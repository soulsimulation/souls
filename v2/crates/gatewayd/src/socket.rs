//! One agent's socket (Engine v2 I1, #2683): WebSocket through axum's upgrade, one task and one bounded outbound
//! queue per socket. The order on a socket: T10's first frame each way (`v2/docs/intents.md` rule 12), then sign-in
//! (by the `authorization: Bearer` header, or the client's first message after its first frame, since a browser
//! cannot set headers), then the sign-in's outcome and any frames resumed, then intents in and the stream out.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, from_hex};
use replica::intent_decode::{LIMITS, decode as decode_intent};
use replica::intents::{Answer, PROTOCOL, answer_hello};

use crate::Gateway;
use crate::receipts::{Outcome, Who};
use crate::times;
use crate::token::{self, Grant, Token};
use crate::world_link::{RESTARTING, Sent, sync_refused};
use replica::sync::wire;
use std::collections::BTreeMap;

/// Where agents connect.
pub const PATH: &str = "/v2/ws";

/// tungstenite's read buffer per socket. Its default is 128 KiB; one benchmark's peak went from 106 to 908 MB between
/// two releases (tungstenite-rs#480), so it is set small and measured (the idle-socket memory in I1's table).
const READ_BUFFER: usize = 4096;
/// The largest message a client may send: an intent's frame limit, from the limits file (I2, #2689). A sign-in is far
/// smaller. tungstenite refuses a longer frame from its header's length, before reading or reserving its payload.
const MESSAGE_MOST: usize = LIMITS.frame_bytes as usize;
/// How long a socket has to send its first frame and to sign in.
const SIGN_IN_WITHIN: Duration = Duration::from_secs(10);

/// The gateway's HTTP routes: the agents' socket.
pub fn router(gw: Arc<Gateway>) -> Router {
    Router::new().route(PATH, get(upgrade)).with_state(gw)
}

async fn upgrade(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(gw): State<Arc<Gateway>>,
) -> Response {
    // Read into a token at once: its text is never formatted (token.rs).
    let header_token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(Token::parse);
    let header_cursor = headers
        .get("souls-cursor")
        .and_then(|v| v.to_str().ok())
        .and_then(|hex| from_hex(hex).ok())
        .and_then(|bytes| decode(&bytes).ok())
        .map(|d| d.value);
    // Which client, for the receipts file: its own header, else the browser's.
    let client = ["souls-client", "user-agent"]
        .iter()
        .find_map(|h| headers.get(*h).and_then(|v| v.to_str().ok()))
        .map(str::to_owned);
    ws.read_buffer_size(READ_BUFFER)
        .write_buffer_size(0)
        .max_write_buffer_size(64 * 1024)
        .max_message_size(MESSAGE_MOST)
        .max_frame_size(MESSAGE_MOST)
        .on_upgrade(move |socket| async move {
            serve(gw, socket, header_token, header_cursor, client).await;
        })
}

fn control(name: &str) -> Vec<u8> {
    let name = Name::new(name).unwrap_or_else(|| unreachable!("a fixed name"));
    encode(&Value::Map([(4, Value::Text(name))].into())).unwrap_or_default()
}

/// An answer the gateway gives itself: `{2: answer}`, with no version, not kept for a resume.
fn own_answer(answer: Answer) -> Vec<u8> {
    encode(&Value::Map([(2, answer.to_value())].into())).unwrap_or_default()
}

/// A refusal the gateway gives itself, by name.
pub fn refused(actor: Actor, sequence: u64, reason: &str, now: Value) -> Vec<u8> {
    own_answer(Answer::Refused {
        actor,
        sequence,
        reason: Name::new(reason).unwrap_or_else(|| unreachable!("a fixed name")),
        now,
        changed: Vec::new(),
    })
}

/// The next binary message, or `None` if the socket ends or sends anything else first.
async fn next_binary(socket: &mut WebSocket) -> Option<Vec<u8>> {
    loop {
        match socket.recv().await? {
            Ok(Message::Binary(b)) => return Some(b.to_vec()),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            _ => return None,
        }
    }
}

async fn send(socket: &mut WebSocket, frame: Vec<u8>) -> bool {
    socket.send(Message::Binary(frame.into())).await.is_ok()
}

/// The sign-in message: `{1: token, 2: cursor}`.
fn read_sign_in(bytes: &[u8]) -> (Option<Token>, Option<Value>) {
    let Ok(d) = decode(bytes) else {
        return (None, None);
    };
    let Value::Map(m) = d.value else {
        return (None, None);
    };
    let token = match m.get(&1) {
        Some(Value::Text(t)) => Token::parse(t.as_str()),
        _ => None,
    };
    (token, m.get(&2).cloned())
}

async fn serve(
    gw: Arc<Gateway>,
    mut socket: WebSocket,
    header_token: Option<Option<Token>>,
    header_cursor: Option<Value>,
    client: Option<String>,
) {
    // 1. The first frame each way (T10 rule 12): the client's, then the gateway's for its world.
    let Ok(Some(first)) = tokio::time::timeout(SIGN_IN_WITHIN, next_binary(&mut socket)).await
    else {
        return;
    };
    let Ok(hello) = answer_hello(&first, PROTOCOL, &gw.build) else {
        return;
    };
    let refused_version =
        replica::intents::Hello::read(&first).is_ok_and(|h| h.protocol != PROTOCOL);
    if !send(&mut socket, hello).await || refused_version {
        return;
    }

    // 2. Sign-in, after the first frame, never in it.
    let (token, cursor) = match header_token {
        Some(t) => (t, header_cursor),
        None => match tokio::time::timeout(SIGN_IN_WITHIN, next_binary(&mut socket)).await {
            Ok(Some(bytes)) => read_sign_in(&bytes),
            _ => return,
        },
    };
    if let Some(f) = gw.tokens_file.get() {
        f.refresh(&gw.tokens);
    }
    let signed = token.and_then(|t| {
        let tokens = gw.tokens.read().unwrap_or_else(|e| e.into_inner());
        let grant = tokens.check(&t)?;
        Some((grant, tokens.account(grant).map(str::to_owned)))
    });
    let Some((grant, account)) = signed else {
        (gw.log)("a sign-in was refused");
        let _ = send(&mut socket, control(token::REFUSED)).await;
        return;
    };
    let Grant::Actor(actor) = grant;
    let who = Arc::new(Who::new(
        grant.to_text(),
        account.as_deref(),
        client.as_deref(),
    ));

    // 3. The outcome, and the kept frames after the cursor.
    let mut attached = gw.attach(grant, cursor.as_ref(), who.clone());
    let mut ok = send(&mut socket, control(attached.outcome)).await;
    for frame in std::mem::take(&mut attached.replay) {
        ok = ok && send(&mut socket, times::finish(frame)).await;
    }

    // 4. Intents in, the stream out.
    while ok {
        tokio::select! {
            incoming = socket.recv() => {
                let received = times::stamp();
                let bytes = match incoming {
                    Some(Ok(Message::Binary(b))) => b.to_vec(),
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    _ => break,
                };
                if let Some(answer) = take_intent(&gw, actor, grant, bytes, received) {
                    gw.receipts.write(&who, Outcome::Refusal);
                    ok = send(&mut socket, answer).await;
                }
            }
            out = attached.frames.recv() => match out {
                Some(frame) => ok = send(&mut socket, times::finish(frame)).await,
                // Another socket signed in for this grant, or this one fell too far behind.
                None => break,
            },
        }
    }
    gw.detach(grant, attached.session);
}

/// Reads an intent and hands it to the world; the gateway's own answer, if it gives one (always a refusal).
fn take_intent(
    gw: &Gateway,
    actor: Actor,
    grant: Grant,
    bytes: Vec<u8>,
    received: u64,
) -> Option<Vec<u8>> {
    // A sync request (R5b, `replica::sync::wire`), not an intent: to the world, for this grant's actor.
    if let Ok(d) = decode(&bytes)
        && let Value::Map(mut m) = d.value
        && let Some(n) = m.remove(&wire::ASK)
    {
        let ask: BTreeMap<u64, Value> = m
            .into_iter()
            .filter(|(k, _)| *k == wire::IDS || *k == wire::RECORDS)
            .collect();
        return match gw.link.ask(grant.key(), n.clone(), ask) {
            Sent::Sent => None,
            Sent::Restarting => Some(sync_refused(n, RESTARTING)),
        };
    }
    let intent = match decode_intent(&bytes) {
        Ok(i) => i,
        Err(r) => {
            let reason = Name::new(r.name).unwrap_or_else(|| unreachable!("a refusal's name"));
            return Some(own_answer(Answer::Unread { reason }));
        }
    };
    if intent.actor != actor {
        return Some(refused(
            intent.actor,
            intent.sequence,
            "intent-not-granted",
            gw.link.now(),
        ));
    }
    let left = intent.expiry.saturating_sub(unix_us());
    match gw
        .link
        .submit(grant.key(), actor, intent.sequence, bytes, received, left)
    {
        Sent::Sent => None,
        Sent::Restarting => Some(refused(actor, intent.sequence, RESTARTING, gw.link.now())),
    }
}

/// The wall clock, µs from the Unix epoch: an intent's expiry is world time, which is real time (T5).
// The gateway's one wall-clock read: how long an intent has left (C8, #3396). The gateway is not the engine.
#[allow(clippy::disallowed_methods)]
fn unix_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}
