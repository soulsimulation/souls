//! Gaze and voice (Engine v2 B11, #2742): in a hall of 1,000 one Soul speaks, and the hearers recorded are exactly the
//! Souls whose interest set holds the speaker at that instant, the same on two runs and on replay; one body walks,
//! holds something and speaks at once.

use std::collections::{BTreeMap, BTreeSet};

use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::encode::{Name, decode, encode};
use replica::ids::{Id, Scope};
use replica::pose::{Frame, Mode, Quat, Vec3};
use replica::speech::{Said, length_of};
use replica::time::Micros;
use replica::world_model::{Audience, show};
use sim::controller::{Controller, Gaze, Line, Part};
use sim::ground::Piece;
use sim::index::place_of;
use sim::mover::Surface;
use sim::speech::{ENTER, Hearing, LEAVE, said};

fn id(scope: u8, n: u64) -> Id {
    Id::new(Scope([scope; 16]), n).expect("an id")
}

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn floor() -> Id {
    id(0xf1, 1)
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

fn shape(n: &str, want: Want) -> SkillShape {
    SkillShape {
        name: name(n),
        claims: vec![want],
        blocks: vec![],
        cancelled_by: vec![],
    }
}

/// A flat hall, 80 m square, centred on the origin (mm).
fn hall() -> Surface {
    let (a, b) = (-40_000, 40_000);
    let corners = vec![[a, 0, a], [b, 0, a], [b, 0, b], [a, 0, b]];
    Surface::new(
        floor(),
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
        }],
    )
}

/// SplitMix64, seeded: the same numbers on every run.
struct Draw(u64);

impl Draw {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A whole number in `-r..=r`.
    fn within(&mut self, r: i64) -> i64 {
        (self.next() % (2 * r as u64 + 1)) as i64 - r
    }
}

/// R4's interest rule worked out the slow way, every Soul against every body: the oracle.
fn naive(c: &Controller, before: &BTreeMap<Id, BTreeSet<Id>>) -> BTreeMap<Id, BTreeSet<Id>> {
    let at: Vec<(Id, Id, [i64; 2])> = c
        .bodies()
        .map(|b| {
            let (n, p) = place_of(b);
            (b.id, n, p)
        })
        .collect();
    let mut out = BTreeMap::new();
    for &(me, node, p) in &at {
        let old = before.get(&me);
        let set = at
            .iter()
            .filter(|&&(_, n, _)| n == node)
            .filter_map(|&(b, _, q)| {
                let d2 = i128::from(p[0] - q[0]).pow(2) + i128::from(p[1] - q[1]).pow(2);
                let d = d2.isqrt() as i64;
                (d < LEAVE && (d < ENTER || old.is_some_and(|o| o.contains(&b)))).then_some(b)
            })
            .collect();
        out.insert(me, set);
    }
    out
}

struct Run {
    /// The utterance's event as written, its bytes.
    bytes: Vec<u8>,
    said: Said,
    /// The oracle's answer: every Soul whose set holds the speaker.
    held: BTreeSet<Id>,
    /// Hearers between ENTER and LEAVE: in only because they were near before.
    band: usize,
}

const N: u64 = 1_000;
const DT: Micros = 100_000;
const WORDS: &str = "good evening, everyone";

/// A hall of 1,000 Souls on a jittered grid 2 m apart; one in five walks for 2.5 s; then Soul 500 speaks.
fn hall_run() -> Run {
    let surfaces = BTreeMap::from([(floor(), hall())]);
    let ground = &surfaces[&floor()];
    let mut c = Controller::new();
    let mut d = Draw(2742);
    let frame = Frame {
        node: floor(),
        slot: None,
    };
    for i in 0..N {
        let (gx, gz) = ((i % 32) as i64, (i / 32) as i64);
        let x = (gx - 16) * 2_000_000 + d.within(400_000);
        let z = (gz - 16) * 2_000_000 + d.within(400_000);
        let b = ground
            .place(id(0xb0, i + 1), frame, Vec3::new(x, 0, z), Quat::IDENTITY)
            .expect("placed");
        c.add(humanoid(), b).expect("added");
    }
    let walk = shape("souls:walk", Want::All(Class::Locomotion));
    for i in (0..N).step_by(5) {
        let body = id(0xb0, i + 1);
        let w = c.claim(body, &walk).expect("a walk driver");
        let v = Vec3::new(d.within(1_200_000), 0, d.within(1_200_000));
        c.set(body, w, Part::Velocity(v, Mode::Surface))
            .expect("walks");
    }
    let mut hearing = Hearing::new();
    let mut oracle = BTreeMap::new();
    let mut at = 0;
    let ids: Vec<Id> = c.bodies().map(|b| b.id).collect();
    for _ in 0..25 {
        let out = c.step(&surfaces, DT, at);
        assert!(out.refused.is_empty(), "{:?}", out.refused);
        hearing.update(c.near(), ids.iter().copied());
        oracle = naive(&c, &oracle);
        at += DT;
    }
    for &b in &ids {
        assert_eq!(hearing.set(b), oracle.get(&b), "{b:?}'s interest set");
        let held: BTreeSet<Id> = ids
            .iter()
            .filter(|o| oracle[o].contains(&b))
            .copied()
            .collect();
        assert_eq!(hearing.holders(c.near(), b), held, "who holds {b:?}");
    }

    let speaker = id(0xb0, 501);
    let v = c
        .claim(speaker, &shape("souls:talk", Want::One(Class::Voice)))
        .expect("a voice driver");
    let line = Line {
        words: id(0xcc, 1),
        length: length_of(WORDS),
        replace: false,
    };
    c.say(speaker, v, line.clone()).expect("says");
    let out = c.step(&surfaces, DT, at);
    hearing.update(c.near(), ids.iter().copied());
    oracle = naive(&c, &oracle);
    assert_eq!(out.said.len(), 1);
    let (who, started, ends) = &out.said[0];
    assert_eq!((*who, started, *ends), (speaker, &line, at + line.length));
    let s = said(&hearing, c.near(), speaker, started);
    let held: BTreeSet<Id> = oracle
        .iter()
        .filter(|(_, set)| set.contains(&speaker))
        .map(|(b, _)| *b)
        .collect();
    let (_, p) = place_of(c.body(speaker).expect("the speaker"));
    let band = s
        .hearers
        .iter()
        .filter(|h| {
            let (_, q) = place_of(c.body(**h).expect("a hearer"));
            let d = (i128::from(p[0] - q[0]).pow(2) + i128::from(p[1] - q[1]).pow(2)).isqrt();
            d >= i128::from(ENTER)
        })
        .count();
    Run {
        bytes: encode(&s.event().to_value()).expect("encodes"),
        said: s,
        held,
        band,
    }
}

#[test]
fn a1_a2_a5_the_hearers_recorded_are_the_souls_whose_interest_set_holds_the_speaker() {
    let one = hall_run();
    println!(
        "A1: {} Souls; {} hearers recorded, {} Souls' interest sets hold the speaker, {} extra, {} missing; {} heard \
         only because they were near before (between {} and {} mm)",
        N,
        one.said.hearers.len(),
        one.held.len(),
        one.said.hearers.difference(&one.held).count(),
        one.held.difference(&one.said.hearers).count(),
        one.band,
        ENTER / 1_000,
        LEAVE / 1_000,
    );
    assert_eq!(one.said.hearers, one.held);
    assert!(one.held.len() > 3, "a crowd hears");

    // A2: a second run writes the same bytes; a replay reads the hearers from the record and works nothing out.
    let two = hall_run();
    assert_eq!(one.bytes, two.bytes);
    let replayed = Said::read(
        &decode(&one.bytes).expect("decodes").value,
        Audience::Everyone,
    )
    .expect("an utterance");
    println!(
        "A2: run 1 and run 2 write the same {} bytes; the replay reads {} hearers, the same set",
        one.bytes.len(),
        replayed.hearers.len()
    );
    assert_eq!(replayed, one.said);

    // A5: reach and audience are two fields, and ordinary talk is public.
    println!(
        "A5: reach {} mm (field 2), audience {:?} (the entry's)",
        one.said.reach_mm, one.said.audience
    );
    assert_eq!(one.said.audience, Audience::Everyone);
    assert_eq!(one.said.reach_mm, (LEAVE / 1_000) as u64);
}

#[test]
fn a3_one_body_walks_holds_something_and_speaks_at_once() {
    let surfaces = BTreeMap::from([(floor(), hall())]);
    let ground = &surfaces[&floor()];
    let mut c = Controller::new();
    let body = id(0xb0, 1);
    let frame = Frame {
        node: floor(),
        slot: None,
    };
    let b = ground
        .place(body, frame, Vec3::ZERO, Quat::IDENTITY)
        .expect("placed");
    c.add(humanoid(), b).expect("added");
    let walk = c
        .claim(body, &shape("souls:walk", Want::All(Class::Locomotion)))
        .expect("walk");
    let hand = c
        .claim(body, &shape("souls:carry", Want::One(Class::Manipulator)))
        .expect("carry");
    let voice = c
        .claim(body, &shape("souls:talk", Want::One(Class::Voice)))
        .expect("talk");
    let eyes = c
        .claim(body, &shape("souls:look", Want::One(Class::Gaze)))
        .expect("look");
    c.set(
        body,
        walk,
        Part::Velocity(Vec3::new(1_000_000, 0, 0), Mode::Surface),
    )
    .expect("walks");
    c.set(
        body,
        hand,
        Part::Move(name("souls:hand-left"), Some(name("souls:hold"))),
    )
    .expect("holds");
    c.set(
        body,
        eyes,
        Part::Gaze(Gaze::Point(Vec3::new(3_000_000, 1_600_000, 0))),
    )
    .expect("looks");
    // The voice is the voice driver's alone: the walk may not speak, nor the voice look.
    let line = |n, replace| Line {
        words: id(0xcc, n),
        length: length_of(WORDS),
        replace,
    };
    assert_eq!(
        c.say(body, walk, line(1, false)).map_err(|r| r.name),
        Err("resource-not-held")
    );
    assert_eq!(
        c.set(body, voice, Part::Gaze(Gaze::Ahead))
            .map_err(|r| r.name),
        Err("resource-not-held")
    );
    c.say(body, voice, line(1, false)).expect("speaks");
    c.say(body, voice, line(2, false)).expect("waits behind");

    let mut at = 0;
    let mut said = Vec::new();
    for _ in 0..20 {
        let out = c.step(&surfaces, DT, at);
        assert!(out.refused.is_empty(), "{:?}", out.refused);
        said.extend(out.said.into_iter().map(|(_, l, _)| (at, show(l.words))));
        at += DT;
    }
    let moved = c.body(body).expect("the body").pose.position;
    let input = c.input(body).expect("its input");
    println!(
        "A3: after {} ms the body has walked {} mm, its left hand's move is {:?}, it looks at {:?}, and it has said \
         {:?} (start µs, words)",
        at / 1_000,
        moved.x / 1_000,
        input.moves.get(&name("souls:hand-left")).map(Name::as_str),
        input.gaze,
        said
    );
    assert!(moved.x >= 1_900_000, "walked");
    assert_eq!(
        input.moves.get(&name("souls:hand-left")),
        Some(&name("souls:hold"))
    );
    assert_eq!(input.gaze, Gaze::Point(Vec3::new(3_000_000, 1_600_000, 0)));
    assert_eq!(
        said,
        vec![
            (0, show(id(0xcc, 1))),
            (length_of(WORDS) / DT * DT + DT, show(id(0xcc, 2)))
        ]
    );
    // The gaze is logged when it changes, in the input's record (field 8).
    assert!(c.log().iter().any(|l| {
        matches!(decode(&l.bytes).expect("decodes").value, replica::encode::Value::Map(ref m) if m.contains_key(&8))
    }));
    // `replace` ends the utterance under way: the new one starts on the next step.
    c.say(body, voice, line(3, true)).expect("replaces");
    let out = c.step(&surfaces, DT, at);
    assert_eq!(
        out.said.iter().map(|(_, l, _)| l.words).collect::<Vec<_>>(),
        vec![id(0xcc, 3)]
    );
}

#[test]
fn a_body_in_a_slot_speaks_its_lines_in_turn_and_its_voice_is_found() {
    // B3 meets B11: a body handed into a slot is not stepped each tick, yet its voice must still end each utterance
    // and start the next, and `saying` must find it there.
    let surfaces = BTreeMap::from([(floor(), hall())]);
    let ground = &surfaces[&floor()];
    let mut c = Controller::new();
    let body = id(0xb0, 2);
    let on_floor = Frame {
        node: floor(),
        slot: None,
    };
    let b = ground
        .place(body, on_floor, Vec3::ZERO, Quat::IDENTITY)
        .expect("placed");
    c.add(humanoid(), b).expect("added");
    let held = c
        .claim(body, &shape("souls:seated", Want::All(Class::Locomotion)))
        .expect("the legs");
    let in_slot = Frame {
        node: id(0xd0, 1),
        slot: Some(1),
    };
    c.slot_in(body, held, in_slot, 0).expect("into the slot");
    let voice = c
        .claim(body, &shape("souls:talk", Want::One(Class::Voice)))
        .expect("talk");
    let line = |n| Line {
        words: id(0xcc, n),
        length: length_of(WORDS),
        replace: false,
    };
    c.say(body, voice, line(1)).expect("speaks");
    c.say(body, voice, line(2)).expect("waits behind");

    let mut at = 0;
    let mut said = Vec::new();
    let mut found = Vec::new();
    for _ in 0..40 {
        let out = c.step(&surfaces, DT, at);
        assert!(out.refused.is_empty(), "{:?}", out.refused);
        said.extend(out.said.into_iter().map(|(_, l, _)| (at, show(l.words))));
        found.push(c.saying(body).map(|(l, _)| l.words));
        at += DT;
    }
    println!("in a slot: said {said:?} (start µs, words)");
    assert_eq!(
        said,
        vec![
            (0, show(id(0xcc, 1))),
            (length_of(WORDS) / DT * DT + DT, show(id(0xcc, 2)))
        ],
        "both lines, the second after the first ends"
    );
    assert_eq!(
        found[0],
        Some(id(0xcc, 1)),
        "saying() finds a body in a slot"
    );
    assert!(
        found.contains(&Some(id(0xcc, 2))),
        "the second line is carried too"
    );
}
