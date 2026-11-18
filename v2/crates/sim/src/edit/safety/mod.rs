//! The safety rule (Engine v2 G2, #2761): a change that would bury a Soul's body, change what it is using, or leave it
//! no way out is refused before it commits, naming the Soul (`replica::edit::Unsafe`). One function for every caller:
//! a creator's edit, a thing a Soul sets down (E4), a form's effect that can close a way, such as a lock or a shut
//! door (E16), and an undo. Each hands it the would-be change as the part it would commit; none writes a second.
//!
//! - **Two steps.** [`guard`] runs off the clock thread, on the frozen copy: it applies the part to a copy of the
//!   tree, cuts the ground and route map on both sides of it (N3, N4, N5) and keeps what the verdict needs. Then
//!   [`Guard::judge`] gives the verdict for bodies as they stand: on the copy's bodies when the change is checked, and
//!   again on the tick it commits, against the bodies as they are then, so a Soul that walked in after the check
//!   still refuses it. Judging is lookups only (a spot on each map per body); no ground is cut on the tick.
//! - **Bury** (`edit.would-bury`): a standing body on ground before the change and on none after it. The would-be
//!   ground is cut with every box grown by the body's radius and margin (N3), so a new or moved solid whose grown
//!   footprint holds the body, a floor shrunk or moved from under it, or its node removed, all bury it.
//! - **In use** (`edit.in-use`): the change removes, moves or sets a thing a body is using: the thing whose slot its
//!   pose is in (what it sits or lies in), a surface other than its own floor that supports it (a perch: a counter, a
//!   table, a stair), or a thing in one of its body's slots (in its hand: a child of the slot, not a link). Removing or
//!   moving an ancestor touches the thing too. A Soul's own change may move what it holds (setting it down).
//! - **Cut off** (`edit.would-cut-off`): N10's meaning of a way out (`crate::ground::exits`: a doorway that still
//!   passes a centre, another usable link's end, the open ground going on) followed piece to piece through N5's map
//!   for the body's own abilities ([`crate::routes::Map::parts`], a door counted as needing hands): a body has a way
//!   out when its part of the map holds the open ground at large, the part with the most open ground. A body that
//!   had one before the change and has none after it is cut off. The part, not the piece, is what is judged: a room
//!   whose door opens on a corridor whose last door is blocked passes N10's check of the body's own piece
//!   (`tests.rs`), and so would a long thin pen whose pieces each reach a square's line.
//! - **Who is judged.** Every body handed in, in the order given, at most one failure each (in use first, then bury,
//!   then cut off); nothing stops at a count. A body in a slot is judged for what it uses only.
//!
//! Not here: moving a Soul aside, today's same-batch repair of blocked approaches to empty places to sit, other body
//! sizes (B12: the map is cut for today's walking body), who may pass a door (F6).

#[cfg(test)]
mod tests;

use crate::routes::{ALL, Map, Mask, Spot};
use replica::edit::{BURIES, CUTS_OFF, IN_USE, Unsafe, Use};
use replica::effects::{Actor, Body, Change, Header, Part, TransferRec};
use replica::ids::Id;
use replica::pose::{Pose, Support};
use replica::tree::Tree;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

/// How far a body may stand off its piece and still be on it, mm (as a route's start, `crate::walk::town`).
const AT_EDGE: i64 = 20;

/// A Soul's body as the rule judges it: the Soul, its body's node, its pose, and its abilities (N5's bits).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Who {
    pub soul: Id,
    pub body: Id,
    pub pose: Pose,
    pub has: Mask,
}

/// The ground on one side of the change: the route map, each ability mask's parts, and each mask's part with the most
/// open ground.
struct Side {
    map: Map,
    parts: Vec<Vec<u32>>,
    main: Vec<Option<u32>>,
}

/// Twice a piece's area, mm².
fn area2(map: &Map, q: u32) -> i128 {
    let pc = map.piece(q);
    pc.triangles
        .iter()
        .map(|t| {
            let v = |k: usize| pc.vertices[t[k] as usize].map(i128::from);
            let (a, b, c) = (v(0), v(1), v(2));
            ((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])).abs()
        })
        .sum()
}

impl Side {
    fn of(tree: &Tree, ground: Id) -> Result<Side, String> {
        let map = Map::build(tree, ground, &|_| 0)?;
        let open: Vec<i128> = (0..map.counts().0 as u32)
            .map(|q| {
                if map.patch_of(q).square.is_some() {
                    area2(&map, q)
                } else {
                    0
                }
            })
            .collect();
        let (mut parts, mut main) = (Vec::new(), Vec::new());
        for has in 0..=ALL {
            let p = map.parts(has);
            let mut sum: BTreeMap<u32, i128> = BTreeMap::new();
            for (q, &a) in open.iter().enumerate() {
                if a > 0 {
                    *sum.entry(p[q]).or_default() += a;
                }
            }
            main.push(
                sum.into_iter()
                    .max_by_key(|&(r, a)| (a, Reverse(r)))
                    .map(|(r, _)| r),
            );
            parts.push(p);
        }
        Ok(Side { map, parts, main })
    }

    /// Whether a body on `spot` with abilities `has` is in the part with the most open ground.
    fn out(&self, spot: Spot, has: Mask) -> bool {
        let m = usize::from(has & ALL);
        self.main[m] == Some(self.parts[m][spot.piece as usize])
    }
}

/// What [`guard`] keeps of a change for its verdict, read from both sides of it.
pub struct Guard {
    before: Side,
    after: Side,
    /// Nodes the change removes, each removed node's subtree whole.
    removed: BTreeSet<Id>,
    /// Nodes it removes, moves (subtrees whole) or sets.
    touched: BTreeSet<Id>,
    /// Of those, the ones in a slot, by the node whose slot holds them.
    held: BTreeMap<Id, Vec<Id>>,
    /// The Souls the change is made by: what each holds is its own to move.
    by: BTreeSet<Id>,
}

/// Each node of the subtree at `id` in `tree`, added to `out`.
fn subtree(tree: &Tree, id: Id, out: &mut BTreeSet<Id>) {
    let mut stack: Vec<_> = tree.handle(id).into_iter().collect();
    while let Some(h) = stack.pop() {
        if let Some(n) = tree.node(h) {
            out.insert(n.id());
        }
        stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
    }
}

/// Off the clock thread: the guard for the would-be change `part` on `before` (the frozen copy's tree; `header` is the
/// zone's, `ground` its open ground). Refused with why when the part does not apply to the copy.
pub fn guard(before: &Tree, header: &Header, ground: Id, part: &Part) -> Result<Guard, String> {
    let mut after = before.frozen();
    after
        .apply(header, part)
        .map_err(|e| format!("{}: {}", e.name, e.detail))?;
    let (mut removed, mut touched, mut by) = (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    for e in &part.effects {
        if let Actor::Soul(s) = e.envelope.actor {
            by.insert(s);
        }
        let changes = match &e.body {
            Body::Changes(c) => c,
            // A crossing to a new parent (a thing set down, picked up or carried through a door) moves its subtree.
            Body::Transfer(TransferRec::Leave { node, .. }) => {
                subtree(before, *node, &mut touched);
                continue;
            }
            _ => continue,
        };
        for c in changes {
            match &c.change {
                Change::Remove { node } => subtree(before, *node, &mut removed),
                Change::Reparent { node, .. } => subtree(before, *node, &mut touched),
                Change::Set { node, .. } => {
                    touched.insert(*node);
                }
                _ => {}
            }
        }
    }
    touched.extend(removed.iter().copied());
    let mut held: BTreeMap<Id, Vec<Id>> = BTreeMap::new();
    for &t in &touched {
        if let Some(n) = before.handle(t).and_then(|h| before.node(h))
            && let (Some(p), Some(_)) = (n.parent(), n.slot())
        {
            held.entry(p).or_default().push(t);
        }
    }
    Ok(Guard {
        before: Side::of(before, ground)?,
        after: Side::of(&after, ground)?,
        removed,
        touched,
        held,
        by,
    })
}

impl Guard {
    /// The verdict for `bodies` as they stand now: each body the change would leave unsafe, in the order given (see
    /// the module's notes). Empty: the change is safe for them.
    pub fn judge(&self, bodies: &[Who]) -> Vec<Unsafe> {
        bodies.iter().filter_map(|w| self.one(w)).collect()
    }

    fn one(&self, w: &Who) -> Option<Unsafe> {
        let (frame, at) = (w.pose.frame, w.pose.position);
        let fail = |name, thing| {
            Some(Unsafe {
                name,
                soul: w.soul,
                node: frame.node,
                at,
                thing,
            })
        };
        if frame.slot.is_some() && self.touched.contains(&frame.node) {
            return fail(IN_USE, Some((frame.node, Use::In)));
        }
        if let Support::Surface { surface, .. } = w.pose.support
            && surface != frame.node
            && self.touched.contains(&surface)
        {
            return fail(IN_USE, Some((surface, Use::On)));
        }
        if !self.by.contains(&w.soul)
            && let Some(t) = self.held.get(&w.body).and_then(|t| t.first())
        {
            return fail(IN_USE, Some((*t, Use::Holds)));
        }
        if frame.slot.is_some() {
            return None;
        }
        if self.removed.contains(&frame.node) {
            return fail(BURIES, None);
        }
        let b = self.before.map.spot_near(frame.node, at, AT_EDGE)?;
        let Some(a) = self.after.map.spot_near(frame.node, at, AT_EDGE) else {
            return fail(BURIES, None);
        };
        if self.before.out(b, w.has) && !self.after.out(a, w.has) {
            return fail(CUTS_OFF, None);
        }
        None
    }
}

/// The rule in one call, for a change judged once: the guard, and its verdict for `bodies` as they stand on the copy.
pub fn check(
    before: &Tree,
    header: &Header,
    ground: Id,
    part: &Part,
    bodies: &[Who],
) -> Result<(Guard, Vec<Unsafe>), String> {
    let g = guard(before, header, ground, part)?;
    let v = g.judge(bodies);
    Ok((g, v))
}
