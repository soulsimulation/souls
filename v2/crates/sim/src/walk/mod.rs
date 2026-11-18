//! The walk skill (Engine v2 N7, #2655): walks bodies along their routes, keeping them apart from each other. Other
//! people are a preference, not a wall: they change the velocity a body wants, never the ground it may stand on.
//!
//! - **A tick.** Each walker, in id order: aim at the next corner of its route's line (the [`World`] gives it), add a
//!   push away from every neighbour within [`RANGE`], leaning right when one comes head-on, and hand the velocity to
//!   the mover. At a link's near end it crosses the link by the link's move, opening a shut door first (stand, open,
//!   cross: the opening is written at the end of the tick and read the next, T1).
//! - **Neighbours** are read as of the previous tick (T1, `v2/docs/TRUNK.md`): a plain grid per node of the bodies'
//!   positions and velocities, taken before any walker moves, in cells of [`RANGE`]. Two at one point push apart
//!   by id: the lower id goes right.
//! - **A preference.** The push is resolved on the walker's own axes: forward, where it may slow the walker but never
//!   below a tenth of its free speed (no waiting at a narrow place yet: N8), and sideways. The sum never exceeds free
//!   speed. Overlap is allowed, and measured ([`Crowd::close`]).
//! - **One trait.** Everything the skill reads of the world or asks of it (the route's legs, the next corner, a step
//!   of the mover, a tick of crossing a link) goes through [`World`], so K13 can re-link it. [`town::Town`] is the
//!   trait over N5's map, N6's mover and N4's links and doors.
//! - **Integers.** Positions in µm, velocities in µm a second, time in µs; square roots by `isqrt`. Nothing is hashed
//!   or decided by a float.
//!
//! Not here: turns (N8), standing spots (N9), the ladder (N10), the neighbour index proper (N16), the transfer records
//! of a crossing (N6's `mover::cross` needs the zone's pose scene, which no caller holds yet).

pub mod town;

use crate::mover::Body;
use replica::effects::Refusal;
use replica::ids::Id;
use replica::pose::{Support, Vec3};
use replica::time::Micros;
use std::collections::BTreeMap;

/// How far a neighbour pushes, µm: from [`GAIN`] times the walker's free speed at no distance to nothing at this one.
pub const RANGE: i64 = 1_200_000;
/// A neighbour's push at no distance, in free speeds.
pub const GAIN: i64 = 2;
/// Two centres closer than this, µm, are an overlap (measured, never prevented).
pub const CLOSE: i64 = 420_000;
/// The lean to the right when a neighbour comes head-on, as a share of its push: `LEAN / 4`.
pub const LEAN: i64 = 2;
/// A leg's end is reached within this, µm: a link's near end.
pub const AT_LINK: i64 = 50_000;
/// A walk's goal is reached within this, µm.
pub const AT_GOAL: i64 = 300_000;

/// One leg of a walk: walk to `to` (µm, in the frame of the node the body stands on), then cross `link`, or arrive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leg {
    pub to: Vec3,
    pub link: Option<Id>,
}

/// The world as the walk skill sees it. Every read and every change the skill makes goes through these four calls.
pub trait World {
    /// The legs from where `body` stands to `goal` (µm, the frame of node `node`), for a body with hands.
    fn plan(&mut self, body: &Body, node: Id, goal: Vec3) -> Result<Vec<Leg>, Refusal>;
    /// Where `body` aims next on its way to `to` (on the node it stands on), x and z µm: `to` when a straight walk
    /// reaches it, else the next corner of the line there.
    fn corner(&mut self, body: &Body, to: Vec3) -> Result<[i64; 2], Refusal>;
    /// One tick of the mover: `body` walks at `velocity` (µm a second, x and z) for `dt`, ending at world time `at`.
    fn step(
        &mut self,
        body: &mut Body,
        velocity: [i64; 2],
        dt: Micros,
        at: Micros,
    ) -> Result<(), Refusal>;
    /// One tick of crossing `link` from its near end at `speed`, for the order `order`: `true` once the body stands
    /// on the far side. A shut door is opened first, and the body stands that tick.
    fn cross(
        &mut self,
        body: &mut Body,
        link: Id,
        order: Id,
        speed: i64,
        dt: Micros,
        at: Micros,
    ) -> Result<bool, Refusal>;
}

/// The node a body stands on.
pub fn node_of(b: &Body) -> Id {
    match b.pose.support {
        Support::Surface { surface, .. } => surface,
        _ => b.pose.frame.node,
    }
}

/// A body the skill walks.
#[derive(Clone, Debug)]
pub struct Walker {
    pub body: Body,
    /// Free speed, µm a second.
    pub speed: i64,
    /// The order it walks for.
    pub order: Id,
    pub legs: Vec<Leg>,
    pub leg: usize,
    pub crossing: bool,
    /// When it arrived, µs of world time.
    pub arrived: Option<Micros>,
}

/// What a neighbour is, as of the previous tick.
#[derive(Clone, Copy)]
struct Seen {
    id: Id,
    node: Id,
    at: [i64; 2],
    v: [i64; 2],
}

/// The bodies of one tick by node and cell of [`RANGE`].
struct Grid {
    cells: BTreeMap<(Id, i64, i64), Vec<Seen>>,
}

impl Grid {
    fn of(walkers: &[Walker]) -> Grid {
        let mut cells: BTreeMap<(Id, i64, i64), Vec<Seen>> = BTreeMap::new();
        for w in walkers.iter().filter(|w| !w.crossing) {
            let p = w.body.pose.position;
            let s = Seen {
                id: w.body.id,
                node: node_of(&w.body),
                at: [p.x, p.z],
                v: [w.body.linear.x, w.body.linear.z],
            };
            cells.entry(Grid::key(s.node, s.at)).or_default().push(s);
        }
        Grid { cells }
    }

    fn key(node: Id, p: [i64; 2]) -> (Id, i64, i64) {
        (node, p[0].div_euclid(RANGE), p[1].div_euclid(RANGE))
    }

    /// Every other body on `node` within `r` of `p`, in id order.
    fn near(&self, me: Id, node: Id, p: [i64; 2], r: i64) -> Vec<(Seen, i64)> {
        let (_, i, j) = Grid::key(node, p);
        let mut out = Vec::new();
        for di in -1..=1 {
            for dj in -1..=1 {
                for s in self
                    .cells
                    .get(&(node, i + di, j + dj))
                    .into_iter()
                    .flatten()
                {
                    if s.id == me {
                        continue;
                    }
                    let d = len([p[0] - s.at[0], p[1] - s.at[1]]);
                    if d < r {
                        out.push((*s, d));
                    }
                }
            }
        }
        out.sort_by_key(|(s, _)| s.id);
        out
    }
}

fn len(v: [i64; 2]) -> i64 {
    let (x, z) = (i128::from(v[0]), i128::from(v[1]));
    (x * x + z * z).isqrt() as i64
}

/// The velocity a walker at `p` wants toward `aim`: free speed `speed` (less when the aim is nearer than a tick),
/// pushed by its neighbours `near` (each with its distance), resolved on its own axes.
fn wanted(
    me: Id,
    p: [i64; 2],
    aim: [i64; 2],
    speed: i64,
    dt: Micros,
    near: &[(Seen, i64)],
) -> [i64; 2] {
    let d = [i128::from(aim[0] - p[0]), i128::from(aim[1] - p[1])];
    let l = (d[0] * d[0] + d[1] * d[1]).isqrt();
    if l == 0 {
        return [0, 0];
    }
    let speed = i128::from(speed);
    // Free speed toward the aim, or just enough to reach it this tick.
    let s = speed.min(l * 1_000_000 / i128::from(dt.max(1)));
    // The walker's axes: forward d / l, and its right, (-dz, dx) / l.
    let r = [-d[1], d[0]];
    let (mut f, mut g) = (s, 0i128);
    for (n, dist) in near {
        let o = [i128::from(p[0] - n.at[0]), i128::from(p[1] - n.at[1])];
        let push = speed * i128::from(GAIN) * i128::from(RANGE - dist) / i128::from(RANGE);
        if *dist == 0 {
            // At one point: apart by id, the lower id to its right.
            g += if me < n.id { push } else { -push };
            continue;
        }
        let dist = i128::from(*dist);
        f += push * (o[0] * d[0] + o[1] * d[1]) / (dist * l);
        g += push * (o[0] * r[0] + o[1] * r[1]) / (dist * l);
        // Head-on: ahead of the walker and coming toward it.
        let ahead = o[0] * d[0] + o[1] * d[1] < 0;
        let toward = i128::from(n.v[0]) * d[0] + i128::from(n.v[1]) * d[1] < 0;
        if ahead && toward {
            g += push * i128::from(LEAN) / 4;
        }
    }
    // Sideways first (stepping aside costs less than stopping), then forward, at least the floor, within free speed.
    let floor = (speed / 10).min(s);
    let side = (s * s - floor * floor).isqrt();
    let g = g.clamp(-side, side);
    let f = f.clamp(floor, (s * s - g * g).isqrt().max(floor));
    [
        ((f * d[0] + g * r[0]) / l) as i64,
        ((f * d[1] + g * r[1]) / l) as i64,
    ]
}

/// Walkers walked together, a tick at a time, with what the overlap measure counted.
pub struct Crowd {
    /// In id order.
    pub walkers: Vec<Walker>,
    pub tick: Micros,
    pub now: Micros,
    /// Walker-ticks walked (a walker not yet arrived, after its step).
    pub walked: u64,
    /// Of those, the ones with another centre closer than [`CLOSE`] on the same node.
    pub close: u64,
}

impl Crowd {
    pub fn new(tick: Micros) -> Crowd {
        Crowd {
            walkers: Vec::new(),
            tick,
            now: 0,
            walked: 0,
            close: 0,
        }
    }

    /// Adds a walker for the order `order`, its legs planned to `goal` on node `node`.
    pub fn add(
        &mut self,
        world: &mut impl World,
        body: Body,
        speed: i64,
        order: Id,
        node: Id,
        goal: Vec3,
    ) -> Result<(), Refusal> {
        let legs = world.plan(&body, node, goal)?;
        let w = Walker {
            body,
            speed,
            order,
            legs,
            leg: 0,
            crossing: false,
            arrived: None,
        };
        let k = self.walkers.partition_point(|o| o.body.id < w.body.id);
        self.walkers.insert(k, w);
        Ok(())
    }

    /// Whether every walker has arrived.
    pub fn done(&self) -> bool {
        self.walkers.iter().all(|w| w.arrived.is_some())
    }

    /// One tick for every walker, in id order, against its neighbours as they stood at the end of the last tick.
    pub fn step(&mut self, world: &mut impl World) -> Result<(), Refusal> {
        let grid = Grid::of(&self.walkers);
        let (dt, at) = (self.tick, self.now + self.tick);
        for w in self.walkers.iter_mut() {
            if w.arrived.is_some() {
                continue;
            }
            if w.crossing {
                let link = w.legs[w.leg].link.expect("a crossing leg");
                if world.cross(&mut w.body, link, w.order, w.speed, dt, at)? {
                    w.crossing = false;
                    w.leg += 1;
                }
                continue;
            }
            let leg = w.legs[w.leg];
            let p = w.body.pose.position;
            let gap = len([leg.to.x - p.x, leg.to.z - p.z]);
            match leg.link {
                Some(link) if gap <= AT_LINK => {
                    w.crossing = true;
                    if world.cross(&mut w.body, link, w.order, w.speed, dt, at)? {
                        w.crossing = false;
                        w.leg += 1;
                    }
                    continue;
                }
                None if gap <= AT_GOAL => {
                    w.arrived = Some(self.now);
                    continue;
                }
                _ => {}
            }
            let aim = world.corner(&w.body, leg.to)?;
            let node = node_of(&w.body);
            let near = grid.near(w.body.id, node, [p.x, p.z], RANGE);
            let v = wanted(w.body.id, [p.x, p.z], aim, w.speed, dt, &near);
            world.step(&mut w.body, v, dt, at)?;
        }
        self.now = at;
        // The overlap measure, on where the bodies stand now.
        let after = Grid::of(&self.walkers);
        for w in self.walkers.iter().filter(|w| w.arrived.is_none()) {
            if w.crossing {
                continue;
            }
            self.walked += 1;
            let p = w.body.pose.position;
            if !after
                .near(w.body.id, node_of(&w.body), [p.x, p.z], CLOSE)
                .is_empty()
            {
                self.close += 1;
            }
        }
        Ok(())
    }
}
