//! The list and create over HTTP (W3), on W1's listener ([`crate::accounts::serve`]):
//!
//! - `GET /v1/worlds`: the list (one request, cacheable for a few seconds, the same for everyone).
//! - `POST /v1/worlds` with `{"key", "name", "template", "label"}`, signed in as W1's session request is: a provider
//!   token as `Authorization: Bearer <token>`, or, with the sign-in for test worlds on, `Bearer test:<name>`.
//!   Answers `{"world": {...}}`, or `{"refused", "detail"}`; a limit's refusal (429) adds `limit` and `retry_after`.

use serde_json::{Value, json};

use super::Ask;
use crate::accounts::correlate;
use crate::accounts::serve::{App, Request, now};
use crate::accounts::start::TEST_ISSUER;

/// The list's cache rule: the same answer for everyone, for a few seconds.
pub const CACHE: &str = "public, max-age=5";

pub fn route(req: &Request, app: &App) -> (u16, Value, String) {
    let refuse = |status, name: &str| (status, json!({"refused": name}), name.to_string());
    let Some(worlds) = &app.worlds else {
        return refuse(404, "no-worlds");
    };
    if req.method == "GET" {
        return match worlds.list() {
            Ok(v) => (200, v, "list".into()),
            Err(e) => refuse(503, e.name),
        };
    }
    let Some(bearer) = &req.bearer else {
        return refuse(401, "token-missing");
    };
    let (issuer, subject) = match (bearer.strip_prefix("test:"), &app.verifier) {
        (Some(n), _) if app.test_sign_in => (TEST_ISSUER.to_string(), n.to_string()),
        (_, Some(v)) => match v.verify(bearer, now()) {
            Ok(s) => (s.issuer, s.subject),
            Err(r) => return refuse(401, r.name()),
        },
        _ => return refuse(401, "no-provider"),
    };
    let Ok(account) = app.store.sign_in(&issuer, &subject, now()) else {
        return refuse(500, "store");
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
