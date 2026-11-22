//! The driver (Engine v2 I10, #2693): one program that drives scripted agents through `gatewayd` from a schedule, open
//! loop, and says whether it kept up. `loads.mjs` writes the schedule from the shared load shapes; this sends each act
//! as its agent's next intent at its due time, never waiting for an answer before the next is due (a driver that
//! waits hides the slow ones: coordinated omission). One thread does all of it, so the driver's cores are its own.
//!
//! Build: `cargo build --release -p gatewayd -p worldd -p driver` (from `v2/`). Then
//! `target/release/driver --schedule <file> --dir <empty folder> [--think-ms 0] [--late-ms 50]`. It starts `worldd
//! gateway-link` (which answers every intent with a receipt, until I4) and `gatewayd` from its own folder, signs every
//! agent in, runs the schedule and prints the report (also `report.json` in the folder): the schedule's describe line,
//! intended against achieved ("under-driven" below 95 %), how late each act was sent against its due time, the
//! driver's cores (`driverCores`, its own user and system time over the run), the answers, kinds with no v2 intent,
//! and `byTenth`, the same numbers per tenth of the agents by intended acts, busiest first
//! (tools/playtest/eval/load.mjs's words).
//!
//! With `--remote <gateway address> --tokens <file>` (X7, #4015) it starts nothing: it signs in the file's tokens, one
//! pre-paired test Soul each (agent k takes line k), at a gateway that serves a world, and sends the same schedule as
//! those Souls. Either way the report adds `perMinute`: receipts a second, act latency (send to the act's first answer)
//! p50/p95/p99, refusals by name and errors by name. On a served world the walks, sits and forms go to the world's own
//! ids, read before the clock starts as a client reads them (`targets.rs`), and says are withheld unless `--speech`.

// The repeat rule's map ban (K12, v2/clippy.toml) is `sim`'s; the driver's maps are lookups.
#![allow(clippy::disallowed_types)]

mod targets;

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use gatewayd::token::{Grant, Token, Tokens};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL, Target};
use tokio::sync::{Semaphore, mpsc};
use tokio_tungstenite::tungstenite::Message;

const LINEAGE: [u8; 16] = [7; 16];

/// One act of the schedule: due at `at_ms` from the start, by `agent`, of shape kind `kind` (an index into the
/// schedule's kinds), carried by `verb` (None: no v2 intent for the kind yet).
#[derive(Debug, PartialEq)]
struct Act {
    at_ms: u64,
    agent: u32,
    kind: usize,
    verb: Option<usize>,
}

#[derive(Debug, Default, PartialEq)]
struct Schedule {
    describe: String,
    kinds: Vec<String>,
    verbs: Vec<String>,
    acts: Vec<Act>,
    agents: u32,
}

/// Reads `loads.mjs`'s file: `# <describe line>`, then `<due ms> <agent> <kind> <verb or ->` a line.
fn parse(text: &str) -> Result<Schedule, String> {
    let mut s = Schedule::default();
    let (mut kinds, mut verbs) = (HashMap::new(), HashMap::new());
    for (n, line) in text.lines().enumerate() {
        if let Some(d) = line.strip_prefix("# ") {
            s.describe = d.to_owned();
            continue;
        }
        let f: Vec<&str> = line.split(' ').collect();
        let bad = || {
            format!(
                "line {}: `{line}` is not `<due ms> <agent> <kind> <verb>`",
                n + 1
            )
        };
        let [at, agent, kind, verb] = f[..] else {
            return Err(bad());
        };
        let (Ok(at_ms), Ok(agent)) = (at.parse(), agent.parse::<u32>()) else {
            return Err(bad());
        };
        if s.acts.last().is_some_and(|a: &Act| a.at_ms > at_ms) {
            return Err(format!("line {}: not in time order", n + 1));
        }
        let index = |m: &mut HashMap<String, usize>, v: &mut Vec<String>, x: &str| {
            *m.entry(x.to_owned()).or_insert_with(|| {
                v.push(x.to_owned());
                v.len() - 1
            })
        };
        let kind = index(&mut kinds, &mut s.kinds, kind);
        let verb = (verb != "-").then(|| index(&mut verbs, &mut s.verbs, verb));
        s.agents = s.agents.max(agent + 1);
        s.acts.push(Act {
            at_ms,
            agent,
            kind,
            verb,
        });
    }
    Ok(s)
}

/// Lateness in microseconds at the given share (0 to 1) of a sorted list.
fn at_share(sorted: &[u64], share: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let k = ((sorted.len() - 1) as f64 * share).round() as usize;
    sorted[k.min(sorted.len() - 1)]
}

/// One agent's numbers after the run.
#[derive(Default)]
struct Sent {
    intended: u64,
    /// Microseconds from each act's due time to the end of its send.
    late_us: Vec<u64>,
    receipts: u64,
    other: u64,
    closed: bool,
    /// The answers by the minute of the run they came in (X7 A2).
    minutes: Vec<Minute>,
    /// Refusals by `<verb> <name>`, over the run.
    refused_by: BTreeMap<String, u64>,
    /// X10: second receipts for one sequence, intents sent again (after a lost socket or `world.restarting`), and
    /// `world.restarting` answers.
    duplicates: u64,
    resent: u64,
    restarting: u64,
    /// Acts answered accepted (kind 3) and not yet ended when the drain ran out: answered, so not an error (W11).
    unfinished: u64,
    /// X10's trace lines (`--trace`): `ack|dup <agent> <sequence> <unix ms>`, `first <agent> <sequence> <sent unix ms>
    /// <answer unix ms> <receipt or refusal name>`, `gone|back <agent> <unix ms>`.
    trace: Vec<String>,
}

/// One minute of the run's answers: receipts (an act's end, kind 1), refusals and errors by name, and each answered
/// act's latency from its send to its first answer (an acceptance, a receipt or a refusal), in microseconds.
#[derive(Default)]
struct Minute {
    receipts: u64,
    refusals: BTreeMap<String, u64>,
    errors: BTreeMap<String, u64>,
    latency_us: Vec<u64>,
}

impl Sent {
    fn minute(&mut self, start: Instant, at: Instant) -> &mut Minute {
        let k = (at.saturating_duration_since(start).as_secs() / 60) as usize;
        if self.minutes.len() <= k {
            self.minutes.resize_with(k + 1, Minute::default);
        }
        &mut self.minutes[k]
    }
    fn error(&mut self, start: Instant, at: Instant, name: &str) {
        *self
            .minute(start, at)
            .errors
            .entry(name.to_owned())
            .or_default() += 1;
    }
}

/// `n` added to `name` in a count by name.
fn add(m: &mut BTreeMap<String, u64>, from: &BTreeMap<String, u64>) {
    for (k, v) in from {
        *m.entry(k.clone()).or_default() += v;
    }
}

/// The run's minutes, every agent's merged: receipts a second over the part of the minute the run covered, latency
/// quantiles (ms) over every answered act, refusals and errors by name.
fn per_minute(agents: &[Sent], wall: Duration) -> Vec<serde_like::Obj> {
    let n = agents.iter().map(|a| a.minutes.len()).max().unwrap_or(0);
    (0..n)
        .map(|k| {
            let mut m = Minute::default();
            for a in agents.iter().filter_map(|a| a.minutes.get(k)) {
                m.receipts += a.receipts;
                add(&mut m.refusals, &a.refusals);
                add(&mut m.errors, &a.errors);
                m.latency_us.extend_from_slice(&a.latency_us);
            }
            m.latency_us.sort_unstable();
            let covered = (wall.as_secs_f64() - 60.0 * k as f64).clamp(1.0, 60.0);
            let ms = |share| at_share(&m.latency_us, share) as f64 / 1000.0;
            serde_like::Obj::new()
                .n("minute", (k + 1) as f64)
                .n("receipts", m.receipts as f64)
                .n(
                    "receiptsPerS",
                    (10.0 * m.receipts as f64 / covered).round() / 10.0,
                )
                .n("answered", m.latency_us.len() as f64)
                .n("latencyP50Ms", ms(0.5))
                .n("latencyP95Ms", ms(0.95))
                .n("latencyP99Ms", ms(0.99))
                .raw("refusals", counts(&m.refusals))
                .raw("errors", counts(&m.errors))
        })
        .collect()
}

/// A count by name as a JSON object.
fn counts<K: std::fmt::Debug>(m: &BTreeMap<K, u64>) -> String {
    let f: Vec<String> = m.iter().map(|(k, v)| format!("{k:?}: {v}")).collect();
    format!("{{{}}}", f.join(", "))
}

/// The numbers of a group of agents: intended, sent, the share sent within `late_ms`, and lateness quantiles (ms).
fn group(agents: &[&Sent], late_ms: u64) -> serde_like::Obj {
    let intended: u64 = agents.iter().map(|a| a.intended).sum();
    let mut late: Vec<u64> = agents
        .iter()
        .flat_map(|a| a.late_us.iter().copied())
        .collect();
    late.sort_unstable();
    let on_time = late.iter().filter(|&&x| x <= late_ms * 1000).count() as u64;
    let ms = |us: u64| us as f64 / 1000.0;
    serde_like::Obj::new()
        .n("agents", agents.len() as f64)
        .n("intended", intended as f64)
        .n("sent", late.len() as f64)
        .n("onTimeShare", ratio(on_time, intended))
        .n("lateP50Ms", ms(at_share(&late, 0.5)))
        .n("lateP99Ms", ms(at_share(&late, 0.99)))
        .n("lateP999Ms", ms(at_share(&late, 0.999)))
        .n("lateMaxMs", ms(late.last().copied().unwrap_or(0)))
}

fn ratio(a: u64, b: u64) -> f64 {
    if b == 0 {
        0.0
    } else {
        (1000.0 * a as f64 / b as f64).round() / 1000.0
    }
}

/// `byTenth`: the agents in ten groups by intended acts, busiest first, each with `group`'s numbers.
fn by_tenth(agents: &[Sent], late_ms: u64) -> Vec<serde_like::Obj> {
    let mut s: Vec<&Sent> = agents.iter().collect();
    s.sort_by(|a, b| b.intended.cmp(&a.intended));
    let parts = s.len().min(10);
    (0..parts)
        .map(|t| {
            let (a, b) = (t * s.len() / parts, (t + 1) * s.len() / parts);
            group(&s[a..b], late_ms).n("tenth", (t + 1) as f64)
        })
        .collect()
}

/// A tiny JSON writer, so the report needs no dependency.
mod serde_like {
    pub struct Obj(Vec<(String, String)>);
    impl Obj {
        pub fn new() -> Obj {
            Obj(Vec::new())
        }
        pub fn n(mut self, k: &str, v: f64) -> Obj {
            self.0.push((k.into(), format!("{v}")));
            self
        }
        pub fn s(mut self, k: &str, v: &str) -> Obj {
            self.0.push((k.into(), format!("{v:?}")));
            self
        }
        pub fn raw(mut self, k: &str, v: String) -> Obj {
            self.0.push((k.into(), v));
            self
        }
        pub fn get(&self, k: &str) -> Option<f64> {
            self.0
                .iter()
                .find(|(x, _)| x == k)
                .and_then(|(_, v)| v.parse().ok())
        }
        pub fn json(&self) -> String {
            let f: Vec<String> = self.0.iter().map(|(k, v)| format!("{k:?}: {v}")).collect();
            format!("{{{}}}", f.join(", "))
        }
    }
    pub fn list(v: &[Obj]) -> String {
        format!(
            "[{}]",
            v.iter().map(Obj::json).collect::<Vec<_>>().join(", ")
        )
    }
}

/// This process's user and system time, in microseconds.
fn cpu_us() -> u64 {
    // SAFETY: getrusage fills the struct it is given; a zeroed rusage is a valid value for it.
    let mut r: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: RUSAGE_SELF with a valid pointer.
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut r) };
    let us = |t: libc::timeval| t.tv_sec as u64 * 1_000_000 + t.tv_usec as u64;
    us(r.ru_utime) + us(r.ru_stime)
}

fn soul(n: u32) -> Actor {
    Actor::Soul(Id::new(Scope([3; 16]), u64::from(n)).expect("a counter"))
}

/// The basis every intent is decided against: the driver's own world's start, or, on a served world it has never
/// read, the zero version (as a client with nothing shown sends it).
fn basis(remote: bool) -> Value {
    let lineage = Scope(if remote { [0; 16] } else { LINEAGE });
    Version {
        lineage,
        zone: Id::new(lineage, 0).expect("a zone"),
        epoch: u64::from(!remote),
        sequence: 0,
    }
    .to_value()
}

/// The words a say carries (parameter 1, `{23: words}`, as the client's `wireIntent` sends them): a served world
/// refuses a say with none (`intent.no-words`). Every other act goes with no parameter, and with its target on a
/// served world (`targets.rs`), none on the driver's own.
const WORDS: &str = "(load test)";

fn intent(actor: Actor, verb: &Name, target: Option<Id>, sequence: u64, basis: &Value) -> Vec<u8> {
    let mut parameters = BTreeMap::new();
    if verb.as_str().ends_with(":say") {
        let words = Value::Map([(23, Value::Bytes(WORDS.as_bytes().to_vec()))].into());
        parameters.insert(1, words);
    }
    let i = Intent {
        actor,
        verb: verb.clone(),
        target: target.map(Target::Node),
        parameters,
        sequence,
        basis: basis.clone(),
        // No expiry: a served world's clock is far past any fixed one (the client's default, Number.MAX_SAFE_INTEGER).
        expiry: (1 << 53) - 1,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).expect("an intent")
}

/// What a frame from the gateway says about the acts.
#[derive(Debug, PartialEq)]
enum Heard {
    /// An act's receipt (`replica::intents::Answer` kind 1), by its sequence: its end.
    Receipt(u64),
    /// An act accepted and still going (kind 3, C20's progress answer; W11 #4087), by its sequence: its first answer,
    /// not its end, which a receipt or a refusal brings later.
    Accepted(u64),
    /// An act refused, by its sequence and the refusal's name (kind 2).
    Refused(u64, String),
    /// Bytes the gateway could not read (kind 5), or a gateway's own word (`{4: name}`, a token refused): an error.
    Error(String),
    /// Anything else: a move's outcome, the stream.
    Other,
}

fn heard(bytes: &[u8]) -> Heard {
    let Ok(Value::Map(m)) = decode(bytes).map(|d| d.value) else {
        return Heard::Other;
    };
    let name = |v: Option<&Value>| match v {
        Some(Value::Text(t)) => t.as_str().to_owned(),
        _ => "unnamed".to_owned(),
    };
    if let (None, Some(v @ Value::Text(_))) = (m.get(&2), m.get(&4)) {
        return Heard::Error(name(Some(v)));
    }
    let Some(Value::Map(a)) = m.get(&2) else {
        return Heard::Other;
    };
    match (a.get(&2), a.get(&3)) {
        (Some(Value::Uint(s)), Some(Value::Uint(1))) => Heard::Receipt(*s),
        (Some(Value::Uint(s)), Some(Value::Uint(3))) => Heard::Accepted(*s),
        (Some(Value::Uint(s)), Some(Value::Uint(2))) => Heard::Refused(*s, name(a.get(&4))),
        (_, Some(Value::Uint(5))) => Heard::Error(name(a.get(&4))),
        _ => Heard::Other,
    }
}

/// What the run hands an agent: an act, or (the first agent, before the clock starts) a request to read its copy.
enum Job {
    Act(Due),
    Read(tokio::sync::oneshot::Sender<Result<targets::Seen, String>>),
}

/// One act handed to its agent: due at, the intent's bytes, its sequence, and the run's start.
struct Due {
    at: Instant,
    bytes: Vec<u8>,
    sequence: u64,
    start: Instant,
    verb: Name,
}

/// How long an agent waits for its answers after its last act: a form's receipt comes when it ends, seconds later.
const DRAIN_S: u64 = 15;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type Tx = futures_util::stream::SplitSink<Ws, Message>;
type Rx = futures_util::stream::SplitStream<Ws>;

/// Opens a socket and signs in: T10's first frame, the sign-in (an agent's token or a view token), the gateway's
/// first frame, then the sign-in's outcome (`stream.*` or `view.started`; anything else named is a refusal).
async fn sign_in(url: &str, token: &str) -> Option<(Tx, Rx)> {
    let (ws, _) = tokio_tungstenite::connect_async(url).await.ok()?;
    let (mut tx, mut rx) = ws.split();
    let hello = Hello {
        protocol: PROTOCOL,
        build: vec![0x12, 0x20],
        refused: None,
        other: None,
    };
    let sign_in = encode(&Value::Map(
        [(1, Value::Text(Name::new(token).expect("a token")))].into(),
    ))
    .expect("a sign-in");
    tx.send(Message::Binary(hello.to_bytes().expect("hello").into()))
        .await
        .ok()?;
    tx.send(Message::Binary(sign_in.into())).await.ok()?;
    if !matches!(rx.next().await, Some(Ok(Message::Binary(_)))) {
        return None;
    }
    match rx.next().await {
        Some(Ok(Message::Binary(b))) => match heard(&b) {
            Heard::Error(n) if !n.starts_with("stream.") && !n.starts_with("view.") => None,
            _ => Some((tx, rx)),
        },
        _ => None,
    }
}

/// The faults an agent takes part in (X10, #4019): it comes back as the runbook's client does when its socket is lost
/// (`--reconnect`), and drops its own socket at a second of the run and comes back after a while (`--drop`).
#[derive(Clone, Copy, Default)]
struct Faults {
    reconnect: bool,
    /// Seconds from the clock's start to the drop, and seconds away.
    drop: Option<(u64, u64)>,
}

/// A `world.restarting` answer is the gateway's, not the world's: the client sends the intent again this much later.
const RESTARTING_RETRY: Duration = Duration::from_millis(200);
/// How long a lost agent keeps trying to sign in again before it counts as gone.
const RECONNECT_MOST: Duration = Duration::from_secs(120);

/// Unix milliseconds now, for the trace.
#[allow(clippy::disallowed_methods)]
fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Signs in again after a lost socket: first a wait inside 2 s fixed by the agent's number (so a crowd does not come
/// back at once), then a try every 50 to 250 ms, until [`RECONNECT_MOST`].
#[allow(clippy::disallowed_methods)]
async fn come_back(url: &str, token: &str, k: u32, jitter: bool) -> Option<(Tx, Rx)> {
    if jitter {
        tokio::time::sleep(Duration::from_millis(u64::from(k) * 7919 % 2000)).await;
    }
    let until = Instant::now() + RECONNECT_MOST;
    let mut n = u64::from(k);
    while Instant::now() < until {
        if let Some(s) = sign_in(url, token).await {
            return Some(s);
        }
        n = n
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        tokio::time::sleep(Duration::from_millis(50 + (n >> 33) % 200)).await;
    }
    None
}

/// One agent: first frame and sign-in, then each intent the schedule hands it, sent at once; then its answers, each
/// act's first answer timed from its send (an accepted act's acceptance, W11 #4087), each act kept until its end (its
/// receipt or refusal). Acts still unanswered at the drain's end are errors (`unanswered`); accepted ones not yet
/// ended are counted as `unfinished`, not as errors.
/// With [`Faults`] it comes back after a lost or dropped socket and sends again, under its old sequence, every intent
/// it has no answer for (the runbook's client, `v2/docs/runbook/gateway-upgrade.md`). A second receipt for one
/// sequence is counted as a duplicate.
// A tool, not the engine: it measures each send's lateness against its due time by the wall clock (K7, v2/clippy.toml).
#[allow(clippy::disallowed_methods, clippy::too_many_arguments)]
async fn agent(
    k: u32,
    url: String,
    token: String,
    gate: Arc<Semaphore>,
    ready: Arc<AtomicU64>,
    seated: Arc<std::sync::atomic::AtomicBool>,
    warm: Option<(Vec<u8>, u64)>,
    faults: Faults,
    mut acts: mpsc::UnboundedReceiver<Job>,
) -> Sent {
    let mut out = Sent::default();
    let permit = gate.acquire().await;
    let Some((mut tx, mut rx)) = sign_in(&url, &token).await else {
        out.closed = true;
        ready.fetch_add(1, Ordering::Relaxed);
        return out;
    };
    let mut ok = true;
    // On a served world a Soul's body is born by its first intent (C3): a rise, before the clock, answered (refused
    // `not-seated` or taken) before the agent counts as ready, so every body is in the world when targets are read.
    if let Some((bytes, sequence)) = warm {
        ok = tx.send(Message::Binary(bytes.into())).await.is_ok();
        let until = Instant::now() + Duration::from_secs(30);
        while ok && Instant::now() < until {
            match tokio::time::timeout_at(until.into(), rx.next()).await {
                Ok(Some(Ok(Message::Binary(b)))) => match heard(&b) {
                    Heard::Receipt(s) | Heard::Refused(s, _) if s == sequence => break,
                    _ => {}
                },
                Ok(Some(Ok(_))) => {}
                Ok(_) => ok = false,
                Err(_) => break,
            }
        }
    }
    drop(permit);
    out.closed = !ok;
    ready.fetch_add(1, Ordering::Relaxed);
    if !ok {
        return out;
    }
    // Sent and not yet answered: sequence → when it went (instant and Unix ms) and its bytes, sent again after a lost
    // socket.
    let mut pending: BTreeMap<u64, (Instant, u64, Vec<u8>)> = BTreeMap::new();
    let mut verb_of: HashMap<u64, Name> = HashMap::new();
    // Sequences with a receipt (kind 1): a second is a duplicate.
    let mut receipted: std::collections::HashSet<u64> = std::collections::HashSet::new();
    // Pending sequences answered accepted (kind 3): their first answer is timed; their end is still to come.
    let mut accepted: std::collections::HashSet<u64> = std::collections::HashSet::new();
    // Intents answered `world.restarting`: sent again at their time.
    let mut retry: std::collections::VecDeque<(Instant, u64)> = std::collections::VecDeque::new();
    let mut start: Option<Instant> = None;
    let mut drain_until: Option<Instant> = None;
    let mut drop_at: Option<Instant> = None;
    loop {
        if drain_until
            .is_some_and(|u| Instant::now() >= u || (pending.is_empty() && retry.is_empty()))
        {
            break;
        }
        let wait = drain_until.map_or(Duration::from_secs(3600), |u| u - Instant::now());
        let next_retry = retry.front().map(|r| r.0);
        // Lost: the socket closed under it (true), or its own drop came (false).
        let mut lost: Option<bool> = None;
        tokio::select! {
            a = acts.recv(), if drain_until.is_none() => match a {
                Some(Job::Read(back)) => {
                    let _ = back.send(targets::sync_copy(&mut tx, &mut rx).await);
                }
                Some(Job::Act(d)) => {
                    // An agent drops only if it is there at the drop: one whose first act comes later does not.
                    if start.is_none() {
                        drop_at = faults
                            .drop
                            .map(|(at, _)| d.start + Duration::from_secs(at))
                            .filter(|&t| t > Instant::now());
                    }
                    start = Some(d.start);
                    let now = Instant::now();
                    pending.insert(d.sequence, (now, unix_ms(), d.bytes.clone()));
                    verb_of.insert(d.sequence, d.verb);
                    out.late_us.push(now.duration_since(d.at).as_micros() as u64);
                    if tx.send(Message::Binary(d.bytes.into())).await.is_err() {
                        out.error(d.start, Instant::now(), "send-failed");
                        lost = Some(true);
                    }
                }
                None => drain_until = Some(Instant::now() + Duration::from_secs(DRAIN_S)),
            },
            m = rx.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    let now = Instant::now();
                    let s0 = start.unwrap_or(now);
                    match heard(&b) {
                        // Accepted: the act's first answer, timed; it stays pending until its receipt or refusal.
                        Heard::Accepted(s) if pending.contains_key(&s) => {
                            if accepted.insert(s) {
                                let (sent_at, sent_ms, _) = pending[&s];
                                let m = out.minute(s0, now);
                                m.latency_us.push(now.duration_since(sent_at).as_micros() as u64);
                                out.trace.push(format!("first {k} {s} {sent_ms} {} accepted", unix_ms()));
                            }
                            out.other += 1;
                        }
                        Heard::Receipt(s) => {
                            if !receipted.insert(s) {
                                out.duplicates += 1;
                                out.trace.push(format!("dup {k} {s} {}", unix_ms()));
                            } else {
                                out.trace.push(format!("ack {k} {s} {}", unix_ms()));
                            }
                            if let Some((sent_at, sent_ms, _)) = pending.remove(&s) {
                                // A sit's receipt seats the Soul: its next walk or sit goes as a rise first.
                                if verb_of.remove(&s).is_some_and(|v| v.as_str().ends_with(":sit")) {
                                    seated.store(true, Ordering::Relaxed);
                                }
                                out.receipts += 1;
                                let m = out.minute(s0, now);
                                m.receipts += 1;
                                if !accepted.remove(&s) {
                                    m.latency_us.push(now.duration_since(sent_at).as_micros() as u64);
                                    out.trace.push(format!("first {k} {s} {sent_ms} {} receipt", unix_ms()));
                                }
                            } else {
                                out.other += 1;
                            }
                        }
                        Heard::Refused(s, reason)
                            if faults.reconnect && reason == "world.restarting" && pending.contains_key(&s) =>
                        {
                            out.restarting += 1;
                            retry.push_back((now + RESTARTING_RETRY, s));
                        }
                        Heard::Refused(s, reason) if pending.contains_key(&s) => {
                            let verb = verb_of.remove(&s).map_or("?".into(), |v| v.as_str().to_owned());
                            *out.refused_by.entry(format!("{verb} {reason}")).or_default() += 1;
                            let (sent_at, sent_ms, _) = pending.remove(&s).expect("pending");
                            let first = !accepted.remove(&s);
                            if first {
                                out.trace.push(format!("first {k} {s} {sent_ms} {} {reason}", unix_ms()));
                            }
                            let m = out.minute(s0, now);
                            *m.refusals.entry(reason).or_default() += 1;
                            if first {
                                m.latency_us.push(now.duration_since(sent_at).as_micros() as u64);
                            }
                            out.other += 1;
                        }
                        Heard::Error(name) => out.error(s0, now, &name),
                        _ => out.other += 1,
                    }
                }
                Some(Ok(_)) => {}
                _ => lost = Some(true),
            },
            _ = async { tokio::time::sleep_until(next_retry.expect("a retry").into()).await }, if next_retry.is_some() => {
                let (_, s) = retry.pop_front().expect("a retry");
                if let Some((_, _, bytes)) = pending.get(&s) {
                    out.resent += 1;
                    if tx.send(Message::Binary(bytes.clone().into())).await.is_err() {
                        lost = Some(true);
                    }
                }
            },
            _ = async { tokio::time::sleep_until(drop_at.expect("a drop").into()).await }, if drop_at.is_some() => {
                drop_at = None;
                lost = Some(false);
            },
            _ = tokio::time::sleep(wait) => {}
        }
        let Some(closed_under) = lost else { continue };
        let s0 = start.unwrap_or_else(Instant::now);
        if closed_under {
            out.error(s0, Instant::now(), "socket-closed");
        } else {
            let _ = tx.send(Message::Close(None)).await;
        }
        out.trace.push(format!("gone {k} {}", unix_ms()));
        if !faults.reconnect && closed_under {
            out.closed = true;
            break;
        }
        if let (false, Some((_, away))) = (closed_under, faults.drop) {
            tokio::time::sleep(Duration::from_secs(away)).await;
        }
        let Some((t, r)) = come_back(&url, &token, k, closed_under).await else {
            out.closed = true;
            out.error(s0, Instant::now(), "not-back");
            break;
        };
        (tx, rx) = (t, r);
        out.trace.push(format!("back {k} {}", unix_ms()));
        // Everything unanswered goes again, in sequence order, under its old sequence.
        retry.clear();
        for (_, _, bytes) in pending.values() {
            out.resent += 1;
            if tx
                .send(Message::Binary(bytes.clone().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    }
    if let Some(s0) = start {
        for (s, (at, sent_ms, _)) in pending {
            // Accepted and still going at the drain's end: answered, not ended, so counted apart, not an error.
            if accepted.contains(&s) {
                out.unfinished += 1;
            } else {
                out.error(s0, at, "unanswered");
            }
            out.trace.push(format!("open {k} {s} {sent_ms}"));
        }
    }
    let _ = tx.send(Message::Close(None)).await;
    out
}

/// One viewer (X10): a view socket signed in with a view token for one Soul, following its body at the full level.
/// A slow one waits `slow_ms` after each frame it reads. It counts its items, the longest gap between them, and the
/// times the gateway let it go; with `reconnect` it signs in and subscribes again.
#[allow(clippy::disallowed_methods)]
async fn viewer(
    url: String,
    token: String,
    body: Id,
    slow_ms: Option<u64>,
    reconnect: bool,
    until: Instant,
) -> serde_like::Obj {
    let subscribe = encode(&Value::Map(
        [(
            30,
            Value::Map(
                [
                    (
                        1,
                        Value::Array(vec![Value::Map([(2, body.to_value())].into())]),
                    ),
                    (2, Value::Uint(1)),
                    (3, Value::Uint(8_000)),
                ]
                .into(),
            ),
        )]
        .into(),
    ))
    .expect("a subscribe frame");
    let (mut items, mut closed, mut gap_ms, mut signed) = (0u64, 0u64, 0u64, false);
    'socket: while Instant::now() < until {
        let Some((mut tx, mut rx)) = sign_in(&url, &token).await else {
            if !reconnect {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        };
        signed = true;
        if tx
            .send(Message::Binary(subscribe.clone().into()))
            .await
            .is_err()
        {
            continue;
        }
        let mut last = Instant::now();
        // A slow viewer's backlog is always ready, so the timeout alone would never end it.
        while Instant::now() < until {
            match tokio::time::timeout_at(until.into(), rx.next()).await {
                Err(_) => break 'socket,
                Ok(Some(Ok(Message::Binary(_)))) => {
                    let now = Instant::now();
                    gap_ms = gap_ms.max(now.duration_since(last).as_millis() as u64);
                    last = now;
                    items += 1;
                    if let Some(ms) = slow_ms {
                        tokio::time::sleep(Duration::from_millis(ms)).await;
                    }
                }
                Ok(Some(Ok(_))) => {}
                Ok(_) => {
                    closed += 1;
                    if !reconnect {
                        break 'socket;
                    }
                    continue 'socket;
                }
            }
        }
    }
    serde_like::Obj::new()
        .s("speed", if slow_ms.is_some() { "slow" } else { "fast" })
        .n("signedIn", f64::from(u8::from(signed)))
        .n("items", items as f64)
        .n("longestGapMs", gap_ms as f64)
        .n("letGo", closed as f64)
}

struct Args {
    schedule: PathBuf,
    dir: PathBuf,
    think_ms: u64,
    late_ms: u64,
    /// A served world's gateway, and the file of its pre-paired test Souls' tokens (X7).
    remote: Option<(String, PathBuf)>,
    /// Send the schedule's says on a served world (out loud, where people may read them); withheld by default.
    speech: bool,
    /// X10 (#4019): come back after a lost socket (`--reconnect`); a share of the agents drop their sockets at a
    /// second and come back after a while (`--drop <share>@<second>+<seconds away>`); viewers on view sockets, a share
    /// of them slow (`--viewers <n>@<slow share>`, `--view-key <file>`, `--slow-read-ms`); the trace (`--trace`).
    reconnect: bool,
    drop: Option<(f64, u64, u64)>,
    viewers: Option<(u32, f64, PathBuf)>,
    slow_read_ms: u64,
    trace: Option<PathBuf>,
}

/// `<share>@<second>+<seconds away>`, as `--drop` takes it.
fn drop_spec(v: &str) -> Option<(f64, u64, u64)> {
    let (share, rest) = v.split_once('@')?;
    let (at, away) = rest.split_once('+')?;
    Some((share.parse().ok()?, at.parse().ok()?, away.parse().ok()?))
}

/// Whether agent (or viewer) `k` of `n` is in a share of them: every one whose place in a spread of the share lands
/// on a new whole number, so 0.2 of 50 is 10, spread across the agents.
fn in_share(k: u32, share: f64) -> bool {
    ((f64::from(k) + 1.0) * share).floor() > (f64::from(k) * share).floor()
}

/// A view token as the directory mints one (V13b): `view.<expires>.<grant>.<HMAC hex>`.
fn view_token(key: &gatewayd::token::ViewKey, grant: Grant, expires: u64) -> String {
    let body = format!("view.{expires}.{}", grant.to_text());
    let mac = key.mac(body.as_bytes());
    format!("{body}.{}", to_hex(&mac))
}

fn args() -> Option<Args> {
    let a: Vec<String> = std::env::args().collect();
    let get = |name: &str| a.iter().position(|x| x == name).and_then(|k| a.get(k + 1));
    let num = |name: &str, d: u64| get(name).map_or(Some(d), |v| v.parse().ok());
    Some(Args {
        schedule: PathBuf::from(get("--schedule")?),
        dir: PathBuf::from(get("--dir")?),
        think_ms: num("--think-ms", 0)?,
        late_ms: num("--late-ms", 50)?,
        remote: match (get("--remote"), get("--tokens")) {
            (Some(r), Some(t)) => Some((r.clone(), PathBuf::from(t))),
            (None, None) => None,
            _ => return None,
        },
        speech: a.iter().any(|x| x == "--speech"),
        reconnect: a.iter().any(|x| x == "--reconnect"),
        drop: match get("--drop") {
            Some(v) => Some(drop_spec(v)?),
            None => None,
        },
        viewers: match (get("--viewers"), get("--view-key")) {
            (Some(v), Some(key)) => {
                let (n, slow) = v.split_once('@')?;
                Some((n.parse().ok()?, slow.parse().ok()?, PathBuf::from(key)))
            }
            (None, None) => None,
            _ => return None,
        },
        slow_read_ms: num("--slow-read-ms", 2000)?,
        trace: get("--trace").map(PathBuf::from),
    })
}

/// The gateway's socket address from `--remote`: `ws://host:port[/path]` or `host:port`, the agents' path added when
/// none is given. `wss://` is refused: the driver carries no TLS, so it runs where it reaches the gateway's own port.
fn socket_url(remote: &str) -> Result<String, String> {
    if remote.starts_with("wss://") || remote.starts_with("https://") {
        return Err(
            "--remote: wss:// is not carried; run the driver where it reaches gatewayd's own ws:// port".into(),
        );
    }
    let rest = remote.strip_prefix("ws://").unwrap_or(remote);
    if rest.is_empty() || rest.contains("://") {
        return Err("--remote: give ws://<host>:<port> or <host>:<port>".into());
    }
    Ok(match rest.find('/') {
        Some(_) => format!("ws://{rest}"),
        None => format!("ws://{rest}{}", gatewayd::socket::PATH),
    })
}

/// The pre-paired Souls' tokens, one a line, the first `agents` of them, with the Soul each signs in as. A line is a
/// token (`worldd seed`'s `souls.tokens`) or `<soul grant> <token>` (`v2/tools/ops/test-soul pair`'s file, #4016),
/// whose grant must be the token's own. A line that is neither is refused by its number; a token's text is never
/// printed.
fn read_tokens(text: &str, agents: u32) -> Result<Vec<(String, Actor)>, String> {
    let mut out = Vec::new();
    for (n, line) in text
        .lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
    {
        if out.len() == agents as usize {
            break;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        let (named, token) = match f[..] {
            [t] => (None, t),
            [g, t] => (Some(g), t),
            _ => (None, ""),
        };
        match Token::parse(token).map(|t| t.grant()) {
            Some(g @ Grant::Actor(a @ Actor::Soul(_)))
                if named.is_none_or(|x| Grant::parse(x) == Some(g)) =>
            {
                out.push((token.to_owned(), a))
            }
            _ => return Err(format!("--tokens: line {} is not a Soul's token", n + 1)),
        }
    }
    if out.len() < agents as usize {
        return Err(format!(
            "--tokens: the schedule has {agents} agents and the file {} Souls",
            out.len()
        ));
    }
    Ok(out)
}

fn spawn(bin: &Path, name: &str, args: &[&str], dir: &Path) -> Child {
    let log = std::fs::File::create(dir.join(format!("{name}.log"))).expect("a log file");
    Command::new(bin.join(name))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(log)
        .spawn()
        .unwrap_or_else(|e| panic!("{name} starts (build it first): {e}"))
}

// One thread: the driver's cores are this process's alone.
// A tool, not the engine: due times and the run's length are wall-clock time (K7, v2/clippy.toml).
#[allow(clippy::disallowed_methods)]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let Some(a) = args() else {
        eprintln!(
            "usage: driver --schedule <file from loads.mjs> --dir <empty folder> [--remote ws://<host>:<port> \
             --tokens <file> [--speech]] [--think-ms 0] [--late-ms 50] [--reconnect] [--drop <share>@<s>+<s away>] \
             [--viewers <n>@<slow share> --view-key <file> [--slow-read-ms 2000]] [--trace <file>]"
        );
        std::process::exit(2);
    };
    let s = match std::fs::read_to_string(&a.schedule)
        .map_err(|e| e.to_string())
        .and_then(|t| parse(&t))
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("driver: the schedule: {e}");
            std::process::exit(2);
        }
    };
    println!("{}", s.describe);
    let verbs: Vec<Name> = s
        .verbs
        .iter()
        .map(|v| Name::new(v).expect("a verb is a name"))
        .collect();
    let bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .expect("this binary's folder");
    std::fs::create_dir_all(&a.dir).expect("the run folder");

    // A served world's kind entries, read with the first test Soul's token before anyone signs in.
    let mut entries = None;
    let (url, signed, children) = match &a.remote {
        Some((remote, file)) => {
            let read = socket_url(remote).and_then(|url| {
                let text = std::fs::read_to_string(file).map_err(|e| format!("--tokens: {e}"))?;
                Ok((url, read_tokens(&text, s.agents)?))
            });
            let read = match read {
                Ok((url, signed)) => {
                    let token = signed.first().map_or("", |(t, _)| t.as_str());
                    targets::read_entries(&url, token)
                        .await
                        .map(|e| (url, signed, e))
                }
                Err(e) => Err(e),
            };
            match read {
                Ok((url, signed, e)) => {
                    entries = Some(e);
                    (url, signed, Vec::new())
                }
                Err(e) => {
                    eprintln!("driver: {e}");
                    std::process::exit(2);
                }
            }
        }
        None => {
            // Tokens: the gateway's file holds hashes only.
            let mut signed = Vec::new();
            let mut file = String::new();
            for i in 0..s.agents {
                let t = Token::issue(Grant::Actor(soul(i))).expect("random bytes");
                file.push_str(&Tokens::line(t.grant(), &t.hash()));
                signed.push((t.reveal().to_owned(), soul(i)));
            }
            std::fs::write(a.dir.join("tokens"), file).expect("the tokens file");
            let sock = a.dir.join("w.sock");
            let sock = sock.to_str().expect("a path");
            let w = spawn(
                &bin,
                "worldd",
                &[
                    "gateway-link",
                    "--socket",
                    sock,
                    "--lineage",
                    &to_hex(&LINEAGE),
                    "--epoch",
                    "1",
                ],
                &a.dir,
            );
            let tokens_path = a.dir.join("tokens");
            let mut g = spawn(
                &bin,
                "gatewayd",
                &[
                    "--listen",
                    "127.0.0.1:0",
                    "--world",
                    sock,
                    "--tokens",
                    tokens_path.to_str().expect("a path"),
                    "--build",
                    "1220",
                ],
                &a.dir,
            );
            let mut line = String::new();
            BufReader::new(g.stdout.take().expect("stdout"))
                .read_line(&mut line)
                .expect("gatewayd says where it listens");
            let addr = line.trim().strip_prefix("listening ").expect("an address");
            let url = format!("ws://{addr}{}", gatewayd::socket::PATH);
            tokio::time::sleep(Duration::from_millis(300)).await;
            (url, signed, vec![g, w])
        }
    };

    // Every agent signs in before the clock starts.
    let ready = Arc::new(AtomicU64::new(0));
    let gate = Arc::new(Semaphore::new(64));
    let mut chans = Vec::new();
    let mut tasks = Vec::new();
    let actors: Vec<Actor> = signed.iter().map(|(_, a)| *a).collect();
    // Each agent's own choice state (a cloned one would share its seated flag).
    let mut choices: Vec<targets::Choice> =
        (0..s.agents).map(|_| targets::Choice::default()).collect();
    // On a served world each Soul's sequences start past any an earlier run sent: at the run's start in Unix ms, the
    // first (that number itself) its body's birth (the warm-up rise), the schedule's after it.
    let first = if a.remote.is_some() {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    } else {
        0
    };
    let based = basis(a.remote.is_some());
    let rise = s
        .verbs
        .first()
        .and_then(|v| v.split_once(':'))
        .map_or("eden", |(ns, _)| ns);
    let rise = Name::new(&format!("{rise}:rise")).expect("a verb");
    // `--drop`: the share is of the agents there at the drop (an act due before it), spread across them.
    let mut there: Vec<u32> = s
        .acts
        .iter()
        .filter(|x| a.drop.is_some_and(|(_, at, _)| x.at_ms < at * 1000))
        .map(|x| x.agent)
        .collect();
    there.sort_unstable();
    there.dedup();
    let dropping: Vec<u32> = there
        .iter()
        .enumerate()
        .filter(|(i, _)| {
            a.drop
                .is_some_and(|(share, _, _)| in_share(*i as u32, share))
        })
        .map(|(_, k)| *k)
        .collect();
    for (k, ((token, _), c)) in signed.into_iter().zip(&choices).enumerate() {
        let (tx, rx) = mpsc::unbounded_channel();
        chans.push(tx);
        let faults = Faults {
            reconnect: a.reconnect,
            drop: a
                .drop
                .filter(|_| dropping.contains(&(k as u32)))
                .map(|(_, at, away)| (at, away)),
        };
        tasks.push(tokio::spawn(agent(
            k as u32,
            url.clone(),
            token,
            gate.clone(),
            ready.clone(),
            c.seated.clone(),
            entries
                .is_some()
                .then(|| (intent(actors[k], &rise, None, first, &based), first)),
            faults,
            rx,
        )));
    }
    while ready.load(Ordering::Relaxed) < u64::from(s.agents) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // On a served world, the ids: the first agent's copy, read now that every agent's body is in the world.
    let mut aimed: Option<targets::Targets> = None;
    if let Some(e) = &entries {
        let (back, seen) = tokio::sync::oneshot::channel();
        let seen = match chans.first().map(|c| c.send(Job::Read(back))) {
            Some(Ok(())) => seen
                .await
                .unwrap_or(Err("targets: the first agent's socket closed".into())),
            _ => Err("targets: no first agent".into()),
        };
        match seen {
            Ok(seen) => {
                let t = targets::Targets::of(&seen, e);
                println!(
                    "targets: {} nodes in the copy; {}",
                    seen.nodes.len(),
                    t.json()
                );
                aimed = Some(t);
            }
            Err(e) => {
                eprintln!("driver: {e}");
                std::process::exit(2);
            }
        }
    }

    // The run: each act at its due time (plus its agent's thinking delay), whatever came back before it.
    let (cpu0, start) = (cpu_us(), Instant::now());
    // X10: the viewers, each following one Soul's body (viewer i the i-th Soul's, round the agents), until the run's
    // answers are in.
    let mut watching = Vec::new();
    if let (Some((n, slow, key)), Some(t)) = (&a.viewers, &aimed) {
        let key = std::fs::read_to_string(key)
            .ok()
            .and_then(|k| gatewayd::token::ViewKey::read(&k))
            .unwrap_or_else(|| {
                eprintln!("driver: --view-key is a file of 64 hex digits");
                std::process::exit(2);
            });
        let last = s.acts.last().map_or(0, |x| x.at_ms) + a.think_ms;
        let until = start + Duration::from_millis(last) + Duration::from_secs(DRAIN_S);
        let expires = unix_ms() / 1000 + 24 * 3600;
        for i in 0..*n {
            let soul = actors[(i % s.agents) as usize];
            let Actor::Soul(id) = soul else { continue };
            let Some(body) = t.bodies.get(&id) else {
                continue;
            };
            watching.push(tokio::spawn(viewer(
                url.clone(),
                view_token(&key, Grant::Actor(soul), expires),
                *body,
                in_share(i, *slow).then_some(a.slow_read_ms),
                a.reconnect,
                until,
            )));
        }
    }
    let think = |agent: u32| a.think_ms * ((u64::from(agent) * 7919) % 1000) / 1000;
    let mut sequence = vec![first; s.agents as usize];
    let mut intended = vec![0u64; s.agents as usize];
    let mut unmapped: BTreeMap<&str, u64> = BTreeMap::new();
    let mut by_verb: BTreeMap<String, u64> = BTreeMap::new();
    let (mut withheld, mut stand_ins) = (BTreeMap::new(), BTreeMap::new());
    for act in &s.acts {
        let Some(v) = act.verb else {
            *unmapped.entry(&s.kinds[act.kind]).or_default() += 1;
            continue;
        };
        let k = act.agent as usize;
        // On a served world: the act's target from the world's ids, a rise first when seated, a say withheld.
        let (verb, target) = match &aimed {
            None => (verbs[v].clone(), None),
            Some(t) => {
                let body = match actors[k] {
                    Actor::Soul(b) => b,
                    _ => continue,
                };
                let kind = s.kinds[act.kind].as_str();
                let Some(c) = choices[k].next(t, kind, &s.verbs[v], act.agent, body, a.speech)
                else {
                    *withheld.entry(kind).or_insert(0u64) += 1;
                    continue;
                };
                if let Some(x) = c.stand_in {
                    *stand_ins.entry(x).or_insert(0u64) += 1;
                }
                (Name::new(&c.verb).expect("a verb is a name"), c.target)
            }
        };
        let due = start + Duration::from_millis(act.at_ms + think(act.agent));
        tokio::time::sleep_until(due.into()).await;
        sequence[k] += 1;
        intended[k] += 1;
        *by_verb.entry(verb.as_str().to_owned()).or_default() += 1;
        let _ = chans[k].send(Job::Act(Due {
            at: due,
            bytes: intent(actors[k], &verb, target, sequence[k], &based),
            sequence: sequence[k],
            start,
            verb,
        }));
    }
    drop(chans);
    let mut sent = Vec::new();
    for (k, t) in tasks.into_iter().enumerate() {
        let mut x = t.await.unwrap_or_default();
        x.intended = intended[k];
        sent.push(x);
    }
    let (wall, cpu) = (start.elapsed(), cpu_us() - cpu0);
    for mut c in children {
        let _ = c.kill();
        let _ = c.wait();
    }

    let all: Vec<&Sent> = sent.iter().collect();
    let total = group(&all, a.late_ms);
    let intended_all = s.acts.len() as u64 - withheld.values().sum::<u64>();
    let achieved = ratio(total.get("sent").unwrap_or(0.0) as u64, intended_all);
    let cores = (1000.0 * cpu as f64 / wall.as_micros().max(1) as f64).round() / 1000.0;
    let receipts: u64 = sent.iter().map(|x| x.receipts).sum();
    let other: u64 = sent.iter().map(|x| x.other).sum();
    let closed = sent.iter().filter(|x| x.closed).count();
    let duplicates: u64 = sent.iter().map(|x| x.duplicates).sum();
    let resent: u64 = sent.iter().map(|x| x.resent).sum();
    let restarting: u64 = sent.iter().map(|x| x.restarting).sum();
    let unfinished: u64 = sent.iter().map(|x| x.unfinished).sum();
    let mut viewers = Vec::new();
    for v in watching {
        if let Ok(v) = v.await {
            viewers.push(v);
        }
    }
    if let Some(path) = &a.trace {
        // Each agent's Soul (`soul <agent> <scope hex>:<counter>`), then what each agent heard.
        let mut lines: Vec<String> = actors
            .iter()
            .enumerate()
            .filter_map(|(k, x)| match x {
                Actor::Soul(id) => Some(format!(
                    "soul {k} {}:{}",
                    to_hex(&id.scope().0),
                    id.counter()
                )),
                _ => None,
            })
            .collect();
        lines.extend(sent.iter().flat_map(|x| x.trace.iter().cloned()));
        std::fs::write(path, lines.join("\n") + "\n").expect("the trace");
    }
    let tenths = by_tenth(&sent, a.late_ms);
    let mut refused_by = BTreeMap::new();
    for x in &sent {
        add(&mut refused_by, &x.refused_by);
    }
    let minutes = per_minute(&sent, wall);
    let report = serde_like::Obj::new()
        .s("describe", &s.describe)
        .n("agents", f64::from(s.agents))
        .n("intendedActs", intended_all as f64)
        .n("achievedShare", achieved)
        .n("lateMs", a.late_ms as f64)
        .n("thinkMs", a.think_ms as f64)
        .n("wallS", (wall.as_millis() as f64 / 100.0).round() / 10.0)
        .n("driverCores", cores)
        .n("receipts", receipts as f64)
        .n("otherAnswers", other as f64)
        .n("socketsClosed", closed as f64)
        .raw("byVerb", counts(&by_verb))
        .raw("unmapped", counts(&unmapped))
        .raw("all", total.json())
        .raw("byTenth", serde_like::list(&tenths))
        .s("world", if a.remote.is_some() { "remote" } else { "own" })
        .raw(
            "targets",
            aimed.as_ref().map_or("null".into(), targets::Targets::json),
        )
        .raw("withheld", counts(&withheld))
        .raw("standIns", counts(&stand_ins))
        .raw("refusedBy", counts(&refused_by))
        .raw("perMinute", serde_like::list(&minutes))
        .n("duplicateReceipts", duplicates as f64)
        .n("resent", resent as f64)
        .n("restartingAnswers", restarting as f64)
        .n("unfinished", unfinished as f64)
        .raw("viewers", serde_like::list(&viewers));
    let on_time = total.get("onTimeShare").unwrap_or(0.0);
    println!(
        "Acts: {} achieved of {} intended ({:.1} %){}; {:.1} % sent within {} ms of due (p50 {} ms, p99 {} ms, max {} ms); \
         driver {} cores over {:.0} s; receipts {}, other answers {}, sockets closed {}; unmapped {}; withheld {}; \
         stand-ins {}",
        total.get("sent").unwrap_or(0.0),
        intended_all,
        100.0 * achieved,
        if achieved < 0.95 {
            ": **under-driven** (under 95 %)"
        } else {
            ""
        },
        100.0 * on_time,
        a.late_ms,
        total.get("lateP50Ms").unwrap_or(0.0),
        total.get("lateP99Ms").unwrap_or(0.0),
        total.get("lateMaxMs").unwrap_or(0.0),
        cores,
        wall.as_secs_f64(),
        receipts,
        other,
        closed,
        counts(&unmapped),
        counts(&withheld),
        counts(&stand_ins),
    );
    for t in &tenths {
        println!("  tenth {}", t.json());
    }
    for m in &minutes {
        println!("  minute {}", m.json());
    }
    println!("  refused by verb {}", counts(&refused_by));
    println!("  accepted, not ended by the drain's end: {unfinished}");
    if a.reconnect || a.drop.is_some() || !viewers.is_empty() {
        println!(
            "  faults: duplicate receipts {duplicates}, sent again {resent}, world.restarting answers {restarting}"
        );
        for v in &viewers {
            println!("  viewer {}", v.json());
        }
    }
    std::fs::write(a.dir.join("report.json"), report.json() + "\n").expect("report.json");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a5_an_unmapped_kind_is_kept_with_no_verb() {
        let s =
            parse("# x: 3 acts intended\n0 0 walk eden:walk\n5 1 juggle -\n5 0 walk eden:walk\n")
                .unwrap();
        assert_eq!(s.describe, "x: 3 acts intended");
        assert_eq!(s.agents, 2);
        assert_eq!(s.kinds, ["walk", "juggle"]);
        assert_eq!(s.verbs, ["eden:walk"]);
        assert_eq!(
            s.acts[1],
            Act {
                at_ms: 5,
                agent: 1,
                kind: 1,
                verb: None
            }
        );
        assert_eq!(s.acts[2].verb, Some(0));
    }

    #[test]
    fn a_schedule_out_of_time_order_or_malformed_is_refused() {
        assert!(parse("5 0 walk eden:walk\n0 0 walk eden:walk\n").is_err());
        assert!(parse("5 0 walk\n").is_err());
    }

    #[test]
    fn a2_the_on_time_share_counts_unsent_acts_as_late() {
        let a = Sent {
            intended: 4,
            late_us: vec![1_000, 50_000, 50_001],
            ..Sent::default()
        };
        let g = group(&[&a], 50);
        assert_eq!(g.get("onTimeShare"), Some(0.5));
        assert_eq!(g.get("sent"), Some(3.0));
        assert_eq!(g.get("lateMaxMs"), Some(50.001));
    }

    #[test]
    fn x7_a1_tokens_are_read_bare_or_after_their_grant() {
        let t = |c| {
            Token::issue(Grant::Actor(soul(c)))
                .unwrap()
                .reveal()
                .to_owned()
        };
        let (a, b) = (t(1), t(2));
        let grant = |x: &str| x.rsplit_once('.').unwrap().0.to_owned();
        let read = read_tokens(&format!("{a}\n\n{} {b}\n", grant(&b)), 2).unwrap();
        assert_eq!(read, [(a.clone(), soul(1)), (b.clone(), soul(2))]);
        assert!(read_tokens(&format!("{} {b}\n", grant(&a)), 1).is_err());
        assert!(read_tokens(&format!("{a}\n"), 2).is_err());
        let e = read_tokens("soul-x.y\n", 1).unwrap_err();
        assert_eq!(e, "--tokens: line 1 is not a Soul's token");
    }

    #[test]
    fn by_tenth_puts_the_busiest_agents_first() {
        let sent: Vec<Sent> = (0..20u64)
            .map(|i| Sent {
                intended: i,
                ..Sent::default()
            })
            .collect();
        let t = by_tenth(&sent, 50);
        assert_eq!(t.len(), 10);
        assert_eq!(t[0].get("intended"), Some(19.0 + 18.0));
        assert_eq!(t[9].get("intended"), Some(1.0));
    }
}
