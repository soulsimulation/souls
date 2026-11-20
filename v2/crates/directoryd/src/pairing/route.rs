//! Pairing over HTTP (W2). Bodies are JSON both ways; the card is the one HTML page.
//!
//! - `POST /v1/pair/request` `{secret_hash, device, label, soul | new: true, scope: "soul", force?}`, or a
//!   creator's `{secret_hash, device, label, creator, scope: "creator", force?}` (G7) →
//!   `{code, link, interval}`. No sign-in: the daemon asks. A Soul of today's client (R18) is asked for as
//!   `{…, former: "s_…", world, scope: "soul"}` in place of `soul` or `new`: the owner's approval pairs the Soul X11
//!   brought over for that former id at that world (`imported_souls_v1`), only for the account that owns it, and
//!   refuses any other `unknown-soul`.
//! - `POST /v1/pair/poll` `{secret}` → `{pending: "authorization_pending" | "slow_down", interval?}`,
//!   `{refused, device?}` or, once, `{token, grant}`, with `former` for a former Soul's request.
//! - `GET /pair` → the approval card. It shows and changes nothing until the signed-in owner acts in it.
//! - `POST /v1/pair/show` and `POST /v1/pair/approve` `{code, confirm: true}`, signed in: W1's session token as
//!   `Authorization: Bearer`, or on a test world W1's test person as `test_person`. An approval records the Soul, and
//!   its own body for the page to follow, under the approving account (V13c), for the session exchange.
//! - `POST /v1/account/souls` → `{souls: [{soul, device}]}` and `POST /v1/account/souls/revoke` `{soul}` →
//!   `{ok: true, soul}`, signed in the same way (the account page, W9 #2827).
//! - My Souls (W11, #2749): a new Soul's request may name its `world`. Each listed Soul also carries `world`, `name`,
//!   `description`, `picture` (a `data:` URL) and `retire_asked`. Signed in: `POST /v1/account/souls/profile`
//!   `{soul, name?, description?}`, `POST /v1/account/souls/picture` `{soul, picture: <base64url>}` and
//!   `POST /v1/account/souls/retire` `{soul, confirm: true}`. The agent asks a retire with
//!   `POST /v1/pair/retire` `{token}`, which changes nothing until the owner's retire.
//!
//! The log line notes a refusal's name or a short hash of the account, never a token, secret, code or name.

use super::souls::{Mine, Profile};
use super::{Ask, Poll, is_name};
use crate::accounts::serve::{App, now};
use crate::accounts::start::TEST_ISSUER;
use crate::accounts::view::follow_of;
use crate::accounts::{b64url, correlate, from_b64url};
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

/// One of the owner's Souls as the list shows it; its picture as a `data:` URL (standard base64).
fn listed(m: &Mine) -> Value {
    let picture = m.picture.as_ref().map(|(format, bytes)| {
        let mut b = b64url(bytes).replace('-', "+").replace('_', "/");
        b.push_str(&"=".repeat((4 - b.len() % 4) % 4));
        format!("data:image/{format};base64,{b}")
    });
    json!({"soul": m.soul, "device": m.device, "world": m.world, "name": m.name, "description": m.description,
           "picture": picture, "retire_asked": m.retire_asked})
}

/// The signed-in account of a request, as W1 signs one in.
pub(super) fn signed_in(
    app: &App,
    bearer: Option<&str>,
    body: &Value,
) -> Result<String, &'static str> {
    let (issuer, subject) = if let Some(t) = bearer {
        let v = app.verifier.as_ref().ok_or("no-provider")?;
        let s = v.verify(t, now()).map_err(|r| r.name())?;
        if app
            .store
            .revoked(&s.issuer, &s.session)
            .map_err(|_| "store")?
        {
            return Err("signed-out");
        }
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
    if let Some(answer) = super::account::route(app, method, path, bearer, body) {
        return Some(answer);
    }
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
            // R18: a Soul of today's client, named by its former id and its world, for the Soul X11 brought over.
            let former = text(&b, "former");
            // A creator's request names its grant as `creator` (G7); a Soul's as `soul`.
            let soul = text(&b, "soul").or_else(|| text(&b, "creator"));
            let (Some(secret_hash), Some(device), Some(label)) =
                (secret_hash, text(&b, "device"), text(&b, "label"))
            else {
                return Some(refuse(400, "request"));
            };
            let named =
                usize::from(new) + usize::from(soul.is_some()) + usize::from(former.is_some());
            if named != 1 || !is_name(&device) || !is_name(&label) {
                return Some(refuse(400, "request"));
            }
            // The world the Soul is paired for (W11), kept with the request until its approval; a former Soul's
            // request must name it.
            let world = text(&b, "world");
            if world.as_deref().is_some_and(|w| !super::souls::is_world(w))
                || (former.is_some() && world.is_none())
            {
                return Some(refuse(400, "world"));
            }
            if former
                .as_deref()
                .is_some_and(|f| !super::souls::is_former(f))
            {
                return Some(refuse(400, "former"));
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
                Ok(a)
                    if world.is_some_and(|w| p.ask_world(&a.code, &w).is_err())
                        || former.is_some_and(|f| p.ask_former(&a.code, &f).is_err()) =>
                {
                    refuse(500, "store")
                }
                Ok(a) => json(
                    200,
                    json!({"code": a.code, "link": format!("{}/pair?code={}", p.public_url, a.code),
                           "interval": a.interval}),
                    "asked",
                ),
                Err(e) => refuse(400, e),
            }
        }
        ("POST", "/v1/pair/poll") => {
            match text(&body(), "secret").map(|s| (p.poll(&s, now()), s)) {
                None => refuse(400, "request"),
                Some((Poll::Pending, _)) => {
                    json(200, json!({"pending": "authorization_pending"}), "pending")
                }
                Some((Poll::SlowDown(n), _)) => json(
                    200,
                    json!({"pending": "slow_down", "interval": n}),
                    "slow_down",
                ),
                Some((Poll::Refused(name, device), _)) => {
                    json(200, json!({"refused": name, "device": device}), name)
                }
                // R18: a former Soul's answer says its former id back.
                Some((Poll::Token { token, grant }, secret)) => match p.former_by_secret(&secret) {
                    Some(former) => json(
                        200,
                        json!({"token": token, "grant": grant, "former": former}),
                        "delivered",
                    ),
                    None => json(200, json!({"token": token, "grant": grant}), "delivered"),
                },
            }
        }
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
                               "age": c.age, "scope": c.scope, "force": c.force, "connected": c.connected,
                               "former": c.former}),
                        note,
                    ),
                    Err(e @ "code-guesses") => refuse(429, e),
                    Err(e) => refuse(404, e),
                }
            } else if b.get("confirm").and_then(Value::as_bool) != Some(true) {
                refuse(400, "confirm")
            } else {
                let imported = |world: &str, former: &str| {
                    if super::is_soul_grant(former) {
                        let rows = app.store.imported_souls(&account).map_err(|_| "store")?;
                        for (grant, imported_world, _, _) in rows {
                            if grant != former {
                                continue;
                            }
                            let same_world = match (
                                p.authority(Some(world))?,
                                p.authority(Some(&imported_world))?,
                            ) {
                                (Some(a), Some(b)) => a.world == b.world,
                                (None, None) => world == imported_world,
                                _ => false,
                            };
                            if same_world {
                                return Ok(Some((grant, account.clone())));
                            }
                        }
                        return Ok(None);
                    }
                    app.store.imported_soul(world, former).map_err(|_| "store")
                };
                // A world's creator grant the account holds is its to pair alongside imported Souls.
                let holds = |g: &str| {
                    app.store
                        .grants(&account)
                        .is_ok_and(|gs| gs.iter().any(|(h, _)| h == g))
                };
                match p.approve_combined(&account, &code, now(), &imported, holds) {
                    // V13c: the approving account owns the Soul, and its page follows the Soul's own body.
                    Ok(grant) => match app
                        .store
                        .own(&account, &grant, follow_of(&grant).as_deref())
                    {
                        Ok(()) => match p.initialize_imported_profile(&app.store, &account, &grant)
                        {
                            Ok(()) => json(200, json!({"approved": true, "soul": grant}), note),
                            Err(e) => refuse(500, e),
                        },
                        Err(_) => refuse(500, "store"),
                    },
                    Err(("code-guesses", _)) => refuse(429, "code-guesses"),
                    Err((e @ "unknown-code", _)) => refuse(404, e),
                    Err((e, device)) => json(409, json!({"refused": e, "device": device}), e),
                }
            }
        }
        ("POST", "/v1/pair/retire") => match text(&body(), "token").map(|t| p.ask_retire(&t)) {
            None => refuse(400, "request"),
            Some(Ok(_)) => json(200, json!({"asked": true}), "retire-asked"),
            Some(Err(e @ "store")) => refuse(500, e),
            Some(Err(e)) => refuse(404, e),
        },
        (
            "POST",
            "/v1/account/souls"
            | "/v1/account/souls/revoke"
            | "/v1/account/souls/profile"
            | "/v1/account/souls/picture"
            | "/v1/account/souls/retire",
        ) => {
            let b = body();
            let account = match signed_in(app, bearer, &b) {
                Ok(a) => a,
                Err(e) => return Some(refuse(401, e)),
            };
            let note = format!("account#{}", correlate(&account));
            if path == "/v1/account/souls" {
                return Some(match p.mine_with_imports(&app.store, &account) {
                    Ok(s) => json(
                        200,
                        json!({ "souls": s.iter().map(listed).collect::<Vec<_>>() }),
                        note,
                    ),
                    Err(e) => refuse(500, e),
                });
            }
            let Some(soul) = text(&b, "soul") else {
                return Some(refuse(400, "request"));
            };
            let done = match path {
                "/v1/account/souls/revoke" => p.revoke(&account, &soul).map_err(str::to_string),
                "/v1/account/souls/profile" => p
                    .set_profile(
                        &account,
                        &soul,
                        &Profile {
                            name: text(&b, "name"),
                            description: text(&b, "description"),
                        },
                    )
                    .map_err(str::to_string),
                "/v1/account/souls/picture" => {
                    match text(&b, "picture").and_then(|t| from_b64url(&t)) {
                        Some(file) => p.set_picture(&account, &soul, &file),
                        None => Err("picture".into()),
                    }
                }
                // Never by following a link: a POST, signed in, that says it confirms.
                _ if b.get("confirm").and_then(Value::as_bool) != Some(true) => {
                    Err("confirm".into())
                }
                _ => p.retire(&account, &soul, now()).map_err(str::to_string),
            };
            match done {
                Ok(()) => json(200, json!({ "ok": true, "soul": soul }), note),
                Err(e) if e == "store" || e == "tokens-file" || e == "souls-file" => {
                    refuse(500, &e)
                }
                Err(e) if e == "unknown-soul" || e == "not-yours" => refuse(404, &e),
                Err(e) => refuse(400, &e),
            }
        }
        _ if path == "/pair" || path.starts_with("/v1/pair/") => refuse(405, "method"),
        _ => return None,
    })
}
