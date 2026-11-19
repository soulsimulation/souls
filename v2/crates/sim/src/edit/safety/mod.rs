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
//!   then cut off); nothing stops at a count.
//! - **Seated or lying** (#3280): a body in a slot is judged for what it uses, and then for being shut in: it stands
//!   up onto the ground nearest the thing it is in (within [`REACH`], at the thing's height on its floor or the open
//!   ground), and is cut off when that ground had a way out before the change and has none after it, or there is no
//!   ground left there to stand up onto.
//! - **Partway across a link** (#3280): a body crossing a doorway, stair, ramp or ladder ([`Who::crossing`]) runs the
//!   crossing to an end. A change that removes the link or newly blocks it (its passage filled, an end covered)
//!   buries the body in it; one that leaves neither end's piece with a way out cuts it off.
//! - **A zone with no open ground** (`ground` none): no ground is cut, so only what a body uses is judged.
//!
//! Not here: moving a Soul aside, today's same-batch repair of blocked approaches to empty places to sit, other body
//! sizes (B12: the map is cut for today's walking body), who may pass a door (F6).

#[cfg(test)]
mod tests;

use crate::ground::scene::xform_to;
use crate::routes::{ALL, Map, Mask, Spot};
use replica::edit::{BURIES, CUTS_OFF, IN_USE, Unsafe, Use};
use replica::effects::{Actor, Body, Change, Header, Part, TransferRec};
use replica::ids::Id;
use replica::pose::{Pose, Support, Vec3};
use replica::tree::{Handle, Tree};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

/// How far a body may stand off its piece and still be on it, mm (as a route's start, `crate::walk::town`).
const AT_EDGE: i64 = 20;
/// How far from the thing it sits or lies in a body may stand up onto the ground, mm: half the width of a thing to lie
/// in and a body's radius, with room to spare.
pub const REACH: i64 = 1_200;

/// A Soul's body as the rule judges it: the Soul, its body's node, its pose, its abilities (N5's bits), and the link
/// it is partway across, if it is crossing one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Who {
    pub soul: Id,
    pub body: Id,
    pub pose: Pose,
    pub has: Mask,
    pub crossing: Option<Id>,
}

/// The ground on one side of the change: the route map, each ability mask's parts, each mask's part with the most
/// open ground, and each link's blocking and the pieces its ends lie on.
struct Side {
    map: Map,
    parts: Vec<Vec<u32>>,
    main: Vec<Option<u32>>,
    links: BTreeMap<Id, (Option<&'static str>, Vec<u32>)>,
}

/// Both sides of the change, and where each thing stands before it: its floor or the open ground, and its origin
/// there (µm).
struct Sides {
    before: Side,
    after: Side,
    places: BTreeMap<Id, (Id, Vec3)>,
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
        let links = map
            .links()
            .iter()
            .enumerate()
            .map(|(k, l)| (l.id, (l.blocked, map.link_pieces(k))))
            .collect();
        Ok(Side {
            map,
            parts,
            main,
            links,
        })
    }

    /// Whether a body on `spot` with abilities `has` is in the part with the most open ground.
    fn out(&self, spot: Spot, has: Mask) -> bool {
        self.out_piece(spot.piece, has)
    }

    fn out_piece(&self, piece: u32, has: Mask) -> bool {
        let m = usize::from(has & ALL);
        self.main[m] == Some(self.parts[m][piece as usize])
    }
}

/// Where each node under a floor or the open ground stands: the nearest such ancestor and the node's origin in its
/// frame (µm).
fn places(tree: &Tree, root: Id, ground: Id, map: &Map) -> BTreeMap<Id, (Id, Vec3)> {
    let mut out = BTreeMap::new();
    let mut stack: Vec<(Handle, Option<(Id, Handle)>)> =
        tree.handle(root).into_iter().map(|h| (h, None)).collect();
    while let Some((h, on)) = stack.pop() {
        let Some(n) = tree.node(h) else { continue };
        let id = n.id();
        let on = if id == ground || map.is_floor(id) {
            Some((id, h))
        } else {
            if let Some((p, ph)) = on
                && let Ok(at) = xform_to(tree, h, ph).and_then(|x| x.point(Vec3::ZERO))
            {
                out.insert(id, (p, at));
            }
            on
        };
        stack.extend(tree.children(h).unwrap_or(&[]).iter().map(|&c| (c, on)));
    }
    out
}

/// What [`guard`] keeps of a change for its verdict, read from both sides of it.
pub struct Guard {
    /// None in a zone with no open ground.
    sides: Option<Sides>,
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
/// zone's, `ground` its open ground, none in a zone without one). Refused with why when the part does not apply to
/// the copy.
pub fn guard(
    before: &Tree,
    header: &Header,
    ground: Option<Id>,
    part: &Part,
) -> Result<Guard, String> {
    // It cuts the ground on both sides of the change: never on the clock thread (G3b, #3449).
    crate::commit::off_clock();
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
    let sides = match ground {
        Some(g) => {
            let b = Side::of(before, g)?;
            Some(Sides {
                places: places(before, header.zone, g, &b.map),
                before: b,
                after: Side::of(&after, g)?,
            })
        }
        None => None,
    };
    Ok(Guard {
        sides,
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
        let s = self.sides.as_ref()?;
        if frame.slot.is_some() {
            // Seated or lying: shut in when the ground it stands up onto loses its way out.
            let &(patch, p) = s.places.get(&frame.node)?;
            let b = s.before.map.spot_near(patch, p, REACH)?;
            let a = s.after.map.spot_near(patch, p, REACH);
            if s.before.out(b, w.has) && !a.is_some_and(|a| s.after.out(a, w.has)) {
                return Some(Unsafe {
                    name: CUTS_OFF,
                    soul: w.soul,
                    node: patch,
                    at: p,
                    thing: None,
                });
            }
            return None;
        }
        if self.removed.contains(&frame.node) {
            return fail(BURIES, None);
        }
        if let Some(link) = w.crossing {
            // Partway across a link: buried in it when it goes or is newly blocked, cut off when neither end is out.
            let (was, ends) = s.before.links.get(&link)?;
            let Some((now, after)) = s.after.links.get(&link) else {
                return fail(BURIES, None);
            };
            if was.is_none() && now.is_some() {
                return fail(BURIES, None);
            }
            let out = |side: &Side, ends: &[u32]| ends.iter().any(|&q| side.out_piece(q, w.has));
            if out(&s.before, ends) && !out(&s.after, after) {
                return fail(CUTS_OFF, None);
            }
            return None;
        }
        let b = s.before.map.spot_near(frame.node, at, AT_EDGE)?;
        let Some(a) = s.after.map.spot_near(frame.node, at, AT_EDGE) else {
            return fail(BURIES, None);
        };
        if s.before.out(b, w.has) && !s.after.out(a, w.has) {
            return fail(CUTS_OFF, None);
        }
        None
    }
}

/// The rule in one call, for a change judged once: the guard, and its verdict for `bodies` as they stand on the copy.
pub fn check(
    before: &Tree,
    header: &Header,
    ground: Option<Id>,
    part: &Part,
    bodies: &[Who],
) -> Result<(Guard, Vec<Unsafe>), String> {
    let g = guard(before, header, ground, part)?;
    let v = g.judge(bodies);
    Ok((g, v))
}
