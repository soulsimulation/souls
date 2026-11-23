//! A creator's uploads through the gateway (#3697, `uploads.rs`): a picture checked in the child, stripped of its
//! metadata and allowed, then served by its hash; a file that is not one refused by its check's name; a Soul's token
//! refused; and, with every upload held for review, a held upload answered `held` and never served.

use std::sync::Arc;

use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::uploads::{PATH, Uploads};
use gatewayd::{Gateway, Log, socket};
use miniz_oxide::deflate::compress_to_vec_zlib;
use replica::effects::Actor;
use replica::ids::{Id, Scope};

/// The `assets-check` program: `ASSETS_CHECK`, else this build's, built when missing.
fn checker() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("ASSETS_CHECK") {
        return p.into();
    }
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap().to_owned();
    let program = dir.join("assets-check");
    if !program.is_file() {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.args(["build", "-p", "assets", "--bin", "assets-check"]);
        if dir.file_name().is_some_and(|n| n == "release") {
            cmd.arg("--release");
        }
        assert!(cmd.status().unwrap().success(), "assets-check builds");
    }
    program
}

fn crc32(b: &[u8]) -> u32 {
    let mut c = !0u32;
    for &x in b {
        c ^= x as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

fn chunk(out: &mut Vec<u8>, ty: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(ty);
    out.extend_from_slice(data);
    let c = crc32(&out[start..]);
    out.extend_from_slice(&c.to_be_bytes());
}

/// An 8 by 8 RGBA PNG whose tEXt chunk carries `text`.
fn png(text: &str) -> Vec<u8> {
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&8u32.to_be_bytes());
    ihdr.extend_from_slice(&8u32.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"tEXt", text.as_bytes());
    chunk(&mut out, b"IDAT", &compress_to_vec_zlib(&[0u8; 8 * 33], 9));
    chunk(&mut out, b"IEND", &[]);
    out
}

/// One request; the status, the headers' text (lower case) and the body.
async fn http(
    base: &str,
    method: &str,
    path: &str,
    auth: Option<&str>,
    body: &[u8],
) -> (u16, String, Vec<u8>) {
    let mut s = tokio::net::TcpStream::connect(base).await.unwrap();
    let auth = auth.map_or(String::new(), |t| format!("authorization: Bearer {t}\r\n"));
    let head = format!(
        "{method} {path} HTTP/1.1\r\nhost: {base}\r\n{auth}content-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    tokio::io::AsyncWriteExt::write_all(&mut s, head.as_bytes())
        .await
        .unwrap();
    tokio::io::AsyncWriteExt::write_all(&mut s, body)
        .await
        .unwrap();
    let mut out = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut s, &mut out)
        .await
        .unwrap();
    let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&out[..split]).to_lowercase();
    let mut body = out[split + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") {
        // One chunk is enough for these small answers: its size line, its bytes.
        let line = body.windows(2).position(|w| w == b"\r\n").unwrap();
        let n = usize::from_str_radix(std::str::from_utf8(&body[..line]).unwrap(), 16).unwrap();
        body = body[line + 2..line + 2 + n].to_vec();
    }
    (head[9..12].parse().unwrap(), head, body)
}

fn field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let rest = json.split_once(&format!("\"{key}\":\""))?.1;
    Some(rest.split_once('"')?.0)
}

/// A gateway taking uploads into `dir` (every one held with `hold`), with a creator's and a Soul's tokens.
async fn gateway(tag: &str, hold: bool) -> (String, Token, Token, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("gatewayd-uploads-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let creator = Grant::Actor(Actor::Creator(Id::new(Scope([0xc0; 16]), 1).unwrap()));
    let soul = Grant::Actor(Actor::Soul(Id::new(Scope([0x50; 16]), 1).unwrap()));
    let (ct, st) = (Token::issue(creator).unwrap(), Token::issue(soul).unwrap());
    let lines = format!(
        "{}\n{}\n",
        Tokens::line(creator, &ct.hash()).trim_end(),
        Tokens::line(soul, &st.hash()).trim_end()
    );
    let log: Log = Arc::new(|_| {});
    let gw = Gateway::with_receipts(
        Tokens::read(&lines).unwrap(),
        vec![0x12, 0x20],
        log,
        Receipts::off(),
    );
    let _ = gw
        .uploads
        .set(Uploads::open(&dir, checker(), hold).unwrap());
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = tcp.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(tcp, socket::router(gw)).into_future());
    (base, ct, st, dir)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_creator_uploads_a_picture_it_is_stripped_allowed_and_served_by_hash() {
    let (base, creator, soul, dir) = gateway("allow", false).await;
    let file = png("GPSLatitude 52.52 N, the camera's owner");

    assert_eq!(
        http(&base, "POST", PATH, None, &file).await.0,
        401,
        "no token"
    );
    assert_eq!(
        http(&base, "POST", PATH, Some(soul.reveal()), &file)
            .await
            .0,
        401,
        "a Soul's token"
    );

    let (status, _, body) = http(&base, "POST", PATH, Some(creator.reveal()), &file).await;
    let answer = String::from_utf8(body).unwrap();
    println!("upload: {status} {answer}");
    assert_eq!(status, 200, "{answer}");
    assert_eq!(field(&answer, "state"), Some("allowed"));
    assert_eq!(field(&answer, "format"), Some("png"));
    let hash = field(&answer, "hash").unwrap().to_owned();
    assert!(hash.starts_with("1220") && hash.len() == 68, "{hash}");

    let (status, head, served) =
        http(&base, "GET", &format!("/v2/uploads/{hash}"), None, &[]).await;
    assert_eq!(status, 200);
    assert!(head.contains("content-type: image/png"), "{head}");
    assert!(head.contains("immutable"), "{head}");
    assert!(served.starts_with(b"\x89PNG"));
    assert!(
        !served.windows(11).any(|w| w == b"GPSLatitude"),
        "the metadata is stripped"
    );
    assert!(served.len() < file.len());
    assert!(
        dir.join(&hash).is_file(),
        "kept by hash, so it outlasts a restart"
    );

    // Not one of the three formats: refused by the check's own name, and nothing kept.
    let (status, _, body) = http(&base, "POST", PATH, Some(creator.reveal()), b"not a model").await;
    let answer = String::from_utf8(body).unwrap();
    assert_eq!(status, 422, "{answer}");
    assert_eq!(field(&answer, "refused"), Some("upload.format"), "{answer}");
    // Only a hash names a served file.
    assert_eq!(
        http(&base, "GET", "/v2/uploads/..%2Fx", None, &[]).await.0,
        404
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_held_upload_is_answered_held_and_never_served() {
    let (base, creator, _, dir) = gateway("hold", true).await;
    let (status, _, body) = http(
        &base,
        "POST",
        PATH,
        Some(creator.reveal()),
        &png("a picture"),
    )
    .await;
    let answer = String::from_utf8(body).unwrap();
    println!("held upload: {status} {answer}");
    assert_eq!(status, 200, "{answer}");
    assert_eq!(field(&answer, "state"), Some("held"));
    assert!(field(&answer, "reason").is_some_and(|r| r.contains("review")));
    let hash = field(&answer, "hash").unwrap();
    assert_eq!(
        http(&base, "GET", &format!("/v2/uploads/{hash}"), None, &[])
            .await
            .0,
        404,
        "a held upload is not served"
    );
    assert!(
        dir.join("held").join(hash).is_file(),
        "kept apart for review"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
