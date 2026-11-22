//! A form's walk that stops making progress (Engine v2 C21, #3484): it ends `walk.blocked` within [`WINDOW`] of
//! stalling, naming the nearest thing or edge in its way, and its Soul is free in the same tick.
//!
//! - **What is watched.** Each tick a walk asks its way (`Ask::Toward`: the corner it aims at toward its leg's end),
//!   the world gives the walker's place, the corner and the leg's end to [`Watch::seen`]. A tick in which the walk
//!   does not ask (it waits its turn at a narrow link, it is carried across one, it stands for its spot) is no tick of
//!   walking: its watch starts again ([`Watch::keep`]).
//! - **Progress** is either of two gains over the last [`WINDOW`] of world time, each at least [`GAIN`]: the least
//!   distance left through the corner aimed at (`|here - corner| + |corner - leg's end|`, never more than the way
//!   left), or, while it aimed at one corner the whole window, the least distance to that corner. A walker going round
//!   a building gains on its corner; one pushed against a thing or an edge, turning this way and that, gains on
//!   neither. A new leg's end starts the watch again, and so does a new corner once the walker has reached the one
//!   before ([`REACHED`]). A tick aimed at its own place (standing for the planner's line, the first tick or two of
//!   each leg) is no tick of walking and is not sampled (C22, #3485).
//! - **The blocker** ([`blocker`]): the thing on the walker's ground whose solids are nearest it, within [`NEAR`],
//!   or else the edge of the walked ground where it stands.
//!
//! Integers only: µm, µs. Deterministic: the same ticks give the same answer.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use replica::encode::Value;
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::time::Micros;
use replica::tree::{Handle, Tree};
use replica::world_model::{plain, show};

use crate::ground::scene::{F_SOLIDS, xform_to};
use crate::walk::town::OFF_LINE;

/// How long a walk may go without progress, world time µs.
pub const WINDOW: Micros = 3_000_000;
/// The least gain toward its goal over [`WINDOW`] that is progress, µm.
pub const GAIN: i64 = 250_000;
/// A thing whose solids are this near the walker is named as what blocks it, µm.
pub const NEAR: i64 = 1_000_000;
/// A corner the walker has come this near is reached: the line moves on from it, there or past it, no more than
/// [`OFF_LINE`] off its stretch, µm.
pub const REACHED: i64 = OFF_LINE;

/// One tick of a walker: when, the least distance left through its corner so far, the corner, and the least
/// distance to that corner so far.
#[derive(Clone, Copy, Debug)]
struct Sample {
    at: Micros,
    here: [i64; 2],
    left: i64,
    aim: [i64; 2],
    near: i64,
}

#[derive(Debug)]
struct Track {
    to: [i64; 2],
    /// When it began aiming at its corner.
    aimed: Micros,
    samples: VecDeque<Sample>,
}

/// The walks watched, by walker.
#[derive(Debug, Default)]
pub struct Watch {
    walkers: BTreeMap<Id, Track>,
}

/// The distance from `a` to `b`, µm; [`i64::MAX`] when it is past that (any two points' differences and squares are
/// taken unsigned, so no input overflows: a walker's place must never panic the clock thread).
fn len(a: [i64; 2], b: [i64; 2]) -> i64 {
    let d = |u: i64, v: i64| u128::from((i128::from(u) - i128::from(v)).unsigned_abs() as u64);
    let (x, z) = (d(a[0], b[0]), d(a[1], b[1]));
    (x * x)
        .checked_add(z * z)
        .and_then(|s| i64::try_from(s.isqrt()).ok())
        .unwrap_or(i64::MAX)
}

impl Watch {
    pub fn new() -> Watch {
        Watch::default()
    }

    /// A tick of walker `who` at world time `now`: where it stands (`here`, x and z µm), the corner it aims at and
    /// its leg's end, in one frame. Whether it has gone a [`WINDOW`] without progress.
    pub fn seen(
        &mut self,
        who: Id,
        here: [i64; 2],
        aim: [i64; 2],
        to: [i64; 2],
        now: Micros,
    ) -> bool {
        // Aiming at its own place, the walk stands for its line (the planner answers a tick later): no corner, so no
        // tick of walking. Its distance straight to `to` would be taken as the least left, and a route round something,
        // longer than that by more than [`GAIN`], found stalled a [`WINDOW`] on, at full walking speed.
        if aim == here {
            return false;
        }
        let t = self.walkers.entry(who).or_insert(Track {
            to,
            aimed: now,
            samples: VecDeque::new(),
        });
        // A new leg's end, or a new corner once the walker has reached the one it aimed at (the line moves on only past
        // a corner it reached), starts the watch again: reaching a corner is progress. The way left through a corner
        // that turns away from the leg's end can be metres longer than the least before it, though the walker goes
        // on at full speed round a building (#1960).
        let reached = t
            .samples
            .back()
            .is_some_and(|b| b.aim != aim && b.near <= REACHED);
        if t.to != to || reached {
            (t.to, t.aimed) = (to, now);
            t.samples.clear();
        }
        let left = len(here, aim).saturating_add(len(aim, to));
        let near = len(here, aim);
        let s = match t.samples.back() {
            Some(b) if b.aim == aim => Sample {
                at: now,
                here,
                left: b.left.min(left),
                aim,
                near: b.near.min(near),
            },
            Some(b) => {
                t.aimed = now;
                Sample {
                    at: now,
                    here,
                    left: b.left.min(left),
                    aim,
                    near,
                }
            }
            None => Sample {
                at: now,
                here,
                left,
                aim,
                near,
            },
        };
        t.samples.push_back(s);
        // The newest sample a window or more old stays as the window's start.
        while t.samples.len() > 1 && t.samples[1].at <= now - WINDOW {
            t.samples.pop_front();
        }
        let first = t.samples[0];
        if now - first.at < WINDOW {
            return false;
        }
        let on_left = first.left - s.left >= GAIN;
        let on_corner = t.aimed <= first.at && first.near - s.near >= GAIN;
        // Or nearer the corner it aims at now than where the window began, by its place: a line that turns away from
        // the leg's end at a corner reached within the window makes the way left through the new corner longer than
        // the least before it, though the walker goes on at full speed (#1960).
        let on_aim = len(first.here, aim).saturating_sub(len(here, aim)) >= GAIN;
        !(on_left || on_corner || on_aim)
    }

    /// Only the walkers in `walking` (their walks asked their way this tick) are watched on; any other starts again
    /// when next seen.
    pub fn keep(&mut self, walking: &BTreeSet<Id>) {
        self.walkers.retain(|w, _| walking.contains(w));
    }

    /// Walkers watched.
    pub fn len(&self) -> usize {
        self.walkers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.walkers.is_empty()
    }
}

fn int(v: &Value) -> i64 {
    match v {
        Value::Uint(u) => i64::try_from(*u).unwrap_or(i64::MAX),
        Value::Nint(u) => -i64::try_from(*u).unwrap_or(i64::MAX) - 1,
        _ => 0,
    }
}

/// How far `p` is from the box `ring` (x and z µm), 0 inside it.
fn to_box(p: [i64; 2], ring: &[[i64; 2]; 4]) -> i64 {
    let side = |a: [i64; 2], b: [i64; 2]| {
        i128::from(b[0] - a[0]) * i128::from(p[1] - a[1])
            - i128::from(b[1] - a[1]) * i128::from(p[0] - a[0])
    };
    let s: Vec<i128> = (0..4).map(|i| side(ring[i], ring[(i + 1) % 4])).collect();
    if s.iter().all(|&c| c >= 0) || s.iter().all(|&c| c <= 0) {
        return 0;
    }
    (0..4)
        .map(|i| {
            let (a, b) = (ring[i], ring[(i + 1) % 4]);
            let e = [i128::from(b[0] - a[0]), i128::from(b[1] - a[1])];
            let l2 = (e[0] * e[0] + e[1] * e[1]).max(1);
            let t = (i128::from(p[0] - a[0]) * e[0] + i128::from(p[1] - a[1]) * e[1]).clamp(0, l2);
            let q = [a[0] + (e[0] * t / l2) as i64, a[1] + (e[1] * t / l2) as i64];
            len(p, q)
        })
        .min()
        .unwrap_or(i64::MAX)
}

/// How near node `h`'s own solids (N1's rows, mm, in its frame) come to `p`, in the frame of `ground`; `None` when it
/// has none that meet a body's height.
fn solids_near(tree: &Tree, h: Handle, ground: Handle, p: [i64; 2]) -> Option<i64> {
    let node = tree.node(h)?;
    let Some(Value::Array(rows)) = node.fields().get(&F_SOLIDS) else {
        return None;
    };
    let x = xform_to(tree, h, ground).ok()?;
    let mut best = None::<i64>;
    for r in rows {
        let Value::Array(r) = r else { continue };
        let n: Vec<i64> = r.iter().map(|v| int(v).saturating_mul(1000)).collect();
        let [cx, cz, hx, hz, yaw, y0, y1, ..] = n[..] else {
            continue;
        };
        // A box under a body's knee or over its head blocks no walk.
        if y1 <= 220_000 || y0 >= 1_800_000 {
            continue;
        }
        let turn = Quat::from_yaw_mdeg(yaw / 1000).ok()?;
        let mut ring = [[0i64; 2]; 4];
        for (i, (u, v)) in [(-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz)]
            .iter()
            .enumerate()
        {
            let q = turn.rotate(Vec3::new(*u, 0, *v)).ok()?;
            let q = x.point(Vec3::new(cx + q.x, 0, cz + q.z)).ok()?;
            ring[i] = [q.x, q.z];
        }
        let d = to_box(p, &ring);
        best = Some(best.map_or(d, |b| b.min(d)));
    }
    best
}

/// What blocks a walker standing at `here` (x and z µm) on node `ground`: the thing below `ground` (on it, or in a
/// room of it) whose solids come nearest, within [`NEAR`], as `kind id, n.nn m away`; else the edge of the walked
/// ground there. Read only when a walk stalls.
pub fn blocker(tree: &Tree, ground: Id, here: [i64; 2]) -> String {
    let Some(g) = tree.handle(ground) else {
        return format!("the edge of the walked ground at {}", at(here));
    };
    let mut best: Option<(i64, Handle)> = None;
    let mut stack: Vec<(Handle, u8)> = vec![(g, 0)];
    while let Some((h, depth)) = stack.pop() {
        for &c in tree.children(h).unwrap_or(&[]) {
            // Things far from the walker are skipped by their place, before their solids are read.
            let far = tree
                .node(c)
                .and_then(|n| n.place())
                .zip(xform_to(tree, h, g).ok())
                .and_then(|(p, x)| x.point(p.position).ok())
                .is_some_and(|q| len([q.x, q.z], here) > 40_000_000);
            if far {
                continue;
            }
            if let Some(d) = solids_near(tree, c, g, here)
                && best.is_none_or(|(b, _)| d < b)
            {
                best = Some((d, c));
            }
            if depth < 2 {
                stack.push((c, depth + 1));
            }
        }
    }
    match best
        .and_then(|(d, h)| Some((d, tree.node(h)?)))
        .filter(|(d, _)| *d <= NEAR)
    {
        Some((d, n)) => format!(
            "{} {}, {}.{:02} m away",
            plain(n.kind().as_str()),
            show(n.id()),
            d / 1_000_000,
            (d % 1_000_000) / 10_000
        ),
        None => format!("the edge of the walked ground at {}", at(here)),
    }
}

fn at(p: [i64; 2]) -> String {
    format!("({:.2}, {:.2}) m", p[0] as f64 / 1e6, p[1] as f64 / 1e6)
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::pose::fixture;

    const TICK: Micros = 50_000;

    /// Walks `who` from `from` by `step` µm a tick toward `to` (aiming at `to`), each tick at most `moved` of it,
    /// for `ticks` ticks: the tick it was found stalled, if any.
    fn walk(
        w: &mut Watch,
        from: [i64; 2],
        to: [i64; 2],
        speed: impl Fn(u32) -> i64,
        ticks: u32,
    ) -> Option<u32> {
        let mut p = from;
        for t in 0..ticks {
            if w.seen(fixture(9), p, to, to, Micros::from(t) * TICK) {
                return Some(t);
            }
            p[1] += speed(t);
        }
        None
    }

    /// A corner or leg's end anywhere in µm, the far ends of i64 included (a forgotten line's sentinel, #1960), is
    /// measured without overflow: it panicked the clock thread before.
    #[test]
    fn extreme_points_never_overflow() {
        let mut w = Watch::new();
        let far = [i64::MIN, i64::MIN];
        for t in 0..100 {
            let _ = w.seen(
                fixture(9),
                [57_000_000, t * 70_000],
                [57_170_000, 0],
                far,
                t * TICK,
            );
        }
        assert_eq!(len([i64::MAX, i64::MAX], far), i64::MAX);
        assert_eq!(len([0, 0], [3, 4]), 5);
    }

    /// Served Eden (#1960): walking west at 1.4 m/s toward its leg's end 145 m to the north-west, the walk reaches a
    /// corner and turns for the next, 16 m west, which makes the way left through it 9 m longer than the least before.
    /// Before, it was found stalled 3 s on, still at full speed: the least left was not reached again in the window,
    /// and the new corner had not been aimed at the whole window.
    #[test]
    fn a_corner_that_turns_away_from_the_legs_end_is_progress() {
        let mut w = Watch::new();
        let (first, next, to) = (
            [-431_932_300, 104_688_193],
            [-448_000_000, 105_500_000],
            [-500_000_000, 250_000_000],
        );
        for t in 0..400i64 {
            let here = [-420_000_000 - t * 70_000, 104_100_000];
            let aim = if here[0] > first[0] + 250_000 {
                first
            } else {
                next
            };
            assert!(!w.seen(fixture(9), here, aim, to, t * TICK), "tick {t}");
        }
    }

    /// Served Eden (#1960): born beside a cottage, the walk goes north round its west wall, away from its leg's end (the
    /// front door, 11 m south-east), then turns east along the north wall. The way left through its first corner was
    /// the least; through the second, 2 m longer, and the walker gained on that corner, aimed at the whole window. On
    /// the tick it reached it and turned for the third, it was found stalled: the way left through the third was
    /// longer still, it had aimed at it for no window, and it was no nearer it than 3 s before.
    #[test]
    fn a_corner_reached_round_a_building_is_progress() {
        let to = [-91_391_500, -96_577_000];
        let corners = [
            [-97_970_226, -90_694_387],
            [-96_044_870, -85_211_099],
            [-85_649_000, -96_000_000],
        ];
        let (mut w, mut here, mut next) = (Watch::new(), [-98_134_000, -92_500_000], 0);
        for t in 0..300i64 {
            if len(here, corners[next]) <= 100_000 && next + 1 < corners.len() {
                next += 1;
            }
            let aim = corners[next];
            assert!(!w.seen(fixture(9), here, aim, to, t * TICK), "tick {t}");
            let d = len(here, aim).max(1);
            let step = 70_000.min(d);
            here = [
                here[0] + (aim[0] - here[0]) * step / d,
                here[1] + (aim[1] - here[1]) * step / d,
            ];
        }
        // Pinned, aimed at corners in turn that it never comes near (new lines): none is reached, and it is found.
        let mut w = Watch::new();
        let stalled = (0..200i64).find(|t| {
            let aim = corners[(*t as usize / 10) % 3];
            w.seen(fixture(9), [-98_134_000, -92_500_000], aim, to, t * TICK)
        });
        assert_eq!(stalled, Some(60));
    }

    #[test]
    fn c21_a2_a_walk_that_gains_too_little_over_3_s_is_found_stalled_at_3_s() {
        // Walking at 1.4 m/s for 2 s, then pushed against something: it moves no more.
        let mut w = Watch::new();
        let stalled = walk(
            &mut w,
            [0, 0],
            [0, 20_000_000],
            |t| if t < 40 { 70_000 } else { 0 },
            400,
        );
        // It last moved at tick 39; once its last 3 s hold less than 0.25 m of gain (the window from tick 37), it is
        // found, at once.
        assert_eq!(stalled, Some(97));
        // Jittering in place, a few cm to and fro: no gain either.
        let mut w = Watch::new();
        let stalled = walk(
            &mut w,
            [0, 0],
            [0, 20_000_000],
            |t| if t % 2 == 0 { 30_000 } else { -30_000 },
            400,
        );
        assert_eq!(stalled, Some(60));
    }

    #[test]
    fn c21_a3_a_slow_walk_still_progressing_is_not_ended() {
        // A crowded doorway: 0.1 m/s, 0.3 m in 3 s.
        let mut w = Watch::new();
        assert_eq!(walk(&mut w, [0, 0], [0, 20_000_000], |_| 5_000, 1200), None);
        // Stop and go: 2 s still, then 1 s at walking speed, for a minute.
        let mut w = Watch::new();
        assert_eq!(
            walk(
                &mut w,
                [0, 0],
                [0, 200_000_000],
                |t| if t % 60 < 40 { 0 } else { 70_000 },
                1200
            ),
            None
        );
    }

    #[test]
    fn c21_going_round_a_corner_away_from_the_goal_is_progress() {
        // The goal lies behind a wall: the walk aims at a corner 8 m to the side, moving away from its goal.
        let mut w = Watch::new();
        let (corner, goal) = ([8_000_000, 0], [0, -10_000_000]);
        for t in 0..114u32 {
            let here = [i64::from(t) * 70_000, 0];
            assert!(!w.seen(fixture(9), here, corner, goal, Micros::from(t) * TICK));
        }
        // A tick with no ask (waiting its turn) starts its watch again.
        w.keep(&BTreeSet::new());
        assert!(w.is_empty());
    }

    #[test]
    fn c22_standing_for_its_line_then_going_round_is_progress() {
        // Eden's tower (C22, #3485): the walk stands two ticks for its line, aiming at its own place, then goes 2.4 m
        // to the side and on past the tower's wall at walking speed, its goal 5.7 m from where it began. Before, the
        // standing ticks set the least left to 5.7 m, the route through the corner was longer, and the walk was found
        // stalled 3 s after it began, still at full speed.
        let (start, corner, goal) = ([0, 0], [2_400_000, 0], [0, 5_700_000]);
        let mut w = Watch::new();
        for t in 0..2u32 {
            assert!(!w.seen(fixture(9), start, start, goal, Micros::from(t) * TICK));
        }
        for t in 2..36u32 {
            let here = [i64::from(t - 2) * 70_000, 0];
            assert!(!w.seen(fixture(9), here, corner, goal, Micros::from(t) * TICK));
        }
        for t in 36..100u32 {
            let here = [2_380_000, i64::from(t - 36) * 70_000];
            assert!(!w.seen(fixture(9), here, goal, goal, Micros::from(t) * TICK));
        }
        // Standing for its line, then pushed against something at once: still found, a window after its first aimed
        // tick.
        let mut w = Watch::new();
        let found = (0..200u32).find(|&t| {
            let aim = if t < 2 { start } else { corner };
            w.seen(fixture(9), start, aim, goal, Micros::from(t) * TICK)
        });
        assert_eq!(found, Some(62));
    }
}
