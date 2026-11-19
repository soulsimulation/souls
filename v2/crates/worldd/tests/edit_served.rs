//! Engine v2 G1e (#3532): a world served by `worldd serve` is edited by its one creator, as its record in the directory
//! names it, through a real gateway; and BUILDSAFE refuses, by name, an edit that would bury a Soul.
//!
//! - **A1** (N2's test world): the store's list row and name record name the creator; `serve` prints it at the start.
//!   Another creator's edit is refused `edit.not-the-creator`; the named creator's commits.
//! - **A2, A3** (seeded Eden, `--ignored`: needs the exported Eden facts file): 21 Souls stand in a row on the open
//!   ground, 20 of them walking. A wall where the 21st stands is refused `edit.would-bury`; once it has walked away,
//!   the same wall commits. Each edit's answer is timed through the gateway, beside the 20 walkers.

// A real process and a real gateway on the real clock: the waits and the times are real time.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use directoryd::accounts::principal_text;
use directoryd::directory::store::{Store, When};
use directoryd::worlds::create::NameRecord;
use futures_util::{SinkExt, StreamExt};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, resume, socket, world_link};
use replica::edit::wire::{VERB, parameters};
use replica::edit::{Op, Ref, Spot};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, from_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL, Target};
use replica::pose::{Quat, Support, Vec3};
use replica::rules::json;
use replica::world_model::Audience;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::answers;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0xab, 0xcd];
const M: i64 = 1_000_000;

fn scratch(tag: &str) -> PathBuf {
    // Short: a Unix socket's path is at most 104 bytes on macOS.
    let d = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

/// A running `worldd serve`, its output lines on a channel.
struct Served {
    child: Child,
    lines: Receiver<String>,
}

impl Served {
    /// The first line starting with `prefix`, within `secs`.
    fn line(&self, prefix: &str, secs: u64) -> String {
        let end = Instant::now() + Duration::from_secs(secs);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.lines.recv_timeout(left) {
                Ok(l) if l.starts_with(prefix) => return l,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        panic!("no line {prefix:?}");
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// What a seeded world gives the test.
struct Seeded {
    dir: PathBuf,
    /// The Souls' bodies, in `world.json`'s order.
    souls: Vec<Id>,
    root: Id,
    zone: Id,
    ground: Id,
    /// A kind the open ground admits, with solids: the walls' kind.
    wall: Name,
}

/// `worldd seed` from the facts `text`, with `souls` Souls 2 m apart along x from (x m, z m).
fn seed(d: &Path, text: &str, souls: u64, at: (i64, i64)) -> Seeded {
    let facts = d.join("facts.json");
    std::fs::write(&facts, text).expect("facts");
    let im = import_eden::load(text).expect("loads");
    let (root, ground) = (im.nodes["world"], im.nodes["ground"]);
    let zone = import_eden::header(root, &im.rules).expect("a header").zone;
    let t = &im.tree;
    let gh = t.handle(ground).expect("the ground");
    let wall = t
        .children(gh)
        .unwrap_or_default()
        .iter()
        .filter_map(|&c| t.node(c))
        .find(|n| n.fields().contains_key(&import_eden::F_SOLIDS))
        .map(|n| n.kind().clone())
        .expect("a thing with solids on the open ground");
    let dir = d.join("w");
    let out = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["seed", "--facts"])
        .arg(&facts)
        .arg("--dir")
        .arg(&dir)
        .args([
            "--souls",
            &souls.to_string(),
            "--at",
            &format!("{},{}", at.0, at.1),
        ])
        .output()
        .expect("seed runs");
    assert!(
        out.status.success(),
        "seed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let meta = json::parse(&std::fs::read_to_string(dir.join("world.json")).unwrap()).unwrap();
    let scope: [u8; 16] = from_hex(meta.get("souls_scope").and_then(json::Value::str).unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    Seeded {
        dir,
        souls: (1..=souls)
            .map(|c| Id::new(Scope(scope), c).unwrap())
            .collect(),
        root,
        zone,
        ground,
        wall,
    }
}

/// The directory's record of the world, in the folder store `bucket`: its row in the list and its name record, which
/// names `creator`.
fn record(bucket: &Path, w: &Seeded, creator: Id) {
    let store = directoryd::directory::folder::Folder::new(bucket.to_owned());
    let lineage = w.root.scope().0;
    let row = format!(
        "{{\"worlds\": [{{\"name\": \"g1e\", \"label\": \"G1e\", \"template\": \"eden\", \"lineage\": \"{}\", \
         \"zone\": \"{}\", \"creator\": \"{}\", \"made\": 0}}]}}",
        replica::encode::to_hex(&lineage),
        principal_text(w.zone),
        principal_text(creator)
    );
    store
        .put("world-list", row.as_bytes(), When::Absent)
        .expect("the list");
    let name = NameRecord {
        name: "g1e".into(),
        lineage,
        zone: w.zone,
        creator,
        source: [0; 16],
    };
    store
        .put(
            &NameRecord::key("g1e"),
            &name.to_bytes().unwrap(),
            When::Absent,
        )
        .expect("the name record");
}

fn serve(w: &Seeded, socket: &Path, bucket: &Path) -> Served {
    let mut child = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["serve", "--dir"])
        .arg(&w.dir)
        .arg("--socket")
        .arg(socket)
        .arg("--store")
        .arg(format!("folder:{}", bucket.display()))
        .args(["--machine", "test-machine"])
        .env_remove("SOULS_BACKUP_URL")
        .env_remove("SOULS_BACKUP_KEY_FILE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("worldd serve starts");
    let (tx, lines) = channel();
    let out = child.stdout.take().expect("stdout");
    let err = child.stderr.take().expect("stderr");
    for pipe in [Box::new(out) as Box<dyn Read + Send>, Box::new(err)] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for l in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = tx.send(l);
            }
        });
    }
    Served { child, lines }
}

fn int(v: i64) -> Value {
    u64::try_from(v).map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
}

fn basis(lineage: Scope, sequence: u64) -> Value {
    Version {
        lineage,
        zone: Id::new(lineage, 0).unwrap(),
        epoch: 1,
        sequence,
    }
    .to_value()
}

/// A wall 1 m long and 0.2 m thick, 2.5 m tall, on the open ground at (x, z) µm.
fn wall(w: &Seeded, x: i64, z: i64) -> Op {
    let solid = Value::Array(
        [0, 0, 500, 100, 0, 0, 2_500, 5, 0]
            .iter()
            .map(|&v| int(v))
            .collect(),
    );
    Op::Place {
        name: 1,
        kind: w.wall.clone(),
        parent: Ref::Node(w.ground),
        at: Spot {
            slot: None,
            position: Vec3::new(x, 0, z),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: w.ground,
                height: 0,
            },
        },
        audience: Audience::Everyone,
        fields: BTreeMap::from([(import_eden::F_SOLIDS, Value::Array(vec![solid]))]),
    }
}

fn edit_intent(w: &Seeded, actor: Actor, sequence: u64, planned: u64, op: Op) -> Vec<u8> {
    let i = Intent {
        actor,
        verb: Name::new(VERB).unwrap(),
        target: None,
        parameters: parameters(&[op]),
        sequence,
        basis: basis(w.root.scope(), planned),
        expiry: i64::MAX,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    };
    encode(&i.to_value()).unwrap()
}

/// A Soul's walk to (x, z) µm, on the world's socket (I1's framing).
fn walk(s: &mut UnixStream, w: &Seeded, body: Id, sequence: u64, x: i64, z: i64) {
    let i = Intent {
        actor: Actor::Soul(body),
        verb: Name::new("eden:walk").unwrap(),
        target: Some(Target::Node(w.ground)),
        parameters: BTreeMap::from([(1, Value::Array(vec![int(x), int(0), int(z)]))]),
        sequence,
        basis: basis(w.root.scope(), 0),
        expiry: answers::now() + 120_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    };
    let bytes = encode(&i.to_value()).unwrap();
    s.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .unwrap();
    s.write_all(&bytes).unwrap();
}

/// An answer: its kind (1 a receipt, 2 a refusal), reason and the world's version.
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

/// The next answer on the world's socket.
fn socket_answer(s: &mut UnixStream) -> Got {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).expect("an answer");
    let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut frame).expect("an answer");
    read_answer(&decode(&frame).expect("a frame").value)
}

fn connect_socket(socket: &Path) -> UnixStream {
    let end = Instant::now() + Duration::from_secs(60);
    loop {
        match UnixStream::connect(socket) {
            Ok(s) => return s,
            Err(_) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => panic!("the socket: {e}"),
        }
    }
}

async fn next(ws: &mut Ws) -> Value {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .expect("an answer within 30 s")
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

/// A gateway in this process, linked to the world's socket, with a token for each creator: its socket's URL and the
/// tokens.
async fn gateway(socket: &Path, creators: &[Actor]) -> (String, Vec<Token>) {
    let mut tokens = Tokens::default();
    let mut out = Vec::new();
    for &c in creators {
        let token = Token::issue(Grant::Actor(c)).unwrap();
        tokens.add(Grant::Actor(c), token.hash());
        out.push(token);
    }
    let log: Log = Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    tokio::spawn(world_link::run(gw.clone(), socket.to_owned()));
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", tcp.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    let end = Instant::now() + Duration::from_secs(60);
    while !gw.link.up() {
        assert!(Instant::now() < end, "the gateway links to the world");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    (url, out)
}

async fn sign_in(url: &str, token: &Token) -> Ws {
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

/// Sends one edit through the gateway: its answer and how long it took.
async fn send(ws: &mut Ws, bytes: Vec<u8>) -> (Got, Duration) {
    let t = Instant::now();
    put(ws, bytes).await;
    let got = read_answer(&next(ws).await);
    (got, t.elapsed())
}

fn creator(n: u8) -> (Id, Actor) {
    let id = Id::new(Scope([n; 16]), 1).unwrap();
    (id, Actor::Creator(id))
}

#[tokio::test(flavor = "multi_thread")]
async fn g1e_a1_the_worlds_record_names_its_one_creator() {
    let d = scratch("g1e");
    let w = seed(
        &d,
        &testworld::generate(1, 0).expect("the test world").text,
        1,
        (-40, 30),
    );
    let bucket = d.join("bucket");
    let ((c, creator), (_, other)) = (creator(0xc0), creator(0xc1));
    record(&bucket, &w, c);
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    let named = s.line("creator: ", 60);
    println!("A1: {named}");
    assert_eq!(named, format!("creator: {}", principal_text(c)));
    s.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[creator, other]).await;
    let mut theirs = sign_in(&url, &tokens[1]).await;
    let (got, _) = send(
        &mut theirs,
        edit_intent(&w, other, 1, 0, wall(&w, -30 * M, 30 * M)),
    )
    .await;
    println!("A1: another creator's edit: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.not-the-creator"));
    let mut ws = sign_in(&url, &tokens[0]).await;
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 1, got.version, wall(&w, -30 * M, 30 * M)),
    )
    .await;
    println!("A1: the record's creator's edit: {got:?}");
    assert_eq!(got.kind, 1, "the creator's wall commits: {got:?}");
}

/// The Souls' row on Eden: 21 places 2 m apart along x from (x0, z0) m, each clear for 8 m to the north, and the walls'
/// places east of the row (x0 + 44 to x0 + 50 m), all on the open ground.
fn clear_row(text: &str) -> (i64, i64) {
    let im = import_eden::load(text).expect("Eden loads");
    let ground = im.nodes["ground"];
    let root = im.nodes["world"];
    let header = import_eden::header(root, &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let doors = sim::links::Doors::new(header, im.rules, next);
    let town = sim::walk::town::Town::new(im.tree, ground, doors).expect("the town");
    let surface = &town.surfaces[&ground];
    let frame = replica::pose::Frame {
        node: ground,
        slot: None,
    };
    let id = Id::new(Scope([0x77; 16]), 1).unwrap();
    let ok = |x: i64, z: i64| {
        surface
            .place(id, frame, Vec3::new(x * M, 0, z * M), Quat::IDENTITY)
            .is_ok()
    };
    for r in 0..40 {
        for (dx, dz) in [
            (1, 0),
            (-1, 0),
            (0, 1),
            (0, -1),
            (1, 1),
            (-1, -1),
            (1, -1),
            (-1, 1),
        ] {
            let (x0, z0) = (dx * r * 10, dz * r * 10);
            if (0..=25).all(|k| (0..=8).all(|j| ok(x0 + 2 * k, z0 + j))) {
                return (x0, z0);
            }
        }
    }
    panic!("no clear row on Eden's open ground");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the exported Eden facts file"]
async fn g1e_a2_a3_eden_buildsafe_refuses_a_wall_on_a_soul_and_answers_fast() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    let (x0, z0) = clear_row(&text);
    println!("the Souls' row on Eden from ({x0} m, {z0} m)");
    let d = scratch("g1e-eden");
    let w = seed(&d, &text, 21, (x0, z0));
    let bucket = d.join("bucket");
    let ((c, creator), (_, other)) = (creator(0xc0), creator(0xc1));
    record(&bucket, &w, c);
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    println!("{}", s.line("creator: ", 120));
    s.line("listening ", 300);
    let (url, tokens) = gateway(&socket, &[creator, other]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let mut theirs = sign_in(&url, &tokens[1]).await;

    // The 20 walkers set off north, 8 m each; the 21st stands at the row's east end.
    let mut souls = connect_socket(&socket);
    for (k, &body) in w.souls.iter().enumerate().take(20) {
        let x = (x0 + 2 * k as i64) * M;
        walk(&mut souls, &w, body, 1, x, (z0 + 8) * M);
    }
    let stander = w.souls[20];
    let (sx, sz) = ((x0 + 40) * M, z0 * M);
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The path an edit takes without G2's guard, for comparison: another creator's edits, refused by the checker
    // before any plan.
    let mut path = Vec::new();
    for k in 0..8 {
        let (got, t) = send(
            &mut theirs,
            edit_intent(&w, other, 1 + k, 0, wall(&w, sx, sz)),
        )
        .await;
        assert_eq!(got.reason, "edit.not-the-creator");
        path.push(t);
    }
    path.sort();
    println!(
        "A3: the path alone (8 edits refused before a plan): p50 {:.1} ms",
        path[path.len() / 2].as_secs_f64() * 1000.0
    );

    // A2: a wall where the 21st Soul stands is refused by BUILDSAFE's name.
    let mut sequence = 1;
    let (got, first) = send(
        &mut ws,
        edit_intent(&w, creator, sequence, 0, wall(&w, sx, sz)),
    )
    .await;
    println!(
        "A2: a wall where a Soul stands: {got:?} in {} ms",
        first.as_millis()
    );
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.would-bury"));
    let mut version = got.version;

    // A3: walls east of the row, beside the walkers, each timed through the gateway, then the wall on the Soul again.
    let mut times = Vec::new();
    for i in 0..12 {
        sequence += 1;
        let (x, z) = ((x0 + 44 + 2 * (i % 4)) * M, (z0 + 2 * (i / 4)) * M);
        let (got, t) = send(
            &mut ws,
            edit_intent(&w, creator, sequence, version, wall(&w, x, z)),
        )
        .await;
        assert_eq!(got.kind, 1, "a wall where no Soul is commits: {got:?}");
        version = got.version;
        times.push(t);
        sequence += 1;
        let (got, t) = send(
            &mut ws,
            edit_intent(&w, creator, sequence, version, wall(&w, sx, sz)),
        )
        .await;
        assert_eq!(
            (got.kind, got.reason.as_str()),
            (2, "edit.would-bury"),
            "{got:?}"
        );
        times.push(t);
    }
    times.sort();
    let ms = |d: &Duration| d.as_secs_f64() * 1000.0;
    let (p50, p90, most) = (
        ms(&times[times.len() / 2]),
        ms(&times[times.len() * 9 / 10]),
        ms(times.last().unwrap()),
    );
    println!(
        "A3: {} edits beside 20 walkers through the gateway: p50 {p50:.1} ms, p90 {p90:.1} ms, longest {most:.1} ms",
        times.len()
    );

    // The 21st walks away north; then the same wall commits.
    walk(&mut souls, &w, stander, 1, sx, sz + 6 * M);
    // Walks answer at their ends: all 21, the 21st's among them.
    souls
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    for _ in 0..21 {
        let got = socket_answer(&mut souls);
        assert_eq!(got.kind, 1, "a walk ends: {got:?}");
    }
    sequence += 1;
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, sequence, version, wall(&w, sx, sz)),
    )
    .await;
    println!("A2: the same wall, the Soul gone: {got:?}");
    assert_eq!(
        got.kind, 1,
        "the same wall commits once no Soul stands there: {got:?}"
    );
    // A3's 200 ms bar is read from the printed numbers on a quiet machine (#3157): on a loaded laptop the path alone
    // (two ticks and the log's sync) passes it before any plan.
}
