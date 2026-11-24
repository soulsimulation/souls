//! E11d review: a world killed while a Soul climbs out of a seat restarts, and every body moves after. During a climb
//! out the body's pose is a floor pose off the floor (the seat's point, over water or its thing's own box); a
//! checkpoint keeps it so. A restart once refused that pose (`off-surface`), so no body started and every move was
//! refused: a frozen world. It now places the body where it was and lets it climb on by the climb's own rule (over
//! water or its own thing's boxes, never another cut); with no clean way it is left there, and the others start.

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
    Id::new(Scope([0x3d; 16]), n).unwrap()
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
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/climb-restart/1").to_bytes()),
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

/// Killed over its own thing: it climbs on to the ground and both bodies walk.
#[test]
fn a_restart_mid_climb_out_starts_every_body_and_each_moves() {
    restart(true);
}

/// Killed inside a cut that is not its own thing's (no clean way out): it is left where the log had it, never carried
/// through the cut, and the other body starts and walks.
#[test]
fn a_restart_inside_another_cut_leaves_the_body_and_the_others_move() {
    restart(false);
}

fn restart(own: bool) {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    // A point off the open ground with ground 1 m east of it (a solid's or a building's cut), as a body mid-climb stands.
    let off = (0..400)
        .flat_map(|i| (0..400).map(move |j| Vec3::new(-40_000_000 + i * 200_000, 0, j * 200_000)))
        .find(|&p| !on(&town, ground, p) && on(&town, ground, Vec3::new(p.x + 1_000_000, 0, p.z)))
        .expect("a point off the ground beside it");
    let near = Vec3::new(off.x + 1_000_000, 0, off.z);
    let (climber, other) = (id(1), id(2));
    let placed = Placed::from([(
        climber,
        (
            Pose {
                frame,
                position: off,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: ground,
                    height: 0,
                },
            },
            None,
        ),
    )]);
    let first = |b| town.surfaces[&ground].place(b, frame, near, Quat::IDENTITY);
    let (c0, o0) = (first(climber).unwrap(), first(other).unwrap());
    let mut b = Bodies::new(town, TICK).expect("the bodies");
    if own {
        // The body is over its seat's thing: a box from just west of it to the ground 1 m east.
        let thing = id(50);
        let place = Place {
            slot: 1,
            height: 450_000,
            stand: [0, 300_000],
        };
        b.add_place(PlaceAt {
            thing,
            place,
            point: Vec3::new(off.x, 450_000, off.z),
            facing: Quat::IDENTITY,
            floor: ground,
        })
        .expect("its seat");
        let (x0, x1, z0, z1) = (off.x - 300_000, near.x, off.z - 300_000, off.z + 300_000);
        b.slots
            .footprint(thing, vec![[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]]);
    }
    b.add_body_at(humanoid(), c0, &placed)
        .expect("a body off its floor starts");
    b.add_body_at(humanoid(), o0, &placed)
        .expect("the other starts");
    b.begin(0);
    let p = b.runner.controller.body(climber).unwrap().pose.position;
    assert_eq!(
        (p.x, p.z),
        (off.x, off.z),
        "placed where the log had it, not moved"
    );
    if !own {
        assert!(
            !b.runner.controller.carried(climber),
            "never carried through the cut"
        );
    } else {
        assert!(
            b.runner.controller.carried(climber),
            "carried on to the floor"
        );
    }
    // It lands, never further in a tick than walking speed, and then both bodies walk.
    let mut now = 0;
    let mut last = p;
    while b.runner.controller.carried(climber) {
        now += TICK;
        assert!(now < 10 * S, "landed within 10 s");
        b.step(now);
        let q = b.runner.controller.body(climber).unwrap().pose.position;
        let d = ((q.x - last.x).pow(2) + (q.z - last.z).pow(2)).isqrt();
        assert!(
            d <= sim::gaits::WALK.speed * TICK / S + 1,
            "{d} µm in a tick"
        );
        last = q;
    }
    let landed = b.runner.controller.body(climber).unwrap().pose;
    assert!(matches!(landed.support, Support::Surface { .. }));
    assert_eq!(
        on_after(&b, ground, landed.position),
        own,
        "on the ground when it climbed, where the log had it when not: {landed:?}"
    );
    let walkers: &[(u64, Id)] = if own {
        &[(1, climber), (2, other)]
    } else {
        &[(2, other)]
    };
    for &(n, body) in walkers {
        let from = b.runner.controller.body(body).unwrap().pose.position;
        let walk = Asked {
            body,
            actor: Actor::Soul(body),
            ask: Ask::Walk {
                node: ground,
                point: Some(Vec3::new(from.x + 1_000_000, 0, from.z)),
                gait: None,
            },
            fallbacks: Vec::new(),
        };
        let started = b.start(vec![(id(100 + n), walk)]);
        assert!(started.iter().all(|(_, r)| r.is_ok()), "{started:?}");
        let mut done = None;
        let start = now;
        while done.is_none() && now < start + 30 * S {
            now += TICK;
            done = b
                .step(now)
                .into_iter()
                .find(|(i, _)| *i == id(100 + n))
                .map(|(_, r)| r);
        }
        let to = b.runner.controller.body(body).unwrap().pose.position;
        println!("body {n}: {from:?} -> {to:?}: {done:?}");
        assert!(to != from, "body {n} moves after the restart: {done:?}");
    }
}

fn on_after(b: &Bodies, ground: Id, p: Vec3) -> bool {
    let frame = Frame {
        node: ground,
        slot: None,
    };
    b.town.surfaces[&ground]
        .place(id(99), frame, p, Quat::IDENTITY)
        .is_ok()
}

/// E11d: a body killed during a climb out, still over the seat's thing with no clean way on (no ground within 0.6 m
/// of it, no water, its thing's box only round its seat) is seated again in that seat, not left standing off the
/// floor where nothing moves it. Its next rise climbs out or is refused by name, and it is seated still if refused.
#[test]
fn a_restart_with_no_clean_way_on_seats_the_body_again_and_it_rises_by_name() {
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
    let off = (0..400)
        .flat_map(|i| (0..400).map(move |j| Vec3::new(-40_000_000 + i * 200_000, 0, j * 200_000)))
        .find(|&p| clear(p))
        .expect("a point with no ground within 0.6 m");
    let start = (0..400)
        .flat_map(|i| (0..400).map(move |j| Vec3::new(-40_000_000 + i * 200_000, 0, j * 200_000)))
        .find(|&p| on(&town, ground, p))
        .expect("ground");
    let body = id(1);
    let placed = Placed::from([(
        body,
        (
            Pose {
                frame,
                position: off,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: ground,
                    height: 0,
                },
            },
            None,
        ),
    )]);
    let first = town.surfaces[&ground]
        .place(body, frame, start, Quat::IDENTITY)
        .unwrap();
    let mut b = Bodies::new(town, TICK).expect("the bodies");
    let thing = id(50);
    b.add_place(PlaceAt {
        thing,
        place: Place {
            slot: 1,
            height: 450_000,
            stand: [0, 300_000],
        },
        point: Vec3::new(off.x, 450_000, off.z),
        facing: Quat::IDENTITY,
        floor: ground,
    })
    .expect("its seat");
    let (x0, x1, z0, z1) = (
        off.x - 100_000,
        off.x + 100_000,
        off.z - 100_000,
        off.z + 100_000,
    );
    b.slots
        .footprint(thing, vec![[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]]);
    b.add_body_at(humanoid(), first, &placed)
        .expect("a body off its floor starts");
    b.begin(0);
    let p = b.runner.controller.body(body).unwrap().pose;
    assert_eq!(p.support, Support::Slot, "seated again: {p:?}");
    assert_eq!(p.frame.node, thing);
    assert_eq!(b.slots.held_by(body), Some(thing), "its seat held");
    assert!(
        !b.runner.controller.carried(body),
        "never carried through a cut"
    );
    // Its next rise: no clean way out, so refused by name, and it is seated still.
    let asked = Asked {
        body,
        actor: Actor::Soul(body),
        ask: Ask::Rise,
        fallbacks: Vec::new(),
    };
    let mut now = 0;
    let mut got = b.start(vec![(id(100), asked)]);
    for _ in 0..100 {
        if !got.is_empty() {
            break;
        }
        now += TICK;
        b.step(now);
        got = b.start(Vec::new());
    }
    got.remove(0).1.expect("the rise starts");
    let mut ended = Vec::new();
    while ended.is_empty() && now < 20 * S {
        now += TICK;
        ended = b.step(now);
    }
    println!("the rise after the restart: {ended:?}");
    let [(i, r)] = ended.as_slice() else {
        panic!("{ended:?}")
    };
    assert_eq!(*i, id(100));
    match r {
        Ok(()) => assert!(
            b.runner.controller.carried(body) || b.slots.held_by(body).is_none(),
            "climbed out"
        ),
        Err(e) => {
            assert!(e.contains("off-surface"), "refused by name: {e}");
            assert_eq!(b.slots.held_by(body), Some(thing), "seated still");
            assert_eq!(
                b.runner.controller.body(body).unwrap().pose.support,
                Support::Slot
            );
        }
    }
}
