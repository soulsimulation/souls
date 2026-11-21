//! Engine v2 G1c (#3456): edits through the gateway keep BUILDSAFE. A real world (`worldd::answers`) whose replica
//! holds open ground with a named area, a seat and three Souls' bodies: A standing, B sitting in the seat, C standing
//! apart. Behind an in-process gateway, a creator's socket sends three unsafe edits, each refused by G2's name with
//! nothing committed (the version stays where it was):
//!
//! - a wall where A stands: `edit.would-bury`;
//! - a closed building (four walls, no door) round C: `edit.would-cut-off`;
//! - the seat B sits on removed: `edit.in-use`.
//!
//! The same three, planned and committed on a copy with the bodies and ground worldd reads (`worldd::buildsafe`),
//! name the Soul in G2's refusal (A3 of #2761's texts). A closed building where no Soul is commits whole in one batch:
//! a way newly cut off with nobody shut in is not refused, as G2 does today.

use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, resume, socket, world_link};
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource};
use replica::edit::wire::{VERB, parameters};
use replica::edit::{self, Edit, Op, Ref, Spot};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest, schema_hash,
};
use replica::effects::{Header, Refusal};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope, Version};
use replica::intents::Target;
use replica::intents::{Hello, Intent, PROTOCOL};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, Kind, parse_kinds, show};
use sim::edit::safety::Who;
use sim::ground::scene::{F_OUTLINE, F_SLOTS, F_SOLIDS};
use sim::links::Doors;
use sim::walk::town::Town;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::answers::{self, Config};
use worldd::bodies::Bodies;
use worldd::buildsafe;
use worldd::checkers::toggles;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0xab, 0xcd];
const LINEAGE: Scope = Scope([0x6b; 16]);
const M: i64 = 1_000_000;

/// The world's kinds: the root, the open ground and its named areas, a box (walls), a seat and a Soul's body.
const KINDS: &str = r#"
{1: "souls:place", 2: "place", 11: ["eden:ground"]}
{1: "eden:ground", 2: "place", 11: ["eden:place", "body", "thing"]}
{1: "eden:place", 2: "place"}
{1: "g1c:box", 2: "thing"}
{1: "g1c:seat", 2: "thing", 6: {1: ["body"]}}
{1: "g1c:body", 2: "family", 6: {1: ["thing"]}}
"#;

fn int(v: i64) -> Value {
    if v >= 0 {
        Value::Uint(v as u64)
    } else {
        Value::Nint((-1 - v) as u64)
    }
}

fn row(r: &[i64]) -> Value {
    Value::Array(r.iter().map(|&v| int(v)).collect())
}

/// One solid, mm in its thing's frame: centre, half lengths, 2.5 m tall.
fn solid(cx: i64, cz: i64, hx: i64, hz: i64) -> Value {
    row(&[cx, cz, hx, hz, 0, 0, 2_500, 5, 0])
}

/// Four walls 3.2 m across, no door, round the thing's origin.
fn closed_building() -> Value {
    Value::Array(vec![
        solid(0, 1_500, 1_600, 100),
        solid(0, -1_500, 1_600, 100),
        solid(1_500, 0, 100, 1_600),
        solid(-1_500, 0, 100, 1_600),
    ])
}

fn kind(kinds: &BTreeMap<String, Kind>, plain: &str) -> Name {
    let full = kinds
        .keys()
        .find(|k| k.split('@').next() == Some(plain))
        .expect("a kind");
    Name::new(full).unwrap()
}

/// The built world: its replica, kinds, open ground, seat and the three Souls.
struct Built {
    replica: Replica,
    kinds: BTreeMap<String, Kind>,
    ground: Id,
    seat: Id,
    a: Id,
    b: Id,
    c: Id,
}

fn standing(ground: Id, x: i64, z: i64) -> Pose {
    Pose {
        frame: Frame {
            node: ground,
            slot: None,
        },
        position: Vec3::new(x, 0, z),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: ground,
            height: 0,
        },
    }
}

fn build() -> Built {
    let kinds = parse_kinds(KINDS).unwrap();
    let mut mint = Minter::new(Scope([0x2b; 16]));
    let root = mint.mint().unwrap();
    let header = encode(&Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"g1c").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                kinds
                    .keys()
                    .map(|k| Value::Text(Name::new(k).unwrap()))
                    .collect(),
            ),
        ),
        (7, Value::Array(Vec::new())),
    ])))
    .unwrap();
    let mut replica = Replica::start(&header).unwrap();
    let [ground, area, seat, a, b, c] = [(); 6].map(|_| mint.mint().unwrap());
    let create = |node: Id, k: &str, pose: Pose, fields: Vec<(u64, Value)>| Change::Create {
        node,
        kind: kind(&kinds, k),
        pose,
        audience: Audience::Everyone,
        fields: fields.into_iter().collect(),
    };
    let slot_1 = || (F_SLOTS, Value::Array(vec![row(&[1, 0, 0, 0])]));
    let at_root = Pose {
        frame: Frame {
            node: root,
            slot: None,
        },
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        support: Support::None,
    };
    let square = Value::Array(
        [
            [-15_000, -15_000],
            [15_000, -15_000],
            [15_000, 15_000],
            [-15_000, 15_000],
        ]
        .iter()
        .map(|p| row(p))
        .collect(),
    );
    let changes = vec![
        (root, create(ground, "eden:ground", at_root, vec![])),
        (
            ground,
            create(
                area,
                "eden:place",
                standing(ground, 0, 0),
                vec![(F_OUTLINE, square)],
            ),
        ),
        (
            ground,
            create(
                seat,
                "g1c:seat",
                standing(ground, 4 * M, -4 * M),
                vec![slot_1()],
            ),
        ),
        (
            ground,
            create(
                a,
                "g1c:body",
                standing(ground, -4 * M, -4 * M),
                vec![slot_1()],
            ),
        ),
        (
            ground,
            create(
                c,
                "g1c:body",
                standing(ground, -4 * M, 4 * M),
                vec![slot_1()],
            ),
        ),
        (
            seat,
            create(
                b,
                "g1c:body",
                Pose {
                    frame: Frame {
                        node: seat,
                        slot: Some(1),
                    },
                    position: Vec3::ZERO,
                    orientation: Quat::IDENTITY,
                    support: Support::Slot,
                },
                vec![slot_1()],
            ),
        ),
    ];
    let effects = changes
        .into_iter()
        .zip(replica.version()..)
        .map(|((node, change), sequence)| {
            Effect {
                envelope: Envelope {
                    sequence,
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
        (1, Value::Bytes(replica.header().hash().to_bytes())),
        (2, Value::Array(effects)),
    ])))
    .unwrap();
    replica.apply(&Part::read(&part).unwrap()).unwrap();
    Built {
        replica,
        kinds,
        ground,
        seat,
        a,
        b,
        c,
    }
}

fn actor(scope: u8, kind: fn(Id) -> Actor) -> Actor {
    kind(Id::new(Scope([scope; 16]), 1).unwrap())
}

fn basis(sequence: u64) -> Value {
    Version {
        lineage: LINEAGE,
        zone: Id::new(LINEAGE, 0).unwrap(),
        epoch: 1,
        sequence,
    }
    .to_value()
}

fn edit_intent(actor: Actor, sequence: u64, planned: u64, ops: &[Op]) -> Vec<u8> {
    let i = Intent {
        actor,
        verb: Name::new(VERB).unwrap(),
        target: None,
        parameters: parameters(ops),
        sequence,
        basis: basis(planned),
        expiry: i64::MAX,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// A box of `solids` placed on the open ground at (x, z) µm.
fn place_box(b: &Built, x: i64, z: i64, solids: Value) -> Op {
    Op::Place {
        name: 1,
        kind: kind(&b.kinds, "g1c:box"),
        parent: Ref::Node(b.ground),
        at: Spot {
            slot: None,
            position: Vec3::new(x, 0, z),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: b.ground,
                height: 0,
            },
        },
        audience: Audience::Everyone,
        fields: BTreeMap::from([(F_SOLIDS, solids)]),
    }
}

/// The three unsafe edits: name, the Soul it is unsafe for, and its one operation.
fn unsafe_edits(b: &Built) -> Vec<(&'static str, Id, Op)> {
    vec![
        (
            "edit.would-bury",
            b.a,
            place_box(b, -4 * M, -4 * M, Value::Array(vec![solid(0, 0, 500, 100)])),
        ),
        (
            "edit.would-cut-off",
            b.c,
            place_box(b, -4 * M, 4 * M, closed_building()),
        ),
        (
            "edit.in-use",
            b.b,
            Op::Remove {
                node: Ref::Node(b.seat),
            },
        ),
    ]
}

#[derive(Debug)]
struct Got {
    kind: u64,
    reason: String,
    version: u64,
}

fn read_answer(v: &Value) -> Got {
    let Value::Map(f) = v else { panic!("a frame") };
    let version = match f.get(&1) {
        Some(Value::Array(a)) => match a.get(3) {
            Some(Value::Uint(s)) => *s,
            _ => panic!("a version"),
        },
        _ => panic!("a version"),
    };
    let Some(Value::Map(a)) = f.get(&2) else {
        panic!("an answer")
    };
    Got {
        kind: match a.get(&3) {
            Some(Value::Uint(n)) => *n,
            _ => panic!("a kind"),
        },
        reason: match a.get(&4) {
            Some(Value::Text(t)) => t.as_str().to_owned(),
            _ => String::new(),
        },
        version,
    }
}

async fn next(ws: &mut Ws) -> Value {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("an answer within 10 s")
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

async fn connect(url: &str, token: &Token) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let hello = Hello {
        protocol: PROTOCOL,
        build: BUILD.to_vec(),
        refused: None,
        other: None,
    };
    put(&mut ws, hello.to_bytes().unwrap()).await;
    next(&mut ws).await;
    let sign_in = BTreeMap::from([(1, Value::Text(Name::new(token.reveal()).unwrap()))]);
    put(&mut ws, encode(&Value::Map(sign_in)).unwrap()).await;
    let Value::Map(o) = next(&mut ws).await else {
        panic!("an outcome")
    };
    assert_eq!(
        o.get(&4),
        Some(&Value::Text(Name::new(resume::STARTED).unwrap()))
    );
    ws
}

async fn send(ws: &mut Ws, bytes: Vec<u8>) -> Got {
    put(ws, bytes).await;
    let got = read_answer(&next(ws).await);
    println!("{got:?}");
    got
}

#[test]
fn g1c_worldd_reads_the_souls_and_the_open_ground_and_g2_names_the_soul() {
    let b = build();
    let copy = b.replica.frozen();
    assert_eq!(buildsafe::open_ground(&copy), Some(b.ground));
    let souls = buildsafe::souls(&copy, &b.kinds);
    let ids: Vec<Id> = souls.iter().map(|w: &Who| w.soul).collect();
    assert_eq!(ids, vec![b.a, b.c, b.b], "every body, breadth first");
    let sitter = souls.iter().find(|w| w.soul == b.b).unwrap();
    assert_eq!(
        (sitter.pose.frame.node, sitter.pose.frame.slot),
        (b.seat, Some(1))
    );
    // The world's creator; the edit checker's two steps, then the commit with those bodies, as worldd runs them.
    let creator = Id::new(Scope([0xc0; 16]), 1).unwrap();
    let world = edit::World {
        creator,
        kinds: b.kinds.clone(),
    };
    for (name, soul, op) in unsafe_edits(&b) {
        let e = Edit {
            intent: Id::new(LINEAGE, 9_000).unwrap(),
            actor: Actor::Creator(creator),
            planned: copy.version(),
            ops: vec![op],
        };
        let planned = edit::check(e, &copy, &world)
            .and_then(|c| sim::edit::plan(c, &copy, buildsafe::open_ground(&copy)))
            .expect("planned");
        let mut live = b.replica.frozen();
        let mut minter = Minter::at(LINEAGE, 10_000);
        let r =
            sim::edit::commit(&mut live, &mut minter, &planned, &souls, 0).expect_err("refused");
        println!("{}: {}", r.name, r.detail);
        assert_eq!(r.name, name);
        assert!(
            r.detail.contains(&format!("Soul {}", show(soul))),
            "{name} names the Soul: {}",
            r.detail
        );
        assert_eq!(live.version(), copy.version(), "nothing written");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn g1c_unsafe_edits_through_the_gateway_are_refused_by_name_and_nothing_is_committed() {
    let b = build();
    let start = b.replica.version();
    let creator = actor(0xc0, Actor::Creator);
    let Actor::Creator(creator_id) = creator else {
        unreachable!()
    };
    let unsafe_ = unsafe_edits(&b);
    let pen = place_box(&b, 8 * M, 8 * M, closed_building());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.measures = false;
    cfg.tick = Duration::from_millis(10);
    cfg.edits = Some(edit::World {
        creator: creator_id,
        kinds: b.kinds.clone(),
    });
    let world = answers::start(b.replica, toggles::rules(), sim::log::Mem::default(), cfg).unwrap();

    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gw-g1c-buildsafe.sock");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let d = door.clone();
            std::thread::spawn(move || answers::serve(d, stream));
        }
    });
    let mut tokens = Tokens::default();
    let token = Token::issue(Grant::Actor(creator)).unwrap();
    tokens.add(Grant::Actor(creator), token.hash());
    let log: Log = std::sync::Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    tokio::spawn(world_link::run(gw.clone(), path));
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", tcp.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let mut ws = connect(&url, &token).await;
    let mut sequence = 0;
    for (name, _, op) in unsafe_ {
        sequence += 1;
        let got = send(&mut ws, edit_intent(creator, sequence, start, &[op])).await;
        assert_eq!((got.kind, got.reason.as_str()), (2, name), "{got:?}");
        assert_eq!(got.version, start, "nothing committed");
    }
    // A closed building where no Soul is: the way it cuts off shuts nobody in, so it commits whole.
    sequence += 1;
    let built = send(&mut ws, edit_intent(creator, sequence, start, &[pen])).await;
    assert_eq!(built.kind, 1, "{built:?}");
    assert!(built.version > start);
    println!("refusals 3, receipts 1");
    world.stop();
}

// ---- G1d (#3462): BUILDSAFE sees walking Souls ----

/// How many walk beside the creator's edits (A3).
const WALKERS: u64 = 20;

fn humanoid() -> Family {
    let leg = |n: &str| Resource {
        name: Name::new(n).unwrap(),
        class: Class::Locomotion,
        slot: None,
    };
    Family {
        name: Name::new("souls:humanoid").unwrap(),
        resources: vec![leg("souls:leg-left"), leg("souls:leg-right")],
    }
}

/// Walker `i`: its body, and its row, z µm. Each walks east along its row from x -12 m to x 12 m (17 s at 1.4 m/s),
/// on the open ground's 30 m square: rows 1 m apart north and south of the three Souls on the tree, and two between.
fn walker(i: u64) -> (Id, i64) {
    let i_ = i as i64;
    let z = match i_ {
        0..=8 => 6 + i_,
        9..=17 => 3 - i_,
        _ => i_ - 18,
    };
    (Id::new(Scope([0x3d; 16]), 1 + i).unwrap(), z * M)
}

/// The world's bodies: a town over the replica's own tree (so the controller's frames are the tree's nodes) and the
/// walkers standing at the west ends of their rows. None of them is on the tree.
fn walkers(
    tree: Tree,
    header: Header,
    kinds: BTreeMap<String, Kind>,
    ground: Id,
) -> Result<Bodies, Refusal> {
    let rules = Rules {
        kinds,
        souls: Default::default(),
        audiences: BTreeMap::new(),
    };
    let next = tree.to_state().next;
    let town = Town::new(tree, ground, Doors::new(header, rules, next)).map_err(|e| Refusal {
        name: "town",
        detail: e,
    })?;
    let mut bodies = Bodies::new(town, 50_000)?;
    for i in 0..WALKERS {
        let (body, z) = walker(i);
        let frame = Frame {
            node: ground,
            slot: None,
        };
        let at = bodies.town.surfaces[&ground].place(
            body,
            frame,
            Vec3::new(-12 * M, 0, z),
            Quat::IDENTITY,
        )?;
        bodies.add_body(humanoid(), at)?;
    }
    Ok(bodies)
}

/// A walk intent for walker `i` to the east end of its row, written on the world's socket (I1's framing).
fn walk(out: &mut std::os::unix::net::UnixStream, ground: Id, i: u64) {
    let (body, z) = walker(i);
    let i = Intent {
        actor: Actor::Soul(body),
        verb: Name::new("eden:walk").unwrap(),
        target: Some(Target::Node(ground)),
        parameters: BTreeMap::from([(1, row(&[12 * M, 0, z]))]),
        sequence: 1,
        basis: basis(0),
        expiry: answers::now() + 60_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let bytes = encode(&i.to_value()).unwrap();
    out.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .unwrap();
    out.write_all(&bytes).unwrap();
}

/// A2 and A3: twenty Souls walking (I4b's controller, on no tree). Through the gateway, a wall where walker 0 is
/// walking and a wall across the next corner of its line (the end of its straight walk, 24 m ahead) are each refused
/// `edit.would-bury`, nothing committed; walls beside the walkers commit. No tick of the world exceeds 50 ms.
#[tokio::test(flavor = "multi_thread")]
async fn g1d_a_wall_where_a_soul_walks_or_across_its_next_corner_is_refused() {
    let b = build();
    let start = b.replica.version();
    let creator = actor(0xc0, Actor::Creator);
    let Actor::Creator(creator_id) = creator else {
        unreachable!()
    };
    let (tree, header, kinds, ground) = (
        b.replica.tree().frozen(),
        b.replica.header().clone(),
        b.kinds.clone(),
        b.ground,
    );
    let (_, row0) = walker(0);
    let on_the_walk = place_box(
        &b,
        -10 * M,
        row0,
        Value::Array(vec![solid(0, 0, 2_500, 100)]),
    );
    let at_the_corner = place_box(&b, 12 * M, row0, Value::Array(vec![solid(0, 0, 100, 300)]));
    let beside: Vec<Op> = (0..5)
        .map(|k| {
            place_box(
                &b,
                (-10 + 5 * k) * M,
                2 * M + M / 2,
                Value::Array(vec![solid(0, 0, 500, 100)]),
            )
        })
        .collect();
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.edits = Some(edit::World {
        creator: creator_id,
        kinds: b.kinds.clone(),
    });
    cfg.bodies = Some(Box::new(move |_: &worldd::bodies::Placed| {
        walkers(tree, header, kinds, ground)
    }));
    let store = sim::log::Mem::with(Vec::new());
    let world = answers::start(b.replica, toggles::rules(), store.clone(), cfg).unwrap();

    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gw-g1d-walkers.sock");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let d = door.clone();
            std::thread::spawn(move || answers::serve(d, stream));
        }
    });
    let mut tokens = Tokens::default();
    let token = Token::issue(Grant::Actor(creator)).unwrap();
    tokens.add(Grant::Actor(creator), token.hash());
    let log: Log = std::sync::Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    tokio::spawn(world_link::run(gw.clone(), path.clone()));
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", tcp.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // The Souls set off; their walks answer at their ends, long after this test.
    let mut souls = std::os::unix::net::UnixStream::connect(&path).unwrap();
    for i in 0..WALKERS {
        walk(&mut souls, b.ground, i);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    let mut ws = connect(&url, &token).await;
    let mut sequence = 0;
    for (what, op) in [
        ("where it walks", on_the_walk),
        ("across its next corner", at_the_corner),
    ] {
        sequence += 1;
        let got = send(&mut ws, edit_intent(creator, sequence, start, &[op])).await;
        assert_eq!(
            (got.kind, got.reason.as_str()),
            (2, "edit.would-bury"),
            "{what}: {got:?}"
        );
    }
    for op in beside {
        sequence += 1;
        let got = send(&mut ws, edit_intent(creator, sequence, start, &[op])).await;
        assert_eq!(got.kind, 1, "a wall beside the walkers commits: {got:?}");
    }
    // The walkers walk on a while longer under the clock's eye.
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    let m = world.measures.clone().expect("measures");
    let longest = m.ticks.quantile(1.0);
    let phases: Vec<u64> = m.phases.iter().map(|h| h.quantile(1.0)).collect();
    println!(
        "refusals 2, receipts 5; the longest tick {longest} us, each phase's longest {phases:?}"
    );
    // A speed bar, held in an optimized build (`cargo test --release`): an unoptimized one under a parallel `cargo
    // test` spends most of a tick stepping and starting the walks (the bodies' phase), not on the edits.
    if !cfg!(debug_assertions) {
        assert!(longest <= 50_000, "no tick over 50 ms: {longest} us");
    }
    world.stop();
    // Nothing of the two refused edits was committed: the log holds the five walls beside the walkers only.
    let boxes = kind(&b.kinds, "g1c:box");
    let log = store.0.lock().unwrap().bytes.clone();
    let mut placed = 0;
    for r in sim::log::recover(&log).unwrap().records {
        // The tick records' parts; K12's input records beside them hold no effects.
        let Ok(part) = Part::read(&r) else { continue };
        for e in part.effects {
            if let Body::Changes(cs) = &e.body {
                placed += cs
                    .iter()
                    .filter(|c| matches!(&c.change, Change::Create { kind, .. } if *kind == boxes))
                    .count();
            }
        }
    }
    assert_eq!(placed, 5, "the two refused walls are not in the log");
}
