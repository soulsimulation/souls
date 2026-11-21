//! #3760: `GET /v2/entries` serves the world's kind entries to a signed-in client only, gzip-encoded, with a tag the
//! client revalidates by (304 while unchanged), and with no `--entries` answers `entries-not-served`.

use std::sync::Arc;

use gatewayd::entries::{Entries, PATH};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, socket};
use replica::effects::Actor;
use replica::ids::{Id, Scope};

/// One GET; the status, the headers' text (lower case) and the body's bytes.
async fn get(base: &str, auth: Option<&str>, tag: Option<&str>) -> (u16, String, Vec<u8>) {
    let mut s = tokio::net::TcpStream::connect(base).await.unwrap();
    let auth = auth.map_or(String::new(), |t| format!("authorization: Bearer {t}\r\n"));
    let tag = tag.map_or(String::new(), |t| format!("if-none-match: {t}\r\n"));
    let req =
        format!("GET {PATH} HTTP/1.1\r\nhost: {base}\r\n{auth}{tag}connection: close\r\n\r\n");
    tokio::io::AsyncWriteExt::write_all(&mut s, req.as_bytes())
        .await
        .unwrap();
    let mut out = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut s, &mut out)
        .await
        .unwrap();
    let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&out[..split]).to_lowercase();
    (
        head[9..12].parse().unwrap(),
        head,
        out[split + 4..].to_vec(),
    )
}

async fn serve(gw: Arc<Gateway>) -> String {
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(tcp, socket::router(gw)).into_future());
    addr
}

#[tokio::test]
async fn a_signed_in_client_fetches_the_entries_once_per_change() {
    let dir = std::env::temp_dir().join(format!("gatewayd-entries-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("eden.bench.json"),
        r#"{"format":"souls-entry/1","kind":"eden:bench","owner":"thing"}"#,
    )
    .unwrap();
    let soul = Grant::Actor(Actor::Soul(Id::new(Scope([0xc3; 16]), 1).unwrap()));
    let token = Token::issue(soul).unwrap();
    let tokens = Tokens::read(&Tokens::line(soul, &token.hash())).unwrap();
    let log: Log = Arc::new(|_| {});
    let gw = Gateway::with_receipts(tokens, vec![0x12, 0x20], log.clone(), Receipts::off());
    let _ = gw.entries.set(Entries::open(&dir).unwrap());
    let base = serve(gw).await;

    assert_eq!(get(&base, None, None).await.0, 401, "no token");
    assert_eq!(
        get(&base, Some("soul-00-1.00"), None).await.0,
        401,
        "a token not in the file"
    );

    let (status, head, body) = get(&base, Some(token.reveal()), None).await;
    assert_eq!(status, 200);
    assert!(head.contains("content-encoding: gzip"));
    let raw = miniz_oxide::inflate::decompress_to_vec(&body[10..body.len() - 8]).unwrap();
    assert_eq!(
        raw,
        br#"[{"format":"souls-entry/1","kind":"eden:bench","owner":"thing"}]"#
    );
    let tag = head
        .lines()
        .find_map(|l| l.strip_prefix("etag: "))
        .unwrap()
        .to_owned();
    assert_eq!(
        get(&base, Some(token.reveal()), Some(&tag)).await.0,
        304,
        "unchanged: not sent again"
    );

    std::fs::write(
        dir.join("eden.lamp.json"),
        r#"{"format":"souls-entry/1","kind":"eden:lamp","owner":"thing"}"#,
    )
    .unwrap();
    let (status, head, _) = get(&base, Some(token.reveal()), Some(&tag)).await;
    assert_eq!(status, 200, "a change is sent");
    assert!(!head.contains(&tag));

    let bare = Gateway::with_receipts(Tokens::default(), vec![0x12, 0x20], log, Receipts::off());
    let (status, _, body) = get(&serve(bare).await, Some(token.reveal()), None).await;
    assert_eq!(
        (status, body),
        (404, br#"{"refused":"entries-not-served"}"#.to_vec())
    );
    let _ = std::fs::remove_dir_all(&dir);
}
