//! The gateway's restart bench (Engine v2 I1, #2683): `n` agents hold sockets to `gatewayd` for `seconds` while the
//! world process behind it is killed (SIGKILL) and restarted `restarts` times, each agent sending an intent every
//! `every_ms` or so throughout. It reports, for the issue's table: sockets closed, intents sent (and sent while the
//! world was away), how they were answered (receipt, `world.restarting`, twice, never), each actor's order at the
//! world (from `worldd`'s arrivals file), and the gateway's memory per idle socket.
//!
//! Build first: `cargo build --release -p gatewayd -p worldd -p bench`. Then
//! `target/release/gateway-restart --dir <empty folder> [--sockets 1000] [--seconds 600] [--restarts 5]
//! [--down-ms 500] [--every-ms 2000]`. The binaries are taken from this one's folder.
// A bench times a run by the wall clock (the wall-clock rule, K7, is the engine's: v2/clippy.toml).
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use gatewayd::token::{Grant, Token};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL};
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::Message;

const LINEAGE: [u8; 16] = [7; 16];

struct Args {
    dir: PathBuf,
    sockets: u64,
    seconds: u64,
    restarts: u64,
    down_ms: u64,
    every_ms: u64,
}

fn args() -> Option<Args> {
    let a: Vec<String> = std::env::args().collect();
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|k| a.get(k + 1));
    let num = |name: &str, d: u64| get(name).map_or(Some(d), |v| v.parse().ok());
    Some(Args {
        dir: PathBuf::from(get("--dir")?),
        sockets: num("--sockets", 1000)?,
        seconds: num("--seconds", 600)?,
        restarts: num("--restarts", 5)?,
        down_ms: num("--down-ms", 500)?,
        every_ms: num("--every-ms", 2000)?,
    })
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

fn world(bin: &Path, a: &Args, epoch: u64) -> Child {
    Command::new(bin.join("worldd"))
        .args(["gateway-link", "--socket"])
        .arg(a.dir.join("w.sock"))
        .args([
            "--lineage",
            &to_hex(&LINEAGE),
            "--epoch",
            &epoch.to_string(),
        ])
        .arg("--arrivals")
        .arg(a.dir.join("arrivals.txt"))
        .spawn()
        .expect("worldd starts")
}

fn soul(n: u64) -> Actor {
    Actor::Soul(Id::new(Scope([3; 16]), n).expect("a counter"))
}

fn intent(actor: Actor, sequence: u64) -> Vec<u8> {
    let zone = Id::new(Scope(LINEAGE), 0).expect("a zone");
    let i = Intent {
        actor,
        verb: Name::new("eden:wave").expect("a name"),
        target: None,
        parameters: BTreeMap::new(),
        sequence,
        basis: Version {
            lineage: Scope(LINEAGE),
            zone,
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: 600_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).expect("an intent")
}

/// How a frame answers: (sequence, receipt?, world.restarting?).
fn read_answer(bytes: &[u8]) -> Option<(u64, bool, bool)> {
    let Value::Map(m) = decode(bytes).ok()?.value else {
        return None;
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        return None;
    };
    let Some(Value::Uint(s)) = a.get(&2) else {
        return None;
    };
    let receipt = a.get(&3) == Some(&Value::Uint(1));
    let restarting = matches!(a.get(&4), Some(Value::Text(n)) if n.as_str() == "world.restarting");
    Some((*s, receipt, restarting))
}

#[derive(Default)]
struct Tally {
    closed: AtomicU64,
    sent: AtomicU64,
    sent_away: AtomicU64,
    receipts: AtomicU64,
    restarting: AtomicU64,
    other: AtomicU64,
    twice: AtomicU64,
    unanswered: AtomicU64,
    unanswered_away: AtomicU64,
    away_answered_once: AtomicU64,
}

/// One agent: first frame, sign-in, then an intent every so often until `stop`, then a wait for its answers.
#[allow(clippy::too_many_arguments)] // one agent's handles, passed once at spawn
async fn agent(
    url: String,
    token: String,
    actor: Actor,
    every: Duration,
    gate: Arc<Semaphore>,
    ready: Arc<AtomicU64>,
    go: Arc<AtomicBool>,
    away: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    t: Arc<Tally>,
) {
    let permit = gate.acquire().await;
    let Ok((ws, _)) = tokio_tungstenite::connect_async(&url).await else {
        t.closed.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let (mut tx, mut rx) = ws.split();
    let hello = Hello {
        protocol: PROTOCOL,
        build: vec![0x12, 0x20],
        refused: None,
        other: None,
    };
    let sign_in = encode(&Value::Map(
        [(1, Value::Text(Name::new(&token).expect("a token")))].into(),
    ))
    .expect("a sign-in");
    let mut ok = tx
        .send(Message::Binary(hello.to_bytes().expect("hello").into()))
        .await
        .is_ok();
    ok = ok && tx.send(Message::Binary(sign_in.into())).await.is_ok();
    // The first frame back, and the sign-in's outcome.
    for _ in 0..2 {
        ok = ok && matches!(rx.next().await, Some(Ok(Message::Binary(_))));
    }
    drop(permit);
    if !ok {
        t.closed.fetch_add(1, Ordering::Relaxed);
        return;
    }
    ready.fetch_add(1, Ordering::Relaxed);
    while !go.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Per sequence: sent while the world was away, and how many answers.
    let mut sent: BTreeMap<u64, (bool, u32)> = BTreeMap::new();
    let mut seq = 0u64;
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut closed = false;
    let mut drain_until: Option<Instant> = None;
    loop {
        let wait = match drain_until {
            Some(u) if Instant::now() >= u => break,
            Some(u) => u - Instant::now(),
            None => Duration::from_secs(3600),
        };
        tokio::select! {
            _ = tick.tick(), if drain_until.is_none() => {
                if stop.load(Ordering::Relaxed) {
                    drain_until = Some(Instant::now() + Duration::from_secs(5));
                    continue;
                }
                seq += 1;
                let during = away.load(Ordering::Relaxed);
                sent.insert(seq, (during, 0));
                if tx.send(Message::Binary(intent(actor, seq).into())).await.is_err() {
                    closed = true;
                    break;
                }
            }
            m = rx.next() => match m {
                Some(Ok(Message::Binary(b))) => match read_answer(&b) {
                    Some((s, receipt, restarting)) => {
                        if let Some(e) = sent.get_mut(&s) { e.1 += 1; }
                        let c = if receipt { &t.receipts } else if restarting { &t.restarting } else { &t.other };
                        c.fetch_add(1, Ordering::Relaxed);
                    }
                    None => { t.other.fetch_add(1, Ordering::Relaxed); }
                },
                Some(Ok(_)) => {}
                _ => { closed = true; break; }
            },
            _ = tokio::time::sleep(wait) => {}
        }
    }
    if closed {
        t.closed.fetch_add(1, Ordering::Relaxed);
    }
    for (during, n) in sent.values() {
        t.sent.fetch_add(1, Ordering::Relaxed);
        if *during {
            t.sent_away.fetch_add(1, Ordering::Relaxed);
        }
        match n {
            0 => {
                t.unanswered.fetch_add(1, Ordering::Relaxed);
                if *during {
                    t.unanswered_away.fetch_add(1, Ordering::Relaxed);
                }
            }
            1 => {
                if *during {
                    t.away_answered_once.fetch_add(1, Ordering::Relaxed);
                }
            }
            _ => {
                t.twice.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    let _ = tx.send(Message::Close(None)).await;
}

/// Each actor's sequences as the world took them: (out of order, repeats across a restart).
fn order(path: &Path) -> (u64, u64, u64) {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut last: BTreeMap<&str, u64> = BTreeMap::new();
    let (mut lines, mut out_of_order, mut repeats) = (0, 0, 0);
    for line in text.lines() {
        let Some((actor, s)) = line.split_once(' ') else {
            continue;
        };
        let Ok(s) = s.parse::<u64>() else { continue };
        lines += 1;
        match last.get(actor) {
            Some(&p) if s < p => out_of_order += 1,
            Some(&p) if s == p => repeats += 1,
            _ => {}
        }
        let e = last.entry(actor).or_insert(s);
        *e = (*e).max(s);
    }
    (lines, out_of_order, repeats)
}

#[tokio::main]
async fn main() {
    let Some(a) = args() else {
        eprintln!(
            "usage: gateway-restart --dir <empty folder> [--sockets n] [--seconds s] [--restarts k] [--down-ms ms] [--every-ms ms]"
        );
        std::process::exit(2);
    };
    let bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .expect("this binary's folder");
    std::fs::create_dir_all(&a.dir).expect("the run folder");
    let _ = std::fs::remove_file(a.dir.join("arrivals.txt"));

    // Tokens: the gateway's file holds hashes only.
    let mut tokens = Vec::new();
    let mut file = String::new();
    for i in 0..a.sockets {
        let t = Token::issue(Grant::Actor(soul(i))).expect("random bytes");
        file.push_str(&gatewayd::token::Tokens::line(t.grant(), &t.hash()));
        tokens.push(t.reveal().to_owned());
    }
    std::fs::write(a.dir.join("tokens"), file).expect("the tokens file");

    let mut w = world(&bin, &a, 1);
    let log = std::fs::File::create(a.dir.join("gatewayd.log")).expect("a log file");
    let mut g = Command::new(bin.join("gatewayd"))
        .args(["--listen", "127.0.0.1:0", "--world"])
        .arg(a.dir.join("w.sock"))
        .arg("--tokens")
        .arg(a.dir.join("tokens"))
        .args(["--build", "1220"])
        .stdout(Stdio::piped())
        .stderr(log)
        .spawn()
        .expect("gatewayd starts");
    let mut line = String::new();
    BufReader::new(g.stdout.take().expect("stdout"))
        .read_line(&mut line)
        .expect("gatewayd says where it listens");
    let addr = line.trim().strip_prefix("listening ").expect("an address");
    let url = format!("ws://{addr}{}", gatewayd::socket::PATH);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let rss_empty = rss_kib(g.id());

    let t = Arc::new(Tally::default());
    let (ready, go, away, stop) = (
        Arc::new(AtomicU64::new(0)),
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
    let gate = Arc::new(Semaphore::new(64));
    let mut agents = Vec::new();
    for (i, token) in tokens.into_iter().enumerate() {
        // Spread the sends over the interval: every_ms, plus up to half of it, by index.
        let i = i as u64;
        let every = Duration::from_millis(a.every_ms + (i * 7919) % (a.every_ms / 2 + 1));
        agents.push(tokio::spawn(agent(
            url.clone(),
            token,
            soul(i),
            every,
            gate.clone(),
            ready.clone(),
            go.clone(),
            away.clone(),
            stop.clone(),
            t.clone(),
        )));
    }
    let connect_start = Instant::now();
    while ready.load(Ordering::Relaxed) + t.closed.load(Ordering::Relaxed) < a.sockets {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let connected = connect_start.elapsed();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let rss_idle = rss_kib(g.id());
    let signed_in = ready.load(Ordering::Relaxed);

    go.store(true, Ordering::Relaxed);
    let start = Instant::now();
    let mut downs = Vec::new();
    for k in 0..a.restarts {
        let at = Duration::from_secs(a.seconds * (k + 1) / (a.restarts + 1));
        tokio::time::sleep(at.saturating_sub(start.elapsed())).await;
        away.store(true, Ordering::Relaxed);
        let down = Instant::now();
        let _ = w.kill();
        let _ = w.wait();
        tokio::time::sleep(Duration::from_millis(a.down_ms)).await;
        w = world(&bin, &a, k + 2);
        // The gateway retries every 20 ms; give it that and a little.
        tokio::time::sleep(Duration::from_millis(50)).await;
        away.store(false, Ordering::Relaxed);
        downs.push(down.elapsed().as_millis());
    }
    tokio::time::sleep(Duration::from_secs(a.seconds).saturating_sub(start.elapsed())).await;
    let rss_end = rss_kib(g.id());
    stop.store(true, Ordering::Relaxed);
    for h in agents {
        let _ = h.await;
    }
    let ran = start.elapsed();
    let _ = g.kill();
    let _ = w.kill();
    let _ = g.wait();
    let _ = w.wait();
    let (arrived, out_of_order, repeats) = order(&a.dir.join("arrivals.txt"));

    let n = |c: &AtomicU64| c.load(Ordering::Relaxed);
    let per_socket = (rss_idle.saturating_sub(rss_empty) * 1024) / signed_in.max(1);
    let report = format!(
        "sockets {} signed in {} (in {} ms) | ran {} s, {} restarts, away {:?} ms | closed {} | sent {} (while away {}) \
         | receipts {} world.restarting {} other {} | answered twice {} | unanswered {} (while away {}) \
         | sent while away and answered once {} | arrivals {} out of order {} repeats across a restart {} \
         | gatewayd RSS empty {} KiB, all idle {} KiB, end {} KiB, per idle socket {} bytes\n",
        a.sockets,
        signed_in,
        connected.as_millis(),
        ran.as_secs(),
        downs.len(),
        downs,
        n(&t.closed),
        n(&t.sent),
        n(&t.sent_away),
        n(&t.receipts),
        n(&t.restarting),
        n(&t.other),
        n(&t.twice),
        n(&t.unanswered),
        n(&t.unanswered_away),
        n(&t.away_answered_once),
        arrived,
        out_of_order,
        repeats,
        rss_empty,
        rss_idle,
        rss_end,
        per_socket,
    );
    print!("{report}");
    let _ = std::io::stdout().flush();
    let _ = std::fs::write(a.dir.join("report.txt"), report);
}
