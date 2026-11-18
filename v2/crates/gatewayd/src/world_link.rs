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

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use replica::encode::{Value, decode, encode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::Gateway;
use crate::resume::Cursor;

/// The answer to an intent sent while the world restarts.
pub const RESTARTING: &str = "world.restarting";

/// The longest frame read from the world.
const FRAME_MOST: usize = 1 << 20;

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

#[derive(Default)]
struct State {
    next: u64,
    /// Unanswered intents in the order they were first sent: (actor's bytes, sequence, the intent's bytes).
    pending: BTreeMap<u64, (Vec<u8>, u64, Vec<u8>)>,
    index: BTreeMap<(Vec<u8>, u64), u64>,
    out: Option<mpsc::UnboundedSender<Vec<u8>>>,
    /// The newest version the world sent: the "version now" of a refusal the gateway gives itself.
    now: Option<Value>,
}

impl Link {
    /// Hands an intent to the world, keeping it until it is answered.
    pub fn submit(&self, key: Vec<u8>, sequence: u64, bytes: Vec<u8>) -> Sent {
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
        s.pending.insert(n, (key, sequence, bytes));
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

    /// Takes the intent an answer is for; false if it was answered already.
    fn answered(&self, key: &[u8], sequence: u64, now: &Value) -> bool {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.now = Some(now.clone());
        match s.index.remove(&(key.to_vec(), sequence)) {
            Some(n) => s.pending.remove(&n).is_some(),
            None => false,
        }
    }

    /// Connected: the writer's queue, with every unanswered intent already in it, in first-sent order.
    fn connected(&self) -> mpsc::UnboundedReceiver<Vec<u8>> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        for (_, _, bytes) in s.pending.values() {
            let _ = tx.send(bytes.clone());
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
            match read_answer(&frame) {
                Some((key, sequence, version, cursor)) => {
                    if gw.link.answered(&key, sequence, &version) {
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
