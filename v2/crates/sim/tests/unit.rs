//! Units (Engine v2 K11, #2674): 20 panics injected into unit code on a world of Eden's size (N2's test world with
//! 10,000 things), against a clean twin. The clock keeps its rate (A3), the other bodies' effects equal the clean
//! run's (A4), and each failed unit ends by name with its body idle, a third failure retiring it (A5).
//! `cargo test -p sim --release --test unit -- --nocapture` prints the numbers. The 20 panic messages on stderr are
//! the injected ones.

#![allow(clippy::disallowed_methods)]

use replica::ids::{Id, Scope};
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use replica::tree::Tree;
use sim::clock::{Clock, Heartbeat, Stats, Ticker};
use sim::unit::{Ran, Units};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

const R0: Micros = 1_763_400_000_000_000;
const TICKS: i64 = 200;
const BODIES: u64 = 100;
/// The body whose unit fails three times, restarted after each.
const STUBBORN: u64 = 0;
const STUBBORN_AT: [i64; 3] = [30, 60, 90];

fn body(n: u64) -> Id {
    Id::new(Scope([0xB0; 16]), n + 1).unwrap()
}

fn unit_of(n: u64) -> String {
    format!("step-{n}")
}

/// Real time as it passes, with a sleep that jumps: the ticks cost what they really cost, and nobody waits.
struct Measured {
    t0: Instant,
    jumped: Micros,
}

impl Clock for Measured {
    fn now(&mut self) -> Micros {
        R0 + self.t0.elapsed().as_micros() as Micros + self.jumped
    }
    fn sleep_until(&mut self, t: Micros) {
        let now = self.now();
        self.jumped += (t - now).max(0);
    }
}

/// SplitMix64.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

/// 17 bodies whose unit panics once, at a seeded tick, plus the stubborn body's three: 20 panics.
fn plan() -> BTreeMap<(u64, i64), ()> {
    let mut rng = Rng(2674);
    let mut once = BTreeSet::new();
    while once.len() < 17 {
        let b = 1 + rng.next() % (BODIES - 1);
        once.insert(b);
    }
    let mut p: BTreeMap<(u64, i64), ()> = once
        .into_iter()
        .map(|b| ((b, 20 + (rng.next() % 160) as i64), ()))
        .collect();
    for t in STUBBORN_AT {
        p.insert((STUBBORN, t), ());
    }
    p
}

struct Run {
    stats: Stats,
    /// Every applied write: body, tick, value.
    effects: Vec<(u64, i64, i64)>,
    units: Units,
    refused: Vec<(u64, i64, &'static str)>,
}

/// Each body runs its unit every tick: it reads the tree and stages one write. With `panics`, a planned unit stages
/// its write and then panics.
fn run(tree: &Tree, panics: &BTreeMap<(u64, i64), ()>) -> Run {
    let m = Mapping::new(0, R0, 1, 1).unwrap();
    let line = Timeline::start(
        m,
        TickRate::new(0, 0, 20).unwrap(),
        Tempo::per_minute(0, 0, 120).unwrap(),
    )
    .unwrap();
    let mut ticker = Ticker::new(line, m, None, R0).unwrap();
    let mut clock = Measured {
        t0: Instant::now(),
        jumped: 0,
    };
    let beat = Heartbeat::new(R0);
    let mut units = Units::new();
    for b in 0..BODIES {
        units.start(body(b), &unit_of(b)).unwrap();
    }
    let (nodes, _) = tree.counts();
    let mut effects = Vec::new();
    let mut refused = Vec::new();
    while ticker.next_tick() < TICKS {
        ticker
            .run_due(&mut clock, &beat, &mut |n, _| {
                if n >= TICKS {
                    return;
                }
                // The stubborn body's agent starts its unit again the tick after each failure.
                if STUBBORN_AT.contains(&(n - 1))
                    && units.running(body(STUBBORN)).is_none()
                    && let Err(r) = units.start(body(STUBBORN), &unit_of(STUBBORN))
                {
                    refused.push((STUBBORN, n, r));
                }
                for b in 0..BODIES {
                    let Some(u) = units.running(body(b)).map(str::to_string) else {
                        continue;
                    };
                    let boom = panics.contains_key(&(b, n));
                    let ran = units.run(&u, body(b), tree, |t: &Tree, stage: &mut Vec<i64>| {
                        let h = t.root();
                        let kids = t.children(h).map_or(0, <[_]>::len) as i64;
                        stage.push(n * 1_000_003 + b as i64 * 7 + kids + nodes as i64);
                        if boom {
                            panic!("seeded panic in {u} at tick {n}");
                        }
                    });
                    if let Ran::Done(writes) = ran {
                        effects.extend(writes.into_iter().map(|v| (b, n, v)));
                    }
                }
            })
            .unwrap();
        ticker.wait(&mut clock).unwrap();
    }
    Run {
        stats: ticker.stats,
        effects,
        units,
        refused,
    }
}

#[test]
fn a3_a4_a5_twenty_panics_in_units_against_a_clean_twin() {
    let w = testworld::generate(1, 10_000).expect("the test world");
    let tree = import_eden::load(&w.text)
        .expect("the test world loads")
        .tree;
    let panics = plan();
    assert_eq!(panics.len(), 20);
    let clean = run(&tree, &BTreeMap::new());
    let faulty = run(&tree, &panics);

    // A3: the clock keeps its rate: every tick runs in both, and (a speed bar, real time) none overruns.
    println!(
        "A3: clean: {} ticks, {} overruns, longest tick {} us; with 20 panics: {} ticks, {} overruns, longest tick {} us",
        clean.stats.ticks,
        clean.stats.overruns,
        clean.stats.max_tick_us,
        faulty.stats.ticks,
        faulty.stats.overruns,
        faulty.stats.max_tick_us
    );
    assert_eq!(faulty.stats.ticks, TICKS as u64);
    assert_eq!(clean.stats.ticks, TICKS as u64);
    // An overrun is a tick's real cost over 50 ms: a loaded runner's debug build overruns with no fault in the units,
    // so the bar is asserted only in the speed-bar step (ci.sh, V2_SPEED_BARS=1, release).
    if std::env::var_os("V2_SPEED_BARS").is_some() {
        assert_eq!(faulty.stats.overruns, 0, "no tick overran");
    }

    // A4: the bodies that never failed wrote exactly what they wrote in the clean run.
    let failed: BTreeSet<u64> = panics.keys().map(|(b, _)| *b).collect();
    let others = |r: &Run| -> Vec<(u64, i64, i64)> {
        r.effects
            .iter()
            .filter(|e| !failed.contains(&e.0))
            .copied()
            .collect()
    };
    assert_eq!(others(&faulty), others(&clean));
    assert!(!others(&clean).is_empty());
    // A failed body's writes are the clean run's, without the failed tick's staged write and with nothing while idle.
    for b in &failed {
        let mine: Vec<_> = faulty.effects.iter().filter(|e| e.0 == *b).collect();
        let theirs: BTreeSet<_> = clean.effects.iter().filter(|e| e.0 == *b).collect();
        assert!(mine.iter().all(|e| theirs.contains(e)));
        assert!(mine.iter().all(|e| !panics.contains_key(&(e.0, e.1))));
    }
    println!(
        "A4: {} writes by the {} bodies that never failed, equal to the clean run's; {} by the failed bodies, all in the clean run",
        others(&faulty).len(),
        BODIES as usize - failed.len(),
        faulty.effects.len() - others(&faulty).len()
    );

    // A5: each failed unit ended by name, its body idle; the third failure retired the stubborn unit.
    assert_eq!(faulty.units.ended.len(), 20);
    for e in &faulty.units.ended {
        assert_eq!(e.reason, "unit-panicked");
        assert!(e.message.contains(&e.unit), "{e:?}");
        assert_eq!(faulty.units.running(e.body), None, "{} idle", e.unit);
    }
    let stubborn: Vec<_> = faulty
        .units
        .ended
        .iter()
        .filter(|e| e.body == body(STUBBORN))
        .map(|e| (e.strikes, e.retired))
        .collect();
    assert_eq!(stubborn, vec![(1, false), (2, false), (3, true)]);
    assert!(faulty.units.is_retired(&unit_of(STUBBORN)));
    assert_eq!(faulty.refused, vec![(STUBBORN, 91, "unit-retired")]);
    for (b, _) in panics.keys() {
        if *b != STUBBORN {
            assert!(!faulty.units.is_retired(&unit_of(*b)));
        }
    }
    let last = faulty.units.ended.last().unwrap();
    println!(
        "A5: 20 units ended by name ({} on 18 bodies, all idle after); e.g. {}: {}; {} retired after its third, then refused: {:?}",
        last.reason,
        last.unit,
        last.message,
        unit_of(STUBBORN),
        faulty.refused
    );
    assert_eq!(clean.units.ended.len(), 0);
}
