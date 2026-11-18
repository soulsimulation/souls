//! The `subscription` bench (Engine v2 R4, #2698): one hall of 60 by 60 m with 1,000 moving bodies, ticking at 20 a
//! second of world time, each body sending a motion sample once a world second (50 a tick, staggered), and the
//! subscription hub reading the parts. Every subscriber follows its own body. Arms, each repeat on its own seed:
//!
//! - `light`: one subscriber (body 0), 8,000 B/s.
//! - `8k`: 1,000 subscribers, 8,000 B/s.
//! - `4k`: 1,000 subscribers, 4,000 B/s, each sent a receipt every world second and an utterance every two.
//!
//! Measures, declared on #2698 before the first run:
//!
//! - A1 (`8k`): every entry of the interest set read at `full` is sent on its tick (due = on tick), and every
//!   subscriber gets the hall's counts by cell every world second.
//! - A2: no subscriber is sent more than its budget in any world second, by the stream's own bytes, both arms.
//! - A3 (`4k`): the level drops and the drop is named (`souls:over-budget`) in the stream; every addressed event
//!   arrives.
//! - A4: body 0's interest set, tick by tick, is the same in `light`, `8k` and `4k`.
//! - The tier's cost: the hub's time a tick with 1,000 subscribers, mean and 99th percentile (reported; no bar).
//!
//! Run from `v2/`: `cargo run -p bench --release --bin subscription -- [ticks] [repeats]` (1,200, 2).

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash as _, Hasher};
use std::time::Instant;

use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::views::Level;
use replica::world_model::Audience;
use worldd::views::subscription::{Hub, Kind, Request, Scope};

const BODY: &str =
    "souls:body@1220ee1ad75a34f067112ef6d2a095fe5bd3e121a75611a1a95ba85198efcb131cb2";
const BODIES: u64 = 1_000;
const SIDE: i64 = 60_000_000;
const TICK_US: i64 = 50_000;
const TICKS_A_SECOND: u64 = 20;

fn id(n: u64) -> Id {
    Id::new(IdScope([9; 16]), n).expect("an id")
}

/// A fixed linear congruential generator: the same walk on every machine.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo) as u64) as i64
    }
}

fn pose(room: Id, p: [i64; 2]) -> Pose {
    Pose {
        frame: Frame {
            node: room,
            slot: None,
        },
        position: Vec3::new(p[0], 0, p[1]),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: room,
            height: 0,
        },
    }
}

/// The hall as the clock thread writes it: positions and velocities, µm and µm a second.
struct World {
    hall: Id,
    seq: u64,
    tick: u64,
    at: [Vec<[i64; 2]>; 2],
}

impl World {
    fn new(seed: u64) -> World {
        let mut r = Lcg(seed);
        let mut at = Vec::new();
        let mut v = Vec::new();
        for _ in 0..BODIES {
            at.push([r.range(0, SIDE), r.range(0, SIDE)]);
            v.push([
                r.range(-1_400_000, 1_400_000),
                r.range(-1_400_000, 1_400_000),
            ]);
        }
        World {
            hall: id(1),
            seq: 0,
            tick: 0,
            at: [at, v],
        }
    }

    fn entry(&mut self, node: Id, change: Change) -> Effect {
        self.seq += 1;
        Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.tick as i64 * TICK_US,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node,
            },
            body: Body::Changes(vec![ChangeRec {
                change,
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        }
    }

    fn part(&self, effects: &[Effect]) -> Part {
        let v = Value::Map(
            [
                (
                    1,
                    Value::Bytes(Hash::of(Purpose::Fixture, b"subscription").to_bytes()),
                ),
                (
                    2,
                    Value::Array(effects.iter().map(Effect::to_value).collect()),
                ),
            ]
            .into(),
        );
        Part::read(&encode(&v).expect("bytes")).expect("a part")
    }

    /// The bodies, created where they start. One part.
    fn create(&mut self) -> Part {
        let hall = self.hall;
        let es: Vec<Effect> = (0..BODIES)
            .map(|b| {
                let c = Change::Create {
                    node: id(100 + b),
                    kind: Name::new(BODY).expect("a name"),
                    pose: pose(hall, self.at[0][b as usize]),
                    audience: Audience::Everyone,
                    fields: BTreeMap::new(),
                };
                self.entry(hall, c)
            })
            .collect();
        let p = self.part(&es);
        self.tick += 1;
        p
    }

    /// One tick: every body moves; a twentieth of them send a sample. One part.
    fn step(&mut self) -> Part {
        let dt = TICK_US;
        for b in 0..BODIES as usize {
            for k in 0..2 {
                let mut x = self.at[0][b][k] + self.at[1][b][k] * dt / 1_000_000;
                if !(0..SIDE).contains(&x) {
                    self.at[1][b][k] = -self.at[1][b][k];
                    x = x.clamp(0, SIDE - 1);
                }
                self.at[0][b][k] = x;
            }
        }
        let (hall, turn) = (self.hall, self.tick % TICKS_A_SECOND);
        let es: Vec<Effect> = (0..BODIES)
            .filter(|b| b % TICKS_A_SECOND == turn)
            .map(|b| {
                let (p, v) = (self.at[0][b as usize], self.at[1][b as usize]);
                let h = HandOff {
                    node: id(100 + b),
                    at: self.tick as i64 * TICK_US,
                    from: Owner::Mover,
                    to: Owner::Mover,
                    pose: pose(hall, p),
                    linear: Vec3::new(v[0], 0, v[1]),
                    angular: Vec3::ZERO,
                };
                self.entry(id(100 + b), Change::Motion(h))
            })
            .collect();
        let p = self.part(&es);
        self.tick += 1;
        p
    }
}

struct Arm {
    name: &'static str,
    subscribers: u64,
    budget: u64,
    addressed: bool,
}

#[derive(Default)]
struct Result {
    tick_us: Vec<f64>,
    /// Body 0's set, a hash a tick.
    set0: Vec<u64>,
    most: u64,
    mean_bps: f64,
    due: u64,
    on_tick: u64,
    cells_short: u64,
    named_drop: u64,
    lowered_now: u64,
    addressed_in: u64,
    addressed_out: u64,
    gaps: u64,
    levels: BTreeMap<&'static str, u64>,
}

fn run(arm: &Arm, ticks: u64, seed: u64) -> Result {
    let mut w = World::new(seed);
    let mut hub = Hub::new();
    hub.tick(&w.create()).expect("a tick");
    let subs: Vec<usize> = (0..arm.subscribers)
        .map(|b| {
            hub.subscribe(Request {
                scopes: vec![Scope::Follow(id(100 + b))],
                level: Level::Full,
                budget: arm.budget,
            })
            .expect("subscribed")
        })
        .collect();
    let mut res = Result::default();
    // Bytes a subscriber was sent in each world second, by the stream, and the seconds it got counts by cell.
    let mut per_second: Vec<BTreeMap<i64, u64>> = vec![BTreeMap::new(); subs.len()];
    let mut cells: Vec<BTreeSet<i64>> = vec![BTreeSet::new(); subs.len()];
    for _ in 0..ticks {
        let second = (w.tick as i64 * TICK_US).div_euclid(1_000_000);
        if arm.addressed && w.tick.is_multiple_of(TICKS_A_SECOND) {
            for &s in &subs {
                hub.address(s, format!("receipt {}", w.tick).as_bytes())
                    .expect("addressed");
                if second % 2 == 0 {
                    hub.address(s, b"utterance: meet me by the north door")
                        .expect("addressed");
                }
            }
        }
        let part = w.step();
        let t = Instant::now();
        hub.tick(&part).expect("a tick");
        res.tick_us.push(t.elapsed().as_secs_f64() * 1e6);
        let mut h = DefaultHasher::new();
        hub.interest(subs[0]).expect("a set").hash(&mut h);
        res.set0.push(h.finish());
        for (i, &s) in subs.iter().enumerate() {
            for o in hub.drain(s) {
                *per_second[i].entry(second).or_default() += o.bytes.len() as u64;
                match o.kind {
                    Kind::Cells => {
                        cells[i].insert(second);
                    }
                    Kind::Grant => {
                        let v = decode(&o.bytes).expect("an item");
                        if format!("{v:?}").contains("souls:over-budget") {
                            res.named_drop += 1;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let seconds = (ticks / TICKS_A_SECOND).max(1);
    let mut total = 0u64;
    for (i, &s) in subs.iter().enumerate() {
        let st = hub.stats(s).expect("stats");
        res.most = res
            .most
            .max(per_second[i].values().copied().max().unwrap_or(0));
        total += per_second[i].values().sum::<u64>();
        res.due += st.due;
        res.on_tick += st.on_tick;
        res.addressed_in += st.addressed_in;
        res.addressed_out += st.addressed_out;
        res.gaps += st.gaps;
        let g = hub.granted(s).expect("a grant");
        if g.level != g.asked {
            res.lowered_now += 1;
        }
        *res.levels.entry(g.level.name()).or_default() += 1;
        // Every whole second after the first: counts by cell (at `full`, `sampled` and `outline`).
        if g.level != Level::Counts {
            res.cells_short += (1..seconds as i64)
                .filter(|sec| !cells[i].contains(sec))
                .count() as u64;
        }
    }
    res.mean_bps = total as f64 / (subs.len() as u64 * seconds) as f64;
    res
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len().max(1) as f64
}

fn pct(v: &[f64], q: f64) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    s[((s.len() as f64 * q) as usize).min(s.len() - 1)]
}

fn ok(b: bool) -> &'static str {
    if b { "met" } else { "NOT met" }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let ticks: u64 = args.get(1).map_or(1_200, |a| a.parse().expect("ticks"));
    let repeats: u64 = args.get(2).map_or(2, |a| a.parse().expect("repeats"));
    let arms = [
        Arm {
            name: "light",
            subscribers: 1,
            budget: 8_000,
            addressed: false,
        },
        Arm {
            name: "8k",
            subscribers: BODIES,
            budget: 8_000,
            addressed: false,
        },
        Arm {
            name: "4k",
            subscribers: BODIES,
            budget: 4_000,
            addressed: true,
        },
    ];
    println!(
        "subscription bench: {BODIES} bodies in a 60 m hall, {ticks} ticks ({} world s), {repeats} repeats",
        ticks / TICKS_A_SECOND
    );
    println!();
    println!(
        "| repeat | arm | subs | budget B/s | most B in a second | mean B/s | due | on tick | seconds without cells | over-budget named | lowered at end | levels at end | addressed in / out | gaps | hub µs/tick mean | p99 |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    let mut pass = true;
    for r in 1..=repeats {
        let res: Vec<Result> = arms.iter().map(|a| run(a, ticks, r)).collect();
        for (a, x) in arms.iter().zip(&res) {
            println!(
                "| {r} | {} | {} | {} | {} | {:.0} | {} | {} | {} | {} | {} | {:?} | {} / {} | {} | {:.0} | {:.0} |",
                a.name,
                a.subscribers,
                a.budget,
                x.most,
                x.mean_bps,
                x.due,
                x.on_tick,
                x.cells_short,
                x.named_drop,
                x.lowered_now,
                x.levels,
                x.addressed_in,
                x.addressed_out,
                x.gaps,
                mean(&x.tick_us),
                pct(&x.tick_us, 0.99)
            );
        }
        let (light, k8, k4) = (&res[0], &res[1], &res[2]);
        let a1 = k8.due > 0 && k8.due == k8.on_tick && k8.cells_short == 0;
        let a2 = res.iter().zip(&arms).all(|(x, a)| x.most <= a.budget);
        let a3 = k4.named_drop > 0 && k4.addressed_in == k4.addressed_out;
        let a4 = light.set0 == k8.set0 && light.set0 == k4.set0;
        println!();
        println!(
            "repeat {r}: A1 {}, A2 {}, A3 {}, A4 {}",
            ok(a1),
            ok(a2),
            ok(a3),
            ok(a4)
        );
        println!();
        pass &= a1 && a2 && a3 && a4;
    }
    println!(
        "{}",
        if pass {
            "all measures met"
        } else {
            "a measure was NOT met"
        }
    );
}
