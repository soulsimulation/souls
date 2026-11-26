//! Engine v2 G1b (#3362): a creator's edits over the gateway. A real world (`worldd::answers`, I3's toggles world with
//! a creator and its pinned kinds) behind an in-process gateway on a local socket, as `worldd gateway-link --creator`
//! runs it. A socket signed in with the creator's token places a thing in a room, moves it and removes it, one answer
//! each, the place's receipt carrying the id minted for its name; an edit naming the removed thing is refused with the
//! failing operation. Edits from a Soul's socket and another creator's are refused `edit.not-the-creator`. The test
//! counts every answer.

use std::collections::BTreeMap;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, resume, socket, world_link};
use replica::edit::wire::{VERB, parameters};
use replica::edit::{self, Op, Ref, Spot};
use replica::effects::{Actor, read_id};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL};
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

#[tokio::test(flavor = "multi_thread")]
async fn g1b_a_creators_socket_places_moves_and_removes_and_others_are_refused() {
    // The world: one room, nothing in it; the creator and the kinds its header pins.
    let built = toggles::World::build(1, 0, 0);
    let tree = built.replica.tree();
    let room = tree
        .children(tree.root())
        .and_then(|c| c.first())
        .and_then(|h| tree.node(*h))
        .map(|n| n.id())
        .expect("a room");
    let kinds = toggles::kinds();
    let item = kinds
        .keys()
        .find(|k| k.starts_with("souls:item@"))
        .map(|k| Name::new(k).unwrap())
        .expect("the item kind");
    let creator = actor(0xc0, Actor::Creator);
    let Actor::Creator(creator_id) = creator else {
        unreachable!()
    };
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.measures = false;
    cfg.tick = Duration::from_millis(10);
    cfg.edits = Some(edit::World {
        creator: creator_id,
        kinds,
    });
    let world = answers::start(
        built.replica,
        toggles::rules(),
        sim::log::Mem::default(),
        cfg,
    )
    .unwrap();

    // Its end of the gateway's local socket, as `worldd gateway-link` serves it.
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gw-g1b-edits.sock");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let d = door.clone();
            std::thread::spawn(move || answers::serve(d, stream));
        }
    });

    // The gateway, with a token for the creator, a Soul and another creator.
    let soul = actor(0xdd, Actor::Soul);
    let other = actor(0xc1, Actor::Creator);
    let mut tokens = Tokens::default();
    let mut issue = |a: Actor| {
        let t = Token::issue(Grant::Actor(a)).unwrap();
        tokens.add(Grant::Actor(a), t.hash());
        t
    };
    let (ct, st, ot) = (issue(creator), issue(soul), issue(other));
    let log: Log = std::sync::Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    tokio::spawn(world_link::run(gw.clone(), path));
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", tcp.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let (mut receipts, mut refusals) = (0, 0);
    let mut count = |g: &Got| {
        if g.kind == 1 {
            receipts += 1;
        } else {
            refusals += 1;
        }
    };

    // The creator places a thing (name 1) in the room, moves it 2 m along, and removes it.
    let mut c = connect(&url, &ct).await;
    let place = Op::Place {
        name: 1,
        kind: item.clone(),
        parent: Ref::Node(room),
        at: spot(1_000_000),
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    };
    let placed = send(
        &mut c,
        edit_intent(creator, 1, 0, std::slice::from_ref(&place)),
    )
    .await;
    count(&placed);
    assert_eq!((placed.kind, placed.op), (1, None), "{placed:?}");
    let thing = *placed
        .names
        .get(&1)
        .expect("the receipt maps name 1 to an id");
    assert_eq!(thing.scope(), LINEAGE, "minted by the world's writer");
    let moved = Op::Move {
        node: Ref::Node(thing),
        at: spot(3_000_000),
    };
    let m = send(
        &mut c,
        edit_intent(creator, 2, placed.version, std::slice::from_ref(&moved)),
    )
    .await;
    count(&m);
    assert_eq!(m.kind, 1, "{m:?}");
    assert!(m.names.is_empty());
    let removed = Op::Remove {
        node: Ref::Node(thing),
    };
    let r = send(&mut c, edit_intent(creator, 3, m.version, &[removed])).await;
    count(&r);
    assert_eq!(r.kind, 1, "{r:?}");
    // Moving the removed thing: refused whole, naming the operation that failed.
    let gone = send(&mut c, edit_intent(creator, 4, r.version, &[place, moved])).await;
    count(&gone);
    assert_eq!(
        (gone.kind, gone.reason.as_str(), gone.op),
        (2, "edit.node-missing", Some(1))
    );
    assert_eq!(gone.version, r.version, "a refused edit changes nothing");

    // A Soul and another creator: refused, by name.
    for (who, token) in [(soul, &st), (other, &ot)] {
        let mut s = connect(&url, token).await;
        let place = Op::Place {
            name: 1,
            kind: item.clone(),
            parent: Ref::Node(room),
            at: spot(0),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        let no = send(&mut s, edit_intent(who, 1, 0, &[place])).await;
        count(&no);
        assert_eq!(
            (no.kind, no.reason.as_str()),
            (2, "edit.not-the-creator"),
            "{who:?}"
        );
    }
    println!("receipts {receipts}, refusals {refusals}");
    assert_eq!((receipts, refusals), (3, 3));
    world.stop();
}

/// An answer's sequence: the intent it answers.
fn answered_sequence(v: &Value) -> u64 {
    let Value::Map(f) = v else { panic!("a frame") };
    let Some(Value::Map(a)) = f.get(&2) else {
        panic!("an answer")
    };
    match a.get(&2) {
        Some(Value::Uint(s)) => *s,
        _ => panic!("a sequence"),
    }
}

/// Nothing comes on `ws` for a while: no answer of another socket's intent.
async fn quiet(ws: &mut Ws, who: &str) {
    if let Ok(Some(Ok(m))) = tokio::time::timeout(Duration::from_millis(300), ws.next()).await {
        panic!("{who} was sent a frame of another socket's: {m:?}");
    }
}

/// Sends one edit on `from` and reads its answer there; the other socket is sent nothing.
async fn edit_on(from: &mut Ws, other: &mut Ws, names: (&str, &str), bytes: Vec<u8>) -> Got {
    put(from, bytes).await;
    let v = next(from).await;
    let got = read_answer(&v);
    println!("{} {}: {got:?}", names.0, answered_sequence(&v));
    quiet(other, names.1).await;
    got
}

#[tokio::test(flavor = "multi_thread")]
async fn a_creators_page_and_agent_edit_in_turn_and_each_gets_every_answer() {
    // #5006: the creator's page (signed in with a token from the session exchange) and the creator's agent (its own
    // paired token) hold the creator's grant at once, on one real world.
    let built = toggles::World::build(1, 0, 0);
    let tree = built.replica.tree();
    let room = tree
        .children(tree.root())
        .and_then(|c| c.first())
        .and_then(|h| tree.node(*h))
        .map(|n| n.id())
        .expect("a room");
    let kinds = toggles::kinds();
    let item = kinds
        .keys()
        .find(|k| k.starts_with("souls:item@"))
        .map(|k| Name::new(k).unwrap())
        .expect("the item kind");
    let creator = actor(0xc0, Actor::Creator);
    let Actor::Creator(creator_id) = creator else {
        unreachable!()
    };
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.measures = false;
    cfg.tick = Duration::from_millis(10);
    cfg.edits = Some(edit::World {
        creator: creator_id,
        kinds,
    });
    let world = answers::start(
        built.replica,
        toggles::rules(),
        sim::log::Mem::default(),
        cfg,
    )
    .unwrap();
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gw-5006-together.sock");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let d = door.clone();
            std::thread::spawn(move || answers::serve(d, stream));
        }
    });
    let soul = actor(0xdd, Actor::Soul);
    let mut tokens = Tokens::default();
    let mut issue = |a: Actor| {
        let t = Token::issue(Grant::Actor(a)).unwrap();
        tokens.add(Grant::Actor(a), t.hash());
        t
    };
    let (page_token, agent_token, soul_token) = (issue(creator), issue(creator), issue(soul));
    let log: Log = std::sync::Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    tokio::spawn(world_link::run(gw.clone(), path));
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", tcp.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let place = |name: u64, x: i64| Op::Place {
        name,
        kind: item.clone(),
        parent: Ref::Node(room),
        at: spot(x),
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    };

    // The agent is connected; the page signs in beside it.
    let mut agent = connect(&url, &agent_token).await;
    let mut page = connect(&url, &page_token).await;
    let (mut sequence, mut version, mut answered) = (0, 0, 0);
    let mut placed = Vec::new();
    // In turn, page then agent, three times each: one numbering for the creator, each answer on its sender.
    for turn in 0..6 {
        sequence += 1;
        let op = place(1, turn * 1_000_000);
        let bytes = edit_intent(creator, sequence, version, &[op]);
        let got = if turn % 2 == 0 {
            edit_on(&mut page, &mut agent, ("page", "agent"), bytes).await
        } else {
            edit_on(&mut agent, &mut page, ("agent", "page"), bytes).await
        };
        assert_eq!(got.kind, 1, "{got:?}");
        answered += 1;
        version = got.version;
        placed.push(*got.names.get(&1).expect("the new thing's id"));
    }
    // The agent moves what the page placed, and the page removes what the agent placed: one world.
    sequence += 1;
    let moved = Op::Move {
        node: Ref::Node(placed[0]),
        at: spot(9_000_000),
    };
    let bytes = edit_intent(creator, sequence, version, &[moved]);
    let got = edit_on(&mut agent, &mut page, ("agent", "page"), bytes).await;
    assert_eq!(got.kind, 1, "{got:?}");
    (answered, version) = (answered + 1, got.version);
    sequence += 1;
    let removed = Op::Remove {
        node: Ref::Node(placed[1]),
    };
    let bytes = edit_intent(creator, sequence, version, &[removed]);
    let got = edit_on(&mut page, &mut agent, ("page", "agent"), bytes).await;
    assert_eq!(got.kind, 1, "{got:?}");
    (answered, version) = (answered + 1, got.version);

    // Both at once: each is answered on its own socket, and only there. The world takes them in the order they reach
    // it, one numbering for the creator: the page's lower sequence is `intent.stale-seq` only if the agent's reached
    // the world and was answered first.
    let (p, a) = (sequence + 1, sequence + 2);
    sequence += 2;
    put(
        &mut page,
        edit_intent(creator, p, version, &[place(1, 20_000_000)]),
    )
    .await;
    put(
        &mut agent,
        edit_intent(creator, a, version, &[place(1, 21_000_000)]),
    )
    .await;
    let (on_page, on_agent) = (next(&mut page).await, next(&mut agent).await);
    assert_eq!(
        (answered_sequence(&on_page), answered_sequence(&on_agent)),
        (p, a)
    );
    let (got_page, got_agent) = (read_answer(&on_page), read_answer(&on_agent));
    assert!(
        got_page.kind == 1 || got_page.reason == "intent.stale-seq",
        "{got_page:?}"
    );
    assert_eq!(got_agent.kind, 1, "{got_agent:?}");
    version = version.max(got_page.version).max(got_agent.version);
    answered += 2;
    quiet(&mut page, "page").await;
    quiet(&mut agent, "agent").await;

    // The page goes: the agent still edits and is answered.
    page.close(None).await.unwrap();
    drop(page);
    tokio::time::sleep(Duration::from_millis(100)).await;
    sequence += 1;
    put(
        &mut agent,
        edit_intent(creator, sequence, version, &[place(1, 30_000_000)]),
    )
    .await;
    let got = read_answer(&next(&mut agent).await);
    assert_eq!(got.kind, 1, "{got:?}");
    (answered, version) = (answered + 1, got.version);
    // The page comes back, and the agent goes: the page edits and is answered.
    let mut page = connect(&url, &page_token).await;
    sequence += 1;
    let bytes = edit_intent(creator, sequence, version, &[place(1, 31_000_000)]);
    let got = edit_on(&mut page, &mut agent, ("page", "agent"), bytes).await;
    assert_eq!(got.kind, 1, "{got:?}");
    (answered, version) = (answered + 1, got.version);
    agent.close(None).await.unwrap();
    drop(agent);
    tokio::time::sleep(Duration::from_millis(100)).await;
    sequence += 1;
    put(
        &mut page,
        edit_intent(creator, sequence, version, &[place(1, 32_000_000)]),
    )
    .await;
    let got = read_answer(&next(&mut page).await);
    assert_eq!(got.kind, 1, "{got:?}");
    answered += 1;
    println!("{answered} edits from two sockets, each answered once on its sender");
    assert_eq!(answered, sequence);

    // A Soul's grant keeps one holder: its second sign-in lets the first go.
    let mut first = connect(&url, &soul_token).await;
    let _second = connect(&url, &soul_token).await;
    let closed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match first.next().await {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                _ => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "a Soul's first socket is let go");
    world.stop();
}
