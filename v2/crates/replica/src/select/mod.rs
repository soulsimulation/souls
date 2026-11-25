//! Described spots (Engine v2 E2, #2709): a target said in words ("the back row", "the far corner, furthest from the
//! door", "between the two windmills") as a closed list of relations, resolved on a copy of the tree by this shared
//! library, so the client and the server give the same answer at the same version. The thirty it was built for, in
//! Eden, are `thirty.txt` beside this file, fixed before this code.
//!
//! - **Two families.** A [`Spot::Pick`] chooses among things, or among the free slots of things, of a kind in a node:
//!   an anchor (a node, a Soul's body node, or me), an order (nearest, furthest) and a rank (first, last, the Nth),
//!   ties by id and then slot number. Every other relation is a point on one node's own shape (its middle, a corner,
//!   an end, a fraction along it, its edge toward another node, just by it, in front of it, behind it) or between two.
//! - **Facts only.** A shape is what the node's fields say: its outline (11), its line and width (16, 17), its solids
//!   (12, a box footprint), its width (8, an opening in a wall), or else its position. A thing's front is its own +z;
//!   a thing whose footprint is the same turned a quarter (every box centred, as deep as wide) has no front, and
//!   [`Spot::Front`] and [`Spot::Behind`] it are refused `spot.no-front`. Nothing here knows a kind by name.
//! - **Whole numbers.** Positions are µm in x and z (the ground plane), worked in the root's frame through T4's
//!   integer turns; distances are compared squared in `i128`; ties go to the first in id order. Straight distance
//!   only: walking distance belongs to the binding (N9 ranks its places by walking).
//! - **What comes back** ([`Resolved`]) is a slot of a thing, a thing, or a point, with the node whose frame the spot
//!   stands in (the nearest node above the subject that has floor surfaces, else the node just below the root) and
//!   the point in that frame. Where the ground is walkable is `sim`'s, which a client does not load: for a point the
//!   client's verdict on legality is unknown, and the server binds the nearest legal standing spot to it (N9) once,
//!   at commit (`sim::commit::spot`).
//!
//! - **As a target** a described spot is selector number 2 of I5's closed list ([`wire`]), so it stands in an act's
//!   ranked list as a candidate beside named nodes and free-slot selectors.
//!
//! Refusals: `spot.no-front`, `spot.not-a-line` (an end or a fraction along a node with no line), `spot.none` (a pick
//! with no candidate), `spot.rank` (a rank past the last), `spot.no-me` (an anchor of me with no body), `node-missing`,
//! `spot.shape` (a field of the wrong shape).

pub mod wire;

use crate::effects::Refusal;
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::pose::{Quat, Vec3};
use crate::tree::Tree;
use crate::world_model::{plain, show};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The fields a shape is read from (N1's numbers, `v2/tools/import-eden`).
pub const F_WIDTH: u64 = 8;
pub const F_OUTLINE: u64 = 11;
pub const F_SOLIDS: u64 = 12;
pub const F_SLOTS: u64 = 13;
pub const F_SURFACES: u64 = 14;
pub const F_LINE: u64 = 16;

/// How far a spot is put off the shape it is said of (by it, in front, behind) or in from its edge (a corner, an end,
/// an edge), µm.
pub const GAP: i64 = 600_000;

/// A point on the ground plane, µm: x and z.
pub type Xz = [i64; 2];

/// What a nearest or furthest is measured from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Anchor {
    /// The asking body.
    Me,
    /// A node (a Soul is its body's node).
    Node(Id),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
    Nearest,
    Furthest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rank {
    First,
    Last,
    /// The Nth, from 1.
    Nth(u32),
}

/// What a pick chooses among.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Among {
    /// The free slots of the things.
    Slots,
    /// The things.
    Things,
}

/// A described spot: the closed list of relations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Spot {
    /// Among the things of `kind` (or their free slots) that are children of `node`, ordered from `anchor`.
    Pick {
        among: Among,
        kind: Name,
        node: Id,
        order: Order,
        anchor: Anchor,
        rank: Rank,
    },
    Middle(Id),
    /// The corner of the node's outline nearest or furthest from the anchor, stepped in off the edge.
    Corner {
        node: Id,
        order: Order,
        anchor: Anchor,
    },
    /// The end of the node's line nearest or furthest from the anchor, stepped in along it.
    End {
        node: Id,
        order: Order,
        anchor: Anchor,
    },
    /// A fraction (per mille) along the node's line, from its end nearest the anchor.
    Along {
        node: Id,
        permille: u32,
        from: Anchor,
    },
    /// The node's edge nearest another node, stepped in.
    Edge {
        node: Id,
        toward: Id,
    },
    /// Just by the node, on the side toward the anchor.
    By {
        node: Id,
        toward: Anchor,
    },
    Front(Id),
    Behind(Id),
    Between(Id, Id),
}

impl Spot {
    /// The relation's name, as the proof's table shows it.
    pub fn relation(&self) -> &'static str {
        match self {
            Spot::Pick { .. } => "pick",
            Spot::Middle(_) => "middle",
            Spot::Corner { .. } => "corner",
            Spot::End { .. } => "end",
            Spot::Along { .. } => "along",
            Spot::Edge { .. } => "edge",
            Spot::By { .. } => "by",
            Spot::Front(_) => "front",
            Spot::Behind(_) => "behind",
            Spot::Between(..) => "between",
        }
    }
}

/// What a spot resolved to, in the root's frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Slot `slot` (its number in the thing's slots) of `thing`, at `at`.
    Slot { thing: Id, slot: u64, at: Xz },
    /// A thing, at its position.
    Thing { thing: Id, at: Xz },
    /// A point.
    Point { at: Xz },
}

/// An answer, with the node whose frame the spot stands in and the point in that frame (µm, height 0).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub answer: Answer,
    pub frame: Id,
    pub local: Vec3,
}

/// Resolves `spot` on `tree` for a body at `me` (the root's frame), with `held(thing, slot)` the slots taken.
pub fn resolve(
    tree: &Tree,
    spot: &Spot,
    me: Option<Xz>,
    held: &dyn Fn(Id, u64) -> bool,
) -> R<Resolved> {
    let c = View { tree };
    let anchor = |a: &Anchor| -> R<Xz> {
        match a {
            Anchor::Me => me.ok_or_else(|| Refusal {
                name: "spot.no-me",
                detail: "an anchor of me with no body".into(),
            }),
            Anchor::Node(n) => Ok(middle(&c.shape(*n)?)),
        }
    };
    let (answer, subject) = match spot {
        Spot::Pick {
            among,
            kind,
            node,
            order,
            anchor: a,
            rank,
        } => (
            c.pick(*among, kind, *node, *order, anchor(a)?, *rank, held)?,
            *node,
        ),
        Spot::Middle(n) => (point(middle(&c.shape(*n)?)), *n),
        Spot::Corner {
            node,
            order,
            anchor: a,
        } => {
            let s = c.shape(*node)?;
            let corners = match &s {
                Shape::Area(p) | Shape::Line(p) => p.clone(),
                Shape::Point(p) => vec![*p],
            };
            let k = choose(&corners, anchor(a)?, *order);
            (point(step(corners[k], middle(&s), GAP)), *node)
        }
        Spot::End {
            node,
            order,
            anchor: a,
        } => {
            let line = c.line(*node)?;
            let at = anchor(a)?;
            let ends = [line[0], line[line.len() - 1]];
            let p = if choose(&ends, at, *order) == 0 {
                step(line[0], line[1], GAP)
            } else {
                step(line[line.len() - 1], line[line.len() - 2], GAP)
            };
            (point(p), *node)
        }
        Spot::Along {
            node,
            permille,
            from,
        } => {
            let mut line = c.line(*node)?;
            let at = anchor(from)?;
            if d2(line[line.len() - 1], at) < d2(line[0], at) {
                line.reverse();
            }
            (point(along(&line, i128::from(*permille), 1000)), *node)
        }
        Spot::Edge { node, toward } => {
            let (s, t) = (c.shape(*node)?, c.shape(*toward)?);
            let mut best: Option<(i128, Xz)> = None;
            for v in corners(&t) {
                let p = nearest_on(&s, v);
                if best.is_none_or(|(d, _)| d2(p, v) < d) {
                    best = Some((d2(p, v), p));
                }
            }
            for u in corners(&s) {
                let q = nearest_on(&t, u);
                if best.is_none_or(|(d, _)| d2(u, q) < d) {
                    best = Some((d2(u, q), u));
                }
            }
            let p = best.map_or(middle(&s), |(_, p)| p);
            (point(step(p, middle(&s), GAP)), *node)
        }
        Spot::By { node, toward } => {
            let s = c.shape(*node)?;
            let at = anchor(toward)?;
            let b = nearest_on(&s, at);
            let m = middle(&s);
            // Off an area outwards, past its edge; off a line or a point, toward the anchor.
            let p = match s {
                Shape::Area(_) if b != m => step(b, [2 * b[0] - m[0], 2 * b[1] - m[1]], GAP),
                _ => step(b, at, GAP),
            };
            (point(p), *node)
        }
        Spot::Front(n) | Spot::Behind(n) => {
            let (lo, hi) = c.footprint(*n)?;
            let z = if matches!(spot, Spot::Front(_)) {
                hi[1] + GAP
            } else {
                lo[1] - GAP
            };
            let x = c.to_root(*n)?;
            (point(x.xz([(lo[0] + hi[0]) / 2, z])?), *n)
        }
        Spot::Between(a, b) => {
            let (p, q) = (middle(&c.shape(*a)?), middle(&c.shape(*b)?));
            (point([half(p[0] + q[0]), half(p[1] + q[1])]), *a)
        }
    };
    let frame = c.frame_of(subject)?;
    let at = match &answer {
        Answer::Slot { at, .. } | Answer::Thing { at, .. } | Answer::Point { at } => *at,
    };
    let local = c.to_root(frame)?.inverse_xz(at)?;
    Ok(Resolved {
        answer,
        frame,
        local,
    })
}

/// Where a node's own origin is, in the root's frame: where a body standing at it is.
pub fn position(tree: &Tree, id: Id) -> R<Xz> {
    let x = View { tree }.to_root(id)?;
    Ok([x.pos.x, x.pos.z])
}

/// Where a node's own origin is in `frame`'s own frame, on the level (height 0): what a body standing in `frame` turns
/// toward to face it (0.135: a walk to a thing ends facing it).
pub fn origin_in(tree: &Tree, id: Id, frame: Id) -> R<Vec3> {
    let v = View { tree };
    let o = v.to_root(id)?.pos;
    v.to_root(frame)?.inverse_xz([o.x, o.z])
}

/// Twice the area a node's outline covers, µm² (0 for a line or a point): which of a building's rooms is its main one
/// (0.133 Q2).
pub fn area2(tree: &Tree, id: Id) -> R<i128> {
    Ok(match (View { tree }).shape(id)? {
        Shape::Area(a) => (0..a.len())
            .map(|i| {
                let (p, q) = (a[i], a[(i + 1) % a.len()]);
                i128::from(p[0]) * i128::from(q[1]) - i128::from(q[0]) * i128::from(p[1])
            })
            .sum::<i128>()
            .abs(),
        _ => 0,
    })
}

/// How far `at` (a point in `frame`'s own frame) lies from `target`'s shape, on the level, µm: 0 inside its area, else
/// to its outline, its line or its point (0.133: a walk's end says how far from its target it stood).
pub fn gap(tree: &Tree, target: Id, frame: Id, at: Vec3) -> R<i64> {
    let v = View { tree };
    let p = v.to_root(frame)?.xz([at.x, at.z])?;
    Ok(gap_to(&v.shape(target)?, p))
}

/// [`gap`] on a shape in the root's frame.
fn gap_to(s: &Shape, p: Xz) -> i64 {
    let seg = |a: Xz, b: Xz| -> i64 {
        let (ex, ez) = (i128::from(b[0] - a[0]), i128::from(b[1] - a[1]));
        let l2 = (ex * ex + ez * ez).max(1);
        let t = (i128::from(p[0] - a[0]) * ex + i128::from(p[1] - a[1]) * ez).clamp(0, l2);
        let q = [a[0] + (ex * t / l2) as i64, a[1] + (ez * t / l2) as i64];
        d2(p, q).isqrt() as i64
    };
    match s {
        Shape::Point(q) => d2(p, *q).isqrt() as i64,
        Shape::Line(l) => l.windows(2).map(|w| seg(w[0], w[1])).min().unwrap_or(0),
        Shape::Area(a) => {
            // inside by the crossing count, else to the nearest edge
            let mut inside = false;
            for i in 0..a.len() {
                let (u, w) = (a[i], a[(i + 1) % a.len()]);
                if (u[1] > p[1]) != (w[1] > p[1]) {
                    let x = i128::from(u[0])
                        + i128::from(w[0] - u[0]) * i128::from(p[1] - u[1])
                            / i128::from(w[1] - u[1]);
                    if i128::from(p[0]) < x {
                        inside = !inside;
                    }
                }
            }
            if inside {
                0
            } else {
                (0..a.len())
                    .map(|i| seg(a[i], a[(i + 1) % a.len()]))
                    .min()
                    .unwrap_or(0)
            }
        }
    }
}

/// The node a body standing at `id`'s origin stands in (as [`Resolved::frame`]) and that origin in its frame.
pub fn standing(tree: &Tree, id: Id) -> R<(Id, Vec3)> {
    let v = View { tree };
    let frame = v.frame_of(id)?;
    let at = position(tree, id)?;
    Ok((frame, v.to_root(frame)?.inverse_xz(at)?))
}

fn point(at: Xz) -> Answer {
    Answer::Point { at }
}

/// Half, rounded toward minus infinity (the same on every build).
fn half(v: i64) -> i64 {
    v.div_euclid(2)
}

fn d2(a: Xz, b: Xz) -> i128 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    d(a[0], b[0]) + d(a[1], b[1])
}

/// The index of the point nearest (or furthest from) `at`, ties to the first.
fn choose(points: &[Xz], at: Xz, order: Order) -> usize {
    let mut k = 0;
    for (i, p) in points.iter().enumerate() {
        let (d, best) = (d2(*p, at), d2(points[k], at));
        if (order == Order::Nearest && d < best) || (order == Order::Furthest && d > best) {
            k = i;
        }
    }
    k
}

/// `from` moved `by` toward `to`, or `from` itself when they are one point.
fn step(from: Xz, to: Xz, by: i64) -> Xz {
    let len = d2(from, to).isqrt();
    if len == 0 {
        return from;
    }
    let mv = |a: i64, b: i64| a + (i128::from(b - a) * i128::from(by) / len) as i64;
    [mv(from[0], to[0]), mv(from[1], to[1])]
}

/// The point on segment `a`–`b` nearest `p`.
fn on_segment(a: Xz, b: Xz, p: Xz) -> Xz {
    let (dx, dz) = (i128::from(b[0] - a[0]), i128::from(b[1] - a[1]));
    let len2 = dx * dx + dz * dz;
    if len2 == 0 {
        return a;
    }
    let t = (i128::from(p[0] - a[0]) * dx + i128::from(p[1] - a[1]) * dz).clamp(0, len2);
    [a[0] + (dx * t / len2) as i64, a[1] + (dz * t / len2) as i64]
}

/// A node's shape on the ground plane, the root's frame.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Shape {
    /// A closed outline.
    Area(Vec<Xz>),
    /// An open line.
    Line(Vec<Xz>),
    Point(Xz),
}

fn corners(s: &Shape) -> Vec<Xz> {
    match s {
        Shape::Area(p) | Shape::Line(p) => p.clone(),
        Shape::Point(p) => vec![*p],
    }
}

/// The point on the shape's edge (an area's outline, a line, a point) nearest `p`, ties to the first edge.
fn nearest_on(s: &Shape, p: Xz) -> Xz {
    let segs: Vec<(Xz, Xz)> = match s {
        Shape::Point(q) => return *q,
        Shape::Line(l) => l.windows(2).map(|w| (w[0], w[1])).collect(),
        Shape::Area(a) => (0..a.len()).map(|i| (a[i], a[(i + 1) % a.len()])).collect(),
    };
    let mut best = segs[0].0;
    let mut bd = i128::MAX;
    for (a, b) in segs {
        let q = on_segment(a, b, p);
        if d2(q, p) < bd {
            (best, bd) = (q, d2(q, p));
        }
    }
    best
}

/// The point `num / den` of the way along a line.
fn along(line: &[Xz], num: i128, den: i128) -> Xz {
    let lens: Vec<i128> = line.windows(2).map(|w| d2(w[0], w[1]).isqrt()).collect();
    let mut left = lens.iter().sum::<i128>() * num.clamp(0, den) / den;
    for (w, len) in line.windows(2).zip(&lens) {
        if left <= *len {
            return step(w[0], w[1], left as i64);
        }
        left -= len;
    }
    line[line.len() - 1]
}

/// The middle of a shape: an area's centroid (by area, the vertices' mean when it has none), a line's halfway point.
fn middle(s: &Shape) -> Xz {
    match s {
        Shape::Point(p) => *p,
        Shape::Line(l) => along(l, 1, 2),
        Shape::Area(a) => {
            let (mut area2, mut cx, mut cz) = (0i128, 0i128, 0i128);
            for i in 0..a.len() {
                let (p, q) = (a[i], a[(i + 1) % a.len()]);
                let cross =
                    i128::from(p[0]) * i128::from(q[1]) - i128::from(q[0]) * i128::from(p[1]);
                area2 += cross;
                cx += (i128::from(p[0]) + i128::from(q[0])) * cross;
                cz += (i128::from(p[1]) + i128::from(q[1])) * cross;
            }
            if area2 == 0 {
                let n = a.len() as i128;
                let sx: i128 = a.iter().map(|p| i128::from(p[0])).sum();
                let sz: i128 = a.iter().map(|p| i128::from(p[1])).sum();
                return [(sx / n) as i64, (sz / n) as i64];
            }
            [
                cx.div_euclid(3 * area2) as i64,
                cz.div_euclid(3 * area2) as i64,
            ]
        }
    }
}

/// A rigid move into the root's frame.
#[derive(Clone, Copy)]
struct Xform {
    pos: Vec3,
    rot: Quat,
}

fn pose_err(e: impl std::fmt::Debug) -> Refusal {
    Refusal {
        name: "spot.shape",
        detail: format!("{e:?}"),
    }
}

impl Xform {
    fn point(&self, p: Vec3) -> R<Vec3> {
        let r = self.rot.rotate(p).map_err(pose_err)?;
        self.pos.plus(r).map_err(pose_err)
    }

    fn xz(&self, p: Xz) -> R<Xz> {
        let v = self.point(Vec3::new(p[0], 0, p[1]))?;
        Ok([v.x, v.z])
    }

    /// The point `p` of the root's frame in this one, at height 0.
    fn inverse_xz(&self, p: Xz) -> R<Vec3> {
        let [w, x, y, z] = self.rot.parts();
        let back = Quat::new(w, -x, -y, -z)
            .or_else(|_| Quat::new(-w, x, y, z))
            .map_err(pose_err)?;
        let d = Vec3::new(p[0] - self.pos.x, 0, p[1] - self.pos.z);
        let v = back.rotate(d).map_err(pose_err)?;
        Ok(Vec3::new(v.x, 0, v.z))
    }
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn row(v: &Value) -> &[Value] {
    match v {
        Value::Array(a) => a,
        _ => &[],
    }
}

/// Whole millimetres to µm.
fn um(v: &Value) -> R<i64> {
    int(v)
        .map(|n| n * 1000)
        .ok_or_else(|| pose_err("a whole number"))
}

/// The points of a node's outline (11) and line (16) in its own frame, µm, read as a shape is read here; empty for a
/// node with neither, `None` when one does not read (the claim check, #3962).
pub(crate) fn shape_points(fields: &std::collections::BTreeMap<u64, Value>) -> Option<Vec<Vec3>> {
    let mut out = Vec::new();
    for v in [F_OUTLINE, F_LINE].iter().filter_map(|f| fields.get(f)) {
        for p in row(v) {
            let [a, b, ..] = row(p) else { return None };
            out.push(Vec3::new(um(a).ok()?, 0, um(b).ok()?));
        }
    }
    Some(out)
}

/// A point in `id`'s frame (µm) in the root's, or `None` when its path cannot be read (the claim check, #3701).
pub(crate) fn to_root_point(tree: &Tree, id: Id, p: Vec3) -> Option<Vec3> {
    View { tree }.to_root(id).ok()?.point(p).ok()
}

/// [`to_root_point`] as it would be once `moved` (`id` or one of its ancestors) stands in its slot `slot` at
/// `position` and `orientation`, in the same parent: where a move takes `id`'s point.
pub(crate) fn to_root_point_moved(
    tree: &Tree,
    id: Id,
    p: Vec3,
    moved: (Id, Option<u64>, Vec3, Quat),
) -> Option<Vec3> {
    View { tree }
        .to_root_with(id, Some(moved))
        .ok()?
        .point(p)
        .ok()
}

/// The tree as this module reads it.
struct View<'a> {
    tree: &'a Tree,
}

impl View<'_> {
    fn fields(&self, id: Id) -> R<std::collections::BTreeMap<u64, Value>> {
        let h = self.tree.handle(id).ok_or_else(|| Refusal {
            name: "node-missing",
            detail: show(id),
        })?;
        let n = self.tree.node(h).ok_or_else(|| Refusal {
            name: "node-missing",
            detail: show(id),
        })?;
        Ok(n.fields().clone())
    }

    /// The move from `id`'s frame into the root's: the poses on its path, composed from the top down, a slot's own
    /// point and turn between a thing in a slot and its parent.
    fn to_root(&self, id: Id) -> R<Xform> {
        self.to_root_with(id, None)
    }

    /// [`Self::to_root`] with one node's slot and place taken from `moved` instead of the tree.
    fn to_root_with(&self, id: Id, moved: Option<(Id, Option<u64>, Vec3, Quat)>) -> R<Xform> {
        let mut chain = Vec::new();
        let mut at = id;
        loop {
            let h = self.tree.handle(at).ok_or_else(|| Refusal {
                name: "node-missing",
                detail: show(at),
            })?;
            let n = self.tree.node(h).ok_or_else(|| Refusal {
                name: "node-missing",
                detail: show(at),
            })?;
            let Some(parent) = n.parent() else { break };
            let (slot, place) = match moved {
                Some((m, slot, pos, rot)) if m == at => (slot, Some((pos, rot))),
                _ => (n.slot(), n.place().map(|p| (p.position, p.orientation))),
            };
            if let Some((pos, rot)) = place {
                chain.push(Xform { pos, rot });
            }
            if let Some(slot) = slot
                && let Some(r) = self.fields(parent)?.get(&F_SLOTS).and_then(|v| {
                    row(v)
                        .iter()
                        .find(|r| row(r).first().and_then(int) == Some(slot as i64))
                })
            {
                let r = row(r);
                let g = |i: usize| r.get(i).map_or(Ok(0), um);
                chain.push(Xform {
                    pos: Vec3::new(g(1)?, g(2)?, g(3)?),
                    rot: Quat::from_yaw_mdeg(r.get(4).and_then(int).unwrap_or(0))
                        .map_err(pose_err)?,
                });
            }
            at = parent;
        }
        let mut x = Xform {
            pos: Vec3::ZERO,
            rot: Quat::IDENTITY,
        };
        for c in chain.iter().rev() {
            x = Xform {
                pos: x.point(c.pos)?,
                rot: x.rot.then(c.rot).map_err(pose_err)?,
            };
        }
        Ok(x)
    }

    /// The node a spot said of `id` stands in: the nearest at or above it with floor surfaces, else the one just
    /// below the root.
    fn frame_of(&self, id: Id) -> R<Id> {
        let mut at = id;
        let mut below_root = id;
        loop {
            if self.fields(at)?.contains_key(&F_SURFACES) {
                return Ok(at);
            }
            let h = self.tree.handle(at).ok_or_else(|| pose_err("a node"))?;
            let Some(parent) = self.tree.node(h).and_then(|n| n.parent()) else {
                return Ok(below_root);
            };
            below_root = at;
            at = parent;
        }
    }

    fn points(&self, v: &Value, x: &Xform) -> R<Vec<Xz>> {
        row(v)
            .iter()
            .map(|p| match row(p) {
                [a, b, ..] => x.xz([um(a)?, um(b)?]),
                _ => Err(pose_err("a point is [x, z]")),
            })
            .collect()
    }

    /// The box footprint of a thing's solids in its own frame, µm: the least and greatest corner. Refused
    /// `spot.no-front` for a node with none, or whose footprint is the same turned a quarter.
    fn footprint(&self, id: Id) -> R<(Xz, Xz)> {
        let f = self.fields(id)?;
        let boxes = f.get(&F_SOLIDS).map(row).unwrap_or_default();
        let mut lo = [i64::MAX; 2];
        let mut hi = [i64::MIN; 2];
        let mut quarter = true;
        for b in boxes {
            let b = row(b);
            let g = |i: usize| b.get(i).map_or(Ok(0), um);
            let (cx, cz, hx, hz) = (g(0)?, g(1)?, g(2)?, g(3)?);
            let turn =
                Quat::from_yaw_mdeg(b.get(4).and_then(int).unwrap_or(0)).map_err(pose_err)?;
            quarter &= cx == 0 && cz == 0 && hx == hz;
            for (sx, sz) in [(-1, -1), (1, -1), (1, 1), (-1, 1)] {
                let c = turn
                    .rotate(Vec3::new(sx * hx, 0, sz * hz))
                    .map_err(pose_err)?;
                lo = [lo[0].min(cx + c.x), lo[1].min(cz + c.z)];
                hi = [hi[0].max(cx + c.x), hi[1].max(cz + c.z)];
            }
        }
        if boxes.is_empty() || quarter {
            return refuse("spot.no-front", show(id));
        }
        Ok((lo, hi))
    }

    fn shape(&self, id: Id) -> R<Shape> {
        let x = self.to_root(id)?;
        let f = self.fields(id)?;
        if let Some(v) = f.get(&F_OUTLINE) {
            return Ok(Shape::Area(self.points(v, &x)?));
        }
        if let Some(v) = f.get(&F_LINE) {
            return Ok(Shape::Line(self.points(v, &x)?));
        }
        if f.contains_key(&F_SOLIDS) {
            let boxes = f.get(&F_SOLIDS).map(row).unwrap_or_default();
            if !boxes.is_empty() {
                let (lo, hi) = match self.footprint(id) {
                    Ok(b) => b,
                    // A footprint with no front is still a footprint.
                    Err(_) => self.square(boxes)?,
                };
                let c = [
                    [lo[0], lo[1]],
                    [hi[0], lo[1]],
                    [hi[0], hi[1]],
                    [lo[0], hi[1]],
                ];
                return Ok(Shape::Area(c.iter().map(|p| x.xz(*p)).collect::<R<_>>()?));
            }
        }
        if let Some(w) = f.get(&F_WIDTH).map(um).transpose()? {
            return Ok(Shape::Line(vec![x.xz([-w / 2, 0])?, x.xz([w / 2, 0])?]));
        }
        Ok(Shape::Point([x.pos.x, x.pos.z]))
    }

    /// The footprint of centred square boxes.
    fn square(&self, boxes: &[Value]) -> R<(Xz, Xz)> {
        let mut h = 0;
        for b in boxes {
            h = h.max(row(b).get(2).map_or(Ok(0), um)?);
        }
        Ok(([-h, -h], [h, h]))
    }

    fn line(&self, id: Id) -> R<Vec<Xz>> {
        match self.shape(id)? {
            Shape::Line(l) if l.len() >= 2 => Ok(l),
            _ => refuse("spot.not-a-line", show(id)),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn pick(
        &self,
        among: Among,
        kind: &Name,
        node: Id,
        order: Order,
        at: Xz,
        rank: Rank,
        held: &dyn Fn(Id, u64) -> bool,
    ) -> R<Answer> {
        let h = self.tree.handle(node).ok_or_else(|| Refusal {
            name: "node-missing",
            detail: show(node),
        })?;
        let want = plain(kind.as_str());
        let mut found: Vec<(i128, Id, u64, Xz)> = Vec::new();
        for c in self.tree.children(h).unwrap_or_default() {
            let Some(n) = self.tree.node(*c) else {
                continue;
            };
            if plain(n.kind().as_str()) != want {
                continue;
            }
            let thing = n.id();
            let x = self.to_root(thing)?;
            match among {
                Among::Things => found.push((0, thing, 0, [x.pos.x, x.pos.z])),
                Among::Slots => {
                    for r in n.fields().get(&F_SLOTS).map(row).unwrap_or_default() {
                        let r = row(r);
                        let Some(slot) =
                            r.first().and_then(int).and_then(|s| u64::try_from(s).ok())
                        else {
                            continue;
                        };
                        if held(thing, slot) {
                            continue;
                        }
                        let g = |i: usize| r.get(i).map_or(Ok(0), um);
                        found.push((0, thing, slot, x.xz([g(1)?, g(3)?])?));
                    }
                }
            }
        }
        for f in &mut found {
            let d = d2(f.3, at);
            f.0 = if order == Order::Nearest { d } else { -d };
        }
        found.sort_unstable();
        if found.is_empty() {
            return refuse("spot.none", format!("{} in {}", kind.as_str(), show(node)));
        }
        let i = match rank {
            Rank::First => 0,
            Rank::Last => found.len() - 1,
            Rank::Nth(n) => (n as usize).saturating_sub(1),
        };
        let Some(&(_, thing, slot, at)) = found.get(i) else {
            return refuse("spot.rank", format!("{i} of {}", found.len()));
        };
        Ok(match among {
            Among::Things => Answer::Thing { thing, at },
            Among::Slots => Answer::Slot { thing, slot, at },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_square_has_its_middle_its_corners_and_its_edge_in_whole_numbers() {
        let sq = Shape::Area(vec![
            [0, 0],
            [10_000_000, 0],
            [10_000_000, 10_000_000],
            [0, 10_000_000],
        ]);
        assert_eq!(middle(&sq), [5_000_000, 5_000_000]);
        let c = corners(&sq);
        assert_eq!(
            choose(&c, [9_000_000, 1_000_000], Order::Furthest),
            3,
            "the far corner"
        );
        assert_eq!(choose(&c, [9_000_000, 1_000_000], Order::Nearest), 1);
        assert_eq!(nearest_on(&sq, [5_000_000, -3_000_000]), [5_000_000, 0]);
        assert_eq!(
            step([0, 0], [3_000_000, 4_000_000], 500_000),
            [300_000, 400_000]
        );
    }

    #[test]
    fn along_a_line_is_measured_from_its_first_point() {
        let l = vec![[0, 0], [0, 6_000_000], [8_000_000, 6_000_000]];
        assert_eq!(along(&l, 1, 2), [1_000_000, 6_000_000]);
        assert_eq!(along(&l, 0, 1000), [0, 0]);
        assert_eq!(along(&l, 1000, 1000), [8_000_000, 6_000_000]);
        assert_eq!(middle(&Shape::Line(l)), [1_000_000, 6_000_000]);
    }

    /// 0.133: how far a point is from a shape: 0 inside an area, else to its nearest edge; to a line; to a point.
    #[test]
    fn a_gap_is_zero_inside_an_area_and_to_the_nearest_edge_outside() {
        let sq = Shape::Area(vec![
            [0, 0],
            [10_000_000, 0],
            [10_000_000, 10_000_000],
            [0, 10_000_000],
        ]);
        assert_eq!(gap_to(&sq, [5_000_000, 5_000_000]), 0);
        assert_eq!(gap_to(&sq, [5_000_000, -300_000]), 300_000);
        assert_eq!(gap_to(&sq, [13_000_000, 14_000_000]), 5_000_000);
        assert_eq!(
            gap_to(
                &Shape::Line(vec![[0, 0], [0, 6_000_000]]),
                [400_000, 3_000_000]
            ),
            400_000
        );
        assert_eq!(
            gap_to(&Shape::Point([0, 0]), [3_000_000, 4_000_000]),
            5_000_000
        );
    }

    #[test]
    fn ties_go_to_the_first() {
        let pts = [[1, 0], [-1, 0], [0, 1]];
        assert_eq!(choose(&pts, [0, 0], Order::Nearest), 0);
        assert_eq!(choose(&pts, [0, 0], Order::Furthest), 0);
    }
}
