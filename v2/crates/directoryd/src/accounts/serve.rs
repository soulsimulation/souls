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
//! The first two answer `{"account", "principal"}`. Answers carry `cache-control: no-store` and may be read by the
//! page's own origin alone (CORS). The log line of a request holds its method, path, status and either the
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
    body: Vec<u8>,
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
        let _ = respond(
            &mut stream,
            400,
            &json!({"refused": "request"}),
            app.origin.as_deref(),
        );
        return;
    };
    let (status, body, note) = route(&req, app);
    let _ = respond(&mut stream, status, &body, app.origin.as_deref());
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

fn route(req: &Request, app: &App) -> (u16, Value, String) {
    let refuse = |status, name: &str| (status, json!({"refused": name}), name.to_string());
    let path = req.path.as_str();
    let signed = match (req.method.as_str(), path) {
        ("GET", "/healthz") => return (200, json!({"ok": true}), "ok".into()),
        // The page's preflight for a request from its own origin (CORS): headers alone.
        ("OPTIONS", _) => return (204, Value::Null, "preflight".into()),
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
    origin: Option<&str>,
) -> std::io::Result<()> {
    let body = if body.is_null() {
        String::new()
    } else {
        body.to_string()
    };
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
        404 => "Not Found",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\
         cache-control: no-store\r\n{cors}connection: close\r\n\r\n{body}",
        body.len()
    )
}
