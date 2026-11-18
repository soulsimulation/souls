//! Ground rebuilt where the edit was (Engine v2 G3, #2760) on N2's test world.
//!
//! `cargo test -p sim --release --test rebuild -- --nocapture` runs both arms (the 5 ms bar is held in release only), two repeats each. 100 walkers: 93 start
//! on the square (54 bound for the hall, three of them for a spot the edit fills, 39 for the far side of the square),
//! four walk the hall from back to front, three stand where the edit puts a wall. Three seconds in, a creator's edit
//! grows one of the hall's boxes into a wall 8 m long across the hall; its ground is cut off the clock thread while
//! the clock goes on ticking, and installed on the tick the edit commits. The even arm starts the 93 on a lattice over
//! the whole square; the uneven arm, declared here before the run, starts 70 of them in the square's north-west
//! quarter and 23 over the rest.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

use import_eden::{F_SOLIDS, Import};
use replica::effects::{
    Actor, Body as EffectBody, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest,
};
use replica::encode::{Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::time::Micros;
use replica::world_model::{Audience, show};
use sim::ground::exits::piece_of;
use sim::ground::{HUMAN_RADIUS, Scene, Turn, cut_floor};
use sim::links::Doors;
use sim::mover::Body;
use sim::unstick::{Ladder, Rung};
use sim::walk::town::Town;
use sim::walk::{Crowd, node_of};
use std::collections::{BTreeMap, BTreeSet};

const SPEED: i64 = 1_400_000; // µm a second
const TICK: Micros = 50_000; // µs: 20 ticks a second
const EDIT_AT: u64 = 60; // ticks: the edit is checked three seconds in
/// The box the edit grows (in the hall's room, at (-876, -13797) mm of the hall's frame, turned by whole degrees) and
/// the wall it becomes: half lengths 4 m by 0.5 m, 1.5 m tall, turned back square to the hall's axes.
const BOX: &str = "box-00033";
const WALL: [u64; 9] = [0, 0, 4_000, 500, 0, 0, 1_500, 5, 0];
const M: i64 = 1_000_000;

fn id(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

fn town() -> (Town, BTreeMap<String, Id>) {
    let w = testworld::generate(1, 200).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/rebuild-test/1").to_bytes()),
        ),
        (2, Value::Bytes(replica::effects::schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = replica::effects::Header::read(&encode(&v).unwrap()).unwrap();
    let next = tree.to_state().next;
    let ground = nodes["ground"];
    let t = Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town");
    (t, nodes)
}

/// The edit as it commits: one effect setting the box's solids to the wall, by the creator, numbered from the zone's
/// next sequence.
fn edit(t: &Town, node: Id, at: Micros) -> Part {
    let turn = t
        .tree
        .node(t.tree.handle(node).unwrap())
        .unwrap()
        .place()
        .unwrap()
        .orientation;
    let deg = (0..360)
        .find(|d| Quat::from_yaw_mdeg(d * 1_000).ok() == Some(turn))
        .expect("the box is turned by whole degrees") as u64;
    let mut wall = WALL;
    wall[4] = (360 - deg) % 360 * 1_000;
    let e = Effect {
        envelope: Envelope {
            sequence: t.doors.next,
            at,
            cause: Cause::Intent(id(9_000)),
            actor: Actor::Creator(id(9_001)),
            audience: Audience::Everyone,
            node,
        },
        body: EffectBody::Changes(vec![ChangeRec {
            change: Change::Set {
                node,
                field: F_SOLIDS,
                to: Value::Array(vec![Value::Array(
                    wall.iter().map(|&v| Value::Uint(v)).collect(),
                )]),
                by: None,
            },
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    };
    let bytes = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(t.doors.header.hash().to_bytes())),
        (2, Value::Array(vec![e.to_value()])),
    ])))
    .unwrap();
    Part::read(&bytes).unwrap()
}

/// A body standing at or near `at` on `node` (nudged off a small box when one stands there).
fn stand(t: &Town, who: Id, node: Id, at: [i64; 2]) -> Option<Body> {
    let s = &t.surfaces[&node];
    [
        [0, 0],
        [600_000, 0],
        [0, 600_000],
        [-600_000, 0],
        [0, -600_000],
    ]
    .iter()
    .find_map(|d| {
        s.place(
            who,
            Frame { node, slot: None },
            Vec3::new(at[0] + d[0], 0, at[1] + d[1]),
            Quat::IDENTITY,
        )
        .ok()
    })
}

/// A goal at or near `g` on `node` that a body may stand at.
fn goal_near(t: &Town, node: Id, g: [i64; 2]) -> [i64; 2] {
    [
        [0, 0],
        [700_000, 0],
        [0, 700_000],
        [-700_000, 0],
        [0, -700_000],
    ]
    .iter()
    .map(|d| [g[0] + d[0], g[1] + d[1]])
    .find(|g| t.map.spot(node, Vec3::new(g[0], 0, g[1])).is_some())
    .unwrap_or_else(|| panic!("no goal near {g:?}"))
}

/// The 93 starts on the square, µm: even over the whole square, or 70 in its north-west quarter and 23 elsewhere.
fn starts(uneven: bool) -> Vec<[i64; 2]> {
    let grid = |x0: i64, x1: i64, z0: i64, z1: i64, nx: i64, nz: i64| {
        let mut v = Vec::new();
        for i in 0..nx {
            for j in 0..nz {
                v.push([
                    x0 + (x1 - x0) * (2 * i + 1) / (2 * nx),
                    z0 + (z1 - z0) * (2 * j + 1) / (2 * nz),
                ]);
            }
        }
        v
    };
    let mut v = if uneven {
        let mut v = grid(-27 * M, -3 * M, 3 * M, 27 * M, 10, 7);
        v.extend(
            grid(-27 * M, 27 * M, -27 * M, 3 * M, 6, 4)
                .into_iter()
                .take(23),
        );
        v
    } else {
        grid(-27 * M, 27 * M, -27 * M, 27 * M, 10, 10)
    };
    v.truncate(93);
    v
}

struct Numbers {
    stale: usize,
    extra: usize,
    max_delay: Micros,
    ended: BTreeMap<&'static str, usize>,
    samples: u64,
    off: u64,
    walked_out: usize,
    cut_max_us: u128,
    touched: Vec<String>,
    rebuild_us: u128,
    ticks_during: u64,
    install_us: u128,
}

fn arm(uneven: bool) -> Numbers {
    let (mut t, nodes) = town();
    let (ground, hall) = (t.ground, nodes["hall/floor-0"]);
    let mut c = Crowd::new(TICK);
    let mut ladder = Ladder::new();
    let mut n = 0u64;
    let mut add = |t: &mut Town,
                   c: &mut Crowd,
                   l: &mut Ladder,
                   node: Id,
                   at: [i64; 2],
                   gn: Id,
                   g: [i64; 2]| {
        n += 1;
        let who = id(n);
        let body = stand(t, who, node, at).unwrap_or_else(|| panic!("no standing room at {at:?}"));
        l.add(
            c,
            t,
            body,
            SPEED,
            id(1_000 + n),
            gn,
            Vec3::new(g[0], 0, g[1]),
        )
        .unwrap_or_else(|e| panic!("no plan for {}: {}: {}", show(who), e.name, e.detail));
        who
    };
    // Goals in the hall (its floor's frame): a lattice clear of the front, the wall's line and the boxes.
    let hall_goals: Vec<[i64; 2]> = (0..54)
        .map(|k| {
            goal_near(
                &t,
                hall,
                [-12 * M + (k % 9) * 3 * M, -6 * M + (k / 9) * 4 * M],
            )
        })
        .collect();
    // Three goals the wall fills, on the ground today.
    let gone = [
        [-3_500_000, -13_800_000],
        [-2_000_000, -13_800_000],
        [2_000_000, -13_800_000],
    ];
    let mut bound_gone = BTreeSet::new();
    for (k, s) in starts(uneven).into_iter().enumerate() {
        if k < 54 {
            let g = if k < 3 { gone[k] } else { hall_goals[k] };
            let who = add(&mut t, &mut c, &mut ladder, ground, s, hall, g);
            if k < 3 {
                bound_gone.insert(who);
            }
        } else {
            let g = goal_near(&t, ground, [-s[0], -s[1]]);
            add(&mut t, &mut c, &mut ladder, ground, s, ground, g);
        }
    }
    // Four walking the hall from back to front, across the wall's line.
    for k in 0..4 {
        let x = -6 * M + k * 4 * M;
        let g = goal_near(&t, hall, [x, -17 * M]);
        add(&mut t, &mut c, &mut ladder, hall, [x, 16 * M], hall, g);
    }
    // Three standing where the wall goes: their walks end where they stand.
    let mut standers = BTreeSet::new();
    for x in [-3_000_000, 1_500_000, 2_600_000] {
        let at = goal_near(&t, hall, [x, -13_800_000]);
        standers.insert(add(&mut t, &mut c, &mut ladder, hall, at, hall, at));
    }
    assert_eq!(c.walkers.len(), 100);
    let step = |t: &mut Town, c: &mut Crowd, l: &mut Ladder| {
        l.step(c, t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
    };
    for _ in 0..EDIT_AT {
        step(&mut t, &mut c, &mut ladder);
    }

    // The edit: its ground cut off the clock thread from a copy, while the clock goes on.
    let part = edit(&t, nodes[BOX], c.now);
    let (base, header, versions) = (t.tree.frozen(), t.doors.header.clone(), t.versions.clone());
    let t0 = std::time::Instant::now();
    let (rebuilt, rebuild_us, ticks_during) = std::thread::scope(|s| {
        let job = s.spawn(|| {
            let r = Town::rebuild(base, &header, ground, &versions, &part);
            (r, t0.elapsed().as_micros())
        });
        let mut ticks = 0;
        while !job.is_finished() {
            step(&mut t, &mut c, &mut ladder);
            ticks += 1;
        }
        let (r, us) = job.join().unwrap();
        (r.expect("the rebuild"), us, ticks)
    });
    // The commit tick: the part and its ground in one call, before the crowd's tick.
    let touched: BTreeSet<Id> = rebuilt.touched.clone();
    let t1 = std::time::Instant::now();
    t.install(rebuilt, &part)
        .unwrap_or_else(|e| panic!("install refused: {}: {}", e.name, e.detail));
    let install_us = t1.elapsed().as_micros();
    let commit_at = c.now;
    let stale: BTreeSet<Id> = c
        .walkers
        .iter()
        .filter(|w| w.arrived.is_none() && w.held.is_none())
        .filter(|w| w.ground.iter().any(|(n, _)| touched.contains(n)))
        .map(|w| w.body.id)
        .collect();

    // A3: each touched node's ground cut again from the tree as committed.
    let mut cut_max_us = 0;
    for &n in &touched {
        let t2 = std::time::Instant::now();
        let p = cut_floor(&Scene::of(&t.tree, n).unwrap(), HUMAN_RADIUS, Turn::NONE).unwrap();
        cut_max_us = cut_max_us.max(t2.elapsed().as_micros());
        assert!(!p.pieces.is_empty());
    }

    // After the commit: every motion sample on the current ground; bodies found off it stand until walked out.
    let (mut samples, mut off) = (0u64, 0u64);
    let mut flagged: BTreeMap<Id, Vec3> = BTreeMap::new();
    // Ten seconds of world time after the commit: five times the re-plan bar.
    for _ in 0..200 {
        if ladder.done(&c) {
            break;
        }
        step(&mut t, &mut c, &mut ladder);
        for w in &c.walkers {
            if w.off_ground && w.held.is_none() {
                let at = *flagged.entry(w.body.id).or_insert(w.body.pose.position);
                assert_eq!(
                    at, w.body.pose.position,
                    "a body off the ground is never moved by the walk skill"
                );
                continue;
            }
            if w.crossing || w.held == Some("walk-out") || w.off_ground {
                continue;
            }
            samples += 1;
            let node = node_of(&w.body);
            if piece_of(t.surfaces[&node].pieces(), w.body.pose.position).is_none() {
                off += 1;
                println!(
                    "  off the ground: {} at {:?} on {}",
                    show(w.body.id),
                    w.body.pose.position,
                    show(node)
                );
            }
        }
        // The last rung (N10): the flagged ones walk out to the nearest legal point, by name.
        let out: Vec<Id> = c
            .walkers
            .iter()
            .filter(|w| w.off_ground && w.held.is_none())
            .map(|w| w.body.id)
            .collect();
        for who in out {
            ladder
                .walk_out(&mut c, &t, who)
                .unwrap_or_else(|e| panic!("walk-out refused: {}: {}", e.name, e.detail));
        }
    }

    // A1: each stale walk planned again (or ended by name) within 2 s of the commit.
    let mut max_delay = 0;
    let mut ended: BTreeMap<&'static str, usize> = BTreeMap::new();
    for who in &stale {
        let (_, at, why) = c
            .replans
            .iter()
            .find(|(w, at, _)| w == who && *at >= commit_at)
            .unwrap_or_else(|| panic!("{} was never planned again", show(*who)));
        max_delay = max_delay.max(at - commit_at);
        if let Some(name) = why {
            *ended.entry(*name).or_default() += 1;
        }
    }
    let extra = c.replans.iter().filter(|r| !stale.contains(&r.0)).count();
    let gone_ended: BTreeSet<Id> = c
        .replans
        .iter()
        .filter(|r| r.2 == Some("destination-gone"))
        .map(|r| r.0)
        .collect();
    assert_eq!(
        gone_ended, bound_gone,
        "the walks to the filled spots end by name"
    );
    let walked_out: BTreeSet<Id> = ladder
        .log
        .iter()
        .filter(|r| matches!(r.rung, Rung::WalkedOut { .. }))
        .map(|r| r.who)
        .collect();
    assert_eq!(
        walked_out, standers,
        "the bodies the wall stands on are walked out"
    );
    Numbers {
        stale: stale.len(),
        extra,
        max_delay,
        ended,
        samples,
        off,
        walked_out: walked_out.len(),
        cut_max_us,
        touched: touched.iter().map(|n| show(*n)).collect(),
        rebuild_us,
        ticks_during,
        install_us,
    }
}

/// A1–A5: both arms, two repeats each.
#[test]
fn a1_to_a5_ground_rebuilt_where_the_edit_was() {
    for (name, uneven) in [("even", false), ("uneven", true)] {
        for repeat in 1..=2 {
            let n = arm(uneven);
            println!(
                "G3 {name} arm, repeat {repeat}: touched {:?}; rebuilt off the clock in {} us while the clock stepped {} ticks; installed in {} us",
                n.touched, n.rebuild_us, n.ticks_during, n.install_us
            );
            println!(
                "  A1: {} walks planned on the changed ground, each planned again within {} ms of the commit (ended by name: {:?}); {} other walks planned again",
                n.stale,
                n.max_delay / 1000,
                n.ended,
                n.extra
            );
            println!(
                "  A2: {} motion samples after the commit, {} off the current ground; A5: {} bodies walked out",
                n.samples, n.off, n.walked_out
            );
            println!("  A3: slowest touched node cut in {} us", n.cut_max_us);
            assert!(n.stale > 0);
            assert_eq!(
                n.extra, 0,
                "only the walks on changed ground are planned again"
            );
            assert!(n.max_delay <= 2_000_000, "A1: within 2 s");
            assert_eq!(n.off, 0, "A2: no sample off the current ground");
            // The bar is the release build's (the debug build in `ci.sh` runs about ten times slower).
            if !cfg!(debug_assertions) {
                assert!(n.cut_max_us < 5_000, "A3: under 5 ms");
            }
        }
    }
}
