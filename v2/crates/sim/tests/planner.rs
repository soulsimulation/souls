//! The world's planner off the clock (Engine v2 K18b, #3175) on N2's test world: walkers sent through the host with
//! the planner on a thread of its own, the runner on a thread marked as the clock (a route search there panics in a
//! debug build).
//!
//! `cargo test -p sim --release --test planner -- --nocapture`; the timing run is
//! `cargo test -p sim --release --test planner -- --ignored --nocapture`.

mod common;

use common::{arrived, id, send, stand};
use replica::pose::Vec3;
use sim::host::{Planned, Runner};
use sim::planner::{Planner, Thread};
use sim::spots::Target;
use sim::walk::town::Town;

const SPEED: i64 = 1_400_000; // µm a second: today's walking pace
const TICK: i64 = 50_000; // µs: 20 ticks a second

fn town() -> Town {
    common::town(b"souls/planner-test/1").0
}

/// Walker `k` of `n`: it starts west of the square and is sent to its own point on the ring's walkway, east of the
/// ring's solid middle for most (their straight way crosses it).
fn walker(t: &Town, k: u64, n: u64) -> (sim::mover::Body, Vec3) {
    let ground = t.ground;
    let (col, row) = ((k % 20) as i64, (k / 20) as i64);
    let at = Vec3::new(
        -26_000_000 + col * 1_200_000,
        0,
        -26_000_000 + row * 1_200_000,
    );
    let a = std::f64::consts::TAU * k as f64 / n as f64;
    let to = Vec3::new(
        75_000_000 + (13_000_000.0 * a.cos()) as i64,
        0,
        (13_000_000.0 * a.sin()) as i64,
    );
    (stand(t, id(k + 1), ground, at), to)
}

fn runner(t: &Town, n: u64) -> Runner {
    let mut r = Runner::new(TICK);
    for k in 0..n {
        let (b, to) = walker(t, k, n);
        send(&mut r, b, SPEED, Target::new(t.ground, to), id(10_000 + k)).unwrap();
    }
    r
}

/// What a run with the planner left: world time at its end (µs), the walkers that arrived, the route searches the
/// planner ran, and the clock's own time per tick (µs; without the wait for the planner).
struct Run {
    now: i64,
    arrived: usize,
    searched: u64,
    times: Vec<u64>,
}

/// `n` walkers ticked with a planner thread, `ticks` times or until every walk ended, on a thread marked as the
/// clock (skills stay on the thread that steps them).
fn planned(n: u64, ticks: usize) -> Run {
    std::thread::spawn(move || {
        sim::commit::mark_clock_thread();
        let mut t = town();
        let mut r = runner(&t, n);
        let mut p = Thread::spawn(Planner::new(t.copy().unwrap())).unwrap();
        let mut answers = Planned::default();
        let mut times = Vec::new();
        for _ in 0..ticks {
            if r.runs.is_empty() {
                break;
            }
            #[allow(clippy::disallowed_methods)] // a test timing its own ticks
            let t0 = std::time::Instant::now();
            let (wants, _) = r.tick_planned(&mut t, &answers);
            p.send(wants);
            #[allow(clippy::disallowed_methods)]
            times.push(t0.elapsed().as_micros() as u64);
            answers = p.take(None);
        }
        Run {
            now: r.now,
            arrived: (0..n).filter(|&k| arrived(&r, id(k + 1)).is_some()).count(),
            searched: p.searched,
            times,
        }
    })
    .join()
    .expect("the clock thread ran no route search")
}

fn pct(v: &mut [u64], q: usize) -> u64 {
    v.sort_unstable();
    v.get((v.len() * q / 100).min(v.len().saturating_sub(1)))
        .copied()
        .unwrap_or(0)
}

/// A1, A2: twenty walkers, most round the ring's middle, arrive with every search on the planner's thread.
#[test]
fn a1_a2_walkers_round_the_ring_arrive_with_no_search_on_the_clock() {
    let run = planned(20, 4_000);
    println!(
        "K18b: {} of 20 arrived by {} s, {} searches on the planner",
        run.arrived,
        run.now / 1_000_000,
        run.searched
    );
    assert_eq!(run.arrived, 20, "every walk arrives");
    assert!(run.searched > 20, "the planner searched");
}

/// The clock's tick with and without the planner: `n` walkers, 30 s of world time, back to back.
#[test]
#[ignore = "a timing run: release build, quiet machine"]
fn timing_the_clock_tick_with_and_without_the_planner() {
    let n = 500;
    let ticks = 600;
    let mut t = town();
    let mut r = runner(&t, n);
    let mut on = Vec::new();
    for _ in 0..ticks {
        #[allow(clippy::disallowed_methods)] // a test timing its own ticks
        let t0 = std::time::Instant::now();
        let _ = r.tick(&mut t);
        #[allow(clippy::disallowed_methods)]
        on.push(t0.elapsed().as_micros() as u64);
    }
    let Run {
        searched,
        times: mut off,
        ..
    } = planned(n, ticks);
    println!(
        "K18b timing, {n} walkers, {ticks} ticks: searches on the clock: tick median {} us, p99 {} us; with the \
         planner: tick median {} us, p99 {} us ({searched} searches on the planner)",
        pct(&mut on, 50),
        pct(&mut on, 99),
        pct(&mut off, 50),
        pct(&mut off, 99),
    );
}

#[test]
fn reach_answers_keep_exact_slot_and_order_identity_off_clock() {
    use sim::host::{ReachQuestion, Wants};
    let mut planner = Thread::spawn(Planner::new(town())).unwrap();
    sim::commit::mark_clock_thread();
    let (body, thing, old, current) = (id(50_001), id(50_002), id(50_003), id(50_004));
    let q = |slot, order, x| ReachQuestion {
        body,
        thing,
        slot,
        order,
        at: Vec3::ZERO,
        points: [Vec3::new(x, 0, 0); 2],
    };
    planner.send(Wants {
        reach: vec![
            q(1, old, 0),
            q(1, current, 3_000_000),
            q(2, current, 5_000_000),
        ],
        ..Wants::default()
    });
    let got = planner.take(None);
    assert_eq!(
        got.reach.len(),
        3,
        "neither a different slot nor a replacement order overwrites another answer"
    );
    assert_eq!(got.reach[&(body, thing, 1, old)], [0, 0]);
    assert_eq!(got.reach[&(body, thing, 1, current)], [3_000_000; 2]);
    assert_eq!(got.reach[&(body, thing, 2, current)], [5_000_000; 2]);
}

/// C29: the route result carries its own length/link count to the exact active order. A late answer from a
/// replaced walk must not provide the replacement's deadline; ending the current order clears its metrics.
#[test]
fn route_metrics_belong_only_to_the_current_order_and_clear_on_end() {
    let mut t = town();
    let mut r = runner(&t, 1);
    let who = id(1);
    let order = id(10_000);
    let mut planner = Planner::new(t.copy().unwrap());
    let (wants, _) = r.tick_planned(&mut t, &Planned::default());
    let old = planner.answer(&wants);
    let (_, Ok((_, _, expected))) = old.places.get(&who).expect("the planned place") else {
        panic!("a route was planned")
    };
    assert!(expected.length_mm > 0);
    assert!(r.route_metrics(who, order).is_none());
    r.tick_planned(&mut t, &old).1.unwrap();
    assert_eq!(r.route_metrics(who, order), Some(*expected));
    assert!(r.route_metrics(who, id(99_999)).is_none());

    let next = id(20_000);
    r.send(
        who,
        Box::new(skills::route::Route::sent(SPEED, TICK)),
        Target::new(t.ground, Vec3::new(88_000_000, 0, 0)),
        next,
    )
    .unwrap();
    assert!(r.route_metrics(who, order).is_none());
    let (wants, _) = r.tick_planned(&mut t, &old);
    assert!(
        r.route_metrics(who, next).is_none(),
        "the old order's late plan is ignored"
    );
    let fresh = planner.answer(&wants);
    r.tick_planned(&mut t, &fresh).1.unwrap();
    assert!(r.route_metrics(who, next).is_some());
    r.end_order(who);
    assert!(r.route_metrics(who, next).is_none());
}
