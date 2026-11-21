//! A creator's uploads (0.131 parity L12, #3697): a model or a picture sent to the world through G6's check and hold
//! point (`assets`), and the allowed ones served by hash. On only with `--uploads <dir>`.
//!
//! - **`POST /v2/creator-upload`** with `Authorization: Bearer <creator token>` and the file (GLB, PNG or JPEG) as the
//!   body, at most [`BODY_MOST`] bytes. A Soul's token or none is refused `token.refused` (401). The file is checked
//!   in a child process (`assets-check`, beside this program unless `--assets-check <path>`), stripped of metadata
//!   and passed through the hold point, as `assets::store::Store::upload` does. The answer is `200 {"hash":
//!   "1220<64 hex>", "state": "allowed" | "held", "format": "glb" | "png" | "jpeg", "bytes": n}` (a held upload's
//!   `reason` too), the hash being `souls/upload/1` over the stripped bytes; a refusal is `422 {"refused":
//!   "upload.<name>", "detail": ..}`, and nothing is kept.
//! - **Kept by hash:** an allowed upload's bytes in `<dir>/<hash>`, a held one's in `<dir>/held/<hash>`, so they
//!   outlast a restart. Releasing or removing a held upload is W9's.
//! - **`GET /v2/uploads/<hash>`** serves an allowed upload's bytes, with their type and a year's immutable caching
//!   (the bytes are their hash's); held, removed or unknown is 404. No sign-in: a page draws what a world shows.
//! - **One at a time:** checks run on a blocking thread, one upload at a time per gateway, each logged with its size,
//!   time and outcome, never its bytes.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use assets::child::Checker;
use assets::store::{State as Kept, Store};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use replica::effects::Actor;
use replica::encode::to_hex;
use replica::ids::{Minter, Scope};

use crate::Gateway;
use crate::token::{Grant, Token};

/// Where a creator uploads.
pub const PATH: &str = "/v2/creator-upload";
/// Where an allowed upload is served, by its hash.
pub const SERVE: &str = "/v2/uploads/{hash}";
/// The largest body read: today's 3 MB model limit and a little.
pub const BODY_MOST: usize = 3_100_000;

/// The uploads of this gateway's world.
pub struct Uploads {
    dir: PathBuf,
    store: Mutex<Store>,
}

impl Uploads {
    /// Uploads kept in `dir` (made if missing), checked by the `assets-check` program at `program`; with `hold`, every
    /// upload is held for review ([`HoldAll`]) instead of passing the shipped classifier, which allows.
    pub fn open(dir: &Path, program: PathBuf, hold: bool) -> Result<Uploads, String> {
        std::fs::create_dir_all(dir.join("held")).map_err(|e| format!("{}: {e}", dir.display()))?;
        if !program.is_file() {
            return Err(format!("no assets-check at {}", program.display()));
        }
        // The store's references are not kept: a page names an upload by its hash (#3697).
        let minter = Minter::new(Scope([0x55; 16]));
        let creator = replica::ids::Id::new(Scope([0; 16]), 1).ok_or("an id")?;
        let mut store = Store::new(creator, minter, Checker::new(program));
        if hold {
            store.classifier = Arc::new(HoldAll);
        }
        Ok(Uploads {
            dir: dir.to_owned(),
            store: Mutex::new(store),
        })
    }
}

/// `--uploads-hold`: every upload is held for the owner's review (W9 releases it), none served until then.
pub struct HoldAll;

impl assets::hold::Classifier for HoldAll {
    fn name(&self) -> &str {
        "hold-all"
    }

    fn classify(&self, _: &assets::check::Checked) -> Result<assets::hold::Verdict, String> {
        Ok(assets::hold::Verdict::Hold(
            "held for the owner's review".into(),
        ))
    }
}

/// The routes' body limit.
pub fn limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(BODY_MOST)
}

fn json(status: StatusCode, body: String) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

fn quoted(s: &str) -> String {
    let mut out = String::from('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn refuse(status: StatusCode, name: &str, detail: &str) -> Response {
    json(
        status,
        format!(
            "{{\"refused\":{},\"detail\":{}}}",
            quoted(name),
            quoted(detail)
        ),
    )
}

/// `POST /v2/creator-upload`.
pub async fn upload(State(gw): State<Arc<Gateway>>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(up) = gw.uploads.get() else {
        return refuse(
            StatusCode::NOT_FOUND,
            "upload.off",
            "this world takes no uploads",
        );
    };
    if let Some(f) = gw.tokens_file.get() {
        f.refresh(&gw.tokens);
    }
    let grant = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| Token::parse(t.trim()))
        .and_then(|t| {
            gw.tokens
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .check(&t)
        });
    let Some(Grant::Actor(actor @ Actor::Creator(creator))) = grant else {
        return refuse(
            StatusCode::UNAUTHORIZED,
            "token.refused",
            "a creator's token uploads",
        );
    };
    let size = body.len();
    let dir = up.dir.clone();
    let gw2 = gw.clone();
    let started = crate::times::stamp();
    let done = tokio::task::spawn_blocking(move || {
        let up = gw2.uploads.get().expect("checked above");
        let mut store = up.store.lock().unwrap_or_else(|e| e.into_inner());
        store.creator = creator;
        let receipt = store.upload(actor, &body)?;
        let record = store.record(receipt.reference).cloned();
        let bytes = store.kept(receipt.reference).map(<[u8]>::to_vec);
        Ok::<_, assets::check::Refused>((receipt, record, bytes))
    })
    .await;
    let ms = crate::times::stamp().saturating_sub(started) / 1000;
    let (receipt, record, kept) = match done {
        Ok(Ok(r)) => r,
        Ok(Err(r)) => {
            (gw.log)(&format!(
                "gatewayd: upload of {size} bytes refused {} in {ms} ms",
                r.code
            ));
            return refuse(StatusCode::UNPROCESSABLE_ENTITY, r.code, &r.detail);
        }
        Err(_) => {
            return refuse(
                StatusCode::INTERNAL_SERVER_ERROR,
                "upload.failed",
                "the check stopped",
            );
        }
    };
    let hash = to_hex(&receipt.hash.to_bytes());
    let (state, reason, path, bytes) = match (&receipt.state, kept) {
        (Kept::Allowed, Some(b)) => ("allowed", None, dir.join(&hash), b),
        (Kept::Held(why), Some(b)) => ("held", Some(why.clone()), dir.join("held").join(&hash), b),
        _ => {
            return refuse(
                StatusCode::INTERNAL_SERVER_ERROR,
                "upload.failed",
                "the upload was not kept",
            );
        }
    };
    if let Err(e) = write_once(&path, &bytes) {
        (gw.log)(&format!("gatewayd: upload {hash} not kept: {e}"));
        return refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "upload.not-kept",
            "the upload could not be kept",
        );
    }
    let format = record.map_or("", |r| r.format.name());
    (gw.log)(&format!(
        "gatewayd: upload of {size} bytes {state} as {hash} ({format}, {} bytes) in {ms} ms",
        bytes.len()
    ));
    json(
        StatusCode::OK,
        format!(
            "{{\"hash\":\"{hash}\",\"state\":\"{state}\",\"format\":\"{format}\",\"bytes\":{}{}}}",
            bytes.len(),
            reason.map_or(String::new(), |r| format!(",\"reason\":{}", quoted(&r)))
        ),
    )
}

/// Writes `bytes` to `path` through a temporary file, once: bytes kept under their hash never change.
fn write_once(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if path.is_file() {
        return Ok(());
    }
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// The type a stored upload is served with, from its first bytes (the check allowed only these three).
fn content_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"glTF") {
        "model/gltf-binary"
    } else if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        "image/jpeg"
    } else {
        "application/octet-stream"
    }
}

/// `GET /v2/uploads/<hash>`.
pub async fn serve(State(gw): State<Arc<Gateway>>, UrlPath(hash): UrlPath<String>) -> Response {
    let Some(up) = gw.uploads.get() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Only a hash names a file here: `1220` and 64 lowercase hex digits.
    if hash.len() != 68
        || !hash.starts_with("1220")
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = up.dir.join(&hash);
    match tokio::task::spawn_blocking(move || std::fs::read(path)).await {
        Ok(Ok(bytes)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type(&bytes)),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            ],
            bytes,
        )
            .into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}
