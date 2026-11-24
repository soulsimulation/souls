//! Engine v2 C7 (#3393): seated and lying Souls hear in the running tick. A body in a seat's or a bed's slot rests
//! outside the bodies the controller steps; the world's tick still resolves its hearing with every other body's. A
//! seated Soul and a lying one 2 m and 3 m from a speaker are recorded as its hearers (A1), and a lecture of one
//! standing speaker and 20 seated listeners records all 20 (A2).
//! `cargo test -p worldd --test heard_seated -- --nocapture` prints the numbers.

use std::collections::{BTreeMap, BTreeSet};

use import_eden::Import;
use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::effects::{Header, Refusal, fixture_bytes, schema_hash};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::moves::Place;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::speech::{Reach, length_of};
use sim::controller::{Line, Stance};
use sim::links::Doors;
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use worldd::bodies::{Bodies, Placed};

const CHAIR: &str = include_str!("../../replica/fixtures/seats/chair.diag");
/// A bed: its slot 450 mm above the floor, its stand point 300 mm in front of it.
const BED: &str = "{1: 1, 2: 450, 3: [0, 300]}";
const TICK: i64 = 50_000;

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn id(n: u64) -> Id {
    Id::new(Scope([0xc7; 16]), n).unwrap()
}

fn speaker() -> Id {
    id(1)
}

/// Listener `i`'s body, and the seat it rests in.
fn listener(i: u64) -> Id {
    id(100 + i)
}

fn seat(i: u64) -> Id {
    id(1_000 + i)
}

/// Two legs and a voice.
fn humanoid() -> Family {
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
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c7-test/1").to_bytes()),
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

/// The speaker stands on the open ground west of the square; each listener `(i, offset, stance, place)` is placed at
/// `offset` (µm) from it and handed into its own seat, as a restart seats a body the log had in a slot (K18c).
fn hall(listeners: &[(u64, Vec3, Stance, &str)]) -> Result<Bodies, Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let at = Vec3::new(-40_000_000, 0, 30_000_000);
    let mut placements =
        vec![town.surfaces[&ground].place(speaker(), frame, at, Quat::IDENTITY)?];
    for (i, off, _, _) in listeners {
        let p = Vec3::new(at.x + off.x, 0, at.z + off.z);
        placements.push(town.surfaces[&ground].place(listener(*i), frame, p, Quat::IDENTITY)?);
    }
    let mut b = Bodies::new(town, TICK)?;
    for p in placements {
        b.add_body(humanoid(), p)?;
    }
    let mut placed = Placed::new();
    for (i, off, stance, place) in listeners {
        let place = Place::from_value(&decode(&fixture_bytes(place)?).unwrap().value)?;
        b.add_place(PlaceAt {
            thing: seat(*i),
            place,
            point: Vec3::new(at.x + off.x, 450_000, at.z + off.z + 300_000),
            facing: Quat::IDENTITY,
            floor: ground,
            more: Vec::new(),
        })?;
        let pose = Pose {
            frame: Frame {
                node: seat(*i),
                slot: None,
            },
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: Support::Slot,
        };
        placed.insert(listener(*i), (pose, Some(*stance)));
    }
    let refused = b.seat_placed(&placed, 0);
    assert!(refused.is_empty(), "every listener is seated: {refused:?}");
    let c = &b.runner.controller;
    for (i, _, _, _) in listeners {
        let pose = c.body(listener(*i)).expect("the listener").pose;
        assert_eq!(
            pose.support,
            Support::Slot,
            "listener {i} rests in its slot"
        );
    }
    Ok(b)
}

/// The world runs four ticks, so every interest set is worked out and the bodies are settled where they are; then
/// the speaker starts an utterance, and the world runs four more. The hearers of each utterance, by speaker.
fn heard(b: &mut Bodies) -> Result<Vec<(Id, BTreeSet<Id>)>, Refusal> {
    b.begin(0);
    b.step(4 * TICK);
    let talk = SkillShape {
        name: name("c7:talk"),
        claims: vec![Want::One(Class::Voice)],
        blocks: Vec::new(),
        cancelled_by: Vec::new(),
    };
    let c = &mut b.runner.controller;
    let voice = c.claim(speaker(), &talk)?;
    c.say(
        speaker(),
        voice,
        Line {
            words: id(9_999),
            length: length_of("good evening"),
            reach: Reach::Talk,
            replace: false,
        },
    )?;
    b.step(8 * TICK);
    Ok(b.heard
        .iter()
        .map(|(s, said, _)| (*s, said.hearers.clone()))
        .collect())
}

#[test]
fn a1_a_seated_and_a_lying_soul_hear_a_speaker_beside_them() {
    let mut b = hall(&[
        (1, Vec3::new(0, 0, 2_000_000), Stance::Sit, CHAIR),
        (2, Vec3::new(3_000_000, 0, 0), Stance::Lie, BED),
    ])
    .expect("the hall");
    let said = heard(&mut b).expect("the talk");
    println!(
        "A1: utterances {}; hearers {} (the speaker, the seated Soul, the lying one)",
        said.len(),
        said.first().map_or(0, |s| s.1.len())
    );
    assert_eq!(said.len(), 1, "A1: one utterance");
    assert_eq!(said[0].0, speaker());
    assert_eq!(
        said[0].1,
        BTreeSet::from([speaker(), listener(1), listener(2)]),
        "A1: the seated Soul 2 m away and the lying one 3 m away hear the speaker"
    );
}

#[test]
fn a2_a_lecture_of_twenty_seated_listeners_is_heard_by_all_twenty() {
    // Two rows of ten, 1 m and 2 m in front of the speaker, 50 cm apart: the farthest is 3.01 m from it.
    let rows: Vec<(u64, Vec3, Stance, &str)> = (0..20u64)
        .map(|i| {
            let x = (i % 10) as i64 * 500_000 - 2_250_000;
            let z = (1 + (i / 10) as i64) * 1_000_000;
            (i + 1, Vec3::new(x, 0, z), Stance::Sit, CHAIR)
        })
        .collect();
    let mut b = hall(&rows).expect("the lecture hall");
    let said = heard(&mut b).expect("the talk");
    let all: BTreeSet<Id> = (1..=20).map(listener).collect();
    println!(
        "A2: utterances {}; seated listeners recorded as hearers {} of 20",
        said.len(),
        said.first().map_or(0, |s| s.1.intersection(&all).count())
    );
    assert_eq!(said.len(), 1, "A2: one talk");
    let mut want = all;
    want.insert(speaker());
    assert_eq!(said[0].1, want, "A2: all 20 seated listeners hear the talk");
}
