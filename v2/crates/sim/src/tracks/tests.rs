//! N14's acceptance (#2738): T4's thrown fixture (`v2/crates/replica/fixtures/pose/thrown.diag`: from 1.5 m up at
//! 8 m/s across and 6 m/s up, under 9.80665 m/s²) thrown from one slot of a node to another, through K9's due list at
//! 20 ticks a second, written as entries and applied to K2's tree. `cargo test -p sim tracks -- --nocapture`.

use super::*;
use crate::timers::DueList;
use replica::effects::{
    Actor, Body, Cause, ChangeRec, Effect, Envelope, FIXTURE_HEADER, Header, Part, Rest, TimerRec,
    fixture_bytes,
};
use replica::encode::{Value, encode};
use replica::ids::Scope;
use replica::pose::Quat;
use replica::tree::Tree;
use replica::world_model::Audience;
use std::collections::BTreeMap;

const TICK: Micros = 50_000;
const T0: Micros = 1_000_000;
const THING: u64 = 50;
const FLOOR: u64 = 60;
const WALL: u64 = 61;
const TIMER: u64 = 70;

fn ee(n: u64) -> Id {
    Id::new(Scope([0xee; 16]), n).unwrap()
}

fn header() -> Header {
    Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap()
}

/// The thrower's slot (1) and the thing in it.
const FROM: Vec3 = Vec3 {
    x: 0,
    y: 1_500_000,
    z: 0,
};
const VELOCITY: Vec3 = Vec3 {
    x: 8_000_000,
    y: 6_000_000,
    z: 0,
};
const GRAVITY: Vec3 = Vec3 {
    x: 0,
    y: -9_806_650,
    z: 0,
};
/// Where T4's fixture puts it 1 s after the throw: the catcher's slot (2) is there.
const AT_ONE_SECOND: Vec3 = Vec3 {
    x: 8_000_000,
    y: 2_596_675,
    z: 0,
};

fn geometry(wall_top: Option<i64>) -> Geometry {
    Geometry {
        solids: wall_top
            .map(|top| Solid {
                id: ee(WALL),
                min: Vec3::new(4_000_000, 0, -5_000_000),
                max: Vec3::new(4_100_000, top, 5_000_000),
            })
            .into_iter()
            .collect(),
        floor: ee(FLOOR),
        floor_y: 0,
        min: Vec3::new(-50_000_000, -1_000_000, -50_000_000),
        max: Vec3::new(50_000_000, 50_000_000, 50_000_000),
    }
}

fn held(root: Id) -> Pose {
    Pose {
        frame: Frame {
            node: root,
            slot: Some(1),
        },
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        support: Support::Slot,
    }
}

/// A throw from slot 1 toward a catcher's slot 2 at `hand` (10 cm reach), past a wall `wall_top` high if any.
fn throw(root: Id, hand: Vec3, wall_top: Option<i64>) -> Flight {
    let catch = Catch {
        slot: 2,
        point: hand,
        reach: 100_000,
    };
    Flight::throw(
        ee(THING),
        held(root),
        FROM,
        T0,
        VELOCITY,
        GRAVITY,
        Vec3::ZERO,
        &geometry(wall_top),
        Some(catch),
    )
    .unwrap()
}

/// A run: the tree, the parts written (one per tick that wrote anything) and the ticks that did any work.
struct Run {
    header: Header,
    tree: Tree,
    next: u64,
    parts: Vec<Part>,
    entries: Vec<Effect>,
    worked: Vec<i64>,
}

impl Run {
    /// The node's root, and the thing created in its slot 1 at world time 0.
    fn new() -> Run {
        let header = header();
        let tree = Tree::start(header.zone, header.kinds[0].clone());
        let next = tree.to_state().next;
        let mut run = Run {
            tree,
            next,
            parts: Vec::new(),
            entries: Vec::new(),
            worked: Vec::new(),
            header,
        };
        let create = Change::Create {
            node: ee(THING),
            kind: run.header.kinds[3].clone(),
            pose: held(run.header.zone),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        let root = run.header.zone;
        let e = run.entry(root, 0, Body::Changes(rec(vec![create])));
        run.commit(vec![e]);
        run
    }

    fn entry(&mut self, node: Id, at: Micros, body: Body) -> Effect {
        let e = Effect {
            envelope: Envelope {
                sequence: self.next,
                at,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node,
            },
            body,
            events: None,
            rest: Rest::new(),
        };
        self.next += 1;
        e
    }

    fn commit(&mut self, entries: Vec<Effect>) {
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(entries.iter().map(Effect::to_value).collect()),
            ),
        ]));
        let part = Part::read(&encode(&v).unwrap()).unwrap();
        self.tree.apply(&self.header, &part).unwrap();
        self.parts.push(part);
        self.entries.extend(entries);
    }

    /// Throws `flight` at its start, then runs ticks until the due list is empty: each tick fires what is due in it.
    fn fly(&mut self, flight: Flight, geometry: &Geometry) {
        let thing = flight.node;
        let mut due = DueList::new();
        let mut ids = TIMER;
        let timer = flight.timer(ee(ids)).unwrap();
        let start = Body::Changes(rec(flight.start(held(self.header.zone).frame).unwrap()));
        let start = self.entry(thing, T0, start);
        let armed = self.entry(thing, T0, set(&timer));
        due.set(timer).unwrap();
        self.commit(vec![start, armed]);
        self.worked.push(T0 / TICK);
        let mut flights = BTreeMap::from([(ee(ids), flight)]);
        let mut tick = T0 / TICK;
        while !due.is_empty() {
            let mut written = Vec::new();
            while let Some(t) = due.fire((tick + 1) * TICK) {
                let f = flights.remove(&t.id).unwrap();
                let (changes, then) = f.finish(geometry).unwrap();
                written.push(self.entry(thing, t.due, clear(t.id)));
                written.push(self.entry(thing, t.due, Body::Changes(rec(changes))));
                if let Some(drop) = then {
                    ids += 1;
                    let timer = drop.timer(ee(ids)).unwrap();
                    written.push(self.entry(thing, t.due, set(&timer)));
                    due.set(timer).unwrap();
                    flights.insert(ee(ids), drop);
                }
            }
            if !written.is_empty() {
                self.worked.push(tick);
                self.commit(written);
            }
            tick += 1;
        }
    }

    /// The thing's place and owner as the tree holds them.
    fn held_now(&self) -> (Pose, Owner) {
        let n = self
            .tree
            .node(self.tree.handle(ee(THING)).unwrap())
            .unwrap();
        let place = n.place().unwrap();
        let frame = Frame {
            node: n.parent().unwrap(),
            slot: n.slot(),
        };
        let pose = Pose {
            frame,
            position: place.position,
            orientation: place.orientation,
            support: place.support,
        };
        (pose, n.moved().map_or(Owner::Slot, |m| m.owner))
    }

    /// What the log says of the thing: (kind of entry, world time), in order.
    fn log(&self) -> Vec<(&'static str, Micros)> {
        self.entries
            .iter()
            .filter(|e| e.envelope.node == ee(THING))
            .map(|e| {
                let kind = match &e.body {
                    Body::Changes(_) => "effect",
                    Body::Timers(_) => "timer",
                    _ => "other",
                };
                (kind, e.envelope.at)
            })
            .collect()
    }
}

fn rec(changes: Vec<Change>) -> Vec<ChangeRec> {
    changes
        .into_iter()
        .map(|change| ChangeRec {
            change,
            rest: Rest::new(),
        })
        .collect()
}

fn set(t: &Timer) -> Body {
    Body::Timers(vec![TimerRec::Set {
        timer: t.id,
        due: t.due,
        name: t.name.clone(),
    }])
}

fn clear(id: Id) -> Body {
    Body::Timers(vec![TimerRec::Clear { timer: id }])
}

#[test]
fn the_path_is_t4s_thrown_fixture() {
    let f = throw(header().zone, AT_ONE_SECOND, None);
    assert_eq!(f.at(T0).unwrap(), FROM);
    assert_eq!(f.at(T0 + 1_000_000).unwrap(), AT_ONE_SECOND);
}

#[test]
fn a1_a_throw_and_catch_is_one_track_two_effects() {
    let mut run = Run::new();
    let f = throw(run.header.zone, AT_ONE_SECOND, None);
    run.fly(f, &geometry(None));
    let log = run.log();
    println!(
        "A1: the thing's log: {log:?}; ends {:?} at {} µs",
        f.end.ends, f.end.at
    );
    assert_eq!(f.end.ends, Ends::Caught { slot: 2 });
    let effects: Vec<_> = log.iter().filter(|(k, _)| *k == "effect").collect();
    assert_eq!(effects.len(), 2, "one effect at the start, one at the end");
    assert_eq!(effects[0].1, T0);
    assert_eq!(effects[1].1, f.end.at);
    assert_eq!(
        log,
        vec![
            ("effect", T0),
            ("timer", T0),
            ("timer", f.end.at),
            ("effect", f.end.at)
        ],
        "nothing between the start and the end"
    );
    let Body::Changes(start) = &run.entries[1].body else {
        panic!("the start is changes");
    };
    let Change::Motion(h) = &start[1].change else {
        panic!("the start hands off");
    };
    assert_eq!((h.from, h.to), (Owner::Slot, Owner::Track(f.track)));
    assert_eq!(h.linear, VELOCITY);
    let (pose, owner) = run.held_now();
    println!("A1: caught: {pose:?}, owner {owner:?}");
    assert_eq!(owner, Owner::Slot);
    assert_eq!(pose.frame.slot, Some(2));
    assert!(
        f.end.position.apart(AT_ONE_SECOND) <= 100_000,
        "caught within reach"
    );
    assert_eq!(
        pose.position,
        f.end.position.minus(AT_ONE_SECOND).unwrap(),
        "it keeps its position: no jump into the hand"
    );
}

#[test]
fn a2_a_replay_shows_the_same_positions_to_the_unit() {
    let mut run = Run::new();
    let f = throw(run.header.zone, AT_ONE_SECOND, None);
    run.fly(f, &geometry(None));
    // Replay: a fresh tree from the same bytes, part by part.
    let mut replay = Tree::start(run.header.zone, run.header.kinds[0].clone());
    let mut compared = 0;
    for (i, part) in run.parts.iter().enumerate() {
        replay.apply(&run.header, part).unwrap();
        if i != 1 {
            continue;
        }
        // In flight: the replay's stored start and track give each microsecond's position, and the engine's agree.
        let n = replay.node(replay.handle(ee(THING)).unwrap()).unwrap();
        let (place, moved) = (n.place().unwrap(), n.moved().unwrap());
        let Owner::Track(track) = moved.owner else {
            panic!("a track owns it in flight");
        };
        let mut t = T0;
        while t <= f.end.at {
            assert_eq!(
                track.at(place.position, t).unwrap().0,
                f.at(t).unwrap(),
                "at {t} µs"
            );
            compared += 1;
            t += 1_000;
        }
    }
    assert_eq!(replay.to_state(), run.tree.to_state());
    let hash = run.tree.to_state().hash().unwrap();
    println!(
        "A2: {compared} positions (every ms of the flight) equal to the micrometre; replayed state {hash} equals the run's"
    );
    assert!(compared > 900);
}

#[test]
fn a3_a_missed_catch_lands_at_rest_and_a_throw_at_a_wall_ends_there() {
    // The catcher's hand a metre too high: missed; it lands on the floor at rest.
    let mut run = Run::new();
    let high = AT_ONE_SECOND.plus(Vec3::new(0, 1_000_000, 0)).unwrap();
    let f = throw(run.header.zone, high, None);
    run.fly(f, &geometry(None));
    let (pose, owner) = run.held_now();
    println!(
        "A3: missed: ends {:?} at {} µs, {pose:?}, owner {owner:?}",
        f.end.ends, f.end.at
    );
    assert_eq!(f.end.ends, Ends::Landed { surface: ee(FLOOR) });
    assert_eq!(owner, Owner::Track(Track::Rest));
    assert_eq!(
        pose.support,
        Support::Surface {
            surface: ee(FLOOR),
            height: 0
        }
    );
    assert!(
        pose.position.y >= 0 && pose.position.y < 20,
        "on the floor, never below it"
    );
    assert_eq!(pose.position, f.at(f.end.at).unwrap(), "where it lands");

    // A wall 4 m high at x 4 m: the path meets it mid-flight, though the landing point is far beyond it.
    let mut run = Run::new();
    let f = throw(run.header.zone, AT_ONE_SECOND, Some(4_000_000));
    let geo = geometry(Some(4_000_000));
    run.fly(f, &geo);
    let (pose, owner) = run.held_now();
    let log = run.log();
    println!(
        "A3: wall: ends {:?} at {} µs at {}; then {pose:?}, owner {owner:?}; log {log:?}",
        f.end.ends, f.end.at, f.end.position
    );
    assert_eq!(f.end.ends, Ends::Wall { solid: ee(WALL) });
    let per_us = VELOCITY.x / 1_000_000;
    assert!(
        (4_000_000 - per_us..4_000_000).contains(&f.end.position.x),
        "ends at the wall's face, outside it, within one microsecond's travel"
    );
    assert!(f.end.position.y < 4_000_000);
    // Then a drop from rest by the wall, its own track, to the floor.
    assert_eq!(owner, Owner::Track(Track::Rest));
    assert_eq!(pose.position.x, f.end.position.x);
    assert!(pose.position.y >= 0 && pose.position.y < 20);
    assert_eq!(log.iter().filter(|(k, _)| *k == "effect").count(), 3);

    // The same wall 3 m high: the path clears it and the catch is made.
    let f = throw(header().zone, AT_ONE_SECOND, Some(3_000_000));
    println!("A3: a 3 m wall is cleared: ends {:?}", f.end.ends);
    assert_eq!(f.end.ends, Ends::Caught { slot: 2 });
}

#[test]
fn a3_an_end_at_a_wall_is_outside_every_solid_at_any_speed() {
    let geo = geometry(Some(4_000_000));
    let inside = |p: Vec3| {
        geo.solids.iter().any(|b| {
            (b.min.x..=b.max.x).contains(&p.x)
                && (b.min.y..=b.max.y).contains(&p.y)
                && (b.min.z..=b.max.z).contains(&p.z)
        }) || p.y < geo.floor_y
    };
    for vx in [3_000_000, 8_000_000, 20_000_000, 47_300_001] {
        let velocity = Vec3::new(vx, 6_000_000, 0);
        let f = Flight::throw(
            ee(THING),
            held(header().zone),
            FROM,
            T0,
            velocity,
            GRAVITY,
            Vec3::ZERO,
            &geo,
            None,
        )
        .unwrap();
        let (_, drop) = f.finish(&geo).unwrap();
        let drop = drop.unwrap();
        println!(
            "A3: at {vx} µm/s: wall at {} µs at {}; the drop ends {:?} at {}",
            f.end.at, f.end.position, drop.end.ends, drop.end.position
        );
        assert_eq!(f.end.ends, Ends::Wall { solid: ee(WALL) });
        assert!(!inside(f.end.position), "the end is outside every solid");
        assert!(
            !inside(drop.end.position),
            "the drop's end is outside every solid"
        );
        assert!(f.end.position.x < 4_000_000 && 4_000_000 - f.end.position.x <= vx / 1_000_000 + 1);
    }
}

#[test]
fn a4_the_end_is_one_timer_and_nothing_runs_per_tick_in_flight() {
    let mut run = Run::new();
    let f = throw(run.header.zone, AT_ONE_SECOND, None);
    let mut due = DueList::new();
    due.set(f.timer(ee(TIMER)).unwrap()).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(
        due.next_due(),
        Some(f.end.at),
        "an idle world jumps to the end"
    );
    run.fly(f, &geometry(None));
    let ticks = (f.end.at - T0) / TICK + 1;
    println!(
        "A4: one timer, due {} µs; of the {ticks} ticks the flight spans, work ran in {:?} only",
        f.end.at, run.worked
    );
    assert_eq!(run.worked, vec![T0 / TICK, f.end.at / TICK]);
    let timers = run
        .entries
        .iter()
        .filter(|e| matches!(&e.body, Body::Timers(t) if t.iter().any(|r| matches!(r, TimerRec::Set { .. }))))
        .count();
    assert_eq!(timers, 1, "one timer set, at the start");
}
