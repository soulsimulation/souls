//! The O16 run (Engine v2 O16, #2809): the gateway is upgraded, then killed outright, under 1,000 scripted agents
//! acting from a schedule `v2/tools/driver/loads.mjs` writes from the shared shapes (even: `target-even`; uneven:
//! `target`). It prints one row of the upgrade table and one of the kill table.
//!
//! - **Upgrade** at `--upgrade-at` s: SIGTERM to the gateway, as `systemctl restart` sends it. It stops accepting,
//!   closes every socket with 1012 and exits; the new build then listens on the same port (here: the same binary
//!   under another name; a restart is a restart).
//! - **Kill** at `--kill-at` s: SIGKILL, and the gateway is started again 1 s later (the unit's `RestartSec=1s`).
//!
//! Each agent is a client as the runbook asks of one (`v2/docs/runbook/gateway-upgrade.md`): on a lost socket it waits
//! a random time inside 2 s, reconnects (again every 50 to 250 ms while refused), signs in with its cursor (the newest
//! version it applied and how many frames at it, R5), compares by hash when the gateway cannot resume its stream
//! (`stream.cannot-resume`: one sync request for its scope's hashes, R5b), and sends again, under its old sequence
//! number, every intent it has no answer for (I4: the world answers a repeat with the answer it had). An answer of
//! `world.restarting` is the gateway's, not the world's: the intent is sent again 200 ms later.
//!
//! An agent is **back** when it is signed in again, and **current** when, besides, its sync request is answered (or
//! its stream resumed) and every intent it had sent before it signed in again has its answer. The run's number for an
//! event is each agent's time from the event to current. Then, from every agent's answers and the world's log: each
//! intent's answers from the world (exactly one, none, or more), and every intent the world acknowledged must be among
//! the log's answered rows.
//!
//! Build first: `cargo build --release -p ops -p worldd -p gatewayd`; then, with `ulimit -n 8192`,
//! `target/release/o16-run --dir <empty folder> --schedule <file> [--upgrade-at 20] [--kill-at 40]`.
//!
//! **Under systemd** (`--unit <script> --listen <addr:port>`, S1): the gateway is a `souls-gateway@` unit and the run
//! starts nothing itself. It calls `<script> start` once the world and the tokens are there, `<script> upgrade` at the
//! upgrade (`gateway-upgrade.sh`: `systemctl restart`), `<script> kill` at the kill (`systemctl kill -s KILL`; the
//! unit's `Restart=always` brings it back after `RestartSec=1s`) and `<script> stop` at the end; it waits for the port
//! to accept after each. `o16-run.sh --systemd` writes the unit and the script.
// A run times itself by the wall clock (the wall-clock rule, K7, is the engine's: v2/clippy.toml).
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use gatewayd::token::{Grant, Token, Tokens};
use replica::effects::{Actor, read_id};
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Fallback, Hello, Intent, PROTOCOL, Target};
use replica::sync::wire;
use sim::log::recover;
use supervisor::deploy::{ANSWERED, End, read_answer};
use tokio::sync::{Semaphore, mpsc};
use tokio_tungstenite::tungstenite::Message;
use worldd::checkers::toggles;

const LINEAGE: [u8; 16] = [0x16; 16];
/// The bar: every agent current within this of the event.
const BAR: Duration = Duration::from_secs(5);
/// A client's random wait before it reconnects is inside this.
const JITTER_MS: u64 = 2000;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("o16-run: {msg}");
    std::process::exit(2)
}

/// A random number from a counter (splitmix64): each agent's waits differ, and the run repeats.
fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

fn toggle(body: Id, thing: Id, sequence: u64) -> Vec<u8> {
    let n = |s: &str| Name::new(s).expect("a name");
    let i = Intent {
        actor: Actor::Soul(body),
        verb: n("r2:switch_on"),
        target: Some(Target::Node(thing)),
        parameters: BTreeMap::new(),
        sequence,
        basis: Version {
            lineage: Scope(LINEAGE),
            zone: Id::new(Scope(LINEAGE), 0).expect("a zone"),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: supervisor::deploy::now_us() + 600_000_000,
        resources: Vec::new(),
        fallbacks: vec![Fallback {
            verb: n("r2:switch_off"),
            target: Some(Target::Node(thing)),
            parameters: BTreeMap::new(),
            resources: Vec::new(),
        }],
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).expect("an intent")
}

/// A version's place in the stream's order, (epoch, sequence), or none if it is not one.
fn order(v: &Value) -> Option<(u64, u64)> {
    match v {
        Value::Array(a) => match a.as_slice() {
            [_, _, Value::Uint(e), Value::Uint(s)] => Some((*e, *s)),
            _ => None,
        },
        _ => None,
    }
}

/// What one agent saw.
#[derive(Default)]
struct Seen {
    /// Sequence → the world's answers to it (never the gateway's `world.restarting`).
    ends: BTreeMap<u64, Vec<End>>,
    restarting: u64,
    /// Intents sent again, under their old sequence, after a reconnect.
    resent: u64,
    /// When each socket was lost, and when the agent was current after it.
    lost: Vec<Instant>,
    current: Vec<Instant>,
    /// The sign-in outcomes after a lost socket, by name.
    outcomes: BTreeMap<String, u64>,
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Hello, sign-in with the cursor, the gateway's hello and the sign-in's outcome.
async fn sign_in(url: &str, token: &str, cursor: Option<&(Value, u64)>) -> Option<(Ws, String)> {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.ok()?;
    let hello = Hello {
        protocol: PROTOCOL,
        build: vec![0x12, 0x20],
        refused: None,
        other: None,
    };
    let mut m = BTreeMap::from([(1, Value::Text(Name::new(token).expect("a token")))]);
    if let Some((v, seen)) = cursor {
        m.insert(2, v.clone());
        m.insert(3, Value::Uint(*seen));
    }
    ws.send(Message::Binary(hello.to_bytes().ok()?.into()))
        .await
        .ok()?;
    ws.send(Message::Binary(encode(&Value::Map(m)).ok()?.into()))
        .await
        .ok()?;
    next_binary(&mut ws).await?;
    let out = next_binary(&mut ws).await?;
    let Ok(Value::Map(o)) = decode(&out).map(|d| d.value) else {
        return None;
    };
    let Some(Value::Text(name)) = o.get(&4) else {
        return None;
    };
    let name = name.as_str().to_owned();
    Some((ws, name))
}

async fn next_binary(ws: &mut Ws) -> Option<Vec<u8>> {
    loop {
        match ws.next().await? {
            Ok(Message::Binary(b)) => return Some(b.to_vec()),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            _ => return None,
        }
    }
}

/// One agent until its acts end and every one is answered (or 15 s pass): see the module's docs.
async fn agent(
    k: u64,
    url: String,
    token: String,
    pair: (Id, Id),
    gate: Arc<Semaphore>,
    ready: Arc<AtomicUsize>,
    mut acts: mpsc::UnboundedReceiver<()>,
) -> Seen {
    let mut seen = Seen::default();
    let mut cursor: Option<(Value, u64)> = None;
    let mut pending: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
    let mut sequence = 0u64;
    let mut attempt = 0u64;
    let mut acts_done = false;
    let mut drain_until: Option<Instant> = None;
    let mut first = true;
    'run: loop {
        // Connect: the first time under the gate, after a lost socket after a random wait inside 2 s.
        let (mut ws, outcome) = loop {
            if drain_until.is_some_and(|u| Instant::now() >= u) {
                break 'run;
            }
            let permit = if first {
                gate.clone().acquire_owned().await.ok()
            } else {
                None
            };
            if let Some(s) = sign_in(&url, &token, cursor.as_ref()).await {
                drop(permit);
                break s;
            }
            attempt += 1;
            let ms = 50 + mix(k << 20 | attempt) % 200;
            tokio::time::sleep(Duration::from_millis(ms)).await;
        };
        let after_loss = !first;
        if first {
            ready.fetch_add(1, Ordering::Relaxed);
        }
        first = false;
        if after_loss {
            *seen.outcomes.entry(outcome.clone()).or_default() += 1;
        }
        let mut ok = true;
        // Not resumed: compare by hash (R5b), one request for the scope's hashes.
        let mut syncing = outcome != gatewayd::resume::RESUMED && after_loss;
        let mut ask_n = 0u64;
        let ask = |n: u64| {
            encode(&Value::Map(BTreeMap::from([
                (wire::ASK, Value::Uint(n)),
                (wire::IDS, Value::Array(Vec::new())),
            ])))
            .expect("a sync request")
        };
        if syncing {
            ok = ws.send(Message::Binary(ask(ask_n).into())).await.is_ok();
        }
        // Everything unanswered goes again, under its old sequence.
        let upto = pending.keys().next_back().copied().unwrap_or(0);
        seen.resent += pending.len() as u64;
        for b in pending.values() {
            ok = ok && ws.send(Message::Binary(b.clone().into())).await.is_ok();
        }
        let mut is_current = !after_loss;
        let mut retry: Vec<u64> = Vec::new();
        let mut retry_at: Option<Instant> = None;
        while ok {
            if !is_current && !syncing && pending.range(..=upto).next().is_none() {
                is_current = true;
                seen.current.push(Instant::now());
            }
            if acts_done && drain_until.is_none() {
                drain_until = Some(Instant::now() + Duration::from_secs(15));
            }
            if acts_done && pending.is_empty() && is_current {
                let _ = ws.send(Message::Close(None)).await;
                break 'run;
            }
            let until = [drain_until, retry_at].into_iter().flatten().min();
            let wait = until.map_or(Duration::from_secs(3600), |u| {
                u.saturating_duration_since(Instant::now())
            });
            tokio::select! {
                a = acts.recv(), if !acts_done => match a {
                    Some(()) => {
                        sequence += 1;
                        let b = toggle(pair.0, pair.1, sequence);
                        seen.ends.insert(sequence, Vec::new());
                        pending.insert(sequence, b.clone());
                        ok = ws.send(Message::Binary(b.into())).await.is_ok();
                    }
                    None => acts_done = true,
                },
                m = ws.next() => {
                    let b = match m {
                        Some(Ok(Message::Binary(b))) => b,
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                        _ => { ok = false; continue; }
                    };
                    let Ok(Value::Map(f)) = decode(&b).map(|d| d.value) else { continue };
                    if f.contains_key(&wire::ASK) {
                        if f.contains_key(&wire::REFUSED) {
                            // `world.restarting`: ask again.
                            ask_n += 1;
                            ok = ws.send(Message::Binary(ask(ask_n).into())).await.is_ok();
                        } else {
                            syncing = false;
                        }
                        continue;
                    }
                    if let Some(v) = f.get(&1) && let Some(o) = order(v) {
                        // The cursor only moves forward: the world answers a repeat at the version it had.
                        cursor = match cursor.take() {
                            Some((c, n)) if order(&c) == Some(o) => Some((c, n + 1)),
                            Some((c, n)) if order(&c) > Some(o) => Some((c, n)),
                            _ => Some((v.clone(), 1)),
                        };
                    }
                    let Some((s, end)) = read_answer(&b) else { continue };
                    if matches!(&end, End::Refused(w) if w == gatewayd::world_link::RESTARTING) {
                        seen.restarting += 1;
                        if pending.contains_key(&s) {
                            retry.push(s);
                            retry_at.get_or_insert(Instant::now() + Duration::from_millis(200));
                        }
                        continue;
                    }
                    if let Some(e) = seen.ends.get_mut(&s) {
                        e.push(end);
                    }
                    pending.remove(&s);
                }
                _ = tokio::time::sleep(wait) => {
                    if retry_at.is_some_and(|u| Instant::now() >= u) {
                        retry_at = None;
                        for s in std::mem::take(&mut retry) {
                            if let Some(b) = pending.get(&s) {
                                ok = ok && ws.send(Message::Binary(b.clone().into())).await.is_ok();
                            }
                        }
                    }
                    if drain_until.is_some_and(|u| Instant::now() >= u) {
                        break 'run;
                    }
                }
            }
        }
        // Lost: a random wait inside 2 s, then again.
        seen.lost.push(Instant::now());
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(mix(k << 20 | attempt) % JITTER_MS)).await;
    }
    seen
}

struct Gw {
    /// None under systemd: the unit's process is systemd's.
    child: Option<Child>,
    addr: String,
}

/// Wait until the gateway accepts at `addr` (under systemd, where no line says so), at most 15 s.
fn wait_listening(addr: &str) {
    let t = Instant::now();
    while std::net::TcpStream::connect(addr).is_err() {
        if t.elapsed() > Duration::from_secs(15) {
            fail(format!("the gateway did not listen at {addr} within 15 s"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// `<script> <what>` for the gateway's unit; the run fails if it does.
fn unit(script: &str, what: &str) {
    let ok = Command::new(script)
        .arg(what)
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        fail(format!("`{script} {what}` failed"));
    }
}

fn start_gateway(bin: &Path, listen: &str, out: &Path) -> Gw {
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(out)
        .unwrap_or_else(|e| fail(e));
    let mut child = Command::new(bin)
        .args([
            "--listen", listen, "--world", "w.sock", "--tokens", "tokens", "--build", "1220",
        ])
        .stdout(Stdio::piped())
        .stderr(log)
        .spawn()
        .unwrap_or_else(|e| fail(format!("gatewayd: {e}")));
    let mut line = String::new();
    BufReader::new(child.stdout.take().expect("stdout"))
        .read_line(&mut line)
        .unwrap_or_else(|e| fail(e));
    let addr = line
        .trim()
        .strip_prefix("listening ")
        .unwrap_or_else(|| fail(format!("gatewayd did not listen: {line:?}")))
        .to_owned();
    Gw {
        child: Some(child),
        addr,
    }
}

/// The two events, each once at its time.
struct Events {
    upgrade_at: Duration,
    kill_at: Duration,
    upgraded: Option<Instant>,
    killed: Option<Instant>,
    listen: String,
    /// The unit's script, under systemd.
    unit: Option<String>,
}

impl Events {
    fn step(&mut self, now: Duration, gw: &mut Gw) {
        let new = Path::new("./gatewayd-new");
        let out = Path::new("gatewayd.out");
        if self.upgraded.is_none() && now >= self.upgrade_at {
            // `systemctl restart`: SIGTERM, the old process exits, the new one starts.
            let t = Instant::now();
            self.upgraded = Some(t);
            if let Some(script) = &self.unit {
                unit(script, "upgrade");
                let restarted = t.elapsed();
                wait_listening(&self.listen);
                println!(
                    "upgraded through systemd: gateway-upgrade returned {} ms after it began; the new gateway listened at {} ms",
                    ms(restarted),
                    ms(t.elapsed())
                );
                return;
            }
            let child = gw.child.as_mut().expect("the gateway's process");
            let _ = Command::new("kill")
                .args(["-TERM", &child.id().to_string()])
                .status();
            let _ = child.wait();
            let stopped = t.elapsed();
            *gw = start_gateway(new, &self.listen, out);
            println!(
                "upgraded: the old gateway exited {} ms after SIGTERM; the new one listened at {} ms",
                ms(stopped),
                ms(t.elapsed())
            );
        }
        if self.killed.is_none() && now >= self.kill_at {
            let t = Instant::now();
            self.killed = Some(t);
            if let Some(script) = &self.unit {
                unit(script, "kill");
                // The killed process is gone well before the unit's RestartSec=1s brings the next one.
                std::thread::sleep(Duration::from_millis(200));
                wait_listening(&self.listen);
                println!(
                    "killed through systemd: the unit listened again {} ms after SIGKILL",
                    ms(t.elapsed())
                );
                return;
            }
            let child = gw.child.as_mut().expect("the gateway's process");
            let _ = child.kill();
            let _ = child.wait();
            std::thread::sleep(Duration::from_secs(1));
            *gw = start_gateway(new, &self.listen, out);
            println!(
                "killed: the gateway listened again {} ms after SIGKILL",
                ms(t.elapsed())
            );
        }
    }
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 10_000.0).round() / 10.0
}

fn quantile(sorted: &[Duration], q: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

/// One event's row: agents current within the bar, p50, p99 and the slowest, and the sign-in outcomes.
fn event_row(
    name: &str,
    at: Instant,
    next: Option<Instant>,
    seen: &[Seen],
    fails: &mut Vec<String>,
) {
    let mut times = Vec::new();
    let mut not_back = 0;
    let mut outcomes: BTreeMap<String, u64> = BTreeMap::new();
    for s in seen {
        let within = |t: &&Instant| **t >= at && next.is_none_or(|n| **t < n);
        let lost = s.lost.iter().any(|t| within(&t));
        match s.current.iter().find(|t| within(t)) {
            Some(c) if lost => times.push(c.duration_since(at)),
            _ => not_back += 1,
        }
    }
    for s in seen {
        for (o, n) in &s.outcomes {
            *outcomes.entry(o.clone()).or_default() += n;
        }
    }
    times.sort();
    let within = times.iter().filter(|t| **t <= BAR).count();
    println!(
        "| {name} | {} | {within} | {not_back} | {} | {} | {} |",
        seen.len(),
        ms(quantile(&times, 0.5)),
        ms(quantile(&times, 0.99)),
        ms(times.last().copied().unwrap_or_default()),
    );
    if within != seen.len() {
        fails.push(format!(
            "{name}: {} of {} current within 5 s",
            within,
            seen.len()
        ));
    }
}

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let get = |n: &str| a.iter().position(|x| x == n).and_then(|k| a.get(k + 1));
    let usage = "usage: o16-run --dir <empty folder> --schedule <loads.mjs file> [--upgrade-at 20] [--kill-at 40] [--agents <n>] [--unit <script> --listen <addr:port>]";
    let dir = PathBuf::from(get("--dir").unwrap_or_else(|| fail(usage)));
    let schedule = std::fs::read_to_string(get("--schedule").unwrap_or_else(|| fail(usage)))
        .unwrap_or_else(|e| fail(format!("the schedule: {e}")));
    let secs = |n: &str, d: u64| get(n).map_or(d, |v| v.parse().unwrap_or_else(|_| fail(usage)));
    let (upgrade_at, kill_at) = (secs("--upgrade-at", 20), secs("--kill-at", 40));
    let unit_script = get("--unit").cloned();
    if unit_script.is_some() && get("--listen").is_none() {
        fail(usage);
    }
    let here = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| fail("no folder for the binaries"));

    // The schedule: `# describe`, then `<due ms> <agent> <kind> <verb>`; every act is sent, as a toggle.
    let mut describe = String::new();
    let mut acts: Vec<(u64, usize)> = Vec::new();
    for line in schedule.lines() {
        if let Some(d) = line.strip_prefix("# ") {
            describe = d.to_owned();
            continue;
        }
        let f: Vec<&str> = line.split(' ').collect();
        match (
            f.first().and_then(|x| x.parse().ok()),
            f.get(1).and_then(|x| x.parse().ok()),
        ) {
            (Some(at), Some(agent)) => acts.push((at, agent)),
            _ => fail(format!("the schedule: `{line}`")),
        }
    }
    // `--agents`: the schedule's agents, those with no act among them (they connect, lose their socket and come back).
    let agents = acts
        .iter()
        .map(|(_, k)| k + 1)
        .max()
        .unwrap_or(0)
        .max(get("--agents").map_or(0, |v| v.parse().unwrap_or_else(|_| fail(usage))));

    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| fail(e));
    std::env::set_current_dir(&dir).unwrap_or_else(|e| fail(e));
    // Two builds of the gateway: the one running and the upgrade (the same bytes here).
    for b in ["gatewayd-old", "gatewayd-new"] {
        std::fs::copy(here.join("gatewayd"), b).unwrap_or_else(|e| fail(format!("{b}: {e}")));
    }
    let pairs = toggles::World::build(1, agents, 0).pairs;
    let mut world = Command::new(here.join("worldd"))
        .args([
            "gateway-link",
            "--socket",
            "w.sock",
            "--lineage",
            &to_hex(&LINEAGE),
            "--epoch",
            "1",
        ])
        .args([
            "--log",
            "world.log",
            "--bodies",
            &agents.to_string(),
            "--no-measures",
        ])
        .stdout(Stdio::null())
        .stderr(std::fs::File::create("worldd.out").unwrap_or_else(|e| fail(e)))
        .spawn()
        .unwrap_or_else(|e| fail(format!("worldd: {e}")));
    let mut file = String::new();
    let mut tokens = Vec::new();
    for p in &pairs {
        let t = Token::issue(Grant::Actor(Actor::Soul(p.0))).expect("random bytes");
        file.push_str(&Tokens::line(t.grant(), &t.hash()));
        tokens.push(t.reveal().to_owned());
    }
    std::fs::write("tokens", file).unwrap_or_else(|e| fail(e));
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .unwrap_or_else(|e| fail(e))
        .port();
    let listen = get("--listen")
        .cloned()
        .unwrap_or_else(|| format!("127.0.0.1:{port}"));
    let mut gw = if let Some(script) = &unit_script {
        unit(script, "start");
        wait_listening(&listen);
        Gw {
            child: None,
            addr: listen.clone(),
        }
    } else {
        start_gateway(
            Path::new("./gatewayd-old"),
            &listen,
            Path::new("gatewayd.out"),
        )
    };
    let url = format!("ws://{}{}", gw.addr, gatewayd::socket::PATH);

    // Every agent signs in before the clock starts.
    let gate = Arc::new(Semaphore::new(64));
    let ready = Arc::new(AtomicUsize::new(0));
    let mut chans = Vec::new();
    let mut tasks = Vec::new();
    for (k, t) in tokens.into_iter().enumerate() {
        let (tx, rx) = mpsc::unbounded_channel();
        chans.push(tx);
        tasks.push(tokio::spawn(agent(
            k as u64,
            url.clone(),
            t,
            pairs[k],
            gate.clone(),
            ready.clone(),
            rx,
        )));
    }
    while ready.load(Ordering::Relaxed) < agents {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;

    let start = Instant::now();
    let mut ev = Events {
        upgrade_at: Duration::from_secs(upgrade_at),
        kill_at: Duration::from_secs(kill_at),
        upgraded: None,
        killed: None,
        listen,
        unit: unit_script.clone(),
    };
    for (at, k) in &acts {
        let due = start + Duration::from_millis(*at);
        while Instant::now() < due {
            ev.step(start.elapsed(), &mut gw);
            tokio::time::sleep_until(due.min(Instant::now() + Duration::from_millis(100)).into())
                .await;
        }
        let _ = chans[*k].send(());
    }
    while ev.upgraded.is_none() || ev.killed.is_none() {
        ev.step(start.elapsed(), &mut gw);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (upgraded, killed) = (ev.upgraded, ev.killed);
    drop(chans);
    let mut seen = Vec::new();
    for t in tasks {
        seen.push(t.await.unwrap_or_else(|e| fail(e)));
    }
    if let Some(script) = &unit_script {
        unit(script, "stop");
    } else if let Some(child) = gw.child.as_mut() {
        let _ = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
        let _ = child.wait();
    }
    let _ = world.kill();
    let _ = world.wait();

    // The world's log: every (body, sequence) it answered.
    let log = std::fs::read("world.log").unwrap_or_else(|e| fail(e));
    let found = recover(&log).unwrap_or_else(|e| fail(e));
    let mut logged: BTreeSet<(Id, u64)> = BTreeSet::new();
    for r in &found.records {
        let Ok(Value::Map(part)) = decode(r).map(|d| d.value) else {
            continue;
        };
        let Some(Value::Array(rows)) = part.get(&ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(m) = row else { continue };
            let (Some(Value::Bytes(k)), Some(Value::Uint(q))) = (m.get(&1), m.get(&2)) else {
                continue;
            };
            let body = decode(k).ok().and_then(|d| match d.value {
                Value::Map(a) => a.get(&2).and_then(|v| read_id(v).ok()),
                _ => None,
            });
            if let Some(b) = body {
                logged.insert((b, *q));
            }
        }
    }

    let mut fails = Vec::new();
    println!("\n# O16 run: {describe}\n");
    println!(
        "| event | agents | current within 5 s | not back | p50 ms | p99 ms | slowest ms |\n|---|---:|---:|---:|---:|---:|---:|"
    );
    let (u, k) = (upgraded.expect("upgraded"), killed.expect("killed"));
    event_row("upgrade (SIGTERM, 1012)", u, Some(k), &seen, &mut fails);
    event_row("kill (SIGKILL, back in 1 s)", k, None, &seen, &mut fails);
    let mut outcomes: BTreeMap<String, u64> = BTreeMap::new();
    let (mut sent, mut once, mut none, mut twice, mut receipts) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut resent, mut restarting, mut acked, mut missing) = (0u64, 0u64, 0u64, 0u64);
    for (i, s) in seen.iter().enumerate() {
        restarting += s.restarting;
        resent += s.resent;
        for (o, n) in &s.outcomes {
            *outcomes.entry(o.clone()).or_default() += n;
        }
        for (q, e) in &s.ends {
            sent += 1;
            match e.len() {
                0 => none += 1,
                1 => once += 1,
                _ => twice += 1,
            }
            receipts += e.iter().filter(|x| matches!(x, End::Receipt)).count() as u64;
            if !e.is_empty() {
                acked += 1;
                if !logged.contains(&(pairs[i].0, *q)) {
                    missing += 1;
                }
            }
        }
    }
    println!(
        "\nSign-ins after a lost socket: {outcomes:?}.\n\n| intents sent | answered once | no answer | two or more | of them receipts | sent again after a reconnect | `world.restarting` (sent again) | acknowledged | acknowledged, not in the log |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n| {sent} | {once} | {none} | {twice} | {receipts} | {resent} | {restarting} | {acked} | {missing} |"
    );
    if none != 0 || twice != 0 || missing != 0 || sent == 0 {
        fails.push(format!("intents: {none} with no answer, {twice} with two or more, {missing} acknowledged and not logged"));
    }
    println!(
        "\nResult: {}",
        if fails.is_empty() {
            "pass".to_owned()
        } else {
            format!("FAIL {fails:?}")
        }
    );
    std::process::exit(i32::from(!fails.is_empty()));
}
