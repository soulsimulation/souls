//! The walk skill (Engine v2 N7, #2655): walks bodies along their routes, keeping them apart from each other. Other
//! people are a preference, not a wall: they change the velocity a body wants, never the ground it may stand on.
//!
//! - **A tick.** Each walker, in id order: aim at the next corner of its route's line (the [`World`] gives it), add a
//!   push away from every neighbour within [`RANGE`], leaning right when one comes head-on, and hand the velocity to
//!   the mover. At a link's near end it crosses the link by the link's move, opening a shut door first (stand, open,
//!   cross: the opening is written at the end of the tick and read the next, T1).
//! - **Neighbours** are read as of the previous tick (T1, `v2/docs/TRUNK.md`): the spatial index (N16,
//!   `crate::index`) of the bodies' positions, with their velocities, taken before any walker moves. Two at one
//!   point push apart by id: the lower id goes right.
//! - **A preference.** The push is resolved on the walker's own axes: forward, where it may slow the walker but never
//!   below a tenth of its free speed (no waiting at a narrow place yet: N8), and sideways. The sum never exceeds free
//!   speed. Overlap is allowed, and measured ([`Crowd::close`]).
//! - **Turns at a narrow place** (N8, `crate::links::turns`). Walking to a link the world takes in turns, a walker
//!   without leave marks itself waiting once within [`MARK`] of the link's near end, and stands once within [`QUEUE`]
//!   of it, or behind a waiting walker for the same link within [`BEHIND`] and nearer the end. It never writes the
//!   link's state: at the start of each tick the world reads every walker's mark as of the last tick
//!   ([`World::turns`]) and the link's owner writes who may enter; a walker crosses only with leave
//!   ([`World::pass`]). Those waiting make way: they push only each other, so the walker let in and those
//!   coming out pass through. A crossing, once begun, runs to its end.
//! - **One trait.** Everything the skill reads of the world or asks of it (the route's legs, the next corner, a step
//!   of the mover, a tick of crossing a link, the marks read and the leave to enter) goes through [`World`], so K13
//!   can re-link it. [`town::Town`] is the trait over N5's map, N6's mover and N4's links, doors and turns.
//! - **Integers.** Positions in µm, velocities in µm a second, time in µs; square roots by `isqrt`. Nothing is hashed
//!   or decided by a float.
//!
//! - **Standing spots** (N9, `crate::spots`). A walker sent to a point ([`Crowd::send`]) marks what it asks; at the
//!   start of each tick the world's spot tables read the marks of the last tick ([`World::spots`]) and grant each
//!   asker its own place near the point ([`World::spot`]). Until then it stands; once granted it walks to that place
//!   and arrives within [`AT_SPOT`] of it. Its mark asks while its order runs; when it no longer asks (it left, or
//!   its order ended, [`Crowd::end`]) the place is released.
//!
//! **Retiring** (T9b #3120): the walk now runs as a skill through the host (`skills::route`, the same algorithm). This
//! `Crowd` keeps its own bodies, stepped by the controller's dry run, until T9c moves N10's ladder and these tests onto
//! the skill.
//!
//! Not here: the ladder (N10), the transfer records
//! of a crossing (N6's `mover::cross` needs the zone's pose scene, which no caller holds yet).

pub mod town;

use crate::index::Index;
use crate::mover::Body;
use crate::spots::Target;
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
/// A granted standing spot is reached within this, µm (N9).
pub const AT_SPOT: i64 = 50_000;
/// Within this of its granted standing spot, µm, no neighbour pushes a walker (N9).
pub const CALM: i64 = 1_000_000;
/// A walker without leave marks itself waiting for a narrow link within this of its near end, µm.
pub const MARK: i64 = 3_000_000;
/// A walker without leave stands within this of a narrow link's near end, µm.
pub const QUEUE: i64 = 1_200_000;
/// A walker without leave stands behind a waiting walker for the same link this near and nearer the end, µm.
pub const BEHIND: i64 = 700_000;

/// May a walker enter a link now?
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pass {
    /// The link is not taken in turns.
    Free,
    /// Its owner let this walker in.
    Granted,
    /// Not yet: wait.
    Wait,
}

/// One body as the world reads it at the start of a tick (as it stood at the end of the last): where it is, the
/// link it waits for and how far from that link's near end (µm), the link it is crossing, whether it stays
/// where it is by its own order, and the point it asks a standing spot near, with its order (N9).
#[derive(Clone, Copy, Debug)]
pub struct Mark {
    pub who: Id,
    pub node: Id,
    pub at: Vec3,
    pub waiting: Option<(Id, i64)>,
    pub crossing: Option<Id>,
    pub staying: bool,
    pub spot: Option<(Target, Id)>,
}

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
    /// At the start of a tick ending at `at`: every body's mark as of the last tick, for the owners of the links
    /// taken in turns to write who may enter. A world with no such links needs nothing.
    fn turns(&mut self, _marks: &[Mark], _at: Micros) -> Result<(), Refusal> {
        Ok(())
    }
    /// Whether `who` may enter `link` now.
    fn pass(&self, _link: Id, _who: Id) -> Pass {
        Pass::Free
    }
    /// At the start of a tick ending at `at`, after the turns: every body's mark as of the last tick, for the owners
    /// of the spot tables to grant and release standing spots (N9). A world without them grants none.
    fn spots(&mut self, _marks: &[Mark], _at: Micros) -> Result<(), Refusal> {
        Ok(())
    }
    /// What `who`, sent to `target`, was given: its place (µm, the target node's frame) or a refusal's name; `None`
    /// until its ask is read.
    fn spot(&self, _who: Id, _target: &Target) -> Option<Result<Vec3, &'static str>> {
        None
    }
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
    /// The narrow link it waits for, and how far from its near end, µm (its mark, read by the link's owner).
    pub waiting: Option<(Id, i64)>,
    /// It stays where it is by its own order (E3's order; a scripted marker here): never moved, never waiting.
    pub staying: bool,
    /// The ladder's shoulder turn (N10, `crate::unstick`): no neighbour pushes it.
    pub shoulder: bool,
    /// The ladder holds it, so this skill never moves it: its order ended by this name, or `walk-out` (N10).
    pub held: Option<&'static str>,
    /// Sent to this point by a standing spot (N9), and the place granted there, once granted.
    pub to: Option<Target>,
    pub spot: Option<Vec3>,
}

/// What a neighbour is, as of the previous tick.
#[derive(Clone, Copy)]
struct Seen {
    id: Id,
    node: Id,
    at: [i64; 2],
    v: [i64; 2],
    waiting: Option<(Id, i64)>,
    /// Standing on its own granted spot (N9).
    settled: bool,
}

/// The bodies of one tick, as they stood before any walker moves: the spatial index (N16, `crate::index`) and what
/// each is.
struct Grid {
    index: Index,
    seen: BTreeMap<Id, Seen>,
}

impl Grid {
    fn of(walkers: &[Walker], split: bool) -> Grid {
        let mut index = if split { Index::new() } else { Index::fixed() };
        let mut seen = BTreeMap::new();
        for w in walkers.iter().filter(|w| !w.crossing) {
            let p = w.body.pose.position;
            let s = Seen {
                id: w.body.id,
                node: node_of(&w.body),
                at: [p.x, p.z],
                v: [w.body.linear.x, w.body.linear.z],
                waiting: w.waiting,
                settled: w.spot.is_some() && w.arrived.is_some(),
            };
            index.put_body(s.id, s.node, s.at);
            seen.insert(s.id, s);
        }
        Grid { index, seen }
    }

    /// Every other body on `node` within `r` of `p`, in id order.
    fn near(&self, me: Id, node: Id, p: [i64; 2], r: i64) -> Vec<(Seen, i64)> {
        self.index
            .bodies_within(node, p, r)
            .into_iter()
            .filter(|(id, _)| *id != me)
            .map(|(id, d)| (self.seen[&id], d))
            .collect()
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

/// The turns a stalled step is tried at, in order: none, then 45 degrees either way, then 70 either way (cosine and
/// sine in thousandths).
const TURNS: [(i64, i64); 5] = [(1000, 0), (707, 707), (707, -707), (342, 940), (342, -940)];

/// `v` turned by `(cos, sin)` (thousandths) and shortened by the cosine: the part of the step that still goes along
/// `v`'s way.
fn turned(v: [i64; 2], (c, s): (i64, i64)) -> [i64; 2] {
    let r = [(v[0] * c - v[1] * s) / 1000, (v[0] * s + v[1] * c) / 1000];
    [r[0] * c / 1000, r[1] * c / 1000]
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
    /// Whether the neighbour index splits crowded cells (N16; on by default). No walker notices either way.
    pub split: bool,
}

impl Crowd {
    pub fn new(tick: Micros) -> Crowd {
        Crowd {
            walkers: Vec::new(),
            tick,
            now: 0,
            walked: 0,
            close: 0,
            split: true,
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
            waiting: None,
            staying: false,
            shoulder: false,
            held: None,
            to: None,
            spot: None,
        };
        self.insert(w);
        Ok(())
    }

    /// Adds a walker sent to the point `target` for the order `order`: it asks for a standing spot near it, stands
    /// until one is granted, then walks there (N9).
    pub fn send(&mut self, body: Body, speed: i64, order: Id, target: Target) {
        self.insert(Walker {
            body,
            speed,
            order,
            legs: Vec::new(),
            leg: 0,
            crossing: false,
            arrived: None,
            waiting: None,
            staying: false,
            shoulder: false,
            held: None,
            to: Some(target),
            spot: None,
        });
    }

    /// Ends `who`'s order: it leaves the crowd, and what it held is released at the start of the next tick.
    pub fn end(&mut self, who: Id) -> Option<Walker> {
        let k = self.walkers.iter().position(|w| w.body.id == who)?;
        Some(self.walkers.remove(k))
    }

    fn insert(&mut self, w: Walker) {
        let k = self.walkers.partition_point(|o| o.body.id < w.body.id);
        self.walkers.insert(k, w);
    }

    /// Whether every walker has arrived.
    pub fn done(&self) -> bool {
        self.walkers
            .iter()
            .all(|w| w.arrived.is_some() || w.held.is_some())
    }

    /// One tick for every walker, in id order, against its neighbours as they stood at the end of the last tick.
    pub fn step(&mut self, world: &mut impl World) -> Result<(), Refusal> {
        let grid = Grid::of(&self.walkers, self.split);
        let (dt, at) = (self.tick, self.now + self.tick);
        // The marks as of the last tick, read by the owners of the links taken in turns.
        let marks: Vec<Mark> = self
            .walkers
            .iter()
            .map(|w| Mark {
                who: w.body.id,
                node: node_of(&w.body),
                at: w.body.pose.position,
                waiting: w.waiting.filter(|_| w.arrived.is_none()),
                crossing: w.crossing.then(|| w.legs[w.leg].link).flatten(),
                staying: w.staying,
                spot: w.to.filter(|_| w.held.is_none()).map(|t| (t, w.order)),
            })
            .collect();
        world.turns(&marks, at)?;
        world.spots(&marks, at)?;
        for w in self.walkers.iter_mut() {
            if w.arrived.is_some() || w.staying || w.held.is_some() {
                continue;
            }
            // Sent to a point: stand until a place is granted, then walk there; a refusal ends the order by its name.
            if let Some(t) = w.to
                && w.spot.is_none()
            {
                match world.spot(w.body.id, &t) {
                    Some(Ok(p)) => match world.plan(&w.body, t.node, p) {
                        Ok(legs) => {
                            (w.legs, w.leg, w.spot) = (legs, 0, Some(p));
                        }
                        Err(e) => {
                            w.held = Some(e.name);
                            continue;
                        }
                    },
                    Some(Err(name)) => {
                        w.held = Some(name);
                        continue;
                    }
                    None => {
                        w.body.linear = Vec3::ZERO;
                        continue;
                    }
                }
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
            // The wait: no leave to enter a narrow link, so mark, and stand near its end or behind one waiting.
            let pass = leg.link.map_or(Pass::Free, |l| world.pass(l, w.body.id));
            w.waiting = match leg.link {
                Some(l) if pass != Pass::Free && gap <= MARK => Some((l, gap)),
                _ => None,
            };
            if pass == Pass::Wait {
                let behind = grid
                    .near(w.body.id, node_of(&w.body), [p.x, p.z], BEHIND)
                    .iter()
                    .any(|(n, _)| {
                        n.waiting
                            .is_some_and(|(l, g)| Some(l) == leg.link && g < gap)
                    });
                if gap <= QUEUE || (gap <= MARK && behind) {
                    w.body.linear = Vec3::ZERO;
                    continue;
                }
            }
            match leg.link {
                Some(link) if gap <= AT_LINK && pass != Pass::Wait => {
                    w.crossing = true;
                    w.waiting = None;
                    if world.cross(&mut w.body, link, w.order, w.speed, dt, at)? {
                        w.crossing = false;
                        w.leg += 1;
                    }
                    continue;
                }
                None if gap <= if w.spot.is_some() { AT_SPOT } else { AT_GOAL } => {
                    w.arrived = Some(self.now);
                    continue;
                }
                _ => {}
            }
            let aim = world.corner(&w.body, leg.to)?;
            let node = node_of(&w.body);
            // Those waiting at a narrow place make way: they push only others waiting.
            let mut near = grid.near(w.body.id, node, [p.x, p.z], RANGE);
            // The shoulder turn, or the last stretch to a granted standing spot (N9): the spot is its own, so no
            // neighbour pushes it off.
            if w.shoulder || (w.spot.is_some() && leg.link.is_none() && gap <= CALM) {
                near.clear();
            } else if pass != Pass::Wait {
                near.retain(|(n, _)| n.waiting.is_none());
            }
            if w.spot.is_some() {
                // Those standing on their own spots stand apart already: a walker to its spot passes between them.
                near.retain(|(n, _)| !n.settled);
            }
            let v = wanted(w.body.id, [p.x, p.z], aim, w.speed, dt, &near);
            // Along an edge: a step the mover cuts to nothing is tried turned by 45 and then 70 degrees, either way
            // (the mover cuts a step at the ground's edge and does not slide).
            let before = w.body;
            for turn in TURNS {
                w.body = before;
                world.step(&mut w.body, turned(v, turn), dt, at)?;
                if w.body.pose.position != p || v == [0, 0] {
                    break;
                }
            }
        }
        self.now = at;
        // The overlap measure, on where the bodies stand now.
        let after = Grid::of(&self.walkers, self.split);
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
