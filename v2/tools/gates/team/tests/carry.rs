//! The team gate's rung 0 (0.135 C1, #4051): two Souls carry a load together through the real gateway, each step its
//! own intent, on one connection and one token each.
//!
//! On N2's test world, two Souls stand 4 m south of a 2 m plank's two ends. Each walks to its end by an ordinary walk.
//! Soul 1 offers a carry to Soul 2 (E8's offer, Soul 1 in front). While Soul 1 is alone in it, its lift is refused
//! `carry-needs-two`. Soul 2 accepts, so the carry starts; Soul 1 lifts the plank, both walk 25 m east, and Soul 2
//! sets it down; then both leave. The plank ends on the ground between them, every node of the world as built is
//! still there and no other is, and the log's effects replayed onto the world as built give the state hash its last
//! part holds. A blocked set-down is not built yet: it prints "not reached", which is not a failure.

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
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL, Target};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::Value as Json;
use replica::tree::Rules as TreeRules;
use replica::world_model::{Audience, Kind};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::walk::town::Town;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::answers::{self, BODIES, Config, STATE};
use worldd::bodies::{Bodies, read_row};
use worldd::checkers::Rules;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0x13, 0x51];
const LINEAGE: Scope = Scope([0x7d; 16]);
const M: i64 = 1_000_000;
/// How far the two carry the plank, µm.
const CARRIED: i64 = 25 * M;

const PLACE: &str = "souls:place";
const WALKER: &str = "test:walker";
const PLANK: &str = "test:plank";
const CARRY: &str = "test:carry";
const FRONT: &str = "test:front";
const BACK: &str = "test:back";

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

/// The kinds in pinned order: (plain name, full name).
fn kinds() -> Vec<(&'static str, String)> {
    [PLACE, WALKER, PLANK, CARRY]
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

/// The two Souls (each Soul's id is its body's here) and the plank.
fn soul(n: u64) -> Id {
    id(n)
}
fn plank() -> Id {
    id(3)
}

/// The plank's middle on the test world's open ground, west of the square; the front's end is 1.35 m east of it and
/// the back's 1.35 m west (B9's places). Each Soul starts 4 m south of its end.
fn middle() -> Vec3 {
    Vec3::new(-41_350_000, 0, 34_000_000)
}
fn end(n: u64) -> Vec3 {
    let dx = if n == 1 { 1_350_000 } else { -1_350_000 };
    Vec3::new(middle().x + dx, 0, middle().z)
}
fn start(n: u64) -> Vec3 {
    Vec3::new(end(n).x, 0, end(n).z - 4 * M)
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

/// The world's rules: the ground takes bodies, things and carries; the plank is held in two hands; the carry has a
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
    };
    TreeRules {
        kinds: BTreeMap::from([
            (
                full(PLACE),
                k("place", &["body", "thing", CARRY], &[], None),
            ),
            (full(WALKER), k("family", &[], &[1, 2], None)),
            (full(PLANK), k("thing", &[], &[], Some(2))),
            (full(CARRY), k("activity", &[], &[1], None)),
        ]),
        souls: [soul(1), soul(2)].into(),
        audiences: BTreeMap::new(),
    }
}

/// The carry's kind: two roles that claim only the voice, so its members walk while in it.
fn carry_kind() -> ActivityKind {
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
    ActivityKind::from_value(&Value::Map(BTreeMap::from([
        (1, Value::Text(name(&full(CARRY)))),
        (2, Value::Uint(1)),
        (3, Value::Array(vec![role(FRONT), role(BACK)])),
        (4, Value::Uint(60_000_000)),
        (5, Value::Uint(400_000)),
    ])))
    .expect("the carry's kind")
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

/// The world as built: the two Souls at their starts and the plank.
fn world() -> Replica {
    let g = ground();
    let h = header(g);
    let mut r = Replica::start(h.stored()).expect("a replica");
    let changes = vec![
        create(soul(1), WALKER, g, start(1)),
        create(soul(2), WALKER, g, start(2)),
        create(plank(), PLANK, g, middle()),
    ];
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

fn bodies() -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let p1 = town.surfaces[&ground].place(soul(1), frame, start(1), Quat::IDENTITY)?;
    let p2 = town.surfaces[&ground].place(soul(2), frame, start(2), Quat::IDENTITY)?;
    let mut b = Bodies::new(town, 50_000)?;
    b.add_body(humanoid(), p1)?;
    b.add_body(humanoid(), p2)?;
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
        let mut poses: BTreeMap<Id, Pose> = bodies().unwrap().poses().into_iter().collect();
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

#[tokio::test(flavor = "multi_thread")]
async fn rung_0_two_souls_carry_a_load_25_m_through_the_gateway() {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.measures = false;
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    cfg.engine = Some((tree_rules(), vec![carry_kind()]));
    let rules = Rules {
        kinds: Json::Obj(Vec::new()),
        moves: Json::Obj(Vec::new()),
    };
    let served = answers::start(world(), rules, store.clone(), cfg).expect("the world starts");
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("team-c1-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = served.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let d = door.clone();
            std::thread::spawn(move || answers::serve(d, stream));
        }
    });
    // One token each, and the gateway in front of the world.
    let mut tokens = Tokens::default();
    let issued: Vec<Token> = [1, 2]
        .iter()
        .map(|n| {
            let grant = Grant::Actor(Actor::Soul(soul(*n)));
            let t = Token::issue(grant).unwrap();
            tokens.add(grant, t.hash());
            t
        })
        .collect();
    let log: Log = std::sync::Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    tokio::spawn(world_link::run(gw.clone(), path.clone()));
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", tcp.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let mut a = Soul::connect(&url, soul(1), &issued[0]).await;
    let mut b = Soul::connect(&url, soul(2), &issued[1]).await;
    let g = ground();
    let mut steps = Vec::new();

    // Each walks to its end of the plank by an ordinary walk.
    a.send("eden:walk", Some(g), point(end(1))).await;
    b.send("eden:walk", Some(g), point(end(2))).await;
    let (wa, wb) = (a.answer().await, b.answer().await);
    wa.expect("Soul 1 walks to the front end");
    wb.expect("Soul 2 walks to the back end");
    steps.push("walked to the load");

    // Soul 1 offers the carry to Soul 2; alone in it, its lift is refused by name.
    let offered = a
        .act(
            "activity:offer",
            Some(g),
            BTreeMap::from([
                (1, pinned(CARRY)),
                (2, Value::Text(name(FRONT))),
                (3, Value::Array(vec![soul(2).to_value()])),
            ]),
        )
        .await
        .expect("offered");
    let carry = Logged::read(&store).created(&offered, CARRY);
    let lift = BTreeMap::from([(1, plank().to_value())]);
    let alone = a.act("carry:lift", Some(carry), lift.clone()).await;
    assert_eq!(alone, Err("carry-needs-two".to_owned()), "a Soul alone");
    b.act("activity:accept", Some(carry), BTreeMap::new())
        .await
        .expect("Soul 2 accepts, and the carry starts");
    steps.push("joined by consent");
    a.act("carry:lift", Some(carry), lift)
        .await
        .expect("lifted");
    steps.push("lifted");

    // Both walk 25 m east, the front leading.
    let on = |p: Vec3| Vec3::new(p.x + CARRIED, 0, p.z);
    a.send("eden:walk", Some(g), point(on(end(1)))).await;
    b.send("eden:walk", Some(g), point(on(end(2)))).await;
    let (wa, wb) = (a.answer().await, b.answer().await);
    wa.expect("the front carries 25 m");
    wb.expect("the back carries 25 m");
    steps.push("carried 25 m");
    b.act("carry:set-down", Some(carry), BTreeMap::new())
        .await
        .expect("set down");
    steps.push("set down");
    for s in [&mut a, &mut b] {
        s.act("activity:leave", Some(carry), BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }
    // The last parts are written in the tick after the last answer.
    tokio::time::sleep(Duration::from_millis(300)).await;
    served.stop();

    let logged = Logged::read(&store);
    let (replayed, hash, held) = logged.replay();
    let t = replayed.tree();
    let n = t.node(t.handle(plank()).expect("the plank")).unwrap();
    let at = n.place().unwrap().position;
    assert_eq!(n.parent(), Some(g), "set down on the ground");
    assert!(
        (at.x - (middle().x + CARRIED)).abs() < 500_000 && (at.z - middle().z).abs() < 500_000,
        "set down 25 m on: {at:?}"
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
        "team gate: rung 0 reached ({}); a Soul alone refused carry-needs-two; ids conserved; the log replays to \
         its state hash; a blocked set-down: not reached",
        steps.join(", ")
    );
}
