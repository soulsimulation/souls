//! The owner's messages (Engine v2 R13, #2753): the gateway's half of the mailbox the directory keeps
//! (`directoryd/src/accounts/mailbox.rs`). Every [`POLL`] it reads the open messages and gives each, once, to its
//! Soul's signed-in socket as a text frame `{"mail": {"id", "text", "at"}}`; the Soul's daemon answers
//! `{"close": {"id", "state", "outcome"}}` when the act that served it ends, and the gateway passes that on for the
//! socket's own grant alone. A message never enters the world's stream or its log, and its text is never logged.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::Gateway;
use crate::token::Grant;

/// How often the open messages are read: a message reaches a reader within about this long.
pub const POLL: Duration = Duration::from_secs(1);
/// The longest answer read from the directory.
const ANSWER_MOST: u64 = 4 << 20;

/// The directory's address (`host:port`) and the key its mailbox requests take.
pub struct Mailbox {
    pub addr: String,
    pub key: String,
}

/// One request to the directory over HTTP/1.1; its JSON answer if it was a 200.
async fn http(mb: &Mailbox, method: &str, path: &str, body: Option<&Value>) -> Option<Value> {
    let body = body.map(Value::to_string).unwrap_or_default();
    let mut s = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&mb.addr))
        .await
        .ok()?
        .ok()?;
    let req = format!(
        "{method} {path} HTTP/1.1\r\nhost: {}\r\nauthorization: Bearer {}\r\ncontent-type: application/json\r\n\
         content-length: {}\r\nconnection: close\r\n\r\n{body}",
        mb.addr,
        mb.key,
        body.len()
    );
    s.write_all(req.as_bytes()).await.ok()?;
    let mut out = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(5),
        s.take(ANSWER_MOST).read_to_end(&mut out),
    )
    .await
    .ok()?
    .ok()?;
    let text = String::from_utf8(out).ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    serde_json::from_str(body).ok()
}

/// Reads the open messages every [`POLL`] and posts them to the signed-in sockets, while a mailbox is set.
pub async fn run(gw: Arc<Gateway>) {
    loop {
        if let Some(mb) = gw.mailbox.get()
            && let Some(answer) = http(mb, "GET", "/v1/mailbox/open", None).await
        {
            let open = answer
                .get("messages")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|m| {
                    let grant = Grant::parse(m.get("soul")?.as_str()?)?;
                    let id = m.get("id")?.as_str()?.to_owned();
                    let frame =
                        json!({"mail": {"id": id, "text": m.get("text")?, "at": m.get("at")?}});
                    Some((grant.key(), id, frame.to_string()))
                })
                .collect();
            gw.post_mail(open);
        }
        tokio::time::sleep(POLL).await;
    }
}

/// A text frame from `grant`'s socket: a close, passed to the directory for that grant alone. Anything else is
/// ignored.
pub fn on_text(gw: &Arc<Gateway>, grant: Grant, text: &str) {
    let Some(close) = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("close").cloned())
    else {
        return;
    };
    let field = |k: &str| {
        close
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let body = json!({"id": field("id"), "soul": grant.to_text(), "state": field("state"), "outcome": field("outcome")});
    let gw = gw.clone();
    tokio::spawn(async move {
        if let Some(mb) = gw.mailbox.get()
            && http(mb, "POST", "/v1/mailbox/close", Some(&body))
                .await
                .is_none()
        {
            (gw.log)("a message's close was not taken by the directory");
        }
    });
}
