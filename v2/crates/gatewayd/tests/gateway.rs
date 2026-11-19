//! Engine v2 I1 (#2683): the token tests (A3) and the resume from a cursor (A4), through a real socket to an
//! in-process gateway and a stand-in world on a local socket. The restart table (A1, A2, A5) is
//! `v2/tools/bench/gateway-restart`. The receipts file (`r1_`..`r4_`): the usage roll-up's source (O21, #3325).

use std::collections::BTreeMap;
use std::path::PathBuf;
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
    let Grant::Actor(actor) = grant;
    let i = Intent {
        actor,
        verb: Name::new("eden:wave").unwrap(),
        target: None,
        parameters: BTreeMap::new(),
        sequence,
        basis: version(0).to_value(),
        expiry: 60_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    };
    encode(&i.to_value()).unwrap()
}

/// A stand-in world: answers every intent with a receipt, one version per answer; from sequence 100, a refusal.
async fn world(listener: UnixListener) {
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
            let i = Intent::read(&bytes).unwrap();
            sequence += 1;
            let answer = if i.sequence >= 100 {
                Answer::Refused {
                    actor: i.actor,
                    sequence: i.sequence,
                    reason: Name::new("eden:out-of-reach").unwrap(),
                    now: version(sequence).to_value(),
                    changed: Vec::new(),
                    op: None,
                }
            } else {
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
        }
    }
}

struct Running {
    gw: Arc<Gateway>,
    url: String,
    lines: Arc<Mutex<Vec<String>>>,
}

async fn start(name: &str, tokens: Tokens) -> Running {
    start_with(name, tokens, Receipts::off()).await
}

async fn start_with(name: &str, tokens: Tokens, receipts: Receipts) -> Running {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("gw-{name}.sock"));
    let _ = std::fs::remove_file(&path);
    tokio::spawn(world(UnixListener::bind(&path).unwrap()));
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
    Running { gw, url, lines }
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

fn sign_in(token: &str, cursor: Option<Value>) -> Vec<u8> {
    let mut m = BTreeMap::from([(1, Value::Text(Name::new(token).unwrap()))]);
    if let Some(c) = cursor {
        m.insert(2, c);
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
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    put(&mut ws, hello()).await;
    let first = Hello::read(&encode(&next(&mut ws).await.unwrap()).unwrap()).unwrap();
    assert_eq!(
        (first.protocol, first.build.as_slice()),
        (PROTOCOL, &BUILD[..])
    );
    put(&mut ws, sign_in(token, cursor)).await;
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
        let answer = tokio::time::timeout(std::time::Duration::from_secs(2), next(&mut ws))
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
