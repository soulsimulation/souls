//! Agents' sockets (Engine v2 I1, #2683). `gatewayd` is a program of its own that holds every agent's socket, so a
//! world restarts without closing one: the agent sees a pause, and each intent it sent is answered once, by its
//! receipt or by `world.restarting`.
//!
//! - [`socket`]: one WebSocket per agent, through axum's upgrade, one task and one bounded outbound queue each. The
//!   first frame each way is T10's (`v2/docs/intents.md` rule 12); sign-in follows it, by header or first message.
//! - [`token`]: what a token grants, its SHA-256 alone stored, compared in constant time, revocable.
//! - [`world_link`]: one local socket to the world; intents not yet answered are kept and sent again on reconnect.
//! - [`resume`]: a client resumes its stream from a cursor, or is told by name that it must start again.
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

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use replica::encode::Value;
use tokio::sync::mpsc;

pub mod resume;
pub mod socket;
pub mod token;
pub mod world_link;

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
}

/// A signed-in socket's place in the hub.
pub struct Attached {
    pub session: u64,
    pub frames: mpsc::Receiver<Vec<u8>>,
    /// The outcome's name, sent before anything else.
    pub outcome: &'static str,
    /// Kept frames after the cursor, sent right after the outcome.
    pub replay: Vec<Vec<u8>>,
}

impl Gateway {
    pub fn new(tokens: Tokens, build: Vec<u8>, log: Log) -> Arc<Gateway> {
        Arc::new(Gateway {
            tokens: RwLock::new(tokens),
            build,
            link: world_link::Link::default(),
            log,
            hub: Mutex::new(Hub::default()),
        })
    }

    /// Signs a socket in for `grant`. A socket already signed in for it is let go (its queue closes, so its task
    /// ends): the last device wins.
    pub fn attach(&self, grant: Grant, cursor: Option<&Value>) -> Attached {
        let (tx, rx) = mpsc::channel(OUTBOUND);
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        hub.next_session += 1;
        let session = hub.next_session;
        let held = hub.grants.entry(grant.key()).or_default();
        held.session = Some((session, tx));
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
        }
    }

    /// Lets a socket go, unless another has signed in for the grant since.
    pub fn detach(&self, grant: Grant, session: u64) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = hub.grants.get_mut(&grant.key())
            && held.session.as_ref().is_some_and(|(s, _)| *s == session)
        {
            held.session = None;
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
