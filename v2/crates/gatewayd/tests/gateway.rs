//! Engine v2 I1 (#2683): the token tests (A3) and the resume from a cursor (A4), through a real socket to an
//! in-process gateway and a stand-in world on a local socket. The restart table (A1, A2, A5) is
//! `v2/tools/bench/gateway-restart`. The receipts file (`r1_`..`r4_`): the usage roll-up's source (O21, #3325).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, socket, world_link};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version, sha256};
use replica::intents::{Answer, Hello, Intent, PROTOCOL};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixListener};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0xab, 0xcd];
const LINEAGE: Scope = Scope([7; 16]);

fn soul(n: u64) -> Grant {
    Grant::Actor(Actor::Soul(Id::new(Scope([1; 16]), n).unwrap()))
}

fn version(sequence: u64) -> Version {
    Version {
        lineage: LINEAGE,
        zone: Id::new(LINEAGE, 0).unwrap(),
        epoch: 1,
        sequence,
    }
}

fn intent(grant: Grant, sequence: u64) -> Vec<u8> {
    intent_to(grant, sequence, "eden:wave")
}

/// An intent the stand-in world refuses.
const REFUSED: &str = "eden:refused";

fn intent_to(grant: Grant, sequence: u64, verb: &str) -> Vec<u8> {
    let Grant::Actor(actor) = grant;
    let i = Intent {
        actor,
        verb: Name::new(verb).unwrap(),
        target: None,
        parameters: BTreeMap::new(),
        sequence,
        basis: version(0).to_value(),
        expiry: 60_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// A stand-in world: answers every intent with a receipt, one version per answer; from sequence 100, a refusal. A
/// [`REFUSED`] intent it refuses at the version it is at, as `worldd` does (a refusal does not move the version).
/// `answered` counts its answers.
async fn world(listener: UnixListener, answered: Arc<AtomicUsize>) {
    let mut sequence = 0;
    while let Ok((mut s, _)) = listener.accept().await {
        loop {
            let mut len = [0u8; 4];
            if s.read_exact(&mut len).await.is_err() {
                break;
            }
            let mut bytes = vec![0u8; u32::from_be_bytes(len) as usize];
            if s.read_exact(&mut bytes).await.is_err() {
                break;
            }
            // The gateway's handover ask (`world_link::handover_ask`) comes first on each connection.
            let Ok(i) = Intent::read(&bytes) else {
                continue;
            };
            let answer = if i.verb.as_str() == REFUSED {
                Answer::Refused {
                    actor: i.actor,
                    sequence: i.sequence,
                    reason: Name::new("act.refused").unwrap(),
                    now: version(sequence).to_value(),
                    changed: Vec::new(),
                    op: None,
                    detail: None,
                }
            } else if i.sequence >= 100 {
                sequence += 1;
                Answer::Refused {
                    actor: i.actor,
                    sequence: i.sequence,
                    reason: Name::new("eden:out-of-reach").unwrap(),
                    now: version(sequence).to_value(),
                    changed: Vec::new(),
                    op: None,
                    detail: None,
                }
            } else {
                sequence += 1;
                Answer::Receipt {
                    actor: i.actor,
                    sequence: i.sequence,
                    intent: Id::new(LINEAGE, sequence).unwrap(),
                    entries: vec![sequence],
                    names: BTreeMap::new(),
                }
            };
            let frame = encode(&Value::Map(
                [(1, version(sequence).to_value()), (2, answer.to_value())].into(),
            ))
            .unwrap();
            let _ = s
                .write_all(&u32::try_from(frame.len()).unwrap().to_be_bytes())
                .await;
            let _ = s.write_all(&frame).await;
            answered.fetch_add(1, Ordering::SeqCst);
        }
    }
}

struct Running {
    gw: Arc<Gateway>,
    url: String,
    lines: Arc<Mutex<Vec<String>>>,
    answered: Arc<AtomicUsize>,
}

async fn start(name: &str, tokens: Tokens) -> Running {
    start_with(name, tokens, Receipts::off()).await
}

async fn start_with(name: &str, tokens: Tokens, receipts: Receipts) -> Running {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("gw-{name}.sock"));
    let _ = std::fs::remove_file(&path);
    let answered = Arc::new(AtomicUsize::new(0));
    tokio::spawn(world(UnixListener::bind(&path).unwrap(), answered.clone()));
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let log: Log = Arc::new(move |l: &str| sink.lock().unwrap().push(l.to_owned()));
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, receipts);
    tokio::spawn(world_link::run(gw.clone(), path));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", listener.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(listener, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    Running {
        gw,
        url,
        lines,
        answered,
    }
}

/// The next binary frame, decoded; `None` when the socket closes.
async fn next(ws: &mut Ws) -> Option<Value> {
    loop {
        match ws.next().await? {
            Ok(Message::Binary(b)) => return Some(decode(&b).unwrap().value),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

async fn put(ws: &mut Ws, bytes: Vec<u8>) {
    ws.send(Message::Binary(bytes.into())).await.unwrap();
}

fn hello() -> Vec<u8> {
    Hello {
        protocol: PROTOCOL,
        build: BUILD.to_vec(),
        refused: None,
        other: None,
    }
    .to_bytes()
    .unwrap()
}

fn sign_in(token: &str, cursor: Option<Value>, seen: Option<u64>) -> Vec<u8> {
    let mut m = BTreeMap::from([(1, Value::Text(Name::new(token).unwrap()))]);
    if let Some(c) = cursor {
        m.insert(2, c);
    }
    if let Some(n) = seen {
        m.insert(3, Value::Uint(n));
    }
    encode(&Value::Map(m)).unwrap()
}

fn outcome(v: &Value) -> String {
    match v {
        Value::Map(m) => match m.get(&4) {
            Some(Value::Text(n)) => n.as_str().to_owned(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

/// Connects, exchanges first frames and signs in by message; the sign-in's outcome.
async fn connect(url: &str, token: &str, cursor: Option<Value>) -> (Ws, String) {
    connect_seen(url, token, cursor, None).await
}

/// [`connect`], saying how many frames at the cursor's version the client applied.
async fn connect_seen(
    url: &str,
    token: &str,
    cursor: Option<Value>,
    seen: Option<u64>,
) -> (Ws, String) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    put(&mut ws, hello()).await;
    let first = Hello::read(&encode(&next(&mut ws).await.unwrap()).unwrap()).unwrap();
    assert_eq!(
        (first.protocol, first.build.as_slice()),
        (PROTOCOL, &BUILD[..])
    );
    put(&mut ws, sign_in(token, cursor, seen)).await;
    let o = next(&mut ws).await.map(|v| outcome(&v)).unwrap_or_default();
    (ws, o)
}

fn issue(tokens: &mut Tokens, grant: Grant) -> Token {
    let t = Token::issue(grant).unwrap();
    tokens.add(grant, t.hash());
    t
}

fn secret(t: &Token) -> String {
    t.reveal().rsplit_once('.').unwrap().1.to_owned()
}

#[test]
fn a3_only_the_sha256_is_stored() {
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(1));
    let stored: Vec<_> = tokens.stored().collect();
    assert_eq!(stored.len(), 1);
    assert_eq!(*stored[0].1, sha256(t.reveal().as_bytes()));
    assert!(!to_hex(stored[0].1).contains(&secret(&t)));
    // The token's own formats hold its grant and never its secret.
    for shown in [format!("{t}"), format!("{t:?}")] {
        assert!(!shown.contains(&secret(&t)), "{shown}");
        assert!(shown.contains(&soul(1).to_text()));
    }
    // The file the gateway reads holds the grant and the hash.
    let line = Tokens::line(soul(1), &t.hash());
    assert!(!line.contains(&secret(&t)));
    assert!(Tokens::read(&line).unwrap().check(&t).is_some());
}

#[test]
fn a3_the_compare_is_constant_time() {
    // `check` and `revoke` compare hashes with `subtle`'s `ct_eq` only: no `==` in either.
    let src = include_str!("../src/token.rs");
    for f in ["pub fn check", "pub fn revoke"] {
        let start = src.find(f).unwrap();
        let body = &src[start..start + src[start..].find("\n    }\n").unwrap()];
        assert!(body.contains("ct_eq"), "{f} uses ct_eq");
        assert!(!body.contains("=="), "{f} has no ==");
    }
    // And it decides rightly: one changed digit at either end of the secret is refused.
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(2));
    assert_eq!(tokens.check(&t), Some(soul(2)));
    for at in [0, 63] {
        let mut s: Vec<u8> = secret(&t).into_bytes();
        s[at] = if s[at] == b'0' { b'1' } else { b'0' };
        let wrong = format!("{}.{}", soul(2).to_text(), String::from_utf8(s).unwrap());
        assert_eq!(tokens.check(&Token::parse(&wrong).unwrap()), None);
    }
    // The right secret under another grant is refused too.
    let other = format!("{}.{}", soul(3).to_text(), secret(&t));
    assert_eq!(tokens.check(&Token::parse(&other).unwrap()), None);
}

#[tokio::test]
async fn a3_a_revoked_token_is_refused_and_no_token_is_in_any_log_line() {
    let mut tokens = Tokens::default();
    let good = issue(&mut tokens, soul(10));
    let revoked = issue(&mut tokens, soul(11));
    assert!(tokens.revoke(&revoked.hash()));
    assert_eq!(tokens.check(&revoked), None);
    let r = start("a3", tokens).await;

    let (_ws, o) = connect(&r.url, good.reveal(), None).await;
    assert_eq!(o, "stream.started");
    let (_ws, o) = connect(&r.url, revoked.reveal(), None).await;
    assert_eq!(o, "token.refused", "a revoked token is refused");
    let unknown = Token::issue(soul(12)).unwrap();
    let (_ws, o) = connect(&r.url, unknown.reveal(), None).await;
    assert_eq!(o, "token.refused");
    // Revoked while the gateway runs.
    r.gw.tokens.write().unwrap().revoke(&good.hash());
    let (_ws, o) = connect(&r.url, good.reveal(), None).await;
    assert_eq!(o, "token.refused", "revoked at run time");

    // By header: the same check, and the socket carries intents.
    let fresh = Token::issue(soul(13)).unwrap();
    r.gw.tokens.write().unwrap().add(soul(13), fresh.hash());
    let mut req = r.url.as_str().into_client_request().unwrap();
    req.headers_mut().insert(
        "authorization",
        format!("Bearer {}", fresh.reveal()).parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    put(&mut ws, hello()).await;
    next(&mut ws).await.unwrap();
    assert_eq!(outcome(&next(&mut ws).await.unwrap()), "stream.started");
    put(&mut ws, intent(soul(13), 1)).await;
    assert!(next(&mut ws).await.is_some(), "an answer");
    // Revoked while signed in (W9, #2827): the next intent is refused by name.
    r.gw.tokens.write().unwrap().revoke(&fresh.hash());
    put(&mut ws, intent(soul(13), 2)).await;
    assert_eq!(outcome(&next(&mut ws).await.unwrap()), "token.refused");

    let lines = r.lines.lock().unwrap().clone();
    assert!(lines.iter().any(|l| l.contains("refused")), "{lines:?}");
    for t in [&good, &revoked, &unknown, &fresh] {
        for l in &lines {
            assert!(!l.contains(&secret(t)), "a token in a log line: {l}");
        }
    }
}

fn frame_version(v: &Value) -> Option<Value> {
    match v {
        Value::Map(m) => m.get(&1).cloned(),
        _ => None,
    }
}

fn frame_sequence(v: &Value) -> Option<u64> {
    let Value::Map(m) = v else { return None };
    let Some(Value::Map(a)) = m.get(&2) else {
        return None;
    };
    match a.get(&2) {
        Some(Value::Uint(s)) => Some(*s),
        _ => None,
    }
}

#[tokio::test]
async fn a4_a_client_resumes_from_its_cursor_or_is_told_it_cannot() {
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(20));
    let r = start("a4", tokens).await;

    let (mut ws, o) = connect(&r.url, t.reveal(), None).await;
    assert_eq!(o, "stream.started");
    let mut got = Vec::new();
    for s in 1..=3 {
        put(&mut ws, intent(soul(20), s)).await;
        got.push(next(&mut ws).await.unwrap());
    }
    // The client applied the first answer only, then its socket dropped.
    let cursor = frame_version(&got[0]).unwrap();
    drop(ws);

    let (mut ws, o) = connect(&r.url, t.reveal(), Some(cursor)).await;
    assert_eq!(o, "stream.resumed");
    let replay = [next(&mut ws).await.unwrap(), next(&mut ws).await.unwrap()];
    assert_eq!(replay.map(|f| frame_sequence(&f)), [Some(2), Some(3)]);
    drop(ws);

    // A cursor from another lineage: told by name to start again, and the stream goes on.
    let other = Version {
        lineage: Scope([9; 16]),
        ..version(1)
    };
    let (mut ws, o) = connect(&r.url, t.reveal(), Some(other.to_value())).await;
    assert_eq!(o, "stream.cannot-resume");
    put(&mut ws, intent(soul(20), 4)).await;
    assert_eq!(frame_sequence(&next(&mut ws).await.unwrap()), Some(4));
    drop(ws);
    // A cursor newer than anything sent: the same.
    let (_ws, o) = connect(&r.url, t.reveal(), Some(version(1_000).to_value())).await;
    assert_eq!(o, "stream.cannot-resume");
}

/// The last device wins, and the socket let go is told so by name (`agent.replaced`, 4001), so its client does not
/// sign in again at once and take the Soul back: two clients of one Soul did, about seven times a second each.
#[tokio::test]
async fn a_socket_replaced_by_a_newer_sign_in_is_closed_as_replaced() {
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(21));
    let r = start("replaced", tokens).await;
    let (mut first, o) = connect(&r.url, t.reveal(), None).await;
    assert_eq!(o, "stream.started");
    let (mut second, o) = connect(&r.url, t.reveal(), None).await;
    assert_eq!(o, "stream.started");
    let close = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match first.next().await {
                Some(Ok(Message::Close(c))) => {
                    return c.map(|c| (u16::from(c.code), c.reason.to_string()));
                }
                Some(Ok(_)) => continue,
                _ => return None,
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        close,
        Some((gatewayd::REPLACED, "agent.replaced".to_owned()))
    );
    // The newer socket goes on.
    put(&mut second, intent(soul(21), 1)).await;
    assert_eq!(frame_sequence(&next(&mut second).await.unwrap()), Some(1));
}

/// A sign-in that asks only if the Soul is free (`?free=1`, a client another took the Soul from) is closed as
/// `agent.held` while a live socket holds it, and that socket goes on; once none holds it, the same sign-in takes it.
#[tokio::test]
async fn a_sign_in_that_asks_if_free_never_takes_the_soul_from_a_live_socket() {
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(22));
    let r = start("free", tokens).await;
    let free = format!("{}?{}", r.url, gatewayd::FREE);
    let (mut holder, o) = connect(&r.url, t.reveal(), None).await;
    assert_eq!(o, "stream.started");
    let (mut asking, _) = tokio_tungstenite::connect_async(&free).await.unwrap();
    put(&mut asking, hello()).await;
    next(&mut asking).await.unwrap();
    put(&mut asking, sign_in(t.reveal(), None, None)).await;
    let close = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match asking.next().await {
                Some(Ok(Message::Close(c))) => {
                    return c.map(|c| (u16::from(c.code), c.reason.to_string()));
                }
                Some(Ok(_)) => continue,
                _ => return None,
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(close, Some((gatewayd::REPLACED, "agent.held".to_owned())));
    // The holder goes on.
    put(&mut holder, intent(soul(22), 1)).await;
    assert_eq!(frame_sequence(&next(&mut holder).await.unwrap()), Some(1));
    // Once it has gone, the same sign-in takes the Soul.
    holder.close(None).await.unwrap();
    while next(&mut holder).await.is_some() {}
    let o = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let (_ws, o) = connect(&free, t.reveal(), None).await;
            if o == "stream.started" {
                return o;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(o, "stream.started");
}

/// The wall clock, µs from the Unix epoch, for an intent's expiry (world time is real time).
#[allow(clippy::disallowed_methods)] // a test that sets real expiries reads the wall clock
fn unix_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64
}

/// A stand-in world that takes `n` intents (after the gateway's handover ask), never answers, then goes away for good.
async fn mute_world(listener: UnixListener, n: usize) {
    let (mut s, _) = listener.accept().await.unwrap();
    for _ in 0..=n {
        let mut len = [0u8; 4];
        s.read_exact(&mut len).await.unwrap();
        let mut bytes = vec![0u8; u32::from_be_bytes(len) as usize];
        s.read_exact(&mut bytes).await.unwrap();
    }
}

/// The answer's sequence and refusal name in a frame the gateway gave itself (`{2: answer}`).
fn refusal(v: &Value) -> (Option<u64>, String) {
    let Value::Map(m) = v else {
        return (None, String::new());
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        return (None, String::new());
    };
    let name = match a.get(&4) {
        Some(Value::Text(n)) => n.as_str().to_owned(),
        _ => String::new(),
    };
    (frame_sequence(v), name)
}

/// C8 (#3396) A3: intents the world took and never answered, the world then away, are answered by the gateway by
/// their deadlines: `intent.expired` at the expiry when that comes first, else `act.timed-out` 10 s after receipt.
/// Never silence, each answered once, and neither kept to send again.
#[allow(clippy::disallowed_methods)] // the test times the answers against the deadline
#[tokio::test]
async fn c8_an_intent_with_no_answer_by_its_deadline_is_answered_by_name() {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gw-c8.sock");
    let _ = std::fs::remove_file(&path);
    let world = tokio::spawn(mute_world(UnixListener::bind(&path).unwrap(), 2));
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(30));
    let gw = Gateway::new(tokens, BUILD.to_vec(), Arc::new(|_: &str| {}));
    tokio::spawn(world_link::run(gw.clone(), path.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", listener.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(listener, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let (mut ws, o) = connect(&url, t.reveal(), None).await;
    assert_eq!(o, "stream.started");
    let with_expiry = |sequence: u64, expiry: i64| {
        let mut v = decode(&intent(soul(30), sequence)).unwrap().value;
        if let Value::Map(m) = &mut v {
            m.insert(7, Value::Uint(u64::try_from(expiry).unwrap()));
        }
        encode(&v).unwrap()
    };
    let start = std::time::Instant::now();
    // One expires in 1.5 s; the other's expiry is a minute off, so its deadline is the gateway's 10 s.
    put(&mut ws, with_expiry(1, unix_us() + 1_500_000)).await;
    put(&mut ws, with_expiry(2, unix_us() + 60_000_000)).await;
    // The world takes both and goes away, its socket gone.
    world.await.unwrap();
    let _ = std::fs::remove_file(&path);
    let first = next(&mut ws).await.unwrap();
    let at_first = start.elapsed().as_secs_f64();
    assert_eq!(refusal(&first), (Some(1), "intent.expired".to_owned()));
    let bars = std::env::var_os("V2_SPEED_BARS").is_some();
    assert!(
        at_first >= 1.4,
        "expired at {at_first} s, before its expiry"
    );
    assert!(!bars || at_first < 2.0, "expired at {at_first} s");
    let second = next(&mut ws).await.unwrap();
    let at_second = start.elapsed().as_secs_f64();
    assert_eq!(refusal(&second), (Some(2), "act.timed-out".to_owned()));
    assert!(
        at_second >= 9.9,
        "timed out at {at_second} s, before its deadline"
    );
    assert!(!bars || at_second < 10.5, "timed out at {at_second} s");
    assert_eq!(gw.link.unanswered(), 0, "neither is kept to send again");
    println!(
        "C8: intent.expired after {at_first:.2} s, act.timed-out after {at_second:.2} s, none kept"
    );
}

/// The next frame within 30 s: an answer that never comes fails the test rather than hanging it.
async fn soon(ws: &mut Ws) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(30), next(ws))
        .await
        .expect("a frame within 30 s")
        .expect("the socket is open")
}

fn is_refusal(v: &Value) -> bool {
    let Value::Map(m) = v else { return false };
    let Some(Value::Map(a)) = m.get(&2) else {
        return false;
    };
    a.get(&3) == Some(&Value::Uint(2))
}

/// Waits until the stand-in world has answered `n` intents and the gateway has taken every answer.
async fn answered(r: &Running, n: usize) {
    while r.answered.load(Ordering::SeqCst) < n || r.gw.link.unanswered() > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    // The gateway keeps an answer just after it stops counting it unanswered.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
}

#[tokio::test]
async fn a_refusal_lost_on_a_drop_is_replayed_once_on_resume() {
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(30));
    let r = start("refusal", tokens).await;

    let (mut ws, o) = connect(&r.url, t.reveal(), None).await;
    assert_eq!(o, "stream.started");
    put(&mut ws, intent(soul(30), 1)).await;
    let first = soon(&mut ws).await;
    let cursor = frame_version(&first).unwrap();
    // The world refuses the next intent without moving the version; the socket drops before its answer arrives.
    put(&mut ws, intent_to(soul(30), 2, REFUSED)).await;
    drop(ws);
    answered(&r, 2).await;

    let (mut ws, o) = connect_seen(&r.url, t.reveal(), Some(cursor.clone()), Some(1)).await;
    assert_eq!(o, "stream.resumed");
    let replayed = soon(&mut ws).await;
    assert!(is_refusal(&replayed), "{replayed:?}");
    assert_eq!(frame_sequence(&replayed), Some(2), "with its request id");
    assert_eq!(
        frame_version(&replayed),
        Some(cursor),
        "at the same version"
    );
    // Once: the next frame is the next intent's answer.
    put(&mut ws, intent(soul(30), 3)).await;
    assert_eq!(frame_sequence(&soon(&mut ws).await), Some(3));
}

#[tokio::test]
async fn accepted_and_refused_answers_resume_in_order_none_twice() {
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(31));
    let r = start("mixed", tokens).await;

    let (mut ws, _) = connect(&r.url, t.reveal(), None).await;
    // 1 accepted (version 1), 2 and 3 refused (still 1), 4 accepted (2), 5 refused (2).
    let mut got = Vec::new();
    for (s, verb) in [
        (1, "eden:wave"),
        (2, REFUSED),
        (3, REFUSED),
        (4, "eden:wave"),
        (5, REFUSED),
    ] {
        put(&mut ws, intent_to(soul(31), s, verb)).await;
        got.push(soon(&mut ws).await);
    }
    let refused: Vec<_> = got.iter().map(is_refusal).collect();
    assert_eq!(refused, [false, true, true, false, true]);
    assert_eq!(frame_version(&got[1]), frame_version(&got[0]));
    // The client applied the first two only (two frames at version 1), then its socket dropped.
    drop(ws);
    let (mut ws, o) = connect_seen(&r.url, t.reveal(), frame_version(&got[1]), Some(2)).await;
    assert_eq!(o, "stream.resumed");
    let mut replay = Vec::new();
    for _ in 0..3 {
        replay.push(frame_sequence(&soon(&mut ws).await));
    }
    assert_eq!(replay, [Some(3), Some(4), Some(5)]);
    put(&mut ws, intent(soul(31), 6)).await;
    assert_eq!(frame_sequence(&soon(&mut ws).await), Some(6), "none twice");
    drop(ws);

    // Having applied everything (6 is the one frame at version 3): nothing is replayed.
    let (mut ws, o) = connect_seen(&r.url, t.reveal(), Some(version(3).to_value()), Some(1)).await;
    assert_eq!(o, "stream.resumed");
    put(&mut ws, intent(soul(31), 7)).await;
    assert_eq!(frame_sequence(&soon(&mut ws).await), Some(7));
}

#[tokio::test]
async fn the_gateways_own_refusal_lost_on_a_drop_is_replayed_once_on_resume() {
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(32));
    let r = start("own-refusal", tokens).await;

    let (mut ws, _) = connect(&r.url, t.reveal(), None).await;
    put(&mut ws, intent(soul(32), 1)).await;
    let cursor = frame_version(&soon(&mut ws).await).unwrap();
    // An intent for an actor this token does not grant: the gateway refuses it itself, `intent-not-granted` (the
    // same path as `world.restarting`). The socket drops before the refusal arrives.
    put(&mut ws, intent(soul(99), 7)).await;
    drop(ws);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let (mut ws, o) = connect_seen(&r.url, t.reveal(), Some(cursor.clone()), Some(1)).await;
    assert_eq!(o, "stream.resumed");
    let replayed = soon(&mut ws).await;
    assert!(is_refusal(&replayed), "{replayed:?}");
    assert_eq!(frame_sequence(&replayed), Some(7), "with its request id");
    assert_eq!(
        frame_version(&replayed),
        Some(cursor),
        "at the newest version"
    );
    put(&mut ws, intent(soul(32), 2)).await;
    assert_eq!(frame_sequence(&soon(&mut ws).await), Some(2), "once");
}

fn tmp(name: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// Signs in by header with a client name; the socket, after the outcome.
async fn connect_as(url: &str, token: &Token, client: &str) -> Ws {
    let mut req = url.into_client_request().unwrap();
    let h = req.headers_mut();
    h.insert(
        "authorization",
        format!("Bearer {}", token.reveal()).parse().unwrap(),
    );
    h.insert("souls-client", client.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    put(&mut ws, hello()).await;
    next(&mut ws).await.unwrap();
    assert_eq!(outcome(&next(&mut ws).await.unwrap()), "stream.started");
    ws
}

/// Every line of the receipts files under `dir` (one per UTC day), once `n` are there.
async fn receipt_lines(dir: &std::path::Path, n: usize) -> Vec<String> {
    for _ in 0..400 {
        let mut lines = Vec::new();
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|d| d.map(|e| e.unwrap().path()).collect())
            .unwrap_or_default();
        files.sort();
        for f in files {
            let text = std::fs::read_to_string(f).unwrap_or_default();
            lines.extend(text.lines().map(str::to_owned));
        }
        if lines.len() >= n {
            return lines;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("fewer than {n} receipt lines in {}", dir.display());
}

/// The scripted run behind `r1_`, `r3_` and `r4_`: two Souls of two accounts. One acts three times and is refused
/// once by the world; the other acts once and is refused once by the world and once by the gateway (an intent
/// naming another actor).
async fn scripted_run(name: &str) -> (PathBuf, Vec<Token>, Vec<String>) {
    let root = tmp(name);
    let dir = root.join("worlds").join("w1").join("receipts");
    let mut tokens = Tokens::default();
    let a = issue(&mut tokens, soul(40));
    let b = issue(&mut tokens, soul(41));
    tokens.set_account(soul(40), "acct_one");
    tokens.set_account(soul(41), "acct_two");
    let r = start_with(name, tokens, Receipts::to_dir(dir.clone())).await;

    let mut wa = connect_as(&r.url, &a, "souls-client/1.2.0").await;
    for s in [1, 2, 3, 100] {
        put(&mut wa, intent(soul(40), s)).await;
        next(&mut wa).await.unwrap();
    }
    let mut wb = connect_as(&r.url, &b, "eden.mjs/0.9").await;
    for bytes in [
        intent(soul(41), 1),
        intent(soul(41), 100),
        intent(soul(40), 7),
    ] {
        put(&mut wb, bytes).await;
        next(&mut wb).await.unwrap();
    }
    let lines = receipt_lines(&dir, 7).await;
    assert_eq!(r.gw.receipts.dropped(), 0);
    (root, vec![a, b], lines)
}

fn count(lines: &[String], soul: Grant, outcome: &str) -> usize {
    let s = format!("\"soul\":\"{}\"", soul.to_text());
    let o = format!("\"outcome\":\"{outcome}\"");
    lines
        .iter()
        .filter(|l| l.contains(&s) && l.contains(&o))
        .count()
}

#[tokio::test]
async fn r1_each_answered_intent_is_one_line_accepted_and_refused() {
    let (_, _, lines) = scripted_run("receipts-r1").await;
    assert_eq!(lines.len(), 7, "{lines:#?}");
    assert_eq!(count(&lines, soul(40), "receipt"), 3);
    assert_eq!(count(&lines, soul(40), "refusal"), 1, "the world's refusal");
    assert_eq!(count(&lines, soul(41), "receipt"), 1);
    assert_eq!(
        count(&lines, soul(41), "refusal"),
        2,
        "the world's and the gateway's"
    );
    for l in &lines {
        // Exactly the five fields, in one JSON object.
        let keys: Vec<&str> = l
            .trim_matches(|c| c == '{' || c == '}')
            .split(',')
            .map(|kv| kv.split(':').next().unwrap())
            .collect();
        assert_eq!(
            keys,
            [
                "\"t\"",
                "\"soul\"",
                "\"account\"",
                "\"outcome\"",
                "\"client\""
            ],
            "{l}"
        );
    }
    assert!(
        lines[0].contains("\"account\":\"acct_one\""),
        "{}",
        lines[0]
    );
    assert!(lines[0].contains("\"client\":\"souls-client/1.2.0\""));
    assert!(
        lines[6].contains("\"account\":\"acct_two\""),
        "{}",
        lines[6]
    );
    assert!(lines[6].contains("\"client\":\"eden.mjs/0.9\""));
}

#[tokio::test]
async fn r2_a_failed_write_drops_and_counts_and_the_answer_still_comes() {
    // The receipts folder cannot be made: a file stands where it would be.
    let root = tmp("receipts-r2");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("receipts"), "not a folder").unwrap();
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(50));
    let r = start_with(
        "receipts-r2",
        tokens,
        Receipts::to_dir(root.join("receipts")),
    )
    .await;
    let mut ws = connect_as(&r.url, &t, "souls-client/1.2.0").await;
    for s in 1..=5 {
        put(&mut ws, intent(soul(50), s)).await;
        let answer = tokio::time::timeout(std::time::Duration::from_secs(30), next(&mut ws))
            .await
            .expect("the answer is not held up");
        assert_eq!(frame_sequence(&answer.unwrap()), Some(s));
    }
    for _ in 0..400 {
        if r.gw.receipts.dropped() == 5 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(r.gw.receipts.dropped(), 5, "each line dropped is counted");
}

#[tokio::test]
async fn r3_no_intent_text_and_no_token_in_the_file() {
    let (root, tokens, lines) = scripted_run("receipts-r3").await;
    let file = lines.join("\n");
    for t in &tokens {
        assert!(!file.contains(t.reveal()), "a token in the receipts file");
        assert!(!file.contains(&secret(t)), "a token's secret in it");
    }
    for text in ["eden:wave", "eden:out-of-reach", "intent-not-granted"] {
        assert!(!file.contains(text), "intent or answer text in it: {text}");
    }
    assert!(root.join("worlds/w1/receipts").is_dir());
}

/// Leaves the scripted run's file where `usage.mjs rollup --root <root>` reads it (the PR shows the roll-up).
#[tokio::test]
async fn r4_scripted_run_for_the_usage_rollup() {
    let (root, _, lines) = scripted_run("receipts-r4").await;
    assert_eq!(lines.len(), 7);
    println!("r4: {} lines under {}", lines.len(), root.display());
}

/// O2 (#2731) A4: the world is asleep (nothing listens on its socket). With a wake set, an agent's sync request (a
/// client syncs before its first intent) is answered `world.restarting` and asks the wake; an intent is held, asks no
/// second wake, and the world, started a second later, answers it within 3 s.
#[tokio::test]
// The test measures how long the answer took in real time (the wall-clock rule, K7).
#[allow(clippy::disallowed_methods)]
async fn o2_an_agents_sync_or_intent_wakes_a_sleeping_world_once() {
    use replica::sync::wire;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};
    const WAKE: Duration = Duration::from_secs(1);
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(30));
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gw-o2.sock");
    let _ = std::fs::remove_file(&path);
    let gw = Gateway::new(tokens, BUILD.to_vec(), Arc::new(|_: &str| {}));
    let wakes = Arc::new(AtomicUsize::new(0));
    let (p, n, rt) = (
        path.clone(),
        wakes.clone(),
        tokio::runtime::Handle::current(),
    );
    gw.link.set_wake(Arc::new(move || {
        n.fetch_add(1, Ordering::SeqCst);
        let p = p.clone();
        rt.spawn(async move {
            tokio::time::sleep(WAKE).await;
            world(
                UnixListener::bind(&p).unwrap(),
                Arc::new(AtomicUsize::new(0)),
            )
            .await;
        });
    }));
    tokio::spawn(world_link::run(gw.clone(), path));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", listener.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(listener, socket::router(gw.clone())).into_future());
    let (mut ws, o) = connect(&url, t.reveal(), None).await;
    assert_eq!(o, "stream.started");

    // An agent's sync request asks the wake: its client sends no intent before it has synced.
    put(
        &mut ws,
        encode(&Value::Map([(wire::ASK, Value::Uint(1))].into())).unwrap(),
    )
    .await;
    let answer = next(&mut ws).await.unwrap();
    let Value::Map(m) = &answer else {
        panic!("{answer:?}")
    };
    assert!(
        matches!(m.get(&wire::REFUSED), Some(Value::Text(n)) if n.as_str() == world_link::RESTARTING)
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(wakes.load(Ordering::SeqCst), 1, "the sync asked no wake");
    assert!(!gw.link.up());

    // A4: an intent wakes it and is answered within 3 s; a second one asks no second wake. Held while the world is
    // away, an intent keeps its deadline (C8): these expire a minute on, so the gateway's own deadline is 10 s.
    let live = |sequence: u64| {
        let mut v = decode(&intent(soul(30), sequence)).unwrap().value;
        if let Value::Map(m) = &mut v {
            m.insert(
                7,
                Value::Uint(u64::try_from(unix_us() + 60_000_000).unwrap()),
            );
        }
        encode(&v).unwrap()
    };
    let sent = Instant::now();
    put(&mut ws, live(1)).await;
    put(&mut ws, live(2)).await;
    let first = next(&mut ws).await.unwrap();
    let took = sent.elapsed();
    let second = next(&mut ws).await.unwrap();
    assert_eq!(
        [frame_sequence(&first), frame_sequence(&second)],
        [Some(1), Some(2)]
    );
    assert!(
        frame_version(&first).is_some(),
        "the world's receipt, not the gateway's refusal"
    );
    assert!(took < Duration::from_secs(3), "answered in {took:?}");
    assert_eq!(wakes.load(Ordering::SeqCst), 1);
    println!(
        "o2: an intent to a sleeping world answered in {} ms (the world up {} ms after the wake)",
        took.as_millis(),
        WAKE.as_millis()
    );
}

/// O16 (#2809): a stopping gateway closes every signed-in socket with 1012, Service Restart; the client reconnects.
#[tokio::test]
async fn o16_a_stopping_gateway_closes_each_socket_with_1012() {
    let mut tokens = Tokens::default();
    let (a, b) = (issue(&mut tokens, soul(1)), issue(&mut tokens, soul(2)));
    let r = start("o16-stop", tokens).await;
    let (mut wa, _) = connect(&r.url, a.reveal(), None).await;
    let (mut wb, _) = connect(&r.url, b.reveal(), None).await;
    r.gw.closing.send_replace(true);
    for ws in [&mut wa, &mut wb] {
        let code = loop {
            match ws.next().await {
                Some(Ok(Message::Close(Some(f)))) => break Some(u16::from(f.code)),
                Some(Ok(_)) => {}
                _ => break None,
            }
        };
        assert_eq!(code, Some(gatewayd::RESTART));
    }
}

/// A stand-in world that takes one intent, says it is in progress with `left` µs to its deadline (C20's progress
/// answer, `worldd::answers::progress`: T10's accepted with field 5), then goes away.
async fn busy_world(listener: UnixListener, left: u64) {
    let (mut s, _) = listener.accept().await.unwrap();
    let i = loop {
        let mut len = [0u8; 4];
        s.read_exact(&mut len).await.unwrap();
        let mut bytes = vec![0u8; u32::from_be_bytes(len) as usize];
        s.read_exact(&mut bytes).await.unwrap();
        // The gateway's handover ask comes first.
        if let Ok(i) = Intent::read(&bytes) {
            break i;
        }
    };
    let Value::Map(mut answer) = (Answer::Accepted {
        actor: i.actor,
        sequence: i.sequence,
        intent: Id::new(LINEAGE, 1).unwrap(),
    })
    .to_value() else {
        panic!("an answer is a map")
    };
    answer.insert(5, Value::Uint(left));
    let frame = encode(&Value::Map(
        [(1, version(1).to_value()), (2, Value::Map(answer))].into(),
    ))
    .unwrap();
    s.write_all(&u32::try_from(frame.len()).unwrap().to_be_bytes())
        .await
        .unwrap();
    s.write_all(&frame).await.unwrap();
}

/// The answer's kind in a frame (`{2: {3: kind}}`).
fn kind(v: &Value) -> Option<u64> {
    let Value::Map(m) = v else { return None };
    let Some(Value::Map(a)) = m.get(&2) else {
        return None;
    };
    match a.get(&3) {
        Some(Value::Uint(k)) => Some(*k),
        _ => None,
    }
}

/// C20 (#3469) A3: an act the world says is in progress (a form's walk across the town, a long read) is passed on to
/// the actor as progress, and the gateway waits for it to the world's deadline, not C8's 10 s: the world goes away
/// after its progress answer, is back at 11 s, and the intent sent again is answered with its receipt, never
/// `act.timed-out`. An intent the world says nothing of keeps C8's 10 s (`c8_` above).
#[allow(clippy::disallowed_methods)] // the test times the answers against the deadlines
#[tokio::test]
async fn c20_an_act_in_progress_is_answered_with_progress_not_timed_out() {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("gw-c20.sock");
    let _ = std::fs::remove_file(&path);
    let busy = tokio::spawn(busy_world(UnixListener::bind(&path).unwrap(), 30_000_000));
    let mut tokens = Tokens::default();
    let t = issue(&mut tokens, soul(31));
    let gw = Gateway::new(tokens, BUILD.to_vec(), Arc::new(|_: &str| {}));
    tokio::spawn(world_link::run(gw.clone(), path.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", listener.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(listener, socket::router(gw.clone())).into_future());
    while !gw.link.up() {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let (mut ws, o) = connect(&url, t.reveal(), None).await;
    assert_eq!(o, "stream.started");
    let mut v = decode(&intent(soul(31), 1)).unwrap().value;
    if let Value::Map(m) = &mut v {
        m.insert(
            7,
            Value::Uint(u64::try_from(unix_us() + 60_000_000).unwrap()),
        );
    }
    let start = std::time::Instant::now();
    put(&mut ws, encode(&v).unwrap()).await;
    let progress = next(&mut ws).await.unwrap();
    assert_eq!(kind(&progress), Some(3), "progress first: {progress:?}");
    assert_eq!(frame_sequence(&progress), Some(1));
    // The world goes away, its socket gone, and is back at 11 s: past C8's 10 s, before the world's deadline.
    busy.await.unwrap();
    let _ = std::fs::remove_file(&path);
    tokio::time::sleep(std::time::Duration::from_secs(11).saturating_sub(start.elapsed())).await;
    tokio::spawn(world(
        UnixListener::bind(&path).unwrap(),
        Arc::new(AtomicUsize::new(0)),
    ));
    let answer = next(&mut ws).await.unwrap();
    let at = start.elapsed().as_secs_f64();
    assert_eq!(
        kind(&answer),
        Some(1),
        "a receipt, not act.timed-out: {answer:?}"
    );
    assert_eq!(frame_sequence(&answer), Some(1));
    assert!(at >= 11.0, "answered at {at} s");
    assert_eq!(gw.link.unanswered(), 0);
    println!(
        "C20: progress at once, the world away 11 s, then the receipt at {at:.2} s; no act.timed-out"
    );
}
