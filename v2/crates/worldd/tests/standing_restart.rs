//! A body in a standing slot restarts standing (C33, #3598). A form hands a body into a standing slot (a phone box's
//! inside, a pool table's side, a balloon's basket) on its feet, held in the standing stance. The tick's record and a
//! checkpoint write that stance (`3`), and a restart (K18c, #3176) hands the body back into the same slot standing,
//! not sitting. A row written before #3598 (no stance) still reads back as a seat taken sitting.

use std::collections::BTreeMap;

use import_eden::Import;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Header, Refusal, fixture_bytes, schema_hash};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::moves::Place;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use sim::controller::Stance;
use sim::links::Doors;
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use worldd::bodies::{Bodies, Placed, read_row, row};

const SLOT: &str = include_str!("../../replica/fixtures/seats/chair.diag");
const TICK: i64 = 50_000;

fn start() -> Vec3 {
    Vec3::new(-40_000_000, 0, 30_000_000)
}

fn id(n: u64) -> Id {
    Id::new(Scope([0x3d; 16]), n).unwrap()
}

fn body() -> Id {
    id(1)
}

fn thing() -> Id {
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

fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/standing-restart/1").to_bytes()),
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

/// A world as a start builds it (K18c): the body added, the slot's place added, and the body handed back into the slot
/// when `placed` had it there.
fn world(placed: &Placed, at: i64) -> Result<Bodies, Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let first = town.surfaces[&ground].place(body(), frame, start(), Quat::IDENTITY)?;
    let mut b = Bodies::new(town, TICK)?;
    b.add_body_at(humanoid(), first, placed)?;
    let place = Place::from_value(&decode(&fixture_bytes(SLOT)?).unwrap().value)?;
    b.add_place(PlaceAt {
        thing: thing(),
        place,
        point: Vec3::new(-38_000_000, 450_000, 30_000_000),
        facing: Quat::IDENTITY,
        floor: ground,
    })?;
    let refused = b.seat_placed(placed, at);
    assert!(refused.is_empty(), "handed back into the slot: {refused:?}");
    b.begin(at);
    Ok(b)
}

fn in_slot(stance: Option<Stance>) -> Placed {
    Placed::from([(
        body(),
        (
            Pose {
                frame: Frame {
                    node: thing(),
                    slot: None,
                },
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::Slot,
            },
            stance,
        ),
    )])
}

#[test]
fn c33_a_body_in_a_standing_slot_restarts_standing() {
    let mut b = world(&in_slot(Some(Stance::Stand)), 0).expect("the world");
    b.step(4 * TICK);
    assert_eq!(b.slots.held_by(body()), Some(thing()), "in the slot");
    assert_eq!(
        b.slots.stance(body()),
        Some(Stance::Stand),
        "standing in it"
    );

    // What a checkpoint and the tick's record keep of it, written and read back as the log holds it.
    let placed = b.placed();
    let (pose, stance) = placed.get(&body()).copied().expect("carried");
    assert_eq!(stance, Some(Stance::Stand));
    let written = row(body(), &pose, stance);
    println!("row: {written:?}");
    let (back, pose_back, stance_back) = read_row(&written).expect("reads back");
    assert_eq!(
        (back, pose_back, stance_back),
        (body(), pose, Some(Stance::Stand))
    );

    // The restart from that row hands the body back into the same slot, standing, not seated.
    let reread = Placed::from([(back, (pose_back, stance_back))]);
    let mut r = world(&reread, 8 * TICK).expect("the restarted world");
    r.step(12 * TICK);
    assert_eq!(
        r.slots.held_by(body()),
        Some(thing()),
        "the slot held again"
    );
    assert_eq!(
        r.slots.stance(body()),
        Some(Stance::Stand),
        "standing after the restart"
    );
    assert_eq!(
        r.runner.controller.input(body()).expect("the body").stance,
        Stance::Stand,
        "the controller holds it standing"
    );
}

#[test]
fn c33_a_row_written_before_standing_slots_still_restarts_seated() {
    // A row with no stance (a seat's row before #3598 carried 1 or 2; a pose in a slot with none) reads as no stance,
    // which a restart takes as a sit, as before.
    let b = world(&in_slot(Some(Stance::Stand)), 0).expect("the world");
    let pose = b.placed()[&body()].0;
    let old = Value::Array(vec![body().to_value(), pose.to_value()]);
    let (_, pose_back, stance) = read_row(&old).expect("an old row reads back");
    assert_eq!(stance, None);
    let r = world(&Placed::from([(body(), (pose_back, None))]), 0).expect("the world");
    assert_eq!(r.slots.stance(body()), Some(Stance::Sit));
}
