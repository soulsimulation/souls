//! A checkpoint taken while a Soul rises from a seat keeps it. A rising body is still in the seat's slot, which the
//! controller keeps apart from the bodies it steps, and the slots table no longer counts it seated; the list a
//! checkpoint saves ([`Bodies::placed`]) must still carry it, so a restart (K18c, #3176) finds it where it was
//! instead of losing it or standing it back where the mover first placed it.

use std::collections::BTreeMap;

use import_eden::Import;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Actor, Header, Refusal, fixture_bytes, schema_hash};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::moves::Place;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use sim::controller::Stance;
use sim::links::Doors;
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use worldd::bodies::{Ask, Asked, Bodies, Placed};

const CHAIR: &str = include_str!("../../replica/fixtures/seats/chair.diag");
const TICK: i64 = 50_000;
/// Where the mover first places the body: 2 m west of the chair.
fn start() -> Vec3 {
    Vec3::new(-40_000_000, 0, 30_000_000)
}

/// The chair's slot.
fn seat() -> Vec3 {
    Vec3::new(-38_000_000, 450_000, 30_000_000)
}

fn id(n: u64) -> Id {
    Id::new(Scope([0x3c; 16]), n).unwrap()
}

fn body() -> Id {
    id(1)
}

fn chair() -> Id {
    id(2)
}

fn humanoid() -> Family {
    let r = |n: &str| Resource {
        name: Name::new(n).unwrap(),
        class: Class::Locomotion,
        slot: None,
    };
    Family {
        name: Name::new("souls:humanoid").unwrap(),
        resources: vec![r("souls:leg-left"), r("souls:leg-right")],
    }
}

/// N2's test world as a town, and its ground.
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/ckpt-rising/1").to_bytes()),
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
    let town = Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town");
    (town, ground)
}

/// A world as a start builds it (K18c): the body added where `placed` last had it (else at [`start`]), the chair
/// added, and the body seated again when `placed` had it in the chair's slot.
fn world(placed: &Placed, at: i64) -> Result<Bodies, Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let first = town.surfaces[&ground].place(body(), frame, start(), Quat::IDENTITY)?;
    let mut b = Bodies::new(town, TICK)?;
    b.add_body_at(humanoid(), first, placed)?;
    let place = Place::from_value(&decode(&fixture_bytes(CHAIR)?).unwrap().value)?;
    b.add_place(PlaceAt {
        thing: chair(),
        place,
        point: seat(),
        facing: Quat::IDENTITY,
        floor: ground,
    })?;
    let refused = b.seat_placed(placed, at);
    assert!(refused.is_empty(), "seated again: {refused:?}");
    b.begin(at);
    Ok(b)
}

fn in_chair(b: &Bodies) -> bool {
    let p = b.runner.controller.body(body()).expect("the body").pose;
    p.support == Support::Slot && p.frame.node == chair()
}

fn rise(b: &mut Bodies, n: u64) -> Result<(), Refusal> {
    let asked = Asked {
        body: body(),
        actor: Actor::Soul(body()),
        ask: Ask::Rise,
    };
    b.start(vec![(id(100 + n), asked)]).remove(0).1
}

#[test]
fn a_checkpoint_taken_while_a_soul_rises_keeps_it_in_its_seat() {
    // Seated in the chair, as a restart seats a body the log had there.
    let seated = Placed::from([(
        body(),
        (
            Pose {
                frame: Frame {
                    node: chair(),
                    slot: None,
                },
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::Slot,
            },
            Some(Stance::Sit),
        ),
    )]);
    let mut b = world(&seated, 0).expect("the world");
    b.step(4 * TICK);
    assert!(in_chair(&b), "seated before the rise");

    // The rise starts; a tick later the body is still in the slot, no longer counted seated.
    rise(&mut b, 1).expect("the rise starts");
    let now = 5 * TICK;
    b.step(now);
    assert!(in_chair(&b), "still in the slot, rising");
    assert!(b.slots.seated().is_empty(), "a rising body is not seated");

    // The checkpoint, taken now, carries the rising body.
    let placed = b.placed();
    println!("checkpoint while rising: {placed:?}");
    let (pose, stance) = placed
        .get(&body())
        .copied()
        .expect("the checkpoint carries the rising body");
    assert_eq!(pose.support, Support::Slot, "in the chair's slot");
    assert_eq!(stance, Some(Stance::Sit), "with the stance it rises from");

    // A restart from it finds the body in the chair, not back where the mover first placed it, and its seat held:
    // a rise asked again lands, the body standing at the chair's stand point.
    let mut r = world(&placed, now).expect("the restarted world");
    assert!(in_chair(&r), "the restart finds the body in the chair");
    assert_eq!(r.slots.held_by(body()), Some(chair()), "its seat held");
    rise(&mut r, 2).expect("a rise asked again starts");
    let ended = r.step(now + 100 * TICK);
    assert_eq!(ended, vec![(id(102), Ok(()))], "the rise lands");
    let stood = r.runner.controller.body(body()).expect("the body").pose;
    println!("after the restart and a rise: {stood:?}");
    assert!(matches!(stood.support, Support::Surface { .. }), "stood up");
    assert!(
        (stood.position.x - seat().x).abs() < 1_000_000,
        "standing beside the chair, not at the start: {:?}",
        stood.position
    );
}
