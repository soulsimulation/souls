//! E7's boarding (#2756, A2): a body sent to a ride's seat by an intent stands at the boarding point and boards when
//! the ride stops there, within its intent's expiry; an intent that expires first ends the wait, and the body never
//! boards. The agent picks the expiry from the timetable its copy reads (`replica::schedule`); the engine holds no time
//! or condition. A1 and A3 are `replica`'s (`cargo test -p replica --lib schedule`).
//!
//! `cargo test -p sim --test schedules -- --nocapture` prints both runs.

use replica::effects::Actor;
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Scope};
use replica::intents::{Intent, Target};
use replica::pose::{Frame, Movable, Owner, Pose, Quat, Scene, Support, Track, Vec3};
use replica::time::Micros;
use replica::world_model::show;
use sim::courses::{Course, Shape, Station, Table};
use sim::links::boarding::{Boarding, Sent, Waited};
use sim::links::turns::{Facts, Turns};
use sim::orders::EXPIRED;
use std::collections::BTreeMap;

const TICK: Micros = 50_000;
const SCOPE: Scope = Scope([0x27; 16]);
const WORLD: u64 = 1;
const GROUND: u64 = 2;
const RIDE: u64 = 3;
const BODY: u64 = 4;
const LINK: u64 = 5;
/// The ride's seat: slot 1 of the moving node.
const SEAT: u64 = 1;

fn id(n: u64) -> Id {
    Id::new(SCOPE, n).unwrap()
}

/// N12's ride: a 40 m by 30 m loop at 3 m/s, stopping 20 s at its first corner (the boarding point) and 10 s at its
/// third.
fn ride() -> Table {
    let st = |x: i64, z: i64, dwell: Micros| Station {
        at: Vec3::new(x, 0, z),
        dwell,
    };
    Course {
        stations: vec![
            st(0, 0, 20_000_000),
            st(40_000_000, 0, 0),
            st(40_000_000, 30_000_000, 10_000_000),
            st(0, 30_000_000, 0),
        ],
        shape: Shape::Loop,
        speed: 3_000_000,
        t0: 0,
        within: 60_000_000,
    }
    .load()
    .unwrap()
}

fn frame(n: u64) -> Frame {
    Frame {
        node: id(n),
        slot: None,
    }
}

fn movable(n: u64, frame: Frame, position: Vec3, support: Support, owner: Owner) -> Movable {
    Movable {
        id: id(n),
        pose: Pose {
            frame,
            position,
            orientation: Quat::IDENTITY,
            support,
        },
        owner,
        linear: Vec3::ZERO,
        angular: Vec3::ZERO,
        slots: BTreeMap::new(),
    }
}

/// The body, standing at the boarding point's ground end beside stop 0.
fn body() -> Movable {
    let on = Support::Surface {
        surface: id(GROUND),
        height: 0,
    };
    movable(
        BODY,
        frame(GROUND),
        Vec3::new(-800_000, 0, 0),
        on,
        Owner::Mover,
    )
}

/// The scene at `t`: the ground, the ride from its formula, the body's record.
fn scene_at(table: &Table, body: &Movable, t: Micros) -> Scene {
    let on = Support::Surface {
        surface: id(GROUND),
        height: 0,
    };
    let ride = table
        .movable(
            id(RIDE),
            frame(WORLD),
            on,
            Quat::IDENTITY,
            BTreeMap::from([(SEAT, Vec3::ZERO)]),
            t,
        )
        .unwrap();
    let ground = movable(
        GROUND,
        frame(WORLD),
        Vec3::ZERO,
        Support::None,
        Owner::Track(Track::Rest),
    );
    Scene::new(id(WORLD), vec![ground, ride, body.clone()]).unwrap()
}

fn link() -> Boarding {
    Boarding {
        id: id(LINK),
        frame: id(RIDE),
        station: 0,
        slot: SEAT,
        ground: id(GROUND),
        width: 800_000,
    }
}

/// The agent's intent: Soul 100 queues for the ride's seat and sits, expiring at `expiry`. Read back from its bytes,
/// as the world receives it: it holds an expiry and nothing else of time.
fn sent_by(expiry: Micros) -> (Intent, Sent) {
    let i = Intent {
        actor: Actor::Soul(Id::new(Scope([0xdd; 16]), 100).unwrap()),
        verb: Name::new("souls:queue").unwrap(),
        target: Some(Target::Node(id(RIDE))),
        parameters: BTreeMap::from([(1, Value::Text(Name::new("test:sit").unwrap()))]),
        sequence: 1,
        basis: Value::Array(vec![
            Value::Bytes(SCOPE.0.to_vec()),
            id(WORLD).to_value(),
            Value::Uint(1),
            Value::Uint(42),
        ]),
        expiry,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let i = Intent::read(&encode(&i.to_value()).unwrap()).unwrap();
    let s = Sent {
        body: id(BODY),
        intent: id(900),
        expiry: i.expiry,
        distance: 0,
    };
    (i, s)
}

/// What one run did: how the wait ended, and the body's hand-off onto the seat if it boarded.
struct Run {
    waited: Waited,
    boarded: Option<(Micros, Movable)>,
}

/// The body reaches the boarding point at `arrive` and waits there under its intent until it is granted the
/// crossing or the intent expires; a granted body crosses on its next tick.
fn run(arrive: Micros, s: Sent) -> Run {
    let (table, link) = (ride(), link());
    let mut turns = Turns::new();
    let mut sent = vec![s];
    let mut t = arrive;
    loop {
        let facts = Facts {
            room: [true, true],
            ..Facts::default()
        };
        let ended = link
            .queue(&mut turns, &table, &mut sent, &facts, t)
            .unwrap();
        if let Some(w) = ended.first() {
            let boarded = matches!(w, Waited::Granted(..)).then(|| {
                let at = t + TICK;
                let mut scene = scene_at(&table, &body(), at);
                link.board(&mut scene, &table, id(BODY), at, id(901), SCOPE, id(WORLD))
                    .unwrap();
                (at, scene.get(id(BODY)).unwrap().clone())
            });
            return Run {
                waited: *w,
                boarded,
            };
        }
        assert!(t < arrive + 2 * table.period, "the wait did not end");
        t += TICK;
    }
}

#[test]
fn a2_a_body_sent_to_a_rides_seat_boards_when_it_stops_within_its_intents_expiry() {
    let table = ride();
    let arrive = 30_000_000;
    assert!(table.stopped(arrive).unwrap().is_none(), "the ride is away");
    // The agent reads the next stop at the boarding point from its copy's timetable (the formula), and sets its
    // intent's expiry to that stop's end.
    let next = table.next(arrive, Some(0), 1)[0];
    println!(
        "E7 A2: the body reaches the boarding point at {arrive} us; the timetable's next stop there is {} to {} us",
        next.arrives, next.leaves
    );
    let (intent, s) = sent_by(next.leaves);
    println!(
        "E7 A2: its intent: {} at the ride {}, expiry {} us (no other time, no condition)",
        intent.verb.as_str(),
        show(id(RIDE)),
        intent.expiry
    );
    let r = run(arrive, s);
    let Waited::Granted(_, granted) = r.waited else {
        panic!("not granted: {:?}", r.waited)
    };
    let (on, rider) = r.boarded.expect("boarded");
    println!(
        "E7 A2: granted at {granted} us, on the seat at {on} us, before its expiry at {} us; the rider's frame is {} slot {:?}, owner {:?}",
        intent.expiry,
        show(rider.pose.frame.node),
        rider.pose.frame.slot,
        rider.owner
    );
    // Granted on the first tick the ride stands at the stop, not before.
    let first = arrive + (next.arrives - arrive + TICK - 1) / TICK * TICK;
    assert_eq!(granted, first);
    assert!(on < intent.expiry, "within its intent's expiry");
    let stop = table.stopped(on).unwrap().expect("the ride is stopped");
    assert_eq!(stop.station, 0, "at the boarding point");
    assert_eq!(
        rider.pose.frame,
        Frame {
            node: id(RIDE),
            slot: Some(SEAT)
        }
    );
    assert_eq!(rider.owner, Owner::Slot);

    // An intent that expires before the ride comes: the wait ends at its expiry, by name, and the body never boards.
    let early = next.arrives - 10_000_000;
    let (_, s) = sent_by(early);
    let r = run(arrive, s);
    println!(
        "E7 A2: an intent expiring at {early} us, before the stop: its wait ended {} ({EXPIRED}), boarded: {}",
        match r.waited {
            Waited::Expired(_, at) => format!("expired at {at} us"),
            Waited::Granted(_, at) => format!("granted at {at} us"),
        },
        r.boarded.is_some()
    );
    // Ended on the first tick at or after its expiry.
    let tick = arrive + (early - arrive + TICK - 1) / TICK * TICK;
    assert_eq!(r.waited, Waited::Expired(s, tick));
    assert!(r.boarded.is_none());
}
