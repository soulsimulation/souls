//! Narrow places taken in turns (Engine v2 N8, #2656) on N2's test world.
//!
//! `cargo test -p sim --release --test turns -- --nocapture` runs Step 0 (50 walkers each way on the building's 1.0 m
//! stair with no turns, ten seeded runs), the same swap with turns (A1 to A3, two seeds), the owner and the tick-late
//! read (A4) and a body staying on the stair (A5).

use import_eden::Import;
use replica::effects::{Header, schema_hash};
use replica::encode::{Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::world_model::show;
use sim::links::turns::{Facts, State, Turn, Turns};
use sim::links::{Doors, Kind};
use sim::mover::Body;
use sim::walk::Crowd;
use sim::walk::town::Town;
use std::collections::BTreeMap;

const SPEED: i64 = 1_400_000; // µm a second
const TICK: i64 = 50_000; // µs
const EACH_WAY: usize = 50;
const SLOW: i64 = 100_000; // µm a second: 0.1 m/s
const CLOSE: i64 = 420_000; // µm

fn id(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

fn town() -> (Town, BTreeMap<String, Id>) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/turns-test/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).unwrap()).unwrap();
    let next = tree.to_state().next;
    let ground = nodes["ground"];
    let t = Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town");
    (t, nodes)
}

fn stand(t: &Town, who: Id, node: Id, at: Vec3) -> Body {
    t.surfaces[&node]
        .place(who, Frame { node, slot: None }, at, Quat::IDENTITY)
        .unwrap_or_else(|e| panic!("{}: {}", e.name, e.detail))
}

/// SplitMix64: the seeded shuffle.
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

fn shuffle<T>(v: &mut [T], s: &mut Seed) {
    for i in (1..v.len()).rev() {
        let j = (s.next() % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
}

/// Standing spots in the stair hall (`floor`), on a 0.8 m lattice at least 1.8 m to either side of the stair's line
/// (z = 0), in the building's frame: the room's inner faces are x -7.9 to -2.1 m and z -5.9 to 5.9 m.
fn spots(t: &Town, floor: Id) -> Vec<Vec3> {
    let mut out = Vec::new();
    for i in 0..7i64 {
        for j in 0..14i64 {
            let (x, z) = (-7_500_000 + i * 800_000, -5_400_000 + j * 800_000);
            if z.abs() < 1_800_000 {
                continue;
            }
            let frame = Frame {
                node: floor,
                slot: None,
            };
            if let Ok(b) =
                t.surfaces[&floor].place(id(0), frame, Vec3::new(x, 0, z), Quat::IDENTITY)
            {
                out.push(b.pose.position);
            }
        }
    }
    out
}

fn dist(a: Vec3, b: Vec3) -> i64 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    (d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt() as i64
}

/// What a run of the swap measured.
struct Run {
    t: Town,
    c: Crowd,
    stair: Id,
    arrived: usize,
    ticks: u64,
    /// The slowest speed of a walker inside the stair over a tick, µm a second.
    slowest: i64,
    /// The longest a walker stayed slower than 0.1 m/s inside, µs.
    longest_slow: i64,
    /// Walker-ticks inside the stair, and of them the ones with another centre inside closer than 0.42 m.
    inside: u64,
    close: u64,
    /// When each walker first marked itself waiting (the end of that tick), µs.
    first_mark: BTreeMap<Id, i64>,
    /// The body staying on the stair, if any, and the nearest any walker inside came to it, µm.
    stayer: Option<(Id, Vec3)>,
    nearest_stayer: i64,
}

impl Run {
    fn state(&self) -> State {
        let l = self
            .t
            .buildings
            .iter()
            .find_map(|b| b.link(self.stair))
            .expect("the stair");
        self.t
            .turns
            .as_ref()
            .and_then(|x| x.state(l))
            .cloned()
            .unwrap_or_default()
    }

    fn line(&self, name: &str) -> String {
        format!(
            "{name}: {} of 100 arrived in {} ticks ({} s); slowest inside {} um/s, longest under 0.1 m/s {} ms; close \
             inside {} of {} walker-ticks ({}.{:02} %)",
            self.arrived,
            self.ticks,
            self.ticks as i64 * TICK / 1_000_000,
            self.slowest,
            self.longest_slow / 1000,
            self.close,
            self.inside,
            self.close * 100 / self.inside.max(1),
            self.close * 10_000 / self.inside.max(1) % 100
        )
    }
}

/// 50 walkers up and 50 down the building's 1.0 m stair, each to the spot one of the others starts from (a seeded
/// pairing). With `stay`, one more body stands still on the stair's middle by its own order (a scripted marker).
fn swap(seed: u64, turns: bool, stay: bool) -> Run {
    let (mut t, nodes) = town();
    if !turns {
        t.turns = None;
    }
    let (f0, f1) = (nodes["building/floor-0"], nodes["building/floor-1"]);
    let l = t
        .buildings
        .iter()
        .flat_map(|b| b.links.iter())
        .find(|l| l.kind == Kind::Stairs)
        .expect("the stair")
        .clone();
    let stair = l.id;
    let (mut down, mut up) = (spots(&t, f0), spots(&t, f1));
    assert!(
        down.len() >= EACH_WAY && up.len() >= EACH_WAY,
        "room for 50 each way"
    );
    let mut s = Seed(seed);
    shuffle(&mut down, &mut s);
    shuffle(&mut up, &mut s);
    let mut c = Crowd::new(TICK);
    for k in 0..EACH_WAY as u64 {
        let a = stand(&t, id(1 + k), f0, down[k as usize]);
        c.add(&mut t, a, SPEED, id(1001 + k), f1, up[k as usize])
            .unwrap_or_else(|e| panic!("no plan up: {}: {}", e.name, e.detail));
        let b = stand(&t, id(101 + k), f1, up[k as usize]);
        c.add(&mut t, b, SPEED, id(1101 + k), f0, down[k as usize])
            .unwrap_or_else(|e| panic!("no plan down: {}: {}", e.name, e.detail));
    }
    let stayer = stay.then(|| {
        // Its body, put on the stair's middle: a point of the link's line, in the floors' (the building's) frame.
        let mid = Vec3::new(
            (l.line[0].x + l.line[l.line.len() - 1].x) / 2,
            (l.line[0].y + l.line[l.line.len() - 1].y) / 2,
            (l.line[0].z + l.line[l.line.len() - 1].z) / 2,
        );
        let mut body = stand(&t, id(999), f0, down[EACH_WAY]);
        c.add(&mut t, body, SPEED, id(1999), f0, down[EACH_WAY])
            .expect("a plan");
        body.pose.position = mid;
        let w = c.walkers.iter_mut().find(|w| w.body.id == id(999)).unwrap();
        w.body = body;
        w.staying = true;
        (id(999), mid)
    });
    let mut r = Run {
        t,
        c,
        stair,
        arrived: 0,
        ticks: 0,
        slowest: i64::MAX,
        longest_slow: 0,
        inside: 0,
        close: 0,
        first_mark: BTreeMap::new(),
        stayer,
        nearest_stayer: i64::MAX,
    };
    let mut was: BTreeMap<Id, Vec3> = BTreeMap::new();
    let mut slow_since: BTreeMap<Id, i64> = BTreeMap::new();
    let movers = |c: &Crowd| {
        c.walkers
            .iter()
            .filter(|w| !w.staying)
            .all(|w| w.arrived.is_some())
    };
    for _ in 0..12_000 {
        if movers(&r.c) {
            break;
        }
        r.c.step(&mut r.t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
        r.ticks += 1;
        let now = r.c.now;
        for w in &r.c.walkers {
            if w.waiting.is_some() {
                r.first_mark.entry(w.body.id).or_insert(now);
            }
        }
        let inside: Vec<(Id, Vec3)> =
            r.c.walkers
                .iter()
                .filter(|w| w.crossing && w.legs[w.leg].link == Some(stair))
                .map(|w| (w.body.id, w.body.pose.position))
                .collect();
        for &(who, p) in &inside {
            r.inside += 1;
            if inside.iter().any(|&(o, q)| o != who && dist(p, q) < CLOSE) {
                r.close += 1;
            }
            if let Some((_, at)) = r.stayer {
                r.nearest_stayer = r.nearest_stayer.min(dist(p, at));
            }
            if let Some(&q) = was.get(&who) {
                let v = dist(p, q) * 1_000_000 / TICK;
                r.slowest = r.slowest.min(v);
                if v < SLOW {
                    let since = *slow_since.entry(who).or_insert(now - TICK);
                    r.longest_slow = r.longest_slow.max(now - since);
                } else {
                    slow_since.remove(&who);
                }
            }
        }
        was = inside.into_iter().collect();
        slow_since.retain(|k, _| was.contains_key(k));
    }
    r.arrived =
        r.c.walkers
            .iter()
            .filter(|w| !w.staying && w.arrived.is_some())
            .count();
    r
}

/// Step 0: the swap with N7 alone (no turns), ten seeded runs.
#[test]
#[ignore = "the Step 0 baseline: ten runs of 600 s, run in release with --ignored"]
fn step0_the_swap_with_n7_alone() {
    println!("Step 0: 50 walkers each way on the 1.0 m stair, no turns");
    for seed in 1..=10 {
        println!(
            "  {}",
            swap(seed, false, false).line(&format!("seed {seed}"))
        );
    }
}

/// A1 to A3: the same swap with turns, two seeds: every walker arrives, the direction changes while both sides wait,
/// and nobody inside is slower than 0.1 m/s for more than a second.
#[test]
fn a1_a2_a3_fifty_each_way_on_the_stair_in_turns() {
    for seed in 1..=2 {
        let r = swap(seed, true, false);
        println!("{}", r.line(&format!("turns, seed {seed}")));
        let mut times: Vec<i64> = r.c.walkers.iter().filter_map(|w| w.arrived).collect();
        times.sort();
        if !times.is_empty() {
            println!(
                "  arrivals: first {} ms, median {} ms, last {} ms",
                times[0] / 1000,
                times[times.len() / 2] / 1000,
                times[times.len() - 1] / 1000
            );
        }
        let st = r.state();
        let (mut both, mut grants, mut line) = (0, 0, String::new());
        for e in &st.timeline {
            match *e {
                Turn::Change { at, to, waiting } => {
                    if !line.is_empty() {
                        line.push_str(&format!(" ({grants} in)"));
                    }
                    grants = 0;
                    both += usize::from(waiting[0] > 0 && waiting[1] > 0);
                    line.push_str(&format!(
                        "\n    {:>6} ms {} ({} waiting below, {} above)",
                        at / 1000,
                        if to == 0 { "up  " } else { "down" },
                        waiting[0],
                        waiting[1]
                    ));
                }
                Turn::Grant { .. } => grants += 1,
            }
        }
        line.push_str(&format!(" ({grants} in)"));
        println!("  timeline, the direction let in:{line}");
        println!("  direction changes while both sides wait: {both}");
        assert_eq!(r.arrived, 100, "A1: all 100 arrive");
        assert!(
            both >= 2,
            "A2: the direction changes at least twice while both sides wait"
        );
        assert!(
            r.longest_slow <= 1_000_000,
            "A3: none slower than 0.1 m/s inside for over a second"
        );
    }
}

/// A4: only the link's owning node writes the turn state, and a walker's mark is read a tick later.
#[test]
fn a4_only_the_owner_writes_and_reads_a_mark_a_tick_later() {
    let r = swap(1, true, false);
    let l =
        r.t.buildings
            .iter()
            .find_map(|b| b.link(r.stair))
            .unwrap()
            .clone();
    // Every state lies under the stair's owning node.
    let turns = r.t.turns.as_ref().unwrap();
    for (owner, links) in &turns.owners {
        for k in links.keys() {
            let lk = r.t.buildings.iter().find_map(|b| b.link(*k)).unwrap();
            assert_eq!(*owner, lk.owner, "a state under its link's owner");
        }
    }
    // Any other node is refused by name.
    let mut other = Turns::new();
    let not_owner = l.nodes.iter().copied().find(|n| *n != l.owner).unwrap();
    let e = other
        .write(not_owner, &l, &Facts::default(), 0)
        .unwrap_err();
    println!(
        "A4: a write by {} is refused: {}: {}",
        show(not_owner),
        e.name,
        e.detail
    );
    assert_eq!(e.name, "turn-not-owner");
    assert!(other.owners.is_empty(), "nothing written");
    // Each grant comes at least a tick after the walker first marked itself waiting.
    let st = r.state();
    let mut gaps = Vec::new();
    for e in &st.timeline {
        if let Turn::Grant { at, who, .. } = *e {
            let marked = r.first_mark[&who];
            assert!(at >= marked + TICK, "a grant reads the mark a tick later");
            gaps.push(at - marked);
        }
    }
    gaps.sort();
    println!(
        "A4: {} grants, each at least one tick after the walker's first mark (shortest {} ms, median {} ms)",
        gaps.len(),
        gaps[0] / 1000,
        gaps[gaps.len() / 2] / 1000
    );
}

/// A5: a body staying on the stair by its own order is left out of the turn state, and the walkers pass it.
#[test]
fn a5_a_body_staying_on_the_stair_is_left_out_and_passed() {
    let r = swap(1, true, true);
    let (who, at) = r.stayer.unwrap();
    println!("{}", r.line("A5, a body staying on the stair's middle"));
    let st = r.state();
    let named = st
        .timeline
        .iter()
        .any(|e| matches!(*e, Turn::Grant { who: g, .. } if g == who));
    let w = r.c.walkers.iter().find(|w| w.body.id == who).unwrap();
    println!(
        "A5: the staying body stood at ({}, {}, {}) mm throughout: never granted ({named}), never marked waiting \
         ({}); the nearest a walker inside came to it {} mm; {} direction changes",
        at.x / 1000,
        at.y / 1000,
        at.z / 1000,
        r.first_mark.contains_key(&who),
        r.nearest_stayer / 1000,
        st.timeline
            .iter()
            .filter(|e| matches!(e, Turn::Change { .. }))
            .count()
    );
    assert_eq!(r.arrived, 100, "the walkers pass it");
    assert!(!named && !r.first_mark.contains_key(&who));
    assert_eq!(w.body.pose.position, at, "it stays");
}
