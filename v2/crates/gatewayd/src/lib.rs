//! Agents' sockets (Engine v2 I1, #2683). `gatewayd` is a program of its own that holds every agent's socket, so a
//! world restarts without closing one: the agent sees a pause, and each intent it sent is answered once, by its
//! receipt, by `world.restarting`, or, when the world is away past the intent's deadline, by `act.timed-out` or
//! `intent.expired` (C8, `world_link`).
//!
//! - [`socket`]: one WebSocket per agent, through axum's upgrade, one task and one bounded outbound queue each. The
//!   first frame each way is T10's (`v2/docs/intents.md` rule 12); sign-in follows it, by header or first message.
//! - [`token`]: what a token grants, its SHA-256 alone stored, compared in constant time, revocable.
//! - [`world_link`]: one local socket to the world; intents not yet answered are kept and sent again on reconnect.
//! - [`resume`]: a client resumes its stream from a cursor, or is told by name that it must start again.
//! - [`gate`]: the gate a world's intents pass through while it moves to another machine (O9, #2828).
//! - [`receipts`]: one line per answered intent in the world's receipts file, for the operator's usage roll-up.
//! - [`views`]: a signed-in socket subscribes to R4's view items for its scope (#3292), on a second local socket to
//!   the world; its frames are keys 30 to 32.
//! - Stopping (O16, #2809): on SIGTERM the gateway stops accepting, closes each signed-in socket with 1012 (Service
//!   Restart) and exits; it keeps nothing a new one does not rebuild (`v2/docs/runbook/gateway-upgrade.md`).
//!
//! Frames after the first, as CBOR in T0's profile (`v2/docs/encoding.md`):
//!
//! - a page's view socket (V13b, #3407): signed in with a view token the directory minted from a web session
//!   ([`token::ViewToken`]), it subscribes to views for the token's grants and nothing else, and renews the token on
//!   the same socket (`socket::serve_view`).
//! - client → gateway, sign-in (unless the `authorization: Bearer <token>` header gave it): `{1: token, 2: cursor,
//!   3: seen}`, 2 left out for a fresh stream; `seen` (default 1) is how many frames the client applied at its
//!   cursor's version, since a refusal does not move the version (the `souls-cursor` and `souls-seen` headers give
//!   the same by header). Then every frame is an intent (T10 rule 2).
//! - gateway → client, the sign-in's outcome: `{4: name}`, one of `token.refused` (and the socket closes),
//!   `stream.started`, `stream.resumed` or `stream.cannot-resume` (the client starts again; the stream continues).
//! - gateway → client, a frame of the stream: `{1: version, 2: answer}` as the world sent it; the version is the
//!   client's next cursor. A refusal the gateway gives itself (`world.restarting`, `intent-not-granted`) is a frame
//!   of the stream too, at the newest version the world sent, and kept for a resume; before the world has sent any
//!   version, and for bytes that are not an intent, it is `{2: answer}`, with no version and not kept.
//! - both ways, after sign-in, R5's sync by hash (R5b, #3164; `replica::sync::wire`): a frame with key 20 is a sync
//!   request, not an intent. The gateway passes it to the world with the asking actor (key 23) under a number of its
//!   own, and the world's answer back to that socket alone, under the client's number; it is not kept for a resume.
//!   A client told `stream.cannot-resume` compares and descends this way, then carries on with the stream.
//! - gateway → client and back, the owner's messages ([`mailbox`], R13, #2753): WebSocket text frames of JSON, not
//!   CBOR (and read by the gateway without parsing JSON), apart from the world's stream and never in its log: `{"mail": {"id", "text", "at"}}` out, once per
//!   socket, and `{"close": {"id", "state", "outcome"}}` back when the act that served it ends.
//! - page → gateway → page, the owner's box (W10, #2802), on a view socket: text frames, apart from the stream too.
//!   `put <grant>\n<words>` puts a message for one of the view token's grants (`mailbox::on_view_text`), answered
//!   `{"sent": {"id"}}` or `{"sent": {"refused"}}`; then, to every view socket whose token holds that grant and to no
//!   other, `{"mail": {"id", "state": "picked"}}` when it is given to the agent's socket, `{"doing": {"seq", "verb",
//!   "phase", "outcome"}}` for each intent the agent sends while it is open (the phase is the answer's own: `sent`,
//!   `accepted`, `receipt`, `refused`, `resolved`), and the agent's own `{"close": …}` once the directory took it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, RwLock};

use replica::encode::Value;
use tokio::sync::mpsc;

pub mod gate;
pub mod mailbox;
pub mod receipts;
pub mod resume;
pub mod socket;
pub mod times;
pub mod token;
pub mod views;
pub mod world_link;

pub use gate::{End, Entry, Gate};

use receipts::{Outcome, Receipts, Who};
use resume::{Cursor, Kept, Resume};
use token::{Grant, Tokens};

/// Where log lines go. A line never holds a token ([`token::Token`] formats without its secret).
pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

/// Log lines to standard error.
pub fn stderr_log() -> Log {
    Arc::new(|line| eprintln!("gatewayd: {line}"))
}

/// The wall clock in ms since 1970: a view token's expiry is a wall-clock time the directory set, not world time.
#[allow(clippy::disallowed_methods)]
pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// [`unix_ms`] in whole seconds.
pub fn unix_now() -> u64 {
    unix_ms() / 1000
}

/// Frames queued to one socket before it counts as too slow and is closed (it may resume from its cursor).
pub const OUTBOUND: usize = 64;

/// The gateway's shared state.
pub struct Gateway {
    pub tokens: RwLock<Tokens>,
    /// The world's pinned build hash, sent in the first frame (T10 rule 12).
    pub build: Vec<u8>,
    pub link: world_link::Link,
    /// The sockets' view subscriptions and their link to the world's view tier.
    pub views: views::Views,
    pub log: Log,
    /// The receipts file's writer (`--receipts`), or off.
    pub receipts: Receipts,
    /// The key view tokens are checked with (`--view-key`, V13b); unset, a view token is refused.
    pub view_key: std::sync::OnceLock<token::ViewKey>,
    /// The directory's mailbox (`--mailbox`), set once at start; off if unset.
    pub mailbox: std::sync::OnceLock<mailbox::Mailbox>,
    /// Set once when the gateway stops: every signed-in socket closes with [`RESTART`].
    pub closing: tokio::sync::watch::Sender<bool>,
    hub: Mutex<Hub>,
    /// The view sockets that watch their grants' messages (W10): by number, the grants' keys and the socket's queue.
    watchers: Mutex<Watchers>,
}

type Watchers = BTreeMap<u64, (Vec<Vec<u8>>, mpsc::Sender<String>)>;

/// The close code a socket gets when the gateway stops for an upgrade: 1012, Service Restart. The client reconnects
/// after a random wait, resumes by cursor and sends again every intent it has no answer for.
pub const RESTART: u16 = 1012;

#[derive(Default)]
struct Hub {
    next_session: u64,
    /// Per grant (by its actor's bytes): its kept frames and its socket, if one is signed in.
    grants: BTreeMap<Vec<u8>, Held>,
}

#[derive(Default)]
struct Held {
    kept: Kept,
    session: Option<(u64, mpsc::Sender<Vec<u8>>)>,
    /// Who the grant's answers count for in the receipts file, as of its latest sign-in.
    who: Option<Arc<Who>>,
    /// The signed-in socket's queue for the owner's messages, and the ids already given to it.
    mail: Option<mpsc::Sender<String>>,
    mailed: BTreeSet<String>,
    /// W10: the grant's intents sent while a message given to it is open, by sequence, and their verbs. Only acts
    /// begun after the pickup are told to the owner, so an older act never reads as the answer.
    doing: BTreeMap<u64, String>,
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
            views: views::Views::default(),
            log,
            receipts,
            view_key: std::sync::OnceLock::new(),
            mailbox: std::sync::OnceLock::new(),
            closing: tokio::sync::watch::channel(false).0,
            hub: Mutex::new(Hub::default()),
            watchers: Mutex::new(BTreeMap::new()),
        })
    }

    /// Signs a socket in for `grant`, resuming after the first `seen` frames at `cursor`. A socket already signed in
    /// for it is let go (its queue closes, so its task ends): the last device wins. `who` is whom its answers count
    /// for in the receipts file.
    pub fn attach(
        &self,
        grant: Grant,
        cursor: Option<&Value>,
        seen: usize,
        who: Arc<Who>,
    ) -> Attached {
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
            Some(v) => match Cursor::from_value(v).map(|c| held.kept.resume(&c, seen)) {
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
        let ids: BTreeSet<&str> = open.iter().map(|(_, id, _)| id.as_str()).collect();
        for held in hub.grants.values_mut() {
            held.mailed.retain(|id| ids.contains(id.as_str()));
        }
        for held in hub.grants.values_mut() {
            if held.mailed.is_empty() {
                held.doing.clear();
            }
        }
        for (key, id, frame) in &open {
            if let Some(held) = hub.grants.get_mut(key)
                && let Some(tx) = &held.mail
                && !held.mailed.contains(id)
                && tx.try_send(frame.clone()).is_ok()
            {
                held.mailed.insert(id.clone());
                if mailbox::id_like(id) {
                    let picked = format!(r#"{{"mail":{{"id":"{id}","state":"picked"}}}}"#);
                    self.tell_watchers(key, picked);
                }
            }
        }
    }

    /// W10: a view socket watches the messages of `grants`; its number, and the queue its text frames arrive on.
    pub fn watch(&self, grants: &[Grant]) -> (u64, mpsc::Sender<String>, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel(OUTBOUND);
        let mut w = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        let n = w.keys().next_back().map_or(1, |n| n + 1);
        w.insert(n, (grants.iter().map(|g| g.key()).collect(), tx.clone()));
        (n, tx, rx)
    }

    /// W10: what a watching view socket may see changed (its token was renewed for other grants).
    pub fn rewatch(&self, n: u64, grants: &[Grant]) {
        let mut w = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((keys, _)) = w.get_mut(&n) {
            *keys = grants.iter().map(|g| g.key()).collect();
        }
    }

    /// W10: a view socket stops watching.
    pub fn unwatch(&self, n: u64) {
        self.watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&n);
    }

    /// W10: a text frame for every view socket whose token holds the grant `key`, and no other. A full queue drops it.
    pub fn tell_watchers(&self, key: &[u8], text: String) {
        let w = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        for (keys, tx) in w.values() {
            if keys.iter().any(|k| k == key) {
                let _ = tx.try_send(text.clone());
            }
        }
    }

    /// W10: the grant `key` sent intent `sequence` (`verb`) to the world. Noted, and told to its owner, only while a
    /// message given to it is open.
    pub fn sent_intent(&self, key: &[u8], sequence: u64, verb: &str) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = hub.grants.get_mut(key)
            && !held.mailed.is_empty()
        {
            held.doing.insert(sequence, verb.to_owned());
            self.tell_watchers(key, mailbox::doing(sequence, verb, "sent", None));
        }
    }

    /// W10: a frame for the grant `key` that answers an intent noted by [`Gateway::sent_intent`]: its phase, told to
    /// the owner. Read only while some are noted, so the stream pays nothing otherwise.
    fn answered(&self, held: &mut Held, key: &[u8], frame: &[u8]) {
        if held.doing.is_empty() {
            return;
        }
        let Some((sequence, phase, outcome)) = mailbox::phase_of(frame) else {
            return;
        };
        let Some(verb) = held.doing.get(&sequence).cloned() else {
            return;
        };
        if phase != "accepted" {
            held.doing.remove(&sequence);
        }
        self.tell_watchers(
            key,
            mailbox::doing(sequence, &verb, phase, outcome.as_deref()),
        );
    }

    /// An answer the gateway gives itself to the actor `key` (`{2: answer}`, not kept for a resume), sent to its
    /// socket if one is signed in; a socket whose queue is full is let go, as by [`Gateway::deliver`].
    pub fn tell(&self, key: &[u8], frame: Vec<u8>) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = hub.grants.get_mut(key)
            && let Some((_, tx)) = &held.session
            && tx.try_send(frame).is_err()
        {
            held.session = None;
            (self.log)("a socket's outbound queue was full; it was let go and may resume");
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
        let held = hub.grants.entry(key.clone()).or_default();
        self.answered(held, &key, &frame);
        held.kept.push(at, frame.clone());
        if let Some((_, tx)) = &held.session
            && tx.try_send(frame).is_err()
        {
            held.session = None;
            (self.log)("a socket's outbound queue was full; it was let go and may resume");
        }
    }
}
