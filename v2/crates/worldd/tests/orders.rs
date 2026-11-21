//! B7c: the failed B7b dining-row geometry, unchanged Standard clearance and the real Town/planner/controller.
//! The seven facts are exact from Eden facts SHA256 2f4f0221a3eacfd12241c0c7fece35311ffca417ade14faf87f8f67d6329e182.
use std::collections::BTreeMap;

use import_eden::json::{self, Json};
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Actor, Header, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::intents::{Intent, Target};
use replica::moves::Place;
use replica::pose::{ControllerInput, Frame, Mode, Quat, Support, Vec3};
use sim::controller::Controller;
use sim::links::Doors;
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use worldd::bodies::{Ask, Asked, Bodies};

const TICK: i64 = 50_000;
fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}
fn id(n: u64) -> Id {
    Id::new(Scope([0x93; 16]), n).unwrap()
}
fn family() -> Family {
    Family {
        name: name("souls:humanoid"),
        resources: ["souls:leg-left", "souls:leg-right"]
            .into_iter()
            .map(|s| Resource {
                name: name(s),
                class: Class::Locomotion,
                slot: None,
            })
            .collect(),
    }
}
fn town() -> (Town, Id, Id) {
    let generated = testworld::generate(1, 0).unwrap();
    let mut facts = json::parse(&generated.text).unwrap();
    let row = json::parse(include_str!("fixtures/queue-chairs.json")).unwrap();
    let Json::Obj(fields) = &mut facts else {
        panic!("facts object")
    };
    for key in ["kinds", "things"] {
        let Json::Arr(values) = &mut fields.iter_mut().find(|(k, _)| k == key).unwrap().1 else {
            panic!("facts array")
        };
        values.extend_from_slice(row.get(key).unwrap().arr());
    }
    let mut text = String::new();
    testworld::write(&facts, &mut text);
    let im = import_eden::load(&text).unwrap();
    let (root, ground, chair) = (
        im.nodes["world"],
        im.nodes["ground"],
        im.nodes["e_3403bec8"],
    );
    let header = Header::read(
        &encode(&Value::Map(BTreeMap::from([
            (
                1,
                Value::Bytes(Hash::of(Purpose::Fixture, b"souls/b7c/1").to_bytes()),
            ),
            (2, Value::Bytes(schema_hash().to_bytes())),
            (3, Value::Bytes(root.scope().0.to_vec())),
            (4, root.to_value()),
            (5, Value::Uint(0)),
            (6, Value::Array(vec![])),
            (7, Value::Array(vec![])),
        ])))
        .unwrap(),
    )
    .unwrap();
    let next = im.tree.to_state().next;
    (
        Town::new(im.tree, ground, Doors::new(header, im.rules, next)).unwrap(),
        ground,
        chair,
    )
}
fn queue(body: Id, chair: Id) -> Intent {
    Intent {
        actor: Actor::Soul(body),
        verb: name("souls:queue"),
        target: Some(Target::Node(chair)),
        parameters: BTreeMap::from([(1, Value::Text(name("eden:sit")))]),
        sequence: 1,
        basis: Value::Array(vec![
            Value::Bytes(vec![0; 16]),
            body.to_value(),
            Value::Uint(0),
            Value::Uint(0),
        ]),
        expiry: 180_000_000,
        resources: vec![],
        fallbacks: vec![],
        replaces: None,
        body: Some(body),
    }
}
fn ask(b: &mut Bodies, who: Id, n: u64, ask: Ask) {
    let result = b.start(vec![(
        id(n),
        Asked {
            body: who,
            actor: Actor::Soul(who),
            ask,
            fallbacks: vec![],
        },
    )]);
    assert!(result.iter().all(|(_, r)| r.is_ok()), "{result:?}");
}
fn tick(b: &mut Bodies, now: &mut i64) {
    *now += TICK;
    // As the served loop does: each tick's asks (here none) are started, committing sits and rises whose reach is back.
    let started = b.start(Vec::new());
    assert!(started.iter().all(|(_, r)| r.is_ok()), "{started:?}");
    let _ = b.step(*now);
}
fn takes(b: &Bodies) -> Vec<Id> {
    b.orders
        .log
        .iter()
        .filter(|e| {
            e.events
                .iter()
                .flatten()
                .any(|v| v.name.as_str() == sim::orders::TAKE)
        })
        .map(|e| e.envelope.node)
        .collect()
}

/// A1, the head: the direct approach is blocked by the rear chairs' unchanged clearance; the head reaches the stand
/// by the supported route, takes slot 1 exactly once, and the other two stay queued behind it in arrival order.
#[test]
fn b7c_obstructed_head_takes_by_supported_route() {
    obstructed_queue(1);
}

/// A1, FIFO as predecessors rise: each head rises from the chair (its stand point lies just inside the collider's
/// Standard clearance, so the rise lands on the nearest supported point) and the next in line takes the seat.
#[test]
fn b7c_obstructed_chairs_supported_route_fifo() {
    obstructed_queue(3);
}

fn obstructed_queue(heads: usize) {
    let (town, ground, chair) = town();
    let starts = [
        Vec3::new(22_900_000, 0, 8_000_000),
        Vec3::new(24_000_000, 0, 8_000_000),
        Vec3::new(25_100_000, 0, 8_000_000),
    ];
    let moved: Vec<_> = starts
        .into_iter()
        .enumerate()
        .map(|(i, p)| {
            town.surfaces[&ground]
                .place(
                    id(i as u64 + 1),
                    Frame {
                        node: ground,
                        slot: None,
                    },
                    p,
                    Quat::IDENTITY,
                )
                .unwrap()
        })
        .collect();
    // Actual entry: seat [0,470,20] mm; front stand [0,0,509] mm. Neither clearance nor reach changes.
    let stand = Vec3::new(21_900_000, 0, 5_109_000);
    let from = moved[0];
    let straight = Controller::probe(
        &town.surfaces[&ground],
        &from,
        ControllerInput {
            velocity: Vec3::new(
                stand.x - from.pose.position.x,
                0,
                stand.z - from.pose.position.z,
            ),
            mode: Mode::Surface,
        },
        1_000_000,
        0,
    )
    .unwrap();
    assert!(
        (straight.pose.position.x - stand.x).abs() + (straight.pose.position.z - stand.z).abs()
            > sim::orders::ARRIVED,
        "the original direct approach must be blocked"
    );
    let mut b = Bodies::new(town, TICK).unwrap();
    for body in moved {
        b.add_body(family(), body).unwrap();
    }
    b.add_place(PlaceAt {
        thing: chair,
        place: Place {
            slot: 1,
            height: 470_000,
            stand: [0, 489_000],
        },
        point: Vec3::new(21_900_000, 470_000, 4_620_000),
        facing: Quat::IDENTITY,
        floor: ground,
    })
    .unwrap();
    let mut now = 0;
    for who in [id(1), id(2), id(3)] {
        worldd::orders::accept(
            &mut b,
            &queue(who, chair),
            who,
            id(100 + who.counter()),
            now,
        )
        .unwrap();
    }
    for (i, who) in [id(1), id(2), id(3)].into_iter().take(heads).enumerate() {
        let end = now + 25_000_000;
        while now < end
            && !(b.slots.holder_in(chair, 1) == Some(who)
                && b.runner.controller.body(who).unwrap().pose.support == Support::Slot)
        {
            tick(&mut b, &mut now);
        }
        assert_eq!(b.slots.holder_in(chair, 1), Some(who), "FIFO head {i}");
        assert_eq!(
            b.runner.controller.body(who).unwrap().pose.support,
            Support::Slot
        );
        assert_eq!(takes(&b), [id(1), id(2), id(3)][..=i]);
        for _ in 0..20 {
            tick(&mut b, &mut now);
        }
        assert_eq!(takes(&b).len(), i + 1, "one take per head");
        if i + 1 < heads {
            ask(&mut b, who, 200 + i as u64, Ask::Rise);
            let end = now + 10_000_000;
            while now < end && b.runner.controller.body(who).unwrap().pose.support == Support::Slot
            {
                tick(&mut b, &mut now);
            }
            assert_ne!(
                b.runner.controller.body(who).unwrap().pose.support,
                Support::Slot,
                "rose {i}"
            );
            for _ in 0..40 {
                tick(&mut b, &mut now);
            }
            ask(
                &mut b,
                who,
                210 + i as u64,
                Ask::Walk {
                    node: ground,
                    point: Some(Vec3::new(18_000_000 - i as i64 * 1_500_000, 0, 7_000_000)),
                },
            );
        }
    }
    if heads == 1 {
        for _ in 0..40 {
            tick(&mut b, &mut now);
        }
        assert_eq!(takes(&b), [id(1)]);
        assert!(b.orders.open(id(2)).is_some() && b.orders.open(id(3)).is_some());
        assert!(b.orders.spot(id(2)).is_some() && b.orders.spot(id(3)).is_some());
    }
}
