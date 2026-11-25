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
        authority_required: false,
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

#[tokio::test]
async fn w16_idle_creator_socket_cannot_revive_after_round_trip_and_soul_churn_keeps_browser_token()
{
    use gatewayd::token::Source;
    let a = Id::new(Scope([0xa1; 16]), 1).unwrap();
    let b = Id::new(Scope([0xb2; 16]), 1).unwrap();
    let root = std::env::temp_dir().join(format!("gateway-w16-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("tokens");
    let write = |generation: u64, owner: Id, tail: &str| {
        let temp = file.with_extension("tmp");
        std::fs::write(
            &temp,
            format!(
                "# souls-creator/1 {generation} {}\n{tail}",
                creator::principal_text(owner)
            ),
        )
        .unwrap();
        std::fs::rename(temp, &file).unwrap();
    };
    write(0, a, "");
    let (source, tokens) = Source::open(&file).unwrap();
    let gw = Gateway::with_receipts(
        tokens,
        BUILD.to_vec(),
        std::sync::Arc::new(|_| {}),
        Receipts::off(),
    );
    assert!(gw.tokens_file.set(source).is_ok());
    assert!(
        gw.exchange
            .set(Exchange {
                creator: a,
                directory: directory(a, b),
                authority_required: true
            })
            .is_ok()
    );
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = tcp.local_addr().unwrap().to_string();
    let task = tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    let url = format!("ws://{base}{}", socket::PATH);
    let (status, body) = exchange(&base, Some("test:maker")).await;
    assert_eq!(status, 200);
    let token = body
        .split_once("\"token\":\"")
        .unwrap()
        .1
        .split('"')
        .next()
        .unwrap()
        .to_owned();
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws.send(Message::Binary(
        Hello {
            protocol: PROTOCOL,
            build: Vec::new(),
            refused: None,
            other: None,
        }
        .to_bytes()
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    next(&mut ws).await;
    ws.send(Message::Binary(
        encode(&Value::Map(
            [(1, Value::Text(Name::new(&token).unwrap()))].into(),
        ))
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    assert_eq!(
        next(&mut ws).await,
        Value::Map([(4, Value::Text(Name::new(resume::STARTED).unwrap()))].into())
    );
    let view_key = gatewayd::token::ViewKey::new([9; 32]);
    assert!(
        gw.view_key
            .set(gatewayd::token::ViewKey::new([9; 32]))
            .is_ok()
    );
    let make_view = |grant: Grant| {
        let text = format!("view.{}.{}", gatewayd::unix_now() + 120, grant.to_text());
        format!(
            "{text}.{}",
            replica::encode::to_hex(&view_key.mac(text.as_bytes()))
        )
    };
    async fn open_view(url: &str, token: &str) -> Ws {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        ws.send(Message::Binary(
            Hello {
                protocol: PROTOCOL,
                build: Vec::new(),
                refused: None,
                other: None,
            }
            .to_bytes()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
        next(&mut ws).await;
        ws.send(Message::Binary(
            encode(&Value::Map(
                [(1, Value::Text(Name::new(token).unwrap()))].into(),
            ))
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
        assert_eq!(
            next(&mut ws).await,
            Value::Map([(4, Value::Text(Name::new(socket::VIEW_STARTED).unwrap()))].into())
        );
        ws
    }
    let maker = Grant::Actor(Actor::Creator(a));
    let mut creator_view = open_view(&url, &make_view(maker)).await;
    // Another ordinary pairing changes the file. Its new hash is loaded, while this short browser token survives.
    let soul = Grant::Actor(Actor::Soul(Id::new(Scope([0xc3; 16]), 1).unwrap()));
    let secret = gatewayd::token::Token::issue(soul).unwrap();
    let mut soul_view = open_view(&url, &make_view(soul)).await;
    write(0, a, &Tokens::line(soul, &secret.hash()));
    gw.tokens_file.get().unwrap().refresh(&gw.tokens);
    assert!(
        gw.tokens
            .read()
            .unwrap()
            .check(&gatewayd::token::Token::parse(&token).unwrap())
            .is_some()
    );
    assert_eq!(gw.tokens.read().unwrap().check(&secret), Some(soul));
    // This A socket sends NOTHING while B owns it, then A owns it again under a new generation.
    write(1, b, &Tokens::line(soul, &secret.hash()));
    assert_eq!(exchange(&base, Some("test:visitor")).await.0, 200);
    write(2, a, &Tokens::line(soul, &secret.hash()));
    // Private outgoing data alone must revoke the idle old creator-view socket, without any incoming frame.
    gw.tell_watchers(&maker.key(), "private creator reply".into());
    assert_eq!(
        next(&mut creator_view).await,
        Value::Map([(4, Value::Text(Name::new("token.refused").unwrap()))].into())
    );
    gw.tell_watchers(&soul.key(), "ordinary Soul reply".into());
    // The owner's box is also told whether the Soul's agent is connected (`{"agent": ...}`): those frames come first.
    let ordinary = loop {
        let m = tokio::time::timeout(Duration::from_secs(5), soul_view.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if !matches!(&m, Message::Text(t) if t.as_str().starts_with(r#"{"agent":"#)) {
            break m;
        }
    };
    assert_eq!(ordinary, Message::Text("ordinary Soul reply".into()));
    ws.send(Message::Text("{}".into())).await.unwrap();
    assert_eq!(
        next(&mut ws).await,
        Value::Map([(4, Value::Text(Name::new("token.refused").unwrap()))].into())
    );
    assert_eq!(sign_in(&url, &token).await, "token.refused");
    assert_eq!(exchange(&base, Some("test:maker")).await.0, 200);
    // Required placed mode never falls back to the static founder when the marker is absent or damaged.
    std::fs::write(&file, "").unwrap();
    assert_eq!(exchange(&base, Some("test:maker")).await.0, 503);
    std::fs::write(&file, "# souls-creator/1 broken none\n").unwrap();
    assert_eq!(exchange(&base, Some("test:maker")).await.0, 503);
    task.abort();
    let _ = task.await;
    std::fs::remove_dir_all(root).unwrap();
}
