//! Pairing over HTTP (W2). Bodies are JSON both ways; the card is the one HTML page.
//!
//! - `POST /v1/pair/request` `{secret_hash, device, label, soul | new: true, scope: "soul", force?}`, or a
//!   creator's `{secret_hash, device, label, creator, scope: "creator", force?}` (G7) →
//!   `{code, link, interval}`. No sign-in: the daemon asks.
//! - `POST /v1/pair/poll` `{secret}` → `{pending: "authorization_pending" | "slow_down", interval?}`,
//!   `{refused, device?}` or, once, `{token, grant}`.
//! - `GET /pair` → the approval card. It shows and changes nothing until the signed-in owner acts in it.
//! - `POST /v1/pair/show` and `POST /v1/pair/approve` `{code, confirm: true}`, signed in: W1's session token as
//!   `Authorization: Bearer`, or on a test world W1's test person as `test_person`. An approval records the Soul, and
//!   its own body for the page to follow, under the approving account (V13c), for the session exchange.
//! - `POST /v1/account/souls` → `{souls: [{soul, device}]}` and `POST /v1/account/souls/revoke` `{soul}` →
//!   `{revoked: soul}`, signed in the same way (the account page, W9 #2827).
//!
//! The log line notes a refusal's name or a short hash of the account, never a token, secret, code or name.

use super::{Ask, Poll, is_name};
use crate::accounts::correlate;
use crate::accounts::serve::{App, now};
use crate::accounts::start::TEST_ISSUER;
use crate::accounts::view::follow_of;
use replica::encode::from_hex;
use serde_json::{Value, json};

/// The approval card (`v2/web/src/pairing/card.html`).
pub const CARD: &str = include_str!("../../../../web/src/pairing/card.html");

/// A response: status, content type, body, and the log line's note.
pub type Answer = (u16, &'static str, String, String);

const JSON: &str = "application/json";

fn json(status: u16, body: Value, note: impl Into<String>) -> Answer {
    (status, JSON, body.to_string(), note.into())
}

fn refuse(status: u16, name: &str) -> Answer {
    json(status, json!({"refused": name}), name)
}

/// The signed-in account of a request, as W1 signs one in.
fn signed_in(app: &App, bearer: Option<&str>, body: &Value) -> Result<String, &'static str> {
    let (issuer, subject) = if let Some(t) = bearer {
        let v = app.verifier.as_ref().ok_or("no-provider")?;
        let s = v.verify(t, now()).map_err(|r| r.name())?;
        (s.issuer, s.subject)
    } else {
        match body.get("test_person").and_then(Value::as_str) {
            Some(n)
                if app.test_sign_in
                    && (1..=64).contains(&n.len())
                    && n.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_. ".contains(&b)) =>
            {
                (TEST_ISSUER.to_string(), n.to_string())
            }
            _ => return Err("signed-out"),
        }
    };
    app.store
        .sign_in(&issuer, &subject, now())
        .map(|a| a.account)
        .map_err(|_| "store")
}

/// Answers a pairing request, or `None` if the path is not one of pairing's.
pub fn route(
    app: &App,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: &[u8],
) -> Option<Answer> {
    let p = app.pairing.as_ref()?;
    let body = || serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let text = |b: &Value, k: &str| b.get(k).and_then(Value::as_str).map(str::to_string);
    Some(match (method, path) {
        ("GET", "/pair") => (
            200,
            "text/html; charset=utf-8",
            CARD.to_string(),
            "card".into(),
        ),
        ("POST", "/v1/pair/request") => {
            let b = body();
            let secret_hash: Option<[u8; 32]> = text(&b, "secret_hash")
                .and_then(|h| from_hex(&h).ok())
                .and_then(|h| h.try_into().ok());
            let new = b.get("new").and_then(Value::as_bool) == Some(true);
            // A creator's request names its grant as `creator` (G7); a Soul's as `soul`.
            let soul = text(&b, "soul").or_else(|| text(&b, "creator"));
            let (Some(secret_hash), Some(device), Some(label)) =
                (secret_hash, text(&b, "device"), text(&b, "label"))
            else {
                return Some(refuse(400, "request"));
            };
            if new == soul.is_some() || !is_name(&device) || !is_name(&label) {
                return Some(refuse(400, "request"));
            }
            let ask = Ask {
                secret_hash,
                device,
                label,
                soul,
                scope: text(&b, "scope").unwrap_or_else(|| "soul".into()),
                force: b.get("force").and_then(Value::as_bool) == Some(true),
            };
            match p.ask(&ask, now()) {
                Ok(a) => json(
                    200,
                    json!({"code": a.code, "link": format!("{}/pair?code={}", p.public_url, a.code),
                           "interval": a.interval}),
                    "asked",
                ),
                Err(e) => refuse(400, e),
            }
        }
        ("POST", "/v1/pair/poll") => match text(&body(), "secret").map(|s| p.poll(&s, now())) {
            None => refuse(400, "request"),
            Some(Poll::Pending) => {
                json(200, json!({"pending": "authorization_pending"}), "pending")
            }
            Some(Poll::SlowDown(n)) => json(
                200,
                json!({"pending": "slow_down", "interval": n}),
                "slow_down",
            ),
            Some(Poll::Refused(name, device)) => {
                json(200, json!({"refused": name, "device": device}), name)
            }
            Some(Poll::Token { token, grant }) => {
                json(200, json!({"token": token, "grant": grant}), "delivered")
            }
        },
        ("POST", "/v1/pair/show" | "/v1/pair/approve") => {
            let b = body();
            let account = match signed_in(app, bearer, &b) {
                Ok(a) => a,
                Err(e) => return Some(refuse(401, e)),
            };
            let note = format!("account#{}", correlate(&account));
            let Some(code) = text(&b, "code") else {
                return Some(refuse(400, "request"));
            };
            if path == "/v1/pair/show" {
                match p.show(&account, &code, now()) {
                    Ok(c) => json(
                        200,
                        json!({"device": c.device, "label": c.label, "soul": c.soul, "code": c.code,
                               "age": c.age, "scope": c.scope, "force": c.force, "connected": c.connected}),
                        note,
                    ),
                    Err(e @ "code-guesses") => refuse(429, e),
                    Err(e) => refuse(404, e),
                }
            } else if b.get("confirm").and_then(Value::as_bool) != Some(true) {
                refuse(400, "confirm")
            } else {
                match p.approve(&account, &code, now()) {
                    // V13c: the approving account owns the Soul, and its page follows the Soul's own body.
                    Ok(grant) => match app
                        .store
                        .own(&account, &grant, follow_of(&grant).as_deref())
                    {
                        Ok(()) => json(200, json!({"approved": true, "soul": grant}), note),
                        Err(_) => refuse(500, "store"),
                    },
                    Err(("code-guesses", _)) => refuse(429, "code-guesses"),
                    Err((e @ "unknown-code", _)) => refuse(404, e),
                    Err((e, device)) => json(409, json!({"refused": e, "device": device}), e),
                }
            }
        }
        ("POST", "/v1/account/souls" | "/v1/account/souls/revoke") => {
            let b = body();
            let account = match signed_in(app, bearer, &b) {
                Ok(a) => a,
                Err(e) => return Some(refuse(401, e)),
            };
            let note = format!("account#{}", correlate(&account));
            if path == "/v1/account/souls" {
                match p.souls(&account) {
                    Ok(s) => {
                        let s: Vec<Value> = s
                            .into_iter()
                            .map(|(soul, device)| json!({"soul": soul, "device": device}))
                            .collect();
                        json(200, json!({ "souls": s }), note)
                    }
                    Err(e) => refuse(500, e),
                }
            } else {
                let Some(soul) = text(&b, "soul") else {
                    return Some(refuse(400, "request"));
                };
                match p.revoke(&account, &soul) {
                    Ok(()) => json(200, json!({ "revoked": soul }), note),
                    Err(e @ ("store" | "tokens-file")) => refuse(500, e),
                    Err(e) => refuse(404, e),
                }
            }
        }
        _ if path == "/pair" || path.starts_with("/v1/pair/") => refuse(405, "method"),
        _ => return None,
    })
}
