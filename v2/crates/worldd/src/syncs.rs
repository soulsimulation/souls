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
#[cfg(test)]
use crate::closed::MADE_MOST;
use crate::closed::{Closed, Redaction, Withhold, actor_of_key};
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
    text: Arc<sim::text::Store>,
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
                    let version = copy.version();
                    let tree = copy.tree();
                    // Made when the copy was just sealed (a hashes request), and kept for the records asked after it.
                    if ask.contains_key(&wire::IDS) {
                        let served = Served {
                            tree,
                            records: &kept,
                        };
                        let mut read = |h: &[u8]| {
                            let mut s = Served {
                                tree: served.tree,
                                records: served.records,
                            };
                            s.records(&[h.to_vec()]).ok().and_then(|mut v| v.pop())
                        };
                        withhold.prepare(tree, version, asker, &mut read);
                    }
                    let mut src = Withheld {
                        served: Served {
                            tree,
                            records: &kept,
                        },
                        withhold: &withhold,
                        redaction: withhold.redaction(asker),
                        asker,
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

/// The world's records for one asker (#3915): a record under a closed container the asker may not see into is
/// answered with empty bytes, as a node not granted is in a hashes answer, so its copy never holds it.
struct Withheld<'a> {
    served: Served<'a>,
    withhold: &'a Withhold,
    redaction: Option<&'a Redaction>,
    asker: Option<Actor>,
}

impl Source for Withheld<'_> {
    fn hashes(&mut self, ids: &[Id]) -> Result<Vec<Option<Hash>>, Refusal> {
        let tree: &Tree = self.served.tree;
        let mut hs = self.served.hashes(ids)?;
        for (h, id) in hs.iter_mut().zip(ids) {
            if self.withhold.withheld(tree, self.asker, *id) {
                *h = None;
            } else if let Some(r) = self.redaction.and_then(|r| r.hash(*id)) {
                *h = Some(r);
            }
        }
        Ok(hs)
    }

    fn records(&mut self, hashes: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, Refusal> {
        let tree: &Tree = self.served.tree;
        hashes
            .iter()
            .map(|h| {
                // A record rewritten for an asker is served from those made; the real one it replaces never is.
                if let Some(b) = self.withhold.made(self.asker, h) {
                    return Ok(b.clone());
                }
                if self.redaction.is_some_and(|r| r.replaced(h)) {
                    return Ok(Vec::new());
                }
                let r = self
                    .served
                    .records(std::slice::from_ref(h))?
                    .pop()
                    .unwrap_or_default();
                Ok(if self.withhold.withholds_record(tree, self.asker, &r) {
                    Vec::new()
                } else {
                    r
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::rules::json::parse;
    use replica::world_model::plain;

    /// A test world whose building is a closed kind (creator only), sealed, and the records its seal gave.
    fn world() -> (Tree, Records, Withhold, Id) {
        let generated = testworld::generate(1, 0).expect("the synthetic world");
        let mut im = import_eden::load(&generated.text).expect("the imported world");
        let building = im.nodes["building"];
        let kind = plain(
            im.tree
                .node(im.tree.handle(building).unwrap())
                .unwrap()
                .kind()
                .as_str(),
        )
        .to_owned();
        let sealed = im.tree.seal().expect("sealed");
        let mut kept = Records::default();
        kept.keep(&sealed);
        let entry =
            parse(r#"{"closed": {"audience": {"rule": "creator"}, "fields": []}}"#).unwrap();
        (
            im.tree,
            kept,
            Withhold::new(Closed::of(&[(kind, entry)])),
            building,
        )
    }

    fn sync_as(tree: &Tree, kept: &Records, w: &mut Withhold, asker: Option<Actor>) -> sync::Copy {
        {
            let served = Served {
                tree,
                records: kept,
            };
            let mut read = |h: &[u8]| {
                Served {
                    tree: served.tree,
                    records: served.records,
                }
                .records(&[h.to_vec()])
                .ok()
                .and_then(|mut v| v.pop())
            };
            w.prepare(tree, 1, asker, &mut read);
        }
        let mut src = Withheld {
            served: Served {
                tree,
                records: kept,
            },
            withhold: w,
            redaction: w.redaction(asker),
            asker,
        };
        let root = tree.node(tree.root()).unwrap().id();
        let mut copy = sync::Copy::default();
        copy.sync(&[root], &mut src).expect("the sync finishes");
        copy
    }

    #[test]
    /// #3915: a Soul outside a closed container's audience syncs a copy that holds neither the container's children
    /// nor their hashes (the container's record and its ancestors' are rewritten for it, and check); the creator's
    /// copy holds them. A store of past records filled past its bound never fails the Soul's current sync.
    fn a_souls_redacted_sync_holds_after_the_past_store_is_filled() {
        let (tree, kept, mut w, building) = world();
        let kids: Vec<Vec<u8>> = tree
            .children(tree.handle(building).unwrap())
            .unwrap()
            .iter()
            .filter_map(|&h| tree.node(h)?.sealed())
            .map(|h| h.to_bytes())
            .collect();
        assert!(!kids.is_empty(), "the building holds floors");
        let real = tree
            .node(tree.handle(building).unwrap())
            .unwrap()
            .sealed()
            .unwrap()
            .to_bytes();
        let soul = Some(Actor::Soul(Id::new(Scope([9; 16]), 1).unwrap()));
        let copy = sync_as(&tree, &kept, &mut w, soul);
        for k in &kids {
            assert!(
                copy.record(k).is_none(),
                "a withheld child is not in the Soul's copy"
            );
        }
        assert!(
            copy.record(&real).is_none(),
            "nor the building's real record, which names them"
        );
        // The store of past records, filled past its bound: the Soul's current redaction is untouched.
        w.fill_past(MADE_MOST + 10);
        let again = sync_as(&tree, &kept, &mut w, soul);
        assert_eq!(again.roots(), copy.roots(), "the same redacted copy");
        let creator = Some(Actor::Creator(Id::new(Scope([9; 16]), 2).unwrap()));
        let full = sync_as(&tree, &kept, &mut w, creator);
        for k in &kids {
            assert!(
                full.record(k).is_some(),
                "the creator's copy holds the building's children"
            );
        }
    }
}
