//! What the walk tests share (T9c #3127): N2's test world as a town, a humanoid body, and a walker run through the
//! host: its legs planned by the town, N7's walk (`skills::route`) as its skill.

#![allow(dead_code)]

use import_eden::Import;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Header, Refusal, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::time::Micros;
use sim::host::Runner;
use sim::links::Doors;
use sim::mover::Body;
use sim::walk::town::Town;
use sim::walk::{Leg, World};
use skills::route::Route;
use std::collections::BTreeMap;

pub fn id(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

/// The test world as a town, with a door writer whose header names `fixture`, and its named nodes.
pub fn town(fixture: &[u8]) -> (Town, BTreeMap<String, Id>) {
    let w = testworld::generate(1, 0).expect("the test world");
    town_of(
        import_eden::load(&w.text).expect("the test world loads"),
        fixture,
    )
}

/// A loaded world as a town, with a door writer whose header names `fixture`, and its named nodes.
pub fn town_of(im: Import, fixture: &[u8]) -> (Town, BTreeMap<String, Id>) {
    let Import {
        tree, rules, nodes, ..
    } = im;
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, fixture).to_bytes()),
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

pub fn stand(t: &Town, who: Id, node: Id, at: Vec3) -> Body {
    t.surfaces[&node]
        .place(who, Frame { node, slot: None }, at, Quat::IDENTITY)
        .unwrap_or_else(|e| panic!("{}: {}", e.name, e.detail))
}

pub fn humanoid() -> Family {
    let r = |n: &str, class| Resource {
        name: Name::new(n).unwrap(),
        class,
        slot: None,
    };
    Family {
        name: Name::new("souls:humanoid").unwrap(),
        resources: vec![
            r("souls:leg-left", Class::Locomotion),
            r("souls:leg-right", Class::Locomotion),
        ],
    }
}

/// N7's walk for `legs`, at `speed`.
pub fn route(legs: &[Leg], speed: i64, tick: Micros) -> Box<Route> {
    let legs = legs
        .iter()
        .map(|l| skills::route::Leg {
            to: l.to,
            link: l.link,
        })
        .collect();
    Box::new(Route::new(legs, speed, tick))
}

/// A walker: `body` (new to the runner, or already in it) walks at `speed` to `goal` on `node`, its legs planned by
/// the town. Returns the legs.
pub fn walk(
    r: &mut Runner,
    t: &mut Town,
    body: Body,
    speed: i64,
    node: Id,
    goal: Vec3,
) -> Result<Vec<Leg>, Refusal> {
    let legs = t.plan(&body, node, goal)?;
    let skill = route(&legs, speed, r.tick);
    if r.controller.body(body.id).is_some() {
        r.start(body.id, skill)?;
    } else {
        r.add(humanoid(), body, skill)?;
    }
    Ok(legs)
}

/// The straight distance between two points, µm (rounded down).
pub fn dist(a: Vec3, b: Vec3) -> i64 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    (d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt() as i64
}

/// When `who`'s walk arrived (the tick's start), if it did.
pub fn arrived(r: &Runner, who: Id) -> Option<Micros> {
    match r.ended.get(&who) {
        Some((at, replica::host::Progress::Done)) => Some(*at),
        _ => None,
    }
}
