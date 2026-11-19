//! Engine v2 C5 (#3369): hearing and the world's sky in the running tick. In K18's loop (lockstep), a Soul speaks and
//! the utterance's entry in the log names its hearers: the Soul beside it and itself, not the one 10 m away (A1).

use std::collections::{BTreeMap, BTreeSet};

use import_eden::Import;
use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::effects::{Effect, Header, Part, read_id, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::speech::{SAID, length_of};
use sim::controller::Line;
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
            e.events.iter().flatten().filter(|v| v.name.as_str() == SAID).map(|v| {
                let hearers = match v.fields.get(&3) {
                    Some(Value::Array(a)) => a.iter().map(|h| read_id(h).unwrap()).collect(),
                    _ => BTreeSet::new(),
                };
                (e.envelope.node, hearers, v.fields[&1].clone())
            })
        })
        .collect();
    let s = souls();
    println!("A1: utterances in the log: {}; hearers {:?}", said.len(), said.first().map(|x| &x.1));
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
