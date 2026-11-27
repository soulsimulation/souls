//! Agents' sockets (Engine v2 I1, #2683). `gatewayd` is a program of its own that holds every agent's socket, so a
//! world restarts without closing one: the agent sees a pause, and each intent it sent is answered once, by its
//! receipt, by `world.restarting`, or, when the world is away past the intent's deadline, by `act.timed-out` or
//! `intent.expired` (C8, `world_link`). An act the world says is in progress is passed on as such, and waited for to
//! the world's own deadline (C20).
//!
//! - [`socket`]: one WebSocket per agent, through axum's upgrade, one task and one bounded outbound queue each. The
//!   first frame each way is T10's (`v2/docs/intents.md` rule 12); sign-in follows it, by header or first message.
//! - [`token`]: what a token grants, its SHA-256 alone stored, compared in constant time, revocable.
//! - [`world_link`]: one local socket to the world; intents not yet answered are kept and sent again on reconnect.
//! - [`resume`]: a client resumes its stream from a cursor, or is told by name that it must start again.
//! - [`gate`]: the gate a world's intents pass through while it moves to another machine (O9, #2828).
//! - [`receipts`]: one line per answered intent in the world's receipts file, for the operator's usage roll-up.
//! - [`creator`]: a page signed in with W1's session exchanges it for a short token for the world's one creator (W5,
//!   #2801), so a browser holds a creator's socket. A Soul's grant has one socket (the last device wins); a creator's
//!   has as many as sign in ([`shared`], #5006), so the creator's page and agent build at once: each intent's answers
//!   go to the socket that sent it, and the owner's messages to each socket.
//! - [`entries`]: `GET /v2/entries`, the world's kind entries as one gzip JSON array for a signed-in client (#3760),
//!   and `GET /v2/kinds`, the world's kinds text a creator's client checks its edits against.
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
//! - A client nobody trusts (O8, #2805): an agent's intents kept here, unanswered, are bounded in bytes
//!   (`world_link::KEPT_MOST`, far above an honest agent's few at a time); one past it is refused at once
//!   `agent.slow-down`, with plain words and when to send again, as `{2: answer}`, not kept and never sent to the
//!   world. A message over the intent limits' `frame_bytes` closes the socket 1009 `message.too-big`, refused from its
//!   length unread; a frame the WebSocket protocol cannot read closes it 1002 `frame.unreadable`. The bench is
//!   `v2/tools/bench/hostile`.
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
//!   other, `{"mail": {"id", "state": "picked"}}` when it is given to the agent's socket, `{"mail": {"id", "state":
//!   "read"}}` when the agent's client says the agent read it (`{"read": {"id"}}`), `{"doing": {"seq", "verb",
//!   "phase", "outcome"}}` for each intent the agent sends while it is open (the phase is the answer's own: `sent`,
//!   `accepted`, `receipt`, `refused`, `resolved`), and the agent's own `{"close": …}` once the directory took it.
//!   Whether each grant's agent is connected (a socket signed in for it) and listening (its client said a reader of
//!   its messages is open, `{"listening": true|false}`), first when the view socket starts watching and then on each
//!   change: `{"agent": {"grant", "connected", "listening"}}`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, RwLock};

use replica::encode::Value;
use tokio::sync::mpsc;

pub mod bulk;
pub mod control;
pub mod creator;
pub mod entries;
pub mod gate;
pub mod mailbox;
pub mod receipts;
pub mod resume;
pub mod socket;
pub mod times;
pub mod token;
pub mod uploads;
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

/// The close code of an agent's socket let go for a full queue, its stream's or its view items' (#4979): 1013, Try
/// Again Later, with the reason [`AGENT_BEHIND`], as a view socket that fell behind is (#4078). Its client signs in
/// again at once and resumes from its cursor; what was still queued for it is not sent first.
pub const BEHIND: u16 = 1013;
/// The reason an agent's socket let go for a full queue is closed with (#4979).
pub const AGENT_BEHIND: &str = "agent.behind";

/// The gateway's shared state.
pub struct Gateway {
    pub tokens: RwLock<Tokens>,
    /// The tokens file, read again at a sign-in when it changed (C3, #3367); unset, the tokens are as given.
    pub tokens_file: std::sync::OnceLock<token::Source>,
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
    /// The world's creator and the directory that checks sessions (`--creator`), set once at start; off if unset.
    pub exchange: std::sync::OnceLock<creator::Exchange>,
    /// The world's kind entries for its clients (`--entries`, #3760); unset, `GET /v2/entries` answers 404.
    pub entries: std::sync::OnceLock<entries::Entries>,
    /// The creator's live helpers (#3727): each helper's actor id and its token's hash, until it lapses.
    pub helpers: Mutex<BTreeMap<replica::ids::Id, [u8; 32]>>,
    /// A creator's bulk edits' counts (#3695, `bulk.rs`).
    pub bulk: bulk::Gauge,
    /// A creator's uploads (`--uploads`, #3697, `uploads.rs`); unset, the routes answer 404.
    pub uploads: std::sync::OnceLock<uploads::Uploads>,
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

/// The gateway's own refusal of an intent from one of a creator's sockets under a sequence another of its sockets,
/// still signed in, sent and has no answer for yet, or had answered among the last [`ENDED`] (#5006): the world keeps
/// one numbering per creator and would take the second as a repeat of the first, answering it with the first's answer
/// (a repeat of one of its last answered is answered from its kept answers, `sim::commit::acts::KEPT`). Its client
/// numbers above it and sends again.
pub const SEQUENCE_IN_USE: &str = "intent.seq-in-use";

/// How many of a shared grant's answered intents the gateway remembers the sender of: as many as the world keeps
/// answers per actor to answer a repeat with (`sim::commit::acts::KEPT`).
pub const ENDED: usize = 16;

/// The gateway's own refusal of an intent a socket sends for a Soul's grant after another socket signed in for it and
/// took it (#4978): it never reaches the world. The same name as the socket's close ([`REPLACED`]).
pub const AGENT_REPLACED: &str = "agent.replaced";

/// The close code a socket gets when another signs in for its grant (the last device wins): 4001, with the reason
/// `agent.replaced`. Its client does not take the Soul back by itself, so two clients of one Soul do not take it from
/// each other several times a second: it signs in again when its own agent next asks it for something, and meanwhile
/// asks now and then only if the Soul is free ([`FREE`]). A sign-in that asks so while a live socket holds the grant
/// is closed with the same code and the reason `agent.held`.
pub const REPLACED: u16 = 4001;

/// The query a sign-in that must not take the Soul from a live socket carries on its URL (`?free=1`).
pub const FREE: &str = "free=1";

#[derive(Default)]
struct Hub {
    next_session: u64,
    /// Per grant (by its actor's bytes): its kept frames and the sockets signed in for it.
    grants: BTreeMap<Vec<u8>, Held>,
}

#[derive(Default)]
struct Held {
    kept: Kept,
    /// The sockets signed in for the grant, by session: at most one for a Soul's (the last device wins), any number
    /// for a creator's ([`shared`]).
    sessions: BTreeMap<u64, Live>,
    /// Who the grant's answers count for in the receipts file, as of its latest sign-in.
    who: Option<Arc<Who>>,
    /// The ids of the owner's messages given to the grant's sockets (each socket's own are in [`Live::mailed`]).
    mailed: BTreeSet<String>,
    /// Whether the grant's agent said a reader of its messages is open now (`{"listening": …}`, first-day 27 Nov): its
    /// client being connected does not say that anyone reads what the client is given.
    listening: bool,
    /// W10: the grant's intents sent while a message given to it is open, by sequence, and their verbs. Only acts
    /// begun after the pickup are told to the owner, so an older act never reads as the answer.
    doing: BTreeMap<u64, String>,
    /// The grant's intents not yet answered, by sequence: who sent each, so their answers go to that socket (#5006),
    /// and which intent it was (#4978).
    senders: BTreeMap<u64, Out>,
    /// The grant's last [`ENDED`] answered intents, `(sequence, session, digest)`, oldest first ([`SEQUENCE_IN_USE`]).
    ended: std::collections::VecDeque<(u64, u64, u64)>,
    /// A Soul's grant: the newest sequence the gateway sent to the world for it, from any of its clients. Each sign-in
    /// is told it, so a client that takes the Soul from another numbers its next intent after the other's (#4978).
    newest: u64,
}

/// An intent out on a shared grant: the session that sent it, and the newest session signed in then. A socket signed
/// in since may be its sender's client back on a new socket (its old one may linger half-open, unnoticed), and the
/// client daemon never sends an intent twice, so its answers go there too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Out {
    session: u64,
    newest: u64,
    /// The intent's bytes, hashed ([`digest`]): the same intent sent again is told from another under its sequence.
    digest: u64,
}

/// An intent's bytes, hashed: equal for the same intent sent again (#4978).
pub fn digest(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::hash::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// One signed-in socket: its queue of the stream's frames, its queue for the owner's messages, the ids of the
/// messages already given to it, and how its task is told at once that it was let go for a full queue (#4979).
struct Live {
    frames: mpsc::Sender<Vec<u8>>,
    mail: mpsc::Sender<String>,
    mailed: BTreeSet<String>,
    behind: Arc<tokio::sync::Notify>,
}

/// Which intent a frame of a grant's stream answers, and whether the answer ends it (a progress answer does not, C20).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Answering {
    pub sequence: u64,
    pub ends: bool,
}

/// Whether several sockets may hold `grant` at once (#5006): a creator's, so the creator's page (Build, Undo, the
/// weather) and the creator's agent build at the same time, each answered on its own socket. A Soul's grant keeps one
/// holder: the last device wins, since two controllers of one body would fight over it.
pub fn shared(grant: Grant) -> bool {
    matches!(grant, Grant::Actor(replica::effects::Actor::Creator(_)))
}

impl Held {
    /// The sessions a frame answering `a` goes to. On a shared grant, for an intent a socket of it sent: that socket,
    /// and any signed in since it was sent ([`Out`]); never the others, which signed in before and are other clients.
    /// Otherwise (a Soul's grant, an answer the world handed over from before a restart, a bulk edit's): every socket
    /// of the grant. The sender is moved to [`Held::ended`] when the answer ends the intent.
    fn route(&mut self, a: Answering) -> Vec<u64> {
        let out = if a.ends {
            self.senders.remove(&a.sequence)
        } else {
            self.senders.get(&a.sequence).copied()
        };
        let Some(out) = out else {
            return self.sessions.keys().copied().collect();
        };
        if a.ends {
            if self.ended.len() == ENDED {
                self.ended.pop_front();
            }
            self.ended.push_back((a.sequence, out.session, out.digest));
        }
        self.sessions
            .keys()
            .copied()
            .filter(|s| *s == out.session || *s > out.newest)
            .collect()
    }
}

/// A signed-in socket's place in the hub.
pub struct Attached {
    pub session: u64,
    pub frames: mpsc::Receiver<Vec<u8>>,
    /// The outcome's name, sent before anything else.
    pub outcome: &'static str,
    /// Kept frames after the cursor, sent right after the outcome.
    pub replay: Vec<Vec<u8>>,
    /// A Soul's grant: the newest sequence sent for it, told with the outcome (#4978); 0 if none, or a creator's.
    pub newest: u64,
    /// The owner's messages for this socket, as text frames (R13).
    pub mail: mpsc::Receiver<String>,
    /// Notified when the socket is let go for a full queue (#4979): its task closes it as [`AGENT_BEHIND`] at once,
    /// not after sending the frames still queued.
    pub behind: Arc<tokio::sync::Notify>,
}

impl Gateway {
    /// Live socket state at this lookup, never inferred from a stored token. A stopping gateway is unknown.
    pub fn connected(&self, grant: Grant) -> Option<bool> {
        if *self.closing.borrow() {
            return None;
        }
        let hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        Some(
            hub.grants
                .get(&grant.key())
                .is_some_and(|h| h.sessions.values().any(|l| !l.frames.is_closed())),
        )
    }

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
            tokens_file: std::sync::OnceLock::new(),
            build,
            link: world_link::Link::default(),
            views: views::Views::default(),
            log,
            receipts,
            view_key: std::sync::OnceLock::new(),
            mailbox: std::sync::OnceLock::new(),
            exchange: std::sync::OnceLock::new(),
            entries: std::sync::OnceLock::new(),
            helpers: Mutex::new(BTreeMap::new()),
            bulk: bulk::Gauge::default(),
            uploads: std::sync::OnceLock::new(),
            closing: tokio::sync::watch::channel(false).0,
            hub: Mutex::new(Hub::default()),
            watchers: Mutex::new(BTreeMap::new()),
        })
    }

    /// Signs a socket in for `grant`, resuming after the first `seen` frames at `cursor`. On a Soul's grant a socket
    /// already signed in for it is let go (its queue closes, so its task ends): the last device wins. A creator's
    /// grant ([`shared`]) keeps the sockets it has: each sends its own intents and is given their answers. `who` is
    /// whom its answers count for in the receipts file.
    pub fn attach(
        &self,
        grant: Grant,
        cursor: Option<&Value>,
        seen: usize,
        who: Arc<Who>,
    ) -> Attached {
        self.attach_if(grant, cursor, seen, who, false)
            .unwrap_or_else(|| unreachable!("a sign-in that may take the grant is always attached"))
    }

    /// As [`Gateway::attach`], but with `free` only while no live socket holds `grant`: `None` when one does, and it
    /// is left as it is. Checked and signed in under one lock, so two at once never both take it.
    pub fn attach_if(
        &self,
        grant: Grant,
        cursor: Option<&Value>,
        seen: usize,
        who: Arc<Who>,
        free: bool,
    ) -> Option<Attached> {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        let held = hub
            .grants
            .get(&grant.key())
            .is_some_and(|h| h.sessions.values().any(|l| !l.frames.is_closed()));
        if free && held {
            return None;
        }
        let (tx, rx) = mpsc::channel(OUTBOUND);
        let (mail_tx, mail_rx) = mpsc::channel(OUTBOUND);
        let behind = Arc::new(tokio::sync::Notify::new());
        hub.next_session += 1;
        let session = hub.next_session;
        let held = hub.grants.entry(grant.key()).or_default();
        if !shared(grant) {
            held.sessions.clear();
            held.mailed.clear();
            held.listening = false;
        }
        held.sessions.insert(
            session,
            Live {
                frames: tx,
                mail: mail_tx,
                mailed: BTreeSet::new(),
                behind: behind.clone(),
            },
        );
        held.who = Some(who);
        self.tell_watchers(&grant.key(), mailbox::agent(grant, true, held.listening));
        let newest = if shared(grant) { 0 } else { held.newest };
        let (outcome, replay) = match cursor {
            None => (resume::STARTED, Vec::new()),
            Some(v) => match Cursor::from_value(v).map(|c| held.kept.resume(&c, seen)) {
                Some(Resume::Resumed(frames)) => (resume::RESUMED, frames),
                _ => (resume::CANNOT_RESUME, Vec::new()),
            },
        };
        Some(Attached {
            session,
            frames: rx,
            outcome,
            replay,
            newest,
            mail: mail_rx,
            behind,
        })
    }

    /// Whether another socket has signed in for `grant` since the one signed in as `session` (the last device wins).
    /// Never on a creator's grant ([`shared`]): its sockets are not replaced, so one let go for a full queue while
    /// another is open (the page beside its agent) is not told `agent.replaced`.
    pub fn replaced(&self, grant: Grant, session: u64) -> bool {
        let hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        !shared(grant)
            && hub
                .grants
                .get(&grant.key())
                .is_some_and(|h| h.sessions.keys().any(|s| *s > session))
    }

    /// Lets a socket go (if it was not let go already). With none signed in for the grant after, the view sockets
    /// that watch the grant are told its agent is gone (also after a slow socket was let go).
    pub fn detach(&self, grant: Grant, session: u64) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = hub.grants.get_mut(&grant.key()) {
            held.sessions.remove(&session);
            if held.sessions.is_empty() {
                held.listening = false;
                self.tell_watchers(&grant.key(), mailbox::agent(grant, false, false));
            }
        }
    }

    /// The socket signed in as `session` sends intent `sequence` for `grant`, now. On a shared grant its answers go
    /// to that socket from now ([`Held::route`]); `false`, and nothing noted, when another socket of the grant, still
    /// signed in, sent the same sequence and it is out or among the last answered ([`SEQUENCE_IN_USE`]).
    pub fn sending(&self, grant: Grant, sequence: u64, session: u64) -> bool {
        if !shared(grant) {
            return true;
        }
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        let newest = hub.next_session;
        let held = hub.grants.entry(grant.key()).or_default();
        let other = |s: u64| s != session && held.sessions.contains_key(&s);
        if held
            .senders
            .get(&sequence)
            .is_some_and(|o| other(o.session))
            || held
                .ended
                .iter()
                .any(|(q, s, _)| *q == sequence && other(*s))
        {
            return false;
        }
        held.senders.insert(
            sequence,
            Out {
                session,
                newest,
                digest: 0,
            },
        );
        true
    }

    /// A Soul's grant (one holder, #4978): the socket signed in as `session` sends intent `sequence`, its bytes hashed
    /// to `digest`, now. Its clients (the same token in two homes) take turns holding it and share the world's one
    /// numbering of its intents, so it is refused by name, nothing noted and nothing sent, when another socket has
    /// signed in for the grant since ([`AGENT_REPLACED`]), or when another intent went under the same sequence and is
    /// still out or among the last [`ENDED`] answered ([`SEQUENCE_IN_USE`]): the world would take it as a repeat of
    /// that one and answer it with that one's answer. The same intent sent again (after a lost socket) is not refused.
    pub fn holding(
        &self,
        grant: Grant,
        sequence: u64,
        session: u64,
        digest: u64,
    ) -> Result<(), &'static str> {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        let newest = hub.next_session;
        let held = hub.grants.entry(grant.key()).or_default();
        if held.sessions.keys().any(|s| *s > session) {
            return Err(AGENT_REPLACED);
        }
        if held
            .senders
            .get(&sequence)
            .is_some_and(|o| o.digest != digest)
            || held
                .ended
                .iter()
                .any(|(q, _, d)| *q == sequence && *d != digest)
        {
            return Err(SEQUENCE_IN_USE);
        }
        held.senders.insert(
            sequence,
            Out {
                session,
                newest,
                digest,
            },
        );
        held.newest = held.newest.max(sequence);
        Ok(())
    }

    /// An intent [`Gateway::sending`] or [`Gateway::holding`] noted was answered on its socket alone, by the gateway, before it reached the
    /// world or its stream (an own answer, not kept): its sender is forgotten.
    pub fn unsent(&self, grant: Grant, sequence: u64) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = hub.grants.get_mut(&grant.key()) {
            held.senders.remove(&sequence);
        }
    }

    /// The mailbox's open messages, `(grant key, id, text frame)`: each given once to each of its grant's signed-in
    /// sockets. A message no longer open is forgotten, so ids given stay as few as the open messages.
    pub fn post_mail(&self, open: Vec<(Vec<u8>, String, String)>) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        let ids: BTreeSet<&str> = open.iter().map(|(_, id, _)| id.as_str()).collect();
        for held in hub.grants.values_mut() {
            held.mailed.retain(|id| ids.contains(id.as_str()));
            for live in held.sessions.values_mut() {
                live.mailed.retain(|id| ids.contains(id.as_str()));
            }
            if held.mailed.is_empty() {
                held.doing.clear();
            }
        }
        for (key, id, frame) in &open {
            let Some(held) = hub.grants.get_mut(key) else {
                continue;
            };
            let mut given = false;
            for live in held.sessions.values_mut() {
                if !live.mailed.contains(id) && live.mail.try_send(frame.clone()).is_ok() {
                    live.mailed.insert(id.clone());
                    given = true;
                }
            }
            if given {
                held.mailed.insert(id.clone());
                if mailbox::id_like(id) {
                    let picked = format!(r#"{{"mail":{{"id":"{id}","state":"picked"}}}}"#);
                    self.tell_watchers(key, picked);
                }
            }
        }
    }

    /// W10: a view socket watches the messages of `grants`; its number, and the queue its text frames arrive on.
    /// The queue starts with whether each grant's agent is connected now (`mailbox::agent`); each change follows.
    pub fn watch(&self, grants: &[Grant]) -> (u64, mpsc::Sender<String>, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel(OUTBOUND);
        for g in grants.iter().take(OUTBOUND / 2) {
            let _ = tx.try_send(self.presence(*g));
        }
        let mut w = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        let n = w.keys().next_back().map_or(1, |n| n + 1);
        w.insert(n, (grants.iter().map(|g| g.key()).collect(), tx.clone()));
        (n, tx, rx)
    }

    /// W10: what a watching view socket may see changed (its token was renewed for other grants); a grant new to it
    /// is told whether its agent is connected.
    pub fn rewatch(&self, n: u64, grants: &[Grant]) {
        let now: Vec<(Vec<u8>, String)> = grants
            .iter()
            .map(|g| (g.key(), self.presence(*g)))
            .collect();
        let mut w = self.watchers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((keys, tx)) = w.get_mut(&n) {
            for (k, frame) in &now {
                if !keys.contains(k) {
                    let _ = tx.try_send(frame.clone());
                }
            }
            *keys = now.into_iter().map(|(k, _)| k).collect();
        }
    }

    /// The owner's box's presence frame for `grant` as it is now: whether its agent is connected, and listening.
    fn presence(&self, grant: Grant) -> String {
        let connected = self.connected(grant) == Some(true);
        let hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        let listening = hub.grants.get(&grant.key()).is_some_and(|h| h.listening);
        mailbox::agent(grant, connected, connected && listening)
    }

    /// The socket signed in for `grant` as `session` says whether a reader of its messages is open now; a change is
    /// told to the view sockets that watch the grant. Nothing from a socket no longer signed in.
    pub fn set_listening(&self, grant: Grant, session: u64, on: bool) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = hub.grants.get_mut(&grant.key())
            && held.sessions.contains_key(&session)
            && held.listening != on
        {
            held.listening = on;
            self.tell_watchers(&grant.key(), mailbox::agent(grant, true, on));
        }
    }

    /// The agent of `grant` read message `id` (its client handed it to the agent's turn): told to the view sockets
    /// that watch the grant as `{"mail": {"id", "state": "read"}}`, while the message is one given to it and open.
    pub fn read_mail(&self, grant: Grant, id: &str) {
        let key = grant.key();
        let hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if mailbox::id_like(id) && hub.grants.get(&key).is_some_and(|h| h.mailed.contains(id)) {
            self.tell_watchers(
                &key,
                format!(r#"{{"mail":{{"id":"{id}","state":"read"}}}}"#),
            );
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

    /// A text frame for the socket signed in as `session` for `key`, now (G11: the directory's reply to that socket's
    /// prayer frame). Dropped if it has gone.
    pub fn post_text(&self, key: &[u8], session: u64, frame: String) {
        let hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(live) = hub.grants.get(key).and_then(|h| h.sessions.get(&session)) {
            let _ = live.mail.try_send(frame);
        }
    }

    /// An answer the gateway gives itself to the actor `key`'s intent `sequence` (`{2: answer}`, not kept for a
    /// resume), which ends it: sent to the socket that sent it, as [`Held::route`] says; a socket whose queue is full
    /// is let go, as by [`Gateway::deliver`].
    pub fn tell(&self, key: &[u8], sequence: u64, frame: Vec<u8>) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = hub.grants.get_mut(key) {
            held.newest = held.newest.max(sequence);
            let to = held.route(Answering {
                sequence,
                ends: true,
            });
            self.queue(held, &to, frame, None);
        }
    }

    /// A frame for the socket signed in as `session` for `key` alone, not kept for a resume (a sync answer, to the
    /// socket that asked). Dropped if it has gone, or its queue is full; the client asks again.
    pub fn reply(&self, key: &[u8], session: u64, frame: Vec<u8>) {
        let hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(live) = hub.grants.get(key).and_then(|h| h.sessions.get(&session)) {
            let _ = live.frames.try_send(frame);
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

    /// A frame of the world's stream for the actor `key`, answering `a`: kept for a resume, and queued to the
    /// sockets [`Held::route`] names. A socket whose queue is full is let go; it resumes from its cursor.
    pub fn deliver(&self, key: Vec<u8>, a: Answering, at: Cursor, frame: Vec<u8>) {
        let mut hub = self.hub.lock().unwrap_or_else(|e| e.into_inner());
        let held = hub.grants.entry(key.clone()).or_default();
        // #4978: an answer names a sequence sent for the grant, also one sent before the gateway restarted.
        held.newest = held.newest.max(a.sequence);
        self.answered(held, &key, &frame);
        held.kept.push(at, frame.clone());
        let trace = world_link::delivery_trace(&frame);
        let to = held.route(a);
        self.queue(held, &to, frame, trace.as_ref());
    }

    /// Queues `frame` to the sockets `to` of `held`; one whose queue is full (or closed) is let go.
    fn queue(
        &self,
        held: &mut Held,
        to: &[u64],
        frame: Vec<u8>,
        trace: Option<&world_link::DeliveryTrace>,
    ) {
        if to.is_empty()
            && let Some(t) = trace
        {
            t.at("gateway-channel", "no-session");
        }
        // Copied for all but the last, which takes it: a Soul's grant, with one socket, copies nothing.
        let last = to.len().saturating_sub(1);
        let mut frame = Some(frame);
        for (n, session) in to.iter().enumerate() {
            let out = if n == last {
                frame.take()
            } else {
                frame.clone()
            };
            let (Some(out), Some(live)) = (out, held.sessions.get(session)) else {
                continue;
            };
            match live.frames.try_send(out) {
                Ok(()) => {
                    if let Some(t) = trace {
                        t.at("gateway-channel", "queued");
                    }
                }
                Err(e) => {
                    if let Some(t) = trace {
                        t.at(
                            "gateway-channel",
                            if matches!(e, tokio::sync::mpsc::error::TrySendError::Full(_)) {
                                "full"
                            } else {
                                "closed"
                            },
                        );
                    }
                    // Its task is told at once (#4979): it closes the socket as `agent.behind`, not after the backlog.
                    live.behind.notify_one();
                    held.sessions.remove(session);
                    (self.log)(
                        "a socket's outbound queue was full; it was let go as agent.behind and may resume",
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Gateway {
        /// A shared grant's intents out, by sequence, and the sessions that sent them.
        fn senders(&self, g: Grant) -> Vec<(u64, u64)> {
            let hub = self.hub.lock().unwrap();
            hub.grants
                .get(&g.key())
                .map(|h| h.senders.iter().map(|(q, o)| (*q, o.session)).collect())
                .unwrap_or_default()
        }
    }

    fn gateway() -> Arc<Gateway> {
        Gateway::new(Tokens::default(), vec![], Arc::new(|_| {}))
    }

    fn grant(kind: &str) -> Grant {
        Grant::parse(&format!("{kind}-{}-1", "5a".repeat(16))).unwrap()
    }

    fn at(sequence: u64) -> Cursor {
        Cursor {
            place: (Value::Bytes(vec![7; 16]), Value::Array(Vec::new())),
            epoch: 1,
            sequence,
        }
    }

    fn sign_in(gw: &Gateway, g: Grant) -> Attached {
        gw.attach(g, None, 1, Arc::new(Who::default()))
    }

    fn ends(sequence: u64) -> Answering {
        Answering {
            sequence,
            ends: true,
        }
    }

    /// The frames queued to a socket now.
    fn got(a: &mut Attached) -> Vec<Vec<u8>> {
        std::iter::from_fn(|| a.frames.try_recv().ok()).collect()
    }

    #[test]
    fn a_creators_sockets_each_get_their_own_answers() {
        let gw = gateway();
        let creator = grant("creator");
        let (mut page, mut agent) = (sign_in(&gw, creator), sign_in(&gw, creator));
        assert!(
            !page.frames.is_closed(),
            "the agent signing in keeps the page"
        );
        // Alternately, and one sent while the other's is still out: each answer to its sender alone.
        assert!(gw.sending(creator, 10, page.session));
        assert!(gw.sending(creator, 11, agent.session));
        let progress = Answering {
            sequence: 11,
            ends: false,
        };
        gw.deliver(
            creator.key(),
            progress,
            at(1),
            b"agent-11-accepted".to_vec(),
        );
        gw.deliver(creator.key(), ends(10), at(2), b"page-10".to_vec());
        gw.deliver(creator.key(), ends(11), at(3), b"agent-11".to_vec());
        assert!(gw.sending(creator, 12, page.session));
        gw.deliver(creator.key(), ends(12), at(4), b"page-12".to_vec());
        assert_eq!(got(&mut page), [b"page-10".to_vec(), b"page-12".to_vec()]);
        assert_eq!(
            got(&mut agent),
            [b"agent-11-accepted".to_vec(), b"agent-11".to_vec()]
        );
        // An answer no socket of the grant is known to have sent (a bulk edit's, or one the world handed over from
        // before a restart) goes to each, as it went to the one holder.
        gw.deliver(creator.key(), ends(99), at(5), b"bulk-99".to_vec());
        assert_eq!(got(&mut page), [b"bulk-99".to_vec()]);
        assert_eq!(got(&mut agent), [b"bulk-99".to_vec()]);
        // The gateway's own answers and a sync answer go to the asker too.
        assert!(gw.sending(creator, 13, agent.session));
        gw.tell(&creator.key(), 13, b"agent-13-timed-out".to_vec());
        gw.reply(&creator.key(), page.session, b"page-sync".to_vec());
        assert_eq!(got(&mut agent), [b"agent-13-timed-out".to_vec()]);
        assert_eq!(got(&mut page), [b"page-sync".to_vec()]);
        assert!(
            gw.senders(creator).is_empty(),
            "every ended intent forgotten"
        );
    }

    #[test]
    fn one_of_a_creators_sockets_going_leaves_the_other_answered() {
        let gw = gateway();
        let creator = grant("creator");
        let (page, mut agent) = (sign_in(&gw, creator), sign_in(&gw, creator));
        assert!(gw.sending(creator, 20, page.session));
        assert!(gw.sending(creator, 21, agent.session));
        let (_, _, mut watching) = gw.watch(&[creator]);
        watching.try_recv().unwrap();
        gw.detach(creator, page.session);
        drop(page);
        assert!(watching.try_recv().is_err(), "the agent is still connected");
        assert_eq!(gw.connected(creator), Some(true));
        gw.deliver(creator.key(), ends(21), at(1), b"agent-21".to_vec());
        assert!(gw.sending(creator, 22, agent.session));
        gw.deliver(creator.key(), ends(22), at(2), b"agent-22".to_vec());
        assert_eq!(
            got(&mut agent),
            [b"agent-21".to_vec(), b"agent-22".to_vec()]
        );
        // The page's answer, its socket gone: kept for its resume, and not given to the agent, which signed in
        // before the page sent it.
        gw.deliver(creator.key(), ends(20), at(3), b"page-20".to_vec());
        assert!(got(&mut agent).is_empty());
        let cursor = Value::Array(vec![
            Value::Bytes(vec![7; 16]),
            Value::Array(Vec::new()),
            Value::Uint(1),
            Value::Uint(2),
        ]);
        let mut back = gw.attach(creator, Some(&cursor), 1, Arc::new(Who::default()));
        assert_eq!(back.outcome, resume::RESUMED);
        assert_eq!(
            back.replay,
            [b"page-20".to_vec()],
            "resumed from its cursor"
        );
        assert_eq!(
            watching.try_recv().unwrap(),
            mailbox::agent(creator, true, false)
        );
        gw.detach(creator, agent.session);
        drop(agent);
        assert!(watching.try_recv().is_err(), "the page is back");
        assert!(gw.sending(creator, 23, back.session));
        gw.deliver(creator.key(), ends(23), at(4), b"page-23".to_vec());
        assert_eq!(got(&mut back), [b"page-23".to_vec()]);
        gw.detach(creator, back.session);
        assert_eq!(
            watching.try_recv().unwrap(),
            mailbox::agent(creator, false, false)
        );
    }

    #[test]
    fn a_sequence_another_creator_socket_has_out_is_refused_until_answered() {
        let gw = gateway();
        let creator = grant("creator");
        let (page, agent) = (sign_in(&gw, creator), sign_in(&gw, creator));
        assert!(gw.sending(creator, 30, page.session));
        assert!(gw.sending(creator, 30, page.session), "its own, sent again");
        assert!(
            !gw.sending(creator, 30, agent.session),
            "the page's, still out"
        );
        assert_eq!(gw.senders(creator), [(30, page.session)]);
        gw.deliver(creator.key(), ends(30), at(1), b"page-30".to_vec());
        // Answered lately: the world would answer a repeat with the page's kept answer.
        assert!(
            !gw.sending(creator, 30, agent.session),
            "the page's, lately answered"
        );
        // Every older answered one is the world's `intent.stale-seq`, by name, on the agent's socket.
        for q in 100..100 + ENDED as u64 {
            assert!(gw.sending(creator, q, page.session));
            gw.deliver(creator.key(), ends(q), at(2), Vec::new());
        }
        assert!(gw.sending(creator, 30, agent.session));
        // Sent from a socket that has gone: the one sending it now takes it (a client back on a new socket).
        assert!(gw.sending(creator, 31, page.session));
        gw.detach(creator, page.session);
        assert!(gw.sending(creator, 31, agent.session));
        assert_eq!(
            gw.senders(creator),
            [(30, agent.session), (31, agent.session)]
        );
    }

    #[test]
    fn a_client_back_on_a_new_socket_gets_its_answer_while_its_old_one_lingers() {
        let gw = gateway();
        let creator = grant("creator");
        let mut page = sign_in(&gw, creator);
        let mut old = sign_in(&gw, creator);
        assert!(gw.sending(creator, 40, old.session));
        // The agent's network died unnoticed by the gateway: its client signs in again; the old socket lingers.
        let mut back = sign_in(&gw, creator);
        let progress = Answering {
            sequence: 40,
            ends: false,
        };
        gw.deliver(
            creator.key(),
            progress,
            at(1),
            b"agent-40-accepted".to_vec(),
        );
        gw.deliver(creator.key(), ends(40), at(2), b"agent-40".to_vec());
        let both = [b"agent-40-accepted".to_vec(), b"agent-40".to_vec()];
        assert_eq!(got(&mut back), both, "the client on its new socket");
        assert_eq!(got(&mut old), both);
        assert!(
            got(&mut page).is_empty(),
            "the page signed in before it was sent"
        );
    }

    #[test]
    fn a_souls_grant_keeps_one_socket_the_last_device_wins() {
        let gw = gateway();
        let soul = grant("soul");
        let mut old = sign_in(&gw, soul);
        let mut new = sign_in(&gw, soul);
        assert_eq!(
            old.frames.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        );
        assert!(
            gw.sending(soul, 1, old.session),
            "a Soul's numbering is its client's"
        );
        assert!(gw.senders(soul).is_empty());
        gw.deliver(soul.key(), ends(1), at(1), b"soul-1".to_vec());
        assert_eq!(got(&mut new), [b"soul-1".to_vec()]);
    }

    #[test]
    fn a_souls_clients_share_one_numbering_and_a_replaced_ones_intent_is_refused() {
        let gw = gateway();
        let soul = grant("soul");
        let first = sign_in(&gw, soul);
        assert_eq!(first.newest, 0, "nothing sent for it yet");
        assert_eq!(gw.holding(soul, 5, first.session, digest(b"a5")), Ok(()));
        assert_eq!(gw.holding(soul, 6, first.session, digest(b"a6")), Ok(()));
        gw.deliver(soul.key(), ends(5), at(1), b"a5-answer".to_vec());
        // Another client takes the Soul: it is told the newest sequence sent, so it numbers after it.
        let second = sign_in(&gw, soul);
        assert_eq!(second.newest, 6);
        // The first one's intent read after that is refused by name, and nothing is noted.
        assert_eq!(
            gw.holding(soul, 7, first.session, digest(b"a7")),
            Err(AGENT_REPLACED)
        );
        // A client that numbered on its own: another intent under a sequence still out, or lately answered.
        assert_eq!(
            gw.holding(soul, 6, second.session, digest(b"b6")),
            Err(SEQUENCE_IN_USE)
        );
        assert_eq!(
            gw.holding(soul, 5, second.session, digest(b"b5")),
            Err(SEQUENCE_IN_USE)
        );
        // The same intent sent again after a lost socket is not refused; the next number is free.
        assert_eq!(gw.holding(soul, 6, second.session, digest(b"a6")), Ok(()));
        assert_eq!(gw.holding(soul, 7, second.session, digest(b"b7")), Ok(()));
        // The first takes it back and is told the second's newest.
        let back = sign_in(&gw, soul);
        assert_eq!(back.newest, 7);
        assert_eq!(gw.holding(soul, 8, back.session, digest(b"a8")), Ok(()));
        assert!(
            gw.holding(soul, 9, second.session, digest(b"b9")).is_err(),
            "the second, replaced in turn"
        );
    }

    #[test]
    fn each_creator_socket_is_given_an_open_message_once() {
        let gw = gateway();
        let creator = grant("creator");
        let (_, _, mut watching) = gw.watch(&[creator]);
        watching.try_recv().unwrap();
        let mut page = sign_in(&gw, creator);
        watching.try_recv().unwrap();
        let open = || {
            vec![(
                creator.key(),
                "m-1".to_owned(),
                r#"{"mail":{"id":"m-1"}}"#.to_owned(),
            )]
        };
        gw.post_mail(open());
        let mut agent = sign_in(&gw, creator);
        watching.try_recv().unwrap();
        gw.post_mail(open());
        gw.post_mail(open());
        assert_eq!(page.mail.try_recv().unwrap(), r#"{"mail":{"id":"m-1"}}"#);
        assert_eq!(agent.mail.try_recv().unwrap(), r#"{"mail":{"id":"m-1"}}"#);
        assert!(
            page.mail.try_recv().is_err() && agent.mail.try_recv().is_err(),
            "once each"
        );
        gw.post_text(&creator.key(), agent.session, "agent-reply".to_owned());
        assert_eq!(agent.mail.try_recv().unwrap(), "agent-reply");
        assert!(page.mail.try_recv().is_err());
    }

    /// First-day 27 Nov: a connected client is not an agent reading its messages. The owner's box is told whether
    /// the client said a reader is open, and when the agent read a message, not only that the client was given it.
    #[test]
    fn the_owners_box_is_told_whether_the_agent_listens_and_what_it_read() {
        let gw = gateway();
        let soul = grant("soul");
        let (_, _, mut watching) = gw.watch(&[soul]);
        assert_eq!(
            watching.try_recv().unwrap(),
            mailbox::agent(soul, false, false)
        );
        let first = sign_in(&gw, soul);
        assert_eq!(
            watching.try_recv().unwrap(),
            mailbox::agent(soul, true, false),
            "connected, and nobody reads yet"
        );
        gw.set_listening(soul, first.session, true);
        assert_eq!(
            watching.try_recv().unwrap(),
            mailbox::agent(soul, true, true)
        );
        gw.set_listening(soul, first.session, true);
        assert!(watching.try_recv().is_err(), "no change, nothing said");
        let (n, _, mut late) = gw.watch(&[soul]);
        assert_eq!(
            late.try_recv().unwrap(),
            mailbox::agent(soul, true, true),
            "as it is now"
        );
        gw.unwatch(n);

        // a message given to the client is picked; read only when the client says the agent read it
        let open = vec![(
            soul.key(),
            "m_1".to_owned(),
            r#"{"mail":{"id":"m_1"}}"#.to_owned(),
        )];
        gw.read_mail(soul, "m_1");
        assert!(watching.try_recv().is_err(), "not given yet: nothing");
        gw.post_mail(open);
        assert_eq!(
            watching.try_recv().unwrap(),
            r#"{"mail":{"id":"m_1","state":"picked"}}"#
        );
        gw.read_mail(soul, "m_2");
        gw.read_mail(soul, "m\"1");
        assert!(
            watching.try_recv().is_err(),
            "another id, or not an id: nothing"
        );
        gw.read_mail(soul, "m_1");
        assert_eq!(
            watching.try_recv().unwrap(),
            r#"{"mail":{"id":"m_1","state":"read"}}"#
        );

        // the reader closes; a new device takes the Soul and starts with nobody reading
        gw.set_listening(soul, first.session, false);
        assert_eq!(
            watching.try_recv().unwrap(),
            mailbox::agent(soul, true, false)
        );
        gw.set_listening(soul, first.session, true);
        watching.try_recv().unwrap();
        let second = sign_in(&gw, soul);
        assert_eq!(
            watching.try_recv().unwrap(),
            mailbox::agent(soul, true, false)
        );
        gw.set_listening(soul, first.session, true);
        assert!(
            watching.try_recv().is_err(),
            "the replaced socket says nothing"
        );
        gw.set_listening(soul, second.session, true);
        watching.try_recv().unwrap();
        gw.detach(soul, second.session);
        assert_eq!(
            watching.try_recv().unwrap(),
            mailbox::agent(soul, false, false)
        );
        let back = sign_in(&gw, soul);
        assert_eq!(
            watching.try_recv().unwrap(),
            mailbox::agent(soul, true, false),
            "a reader is not carried over a new sign-in"
        );
        drop(back);
    }
}
