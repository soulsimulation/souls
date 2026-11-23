//! The walkable ground, cut from the tree (Engine v2 N3, #2651): for one node and one body radius, the patch where
//! that body's centre may stand, from the exact geometry the tree holds. No raster.
//!
//! - **What is cut.** A floor node's surfaces, or a 16 m square of the open ground (the design started at 32 m; Eden's
//!   busiest 32 m square took 8.5 ms to cut, its busiest 16 m one 2.6 ms). A floor is shrunk by the radius
//!   plus [`MARGIN`]; the open ground's square edges are no walls and are not shrunk. From either, the union of every
//!   box whose height span meets the body's ([`BODY_LOW`] to [`BODY_HIGH`] above the floor) is taken away, grown by
//!   the same amount, and so are the doorways (a doorway is never floor), the floors of buildings standing on the
//!   open ground (each is a node of its own) and the waters, which are cut beside it ([`OpenGround::cut_water`]).
//! - **Ground cover.** A floor on the open ground that holds no room and lies within [`STEP`] of the ground
//!   (Eden's footpaths, lawns, garden beds, shores, piers) is not a node of its own to walk: it is open ground, added
//!   back over any water it lies on, so a pier reaches out over the sea. A body on it stays on the open ground (its
//!   support, at the ground's height, T4 rule 6), crossing its edge is no hop and no transfer, and a named place
//!   holds nobody (T2). Its thing's boxes (a pier's rails, a court's posts) are cut like any other. Its floor node
//!   has no ground of its own (`ground-cover`).
//! - **Steps.** A floor of a building on the open ground, whose outline's edge bounds a surface within [`STEP`] of the
//!   ground (a shop's porch, 100 mm up), steps down there: each such edge is a doorway of no depth (`Doorway::step`),
//!   taken from neither side, whose passage is cut like any doorway's. N4 makes it a link from the floor to the
//!   ground where its passage meets both ([`crate::links::Kind::Step`]). Inside a floor, two surfaces that share a
//!   stretch of edge and lie within [`STEP`] of each other in height (a bridge's deck, quads 100 to 145 mm apart) are
//!   cut as two heights, each shrunk at that edge like any other; the stretch is a step too, at the height between
//!   them, which N4 makes a link from the floor to itself (#3224). Surfaces further apart are joined only by a stair.
//!   Boxes overlap and cross the floor's edge, so they are a union taken away, never a list of holes; a floor may
//!   fall into several pieces, and each piece is cut into triangles that keep its edges (`i_triangle`, then
//!   Delaunay flips).
//! - **The grid.** Union and difference run on whole millimetres (`i_overlay` on `i32`), the one grid. Growing is a
//!   Minkowski sum, plus 1 mm for rounding a point onto the grid: a box with the octagon in its own axes (its faces
//!   move out by exactly the amount, so a doorway's width is exact), anything else with a 16-gon; both have edges that
//!   touch the true circle and corners rounded outwards, so a grown corner always lies outside the true arc.
//! - **Doorways.** A doorway link meets a patch where the clear passage through it (the opening, run through the wall
//!   to both sides, less the grown boxes) overlaps a piece: a [`Meet`] records that segment, which side of the wall
//!   it is on, its height and the width left for the centre at the doorway's middle. A shut door is the link's state
//!   (N4, #2652), never an obstacle.
//! - **Height.** Every vertex is `[x, y, z]` in whole millimetres in the node's frame (T4, #2644: never a 2D point on a
//!   floor). A floor's vertices carry its surface's height. The open ground's are at 0, its plan: the routes, the
//!   doorways' meets and the spots read it as one level. Its heights are the terrain's (N11a, #2735, from N1b's
//!   `scene::Terrain`, read by [`OpenGround::of`]): the mover reads them at the point inside every triangle that
//!   lies on the terrain ([`OpenGround::on_terrain`], `crate::mover::Surface::on_terrain`), and a triangle with a
//!   corner or its middle over water (ground cover: a pier, a shore) keeps 0, the cover's height as before. Cutting
//!   through every 1 m sample instead made Eden's open ground 24 times the triangles and slowed N15's thousand
//!   walkers past real time; heights on the vertices made the routes' one level many.
//! - **Things on the terrain.** What stands on the open ground is measured from the ground under it, not from the
//!   plan's 0 (#3227; `scene::Terrain::ground`: the terrain's height there, or 0 where that is nearer, as over water
//!   under a pier): a floor is ground cover within [`STEP`] of it, a footprint below [`BODY_HIGH`] above it, a
//!   doorway or a step meets the open ground's plan from its height above it, and an outline step steps down to it.
//!   So Eden's 94 floors of buildings on its hills (a cottage 10.3 m up) are joined to the open ground like the
//!   town's. A box on the open ground is measured from the ground under its middle (#3241), so a fence or a tree on
//!   a hill blocks at its foot as on flat ground; a doorway's wall and passage are read against the boxes at the
//!   doorway's height above the ground.
//! - **Steep cells.** A 1 m cell whose slope is above [`STEEP`] (a rise over run of 0.5774, today's) is taken from
//!   the open ground before its cover is added back: no centre stands on it, so the mover slides along its edge and
//!   a route goes round it. Cells are taken as they are, not grown by the radius: a body's edge may hang over one.
//! - **Water** (N11b, #3198). Each water in a square, less the ground cover over it (a pier) and the waters before it
//!   in the scene (a river's mouth in a lake), with the same boxes taken away, is that square's water patch: pieces of
//!   their own kind ([`Piece::ground`]) beside the dry ground. Its edge is the water's own outline. A 1 m terrain cell
//!   whose bed at its middle lies more than [`crate::gaits::WADE_DEPTH`] under the water's level is swimming water,
//!   a piece at the water's level ([`Ground::Water`]); the rest is wading ground, on the bed (its triangles lie on the
//!   terrain, [`OpenGround::on_terrain`]). The line between the two is the cells' edge. With no terrain, a water is
//!   all swimming water. Dry ground, wading ground and water meet edge to edge: crossing between them is a shore link
//!   naming its move (`crate::routes`, N11c, #3218), so the mover, on one ground, slides along such an edge.
//! - **Where it lives.** Here in `sim`, native only. An agent's client never loads the ground: where a described spot
//!   is a point, the server binds the legal standing spot (E2, #2709).
//! - **Versions** (G3, #2760). Each node's ground has a version ([`Versions`]), bumped when a committed part changes
//!   what its scene is read from ([`touched`]): a node's shape fields, its place, its parent, it coming or going, a
//!   link at it. A change inside a building touches every floor of it; one not under a floor of a building (the
//!   building itself, a floor's surfaces, a wall on the open ground) touches the open ground too. The would-be ground
//!   of the touched nodes is cut off the clock thread from the tree as the part leaves it, and installed on the tick
//!   the part commits (`crate::walk::town::Town::install`): no tick sees new geometry over old ground. A route
//!   records the versions it was planned on, and the walk is planned again on a mismatch (`crate::unstick`).
//! - **Seated parts** (N19, #3341). A part seated in a bay is fixed geometry: its boxes are cut like any other's. A
//!   thing riding a slot its parent gives no point for (`F_SLOTS`: a body's hands, a crew's carry) is carried, and is
//!   not cut. A part moved to a new parent with its boxes (a transfer, not a creator's edit) touches its old ground and
//!   its new, so the commit that seats or takes it asks for G3's rebuild (`crate::activity::seating::Seating::write`).
//!   A body standing where a part would be seated is found by [`scene::stands_in`].
//!
//! A [`Turn`] moves the node's geometry into a turned and shifted frame before it is put on the grid; the door table
//! (36 yaws, 25 offsets) uses it to show the cut does not depend on where the grid falls.

// The repeat rule (K12, v2/clippy.toml): the patch map is a lookup, never iterated, so its order reaches nothing.
#![allow(clippy::disallowed_types)]

pub mod exits;
pub mod open;
pub mod scene;
pub mod sizes;

use crate::gaits::{Ground, WADE_DEPTH};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::{Overlay, ShapeType};
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::i_float::int::point::IntPoint;
use i_overlay::i_shape::int::shape::{IntShape, IntShapes};
use i_triangle::int::triangulatable::IntTriangulatable;
use replica::effects::{Body, Change, Part, Refusal, TransferRec};
use replica::ids::Id;
use replica::kinds::sizes::Size;
use replica::pose::{Quat, Vec3};
use replica::tree::Tree;
use replica::world_model::plain;
pub use scene::{Doorway, Scene, Solid, Surface, Terrain, Water};
use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// The clearance kept beyond the body's radius, mm.
pub const MARGIN: i64 = 60;
/// The body's height span above the floor, mm: a box that meets it blocks.
pub const BODY_LOW: i64 = 220;
pub const BODY_HIGH: i64 = 1_800;
/// The highest a floor with no room may lie above the ground and still be ground cover, walked as the open ground,
/// mm: what a body steps over, as a box lower than [`BODY_LOW`] never blocks it.
pub const STEP: i64 = BODY_LOW;
/// The open ground's square, mm.
pub const SQUARE: i64 = 16_000;
/// The steepest slope a body stands on, parts per million (rise over run, today's 0.5774: 30°).
pub const STEEP: i64 = 577_400;
/// The terrain's cell, mm.
const CELL: i32 = 1_000;
/// Today's walking body, mm (`HUMAN_PROFILE`): the standard size class. Other bodies are cut for their own class
/// (B12, `replica::kinds::sizes::Size`): one cut per class, kept by [`Cache`] per radius.
pub const HUMAN_RADIUS: i64 = Size::Standard.radius_mm();
/// A doorway's depth either side of its middle when no wall flanks it, mm.
const DOOR_HALF_DEPTH: i64 = 100;
/// How far the passage through a doorway runs past the grown wall, so that it overlaps the patch on each side, mm. A
/// modelled floor may stop short of its wall's inner face (the Mars campus's Mimos: 100 mm), and its door must still
/// meet it.
const PASSAGE_REACH: i64 = 150;
/// How far a doorway's end on the grown wall's face may lie off the floor it meets and stay there, mm: the walker's
/// own reach for a leg's end on its piece's edge (`walk::town`'s `AT_EDGE`). Further off, the end is put on the floor's
/// edge ([`meets`]).
const MEET_SHORT: i64 = 20;

type P = IntPoint<i32>;

/// A turn and shift applied to a node's geometry before it is put on the grid (the identity for a real cut).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Turn {
    pub yaw_mdeg: i64,
    pub dx_um: i64,
    pub dz_um: i64,
}

impl Turn {
    pub const NONE: Turn = Turn {
        yaw_mdeg: 0,
        dx_um: 0,
        dz_um: 0,
    };
}

/// One piece of a patch: its outline (outer ring counter-clockwise, then holes), its triangles and the ground it is
/// (dry, or wading ground or water: [`OpenGround::cut_water`]).
#[derive(Clone, Debug)]
pub struct Piece {
    pub outline: Vec<Vec<[i32; 3]>>,
    pub vertices: Vec<[i32; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub ground: Ground,
}

/// Where a doorway link meets a piece: the segment `a`–`b` (mm, with height) where the passage's narrowest width
/// reaches this side's piece, the side of the wall (+1 the way the opening faces, −1 behind it), and that width left
/// for the centre at the doorway's middle (0: nothing passes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Meet {
    pub link: Id,
    pub piece: u32,
    pub side: i8,
    pub a: [i32; 3],
    pub b: [i32; 3],
    pub width_left: i64,
    /// The passage through the doorway is one piece, wider than nothing, reaching a piece of this patch on both sides.
    pub through: bool,
    /// The doorway is a step off a low floor (`scene::Doorway::step`): a link of no tree.
    pub step: bool,
}

/// One square's wet pieces, each with its water's index ([`OpenGround::cut_water`]).
pub type Wet = Vec<(u32, Piece)>;

/// The walkable ground of one node (or one square of the open ground) for one radius.
#[derive(Clone, Debug)]
pub struct Patch {
    pub radius: i64,
    pub pieces: Vec<Piece>,
    pub meets: Vec<Meet>,
}

fn mm(um: i64) -> i64 {
    let h = if um < 0 { -500 } else { 500 };
    (um + h) / 1000
}

fn quat(mdeg: i64) -> Result<Quat, String> {
    Quat::from_yaw_mdeg(mdeg).map_err(|e| format!("{e:?}"))
}

/// Moves a node-frame point (µm) by the turn and puts it on the millimetre grid.
fn on_grid(q: &Quat, t: &Turn, p: [i64; 2]) -> Result<P, String> {
    let r = q
        .rotate(Vec3::new(p[0], 0, p[1]))
        .map_err(|e| format!("{e:?}"))?;
    let (x, z) = (mm(r.x + t.dx_um), mm(r.z + t.dz_um));
    let ok = |v: i64| i32::try_from(v).ok().filter(|v| v.abs() < 1 << 29);
    Ok(P::new(
        ok(x).ok_or("a point off the grid")?,
        ok(z).ok_or("a point off the grid")?,
    ))
}

fn area2(r: &[P]) -> i64 {
    let mut a = 0i64;
    for k in 0..r.len() {
        let (p, q) = (r[k], r[(k + 1) % r.len()]);
        a += i64::from(p.x) * i64::from(q.y) - i64::from(q.x) * i64::from(p.y);
    }
    a
}

/// Counter-clockwise, so that overlapping rings add under the non-zero rule and never cancel.
fn ccw(mut r: Vec<P>) -> Vec<P> {
    if area2(&r) < 0 {
        r.reverse();
    }
    r
}

/// The convex hull, counter-clockwise (monotone chain, exact on integers).
fn hull(mut pts: Vec<P>) -> Vec<P> {
    pts.sort_by_key(|p| (p.x, p.y));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: P, a: P, b: P| {
        i64::from(a.x - o.x) * i64::from(b.y - o.y) - i64::from(a.y - o.y) * i64::from(b.x - o.x)
    };
    let mut h: Vec<P> = Vec::with_capacity(pts.len() * 2);
    for pass in 0..2 {
        let start = h.len();
        let it: Box<dyn Iterator<Item = &P>> = if pass == 0 {
            Box::new(pts.iter())
        } else {
            Box::new(pts.iter().rev())
        };
        for &p in it {
            while h.len() >= start + 2 && cross(h[h.len() - 2], h[h.len() - 1], p) <= 0 {
                h.pop();
            }
            h.push(p);
        }
        h.pop();
    }
    h
}

/// The 16-gon round the origin whose edges touch the circle of radius `d` and whose corners are rounded outwards:
/// corners at 11.25° + k·22.5°, each coordinate `d` times tan 11.25°, 0.8478 or 0.5665 or 1 (per million, rounded up).
fn sixteen(d: i64) -> [P; 16] {
    const K: [i64; 4] = [1_000_000, 847_760, 566_455, 198_913];
    let up = |k: i64| ((d * k + 999_999) / 1_000_000) as i32;
    let q: [(i32, i32); 4] = [
        (up(K[0]), up(K[3])),
        (up(K[1]), up(K[2])),
        (up(K[2]), up(K[1])),
        (up(K[3]), up(K[0])),
    ];
    let mut out = [P::new(0, 0); 16];
    for (k, &(a, b)) in q.iter().enumerate() {
        out[k] = P::new(a, b);
        out[4 + k] = P::new(-b, a);
        out[8 + k] = P::new(-a, -b);
        out[12 + k] = P::new(b, -a);
    }
    out
}

/// A convex ring grown by `d` (its Minkowski sum with the 16-gon), counter-clockwise.
fn grow(ring: &[P], d: i64) -> Vec<P> {
    let g = sixteen(d);
    hull(
        ring.iter()
            .flat_map(|p| g.iter().map(move |o| P::new(p.x + o.x, p.y + o.y)))
            .collect(),
    )
}

/// A box (its four corners, µm, in order) grown by `d` mm in its own axes: its faces move out by exactly `d`, its
/// corners are cut at 45° by the octagon whose edges touch the circle (tan 22.5° per million, rounded up), so they
/// lie outside the true arc. Eight points, µm; `None` for a box with no width.
fn grow_box(c: &[[i64; 2]; 4], d: i64) -> Option<[[i64; 2]; 8]> {
    let (e1, e2) = (
        [c[1][0] - c[0][0], c[1][1] - c[0][1]],
        [c[3][0] - c[0][0], c[3][1] - c[0][1]],
    );
    let len = |e: [i64; 2]| (e[0] * e[0] + e[1] * e[1]).isqrt();
    let (l1, l2) = (len(e1), len(e2));
    if l1 == 0 || l2 == 0 {
        return None;
    }
    let (dd, da) = (d * 1000, (d * 414_214 + 999) / 1000);
    let up = |v: i64, k: i64, l: i64| (v.abs() * k + l - 1) / l * v.signum();
    let sc = |e: [i64; 2], k: i64, l: i64| [up(e[0], k, l), up(e[1], k, l)];
    let (u, ua, v, va) = (
        sc(e1, dd, l1),
        sc(e1, da, l1),
        sc(e2, dd, l2),
        sc(e2, da, l2),
    );
    let at = |p: [i64; 2], su: i64, a: [i64; 2], sv: i64, b: [i64; 2]| {
        [p[0] + su * a[0] + sv * b[0], p[1] + su * a[1] + sv * b[1]]
    };
    Some([
        at(c[0], -1, u, -1, va),
        at(c[0], -1, ua, -1, v),
        at(c[1], 1, ua, -1, v),
        at(c[1], 1, u, -1, va),
        at(c[2], 1, u, 1, va),
        at(c[2], 1, ua, 1, v),
        at(c[3], -1, ua, 1, v),
        at(c[3], -1, u, 1, va),
    ])
}

/// The 16-gon corner whose sector (from corner `k` to corner `k + 1`, counter-clockwise) holds direction `v`.
fn sector(g: &[P; 16], v: (i64, i64)) -> usize {
    let cross = |a: P, v: (i64, i64)| i64::from(a.x) * v.1 - i64::from(a.y) * v.0;
    (0..16)
        .find(|&k| cross(g[k], v) >= 0 && cross(g[(k + 1) % 16], v) < 0)
        .unwrap_or(0)
}

/// What shrinking the shapes by `d` takes away: along each edge, the band `d` deep on its inner side (the left, as
/// `i_overlay` writes outer rings counter-clockwise and holes clockwise), its depth rounded outwards; and at each
/// reflex corner, where the bands leave a gap, the 16-gon's fan from the one band's end to the other's, from the
/// corner before the gap to the corner after it. A convex corner needs none: there the two bands overlap.
fn edges_grown(shapes: &IntShapes<i32>, d: i64, out: &mut Vec<Vec<P>>) {
    let g = sixteen(d);
    for c in shapes.iter().flatten() {
        let n = c.len();
        let normal = |a: P, b: P| {
            let (ex, ez) = (i64::from(b.x - a.x), i64::from(b.y - a.y));
            let len = (ex * ex + ez * ez).isqrt().max(1);
            // The inward normal times d, each part rounded away from zero, so the band is never short.
            let up = |v: i64| (v.abs() * d + len - 1) / len * v.signum();
            (up(-ez), up(ex))
        };
        for k in 0..n {
            let (a, b, o) = (c[k], c[(k + 1) % n], c[(k + 2) % n]);
            if a == b {
                continue;
            }
            let (nx, nz) = normal(a, b);
            out.push(vec![
                a,
                b,
                P::new(b.x + nx as i32, b.y + nz as i32),
                P::new(a.x + nx as i32, a.y + nz as i32),
            ]);
            let (ex, ez) = (i64::from(b.x - a.x), i64::from(b.y - a.y));
            let (fx, fz) = (i64::from(o.x - b.x), i64::from(o.y - b.y));
            let turn = ex * fz - ez * fx;
            if o != b && (turn < 0 || (turn == 0 && ex * fx + ez * fz < 0)) {
                let (s1, s2) = (sector(&g, (nx, nz)), sector(&g, normal(b, o)));
                let mut fan = vec![b];
                let mut k = s2;
                while k != (s1 + 2) % 16 {
                    fan.push(P::new(b.x + g[k].x, b.y + g[k].y));
                    k = (k + 1) % 16;
                }
                out.push(fan);
            }
        }
    }
}

fn op(subj: &[Vec<P>], clip: &[Vec<P>], rule: OverlayRule) -> IntShapes<i32> {
    let mut o = Overlay::new(subj.len() + clip.len());
    for c in subj {
        o.add_contour(c, ShapeType::Subject);
    }
    for c in clip {
        o.add_contour(c, ShapeType::Clip);
    }
    o.overlay(rule, FillRule::NonZero)
}

fn shapes_op(subj: &IntShapes<i32>, clip: &[Vec<P>], rule: OverlayRule) -> IntShapes<i32> {
    let mut o = Overlay::new(64 + clip.len());
    for s in subj {
        o.add_source(s, ShapeType::Subject);
    }
    for c in clip {
        o.add_contour(c, ShapeType::Clip);
    }
    o.overlay(rule, FillRule::NonZero)
}

fn bounds(r: &[P]) -> [i32; 4] {
    let mut b = [i32::MAX, i32::MAX, i32::MIN, i32::MIN];
    for p in r {
        b = [b[0].min(p.x), b[1].min(p.y), b[2].max(p.x), b[3].max(p.y)];
    }
    b
}

fn meets_box(b: &[i32; 4], c: &[i32; 4]) -> bool {
    b[0] <= c[2] && c[0] <= b[2] && b[1] <= c[3] && c[1] <= b[3]
}

/// A doorway on the grid: its middle, a unit along the wall and through it (as millimetres per metre), and the clear
/// passage's extent.
struct Door {
    link: Id,
    at: P,
    along: [i64; 2],
    across: [i64; 2],
    half: i64,
    y: i64,
    /// The open ground's height under it, µm (its terrain's, #3227): the open ground's cut, whose plan is at 0, meets
    /// a doorway at `y` less this. 0 on a floor.
    ground: i64,
    /// Through the wall: from `n0` to `n1` mm along `across`.
    n0: i64,
    n1: i64,
    step: bool,
}

impl Door {
    fn point(&self, s_along: i64, s_across: i64) -> P {
        let x = i64::from(self.at.x) + (s_along * self.along[0] + s_across * self.across[0]) / 1000;
        let z = i64::from(self.at.y) + (s_along * self.along[1] + s_across * self.across[1]) / 1000;
        P::new(x as i32, z as i32)
    }
    fn coords(&self, p: P) -> (i64, i64) {
        let (dx, dz) = (i64::from(p.x - self.at.x), i64::from(p.y - self.at.y));
        (
            (dx * self.along[0] + dz * self.along[1]) / 1000,
            (dx * self.across[0] + dz * self.across[1]) / 1000,
        )
    }
    fn rect(&self, a0: i64, a1: i64, n0: i64, n1: i64) -> Vec<P> {
        vec![
            self.point(a0, n0),
            self.point(a1, n0),
            self.point(a1, n1),
            self.point(a0, n1),
        ]
    }
}

fn inside_convex(r: &[P], p: P) -> bool {
    let s = area2(r).signum();
    (0..r.len()).all(|k| {
        let (a, b) = (r[k], r[(k + 1) % r.len()]);
        let c = i64::from(b.x - a.x) * i64::from(p.y - a.y)
            - i64::from(b.y - a.y) * i64::from(p.x - a.x);
        c * s >= 0
    })
}

/// A scene on the grid, grown for one radius: what every cut of it (a floor's, or each square's) takes away.
struct Grown {
    /// By surface height: the surfaces at that height (a floor) and what is taken from them.
    levels: Vec<(i64, Vec<Vec<P>>)>,
    /// Grown boxes, each with its height span and bounds.
    boxes: Vec<(Vec<P>, i64, i64, [i32; 4])>,
    /// Grown doorways and footprints (with their heights): never walkable.
    never: Vec<(Vec<P>, i64, [i32; 4])>,
    /// Waters, taken from the open ground before its cover is added back.
    waters: Vec<(Vec<P>, [i32; 4])>,
    /// For each of `waters`, the index of its water in the scene and that water's level, µm.
    wet: Vec<(u32, i64)>,
    /// Ground cover: open ground, over water too.
    covers: Vec<(Vec<P>, [i32; 4])>,
    /// The bounds of the open ground's named places: they only widen the squares cut.
    areas: Vec<[i32; 4]>,
    doors: Vec<Door>,
    d: i64,
}

fn spans(y0: i64, y1: i64, floor: i64) -> bool {
    y1 > floor + BODY_LOW * 1000 && y0 < floor + BODY_HIGH * 1000
}

fn prepare(s: &Scene, radius: i64, t: Turn) -> Result<Grown, String> {
    let q = quat(t.yaw_mdeg)?;
    let d = radius + MARGIN + 1;
    let g = |p: [i64; 2]| on_grid(&q, &t, p);
    let mut levels: Vec<(i64, Vec<Vec<P>>)> = Vec::new();
    for sf in &s.surfaces {
        let r = ccw(sf.ring.iter().map(|p| g(*p)).collect::<Result<_, _>>()?);
        match levels.iter_mut().find(|(y, _)| *y == sf.y) {
            Some((_, v)) => v.push(r),
            None => levels.push((sf.y, vec![r])),
        }
    }
    let mut boxes = Vec::with_capacity(s.solids.len());
    let mut flat = Vec::with_capacity(s.solids.len());
    for b in &s.solids {
        let r: Vec<P> = b.ring.iter().map(|p| g(*p)).collect::<Result<_, _>>()?;
        let gr = match grow_box(&b.ring, d) {
            Some(oct) => hull(oct.iter().map(|p| g(*p)).collect::<Result<_, _>>()?),
            None => grow(&r, d),
        };
        let bb = bounds(&gr);
        // On the open ground a box is measured from the ground under its middle, as a footprint is (#3241): a fence
        // on a hill spans the body at its foot as on flat ground. The open ground's plan, cut at 0, meets it there.
        let lift = if s.open {
            let (x, z) = b
                .ring
                .iter()
                .fold((0, 0), |(x, z), p| (x + p[0] / 4, z + p[1] / 4));
            Terrain::ground(s.terrain.as_ref(), x, z, b.y0)
        } else {
            0
        };
        flat.push((r, b.y0 - lift, b.y1 - lift));
        boxes.push((gr, b.y0 - lift, b.y1 - lift, bb));
    }
    let mut never = Vec::new();
    let mut doors = Vec::new();
    let o = g([0, 0])?;
    for dw in &s.doorways {
        let at = g(dw.at)?;
        let unit = |v: [i64; 2]| -> Result<[i64; 2], String> {
            let e = g(v)?;
            Ok([i64::from(e.x - o.x), i64::from(e.y - o.y)])
        };
        // The axes are a metre long in µm, so on the grid they are millimetres per metre.
        let (along, across) = (unit(dw.along)?, unit(dw.across)?);
        let mut door = Door {
            link: dw.link,
            at,
            along,
            across,
            half: dw.width / 2000,
            y: dw.y,
            ground: if s.open {
                Terrain::ground(s.terrain.as_ref(), dw.at[0], dw.at[1], dw.y)
            } else {
                0
            },
            n0: -DOOR_HALF_DEPTH,
            n1: DOOR_HALF_DEPTH,
            step: dw.step,
        };
        if dw.step {
            // A step has no depth and is floor on one side and ground on the other: nothing is taken from either.
            (door.n0, door.n1) = (0, 0);
            doors.push(door);
            continue;
        }
        // Its depth is the wall's: the boxes either side of the opening, just past its edges.
        let flank = [
            door.point(-door.half - 50, 0),
            door.point(door.half + 50, 0),
        ];
        for (r, y0, y1) in &flat {
            if spans(*y0, *y1, dw.y - door.ground) && flank.iter().any(|f| inside_convex(r, *f)) {
                // A box of the door's own wall runs along it. One that meets the opening end-on (a corridor's side
                // wall starting at the jamb) runs through it, and would make the whole corridor doorway.
                let cs: Vec<(i64, i64)> = r.iter().map(|p| door.coords(*p)).collect();
                let span = |f: fn(&(i64, i64)) -> i64| {
                    cs.iter().map(f).max().unwrap_or(0) - cs.iter().map(f).min().unwrap_or(0)
                };
                if span(|c| c.1) > span(|c| c.0) {
                    continue;
                }
                for (_, n) in cs {
                    door.n0 = door.n0.min(n);
                    door.n1 = door.n1.max(n);
                }
            }
        }
        let rect = door.rect(-door.half, door.half, door.n0, door.n1);
        let gr = grow(&rect, d);
        let bb = bounds(&gr);
        never.push((gr, dw.y - door.ground, bb));
        doors.push(door);
    }
    for f in &s.footprints {
        // A building on the terrain is a footprint where its floor stands on the ground under it (#3227).
        if scene::above_ground(s.terrain.as_ref(), f) < BODY_HIGH * 1000 {
            let r = ccw(f.ring.iter().map(|p| g(*p)).collect::<Result<_, _>>()?);
            // Grown outwards: the ring turned clockwise has the outside on its left.
            let mut parts = Vec::new();
            let cw: Vec<P> = r.iter().rev().copied().collect();
            edges_grown(&vec![vec![cw]], d, &mut parts);
            parts.push(r);
            for p in parts {
                let bb = bounds(&p);
                never.push((p, i64::MIN, bb));
            }
        }
    }
    let (mut waters, mut wet) = (Vec::new(), Vec::new());
    for (k, w) in s.waters.iter().enumerate() {
        if w.ring.len() >= 3 {
            let r = ccw(w.ring.iter().map(|p| g(*p)).collect::<Result<_, _>>()?);
            let bb = bounds(&r);
            waters.push((r, bb));
        }
        if w.line.len() >= 2 {
            // A river: its line there and back is a ring of no area, whose bands are the river's two halves.
            let mut ring: Vec<P> = w.line.iter().map(|p| g(*p)).collect::<Result<_, _>>()?;
            let back: Vec<P> = ring[1..ring.len() - 1].iter().rev().copied().collect();
            ring.extend(back);
            let mut parts = Vec::new();
            edges_grown(&vec![vec![ring]], w.width / 2000 + 1, &mut parts);
            for r in parts {
                let bb = bounds(&r);
                waters.push((r, bb));
            }
        }
        wet.resize(waters.len(), (k as u32, w.level));
    }
    let mut covers = Vec::new();
    for c in &s.covers {
        let r = ccw(c.ring.iter().map(|p| g(*p)).collect::<Result<_, _>>()?);
        let bb = bounds(&r);
        covers.push((r, bb));
    }
    let mut areas = Vec::new();
    for a in s.areas.iter().filter(|a| !a.is_empty()) {
        areas.push(bounds(
            &a.iter().map(|p| g(*p)).collect::<Result<Vec<_>, _>>()?,
        ));
    }
    Ok(Grown {
        levels,
        boxes,
        never,
        waters,
        wet,
        covers,
        areas,
        doors,
        d,
    })
}

/// Cuts `subj` (already the walkable area before boxes) at floor height `y`, keeping to `window` when given.
fn cut_level(g: &Grown, subj: IntShapes<i32>, y: i64, window: Option<[i32; 4]>) -> IntShapes<i32> {
    let hit = |b: &[i32; 4]| window.is_none_or(|w| meets_box(b, &w));
    let mut clip: Vec<Vec<P>> = Vec::new();
    for (r, y0, y1, bb) in &g.boxes {
        if spans(*y0, *y1, y) && hit(bb) {
            clip.push(r.clone());
        }
    }
    for (r, dy, bb) in &g.never {
        if (*dy == i64::MIN || (*dy - y).abs() < BODY_HIGH * 1000) && hit(bb) {
            clip.push(r.clone());
        }
    }
    shapes_op(&subj, &clip, OverlayRule::Difference)
}

fn piece(shape: &IntShape<i32>, y: i64, ground: Ground) -> Piece {
    let y = mm(y) as i32;
    let t = shape
        .triangulate()
        .into_delaunay()
        .into_raw()
        .into_triangulation::<u32>();
    Piece {
        outline: shape
            .iter()
            .map(|c| c.iter().map(|p| [p.x, y, p.y]).collect())
            .collect(),
        vertices: t.points.iter().map(|p| [p.x, y, p.y]).collect(),
        triangles: t.indices.chunks(3).map(|c| [c[0], c[1], c[2]]).collect(),
        ground,
    }
}

/// Whether `p` lies inside `shape` (its outer ring less its holes) and on none of its edges.
fn strictly_inside(shape: &IntShape<i32>, p: P) -> bool {
    let mut odd = false;
    for c in shape {
        for k in 0..c.len() {
            let (a, b) = (c[k], c[(k + 1) % c.len()]);
            let cross = i64::from(b.x - a.x) * i64::from(p.y - a.y)
                - i64::from(b.y - a.y) * i64::from(p.x - a.x);
            let within = |u: i32, v: i32, w: i32| u.min(v) <= w && w <= u.max(v);
            if cross == 0 && within(a.x, b.x, p.x) && within(a.y, b.y, p.y) {
                return false;
            }
            if (a.y > p.y) != (b.y > p.y) {
                // Where the edge crosses the point's row, compared without dividing.
                let lhs = i64::from(p.x - a.x) * i64::from(b.y - a.y);
                let rhs = i64::from(b.x - a.x) * i64::from(p.y - a.y);
                if (b.y > a.y && lhs < rhs) || (b.y < a.y && lhs > rhs) {
                    odd = !odd;
                }
            }
        }
    }
    odd
}

/// Whether `p` lies inside or on any of `rings` (each one closed ring, any winding).
fn in_any(rings: &[Vec<P>], p: P) -> bool {
    rings.iter().any(|r| {
        let shape: IntShape<i32> = vec![r.clone()];
        strictly_inside(&shape, p)
            || (0..r.len()).any(|k| {
                let (a, b) = (r[k], r[(k + 1) % r.len()]);
                let cross = i64::from(b.x - a.x) * i64::from(p.y - a.y)
                    - i64::from(b.y - a.y) * i64::from(p.x - a.x);
                cross == 0
                    && a.x.min(b.x) <= p.x
                    && p.x <= a.x.max(b.x)
                    && a.y.min(b.y) <= p.y
                    && p.y <= a.y.max(b.y)
            })
    })
}

/// Where the ring `cs` (a doorway's own axes: along, across) lies nearest to `face` on the line across the doorway at
/// `s` along it: `face` itself when that point is inside the ring, else the nearest crossing of the ring's outline;
/// none when the line misses the ring.
fn nearest_across(cs: &[(i64, i64)], s: i64, face: i64) -> Option<i64> {
    let mut hits = Vec::new();
    for k in 0..cs.len() {
        let (a, b) = (cs[k], cs[(k + 1) % cs.len()]);
        if a.0.min(b.0) <= s && s < a.0.max(b.0) {
            hits.push(a.1 + (b.1 - a.1) * (s - a.0) / (b.0 - a.0));
        }
    }
    if hits.iter().filter(|&&n| n <= face).count() % 2 == 1 {
        return Some(face);
    }
    hits.into_iter().min_by_key(|n| (n - face).abs())
}

/// The doorways' meets with the pieces just cut (all at height `y`).
fn meets(
    g: &Grown,
    shapes: &IntShapes<i32>,
    first: u32,
    y: i64,
    within: Option<[i32; 4]>,
    out: &mut Vec<Meet>,
) {
    let reach = g.d + PASSAGE_REACH;
    for door in &g.doors {
        if (door.y - door.ground - y).abs() >= BODY_LOW * 1000 {
            continue;
        }
        let q0 = door.rect(-door.half, door.half, door.n0 - reach, door.n1 + reach);
        let window = bounds(&q0);
        if within.is_some_and(|w| !meets_box(&w, &window)) {
            continue;
        }
        let mut clip = Vec::new();
        for (r, y0, y1, bb) in &g.boxes {
            if spans(*y0, *y1, door.y - door.ground) && meets_box(bb, &window) {
                clip.push(r.clone());
            }
        }
        let passage = op(&[q0], &clip, OverlayRule::Difference);
        let strip = door.rect(-door.half - 1, door.half + 1, -1, 1);
        let middle = shapes_op(&passage, &[strip], OverlayRule::Intersect);
        // The narrowest cross-section, at the doorway's middle: its widest piece is the portal.
        let (mut a0, mut a1) = (0, 0);
        for sh in &middle {
            let a: Vec<i64> = sh[0].iter().map(|p| door.coords(*p).0).collect();
            let (lo, hi) = (*a.iter().min().unwrap_or(&0), *a.iter().max().unwrap_or(&0));
            if hi - lo > a1 - a0 {
                (a0, a1) = (lo, hi);
            }
        }
        let width_left = a1 - a0;
        let mut sides = [false, false];
        // Each part of the passage on a piece: the piece, its ring in the doorway's own axes (along, across), its
        // side of the wall and the part of the narrowest width that reaches it.
        let mut parts = Vec::new();
        for (k, sh) in shapes.iter().enumerate() {
            let both = shapes_op(&passage, sh, OverlayRule::Intersect);
            for part in &both {
                let cs: Vec<(i64, i64)> = part[0].iter().map(|p| door.coords(*p)).collect();
                let mid = cs.iter().map(|c| c.1).sum::<i64>() / cs.len().max(1) as i64;
                let side: i8 = if mid >= 0 { 1 } else { -1 };
                // The segment is the part of the narrowest width that reaches this piece: where a box beyond the
                // wall leaves the piece only one side of the doorway, the middle of the whole width lies off it.
                let lo = cs.iter().map(|c| c.0).min().unwrap_or(a0).max(a0);
                let hi = cs.iter().map(|c| c.0).max().unwrap_or(a1).min(a1);
                let (s0, s1) = if lo <= hi { (lo, hi) } else { (a0, a1) };
                sides[usize::from(side > 0)] = true;
                parts.push((first + k as u32, cs, side, s0, s1));
            }
        }
        // A side's segments lie on the grown wall's face, where ground cut by that wall ends. A floor whose own
        // outline stops short of the face (a modelled floor: the Mars campus's Mimos, 50 mm) leaves that end off
        // every piece, where a route took it for a portal and no walker could aim at it (W8, #4084): the side's
        // segments are then put on the floor's edge nearest the face. Only a floor is measured (`within` is a square
        // of the open ground, which the grown wall itself cuts), and only when no piece of the side comes within
        // [`MEET_SHORT`] of the face along its own segment's middle.
        let face = |side: i8| {
            if side > 0 {
                door.n1 + g.d
            } else {
                door.n0 - g.d
            }
        };
        let line = [1i8, -1].map(|side| {
            let f = face(side);
            if within.is_some() {
                return f;
            }
            let near = parts
                .iter()
                .filter(|p| p.2 == side)
                .filter_map(|(_, cs, _, s0, s1)| nearest_across(cs, (s0 + s1) / 2, f))
                .min_by_key(|n| (n - f).abs());
            match near {
                Some(n) if (n - f) * i64::from(side) > MEET_SHORT => n,
                _ => f,
            }
        });
        let mut found = Vec::new();
        for (piece, _, side, s0, s1) in parts {
            let n = line[usize::from(side < 0)];
            let (pa, pb) = (door.point(s0, n), door.point(s1, n));
            let ym = mm(y) as i32;
            found.push(Meet {
                link: door.link,
                piece,
                side,
                a: [pa.x, ym, pa.y],
                b: [pb.x, ym, pb.y],
                width_left,
                through: false,
                step: door.step,
            });
        }
        let through = passage.len() == 1 && width_left > 0 && sides == [true, true];
        for mut m in found {
            m.through = through;
            out.push(m);
        }
    }
}

fn square_ring(w: [i32; 4]) -> Vec<P> {
    vec![
        P::new(w[0], w[1]),
        P::new(w[2], w[1]),
        P::new(w[2], w[3]),
        P::new(w[0], w[3]),
    ]
}

/// The patch of a floor scene for one radius, turned by `t` before it is put on the grid.
pub fn cut_floor(s: &Scene, radius: i64, t: Turn) -> Result<Patch, String> {
    let g = prepare(s, radius, t)?;
    let mut patch = Patch {
        radius,
        pieces: Vec::new(),
        meets: Vec::new(),
    };
    for (y, rings) in &g.levels {
        let floor = op(rings, &[], OverlayRule::Union);
        let mut shrink = Vec::new();
        edges_grown(&floor, g.d, &mut shrink);
        let floor = shapes_op(&floor, &shrink, OverlayRule::Difference);
        let shapes = cut_level(&g, floor, *y, None);
        let first = patch.pieces.len() as u32;
        meets(&g, &shapes, first, *y, None, &mut patch.meets);
        patch
            .pieces
            .extend(shapes.iter().map(|sh| piece(sh, *y, Ground::Dry)));
    }
    Ok(patch)
}

/// The open ground, prepared once for one radius: every square is cut from it, on its terrain when it has one.
pub struct OpenGround(Grown, Option<Terrain>);

impl OpenGround {
    /// The open ground of `s`, flat at 0.
    pub fn prepare(s: &Scene, radius: i64) -> Result<OpenGround, String> {
        prepare(s, radius, Turn::NONE).map(|g| OpenGround(g, None))
    }

    /// The open ground node `ground` of `tree`, on the terrain it holds (N1b, #3197), if any.
    pub fn of(tree: &Tree, ground: Id, radius: i64) -> Result<OpenGround, String> {
        let s = Scene::of(tree, ground)?;
        let mut o = OpenGround::prepare(&s, radius)?;
        o.1 = s.terrain;
        Ok(o)
    }

    /// The terrain it is cut on, if any.
    pub fn terrain(&self) -> Option<&Terrain> {
        self.1.as_ref()
    }

    /// Per piece of `pieces` (cut from this open ground, dry or wet), per triangle: whether it lies on the terrain, so
    /// that its heights are the terrain's. Not when there is no terrain; on dry ground, not when a corner or the middle
    /// of the triangle lies in or on a water's outline (ground cover over water keeps 0). Wading ground lies on it (its
    /// bed), water never (its level).
    pub fn on_terrain(&self, pieces: &[Piece]) -> Vec<Vec<bool>> {
        let wet = |p: P| {
            self.0.waters.iter().any(|(r, bb)| {
                bb[0] <= p.x
                    && p.x <= bb[2]
                    && bb[1] <= p.y
                    && p.y <= bb[3]
                    && in_any(std::slice::from_ref(r), p)
            })
        };
        pieces
            .iter()
            .map(|pc| {
                if pc.ground != Ground::Dry {
                    let on = self.1.is_some() && pc.ground == Ground::Wading;
                    return vec![on; pc.triangles.len()];
                }
                pc.triangles
                    .iter()
                    .map(|t| {
                        let c = t.map(|k| {
                            let v = pc.vertices[k as usize];
                            P::new(v[0], v[2])
                        });
                        let mid = P::new(
                            ((i64::from(c[0].x) + i64::from(c[1].x) + i64::from(c[2].x)) / 3)
                                as i32,
                            ((i64::from(c[0].y) + i64::from(c[1].y) + i64::from(c[2].y)) / 3)
                                as i32,
                        );
                        self.1.is_some() && !c.iter().chain([&mid]).any(|&p| wet(p))
                    })
                    .collect()
            })
            .collect()
    }

    /// The same open ground on terrain `t`.
    pub fn on(mut self, t: Terrain) -> OpenGround {
        self.1 = Some(t);
        self
    }

    /// The squares that hold anything, as (i, j) with the square from (i·[`SQUARE`], j·[`SQUARE`]).
    pub fn squares(&self) -> Vec<(i32, i32)> {
        let mut b = [i32::MAX, i32::MAX, i32::MIN, i32::MIN];
        let g = &self.0;
        for bb in g
            .boxes
            .iter()
            .map(|x| &x.3)
            .chain(g.never.iter().map(|x| &x.2))
            .chain(g.waters.iter().chain(&g.covers).map(|x| &x.1))
            .chain(&g.areas)
        {
            b = [
                b[0].min(bb[0]),
                b[1].min(bb[1]),
                b[2].max(bb[2]),
                b[3].max(bb[3]),
            ];
        }
        if b[0] > b[2] {
            return Vec::new();
        }
        let sq = SQUARE as i32;
        let mut out = Vec::new();
        for j in b[1].div_euclid(sq)..=b[3].div_euclid(sq) {
            for i in b[0].div_euclid(sq)..=b[2].div_euclid(sq) {
                out.push((i, j));
            }
        }
        out
    }

    /// Every square's patch, in [`OpenGround::squares`]' order (S5, 0.133): the squares are cut on as many threads
    /// as the machine has, each square on its own (a cut reads only the ground), and put back in order, so the
    /// answer is the same as cutting them one by one.
    pub fn cut_all(&self) -> Vec<((i32, i32), Patch)> {
        self.each_square(|i, j| self.cut_square(i, j))
    }

    /// Every square's wet pieces ([`OpenGround::cut_water`]), as [`OpenGround::cut_all`] cuts the dry ones.
    pub fn cut_all_water(&self) -> Vec<((i32, i32), Wet)> {
        self.each_square(|i, j| self.cut_water(i, j))
    }

    /// `f` of every square, on as many threads as the machine has, in [`OpenGround::squares`]' order.
    fn each_square<T: Send>(&self, f: impl Fn(i32, i32) -> T + Sync) -> Vec<((i32, i32), T)> {
        let squares = self.squares();
        let threads = std::thread::available_parallelism()
            .map_or(1, std::num::NonZeroUsize::get)
            .min(squares.len().max(1));
        let chunk = squares.len().div_ceil(threads).max(1);
        let f = &f;
        std::thread::scope(|s| {
            let parts: Vec<_> = squares
                .chunks(chunk)
                .map(|c| {
                    s.spawn(move || {
                        c.iter()
                            .map(|&(i, j)| ((i, j), f(i, j)))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            parts
                .into_iter()
                .flat_map(|h| h.join().unwrap_or_else(|e| std::panic::resume_unwind(e)))
                .collect()
        })
    }

    /// One square's patch.
    pub fn cut_square(&self, i: i32, j: i32) -> Patch {
        let sq = SQUARE as i32;
        let w = [i * sq, j * sq, (i + 1) * sq, (j + 1) * sq];
        let g = &self.0;
        let near = |v: &[(Vec<P>, [i32; 4])]| -> Vec<Vec<P>> {
            v.iter()
                .filter(|(_, bb)| meets_box(bb, &w))
                .map(|(r, _)| r.clone())
                .collect()
        };
        let (wet, cover) = (near(&g.waters), near(&g.covers));
        let mut open = op(&[square_ring(w)], &wet, OverlayRule::Difference);
        // The terrain's steep cells in the square, taken away in runs along x.
        let n = (SQUARE as i32 / CELL) as usize;
        if let Some(t) = &self.1 {
            let um = |v: i32| i64::from(v) * 1000;
            let mut steep: Vec<Vec<P>> = Vec::new();
            for r in 0..=n {
                let z = w[1] + r as i32 * CELL;
                let mut run: Option<i32> = None;
                for c in 0..=n {
                    let x = w[0] + c as i32 * CELL;
                    let is = r < n
                        && c < n
                        && t.slope_at(um(x) + 500_000, um(z) + 500_000)
                            .is_some_and(|s| s > STEEP);
                    match (run, is) {
                        (None, true) => run = Some(x),
                        (Some(x0), false) => {
                            steep.push(square_ring([x0, z, x, z + CELL]));
                            run = None;
                        }
                        _ => {}
                    }
                }
            }
            if !steep.is_empty() {
                open = shapes_op(&open, &steep, OverlayRule::Difference);
            }
        }
        if !cover.is_empty() {
            // The cover inside the square, added back over the water it lies on (a pier, a shore).
            let on = op(&cover, &[square_ring(w)], OverlayRule::Intersect);
            let on: Vec<Vec<P>> = on.into_iter().flatten().collect();
            open = shapes_op(&open, &on, OverlayRule::Union);
        }
        let shapes = cut_level(g, open, 0, Some(w));
        let mut meets_out = Vec::new();
        meets(&self.0, &shapes, 0, 0, Some(w), &mut meets_out);
        let pieces = shapes.iter().map(|sh| piece(sh, 0, Ground::Dry)).collect();
        Patch {
            radius: self.0.d - MARGIN - 1,
            pieces,
            meets: meets_out,
        }
    }
}

impl OpenGround {
    /// One square's water patch (N11b, #3198): its wading ground and water pieces, each with the index of its water in
    /// the scene's waters ([`Scene::waters`]), in that order.
    pub fn cut_water(&self, i: i32, j: i32) -> Vec<(u32, Piece)> {
        let sq = SQUARE as i32;
        let w = [i * sq, j * sq, (i + 1) * sq, (j + 1) * sq];
        let g = &self.0;
        // What is not this water's: the cover over it, then each water before it.
        let mut taken: Vec<Vec<P>> = g
            .covers
            .iter()
            .filter(|(_, bb)| meets_box(bb, &w))
            .map(|(r, _)| r.clone())
            .collect();
        let mut out = Vec::new();
        let mut k = 0;
        while k < g.waters.len() {
            let (water, level) = g.wet[k];
            let mut rings = Vec::new();
            while k < g.waters.len() && g.wet[k].0 == water {
                if meets_box(&g.waters[k].1, &w) {
                    rings.push(g.waters[k].0.clone());
                }
                k += 1;
            }
            if rings.is_empty() {
                continue;
            }
            let mine = op(&rings, &[square_ring(w)], OverlayRule::Intersect);
            let mine = shapes_op(&mine, &taken, OverlayRule::Difference);
            if mine.is_empty() {
                continue;
            }
            taken.extend(mine.iter().flatten().cloned());
            // The cells deeper than wading, in runs along x.
            let (swim, wade) = match &self.1 {
                None => (mine, Vec::new()),
                Some(t) => {
                    let n = SQUARE as i32 / CELL;
                    let um = |v: i32| i64::from(v) * 1000;
                    let mut deep: Vec<Vec<P>> = Vec::new();
                    for r in 0..n {
                        let z = w[1] + r * CELL;
                        let mut run: Option<i32> = None;
                        for c in 0..=n {
                            let x = w[0] + c * CELL;
                            let is = c < n
                                && t.height_at(um(x) + 500_000, um(z) + 500_000)
                                    .is_some_and(|bed| level - bed > WADE_DEPTH);
                            match (run, is) {
                                (None, true) => run = Some(x),
                                (Some(x0), false) => {
                                    deep.push(square_ring([x0, z, x, z + CELL]));
                                    run = None;
                                }
                                _ => {}
                            }
                        }
                    }
                    (
                        shapes_op(&mine, &deep, OverlayRule::Intersect),
                        shapes_op(&mine, &deep, OverlayRule::Difference),
                    )
                }
            };
            for (shapes, y, ground) in [(swim, level, Ground::Water), (wade, 0, Ground::Wading)] {
                if shapes.is_empty() {
                    continue;
                }
                let shapes = cut_level(g, shapes, 0, Some(w));
                out.extend(shapes.iter().map(|sh| (water, piece(sh, y, ground))));
            }
        }
        out
    }
}

/// How a commit that is not a creator's edit asks for G3's rebuild (N19, #3341): called with the tree as it stood
/// before `part` and the part, once the part is committed, it rebuilds the ground the part touches and installs it
/// before the next tick (`crate::walk::town::Town::rebuild` and `Town::install`, through what holds the town).
pub type Rebuild = Box<dyn FnMut(Tree, &Part) -> Result<(), Refusal>>;

/// Each node's ground version (G3, #2760): 0 until a committed part first touches it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Versions(BTreeMap<Id, u64>);

impl Versions {
    pub fn of(&self, node: Id) -> u64 {
        self.0.get(&node).copied().unwrap_or(0)
    }

    /// Whether no ground has changed yet.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// One more for each node of `nodes`.
    pub fn bump<'a>(&mut self, nodes: impl IntoIterator<Item = &'a Id>) {
        for n in nodes {
            *self.0.entry(*n).or_default() += 1;
        }
    }
}

/// The fields a scene is read from: a change to any other (a door's open field, a name) leaves the ground as it was.
/// A floor's stairs, ramps and ladders (`crate::links::F_STAIRS`) are read with it: they are the map's links (G2b).
const SHAPE: [u64; 12] = [
    crate::links::F_STAIRS,
    scene::F_OPEN_DOOR_LINK,
    scene::F_OUTLINE,
    scene::F_SOLIDS,
    scene::F_SURFACES,
    scene::F_LINE,
    scene::F_LINE_WIDTH,
    scene::F_WATER_LEVEL,
    scene::F_PLACE_OF,
    scene::F_DOORWAYS,
    scene::F_TILE_SIZE,
    scene::F_TILES,
];

/// The nodes whose ground a change at node `id` of `tree` changes (see the module's notes), added to `out`.
fn grounds_of(tree: &Tree, id: Id, out: &mut BTreeSet<Id>) {
    let kind = |h| tree.node(h).map(|n| plain(n.kind().as_str()).to_owned());
    let mut up = tree.handle(id);
    let mut under_floor = false;
    while let Some(h) = up {
        let k = kind(h).unwrap_or_default();
        if k == scene::GROUND {
            out.insert(tree.node(h).map_or(id, |n| n.id()));
            return;
        }
        let kids = tree.children(h).unwrap_or(&[]);
        let floors: Vec<Id> = kids
            .iter()
            .filter(|&&c| kind(c).as_deref() == Some(scene::FLOOR))
            .filter_map(|&c| tree.node(c).map(|n| n.id()))
            .collect();
        if !floors.is_empty() {
            out.extend(floors);
            if under_floor {
                return;
            }
        }
        if k == scene::FLOOR && tree.node(h).is_some_and(|n| n.id() != id) {
            under_floor = true;
        }
        up = tree
            .node(h)
            .and_then(|n| n.parent())
            .and_then(|p| tree.handle(p));
    }
}

/// The nodes whose ground the committed part `part` changes: read in `before` (the tree it was applied to) for what
/// it moves or removes, and in `after` for what it places or moves. Motion samples change no ground.
pub fn touched(before: &Tree, after: &Tree, part: &Part) -> BTreeSet<Id> {
    let ids = changed(before, part);
    let mut out = BTreeSet::new();
    grounds(before, &ids, &mut out);
    grounds(after, &ids, &mut out);
    out
}

/// The nodes whose ground a change at the nodes `ids` changes, read in `tree`, added to `out`: [`touched`] is these
/// in the tree before the part and in the tree after it.
pub fn grounds(tree: &Tree, ids: &[Id], out: &mut BTreeSet<Id>) {
    for &id in ids {
        grounds_of(tree, id, out);
    }
}

/// The nodes the committed part `part` changes in a way its ground reads (see [`touched`]), read in `before` (the tree
/// it was applied to) for what it moves or removes.
pub fn changed(before: &Tree, part: &Part) -> Vec<Id> {
    let mut ids = Vec::new();
    for e in &part.effects {
        let changes = match &e.body {
            Body::Changes(changes) => changes,
            // A thing with boxes moved to a new parent (a part seated or taken out, N19 #3341): its old ground and
            // its new. A body or a crew's node has none, so a body's hop through a doorway touches nothing.
            Body::Transfer(TransferRec::Leave { node, .. }) => {
                let solid = |h| {
                    before
                        .node(h)
                        .is_some_and(|n| n.fields().contains_key(&scene::F_SOLIDS))
                };
                if before.handle(*node).is_some_and(solid) {
                    ids.push(*node);
                }
                continue;
            }
            _ => continue,
        };
        for c in changes {
            match &c.change {
                // A node made with no field a scene is read from (a chalk mark set down, E4 #2772) cuts no ground.
                Change::Create { fields, .. } if !SHAPE.iter().any(|f| fields.contains_key(f)) => {}
                Change::Create { node, .. }
                | Change::Remove { node }
                | Change::Reparent { node, .. } => ids.push(*node),
                Change::Set { node, field, .. } if SHAPE.contains(field) => ids.push(*node),
                Change::Link { ends, .. } => ids.extend(ends),
                Change::Unlink { link } => {
                    if let Some((_, ends, ..)) = before.link(*link) {
                        ids.extend(ends);
                    }
                }
                _ => {}
            }
        }
    }
    ids
}

/// Patches kept per node, node version and radius (G3, #2760, rebuilds one on an edit by asking with the new version).
#[derive(Default)]
pub struct Cache {
    map: HashMap<(Id, u64, i64), Patch>,
}

impl Cache {
    /// A floor node's patch at `version` for `radius`, cut from the tree only when it is not already kept.
    pub fn floor(
        &mut self,
        tree: &Tree,
        node: Id,
        version: u64,
        radius: i64,
    ) -> Result<&Patch, String> {
        Ok(match self.map.entry((node, version, radius)) {
            Entry::Occupied(e) => e.into_mut(),
            Entry::Vacant(e) => e.insert(cut_floor(&Scene::of(tree, node)?, radius, Turn::NONE)?),
        })
    }
}
