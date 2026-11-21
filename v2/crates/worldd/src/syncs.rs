//! Sync answers off the clock thread (Engine v2 C16, #3450). R5b's sync requests (`replica::sync::wire`) are answered
//! by a reader thread of their own, `sync`, never by the clock thread: an agent syncing a world of 30,000 records
//! once held the clock past K7's watchdog (`tick-stalled`).
//!
//! - **Its copy is kept the way K8's frozen copies are** (`sim::frozen`): a whole copy of the zone taken at start,
//!   before the clock runs, then each tick's parts handed over (a send, nothing copied) and applied on this thread.
//!   K8's published copies are shared and never sealed, so they cannot answer by hash; this copy is sealed here, on a
//!   hash request after a change (only what changed is hashed), and every record a seal gave is kept.
//! - **It holds only what is on the disk:** the answers thread hands over a tick's parts once the tick's records are
//!   durable, so an answer never shows a change before it is on the disk and goes to the asker at once.
//! - **It is never behind an answer the asker holds:** the parts are handed over before the tick's answers are sent,
//!   so a sync asked after a receipt sees the receipt's change.
//!
//! Requests reach it from the [`crate::answers::Door`] directly, so they never wait in the clock thread's queue.

use crate::answers::Reply;
use crate::views::names::{self, PublicNames};
use replica::apply::Replica;
use replica::effects::Part;
use replica::encode::{Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::sync::{self, Records, Served, wire};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::thread;

/// What the sync thread is handed.
pub(crate) enum ToSync {
    /// A durable tick's parts, in order.
    Parts(Vec<Arc<Part>>),
    /// A sync request (its map, the request's number included) and where its answer goes.
    Ask(BTreeMap<u64, Value>, Reply),
}

/// The map of a sync request (a frame with key [`wire::ASK`]), or none for any other frame (an intent).
pub(crate) fn ask_of(bytes: &[u8]) -> Option<BTreeMap<u64, Value>> {
    match decode(bytes).ok()?.value {
        Value::Map(m) if m.contains_key(&wire::ASK) => Some(m),
        _ => None,
    }
}

/// Starts the sync thread on `copy`, sealed, and the records its seal gave; answers carry the version `(lineage,
/// zone, epoch)` at the copy's sequence. It ends once every sender is dropped.
pub(crate) fn start(
    mut copy: Replica,
    mut kept: Records,
    (lineage, zone, epoch): (Scope, Id, u64),
    public_names: Arc<PublicNames>,
    text: Arc<sim::text::Store>,
) -> std::io::Result<Sender<ToSync>> {
    let (tx, rx) = channel();
    thread::Builder::new().name("sync".into()).spawn(move || {
        let mut unsealed = false;
        for r in rx {
            match r {
                ToSync::Parts(parts) => {
                    for p in parts {
                        match copy.apply(&p) {
                            Ok(()) => unsealed = true,
                            Err(e) => eprintln!("worldd: the sync copy refused a part: {e}"),
                        }
                    }
                }
                ToSync::Ask(mut ask, reply) => {
                    // Never the clock thread: a debug build panics there, a release build counts it.
                    sim::commit::off_clock();
                    let Some(n) = ask.remove(&wire::ASK) else {
                        continue;
                    };
                    if unsealed && ask.contains_key(&wire::IDS) {
                        match copy.seal() {
                            Ok(sealed) => {
                                kept.keep(&sealed);
                                unsealed = false;
                            }
                            Err(e) => eprintln!("worldd: the sync copy was not sealed: {e}"),
                        }
                    }
                    let now = Version {
                        lineage,
                        zone,
                        epoch,
                        sequence: copy.version(),
                    }
                    .to_value();
                    let place = copy.header().zone;
                    let mut src = Served {
                        tree: copy.tree(),
                        records: &kept,
                    };
                    let mut a = sync::answer(&mut src, &[place], &ask, now);
                    a.insert(wire::ASK, n);
                    names::attach(&mut a, &public_names);
                    // #3703: the public words of the text references these records hold.
                    names::attach_words(&mut a, &|r| text.read(r, &[]).ok());
                    if let Ok(frame) = encode(&Value::Map(a)) {
                        let _ = reply.send(frame);
                    }
                }
            }
        }
    })?;
    Ok(tx)
}
