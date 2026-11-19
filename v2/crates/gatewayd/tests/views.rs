//! View subscriptions over the gateway (#3292): a signed-in socket subscribes and receives R4's items from the world's
//! view tier (`worldd::views::served`), fed committed parts. Each `aN_` test is one acceptance box; A1's world side
//! (the answers thread feeding the tier) is `worldd`'s `views::served` test.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens, ViewKey};
use gatewayd::views::{ITEM, SUBSCRIBE};
use gatewayd::{Gateway, Log, socket, views};
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Rest};
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::intents::{Hello, PROTOCOL};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::world_model::Audience;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::views::served::{self, Feed};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0xab, 0xcd];
const BODY: &str =
    "souls:body@1220ee1ad75a34f067112ef6d2a095fe5bd3e121a75611a1a95ba85198efcb131cb2";

fn soul_id(n: u64) -> Id {
    Id::new(Scope([1; 16]), n).unwrap()
}

fn soul(n: u64) -> Grant {
    Grant::Actor(Actor::Soul(soul_id(n)))
}

fn node(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

fn pose(room: Id, x: i64) -> Pose {
    Pose {
        frame: Frame {
            node: room,
            slot: None,
        },
        position: Vec3::new(x, 0, 0),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: room,
            height: 0,
        },
    }
}

/// A log being written: entries, and records of them as committed ticks.
struct W {
    seq: u64,
    at: i64,
}

impl W {
    fn entry(&mut self, n: Id, audience: Audience, change: Change) -> Effect {
        self.seq += 1;
        Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.at,
                cause: Cause::World,
                actor: Actor::World,
                audience,
                node: n,
            },
            body: Body::Changes(vec![ChangeRec {
                change,
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        }
    }

    fn body(&mut self, b: Id, room: Id, x: i64) -> Effect {
        let c = Change::Create {
            node: b,
            kind: Name::new(BODY).unwrap(),
            pose: pose(room, x),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        self.entry(room, Audience::Everyone, c)
    }

    fn walk(&mut self, b: Id, room: Id, x: i64) -> Effect {
        let h = HandOff {
            node: b,
            at: self.at,
            from: Owner::Mover,
            to: Owner::Mover,
            pose: pose(room, x),
            linear: Vec3::new(1_000_000, 0, 0),
            angular: Vec3::ZERO,
        };
        self.entry(b, Audience::Everyone, Change::Motion(h))
    }

    fn set(&mut self, b: Id, audience: Audience, field: u64) -> Effect {
        let c = Change::Set {
            node: b,
            field,
            to: Value::Uint(field),
            by: None,
        };
        self.entry(b, audience, c)
    }

    /// One tick's record, as the answers thread hands it once on the disk; the clock moves on 50 ms.
    fn record(&mut self, effects: &[Effect]) -> Vec<u8> {
        let v = Value::Map(
            [
                (
                    1,
                    Value::Bytes(Hash::of(Purpose::Fixture, b"views").to_bytes()),
                ),
                (
                    2,
                    Value::Array(effects.iter().map(Effect::to_value).collect()),
                ),
            ]
            .into(),
        );
        self.at += 50_000;
        encode(&v).unwrap()
    }
}

struct Running {
    gw: Arc<Gateway>,
    url: String,
    feed: Feed,
    tokens: Vec<Token>,
}

/// A world's view tier on a local socket, a gateway linked to it, and a token for souls 1 to 3.
async fn start(name: &str, receipts: Receipts) -> Running {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("v-{name}.views"));
    let feed = served::start().unwrap();
    served::listen(feed.clone(), &path).unwrap();
    let mut tokens = Tokens::default();
    let issued: Vec<Token> = (1..=3)
        .map(|n| {
            let t = Token::issue(soul(n)).unwrap();
            tokens.add(soul(n), t.hash());
            t
        })
        .collect();
    let log: Log = Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, receipts);
    tokio::spawn(views::run(gw.clone(), path));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", listener.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(listener, socket::router(gw.clone())).into_future());
    Running {
        gw,
        url,
        feed,
        tokens: issued,
    }
}

async fn next(ws: &mut Ws, wait: Duration) -> Option<Value> {
    loop {
        match tokio::time::timeout(wait, ws.next()).await.ok()?? {
            Ok(Message::Binary(b)) => return Some(decode(&b).unwrap().value),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

async fn put(ws: &mut Ws, bytes: Vec<u8>) {
    ws.send(Message::Binary(bytes.into())).await.unwrap();
}

/// Connects and signs in by message as `token`.
async fn connect(url: &str, token: &Token) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let hello = Hello {
        protocol: PROTOCOL,
        build: BUILD.to_vec(),
        refused: None,
        other: None,
    };
    put(&mut ws, hello.to_bytes().unwrap()).await;
    next(&mut ws, Duration::from_secs(5)).await.unwrap();
    let sign_in = BTreeMap::from([(1, Value::Text(Name::new(token.reveal()).unwrap()))]);
    put(&mut ws, encode(&Value::Map(sign_in)).unwrap()).await;
    let started = next(&mut ws, Duration::from_secs(5)).await.unwrap();
    assert!(
        matches!(&started, Value::Map(m) if m.contains_key(&4)),
        "{started:?}"
    );
    ws
}

/// The client's subscribe frame: follow `body` at `level`, `budget` bytes a world second.
fn subscribe(body: Id, level: u64, budget: u64) -> Vec<u8> {
    let request = Value::Map(
        [
            (
                1,
                Value::Array(vec![Value::Map([(2, body.to_value())].into())]),
            ),
            (2, Value::Uint(level)),
            (3, Value::Uint(budget)),
        ]
        .into(),
    );
    encode(&Value::Map([(SUBSCRIBE, request)].into())).unwrap()
}

/// An item's bytes, if the frame is one.
fn item(v: &Value) -> Option<Vec<u8>> {
    match v {
        Value::Map(m) => match m.get(&ITEM) {
            Some(Value::Bytes(b)) => Some(b.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Feeds a tick of `me` walking until the socket's first item arrives (its subscription reached the tier).
async fn first_item(ws: &mut Ws, w: &mut W, feed: &Feed, me: Id, hall: Id) -> Vec<u8> {
    for _ in 0..250 {
        let e = w.walk(me, hall, 0);
        feed.record(w.record(&[e]));
        if let Some(v) = next(ws, Duration::from_millis(20)).await {
            return item(&v).expect("an item");
        }
    }
    panic!("no item arrived")
}

/// Every item that arrives within `wait` of the last.
async fn items(ws: &mut Ws, wait: Duration) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(v) = next(ws, wait).await {
        out.push(item(&v).expect("an item"));
    }
    out
}

fn has(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// A2 and A3: the subscriber's items reach its socket alone, hold its own audience's entry and the public ones, and
/// never another owner's private entry; nothing is kept for a resume or written to a file.
#[tokio::test]
async fn a2_a3_items_to_the_socket_alone_and_never_another_owners_private_entry() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("views-receipts");
    let _ = std::fs::remove_dir_all(&dir);
    let r = start("a3", Receipts::to_dir(dir.clone())).await;
    let (hall, me, other) = (node(1), node(10), node(11));
    let mut w = W { seq: 0, at: 0 };
    let e = [w.body(me, hall, 0), w.body(other, hall, 500_000)];
    r.feed.record(w.record(&e));

    let mut a = connect(&r.url, &r.tokens[0]).await;
    let mut b = connect(&r.url, &r.tokens[1]).await;
    put(&mut a, subscribe(me, 1, 100_000)).await;
    let grant = first_item(&mut a, &mut w, &r.feed, me, hall).await;
    let kind = |i: &[u8]| match decode(i).unwrap().value {
        Value::Map(m) => m.get(&1).cloned(),
        _ => None,
    };
    assert_eq!(
        kind(&grant),
        Some(Value::Uint(5)),
        "a grant item opens the stream"
    );

    // One tick: the other body's field set three times, for everyone, for soul 1 (the subscriber), for soul 2.
    let public = w.set(other, Audience::Everyone, 1);
    let mine = w.set(other, Audience::Of(soul_id(1)), 2);
    let theirs = w.set(other, Audience::Of(soul_id(2)), 3);
    r.feed
        .record(w.record(&[public.clone(), mine.clone(), theirs.clone()]));
    for _ in 0..3 {
        let e = w.walk(other, hall, 600_000);
        r.feed.record(w.record(&[e]));
    }
    let got = items(&mut a, Duration::from_millis(300)).await;
    let bytes = |e: &Effect| encode(&e.to_value()).unwrap();
    assert!(
        got.iter().any(|i| has(i, &bytes(&public))),
        "the public entry"
    );
    assert!(
        got.iter().any(|i| has(i, &bytes(&mine))),
        "its own audience's entry"
    );
    assert!(
        !got.iter().any(|i| has(i, &bytes(&theirs))),
        "another owner's private entry never reaches the socket"
    );
    assert!(
        next(&mut b, Duration::from_millis(200)).await.is_none(),
        "a socket that did not subscribe is sent no item"
    );
    drop(a);
    for _ in 0..100 {
        if r.gw.views.held() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        r.gw.views.held(),
        0,
        "the subscription ends with its socket"
    );
    let mut again = connect(&r.url, &r.tokens[0]).await;
    let e = w.walk(other, hall, 700_000);
    r.feed.record(w.record(&[e]));
    assert!(
        next(&mut again, Duration::from_millis(200)).await.is_none(),
        "no item is kept for a resume"
    );
    let files = std::fs::read_dir(&dir).map_or(0, |d| d.count());
    assert_eq!(files, 0, "no item is written to a file");
    println!(
        "A3: {} items to the subscriber, its own and the public entry among them, soul 2's private entry in none",
        got.len()
    );
}

/// A4: a level the server lowers arrives as R4's grant item.
#[tokio::test]
async fn a4_a_lowered_level_arrives_as_the_grant_item() {
    let r = start("a4", Receipts::off()).await;
    let (hall, me) = (node(1), node(10));
    let mut w = W { seq: 0, at: 0 };
    let mut e = vec![w.body(me, hall, 0)];
    e.extend((0..8).map(|i| w.body(node(20 + i), hall, 200_000 * (i as i64 + 1))));
    r.feed.record(w.record(&e));

    let mut c = connect(&r.url, &r.tokens[2]).await;
    put(&mut c, subscribe(me, 1, 600)).await;
    let first = first_item(&mut c, &mut w, &r.feed, me, hall).await;
    let mut got = vec![first];
    // Three world seconds of every near body walking each tick: far more than 600 bytes a second at full.
    for t in 0..60 {
        let e: Vec<Effect> = (0..8)
            .map(|i| w.walk(node(20 + i), hall, 200_000 * (i as i64 + 1) + t * 1_000))
            .collect();
        r.feed.record(w.record(&e));
    }
    got.extend(items(&mut c, Duration::from_millis(300)).await);
    let grants: Vec<BTreeMap<u64, Value>> = got
        .iter()
        .filter_map(|i| match decode(i).unwrap().value {
            Value::Map(m) if m.get(&1) == Some(&Value::Uint(5)) => match m.get(&2) {
                Some(Value::Map(g)) => Some(g.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect();
    let lowered = grants
        .iter()
        .find(|g| matches!(g.get(&3), Some(Value::Text(n)) if n.as_str() == "souls:over-budget"));
    let lowered = lowered.unwrap_or_else(|| panic!("a lowered grant among {grants:?}"));
    assert_eq!(
        lowered.get(&2),
        Some(&Value::Uint(1)),
        "the level asked for: full"
    );
    assert_ne!(
        lowered.get(&1),
        Some(&Value::Uint(1)),
        "a lower level granted"
    );
    println!("A4: grants in the stream {grants:?}");
}

/// V13 (#2745) A4: the socket that carries an owner's private view is answered `cache-control: no-store`, so no cache
/// keeps a response of it; its items are not kept or written (the A2/A3 test above).
#[tokio::test]
async fn v13_a4_the_view_socket_is_no_store() {
    let r = start("v13-a4", Receipts::off()).await;
    let (_ws, res) = tokio_tungstenite::connect_async(&r.url).await.unwrap();
    assert_eq!(
        res.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
}

/// A view token as the directory mints it (`directoryd::accounts::view`): its grants, its expiry, the key's MAC.
fn view_token(key: &ViewKey, grants: &[Grant], expires: u64) -> String {
    let grants: Vec<String> = grants.iter().map(|g| g.to_text()).collect();
    let body = format!("view.{expires}.{}", grants.join("/"));
    format!("{body}.{}", to_hex(&key.mac(body.as_bytes())))
}

/// Connects and signs in by message with `text`: the socket and the sign-in's outcome's name.
async fn sign_in_as(url: &str, text: &str) -> (Ws, String) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let hello = Hello {
        protocol: PROTOCOL,
        build: BUILD.to_vec(),
        refused: None,
        other: None,
    };
    put(&mut ws, hello.to_bytes().unwrap()).await;
    next(&mut ws, Duration::from_secs(5)).await.unwrap();
    put(&mut ws, sign_in_frame(text)).await;
    let outcome = next(&mut ws, Duration::from_secs(5)).await.unwrap();
    (ws, outcome_name(&outcome).expect("an outcome"))
}

fn sign_in_frame(text: &str) -> Vec<u8> {
    encode(&Value::Map(
        [(1, Value::Text(Name::new(text).unwrap()))].into(),
    ))
    .unwrap()
}

fn outcome_name(v: &Value) -> Option<String> {
    match v {
        Value::Map(m) => match m.get(&4) {
            Some(Value::Text(n)) => Some(n.as_str().to_owned()),
            _ => None,
        },
        _ => None,
    }
}

const KEY: [u8; 32] = [0x5a; 32];

/// V13b (#3407) A1: a view token the directory signed watches its own Souls' views (their audiences, never another
/// owner's private entry) and cannot act; one under another key, or expired, is refused.
#[tokio::test]
async fn v13b_a1_a_view_token_watches_its_souls_and_never_acts() {
    let r = start("v13b-a1", Receipts::off()).await;
    let _ = r.gw.view_key.set(ViewKey::new(KEY));
    let (hall, me, other) = (node(1), node(10), node(11));
    let mut w = W { seq: 0, at: 0 };
    let e = [w.body(me, hall, 0), w.body(other, hall, 500_000)];
    r.feed.record(w.record(&e));
    let later = gatewayd::unix_now() + 60;

    let forged = view_token(&ViewKey::new([1; 32]), &[soul(1)], later);
    assert_eq!(sign_in_as(&r.url, &forged).await.1, "token.refused");
    let expired = view_token(&ViewKey::new(KEY), &[soul(1)], gatewayd::unix_now());
    assert_eq!(sign_in_as(&r.url, &expired).await.1, "token.refused");

    let (mut a, outcome) =
        sign_in_as(&r.url, &view_token(&ViewKey::new(KEY), &[soul(1)], later)).await;
    assert_eq!(outcome, socket::VIEW_STARTED);
    put(&mut a, subscribe(me, 1, 100_000)).await;
    first_item(&mut a, &mut w, &r.feed, me, hall).await;
    let mine = w.set(other, Audience::Of(soul_id(1)), 2);
    let theirs = w.set(other, Audience::Of(soul_id(2)), 3);
    r.feed.record(w.record(&[mine.clone(), theirs.clone()]));
    let got = items(&mut a, Duration::from_millis(300)).await;
    let bytes = |e: &Effect| encode(&e.to_value()).unwrap();
    assert!(
        got.iter().any(|i| has(i, &bytes(&mine))),
        "its Soul's audience"
    );
    assert!(
        !got.iter().any(|i| has(i, &bytes(&theirs))),
        "never another owner's"
    );
    // An intent's frame on a view socket is answered `view.only` and goes nowhere.
    put(
        &mut a,
        encode(&Value::Map([(1, Value::Uint(1))].into())).unwrap(),
    )
    .await;
    let answer = next(&mut a, Duration::from_secs(2)).await.unwrap();
    assert_eq!(outcome_name(&answer).as_deref(), Some(socket::VIEW_ONLY));
    println!(
        "V13b A1: {} items to the view socket, its Soul's private entry among them, another's in none",
        got.len()
    );
}

/// V13b (#3407) A3: a view socket whose token is renewed on it before it expires keeps receiving with no gap; one not
/// renewed is told `view.expired` and closed.
#[tokio::test]
async fn v13b_a3_a_renewed_view_carries_on_and_an_unrenewed_one_expires() {
    let r = start("v13b-a3", Receipts::off()).await;
    let _ = r.gw.view_key.set(ViewKey::new(KEY));
    let key = ViewKey::new(KEY);
    let (hall, me) = (node(1), node(10));
    let mut w = W { seq: 0, at: 0 };
    let e = [w.body(me, hall, 0)];
    r.feed.record(w.record(&e));
    // Expires within 1 to 2 s of now, so the renewal comes at 0.5 s.
    let soon = gatewayd::unix_now() + 2;
    let (mut a, _) = sign_in_as(&r.url, &view_token(&key, &[soul(1)], soon)).await;
    let (mut b, _) = sign_in_as(&r.url, &view_token(&key, &[soul(1)], soon)).await;
    put(&mut a, subscribe(me, 1, 100_000)).await;
    put(&mut b, subscribe(me, 1, 100_000)).await;
    first_item(&mut a, &mut w, &r.feed, me, hall).await;
    // The world walks the body every 50 ms from here on.
    let feed = r.feed.clone();
    tokio::spawn(async move {
        for x in 0..120 {
            let e = w.walk(me, hall, x * 1_000);
            feed.record(w.record(&[e]));
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
    let start = tokio::time::Instant::now();
    let mut renewed = false;
    let (mut gap, mut last, mut count) = (Duration::ZERO, start, 0);
    // Three seconds: at least a second past the first token's expiry.
    while start.elapsed() < Duration::from_secs(3) {
        if !renewed && start.elapsed() > Duration::from_millis(500) {
            put(
                &mut a,
                sign_in_frame(&view_token(&key, &[soul(1)], soon + 60)),
            )
            .await;
            renewed = true;
        }
        let v = next(&mut a, Duration::from_millis(500))
            .await
            .expect("the renewed socket stays open");
        if let Some(name) = outcome_name(&v) {
            assert_eq!(name, socket::VIEW_RENEWED);
            continue;
        }
        let now = tokio::time::Instant::now();
        gap = gap.max(now - last);
        (last, count) = (now, count + 1);
    }
    assert!(renewed && count > 20, "{count} items");
    assert!(
        gap < Duration::from_millis(300),
        "the longest gap was {gap:?}"
    );
    // The other socket was not renewed: told it expired, then closed.
    let mut told = false;
    while let Some(v) = next(&mut b, Duration::from_secs(3)).await {
        told |= outcome_name(&v).as_deref() == Some(socket::VIEW_EXPIRED);
    }
    assert!(told, "the unrenewed socket is told its view expired");
    println!(
        "V13b A3: {count} items across the old token's expiry, the longest gap {gap:?}; the unrenewed socket expired"
    );
}
