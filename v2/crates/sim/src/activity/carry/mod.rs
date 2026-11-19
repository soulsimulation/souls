//! Carrying together (Engine v2 B9, #2741): two Souls carry one long thing, in the simplest form that passes a door.
//! It is E23's moving group (`v2/docs/moving-group.md`, `replica::group`), used and not defined again: the carry is a
//! joint activity (B5), its node is the group's node, the board rides it and the two carriers are linked to it.
//!
//! - **The group** ([`group`]): the activity's node whose frame moves; the board its rider, at the frame's origin in
//!   its slot [`SLOT`], so it is in nobody's hand slot; the carriers its walkers, linked by B5's join, at the
//!   fixture's places (+1.35 m in front, which leads, and −1.35 m behind). Its outline is the fixture's rigid
//!   3.3 m by 0.56 m and its leave rule is stop and set down.
//! - **The leader walks an ordinary route; the follower keeps to its trail.** Each carrier walks its own route (N7's
//!   walk), the follower from [`SPAN`] behind to [`SPAN`] short of the leader's goal, so on a route that is straight
//!   through the door the two keep to one line. The activity owns the frame's motion (T4, `Owner::Mover`): each tick
//!   [`Carry::step`] writes one motion sample of its node, centred between the carriers and turned to face from the
//!   follower to the leader. That sample is the board's track in the log.
//! - **The sweep before the lift** ([`sweep`]): the board is moved along the whole planned route (on the open
//!   ground's plan, from the follower's start), the follower [`SPAN`] behind the leader on the trail, and at every
//!   [`SWEEP_STEP`] the board's outline is checked against fixed geometry ([`Fixed`]). A clip refuses the carry
//!   before the lift as `carry-board-clips`, naming where; nothing is written.
//! - **Fixed geometry** ([`Fixed`]): every box N3 cuts for a walking body (a height span within [`BODY_LOW`] to
//!   [`BODY_HIGH`] of its floor), on the open ground and on the lowest floor of each building, on the open ground's
//!   plan. The board's outline is its 2 m by [`HALF_WIDTH`] times two; touching is not overlapping.
//! - **Lift and set down are one change of parent each** ([`Carry::lift`], [`Carry::set_down`]): T1's leave and
//!   arrive under one transfer id, in one part with the frame's first or last sample. Setting down puts the board, at
//!   rest, on the node it is in (the floor both carriers stand on, or the open ground), in that node's frame.
//!
//! Not here, proposed as tasks: a search over turning poses and corners (B14); stairs; three carriers; a blocked
//! set-down; walking on after a restart; the gathering walk to the ends (the carriers start at their places); moving
//! the group's node to the floor's frame as one transfer when it crosses the door (E23 rule 9: it stays a child of the
//! open ground, whose frame holds the building).

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use replica::effects::{Body as EffectBody, Change, ChangeRec, Header, Refusal, Rest, TransferRec};
use replica::group::{Belonging, Group, Leave, Member, Outline};
use replica::ids::Id;
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::tree::{Handle, Tree};
use replica::world_model::{Audience, plain};

use crate::ground::scene::{FLOOR, Scene, Xz, xform_to};
use crate::ground::{BODY_HIGH, BODY_LOW};
use crate::slots::hands::{Entry, Log};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// Half the board's length, µm: a 2 m board.
pub const HALF_LENGTH: i64 = 1_000_000;
/// Half the board's width, µm.
pub const HALF_WIDTH: i64 = 150_000;
/// From a carrier's centre to its end of the board, µm: the fixture's places at ±1.35 m.
pub const REACH: i64 = 350_000;
/// Between the two carriers' centres, µm.
pub const SPAN: i64 = 2 * (HALF_LENGTH + REACH);
/// The board's height above its carriers' feet while carried, µm.
pub const HEIGHT: i64 = 900_000;
/// The sweep's step along the route, µm.
pub const SWEEP_STEP: i64 = 50_000;
/// The activity kind's slot the board rides in.
pub const SLOT: u64 = 1;

/// The carry as E23's group (`v2/docs/moving-group.md`, the `carried-load` fixture with this carry's ids): the board
/// rides `activity`'s node, `leader` walks in front and steers, `follower` walks behind.
pub fn group(activity: Id, board: Id, leader: Id, follower: Id) -> Group {
    let walker = |node, x, steers| Member {
        node,
        belongs: Belonging::Walker {
            place: Vec3::new(x, 0, 0),
        },
        steers,
    };
    Group {
        node: activity,
        track: false,
        members: vec![
            Member {
                node: board,
                belongs: Belonging::Rider,
                steers: false,
            },
            walker(leader, HALF_LENGTH + REACH, true),
            walker(follower, -(HALF_LENGTH + REACH), false),
        ],
        outline: Outline::Rigid {
            half_length: HALF_LENGTH + REACH + 300_000,
            half_width: 280_000,
        },
        leave: Some(Leave::StopAndSetDown),
    }
}

/// A four-cornered outline on the open ground's plan, µm.
pub type Quad = [Xz; 4];

fn len(d: Xz) -> i64 {
    (i128::from(d[0]).pow(2) + i128::from(d[1]).pow(2)).isqrt() as i64
}

fn scale(d: Xz, by: i64, of: i64) -> Xz {
    [
        (i128::from(d[0]) * i128::from(by) / i128::from(of.max(1))) as i64,
        (i128::from(d[1]) * i128::from(by) / i128::from(of.max(1))) as i64,
    ]
}

/// The board between a leader standing at `front` and a follower at `back`: centred between them, along the line
/// from one to the other.
pub fn board(front: Xz, back: Xz) -> Quad {
    let c = [(front[0] + back[0]) / 2, (front[1] + back[1]) / 2];
    let d = [front[0] - back[0], front[1] - back[1]];
    let l = len(d);
    let u = scale(d, HALF_LENGTH, l);
    let n = scale([-d[1], d[0]], HALF_WIDTH, l);
    [
        [c[0] + u[0] + n[0], c[1] + u[1] + n[1]],
        [c[0] + u[0] - n[0], c[1] + u[1] - n[1]],
        [c[0] - u[0] - n[0], c[1] - u[1] - n[1]],
        [c[0] - u[0] + n[0], c[1] - u[1] + n[1]],
    ]
}

/// Whether two convex outlines overlap (separating axes on every edge of both); touching is not overlapping.
pub fn overlap(a: &Quad, b: &Quad) -> bool {
    for q in [a, b] {
        for i in 0..4 {
            let (p, r) = (q[i], q[(i + 1) % 4]);
            let axis = [i128::from(p[1] - r[1]), i128::from(r[0] - p[0])];
            let proj = |s: &Quad| {
                s.iter().fold((i128::MAX, i128::MIN), |(lo, hi), v| {
                    let d = axis[0] * i128::from(v[0]) + axis[1] * i128::from(v[1]);
                    (lo.min(d), hi.max(d))
                })
            };
            let ((a0, a1), (b0, b1)) = (proj(a), proj(b));
            if a1 <= b0 || b1 <= a0 {
                return false;
            }
        }
    }
    true
}

fn bounds(q: &Quad) -> [i64; 4] {
    q.iter()
        .fold([i64::MAX, i64::MAX, i64::MIN, i64::MIN], |b, v| {
            [
                b[0].min(v[0]),
                b[1].min(v[1]),
                b[2].max(v[0]),
                b[3].max(v[1]),
            ]
        })
}

/// Cells of the index, µm.
const CELL: i64 = 4_000_000;

fn spans(y0: i64, y1: i64, floor: i64) -> bool {
    y1 > floor + BODY_LOW * 1000 && y0 < floor + BODY_HIGH * 1000
}

/// The fixed geometry a carried board must not overlap, on the open ground's plan (µm): every box a walking body is
/// cut against, on the open ground and on the lowest floor of each building on it, indexed by 4 m cells.
pub struct Fixed {
    pub quads: Vec<Quad>,
    cells: BTreeMap<(i64, i64), Vec<u32>>,
}

impl Fixed {
    /// The fixed geometry of the open ground `ground` and the lowest floor of each building standing on it.
    pub fn of(tree: &Tree, ground: Id) -> Result<Fixed, String> {
        let gh = tree.handle(ground).ok_or("no such ground")?;
        let mut quads: Vec<Quad> = Scene::of(tree, ground)?
            .solids
            .iter()
            .filter(|s| spans(s.y0, s.y1, 0))
            .map(|s| s.ring)
            .collect();
        // The lowest floor of each building: by parent, the floor whose frame stands lowest on the ground.
        let mut lowest: BTreeMap<Handle, (i64, Handle)> = BTreeMap::new();
        let mut stack = vec![gh];
        while let Some(h) = stack.pop() {
            let kids = tree.children(h).ok_or("a node that is gone")?;
            for &c in kids.iter() {
                let n = tree.node(c).ok_or("a node that is gone")?;
                if plain(n.kind().as_str()) == FLOOR {
                    let y = xform_to(tree, c, gh)?.pos.y;
                    let e = lowest.entry(h).or_insert((y, c));
                    if y < e.0 {
                        *e = (y, c);
                    }
                } else {
                    stack.push(c);
                }
            }
        }
        for &(_, h) in lowest.values() {
            let id = tree.node(h).ok_or("a node that is gone")?.id();
            let x = xform_to(tree, h, gh)?;
            // Ground cover (a footpath, a lawn) is walked as the open ground and has no scene of its own.
            let Ok(s) = Scene::of(tree, id) else {
                continue;
            };
            for b in &s.solids {
                if !s.surfaces.iter().any(|f| spans(b.y0, b.y1, f.y)) {
                    continue;
                }
                let mut q = [[0; 2]; 4];
                for (k, v) in b.ring.iter().enumerate() {
                    let p = x.point(Vec3::new(v[0], 0, v[1]))?;
                    q[k] = [p.x, p.z];
                }
                quads.push(q);
            }
        }
        Ok(Fixed::new(quads))
    }

    pub fn new(quads: Vec<Quad>) -> Fixed {
        let mut cells: BTreeMap<(i64, i64), Vec<u32>> = BTreeMap::new();
        for (k, q) in quads.iter().enumerate() {
            let b = bounds(q);
            for i in b[0].div_euclid(CELL)..=b[2].div_euclid(CELL) {
                for j in b[1].div_euclid(CELL)..=b[3].div_euclid(CELL) {
                    cells.entry((i, j)).or_default().push(k as u32);
                }
            }
        }
        Fixed { quads, cells }
    }

    /// The first fixed outline `q` overlaps, if any.
    pub fn hit(&self, q: &Quad) -> Option<&Quad> {
        let b = bounds(q);
        for i in b[0].div_euclid(CELL)..=b[2].div_euclid(CELL) {
            for j in b[1].div_euclid(CELL)..=b[3].div_euclid(CELL) {
                for &k in self.cells.get(&(i, j)).into_iter().flatten() {
                    let f = &self.quads[k as usize];
                    if overlap(q, f) {
                        return Some(f);
                    }
                }
            }
        }
        None
    }

    /// The fixed outlines that meet the box `b` (`[x0, z0, x1, z1]`, µm), each once: for drawing.
    pub fn within(&self, b: [i64; 4]) -> Vec<&Quad> {
        let mut seen = std::collections::BTreeSet::new();
        for i in b[0].div_euclid(CELL)..=b[2].div_euclid(CELL) {
            for j in b[1].div_euclid(CELL)..=b[3].div_euclid(CELL) {
                seen.extend(self.cells.get(&(i, j)).into_iter().flatten().copied());
            }
        }
        seen.into_iter().map(|k| &self.quads[k as usize]).collect()
    }
}

/// The point `along` µm from the start of the polyline `path` (its end beyond it).
fn at(path: &[Xz], along: i64) -> Xz {
    let mut left = along;
    for w in path.windows(2) {
        let l = len([w[1][0] - w[0][0], w[1][1] - w[0][1]]);
        if left <= l {
            let d = scale([w[1][0] - w[0][0], w[1][1] - w[0][1]], left, l);
            return [w[0][0] + d[0], w[0][1] + d[1]];
        }
        left -= l;
    }
    *path.last().unwrap_or(&[0, 0])
}

/// Where the follower is on the trail when the leader is `along` µm from its start: the point behind it, on the
/// path, [`SPAN`] away (to within a millimetre).
fn trail(path: &[Xz], along: i64) -> Xz {
    let lead = at(path, along);
    let (mut lo, mut hi) = (0, along);
    while hi - lo > 1_000 {
        let mid = (lo + hi) / 2;
        let p = at(path, mid);
        if len([lead[0] - p[0], lead[1] - p[1]]) > SPAN {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    at(path, lo)
}

/// Sweeps the board along `path` (the open ground's plan, µm), the follower starting at its first point and the leader
/// [`SPAN`] along it, the leader walking on to its end and the follower keeping to its trail. Refused before the lift
/// as `carry-board-clips` at the first pose whose board overlaps fixed geometry: how far along, and where.
pub fn sweep(path: &[Xz], fixed: &Fixed) -> R<u64> {
    let total: i64 = path
        .windows(2)
        .map(|w| len([w[1][0] - w[0][0], w[1][1] - w[0][1]]))
        .sum();
    if total < SPAN {
        return refuse("carry-route-too-short", format!("{total} µm"));
    }
    let mut poses = 0;
    let mut along = SPAN;
    loop {
        let lead = at(path, along);
        let q = board(lead, trail(path, along));
        if let Some(f) = fixed.hit(&q) {
            return refuse(
                "carry-board-clips",
                format!(
                    "{} mm along the route, the board between ({}, {}) and ({}, {}) mm meets the box at ({}, {}) mm",
                    (along - SPAN) / 1000,
                    q[0][0] / 1000,
                    q[0][1] / 1000,
                    q[2][0] / 1000,
                    q[2][1] / 1000,
                    f[0][0] / 1000,
                    f[0][1] / 1000
                ),
            );
        }
        poses += 1;
        if along >= total {
            return Ok(poses);
        }
        along = (along + SWEEP_STEP).min(total);
    }
}

/// The yaw that turns +x toward `d` (x and z), to the nearest millidegree: whole-number search on T4's integer
/// rotation, so no float and no platform trigonometry.
pub fn yaw_toward(d: Xz) -> R<Quat> {
    let r = |mdeg: i64| -> R<(Quat, i128, i128)> {
        let q = Quat::from_yaw_mdeg(mdeg).map_err(pose_refusal)?;
        let v = q.rotate(Vec3::new(1 << 20, 0, 0)).map_err(pose_refusal)?;
        let dot = i128::from(v.x) * i128::from(d[0]) + i128::from(v.z) * i128::from(d[1]);
        let cross = i128::from(v.x) * i128::from(d[1]) - i128::from(v.z) * i128::from(d[0]);
        Ok((q, dot, cross))
    };
    // The quarter nearest, then halving: within 90 degrees of it the cross product changes sign once.
    let mut best = (0, i128::MIN);
    for m in [0, 90_000, 180_000, 270_000] {
        let (_, dot, _) = r(m)?;
        if dot > best.1 {
            best = (m, dot);
        }
    }
    let (_, _, c0) = r(best.0)?;
    let (mut lo, mut hi) = (best.0, best.0);
    if c0 != 0 {
        // Which way the yaw grows the cross product, found by a small turn.
        let (_, _, c1) = r(best.0 + 1_000)?;
        let up = (c1 - c0).signum() == -c0.signum();
        if up {
            hi = best.0 + 90_000;
        } else {
            lo = best.0 - 90_000;
        }
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            let (_, _, c) = r(mid)?;
            if c == 0 {
                lo = mid;
                break;
            }
            if (c.signum() == c0.signum()) == up {
                lo = mid;
            } else {
                hi = mid;
            }
        }
    }
    Ok(r(lo)?.0)
}

fn pose_refusal(e: replica::pose::PoseRefusal) -> Refusal {
    Refusal {
        name: "carry-pose",
        detail: format!("{e:?}"),
    }
}

/// The carry's writer: the activity's node, the board and the world's log they are written to (B4's part writer, so
/// each change is all or none and checked by T2 at commit).
pub struct Carry {
    pub activity: Id,
    pub board: Id,
    pub ground: Id,
    pub audience: Audience,
    pub log: Log,
    /// Every sample written of the activity's node: the board's track (at, its centre in the open ground's frame,
    /// µm, and its turn).
    pub track: Vec<(Micros, Vec3, Quat)>,
}

fn sample(node: Id, at: Micros, frame: Id, position: Vec3, orientation: Quat) -> Change {
    Change::Motion(HandOff {
        node,
        at,
        from: Owner::Mover,
        to: Owner::Mover,
        pose: Pose {
            frame: Frame {
                node: frame,
                slot: None,
            },
            position,
            orientation,
            support: Support::Surface {
                surface: frame,
                height: 0,
            },
        },
        linear: Vec3::ZERO,
        angular: Vec3::ZERO,
    })
}

impl Carry {
    pub fn new(
        activity: Id,
        board: Id,
        ground: Id,
        audience: Audience,
        header: Header,
        rules: replica::tree::Rules,
    ) -> Carry {
        Carry {
            activity,
            board,
            ground,
            audience,
            log: Log::new(header, rules, 0),
            track: Vec::new(),
        }
    }

    fn write(&mut self, tree: &mut Tree, at: Micros, entries: Vec<Entry>) -> R<()> {
        self.log.next = tree.next();
        self.log.write(tree, at, entries)
    }

    /// The frame's pose for carriers at `front` and `back` (µm, the open ground's frame).
    fn pose(front: Vec3, back: Vec3) -> R<(Vec3, Quat)> {
        let c = Vec3::new(
            (front.x + back.x) / 2,
            (front.y + back.y) / 2 + HEIGHT,
            (front.z + back.z) / 2,
        );
        Ok((c, yaw_toward([front.x - back.x, front.z - back.z])?))
    }

    /// Lifts the board: the frame's first sample, between the carriers, and the board's change of parent to the
    /// frame's slot, in one part, under the transfer id `transfer`.
    pub fn lift(
        &mut self,
        tree: &mut Tree,
        at: Micros,
        front: Vec3,
        back: Vec3,
        transfer: Id,
    ) -> R<()> {
        let (c, q) = Carry::pose(front, back)?;
        let leave = TransferRec::Leave {
            transfer,
            node: self.board,
            lineage: self.log.header.lineage,
            zone: self.log.header.zone,
            pose: Pose {
                frame: Frame {
                    node: self.activity,
                    slot: Some(SLOT),
                },
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::Slot,
            },
        };
        let entries = vec![
            (
                self.activity,
                self.audience,
                EffectBody::Changes(vec![ChangeRec {
                    change: sample(self.activity, at, self.ground, c, q),
                    rest: Rest::new(),
                }]),
            ),
            (self.board, self.audience, EffectBody::Transfer(leave)),
            (
                self.activity,
                self.audience,
                EffectBody::Transfer(TransferRec::Arrive {
                    transfer,
                    carried: Vec::new(),
                }),
            ),
        ];
        self.write(tree, at, entries)?;
        self.track.push((at, c, q));
        Ok(())
    }

    /// One tick of the carry: the frame's sample between the carriers (µm, the open ground's frame).
    pub fn step(&mut self, tree: &mut Tree, at: Micros, front: Vec3, back: Vec3) -> R<()> {
        let (c, q) = Carry::pose(front, back)?;
        let e = (
            self.activity,
            self.audience,
            EffectBody::Changes(vec![ChangeRec {
                change: sample(self.activity, at, self.ground, c, q),
                rest: Rest::new(),
            }]),
        );
        self.write(tree, at, vec![e])?;
        self.track.push((at, c, q));
        Ok(())
    }

    /// Sets the board down at rest on `node`, the node both carriers stand on, between them where they stand
    /// (`front` and `back` in that node's frame, µm): one change of parent, under the transfer id `transfer`.
    pub fn set_down(
        &mut self,
        tree: &mut Tree,
        at: Micros,
        node: Id,
        front: Vec3,
        back: Vec3,
        transfer: Id,
    ) -> R<()> {
        let (mut c, q) = Carry::pose(front, back)?;
        c.y -= HEIGHT;
        let leave = TransferRec::Leave {
            transfer,
            node: self.board,
            lineage: self.log.header.lineage,
            zone: self.log.header.zone,
            pose: Pose {
                frame: Frame { node, slot: None },
                position: c,
                orientation: q,
                support: Support::Surface {
                    surface: node,
                    height: 0,
                },
            },
        };
        if tree.handle(node).is_none() {
            return refuse("carry-set-down-nowhere", replica::world_model::show(node));
        }
        let entries = vec![
            (self.board, self.audience, EffectBody::Transfer(leave)),
            (
                node,
                self.audience,
                EffectBody::Transfer(TransferRec::Arrive {
                    transfer,
                    carried: Vec::new(),
                }),
            ),
        ];
        self.write(tree, at, entries)
    }
}
