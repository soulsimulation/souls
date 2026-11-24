//! The team gate's rungs 0 and 1 (0.135 C1 #4051, C2): two Souls carry loads together through the real gateway, each
//! step its own intent, on one connection and one token each. Each load is carried as its kind's entry states it
//! (`content/kinds/construction/`): its grips, its outline and its carriers' places.
//!
//! On N2's test world, two Souls stand 4 m west of a rack beam's two carrying places, at its ends. Each walks to its
//! place by an ordinary walk. Soul 1 offers a carry to Soul 2 (E8's offer, Soul 1 in front). While Soul 1 is alone in
//! it, its lift is refused `carry-needs-two`. Soul 2 accepts, so the carry starts; Soul 1 lifts the beam, both walk
//! 25 m east side by side, and Soul 2 sets it down. Then they carry a rack upright, which is shorter and wider, 25 m west, Soul 2 in front. Before
//! that, a lift naming a way through a passage narrower than the upright is refused `carry-board-clips`. Last, in a
//! third carry, a crate that takes three is refused `carry-crew-too-small`, and the beam, now 25 m off, is refused
//! `carry-grip-out-of-reach`; neither moves. Every node of the world as built is still there and no other is, and the
//! log's effects replayed onto the world as built give the state hash its last part holds. A blocked set-down is not
//! built yet: it prints "not reached", which is not a failure.

// The scene times how long each leave's answer takes (rung 2): a measure, never in the world's log.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, resume, socket, world_link};
use import_eden::Import;
use replica::activity::ActivityKind;
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::Minter;
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL, Target};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::{Value as Json, parse};
use replica::tree::Rules as TreeRules;
use replica::views::{Key, Level, Redactions};
use replica::world_model::{Audience, Kind};
use sim::activity::carry::Load;
use sim::ground::scene::F_SOLIDS;
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::text::Store;
use sim::walk::town::Town;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::answers::{self, BODIES, Config, STATE};
use worldd::bodies::{Bodies, Placed, read_row};
use worldd::checkers::Rules;
use worldd::view_out::{Writer, follow};
use worldd::views::Tier;
use worldd::words;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0x13, 0x51];
const LINEAGE: Scope = Scope([0x7d; 16]);
const M: i64 = 1_000_000;
/// How far the two carry each load, µm.
const CARRIED: i64 = 25 * M;

const PLACE: &str = "souls:place";
/// The open ground, as the carry's sweep reads it (`sim::ground::scene::GROUND`): a child of the zone's root.
const GROUND: &str = "eden:ground";
const WALKER: &str = "test:body"; // K1: a body as the old page knows one (`:body`), so the scene draws its carriers
const BEAM: &str = "mars:rack_beam";
const UPRIGHT: &str = "mars:rack_upright";
const CRATE: &str = "test:crate";
const WALL: &str = "test:wall";
const CARRY: &str = "test:carry";
/// A carry whose offer lapses in half a second (0.135 C3).
const BRIEF: &str = "test:brief_carry";
/// A carry that takes up to six (the crew test): the kind's members at most.
const CREW: &str = "test:crew_carry";
/// How many Souls the crew test's world holds.
const CREW_SOULS: u64 = 5;
const FRONT: &str = "test:front";
const BACK: &str = "test:back";

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

/// The kinds in pinned order: (plain name, full name).
fn kinds() -> Vec<(&'static str, String)> {
    [
        PLACE, GROUND, WALKER, BEAM, UPRIGHT, CRATE, WALL, CARRY, BRIEF, CREW,
    ]
    .iter()
    .enumerate()
    .map(|(i, k)| (*k, format!("{k}@1220{}{:02x}", "00".repeat(31), i + 1)))
    .collect()
}

fn full(plain: &str) -> String {
    kinds().into_iter().find(|(p, _)| *p == plain).unwrap().1
}

/// A kind as an intent through the gateway names it: its plain name and its hash's bytes (`engine::param_kind`), so
/// no text is longer than an intent's limit.
fn pinned(plain: &str) -> Value {
    let f = full(plain);
    let (_, hex) = f.split_once('@').unwrap();
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    Value::Array(vec![Value::Text(name(plain)), Value::Bytes(bytes)])
}

fn id(n: u64) -> Id {
    Id::new(Scope([0x7e; 16]), n).unwrap()
}

/// The Souls (each Soul's id is its body's here; the crew test's third to fifth after the walls), the loads and the
/// passage's two walls.
fn soul(n: u64) -> Id {
    if n <= 2 { id(n) } else { id(20 + n) }
}
fn beam() -> Id {
    id(3)
}
fn upright() -> Id {
    id(4)
}
fn crate_() -> Id {
    id(5)
}
fn wall(n: u64) -> Id {
    id(5 + n)
}

/// A load's carrying places from its kind's entry (as the engine reads them, `sim::activity::carry::Load`): the
/// back's and the front's, along the carry from its middle, µm.
fn places(entry: &Json) -> [i64; 2] {
    Load::of(entry).expect("a load").places()
}

fn beam_entry() -> Json {
    parse(include_str!(
        "../../../../../content/kinds/construction/rack_beam.json"
    ))
    .unwrap()
}
fn upright_entry() -> Json {
    parse(include_str!(
        "../../../../../content/kinds/construction/rack_upright.json"
    ))
    .unwrap()
}
/// A crate that takes three to carry.
fn crate_entry() -> Json {
    parse(
        r#"{"format": "souls-entry/1", "kind": "test:crate", "owner": "thing",
            "state": {"hold_crew": {"n": 28, "type": "int", "unit": "count", "default": 3, "audience": {"rule": "everyone"}}},
            "points": {"grip_a": {"role": "grip", "at_mm": [0, 300, -500]}, "grip_b": {"role": "grip", "at_mm": [0, 300, 500]}},
            "geometry": {"bounds_mm": [800, 600, 1200]}, "motion": {"how": "two_souls"}, "loose": {"ever": true},
            "text": {"card": "card"}, "card": {"text": "card"}}"#,
    )
    .unwrap()
}

/// The world's entries, by kind.
fn entries() -> Json {
    Json::Obj(vec![
        (BEAM.into(), beam_entry()),
        (UPRIGHT.into(), upright_entry()),
        (CRATE.into(), crate_entry()),
    ])
}

/// The beam's middle on the test world's open ground, west of the square; it is carried 25 m east.
fn beam_at() -> Vec3 {
    Vec3::new(-41_400_000, 0, 26_000_000)
}
/// The upright's middle, 4 m north of where the beam is set down; it is carried 25 m west.
fn upright_at() -> Vec3 {
    Vec3::new(beam_at().x + CARRIED, 0, 30_000_000)
}
fn crate_at() -> Vec3 {
    Vec3::new(-30_000_000, 0, 20_000_000)
}
/// Two walls north of the upright's way west: between them a passage 0.9 m wide, narrower than the upright (1.22 m),
/// on the way from its front 10 m west and 10 m north. Each is (middle, half its length along z), µm.
fn walls() -> [(Vec3, i64); 2] {
    [
        (Vec3::new(-22_500_000, 0, 33_050_000), 1_550_000),
        (Vec3::new(-22_500_000, 0, 37_750_000), 2_250_000),
    ]
}

/// Where a carrier of the load whose middle is `middle` stands, its place `along` µm along the carry, heading `east`
/// or west.
fn place(middle: Vec3, along: i64, east: bool) -> Vec3 {
    Vec3::new(middle.x + if east { along } else { -along }, 0, middle.z)
}
/// Where a carrier of the beam whose middle is `middle` stands, `along` µm from it at one of its ends: the beam lies
/// with its length along z, and its front is north (0.135 C4: its carriers stand at its ends, not beside it).
fn at_end(middle: Vec3, along: i64) -> Vec3 {
    Vec3::new(middle.x, 0, middle.z + along)
}
/// Each Soul starts 4 m west of its place at the beam: Soul 1 in front (north), Soul 2 behind. The crew test's
/// third to fifth stand 4 m west of the crate and south of it, off every carry's way.
fn start(n: u64) -> Vec3 {
    if n > 2 {
        return Vec3::new(crate_at().x - 4 * M, 0, crate_at().z - (n as i64) * M);
    }
    let [back, front] = places(&beam_entry());
    let p = at_end(beam_at(), if n == 1 { front } else { back });
    Vec3::new(p.x - 4 * M, 0, p.z)
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
        ],
    }
}

/// N2's test world as a town and its ground: the replica's zone is rooted at that ground.
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c1-town/1").to_bytes()),
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

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c1-team/1").to_bytes()),
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

/// The world's rules: the ground takes bodies, things and carries; the loads are held in two hands; the carry has a
/// slot for what it carries.
fn tree_rules() -> TreeRules {
    let k = |owner: &str, children: &[&str], slots: &[u64], hands| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: slots
            .iter()
            .map(|s| (*s, BTreeSet::from(["thing".to_owned()])))
            .collect(),
        hands,
        fields: Default::default(),
    };
    TreeRules {
        kinds: BTreeMap::from([
            (full(PLACE), k("place", &[GROUND], &[], None)),
            (
                full(GROUND),
                k("place", &["body", "thing", CARRY, BRIEF, CREW], &[], None),
            ),
            (full(WALKER), k("family", &[], &[1, 2], None)),
            (full(BEAM), k("thing", &[], &[], Some(2))),
            (full(UPRIGHT), k("thing", &[], &[], Some(2))),
            (full(CRATE), k("thing", &[], &[], Some(2))),
            (full(WALL), k("thing", &[], &[], None)),
            (full(CARRY), k("activity", &[], &[1], None)),
            (full(BRIEF), k("activity", &[], &[1], None)),
            (full(CREW), k("activity", &[], &[1], None)),
        ]),
        souls: (1..=CREW_SOULS).map(soul).collect(),
        audiences: BTreeMap::new(),
    }
}

/// The carry's kind: two roles that claim only the voice, so its members walk while in it.
fn carry_kind() -> ActivityKind {
    carry_of(CARRY, 60_000_000)
}

/// A carry's kind of plain name `plain`, whose offer lasts `lasts` µs.
fn carry_of(plain: &str, lasts: u64) -> ActivityKind {
    carry_most(plain, lasts, None)
}

/// [`carry_of`] taking up to `most` members (two when none), as a dance offered to several does (0.134 T3).
fn carry_most(plain: &str, lasts: u64, most: Option<u64>) -> ActivityKind {
    let role = |r: &str| {
        Value::Map(BTreeMap::from([
            (1, Value::Text(name(r))),
            (2, Value::Text(name(&format!("{r}-place")))),
            (
                3,
                Value::Array(vec![Value::Map(BTreeMap::from([
                    (1, Value::Uint(2)),
                    (2, Value::Uint(4)),
                ]))]),
            ),
        ]))
    };
    let mut m = BTreeMap::from([
        (1, Value::Text(name(&full(plain)))),
        (2, Value::Uint(1)),
        (3, Value::Array(vec![role(FRONT), role(BACK)])),
        (4, Value::Uint(lasts)),
        (5, Value::Uint(400_000)),
    ]);
    if let Some(most) = most {
        m.insert(6, Value::Uint(most));
    }
    ActivityKind::from_value(&Value::Map(m)).expect("the carry's kind")
}

fn create(node: Id, kind: &str, parent: Id, at: Vec3) -> (Id, Change) {
    (
        parent,
        Change::Create {
            node,
            kind: name(&full(kind)),
            pose: Pose {
                frame: Frame {
                    node: parent,
                    slot: None,
                },
                position: at,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: parent,
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        },
    )
}

/// The world as built: the two Souls at their starts, the three loads and the two walls.
fn world() -> Replica {
    world_of(2)
}

/// [`world`] with `souls` Souls at their starts (the crew test's five).
fn world_of(souls: u64) -> Replica {
    let g = ground();
    let root = id(100);
    let h = header(root);
    let mut r = Replica::start(h.stored()).expect("a replica");
    let (_, mut open) = create(g, GROUND, root, Vec3::ZERO);
    if let Change::Create { pose, .. } = &mut open {
        pose.support = Support::None;
    }
    let mut changes = vec![(root, open)];
    changes.extend((1..=souls).map(|n| create(soul(n), WALKER, g, start(n))));
    changes.extend([
        create(beam(), BEAM, g, beam_at()),
        create(upright(), UPRIGHT, g, upright_at()),
        create(crate_(), CRATE, g, crate_at()),
    ]);
    let solid = |hz: i64| {
        Value::Array(vec![Value::Array(
            [0, 0, 100, hz / 1000, 0, 0, 2_500]
                .iter()
                .map(|v| int(*v))
                .collect(),
        )])
    };
    for (n, (at, hz)) in walls().into_iter().enumerate() {
        let (parent, mut c) = create(wall(n as u64 + 1), WALL, g, at);
        if let Change::Create { fields, .. } = &mut c {
            fields.insert(F_SOLIDS, solid(hz));
        }
        changes.push((parent, c));
    }
    let effects: Vec<Value> = changes
        .into_iter()
        .enumerate()
        .map(|(k, (node, change))| {
            Effect {
                envelope: Envelope {
                    sequence: k as u64,
                    at: 0,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node,
                },
                body: Body::Changes(vec![ChangeRec {
                    change,
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

/// The bodies, each where the log last had it on a restart (`placed`), else at its start.
fn bodies(placed: &Placed) -> Result<Bodies, replica::effects::Refusal> {
    bodies_of(2, placed)
}

/// [`bodies`] of `souls` Souls.
fn bodies_of(souls: u64, placed: &Placed) -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let at = (1..=souls)
        .map(|n| town.surfaces[&ground].place(soul(n), frame, start(n), Quat::IDENTITY))
        .collect::<Result<Vec<_>, _>>()?;
    let mut b = Bodies::new(town, 50_000)?;
    for p in at {
        b.add_body_at(humanoid(), p, placed)?;
    }
    Ok(b)
}

fn int(v: i64) -> Value {
    u64::try_from(v).map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
}

fn point(p: Vec3) -> BTreeMap<u64, Value> {
    BTreeMap::from([(1, Value::Array(vec![int(p.x), int(p.y), int(p.z)]))])
}

/// One Soul on its own gateway connection, signed in with its own token.
struct Soul {
    ws: Ws,
    id: Id,
    sequence: u64,
}

impl Soul {
    async fn connect(url: &str, id: Id, token: &Token) -> Soul {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let hello = Hello {
            protocol: PROTOCOL,
            build: BUILD.to_vec(),
            refused: None,
            other: None,
        };
        put(&mut ws, hello.to_bytes().unwrap()).await;
        next(&mut ws).await;
        let sign_in = BTreeMap::from([(1, Value::Text(name(token.reveal())))]);
        put(&mut ws, encode(&Value::Map(sign_in)).unwrap()).await;
        let Value::Map(o) = next(&mut ws).await else {
            panic!("an outcome")
        };
        assert_eq!(o.get(&4), Some(&Value::Text(name(resume::STARTED))));
        Soul {
            ws,
            id,
            sequence: 0,
        }
    }

    async fn send(&mut self, verb: &str, target: Option<Id>, parameters: BTreeMap<u64, Value>) {
        self.sequence += 1;
        let i = Intent {
            actor: Actor::Soul(self.id),
            verb: name(verb),
            target: target.map(Target::Node),
            parameters,
            sequence: self.sequence,
            basis: Version {
                lineage: LINEAGE,
                zone: Id::new(LINEAGE, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: answers::now() + 120_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        put(&mut self.ws, encode(&i.to_value()).unwrap()).await;
    }

    /// The answer to this Soul's last intent: a receipt's entries, or a refusal's reason. A progress answer (a walk
    /// or a run accepted, kind 3) is read past.
    async fn answer(&mut self) -> Result<Vec<u64>, String> {
        loop {
            let Value::Map(f) = next(&mut self.ws).await else {
                continue;
            };
            let Some(Value::Map(a)) = f.get(&2) else {
                continue;
            };
            if a.get(&2) != Some(&Value::Uint(self.sequence)) {
                continue;
            }
            match (a.get(&3), a.get(&5)) {
                (Some(Value::Uint(1)), Some(Value::Array(e))) => {
                    return Ok(e
                        .iter()
                        .map(|v| match v {
                            Value::Uint(n) => *n,
                            _ => panic!("an entry"),
                        })
                        .collect());
                }
                (Some(Value::Uint(1)), _) => return Ok(Vec::new()),
                (Some(Value::Uint(2)), _) => {
                    return Err(match a.get(&4) {
                        Some(Value::Text(t)) => t.as_str().to_owned(),
                        other => format!("{other:?}"),
                    });
                }
                _ => continue,
            }
        }
    }

    async fn act(
        &mut self,
        verb: &str,
        target: Option<Id>,
        parameters: BTreeMap<u64, Value>,
    ) -> Result<Vec<u64>, String> {
        self.send(verb, target, parameters).await;
        self.answer().await
    }
}

async fn next(ws: &mut Ws) -> Value {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(60), ws.next())
            .await
            .expect("an answer within 60 s")
            .expect("the socket is open")
            .expect("a message");
        if let Message::Binary(b) = m {
            return decode(&b).unwrap().value;
        }
    }
}

async fn put(ws: &mut Ws, bytes: Vec<u8>) {
    ws.send(Message::Binary(bytes.into())).await.unwrap();
}

/// Every effect the log holds, in order, and each part's body rows and state hash.
struct Logged {
    parts: Vec<Part>,
}

impl Logged {
    fn read(store: &Mem) -> Logged {
        let log = store.0.lock().unwrap().bytes.clone();
        let parts = recover(&log)
            .unwrap()
            .records
            .into_iter()
            .filter(|r| !sim::recorder::is_input(r))
            .map(|r| Part::read(&r).unwrap())
            .collect();
        Logged { parts }
    }

    /// The node created by the entries numbered `seq`, of kind `kind`.
    fn created(&self, seq: &[u64], kind: &str) -> Id {
        for e in self.parts.iter().flat_map(|p| p.effects.iter()) {
            if !seq.contains(&e.envelope.sequence) {
                continue;
            }
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    if let Change::Create { node, kind: k, .. } = &c.change
                        && k.as_str() == full(kind)
                    {
                        return *node;
                    }
                }
            }
        }
        panic!("no {kind} created in {seq:?}")
    }

    /// The world as built with every logged effect applied, and the state hash that gives (`answers::state_hash`,
    /// the bodies' poses from the world's start and each part's rows), beside the one the last part holds.
    fn replay(&self) -> (Replica, [u8; 32], Vec<u8>) {
        let mut r = world();
        let mut poses: BTreeMap<Id, Pose> = bodies(&Placed::new())
            .unwrap()
            .poses()
            .into_iter()
            .collect();
        let mut last = Vec::new();
        for p in &self.parts {
            if !p.effects.is_empty() {
                r.apply(p).expect("the log replays");
            }
            if let Some(Value::Array(rows)) = p.rest.get(&BODIES) {
                for (body, pose, _) in rows.iter().filter_map(read_row) {
                    poses.insert(body, pose);
                }
            }
            if let Some(Value::Bytes(h)) = p.rest.get(&STATE) {
                last = h.clone();
            }
        }
        let tree = r.tree_for_seal().state_hashes().expect("the tree's hashes");
        let poses: Vec<(Id, Pose)> = poses.into_iter().collect();
        let hash = answers::state_hash(&tree, &poses);
        (r, hash, last)
    }
}

fn nodes(r: &Replica) -> BTreeSet<Id> {
    let t = r.tree();
    let mut out = BTreeSet::new();
    let mut stack = vec![t.root()];
    while let Some(h) = stack.pop() {
        if let Some(n) = t.node(h) {
            out.insert(n.id());
        }
        stack.extend(t.children(h).into_iter().flatten().copied());
    }
    out
}

/// K1 (0.135): with `TEAM_GATE_WWW=<dir>`, the scene's world also writes its public stream under `<dir>` (as
/// `worldd gateway-link --www` does), so the old page can play the carry; `TEAM_GATE_HOLD=<s>` keeps the world up that
/// long after the scene and `TEAM_GATE_WAIT=<s>` before it, to watch. Unset, nothing changes.
fn watch(cfg: &mut Config) {
    let Ok(www) = std::env::var("TEAM_GATE_WWW") else {
        return;
    };
    let www = PathBuf::from(www);
    let text = Arc::new(
        Store::open_dir(&www.join("text"), Minter::new(words::scope(LINEAGE)))
            .expect("the text store"),
    );
    cfg.text = Some(Arc::clone(&text));
    let built = world();
    let header = built.header().clone();
    let start = built.tree().to_state();
    let key = Key {
        node: start.root,
        level: Level::Full,
        audience: Audience::Everyone,
    };
    cfg.follow = Some(Box::new(move |durable| {
        let tier = Tier::start(
            header.clone(),
            start.clone(),
            Redactions::default(),
            durable,
        )
        .expect("the view tier");
        let sub = tier.subscribe(vec![key], 1 << 16);
        let now = answers::now();
        let anchor = (now, u64::try_from(now / 1_000).unwrap_or(0));
        let writer = Writer::fork_with_text(&www, &header, &key, anchor, &start, Some(text))
            .expect("the stream writer");
        println!(
            "team gate: stream {}",
            writer
                .dir()
                .strip_prefix(&www)
                .unwrap_or(writer.dir())
                .display()
        );
        drop(follow(
            writer,
            sub,
            Arc::new(AtomicBool::new(false)),
            answers::now,
        ));
        Box::new(move |n, bytes| tier.offer(n, bytes))
    }));
}

/// K1: `TEAM_GATE_WAIT` seconds before the scene (a page opens on the world) and `TEAM_GATE_HOLD` after it, else none.
async fn hold(var: &str) {
    if let Some(s) = std::env::var(var).ok().and_then(|v| v.parse::<u64>().ok()) {
        tokio::time::sleep(Duration::from_secs(s)).await;
    }
}

fn socket_path(tag: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("team-{tag}-{}.sock", std::process::id()))
}

/// The world, from `store`'s log if it has one, serving the gateway's link on `path`; `watched`, its stream written
/// for the old page as K1's [`watch`] says (rungs 0 and 1).
fn start_world(store: &Mem, path: &std::path::Path, watched: bool) -> answers::World {
    start_world_of(store, path, watched, 2)
}

/// [`start_world`] with `souls` Souls (the crew test's five).
fn start_world_of(
    store: &Mem,
    path: &std::path::Path,
    watched: bool,
    souls: u64,
) -> answers::World {
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.measures = false;
    cfg.bodies = Some(Box::new(move |p: &Placed| bodies_of(souls, p)));
    cfg.engine = Some((
        tree_rules(),
        vec![
            carry_kind(),
            carry_of(BRIEF, 500_000),
            carry_most(CREW, 60_000_000, Some(6)),
        ],
    ));
    if watched {
        watch(&mut cfg);
    }
    let rules = Rules {
        kinds: entries(),
        moves: Json::Obj(Vec::new()),
    };
    let served =
        answers::start(world_of(souls), rules, store.clone(), cfg).expect("the world starts");
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).unwrap();
    let door = served.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let d = door.clone();
            std::thread::spawn(move || answers::serve(d, stream));
        }
    });
    served
}

/// The gateway in front of the world on `path`, and one token for each Soul.
struct Gate {
    url: String,
    issued: Vec<Token>,
}

async fn gate(path: &std::path::Path) -> Gate {
    gate_of(path, 2).await
}

/// [`gate`] with a token for each of `souls` Souls.
async fn gate_of(path: &std::path::Path, souls: u64) -> Gate {
    let mut tokens = Tokens::default();
    let issued: Vec<Token> = (1..=souls)
        .map(|n| {
            let grant = Grant::Actor(Actor::Soul(soul(n)));
            let t = Token::issue(grant).unwrap();
            tokens.add(grant, t.hash());
            t
        })
        .collect();
    let log: Log = std::sync::Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    tokio::spawn(world_link::run(gw.clone(), path.to_path_buf()));
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", tcp.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    Gate { url, issued }
}

#[tokio::test(flavor = "multi_thread")]
async fn rungs_0_and_1_two_souls_carry_loads_as_their_entries_state_through_the_gateway() {
    let store = Mem::with(Vec::new());
    let path = socket_path("c1");
    let served = start_world(&store, &path, true);
    let Gate { url, issued } = gate(&path).await;
    let mut a = Soul::connect(&url, soul(1), &issued[0]).await;
    let mut b = Soul::connect(&url, soul(2), &issued[1]).await;
    let g = ground();
    let mut steps = Vec::new();
    hold("TEAM_GATE_WAIT").await;

    // The beam: each walks to its place by an ordinary walk.
    let [back, front] = places(&beam_entry());
    a.send("eden:walk", Some(g), point(at_end(beam_at(), front)))
        .await;
    b.send("eden:walk", Some(g), point(at_end(beam_at(), back)))
        .await;
    let (wa, wb) = (a.answer().await, b.answer().await);
    wa.expect("Soul 1 walks to the beam's front place");
    wb.expect("Soul 2 walks to the beam's back place");
    steps.push("walked to the beam");

    // Soul 1 offers the carry to Soul 2; alone in it, its lift is refused by name.
    let first = offer(&mut a, 2, &store).await;
    let alone = a.act("carry:lift", Some(first), lift(beam(), None)).await;
    assert_eq!(alone, Err("carry-needs-two".to_owned()), "a Soul alone");
    b.act("activity:accept", Some(first), BTreeMap::new())
        .await
        .expect("Soul 2 accepts, and the carry starts");
    a.act("carry:lift", Some(first), lift(beam(), None))
        .await
        .expect("the beam lifted");
    let on = |p: Vec3, by: i64| Vec3::new(p.x + by, 0, p.z);
    a.send(
        "eden:walk",
        Some(g),
        point(on(at_end(beam_at(), front), CARRIED)),
    )
    .await;
    b.send(
        "eden:walk",
        Some(g),
        point(on(at_end(beam_at(), back), CARRIED)),
    )
    .await;
    let (wa, wb) = (a.answer().await, b.answer().await);
    wa.expect("the front carries the beam 25 m");
    wb.expect("the back carries the beam 25 m");
    b.act("carry:set-down", Some(first), BTreeMap::new())
        .await
        .expect("the beam set down");
    for s in [&mut a, &mut b] {
        s.act("activity:leave", Some(first), BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }
    steps.push("carried the beam 25 m");

    // The upright, west, Soul 2 in front: each walks to its place.
    let [back, front] = places(&upright_entry());
    b.send(
        "eden:walk",
        Some(g),
        point(place(upright_at(), front, false)),
    )
    .await;
    a.send(
        "eden:walk",
        Some(g),
        point(place(upright_at(), back, false)),
    )
    .await;
    let (wb, wa) = (b.answer().await, a.answer().await);
    wb.expect("Soul 2 walks to the upright's front place");
    wa.expect("Soul 1 walks to the upright's back place");
    let second = offer(&mut b, 1, &store).await;
    a.act("activity:accept", Some(second), BTreeMap::new())
        .await
        .expect("Soul 1 accepts");
    // A way 10 m west and 10 m north goes through the 0.9 m passage: refused before the lift, and nothing moves.
    let narrow = Vec3::new(
        place(upright_at(), front, false).x - 10 * M,
        0,
        upright_at().z + 10 * M,
    );
    let clips = b
        .act("carry:lift", Some(second), lift(upright(), Some(narrow)))
        .await;
    assert!(
        clips.as_ref().is_err_and(|r| r == "carry-board-clips"),
        "a passage too narrow: {clips:?}"
    );
    let ahead = on(place(upright_at(), front, false), -CARRIED);
    b.act("carry:lift", Some(second), lift(upright(), Some(ahead)))
        .await
        .expect("the upright lifted, its way west clear");
    b.send("eden:walk", Some(g), point(ahead)).await;
    a.send(
        "eden:walk",
        Some(g),
        point(on(place(upright_at(), back, false), -CARRIED)),
    )
    .await;
    let (wb, wa) = (b.answer().await, a.answer().await);
    wb.expect("the front carries the upright 25 m");
    wa.expect("the back carries the upright 25 m");
    a.act("carry:set-down", Some(second), BTreeMap::new())
        .await
        .expect("the upright set down");
    steps.push("carried the upright 25 m");

    // A crate that takes three, and the beam 25 m off: each refused before the lift.
    let crew = a
        .act("carry:lift", Some(second), lift(crate_(), None))
        .await;
    assert_eq!(
        crew,
        Err("carry-crew-too-small".to_owned()),
        "a crew too small"
    );
    let far = b.act("carry:lift", Some(second), lift(beam(), None)).await;
    assert_eq!(
        far,
        Err("carry-grip-out-of-reach".to_owned()),
        "a grip out of reach"
    );
    for s in [&mut a, &mut b] {
        s.act("activity:leave", Some(second), BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }
    // The last parts are written in the tick after the last answer.
    tokio::time::sleep(Duration::from_millis(300)).await;
    served.stop();

    let logged = Logged::read(&store);
    let (replayed, hash, held) = logged.replay();
    let t = replayed.tree();
    // Where each load's middle lies (0.135 C4: a laid-flat upright's origin is at its foot, not its middle).
    let lies = |n: Id| {
        let node = t.node(t.handle(n).expect("the load")).unwrap();
        let p = node.place().unwrap();
        let middle = match node.kind().as_str() {
            k if k == full(UPRIGHT) => Load::of(&upright_entry()).unwrap().middle,
            _ => Vec3::ZERO,
        };
        let m = p.orientation.rotate(middle).unwrap();
        (
            node.parent(),
            Vec3::new(p.position.x + m.x, 0, p.position.z + m.z),
        )
    };
    let near = |p: Vec3, q: Vec3| (p.x - q.x).abs() < 500_000 && (p.z - q.z).abs() < 500_000;
    let (on_b, at_b) = lies(beam());
    assert!(
        on_b == Some(g) && near(at_b, on(beam_at(), CARRIED)),
        "the beam 25 m east: {at_b:?}"
    );
    let (on_u, at_u) = lies(upright());
    assert!(
        on_u == Some(g) && near(at_u, on(upright_at(), -CARRIED)),
        "the upright 25 m west: {at_u:?}"
    );
    assert_eq!(
        lies(crate_()),
        (Some(g), crate_at()),
        "the crate never moved"
    );
    assert_eq!(
        nodes(&replayed),
        nodes(&world()),
        "every id conserved, and no other"
    );
    assert_eq!(
        hash.to_vec(),
        held,
        "the log replays to the state hash it holds"
    );
    println!(
        "team gate: rung 1 reached ({}); a Soul alone refused carry-needs-two; a passage too narrow refused \
         carry-board-clips; a crew too small refused carry-crew-too-small; a grip out of reach refused \
         carry-grip-out-of-reach; ids conserved; the log replays to its state hash; a blocked set-down: not reached",
        steps.join(", ")
    );
    hold("TEAM_GATE_HOLD").await;
}

/// Soul `from` offers a carry, in front, to Soul `to`, on the ground: the offer's activity.
async fn offer(from: &mut Soul, to: u64, store: &Mem) -> Id {
    offer_of(from, CARRY, to, store).await
}

/// [`offer`] of the carry kind `kind`.
async fn offer_of(from: &mut Soul, kind: &str, to: u64, store: &Mem) -> Id {
    let offered = from
        .act(
            "activity:offer",
            Some(ground()),
            BTreeMap::from([
                (1, pinned(kind)),
                (2, Value::Text(name(FRONT))),
                (3, Value::Array(vec![soul(to).to_value()])),
            ]),
        )
        .await
        .expect("offered");
    Logged::read(store).created(&offered, kind)
}

/// A lift of `load`, naming where its front goes if `to` (the engine sweeps the way there before the lift).
fn lift(load: Id, to: Option<Vec3>) -> BTreeMap<u64, Value> {
    let mut p = BTreeMap::from([(1, load.to_value())]);
    if let Some(to) = to {
        p.insert(2, Value::Array(vec![int(to.x), int(to.y), int(to.z)]));
    }
    p
}

impl Logged {
    /// Each event named `event` the log holds: its fields.
    fn events(&self, event: &str) -> Vec<BTreeMap<u64, Value>> {
        self.parts
            .iter()
            .flat_map(|p| p.effects.iter())
            .flat_map(|e| e.events.iter().flatten())
            .filter(|ev| ev.name.as_str() == event)
            .map(|ev| ev.fields.clone())
            .collect()
    }

    /// Why each carry was set down where it was (`souls:carry-set-down`, field 3), in order.
    fn set_downs(&self) -> Vec<String> {
        self.events("souls:carry-set-down")
            .iter()
            .map(|f| match f.get(&3) {
                Some(Value::Text(t)) => t.as_str().to_owned(),
                other => panic!("why: {other:?}"),
            })
            .collect()
    }
}

/// Where a load lies now: its parent and its place there.
fn lies(store: &Mem, load: Id) -> (Option<Id>, replica::tree::Place) {
    let (r, _, _) = Logged::read(store).replay();
    let t = r.tree();
    let n = t.node(t.handle(load).expect("the load")).unwrap();
    (n.parent(), n.place().unwrap())
}

/// Each walks to its place at the beam where it lies now, at its ends: Soul 1 in front, at its + end.
async fn to_the_beam(a: &mut Soul, b: &mut Soul, store: &Mem) {
    let (_, at) = lies(store, beam());
    let load = Load::of(&beam_entry()).unwrap();
    let [back, front] = load.places();
    // 0.135 C4: at its ends as it lies now (set down where a carry broke off, it may lie turned).
    let axis = load
        .lies_along(at.orientation)
        .unwrap()
        .expect("the beam lies flat");
    let l = load.half_length;
    let end = |along: i64| {
        Vec3::new(
            at.position.x + axis[0] * along / l,
            0,
            at.position.z + axis[1] * along / l,
        )
    };
    let g = ground();
    a.send("eden:walk", Some(g), point(end(front))).await;
    b.send("eden:walk", Some(g), point(end(back))).await;
    let (wa, wb) = (a.answer().await, b.answer().await);
    wa.expect("Soul 1 walks to the beam's front place");
    wb.expect("Soul 2 walks to the beam's back place");
}

/// Both walk on east by `by` µm from where they stand now; neither waits for the answer.
async fn walk_on(s: &mut Soul, store: &Mem, by: i64) {
    let at = start_of(store, s.id);
    s.send(
        "eden:walk",
        Some(ground()),
        point(Vec3::new(at.x + by, 0, at.z)),
    )
    .await;
}

/// Where the log last had body `body`.
fn start_of(store: &Mem, body: Id) -> Vec3 {
    let mut at = bodies(&Placed::new())
        .unwrap()
        .poses()
        .into_iter()
        .find(|(b, _)| *b == body)
        .map(|(_, p)| p.position)
        .expect("a body");
    for p in &Logged::read(store).parts {
        if let Some(Value::Array(rows)) = p.rest.get(&BODIES) {
            for (b, pose, _) in rows.iter().filter_map(read_row) {
                if b == body {
                    at = pose.position;
                }
            }
        }
    }
    at
}

/// Rung 2 (0.135 C3): a carry that breaks off. A decline and a lapsed offer move nothing, and the asker is told
/// (`souls:offer-declined`, `souls:offer-lapsed`). A partner who leaves mid-carry, a partner whose connection is gone
/// mid-carry, and a world restarted mid-carry each leave the beam set down on the ground where the carry had it,
/// and the world says why (`souls:carry-set-down`: `souls:partner-left`, `souls:carriers-apart`, `souls:world-restarted`). Every leave
/// after is accepted at once, so no Soul is held; every id is conserved, and the log replays to its state hash.
#[tokio::test(flavor = "multi_thread")]
async fn rung_2_a_carry_that_breaks_off_sets_its_load_down() {
    let store = Mem::with(Vec::new());
    let path = socket_path("c3");
    let mut served = start_world(&store, &path, false);
    let Gate { url, issued } = gate(&path).await;
    let mut a = Soul::connect(&url, soul(1), &issued[0]).await;
    let mut b = Soul::connect(&url, soul(2), &issued[1]).await;
    let none = BTreeMap::new;
    let mut held = std::time::Duration::ZERO;
    let mut cases = Vec::new();

    // A decline, and a lapsed offer: the beam never moves, and the asker is told.
    let declined = offer(&mut a, 2, &store).await;
    b.act("activity:decline", Some(declined), none())
        .await
        .expect("declined");
    let lapsing = offer_of(&mut a, BRIEF, 2, &store).await;
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    let late = b.act("activity:accept", Some(lapsing), none()).await;
    assert!(late.is_err(), "a lapsed offer: {late:?}");
    let logged = Logged::read(&store);
    let offers = |event: &str| -> Vec<Id> {
        logged
            .events(event)
            .iter()
            .filter_map(|f| f.get(&1).and_then(|v| replica::effects::read_id(v).ok()))
            .collect()
    };
    assert!(
        offers("souls:offer-declined").contains(&declined),
        "told of the decline"
    );
    assert!(
        offers("souls:offer-lapsed").contains(&lapsing),
        "told of the lapse"
    );
    assert_eq!(
        lies(&store, beam()).1.position,
        beam_at(),
        "the beam never moved"
    );
    cases.push("declined");
    cases.push("lapsed");

    // A partner who leaves mid-carry.
    to_the_beam(&mut a, &mut b, &store).await;
    let carry = offer(&mut a, 2, &store).await;
    b.act("activity:accept", Some(carry), none())
        .await
        .expect("accepted");
    let before = lies(&store, beam()).1;
    a.act("carry:lift", Some(carry), lift(beam(), None))
        .await
        .expect("lifted");
    walk_on(&mut a, &store, 6 * M).await;
    walk_on(&mut b, &store, 6 * M).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    // The partner leaves while both walk (its own walk goes on, without the beam).
    held = held.max(leave(&mut b, carry, "the partner leaves").await);
    a.answer().await.expect("the front's walk ends");
    held = held.max(leave(&mut a, carry, "the front leaves").await);
    assert_eq!(Logged::read(&store).set_downs(), vec!["souls:partner-left"]);
    let (on, at) = lies(&store, beam());
    assert_eq!(on, Some(ground()), "set down on the ground");
    assert!(
        at.position.x > before.position.x + 1_000_000
            && at.position.x < before.position.x + 6_000_000,
        "set down where the carry had it, a little way east: {:?}",
        at.position
    );
    cases.push("partner left");

    // A partner whose connection is gone mid-carry: it stops; the front walks on.
    to_the_beam(&mut a, &mut b, &store).await;
    let carry = offer(&mut a, 2, &store).await;
    b.act("activity:accept", Some(carry), none())
        .await
        .expect("accepted");
    a.act("carry:lift", Some(carry), lift(beam(), None))
        .await
        .expect("lifted");
    drop(b);
    walk_on(&mut a, &store, 6 * M).await;
    a.answer().await.expect("the front walks on alone");
    let mut b = Soul::connect(&url, soul(2), &issued[1]).await;
    b.sequence = 2_000;
    held = held.max(leave(&mut b, carry, "back again, the partner leaves").await);
    held = held.max(leave(&mut a, carry, "the front leaves").await);
    assert_eq!(
        Logged::read(&store).set_downs(),
        vec!["souls:partner-left", "souls:carriers-apart"]
    );
    assert_eq!(
        lies(&store, beam()).0,
        Some(ground()),
        "set down on the ground"
    );
    cases.push("partner gone");

    // A world restarted mid-carry: the load is set down where the carry had it at the first tick after.
    to_the_beam(&mut a, &mut b, &store).await;
    let carry = offer(&mut a, 2, &store).await;
    b.act("activity:accept", Some(carry), none())
        .await
        .expect("accepted");
    a.act("carry:lift", Some(carry), lift(beam(), None))
        .await
        .expect("lifted");
    walk_on(&mut a, &store, 6 * M).await;
    walk_on(&mut b, &store, 6 * M).await;
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    served.stop();
    served = start_world(&store, &path, false);
    let _ = a.answer().await;
    let _ = b.answer().await;
    held = held.max(leave(&mut a, carry, "the front leaves").await);
    held = held.max(leave(&mut b, carry, "the back leaves").await);
    assert_eq!(
        Logged::read(&store).set_downs(),
        vec![
            "souls:partner-left",
            "souls:carriers-apart",
            "souls:world-restarted"
        ]
    );
    assert_eq!(
        lies(&store, beam()).0,
        Some(ground()),
        "set down on the ground"
    );
    cases.push("world restarted");

    tokio::time::sleep(Duration::from_millis(300)).await;
    served.stop();
    let logged = Logged::read(&store);
    let (replayed, hash, held_hash) = logged.replay();
    assert_eq!(
        nodes(&replayed),
        nodes(&world()),
        "every id conserved, and no other"
    );
    assert_eq!(
        hash.to_vec(),
        held_hash,
        "the log replays to the state hash it holds"
    );
    assert!(
        held < Duration::from_secs(15),
        "no Soul held 15 s: {held:?}"
    );
    println!(
        "team gate: rung 2 reached ({}): each set down where it was, the reason said; no Soul held over {} ms; ids \
         conserved; the log replays to its state hash",
        cases.join(", "),
        held.as_millis()
    );
}

/// Soul `s` leaves `carry`, which is always accepted: how long its answer took.
async fn leave(s: &mut Soul, carry: Id, what: &str) -> Duration {
    let t = std::time::Instant::now();
    s.act("activity:leave", Some(carry), BTreeMap::new())
        .await
        .unwrap_or_else(|r| panic!("{what}: {r}"));
    t.elapsed()
}

/// The crew measure (0.135, crews of up to six): what a crew of five meets today, each step by name. It reaches no
/// rung yet. A two-role carry (as the served `mars:carry` is: its front and its back take one each,
/// `content/kinds/construction/carry.json`) makes a second pair at a third Soul's accept, never a crew of three.
/// Given a kind that takes six, five Souls join one carry, and then:
/// - the crate, which takes three, is lifted with only its first two members at its grips: the lift counts members,
///   not carriers, and carries between the first two (`worldd::engine`, `carry:lift`);
/// - the fifth member, who holds nothing, leaves, and the carry breaks off: the crate is set down
///   (`souls:partner-left`) though four remain, more than it takes.
///
/// Each is asserted as it is today, so the task that carries with up to six changes this test where it changes that.
#[tokio::test(flavor = "multi_thread")]
async fn crew_measure_five_souls_today_carry_on_two_and_break_off_at_any_leave() {
    let store = Mem::with(Vec::new());
    let path = socket_path("crew");
    let served = start_world_of(&store, &path, false, CREW_SOULS);
    let Gate { url, issued } = gate_of(&path, CREW_SOULS).await;
    let mut crew = Vec::new();
    for (n, token) in (1..=CREW_SOULS).zip(&issued) {
        crew.push(Soul::connect(&url, soul(n), token).await);
    }
    let g = ground();
    let offer_to = |kind: &str, to: &[u64]| {
        BTreeMap::from([
            (1, pinned(kind)),
            (2, Value::Text(name(FRONT))),
            (
                3,
                Value::Array(to.iter().map(|n| soul(*n).to_value()).collect()),
            ),
        ])
    };

    // A two-role carry offered to Souls 3 and 4: the second accept makes a second pair, not a crew of three.
    let offered = crew[0]
        .act("activity:offer", Some(g), offer_to(CARRY, &[3, 4]))
        .await
        .expect("a carry offered to two");
    let pair = Logged::read(&store).created(&offered, CARRY);
    crew[2]
        .act("activity:accept", Some(pair), BTreeMap::new())
        .await
        .expect("Soul 3 accepts");
    let second = crew[3]
        .act("activity:accept", Some(pair), BTreeMap::new())
        .await
        .expect("Soul 4 accepts");
    let other = Logged::read(&store).created(&second, CARRY);
    assert_ne!(
        other, pair,
        "today: a third Soul's accept makes a second pair"
    );
    // Each leaves both pairs, so Soul 1 is free for the crew.
    for (s, activity) in [(2, pair), (0, pair), (3, other), (0, other)] {
        crew[s]
            .act("activity:leave", Some(activity), BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }

    // The first two walk to the crate's carrying places, at its ends along its length (its z).
    let [back, front] = places(&crate_entry());
    let end = |along: i64| Vec3::new(crate_at().x, 0, crate_at().z + along);
    crew[0].send("eden:walk", Some(g), point(end(front))).await;
    crew[1].send("eden:walk", Some(g), point(end(back))).await;
    for s in &mut crew[..2] {
        s.answer().await.expect("walks to the crate");
    }

    // A carry that takes six, offered to the other four: each accept joins the one carry.
    let offered = crew[0]
        .act("activity:offer", Some(g), offer_to(CREW, &[2, 3, 4, 5]))
        .await
        .expect("a crew's carry offered to four");
    let carry = Logged::read(&store).created(&offered, CREW);
    for s in &mut crew[1..] {
        s.act("activity:accept", Some(carry), BTreeMap::new())
            .await
            .expect("each of the four joins the carry");
    }
    // Today: the crate that takes three is lifted, though only the first two stand at its grips.
    crew[0]
        .act("carry:lift", Some(carry), lift(crate_(), None))
        .await
        .expect("today: a crate that takes three lifted by two at its grips");
    // Today: the fifth, who holds nothing, leaves, and the crate is set down with four still in the carry.
    crew[4]
        .act("activity:leave", Some(carry), BTreeMap::new())
        .await
        .expect("a leave is always accepted");
    tokio::time::sleep(Duration::from_millis(300)).await;
    served.stop();
    assert_eq!(
        Logged::read(&store).set_downs(),
        vec!["souls:partner-left".to_owned()],
        "today: any member's leave breaks a crew's carry off"
    );
    println!(
        "team gate: crews of up to six: not reached; a two-role carry makes a second pair at a third accept; five in \
         one carry lift a crate that takes three with two at its grips; the fifth's leave sets it down \
         (souls:partner-left) with four left"
    );
}
