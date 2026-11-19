//! The owner's messages (Engine v2 R13, #2753): the gateway's half of the mailbox the directory keeps
//! (`directoryd/src/accounts/mailbox.rs`). Every [`POLL`] it reads the open messages and gives each, once, to its
//! Soul's signed-in socket as a text frame `{"mail": {"id", "text", "at"}}`; the Soul's daemon answers
//! `{"close": {"id", "state", "outcome"}}` when the act that served it ends, and the gateway passes that on for the
//! socket's own grant alone. A message never enters the world's stream or its log, and its text is never logged.
//!
//! The gateway reads no JSON: the directory answers a line per open message, `<soul> <id> <text frame>`, and takes
//! a close as the socket sent it, with the socket's grant in a `souls-soul` header.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::Gateway;
use crate::token::Grant;

/// How often the open messages are read: a message reaches a reader within about this long.
pub const POLL: Duration = Duration::from_secs(1);
/// The longest answer read from the directory.
const ANSWER_MOST: u64 = 4 << 20;
/// The longest frame passed on: a close, or a prayer or an answer (G11; the directory reads at most 40,000 bytes).
const CLOSE_MOST: usize = 40_000;
/// The frames passed on to the directory by their first key, and where; G11's prayers are answered back.
const PASSED: [(&str, &str); 4] = [
    ("{\"close\"", "close"),
    ("{\"pray\"", "pray"),
    ("{\"prayers\"", "prayers"),
    ("{\"answer\"", "answer"),
];

/// The directory's address (`host:port`) and the key its mailbox requests take.
pub struct Mailbox {
    pub addr: String,
    pub key: String,
}

/// One request to the directory over HTTP/1.1; its body if it was a 200.
async fn http(mb: &Mailbox, method: &str, path: &str, soul: &str, body: &str) -> Option<String> {
    let mut s = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&mb.addr))
        .await
        .ok()?
        .ok()?;
    let soul = if soul.is_empty() {
        String::new()
    } else {
        format!("souls-soul: {soul}\r\n")
    };
    let req = format!(
        "{method} {path} HTTP/1.1\r\nhost: {}\r\nauthorization: Bearer {}\r\n{soul}content-type: application/json\r\n\
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
    head.starts_with("HTTP/1.1 200").then(|| body.to_owned())
}

/// The directory's open lines as `(grant key, id, text frame)`; a line not in the form is skipped.
pub fn read_open(lines: &str) -> Vec<(Vec<u8>, String, String)> {
    lines
        .lines()
        .filter_map(|l| {
            let mut w = l.splitn(3, ' ');
            let (soul, id, frame) = (w.next()?, w.next()?, w.next()?);
            Some((Grant::parse(soul)?.key(), id.to_owned(), frame.to_owned()))
        })
        .collect()
}

/// Reads the open messages every [`POLL`] and posts them to the signed-in sockets, while a mailbox is set.
pub async fn run(gw: Arc<Gateway>) {
    loop {
        if let Some(mb) = gw.mailbox.get()
            && let Some(lines) = http(mb, "GET", "/v1/mailbox/open", "", "").await
        {
            gw.post_mail(read_open(&lines));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// A text frame from `grant`'s socket: a close, passed to the directory for that grant alone (the directory reads
/// it, and ignores anything else).
pub fn on_text(gw: &Arc<Gateway>, grant: Grant, text: &str) {
    let Some((_, path)) = PASSED.iter().find(|(p, _)| text.starts_with(p)) else {
        return;
    };
    if text.len() > CLOSE_MOST {
        return;
    }
    let (gw, soul, body) = (gw.clone(), grant.to_text(), text.to_owned());
    tokio::spawn(async move {
        let Some(mb) = gw.mailbox.get() else { return };
        match http(mb, "POST", &format!("/v1/mailbox/{path}"), &soul, &body).await {
            Some(reply) if *path != "close" => gw.post_text(&grant.key(), reply),
            Some(_) => {}
            None => (gw.log)("a mailbox frame was not taken by the directory"),
        }
    });
}
