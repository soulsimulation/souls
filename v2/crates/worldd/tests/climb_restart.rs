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

/// Killed inside a cut that is not its own thing's, where it may no longer stand (no clean way out, no seat): never
/// carried through the cut, it is placed at its floor's nearest legal point, an entry on it says so (`souls:restarted`,
/// `resume-placed`, from and to), and its next walk is accepted and moves it, as the other body's does.
#[test]
fn a_restart_places_a_body_where_it_may_no_longer_stand_says_so_and_it_walks() {
    restart(false);
}

/// The world's `souls:restarted` entries since the last take: (body, how, from, to), each on the body, changing nothing.
fn restarted(b: &mut Bodies) -> Vec<(Id, String, Vec3, Vec3)> {
    let point = |v: &Value| {
        let Value::Array(a) = v else {
            panic!("a point: {v:?}")
        };
        let n = |v: &Value| match v {
            Value::Uint(n) => i64::try_from(*n).unwrap(),
            Value::Nint(n) => -i64::try_from(*n).unwrap() - 1,
            _ => panic!("a coordinate: {v:?}"),
        };
        Vec3::new(n(&a[0]), n(&a[1]), n(&a[2]))
    };
    let mut out = Vec::new();
    for e in std::mem::take(&mut b.wind_log) {
        for ev in e.events.iter().flatten() {
            if ev.name.as_str() != "souls:restarted" {
                continue;
            }
            assert!(
                matches!(&e.body, replica::effects::Body::Changes(c) if c.is_empty()),
                "an event only: {e:?}"
            );
            let body = replica::effects::read_id(&ev.fields[&1]).unwrap();
            assert_eq!(
                e.envelope.node, body,
                "on the body, so its Soul's client reads it"
            );
            let Value::Bytes(how) = &ev.fields[&2] else {
                panic!("how: {:?}", ev.fields[&2])
            };
            out.push((
                body,
                String::from_utf8(how.clone()).unwrap(),
                point(&ev.fields[&4]),
                point(&ev.fields[&5]),
            ));
        }
    }
    out
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
            more: Vec::new(),
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
    if own {
        assert_eq!(
            (p.x, p.z),
            (off.x, off.z),
            "placed where the log had it, not moved"
        );
        assert!(
            b.runner.controller.carried(climber),
            "carried on to the floor"
        );
    } else {
        assert!(
            !b.runner.controller.carried(climber),
            "never carried through the cut"
        );
        assert!(
            on_after(&b, ground, p),
            "placed at a point it may stand on: {p:?}"
        );
        assert_eq!(b.resumed, vec![(climber, "resume-placed")]);
    }
    // The first tick writes what the restart did, on the body: never a silent move.
    b.step(TICK);
    let said = restarted(&mut b);
    let how = if own { "climb-out" } else { "resume-placed" };
    assert_eq!(said.len(), 1, "{said:?}");
    let (who, named, from, to) = &said[0];
    assert_eq!((*who, named.as_str()), (climber, how));
    assert_eq!(
        (from.x, from.z),
        (off.x, off.z),
        "from where the log had it"
    );
    if !own {
        assert_eq!(*to, p, "to where it stands");
    }
    // It lands, never further in a tick than walking speed, and then both bodies walk.
    let mut now = TICK;
    let mut last = b.runner.controller.body(climber).unwrap().pose.position;
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
    assert!(
        on_after(&b, ground, landed.position),
        "on the ground: {landed:?}"
    );
    for (n, body) in [(1, climber), (2, other)] {
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
        more: Vec::new(),
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

/// E11d after E16: a body killed early in a climb out of a bench's second place (200 mm west of its first), with no
/// clean way on, is seated again in that same place (`resume-seated`), never moved to the bench's lowest free one.
/// With that place taken by another body, it takes the bench's other free place, named `resume-seated-other`.
#[test]
fn a_restart_reseats_a_body_in_the_place_it_was_climbing_out_of() {
    for taken in [false, true] {
        let (town, ground) = town();
        let frame = Frame {
            node: ground,
            slot: None,
        };
        let clear = |p: Vec3| {
            (-4..=3).all(|i| {
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
            .flat_map(|i| {
                (0..400).map(move |j| Vec3::new(-40_000_000 + i * 200_000, 0, j * 200_000))
            })
            .find(|&p| clear(p))
            .expect("a point with no ground within 0.6 m");
        let start = (0..400)
            .flat_map(|i| {
                (0..400).map(move |j| Vec3::new(-40_000_000 + i * 200_000, 0, j * 200_000))
            })
            .find(|&p| on(&town, ground, p))
            .expect("ground");
        let second = Vec3::new(-200_000, 0, 0);
        let (body, sitter) = (id(1), id(2));
        let placed = Placed::from([(
            body,
            (
                Pose {
                    frame,
                    position: Vec3::new(off.x + second.x, 0, off.z),
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: ground,
                        height: 0,
                    },
                },
                None,
            ),
        )]);
        let first = |b| {
            town.surfaces[&ground]
                .place(b, frame, start, Quat::IDENTITY)
                .unwrap()
        };
        let (c0, s0) = (first(body), first(sitter));
        let mut b = Bodies::new(town, TICK).expect("the bodies");
        let bench = id(50);
        b.add_place(PlaceAt {
            thing: bench,
            place: Place {
                slot: 1,
                height: 450_000,
                stand: [0, 300_000],
            },
            point: Vec3::new(off.x, 450_000, off.z),
            facing: Quat::IDENTITY,
            floor: ground,
            more: vec![second],
        })
        .expect("the bench");
        let (x0, x1, z0, z1) = (
            off.x - 300_000,
            off.x + 100_000,
            off.z - 100_000,
            off.z + 100_000,
        );
        b.slots
            .footprint(bench, vec![[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]]);
        if taken {
            b.add_body_at(humanoid(), s0, &Placed::new()).unwrap();
            b.slots
                .restore(
                    &mut b.runner.controller,
                    sitter,
                    (bench, Some(1)),
                    Some(second),
                    sim::controller::Stance::Sit,
                    0,
                )
                .expect("the other body in the second place");
        }
        b.add_body_at(humanoid(), c0, &placed)
            .expect("a body off its floor starts");
        b.begin(0);
        let p = b.runner.controller.body(body).unwrap().pose;
        assert_eq!(p.support, Support::Slot, "seated again: {p:?}");
        let (want, name) = if taken {
            (Vec3::ZERO, "resume-seated-other")
        } else {
            (second, "resume-seated")
        };
        assert_eq!(p.position, want, "the place: {p:?}");
        assert_eq!(b.slots.spot_of(body), Some((bench, 1, u32::from(!taken))));
        assert_eq!(b.resumed, vec![(body, name)]);
    }
}

/// E11d review of #4551 (#4673's case): a body killed during a climb out with no clean way on, beside a seat that
/// moves with its cabin (N14) while that cabin is away from its own stop, is never seated into the away cabin (it would
/// ride off, a named jump): it stands at its floor's nearest legal point, `resume-placed`, and its next walk is
/// accepted, done and moves it, never seated in the cabin through the cabin's return.
#[test]
fn a_restart_beside_an_away_cabin_places_the_body_out_of_it_and_it_walks() {
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
    let (x0, x1, z0, z1) = (
        off.x - 100_000,
        off.x + 100_000,
        off.z - 100_000,
        off.z + 100_000,
    );
    b.slots
        .footprint(cabin, vec![[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]]);
    let mut now = 11 * S;
    assert!(!b.slots.at_own_stop(cabin, 1, now), "the cabin is away");
    b.add_body_at(humanoid(), first, &placed)
        .expect("a body off its floor starts");
    b.begin(now);
    let p = b.runner.controller.body(body).unwrap().pose;
    assert_eq!(b.slots.held_by(body), None, "not in the away cabin: {p:?}");
    assert!(
        matches!(p.support, Support::Surface { .. }),
        "on its floor: {p:?}"
    );
    assert!(
        on_after(&b, ground, p.position),
        "at a point it may stand on: {p:?}"
    );
    assert!(!b.runner.controller.carried(body), "never carried off");
    assert_eq!(b.resumed, vec![(body, "resume-placed")]);
    // Its next walk is accepted and done: to the nearest open ground (ground all round it for 1 m). Through the
    // cabin's return to its own stop (26 s) and on, it is never seated in the cabin.
    let open = |p: Vec3| {
        (-2..=2).all(|i| {
            (-2..=2).all(|j| {
                on(
                    &b.town,
                    ground,
                    Vec3::new(p.x + i * 500_000, 0, p.z + j * 500_000),
                )
            })
        })
    };
    let mut near: Vec<Vec3> = (-50..=50)
        .flat_map(|i| {
            (-50..=50).map(move |j| Vec3::new(off.x + i * 400_000, 0, off.z + j * 400_000))
        })
        .collect();
    near.sort_by_key(|p| ((p.x - off.x).pow(2) + (p.z - off.z).pow(2), p.x, p.z));
    let to = near
        .into_iter()
        .find(|&p| open(p))
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
    println!("the walk after the restart: {started:?}");
    assert!(started.iter().all(|(_, r)| r.is_ok()), "{started:?}");
    let mut done = None;
    let until = now + 60 * S;
    while now < until {
        now += TICK;
        if let Some((_, r)) = b.step(now).into_iter().find(|(i, _)| *i == id(100)) {
            done.get_or_insert((now, r));
        }
        assert_eq!(b.slots.held_by(body), None, "never seated in the cabin");
        assert!(!b.runner.controller.carried(body), "never carried off");
    }
    println!("the walk's answer: {done:?}");
    let (_, r) = done.expect("the walk is answered");
    r.expect("the walk is done");
    let q = b.runner.controller.body(body).unwrap().pose.position;
    assert!(q != p.position, "it moved: {q:?}");
}

/// Walks `body` 1 m east of where it stands and steps until the walk ends: its answer, and whether it moved.
fn walk_east(
    b: &mut Bodies,
    ground: Id,
    body: Id,
    order: Id,
    now: &mut i64,
) -> (Result<(), String>, bool) {
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
    let started = b.start(vec![(order, walk)]);
    assert!(
        started.iter().all(|(_, r)| r.is_ok()),
        "accepted: {started:?}"
    );
    let until = *now + 30 * S;
    while *now < until {
        *now += TICK;
        if let Some((_, r)) = b.step(*now).into_iter().find(|(i, _)| *i == order) {
            let to = b.runner.controller.body(body).unwrap().pose.position;
            return (r, to != from);
        }
    }
    panic!("the walk of {body:?} was not answered in 30 s");
}

/// Two bodies the log had at one point where neither may stand: each is placed at a legal point, never on the
/// other (at least a body's width apart), each named and told, and both walks are done.
#[test]
fn a_restart_places_two_bodies_logged_at_one_spot_apart_and_both_walk() {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let off = (0..400)
        .flat_map(|i| (0..400).map(move |j| Vec3::new(-40_000_000 + i * 200_000, 0, j * 200_000)))
        .find(|&p| !on(&town, ground, p) && on(&town, ground, Vec3::new(p.x + 1_000_000, 0, p.z)))
        .expect("a point off the ground beside it");
    let near = Vec3::new(off.x + 1_000_000, 0, off.z);
    let logged = Pose {
        frame,
        position: off,
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: ground,
            height: 0,
        },
    };
    let (a, c) = (id(1), id(2));
    let placed = Placed::from([(a, (logged, None)), (c, (logged, None))]);
    let first = |n| {
        town.surfaces[&ground]
            .place(n, frame, near, Quat::IDENTITY)
            .unwrap()
    };
    let (a0, c0) = (first(a), first(c));
    let mut b = Bodies::new(town, TICK).expect("the bodies");
    b.add_body_at(humanoid(), a0, &placed)
        .expect("the first starts");
    b.add_body_at(humanoid(), c0, &placed)
        .expect("the second starts");
    b.begin(0);
    assert_eq!(b.resumed, vec![(a, "resume-placed"), (c, "resume-placed")]);
    let (pa, pc) = (
        b.runner.controller.body(a).unwrap().pose.position,
        b.runner.controller.body(c).unwrap().pose.position,
    );
    assert!(
        on_after(&b, ground, pa) && on_after(&b, ground, pc),
        "{pa:?} {pc:?}"
    );
    let d = ((pa.x - pc.x).pow(2) + (pa.z - pc.z).pow(2)).isqrt();
    assert!(d >= 560_000, "a body's width apart: {d} µm");
    b.step(TICK);
    assert_eq!(restarted(&mut b).len(), 2, "each told");
    let mut now = TICK;
    for (n, body) in [(1, a), (2, c)] {
        let (r, moved) = walk_east(&mut b, ground, body, id(100 + n), &mut now);
        r.expect("the walk is done");
        assert!(moved, "body {n} moved");
    }
}

/// A body the log had seated in a seat that is gone at the restart stands at a point it may stand on, named
/// `resume-stood` with an entry on it, is logged as the log had it (its next row heals the log), and its next walk is
/// done.
#[test]
fn a_restart_with_a_seat_gone_stands_the_body_says_so_and_it_walks() {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let stand = (0..400)
        .flat_map(|i| (0..400).map(move |j| Vec3::new(-40_000_000 + i * 200_000, 0, j * 200_000)))
        .find(|&p| (0..=5).all(|k| on(&town, ground, Vec3::new(p.x + k * 200_000, 0, p.z))))
        .expect("open ground");
    let body = id(1);
    let gone = id(50);
    let seated = Pose {
        frame: Frame {
            node: gone,
            slot: Some(1),
        },
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        support: Support::Slot,
    };
    let placed = Placed::from([(body, (seated, Some(sim::controller::Stance::Sit)))]);
    let added = town.surfaces[&ground]
        .place(body, frame, stand, Quat::IDENTITY)
        .unwrap();
    let mut b = Bodies::new(town, TICK).expect("the bodies");
    b.add_body_at(humanoid(), added, &placed)
        .expect("it starts");
    b.begin(0);
    let refused = b.seat_placed(&placed, 0);
    assert_eq!(refused.len(), 1, "its seat is gone: {refused:?}");
    assert_eq!(b.resumed, vec![(body, "resume-stood")]);
    let p = b.runner.controller.body(body).unwrap().pose;
    assert!(
        on_after(&b, ground, p.position),
        "standing where it may: {p:?}"
    );
    b.step(TICK);
    let said = restarted(&mut b);
    assert_eq!(said.len(), 1, "{said:?}");
    assert_eq!((said[0].0, said[0].1.as_str()), (body, "resume-stood"));
    assert!(
        b.moved().iter().any(|row| row.0 == body),
        "its row is written again"
    );
    let mut now = TICK;
    let (r, moved) = walk_east(&mut b, ground, body, id(100), &mut now);
    r.expect("the walk is done");
    assert!(moved, "it moved");
}

/// An open ground 20 m square holding Eden's bench seat at the origin and its table 3 m east (today's solids and slots,
/// the facts' rows): the ground under the bench's seats and the table's top is cut since the first-day tester's round
/// 2 (`sim::ground::scene`).
const BENCH_AND_TABLE: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [{"ref": "core-bench-seat@1", "hash": "ab", "name": "core:bench_seat", "form": "point"},
            {"ref": "core-table@1", "hash": "ac", "name": "core:table", "form": "point"}],
  "things": [
    {"id": "e_bench", "def": "core-bench-seat@1", "ref": "core-bench-seat@1", "parent": null,
     "pose": [0, 0, 0, 0], "world": [0, 0, 0, 0], "scale_ppm": 1000000, "name": "bench",
     "solids": [[-600, 0, 15, 135, 0, 15, 405, 0, 0], [600, 0, 15, 135, 0, 15, 405, 0, 0]],
     "slots": [{"n": 1, "id": "seat-1", "kind": "seat", "at": [-350, 465, 0], "yaw": 0, "capacity": 1},
               {"n": 2, "id": "seat-2", "kind": "seat", "at": [350, 465, 0], "yaw": 0, "capacity": 1}]},
    {"id": "e_table", "def": "core-table@1", "ref": "core-table@1", "parent": null,
     "pose": [3000, 0, 0, 0], "world": [3000, 0, 0, 0], "scale_ppm": 1000000, "name": "table",
     "solids": [[-520, -320, 30, 30, 0, 0, 700, 0, 0], [520, -320, 30, 30, 0, 0, 700, 0, 0],
                [-520, 320, 30, 30, 0, 0, 700, 0, 0], [520, 320, 30, 30, 0, 0, 700, 0, 0]],
     "slots": [{"n": 1, "id": "top", "kind": "surface", "at": [0, 750, 0], "yaw": 0, "capacity": 12}]}
  ],
  "doors": [],
  "places": [{"id": "square.area", "of": "area", "kind": "square", "name": "the square",
              "polygon": [[-10000, -10000], [10000, -10000], [10000, 10000], [-10000, 10000]]}],
  "bake": {"things": 2},
  "byRef": {"core-bench-seat@1": 1, "core-table@1": 1}
}"#;

/// First-day tester, round 2: a body the log had standing where the ground under a bench's seats or a table's top is
/// now cut (in the bench's middle, under the table) is never left there at a restart. The bench's body climbs out
/// over the bench's own boxes (its footprint, which holds the box under its seats); the table's, under a thing with no
/// seat, is placed at its floor's nearest legal point (`resume-placed`). Both then stand where they may, and walk.
#[test]
fn a_restart_places_bodies_logged_under_a_bench_or_a_table_where_they_may_stand_and_they_walk() {
    let (town, nodes) = town_of(BENCH_AND_TABLE);
    let ground = nodes["ground"];
    let bench = nodes["e_bench"];
    restart_under(town, ground, bench);
}

/// A town of the facts `text` (an open ground and what stands on it), and its nodes by key.
fn town_of(text: &str) -> (Town, BTreeMap<String, Id>) {
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(text).expect("the facts load");
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
    (town, nodes)
}

/// A pen on the open ground: four walls round a 2 m square, no gap. Its inside is ground no walk from outside reaches:
/// `View::sealed` says so there and not outside, so a seat's stand point is never moved in (`places::register`).
const PEN: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [{"ref": "core-fence@1", "hash": "ad", "name": "core:fence", "form": "point"}],
  "things": [
    {"id": "e_pen", "def": "core-fence@1", "ref": "core-fence@1", "parent": null,
     "pose": [0, 0, 0, 0], "world": [0, 0, 0, 0], "scale_ppm": 1000000, "name": "pen",
     "solids": [[0, -1500, 1600, 100, 0, 0, 1500, 0, 0], [0, 1500, 1600, 100, 0, 0, 1500, 0, 0],
                [-1500, 0, 100, 1600, 0, 0, 1500, 0, 0], [1500, 0, 100, 1600, 0, 0, 1500, 0, 0]]}
  ],
  "doors": [],
  "places": [{"id": "square.area", "of": "area", "kind": "square", "name": "the square",
              "polygon": [[-10000, -10000], [10000, -10000], [10000, 10000], [-10000, 10000]]}],
  "bake": {"things": 1},
  "byRef": {"core-fence@1": 1}
}"#;

#[test]
fn ground_sealed_off_from_the_main_ground_is_named_sealed() {
    let (mut town, nodes) = town_of(PEN);
    let ground = nodes["ground"];
    assert!(on(&town, ground, Vec3::ZERO), "the pen's inside is ground");
    assert!(
        on(&town, ground, Vec3::new(4_000_000, 0, 0)),
        "outside it too"
    );
    let view = town.view();
    assert!(
        view.sealed(ground, Vec3::ZERO),
        "the pen's inside is sealed off"
    );
    assert!(
        !view.sealed(ground, Vec3::new(4_000_000, 0, 0)),
        "outside it is not"
    );
}

fn restart_under(town: Town, ground: Id, bench: Id) {
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let (in_bench, in_table) = (Vec3::ZERO, Vec3::new(3_000_000, 0, 0));
    assert!(!on(&town, ground, in_bench), "the bench's middle is cut");
    assert!(!on(&town, ground, in_table), "under the table is cut");
    let own = worldd::places::footprint(&town.tree, bench, ground);
    let clear = Vec3::new(0, 0, 3_000_000);
    let first = |b| town.surfaces[&ground].place(b, frame, clear, Quat::IDENTITY);
    let (a, c) = (id(1), id(2));
    let (a0, c0) = (first(a).unwrap(), first(c).unwrap());
    let logged = |p| {
        (
            Pose {
                frame,
                position: p,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: ground,
                    height: 0,
                },
            },
            None,
        )
    };
    let placed = Placed::from([(a, logged(in_bench)), (c, logged(in_table))]);
    let mut b = Bodies::new(town, TICK).expect("the bodies");
    // The bench's seats, as `worldd serve` registers them: the seat's point and its stand point 455 mm in front.
    for (slot, x) in [(1, -350_000), (2, 350_000)] {
        b.add_place(PlaceAt {
            thing: bench,
            place: Place {
                slot,
                height: 465_000,
                stand: [0, 455_000],
            },
            point: Vec3::new(x, 465_000, 0),
            facing: Quat::IDENTITY,
            floor: ground,
            more: Vec::new(),
        })
        .expect("its seat");
    }
    b.slots.footprint(bench, own);
    b.add_body_at(humanoid(), a0, &placed)
        .expect("the bench's body starts");
    b.add_body_at(humanoid(), c0, &placed)
        .expect("the table's body starts");
    b.begin(0);
    println!("resumed: {:?}", b.resumed);
    let mut now = 0;
    while b.runner.controller.carried(a) || b.runner.controller.carried(c) {
        now += TICK;
        assert!(now < 10 * S, "landed within 10 s");
        b.step(now);
    }
    let said = restarted(&mut b);
    println!("restarted: {said:?}");
    let how = |who| said.iter().find(|s| s.0 == who).map(|s| s.1.clone());
    assert_eq!(
        how(a).as_deref(),
        Some("climb-out"),
        "out over the bench's own boxes"
    );
    assert_eq!(
        how(c).as_deref(),
        Some("resume-placed"),
        "placed beside the table"
    );
    for (n, body) in [(1, a), (2, c)] {
        let p = b.runner.controller.body(body).unwrap().pose.position;
        assert!(
            on_after(&b, ground, p),
            "body {n} stands where it may: {p:?}"
        );
        let (r, moved) = walk_east(&mut b, ground, body, id(100 + n), &mut now);
        println!("body {n}: from {p:?}: {r:?}");
        r.expect("the walk is done");
        assert!(moved, "body {n} moved");
    }
}
