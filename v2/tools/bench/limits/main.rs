//! The `limits` bench (Engine v2 I8, #2692): limits charged in checking time (`worldd::checkers::budget`).
//!
//! - `step0`: what a check costs on I3's checkers, on one thread (the premise; declared on #2692).
//! - `runs` (the default): I3's world with one more room (101 rooms of 10 bodies, a toggle beside each, 80 items),
//!   4 checker threads behind budgets, a clock thread that ticks every 50 ms and commits. Arms, two repeats each:
//!   *base*, 1,000 Souls each switching its own toggle once a second, spread evenly (1,000 acts in each second),
//!   for 3 s; *flood*, the same plus one more Soul sending 50 acts a second of 400 candidates each (switch_off on its
//!   own room's ten unlit toggles, forty times over: every candidate is decided, none applies). An act is answered
//!   when the clock thread commits or refuses it, or when the budget answers `soul.slow-down`.
//!
//! Run from `v2/`: `cargo run -p bench --release --bin limits [-- step0]`.

// A bench times runs with the wall clock; the wall-clock rule (K7, v2/clippy.toml) is for the engine, not a bench.
#![allow(clippy::disallowed_methods)]

use replica::effects::Actor;
use sim::commit::{Outcome, commit, mark_clock_thread};
use sim::frozen::Publisher;
use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use worldd::checkers::budget::{Answered, Turns, real_clock, start};
use worldd::checkers::toggles::{World, rules, toggle};
use worldd::checkers::{Act, Candidate, check};

const TICK: Duration = Duration::from_millis(50);
const CHECKERS: usize = 4;
const SOULS: usize = 1_000;
const SECONDS: u32 = 3;
const FLOOD_RATE: u32 = 50;
const FLOOD_WIDTH: usize = 400;
const REPEATS: usize = 2;
/// The flood's act ids start here; the others' are their index.
const FLOOD_IDS: u64 = 1 << 40;

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn pct(v: &mut [Duration], p: usize) -> f64 {
    v.sort();
    ms(v[(v.len() * p / 100).min(v.len() - 1)])
}

/// An act whose candidates are `n` toggles' switch_on, from one body.
fn wide(id: u64, w: &World, body: usize, n: usize) -> Act {
    let mut a = toggle(id, w.pairs[body].0, w.pairs[body].1);
    a.candidates = (0..n)
        .map(|i| Candidate {
            this: w.pairs[(body + i) % w.pairs.len()].1,
            form: "switch_on".into(),
        })
        .collect();
    a
}

fn step0() {
    let w = World::build(100, 10, 80);
    let copy = w.replica.frozen();
    let rules = rules();
    for (label, n) in [
        ("toggle (2 candidates)", 2usize),
        ("wide (50)", 50),
        ("wide (200)", 200),
    ] {
        let rounds = if n > 2 { 2_000 } else { 20_000 };
        let mut t = Vec::with_capacity(rounds);
        for i in 0..rounds {
            let act = if n == 2 {
                let (b, l) = w.pairs[i % w.pairs.len()];
                toggle(i as u64, b, l)
            } else {
                wide(i as u64, &w, i % w.pairs.len(), n)
            };
            let s = Instant::now();
            let c = check(&copy, &rules, &act);
            t.push(s.elapsed());
            std::hint::black_box(c);
        }
        let mean = t.iter().map(|d| ms(*d)).sum::<f64>() / t.len() as f64;
        println!(
            "{label}: {rounds} checks, median {:.4} ms, p99 {:.4} ms, mean {:.4} ms, per candidate (median) {:.4} ms",
            pct(&mut t, 50),
            pct(&mut t, 99),
            mean,
            pct(&mut t, 50) / n as f64
        );
    }
    let mut t = Vec::new();
    for i in 0..200_000 {
        let id = w.pairs[i % w.pairs.len()].1;
        let s = Instant::now();
        std::hint::black_box(copy.node(id));
        t.push(s.elapsed());
    }
    println!(
        "node read: median {:.5} ms, p99 {:.5} ms",
        pct(&mut t, 50),
        pct(&mut t, 99)
    );
}

/// One run's numbers.
#[derive(Default)]
struct Run {
    /// The others' latencies, send to answer.
    others: Vec<Duration>,
    others_slowed: usize,
    others_refused: HashMap<String, usize>,
    flood_sent: usize,
    flood_checked: usize,
    flood_slowed: usize,
    waits: Vec<Duration>,
    flood_left: i64,
    others_min_left: i64,
    rechecks: usize,
}

/// Sends `n` acts evenly over `SECONDS`, `make(i)` the i-th; the send instants by act id.
fn feed(
    turns: Arc<Turns>,
    n: usize,
    make: impl Fn(usize) -> Act + Send + 'static,
) -> thread::JoinHandle<Vec<(u64, Instant)>> {
    thread::spawn(move || {
        let gap = Duration::from_secs(u64::from(SECONDS)) / u32::try_from(n).expect("n");
        let start = Instant::now();
        let mut sent = Vec::with_capacity(n);
        for i in 0..n {
            let at = start + gap * u32::try_from(i).expect("i");
            let now = Instant::now();
            if now < at {
                thread::sleep(at - now);
            }
            let act = make(i);
            sent.push((act.id, Instant::now()));
            turns.submit(act, None);
        }
        sent
    })
}

fn run(w: &mut World, flood: bool) -> Run {
    let publisher = Arc::new(Publisher::new(&w.replica));
    let (turns, answers) = start(
        CHECKERS,
        Arc::clone(&publisher),
        Arc::new(rules()),
        real_clock(),
    );
    let pairs = Arc::new(w.pairs.clone());
    let n = SOULS * SECONDS as usize;
    let p = Arc::clone(&pairs);
    let others = feed(Arc::clone(&turns), n, move |i| {
        let (b, l) = p[i % SOULS];
        let mut a = toggle(i as u64, b, l);
        a.actor = Actor::Soul(b);
        a
    });
    let f = (FLOOD_RATE * SECONDS) as usize;
    let flooder = flood.then(|| {
        let p = Arc::clone(&pairs);
        feed(Arc::clone(&turns), f, move |i| {
            let room = &p[SOULS..];
            let body = room[0].0;
            let mut a = toggle(FLOOD_IDS + i as u64, body, room[0].1);
            a.actor = Actor::Soul(body);
            a.candidates = (0..FLOOD_WIDTH)
                .map(|k| Candidate {
                    this: room[k % room.len()].1,
                    form: "switch_off".into(),
                })
                .collect();
            a
        })
    });
    let expected = n + if flood { f } else { 0 };
    let mut answered: HashMap<u64, Instant> = HashMap::new();
    let mut r = Run {
        others_min_left: i64::MAX,
        ..Run::default()
    };
    let mut deadline = Instant::now() + TICK;
    while answered.len() < expected {
        let now = Instant::now();
        if now < deadline {
            thread::sleep(deadline - now);
        }
        let mut parts = Vec::new();
        for mut a in answers.try_iter() {
            let is_flood = a.act.id >= FLOOD_IDS;
            if is_flood {
                r.flood_left = a.left;
            } else {
                r.others_min_left = r.others_min_left.min(a.left);
            }
            match a.answered {
                Answered::Checked(checks) => match commit(&mut w.replica, &checks, 0) {
                    Outcome::Applied { part, .. } => {
                        parts.push(part);
                        r.flood_checked += usize::from(is_flood);
                        answered.insert(a.act.id, Instant::now());
                    }
                    Outcome::Recheck { version } => {
                        r.rechecks += 1;
                        a.act.recheck = Some(version);
                        turns.submit(a.act, None);
                    }
                    Outcome::Refused { reason } => {
                        if is_flood {
                            r.flood_checked += 1;
                        } else {
                            *r.others_refused.entry(reason).or_default() += 1;
                        }
                        answered.insert(a.act.id, Instant::now());
                    }
                },
                Answered::SlowDown { wait } => {
                    if is_flood {
                        r.flood_slowed += 1;
                        r.waits.push(wait);
                    } else {
                        r.others_slowed += 1;
                    }
                    answered.insert(a.act.id, Instant::now());
                }
                Answered::Replaced { .. } => unreachable!("the bench replaces nothing"),
            }
        }
        publisher.publish(parts);
        deadline += TICK;
    }
    for (id, at) in others.join().expect("the feeder") {
        r.others.push(answered[&id] - at);
    }
    if let Some(f) = flooder {
        r.flood_sent = f.join().expect("the flood").len();
    }
    turns.close();
    r
}

fn runs() {
    mark_clock_thread();
    let cores = thread::available_parallelism().map_or(0, |n| n.get());
    let mut w = World::build(101, 10, 80);
    println!(
        "world: {} bodies (the last room's ten are the flood's); {cores} cores, {CHECKERS} checker threads, {} ms ticks; \
         {SOULS} Souls x 1 act/s for {SECONDS} s; flood {FLOOD_RATE} acts/s of {FLOOD_WIDTH} candidates",
        w.pairs.len(),
        TICK.as_millis()
    );
    println!();
    println!(
        "| arm | repeat | others answered | others max | others p99 | others p50 | others slowed | others refused | \
         others min left | flood sent | flood checked | flood slowed | flood wait (first, max) | flood left | rechecks |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    let mut p99s: HashMap<&str, Vec<f64>> = HashMap::new();
    for repeat in 1..=REPEATS {
        for (arm, flood) in [("base", false), ("flood", true)] {
            let mut r = run(&mut w, flood);
            let max = r.others.iter().max().copied().unwrap_or_default();
            let p99 = pct(&mut r.others, 99);
            let p50 = pct(&mut r.others, 50);
            p99s.entry(arm).or_default().push(p99);
            let first = r.waits.first().map_or(0.0, |d| ms(*d));
            let most = r.waits.iter().max().map_or(0.0, |d| ms(*d));
            println!(
                "| {arm} | {repeat} | {} | {:.1} ms | {p99:.1} ms | {p50:.1} ms | {} | {:?} | {:.3} ms | {} | {} | {} | \
                 {first:.1} ms, {most:.1} ms | {:.3} ms | {} |",
                r.others.len(),
                ms(max),
                r.others_slowed,
                r.others_refused,
                r.others_min_left as f64 / 1e6,
                r.flood_sent,
                r.flood_checked,
                r.flood_slowed,
                r.flood_left as f64 / 1e6,
                r.rechecks
            );
        }
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let (base, flood) = (mean(&p99s["base"]), mean(&p99s["flood"]));
    println!();
    println!(
        "others' p99, mean of the repeats: base {base:.2} ms, flood {flood:.2} ms, moved {:+.1} %",
        (flood - base) / base * 100.0
    );
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("step0") => step0(),
        _ => runs(),
    }
}
