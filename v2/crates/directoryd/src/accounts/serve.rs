//! The sign-in requests over HTTP (W1), on a plain listener: a thread per connection, one request each.
//!
//! - `POST /v1/account/session` with `Authorization: Bearer <session token>`: the token checked
//!   ([`super::session`]), then the account and principal for its (issuer, subject), made on the first sign-in.
//! - `POST /v1/account/test-sign-in` with `{"name": "<test person>"}`: only with the sign-in for test worlds on.
//!
//! - `POST /v1/account/view-token` (V13b), signed in either way: `{"token", "expires", "owned": [{"grant", "follow"}]}`,
//!   a short-lived view token for the gateways ([`super::view`]) scoped to what the account owns. A signed-out
//!   session, or one whose token has expired, gets none.
//! - `POST /v1/account/sign-out` with the provider's session: that session gets no view token again.
//!
//! The first two answer `{"account", "principal"}`. The mailbox's (R13, #2753; [`super::mailbox`]):
//!
//! - `GET /v1/mailbox/open` and `POST /v1/mailbox/close`, the gateway's, with `Authorization: Bearer <the
//!   --mailbox-key>`. The first answers in plain text, a line per open message: `<soul> <id> <text frame>`, the
//!   frame the gateway gives the Soul's socket as it is (`{"mail": {"id", "text", "at"}}`). The second's body is the
//!   socket's own `{"close": {"id", "state", "outcome"}}`, with the socket's grant in a `souls-soul` header. So the
//!   gateway reads no JSON.
//! - `POST /v1/mailbox/put` `{"soul", "text"}`: the gateway's, with the mailbox key, for the page's box (W10), which
//!   checks the page's view token holds that Soul; also open with the sign-in for test worlds on, as is
//!   `POST /v1/mailbox/read` `{"id"}`.
//! - Prayers (G11, #3335; [`super::prayers`]), the gateway's too, each the socket's own frame with its grant in the
//!   `souls-soul` header, and answered `{"reply": {"n", "ok", ..}}` (`n` the request's own, `refused` a name), which
//!   the gateway gives back to that socket: `POST /v1/mailbox/pray` `{"pray": {"n", "text"}}` (a Soul's),
//!   `POST /v1/mailbox/prayers` `{"prayers": {"n", "all"}}` (a Soul's own, or its world's for a creator) and
//!   `POST /v1/mailbox/answer` `{"answer": {"n", "id", "text"}}` (a creator's). An answer not yet taken is an open
//!   line `<soul> <prayer id> {"answered": {"id", "text", "answer", "at"}}`, closed by the daemon's
//!   `{"close": {"id"}}`.
//!
//! - A Soul's status line (C14, #3684; [`super::now`]): `POST /v1/mailbox/now` `{"now": {"n", "text"}}`, the
//!   gateway's, with the socket's grant in the `souls-soul` header, answered as a prayer is (`{"reply": {"n", "ok",
//!   "now": {"text", "at"} | null}}`); and `POST /v1/account/now` `{"souls": [grant, ..]}`, public, answered
//!   `{"now": {grant: {"text", "at"}}, "state": {grant: word}}` for those with a line, and those a world has said are
//!   idle, a zombie or asleep (#3784; `POST /v1/mailbox/state` `{"states": {grant: word}}` from the gateway, the word
//!   `awake` clearing it).
//!
//! Answers carry `cache-control: no-store` (the world list's a short while) and may be read by the page's own origin
//! alone (CORS). A message's text is never in a log line. The log line of a request holds its method, path, status
//! and either the
//! refusal's name or a short hash of the account id: never a token, a header, a subject, a name or an email.

use super::session::Verifier;
use super::start::TEST_ISSUER;
use super::store::Store;
use super::view::{VIEW_TTL_S, ViewKey};
use super::{correlate, principal_text};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The largest request body read.
pub const BODY_MOST: usize = 4096;
/// The largest body of a Soul's picture upload (W11): base64url of `pairing::souls::PICTURE_BYTES`, and its JSON.
pub const PICTURE_BODY_MOST: usize = 360_000;
/// The largest body of a prayer or an answer (G11): 4,000 characters of up to four bytes, escaped, and its JSON.
pub const PRAYER_BODY_MOST: usize = 40_000;

pub struct App {
    pub store: Store,
    pub verifier: Option<Verifier>,
    pub test_sign_in: bool,
    /// The key view tokens are signed with (V13b), or no exchange.
    pub view_key: Option<ViewKey>,
    /// The page's origin, the one origin whose scripts may read these answers.
    pub origin: Option<String>,
    /// The SHA-256 of the gateway's mailbox key ([`key_digest`]); the gateway's mailbox requests are off without it.
    pub mailbox_key: Option<Vec<u8>>,
    /// Pairing a Soul to an agent (W2), if on.
    pub pairing: Option<crate::pairing::Pairing>,
    pub log: Mutex<Box<dyn Write + Send>>,
    /// The list of worlds and making one (W3), when configured.
    pub worlds: Option<
        crate::worlds::list::Worlds<&'static (dyn crate::directory::store::Store + Send + Sync)>,
    >,
}

/// The wall clock, in seconds since 1970: a token's `exp` and `nbf` are wall-clock times, not world time.
#[allow(clippy::disallowed_methods)]
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Serves until the listener fails.
pub fn run(listener: TcpListener, app: Arc<App>) {
    if configure_current_authority(&app).is_err() {
        eprintln!("directoryd: refusing to serve: world-authority-unavailable");
        return;
    }
    for stream in listener.incoming().flatten() {
        let app = app.clone();
        std::thread::spawn(move || handle(stream, &app));
    }
}

/// Startup wiring: the registry stays read-only; weak ownership avoids a callback cycle.
pub fn configure_current_authority(app: &Arc<App>) -> Result<(), String> {
    let Some(pairing) = &app.pairing else {
        return Ok(());
    };
    if pairing.requires_world_authority() {
        if app.worlds.is_none() {
            return Err("world-authority-required".into());
        }
        let weak = Arc::downgrade(app);
        pairing.current_owner_reader(Arc::new(move |world| {
            let app = weak.upgrade().ok_or("world-authority-unavailable")?;
            let worlds = app.worlds.as_ref().ok_or("world-authority-required")?;
            worlds.ownership(world).map_err(|e| e.name.to_owned())
        }))?;
        pairing.reconcile_current_authority()?;
    }
    Ok(())
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub bearer: Option<String>,
    /// The gateway's `souls-soul` header on a mailbox close: the grant of the socket it came from.
    pub soul: Option<String>,
    pub body: Vec<u8>,
}

fn read(stream: &TcpStream) -> Option<(Request, bool, Option<std::net::IpAddr>)> {
    let mut r = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut words = line.split_whitespace();
    let method = words.next()?.to_string();
    let path = words.next()?.split('?').next()?.to_string();
    let (mut bearer, mut soul, mut length) = (None, None, 0usize);
    let mut indirect = false;
    let (mut forwarded, mut forwarded_count) = (None, 0u8);
    // A picture rides in a Soul's picture and in a world's settings (its list picture, G10).
    let most = if path == "/v1/account/souls/picture" || path == "/v1/worlds/settings" {
        PICTURE_BODY_MOST
    } else if path == "/v1/mailbox/pray" || path == "/v1/mailbox/answer" {
        PRAYER_BODY_MOST
    } else {
        BODY_MOST
    };
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 {
            return None;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let (name, value) = h.split_once(':')?;
        let value = value.trim();
        let lower = name.to_ascii_lowercase();
        if lower == "x-forwarded-for" {
            forwarded_count = forwarded_count.saturating_add(1);
            // Caddy overwrites this header. A list, duplicate or non-address never supplies rate identity.
            forwarded = if forwarded_count == 1 {
                value.parse::<std::net::IpAddr>().ok()
            } else {
                None
            };
        }
        indirect |= lower.starts_with("x-forwarded-")
            || matches!(
                lower.as_str(),
                "forwarded"
                    | "x-real-ip"
                    | "client-ip"
                    | "x-client-ip"
                    | "true-client-ip"
                    | "cf-connecting-ip"
                    | "fastly-client-ip"
                    | "x-envoy-external-address"
                    | "via"
                    | "origin"
            );
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse().ok().filter(|n| *n <= most)?;
        } else if name.eq_ignore_ascii_case("authorization") {
            bearer = value.strip_prefix("Bearer ").map(str::to_string);
        } else if name.eq_ignore_ascii_case("souls-soul") {
            soul = Some(value.to_string());
        }
    }
    let mut body = vec![0; length];
    r.read_exact(&mut body).ok()?;
    Some((
        Request {
            method,
            path,
            bearer,
            soul,
            body,
        },
        indirect,
        forwarded,
    ))
}

fn rate_identity(peer: std::net::IpAddr, forwarded: Option<std::net::IpAddr>) -> std::net::IpAddr {
    if peer.is_loopback() {
        forwarded.unwrap_or(peer)
    } else {
        peer
    }
}

#[derive(Default)]
struct AccountRates(std::collections::BTreeMap<(std::net::IpAddr, u8), Vec<u64>>);
impl AccountRates {
    fn allow(&mut self, peer: std::net::IpAddr, path: &str, at: u64) -> bool {
        let (kind, most) = match path {
            "/v1/agent/account/login" => (0, 6),
            "/v1/agent/account/requests/poll" => (1, 60),
            "/v1/agent/account/pair" => (2, 10),
            p if p.starts_with("/v1/account/requests/") && p.ends_with("/approve") => (3, 10),
            _ => return true,
        };
        self.0.retain(|_, hits| {
            hits.retain(|t| at.saturating_sub(*t) < 60);
            !hits.is_empty()
        });
        // Only security-rate metadata is capped; no live sessions, accounts or Souls are capped.
        if self.0.len() >= 4096 && !self.0.contains_key(&(peer, kind)) {
            return false;
        }
        let hits = self.0.entry((peer, kind)).or_default();
        if hits.len() >= most {
            return false;
        }
        hits.push(at);
        true
    }
}

fn handle(mut stream: TcpStream, app: &App) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Some((req, indirect, forwarded)) = read(&stream) else {
        let _ = respond(
            &mut stream,
            400,
            &json!({"refused": "request"}),
            "no-store",
            app.origin.as_deref(),
        );
        return;
    };
    let direct = !indirect && stream.peer_addr().is_ok_and(|peer| peer.ip().is_loopback());
    if req.method == "POST" {
        static RATES: std::sync::OnceLock<Mutex<AccountRates>> = std::sync::OnceLock::new();
        let allowed = stream.peer_addr().is_ok_and(|peer| {
            RATES
                .get_or_init(Mutex::default)
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .allow(rate_identity(peer.ip(), forwarded), &req.path, now())
        });
        if !allowed {
            let _ = respond(
                &mut stream,
                429,
                &json!({"refused":"account-rate"}),
                "no-store",
                app.origin.as_deref(),
            );
            return;
        }
    }
    let (status, kind, body, note) =
        crate::pairing::operator::route(app, &req.method, &req.path, &req.body, direct)
            .or_else(|| {
                crate::pairing::route::route(
                    app,
                    &req.method,
                    &req.path,
                    req.bearer.as_deref(),
                    &req.body,
                )
            })
            .unwrap_or_else(|| {
                let (status, body, note) = route(&req, app);
                // A text answer (the mailbox's open lines) is written as it is.
                match body {
                    Value::String(s) => (status, "text/plain; charset=utf-8", s, note),
                    v => (status, "application/json", text(&v), note),
                }
            });
    // The world list may be cached a short while (W3, #2799); everything else is no-store.
    let list = req.method == "GET" && req.path == "/v1/worlds" && status == 200;
    let cache = if list {
        crate::worlds::list::http::CACHE
    } else {
        "no-store"
    };
    let _ = respond_as(
        &mut stream,
        status,
        kind,
        &body,
        cache,
        app.origin.as_deref(),
    );
    let line = format!("directoryd: {} {} {status} {note}\n", req.method, req.path);
    let _ = app.log.lock().expect("the log").write_all(line.as_bytes());
}

/// Who a request signs in as: the provider's session (`Authorization: Bearer`), or a named test person when the
/// sign-in for test worlds is on. `(issuer, subject, session id)`; a test person has no session id.
fn who(
    req: &Request,
    app: &App,
    test: bool,
) -> Result<(String, String, Option<String>), (u16, &'static str)> {
    if test && app.test_sign_in {
        let name = serde_json::from_slice::<Value>(&req.body)
            .ok()
            .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_string));
        return match name {
            Some(n)
                if (1..=64).contains(&n.len())
                    && n.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_. ".contains(&b)) =>
            {
                Ok((TEST_ISSUER.to_string(), n, None))
            }
            _ => Err((400, "test-name")),
        };
    }
    let Some(v) = &app.verifier else {
        return Err((404, "no-provider"));
    };
    let Some(token) = &req.bearer else {
        return Err((401, "token-missing"));
    };
    let s = v.verify(token, now()).map_err(|r| (401, r.name()))?;
    Ok((s.issuer, s.subject, Some(s.session)))
}

/// The SHA-256 of a key, compared instead of the key itself.
pub fn key_digest(key: &str) -> Vec<u8> {
    ring::digest::digest(&ring::digest::SHA256, key.as_bytes())
        .as_ref()
        .to_vec()
}

fn mail_json(m: &super::mailbox::Mail) -> Value {
    json!({"id": m.id, "soul": m.soul, "text": m.text, "at": m.at, "state": m.state, "outcome": m.outcome})
}

/// The mailbox's requests; `None` for any other path.
fn mailbox(req: &Request, app: &App) -> Option<(u16, Value, String)> {
    let refuse = |status, name: &str| Some((status, json!({"refused": name}), name.to_string()));
    let body = || serde_json::from_slice::<Value>(&req.body).unwrap_or(Value::Null);
    let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let gateway = || {
        let given = req.bearer.as_deref().map(key_digest);
        app.mailbox_key.is_some() && given.as_ref() == app.mailbox_key.as_ref()
    };
    let store =
        |_: super::store::StoreError| (500, json!({"refused": "store"}), "store".to_string());
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/mailbox/open") if gateway() => Some(match app.store.mail_open(now()) {
            Ok(m) => {
                let lines: String = m
                    .iter()
                    .map(|m| {
                        let frame = json!({"mail": {"id": m.id, "text": m.text, "at": m.at}});
                        format!("{} {} {frame}\n", m.soul, m.id)
                    })
                    .collect();
                // G11: the answers not yet taken, to their Souls' sockets the same way.
                let answers = match app.store.answers_open(now()) {
                    Ok(a) => a,
                    Err(e) => return Some(store(e)),
                };
                let answered: String = answers
                    .iter()
                    .map(|p| {
                        let frame = json!({"answered": {"id": p.id, "text": p.text, "answer": p.answer, "at": p.answered_at}});
                        format!("{} {} {frame}\n", p.soul, p.id)
                    })
                    .collect();
                let note = format!("{} open {} answers", m.len(), answers.len());
                (200, Value::String(lines + &answered), note)
            }
            Err(e) => store(e),
        }),
        ("POST", "/v1/mailbox/close") if gateway() => {
            let b = body().get("close").cloned().unwrap_or(Value::Null);
            let (id, soul) = (text(&b, "id"), req.soul.clone().unwrap_or_default());
            Some(
                match app
                    .store
                    .mail_close(&id, &soul, &text(&b, "state"), &text(&b, "outcome"), now())
                    .and_then(|c| {
                        if c {
                            Ok(c)
                        } else {
                            app.store.answer_taken(&id, &soul)
                        }
                    }) {
                    Ok(closed) => (200, json!({"closed": closed}), format!("closed {closed}")),
                    Err(e) => store(e),
                },
            )
        }
        ("POST", "/v1/mailbox/pray" | "/v1/mailbox/prayers" | "/v1/mailbox/answer")
            if gateway() =>
        {
            Some(prayers(req, app))
        }
        ("POST", "/v1/mailbox/now") if gateway() => Some(now_set(req, app)),
        // #3784: a world's word on its Souls, passed on by its gateway on each change: `{"states": {grant: word}}`.
        ("POST", "/v1/mailbox/state") if gateway() => {
            let b = body();
            let words: Vec<(&str, &str)> = b
                .get("states")
                .and_then(Value::as_object)
                .map(|m| {
                    m.iter()
                        .filter_map(|(g, w)| Some((g.as_str(), w.as_str()?)))
                        .collect()
                })
                .unwrap_or_default();
            Some(match app.store.states_set(words, now()) {
                Ok(n) => (200, json!({"ok": true, "n": n}), format!("states {n}")),
                Err(e) => store(e),
            })
        }
        ("GET", "/v1/mailbox/open")
        | (
            "POST",
            "/v1/mailbox/close"
            | "/v1/mailbox/pray"
            | "/v1/mailbox/prayers"
            | "/v1/mailbox/answer"
            | "/v1/mailbox/now"
            | "/v1/mailbox/state",
        ) => refuse(401, "mailbox-key"),
        ("POST", "/v1/mailbox/put") if app.test_sign_in || gateway() => {
            let b = body();
            Some(
                match app
                    .store
                    .mail_put(&text(&b, "soul"), &text(&b, "text"), now())
                {
                    Ok(Some(id)) => (200, json!({"id": id}), "put".to_string()),
                    Ok(None) => (
                        400,
                        json!({"refused": "mail-form"}),
                        "mail-form".to_string(),
                    ),
                    Err(e) => store(e),
                },
            )
        }
        ("POST", "/v1/mailbox/read") if app.test_sign_in => {
            Some(match app.store.mail(&text(&body(), "id")) {
                Ok(Some(m)) => (200, mail_json(&m), "read".to_string()),
                Ok(None) => (
                    404,
                    json!({"refused": "mail-not-found"}),
                    "mail-not-found".to_string(),
                ),
                Err(e) => store(e),
            })
        }
        _ => None,
    }
}

fn prayer_json(p: &super::prayers::Prayer) -> Value {
    let state = if p.answer.is_some() {
        "answered"
    } else {
        "waiting"
    };
    json!({"id": p.id, "soul": p.soul, "text": p.text, "at": p.at, "state": state, "answer": p.answer,
           "answered_at": p.answered_at})
}

/// The worlds a creator grant is the creator of, by the list of worlds when there is one ([`super::prayers::creator_worlds`]).
fn creator_worlds_of(grant: &str, app: &App) -> Option<Vec<String>> {
    let Some(worlds) = &app.worlds else {
        return super::prayers::creator_worlds(grant, &[]);
    };
    let rows = worlds.creators().ok()?;
    let scope = super::prayers::scope_of(grant, "creator")?;
    let principal = format!("{scope}:{}", grant.rsplit('-').next()?);
    Some(
        rows.into_iter()
            .filter(|(_, owner)| owner == &principal)
            .map(|(lineage, _)| lineage)
            .collect(),
    )
}

/// A prayer request from the gateway (G11): the socket's own frame and grant. Always a 200 whose body is the reply the
/// gateway gives back to that socket, a refusal included, so the asker hears it by name. Its log note holds no text.
fn prayers(req: &Request, app: &App) -> (u16, Value, String) {
    let grant = req.soul.clone().unwrap_or_default();
    let frame = serde_json::from_slice::<Value>(&req.body).unwrap_or(Value::Null);
    let kind = req.path.trim_start_matches("/v1/mailbox/");
    let b = frame.get(kind).cloned().unwrap_or(Value::Null);
    let n = b.get("n").and_then(Value::as_u64).unwrap_or(0);
    let text = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let answer = match kind {
        "pray" => app
            .store
            .pray(&grant, &text("text"), now())
            .map(|r| r.map(|id| json!({"id": id}))),
        "prayers" if super::prayers::scope_of(&grant, "soul").is_some() => app
            .store
            .prayers_of(&grant)
            .map(|v| Ok(json!({"prayers": v.iter().map(prayer_json).collect::<Vec<_>>()}))),
        _ => match creator_worlds_of(&grant, app) {
            None => Ok(Err("prayer.not-the-creator")),
            Some(worlds) if kind == "prayers" => {
                let all = b.get("all").and_then(Value::as_bool).unwrap_or(false);
                app.store
                    .prayers_to(&worlds, all)
                    .map(|v| Ok(json!({"prayers": v.iter().map(prayer_json).collect::<Vec<_>>()})))
            }
            Some(worlds) => app
                .store
                .answer(&worlds, &text("id"), &text("text"), now())
                .map(|r| r.map(|p| json!({"prayer": prayer_json(&p)}))),
        },
    };
    let (mut reply, note) = match answer {
        Ok(Ok(v)) => (v, format!("{kind} ok")),
        Ok(Err(name)) => (json!({"refused": name}), name.to_string()),
        Err(_) => (json!({"refused": "store"}), "store".to_string()),
    };
    reply["n"] = json!(n);
    reply["ok"] = json!(reply.get("refused").is_none());
    (200, json!({"reply": reply}), note)
}

fn now_json(n: &super::now::Now) -> Value {
    json!({"text": n.text, "at": n.at})
}

/// C14 (#3684): a Soul sets its status line, from the gateway with the socket's own grant (`{"now": {"n", "text"}}`).
/// Answered as a prayer is, a 200 whose body is the reply the gateway gives back to that socket. No text in the log.
fn now_set(req: &Request, app: &App) -> (u16, Value, String) {
    let grant = req.soul.clone().unwrap_or_default();
    let frame = serde_json::from_slice::<Value>(&req.body).unwrap_or(Value::Null);
    let b = frame.get("now").cloned().unwrap_or(Value::Null);
    let n = b.get("n").and_then(Value::as_u64).unwrap_or(0);
    // A null or empty text clears the line.
    let text = match b.get("text") {
        Some(Value::Null) => Some(""),
        Some(Value::String(t)) => Some(t.as_str()),
        _ => None,
    };
    let (mut reply, note) = match text.map(|t| app.store.now_set(&grant, t, now())) {
        None => (json!({"refused": "now.form"}), "now.form".to_string()),
        Some(Ok(Ok(line))) => {
            let note = if line.is_some() {
                "now set"
            } else {
                "now cleared"
            };
            (
                json!({"now": line.as_ref().map(now_json)}),
                note.to_string(),
            )
        }
        Some(Ok(Err(name))) => (json!({"refused": name}), name.to_string()),
        Some(Err(_)) => (json!({"refused": "store"}), "store".to_string()),
    };
    reply["n"] = json!(n);
    reply["ok"] = json!(reply.get("refused").is_none());
    (200, json!({"reply": reply}), note)
}

/// C14 (#3684): the public read of Souls' status lines, `{"souls": [grant, ..]}` (at most `now::READ_MOST`), answered
/// `{"now": {grant: {"text", "at"}}, "state": {grant: word}}` for those that have one. Public, as the Soul's page is
/// (the word is what the world's stream already shows anyone); no sign-in.
fn now_read(req: &Request, app: &App) -> (u16, Value, String) {
    let body = serde_json::from_slice::<Value>(&req.body).unwrap_or(Value::Null);
    let Some(souls) = body.get("souls").and_then(Value::as_array) else {
        return (400, json!({"refused": "request"}), "request".into());
    };
    if souls.len() > super::now::READ_MOST {
        return (
            400,
            json!({"refused": "now.too-many"}),
            "now.too-many".into(),
        );
    }
    let asked: Vec<&str> = souls.iter().filter_map(Value::as_str).collect();
    match (app.store.now_of(&asked), app.store.states_of(&asked)) {
        (Ok(lines), Ok(states)) => {
            let map: serde_json::Map<String, Value> = lines
                .iter()
                .map(|(g, n)| (g.clone(), now_json(n)))
                .collect();
            let state: serde_json::Map<String, Value> =
                states.into_iter().map(|(g, w)| (g, json!(w))).collect();
            let note = format!("now {} of {}", map.len(), asked.len());
            (200, json!({"now": map, "state": state}), note)
        }
        _ => (500, json!({"refused": "store"}), "store".into()),
    }
}

fn route(req: &Request, app: &App) -> (u16, Value, String) {
    if let Some(r) = mailbox(req, app) {
        return r;
    }
    let refuse = |status, name: &str| (status, json!({"refused": name}), name.to_string());
    let path = req.path.as_str();
    let signed = match (req.method.as_str(), path) {
        ("GET", "/healthz") => return (200, json!({"ok": true}), "ok".into()),
        // The page's preflight for a request from its own origin (CORS): headers alone.
        ("OPTIONS", _) => return (204, Value::Null, "preflight".into()),
        ("GET" | "POST", "/v1/worlds") => return crate::worlds::list::http::route(req, app),
        ("POST", "/v1/worlds/settings") => return crate::worlds::list::http::settings(req, app),
        ("POST", "/v1/worlds/welcome") => return crate::worlds::list::http::welcome(req, app),
        ("POST", "/v1/worlds/visitors") => return crate::worlds::list::http::visitors(req, app),
        ("POST", "/v1/worlds/archive") => return crate::worlds::list::http::archive(req, app),
        ("POST", "/v1/account/now") => return now_read(req, app),
        (
            "POST",
            "/v1/worlds/handoff/offer" | "/v1/worlds/handoff/cancel" | "/v1/worlds/handoff/accept",
        ) => return crate::worlds::list::http::handoff(req, app),
        ("POST", "/v1/account/session") => who(req, app, false),
        ("POST", "/v1/account/test-sign-in") if app.test_sign_in => who(req, app, true),
        ("POST", "/v1/account/view-token" | "/v1/account/sign-out") => {
            who(req, app, req.bearer.is_none())
        }
        _ => return refuse(404, "not-found"),
    };
    let (issuer, subject, session) = match signed {
        Ok(w) => w,
        Err((status, name)) => return refuse(status, name),
    };
    if path == "/v1/account/sign-out" {
        let Some(sid) = &session else {
            return refuse(400, "no-session");
        };
        return match app.store.revoke_session(&issuer, sid, now()) {
            Ok(()) => (200, json!({"signed_out": true}), "signed-out".into()),
            Err(_) => refuse(500, "store"),
        };
    }
    if let Some(sid) = &session {
        match app.store.revoked(&issuer, sid) {
            Ok(false) => {}
            Ok(true) => return refuse(401, "session-revoked"),
            Err(_) => return refuse(500, "store"),
        }
    }
    let a = match app.store.sign_in(&issuer, &subject, now()) {
        Ok(a) => a,
        Err(_) => return refuse(500, "store"),
    };
    let note = format!("account#{}", correlate(&a.account));
    if path != "/v1/account/view-token" {
        let body = json!({"account": a.account, "principal": principal_text(a.principal)});
        return (200, body, note);
    }
    // The exchange (V13b): a view token for what the account owns, answered once and written nowhere.
    let Some(key) = &app.view_key else {
        return refuse(404, "no-view-key");
    };
    let owned = match app.store.grants(&a.account) {
        Ok(g) if !g.is_empty() => g
            .into_iter()
            .filter(|(grant, _)| {
                !grant.starts_with("creator-")
                    || creator_worlds_of(grant, app).is_some_and(|worlds| !worlds.is_empty())
            })
            .collect::<Vec<_>>(),
        Ok(_) => return refuse(404, "nothing-owned"),
        Err(_) => return refuse(500, "store"),
    };
    if owned.is_empty() {
        return refuse(404, "nothing-owned");
    }
    let expires = now() + VIEW_TTL_S;
    let grants: Vec<String> = owned.iter().map(|(g, _)| g.clone()).collect();
    let owned: Vec<Value> = owned
        .iter()
        .map(|(g, f)| json!({"grant": g, "follow": f}))
        .collect();
    let body = json!({"token": key.mint(&grants, expires), "expires": expires, "owned": owned});
    (200, body, note)
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    body: &Value,
    cache: &str,
    origin: Option<&str>,
) -> std::io::Result<()> {
    respond_as(
        stream,
        status,
        "application/json",
        &text(body),
        cache,
        origin,
    )
}

/// A JSON answer's text; none for an empty answer (the preflight's).
fn text(body: &Value) -> String {
    if body.is_null() {
        String::new()
    } else {
        body.to_string()
    }
}

fn respond_as(
    stream: &mut TcpStream,
    status: u16,
    kind: &str,
    body: &str,
    cache: &str,
    origin: Option<&str>,
) -> std::io::Result<()> {
    // The page's own origin may read the answers (CORS); no other origin may.
    let cors = origin.map_or(String::new(), |o| {
        format!(
            "access-control-allow-origin: {o}\r\nvary: origin\r\naccess-control-allow-methods: POST\r\n\
             access-control-allow-headers: authorization, content-type\r\naccess-control-max-age: 600\r\n"
        )
    });
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        409 => "Conflict",
        429 => "Too Many Requests",
        404 => "Not Found",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\n\
         cache-control: {cache}\r\n{cors}connection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
mod operator_transport_tests {
    use super::*;

    #[test]
    fn o24_actual_http_refuses_indirect_operator_and_public_status_hides_ordinary_existence() {
        let ordinary = "soul-0123456789abcdef0123456789abcdef-4";
        let pairing = crate::pairing::Pairing::open(
            std::path::Path::new(":memory:"),
            None,
            "https://example.invalid",
        )
        .unwrap();
        pairing.register(ordinary, "acct_owner").unwrap();
        let app = App {
            store: Store::open(std::path::Path::new(":memory:")).unwrap(),
            verifier: None,
            test_sign_in: false,
            view_key: None,
            origin: None,
            mailbox_key: None,
            pairing: Some(pairing),
            log: Mutex::new(Box::new(std::io::sink())),
            worlds: None,
        };
        for (path, header, body, expected, contains) in [
            ("/v1/pair/operator/list", "", "{}".to_string(), 200, "souls"),
            (
                "/v1/pair/operator/list",
                "Forwarded: for=example\r\n",
                "{}".to_string(),
                403,
                "operator.direct-only",
            ),
            (
                "/v1/pair/operator/list",
                "Origin: https://example.invalid\r\n",
                "{}".to_string(),
                403,
                "operator.direct-only",
            ),
            (
                "/v1/pair/test-status",
                "",
                json!({"soul": ordinary}).to_string(),
                200,
                "\"test\":false",
            ),
            (
                "/v1/pair/test-status",
                "",
                json!({"soul": "soul-ffffffffffffffffffffffffffffffff-0"}).to_string(),
                200,
                "\"test\":false",
            ),
        ] {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (server, _) = listener.accept().unwrap();
            write!(
                client,
                "POST {path} HTTP/1.1\r\nContent-Length: {}\r\n{header}\r\n{body}",
                body.len()
            )
            .unwrap();
            handle(server, &app);
            let mut answer = String::new();
            client.read_to_string(&mut answer).unwrap();
            assert!(
                answer.starts_with(&format!("HTTP/1.1 {expected}")),
                "{answer}"
            );
            assert!(answer.contains(contains), "{answer}");
        }
    }

    #[test]
    fn o24_actual_reader_marks_proxy_and_browser_identity_headers_indirect() {
        for header in [
            "",
            "Forwarded: for=example",
            "X-Forwarded-For: example",
            "X-Real-IP: example",
            "Via: proxy",
            "Origin: https://example.invalid",
        ] {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (server, peer) = listener.accept().unwrap();
            assert!(peer.ip().is_loopback());
            write!(
                client,
                "POST /v1/pair/operator/list HTTP/1.1\r\nContent-Length: 2\r\n{header}{}\r\n{{}}",
                if header.is_empty() { "" } else { "\r\n" }
            )
            .unwrap();
            let (req, indirect, _) = read(&server).unwrap();
            assert_eq!(req.body, b"{}");
            assert_eq!(indirect, !header.is_empty());
        }
    }
}

#[cfg(test)]
mod account_transport_tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};
    fn address(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(192, 0, 2, last))
    }
    fn forwarded(headers: &str) -> Option<IpAddr> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        write!(
            client,
            "POST /v1/agent/account/login HTTP/1.1\r\nContent-Length: 2\r\n{headers}\r\n{{}}"
        )
        .unwrap();
        let (_, indirect, forwarded) = read(&server).unwrap();
        assert!(
            indirect,
            "rate metadata must never make proxy traffic direct"
        );
        forwarded
    }
    #[test]
    fn w15_rate_identity_accepts_only_one_proxy_address_from_a_loopback_peer() {
        let one = address(1);
        let two = address(2);
        let local = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let a = forwarded(&format!("X-Forwarded-For: {one}\r\n"));
        let b = forwarded(&format!("X-Forwarded-For: {two}\r\n"));
        assert_eq!(rate_identity(local, a), one);
        assert_eq!(rate_identity(local, b), two);
        assert_eq!(
            rate_identity(two, a),
            two,
            "off-host peers cannot supply rate identity"
        );
        for headers in [
            format!("X-Forwarded-For: {one}, {two}\r\n"),
            format!("X-Forwarded-For: {one}\r\nX-Forwarded-For: {two}\r\n"),
            format!("X-Real-IP: {one}\r\n"),
            "X-Forwarded-For: not-an-address\r\n".into(),
        ] {
            assert_eq!(forwarded(&headers), None);
        }
        let mut rates = AccountRates::default();
        for _ in 0..6 {
            assert!(rates.allow(rate_identity(local, a), "/v1/agent/account/login", 100));
        }
        assert!(!rates.allow(one, "/v1/agent/account/login", 100));
        assert!(rates.allow(rate_identity(local, b), "/v1/agent/account/login", 100));
        for _ in 0..60 {
            assert!(rates.allow(one, "/v1/agent/account/requests/poll", 100));
        }
        assert!(!rates.allow(one, "/v1/agent/account/requests/poll", 100));
        for path in [
            "/v1/agent/account/pair",
            "/v1/account/requests/aq_test/approve",
        ] {
            for _ in 0..10 {
                assert!(rates.allow(one, path, 100));
            }
            assert!(!rates.allow(one, path, 100));
        }
        assert!(rates.allow(one, "/v1/agent/account/login", 160));
    }
}

#[cfg(test)]
mod w16_current_account_tests {
    use super::*;
    #[test]
    fn w16_view_and_prayers_use_current_owner_preserving_ordinary_soul() {
        use crate::directory::store::{Memory, Store as ObjectStore, When};
        use crate::worlds::{create::NameRecord, list::Worlds};
        use replica::{
            encode::{Name, to_hex},
            ids::{Id, Scope},
        };
        let memory: &'static (dyn ObjectStore + Send + Sync) =
            Box::leak(Box::new(Memory::default()));
        let accounts = Store::open(std::path::Path::new(":memory:")).unwrap();
        let a = accounts.sign_in(TEST_ISSUER, "first", 0).unwrap();
        let b = accounts.sign_in(TEST_ISSUER, "next", 0).unwrap();
        let old = super::super::view::grant_text("creator", a.principal);
        let new = super::super::view::grant_text("creator", b.principal);
        let soul = super::super::view::grant_text("soul", Id::new(Scope([5; 16]), 0).unwrap());
        accounts.own(&a.account, &old, None).unwrap();
        accounts.own(&a.account, &soul, None).unwrap();
        accounts.own(&b.account, &new, None).unwrap();
        let name = NameRecord {
            name: "eden".into(),
            lineage: [6; 16],
            zone: Id::new(Scope([7; 16]), 0).unwrap(),
            creator: a.principal,
            source: [8; 16],
        };
        memory
            .put(
                &NameRecord::key("eden"),
                &name.to_bytes().unwrap(),
                When::Absent,
            )
            .unwrap();
        memory.put(crate::worlds::list::KEY,&serde_json::to_vec(&json!({"worlds":[{"name":"eden","lineage":to_hex(&name.lineage),"zone":super::super::principal_text(name.zone),"creator":super::super::principal_text(a.principal)}]})).unwrap(),When::Absent).unwrap();
        let app = App {
            store: accounts,
            verifier: None,
            test_sign_in: true,
            view_key: Some(ViewKey::new(&[1; 32])),
            origin: None,
            mailbox_key: None,
            pairing: None,
            log: Mutex::new(Box::new(std::io::sink())),
            worlds: Some(Worlds::new(
                crate::directory::Directory::new(memory, Name::new("fixture").unwrap()),
                std::collections::BTreeMap::new(),
                Box::new(|_| Ok(())),
            )),
        };
        let request = |who: &str| Request {
            method: "POST".into(),
            path: "/v1/account/view-token".into(),
            bearer: None,
            soul: None,
            body: json!({"name":who}).to_string().into_bytes(),
        };
        assert_eq!(
            route(&request("first"), &app).1["owned"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let worlds = app.worlds.as_ref().unwrap();
        let offer_request = Request {
            method: "POST".into(),
            path: "/v1/worlds/handoff/offer".into(),
            bearer: Some("test:first".into()),
            soul: None,
            body: json!({"world":"eden"}).to_string().into_bytes(),
        };
        let (status, code, _) = route(&offer_request, &app);
        assert_eq!(status, 200, "an existing reserved world may be handed over");
        let invalid = Request {
            body: json!({"world":"../eden"}).to_string().into_bytes(),
            ..offer_request
        };
        assert_eq!(route(&invalid, &app).0, 400, "syntax is still rejected");
        let p = worlds
            .begin_handoff(
                "eden",
                code["code"].as_str().unwrap(),
                &b.account,
                b.principal,
                11,
            )
            .unwrap();
        assert!(creator_worlds_of(&old, &app).unwrap().is_empty());
        assert!(creator_worlds_of(&new, &app).unwrap().is_empty());
        let pending = route(&request("first"), &app);
        assert_eq!(pending.0, 200);
        assert_eq!(pending.1["owned"], json!([{"grant":soul,"follow":null}]));
        worlds.finish_handoff(&p).unwrap();
        assert!(creator_worlds_of(&old, &app).unwrap().is_empty());
        assert_eq!(
            creator_worlds_of(&new, &app).unwrap(),
            vec![to_hex(&name.lineage)]
        );
        assert_eq!(
            route(&request("first"), &app).1["owned"],
            pending.1["owned"]
        );
        assert_eq!(
            route(&request("next"), &app).1["owned"],
            json!([{"grant":new,"follow":null}])
        );
        assert_eq!(
            app.store.grants(&a.account).unwrap().len(),
            2,
            "global grant history was not deleted"
        );
    }
}
