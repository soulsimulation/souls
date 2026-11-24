//! A long load turned through a door (0.135 R2, #2814): when the straight way to a lift's destination clips fixed
//! geometry, a search over the load's poses finds a way that turns it, or the lift is refused by name.
//!
//! - **A pose** is the carry's middle on a lattice of [`STEP`] round the middle at the lift, and its heading, one of
//!   [`TURNS`] about the heading at the lift. The carriers stand as the carry's frame has them ([`super::Carry`]'s
//!   pose): in line, half their span either side of the middle. So a pose is exactly where the two would stand.
//! - **A move** is one lattice step of the middle (eight ways) or one turn about it. Each is checked with C7's own
//!   check ([`super::way`]: the load's outline between its carriers at every [`super::SWEEP_STEP`] of either end, as
//!   it is held, at its own height), the load grown by [`MARGIN`] each way so two carriers walking it a little out of
//!   step stay legal; and each carrier's body, a square of [`BODY_HALF`] about it, against the boxes a walking body
//!   meets ([`Fixed::hit`]), at the same steps. No move goes through forbidden geometry, so neither does the way.
//! - **The search** is a weighted A* (cost: how far the farther end moves; estimate: [`GREED`] times the front's
//!   distance to the destination), in a fixed order, so the same world gives the same way. The middle stays within [`ROOM`] beyond half the span of
//!   the straight way (from the back, to the front, to the destination). It ends when the front is within [`STEP`]
//!   of the destination. Every pose of that band tried, none there: `carry-load-blocked`, before the lift. More than
//!   `budget` poses tried: `carry-unproven`. [`BUDGET`] is small, so a lift is answered soon: a way through a door
//!   near the lift, not a long way round (a destination beyond it is refused unproven; lift for the door's far side,
//!   then lift again).
//! - **Off the clock.** The search is a route search: it calls `crate::commit::off_clock`, so on the world's clock
//!   thread it panics in a debug build and is counted in a release build. worldd's engine asks it of its own thread
//!   and answers the lift when the way comes back; the same inputs give the same way on any thread.
//! - **The way is the world's** ([`super::Carry::way`]): kept on the carry at the lift and said to its audience
//!   (`souls:carry-way`), so its carriers walk it pose by pose; each tick is still checked by C7's check.
//!
//! Not here: carriers that swing about their grips (the group held in line is the load plus both reaches and both
//! bodies, so a 2 m board cannot round a corner between 1.2 m corridors: #2814's corner, proposed as a task); three
//! carriers or more turning; stairs.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

use replica::pose::{Quat, Vec3};

use super::{Fixed, Load, Quad, R, SWEEP_STEP, len, pose_refusal, refuse, scale, way};
use crate::ground::scene::Xz;

/// The lattice's step for the carry's middle, µm.
pub const STEP: i64 = 200_000;
/// How many headings the lattice has, about the heading at the lift: 15 degrees apart.
pub const TURNS: i64 = 24;
/// How much the load is grown each way while a way is searched, µm: two carriers walking it a little out of step,
/// each tick still checked by C7 against its own outline, stay clear.
pub const MARGIN: i64 = 100_000;
/// Half the side of the square a carrier's body takes up while a way is searched, µm: the body's 0.28 m and 50 mm.
pub const BODY_HALF: i64 = 330_000;
/// How far beyond half the span the middle may stray from the straight way, µm.
pub const ROOM: i64 = 2_000_000;
/// How many poses the search tries before it gives up as unproven. It bounds how long a lift waits for its way, off
/// the clock: measured in release at about 20 µs a pose on a ground of posts every 1.5 m
/// (`r2_a_sealed_destination_never_holds_the_clock`), a few milliseconds at most. A door near the lift takes about a
/// hundred.
pub const BUDGET: usize = 200;
/// How much the estimate counts against the cost so far: more than one, so the search heads for the destination
/// and tries few poses (a weighted A*; the way found is legal, not always the shortest).
pub const GREED: i64 = 2;

/// A pose on the lattice: the middle's steps along x and z from the middle at the lift, and the heading's.
type State = (i64, i64, i64);

/// Where each carrier stands, `(front, back)` on the open ground's plan, µm.
pub type Ends = (Xz, Xz);

fn square(p: Xz, d: Xz) -> Quad {
    let u = scale(d, BODY_HALF, len(d));
    let n = [-u[1], u[0]];
    [
        [p[0] + u[0] + n[0], p[1] + u[1] + n[1]],
        [p[0] + u[0] - n[0], p[1] + u[1] - n[1]],
        [p[0] - u[0] - n[0], p[1] - u[1] - n[1]],
        [p[0] - u[0] + n[0], p[1] - u[1] + n[1]],
    ]
}

/// Whether both carriers' bodies stay clear of what a walking body meets as they walk from `a` to `b`, at every
/// twice [`SWEEP_STEP`] of either: a body between two of those is within half that, 50 mm, of one, and the square
/// checked there is 50 mm wider than the body's 0.28 m.
fn bodies_clear(fixed: &Fixed, a: Ends, b: Ends) -> bool {
    let moved = |p: Xz, q: Xz| len([q[0] - p[0], q[1] - p[1]]);
    let n = moved(a.0, b.0)
        .max(moved(a.1, b.1))
        .div_euclid(2 * SWEEP_STEP)
        + 1;
    let between = |p: Xz, q: Xz, k: i64| {
        let d = scale([q[0] - p[0], q[1] - p[1]], k, n);
        [p[0] + d[0], p[1] + d[1]]
    };
    (0..=n).all(|k| {
        let (f, r) = (between(a.0, b.0, k), between(a.1, b.1, k));
        let d = [f[0] - r[0], f[1] - r[1]];
        fixed.hit(&square(f, d)).is_none() && fixed.hit(&square(r, d)).is_none()
    })
}

/// The distance from `p` to the segment `a`–`b`, µm.
fn off_segment(p: Xz, a: Xz, b: Xz) -> i64 {
    let d = [i128::from(b[0] - a[0]), i128::from(b[1] - a[1])];
    let v = [i128::from(p[0] - a[0]), i128::from(p[1] - a[1])];
    let dd = d[0] * d[0] + d[1] * d[1];
    let t = if dd == 0 {
        0
    } else {
        (v[0] * d[0] + v[1] * d[1]).clamp(0, dd)
    };
    let q = [
        a[0] + (d[0] * t / dd.max(1)) as i64,
        a[1] + (d[1] * t / dd.max(1)) as i64,
    ];
    len([p[0] - q[0], p[1] - q[1]])
}

/// A way for `load`, its carriers at `front` and `back`, to carry its front to within [`STEP`] of `to` (each on the
/// open ground's plan, µm), turning it as the fixed geometry needs: every pose from the lift to the end, as where the
/// carriers stand, the first where they stand now. Refused `carry-load-blocked` when no way exists within [`ROOM`]
/// of the straight way, `carry-unproven` when more than `budget` poses were tried.
pub fn turn_way(
    load: &Load,
    fixed: &Fixed,
    front: Xz,
    back: Xz,
    to: Xz,
    budget: usize,
) -> R<Vec<Ends>> {
    search(load, fixed, front, back, to, budget).0
}

/// [`turn_way`], and how many poses it tried.
pub fn search(
    load: &Load,
    fixed: &Fixed,
    front: Xz,
    back: Xz,
    to: Xz,
    budget: usize,
) -> (R<Vec<Ends>>, usize) {
    crate::commit::off_clock();
    let mut tried = 0usize;
    let r = search_counted(load, fixed, (front, back), to, budget, &mut tried);
    (r, tried)
}

fn search_counted(
    load: &Load,
    fixed: &Fixed,
    (front, back): Ends,
    to: Xz,
    budget: usize,
    tried: &mut usize,
) -> R<Vec<Ends>> {
    let h = load.half;
    let fat = Load {
        half: Vec3::new(h.x + MARGIN, h.y + MARGIN, h.z + MARGIN),
        ..*load
    };
    let c0 = [(front[0] + back[0]) / 2, (front[1] + back[1]) / 2];
    let h0 = Vec3::new(front[0] - c0[0], 0, front[1] - c0[1]);
    let mut halves = Vec::new();
    for k in 0..TURNS {
        let v = Quat::from_yaw_mdeg(k * 360_000 / TURNS)
            .and_then(|q| q.rotate(h0))
            .map_err(pose_refusal)?;
        halves.push([v.x, v.z]);
    }
    let ends = |s: State| -> Ends {
        let c = [c0[0] + s.0 * STEP, c0[1] + s.1 * STEP];
        let v = halves[s.2 as usize];
        ([c[0] + v[0], c[1] + v[1]], [c[0] - v[0], c[1] - v[1]])
    };
    let band = len([h0.x, h0.z]) + ROOM;
    let within = |s: State| {
        let c = [c0[0] + s.0 * STEP, c0[1] + s.1 * STEP];
        off_segment(c, back, front).min(off_segment(c, front, to)) <= band
    };
    let fits = |e: Ends| way(fixed, &fat, e, e, &[]).is_ok() && bodies_clear(fixed, e, e);
    let goal = |e: Ends| len([e.0[0] - to[0], e.0[1] - to[1]]) <= STEP;
    let guess = |e: Ends| GREED * len([e.0[0] - to[0], e.0[1] - to[1]]);

    let start: State = (0, 0, 0);
    let first = (front, back);
    if !fits(first) {
        return refuse(
            "carry-load-blocked",
            "where it is lifted, the load or a carrier meets fixed geometry".to_owned(),
        );
    }
    let mut best: BTreeMap<State, (i64, Option<State>)> = BTreeMap::from([(start, (0, None))]);
    let mut fit: BTreeMap<State, bool> = BTreeMap::from([(start, true)]);
    let mut open = BinaryHeap::from([Reverse((guess(ends(start)), 0i64, start))]);
    let diag = STEP * 1_414_214 / 1_000_000;
    while let Some(Reverse((_, g, s))) = open.pop() {
        if best.get(&s).is_some_and(|b| b.0 < g) {
            continue;
        }
        let here = ends(s);
        if goal(here) {
            let mut way_back = vec![s];
            let mut at = s;
            while let Some(&(_, Some(p))) = best.get(&at) {
                way_back.push(p);
                at = p;
            }
            way_back.reverse();
            let mut out = vec![first];
            // A run of the same step is one straight walk for both carriers: only its ends are kept.
            for w in way_back.windows(3) {
                let d1 = (w[1].0 - w[0].0, w[1].1 - w[0].1, w[1].2 - w[0].2);
                let d2 = (w[2].0 - w[1].0, w[2].1 - w[1].1, w[2].2 - w[1].2);
                if d1 != d2 || d1.2 != 0 {
                    out.push(ends(w[1]));
                }
            }
            if way_back.len() > 1 {
                out.push(here);
            }
            return Ok(out);
        }
        *tried += 1;
        if *tried > budget {
            return refuse(
                "carry-unproven",
                format!("{budget} poses tried and no way found yet"),
            );
        }
        let mut next: Vec<(State, i64)> = Vec::new();
        for (di, dj) in [
            (1, 0),
            (-1, 0),
            (0, 1),
            (0, -1),
            (1, 1),
            (1, -1),
            (-1, 1),
            (-1, -1),
        ] {
            let cost = if di != 0 && dj != 0 { diag } else { STEP };
            next.push(((s.0 + di, s.1 + dj, s.2), cost));
        }
        for dk in [1, TURNS - 1] {
            let k = (s.2 + dk) % TURNS;
            let (a, b) = (halves[s.2 as usize], halves[k as usize]);
            next.push(((s.0, s.1, k), len([b[0] - a[0], b[1] - a[1]])));
        }
        for (n, cost) in next {
            let ng = g + cost;
            if best.get(&n).is_some_and(|b| b.0 <= ng) || !within(n) {
                continue;
            }
            let there = ends(n);
            let ok = *fit.entry(n).or_insert_with(|| fits(there));
            if !ok
                || way(fixed, &fat, here, there, &[]).is_err()
                || !bodies_clear(fixed, here, there)
            {
                continue;
            }
            best.insert(n, (ng, Some(s)));
            open.push(Reverse((ng + guess(there), ng, n)));
        }
    }
    refuse(
        "carry-load-blocked",
        format!(
            "no way turns it to ({}, {}) mm within {} mm of the straight way ({} poses tried)",
            to[0] / 1000,
            to[1] / 1000,
            band / 1000,
            *tried
        ),
    )
}
