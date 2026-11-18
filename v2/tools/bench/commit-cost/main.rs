//! The `commit-cost` bench (Engine v2 I3, #2686): what the clock thread spends on each committed act once checkers
//! (`worldd::checkers`) check acts on the frozen copy (K8) off the clock. The world: 100 rooms, each with 10 bodies,
//! a lamp beside each and 80 cups (1,000 bodies, 10,000 things). An act switches a body's lamp: switch_on, then
//! switch_off, as ranked candidates. The clock thread ticks every 50 ms, commits what the checkers handed over
//! (`sim::commit`: confirm the read set's stamps, apply), and publishes the tick's parts.
//!
//! Arms, two repeats each: even, 100 acts a second for 15 s; burst, 1,000 acts sent at once after a tick. Reported:
//! the clock's time per committed act (confirm and apply), mean and 99th percentile; for the burst, the acts its
//! biggest tick committed, that tick's work and how late the next tick started. Run from `v2/`:
//! `cargo run -p bench --release --bin commit-cost`. Declared on #2686.

use sim::commit::{Outcome, checks_on_clock, commit, mark_clock_thread};
use sim::frozen::Publisher;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::thread;
use std::time::{Duration, Instant};
use worldd::checkers::lamps::{World, rules, toggle};
use worldd::checkers::start;

const TICK: Duration = Duration::from_millis(50);
const CHECKERS: usize = 4;
const EVEN_RATE: u64 = 100;
const EVEN_SECONDS: u64 = 15;
const BURST: usize = 1_000;
const REPEATS: usize = 2;

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Mean and 99th percentile, in ms.
fn stats(mut v: Vec<Duration>) -> (f64, f64) {
    v.sort();
    let mean = v.iter().map(|d| ms(*d)).sum::<f64>() / v.len().max(1) as f64;
    (mean, ms(v[(v.len() * 99 / 100).min(v.len() - 1)]))
}

#[derive(Default)]
struct Tick {
    commits: usize,
    work: Duration,
    late: Duration,
}

struct Run {
    commits: Vec<Duration>,
    ticks: Vec<Tick>,
    rechecks: u64,
    refused: u64,
}

/// Ticks until `expected` acts are resolved; `feed` sends acts from its own thread, `after_tick` on the clock
/// thread after the given tick's work.
fn run(
    w: &mut World,
    expected: usize,
    feed: impl FnOnce(std::sync::mpsc::Sender<worldd::checkers::Act>) + Send + 'static,
    mut after_tick: impl FnMut(usize, &std::sync::mpsc::Sender<worldd::checkers::Act>),
) -> Run {
    let publisher = Arc::new(Publisher::new(&w.replica));
    let (acts, checked) = start(CHECKERS, Arc::clone(&publisher), Arc::new(rules()));
    let feeder_acts = acts.clone();
    let feeder = thread::spawn(move || feed(feeder_acts));
    let mut r = Run {
        commits: Vec::new(),
        ticks: Vec::new(),
        rechecks: 0,
        refused: 0,
    };
    let mut resolved = 0;
    let mut deadline = Instant::now() + TICK;
    let mut k = 0;
    while resolved < expected {
        let now = Instant::now();
        if now < deadline {
            thread::sleep(deadline - now);
        }
        let started = Instant::now();
        let mut t = Tick {
            late: started.saturating_duration_since(deadline),
            ..Tick::default()
        };
        let mut parts = Vec::new();
        for (mut act, checks) in checked.try_iter() {
            let c = Instant::now();
            let out = commit(&mut w.replica, &checks, 0);
            let spent = c.elapsed();
            match out {
                Outcome::Applied { part, .. } => {
                    r.commits.push(spent);
                    t.commits += 1;
                    parts.push(part);
                    resolved += 1;
                }
                Outcome::Recheck { version } => {
                    r.rechecks += 1;
                    act.recheck = Some(version);
                    acts.send(act).expect("a checker takes it");
                }
                Outcome::Refused { .. } => {
                    r.refused += 1;
                    resolved += 1;
                }
            }
        }
        publisher.publish(parts);
        t.work = started.elapsed();
        r.ticks.push(t);
        after_tick(k, &acts);
        k += 1;
        deadline += TICK;
    }
    feeder.join().expect("the feeder");
    r
}

fn main() {
    mark_clock_thread();
    let cores = thread::available_parallelism().map_or(0, |n| n.get());
    let t0 = Instant::now();
    let mut w = World::build(100, 10, 80);
    let (nodes, links) = w.replica.tree().counts();
    println!(
        "world: {nodes} nodes, {links} links, {} bodies, built in {:.0} ms; {cores} cores, {CHECKERS} checker threads, \
         {} ms ticks",
        w.pairs.len(),
        ms(t0.elapsed()),
        TICK.as_millis()
    );
    println!();
    println!(
        "| arm | repeat | committed | commit mean | commit p99 | rechecks | refused | biggest tick | its work | next tick late |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|");
    let pairs = Arc::new(w.pairs.clone());
    let mut next_id = 0u64;
    for repeat in 1..=REPEATS {
        // Even: one act every 10 ms, each a different body's lamp in turn.
        let n = (EVEN_RATE * EVEN_SECONDS) as usize;
        let (p, first) = (Arc::clone(&pairs), next_id);
        next_id += n as u64;
        let even = run(
            &mut w,
            n,
            move |acts| {
                let gap = Duration::from_millis(1000 / EVEN_RATE);
                let start = Instant::now();
                for i in 0..n {
                    let at = start + gap * i as u32;
                    let now = Instant::now();
                    if now < at {
                        thread::sleep(at - now);
                    }
                    let (b, l) = p[(first as usize + i) % p.len()];
                    acts.send(toggle(first + i as u64, b, l)).expect("sent");
                }
            },
            |_, _| {},
        );
        report("even", repeat, even);

        // Burst: every body's lamp at once, sent on the clock thread right after its third tick.
        let (p, first) = (Arc::clone(&pairs), next_id);
        next_id += BURST as u64;
        let sent = Arc::new(AtomicBool::new(false));
        let s = Arc::clone(&sent);
        let burst = run(
            &mut w,
            BURST,
            |_| {},
            move |k, acts| {
                if k == 2 && !s.swap(true, Relaxed) {
                    for (i, (b, l)) in p.iter().take(BURST).enumerate() {
                        acts.send(toggle(first + i as u64, *b, *l)).expect("sent");
                    }
                }
            },
        );
        report("burst", repeat, burst);
    }
    println!();
    println!("rule checks on the clock thread: {}", checks_on_clock());
    let last = w.replica.version();
    println!("live version at the end: {last}");
}

fn report(arm: &str, repeat: usize, r: Run) {
    let committed = r.commits.len();
    let (mean, p99) = stats(r.commits);
    let (_, big) = r
        .ticks
        .iter()
        .enumerate()
        .max_by_key(|(_, t)| t.commits)
        .expect("a tick");
    // The next tick starts late by however far this one's start and work run past its 50 ms.
    let next_late = (big.late + big.work).saturating_sub(TICK);
    println!(
        "| {arm} | {repeat} | {committed} | {mean:.4} ms | {p99:.4} ms | {} | {} | {} acts | {:.2} ms | {:.2} ms |",
        r.rechecks,
        r.refused,
        big.commits,
        ms(big.work),
        ms(next_late)
    );
}
