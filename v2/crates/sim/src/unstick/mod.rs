//! The never-stuck ladder (Engine v2 N10, #2657): no walking body is ever left stuck. A walker that makes no progress
//! climbs rungs by time, and its order ends by name before it could be parked; a body found on illegal ground walks
//! out to the nearest legal point.
//!
//! - **Time without progress.** Each second in which a walker comes at least a quarter of its free speed's worth
//!   nearer than it has ever been by its way left (through the corner its line aims at, to its leg's end), or nearer
//!   the corner it aims at, is progress and takes the second off its time without progress (to no less than none);
//!   any other second adds itself. A walker going round a block at full speed, its route heading away from its leg's
//!   end, comes nearer its corner; one held against a thing or a crowd comes nearer neither. A corner counts when
//!   aimed at the whole second (nearer than ever while aimed at) or turned to in it (nearer than where the second
//!   began), and one turned back to within [`LONG`] keeps the least distance it had (after the stall watch's), so a
//!   walker rocking or going to and fro between corners gains on none after its first swing. A tick with no line for
//!   the leg (the planner's answer pending) measures nothing. A new leg starts the clock again, and so does, while it
//!   waits for a link taken in turns (N8), that link's owner letting someone in or turning it (the queue moves). The
//!   rungs go by this time, so a walker circling a goal it cannot reach, or nudged forward now and then, still climbs
//!   them: coming nearer a corner counts only while its least way left has shrunk by [`GAIN`] within [`LONG`] (the
//!   backstop, as the stall watch's). A new route to the same leg's end (the reroute rung) keeps its least way left,
//!   so one going to and fro climbs too; a new leg's end is measured again once a clock and keeps the backstop's time,
//!   so one routed again and again still ends.
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
/// The backstop: a walker coming nearer its corner counts as progress only while its least way left has shrunk by
/// [`GAIN`] within this, µs (the stall watch's, `crate::walk::stall::LONG`).
pub const LONG: Micros = crate::walk::stall::LONG;
/// What the least way left must shrink by to keep the backstop off, µm (`crate::walk::stall::GAIN`).
pub const GAIN: i64 = crate::walk::stall::GAIN;
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

/// The least way left before a tick with a line has measured it (a new clock, or a new leg's end from a reroute).
const UNSET: i64 = i64::MAX;
/// How many of the corners a walker turned away from its progress remembers.
const GONE: usize = 4;

/// A walker's progress: its leg, the least way left to that leg's end (through the corner its line aims at), the
/// time without progress (µs) and the rungs climbed.
#[derive(Clone, Copy)]
struct Clock {
    leg: usize,
    /// [`UNSET`] until a tick with a line for the leg measures it.
    best: i64,
    /// The least way left at the last second's mark, where the walker stood then, and when that was.
    mark: i64,
    from: [i64; 2],
    at: Micros,
    idle: Micros,
    rung: u8,
    /// The corner aimed at (x and z µm), since when, the least distance to it while aimed at, and that at the last
    /// mark; whether the aim turned this second to a corner not turned back to.
    aim: Option<[i64; 2]>,
    aimed: Micros,
    near: i64,
    near_mark: i64,
    turned: bool,
    /// The last [`GONE`] corners turned away from: each, its least distance then, and when.
    gone: [([i64; 2], i64, Micros); GONE],
    /// The least way left when it last shrank by [`GAIN`], and when (the backstop).
    long: (i64, Micros),
    /// A reroute has given this clock a new leg's end.
    moved: bool,
}

impl Clock {
    fn new(leg: usize, now: Micros) -> Clock {
        Clock {
            leg,
            best: UNSET,
            mark: UNSET,
            from: [0, 0],
            at: now,
            idle: 0,
            rung: 0,
            aim: None,
            aimed: Micros::MAX,
            near: UNSET,
            near_mark: UNSET,
            turned: false,
            gone: [([0, 0], 0, Micros::MIN); GONE],
            long: (UNSET, now),
            moved: false,
        }
    }

    /// A tick of the walker at `here` (x and z µm), its line aiming at `aim` on the way to its leg's end `end`
    /// (`None`: no line for this leg, the planner's answer pending). A tick with no line is no tick of walking (as
    /// the stall watch skips a walk aimed at its own place): its straight distance is no way left.
    fn seen(&mut self, now: Micros, here: [i64; 2], aim: Option<[i64; 2]>, end: [i64; 2]) {
        let Some(aim) = aim else {
            return;
        };
        let near = dist(here, aim);
        let left = near.saturating_add(dist(aim, end));
        if self.best == UNSET {
            // Measured from here; the backstop's time goes on.
            (self.best, self.mark, self.from, self.long.0) = (left, left, here, left);
        }
        self.best = self.best.min(left);
        if self.best.saturating_add(GAIN) <= self.long.0 {
            self.long = (self.best, now);
        }
        if self.aim == Some(aim) {
            self.near = self.near.min(near);
            return;
        }
        // A new corner is measured from where the walker stands when it turns to it. One it turned away from within
        // [`LONG`] keeps the least distance it had then (after the stall watch's rule that a corner turned back to is
        // no new corner, kept longer and with its distance), so a walker going to and fro between corners gains on
        // none after its first swing.
        let back = self
            .gone
            .iter()
            .find(|g| g.0 == aim && g.2 > now - LONG)
            .map(|g| g.1);
        if let Some(old) = self.aim {
            self.gone.rotate_right(1);
            self.gone[0] = (old, self.near, now);
        }
        self.near = back.map_or(near, |b| b.min(near));
        (self.aim, self.aimed, self.near_mark, self.turned) =
            (Some(aim), now, self.near, back.is_none());
    }

    /// A second's mark, the walker at `here` at free speed `speed`. Progress is coming a quarter of that speed's
    /// worth nearer than ever by the way left, or, while the backstop holds, nearer the corner aimed at: aimed at the
    /// whole second, nearer than ever while aimed at; turned to this second, nearer than where it stood at the last
    /// mark. It takes the second off the time without progress (to no less than none); any other second adds itself.
    fn second(&mut self, now: Micros, here: [i64; 2], speed: i64) {
        let span = now - self.at;
        // At least 1 µm: a walker given no speed still climbs.
        let q = (speed * span / 4_000_000).max(1);
        let on_left = self.mark - self.best >= q;
        let on_corner = now - self.long.1 < LONG
            && self.aim.is_some_and(|aim| {
                if self.aimed <= self.at {
                    self.near_mark - self.near >= q
                } else {
                    self.turned && dist(self.from, aim) - dist(here, aim) >= q
                }
            });
        if on_left || on_corner {
            self.idle = (self.idle - span).max(0);
        } else {
            self.idle += span;
        }
        (self.mark, self.near_mark, self.from, self.at, self.turned) =
            (self.best, self.near, here, now, false);
    }

    /// A reroute gave the walk a new leg's end: its way left is measured again at its next tick with a line, once a
    /// clock. Its time without progress, its rungs, the backstop's time and the corners it turned from are kept, so a
    /// walker going to and fro that is routed again and again still climbs (and a second new end is measured against
    /// the least way left so far).
    fn rerouted(&mut self) {
        if !self.moved {
            (self.moved, self.best, self.mark) = (true, UNSET, UNSET);
        }
    }
}

/// The distance between two points (x and z µm), µm; [`i64::MAX`] past that (no input overflows).
fn dist(a: [i64; 2], b: [i64; 2]) -> i64 {
    let d = |u: i64, v: i64| (i128::from(u) - i128::from(v)).unsigned_abs();
    let (x, z) = (d(a[0], b[0]), d(a[1], b[1]));
    x.checked_mul(x)
        .zip(z.checked_mul(z))
        .and_then(|(x, z)| x.checked_add(z))
        .and_then(|s| i64::try_from(s.isqrt()).ok())
        .unwrap_or(i64::MAX)
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
    /// A served world's ladder (`worldd`, 0.133 N1): no route search on the clock thread; the reroute rung asks the
    /// world's planner again ([`Ladder::served`]).
    served: bool,
}

fn len(a: Vec3, b: Vec3) -> i64 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    (d(a.x, b.x) + d(a.z, b.z)).isqrt() as i64
}

impl Ladder {
    pub fn new() -> Ladder {
        Ladder::default()
    }

    /// A ladder for a served world, whose routes are searched off the clock (K18b): the reroute rung lets go the walk's
    /// granted place, so the runner asks the planner for its place and legs again from where it stands, and the walk
    /// is given them a tick later ([`Ladder::routed`]).
    pub fn served() -> Ladder {
        Ladder {
            served: true,
            ..Ladder::default()
        }
    }

    /// `who`'s walk, for the order the ladder keeps, was given new legs from where it stands (a served world's planner
    /// answered its reroute): it walks them from the first, and keeps its least way left to its leg's end, as a reroute
    /// does (#3168); a new leg's end is measured again once a clock ([`Clock::rerouted`]).
    pub fn routed(&mut self, runner: &Runner, who: Id, legs: Vec<Leg>) {
        let Some(w) = self.walkers.get_mut(&who) else {
            return;
        };
        let old = w.legs.get(w.leg).copied();
        (w.legs, w.leg) = (legs, 0);
        if let (Some(c), Some(first), Some(_)) = (
            self.clocks.get_mut(&who),
            w.legs.first(),
            runner.controller.body(who),
        ) {
            c.leg = 0;
            if old.is_none_or(|l| l.to != first.to) {
                c.rerouted();
            }
        }
    }

    /// Keeps a walker the runner walks along `legs` for the order `order`, at free speed `speed`, to `goal` on
    /// `node`, for routing it again.
    pub fn add(&mut self, who: Id, order: Id, speed: i64, node: Id, goal: Vec3, legs: Vec<Leg>) {
        // A new walk is a new leg: its clock starts again.
        self.clocks.remove(&who);
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

    /// The order the ladder keeps `who`'s walk for.
    pub fn order(&self, who: Id) -> Option<Id> {
        self.walkers.get(&who).map(|w| w.order)
    }

    /// Lets go every walker whose run has ended and that is not walking out (a served world keeps no walk it no longer
    /// runs).
    pub fn forget_ended(&mut self, runner: &Runner) {
        let running = runner.running_bodies();
        let outs = &self.outs;
        self.walkers
            .retain(|who, _| running.contains(who) || outs.contains(who));
        let walkers = &self.walkers;
        self.clocks.retain(|who, _| walkers.contains_key(who));
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
        if self.served {
            // A served world searches no route on its clock: the planner plans it again from where it stands, and its
            // answer comes to [`Ladder::routed`] (0.133 N1).
            runner.granted.remove(&who);
            runner.overflow.remove(&who);
            return Ok(());
        }
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
            hold: false,
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

    /// The rungs after a tick a served world ran itself (`worldd` steps the runner with the planner's answers, K18b):
    /// each walker the tick refused ended, the walk-outs ended, then each walker's clock and rungs, as [`Ladder::step`]
    /// does after its own tick.
    pub fn after(&mut self, runner: &mut Runner, town: &mut Town) {
        self.faults(runner);
        self.climb(runner, town);
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
            let p = body.pose.position;
            let gap = len(p, leg.to);
            // The corner its line aims at on the way to this leg's end: the way left goes through it. A route round a
            // block heads away from the leg's end, and a walker going round it at full speed comes no nearer that end
            // for a while (#4914's long walks to a landform, round the vineyard). No line for this leg (the planner's
            // answer pending): nothing is measured.
            let end = [leg.to.x, leg.to.z];
            let here = [p.x, p.z];
            let aim = town
                .next_corner_toward(who)
                .filter(|&(n, _, to)| n == node_of(&body) && to == Some(end))
                .map(|(_, c, _)| c);
            let fresh = Clock::new(wleg, now);
            let c = self.clocks.entry(who).or_insert(fresh);
            // A new leg, or a queue that moved, starts the clock again.
            let moved = waits
                .and_then(|(l, _)| town.moved(l))
                .is_some_and(|m| m > c.at);
            if c.leg != wleg || moved {
                *c = fresh;
                c.seen(now, here, aim, end);
                if let Some(f) = runner.fields.get_mut(&who) {
                    f.remove(&F_SHOULDER);
                }
                continue;
            }
            // Each second's progress, by [`Clock::second`]: the way left, or the corner aimed at while the backstop
            // holds, so a walker circling a block, rocking between corners or going to and fro still climbs.
            c.seen(now, here, aim, end);
            if now - c.at >= SECOND {
                c.second(now, here, speed);
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
                                hold: false,
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
                // A new route to the same leg's end keeps the least way left to it: measured again from where the
                // walker stands, a walker going to and fro would count each swing back as progress, and be routed
                // again every few seconds without ever climbing further (#3168). A new leg's end is measured again
                // once a clock, and keeps the backstop's time. A served world's legs come later, to
                // [`Ladder::routed`], which does this; until then the walk keeps its leg and its clock.
                if let (false, Some(c), Some(w)) = (
                    self.served,
                    self.clocks.get_mut(&who),
                    self.walkers.get(&who),
                ) {
                    c.leg = 0;
                    if w.legs[0].to != leg.to {
                        c.rerouted();
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Micros = 50_000;
    /// 1.4 m/s: 70 mm a tick.
    const SPEED: i64 = 1_400_000;

    /// Runs a walker's clock as the ladder climbs it, a tick each [`TICK`], for `ticks` ticks. `walk(t, n)` gives where
    /// the walker stands at tick `t`, the corner its line aims at (`None`: no line) and its leg's end, after `n` new
    /// reroutes; `forced(t)` whether a served planner routes it again at `t` besides the reroute rung. Returns when its
    /// order ends ([`END`] without progress), `None` if it walks on, and how many times it was routed again.
    fn run(
        ticks: i64,
        walk: impl Fn(i64, u32) -> ([i64; 2], Option<[i64; 2]>, [i64; 2]),
        forced: impl Fn(i64) -> bool,
    ) -> (Option<Micros>, u32) {
        let (mut c, mut n) = (Clock::new(0, 0), 0u32);
        for t in 0..ticks {
            let now = t * TICK;
            let (here, aim, end) = walk(t, n);
            c.seen(now, here, aim, end);
            if now - c.at >= SECOND {
                c.second(now, here, SPEED);
                if c.idle == 0 {
                    c.rung = 0;
                }
            }
            if c.idle >= END {
                return (Some(now), n);
            }
            let rung = if c.idle >= SHOULDER {
                c.rung = c.rung.max(3);
                false
            } else if c.idle >= MAKE_WAY {
                c.rung = c.rung.max(2);
                false
            } else if c.idle >= REROUTE && c.rung < 1 {
                c.rung = 1;
                true
            } else {
                false
            };
            if rung || forced(t) {
                n += 1;
                if walk(t, n).2 != end {
                    c.rerouted();
                }
            }
        }
        (None, n)
    }

    /// To and fro between corners `a` and `b`, aiming at the one it walks toward, at 1.4 m/s from `a`.
    fn to_and_fro(t: i64, a: [i64; 2], b: [i64; 2]) -> ([i64; 2], [i64; 2]) {
        let d = dist(a, b);
        let s = (t * 70_000) % (2 * d);
        let (from, to, f) = if s <= d { (a, b, s) } else { (b, a, s - d) };
        let here = [
            from[0] + (to[0] - from[0]) * f / d,
            from[1] + (to[1] - from[1]) * f / d,
        ];
        (here, to)
    }

    /// Along the line `line` at 1.4 m/s from its first point, aiming at the next; round and round when `closed`.
    fn along(t: i64, line: &[[i64; 2]], closed: bool) -> ([i64; 2], [i64; 2]) {
        let n = if closed { line.len() } else { line.len() - 1 };
        let lap: i64 = (0..n)
            .map(|i| dist(line[i], line[(i + 1) % line.len()]))
            .sum();
        let mut s = t * 70_000;
        if closed {
            s %= lap;
        }
        for i in 0..n {
            let (a, b) = (line[i], line[(i + 1) % line.len()]);
            let d = dist(a, b);
            if s < d {
                return (
                    [a[0] + (b[0] - a[0]) * s / d, a[1] + (b[1] - a[1]) * s / d],
                    b,
                );
            }
            s -= d;
        }
        (line[n], line[n])
    }

    /// Review of #4946: a walker held going to and fro, rocking or circling gains on no corner for ever.
    /// - To and fro between corners 10 m apart, its leg's end 20 m to the side: its first swing each way is progress
    ///   (14.3 s), and then no second is, so it ends [`END`] later, at 29 s (51 s without the stall watch's guards,
    ///   each corner measured afresh: to the backstop, then [`END`]).
    /// - Rocking 1.2 m between two near corners, turning every 0.9 s: at 16 s (28 s without the corners it remembers).
    /// - Circling a ring of more corners than it remembers: by the backstop and [`END`], at 48 s.
    #[test]
    fn a_walker_going_to_and_fro_rocking_or_circling_ends() {
        let (a, b, to) = ([0, 0], [10_000_000, 0], [5_000_000, 20_000_000]);
        let walk = |t, _| {
            let (here, aim) = to_and_fro(t, a, b);
            (here, Some(aim), to)
        };
        let at = run(4000, walk, |_| false).0.expect("to and fro ends");
        assert!(
            (END..=30_000_000).contains(&at),
            "to and fro ended at {at} µs"
        );

        let (a, b, to) = (
            [1_500_000, 500_000],
            [-300_000, 600_000],
            [5_000_000, 5_000_000],
        );
        let walk = |t: i64, _| {
            let f = (t * 70_000) % 2_400_000;
            let (x, aim) = if f <= 1_200_000 {
                (f, a)
            } else {
                (2_400_000 - f, b)
            };
            ([x, 0], Some(aim), to)
        };
        let at = run(4000, walk, |_| false).0.expect("rocking ends");
        assert!(at <= END + 2 * SECOND, "rocking ended at {at} µs");

        // Twelve corners round its leg's end, 10 m out (a lap of 45 s): each corner it aims at is one it has not
        // turned from within its memory, so only the backstop stops it gaining on them.
        let ring: Vec<[i64; 2]> = (0..12)
            .map(|i| {
                let r = std::f64::consts::TAU * f64::from(i) / 12.0;
                [(10e6 * r.cos()) as i64, (10e6 * r.sin()) as i64]
            })
            .collect();
        let walk = |t, _| {
            let (here, aim) = along(t, &ring, true);
            (here, Some(aim), [0, 0])
        };
        let at = run(4000, walk, |_| false).0.expect("circling ends");
        assert!(at <= LONG + END + 4 * SECOND, "circling ended at {at} µs");
    }

    /// Review of #4946: a walker going to and fro that is routed again and again, each time to another leg's end,
    /// still ends: by the reroute rung (37 s, its least way left measured again once), and with a served planner moving
    /// its leg's end every 3 s besides (31 s). Before, each new end started the backstop's time again, so it could
    /// walk for ever.
    #[test]
    fn a_walker_routed_again_and_again_to_new_ends_ends() {
        let (a, b) = ([0, 0], [10_000_000, 0]);
        let ends = [[5_000_000, 20_000_000], [5_000_000, -8_000_000]];
        let walk = |t, n: u32| {
            let (here, aim) = to_and_fro(t, a, b);
            (here, Some(aim), ends[n as usize % 2])
        };
        let (at, n) = run(4000, walk, |_| false);
        let at = at.expect("ends with the reroute rung");
        assert!(n >= 2, "routed again {n} times");
        assert!(at <= 38_000_000, "rerouted by the rung, ended at {at} µs");
        let (at, n) = run(4000, walk, |t| t % 60 == 59);
        let at = at.expect("ends with its end moved");
        assert!(n >= 5, "routed again {n} times");
        assert!(at <= 32_000_000, "rerouted every 3 s, ended at {at} µs");
    }

    /// #4914's long walks, in a served world: the planner's line comes on its third tick, then leads 14 m away from
    /// the leg's end, 14 m across and 24 m back past it (47 s). The way left is measured through the corners from the
    /// first tick with a line, and coming nearer each new corner is progress: it is never routed again. Before, the
    /// straight distance on the first ticks was taken as its least way left, and it was routed again on its way.
    #[test]
    fn a_walk_round_a_block_away_from_its_end_is_progress() {
        let to = [0, -10_000_000];
        let line = [
            [0, 0],
            [0, 14_000_000],
            [14_000_000, 14_000_000],
            [14_000_000, -10_000_000],
            to,
        ];
        let walk = |t: i64, _| {
            if t < 2 {
                return ([0, 0], None, to);
            }
            let (here, aim) = along(t - 2, &line, false);
            (here, Some(aim), to)
        };
        assert_eq!(run(940, walk, |_| false), (None, 0));
        // Held where its line begins, it is routed again at 3 s and ends at [`END`].
        let held = |_, _| ([0, 0], Some([0, 14_000_000]), to);
        assert_eq!(run(1400, held, |_| false), (Some(END), 1));
    }
}
