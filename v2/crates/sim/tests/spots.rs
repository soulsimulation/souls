//! Standing spots, approach, and a crowd around a point (Engine v2 N9, #2678) on N2's test world.
//!
//! `cargo test -p sim --release --test spots -- --nocapture`. The walkers run N7's walk skill through the host; a
//! walker sent to a point is `skills::route::Route::sent`, given its route once its spot is granted (T9c #3127).

mod common;

use common::{arrived, id, send, stand, walk};
use import_eden::Import;
use replica::effects::{Actor, Cause};
use replica::host::Progress;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::world_model::show;
use sim::host::Runner;
use sim::links::Kind;
use sim::spots::{CLEAR, Entry, Target, to_segment};
use sim::walk::town::{Town, level_part};
use std::collections::BTreeMap;

const SPEED: i64 = 1_400_000; // µm a second: today's walking pace
const TICK: i64 = 50_000; // µs: 20 ticks a second

fn town() -> (Town, BTreeMap<String, Id>) {
    common::town(b"souls/spots-test/1")
}

fn town_of(im: Import) -> (Town, BTreeMap<String, Id>) {
    common::town_of(im, b"souls/spots-test/1")
}

fn flat(a: Vec3, b: Vec3) -> i64 {
    (i128::from(a.x - b.x).pow(2) + i128::from(a.z - b.z).pow(2)).isqrt() as i64
}

/// Where the `k`-th of thirty walkers starts: round a square 24 m on a side about `c`, 3.2 m apart.
fn start(c: Vec3, k: i64) -> Vec3 {
    let s = k * 3_200_000; // along the perimeter
    let (side, a) = (s / 24_000_000, s % 24_000_000 - 12_000_000);
    let (x, z) = match side {
        0 => (a, -12_000_000),
        1 => (12_000_000, a),
        2 => (-a, 12_000_000),
        _ => (-12_000_000, -a),
    };
    Vec3::new(c.x + x, 0, c.z + z)
}

/// The closest two centres of the crowd, µm.
fn closest(c: &Runner) -> i64 {
    let mut best = i64::MAX;
    let bodies: Vec<_> = c.controller.bodies().collect();
    for (i, a) in bodies.iter().enumerate() {
        for b in &bodies[i + 1..] {
            best = best.min(flat(a.pose.position, b.pose.position));
        }
    }
    best
}

/// When each body's walk arrived, in id order.
fn arrivals(c: &Runner) -> Vec<Option<i64>> {
    c.controller.bodies().map(|b| arrived(c, b.id)).collect()
}

/// Step 0: thirty walkers sent to one point with N7 alone.
#[test]
fn step0_thirty_walkers_to_one_point_with_the_walk_alone() {
    let (mut t, _) = town();
    let ground = t.ground;
    let target = Vec3::new(0, 0, 0);
    let mut c = Runner::new(TICK);
    for k in 0..30 {
        let b = stand(&t, id(k as u64 + 1), ground, start(target, k));
        walk(&mut c, &mut t, b, SPEED, ground, target)
            .unwrap_or_else(|e| panic!("no plan: {}: {}", e.name, e.detail));
    }
    for _ in 0..400 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(&mut t).unwrap();
    }
    let arrived = arrivals(&c).iter().flatten().count();
    let last = arrivals(&c).into_iter().flatten().max();
    println!(
        "step 0: {arrived} of 30 standing after {} ms; last stopped at {:?} ms; closest pair {} mm",
        c.now / 1000,
        last.map(|l| l / 1000),
        closest(&c) / 1000
    );
}

/// Thirty walkers sent to `target` on the open ground by standing spots, for at most 20 s of world time.
fn ring(target: Vec3) -> (Town, Runner) {
    let (mut t, _) = town();
    let ground = t.ground;
    let mut c = Runner::new(TICK);
    for k in 0..30 {
        let b = stand(&t, id(k as u64 + 1), ground, start(target, k));
        send(
            &mut c,
            b,
            SPEED,
            Target::new(ground, target),
            id(1000 + k as u64),
        )
        .unwrap();
    }
    for _ in 0..400 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(&mut t).unwrap();
    }
    (t, c)
}

/// A1 and A4: thirty walkers sent to one point form a ring; two runs give the same spots, each the engine's choice.
#[test]
fn a1_a4_thirty_walkers_sent_to_one_point_form_a_ring() {
    let target = Vec3::new(0, 0, 0);
    let (t, c) = ring(target);
    let arrived = arrivals(&c).iter().flatten().count();
    let last = arrivals(&c).into_iter().flatten().max();
    let near = closest(&c);
    println!(
        "A1: {arrived} of 30 standing; last stopped at {:?} ms; closest pair {} mm",
        last.map(|l| l / 1000),
        near / 1000
    );
    for w in c.controller.bodies() {
        let p = w.pose.position;
        let s = start(target, (w.id.counter() - 1) as i64);
        println!(
            "  {} from ({}, {}) to ({}, {}) mm, {} mm from the target, stopped at {:?} ms",
            show(w.id),
            s.x / 1000,
            s.z / 1000,
            p.x / 1000,
            p.z / 1000,
            flat(p, target) / 1000,
            common::arrived(&c, w.id).map(|a| a / 1000)
        );
    }
    picture(&c, target);
    assert_eq!(arrived, 30, "A1: all standing");
    assert!(last.unwrap() <= 20_000_000, "A1: within 20 s");
    assert!(near >= 560_000, "A1: no two centres closer than 0.56 m");
    // A4: every choice is the engine's, for the walker's order.
    let grants: Vec<&Entry> = t
        .spots
        .record
        .iter()
        .filter(|e| matches!(e, Entry::Grant { .. }))
        .collect();
    assert_eq!(grants.len(), 30);
    for e in &grants {
        let Entry::Grant {
            who, cause, actor, ..
        } = e
        else {
            unreachable!()
        };
        let order = c.asks[who].1;
        assert_eq!(*actor, Actor::World);
        assert_eq!(*cause, Cause::Intent(order));
    }
    let (t2, c2) = ring(target);
    assert_eq!(
        t.spots.record, t2.spots.record,
        "A4: two runs, the same spots"
    );
    let at = |c: &Runner| -> Vec<Vec3> { c.controller.bodies().map(|w| w.pose.position).collect() };
    assert_eq!(at(&c), at(&c2));
    println!(
        "A4: two runs give the same {} grants and the same standing places",
        grants.len()
    );
}

/// Writes the ring as an SVG under the workspace's ignored `.local/` (the proof's picture).
fn picture(c: &Runner, target: Vec3) {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.local/spots");
    let _ = std::fs::create_dir_all(dir);
    // 40 px a metre, the target at (200, 200).
    let px = |v: i64| v * 40 / 1_000_000 + 200;
    let mut svg = String::from(
        "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><rect width='400' height='400' fill='white'/>",
    );
    for r in 1..=4 {
        svg += &format!(
            "<circle cx='200' cy='200' r='{}' fill='none' stroke='#ddd'/>",
            r * 28
        );
    }
    for w in c.controller.bodies() {
        let p = w.pose.position;
        svg += &format!(
            "<circle cx='{}' cy='{}' r='10' fill='#4a7' fill-opacity='0.6' stroke='#253'/>",
            px(p.x - target.x),
            px(p.z - target.z),
        );
    }
    svg += "<circle cx='200' cy='200' r='3' fill='red'/>";
    svg += "<text x='8' y='392' font-size='11' font-family='sans-serif'>30 walkers sent to one point (red); grey rings 0.7 m apart; bodies 0.25 m radius</text></svg>";
    let _ = std::fs::write(format!("{dir}/ring.svg"), svg);
}

/// The test world with a pond: 8 m square, 10 m to 18 m east and 10 m to 18 m south of the origin, on the square.
fn town_with_pond() -> (Town, BTreeMap<String, Id>) {
    let w = testworld::generate(1, 0).expect("the test world");
    let pond = "{\"id\":\"pond\",\"kind\":\"pond\",\"level\":0,\"name\":\"a pond\",\"of\":\"water\",\
                \"polygon\":[[10000,-18000],[18000,-18000],[18000,-10000],[10000,-10000]]},";
    assert!(w.text.contains("\"places\":["));
    let text = w
        .text
        .replacen("\"places\":[", &format!("\"places\":[{pond}"), 1);
    town_of(import_eden::load(&text).expect("the pond world loads"))
}

/// One walker `who` standing at `from` on `node`, sent to `target`: what the engine binds it to, after one tick.
fn bind(t: &mut Town, who: u64, node: Id, from: Vec3, target: Target) -> Result<Vec3, String> {
    let mut c = Runner::new(TICK);
    send(
        &mut c,
        stand(t, id(who), node, from),
        SPEED,
        target,
        id(5000 + who),
    )
    .unwrap();
    c.tick(t).unwrap();
    match (c.granted.get(&id(who)), c.ended.get(&id(who))) {
        (Some(p), _) => Ok(*p),
        (None, Some((_, Progress::Failed(name)))) => Err(name.as_str().to_owned()),
        _ => panic!("no answer after a tick"),
    }
}

/// Whether `p` lies in a rectangle (µm: x0, x1, z0, z1).
fn inside(p: Vec3, r: [i64; 4]) -> bool {
    p.x >= r[0] && p.x <= r[1] && p.z >= r[2] && p.z <= r[3]
}

/// A3's check on every table a town holds: no place within `CLEAR` of a link's end on its node, nor within half the
/// link's width and half `CLEAR` of its line (#4072: a step's line within half `CLEAR`, its ends holding its width; a
/// doorway's between its ends within half its widest end and half `CLEAR`, past them within half `CLEAR`; on a
/// building's floor, a flight's line where it lies from a step below the place to a body's height above it).
/// Returns how many places it checked.
fn no_place_in_a_passage(t: &Town) -> usize {
    let mut n = 0;
    for (node, tables) in &t.spots.owners {
        for table in tables.values() {
            for p in &table.places {
                n += 1;
                for b in &t.buildings {
                    for l in &b.links {
                        let ends: Vec<_> = l
                            .ends
                            .iter()
                            .flatten()
                            .filter(|e| e.floor == *node)
                            .collect();
                        if ends.is_empty() {
                            continue;
                        }
                        for e in ends {
                            assert!(
                                to_segment(p.at, e.a, e.b) >= CLEAR,
                                "A3: a place at a link's end"
                            );
                        }
                        // A doorway's band between its ends is as wide as its widest end; past them, half CLEAR.
                        let framed = |q: Vec3| {
                            if *node == t.ground {
                                b.place.point(q).unwrap()
                            } else {
                                q
                            }
                        };
                        let between = match (l.line.first(), l.line.last()) {
                            (Some(&a), Some(&c)) => {
                                let (a, c) = (framed(a), framed(c));
                                let (ex, ez) = (i128::from(c.x - a.x), i128::from(c.z - a.z));
                                let k =
                                    i128::from(p.at.x - a.x) * ex + i128::from(p.at.z - a.z) * ez;
                                k > 0 && k < ex * ex + ez * ez
                            }
                            _ => false,
                        };
                        let held = l.ends.iter().flatten().map(|e| flat(e.a, e.b) / 2).max();
                        let reach = match l.kind {
                            Kind::Step => CLEAR / 2,
                            Kind::Doorway if between => held.unwrap_or(0) + CLEAR / 2,
                            Kind::Doorway => CLEAR / 2,
                            _ => l.width / 2 + CLEAR / 2,
                        };
                        let flight = matches!(l.kind, Kind::Stairs | Kind::Ramp | Kind::Ladder);
                        for s in l.line.windows(2) {
                            let (a, c) = if *node == t.ground {
                                (b.place.point(s[0]).unwrap(), b.place.point(s[1]).unwrap())
                            } else {
                                (s[0], s[1])
                            };
                            let part = if flight && *node != t.ground {
                                level_part(a, c, p.at.y)
                            } else {
                                Some((a, c))
                            };
                            if let Some((a, c)) = part {
                                assert!(
                                    to_segment(p.at, a, c) >= reach,
                                    "A3: a place on a link's line"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    n
}

fn shown(target: Vec3, got: Result<Vec3, String>) -> String {
    let g = got.map(|p| {
        format!(
            "({}, {}) mm, {} mm from the target",
            p.x / 1000,
            p.z / 1000,
            flat(p, target) / 1000
        )
    });
    format!(
        "target ({}, {}) mm -> {}",
        target.x / 1000,
        target.z / 1000,
        g.unwrap_or_else(|e| e)
    )
}

/// A2 and A3: the eight nearest-clear-point cases, as data. Floor positions are in the building's frame (x along
/// its 16 m, z across its 12 m); the open ground's in the world's.
#[test]
fn a2_a3_eight_nearest_clear_point_cases() {
    let (mut t, nodes) = town();
    let f0 = nodes["building/floor-0"];
    let r0b = [-1_900_000, 2_900_000, -5_900_000, -100_000]; // the south room, clear
    let r0a = [-7_900_000, -2_100_000, -5_900_000, 5_900_000]; // the stair hall
    let mut rows = Vec::new();

    // 1. Inside a box (a 0.3 m box on the square, in the world with boxes): beside it, on the asker's side.
    {
        let w = testworld::generate(1, 60).expect("the test world with boxes");
        let (mut tb, nb) = town_of(import_eden::load(&w.text).unwrap());
        let ground = tb.ground;
        let boxes: Vec<Vec3> = nb
            .iter()
            .filter(|(k, _)| k.starts_with("box-"))
            .filter_map(|(_, &n)| {
                let node = tb.tree.node(tb.tree.handle(n)?)?;
                if node.parent() != Some(ground) {
                    return None;
                }
                node.place().map(|p| p.position)
            })
            .collect();
        let b = *boxes
            .iter()
            .min_by_key(|p| flat(**p, Vec3::ZERO))
            .expect("a box on the square");
        let from = Vec3::new(b.x - 4_000_000, 0, b.z);
        let got = bind(&mut tb, 1, ground, from, Target::new(ground, b));
        rows.push(format!("in a box: {}", shown(b, got.clone())));
        let p = got.expect("bound");
        assert!(!tb.spots.table(&Target::new(ground, b)).unwrap().clear);
        assert!(
            flat(p, b) >= 300_000 && flat(p, b) <= 1_400_000,
            "beside the box"
        );
        assert!(p.x < b.x, "on the asker's side");
        no_place_in_a_passage(&tb);
    }

    // 2. In a corner of the south room: within a metre of it, in the room.
    let corner = Vec3::new(2_900_000, 0, -5_900_000);
    let got = bind(
        &mut t,
        2,
        f0,
        Vec3::new(500_000, 0, -3_000_000),
        Target::new(f0, corner),
    );
    rows.push(format!("in a corner: {}", shown(corner, got.clone())));
    let p = got.expect("bound");
    assert!(inside(p, r0b) && flat(p, corner) <= 1_000_000);

    // 3. In the wall between the south and east rooms, 20 mm from its east face: the far side is nearer in a
    // straight line, but the asker is in the south room, so it is bound there, never through the wall.
    let wall = Vec3::new(3_080_000, 0, -1_500_000);
    let got = bind(
        &mut t,
        3,
        f0,
        Vec3::new(500_000, 0, -1_500_000),
        Target::new(f0, wall),
    );
    rows.push(format!(
        "in a wall, its far side nearer: {}",
        shown(wall, got.clone())
    ));
    let p = got.expect("bound");
    assert!(inside(p, r0b), "the asker's side of the wall");
    assert!(flat(p, wall) <= 1_500_000);

    // 4. In the doorway between the stair hall and the south room, asked from the south room: beside it, clear.
    let doorway = Vec3::new(-2_000_000, 0, -3_000_000);
    let got = bind(
        &mut t,
        4,
        f0,
        Vec3::new(500_000, 0, -3_000_000),
        Target::new(f0, doorway),
    );
    rows.push(format!("in a doorway: {}", shown(doorway, got.clone())));
    let p = got.expect("bound");
    assert!(!t.spots.table(&Target::new(f0, doorway)).unwrap().clear);
    assert!(inside(p, r0b) && flat(p, doorway) <= 2_100_000);

    // 5. On the stair (its middle, on the ground floor), asked from the stair hall: beside it, clear of it.
    let stair = Vec3::new(-5_400_000, 0, 0);
    let got = bind(
        &mut t,
        5,
        f0,
        Vec3::new(-5_400_000, 0, -3_500_000),
        Target::new(f0, stair),
    );
    rows.push(format!("on a stair: {}", shown(stair, got.clone())));
    let p = got.expect("bound");
    assert!(!t.spots.table(&Target::new(f0, stair)).unwrap().clear);
    assert!(inside(p, r0a) && flat(p, stair) <= 2_100_000);

    // 6. A full room: every place in the south room held, the next asker in it is bound outside, through a door
    // (the stair hall or the east room), never through the wall into the north room.
    let middle = Vec3::new(500_000, 0, -3_000_000);
    let target = Target::new(f0, middle);
    let mut c = Runner::new(TICK);
    for k in 0..60 {
        send(
            &mut c,
            stand(&t, id(100 + k), f0, middle),
            SPEED,
            target,
            id(6100 + k),
        )
        .unwrap();
    }
    c.tick(&mut t).unwrap();
    let table = t.spots.table(&target).unwrap();
    let in_room = table.places.iter().filter(|p| inside(p.at, r0b)).count();
    // The places granted, in the askers' id order.
    let spots: Vec<Vec3> = c.granted.values().copied().collect();
    let k = spots
        .iter()
        .position(|p| !inside(*p, r0b))
        .expect("the room fills and an asker is bound outside it");
    let p = spots[k];
    rows.push(format!(
        "in a full room: {} ({in_room} places in the room, all held before; asker {})",
        shown(middle, Ok(p)),
        k + 1
    ));
    assert_eq!(
        k, in_room,
        "every place in the room is granted before one outside it"
    );
    assert!(
        table
            .places
            .iter()
            .filter(|p| inside(p.at, r0b))
            .all(|p| p.holder.is_some())
    );
    let r0c = [-1_900_000, 2_900_000, 100_000, 5_900_000];
    for s in c.granted.values() {
        assert!(
            !inside(*s, r0c),
            "never through the wall into the north room"
        );
    }
    no_place_in_a_passage(&t);

    // 7. Outside the world, 1.5 m past the open ground's south edge: on the ground, by the edge.
    let ground = t.ground;
    let off = Vec3::new(0, 0, -34_000_000);
    let got = bind(
        &mut t,
        7,
        ground,
        Vec3::new(0, 0, -25_000_000),
        Target::new(ground, off),
    );
    rows.push(format!("outside the world: {}", shown(off, got.clone())));
    let p = got.expect("bound");
    assert!(t.map.spot(ground, off).is_none());
    assert!(flat(p, off) <= 2_800_000);
    // Far outside, with no ground on the rings: a named refusal.
    let far = Vec3::new(0, 0, -60_000_000);
    let got = bind(
        &mut t,
        8,
        ground,
        Vec3::new(0, 0, -25_000_000),
        Target::new(ground, far),
    );
    rows.push(format!(
        "far outside the world: {}",
        shown(far, got.clone())
    ));
    assert_eq!(got, Err("spot-none-near".to_owned()));
    no_place_in_a_passage(&t);

    // 8. On water, 2 m into a pond from its west shore, asked from the west: on the shore.
    let (mut tp, _) = town_with_pond();
    let ground = tp.ground;
    let wet = Vec3::new(12_000_000, 0, -14_000_000);
    let got = bind(
        &mut tp,
        9,
        ground,
        Vec3::new(5_000_000, 0, -14_000_000),
        Target::new(ground, wet),
    );
    rows.push(format!("on water: {}", shown(wet, got.clone())));
    let p = got.expect("bound");
    assert!(
        tp.map.spot(ground, wet).is_none(),
        "the pond is no walkable ground"
    );
    assert!(
        p.x < 10_000_000 && flat(p, wet) <= 2_800_000,
        "on the west shore"
    );
    no_place_in_a_passage(&tp);

    println!("A2, the eight cases:");
    for r in &rows {
        println!("  {r}");
    }
}

/// A3: a body whose own order is to stay at a doorway stays: spots are granted round it, none in the doorway, and
/// nothing moves or refuses it.
#[test]
fn a3_a_body_staying_in_a_doorway_is_left_there() {
    let (mut t, nodes) = town();
    let f0 = nodes["building/floor-0"];
    let door = nodes["door-building-a-b"];
    let mouth = t
        .buildings
        .iter()
        .flat_map(|b| &b.links)
        .find(|l| l.door == Some(door))
        .and_then(|l| l.ends.iter().flatten().find(|e| e.floor == f0).copied())
        .expect("the doorway a-b, an end on the floor")
        .middle();
    let mut c = Runner::new(TICK);
    let body = stand(&t, id(1), f0, mouth);
    c.add_body(common::humanoid(), body).unwrap();
    c.stay(id(1));
    for k in 0..6u64 {
        let from = Vec3::new(500_000, 0, -4_500_000 + k as i64 * 600_000);
        send(
            &mut c,
            stand(&t, id(10 + k), f0, from),
            SPEED,
            Target::new(f0, mouth),
            id(7010 + k),
        )
        .unwrap();
    }
    for _ in 0..200 {
        c.tick(&mut t).unwrap();
    }
    let still = c.controller.body(id(1)).unwrap();
    assert_eq!(
        still.pose.position, mouth,
        "the staying body was never moved"
    );
    assert!(
        !c.ended.contains_key(&id(1)) && c.staying.contains(&id(1)),
        "nor refused"
    );
    let n = no_place_in_a_passage(&t);
    let standing = (10..16).filter(|k| arrived(&c, id(*k)).is_some()).count();
    println!(
        "A3: a body stays at the doorway's mouth; {standing} of 6 sent there stand round it; {n} places, none in a passage"
    );
    assert_eq!(standing, 6);
}

/// A5: a spot is released when its holder's order ends mid-walk, or when it leaves; then another is granted it.
#[test]
fn a5_a_spot_is_released_when_its_holder_leaves() {
    let (mut t, _) = town();
    let ground = t.ground;
    let point = Vec3::new(5_000_000, 0, 5_000_000);
    let target = Target::new(ground, point);
    let mut c = Runner::new(TICK);
    let from = Vec3::new(5_000_000, 0, -5_000_000);
    send(
        &mut c,
        stand(&t, id(1), ground, from),
        SPEED,
        target,
        id(8001),
    )
    .unwrap();
    for _ in 0..40 {
        c.tick(&mut t).unwrap();
    }
    assert!(arrived(&c, id(1)).is_none(), "mid-walk");
    let held = *c.granted.get(&id(1)).expect("granted");
    // Its order ends mid-walk: the place is released at the start of the next tick, and the next asker gets it.
    c.end_order(id(1));
    let from = Vec3::new(-5_000_000, 0, 5_000_000);
    send(
        &mut c,
        stand(&t, id(2), ground, from),
        SPEED,
        target,
        id(8002),
    )
    .unwrap();
    c.tick(&mut t).unwrap();
    let released = |t: &Town, who: Id| {
        t.spots
            .record
            .iter()
            .find(|e| matches!(e, Entry::Release { who: w, .. } if *w == who))
            .cloned()
    };
    let rel = released(&t, id(1));
    assert!(
        matches!(
            rel,
            Some(Entry::Release {
                why: "order-ended",
                place: (0, 0),
                ..
            })
        ),
        "{rel:?}"
    );
    assert_eq!(
        c.granted.get(&id(2)).copied(),
        Some(held),
        "the next asker is granted the released place"
    );
    // It arrives, then leaves for another point: released again, by `spot-left`.
    for _ in 0..400 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(&mut t).unwrap();
    }
    assert!(arrived(&c, id(2)).is_some());
    let b = *c.controller.body(id(2)).unwrap();
    let elsewhere = Target::new(ground, Vec3::new(-5_000_000, 0, -5_000_000));
    send(&mut c, b, SPEED, elsewhere, id(8003)).unwrap();
    c.tick(&mut t).unwrap();
    let rel = released(&t, id(2));
    assert!(
        matches!(
            rel,
            Some(Entry::Release {
                why: "spot-left",
                place: (0, 0),
                ..
            })
        ),
        "{rel:?}"
    );
    assert!(
        t.spots
            .table(&target)
            .unwrap()
            .places
            .iter()
            .all(|p| p.holder.is_none()),
        "the table is empty again"
    );
    println!(
        "A5: released when the order ended mid-walk, and granted again; released again when its holder left:"
    );
    for e in &t.spots.record {
        if let Entry::Release {
            at,
            who,
            place,
            why,
            ..
        } = e
        {
            println!(
                "  at {} ms: {} released {place:?}, {why}",
                at / 1000,
                show(*who)
            );
        }
    }
}

/// C8 (#3396): the building boxes skip only what is in no passage. On the open ground, at every point on a 100 mm grid
/// over each building's box widened by 1 m, the passage test with the boxes gives the same answer as without them.
#[test]
fn c8_the_boxes_give_the_same_passages() {
    use sim::walk::town::{ground_boxes, in_passage};
    let (t, _) = town();
    let boxes = ground_boxes(&t.buildings, t.ground);
    let (mut checked, mut inside) = (0, 0);
    for r in boxes.iter().flatten() {
        for x in ((r[0] - 1_000_000)..=(r[2] + 1_000_000)).step_by(100_000) {
            for z in ((r[1] - 1_000_000)..=(r[3] + 1_000_000)).step_by(100_000) {
                let p = Vec3::new(x, 0, z);
                let full = in_passage(&t.buildings, &[], t.ground, t.ground, p);
                assert_eq!(
                    in_passage(&t.buildings, &boxes, t.ground, t.ground, p),
                    full,
                    "C8: the boxes changed the passage test at {p:?}"
                );
                checked += 1;
                inside += usize::from(full);
            }
        }
    }
    println!("C8: {checked} points, {inside} in a passage, the same with and without the boxes");
    assert!(inside > 0 && checked > inside);
}

/// #5003's Eden audit: a doorway's passage is its ends' and its line's, not a disc of its width. A point at an end, on
/// the room's side, is in the passage and at the doorway's mouth; one between the ends is in the doorway, no mouth; and
/// one 1.5 m out past an end is in neither, though the doorway be 11.6 m wide (a market pavilion's open side, whose
/// width counted out from its line swallowed the pavilion).
#[test]
fn a_doorways_passage_is_its_ends_and_its_line_and_its_mouth_is_on_the_rooms_side() {
    use sim::walk::town::{in_mouth_indexed, in_passage, passages_of};
    let (t, nodes) = town();
    let f0 = nodes["building/floor-0"];
    let door = nodes["door-building-a-b"];
    let (bi, li) = t
        .buildings
        .iter()
        .enumerate()
        .find_map(|(bi, b)| Some((bi, b.links.iter().position(|l| l.door == Some(door))?)))
        .expect("the doorway a-b");
    let l = &t.buildings[bi].links[li];
    let (a, c) = (l.line[0], l.line[l.line.len() - 1]);
    let len = flat(a, c);
    // `k` µm from end 0 along the line toward end 1 (out past it when below 0).
    let along = |k: i64| {
        Vec3::new(
            a.x + (i128::from(c.x - a.x) * i128::from(k) / i128::from(len)) as i64,
            a.y,
            a.z + (i128::from(c.z - a.z) * i128::from(k) / i128::from(len)) as i64,
        )
    };
    let passages = passages_of(&t.buildings, t.ground);
    let mouth = |bs: &[sim::links::Building], p: Vec3| {
        in_mouth_indexed(bs, &passages, t.ground, f0, p, None)
    };
    let at_end = along(-400_000);
    assert!(
        in_passage(&t.buildings, &[], t.ground, f0, at_end),
        "at an end"
    );
    assert!(
        mouth(&t.buildings, at_end),
        "at an end, on the room's side: the mouth"
    );
    let inside = along(len / 2);
    assert!(
        in_passage(&t.buildings, &[], t.ground, f0, inside),
        "in the doorway"
    );
    assert!(!mouth(&t.buildings, inside), "in the doorway: no mouth");
    // Between the ends 0.2 m in from the wider one, 0.1 m to the side of the band: at that end, in the doorway, no mouth.
    let halves: Vec<i64> = l
        .ends
        .iter()
        .flatten()
        .map(|e| flat(e.a, e.b) / 2)
        .collect();
    let held = *halves.iter().max().expect("its ends");
    let on_line = if halves[0] >= halves[1] {
        along(200_000)
    } else {
        along(len - 200_000)
    };
    let side = held + CLEAR / 2 + 100_000;
    let aside = Vec3::new(
        on_line.x - (i128::from(c.z - a.z) * i128::from(side) / i128::from(len)) as i64,
        a.y,
        on_line.z + (i128::from(c.x - a.x) * i128::from(side) / i128::from(len)) as i64,
    );
    assert!(
        in_passage(&t.buildings, &[], t.ground, f0, aside),
        "beside the band, at an end, between the ends"
    );
    assert!(!mouth(&t.buildings, aside), "between the ends: no mouth");
    let out = along(-1_500_000);
    let mut wide = t.buildings.clone();
    wide[bi].links[li].width = 11_600_000;
    for (name, bs) in [("as built", &t.buildings), ("11.6 m wide", &wide)] {
        assert!(
            !in_passage(bs, &[], t.ground, f0, out),
            "{name}: 1.5 m out past an end"
        );
        assert!(!mouth(bs, out), "{name}: 1.5 m out past an end, no mouth");
    }
}

/// #1960 (#3688's class): a move at a door aimed in its wall, short of the doorway, from a room on either side. Every
/// floor place within an arm of the aim lies within [`CLEAR`] of the doorway's ends, so the plain search finds none
/// clear of the doorway (the bedroom close's `out-of-reach` on served Eden, 783 mm against 600): since #5003's Eden
/// audit it finds one at the doorway's mouth, on the walker's own side, never in the doorway itself; another thing's
/// id changes nothing. With the move's own door, its doorway counts and each side gets a place on its own side,
/// within the arm.
#[test]
fn a_door_is_reached_from_a_room_on_either_side() {
    let (mut t, nodes) = town();
    let f0 = nodes["building/floor-0"];
    let door = nodes["door-building-a-b"];
    let ends: Vec<_> = t
        .buildings
        .iter()
        .flat_map(|b| &b.links)
        .find(|l| l.door == Some(door))
        .expect("the doorway a-b")
        .ends
        .iter()
        .flatten()
        .map(|e| e.middle().x)
        .collect();
    let (west, east) = (ends[0].min(ends[1]), ends[0].max(ends[1]));
    let (aim, reach) = (Vec3::new((west + east) / 2, 0, -3_400_000), 600_000);
    let (buildings, ground) = (t.buildings.clone(), t.ground);
    for (side, from) in [("west", west - 1_000_000), ("east", east + 1_000_000)] {
        let body = stand(&t, id(1), f0, Vec3::new(from, 0, -3_000_000));
        let v = t.view();
        let mouth = v
            .stand_near(f0, aim, reach, Some(&body))
            .unwrap_or_else(|| panic!("{side}: a place at the doorway's mouth"));
        let own_side = |p: Vec3| {
            if side == "west" {
                p.x <= west
            } else {
                p.x >= east
            }
        };
        assert!(
            flat(mouth, aim) <= reach && own_side(mouth),
            "{side}: {mouth:?} within an arm of {aim:?}, on the walker's side of the doorway"
        );
        assert!(
            sim::walk::town::in_passage(&buildings, &[], ground, f0, mouth),
            "{side}: {mouth:?} by the doorway's end, as no place clear of it is"
        );
        assert_eq!(
            v.stand_near_door(f0, aim, reach, Some(&body), Some(f0)),
            Some(mouth),
            "{side}: another thing's id frees no doorway"
        );
        let p = v
            .stand_near_door(f0, aim, reach, Some(&body), Some(door))
            .unwrap_or_else(|| panic!("{side}: a place in the door's own doorway"));
        assert!(
            flat(p, aim) <= reach,
            "{side}: {p:?} within an arm of {aim:?}"
        );
        let near_side = if side == "west" {
            p.x <= west
        } else {
            p.x >= east
        };
        assert!(
            near_side,
            "{side}: {p:?} on the body's own side of the door"
        );
    }
}

/// One walker sent from `(sx, 0)` to the point `(0, 0)` on the open ground, bodies standing still (no order) at `by`,
/// run until its walk ends: the runner and the town after.
fn sent_past(sx: i64, by: &[(i64, i64)]) -> (Runner, Town) {
    let (mut t, _) = town();
    let g = t.ground;
    let mut c = Runner::new(TICK);
    let w = stand(&t, id(1), g, Vec3::new(sx, 0, 0));
    send(
        &mut c,
        w,
        SPEED,
        Target::new(g, Vec3::new(0, 0, 0)),
        id(1000),
    )
    .unwrap();
    for (k, &(x, z)) in by.iter().enumerate() {
        let b = stand(&t, id(10 + k as u64), g, Vec3::new(x, 0, z));
        c.add_body(common::humanoid(), b).unwrap();
    }
    for _ in 0..600 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(&mut t).unwrap();
    }
    (c, t)
}

/// Whether the walk ended short of its goal, as near as the crowd allows (`F_SHORT` on its body, 0.133 A2-4).
fn short(c: &Runner) -> bool {
    c.fields
        .get(&id(1))
        .is_some_and(|f| f.contains_key(&replica::host::F_SHORT))
}

/// 0.133 A2-4 (review of #4364): a walk to its own granted spot, free and reachable, is never ended short by bodies
/// at rest near its line. One bystander in line, a pair with a gap a body passes through, and a row of three before
/// the spot: each walk ends a plain `done` on its spot, which it holds, settled.
#[test]
fn a2_4_a_walk_to_a_free_spot_arrives_past_bodies_near_its_line() {
    type Case = (&'static str, &'static [(i64, i64)]);
    let cases: [Case; 4] = [
        ("one bystander 2 m short, in line", &[(-2_000_000, 0)]),
        ("one bystander 0.5 m short, in line", &[(-500_000, 0)]),
        (
            "a pair 0.5 m apart across the line, 1.5 m short",
            &[(-1_500_000, -250_000), (-1_500_000, 250_000)],
        ),
        (
            "a row of three 0.4 m apart across the line, 1.5 m short",
            &[
                (-1_500_000, -400_000),
                (-1_500_000, 0),
                (-1_500_000, 400_000),
            ],
        ),
    ];
    for (label, by) in cases {
        let (c, _) = sent_past(-6_000_000, by);
        let p = c.controller.body(id(1)).unwrap().pose.position;
        let spot = c.granted.get(&id(1)).copied();
        let off = spot.map(|s| flat(p, s));
        println!(
            "A2-4 {label}: ended {:?}; at ({}, {}) mm; short {}; spot {spot:?}, {off:?} µm off",
            c.ended.get(&id(1)),
            p.x / 1000,
            p.z / 1000,
            short(&c)
        );
        assert!(
            matches!(c.ended.get(&id(1)), Some((_, Progress::Done))),
            "{label}: done"
        );
        assert!(!short(&c), "{label}: a plain done, not short");
        assert!(
            off.is_some_and(|o| o <= skills::route::AT_SPOT),
            "{label}: on its spot: {off:?}"
        );
        assert!(c.settled(id(1)), "{label}: settled on its spot");
    }
}

/// 0.133 A2-4 (review of #4364): a walk whose granted spot a body at rest stands on ends short of it, as near as the
/// crowd allows, and gives the spot back: it is not settled, and the spot is released at the next tick.
#[test]
fn a2_4_a_walk_ended_short_of_its_spot_releases_it() {
    let (mut c, mut t) = sent_past(-6_000_000, &[(0, 0)]);
    let p = c.controller.body(id(1)).unwrap().pose.position;
    println!(
        "A2-4 spot taken: ended {:?}; {} mm from the point; spot {:?}; short {}",
        c.ended.get(&id(1)),
        flat(p, Vec3::new(0, 0, 0)) / 1000,
        c.granted.get(&id(1)),
        short(&c)
    );
    assert!(matches!(c.ended.get(&id(1)), Some((_, Progress::Done))));
    assert!(short(&c), "ended short of its spot");
    assert!(!c.settled(id(1)), "not settled on a spot it never reached");
    assert!(!c.granted.contains_key(&id(1)), "its grant is given back");
    c.tick(&mut t).unwrap();
    assert!(
        t.spots
            .record
            .iter()
            .any(|e| matches!(e, Entry::Release { who, .. } if *who == id(1))),
        "the spot is released"
    );
}

/// 0.133 A2-5 (review of #4399): the town's own overflow grounds. A point on the open ground overflows round itself;
/// a point on a building's floor onto the open ground, at that point in the ground's frame (as the ground's own read
/// of a standing point there gives it).
#[test]
fn a2_5_the_town_overflows_onto_the_open_ground() {
    let (mut t, nodes) = town();
    let (ground, f0) = (nodes["ground"], nodes["building/floor-0"]);
    let q = Vec3::new(500_000, 0, -3_000_000);
    let (on_ground, from_floor, stood) = t.with_ground(|_, g| {
        (
            g.overflow_at(ground, Vec3::new(1_000_000, 0, 2_000_000)),
            g.overflow_at(f0, q),
            g.stand(f0, q),
        )
    });
    println!(
        "A2-5 overflow grounds: {on_ground:?}; from the floor {from_floor:?}; the floor point {stood:?}"
    );
    assert_eq!(
        on_ground,
        vec![(ground, Vec3::new(1_000_000, 0, 2_000_000))]
    );
    let (_, world) = stood.expect("a body stands there");
    assert_eq!(from_floor.len(), 1);
    assert_eq!(from_floor[0].0, ground, "onto the open ground");
    assert!(
        flat(from_floor[0].1, world) <= 1_000,
        "the same point, in the ground's frame: {:?} {world:?}",
        from_floor[0].1
    );
}

/// 0.133 A2-5 (review of #4399), through the runner: more walkers sent to one point on the square than it has places.
/// Those granted overflow points walk there, end `done` as near as the crowd allows (`F_SHORT`) and hold them,
/// settled; none is refused.
#[test]
fn a2_5_walkers_beyond_a_full_place_end_done_on_overflow_points() {
    let (mut t, nodes) = town();
    let ground = nodes["ground"];
    let target = Target::new(ground, Vec3::ZERO);
    let mut c = Runner::new(TICK);
    // A first walker, for the table's size.
    send(
        &mut c,
        stand(&t, id(1), ground, Vec3::new(0, 0, -12_000_000)),
        SPEED,
        target,
        id(5001),
    )
    .unwrap();
    c.tick(&mut t).unwrap();
    c.tick(&mut t).unwrap();
    let places = t.spots.table(&target).expect("the table").places.len();
    let n = places + 12;
    let mut k = 1;
    'all: for row in 0..40i64 {
        for col in 0..30i64 {
            if k >= n {
                break 'all;
            }
            let at = Vec3::new(
                -17_400_000 + col * 1_200_000,
                0,
                -14_000_000 - row * 1_200_000,
            );
            send(
                &mut c,
                stand(&t, id(1 + k as u64), ground, at),
                SPEED,
                target,
                id(5001 + k as u64),
            )
            .unwrap();
            k += 1;
        }
    }
    for _ in 0..4_000 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(&mut t).unwrap();
    }
    let who: Vec<Id> = (0..n).map(|k| id(1 + k as u64)).collect();
    let refused = who
        .iter()
        .filter(|w| matches!(c.ended.get(w), Some((_, Progress::Failed(_)))))
        .count();
    let over: Vec<Id> = who
        .iter()
        .copied()
        .filter(|w| matches!(t.spots.granted(*w, &target), Some(Ok(g)) if g.overflow))
        .collect();
    let done = over
        .iter()
        .filter(|w| {
            matches!(c.ended.get(w), Some((_, Progress::Done)))
                && c.fields
                    .get(w)
                    .is_some_and(|f| f.contains_key(&replica::host::F_SHORT))
                && c.settled(**w)
        })
        .count();
    println!(
        "A2-5 through the runner: {places} places, {n} sent; refused {refused}; on overflow points {}, of them done short and settled {done}; still walking {}",
        over.len(),
        c.runs.len()
    );
    assert_eq!(refused, 0, "none refused");
    assert!(over.len() >= 12, "the last sent overflow: {}", over.len());
    assert_eq!(
        done,
        over.len(),
        "each arrived, done as near as the crowd allows, holding its point"
    );
}
