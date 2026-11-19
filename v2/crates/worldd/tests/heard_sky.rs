//! Engine v2 C5 (#3369): hearing and the world's sky in the running tick. In K18's loop (lockstep), a Soul speaks and
//! the utterance's entry in the log names its hearers: the Soul beside it and itself, not the one 10 m away (A1). The
//! world node's light, day and weather are set at start and fired by the due list; a world stopped after its first
//! tick and started again 48 hours later writes the same log, byte for byte, as one stepped tick by tick (A2).
//! `cargo test -p worldd --test heard_sky -- --nocapture` prints the numbers.

use std::collections::{BTreeMap, BTreeSet};

use import_eden::Import;
use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::effects::{Effect, Header, Part, read_id, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::sky::{self, Calendar, DAY_US, days_from_civil};
use replica::speech::{SAID, length_of};
use sim::controller::Line;
use sim::daylight;
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::recorder;
use sim::walk::town::Town;
use worldd::answers::{self, Config, Event, Ran, World};
use worldd::bodies::{Bodies, Placed};
use worldd::checkers::toggles;

const LINEAGE: Scope = Scope([0xc5; 16]);

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

/// Two legs and a voice.
fn speaker() -> Family {
    let r = |n: &str, class| Resource {
        name: name(n),
        class,
        slot: None,
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![
            r("souls:leg-left", Class::Locomotion),
            r("souls:leg-right", Class::Locomotion),
            r("souls:voice", Class::Voice),
        ],
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
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c5-test/1").to_bytes()),
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

/// The lamps world's three bodies, which are nodes of its tree.
fn souls() -> Vec<Id> {
    toggles::World::build(1, 3, 0)
        .pairs
        .iter()
        .map(|p| p.0)
        .collect()
}

fn words() -> Id {
    Id::new(Scope([0xcc; 16]), 1).unwrap()
}

/// The three bodies on the ground: the first and second 2 m apart, the third 10 m from the first; the first is given
/// an utterance, which its voice starts at the first step.
fn bodies(placed: &Placed) -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let starts = [
        Vec3::new(-40_000_000, 0, 30_000_000),
        Vec3::new(-40_000_000, 0, 32_000_000),
        Vec3::new(-40_000_000, 0, 40_000_000),
    ];
    let mut placements = Vec::new();
    for (body, at) in souls().into_iter().zip(starts) {
        placements.push(town.surfaces[&ground].place(body, frame, at, Quat::IDENTITY)?);
    }
    let mut b = Bodies::new(town, 50_000)?;
    for p in placements {
        b.add_body_at(speaker(), p, placed)?;
    }
    let first = souls()[0];
    let talk = SkillShape {
        name: name("c5:talk"),
        claims: vec![Want::One(Class::Voice)],
        blocks: Vec::new(),
        cancelled_by: Vec::new(),
    };
    let c = &mut b.runner.controller;
    let voice = c.claim(first, &talk)?;
    c.say(
        first,
        voice,
        Line {
            words: words(),
            length: length_of("good evening"),
            replace: false,
        },
    )?;
    Ok(b)
}

fn run_to(w: &World, tick: i64) -> Ran {
    let (done, rx) = std::sync::mpsc::channel();
    w.events.send(Event::RunTo { tick, done }).unwrap();
    rx.recv().unwrap()
}

/// Every world entry the log holds, in order.
fn entries(log: &[u8]) -> Vec<Effect> {
    recover(log)
        .unwrap()
        .records
        .iter()
        .filter(|r| !recorder::is_input(r))
        .flat_map(|r| Part::read(r).unwrap().effects)
        .collect()
}

#[test]
fn a1_an_utterance_in_the_running_tick_records_its_hearers() {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.lockstep = true;
    cfg.bodies = Some(Box::new(bodies));
    let w = answers::start(
        toggles::World::build(1, 3, 0).replica,
        toggles::rules(),
        store.clone(),
        cfg,
    )
    .expect("the world starts");
    let end = run_to(&w, 10);
    w.stop();
    assert_eq!(end.faults, 0);
    let log = store.0.lock().unwrap().bytes.clone();
    let said: Vec<(Id, BTreeSet<Id>, Value)> = entries(&log)
        .iter()
        .flat_map(|e| {
            e.events
                .iter()
                .flatten()
                .filter(|v| v.name.as_str() == SAID)
                .map(|v| {
                    let hearers = match v.fields.get(&3) {
                        Some(Value::Array(a)) => a.iter().map(|h| read_id(h).unwrap()).collect(),
                        _ => BTreeSet::new(),
                    };
                    (e.envelope.node, hearers, v.fields[&1].clone())
                })
        })
        .collect();
    let s = souls();
    println!(
        "A1: utterances in the log: {}; hearers {:?}",
        said.len(),
        said.first().map(|x| &x.1)
    );
    assert_eq!(said.len(), 1, "A1: one utterance, written once");
    assert_eq!(said[0].0, s[0], "A1: written by the speaker's body");
    assert_eq!(
        said[0].1,
        BTreeSet::from([s[0], s[1]]),
        "A1: heard by the Soul 2 m away and the speaker, not the one 10 m away"
    );
    assert_eq!(
        said[0].2,
        Value::Map(BTreeMap::from([(21, words().to_value())])),
        "A1: its words by reference"
    );
}

const HOUR: i64 = 3_600_000_000;
/// 48 hours of one-second ticks.
const TWO_DAYS: i64 = 172_800;

/// Today's sky on a real-time calendar whose world time 0 is local midnight of 18 Nov 2026, five hours behind UTC.
fn sky() -> daylight::Config {
    let cal = Calendar {
        day_s: 86_400,
        origin: days_from_civil(2026, 11, 18) * DAY_US + 5 * HOUR,
        offsets: vec![(0, -5 * HOUR)],
    };
    daylight::Config::today(cal, 3369)
}

/// A world of the lamps' tree, no bodies, one-second ticks, its sky as [`sky`], in lockstep.
fn sky_world(store: Mem) -> World {
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.lockstep = true;
    cfg.tick = std::time::Duration::from_secs(1);
    cfg.views = true;
    cfg.sky = Some(sky());
    cfg.measures = false;
    answers::start(
        toggles::World::build(1, 3, 0).replica,
        toggles::rules(),
        store,
        cfg,
    )
    .expect("the world starts")
}

/// The named events of the world's entries, with their world times.
fn events(log: &[u8]) -> Vec<(i64, String, BTreeMap<u64, Value>)> {
    entries(log)
        .iter()
        .flat_map(|e| {
            e.events
                .iter()
                .flatten()
                .map(move |v| (e.envelope.at, v.name.as_str().to_owned(), v.fields.clone()))
        })
        .collect()
}

#[test]
fn a2_the_sky_in_the_running_tick_and_a_48_hour_jump_writes_what_stepping_writes() {
    // Stepped: the caller moves the clock one tick at a time through 48 hours.
    let stepped = Mem::with(Vec::new());
    let w = sky_world(stepped.clone());
    for n in 0..=TWO_DAYS {
        run_to(&w, n);
    }
    let tier = w.tier.as_ref().map(|t| t.stats()).expect("the view tier");
    w.stop();
    let stepped = stepped.0.lock().unwrap().bytes.clone();

    // Jumped: the world starts, stops after its first tick, and is started again from its log 48 hours later; the
    // ticks it owes run back to back.
    let jumped = Mem::with(Vec::new());
    let w = sky_world(jumped.clone());
    run_to(&w, 0);
    w.stop();
    let first = jumped.0.lock().unwrap().bytes.clone();
    let jumped = Mem::with(first);
    let w = sky_world(jumped.clone());
    let end = run_to(&w, TWO_DAYS);
    w.stop();
    let jumped = jumped.0.lock().unwrap().bytes.clone();

    let ev = events(&stepped);
    let light: Vec<(i64, Value)> = ev
        .iter()
        .filter(|e| e.0 > 0 && e.1 == sky::EV_LIGHT)
        .map(|e| (e.0, e.2[&1].clone()))
        .collect();
    let days = ev.iter().filter(|e| e.0 > 0 && e.1 == sky::EV_DAY).count();
    let weather = ev
        .iter()
        .filter(|e| e.0 > 0 && e.1 == sky::EV_WEATHER)
        .count();
    println!(
        "A2: 48 h: {} light, {days} new days, {weather} weather changes; tier ticks {}, fault {:?}; log {} bytes \
         stepped, {} jumped; end {end:?}",
        light.len(),
        tier.ticks,
        tier.fault,
        stepped.len(),
        jumped.len()
    );
    // The start: the first light, date and weather, on the world node at world time 0.
    let start: Vec<&str> = ev
        .iter()
        .filter(|e| e.0 == 0)
        .map(|e| e.1.as_str())
        .collect();
    assert_eq!(
        start,
        [sky::EV_LIGHT, sky::EV_DAY, sky::EV_WEATHER],
        "A2: set at start"
    );
    // Each change of light at its boundary, local 05:30, 07:00, 18:00, 19:30 and 21:00, on both days.
    let table = [
        (330, "dawn"),
        (420, "day"),
        (1080, "evening"),
        (1170, "dusk"),
        (1260, "night"),
    ];
    let want: Vec<(i64, Value)> = (0..2)
        .flat_map(|d| {
            table.map(|(m, n)| {
                (
                    d * 24 * HOUR + m * 60_000_000,
                    Value::Text(name(&format!("souls:{n}"))),
                )
            })
        })
        .collect();
    assert_eq!(light, want, "A2: fired by the due list at each boundary");
    assert_eq!(days, 2, "A2: a new day at each local midnight");
    assert!(weather > 0, "A2: the weather changes");
    assert!(
        tier.ticks > 0 && tier.fault.is_none(),
        "A2: the view tier read the ticks"
    );
    assert!(
        jumped == stepped,
        "A2: the 48-hour jump writes the same log as stepping tick by tick"
    );
}
