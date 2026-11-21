//! E7's checks (#2756): the three readings from a copy that applied the log, with no request (A1), and the closed
//! list of orders with no intent holding a start time or a condition (A3). A2, boarding, is `sim/tests/schedules.rs`.
//!
//! `cargo test -p replica --lib schedule -- --nocapture` prints the readings.

use std::collections::BTreeMap;

use super::course::{Course, Shape, Station};
use super::{
    F_COURSE, F_END, F_HOURS, F_PLACE, F_POSTED_BY, F_START, F_TEXT, Hours, calendar, hours, stops,
};
use crate::apply::Replica;
use crate::audience::REFERENCE;
use crate::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, FIXTURE_HEADER, Header, Part,
    fixture_bytes,
};
use crate::encode::{Name, Value, decode, encode};
use crate::ids::{Id, Scope};
use crate::intents::{FIXTURES as INTENTS, Intent, Kind, ORDERS};
use crate::pose::{Frame, Pose, Quat, Support, Vec3};
use crate::sky::{Calendar, DAY_US, civil_from_days, days_from_civil, int};
use crate::time::Micros;
use crate::world_model::{Audience, show};

fn ee(n: u64) -> Id {
    Id::new(Scope([0xee; 16]), n).unwrap()
}

fn dd(n: u64) -> Id {
    Id::new(Scope([0xdd; 16]), n).unwrap()
}

const HOUR: Micros = 3_600_000_000;
const ROOT: u64 = 0;
const RIDE: u64 = 1000;
const SHOP: u64 = 1001;
const CAL: u64 = 1002;
/// Entries are 2000 and up, as many as the live Eden held.
const ENTRIES: u64 = 8_273;
/// The world's local zone: UTC-5 throughout.
const OFFSET: Micros = -5 * HOUR;

/// Now, as the agent reads it: Thursday 19 November 2026, 10:30 local, three days into the world.
fn now() -> Micros {
    3 * DAY_US + 15 * HOUR + 30 * 60_000_000
}

/// The calendar on the root: a real-time day, world time 0 at 2026-11-16T00:00 UTC.
fn world_calendar() -> Calendar {
    Calendar {
        day_s: 86_400,
        origin: days_from_civil(2026, 11, 16) * DAY_US,
        offsets: vec![(0, OFFSET)],
    }
}

/// N12's ride: a 40 m by 30 m loop at 3 m/s, stopping 20 s at its first corner (the boarding point) and 10 s at its
/// third.
fn ride() -> Course {
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
}

/// A shop open 09:00 to 17:30 on weekdays and 10:00 to 14:00 on Saturdays, and once on a Sunday evening.
fn shop_hours() -> Vec<Hours> {
    let m = 60_000_000;
    vec![
        Hours::Weekly(0b001_1111, 9 * HOUR, 17 * HOUR + 30 * m),
        Hours::Weekly(0b010_0000, 10 * HOUR, 14 * HOUR),
        Hours::Once(6 * DAY_US + 23 * HOUR, 6 * DAY_US + 26 * HOUR),
    ]
}

fn kind(name: &str) -> Name {
    Name::new(&format!(
        "test:{name}@12200000000000000000000000000000000000000000000000000000000000000000"
    ))
    .unwrap()
}

fn create(node: Id, k: &str, fields: Vec<(u64, Value)>) -> ChangeRec {
    ChangeRec {
        change: Change::Create {
            node,
            kind: kind(k),
            pose: Pose {
                frame: Frame {
                    node: if k == "entry" { ee(CAL) } else { ee(ROOT) },
                    slot: None,
                },
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::None,
            },
            audience: Audience::Everyone,
            fields: fields.into_iter().collect(),
        },
        rest: BTreeMap::new(),
    }
}

/// Entry `k`: an hour long, spread over a year from the world's start (one every 63 minutes), at the shop, its words
/// by reference, posted by one of three Souls.
fn entry(k: u64) -> ChangeRec {
    let start = i64::try_from(k).unwrap() * 63 * 60_000_000;
    create(
        ee(2000 + k),
        "entry",
        vec![
            (F_PLACE, ee(SHOP).to_value()),
            (F_START, int(start)),
            (F_END, int(start + HOUR)),
            (
                F_TEXT,
                Value::Map(BTreeMap::from([(REFERENCE, ee(100_000 + k).to_value())])),
            ),
            (F_POSTED_BY, dd(100 + k % 3).to_value()),
        ],
    )
}

/// Eden's copy, as a client's copy applies the log: one entry of the world's start that writes the calendar's
/// settings on the root and creates the ride, the shop, the calendar and its entries.
fn copy() -> Replica {
    // T6's fixture header, with the kinds this world pins added.
    let Value::Map(mut h) = decode(&fixture_bytes(FIXTURE_HEADER).unwrap())
        .unwrap()
        .value
    else {
        panic!("a header")
    };
    let Some(Value::Array(kinds)) = h.get_mut(&6) else {
        panic!("its kinds")
    };
    kinds.extend(["ride", "shop", "calendar", "entry"].map(|k| Value::Text(kind(k))));
    let header = encode(&Value::Map(h)).unwrap();
    let mut r = Replica::start(&header).unwrap();
    let mut changes: Vec<ChangeRec> = world_calendar()
        .fields()
        .into_iter()
        .map(|(field, to)| ChangeRec {
            change: Change::Set {
                node: ee(ROOT),
                field,
                to,
                by: None,
            },
            rest: BTreeMap::new(),
        })
        .collect();
    changes.push(create(
        ee(RIDE),
        "ride",
        vec![(F_COURSE, ride().to_value())],
    ));
    let rows = shop_hours().into_iter().map(Hours::to_value).collect();
    changes.push(create(
        ee(SHOP),
        "shop",
        vec![(F_HOURS, Value::Array(rows))],
    ));
    changes.push(create(ee(CAL), "calendar", Vec::new()));
    changes.extend((0..ENTRIES).map(entry));
    let e = Effect {
        envelope: Envelope {
            sequence: r.version(),
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: ee(ROOT),
        },
        body: Body::Changes(changes),
        events: None,
        rest: BTreeMap::new(),
    };
    let hash = Header::read(&header).unwrap().hash().to_bytes();
    let part = Value::Map(BTreeMap::from([
        (1, Value::Bytes(hash)),
        (2, Value::Array(vec![e.to_value()])),
    ]));
    r.apply(&Part::read(&encode(&part).unwrap()).unwrap())
        .unwrap();
    r
}

/// World µs as a local date and time, for the printout.
fn local(t: Micros) -> String {
    let l = world_calendar().local(t).unwrap();
    let ([y, m, d], wd) = civil_from_days(l.div_euclid(DAY_US));
    let s = l.rem_euclid(DAY_US) / 1_000_000;
    let day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][usize::try_from(wd - 1).unwrap()];
    format!(
        "{day} {y}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        s / 3600,
        s / 60 % 60,
        s % 60
    )
}

#[test]
fn a1_the_three_readings_from_the_copy_with_no_request() {
    let r = copy();
    let now = now();
    assert_eq!(local(now), "Thu 2026-11-19 10:30:00");

    // A ride's next three stops at its boarding point (station 0), from its formula.
    let next = stops(&r, ee(RIDE), Some(0), now, 3).unwrap();
    println!("E7 A1: now {} (world {now} us)", local(now));
    for s in &next {
        println!(
            "E7 A1: ride stops at station {} from {} to {} (world {}..{} us)",
            s.station,
            local(s.arrives),
            local(s.leaves),
            s.arrives,
            s.leaves
        );
    }
    let table = ride().load().unwrap();
    assert_eq!(next.len(), 3);
    for (k, s) in next.iter().enumerate() {
        assert_eq!(s.station, 0);
        assert!(s.leaves > now);
        assert_eq!(s.leaves - s.arrives, 20_000_000, "the stop's dwell");
        // The formula agrees: the frame dwells at station 0 throughout, and not just before it arrives.
        let at = table.stopped(s.arrives).unwrap().unwrap();
        assert_eq!((at.station, at.left), (0, 20_000_000));
        assert!(table.stopped(s.arrives - 1).unwrap().is_none());
        if k > 0 {
            assert_eq!(s.arrives - next[k - 1].arrives, table.period, "a lap apart");
        }
    }
    // Every stop on the line, not only the boarding point's.
    let all = stops(&r, ee(RIDE), None, now, 3).unwrap();
    assert_eq!(
        all.iter().map(|s| s.station).collect::<Vec<_>>(),
        if all[0].station == 0 {
            vec![0, 2, 0]
        } else {
            vec![2, 0, 2]
        }
    );

    // A shop's hours over the next seven days, as world times through the world's calendar.
    let week = now + 7 * DAY_US;
    let open = hours(&r, ee(SHOP), now, week).unwrap();
    for (a, b) in &open {
        println!("E7 A1: shop's hours {} to {}", local(*a), local(*b));
    }
    let shown: Vec<String> = open
        .iter()
        .map(|(a, b)| format!("{} - {}", local(*a), &local(*b)[15..]))
        .collect();
    assert_eq!(
        shown,
        [
            "Thu 2026-11-19 09:00:00 - 17:30:00",
            "Fri 2026-11-20 09:00:00 - 17:30:00",
            "Sat 2026-11-21 10:00:00 - 14:00:00",
            "Sun 2026-11-22 18:00:00 - 21:00:00",
            "Mon 2026-11-23 09:00:00 - 17:30:00",
            "Tue 2026-11-24 09:00:00 - 17:30:00",
            "Wed 2026-11-25 09:00:00 - 17:30:00",
            "Thu 2026-11-26 09:00:00 - 17:30:00",
        ]
    );

    // The calendar's entries for the next seven days, out of 8,273 over a year.
    let cal = calendar(&r, ee(CAL), now, week).unwrap();
    assert_eq!(r.children(ee(CAL), None).unwrap().len(), 8_273);
    let want: Vec<Id> = (0..ENTRIES)
        .filter(|k| {
            let s = i64::try_from(*k).unwrap() * 63 * 60_000_000;
            s < week && s + HOUR > now
        })
        .map(|k| ee(2000 + k))
        .collect();
    assert_eq!(cal.iter().map(|e| e.id).collect::<Vec<_>>(), want);
    assert!(cal.windows(2).all(|w| w[0].start <= w[1].start));
    for e in cal.iter().take(3) {
        println!(
            "E7 A1: calendar entry {} at {} from {} to {}, text {}, posted by {}",
            show(e.id),
            show(e.place),
            local(e.start),
            local(e.end),
            show(e.text),
            show(e.posted_by)
        );
    }
    println!(
        "E7 A1: {} of the calendar's {} entries fall in the next seven days",
        cal.len(),
        ENTRIES
    );
    assert_eq!(cal[0].place, ee(SHOP));
    let k0 = (0..ENTRIES).find(|k| ee(2000 + k) == cal[0].id).unwrap();
    assert_eq!(cal[0].text, ee(100_000 + k0), "the words by reference");

    // What a copy cannot read is refused by name; nothing is guessed.
    assert_eq!(
        stops(&r, ee(SHOP), Some(0), now, 3).unwrap_err().name,
        "schedule-missing"
    );
    assert_eq!(
        hours(&r, ee(9_999_999), now, week).unwrap_err().name,
        "node-missing"
    );
    assert_eq!(
        hours(&r, ee(SHOP), now, now + 500 * DAY_US)
            .unwrap_err()
            .name,
        "window-too-long"
    );
}

#[test]
fn a3_four_kinds_of_order_and_no_intent_with_a_start_time_or_a_condition() {
    // The kinds of order the engine carries out, found from one intent of each kind (T10's fixtures): an order's
    // verb, or an act's ranked fallbacks.
    let mut orders: Vec<String> = Vec::new();
    for (name, text) in INTENTS {
        let i = Intent::read(&fixture_bytes(text).unwrap()).unwrap();
        match i.kind().unwrap() {
            Kind::Order => orders.push(i.verb.as_str().to_owned()),
            Kind::Act if !i.fallbacks.is_empty() => orders.push("ranked fallbacks".into()),
            _ => {}
        }
        println!("E7 A3: fixture {name:<9} is {:?}", i.kind().unwrap());
    }
    orders.sort();
    println!("E7 A3: the kinds of order: {orders:?}");
    assert_eq!(
        orders,
        [
            "ranked fallbacks",
            "souls:follow",
            "souls:hold",
            "souls:queue"
        ]
    );
    assert_eq!(
        ORDERS.len() + 1,
        orders.len(),
        "the closed list and fallbacks: four"
    );

    // No fifth: any other engine verb, a wait or a condition among them, is refused by name.
    let act = fixture_bytes(INTENTS[0].1).unwrap();
    let Value::Map(base) = decode(&act).unwrap().value else {
        panic!("an intent")
    };
    let with = |k: u64, v: Value| {
        let mut m = base.clone();
        m.insert(k, v);
        Intent::read(&encode(&Value::Map(m)).unwrap())
    };
    for verb in [
        "souls:wait-until",
        "souls:when",
        "souls:at",
        "souls:every",
        "souls:remind",
        "souls:schedule",
    ] {
        let r = with(2, Value::Text(Name::new(verb).unwrap())).unwrap_err();
        println!("E7 A3: {verb:<17} refused {}", r.name);
        assert_eq!(r.name, "order-unknown", "{verb}");
    }
    // No field for a start time or a condition: an intent's fields are 1 to 11, and only 7, the expiry, is a time.
    for (k, what) in [(12, "a start time"), (13, "a condition"), (0, "field 0")] {
        let r = with(k, int(60_000_000)).unwrap_err();
        println!(
            "E7 A3: an intent with {what} (field {k}) refused {}",
            r.name
        );
        assert_eq!(r.name, "intent-not-a-record", "{what}");
    }
}

/// #3603: a track run once (a steered punt's) goes through its stations and stands at the last for good, a stop that
/// never ends; it round-trips through the node's field; a node's place at a time is its course's, else where it was
/// placed (no course, a course that does not load, or a time before it starts).
#[test]
fn a_track_run_once_stands_at_its_last_station_and_a_place_is_read_from_the_field() {
    let once = Course {
        stations: vec![
            Station {
                at: Vec3::new(0, 0, 0),
                dwell: 0,
            },
            Station {
                at: Vec3::new(6_000_000, 0, 8_000_000),
                dwell: 0,
            },
        ],
        shape: Shape::Once,
        speed: 600_000,
        t0: 1_000_000,
        within: 20_000_000,
    };
    let table = once.load().expect("a track run once loads");
    // 10 m at 0.6 m/s: 16.666667 s, rounded up to the microsecond.
    let (mid, v) = table.at(1_000_000 + 8_333_334).unwrap();
    assert_eq!(
        (mid, v),
        (
            Vec3::new(3_000_000, 0, 4_000_000),
            Vec3::new(360_000, 0, 480_000)
        )
    );
    let end = 1_000_000 + 16_666_667;
    assert_eq!(
        table.at(end).unwrap(),
        (Vec3::new(6_000_000, 0, 8_000_000), Vec3::ZERO)
    );
    let much_later = end + 365 * DAY_US;
    assert_eq!(
        table.at(much_later).unwrap().0,
        Vec3::new(6_000_000, 0, 8_000_000)
    );
    assert_eq!(
        table.stopped(much_later).unwrap().map(|s| s.station),
        Some(1)
    );
    assert_eq!(Course::read(&once.to_value()), Some(once.clone()));
    let placed = Vec3::new(-1, -2, -3);
    let fields = BTreeMap::from([(F_COURSE, once.to_value())]);
    assert_eq!(
        super::course::place_at(&fields, placed, end).0,
        Vec3::new(6_000_000, 0, 8_000_000)
    );
    assert_eq!(
        super::course::place_at(&fields, placed, 0),
        (placed, Vec3::ZERO),
        "before it starts"
    );
    assert_eq!(
        super::course::place_at(&BTreeMap::new(), placed, end),
        (placed, Vec3::ZERO),
        "no course"
    );
}
