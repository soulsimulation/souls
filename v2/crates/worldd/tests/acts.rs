//! Engine v2 C2 (#3366): Soul Actions acts in a running world, through the world's end of the gateway's socket (I1's
//! framing), on N2's test world with two bodies that are nodes of the tree. Each intent gets one answer.
//!
//! - A2: a form's take puts a thing in the body's hand (B4's transfer, F4's take step) and a put sets it into a
//!   rack's slot; each is one receipt, and the log replayed holds the thing in the hand, then in the slot.
//! - A3: a joint activity's propose, join (both), start and leave (both), each one receipt; an offer (E8) accepted and
//!   another declined, each one receipt.
//! - A4: two Souls carry a plank together: a carry activity both join and start, the lift, both walk 3 m, the
//!   carry sampled each tick between them, and the set-down; the plank ends on the ground where they stopped.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

use import_eden::Import;
use replica::activity::ActivityKind;
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Intent, Target};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::{Value as Json, parse};
use replica::tree::Rules as TreeRules;
use replica::world_model::{Audience, Kind};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::walk::town::Town;
use worldd::answers::{self, Config};
use worldd::bodies::Bodies;
use worldd::checkers::Rules;

thread_local! {
    /// The acts that had their one progress answer (C20) on this test's thread.
    static PROGRESSED: std::cell::RefCell<std::collections::BTreeSet<(Vec<u8>, u64)>> =
        std::cell::RefCell::default();
}

/// Whether `frame` is an act's progress answer (C20, W11 #4087), which the answer helpers read past. An act has at
/// most one: a second fails the test.
fn progress_once(frame: &[u8]) -> bool {
    let Some(key) = answers::progress_of(frame) else {
        return false;
    };
    let first = PROGRESSED.with(|p| p.borrow_mut().insert(key));
    assert!(first, "a second progress answer for one act");
    true
}

const LINEAGE: Scope = Scope([0xc2; 16]);

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn full(plain: &str, n: u8) -> String {
    format!("{plain}@1220{}{n:02x}", "00".repeat(31))
}

const PLACE: &str = "souls:place";
const WALKER: &str = "test:walker";
const VESSEL: &str = "test:vessel";
const RACK: &str = "test:rack";
const PLANK: &str = "test:plank";
const PAIR: &str = "test:pair";
const CARRY: &str = "test:carry";
const COURT: &str = "test:court";
const CAN: &str = "test:can";
const CIRCLE: &str = "test:circle";
/// An open ground under the zone's place, and a thing of walls on it (R2 off the clock: the fixed geometry a carry
/// reads, `sim::activity::carry::Fixed::of`).
const OPEN_GROUND: &str = "eden:ground";
const WALLS: &str = "test:walls";
const BAR: &str = "test:bar";
const LIFT: &str = "test:lift";
const WHEEL: &str = "test:wheel";

/// The kinds in pinned order: (plain name, full name).
fn kinds() -> Vec<(&'static str, String)> {
    [
        PLACE,
        WALKER,
        VESSEL,
        RACK,
        PLANK,
        PAIR,
        CARRY,
        COURT,
        CAN,
        CIRCLE,
        OPEN_GROUND,
        WALLS,
        BAR,
        LIFT,
        WHEEL,
    ]
    .iter()
    .enumerate()
    .map(|(i, k)| (*k, full(k, i as u8 + 1)))
    .collect()
}

fn fullname(plain: &str) -> String {
    kinds().into_iter().find(|(p, _)| *p == plain).unwrap().1
}

fn humanoid() -> Family {
    let r = |n: &str, class, slot| Resource {
        name: name(n),
        class,
        slot,
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![
            r("souls:leg-left", Class::Locomotion, None),
            r("souls:leg-right", Class::Locomotion, None),
            r("souls:hand-left", Class::Manipulator, Some(1)),
            r("souls:hand-right", Class::Manipulator, Some(2)),
            r("souls:voice", Class::Voice, None),
        ],
    }
}

/// N2's test world as a town and its ground: the replica's zone is rooted at a place over that ground ([`zone_place`]),
/// so a body the town stands on the ground stands on the ground's node, as in a served world.
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c2-town/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(nodes["world"].scope().0.to_vec())),
        (4, nodes["world"].to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).unwrap()).unwrap();
    let next = tree.to_state().next;
    let ground = nodes["ground"];
    let town = Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town");
    (town, ground)
}

fn ground() -> Id {
    town().1
}

fn id(n: u64) -> Id {
    Id::new(Scope([0x7c; 16]), n).unwrap()
}

fn w1() -> Id {
    id(1)
}
fn w2() -> Id {
    id(2)
}
fn vessel() -> Id {
    id(3)
}
fn rack() -> Id {
    id(4)
}
fn plank() -> Id {
    id(5)
}
fn court() -> Id {
    id(6)
}
/// #4086: three watering cans south of the first walker, 100 m, 2.2 m and 1.5 m away (a can's reach from a body is
/// its half size, 0.38 m, and 1.5 m).
fn far_can() -> Id {
    id(7)
}
fn beyond_can() -> Id {
    id(8)
}
fn near_can() -> Id {
    id(9)
}
fn south(by: i64) -> Vec3 {
    Vec3::new(at1().x, 0, at1().z - by)
}

/// Where the bodies stand on the test world's open ground, west of the square, µm.
fn at1() -> Vec3 {
    Vec3::new(-40_000_000, 0, 30_000_000)
}
fn at2() -> Vec3 {
    Vec3::new(-42_700_000, 0, 30_000_000)
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c2-acts/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                kinds()
                    .into_iter()
                    .map(|(_, f)| Value::Text(name(&f)))
                    .collect(),
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).unwrap()).unwrap()
}

/// The world's rules (T2): the ground takes bodies, things and activities; a walker holds a thing in each hand; the
/// vessel is held in one hand, the plank in two; the rack and the carry each have a slot for a thing.
fn tree_rules() -> TreeRules {
    let k = |owner: &str, children: &[&str], slots: &[u64], hands| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: slots
            .iter()
            .map(|s| (*s, BTreeSet::from(["thing".to_owned()])))
            .collect(),
        hands,
        fields: Default::default(),
    };
    TreeRules {
        kinds: BTreeMap::from([
            (
                fullname(PLACE),
                k("place", &["body", "thing", PAIR, CARRY], &[], None),
            ),
            (fullname(WALKER), k("family", &[], &[1, 2], None)),
            (fullname(VESSEL), k("thing", &[], &[], Some(1))),
            (fullname(RACK), k("thing", &[], &[1], None)),
            (fullname(PLANK), k("thing", &[], &[], Some(2))),
            (fullname(PAIR), k("activity", &[], &[], None)),
            (fullname(CARRY), k("activity", &[], &[1], None)),
            (fullname(COURT), k("thing", &[], &[], None)),
            (fullname(CAN), k("thing", &[], &[], Some(1))),
            (
                fullname(CIRCLE),
                Kind {
                    slots: BTreeMap::from([(1, BTreeSet::from(["family".to_owned()]))]),
                    ..k("thing", &[], &[], None)
                },
            ),
            (
                fullname(OPEN_GROUND),
                k("place", &["body", "thing", PAIR, CARRY], &[], None),
            ),
            (fullname(WALLS), k("thing", &[], &[], None)),
            (
                fullname(WHEEL),
                Kind {
                    slots: (1..=4)
                        .map(|s| (s, BTreeSet::from(["family".to_owned()])))
                        .collect(),
                    ..k("thing", &[], &[], None)
                },
            ),
            (
                fullname(LIFT),
                Kind {
                    slots: BTreeMap::from([(1, BTreeSet::from(["family".to_owned()]))]),
                    ..k("thing", &[], &[], None)
                },
            ),
            (
                fullname(BAR),
                Kind {
                    slots: BTreeMap::from([
                        (1, BTreeSet::from(["family".to_owned()])),
                        (2, BTreeSet::from(["family".to_owned()])),
                    ]),
                    ..k("thing", &[], &[], None)
                },
            ),
        ]),
        souls: [w1(), w2()].into(),
        audiences: BTreeMap::new(),
    }
}

/// An activity kind of two roles that claim only the voice, so its members walk and use their hands while in it.
fn activity(kind: &str, roles: [&str; 2]) -> ActivityKind {
    let role = |r: &str| {
        Value::Map(BTreeMap::from([
            (1, Value::Text(name(r))),
            (2, Value::Text(name(&format!("{r}-place")))),
            (
                3,
                Value::Array(vec![Value::Map(BTreeMap::from([
                    (1, Value::Uint(2)),
                    (2, Value::Uint(4)),
                ]))]),
            ),
        ]))
    };
    ActivityKind::from_value(&Value::Map(BTreeMap::from([
        (1, Value::Text(name(&fullname(kind)))),
        (2, Value::Uint(1)),
        (3, Value::Array(roles.iter().map(|r| role(r)).collect())),
        (4, Value::Uint(60_000_000)),
        (5, Value::Uint(400_000)),
    ])))
    .expect("an activity kind")
}

/// The forms' entries (`souls-entry/1`): the vessel's take and the rack's put.
fn entries() -> Json {
    let vessel = parse(
        &r#"{ "format": "souls-entry/1", "kind": "test:vessel", "owner": "thing",
      "points": { "grip": { "role": "grip", "at_mm": [0, 100, 0] } },
      "forms": { "take": { "who": "anyone", "steps": [{ "step": "take", "move": "press", "at": "grip" }] },
        "discard": { "who": "anyone", "steps": [{ "step": "use_held" }],
          "effects": [{ "change": "remove", "what": "this", "event": "discarded" }] },
        "consume_late": { "who": "anyone", "steps": [{ "step": "wait", "us": 300000 }, { "step": "use_held" }],
          "effects": [{ "change": "create", "kind": "GHOST", "into": "actor_hand", "event": "haunted" },
            { "change": "remove", "what": "this", "event": "consumed" }] },
        "rest_by": { "who": "anyone",
          "steps": [{ "step": "settle", "posture": "sit" }, { "step": "wait", "us": 500000 }, { "step": "rise" }] } } }"#
            .replace("GHOST", &full("test:ghost", 0xff)),
    )
    .unwrap();
    // A create names its kind pinned (C25's `stock`).
    let rack = parse(
        &r#"{ "format": "souls-entry/1", "kind": "test:rack", "owner": "thing",
      "points": { "edge": { "role": "rest", "at_mm": [0, 400, 0] } },
      "slots": { "rest": { "admits": "thing" } },
      "forms": { "put": { "who": "anyone",
        "steps": [{ "step": "put", "move": "press", "at": "edge", "what": { "arg": "item" }, "slot": "rest" }] },
        "stock": { "who": "anyone", "steps": [],
          "effects": [{ "change": "create", "kind": "PLANK", "into": "rest", "event": "stocked" }] },
        "overstock": { "who": "anyone", "steps": [],
          "effects": [{ "change": "create", "kind": "GHOST", "into": "rest", "event": "haunted" }] },
        "overstock_late": { "who": "anyone", "steps": [{ "step": "wait", "us": 300000 }],
          "effects": [{ "change": "create", "kind": "GHOST", "into": "rest", "event": "haunted" }] },
        "haunt": { "who": "anyone", "steps": [],
          "effects": [{ "change": "timer", "form": "haunt_again", "after_us": 1, "event": "haunting" }] },
        "haunt_again": { "who": "anyone", "steps": [],
          "effects": [{ "change": "create", "kind": "GHOST", "into": "rest", "event": "haunted" },
            { "change": "timer", "form": "haunt_again", "after_us": 1, "event": "again" }] } } }"#
            .replace("PLANK", &fullname(PLANK))
            .replace("GHOST", &full("test:ghost", 0xff)),
    )
    .unwrap();
    // A game of two ends, as a frisbee is played (#3888): each player takes an end; whoever holds the disc throws
    // it to the other end, which needs a player there (a `linked` need only the world can read).
    let court = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:court", "owner": "thing",
      "state": { "disc": { "n": 28, "type": "enum", "values": ["end_a", "end_b"], "default": "end_a",
        "audience": { "rule": "everyone" } } },
      "links": { "end_a": { "n": 1, "from": "body", "most": 1, "audience": { "rule": "everyone" } },
        "end_b": { "n": 2, "from": "body", "most": 1, "audience": { "rule": "everyone" } } },
      "forms": {
        "play_at_end_a": { "who": "anyone", "starts": "act", "needs": [{ "need": "unlinked", "link": "end_a" }],
          "steps": [], "effects": [{ "change": "link", "link": "end_a", "from": "actor", "event": "joined" }] },
        "play_at_end_b": { "who": "anyone", "starts": "act", "needs": [{ "need": "unlinked", "link": "end_b" }],
          "steps": [], "effects": [{ "change": "link", "link": "end_b", "from": "actor", "event": "joined" }] },
        "throw_from_end_a_to_end_b": { "who": { "link": "end_a" }, "starts": "act",
          "needs": [{ "need": "state", "field": "disc", "is": "end_a" }, { "need": "linked", "link": "end_b" }],
          "steps": [], "effects": [{ "change": "set", "field": "disc", "to": "end_b", "event": "threw" }] } } }"#,
    )
    .unwrap();
    // The watering can's own take (`content/kinds/garden/watering_can.json`): no move and no walk before its hand
    // step, and a free hand its one need (#4086).
    let can = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:can", "owner": "thing",
      "points": { "grip": { "role": "grip", "at_mm": [0, 305, 0] } },
      "geometry": { "bounds_mm": [760, 360, 240] },
      "forms": { "take": { "who": "anyone", "starts": "act", "needs": [{ "need": "hand", "free": true }],
        "steps": [{ "step": "take" }],
        "effects": [{ "change": "reparent", "what": "this", "into": "actor_hand", "event": "taken" }] } },
      "motion": { "how": "one_hand" }, "loose": { "ever": true } }"#,
    )
    .unwrap();
    // 0.135 C4: only a load is carried, a kind whose entry states its size, grips and crew: a 2 m plank, held at
    // its ends.
    let plank = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:plank", "owner": "thing",
      "points": { "end_a": { "role": "grip", "at_mm": [-1000, 25, 0] }, "end_b": { "role": "grip", "at_mm": [1000, 25, 0] } },
      "geometry": { "bounds_mm": [2000, 50, 300] } }"#,
    )
    .unwrap();
    Json::Obj(vec![
        (VESSEL.into(), vessel),
        (RACK.into(), rack),
        (COURT.into(), court),
        (CAN.into(), can),
        (PLANK.into(), plank),
        (CIRCLE.into(), circle_entry()),
        (LIFT.into(), lift_entry()),
        (WHEEL.into(), wheel_entry()),
        (BAR.into(), bar_entry()),
    ])
}

fn create(node: Id, kind: &str, parent: Id, at: Vec3) -> (Id, Change) {
    (
        parent,
        Change::Create {
            node,
            kind: name(&fullname(kind)),
            pose: Pose {
                frame: Frame {
                    node: parent,
                    slot: None,
                },
                position: at,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: parent,
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        },
    )
}

/// The world as built, on an open ground under the zone's place: the two walkers, the vessel 300 mm from the first,
/// the rack 400 mm from it, the plank between the two.
fn world() -> Replica {
    world_of(zone_place(), built())
}

/// [`world`]'s changes.
fn built() -> Vec<(Id, Change)> {
    let g = ground();
    let off = |p: Vec3, dx: i64| Vec3::new(p.x + dx, 0, p.z);
    vec![
        create(g, OPEN_GROUND, zone_place(), Vec3::ZERO),
        create(w1(), WALKER, g, at1()),
        create(w2(), WALKER, g, at2()),
        create(vessel(), VESSEL, g, off(at1(), 300_000)),
        create(rack(), RACK, g, Vec3::new(at1().x, 0, at1().z + 400_000)),
        create(plank(), PLANK, g, off(at2(), 1_350_000)),
        create(
            court(),
            COURT,
            g,
            Vec3::new(at1().x, 0, at1().z - 2_000_000),
        ),
        create(far_can(), CAN, g, south(100_000_000)),
        create(beyond_can(), CAN, g, south(2_200_000)),
        create(near_can(), CAN, g, south(1_500_000)),
        create(circle(), CIRCLE, g, circle_at()),
        create(bar(), BAR, g, bar_at()),
        create(lift(), LIFT, g, lift_at()),
        create(wheel(), WHEEL, g, wheel_at()),
    ]
}

/// N2's test world's ground with `changes` written on it as built.
fn world_of(g: Id, changes: Vec<(Id, Change)>) -> Replica {
    let h = header(g);
    let mut r = Replica::start(h.stored()).expect("a replica");
    let effects: Vec<Value> = changes
        .into_iter()
        .enumerate()
        .map(|(k, (node, change))| {
            Effect {
                envelope: Envelope {
                    sequence: k as u64,
                    at: 0,
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
            .to_value()
        })
        .collect();
    let part = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (2, Value::Array(effects)),
    ])))
    .unwrap();
    r.apply(&Part::read(&part).unwrap())
        .expect("the world as built");
    r
}

fn bodies() -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let p1 = town.surfaces[&ground].place(w1(), frame, at1(), Quat::IDENTITY)?;
    let p2 = town.surfaces[&ground].place(w2(), frame, at2(), Quat::IDENTITY)?;
    let mut b = Bodies::new(town, 50_000)?;
    b.add_body(humanoid(), p1)?;
    b.add_body(humanoid(), p2)?;
    b.add_place(circle_place(ground))?;
    for p in bar_places(ground) {
        b.add_place(p)?;
    }
    let (cabin, r) = lift_place(ground);
    b.add_place(cabin)?;
    b.slots.trip_ends(lift(), r.ends.clone());
    b.slots.run(lift(), r.slot, &r.course, r.stops, &r.own)?;
    for (p, r) in wheel_places(ground) {
        b.add_place(p)?;
        b.slots.run(wheel(), r.slot, &r.course, r.stops, &r.own)?;
    }
    Ok(b)
}

/// 0.135 E16: a petanque circle's like, a standing slot of two bodies (`most: 2`), 3 m north of the walkers.
fn circle() -> Id {
    id(10)
}
fn circle_at() -> Vec3 {
    Vec3::new(-41_350_000, 0, 33_000_000)
}
fn circle_entry() -> Json {
    parse(
        r#"{ "format": "souls-entry/1", "kind": "test:circle", "owner": "thing",
      "points": { "by": { "role": "stand", "at_mm": [0, 0, -600] } },
      "slots": { "circle": { "admits": "body", "most": 2, "at_mm": [0, 0, 0], "stand": "by" } },
      "geometry": { "bounds_mm": [3000, 100, 3000] },
      "forms": { "play": { "who": "anyone", "starts": "act",
        "takes": { "place": { "type": "slot",
          "select": { "of": "free_slots", "in": "this", "anchor": "me", "order": "nearest", "rank": 1 } } },
        "needs": [{ "need": "slot_free", "slot": { "arg": "place" } }],
        "steps": [{ "step": "walk_to", "point": { "arg": "place" } }],
        "effects": [{ "change": "reparent", "what": "actor", "into": { "arg": "place" }, "event": "took_a_place" }] } } }"#,
    )
    .unwrap()
}
/// The circle's seat as a served world registers it: its point, its stand point 600 mm south, and its other place.
fn circle_place(ground: Id) -> sim::slots::PlaceAt {
    sim::slots::PlaceAt {
        thing: circle(),
        place: replica::moves::Place {
            slot: 1,
            height: 0,
            stand: [0, -600_000],
        },
        point: circle_at(),
        facing: Quat::IDENTITY,
        floor: ground,
        more: import_eden::more_places(Vec3::ZERO, 2, Some([3_000_000, 3_000_000])),
    }
}

/// #4575: a counter with two places of one body each along z, 5 m south of the circle. Place 1 (`a`) is nearer the
/// walkers than place 2 (`b`), and the walkers stand as far from it as each other, so the nearest free pick gives
/// both of them `a` unless it skips a place another Soul's run is on its way to.
fn bar() -> Id {
    id(11)
}
fn bar_at() -> Vec3 {
    Vec3::new(-41_350_000, 0, 25_000_000)
}
fn bar_entry() -> Json {
    parse(
        r#"{ "format": "souls-entry/1", "kind": "test:bar", "owner": "thing",
      "points": { "a_by": { "role": "stand", "at_mm": [0, 0, 1600] }, "b_by": { "role": "stand", "at_mm": [0, 0, -400] } },
      "slots": { "a": { "admits": "body", "most": 1, "at_mm": [0, 0, 1000], "stand": "a_by" },
        "b": { "admits": "body", "most": 1, "at_mm": [0, 0, -1000], "stand": "b_by" } },
      "geometry": { "bounds_mm": [600, 100, 3000] },
      "forms": { "stand_at": { "who": "anyone", "starts": "act",
        "takes": { "place": { "type": "slot",
          "select": { "of": "free_slots", "in": "this", "anchor": "me", "order": "nearest", "rank": 1 } } },
        "needs": [{ "need": "slot_free", "slot": { "arg": "place" } }],
        "steps": [{ "step": "walk_to", "point": { "arg": "place" } }],
        "effects": [{ "change": "reparent", "what": "actor", "into": { "arg": "place" }, "event": "took_a_place" }] } } }"#,
    )
    .unwrap()
}
/// The counter's two places as a served world registers them, each with its stand point 600 mm north of it.
fn bar_places(ground: Id) -> Vec<sim::slots::PlaceAt> {
    [(1, 1_000_000), (2, -1_000_000)]
        .into_iter()
        .map(|(slot, dz)| sim::slots::PlaceAt {
            thing: bar(),
            place: replica::moves::Place {
                slot,
                height: 0,
                stand: [0, 600_000],
            },
            point: Vec3::new(bar_at().x, 0, bar_at().z + dz),
            facing: Quat::IDENTITY,
            floor: ground,
            more: Vec::new(),
        })
        .collect()
}

/// An answer frame's sequence and its receipt's entries, or its refusal's reason.
fn answer_in(frame: &[u8]) -> (u64, Result<Vec<u64>, String>) {
    let Value::Map(m) = decode(frame).unwrap().value else {
        panic!("a frame")
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        panic!("an answer")
    };
    let Some(Value::Uint(sequence)) = a.get(&2) else {
        panic!("an answer's sequence: {a:?}")
    };
    let r = match (a.get(&3), a.get(&5)) {
        (Some(Value::Uint(1)), Some(Value::Array(e))) => Ok(e
            .iter()
            .map(|v| match v {
                Value::Uint(n) => *n,
                _ => panic!("an entry"),
            })
            .collect()),
        (Some(Value::Uint(2)), _) => match a.get(&4) {
            Some(Value::Text(t)) => Err(t.as_str().to_owned()),
            other => panic!("a refusal: {other:?}"),
        },
        other => panic!("an answer: {other:?}"),
    };
    (*sequence, r)
}

/// A scripted client on the world's socket, one per Soul.
struct Client(UnixStream, Id, u64, Vec<u8>);

impl Client {
    fn send(&mut self, verb: &str, target: Option<Id>, parameters: BTreeMap<u64, Value>) {
        self.2 += 1;
        let i = Intent {
            actor: Actor::Soul(self.1),
            verb: name(verb),
            target: target.map(Target::Node),
            parameters,
            sequence: self.2,
            basis: Version {
                lineage: LINEAGE,
                zone: Id::new(LINEAGE, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: answers::now() + 60_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let bytes = encode(&i.to_value()).unwrap();
        self.raw(&bytes);
        self.3 = bytes;
    }

    /// Sends `bytes` as they are: an intent sent again, as the gateway sends the unanswered ones on a reconnect.
    fn raw(&mut self, bytes: &[u8]) {
        self.0
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        self.0.write_all(bytes).unwrap();
    }

    /// The next answer: a receipt's entries, or a refusal's reason. A progress answer (C20, sent as a run starts) is
    /// read past.
    fn answer(&mut self) -> Result<Vec<u64>, String> {
        self.answer_of().1
    }

    /// The next answer, with the sequence of the intent it answers.
    fn answer_of(&mut self) -> (u64, Result<Vec<u64>, String>) {
        let frame = loop {
            let mut len = [0u8; 4];
            self.0.read_exact(&mut len).expect("an answer");
            let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
            self.0.read_exact(&mut frame).unwrap();
            if !progress_once(&frame) {
                break frame;
            }
        };
        answer_in(&frame)
    }

    /// Waits for the progress answer of the act just sent (C20: sent in the tick its run starts).
    fn started(&mut self) {
        let mut len = [0u8; 4];
        self.0.read_exact(&mut len).expect("an answer");
        let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
        self.0.read_exact(&mut frame).unwrap();
        assert!(progress_once(&frame), "the act's run started");
    }

    /// One act and its one answer.
    fn act(
        &mut self,
        verb: &str,
        target: Option<Id>,
        p: BTreeMap<u64, Value>,
    ) -> Result<Vec<u64>, String> {
        self.send(verb, target, p);
        self.answer()
    }
}

/// A world serving on a socket, and a client for each Soul.
struct Run {
    world: answers::World,
    store: Mem,
    path: std::path::PathBuf,
}

fn serve(tag: &str) -> (Run, Client, Client) {
    serve_on(tag, Mem::with(Vec::new()))
}

/// [`serve`] on the log `store` holds: a world started again after a stop reads it back.
fn serve_on(tag: &str, store: Mem) -> (Run, Client, Client) {
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    cfg.engine = Some((
        tree_rules(),
        vec![
            activity(PAIR, ["test:first", "test:second"]),
            activity(CARRY, ["test:front", "test:back"]),
        ],
    ));
    let rules = Rules {
        kinds: entries(),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(world(), rules, store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("c2-{tag}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, stream));
        }
    });
    let client = |soul| {
        let s = UnixStream::connect(&path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        Client(s, soul, 0, Vec::new())
    };
    let (a, b) = (client(w1()), client(w2()));
    (Run { world, store, path }, a, b)
}

impl Run {
    /// The world's replica as of now: the world as built with every logged part applied.
    fn replay(&self) -> Replica {
        self.replay_on(world())
    }

    /// [`Run::replay`] on `r`, the world as built.
    fn replay_on(&self, mut r: Replica) -> Replica {
        let log = self.store.0.lock().unwrap().bytes.clone();
        for rec in recover(&log).unwrap().records {
            if sim::recorder::is_input(&rec) {
                continue;
            }
            let p = Part::read(&rec).unwrap();
            if !p.effects.is_empty() {
                r.apply(&p).expect("the log replays");
            }
        }
        r
    }

    /// The node an entry created, by its sequence.
    fn created(&self, entries: &[u64], kind: &str) -> Id {
        let log = self.store.0.lock().unwrap().bytes.clone();
        for rec in recover(&log).unwrap().records {
            if sim::recorder::is_input(&rec) {
                continue;
            }
            for e in Part::read(&rec).unwrap().effects {
                if !entries.contains(&e.envelope.sequence) {
                    continue;
                }
                if let Body::Changes(cs) = &e.body {
                    for c in cs {
                        if let Change::Create { node, kind: k, .. } = &c.change
                            && k.as_str() == fullname(kind)
                        {
                            return *node;
                        }
                    }
                }
            }
        }
        panic!("no {kind} created in {entries:?}")
    }

    fn stop(self) {
        self.world.stop();
        let _ = std::fs::remove_file(&self.path);
    }
}

fn parent(r: &Replica, node: Id) -> (Option<Id>, Option<u64>) {
    let t = r.tree();
    let n = t.node(t.handle(node).expect("the node")).expect("the node");
    (n.parent(), n.slot())
}

fn p(pairs: &[(u64, Value)]) -> BTreeMap<u64, Value> {
    pairs.iter().cloned().collect()
}

#[test]
fn a2_take_and_put_through_the_gateway_each_one_receipt() {
    let (run, mut a, _) = serve("a2");
    let take = a.act("test:take", Some(vessel()), BTreeMap::new());
    println!("A2 take: {take:?}");
    let take = take.expect("the take lands");
    let held = parent(&run.replay(), vessel());
    println!("A2 held: {held:?}");
    assert_eq!(held.0, Some(w1()), "held: a child of the body");
    assert!(matches!(held.1, Some(1 | 2)), "in a hand's slot");
    let item = Value::Array(vec![Value::Array(vec![
        Value::Bytes(b"item".to_vec()),
        vessel().to_value(),
    ])]);
    let put = a.act("test:put", Some(rack()), p(&[(1, item)]));
    println!("A2 put: {put:?}");
    let put = put.expect("the put lands");
    let set = parent(&run.replay(), vessel());
    println!("A2 set: {set:?}");
    assert_eq!(set, (Some(rack()), Some(1)), "in the rack's slot");
    assert!(
        !take.is_empty() && !put.is_empty(),
        "each receipt names its entries"
    );
    // Holding nothing now, a second put is refused by name.
    let item = Value::Array(vec![Value::Array(vec![
        Value::Bytes(b"item".to_vec()),
        vessel().to_value(),
    ])]);
    let again = a.act("test:put", Some(rack()), p(&[(1, item)]));
    println!("A2 put again: {again:?}");
    assert!(again.is_err(), "nothing held: refused");
    run.stop();
}

#[test]
fn a3_an_activity_and_an_offer_through_the_gateway_each_one_receipt() {
    let (run, mut a, mut b) = serve("a3");
    let g = ground();
    let kind = |k: &str| (1, Value::Text(name(&fullname(k))));
    let proposed = a
        .act("activity:propose", Some(g), p(&[kind(PAIR)]))
        .expect("proposed");
    let act = run.created(&proposed, PAIR);
    let role = |r: &str| (1, Value::Text(name(r)));
    let j1 = a.act("activity:join", Some(act), p(&[role("test:first")]));
    let j2 = b.act("activity:join", Some(act), p(&[role("test:second")]));
    let started = a.act("activity:start", Some(act), BTreeMap::new());
    let l1 = a.act("activity:leave", Some(act), BTreeMap::new());
    let l2 = b.act("activity:leave", Some(act), BTreeMap::new());
    println!("A3: propose {proposed:?} join {j1:?} {j2:?} start {started:?} leave {l1:?} {l2:?}");
    for (what, r) in [
        ("join", &j1),
        ("join", &j2),
        ("start", &started),
        ("leave", &l1),
        ("leave", &l2),
    ] {
        assert!(
            r.as_ref().is_ok_and(|e| !e.is_empty()),
            "{what}: one receipt"
        );
    }
    let r = run.replay();
    assert!(
        r.tree().handle(act).is_none(),
        "the activity ended with its last member"
    );

    // E8: an offer accepted, another declined.
    let offer = |c: &mut Client| {
        c.act(
            "activity:offer",
            Some(g),
            p(&[
                kind(PAIR),
                (2, Value::Text(name("test:first"))),
                (3, Value::Array(vec![w2().to_value()])),
            ]),
        )
    };
    let o1 = offer(&mut a).expect("offered");
    let first = run.created(&o1, PAIR);
    let accepted = b.act("activity:accept", Some(first), BTreeMap::new());
    let left = a.act("activity:leave", Some(first), BTreeMap::new());
    let left2 = b.act("activity:leave", Some(first), BTreeMap::new());
    let o2 = offer(&mut a).expect("offered again");
    let second = run.created(&o2, PAIR);
    let declined = b.act("activity:decline", Some(second), BTreeMap::new());
    println!(
        "A3 offers: offer {o1:?} accept {accepted:?} leave {left:?} {left2:?}; offer {o2:?} decline {declined:?}"
    );
    accepted.expect("the accept lands");
    declined.expect("the decline lands");
    let r = run.replay();
    assert!(
        r.tree().handle(second).is_none(),
        "declined by everyone asked: the offer ended"
    );
    run.stop();
}

#[test]
fn a4_two_souls_carry_a_plank_together_through_the_gateway() {
    let (run, mut a, mut b) = serve("a4");
    let g = ground();
    let proposed = a
        .act(
            "activity:propose",
            Some(g),
            p(&[(1, Value::Text(name(&fullname(CARRY))))]),
        )
        .expect("proposed");
    let carry = run.created(&proposed, CARRY);
    let role = |r: &str| p(&[(1, Value::Text(name(r)))]);
    a.act("activity:join", Some(carry), role("test:front"))
        .expect("the front joins");
    b.act("activity:join", Some(carry), role("test:back"))
        .expect("the back joins");
    a.act("activity:start", Some(carry), BTreeMap::new())
        .expect("started");
    let lift = a.act("carry:lift", Some(carry), p(&[(1, plank().to_value())]));
    println!("A4 lift: {lift:?}");
    lift.expect("lifted");
    assert_eq!(
        parent(&run.replay(), plank()),
        (Some(carry), Some(1)),
        "the plank rides the carry"
    );
    // Both walk 3 m along x, side by side.
    let to = |p: Vec3| {
        let v = |n: i64| {
            u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
        };
        BTreeMap::from([(1, Value::Array(vec![v(p.x + 3_000_000), v(0), v(p.z)]))])
    };
    a.send("eden:walk", Some(g), to(at1()));
    b.send("eden:walk", Some(g), to(at2()));
    let (wa, wb) = (a.answer(), b.answer());
    println!("A4 walks: {wa:?} {wb:?}");
    wa.expect("the front walked");
    wb.expect("the back walked");
    let down = b.act("carry:set-down", Some(carry), BTreeMap::new());
    println!("A4 set down: {down:?}");
    down.expect("set down");
    let r = run.replay();
    let t = r.tree();
    let n = t.node(t.handle(plank()).unwrap()).unwrap();
    let at = n.place().unwrap().position;
    println!("A4 plank on {:?} at {at:?}", n.parent());
    assert_eq!(n.parent(), Some(g), "set down on the ground");
    // The carry's frame was sampled between its carriers each tick they walked (B9's track, in the log).
    let log = run.store.0.lock().unwrap().bytes.clone();
    let samples = recover(&log)
        .unwrap()
        .records
        .iter()
        .filter(|rec| !sim::recorder::is_input(rec))
        .flat_map(|rec| Part::read(rec).unwrap().effects)
        .filter(|e| {
            matches!(&e.body, Body::Changes(cs)
                if cs.iter().any(|c| matches!(c.change, Change::Motion(ref h) if h.node == carry)))
        })
        .count();
    println!("A4 carry samples: {samples}");
    assert!(samples > 20, "sampled through the walk: {samples}");
    let mid = (at1().x + at2().x) / 2 + 3_000_000;
    assert!(
        (at.x - mid).abs() < 300_000,
        "between the carriers where they stopped: x {} near {mid}",
        at.x
    );
    for c in [&mut a, &mut b] {
        c.act("activity:leave", Some(carry), BTreeMap::new())
            .expect("left");
    }
    run.stop();
}

/// C25 (#3496) A1, A3: through the gateway, a form with no steps (the rack's `stock`, which makes a plank in its slot)
/// applies its effect at once: one act, one receipt, the plank in the rack's slot in the log replayed. The vessel's `rest_by` settles the
/// body on the ground, pauses and rises: done. Its `discard` (`use_held`, then a removal) is refused `not-held` while
/// the body does not hold it, and after a take removes it: done.
#[test]
fn c25_no_steps_settle_rise_and_use_held_through_the_gateway() {
    let (run, mut a, _) = serve("c25");
    let stocked = a.act("test:stock", Some(rack()), BTreeMap::new());
    println!("C25 stock: {stocked:?}");
    assert!(!stocked.expect("the stock lands").is_empty(), "one receipt");
    let r = run.replay();
    let t = r.tree();
    let made = t.children(t.handle(rack()).unwrap()).map_or(0, <[_]>::len);
    assert_eq!(made, 1, "a plank in the rack's slot");
    let rested = a.act("test:rest_by", Some(vessel()), BTreeMap::new());
    println!("C25 rest_by: {rested:?}");
    assert!(rested.is_ok(), "settled, paused and rose");
    let early = a.act("test:discard", Some(vessel()), BTreeMap::new());
    println!("C25 discard before a take: {early:?}");
    assert_eq!(early, Err("not-held".to_owned()));
    a.act("test:take", Some(vessel()), BTreeMap::new())
        .expect("the take lands");
    let discarded = a.act("test:discard", Some(vessel()), BTreeMap::new());
    println!("C25 discard: {discarded:?}");
    assert!(!discarded.expect("the discard lands").is_empty());
    assert!(
        run.replay().tree().handle(vessel()).is_none(),
        "the vessel is gone"
    );
    run.stop();
}

/// C24 (#3495) A1: a form's `timer` effect is written as the node's timer (one entry), goes on the forms' due list,
/// and when it fires its clear is written and its form starts on the node with the world as actor and runs to its
/// end; the tree holds no timer after.
#[test]
fn c24_a_forms_timer_fires_and_starts_its_form_with_the_world_as_actor() {
    use worldd::acts::{Acts, Args, intent, library};
    let vessel_entry = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:vessel", "owner": "thing",
      "forms": {
        "ring": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
          "effects": [{ "change": "timer", "form": "quiet", "after_us": 200000, "event": "will_quiet" }] },
        "quiet": { "who": "world", "steps": [{ "step": "wait", "us": 50000 }] } } }"#,
    )
    .unwrap();
    let mut r = world();
    let mut b = bodies().expect("the bodies");
    let mut acts = Acts::new(
        Json::Obj(vec![(VESSEL.into(), vessel_entry)]),
        library().expect("the moves"),
        header(ground()),
        Scope([0xc4; 16]),
    );
    let (mut now, mut tick) = (1_000_000_i64, 0u64);
    b.begin(now);
    let ask = intent(id(9000), now + 60_000_000, Actor::Soul(w1()), b"ring");
    let started = acts.start(
        r.tree(),
        Some(&mut b),
        w1(),
        &[(vessel(), "ring".to_owned())],
        &Args::default(),
        ask,
        tick,
        now,
    );
    assert!(
        matches!(started, Ok(sim::forms::Asked::Started(_))),
        "{started:?}"
    );
    let (mut ended, mut timers) = (Vec::new(), Vec::new());
    while ended.len() < 2 && now < 5_000_000 {
        now += 50_000;
        tick += 1;
        let _ = b.step(now);
        acts.tick(r.tree(), Some(&mut b), tick, now);
        let mut out = acts.out();
        for (k, e) in out.iter_mut().enumerate() {
            e.envelope.sequence = r.version() + k as u64;
        }
        if !out.is_empty() {
            let part = sim::commit::write(&mut r, &out).expect("the forms' entries commit");
            for e in &part.effects {
                acts.forms.logged(e);
                if let Body::Timers(t) = &e.body {
                    timers.push((e.envelope.at, t.clone()));
                }
            }
        }
        if r.tree().timers().len() == 1 {
            println!("{now} µs: pending {:?}", r.tree().timers().values().next());
        }
        ended.extend(acts.ended());
    }
    let fired: Vec<_> = acts.fired.drain(..).collect();
    println!("timer entries: {timers:?}\nfired: {fired:?}\nended: {ended:?}");
    assert_eq!(timers.len(), 2, "set, then cleared as it fired");
    assert!(matches!(
        &fired[..],
        [(_, Ok(sim::forms::Asked::Started(_)))]
    ));
    assert_eq!(ended.len(), 2, "the act's run, then the timer's");
    assert!(ended.iter().all(|(_, how, _)| how == "done"), "{ended:?}");
    assert_eq!(
        ended[1].0, fired[0].0,
        "the timer's run is keyed by the timer"
    );
    assert!(r.tree().timers().is_empty());
}

/// 0.135 E16, review of #4549: two Souls take one slot of two places (`most: 2`) through the gateway, each naming
/// it. The second is not refused `place-taken` for the first's hold, as it was while any holder made a slot full; both
/// end in the slot, each at its own place.
#[test]
fn e16_two_souls_take_a_slot_of_two_naming_it_through_the_gateway() {
    let (run, mut a, mut b) = serve("e16");
    let place = || {
        p(&[(
            1,
            Value::Array(vec![Value::Array(vec![
                Value::Bytes(b"place".to_vec()),
                Value::Bytes(b"circle".to_vec()),
            ])]),
        )])
    };
    let first = a.act("test:play", Some(circle()), place());
    println!("E16 first: {first:?}");
    first.expect("the first takes a place");
    let second = b.act("test:play", Some(circle()), place());
    println!("E16 second: {second:?}");
    second.expect("the second takes the other place, not place-taken");
    let r = run.replay();
    assert_eq!(parent(&r, w1()), (Some(circle()), Some(1)));
    assert_eq!(parent(&r, w2()), (Some(circle()), Some(1)));
    let (pa, pb) = (
        r.tree()
            .node(r.tree().handle(w1()).unwrap())
            .unwrap()
            .place(),
        r.tree()
            .node(r.tree().handle(w2()).unwrap())
            .unwrap()
            .place(),
    );
    println!("E16 places: {pa:?} {pb:?}");
    assert_ne!(
        pa.map(|p| p.position),
        pb.map(|p| p.position),
        "each at its own place"
    );
    run.stop();
}

/// #4575: two Souls take places at one thing at the same moment through the gateway. The second's act is sent while
/// the first's run is still walking to its place, as Bea's sit on Eden's bench was sent 40 ms after Ada's. A form
/// that only takes a slot reserves that slot (here one of two places, E16), not the whole thing, so the second is not
/// refused `thing-reserved`: both runs go on at once, and both end in the slot, each at its own place.
#[test]
fn i4575_two_souls_take_places_at_one_thing_at_once_through_the_gateway() {
    let (run, mut a, mut b) = serve("i4575");
    let place = || {
        p(&[(
            1,
            Value::Array(vec![Value::Array(vec![
                Value::Bytes(b"place".to_vec()),
                Value::Bytes(b"circle".to_vec()),
            ])]),
        )])
    };
    a.send("test:play", Some(circle()), place());
    a.started();
    b.send("test:play", Some(circle()), place());
    let (first, second) = (a.answer(), b.answer());
    println!("#4575 at once: first {first:?}, second {second:?}");
    first.expect("the first takes a place");
    second.expect("the second takes the other place while the first's run goes on");
    let r = run.replay();
    assert_eq!(parent(&r, w1()), (Some(circle()), Some(1)));
    assert_eq!(parent(&r, w2()), (Some(circle()), Some(1)));
    run.stop();
}

/// #4575: two Souls ask for a place at the counter at the same moment, naming none. The world's nearest free pick
/// skips a place another Soul's run is on its way to, so the second is given the other place, not the first's (and
/// refused `place-taken`, as on Eden's bench). Both end in their own places.
#[test]
fn i4575_two_souls_asking_for_a_place_at_once_are_given_different_places() {
    let (run, mut a, mut b) = serve("i4575-pick");
    a.send("test:stand_at", Some(bar()), BTreeMap::new());
    a.started();
    b.send("test:stand_at", Some(bar()), BTreeMap::new());
    let (first, second) = (a.answer(), b.answer());
    println!("#4575 pick: first {first:?}, second {second:?}");
    first.expect("the first takes the nearer place");
    second.expect("the second is given the other place");
    let r = run.replay();
    let (pa, pb) = (parent(&r, w1()), parent(&r, w2()));
    println!("#4575 pick: places {pa:?} {pb:?}");
    assert_eq!(pa, (Some(bar()), Some(1)));
    assert_eq!(pb, (Some(bar()), Some(2)));
    run.stop();
}

#[path = "acts/attend.rs"]
mod attend;
#[path = "acts/effect_refused.rs"]
mod effect_refused;
#[path = "acts/named_args.rs"]
mod named_args;

/// #3888 A1, A2: the world decides a form's needs at commit, links included, by R2's one evaluator, whatever the
/// client said. A throw to an end nobody plays is refused `not_linked` naming need 1, and nothing changes; with a
/// Soul at that end it is done and the disc is there. An end already taken is refused `already_linked` (need 0),
/// as chess's `play_white` is when white is taken.
#[test]
fn i3888_a_forms_needs_are_the_worlds_at_commit() {
    let (run, mut a, mut b) = serve("i3888");
    let disc = |run: &Run| {
        let r = run.replay();
        let t = r.tree();
        t.node(t.handle(court()).unwrap())
            .unwrap()
            .fields()
            .get(&28)
            .cloned()
    };
    let none = BTreeMap::new;
    a.act("test:play_at_end_a", Some(court()), none())
        .expect("a takes end a");
    let alone = a.act("test:throw_from_end_a_to_end_b", Some(court()), none());
    println!("#3888 throw with nobody at end b: {alone:?}");
    assert_eq!(
        alone,
        Err("not_linked".to_owned()),
        "refused by the need's name"
    );
    assert_eq!(
        disc(&run),
        None,
        "nothing changed: the disc is still at end a"
    );
    let taken = b.act("test:play_at_end_a", Some(court()), none());
    println!("#3888 end a again: {taken:?}");
    assert_eq!(taken, Err("already_linked".to_owned()));
    b.act("test:play_at_end_b", Some(court()), none())
        .expect("b takes end b");
    let thrown = a.act("test:throw_from_end_a_to_end_b", Some(court()), none());
    println!("#3888 throw with b at end b: {thrown:?}");
    assert!(!thrown.expect("the throw lands").is_empty());
    assert_eq!(disc(&run), Some(Value::Text(name("test:end_b"))));
    // The disc is at end b now: a's throw from end a is refused by the state need (need 0).
    let again = a.act("test:throw_from_end_a_to_end_b", Some(court()), none());
    assert_eq!(again, Err("field_differs".to_owned()));
    run.stop();
}

/// Where node `n` is in its frame, as the world's records have it.
fn at(r: &Replica, n: Id) -> Vec3 {
    let t = r.tree();
    t.node(t.handle(n).expect("the node"))
        .expect("the node")
        .place()
        .expect("a place")
        .position
}

/// #4086: no take at a distance. A watering can's `take` has no walk and no move before its hand step (the can's own
/// form, as Eden and Mars serve it). Before this change a body 100 m away was handed the can at once, never moving
/// (A1). Now the world measures the reach at commit: the can 100 m away and one just beyond a form's reach (2.2 m)
/// are refused `out_of_reach`, naming the walk that would work, with nothing changed; one within it (1.5 m) is taken.
/// The body's place and the cans' parents are read from the world's records.
#[test]
fn w10_a_take_with_no_walk_needs_the_thing_in_reach() {
    let (run, mut a, _) = serve("w10");
    let none = BTreeMap::new;
    let before = at(&run.replay(), w1());
    let far = a.act("test:take", Some(far_can()), none());
    let r = run.replay();
    println!(
        "W10 take 100 m: {far:?}; body {before:?} then {:?}; can at {:?}, parent {:?}",
        at(&r, w1()),
        at(&r, far_can()),
        parent(&r, far_can())
    );
    assert_eq!(far, Err("out_of_reach".to_owned()), "refused by name");
    assert_eq!(at(&r, w1()), before, "the body has not moved");
    assert_eq!(
        parent(&r, far_can()),
        (Some(ground()), None),
        "the can lies where it lay"
    );
    let beyond = a.act("test:take", Some(beyond_can()), none());
    println!("W10 take 2.2 m: {beyond:?}");
    assert_eq!(beyond, Err("out_of_reach".to_owned()));
    assert_eq!(parent(&run.replay(), beyond_can()), (Some(ground()), None));
    let near = a.act("test:take", Some(near_can()), none());
    let r = run.replay();
    println!(
        "W10 take 1.5 m: {near:?}; parent {:?}",
        parent(&r, near_can())
    );
    assert!(!near.expect("within reach: taken").is_empty());
    assert_eq!(parent(&r, near_can()).0, Some(w1()), "in the body's hand");
    assert_eq!(at(&r, w1()), before, "taken where the body stands");
    run.stop();
}

/// A walk's point, `{1: [x, y, z]}` in µm in its target's frame.
fn point(v: Vec3) -> BTreeMap<u64, Value> {
    let i =
        |n: i64| u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint);
    p(&[(1, Value::Array(vec![i(v.x), i(v.y), i(v.z)]))])
}

/// #4187, the trace: a Soul's take is running (its run open, its press under way) when its own controller sends a
/// walk. The walk is a move, which the bodies take, not the form runner. The walk replaces the run: in the take's
/// approach its claim on the legs ends the run, the take is refused `claim-taken` with nothing taken, and the walk is
/// done where it was sent. In lockstep, the walk arriving at a fixed tick: the take starts at tick 1 and is in its approach at ticks 2
/// and 3, which the walk's claim on the legs ends. From tick 4 the take is in its press, a hand move, which the walk
/// leaves at its next phase end ([`i4_a_walk_leaves_a_run_in_its_hand_move_at_the_next_phase_end`]).
#[test]
fn i4187_a_walk_sent_during_an_open_form_run() {
    let run = lockstep();
    let (take, walk) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
    let arrive = |tick, sequence, verb: &str, target, parameters, reply| {
        let bytes = intent_bytes(w1(), sequence, verb, target, parameters);
        run.world
            .events
            .send(answers::Event::ArrivalAt { tick, bytes, reply })
            .unwrap();
    };
    arrive(1, 1, "test:take", Some(vessel()), BTreeMap::new(), take.0);
    arrive(
        WALK_AT,
        2,
        "test:walk",
        Some(ground()),
        point(south(3_000_000)),
        walk.0,
    );
    let (done, ran) = std::sync::mpsc::channel();
    run.world
        .events
        .send(answers::Event::RunTo { tick: 400, done })
        .unwrap();
    ran.recv().unwrap();
    // The take's run started (its progress answer) before the walk arrived, and ended once.
    let final_of = |rx: &std::sync::mpsc::Receiver<Vec<u8>>| {
        let frames: Vec<_> = rx.try_iter().collect();
        let (progress, ends): (Vec<_>, Vec<_>) = frames
            .iter()
            .partition(|f| answers::progress_of(f).is_some());
        assert_eq!(ends.len(), 1, "one final answer");
        (progress.len(), answer_in(ends[0]))
    };
    let (first, second) = (final_of(&take.1), final_of(&walk.1));
    println!("#4187 trace: take then walk answered {first:?} then {second:?}");
    let r = run.replay();
    println!(
        "#4187 trace: body at {:?}, vessel parent {:?}",
        at(&r, w1()),
        parent(&r, vessel())
    );
    assert_eq!(
        first,
        (1, (1, Err("claim-taken".to_owned()))),
        "the take's run started, and is replaced"
    );
    assert!(
        matches!(second, (_, (2, Ok(_)))),
        "the walk is accepted and done"
    );
    assert_eq!(
        at(&r, w1()),
        south(3_000_000),
        "walked to where it was sent"
    );
    assert_eq!(
        parent(&r, vessel()),
        (Some(ground()), None),
        "nothing taken"
    );
    run.world.stop();
}

/// The tick #4187's walk arrives at: the take's approach (ticks 2 and 3).
const WALK_AT: i64 = 2;

/// The test world in lockstep (no socket): intents arrive at the ticks they name, and nothing waits on a clock.
fn lockstep() -> Run {
    lockstep_with(bodies)
}

/// [`lockstep`], its bodies made by `make`.
fn lockstep_with(make: fn() -> Result<Bodies, replica::effects::Refusal>) -> Run {
    lockstep_on(world(), make)
}

/// [`lockstep_with`] on `built`, the world as built.
fn lockstep_on(built: Replica, make: fn() -> Result<Bodies, replica::effects::Refusal>) -> Run {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.lockstep = true;
    cfg.bodies = Some(Box::new(move |_: &worldd::bodies::Placed| make()));
    cfg.engine = Some((
        tree_rules(),
        vec![
            activity(PAIR, ["test:first", "test:second"]),
            activity(CARRY, ["test:front", "test:back"]),
        ],
    ));
    let rules = Rules {
        kinds: entries(),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(built, rules, store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("c2-lockstep-{}.sock", std::process::id()));
    Run { world, store, path }
}

/// Soul `soul`'s intent, encoded as it arrives: its expiry far ahead of any world time.
fn intent_bytes(
    soul: Id,
    sequence: u64,
    verb: &str,
    target: Option<Id>,
    parameters: BTreeMap<u64, Value>,
) -> Vec<u8> {
    let i = Intent {
        actor: Actor::Soul(soul),
        verb: name(verb),
        target: target.map(Target::Node),
        parameters,
        sequence,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: answers::now() + 60_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// #4187: a second form act from the Soul's own controller while its first run is open. Before this change it was
/// refused `form-running` and the first ran on. Now it preempts: the first run is left (answered `left`, nothing
/// taken) and the second starts at once and lands.
#[test]
fn i4187_a_form_act_sent_during_an_open_form_run() {
    let (run, mut a, _) = serve("i4187f");
    a.send("test:take", Some(vessel()), BTreeMap::new());
    a.started();
    a.send("test:take", Some(near_can()), BTreeMap::new());
    let mut answers = [a.answer_of(), a.answer_of()];
    answers.sort_by_key(|(s, _)| *s);
    println!("#4187: take then take answered {answers:?}");
    let r = run.replay();
    println!(
        "#4187: vessel parent {:?}, can parent {:?}",
        parent(&r, vessel()),
        parent(&r, near_can())
    );
    let [(1, first), (2, second)] = answers else {
        panic!("{answers:?}")
    };
    assert_eq!(first, Err("left".to_owned()), "the first run is left");
    assert!(
        second.is_ok(),
        "the Soul's own new act is accepted: {second:?}"
    );
    assert_eq!(
        parent(&r, vessel()),
        (Some(ground()), None),
        "nothing of the first"
    );
    assert_eq!(
        parent(&r, near_can()).0,
        Some(w1()),
        "the can in the body's hand"
    );
    run.stop();
}

/// The take's answer and the walk's (their sequence, and the receipt's entries or the refusal's reason), where the
/// vessel is and where the walker stands.
type TakeThenWalk = (
    (u64, Result<Vec<u64>, String>),
    (u64, Result<Vec<u64>, String>),
    (Option<Id>, Option<u64>),
    Vec3,
);

/// #4187's take, its Soul's walk arriving at tick `walk_at`, in lockstep.
fn take_then_walk(walk_at: i64) -> TakeThenWalk {
    let run = lockstep();
    let (take, walk) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
    let arrive = |tick, sequence, verb: &str, target, parameters, reply| {
        let bytes = intent_bytes(w1(), sequence, verb, target, parameters);
        run.world
            .events
            .send(answers::Event::ArrivalAt { tick, bytes, reply })
            .unwrap();
    };
    arrive(1, 1, "test:take", Some(vessel()), BTreeMap::new(), take.0);
    arrive(
        walk_at,
        2,
        "test:walk",
        Some(ground()),
        point(south(3_000_000)),
        walk.0,
    );
    let (done, ran) = std::sync::mpsc::channel();
    run.world
        .events
        .send(answers::Event::RunTo { tick: 400, done })
        .unwrap();
    ran.recv().unwrap();
    let final_of = |rx: &std::sync::mpsc::Receiver<Vec<u8>>| {
        let ends: Vec<_> = rx
            .try_iter()
            .filter(|f| answers::progress_of(f).is_none())
            .collect();
        assert_eq!(ends.len(), 1, "one final answer");
        answer_in(&ends[0])
    };
    let (first, second) = (final_of(&take.1), final_of(&walk.1));
    let r = run.replay();
    let out = (first, second, parent(&r, vessel()), at(&r, w1()));
    run.world.stop();
    out
}

/// 0.134 I4, intents rule 10 in a hand move: the take's press starts at tick 8 and makes contact at about tick 14 (its
/// approach walk ends on the grip's point since 0.135 E20, not 300 mm short of it, so both are four ticks later than
/// they were; a walk arriving before tick 8 is in the run's walk, which its claim on the legs ends `claim-taken`). The
/// Soul's walk arriving before the contact leaves the run there (`left`, nothing taken); arriving after it, at the
/// press's end (`left`, the vessel taken at the contact stays in the hand). Either way the walk goes on and is done,
/// and no intent waits to its deadline.
#[test]
fn i4_a_walk_leaves_a_run_in_its_hand_move_at_the_next_phase_end() {
    let hand = (Some(w1()), Some(1));
    for (walk_at, taken) in [(10, false), (16, true)] {
        let (first, second, vessel_at, walker) = take_then_walk(walk_at);
        println!(
            "I4 walk at tick {walk_at}: take {first:?}, walk {second:?}, vessel {vessel_at:?}"
        );
        assert_eq!(first, (1, Err("left".to_owned())), "the run is left");
        assert!(matches!(second, (2, Ok(_))), "the walk is done: {second:?}");
        // Arrived: within the walk's reach of its spot (`skills::route::AT_SPOT`); where in it depends on its last
        // steps, and so on where the take's walk left the body.
        let to = south(3_000_000);
        let off = (i128::from(walker.x - to.x).pow(2) + i128::from(walker.z - to.z).pow(2)).isqrt();
        assert!(
            off <= i128::from(skills::route::AT_SPOT),
            "walked to where it was sent: {off} µm off"
        );
        if taken {
            assert_eq!(vessel_at, hand, "the effect landed at the contact stays");
        } else {
            assert_eq!(
                vessel_at,
                (Some(ground()), None),
                "left before the contact: nothing taken"
            );
        }
    }
}

// --- 0.133 N1: the never-stuck ladder in a served world ---------------------------------------------------------------

/// Where the first walker is sent: 5 m east, the only way out of its ring (below).
fn east() -> Vec3 {
    Vec3::new(at1().x + 5_000_000, 0, at1().z)
}

/// Where the second body stands in the ring's gap: 0.6 m east of the first.
fn in_the_gap() -> Vec3 {
    Vec3::new(at1().x + 600_000, 0, at1().z)
}

/// The first walker ringed 0.6 m round by bodies staying by their own orders (E3), every way but east; east, when
/// `gap`, the second body stands still in the ring's gap (staying too when `staying`); else the ring is closed.
fn ringed(gap: bool, staying: bool) -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let p1 = town.surfaces[&ground].place(w1(), frame, at1(), Quat::IDENTITY)?;
    let p2 = town.surfaces[&ground].place(
        w2(),
        frame,
        if gap { in_the_gap() } else { at2() },
        Quat::IDENTITY,
    )?;
    let mut ring = vec![
        (424_264, 424_264),
        (0, 600_000),
        (-424_264, 424_264),
        (-600_000, 0),
        (-424_264, -424_264),
        (0, -600_000),
        (424_264, -424_264),
    ];
    if !gap {
        ring.push((600_000, 0));
    }
    let mut places = Vec::new();
    for (k, (dx, dz)) in ring.into_iter().enumerate() {
        let who = id(40 + k as u64);
        let at = Vec3::new(at1().x + dx, 0, at1().z + dz);
        places.push((
            who,
            town.surfaces[&ground].place(who, frame, at, Quat::IDENTITY)?,
        ));
    }
    let mut b = Bodies::new(town, 50_000)?;
    b.add_body(humanoid(), p1)?;
    b.add_body(humanoid(), p2)?;
    for (who, placed) in places {
        b.add_body(humanoid(), placed)?;
        b.runner.staying.insert(who);
    }
    if staying {
        b.runner.staying.insert(w2());
    }
    Ok(b)
}

fn ring_with_a_still_body() -> Result<Bodies, replica::effects::Refusal> {
    ringed(true, false)
}
fn ring_with_a_staying_body() -> Result<Bodies, replica::effects::Refusal> {
    ringed(true, true)
}
fn ring_closed() -> Result<Bodies, replica::effects::Refusal> {
    ringed(false, false)
}

/// One walk of the first walker to `to`, sent at tick 1, run to tick `ticks` in lockstep: its final answer, and the
/// world's ladder entries in order (world time, event name, node, fields).
/// An answer: its sequence and its receipt's entries, or its refusal's reason.
type Answered = (u64, Result<Vec<u64>, String>);

fn walk_in(run: &Run, to: Vec3, ticks: i64) -> (Answered, Vec<Rungs>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let bytes = intent_bytes(w1(), 1, "test:walk", Some(ground()), point(to));
    run.world
        .events
        .send(answers::Event::ArrivalAt {
            tick: 1,
            bytes,
            reply: tx,
        })
        .unwrap();
    let (done, ran) = std::sync::mpsc::channel();
    run.world
        .events
        .send(answers::Event::RunTo { tick: ticks, done })
        .unwrap();
    ran.recv().unwrap();
    let ends: Vec<_> = rx
        .try_iter()
        .filter(|f| answers::progress_of(f).is_none())
        .collect();
    assert_eq!(ends.len(), 1, "one final answer");
    let log = run.store.0.lock().unwrap().bytes.clone();
    let mut rungs = Vec::new();
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            for v in e.events.iter().flatten() {
                if v.name.as_str().starts_with("souls:")
                    && [
                        "reroute",
                        "make-way",
                        "step-aside",
                        "shoulder-turn",
                        "order-ended",
                        "walk-out",
                        "walked-out",
                    ]
                    .contains(&&v.name.as_str()["souls:".len()..])
                {
                    assert_eq!(e.envelope.actor, Actor::World, "the world's own entry");
                    rungs.push((
                        e.envelope.at,
                        v.name.as_str().to_owned(),
                        e.envelope.node,
                        v.fields.clone(),
                    ));
                }
            }
        }
    }
    (answer_in(&ends[0]), rungs)
}

/// A ladder entry: world time, event name, node, fields.
type Rungs = (i64, String, Id, BTreeMap<u64, Value>);

fn names(rungs: &[Rungs]) -> Vec<(i64, &str)> {
    rungs
        .iter()
        .map(|r| (r.0 / 100_000, r.1.as_str()))
        .collect()
}

/// 0.133 N1 with A2-3's rule, end to end: the first walker's only way out of its ring is through the second body,
/// which stands still with no order to stay. It is routed again at 3 s, the world steps the second body aside at 5 s
/// (its entry the world's, on the body moved), and the walk arrives.
#[test]
fn n1_a_still_body_in_the_only_way_is_stepped_aside_and_the_walker_arrives() {
    let run = lockstep_with(ring_with_a_still_body);
    let (answer, rungs) = walk_in(&run, east(), 400);
    let r = run.replay();
    println!(
        "N1 make-way: {answer:?}; rungs {:?}; w2 at {:?}",
        names(&rungs),
        at(&r, w2())
    );
    let when = |n: &str| rungs.iter().find(|r| r.1 == n);
    let reroute = when("souls:reroute").expect("routed again").0;
    assert!(reroute >= 3_000_000, "routed again at 3 s: {reroute}");
    let aside = when("souls:step-aside").expect("a step aside");
    assert!(
        aside.0 >= 5_000_000,
        "after 5 s without progress: {}",
        aside.0
    );
    assert_eq!(
        (aside.2, &aside.3[&3]),
        (w2(), &w2().to_value()),
        "on the body moved"
    );
    assert_eq!(
        aside.3[&4],
        ladder_point(in_the_gap()),
        "from where it stood"
    );
    assert_eq!(
        ladder_point(at(&r, w2())),
        aside.3[&5],
        "where the world put it"
    );
    assert!(matches!(answer, (1, Ok(_))), "the walk arrives: {answer:?}");
    // Arrived: within the walk's reach of its spot (`skills::route::AT_SPOT`); where in it depends on its last steps.
    let (p, e) = (at(&r, w1()), east());
    let off = (i128::from(p.x - e.x).pow(2) + i128::from(p.z - e.z).pow(2)).isqrt();
    assert!(
        off <= i128::from(skills::route::AT_SPOT),
        "the walker arrived: {off} µm off"
    );
    run.world.stop();
}

/// 0.133 N1: the same ring, the second body staying by its own order. Nothing makes way: routed again at 3 s, then a
/// shoulder turn at 9 s; the staying body is never moved.
#[test]
fn n1_a_staying_body_is_never_moved_and_the_walker_turns_its_shoulder_at_9_s() {
    let run = lockstep_with(ring_with_a_staying_body);
    let (answer, rungs) = walk_in(&run, east(), 500);
    let r = run.replay();
    println!("N1 shoulder: {answer:?}; rungs {:?}", names(&rungs));
    let when = |n: &str| rungs.iter().find(|r| r.1 == n).map(|r| r.0);
    let reroute = when("souls:reroute").expect("routed again");
    let shoulder = when("souls:shoulder-turn").expect("a shoulder turn");
    assert!(reroute >= 3_000_000, "routed again at 3 s: {reroute}");
    assert!(shoulder >= 9_000_000, "a shoulder turn at 9 s: {shoulder}");
    assert!(
        when("souls:step-aside").is_none(),
        "a staying body is never moved"
    );
    assert_eq!(at(&r, w2()), in_the_gap(), "never moved");
    run.world.stop();
}

/// 0.133 N1: a walker in a closed ring of bodies staying by their own orders gets nowhere: routed again at 3 s, a
/// shoulder turn at 9 s, and at 15 s its order ends by name, `goal-unreachable`, the entry naming how far it is from
/// its leg's end; the walk's receipt is that refusal.
#[test]
fn n1_a_walker_that_gets_nowhere_ends_goal_unreachable_at_15_s() {
    let run = lockstep_with(ring_closed);
    let (answer, rungs) = walk_in(&run, east(), 500);
    println!("N1 unreachable: {answer:?}; rungs {:?}", names(&rungs));
    assert_eq!(answer, (1, Err("goal-unreachable".to_owned())));
    let when = |n: &str| rungs.iter().find(|r| r.1 == n);
    assert!(when("souls:reroute").expect("routed again").0 >= 3_000_000);
    assert!(when("souls:shoulder-turn").expect("a shoulder turn").0 >= 9_000_000);
    let ended = when("souls:order-ended").expect("its order ended");
    assert!(ended.0 >= 15_000_000, "at 15 s: {}", ended.0);
    assert_eq!(ended.3[&3], Value::Bytes(b"goal-unreachable".to_vec()));
    let Value::Bytes(why) = &ended.3[&4] else {
        panic!("what it waited for")
    };
    let why = String::from_utf8_lossy(why);
    println!("N1 unreachable: {why}");
    assert!(why.contains("no progress for"), "{why}");
    run.world.stop();
}

/// A point as the ladder's entries write it: `[x, y, z]` µm.
fn ladder_point(p: Vec3) -> Value {
    let i =
        |n: i64| u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint);
    Value::Array(vec![i(p.x), i(p.y), i(p.z)])
}

/// 0.133 N1, the last rung, on the bodies of a served world: the ground under a body on the building's ground floor
/// changes (a box set down over it, an edit the builder let through), the runner finds it off the ground, and it
/// walks out to the nearest point it may stand on, at walking speed, no tick further than a walking step; the world's
/// entries name the walk-out and where it stands again.
#[test]
fn n1_a_body_found_off_the_ground_walks_out() {
    use sim::ground::{HUMAN_RADIUS, Scene as GroundScene, Solid, Turn as GroundTurn, cut_floor};
    use sim::mover::Surface;
    let w = testworld::generate(1, 0).expect("the test world");
    let floor = import_eden::load(&w.text)
        .expect("the test world loads")
        .nodes["building/floor-0"];
    let (town, _) = town();
    let from = Vec3::new(0, 0, -3_000_000);
    let frame = Frame {
        node: floor,
        slot: None,
    };
    let placed = town.surfaces[&floor]
        .place(w2(), frame, from, Quat::IDENTITY)
        .expect("on the floor");
    let mut b = Bodies::new(town, 50_000).expect("the bodies");
    b.add_body(humanoid(), placed).expect("the body");
    let tick = b.runner.tick;
    let mut now = 0;
    for _ in 0..4 {
        now += tick;
        b.step(now);
    }
    let mut scene = GroundScene::of(&b.town.tree, floor).expect("the floor's scene");
    scene.solids.push(Solid {
        ring: [
            [-600_000, -3_600_000],
            [600_000, -3_600_000],
            [600_000, -2_400_000],
            [-600_000, -2_400_000],
        ],
        y0: 0,
        y1: 2_000_000,
    });
    let patch = cut_floor(&scene, HUMAN_RADIUS, GroundTurn::NONE).expect("the new ground");
    b.town
        .surfaces
        .insert(floor, Surface::new(floor, patch.pieces.clone()));
    b.town.versions.bump([&floor]);
    let (mut was, mut largest) = (from, 0);
    let mut entries = Vec::new();
    for _ in 0..200 {
        now += tick;
        b.step(now);
        entries.extend(std::mem::take(&mut b.wind_log));
        let p = b
            .runner
            .controller
            .body(w2())
            .expect("the body")
            .pose
            .position;
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        largest = largest.max((d(p.x, was.x) + d(p.z, was.z)).isqrt() as i64);
        was = p;
        if entries.iter().any(|e| named(e, "souls:walked-out")) {
            break;
        }
    }
    let to = b
        .runner
        .controller
        .body(w2())
        .expect("the body")
        .pose
        .position;
    println!("N1 walk-out: from {from:?} to {to:?}, largest step {largest} um");
    let out = entries
        .iter()
        .find(|e| named(e, "souls:walk-out"))
        .expect("a walk-out");
    assert_eq!(
        (out.envelope.actor, out.envelope.node),
        (Actor::World, w2())
    );
    assert!(
        entries.iter().any(|e| named(e, "souls:walked-out")),
        "walked out"
    );
    assert!(
        b.town.surfaces[&floor]
            .place(w2(), frame, to, Quat::IDENTITY)
            .is_ok(),
        "on ground it may stand on"
    );
    assert!(
        largest <= worldd::bodies::WALK * tick / 1_000_000 + 1,
        "no jump: {largest} um in a tick"
    );
}

fn named(e: &Effect, name: &str) -> bool {
    e.events.iter().flatten().any(|v| v.name.as_str() == name)
}

/// The form runs' endings the log holds, by name (`souls:form-ended`'s field 3).
fn endings(run: &Run) -> Vec<String> {
    let log = run.store.0.lock().unwrap().bytes.clone();
    let mut out = Vec::new();
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            for ev in e.events.iter().flatten() {
                if ev.name.as_str() == "souls:form-ended"
                    && let Some(Value::Bytes(how)) = ev.fields.get(&3)
                {
                    out.push(String::from_utf8_lossy(how).into_owned());
                }
            }
        }
    }
    out
}

/// N2 (0.133): a world stopped with a form's run open (a take, walking to its thing) and a gateway walk under way,
/// then started again from its log. The open run is ended `restart` in the log in the first tick; each intent, sent
/// again as the gateway sends the unanswered ones, starts afresh and ends with its receipt, well before its deadline.
/// (This harness's bodies start where it built them; a served world stands each where the log last had it.)
#[test]
// A real world on the real clock: an answer's time is real time.
#[allow(clippy::disallowed_methods)]
fn n2_a_run_open_at_a_restart_ends_by_name_and_its_intent_starts_again() {
    let store = Mem::with(Vec::new());
    let (run, mut a, mut b) = serve_on("n2a", store.clone());
    b.send("test:walk", Some(ground()), point(south(12_000_000)));
    b.started();
    std::thread::sleep(Duration::from_millis(1500));
    a.send("test:take", Some(vessel()), BTreeMap::new());
    a.started();
    let (take, walk) = (a.3.clone(), b.3.clone());
    assert_ne!(at(&run.replay(), w2()), at2(), "the walker was under way");
    run.world.stop();

    let (run, mut a, mut b) = serve_on("n2b", store);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        endings(&run),
        ["souls:restart"],
        "the take's open run ended by name in the first tick"
    );
    PROGRESSED.with(|p| p.borrow_mut().clear());
    let t0 = std::time::Instant::now();
    a.raw(&take);
    b.raw(&walk);
    assert!(
        matches!(a.answer_of(), (1, Ok(_))),
        "the take starts again and lands"
    );
    assert!(
        matches!(b.answer_of(), (1, Ok(_))),
        "the walk is planned again from where it stood and arrives"
    );
    assert!(
        t0.elapsed() < Duration::from_secs(15),
        "no intent waits to its deadline: {:?}",
        t0.elapsed()
    );
    let r = run.replay();
    assert_eq!(parent(&r, vessel()).0, Some(w1()), "the vessel in the hand");
    let off = (at(&r, w2()).z - south(12_000_000).z).abs();
    assert!(
        off <= 100_000,
        "at the walk's goal, within 10 cm: {off} µm off"
    );
    run.stop();
}

/// 0.133 A2-4: a place already full. Nine bodies stand at the walk's goal, 0.35 m apart, staying by their own orders;
/// the walker gets as near as they allow and its walk ends `done`, saying so: its `souls:move-ended` names
/// `done.as-near-as-the-crowd-allows`.
fn full_place() -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let p1 = town.surfaces[&ground].place(w1(), frame, at1(), Quat::IDENTITY)?;
    let p2 = town.surfaces[&ground].place(w2(), frame, at2(), Quat::IDENTITY)?;
    let mut places = Vec::new();
    for k in 0..9i64 {
        let who = id(60 + k as u64);
        let at = Vec3::new(
            east().x + (k % 3 - 1) * 350_000,
            0,
            east().z + (k / 3 - 1) * 350_000,
        );
        places.push((
            who,
            town.surfaces[&ground].place(who, frame, at, Quat::IDENTITY)?,
        ));
    }
    let mut b = Bodies::new(town, 50_000)?;
    b.add_body(humanoid(), p1)?;
    b.add_body(humanoid(), p2)?;
    for (who, placed) in places {
        b.add_body(humanoid(), placed)?;
        b.runner.staying.insert(who);
    }
    Ok(b)
}

/// How each walk ended, as its `souls:move-ended` names it, in the log's order.
fn moves_ended(run: &Run) -> Vec<String> {
    let log = run.store.0.lock().unwrap().bytes.clone();
    let mut how = Vec::new();
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            for v in e.events.iter().flatten() {
                if v.name.as_str() == answers::MOVE_ENDED
                    && let Some(Value::Bytes(b)) = v.fields.get(&2)
                {
                    how.push(String::from_utf8_lossy(b).into_owned());
                }
            }
        }
    }
    how
}

#[test]
fn a2_4_a_walk_to_a_full_place_ends_done_as_near_as_the_crowd_allows() {
    let run = lockstep_with(full_place);
    let (answer, _) = walk_in(&run, east(), 400);
    let r = run.replay();
    let p = at(&r, w1());
    let off = (i128::from(p.x - east().x).pow(2) + i128::from(p.z - east().z).pow(2)).isqrt();
    let how = moves_ended(&run);
    println!("A2-4 full place: {answer:?}; ended {off} µm from the goal; move-ended {how:?}");
    assert!(matches!(answer, (1, Ok(_))), "a done: {answer:?}");
    assert!(
        off > 300_000 && off <= 3_000_000,
        "short of the goal, near it: {off} µm"
    );
    assert_eq!(
        how,
        vec![answers::DONE_SHORT.to_owned()],
        "it names that it stopped short"
    );
    run.world.stop();
}

/// 0.133 A2-4 (review of #4364, the reviewer's ring): eight bodies stand round the walk's goal, 0.6 m out: seven stay
/// by their own orders, and the second body, on the walker's side, stands still with no order to stay. The goal's
/// spot is free, the ring round it close (0.46 m between neighbours).
fn ringed_goal() -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let on = |dx: i64, dz: i64| Vec3::new(east().x + dx, 0, east().z + dz);
    let p1 = town.surfaces[&ground].place(w1(), frame, at1(), Quat::IDENTITY)?;
    let p2 = town.surfaces[&ground].place(w2(), frame, on(-600_000, 0), Quat::IDENTITY)?;
    let ring = [
        (600_000, 0),
        (424_264, 424_264),
        (0, 600_000),
        (-424_264, 424_264),
        (-424_264, -424_264),
        (0, -600_000),
        (424_264, -424_264),
    ];
    let mut places = Vec::new();
    for (k, (dx, dz)) in ring.into_iter().enumerate() {
        let who = id(60 + k as u64);
        places.push((
            who,
            town.surfaces[&ground].place(who, frame, on(dx, dz), Quat::IDENTITY)?,
        ));
    }
    let mut b = Bodies::new(town, 50_000)?;
    b.add_body(humanoid(), p1)?;
    b.add_body(humanoid(), p2)?;
    for (who, placed) in places {
        b.add_body(humanoid(), placed)?;
        b.runner.staying.insert(who);
    }
    Ok(b)
}

/// The walk is not ended short of its free spot by the ring: a way round and the world's ladder have their turn. The
/// world steps the still body aside (make-way), and the walk arrives on its spot, a plain `done`.
#[test]
fn a2_4_a_walk_to_a_spot_ringed_by_bodies_arrives_through_make_way() {
    let run = lockstep_with(ringed_goal);
    let (answer, rungs) = walk_in(&run, east(), 600);
    let r = run.replay();
    let p = at(&r, w1());
    let off = (i128::from(p.x - east().x).pow(2) + i128::from(p.z - east().z).pow(2)).isqrt();
    let how = moves_ended(&run);
    println!(
        "A2-4 ringed goal: {answer:?}; rungs {:?}; ended {off} µm from the goal; move-ended {how:?}; w2 at {:?}",
        names(&rungs),
        at(&r, w2())
    );
    assert!(matches!(answer, (1, Ok(_))), "a done: {answer:?}");
    assert!(
        rungs.iter().any(|r| r.1 == "souls:step-aside"),
        "the still body in the ring was stepped aside"
    );
    assert_eq!(how, vec!["done".to_owned()], "a plain done, not short");
    assert!(
        off <= i128::from(skills::route::AT_SPOT),
        "on its spot: {off} µm off"
    );
    run.world.stop();
}

// ---- 0.135 R2 off the clock (follow-up to #4564): a lift whose way must turn its load waits for it off the clock. --

/// How many crews lift in one tick.
const CREWS: u64 = 20;

/// Crew `k`'s front and back walkers and its plank.
fn crew(k: u64) -> (Id, Id, Id) {
    (id(100 + 2 * k), id(101 + 2 * k), id(200 + k))
}

/// Where crew `k`'s front and back stand: as A4's two, the crews in a row north of them 2.5 m apart.
fn crew_at(k: u64) -> (Vec3, Vec3) {
    let z = at1().z + k as i64 * 2_500_000;
    (Vec3::new(at1().x, 0, z), Vec3::new(at2().x, 0, z))
}

/// Where every crew's lift sends its front: inside a room of walls with no door, 4 m square, east of the crews.
fn sealed() -> Vec3 {
    Vec3::new(-30_000_000, 0, 54_000_000)
}

/// The zone's place: the replica's root, the open ground under it (so a carry reads its fixed geometry, 0.135 C7).
fn zone_place() -> Id {
    id(90)
}

/// The test world with the crews and their planks, on an open ground under the zone's place, and the sealed room's
/// walls: each plank between its crew's two (as A4's), the crews in a row west of the room.
fn crews_world() -> Replica {
    let g = ground();
    let mut changes = vec![create(g, OPEN_GROUND, zone_place(), Vec3::ZERO)];
    let (on, mut wall) = create(id(91), WALLS, g, sealed());
    let int =
        |n: i64| u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint);
    let rows = [
        [0, 2_000, 2_000, 100],
        [0, -2_000, 2_000, 100],
        [2_000, 0, 100, 2_000],
        [-2_000, 0, 100, 2_000],
    ]
    .iter()
    .map(|[cx, cz, hx, hz]| Value::Array([*cx, *cz, *hx, *hz, 0, 0, 2_400].map(int).to_vec()))
    .collect();
    if let Change::Create { fields, .. } = &mut wall {
        fields.insert(sim::ground::scene::F_SOLIDS, Value::Array(rows));
    }
    changes.push((on, wall));
    for k in 0..CREWS {
        let ((f, b, plank), (at_f, at_b)) = (crew(k), crew_at(k));
        changes.push(create(f, WALKER, g, at_f));
        changes.push(create(b, WALKER, g, at_b));
        changes.push(create(
            plank,
            PLANK,
            g,
            Vec3::new(at_b.x + 1_350_000, 0, at_b.z),
        ));
    }
    world_of(zone_place(), changes)
}

fn crews_bodies() -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let mut placed = Vec::new();
    for k in 0..CREWS {
        let ((f, b, _), (at_f, at_b)) = (crew(k), crew_at(k));
        placed.push(town.surfaces[&ground].place(f, frame, at_f, Quat::IDENTITY)?);
        placed.push(town.surfaces[&ground].place(b, frame, at_b, Quat::IDENTITY)?);
    }
    let mut b = Bodies::new(town, 50_000)?;
    for p in placed {
        b.add_body(humanoid(), p)?;
    }
    Ok(b)
}

/// What a lift was answered, and at which tick.
type Lift = (i64, Result<Vec<u64>, String>);

/// The crews' run: what each lift was answered and at which tick, the zone's state after it, and the clock's ticks
/// over the 50 ms budget while the lifts were taken and answered (ticks 4 to 8), and the longest of those ticks.
#[derive(Debug, PartialEq)]
struct Lifted {
    answers: Vec<Lift>,
    state: [u8; 32],
    over: u64,
    longest_us: u64,
    /// What the engine still keeps for lifts' ways after the run: lifts waiting, ways back not yet read.
    kept: (usize, usize),
}

/// In lockstep, every crew's carry is proposed (tick 1), joined (2) and started (3), then every crew lifts its plank
/// in tick 4, its front sent into the sealed room east of them: the straight way there clips the room's walls, so each
/// lift's way is searched off the clock, and no way gets in (the costliest search: its whole budget, or its band).
/// `deadline`, when given, is how long each act stays open. With `both`, each crew's two carriers lift in tick 4, each
/// to 5 m east of its front on clear ground: the front's lift lands when its way comes back, the back's is refused
/// `carry-lifted`.
fn crews_lift(deadline: Option<replica::time::Micros>, both: bool) -> Lifted {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.lockstep = true;
    cfg.measures = true;
    if let Some(d) = deadline {
        cfg.deadline = d;
    }
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| crews_bodies()));
    cfg.engine = Some((
        tree_rules(),
        vec![activity(CARRY, ["test:front", "test:back"])],
    ));
    let rules = Rules {
        kinds: entries(),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(crews_world(), rules, store.clone(), cfg).expect("the world starts");
    let run = Run {
        world,
        store,
        path: std::env::temp_dir().join("r2-off-clock-unused.sock"),
    };
    let run_to = |tick| {
        let (done, ran) = std::sync::mpsc::channel();
        run.world
            .events
            .send(answers::Event::RunTo { tick, done })
            .unwrap();
        ran.recv().expect("the clock ran")
    };
    let mut sequence = BTreeMap::<Id, u64>::new();
    let mut ask = |tick, soul: Id, verb: &str, target, parameters| {
        let s = sequence.entry(soul).or_default();
        *s += 1;
        let (reply, rx) = std::sync::mpsc::channel();
        let bytes = intent_bytes(soul, *s, verb, Some(target), parameters);
        run.world
            .events
            .send(answers::Event::ArrivalAt { tick, bytes, reply })
            .unwrap();
        rx
    };
    let answered = |rx: &std::sync::mpsc::Receiver<Vec<u8>>| {
        rx.try_iter()
            .find(|f| answers::progress_of(f).is_none())
            .map(|f| answer_in(&f).1)
    };
    let health = || {
        let h = parse(&run.world.measures.as_ref().unwrap().health(0)).unwrap();
        let int = |v: Option<&Json>| match v {
            Some(Json::Int(n)) => *n as u64,
            other => panic!("a count: {other:?}"),
        };
        // The last tick's time: its phases' sum.
        let last = match h.get("last_tick_us") {
            Some(Json::Obj(phases)) => phases.iter().map(|(_, us)| int(Some(us))).sum(),
            other => panic!("the last tick's phases: {other:?}"),
        };
        (int(h.get("over_budget")), last)
    };
    let role = |r: &str| p(&[(1, Value::Text(name(r)))]);
    let proposed: Vec<_> = (0..CREWS)
        .map(|k| {
            let kind = p(&[(1, Value::Text(name(&fullname(CARRY))))]);
            ask(1, crew(k).0, "activity:propose", ground(), kind)
        })
        .collect();
    run_to(1);
    let carries: Vec<Id> = proposed
        .iter()
        .map(|rx| run.created(&answered(rx).expect("answered").expect("proposed"), CARRY))
        .collect();
    let mut steps = Vec::new();
    for (k, &c) in carries.iter().enumerate() {
        let (f, b, _) = crew(k as u64);
        steps.push((2, ask(2, f, "activity:join", c, role("test:front"))));
        steps.push((2, ask(2, b, "activity:join", c, role("test:back"))));
        steps.push((3, ask(3, f, "activity:start", c, BTreeMap::new())));
    }
    run_to(3);
    for (tick, rx) in &steps {
        let a = answered(rx).unwrap_or_else(|| panic!("tick {tick}: unanswered"));
        a.unwrap_or_else(|r| panic!("tick {tick}: {r}"));
    }
    let (over_before, _) = health();
    let mut lifts = Vec::new();
    for (k, &c) in carries.iter().enumerate() {
        let ((f, b, plank), (at_f, _)) = (crew(k as u64), crew_at(k as u64));
        let to = match both {
            true => Vec3::new(at_f.x + 5_000_000, 0, at_f.z),
            false => sealed(),
        };
        let lift = p(&[(1, plank.to_value()), (2, point(to).remove(&1).unwrap())]);
        lifts.push(ask(4, f, "carry:lift", c, lift.clone()));
        if both {
            lifts.push(ask(4, b, "carry:lift", c, lift));
        }
    }
    let mut answers: Vec<Option<Lift>> = vec![None; lifts.len()];
    let (mut state, mut longest_us, mut kept) = ([0; 32], 0, (0, 0));
    for tick in 4..=8 {
        let ran = run_to(tick);
        (state, kept) = (ran.state, ran.ways_kept);
        longest_us = longest_us.max(health().1);
        for (a, rx) in answers.iter_mut().zip(&lifts) {
            if a.is_none() {
                *a = answered(rx).map(|r| (tick, r));
            }
        }
    }
    let (over_after, _) = health();
    run.world.stop();
    Lifted {
        answers: answers
            .into_iter()
            .map(|a| a.expect("every lift answered"))
            .collect(),
        state,
        over: over_after - over_before,
        longest_us,
        kept,
    }
}

/// 0.135 R2 off the clock: twenty crews lift in one tick, each lift's way into the sealed room searched (up to
/// `turn::BUDGET` poses, a few milliseconds each in release). The searches run on the way thread, never on the clock
/// (there a search panics the clock in a debug build and is counted in a release build), so no tick runs over its
/// 50 ms, and each lift is answered the tick after it was taken, lockstep having waited for its way before that tick
/// as it waits for every check. Run again with the same inputs, every answer lands at the same tick and the zone ends
/// in the same state.
#[test]
fn r2_twenty_crews_lift_in_one_tick_and_every_tick_is_on_time() {
    let on_clock = sim::commit::checks_on_clock();
    let first = crews_lift(None, false);
    println!(
        "R2 off the clock: {} lifts answered {:?}; ticks 4 to 8 over budget {}, the longest of them {} µs",
        first.answers.len(),
        first
            .answers
            .iter()
            .map(|(t, r)| (*t, r.as_ref().map(|_| "lifted").map_err(String::as_str)))
            .collect::<BTreeSet<_>>(),
        first.over,
        first.longest_us
    );
    assert_eq!(
        sim::commit::checks_on_clock(),
        on_clock,
        "no search on the clock"
    );
    assert!(
        first.answers.iter().all(|(tick, _)| *tick == 5),
        "each lift answered the tick after it was taken: {:?}",
        first.answers
    );
    assert!(
        first.answers.iter().all(|(_, r)| matches!(
            r.as_ref().map_err(String::as_str),
            Err("carry-unproven" | "carry-load-blocked")
        )),
        "each searched, and no way into the sealed room: {:?}",
        first.answers
    );
    // The time bound holds a release build to the 50 ms tick; a debug build on a loaded runner is only reported.
    if !cfg!(debug_assertions) {
        assert_eq!(first.over, 0, "no tick over its budget");
    }
    assert_eq!(
        first.kept,
        (0, 0),
        "nothing kept for the lifts once answered"
    );
    let again = crews_lift(None, false);
    assert_eq!(
        again.answers, first.answers,
        "the same answers at the same ticks"
    );
    assert_eq!(again.state, first.state, "the same state: the run replays");
}

/// 0.135 R2 off the clock: a lift whose way has not come back by its act's deadline is refused `carry-way-late`, and
/// the way that comes back after is dropped (each act open one microsecond: the ways come back before tick 5 and the
/// deadlines pass at its start).
#[test]
fn r2_a_lift_whose_way_is_late_is_refused_by_name() {
    let late = crews_lift(Some(1), false);
    assert!(
        late.answers
            .iter()
            .all(|a| *a == (5, Err("carry-way-late".to_owned()))),
        "{:?}",
        late.answers
    );
    assert_eq!(late.kept, (0, 0), "nothing kept for the late lifts");
}

/// 0.135 R2 off the clock (review of #4593): both carriers of each crew lift their carry in one tick. Both wait for
/// their ways; when the ways come back the front's lift lands and the back's is refused `carry-lifted` before it reads
/// its way. Nothing is kept for either afterwards: no lift waiting, no way (and no ground's geometry) held.
#[test]
fn r2_two_carriers_lift_one_carry_in_one_tick_and_nothing_is_kept() {
    let both = crews_lift(None, true);
    for (k, pair) in both.answers.chunks(2).enumerate() {
        assert!(
            matches!(&pair[0], (5, Ok(_))),
            "crew {k}'s front lifts: {:?}",
            pair[0]
        );
        assert_eq!(
            pair[1],
            (5, Err("carry-lifted".to_owned())),
            "crew {k}'s back"
        );
    }
    assert_eq!(both.kept, (0, 0), "nothing kept for the lifts");
}

/// N14: a lift whose one cabin runs across and back between its low stop (where it is declared, its stand point 800 mm
/// south) and its high stop 4 m north, east of the walkers. Its `board` sets it off (`under_way`, as the cable car's
/// `ride`) and needs it not under way; it is left by a rise.
fn lift() -> Id {
    id(12)
}
fn lift_at() -> Vec3 {
    Vec3::new(-36_000_000, 0, 30_000_000)
}
fn lift_entry() -> Json {
    parse(
        r#"{ "format": "souls-entry/1", "kind": "test:lift", "owner": "thing",
      "state": { "under_way": { "n": 28, "type": "bool", "default": false, "audience": { "rule": "everyone" } } },
      "points": { "low": { "role": "stand", "at_mm": [0, 0, -800], "yaw_mdeg": 0 },
        "high": { "role": "stand", "at_mm": [0, 0, 3200], "yaw_mdeg": 0 } },
      "slots": { "cabin": { "admits": "body", "posture": "sit", "most": 1, "at_mm": [0, 450, 0], "stand": "low" } },
      "geometry": { "bounds_mm": [2000, 3000, 6000] },
      "forms": {
        "board": { "who": "anyone", "starts": "act",
          "takes": { "seat": { "type": "slot",
            "select": { "of": "free_slots", "in": "this", "anchor": "me", "order": "nearest", "rank": 1 } } },
          "needs": [{ "need": "state", "field": "under_way", "is": false }, { "need": "slot_free", "slot": { "arg": "seat" } }],
          "steps": [{ "step": "walk_to", "point": { "arg": "seat" } }, { "step": "sit", "slot": { "arg": "seat" } }],
          "effects": [{ "change": "reparent", "what": "actor", "into": { "arg": "seat" }, "event": "boarded" },
            { "change": "set", "field": "under_way", "to": true, "event": "set_off" }] },
        "get_off": { "who": "anyone", "starts": "act", "steps": [{ "step": "rise" }] } },
      "ride": { "seats": ["cabin"], "stops": ["low", "high"], "returns": true, "start": "board",
        "speed_mm_s": 1000, "ground": "level" } }"#,
    )
    .unwrap()
}
/// How long the lift's cabin waits at each stop here, µs: 8 s, not a ride's 3 minutes, so a test sees a whole lap (8 s
/// at the low stop from the world's start, 4 s up, 8 s at the high stop, 4 s down, and again).
const LIFT_STOP: i64 = 8_000_000;
/// The lift's cabin seat as a served world registers it, and its run (`sim::courses::rides::seat_runs`, as
/// `worldd::places::runs` gives it) on the open ground, from the world's start (world time is real time), each stop
/// [`LIFT_STOP`] long.
#[allow(clippy::disallowed_methods)]
fn lift_place(ground: Id) -> (sim::slots::PlaceAt, sim::courses::rides::SeatRun) {
    let place = sim::slots::PlaceAt {
        thing: lift(),
        place: replica::moves::Place {
            slot: 1,
            height: 450_000,
            stand: [0, -800_000],
        },
        point: Vec3::new(lift_at().x, 450_000, lift_at().z),
        facing: Quat::IDENTITY,
        floor: ground,
        more: Vec::new(),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64;
    let seats = BTreeMap::from([(1, place.clone())]);
    let at = lift_at();
    let mut runs = sim::courses::rides::seat_runs(
        &lift_entry(),
        &seats,
        &|p: Vec3| p.plus(at).ok(),
        &|_, _| Some(0),
        now,
    );
    assert_eq!(runs.len(), 1, "the cabin runs");
    let mut r = runs.remove(0);
    for s in &mut r.course.stations {
        s.dwell = LIFT_STOP;
    }
    r.course.within = r.course.load().expect("a lap").period;
    assert_eq!(r.ends.len(), 1, "its trip's end sets under_way back");
    (place, r)
}

/// The lift's `under_way` (field 28) as the log has it: 1 set off, 0 not.
fn under_way(r: &Replica) -> Option<Value> {
    let t = r.tree();
    t.node(t.handle(lift()).unwrap())
        .unwrap()
        .fields()
        .get(&28)
        .cloned()
}

/// N14: a Soul boards a cabin at its stop through the gateway, setting the lift off; another is refused while it is
/// under way. The rider is carried in its seat while the cabin is between stops (a rise is refused `boarding-frame-away`
/// and it stays in the slot), and gets off at the far stop, on its feet at that stop's stand point, 4 m from where it
/// got on: never set down mid-way, never left aloft. The trip ended at that stop (`under_way` back to false), so the
/// lift is never stuck under way: while the cabin is away a board is refused before any walk, saying when it is back,
/// and once it is back the Soul boards it again.
#[test]
// The world's clock is real time: the test reads it to wait for the cabin (#1926's way).
#[allow(clippy::disallowed_methods)]
fn n14_a_soul_rides_a_cabin_gets_off_at_the_far_stop_and_boards_again_through_the_gateway() {
    let started = std::time::Instant::now();
    let at =
        |ms: u64| std::thread::sleep(Duration::from_millis(ms).saturating_sub(started.elapsed()));
    let (run, mut a, mut b) = serve("n14");
    let boarded = a.act("test:board", Some(lift()), BTreeMap::new());
    println!("N14 board: {boarded:?} after {:?}", started.elapsed());
    boarded.expect("boarded at its stop");
    let r = run.replay();
    assert_eq!(parent(&r, w1()), (Some(lift()), Some(1)));
    assert_eq!(under_way(&r), Some(Value::Uint(1)), "set off");
    // The world wrote the cabin's course onto the lift at its start, for every copy and the page to read.
    let t = r.tree();
    let written = t
        .node(t.handle(lift()).unwrap())
        .unwrap()
        .fields()
        .get(&replica::schedule::F_SEAT_COURSES)
        .cloned();
    let Some(Value::Map(courses)) = written else {
        panic!("no seat courses on the lift: {written:?}")
    };
    let course = replica::schedule::course::Course::read(&courses[&1]).expect("a course");
    assert_eq!(course.stations.len(), 2);
    assert_eq!(course.stations[1].at.z - course.stations[0].at.z, 4_000_000);
    let other = b.act("test:board", Some(lift()), BTreeMap::new());
    println!("N14 another board while under way: {other:?}");
    assert!(other.is_err(), "its one seat is taken");
    // On its way to the far stop (it leaves 8 s in and takes 4 s): carried, not set down.
    at(10_000);
    let away = a.act("test:get_off", Some(lift()), BTreeMap::new());
    println!(
        "N14 get off on the way: {away:?} after {:?}",
        started.elapsed()
    );
    assert_eq!(away, Err("boarding-frame-away".to_owned()));
    assert_eq!(
        parent(&run.replay(), w1()),
        (Some(lift()), Some(1)),
        "still in its seat"
    );
    // At the far stop the trip has ended, and it gets off there.
    at(14_500);
    assert_eq!(
        under_way(&run.replay()),
        Some(Value::Uint(0)),
        "the trip ended at the stop"
    );
    let off = a.act("test:get_off", Some(lift()), BTreeMap::new());
    println!(
        "N14 get off at the far stop: {off:?} after {:?}",
        started.elapsed()
    );
    off.expect("gets off at the far stop");
    let r = run.replay();
    assert_eq!(parent(&r, w1()), (Some(ground()), None), "on the ground");
    let t = r.tree();
    let p = t
        .node(t.handle(w1()).unwrap())
        .unwrap()
        .place()
        .unwrap()
        .position;
    let high = Vec3::new(lift_at().x, 0, lift_at().z + 3_200_000);
    println!("N14 stands at {p:?}, the far stand point {high:?}");
    assert!(
        (p.x - high.x).abs() <= 300_000 && (p.z - high.z).abs() <= 300_000,
        "at the far stop's stand point"
    );
    // While the cabin is on its way back, a board is refused before any walk, saying when it is back.
    at(21_000);
    let early = a.act("test:board", Some(lift()), BTreeMap::new());
    println!("N14 board while the cabin is away: {early:?}");
    assert_eq!(early, Err("boarding-frame-away".to_owned()));
    let still = run.replay();
    let t = still.tree();
    assert_eq!(
        t.node(t.handle(w1()).unwrap())
            .unwrap()
            .place()
            .unwrap()
            .position,
        p,
        "not walked toward a cabin that is away"
    );
    // Back at its stop: the Soul boards it again.
    at(24_500);
    let again = a.act("test:board", Some(lift()), BTreeMap::new());
    println!("N14 board again: {again:?} after {:?}", started.elapsed());
    again.expect("boards again once the cabin is back");
    let r = run.replay();
    assert_eq!(parent(&r, w1()), (Some(lift()), Some(1)), "aboard again");
    assert_eq!(under_way(&r), Some(Value::Uint(1)), "set off again");
    run.stop();
}

/// N14 review: a small wheel of four gondolas (bottom, right, top, left of a ring 2 m across, its bottom 0.45 m up), all
/// boarded from one stand point 1 m in front of it, 5 m north of the first walker. Its `board` names no gondola.
fn wheel() -> Id {
    id(13)
}
fn wheel_at() -> Vec3 {
    Vec3::new(-40_000_000, 0, 36_000_000)
}
fn wheel_entry() -> Json {
    parse(
        r#"{ "format": "souls-entry/1", "kind": "test:wheel", "owner": "thing",
      "points": { "boarding": { "role": "stand", "at_mm": [0, 0, -1000] }, "out": { "role": "stand", "at_mm": [0, 0, 1000] } },
      "slots": {
        "g1": { "admits": "body", "posture": "sit", "most": 1, "at_mm": [0, 450, 0], "stand": "boarding" },
        "g2": { "admits": "body", "posture": "sit", "most": 1, "at_mm": [2000, 2450, 0], "stand": "boarding" },
        "g3": { "admits": "body", "posture": "sit", "most": 1, "at_mm": [0, 4450, 0], "stand": "boarding" },
        "g4": { "admits": "body", "posture": "sit", "most": 1, "at_mm": [-2000, 2450, 0], "stand": "boarding" } },
      "geometry": { "bounds_mm": [5000, 5000, 3000] },
      "forms": {
        "board": { "who": "anyone", "starts": "act",
          "takes": { "seat": { "type": "slot",
            "select": { "of": "free_slots", "in": "this", "anchor": "me", "order": "nearest", "rank": 1 } } },
          "needs": [{ "need": "slot_free", "slot": { "arg": "seat" } }],
          "steps": [{ "step": "walk_to", "point": { "arg": "seat" } }, { "step": "sit", "slot": { "arg": "seat" } }],
          "effects": [{ "change": "reparent", "what": "actor", "into": { "arg": "seat" }, "event": "boarded" }] } },
      "ride": { "seats": ["g1", "g2", "g3", "g4"], "stops": ["boarding", "out"], "returns": false, "start": "board",
        "speed_mm_s": 1000, "ground": "level" } }"#,
    )
    .unwrap()
}
/// The wheel's four places as a served world registers them, and their runs, each step a stop of 40 s, the wheel's
/// clock set so that at the world's start it stands at the step where gondola 1 is at the top, out of reach, and two
/// others wait at the platform (world time is real time).
#[allow(clippy::disallowed_methods)]
fn wheel_places(ground: Id) -> Vec<(sim::slots::PlaceAt, sim::courses::rides::SeatRun)> {
    let at = wheel_at();
    let declared = [
        (1, Vec3::new(0, 450_000, 0)),
        (2, Vec3::new(2_000_000, 2_450_000, 0)),
        (3, Vec3::new(0, 4_450_000, 0)),
        (4, Vec3::new(-2_000_000, 2_450_000, 0)),
    ];
    let registered: BTreeMap<u64, sim::slots::PlaceAt> = declared
        .iter()
        .map(|(n, p)| {
            (
                *n,
                sim::slots::PlaceAt {
                    thing: wheel(),
                    place: replica::moves::Place {
                        slot: *n,
                        height: p.y,
                        stand: [-p.x, -1_000_000 - p.z],
                    },
                    point: p.plus(at).unwrap(),
                    facing: Quat::IDENTITY,
                    floor: ground,
                    more: Vec::new(),
                },
            )
        })
        .collect();
    let mut runs = sim::courses::rides::seat_runs(
        &wheel_entry(),
        &registered,
        &|p: Vec3| p.plus(at).ok(),
        &|_, _| Some(0),
        0,
    );
    assert_eq!(runs.len(), 4, "every gondola runs");
    for r in &mut runs {
        for s in &mut r.course.stations {
            s.dwell = 40_000_000;
        }
    }
    // Gondola 1's third stop (two steps round) is the top; start the clock 1 s into it.
    let table = runs[0].course.load().unwrap();
    let top = table
        .legs
        .iter()
        .filter(|l| l.stop.is_some())
        .nth(2)
        .unwrap()
        .start;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64;
    for r in &mut runs {
        r.course.t0 = now - top - 1_000_000;
        r.course.within = r.course.load().unwrap().period;
    }
    runs.into_iter()
        .map(|r| (registered[&r.slot].clone(), r))
        .collect()
}

/// N14 review: a Soul's `board` on a big wheel names no gondola. At a step where gondola 1 is up the wheel the world
/// picks one that waits at the platform (not the nearest stand point's first, gondola 1), walks the Soul there and
/// seats it: it is never sent to a gondola that is aloft.
#[test]
fn n14_a_wheel_is_boarded_at_a_gondola_that_waits_while_gondola_1_is_aloft_through_the_gateway() {
    let (run, mut a, _) = serve("n14w");
    let boarded = a.act("test:board", Some(wheel()), BTreeMap::new());
    println!("N14 wheel board: {boarded:?}");
    boarded.expect("boarded at a waiting gondola");
    let (parent, slot) = parent(&run.replay(), w1());
    assert_eq!(parent, Some(wheel()));
    println!("N14 wheel: in gondola {slot:?}");
    assert!(
        matches!(slot, Some(2..=4)),
        "not gondola 1, aloft: {slot:?}"
    );
    run.stop();
}

// --- A far approach planned off the clock -----------------------------------------------------------------------------

/// Vessel `k` of two past the ring from the walkers, 2 m apart: no straight walk reaches them, so a place to stand at
/// one is found by a route search.
fn far_vessel(k: u64) -> Id {
    id(14 + k)
}
fn past_the_ring(k: u64) -> Vec3 {
    Vec3::new(90_000_000, 0, k as i64 * 2_000_000 - 1_000_000)
}

/// Two Souls far off take at once, each its own vessel past the ring: each take's approach walk looks for a place to
/// stand by its vessel from where the Soul stands, a route search round the ring. It runs on the planner, never on
/// the clock (where a debug build panics the clock, and a release build counts it), and the form waits for it as a
/// walk does. Both takes land, each vessel in its Soul's hand.
#[test]
fn two_far_souls_take_at_once_and_their_approaches_are_planned_off_the_clock() {
    let on_clock = sim::commit::checks_on_clock();
    let mut changes = built();
    for k in 0..2 {
        changes.push(create(far_vessel(k), VESSEL, ground(), past_the_ring(k)));
    }
    let world = || world_of(zone_place(), changes.clone());
    let run = lockstep_on(world(), bodies);
    let takes: Vec<_> = [w1(), w2()]
        .into_iter()
        .zip(0..)
        .map(|(w, k)| {
            let (reply, rx) = std::sync::mpsc::channel();
            let bytes = intent_bytes(w, 1, "test:take", Some(far_vessel(k)), BTreeMap::new());
            run.world
                .events
                .send(answers::Event::ArrivalAt {
                    tick: 1,
                    bytes,
                    reply,
                })
                .unwrap();
            rx
        })
        .collect();
    let (done, ran) = std::sync::mpsc::channel();
    run.world
        .events
        .send(answers::Event::RunTo { tick: 4_000, done })
        .unwrap();
    ran.recv()
        .expect("the clock ran (a route search on it panics it in a debug build)");
    let r = run.replay_on(world());
    for ((rx, w), k) in takes.iter().zip([w1(), w2()]).zip(0..) {
        let ends: Vec<_> = rx
            .try_iter()
            .filter(|f| answers::progress_of(f).is_none())
            .map(|f| answer_in(&f))
            .collect();
        println!(
            "far take {k}: {ends:?}; body at {:?}, vessel parent {:?}",
            at(&r, w),
            parent(&r, far_vessel(k))
        );
        assert!(
            matches!(ends[..], [(1, Ok(_))]),
            "take {k} answered once, taken: {ends:?}"
        );
        assert_eq!(parent(&r, far_vessel(k)).0, Some(w), "in its Soul's hand");
    }
    assert_eq!(
        sim::commit::checks_on_clock(),
        on_clock,
        "no route search on the clock"
    );
    run.world.stop();
}
