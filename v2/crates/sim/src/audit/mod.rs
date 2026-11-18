//! The auditor (Engine v2 K11, #2674): a checker that sweeps a zone's tree in slices, a few nodes a tick, and names
//! every broken rule of the tree's structure it finds, by name and node. It reads through [`Source`] and holds no
//! way to write: it repairs nothing (N10 does) and never stops the clock (a slice returns what it found).
//!
//! The rules it checks, each fault named:
//!
//! - `parent-disagrees`: a node listed among a parent's children names another parent (T2 rule 1).
//! - `link-one-end`: a link in the index at one end is missing from the other end's index, or from the links
//!   (T2 rule 8: the index at each end carries every link).
//! - `slot-over-full`: two children sit in one slot of their parent (one occupant per slot).
//! - `hold-without-holder`: a node supported by its frame's slot (a held thing) that is in no slot.
//! - `timer-orphan`: a pending timer whose node is not in the zone (T6 rule 15: a timer belongs to its node).
//! - `support-missing`: a node standing on a surface, or floating in a volume, that is not in the zone.
//!
//! Not here: geometry (a body inside a wall), repair and walking out (N10), fault simulation (O5).

use replica::ids::Id;
use replica::pose::Support;
use replica::tree::{Handle, Tree};
use replica::world_model::show;
use std::collections::BTreeMap;

/// A broken rule, by name, at the node it was found on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fault {
    pub name: &'static str,
    pub node: Id,
    pub detail: String,
}

/// What the auditor reads of a node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seen {
    pub id: Id,
    pub parent: Option<Id>,
    pub slot: Option<u64>,
    /// What supports it; none for the zone's root.
    pub support: Option<Support>,
}

/// What the auditor reads, and all it can reach: shared reads, no writes. [`Tree`] is the one source in the world;
/// tests read the same tree through a source that answers one question wrongly (a seeded fault).
pub trait Source {
    fn root(&self) -> Handle;
    /// A live node's handle, by id.
    fn handle(&self, id: Id) -> Option<Handle>;
    fn node(&self, h: Handle) -> Option<Seen>;
    fn children(&self, h: Handle) -> Vec<Handle>;
    /// The index at an end, a node here or not: each link's id and its other end.
    fn links_at(&self, end: Id) -> Vec<(Id, Id)>;
    /// A link's two ends.
    fn link(&self, id: Id) -> Option<[Id; 2]>;
    /// Up to `max` pending timers after `after` in id order: each timer's id and its node.
    fn timers(&self, after: Option<Id>, max: usize) -> Vec<(Id, Id)>;
}

impl Source for Tree {
    fn root(&self) -> Handle {
        Tree::root(self)
    }
    fn handle(&self, id: Id) -> Option<Handle> {
        Tree::handle(self, id)
    }
    fn node(&self, h: Handle) -> Option<Seen> {
        Tree::node(self, h).map(|n| Seen {
            id: n.id(),
            parent: n.parent(),
            slot: n.slot(),
            support: n.place().map(|p| p.support),
        })
    }
    fn children(&self, h: Handle) -> Vec<Handle> {
        Tree::children(self, h).map_or_else(Vec::new, <[Handle]>::to_vec)
    }
    fn links_at(&self, end: Id) -> Vec<(Id, Id)> {
        Tree::links_at(self, end)
            .iter()
            .map(|e| (e.link, e.other))
            .collect()
    }
    fn link(&self, id: Id) -> Option<[Id; 2]> {
        Tree::link(self, id).map(|l| l.1)
    }
    fn timers(&self, after: Option<Id>, max: usize) -> Vec<(Id, Id)> {
        let all = Tree::timers(self);
        let it: Box<dyn Iterator<Item = _>> = match after {
            Some(a) => {
                Box::new(all.range((std::ops::Bound::Excluded(a), std::ops::Bound::Unbounded)))
            }
            None => Box::new(all.iter()),
        };
        it.take(max).map(|(t, s)| (*t, s.node)).collect()
    }
}

/// One slice's result: the faults found in it, and whether it ended a full pass (the next slice starts another).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Slice {
    pub faults: Vec<Fault>,
    pub checked: usize,
    pub pass_ended: bool,
}

/// The sweep: a walk of the tree from its root, carried from slice to slice, then the timers. A handle gone between
/// slices (its node removed) is skipped; a node added behind the walk is checked on the next pass.
#[derive(Clone, Debug, Default)]
pub struct Auditor {
    stack: Vec<Handle>,
    /// In the timers, after this one; `None` while walking the tree.
    timers_after: Option<Option<Id>>,
    started: bool,
    /// Full passes ended.
    pub passes: u64,
}

impl Auditor {
    pub fn new() -> Auditor {
        Auditor::default()
    }

    /// Checks up to `budget` nodes or timers, carrying on where the last slice stopped.
    pub fn slice(&mut self, src: &dyn Source, budget: usize) -> Slice {
        let mut out = Slice::default();
        if !self.started {
            self.stack.push(src.root());
            self.started = true;
        }
        while out.checked < budget {
            if let Some(after) = self.timers_after {
                let want = budget - out.checked;
                let batch = src.timers(after, want);
                out.checked += batch.len();
                for (timer, node) in &batch {
                    if src.handle(*node).is_none() {
                        out.faults.push(Fault {
                            name: "timer-orphan",
                            node: *node,
                            detail: format!(
                                "timer {} on {}, not in the zone",
                                show(*timer),
                                show(*node)
                            ),
                        });
                    }
                }
                if batch.len() < want {
                    // The timers are done: the pass ends, and the next slice starts the next pass.
                    self.timers_after = None;
                    self.started = false;
                    self.passes += 1;
                    out.pass_ended = true;
                    return out;
                }
                self.timers_after = Some(batch.last().map(|t| t.0));
                break;
            }
            let Some(h) = self.stack.pop() else {
                self.timers_after = Some(None);
                continue;
            };
            out.checked += 1;
            let Some(n) = src.node(h) else { continue };
            node(src, h, &n, &mut out.faults);
            let kids = src.children(h);
            // Pushed in reverse, so the walk takes children in id order.
            self.stack.extend(kids.iter().rev());
        }
        out
    }
}

/// The checks on one node: its children's parent and slots, its links' far ends, and its support.
fn node(src: &dyn Source, h: Handle, n: &Seen, faults: &mut Vec<Fault>) {
    let mut slots: BTreeMap<u64, Id> = BTreeMap::new();
    for c in src.children(h) {
        let Some(k) = src.node(c) else { continue };
        if k.parent != Some(n.id) {
            faults.push(Fault {
                name: "parent-disagrees",
                node: k.id,
                detail: format!(
                    "listed under {}, names {} as its parent",
                    show(n.id),
                    k.parent.map_or_else(|| "none".to_string(), show)
                ),
            });
        }
        if let Some(s) = k.slot
            && let Some(first) = slots.insert(s, k.id)
        {
            faults.push(Fault {
                name: "slot-over-full",
                node: n.id,
                detail: format!("slot {s} holds {} and {}", show(first), show(k.id)),
            });
        }
    }
    for (link, other) in src.links_at(n.id) {
        let ends = src.link(link);
        let here = ends.is_some_and(|e| e.contains(&n.id) && e.contains(&other));
        let there = src.links_at(other).iter().any(|(l, _)| *l == link);
        if !here || !there {
            faults.push(Fault {
                name: "link-one-end",
                node: n.id,
                detail: format!(
                    "link {} to {}: {}",
                    show(link),
                    show(other),
                    if here {
                        "not in the other end's index"
                    } else {
                        "not among the links"
                    }
                ),
            });
        }
    }
    match n.support {
        Some(Support::Slot) if n.slot.is_none() => faults.push(Fault {
            name: "hold-without-holder",
            node: n.id,
            detail: format!(
                "held in a slot of {}, in none",
                n.parent.map_or_else(|| "none".to_string(), show)
            ),
        }),
        Some(Support::Surface { surface: s, .. } | Support::Volume { volume: s })
            if src.handle(s).is_none() =>
        {
            faults.push(Fault {
                name: "support-missing",
                node: n.id,
                detail: format!("supported by {}, not in the zone", show(s)),
            });
        }
        _ => {}
    }
}
