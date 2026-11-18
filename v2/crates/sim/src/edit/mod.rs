//! A creator's edit committed (Engine v2 G1, #2746): the clock thread's share. `replica::edit::check` ran off the
//! clock on a frozen copy; here the clock thread confirms that what the edit touches is unchanged since it was planned
//! (`replica::edit::confirm`), mints the placed nodes' ids, and writes the batch as generic effects (T6) under one
//! cause, the edit's intent, with the creator as actor, through the one write path every act uses
//! ([`crate::commit::write`]): one part, applied whole or not at all, which the caller appends to the log as it does an
//! act's. It runs no rule and no search.
//!
//! Each effect is written by its own node (T6 rule 6): a place by its parent, a move, set or remove by the node itself.
//! Operations in a row with the same writer and audience share one effect.

pub mod safety;

use crate::commit::write;
use replica::apply::Replica;
use replica::edit::{Checked, Op, Ref, Refused, confirm};
use replica::effects::{Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest};
use replica::ids::{Id, Minter};
use replica::pose::Frame;
use replica::time::Micros;
use replica::world_model::Audience;
use std::collections::BTreeMap;
use std::sync::Arc;

/// A committed edit: its part, for the log and the views, and the receipt's map from each temporary name to the id
/// the engine minted for it.
#[derive(Clone, Debug)]
pub struct Committed {
    pub part: Arc<Part>,
    pub names: BTreeMap<u64, Id>,
}

/// Commits a checked edit on the live replica at world time `at` (see the module's notes), or refuses it whole: a
/// refusal changes nothing.
pub fn commit(
    live: &mut Replica,
    minter: &mut Minter,
    checked: &Checked,
    at: Micros,
) -> Result<Committed, Refused> {
    confirm(live, checked)?;
    let edit = &checked.edit;
    let mut names = BTreeMap::new();
    let mut audiences: BTreeMap<u64, Audience> = BTreeMap::new();
    for op in &edit.ops {
        if let Op::Place { name, audience, .. } = op {
            let id = minter.mint().map_err(|e| Refused {
                op: None,
                name: "edit.ids-exhausted",
                detail: e.to_string(),
            })?;
            names.insert(*name, id);
            audiences.insert(*name, *audience);
        }
    }
    let id = |r: Ref| match r {
        Ref::Node(id) => id,
        Ref::New(n) => names[&n],
    };
    let audience = |r: Ref| match r {
        Ref::New(n) => audiences[&n],
        Ref::Node(id) => live
            .tree()
            .handle(id)
            .and_then(|h| live.tree().node(h))
            .map_or(Audience::Everyone, |n| n.audience()),
    };
    let mut frames: BTreeMap<Id, (Id, Option<u64>)> = BTreeMap::new();
    let mut groups: Vec<(Id, Audience, Vec<Change>)> = Vec::new();
    for op in &edit.ops {
        let (writer, seen_by, change) = match op {
            Op::Place {
                name,
                kind,
                parent,
                at,
                audience,
                fields,
            } => {
                let p = id(*parent);
                frames.insert(names[name], (p, at.slot));
                let change = Change::Create {
                    node: names[name],
                    kind: kind.clone(),
                    pose: at.pose(p),
                    audience: *audience,
                    fields: fields.clone(),
                };
                (p, *audience, change)
            }
            Op::Move { node, at } => {
                let n = id(*node);
                // Its frame as the batch has left it so far, else as the live tree has it.
                let (parent, slot) = frames.get(&n).copied().unwrap_or_else(|| {
                    live.tree()
                        .handle(n)
                        .and_then(|h| live.tree().node(h))
                        .and_then(|x| x.parent().map(|p| (p, x.slot())))
                        .unwrap_or_else(|| unreachable!("the check found it"))
                });
                frames.insert(n, (parent, at.slot));
                let change = Change::Reparent {
                    node: n,
                    from: Frame { node: parent, slot },
                    pose: at.pose(parent),
                };
                (n, audience(*node), change)
            }
            Op::Set { node, field, to } => {
                let n = id(*node);
                let change = Change::Set {
                    node: n,
                    field: *field,
                    to: to.clone(),
                    by: None,
                };
                (n, audience(*node), change)
            }
            Op::Remove { node } => {
                let n = id(*node);
                (n, audience(*node), Change::Remove { node: n })
            }
        };
        match groups.last_mut() {
            Some((w, a, changes)) if *w == writer && *a == seen_by => changes.push(change),
            _ => groups.push((writer, seen_by, vec![change])),
        }
    }
    let first = live.version();
    let effects: Vec<Effect> = groups
        .into_iter()
        .zip(first..)
        .map(|((node, audience, changes), sequence)| Effect {
            envelope: Envelope {
                sequence,
                at,
                cause: Cause::Intent(edit.intent),
                actor: edit.actor,
                audience,
                node,
            },
            body: Body::Changes(
                changes
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            ),
            events: None,
            rest: Rest::new(),
        })
        .collect();
    let part = write(live, &effects).map_err(|r| Refused {
        op: None,
        name: r.name,
        detail: r.detail,
    })?;
    Ok(Committed { part, names })
}
