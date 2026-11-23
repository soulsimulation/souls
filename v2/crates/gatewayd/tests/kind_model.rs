//! I2 (0.134): the gateway checks a kind's uploaded model. A real world (`worldd::answers`, I3's toggles world with a
//! creator) behind an in-process gateway keeping uploads. A creator's kind definition whose `looks.model` names an
//! upload the gateway does not hold as allowed is refused `kind.model-unknown` by the gateway, and the world's version
//! does not move (it never saw the edit); one naming an allowed upload is defined by the world.

use std::collections::BTreeMap;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::uploads::{MODEL_UNKNOWN, Uploads};
use gatewayd::{Gateway, Log, resume, socket, world_link};
use replica::edit::wire::{VERB, parameters};
use replica::edit::{self, Op, Ref, Spot};
use replica::effects::{Actor, read_id};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL};
use replica::kinds::defined;
use replica::pose::{Quat, Support, Vec3};
use replica::world_model::Audience;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::answers::{self, Config};
use worldd::checkers::toggles;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0xab, 0xcd];
const LINEAGE: Scope = Scope([0x6b; 16]);

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

/// An edit intent: `ops` from `actor` under `sequence`, planned against version `planned`.
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

fn spot(x: i64) -> Spot {
    Spot {
        slot: None,
        position: Vec3::new(x, 0, 0),
        orientation: Quat::IDENTITY,
        support: Support::None,
    }
}

/// An answer as the client reads it: kind (1 receipt, 2 refusal), reason, the failing operation, names, and the
/// version the world stood at.
#[derive(Debug)]
#[allow(dead_code)]
struct Got {
    kind: u64,
    reason: String,
    op: Option<u64>,
    names: BTreeMap<u64, Id>,
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
    let uint = |k| match a.get(&k) {
        Some(Value::Uint(n)) => Some(*n),
        _ => None,
    };
    Got {
        kind: uint(3).unwrap(),
        reason: match a.get(&4) {
            Some(Value::Text(t)) => t.as_str().to_owned(),
            _ => String::new(),
        },
        op: uint(7),
        names: match a.get(&6) {
            Some(Value::Map(m)) => m.iter().map(|(n, id)| (*n, read_id(id).unwrap())).collect(),
            _ => BTreeMap::new(),
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

/// Connects, exchanges first frames and signs in; the stream must start.
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

/// The `assets-check` program the gateway's uploads are opened with: `ASSETS_CHECK`, else this build's (no upload is
/// checked here; the store is only opened).
fn checker() -> PathBuf {
    if let Ok(p) = std::env::var("ASSETS_CHECK") {
        return p.into();
    }
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap().to_owned();
    let program = dir.join("assets-check");
    if !program.is_file() {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.args(["build", "-p", "assets", "--bin", "assets-check"]);
        if dir.file_name().is_some_and(|n| n == "release") {
            cmd.arg("--release");
        }
        assert!(cmd.status().unwrap().success(), "assets-check builds");
    }
    program
}

/// A world with a creator behind a gateway keeping uploads in `dir`, and the creator's socket and the world's root.
async fn world(tag: &str, dir: &std::path::Path) -> (Ws, Actor, Id) {
    let built = toggles::World::build(1, 0, 0);
    let root = built
        .replica
        .tree()
        .node(built.replica.tree().root())
        .unwrap()
        .id();
    let creator = actor(0xc0, Actor::Creator);
    let Actor::Creator(creator_id) = creator else {
        unreachable!()
    };
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.measures = false;
    cfg.tick = Duration::from_millis(10);
    cfg.edits = Some(edit::World {
        creator: creator_id,
        kinds: toggles::kinds(),
    });
    let world = answers::start(
        built.replica,
        toggles::rules(),
        sim::log::Mem::default(),
        cfg,
    )
    .unwrap();
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("gw-i2-{tag}.sock"));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        let _world = world;
        for stream in listener.incoming().flatten() {
            let d = door.clone();
            std::thread::spawn(move || answers::serve(d, stream));
        }
    });
    let mut tokens = Tokens::default();
    let ct = Token::issue(Grant::Actor(creator)).unwrap();
    tokens.add(Grant::Actor(creator), ct.hash());
    let log: Log = std::sync::Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    let _ = gw
        .uploads
        .set(Uploads::open(dir, checker(), false).unwrap());
    tokio::spawn(world_link::run(gw.clone(), path));
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", tcp.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    (connect(&url, &ct).await, creator, root)
}

/// A kind definition at the root, as the creator's client places one (`define`): its entry names `model`.
fn define(root: Id, model: &str) -> Op {
    let entry = format!(
        r#"{{"format":"souls-entry/1","kind":"i2:statue","owner":"thing","geometry":{{"bounds_mm":[500,1500,500]}},"looks":{{"model":"{model}"}},"text":{{"card":"A statue."}}}}"#
    );
    Op::Place {
        name: 1,
        kind: Name::new(&defined::kind().0).unwrap(),
        parent: Ref::Node(root),
        at: spot(0),
        audience: Audience::Everyone,
        fields: BTreeMap::from([(defined::ENTRY, Value::Bytes(entry.into_bytes()))]),
    }
}

fn uploads_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gatewayd-i2-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn i2_a_kind_naming_an_upload_the_gateway_does_not_hold_as_allowed_is_refused_before_the_world()
 {
    let dir = uploads_dir("refused");
    let held = format!("1220{}", "ab".repeat(32));
    std::fs::create_dir_all(dir.join("held")).unwrap();
    std::fs::write(dir.join("held").join(&held), b"held for review").unwrap();
    let (mut c, creator, root) = world("refused", &dir).await;
    for (sequence, model) in [
        (1, format!("upload:1220{}", "0".repeat(64))),
        (2, format!("upload:{held}")),
        (3, "upload:not-a-hash".to_owned()),
    ] {
        put(
            &mut c,
            edit_intent(creator, sequence, 0, &[define(root, &model)]),
        )
        .await;
        let Value::Map(f) = next(&mut c).await else {
            panic!("an answer")
        };
        // the gateway's own refusal: before the world sent any version it is `{2: answer}`, else at the world's version
        let answer = f.get(&2).expect("an answer");
        let Value::Map(a) = answer else {
            panic!("an answer map")
        };
        assert_eq!(a.get(&3), Some(&Value::Uint(2)), "a refusal for {model}");
        assert_eq!(
            a.get(&4),
            Some(&Value::Text(Name::new(MODEL_UNKNOWN).unwrap())),
            "{model}"
        );
        if let Some(v) = f.get(&1) {
            let Value::Array(v) = v else {
                panic!("a version")
            };
            assert_eq!(
                v.get(3),
                Some(&Value::Uint(0)),
                "the world's version did not move: it never saw {model}"
            );
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn i2_a_kind_naming_an_allowed_upload_passes_and_the_world_defines_it() {
    let dir = uploads_dir("allowed");
    let allowed = format!("1220{}", "cd".repeat(32));
    std::fs::write(dir.join(&allowed), b"glTF an allowed model").unwrap();
    let (mut c, creator, root) = world("allowed", &dir).await;
    let got = send(
        &mut c,
        edit_intent(creator, 1, 0, &[define(root, &format!("upload:{allowed}"))]),
    )
    .await;
    assert_eq!((got.kind, got.reason.as_str()), (1, ""), "defined: {got:?}");
    assert!(got.version > 0, "the world committed it: {got:?}");
    let _ = std::fs::remove_dir_all(&dir);
}
