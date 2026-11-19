//! View subscriptions over the gateway (#3292, the prerequisite of V13 #2745). A signed-in socket sends a subscribe
//! frame and receives R4's items for its scope (`worldd::views::subscription`), from the world's view tier on a local
//! socket of its own (`worldd::views::served`), apart from the intents' link.
//!
//! - client → gateway: `{30: {1: [scope, ...], 2: level number, 3: budget}}`, a scope `{1: node}` held for good or
//!   `{2: body}` followed (R4 rule 1). A later subscribe on the same socket replaces it.
//! - gateway → client: `{31: item}`, one of R4's items as its bytes (a grant the server lowered is R4's grant item,
//!   `{1: 5, 2: {1: level, 2: level asked, 3: "souls:over-budget"}}`), or `{32: name}` when the world refused the
//!   request.
//!
//! Items go to the socket that subscribed alone: they are not kept for a resume and never written to a file. The
//! world sends the public entries and those of the audiences the gateway resolves for the socket's grant: today its
//! actor's own principal id (T8 rule 1); the audience nodes it is a member of are the directory's to resolve. A socket
//! whose item queue is full is let go, as a slow stream is. A subscription outlives a restart of the world: it is
//! sent again on reconnect, and the new hub opens with its grant.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use replica::effects::Actor;
use replica::encode::{Value, decode, encode};
use replica::ids::Id;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::Gateway;
use crate::token::Grant;

/// A client's subscribe frame's key.
pub const SUBSCRIBE: u64 = 30;
/// An item's key, gateway → client.
pub const ITEM: u64 = 31;
/// A refused subscription's key, gateway → client.
pub const REFUSED: u64 = 32;

const FRAME_MOST: usize = 1 << 20;
const RETRY: Duration = Duration::from_millis(20);

/// The audience ids a grant is in, besides everyone: its actor's own principal id.
pub fn audiences(grant: Grant) -> Vec<Id> {
    let Grant::Actor(a) = grant;
    match a {
        Actor::Soul(id) | Actor::Creator(id) => vec![id],
        Actor::World => Vec::new(),
    }
}

/// A client's subscribe request, if the frame is one.
pub fn request(bytes: &[u8]) -> Option<Value> {
    match decode(bytes).ok()?.value {
        Value::Map(mut m) => m.remove(&SUBSCRIBE),
        _ => None,
    }
}

/// The subscriptions held for sockets, and the link that carries them to the world.
#[derive(Default)]
pub struct Views {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    next: u64,
    /// By number: its subscribe frame to the world, and its socket's item queue.
    subs: BTreeMap<u64, (Vec<u8>, mpsc::Sender<Vec<u8>>)>,
    out: Option<mpsc::UnboundedSender<Vec<u8>>>,
}

impl Views {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Subscribes for a socket: its number, and the queue its items arrive on. Kept and sent again whenever the world
    /// is reached; the queue closes when the socket is to be let go.
    pub fn subscribe(&self, request: Value, audiences: &[Id]) -> (u64, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel(crate::OUTBOUND);
        let mut s = self.state();
        s.next += 1;
        let n = s.next;
        let frame = encode(&Value::Map(
            [
                (1, Value::Uint(n)),
                (2, request),
                (
                    3,
                    Value::Array(audiences.iter().map(|a| a.to_value()).collect()),
                ),
            ]
            .into(),
        ))
        .unwrap_or_default();
        if let Some(out) = &s.out {
            let _ = out.send(frame.clone());
        }
        s.subs.insert(n, (frame, tx));
        (n, rx)
    }

    /// Ends a subscription.
    pub fn end(&self, n: u64) {
        let mut s = self.state();
        if s.subs.remove(&n).is_some()
            && let Some(out) = &s.out
        {
            let _ = out.send(encode(&Value::Map([(1, Value::Uint(n))].into())).unwrap_or_default());
        }
    }

    /// Subscriptions held now.
    pub fn held(&self) -> usize {
        self.state().subs.len()
    }

    fn connected(&self) -> mpsc::UnboundedReceiver<Vec<u8>> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut s = self.state();
        for (frame, _) in s.subs.values() {
            let _ = tx.send(frame.clone());
        }
        s.out = Some(tx);
        rx
    }

    fn disconnected(&self) {
        self.state().out = None;
    }

    /// A frame from the world, `{1: n, 2: item}` or `{1: n, 3: name}`, to its socket alone. False when that socket's
    /// queue is full: it is let go.
    fn route(&self, frame: &[u8]) -> bool {
        let Ok(Value::Map(mut m)) = decode(frame).map(|d| d.value) else {
            return true;
        };
        let Some(Value::Uint(n)) = m.remove(&1) else {
            return true;
        };
        let to_client = match (m.remove(&2), m.remove(&3)) {
            (Some(item), _) => (ITEM, item),
            (None, Some(name)) => (REFUSED, name),
            _ => return true,
        };
        let bytes = encode(&Value::Map([to_client].into())).unwrap_or_default();
        let mut s = self.state();
        let Some((_, tx)) = s.subs.get(&n) else {
            return true;
        };
        match tx.try_send(bytes) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Closed(_)) => {
                s.subs.remove(&n);
                true
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                // Dropping its queue's sender ends the socket's task.
                s.subs.remove(&n);
                false
            }
        }
    }
}

/// Holds the views link to the world at `path` for as long as the gateway runs, reconnecting whenever it drops.
pub async fn run(gw: Arc<Gateway>, path: PathBuf) {
    loop {
        let Ok(stream) = UnixStream::connect(&path).await else {
            tokio::time::sleep(RETRY).await;
            continue;
        };
        let (mut read, mut write) = stream.into_split();
        let mut queue = gw.views.connected();
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
                (gw.log)("a views frame from the world was too long; reconnecting");
                break;
            }
            let mut frame = vec![0u8; len];
            if read.read_exact(&mut frame).await.is_err() {
                break;
            }
            if !gw.views.route(&frame) {
                (gw.log)("a socket's view queue was full; it was let go");
            }
        }
        gw.views.disconnected();
        writer.abort();
    }
}
