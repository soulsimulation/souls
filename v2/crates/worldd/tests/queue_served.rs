//! B7c (#3593): a queue for a dining chair from behind two others, served by `worldd serve`, three Souls' own intents
//! through a real gateway, one connection and one token each. N2's test world with B7b's dining row (the seven things
//! of `fixtures/queue-chairs.json`); the Souls are born north of the row, behind its two rear chairs, as in B7b's
//! failed third trial (seed at 21.9, 8 m). Each joins and queues for chair `e_3403bec8` to sit. The head walks round the
//! rear chairs by the town's supported route (its logged inputs head west along the row before south, where the
//! straight way runs south through the chairs), and takes the seat; each in turn rises and walks off, and the next
//! takes it, in arrival order, one take each.
//! `cargo test -p worldd --test queue_served -- --nocapture`.

// A real process and a real gateway on the real clock: the waits are real time.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, resume, socket, world_link};
use replica::effects::{Actor, Body, Change, Effect, Part};
use replica::encode::{Name, Value, decode, encode, from_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL, Target};
use replica::rules::json;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::answers;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0xb7, 0x0c];
/// Where the Souls are born, m: B7b's third trial, north of the row's rear chairs.
const BORN: &str = "21.9,8";
/// The chair queued for, at (21.9, 4.6) m facing the table, behind the rear chairs at z 7.4 m.
const CHAIR: &str = "e_3403bec8";

fn scratch(tag: &str) -> PathBuf {
    // Short: a Unix socket's path is at most 104 bytes on macOS.
    let d = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

/// N2's test world with the dining row, and the folder of entries: the body and the chair.
fn world(d: &Path) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    std::fs::copy(
        root.join("body/humanoid.json"),
        entries.join("humanoid.json"),
    )
    .unwrap();
    // The chair's seat admits a body (Eden's chair entry, its stand point 509 mm in front as the facts have it).
    std::fs::copy(root.join("seating/chair.json"), entries.join("chair.json")).unwrap();
    let mut f = json::parse(&testworld::generate(1, 0).unwrap().text).unwrap();
    let row = json::parse(include_str!("fixtures/queue-chairs.json")).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    for (k, v) in top.iter_mut() {
        if let ("kinds" | "things", json::Value::Arr(a)) = (k.as_str(), v)
            && let Some(json::Value::Arr(more)) = row.get(k)
        {
            a.extend(more.iter().cloned());
        }
    }
    f.to_json()
}

/// A running `worldd serve`, its output lines on a channel.
struct Served {
    child: Child,
    lines: Receiver<String>,
}

impl Served {
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

/// `worldd seed` of `facts` with the entries in `d`, three Souls born at [`BORN`]; then `worldd serve` on `socket`.
fn seed_and_serve(d: &Path, facts: &str, socket: &Path) -> (PathBuf, [Id; 3], Served) {
    let path = d.join("facts.json");
    std::fs::write(&path, facts).unwrap();
    let dir = d.join("w");
    let out = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["seed", "--facts"])
        .arg(&path)
        .arg("--dir")
        .arg(&dir)
        .args(["--souls", "3", "--at", BORN])
        .arg("--entries")
        .arg(d.join("entries"))
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
    let souls = [1, 2, 3].map(|c| Id::new(Scope(scope), c).unwrap());
    let mut child = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["serve", "--dir"])
        .arg(&dir)
        .arg("--socket")
        .arg(socket)
        .args(["--machine", "test-machine"])
        .env_remove("WORLDD_STORE")
        .env_remove("DIRECTORY_STORE_URL")
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
    (dir, souls, Served { child, lines })
}

/// Every effect the world's log holds now.
fn effects(dir: &Path) -> Vec<Effect> {
    let bytes = std::fs::read(dir.join("log")).unwrap_or_default();
    let Ok(r) = sim::log::recover(&bytes) else {
        return Vec::new();
    };
    r.records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
        .filter_map(|r| Part::read(&r).ok())
        .flat_map(|p| p.effects)
        .collect()
}

/// What `find` picks from the log's effects, within `secs` (the log reaches the disk beside the answer).
fn in_log<T>(dir: &Path, secs: u64, what: &str, find: impl Fn(&[Effect]) -> Option<T>) -> T {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(t) = find(&effects(dir)) {
            return t;
        }
        assert!(
            Instant::now() < end,
            "not in the log within {secs} s: {what}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn changes(e: &Effect) -> impl Iterator<Item = &Change> {
    let cs = match &e.body {
        Body::Changes(cs) => cs.as_slice(),
        _ => &[],
    };
    cs.iter().map(|c| &c.change)
}

/// The body born for `soul`, by its `souls:body-of` link.
fn body_of(dir: &Path, soul: Id) -> Id {
    in_log(dir, 20, "a body", |es| {
        es.iter().flat_map(changes).find_map(|c| match c {
            Change::Link { ty, ends, .. }
                if ty.as_str() == "souls:body-of" && ends.contains(&soul) =>
            {
                ends.iter().copied().find(|e| *e != soul)
            }
            _ => None,
        })
    })
}

/// The order events of name `name` in the log, in order, as (body, its fields).
fn order_events(es: &[Effect], name: &str) -> Vec<(Id, BTreeMap<u64, Value>)> {
    es.iter()
        .flat_map(|e| {
            e.events
                .iter()
                .flatten()
                .filter(move |ev| ev.name.as_str() == name)
                .map(move |ev| (e.envelope.node, ev.fields.clone()))
        })
        .collect()
}

/// The bodies whose queue took its slot, in the log's order.
fn takes(es: &[Effect]) -> Vec<Id> {
    order_events(es, sim::orders::TAKE)
        .into_iter()
        .map(|(b, _)| b)
        .collect()
}

/// Whether the log holds `body` put in slot 1 of `chair`.
fn seated(es: &[Effect], body: Id, chair: Id) -> bool {
    es.iter().flat_map(changes).any(|c| match c {
        Change::Motion(h) => h.node == body && h.pose.frame.node == chair,
        Change::Reparent { node, pose, .. } => *node == body && pose.frame.node == chair,
        _ => false,
    })
}

/// Each order input of `body` in the log, as its velocity's x and z µm/s.
fn inputs(es: &[Effect], body: Id) -> Vec<(i64, i64)> {
    let int = |v: &Value| match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    };
    order_events(es, sim::orders::INPUT)
        .into_iter()
        .filter(|(b, _)| *b == body)
        .filter_map(|(_, f)| match f.get(&2) {
            Some(Value::Array(v)) if v.len() == 3 => Some((int(&v[0])?, int(&v[2])?)),
            _ => None,
        })
        .collect()
}

async fn next(ws: &mut Ws) -> Value {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(90), ws.next())
            .await
            .expect("an answer within 90 s")
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

/// One Soul on its own connection through the gateway, signed in with its own token.
struct Soul {
    ws: Ws,
    id: Id,
    lineage: Scope,
    sequence: u64,
}

impl Soul {
    async fn connect(url: &str, id: Id, lineage: Scope, token: &Token) -> Soul {
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
        Soul {
            ws,
            id,
            lineage,
            sequence: 0,
        }
    }

    /// One intent, and its answer: a receipt's entries, or a refusal's reason. A progress answer (kind 3) is read
    /// past.
    async fn act(
        &mut self,
        verb: &str,
        target: Option<Id>,
        parameters: BTreeMap<u64, Value>,
    ) -> Result<Vec<u64>, String> {
        self.sequence += 1;
        let i = Intent {
            actor: Actor::Soul(self.id),
            verb: Name::new(verb).unwrap(),
            target: target.map(Target::Node),
            parameters,
            sequence: self.sequence,
            basis: Version {
                lineage: self.lineage,
                zone: Id::new(self.lineage, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: answers::now() + 600_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        put(&mut self.ws, encode(&i.to_value()).unwrap()).await;
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
                        .filter_map(|v| match v {
                            Value::Uint(n) => Some(*n),
                            _ => None,
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
}

/// A gateway in this process, linked to the world's socket, with one token for each Soul: its URL and the tokens.
async fn gateway(socket: &Path, souls: &[Id]) -> (String, Vec<Token>) {
    let mut tokens = Tokens::default();
    let mut out = Vec::new();
    for &s in souls {
        let grant = Grant::Actor(Actor::Soul(s));
        let token = Token::issue(grant).unwrap();
        tokens.add(grant, token.hash());
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

fn int(v: i64) -> Value {
    u64::try_from(v).map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
}

#[tokio::test(flavor = "multi_thread")]
async fn b7c_queue_from_behind_two_chairs_takes_the_seat_by_the_supported_route() {
    let d = scratch("b7c");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, &socket);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (chair, ground) = (im.nodes[CHAIR], im.nodes["ground"]);
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut s = Vec::new();
    for (soul, token) in souls.iter().zip(&tokens) {
        s.push(Soul::connect(&url, *soul, lineage, token).await);
    }
    for soul in &mut s {
        soul.act("life:join", None, BTreeMap::new())
            .await
            .expect("joined");
    }
    let bodies: Vec<Id> = souls.iter().map(|soul| body_of(&dir, *soul)).collect();
    // Each queues for the chair to sit, in this order: the line's arrival order.
    for soul in &mut s {
        let queued = soul
            .act(
                "souls:queue",
                Some(chair),
                BTreeMap::from([(1, Value::Text(Name::new("eden:sit").unwrap()))]),
            )
            .await;
        assert!(queued.is_ok(), "queue accepted: {queued:?}");
    }
    for (i, head) in bodies.iter().enumerate() {
        // Within 60 s, or the head's inputs say how it stood (B7b: straight at the rear chairs, and no take).
        let end = Instant::now() + Duration::from_secs(60);
        while !{
            let es = effects(&dir);
            takes(&es).contains(head) && seated(&es, *head, chair)
        } {
            if Instant::now() > end {
                let es = effects(&dir);
                let moved = inputs(&es, *head);
                let n = moved.len();
                panic!(
                    "head {i} not seated by its take within 60 s; takes {:?}; its last order inputs (vx, vz µm/s) of \
                     {n}: {:?}",
                    takes(&es),
                    &moved[n.saturating_sub(8)..]
                );
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let es = effects(&dir);
        assert_eq!(takes(&es), bodies[..=i], "FIFO, one take each");
        let ended: Vec<_> = order_events(&es, "souls:order-ended")
            .into_iter()
            .filter(|(b, _)| b == head)
            .filter_map(|(_, f)| match f.get(&2) {
                Some(Value::Text(t)) => Some(t.as_str().to_owned()),
                _ => None,
            })
            .collect();
        assert_eq!(ended, [sim::orders::DONE], "head {i}'s order ended done");
        let moved = inputs(&es, *head);
        println!("head {i}: order inputs (vx, vz µm/s): {moved:?}");
        if i == 0 {
            // The straight way runs south through the rear chairs; the supported route goes west along the row first.
            assert!(
                moved
                    .iter()
                    .any(|&(vx, vz)| vx < 0 && vx.abs() > 2 * vz.abs()),
                "the head walked round the rear chairs"
            );
        }
        if i + 1 < bodies.len() {
            // The sit's own phases end before a rise is admitted (`not-seated` until then).
            let end = Instant::now() + Duration::from_secs(20);
            loop {
                match s[i].act("eden:rise", None, BTreeMap::new()).await {
                    Ok(_) => break,
                    Err(r) if r == "not-seated" && Instant::now() < end => {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    Err(r) => panic!("head {i} rises: {r}"),
                }
            }
            let away = BTreeMap::from([(
                1,
                Value::Array(vec![
                    int(18_000_000 - i as i64 * 1_500_000),
                    int(0),
                    int(7_000_000),
                ]),
            )]);
            // Out of the way of the next in line, once the rise lets it walk.
            let end = Instant::now() + Duration::from_secs(20);
            loop {
                match s[i].act("eden:walk", Some(ground), away.clone()).await {
                    Ok(_) => break,
                    Err(r) if Instant::now() < end => {
                        println!("head {i} walk away: {r}; again");
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    Err(r) => panic!("head {i} walks away: {r}"),
                }
            }
        }
    }
    let es = effects(&dir);
    drop(served);
    assert_eq!(
        takes(&es),
        bodies,
        "each took the seat once, in arrival order"
    );
    let _ = std::fs::remove_dir_all(&d);
    println!(
        "B7c: three Souls queued through the gateway for the chair behind the rear chairs; each head walked the \
         supported route, took the seat once, in arrival order, and rose for the next"
    );
}
