//! The `moves` bench (Engine v2 B2, #2681): 1,000 bodies of the fixtures' two-handed family on open ground, each tick
//! the controller's step and the due list's timers. Arm `idle` starts no moves; arm `moves` starts one move on every
//! body. Only ticks wholly inside one phase of every move are timed, so 1,000 moves are in progress and none is at a
//! phase boundary (A2); both arms time the same ticks. The move is the fixture with the longest phase after contact,
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

/// Mean ns per timed tick, over `CYCLES` cycles of one move on every body (`run` false: none started).
fn arm(mv: &Move, phase: usize, run: bool) -> f64 {
    let surfaces = BTreeMap::from([(ground_id(), ground())]);
    let geo = Fixed(0);
    let mut w = world();
    let starts: Vec<Micros> = std::iter::once(0)
        .chain(mv.phases.iter().scan(0, |a, p| {
            *a += p.length;
            Some(*a)
        }))
        .collect();
    let (mut spent, mut timed) = (0.0, 0u64);
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
        let (from, to) = (t0 + starts[phase], t0 + starts[phase + 1]);
        let done = t0 + mv.length();
        while w.tick * TICK < done + TICK {
            let at = w.tick * TICK;
            // A tick handles the timers due in [at, at + TICK): none of the phase's ends.
            let inside = at > from && at + TICK <= to;
            if inside {
                let t = Instant::now();
                let fired = w.step(&surfaces, &geo);
                spent += t.elapsed().as_secs_f64() * 1e9;
                timed += 1;
                assert_eq!(fired, 0, "no boundary in a timed tick");
                if run {
                    assert_eq!(w.moves.len(), BODIES as usize);
                }
            } else {
                w.step(&surfaces, &geo);
            }
        }
        assert!(w.moves.is_empty(), "every move ended");
    }
    spent / timed as f64
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
        let idle = arm(mv, phase, false);
        let moving = arm(mv, phase, true);
        println!(
            "repeat {repeat}: idle {idle:.0} ns a tick, 1,000 moves in progress {moving:.0} ns a tick"
        );
        rows.push((idle, moving));
    }
    let spread = |f: fn(&(f64, f64)) -> f64| (f(&rows[0]) - f(&rows[1])).abs();
    let (si, sm) = (spread(|r| r.0), spread(|r| r.1));
    let mi = (rows[0].0 + rows[1].0) / 2.0;
    let mm = (rows[0].1 + rows[1].1) / 2.0;
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
