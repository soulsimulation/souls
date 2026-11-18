//! Acts through the world process, from arrival to answer (Engine v2 I4, #2687). It starts `worldd gateway-link`
//! (I3's lamps world, one room of 200 bodies, each with a lamp, so a burst of 100 acts touches 100 lamps) and speaks the gateway's socket protocol to it
//! directly, so a time is from the intent's arrival at the world process to its answer. Each act toggles the
//! actor's own lamp (switch it on, else off as a fallback).
//!
//! - `act-latency latency <dir> [seconds]` (A1): 100 acts a second for `seconds` (default 30), evenly (one every
//!   10 ms) and in bursts (100 at once each second), two repeats of each, a fresh log each. Prints each run's
//!   answered share within 100 ms, the median, 99th percentile and longest.
//! - `act-latency kills <dir> [acts] [kills] [seed]` (A2): `acts` acts (default 10,000) at 500 a second, the world
//!   killed (SIGKILL) at `kills` random moments (default 50) and restarted on the same log; after each restart every
//!   act not yet answered is sent again with its sequence, as the gateway does. Counts acts never answered, answered
//!   later than their deadline after their last send, applied twice (one actor's sequence with entries under two
//!   intent ids in the log), and acknowledged but lost (a receipt whose entries the final log does not hold).
//!
//! Build first: `cargo build --release -p worldd -p bench`; `worldd` is taken from this binary's folder.
// A bench times a run by the wall clock (the wall-clock rule, K7, is the engine's: v2/clippy.toml).
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use replica::effects::{Actor, Cause, Part, read_id};
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Fallback, Intent, Target};
use sim::log::recover;
use worldd::answers::now;
use worldd::checkers::lamps;

const LINEAGE: [u8; 16] = [0x44; 16];
const BODIES: usize = 200;
/// How long an act may stay open in this bench: its expiry, from its send.
const EXPIRY_US: i64 = 3_000_000;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("act-latency: {msg}");
    std::process::exit(1)
}

struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        (z ^ (z >> 31)) % n.max(1)
    }
}

fn world(dir: &Path) -> (Child, UnixStream) {
    let bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| fail("no folder for worldd"));
    let sock = dir.join("w.sock");
    let _ = std::fs::remove_file(&sock);
    let child = Command::new(bin.join("worldd"))
        .args(["gateway-link", "--socket"])
        .arg(&sock)
        .args(["--lineage", &to_hex(&LINEAGE), "--epoch", "1"])
        .args(["--bodies", &BODIES.to_string(), "--log"])
        .arg(dir.join("world.log"))
        .spawn()
        .unwrap_or_else(|e| fail(format!("worldd: {e}")));
    let mut child = child;
    let started = Instant::now();
    loop {
        if let Ok(s) = UnixStream::connect(&sock) {
            return (child, s);
        }
        if started.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            fail("worldd did not listen within 10 s");
        }
        std::thread::sleep(Duration::from_millis(2));
    }
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
        expiry: now() + EXPIRY_US,
        resources: Vec::new(),
        fallbacks: vec![Fallback {
            verb: n("r2:switch_off"),
            target: Some(Target::Node(lamp)),
            parameters: BTreeMap::new(),
            resources: Vec::new(),
        }],
        replaces: None,
        body: None,
    };
    encode(&i.to_value()).expect("an intent")
}

fn send(s: &mut UnixStream, bytes: &[u8]) -> bool {
    let len = u32::try_from(bytes.len()).expect("small").to_be_bytes();
    s.write_all(&len).is_ok() && s.write_all(bytes).is_ok()
}

/// What an answer says: the actor's body, the sequence, a receipt's intent id and entries, or a refusal's reason.
struct Answered {
    body: Id,
    sequence: u64,
    receipt: Option<(Id, Vec<u64>)>,
    reason: String,
    at: Instant,
}

fn read_answer(frame: &[u8], at: Instant) -> Option<Answered> {
    let Value::Map(m) = decode(frame).ok()?.value else {
        return None;
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        return None;
    };
    let body = match a.get(&1)? {
        Value::Map(actor) => read_id(actor.get(&2)?).ok()?,
        _ => return None,
    };
    let Value::Uint(sequence) = a.get(&2)? else {
        return None;
    };
    let (receipt, reason) = match (a.get(&3)?, a.get(&4)?) {
        (Value::Uint(1), id) => {
            let Some(Value::Array(e)) = a.get(&5) else {
                return None;
            };
            let entries = e
                .iter()
                .map(|v| match v {
                    Value::Uint(n) => Some(*n),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()?;
            (Some((read_id(id).ok()?, entries)), String::new())
        }
        (_, Value::Text(t)) => (None, t.as_str().to_owned()),
        _ => (None, String::new()),
    };
    Some(Answered {
        body,
        sequence: *sequence,
        receipt,
        reason,
        at,
    })
}

/// Reads answer frames off the socket until it closes.
fn reader(mut s: UnixStream) -> Receiver<Answered> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        loop {
            let mut len = [0u8; 4];
            if s.read_exact(&mut len).is_err() {
                return;
            }
            let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
            if s.read_exact(&mut frame).is_err() {
                return;
            }
            if let Some(a) = read_answer(&frame, Instant::now())
                && tx.send(a).is_err()
            {
                return;
            }
        }
    });
    rx
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted.get(i).copied().unwrap_or(0.0)
}

fn latency_run(
    dir: &Path,
    pairs: &[(Id, Id)],
    seconds: u64,
    bursts: bool,
) -> (usize, f64, f64, f64, f64) {
    let _ = std::fs::remove_file(dir.join("world.log"));
    let (mut child, mut s) = world(dir);
    let answers = reader(s.try_clone().expect("a socket"));
    let mut sent: BTreeMap<(Id, u64), Instant> = BTreeMap::new();
    let mut seq = vec![0u64; pairs.len()];
    let total = seconds as usize * 100;
    let start = Instant::now();
    for k in 0..total {
        // Even: act k at k × 10 ms. Bursts: the 100 acts of second k / 100 all at its start.
        let due = if bursts {
            Duration::from_secs((k / 100) as u64)
        } else {
            Duration::from_millis(k as u64 * 10)
        };
        if let Some(wait) = (start + due).checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        let a = k % pairs.len();
        seq[a] += 1;
        let (body, lamp) = pairs[a];
        sent.insert((body, seq[a]), Instant::now());
        if !send(&mut s, &toggle(body, lamp, seq[a])) {
            fail("the world closed the socket");
        }
    }
    let mut ms = Vec::with_capacity(total);
    let mut receipts = 0;
    while ms.len() < total {
        let a = answers
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| fail(format!("{} of {total} answered", ms.len())));
        if let Some(t) = sent.get(&(a.body, a.sequence)) {
            ms.push(a.at.duration_since(*t).as_secs_f64() * 1e3);
            receipts += usize::from(a.receipt.is_some());
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let within = ms.iter().filter(|m| **m <= 100.0).count() as f64 / total as f64 * 100.0;
    ms.sort_by(f64::total_cmp);
    let _ = receipts;
    (
        total,
        within,
        pct(&ms, 0.5),
        pct(&ms, 0.99),
        ms[ms.len() - 1],
    )
}

fn latency(dir: &Path, seconds: u64) {
    let pairs = lamps::World::build(1, BODIES, 0).pairs;
    println!(
        "act latency: 100 acts a second for {seconds} s, arrival at the world process to answer, 50 ms ticks"
    );
    println!("| arm | repeat | acts | within 100 ms | median ms | p99 ms | longest ms |");
    println!("|---|---|---|---|---|---|---|");
    for (arm, bursts) in [("even", false), ("bursts", true)] {
        for rep in 1..=2 {
            let (n, within, p50, p99, max) = latency_run(dir, &pairs, seconds, bursts);
            println!("| {arm} | {rep} | {n} | {within:.2} % | {p50:.1} | {p99:.1} | {max:.1} |");
        }
    }
}

struct Pending {
    bytes: Vec<u8>,
    last_sent: Instant,
}

fn kills(dir: &Path, acts: u64, kills: u64, seed: u64) {
    let _ = std::fs::remove_file(dir.join("world.log"));
    let pairs = lamps::World::build(1, BODIES, 0).pairs;
    let mut rng = Rng(seed);
    let mut at: Vec<u64> = (0..kills).map(|_| 1 + rng.below(acts - 1)).collect();
    at.sort_unstable();
    let mut pending: BTreeMap<(u64, usize), Pending> = BTreeMap::new();
    let mut answered: BTreeMap<(Id, u64), Answered> = BTreeMap::new();
    let mut open_late = 0u64;
    let mut longest_open = Duration::ZERO;
    let mut seq = vec![0u64; pairs.len()];
    let index: BTreeMap<Id, usize> = pairs.iter().enumerate().map(|(i, p)| (p.0, i)).collect();
    let mut made = 0u64;
    let started = Instant::now();
    let mut take = |answers: &Receiver<Answered>,
                    pending: &mut BTreeMap<(u64, usize), Pending>,
                    wait: Duration| {
        while let Ok(a) = answers.recv_timeout(wait) {
            let Some(&i) = index.get(&a.body) else {
                continue;
            };
            if let Some(p) = pending.remove(&(a.sequence, i)) {
                let open = a.at.duration_since(p.last_sent);
                longest_open = longest_open.max(open);
                // The deadline is the expiry, 3 s after the send; one tick and a sync may follow it.
                if open > Duration::from_micros(EXPIRY_US as u64) + Duration::from_millis(100) {
                    open_late += 1;
                }
                answered.insert((a.body, a.sequence), a);
            }
            if wait > Duration::ZERO && pending.is_empty() {
                break;
            }
        }
    };
    for (round, kill_at) in at.iter().copied().chain([acts]).enumerate() {
        let (mut child, mut s) = world(dir);
        let answers = reader(s.try_clone().expect("a socket"));
        // Unanswered acts again, in sequence order per actor, as the gateway sends them after a reconnect.
        for p in pending.values_mut() {
            p.last_sent = Instant::now();
            send(&mut s, &p.bytes);
        }
        while made < kill_at {
            let a = (made as usize) % pairs.len();
            seq[a] += 1;
            let bytes = toggle(pairs[a].0, pairs[a].1, seq[a]);
            send(&mut s, &bytes);
            pending.insert(
                (seq[a], a),
                Pending {
                    bytes,
                    last_sent: Instant::now(),
                },
            );
            made += 1;
            std::thread::sleep(Duration::from_millis(2));
            take(&answers, &mut pending, Duration::ZERO);
        }
        if round as u64 == kills {
            take(&answers, &mut pending, Duration::from_secs(10));
        } else {
            // Somewhere in the next tick or two: the kill lands on acts open, checked, committed or syncing.
            std::thread::sleep(Duration::from_millis(rng.below(60)));
            take(&answers, &mut pending, Duration::ZERO);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    let log = std::fs::read(dir.join("world.log")).unwrap_or_else(|e| fail(e));
    let found = recover(&log).unwrap_or_else(|e| fail(e));
    let mut by_intent: BTreeMap<Id, Vec<u64>> = BTreeMap::new();
    let mut intents_of: BTreeMap<(Vec<u8>, u64), Vec<Id>> = BTreeMap::new();
    for r in found.records.iter().filter(|r| !sim::recorder::is_input(r)) {
        let part = Part::read(r).unwrap_or_else(|e| fail(e));
        for e in &part.effects {
            if let Cause::Intent(id) = e.envelope.cause {
                by_intent.entry(id).or_default().push(e.envelope.sequence);
            }
        }
        if let Some(Value::Array(rows)) = part.rest.get(&worldd::answers::ANSWERED) {
            for row in rows {
                let Value::Map(m) = row else { continue };
                if let (Some(Value::Bytes(k)), Some(Value::Uint(q)), Some(id)) =
                    (m.get(&1), m.get(&2), m.get(&3))
                    && let Ok(id) = read_id(id)
                {
                    intents_of.entry((k.clone(), *q)).or_default().push(id);
                }
            }
        }
    }
    let twice = intents_of
        .values()
        .filter(|ids| ids.iter().filter(|id| by_intent.contains_key(id)).count() > 1)
        .count();
    let receipts: Vec<&(Id, Vec<u64>)> = answered
        .values()
        .filter_map(|a| a.receipt.as_ref())
        .collect();
    let lost = receipts
        .iter()
        .filter(|(id, entries)| by_intent.get(id) != Some(entries))
        .count();
    let mut reasons: BTreeMap<&str, u64> = BTreeMap::new();
    for a in answered.values() {
        *reasons
            .entry(if a.receipt.is_some() {
                "receipt"
            } else {
                a.reason.as_str()
            })
            .or_default() += 1;
    }
    println!(
        "kill run: {acts} acts, {kills} kills (seed {seed}), {:.1} s, {} log records",
        started.elapsed().as_secs_f64(),
        found.records.len()
    );
    println!("| count | value |");
    println!("|---|---|");
    println!("| acts answered | {} of {acts} |", answered.len());
    println!("| never answered | {} |", pending.len());
    println!("| answered after their deadline (3 s expiry + 100 ms) | {open_late} |");
    println!(
        "| longest from last send to answer | {:.0} ms |",
        longest_open.as_secs_f64() * 1e3
    );
    println!("| applied twice | {twice} |");
    println!("| receipts | {} |", receipts.len());
    println!("| acknowledged and lost | {lost} |");
    for (r, n) in reasons {
        println!("| answered `{r}` | {n} |");
    }
    if !pending.is_empty() || open_late > 0 || twice > 0 || lost > 0 {
        std::process::exit(1);
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let num = |k: usize, d: u64| a.get(k).map_or(Some(d), |v| v.parse().ok());
    let dir = a.get(2).map(PathBuf::from);
    match (a.get(1).map(String::as_str), dir) {
        (Some("latency"), Some(dir)) => {
            latency(&dir, num(3, 30).unwrap_or_else(|| fail("seconds")))
        }
        (Some("kills"), Some(dir)) => kills(
            &dir,
            num(3, 10_000).unwrap_or_else(|| fail("acts")),
            num(4, 50).unwrap_or_else(|| fail("kills")),
            num(5, 1).unwrap_or_else(|| fail("seed")),
        ),
        _ => fail("usage: act-latency latency <dir> [seconds] | kills <dir> [acts] [kills] [seed]"),
    }
}
