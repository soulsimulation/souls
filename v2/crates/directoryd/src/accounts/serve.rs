//! The sign-in requests over HTTP (W1), on a plain listener: a thread per connection, one request each.
//!
//! - `POST /v1/account/session` with `Authorization: Bearer <session token>`: the token checked
//!   ([`super::session`]), then the account and principal for its (issuer, subject), made on the first sign-in.
//! - `POST /v1/account/test-sign-in` with `{"name": "<test person>"}`: only with the sign-in for test worlds on.
//!
//! Each answers `{"account", "principal"}`. The mailbox's (R13, #2753; [`super::mailbox`]):
//!
//! - `GET /v1/mailbox/open` and `POST /v1/mailbox/close`, the gateway's, with `Authorization: Bearer <the
//!   --mailbox-key>`. The first answers in plain text, a line per open message: `<soul> <id> <text frame>`, the
//!   frame the gateway gives the Soul's socket as it is (`{"mail": {"id", "text", "at"}}`). The second's body is the
//!   socket's own `{"close": {"id", "state", "outcome"}}`, with the socket's grant in a `souls-soul` header. So the
//!   gateway reads no JSON.
//! - `POST /v1/mailbox/put` `{"soul", "text"}` and `POST /v1/mailbox/read` `{"id"}`: the test call that stands in
//!   for the page's box (W10) until it lands, with the sign-in for test worlds on only.
//!
//! A message's text is never in a log line. The log line of a request holds its method, path, status and either the
//! refusal's name or a short hash of the account id: never a token, a header, a subject, a name or an email.

use super::session::Verifier;
use super::start::TEST_ISSUER;
use super::store::Store;
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
    /// The SHA-256 of the gateway's mailbox key ([`key_digest`]); the gateway's mailbox requests are off without it.
    pub mailbox_key: Option<Vec<u8>>,
    pub log: Mutex<Box<dyn Write + Send>>,
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

struct Request {
    method: String,
    path: String,
    bearer: Option<String>,
    /// The gateway's `souls-soul` header on a mailbox close: the grant of the socket it came from.
    soul: Option<String>,
    body: Vec<u8>,
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
        let _ = respond(&mut stream, 400, &json!({"refused": "request"}));
        return;
    };
    let (status, body, note) = route(&req, app);
    let _ = respond(&mut stream, status, &body);
    let line = format!("directoryd: {} {} {status} {note}\n", req.method, req.path);
    let _ = app.log.lock().expect("the log").write_all(line.as_bytes());
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
    let (issuer, subject) = match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/healthz") => return (200, json!({"ok": true}), "ok".into()),
        ("POST", "/v1/account/session") => {
            let Some(v) = &app.verifier else {
                return refuse(404, "no-provider");
            };
            let Some(token) = &req.bearer else {
                return refuse(401, "token-missing");
            };
            match v.verify(token, now()) {
                Ok(s) => (s.issuer, s.subject),
                Err(r) => return refuse(401, r.name()),
            }
        }
        ("POST", "/v1/account/test-sign-in") if app.test_sign_in => {
            let name = serde_json::from_slice::<Value>(&req.body)
                .ok()
                .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_string));
            match name {
                Some(n)
                    if (1..=64).contains(&n.len())
                        && n.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_. ".contains(&b)) =>
                {
                    (TEST_ISSUER.to_string(), n)
                }
                _ => return refuse(400, "test-name"),
            }
        }
        _ => return refuse(404, "not-found"),
    };
    match app.store.sign_in(&issuer, &subject, now()) {
        Ok(a) => (
            200,
            json!({"account": a.account, "principal": principal_text(a.principal)}),
            format!("account#{}", correlate(&a.account)),
        ),
        Err(_) => refuse(500, "store"),
    }
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    // A text answer (the mailbox's open lines) is written as it is.
    let (body, kind) = match body {
        Value::String(s) => (s.clone(), "text/plain; charset=utf-8"),
        v => (v.to_string(), "application/json"),
    };
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\n\
         cache-control: no-store\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}
