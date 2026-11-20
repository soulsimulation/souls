//! The surface mover (Engine v2 N6, #2654): the one owner of a walking body's motion (T4 rule 7, `v2/docs/pose.md`).
//! It moves a body by a wanted velocity across the walkable pieces of its node (N3's patch, `crate::ground`), in that
//! node's frame, and never off them. N11, N12 and N13 reuse it.
//!
//! - **Input.** T4's `ControllerInput`: a velocity in three dimensions in the body's frame, and a mode; only walking
//!   on a surface is built. The height part of the velocity is not used: the height comes from the surface.
//! - **A step.** The wanted move for one tick (velocity times the tick, rounded once per number) is walked across the
//!   piece's triangles by orientation tests on whole micrometres: a straight walk from triangle to triangle through
//!   the edges the line crosses. An edge with no triangle across it is the piece's edge: where it lies on a 16 m square's line and another
//!   piece of the same node holds the point just past it with the line going into it (the open ground's next square;
//!   at a corner of four squares, the one ahead, not one beside), the walk goes on there;
//!   otherwise the rest of the move slides along the edge. At most [`PASSES`] slides a step, so a tight corner cannot loop.
//! - **Rounding.** A point is put on the micrometre grid toward where the walk last stood, then checked: one that
//!   rounding put outside its triangle falls back to the last point that was inside one. A slid point is moved
//!   inwards by a micrometre at a time until it is on the piece's side of the edge.
//! - **What is stored.** The pose (its frame is the body's parent, its support the surface with height 0, its height
//!   the surface's at that point) and the velocity it moved at, relative to the frame. A step that changes neither
//!   writes nothing; one that does gives T6's motion sample (`HandOff`, from mover to mover). A body standing on a
//!   moving deck is carried by the deck's own motion and writes nothing.
//! - **Crossing.** Into another node's frame (a doorway's other side, a deck to a dock): T4's hand-off keeps the
//!   body's motion in the root frame, and T1's leave and arrive carry it under one transfer id, inside one zone.
//!   Within one node (one square of the open ground to the next) nothing crosses: the node and frame are the same.
//!
//! - **Along the surface** (N11a, #2735). A speed is along the surface: where the walked line climbs or falls, the move
//!   is walked again from the start, its length on the plan times the line's cosine, so the distance covered on a
//!   slope is the speed's. The height part of the velocity stored is the climb.
//!
//! Not here: other people (N7), the gaits' table (`crate::gaits`), the controller's resources (B1), facing (B1's
//! separate input), drawing.

use crate::ground::{Piece, SQUARE, Terrain};
use replica::effects::{Refusal, TransferRec};
use replica::ids::{Id, Scope};
use replica::pose::{
    ControllerInput, Frame, HandOff, Mode, Owner, Pose, Quat, Scene, Support, Vec3,
};
use replica::time::Micros;
use std::collections::BTreeMap;

/// Slides a step may take before it stops where it stands.
pub const PASSES: u32 = 4;
/// Triangles a step may walk through.
const WALK: u32 = 4_096;
const NONE: u32 = u32::MAX;
/// Across this edge, no triangle of the piece, but the edge lies on a 16 m square's line: the next square's piece.
const SEAM: u32 = u32::MAX - 1;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// `n / d`, halves away from zero (T4 rule 3).
fn div_round(n: i128, d: i128) -> i128 {
    let (n, d) = if d < 0 { (-n, -d) } else { (n, d) };
    if n >= 0 {
        (n + d / 2) / d
    } else {
        -((-n + d / 2) / d)
    }
}

/// Which side of `a`–`b` the point `p` lies: positive to the left.
fn orient(a: [i128; 2], b: [i128; 2], p: [i128; 2]) -> i128 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}

/// A triangle: its corners counter-clockwise (µm, x and z), their vertex indices, and what lies across each edge.
type Tri = ([[i128; 2]; 3], [u32; 3], [u32; 3]);

/// The walkable pieces of one node, in its frame, ready to walk on.
#[derive(Clone)]
pub struct Surface {
    pub node: Id,
    pieces: Vec<Piece>,
    /// Per piece, per triangle: its vertices counter-clockwise (µm, x and z), and the triangle across each edge `k`
    /// (vertex `k` to `k + 1`), or `NONE`.
    tris: Vec<Vec<Tri>>,
    /// The pieces whose bounds meet each 16 m cell.
    cells: BTreeMap<(i64, i64), Vec<u32>>,
    /// The terrain under the open ground (N11a, #2735), and per piece, per triangle, whether the triangle lies on it
    /// (each corner at the terrain's height there): such a triangle's heights are the terrain's own.
    terrain: Option<(std::sync::Arc<Terrain>, Vec<Vec<bool>>)>,
}

/// A body the mover owns: its pose and velocity (in its frame), and the piece and triangle it stands in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Body {
    pub id: Id,
    pub pose: Pose,
    pub linear: Vec3,
    pub piece: u32,
    pub tri: u32,
}

fn cell(v: i128) -> i64 {
    (v as i64).div_euclid(SQUARE * 1000)
}

/// Piece `q`'s triangles, counter-clockwise, with the triangle across each edge, the piece put in `cells`.
fn tris_of(pc: &Piece, q: u32, cells: &mut BTreeMap<(i64, i64), Vec<u32>>) -> Vec<Tri> {
    let um = |k: u32| {
        let v = pc.vertices[k as usize];
        [i128::from(v[0]) * 1000, i128::from(v[2]) * 1000]
    };
    let mut list = Vec::with_capacity(pc.triangles.len());
    let mut edges: BTreeMap<(u32, u32), (u32, usize)> = BTreeMap::new();
    for (t, tri) in pc.triangles.iter().enumerate() {
        let mut idx = *tri;
        if orient(um(idx[0]), um(idx[1]), um(idx[2])) < 0 {
            idx.swap(1, 2);
        }
        for k in 0..3 {
            edges.insert((idx[k], idx[(k + 1) % 3]), (t as u32, k));
        }
        list.push(([um(idx[0]), um(idx[1]), um(idx[2])], idx, [NONE; 3]));
    }
    for tr in list.iter_mut() {
        let idx = tr.1;
        for k in 0..3 {
            if let Some(&(o, _)) = edges.get(&(idx[(k + 1) % 3], idx[k])) {
                tr.2[k] = o;
            } else {
                let (a, b) = (tr.0[k], tr.0[(k + 1) % 3]);
                let on = |u: i128, v: i128| u == v && u % (i128::from(SQUARE) * 1000) == 0;
                if on(a[0], b[0]) || on(a[1], b[1]) {
                    tr.2[k] = SEAM;
                }
            }
        }
    }
    let (mut lo, mut hi) = ([i128::MAX; 2], [i128::MIN; 2]);
    for (v, ..) in &list {
        for p in v {
            lo = [lo[0].min(p[0]), lo[1].min(p[1])];
            hi = [hi[0].max(p[0]), hi[1].max(p[1])];
        }
    }
    if !list.is_empty() {
        for i in cell(lo[0])..=cell(hi[0]) {
            for j in cell(lo[1])..=cell(hi[1]) {
                cells.entry((i, j)).or_default().push(q);
            }
        }
    }
    list
}

impl Surface {
    /// The pieces of node `node` (one floor's patch, or every square of the open ground), in its frame.
    pub fn new(node: Id, pieces: Vec<Piece>) -> Surface {
        let mut tris = Vec::with_capacity(pieces.len());
        let mut cells: BTreeMap<(i64, i64), Vec<u32>> = BTreeMap::new();
        for (q, pc) in pieces.iter().enumerate() {
            tris.push(tris_of(pc, q as u32, &mut cells));
        }
        Surface {
            node,
            pieces,
            tris,
            cells,
            terrain: None,
        }
    }

    /// Replaces the pieces `drop` with `add` (G3b, #3449: the open ground's squares cut again after a change): the
    /// dropped pieces are left empty, so no body stands on them and every other piece keeps its number; the new ones
    /// follow the last, each with whether each of its triangles lies on the terrain (`on`, when the surface has one).
    /// Returns the first new piece's number.
    pub fn replace(&mut self, drop: &[u32], add: Vec<Piece>, on: Vec<Vec<bool>>) -> u32 {
        for &q in drop {
            let Some(pc) = self.pieces.get_mut(q as usize) else {
                continue;
            };
            pc.outline.clear();
            pc.vertices.clear();
            pc.triangles.clear();
            self.tris[q as usize].clear();
            if let Some((_, flags)) = &mut self.terrain
                && let Some(f) = flags.get_mut(q as usize)
            {
                f.clear();
            }
        }
        if !drop.is_empty() {
            for list in self.cells.values_mut() {
                list.retain(|q| !drop.contains(q));
            }
        }
        let first = self.pieces.len() as u32;
        for (k, pc) in add.iter().enumerate() {
            let t = tris_of(pc, first + k as u32, &mut self.cells);
            self.tris.push(t);
        }
        if let Some((_, flags)) = &mut self.terrain {
            let mut on = on.into_iter();
            for pc in &add {
                flags.push(on.next().unwrap_or_else(|| vec![false; pc.triangles.len()]));
            }
        }
        self.pieces.extend(add);
        first
    }

    /// The same surface on terrain `t` (the open ground's, `crate::ground::OpenGround::terrain`): inside a triangle
    /// that `on` marks (per piece, per triangle: `crate::ground::OpenGround::on_terrain`), the height is the
    /// terrain's, read at the point; elsewhere (a pier over water, a floor) it is the triangle's.
    pub fn on_terrain(mut self, t: Terrain, on: Vec<Vec<bool>>) -> Surface {
        self.terrain = Some((std::sync::Arc::new(t), on));
        self
    }

    pub fn pieces(&self) -> &[Piece] {
        &self.pieces
    }

    /// Whether `p` (µm, x and z) lies in triangle `t` of piece `q`, its edges included.
    pub fn inside(&self, q: u32, t: u32, p: [i64; 2]) -> bool {
        let Some((v, ..)) = self.tris.get(q as usize).and_then(|l| l.get(t as usize)) else {
            return false;
        };
        let p = [i128::from(p[0]), i128::from(p[1])];
        (0..3).all(|k| orient(v[k], v[(k + 1) % 3], p) >= 0)
    }

    /// The piece and triangle holding `p`, other than piece `not`.
    fn locate(&self, p: [i128; 2], not: u32) -> Option<(u32, u32)> {
        let qs = self.cells.get(&(cell(p[0]), cell(p[1])))?;
        qs.iter().filter(|&&q| q != not).find_map(|&q| {
            self.tris[q as usize]
                .iter()
                .position(|(v, ..)| (0..3).all(|k| orient(v[k], v[(k + 1) % 3], p) >= 0))
                .map(|t| (q, t as u32))
        })
    }

    /// The piece and triangle, other than piece `not`, that a walk from `p` toward `to` enters: it holds `p`, and on
    /// every edge `p` lies on, `to` is on its side. At a corner several squares hold `p`; only this one is ahead.
    fn enter(&self, p: [i128; 2], to: [i128; 2], not: u32) -> Option<(u32, u32)> {
        let qs = self.cells.get(&(cell(p[0]), cell(p[1])))?;
        qs.iter().filter(|&&q| q != not).find_map(|&q| {
            self.tris[q as usize]
                .iter()
                .position(|(v, ..)| {
                    (0..3).all(|k| {
                        let (a, b) = (v[k], v[(k + 1) % 3]);
                        let o = orient(a, b, p);
                        o > 0 || (o == 0 && orient(a, b, to) >= 0)
                    })
                })
                .map(|t| (q, t as u32))
        })
    }

    /// The surface's height at `p` in triangle `t` of piece `q`, µm.
    fn height(&self, q: u32, t: u32, p: [i128; 2]) -> i64 {
        if let Some((ground, on)) = &self.terrain
            && on
                .get(q as usize)
                .and_then(|l| l.get(t as usize))
                .copied()
                .unwrap_or(false)
            && let Some(h) = ground.height_at(p[0] as i64, p[1] as i64)
        {
            return h;
        }
        let (v, idx, _) = &self.tris[q as usize][t as usize];
        let y = |k: usize| i128::from(self.pieces[q as usize].vertices[idx[k] as usize][1]) * 1000;
        let a = orient(v[0], v[1], v[2]);
        if a == 0 {
            return y(0) as i64;
        }
        let w = [
            orient(v[1], v[2], p),
            orient(v[2], v[0], p),
            orient(v[0], v[1], p),
        ];
        div_round(w[0] * y(0) + w[1] * y(1) + w[2] * y(2), a) as i64
    }

    /// A body standing at `at` (its frame's position, µm) on this surface, at rest: `off-surface` when no piece
    /// holds it.
    pub fn place(&self, id: Id, frame: Frame, at: Vec3, orientation: Quat) -> R<Body> {
        let p = [i128::from(at.x), i128::from(at.z)];
        let Some((q, t)) = self.locate(p, NONE) else {
            return refuse("off-surface", format!("({}, {}) µm", at.x, at.z));
        };
        Ok(Body {
            id,
            pose: Pose {
                frame,
                position: Vec3::new(at.x, self.height(q, t, p), at.z),
                orientation,
                support: Support::Surface {
                    surface: self.node,
                    height: 0,
                },
            },
            linear: Vec3::ZERO,
            piece: q,
            tri: t,
        })
    }

    /// Walks from `p` (in triangle `t` of piece `q`) toward `target`: where it ends, in which piece and triangle.
    fn walk(
        &self,
        mut q: u32,
        mut t: u32,
        from: [i128; 2],
        to: [i128; 2],
    ) -> (u32, u32, [i128; 2]) {
        let (mut p, mut target) = (from, to);
        let mut legal = (q, t, p);
        let mut entry: Option<usize> = None;
        let mut passes = 0;
        let mut steps = 0;
        loop {
            steps += 1;
            if steps > WALK {
                return legal;
            }
            let (v, _, adj) = &self.tris[q as usize][t as usize];
            let out: Vec<usize> = (0..3)
                .filter(|&k| orient(v[k], v[(k + 1) % 3], target) < 0)
                .collect();
            if out.is_empty() {
                return (q, t, target);
            }
            // The edge the line leaves by: the only one the target is past, or, of the two that meet at the corner
            // opposite the edge it came in by, the one on that corner's side of the line.
            let k = match (entry, out.as_slice()) {
                (_, [k]) => *k,
                _ => {
                    let apex = match entry {
                        Some(e) => (e + 2) % 3,
                        None => {
                            let (a, b) = (out[0], out[1]);
                            if (a + 1) % 3 == b { b } else { a }
                        }
                    };
                    let s = orient(p, target, v[apex]);
                    // The edge ending at the apex when the apex is left of the line (or on it), else the one from it.
                    let k = if s >= 0 { (apex + 2) % 3 } else { apex };
                    if out.contains(&k) { k } else { out[0] }
                }
            };
            let (a, b) = (v[k], v[(k + 1) % 3]);
            if adj[k] < SEAM {
                let n = adj[k];
                entry = (0..3).find(|&e| self.tris[q as usize][n as usize].2[e] == t);
                t = n;
                continue;
            }
            // The piece's edge: where the line meets it, rounded toward where the walk stands, and just past it.
            let (op, ot) = (orient(a, b, p).max(0), orient(a, b, target));
            let den = op - ot;
            let at = |round_out: bool| -> [i128; 2] {
                let mut c = [0i128; 2];
                for i in 0..2 {
                    let n = (target[i] - p[i]) * op;
                    let f = if round_out {
                        // Away from p: up in magnitude.
                        (n.abs() + den - 1) / den * n.signum()
                    } else {
                        n / den
                    };
                    c[i] = p[i] + f;
                }
                c
            };
            let c = at(false);
            if !(0..3).all(|e| orient(v[e], v[(e + 1) % 3], c) >= 0) {
                return legal;
            }
            legal = (q, t, c);
            let past = at(true);
            if let Some((nq, nt)) = (adj[k] == SEAM)
                .then(|| self.enter(past, target, q))
                .flatten()
            {
                (q, t, p) = (nq, nt, past);
                legal = (q, t, p);
                entry = None;
                continue;
            }
            passes += 1;
            if passes > PASSES {
                return legal;
            }
            // Slide: the rest of the move along the edge, kept on the piece's side of it.
            let (e, rest) = (
                [b[0] - a[0], b[1] - a[1]],
                [target[0] - c[0], target[1] - c[1]],
            );
            let ee = e[0] * e[0] + e[1] * e[1];
            let dot = rest[0] * e[0] + rest[1] * e[1];
            let mut s = [c[0] + dot * e[0] / ee, c[1] + dot * e[1] / ee];
            let inward = [-e[1].signum(), e[0].signum()];
            let mut nudge = 0;
            while orient(a, b, s) < 0 && nudge < 4 {
                s = [s[0] + inward[0], s[1] + inward[1]];
                nudge += 1;
            }
            if s == c || orient(a, b, s) < 0 {
                return legal;
            }
            p = c;
            target = s;
            entry = None;
        }
    }

    /// One tick of walking: `body` moves by `input` for `dt` µs, ending at world time `at`. Returns T6's motion
    /// sample when its pose or velocity changed, and nothing when neither did.
    pub fn step(
        &self,
        body: &mut Body,
        input: ControllerInput,
        dt: Micros,
        at: Micros,
    ) -> R<Option<HandOff>> {
        let Mode::Surface = input.mode;
        if dt <= 0 {
            return refuse("tick-not-positive", format!("{dt} µs"));
        }
        if !matches!(body.pose.support, Support::Surface { surface, .. } if surface == self.node) {
            return refuse(
                "support-not-this-surface",
                "the body stands on another surface",
            );
        }
        let (dt, m) = (i128::from(dt), 1_000_000i128);
        let p = [
            i128::from(body.pose.position.x),
            i128::from(body.pose.position.z),
        ];
        let want = [
            div_round(i128::from(input.velocity.x) * dt, m),
            div_round(i128::from(input.velocity.z) * dt, m),
        ];
        let (mut q, mut t, mut e) = if want == [0, 0] {
            (body.piece, body.tri, p)
        } else {
            self.walk(body.piece, body.tri, p, [p[0] + want[0], p[1] + want[1]])
        };
        let mut y = i128::from(self.height(q, t, e));
        // Speed is along the surface (N11a, #2735): on a slope the move is walked again, shortened by the cosine of
        // the line just walked (its length on the plan over its length on the surface), once.
        let dy = y - i128::from(body.pose.position.y);
        if dy != 0 && want != [0, 0] {
            let (hx, hz) = (e[0] - p[0], e[1] - p[1]);
            let h2 = hx * hx + hz * hz;
            let (h, l) = (h2.isqrt(), (h2 + dy * dy).isqrt());
            if h > 0 {
                let w = [div_round(want[0] * h, l), div_round(want[1] * h, l)];
                (q, t, e) = self.walk(body.piece, body.tri, p, [p[0] + w[0], p[1] + w[1]]);
                y = i128::from(self.height(q, t, e));
            }
        }
        let fit = |v: i128| i64::try_from(v).map_err(|_| ());
        let (Ok(x), Ok(z)) = (fit(e[0]), fit(e[1])) else {
            return refuse("out-of-range", "a position past 64 bits");
        };
        let position = Vec3::new(x, y as i64, z);
        let old = body.pose.position;
        let v = |d: i128| fit(div_round(d * m, dt)).unwrap_or(0);
        let linear = Vec3::new(v(e[0] - p[0]), v(y - i128::from(old.y)), v(e[1] - p[1]));
        let changed = position != old || linear != body.linear;
        body.pose.position = position;
        body.linear = linear;
        body.piece = q;
        body.tri = t;
        Ok(changed.then_some(HandOff {
            node: body.id,
            at,
            from: Owner::Mover,
            to: Owner::Mover,
            pose: body.pose,
            linear,
            angular: Vec3::ZERO,
        }))
    }
}

/// The body crosses into `frame` onto `to` (another node's surface) at world time `at`: T4's hand-off keeps its
/// motion in the root frame, and T1's leave and arrive, inside zone `zone` of the world `lineage`, carry it under the
/// one id `transfer`. The scene holds the body as it stands; it is changed only when the crossing is made.
/// `off-surface` when the body would not stand on `to`.
#[allow(clippy::too_many_arguments)]
pub fn cross(
    scene: &mut Scene,
    body: &Body,
    to: &Surface,
    frame: Frame,
    at: Micros,
    transfer: Id,
    lineage: Scope,
    zone: Id,
) -> R<(Body, [TransferRec; 2])> {
    let pose_refusal = |e: replica::pose::PoseRefusal| Refusal {
        name: e.name(),
        detail: "the crossing".into(),
    };
    let mut next = scene.clone();
    let support = Support::Surface {
        surface: to.node,
        height: 0,
    };
    let (h, _) = next
        .hand_off(body.id, at, frame, support, Owner::Mover, Vec3::ZERO)
        .map_err(pose_refusal)?;
    let mut b = to.place(body.id, frame, h.pose.position, h.pose.orientation)?;
    b.linear = h.linear;
    *scene = next;
    let pose = b.pose;
    Ok((
        b,
        [
            TransferRec::Leave {
                transfer,
                node: body.id,
                lineage,
                zone,
                pose,
            },
            TransferRec::Arrive {
                transfer,
                carried: Vec::new(),
            },
        ],
    ))
}
