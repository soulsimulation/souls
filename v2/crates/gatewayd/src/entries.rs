//! The world's kind entries for its paired clients (#3760). `gatewayd --entries <dir>` (the world's own
//! `<world>/entries`, as `worldd seed` wrote them) serves `GET /v2/entries`: every `souls-entry/1` file under the
//! folder, as one JSON array in path order, gzip-encoded, with its SHA-256 as a strong `ETag`. A client sends its
//! stored tag as `If-None-Match` and gets 304 while the entries are unchanged, so it fetches them once per change.
//!
//! It is signed in like the stream: `Authorization: Bearer <token>` with a token of the tokens file (read again if it
//! changed, so a client fetching straight after its pairing is known); a page's view token is refused. Entries hold the world's rules (forms, slots, geometry, cards), not anything private.
//!
//! The folder is read at start (an unreadable folder, or one without an entry, stops the gateway) and again at a
//! request whenever its files' names, sizes or times changed, so a world given new entries serves them without a
//! restart. If a re-read fails, the last good array is served.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use replica::encode::to_hex;
use replica::ids::sha256;
use replica::rules::json;

use crate::Gateway;
use crate::token::Token;

/// Where clients fetch the entries.
pub const PATH: &str = "/v2/entries";

/// The entries as served: gzip bytes, their tag and how many entries.
pub struct Built {
    pub gz: Vec<u8>,
    pub etag: String,
    pub count: usize,
}

/// One file's name, size and modification time: the folder's fingerprint is the list of them.
type Stamp = (PathBuf, u64, Option<SystemTime>);

/// The folder and what was last built from it.
pub struct Entries {
    dir: PathBuf,
    held: Mutex<(Vec<Stamp>, Arc<Built>)>,
}

impl Entries {
    /// Reads the folder; an error names why it cannot be served (the gateway refuses to start).
    pub fn open(dir: &Path) -> Result<Entries, String> {
        let stamps = stamps(dir)?;
        let built = build(&stamps)?;
        Ok(Entries {
            dir: dir.to_owned(),
            held: Mutex::new((stamps, Arc::new(built))),
        })
    }

    /// The current array, re-read when the folder changed since the last build.
    pub fn current(&self) -> Arc<Built> {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(now) = stamps(&self.dir)
            && now != held.0
            && let Ok(b) = build(&now)
        {
            *held = (now, Arc::new(b));
        }
        held.1.clone()
    }
}

fn stamps(dir: &Path) -> Result<Vec<Stamp>, String> {
    let mut out = Vec::new();
    walk(dir, &mut out).map_err(|e| format!("{}: {e}", dir.display()))?;
    out.sort();
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<Stamp>) -> std::io::Result<()> {
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        let (p, m) = (e.path(), e.metadata()?);
        if m.is_dir() {
            walk(&p, out)?;
        } else if p.extension().is_some_and(|x| x == "json") {
            out.push((p, m.len(), m.modified().ok()));
        }
    }
    Ok(())
}

fn build(stamps: &[Stamp]) -> Result<Built, String> {
    let mut raw = String::from("[");
    let mut count = 0;
    for (p, _, _) in stamps {
        let text = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
        let Ok(v) = json::parse(&text) else { continue };
        if v.get("format").and_then(json::Value::str) != Some("souls-entry/1") {
            continue;
        }
        if count > 0 {
            raw.push(',');
        }
        raw.push_str(text.trim());
        count += 1;
    }
    raw.push(']');
    if count == 0 {
        return Err("no souls-entry/1 file".into());
    }
    Ok(Built {
        etag: format!("\"{}\"", to_hex(&sha256(raw.as_bytes()))),
        gz: gzip(raw.as_bytes()),
        count,
    })
}

/// RFC 1952: a 10-byte header, the deflate stream, CRC-32 and size.
fn gzip(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255];
    out.extend(miniz_oxide::deflate::compress_to_vec(data, 6));
    out.extend(crc32(data).to_le_bytes());
    out.extend((data.len() as u32).to_le_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = !0u32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = (c >> 1) ^ (0xEDB8_8320 & (c & 1).wrapping_neg());
        }
    }
    !c
}

fn refuse(status: StatusCode, name: &str) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        format!("{{\"refused\":\"{name}\"}}"),
    )
        .into_response()
}

/// `GET /v2/entries`.
pub async fn serve(State(gw): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    let Some(entries) = gw.entries.get() else {
        return refuse(StatusCode::NOT_FOUND, "entries-not-served");
    };
    // As a sign-in does (C3): a token paired a moment ago is in the file before the 2 s re-read.
    if let Some(f) = gw.tokens_file.get() {
        f.refresh(&gw.tokens);
    }
    let signed_in = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| Token::parse(t.trim()))
        .is_some_and(|t| {
            gw.tokens
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .check(&t)
                .is_some()
        });
    if !signed_in {
        return refuse(StatusCode::UNAUTHORIZED, "token.refused");
    }
    let built = entries.current();
    let tag =
        HeaderValue::from_str(&built.etag).unwrap_or_else(|_| HeaderValue::from_static("\"\""));
    let cache = HeaderValue::from_static("private, no-cache");
    if headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|v| v.as_bytes() == built.etag.as_bytes())
    {
        return (
            StatusCode::NOT_MODIFIED,
            [(header::ETAG, tag), (header::CACHE_CONTROL, cache)],
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (header::CONTENT_ENCODING, HeaderValue::from_static("gzip")),
            (header::ETAG, tag),
            (header::CACHE_CONTROL, cache),
        ],
        built.gz.clone(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_is_ieee() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn builds_an_array_of_entries_only_and_rereads_a_change() {
        let dir = std::env::temp_dir().join(format!("gatewayd-entries-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        assert!(Entries::open(&dir).is_err(), "an empty folder is refused");
        std::fs::write(
            dir.join("a.json"),
            r#"{"format":"souls-entry/1","kind":"x:a"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("sub/b.json"),
            r#"{"format":"souls-entry/1","kind":"x:b"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("c.json"), r#"{"format":"other"}"#).unwrap();
        let e = Entries::open(&dir).unwrap();
        let first = e.current();
        assert_eq!(first.count, 2);
        let raw =
            miniz_oxide::inflate::decompress_to_vec(&first.gz[10..first.gz.len() - 8]).unwrap();
        assert_eq!(
            String::from_utf8(raw).unwrap(),
            r#"[{"format":"souls-entry/1","kind":"x:a"},{"format":"souls-entry/1","kind":"x:b"}]"#
        );
        assert_eq!(e.current().etag, first.etag, "unchanged: the same tag");
        std::fs::write(
            dir.join("d.json"),
            r#"{"format":"souls-entry/1","kind":"x:d"}"#,
        )
        .unwrap();
        assert_eq!(
            e.current().count,
            3,
            "a new file is served without a restart"
        );
        assert_ne!(e.current().etag, first.etag);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
