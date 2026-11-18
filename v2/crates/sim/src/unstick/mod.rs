//! The never-stuck ladder (Engine v2 N10, #2657): no walking body is ever left stuck. A walker that makes no progress
//! climbs rungs by time, and its order ends by name before it could be parked; a body found on illegal ground walks
//! out to the nearest legal point.
//!
//! - **Time without progress.** Each second in which a walker comes at least a quarter of its free speed's worth
//!   nearer its leg's end than it has ever been is progress and takes the second off its time without progress (to
//!   no less than none); any other second adds itself. A new leg starts the clock again, and so does, while it waits for a link taken in turns
//!   (N8), that link's owner letting someone in or turning it (the queue moves). The rungs go by this time, so a
//!   walker circling a goal it cannot reach, or nudged forward now and then, still climbs them.
//! - **The rungs** (the declared timings, [`REROUTE`], [`MAKE_WAY`], [`SHOULDER`], [`END`]): at 3 s it is routed
//!   again once from where it stands; at 6 s a `make-way` is sent to the agent of each still body in its way (within
//!   [`walk::RANGE`] of it, or within [`ROOM`] of the far end of the link it waits for) that has no order to stay
//!   there; at 9 s it passes with a shoulder turn (no neighbour pushes it); at 15 s its order ends by name,
//!   `goal-unreachable`, naming what it waited for. Each is a [`Record`] in [`Ladder::log`].
//! - **Still bodies.** The engine never moves a still body: it asks that Soul's agent. A body staying by its own order
//!   (E3; `Walker::staying`) is sent nothing, and the walker passes it (other bodies are a preference, not a wall).
//! - **The last rung.** A body found on illegal ground (by [`crate::ground::exits::check`], on a rebuild, a size
//!   change or a birth) walks at its own speed in a straight line to the nearest legal point, collision off: a
//!   `walk-out` record that names it when it starts, `walked-out` when it stands on the ground again. The walk skill
//!   holds it meanwhile (`Walker::held`). Nothing teleports: no tick moves it further than its speed allows.
//! - **Water** (N11b, #3198). Water is legal ground for a body that may use it ([`may_stand`]: wading ground with
//!   wading, water with swimming), and illegal for any other: [`in_water`] lists a body on water it may not use
//!   (`in-water`), which the last rung walks out to the nearest ground it may stand on (a walker's surface holds dry
//!   ground only), and a body afloat on water with no way to a shore (`no-shore`: no chain of wet pieces, each
//!   touching the next, reaches dry ground). A swimmer whose order ends stays afloat where it is.
//! - **One trait.** What the ladder reads of the world beyond the walk skill's [`World`] goes through [`Unstick`].
//!
//! Integers only: µm and µs. Not here: the order to stay (E3), refusing edits (G2), the auditor (K11), births (K10).

pub mod town;

use crate::gaits::Ground;
use crate::ground::Piece;
use crate::ground::exits::{self, Finding};
use crate::links::turns::ROOM;
use crate::mover::Body;
use crate::routes::Mask;
use crate::walk::{self, Crowd, World, node_of};
use replica::effects::Refusal;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::time::Micros;
use std::collections::{BTreeMap, BTreeSet};

/// Progress is judged once a second, µs.
pub const SECOND: Micros = 1_000_000;
/// Without progress this long, a walker is routed again once, µs.
pub const REROUTE: Micros = 3_000_000;
/// Then `make-way` to the agents of still bodies in its way.
pub const MAKE_WAY: Micros = 6_000_000;
/// Then it passes with a shoulder turn.
pub const SHOULDER: Micros = 9_000_000;
/// Then its order ends by name. The design's 20 s is a bound; 15 s ends a jam that starts within 5 s of a walk's
/// start inside 20 s of it.
pub const END: Micros = 15_000_000;

/// Whether a body with abilities `has` may stand on `ground` (the routes' own rule, N11c #3218).
pub use crate::routes::may_stand;

/// Whether two pieces touch: a corner of either lies on an edge of the other, within [`exits::ON`].
fn touch(a: &Piece, b: &Piece) -> bool {
    let bounds = |p: &Piece| {
        p.outline
            .iter()
            .flatten()
            .fold([i64::MAX, i64::MAX, i64::MIN, i64::MIN], |r, v| {
                let (x, z) = (i64::from(v[0]), i64::from(v[2]));
                [r[0].min(x), r[1].min(z), r[2].max(x), r[3].max(z)]
            })
    };
    let (ba, bb) = (bounds(a), bounds(b));
    let on = exits::ON;
    if ba[0] > bb[2] + on || bb[0] > ba[2] + on || ba[1] > bb[3] + on || bb[1] > ba[3] + on {
        return false;
    }
    let meets = |p: &Piece, q: &Piece| {
        p.outline.iter().flatten().any(|v| {
            let c = [i128::from(v[0]), i128::from(v[2])];
            q.outline.iter().any(|ring| {
                (0..ring.len()).any(|k| {
                    let (s, e) = (ring[k], ring[(k + 1) % ring.len()]);
                    let (s, e) = (
                        [i128::from(s[0]), i128::from(s[2])],
                        [i128::from(e[0]), i128::from(e[2])],
                    );
                    let d = [e[0] - s[0], e[1] - s[1]];
                    let dd = d[0] * d[0] + d[1] * d[1];
                    let t = ((c[0] - s[0]) * d[0] + (c[1] - s[1]) * d[1]).clamp(0, dd.max(1));
                    let n = if dd == 0 {
                        s
                    } else {
                        [s[0] + d[0] * t / dd, s[1] + d[1] * t / dd]
                    };
                    let (x, z) = (c[0] - n[0], c[1] - n[1]);
                    x * x + z * z <= i128::from(on * on)
                })
            })
        })
    };
    meets(a, b) || meets(b, a)
}

/// Of `bodies` (each with its abilities and its centre, µm, in the node's frame), the ones standing in water among
/// `pieces` (one node's dry and wet ground, mm): on water it may not use (`in-water`), or afloat with no way to a
/// shore (`no-shore`), in the order given.
pub fn in_water(pieces: &[Piece], bodies: &[(Id, Mask, Vec3)]) -> Vec<Finding> {
    // The wet pieces a shore is reached from: touching dry ground, or a wet piece that does.
    let mut shore: Vec<bool> = pieces.iter().map(|p| p.ground == Ground::Dry).collect();
    let mut grew = true;
    while grew {
        grew = false;
        for q in 0..pieces.len() {
            if !shore[q] && (0..pieces.len()).any(|o| shore[o] && touch(&pieces[q], &pieces[o])) {
                shore[q] = true;
                grew = true;
            }
        }
    }
    bodies
        .iter()
        .filter_map(|&(body, has, at)| {
            let q = exits::piece_of(pieces, at)?;
            let ground = pieces[q as usize].ground;
            let why = if ground == Ground::Dry {
                return None;
            } else if !may_stand(ground, has) {
                "in-water"
            } else if !shore[q as usize] {
                "no-shore"
            } else {
                return None;
            };
            Some(Finding {
                body,
                at,
                why,
                piece: Some(q),
            })
        })
        .collect()
}

/// What the ladder reads of the world beyond the walk skill's.
pub trait Unstick: World {
    /// When the owner of link `link` last let someone in or turned it, µs, if it takes it in turns.
    fn moved(&self, link: Id) -> Option<Micros>;
    /// The far end of `link` for a body on `node` at `at`: its node and middle (µm, that node's frame).
    fn far_end(&self, link: Id, node: Id, at: Vec3) -> Option<(Id, Vec3)>;
    /// The nearest legal point on `node` to `at` (µm): `at` itself when it is legal.
    fn nearest(&self, node: Id, at: Vec3) -> Option<Vec3>;
    /// `body` standing at `at` on its node, legal ground (the mover's place).
    fn place(&self, body: &Body, at: Vec3) -> Result<Body, Refusal>;
}

/// One rung climbed, or the last rung walked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rung {
    /// Routed again from where it stood.
    Reroute,
    /// Sent to the agent of still body `to`: make way.
    MakeWay { to: Id },
    /// Passes with a shoulder turn.
    Shoulder,
    /// Its order ended by name.
    Ended { name: &'static str, detail: String },
    /// Found on illegal ground on node `node` at `from`: walks to `to` (µm, that node's frame), collision off.
    WalkOut { node: Id, from: Vec3, to: Vec3 },
    /// Stands on legal ground again at `at`.
    WalkedOut { at: Vec3 },
}

impl Rung {
    /// The event's name.
    pub fn name(&self) -> &'static str {
        match self {
            Rung::Reroute => "reroute",
            Rung::MakeWay { .. } => "make-way",
            Rung::Shoulder => "shoulder-turn",
            Rung::Ended { .. } => "order-ended",
            Rung::WalkOut { .. } => "walk-out",
            Rung::WalkedOut { .. } => "walked-out",
        }
    }
}

/// A record of the ladder: at world time `at`, body `who` (for its order `order`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub at: Micros,
    pub who: Id,
    pub order: Id,
    pub rung: Rung,
}

/// A walker's progress: its leg, the least distance to that leg's end, the time without progress (µs) and the rungs
/// climbed.
#[derive(Clone, Copy)]
struct Clock {
    leg: usize,
    best: i64,
    /// The least distance at the last second's mark, and when that was.
    mark: i64,
    at: Micros,
    idle: Micros,
    rung: u8,
}

/// A walk-out under way: where to, and what held the walker before (an order ended by name stays ended).
#[derive(Clone, Copy)]
struct Out {
    to: Vec3,
    was: Option<&'static str>,
}

/// The ladder over one crowd.
#[derive(Default)]
pub struct Ladder {
    /// Each walker's goal: its node and point (µm), for routing again.
    goals: BTreeMap<Id, (Id, Vec3)>,
    clocks: BTreeMap<Id, Clock>,
    outs: BTreeMap<Id, Out>,
    /// Every rung climbed, in order.
    pub log: Vec<Record>,
}

fn len(a: Vec3, b: Vec3) -> i64 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    (d(a.x, b.x) + d(a.z, b.z)).isqrt() as i64
}

impl Ladder {
    pub fn new() -> Ladder {
        Ladder::default()
    }

    /// Adds a walker to `crowd` (the walk skill's `Crowd::add`), keeping its goal for routing again.
    #[allow(clippy::too_many_arguments)]
    pub fn add(
        &mut self,
        crowd: &mut Crowd,
        world: &mut impl World,
        body: Body,
        speed: i64,
        order: Id,
        node: Id,
        goal: Vec3,
    ) -> Result<(), Refusal> {
        let who = body.id;
        crowd.add(world, body, speed, order, node, goal)?;
        self.goals.insert(who, (node, goal));
        Ok(())
    }

    /// Whether every walker has arrived or ended by name, and no walk-out is under way.
    pub fn done(&self, crowd: &Crowd) -> bool {
        self.outs.is_empty() && crowd.done()
    }

    fn record(&mut self, at: Micros, who: Id, order: Id, rung: Rung) {
        self.log.push(Record {
            at,
            who,
            order,
            rung,
        });
    }

    /// The last rung: body `who`, found on illegal ground, walks to the nearest legal point. Refused when it is on
    /// legal ground already (`on-ground`), crossing a link (`crossing`), or its node has no ground (`no-ground`).
    pub fn walk_out(
        &mut self,
        crowd: &mut Crowd,
        world: &impl Unstick,
        who: Id,
    ) -> Result<(), Refusal> {
        let refuse = |name: &'static str| Refusal {
            name,
            detail: replica::world_model::show(who),
        };
        let w = crowd
            .walkers
            .iter_mut()
            .find(|w| w.body.id == who)
            .ok_or_else(|| refuse("body-missing"))?;
        if w.crossing {
            return Err(refuse("crossing"));
        }
        let node = node_of(&w.body);
        let from = w.body.pose.position;
        let to = world
            .nearest(node, from)
            .ok_or_else(|| refuse("no-ground"))?;
        if to == from {
            return Err(refuse("on-ground"));
        }
        let was = w.held.replace("walk-out");
        w.waiting = None;
        w.body.linear = Vec3::ZERO;
        let order = w.order;
        self.outs.insert(who, Out { to, was });
        self.record(crowd.now, who, order, Rung::WalkOut { node, from, to });
        Ok(())
    }

    /// One tick: the walk-outs under way, then the crowd's tick, then each walker's clock and rungs.
    pub fn step(&mut self, crowd: &mut Crowd, world: &mut impl Unstick) -> Result<(), Refusal> {
        let (dt, at) = (crowd.tick, crowd.now + crowd.tick);
        // The last rung: straight to the nearest legal point at the walker's speed, collision off.
        let outs: Vec<Id> = self.outs.keys().copied().collect();
        for who in outs {
            let Some(w) = crowd.walkers.iter_mut().find(|w| w.body.id == who) else {
                self.outs.remove(&who);
                continue;
            };
            let Out { to, was } = self.outs[&who];
            let p = w.body.pose.position;
            let d = len(p, to);
            let reach = w.speed * dt / 1_000_000;
            if d > reach {
                let q = Vec3::new(
                    p.x + ((i128::from(to.x - p.x) * i128::from(reach)) / i128::from(d)) as i64,
                    p.y,
                    p.z + ((i128::from(to.z - p.z) * i128::from(reach)) / i128::from(d)) as i64,
                );
                w.body.linear = Vec3::new(
                    (q.x - p.x) * 1_000_000 / dt,
                    0,
                    (q.z - p.z) * 1_000_000 / dt,
                );
                w.body.pose.position = q;
                continue;
            }
            let mut b = world.place(&w.body, to)?;
            b.linear = Vec3::new(
                (to.x - p.x) * 1_000_000 / dt,
                0,
                (to.z - p.z) * 1_000_000 / dt,
            );
            w.body = b;
            w.held = was;
            let order = w.order;
            self.outs.remove(&who);
            self.record(at, who, order, Rung::WalkedOut { at: to });
            // Its order, if it has one still, goes on from where it stands.
            if w.arrived.is_none()
                && was.is_none()
                && let Some(&(node, goal)) = self.goals.get(&who)
            {
                match world.plan(&w.body, node, goal) {
                    Ok(legs) => {
                        w.legs = legs;
                        w.leg = 0;
                        self.clocks.remove(&who);
                    }
                    Err(e) => {
                        w.held = Some(e.name);
                        self.record(
                            at,
                            who,
                            order,
                            Rung::Ended {
                                name: e.name,
                                detail: e.detail,
                            },
                        );
                    }
                }
            }
        }
        crowd.step(world)?;
        let now = crowd.now;
        // Still bodies, as they stand now: no order (arrived, or ended by name), not staying.
        let still: Vec<(Id, Id, Vec3)> = crowd
            .walkers
            .iter()
            .filter(|w| {
                !w.staying && (w.arrived.is_some() || w.held.is_some_and(|h| h != "walk-out"))
            })
            .map(|w| (w.body.id, node_of(&w.body), w.body.pose.position))
            .collect();
        let mut asked: BTreeSet<(Id, Id)> = BTreeSet::new();
        for k in 0..crowd.walkers.len() {
            let w = crowd.walkers[k].clone();
            if w.arrived.is_some() || w.held.is_some() || w.staying || w.crossing {
                self.clocks.remove(&w.body.id);
                continue;
            }
            let (who, order) = (w.body.id, w.order);
            let leg = w.legs[w.leg];
            let gap = len(w.body.pose.position, leg.to);
            let fresh = Clock {
                leg: w.leg,
                best: gap,
                mark: gap,
                at: now,
                idle: 0,
                rung: 0,
            };
            let c = self.clocks.entry(who).or_insert(fresh);
            // A new leg, or a queue that moved, starts the clock again.
            let moved = w
                .waiting
                .and_then(|(l, _)| world.moved(l))
                .is_some_and(|m| m > c.at);
            if c.leg != w.leg || moved {
                *c = fresh;
                crowd.walkers[k].shoulder = false;
                continue;
            }
            // Each second: coming a quarter of free speed's worth nearer the leg's end than ever is progress, and
            // takes the second off the time without it; any other second adds itself.
            c.best = c.best.min(gap);
            if now - c.at >= SECOND {
                let span = now - c.at;
                if c.best + w.speed * span / 4_000_000 <= c.mark {
                    c.idle = (c.idle - span).max(0);
                } else {
                    c.idle += span;
                }
                (c.mark, c.at) = (c.best, now);
                if c.idle == 0 {
                    c.rung = 0;
                    crowd.walkers[k].shoulder = false;
                }
            }
            let idle = c.idle;
            if idle >= END {
                let detail = match w.waiting {
                    Some((l, _)) => format!(
                        "no progress for {} ms, waiting for {}",
                        idle / 1000,
                        replica::world_model::show(l)
                    ),
                    None => format!(
                        "no progress for {} ms, {} um from its leg's end",
                        idle / 1000,
                        gap
                    ),
                };
                let w = &mut crowd.walkers[k];
                w.held = Some("goal-unreachable");
                w.waiting = None;
                w.shoulder = false;
                w.body.linear = Vec3::ZERO;
                self.clocks.remove(&who);
                self.record(
                    now,
                    who,
                    order,
                    Rung::Ended {
                        name: "goal-unreachable",
                        detail,
                    },
                );
                continue;
            }
            if idle >= SHOULDER && c.rung < 3 {
                c.rung = 3;
                crowd.walkers[k].shoulder = true;
                self.record(now, who, order, Rung::Shoulder);
            } else if idle >= MAKE_WAY && c.rung < 2 {
                c.rung = 2;
                let (node, p) = (node_of(&w.body), w.body.pose.position);
                let far = w.waiting.and_then(|(l, _)| world.far_end(l, node, p));
                for &(s, sn, sp) in &still {
                    let near = sn == node && len(sp, p) < walk::RANGE;
                    let blocks = far.is_some_and(|(fnode, fp)| sn == fnode && len(sp, fp) < ROOM);
                    if (near || blocks) && asked.insert((who, s)) {
                        self.log.push(Record {
                            at: now,
                            who,
                            order,
                            rung: Rung::MakeWay { to: s },
                        });
                    }
                }
            } else if idle >= REROUTE && c.rung < 1 {
                c.rung = 1;
                let goal = self.goals.get(&who).copied();
                let body = w.body;
                self.record(now, who, order, Rung::Reroute);
                if let Some((node, goal)) = goal {
                    match world.plan(&body, node, goal) {
                        Ok(legs) => {
                            let w = &mut crowd.walkers[k];
                            w.legs = legs;
                            w.leg = 0;
                            let c = self.clocks.get_mut(&who).expect("its clock");
                            c.leg = 0;
                            c.best = len(body.pose.position, w.legs[0].to);
                            c.mark = c.best;
                        }
                        Err(e) => {
                            let w = &mut crowd.walkers[k];
                            w.held = Some(e.name);
                            w.waiting = None;
                            self.clocks.remove(&who);
                            self.record(
                                now,
                                who,
                                order,
                                Rung::Ended {
                                    name: e.name,
                                    detail: e.detail,
                                },
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
