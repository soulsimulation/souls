//! The hostile-client bench (Engine v2 O8, #2805): `--honest` agents (default 50) each toggle their own lamp once a
//! second through `gatewayd` to `worldd gateway-link` (I3's lamps world, one room), while one more client, in a process
//! of its own, makes one attack for the whole window. Arms, `--repeats` each (default 2), a fresh world and gateway
//! each:
//!
//! - `none`: no attack, the honest arm.
//! - `flood`: one signed-in socket sends valid intents for its own lamp as fast as the socket takes them, and reads
//!   its answers.
//! - `oversized`: sign in, send a 64 KiB message (the limit is the intent limits' `frame_bytes`), read what is told,
//!   connect again; in a loop.
//! - `malformed`: one signed-in socket sends frames the gateway cannot take as intents as fast as it can: random bytes,
//!   a cut intent, and an intent for another Soul's actor, in turn; it reads its answers.
//! - `reconnect`: four loops on the hostile's one token: connect, sign in, read the outcome, drop the socket.
//!
//! For each run it prints: the world's tick p99 and longest and ticks over budget (`health.json`, the whole run), the
//! honest agents' act wait (send to final answer, at the client) p50, p95 and p99, honest acts not answered, honest
//! refusals and honest sockets closed, `gatewayd`'s largest RSS, and what the hostile was told (each name, close and
//! drop, counted).
//!
//! Build first: `cargo build --release -p gatewayd -p worldd -p bench`. Then `target/release/hostile --dir <empty
//! folder> [--honest 50] [--seconds 20] [--repeats 2] [--arms none,flood,oversized,malformed,reconnect]`.
// A bench times a run by the wall clock (the wall-clock rule, K7, is the engine's: v2/clippy.toml).
#![allow(clippy::disallowed_methods)]
// The repeat rule's map ban (K12, v2/clippy.toml) is `sim`'s; this bench's maps are tallies.
#![allow(clippy::disallowed_types)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use gatewayd::token::{Grant, Token};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Fallback, Hello, Intent, PROTOCOL, Target};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use worldd::checkers::toggles;

const LINEAGE: [u8; 16] = [0x45; 16];
const ARMS: [&str; 5] = ["none", "flood", "oversized", "malformed", "reconnect"];
/// An honest act's expiry, from its send.
const EXPIRY_US: i64 = 30_000_000;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("hostile: {msg}");
    std::process::exit(1)
}

fn bin() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| fail("no folder for the binaries"))
}

fn rss_kib(pid: u32) -> u64 {
    Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn us_now() -> i64 {
    worldd::answers::now()
}

fn toggle(body: Id, lamp: Id, sequence: u64) -> Vec<u8> {
    let n = |s: &str| Name::new(s).expect("a name");
    let i = Intent {
        actor: Actor::Soul(body),
        verb: n("r2:switch_on"),
        target: Some(Target::Node(lamp)),
        parameters: BTreeMap::new(),
        sequence,
        basis: Version {
            lineage: Scope(LINEAGE),
            zone: Id::new(Scope(LINEAGE), 0).expect("a zone"),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: us_now() + EXPIRY_US,
        resources: Vec::new(),
        fallbacks: vec![Fallback {
            verb: n("r2:switch_off"),
            target: Some(Target::Node(lamp)),
            parameters: BTreeMap::new(),
            resources: Vec::new(),
        }],
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).expect("an intent")
}

fn hello() -> Message {
    let h = Hello {
        protocol: PROTOCOL,
        build: vec![0x12, 0x20],
        refused: None,
        other: None,
    };
    Message::Binary(h.to_bytes().expect("hello").into())
}

fn sign_in(token: &str) -> Message {
    let m = encode(&Value::Map(
        [(1, Value::Text(Name::new(token).expect("a token")))].into(),
    ))
    .expect("a sign-in");
    Message::Binary(m.into())
}

/// What a frame from the gateway says: `(sequence, final?)` for an answer to an intent, and a name for the tally.
fn told(bytes: &[u8]) -> (Option<(u64, bool)>, String) {
    let Ok(Value::Map(m)) = decode(bytes).map(|d| d.value) else {
        return (None, "undecodable".into());
    };
    if let Some(Value::Text(n)) = m.get(&4) {
        return (None, n.as_str().to_owned());
    }
    let Some(Value::Map(a)) = m.get(&2) else {
        return (None, "other".into());
    };
    let kind = match a.get(&3) {
        Some(Value::Uint(k)) => *k,
        _ => 0,
    };
    let name = match (kind, a.get(&4)) {
        (1, _) => "receipt".to_owned(),
        (3, _) => "accepted".to_owned(),
        (_, Some(Value::Text(t))) => t.as_str().to_owned(),
        _ => format!("kind {kind}"),
    };
    let seq = match a.get(&2) {
        Some(Value::Uint(s)) => Some((*s, kind != 3)),
        _ => None,
    };
    (seq, name)
}

fn close_name(c: Option<CloseFrame>) -> String {
    match c {
        Some(c) => format!("close {} {}", u16::from(c.code), c.reason.as_str()),
        None => "close (none)".into(),
    }
}

type Tally = Arc<Mutex<BTreeMap<String, u64>>>;

fn count(t: &Tally, name: impl Into<String>) {
    *t.lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(name.into())
        .or_insert(0) += 1;
}

#[derive(Default)]
struct Honest {
    waits_us: Mutex<Vec<u64>>,
    unanswered: AtomicU64,
    refused: AtomicU64,
    closed: AtomicU64,
    ready: AtomicU64,
    reasons: Mutex<BTreeMap<String, u64>>,
}

/// One honest agent: first frame, sign-in, then its own lamp toggled once a second from `offset` until `stop`, then a
/// wait for its answers.
async fn honest(
    url: String,
    token: String,
    pair: (Id, Id),
    offset: Duration,
    go: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    h: Arc<Honest>,
) {
    let Ok((ws, _)) = tokio_tungstenite::connect_async(&url).await else {
        h.closed.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let (mut tx, mut rx) = ws.split();
    let mut ok = tx.send(hello()).await.is_ok() && tx.send(sign_in(&token)).await.is_ok();
    for _ in 0..2 {
        ok = ok && matches!(rx.next().await, Some(Ok(Message::Binary(_))));
    }
    if !ok {
        h.closed.fetch_add(1, Ordering::Relaxed);
        return;
    }
    h.ready.fetch_add(1, Ordering::Relaxed);
    while !go.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut sent: BTreeMap<u64, Instant> = BTreeMap::new();
    let mut waits = Vec::new();
    let mut seq = 0u64;
    let mut tick =
        tokio::time::interval_at(tokio::time::Instant::now() + offset, Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut drain: Option<Instant> = None;
    let mut closed = false;
    loop {
        if drain.is_some_and(|d| Instant::now() >= d) || (drain.is_some() && sent.is_empty()) {
            break;
        }
        tokio::select! {
            _ = tick.tick(), if drain.is_none() => {
                if stop.load(Ordering::Relaxed) {
                    drain = Some(Instant::now() + Duration::from_secs(10));
                    continue;
                }
                seq += 1;
                sent.insert(seq, Instant::now());
                if tx.send(Message::Binary(toggle(pair.0, pair.1, seq).into())).await.is_err() {
                    closed = true;
                    break;
                }
            }
            m = rx.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    let (s, name) = told(&b);
                    if let Some((s, true)) = s && let Some(at) = sent.remove(&s) {
                        waits.push(at.elapsed().as_micros() as u64);
                        if name != "receipt" {
                            h.refused.fetch_add(1, Ordering::Relaxed);
                            *h.reasons.lock().unwrap_or_else(|e| e.into_inner()).entry(name).or_insert(0) += 1;
                        }
                    }
                }
                Some(Ok(_)) => {}
                _ => { closed = true; break; }
            },
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
    if closed {
        h.closed.fetch_add(1, Ordering::Relaxed);
    }
    h.unanswered.fetch_add(sent.len() as u64, Ordering::Relaxed);
    h.waits_us
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .extend(waits);
    let _ = tx.send(Message::Close(None)).await;
}

/// Reads a socket until it ends, tallying what it is told.
async fn read_all<S>(mut rx: S, t: Tally)
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match rx.next().await {
            Some(Ok(Message::Binary(b))) => count(&t, told(&b).1),
            Some(Ok(Message::Text(_))) => count(&t, "text"),
            Some(Ok(Message::Close(c))) => {
                count(&t, close_name(c));
                return;
            }
            Some(Ok(_)) => {}
            Some(Err(_)) | None => {
                count(&t, "dropped without a close");
                return;
            }
        }
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connects and signs in; the socket and the outcome's name.
async fn signed_in(url: &str, token: &str) -> Option<(Socket, String)> {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.ok()?;
    ws.send(hello()).await.ok()?;
    ws.send(sign_in(token)).await.ok()?;
    let _first = ws.next().await?.ok()?;
    match ws.next().await?.ok()? {
        Message::Binary(b) => Some((ws, told(&b).1)),
        Message::Close(c) => Some((ws, close_name(c))),
        _ => Some((ws, "other".into())),
    }
}

/// The attack, in this process: for `seconds`, then its tally on one line to `out`.
async fn attack(
    arm: &str,
    url: String,
    token: String,
    pairs: Vec<(Id, Id)>,
    seconds: u64,
    out: PathBuf,
) {
    let t: Tally = Arc::default();
    let end = Instant::now() + Duration::from_secs(seconds);
    let me = *pairs.last().unwrap_or_else(|| fail("no pairs"));
    let mut sent = 0u64;
    match arm {
        "flood" | "malformed" => {
            let Some((ws, outcome)) = signed_in(&url, &token).await else {
                fail("the hostile could not sign in")
            };
            count(&t, format!("sign-in {outcome}"));
            let (mut tx, rx) = ws.split();
            let reader = tokio::spawn(read_all(rx, t.clone()));
            let other = pairs[0];
            let cut = toggle(me.0, me.1, 1);
            let mut junk = 0x9E37_79B9_7F4A_7C15u64;
            while Instant::now() < end {
                sent += 1;
                let frame = if arm == "flood" {
                    toggle(me.0, me.1, sent)
                } else {
                    match sent % 3 {
                        0 => {
                            let n = 1 + (sent as usize * 131) % 4000;
                            (0..n)
                                .map(|_| {
                                    junk ^= junk << 13;
                                    junk ^= junk >> 7;
                                    junk ^= junk << 17;
                                    junk as u8
                                })
                                .collect()
                        }
                        1 => cut[..cut.len() / 2].to_vec(),
                        _ => toggle(other.0, other.1, sent),
                    }
                };
                if tx.send(Message::Binary(frame.into())).await.is_err() {
                    count(&t, "send failed");
                    break;
                }
            }
            let _ =
                tokio::time::timeout(Duration::from_secs(2), tx.send(Message::Close(None))).await;
            let _ = tokio::time::timeout(Duration::from_secs(30), reader).await;
        }
        "oversized" => {
            let big = vec![0xA5u8; 64 << 10];
            while Instant::now() < end {
                let Some((mut ws, outcome)) = signed_in(&url, &token).await else {
                    count(&t, "connect failed");
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                };
                if outcome != "stream.started" && outcome != "stream.resumed" {
                    count(&t, format!("sign-in {outcome}"));
                }
                sent += 1;
                if ws.send(Message::Binary(big.clone().into())).await.is_err() {
                    count(&t, "send failed");
                }
                let (_, rx) = ws.split();
                let _ = tokio::time::timeout(Duration::from_secs(5), read_all(rx, t.clone())).await;
            }
        }
        "reconnect" => {
            let mut loops = Vec::new();
            for _ in 0..4 {
                let (url, token, t) = (url.clone(), token.clone(), t.clone());
                loops.push(tokio::spawn(async move {
                    let mut n = 0u64;
                    while Instant::now() < end {
                        n += 1;
                        match signed_in(&url, &token).await {
                            Some((ws, outcome)) => {
                                count(&t, format!("sign-in {outcome}"));
                                drop(ws);
                            }
                            None => count(&t, "connect failed"),
                        }
                    }
                    n
                }));
            }
            for l in loops {
                sent += l.await.unwrap_or(0);
            }
        }
        _ => fail(format!("no attack {arm}")),
    }
    let tally = t.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let told: Vec<String> = tally.iter().map(|(k, v)| format!("{k}: {v}")).collect();
    let line = format!("sent {sent}; told {}\n", told.join(", "));
    let _ = std::fs::write(out, line);
}

struct Args {
    dir: PathBuf,
    honest: usize,
    seconds: u64,
    repeats: usize,
    arms: Vec<String>,
}

fn args(a: &[String]) -> Option<Args> {
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|k| a.get(k + 1));
    let num = |name: &str, d: u64| get(name).map_or(Some(d), |v| v.parse().ok());
    Some(Args {
        dir: PathBuf::from(get("--dir")?),
        honest: num("--honest", 50)? as usize,
        seconds: num("--seconds", 20)?,
        repeats: num("--repeats", 2)? as usize,
        arms: get("--arms").map_or_else(
            || ARMS.iter().map(|s| (*s).to_owned()).collect(),
            |s| s.split(',').map(str::to_owned).collect(),
        ),
    })
}

fn pct(sorted: &[u64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[i.min(sorted.len() - 1)] as f64 / 1000.0
}

/// `health.json`'s ticks: p99 and longest, µs, and ticks over budget.
fn ticks(path: &Path) -> (u64, u64, u64, u64) {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let field = |from: &str, key: &str| -> u64 {
        text.find(from)
            .and_then(|i| {
                let rest = &text[i..];
                let j = rest.find(key)? + key.len();
                let digits: String = rest[j..].chars().take_while(char::is_ascii_digit).collect();
                digits.parse().ok()
            })
            .unwrap_or(0)
    };
    (
        field("\"ticks\":", "\"count\":"),
        field("\"ticks\":", "\"p99_us\":"),
        field("\"ticks\":", "\"max_us\":"),
        field("\"over_budget\":", "\"over_budget\":"),
    )
}

fn kill(c: &mut Child) {
    let _ = c.kill();
    let _ = c.wait();
}

async fn run(a: &Args, arm: &str, rep: usize) -> String {
    let dir = a.dir.join(format!("{arm}-{rep}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| fail(format!("the run folder: {e}")));
    let n = a.honest + 1;
    let pairs = toggles::World::build(1, n, 0).pairs;
    let sock = dir.join("w.sock");
    let mut w = Command::new(bin().join("worldd"))
        .args(["gateway-link", "--socket"])
        .arg(&sock)
        .args(["--lineage", &to_hex(&LINEAGE), "--epoch", "1"])
        .args(["--rooms", "1", "--bodies", &n.to_string(), "--log"])
        .arg(dir.join("world.log"))
        .arg("--health")
        .arg(dir.join("health.json"))
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(dir.join("worldd.log")).unwrap_or_else(|e| fail(e)))
        .spawn()
        .unwrap_or_else(|e| fail(format!("worldd: {e}")));
    let started = Instant::now();
    while !sock.exists() {
        if started.elapsed() > Duration::from_secs(10) {
            kill(&mut w);
            fail("worldd did not listen within 10 s");
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let mut tokens = Vec::new();
    let mut file = String::new();
    for (body, _) in &pairs {
        let t = Token::issue(Grant::Actor(Actor::Soul(*body))).expect("random bytes");
        file.push_str(&gatewayd::token::Tokens::line(t.grant(), &t.hash()));
        tokens.push(t.reveal().to_owned());
    }
    std::fs::write(dir.join("tokens"), file).unwrap_or_else(|e| fail(e));
    let mut g = Command::new(bin().join("gatewayd"))
        .args(["--listen", "127.0.0.1:0", "--world"])
        .arg(&sock)
        .arg("--tokens")
        .arg(dir.join("tokens"))
        .args(["--build", "1220"])
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(dir.join("gatewayd.log")).unwrap_or_else(|e| fail(e)))
        .spawn()
        .unwrap_or_else(|e| fail(format!("gatewayd: {e}")));
    let mut line = String::new();
    let _ = BufReader::new(g.stdout.take().expect("stdout")).read_line(&mut line);
    let addr = line
        .trim()
        .strip_prefix("listening ")
        .unwrap_or_else(|| fail("gatewayd did not say where it listens"))
        .to_owned();
    let url = format!("ws://{addr}{}", gatewayd::socket::PATH);
    let gpid = g.id();

    let h = Arc::new(Honest::default());
    let (go, stop) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
    let mut agents = Vec::new();
    for i in 0..a.honest {
        // Offset by index, so the acts spread over each second.
        let offset = Duration::from_millis((i as u64 * 1000) / a.honest as u64);
        agents.push(tokio::spawn(honest(
            url.clone(),
            tokens[i].clone(),
            pairs[i],
            offset,
            go.clone(),
            stop.clone(),
            h.clone(),
        )));
    }
    while h.ready.load(Ordering::Relaxed) + h.closed.load(Ordering::Relaxed) < a.honest as u64 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let rss_idle = rss_kib(gpid);

    // The attack, in a process of its own, so its sends never take this one's threads.
    let out = dir.join("hostile.txt");
    let mut hostile = (arm != "none").then(|| {
        Command::new(std::env::current_exe().unwrap_or_else(|_| fail("this binary")))
            .args([
                "attack",
                arm,
                &url,
                &tokens[a.honest],
                &n.to_string(),
                &a.seconds.to_string(),
            ])
            .arg(&out)
            .stdout(Stdio::null())
            .spawn()
            .unwrap_or_else(|e| fail(format!("the hostile: {e}")))
    });
    go.store(true, Ordering::Relaxed);
    let rss_max = Arc::new(AtomicU64::new(rss_idle));
    let sampling = Arc::new(AtomicBool::new(true));
    let sampler = {
        let (rss_max, sampling) = (rss_max.clone(), sampling.clone());
        tokio::spawn(async move {
            while sampling.load(Ordering::Relaxed) {
                let r = tokio::task::spawn_blocking(move || rss_kib(gpid))
                    .await
                    .unwrap_or(0);
                rss_max.fetch_max(r, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
    };
    tokio::time::sleep(Duration::from_secs(a.seconds)).await;
    stop.store(true, Ordering::Relaxed);
    for ag in agents {
        let _ = ag.await;
    }
    if let Some(c) = hostile.as_mut() {
        let _ = tokio::task::block_in_place(|| c.wait());
    }
    sampling.store(false, Ordering::Relaxed);
    let _ = sampler.await;
    // One more health write (every second) after the last act.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    kill(&mut g);
    kill(&mut w);

    let (tick_n, tick_p99, tick_max, over) = ticks(&dir.join("health.json"));
    let mut waits = std::mem::take(&mut *h.waits_us.lock().unwrap_or_else(|e| e.into_inner()));
    waits.sort_unstable();
    let reasons = h.reasons.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let hostile_told = std::fs::read_to_string(&out).unwrap_or_else(|_| "—".into());
    format!(
        "| {arm} | {rep} | {tick_n} | {:.1} | {:.1} | {over} | {} | {:.1} | {:.1} | {:.1} | {} | {} {:?} | {} | {} | {} | {} |",
        tick_p99 as f64 / 1000.0,
        tick_max as f64 / 1000.0,
        waits.len(),
        pct(&waits, 0.5),
        pct(&waits, 0.95),
        pct(&waits, 0.99),
        h.unanswered.load(Ordering::Relaxed),
        h.refused.load(Ordering::Relaxed),
        reasons,
        h.closed.load(Ordering::Relaxed),
        rss_idle / 1024,
        rss_max.load(Ordering::Relaxed) / 1024,
        hostile_told.trim(),
    )
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some("attack") {
        let (Some(arm), Some(url), Some(token), Some(n), Some(seconds), Some(out)) = (
            argv.get(2),
            argv.get(3),
            argv.get(4),
            argv.get(5).and_then(|s| s.parse::<usize>().ok()),
            argv.get(6).and_then(|s| s.parse::<u64>().ok()),
            argv.get(7),
        ) else {
            fail("usage: hostile attack <arm> <url> <token> <bodies> <seconds> <out>")
        };
        let pairs = toggles::World::build(1, n, 0).pairs;
        attack(
            arm,
            url.clone(),
            token.clone(),
            pairs,
            seconds,
            PathBuf::from(out),
        )
        .await;
        return;
    }
    let Some(a) = args(&argv) else {
        fail(
            "usage: hostile --dir <empty folder> [--honest 50] [--seconds 20] [--repeats 2] [--arms a,b]",
        )
    };
    println!(
        "hostile bench: {} honest agents, each its own lamp once a second, {} s a run, 50 ms ticks",
        a.honest, a.seconds
    );
    println!(
        "| arm | repeat | ticks | tick p99 ms | tick longest ms | over budget | honest acts | wait p50 ms | p95 ms | p99 ms | unanswered | refused | honest closed | gatewayd MiB idle | MiB max | hostile |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for arm in &a.arms {
        for rep in 1..=a.repeats {
            println!("{}", run(&a, arm, rep).await);
        }
    }
}
