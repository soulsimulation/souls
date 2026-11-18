//! The `timers` bench (Engine v2 K9, #2672): a test world of 10,000 things with 1,000 timers that fire 10,000 times
//! in all, advanced 24 hours by jumping to each next due time (A1: under 50 ms), then checked against the same world
//! stepped tick by tick at 20 a second, and again with the rate changed to 30 inside the gap (A2, A3); then a tick's
//! cost with 5,000 timers pending and none due (A4). Run from `v2/`: `cargo run -p bench --release --bin timers`.
//! Declared on #2672. The scenario is `crates/sim/tests/timers.rs`, included by path so both run the same one.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

#[path = "../../../crates/sim/tests/timers.rs"]
mod scenario;

use scenario::{HOUR, Scenario, World, both};
use sim::timers::{DueList, Timer};
use std::hint::black_box;
use std::time::Instant;

use replica::encode::Name;
use replica::ids::{Minter, Scope};

const FULL: Scenario = Scenario {
    seed: 7,
    things: 10_000,
    timers: 1_000,
    fires: 10,
    span: 24 * HOUR,
    change_at: None,
};

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

fn main() {
    for repeat in 1..=2 {
        println!("repeat {repeat}");
        let mut w = World::new(&FULL);
        let t = Instant::now();
        w.jump(None);
        let took = ms(t);
        println!(
            "  A1 jump: 24 h, {} fires, {} entries, {} ticks run: {took:.2} ms (bar 50)",
            w.fired(),
            w.written.len(),
            w.ticks
        );
        let [enc, dec, apply] = w.spent.map(|d| d.as_secs_f64() * 1e3);
        println!(
            "     of which committing the entries: encoding the parts {enc:.2} ms, reading them back {dec:.2} ms, \
             the tree's apply {apply:.2} ms; the rest (the due list, the entries built) {:.2} ms",
            took - enc - dec - apply
        );

        let t = Instant::now();
        let (_, stepped) = both(&FULL);
        println!(
            "  A2 equal to every tick: {} ticks stepped; jump and step together {:.0} ms",
            stepped.ticks,
            ms(t)
        );
        let changed = Scenario {
            change_at: Some(6 * HOUR + 300_000),
            ..FULL
        };
        let t = Instant::now();
        let (_, stepped) = both(&changed);
        println!(
            "  A3 equal with 20 -> 30 a second at 6 h 0.3 s: {} ticks stepped; {:.0} ms",
            stepped.ticks,
            ms(t)
        );

        // A4: 5,000 timers pending, all due after the ticks measured; a tick asks the list for what is due.
        let mut due = DueList::new();
        let mut mint = Minter::new(Scope([0x4c; 16]));
        let name = Name::new("k9:idle").expect("a name");
        for i in 0..5_000 {
            let node = mint.mint().expect("an id");
            let id = mint.mint().expect("an id");
            due.set(Timer {
                node,
                id,
                due: 25 * HOUR + i,
                name: name.clone(),
            })
            .expect("set");
        }
        let line = &w.line;
        let ticks = 1_000_000;
        let t = Instant::now();
        let mut fired = 0;
        for n in 0..ticks {
            let end = line.tick_start(black_box(n) + 1).expect("a tick");
            while let Some(t) = due.fire(end) {
                black_box(t);
                fired += 1;
            }
        }
        let per = t.elapsed().as_secs_f64() * 1e9 / ticks as f64;
        assert_eq!(fired, 0, "none due");
        println!(
            "  A4 a tick with {} pending and none due: {per:.1} ns (the tick's end computed and the list's first key read)",
            due.len()
        );
    }
}
