//! N2's test world with one Soul and three chairs, for `worldd gateway-link --testworld` (B10, #2688): the world a
//! keyboard client (`v2/tools/keys`) drives a body in. The same layout as I4b's test (`tests/moves.rs`): the body
//! stands on the open ground west of the square; the chairs face +z, each stand point 300 mm in front of its seat.

use std::collections::BTreeMap;

use import_eden::Import;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Refusal, fixture_bytes, schema_hash};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::moves::Seat;
use replica::pose::{Frame, Quat, Vec3};
use sim::links::Doors;
use sim::slots::SeatAt;
use sim::walk::town::Town;

use crate::bodies::Bodies;

const CHAIR: &str = include_str!("../../replica/fixtures/seats/chair.diag");

/// The Soul's body, also its actor's id.
pub fn body() -> Id {
    id(9_001)
}

/// Where the body starts, µm on the ground.
pub fn start() -> Vec3 {
    Vec3::new(-40_000_000, 0, 30_000_000)
}

/// The chairs: name, thing, seat point (µm on the ground).
pub fn chairs() -> Vec<(&'static str, Id, Vec3)> {
    vec![
        (
            "the west chair",
            id(9_002),
            Vec3::new(-36_000_000, 450_000, 30_000_000),
        ),
        (
            "the chair at the square's west edge",
            id(9_003),
            Vec3::new(-26_000_000, 450_000, 20_000_000),
        ),
        (
            "the chair in the square",
            id(9_004),
            Vec3::new(-10_000_000, 450_000, 10_000_000),
        ),
    ]
}

fn id(counter: u64) -> Id {
    Id::new(Scope([7; 16]), counter).unwrap_or_else(|| unreachable!("a small counter"))
}

fn humanoid() -> Family {
    let leg = |n: &str| Resource {
        name: Name::new(n).unwrap_or_else(|| unreachable!("a fixed name")),
        class: Class::Locomotion,
        slot: None,
    };
    Family {
        name: Name::new("souls:humanoid").unwrap_or_else(|| unreachable!("a fixed name")),
        resources: vec![leg("souls:leg-left"), leg("souls:leg-right")],
    }
}

fn refusal(name: &'static str, e: impl ToString) -> Refusal {
    Refusal {
        name,
        detail: e.to_string(),
    }
}

/// N2's test world (seed 1) as a town, and its ground.
pub fn town() -> Result<(Town, Id), Refusal> {
    let w = testworld::generate(1, 0).map_err(|e| refusal("testworld", e))?;
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).map_err(|e| refusal("testworld", e))?;
    let (root, ground) = (nodes["world"], nodes["ground"]);
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/b10-keys/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = replica::effects::Header::read(&encode(&v).map_err(|e| refusal("encoding", e))?)?;
    let next = tree.to_state().next;
    let town = Town::new(tree, ground, Doors::new(header, rules, next))
        .map_err(|e| refusal("testworld", e))?;
    Ok((town, ground))
}

/// The world's bodies: the Soul at [`start`] and the [`chairs`].
pub fn bodies() -> Result<Bodies, Refusal> {
    let (town, ground) = town()?;
    let at = town.surfaces[&ground].place(
        body(),
        Frame {
            node: ground,
            slot: None,
        },
        start(),
        Quat::IDENTITY,
    )?;
    let mut b = Bodies::new(town, 50_000)?;
    b.add_body(humanoid(), at)?;
    let chair = decode(&fixture_bytes(CHAIR)?).map_err(|e| refusal("seat-unread", e))?;
    let seat = Seat::from_value(&chair.value)?;
    for (_, thing, point) in chairs() {
        b.add_seat(SeatAt {
            thing,
            seat: seat.clone(),
            point,
            facing: Quat::IDENTITY,
            floor: ground,
        })?;
    }
    Ok(b)
}
