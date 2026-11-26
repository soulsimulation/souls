//! The list and create over HTTP (W3), on W1's listener ([`crate::accounts::serve`]):
//!
//! - `GET /v1/worlds`: the list (one request, cacheable for a few seconds, the same for everyone). Signed in as for
//!   create, it also lists the caller's own unlisted worlds (#3698), and is not cached.
//! - `POST /v1/worlds` with `{"key", "name", "template", "label"}`, signed in as W1's session request is: a provider
//!   token as `Authorization: Bearer <token>`, or, with the sign-in for test worlds on, `Bearer test:<name>`.
//!   Answers `{"world": {...}}`, or `{"refused", "detail"}`; a limit's refusal (429) adds `limit` and `retry_after`.
//! - `POST /v1/worlds/settings` with `{"world", "unlisted"?, "closed"?}`, signed in the same way as the world's creator
//!   (W9, #2827): answers `{"world": {...}}`, the row as set; with neither switch, the row as it is. With
//!   `"picture": <base64url>` it also sets the list's picture (G10, #2800), refused by G6's code when the file fails.
//! - `POST /v1/worlds/welcome` with `{"world", "welcome"}` (#3702): the creator sets the words visitors are shown on
//!   arrival (empty clears them); answers `{"world": {...}}`. Signed in as the creator, or with the creator's paired
//!   token (`Bearer creator-…`, what `souls-god` holds).
//! - `POST /v1/worlds/visitors` with `{"world"}` (#3702), signed in the same way: the world's welcome and its most
//!   recent visitors, newest first, each `{"soul", "name", "arrived", "connected"}`; nothing of an owner's account.

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
            Ok(s) => {
                match app.store.revoked(&s.issuer, &s.session) {
                    Ok(false) => {}
                    Ok(true) => return Err(refuse(401, "session-revoked")),
                    Err(_) => return Err(refuse(500, "store")),
                }
                (s.issuer, s.subject)
            }
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
    let picture = match body.get("picture").and_then(Value::as_str) {
        None => None,
        Some(t) => match crate::accounts::from_b64url(t)
            .ok_or_else(|| "picture".to_string())
            .and_then(|f| super::list_picture(&f))
        {
            Ok(url) => Some(url),
            Err(code) => return (400, json!({"refused": code}), format!("{note} {code}")),
        },
    };
    match worlds.settings(
        world,
        account.principal,
        switch("unlisted"),
        switch("closed"),
        picture.as_deref(),
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
        // Signed in, the caller's own unlisted worlds are listed too (#3698); that answer is not cached publicly.
        let viewer = match &req.bearer {
            None => None,
            Some(_) => match signed_in(req, app) {
                Ok(a) => Some(a.principal),
                Err(e) => return e,
            },
        };
        return match worlds.list_for(viewer) {
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
        Ok(v) => {
            let grant = format!(
                "creator-{}",
                crate::accounts::principal_text(account.principal).replace(':', "-")
            );
            if app.store.own(&account.account, &grant, None).is_err() {
                return refuse(503, "store");
            }
            (200, v, note)
        }
        Err(e) if e.name.starts_with("world-limit") => {
            let mut v: Value = serde_json::from_str(&e.detail).unwrap_or(json!({}));
            v["refused"] = json!(e.name);
            (429, v, format!("{note} {}", e.name))
        }
        Err(e) => {
            let status = match e.name {
                "store-unreachable" | "start-failed" | "world-starting" => 503,
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

/// The signed-in creator offers/cancels, and a signed-in recipient explicitly accepts.
pub fn handoff(req: &Request, app: &App) -> Answer {
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
    if let Err(error) = crate::worlds::create::check_name(world)
        && error.name != "name-reserved"
    {
        return refuse(400, "world-name-invalid");
    }
    let note = format!("account#{}", correlate(&account.account));
    let _transaction = worlds.handoffs.lock().unwrap_or_else(|e| e.into_inner());
    let result: Result<Value, replica::effects::Refusal> = (|| match req.path.as_str() {
        "/v1/worlds/handoff/offer" => {
            let to = body
                .get("to")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty());
            if to == Some(&account.account) {
                return crate::directory::store::refuse(
                    "handoff-already-owner",
                    "recipient already owns world",
                );
            }
            worlds.offer_handoff(world, account.principal, to, now())
        }
        "/v1/worlds/handoff/cancel" => {
            worlds.cancel_handoff(world, account.principal)?;
            Ok(json!({"cancelled":true}))
        }
        "/v1/worlds/handoff/accept" => {
            // Acceptance fences the row (no creator) until the new one is published; a directory that cannot publish
            // this world's authority would leave it so for good, so it refuses before writing anything (#5006).
            if !app.pairing.as_ref().is_some_and(|p| p.can_hand_on(world)) {
                return crate::directory::store::refuse(
                    "world-authority-required",
                    "this directory cannot publish the world's authority",
                );
            }
            let code = body.get("code").and_then(Value::as_str).unwrap_or_default();
            let pending =
                worlds.begin_handoff(world, code, &account.account, account.principal, now())?;
            let publication = || -> Result<(), String> {
                let p = app.pairing.as_ref().ok_or("world-authority-required")?;
                let grant = format!(
                    "creator-{}",
                    crate::accounts::principal_text(pending.creator).replace(':', "-")
                );
                app.store
                    .own(&account.account, &grant, None)
                    .map_err(|_| "store")?;
                p.materialize_handoff(&pending)?;
                Ok(())
            };
            if publication().is_err() {
                return crate::directory::store::refuse(
                    "handoff-pending",
                    "accepted handoff awaits authority publication; retry the same acceptance",
                );
            }
            worlds.finish_handoff(&pending)?;
            Ok(json!({"accepted":true,"world":world}))
        }
        _ => crate::directory::store::refuse("handoff-route", "unknown handoff operation"),
    })();
    match result {
        Ok(body) => (200, body, note),
        Err(e) => {
            let status = if e.name == "handoff-pending" || e.name.starts_with("world-authority-") {
                503
            } else if e.name == "not-the-creator" || e.name == "handoff-not-for-you" {
                403
            } else {
                409
            };
            refuse(status, e.name)
        }
    }
}

/// Creator archive requires the current authority and exact name confirmation; restore is operator-only.
pub fn archive(req: &Request, app: &App) -> Answer {
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
    let confirm = body
        .get("confirm")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // With nothing to finish it, an archive begun here would stay `archiving` for good: the world off the list and its
    // creator unable to hand it on. Refuse before the row changes (#5006).
    if !super::archive::configured() {
        return refuse(503, "archive-unavailable");
    }
    let inner = worlds.inner.lock().unwrap_or_else(|e| e.into_inner());
    match super::archive::begin(
        &inner.dir.store,
        world,
        Some(account.principal),
        confirm,
        false,
    ) {
        Ok(phase) => {
            if phase.state == "archived" {
                return (
                    200,
                    json!({"archived":true,"world":world}),
                    "archive".into(),
                );
            }
            match super::archive::enqueue(&phase.request) {
                Ok(()) => (
                    202,
                    json!({"pending":true,"world":world}),
                    "archive-pending".into(),
                ),
                Err(e) => refuse(503, e.name),
            }
        }
        Err(e) => refuse(
            if e.name == "not-the-creator" {
                403
            } else {
                409
            },
            e.name,
        ),
    }
}

/// The most visitors the list gives (today's `/v1/world/visitors` gives 20 recent arrivals).
pub const VISITORS_MOST: usize = 20;

/// The creator asking (#3702): a paired creator's token (`Bearer creator-…`), else a signed-in account.
fn creator_asking(req: &Request, app: &App) -> Result<replica::ids::Id, Answer> {
    if let Some(token) = req.bearer.as_deref().filter(|b| b.starts_with("creator-")) {
        let grant = app
            .pairing
            .as_ref()
            .and_then(|p| p.creator_by_token(token))
            .ok_or_else(|| refuse(401, "token-refused"))?;
        let text = grant.trim_start_matches("creator-");
        let principal = text
            .rsplit_once('-')
            .and_then(|(scope, n)| crate::accounts::principal_from_text(&format!("{scope}:{n}")));
        return principal.ok_or_else(|| refuse(401, "token-refused"));
    }
    signed_in(req, app).map(|a| a.principal)
}

fn world_refusal(e: replica::effects::Refusal) -> Answer {
    let status = match e.name {
        "world-missing" => 404,
        "not-the-creator" => 403,
        "store-unreachable" | "contended" => 503,
        _ => 400,
    };
    refuse(status, e.name)
}

/// `POST /v1/worlds/welcome`: the creator sets the world's welcome.
pub fn welcome(req: &Request, app: &App) -> Answer {
    let Some(worlds) = &app.worlds else {
        return refuse(404, "no-worlds");
    };
    let who = match creator_asking(req, app) {
        Ok(w) => w,
        Err(e) => return e,
    };
    let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    let (Some(world), Some(words)) = (
        body.get("world").and_then(Value::as_str),
        body.get("welcome").and_then(Value::as_str),
    ) else {
        return refuse(400, "request");
    };
    match worlds.set_welcome(world, who, words) {
        Ok(row) => (200, json!({"world": row}), "welcome".into()),
        Err(e) => world_refusal(e),
    }
}

/// `POST /v1/worlds/visitors`: the creator reads the world's welcome and recent visitors.
pub fn visitors(req: &Request, app: &App) -> Answer {
    let (Some(worlds), Some(pairing)) = (&app.worlds, &app.pairing) else {
        return refuse(404, "no-worlds");
    };
    let who = match creator_asking(req, app) {
        Ok(w) => w,
        Err(e) => return e,
    };
    let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
    let Some(world) = body.get("world").and_then(Value::as_str) else {
        return refuse(400, "request");
    };
    match worlds.is_creator(world, who) {
        Ok(true) => {}
        Ok(false) => return refuse(403, "not-the-creator"),
        Err(e) => return world_refusal(e),
    }
    let Ok(list) = pairing.visitors(world, VISITORS_MOST) else {
        return refuse(500, "store");
    };
    let welcome = worlds.welcome_of(world).ok().flatten();
    let rows: Vec<Value> = list
        .iter()
        .map(|v| json!({"soul": v.soul, "name": v.name, "arrived": v.arrived, "connected": v.connected}))
        .collect();
    (
        200,
        json!({"world": world, "welcome": welcome, "visitors": rows}),
        "visitors".into(),
    )
}
