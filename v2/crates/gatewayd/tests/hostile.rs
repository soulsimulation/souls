//! Engine v2 O8 (#2805): a client nobody trusts, through a real socket to an in-process gateway and a stand-in world
//! that takes intents and never answers. A message over the limit is closed by name; a flood past the agent's kept
//! budget is refused by name and never kept, and another agent is not held by it; so is a flood of sync requests past
//! the agent's sync budget, never sent to the world. The bench table is
//! `v2/tools/bench/hostile`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, socket, world_link};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL};
use tokio::io::AsyncReadExt;
use tokio::net::{TcpStream, UnixListener};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 2] = [0x12, 0x20];
const LINEAGE: Scope = Scope([9; 16]);

fn soul(n: u64) -> Grant {
    Grant::Actor(Actor::Soul(Id::new(Scope([2; 16]), n).unwrap()))
}

fn intent(grant: Grant, sequence: u64) -> Vec<u8> {
    let Grant::Actor(actor) = grant;
    let i = Intent {
        actor,
        verb: Name::new("eden:wave").unwrap(),
        target: None,
        parameters: BTreeMap::new(),
        sequence,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: i64::MAX / 2,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// A world that takes every frame and answers none.
async fn silent_world(listener: UnixListener) {
    while let Ok((mut s, _)) = listener.accept().await {
        tokio::spawn(async move {
            let mut buf = vec![0u8; 1 << 16];
            while matches!(s.read(&mut buf).await, Ok(n) if n > 0) {}
        });
    }
}

async fn start(name: &str, tokens: Tokens) -> (Arc<Gateway>, String) {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("gw-o8-{name}.sock"));
    let _ = std::fs::remove_file(&path);
    tokio::spawn(silent_world(UnixListener::bind(&path).unwrap()));
    let log: Log = Arc::new(|_: &str| {});
    let gw = Gateway::new(tokens, BUILD.to_vec(), log);
    tokio::spawn(world_link::run(gw.clone(), path));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", listener.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(listener, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    (gw, url)
}

fn hello() -> Message {
    let h = Hello {
        protocol: PROTOCOL,
        build: BUILD.to_vec(),
        refused: None,
        other: None,
    };
    Message::Binary(h.to_bytes().unwrap().into())
}

fn sign_in(token: &str) -> Message {
    let m = BTreeMap::from([(1, Value::Text(Name::new(token).unwrap()))]);
    Message::Binary(encode(&Value::Map(m)).unwrap().into())
}

/// Connects, exchanges first frames and signs in; the socket after the sign-in's outcome.
async fn connect(url: &str, token: &str) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws.send(hello()).await.unwrap();
    ws.send(sign_in(token)).await.unwrap();
    for _ in 0..2 {
        assert!(matches!(ws.next().await, Some(Ok(Message::Binary(_)))));
    }
    ws
}

/// The close a socket is given, as `(code, reason)`, reading past any other frame.
async fn closed(ws: &mut Ws) -> Option<(u16, String)> {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .ok()??
        {
            Ok(Message::Close(Some(c))) => {
                return Some((u16::from(c.code), c.reason.as_str().to_owned()));
            }
            Ok(Message::Close(None)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

fn issue(tokens: &mut Tokens, grant: Grant) -> Token {
    let t = Token::issue(grant).unwrap();
    tokens.add(grant, t.hash());
    t
}

#[tokio::test]
async fn o8_a_message_over_the_limit_is_closed_by_name() {
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(1));
    let (_gw, url) = start("big", tokens).await;
    let big = vec![0xA5u8; 64 << 10];
    // Signed in: its socket is closed 1009 `message.too-big`.
    let mut ws = connect(&url, t.reveal()).await;
    let _ = ws.send(Message::Binary(big.clone().into())).await;
    assert_eq!(
        closed(&mut ws).await,
        Some((socket::TOO_BIG, socket::MESSAGE_TOO_BIG.to_owned()))
    );
    // Before its first frame, too.
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let _ = ws.send(Message::Binary(big.into())).await;
    assert_eq!(
        closed(&mut ws).await,
        Some((socket::TOO_BIG, socket::MESSAGE_TOO_BIG.to_owned()))
    );
}

#[tokio::test]
async fn o8_a_flood_past_the_kept_budget_is_refused_by_name_and_never_kept() {
    let mut tokens = Tokens::default();
    let (flood, honest) = (issue(&mut tokens, soul(1)), issue(&mut tokens, soul(2)));
    let (gw, url) = start("flood", tokens).await;
    let mut f = connect(&url, flood.reveal()).await;
    // Sequences of one length (CBOR's three-byte form), so each intent is charged the same.
    let each = intent(soul(1), 1000).len() + world_link::KEPT_EACH;
    let fits = world_link::KEPT_MOST / each;
    let sent = fits + 200;
    for seq in 1000..1000 + sent as u64 {
        f.send(Message::Binary(intent(soul(1), seq).into()))
            .await
            .unwrap();
    }
    // Every intent past the budget is answered at once, by name, with plain words; none of them is kept.
    let mut slowed = 0;
    while slowed < sent - fits {
        let Ok(Some(Ok(Message::Binary(b)))) =
            tokio::time::timeout(Duration::from_secs(5), f.next()).await
        else {
            panic!("{slowed} of {} refused", sent - fits);
        };
        let Value::Map(m) = decode(&b).unwrap().value else {
            continue;
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            continue;
        };
        assert_eq!(
            a.get(&4),
            Some(&Value::Text(Name::new(world_link::SLOW_DOWN).unwrap()))
        );
        assert!(matches!(a.get(&8), Some(Value::Bytes(w)) if w.starts_with(b"Too many")));
        slowed += 1;
    }
    assert_eq!(gw.link.unanswered(), fits);
    // Another agent's intent is taken while the flooder is held.
    let mut h = connect(&url, honest.reveal()).await;
    h.send(Message::Binary(intent(soul(2), 1).into()))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(300), h.next())
            .await
            .is_err(),
        "the honest agent is told nothing: its intent is kept for the world"
    );
    let by = tokio::time::Instant::now() + Duration::from_secs(5);
    while gw.link.unanswered() < fits + 1 && tokio::time::Instant::now() < by {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(gw.link.unanswered(), fits + 1);
}

/// A sync request (R5b), `{20: n, 21: []}`.
fn sync_ask(n: u64) -> Vec<u8> {
    encode(&Value::Map(
        [(20, Value::Uint(n)), (21, Value::Array(Vec::new()))].into(),
    ))
    .unwrap()
}

/// A flood of sync requests (the bench's `sync` arm) against a world that answers none: past the agent's budget each is
/// refused at once, under its own number, `agent.slow-down`, and never sent; another agent's request still goes.
#[tokio::test]
async fn o8_a_sync_flood_past_its_budget_is_refused_by_name_and_never_sent() {
    let mut tokens = Tokens::default();
    let (flood, honest) = (issue(&mut tokens, soul(1)), issue(&mut tokens, soul(2)));
    let (gw, url) = start("sync", tokens).await;
    let mut f = connect(&url, flood.reveal()).await;
    let sent = 2000u64;
    for n in 0..sent {
        f.send(Message::Binary(sync_ask(n).into())).await.unwrap();
    }
    let mut slowed = 0;
    while slowed as usize + gw.link.syncs_waiting() < sent as usize {
        let Ok(Some(Ok(Message::Binary(b)))) =
            tokio::time::timeout(Duration::from_secs(5), f.next()).await
        else {
            panic!("{slowed} refused, {} waiting, of {sent}", gw.link.syncs_waiting());
        };
        let Value::Map(m) = decode(&b).unwrap().value else {
            panic!("not a map");
        };
        assert!(matches!(m.get(&20), Some(Value::Uint(_))), "under its own number");
        assert_eq!(
            m.get(&24),
            Some(&Value::Text(Name::new(world_link::SLOW_DOWN).unwrap()))
        );
        slowed += 1;
    }
    let waiting = gw.link.syncs_waiting();
    assert!(slowed > 0 && waiting < 300, "bounded: {waiting} waiting, {slowed} refused");
    assert_eq!(gw.link.syncs_slowed(), slowed);
    // Another agent's request goes to the world: it is told nothing here.
    let mut h = connect(&url, honest.reveal()).await;
    h.send(Message::Binary(sync_ask(1).into())).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(300), h.next())
            .await
            .is_err(),
        "the honest agent's request is sent to the world"
    );
    assert_eq!(gw.link.syncs_waiting(), waiting + 1);
}
