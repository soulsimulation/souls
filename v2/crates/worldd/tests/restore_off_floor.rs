//! A restart never leaves a body standing off its floor (the hello-hamlet freeze, #4669): a body the log had standing
//! where its floor holds no point (killed mid-crossing, a log from before the write rule, ground an edit changed) is
//! restored onto the nearest legal point of that floor by the walk-out's rule, and its next walk moves it. The case
//! the coordinator named: beside a seat that moves with its cabin while the cabin is away from its own stop (N14), the
//! shape of #4673's `a_restart_beside_an_away_cabin_holds_the_body_out_of_it`.

use std::collections::BTreeMap;

use import_eden::Import;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Actor, Header, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::moves::Place;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use sim::links::Doors;
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use worldd::bodies::{Ask, Asked, Bodies, Placed};

const TICK: i64 = 50_000;
const S: i64 = 1_000_000;

fn id(n: u64) -> Id {
    Id::new(Scope([0x3e; 16]), n).unwrap()
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
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/restore-off-floor/1").to_bytes()),
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

fn on(town: &Town, ground: Id, p: Vec3) -> bool {
    let frame = Frame {
        node: ground,
        slot: None,
    };
    town.surfaces[&ground]
        .place(id(99), frame, p, Quat::IDENTITY)
        .is_ok()
}

#[test]
fn a_restart_beside_an_away_cabin_restores_the_body_and_its_next_walk_moves_it() {
    use sim::courses::{Course, Shape, Station};
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let clear = |p: Vec3| {
        (-3..=3).all(|i| {
            (-3..=3).all(|j| {
                !on(
                    &town,
                    ground,
                    Vec3::new(p.x + i * 200_000, 0, p.z + j * 200_000),
                )
            })
        })
    };
    let grid = || {
        (0..400).flat_map(|i| {
            (0..400).map(move |j| Vec3::new(-40_000_000 + i * 200_000, 0, j * 200_000))
        })
    };
    let off = grid()
        .find(|&p| clear(p))
        .expect("a point with no ground within 0.6 m");
    let start = grid().find(|&p| on(&town, ground, p)).expect("ground");
    let body = id(1);
    let logged = Pose {
        frame,
        position: off,
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: ground,
            height: 0,
        },
    };
    let placed = Placed::from([(body, (logged, None))]);
    let first = town.surfaces[&ground]
        .place(body, frame, start, Quat::IDENTITY)
        .unwrap();
    let mut b = Bodies::new(town, TICK).expect("the bodies");
    let cabin = id(50);
    let seat = PlaceAt {
        thing: cabin,
        place: Place {
            slot: 1,
            height: 450_000,
            stand: [0, 300_000],
        },
        point: Vec3::new(off.x, 450_000, off.z),
        facing: Quat::IDENTITY,
        floor: ground,
        more: Vec::new(),
    };
    b.add_place(seat.clone()).expect("its seat");
    // Its cabin runs there and back between its own stop and one 3 m on, 10 s at each, at 1 m/s: 11 s in, it is
    // between the two, away from its own stop.
    let far = Vec3::new(off.x, 450_000, off.z + 3_000_000);
    let course = Course {
        stations: vec![
            Station {
                at: seat.point,
                dwell: 10 * S,
            },
            Station {
                at: far,
                dwell: 10 * S,
            },
        ],
        shape: Shape::ThereAndBack,
        speed: S,
        t0: 0,
        within: 30 * S,
    };
    let there = PlaceAt {
        point: far,
        ..seat.clone()
    };
    b.slots
        .run(
            cabin,
            1,
            &course,
            vec![(0, seat), (1, there)],
            &std::collections::BTreeSet::from([0]),
        )
        .expect("its run");
    let mut now = 11 * S;
    assert!(!b.slots.at_own_stop(cabin, 1, now), "the cabin is away");
    b.begin(now);
    b.add_body_at(humanoid(), first, &placed)
        .expect("a body logged off its floor starts");
    let p = b.runner.controller.body(body).unwrap().pose;
    assert_eq!(b.slots.held_by(body), None, "not in the away cabin: {p:?}");
    assert!(
        matches!(p.support, Support::Surface { surface, .. } if surface == ground),
        "on its own floor: {p:?}"
    );
    assert!(
        on(&b.town, ground, p.position),
        "on a point its floor holds: {p:?}"
    );
    let gap = i128::from(p.position.x - off.x).pow(2) + i128::from(p.position.z - off.z).pow(2);
    assert!(gap.isqrt() < 5_000_000, "restored nearby: {p:?}");
    assert!(!b.runner.controller.carried(body), "never carried off");
    // Its row is written again in the first record, so the log heals.
    assert!(
        b.moved()
            .iter()
            .any(|(i, q, _)| *i == body && q.position == p.position)
    );
    // Its next walk, to open ground nearby, moves it and is done.
    let open = |q: Vec3| {
        (-2..=2).all(|i| {
            (-2..=2).all(|j| {
                on(
                    &b.town,
                    ground,
                    Vec3::new(q.x + i * 500_000, 0, q.z + j * 500_000),
                )
            })
        })
    };
    let mut near: Vec<Vec3> = (-50..=50)
        .flat_map(|i| {
            (-50..=50).map(move |j| Vec3::new(off.x + i * 400_000, 0, off.z + j * 400_000))
        })
        .collect();
    near.sort_by_key(|q| ((q.x - off.x).pow(2) + (q.z - off.z).pow(2), q.x, q.z));
    let to = near
        .into_iter()
        .find(|&q| open(q))
        .expect("open ground within 20 m");
    let walk = Asked {
        body,
        actor: Actor::Soul(body),
        ask: Ask::Walk {
            node: ground,
            point: Some(to),
            gait: None,
        },
        fallbacks: Vec::new(),
    };
    let started = b.start(vec![(id(100), walk)]);
    assert!(started.iter().all(|(_, r)| r.is_ok()), "{started:?}");
    let mut done = None;
    let until = now + 60 * S;
    while now < until && done.is_none() {
        now += TICK;
        if let Some((_, r)) = b.step(now).into_iter().find(|(i, _)| *i == id(100)) {
            done = Some(r);
        }
        assert_eq!(b.slots.held_by(body), None, "never seated in the cabin");
    }
    println!("the walk after the restart: {done:?}");
    assert_eq!(done, Some(Ok(())), "the walk is done");
    let q = b.runner.controller.body(body).unwrap().pose.position;
    assert_ne!(
        (q.x, q.z),
        (p.position.x, p.position.z),
        "the walk moved it"
    );
}
