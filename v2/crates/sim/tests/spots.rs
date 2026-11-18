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
use sim::spots::{CLEAR, Entry, Target, to_segment};
use sim::walk::town::Town;
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
/// link's width and half `CLEAR` of its line.
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
                        for s in l.line.windows(2) {
                            let (a, c) = if *node == t.ground {
                                (b.place.point(s[0]).unwrap(), b.place.point(s[1]).unwrap())
                            } else {
                                (s[0], s[1])
                            };
                            assert!(
                                to_segment(p.at, a, c) >= l.width / 2 + CLEAR / 2,
                                "A3: a place on a link's line"
                            );
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
