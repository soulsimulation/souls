//! The walk skill and keeping apart (Engine v2 N7, #2655) on N2's test world.
//!
//! `cargo test -p sim --release --test walk -- --nocapture` runs the walker through three shut doors (A3, and step 0:
//! one walker, door to door), the skill on a world of its own (A4) and the crossings of the square (A1, A2, A5): 400
//! walkers, 100 from each side (the even arm, held to the bars), then the uneven arm declared here before the run, 160
//! from the west, 120 from the east, 80 from the north and 40 from the south (reported, no bar); two repeats each.

use import_eden::{F_DOORWAY, Import};
use replica::effects::{Actor, Body as EffectBody, Cause, Header, Refusal, schema_hash};
use replica::encode::{Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::world_model::show;
use sim::links::{DOOR_OPENED, Doors, F_OPEN};
use sim::mover::Body;
use sim::walk::town::Town;
use sim::walk::{Crowd, Leg, World};
use std::collections::BTreeMap;

const SPEED: i64 = 1_400_000; // µm a second: today's walking pace
const TICK: i64 = 50_000; // µs: 20 ticks a second

fn id(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

/// The test world as the walk skill reads it, with a door writer, and its named nodes.
fn town() -> (Town, BTreeMap<String, Id>) {
    let w = testworld::generate(1, 0).expect("the test world");
    town_of(import_eden::load(&w.text).expect("the test world loads"))
}

/// A loaded world as the walk skill reads it, with a door writer, and its named nodes.
fn town_of(im: Import) -> (Town, BTreeMap<String, Id>) {
    let Import {
        tree, rules, nodes, ..
    } = im;
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/walk-test/1").to_bytes()),
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
    let frame = Frame { node, slot: None };
    t.surfaces[&node]
        .place(who, frame, at, Quat::IDENTITY)
        .unwrap_or_else(|e| panic!("{}: {}", e.name, e.detail))
}

fn run(t: &mut Town, c: &mut Crowd, ticks: u64) {
    for _ in 0..ticks {
        if c.done() {
            break;
        }
        c.step(t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
    }
}

/// Step 0 and A3: one walker, from the south room of the ground floor to the north-east room upstairs, routed by N5
/// through shut doors and the stair; each opening is in the effect stream.
#[test]
fn a3_a_walker_routed_through_three_shut_doors_arrives() {
    let (mut t, nodes) = town();
    let (f0, f1) = (nodes["building/floor-0"], nodes["building/floor-1"]);
    let room = |k: &str| {
        let h = t.tree.handle(nodes[k]).unwrap();
        t.tree.node(h).unwrap().place().unwrap().position
    };
    let goal = room("building/r1d");
    let me = stand(&t, id(1), f0, Vec3::new(0, 0, -3_000_000));
    let mut c = Crowd::new(TICK);
    c.add(&mut t, me, SPEED, id(1001), f1, goal)
        .unwrap_or_else(|e| panic!("no plan: {}: {}", e.name, e.detail));
    let legs = c.walkers[0].legs.clone();
    println!("A3 legs:");
    for l in &legs {
        println!(
            "  to ({}, {}, {}) mm{}",
            l.to.x / 1000,
            l.to.y / 1000,
            l.to.z / 1000,
            l.link
                .map(|k| format!(", then cross {}", show(k)))
                .unwrap_or_default()
        );
    }
    let t0 = std::time::Instant::now();
    run(&mut t, &mut c, 4_000);
    let w = &c.walkers[0];
    let arrived = w.arrived.expect("the walker arrives");
    let p = w.body.pose.position;
    println!(
        "A3: arrived at {} ms of world time ({} ticks, {} us of run time), at ({}, {}, {}) mm on {}",
        arrived / 1000,
        arrived / TICK,
        t0.elapsed().as_micros(),
        p.x / 1000,
        p.y / 1000,
        p.z / 1000,
        show(sim::walk::node_of(&w.body))
    );
    assert_eq!(sim::walk::node_of(&w.body), f1);
    // Each door crossed opened once, by this walker's order, in the order crossed.
    let doors: Vec<Id> = legs
        .iter()
        .filter_map(|l| l.link)
        .filter(|k| {
            t.buildings
                .iter()
                .any(|b| b.link(*k).is_some_and(|l| l.door.is_some()))
        })
        .collect();
    println!("A3 effect stream:");
    let mut opened = Vec::new();
    for e in &t.doors.stream {
        let ev = &e.events.as_ref().unwrap()[0];
        let link = replica::effects::read_id(&ev.fields[&1]).unwrap();
        let EffectBody::Changes(ch) = &e.body else {
            panic!("changes")
        };
        println!(
            "  #{} at {} us: {} on door {} of link {} ({} change, field {F_OPEN} to 1), the walker's order",
            e.envelope.sequence,
            e.envelope.at,
            ev.name.as_str(),
            show(e.envelope.node),
            show(link),
            ch.len(),
        );
        assert_eq!(ev.name.as_str(), DOOR_OPENED);
        assert_eq!(e.envelope.cause, Cause::Intent(id(1001)));
        assert_eq!(e.envelope.actor, Actor::Soul(id(1)));
        opened.push(link);
    }
    assert_eq!(
        opened, doors,
        "one opening per shut door, in the order crossed"
    );
    assert_eq!(opened.len(), 3, "three shut doors on the way");
    // Each door it crossed now stands open; the others stay shut.
    for d in [
        "door-building-a-b",
        "door-building-narrow",
        "door-building-to-d",
    ] {
        let h = t.tree.handle(nodes[d]).unwrap();
        let n = t.tree.node(h).unwrap();
        let link = replica::effects::read_id(n.fields().get(&F_DOORWAY).unwrap()).unwrap();
        assert!(opened.contains(&link), "{d} crossed");
        assert_eq!(n.fields().get(&F_OPEN), Some(&Value::Uint(1)), "{d} open");
    }
}

/// A flat world of its own: one square plane, straight lines, no links. The skill runs on it unchanged.
struct Plane {
    half: i64,
    plans: u32,
}

impl World for Plane {
    fn plan(&mut self, _: &Body, _: Id, goal: Vec3) -> Result<Vec<Leg>, Refusal> {
        self.plans += 1;
        Ok(vec![Leg {
            to: goal,
            link: None,
        }])
    }
    fn corner(&mut self, _: &Body, to: Vec3) -> Result<[i64; 2], Refusal> {
        Ok([to.x, to.z])
    }
    fn step(&mut self, b: &mut Body, v: [i64; 2], dt: Micros, _: Micros) -> Result<(), Refusal> {
        let p = b.pose.position;
        let c = |a: i64, d: i64| (a + d * dt / 1_000_000).clamp(-self.half, self.half);
        b.pose.position = Vec3::new(c(p.x, v[0]), 0, c(p.z, v[1]));
        b.linear = Vec3::new(v[0], 0, v[1]);
        Ok(())
    }
    fn cross(
        &mut self,
        _: &mut Body,
        link: Id,
        _: Id,
        _: i64,
        _: Micros,
        _: Micros,
    ) -> Result<bool, Refusal> {
        Err(Refusal {
            name: "link-missing",
            detail: show(link),
        })
    }
}

/// A4: the skill reaches the world only through its trait: the same crowd code walks two bodies head-on across a
/// plane that is no part of the engine, and they pass.
#[test]
fn a4_the_skill_runs_on_any_world_through_its_one_trait() {
    let mut w = Plane {
        half: 20_000_000,
        plans: 0,
    };
    let node = id(500);
    let body = |n: u64, x: i64| Body {
        id: id(n),
        pose: Pose {
            frame: Frame { node, slot: None },
            position: Vec3::new(x, 0, 0),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: node,
                height: 0,
            },
        },
        linear: Vec3::ZERO,
        piece: 0,
        tri: 0,
    };
    let mut c = Crowd::new(TICK);
    c.add(
        &mut w,
        body(1, -10_000_000),
        SPEED,
        id(1001),
        node,
        Vec3::new(10_000_000, 0, 0),
    )
    .unwrap();
    c.add(
        &mut w,
        body(2, 10_000_000),
        SPEED,
        id(1002),
        node,
        Vec3::new(-10_000_000, 0, 0),
    )
    .unwrap();
    let mut nearest = i64::MAX;
    for _ in 0..1_000 {
        if c.done() {
            break;
        }
        c.step(&mut w).unwrap();
        let (a, b) = (
            c.walkers[0].body.pose.position,
            c.walkers[1].body.pose.position,
        );
        nearest = nearest
            .min((((a.x - b.x) as i128).pow(2) + ((a.z - b.z) as i128).pow(2)).isqrt() as i64);
    }
    println!(
        "A4: two walkers head-on on a plane of their own: plans {}, arrived at {:?} ms, nearest {} mm, close walker-ticks {} of {}",
        w.plans,
        c.walkers
            .iter()
            .map(|w| w.arrived.map(|a| a / 1000))
            .collect::<Vec<_>>(),
        nearest / 1000,
        c.close,
        c.walked
    );
    assert!(c.done());
    assert!(nearest >= sim::walk::CLOSE, "they pass apart");
}

/// The arms: walkers from each side, (west, east, north, south).
/// The straight distance between two points, µm (rounded down).
fn dist(a: Vec3, b: Vec3) -> i64 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    (d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt() as i64
}

/// The world-frame position of a body: on the open ground as it stands, on a floor through its building's place.
fn world_at(t: &Town, b: &Body) -> Vec3 {
    let node = sim::walk::node_of(b);
    let p = b.pose.position;
    if node == t.ground {
        return p;
    }
    let place = t
        .buildings
        .iter()
        .find(|x| x.floors.contains_key(&node))
        .expect("a floor of a building")
        .place;
    place.point(p).expect("in range")
}

/// A spot on the open ground `d` µm straight out from the doorway `door`'s end there, and the room side's end
/// (its floor and middle) carried `d` µm inwards.
fn either_side(t: &Town, door: Id, d: i64) -> (Vec3, Id, Vec3) {
    let b = t
        .buildings
        .iter()
        .find(|b| b.link(door).is_some())
        .expect("a building holds the doorway");
    let l = b.link(door).unwrap();
    assert_eq!(l.blocked, None, "the doorway is crossable");
    let (Some(e0), Some(e1)) = (l.ends[0], l.ends[1]) else {
        panic!("two ends")
    };
    // The line is in the building's frame: from the ground end's middle to the floor end's, or back.
    let (out, inn, lo, li) = if e0.floor == t.ground {
        (e0, e1, l.line[0], l.line[1])
    } else {
        (e1, e0, l.line[1], l.line[0])
    };
    assert_ne!(inn.floor, t.ground, "one end on a floor");
    let len = dist(lo, li);
    let along = |p: Vec3, from: Vec3, to: Vec3| {
        Vec3::new(
            p.x + (to.x - from.x) * d / len,
            p.y,
            p.z + (to.z - from.z) * d / len,
        )
    };
    // Outwards in the ground's frame: the line's direction placed there.
    let (wo, wi) = (b.place.point(lo).unwrap(), b.place.point(li).unwrap());
    (
        along(out.middle(), wi, wo),
        inn.floor,
        along(inn.middle(), lo, li),
    )
}

/// The links with a shut door that a walker's legs cross, in order.
fn doors_on(t: &Town, c: &Crowd) -> Vec<Id> {
    c.walkers[0]
        .legs
        .iter()
        .filter_map(|l| l.link)
        .filter(|k| {
            t.buildings.iter().any(|b| {
                b.link(*k).and_then(|l| l.door).is_some_and(|d| {
                    let n = t.tree.node(t.tree.handle(d).unwrap()).unwrap();
                    n.fields().get(&F_OPEN) != Some(&Value::Uint(1))
                })
            })
        })
        .collect()
}

/// Walks the crowd's one walker until it arrives; returns the largest step it took in the world's frame, µm.
fn walk_one(t: &mut Town, c: &mut Crowd) -> i64 {
    let mut largest = 0;
    let mut was = world_at(t, &c.walkers[0].body);
    for _ in 0..4_000 {
        if c.done() {
            break;
        }
        c.step(t).unwrap_or_else(|e| {
            let w = &c.walkers[0];
            panic!(
                "refused: {}: {} (leg {} crossing {} at {:?} on {})",
                e.name,
                e.detail,
                w.leg,
                w.crossing,
                w.body.pose.position,
                show(sim::walk::node_of(&w.body))
            )
        });
        let now = world_at(t, &c.walkers[0].body);
        largest = largest.max(dist(now, was));
        was = now;
    }
    largest
}

/// One walker from `from` on the open ground to `goal` on `floor`, and back out to where it started. The way in
/// first crosses `entry`, a doorway between the building and the open ground, and the way out last; each shut door
/// on the way in opens once, by the walker's order, in the order crossed (`souls:door-opened` in the stream), and the
/// way out opens none. No tick moves the body further in the world's frame than its speed allows.
fn in_and_out(t: &mut Town, from: Vec3, floor: Id, goal: Vec3, entry: Id) {
    let ground = t.ground;
    let me = stand(t, id(1), ground, from);
    let before = t.doors.stream.len();
    let mut c = Crowd::new(TICK);
    c.add(t, me, SPEED, id(2001), floor, goal)
        .unwrap_or_else(|e| panic!("no plan in: {}: {}", e.name, e.detail));
    let links: Vec<Id> = c.walkers[0].legs.iter().filter_map(|l| l.link).collect();
    assert_eq!(links.first(), Some(&entry), "in: the entry first");
    println!(
        "  in: legs cross {}",
        links
            .iter()
            .map(|k| show(*k))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let doors = doors_on(t, &c);
    let reach = SPEED * TICK / 1_000_000;
    let mut largest = walk_one(t, &mut c);
    let w = &c.walkers[0];
    let arrived_in = w.arrived.unwrap_or_else(|| {
        panic!(
            "the walker arrives in the room: leg {} of {:?}, crossing {}, at {:?} on {}, goal {:?}, from {:?}",
            w.leg,
            w.legs,
            w.crossing,
            w.body.pose.position,
            show(sim::walk::node_of(&w.body)),
            goal,
            from
        )
    });
    assert_eq!(
        sim::walk::node_of(&w.body),
        floor,
        "in: on the room's floor"
    );
    let mut opened = Vec::new();
    for e in &t.doors.stream[before..] {
        let ev = &e.events.as_ref().unwrap()[0];
        assert_eq!(ev.name.as_str(), DOOR_OPENED);
        assert_eq!(e.envelope.cause, Cause::Intent(id(2001)));
        assert_eq!(e.envelope.actor, Actor::Soul(id(1)));
        let link = replica::effects::read_id(&ev.fields[&1]).unwrap();
        println!(
            "  in: effect #{} at {} us: {} on door {} of link {}",
            e.envelope.sequence,
            e.envelope.at,
            ev.name.as_str(),
            show(e.envelope.node),
            show(link)
        );
        opened.push(link);
    }
    assert!(!opened.is_empty(), "in: a door opened on the way");
    assert_eq!(
        opened, doors,
        "in: one opening per shut door, in the order crossed"
    );
    println!(
        "  in: arrived at {} ms on {} at ({}, {}, {}) mm",
        arrived_in / 1000,
        show(floor),
        w.body.pose.position.x / 1000,
        w.body.pose.position.y / 1000,
        w.body.pose.position.z / 1000,
    );
    // And back out, through the doors now open.
    let body = c.walkers[0].body;
    let mut c = Crowd::new(TICK);
    c.now = arrived_in;
    c.add(t, body, SPEED, id(2002), ground, from)
        .unwrap_or_else(|e| panic!("no plan out: {}: {}", e.name, e.detail));
    let links: Vec<Id> = c.walkers[0].legs.iter().filter_map(|l| l.link).collect();
    assert_eq!(links.last(), Some(&entry), "out: the entry last");
    largest = largest.max(walk_one(t, &mut c));
    let w = &c.walkers[0];
    let arrived_out = w
        .arrived
        .expect("the walker arrives back on the open ground");
    assert_eq!(
        sim::walk::node_of(&w.body),
        ground,
        "out: on the open ground"
    );
    assert_eq!(
        t.doors.stream.len(),
        before + opened.len(),
        "out: the doors were open"
    );
    println!(
        "  out: arrived at {} ms on the open ground at ({}, {}) mm; largest step in the world's frame {} um, bar {} um",
        arrived_out / 1000,
        w.body.pose.position.x / 1000,
        w.body.pose.position.z / 1000,
        largest,
        reach
    );
    assert!(
        largest <= reach + 10,
        "no tick longer than speed times the tick"
    );
}

/// Building entry: from the square, through the building's front door (shut, the building turned 33 degrees), into
/// room r0a; then back out to the square.
#[test]
fn entry_a_walker_goes_from_the_open_ground_through_the_front_door_into_a_room() {
    let (mut t, nodes) = town();
    let h = t.tree.handle(nodes["door-building-front"]).unwrap();
    let door = replica::effects::read_id(t.tree.node(h).unwrap().fields().get(&F_DOORWAY).unwrap())
        .unwrap();
    let (from, floor, goal) = either_side(&t, door, 3_000_000);
    assert_eq!(floor, nodes["building/floor-0"]);
    println!("entry, test world: 3 m outside the front door to 3 m inside room r0a, and back");
    in_and_out(&mut t, from, floor, goal, door);
    let n = t.tree.node(h).unwrap();
    assert_eq!(
        n.fields().get(&F_OPEN),
        Some(&Value::Uint(1)),
        "the front door stands open"
    );
}

fn eden() -> Import {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    import_eden::load(&text).expect("Eden loads")
}

/// A thing's def, without its revision.
fn def_of(t: &Town, thing: Id) -> String {
    match t
        .tree
        .node(t.tree.handle(thing).unwrap())
        .unwrap()
        .fields()
        .get(&import_eden::F_DEF)
    {
        Some(Value::Bytes(d)) => String::from_utf8_lossy(d)
            .split('@')
            .next()
            .unwrap_or("")
            .to_owned(),
        _ => String::new(),
    }
}

/// The rooms of building `thing`: each one's floor and a spot on that floor near its middle (µm), in id order.
fn rooms_of(t: &Town, thing: Id) -> Vec<(Id, Id, Vec3)> {
    let mut out = Vec::new();
    let th = t.tree.handle(thing).unwrap();
    for &f in t.tree.children(th).unwrap() {
        let fnode = t.tree.node(f).unwrap();
        if !fnode.kind().as_str().starts_with("eden:floor") {
            continue;
        }
        for &r in t.tree.children(f).unwrap() {
            let rn = t.tree.node(r).unwrap();
            if !rn.kind().as_str().starts_with("eden:room") {
                continue;
            }
            let at = rn.place().unwrap().position;
            if let Some(s) = t.map.spot_near(fnode.id(), at, 2_000) {
                let p = Vec3::new(s.at[0] * 1000, s.at[1] * 1000, s.at[2] * 1000);
                out.push((rn.id(), fnode.id(), p));
            }
        }
    }
    out
}

/// Building entry in Eden: from 2 m outside a doorway between a building and the open ground, into a room whose way
/// in crosses a shut door (a `core-house` first; Eden places all but two of its doors open), and back out. Then,
/// for each of the 16 houses, which of its rooms a body with hands is routed to from outside.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn entry_eden_a_walker_goes_from_the_open_ground_through_a_shut_door_into_a_room() {
    let (mut t, _) = town_of(eden());
    let ground = t.ground;
    let mut entries: Vec<(bool, Id, Id)> = Vec::new();
    let (mut to_ground, mut with_door) = (0, 0);
    for b in &t.buildings {
        for l in &b.links {
            if l.ends.iter().any(|e| e.is_some_and(|e| e.floor == ground))
                && l.ends.iter().any(|e| e.is_some_and(|e| e.floor != ground))
            {
                to_ground += 1;
                with_door += usize::from(l.door.is_some());
                if l.blocked.is_none() {
                    entries.push((def_of(&t, b.thing) != "core-house", l.id, b.thing));
                }
            }
        }
    }
    entries.sort();
    println!(
        "entry, Eden: {to_ground} doorways between a building's floor and the open ground, {} crossable, {with_door} \
         with a door",
        entries.len()
    );
    // The first core-house doorway, and the first room behind it whose way in crosses a shut door.
    let mut pick = None;
    'find: for &(_, entry, thing) in &entries {
        let (from, ..) = either_side(&t, entry, 2_000_000);
        if t.map.spot(ground, from).is_none() {
            continue;
        }
        for (room, floor, goal) in rooms_of(&t, thing) {
            let me = stand(&t, id(1), ground, from);
            let Ok(legs) = t.plan(&me, floor, goal) else {
                continue;
            };
            let links: Vec<Id> = legs.iter().filter_map(|l| l.link).collect();
            let doors = links
                .iter()
                .filter(|k| {
                    t.buildings.iter().any(|b| {
                        b.link(**k).and_then(|l| l.door).is_some_and(|d| {
                            let n = t.tree.node(t.tree.handle(d).unwrap()).unwrap();
                            n.fields().get(&F_OPEN) != Some(&Value::Uint(1))
                        })
                    })
                })
                .count();
            if links.first() == Some(&entry) && doors > 0 {
                pick = Some((entry, thing, room, from, floor, goal));
                break 'find;
            }
        }
    }
    let (entry, thing, room, from, floor, goal) = pick.expect("a room behind a shut door");
    println!(
        "  {} ({}): 2 m outside doorway {} to room {} on {}, and back",
        show(thing),
        def_of(&t, thing),
        show(entry),
        show(room),
        show(floor)
    );
    in_and_out(&mut t, from, floor, goal, entry);
    // Each house: its rooms a body with hands is routed to from outside its first doorway to the open ground.
    let mut seen = std::collections::BTreeSet::new();
    let (mut reached, mut rooms) = (0, 0);
    let mut not = Vec::new();
    for &(_, entry, thing) in &entries {
        if def_of(&t, thing) != "core-house" || seen.contains(&thing) {
            continue;
        }
        let (from, ..) = either_side(&t, entry, 2_000_000);
        let Some(from) = t.map.spot(ground, from) else {
            continue;
        };
        seen.insert(thing);
        for (room, floor, goal) in rooms_of(&t, thing) {
            rooms += 1;
            let to = t.map.spot(floor, goal).unwrap();
            match t.map.route(&t.tree, from, to, sim::routes::HANDS) {
                Ok(_) => reached += 1,
                Err(e) => not.push(format!("{} room {}: {}", show(thing), show(room), e.detail)),
            }
        }
    }
    println!(
        "  core-house: {} houses, {reached} of {rooms} rooms routed to from outside",
        seen.len()
    );
    for n in &not {
        println!("    not routed: {n}");
    }
}

const EVEN: [usize; 4] = [100, 100, 100, 100];
const UNEVEN: [usize; 4] = [160, 120, 80, 40];

/// Where a side's `k`-th walker starts and where it goes: rows of 25 at 2.4 m, 1.5 m apart, from 1.5 m outside the
/// square's edge inwards; the goal is the same spot across the square.
fn spots(side: usize, k: usize) -> (Vec3, Vec3) {
    let along = -28_800_000 + (k % 25) as i64 * 2_400_000;
    let out = 31_500_000 - (k / 25) as i64 * 1_500_000;
    let (s, g) = match side {
        0 => ([-out, along], [out, along]),
        1 => ([out, along], [-out, along]),
        2 => ([along, out], [along, -out]),
        _ => ([along, -out], [along, out]),
    };
    (Vec3::new(s[0], 0, s[1]), Vec3::new(g[0], 0, g[1]))
}

struct Outcome {
    /// Per walker, its speed over its crossing as a share of free speed, in thousandths.
    shares: Vec<i64>,
    arrived: usize,
    close: u64,
    walked: u64,
    ns: u128,
    ticks: u64,
    fingerprint: Vec<(i64, i64)>,
}

fn crossing(arm: [usize; 4]) -> Outcome {
    let (mut t, _) = town();
    let ground = t.ground;
    let mut c = Crowd::new(TICK);
    let mut n = 0;
    let mut trips = BTreeMap::new();
    for (side, &count) in arm.iter().enumerate() {
        for k in 0..count {
            n += 1;
            let (s, g) = spots(side, k);
            let b = stand(&t, id(n), ground, s);
            c.add(&mut t, b, SPEED, id(10_000 + n), ground, g)
                .unwrap_or_else(|e| panic!("no plan: {}: {}", e.name, e.detail));
            trips.insert(id(n), (s, g));
        }
    }
    let cap = 3_000; // 150 s of world time
    let t0 = std::time::Instant::now();
    let mut ticks = 0;
    while ticks < cap && !c.done() {
        c.step(&mut t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
        ticks += 1;
    }
    let ns = t0.elapsed().as_nanos();
    let flat = |a: Vec3, b: Vec3| {
        (((a.x - b.x) as i128).pow(2) + ((a.z - b.z) as i128).pow(2)).isqrt() as i64
    };
    let mut shares = Vec::new();
    let mut fingerprint = Vec::new();
    for w in &c.walkers {
        let (s, g) = trips[&w.body.id];
        let whole = flat(s, g);
        let share = match w.arrived {
            Some(at) => {
                (i128::from(whole) * 1_000_000_000 / (i128::from(at.max(1)) * i128::from(SPEED)))
                    as i64
            }
            None => {
                let gone = whole - flat(w.body.pose.position, g);
                (i128::from(gone) * 1_000_000_000 / (i128::from(c.now) * i128::from(SPEED))) as i64
            }
        };
        shares.push(share);
        fingerprint.push((w.body.pose.position.x, w.body.pose.position.z));
    }
    Outcome {
        arrived: c.walkers.iter().filter(|w| w.arrived.is_some()).count(),
        shares,
        close: c.close,
        walked: c.walked,
        ns,
        ticks,
        fingerprint,
    }
}

fn pct(v: &[i64], p: usize) -> i64 {
    let mut s = v.to_vec();
    s.sort();
    s[(s.len() - 1) * p / 100]
}

/// A1, A2 and A5: the crossings of the square, even and uneven, two repeats each.
#[test]
fn a1_a2_a5_four_hundred_walkers_cross_the_square() {
    let mut even = Vec::new();
    for (name, arm) in [("even", EVEN), ("uneven", UNEVEN)] {
        for repeat in 1..=2 {
            let o = crossing(arm);
            println!(
                "{name} {arm:?}, repeat {repeat}: {} of {} arrived in {} ticks; speed share median {}.{} %, 5th percentile {}.{} %; close walker-ticks {} of {} ({}.{:02} %); {} ns a walker-tick ({} ms in all)",
                o.arrived,
                o.shares.len(),
                o.ticks,
                pct(&o.shares, 50) / 10,
                pct(&o.shares, 50) % 10,
                pct(&o.shares, 5) / 10,
                pct(&o.shares, 5) % 10,
                o.close,
                o.walked,
                o.close * 100 / o.walked.max(1),
                o.close * 10_000 / o.walked.max(1) % 100,
                o.ns / u128::from(o.walked.max(1)),
                o.ns / 1_000_000
            );
            if name == "even" {
                even.push(o);
            }
        }
    }
    // The same seedless run twice gives the same walk (integers only).
    assert_eq!(even[0].fingerprint, even[1].fingerprint);
    for o in &even {
        assert!(
            pct(&o.shares, 50) >= 600,
            "A1: median below 60 % of free speed"
        );
        assert!(
            o.close * 50 < o.walked,
            "A2: 2 % or more walker-ticks close"
        );
    }
}
