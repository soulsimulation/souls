//! The owner's messages (Engine v2 R13, #2753): the gateway's half of the mailbox the directory keeps
//! (`directoryd/src/accounts/mailbox.rs`). Every [`POLL`] it reads the open messages and gives each, once, to its
//! Soul's signed-in socket as a text frame `{"mail": {"id", "text", "at"}}`; the Soul's daemon answers
//! `{"close": {"id", "state", "outcome"}}` when the act that served it ends, and the gateway passes that on for the
//! socket's own grant alone. A message never enters the world's stream or its log, and its text is never logged.
//!
//! The gateway reads no JSON: the directory answers a line per open message, `<soul> <id> <text frame>`, and takes
//! a close as the socket sent it, with the socket's grant in a `souls-soul` header.
//!
//! The owner's box (W10, #2802): a page's view socket puts a message for a grant its view token holds
//! ([`on_view_text`]; a Soul's, or a world's creator's), and every view socket whose token holds that grant is told,
//! as text frames, when the agent's socket was given it, each intent the agent sent while it was open with the phase
//! of its answer (I4's own: the envelope gains no field), the agent's interim notes (#3781) and its close. No other
//! socket is told anything.
//! Nothing here makes an agent act.

use std::sync::Arc;
use std::time::Duration;

use replica::encode::{Value, decode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::Gateway;
use crate::token::Grant;

/// How often the open messages are read: a message reaches a reader within about this long.
pub const POLL: Duration = Duration::from_secs(1);
/// The longest answer read from the directory.
const ANSWER_MOST: u64 = 4 << 20;
/// The longest frame passed on: a close, or a prayer or an answer (G11; the directory reads at most 40,000 bytes).
const CLOSE_MOST: usize = 40_000;
/// The frames passed on to the directory by their first key, and where; G11's prayers are answered back.
const PASSED: [(&str, &str); 5] = [
    ("{\"close\"", "close"),
    ("{\"pray\"", "pray"),
    ("{\"prayers\"", "prayers"),
    ("{\"answer\"", "answer"),
    ("{\"now\"", "now"),
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
/// it, and ignores anything else). Once the directory closed the message, the close goes to the view sockets that
/// watch that grant (W10) as the agent sent it.
pub fn on_text(gw: &Arc<Gateway>, grant: Grant, text: &str) {
    if text.len() > CLOSE_MOST {
        return;
    }
    if text.starts_with("{\"note\"") {
        return note(gw, &grant, text);
    }
    let Some((_, path)) = PASSED.iter().find(|(p, _)| text.starts_with(p)) else {
        return;
    };
    let (gw, soul, body) = (gw.clone(), grant.to_text(), text.to_owned());
    tokio::spawn(async move {
        let Some(mb) = gw.mailbox.get() else {
            return;
        };
        match http(mb, "POST", &format!("/v1/mailbox/{path}"), &soul, &body).await {
            Some(reply) if *path != "close" => gw.post_text(&grant.key(), reply),
            Some(reply) if reply.contains("\"closed\":true") => {
                gw.tell_watchers(&grant.key(), body)
            }
            Some(_) => {}
            None => (gw.log)("a mailbox frame was not taken by the directory"),
        }
    });
}

/// An agent's interim note on an open message (#3781): `{"note":{"id":"<id>","reply":".."}}`, told as it was sent to
/// the view sockets that watch `grant`, while the message is one given to that grant and still open. It goes nowhere
/// else: the directory is not told, and the message stays open.
fn note(gw: &Gateway, grant: &Grant, text: &str) {
    let Some((id, _)) = text
        .strip_prefix("{\"note\":{\"id\":\"")
        .and_then(|t| t.split_once('"'))
    else {
        return;
    };
    let key = grant.key();
    let open = id_like(id)
        && gw
            .hub
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .grants
            .get(&key)
            .is_some_and(|held| held.mailed.contains(id));
    if open {
        gw.tell_watchers(&key, text.to_owned());
    }
}

/// The longest message a page puts, in bytes (the directory's `TEXT_MOST`).
pub const PUT_MOST: usize = 2000;

/// A text frame from a page's view socket whose token holds `grants` (W10, #2802): `put <grant>\n<words>`, a message
/// for one of those grants, put in the directory's mailbox. The page is answered `{"sent": {"id"}}`, or `{"sent":
/// {"refused": name}}`: `not-yours` for a grant its token does not hold, `mail-form` for empty or long words,
/// `no-mailbox` with none set, `not-taken` when the directory did not take it. Its words are never logged.
pub fn on_view_text(gw: &Arc<Gateway>, grants: &[Grant], text: &str, reply: mpsc::Sender<String>) {
    let refused = |name: &str| format!(r#"{{"sent":{{"refused":"{name}"}}}}"#);
    let Some((to, words)) = text.strip_prefix("put ").and_then(|t| t.split_once('\n')) else {
        return;
    };
    let answer = match Grant::parse(to) {
        Some(g) if grants.contains(&g) => None,
        _ => Some(refused("not-yours")),
    }
    .or_else(|| (words.trim().is_empty() || words.len() > PUT_MOST).then(|| refused("mail-form")))
    .or_else(|| gw.mailbox.get().is_none().then(|| refused("no-mailbox")));
    if let Some(a) = answer {
        let _ = reply.try_send(a);
        return;
    }
    let (gw, body) = (
        gw.clone(),
        format!(r#"{{"soul":"{to}","text":{}}}"#, json_string(words)),
    );
    tokio::spawn(async move {
        let Some(mb) = gw.mailbox.get() else { return };
        let answer = match http(mb, "POST", "/v1/mailbox/put", "", &body).await {
            Some(b) if b.starts_with("{\"id\":\"") => format!(r#"{{"sent":{b}}}"#),
            _ => refused("not-taken"),
        };
        let _ = reply.try_send(answer);
    });
}

/// The owner's box's presence frame: whether a socket is signed in for `grant` (its agent's client is connected),
/// `{"agent":{"grant":"<grant>","connected":true}}`. Told only to view sockets whose token holds the grant.
pub fn agent(grant: Grant, connected: bool) -> String {
    format!(
        r#"{{"agent":{{"grant":"{}","connected":{connected}}}}}"#,
        grant.to_text()
    )
}

/// Text as a JSON string: quotes, backslashes and control characters escaped.
pub fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The key of the world's frame of Souls' wind-down words (#3784; worldd's `answers::STATES`).
pub const STATES: u64 = 30;

/// The frame that asks the world for its Souls' words (worldd's `answers::states_ask`): `{30: []}`. Sent on each
/// connection to the world when a mailbox is set.
pub fn states_ask() -> Vec<u8> {
    replica::encode::encode(&Value::Map(std::collections::BTreeMap::from([(
        STATES,
        Value::Array(Vec::new()),
    )])))
    .unwrap_or_default()
}

/// The body the directory takes for a frame of Souls' wind-down words, `{"states": {grant: word}}`, or None when the
/// frame is not one. Rows whose grant or word does not read are passed over.
pub fn states_body(frame: &[u8]) -> Option<String> {
    let Value::Map(m) = decode(frame).ok()?.value else {
        return None;
    };
    let Some(Value::Array(rows)) = m.get(&STATES) else {
        return None;
    };
    let words: Vec<String> = rows
        .iter()
        .filter_map(|row| {
            let Value::Array(r) = row else { return None };
            let (Some(Value::Bytes(g)), Some(Value::Text(w))) = (r.first(), r.get(1)) else {
                return None;
            };
            let grant = std::str::from_utf8(g)
                .ok()
                .filter(|g| Grant::parse(g).is_some())?;
            Some(format!(
                "{}:{}",
                json_string(grant),
                json_string(w.as_str())
            ))
        })
        .collect();
    Some(format!("{{\"states\":{{{}}}}}", words.join(",")))
}

/// #3784: passes a frame of the world's Souls' wind-down words on to the directory (`POST /v1/mailbox/state`), when
/// a mailbox is set; true when the frame was one. The world sends only changes, and all of them on each connection,
/// so one lost while the directory is away comes again when the world next connects.
pub fn on_states(gw: &Arc<Gateway>, frame: &[u8]) -> bool {
    let Some(body) = states_body(frame) else {
        return false;
    };
    if let Some(mb) = gw.mailbox.get().filter(|_| body != "{\"states\":{}}") {
        let mb = Mailbox {
            addr: mb.addr.clone(),
            key: mb.key.clone(),
        };
        tokio::spawn(async move {
            let _ = http(&mb, "POST", "/v1/mailbox/state", "", &body).await;
        });
    }
    true
}

/// A message id as the directory makes them (`m_<hex>`), safe to write into a frame as it is.
pub fn id_like(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// W10's `{"doing": …}` frame: an intent of the agent's, by sequence and verb, at a phase, with the outcome's name.
pub fn doing(sequence: u64, verb: &str, phase: &str, outcome: Option<&str>) -> String {
    let outcome = outcome.map_or(String::new(), |o| format!(r#","outcome":"{o}""#));
    format!(r#"{{"doing":{{"seq":{sequence},"verb":"{verb}","phase":"{phase}"{outcome}}}}}"#)
}

/// What a frame of the stream answers (`{1: version, 2: answer}`): the intent's sequence, its phase (I4: `receipt`,
/// `refused`, `accepted` or `resolved`) and, for a refusal or a resolution, the reason's or outcome's name.
pub fn phase_of(frame: &[u8]) -> Option<(u64, &'static str, Option<String>)> {
    let Value::Map(mut m) = decode(frame).ok()?.value else {
        return None;
    };
    let Some(Value::Map(mut a)) = m.remove(&2) else {
        return None;
    };
    let Some(Value::Uint(sequence)) = a.remove(&2) else {
        return None;
    };
    let named = |v: Option<Value>| match v {
        Some(Value::Text(n)) => Some(n.as_str().to_owned()),
        _ => None,
    };
    match a.remove(&3)? {
        Value::Uint(1) => Some((sequence, "receipt", None)),
        Value::Uint(2) => Some((sequence, "refused", named(a.remove(&4)))),
        Value::Uint(3) => Some((sequence, "accepted", None)),
        Value::Uint(4) => Some((sequence, "resolved", named(a.remove(&4)))),
        _ => None,
    }
}

#[cfg(test)]
mod states_tests {
    use super::*;
    use replica::encode::{Name, encode};
    use std::collections::BTreeMap;

    #[test]
    fn a3784_the_worlds_words_become_the_directorys_body() {
        let grant = format!("soul-{}-3", "4d".repeat(16));
        let row = |g: &str, w: &str| {
            Value::Array(vec![
                Value::Bytes(g.as_bytes().to_vec()),
                Value::Text(Name::new(w).unwrap()),
            ])
        };
        let frame = encode(&Value::Map(BTreeMap::from([(
            STATES,
            Value::Array(vec![row(&grant, "asleep"), row("not-a-grant", "zombie")]),
        )])))
        .unwrap();
        assert_eq!(
            states_body(&frame).unwrap(),
            format!("{{\"states\":{{\"{grant}\":\"asleep\"}}}}")
        );
        let answer = encode(&Value::Map(BTreeMap::from([(1, Value::Uint(1))]))).unwrap();
        assert_eq!(
            states_body(&answer),
            None,
            "an answer is not a states frame"
        );
        assert_eq!(
            states_body(&states_ask()).as_deref(),
            Some("{\"states\":{}}"),
            "the ask reads as no words"
        );
    }
}
