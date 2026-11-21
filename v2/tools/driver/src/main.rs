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

// The repeat rule's map ban (K12, v2/clippy.toml) is `sim`'s; the driver's maps are lookups.
#![allow(clippy::disallowed_types)]

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
use replica::intents::{Hello, Intent, PROTOCOL};
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

fn intent(actor: Actor, verb: &Name, sequence: u64) -> Vec<u8> {
    let zone = Id::new(Scope(LINEAGE), 0).expect("a zone");
    let i = Intent {
        actor,
        verb: verb.clone(),
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

/// Whether a stream frame is a receipt.
fn is_receipt(bytes: &[u8]) -> bool {
    let Ok(d) = decode(bytes) else { return false };
    let Value::Map(m) = d.value else { return false };
    matches!(m.get(&2), Some(Value::Map(a)) if a.get(&3) == Some(&Value::Uint(1)))
}

/// One agent: first frame and sign-in, then each intent the schedule hands it, sent at once; then its answers.
// A tool, not the engine: it measures each send's lateness against its due time by the wall clock (K7, v2/clippy.toml).
#[allow(clippy::disallowed_methods)]
async fn agent(
    url: String,
    token: String,
    gate: Arc<Semaphore>,
    ready: Arc<AtomicU64>,
    mut acts: mpsc::UnboundedReceiver<(Instant, Vec<u8>)>,
) -> Sent {
    let mut out = Sent::default();
    let permit = gate.acquire().await;
    let Ok((ws, _)) = tokio_tungstenite::connect_async(&url).await else {
        out.closed = true;
        ready.fetch_add(1, Ordering::Relaxed);
        return out;
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
    for _ in 0..2 {
        ok = ok && matches!(rx.next().await, Some(Ok(Message::Binary(_))));
    }
    drop(permit);
    out.closed = !ok;
    ready.fetch_add(1, Ordering::Relaxed);
    if !ok {
        return out;
    }
    let mut drain_until: Option<Instant> = None;
    loop {
        let answered = out.receipts + out.other;
        if drain_until.is_some_and(|u| Instant::now() >= u || answered >= out.late_us.len() as u64)
        {
            break;
        }
        let wait = drain_until.map_or(Duration::from_secs(3600), |u| u - Instant::now());
        tokio::select! {
            a = acts.recv(), if drain_until.is_none() => match a {
                Some((due, bytes)) => {
                    if tx.send(Message::Binary(bytes.into())).await.is_err() {
                        out.closed = true;
                        break;
                    }
                    out.late_us.push(due.elapsed().as_micros() as u64);
                }
                None => drain_until = Some(Instant::now() + Duration::from_secs(5)),
            },
            m = rx.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    if is_receipt(&b) { out.receipts += 1 } else { out.other += 1 }
                }
                Some(Ok(_)) => {}
                _ => { out.closed = true; break; }
            },
            _ = tokio::time::sleep(wait) => {}
        }
    }
    let _ = tx.send(Message::Close(None)).await;
    out
}

struct Args {
    schedule: PathBuf,
    dir: PathBuf,
    think_ms: u64,
    late_ms: u64,
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
    })
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
            "usage: driver --schedule <file from loads.mjs> --dir <empty folder> [--think-ms 0] [--late-ms 50]"
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

    // Tokens: the gateway's file holds hashes only.
    let mut tokens = Vec::new();
    let mut file = String::new();
    for i in 0..s.agents {
        let t = Token::issue(Grant::Actor(soul(i))).expect("random bytes");
        file.push_str(&Tokens::line(t.grant(), &t.hash()));
        tokens.push(t.reveal().to_owned());
    }
    std::fs::write(a.dir.join("tokens"), file).expect("the tokens file");
    let sock = a.dir.join("w.sock");
    let sock = sock.to_str().expect("a path");
    let mut w = spawn(
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

    // Every agent signs in before the clock starts.
    let ready = Arc::new(AtomicU64::new(0));
    let gate = Arc::new(Semaphore::new(64));
    let mut chans = Vec::new();
    let mut tasks = Vec::new();
    for token in tokens {
        let (tx, rx) = mpsc::unbounded_channel();
        chans.push(tx);
        tasks.push(tokio::spawn(agent(
            url.clone(),
            token,
            gate.clone(),
            ready.clone(),
            rx,
        )));
    }
    while ready.load(Ordering::Relaxed) < u64::from(s.agents) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // The run: each act at its due time (plus its agent's thinking delay), whatever came back before it.
    let (cpu0, start) = (cpu_us(), Instant::now());
    let think = |agent: u32| a.think_ms * ((u64::from(agent) * 7919) % 1000) / 1000;
    let mut sequence = vec![0u64; s.agents as usize];
    let mut intended = vec![0u64; s.agents as usize];
    let mut unmapped: BTreeMap<&str, u64> = BTreeMap::new();
    let mut by_verb: BTreeMap<&str, u64> = BTreeMap::new();
    for act in &s.acts {
        let Some(v) = act.verb else {
            *unmapped.entry(&s.kinds[act.kind]).or_default() += 1;
            continue;
        };
        let due = start + Duration::from_millis(act.at_ms + think(act.agent));
        tokio::time::sleep_until(due.into()).await;
        let k = act.agent as usize;
        sequence[k] += 1;
        intended[k] += 1;
        *by_verb.entry(&s.verbs[v]).or_default() += 1;
        let _ = chans[k].send((due, intent(soul(act.agent), &verbs[v], sequence[k])));
    }
    drop(chans);
    let mut sent = Vec::new();
    for (k, t) in tasks.into_iter().enumerate() {
        let mut x = t.await.unwrap_or_default();
        x.intended = intended[k];
        sent.push(x);
    }
    let (wall, cpu) = (start.elapsed(), cpu_us() - cpu0);
    let _ = g.kill();
    let _ = w.kill();
    let _ = g.wait();
    let _ = w.wait();

    let all: Vec<&Sent> = sent.iter().collect();
    let total = group(&all, a.late_ms);
    let intended_all = s.acts.len() as u64;
    let achieved = ratio(total.get("sent").unwrap_or(0.0) as u64, intended_all);
    let cores = (1000.0 * cpu as f64 / wall.as_micros().max(1) as f64).round() / 1000.0;
    let counts = |m: &BTreeMap<&str, u64>| {
        let f: Vec<String> = m.iter().map(|(k, v)| format!("{k:?}: {v}")).collect();
        format!("{{{}}}", f.join(", "))
    };
    let receipts: u64 = sent.iter().map(|x| x.receipts).sum();
    let other: u64 = sent.iter().map(|x| x.other).sum();
    let closed = sent.iter().filter(|x| x.closed).count();
    let tenths = by_tenth(&sent, a.late_ms);
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
        .raw("byTenth", serde_like::list(&tenths));
    let on_time = total.get("onTimeShare").unwrap_or(0.0);
    println!(
        "Acts: {} achieved of {} intended ({:.1} %){}; {:.1} % sent within {} ms of due (p50 {} ms, p99 {} ms, max {} ms); \
         driver {} cores over {:.0} s; receipts {}, other answers {}, sockets closed {}; unmapped {}",
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
    );
    for t in &tenths {
        println!("  tenth {}", t.json());
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
