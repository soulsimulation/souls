//! Undo, redo and builds with steps (Engine v2 G4, #2795). History is never rewritten (T7): an undo is a new batch of
//! inverse effects appended to the log, and so is a redo. Nothing is rolled back and no checkpoint is restored into a
//! live world.
//!
//! - **Before-values.** When a batch commits, the history keeps what its changes overwrote: each moved or set node's
//!   old pose and fields, and each removed node's whole subtree with every link at it. The inverse follows from T6's
//!   generic layer alone: what the batch created is removed (a link it made, unlinked), what it removed is created
//!   again with the same ids, kinds, poses, audiences, fields and links, and what it moved or set is moved or set back.
//!   A change with no generic inverse (a field the batch added, since T6 has no unset; a node in motion; a body that is
//!   not changes; an unlink) makes that batch's undo refused `undo.no-inverse`.
//! - **Undo, redo.** Undo reverses the newest batch not undone, redo the newest undo, and a new edit clears redo (the
//!   rules of `apps/server/src/god/god.ts`). Each is written by the creator under `Cause::Effect(first)`, where `first`
//!   is the sequence of the reversed batch's first effect ([`replica::edit::reverses`]).
//! - **Same ids.** Undoing a removal brings back the same things with their ids (TRUNK, "Settled at reconciliation";
//!   `v2/docs/ids.md` rule 4), so a redo of an undone place gives back the id the place minted, and later batches still
//!   point at what they named.
//! - **Checked like any batch.** An undo or redo passes G1's gate (the world's one creator, at most
//!   [`replica::edit::NODES_MOST`] changed nodes) and the caller's rule: G2's guard and judge (#2761) where wired. It is
//!   refused `undo.conflict` when a node it touches changed since the batch it reverses: the node's content hash differs
//!   from the one the batch left, or something was put inside a thing the undo would remove. So no undo takes a thing
//!   from a Soul's hands: taking it moved it. A refusal changes nothing, neither the world nor the history.
//! - **Builds.** A build is a label and step names on batches ([`Step`]). Rewinding to a step undoes the batches after
//!   it, newest first, and stops at the first refusal. A step here is a name on a batch, not K5's checkpoint.
//! - **Bound.** The history keeps at most [`KEPT_MOST`] bytes of inverse effects (64 MiB, an eighth of today's 512 MB
//!   journal cap), measured as their encoded size; the oldest batches leave first and can no longer be undone.

#[cfg(test)]
mod tests;

use crate::commit::write;
use crate::edit::safety::Who;
use crate::edit::{Committed, Planned, commit};
use replica::apply::Replica;
use replica::edit::{NODES_MOST, Refused, World};
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest};
use replica::encode::{Name, Value, encode};
use replica::hash::node_hash;
use replica::ids::{Hash, Id};
use replica::pose::{Frame, Pose};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{Audience, End};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

/// The most bytes of inverse effects a history keeps (the module's notes).
pub const KEPT_MOST: usize = 64 << 20;

/// A build's label and a step's name on a batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub build: String,
    pub name: String,
}

/// The rule an undo or redo passes before it is written: G2's guard and judge (#2761) where wired. It sees the live
/// replica and the effects about to be written.
pub type Rule<'a> = &'a mut dyn FnMut(&Replica, &[Effect]) -> Result<(), Refused>;

/// One change of an inverse, with the node that writes it (T6 rule 6) and its audience.
#[derive(Clone, Debug)]
struct Write {
    node: Id,
    audience: Audience,
    change: Change,
}

/// A committed batch as the history keeps it.
#[derive(Clone, Debug)]
struct Batch {
    /// The sequence of its first effect: how an undo or redo names it.
    first: u64,
    /// The touched nodes' content hashes after it (none for a node it removed).
    after: BTreeMap<Id, Option<Hash>>,
    /// The changes that reverse it, or why there are none.
    inverse: Result<Vec<Write>, Refused>,
    step: Option<Step>,
    /// The encoded size of its inverse.
    kept: usize,
}

/// A node as it was before a batch.
#[derive(Clone, Debug)]
struct Was {
    kind: Name,
    parent: Option<Id>,
    /// Its pose in its parent's frame; none for the zone's root.
    pose: Option<Pose>,
    audience: Audience,
    fields: BTreeMap<u64, Value>,
    moving: bool,
}

/// A link as it was before a batch.
#[derive(Clone, Debug)]
struct LinkWas {
    ty: Name,
    ends: [Id; 2],
    owner: End,
    audience: Audience,
}

/// The before-values of the nodes a batch is about to touch: read with [`Before::of`] just before the batch is
/// written, and handed to [`History::record`] with the part it wrote.
#[derive(Default)]
pub struct Before {
    nodes: BTreeMap<Id, Was>,
    links: BTreeMap<Id, LinkWas>,
}

impl Before {
    /// The nodes `ids` (and the links at them) as they stand on `tree`.
    pub fn of(tree: &Tree, ids: impl IntoIterator<Item = Id>) -> Before {
        let mut b = Before::default();
        for id in ids {
            if b.nodes.contains_key(&id) {
                continue;
            }
            let Some(h) = tree.handle(id) else { continue };
            let Some(n) = tree.node(h) else { continue };
            let pose = n.parent().zip(n.place()).map(|(p, at)| Pose {
                frame: Frame {
                    node: p,
                    slot: n.slot(),
                },
                position: at.position,
                orientation: at.orientation,
                support: at.support,
            });
            b.nodes.insert(
                id,
                Was {
                    kind: n.kind().clone(),
                    parent: n.parent(),
                    pose,
                    audience: n.audience(),
                    fields: n.fields().clone(),
                    moving: n.moved().is_some(),
                },
            );
            for e in tree.links_of(h).unwrap_or(&[]) {
                if let Some((ty, ends, owner, audience)) = tree.link(e.link) {
                    b.links.insert(
                        e.link,
                        LinkWas {
                            ty: ty.clone(),
                            ends,
                            owner,
                            audience,
                        },
                    );
                }
            }
        }
        b
    }
}

/// `id` and every node below it on `tree`.
fn subtree(tree: &Tree, id: Id) -> Vec<Id> {
    let mut out = Vec::new();
    let mut stack = vec![id];
    while let Some(id) = stack.pop() {
        let Some(h) = tree.handle(id) else { continue };
        out.push(id);
        for c in tree.children(h).unwrap_or(&[]) {
            if let Some(n) = tree.node(*c) {
                stack.push(n.id());
            }
        }
    }
    out
}

fn no_inverse<T>(detail: impl Into<String>) -> Result<T, Refused> {
    Err(Refused {
        op: None,
        name: "undo.no-inverse",
        detail: detail.into(),
    })
}

fn conflict<T>(detail: impl Into<String>) -> Result<T, Refused> {
    Err(Refused {
        op: None,
        name: "undo.conflict",
        detail: detail.into(),
    })
}

/// The changes that reverse `part`, read from what it overwrote (`before`) and the live tree after it.
fn inverse(before: &Before, tree: &Tree, part: &Part) -> Result<Vec<Write>, Refused> {
    let alive = |id: Id| tree.handle(id).is_some();
    let mut created = Vec::new();
    let mut linked = Vec::new();
    let mut changed = BTreeSet::new();
    for e in &part.effects {
        let Body::Changes(cs) = &e.body else {
            return no_inverse("a body that is not changes");
        };
        for c in cs {
            match &c.change {
                Change::Create { node, .. } => created.push(*node),
                Change::Link { link, .. } => linked.push(*link),
                Change::Remove { .. } => {}
                Change::Reparent { node, .. } | Change::Set { node, .. } => {
                    changed.insert(*node);
                }
                other => return no_inverse(format!("no generic inverse for {other:?}")),
            }
        }
    }
    let now = |id: Id| tree.handle(id).and_then(|h| tree.node(h));
    let mut out = Vec::new();
    // What the batch placed and is still here: the topmost of each, newest first, by itself.
    let made: BTreeSet<Id> = created.iter().copied().filter(|id| alive(*id)).collect();
    for id in created.iter().rev().filter(|id| made.contains(id)) {
        let n = now(*id).expect("alive");
        if n.parent().is_some_and(|p| made.contains(&p)) {
            continue;
        }
        out.push(Write {
            node: *id,
            audience: n.audience(),
            change: Change::Remove { node: *id },
        });
    }
    // The links it made that removing those leaves, by their owning ends.
    for link in linked.iter().rev() {
        let Some((_, ends, owner, audience)) = tree.link(*link) else {
            continue;
        };
        if ends.iter().any(|e| made.contains(e)) {
            continue;
        }
        out.push(Write {
            node: ends[usize::from(owner == End::Second)],
            audience,
            change: Change::Unlink { link: *link },
        });
    }
    // What it removed, parents first, each created by its parent; then the links at it.
    let gone: BTreeMap<Id, &Was> = before
        .nodes
        .iter()
        .filter(|(id, _)| !alive(**id))
        .map(|(id, w)| (*id, w))
        .collect();
    let mut kids: BTreeMap<Id, Vec<Id>> = BTreeMap::new();
    for (id, w) in &gone {
        if let Some(p) = w.parent {
            kids.entry(p).or_default().push(*id);
        }
    }
    let mut stack: Vec<Id> = gone
        .iter()
        .filter(|(_, w)| w.parent.is_none_or(|p| !gone.contains_key(&p)))
        .map(|(id, _)| *id)
        .rev()
        .collect();
    while let Some(id) = stack.pop() {
        let w = gone[&id];
        let (Some(pose), false) = (w.pose, w.moving) else {
            return no_inverse(format!("{id:?} was in motion or has no pose"));
        };
        out.push(Write {
            node: pose.frame.node,
            audience: w.audience,
            change: Change::Create {
                node: id,
                kind: w.kind.clone(),
                pose,
                audience: w.audience,
                fields: w.fields.clone(),
            },
        });
        stack.extend(kids.get(&id).into_iter().flatten().rev());
    }
    for (link, l) in &before.links {
        if tree.link(*link).is_none() {
            out.push(Write {
                node: l.ends[usize::from(l.owner == End::Second)],
                audience: l.audience,
                change: Change::Link {
                    link: *link,
                    ty: l.ty.clone(),
                    ends: l.ends,
                    owner: l.owner,
                    audience: l.audience,
                },
            });
        }
    }
    // What it moved or set and is still here: back to its old pose and fields.
    for id in &changed {
        let (Some(w), Some(n)) = (before.nodes.get(id), now(*id)) else {
            continue;
        };
        if n.parent() != w.parent {
            return no_inverse(format!("{id:?} has another parent"));
        }
        if let (Some(pose), Some(p), Some(at)) = (w.pose, n.parent(), n.place()) {
            let here = (n.slot(), at.position, at.orientation, at.support);
            if here
                != (
                    pose.frame.slot,
                    pose.position,
                    pose.orientation,
                    pose.support,
                )
            {
                out.push(Write {
                    node: *id,
                    audience: n.audience(),
                    change: Change::Reparent {
                        node: *id,
                        from: Frame {
                            node: p,
                            slot: n.slot(),
                        },
                        pose,
                    },
                });
            }
        }
        if let Some(k) = n.fields().keys().find(|k| !w.fields.contains_key(k)) {
            return no_inverse(format!("{id:?} field {k} was added, and T6 has no unset"));
        }
        for (field, to) in &w.fields {
            if n.fields().get(field) != Some(to) {
                out.push(Write {
                    node: *id,
                    audience: n.audience(),
                    change: Change::Set {
                        node: *id,
                        field: *field,
                        to: to.clone(),
                        by: None,
                    },
                });
            }
        }
    }
    Ok(out)
}

/// `writes` as effects from sequence `first`: a run of writes with the same writer and audience shares one effect.
fn effects(writes: &[Write], first: u64, at: Micros, cause: Cause, actor: Actor) -> Vec<Effect> {
    let mut groups: Vec<(Id, Audience, Vec<ChangeRec>)> = Vec::new();
    for w in writes {
        let rec = ChangeRec {
            change: w.change.clone(),
            rest: Rest::new(),
        };
        match groups.last_mut() {
            Some((n, a, list)) if *n == w.node && *a == w.audience => list.push(rec),
            _ => groups.push((w.node, w.audience, vec![rec])),
        }
    }
    groups
        .into_iter()
        .zip(first..)
        .map(|((node, audience, changes), sequence)| Effect {
            envelope: Envelope {
                sequence,
                at,
                cause,
                actor,
                audience,
                node,
            },
            body: Body::Changes(changes),
            events: None,
            rest: Rest::new(),
        })
        .collect()
}

/// The nodes an inverse overwrites, read before it is written: each moved or set node, a removed node's subtree.
fn reads(tree: &Tree, writes: &[Write]) -> Vec<Id> {
    let mut ids = Vec::new();
    for w in writes {
        match &w.change {
            Change::Remove { node } => ids.extend(subtree(tree, *node)),
            Change::Reparent { node, .. } | Change::Set { node, .. } => ids.push(*node),
            _ => {}
        }
    }
    ids
}

/// What an undo or redo wrote: its part, for the log and the views.
#[derive(Clone, Debug)]
pub struct Reversed {
    pub part: Arc<Part>,
    /// The sequence of the reversed batch's first effect, which the part's cause names.
    pub reverses: u64,
}

/// What a rewind did: the parts it wrote, newest batch's undo first, and the refusal it stopped at, if any.
#[derive(Clone, Debug)]
pub struct Rewound {
    pub parts: Vec<Reversed>,
    pub stopped: Option<Refused>,
}

/// One creator's history in one world: the batches that can be undone and the undos that can be redone.
#[derive(Debug)]
pub struct History {
    done: VecDeque<Batch>,
    undone: Vec<Batch>,
    kept: usize,
    limit: usize,
}

impl Default for History {
    fn default() -> History {
        History::with_limit(KEPT_MOST)
    }
}

impl History {
    /// A history that keeps at most `limit` bytes of inverse effects.
    pub fn with_limit(limit: usize) -> History {
        History {
            done: VecDeque::new(),
            undone: Vec::new(),
            kept: 0,
            limit,
        }
    }

    /// Batches that can be undone, and undos that can be redone.
    pub fn depth(&self) -> (usize, usize) {
        (self.done.len(), self.undone.len())
    }

    /// Bytes of inverse effects kept.
    pub fn kept(&self) -> usize {
        self.kept
    }

    /// Commits a planned edit through G1 (`crate::edit::commit`, which judges the safety rule against `bodies`),
    /// keeping its before-values, with `step` its build step's name if any. A new edit clears redo.
    pub fn edit(
        &mut self,
        live: &mut Replica,
        minter: &mut replica::ids::Minter,
        planned: &Planned,
        bodies: &[Who],
        at: Micros,
        step: Option<Step>,
    ) -> Result<Committed, Refused> {
        let checked = &planned.checked;
        let before = Before::of(live.tree(), checked.reads.iter().map(|(_, id)| *id));
        let c = commit(live, minter, planned, bodies, at)?;
        self.record(&before, live, &c.part, step);
        Ok(c)
    }

    /// Keeps a batch committed elsewhere (the world's own commit path) as [`History::edit`] keeps its own: `before`
    /// read just before `part` was written on `live`, `step` its build step's name if any. A new edit clears redo.
    pub fn record(&mut self, before: &Before, live: &Replica, part: &Part, step: Option<Step>) {
        self.undone.clear();
        let batch = self.batch(before, live, part, step);
        self.done.push_back(batch);
        self.trim();
    }

    /// The effects an undo (or, with `redo`, a redo) would write on `live` now, after G1's gate and the conflict
    /// check, numbered from `live`'s version; nothing is written. The world plans its guard and maps on these off the
    /// clock, then commits with [`History::undo`] or [`History::redo`], whose rule finds the same effects.
    pub fn preview(
        &self,
        redo: bool,
        live: &Replica,
        world: &World,
        actor: Actor,
        at: Micros,
    ) -> Result<Vec<Effect>, Refused> {
        let b = if redo {
            self.undone.last().ok_or_else(|| Refused {
                op: None,
                name: "undo.nothing-to-redo",
                detail: "no undo to redo".to_owned(),
            })?
        } else {
            self.done.back().ok_or_else(|| Refused {
                op: None,
                name: "undo.nothing",
                detail: "no batch to undo".to_owned(),
            })?
        };
        let writes = Self::admit(b, live, world, actor)?;
        Ok(effects(
            &writes,
            live.version(),
            at,
            Cause::Effect(b.first),
            actor,
        ))
    }

    /// The step names of the batches that can be undone, oldest first (a build's steps, as `history` lists them).
    pub fn steps(&self) -> Vec<(u64, Option<Step>)> {
        self.done.iter().map(|b| (b.first, b.step.clone())).collect()
    }

    /// Undoes the newest batch not undone (the module's notes), or refuses and changes nothing.
    pub fn undo(
        &mut self,
        live: &mut Replica,
        world: &World,
        actor: Actor,
        at: Micros,
        rule: Rule<'_>,
    ) -> Result<Reversed, Refused> {
        let Some(b) = self.done.back() else {
            return Err(Refused {
                op: None,
                name: "undo.nothing",
                detail: "no batch to undo".to_owned(),
            });
        };
        let (r, next) = self.reverse(b, live, world, actor, at, rule)?;
        self.done.pop_back();
        self.undone.push(next);
        self.trim();
        Ok(r)
    }

    /// Redoes the newest undo, giving back the same ids, or refuses and changes nothing.
    pub fn redo(
        &mut self,
        live: &mut Replica,
        world: &World,
        actor: Actor,
        at: Micros,
        rule: Rule<'_>,
    ) -> Result<Reversed, Refused> {
        let Some(u) = self.undone.last() else {
            return Err(Refused {
                op: None,
                name: "undo.nothing-to-redo",
                detail: "no undo to redo".to_owned(),
            });
        };
        let (r, next) = self.reverse(u, live, world, actor, at, rule)?;
        self.undone.pop();
        self.done.push_back(next);
        self.trim();
        Ok(r)
    }

    /// Undoes the batches after the newest one named `step` of `build`, newest first, stopping at the first refusal.
    pub fn rewind(
        &mut self,
        live: &mut Replica,
        world: &World,
        actor: Actor,
        step: &Step,
        at: Micros,
        rule: Rule<'_>,
    ) -> Result<Rewound, Refused> {
        let Some(i) = self
            .done
            .iter()
            .rposition(|b| b.step.as_ref() == Some(step))
        else {
            return Err(Refused {
                op: None,
                name: "undo.step-unknown",
                detail: format!("no batch is step {} of build {}", step.name, step.build),
            });
        };
        let mut parts = Vec::new();
        for _ in i + 1..self.done.len() {
            match self.undo(live, world, actor, at, rule) {
                Ok(r) => parts.push(r),
                Err(e) => {
                    return Ok(Rewound {
                        parts,
                        stopped: Some(e),
                    });
                }
            }
        }
        Ok(Rewound {
            parts,
            stopped: None,
        })
    }

    /// Writes `b`'s inverse after G1's gate, the conflict check and `rule`, giving the part and the batch it left (whose
    /// inverse reverses it in turn). Changes nothing on a refusal.
    fn reverse(
        &self,
        b: &Batch,
        live: &mut Replica,
        world: &World,
        actor: Actor,
        at: Micros,
        rule: Rule<'_>,
    ) -> Result<(Reversed, Batch), Refused> {
        let writes = Self::admit(b, live, world, actor)?;
        let tree = live.tree();
        let cause = Cause::Effect(b.first);
        let list = effects(&writes, live.version(), at, cause, actor);
        rule(live, &list)?;
        let before = Before::of(tree, reads(tree, &writes));
        let part = write(live, &list).map_err(|r| Refused {
            op: None,
            name: "undo.conflict",
            detail: format!("{}: {}", r.name, r.detail),
        })?;
        let next = self.batch(&before, live, &part, b.step.clone());
        Ok((
            Reversed {
                part,
                reverses: b.first,
            },
            next,
        ))
    }

    /// G1's gate and the conflict check for writing `b`'s inverse on `live`: its writes, or why not.
    fn admit(b: &Batch, live: &Replica, world: &World, actor: Actor) -> Result<Vec<Write>, Refused> {
        if actor != Actor::Creator(world.creator) {
            return Err(Refused {
                op: None,
                name: "edit.not-the-creator",
                detail: "only the world's creator edits it".to_owned(),
            });
        }
        let writes = b.inverse.clone()?;
        if writes.len() > NODES_MOST {
            return Err(Refused {
                op: None,
                name: "edit.too-many-nodes",
                detail: format!("over {NODES_MOST} changed nodes"),
            });
        }
        let tree = live.tree();
        for (id, was) in &b.after {
            let Some(was) = was else { continue };
            if node_hash(tree, *id).as_ref() != Some(was) {
                return conflict(format!("{id:?} changed since batch {}", b.first));
            }
        }
        for w in &writes {
            if let Change::Remove { node } = w.change
                && let Some(x) = subtree(tree, node)
                    .into_iter()
                    .find(|x| !b.after.contains_key(x))
            {
                return conflict(format!("{x:?} was put in {node:?} since batch {}", b.first));
            }
        }
        Ok(writes)
    }

    /// The history's record of a committed part.
    fn batch(&self, before: &Before, live: &Replica, part: &Part, step: Option<Step>) -> Batch {
        let tree = live.tree();
        let inverse = inverse(before, tree, part);
        let mut touched: BTreeSet<Id> = before.nodes.keys().copied().collect();
        for e in &part.effects {
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    match &c.change {
                        Change::Create { node, .. }
                        | Change::Reparent { node, .. }
                        | Change::Set { node, .. } => {
                            touched.insert(*node);
                        }
                        _ => {}
                    }
                }
            }
        }
        let after = touched
            .into_iter()
            .map(|id| (id, node_hash(tree, id)))
            .collect();
        let kept = inverse.as_ref().map_or(0, |w| {
            effects(w, 0, 0, Cause::World, Actor::World)
                .iter()
                .map(|e| encode(&e.to_value()).map_or(0, |b| b.len()))
                .sum()
        });
        Batch {
            first: part.effects.first().map_or(0, |e| e.envelope.sequence),
            after,
            inverse,
            step,
            kept,
        }
    }

    /// Drops the oldest batches while more than the limit is kept.
    fn trim(&mut self) {
        self.kept = self.done.iter().chain(&self.undone).map(|b| b.kept).sum();
        while self.kept > self.limit
            && let Some(b) = self.done.pop_front()
        {
            self.kept -= b.kept;
        }
    }
}
