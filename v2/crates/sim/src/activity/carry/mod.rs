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
//! - **A load from its own entry (0.135 C2).** A load whose kind has an entry is carried as the entry states it
//!   ([`Load::of`]): its longest side is carried lengthways, its width on the plan is the larger of its other two
//!   sides, its two outermost grips along its length are where its carriers hold it, each carrier standing [`REACH`]
//!   beyond its grip, and its `hold_crew` is how many must carry it. Before the lift ([`Load::check`]) a crew smaller
//!   than that is refused `carry-crew-too-small`, a carrier more than [`GRIP_REACH`] from its grip
//!   `carry-grip-out-of-reach`, and, when the lift names where the front goes, a load whose outline would meet fixed
//!   geometry on the straight way there `carry-board-clips` ([`sweep_load`]); nothing is written. A load whose kind
//!   has no entry is B9's 2 m board, as before.
//!
//! - **Held lengthwise (0.135 C4).** The carry's +x runs from the back carrier to the front, so a load is held in the
//!   carry's slot turned so its longest side runs along it ([`Load::turn`]: a quarter turn about y for a beam whose
//!   length is its z; an upright, whose length is its y, laid flat), its middle at the slot's origin ([`Load::held`]);
//!   set down, it lies the same way, its middle between the carriers and its lowest side on the floor
//!   ([`Load::resting`]). B9's board, whose length is its x, is held as before.
//! - **A carry that breaks off sets its load down where it is (0.135 C3).** A partner's leave, carriers drifted more
//!   than [`STRETCH`] from their span at the lift (one stopped, or its connection is gone, while the other walked
//!   on), and a restart (a carry is not stored, so the load found riding is set down at the first tick) each set
//!   the load down at its last sample, at rest on the ground ([`Carry::set_down_here`]); the world says why
//!   (`souls:carry-set-down`, worldd's engine).
//!
//! - **Carriers at every grip (0.135 C5).** The front and the back are the carry's ends as above; each member after
//!   them is a side carrier, beside one of the load's grips between its ends ([`Load::inner`], from the back toward
//!   the front, in join order, alternating sides: [`Load::side_places`]). More members than grips is refused
//!   `carry-crew-too-large`, and each side is checked at its grip by name ([`Load::check_sides`]). The frame's pose is
//!   still the front's and the back's: each side walks its own way, and one that drifts more than [`STRETCH`] from
//!   its place at the lift ([`Carry::sides`]) breaks the carry off. A side's leave with the load's crew left goes on,
//!   its place empty (worldd's engine, `souls:carrier-left`); below the crew it is set down.
//!
//! Not here, proposed as tasks: a search over turning poses and corners (B14); stairs; turning with three carriers or
//! more; a sweep that counts the sides' bodies; a blocked
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
use replica::rules::json::Value as Json;
use replica::time::Micros;
use replica::tree::{Handle, Tree};
use replica::world_model::{Audience, plain};

use crate::ground::scene::{FLOOR, Scene, Terrain, Xz, xform_to};
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
/// The farthest a carrier may stand from its grip on the plan at the lift, µm: a touch's reach (0.134).
pub const GRIP_REACH: i64 = 700_000;
/// How many grips a load has between its ends, at most, that carriers take (0.135 C5): a crew of six, less its front
/// and its back.
pub const INNER: usize = 4;

/// A load as its kind's entry states it (0.135 C2), µm along and across the carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Load {
    /// Half its longest side, carried lengthways.
    pub half_length: i64,
    /// Half its width on the plan while carried: the larger of its other two sides.
    pub half_width: i64,
    /// Its two outermost grips along its length, from its middle: the back's, then the front's.
    pub grips: [i64; 2],
    /// The grips between those, from the back toward the front (0.135 C5): each a side carrier's, beside it. A crew
    /// of six has four sides, so a load with more keeps its first four.
    pub inner: [Option<i64>; INNER],
    /// How many must carry it (`state.hold_crew`'s default; two when it says none).
    pub crew: u64,
    /// The turn from its own frame to the carry's (0.135 C4): its longest side along the carry's +x, from the back
    /// carrier to the front; a load whose length lies flat keeps its up, one whose length stands is laid flat.
    pub turn: Quat,
    /// The middle of its bounds in its own frame, µm: held at the carry's slot, set down between its carriers.
    pub middle: Vec3,
    /// Half its side that stands upright once turned, µm: how high its middle rests when it is set down.
    pub rest: i64,
    /// The end of its long axis in its own frame, from its middle, µm (half its length along that axis, +).
    pub long: Vec3,
}

impl Load {
    /// B9's 2 m board, held at its ends: a load whose kind has no entry.
    pub fn board() -> Load {
        Load {
            half_length: HALF_LENGTH,
            half_width: HALF_WIDTH,
            grips: [-HALF_LENGTH, HALF_LENGTH],
            inner: [None; INNER],
            crew: 2,
            turn: Quat::IDENTITY,
            middle: Vec3::ZERO,
            rest: 0,
            long: Vec3::new(HALF_LENGTH, 0, 0),
        }
    }

    /// Its long axis on the plan, lying turned `o` (µm, from its middle to the + end of its length); none when that
    /// axis stands more than half upright (a standing frame: its carriers take it along the line they stand on).
    pub fn lies_along(&self, o: Quat) -> R<Option<Xz>> {
        let v = o.rotate(self.long).map_err(pose_refusal)?;
        Ok((2 * len([v.x, v.z]) >= self.half_length).then_some([v.x, v.z]))
    }

    /// The load lifted the other way round, its + end behind (0.135 C4): its grips swapped, and a half turn more so it
    /// does not swing round as it is lifted.
    pub fn reversed(&self) -> R<Load> {
        let half = Quat::from_yaw_mdeg(180_000).map_err(pose_refusal)?;
        let mut inner = [None; INNER];
        for (k, g) in self.inner.iter().flatten().rev().enumerate() {
            inner[k] = Some(-g);
        }
        Ok(Load {
            grips: [-self.grips[1], -self.grips[0]],
            inner,
            turn: half.then(self.turn).map_err(pose_refusal)?,
            ..*self
        })
    }

    /// Where the load is held in the carry's slot (0.135 C4): its middle at the slot's origin, its long axis between
    /// the carriers. Its position and orientation in the carry's frame.
    pub fn held(&self) -> R<(Vec3, Quat)> {
        let m = self.turn.rotate(self.middle).map_err(pose_refusal)?;
        Ok((Vec3::new(-m.x, -m.y, -m.z), self.turn))
    }

    /// Where the load rests when set down (0.135 C4): its middle over `c` (on the floor, in the floor's frame, µm)
    /// and its long axis along `q`'s +x. Its position and orientation in the floor's frame.
    pub fn resting(&self, c: Vec3, q: Quat) -> R<(Vec3, Quat)> {
        let o = q.then(self.turn).map_err(pose_refusal)?;
        let m = o.rotate(self.middle).map_err(pose_refusal)?;
        Ok((Vec3::new(c.x - m.x, c.y + self.rest - m.y, c.z - m.z), o))
    }

    /// A load from its kind's entry (`souls-entry/1`): `geometry.bounds_mm`, the `grip` points and
    /// `state.hold_crew`. An entry with no bounds, or fewer than two grips apart along its length, is not a load.
    pub fn of(entry: &Json) -> Result<Load, String> {
        let bounds: Vec<i64> = entry
            .get("geometry")
            .and_then(|g| g.get("bounds_mm"))
            .and_then(Json::arr)
            .ok_or("a load states geometry.bounds_mm")?
            .iter()
            .map(|v| match v {
                Json::Int(n) => i64::try_from(*n).map_err(|_| "a side in mm"),
                _ => Err("a side in mm"),
            })
            .collect::<Result<_, _>>()?;
        let [w, h, d] = bounds[..] else {
            return Err("bounds_mm are three sides".into());
        };
        let sides = [w, h, d];
        let axis = (0..3).max_by_key(|i| (sides[*i], 3 - *i)).unwrap_or(2);
        let across = (0..3)
            .filter(|i| *i != axis)
            .map(|i| sides[i])
            .max()
            .unwrap_or(0);
        // The entry's frame: x and z centred, y from the floor up (entry-format.md, section 5).
        let middle = if axis == 1 { h / 2 } else { 0 };
        let mut along: Vec<i64> = entry
            .get("points")
            .and_then(Json::obj)
            .unwrap_or(&[])
            .iter()
            .filter(|(_, p)| p.get("role").and_then(Json::str) == Some("grip"))
            .filter_map(
                |(_, p)| match p.get("at_mm").and_then(Json::arr)?.get(axis)? {
                    Json::Int(n) => i64::try_from(*n).ok(),
                    _ => None,
                },
            )
            .map(|c| (c - middle) * 1000)
            .collect();
        along.sort_unstable();
        let (Some(&back), Some(&front)) = (along.first(), along.last()) else {
            return Err("a load names its grips".into());
        };
        if front <= back {
            return Err("a load's grips are apart along its length".into());
        }
        let mut inner = [None; INNER];
        let between = &along[1..along.len() - 1];
        for (k, g) in between.iter().take(INNER).enumerate() {
            inner[k] = Some(*g);
        }
        let crew = match entry
            .get("state")
            .and_then(|s| s.get("hold_crew"))
            .and_then(|c| c.get("default"))
        {
            Some(Json::Int(n)) => u64::try_from(*n).map_err(|_| "hold_crew is a count")?,
            _ => 2,
        };
        // Its longest side onto the carry's +x (0.135 C4): x stays; z by a quarter turn about y; y laid flat, by the
        // turn that takes y to x, x to z and z to y, so its wider side lies across as `half_width` has it.
        let (turn, up) = match axis {
            0 => (Ok(Quat::IDENTITY), h),
            1 => (Quat::new(1 << 29, -(1 << 29), -(1 << 29), -(1 << 29)), d),
            _ => (Quat::from_yaw_mdeg(90_000), h),
        };
        Ok(Load {
            half_length: sides[axis] * 500,
            half_width: across * 500,
            grips: [back, front],
            inner,
            crew,
            turn: turn.map_err(|e| format!("a load's turn: {e:?}"))?,
            middle: Vec3::new(0, h * 500, 0),
            rest: up * 500,
            long: match axis {
                0 => Vec3::new(w * 500, 0, 0),
                1 => Vec3::new(0, h * 500, 0),
                _ => Vec3::new(0, 0, d * 500),
            },
        })
    }

    /// Where its back and front carriers stand along the carry, from its middle: [`REACH`] beyond each grip.
    pub fn places(&self) -> [i64; 2] {
        [self.grips[0] - REACH, self.grips[1] + REACH]
    }

    /// How many carriers it takes at most (0.135 C5): one at each grip.
    pub fn most(&self) -> usize {
        2 + self.inner.iter().flatten().count()
    }

    /// Where its side carriers stand (0.135 C5), in join order: each beside its grip between the ends, from the back
    /// toward the front, [`REACH`] off its side, the first on its + side, then alternating. Each `[along, across]`
    /// from its middle, µm, in the carry's frame: along its +x, from the back toward the front, and across its +z.
    pub fn side_places(&self) -> Vec<[i64; 2]> {
        let off = self.half_width + REACH;
        self.inner
            .iter()
            .flatten()
            .enumerate()
            .map(|(k, g)| [*g, if k % 2 == 0 { off } else { -off }])
            .collect()
    }

    /// The checks before the lift of its side carriers (0.135 C5), after [`Load::check`]'s: `crew` carriers, more than
    /// its grips refused `carry-crew-too-large`; and each side carrier in `sides` (in join order, where it stands on the
    /// open ground's plan, µm) within [`GRIP_REACH`] of its grip's edge on the side it stands, or refused
    /// `carry-grip-out-of-reach`, naming it. The load's middle at `middle`, its grips along `axis` (the front's and the
    /// back's line when none), from the back at `back` toward the front at `front`.
    pub fn check_sides(
        &self,
        crew: usize,
        front: Xz,
        back: Xz,
        middle: Xz,
        axis: Option<Xz>,
        sides: &[(Id, Xz)],
    ) -> R<()> {
        if crew > self.most() {
            return refuse(
                "carry-crew-too-large",
                format!("{crew} carrying; it has {} grips", self.most()),
            );
        }
        let a = axis.unwrap_or([front[0] - back[0], front[1] - back[1]]);
        let l = len(a);
        for ((who, at), along) in sides.iter().zip(self.inner.iter().flatten()) {
            let u = scale(a, *along, l);
            let grip = [middle[0] + u[0], middle[1] + u[1]];
            // Its edge on the carrier's side: across the axis by half the load's width.
            let d = [at[0] - grip[0], at[1] - grip[1]];
            let plus =
                i128::from(a[0]) * i128::from(d[1]) - i128::from(a[1]) * i128::from(d[0]) > 0;
            let n = scale([-a[1], a[0]], self.half_width, l);
            let edge = if plus {
                [grip[0] + n[0], grip[1] + n[1]]
            } else {
                [grip[0] - n[0], grip[1] - n[1]]
            };
            let off = len([at[0] - edge[0], at[1] - edge[1]]);
            if off > GRIP_REACH {
                return refuse(
                    "carry-grip-out-of-reach",
                    format!(
                        "the side carrier {} stands {} mm from its grip at ({}, {}) mm; at most {} mm",
                        replica::world_model::show(*who),
                        off / 1000,
                        edge[0] / 1000,
                        edge[1] / 1000,
                        GRIP_REACH / 1000
                    ),
                );
            }
        }
        Ok(())
    }

    /// The checks before the lift (see the module's notes): `crew` carriers, the front at `front` and the back at
    /// `back`, the load's middle at `middle` (each the open ground's plan, µm), its grips along `axis` on the plan from
    /// the back toward the front ([`Load::lies_along`]; the carriers' own line when it stands); and, if the lift names
    /// one, the front's destination `to` and the fixed geometry on the way. `carry-crew-too-small`,
    /// `carry-grip-out-of-reach`, `carry-board-clips`, `carry-route-too-short`.
    pub fn check(
        &self,
        crew: usize,
        front: Xz,
        back: Xz,
        middle: Xz,
        axis: Option<Xz>,
        to: Option<(Xz, &Fixed)>,
    ) -> R<()> {
        if (crew as u64) < self.crew {
            return refuse(
                "carry-crew-too-small",
                format!("{crew} carrying; it takes {}", self.crew),
            );
        }
        let d = [front[0] - back[0], front[1] - back[1]];
        let l = len(d);
        // 0.135 C4: the grips lie along the load's own long axis, so carriers beside it are not at its grips.
        let a = axis.unwrap_or(d);
        for (who, at, along) in [
            ("front", front, self.grips[1]),
            ("back", back, self.grips[0]),
        ] {
            let u = scale(a, along, len(a));
            let grip = [middle[0] + u[0], middle[1] + u[1]];
            let off = len([at[0] - grip[0], at[1] - grip[1]]);
            if off > GRIP_REACH {
                return refuse(
                    "carry-grip-out-of-reach",
                    format!(
                        "the {who} stands {} mm from its grip at ({}, {}) mm; at most {} mm",
                        off / 1000,
                        grip[0] / 1000,
                        grip[1] / 1000,
                        GRIP_REACH / 1000
                    ),
                );
            }
        }
        if let Some((to, fixed)) = to {
            sweep_load(&[back, front, to], fixed, self, l)?;
        }
        Ok(())
    }
}

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
    outline(front, back, &Load::board())
}

/// `load`'s outline between a leader at `front` and a follower at `back`, centred between them, along the line from
/// one to the other.
pub fn outline(front: Xz, back: Xz, load: &Load) -> Quad {
    let c = [(front[0] + back[0]) / 2, (front[1] + back[1]) / 2];
    let d = [front[0] - back[0], front[1] - back[1]];
    let l = len(d);
    let u = scale(d, load.half_length, l);
    let n = scale([-d[1], d[0]], load.half_width, l);
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
        // On the open ground a box is read against the ground's height under it (its terrain's, raised or sloped).
        let scene = Scene::of(tree, ground)?;
        let t = scene.terrain.as_ref();
        let mut quads: Vec<Quad> = scene
            .solids
            .iter()
            .filter(|s| {
                let c = s
                    .ring
                    .iter()
                    .fold([0, 0], |a, p| [a[0] + p[0] / 4, a[1] + p[1] / 4]);
                spans(s.y0, s.y1, Terrain::ground(t, c[0], c[1], s.y0))
            })
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
fn trail(path: &[Xz], along: i64, span: i64) -> Xz {
    let lead = at(path, along);
    let (mut lo, mut hi) = (0, along);
    while hi - lo > 1_000 {
        let mid = (lo + hi) / 2;
        let p = at(path, mid);
        if len([lead[0] - p[0], lead[1] - p[1]]) > span {
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
    sweep_load(path, fixed, &Load::board(), SPAN)
}

/// [`sweep`] for `load`, its carriers `span` µm apart (0.135 C2).
pub fn sweep_load(path: &[Xz], fixed: &Fixed, load: &Load, span: i64) -> R<u64> {
    let total: i64 = path
        .windows(2)
        .map(|w| len([w[1][0] - w[0][0], w[1][1] - w[0][1]]))
        .sum();
    if total < span {
        return refuse("carry-route-too-short", format!("{total} µm"));
    }
    let mut poses = 0;
    let mut along = span;
    loop {
        let lead = at(path, along);
        let q = outline(lead, trail(path, along, span), load);
        if let Some(f) = fixed.hit(&q) {
            return refuse(
                "carry-board-clips",
                format!(
                    "{} mm along the route, the board between ({}, {}) and ({}, {}) mm meets the box at ({}, {}) mm",
                    (along - span) / 1000,
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
    /// How far apart its carriers stood at the lift, µm on the plan (0.135 C3).
    pub span: i64,
    /// What it carries, as its kind's entry states it (B9's board when it has none): how it is held and set down
    /// (0.135 C4).
    pub load: Load,
    /// Its side carriers, beside it between the front and the back (0.135 C5): each body and where it stood at the
    /// lift, `[along, across]` in the carry's frame, µm ([`Carry::place_of`]). Each walks its own way; one that drifts
    /// more than [`STRETCH`] from its place breaks the carry off, as its ends do.
    pub sides: Vec<(Id, [i64; 2])>,
}

/// How far the carriers may drift from their span at the lift before the carry breaks off, µm (0.135 C3): a partner
/// who stops (or whose connection is gone) while the other walks on.
pub const STRETCH: i64 = 1_000_000;

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
            span: 0,
            load: Load::board(),
            sides: Vec::new(),
        }
    }

    /// Where a carrier at `at` stands in the frame of a carry between `front` and `back` (0.135 C5): `[along,
    /// across]` from the frame's middle, µm, along its +x (from the back toward the front) and across its +z.
    pub fn place_of(front: Vec3, back: Vec3, at: Vec3) -> [i64; 2] {
        let d = [front.x - back.x, front.z - back.z];
        let l = i128::from(len(d).max(1));
        let p = [
            i128::from(at.x - (front.x + back.x) / 2),
            i128::from(at.z - (front.z + back.z) / 2),
        ];
        let (dx, dz) = (i128::from(d[0]), i128::from(d[1]));
        [
            ((p[0] * dx + p[1] * dz) / l) as i64,
            ((p[1] * dx - p[0] * dz) / l) as i64,
        ]
    }

    /// The first side carrier, of those standing at `at` (each body's place on the open ground, µm), that has drifted
    /// more than [`STRETCH`] from its place at the lift, with carriers at `front` and `back` (0.135 C5); a side with no
    /// place in `at` is not counted here.
    pub fn side_apart(&self, front: Vec3, back: Vec3, at: &BTreeMap<Id, Vec3>) -> Option<Id> {
        self.sides.iter().find_map(|(who, was)| {
            let now = Carry::place_of(front, back, *at.get(who)?);
            (len([now[0] - was[0], now[1] - was[1]]) > STRETCH).then_some(*who)
        })
    }

    /// Whether carriers at `front` and `back` have drifted more than [`STRETCH`] from their span at the lift: the
    /// carry has broken off (0.135 C3).
    pub fn stretched(&self, front: Vec3, back: Vec3) -> bool {
        let d = len([front.x - back.x, front.z - back.z]);
        (d - self.span).abs() > STRETCH
    }

    /// Sets the board down where the carry last had it (its last sample, or `at` the frame's pose `here` when it has
    /// none: a carry found riding after a restart), at rest on `node` (0.135 C3: a carry that breaks off).
    pub fn set_down_here(
        &mut self,
        tree: &mut Tree,
        at: Micros,
        node: Id,
        here: Option<(Vec3, Quat)>,
        transfer: Id,
    ) -> R<()> {
        let Some((mut c, q)) = self.track.last().map(|t| (t.1, t.2)).or(here) else {
            return refuse("carry-set-down-nowhere", "no sample of the carry");
        };
        c.y -= HEIGHT;
        self.put(tree, at, node, c, q, transfer)
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
        let (position, orientation) = self.load.held()?;
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
                position,
                orientation,
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
        self.span = len([front.x - back.x, front.z - back.z]);
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
        self.put(tree, at, node, c, q, transfer)
    }

    /// The board, at rest at `c` turned `q`, on `node`: its leave and its arrival under `transfer`.
    fn put(
        &mut self,
        tree: &mut Tree,
        at: Micros,
        node: Id,
        c: Vec3,
        q: Quat,
        transfer: Id,
    ) -> R<()> {
        let (position, orientation) = self.load.resting(c, q)?;
        let leave = TransferRec::Leave {
            transfer,
            node: self.board,
            lineage: self.log.header.lineage,
            zone: self.log.header.zone,
            pose: Pose {
                frame: Frame { node, slot: None },
                position,
                orientation,
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
