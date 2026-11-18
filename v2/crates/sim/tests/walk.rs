//! The walk skill and keeping apart (Engine v2 N7, #2655) on N2's test world.
//!
//! `cargo test -p sim --release --test walk -- --nocapture` runs the walker through three shut doors (A3, and step 0:
//! one walker, door to door), the skill on a world of its own (A4) and the crossings of the square (A1, A2, A5): 400
//! walkers, 100 from each side (the even arm, held to the bars), then the uneven arm declared here before the run, 160
//! from the west, 120 from the east, 80 from the north and 40 from the south (reported, no bar); two repeats each.
//! The walkers run N7's walk skill (`skills::route`) through the host (T9c #3127).

// Times its own runs: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

mod common;

use common::{arrived, dist, id, stand, walk};
use import_eden::{F_DOORWAY, Import};
use replica::effects::{Actor, Body as EffectBody, Cause, Change, Event, Refusal};
use replica::encode::{Name, Value};
use replica::host::{Answer, Ask, Host, Near, Progress, Seen, Skill};
use replica::ids::Id;
use replica::pose::{ControllerInput, Vec3};
use replica::time::Micros;
use replica::world_model::show;
use sim::host::Runner;
use sim::links::{DOOR_OPENED, F_OPEN};
use sim::mover::Body;
use sim::walk::town::Town;
use sim::walk::{Leg, World, node_of};
use std::collections::BTreeMap;

const SPEED: i64 = 1_400_000; // µm a second: today's walking pace
const TICK: i64 = 50_000; // µs: 20 ticks a second

/// Two centres closer than this, µm, are an overlap (measured, never prevented).
const CLOSE: i64 = 420_000;

/// The test world as a town, with a door writer, and its named nodes.
fn town() -> (Town, BTreeMap<String, Id>) {
    common::town(b"souls/walk-test/1")
}

/// A loaded world as a town, with a door writer, and its named nodes.
fn town_of(im: Import) -> (Town, BTreeMap<String, Id>) {
    common::town_of(im, b"souls/walk-test/1")
}

fn run(t: &mut Town, c: &mut Runner, ticks: u64) {
    for _ in 0..ticks {
        if c.runs.is_empty() {
            break;
        }
        c.tick(t)
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
    let mut c = Runner::new(TICK);
    let legs = walk(&mut c, &mut t, me, SPEED, f1, goal)
        .unwrap_or_else(|e| panic!("no plan: {}: {}", e.name, e.detail));
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
    let w = *c.controller.body(id(1)).unwrap();
    let arrived = arrived(&c, id(1)).expect("the walker arrives");
    let p = w.pose.position;
    println!(
        "A3: arrived at {} ms of world time ({} ticks, {} us of run time), at ({}, {}, {}) mm on {}",
        arrived / 1000,
        arrived / TICK,
        t0.elapsed().as_micros(),
        p.x / 1000,
        p.y / 1000,
        p.z / 1000,
        show(node_of(&w))
    );
    assert_eq!(node_of(&w), f1);
    // The next corner at a fixed cost (#3167): the line is kept from its search, so lines are searched for a few
    // times a leg, never once a tick.
    let s = t.spent.get();
    let lines = s.lines_new + s.lines_off + s.lines_end + s.lines_blocked;
    println!(
        "A3 corners: {} calls, {lines} lines searched for ({} new, {} off, {} at a piece's end, {} refused), {} route searches",
        s.corners, s.lines_new, s.lines_off, s.lines_end, s.lines_blocked, s.searches
    );
    assert!(
        lines >= legs.len() as u64 && lines <= 3 * legs.len() as u64,
        "{lines} lines for {} legs",
        legs.len()
    );
    assert!(
        s.corners >= 10 * lines,
        "{} corner calls for {lines} lines",
        s.corners
    );
    // Each door crossed opened once, by the world for this walker, in the order crossed.
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
            "  #{} at {} us: {} on door {} of link {} ({} change, field {F_OPEN} to 1), for the walker",
            e.envelope.sequence,
            e.envelope.at,
            ev.name.as_str(),
            show(e.envelope.node),
            show(link),
            ch.len(),
        );
        assert_eq!(ev.name.as_str(), DOOR_OPENED);
        // The world opens a shut door for the walker (T9b, rule 7), the walker as the acting Soul.
        assert_eq!(e.envelope.cause, Cause::World);
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

/// A flat world of its own: one square plane, straight lines, no links, its own bodies. The skill runs on it unchanged,
/// through its own `Host`.
struct Plane {
    half: i64,
    now: Micros,
    /// Positions and velocities as of the tick's start.
    bodies: BTreeMap<Id, (Vec3, Vec3)>,
}

/// The plane as one body's skill sees it in a tick.
struct OnPlane<'a> {
    plane: &'a Plane,
    me: Id,
    input: Option<ControllerInput>,
}

impl Host for OnPlane<'_> {
    fn now(&self) -> Micros {
        self.plane.now
    }
    fn body(&self) -> Id {
        self.me
    }
    fn read(&self, node: Id) -> Option<Seen> {
        let (p, _) = *self.plane.bodies.get(&node)?;
        Some(Seen {
            id: node,
            kind: Name::new("test:body").unwrap(),
            parent: None,
            position: p,
            fields: BTreeMap::new(),
        })
    }
    fn ask(&self, q: &Ask) -> Option<Answer> {
        let (me, _) = self.plane.bodies[&self.me];
        match q {
            Ask::Toward { to, .. } => Some(Answer::Point(*to)),
            Ask::Near { radius } => Some(Answer::Near(
                self.plane
                    .bodies
                    .iter()
                    .filter(|(k, (p, _))| **k != self.me && dist(*p, me) < *radius)
                    .map(|(k, (p, v))| Near {
                        id: *k,
                        position: *p,
                        velocity: *v,
                    })
                    .collect(),
            )),
            Ask::Distance { .. } => None,
        }
    }
    fn set_timer(&mut self, _: Micros, _: Name) -> Id {
        self.me
    }
    fn clear_timer(&mut self, _: Id) {}
    fn draw(&mut self) -> u64 {
        0
    }
    fn control(&mut self, input: ControllerInput) {
        self.input = Some(input);
    }
    fn cross(&mut self, _: Id, _: i64) {}
    fn emit(&mut self, _: Vec<Change>, _: Option<Event>) -> Result<(), Refusal> {
        Ok(())
    }
}

/// A4: the skill reaches the world only through `Host`: the same walk skill walks two bodies head-on across a plane
/// that is no part of the engine, and they pass.
#[test]
fn a4_the_skill_runs_on_any_world_through_its_one_trait() {
    let mut w = Plane {
        half: 20_000_000,
        now: 0,
        bodies: BTreeMap::new(),
    };
    type Walking = (Id, Box<dyn Skill>, Option<Micros>);
    let mut skills: Vec<Walking> = Vec::new();
    for (n, x) in [(1, -10_000_000), (2, 10_000_000)] {
        w.bodies.insert(id(n), (Vec3::new(x, 0, 0), Vec3::ZERO));
        let legs = [Leg {
            to: Vec3::new(-x, 0, 0),
            link: None,
        }];
        skills.push((id(n), common::route(&legs, SPEED, TICK), None));
    }
    let mut nearest = i64::MAX;
    for _ in 0..1_000 {
        if skills.iter().all(|s| s.2.is_some()) {
            break;
        }
        let mut inputs = Vec::new();
        for (me, skill, done) in skills.iter_mut().filter(|s| s.2.is_none()) {
            let mut h = OnPlane {
                plane: &w,
                me: *me,
                input: None,
            };
            if skill.step(&mut h) == Progress::Done {
                *done = Some(w.now);
            }
            inputs.push((*me, h.input));
        }
        for (me, input) in inputs {
            let v = input.map_or(Vec3::ZERO, |i| i.velocity);
            let (p, _) = w.bodies[&me];
            let c = |a: i64, d: i64| (a + d * TICK / 1_000_000).clamp(-w.half, w.half);
            w.bodies
                .insert(me, (Vec3::new(c(p.x, v.x), 0, c(p.z, v.z)), v));
        }
        w.now += TICK;
        let (a, b) = (w.bodies[&id(1)].0, w.bodies[&id(2)].0);
        nearest = nearest.min(dist(a, b));
    }
    println!(
        "A4: two walkers head-on on a plane of their own: arrived at {:?} ms, nearest {} mm",
        skills
            .iter()
            .map(|s| s.2.map(|a| a / 1000))
            .collect::<Vec<_>>(),
        nearest / 1000,
    );
    assert!(skills.iter().all(|s| s.2.is_some()));
    assert!(nearest >= CLOSE, "they pass apart");
}

/// The arms: walkers from each side, (west, east, north, south).
/// The world-frame position of a body: on the open ground as it stands, on a floor through its building's place.
fn world_at(t: &Town, b: &Body) -> Vec3 {
    let node = node_of(b);
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
fn doors_on(t: &Town, legs: &[Leg]) -> Vec<Id> {
    legs.iter()
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

/// Walks the runner's one walker `who` until it arrives; returns the largest step it took in the world's frame, µm.
fn walk_one(t: &mut Town, c: &mut Runner, who: Id) -> i64 {
    let mut largest = 0;
    let mut was = world_at(t, c.controller.body(who).unwrap());
    for _ in 0..4_000 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(t).unwrap_or_else(|e| {
            let b = c.controller.body(who).unwrap();
            panic!(
                "refused: {}: {} (carried across {:?} at {:?} on {})",
                e.name,
                e.detail,
                c.controller.carrying(who),
                b.pose.position,
                show(node_of(b))
            )
        });
        let now = world_at(t, c.controller.body(who).unwrap());
        largest = largest.max(dist(now, was));
        was = now;
    }
    largest
}

/// One walker from `from` on the open ground to `goal` on `floor`, and back out to where it started. The way in
/// first crosses `entry`, a doorway between the building and the open ground, and the way out last; each shut door
/// on the way in opens once, by the walker's order, in the order crossed (`eden:door_opened` in the stream), and the
/// way out opens none. No tick moves the body further in the world's frame than its speed allows.
fn in_and_out(t: &mut Town, from: Vec3, floor: Id, goal: Vec3, entry: Id) {
    let ground = t.ground;
    let me = stand(t, id(1), ground, from);
    let before = t.doors.stream.len();
    let mut c = Runner::new(TICK);
    let legs = walk(&mut c, t, me, SPEED, floor, goal)
        .unwrap_or_else(|e| panic!("no plan in: {}: {}", e.name, e.detail));
    let links: Vec<Id> = legs.iter().filter_map(|l| l.link).collect();
    assert_eq!(links.first(), Some(&entry), "in: the entry first");
    println!(
        "  in: legs cross {}",
        links
            .iter()
            .map(|k| show(*k))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let doors = doors_on(t, &legs);
    let reach = SPEED * TICK / 1_000_000;
    let mut largest = walk_one(t, &mut c, id(1));
    let w = *c.controller.body(id(1)).unwrap();
    let arrived_in = arrived(&c, id(1)).unwrap_or_else(|| {
        panic!(
            "the walker arrives in the room: legs {:?}, ended {:?}, at {:?} on {}, goal {:?}, from {:?}",
            legs,
            c.ended.get(&id(1)),
            w.pose.position,
            show(node_of(&w)),
            goal,
            from
        )
    });
    assert_eq!(node_of(&w), floor, "in: on the room's floor");
    let mut opened = Vec::new();
    for e in &t.doors.stream[before..] {
        let ev = &e.events.as_ref().unwrap()[0];
        assert_eq!(ev.name.as_str(), DOOR_OPENED);
        assert_eq!(e.envelope.cause, Cause::World);
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
        w.pose.position.x / 1000,
        w.pose.position.y / 1000,
        w.pose.position.z / 1000,
    );
    // And back out, through the doors now open: a new walk for the same body.
    let legs = walk(&mut c, t, w, SPEED, ground, from)
        .unwrap_or_else(|e| panic!("no plan out: {}: {}", e.name, e.detail));
    let links: Vec<Id> = legs.iter().filter_map(|l| l.link).collect();
    assert_eq!(links.last(), Some(&entry), "out: the entry last");
    largest = largest.max(walk_one(t, &mut c, id(1)));
    let w = *c.controller.body(id(1)).unwrap();
    let arrived_out = arrived(&c, id(1)).expect("the walker arrives back on the open ground");
    assert_eq!(node_of(&w), ground, "out: on the open ground");
    assert_eq!(
        t.doors.stream.len(),
        before + opened.len(),
        "out: the doors were open"
    );
    println!(
        "  out: arrived at {} ms on the open ground at ({}, {}) mm; largest step in the world's frame {} um, bar {} um",
        arrived_out / 1000,
        w.pose.position.x / 1000,
        w.pose.position.z / 1000,
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

/// Walks the runner's one walker `who` until it arrives, checking each tick: off a link, the body stands on its node's
/// patch (within 2 mm, the grid's rounding); on one, within 2 mm of the link's line in the world's frame. Returns the
/// largest step it took in the world's frame, µm.
fn walk_on_ground(t: &mut Town, c: &mut Runner, who: Id) -> i64 {
    let mut largest = 0;
    let mut was = world_at(t, c.controller.body(who).unwrap());
    for _ in 0..4_000 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
        let b = *c.controller.body(who).unwrap();
        let now = world_at(t, &b);
        if let Some(link) = c.controller.carrying(who) {
            let bl = t.buildings.iter().find(|b| b.link(link).is_some()).unwrap();
            let line: Vec<Vec3> = bl
                .link(link)
                .unwrap()
                .line
                .iter()
                .map(|p| bl.place.point(*p).unwrap())
                .collect();
            let off = line
                .windows(2)
                .map(|s| {
                    let (a, e) = (s[0], s[1]);
                    let l2 = i128::from(dist(a, e)).pow(2).max(1);
                    let k = (i128::from(now.x - a.x) * i128::from(e.x - a.x)
                        + i128::from(now.y - a.y) * i128::from(e.y - a.y)
                        + i128::from(now.z - a.z) * i128::from(e.z - a.z))
                    .clamp(0, l2);
                    let at = |u: i64, v: i64| u + (i128::from(v - u) * k / l2) as i64;
                    dist(now, Vec3::new(at(a.x, e.x), at(a.y, e.y), at(a.z, e.z)))
                })
                .min()
                .unwrap();
            assert!(
                off <= 2_000,
                "on link {}: {off} um off its line",
                show(link)
            );
        } else {
            let node = node_of(&b);
            assert!(
                t.map.spot_near(node, b.pose.position, 2).is_some(),
                "off {}'s patch at {:?}",
                show(node),
                b.pose.position
            );
        }
        largest = largest.max(dist(now, was));
        was = now;
    }
    largest
}

/// The kind of the link `k` among the town's buildings.
fn link_kind(t: &Town, k: Id) -> sim::links::Kind {
    t.buildings.iter().find_map(|b| b.link(k)).unwrap().kind
}

/// Porch steps in Eden (N18's follow-up): a shop's crossable doorway to the open ground opens onto its porch, 100 mm
/// up, whose open edge is a step to the ground. A walker from 2 m outside a step goes in across it to a room of the
/// shop and back out across a step; every tick stands on a patch or on a link's line, and no tick is longer than its
/// speed allows.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn steps_eden_a_walker_steps_up_onto_a_porch_into_a_shop_and_back() {
    let (mut t, _) = town_of(eden());
    let ground = t.ground;
    let steps: Vec<(Id, Id)> = t
        .buildings
        .iter()
        .flat_map(|b| b.links.iter().map(move |l| (l, b.thing)))
        .filter(|(l, _)| l.kind == sim::links::Kind::Step)
        .map(|(l, th)| (l.id, th))
        .collect();
    let shops = steps
        .iter()
        .filter(|(_, th)| def_of(&t, *th) == "core-shop")
        .count();
    println!(
        "steps, Eden: {} crossable steps, {shops} of them off a core-shop's floor",
        steps.len()
    );
    let (step, thing) = *steps
        .iter()
        .find(|(_, th)| def_of(&t, *th) == "core-shop")
        .expect("a shop's step");
    let (from, ..) = either_side(&t, step, 2_000_000);
    let (_, floor, goal) = rooms_of(&t, thing)
        .into_iter()
        .find(|(_, f, _)| {
            t.buildings.iter().any(|b| {
                b.link(step)
                    .is_some_and(|l| l.ends[0].is_some_and(|e| e.floor == *f))
            })
        })
        .expect("a room on the step's floor");
    let me = stand(&t, id(1), ground, from);
    let mut c = Runner::new(TICK);
    let legs = walk(&mut c, &mut t, me, SPEED, floor, goal)
        .unwrap_or_else(|e| panic!("no plan in: {}: {}", e.name, e.detail));
    let links: Vec<Id> = legs.iter().filter_map(|l| l.link).collect();
    println!(
        "  {} (core-shop): in across {}",
        show(thing),
        links
            .iter()
            .map(|k| format!("{:?} {}", link_kind(&t, *k), show(*k)))
            .collect::<Vec<_>>()
            .join(", ")
    );
    assert_eq!(
        link_kind(&t, links[0]),
        sim::links::Kind::Step,
        "in: a step first"
    );
    let reach = SPEED * TICK / 1_000_000;
    let mut largest = walk_on_ground(&mut t, &mut c, id(1));
    let body = *c.controller.body(id(1)).unwrap();
    let arrived_in = arrived(&c, id(1)).expect("the walker arrives in the shop");
    assert_eq!(node_of(&body), floor, "in: on the shop's floor");
    let legs = walk(&mut c, &mut t, body, SPEED, ground, from)
        .unwrap_or_else(|e| panic!("no plan out: {}: {}", e.name, e.detail));
    let out: Vec<Id> = legs.iter().filter_map(|l| l.link).collect();
    assert_eq!(
        link_kind(&t, *out.last().unwrap()),
        sim::links::Kind::Step,
        "out: a step last"
    );
    largest = largest.max(walk_on_ground(&mut t, &mut c, id(1)));
    let w = *c.controller.body(id(1)).unwrap();
    let arrived_out = arrived(&c, id(1)).expect("the walker arrives back on the open ground");
    assert_eq!(node_of(&w), ground, "out: on the open ground");
    println!(
        "  in at {} ms, out at {} ms; largest step in the world's frame {largest} um, bar {reach} um",
        arrived_in / 1000,
        arrived_out / 1000
    );
    assert!(
        largest <= reach + 10,
        "no tick longer than speed times the tick"
    );
}

/// Eden's bridges (#3224): a deck of flat quads, each 100 to 145 mm above the last, joined by steps inside the floor
/// and stepped onto from the ground at an end. A walker from 2 m beyond one end walks over the bridge to 2 m beyond
/// the other, crossing every step of the deck; where an end has no ground to step down to, it walks to the deck's far
/// end and back. Every tick stands on a patch or on a link's line, and no tick is longer than its speed allows.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn bridges_eden_a_walker_walks_over_each_bridge_end_to_end() {
    let (mut t, _) = town_of(eden());
    let ground = t.ground;
    let reach = SPEED * TICK / 1_000_000;
    let bridges: Vec<(Id, Id, Vec<Id>, usize)> = t
        .buildings
        .iter()
        .filter(|b| def_of(&t, b.thing) == "core-bridge")
        .map(|b| {
            let floor = *b.floors.keys().next().expect("a deck");
            let to_ground: Vec<Id> = b
                .links
                .iter()
                .filter(|l| l.kind == sim::links::Kind::Step && l.nodes.contains(&ground))
                .map(|l| l.id)
                .collect();
            let inner = b
                .links
                .iter()
                .filter(|l| l.kind == sim::links::Kind::Step && l.nodes == [floor, floor])
                .count();
            (b.thing, floor, to_ground, inner)
        })
        .collect();
    assert_eq!(bridges.len(), 4, "Eden's four bridges");
    let mut n = 0;
    for (thing, floor, to_ground, inner) in bridges {
        println!(
            "{}: {} steps to the ground, {inner} steps inside the deck",
            show(thing),
            to_ground.len()
        );
        let (from, ..) = either_side(&t, to_ground[0], 2_000_000);
        let (goal_node, goal) = match to_ground.get(1) {
            Some(&s) => (ground, either_side(&t, s, 2_000_000).0),
            None => {
                // The deck's far end: its lowest piece farthest from where the walker starts.
                let (pieces, ..) = t.map.counts();
                let place = t.buildings.iter().find(|b| b.thing == thing).unwrap().place;
                let qs: Vec<u32> = (0..pieces as u32)
                    .filter(|&q| t.map.patch_of(q).node == floor)
                    .collect();
                let low = qs.iter().map(|&q| t.map.standing(q)[0][1]).min().unwrap();
                let at = qs
                    .iter()
                    .filter(|&&q| t.map.standing(q)[0][1] == low)
                    .map(|&q| t.map.standing(q)[0])
                    .max_by_key(|p| {
                        let w = place
                            .point(Vec3::new(p[0] * 1000, p[1] * 1000, p[2] * 1000))
                            .unwrap();
                        dist(w, from)
                    })
                    .unwrap();
                (floor, Vec3::new(at[0] * 1000, at[1] * 1000, at[2] * 1000))
            }
        };
        n += 1;
        let who = id(100 + n);
        let me = stand(&t, who, ground, from);
        let mut c = Runner::new(TICK);
        let legs = walk(&mut c, &mut t, me, SPEED, goal_node, goal)
            .unwrap_or_else(|e| panic!("no plan over {}: {}: {}", show(thing), e.name, e.detail));
        let links: Vec<Id> = legs.iter().filter_map(|l| l.link).collect();
        let on_deck = links
            .iter()
            .filter(|k| {
                t.buildings
                    .iter()
                    .find_map(|b| b.link(**k))
                    .is_some_and(|l| l.nodes == [floor, floor])
            })
            .count();
        let largest = walk_on_ground(&mut t, &mut c, who);
        let w = *c.controller.body(who).unwrap();
        let arrived = arrived(&c, who).expect("the walker arrives");
        assert_eq!(node_of(&w), goal_node, "where it was going");
        let at = world_at(&t, &w);
        println!(
            "  from ({}, {}) m to ({}, {}, {}) m on {}: across {} links ({on_deck} of them the deck's steps) in {} ms; largest step {largest} um, bar {reach} um",
            from.x / 1_000_000,
            from.z / 1_000_000,
            at.x / 1_000_000,
            at.y / 1_000_000,
            at.z / 1_000_000,
            if goal_node == ground {
                "the ground"
            } else {
                "the deck"
            },
            links.len(),
            arrived / 1000
        );
        assert_eq!(on_deck, inner, "every step of the deck crossed");
        assert!(
            largest <= reach + 10,
            "no tick longer than speed times the tick"
        );
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
    let mut c = Runner::new(TICK);
    let mut n = 0;
    let mut trips = BTreeMap::new();
    for (side, &count) in arm.iter().enumerate() {
        for k in 0..count {
            n += 1;
            let (s, g) = spots(side, k);
            let b = stand(&t, id(n), ground, s);
            walk(&mut c, &mut t, b, SPEED, ground, g)
                .unwrap_or_else(|e| panic!("no plan: {}: {}", e.name, e.detail));
            trips.insert(id(n), (s, g));
        }
    }
    let cap = 3_000; // 150 s of world time
    let t0 = std::time::Instant::now();
    let mut ticks = 0;
    // The overlap measure, on where the bodies stand after each tick: walker-ticks walked (a walk not yet arrived,
    // not carried across a link), and of them the ones with another centre closer than CLOSE on the same node.
    let (mut walked, mut close) = (0u64, 0u64);
    while ticks < cap && !c.runs.is_empty() {
        c.tick(&mut t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
        ticks += 1;
        for r in &c.runs {
            if c.controller.carried(r.body) {
                continue;
            }
            walked += 1;
            if !c.near(r.body, CLOSE).is_empty() {
                close += 1;
            }
        }
    }
    let ns = t0.elapsed().as_nanos();
    let flat = |a: Vec3, b: Vec3| {
        (((a.x - b.x) as i128).pow(2) + ((a.z - b.z) as i128).pow(2)).isqrt() as i64
    };
    let mut shares = Vec::new();
    let mut fingerprint = Vec::new();
    for w in c.controller.bodies() {
        let (s, g) = trips[&w.id];
        let whole = flat(s, g);
        let share = match arrived(&c, w.id) {
            Some(at) => {
                (i128::from(whole) * 1_000_000_000 / (i128::from(at.max(1)) * i128::from(SPEED)))
                    as i64
            }
            None => {
                let gone = whole - flat(w.pose.position, g);
                (i128::from(gone) * 1_000_000_000 / (i128::from(c.now) * i128::from(SPEED))) as i64
            }
        };
        shares.push(share);
        fingerprint.push((w.pose.position.x, w.pose.position.z));
    }
    Outcome {
        arrived: c
            .controller
            .bodies()
            .filter(|w| arrived(&c, w.id).is_some())
            .count(),
        shares,
        close,
        walked,
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
