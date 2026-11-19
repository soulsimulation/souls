//! A voice that carries as far as it should (Engine v2 E13, #2784): a whisper is heard by one named Soul and is in
//! no other view (A1); a shout by every Soul within its radius, larger than talk's (A2); a device by the Souls where
//! a receiver is on (A4); a Soul within talk's reach of two others hears both, one outside hears neither (A5). A call
//! (A3) is `sim::activity`'s test `a3_a_call_joins_two_souls_far_apart`. `cargo test -p sim --test reach --
//! --nocapture` prints each case's hearers.

use std::collections::{BTreeMap, BTreeSet};

use replica::audience::{TextStore, deliver, references};
use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::effects::{Header, Part, State, fixture_bytes};
use replica::encode::Name;
use replica::ids::{Id, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::speech::{Device, Radii, Reach, Receiver, SAID, Said, length_of};
use replica::time::Micros;
use replica::views::{Key, Level, Redactions, build, entry_part};
use replica::world_model::{Audience, show};
use sim::controller::{Controller, Driver, Line};
use sim::ground::Piece;
use sim::index::place_of;
use sim::mover::Surface;
use sim::speech::{Carriers, Hearing, LEAVE, heard_by};

const HEADER: &str = include_str!("../../replica/fixtures/audience/header.diag");
const LOG: &str = include_str!("../../replica/fixtures/audience/log.diag");
const DT: Micros = 100_000;
const WHISPER: &str = "meet me by the gate";

fn id(scope: u8, n: u64) -> Id {
    Id::new(Scope([scope; 16]), n).expect("an id")
}

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn floor(n: u64) -> Id {
    id(0xf1, n)
}

fn body(n: u64) -> Id {
    id(0xb0, n)
}

fn holds(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

/// Two legs, two hands, eyes, a voice (T9's fixture `souls:humanoid`).
fn humanoid() -> Family {
    use Class::*;
    let r = |n: &str, class, slot| Resource {
        name: name(n),
        class,
        slot,
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![
            r("souls:leg-left", Locomotion, None),
            r("souls:leg-right", Locomotion, None),
            r("souls:hand-left", Manipulator, Some(1)),
            r("souls:hand-right", Manipulator, Some(2)),
            r("souls:eyes", Gaze, None),
            r("souls:voice", Voice, None),
        ],
    }
}

/// A flat hall, 80 m square, centred on the origin (mm).
fn hall(id: Id) -> Surface {
    let (a, b) = (-40_000, 40_000);
    let corners = vec![[a, 0, a], [b, 0, a], [b, 0, b], [a, 0, b]];
    Surface::new(
        id,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: sim::gaits::Ground::Dry,
        }],
    )
}

/// Bodies on floors, a voice each, and the world's interest sets.
struct Scene {
    c: Controller,
    surfaces: BTreeMap<Id, Surface>,
    hearing: Hearing,
    voices: BTreeMap<Id, Driver>,
    at: Micros,
}

/// `bodies` are (floor, body, x µm, z µm).
fn scene(bodies: &[(u64, Id, i64, i64)]) -> Scene {
    let surfaces: BTreeMap<Id, Surface> = bodies
        .iter()
        .map(|b| (floor(b.0), hall(floor(b.0))))
        .collect();
    let mut c = Controller::new();
    let talk = SkillShape {
        name: name("souls:talk"),
        claims: vec![Want::One(Class::Voice)],
        blocks: vec![],
        cancelled_by: vec![],
    };
    let mut voices = BTreeMap::new();
    for &(f, b, x, z) in bodies {
        let frame = Frame {
            node: floor(f),
            slot: None,
        };
        let placed = surfaces[&floor(f)]
            .place(b, frame, Vec3::new(x, 0, z), Quat::IDENTITY)
            .expect("placed");
        c.add(humanoid(), placed).expect("added");
        voices.insert(b, c.claim(b, &talk).expect("a voice"));
    }
    let mut hearing = Hearing::new();
    hearing.update(c.near(), bodies.iter().map(|b| b.1));
    Scene {
        c,
        surfaces,
        hearing,
        voices,
        at: 0,
    }
}

fn no_members(_: Id) -> Vec<Id> {
    Vec::new()
}

impl Scene {
    /// `speaker` says words `n` with `reach`; the world's tick resolves it against `radii` and `devices`.
    fn say(
        &mut self,
        speaker: Id,
        n: u64,
        reach: Reach,
        radii: Radii,
        devices: &BTreeMap<Id, Device>,
    ) -> Said {
        let line = Line {
            words: id(0xcc, n),
            length: length_of(WHISPER),
            replace: true,
            reach,
        };
        self.c
            .say(speaker, self.voices[&speaker], line)
            .expect("says");
        let out = self.c.step(&self.surfaces, DT, self.at);
        self.at += DT;
        let carriers = Carriers {
            radii,
            members: &no_members,
            devices,
        };
        let bodies: Vec<Id> = self.c.bodies().map(|b| b.id).collect();
        let mut said = heard_by(
            &mut self.hearing,
            self.c.near(),
            &carriers,
            bodies,
            &out.said,
        );
        assert_eq!(said.len(), 1, "one utterance started");
        said.remove(0).1
    }
}

fn shown(s: &BTreeSet<Id>) -> Vec<String> {
    s.iter().map(|b| show(*b)).collect()
}

#[test]
fn a1_a_whisper_reaches_one_named_soul_and_is_in_no_other_view() {
    let (speaker, listener, beside, across) = (body(1), body(2), body(3), body(4));
    let mut s = scene(&[
        (1, speaker, 0, 0),
        (1, listener, 600_000, 0),
        (1, beside, 0, 900_000),
        (1, across, 3_000_000, 0),
    ]);
    let soul = id(0xdd, 101);
    let none = BTreeMap::new();
    let whisper = Reach::Whisper {
        body: listener,
        soul,
    };
    let w = s.say(speaker, 9, whisper, Radii::default(), &none);
    let talk = s.say(speaker, 10, Reach::Talk, Radii::default(), &none);
    let too_far = Reach::Whisper { body: across, soul };
    let far = s.say(speaker, 11, too_far, Radii::default(), &none);
    println!(
        "A1: a whisper to {} heard by {:?}, audience of one {}, reach {} mm; talk from the same spot heard by {:?}; a \
         whisper to {} (3 m off, beyond arm's length) heard by {:?}",
        show(listener),
        shown(&w.hearers),
        show(soul),
        w.reach_mm,
        shown(&talk.hearers),
        show(across),
        shown(&far.hearers)
    );
    assert_eq!(w.hearers, BTreeSet::from([listener]));
    assert_eq!(w.audience, Audience::Of(soul));
    assert!(talk.hearers.contains(&beside) && talk.hearers.contains(&across));
    assert!(far.hearers.is_empty());

    // In the log: T8's fixture whispers to Soul 101 at seq 8. That entry carries the record the world wrote; views of
    // the room for every other audience neither hold its event's reference nor deliver its words.
    let header = Header::read(&fixture_bytes(HEADER).expect("bytes")).expect("a header");
    let start = State::start(header.zone, header.kinds[0].clone());
    let mut part = Part::read(&fixture_bytes(LOG).expect("bytes")).expect("a part");
    let entry = part
        .effects
        .iter_mut()
        .find(|e| e.envelope.sequence == 8)
        .expect("seq 8");
    assert_eq!(entry.envelope.audience, w.audience, "the whisper's own");
    entry.events = Some(vec![w.event()]);
    let mut end = start.clone();
    for e in &part.effects {
        end.apply(&header, &entry_part(&header, e).expect("a part"))
            .expect("applies");
    }
    let audiences = [
        Audience::Everyone,
        Audience::Of(soul),
        Audience::Of(id(0xdd, 100)),
        Audience::Of(id(0x77, 1)),
        Audience::Of(id(0x88, 1)),
    ];
    let keys: Vec<Key> = audiences
        .iter()
        .flat_map(|a| {
            [Level::Full, Level::Sampled].map(|level| Key {
                node: id(0xee, 1),
                level,
                audience: *a,
            })
        })
        .collect();
    let mut words = TextStore::default();
    words.keep(w.words, w.audience, WHISPER);
    let none = Redactions::default();
    let views = build(&start, &header, std::slice::from_ref(&part), &keys, &none).expect("views");
    let mut holding: Vec<Audience> = Vec::new();
    for v in &views {
        let bytes = deliver(v, &words, &none, &end).expect("delivered");
        let has = references(&v.to_value()).contains(&w.words);
        assert_eq!(has, holds(&bytes, WHISPER), "{:?}", v.key);
        if has {
            assert!(holds(&bytes, SAID));
            holding.push(v.key.audience);
        }
    }
    println!(
        "A1: of {} views of the room ({} audiences, full and sampled), the whisper's event and words are in {} \
         ({}'s, full and sampled)",
        views.len(),
        audiences.len(),
        holding.len(),
        show(soul)
    );
    assert_eq!(holding, vec![Audience::Of(soul); 2]);
}

/// A hall of 1,000 Souls on a grid 2 m apart: (floor, body, x, z).
fn crowd() -> Vec<(u64, Id, i64, i64)> {
    (0..1_000u64)
        .map(|i| {
            let (gx, gz) = ((i % 32) as i64, (i / 32) as i64);
            (1, body(i + 1), (gx - 16) * 2_000_000, (gz - 16) * 2_000_000)
        })
        .collect()
}

#[test]
fn a2_a_shout_reaches_every_soul_within_its_radius_larger_than_talks() {
    let at = crowd();
    let mut s = scene(&at);
    let speaker = body(501);
    let (_, p) = place_of(s.c.body(speaker).expect("the speaker"));
    let within = |r: i64| -> BTreeSet<Id> {
        at.iter()
            .filter(|b| {
                let d2 = i128::from(b.2 - p[0]).pow(2) + i128::from(b.3 - p[1]).pow(2);
                d2 < i128::from(r).pow(2)
            })
            .map(|b| b.1)
            .collect()
    };
    let none = BTreeMap::new();
    let talk = s.say(speaker, 1, Reach::Talk, Radii::default(), &none);
    let shout = s.say(speaker, 2, Reach::Loud, Radii::default(), &none);
    let louder = Radii {
        loud: 20_000_000,
        ..Radii::default()
    };
    let wider = s.say(speaker, 3, Reach::Loud, louder, &none);
    println!(
        "A2: talk reaches {} mm and {} Souls; a shout {} mm and {} Souls (every Soul within it: {}); a world whose \
         shout carries {} mm, {} Souls",
        talk.reach_mm,
        talk.hearers.len(),
        shout.reach_mm,
        shout.hearers.len(),
        within(Radii::default().loud).len(),
        wider.reach_mm,
        wider.hearers.len()
    );
    assert!(Radii::default().loud > LEAVE);
    assert_eq!(shout.hearers, within(Radii::default().loud));
    assert_eq!(wider.hearers, within(louder.loud));
    assert!(talk.hearers.is_subset(&shout.hearers) && shout.hearers.len() > talk.hearers.len());
    assert_eq!(shout.audience, Audience::Everyone);
}

#[test]
fn a4_a_device_is_heard_exactly_where_a_receiver_is_on() {
    let (speaker, beside, near_on, far_on, near_off, away) =
        (body(1), body(2), body(3), body(4), body(5), body(6));
    let mut s = scene(&[
        (1, speaker, 0, 0),
        (1, beside, 2_000_000, 0),
        (1, away, 30_000_000, 0),
        (2, near_on, 2_000_000, 0),
        (2, far_on, 10_000_000, 0),
        (3, near_off, 1_000_000, 0),
    ]);
    let sender = id(0x5e, 1);
    let receiver = |n, node, on| Receiver {
        thing: id(0x5e, n),
        node,
        at: [0, 0],
        on,
        radius: 6_000_000,
    };
    let mut devices = BTreeMap::from([(
        sender,
        Device {
            sender,
            receivers: vec![receiver(2, floor(2), true), receiver(3, floor(3), false)],
        },
    )]);
    let r = Radii::default();
    let one = s.say(speaker, 1, Reach::Through(sender), r, &devices);
    devices.get_mut(&sender).expect("the link").receivers[1].on = true;
    let both = s.say(speaker, 2, Reach::Through(sender), r, &devices);
    devices.get_mut(&sender).expect("the link").receivers[0].radius = 12_000_000;
    let up = s.say(speaker, 3, Reach::Through(sender), r, &devices);
    println!(
        "A4: one receiver on: heard by {:?}; both on: {:?}; the first turned up to 12 m: {:?}",
        shown(&one.hearers),
        shown(&both.hearers),
        shown(&up.hearers)
    );
    assert_eq!(one.hearers, BTreeSet::from([speaker, beside, near_on]));
    assert_eq!(
        both.hearers,
        BTreeSet::from([speaker, beside, near_on, near_off])
    );
    assert_eq!(
        up.hearers,
        BTreeSet::from([speaker, beside, near_on, far_on, near_off])
    );
}

#[test]
fn a5_a_soul_within_talks_reach_of_two_others_hears_them_and_one_outside_does_not() {
    let (a, b, between, outside) = (body(1), body(2), body(3), body(4));
    let mut s = scene(&[
        (1, a, 0, 0),
        (1, b, 3_000_000, 0),
        (1, between, 1_500_000, 1_000_000),
        (1, outside, 1_500_000, 8_000_000),
    ]);
    let none = BTreeMap::new();
    let from_a = s.say(a, 1, Reach::Talk, Radii::default(), &none);
    let from_b = s.say(b, 2, Reach::Talk, Radii::default(), &none);
    println!(
        "A5: {} says, heard by {:?}; {} answers, heard by {:?}; {} listens in, {} (8 m off) hears neither",
        show(a),
        shown(&from_a.hearers),
        show(b),
        shown(&from_b.hearers),
        show(between),
        show(outside)
    );
    for said in [&from_a, &from_b] {
        assert!(said.hearers.contains(&between));
        assert!(!said.hearers.contains(&outside));
    }
    assert!(from_a.hearers.contains(&b) && from_b.hearers.contains(&a));
}
