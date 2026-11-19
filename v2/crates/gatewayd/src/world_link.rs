//! The gateway's one local socket to its world (Engine v2 I1, #2683). Frames both ways are a 4-byte big-endian length
//! and that many bytes. The gateway sends each intent as the agent sent it (T10 rule 2); the world answers
//! `{1: version, 2: answer}` (T10 rule 8, the version T3's).
//!
//! Every intent sent is kept until it is answered. When the socket drops, the gateway reconnects and sends what is
//! unanswered again, in the order it first sent it, so each actor's intents reach the world in sequence order; the
//! world drops repeats by (actor, sequence) (`worldd`'s `gateway_link`). An intent that arrives while the world is
//! away is answered at once with [`RESTARTING`] and never sent. An answer for an intent no longer kept (the world
//! answered a repeat) is dropped, so each intent is answered once. Keeping intents across a restart of the gateway
//! itself, and the world's repeats across its own restart, are I4's durable half.
//!
//! **Never silence** (C8, #3396). Each kept intent has a deadline: its expiry, or [`DEADLINE`] after it was received,
//! whichever is sooner (the world's own, `worldd::answers::Config::deadline`). Once it passes while the world is away,
//! the gateway answers the intent itself, `intent.expired` when the expiry came first and `act.timed-out` otherwise,
//! and drops it, so it is never sent again ([`deadlines`]). While the world is reachable it answers by its own
//! deadline; the gateway steps in only [`WEDGED`] after it, for a world that takes intents and never answers.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use replica::effects::Actor;
use replica::encode::{Value, decode, encode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::Gateway;
use crate::resume::Cursor;
use crate::times;

/// The answer to an intent sent while the world restarts.
pub const RESTARTING: &str = "world.restarting";

/// The longest frame read from the world.
const FRAME_MOST: usize = 1 << 20;

/// How long the gateway waits between attempts to reach the world.
const RETRY: Duration = Duration::from_millis(20);

/// The longest an act stays open after it is received, µs: the world's deadline (`worldd::answers::Config`).
pub const DEADLINE: u64 = 10_000_000;
/// How long past an intent's deadline a reachable world has to answer it before the gateway does, µs.
pub const WEDGED: u64 = 20_000_000;
/// How often the gateway looks for intents past their deadline.
const SWEEP: Duration = Duration::from_millis(50);
/// The gateway's answer to an intent whose expiry passed unanswered.
pub const EXPIRED: &str = "intent.expired";
/// The gateway's answer to an intent whose deadline passed unanswered before its expiry.
pub const TIMED_OUT: &str = "act.timed-out";

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
        let Some(out) = s.out.clone() else {
            return Sent::Restarting;
        };
        if s.index.contains_key(&(key.clone(), sequence)) {
            // Sent again while still unanswered: it is answered once.
            return Sent::Sent;
        }
        let n = s.next;
        s.next += 1;
        s.index.insert((key.clone(), sequence), n);
        // A send to a writer that has just ended is not lost: the intent stays kept and goes again on reconnect.
        let _ = out.send(bytes.clone());
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
            },
        );
        Sent::Sent
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

    /// Takes the intent an answer is for, with when it was received and handed on; none if it was answered already.
    fn answered(&self, key: &[u8], sequence: u64, now: &Value) -> Option<(u64, u64)> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.now = Some(now.clone());
        let n = s.index.remove(&(key.to_vec(), sequence))?;
        s.pending.remove(&n).map(|p| (p.received, p.handed))
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
                out.push((p.key, p.actor, p.sequence, p.reason));
            }
        }
        out
    }

    /// Connected: the writer's queue, with every unanswered intent already in it, in first-sent order.
    fn connected(&self) -> mpsc::UnboundedReceiver<Vec<u8>> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        for p in s.pending.values() {
            let _ = tx.send(p.bytes.clone());
        }
        s.out = Some(tx);
        rx
    }

    fn disconnected(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).out = None;
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
        let (mut read, mut write) = stream.into_split();
        let mut queue = gw.link.connected();
        let writer = tokio::spawn(async move {
            while let Some(frame) = queue.recv().await {
                let len = u32::try_from(frame.len()).unwrap_or(u32::MAX).to_be_bytes();
                if write.write_all(&len).await.is_err() || write.write_all(&frame).await.is_err() {
                    break;
                }
            }
        });
        loop {
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
            let at = times::stamp();
            match read_answer(&frame) {
                Some((key, sequence, version, cursor)) => {
                    if let Some((received, handed)) = gw.link.answered(&key, sequence, &version) {
                        let frame = times::read_from_world(frame, received, handed, at);
                        gw.deliver(key, cursor, frame);
                    }
                }
                None => (gw.log)("a frame from the world was not {1: version, 2: answer}"),
            }
        }
        gw.link.disconnected();
        writer.abort();
    }
}

/// Answers each kept intent past its deadline ([`Link::overdue`]) by name, as the gateway's own answer, for as long
/// as the gateway runs (C8, #3396).
pub async fn deadlines(gw: Arc<Gateway>) {
    loop {
        tokio::time::sleep(SWEEP).await;
        for (key, actor, sequence, reason) in gw.link.overdue(times::stamp()) {
            let frame = crate::socket::refused(actor, sequence, reason, gw.link.now());
            gw.tell(&key, frame);
        }
    }
}

/// An answer frame's actor (as bytes), sequence, version and cursor.
fn read_answer(frame: &[u8]) -> Option<(Vec<u8>, u64, Value, Cursor)> {
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
    Some((key, *sequence, version, cursor))
}
