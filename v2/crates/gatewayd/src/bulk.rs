//! A creator's bulk edit (#3695): `POST /v2/creator-edit` with `Authorization: Bearer <creator token>` and the edit
//! intent's bytes as the body, for an edit over the agents' frame limit (a landform's ground tiles, and later an
//! imported world's parts and an upload). A Soul's intents keep the socket's limit (`intent_limits.txt`).
//!
//! - **Who:** a creator's token of the tokens file, and the intent names that creator as its actor
//!   (`intent-not-granted`); a Soul's token or none is refused `token.refused` (401).
//! - **Its own limit:** the body is read up to [`intents::BULK_MOST`] bytes and decoded by
//!   `intent_decode::decode_bulk`, which reads only a creator's edit over the frame limit (`intent.too-large`).
//! - **Then as any intent:** handed to the world on the link and answered once, on the creator's signed-in socket, as
//!   the socket's intents are (a refusal the gateway gives itself is answered there too). The HTTP answer only says
//!   it was taken: `202 {"sent": true}`, or `4xx {"refused": "<name>"}` for what was never sent.
//! - **Its own gauge:** edits taken, refused and bytes taken, and the largest, in [`Gauge`], logged with each edit.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use replica::effects::Actor;
use replica::intent_decode::decode_bulk;
use replica::intents;

use crate::Gateway;
use crate::token::{Grant, Token};
use crate::world_link::Sent;

/// Where a creator sends a bulk edit.
pub const PATH: &str = "/v2/creator-edit";

/// The body limit the route is mounted with: the bulk limit, and a little for nothing else.
pub fn limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(usize::try_from(intents::BULK_MOST).unwrap_or(usize::MAX))
}

/// The route's own counts.
#[derive(Default)]
pub struct Gauge {
    pub taken: AtomicU64,
    pub refused: AtomicU64,
    pub bytes: AtomicU64,
    pub largest: AtomicU64,
}

impl Gauge {
    fn line(&self) -> String {
        format!(
            "bulk edits taken {} refused {} bytes {} largest {}",
            self.taken.load(Ordering::Relaxed),
            self.refused.load(Ordering::Relaxed),
            self.bytes.load(Ordering::Relaxed),
            self.largest.load(Ordering::Relaxed)
        )
    }
}

fn refuse(gw: &Gateway, status: StatusCode, name: &str) -> Response {
    gw.bulk.refused.fetch_add(1, Ordering::Relaxed);
    (gw.log)(&format!(
        "gatewayd: bulk edit refused {name}; {}",
        gw.bulk.line()
    ));
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        format!("{{\"refused\":\"{name}\"}}"),
    )
        .into_response()
}

/// `POST /v2/creator-edit`.
pub async fn submit(State(gw): State<Arc<Gateway>>, headers: HeaderMap, body: Bytes) -> Response {
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
    let Some(grant @ Grant::Actor(actor @ Actor::Creator(_))) = grant else {
        return refuse(&gw, StatusCode::UNAUTHORIZED, "token.refused");
    };
    let received = crate::times::stamp();
    let intent = match decode_bulk(&body) {
        Ok(i) => i,
        Err(r) => return refuse(&gw, StatusCode::BAD_REQUEST, r.name),
    };
    if intent.actor != actor {
        return refuse(&gw, StatusCode::FORBIDDEN, "intent-not-granted");
    }
    if let Some(reason) = crate::uploads::edit_refusal(&gw, &intent) {
        return refuse(&gw, StatusCode::UNPROCESSABLE_ENTITY, reason); // I2, as on the socket
    }
    let left = intent.expiry.saturating_sub(crate::socket::unix_us());
    let size = u64::try_from(body.len()).unwrap_or(u64::MAX);
    match gw.link.submit(
        grant.key(),
        actor,
        intent.sequence,
        body.to_vec(),
        received,
        left,
    ) {
        Sent::Sent => {
            gw.bulk.taken.fetch_add(1, Ordering::Relaxed);
            gw.bulk.bytes.fetch_add(size, Ordering::Relaxed);
            gw.bulk.largest.fetch_max(size, Ordering::Relaxed);
            (gw.log)(&format!(
                "gatewayd: bulk edit {size} bytes sent; {}",
                gw.bulk.line()
            ));
            (
                StatusCode::ACCEPTED,
                [(header::CACHE_CONTROL, "no-store")],
                "{\"sent\":true}",
            )
                .into_response()
        }
        Sent::Restarting => refuse(&gw, StatusCode::SERVICE_UNAVAILABLE, "world.restarting"),
    }
}
