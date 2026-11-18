//! Engine v2 I5b (#3178): a sit from the gateway through I5's selector, and a burst that fills every seat. On N2's
//! test world, in lockstep, 600 bodies each send `eden:sit` with the selector "any free chair in this room, nearest
//! to the body" in the same tick, into 300 chairs. The selector is resolved at commit from the per-room index of free
//! seats, in B3's stable order: every chair is taken once, each sit runs to its end, and the other 300 are refused
//! `seat.none-free` by name. Each receipt names the move-started entry, which names the seat bound and its rank.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use import_eden::Import;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Actor, Cause, Header, Part, fixture_bytes, read_id, schema_hash};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::Intent;
use replica::moves::Seat;
use replica::pose::{Frame, Quat, Vec3};
use replica::selector::{Rule, Selector};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::recorder;
use sim::slots::SeatAt;
use sim::walk::town::Town;
use worldd::answers::{self, Config, Event, MOVE_STARTED};
use worldd::bodies::{Bodies, Placed};
use worldd::checkers::lamps;

const LINEAGE: Scope = Scope([0x5b; 16]);
const CHAIR: &str = include_str!("../../replica/fixtures/seats/chair.diag");
const CHAIRS: u64 = 300;
const SENDS: u64 = 600;
/// The chairs' grid: 20 to a row, 1 m apart, rows 1.5 m apart, facing +z; the hall's corner, µm.
const PER_ROW: u64 = 20;
const CORNER: (i64, i64) = (-40_000_000, 15_000_000);

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn humanoid() -> Family {
    let r = |n: &str| Resource {
        name: name(n),
        class: Class::Locomotion,
        slot: None,
    };
    Family {
        name: name("souls:humanoid"),
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
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/i5b-test/1").to_bytes()),
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

/// Body `n` (1-based): bodies 1..=300 stand at chair n's stand point, the rest 3 m behind the last row.
fn body(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

fn chair(n: u64) -> Id {
    Id::new(Scope([8; 16]), n).unwrap()
}

fn seat_point(n: u64) -> Vec3 {
    let (col, row) = ((n - 1) % PER_ROW, (n - 1) / PER_ROW);
    Vec3::new(
        CORNER.0 + col as i64 * 1_000_000,
        450_000,
        CORNER.1 + row as i64 * 1_500_000,
    )
}

fn start_point(n: u64) -> Vec3 {
    if n <= CHAIRS {
        let s = seat_point(n);
        Vec3::new(s.x, 0, s.z + 300_000)
    } else {
        let k = n - CHAIRS - 1;
        Vec3::new(
            CORNER.0 + (k % PER_ROW) as i64 * 1_000_000,
            0,
            CORNER.1
                + (CHAIRS / PER_ROW) as i64 * 1_500_000
                + 3_000_000
                + (k / PER_ROW) as i64 * 500_000,
        )
    }
}

fn bodies(placed: &Placed) -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let mut placements = Vec::new();
    for n in 1..=SENDS {
        placements.push(town.surfaces[&ground].place(
            body(n),
            frame,
            start_point(n),
            Quat::IDENTITY,
        )?);
    }
    let mut b = Bodies::new(town, 50_000)?;
    for p in placements {
        b.add_body_at(humanoid(), p, placed)?;
    }
    let seat = Seat::from_value(&decode(&fixture_bytes(CHAIR)?).unwrap().value)?;
    for n in 1..=CHAIRS {
        b.add_seat_of(
            SeatAt {
                thing: chair(n),
                seat: seat.clone(),
                point: seat_point(n),
                facing: Quat::IDENTITY,
                floor: ground,
            },
            name("eden:chair"),
        )?;
    }
    Ok(b)
}

fn sit_any(b: Id, ground: Id) -> Vec<u8> {
    let any = Selector::FreeSlot {
        kind: name("eden:chair"),
        node: ground,
        rule: Rule::Nearest,
    };
    let i = Intent {
        actor: Actor::Soul(b),
        verb: name("eden:sit"),
        target: Some(any.target()),
        parameters: BTreeMap::new(),
        sequence: 1,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: 1_000_000_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    };
    encode(&i.to_value()).unwrap()
}

/// An answer: `Ok((intent, entries))` for a receipt, `Err(reason)` for a refusal.
type Answered = Result<(Id, Vec<u64>), String>;

fn answer(rx: &Receiver<Vec<u8>>) -> Answered {
    let frame = rx.recv_timeout(Duration::from_secs(60)).expect("an answer");
    let Value::Map(m) = decode(&frame).unwrap().value else {
        panic!("a frame")
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        panic!("an answer")
    };
    match (a.get(&3), a.get(&4), a.get(&5)) {
        (Some(Value::Uint(1)), Some(id), Some(Value::Array(e))) => Ok((
            read_id(id).unwrap(),
            e.iter()
                .map(|v| match v {
                    Value::Uint(n) => *n,
                    _ => panic!("an entry"),
                })
                .collect(),
        )),
        (Some(Value::Uint(2)), Some(Value::Text(t)), _) => Err(t.as_str().to_owned()),
        other => panic!("an answer: {other:?}"),
    }
}

/// Each move-started entry: (entry, intent) -> (body, seat, rank).
fn started(log: &[u8]) -> BTreeMap<(u64, Id), (Id, Id, u64)> {
    let mut out = BTreeMap::new();
    for r in recover(log)
        .unwrap()
        .records
        .into_iter()
        .filter(|r| !recorder::is_input(r))
    {
        for e in Part::read(&r).unwrap().effects {
            let Cause::Intent(id) = e.envelope.cause else {
                continue;
            };
            for ev in e.events.iter().flatten() {
                if ev.name.as_str() != MOVE_STARTED {
                    continue;
                }
                let f = &ev.fields;
                let Some(Value::Uint(rank)) = f.get(&6) else {
                    panic!("a sit's rank")
                };
                out.insert(
                    (e.envelope.sequence, id),
                    (read_id(&f[&1]).unwrap(), read_id(&f[&5]).unwrap(), *rank),
                );
            }
        }
    }
    out
}

/// A1, A2: 600 sends of the selector in one tick into 300 chairs, through the world's own path.
#[test]
fn a_burst_of_selector_sits_fills_every_chair_and_the_rest_end_none_free() {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.lockstep = true;
    cfg.bodies = Some(Box::new(bodies));
    let w = answers::start(
        lamps::World::build(0, 0, 0).replica,
        lamps::rules(),
        store.clone(),
        cfg,
    )
    .expect("the world starts");
    let ground = town().1;
    let mut rxs = Vec::new();
    for n in 1..=SENDS {
        let (reply, rx) = channel();
        w.events
            .send(Event::ArrivalAt {
                tick: 1,
                bytes: sit_any(body(n), ground),
                reply,
            })
            .unwrap();
        rxs.push((n, rx));
    }
    let (done, ran) = channel();
    w.events.send(Event::RunTo { tick: 200, done }).unwrap();
    ran.recv().unwrap();
    let answers: Vec<(u64, Answered)> = rxs.iter().map(|(n, rx)| (*n, answer(rx))).collect();
    w.stop();

    let mut ends: BTreeMap<String, u64> = BTreeMap::new();
    for (_, a) in &answers {
        let k = match a {
            Ok(_) => "seated".to_owned(),
            Err(r) => r.clone(),
        };
        *ends.entry(k).or_default() += 1;
    }
    println!("600 sends into 300 chairs, one tick: {ends:?}");
    assert_eq!(
        ends,
        BTreeMap::from([
            ("seat.none-free".to_owned(), 300),
            ("seated".to_owned(), 300)
        ]),
        "every chair filled, the rest refused by name"
    );

    // Each receipt names its move-started entry, and that entry names the seat bound and the rank.
    let log = started(&store.0.lock().unwrap().bytes);
    let mut seats = BTreeSet::new();
    for (n, a) in &answers {
        let Ok((id, entries)) = a else { continue };
        let (&(_, _), &(b, seat, rank)) = log
            .iter()
            .find(|((e, i), _)| i == id && entries.contains(e))
            .expect("the receipt names the move-started entry");
        assert_eq!(b, body(*n));
        assert_eq!(rank, 0, "the selector is the act's first candidate");
        assert_eq!(seat, chair(*n), "the nearest free chair: its own");
        assert!(seats.insert(seat), "no chair bound twice");
    }
    assert_eq!(seats.len() as u64, CHAIRS);
}
