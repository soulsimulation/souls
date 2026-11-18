//! Walkers stepped side by side (Engine v2 N17b, #3255) on N2's test world: the same tick at any thread count.
//!
//! - **A1.** Crowds on the square, a crowd to one point, two groups swapping rooms through one door, and walkers up
//!   the stair onto the narrow door, with N10's ladder over them, each walker's start moved by the seed: the input
//!   log, every body's place, every body's fields, the runs that ended, the refusals and the ladder's record are the
//!   same at every tick at 1, 2, 4 and 8 threads (chunks of 3 runs, so every thread has some), over eight seeds.
//! - **A3.** A skill that panics in the middle of a chunk ends its own run by name (`unit-panicked`, the panic's
//!   message kept), and the tick goes on: the others walk on and arrive, at every thread count alike. A skill stepped
//!   beside others that draws is refused the same way (`beside-ordered`).

mod common;

use common::{id, stand, walk};
use replica::bodies::SkillShape;
use replica::host::{Host, Progress, Skill};
use replica::ids::Id;
use replica::pose::Vec3;
use sim::host::{BESIDE_ORDERED, Runner, UNIT_PANICKED};
use sim::unstick::Ladder;
use sim::walk::town::Town;
use sim::walk::{World, node_of};
use std::hash::{DefaultHasher, Hash, Hasher};

const SPEED: i64 = 1_400_000;
const TICK: i64 = 50_000;
const TICKS: usize = 400;

fn v(x: i64, z: i64) -> Vec3 {
    Vec3::new(x, 0, z)
}

/// SplitMix64, for the seed's jitter.
struct Seed(u64);
impl Seed {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [-r, r], µm.
    fn jit(&mut self, r: i64) -> i64 {
        (self.next() % (2 * r as u64 + 1)) as i64 - r
    }
}

struct Scene {
    t: Town,
    r: Runner,
    l: Ladder,
    walkers: Vec<Id>,
}

impl Scene {
    fn walker(&mut self, n: u64, node: Id, from: Vec3, to: Id, goal: Vec3) {
        let b = stand(&self.t, id(n), node, from);
        if let Ok(legs) = walk(&mut self.r, &mut self.t, b, SPEED, to, goal) {
            self.l.add(id(n), id(10_000 + n), SPEED, to, goal, legs);
            self.walkers.push(id(n));
        }
    }

    fn tick(&mut self) {
        // The world's own refusals are part of the outcome too: kept in the digest, never a stop.
        let r = self.l.step(&mut self.r, &mut self.t);
        self.r.refused.extend(r.err().map(|e| {
            (
                id(0),
                replica::effects::Refusal {
                    name: e.name,
                    detail: e.detail,
                },
            )
        }));
    }

    /// Everything the tick changed, as one number.
    fn digest(&self) -> u64 {
        let mut h = DefaultHasher::new();
        for b in self.r.controller.bodies() {
            (b.id, node_of(b)).hash(&mut h);
            format!(
                "{:?} {:?} {:?}",
                b.pose.position, b.pose.orientation, b.linear
            )
            .hash(&mut h);
        }
        for l in self.r.controller.log() {
            (l.at, l.body, &l.bytes).hash(&mut h);
        }
        format!("{:?}", self.r.fields).hash(&mut h);
        format!("{:?}", self.r.ended).hash(&mut h);
        format!("{:?}", self.r.refused).hash(&mut h);
        format!("{:?}", self.l.log).hash(&mut h);
        self.t.doors.stream.len().hash(&mut h);
        h.finish()
    }
}

/// The scene for `seed`, its runs stepped on `threads` threads, `chunk` at a time.
fn scene(seed: u64, threads: usize, chunk: usize) -> Scene {
    let (t, n) = common::town(b"souls/beside-test/1");
    let mut r = Runner::new(TICK);
    (r.threads, r.chunk) = (threads, chunk);
    let mut s = Scene {
        t,
        r,
        l: Ladder::new(),
        walkers: Vec::new(),
    };
    let mut j = Seed(seed);
    let (g, f0, f1) = (n["ground"], n["building/floor-0"], n["building/floor-1"]);
    // A four-way crossing on the square.
    for k in 0..4i64 {
        let a = -1_600_000 + k * 1_000_000 + j.jit(150_000);
        let o = 6_000_000 + j.jit(300_000);
        let k = k as u64;
        s.walker(100 + k, g, v(-o, a), g, v(o, a));
        s.walker(110 + k, g, v(o, a), g, v(-o, a));
        s.walker(120 + k, g, v(a, -o), g, v(a, o));
        s.walker(130 + k, g, v(a, o), g, v(a, -o));
    }
    // A crowd to one point.
    let (cx, cz) = (-10_000_000, 10_000_000);
    for (k, (c, sn)) in [
        (1000, 0),
        (809, 588),
        (309, 951),
        (-309, 951),
        (-809, 588),
        (-1000, 0),
        (-809, -588),
        (-309, -951),
        (309, -951),
        (809, -588),
    ]
    .iter()
    .enumerate()
    {
        let (x, z) = (
            cx + c * 5_000 + j.jit(200_000),
            cz + sn * 5_000 + j.jit(200_000),
        );
        s.walker(500 + k as u64, g, v(x, z), g, v(cx, cz));
    }
    // Two groups swapping rooms through one door.
    for k in 0..4i64 {
        let z = -4_200_000 + (k % 2) * 1_200_000;
        let dx = 1_000_000 + (k / 2) * 900_000;
        let w = j.jit(100_000);
        s.walker(
            300 + k as u64,
            f0,
            v(-2_000_000 - dx, z - 600_000 * (k / 2) + w),
            f0,
            v(-2_000_000 + dx, z),
        );
        s.walker(
            310 + k as u64,
            f0,
            v(-2_000_000 + dx, z + w),
            f0,
            v(-2_000_000 - dx, z - 600_000 * (k / 2)),
        );
    }
    // Up the stair onto the narrow door, and down.
    let w = j.jit(200_000);
    s.walker(700, f0, v(-6_000_000, 2_000_000 + w), f1, v(1_000_000, 0));
    s.walker(701, f0, v(-5_000_000, 2_000_000 - w), f1, v(2_000_000, 0));
    s.walker(710, f1, v(1_500_000, 0), f0, v(-5_500_000, -2_000_000 + w));
    s.walker(711, f1, v(2_500_000, 0), f0, v(-4_500_000, -2_000_000 - w));
    s
}

/// The scene's digest at each tick.
fn run(mut s: Scene) -> (Vec<u64>, Scene) {
    let mut out = Vec::with_capacity(TICKS);
    for _ in 0..TICKS {
        s.tick();
        out.push(s.digest());
    }
    (out, s)
}

#[test]
fn a1_every_tick_is_the_same_at_one_two_four_and_eight_threads() {
    for seed in 1..=8u64 {
        let (one, s) = run(scene(seed, 1, 3));
        let arrived = s
            .walkers
            .iter()
            .filter(|w| matches!(s.r.ended.get(w), Some((_, Progress::Done))))
            .count();
        println!(
            "seed {seed}: {} walkers, {} arrived in {} s, {} input records, {} ladder records",
            s.walkers.len(),
            arrived,
            TICKS as i64 * TICK / 1_000_000,
            s.r.controller.log().len(),
            s.l.log.len()
        );
        assert!(s.walkers.len() >= 30, "the scene has its crowds");
        assert!(arrived > 0, "walkers arrive");
        // The chunk's size changes nothing either.
        for (threads, chunk) in [(2, 3), (4, 3), (8, 3), (1, 64), (4, 1)] {
            let (got, _) = run(scene(seed, threads, chunk));
            let first = one.iter().zip(&got).position(|(a, b)| a != b);
            assert_eq!(
                first, None,
                "seed {seed}, {threads} threads, chunks of {chunk}: first differs at tick"
            );
        }
    }
}

/// N7's walk, panicking at its `at`-th step, or drawing there when `draw`.
struct Boom {
    walk: Box<skills::route::Route>,
    steps: u32,
    at: u32,
    draw: bool,
}

impl Skill for Boom {
    fn shape(&self) -> SkillShape {
        self.walk.shape()
    }
    fn step(&mut self, host: &mut dyn Host) -> Progress {
        self.steps += 1;
        if self.steps == self.at {
            if self.draw {
                host.draw();
            } else {
                panic!("boom at step {}", self.at);
            }
        }
        self.walk.step(host)
    }
    fn beside(&mut self) -> Option<&mut (dyn Skill + Send)> {
        Some(self)
    }
}

#[test]
fn a3_a_panic_in_one_chunk_ends_that_walk_by_name_and_every_other_goes_on() {
    for draw in [false, true] {
        let mut outcomes = Vec::new();
        for threads in [1, 4] {
            let mut s = scene(3, threads, 3);
            // Two walkers in the crossing crowd get a skill that fails at its 40th step, mid-chunk.
            for (who, at) in [(id(111), 40), (id(122), 41)] {
                let (node, goal) = (node_of(s.r.controller.body(who).unwrap()), {
                    let b = s.r.controller.body(who).unwrap();
                    Vec3::new(-b.pose.position.x, 0, -b.pose.position.z)
                });
                let legs =
                    s.t.plan(s.r.controller.body(who).unwrap(), node, goal)
                        .unwrap();
                let walk = common::route(&legs, SPEED, TICK);
                s.r.end_order(who);
                s.r.start(
                    who,
                    Box::new(Boom {
                        walk,
                        steps: 0,
                        at,
                        draw,
                    }),
                )
                .unwrap();
            }
            let (digests, s) = run(s);
            for who in [id(111), id(122)] {
                let (_, how) = s.r.ended.get(&who).expect("its run ended");
                assert_eq!(
                    *how,
                    Progress::Failed(replica::encode::Name::new(UNIT_PANICKED).unwrap())
                );
            }
            let named: Vec<String> =
                s.l.log
                    .iter()
                    .map(|r| format!("{r:?}"))
                    .filter(|r| r.contains(UNIT_PANICKED))
                    .collect();
            println!("{threads} threads, draw {draw}: {named:?}");
            assert_eq!(named.len(), 2, "each failed walker's order ended by name");
            let why = if draw { BESIDE_ORDERED } else { "boom at step" };
            assert!(named.iter().all(|r| r.contains(why)), "the message is kept");
            let arrived = s
                .walkers
                .iter()
                .filter(|w| matches!(s.r.ended.get(w), Some((_, Progress::Done))))
                .count();
            assert!(arrived > 20, "the others walk on and arrive: {arrived}");
            outcomes.push(digests);
        }
        assert_eq!(outcomes[0], outcomes[1], "the same at 1 and 4 threads");
    }
}
