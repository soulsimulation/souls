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
//! A sync request (R5b, #3164; `replica::sync::wire`) goes to the world under the gateway's own number, with the
//! asking actor; its answer goes back to that actor's socket under the client's number. One asked while the world is
//! away, or not yet answered when the link drops, is answered at once with [`RESTARTING`]: the client asks again.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use replica::encode::{Name, Value, decode, encode};
use replica::sync::wire;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::Gateway;
use crate::receipts::Outcome;
use crate::resume::Cursor;
use crate::times;

/// The answer to an intent sent while the world restarts.
pub const RESTARTING: &str = "world.restarting";

/// The longest frame read from the world. A sync answer carries whole records, and one record can be large: Eden's open
/// ground holds every terrain tile's heights and classes, 5.4 MB, and a room's record lists each child's hash (36 bytes
/// each). At 1 MiB neither could be sent, and the link was dropped at every try (#3424).
pub const FRAME_MOST: usize = 16 << 20;

/// How long the gateway waits between attempts to reach the world.
const RETRY: Duration = Duration::from_millis(20);

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

type Pending = (Vec<u8>, u64, Vec<u8>, u64, u64);

#[derive(Default)]
struct State {
    next: u64,
    /// Unanswered intents in the order they were first sent: (actor's bytes, sequence, the intent's bytes, when it
    /// was received and handed to the link: O4's gateway in).
    pending: BTreeMap<u64, Pending>,
    index: HashMap<(Vec<u8>, u64), u64>,
    out: Option<mpsc::UnboundedSender<Vec<u8>>>,
    /// The newest version the world sent: the "version now" of a refusal the gateway gives itself.
    now: Option<Value>,
    /// Sync requests sent and not yet answered, by the gateway's number: the actor's bytes and the client's number.
    syncs: HashMap<u64, (Vec<u8>, Value)>,
}

impl Link {
    /// Hands an intent to the world, keeping it until it is answered; `received` is when its socket read it.
    pub fn submit(&self, key: Vec<u8>, sequence: u64, bytes: Vec<u8>, received: u64) -> Sent {
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
        s.pending
            .insert(n, (key, sequence, bytes, received, times::stamp()));
        Sent::Sent
    }

    /// Hands a sync request to the world: `ask` is the client's request, with its number `n` taken out.
    pub fn ask(&self, key: Vec<u8>, n: Value, mut ask: BTreeMap<u64, Value>) -> Sent {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(out) = s.out.clone() else {
            return Sent::Restarting;
        };
        let ours = s.next;
        s.next += 1;
        ask.insert(wire::ASK, Value::Uint(ours));
        ask.insert(wire::ACTOR, Value::Bytes(key.clone()));
        let Ok(bytes) = encode(&Value::Map(ask)) else {
            return Sent::Restarting;
        };
        s.syncs.insert(ours, (key, n));
        let _ = out.send(bytes);
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
        s.pending.remove(&n).map(|p| (p.3, p.4))
    }

    /// A sync answer from the world (key 20): the actor it is for and the frame under the client's number, or
    /// `Some(None)` for one answering a request not kept. `None` if the frame is not a sync answer.
    fn sync_answered(&self, frame: &[u8]) -> Option<Option<(Vec<u8>, Vec<u8>)>> {
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
        Some(kept.and_then(|(key, n)| {
            m.insert(wire::ASK, n);
            m.remove(&wire::ACTOR);
            Some((key, encode(&Value::Map(m)).ok()?))
        }))
    }

    /// Connected: the writer's queue, with every unanswered intent already in it, in first-sent order.
    fn connected(&self) -> mpsc::UnboundedReceiver<Vec<u8>> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        for (_, _, bytes, _, _) in s.pending.values() {
            let _ = tx.send(bytes.clone());
        }
        s.out = Some(tx);
        rx
    }

    /// The world went away: the sync requests it had not answered, to answer with [`RESTARTING`].
    fn disconnected(&self) -> Vec<(Vec<u8>, Value)> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.out = None;
        s.syncs.drain().map(|(_, v)| v).collect()
    }
}

/// Holds the link to the world at `path` for as long as the gateway runs, reconnecting whenever it drops.
pub async fn run(gw: Arc<Gateway>, path: PathBuf) {
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
            if let Some(answer) = gw.link.sync_answered(&frame) {
                if let Some((key, frame)) = answer {
                    gw.reply(&key, frame);
                }
                continue;
            }
            let at = times::stamp();
            match read_answer(&frame) {
                Some((key, sequence, version, cursor, outcome)) => {
                    if let Some((received, handed)) = gw.link.answered(&key, sequence, &version) {
                        gw.record(&key, outcome);
                        let frame = times::read_from_world(frame, received, handed, at);
                        gw.deliver(key, cursor, frame);
                    }
                }
                None => (gw.log)("a frame from the world was not {1: version, 2: answer}"),
            }
        }
        for (key, n) in gw.link.disconnected() {
            gw.reply(&key, sync_refused(n, RESTARTING));
        }
        writer.abort();
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
