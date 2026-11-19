//! Engine v2 W5 (#2801), A4: the session exchange. A directory stand-in answers W1's test sign-in for two accounts;
//! the gateway is told one of them is the world's creator. That account's session is exchanged for a token whose
//! socket signs in; the other signed-in account is refused `not-the-creator`, and a session the directory refuses or
//! none at all is refused `session-refused`. Nothing is stored but the token's hash.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gatewayd::creator::{self, Exchange};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Tokens};
use gatewayd::{Gateway, Log, resume, socket};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope};
use replica::intents::{Hello, PROTOCOL};
use tokio_tungstenite::tungstenite::Message;

const BUILD: [u8; 4] = [0x12, 0x20, 0xab, 0xcd];

/// A directory that signs in `maker` and `visitor` for test worlds, as W1's `/v1/account/test-sign-in` answers, and
/// refuses every provider session.
fn directory(maker: Id, visitor: Id) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            let mut length = 0;
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                if h.trim().is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            r.read_exact(&mut body).unwrap();
            let body = String::from_utf8(body).unwrap();
            let who = match (line.contains("/v1/account/test-sign-in"), body.as_str()) {
                (true, b) if b.contains("\"maker\"") => Some(maker),
                (true, b) if b.contains("\"visitor\"") => Some(visitor),
                _ => None,
            };
            let (status, out) = match who {
                Some(p) => (
                    "200 OK",
                    format!(
                        "{{\"account\":\"a\",\"principal\":\"{}\"}}",
                        creator::principal_text(p)
                    ),
                ),
                None => ("401 Unauthorized", "{\"refused\":\"token-invalid\"}".into()),
            };
            let _ = write!(
                s,
                "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                out.len()
            );
        }
    });
    addr
}

async fn exchange(base: &str, session: Option<&str>) -> (u16, String) {
    let mut s = tokio::net::TcpStream::connect(base).await.unwrap();
    let auth = session.map_or(String::new(), |t| format!("authorization: Bearer {t}\r\n"));
    let req = format!(
        "POST {} HTTP/1.1\r\nhost: {base}\r\n{auth}content-length: 0\r\nconnection: close\r\n\r\n",
        creator::PATH
    );
    tokio::io::AsyncWriteExt::write_all(&mut s, req.as_bytes())
        .await
        .unwrap();
    let mut out = String::new();
    tokio::io::AsyncReadExt::read_to_string(&mut s, &mut out)
        .await
        .unwrap();
    let status = out[9..12].parse().unwrap();
    let body = out.split_once("\r\n\r\n").unwrap().1.to_owned();
    (status, body)
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next(ws: &mut Ws) -> Value {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Message::Binary(b) = m {
            return decode(&b).unwrap().value;
        }
    }
}

/// Signs in with `token` over the socket, as a browser does (by message after the first frame): the outcome's name.
async fn sign_in(url: &str, token: &str) -> String {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let hello = Hello {
        protocol: PROTOCOL,
        build: Vec::new(),
        refused: None,
        other: None,
    };
    ws.send(Message::Binary(hello.to_bytes().unwrap().into()))
        .await
        .unwrap();
    next(&mut ws).await;
    let m = BTreeMap::from([(1, Value::Text(Name::new(token).unwrap()))]);
    ws.send(Message::Binary(encode(&Value::Map(m)).unwrap().into()))
        .await
        .unwrap();
    let Value::Map(o) = next(&mut ws).await else {
        panic!("an outcome")
    };
    match o.get(&4) {
        Some(Value::Text(n)) => n.as_str().to_owned(),
        other => panic!("an outcome's name, not {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn w5_a4_only_the_worlds_creator_gets_a_token_and_its_socket_signs_in() {
    let maker = Id::new(Scope([0xc0; 16]), 1).unwrap();
    let visitor = Id::new(Scope([0x7a; 16]), 1).unwrap();
    let log: Log = std::sync::Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(Tokens::default(), BUILD.to_vec(), log, Receipts::off());
    let _ = gw.exchange.set(Exchange {
        creator: maker,
        directory: directory(maker, visitor),
    });
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = tcp.local_addr().unwrap().to_string();
    let url = format!("ws://{base}{}", socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());

    // The creator's session: a token for the creator's grant, which signs in; only its hash is kept.
    let (status, body) = exchange(&base, Some("test:maker")).await;
    println!("creator: {status} (token withheld)");
    assert_eq!(status, 200, "{body}");
    let grant = Grant::Actor(Actor::Creator(maker));
    assert!(body.contains(&format!("\"grant\":\"{}\"", grant.to_text())));
    let token = body
        .split_once("\"token\":\"")
        .and_then(|(_, r)| r.split_once('"'))
        .map(|(t, _)| t.to_owned())
        .unwrap();
    {
        let tokens = gw.tokens.read().unwrap();
        let stored: Vec<_> = tokens.stored().collect();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].0, grant);
    }
    assert_eq!(sign_in(&url, &token).await, resume::STARTED);

    // Another signed-in account, a session the directory refuses, and none: refused by name, nothing stored.
    for (session, want, name) in [
        (Some("test:visitor"), 403, "not-the-creator"),
        (Some("not-a-session"), 401, "session-refused"),
        (None, 401, "session-refused"),
    ] {
        let (status, body) = exchange(&base, session).await;
        println!("{session:?}: {status} {body}");
        assert_eq!(
            (status, body),
            (want, format!("{{\"refused\":\"{name}\"}}"))
        );
    }
    assert_eq!(gw.tokens.read().unwrap().stored().count(), 1);
}
