//! The session exchange (Engine v2 W5, #2801; shared with V13, #2745): a page signed in with W1's session gets a
//! short token for the world's one creator, so a browser holds the creator's socket without the creator's agent.
//!
//! `POST /v2/creator-token` with `Authorization: Bearer <session>`: W1's session as the page holds it (a provider's
//! token, or `test:<name>` where the directory has the sign-in for test worlds on). The gateway asks the directory who
//! that is (`POST /v1/account/session`, or `/v1/account/test-sign-in`), so the directory alone checks a session. If
//! the account's principal is this world's creator (`--creator`), the answer is `{"token", "grant", "expires_in"}`: a
//! new token for the creator's grant, its hash alone stored, revoked after [`LIFETIME`]. Anyone else is refused
//! `not-the-creator` (403); a session the directory refuses, `session-refused` (401). The token is never logged, and
//! the answer is never cached. A socket already signed in keeps its sign-in when its token lapses; the page exchanges
//! again to sign in again.
//!
//! The creator's helpers (#3727, today's `build claim --helper`): `POST /v2/creator-helper[?minutes=n]` with
//! `Authorization: Bearer <the creator's own token>` answers `{"token", "grant", "helper", "expires_in"}`: a token for
//! a new creator-scope actor of the creator's (`helper`, `<scope hex>-<counter>`), revoked after `minutes` (default
//! 120, 1 to 720). The gateway lets it sign in while it lives; the world lets it edit only when a live claim names it
//! as that claim's helper and the edit is sent under that claim (`replica::edit::claims`), so the creator names it on
//! a claim next. A helper cannot ask for a helper, and an undo is the creator's alone. At most [`HELPERS_MOST`] live.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use replica::effects::Actor;
use replica::encode::to_hex;
use replica::ids::Id;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::Gateway;
use crate::token::{CreatorMark, Grant, Token};

/// Where a page exchanges its session.
pub const PATH: &str = "/v2/creator-token";
/// How long an exchanged token signs in.
pub const LIFETIME: Duration = Duration::from_secs(15 * 60);
/// Where the creator asks for a helper's token (#3727).
pub const HELPER_PATH: &str = "/v2/creator-helper";
/// A helper token's lifetime, minutes: by default, and at most (today's helper limits).
pub const HELPER_MINUTES: u64 = 120;
pub const HELPER_MINUTES_MOST: u64 = 720;
/// The most helpers live at once (today's per-world limit).
pub const HELPERS_MOST: usize = 64;
/// The longest answer read from the directory.
const ANSWER_MOST: u64 = 16 << 10;

/// The world's one creator, and the directory that checks sessions (`host:port`).
pub struct Exchange {
    pub creator: Id,
    pub directory: String,
    pub authority_required: bool,
}

/// A principal as the directory writes it: `<scope hex>:<counter>`.
pub fn principal_text(id: Id) -> String {
    format!("{}:{}", to_hex(&id.scope().0), id.counter())
}

/// The principal in the directory's sign-in answer `{"account": .., "principal": ".."}`, read without parsing JSON:
/// the value is hex, a colon and digits.
pub fn read_principal(body: &str) -> Option<&str> {
    let rest = body.split_once("\"principal\":\"")?.1;
    let p = rest.split_once('"')?.0;
    p.bytes()
        .all(|b| b.is_ascii_hexdigit() || b == b':')
        .then_some(p)
}

/// Who a session is, by the directory: the principal's text, or the refusal's name.
async fn who(directory: &str, session: &str) -> Result<String, &'static str> {
    // The sign-in for test worlds takes a name; the directory refuses it unless it is on.
    let (path, auth, body) = match session.strip_prefix("test:") {
        Some(name)
            if (1..=64).contains(&name.len())
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_. ".contains(&b)) =>
        {
            (
                "/v1/account/test-sign-in",
                String::new(),
                format!("{{\"name\":\"{name}\"}}"),
            )
        }
        Some(_) => return Err("session-refused"),
        None if session.bytes().all(|b| b.is_ascii_graphic()) => (
            "/v1/account/session",
            format!("authorization: Bearer {session}\r\n"),
            String::new(),
        ),
        None => return Err("session-refused"),
    };
    let unreachable = "directory-unreachable";
    let mut s = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(directory))
        .await
        .map_err(|_| unreachable)?
        .map_err(|_| unreachable)?;
    let req = format!(
        "POST {path} HTTP/1.1\r\nhost: {directory}\r\n{auth}content-type: application/json\r\ncontent-length: {}\r\n\
         connection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.map_err(|_| unreachable)?;
    let mut out = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(5),
        s.take(ANSWER_MOST).read_to_end(&mut out),
    )
    .await
    .map_err(|_| unreachable)?
    .map_err(|_| unreachable)?;
    let text = String::from_utf8(out).map_err(|_| unreachable)?;
    let (head, body) = text.split_once("\r\n\r\n").ok_or(unreachable)?;
    if !head.starts_with("HTTP/1.1 200") {
        return Err("session-refused");
    }
    read_principal(body)
        .map(str::to_owned)
        .ok_or("session-refused")
}

fn answer(status: StatusCode, body: String) -> Response {
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

fn refuse(status: StatusCode, name: &str) -> Response {
    answer(status, format!("{{\"refused\":\"{name}\"}}"))
}

/// The current exact-world authority, including its monotonic generation.
pub fn current_mark(gw: &Gateway) -> Option<CreatorMark> {
    let ex = gw.exchange.get()?;
    match gw.tokens_file.get() {
        Some(source) => source
            .creator(&gw.tokens, ex.creator, ex.authority_required)
            .ok(),
        None if !ex.authority_required => Some(CreatorMark {
            generation: 0,
            owner: Some(ex.creator),
        }),
        None => None,
    }
}

/// Whether `id` is a live helper's actor (#3727).
pub fn is_helper(gw: &Gateway, id: Id) -> bool {
    gw.helpers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&id)
}

/// Capture at sign-in; an idle socket cannot regain authority on an A → B → A handoff.
pub fn session(gw: &Gateway, actor: Actor) -> Result<Option<CreatorMark>, &'static str> {
    if gw.exchange.get().is_none() {
        return Ok(None);
    }
    match actor {
        // A helper holds the authority it was minted under; it lapses with it, or when revoked.
        Actor::Creator(id) if is_helper(gw, id) => current_mark(gw)
            .filter(|m| m.owner.is_some())
            .map(Some)
            .ok_or(crate::token::REFUSED),
        Actor::Creator(id) => current_mark(gw)
            .filter(|m| m.owner == Some(id))
            .map(Some)
            .ok_or(crate::token::REFUSED),
        _ => Ok(None),
    }
}

pub fn permits(gw: &Gateway, actor: Actor, captured: Option<CreatorMark>) -> bool {
    match actor {
        Actor::Creator(_) if gw.exchange.get().is_some() => {
            captured.is_some() && session(gw, actor) == Ok(captured)
        }
        _ => true,
    }
}

/// The exchange's route.
pub async fn exchange(State(gw): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    let Some(ex) = gw.exchange.get() else {
        return refuse(StatusCode::NOT_FOUND, "no-creator");
    };
    let Some(session) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return refuse(StatusCode::UNAUTHORIZED, "session-refused");
    };
    let principal = match who(&ex.directory, session.trim()).await {
        Ok(p) => p,
        Err(name @ "directory-unreachable") => {
            return refuse(StatusCode::SERVICE_UNAVAILABLE, name);
        }
        Err(name) => return refuse(StatusCode::UNAUTHORIZED, name),
    };
    let Some(mark) = current_mark(&gw).filter(|m| m.owner.is_some()) else {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "creator-authority-unavailable",
        );
    };
    let owner = mark.owner.expect("checked owner");
    if principal != principal_text(owner) {
        (gw.log)("a session that is not the world's creator asked for its token; refused");
        return refuse(StatusCode::FORBIDDEN, "not-the-creator");
    }
    let grant = Grant::Actor(Actor::Creator(owner));
    let Ok(token) = Token::issue(grant) else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "random-unavailable");
    };
    let hash = token.hash();
    let fallback = (!ex.authority_required).then_some(CreatorMark {
        generation: 0,
        owner: Some(ex.creator),
    });
    if !gw
        .tokens
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .add_browser(grant, hash, mark, fallback)
    {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "creator-authority-changing",
        );
    }
    let lapse = gw.clone();
    tokio::spawn(async move {
        tokio::time::sleep(LIFETIME).await;
        lapse
            .tokens
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .revoke(&hash);
    });
    (gw.log)("a creator token was issued for a signed-in session");
    answer(
        StatusCode::OK,
        format!(
            "{{\"token\":\"{}\",\"grant\":\"{}\",\"expires_in\":{}}}",
            token.reveal(),
            grant.to_text(),
            LIFETIME.as_secs()
        ),
    )
}

/// The helper route (see the module's notes).
pub async fn helper(
    State(gw): State<Arc<Gateway>>,
    axum::extract::RawQuery(query): axum::extract::RawQuery,
    headers: HeaderMap,
) -> Response {
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| Token::parse(t.trim()));
    if let Some(f) = gw.tokens_file.get() {
        f.refresh(&gw.tokens);
    }
    let grant = presented
        .as_ref()
        .and_then(|t| gw.tokens.read().unwrap_or_else(|e| e.into_inner()).check(t));
    // The creator's own token: with an exchange, the world's creator; a helper never mints a helper.
    let owner = match grant {
        Some(Grant::Actor(Actor::Creator(id))) if !is_helper(&gw, id) => id,
        _ => return refuse(StatusCode::UNAUTHORIZED, "token-refused"),
    };
    if gw.exchange.get().is_some() && session(&gw, Actor::Creator(owner)).is_err() {
        return refuse(StatusCode::FORBIDDEN, "not-the-creator");
    }
    let minutes = match query
        .as_deref()
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("minutes="))
    {
        None => HELPER_MINUTES,
        Some(m) => match m.parse::<u64>() {
            Ok(n) if (1..=HELPER_MINUTES_MOST).contains(&n) => n,
            _ => return refuse(StatusCode::BAD_REQUEST, "helper-minutes"),
        },
    };
    // A new actor of the creator's scope, its counter far above any grant a directory gives.
    let mut bytes = [0u8; 5];
    if getrandom::fill(&mut bytes).is_err() {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "random-unavailable");
    }
    let counter = (1u64 << 44) + bytes.iter().fold(0u64, |n, b| (n << 8) | u64::from(*b));
    let Some(id) = Id::new(owner.scope(), counter) else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "random-unavailable");
    };
    let grant = Grant::Actor(Actor::Creator(id));
    let Ok(token) = Token::issue(grant) else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "random-unavailable");
    };
    let hash = token.hash();
    {
        let mut helpers = gw.helpers.lock().unwrap_or_else(|e| e.into_inner());
        if helpers.len() >= HELPERS_MOST {
            return refuse(StatusCode::TOO_MANY_REQUESTS, "helper-limit");
        }
        helpers.insert(id, hash);
    }
    gw.tokens
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .add_helper(grant, hash);
    let lapse = gw.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(minutes * 60)).await;
        lapse
            .helpers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        lapse
            .tokens
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .revoke(&hash);
    });
    (gw.log)("a helper token was issued for the creator");
    answer(
        StatusCode::OK,
        format!(
            "{{\"token\":\"{}\",\"grant\":\"{}\",\"helper\":\"{}-{}\",\"expires_in\":{}}}",
            token.reveal(),
            grant.to_text(),
            to_hex(&id.scope().0),
            id.counter(),
            minutes * 60
        ),
    )
}
