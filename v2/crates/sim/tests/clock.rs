//! The clock (Engine v2 K7, #2647) on a fake clock: world time never goes back (A2), and after an overrun the loop
//! ticks back to back until caught up, skipping no world time (A3), with its durations, overruns and lag exposed
//! (A5). `cargo test -p sim --test clock -- --nocapture`. The stall and restart (A1) is `v2/tools/stall-test`.

use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use sim::clock::{Fake, Heartbeat, Ticker};

/// The real anchor: a Unix time in µs, as the process would read once at start.
const R0: Micros = 1_763_400_000_000_000;
/// 20 ticks a second.
const TICK: Micros = 50_000;

fn timeline() -> (Timeline, Mapping) {
    let m = Mapping::new(0, R0, 1, 1).unwrap();
    let line = Timeline::start(
        m,
        TickRate::new(0, 0, 20).unwrap(),
        Tempo::per_minute(0, 0, 120).unwrap(),
    )
    .unwrap();
    (line, m)
}

/// SplitMix64: the seeded steps.
struct Seed(u64);

impl Seed {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

/// A2: 1,000 fake clock steps, a quarter of them backwards (up to 300 ms, six ticks' worth), the rest forwards
/// up to 200 ms. World time never decreases, ticks run in order with none skipped, and each runs at its own
/// start.
#[test]
fn a2_world_time_never_decreases_across_a_thousand_fake_steps() {
    let (line, m) = timeline();
    let mut seed = Seed(2647);
    let steps: Vec<Micros> = (0..1_000)
        .map(|_| {
            let r = seed.next();
            let size = (r >> 8) as i64 % 200_000;
            if r.is_multiple_of(4) {
                -(size * 3 / 2)
            } else {
                size
            }
        })
        .collect();
    let back = steps.iter().filter(|s| **s < 0).count();
    // Readings behind the latest already read: without the floor, world time would go back at each.
    let (mut at, mut top, mut behind) = (0i64, 0i64, 0);
    for s in &steps {
        at += s;
        behind += usize::from(at < top);
        top = top.max(at);
    }
    let mut clock = Fake::new(R0, steps);
    let mut t = Ticker::new(line, m, None, R0).unwrap();
    let beat = Heartbeat::new(R0);
    let (mut last_world, mut ran) = (t.world(), Vec::new());
    let mut reads = 0;
    while clock.next < clock.steps.len() {
        t.run_due(&mut clock, &beat, &mut |n, start| ran.push((n, start)))
            .unwrap();
        assert!(
            t.world() >= last_world,
            "world time went back: {} after {last_world}",
            t.world()
        );
        last_world = t.world();
        reads += 1;
    }
    for (k, &(n, start)) in ran.iter().enumerate() {
        assert_eq!(n, k as i64, "tick {k} ran as {n}");
        assert_eq!(start, n * TICK, "tick {n} at its own start");
    }
    println!(
        "A2: 1000 steps ({back} backwards, {behind} readings behind the latest), {reads} loop turns, {} ticks in order, world time {} us, never back; \
         clock ended at real {} us from the anchor",
        ran.len(),
        t.world(),
        clock.at - R0
    );
    assert!(back > 200 && behind > 200, "a quarter of the steps go back");
}

/// A3 and A5: a tick that overruns (300 ms, six ticks' worth). The loop then runs the owed ticks back to back, each
/// at its own start, until it has caught up; nothing is skipped and world time is where real time says. The stats
/// show the tick's duration, the overrun and the lag.
#[test]
fn a3_after_an_overrun_ticks_run_back_to_back_until_caught_up() {
    let (line, m) = timeline();
    // Readings: one as each turn starts (after the sleep) and one after each tick. Tick 0 costs 1 ms, tick 1 costs
    // 300 ms, and every tick after costs 1 ms.
    let mut steps = vec![0, 1_000, 0, 300_000];
    steps.extend(std::iter::repeat_n(1_000, 20));
    let mut clock = Fake::new(R0, steps);
    let mut t = Ticker::new(line, m, None, R0).unwrap();
    let beat = Heartbeat::new(R0);
    let mut ran: Vec<(i64, Micros)> = Vec::new();
    let mut turns = Vec::new();
    for k in 0..3 {
        if k > 0 {
            t.wait(&mut clock).unwrap();
        }
        let n = t
            .run_due(&mut clock, &beat, &mut |n, start| ran.push((n, start)))
            .unwrap();
        turns.push((n, t.stats));
    }
    for (k, &(n, start)) in ran.iter().enumerate() {
        assert_eq!(
            (n, start),
            (k as i64, k as i64 * TICK),
            "no tick skipped or moved"
        );
    }
    let s = t.stats;
    println!(
        "A3: turns {:?}",
        turns.iter().map(|x| x.0).collect::<Vec<_>>()
    );
    println!(
        "A3: {} ticks, last tick {} us, longest {} us, {} overrun(s), most owed {} us; world time {} us at real {} us",
        s.ticks,
        s.last_tick_us,
        s.max_tick_us,
        s.overruns,
        s.max_lag_us,
        t.world(),
        clock.at - R0
    );
    // Tick 1 ran 300 ms: ticks 2 to 7 were owed and ran in the same turn, back to back.
    assert_eq!(turns[1].0, 7, "tick 1 and the six it owed, in one turn");
    assert_eq!(s.max_tick_us, 300_000, "the overrun tick's duration");
    assert_eq!(s.overruns, 1, "one tick took longer than a tick");
    assert_eq!(
        s.max_lag_us, 250_000,
        "owed when tick 2 started: 350 ms less its start, 100 ms"
    );
    assert_eq!(
        beat.read().0,
        ran.last().unwrap().0,
        "the heartbeat names the last tick"
    );
    // Caught up: the next tick starts after world time now, and world time is the mapping's for real time now.
    assert!(t.world() < (t.next_tick()) * TICK);
    assert_eq!(t.world(), clock.at - R0);
}

/// A restart: world time is the later of the mapping's for the real time read at start and the last tick logged, so
/// a wall clock read early (stepped back) never takes world time back; the next tick is the one after the last.
#[test]
fn a_restart_takes_the_later_of_the_wall_clock_and_the_last_logged() {
    let (line, m) = timeline();
    // The wall clock read 5 s after the anchor, the log's last tick 99 (world 4.95 s): the clock is later.
    let t = Ticker::new(line.clone(), m, Some(99), R0 + 5_000_000).unwrap();
    assert_eq!((t.next_tick(), t.world()), (100, 5_000_000));
    // The wall clock read 1 s after the anchor (it stepped back), the log's last tick 99: the log is later.
    let t = Ticker::new(line, m, Some(99), R0 + 1_000_000).unwrap();
    assert_eq!((t.next_tick(), t.world()), (100, 99 * TICK));
}
