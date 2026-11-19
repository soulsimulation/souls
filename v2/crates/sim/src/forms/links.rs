//! Link and unlink effects (Engine v2 F15, #3385): what a form's `link` and `unlink` write, worked out at the effect's
//! instant against the tree as of the tick's start and the entries the forms wrote since ([`View`]). No code here
//! names a kind.
//!
//! - **Link** writes one K5 link (contract T2 rule 7) of the kind's type from the actor's end (its Soul or its body)
//!   to the node, owned by the node (an entry writes its own node, T6), seen by everyone.
//! - **Unlink** takes down the node's own links of that type: the one ending at the actor's end, or every one. A link
//!   the node does not own is not its to write and is left. With none to take down it changes nothing (a form such as
//!   closing a door unlinks whoever opened it, if anyone did): its one entry carries the effect's key alone.
//!
//! Not here: a link seen by its owner or its members (its audience node is T8's); the binder refuses it.

use replica::effects::{Body, Change, ChangeRec, Refusal, Rest};
use replica::encode::Name;
use replica::ids::{Id, Minter};
use replica::world_model::{Audience, End};

use super::amounts::{Cx, View};
use crate::slots::Entry;

type R<T> = Result<T, Refusal>;

fn owning(ends: [Id; 2], owner: End) -> Id {
    match owner {
        End::First => ends[0],
        End::Second => ends[1],
    }
}

/// The links of type `ty` that `node` owns, as the tree and the entries written since leave them: each as (link, its
/// other end, its audience), oldest first.
fn owned(view: &View, node: Id, ty: &Name) -> Vec<(Id, Id, Audience)> {
    let mut out: Vec<(Id, Id, Audience)> = view
        .tree
        .links_at(node)
        .iter()
        .filter(|e| view.tree.ty(e) == ty)
        .filter(|e| {
            view.tree
                .link(e.link)
                .is_some_and(|(_, ends, owner, _)| owning(ends, owner) == node)
        })
        .map(|e| (e.link, e.other, e.audience))
        .collect();
    for c in view.out.iter().flat_map(|e| e.changes()) {
        match &c.change {
            Change::Link {
                link,
                ty: t,
                ends,
                owner,
                audience,
            } if t == ty && owning(*ends, *owner) == node => {
                let other = if ends[0] == node { ends[1] } else { ends[0] };
                out.push((*link, other, *audience));
            }
            Change::Unlink { link } => out.retain(|(l, _, _)| l != link),
            // A removal takes every link ending in what it removes (T2 rule 3).
            Change::Remove { node: gone } => out.retain(|(_, o, _)| o != gone),
            _ => {}
        }
    }
    out
}

fn changes(c: Vec<Change>) -> Body {
    Body::Changes(
        c.into_iter()
            .map(|change| ChangeRec {
                change,
                rest: Rest::new(),
            })
            .collect(),
    )
}

/// A link of type `ty` from the actor's end (its Soul when `soul`, else its body) to the node, owned by the node and
/// seen by everyone; refused `link-full` when the node already owns `most` of that type (C24).
pub(super) fn link(
    cx: &Cx,
    m: &mut Minter,
    ty: &Name,
    soul: bool,
    most: Option<u64>,
) -> R<Vec<Entry>> {
    let end = if soul { cx.soul } else { cx.body };
    let has = owned(&cx.view, cx.node, ty).len() as u64;
    if most.is_some_and(|m| has >= m) {
        return Err(Refusal {
            name: "link-full",
            detail: format!(
                "{} has {has} of {}",
                replica::world_model::show(cx.node),
                ty.as_str()
            ),
        });
    }
    let link = m.mint().map_err(|e| Refusal {
        name: "id-counter-exhausted",
        detail: e.to_string(),
    })?;
    let audience = Audience::Everyone;
    Ok(vec![(
        cx.node,
        audience,
        changes(vec![Change::Link {
            link,
            ty: ty.clone(),
            ends: [end, cx.node],
            owner: End::Second,
            audience,
        }]),
    )])
}

/// The node's own links of type `ty` taken down, each in an entry of its audience: the one ending at the actor's end
/// (its Soul when `soul`, else its body), or every one when `all`. With none, one entry of no change.
pub(super) fn unlink(cx: &Cx, ty: &Name, soul: bool, all: bool) -> R<Vec<Entry>> {
    let end = if soul { cx.soul } else { cx.body };
    let gone: Vec<Entry> = owned(&cx.view, cx.node, ty)
        .into_iter()
        .filter(|(_, other, _)| all || *other == end)
        .map(|(link, _, audience)| (cx.node, audience, changes(vec![Change::Unlink { link }])))
        .collect();
    match gone.is_empty() {
        true => Ok(vec![(cx.node, Audience::Everyone, changes(Vec::new()))]),
        false => Ok(gone),
    }
}
