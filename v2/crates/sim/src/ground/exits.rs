//! The check when geometry changes (Engine v2 N10, #2657): given a node's new patch, before it is applied, every
//! body it would leave on illegal ground or in a piece with no usable way out, each by name.
//!
//! - **Illegal ground** (`off-ground`): the body's centre lies in no triangle of any piece of the new patch (a box
//!   dropped where it stands, a floor shrunk under it).
//! - **No way out** (`no-way-out`): the piece it stands on has none of: a doorway meeting it that still passes a
//!   centre (N3's [`Meet`] with width left), the end of another usable link (a stair's or a ladder's, given by the
//!   caller) on it or within [`ON`] of it, or, for a square of the open ground, an edge on the square's line (the
//!   ground goes on into the next square).
//! - **Who calls it.** Rebuilding a node's patch, changing a body's size and a birth: G2 refuses the edit, K11 audits,
//!   K10 places the newborn. Nothing here changes anything: the check reads the new patch and the bodies and lists.
//! - [`nearest`] is the nearest legal point to a spot off the ground, for the last rung (`crate::unstick`).
//!
//! Integers only: patches in mm (N3's grid), bodies in µm, orientation tests on `i128`.

use super::{Patch, Piece, SQUARE};
use replica::ids::Id;
use replica::pose::Vec3;

/// A link's end lies on its piece's edge within this, mm (N3's grid rounding).
pub const ON: i64 = 20;

/// A body the new patch would leave stuck: on illegal ground (`off-ground`), or on piece `piece` with no usable way
/// out (`no-way-out`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Finding {
    pub body: Id,
    pub at: Vec3,
    pub why: &'static str,
    pub piece: Option<u32>,
}

type P = [i128; 2];

fn um(v: [i32; 3]) -> P {
    [i128::from(v[0]) * 1000, i128::from(v[2]) * 1000]
}

fn orient(a: P, b: P, p: P) -> i128 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}

/// Each triangle of a piece as three corners, µm.
fn tris(pc: &Piece) -> impl Iterator<Item = [P; 3]> + '_ {
    pc.triangles.iter().map(|t| {
        let v = |k: usize| um(pc.vertices[t[k] as usize]);
        [v(0), v(1), v(2)]
    })
}

fn inside(t: [P; 3], p: P) -> bool {
    let s = orient(t[0], t[1], t[2]).signum();
    s != 0 && (0..3).all(|k| orient(t[k], t[(k + 1) % 3], p) * s >= 0)
}

/// The piece holding `at` (µm, the node's frame), edges included.
pub fn piece_of(pieces: &[Piece], at: Vec3) -> Option<u32> {
    let p = [i128::from(at.x), i128::from(at.z)];
    pieces
        .iter()
        .position(|pc| tris(pc).any(|t| inside(t, p)))
        .map(|q| q as u32)
}

/// The point of segment `a`–`b` nearest `p`, and its squared distance.
fn on_segment(a: P, b: P, p: P) -> (P, i128) {
    let e = [b[0] - a[0], b[1] - a[1]];
    let ee = e[0] * e[0] + e[1] * e[1];
    let t = if ee == 0 {
        0
    } else {
        ((p[0] - a[0]) * e[0] + (p[1] - a[1]) * e[1]).clamp(0, ee)
    };
    let c = if ee == 0 {
        a
    } else {
        [a[0] + e[0] * t / ee, a[1] + e[1] * t / ee]
    };
    let d = [p[0] - c[0], p[1] - c[1]];
    (c, d[0] * d[0] + d[1] * d[1])
}

/// The nearest legal point to `at` (µm, the node's frame) and its piece: `at` itself when a piece holds it, else the
/// nearest point of any triangle's edge, moved 1 mm into that triangle (towards its centroid) so that it lies inside
/// whatever the rounding. Ties go to the first piece and triangle. `None` when there is no ground at all.
pub fn nearest(pieces: &[Piece], at: Vec3) -> Option<(u32, Vec3)> {
    nearest_where(pieces, at, &|_| true)
}

/// [`nearest`] among the points `ok` keeps: a piece whose nearest point it refuses (ground sealed off from the main
/// ground, `crate::mover::Floors::sealed`) is passed over and the next nearest piece tried. `None` when none is kept.
pub fn nearest_where(pieces: &[Piece], at: Vec3, ok: &dyn Fn(Vec3) -> bool) -> Option<(u32, Vec3)> {
    let mut skip: Vec<u32> = Vec::new();
    if let Some(q) = piece_of(pieces, at) {
        if ok(at) {
            return Some((q, at));
        }
        skip.push(q);
    }
    while skip.len() < pieces.len() {
        let (q, s) = nearest_off(pieces, at, &skip)?;
        if ok(s) {
            return Some((q, s));
        }
        skip.push(q);
    }
    None
}

/// The nearest point to `at` of any piece not in `skip`, moved 1 mm into its triangle.
fn nearest_off(pieces: &[Piece], at: Vec3, skip: &[u32]) -> Option<(u32, Vec3)> {
    let p = [i128::from(at.x), i128::from(at.z)];
    let mut best: Option<(i128, u32, P, [P; 3])> = None;
    for (q, pc) in pieces.iter().enumerate() {
        if skip.contains(&(q as u32)) {
            continue;
        }
        for t in tris(pc) {
            for k in 0..3 {
                let (c, d) = on_segment(t[k], t[(k + 1) % 3], p);
                if best.is_none_or(|b| d < b.0) {
                    best = Some((d, q as u32, c, t));
                }
            }
        }
    }
    let (_, q, c, t) = best?;
    let g = [
        (t[0][0] + t[1][0] + t[2][0]) / 3,
        (t[0][1] + t[1][1] + t[2][1]) / 3,
    ];
    let d = [g[0] - c[0], g[1] - c[1]];
    let l = (d[0] * d[0] + d[1] * d[1]).isqrt();
    let s = if l <= 1000 {
        g
    } else {
        [c[0] + d[0] * 1000 / l, c[1] + d[1] * 1000 / l]
    };
    let s = if inside(t, s) { s } else { g };
    Some((q, Vec3::new(s[0] as i64, at.y, s[1] as i64)))
}

/// The piece `at` lies on, or within `tol` mm of.
fn near_piece(pieces: &[Piece], at: Vec3, tol: i64) -> Option<u32> {
    let (q, s) = nearest(pieces, at)?;
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    let t = i128::from(tol) * 1000;
    (d(s.x, at.x) + d(s.z, at.z) <= t * t).then_some(q)
}

/// The check: of `bodies` (each with its centre, µm, in the node's frame), the ones the new patch `patch` would leave
/// on illegal ground or on a piece with no usable way out, in the order given. `ends` are the ends of the node's other
/// usable links (stairs, ramps, ladders), µm; `open` is set for a square of the open ground.
pub fn check(patch: &Patch, open: bool, ends: &[Vec3], bodies: &[(Id, Vec3)]) -> Vec<Finding> {
    let pieces = &patch.pieces;
    let mut out = vec![false; pieces.len()];
    for m in patch.meets.iter().filter(|m| m.width_left > 0) {
        if let Some(o) = out.get_mut(m.piece as usize) {
            *o = true;
        }
    }
    for &e in ends {
        if let Some(q) = near_piece(pieces, e, ON) {
            out[q as usize] = true;
        }
    }
    if open {
        let on_line = |u: i32, v: i32| u == v && i64::from(u).rem_euclid(SQUARE) == 0;
        for (q, pc) in pieces.iter().enumerate() {
            out[q] |= pc.outline.iter().any(|ring| {
                (0..ring.len()).any(|k| {
                    let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
                    on_line(a[0], b[0]) || on_line(a[2], b[2])
                })
            });
        }
    }
    bodies
        .iter()
        .filter_map(|&(body, at)| match piece_of(pieces, at) {
            None => Some(Finding {
                body,
                at,
                why: "off-ground",
                piece: None,
            }),
            Some(q) if !out[q as usize] => Some(Finding {
                body,
                at,
                why: "no-way-out",
                piece: Some(q),
            }),
            Some(_) => None,
        })
        .collect()
}
