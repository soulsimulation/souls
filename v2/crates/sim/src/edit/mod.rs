//! A creator's edit committed (Engine v2 G1, #2746): the clock thread's share. `replica::edit::check` ran off the
//! clock on a frozen copy; here the clock thread confirms that what the edit touches is unchanged since it was planned
//! (`replica::edit::confirm`), mints the placed nodes' ids, and writes the batch as generic effects (T6) under one
//! cause, the edit's intent, with the creator as actor, through the one write path every act uses
//! ([`crate::commit::write`]): one part, applied whole or not at all, which the caller appends to the log as it does an
//! act's. It runs no search: the safety rule's verdict on its tick is lookups only.
//!
//! Each effect is written by its own node (T6 rule 6): a place by its parent, a move, set or remove by the node itself.
//! Operations in a row with the same writer and audience share one effect.
//!
//! The safety rule (G2's [`safety`], wired by #3280): [`plan`] runs off the clock after the check, writing the
//! would-be part on the copy (placed nodes under provisional ids, [`PROVISIONAL`]) and handing it to
//! [`safety::guard`]. [`commit`] takes the plan and the bodies as they stand on its tick, and refuses the edit by the
//! first unsafe body's name ([`safety::Guard::judge`], lookups only) before it mints or writes anything.
//!
//! A terrain edit (G5's [`terrain`]) is guarded the same way: planned off the clock, its Souls and resting things
//! judged on the commit tick before the safety rule. A creator's weather is set through [`weather`].

pub mod safety;
pub mod terrain;
pub mod undo;
pub mod weather;

use crate::commit::{off_clock, write_guarded};
use crate::structure::Structure;
use replica::apply::Replica;
use replica::edit::{Checked, Op, Ref, Refused, confirm};
use replica::effects::{Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest};
use replica::encode::{Value, encode};
use replica::ids::{Id, Minter, Scope};
use replica::pose::Frame;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::Audience;
use safety::{Guard, Who, guard};
use std::collections::BTreeMap;
use std::sync::Arc;

/// The scope of the ids a plan gives placed nodes on the copy: never minted for a node of a zone.
pub const PROVISIONAL: Scope = Scope([0xff; 16]);

/// A committed edit: its part, for the log and the views, and the receipt's map from each temporary name to the id
/// the engine minted for it.
#[derive(Clone, Debug)]
pub struct Committed {
    pub part: Arc<Part>,
    pub names: BTreeMap<u64, Id>,
}

/// An edit checked and guarded off the clock, ready for its commit tick.
pub struct Planned {
    pub checked: Checked,
    guard: Guard,
    terrain: Option<terrain::Guard>,
}

fn refused(name: &'static str, detail: impl Into<String>) -> Refused {
    Refused {
        op: None,
        name,
        detail: detail.into(),
    }
}

/// Off the clock thread, after `replica::edit::check` on the same copy: the safety rule's guard for the part the edit
/// would commit (see the module's notes). `ground` is the zone's open ground, none in a zone without one.
pub fn plan(checked: Checked, copy: &Replica, ground: Option<Id>) -> Result<Planned, Refused> {
    off_clock();
    let mut minter = Minter::new(PROVISIONAL);
    let names = names(&checked, &mut minter)?;
    let effects = effects(copy.tree(), copy.version(), &checked, &names, 0);
    let bytes = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(copy.header().hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ])))
    .map_err(|e| refused("encoding", e.to_string()))?;
    let part = Part::read(&bytes).map_err(|r| refused(r.name, r.detail))?;
    let terrain = terrain::guard(copy.tree(), copy.header(), ground, &checked, &part)?;
    let guard = guard(copy.tree(), copy.header(), ground, &part)
        .map_err(|e| refused("edit.unchecked", e))?;
    Ok(Planned {
        checked,
        guard,
        terrain,
    })
}

/// Each placed node's temporary name and the id `minter` gives it.
fn names(checked: &Checked, minter: &mut Minter) -> Result<BTreeMap<u64, Id>, Refused> {
    let mut names = BTreeMap::new();
    for op in &checked.edit.ops {
        if let Op::Place { name, .. } = op {
            let id = minter
                .mint()
                .map_err(|e| refused("edit.ids-exhausted", e.to_string()))?;
            names.insert(*name, id);
        }
    }
    Ok(names)
}

/// Commits a planned edit on the live replica at world time `at` (see the module's notes), or refuses it whole: a
/// refusal changes nothing. `bodies` are the zone's Souls' bodies as they stand on this tick.
pub fn commit(
    live: &mut Replica,
    minter: &mut Minter,
    planned: &Planned,
    bodies: &[Who],
    at: Micros,
) -> Result<Committed, Refused> {
    commit_guarded(live, minter, planned, bodies, at, &Structure::default())
}

/// [`commit`], with the world's structure rule checked on the write (B18, `crate::structure`).
pub fn commit_guarded(
    live: &mut Replica,
    minter: &mut Minter,
    planned: &Planned,
    bodies: &[Who],
    at: Micros,
    structure: &Structure,
) -> Result<Committed, Refused> {
    let checked = &planned.checked;
    confirm(live, checked)?;
    if let Some(t) = &planned.terrain {
        t.judge(bodies)?;
    }
    let unsafe_ = planned.guard.judge(bodies);
    if let Some(first) = unsafe_.first() {
        let detail = unsafe_.iter().map(|u| u.text()).collect::<Vec<_>>();
        return Err(refused(first.name, detail.join("\n")));
    }
    let names = names(checked, minter)?;
    let effects = effects(live.tree(), live.version(), checked, &names, at);
    let part = write_guarded(live, &effects, structure).map_err(|r| refused(r.name, r.detail))?;
    Ok(Committed { part, names })
}

/// The effects of a checked edit on `tree` at version `first`, its placed nodes under `names`.
fn effects(
    tree: &Tree,
    first: u64,
    checked: &Checked,
    names: &BTreeMap<u64, Id>,
    at: Micros,
) -> Vec<Effect> {
    let edit = &checked.edit;
    let audiences: BTreeMap<u64, Audience> = edit
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Place { name, audience, .. } => Some((*name, *audience)),
            _ => None,
        })
        .collect();
    let id = |r: Ref| match r {
        Ref::Node(id) => id,
        Ref::New(n) => names[&n],
    };
    let audience = |r: Ref| match r {
        Ref::New(n) => audiences[&n],
        Ref::Node(id) => tree
            .handle(id)
            .and_then(|h| tree.node(h))
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
                // Its frame as the batch has left it so far, else as the tree has it.
                let (parent, slot) = frames.get(&n).copied().unwrap_or_else(|| {
                    tree.handle(n)
                        .and_then(|h| tree.node(h))
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
    groups
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
        .collect()
}
