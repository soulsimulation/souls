//! O4's measures bench (Engine v2 O4, #2694).
//!
//! - `measures sum <dir> [acts] [rate] [sockets]` (A1): starts `worldd gateway-link` (I3's lamps world) and
//!   `gatewayd` in front of it, signs in `sockets` agents (default 100), and sends `acts` acts (default 10,000) at
//!   `rate` a second (default 200) in all, each agent on its own fixed schedule, so a time is from the act's intended
//!   send, never from the last answer (no coordinated omission). Each act toggles the agent's own lamp. For every
//!   answer it reads the block (`replica::intents::ANSWER_TIMES`): the gateway's whole time and ten parts. The
//!   network is the client's wait less the gateway's whole; the check is that the parts sum to the wait less the
//!   network within 1 ms. Prints the worst gap, the share over 1 ms, each part's median and 99th percentile, the
//!   network's, and how late the driver itself sent.
//! - `measures overhead [acts]` (A3): the clock thread's stamping per act, the same calls the clock thread makes
//!   (`worldd::measures`), `acts` times (default 1,000,000), twice.
//!
//! Build first: `cargo build --release -p gatewayd -p worldd -p bench`; the binaries are taken from this one's folder.
// A bench times a run by the wall clock (the wall-clock rule, K7, is the engine's: v2/clippy.toml).
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use gatewayd::token::{Grant, Token};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{ANSWER_TIMES, Fallback, Hello, Intent, PROTOCOL, Target};
use tokio_tungstenite::tungstenite::Message;
use worldd::answers::now;
use worldd::checkers::toggles;
use worldd::measures::{Measures, Stamps};

const LINEAGE: [u8; 16] = [0x4f; 16];
const NAMES: [&str; 11] = [
    "gateway.whole",
    "gateway.in",
    "link.in",
    "world.in",
    "check",
    "tick.wait",
    "commit",
    "log.sync",
    "world.out",
    "link.out",
    "gateway.out",
];

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("measures: {msg}");
    std::process::exit(1)
}

fn bin() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| fail("no folder for the binaries"))
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
        expiry: now() + 30_000_000,
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

/// An answer's sequence, whether it is a receipt, and its block.
fn read_answer(bytes: &[u8]) -> Option<(u64, bool, Vec<u64>)> {
    let Value::Map(m) = decode(bytes).ok()?.value else {
        return None;
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        return None;
    };
    let Some(Value::Uint(s)) = a.get(&2) else {
        return None;
    };
    let block = match m.get(&ANSWER_TIMES) {
        Some(Value::Array(b)) => b
            .iter()
            .filter_map(|v| match v {
                Value::Uint(n) => Some(*n),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    Some((*s, a.get(&3) == Some(&Value::Uint(1)), block))
}

/// One answered act: the client's wait from its intended send, how late the driver sent it, receipt?, the block.
struct Done {
    wait_us: u64,
    late_us: u64,
    receipt: bool,
    block: Vec<u64>,
}

#[allow(clippy::too_many_arguments)] // one agent's handles, passed once at spawn
async fn agent(
    url: String,
    token: String,
    body: Id,
    lamp: Id,
    acts: u64,
    every: Duration,
    start: tokio::time::Instant,
    out: Arc<Mutex<Vec<Done>>>,
) {
    let Ok((ws, _)) = tokio_tungstenite::connect_async(&url).await else {
        fail("an agent could not connect");
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
    let ok = tx
        .send(Message::Binary(hello.to_bytes().expect("hello").into()))
        .await
        .is_ok()
        && tx.send(Message::Binary(sign_in.into())).await.is_ok();
    for _ in 0..2 {
        if !ok || !matches!(rx.next().await, Some(Ok(Message::Binary(_)))) {
            fail("an agent's sign-in failed");
        }
    }
    // Intended send times: the reader measures from these, not from the actual send.
    let intended: Arc<Mutex<BTreeMap<u64, (tokio::time::Instant, u64)>>> = Arc::default();
    let reader = {
        let intended = Arc::clone(&intended);
        let out = Arc::clone(&out);
        tokio::spawn(async move {
            let mut got = 0;
            while got < acts {
                let Some(Ok(Message::Binary(b))) = rx.next().await else {
                    fail("an agent's socket closed");
                };
                let at = tokio::time::Instant::now();
                let Some((seq, receipt, block)) = read_answer(&b) else {
                    continue;
                };
                let Some((sent, late_us)) = intended.lock().unwrap().remove(&seq) else {
                    continue;
                };
                got += 1;
                let wait_us = u64::try_from((at - sent).as_micros()).unwrap_or(u64::MAX);
                out.lock().unwrap().push(Done {
                    wait_us,
                    late_us,
                    receipt,
                    block,
                });
            }
        })
    };
    for seq in 1..=acts {
        let due = start + every * u32::try_from(seq - 1).unwrap_or(u32::MAX);
        tokio::time::sleep_until(due).await;
        let bytes = toggle(body, lamp, seq);
        let late = u64::try_from(
            tokio::time::Instant::now()
                .saturating_duration_since(due)
                .as_micros(),
        )
        .unwrap_or(u64::MAX);
        intended.lock().unwrap().insert(seq, (due, late));
        if tx.send(Message::Binary(bytes.into())).await.is_err() {
            fail("an agent could not send");
        }
    }
    if tokio::time::timeout(Duration::from_secs(60), reader)
        .await
        .is_err()
    {
        fail("answers missing after 60 s");
    }
    let _ = tx.send(Message::Close(None)).await;
}

fn pct(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

fn kill(c: &mut Child) {
    let _ = c.kill();
    let _ = c.wait();
}

async fn sum(dir: &Path, acts: u64, rate: u64, sockets: u64) {
    std::fs::create_dir_all(dir).unwrap_or_else(|e| fail(format!("{}: {e}", dir.display())));
    let _ = std::fs::remove_file(dir.join("world.log"));
    let world = toggles::World::build(1, usize::try_from(sockets).unwrap_or(1), 0);
    let mut tokens = Vec::new();
    let mut file = String::new();
    for (body, _) in &world.pairs {
        let t = Token::issue(Grant::Actor(Actor::Soul(*body))).expect("random bytes");
        file.push_str(&gatewayd::token::Tokens::line(t.grant(), &t.hash()));
        tokens.push(t.reveal().to_owned());
    }
    std::fs::write(dir.join("tokens"), file).expect("the tokens file");
    let sock = dir.join("w.sock");
    let mut w = Command::new(bin().join("worldd"))
        .args(["gateway-link", "--socket"])
        .arg(&sock)
        .args(["--lineage", &to_hex(&LINEAGE), "--epoch", "1"])
        .args(["--bodies", &sockets.to_string(), "--log"])
        .arg(dir.join("world.log"))
        .arg("--health")
        .arg(dir.join("health.json"))
        .spawn()
        .unwrap_or_else(|e| fail(format!("worldd: {e}")));
    let log = std::fs::File::create(dir.join("gatewayd.log")).expect("a log file");
    let mut g = Command::new(bin().join("gatewayd"))
        .args(["--listen", "127.0.0.1:0", "--world"])
        .arg(&sock)
        .arg("--tokens")
        .arg(dir.join("tokens"))
        .args(["--build", "1220"])
        .stdout(Stdio::piped())
        .stderr(log)
        .spawn()
        .unwrap_or_else(|e| fail(format!("gatewayd: {e}")));
    let mut line = String::new();
    BufReader::new(g.stdout.take().expect("stdout"))
        .read_line(&mut line)
        .expect("gatewayd says where it listens");
    let addr = line.trim().strip_prefix("listening ").expect("an address");
    let url = format!("ws://{addr}{}", gatewayd::socket::PATH);
    tokio::time::sleep(Duration::from_millis(500)).await;

    let per = acts / sockets;
    let every = Duration::from_secs_f64(sockets as f64 / rate as f64);
    let start = tokio::time::Instant::now() + Duration::from_secs(2);
    let out: Arc<Mutex<Vec<Done>>> = Arc::default();
    let mut agents = Vec::new();
    for (i, (token, (body, lamp))) in tokens.into_iter().zip(world.pairs.clone()).enumerate() {
        // Each agent's schedule offset by its share of the interval, so sends are even in all.
        let offset = every.mul_f64(i as f64 / sockets as f64);
        agents.push(tokio::spawn(agent(
            url.clone(),
            token,
            body,
            lamp,
            per,
            every,
            start + offset,
            Arc::clone(&out),
        )));
    }
    for a in agents {
        let _ = a.await;
    }
    let health = std::fs::read_to_string(dir.join("health.json")).unwrap_or_default();
    kill(&mut g);
    kill(&mut w);

    let done = std::mem::take(&mut *out.lock().unwrap());
    let n = done.len() as u64;
    let receipts = done.iter().filter(|d| d.receipt).count();
    let blocks: Vec<&Done> = done
        .iter()
        .filter(|d| d.block.len() == NAMES.len())
        .collect();
    let mut gaps = Vec::new();
    let mut net = Vec::new();
    let mut late = Vec::new();
    let mut parts: Vec<Vec<u64>> = vec![Vec::new(); NAMES.len()];
    for d in &blocks {
        let whole = d.block[0];
        let sum: u64 = d.block[1..].iter().sum();
        gaps.push(whole.abs_diff(sum));
        net.push(d.wait_us.saturating_sub(whole));
        late.push(d.late_us);
        for (k, v) in d.block.iter().enumerate() {
            parts[k].push(*v);
        }
    }
    // The acts over 1 ms, worst first: their gap, how late the driver sent them, and their block.
    let mut worst: Vec<(u64, u64, &Vec<u64>)> = blocks
        .iter()
        .zip(&gaps)
        .filter(|(_, g)| **g > 1_000)
        .map(|(d, g)| (*g, d.late_us, &d.block))
        .collect();
    worst.sort_by(|a, b| b.0.cmp(&a.0));
    for (g, l, b) in worst.iter().take(10) {
        println!("over 1 ms: gap {g} us, driver late {l} us, block {b:?}");
    }
    for v in [&mut gaps, &mut net, &mut late] {
        v.sort_unstable();
    }
    let over = gaps.iter().filter(|g| **g > 1_000).count();
    println!(
        "acts {acts} at {rate}/s over {sockets} sockets: answered {n}, receipts {receipts}, with a block {}",
        blocks.len()
    );
    println!(
        "sum check |wait - network - parts|: max {} us, p99 {} us, over 1 ms {over} ({:.3}%)",
        gaps.last().copied().unwrap_or(0),
        pct(&gaps, 0.99),
        100.0 * over as f64 / blocks.len().max(1) as f64
    );
    println!(
        "network (wait - gateway whole): p50 {} us, p99 {} us, max {} us; driver late: p50 {} us, p99 {} us, max {} us",
        pct(&net, 0.5),
        pct(&net, 0.99),
        net.last().copied().unwrap_or(0),
        pct(&late, 0.5),
        pct(&late, 0.99),
        late.last().copied().unwrap_or(0)
    );
    for (k, name) in NAMES.iter().enumerate() {
        let v = &mut parts[k];
        v.sort_unstable();
        println!(
            "  {name:<14} p50 {:>7} us  p99 {:>7} us  max {:>7} us",
            pct(v, 0.5),
            pct(v, 0.99),
            v.last().copied().unwrap_or(0)
        );
    }
    println!("health.json at the end: {}", health.trim());
    if n != acts || blocks.len() as u64 != acts || over > 0 {
        std::process::exit(1);
    }
}

/// A3: the clock thread's stamping per act, by the same calls, `acts` times.
fn overhead(acts: u64) -> f64 {
    let m = Measures::default();
    // Arrivals are stamped on the socket's thread, before the clock thread: done first, outside the timing.
    let mut arrived: Vec<(Stamps, u64)> = (0..acts).map(|_| m.arrive()).collect();
    let t = Instant::now();
    for (i, (stamps, key)) in arrived.iter_mut().enumerate() {
        let act = i as u64;
        m.taken(*key, stamps);
        m.to_check(act, stamps.0[1]);
        m.checked(act, Some(stamps));
        m.left_tick(act);
    }
    let ns = t.elapsed().as_nanos() as f64 / acts as f64;
    std::hint::black_box(&arrived);
    ns
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let num = |k: usize, d: u64| args.get(k).and_then(|a| a.parse().ok()).unwrap_or(d);
    match args.get(1).map(String::as_str) {
        Some("sum") => {
            let Some(dir) = args.get(2) else {
                fail("usage: measures sum <dir> [acts] [rate] [sockets]");
            };
            sum(Path::new(dir), num(3, 10_000), num(4, 200), num(5, 100)).await;
        }
        Some("overhead") => {
            let acts = num(2, 1_000_000);
            for r in 1..=2 {
                println!(
                    "repeat {r}: {:.0} ns of stamping an act on the clock thread ({acts} acts)",
                    overhead(acts)
                );
            }
        }
        _ => fail("usage: measures sum <dir> [acts] [rate] [sockets] | measures overhead [acts]"),
    }
}
