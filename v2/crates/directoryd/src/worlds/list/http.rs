//! The list and create over HTTP (W3), on W1's listener ([`crate::accounts::serve`]):
//!
//! - `GET /v1/worlds`: the list (one request, cacheable for a few seconds, the same for everyone).
//! - `POST /v1/worlds` with `{"key", "name", "template", "label"}`, signed in as W1's session request is: a provider
//!   token as `Authorization: Bearer <token>`, or, with the sign-in for test worlds on, `Bearer test:<name>`.
//!   Answers `{"world": {...}}`, or `{"refused", "detail"}`; a limit's refusal (429) adds `limit` and `retry_after`.
//! - `POST /v1/worlds/settings` with `{"world", "unlisted"?, "closed"?}`, signed in the same way as the world's creator
//!   (W9, #2827): answers `{"world": {...}}`, the row as set; with neither switch, the row as it is.

use serde_json::{Value, json};

use super::Ask;
use crate::accounts::correlate;
use crate::accounts::serve::{App, Request, now};
use crate::accounts::start::TEST_ISSUER;
use crate::accounts::store::Account;

/// The list's cache rule: the same answer for everyone, for a few seconds.
pub const CACHE: &str = "public, max-age=5";

type Answer = (u16, Value, String);

fn refuse(status: u16, name: &str) -> Answer {
    (status, json!({"refused": name}), name.to_string())
}

/// The signed-in account: a provider token as `Authorization: Bearer <token>`, or `Bearer test:<name>` with the
/// sign-in for test worlds on.
fn signed_in(req: &Request, app: &App) -> Result<Account, Answer> {
    let Some(bearer) = &req.bearer else {
        return Err(refuse(401, "token-missing"));
    };
    let (issuer, subject) = match (bearer.strip_prefix("test:"), &app.verifier) {
        (Some(n), _) if app.test_sign_in => (TEST_ISSUER.to_string(), n.to_string()),
        (_, Some(v)) => match v.verify(bearer, now()) {
            Ok(s) => (s.issuer, s.subject),
            Err(r) => return Err(refuse(401, r.name())),
        },
        _ => return Err(refuse(401, "no-provider")),
    };
    app.store
        .sign_in(&issuer, &subject, now())
        .map_err(|_| refuse(500, "store"))
}

/// `POST /v1/worlds/settings`: a world's two switches, by its creator.
pub fn settings(req: &Request, app: &App) -> Answer {
    let Some(worlds) = &app.worlds else {
        return refuse(404, "no-worlds");
    };
    let account = match signed_in(req, app) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    let world = body
        .get("world")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let switch = |k: &str| body.get(k).and_then(Value::as_bool);
    let note = format!("account#{}", correlate(&account.account));
    match worlds.settings(
        world,
        account.principal,
        switch("unlisted"),
        switch("closed"),
    ) {
        Ok(row) => (200, json!({"world": row}), note),
        Err(e) => {
            let status = match e.name {
                "world-missing" => 404,
                "not-the-creator" => 403,
                "store-unreachable" | "contended" => 503,
                _ => 409,
            };
            (
                status,
                json!({"refused": e.name}),
                format!("{note} {}", e.name),
            )
        }
    }
}

pub fn route(req: &Request, app: &App) -> Answer {
    let Some(worlds) = &app.worlds else {
        return refuse(404, "no-worlds");
    };
    if req.method == "GET" {
        return match worlds.list() {
            Ok(v) => (200, v, "list".into()),
            Err(e) => refuse(503, e.name),
        };
    }
    let account = match signed_in(req, app) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let Ok(made) = app.store.made(&account.account) else {
        return refuse(500, "store");
    };
    let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    let field = |k: &str| {
        body.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let ask = Ask {
        key: field("key"),
        name: field("name"),
        template: field("template"),
        label: field("label"),
    };
    let note = format!("account#{}", correlate(&account.account));
    match worlds.create(&ask, account.principal, made, now()) {
        Ok(v) => (200, v, note),
        Err(e) if e.name.starts_with("world-limit") => {
            let mut v: Value = serde_json::from_str(&e.detail).unwrap_or(json!({}));
            v["refused"] = json!(e.name);
            (429, v, format!("{note} {}", e.name))
        }
        Err(e) => {
            let status = match e.name {
                "store-unreachable" | "start-failed" => 503,
                _ => 409,
            };
            // A failed start's detail is the machine's (its paths): it stays in the machine's own log.
            let detail = if status == 503 { "" } else { e.detail.as_str() };
            (
                status,
                json!({"refused": e.name, "detail": detail}),
                format!("{note} {}", e.name),
            )
        }
    }
}
