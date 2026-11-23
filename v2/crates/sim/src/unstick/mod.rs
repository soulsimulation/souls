//! The never-stuck ladder (Engine v2 N10, #2657): no walking body is ever left stuck. A walker that makes no progress
//! climbs rungs by time, and its order ends by name before it could be parked; a body found on illegal ground walks
//! out to the nearest legal point.
//!
//! - **Time without progress.** Each second in which a walker comes at least a quarter of its free speed's worth
//!   nearer its leg's end than it has ever been is progress and takes the second off its time without progress (to
//!   no less than none); any other second adds itself. A new leg starts the clock again, and so does, while it waits for a link taken in turns
//!   (N8), that link's owner letting someone in or turning it (the queue moves). The rungs go by this time, so a
//!   walker circling a goal it cannot reach, or nudged forward now and then, still climbs them. A new route
//!   to the same leg's end (the reroute rung) keeps its least distance to it, so one going to and fro climbs too.
//! - **The rungs** (the declared timings, [`REROUTE`], [`MAKE_WAY`], [`SHOULDER`], [`END`]): at 3 s it is routed
//!   again once from where it stands; at 5 s each still body in its way (within [`NEAR`] of it, or within [`ROOM`]
//!   of the far end of the link it waits for) that has no order to stay there is sent `make-way`, and the world steps
//!   it aside ([`Rung::StepAside`]); at 9 s it passes with a shoulder turn (no neighbour pushes it); at 15 s its order
//!   ends by name, `goal-unreachable`, naming what it waited for. Each is a [`Record`] in [`Ladder::log`].
//! - **Still bodies** (Gene's decision, 0.132 A2-3: no Soul is left stuck). When the only way is blocked, the world
//!   moves a still body aside by the smallest step that clears the walker's line: across that line, to
//!   [`CLEAR`] from it, onto legal ground and clear of every other body, the nearer side first, at walking speed and
//!   in a straight line, as the last rung walks (nothing teleports). A body staying by its own order (E3;
//!   `Runner::staying`) is sent nothing and never moved, and the walker passes it (other bodies are a preference, not
//!   a wall).
//! - **The last rung.** A body found on illegal ground (by [`crate::ground::exits::check`], on a rebuild, a size
//!   change or a birth) walks at its own speed in a straight line to the nearest legal point, collision off: a
//!   `walk-out` record that names it when it starts, `walked-out` when it stands on the ground again. The controller
//!   carries it, by the world's own rule ([`crate::controller::Controller::carry`]), and its walk stands meanwhile.
//!   Nothing teleports: no tick moves it further than its speed allows.
//! - **Through the host** (T9c #3127). The walk is a skill (`skills::route`) run by the [`Runner`]; the ladder reaches
//!   it only by fields the world sets on the walker's body: `F_ROUTE` (routed again), `F_SHOULDER` (the shoulder
//!   turn) and `F_HELD` (walked out). Ending an order by name ends its run ([`Runner::end`]). The ladder keeps each
//!   walker's legs, and a leg ends when the controller has carried the body across the leg's link.
//! - **Water** (N11b, #3198). Water is legal ground for a body that may use it ([`may_stand`]: wading ground with
//!   wading, water with swimming), and illegal for any other: [`in_water`] lists a body on water it may not use
//!   (`in-water`), which the last rung walks out to the nearest ground it may stand on (a walker's surface holds dry
//!   ground only), and a body afloat on water with no way to a shore (`no-shore`: no chain of wet pieces, each
//!   touching the next, reaches dry ground). A swimmer whose order ends stays afloat where it is.
//! - **Changed ground** (G3, #2760). Before each tick, once the runner has found its bodies again on ground an edit
//!   changed (`Runner::reground`), the walks planned on that ground (`Town::stale`) are planned again from where
//!   they stand: those whose body stands on a changed node at once, the rest nearest the change first (by how soon
//!   their route reaches it), spread over [`REPLAN_WITHIN`]. A walk with no plan now ends by the plan's refusal
//!   (`destination-gone`, `no-route`, ...); the engine chooses no other goal. A body carried across a link finishes
//!   the crossing first, and one found off the ground is walked out first (the last rung, below).
//! - **One trait.** What the ladder reads of the world beyond walking's [`World`] goes through [`Unstick`].
//!
//! Integers only: µm and µs. Not here: the order to stay (E3), refusing edits (G2), the auditor (K11), births (K10).

pub mod town;

use crate::controller::Track;
use crate::gaits::Ground;
use crate::ground::Piece;
use crate::ground::exits::{self, Finding};
use crate::host::{Runner, named, waiting};
use crate::links::turns::ROOM;
use crate::routes::Mask;
use crate::walk::town::Town;
use crate::walk::{Leg, World, node_of};
use replica::effects::Refusal;
use replica::encode::Value;
use replica::host::{F_HELD, F_SHOULDER, Progress};
use replica::ids::Id;
use replica::pose::Vec3;
use replica::time::Micros;
use std::collections::{BTreeMap, BTreeSet};

/// Progress is judged once a second, µs.
pub const SECOND: Micros = 1_000_000;
/// Without progress this long, a walker is routed again once, µs.
pub const REROUTE: Micros = 3_000_000;
/// Then `make-way` to the agents of still bodies in its way, and each is stepped aside (0.132 A2-3: after 5 s).
pub const MAKE_WAY: Micros = 5_000_000;
/// Then it passes with a shoulder turn.
pub const SHOULDER: Micros = 9_000_000;
/// Then its order ends by name. The design's 20 s is a bound; 15 s ends a jam that starts within 5 s of a walk's
/// start inside 20 s of it.
pub const END: Micros = 15_000_000;
/// A still body this near a walker is in its way, µm: the walk's push range (`skills::route::RANGE`).
pub const NEAR: i64 = 1_200_000;
/// A still body stepped aside stands at least this far across the walker's line, µm: two standard bodies' radii and
/// 0.1 m, so a walker passes it.
pub const CLEAR: i64 = (2 * crate::ground::HUMAN_RADIUS + 100) * 1000;
/// The walks planned on changed ground are all planned again within this, µs (G3's bar is 2 s).
pub const REPLAN_WITHIN: Micros = 1_000_000;

/// Whether a body with abilities `has` may stand on `ground` (the routes' own rule, N11c #3218).
pub use crate::routes::may_stand;

/// The smallest step that takes a still body at `at` on `node` out of the walker's `line` (from, to), when it is on
/// that line (within [`CLEAR`] across it, between the walker and the line's end): across the line to [`CLEAR`] from
/// it, the nearer side first, then each side a [`CLEAR`] further, up to three; a point on legal ground and at least
/// two standard radii from every body in `taken`. None when no such point is found.
pub fn aside(
    world: &impl Unstick,
    node: Id,
    at: Vec3,
    line: (Vec3, Vec3),
    taken: &[Vec3],
) -> Option<Vec3> {
    let (a, b) = line;
    let (dx, dz) = (b.x - a.x, b.z - a.z);
    let d = len(a, b);
    // Across the line (a line of no length: across the way from the walker to the body).
    let (nx, nz, lat) = if d > 0 {
        let lat = (i128::from(at.x - a.x) * i128::from(-dz)
            + i128::from(at.z - a.z) * i128::from(dx))
            / i128::from(d);
        (-dz, dx, lat as i64)
    } else {
        (at.z - a.z, a.x - at.x, 0)
    };
    let n = len(Vec3::ZERO, Vec3::new(nx, 0, nz));
    if n == 0 {
        return None;
    }
    // Only a body on the way: across the line within [`CLEAR`], and not behind the walker or past the line's end.
    if d > 0 {
        let along = (i128::from(at.x - a.x) * i128::from(dx)
            + i128::from(at.z - a.z) * i128::from(dz))
            / i128::from(d);
        let r = crate::ground::HUMAN_RADIUS * 1000;
        if lat.abs() >= CLEAR || along < i128::from(-r) || along > i128::from(d + CLEAR) {
            return None;
        }
    }
    let side = if lat < 0 { -1 } else { 1 };
    let apart = 2 * crate::ground::HUMAN_RADIUS * 1000;
    for k in 0..3 {
        for s in [side, -side] {
            let want = s * (CLEAR + k * CLEAR);
            let step = want - lat;
            let to = Vec3::new(
                at.x + (i128::from(nx) * i128::from(step) / i128::from(n)) as i64,
                at.y,
                at.z + (i128::from(nz) * i128::from(step) / i128::from(n)) as i64,
            );
            let legal = world.nearest(node, to).is_some_and(|q| len(q, to) == 0);
            if legal && taken.iter().all(|&t| len(t, to) >= apart) {
                return Some(to);
            }
        }
    }
    None
}

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
    /// Still body `body` stepped aside by the world, on node `node` from `from` to `to` (µm, that node's frame).
    StepAside {
        body: Id,
        node: Id,
        from: Vec3,
        to: Vec3,
    },
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
            Rung::StepAside { .. } => "step-aside",
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
    /// Each walk planned again on changed ground (G3): who, when (µs of world time), and the name it ended by when no
    /// plan was found.
    pub replans: Vec<(Id, Micros, Option<&'static str>)>,
    /// Plans a tick for the stale walks of the ground change under way (0: none under way).
    spread: usize,
    /// Where still bodies stepped aside this tick are going (node and point), so two are not sent to one place.
    aside: Vec<(Id, Vec3)>,
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
    /// refusal, which is returned. A walk planned again is no longer stale (G3).
    fn reroute(
        &mut self,
        runner: &mut Runner,
        town: &mut Town,
        who: Id,
    ) -> Result<(), &'static str> {
        let (Some(w), Some(body)) = (self.walkers.get_mut(&who), runner.controller.body(who))
        else {
            return Ok(());
        };
        town.stale.remove(&who);
        let (node, goal) = w.goal;
        match town.plan(body, node, goal) {
            Ok(legs) => {
                runner.route(who, &legs);
                (w.legs, w.leg) = (legs, 0);
                Ok(())
            }
            Err(e) => {
                let order = w.order;
                self.end(runner, who, order, e.name, e.detail);
                Err(e.name)
            }
        }
    }

    /// Changed ground (G3, see the module's notes): the stale walks planned again, those on a changed node at once and
    /// the rest by rank, a share a tick so that all are within [`REPLAN_WITHIN`].
    fn replan(&mut self, runner: &mut Runner, town: &mut Town) {
        let running = runner.running_bodies();
        town.stale
            .retain(|who, _| running.contains(who) && self.walkers.contains_key(who));
        if town.stale.is_empty() {
            self.spread = 0;
            return;
        }
        if self.spread == 0 {
            let ticks = (REPLAN_WITHIN / runner.tick.max(1)).max(1) as usize;
            self.spread = town.stale.len().div_ceil(ticks);
        }
        let mut order: Vec<(usize, Id)> = town
            .stale
            .iter()
            .filter(|(who, _)| {
                !runner.controller.carried(**who)
                    && !runner.off_ground.contains(*who)
                    && !self.outs.contains(*who)
            })
            .map(|(who, rank)| (*rank, *who))
            .collect();
        order.sort();
        let mut budget = self.spread;
        for (rank, who) in order {
            if rank > 0 {
                if budget == 0 {
                    break;
                }
                budget -= 1;
            }
            self.clocks.remove(&who);
            let ended = self.reroute(runner, town, who).err();
            self.replans.push((who, runner.now, ended));
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

    /// One tick: changed ground first (its bodies found again on it, the walks planned on it planned again, G3), then
    /// the runner's tick (the walk-outs under way are carried in it), then each walker the tick refused
    /// ended, then the walk-outs ended, then each walker's clock and rungs. A refusal of one walker in the runner's
    /// tick (`Runner::refused`, #3275) is its fault alone: a walk-out under way is dropped, and its order ends by the
    /// refusal's name, with its record ([`Rung::Ended`]); it never stops the ladder for the others. A refusal of the
    /// world's own in the runner's tick is returned once the rungs are climbed.
    pub fn step(&mut self, runner: &mut Runner, town: &mut Town) -> Result<(), Refusal> {
        runner.reground(town);
        self.replan(runner, town);
        let ticked = runner.tick(town);
        self.faults(runner);
        self.climb(runner, town);
        ticked
    }

    /// Each walker refused in the last tick (its first refusal) whose walk the tick ended or whose walk-out was under
    /// way: the walk-out dropped, its order ended by name. A body with neither (it stood still) has nothing to end.
    fn faults(&mut self, runner: &mut Runner) {
        if runner.refused.is_empty() {
            return;
        }
        let start = runner.now - runner.tick;
        let mut seen = BTreeSet::new();
        let refused: Vec<(Id, Refusal)> = runner
            .refused
            .iter()
            .filter(|(who, _)| {
                self.walkers.contains_key(who)
                    && (self.outs.contains(who)
                        || matches!(runner.ended.get(who), Some((t, Progress::Failed(_))) if *t == start))
                    && seen.insert(*who)
            })
            .cloned()
            .collect();
        for (who, r) in refused {
            if self.outs.remove(&who)
                && let Some(f) = runner.fields.get_mut(&who)
            {
                f.remove(&F_HELD);
            }
            let order = self.walkers[&who].order;
            self.end(runner, who, order, r.name, r.detail);
        }
    }

    fn climb(&mut self, runner: &mut Runner, town: &mut Town) {
        let now = runner.now;
        self.aside.clear();
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
                let _ = self.reroute(runner, town, who);
            }
        }
        // Who runs, taken once (each walker below changes only its own run, after it is read).
        let running = runner.running_bodies();
        // Still bodies, as they stand now: no order (arrived, or ended by name), not staying, not walking out. Read
        // the first time a walker asks (N17b): nothing below moves a body, starts a run or changes the walk-outs.
        let mut still: Option<Vec<(Id, Id, Vec3)>> = None;
        let mut asked: BTreeSet<(Id, Id)> = BTreeSet::new();
        let ids: Vec<Id> = self.walkers.keys().copied().collect();
        // Each walker's own reads, on the runner's threads (N17b): nothing below changes another walker's.
        let reads = crate::par::map(&ids, runner.threads, 256, |&who| {
            runner.controller.body(who).copied().map(|b| {
                (
                    b,
                    runner.controller.carrying(who).is_some(),
                    running.contains(&who),
                    waiting(runner.fields.get(&who)),
                )
            })
        });
        for (who, read) in ids.into_iter().zip(reads) {
            let Some((body, carried, runs, waits)) = read else {
                continue;
            };
            // A leg ends when the controller has carried the body across its link (`carried`).
            let w = self.walkers.get_mut(&who).expect("a walker");
            if w.carried && !carried {
                w.leg += 1;
            }
            w.carried = carried;
            if !runs || self.outs.contains(&who) || runner.staying.contains(&who) || carried {
                self.clocks.remove(&who);
                continue;
            }
            let Some(&leg) = w.legs.get(w.leg) else {
                self.clocks.remove(&who);
                continue;
            };
            let (order, speed, wleg) = (w.order, w.speed, w.leg);
            let gap = len(body.pose.position, leg.to);
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
                let still = still.get_or_insert_with(|| {
                    runner
                        .controller
                        .bodies()
                        .filter(|b| {
                            !runner.staying.contains(&b.id)
                                && !running.contains(&b.id)
                                && !self.outs.contains(&b.id)
                                && !runner.controller.carried(b.id)
                        })
                        .map(|b| (b.id, node_of(b), b.pose.position))
                        .collect()
                });
                let still: Vec<(Id, Id, Vec3)> = still.clone();
                for &(s, sn, sp) in &still {
                    let near = sn == node && len(sp, p) < NEAR;
                    let blocks = far.is_some_and(|(fnode, fp)| sn == fnode && len(sp, fp) < ROOM);
                    if (near || blocks) && asked.insert((who, s)) {
                        self.record(now, who, order, Rung::MakeWay { to: s });
                        // The line it blocks: the walker's to its leg's end, or the link's far end it waits at.
                        let line = match far {
                            Some((_, fp)) if blocks => (p, fp),
                            _ => (p, leg.to),
                        };
                        let taken = runner
                            .controller
                            .bodies()
                            .filter(|b| b.id != s)
                            .map(|b| (node_of(b), b.pose.position))
                            .chain(self.aside.iter().map(|&(n, at)| (n, at)))
                            .filter(|(n, _)| *n == sn)
                            .map(|(_, at)| at)
                            .collect::<Vec<_>>();
                        if let Some(to) = aside(town, sn, sp, line, &taken) {
                            let track = Track {
                                link: None,
                                line: vec![to],
                                speed,
                                to: sn,
                                arrive: None,
                            };
                            if runner.controller.carry(s, track).is_ok() {
                                self.aside.push((sn, to));
                                self.record(
                                    now,
                                    who,
                                    order,
                                    Rung::StepAside {
                                        body: s,
                                        node: sn,
                                        from: sp,
                                        to,
                                    },
                                );
                            }
                        }
                    }
                }
            } else if idle >= REROUTE && c.rung < 1 {
                c.rung = 1;
                self.record(now, who, order, Rung::Reroute);
                let _ = self.reroute(runner, town, who);
                // A new route to the same leg's end keeps the least distance to it: measured again from where the
                // walker stands, a walker going to and fro would count each swing back as progress, and be routed
                // again every few seconds without ever climbing further (#3168).
                if let (Some(c), Some(w)) = (self.clocks.get_mut(&who), self.walkers.get(&who)) {
                    c.leg = 0;
                    if w.legs[0].to != leg.to {
                        c.best = len(body.pose.position, w.legs[0].to);
                        c.mark = c.best;
                    }
                }
            }
        }
    }
}
