//! B10 (#4239): accepted activity roles bind to the entry's forms, on a world served by `worldd serve`, two Souls'
//! own intents through a real gateway, one connection and one token each. The game is a two-sided turn game (the
//! shape of Soul Actions' counter match, #4391): its roles `first` and `second` are its links, and its forms ask for
//! them (`linked` with `end: actor`, and `who: {link}`). No link is supplied by hand: Soul 1 offers the game at the
//! board in the role `first`, Soul 2 accepts it as `second`, and each then holds its role's link on the board,
//! written in the offer's and the accept's own parts, acted and caused by them.
//!
//! Each Soul makes only its own side's move: the other side's is refused by name (`not_linked`, `not-permitted`).
//! When Soul 2 leaves, its link goes in its leave's part, and Soul 1's move is refused again (`not_linked`: the other
//! side is missing); when Soul 1 leaves, the activity ends and no role link is left on the board.
//! `cargo test -p worldd --test roles_served -- --nocapture`.

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
use replica::effects::{Actor, Body, Cause, Change, Effect, Part};
use replica::encode::{Name, Value, decode, encode, from_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL, Target};
use replica::rules::json;
use replica::world_model::plain;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::answers;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0xb1, 0x00];
const GAME: &str = "eden:turn_test_activity";
const FIRST: &str = "eden:first";
const SECOND: &str = "eden:second";
/// Where the Souls are born (m) and where the board stands (mm), 2 m east of them.
const BORN: (i64, i64) = (44, -18);
const BOARD_AT: [i64; 3] = [46_000, 0, -18_000];

/// A two-sided turn game, the counter match's shape (#4391) cut to one take a side: its roles are its links.
const ENTRY: &str = r#"{
  "format": "souls-entry/1",
  "kind": "eden:turn_test",
  "owner": "thing",
  "state": {
    "turn": {"n": 1, "type": "enum", "default": "first", "audience": {"rule": "everyone"}, "values": ["first", "second"]}
  },
  "links": {
    "first": {"n": 1, "from": "body", "most": 1, "audience": {"rule": "everyone"}},
    "second": {"n": 2, "from": "body", "most": 1, "audience": {"rule": "everyone"}}
  },
  "points": {
    "first_stand": {"role": "stand", "at_mm": [-550, 0, 450], "yaw_mdeg": 90000},
    "second_stand": {"role": "stand", "at_mm": [550, 0, 450], "yaw_mdeg": -90000},
    "pile": {"role": "contact", "at_mm": [0, 760, 0]}
  },
  "geometry": {"bounds_mm": [1500, 900, 1500]},
  "forms": {
    "take_first": {
      "who": "anyone",
      "starts": "act",
      "needs": [
        {"need": "linked", "link": "first", "end": "actor", "says": "join_first"},
        {"need": "linked", "link": "second", "says": "other_side_missing"},
        {"need": "state", "field": "turn", "is": "first", "says": "second_to_play"},
        {"need": "within_reach", "point": "pile"}
      ],
      "steps": [{"step": "walk_to", "point": "first_stand"}, {"step": "move", "move": "press", "at": "pile"}],
      "effects": [{"change": "set", "field": "turn", "to": "second", "event": "turn_passed"}]
    },
    "take_second": {
      "who": "anyone",
      "starts": "act",
      "needs": [
        {"need": "linked", "link": "second", "end": "actor", "says": "join_second"},
        {"need": "linked", "link": "first", "says": "other_side_missing"},
        {"need": "state", "field": "turn", "is": "second", "says": "first_to_play"},
        {"need": "within_reach", "point": "pile"}
      ],
      "steps": [{"step": "walk_to", "point": "second_stand"}, {"step": "move", "move": "press", "at": "pile"}],
      "effects": [{"change": "set", "field": "turn", "to": "first", "event": "turn_passed"}]
    },
    "concede": {
      "who": {"link": "second"},
      "starts": "act",
      "steps": [{"step": "walk_to", "point": "second_stand"}],
      "effects": [{"change": "set", "field": "turn", "to": "first", "event": "conceded"}]
    }
  },
  "roles": {
    "first": {"need": "required", "places": {"in": "here", "within_mm": 2000}},
    "second": {"need": "required", "places": {"in": "here", "within_mm": 2000}}
  },
  "motion": {"how": "fixed"},
  "loose": {"ever": true},
  "text": {
    "card": "A two-sided turn game.",
    "join_first": "Join as the first side.",
    "join_second": "Join as the second side.",
    "other_side_missing": "Both sides must have a member.",
    "first_to_play": "First side's turn.",
    "second_to_play": "Second side's turn."
  }
}"#;

fn scratch(tag: &str) -> PathBuf {
    // Short: a Unix socket's path is at most 104 bytes on macOS.
    let d = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

/// N2's test world with the board standing on the open ground beside where the Souls are born, and the folder of
/// entries: the game and the body.
fn world(d: &Path) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    std::fs::write(entries.join("turn_test.json"), ENTRY).unwrap();
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
    let def = "core-turn_test@1";
    for (k, v) in top.iter_mut() {
        match (k.as_str(), v) {
            ("kinds", json::Value::Arr(a)) => a.push(
                json::parse(&format!(
                    r#"{{"ref":"{def}","hash":"{}","name":"core:turn_test","form":"point","layer":"solid","door":false,"mesh":false,"slots":1}}"#,
                    "b10".repeat(21) + "b"
                ))
                .unwrap(),
            ),
            ("things", json::Value::Arr(a)) => {
                let pose = json::Value::Arr([BOARD_AT[0], 0, BOARD_AT[2], 0].map(num).to_vec());
                a.push(json::Value::Obj(vec![
                    ("id".into(), json::Value::s("turn-board")),
                    ("def".into(), json::Value::s(def)),
                    ("ref".into(), json::Value::s(def)),
                    ("parent".into(), json::Value::Null),
                    ("pose".into(), pose.clone()),
                    ("world".into(), pose),
                    ("scale_ppm".into(), num(1_000_000)),
                    ("name".into(), json::Value::s("a turn game")),
                ]));
            }
            _ => {}
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

/// `worldd seed` of `facts` with the entries in `d`, two Souls born at [`BORN`]; then `worldd serve` on `socket`.
fn seed_and_serve(d: &Path, facts: &str, socket: &Path) -> (PathBuf, [Id; 2], Served) {
    let path = d.join("facts.json");
    std::fs::write(&path, facts).unwrap();
    let dir = d.join("w");
    let out = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["seed", "--facts"])
        .arg(&path)
        .arg("--dir")
        .arg(&dir)
        .args(["--souls", "2", "--at", &format!("{},{}", BORN.0, BORN.1)])
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
    let souls = [1, 2].map(|c| Id::new(Scope(scope), c).unwrap());
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

/// The game's activity kind as the served world pins it (`world.kinds`' boot lines), as an intent names a kind.
fn game_kind(dir: &Path) -> Value {
    let text = std::fs::read_to_string(dir.join("world.kinds")).expect("world.kinds");
    let full = text
        .lines()
        .filter_map(|l| l.strip_prefix("# souls-boot-activity "))
        .filter_map(|l| l.split_once(' ').map(|(_, a)| a))
        .find(|a| plain(a) == GAME)
        .expect("the game's activity is served");
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

fn changes(e: &Effect) -> impl Iterator<Item = &Change> {
    let cs = match &e.body {
        Body::Changes(cs) => cs.as_slice(),
        _ => &[],
    };
    cs.iter().map(|c| &c.change)
}

/// The body born for `soul`, by its `souls:body-of` link.
fn body_of(dir: &Path, soul: Id) -> Id {
    in_log(dir, |es| {
        es.iter().flat_map(changes).find_map(|c| match c {
            Change::Link { ty, ends, .. } if ty.as_str() == "souls:body-of" && ends.contains(&soul) => {
                ends.iter().copied().find(|e| *e != soul)
            }
            _ => None,
        })
    })
}

/// The game made by the entries numbered `seq`.
fn game_made(dir: &Path, seq: &[u64]) -> Id {
    in_log(dir, |es| {
        es.iter()
            .filter(|e| seq.contains(&e.envelope.sequence))
            .flat_map(changes)
            .find_map(|c| match c {
                Change::Create { node, kind, .. } if plain(kind.as_str()) == GAME => Some(*node),
                _ => None,
            })
    })
}

/// The role links on `board` the log holds now, as `(type, body)`, in the order written, each with the actor and
/// cause of the entry that wrote it; and the links taken down since.
fn role_links(dir: &Path, board: Id) -> (Vec<(String, Id, Actor, Cause)>, usize) {
    let mut live: Vec<(Id, (String, Id, Actor, Cause))> = Vec::new();
    let mut gone = 0;
    for e in effects(dir).iter().filter(|e| e.envelope.node == board) {
        for c in changes(e) {
            match c {
                Change::Link {
                    link, ty, ends, ..
                } if ty.as_str() == FIRST || ty.as_str() == SECOND => {
                    live.push((
                        *link,
                        (ty.as_str().to_owned(), ends[0], e.envelope.actor, e.envelope.cause),
                    ));
                }
                Change::Unlink { link } => {
                    let n = live.len();
                    live.retain(|(l, _)| l != link);
                    gone += n - live.len();
                }
                _ => {}
            }
        }
    }
    (live.into_iter().map(|(_, r)| r).collect(), gone)
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
        self.sequence += 1;
        let i = Intent {
            actor: Actor::Soul(self.id),
            verb: Name::new(verb).unwrap(),
            target: Some(Target::Node(target)),
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

    /// A form of the board, with no arguments.
    async fn form(&mut self, form: &str, board: Id) -> Result<Vec<u64>, String> {
        self.act(&format!("eden:{form}"), board, BTreeMap::new())
            .await
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

#[tokio::test(flavor = "multi_thread")]
async fn b10_two_souls_accept_the_sides_of_a_turn_game_and_each_makes_only_its_own_move() {
    let d = scratch("b10");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, &socket);
    let activities = served.line("activities: ", 180);
    println!("{activities}");
    assert!(activities.contains(GAME), "the game is an activity kind");
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let board = im.nodes["turn-board"];
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut a = Soul::connect(&url, souls[0], lineage, &tokens[0]).await;
    let mut b = Soul::connect(&url, souls[1], lineage, &tokens[1]).await;
    let (body_a, body_b) = (body_of(&dir, a.id), body_of(&dir, b.id));

    // Nobody holds a side: no move is anyone's, and no link is on the board.
    assert_eq!(
        a.form("take_first", board).await,
        Err("not_linked".to_owned()),
        "before any role, the first side's move is refused"
    );
    assert!(role_links(&dir, board).0.is_empty());

    // Soul 1 offers the game at the board as the first side; Soul 2 accepts, as the second.
    let offered = a
        .act(
            "activity:offer",
            board,
            BTreeMap::from([
                (1, game_kind(&dir)),
                (2, Value::Text(Name::new(FIRST).unwrap())),
                (3, Value::Array(vec![body_b.to_value()])),
            ]),
        )
        .await
        .expect("the game offered at the board");
    let game = game_made(&dir, &offered);
    b.act("activity:accept", game, BTreeMap::new())
        .await
        .expect("Soul 2 accepts the second side");
    // The last parts reach the log in the tick after the answer.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (links, _) = role_links(&dir, board);
    println!("role links on the board: {links:?}");
    let sides: Vec<(&str, Id)> = links.iter().map(|(t, e, ..)| (t.as_str(), *e)).collect();
    assert_eq!(sides, vec![(FIRST, body_a), (SECOND, body_b)], "each holds its own side's link");
    assert_eq!(links[0].2, Actor::Soul(a.id), "the offer's, acted by Soul 1");
    assert_eq!(links[1].2, Actor::Soul(b.id), "the accept's, acted by Soul 2");
    assert!(
        links.iter().all(|l| matches!(l.3, Cause::Intent(_))),
        "each caused by its Soul's intent"
    );

    // Each makes only its own side's move; the other side's is refused by name.
    assert_eq!(
        b.form("take_first", board).await,
        Err("not_linked".to_owned()),
        "Soul 2 is not the first side"
    );
    assert_eq!(
        a.form("concede", board).await,
        Err("not-permitted".to_owned()),
        "only the second side may concede"
    );
    a.form("take_first", board)
        .await
        .expect("Soul 1 takes, as the first side");
    assert_eq!(
        a.form("take_second", board).await,
        Err("not_linked".to_owned()),
        "Soul 1 is not the second side"
    );
    b.form("take_second", board)
        .await
        .expect("Soul 2 takes, as the second side");
    b.form("concede", board)
        .await
        .expect("the second side concedes");

    // Soul 2 leaves: its link goes, and the first side's move lacks its other side.
    b.act("activity:leave", game, BTreeMap::new())
        .await
        .expect("a leave is always accepted");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (links, gone) = role_links(&dir, board);
    assert_eq!(gone, 1, "the leaver's link is taken down");
    assert_eq!(links.len(), 1);
    assert_eq!((links[0].0.as_str(), links[0].1), (FIRST, body_a));
    assert_eq!(
        a.form("take_first", board).await,
        Err("not_linked".to_owned()),
        "the second side is missing"
    );
    // Soul 1 leaves: the game ends, and no role link is left.
    a.act("activity:leave", game, BTreeMap::new())
        .await
        .expect("a leave is always accepted");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (links, gone) = role_links(&dir, board);
    drop(served);
    assert!(links.is_empty(), "no role link outlives the game: {links:?}");
    assert_eq!(gone, 2);
    let _ = std::fs::remove_dir_all(&d);
    println!(
        "B10: offered at the board as first and accepted as second through the gateway; each Soul held its own side's \
         link (caused by its own intent), made only its own move (the other's refused not_linked / not-permitted), \
         and each leave took its link down"
    );
}
