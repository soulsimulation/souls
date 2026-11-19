//! The sign-in requests over HTTP (W1), on a plain listener: a thread per connection, one request each.
//!
//! - `POST /v1/account/session` with `Authorization: Bearer <session token>`: the token checked
//!   ([`super::session`]), then the account and principal for its (issuer, subject), made on the first sign-in.
//! - `POST /v1/account/test-sign-in` with `{"name": "<test person>"}`: only with the sign-in for test worlds on.
//!
//! Each answers `{"account", "principal"}`. The log line of a request holds its method, path, status and either the
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
    pub body: Vec<u8>,
}

fn read(stream: &TcpStream) -> Option<Request> {
    let mut r = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut words = line.split_whitespace();
    let method = words.next()?.to_string();
    let path = words.next()?.split('?').next()?.to_string();
    let (mut bearer, mut length) = (None, 0usize);
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
        }
    }
    let mut body = vec![0; length];
    r.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        bearer,
        body,
    })
}

fn handle(mut stream: TcpStream, app: &App) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let Some(req) = read(&stream) else {
        let _ = respond(&mut stream, 400, &json!({"refused": "request"}), "no-store");
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
        (status, "application/json", body.to_string(), note)
    });
    // The world list may be cached a short while (W3, #2799); everything else is no-store.
    let list = req.method == "GET" && req.path == "/v1/worlds" && status == 200;
    let cache = if list {
        crate::worlds::list::http::CACHE
    } else {
        "no-store"
    };
    let _ = respond_as(&mut stream, status, kind, &body, cache);
    let line = format!("directoryd: {} {} {status} {note}\n", req.method, req.path);
    let _ = app.log.lock().expect("the log").write_all(line.as_bytes());
}

fn route(req: &Request, app: &App) -> (u16, Value, String) {
    let refuse = |status, name: &str| (status, json!({"refused": name}), name.to_string());
    let (issuer, subject) = match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/healthz") => return (200, json!({"ok": true}), "ok".into()),
        ("GET" | "POST", "/v1/worlds") => return crate::worlds::list::http::route(req, app),
        ("POST", "/v1/worlds/settings") => return crate::worlds::list::http::settings(req, app),
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

fn respond(stream: &mut TcpStream, status: u16, body: &Value, cache: &str) -> std::io::Result<()> {
    respond_as(stream, status, "application/json", &body.to_string(), cache)
}

fn respond_as(
    stream: &mut TcpStream,
    status: u16,
    kind: &str,
    body: &str,
    cache: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
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
         cache-control: {cache}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}
