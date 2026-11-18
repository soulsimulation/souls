//! Speech is heard in a running world (Engine v2 #3231): a hall of 1,000 Souls, each followed by its own subscription;
//! one in five walks; for 25 ticks eight Souls a tick start to speak. Each tick runs as the world's tick does: the
//! controller's step, `sim::speech::heard` (the interest sets brought up to date, each started utterance's record),
//! the utterance entries written in the tick's part with the motion samples, and the view tier's hub reading the part.
//! Every utterance's recorded hearers are B11's brute-force rule's, and every subscription is addressed exactly the
//! utterances whose hearers hold its Soul (A2). The world's own loop (K18) calls the same step.
//! Run with `cargo test -p worldd --test hearing -- --nocapture` to see the numbers.

use std::collections::{BTreeMap, BTreeSet};

use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope};
use replica::pose::{Frame, Mode, Quat, Vec3};
use replica::speech::length_of;
use replica::time::Micros;
use replica::views::Level;
use replica::world_model::Audience;
use sim::controller::{Controller, Line, Part as InputPart};
use sim::ground::Piece;
use sim::index::place_of;
use sim::mover::Surface;
use sim::speech::{ENTER, Hearing, LEAVE, entry, heard};
use worldd::views::subscription::{Hub, Kind, Request, Scope};

/// A pinned body kind, as a log names it.
const BODY: &str =
    "souls:body@1220ee1ad75a34f067112ef6d2a095fe5bd3e121a75611a1a95ba85198efcb131cb2";
const N: u64 = 1_000;
const TICKS: u64 = 25;
/// Souls that start to speak each tick.
const SPEAKERS: u64 = 8;
const DT: Micros = 50_000;

fn id(scope: u8, n: u64) -> Id {
    Id::new(IdScope([scope; 16]), n).expect("an id")
}

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn floor() -> Id {
    id(0xf1, 1)
}

fn soul(i: u64) -> Id {
    id(0xb0, i + 1)
}

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

/// SplitMix64, seeded.
struct Draw(u64);

impl Draw {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn within(&mut self, r: i64) -> i64 {
        (self.next() % (2 * r as u64 + 1)) as i64 - r
    }
}

/// B11's brute-force rule: R4's interest rule worked out every Soul against every body.
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

/// A tick's entries as the log's part.
fn part(effects: &[Effect]) -> Part {
    let v = Value::Map(
        [
            (
                1,
                Value::Bytes(Hash::of(Purpose::Fixture, b"hearing").to_bytes()),
            ),
            (
                2,
                Value::Array(effects.iter().map(Effect::to_value).collect()),
            ),
        ]
        .into(),
    );
    Part::read(&encode(&v).expect("bytes")).expect("a part")
}

fn envelope(sequence: u64, at: Micros, node: Id) -> Envelope {
    Envelope {
        sequence,
        at,
        cause: Cause::World,
        actor: Actor::World,
        audience: Audience::Everyone,
        node,
    }
}

fn change(sequence: u64, at: Micros, node: Id, change: Change) -> Effect {
    Effect {
        envelope: envelope(sequence, at, node),
        body: Body::Changes(vec![ChangeRec {
            change,
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    }
}

/// The entry an addressed item carries.
fn carried(bytes: &[u8]) -> Vec<u8> {
    let Value::Map(m) = decode(bytes).expect("decodes").value else {
        panic!("an item is a map")
    };
    match m.get(&2) {
        Some(Value::Bytes(b)) => b.clone(),
        other => panic!("an addressed item carries bytes, not {other:?}"),
    }
}

#[test]
fn a2_every_hearer_is_addressed_the_utterance_and_no_one_else() {
    let surfaces = BTreeMap::from([(floor(), hall())]);
    let ground = &surfaces[&floor()];
    let mut c = Controller::new();
    let mut d = Draw(3231);
    let frame = Frame {
        node: floor(),
        slot: None,
    };
    let (mut seq, mut at) = (0u64, 0);
    let mut start = Vec::new();
    for i in 0..N {
        let (gx, gz) = ((i % 32) as i64, (i / 32) as i64);
        let x = (gx - 16) * 2_000_000 + d.within(400_000);
        let z = (gz - 16) * 2_000_000 + d.within(400_000);
        let b = ground
            .place(soul(i), frame, Vec3::new(x, 0, z), Quat::IDENTITY)
            .expect("placed");
        seq += 1;
        start.push(change(
            seq,
            at,
            floor(),
            Change::Create {
                node: b.id,
                kind: name(BODY),
                pose: b.pose,
                audience: Audience::Everyone,
                fields: BTreeMap::new(),
            },
        ));
        c.add(humanoid(), b).expect("added");
    }
    let walk = shape("souls:walk", Want::All(Class::Locomotion));
    for i in (0..N).step_by(5) {
        let w = c.claim(soul(i), &walk).expect("a walk driver");
        let v = Vec3::new(d.within(1_400_000), 0, d.within(1_400_000));
        c.set(soul(i), w, InputPart::Velocity(v, Mode::Surface))
            .expect("walks");
    }
    let mut hub = Hub::new();
    hub.tick(&part(&start)).expect("the start");
    let subs: Vec<(Id, usize)> = (0..N)
        .map(|i| {
            let s = hub
                .subscribe(Request {
                    scopes: vec![Scope::Follow(soul(i))],
                    level: Level::Counts,
                    budget: 1_000_000,
                })
                .expect("subscribed");
            (soul(i), s)
        })
        .collect();

    let talk = shape("souls:talk", Want::One(Class::Voice));
    let ids: Vec<Id> = c.bodies().map(|b| b.id).collect();
    let mut hearing = Hearing::new();
    let mut oracle = BTreeMap::new();
    // Each utterance's entry bytes, and who should be addressed it by the brute-force rule.
    let mut due: BTreeMap<Vec<u8>, BTreeSet<Id>> = BTreeMap::new();
    let mut got: BTreeMap<Id, BTreeSet<Vec<u8>>> = BTreeMap::new();
    let mut said_n = 0usize;
    for t in 0..TICKS {
        // Eight Souls not yet heard from start to speak (389 is prime to 1,000: every Soul at most once).
        for k in 0..SPEAKERS {
            let who = soul((t * SPEAKERS + k) * 389 % N);
            let v = c.claim(who, &talk).expect("a voice driver");
            let line = Line {
                words: id(0xcc, t * SPEAKERS + k + 1),
                length: length_of("good evening, everyone"),
                replace: false,
            };
            c.say(who, v, line).expect("says");
        }
        let out = c.step(&surfaces, DT, at);
        assert!(out.refused.is_empty(), "{:?}", out.refused);
        let records = heard(&mut hearing, c.near(), ids.iter().copied(), &out.said);
        oracle = naive(&c, &oracle);
        assert_eq!(
            records.len(),
            SPEAKERS as usize,
            "tick {t}: every Soul asked starts"
        );
        let mut effects = Vec::new();
        for h in out.samples {
            seq += 1;
            effects.push(change(seq, at, h.node, Change::Motion(h)));
        }
        for (speaker, s) in &records {
            let held: BTreeSet<Id> = oracle
                .iter()
                .filter(|(_, set)| set.contains(speaker))
                .map(|(b, _)| *b)
                .collect();
            assert_eq!(s.hearers, held, "tick {t}: {speaker:?}'s hearers");
            seq += 1;
            let e = entry(envelope(seq, at, floor()), *speaker, s);
            due.insert(encode(&e.to_value()).expect("bytes"), held);
            effects.push(e);
            said_n += 1;
        }
        hub.tick(&part(&effects)).expect("a tick");
        for (soul, s) in &subs {
            for o in hub.drain(*s) {
                if o.kind == Kind::Addressed {
                    got.entry(*soul).or_default().insert(carried(&o.bytes));
                }
            }
        }
        at += DT;
    }

    // Every subscription was addressed exactly the utterances whose hearers hold its Soul.
    let mut deliveries = 0usize;
    let (mut wrong, mut missing) = (0usize, 0usize);
    for (soul, s) in &subs {
        let want: BTreeSet<Vec<u8>> = due
            .iter()
            .filter(|(_, held)| held.contains(soul))
            .map(|(b, _)| b.clone())
            .collect();
        let have = got.remove(soul).unwrap_or_default();
        wrong += have.difference(&want).count();
        missing += want.difference(&have).count();
        deliveries += have.len();
        let stats = hub.stats(*s).expect("its stats");
        assert_eq!(stats.addressed_in, stats.addressed_out, "all sent");
        assert_eq!(have, want, "{soul:?}'s utterances");
    }
    let expected: usize = due.values().map(BTreeSet::len).sum();
    println!(
        "A2: {N} Souls, {TICKS} ticks, {said_n} utterances; {expected} hearers by the brute-force rule, {deliveries} \
         addressed, {wrong} to a subscription not a hearer, {missing} missing"
    );
    assert_eq!(deliveries, expected);
    assert!(expected > said_n * 3, "a crowd hears");
}
