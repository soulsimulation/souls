//! The `moves` bench (Engine v2 B2, #2681): 1,000 bodies of the fixtures' two-handed family on open ground, each tick
//! the controller's step and the due list's timers. Arm `idle` starts no moves; arm `claims` makes the move's claim on
//! every body and nothing else (no move set, no timer: #3236); arm `moves` starts one move on every body. Only ticks
//! wholly inside one phase of every move are timed, so 1,000 moves are in progress and none is at a phase boundary
//! (A2); every arm times the same ticks. Each arm also times each cycle's first tick, the one that logs the inputs its
//! starts changed (#3236: where the time goes). Mean and median of the timed ticks; on a loaded machine a preempted
//! tick moves the mean, not the median. The move is the fixture with the longest phase after contact,
//! chosen from data, never by name. Then each fixture move beyond its reach, refused (A3). Two repeats. Declared on
//! #2681. Run from `v2/`: `cargo run -p bench --release --bin moves`.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::hint::black_box;
use std::path::Path;
use std::time::Instant;

use body_script::{TICK, ground, ground_id, humanoid, place};
use replica::encode::Name;
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::time::Micros;
use sim::controller::Controller;
use sim::moves::{Moves, Reach, load};
use sim::timers::DueList;

const BODIES: i64 = 1_000;
const CYCLES: usize = 100;

/// Every thing is this far from every body's effector, µm.
struct Fixed(i64);

impl Reach for Fixed {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, _: Id, _: &Name) -> Option<i64> {
        Some(self.0)
    }
}

struct World {
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    bodies: Vec<Id>,
    target: Id,
    tick: i64,
}

fn world() -> World {
    let g = ground();
    let mut c = Controller::new();
    let mut mint = Minter::new(Scope([0xb2; 16]));
    let mut bodies = Vec::new();
    for i in 0..BODIES {
        let id = mint.mint().expect("an id");
        // A grid 1 m apart inside the 40 m ground.
        place(&mut c, &g, id, humanoid(), i % 32 - 16, i / 32 - 16).expect("placed");
        bodies.push(id);
    }
    let target = mint.mint().expect("an id");
    World {
        c,
        due: DueList::new(),
        mint,
        moves: Moves::new(),
        bodies,
        target,
        tick: 0,
    }
}

impl World {
    /// One tick: the controller steps every body, then every timer due before the next tick fires. Returns the
    /// timers fired.
    fn step(&mut self, surfaces: &BTreeMap<Id, sim::mover::Surface>, geo: &Fixed) -> usize {
        let at = self.tick * TICK;
        let end = at + TICK;
        black_box(self.c.step(surfaces, TICK, at));
        let mut fired = 0;
        while let Some(t) = self.due.fire(end) {
            black_box(
                self.moves
                    .fire(&mut self.c, &mut self.due, &mut self.mint, geo, &t),
            );
            fired += 1;
        }
        self.tick += 1;
        fired
    }
}

/// What an arm starts on every body each cycle.
#[derive(Clone, Copy, PartialEq)]
enum Arm {
    Idle,
    /// The move's claim alone, released when the move would end.
    Claims,
    Moves,
}

/// One arm's numbers.
struct Run {
    /// Mean and median ns of the timed ticks.
    mean: f64,
    median: f64,
    /// Mean ns of each cycle's first tick, and the input records it logged a cycle.
    first: f64,
    logged: usize,
}

/// `CYCLES` cycles of `arm` on every body.
fn arm(mv: &Move, phase: usize, arm: Arm) -> Run {
    let run = arm == Arm::Moves;
    let surfaces = BTreeMap::from([(ground_id(), ground())]);
    let geo = Fixed(0);
    let mut w = world();
    let starts: Vec<Micros> = std::iter::once(0)
        .chain(mv.phases.iter().scan(0, |a, p| {
            *a += p.length;
            Some(*a)
        }))
        .collect();
    let mut ticks = Vec::new();
    let (mut first, mut logged) = (0.0, 0);
    // The bodies' first inputs are logged here, not in a cycle's first tick.
    w.step(&surfaces, &geo);
    for _ in 0..CYCLES {
        let t0 = w.tick * TICK;
        if run {
            for &b in &w.bodies.clone() {
                w.moves
                    .start(&mut w.c, &mut w.due, &mut w.mint, &geo, b, mv, w.target, t0)
                    .expect("started");
            }
            assert_eq!(w.moves.len(), BODIES as usize);
        }
        let mut held = Vec::new();
        if arm == Arm::Claims {
            let shape = mv.shape();
            for &b in &w.bodies {
                held.push((b, w.c.claim(b, &shape).expect("claimed")));
            }
        }
        let (from, to) = (t0 + starts[phase], t0 + starts[phase + 1]);
        let done = t0 + mv.length();
        let before = w.c.log().len();
        let t = Instant::now();
        assert_eq!(w.step(&surfaces, &geo), 0, "no boundary in a first tick");
        first += t.elapsed().as_secs_f64() * 1e9;
        logged += w.c.log().len() - before;
        while w.tick * TICK < done + TICK {
            let at = w.tick * TICK;
            // A tick handles the timers due in [at, at + TICK): none of the phase's ends.
            let inside = at > from && at + TICK <= to;
            if inside {
                let t = Instant::now();
                let fired = w.step(&surfaces, &geo);
                ticks.push(t.elapsed().as_secs_f64() * 1e9);
                assert_eq!(fired, 0, "no boundary in a timed tick");
                if run {
                    assert_eq!(w.moves.len(), BODIES as usize);
                }
            } else {
                w.step(&surfaces, &geo);
            }
            if at + TICK > done {
                for (b, d) in held.drain(..) {
                    w.c.release(b, d).expect("released");
                }
            }
        }
        assert!(w.moves.is_empty(), "every move ended");
        // A tick at rest logs what the ends changed, so the next start's changes are logged in its first tick.
        w.step(&surfaces, &geo);
    }
    let mean = ticks.iter().sum::<f64>() / ticks.len() as f64;
    ticks.sort_by(f64::total_cmp);
    Run {
        mean,
        median: ticks[ticks.len() / 2],
        first: first / CYCLES as f64,
        logged: logged / CYCLES,
    }
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/replica/fixtures/moves");
    let all = load(&dir).expect("the fixture moves");
    // The longest phase after contact, so the most ticks lie wholly inside it.
    let (mv, phase) = all
        .iter()
        .flat_map(|m| (1..m.phases.len()).map(move |p| (m, p)))
        .max_by_key(|(m, p)| m.phases[*p].length)
        .expect("a move with a phase after contact");
    let ticks = mv.phases[phase].length / TICK - 1;
    println!(
        "{} bodies; move {} rev {}, phase {} ({} µs): about {ticks} timed ticks a cycle, {CYCLES} cycles; tick {TICK} µs",
        BODIES,
        mv.name.as_str(),
        mv.revision,
        mv.phases[phase].name.as_str(),
        mv.phases[phase].length
    );
    let mut rows = Vec::new();
    for repeat in 1..=2 {
        let runs = [Arm::Idle, Arm::Claims, Arm::Moves].map(|a| arm(mv, phase, a));
        let [i, c, m] = &runs;
        println!(
            "repeat {repeat}: timed ticks, mean / median ns: idle {:.0} / {:.0}, 1,000 claims held {:.0} / {:.0}, \
             1,000 moves in progress {:.0} / {:.0}",
            i.mean, i.median, c.mean, c.median, m.mean, m.median
        );
        println!(
            "  first tick of a cycle: idle {:.0} ns ({} inputs logged), claims {:.0} ns ({}), moves {:.0} ns ({}): \
             about {:.0} ns more an input logged",
            i.first,
            i.logged,
            c.first,
            c.logged,
            m.first,
            m.logged,
            (m.first - i.first) / m.logged.max(1) as f64
        );
        rows.push(runs.map(|r| (r.mean, r.median)));
    }
    // Arm `a`'s statistic (0 mean, 1 median): the mean of the two repeats, and their spread.
    let stat = |a: usize, k: usize| {
        let v = |r: &[(f64, f64); 3]| if k == 0 { r[a].0 } else { r[a].1 };
        (
            (v(&rows[0]) + v(&rows[1])) / 2.0,
            (v(&rows[0]) - v(&rows[1])).abs(),
        )
    };
    for (k, what) in [(1, "median"), (0, "mean")] {
        let ((mi, si), (mc, _), (mm, sm)) = (stat(0, k), stat(1, k), stat(2, k));
        let verdict = |ok: bool| if ok { "met" } else { "UNMET" };
        println!(
            "#3236 A2 by the {what}: claims held {mc:.0} ns, idle {mi:.0} ns, difference {:.0} ns, bar (the idle spread) \
             {si:.0} ns: {}; moves in progress {mm:.0} ns, difference {:.0} ns, bar (the larger spread) {:.0} ns: {}",
            mc - mi,
            verdict(mc - mi <= si),
            mm - mi,
            si.max(sm),
            verdict((mm - mi).abs() <= si.max(sm))
        );
    }
    let ((mi, si), (mm, sm)) = (stat(0, 0), stat(2, 0));
    let bar = si.max(sm);
    println!(
        "A2: mean idle {mi:.0} ns, mean moves {mm:.0} ns, difference {:.0} ns; spread idle {si:.0} ns, moves {sm:.0} ns; \
         bar (the larger spread) {bar:.0} ns: {}",
        mm - mi,
        if (mm - mi).abs() <= bar {
            "met"
        } else {
            "UNMET"
        }
    );

    let mut w = world();
    for mv in &all {
        let far = mv.reach + 100_000;
        let b = w.bodies[0];
        match w.moves.start(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &Fixed(far),
            b,
            mv,
            w.target,
            0,
        ) {
            Err(r) => println!("A3: {r}"),
            Ok(_) => panic!("{} beyond reach started", mv.name.as_str()),
        }
    }
}
