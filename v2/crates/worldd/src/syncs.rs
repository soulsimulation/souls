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
use crate::closed::{Closed, Withhold, actor_of_key};
use crate::views::names::{self, PublicNames};
use replica::apply::Replica;
use replica::effects::Part;
use replica::effects::{Actor, Refusal};
use replica::encode::{Value, decode, encode};
use replica::ids::{Hash, Id, Scope, Version};
use replica::sync::{self, Records, Served, Source, wire};
use replica::tree::Tree;
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
    closed: Closed,
) -> std::io::Result<Sender<ToSync>> {
    let (tx, rx) = channel();
    thread::Builder::new().name("sync".into()).spawn(move || {
        let mut unsealed = false;
        let mut withhold = Withhold::new(closed);
        for r in rx {
            match r {
                ToSync::Parts(parts) => {
                    for p in parts {
                        match copy.apply(&p) {
                            Ok(()) => {
                                unsealed = true;
                                withhold.applied(copy.tree(), &p);
                            }
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
                    let asker = ask.remove(&wire::ACTOR).and_then(|k| actor_of_key(&k));
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
                    let mut src = Withheld {
                        served: Served {
                            tree: copy.tree(),
                            records: &kept,
                        },
                        withhold: &withhold,
                        asker,
                    };
                    let mut a = sync::answer(&mut src, &[place], &ask, now);
                    a.insert(wire::ASK, n);
                    names::attach(&mut a, &public_names);
                    if let Ok(frame) = encode(&Value::Map(a)) {
                        let _ = reply.send(frame);
                    }
                }
            }
        }
    })?;
    Ok(tx)
}

/// The world's records for one asker (#3915): a record under a closed container the asker may not see into is
/// answered with empty bytes, as a node not granted is in a hashes answer, so its copy never holds it.
struct Withheld<'a> {
    served: Served<'a>,
    withhold: &'a Withhold,
    asker: Option<Actor>,
}

impl Source for Withheld<'_> {
    fn hashes(&mut self, ids: &[Id]) -> Result<Vec<Option<Hash>>, Refusal> {
        let tree: &Tree = self.served.tree;
        let mut hs = self.served.hashes(ids)?;
        for (h, id) in hs.iter_mut().zip(ids) {
            if self.withhold.withheld(tree, self.asker, *id) {
                *h = None;
            }
        }
        Ok(hs)
    }

    fn records(&mut self, hashes: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, Refusal> {
        let tree: &Tree = self.served.tree;
        Ok(self
            .served
            .records(hashes)?
            .into_iter()
            .map(|r| {
                if self.withhold.withholds_record(tree, self.asker, &r) {
                    Vec::new()
                } else {
                    r
                }
            })
            .collect())
    }
}
