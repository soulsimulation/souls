//! Things that move by themselves (Engine v2 N14, #2738): a thing's motion owned by a closed-form track (T4 rule 8,
//! `v2/docs/pose.md`), at rest, straight or thrown, from a slot of a node to a slot of the same node. Hands (B4) are
//! not built, so a throw goes from slot to slot.
//!
//! - **A flight is one track.** Its start is one effect: the thing leaves its slot for the node itself (a reparent
//!   inside the node) and T4's hand-off gives its motion to the track, slot to track, with the pose and velocity
//!   ([`Flight::start`]). Its end is one effect at the end time ([`Flight::finish`]). Nothing is written between: the
//!   engine, a viewer and a replay all read the position at any time from the stored start and the formula
//!   ([`replica::pose::Track::at`]), in whole micrometres.
//! - **The end is worked out at the start** ([`Flight::throw`]) and is one timer (K9, [`Flight::timer`], named
//!   [`TRACK_END`]). Nothing runs per tick while the thing flies.
//! - **The whole path is tested,** not the landing point. For each face of each box the path could meet, the time it
//!   crosses the face's plane inwards comes from the integer quadratic `g·dt² + 2·10^6·v·dt + 2·10^12·(p0 − x) = 0`
//!   and an integer square root, then is checked on that polynomial so it is the first microsecond at or after the
//!   crossing (T5's rule); the point must be on the face then. The earliest of these ends the track: the catching
//!   slot's reach, a solid's face, the floor, the node's edge.
//! - **Never inside forbidden geometry.** An end at a solid's face or the floor rounds toward the start instead: the
//!   last microsecond whose position is outside every solid (faces included) and not below the floor.
//! - **How it ends.** Caught: into the catching slot, keeping its position (as an offset in the slot) with velocity
//!   zero (T4 rule 10: a catch ends the motion on purpose). On a solid's top or the floor: at rest where it lands
//!   ([`rest`], the at-rest track a thing set down also uses), on that surface. On any other face of a solid (a wall):
//!   the track ends at the wall and hands to a second track, a drop from rest there (no rebound), which ends where it
//!   lands. At the node's edge: at rest there, unsupported, for the paired transfer (T1) to carry out (not built).
//!
//! Integers only: µm and µs, through 128 bits. Not here: rolling, bouncing, hitting a body, aiming, a track that
//! turns, geometry that changes in flight (the end would be worked out again, as N10 does for bodies), the transfer
//! out of the node.

#[cfg(test)]
mod tests;

use crate::timers::Timer;
use replica::effects::{Change, Refusal};
use replica::encode::Name;
use replica::ids::Id;
use replica::pose::{Frame, HandOff, Owner, Pose, PoseRefusal, Support, Track, Vec3};
use replica::time::Micros;

/// The name of the timer that ends a track.
pub const TRACK_END: &str = "souls:track-end";

const MICRO: i128 = 1_000_000;
/// The search window around an estimated root, in µs: the estimate is within two of the true time.
const WINDOW: i128 = 3;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn pose_refusal(r: PoseRefusal) -> Refusal {
    Refusal {
        name: r.name(),
        detail: "a track (v2/docs/pose.md rule 8)".into(),
    }
}

fn wide(v: Vec3) -> [i128; 3] {
    [v.x.into(), v.y.into(), v.z.into()]
}

/// A box of a node's fixed geometry in the node's frame, µm, faces included.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Solid {
    pub id: Id,
    pub min: Vec3,
    pub max: Vec3,
}

/// What a track can meet in its node, in the node's frame: its solids, its floor (the surface `floor` at height
/// `floor_y`; +y is up, T4 rule 5) and its extent, `min` to `max`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub solids: Vec<Solid>,
    pub floor: Id,
    pub floor_y: i64,
    pub min: Vec3,
    pub max: Vec3,
}

/// A slot of the node that catches: its point in the node's frame and how far from it it reaches on each axis, µm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Catch {
    pub slot: u64,
    pub point: Vec3,
    pub reach: i64,
}

/// What ends a track.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ends {
    Caught {
        slot: u64,
    },
    /// On the floor or a solid's top.
    Landed {
        surface: Id,
    },
    /// Any other face of a solid.
    Wall {
        solid: Id,
    },
    /// The node's extent.
    Edge,
}

/// A track's end: when (the first microsecond at or after it; at a solid or the floor, the last one still outside),
/// where (the formula's position then) and why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct End {
    pub at: Micros,
    pub position: Vec3,
    pub ends: Ends,
}

/// A thing on a straight or thrown track, with its end worked out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flight {
    pub node: Id,
    /// Where it starts, in the node's frame (no slot), unsupported.
    pub pose: Pose,
    pub track: Track,
    pub catch: Option<Catch>,
    pub end: End,
}

/// The hand-off that puts `node` at rest at `pose` at `at`: the at-rest track, velocity zero (T4 rule 10).
pub fn rest(node: Id, at: Micros, from: Owner, pose: Pose) -> HandOff {
    HandOff {
        node,
        at,
        from,
        to: Owner::Track(Track::Rest),
        pose,
        linear: Vec3::ZERO,
        angular: Vec3::ZERO,
    }
}

/// The track from `t0` at `velocity` under `gravity`: straight without gravity, thrown with it.
fn track_of(t0: Micros, velocity: Vec3, gravity: Vec3, spin: Vec3) -> Track {
    if gravity == Vec3::ZERO {
        Track::Straight { t0, velocity }
    } else {
        Track::Thrown {
            t0,
            velocity,
            gravity,
            spin,
        }
    }
}

impl Flight {
    /// Throws `node`, held in a slot at `held` (the slot's point is `point` in the node's frame), at world time `at`
    /// with `velocity` under `gravity` (both in the node's axes), toward `catch` if any; its end is worked out now.
    #[allow(clippy::too_many_arguments)]
    pub fn throw(
        node: Id,
        held: Pose,
        point: Vec3,
        at: Micros,
        velocity: Vec3,
        gravity: Vec3,
        spin: Vec3,
        geometry: &Geometry,
        catch: Option<Catch>,
    ) -> R<Flight> {
        if held.frame.slot.is_none() {
            return refuse("not-in-slot", "a throw starts from a slot");
        }
        let pose = Pose {
            frame: Frame {
                node: held.frame.node,
                slot: None,
            },
            position: point.plus(held.position).map_err(pose_refusal)?,
            orientation: held.orientation,
            support: Support::None,
        };
        Flight::plan(
            node,
            pose,
            track_of(at, velocity, gravity, spin),
            geometry,
            catch,
        )
    }

    fn plan(
        node: Id,
        pose: Pose,
        track: Track,
        geometry: &Geometry,
        catch: Option<Catch>,
    ) -> R<Flight> {
        let end = first_end(&pose, &track, geometry, catch.as_ref())?;
        Ok(Flight {
            node,
            pose,
            track,
            catch,
            end,
        })
    }

    fn t0(&self) -> Micros {
        match self.track {
            Track::Straight { t0, .. } | Track::Thrown { t0, .. } | Track::Rail { t0, .. } => t0,
            Track::Rest => self.end.at,
        }
    }

    /// The position at world time `t`, from the start and the formula.
    pub fn at(&self, t: Micros) -> R<Vec3> {
        Ok(self
            .track
            .at(self.pose.position, t)
            .map_err(pose_refusal)?
            .0)
    }

    /// The start's changes, for the thing's own entry at the start: out of the slot `from` into the node, and the
    /// hand-off from the slot to the track.
    pub fn start(&self, from: Frame) -> R<Vec<Change>> {
        let (_, linear) = self
            .track
            .at(self.pose.position, self.t0())
            .map_err(pose_refusal)?;
        Ok(vec![
            Change::Reparent {
                node: self.node,
                from,
                pose: self.pose,
            },
            Change::Motion(HandOff {
                node: self.node,
                at: self.t0(),
                from: Owner::Slot,
                to: Owner::Track(self.track),
                pose: self.pose,
                linear,
                angular: self.track.spin(),
            }),
        ])
    }

    /// The timer `id` that ends the track, set with the start.
    pub fn timer(&self, id: Id) -> R<Timer> {
        Ok(Timer {
            node: self.node,
            id,
            due: self.end.at,
            name: Name::new(TRACK_END).map_or_else(|| refuse("not-a-name", TRACK_END), Ok)?,
        })
    }

    /// The end's changes, for the thing's own entry when the timer fires, and, after a wall, the drop it hands to
    /// (whose own end is a new timer).
    pub fn finish(&self, geometry: &Geometry) -> R<(Vec<Change>, Option<Flight>)> {
        let End { at, position, ends } = self.end;
        let from = Owner::Track(self.track);
        let here = |support| Pose {
            position,
            support,
            ..self.pose
        };
        Ok(match ends {
            Ends::Caught { slot } => {
                let point = self.catch.map_or(Vec3::ZERO, |c| c.point);
                let pose = Pose {
                    frame: Frame {
                        node: self.pose.frame.node,
                        slot: Some(slot),
                    },
                    position: position.minus(point).map_err(pose_refusal)?,
                    orientation: self.pose.orientation,
                    support: Support::Slot,
                };
                let hand = HandOff {
                    to: Owner::Slot,
                    ..rest(self.node, at, from, pose)
                };
                let changes = vec![
                    Change::Reparent {
                        node: self.node,
                        from: self.pose.frame,
                        pose,
                    },
                    Change::Motion(hand),
                ];
                (changes, None)
            }
            Ends::Landed { surface } => {
                let pose = here(Support::Surface { surface, height: 0 });
                (vec![Change::Motion(rest(self.node, at, from, pose))], None)
            }
            Ends::Edge => (
                vec![Change::Motion(rest(
                    self.node,
                    at,
                    from,
                    here(Support::None),
                ))],
                None,
            ),
            Ends::Wall { .. } => {
                let gravity = match self.track {
                    Track::Thrown { gravity, .. } => gravity,
                    _ => Vec3::ZERO,
                };
                if gravity == Vec3::ZERO {
                    let pose = here(Support::None);
                    return Ok((vec![Change::Motion(rest(self.node, at, from, pose))], None));
                }
                let drop = Flight::plan(
                    self.node,
                    here(Support::None),
                    track_of(at, Vec3::ZERO, gravity, Vec3::ZERO),
                    geometry,
                    None,
                )?;
                let hand = HandOff {
                    to: Owner::Track(drop.track),
                    ..rest(self.node, at, from, drop.pose)
                };
                (vec![Change::Motion(hand)], Some(drop))
            }
        })
    }
}

/// `g·n² + 2·10^6·v·n + 2·10^12·(s − x)`: 2·10^12 times how far past `x` the path is at `n` µs, exactly.
fn past(s: i128, v: i128, g: i128, x: i128, n: i128) -> Option<i128> {
    g.checked_mul(n.checked_mul(n)?)?
        .checked_add((2 * MICRO).checked_mul(v)?.checked_mul(n)?)?
        .checked_add((2 * MICRO * MICRO).checked_mul(s - x)?)
}

/// `n / d` rounded down; `d` is not zero.
fn floor_div(n: i128, d: i128) -> i128 {
    let (n, d) = if d < 0 { (-n, -d) } else { (n, d) };
    n.div_euclid(d)
}

/// The largest whole number whose square is at most `n`.
fn isqrt(n: i128) -> i128 {
    if n < 2 {
        return n;
    }
    let mut x = 1i128 << (128 - n.leading_zeros()).div_ceil(2);
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// The first µs `n ≥ 1` after the start at which one axis of the path (from `s` at `v` under `g`) has crossed the
/// plane `x` going up (from below to at or above it) or down; `None` if it never does.
fn cross(s: i64, v: i64, g: i64, x: i64, up: bool) -> R<Option<i128>> {
    let (s, v, g, x): (i128, i128, i128, i128) = (s.into(), v.into(), g.into(), x.into());
    let range = || Refusal {
        name: "out-of-range",
        detail: "a track's end".into(),
    };
    let (b, c) = (
        (2 * MICRO).checked_mul(v).ok_or_else(range)?,
        (2 * MICRO * MICRO).checked_mul(s - x).ok_or_else(range)?,
    );
    let estimate = if g == 0 {
        if b == 0 || (b > 0) != up {
            return Ok(None);
        }
        floor_div(-c, b)
    } else {
        let d = b
            .checked_mul(b)
            .and_then(|bb| {
                g.checked_mul(c)
                    .and_then(|gc| gc.checked_mul(4))
                    .and_then(|ac| bb.checked_sub(ac))
            })
            .ok_or_else(range)?;
        if d <= 0 {
            return Ok(None);
        }
        let root = isqrt(d);
        // The upward crossing is the root where the polynomial's slope, ±√d, is positive.
        floor_div(if up { root - b } else { -root - b }, 2 * g)
    };
    let side = |n: i128| past(s, v, g, x, n).ok_or_else(range);
    for n in (estimate - WINDOW).max(1)..=(estimate + WINDOW).max(0) {
        let (before, now) = (side(n - 1)?, side(n)?);
        if (up && before < 0 && now >= 0) || (!up && before > 0 && now <= 0) {
            return Ok(Some(n));
        }
    }
    Ok(None)
}

/// The end of `track`, starting at `pose`: the earliest crossing into the catch's reach, a solid's face or the floor,
/// or out of the node's extent.
fn first_end(pose: &Pose, track: &Track, geometry: &Geometry, catch: Option<&Catch>) -> R<End> {
    let (t0, v, g) = match *track {
        Track::Straight { t0, velocity } => (t0, velocity, Vec3::ZERO),
        Track::Thrown {
            t0,
            velocity,
            gravity,
            ..
        } => (t0, velocity, gravity),
        Track::Rest | Track::Rail { .. } => {
            return refuse("track-never-ends", "only a straight or thrown track ends");
        }
    };
    let s = pose.position;
    let (sa, va, ga) = ([s.x, s.y, s.z], [v.x, v.y, v.z], [g.x, g.y, g.z]);
    let at = |n: i128| -> R<(Micros, Vec3)> {
        let t = i128::from(t0) + n;
        let t = Micros::try_from(t).map_or_else(|_| refuse("out-of-range", "a track's end"), Ok)?;
        Ok((t, track.at(s, t).map_err(pose_refusal)?.0))
    };
    // Each box: its faces, entered from outside. Earlier in this list wins a tie: the catch, then the solids.
    let reach = |c: &Catch| Vec3::new(c.reach, c.reach, c.reach);
    let mut boxes = Vec::new();
    if let Some(c) = catch {
        let r = reach(c);
        let (min, max) = (
            c.point.minus(r).map_err(pose_refusal)?,
            c.point.plus(r).map_err(pose_refusal)?,
        );
        boxes.push((min, max, None));
    }
    boxes.extend(geometry.solids.iter().map(|b| (b.min, b.max, Some(b.id))));
    let mut best: Option<(i128, Ends)> = None;
    let mut take = |n: i128, ends: Ends| {
        if best.is_none_or(|(b, _)| n < b) {
            best = Some((n, ends));
        }
    };
    for (min, max, solid) in boxes {
        let (lo, hi) = (wide(min), wide(max));
        for axis in 0..3 {
            for (x, up) in [(lo[axis], true), (hi[axis], false)] {
                let x = i64::try_from(x).unwrap_or(i64::MAX);
                let Some(n) = cross(sa[axis], va[axis], ga[axis], x, up)? else {
                    continue;
                };
                let p = wide(at(n)?.1);
                if (0..3).all(|j| j == axis || (lo[j] <= p[j] && p[j] <= hi[j])) {
                    take(
                        n,
                        match (solid, catch) {
                            (None, Some(c)) => Ends::Caught { slot: c.slot },
                            (Some(id), _) if axis == 1 && !up => Ends::Landed { surface: id },
                            (Some(id), _) => Ends::Wall { solid: id },
                            (None, None) => continue,
                        },
                    );
                }
            }
        }
    }
    if let Some(n) = cross(s.y, v.y, g.y, geometry.floor_y, false)? {
        take(
            n,
            Ends::Landed {
                surface: geometry.floor,
            },
        );
    }
    let (lo, hi) = (geometry.min, geometry.max);
    for (axis, lo, hi) in [(0, lo.x, hi.x), (1, lo.y, hi.y), (2, lo.z, hi.z)] {
        for (x, up) in [(hi, true), (lo, false)] {
            if let Some(n) = cross(sa[axis], va[axis], ga[axis], x, up)? {
                take(n, Ends::Edge);
            }
        }
    }
    let Some((mut n, ends)) = best else {
        return refuse("track-never-ends", "nothing ends this track");
    };
    // At a solid's face or the floor, the end rounds toward the start: the last microsecond whose position is
    // outside every solid (faces included) and not below the floor, so a thing never rests inside forbidden geometry.
    if matches!(ends, Ends::Wall { .. } | Ends::Landed { .. }) {
        let forbidden = |p: Vec3| {
            p.y < geometry.floor_y
                || geometry.solids.iter().any(|b| {
                    let (p, lo, hi) = (wide(p), wide(b.min), wide(b.max));
                    (0..3).all(|j| lo[j] <= p[j] && p[j] <= hi[j])
                })
        };
        n -= 1;
        while n > 0 && forbidden(at(n)?.1) {
            n -= 1;
        }
    }
    let (at, position) = at(n)?;
    Ok(End { at, position, ends })
}
