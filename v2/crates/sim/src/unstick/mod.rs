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
//!   [`NEAR`] of it, or within [`ROOM`] of the far end of the link it waits for) that has no order to stay
//!   there; at 9 s it passes with a shoulder turn (no neighbour pushes it); at 15 s its order ends by name,
//!   `goal-unreachable`, naming what it waited for. Each is a [`Record`] in [`Ladder::log`].
//! - **Still bodies.** The engine never moves a still body: it asks that Soul's agent. A body staying by its own order
//!   (E3; `Runner::staying`) is sent nothing, and the walker passes it (other bodies are a preference, not a wall).
//! - **The last rung.** A body found on illegal ground (by [`crate::ground::exits::check`], on a rebuild, a size
//!   change or a birth) walks at its own speed in a straight line to the nearest legal point, collision off: a
//!   `walk-out` record that names it when it starts, `walked-out` when it stands on the ground again. The controller
//!   carries it, by the world's own rule ([`crate::controller::Controller::carry`]), and its walk stands meanwhile.
//!   Nothing teleports: no tick moves it further than its speed allows.
//! - **Through the host** (T9c #3127). The walk is a skill (`skills::route`) run by the [`Runner`]; the ladder reaches
//!   it only by fields the world sets on the walker's body: `F_ROUTE` (routed again), `F_SHOULDER` (the shoulder
//!   turn) and `F_HELD` (walked out). Ending an order by name ends its run ([`Runner::end`]). The ladder keeps each
//!   walker's legs, and a leg ends when the controller has carried the body across the leg's link.
//! - **One trait.** What the ladder reads of the world beyond walking's [`World`] goes through [`Unstick`].
//!
//! Integers only: µm and µs. Not here: the order to stay (E3), refusing edits (G2), the auditor (K11), births (K10).

pub mod town;

use crate::controller::Track;
use crate::host::{Runner, named, waiting};
use crate::links::turns::ROOM;
use crate::walk::town::Town;
use crate::walk::{Leg, World, node_of};
use replica::effects::Refusal;
use replica::encode::Value;
use replica::host::{F_HELD, F_SHOULDER};
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
/// A still body this near a walker is in its way, µm: the walk's push range (`skills::route::RANGE`).
pub const NEAR: i64 = 1_200_000;

/// What the ladder reads of the world beyond walking's.
pub trait Unstick: World {
    /// When the owner of link `link` last let someone in or turned it, µs, if it takes it in turns.
    fn moved(&self, link: Id) -> Option<Micros>;
    /// The far end of `link` for a body on `node` at `at`: its node and middle (µm, that node's frame).
    fn far_end(&self, link: Id, node: Id, at: Vec3) -> Option<(Id, Vec3)>;
    /// The nearest legal point on `node` to `at` (µm): `at` itself when it is legal.
    fn nearest(&self, node: Id, at: Vec3) -> Option<Vec3>;
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

/// A walker as the ladder knows it: its order, free speed, goal (node and point, µm) and legs, the leg it walks, and
/// whether the controller was carrying it across a link at the last tick's end.
struct Walker {
    order: Id,
    speed: i64,
    goal: (Id, Vec3),
    legs: Vec<Leg>,
    leg: usize,
    carried: bool,
}

/// The ladder over one runner's walkers.
#[derive(Default)]
pub struct Ladder {
    walkers: BTreeMap<Id, Walker>,
    clocks: BTreeMap<Id, Clock>,
    /// The walk-outs under way.
    outs: BTreeSet<Id>,
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

    /// Keeps a walker the runner walks along `legs` for the order `order`, at free speed `speed`, to `goal` on
    /// `node`, for routing it again.
    pub fn add(&mut self, who: Id, order: Id, speed: i64, node: Id, goal: Vec3, legs: Vec<Leg>) {
        self.walkers.insert(
            who,
            Walker {
                order,
                speed,
                goal: (node, goal),
                legs,
                leg: 0,
                carried: false,
            },
        );
    }

    /// The leg `who` walks as the ladder keeps it: its index in the route and the leg.
    pub fn leg(&self, who: Id) -> Option<(usize, Leg)> {
        let w = self.walkers.get(&who)?;
        Some((w.leg, *w.legs.get(w.leg)?))
    }

    /// Whether every walk has ended (arrived or by name) and no walk-out is under way.
    pub fn done(&self, runner: &Runner) -> bool {
        self.outs.is_empty() && runner.runs.is_empty()
    }

    fn record(&mut self, at: Micros, who: Id, order: Id, rung: Rung) {
        self.log.push(Record {
            at,
            who,
            order,
            rung,
        });
    }

    /// Ends `who`'s order by name: its run ends, and the record says why.
    fn end(&mut self, runner: &mut Runner, who: Id, order: Id, name: &'static str, detail: String) {
        runner.end(who, named(name));
        self.clocks.remove(&who);
        self.record(runner.now, who, order, Rung::Ended { name, detail });
    }

    /// Gives `who` a new route from where it stands to its goal (`F_ROUTE`), or ends its order by the plan's
    /// refusal.
    fn reroute(&mut self, runner: &mut Runner, world: &mut impl World, who: Id) {
        let (Some(w), Some(body)) = (self.walkers.get_mut(&who), runner.controller.body(who))
        else {
            return;
        };
        let (node, goal) = w.goal;
        match world.plan(body, node, goal) {
            Ok(legs) => {
                runner.route(who, &legs);
                (w.legs, w.leg) = (legs, 0);
            }
            Err(e) => {
                let order = w.order;
                self.end(runner, who, order, e.name, e.detail);
            }
        }
    }

    /// The last rung: body `who`, found on illegal ground, walks to the nearest legal point. Refused when it is on
    /// legal ground already (`on-ground`), crossing a link (`crossing`), or its node has no ground (`no-ground`).
    pub fn walk_out(
        &mut self,
        runner: &mut Runner,
        world: &impl Unstick,
        who: Id,
    ) -> Result<(), Refusal> {
        let refuse = |name: &'static str| Refusal {
            name,
            detail: replica::world_model::show(who),
        };
        let w = self
            .walkers
            .get(&who)
            .ok_or_else(|| refuse("body-missing"))?;
        let b = *runner
            .controller
            .body(who)
            .ok_or_else(|| refuse("body-missing"))?;
        if runner.controller.carried(who) {
            return Err(refuse("crossing"));
        }
        let node = node_of(&b);
        let from = b.pose.position;
        let to = world
            .nearest(node, from)
            .ok_or_else(|| refuse("no-ground"))?;
        if to == from {
            return Err(refuse("on-ground"));
        }
        let track = Track {
            link: None,
            line: vec![to],
            speed: w.speed,
            to: node,
            arrive: None,
        };
        runner.controller.carry(who, track)?;
        if runner.running(who) {
            runner
                .fields
                .entry(who)
                .or_default()
                .insert(F_HELD, Value::Uint(1));
        }
        let order = w.order;
        self.outs.insert(who);
        self.clocks.remove(&who);
        self.record(runner.now, who, order, Rung::WalkOut { node, from, to });
        Ok(())
    }

    /// One tick: the runner's tick (the walk-outs under way are carried in it), then the walk-outs ended, then each
    /// walker's clock and rungs.
    pub fn step(&mut self, runner: &mut Runner, town: &mut Town) -> Result<(), Refusal> {
        // A refusal is one body's (the runner went on for the others): the rungs go on too, and it is returned last.
        let ticked = runner.tick(town);
        let now = runner.now;
        // The walk-outs the controller has stood on the ground: the order, if it has one still, goes on from there.
        let outs: Vec<Id> = self.outs.iter().copied().collect();
        for who in outs {
            if runner.controller.carried(who) {
                continue;
            }
            self.outs.remove(&who);
            let Some(at) = runner.controller.body(who).map(|b| b.pose.position) else {
                continue;
            };
            let order = self.walkers.get(&who).map_or(who, |w| w.order);
            self.record(now, who, order, Rung::WalkedOut { at });
            if let Some(f) = runner.fields.get_mut(&who) {
                f.remove(&F_HELD);
            }
            if runner.running(who) {
                self.clocks.remove(&who);
                self.reroute(runner, town, who);
            }
        }
        // Still bodies, as they stand now: no order (arrived, or ended by name), not staying, not walking out.
        let still: Vec<(Id, Id, Vec3)> = runner
            .controller
            .bodies()
            .filter(|b| {
                !runner.staying.contains(&b.id)
                    && !runner.running(b.id)
                    && !self.outs.contains(&b.id)
            })
            .map(|b| (b.id, node_of(b), b.pose.position))
            .collect();
        let mut asked: BTreeSet<(Id, Id)> = BTreeSet::new();
        let ids: Vec<Id> = self.walkers.keys().copied().collect();
        for who in ids {
            let Some(body) = runner.controller.body(who).copied() else {
                continue;
            };
            // A leg ends when the controller has carried the body across its link.
            let carried = runner.controller.carrying(who).is_some();
            let w = self.walkers.get_mut(&who).expect("a walker");
            if w.carried && !carried {
                w.leg += 1;
            }
            w.carried = carried;
            if !runner.running(who)
                || self.outs.contains(&who)
                || runner.staying.contains(&who)
                || carried
            {
                self.clocks.remove(&who);
                continue;
            }
            let Some(&leg) = w.legs.get(w.leg) else {
                self.clocks.remove(&who);
                continue;
            };
            let (order, speed, wleg) = (w.order, w.speed, w.leg);
            let gap = len(body.pose.position, leg.to);
            let waits = waiting(runner.fields.get(&who));
            let fresh = Clock {
                leg: wleg,
                best: gap,
                mark: gap,
                at: now,
                idle: 0,
                rung: 0,
            };
            let c = self.clocks.entry(who).or_insert(fresh);
            // A new leg, or a queue that moved, starts the clock again.
            let moved = waits
                .and_then(|(l, _)| town.moved(l))
                .is_some_and(|m| m > c.at);
            if c.leg != wleg || moved {
                *c = fresh;
                if let Some(f) = runner.fields.get_mut(&who) {
                    f.remove(&F_SHOULDER);
                }
                continue;
            }
            // Each second: coming a quarter of free speed's worth nearer the leg's end than ever is progress, and
            // takes the second off the time without it; any other second adds itself.
            c.best = c.best.min(gap);
            if now - c.at >= SECOND {
                let span = now - c.at;
                if c.best + speed * span / 4_000_000 <= c.mark {
                    c.idle = (c.idle - span).max(0);
                } else {
                    c.idle += span;
                }
                (c.mark, c.at) = (c.best, now);
                if c.idle == 0 {
                    c.rung = 0;
                    if let Some(f) = runner.fields.get_mut(&who) {
                        f.remove(&F_SHOULDER);
                    }
                }
            }
            let idle = c.idle;
            if idle >= END {
                let detail = match waits {
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
                self.end(runner, who, order, "goal-unreachable", detail);
                continue;
            }
            if idle >= SHOULDER && c.rung < 3 {
                c.rung = 3;
                runner
                    .fields
                    .entry(who)
                    .or_default()
                    .insert(F_SHOULDER, Value::Uint(1));
                self.record(now, who, order, Rung::Shoulder);
            } else if idle >= MAKE_WAY && c.rung < 2 {
                c.rung = 2;
                let (node, p) = (node_of(&body), body.pose.position);
                let far = waits.and_then(|(l, _)| town.far_end(l, node, p));
                for &(s, sn, sp) in &still {
                    let near = sn == node && len(sp, p) < NEAR;
                    let blocks = far.is_some_and(|(fnode, fp)| sn == fnode && len(sp, fp) < ROOM);
                    if (near || blocks) && asked.insert((who, s)) {
                        self.record(now, who, order, Rung::MakeWay { to: s });
                    }
                }
            } else if idle >= REROUTE && c.rung < 1 {
                c.rung = 1;
                self.record(now, who, order, Rung::Reroute);
                self.reroute(runner, town, who);
                if let (Some(c), Some(w)) = (self.clocks.get_mut(&who), self.walkers.get(&who)) {
                    c.leg = 0;
                    c.best = len(body.pose.position, w.legs[0].to);
                    c.mark = c.best;
                }
            }
        }
        ticked
    }
}
