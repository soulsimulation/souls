//! One agent's socket (Engine v2 I1, #2683): WebSocket through axum's upgrade, one task and one bounded outbound
//! queue per socket. The order on a socket: T10's first frame each way (`v2/docs/intents.md` rule 12), then sign-in
//! (by the `authorization: Bearer` header, or the client's first message after its first frame, since a browser
//! cannot set headers), then the sign-in's outcome and any frames resumed, then intents in and the stream out. A page
//! signed in with a view token (V13b) gets a view socket instead ([`serve_view`]).

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderMap, HeaderValue, Uri};
use axum::response::Response;
use axum::routing::{get, post};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, from_hex};
use replica::intent_decode::{LIMITS, decode as decode_intent};
use replica::intents::{Answer, PROTOCOL, answer_hello};

use crate::Gateway;
use crate::receipts::{Outcome, Who};
use crate::resume::Cursor;
use crate::times;
use crate::token::{self, Grant, Token, View, ViewToken};
use crate::views;
use crate::world_link::{FRAME_MOST, RESTARTING, Sent, sync_refused};
use replica::sync::wire;
use std::collections::BTreeMap;

/// A view socket's outcomes (V13b): signed in, renewed on the same socket, or expired unrenewed and closed.
pub const VIEW_STARTED: &str = "view.started";
pub const VIEW_RENEWED: &str = "view.renewed";
pub const VIEW_EXPIRED: &str = "view.expired";
/// A view socket was sent something other than a subscribe or a renewal: it watches and never acts.
pub const VIEW_ONLY: &str = "view.only";
/// A view socket fell further behind its stream than [`VIEW_BEHIND_MOST`] and was let go (#4078).
pub const VIEW_BEHIND: &str = "view.behind";

/// How far a view socket may fall behind its stream before it is let go, as [`VIEW_BEHIND`] (#4078). Measured by a
/// probe, a WebSocket ping its client answers only once it has read everything sent before it: a backlog held in the
/// kernel's buffers, which the socket's item queue never sees, counts. A send that waits this long counts too.
pub const VIEW_BEHIND_MOST: Duration = Duration::from_secs(10);
/// How often a view socket is probed, once its last probe was answered.
const VIEW_PROBE_EVERY: Duration = Duration::from_secs(2);
/// How long a view socket that fell behind is given to take its reason and close frame before it is dropped.
const VIEW_BEHIND_GRACE: Duration = Duration::from_secs(1);
/// The close code of a view socket that fell behind: 1013, Try Again Later. It rejoins as any new viewer does.
const VIEW_BEHIND_CODE: u16 = 1013;

/// A presented sign-in: an agent's token, or a page's view token (V13b, #3407).
enum Presented {
    Agent(Option<Token>),
    View(ViewToken),
}

fn presented(text: &str) -> Presented {
    match ViewToken::parse(text) {
        Some(v) => Presented::View(v),
        None => Presented::Agent(Token::parse(text)),
    }
}

/// Where agents connect.
pub const PATH: &str = "/v2/ws";

/// tungstenite's read buffer per socket. Its default is 128 KiB; one benchmark's peak went from 106 to 908 MB between
/// two releases (tungstenite-rs#480), so it is set small and measured (the idle-socket memory in I1's table).
const READ_BUFFER: usize = 4096;
/// The largest message a client may send: an intent's frame limit, from the limits file (I2, #2689). A sign-in is far
/// smaller. tungstenite refuses a longer frame from its header's length, before reading or reserving its payload.
const MESSAGE_MOST: usize = LIMITS.frame_bytes as usize;
/// The largest message the gateway may send: a frame from the world (a sync answer: one room's record lists each
/// child's hash, 36 bytes each), with the client's own request number in place of the gateway's and the WebSocket
/// header. tungstenite refuses to send a message over its write buffer's limit and the socket ends (1006 at the
/// client); at 64 KiB a first sync stopped at a room of about 1,800 children (#3424). It bounds one message in
/// flight, not memory held: each send is flushed before the next (`write_buffer_size(0)`).
const SEND_MOST: usize = FRAME_MOST + 64;
/// How long a socket has to send its first frame and to sign in.
const SIGN_IN_WITHIN: Duration = Duration::from_secs(10);

/// The gateway's HTTP routes: the agents' socket, the creator's session exchange (W5, `creator.rs`), the world's
/// entries (`entries.rs`), a creator's bulk edits (#3695, `bulk.rs`) and uploads (#3697, `uploads.rs`).
pub fn router(gw: Arc<Gateway>) -> Router {
    Router::new()
        .route(PATH, get(upgrade))
        .route(crate::creator::PATH, post(crate::creator::exchange))
        .route(crate::creator::HELPER_PATH, post(crate::creator::helper))
        .route(crate::entries::PATH, get(crate::entries::serve))
        .route(crate::entries::KINDS_PATH, get(crate::entries::serve_kinds))
        .route(
            crate::bulk::PATH,
            post(crate::bulk::submit).layer(crate::bulk::limit()),
        )
        .route(
            crate::uploads::PATH,
            post(crate::uploads::upload).layer(crate::uploads::limit()),
        )
        .route(crate::uploads::SERVE, get(crate::uploads::serve))
        .with_state(gw)
}

async fn upgrade(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    uri: Uri,
    State(gw): State<Arc<Gateway>>,
) -> Response {
    // Read into a token at once: its text is never formatted (token.rs).
    let header_token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(presented);
    let header_cursor = headers
        .get("souls-cursor")
        .and_then(|v| v.to_str().ok())
        .and_then(|hex| from_hex(hex).ok())
        .and_then(|bytes| decode(&bytes).ok())
        .map(|d| d.value);
    let header_seen = headers
        .get("souls-seen")
        .and_then(|v| v.to_str().ok())
        .and_then(|n| n.parse().ok());
    // Which client, for the receipts file: its own header, else the browser's.
    let client = ["souls-client", "user-agent"]
        .iter()
        .find_map(|h| headers.get(*h).and_then(|v| v.to_str().ok()))
        .map(str::to_owned);
    // A client another took the Soul from asks only if it is free (`?free=1`): it never takes it from a live socket.
    let free = uri
        .query()
        .is_some_and(|q| q.split('&').any(|p| p == crate::FREE));
    let mut res = ws
        .read_buffer_size(READ_BUFFER)
        .write_buffer_size(0)
        .max_write_buffer_size(SEND_MOST)
        .max_message_size(MESSAGE_MOST)
        .max_frame_size(MESSAGE_MOST)
        .on_upgrade(move |socket| async move {
            serve(
                gw,
                socket,
                header_token,
                (header_cursor, header_seen),
                client,
                free,
            )
            .await;
        });
    // The socket carries an owner's private view (V13, #2745): no cache keeps any response of it.
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn control(name: &str) -> Vec<u8> {
    let name = Name::new(name).unwrap_or_else(|| unreachable!("a fixed name"));
    encode(&Value::Map([(4, Value::Text(name))].into())).unwrap_or_default()
}

/// The sign-in's outcome, `{4: name}`, and on a Soul's grant whose intents were sent before, `5`: the newest sequence
/// sent for it (#4978). A client that took the Soul from another numbers its next intent after it.
fn outcome(name: &str, newest: u64) -> Vec<u8> {
    let name = Name::new(name).unwrap_or_else(|| unreachable!("a fixed name"));
    let mut m: BTreeMap<u64, Value> = [(4, Value::Text(name))].into();
    if newest > 0 {
        m.insert(5, Value::Uint(newest));
    }
    encode(&Value::Map(m)).unwrap_or_default()
}

/// An answer the gateway gives itself to bytes it could not read: `{2: answer}`, with no version, not kept.
fn own_answer(answer: Answer) -> Vec<u8> {
    encode(&Value::Map([(2, answer.to_value())].into())).unwrap_or_default()
}

/// A refusal the gateway gives itself, by name, as `{2: answer}`, not kept for a resume: C8's answer to an intent past
/// its deadline while the world is away (`world_link::deadlines`).
pub fn refused(actor: Actor, sequence: u64, reason: &str, now: Value) -> Vec<u8> {
    own_answer(Answer::Refused {
        actor,
        sequence,
        reason: Name::new(reason).unwrap_or_else(|| unreachable!("a fixed name")),
        now,
        changed: Vec::new(),
        op: None,
        detail: None,
    })
}

/// A refusal the gateway gives itself, at the newest version the world sent. Once the world has sent one, it is a
/// frame of the stream, `{1: version, 2: answer}`, kept for a resume like the world's own refusals, so one lost on a
/// drop is replayed; before any, it is `{2: answer}` and sent on this socket only.
fn refuse(
    gw: &Gateway,
    grant: Grant,
    actor: Actor,
    sequence: u64,
    reason: &str,
) -> Option<Vec<u8>> {
    let now = gw.link.now();
    let answer = Answer::Refused {
        actor,
        sequence,
        reason: Name::new(reason).unwrap_or_else(|| unreachable!("a fixed name")),
        now: now.clone(),
        changed: Vec::new(),
        op: None,
        detail: None,
    };
    let Some(at) = Cursor::from_value(&now) else {
        return Some(own_answer(answer));
    };
    let frame = encode(&Value::Map([(1, now), (2, answer.to_value())].into())).unwrap_or_default();
    // One line in the receipts file, as for a refusal sent at once.
    gw.record(&grant.key(), Outcome::Refusal);
    let a = crate::Answering {
        sequence,
        ends: true,
    };
    gw.deliver(grant.key(), a, at, frame);
    None
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

/// A view socket's probe (#4078): the ping out and when it was sent, or when the next goes.
struct Probe {
    sent: u64,
    out: Option<tokio::time::Instant>,
    next: tokio::time::Instant,
}

impl Probe {
    fn new() -> Self {
        Probe {
            sent: 0,
            out: None,
            next: tokio::time::Instant::now() + VIEW_PROBE_EVERY,
        }
    }

    /// By when everything sent now must be read: the probe out's bound, else this send's own.
    fn by(&self) -> tokio::time::Instant {
        self.out
            .unwrap_or_else(tokio::time::Instant::now)
            .checked_add(VIEW_BEHIND_MOST)
            .unwrap_or_else(tokio::time::Instant::now)
    }

    /// When the probe needs the socket's task: to send the next, or to let the socket go.
    fn wake(&self) -> tokio::time::Instant {
        self.out.map_or(self.next, |_| self.by())
    }

    /// A pong: the probe is answered if it carries the number of the one out.
    fn answered(&mut self, payload: &[u8]) {
        if self.out.is_some() && payload == self.sent.to_be_bytes() {
            self.out = None;
            self.next = tokio::time::Instant::now() + VIEW_PROBE_EVERY;
        }
    }
}

/// Sends on a view socket within its probe's bound; one that cannot take it by then fell behind.
async fn send_view(
    socket: &mut WebSocket,
    probe: &Probe,
    behind: &mut bool,
    message: Message,
) -> bool {
    match tokio::time::timeout_at(probe.by(), socket.send(message)).await {
        Ok(sent) => sent.is_ok(),
        Err(_) => {
            *behind = true;
            false
        }
    }
}

fn binary(frame: Vec<u8>) -> Message {
    Message::Binary(frame.into())
}

/// Where a client resumes from: its cursor, and how many frames at the cursor's version it applied.
type ResumeFrom = (Option<Value>, Option<usize>);

/// The sign-in message: `{1: token, 2: cursor, 3: seen}`.
fn read_sign_in(bytes: &[u8]) -> (Option<Presented>, ResumeFrom) {
    let Ok(Value::Map(m)) = decode(bytes).map(|d| d.value) else {
        return (None, (None, None));
    };
    let token = match m.get(&1) {
        Some(Value::Text(t)) => Some(presented(t.as_str())),
        _ => None,
    };
    let seen = match m.get(&3) {
        Some(Value::Uint(n)) => usize::try_from(*n).ok(),
        _ => None,
    };
    (token, (m.get(&2).cloned(), seen))
}

async fn serve(
    gw: Arc<Gateway>,
    mut socket: WebSocket,
    header_token: Option<Presented>,
    header_from: ResumeFrom,
    client: Option<String>,
    free: bool,
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
    let (token, (cursor, seen)) = match header_token {
        Some(t) => (Some(t), header_from),
        None => match tokio::time::timeout(SIGN_IN_WITHIN, next_binary(&mut socket)).await {
            Ok(Some(bytes)) => read_sign_in(&bytes),
            _ => return,
        },
    };
    if let Some(f) = gw.tokens_file.get() {
        f.refresh(&gw.tokens);
    }
    let token = match token {
        Some(Presented::View(v)) => return serve_view(gw, socket, v).await,
        Some(Presented::Agent(t)) => t,
        None => None,
    };
    let signed = token.as_ref().and_then(|t| {
        let tokens = gw.tokens.read().unwrap_or_else(|e| e.into_inner());
        let grant = tokens.check(t)?;
        Some((grant, tokens.account(grant).map(str::to_owned)))
    });
    let Some((grant, account)) = signed else {
        (gw.log)("a sign-in was refused");
        let _ = send(&mut socket, control(token::REFUSED)).await;
        return;
    };
    let Grant::Actor(actor) = grant;
    let authority = match crate::creator::session(&gw, actor) {
        Ok(mark) => mark,
        Err(_) => {
            let _ = send(&mut socket, control(token::REFUSED)).await;
            return;
        }
    };
    let who = Arc::new(Who::new(
        grant.to_text(),
        account.as_deref(),
        client.as_deref(),
    ));

    // 3. The outcome, and the kept frames after the cursor. A sign-in that asked only if the Soul is free, while a live
    // socket holds it, is closed as `agent.held` and the holder left as it is.
    let Some(mut attached) =
        gw.attach_if(grant, cursor.as_ref(), seen.unwrap_or(1), who.clone(), free)
    else {
        let close = CloseFrame {
            code: crate::REPLACED,
            reason: "agent.held".into(),
        };
        let _ = socket.send(Message::Close(Some(close))).await;
        return;
    };
    let mut ok = send(&mut socket, outcome(attached.outcome, attached.newest)).await;
    for frame in std::mem::take(&mut attached.replay) {
        ok = ok && send(&mut socket, times::finish(frame)).await;
    }

    // 4. Intents in, the stream out; view items out once it subscribes, to this socket alone (`views.rs`). Until the
    // gateway stops: then the socket closes with 1012 (O16).
    let mut view: Option<(u64, tokio::sync::mpsc::Receiver<Vec<u8>>)> = None;
    let mut closing = gw.closing.subscribe();
    // The newest sequence of an intent read from this socket (#4978): told when another takes the grant from it.
    let mut read = 0;
    while ok {
        tokio::select! {
            _ = stopped(&mut closing) => {
                let close = CloseFrame { code: crate::RESTART, reason: "gateway.restarting".into() };
                let _ = socket.send(Message::Close(Some(close))).await;
                break;
            }
            incoming = socket.recv() => {
                let received = times::stamp();
                let bytes = match incoming {
                    Some(Ok(Message::Binary(b))) => b.to_vec(),
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    // R13: a message's close, the mailbox's alone.
                    Some(Ok(Message::Text(t))) => {
                        if !crate::creator::permits(&gw,actor,authority) {
                            let _=send(&mut socket,control(token::REFUSED)).await;break;
                        }
                        crate::mailbox::on_text(&gw, grant, attached.session, t.as_str());
                        continue;
                    }
                    _ => break,
                };
                if !crate::creator::permits(&gw,actor,authority) {
                    let _=send(&mut socket,control(token::REFUSED)).await;break;
                }
                if let Some(request) = views::request(&bytes) {
                    if let Some((n, _)) = view.take() {
                        gw.views.end(n);
                    }
                    view = Some(gw.views.subscribe(request, &views::audiences(grant)));
                    continue;
                }
                // A token revoked since sign-in (W9, #2827): its next intent is refused by name, and the socket ends.
                if token.as_ref().and_then(|t| gw.tokens.read().unwrap_or_else(|e| e.into_inner()).check(t)).is_none() {
                    let _ = send(&mut socket, control(token::REFUSED)).await;
                    break;
                }
                if let Some(answer) = take_intent(&gw, actor, grant, attached.session, bytes, received, &mut read) {
                    gw.receipts.write(&who, Outcome::Refusal);
                    ok = send(&mut socket, answer).await;
                }
            }
            Some(mail) = attached.mail.recv() => {
                if !crate::creator::permits(&gw,actor,authority) { let _=send(&mut socket,control(token::REFUSED)).await;break; }
                ok = socket.send(Message::Text(mail.into())).await.is_ok();
            }
            out = attached.frames.recv() => match out {
                Some(frame) => {
                    if !crate::creator::permits(&gw,actor,authority) { let _=send(&mut socket,control(token::REFUSED)).await;break; }
                    let trace = crate::world_link::delivery_trace(&frame);
                    if let Some(t) = &trace { t.at("socket-dequeue", "ready"); }
                    let frame = times::finish(frame);
                    if let Some(t) = &trace { t.final_frame(&frame); }
                    ok = send(&mut socket, frame).await;
                    if let Some(t) = &trace { t.at("socket-send", if ok { "sent" } else { "failed" }); }
                }
                // Another socket signed in for this grant (a Soul's: the last device wins): it is told so, by name,
                // and its client does not sign in again at once. Or this one fell too far behind, and it may resume.
                None => {
                    if gw.replaced(grant, attached.session) {
                        // #4978: the newest intent it read from this socket; one its client sent later never reached
                        // the world, and its client refuses it by name.
                        let _ = socket.send(Message::Text(format!(r#"{{"replaced":{{"read":{read}}}}}"#).into())).await;
                        let close = CloseFrame { code: crate::REPLACED, reason: crate::AGENT_REPLACED.into() };
                        let _ = socket.send(Message::Close(Some(close))).await;
                    }
                    break;
                }
            },
            item = async {
                match view.as_mut() {
                    Some((_, items)) => items.recv().await,
                    None => std::future::pending().await,
                }
            } => match item {
                Some(frame) => {
                    if !crate::creator::permits(&gw,actor,authority) { let _=send(&mut socket,control(token::REFUSED)).await;break; }
                    ok = send(&mut socket, frame).await;
                },
                // Its view queue was full: let go, as a slow stream is.
                None => break,
            },
        }
    }
    if let Some((n, _)) = view {
        gw.views.end(n);
    }
    gw.detach(grant, attached.session);
}

/// A page's view socket (V13b, #3407), signed in with a view token: it subscribes to views for the token's grants (its
/// audiences are theirs, as an agent's are its actor's) and does nothing else: no intent, no stream, no place in the
/// hub, so an owner watching never lets their agent's socket go. Before the token expires the page signs in again on
/// the same socket (`{1: view token}`, answered `{4: "view.renewed"}`) and the subscription carries on with no gap;
/// unrenewed, the socket is told `{4: "view.expired"}` and closed. Its text frames are the owner's box (W10,
/// `mailbox::on_view_text`): a message to its grants' agents, and what each agent is doing about it.
async fn serve_view(gw: Arc<Gateway>, mut socket: WebSocket, presented: ViewToken) {
    let check = |t: &ViewToken| {
        gw.view_key
            .get()
            .and_then(|k| t.check(k, crate::unix_now()))
    };
    // Account view tokens may include worlds served by other gateways. Drop only creator grants that
    // this exact world's current authority does not grant; retain every ordinary Soul view.
    let local = |mut v: View| {
        v.grants.retain(|g| {
            let Grant::Actor(actor) = g;
            crate::creator::session(&gw, *actor).is_ok()
        });
        (!v.grants.is_empty()).then_some(v)
    };
    let Some(mut view) = check(&presented).and_then(&local) else {
        (gw.log)("a view sign-in was refused");
        let _ = send(&mut socket, control(token::REFUSED)).await;
        return;
    };
    let capture = |v: &View| {
        v.grants
            .iter()
            .map(|g| {
                let Grant::Actor(actor) = g;
                crate::creator::session(&gw, *actor)
            })
            .collect::<Result<Vec<_>, _>>()
    };
    let allowed = |v: &View, marks: &[Option<token::CreatorMark>]| {
        v.grants.iter().zip(marks).all(|(g, mark)| {
            let Grant::Actor(actor) = g;
            crate::creator::permits(&gw, *actor, *mark)
        })
    };
    let Ok(mut authority) = capture(&view) else {
        let _ = send(&mut socket, control(token::REFUSED)).await;
        return;
    };
    drop(presented);
    let audiences = |v: &View| -> Vec<replica::ids::Id> {
        v.grants.iter().flat_map(|g| views::audiences(*g)).collect()
    };
    let mut ok = send(&mut socket, control(VIEW_STARTED)).await;
    let mut asked: Option<Value> = None;
    let mut sub: Option<(u64, tokio::sync::mpsc::Receiver<Vec<u8>>)> = None;
    // W10 (#2802): the owner's box. Its grants' messages are told on `mail`, and its own puts answered there too.
    let (watching, reply, mut mail) = gw.watch(&view.grants);
    // #4078: how far behind its stream the socket is, and whether it fell further than the bound.
    let (mut probe, mut behind) = (Probe::new(), false);
    let refuse = binary(control(token::REFUSED));
    while ok {
        let left = Duration::from_millis((view.expires * 1000).saturating_sub(crate::unix_ms()));
        tokio::select! {
            incoming = socket.recv() => {
                let bytes = match incoming {
                    Some(Ok(Message::Binary(b))) => b.to_vec(),
                    Some(Ok(Message::Pong(p))) => {
                        probe.answered(&p);
                        continue;
                    }
                    Some(Ok(Message::Ping(_))) => continue,
                    Some(Ok(Message::Text(t))) => {
                        if !allowed(&view,&authority) { send_view(&mut socket,&probe,&mut behind,refuse.clone()).await;break; }
                        crate::mailbox::on_view_text(&gw, &view.grants, t.as_str(), reply.clone());
                        continue;
                    }
                    _ => break,
                };
                if !allowed(&view,&authority) { send_view(&mut socket,&probe,&mut behind,refuse.clone()).await;break; }
                if let Some(request) = views::request(&bytes) {
                    if let Some((n, _)) = sub.take() {
                        gw.views.end(n);
                    }
                    sub = Some(gw.views.subscribe(request.clone(), &audiences(&view)));
                    asked = Some(request);
                    continue;
                }
                let fresh = match read_sign_in(&bytes).0 {
                    Some(Presented::View(t)) => check(&t).and_then(&local).ok_or(token::REFUSED),
                    _ => Err(VIEW_ONLY),
                };
                let fresh = match fresh {
                    Ok(f) => f,
                    // A failed renewal keeps the token it has, until it expires.
                    Err(name) => {
                        ok = send_view(&mut socket, &probe, &mut behind, binary(control(name))).await;
                        continue;
                    }
                };
                let Ok(fresh_authority)=capture(&fresh) else { send_view(&mut socket,&probe,&mut behind,refuse.clone()).await;break; };
                // What it may watch changed (a Soul given away): the subscription is made again for the new grants.
                if audiences(&fresh) != audiences(&view)
                    && let (Some(request), Some((n, _))) = (&asked, sub.take())
                {
                    gw.views.end(n);
                    sub = Some(gw.views.subscribe(request.clone(), &audiences(&fresh)));
                }
                view = fresh;
                authority = fresh_authority;
                gw.rewatch(watching, &view.grants);
                ok = send_view(&mut socket, &probe, &mut behind, binary(control(VIEW_RENEWED))).await;
            }
            Some(text) = mail.recv() => {
                if !allowed(&view,&authority) { send_view(&mut socket,&probe,&mut behind,refuse.clone()).await;break; }
                ok = send_view(&mut socket, &probe, &mut behind, Message::Text(text.into())).await;
            }
            _ = tokio::time::sleep(left) => {
                let _ = send_view(&mut socket, &probe, &mut behind, binary(control(VIEW_EXPIRED))).await;
                break;
            }
            // The probe: past its bound unanswered, the socket fell behind; else the next one goes.
            _ = tokio::time::sleep_until(probe.wake()) => {
                if probe.out.is_some() {
                    behind = true;
                    break;
                }
                probe.sent += 1;
                probe.out = Some(tokio::time::Instant::now());
                let ping = Message::Ping(probe.sent.to_be_bytes().to_vec().into());
                ok = send_view(&mut socket, &probe, &mut behind, ping).await;
            }
            item = async {
                match sub.as_mut() {
                    Some((_, items)) => items.recv().await,
                    None => std::future::pending().await,
                }
            } => match item {
                Some(frame) => {
                    if !allowed(&view,&authority) { send_view(&mut socket,&probe,&mut behind,refuse.clone()).await;break; }
                    ok = send_view(&mut socket, &probe, &mut behind, binary(frame)).await;
                },
                None => break,
            },
        }
    }
    if let Some((n, _)) = sub {
        gw.views.end(n);
    }
    gw.unwatch(watching);
    if behind {
        (gw.log)(&format!(
            "a view socket fell more than {} s behind its stream ({VIEW_BEHIND}); it was let go",
            VIEW_BEHIND_MOST.as_secs()
        ));
        // Its reason and close frame, if it can still take them; either way the socket is dropped.
        let close = CloseFrame {
            code: VIEW_BEHIND_CODE,
            reason: VIEW_BEHIND.into(),
        };
        let _ = tokio::time::timeout(VIEW_BEHIND_GRACE, async {
            if send(&mut socket, control(VIEW_BEHIND)).await {
                let _ = socket.send(Message::Close(Some(close))).await;
            }
        })
        .await;
    }
}

/// Returns once the gateway is stopping (at once if it already is).
async fn stopped(closing: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        let set = *closing.borrow_and_update();
        if set {
            return;
        }
        if closing.changed().await.is_err() {
            return std::future::pending().await;
        }
    }
}

/// Reads an intent from the socket signed in as `session` and hands it to the world; the gateway's own answer to send
/// now, if it gives one not kept (always a refusal).
fn take_intent(
    gw: &Gateway,
    actor: Actor,
    grant: Grant,
    session: u64,
    bytes: Vec<u8>,
    received: u64,
    read: &mut u64,
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
        return match gw.link.ask(grant.key(), session, n.clone(), ask) {
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
    *read = (*read).max(intent.sequence);
    if intent.actor != actor {
        return refuse(
            gw,
            grant,
            intent.actor,
            intent.sequence,
            "intent-not-granted",
        );
    }
    // I2: a kind definition naming an uploaded model this world does not hold as allowed never reaches the world
    if let Some(reason) = crate::uploads::edit_refusal(gw, &intent) {
        return refuse(gw, grant, actor, intent.sequence, reason);
    }
    let left = intent.expiry.saturating_sub(unix_us());
    let (sequence, verb) = (intent.sequence, intent.verb.clone());
    // #5006: on a creator's grant, which several sockets hold, this intent's answers go to this socket; a sequence
    // another of them sent, out or lately answered, is refused here, on this socket, and never sent. #4978: on a
    // Soul's, one sent after another socket took the grant, or under a sequence another intent went under.
    let turn = if crate::shared(grant) {
        if gw.sending(grant, sequence, session) {
            Ok(())
        } else {
            Err(crate::SEQUENCE_IN_USE)
        }
    } else {
        gw.holding(grant, sequence, session, crate::digest(&bytes))
    };
    if let Err(reason) = turn {
        return Some(refused(actor, sequence, reason, gw.link.now()));
    }
    match gw
        .link
        .submit(grant.key(), actor, intent.sequence, bytes, received, left)
    {
        Sent::Sent => {
            // W10: told to the owner while a message given to this agent is open.
            gw.sent_intent(&grant.key(), sequence, verb.as_str());
            None
        }
        Sent::Restarting => {
            let own = refuse(gw, grant, actor, sequence, RESTARTING);
            if own.is_some() {
                gw.unsent(grant, sequence);
            }
            own
        }
    }
}

/// The wall clock, µs from the Unix epoch: an intent's expiry is world time, which is real time (T5).
// The gateway's one wall-clock read: how long an intent has left (C8, #3396). The gateway is not the engine.
#[allow(clippy::disallowed_methods)]
pub(crate) fn unix_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}
