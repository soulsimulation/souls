//! 0.135 C4: a world served by `worldd serve` carries both rack parts, a beam and an upright, by two Souls' own intents
//! through a real gateway, one connection and one token each, as C1's steps: walk, offer and accept, lift, carry 25 m
//! and set down. The carry is the content entry `content/kinds/construction/carry.json` (its two roles make it an
//! activity kind, its slot admitting a thing is where the load rides), and each load is carried as its own entry
//! states; a thing that is not a load is refused `lift-not-a-load`. Held and set down, the load's long axis runs
//! between its carriers, who stand at its ends.
//!
//! N2's test world, its yard, and one upright standing loose on the open ground (the yard's frames stand in their
//! stand's slots, and a lift takes a load from the floor its carriers stand on). The Souls are born at the yard's
//! north edge.

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
use replica::effects::{Actor, Body, Change, Effect, Part, TransferRec};
use replica::encode::{Name, Value, decode, encode, from_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL, Target};
use replica::pose::{Pose, Vec3};
use replica::rules::json;
use replica::world_model::plain;
use sim::activity::carry::{Load, REACH};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::answers;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0xc4, 0x01];
const M: i64 = 1_000_000;
/// How far the two carry each load, µm.
const CARRIED: i64 = 25 * M;
const CARRY: &str = "mars:carry_activity";
const FRONT: &str = "mars:front";

fn scratch(tag: &str) -> PathBuf {
    // Short: a Unix socket's path is at most 104 bytes on macOS.
    let d = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

fn construction(file: &str) -> json::Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/construction");
    json::parse(&std::fs::read_to_string(p.join(file)).unwrap()).unwrap()
}

/// The beam carried: the yard's fourth, the easternmost, lying with its length along z.
fn beam_at() -> Vec3 {
    let x = testworld::YARD_X + 2_000 + 3 * testworld::BEAM_PITCH;
    Vec3::new(x * 1000, 0, testworld::YARD_Z * 1000)
}
/// The loose upright, standing on the open ground 3 m north of the beams' line, west of the stand.
fn upright_at() -> Vec3 {
    Vec3::new(38 * M, 0, -21 * M)
}

/// N2's test world with one upright standing loose on the open ground, and the folder of entries: the construction
/// kinds (the carry among them) and the body.
fn world(d: &Path) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    for f in std::fs::read_dir(root.join("construction")).unwrap() {
        let p = f.unwrap().path();
        std::fs::copy(&p, entries.join(p.file_name().unwrap())).unwrap();
    }
    std::fs::copy(
        root.join("body/humanoid.json"),
        entries.join("humanoid.json"),
    )
    .unwrap();
    let mut f = json::parse(&testworld::generate(1, 0).unwrap().text).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    let num = |v: i64| json::Value::Int(i128::from(v));
    let u = upright_at();
    for (k, v) in top.iter_mut() {
        if let ("things", json::Value::Arr(a)) = (k.as_str(), v) {
            a.push(json::Value::Obj(vec![
                ("id".into(), json::Value::s("loose-upright")),
                ("def".into(), json::Value::s("testworld-rack-upright@1")),
                ("ref".into(), json::Value::s("testworld-rack-upright@1")),
                ("parent".into(), json::Value::Null),
                (
                    "pose".into(),
                    json::Value::Arr([u.x / 1000, 0, u.z / 1000, 0].map(num).to_vec()),
                ),
                ("scale_ppm".into(), num(1_000_000)),
                ("name".into(), json::Value::s("a loose rack frame")),
            ]));
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

/// `worldd seed` of `facts` with the entries in `d`, `souls` Souls born at (x m, z m); then `worldd serve` on
/// `socket`. The world's folder, its Souls and the process.
fn seed_and_serve(
    d: &Path,
    facts: &str,
    at: (i64, i64),
    socket: &Path,
    souls: u64,
) -> (PathBuf, Vec<Id>, Served) {
    let path = d.join("facts.json");
    std::fs::write(&path, facts).unwrap();
    let dir = d.join("w");
    let out = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["seed", "--facts"])
        .arg(&path)
        .arg("--dir")
        .arg(&dir)
        .args(["--souls", &souls.to_string()])
        .args(["--at", &format!("{},{}", at.0, at.1)])
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
    let souls = (1..=souls)
        .map(|c| Id::new(Scope(scope), c).unwrap())
        .collect();
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

/// The carry's activity kind as the served world pins it (`world.kinds`' boot lines), as an intent names a kind: its
/// plain name and its hash's bytes.
fn carry_kind(dir: &Path) -> Value {
    let text = std::fs::read_to_string(dir.join("world.kinds")).expect("world.kinds");
    let full = text
        .lines()
        .filter_map(|l| l.strip_prefix("# souls-boot-activity "))
        .filter_map(|l| l.split_once(' ').map(|(_, a)| a))
        .find(|a| plain(a) == CARRY)
        .expect("the carry's activity is served");
    let (p, hex) = full.split_once('@').unwrap();
    Value::Array(vec![
        Value::Text(Name::new(p).unwrap()),
        Value::Bytes(from_hex(hex).unwrap()),
    ])
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

/// The first id `find` picks from the log's effects, within 20 s (the log reaches the disk beside the answer).
fn in_log(dir: &Path, find: impl Fn(&[Effect]) -> Option<Id>) -> Id {
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(id) = find(&effects(dir)) {
            return id;
        }
        assert!(Instant::now() < end, "not in the log");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The body born for `soul`, by its `souls:body-of` link.
fn body_of(dir: &Path, soul: Id) -> Id {
    in_log(dir, |es| {
        es.iter()
            .filter_map(|e| match &e.body {
                Body::Changes(cs) => Some(cs),
                _ => None,
            })
            .flatten()
            .find_map(|c| match &c.change {
                Change::Link { ty, ends, .. }
                    if ty.as_str() == "souls:body-of" && ends.contains(&soul) =>
                {
                    ends.iter().copied().find(|e| *e != soul)
                }
                _ => None,
            })
    })
}

/// The carry made by the entries numbered `seq`.
fn carry_made(dir: &Path, seq: &[u64]) -> Id {
    in_log(dir, |es| {
        es.iter()
            .filter(|e| seq.contains(&e.envelope.sequence))
            .filter_map(|e| match &e.body {
                Body::Changes(cs) => Some(cs),
                _ => None,
            })
            .flatten()
            .find_map(|c| match &c.change {
                Change::Create { node, kind, .. } if plain(kind.as_str()) == CARRY => Some(*node),
                _ => None,
            })
    })
}

/// Each change of parent `load` made, in order: where it was put.
fn moves_of(dir: &Path, load: Id) -> Vec<Pose> {
    effects(dir)
        .into_iter()
        .filter_map(|e| match e.body {
            Body::Transfer(TransferRec::Leave { node, pose, .. }) if node == load => Some(pose),
            _ => None,
        })
        .collect()
}

/// The way the world said for a carry that turns its load (0.135 R2, `souls:carry-way`), within 20 s: each pose's
/// front x, front z, back x and back z, µm.
fn carry_way(dir: &Path) -> Vec<[i64; 4]> {
    let num = |v: &Value| match v {
        Value::Uint(n) => i64::try_from(*n).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    };
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        let found = effects(dir)
            .iter()
            .flat_map(|e| e.events.iter().flatten())
            .find(|ev| ev.name.as_str() == "souls:carry-way")
            .and_then(|ev| match ev.fields.get(&3) {
                Some(Value::Array(ps)) => ps
                    .iter()
                    .map(|p| match p {
                        Value::Array(v) => {
                            let v: Vec<i64> = v.iter().filter_map(num).collect();
                            v.try_into().ok()
                        }
                        _ => None,
                    })
                    .collect::<Option<Vec<[i64; 4]>>>(),
                _ => None,
            });
        if let Some(w) = found {
            return w;
        }
        assert!(Instant::now() < end, "no souls:carry-way in the log");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn int(v: i64) -> Value {
    u64::try_from(v).map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
}

fn point(p: Vec3) -> BTreeMap<u64, Value> {
    BTreeMap::from([(1, Value::Array(vec![int(p.x), int(0), int(p.z)]))])
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

    async fn send(&mut self, verb: &str, target: Id, parameters: BTreeMap<u64, Value>) {
        self.send_on(verb, Some(target), parameters).await;
    }

    /// [`Soul::send`] with a target or none (a leave of the world, `life:leave`).
    async fn send_on(&mut self, verb: &str, target: Option<Id>, parameters: BTreeMap<u64, Value>) {
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
            expiry: answers::now() + 120_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        put(&mut self.ws, encode(&i.to_value()).unwrap()).await;
    }

    /// The answer to this Soul's last intent: a receipt's entries, or a refusal's reason. A progress answer (kind 3)
    /// is read past.
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

    async fn act(
        &mut self,
        verb: &str,
        target: Id,
        parameters: BTreeMap<u64, Value>,
    ) -> Result<Vec<u64>, String> {
        self.send(verb, target, parameters).await;
        self.answer().await
    }

    /// [`Soul::act`] with a target or none.
    async fn act_on(
        &mut self,
        verb: &str,
        target: Option<Id>,
        parameters: BTreeMap<u64, Value>,
    ) -> Result<Vec<u64>, String> {
        self.send_on(verb, target, parameters).await;
        self.answer().await
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

/// Where a carrier stands at a load whose middle is `at`: `along` µm from it, north (+z) along a load lying along z,
/// or east (+x) along one that stands (it is taken along the line its carriers stand on).
fn spot(at: Vec3, along: i64, north: bool) -> Vec3 {
    match north {
        true => Vec3::new(at.x, 0, at.z + along),
        false => Vec3::new(at.x + along, 0, at.z),
    }
}

/// Both walk to their places at the ends of a load whose middle is `at`, Soul 1 in front, then Soul 1 offers the
/// carry to Soul 2 and Soul 2 accepts; the carry's activity. Before the accept, Soul 1 alone is refused its lift by
/// name.
#[allow(clippy::too_many_arguments)]
async fn gather(
    a: &mut Soul,
    b: &mut Soul,
    dir: &Path,
    ground: Id,
    load: Id,
    entry: &json::Value,
    at: Vec3,
    north: bool,
) -> Id {
    let [back, front] = Load::of(entry).unwrap().places();
    a.send("eden:walk", ground, point(spot(at, front, north)))
        .await;
    b.send("eden:walk", ground, point(spot(at, back, north)))
        .await;
    let (wa, wb) = (a.answer().await, b.answer().await);
    wa.expect("Soul 1 walks to its place in front");
    wb.expect("Soul 2 walks to its place behind");
    let partner = body_of(dir, b.id);
    let offered = a
        .act(
            "activity:offer",
            ground,
            BTreeMap::from([
                (1, carry_kind(dir)),
                (2, Value::Text(Name::new(FRONT).unwrap())),
                (3, Value::Array(vec![partner.to_value()])),
            ]),
        )
        .await
        .expect("the carry offered");
    let carry = carry_made(dir, &offered);
    let alone = a
        .act("carry:lift", carry, BTreeMap::from([(1, load.to_value())]))
        .await;
    assert_eq!(alone, Err("carry-needs-two".to_owned()), "a Soul alone");
    b.act("activity:accept", carry, BTreeMap::new())
        .await
        .expect("Soul 2 accepts, and the carry starts");
    carry
}

/// Soul 1 lifts `load`, both walk 25 m east (side by side when they stand at a beam's ends), Soul 2 sets it down and
/// both leave.
#[allow(clippy::too_many_arguments)]
async fn carry_east(
    a: &mut Soul,
    b: &mut Soul,
    ground: Id,
    carry: Id,
    load: Id,
    entry: &json::Value,
    at: Vec3,
    north: bool,
) {
    let [back, front] = Load::of(entry).unwrap().places();
    a.act("carry:lift", carry, BTreeMap::from([(1, load.to_value())]))
        .await
        .expect("lifted");
    let east = |p: Vec3| Vec3::new(p.x + CARRIED, 0, p.z);
    a.send("eden:walk", ground, point(east(spot(at, front, north))))
        .await;
    b.send("eden:walk", ground, point(east(spot(at, back, north))))
        .await;
    let (wa, wb) = (a.answer().await, b.answer().await);
    wa.expect("the front carries it 25 m");
    wb.expect("the back carries it 25 m");
    b.act("carry:set-down", carry, BTreeMap::new())
        .await
        .expect("set down");
    for s in [a, b] {
        s.act("activity:leave", carry, BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }
}

/// The load's lift and its set-down, from the log: held in the carry's slot with its `long` axis (its own frame,
/// µm from its middle) along the carry's +x, and set down with its middle 25 m east of `at` and its long axis still
/// between where its carriers stood (north to south, or east to west).
#[allow(clippy::too_many_arguments)]
fn held_and_set_down(
    dir: &Path,
    name: &str,
    load: Id,
    entry: &json::Value,
    long: Vec3,
    at: Vec3,
    north: bool,
    carriers: [Id; 2],
) {
    let l = Load::of(entry).unwrap();
    let moved = moves_of(dir, load);
    let [lift, down] = moved[..] else {
        panic!("{name}: lifted once and set down once: {moved:?}")
    };
    assert!(
        lift.frame.slot.is_some(),
        "{name}: held in the carry's slot"
    );
    let end = lift.orientation.rotate(long).unwrap();
    println!(
        "{name}: held with its long axis's end at {end:?} in the carry's frame (+x the front)"
    );
    assert!(
        (end.x - l.half_length).abs() <= 2 && end.y.abs() <= 2 && end.z.abs() <= 2,
        "{name}: its long axis runs between the carriers: {end:?}"
    );
    let m = down.orientation.rotate(l.middle).unwrap();
    let middle = Vec3::new(
        down.position.x + m.x,
        down.position.y + m.y,
        down.position.z + m.z,
    );
    let end = down.orientation.rotate(long).unwrap();
    println!("{name}: set down, its middle at {middle:?}, its long axis's end at {end:?}");
    assert!(
        (middle.x - at.x - CARRIED).abs() < 600_000 && (middle.z - at.z).abs() < 600_000,
        "{name}: set down 25 m east: {middle:?}"
    );
    // Its yaw follows where its front and back carriers' walks ended, which is within a walk's reach of their places:
    // its long axis is checked against the line between where they stood, and that line against the nominal one.
    let (f, k) = stood_at_set_down(dir, load, carriers);
    let (dx, dz) = ((f.x - k.x) as f64, (f.z - k.z) as f64);
    let gap = dx.hypot(dz);
    let across = (end.x as f64 * dz - end.z as f64 * dx) / gap;
    let along = (end.x as f64).hypot(end.z as f64);
    println!(
        "{name}: its carriers stood {gap:.0} µm apart, its long axis {across:.0} µm off their line"
    );
    let nominal = match north {
        true => dx.abs() / gap,
        false => dz.abs() / gap,
    };
    assert!(
        nominal < 0.05,
        "{name}: its carriers stood {} its length: {f:?} {k:?}",
        if north {
            "north to south"
        } else {
            "east to west"
        }
    );
    assert!(
        (along - l.half_length as f64).abs() < 20_000.0 && across.abs() < 20_000.0,
        "{name}: set down lengthwise between where its carriers stood: {end:?}, {f:?} {k:?}"
    );
}

/// Where the bodies `carriers` (front, back) stood when `load` was set down: the log's body rows up to the part that
/// holds the load's second move.
fn stood_at_set_down(dir: &Path, load: Id, carriers: [Id; 2]) -> (Vec3, Vec3) {
    let bytes = std::fs::read(dir.join("log")).unwrap_or_default();
    let mut at = BTreeMap::new();
    let mut moved = 0;
    for r in sim::log::recover(&bytes).unwrap().records {
        let Ok(p) = Part::read(&r) else { continue };
        if let Some(Value::Array(rows)) = p.rest.get(&answers::BODIES) {
            for (b, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                at.insert(b, pose.position);
            }
        }
        moved += p
            .effects
            .iter()
            .filter(|e| matches!(e.body, Body::Transfer(TransferRec::Leave { node, .. }) if node == load))
            .count();
        if moved >= 2 {
            break;
        }
    }
    let [f, k] = carriers.map(|b| *at.get(&b).expect("a carrier's body row"));
    (f, k)
}

#[tokio::test(flavor = "multi_thread")]
async fn c4_a_served_world_carries_a_beam_and_an_upright_by_souls_intents_lengthwise() {
    let d = scratch("c4");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
    let activities = served.line("activities: ", 180);
    println!("{activities}");
    assert!(activities.contains(CARRY), "the carry is an activity kind");
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam, upright, stand) = (
        im.nodes["ground"],
        im.nodes["yard-beam-4"],
        im.nodes["loose-upright"],
        im.nodes["yard-stand"],
    );
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut a = Soul::connect(&url, souls[0], lineage, &tokens[0]).await;
    let mut b = Soul::connect(&url, souls[1], lineage, &tokens[1]).await;

    let (beam_entry, upright_entry) = (
        construction("rack_beam.json"),
        construction("rack_upright.json"),
    );
    // The beam lies with its length along z: its carriers stand at its ends, Soul 1 at the north end.
    let first = gather(
        &mut a,
        &mut b,
        &dir,
        ground,
        beam,
        &beam_entry,
        beam_at(),
        true,
    )
    .await;
    // A thing that is not a load (its kind's entry states no grips): refused by name, and nothing moves.
    let not = a
        .act("carry:lift", first, BTreeMap::from([(1, stand.to_value())]))
        .await;
    assert_eq!(not, Err("lift-not-a-load".to_owned()), "the frame stand");
    assert!(moves_of(&dir, stand).is_empty(), "the stand never moved");
    carry_east(
        &mut a,
        &mut b,
        ground,
        first,
        beam,
        &beam_entry,
        beam_at(),
        true,
    )
    .await;
    // The upright stands: its carriers take it along the line they stand on, Soul 1 east.
    let second = gather(
        &mut a,
        &mut b,
        &dir,
        ground,
        upright,
        &upright_entry,
        upright_at(),
        false,
    )
    .await;
    carry_east(
        &mut a,
        &mut b,
        ground,
        second,
        upright,
        &upright_entry,
        upright_at(),
        false,
    )
    .await;
    // The last parts reach the log in the tick after the last answer.
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(served);

    // The beam's length is its z, the upright's its y (from its foot; its middle is half its height up).
    let carriers = [body_of(&dir, souls[0]), body_of(&dir, souls[1])];
    held_and_set_down(
        &dir,
        "the beam",
        beam,
        &beam_entry,
        Vec3::new(0, 0, Load::of(&beam_entry).unwrap().half_length),
        beam_at(),
        true,
        carriers,
    );
    let up = Load::of(&upright_entry).unwrap();
    held_and_set_down(
        &dir,
        "the upright",
        upright,
        &upright_entry,
        Vec3::new(0, up.half_length, 0),
        upright_at(),
        false,
        carriers,
    );
    println!(
        "C4: a served world carried the beam and the upright 25 m by two Souls' intents through the gateway (walk, \
         offer, a Soul alone refused carry-needs-two, accept, a thing not a load refused lift-not-a-load, lift, \
         carry, set down, leave), each held and set down lengthwise between its carriers"
    );
}

/// N2's test world ([`world`]) with a post on the beam's middle line 7 m east of it: 0.2 m square and 1.5 m high.
/// The facts and where the post stands (x, z µm).
fn post_world(d: &Path) -> (String, (i64, i64)) {
    // The post: 0.2 m square and 1.5 m high, on the beam's middle line 7 m east of it.
    let post = (beam_at().x + 7 * M, beam_at().z);
    let mut f = json::parse(&world(d)).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    let num = |v: i64| json::Value::Int(i128::from(v));
    for (k, v) in top.iter_mut() {
        if let ("things", json::Value::Arr(a)) = (k.as_str(), v) {
            a.push(json::Value::Obj(vec![
                ("id".into(), json::Value::s("post")),
                ("def".into(), json::Value::s("testworld-box@1")),
                ("ref".into(), json::Value::s("testworld-box@1")),
                ("parent".into(), json::Value::Null),
                (
                    "pose".into(),
                    json::Value::Arr([post.0 / 1000, 0, post.1 / 1000, 0].map(num).to_vec()),
                ),
                ("scale_ppm".into(), num(1_000_000)),
                (
                    "solids".into(),
                    json::Value::Arr(vec![json::Value::Arr(
                        [0, 0, 100, 100, 0, 0, 1500, 5, 0].map(num).to_vec(),
                    )]),
                ),
                ("name".into(), json::Value::s("a post")),
            ]));
        }
    }
    (f.to_json(), post)
}

/// 0.135 C7: the beam carried with no destination named, its two carriers walking east either side of a post that
/// stands on the line between them. Each walks clear of the post, but the beam would sweep through it: the carry
/// stops where the beam meets it, the beam set down at its last sample (`souls:carry-set-down`, why
/// `souls:carry-blocked`), never past the post and never through it. The front's walk led its crew (moving-group rule
/// 3), so it stops there, ended by that reason; the back, which walked its own way, is not held: its walk arrives, the
/// beam is no longer carried, and both may leave.
#[tokio::test(flavor = "multi_thread")]
async fn c7_a_load_carried_with_no_destination_stops_at_a_post_between_its_carriers() {
    use sim::activity::carry::{Fixed, outline};
    let d = scratch("c7");
    let (facts, post) = post_world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam) = (im.nodes["ground"], im.nodes["yard-beam-4"]);
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut a = Soul::connect(&url, souls[0], lineage, &tokens[0]).await;
    let mut b = Soul::connect(&url, souls[1], lineage, &tokens[1]).await;
    let entry = construction("rack_beam.json");
    let load = Load::of(&entry).unwrap();
    let [back, front] = load.places();
    let carry = gather(&mut a, &mut b, &dir, ground, beam, &entry, beam_at(), true).await;
    a.act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("lifted, with no destination named");
    let east = |p: Vec3| Vec3::new(p.x + 12 * M, 0, p.z);
    a.send(
        "eden:walk",
        ground,
        point(east(spot(beam_at(), front, true))),
    )
    .await;
    b.send(
        "eden:walk",
        ground,
        point(east(spot(beam_at(), back, true))),
    )
    .await;
    let (wa, wb) = (a.answer().await, b.answer().await);
    assert_eq!(
        wa,
        Err("souls:carry-blocked".to_owned()),
        "the front's walk led the carry: it stops with it"
    );
    wb.expect("the back walks on past the post, its own way");
    let down = b.act("carry:set-down", carry, BTreeMap::new()).await;
    assert_eq!(down, Err("not-carried".to_owned()), "the carry had stopped");
    for s in [&mut a, &mut b] {
        s.act("activity:leave", carry, BTreeMap::new())
            .await
            .expect("each carrier leaves");
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(served);

    let es = effects(&dir);
    let why: Vec<String> = es
        .iter()
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == "souls:carry-set-down")
        .filter_map(|ev| match ev.fields.get(&3) {
            Some(Value::Text(t)) => Some(t.as_str().to_owned()),
            _ => None,
        })
        .collect();
    assert_eq!(
        why,
        vec!["souls:carry-blocked".to_owned()],
        "set down once, blocked"
    );
    // Every sample of the carry: the beam's outline on the plan, clear of the post.
    let fixed = Fixed::new(vec![[
        [post.0 - 100_000, post.1 - 100_000],
        [post.0 + 100_000, post.1 - 100_000],
        [post.0 + 100_000, post.1 + 100_000],
        [post.0 - 100_000, post.1 + 100_000],
    ]]);
    // The beam as it is held: on its edge, 51 mm across.
    let (held, _) = load.as_held().unwrap();
    let mut samples = 0;
    let mut east_most = i64::MIN;
    for e in &es {
        let Body::Changes(cs) = &e.body else { continue };
        for c in cs {
            let Change::Motion(h) = &c.change else {
                continue;
            };
            if h.node != carry {
                continue;
            }
            let p = h.pose.position;
            let u = h
                .pose
                .orientation
                .rotate(Vec3::new(1_000_000, 0, 0))
                .unwrap();
            let q = outline([p.x + u.x, p.z + u.z], [p.x - u.x, p.z - u.z], &held);
            assert!(fixed.hit(&q).is_none(), "a sample through the post: {p:?}");
            samples += 1;
            east_most = east_most.max(p.x);
        }
    }
    let moved = moves_of(&dir, beam);
    let [lift, set] = moved[..] else {
        panic!("lifted once and set down once: {moved:?}")
    };
    assert!(lift.frame.slot.is_some(), "held in the carry's slot");
    let m = set.orientation.rotate(load.middle).unwrap();
    let middle = set.position.x + m.x;
    println!(
        "C7: {samples} samples of the carry, none through the post; it stopped with the beam's middle at x {} mm, \
         {} mm short of the post's west face; set down there, its middle at x {} mm (souls:carry-blocked); the \
         carriers walked on and left",
        east_most / 1000,
        (post.0 - 100_000 - east_most) / 1000,
        middle / 1000
    );
    assert!(samples > 10, "the carry moved before it stopped");
    assert!(
        east_most < post.0 - 100_000 && post.0 - 100_000 - east_most < 400_000,
        "stopped at the post, not before it: {east_most}"
    );
    assert!(
        (middle - east_most).abs() < 2_000,
        "set down where its last sample had it, not moved: {middle} against {east_most}"
    );
}

/// 0.135 R2 (#2814): the beam, lying along a wall 1.2 m west of it, is carried into a room through the wall's 1.2 m
/// doorway, narrower than the beam's 2.74 m, by turning it a quarter. A room of walls stands on the open ground east of
/// the beam: 5.8 m by 8 m clear inside, its one doorway in its west wall level with the beam's middle. The lift names
/// a point 4.6 m inside; the straight way there clips the wall, so the lift's check finds a way that turns the beam
/// (`turn::turn_way`) and says it (`souls:carry-way`); the two Souls read it from the world and walk it pose by pose,
/// by their own intents through the gateway, each tick checked by C7's check. The carry is never stopped, no sample of the beam meets a wall, it turns from north to
/// east, and it is set down inside the room.
#[tokio::test(flavor = "multi_thread")]
async fn r2_a_beam_turns_through_a_doorway_narrower_than_it_is_long() {
    use sim::activity::carry::{Fixed, outline};
    let d = scratch("r2");
    // The room's west wall's west face, level with the beam's middle, 1.2 m east of it (mm).
    let (wx, wz) = (beam_at().x / 1000 + 1_200, beam_at().z / 1000);
    let walls: [[i64; 4]; 5] = [
        [100, 2_300, 100, 1_700],
        [100, -2_300, 100, 1_700],
        [3_100, 4_100, 3_100, 100],
        [3_100, -4_100, 3_100, 100],
        [6_100, 0, 100, 4_000],
    ];
    let mut f = json::parse(&world(&d)).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    let num = |v: i64| json::Value::Int(i128::from(v));
    for (k, v) in top.iter_mut() {
        if let ("things", json::Value::Arr(a)) = (k.as_str(), v) {
            let solids = walls
                .iter()
                .map(|[cx, cz, hx, hz]| {
                    json::Value::Arr([*cx, *cz, *hx, *hz, 0, 0, 2_400, 5, 0].map(num).to_vec())
                })
                .collect();
            a.push(json::Value::Obj(vec![
                ("id".into(), json::Value::s("room")),
                ("def".into(), json::Value::s("testworld-box@1")),
                ("ref".into(), json::Value::s("testworld-box@1")),
                ("parent".into(), json::Value::Null),
                (
                    "pose".into(),
                    json::Value::Arr([wx, 0, wz, 0].map(num).to_vec()),
                ),
                ("scale_ppm".into(), num(1_000_000)),
                ("solids".into(), json::Value::Arr(solids)),
                ("name".into(), json::Value::s("a room with one doorway")),
            ]));
        }
    }
    let facts = f.to_json();
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam) = (im.nodes["ground"], im.nodes["yard-beam-4"]);
    let lineage = im.nodes["world"].scope();
    let entry = construction("rack_beam.json");
    let load = Load::of(&entry).unwrap();
    let to = Vec3::new((wx + 4_600) * 1000, 0, wz * 1000);
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut a = Soul::connect(&url, souls[0], lineage, &tokens[0]).await;
    let mut b = Soul::connect(&url, souls[1], lineage, &tokens[1]).await;
    let carry = gather(&mut a, &mut b, &dir, ground, beam, &entry, beam_at(), true).await;
    let lift = BTreeMap::from([
        (1, beam.to_value()),
        (2, Value::Array(vec![int(to.x), int(0), int(to.z)])),
    ]);
    a.act("carry:lift", carry, lift)
        .await
        .expect("lifted, a way through the doorway found");
    // The way, as the world says it to the carry's audience: each pose where the front and the back stand.
    let way = carry_way(&dir);
    for (k, p) in way.iter().enumerate().skip(1) {
        a.send("eden:walk", ground, point(Vec3::new(p[0], 0, p[1])))
            .await;
        b.send("eden:walk", ground, point(Vec3::new(p[2], 0, p[3])))
            .await;
        let (wa, wb) = (a.answer().await, b.answer().await);
        wa.unwrap_or_else(|r| panic!("the front's walk {k}: {r}"));
        wb.unwrap_or_else(|r| panic!("the back's walk {k}: {r}"));
    }
    b.act("carry:set-down", carry, BTreeMap::new())
        .await
        .expect("set down inside, the carry never stopped");
    for s in [&mut a, &mut b] {
        s.act("activity:leave", carry, BTreeMap::new())
            .await
            .expect("each carrier leaves");
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(served);

    let es = effects(&dir);
    let stopped = es
        .iter()
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == "souls:carry-set-down")
        .count();
    assert_eq!(stopped, 0, "the carry was never broken off");
    // Every sample of the carry: the beam as it is held (on its edge), clear of every wall.
    let quads = walls
        .iter()
        .map(|[cx, cz, hx, hz]| {
            let (x, z) = ((wx + cx) * 1000, (wz + cz) * 1000);
            let (hx, hz) = (hx * 1000, hz * 1000);
            [
                [x - hx, z - hz],
                [x + hx, z - hz],
                [x + hx, z + hz],
                [x - hx, z + hz],
            ]
        })
        .collect();
    let walls_fixed = Fixed::new(quads);
    let (held, _) = load.as_held().unwrap();
    let mut headings = Vec::new();
    for e in &es {
        let Body::Changes(cs) = &e.body else { continue };
        for c in cs {
            let Change::Motion(h) = &c.change else {
                continue;
            };
            if h.node != carry {
                continue;
            }
            let p = h.pose.position;
            let u = h
                .pose
                .orientation
                .rotate(Vec3::new(1_000_000, 0, 0))
                .unwrap();
            let q = outline([p.x + u.x, p.z + u.z], [p.x - u.x, p.z - u.z], &held);
            assert!(
                walls_fixed.hit(&q).is_none(),
                "a sample through a wall: {p:?}"
            );
            headings.push((u.z as f64).atan2(u.x as f64).to_degrees());
        }
    }
    let (first, last) = (headings[0], *headings.last().unwrap());
    let moved = moves_of(&dir, beam);
    let [lift, set] = moved[..] else {
        panic!("lifted once and set down once: {moved:?}")
    };
    assert!(lift.frame.slot.is_some(), "held in the carry's slot");
    let m = set.orientation.rotate(load.middle).unwrap();
    let middle = (set.position.x + m.x, set.position.z + m.z);
    println!(
        "R2: {} poses walked, {} samples of the carry, none through a wall; it turned from {first:.0} to {last:.0} \
         degrees through the 1.2 m doorway and was set down inside, its middle {} mm east of the wall's inner face",
        way.len(),
        headings.len(),
        (middle.0 - (wx + 200) * 1000) / 1000
    );
    assert!(headings.len() > 20, "the carry moved");
    assert!((first - 90.0).abs() < 5.0, "lifted facing north: {first}");
    assert!(
        last.abs() < 20.0,
        "set down facing east, into the room: {last}"
    );
    assert!(
        middle.0 > (wx + 200) * 1000 + 500_000 && middle.0 < (wx + 6_000) * 1000,
        "set down inside the room: {middle:?}"
    );
}

/// N2's test world with the 6.1 m upright (0.135 C6) standing loose where C4's upright stands, in its place, its kind
/// given to the facts as the yard's are; the construction entries (its own among them) in `d`.
fn tall_world(d: &Path) -> String {
    let mut f = json::parse(&world(d)).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    for (k, v) in top.iter_mut() {
        match (k.as_str(), v) {
            ("kinds", json::Value::Arr(a)) => a.push(json::Value::Obj(vec![
                ("ref".into(), json::Value::s("c6-rack-upright-6m@1")),
                ("hash".into(), json::Value::s(&"c6".repeat(32))),
                ("name".into(), json::Value::s("mars:rack_upright_6m")),
                ("form".into(), json::Value::s("point")),
            ])),
            ("things", json::Value::Arr(a)) => {
                for t in a.iter_mut() {
                    let json::Value::Obj(kv) = t else { continue };
                    if !kv
                        .iter()
                        .any(|(k, v)| k == "id" && v.str() == Some("loose-upright"))
                    {
                        continue;
                    }
                    for (k, v) in kv.iter_mut() {
                        match k.as_str() {
                            "id" => *v = json::Value::s("tall-upright"),
                            "def" | "ref" => *v = json::Value::s("c6-rack-upright-6m@1"),
                            "name" => *v = json::Value::s("a loose 6 m rack frame"),
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
    f.to_json()
}

/// 0.135 C6: a load that four carry. A 6.1 m upright one holds standing (`hold_crew` 1) takes four to carry
/// (`carry_crew` 4, `content/kinds/construction/rack_upright_6m.json`). In a served world four Souls walk to its four
/// grips (the front and the back at its ends, two sides beside its middle grips), and Soul 1 offers the carry to the
/// other three. With three in it the lift is refused `carry-crew-too-small` and nothing moves; the fourth accepts, and
/// the four carry it 25 m east laid flat, each by its own walk, and set it down. Then the served carry as a crew of
/// three (0.135 C5): the beam, which two carry, taken at its three grips; its side leaves the world (a retire) once it
/// is lifted, and the two carry it on 25 m (`souls:carry-going-on`, `souls:carrier-left`).
#[tokio::test(flavor = "multi_thread")]
async fn c6_four_souls_carry_a_6_m_upright_laid_flat_and_three_are_too_few() {
    let d = scratch("c6");
    let facts = tall_world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 4);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, tall) = (im.nodes["ground"], im.nodes["tall-upright"]);
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut crew = Vec::new();
    for (s, t) in souls.iter().zip(&tokens) {
        crew.push(Soul::connect(&url, *s, lineage, t).await);
    }
    hold("C6_WAIT").await;
    let at = upright_at();
    let (places, bodies) = carry_tall(&mut crew, &souls, &dir, ground, tall, at, "eden").await;

    // 0.135 C5 on the served carry: the beam, crew two, three grips. Souls 1 and 2 at its ends and Soul 3 beside its
    // middle grip lift it; Soul 3 leaves the world (a retire), and the carry goes on with two, 25 m east.
    let beam = im.nodes["yard-beam-4"];
    let beam_entry = construction("rack_beam.json");
    let bl = Load::of(&beam_entry).unwrap();
    let [back, front] = bl.places();
    let beside = Vec3::new(beam_at().x + bl.half_width + REACH, 0, beam_at().z);
    let spots = [
        spot(beam_at(), front, true),
        spot(beam_at(), back, true),
        beside,
    ];
    for (s, p) in crew.iter_mut().zip(&spots) {
        s.send("eden:walk", ground, point(*p)).await;
    }
    for s in &mut crew[..3] {
        s.answer().await.expect("walks to its place at the beam");
    }
    // Soul 4 steps 3 m north, off the beam's way.
    let p = places[3];
    crew[3]
        .act(
            "eden:walk",
            ground,
            point(Vec3::new(p.x + CARRIED, 0, p.z + 3 * M)),
        )
        .await
        .expect("Soul 4 steps aside");
    let offered = crew[0]
        .act(
            "activity:offer",
            ground,
            BTreeMap::from([
                (1, carry_kind(&dir)),
                (2, Value::Text(Name::new(FRONT).unwrap())),
                (3, Value::Array(bodies[..2].to_vec())),
            ]),
        )
        .await
        .expect("the carry offered to two");
    let three = carry_made(&dir, &offered);
    for s in &mut crew[1..3] {
        s.act("activity:accept", three, BTreeMap::new())
            .await
            .expect("accepts");
    }
    crew[0]
        .act("carry:lift", three, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("three lift the beam");
    // Soul 4 is not in this carry: its leave of it sets nothing down (the beam's moves below are its lift and its
    // set-down only, and no souls:carry-set-down is said).
    let _ = crew[3].act("activity:leave", three, BTreeMap::new()).await;
    crew[2]
        .act_on("life:leave", None, BTreeMap::new())
        .await
        .expect("Soul 3 leaves the world");
    for (s, p) in crew.iter_mut().zip(&spots[..2]) {
        s.send("eden:walk", ground, point(Vec3::new(p.x + CARRIED, 0, p.z)))
            .await;
    }
    for s in &mut crew[..2] {
        s.answer().await.expect("the two carry it on 25 m");
    }
    crew[1]
        .act("carry:set-down", three, BTreeMap::new())
        .await
        .expect("the beam set down");
    for s in &mut crew[..2] {
        s.act("activity:leave", three, BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }

    hold("C6_HOLD").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(served);
    let words = |name: &str| -> Vec<Value> {
        effects(&dir)
            .iter()
            .flat_map(|e| e.events.iter().flatten())
            .filter(|ev| ev.name.as_str() == name)
            .filter_map(|ev| ev.fields.get(&3).cloned())
            .collect()
    };
    assert!(
        words("souls:carry-set-down").is_empty(),
        "neither broke off, nor did a stranger's leave"
    );
    let carriers = [body_of(&dir, souls[0]), body_of(&dir, souls[1])];
    assert_eq!(
        words("souls:carry-going-on"),
        vec![Value::Text(Name::new("souls:carrier-left").unwrap())],
        "a side's retire leaves the carry going on"
    );
    held_and_set_down(
        &dir,
        "the beam",
        beam,
        &beam_entry,
        Vec3::new(0, 0, bl.half_length),
        beam_at(),
        true,
        carriers,
    );
    // Its length is its y, from its foot: laid flat when lifted, and set down so, 25 m east.
    let entry = construction("rack_upright_6m.json");
    let load = Load::of(&entry).unwrap();
    held_and_set_down(
        &dir,
        "the 6.1 m upright",
        tall,
        &entry,
        Vec3::new(0, load.half_length, 0),
        at,
        false,
        carriers,
    );
    println!(
        "C6: a served world carried the 6.1 m upright 25 m laid flat by four Souls' intents through the gateway, one \
         at each grip; three were refused carry-crew-too-small and nothing moved; a crew of three carried the beam, \
         its side retired and the two carried it on 25 m (souls:carrier-left)"
    );
}

/// Waits until each of `souls`' bodies stands within 0.3 m of its place in `to` (the log's body rows), at most 120 s: a
/// world whose gateway answers a walk once it starts (the clip's) is waited on as one that answers when it ends.
async fn arrived(dir: &Path, souls: &[Id], to: &[Vec3]) {
    let bodies: Vec<Id> = souls.iter().map(|s| body_of(dir, *s)).collect();
    let end = Instant::now() + Duration::from_secs(120);
    loop {
        let mut at = BTreeMap::new();
        let bytes = std::fs::read(dir.join("log")).unwrap_or_default();
        for r in sim::log::recover(&bytes)
            .map(|r| r.records)
            .unwrap_or_default()
        {
            let Ok(p) = Part::read(&r) else { continue };
            if let Some(Value::Array(rows)) = p.rest.get(&answers::BODIES) {
                for (b, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                    at.insert(b, pose.position);
                }
            }
        }
        let near = bodies.iter().zip(to).all(|(b, p)| {
            at.get(b)
                .is_some_and(|q| (q.x - p.x).abs() < 300_000 && (q.z - p.z).abs() < 300_000)
        });
        if near {
            return;
        }
        assert!(Instant::now() < end, "not at their places in 120 s");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The 6.1 m upright (0.135 C6) at `at`, standing, carried 25 m east by the four Souls `crew` (their Ids `souls`) in the
/// world folder `dir`: each walks to its grip, three are refused `carry-crew-too-small` and nothing moves, the fourth
/// joins, the four lift it, carry it and set it down, and all leave. Their places at it and the bodies asked.
async fn carry_tall(
    crew: &mut [Soul],
    souls: &[Id],
    dir: &Path,
    ground: Id,
    tall: Id,
    at: Vec3,
    ns: &str,
) -> (Vec<Vec3>, Vec<Value>) {
    let walk = format!("{ns}:walk");
    let entry = construction("rack_upright_6m.json");
    let load = Load::of(&entry).unwrap();
    assert_eq!(
        (load.crew, load.most()),
        (4, 4),
        "four carry it, one at each grip"
    );

    // It stands: its carriers take it along the line they stand on, Soul 1 at the east end, the sides beside it.
    let [back, front] = load.places();
    let mut places = vec![spot(at, front, false), spot(at, back, false)];
    places.extend(
        load.side_places()
            .into_iter()
            .map(|[along, across]| Vec3::new(at.x + along, 0, at.z + across)),
    );
    for (s, p) in crew.iter_mut().zip(&places) {
        s.send(&walk, ground, point(*p)).await;
    }
    for s in crew.iter_mut() {
        s.answer().await.expect("walks to its place");
    }
    arrived(dir, souls, &places).await;
    let bodies: Vec<Value> = souls[1..]
        .iter()
        .map(|s| body_of(dir, *s).to_value())
        .collect();
    let offered = crew[0]
        .act(
            "activity:offer",
            ground,
            BTreeMap::from([
                (1, carry_kind(dir)),
                (2, Value::Text(Name::new(FRONT).unwrap())),
                (3, Value::Array(bodies.clone())),
            ]),
        )
        .await
        .expect("the carry offered to three");
    let carry = carry_made(dir, &offered);
    let lift = || BTreeMap::from([(1, tall.to_value())]);
    for s in &mut crew[1..3] {
        s.act("activity:accept", carry, BTreeMap::new())
            .await
            .expect("accepts");
    }
    let three = crew[0].act("carry:lift", carry, lift()).await;
    assert_eq!(
        three,
        Err("carry-crew-too-small".to_owned()),
        "three are too few"
    );
    assert!(moves_of(dir, tall).is_empty(), "nothing moved");
    crew[3]
        .act("activity:accept", carry, BTreeMap::new())
        .await
        .expect("the fourth accepts");
    crew[0]
        .act("carry:lift", carry, lift())
        .await
        .expect("four lift it");
    for (s, p) in crew.iter_mut().zip(&places) {
        s.send(&walk, ground, point(Vec3::new(p.x + CARRIED, 0, p.z)))
            .await;
    }
    for s in crew.iter_mut() {
        s.answer().await.expect("carries it 25 m");
    }
    let ahead: Vec<Vec3> = places
        .iter()
        .map(|p| Vec3::new(p.x + CARRIED, 0, p.z))
        .collect();
    arrived(dir, souls, &ahead).await;
    crew[1]
        .act("carry:set-down", carry, BTreeMap::new())
        .await
        .expect("set down");
    for s in crew.iter_mut() {
        s.act("activity:leave", carry, BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }
    (places, bodies)
}

/// `C6_WAIT=<s>` seconds after the Souls sign in (a page opens on the world) and `C6_HOLD=<s>` after the scene, to
/// watch it; else none.
async fn hold(var: &str) {
    if let Some(s) = std::env::var(var).ok().and_then(|v| v.parse::<u64>().ok()) {
        tokio::time::sleep(Duration::from_secs(s)).await;
    }
}

/// The C6 clip's driver (0.135 C6; run by hand, never in CI): the tall carry on a world another process runs, while the
/// old page watches it. `C6_WORLD=<file>` names `{"gateway": its ws URL, "dir": the world's folder, "facts": its facts
/// file, "souls": [["s_<hex>-<n>", "<token>"], ...four], "at": [x m, z m]}`, the 6.1 m upright's place, and
/// `"ns"`, its Souls' verbs' namespace (default `dev`, run.sh's world).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "drives a world another process runs: the C6 clip"]
async fn c6_clip_four_souls_carry_the_6_m_upright_on_a_running_world() {
    let Ok(file) = std::env::var("C6_WORLD") else {
        return;
    };
    let w = json::parse(&std::fs::read_to_string(file).unwrap()).unwrap();
    let text = |k: &str| w.get(k).and_then(json::Value::str).unwrap().to_owned();
    let facts = std::fs::read_to_string(text("facts")).unwrap();
    let im = import_eden::load(&facts).unwrap();
    let (ground, tall) = (im.nodes["ground"], im.nodes["tall-upright"]);
    let lineage = im.nodes["world"].scope();
    let dir = PathBuf::from(text("dir"));
    let (mut souls, mut crew) = (Vec::new(), Vec::new());
    for s in w.get("souls").and_then(json::Value::arr).unwrap() {
        let pair = s.arr().unwrap();
        let (scope, n) = pair[0]
            .str()
            .and_then(|s| s.strip_prefix("s_"))
            .and_then(|s| s.split_once('-'))
            .unwrap();
        let scope: [u8; 16] = from_hex(scope).unwrap().try_into().unwrap();
        let id = Id::new(Scope(scope), n.parse().unwrap()).unwrap();
        let token = Token::parse(pair[1].str().unwrap()).unwrap();
        let mut soul = Soul::connect(&text("gateway"), id, lineage, &token).await;
        // Past every sequence its own client sent: a sequence the gateway has answered gets that answer again.
        soul.sequence = 1 << 40;
        crew.push(soul);
        souls.push(id);
    }
    let metres = |v: &json::Value| match v {
        json::Value::Int(n) => i64::try_from(*n).unwrap() * M,
        _ => panic!("metres"),
    };
    let at = w.get("at").and_then(json::Value::arr).unwrap();
    let at = Vec3::new(metres(&at[0]), 0, metres(&at[1]));
    hold("C6_WAIT").await;
    let ns = w.get("ns").and_then(json::Value::str).unwrap_or("dev");
    let from = answers::now();
    carry_tall(&mut crew, &souls, &dir, ground, tall, at, ns).await;
    // The span a recorder plays back on the old page (`scene.mjs --span --from .. --to ..`), world µs.
    println!(
        "C6 clip: four Souls carried the 6.1 m upright 25 m, from {from} to {}",
        answers::now()
    );
}

// --- Carrying together: the crew walks with its front (moving-group rule 3) -------------------------------------------

/// Where each body stands, as the log's last body rows have it.
fn stood(dir: &Path) -> BTreeMap<Id, Vec3> {
    let mut at = BTreeMap::new();
    let bytes = std::fs::read(dir.join("log")).unwrap_or_default();
    for r in sim::log::recover(&bytes)
        .map(|r| r.records)
        .unwrap_or_default()
    {
        let Ok(p) = Part::read(&r) else { continue };
        if let Some(Value::Array(rows)) = p.rest.get(&answers::BODIES) {
            for (b, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                at.insert(b, pose.position);
            }
        }
    }
    at
}

/// The bodies `bodies` each within 0.3 m of its place in `to` within `secs` seconds; else the test fails, naming how
/// far each stood. How long it took.
async fn together(dir: &Path, bodies: &[Id], to: &[Vec3], secs: u64) -> Duration {
    let t0 = Instant::now();
    loop {
        let at = stood(dir);
        let off: Vec<i64> = bodies
            .iter()
            .zip(to)
            .map(|(b, p)| {
                at.get(b).map_or(i64::MAX, |q| {
                    (i128::from(q.x - p.x).pow(2) + i128::from(q.z - p.z).pow(2)).isqrt() as i64
                })
            })
            .collect();
        if off.iter().all(|d| *d < 300_000) {
            return t0.elapsed();
        }
        assert!(
            t0.elapsed() < Duration::from_secs(secs),
            "not all at their places within {secs} s: µm off {off:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The 6.1 m upright with six grips, one at each of its six carriers (the front, the back and four sides), as its
/// entry in the world's folder of entries `d` states it; `carry_crew` 4 as before.
fn six_grips(d: &Path) {
    let p = d.join("entries").join("rack_upright_6m.json");
    let mut e = json::parse(&std::fs::read_to_string(&p).unwrap()).unwrap();
    let json::Value::Obj(top) = &mut e else {
        panic!("an entry")
    };
    let num = |v: i64| json::Value::Int(i128::from(v));
    for (k, v) in top.iter_mut() {
        if k == "points" {
            let json::Value::Obj(points) = v else {
                panic!("points")
            };
            points.retain(|(_, p)| p.get("role").and_then(json::Value::str) != Some("grip"));
            for (n, y) in [300, 1399, 2498, 3598, 4697, 5796].iter().enumerate() {
                points.push((
                    format!("grip_{n}"),
                    json::Value::Obj(vec![
                        ("role".into(), json::Value::s("grip")),
                        (
                            "at_mm".into(),
                            json::Value::Arr([0, *y, 0].map(num).to_vec()),
                        ),
                    ]),
                ));
            }
        }
    }
    std::fs::write(&p, e.to_json()).unwrap();
}

/// Where a crew of `n` stands at a load whose middle is `at` and whose length lies along x (or stands: taken along x):
/// the front east, the back west, then its sides at its grips between, in join order.
fn crew_places(at: Vec3, load: &Load, n: usize) -> Vec<Vec3> {
    let [back, front] = load.places();
    let mut p = vec![spot(at, front, false), spot(at, back, false)];
    p.extend(
        load.side_places()
            .into_iter()
            .take(n - 2)
            .map(|[along, across]| Vec3::new(at.x + along, 0, at.z + across)),
    );
    p
}

/// The crew `crew` (its first the front, then the back, then its sides in grip order), at `places`, takes up `load`:
/// each walks to its place, the front offers the carry to the rest, each accepts in turn and the front lifts it. Then
/// only the front walks, `by` µm along x; the others send nothing. Each must stand at its place moved `by` within 3 s
/// of the front's walk ending. The crew sets it down and every one leaves. The carry, and how long the last took to
/// arrive after the front.
#[allow(clippy::too_many_arguments)]
async fn front_only(
    crew: &mut [Soul],
    dir: &Path,
    ground: Id,
    load: Id,
    places: &[Vec3],
    by: i64,
    late: Option<usize>,
    what: &str,
) -> (Id, Duration) {
    for (s, p) in crew.iter_mut().zip(places) {
        s.send("eden:walk", ground, point(*p)).await;
    }
    for s in crew.iter_mut() {
        s.answer().await.expect("walks to its place");
    }
    let bodies: Vec<Id> = crew.iter().map(|s| body_of(dir, s.id)).collect();
    together(dir, &bodies, places, 60).await;
    let others: Vec<Value> = bodies[1..].iter().map(|b| b.to_value()).collect();
    let offered = crew[0]
        .act(
            "activity:offer",
            ground,
            BTreeMap::from([
                (1, carry_kind(dir)),
                (2, Value::Text(Name::new(FRONT).unwrap())),
                (3, Value::Array(others)),
            ]),
        )
        .await
        .expect("the carry offered");
    let carry = carry_made(dir, &offered);
    for s in crew[1..].iter_mut() {
        s.act("activity:accept", carry, BTreeMap::new())
            .await
            .expect("accepts");
    }
    crew[0]
        .act("carry:lift", carry, BTreeMap::from([(1, load.to_value())]))
        .await
        .expect("lifted");
    let ahead: Vec<Vec3> = places.iter().map(|p| Vec3::new(p.x + by, 0, p.z)).collect();
    crew[0].send("eden:walk", ground, point(ahead[0])).await;
    // A late carrier sends its own walk to its place 2 s after the front set off: it takes its legs back and walks its
    // own way, still in the carry, and the group is not broken.
    if let Some(k) = late {
        tokio::time::sleep(Duration::from_secs(2)).await;
        crew[k].send("eden:walk", ground, point(ahead[k])).await;
        crew[k]
            .answer()
            .await
            .unwrap_or_else(|r| panic!("{what}: the late carrier's own walk: {r}"));
    }
    crew[0]
        .answer()
        .await
        .unwrap_or_else(|r| panic!("{what}: the front carries it: {r}"));
    let late = together(dir, &bodies, &ahead, 3).await;
    println!(
        "{what}: only the front walked {} m; all {} at their places {} ms after it arrived",
        by / M,
        crew.len(),
        late.as_millis()
    );
    crew[1]
        .act("carry:set-down", carry, BTreeMap::new())
        .await
        .unwrap_or_else(|r| panic!("{what}: still carried, and set down: {r}"));
    for s in crew.iter_mut() {
        s.act("activity:leave", carry, BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }
    (carry, late)
}

/// The world's `souls:carry-set-down` words' reasons, in order: each carry that broke off.
fn broke(dir: &Path) -> Vec<String> {
    effects(dir)
        .iter()
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == "souls:carry-set-down")
        .filter_map(|ev| match ev.fields.get(&3) {
            Some(Value::Text(t)) => Some(t.as_str().to_owned()),
            _ => None,
        })
        .collect()
}

/// The `souls:follow` orders accepted and not ended, by the log: none is left open once a carry is over.
fn open_follows(dir: &Path) -> usize {
    use sim::host::restart::{ORDER, ORDER_ENDED};
    let mut open = std::collections::BTreeSet::new();
    for ev in effects(dir).iter().flat_map(|e| e.events.iter().flatten()) {
        match (ev.name.as_str(), ev.fields.get(&1), ev.fields.get(&2)) {
            (n, Some(i), Some(Value::Text(v))) if n == ORDER && v.as_str() == "souls:follow" => {
                open.insert(format!("{i:?}"));
            }
            (n, Some(i), _) if n == ORDER_ENDED => {
                open.remove(&format!("{i:?}"));
            }
            _ => {}
        }
    }
    open.len()
}

/// Carrying together (moving-group rule 3): a crew moves as one when only its front walks. Separate agents each take
/// seconds a turn, so no crew can rely on its carriers setting off within the 0.7 s a 1 m stretch allows. In a served
/// world, six Souls carry the 6.1 m upright (six grips) 25 m east; four carry it 25 m back west, their front walking
/// backwards along it; two carry a beam 25 m east, sideways to its length. Each time only the front's Soul sends a
/// walk and the rest send nothing: every carrier walks with it by its own follow order, keeping its place, all arrive
/// within 3 s of the front, nothing breaks off, and each load is set down where its crew took it to.
#[tokio::test(flavor = "multi_thread")]
async fn group_only_the_front_walks_and_crews_of_two_four_and_six_arrive_together() {
    let d = scratch("cgroup");
    let facts = tall_world(&d);
    six_grips(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 6);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, tall, beam) = (
        im.nodes["ground"],
        im.nodes["tall-upright"],
        im.nodes["yard-beam-4"],
    );
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut crew = Vec::new();
    for (s, t) in souls.iter().zip(&tokens) {
        crew.push(Soul::connect(&url, *s, lineage, t).await);
    }
    let entry = json::parse(
        &std::fs::read_to_string(d.join("entries").join("rack_upright_6m.json")).unwrap(),
    )
    .unwrap();
    let load = Load::of(&entry).unwrap();
    assert_eq!((load.crew, load.most()), (4, 6), "four to six carry it");

    // Six, 25 m east, along its length.
    let six = crew_places(upright_at(), &load, 6);
    let (_, late6) = front_only(&mut crew, &dir, ground, tall, &six, 25 * M, None, "six").await;

    // Four, 25 m back west: the front, at its east end, walks backwards. Souls 5 and 6 step out of the way first.
    let east = Vec3::new(upright_at().x + 25 * M, 0, upright_at().z);
    for (k, s) in crew[4..].iter_mut().enumerate() {
        let p = six[4 + k];
        let aside = Vec3::new(p.x + 25 * M, 0, p.z + [3, 5][k] * M);
        s.act("eden:walk", ground, point(aside))
            .await
            .expect("steps aside");
    }
    let four = crew_places(east, &load, 4);
    let (_, late4) = front_only(
        &mut crew[..4],
        &dir,
        ground,
        tall,
        &four,
        -25 * M,
        Some(1),
        "four, the back 2 s late",
    )
    .await;

    // Two, the beam 25 m east: it lies along z, so they carry it sideways, the front at its +z end.
    let bl = Load::of(&construction("rack_beam.json")).unwrap();
    let [back, front] = bl.places();
    let two = [spot(beam_at(), front, true), spot(beam_at(), back, true)];
    let (_, late2) = front_only(
        &mut crew[..2],
        &dir,
        ground,
        beam,
        &two,
        25 * M,
        None,
        "two",
    )
    .await;

    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(served);
    assert!(
        broke(&dir).is_empty(),
        "nothing broke off: {:?}",
        broke(&dir)
    );
    assert_eq!(open_follows(&dir), 0, "every carrier's follow order ended");
    // Each load where its last crew took it: its middle within 0.6 m.
    for (name, id, entry, to) in [
        ("the upright", tall, entry, upright_at()),
        (
            "the beam",
            beam,
            construction("rack_beam.json"),
            Vec3::new(beam_at().x + 25 * M, 0, beam_at().z),
        ),
    ] {
        let l = Load::of(&entry).unwrap();
        let last = *moves_of(&dir, id).last().expect("moved");
        let m = last.orientation.rotate(l.middle).unwrap();
        let (x, z) = (last.position.x + m.x, last.position.z + m.z);
        println!(
            "{name}: set down with its middle at ({}, {}) mm",
            x / 1000,
            z / 1000
        );
        assert!(
            (x - to.x).abs() < 600_000 && (z - to.z).abs() < 600_000,
            "{name}: set down where its crew took it"
        );
    }
    println!(
        "group: crews of six, four and two each carried by the front's walk alone; the last carrier arrived {} ms, \
         {} ms and {} ms after the front; nothing broke off",
        late6.as_millis(),
        late4.as_millis(),
        late2.as_millis()
    );
}

/// Carrying together: a carrier may let go mid-walk, and the world says why. Three carry the beam (its front, its back
/// and a side at its middle grip), only the front walking 25 m east. 3 s in, the side leaves: the beam's crew of two is
/// left, so the carry goes on (`souls:carry-going-on`, `souls:carrier-left`), the side stops where it let go, and the
/// two arrive together. Then the two lift it again and the front walks 25 m back west; 3 s in, the back leaves: the
/// carry breaks off (`souls:partner-left`), the beam is set down where it is, and the front's walk, which led the
/// carry, stops there, ended by that reason: the whole group stops with one reason.
#[tokio::test(flavor = "multi_thread")]
async fn group_a_carrier_lets_go_mid_walk() {
    let d = scratch("cletgo");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 3);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam) = (im.nodes["ground"], im.nodes["yard-beam-4"]);
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut crew = Vec::new();
    for (s, t) in souls.iter().zip(&tokens) {
        crew.push(Soul::connect(&url, *s, lineage, t).await);
    }
    let bl = Load::of(&construction("rack_beam.json")).unwrap();
    let [back, front] = bl.places();
    let places = [
        spot(beam_at(), front, true),
        spot(beam_at(), back, true),
        Vec3::new(beam_at().x + bl.half_width + REACH, 0, beam_at().z),
    ];
    for (s, p) in crew.iter_mut().zip(&places) {
        s.send("eden:walk", ground, point(*p)).await;
    }
    for s in crew.iter_mut() {
        s.answer().await.expect("walks to its place");
    }
    // A body is born at its Soul's first act.
    let bodies: Vec<Id> = souls.iter().map(|s| body_of(&dir, *s)).collect();
    together(&dir, &bodies, &places, 60).await;
    let offered = crew[0]
        .act(
            "activity:offer",
            ground,
            BTreeMap::from([
                (1, carry_kind(&dir)),
                (2, Value::Text(Name::new(FRONT).unwrap())),
                (
                    3,
                    Value::Array(vec![bodies[1].to_value(), bodies[2].to_value()]),
                ),
            ]),
        )
        .await
        .expect("offered");
    let carry = carry_made(&dir, &offered);
    for s in crew[1..].iter_mut() {
        s.act("activity:accept", carry, BTreeMap::new())
            .await
            .expect("accepts");
    }
    crew[0]
        .act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("three lift the beam");
    let ahead: Vec<Vec3> = places
        .iter()
        .map(|p| Vec3::new(p.x + 25 * M, 0, p.z))
        .collect();
    crew[0].send("eden:walk", ground, point(ahead[0])).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    crew[2]
        .act("activity:leave", carry, BTreeMap::new())
        .await
        .expect("the side lets go");
    let left_at = stood(&dir)[&bodies[2]];
    crew[0]
        .answer()
        .await
        .expect("the front carries it on with the back");
    let late = together(&dir, &bodies[..2], &ahead[..2], 3).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let side = stood(&dir)[&bodies[2]];
    println!(
        "the side let go at x {} mm and stood at x {} mm; the two arrived {} ms apart",
        left_at.x / 1000,
        side.x / 1000,
        late.as_millis()
    );
    assert!(
        (side.x - left_at.x).abs() < 600_000 && side.x < ahead[2].x - 10 * M,
        "the side stops where it let go"
    );

    // The two carry it back west; 3 s in, the back lets go.
    let here: Vec<Vec3> = ahead[..2].to_vec();
    crew[0]
        .act("carry:set-down", carry, BTreeMap::new())
        .await
        .expect("set down");
    crew[0]
        .act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("lifted again");
    let west = Vec3::new(here[0].x - 25 * M, 0, here[0].z);
    crew[0].send("eden:walk", ground, point(west)).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    crew[1]
        .act("activity:leave", carry, BTreeMap::new())
        .await
        .expect("the back lets go");
    let walked = crew[0].answer().await;
    assert_eq!(
        walked,
        Err("souls:partner-left".to_owned()),
        "the front's walk stops with the carry"
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let at = stood(&dir);
    let (f, k) = (at[&bodies[0]], at[&bodies[1]]);
    println!(
        "the back let go: the front stopped at x {} mm, the back at x {} mm",
        f.x / 1000,
        k.x / 1000
    );
    assert!(
        f.x > west.x + 10 * M && k.x > west.x + 10 * M,
        "both stopped short of where the front was going"
    );
    for k in [0, 2] {
        let _ = crew[k].act("activity:leave", carry, BTreeMap::new()).await;
    }

    // The front lets go itself, 3 s into a walk: the carry breaks off and the beam is set down, and the front's own
    // walk goes on to where it was going.
    let again = crew[0]
        .act(
            "activity:offer",
            ground,
            BTreeMap::from([
                (1, carry_kind(&dir)),
                (2, Value::Text(Name::new(FRONT).unwrap())),
                (3, Value::Array(vec![bodies[1].to_value()])),
            ]),
        )
        .await
        .expect("offered again");
    let third = carry_made(&dir, &again);
    crew[1]
        .act("activity:accept", third, BTreeMap::new())
        .await
        .expect("the back accepts again");
    crew[0]
        .act("carry:lift", third, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("lifted where it lies");
    let on = Vec3::new(f.x + 14 * M, 0, f.z);
    crew[0].send("eden:walk", ground, point(on)).await;
    let walk = crew[0].sequence;
    tokio::time::sleep(Duration::from_secs(3)).await;
    crew[0]
        .act("activity:leave", third, BTreeMap::new())
        .await
        .expect("the front lets go");
    // The walk's own answer, by its sequence (the leave's came first).
    let leave = crew[0].sequence;
    crew[0].sequence = walk;
    let walked_on = crew[0].answer().await;
    crew[0].sequence = leave;
    walked_on.expect("the front's own walk goes on when it lets go itself");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let at = stood(&dir);
    println!(
        "the front let go: it walked on to x {} mm; the back stopped at x {} mm",
        at[&bodies[0]].x / 1000,
        at[&bodies[1]].x / 1000
    );
    assert!(
        at[&bodies[1]].x < on.x - 5 * M,
        "the back, no longer led, stopped"
    );
    let _ = crew[1].act("activity:leave", third, BTreeMap::new()).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(served);
    let words = |name: &str| -> Vec<Value> {
        effects(&dir)
            .iter()
            .flat_map(|e| e.events.iter().flatten())
            .filter(|ev| ev.name.as_str() == name)
            .filter_map(|ev| ev.fields.get(&3).cloned())
            .collect()
    };
    assert_eq!(
        words("souls:carry-going-on"),
        vec![Value::Text(Name::new("souls:carrier-left").unwrap())],
        "the side's leave left the carry going on"
    );
    assert_eq!(
        broke(&dir),
        vec![
            "souls:partner-left".to_owned(),
            "souls:partner-left".to_owned()
        ],
        "the back's leave broke it off, then the front's"
    );
    assert_eq!(open_follows(&dir), 0, "every carrier's follow order ended");
}

/// Carrying together: a blocked way stops the whole group with one reason. The beam is carried east by its front's
/// walk alone, its carriers either side of a post on the line between them ([`post_world`]): its back walks with the
/// front, the beam meets the post, the carry stops there and the beam is set down (`souls:carry-blocked`); the front's
/// walk ends by that reason, and the back, its place no longer kept for a carry, stops with it. Neither passes the
/// post.
#[tokio::test(flavor = "multi_thread")]
async fn group_a_blocked_way_stops_the_whole_group() {
    let d = scratch("cblock");
    let (facts, post) = post_world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam) = (im.nodes["ground"], im.nodes["yard-beam-4"]);
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut a = Soul::connect(&url, souls[0], lineage, &tokens[0]).await;
    let mut b = Soul::connect(&url, souls[1], lineage, &tokens[1]).await;
    let entry = construction("rack_beam.json");
    let [_, front] = Load::of(&entry).unwrap().places();
    let carry = gather(&mut a, &mut b, &dir, ground, beam, &entry, beam_at(), true).await;
    a.act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("lifted");
    let to = spot(beam_at(), front, true);
    let walked = a
        .act(
            "eden:walk",
            ground,
            point(Vec3::new(to.x + 12 * M, 0, to.z)),
        )
        .await;
    assert_eq!(
        walked,
        Err("souls:carry-blocked".to_owned()),
        "the front's walk stops with its carry"
    );
    tokio::time::sleep(Duration::from_secs(1)).await;
    let at = stood(&dir);
    let (f, k) = (at[&body_of(&dir, souls[0])], at[&body_of(&dir, souls[1])]);
    println!(
        "blocked: the front stopped at x {} mm, the back at x {} mm; the post's west face at x {} mm",
        f.x / 1000,
        k.x / 1000,
        (post.0 - 100_000) / 1000
    );
    assert!(
        f.x < post.0 && k.x < post.0,
        "neither passed the post: {} {}",
        f.x,
        k.x
    );
    assert!(
        (f.x - k.x).abs() < 500_000,
        "the back stopped with the front"
    );
    let down = b.act("carry:set-down", carry, BTreeMap::new()).await;
    assert_eq!(down, Err("not-carried".to_owned()), "the carry had stopped");
    for s in [&mut a, &mut b] {
        s.act("activity:leave", carry, BTreeMap::new())
            .await
            .expect("each carrier leaves");
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(served);
    assert_eq!(broke(&dir), vec!["souls:carry-blocked".to_owned()]);
    assert_eq!(open_follows(&dir), 0, "the back's follow order ended");
}
