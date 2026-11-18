//! The `timed` bench (Engine v2 F5, #2770, A1): K9's test world (10,000 things, 1,000 timers firing 50 times each in
//! the hour) stepped tick by tick at 20 a second for one hour of world time, without and with 5,000 timed values
//! whose crossings all fall after the hour (none due). Each arm runs twice, interleaved; the tick's mean time is
//! printed for each run. The bar, declared on #2770 before the run: the arms' means differ by no more than the larger
//! of the two arms' repeat-to-repeat differences. Run from `v2/`: `cargo run -p bench --release --bin timed`.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

#[path = "../../../crates/sim/tests/timers.rs"]
mod scenario;

use replica::ids::{Minter, Scope};
use replica::timed::{Bounds, Level, Timed};
use scenario::{HOUR, Scenario, World};
use sim::timed::{Field, Values};
use std::time::Instant;

const RUN: Scenario = Scenario {
    seed: 11,
    things: 10_000,
    timers: 1_000,
    fires: 50,
    span: HOUR,
    change_at: None,
};

const TIMED: u64 = 5_000;

/// One arm: the world built (not timed), then every tick of the hour stepped; the mean tick in µs and the timed
/// values kept.
fn arm(with: bool) -> (f64, u64, usize) {
    let mut w = World::new(&RUN);
    let mut values = Values::new();
    if with {
        let mut mint = Minter::new(Scope([0xf5; 16]));
        for i in 0..TIMED {
            let field = Field {
                n: 1,
                bounds: Bounds {
                    min: Some(0),
                    max: Some(1_000_000),
                },
                levels: vec![(Level::AtLeast(1_000_000), "full".into())],
            };
            let node = mint.mint().expect("an id");
            // At 1 to 100 a second from 0, the level is 2.7 to 277 hours away: never inside the hour.
            let to = Timed {
                value: 0,
                per_s: 1 + (i % 100) as i64,
                set_us: 0,
            };
            values
                .set(&mut w.due, &mut mint, node, &field, to, 0)
                .expect("set");
        }
        assert!(w.due.len() >= TIMED as usize);
    }
    let t = Instant::now();
    w.step(None);
    let us = t.elapsed().as_secs_f64() * 1e6 / w.ticks as f64;
    (us, w.fired(), values.len())
}

fn main() {
    let mut without = Vec::new();
    let mut with = Vec::new();
    for repeat in 1..=2 {
        for on in [false, true] {
            let (us, fired, kept) = arm(on);
            println!(
                "repeat {repeat} {:<7} {kept:>5} timed values: {:.3} µs a tick over {} ticks, {fired} timer fires",
                if on { "with" } else { "without" },
                us,
                RUN.span / 50_000
            );
            if on { &mut with } else { &mut without }.push(us);
        }
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let spread = (without[0] - without[1])
        .abs()
        .max((with[0] - with[1]).abs());
    let diff = mean(&with) - mean(&without);
    println!(
        "A1: mean without {:.3} µs, with {:.3} µs, difference {diff:+.3} µs; spread of two repeats {spread:.3} µs: {}",
        mean(&without),
        mean(&with),
        if diff.abs() <= spread {
            "within"
        } else {
            "OUTSIDE"
        }
    );
}
