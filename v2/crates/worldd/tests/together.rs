//! 0.134 T1 (#3891), touch by offer and accept on a served world: three scripted Souls on the world's end of the
//! gateway's socket, on N2's test world, Souls 1 and 2 standing 0.6 m apart. The handshake is an activity kind whose
//! two roles each name content's `handshake` move (B2's, `content/moves/handshake.json`).
//!
//! - An accepted handshake writes both members' moves for viewers (`souls:form-move`), each aimed at the other, with
//!   their contact times within 50 ms of each other; when the moves are done the handshake ends, both leaving it.
//! - A declined offer, and one left to lapse, move nobody. An accept from 2.6 m away is refused `together.too-far`
//!   and leaves the offer open.
//! - 0.134 item 5: after one Soul walks up to another, content's handshake, hug, high-five and holding hands are each
//!   accepted (the reach read from the places the two will take, 0.135 G3), the two walk there and the moves play;
//!   from 5 m apart each is refused `together.too-far` and nobody moves.
//!
//! - 0.134 T2: holding hands (content's `hold_hand`, its last phase held) lasts while both stay. One leaving releases
//!   both holds, each written again ended `released`; a walk sent by either leaves the activity the same way.
//!
//! A third Soul's aim at a member (`target-outside-activity`) has no verb of its own at the gateway; it is
//! `sim`'s `activity::tests::together`. `cargo test -p worldd --test together -- --nocapture`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

use import_eden::Import;
use replica::activity::{ActivityKind, Role};
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource, Want};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, fixture_bytes,
    read_id, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Intent, Target};
use replica::moves::Place;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::{Value as Json, parse};
use replica::time::Micros;
use replica::tree::Rules as TreeRules;
use replica::world_model::{Audience, Kind};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use worldd::answers::{self, BODIES, Config};
use worldd::bodies::{Bodies, read_row};
use worldd::checkers::Rules;

const LINEAGE: Scope = Scope([0x71; 16]);
const PLACE: &str = "souls:place";
const WALKER: &str = "test:walker";
/// A handshake offered for a minute, and one that lapses in half a second.
const HANDSHAKE: &str = "test:handshake";
const BRIEF: &str = "test:brief_handshake";
/// Holding hands (0.134 T2): each role names content's `hold_hand`, whose last phase holds until released.
const HOLD: &str = "test:hold_hands";
/// Following (0.135 G2): no move; the giver's role follows.
/// Holding hands whose two roles stand shoulder to shoulder, 0.25 m either side, facing one way (0.135 G3).
fn hold_at() -> ActivityKind {
    let mut k = touch(HOLD_AT, 60_000_000, "souls:hold_hand");
    k.roles[0].stands = vec![(Vec3::new(-250_000, 0, 0), 0)];
    k.roles[1].stands = vec![(Vec3::new(250_000, 0, 0), 0)];
    k
}

/// Content's own touch `file` (`content/kinds/together/<file>.json`) as a test kind whose roles name move `mv`: the
/// giver stands where the entry's slot `one` stands a member, the taker at `other` (each slot's stand point, mm to
/// µm, with its facing), as `serve::activity_kinds` reads them (0.134 item 5).
fn content_touch(plain: &str, file: &str, mv: &str) -> ActivityKind {
    let path = format!(
        "{}/../../../content/kinds/together/{file}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let entry = parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    let int = |v: Option<&Json>| match v {
        Some(Json::Int(n)) => i64::try_from(*n).unwrap(),
        _ => 0,
    };
    let mut k = touch(plain, 60_000_000, mv);
    for (role, slot) in k.roles.iter_mut().zip(["one", "other"]) {
        let stand = entry
            .get("slots")
            .and_then(|s| s.get(slot))
            .and_then(|s| s.get("stand"))
            .and_then(Json::str)
            .unwrap();
        let p = entry.get("points").and_then(|ps| ps.get(stand)).unwrap();
        let a = p.get("at_mm").and_then(Json::arr).unwrap();
        let mm = |i: usize| int(a.get(i)) * 1000;
        role.stands = vec![(Vec3::new(mm(0), mm(1), mm(2)), int(p.get("yaw_mdeg")))];
    }
    k
}

/// A dance whose members stand in a ring of 1 m, facing its middle (0.135 G3): the first role's one place, then the
/// other role's seven.
fn dance_at() -> ActivityKind {
    let ring = |k: i64| {
        // At 45° steps from +z toward +x: whole-mm points, as the entry states them.
        let (s, c) = [
            (0, 1000),
            (707, 707),
            (1000, 0),
            (707, -707),
            (0, -1000),
            (-707, -707),
            (-1000, 0),
            (-707, 707),
        ][k as usize];
        (
            Vec3::new(s * 1000, 0, c * 1000),
            (k * 45_000 + 180_000) % 360_000,
        )
    };
    let mut k = ActivityKind {
        most: 8,
        beat: true,
        ..touch(DANCE_AT, 60_000_000, "souls:dance")
    };
    k.roles[0].stands = vec![ring(0)];
    k.roles[1].stands = (1..8).map(ring).collect();
    k
}

fn follow() -> ActivityKind {
    let mut k = touch(FOLLOW, 60_000_000, "souls:none");
    for r in &mut k.roles {
        r.mv = None;
    }
    k.follows = Some(name(GIVER));
    k
}

/// Dancing together (0.134 T3).
const DANCE: &str = "test:dance";
/// A hug and a high-five, as the handshake: each ends with its moves.
const HUG: &str = "test:hug";
const HIGH_FIVE: &str = "test:high_five";
/// Following (0.135 G2): the asker (the giver's role) follows the other.
const FOLLOW: &str = "test:follow";
/// Holding hands and a dance whose roles say where members stand (0.135 G3).
const HOLD_AT: &str = "test:hold_at";
const DANCE_AT: &str = "test:dance_at";
/// Content's handshake, hug, high-five and holding hands, standing where their entries place them (0.134 item 5).
const W_HANDSHAKE: &str = "test:w_handshake";
const W_HUG: &str = "test:w_hug";
const W_HIGH_FIVE: &str = "test:w_high_five";
const W_HOLD: &str = "test:w_hold_hands";
const GIVER: &str = "test:giver";
/// The greetings of #4454, #4459 and #4477, read from their entries (`tests/greetings/`): a one-off aimed move each.
const BOW: &str = "test:bow_to_each_other";
const NOD: &str = "test:nod_to_each_other";
const WAVE: &str = "test:wave_to_each_other";
const INTRO: &str = "test:speaker_introduction";
const TAKER: &str = "test:taker";

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn pinned(plain: &str, n: u8) -> String {
    format!("{plain}@1220{}{n:02x}", "00".repeat(31))
}

/// The kinds in pinned order: (plain name, full name).
fn kinds() -> Vec<(&'static str, String)> {
    vec![
        (PLACE, pinned(PLACE, 1)),
        (WALKER, pinned(WALKER, 2)),
        (HANDSHAKE, pinned(HANDSHAKE, 3)),
        (BRIEF, pinned(BRIEF, 4)),
        (HOLD, pinned(HOLD, 5)),
        (DANCE, pinned(DANCE, 6)),
        (HUG, pinned(HUG, 7)),
        (HIGH_FIVE, pinned(HIGH_FIVE, 8)),
        (FOLLOW, pinned(FOLLOW, 9)),
        (HOLD_AT, pinned(HOLD_AT, 10)),
        (DANCE_AT, pinned(DANCE_AT, 11)),
        (W_HANDSHAKE, pinned(W_HANDSHAKE, 12)),
        (W_HUG, pinned(W_HUG, 13)),
        (W_HIGH_FIVE, pinned(W_HIGH_FIVE, 14)),
        (W_HOLD, pinned(W_HOLD, 15)),
        (BOW, pinned(BOW, 16)),
        (NOD, pinned(NOD, 17)),
        (WAVE, pinned(WAVE, 18)),
        (INTRO, pinned(INTRO, 19)),
    ]
}

fn full(plain: &str) -> String {
    kinds().into_iter().find(|(p, _)| *p == plain).unwrap().1
}

/// A handshake's kind, as `serve::activity_kinds` reads an entry whose roles name the move: each role claims a hand
/// and names `souls:handshake`; its proposal lasts `lasts`.
fn handshake(plain: &str, lasts: Micros) -> ActivityKind {
    touch(plain, lasts, "souls:handshake")
}

/// A touch's kind whose two roles each claim a hand and name move `mv`.
fn touch(plain: &str, lasts: Micros, mv: &str) -> ActivityKind {
    let role = |r: &str| Role {
        name: name(r),
        place: name("souls:here"),
        claims: vec![Want::One(Class::Manipulator)],
        mv: Some(name(mv)),
        stands: Vec::new(),
        within: None,
        link: None,
    };
    ActivityKind {
        name: name(&full(plain)),
        revision: 1,
        roles: vec![role(GIVER), role(TAKER)],
        proposal_lasts: lasts,
        leave_within: 400_000,
        most: 2,
        beat: false,
        follows: None,
    }
}

/// The kind `serve::activity_kinds` reads from a greeting's entry `text`, named `plain`: each role claims a hand and
/// names its `move`, standing at its slot's stand point, walked there from within its `within_mm`.
fn greeting(plain: &str, text: &str) -> ActivityKind {
    let e = replica::rules::json::parse(text).unwrap();
    let mm = |v: Option<&Json>| match v {
        Some(Json::Int(n)) => i64::try_from(*n).unwrap() * 1000,
        other => panic!("a length: {other:?}"),
    };
    let roles = e
        .get("roles")
        .and_then(Json::obj)
        .unwrap()
        .iter()
        .map(|(role, v)| {
            let places = v.get("places").unwrap();
            let slot = places.get("slots").and_then(Json::arr).unwrap()[0]
                .str()
                .unwrap();
            let stand = e.get("slots").unwrap().get(slot).unwrap();
            let at = e
                .get("points")
                .unwrap()
                .get(stand.get("stand").and_then(Json::str).unwrap())
                .unwrap();
            let a = at.get("at_mm").and_then(Json::arr).unwrap();
            let yaw = match at.get("yaw_mdeg") {
                Some(Json::Int(n)) => i64::try_from(*n).unwrap(),
                _ => 0,
            };
            Role {
                name: name(&format!("eden:{role}")),
                place: name("souls:here"),
                claims: vec![Want::One(Class::Manipulator)],
                mv: Some(name(&format!(
                    "souls:{}",
                    v.get("move").and_then(Json::str).unwrap()
                ))),
                stands: vec![(Vec3::new(mm(a.first()), mm(a.get(1)), mm(a.get(2))), yaw)],
                within: Some(mm(places.get("within_mm"))),
                link: None,
            }
        })
        .collect();
    ActivityKind {
        name: name(&full(plain)),
        revision: 1,
        roles,
        proposal_lasts: 60_000_000,
        leave_within: 400_000,
        most: 2,
        beat: false,
        follows: None,
    }
}

fn greetings() -> Vec<ActivityKind> {
    vec![
        greeting(BOW, include_str!("greetings/bow_to_each_other.json")),
        greeting(NOD, include_str!("greetings/nod_to_each_other.json")),
        greeting(WAVE, include_str!("greetings/wave_to_each_other.json")),
        greeting(INTRO, include_str!("greetings/speaker_introduction.json")),
    ]
}

/// Dancing together (0.134 T3): content's `dance` on the world's beat, up to eight members.
fn dance() -> ActivityKind {
    ActivityKind {
        most: 8,
        beat: true,
        ..touch(DANCE, 60_000_000, "souls:dance")
    }
}

fn humanoid() -> Family {
    let r = |n: &str, class, slot| Resource {
        name: name(n),
        class,
        slot,
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![
            r("souls:leg-left", Class::Locomotion, None),
            r("souls:leg-right", Class::Locomotion, None),
            r("souls:hand-left", Class::Manipulator, Some(1)),
            r("souls:hand-right", Class::Manipulator, Some(2)),
            r("souls:voice", Class::Voice, None),
            r("souls:eyes", Class::Gaze, None),
        ],
    }
}

/// N2's test world as a town and its ground (the replica's zone is rooted at that ground).
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/t1-town/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(nodes["world"].scope().0.to_vec())),
        (4, nodes["world"].to_value()),
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

fn ground() -> Id {
    town().1
}

/// The three Souls' bodies (each Soul's id is its body's here).
fn soul(n: u64) -> Id {
    Id::new(Scope([0x7f; 16]), n).unwrap()
}

/// Where the bodies stand on the test world's open ground, west of the square, µm: Souls 1 and 2 0.6 m apart, as a
/// handshake's roles place them, and Soul 3 2 m on; Soul 4 a dancer 1.5 m north of them.
fn at(n: u64) -> Vec3 {
    let x = match n {
        1 => -40_000_000,
        2 => -40_600_000,
        4 => -41_600_000,
        _ => -42_600_000,
    };
    Vec3::new(x, 0, if n == 4 { 28_500_000 } else { 30_000_000 })
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/t1-together/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                kinds()
                    .into_iter()
                    .map(|(_, f)| Value::Text(name(&f)))
                    .collect(),
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).unwrap()).unwrap()
}

/// The world's rules (T2): the ground takes bodies and handshakes.
fn tree_rules() -> TreeRules {
    let k = |owner: &str, children: &[&str]| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: BTreeMap::new(),
        hands: None,
        fields: Default::default(),
    };
    TreeRules {
        kinds: BTreeMap::from([
            (
                full(PLACE),
                k(
                    "place",
                    &[
                        "body",
                        HANDSHAKE,
                        BRIEF,
                        HOLD,
                        DANCE,
                        HUG,
                        HIGH_FIVE,
                        FOLLOW,
                        HOLD_AT,
                        DANCE_AT,
                        W_HANDSHAKE,
                        W_HUG,
                        W_HIGH_FIVE,
                        W_HOLD,
                        BOW,
                        NOD,
                        WAVE,
                        INTRO,
                    ],
                ),
            ),
            (full(WALKER), k("family", &[])),
            (full(HANDSHAKE), k("activity", &[])),
            (full(BRIEF), k("activity", &[])),
            (full(HOLD), k("activity", &[])),
            (full(DANCE), k("activity", &[])),
            (full(HUG), k("activity", &[])),
            (full(HIGH_FIVE), k("activity", &[])),
            (full(FOLLOW), k("activity", &[])),
            (full(HOLD_AT), k("activity", &[])),
            (full(DANCE_AT), k("activity", &[])),
            (full(W_HANDSHAKE), k("activity", &[])),
            (full(W_HUG), k("activity", &[])),
            (full(W_HIGH_FIVE), k("activity", &[])),
            (full(W_HOLD), k("activity", &[])),
            (full(BOW), k("activity", &[])),
            (full(NOD), k("activity", &[])),
            (full(WAVE), k("activity", &[])),
            (full(INTRO), k("activity", &[])),
        ]),
        souls: [soul(1), soul(2), soul(3), soul(4)].into(),
        audiences: BTreeMap::new(),
    }
}

/// The world as built: three walkers on the ground.
fn world() -> Replica {
    let g = ground();
    let h = header(g);
    let mut r = Replica::start(h.stored()).expect("a replica");
    let effects: Vec<Value> = (1..=4)
        .map(|n| {
            Effect {
                envelope: Envelope {
                    sequence: n - 1,
                    at: 0,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node: g,
                },
                body: Body::Changes(vec![ChangeRec {
                    change: Change::Create {
                        node: soul(n),
                        kind: name(&full(WALKER)),
                        pose: Pose {
                            frame: Frame {
                                node: g,
                                slot: None,
                            },
                            position: at(n),
                            orientation: Quat::IDENTITY,
                            support: Support::Surface {
                                surface: g,
                                height: 0,
                            },
                        },
                        audience: Audience::Everyone,
                        fields: BTreeMap::new(),
                    },
                    rest: Rest::new(),
                }]),
                events: None,
                rest: Rest::new(),
            }
            .to_value()
        })
        .collect();
    let part = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (2, Value::Array(effects)),
    ])))
    .unwrap();
    r.apply(&Part::read(&part).unwrap())
        .expect("the world as built");
    r
}

/// The test world's building's ground floor (0.135 G3).
fn floor() -> Id {
    let w = testworld::generate(1, 0).expect("the test world");
    import_eden::load(&w.text)
        .expect("the test world loads")
        .nodes["building/floor-0"]
}

/// Where Souls 1 and 2 stand indoors (0.135 G3): 0.6 m apart in a room of the building's ground floor, in its axes.
fn indoors(n: u64) -> Vec3 {
    Vec3::new(if n == 1 { 200_000 } else { 800_000 }, 0, -3_000_000)
}

/// The bodies; `indoor`, Souls 1 and 2 on the building's ground floor ([`indoors`]).
fn bodies_on(indoor: bool) -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let on = |n: u64| {
        let node = if indoor && n <= 2 { floor() } else { ground };
        let p = if indoor && n <= 2 { indoors(n) } else { at(n) };
        let frame = Frame { node, slot: None };
        town.surfaces[&node].place(soul(n), frame, p, Quat::IDENTITY)
    };
    let placed = (1..=4).map(on).collect::<Result<Vec<_>, _>>()?;
    let mut b = Bodies::new(town, 50_000)?;
    for p in placed {
        b.add_body(humanoid(), p)?;
    }
    // 0.135 R1: a chair north-west of the Souls, out of every other test's way, facing +z.
    let place = Place::from_value(&decode(&fixture_bytes(CHAIR)?).unwrap().value)?;
    b.add_place(PlaceAt {
        thing: chair(),
        place,
        point: Vec3::new(-44_000_000, 450_000, 34_000_000),
        facing: Quat::IDENTITY,
        floor: ground,
        more: Vec::new(),
    })?;
    Ok(b)
}

/// The chair's fixture (0.135 R1: a sit lets go of a hold).
const CHAIR: &str = include_str!("../../replica/fixtures/seats/chair.diag");

fn chair() -> Id {
    Id::new(Scope([0x7e; 16]), 1).unwrap()
}

/// A scripted Soul on the world's socket: its stream, its id and its last sequence.
struct Client(UnixStream, Id, u64);

impl Client {
    /// One intent and its one answer: a receipt's entries, or a refusal's reason.
    fn act(
        &mut self,
        verb: &str,
        target: Option<Id>,
        p: &[(u64, Value)],
    ) -> Result<Vec<u64>, String> {
        self.2 += 1;
        let i = Intent {
            actor: Actor::Soul(self.1),
            verb: name(verb),
            target: target.map(Target::Node),
            parameters: p.iter().cloned().collect(),
            sequence: self.2,
            basis: Version {
                lineage: LINEAGE,
                zone: Id::new(LINEAGE, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: answers::now() + 60_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let bytes = encode(&i.to_value()).unwrap();
        self.0
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        self.0.write_all(&bytes).unwrap();
        // A walk is answered `started` first (3), then by its receipt.
        let a = loop {
            let mut len = [0u8; 4];
            self.0.read_exact(&mut len).expect("an answer");
            let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
            self.0.read_exact(&mut frame).unwrap();
            let Value::Map(mut m) = decode(&frame).unwrap().value else {
                panic!("a frame")
            };
            let Some(Value::Map(a)) = m.remove(&2) else {
                panic!("an answer")
            };
            if a.get(&3) != Some(&Value::Uint(3)) {
                break a;
            }
        };
        match (a.get(&3), a.get(&5)) {
            (Some(Value::Uint(1)), Some(Value::Array(e))) => Ok(e
                .iter()
                .map(|v| match v {
                    Value::Uint(n) => *n,
                    _ => panic!("an entry"),
                })
                .collect()),
            (Some(Value::Uint(2)), _) => match a.get(&4) {
                Some(Value::Text(t)) => Err(t.as_str().to_owned()),
                other => panic!("a refusal: {other:?}"),
            },
            other => panic!("an answer: {other:?}"),
        }
    }

    /// An offer of `kind` to Soul `to`, in the giver's role, under the ground.
    fn offer(&mut self, kind: &str, to: u64) -> Result<Vec<u64>, String> {
        self.act(
            "activity:offer",
            Some(ground()),
            &[
                (1, Value::Text(name(&full(kind)))),
                (2, Value::Text(name(GIVER))),
                (3, Value::Array(vec![soul(to).to_value()])),
            ],
        )
    }
}

/// A world serving on a socket, and its log.
struct Run {
    world: answers::World,
    store: Mem,
    path: std::path::PathBuf,
}

fn serve(tag: &str) -> Run {
    serve_on(tag, Mem::with(Vec::new()))
}

/// [`serve`] from `store`'s log, if it has one: a restart.
fn serve_on(tag: &str, store: Mem) -> Run {
    serve_with(tag, store, false)
}

/// [`serve`] with Souls 1 and 2 indoors ([`indoors`]).
fn serve_indoors(tag: &str) -> Run {
    serve_with(tag, Mem::with(Vec::new()), true)
}

fn serve_with(tag: &str, store: Mem, indoor: bool) -> Run {
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(move |_: &worldd::bodies::Placed| {
        bodies_on(indoor)
    }));
    cfg.engine = Some((
        tree_rules(),
        [
            handshake(HANDSHAKE, 60_000_000),
            handshake(BRIEF, 500_000),
            touch(HOLD, 60_000_000, "souls:hold_hand"),
            dance(),
            touch(HUG, 60_000_000, "souls:hug"),
            touch(HIGH_FIVE, 60_000_000, "souls:high_five"),
            follow(),
            hold_at(),
            dance_at(),
            content_touch(W_HANDSHAKE, "handshake", "souls:handshake"),
            content_touch(W_HUG, "hug", "souls:hug"),
            content_touch(W_HIGH_FIVE, "high_five", "souls:high_five"),
            content_touch(W_HOLD, "hold_hands", "souls:hold_hand"),
        ]
        .into_iter()
        .chain(greetings())
        .collect(),
    ));
    let rules = Rules {
        kinds: Json::Obj(Vec::new()),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(world(), rules, store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("t1-{tag}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, stream));
        }
    });
    Run { world, store, path }
}

impl Run {
    fn client(&self, n: u64) -> Client {
        let s = UnixStream::connect(&self.path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        Client(s, soul(n), 0)
    }

    /// Every logged entry, in order.
    fn entries(&self) -> Vec<Effect> {
        let log = self.store.0.lock().unwrap().bytes.clone();
        recover(&log)
            .unwrap()
            .records
            .into_iter()
            .filter(|r| !sim::recorder::is_input(r))
            .flat_map(|r| Part::read(&r).unwrap().effects)
            .collect()
    }

    /// The activity node the entries numbered `seq` created.
    fn created(&self, seq: &[u64]) -> Id {
        for e in self.entries() {
            if !seq.contains(&e.envelope.sequence) {
                continue;
            }
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    if let Change::Create { node, kind, .. } = &c.change
                        && [
                            HANDSHAKE,
                            BRIEF,
                            HOLD,
                            DANCE,
                            HUG,
                            HIGH_FIVE,
                            FOLLOW,
                            HOLD_AT,
                            DANCE_AT,
                            W_HANDSHAKE,
                            W_HUG,
                            W_HIGH_FIVE,
                            W_HOLD,
                            BOW,
                            NOD,
                            WAVE,
                            INTRO,
                        ]
                        .iter()
                        .any(|k| kind.as_str() == full(k))
                    {
                        return *node;
                    }
                }
            }
        }
        panic!("no handshake created in {seq:?}")
    }

    /// Each move written for viewers (`souls:form-move`): its body, the move, its target and its contact time.
    fn touches(&self) -> Vec<(Id, String, Id, Micros)> {
        let text = |v: Option<&Value>| match v {
            Some(Value::Bytes(b)) => String::from_utf8(b.clone()).unwrap(),
            other => panic!("a name as bytes: {other:?}"),
        };
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| ev.name.as_str() == "souls:form-move")
            .map(|ev| {
                let Value::Map(r) = &ev.fields[&3] else {
                    panic!("a move record")
                };
                let Some(Value::Array(ends)) = r.get(&8) else {
                    panic!("its phase ends")
                };
                let Value::Uint(contact) = ends[0] else {
                    panic!("a contact time")
                };
                (
                    read_id(&ev.fields[&2]).unwrap(),
                    text(r.get(&2)),
                    read_id(&r[&5]).unwrap(),
                    contact as Micros,
                )
            })
            .collect()
    }

    /// Each move written for viewers that has ended, by body: how it ended (`released`).
    fn ended(&self) -> Vec<(Id, String)> {
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| ev.name.as_str() == "souls:form-move")
            .filter_map(|ev| {
                let Value::Map(r) = &ev.fields[&3] else {
                    panic!("a move record")
                };
                let Some(Value::Map(e)) = r.get(&9) else {
                    return None;
                };
                let Some(Value::Bytes(how)) = e.get(&2) else {
                    panic!("how it ended")
                };
                Some((
                    read_id(&ev.fields[&2]).unwrap(),
                    String::from_utf8(how.clone()).unwrap(),
                ))
            })
            .collect()
    }

    /// Each dance move written for viewers in `activity`, in order: its body and the start in its record.
    fn starts(&self, activity: Id) -> Vec<(Id, Micros)> {
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| {
                ev.name.as_str() == "souls:form-move"
                    && read_id(&ev.fields[&1]).ok() == Some(activity)
            })
            .map(|ev| {
                let Value::Map(r) = &ev.fields[&3] else {
                    panic!("a move record")
                };
                let Some(Value::Uint(start)) = r.get(&7) else {
                    panic!("a start after the world began")
                };
                (read_id(&ev.fields[&2]).unwrap(), *start as Micros)
            })
            .collect()
    }

    /// The world time of the effect numbered `seq`.
    fn at_seq(&self, seq: u64) -> Micros {
        self.entries()
            .into_iter()
            .find(|e| e.envelope.sequence == seq)
            .map(|e| e.envelope.at)
            .expect("that entry")
    }

    /// How many `souls:activity-left` events the log holds.
    fn lefts(&self) -> usize {
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| ev.name.as_str() == "souls:activity-left")
            .count()
    }

    fn stop(self) {
        self.world.stop();
        let _ = std::fs::remove_file(&self.path);
    }
}

#[test]
fn t1_an_accepted_handshake_writes_both_moves_touching_together() {
    let run = serve("accept");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let offer = run.created(&a.offer(HANDSHAKE, 2).expect("offered"));
    assert!(run.touches().is_empty(), "an offer alone moves nobody");
    let accepted = b
        .act("activity:accept", Some(offer), &[])
        .expect("accepted");
    let touches = run.touches();
    println!("t1: accept {accepted:?}; {} moves written", touches.len());
    let aimed: BTreeSet<(Id, Id)> = touches.iter().map(|t| (t.0, t.2)).collect();
    assert_eq!(
        aimed,
        BTreeSet::from([(soul(1), soul(2)), (soul(2), soul(1))]),
        "each member's move is aimed at the other"
    );
    assert!(touches.iter().all(|t| t.1 == "souls:handshake"));
    let (c1, c2) = (touches[0].3, touches[1].3);
    assert!(
        (c1 - c2).abs() <= 50_000,
        "contacts within 50 ms: {c1} and {c2} µs"
    );
    // The moves take 2.3 s; then the handshake ends by itself, both leaving it.
    std::thread::sleep(Duration::from_millis(2_600));
    assert_eq!(run.lefts(), 2, "both left when the moves ended");
    println!("t1: contacts at {c1} and {c2} µs; both left");
    run.stop();
}

#[test]
fn t1_a_declined_or_lapsed_handshake_moves_nobody() {
    let run = serve("decline");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let declined = run.created(&a.offer(HANDSHAKE, 2).expect("offered"));
    b.act("activity:decline", Some(declined), &[])
        .expect("declined");
    let lapsing = run.created(&a.offer(BRIEF, 2).expect("offered"));
    std::thread::sleep(Duration::from_millis(1_000));
    let late = b.act("activity:accept", Some(lapsing), &[]);
    assert!(late.is_err(), "a lapsed offer is not accepted: {late:?}");
    // Soul 3 stands 2.6 m off: nothing walks it to its place, so its accept is refused by name and the offer stays.
    let mut c = run.client(3);
    let far = run.created(&a.offer(HANDSHAKE, 3).expect("offered"));
    let refused = c.act("activity:accept", Some(far), &[]);
    assert!(
        refused
            .as_ref()
            .is_err_and(|r| r.contains("together.too-far")),
        "too far to touch: {refused:?}"
    );
    c.act("activity:decline", Some(far), &[])
        .expect("the offer stayed open");
    assert!(run.touches().is_empty(), "nobody moved");
    println!(
        "t1: declined; lapsed (a late accept refused {late:?}); too far ({refused:?}): no move written"
    );
    run.stop();
}

/// Content's four touches: the move each names, its reach and how far apart its members stand once placed, µm.
const WALKED: [(&str, &str, i64, i64); 4] = [
    (W_HANDSHAKE, "souls:handshake", 700_000, 550_000),
    (W_HUG, "souls:hug", 700_000, 550_000),
    (W_HIGH_FIVE, "souls:high_five", 700_000, 550_000),
    (W_HOLD, "souls:hold_hand", 600_000, 450_000),
];

fn apart(p: Vec3, q: Vec3) -> i64 {
    ((i128::from(p.x - q.x).pow(2) + i128::from(p.z - q.z).pow(2)).isqrt()) as i64
}

/// Waits up to about 10 s (100 waits of 0.1 s) for `done` to hold of `run`.
fn until(run: &Run, done: impl Fn(&Run) -> bool) -> bool {
    for _ in 0..100 {
        if done(run) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    done(run)
}

impl Run {
    /// The world time of each `souls:activity-left` event, in order.
    fn left_at(&self) -> Vec<Micros> {
        self.entries()
            .into_iter()
            .filter(|e| {
                e.events
                    .iter()
                    .flatten()
                    .any(|ev| ev.name.as_str() == "souls:activity-left")
            })
            .map(|e| e.envelope.at)
            .collect()
    }
}

/// 0.134 item 5: a touch after a walk-up. Soul 3, 2 m from Soul 2, walks up to it (a walk to a body ends beside it,
/// at speaking distance); then each of content's handshake, hug, high-five and holding hands, offered by Soul 3 and
/// accepted by Soul 2, starts: the two walk to their places (0.6 m apart, 0.5 m holding hands), within the move's
/// reach, and their moves play past contact to the end (a touch ends by itself after its last phase, never at
/// contact, where a move out of reach is cancelled; the hold holds until a leave releases it). Each on a fresh
/// world, so each starts from the walk-up.
#[test]
fn t1_each_touch_after_a_walk_up_is_accepted_and_plays() {
    for (i, (kind, mv, reach, placed)) in WALKED.into_iter().enumerate() {
        let run = serve(&format!("walk-up-{i}"));
        let (mut a, mut b) = (run.client(3), run.client(2));
        a.act("eden:walk", Some(soul(2)), &[])
            .expect("Soul 3 walks up to Soul 2");
        let from = apart(run.last(3).0, run.last(2).0);
        assert!(
            (1_000_000..1_500_000).contains(&from),
            "walked up to speaking distance: {from} µm"
        );
        let offer = run.created(&a.offer(kind, 2).expect("offered"));
        b.act("activity:accept", Some(offer), &[])
            .unwrap_or_else(|r| panic!("{kind} accepted from {from} µm apart: {r}"));
        assert!(
            until(&run, |r| r.touches().len() == 2),
            "{kind}: both moves begin once both are placed"
        );
        let at = apart(run.last(3).0, run.last(2).0);
        assert!(
            (at - placed).abs() <= 100_000 && at <= reach,
            "{kind}: placed {placed} µm apart and within its {reach} µm reach: stood {at} µm"
        );
        let touches = run.touches();
        assert!(touches.iter().all(|t| t.1 == mv));
        let aimed: BTreeSet<(Id, Id)> = touches.iter().map(|t| (t.0, t.2)).collect();
        assert_eq!(
            aimed,
            BTreeSet::from([(soul(3), soul(2)), (soul(2), soul(3))])
        );
        let contact = touches.iter().map(|t| t.3).max().unwrap();
        let how = if mv == "souls:hold_hand" {
            std::thread::sleep(Duration::from_millis(1_500));
            assert_eq!(run.lefts(), 0, "the hold holds");
            b.act("activity:leave", Some(offer), &[]).expect("left");
            assert!(until(&run, |r| r.ended().len() == 2), "the hold released");
            let ended = run.ended();
            assert!(ended.iter().all(|(_, h)| h == "released"), "{ended:?}");
            "held, then released by a leave"
        } else {
            assert!(until(&run, |r| r.lefts() == 2), "{kind} ended by itself");
            let left = run.left_at();
            assert!(
                left.iter().all(|t| *t >= contact + 300_000),
                "{kind}: ended after its last phase, not at contact {contact}: {left:?}"
            );
            "played past contact and ended by themselves"
        };
        println!("item 5: {kind} accepted {from} µm apart; placed {at} µm apart; both moves {how}");
        run.stop();
    }
}

/// 0.134 item 5: two Souls 5 m apart are still too far for each touch. Soul 3 walks to a point 5 m from Soul 2; each
/// accept is refused `together.too-far`, the offer stays open (declined after), and nobody moves.
#[test]
fn t1_a_touch_from_5_m_apart_is_refused_and_moves_nobody() {
    let run = serve("walk-up-far");
    let (mut a, mut b) = (run.client(3), run.client(2));
    let two = at(2);
    a.act(
        "eden:walk",
        Some(ground()),
        &[(1, walk_to(two.x - 5_000_000, two.z))],
    )
    .expect("Soul 3 walks to 5 m from Soul 2");
    let (p3, p2) = (run.last(3).0, run.last(2).0);
    let from = apart(p3, p2);
    assert!((from - 5_000_000).abs() <= 200_000, "5 m apart: {from} µm");
    for (kind, _, _, _) in WALKED {
        let offer = run.created(&a.offer(kind, 2).expect("offered"));
        let refused = b.act("activity:accept", Some(offer), &[]);
        assert!(
            refused
                .as_ref()
                .is_err_and(|r| r.contains("together.too-far")),
            "{kind} from {from} µm: {refused:?}"
        );
        b.act("activity:decline", Some(offer), &[])
            .expect("the offer stayed open");
        println!(
            "item 5: {kind} from {from} µm refused: {}",
            refused.unwrap_err()
        );
    }
    std::thread::sleep(Duration::from_millis(500));
    assert!(run.touches().is_empty(), "no move written");
    assert_eq!((run.last(3).0, run.last(2).0), (p3, p2), "nobody moved");
    run.stop();
}

/// 0.134 T2: two Souls hold hands, standing, for as long as both stay. One leaving frees both hands; so does a walk
/// sent by the one who does not lead (0.135 R1: the first to walk leads, and the other walks beside it), which leaves
/// the activity as `activity:leave` does.
#[test]
fn t2_holding_hands_lasts_until_either_leaves_or_walks() {
    let run = serve("hold");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let both = BTreeSet::from([(soul(1), soul(2)), (soul(2), soul(1))]);
    let released = |run: &Run| -> BTreeSet<Id> {
        run.ended()
            .into_iter()
            .filter(|(_, how)| how == "released")
            .map(|(b, _)| b)
            .collect()
    };

    // Held, then Soul 2 leaves: both hands come free at once.
    let held = run.created(&a.offer(HOLD, 2).expect("offered"));
    b.act("activity:accept", Some(held), &[]).expect("accepted");
    let aimed: BTreeSet<(Id, Id)> = run.touches().iter().map(|t| (t.0, t.2)).collect();
    assert_eq!(aimed, both, "each member holds the other's hand");
    assert!(run.touches().iter().all(|t| t.1 == "souls:hold_hand"));
    // Well past the reach (0.6 s): still held, nothing ended.
    std::thread::sleep(Duration::from_millis(1_500));
    assert!(run.ended().is_empty(), "held while both stay");
    b.act("activity:leave", Some(held), &[])
        .expect("Soul 2 leaves");
    assert_eq!(
        released(&run),
        BTreeSet::from([soul(1), soul(2)]),
        "a leave frees both hands"
    );
    assert_eq!(run.lefts(), 2, "the hold is over: Soul 1 left it too");
    let after_leave = run.ended().len();

    // Held again, then Soul 1 walks 2 m: it leads (0.135 R1), so Soul 2 walks beside it, still holding. Then Soul 2
    // walks off on its own: its walk leaves the activity, and both hands come free.
    let again = run.created(&a.offer(HOLD, 2).expect("offered again"));
    b.act("activity:accept", Some(again), &[])
        .expect("accepted again");
    std::thread::sleep(Duration::from_millis(1_000));
    let lefts = run.lefts();
    a.act(
        "eden:walk",
        Some(ground()),
        &[(1, walk_to(-40_000_000, 32_000_000))],
    )
    .expect("Soul 1 walks, leading");
    assert_eq!(
        run.ended().len(),
        after_leave,
        "the leader's walk lets nobody go"
    );
    assert_eq!(run.lefts(), lefts, "the hold goes on");
    b.act(
        "eden:walk",
        Some(ground()),
        &[(1, walk_to(-43_000_000, 32_000_000))],
    )
    .expect("Soul 2 walks off");
    let walked: Vec<(Id, String)> = run.ended().split_off(after_leave);
    assert_eq!(
        walked.iter().map(|(b, _)| *b).collect::<BTreeSet<_>>(),
        BTreeSet::from([soul(1), soul(2)]),
        "a walk frees both hands: {walked:?}"
    );
    assert!(walked.iter().all(|(_, how)| how == "released"));
    assert_eq!(
        run.lefts(),
        lefts + 2,
        "the walk left the activity as a leave does, and the hold is over for both"
    );
    println!(
        "t2: held 1.5 s; a leave freed both hands; held again, the leader walked holding, the other's walk freed both ({} released)",
        walked.len()
    );
    run.stop();
}

/// 0.134 T3: four scripted Souls dance together. Soul 1 offers the dance to Souls 2, 3 and 4 at once, and their
/// accepts arrive up to 500 ms apart. In each of 20 runs, every member's first dance move starts on the same beat of
/// the world's clock (120 a minute from 0: a whole multiple of 500 ms), at most 2 s after the first accept. In the
/// first run the dance goes on: each member's next move starts on the next whole beat after the first ends. Every
/// leave is accepted.
#[test]
fn t3_four_souls_dance_on_one_beat_in_20_runs() {
    let run = serve("dance");
    let mut c: Vec<Client> = (1..=4).map(|n| run.client(n)).collect();
    let beat = replica::time::Tempo::per_minute(0, 0, 120).unwrap();
    let line = replica::time::Timeline::start(
        replica::time::Mapping::new(0, 0, 1, 1).unwrap(),
        replica::time::TickRate::new(0, 0, 20).unwrap(),
        beat,
    )
    .unwrap();
    let on_beat = |t: Micros| line.beat_of(t).and_then(|k| line.beat_time(k)) == Ok(t);
    let mut spreads = Vec::new();
    for r in 0..20u64 {
        let asked = Value::Array((2..=4).map(|n| soul(n).to_value()).collect());
        let offered = c[0]
            .act(
                "activity:offer",
                Some(ground()),
                &[
                    (1, Value::Text(name(&full(DANCE)))),
                    (2, Value::Text(name(GIVER))),
                    (3, asked),
                ],
            )
            .expect("offered to three");
        let dance = run.created(&offered);
        // Three accepts, each 0 to 249 ms after the one before: at most 500 ms from first to last.
        let gaps = [0, (r * 37) % 250, (r * 91 + 40) % 250];
        let mut first = None;
        for (k, gap) in gaps.iter().enumerate() {
            std::thread::sleep(Duration::from_millis(*gap));
            let e = c[k + 1]
                .act("activity:accept", Some(dance), &[])
                .unwrap_or_else(|x| panic!("run {r}: Soul {} accepts: {x}", k + 2));
            first.get_or_insert(run.at_seq(e[0]));
        }
        let first = first.unwrap();
        let starts = run.starts(dance);
        let members: BTreeSet<Id> = starts.iter().map(|s| s.0).collect();
        assert_eq!(
            members,
            (1..=4).map(soul).collect(),
            "run {r}: all four dance"
        );
        let s0 = starts[0].1;
        assert!(
            starts.iter().all(|s| s.1 == s0),
            "run {r}: one beat for all: {starts:?}"
        );
        assert!(on_beat(s0), "run {r}: {s0} µs is a whole beat");
        assert!(
            s0 > first && s0 - first <= 2_000_000,
            "run {r}: the beat is {} µs after the first accept",
            s0 - first
        );
        spreads.push(gaps.iter().sum::<u64>());
        if r == 0 {
            // Beat after beat: the dance (0.8 s) ends, and each member's next begins on the next whole beat.
            let wait = s0 - answers::now() + 1_300_000;
            std::thread::sleep(Duration::from_micros(u64::try_from(wait).unwrap_or(0)));
            let again: Vec<(Id, Micros)> = run.starts(dance).split_off(4);
            assert_eq!(
                again.iter().map(|s| s.0).collect::<BTreeSet<_>>(),
                members,
                "each member dances again: {again:?}"
            );
            assert!(
                again.iter().all(|s| s.1 == s0 + 1_000_000),
                "the next whole beat after the first dance: {again:?}"
            );
        }
        for (k, cl) in c.iter_mut().enumerate() {
            cl.act("activity:leave", Some(dance), &[])
                .unwrap_or_else(|x| panic!("run {r}: Soul {} leaves: {x}", k + 1));
        }
        // Let the leaves end the moves in progress (at most the kind's 400 ms).
        std::thread::sleep(Duration::from_millis(600));
    }
    println!(
        "t3: 20 runs, four Souls on one beat each; accepts spread over {spreads:?} ms; leaves accepted"
    );
    run.stop();
}

/// Lane B's find on 0.134 T1: a touch kept running after its moves ended, holding both arms, so a later point or
/// wave was refused and a later touch between the same two never started. Each touch now ends with its moves: both
/// members leave it by themselves (`souls:activity-left`), and the same touch again between the same two plays both
/// moves.
#[test]
fn t1_each_touch_ends_with_its_moves_and_the_next_one_plays() {
    let run = serve("again");
    let (mut a, mut b) = (run.client(1), run.client(2));
    for kind in [HANDSHAKE, HUG, HIGH_FIVE] {
        for round in 1..=2 {
            let moved = run.touches().len();
            let lefts = run.lefts();
            let touch = run.created(&a.offer(kind, 2).expect("offered"));
            b.act("activity:accept", Some(touch), &[])
                .unwrap_or_else(|r| panic!("{kind} {round}: accepted: {r}"));
            assert_eq!(
                run.touches().len(),
                moved + 2,
                "{kind} {round}: both moves written"
            );
            // The longest (a hug) takes 2.8 s; then the touch ends by itself.
            std::thread::sleep(Duration::from_millis(3_300));
            assert_eq!(
                run.lefts(),
                lefts + 2,
                "{kind} {round}: both left when the moves ended"
            );
        }
    }
    println!(
        "t1: a handshake, a hug and a high-five each ended with its moves, and each played again"
    );
    run.stop();
}

/// Lane B's find on 0.134 T2: a body that had held hands once got no held move again, because the one who stayed
/// was still in the old hold. Now when one leaves, the hold is over for both. Two holds in a row between the same
/// two, then one Soul with a second partner: each hold writes both `souls:hold_hand` moves, releases both, and both
/// leave it.
#[test]
fn t2_holds_again_and_with_another_partner() {
    let run = serve("hold-again");
    let (mut a, mut b, mut c) = (run.client(1), run.client(2), run.client(3));
    let holds = |run: &Run| -> usize {
        run.touches()
            .iter()
            .filter(|t| t.1 == "souls:hold_hand")
            .count()
    };
    let released = |run: &Run| -> usize {
        run.ended()
            .iter()
            .filter(|(_, how)| how == "released")
            .count()
    };
    let hold = |asker: &mut Client, other: &mut Client, to: u64, round: &str| {
        let (h, r, l) = (holds(&run), released(&run), run.lefts());
        let held = run.created(&asker.offer(HOLD, to).expect("offered"));
        other
            .act("activity:accept", Some(held), &[])
            .unwrap_or_else(|e| panic!("{round}: accepted: {e}"));
        assert_eq!(holds(&run), h + 2, "{round}: both hold");
        std::thread::sleep(Duration::from_millis(800));
        other
            .act("activity:leave", Some(held), &[])
            .unwrap_or_else(|e| panic!("{round}: left: {e}"));
        assert_eq!(released(&run), r + 2, "{round}: both released");
        assert_eq!(run.lefts(), l + 2, "{round}: the hold is over, both left");
    };
    hold(&mut a, &mut b, 2, "first");
    hold(&mut a, &mut b, 2, "again, the same two");
    // Soul 3 comes to stand 0.5 m east of Soul 1 and holds its hand.
    let to = Value::Array(vec![
        Value::Nint(39_499_999),
        Value::Uint(0),
        Value::Uint(30_000_000),
    ]);
    c.act("eden:walk", Some(ground()), &[(1, to)])
        .expect("Soul 3 comes over");
    hold(&mut a, &mut c, 3, "with another partner");
    println!("t2: three holds, each with both moves and both released");
    run.stop();
}

impl Run {
    /// Each body row the log holds, in order: the body and where it stood.
    fn rows(&self) -> Vec<(Id, Vec3)> {
        let log = self.store.0.lock().unwrap().bytes.clone();
        recover(&log)
            .unwrap()
            .records
            .into_iter()
            .filter(|r| !sim::recorder::is_input(r))
            .flat_map(|r| match Part::read(&r).unwrap().rest.get(&BODIES) {
                Some(Value::Array(rows)) => rows.clone(),
                _ => Vec::new(),
            })
            .filter_map(|v| read_row(&v).map(|(b, p, _)| (b, p.position)))
            .collect()
    }
}

fn walk_to(x: i64, z: i64) -> Value {
    let int =
        |n: i64| u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint);
    Value::Array(vec![int(x), int(0), int(z)])
}

/// The follower's track since row `from`: the furthest it was from its place (1 m from the leader, toward the
/// follower) and the most it moved in one tick.
fn track(run: &Run, from: usize) -> (i64, i64, Vec3, Vec3) {
    let len = |a: Vec3, b: Vec3| {
        ((((a.x - b.x) as i128).pow(2) + ((a.z - b.z) as i128).pow(2)).isqrt()) as i64
    };
    let rows = run.rows();
    let (mut l, mut f) = (at(1), at(2));
    for (body, p) in rows.iter().take(from) {
        if *body == soul(1) {
            l = *p;
        } else if *body == soul(2) {
            f = *p;
        }
    }
    let (mut worst, mut step) = (0_i64, 0_i64);
    for (body, p) in rows.into_iter().skip(from) {
        if body == soul(1) {
            l = p;
        } else if body == soul(2) {
            step = step.max(len(p, f));
            f = p;
        } else {
            continue;
        }
        let d = len(f, l).max(1);
        let place = Vec3::new(
            l.x + (i128::from(f.x - l.x) * 1_000_000 / i128::from(d)) as i64,
            0,
            l.z + (i128::from(f.z - l.z) * 1_000_000 / i128::from(d)) as i64,
        );
        worst = worst.max(len(f, place));
    }
    (worst, step, l, f)
}

/// 0.135 G2: Soul 2 offers to follow Soul 1, and Soul 1 accepts; Soul 2's own `souls:follow` order then walks it
/// along Soul 1's trail. Soul 1 walks 30 m with two turns (10 m east, 8 m south, 12 m east): at every tick either
/// moved, Soul 2 is within 2.5 m of its place 1 m behind and never moves more than 0.2 m in a tick (walked, never
/// placed). Soul 2 walking on its own ends the follow for both. Followed again, Soul 1 turns back through Soul 2
/// (8 m east, then 12 m west), and Soul 2 keeps the same bounds; Soul 2's own order (a held stance) ends that follow
/// for both too.
#[test]
fn g2_a_soul_follows_another_over_a_walk_with_two_turns() {
    let run = serve("follow");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let len = |a: Vec3, b: Vec3| {
        ((((a.x - b.x) as i128).pow(2) + ((a.z - b.z) as i128).pow(2)).isqrt()) as i64
    };
    let follow = run.created(&b.offer(FOLLOW, 1).expect("Soul 2 offers to follow"));
    a.act("activity:accept", Some(follow), &[])
        .expect("Soul 1 accepts");
    let from = run.rows().len();
    for (x, z) in [
        (-30_000_000, 30_000_000),
        (-30_000_000, 22_000_000),
        (-18_000_000, 22_000_000),
    ] {
        a.act("eden:walk", Some(ground()), &[(1, walk_to(x, z))])
            .unwrap_or_else(|e| panic!("Soul 1 walks to ({x}, {z}): {e}"));
    }
    std::thread::sleep(Duration::from_millis(2_000));
    let (worst, step, leader, follower) = track(&run, from);
    println!(
        "g2: two turns: the follower within {} mm of its place; at most {} mm a tick",
        worst / 1000,
        step / 1000
    );
    assert!(worst <= 2_500_000, "within 2.5 m of its place: {worst} µm");
    assert!(
        step <= 200_000,
        "walked, never placed: {step} µm in one tick"
    );
    assert!(
        len(follower, leader) < 3_000_000,
        "the follower ended behind: {follower:?} {leader:?}"
    );
    // Soul 2 walks on its own: the follow ends for both.
    let lefts = run.lefts();
    b.act(
        "eden:walk",
        Some(ground()),
        &[(1, walk_to(-19_000_000, 24_000_000))],
    )
    .expect("Soul 2 walks on its own");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(run.lefts(), lefts + 2, "the follow is over for both");

    // Followed again; Soul 1 turns back through Soul 2.
    let again = run.created(&b.offer(FOLLOW, 1).expect("offered again"));
    a.act("activity:accept", Some(again), &[])
        .expect("accepted again");
    let from = run.rows().len();
    for (x, z) in [(-10_000_000, 22_000_000), (-22_000_000, 22_000_000)] {
        a.act("eden:walk", Some(ground()), &[(1, walk_to(x, z))])
            .unwrap_or_else(|e| panic!("Soul 1 walks to ({x}, {z}): {e}"));
    }
    std::thread::sleep(Duration::from_millis(2_000));
    let (worst, step, _, _) = track(&run, from);
    println!(
        "g2: turned back through: the follower within {} mm of its place; at most {} mm a tick",
        worst / 1000,
        step / 1000
    );
    assert!(worst <= 2_500_000, "within 2.5 m of its place: {worst} µm");
    assert!(
        step <= 200_000,
        "walked, never placed: {step} µm in one tick"
    );
    // Soul 2's own order (a held stance) ends the follow for both.
    let lefts = run.lefts();
    b.act("souls:hold", None, &[(1, Value::Uint(1))])
        .expect("Soul 2 holds its stance");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        run.lefts(),
        lefts + 2,
        "its own order ends the follow for both"
    );
    run.stop();
}

/// 0.135 G2 after G1: the follower walks at the leader's gait. Soul 1 jogs 12 m east, then runs 16 m east (`gait:jog`,
/// `gait:run`, parameter 2); Soul 2 keeps within 2.5 m of its place 1 m behind (at walking pace's closing cap,
/// 2.4 m/s, it fell more than 6 m behind on the run), and never moves more than the run's 0.2 m in a tick, plus 5 %.
#[test]
fn g2_a_follower_keeps_the_leaders_gait() {
    let run = serve("follow-gait");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let follow = run.created(&b.offer(FOLLOW, 1).expect("Soul 2 offers to follow"));
    a.act("activity:accept", Some(follow), &[])
        .expect("Soul 1 accepts");
    let from = run.rows().len();
    for (x, gait) in [(-28_000_000, "gait:jog"), (-12_000_000, "gait:run")] {
        a.act(
            "eden:walk",
            Some(ground()),
            &[(1, walk_to(x, 30_000_000)), (2, Value::Text(name(gait)))],
        )
        .unwrap_or_else(|e| panic!("Soul 1 goes to x {x} at {gait}: {e}"));
    }
    std::thread::sleep(Duration::from_millis(2_000));
    let (worst, step, leader, follower) = track(&run, from);
    println!(
        "g2 gait: the follower within {} mm of its place; at most {} mm a tick; ended {} mm from the leader",
        worst / 1000,
        step / 1000,
        (follower.x - leader.x).abs() / 1000
    );
    assert!(worst <= 2_500_000, "within 2.5 m of its place: {worst} µm");
    assert!(step <= 210_000, "at most a run's tick: {step} µm");
    run.stop();
}

/// 0.135 G2, review R1 and R2: a follow survives a restart. The follower's order is taken up from the log as it is;
/// an intent arriving after the restart never takes the order's id (the world made the order on the intents'
/// counter); and the leader's leave then ends the follow for both and cancels the order, in the same tick.
#[test]
fn g2_a_follow_across_a_restart() {
    let run = serve("follow-restart");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let follow = run.created(&b.offer(FOLLOW, 1).expect("Soul 2 offers to follow"));
    a.act("activity:accept", Some(follow), &[])
        .expect("Soul 1 accepts");
    std::thread::sleep(Duration::from_millis(300));
    let order = |run: &Run, name: &str| -> Vec<Id> {
        let log = run.store.0.lock().unwrap().bytes.clone();
        recover(&log)
            .unwrap()
            .records
            .into_iter()
            .filter(|r| !sim::recorder::is_input(r))
            .flat_map(|r| Part::read(&r).unwrap().effects)
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| ev.name.as_str() == name)
            .filter_map(|ev| read_id(&ev.fields[&1]).ok())
            .collect()
    };
    let orders = order(&run, "souls:order");
    assert_eq!(orders.len(), 1, "the follower's own follow order");
    let Run { world, store, path } = run;
    world.stop();
    let _ = std::fs::remove_file(&path);
    let run = serve_on("follow-restart-2", store);
    let mut a = run.client(1);
    a.2 = 100;
    // An intent after the restart: its effects name its own id, never the order's.
    let walked = a
        .act(
            "eden:walk",
            Some(ground()),
            &[(1, walk_to(-36_000_000, 30_000_000))],
        )
        .expect("Soul 1 walks after the restart");
    let log = run.store.0.lock().unwrap().bytes.clone();
    let causes: BTreeSet<Id> = recover(&log)
        .unwrap()
        .records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
        .flat_map(|r| Part::read(&r).unwrap().effects)
        .filter(|e| walked.contains(&e.envelope.sequence))
        .filter_map(|e| match e.envelope.cause {
            Cause::Intent(i) => Some(i),
            _ => None,
        })
        .collect();
    assert!(
        !causes.is_empty() && !causes.contains(&orders[0]),
        "a fresh id: {causes:?}"
    );
    // The order was taken up as it is: no second order, and the leader's leave ends both and cancels it.
    let lefts = run.lefts();
    a.act("activity:leave", Some(follow), &[])
        .expect("Soul 1 leaves");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(run.lefts(), lefts + 2, "the follow is over for both");
    assert_eq!(order(&run, "souls:order"), orders, "no second order");
    assert_eq!(
        order(&run, "souls:order-ended"),
        orders,
        "the order ended with the follow"
    );
    run.stop();
}

impl Run {
    /// Each body row the log holds, in order, with its whole pose.
    fn poses(&self) -> Vec<(Id, Pose)> {
        let log = self.store.0.lock().unwrap().bytes.clone();
        recover(&log)
            .unwrap()
            .records
            .into_iter()
            .filter(|r| !sim::recorder::is_input(r))
            .flat_map(|r| match Part::read(&r).unwrap().rest.get(&BODIES) {
                Some(Value::Array(rows)) => rows.clone(),
                _ => Vec::new(),
            })
            .filter_map(|v| read_row(&v).map(|(b, p, _)| (b, p)))
            .collect()
    }

    /// Each body's last pose in the log (its start if it never moved).
    fn last(&self, n: u64) -> (Vec3, Quat) {
        self.poses()
            .into_iter()
            .filter(|(b, _)| *b == soul(n))
            .map(|(_, p)| (p.position, p.orientation))
            .next_back()
            .unwrap_or((at(n), Quat::IDENTITY))
    }
}

/// Where a facing looks on the plan: +x turned by it (a body's ahead, as the page draws it), µm per metre.
fn ahead(q: Quat) -> (i64, i64) {
    let v = q.rotate(Vec3::new(1_000_000, 0, 0)).unwrap();
    (v.x, v.z)
}

/// 0.135 G3: members take their places when a group activity starts. Holding hands: the two end shoulder to
/// shoulder, 0.5 m apart, facing the same way, across the line between them; the hold's moves begin after. A dance
/// of four: each walks (never more than 0.2 m a tick) to its place on a 1 m ring round where its first two members
/// stood when it started, faces its middle, and all four start dancing on the same beat.
#[test]
fn g3_members_take_their_places_then_their_moves_begin() {
    let run = serve("places");
    let mut c: Vec<Client> = (1..=4).map(|n| run.client(n)).collect();
    let len = |x: i64, z: i64| ((i128::from(x).pow(2) + i128::from(z).pow(2)).isqrt()) as i64;

    // Holding hands.
    let hold = run.created(&c[0].offer(HOLD_AT, 2).expect("offered"));
    c[1].act("activity:accept", Some(hold), &[])
        .expect("accepted");
    std::thread::sleep(Duration::from_millis(1_500));
    let ((p1, q1), (p2, q2)) = (run.last(1), run.last(2));
    let apart = len(p1.x - p2.x, p1.z - p2.z);
    let (f1, f2) = (ahead(q1), ahead(q2));
    println!("g3: hold hands {apart} µm apart, facing {f1:?} and {f2:?}");
    assert!(
        (apart - 500_000).abs() <= 100_000,
        "shoulder to shoulder: {apart} µm"
    );
    assert!(
        (f1.0 - f2.0).abs() < 20_000 && (f1.1 - f2.1).abs() < 20_000,
        "one way: {f1:?} {f2:?}"
    );
    let across = (i128::from(f1.0) * i128::from(p2.x - p1.x)
        + i128::from(f1.1) * i128::from(p2.z - p1.z))
    .abs();
    assert!(
        across < i128::from(apart) * 100_000,
        "facing across the line between them"
    );
    let holds: Vec<_> = run
        .touches()
        .into_iter()
        .filter(|t| t.1 == "souls:hold_hand")
        .collect();
    assert_eq!(
        holds.len(),
        2,
        "the hold's moves begin once both are placed"
    );
    c[1].act("activity:leave", Some(hold), &[]).expect("left");

    // A dance of four.
    let from = run.poses().len();
    let start: Vec<Vec3> = (1..=4).map(|n| run.last(n).0).collect();
    // The ring's middle is fixed when the dance starts: at the first accept, between its first two members.
    let middle = Vec3::new(
        (start[0].x + start[1].x) / 2,
        0,
        (start[0].z + start[1].z) / 2,
    );
    let asked = Value::Array((2..=4).map(|n| soul(n).to_value()).collect());
    let offered = c[0]
        .act(
            "activity:offer",
            Some(ground()),
            &[
                (1, Value::Text(name(&full(DANCE_AT)))),
                (2, Value::Text(name(GIVER))),
                (3, asked),
            ],
        )
        .expect("offered to three");
    let dance = run.created(&offered);
    for cl in c.iter_mut().skip(1) {
        cl.act("activity:accept", Some(dance), &[])
            .expect("accepted");
    }
    std::thread::sleep(Duration::from_millis(5_000));
    let mut step = 0;
    let mut last: BTreeMap<Id, Vec3> = (1..=4).map(|n| (soul(n), start[n as usize - 1])).collect();
    for (b, p) in run.poses().into_iter().skip(from) {
        if let Some(l) = last.get_mut(&b) {
            step = step.max(len(p.position.x - l.x, p.position.z - l.z));
            *l = p.position;
        }
    }
    assert!(step <= 200_000, "walked, never placed: {step} µm in a tick");
    for n in 1..=4 {
        let (p, q) = run.last(n);
        let r = len(p.x - middle.x, p.z - middle.z);
        let f = ahead(q);
        let inward = i128::from(f.0) * i128::from(middle.x - p.x)
            + i128::from(f.1) * i128::from(middle.z - p.z);
        println!("g3: dancer {n} {r} µm from the middle, facing {f:?}");
        assert!(
            (r - 1_000_000).abs() <= 50_000,
            "dancer {n} on the ring: {r} µm"
        );
        assert!(
            inward > i128::from(r) * 900_000,
            "dancer {n} faces the middle: {f:?}"
        );
    }
    let starts = run.starts(dance);
    let first: BTreeSet<Micros> = starts.iter().take(4).map(|s| s.1).collect();
    assert_eq!(
        starts
            .iter()
            .take(4)
            .map(|s| s.0)
            .collect::<BTreeSet<_>>()
            .len(),
        4,
        "all four dance"
    );
    assert_eq!(first.len(), 1, "on one beat: {starts:?}");
    run.stop();
}

impl Run {
    /// Soul `n`'s body's last pose in the log, whole (0.135 G3); none if it never changed.
    fn last_pose(&self, n: u64) -> Option<Pose> {
        self.poses()
            .into_iter()
            .filter(|(b, _)| *b == soul(n))
            .map(|(_, p)| p)
            .next_back()
    }
}

/// 0.135 G3, indoors: two Souls in a room of the building's ground floor start a dance; each walks to its place on
/// the 1 m ring round where they stood, on that floor and in its axes, not to the same numbers on the open ground.
#[test]
fn g3_indoors_members_take_their_places_on_their_floor() {
    let run = serve_indoors("places-indoors");
    let mut c: Vec<Client> = (1..=2).map(|n| run.client(n)).collect();
    let dance = run.created(&c[0].offer(DANCE_AT, 2).expect("offered"));
    c[1].act("activity:accept", Some(dance), &[])
        .expect("accepted");
    std::thread::sleep(Duration::from_millis(3_000));
    let len = |x: i64, z: i64| ((i128::from(x).pow(2) + i128::from(z).pow(2)).isqrt()) as i64;
    let middle = Vec3::new(500_000, 0, -3_000_000);
    for n in 1..=2 {
        let p = run.last_pose(n).expect("it moved");
        let r = len(p.position.x - middle.x, p.position.z - middle.z);
        println!(
            "g3 indoors: dancer {n} at {:?} on {:?}, {r} µm from the middle",
            p.position, p.frame.node
        );
        assert_eq!(p.frame.node, floor(), "dancer {n} stays on its floor");
        assert!(
            (r - 1_000_000).abs() <= 50_000,
            "dancer {n} on the ring round where they stood: {r} µm"
        );
    }
    run.stop();
}

/// 0.135 G3: a Soul that leaves while it walks to its place stops: the world's walk to a place ends with the
/// membership it was for.
#[test]
fn g3_a_leave_while_taking_places_ends_the_walk() {
    let run = serve("places-leave");
    let mut c: Vec<Client> = (1..=2).map(|n| run.client(n)).collect();
    let dance = run.created(&c[0].offer(DANCE_AT, 2).expect("offered"));
    c[1].act("activity:accept", Some(dance), &[])
        .expect("accepted");
    let mut waited = 0;
    while run.last(2).0 == at(2) {
        assert!(waited < 3_000, "Soul 2 walks to its place");
        std::thread::sleep(Duration::from_millis(20));
        waited += 20;
    }
    c[1].act("activity:leave", Some(dance), &[]).expect("left");
    std::thread::sleep(Duration::from_millis(300));
    let stopped = run.last(2).0;
    std::thread::sleep(Duration::from_millis(1_500));
    let later = run.last(2).0;
    println!("g3: left on its way at {stopped:?}; 1.5 s on, at {later:?}");
    assert_eq!(stopped, later, "the walk to its place ended with the leave");
    run.stop();
}

impl Run {
    /// The node each event named `name` in the log is about (its field 1), in order.
    fn named(&self, name: &str) -> Vec<Id> {
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| ev.name.as_str() == name)
            .filter_map(|ev| read_id(&ev.fields[&1]).ok())
            .collect()
    }
}

/// Where Soul 2 stands from Soul 1 on the last body rows, µm: along the way Soul 1 last walked (from where it stood
/// half a metre back along its own track, since its route need not run straight) and across it.
fn beside(run: &Run) -> (i64, i64) {
    let (l, f) = (run.last(1).0, run.last(2).0);
    let len = |a: Vec3, b: Vec3| {
        ((((a.x - b.x) as i128).pow(2) + ((a.z - b.z) as i128).pow(2)).isqrt()) as i64
    };
    let back = run
        .rows()
        .into_iter()
        .filter(|(b, p)| *b == soul(1) && len(*p, l) >= 500_000)
        .map(|(_, p)| p)
        .next_back()
        .expect("Soul 1 walked");
    let heading = (l.x - back.x, l.z - back.z);
    let (dx, dz) = (f.x - l.x, f.z - l.z);
    let n = ((i128::from(heading.0).pow(2) + i128::from(heading.1).pow(2)).isqrt()).max(1);
    let along =
        (i128::from(dx) * i128::from(heading.0) + i128::from(dz) * i128::from(heading.1)) / n;
    let across =
        (i128::from(dx) * i128::from(heading.1) - i128::from(dz) * i128::from(heading.0)) / n;
    (along as i64, across as i64)
}

/// 0.135 R1, walking hand in hand: Souls 1 and 2 hold hands (taking their places shoulder to shoulder, G3), then
/// Soul 1 walks 6 m one way and 6 m square to it. Soul 1 leads: its walk lets nobody go, and Soul 2 walks beside it
/// by its own order, at every tick either moved within 1.2 m of Soul 1 and never more than 0.2 m in a tick (walked,
/// never placed); when Soul 1 stops after each leg, Soul 2 stands 0.5 m to its side (within 0.15 m), no more than
/// 0.2 m ahead or behind of the way Soul 1 last walked (its route bends round what is in its way), both still holding hands. Then Soul 2's own walk lets go for both. Held again, Soul 1 leads
/// and then leaves: both hands come free, Soul 2's order ends, and Soul 1's next walk leaves Soul 2 where it stood.
#[test]
fn r1_two_souls_walk_hand_in_hand_until_either_lets_go() {
    let run = serve("hand-in-hand");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let len = |a: Vec3, b: Vec3| {
        ((((a.x - b.x) as i128).pow(2) + ((a.z - b.z) as i128).pow(2)).isqrt()) as i64
    };
    let hold = run.created(&a.offer(HOLD_AT, 2).expect("Soul 1 offers to hold hands"));
    b.act("activity:accept", Some(hold), &[])
        .expect("Soul 2 accepts");
    std::thread::sleep(Duration::from_millis(1_500));
    assert_eq!(run.touches().len(), 2, "both hold a hand");
    let lefts = run.lefts();
    let start = run.last(1).0;
    let from = run.rows().len();
    // One leg along where Soul 2 stands from Soul 1 turned square (the way they face, or its back), then one square
    // to it.
    let f = run.last(2).0;
    let (sx, sz) = (f.x - start.x, f.z - start.z);
    let s = ((i128::from(sx).pow(2) + i128::from(sz).pow(2)).isqrt()).max(1);
    let six = |c: i64| (i128::from(c) * 6_000_000 / s) as i64;
    let legs = [(six(-sz), six(sx)), (-six(sx), -six(sz))];
    let mut at = start;
    let mut placed = Vec::new();
    for (dx, dz) in legs {
        at = Vec3::new(at.x + dx, 0, at.z + dz);
        a.act("eden:walk", Some(ground()), &[(1, walk_to(at.x, at.z))])
            .unwrap_or_else(|e| panic!("Soul 1 walks to {at:?}: {e}"));
        std::thread::sleep(Duration::from_millis(1_500));
        placed.push(beside(&run));
    }
    let (mut l, mut f, mut far, mut step) = (start, f, 0_i64, 0_i64);
    for (body, p) in run.rows().into_iter().skip(from) {
        if body == soul(1) {
            l = p;
        } else if body == soul(2) {
            step = step.max(len(p, f));
            f = p;
        } else {
            continue;
        }
        far = far.max(len(f, l));
    }
    println!(
        "r1: walking hand in hand, at most {} mm apart and {} mm a tick; stopped after each leg, Soul 2 stood (along, across) {:?} mm",
        far / 1000,
        step / 1000,
        placed
            .iter()
            .map(|p| (p.0 / 1000, p.1 / 1000))
            .collect::<Vec<_>>()
    );
    assert!(
        len(run.last(1).0, start) >= 8_000_000,
        "Soul 1 walked both legs"
    );
    assert!(far <= 1_200_000, "beside, never trailing far: {far} µm");
    assert!(
        step <= 200_000,
        "walked, never placed: {step} µm in one tick"
    );
    for (along, across) in &placed {
        assert!(
            along.abs() <= 200_000,
            "beside, not ahead or behind: {along} µm"
        );
        assert!(
            (across.abs() - 500_000).abs() <= 150_000,
            "0.5 m to the side: {across} µm"
        );
    }
    assert!(
        placed[0].1.signum() == placed[1].1.signum(),
        "on the same side of Soul 1 through the turn: {placed:?}"
    );
    assert!(run.ended().is_empty(), "both still hold hands");
    assert_eq!(run.lefts(), lefts, "nobody left");

    // Soul 2 steps off on its own, 0.3 m: it lets go, for both.
    let here = run.last(2).0;
    b.act(
        "eden:walk",
        Some(ground()),
        &[(1, walk_to(here.x + 300_000, here.z))],
    )
    .expect("Soul 2 walks off");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(run.ended().len(), 2, "both hands come free");
    assert_eq!(run.lefts(), lefts + 2, "the hold is over for both");

    // Back beside Soul 1 (a walk of a Soul in no hold), held again; Soul 1 leads, then leaves.
    b.act("eden:walk", Some(ground()), &[(1, walk_to(here.x, here.z))])
        .expect("Soul 2 steps back");
    let again = run.created(&a.offer(HOLD_AT, 2).expect("offered again"));
    b.act("activity:accept", Some(again), &[])
        .expect("accepted again");
    std::thread::sleep(Duration::from_millis(1_500));
    let ended = run.named("souls:order-ended").len();
    let p = run.last(1).0;
    a.act(
        "eden:walk",
        Some(ground()),
        &[(1, walk_to(p.x, p.z - 3_000_000))],
    )
    .expect("Soul 1 leads");
    let orders = run.named("souls:order").len();
    let lefts = run.lefts();
    a.act("activity:leave", Some(again), &[])
        .expect("Soul 1 lets go");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(run.lefts(), lefts + 2, "the hold is over for both");
    assert_eq!(
        run.named("souls:order-ended").len(),
        ended + 1,
        "Soul 2's order beside Soul 1 ended with it"
    );
    let stood = run.last(2).0;
    a.act(
        "eden:walk",
        Some(ground()),
        &[(1, walk_to(p.x + 3_000_000, p.z - 3_000_000))],
    )
    .expect("Soul 1 walks alone");
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        len(run.last(2).0, stood) <= 10_000,
        "Soul 2 stays where it stood: {:?} then {:?}",
        stood,
        run.last(2).0
    );
    assert_eq!(
        run.named("souls:order").len(),
        orders,
        "no order after the hold"
    );
    println!(
        "r1: Soul 2's walk let go for both; held again, Soul 1's leave let go and ended Soul 2's order"
    );
    run.stop();
}

/// 0.135 R1: a hold walking hand in hand does not outlast a restart. After the leader's walk (an act is answered once
/// its walk is done), with Soul 2's order beside it open, the world stops; after it starts again from its log, the
/// hold ends for both at once (its hands came apart: moves are not stored), Soul 2's order beside Soul 1, which the
/// log brought back, is cancelled, and the same two can hold hands again: neither is left stuck.
#[test]
fn r1_a_restart_ends_a_hold_hand_in_hand_for_both() {
    let run = serve("hand-restart");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let hold = run.created(&a.offer(HOLD, 2).expect("offered"));
    b.act("activity:accept", Some(hold), &[]).expect("accepted");
    std::thread::sleep(Duration::from_millis(1_000));
    a.act(
        "eden:walk",
        Some(ground()),
        &[(1, walk_to(-40_000_000, 32_000_000))],
    )
    .expect("Soul 1 leads");
    std::thread::sleep(Duration::from_millis(300));
    let orders = run.named("souls:order");
    assert_eq!(orders.len(), 1, "Soul 2's own order beside Soul 1");
    let lefts = run.lefts();
    let Run { world, store, path } = run;
    world.stop();
    let _ = std::fs::remove_file(&path);
    let run = serve_on("hand-restart-2", store);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        run.lefts(),
        lefts + 2,
        "the hold ended for both at the restart"
    );
    assert_eq!(
        run.named("souls:order-ended"),
        orders,
        "the order beside Soul 1 was cancelled"
    );
    let touches = run.touches().len();
    let (mut a, mut b) = (run.client(1), run.client(2));
    a.2 = 100;
    b.2 = 100;
    let again = run.created(&a.offer(HOLD, 2).expect("offered after the restart"));
    b.act("activity:accept", Some(again), &[])
        .expect("accepted after the restart");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        run.touches().len(),
        touches + 2,
        "the next hold plays both moves: neither was stuck"
    );
    println!("r1: a restart ended the hold for both and cancelled the order; the next hold played");
    run.stop();
}

/// 0.135 R1: a sit (or a lie, the same path) by either Soul lets go of a hold, for both. Souls 1 and 2 hold hands and
/// Soul 1 walks to the chair, leading, Soul 2 beside it; Soul 1's sit then frees both hands and both leave the hold.
/// Soul 1 rises, Soul 2 comes back beside it, and they hold hands standing (nobody leads); Soul 1 sits again, and that
/// lets go for both too.
#[test]
fn r1_a_sit_by_either_lets_go_of_a_hold() {
    let run = serve("hand-sit");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let hold = run.created(&a.offer(HOLD, 2).expect("offered"));
    b.act("activity:accept", Some(hold), &[]).expect("accepted");
    std::thread::sleep(Duration::from_millis(1_000));
    let lefts = run.lefts();
    a.act("eden:walk", Some(chair()), &[])
        .expect("Soul 1 leads to the chair");
    assert_eq!(run.lefts(), lefts, "walking hand in hand");
    a.act("eden:sit", Some(chair()), &[]).expect("Soul 1 sits");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(run.lefts(), lefts + 2, "the leader's sit let go, for both");
    assert_eq!(run.ended().len(), 2, "both hands came free");

    a.act("eden:rise", None, &[]).expect("Soul 1 rises");
    let p = run.last(1).0;
    b.act(
        "eden:walk",
        Some(ground()),
        &[(1, walk_to(p.x - 500_000, p.z))],
    )
    .expect("Soul 2 comes back beside");
    let again = run.created(&a.offer(HOLD, 2).expect("offered again"));
    b.act("activity:accept", Some(again), &[])
        .expect("accepted again");
    std::thread::sleep(Duration::from_millis(1_000));
    let lefts = run.lefts();
    a.act("eden:sit", Some(chair()), &[])
        .expect("Soul 1 sits, standing hand in hand");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        run.lefts(),
        lefts + 2,
        "a sit in a standing hold let go, for both"
    );
    assert_eq!(run.ended().len(), 4, "both hands came free again");
    println!("r1: a sit by the leader, and a sit in a standing hold, each let go for both");
    run.stop();
}

impl Run {
    /// The moves written for viewers in `activity`: the body, the move, its target and its planned last end.
    fn played(&self, activity: Id) -> Vec<(Id, String, Id, Micros)> {
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| {
                ev.name.as_str() == "souls:form-move"
                    && read_id(&ev.fields[&1]).ok() == Some(activity)
            })
            .map(|ev| {
                let Value::Map(r) = &ev.fields[&3] else {
                    panic!("a move record")
                };
                let Some(Value::Array(ends)) = r.get(&8) else {
                    panic!("its phase ends")
                };
                let Some(Value::Uint(last)) = ends.last() else {
                    panic!("an end")
                };
                let Some(Value::Bytes(mv)) = r.get(&2) else {
                    panic!("a move's name")
                };
                (
                    read_id(&ev.fields[&2]).unwrap(),
                    String::from_utf8(mv.clone()).unwrap(),
                    read_id(&r[&5]).unwrap(),
                    *last as Micros,
                )
            })
            .collect()
    }

    /// When each member left `activity`.
    fn left_from(&self, activity: Id) -> Vec<Micros> {
        self.entries()
            .into_iter()
            .filter(|e| e.envelope.node == activity)
            .filter(|e| {
                e.events
                    .iter()
                    .flatten()
                    .any(|ev| ev.name.as_str() == "souls:activity-left")
            })
            .map(|e| e.envelope.at)
            .collect()
    }
}

/// Verifying #4456 and #4482: a greeting whose roles each name one aimed move (a bow, a nod, a host's point) was
/// accepted and ended within 2 s with neither move drawn on the old page, while a returned wave (#4459) was. The engine
/// is not where it is lost: each greeting, read from its own entry, plays each member's move once, aimed at the other
/// member, with no `on_beat`, and then ends, both members leaving it after their moves' last phase. A gaze-claiming
/// move (bow, nod, point) starts as a wave does: nothing else holds a body's gaze when an activity starts.
#[test]
fn greetings_play_each_members_aimed_move_once_then_end() {
    let run = serve("greet");
    let (mut a, mut b) = (run.client(1), run.client(2));
    for (kind, role, first, second) in [
        (WAVE, "eden:one", "souls:wave", "souls:wave"),
        (BOW, "eden:one", "souls:bow", "souls:bow"),
        (NOD, "eden:one", "souls:nod", "souls:nod"),
        (INTRO, "eden:host", "souls:point", "souls:bow"),
    ] {
        let lefts = run.lefts();
        let offered = a
            .act(
                "activity:offer",
                Some(ground()),
                &[
                    (1, Value::Text(name(&full(kind)))),
                    (2, Value::Text(name(role))),
                    (3, Value::Array(vec![soul(2).to_value()])),
                ],
            )
            .unwrap_or_else(|r| panic!("{kind}: offered: {r}"));
        let greeting = run.created(&offered);
        b.act("activity:accept", Some(greeting), &[])
            .unwrap_or_else(|r| panic!("{kind}: accepted: {r}"));
        // Both walk about a metre to their places, then make their moves (at most 1.5 s), then it ends.
        std::thread::sleep(Duration::from_millis(4_500));
        let played = run.played(greeting);
        let left = run.left_from(greeting);
        println!("{kind}: played {played:?}; left at {left:?}");
        let mut by: Vec<(Id, &str, Id)> = played.iter().map(|p| (p.0, p.1.as_str(), p.2)).collect();
        by.sort();
        assert_eq!(
            by,
            vec![(soul(1), first, soul(2)), (soul(2), second, soul(1))],
            "{kind}: each member's move, once, aimed at the other"
        );
        assert_eq!(run.lefts(), lefts + 2, "{kind}: both left by themselves");
        let last = played.iter().map(|p| p.3).max().unwrap();
        assert!(
            left.iter().all(|t| *t >= last),
            "{kind}: it ends after the moves' last phase ({last} µs): {left:?}"
        );
    }
    run.stop();
}
