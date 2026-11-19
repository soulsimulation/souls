//! Agents' sockets (Engine v2 I1, #2683). `gatewayd` is a program of its own that holds every agent's socket, so a
//! world restarts without closing one: the agent sees a pause, and each intent it sent is answered once, by its
//! receipt or by `world.restarting`.
//!
//! - [`socket`]: one WebSocket per agent, through axum's upgrade, one task and one bounded outbound queue each. The
//!   first frame each way is T10's (`v2/docs/intents.md` rule 12); sign-in follows it, by header or first message.
//! - [`token`]: what a token grants, its SHA-256 alone stored, compared in constant time, revocable.
//! - [`world_link`]: one local socket to the world; intents not yet answered are kept and sent again on reconnect.
//! - [`resume`]: a client resumes its stream from a cursor, or is told by name that it must start again.
//! - [`receipts`]: one line per answered intent in the world's receipts file, for the operator's usage roll-up.
//!
//! Frames after the first, as CBOR in T0's profile (`v2/docs/encoding.md`):
//!
//! - client → gateway, sign-in (unless the `authorization: Bearer <token>` header gave it): `{1: token, 2: cursor}`,
//!   2 left out for a fresh stream. Then every frame is an intent (T10 rule 2).
//! - gateway → client, the sign-in's outcome: `{4: name}`, one of `token.refused` (and the socket closes),
//!   `stream.started`, `stream.resumed` or `stream.cannot-resume` (the client starts again; the stream continues).
//! - gateway → client, a frame of the stream: `{1: version, 2: answer}` as the world sent it; the version is the
//!   client's next cursor. An answer the gateway gives itself (`world.restarting`, a refusal before the world) is
//!   `{2: answer}`: it has no version and is not kept for a resume.
//! - both ways, after sign-in, R5's sync by hash (R5b, #3164; `replica::sync::wire`): a frame with key 20 is a sync
//!   request, not an intent. The gateway passes it to the world with the asking actor (key 23) under a number of its
//!   own, and the world's answer back to that socket alone, under the client's number; it is not kept for a resume.
//!   A client told `stream.cannot-resume` compares and descends this way, then carries on with the stream.
//! - gateway → client and back, the owner's messages ([`mailbox`], R13, #2753): WebSocket text frames of JSON, not
//!   CBOR, apart from the world's stream and never in its log: `{"mail": {"id", "text", "at"}}` out, once per
//!   socket, and `{"close": {"id", "state", "outcome"}}` back when the act that served it ends.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};

use replica::encode::Value;
use tokio::sync::mpsc;

pub mod mailbox;
pub mod receipts;
pub mod resume;
pub mod socket;
pub mod times;
pub mod token;
pub mod world_link;

use receipts::{Outcome, Receipts, Who};
use resume::{Cursor, Kept, Resume};
use token::{Grant, Tokens};

/// Where log lines go. A line never holds a token ([`token::Token`] formats without its secret).
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

/// Log lines to standard error.
pub fn stderr_log() -> Log {
    Arc::new(|line| eprintln!("gatewayd: {line}"))
}

/// Frames queued to one socket before it counts as too slow and is closed (it may resume from its cursor).
pub const OUTBOUND: usize = 64;

/// The gateway's shared state.
pub struct Gateway {
    pub tokens: RwLock<Tokens>,
    /// The world's pinned build hash, sent in the first frame (T10 rule 12).
    pub build: Vec<u8>,
    pub link: world_link::Link,
    pub log: Log,
    /// The receipts file's writer (`--receipts`), or off.
    pub receipts: Receipts,
    /// The directory's mailbox (`--mailbox`), set once at start; off if unset.
    pub mailbox: std::sync::OnceLock<mailbox::Mailbox>,
    hub: Mutex<Hub>,
}

#[derive(Default)]
struct Hub {
    next_session: u64,
    /// Per grant (by its actor's bytes): its kept frames and its socket, if one is signed in.
    grants: HashMap<Vec<u8>, Held>,
}

#[derive(Default)]
struct Held {
    kept: Kept,
    session: Option<(u64, mpsc::Sender<Vec<u8>>)>,
    /// Who the grant's answers count for in the receipts file, as of its latest sign-in.
    who: Option<Arc<Who>>,
    /// The signed-in socket's queue for the owner's messages, and the ids already given to it.
    mail: Option<mpsc::Sender<String>>,
    mailed: HashSet<String>,
}

/// A signed-in socket's place in the hub.
pub struct Attached {
    pub session: u64,
    pub frames: mpsc::Receiver<Vec<u8>>,
    /// The outcome's name, sent before anything else.
    pub outcome: &'static str,
    /// Kept frames after the cursor, sent right after the outcome.
    pub replay: Vec<Vec<u8>>,
    /// The owner's messages for this socket, as text frames (R13).
    pub mail: mpsc::Receiver<String>,
}

impl Gateway {
    pub fn new(tokens: Tokens, build: Vec<u8>, log: Log) -> Arc<Gateway> {
        Gateway::with_receipts(tokens, build, log, Receipts::off())
    }

    pub fn with_receipts(
        tokens: Tokens,
        build: Vec<u8>,
        log: Log,
        receipts: Receipts,
    ) -> Arc<Gateway> {
        Arc::new(Gateway {
            tokens: RwLock::new(tokens),
            build,
            link: world_link::Link::default(),
            log,
            receipts,
            mailbox: std::sync::OnceLock::new(),
            hub: Mutex::new(Hub::default()),
        })
    }

    /// Signs a socket in for `grant`. A socket already signed in for it is let go (its queue closes, so its task
    /// ends): the last device wins. `who` is whom its answers count for in the receipts file.
    pub fn attach(&self, grant: Grant, cursor: Option<&Value>, who: Arc<Who>) -> Attached {
        let (tx, rx) = mpsc::channel(OUTBOUND);
        let (mail_tx, mail_rx) = mpsc::channel(OUTBOUND);
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        hub.next_session += 1;
        let session = hub.next_session;
        let held = hub.grants.entry(grant.key()).or_default();
        held.session = Some((session, tx));
        held.who = Some(who);
        held.mail = Some(mail_tx);
        held.mailed.clear();
        let (outcome, replay) = match cursor {
            None => (resume::STARTED, Vec::new()),
            Some(v) => match Cursor::from_value(v).map(|c| held.kept.resume(&c)) {
                Some(Resume::Resumed(frames)) => (resume::RESUMED, frames),
                _ => (resume::CANNOT_RESUME, Vec::new()),
            },
        };
        Attached {
            session,
            frames: rx,
            outcome,
            replay,
            mail: mail_rx,
        }
    }

    /// Lets a socket go, unless another has signed in for the grant since.
    pub fn detach(&self, grant: Grant, session: u64) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = hub.grants.get_mut(&grant.key())
            && held.session.as_ref().is_some_and(|(s, _)| *s == session)
        {
            held.session = None;
            held.mail = None;
        }
    }

    /// The mailbox's open messages, `(grant key, id, text frame)`: each given once to its grant's signed-in socket.
    /// A message no longer open is forgotten, so ids given stay as few as the open messages.
    pub fn post_mail(&self, open: Vec<(Vec<u8>, String, String)>) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        let ids: HashSet<&str> = open.iter().map(|(_, id, _)| id.as_str()).collect();
        for held in hub.grants.values_mut() {
            held.mailed.retain(|id| ids.contains(id.as_str()));
        }
        for (key, id, frame) in &open {
            if let Some(held) = hub.grants.get_mut(key)
                && let Some(tx) = &held.mail
                && !held.mailed.contains(id)
                && tx.try_send(frame.clone()).is_ok()
            {
                held.mailed.insert(id.clone());
            }
        }
    }

    /// A frame for the socket signed in for `key` alone, not kept for a resume (a sync answer). Dropped if none is
    /// signed in, or its queue is full; the client asks again.
    pub fn reply(&self, key: &[u8], frame: Vec<u8>) {
        let hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, tx)) = hub.grants.get(key).and_then(|h| h.session.as_ref()) {
            let _ = tx.try_send(frame);
        }
    }

    /// An intent of the actor `key` was answered by the world: one line in the receipts file.
    pub fn record(&self, key: &[u8], outcome: Outcome) {
        let who = {
            let hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
            hub.grants.get(key).and_then(|h| h.who.clone())
        };
        if let Some(who) = who {
            self.receipts.write(&who, outcome);
        }
    }

    /// A frame of the world's stream for the actor `key`: kept for a resume, and queued to its socket if one is
    /// signed in. A socket whose queue is full is let go; it resumes from its cursor.
    pub fn deliver(&self, key: Vec<u8>, at: Cursor, frame: Vec<u8>) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        let held = hub.grants.entry(key).or_default();
        held.kept.push(at, frame.clone());
        if let Some((_, tx)) = &held.session
            && tx.try_send(frame).is_err()
        {
            held.session = None;
            (self.log)("a socket's outbound queue was full; it was let go and may resume");
        }
    }
}
