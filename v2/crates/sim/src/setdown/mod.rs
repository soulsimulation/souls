//! Putting a thing down where there is no slot (Engine v2 E4, #2772): a Soul sets what it holds, or what it makes,
//! on the ground or on any surface, at a described spot, facing a described way. No code here names a kind.
//!
//! - **One effect, set down.** The hand's slot hands the thing to an at-rest owner of its motion: T4's rest track
//!   (`Owner::Track(Track::Rest)`, `v2/docs/pose.md` rule 8; [`SetDown::hand_off`]), with the pose kept and the
//!   velocity zero, the same owner a thrown thing lands to (N14). The change of parent is T1's leave and arrive under
//!   one transfer id ([`crate::slots::hands::transfer`]'s shape, with the pose chosen here), so at every position of
//!   the log the thing has exactly one parent. Its new parent is the room or the open ground it stands in, or the
//!   thing it rests on where that thing admits things (a window's sill rests it in the window's room). Its support is
//!   the surface it rests on. "Make at a spot" is the same choice, written as the thing's create there (F4's make);
//!   picking up again is B4's take.
//! - **The words** are Soul Actions' one list (`replica::kinds::place::Word`, `packages/form-rules/placements.json`).
//!   `next_to`, `in_front_of`, `behind`, `against`, `in` and `middle` are E2's described spots (`replica::select`:
//!   by, front, behind, by, middle), resolved on the tree as the client resolves them; `here` is where the body
//!   stands; `on` is the anchor's top, the highest of its boxes the thing fits on, or a window's sill; `facing` turns
//!   the thing where it rests. E2's refusals stand (`spot.no-front` for in front of or behind a thing with none).
//! - **The engine's choice, recorded.** From the spot the words give, the nearest place that fits is taken
//!   ([`Chosen`]: its ring and place, as N9's tables number them): on the ground, rings [`PITCH`] apart out to
//!   [`RINGS`], a place whose middle a body could stand on (N3's ground, never in a doorway or on a stair:
//!   `crate::spots::Ground`), whose footprint overlaps no other thing's and no standing body; on a surface, the
//!   footprint inside the top, turned square to it by the quarter nearest the facing asked, clear of what already
//!   rests there. None: `setdown.no-room`.
//! - **Facing** is toward a node, as it was, or to the wall (its back to the anchor it is set against); a thing whose
//!   kind says it has no front is refused `setdown.no-front` for the first and the last.
//! - **Two outlines** (`replica::kinds::place::Outlines`): what the thing may not overlap (its footprint) and what
//!   walkers go round (its box). A thing made here is given its walk outline as its boxes (N1's solids field), so the
//!   ground is cut round it; a flat thing (a chalk mark, a rug) has none, so setting it down rebuilds no ground. A
//!   thing that already has boxes (an imported crate) keeps them. Which ground a commit touches, and its rebuild on
//!   the tick it commits, are G3's (`crate::ground::touched`, `crate::walk::town::Town::rebuild` and `install`).
//! - **Safe, by G2's one function.** [`judge`] hands the would-be part to the safety rule (`crate::edit::safety`)
//!   with the bodies as they stand: a set-down that would bury a body or leave it no way out is refused by the rule's
//!   name (`edit.would-bury`, `edit.would-cut-off`), naming the Soul, before it commits; it is judged again on the
//!   commit tick against the bodies as they are then.
//!
//! Not here: digging, hanging on walls, throwing (N14), how long a loose thing lasts (F10), the world-side routing of
//! a Soul's act to this effect (C2), walking to the spot (the act's walk, N9).

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};

use replica::edit::Unsafe;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Refusal, Rest,
    TransferRec,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Minter};
use replica::kinds::place::{Facing, Outlines, Word};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Track, Vec3};
use replica::select::{self, Anchor, Spot};
use replica::time::Micros;
use replica::tree::{Handle, Rules, Tree};
use replica::world_model::{Audience, show};

use crate::activity::carry::yaw_toward;
use crate::edit::safety::{self, Who};
use crate::ground::scene::{F_OUTLINE, F_SOLIDS, Terrain, Xform, xform_to};
use crate::ground::{HUMAN_RADIUS, MARGIN};
use crate::slots::hands::Entry;
use crate::spots::Ground;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn err(e: impl std::fmt::Debug) -> Refusal {
    Refusal {
        name: "setdown.frame",
        detail: format!("{e:?}"),
    }
}

/// Between rings on the ground, and between neighbouring places on a ring, µm.
pub const PITCH: i64 = 100_000;
/// Rings round the spot on the ground (3 m).
pub const RINGS: i64 = 30;
/// Between places on a surface, µm.
pub const SURFACE_PITCH: i64 = 50_000;
/// A window's sill, read as a strip this deep across its width (the wall and its ledge), mm: N1's facts give its width and height, not its
/// depth.
pub const SILL_DEPTH: i64 = 400;
/// The least height a thing is counted as having when it meets what stands beside it, mm (a chalk mark meets a rug).
pub const LOW: i64 = 50;
/// N1's fields a window carries (`v2/tools/import-eden`): its width and its sill's height, mm.
pub const F_WIDTH: u64 = 8;
pub const F_SILL: u64 = 10;

/// What is set down: a thing the body holds, or a thing made at the spot (F4's make, with no slot).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum What {
    Held(Id),
    Make(Name),
}

/// A set-down as asked: by whom, what, the words, and the bodies standing (each a Soul's body and where it stands,
/// µm in the root's frame), which no place is chosen under.
#[derive(Clone, Debug)]
pub struct Ask<'a> {
    pub soul: Id,
    pub body: Id,
    pub what: What,
    pub word: Word,
    pub anchor: Option<Id>,
    pub facing: Facing,
    pub bodies: &'a [Vec3],
}

/// The engine's choice: the thing, its new parent, its pose there, what it rests on, and the place taken (its ring
/// and its number on the ring, from the spot the words gave).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chosen {
    pub thing: Id,
    pub parent: Id,
    pub pose: Pose,
    pub surface: Id,
    pub ring: u16,
    pub k: u16,
}

/// A set-down worked out: the choice, the entries of its one part, the hand-off to rest (none for a thing made at
/// rest), and whether the thing has a walk outline (so its commit asks for G3's rebuild).
#[derive(Clone, Debug)]
pub struct SetDown {
    pub chosen: Chosen,
    pub entries: Vec<Entry>,
    pub hand_off: Option<HandOff>,
    pub walk: bool,
}

/// What a set-down reads: the tree, the admit rules, the ground for a body's middle (N9's), a kind's outlines (K3's
/// section 7, `None` for a kind that gives none), the zone's header, and the ids to mint from.
pub struct World<'a> {
    pub tree: &'a Tree,
    pub rules: &'a Rules,
    pub ground: &'a mut dyn Ground,
    pub outlines: &'a dyn Fn(&Name) -> Option<Outlines>,
    pub header: &'a Header,
    pub mint: &'a mut Minter,
}

/// An axis-aligned footprint on the root's ground plane, µm, with its height span.
#[derive(Clone, Copy, Debug)]
struct Foot {
    lo: [i64; 2],
    hi: [i64; 2],
    y0: i64,
    y1: i64,
    /// Its bottom above its own node's origin, µm: what stands on a floor starts near 0.
    base: i64,
}

impl Foot {
    fn meets(&self, lo: [i64; 2], hi: [i64; 2]) -> bool {
        self.lo[0] < hi[0] && lo[0] < self.hi[0] && self.lo[1] < hi[1] && lo[1] < self.hi[1]
    }
}

fn um(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok().map(|n| n * 1000),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| (-1 - n) * 1000),
        _ => None,
    }
}

fn rows(v: &Value) -> &[Value] {
    match v {
        Value::Array(a) => a,
        _ => &[],
    }
}

fn yaw(mdeg: i64) -> R<Quat> {
    Quat::from_yaw_mdeg(mdeg).map_err(err)
}

/// A node's boxes (N1's solids), each as its middle and turn in the node's frame and its half sizes and height span,
/// µm.
fn boxes(tree: &Tree, h: Handle) -> Vec<(Xform, [i64; 2], [i64; 2])> {
    let Some(v) = tree
        .node(h)
        .and_then(|n| n.fields().get(&F_SOLIDS).cloned())
    else {
        return Vec::new();
    };
    rows(&v)
        .iter()
        .filter_map(|r| {
            let n: Vec<i64> = rows(r).iter().filter_map(um).collect();
            let [cx, cz, hx, hz, yaw_um, y0, y1, ..] = n[..] else {
                return None;
            };
            Some((
                Xform {
                    pos: Vec3::new(cx, 0, cz),
                    rot: Quat::from_yaw_mdeg(yaw_um / 1000).ok()?,
                },
                [hx, hz],
                [y0, y1],
            ))
        })
        .collect()
}

fn then(a: &Xform, b: &Xform) -> R<Xform> {
    Ok(Xform {
        pos: a.point(b.pos).map_err(err)?,
        rot: a.rot.then(b.rot).map_err(err)?,
    })
}

fn root_of(tree: &Tree, id: Id) -> R<Xform> {
    let h = tree.handle(id).ok_or_else(|| err(show(id)))?;
    xform_to(tree, h, tree.root()).map_err(err)
}

/// The inverse turn, in its one byte form (q and -q are one turn).
fn inv(q: Quat) -> R<Quat> {
    let [w, x, y, z] = q.parts();
    Quat::new(w, -x, -y, -z)
        .or_else(|_| Quat::new(-w, x, y, z))
        .map_err(err)
}

/// A root-frame point in the frame `x` takes to the root.
fn into(x: &Xform, p: Vec3) -> R<Vec3> {
    inv(x.rot)?
        .rotate(p.minus(x.pos).map_err(err)?)
        .map_err(err)
}

/// The footprint of a box of half sizes `half` turned and placed by `x` (to the root), as root x and z bounds.
fn bounds(x: &Xform, half: [i64; 2]) -> R<([i64; 2], [i64; 2])> {
    let (mut lo, mut hi) = ([i64::MAX; 2], [i64::MIN; 2]);
    for (u, v) in [(-1, -1), (1, -1), (1, 1), (-1, 1)] {
        let p = x
            .point(Vec3::new(u * half[0], 0, v * half[1]))
            .map_err(err)?;
        lo = [lo[0].min(p.x), lo[1].min(p.z)];
        hi = [hi[0].max(p.x), hi[1].max(p.z)];
    }
    Ok((lo, hi))
}

/// The two outlines of a node: its kind's, else read from its boxes (the footprint round them all; walked round when
/// one reaches N3's lowest blocking height).
fn outlines_of(w: &World, h: Handle) -> Option<Outlines> {
    let n = w.tree.node(h)?;
    if let Some(o) = (w.outlines)(n.kind()) {
        return Some(o);
    }
    let bs = boxes(w.tree, h);
    if bs.is_empty() {
        return None;
    }
    let (mut lo, mut hi) = ([i64::MAX; 2], [i64::MIN; 2]);
    let mut top = 0;
    for (x, half, ys) in &bs {
        let (l, u) = bounds(x, *half).ok()?;
        lo = [lo[0].min(l[0]), lo[1].min(l[1])];
        hi = [hi[0].max(u[0]), hi[1].max(u[1])];
        top = top.max(ys[1]);
    }
    // Half the footprint round its middle: the boxes are seldom centred on the origin, so the larger side.
    let hx = lo[0].abs().max(hi[0].abs()) / 1000;
    let hz = lo[1].abs().max(hi[1].abs()) / 1000;
    let top = top / 1000;
    Some(Outlines {
        clear: [hx, hz],
        walk: (top >= replica::kinds::place::FLAT).then_some([hx, top, hz]),
        front: true,
    })
}

/// Every footprint in the world the thing could meet: each box of a node, or a node's kind outline where it has no
/// boxes, in the root's frame. What `skip` names is left out with its subtree, and so is everything in a slot (held,
/// carried or seated: it moves with what holds it); what `own` names is left out but its children are not.
fn feet(w: &World, skip: &BTreeSet<Id>, own: &BTreeSet<Id>) -> Vec<Foot> {
    let tree = w.tree;
    let mut out = Vec::new();
    let mut stack = vec![tree.root()];
    while let Some(h) = stack.pop() {
        let Some(n) = tree.node(h) else { continue };
        if skip.contains(&n.id()) || n.slot().is_some() {
            continue;
        }
        stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
        if own.contains(&n.id()) {
            continue;
        }
        let bs = boxes(tree, h);
        let kind = if bs.is_empty() {
            (w.outlines)(n.kind())
        } else {
            None
        };
        if bs.is_empty() && kind.is_none() {
            continue;
        }
        let Ok(x) = xform_to(tree, h, tree.root()) else {
            continue;
        };
        let mut push = |bx: &Xform, half: [i64; 2], ys: [i64; 2]| {
            if let Ok(b) = then(&x, bx)
                && let Ok((lo, hi)) = bounds(&b, half)
            {
                out.push(Foot {
                    lo,
                    hi,
                    y0: x.pos.y + ys[0],
                    y1: x.pos.y + ys[1],
                    base: ys[0],
                });
            }
        };
        for (bx, half, ys) in &bs {
            push(bx, *half, *ys);
        }
        if let Some(o) = kind {
            let h = o.walk.map_or(0, |w| w[1]) * 1000;
            push(
                &Xform::IDENTITY,
                [o.clear[0] * 1000, o.clear[1] * 1000],
                [0, h],
            );
        }
    }
    out
}

/// The turn that points a thing's front (+z) along `d` (x, z).
fn front_toward(d: [i64; 2]) -> R<Quat> {
    let q = yaw_toward(d)?;
    let mut best: Option<(i128, Quat)> = None;
    for m in [90_000, 270_000] {
        let c = q.then(yaw(m)?).map_err(err)?;
        let f = c.rotate(Vec3::new(0, 0, 1 << 20)).map_err(err)?;
        let dot = i128::from(f.x) * i128::from(d[0]) + i128::from(f.z) * i128::from(d[1]);
        if best.is_none_or(|b| dot > b.0) {
            best = Some((dot, c));
        }
    }
    Ok(best.expect("two turns").1)
}

/// Whether a node's kind admits things as its children.
fn admits_things(rules: &Rules, tree: &Tree, h: Handle) -> bool {
    tree.node(h).is_some_and(|n| {
        rules
            .kinds
            .get(n.kind().as_str())
            .is_some_and(|k| k.children.contains("thing"))
    })
}

/// Whether the root-frame point `p` lies inside node `h`'s outline (N1's `F_OUTLINE`, mm in its frame).
fn holds(tree: &Tree, h: Handle, p: Vec3) -> bool {
    let Some(v) = tree
        .node(h)
        .and_then(|n| n.fields().get(&F_OUTLINE).cloned())
    else {
        return false;
    };
    let Ok(x) = xform_to(tree, h, tree.root()) else {
        return false;
    };
    let Ok(q) = into(&x, p) else { return false };
    let ring: Vec<[i64; 2]> = rows(&v)
        .iter()
        .filter_map(|r| match rows(r) {
            [a, b, ..] => Some([um(a)?, um(b)?]),
            _ => None,
        })
        .collect();
    let mut inside = false;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        if (a[1] > q.z) != (b[1] > q.z) {
            let t = i128::from(b[0] - a[0]) * i128::from(q.z - a[1]);
            let x = i128::from(a[0]) + t / i128::from(b[1] - a[1]);
            if i128::from(q.x) < x {
                inside = !inside;
            }
        }
    }
    inside
}

/// The parent for a thing resting at root point `p` on node `on`: `on` when it admits things, else the child of it
/// whose outline holds `p` and admits things (a floor's room).
fn parent_at(w: &World, on: Id, p: Vec3) -> R<Id> {
    let tree = w.tree;
    let h = tree.handle(on).ok_or_else(|| err(show(on)))?;
    if admits_things(w.rules, tree, h) {
        return Ok(on);
    }
    tree.children(h)
        .unwrap_or(&[])
        .iter()
        .find(|c| admits_things(w.rules, tree, **c) && holds(tree, **c, p))
        .and_then(|c| tree.node(*c).map(|n| n.id()))
        .ok_or_else(|| Refusal {
            name: "setdown.no-room",
            detail: format!("no room of {} holds the spot", show(on)),
        })
}

/// The nearest ancestor of `id` (or `id`) that admits things.
fn admitting(w: &World, id: Id) -> R<Id> {
    let mut at = Some(id);
    while let Some(i) = at {
        let h = w.tree.handle(i).ok_or_else(|| err(show(i)))?;
        if admits_things(w.rules, w.tree, h) {
            return Ok(i);
        }
        at = w.tree.node(h).and_then(|n| n.parent());
    }
    refuse(
        "setdown.no-room",
        format!("nothing above {} admits things", show(id)),
    )
}

/// The pose of a thing at root point `p` turned by root turn `q`, in `parent`'s frame, resting on `surface`.
fn pose_in(tree: &Tree, parent: Id, p: Vec3, q: Quat, surface: Id) -> R<Pose> {
    let x = root_of(tree, parent)?;
    Ok(Pose {
        frame: Frame {
            node: parent,
            slot: None,
        },
        position: into(&x, p)?,
        orientation: inv(x.rot)?.then(q).map_err(err)?,
        support: Support::Surface { surface, height: 0 },
    })
}

/// Where the words put the spot: the node whose frame it stands in and the point there (µm), as E2 resolves it, or
/// where the body stands.
fn spot_of(w: &World, a: &Ask) -> R<(Id, Vec3)> {
    let me = select::position(w.tree, a.body).ok();
    let anchor = || {
        a.anchor.ok_or_else(|| Refusal {
            name: "setdown.no-anchor",
            detail: format!("{} needs an anchor", a.word.name()),
        })
    };
    let spot = match a.word {
        Word::Here => return select::standing(w.tree, a.body),
        Word::NextTo | Word::Against => Spot::By {
            node: anchor()?,
            toward: Anchor::Me,
        },
        Word::InFrontOf => Spot::Front(anchor()?),
        Word::Behind => Spot::Behind(anchor()?),
        Word::In => Spot::Middle(anchor()?),
        Word::Middle => match a.anchor {
            Some(n) => Spot::Middle(n),
            None => {
                // The room the body is in.
                let (frame, _) = select::standing(w.tree, a.body)?;
                let p = root_of(w.tree, a.body)?.pos;
                Spot::Middle(parent_at(w, frame, p)?)
            }
        },
        Word::On | Word::Facing => unreachable!("not a spot on the ground"),
    };
    let r = select::resolve(w.tree, &spot, me, &|_, _| false)?;
    Ok((r.frame, r.local))
}

/// The root turn the facing asks for, for a thing whose spot is root point `at`, its turn now `now`.
fn turn(w: &World, a: &Ask, o: &Outlines, at: Vec3, now: Quat) -> R<Quat> {
    let flat_from = |n: Id| -> R<[i64; 2]> {
        let p = root_of(w.tree, n)?.pos;
        Ok([p.x - at.x, p.z - at.z])
    };
    let wants_front = !matches!(a.facing, Facing::AsItWas);
    if wants_front && !o.front {
        return refuse(
            "setdown.no-front",
            format!("{:?} faces {}", a.what, a.facing.name()),
        );
    }
    match a.facing {
        Facing::AsItWas => Ok(now),
        Facing::Toward(n) => front_toward(flat_from(n)?),
        Facing::ToWall => match a.anchor {
            Some(n) => {
                let d = flat_from(n)?;
                front_toward([-d[0], -d[1]])
            }
            None => Ok(now),
        },
    }
}

/// The half sizes (µm) of a footprint of half sizes `clear` (mm) turned by `q`, on the root's plane.
fn turned(clear: [i64; 2], q: Quat) -> R<[i64; 2]> {
    let x = Xform {
        pos: Vec3::ZERO,
        rot: q,
    };
    let (lo, hi) = bounds(&x, [clear[0] * 1000, clear[1] * 1000])?;
    Ok([(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2])
}

/// Each place on the rings round the origin, in order: (ring, k, offset µm).
fn rings(pitch: i64, n_rings: i64) -> R<Vec<(u16, u16, [i64; 2])>> {
    let mut out = Vec::new();
    for ring in 0..=n_rings {
        let n = if ring == 0 { 1 } else { 6_283 * ring / 1_000 };
        for k in 0..n {
            let off = yaw(k * 360_000 / n)?
                .rotate(Vec3::new(0, 0, ring * pitch))
                .map_err(err)?;
            out.push((ring as u16, k as u16, [off.x, off.z]));
        }
    }
    Ok(out)
}

/// The nearest place on the ground (or a floor) round the spot that fits, with its parent and pose.
fn on_ground(
    w: &mut World,
    a: &Ask,
    thing: Id,
    o: &Outlines,
    now: Quat,
    feet: &[Foot],
) -> R<Chosen> {
    let (node, local) = spot_of(w, a)?;
    let fx = root_of(w.tree, node)?;
    let target = fx.point(local).map_err(err)?;
    let q = turn(w, a, o, target, now)?;
    let half = turned(o.clear, q)?;
    let h = o.walk.map_or(LOW, |w| w[1].max(LOW)) * 1000;
    let clear = (HUMAN_RADIUS + MARGIN) * 1000;
    let near: Vec<&Foot> = feet
        .iter()
        .filter(|f| f.base < h)
        .filter(|f| {
            let r = RINGS * PITCH + half[0].max(half[1]);
            f.meets([target.x - r, target.z - r], [target.x + r, target.z + r])
        })
        .collect();
    let terrain = Terrain::within(
        w.tree,
        node,
        [
            target.x - RINGS * PITCH,
            target.z - RINGS * PITCH,
            target.x + RINGS * PITCH,
            target.z + RINGS * PITCH,
        ],
    )
    .ok()
    .flatten();
    for (ring, k, off) in rings(PITCH, RINGS)? {
        let p = Vec3::new(target.x + off[0], target.y, target.z + off[1]);
        let Some((at, _)) = w.ground.stand(node, into(&fx, p)?) else {
            continue;
        };
        if w.ground.passage(node, at) {
            continue;
        }
        let mut at = at;
        if let Some(t) = &terrain
            && let Some(y) = t.height_at(at.x, at.z)
        {
            at.y = y;
        }
        let p = fx.point(at).map_err(err)?;
        let (lo, hi) = (
            [p.x - half[0], p.z - half[1]],
            [p.x + half[0], p.z + half[1]],
        );
        if near.iter().any(|f| f.meets(lo, hi)) {
            continue;
        }
        let body = |b: &&Vec3| {
            b.x > lo[0] - clear && b.x < hi[0] + clear && b.z > lo[1] - clear && b.z < hi[1] + clear
        };
        if a.bodies.iter().any(|b| body(&b)) {
            continue;
        }
        let parent = parent_at(w, node, p)?;
        return Ok(Chosen {
            thing,
            parent,
            pose: pose_in(w.tree, parent, p, q, node)?,
            surface: node,
            ring,
            k,
        });
    }
    refuse(
        "setdown.no-room",
        format!(
            "no place within {} m of the spot fits",
            RINGS * PITCH / 1_000_000
        ),
    )
}

/// The nearest place on the anchor's top (its highest box the thing fits on, or a window's sill) that fits.
fn on_top(w: &mut World, a: &Ask, thing: Id, o: &Outlines, now: Quat) -> R<Chosen> {
    let tree = w.tree;
    let anchor = a.anchor.ok_or_else(|| Refusal {
        name: "setdown.no-anchor",
        detail: "on needs an anchor".into(),
    })?;
    let ah = tree.handle(anchor).ok_or_else(|| err(show(anchor)))?;
    let ax = root_of(tree, anchor)?;
    // Its tops: each box's (middle and turn, half sizes, height), highest first; or a window's sill.
    let mut tops: Vec<(Xform, [i64; 2], i64)> = boxes(tree, ah)
        .into_iter()
        .map(|(x, half, ys)| (x, half, ys[1]))
        .collect();
    if tops.is_empty() {
        let f = tree
            .node(ah)
            .map(|n| n.fields().clone())
            .unwrap_or_default();
        if let (Some(wd), Some(sill)) = (f.get(&F_WIDTH).and_then(um), f.get(&F_SILL).and_then(um))
        {
            tops.push((Xform::IDENTITY, [wd / 2, SILL_DEPTH * 500], sill));
        }
    }
    tops.sort_by_key(|t| std::cmp::Reverse(t.2));
    if tops.is_empty() {
        return refuse("setdown.no-surface", format!("{} has no top", show(anchor)));
    }
    // What already rests on it: every other footprint whose height span meets the thing's above the top, not the
    // anchor's own boxes nor those of what holds it (the wall a sill is in).
    let mut own = BTreeSet::from([anchor]);
    let mut up = tree.node(ah).and_then(|n| n.parent());
    while let Some(p) = up {
        own.insert(p);
        up = tree
            .handle(p)
            .and_then(|h| tree.node(h))
            .and_then(|n| n.parent());
    }
    let all = feet(w, &BTreeSet::from([thing]), &own);
    let h = o.walk.map_or(LOW, |w| w[1].max(LOW)) * 1000;
    let spots = rings(SURFACE_PITCH, 40)?;
    for (bx, half, top) in tops {
        let x = then(&ax, &bx)?;
        let y = x.pos.y + top;
        // Square to the top: the quarter turn nearest the facing asked.
        let want = turn(w, a, o, x.pos, now)?;
        let mut best: Option<(i128, i64)> = None;
        for m in [0, 90_000, 180_000, 270_000] {
            let c = x.rot.then(yaw(m)?).map_err(err)?;
            let f = c.rotate(Vec3::new(0, 0, 1 << 20)).map_err(err)?;
            let g = want.rotate(Vec3::new(0, 0, 1 << 20)).map_err(err)?;
            let dot = i128::from(f.x) * i128::from(g.x) + i128::from(f.z) * i128::from(g.z);
            if best.is_none_or(|b| dot > b.0) {
                best = Some((dot, m));
            }
        }
        let m = best.expect("four turns").1;
        let q = x.rot.then(yaw(m)?).map_err(err)?;
        let (tu, tv) = if m % 180_000 == 0 {
            (o.clear[0] * 1000, o.clear[1] * 1000)
        } else {
            (o.clear[1] * 1000, o.clear[0] * 1000)
        };
        if tu > half[0] || tv > half[1] {
            continue;
        }
        let half_root = turned(o.clear, q)?;
        let near: Vec<&Foot> = all
            .iter()
            .filter(|f| f.y1 > y + 1_000 && f.y0 < y + h)
            .collect();
        for &(ring, k, off) in &spots {
            if off[0].abs() + tu > half[0] || off[1].abs() + tv > half[1] {
                continue;
            }
            let p = x.point(Vec3::new(off[0], top, off[1])).map_err(err)?;
            let p = Vec3::new(p.x, y, p.z);
            let (lo, hi) = (
                [p.x - half_root[0], p.z - half_root[1]],
                [p.x + half_root[0], p.z + half_root[1]],
            );
            if near.iter().any(|f| f.meets(lo, hi)) {
                continue;
            }
            let parent = admitting(w, anchor)?;
            return Ok(Chosen {
                thing,
                parent,
                pose: pose_in(tree, parent, p, q, anchor)?,
                surface: anchor,
                ring,
                k,
            });
        }
    }
    refuse(
        "setdown.no-room",
        format!("nothing on {} has room for it", show(anchor)),
    )
}

fn mint(m: &mut Minter) -> R<Id> {
    m.mint().map_err(|e| Refusal {
        name: "id-counter-exhausted",
        detail: e.to_string(),
    })
}

/// Works out a set-down at world time `at`: the place it takes and the entries of its one part. Refused by name:
/// `not-held` (the body does not hold the thing), `setdown.no-anchor`, `setdown.no-surface`, `setdown.no-front`,
/// `setdown.no-room`, `setdown.unknown-kind` (a thing made of a kind with no outline), and E2's refusals.
pub fn plan(w: &mut World, a: &Ask, at: Micros) -> R<SetDown> {
    let tree = w.tree;
    let (thing, o, now, held) = match &a.what {
        What::Held(t) => {
            let h = tree.handle(*t).ok_or_else(|| err(show(*t)))?;
            let n = tree.node(h).ok_or_else(|| err(show(*t)))?;
            if n.parent() != Some(a.body) || n.slot().is_none() {
                return refuse(
                    "not-held",
                    format!("{} holds no {}", show(a.body), show(*t)),
                );
            }
            let o = outlines_of(w, h).unwrap_or(Outlines {
                clear: [0, 0],
                walk: None,
                front: true,
            });
            // As it faces in the hand; a hand its body gives no point for faces as the body does.
            let now = root_of(tree, *t).or_else(|_| root_of(tree, a.body))?.rot;
            (*t, o, now, true)
        }
        What::Make(kind) => {
            let o = (w.outlines)(kind).ok_or_else(|| Refusal {
                name: "setdown.unknown-kind",
                detail: format!("{} gives no outline", kind.as_str()),
            })?;
            (mint(w.mint)?, o, root_of(tree, a.body)?.rot, false)
        }
    };
    if a.word == Word::Facing {
        return face(w, a, thing, &o, at);
    }
    let chosen = if a.word == Word::On {
        on_top(w, a, thing, &o, now)?
    } else {
        let mut skip = BTreeSet::from([thing, a.body]);
        skip.extend(
            a.anchor
                .filter(|_| a.word == Word::In || a.word == Word::Middle),
        );
        let feet = feet(w, &skip, &BTreeSet::new());
        on_ground(w, a, thing, &o, now, &feet)?
    };
    let entries = if held {
        let transfer = mint(w.mint)?;
        let audience = tree
            .handle(thing)
            .and_then(|h| tree.node(h))
            .map_or(Audience::Everyone, |n| n.audience());
        vec![
            (
                thing,
                audience,
                Body::Transfer(TransferRec::Leave {
                    transfer,
                    node: thing,
                    lineage: w.header.lineage,
                    zone: w.header.zone,
                    pose: chosen.pose,
                }),
            ),
            (
                chosen.parent,
                audience,
                Body::Transfer(TransferRec::Arrive {
                    transfer,
                    carried: Vec::new(),
                }),
            ),
        ]
    } else {
        let What::Make(kind) = &a.what else {
            unreachable!("made")
        };
        let fields: BTreeMap<u64, Value> = o.solids().map(|s| (F_SOLIDS, s)).into_iter().collect();
        vec![(
            chosen.parent,
            Audience::Everyone,
            Body::Changes(vec![ChangeRec {
                change: Change::Create {
                    node: thing,
                    kind: kind.clone(),
                    pose: chosen.pose,
                    audience: Audience::Everyone,
                    fields,
                },
                rest: Rest::new(),
            }]),
        )]
    };
    let hand_off = held.then_some(HandOff {
        node: thing,
        at,
        from: Owner::Slot,
        to: Owner::Track(Track::Rest),
        pose: chosen.pose,
        linear: Vec3::ZERO,
        angular: Vec3::ZERO,
    });
    Ok(SetDown {
        chosen,
        entries,
        hand_off,
        walk: o.walk.is_some(),
    })
}

/// The word `facing`: the thing turned where it rests, its position untouched.
fn face(w: &mut World, a: &Ask, thing: Id, o: &Outlines, at: Micros) -> R<SetDown> {
    let tree = w.tree;
    let h = tree.handle(thing).ok_or_else(|| err(show(thing)))?;
    let n = tree.node(h).ok_or_else(|| err(show(thing)))?;
    let (Some(parent), None, Some(place)) = (n.parent(), n.slot(), n.place()) else {
        return refuse("setdown.not-resting", format!("{} is held", show(thing)));
    };
    let x = root_of(tree, thing)?;
    let q = turn(w, a, o, x.pos, x.rot)?;
    let px = root_of(tree, parent)?;
    let frame = Frame {
        node: parent,
        slot: None,
    };
    let pose = Pose {
        frame,
        position: place.position,
        orientation: inv(px.rot)?.then(q).map_err(err)?,
        support: place.support,
    };
    let surface = match place.support {
        Support::Surface { surface, .. } => surface,
        _ => parent,
    };
    Ok(SetDown {
        chosen: Chosen {
            thing,
            parent,
            pose,
            surface,
            ring: 0,
            k: 0,
        },
        entries: vec![(
            thing,
            n.audience(),
            Body::Changes(vec![ChangeRec {
                change: Change::Reparent {
                    node: thing,
                    from: frame,
                    pose,
                },
                rest: Rest::new(),
            }]),
        )],
        hand_off: Some(HandOff {
            node: thing,
            at,
            from: Owner::Track(Track::Rest),
            to: Owner::Track(Track::Rest),
            pose,
            linear: Vec3::ZERO,
            angular: Vec3::ZERO,
        }),
        walk: o.walk.is_some(),
    })
}

/// The entries as one part of the zone's log at world time `at`, by the Soul `soul` for its intent `cause`, numbered
/// from `next`.
pub fn part(
    header: &Header,
    next: u64,
    at: Micros,
    soul: Id,
    cause: Cause,
    entries: Vec<Entry>,
) -> R<Part> {
    let effects: Vec<Effect> = entries
        .into_iter()
        .zip(next..)
        .map(|((node, audience, body), sequence)| Effect {
            envelope: Envelope {
                sequence,
                at,
                cause,
                actor: Actor::Soul(soul),
                audience,
                node,
            },
            body,
            events: None,
            rest: Rest::new(),
        })
        .collect();
    let bytes = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(header.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ])))
    .map_err(|e| Refusal {
        name: "encoding",
        detail: e.to_string(),
    })?;
    Part::read(&bytes)
}

/// G2's verdict on the would-be part for the bodies as they stand (`ground` the zone's open ground): refused by the
/// first unsafe body's name (`edit.would-bury`, `edit.in-use`, `edit.would-cut-off`), naming the Soul, else `Ok`.
pub fn judge(
    tree: &Tree,
    header: &Header,
    ground: Option<Id>,
    part: &Part,
    bodies: &[Who],
) -> R<Vec<Unsafe>> {
    let (_, v) = safety::check(tree, header, ground, part, bodies).map_err(|e| Refusal {
        name: "setdown.unsafe-check",
        detail: e,
    })?;
    match v.first() {
        Some(u) => Err(Refusal {
            name: u.name,
            detail: format!("{} at {}", show(u.soul), show(u.node)),
        }),
        None => Ok(v),
    }
}
