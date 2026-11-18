//! The interest set (Engine v2 R4, #2698): the bodies near a subscriber's own body, a fact of the world, the same
//! under any load. It is read from N16's spatial index (`sim::index`, #2679), held by the view tier as its own copy and
//! kept from the log's entries, never from the clock thread's live tree (step 0).
//!
//! - **Places.** [`Places`] follows the entries the tier reads: a body is entered when it is created (a node of a
//!   `souls:body` kind), moved by its motion samples and reparents, put where a leave sends it, and taken out when it
//!   is removed. Its node is the surface it stands on, else its frame.
//! - **Hysteresis.** A body enters the set closer than [`ENTER`] and leaves it only at [`LEAVE`] or farther, so a body
//!   standing at the edge does not flicker in and out. The subscriber's own body is in its set.
//! - **Counts by cell.** The other bodies of a node are summed by N16's cells ([`sim::index::Cell`]), once a world
//!   second for every node however many subscribers read them ([`Places::cells`]).
//!
//! Not here: what a level sends of the set, and the budget (`subscription.rs`); speech and its reach (B11, E13).

use std::collections::{BTreeMap, BTreeSet};

use replica::effects::{Body, Change, Effect, TransferRec};
use replica::ids::Id;
use replica::pose::{Pose, Support};
use sim::index::Index;

/// A body enters the set closer than this, µm (talking distance and a step).
pub const ENTER: i64 = 4_000_000;
/// A body in the set leaves it at this distance or farther, µm.
pub const LEAVE: i64 = 5_000_000;

/// The node a pose stands on, and where on it (x, z µm): the surface it stands on, else its frame.
pub fn place(p: &Pose) -> (Id, [i64; 2]) {
    let node = match p.support {
        Support::Surface { surface, .. } => surface,
        _ => p.frame.node,
    };
    (node, [p.position.x, p.position.z])
}

/// Where every body is, as the log says: N16's index, kept by the tier.
#[derive(Default)]
pub struct Places {
    index: Index,
    bodies: BTreeSet<Id>,
}

impl Places {
    pub fn new() -> Places {
        Places::default()
    }

    pub fn index(&self) -> &Index {
        &self.index
    }

    pub fn is_body(&self, id: Id) -> bool {
        self.bodies.contains(&id)
    }

    /// Where body `id` is: node and position.
    pub fn of(&self, id: Id) -> Option<(Id, [i64; 2])> {
        self.index.body(id)
    }

    fn put(&mut self, id: Id, p: &Pose) {
        let (node, at) = place(p);
        self.index.put_body(id, node, at);
    }

    /// Follows one entry of the log.
    pub fn apply(&mut self, e: &Effect) {
        match &e.body {
            Body::Changes(cs) => {
                for c in cs {
                    match &c.change {
                        Change::Create {
                            node, kind, pose, ..
                        } if kind.as_str().split('@').next() == Some("souls:body") => {
                            self.bodies.insert(*node);
                            self.put(*node, pose);
                        }
                        Change::Motion(h) if self.bodies.contains(&h.node) => {
                            self.put(h.node, &h.pose)
                        }
                        Change::Reparent { node, pose, .. } if self.bodies.contains(node) => {
                            self.put(*node, pose)
                        }
                        Change::Remove { node } if self.bodies.remove(node) => {
                            self.index.remove_body(*node);
                        }
                        _ => {}
                    }
                }
            }
            Body::Transfer(TransferRec::Leave { node, pose, .. }) if self.bodies.contains(node) => {
                self.put(*node, pose)
            }
            _ => {}
        }
    }

    /// Every node's bodies counted by cell, `(i, j, bodies)` in grid order: what a subscriber is sent of the bodies
    /// of its scope's nodes, once a world second, built once for all of them.
    pub fn cells(&self) -> BTreeMap<Id, Vec<(i64, i64, u32)>> {
        let mut by: BTreeMap<Id, BTreeMap<(i64, i64), u32>> = BTreeMap::new();
        for id in &self.bodies {
            if let Some((node, p)) = self.index.body(*id) {
                let c = self.index.cell_of(node, p);
                *by.entry(node).or_default().entry((c.i, c.j)).or_default() += 1;
            }
        }
        by.into_iter()
            .map(|(n, m)| (n, m.into_iter().map(|((i, j), c)| (i, j, c)).collect()))
            .collect()
    }
}

/// One subscriber's interest set: the bodies near its own body.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Interest {
    pub set: BTreeSet<Id>,
}

impl Interest {
    /// Brings the set up to date around body `me`: a body enters closer than [`ENTER`] and stays while closer than
    /// [`LEAVE`], on the node `me` stands on. Whether the set changed.
    pub fn update(&mut self, places: &Places, me: Id) -> bool {
        let Some((node, p)) = places.of(me) else {
            let changed = !self.set.is_empty();
            self.set.clear();
            return changed;
        };
        let set: BTreeSet<Id> = places
            .index()
            .bodies_within(node, p, LEAVE)
            .into_iter()
            .filter(|&(id, d)| d < ENTER || self.set.contains(&id))
            .map(|(id, _)| id)
            .collect();
        let changed = set != self.set;
        self.set = set;
        changed
    }
}
