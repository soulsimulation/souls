//! The gateway's one local socket to its world (Engine v2 I1, #2683). Frames both ways are a 4-byte big-endian length
//! and that many bytes. The gateway sends each intent as the agent sent it (T10 rule 2); the world answers
//! `{1: version, 2: answer}` (T10 rule 8, the version T3's).
//!
//! Every intent sent is kept until it is answered. When the socket drops, the gateway reconnects and sends what is
//! unanswered again, in the order it first sent it, so each actor's intents reach the world in sequence order; the
//! world drops repeats by (actor, sequence) (`worldd`'s `gateway_link`). An intent that arrives while the world is
//! away is answered at once with [`RESTARTING`] and never sent. The world's repeats across its own restart are I4's
//! durable half.
//!
//! **A restart of the gateway itself** (0.133 verification). The intents a gateway kept go with it, while the world
//! goes on: a walk accepted before the restart ends after it. So each connection to the world begins with
//! [`handover_ask`], and the world hands an ended gateway connection's answers to the newest one, or holds them until
//! one asks (`worldd::handover`). An answer for an intent this gateway does not hold is passed to its actor's socket
//! (and kept for a resume) the first time; an answer that could come twice (to an intent sent on two connections, one
//! the gateway answered itself by its deadline, or one passed on so) is remembered ([`RECENT`]), as is every kept
//! intent answered lately ([`ANSWERED`]: a client's repeat through a new gateway), and a second copy
//! dropped, so each intent is answered once. A stopping gateway (SIGTERM) lets the world go before its sockets close,
//! so what the world answers after that goes to the next gateway rather than to sockets that are closing.
//!
//! A sleeping world (O2, #2731): with a wake set ([`Link::set_wake`], the gateway's `--wake`), an intent that
//! arrives while the world is away is held instead, and the gateway asks once for the world to be woken; the held
//! intents go when it is reachable, as on any reconnect, and one whose deadline passes first is answered as below.
//! A sync request asks too: only an agent sends one (viewers read the public stream, which wakes nothing), and an
//! agent's client syncs before it sends its first intent, so without it a Soul arriving at a sleeping world waited
//! forever. The sync request itself is still answered [`RESTARTING`]: the client asks again once the world is up.
//!
//! A sync request (R5b, #3164; `replica::sync::wire`) goes to the world under the gateway's own number, with the
//! asking actor; its answer goes back to the socket that asked, under the client's number. One asked while the world
//! is away, or not yet answered when the link drops, is answered at once with [`RESTARTING`]: the client asks again.
//!
//! **Never silence** (C8, #3396). Each kept intent has a deadline: its expiry, or [`DEADLINE`] after it was received,
//! whichever is sooner (the world's own, `worldd::answers::Config::deadline`). Once it passes while the world is away,
//! the gateway answers the intent itself, `intent.expired` when the expiry came first and `act.timed-out` otherwise,
//! and drops it, so it is never sent again ([`deadlines`]). While the world is reachable it answers by its own
//! deadline; the gateway steps in only [`WEDGED`] after it, for a world that takes intents and never answers.
//!
//! **In progress** (C20, #3469). A form's act runs as long as its walk and its own steps take, from its start (a
//! walk across the town, a long read). When its run starts (a gateway walk: when its route is planned), the world
//! says so with a progress answer, T10's accepted with how long the act has left (`worldd::answers::progress`; W11,
//! #4087: in the tick it starts, not at [`DEADLINE`]): the gateway passes it on to the actor and moves the intent's
//! deadline to the world's, so it answers in-flight acts with progress, not `act.timed-out`. The intent stays kept
//! until its answer comes; an intent the world has said nothing of still has [`DEADLINE`].
//!
//! **Turns** (S2, 0.133). The world reads its link as fast as it comes and takes intents first come, first served, so
//! one agent's flood would stand in front of everyone's. The gateway keeps each agent's place: at most [`TURN`] of an
//! agent's intents are in the world's line at a time, from when they are sent until the world first answers them
//! (progress, a receipt or a refusal); the agent's next ones wait in its own queue, in order, and go as those are
//! answered. A flooding agent waits behind its own intents; one that sends now and then finds its place free. Nothing
//! is refused or dropped for speed: a waiting intent keeps its deadline (C8) like any other. Sync requests are not
//! intents and go at once.

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode};
use replica::sync::wire;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::Gateway;
use crate::receipts::Outcome;
use crate::resume::Cursor;
use crate::times;

/// Opt-in native delivery evidence. Hashes correlate frames without exposing actor ids or payloads.
pub(crate) struct DeliveryTrace {
    actor: String,
    sequence: u64,
    kind: u64,
    version: Option<u64>,
}

impl DeliveryTrace {
    pub(crate) fn at(&self, stage: &str, outcome: &str) {
        eprintln!(
            "gatewayd: join-delivery stage={stage} actor-hash={} sequence={} kind={} version={:?} outcome={outcome} elapsed-us={}",
            self.actor,
            self.sequence,
            self.kind,
            self.version,
            delivery_elapsed_us()
        );
    }

    /// The application binary payload after its one existing timing-block finish, not a WebSocket header.
    pub(crate) fn final_frame(&self, frame: &[u8]) {
        eprintln!(
            "gatewayd: join-delivery stage=socket-final-frame actor-hash={} sequence={} kind={} version={:?} bytes={} sha256={} elapsed-us={}",
            self.actor,
            self.sequence,
            self.kind,
            self.version,
            frame.len(),
            replica::encode::to_hex(&replica::ids::sha256(frame)),
            delivery_elapsed_us()
        );
    }
}

// Called only through an enabled DeliveryTrace; the disabled fast path performs no clock read.
fn delivery_elapsed_us() -> u64 {
    static START: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    let now = crate::times::stamp();
    let origin = START.get_or_init(|| now);
    now.saturating_sub(*origin).min(120_000_000)
}

pub(crate) fn delivery_trace(frame: &[u8]) -> Option<DeliveryTrace> {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ENABLED
        .get_or_init(|| std::env::var_os("SOULS_JOIN_DELIVERY_TRACE").is_some_and(|v| v == "1"))
    {
        return None;
    }
    delivery_metadata(frame)
}

fn delivery_metadata(frame: &[u8]) -> Option<DeliveryTrace> {
    let Value::Map(m) = decode(frame).ok()?.value else {
        return None;
    };
    let Value::Map(a) = m.get(&2)? else {
        return None;
    };
    let (Some(actor), Some(Value::Uint(sequence)), Some(Value::Uint(kind))) =
        (a.get(&1), a.get(&2), a.get(&3))
    else {
        return None;
    };
    let actor = replica::encode::to_hex(&replica::ids::sha256(&encode(actor).ok()?));
    let version = match m.get(&1) {
        Some(Value::Array(v)) => v.last().and_then(|v| match v {
            Value::Uint(n) => Some(*n),
            _ => None,
        }),
        _ => None,
    };
    Some(DeliveryTrace {
        actor,
        sequence: *sequence,
        kind: *kind,
        version,
    })
}

/// How many of one agent's intents may be in the world's line at a time, sent and not yet answered (S2).
pub const TURN: usize = 4;

/// The key of the frame sent first on each connection to the world, `{31: []}`: this is the world's gateway, so the
/// answers an ended connection could not take come here (worldd's `handover::ASK`).
pub const HANDOVER: u64 = 31;

/// How many answers that could come twice (to an intent sent again, answered by the gateway itself, or handed on from
/// an ended connection) are remembered, so the second is dropped.
pub const RECENT: usize = 4096;

/// How many kept intents' answers are remembered, newest last: a kept intent the world answers on two connections (a
/// client's repeat through a new gateway, and the ended connection's copy handed on) has both copies leave the world
/// in one tick, so a short ring that every answer passes through catches the second.
pub const ANSWERED: usize = 1024;

/// The frame that says this is the world's gateway ([`HANDOVER`]).
pub fn handover_ask() -> Vec<u8> {
    encode(&Value::Map([(HANDOVER, Value::Array(Vec::new()))].into())).unwrap_or_default()
}

/// The answer to an intent sent while the world restarts.
pub const RESTARTING: &str = "world.restarting";

/// The longest frame read from the world. A sync answer carries whole records, and one record can be large: Eden's open
/// ground holds every terrain tile's heights and classes, 5.4 MB, and a room's record lists each child's hash (36 bytes
/// each). At 1 MiB neither could be sent, and the link was dropped at every try (#3424).
pub const FRAME_MOST: usize = 16 << 20;

/// How long the gateway waits between attempts to reach the world.
const RETRY: Duration = Duration::from_millis(20);

/// The longest an act stays open after it is received, µs, unless the world says it is in progress: the world's
/// deadline at an act's arrival (`worldd::answers::Config`).
pub const DEADLINE: u64 = 10_000_000;
/// How long past an intent's deadline a reachable world has to answer it before the gateway does, µs.
pub const WEDGED: u64 = 20_000_000;
/// How often the gateway looks for intents past their deadline.
const SWEEP: Duration = Duration::from_millis(50);
/// The gateway's answer to an intent whose expiry passed unanswered.
pub const EXPIRED: &str = "intent.expired";
/// The gateway's answer to an intent whose deadline passed unanswered before its expiry.
pub const TIMED_OUT: &str = "act.timed-out";

/// Asks for the sleeping world to be woken; it must not block.
pub type Wake = Arc<dyn Fn() + Send + Sync>;

/// What became of an intent handed to the link.
#[derive(Debug, PartialEq, Eq)]
pub enum Sent {
    /// Sent (or kept to send again): the world answers it.
    Sent,
    /// The world is away: answer it with [`RESTARTING`].
    Restarting,
}

#[derive(Default)]
pub struct Link {
    state: Mutex<State>,
}

/// A kept intent: its actor's bytes, its bytes, when it was received and handed to the link (O4's gateway in, the
/// steady clock), its actor and sequence, and its deadline on the steady clock with the answer given then (C8).
struct Pending {
    key: Vec<u8>,
    bytes: Vec<u8>,
    received: u64,
    handed: u64,
    actor: Actor,
    sequence: u64,
    due: u64,
    reason: &'static str,
    /// In the world's line: sent on this connection and not yet answered at all (S2).
    flying: bool,
    /// Sent on more than one connection: the world may answer it on each.
    resent: bool,
}

#[derive(Default)]
struct State {
    next: u64,
    /// Unanswered intents in the order they were first sent.
    pending: BTreeMap<u64, Pending>,
    index: BTreeMap<(Vec<u8>, u64), u64>,
    out: Option<mpsc::UnboundedSender<Vec<u8>>>,
    /// The newest version the world sent: the "version now" of a refusal the gateway gives itself.
    now: Option<Value>,
    /// Sync requests sent and not yet answered, by the gateway's number: the actor's bytes, the asking socket's
    /// session and the client's number.
    syncs: BTreeMap<u64, (Vec<u8>, u64, Value)>,
    /// How to wake a sleeping world, and whether it was asked since the world was last reachable.
    wake: Option<Wake>,
    asked: bool,
    /// S2: each agent's intents in the world's line now, and those waiting their turn, by number, oldest first.
    flying: BTreeMap<Vec<u8>, usize>,
    waiting: BTreeMap<Vec<u8>, VecDeque<u64>>,
    /// Intents answered whose answer could come again, by actor's bytes and sequence, newest last ([`RECENT`]).
    recent: VecDeque<(Vec<u8>, u64)>,
    /// Every kept intent answered lately, by actor's bytes and sequence, newest last ([`ANSWERED`]).
    answered: VecDeque<(Vec<u8>, u64)>,
}

/// What an answer from the world is to the gateway.
#[derive(Debug, PartialEq, Eq)]
enum Answered {
    /// To a kept intent: when it was received and handed on.
    Kept(u64, u64),
    /// To an intent this gateway does not hold (sent before it started): passed to its actor.
    Unheld,
    /// Already answered: dropped.
    Again,
}

impl State {
    fn remember(&mut self, key: Vec<u8>, sequence: u64) {
        if self.recent.len() == RECENT {
            self.recent.pop_front();
        }
        self.recent.push_back((key, sequence));
    }

    /// Sends kept intent `n` now if its agent has a place in the world's line, else queues it behind the agent's own.
    fn turn(&mut self, n: u64) {
        let Some(p) = self.pending.get(&n) else {
            return;
        };
        let key = p.key.clone();
        let Some(out) = self.out.clone() else {
            return;
        };
        let line = self.flying.entry(key.clone()).or_insert(0);
        if *line >= TURN {
            self.waiting.entry(key).or_default().push_back(n);
            return;
        }
        *line += 1;
        let p = self
            .pending
            .get_mut(&n)
            .unwrap_or_else(|| unreachable!("looked up above"));
        p.flying = true;
        p.handed = times::stamp();
        // A send to a writer that has just ended is not lost: the intent stays kept and goes again on reconnect.
        let _ = out.send(p.bytes.clone());
    }

    /// Intent `n` (taken from `pending` already when `flying` is given) left the world's line: its agent's next
    /// waiting intent goes.
    fn landed(&mut self, key: &[u8], was_flying: bool) {
        if !was_flying {
            return;
        }
        if let Some(line) = self.flying.get_mut(key) {
            *line = line.saturating_sub(1);
        }
        while self.flying.get(key).copied().unwrap_or(0) < TURN {
            let Some(next) = self.waiting.get_mut(key).and_then(VecDeque::pop_front) else {
                break;
            };
            self.turn(next);
        }
        if self.waiting.get(key).is_some_and(VecDeque::is_empty) {
            self.waiting.remove(key);
        }
        if self.flying.get(key) == Some(&0) {
            self.flying.remove(key);
        }
    }
}

impl Link {
    /// Hands an intent to the world, keeping it until it is answered; `received` is when its socket read it (the
    /// steady clock, [`times::stamp`]) and `left` how long its expiry was off then, µs.
    pub fn submit(
        &self,
        key: Vec<u8>,
        actor: Actor,
        sequence: u64,
        bytes: Vec<u8>,
        received: u64,
        left: i64,
    ) -> Sent {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let out = s.out.clone();
        if out.is_none() {
            let Some(wake) = s.wake.clone() else {
                return Sent::Restarting;
            };
            // The world may be asleep: hold the intent and ask, once, for the world to be woken.
            if !std::mem::replace(&mut s.asked, true) {
                wake();
            }
        }
        if s.index.contains_key(&(key.clone(), sequence)) {
            // Sent again while still unanswered: it is answered once.
            return Sent::Sent;
        }
        let n = s.next;
        s.next += 1;
        s.index.insert((key.clone(), sequence), n);
        let left = u64::try_from(left).unwrap_or(0);
        let (wait, reason) = if left <= DEADLINE {
            (left, EXPIRED)
        } else {
            (DEADLINE, TIMED_OUT)
        };
        s.pending.insert(
            n,
            Pending {
                key,
                bytes,
                received,
                handed: times::stamp(),
                actor,
                sequence,
                due: received.saturating_add(wait),
                reason,
                flying: false,
                resent: false,
            },
        );
        drop(out);
        s.turn(n);
        Sent::Sent
    }

    /// Hands a sync request to the world: `ask` is the client's request, with its number `n` taken out, from the
    /// socket signed in as `session`, which alone is given its answer.
    pub fn ask(&self, key: Vec<u8>, session: u64, n: Value, mut ask: BTreeMap<u64, Value>) -> Sent {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(out) = s.out.clone() else {
            // Only an agent (a grant on a socket) asks here: a Soul's client syncs before it sends any intent, so a
            // sleeping world that waited for an intent would never be woken by one. Asked awake once, as an intent
            // asks; the request is still answered `world.restarting` and the client asks again.
            if let Some(wake) = s.wake.clone()
                && !std::mem::replace(&mut s.asked, true)
            {
                wake();
            }
            return Sent::Restarting;
        };
        let ours = s.next;
        s.next += 1;
        ask.insert(wire::ASK, Value::Uint(ours));
        ask.insert(wire::ACTOR, Value::Bytes(key.clone()));
        let Ok(bytes) = encode(&Value::Map(ask)) else {
            return Sent::Restarting;
        };
        s.syncs.insert(ours, (key, session, n));
        let _ = out.send(bytes);
        Sent::Sent
    }

    /// Sets how to wake a sleeping world: from now, an intent while the world is away is held and a wake asked.
    pub fn set_wake(&self, wake: Wake) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).wake = Some(wake);
    }

    /// Whether the world is reachable now.
    pub fn up(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .out
            .is_some()
    }

    /// Intents sent and not yet answered.
    pub fn unanswered(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .len()
    }

    /// The newest version the world sent, or an empty array before any.
    pub fn now(&self) -> Value {
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.now.clone().unwrap_or(Value::Array(Vec::new()))
    }

    /// Takes the intent an answer is for. One this gateway does not hold is passed on the first time only: the world
    /// hands on an ended connection's answers (a gateway restarted under a walk), and an answer that could come twice
    /// is remembered ([`RECENT`]).
    fn answered(&self, key: &[u8], sequence: u64, now: &Value) -> Answered {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.now = Some(now.clone());
        let id = (key.to_vec(), sequence);
        let Some(p) = s.index.remove(&id).and_then(|n| s.pending.remove(&n)) else {
            if s.recent.contains(&id) || s.answered.contains(&id) {
                return Answered::Again;
            }
            s.remember(id.0, id.1);
            return Answered::Unheld;
        };
        s.landed(&p.key, p.flying);
        if p.resent {
            s.remember(id.0.clone(), id.1);
        }
        if s.answered.len() == ANSWERED {
            s.answered.pop_front();
        }
        s.answered.push_back(id);
        Answered::Kept(p.received, p.handed)
    }

    /// The world said the intent is in progress, with `left` µs until its deadline (C20): it stays kept, now due
    /// `left` after `now` (the steady clock), answered [`TIMED_OUT`] then if the world has not. When it was received
    /// and handed on, if it is still kept.
    fn progress(&self, key: &[u8], sequence: u64, left: u64, now: u64) -> Option<(u64, u64)> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let n = *s.index.get(&(key.to_vec(), sequence))?;
        let p = s.pending.get_mut(&n)?;
        p.due = now.saturating_add(left);
        p.reason = TIMED_OUT;
        let (received, handed, key, was) = (p.received, p.handed, p.key.clone(), p.flying);
        p.flying = false;
        s.landed(&key, was);
        Some((received, handed))
    }

    /// Takes every kept intent past its deadline at `now` (the steady clock) while the world is away, or [`WEDGED`]
    /// past it while it is reachable: its actor's bytes, actor, sequence and the answer's name. None is sent again.
    pub fn overdue(&self, now: u64) -> Vec<(Vec<u8>, Actor, u64, &'static str)> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slack = if s.out.is_some() { WEDGED } else { 0 };
        let late: Vec<u64> = s
            .pending
            .iter()
            .filter(|(_, p)| now >= p.due.saturating_add(slack))
            .map(|(n, _)| *n)
            .collect();
        let mut out = Vec::new();
        for n in late {
            if let Some(p) = s.pending.remove(&n) {
                s.index.remove(&(p.key.clone(), p.sequence));
                if let Some(q) = s.waiting.get_mut(&p.key) {
                    q.retain(|w| *w != n);
                }
                s.landed(&p.key, p.flying);
                // The world's own answer may still come: it is not passed on a second time.
                s.remember(p.key.clone(), p.sequence);
                out.push((p.key, p.actor, p.sequence, p.reason));
            }
        }
        out
    }

    /// A sync answer from the world (key 20): the actor it is for, the asking socket's session and the frame under
    /// the client's number, or `Some(None)` for one answering a request not kept. `None` if the frame is not a sync
    /// answer.
    fn sync_answered(&self, frame: &[u8]) -> Option<Option<(Vec<u8>, u64, Vec<u8>)>> {
        let Value::Map(mut m) = decode(frame).ok()?.value else {
            return None;
        };
        let Some(Value::Uint(ours)) = m.get(&wire::ASK) else {
            return None;
        };
        let ours = *ours;
        let kept = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .syncs
            .remove(&ours);
        Some(kept.and_then(|(key, session, n)| {
            m.insert(wire::ASK, n);
            m.remove(&wire::ACTOR);
            Some((key, session, encode(&Value::Map(m)).ok()?))
        }))
    }

    /// Connected: the writer's queue, with every unanswered intent in it or waiting its agent's turn (S2), in
    /// first-sent order.
    fn connected(&self) -> mpsc::UnboundedReceiver<Vec<u8>> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.out = Some(tx);
        s.asked = false;
        s.flying.clear();
        s.waiting.clear();
        let kept: Vec<u64> = s.pending.keys().copied().collect();
        for n in &kept {
            if let Some(p) = s.pending.get_mut(n) {
                p.flying = false;
                p.resent = true;
            }
        }
        for n in kept {
            s.turn(n);
        }
        rx
    }

    /// The world went away: the sync requests it had not answered, to answer with [`RESTARTING`].
    fn disconnected(&self) -> Vec<(Vec<u8>, u64, Value)> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.out = None;
        // A world that went to sleep with intents still unanswered here (one arrived as it went): asked awake at
        // once, as a new intent would ask (O2, 0.133 S3b), so they are not left to their deadlines.
        if !s.pending.is_empty()
            && let Some(wake) = s.wake.clone()
            && !std::mem::replace(&mut s.asked, true)
        {
            wake();
        }
        std::mem::take(&mut s.syncs).into_values().collect()
    }
}

/// Holds the link to the world at `path` for as long as the gateway runs, reconnecting whenever it drops.
pub async fn run(gw: Arc<Gateway>, path: PathBuf) {
    tokio::spawn(deadlines(gw.clone()));
    let mut was_up = false;
    loop {
        let Ok(stream) = UnixStream::connect(&path).await else {
            if was_up {
                (gw.log)("the world is away; waiting for it");
                was_up = false;
            }
            tokio::time::sleep(RETRY).await;
            continue;
        };
        let resent = gw.link.unanswered();
        (gw.log)(&format!(
            "the world is reachable; {resent} unanswered intents sent again"
        ));
        was_up = true;
        let (read, mut write) = stream.into_split();
        let mut queue = gw.link.connected();
        // #3784: with a directory, ask the world for its Souls' wind-down words (now, and each change after).
        let ask = gw.mailbox.get().map(|_| crate::mailbox::states_ask());
        let writer = tokio::spawn(async move {
            for ask in std::iter::once(handover_ask()).chain(ask) {
                let len = u32::try_from(ask.len()).unwrap_or(u32::MAX).to_be_bytes();
                if write.write_all(&len).await.is_err() || write.write_all(&ask).await.is_err() {
                    return;
                }
            }
            while let Some(frame) = queue.recv().await {
                let len = u32::try_from(frame.len()).unwrap_or(u32::MAX).to_be_bytes();
                if write.write_all(&len).await.is_err() || write.write_all(&frame).await.is_err() {
                    break;
                }
            }
        });
        // A stopping gateway (O16) lets the world go first, between frames: what the world answers after that it
        // hands to the next gateway, instead of to sockets that are closing.
        let mut read = tokio::io::BufReader::new(read);
        let mut closing = gw.closing.subscribe();
        let mut stopping = false;
        loop {
            if read.buffer().is_empty() {
                tokio::select! {
                    _ = closing.wait_for(|c| *c) => {
                        stopping = true;
                        break;
                    }
                    more = read.fill_buf() => if more.map_or(true, |b| b.is_empty()) {
                        break;
                    },
                }
            }
            let mut len = [0u8; 4];
            if read.read_exact(&mut len).await.is_err() {
                break;
            }
            let len = u32::from_be_bytes(len) as usize;
            if len > FRAME_MOST {
                (gw.log)("a frame from the world was too long; reconnecting");
                break;
            }
            let mut frame = vec![0u8; len];
            if read.read_exact(&mut frame).await.is_err() {
                break;
            }
            let trace = delivery_trace(&frame);
            if let Some(t) = &trace {
                t.at("native-read", "complete");
            }
            // #3784: the Souls' wind-down words go on to the directory; they answer no intent.
            if crate::mailbox::on_states(&gw, &frame) {
                continue;
            }
            if let Some(answer) = gw.link.sync_answered(&frame) {
                if let Some((key, session, frame)) = answer {
                    gw.reply(&key, session, frame);
                }
                continue;
            }
            let at = times::stamp();
            if let Some((key, sequence, cursor, left)) = read_progress(&frame) {
                if let Some((received, handed)) = gw.link.progress(&key, sequence, left, at) {
                    let frame = times::read_from_world(frame, received, handed, at);
                    let a = crate::Answering {
                        sequence,
                        ends: false,
                    };
                    gw.deliver(key, a, cursor, frame);
                }
                continue;
            }
            match read_answer(&frame) {
                Some((key, sequence, version, cursor, outcome)) => {
                    let times = match gw.link.answered(&key, sequence, &version) {
                        Answered::Kept(received, handed) => Some((received, handed)),
                        Answered::Unheld => Some((at, at)),
                        Answered::Again => None,
                    };
                    if let Some((received, handed)) = times {
                        if let Some(t) = &trace {
                            t.at("pending-match", "matched");
                        }
                        gw.record(&key, outcome);
                        if let Some(t) = &trace {
                            t.at("receipt-record", "returned");
                        }
                        let frame = times::read_from_world(frame, received, handed, at);
                        let a = crate::Answering {
                            sequence,
                            ends: true,
                        };
                        gw.deliver(key, a, cursor, frame);
                        if let Some(t) = &trace {
                            t.at("deliver", "returned");
                        }
                    } else if let Some(t) = &trace {
                        t.at("pending-match", "unmatched");
                    }
                }
                None => (gw.log)("a frame from the world was not {1: version, 2: answer}"),
            }
        }
        for (key, session, n) in gw.link.disconnected() {
            gw.reply(&key, session, sync_refused(n, RESTARTING));
        }
        writer.abort();
        if stopping {
            return;
        }
    }
}

/// Answers each kept intent past its deadline ([`Link::overdue`]) by name, as the gateway's own answer, for as long
/// as the gateway runs (C8, #3396).
pub async fn deadlines(gw: Arc<Gateway>) {
    loop {
        tokio::time::sleep(SWEEP).await;
        for (key, actor, sequence, reason) in gw.link.overdue(times::stamp()) {
            let frame = crate::socket::refused(actor, sequence, reason, gw.link.now());
            gw.tell(&key, sequence, frame);
        }
    }
}

/// A sync request's refusal by name, under the client's number `n`.
pub fn sync_refused(n: Value, name: &str) -> Vec<u8> {
    let name = Name::new(name).unwrap_or_else(|| unreachable!("a fixed name"));
    encode(&Value::Map(
        [(wire::ASK, n), (wire::REFUSED, Value::Text(name))].into(),
    ))
    .unwrap_or_default()
}

/// A progress answer's actor (as bytes), sequence, cursor and µs left (C20): kind 3 with field 5.
fn read_progress(frame: &[u8]) -> Option<(Vec<u8>, u64, Cursor, u64)> {
    let Value::Map(m) = decode(frame).ok()?.value else {
        return None;
    };
    let Value::Map(answer) = m.get(&2)? else {
        return None;
    };
    let (Some(Value::Uint(3)), Some(Value::Uint(left)), Some(Value::Uint(sequence))) =
        (answer.get(&3), answer.get(&5), answer.get(&2))
    else {
        return None;
    };
    let cursor = Cursor::from_value(m.get(&1)?)?;
    Some((encode(answer.get(&1)?).ok()?, *sequence, cursor, *left))
}

/// An answer frame's actor (as bytes), sequence, version, cursor and outcome (a refusal is kind 2 or 5).
fn read_answer(frame: &[u8]) -> Option<(Vec<u8>, u64, Value, Cursor, Outcome)> {
    let Value::Map(m) = decode(frame).ok()?.value else {
        return None;
    };
    let version = m.get(&1)?.clone();
    let cursor = Cursor::from_value(&version)?;
    let Value::Map(answer) = m.get(&2)? else {
        return None;
    };
    let key = encode(answer.get(&1)?).ok()?;
    let Value::Uint(sequence) = answer.get(&2)? else {
        return None;
    };
    let outcome = match answer.get(&3) {
        Some(Value::Uint(2 | 5)) => Outcome::Refusal,
        _ => Outcome::Receipt,
    };
    Some((key, *sequence, version, cursor, outcome))
}

#[cfg(test)]
mod delivery_tests {
    use super::*;
    use replica::ids::{Id, Scope, Version};
    use replica::intents::Answer;

    fn frame(counter: u64, refused: bool) -> Vec<u8> {
        let scope = Scope([0x51; 16]);
        let actor = Actor::Soul(Id::new(scope, counter).unwrap());
        let version = Version {
            lineage: scope,
            zone: Id::new(scope, 0).unwrap(),
            epoch: 1,
            sequence: 7,
        }
        .to_value();
        let answer = if refused {
            Answer::Refused {
                actor,
                sequence: 1,
                reason: Name::new("intent.expired").unwrap(),
                now: version.clone(),
                changed: Vec::new(),
                op: None,
                detail: None,
            }
        } else {
            Answer::Receipt {
                actor,
                sequence: 1,
                intent: Id::new(scope, 9).unwrap(),
                entries: vec![6],
                names: BTreeMap::new(),
            }
        };
        encode(&Value::Map([(1, version), (2, answer.to_value())].into())).unwrap()
    }

    #[test]
    fn malformed_and_nonanswer_frames_have_no_delivery_metadata() {
        assert!(delivery_metadata(&[0xff]).is_none());
        let sync = sync_refused(Value::Uint(1), RESTARTING);
        assert!(delivery_metadata(&sync).is_none());
        let missing_actor = encode(&Value::Map(
            [(
                2,
                Value::Map([(2, Value::Uint(1)), (3, Value::Uint(1))].into()),
            )]
            .into(),
        ))
        .unwrap();
        assert!(delivery_metadata(&missing_actor).is_none());
    }

    #[test]
    fn synthetic_actor_hash_correlates_receipt_refusal_and_isolates_actors() {
        let receipt = delivery_metadata(&frame(100, false)).unwrap();
        let refusal = delivery_metadata(&frame(100, true)).unwrap();
        let other = delivery_metadata(&frame(101, false)).unwrap();
        assert_eq!(receipt.actor, refusal.actor);
        assert_ne!(receipt.actor, other.actor);
        assert_eq!(receipt.actor.len(), 64);
        assert_eq!((receipt.sequence, refusal.sequence), (1, 1));
        assert_eq!((receipt.kind, refusal.kind), (1, 2));
        assert_eq!((receipt.version, refusal.version), (Some(7), Some(7)));
    }
}
