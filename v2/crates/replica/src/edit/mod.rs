//! A creator's edit (Engine v2 G1, #2746): the intent and its checks. An edit is a batch of place, move, set and
//! remove operations and the version it was planned against. It is checked here, off the clock thread, on a frozen
//! copy ([`check`]), and committed on one tick by `sim::edit` as generic effects (T6) under one cause, with the
//! creator as actor, through the same write as every act (`sim::commit::write`), or refused whole.
//!
//! - **Who:** the world's one creator, and nobody else (`edit.not-the-creator`).
//! - **Size:** at most [`OPS_MOST`] operations (`edit.too-many-operations`) and [`NODES_MOST`] changed nodes, a removed
//!   subtree counted whole (`edit.too-many-nodes`).
//! - **Structure:** a placed kind is known by its full `namespace:name@hash` (`edit.kind-unknown`), and the parent's
//!   kind admits it in the slot named (`edit.child-not-admitted`), as T2 rule 5 says; so does a move's new slot.
//! - **Planned against a version:** each node the batch moves, sets or removes (a removed node's subtree with it) must
//!   be unchanged since that version (its stamp no later), else `edit.stale`. Other nodes changing does not matter, so
//!   a busy world does not refuse every edit. A place's parent need only still be there.
//! - **Ids:** a placed node has a temporary name in the batch; the engine mints its id at commit, and the receipt maps
//!   each name to its id.
//!
//! A refusal names the failing operation by its place in the batch. Not here: overlap and support, the ground.
//! The safety rule (G2, #2761) is judged in `sim::edit::safety`; its failures' names and texts are here ([`Unsafe`]),
//! so a client reads the same names the world refuses by.
//!
//! - **Undo and redo** (G4, #2795) are batches like any other, committed by `sim::edit::undo`. Each names the batch it
//!   reverses by its cause, `Cause::Effect(first)`, where `first` is the sequence of that batch's first effect, with a
//!   creator acting ([`reverses`]).

pub mod wire;

use crate::apply::Replica;
use crate::effects::{Actor, Cause, Effect};
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::pose::{Frame, Pose, Quat, Support, Vec3};
use crate::read::Read;
use crate::world_model::{Audience, Kind, plain, show, takes};
use std::collections::{BTreeMap, BTreeSet};

/// The most operations a batch may carry.
pub const OPS_MOST: usize = 256;
/// The most nodes a batch may change.
pub const NODES_MOST: usize = 4096;

/// A node an operation names: one in the zone, or one placed earlier in the same batch, by its temporary name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Ref {
    Node(Id),
    New(u64),
}

/// Where a node goes in its parent's frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spot {
    pub slot: Option<u64>,
    pub position: Vec3,
    pub orientation: Quat,
    pub support: Support,
}

impl Spot {
    pub fn pose(&self, parent: Id) -> Pose {
        Pose {
            frame: Frame {
                node: parent,
                slot: self.slot,
            },
            position: self.position,
            orientation: self.orientation,
            support: self.support,
        }
    }
}

/// One operation of a batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    /// A new node, named `name` until the engine mints its id.
    Place {
        name: u64,
        kind: Name,
        parent: Ref,
        at: Spot,
        audience: Audience,
        fields: BTreeMap<u64, Value>,
    },
    /// A node to another spot in the same parent (a new parent is a crossing, T1).
    Move {
        node: Ref,
        at: Spot,
    },
    Set {
        node: Ref,
        field: u64,
        to: Value,
    },
    /// A node and its subtree.
    Remove {
        node: Ref,
    },
}

/// An edit intent: who sends it, its id (the cause of every effect it commits), the version of the zone it was planned
/// against, and its operations in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub intent: Id,
    pub actor: Actor,
    pub planned: u64,
    pub ops: Vec<Op>,
}

/// What an edit is checked against: the world's one creator, and the kinds it pins by full name.
#[derive(Clone, Debug)]
pub struct World {
    pub creator: Id,
    pub kinds: BTreeMap<String, Kind>,
}

/// A refused edit: the operation that failed, by its place in the batch (none for one about the whole batch), the
/// refusal's name and what it found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    pub op: Option<usize>,
    pub name: &'static str,
    pub detail: String,
}

fn refuse<T>(
    op: Option<usize>,
    name: &'static str,
    detail: impl Into<String>,
) -> Result<T, Refused> {
    Err(Refused {
        op,
        name,
        detail: detail.into(),
    })
}

/// An edit that passed its checks on a copy, with what the clock thread confirms at commit: for each operation, the
/// nodes whose stamps must be no later than the planned version, and the place parents that must still be there.
#[derive(Clone, Debug)]
pub struct Checked {
    pub edit: Edit,
    pub reads: Vec<(usize, Id)>,
    pub parents: Vec<(usize, Id)>,
}

/// A placed node as the check tracks it through the batch.
struct New {
    kind: String,
    parent: Ref,
}

/// Checks `edit` on `copy` (see the module's notes). Runs off the clock thread.
pub fn check(edit: Edit, copy: &Replica, world: &World) -> Result<Checked, Refused> {
    if edit.actor != Actor::Creator(world.creator) {
        return refuse(
            None,
            "edit.not-the-creator",
            "only the world's creator edits it",
        );
    }
    if edit.ops.len() > OPS_MOST {
        return refuse(
            None,
            "edit.too-many-operations",
            format!("{} operations, over {OPS_MOST}", edit.ops.len()),
        );
    }
    let tree = copy.tree();
    let mut new: BTreeMap<u64, New> = BTreeMap::new();
    let mut gone: BTreeSet<Ref> = BTreeSet::new();
    let mut changed: BTreeSet<Ref> = BTreeSet::new();
    let mut reads = Vec::new();
    let mut parents = Vec::new();
    for (i, op) in edit.ops.iter().enumerate() {
        let here = Some(i);
        // The kind of a node the batch names, and its parent, as the batch has left it so far.
        let named = |r: Ref| -> Result<(String, Option<Ref>), Refused> {
            if gone.contains(&r) {
                return refuse(
                    here,
                    "edit.node-missing",
                    format!("{r:?} is removed earlier in the batch"),
                );
            }
            match r {
                Ref::New(n) => new
                    .get(&n)
                    .map(|x| (x.kind.clone(), Some(x.parent)))
                    .map_or_else(
                        || refuse(here, "edit.name-unknown", format!("no place names {n}")),
                        Ok,
                    ),
                Ref::Node(id) => {
                    let h = tree.handle(id);
                    match h.and_then(|h| tree.node(h)) {
                        Some(n) => Ok((n.kind().as_str().to_owned(), n.parent().map(Ref::Node))),
                        None => refuse(here, "edit.node-missing", format!("{id:?} is not here")),
                    }
                }
            }
        };
        let admits = |parent: &str, child: &str, slot: Option<u64>| -> Result<(), Refused> {
            let (Some(pk), Some(ck)) = (world.kinds.get(parent), world.kinds.get(child)) else {
                return refuse(here, "edit.kind-unknown", format!("{parent} or {child}"));
            };
            let list = match slot {
                Some(s) => pk.slots.get(&s),
                None => Some(&pk.children),
            };
            if list.is_some_and(|l| takes(l, plain(child), &ck.owner)) {
                Ok(())
            } else {
                refuse(
                    here,
                    "edit.child-not-admitted",
                    format!(
                        "{} does not admit {} (slot {slot:?})",
                        plain(parent),
                        plain(child)
                    ),
                )
            }
        };
        match op {
            Op::Place {
                name,
                kind,
                parent,
                at,
                ..
            } => {
                let k = kind.as_str();
                if !world.kinds.contains_key(k) || !copy.header().kinds.contains(kind) {
                    return refuse(
                        here,
                        "edit.kind-unknown",
                        format!("{k} is not pinned by this world"),
                    );
                }
                if new.contains_key(name) {
                    return refuse(here, "edit.name-twice", format!("{name} is placed twice"));
                }
                let (pk, _) = named(*parent)?;
                admits(&pk, k, at.slot)?;
                if let Ref::Node(p) = parent {
                    parents.push((i, *p));
                }
                new.insert(
                    *name,
                    New {
                        kind: k.to_owned(),
                        parent: *parent,
                    },
                );
                changed.insert(Ref::New(*name));
            }
            Op::Move { node, at } => {
                let (k, parent) = named(*node)?;
                let Some(parent) = parent else {
                    return refuse(here, "edit.root", "the zone's root does not move");
                };
                let (pk, _) = named(parent)?;
                admits(&pk, &k, at.slot)?;
                if let Ref::Node(id) = node {
                    reads.push((i, *id));
                }
                changed.insert(*node);
            }
            Op::Set { node, .. } => {
                named(*node)?;
                if let Ref::Node(id) = node {
                    reads.push((i, *id));
                }
                changed.insert(*node);
            }
            Op::Remove { node } => {
                let (_, parent) = named(*node)?;
                if parent.is_none() {
                    return refuse(here, "edit.root", "the zone's root is not removed");
                }
                // The subtree on the copy (a placed node's is in the batch), each node read and changed.
                let mut stack: Vec<Ref> = vec![*node];
                while let Some(r) = stack.pop() {
                    if let Ref::Node(id) = r {
                        reads.push((i, id));
                        if let Some(cs) = tree.handle(id).and_then(|h| tree.children(h)) {
                            stack.extend(
                                cs.iter()
                                    .filter_map(|c| tree.node(*c))
                                    .map(|n| Ref::Node(n.id())),
                            );
                        }
                    }
                    stack.extend(
                        new.iter()
                            .filter(|(_, x)| x.parent == r)
                            .map(|(n, _)| Ref::New(*n)),
                    );
                    changed.insert(r);
                    gone.insert(r);
                    if changed.len() > NODES_MOST {
                        break;
                    }
                }
            }
        }
        if changed.len() > NODES_MOST {
            return refuse(
                here,
                "edit.too-many-nodes",
                format!("over {NODES_MOST} changed nodes"),
            );
        }
    }
    Ok(Checked {
        edit,
        reads,
        parents,
    })
}

/// Whether the nodes a checked edit read are unchanged since it was planned, on `live`: the first that is not, as the
/// refusal. Each place's parent must still be there.
pub fn confirm(live: &Replica, c: &Checked) -> Result<(), Refused> {
    for (i, id) in &c.reads {
        if live.stamp(*id) > c.edit.planned {
            return refuse(
                Some(*i),
                "edit.stale",
                format!("{id:?} changed after version {}", c.edit.planned),
            );
        }
    }
    for (i, id) in &c.parents {
        if live.tree().handle(*id).is_none() {
            return refuse(Some(*i), "edit.stale", format!("{id:?} is gone"));
        }
    }
    Ok(())
}

/// The batch an undo or redo reverses, by the sequence of its first effect: a creator's effect caused by an earlier
/// effect. None for any other effect.
pub fn reverses(e: &Effect) -> Option<u64> {
    match (e.envelope.actor, e.envelope.cause) {
        (Actor::Creator(_), Cause::Effect(first)) => Some(first),
        _ => None,
    }
}

/// The safety rule's failures (G2, #2761): an edit, a thing set down, a lock or an undo that would bury a Soul's body,
/// change what it is using, or leave it no way out is refused before it commits, by one of these names.
pub const BURIES: &str = "edit.would-bury";
pub const IN_USE: &str = "edit.in-use";
pub const CUTS_OFF: &str = "edit.would-cut-off";

/// How a body uses a thing an edit touches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Use {
    /// Its pose is in one of the thing's slots (what it sits or lies in).
    In,
    /// Its support is the thing's surface (a counter, a table, a stair: a perch).
    On,
    /// The thing is a child of one of its body's slots (in its hand).
    Holds,
}

/// One body the safety rule finds unsafe: which failure, the Soul, where its body is (the node its pose is in, and the
/// point there, µm), and the thing it uses with how, when that is what the edit touches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unsafe {
    pub name: &'static str,
    pub soul: Id,
    pub node: Id,
    pub at: Vec3,
    pub thing: Option<(Id, Use)>,
}

/// Micrometres as metres to the centimetre.
fn metres(v: i64) -> String {
    let sign = if v < 0 { "-" } else { "" };
    let a = v.unsigned_abs();
    format!("{sign}{}.{:02}", a / 1_000_000, a % 1_000_000 / 10_000)
}

impl Unsafe {
    /// The refusal's text: the Soul, the place and a fix.
    pub fn text(&self) -> String {
        let soul = show(self.soul);
        let place = format!(
            "node {} at ({}, {}) m",
            show(self.node),
            metres(self.at.x),
            metres(self.at.z)
        );
        match (self.name, self.thing) {
            (IN_USE, Some((t, how))) => {
                let t = show(t);
                let (how, place) = match how {
                    // Its pose is in the thing's frame: the thing is the place.
                    Use::In => ("is in", String::new()),
                    Use::On => ("rests on", format!(", on {place}")),
                    Use::Holds => ("holds", format!(", on {place}")),
                };
                format!(
                    "Soul {soul} {how} {t}{place}; fix: leave {t} as it is until the Soul is done with it, or edit \
                     something else"
                )
            }
            (BURIES, _) => format!(
                "would bury Soul {soul} where it stands, on {place}; fix: keep what the edit places or moves clear \
                 of that spot by the body's radius, or make the edit once the Soul has moved"
            ),
            _ => format!(
                "would leave Soul {soul} no way out, on {place}; fix: keep a way from there to the open ground \
                 passable (a doorway, stair or gap a body can pass), or make the edit once the Soul has left"
            ),
        }
    }

    /// As a refusal of the whole batch.
    pub fn refused(&self) -> Refused {
        Refused {
            op: None,
            name: self.name,
            detail: self.text(),
        }
    }
}
