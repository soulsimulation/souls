//! #3760: `GET /v2/entries` serves the world's kind entries to a signed-in client only, gzip-encoded, with a tag the
//! client revalidates by (304 while unchanged), and with no `--entries` answers `entries-not-served`. `GET /v2/kinds`
//! serves the world's kinds text (`world.kinds` beside the entries folder) the same way (#1960).

use std::sync::Arc;

use gatewayd::entries::{Entries, KINDS_PATH, PATH};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, socket};
use replica::effects::Actor;
use replica::ids::{Id, Scope};

/// One GET; the status, the headers' text (lower case) and the body's bytes.
async fn get(base: &str, auth: Option<&str>, tag: Option<&str>) -> (u16, String, Vec<u8>) {
    get_at(PATH, base, auth, tag).await
}

async fn get_at(
    path: &str,
    base: &str,
    auth: Option<&str>,
    tag: Option<&str>,
) -> (u16, String, Vec<u8>) {
    let mut s = tokio::net::TcpStream::connect(base).await.unwrap();
    let auth = auth.map_or(String::new(), |t| format!("authorization: Bearer {t}\r\n"));
    let tag = tag.map_or(String::new(), |t| format!("if-none-match: {t}\r\n"));
    let req =
        format!("GET {path} HTTP/1.1\r\nhost: {base}\r\n{auth}{tag}connection: close\r\n\r\n");
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

#[tokio::test]
async fn a_token_paired_a_moment_ago_fetches_at_once() {
    let dir = std::env::temp_dir().join(format!("gatewayd-entries-paired-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("entries")).unwrap();
    std::fs::write(
        dir.join("entries/eden.bench.json"),
        r#"{"format":"souls-entry/1","kind":"eden:bench","owner":"thing"}"#,
    )
    .unwrap();
    let file = dir.join("tokens");
    std::fs::write(&file, "").unwrap();
    let (source, tokens) = gatewayd::token::Source::open(&file).unwrap();
    let log: Log = Arc::new(|_| {});
    let gw = Gateway::with_receipts(tokens, vec![0x12, 0x20], log, Receipts::off());
    let _ = gw.tokens_file.set(source);
    let _ = gw.entries.set(Entries::open(&dir.join("entries")).unwrap());
    let base = serve(gw).await;
    // The directory writes the new pairing's hash; the client asks at once, before any periodic re-read.
    let soul = Grant::Actor(Actor::Soul(Id::new(Scope([0xc4; 16]), 1).unwrap()));
    let token = Token::issue(soul).unwrap();
    std::fs::write(&file, Tokens::line(soul, &token.hash())).unwrap();
    assert_eq!(get(&base, Some(token.reveal()), None).await.0, 200);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_signed_in_client_fetches_the_worlds_kinds_text() {
    let dir = std::env::temp_dir().join(format!("gatewayd-kinds-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("entries")).unwrap();
    std::fs::write(
        dir.join("entries/eden.bench.json"),
        r#"{"format":"souls-entry/1","kind":"eden:bench","owner":"thing"}"#,
    )
    .unwrap();
    let soul = Grant::Actor(Actor::Soul(Id::new(Scope([0xc5; 16]), 1).unwrap()));
    let token = Token::issue(soul).unwrap();
    let tokens = Tokens::read(&Tokens::line(soul, &token.hash())).unwrap();
    let log: Log = Arc::new(|_| {});
    let gw = Gateway::with_receipts(tokens, vec![0x12, 0x20], log, Receipts::off());
    let _ = gw.entries.set(Entries::open(&dir.join("entries")).unwrap());
    let base = serve(gw).await;
    let at = |auth, tag| get_at(KINDS_PATH, &base, auth, tag);

    let (status, _, body) = at(Some(token.reveal()), None).await;
    assert_eq!(
        (status, body),
        (404, br#"{"refused":"kinds-not-served"}"#.to_vec()),
        "not written yet"
    );
    let text = "{1: \"eden:bench\", 2: \"thing\"}\n";
    std::fs::write(dir.join("world.kinds"), text).unwrap();
    assert_eq!(at(None, None).await.0, 401, "no token");
    let (status, head, body) = at(Some(token.reveal()), None).await;
    assert_eq!(status, 200);
    assert!(head.contains("content-encoding: gzip"));
    let raw = miniz_oxide::inflate::decompress_to_vec(&body[10..body.len() - 8]).unwrap();
    assert_eq!(raw, text.as_bytes());
    let tag = head
        .lines()
        .find_map(|l| l.strip_prefix("etag: "))
        .unwrap()
        .to_owned();
    assert_eq!(at(Some(token.reveal()), Some(&tag)).await.0, 304);
    std::fs::write(
        dir.join("world.kinds"),
        format!("{text}# souls-boot-body eden:bench\n"),
    )
    .unwrap();
    assert_eq!(
        at(Some(token.reveal()), Some(&tag)).await.0,
        200,
        "a restart's new text is sent"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
