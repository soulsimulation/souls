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
//! - `POST /v1/mailbox/put` `{"soul", "text"}` and `POST /v1/mailbox/read` `{"id"}`: the test call that stands in
//!   for the page's box (W10) until it lands, with the sign-in for test worlds on only.
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
    for stream in listener.incoming().flatten() {
        let app = app.clone();
        std::thread::spawn(move || handle(stream, &app));
    }
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub bearer: Option<String>,
    /// The gateway's `souls-soul` header on a mailbox close: the grant of the socket it came from.
    pub soul: Option<String>,
    pub body: Vec<u8>,
}

fn read(stream: &TcpStream) -> Option<Request> {
    let mut r = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut words = line.split_whitespace();
    let method = words.next()?.to_string();
    let path = words.next()?.split('?').next()?.to_string();
    let (mut bearer, mut soul, mut length) = (None, None, 0usize);
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
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse().ok().filter(|n| *n <= BODY_MOST)?;
        } else if name.eq_ignore_ascii_case("authorization") {
            bearer = value.strip_prefix("Bearer ").map(str::to_string);
        } else if name.eq_ignore_ascii_case("souls-soul") {
            soul = Some(value.to_string());
        }
    }
    let mut body = vec![0; length];
    r.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        bearer,
        soul,
        body,
    })
}

fn handle(mut stream: TcpStream, app: &App) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Some(req) = read(&stream) else {
        let _ = respond(
            &mut stream,
            400,
            &json!({"refused": "request"}),
            "no-store",
            app.origin.as_deref(),
        );
        return;
    };
    let (status, kind, body, note) = crate::pairing::route::route(
        app,
        &req.method,
        &req.path,
        req.bearer.as_deref(),
        &req.body,
    )
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
                (200, Value::String(lines), format!("{} open", m.len()))
            }
            Err(e) => store(e),
        }),
        ("POST", "/v1/mailbox/close") if gateway() => {
            let b = body().get("close").cloned().unwrap_or(Value::Null);
            let (id, soul) = (text(&b, "id"), req.soul.clone().unwrap_or_default());
            Some(
                match app.store.mail_close(
                    &id,
                    &soul,
                    &text(&b, "state"),
                    &text(&b, "outcome"),
                    now(),
                ) {
                    Ok(closed) => (200, json!({"closed": closed}), format!("closed {closed}")),
                    Err(e) => store(e),
                },
            )
        }
        ("GET", "/v1/mailbox/open") | ("POST", "/v1/mailbox/close") => refuse(401, "mailbox-key"),
        ("POST", "/v1/mailbox/put") if app.test_sign_in => {
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
        Ok(g) if !g.is_empty() => g,
        Ok(_) => return refuse(404, "nothing-owned"),
        Err(_) => return refuse(500, "store"),
    };
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
