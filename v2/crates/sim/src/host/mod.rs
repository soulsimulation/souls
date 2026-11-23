//! The world's side of the host interface (Engine v2 K13a, #2676; contract T9, `v2/docs/bodies.md` rules 7 to 9).
//! Skills touch the world only through `replica::host::Host`; this module is the one place `sim` implements it, and
//! the one place a skill's controller inputs are handed on (to the controller, B1 #2680).
//!
//! - **One phase a tick.** [`step`] steps every running skill once, in its body's id order, against the tree as it
//!   stood at the tick's start: the tree is borrowed read-only for the whole phase, so nothing a skill does can change
//!   what another reads in the same tick (T1).
//! - **Side by side** (N17b, #3255). [`Runner::tick`] steps the skills that allow it on [`Runner::threads`] threads,
//!   a chunk of runs at a time, and joins their stages in body order (`beside`); the controller's step, the inputs
//!   handed on and the ladder's reads are split the same way (`crate::par`). The outcome is the same, bit for bit,
//!   at any thread count, and a skill that panics ends its own run by name (`unit-panicked`).
//! - **Everything staged.** Controller inputs, entries, timers set and cleared are held in [`Staged`] until every
//!   skill has stepped. The caller applies them after: inputs through [`hand_on`] to the controller (B1 #2680),
//!   entries to the log, timers to the due list (K9 #2672). A skill does not see its own emits either.
//! - **One movement path.** A skill moves its body only by controller inputs, under the driver its run was given:
//!   the controller refuses an input from a driver that does not hold the resources, and an emit of a motion change
//!   on the skill's own body is refused (`motion-outside-controller`).
//! - **Reads.** A node as [`Seen`]: kind, parent, position in its parent's frame and fields, by value. No reference
//!   into the tree crosses the interface.
//! - **Geometry** is asked of a [`Geometry`], the N lane's answers in integers (T9's closed list).
//! - **Draws** are SplitMix64 over a seed the caller gives and a count of draws in this tick, so a log replays them.
//! - **Counted.** Every host call adds one to [`Staged::calls`], for F8's metering.
//!
//! - **Crossing a link** (T9b #3120): `Host::cross` is staged as a request, and [`carry`] has the world's [`Links`]
//!   turn it into the controller's [`Track`], which the controller carries the body along. A shut door is opened by
//!   the world, not the walker: [`Links::track`] writes the opening and the body stands that tick.
//! - **What the tree does not hold yet** (bodies in the controller, a link's turn state) is read through
//!   [`Geometry::read`], before the tree.
//!
//! - **The runner** ([`Runner`], T9c #3127): skills on bodies in the controller over a town, a tick at a time. The
//!   marks are read for the turns, the skills step, their inputs and crossings are handed on, their entries set their
//!   bodies' fields, and the controller steps. It answers the walk's questions: the next corner (the town), the bodies
//!   near (the controller's spatial index, N16 `crate::index`: the bodies as the mover left them at the last tick's
//!   end), and reads of bodies and links.
//! - **With a planner** ([`Runner::tick_planned`], K18b #3175): the runner runs no route search. The spot tables, a
//!   granted walk's legs and each walker's line are the planner's (`crate::planner`), answered from the last tick's
//!   [`Wants`]; the clock asks only whether a straight walk is clear (the controller's dry run). A walk gets its place
//!   and legs a tick after it asks, and stands a tick wherever it would have searched for a new line (a new leg whose
//!   straight way is not clear, pushed off its line, a line's end, a refused check).
//!
//! - **Changed ground** (G3, #2760). At the start of each tick, after an edit's ground is installed
//!   (`Town::install`), each body not carried whose node's ground version moved since it last stood is found again
//!   on that ground where it stands ([`Runner::reground`]). One that stands on none now is marked off the ground
//!   ([`Runner::off_ground`]): it is held (`F_HELD`), stands, and no skill moves it until N10's last rung walks it out
//!   by name. The walks planned on the changed ground are planned again by the ladder (`crate::unstick`).
//!
//! - **After a restart** ([`restart`], K13b #3119): each order the log holds as accepted and not ended is handed to
//!   its skill again, from where its body stands, or ended with a named reason.
//!
//! Not here: entries to the log, timers (K9).

mod beside;
pub mod restart;

pub use beside::{BESIDE_ORDERED, CHUNK, UNIT_PANICKED};

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};

use replica::bodies::Family;
use replica::effects::{Change, Event, Refusal, read_id};
use replica::encode::{Name, Value};
use replica::host::{
    Answer, Ask, F_CROSSING, F_HELD, F_ROUTE, F_SETTLED, F_SHOULDER, F_WAITING, Host, Near,
    Progress, Seen, Skill, WalkPlan,
};
use replica::ids::{Id, Minter, Scope};
use replica::pose::{ControllerInput, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::End;

use crate::controller::{Controller, Driver, Line, Part, Track};
use crate::mover::Body as Moved;
use crate::spots::Target;
use crate::unit::{Ran, Units};
use crate::walk::town::{Found, Plans, Town, View};
use crate::walk::{Leg, Mark, World, node_of};

/// The N lane's answers to T9's closed list of geometry questions, asked for `body`.
pub trait Geometry {
    fn ask(&self, body: Id, q: &Ask) -> Option<Answer>;
    /// Where `body` may stand within `reach` of `at` to act there ([`Host::stand_near`], C15); `None` by default.
    fn stand_near(&self, _body: Id, _at: Vec3, _reach: i64) -> Option<Vec3> {
        None
    }
    /// The legs of `body`'s walk to `at` of `node`'s frame, or near it ([`Host::legs`], C17); `None` by default.
    fn legs(&self, _body: Id, _node: Id, _at: Vec3, _reach: i64) -> Option<Vec<Leg>> {
        None
    }
    /// One form step's plan, with Pending distinct from a missing geometry interface.
    fn plan_walk(&self, body: Id, _step: usize, node: Id, at: Vec3, reach: i64) -> WalkPlan {
        self.legs(body, node, at, reach)
            .map_or(WalkPlan::Unplanned, |legs| {
                WalkPlan::Legs(legs.into_iter().map(|l| (l.to, l.link)).collect())
            })
    }
    /// A node the world holds outside the tree for now (a body's pose in the controller, a link's turn state, T9b
    /// A3), as of the tick's start; `None` reads the tree.
    fn read(&self, _node: Id) -> Option<Seen> {
        None
    }
    /// One field of such a node as [`Geometry::read`] shows it (the inner `None`: the node holds no such field);
    /// `None` reads the tree.
    fn field(&self, node: Id, field: u64) -> Option<Option<Value>> {
        self.read(node).map(|mut s| s.fields.remove(&field))
    }
    /// Such a node's position as [`Geometry::read`] shows it; `None` reads the tree.
    fn position(&self, node: Id) -> Option<Vec3> {
        self.read(node).map(|s| s.position)
    }
}

/// The world's side of a crossing: the track a body is carried along across `link` at `speed`, or `None` while it
/// stands (a shut door being opened for it, written by the world with the body as the acting Soul).
pub trait Links {
    fn track(
        &mut self,
        body: &Moved,
        link: Id,
        speed: i64,
        at: Micros,
    ) -> Result<Option<Track>, Refusal>;
    /// Whether `link` is taken in turns (N8): its owner's turns keep its far end clear, so a crossing of it is not held
    /// for a body standing where it lands (#4215).
    fn in_turns(&self, _link: Id) -> bool {
        false
    }
}

/// A running skill on a body.
pub struct Run {
    pub body: Id,
    /// The driver the controller gave this run's claims ([`Controller::claim`]).
    pub driver: Driver,
    pub skill: Box<dyn Skill>,
}

/// One entry a skill emitted: its body, the changes and what they meant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Emit {
    pub body: Id,
    pub changes: Vec<Change>,
    pub meaning: Option<Event>,
}

/// A timer a skill set on its body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Timer {
    pub body: Id,
    pub id: Id,
    /// World time it is due, µs.
    pub due: Micros,
    pub name: Name,
}

/// What a tick's skills asked for, held until all of them have stepped.
#[derive(Debug, Default)]
pub struct Staged {
    /// Controller inputs with their run's driver, in body order; a run's last input in the tick wins.
    pub controls: Vec<(Id, Driver, ControllerInput)>,
    /// Crossings asked for, with their run's driver: body, driver, link and speed (µm a second).
    pub crossings: Vec<(Id, Driver, Id, i64)>,
    pub emits: Vec<Emit>,
    pub timers: Vec<Timer>,
    /// Timers cleared: body and timer.
    pub cleared: Vec<(Id, Id)>,
    /// The runs that ended this tick, with how; they are no longer in the run list.
    pub ended: Vec<(Id, Progress)>,
    /// Host calls made, every kind counted.
    pub calls: u64,
    draws: u64,
}

/// The host one skill sees while it steps.
struct WorldHost<'a, G> {
    tree: &'a Tree,
    geometry: &'a G,
    now: Micros,
    seed: u64,
    body: Id,
    driver: Driver,
    /// `None` for a skill stepped beside others ([`Skill::beside`]): it may neither draw nor set a timer.
    minter: Option<&'a mut Minter>,
    staged: &'a mut Staged,
    /// Host calls, reads and questions included (they take `&self`).
    calls: Cell<u64>,
}

fn splitmix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

fn outside(node: Id) -> Refusal {
    Refusal {
        name: "write-outside-own",
        detail: replica::world_model::show(node),
    }
}

impl<G: Geometry> WorldHost<'_, G> {
    fn count(&self) {
        self.calls.set(self.calls.get() + 1);
    }

    /// T9 rule 7: changes to the body and to nodes the same changes create under it, all or none.
    fn own(&self, changes: &[Change]) -> Result<(), Refusal> {
        let mut mine = BTreeSet::from([self.body]);
        let check = |mine: &BTreeSet<Id>, n: Id| {
            if mine.contains(&n) {
                Ok(())
            } else {
                Err(outside(n))
            }
        };
        for c in changes {
            match c {
                Change::Create { node, pose, .. } => {
                    check(&mine, pose.frame.node)?;
                    mine.insert(*node);
                }
                // Moving the body into another frame is motion too: the controller carries it (T9b #3120).
                Change::Reparent { node, .. } if *node == self.body => {
                    return Err(Refusal {
                        name: "reparent-outside-controller",
                        detail: replica::world_model::show(*node),
                    });
                }
                Change::Remove { node }
                | Change::Reparent { node, .. }
                | Change::Set { node, .. } => check(&mine, *node)?,
                Change::Link { ends, owner, .. } => check(&mine, owning(*ends, *owner))?,
                Change::Unlink { link } => match self.tree.link(*link) {
                    Some((_, ends, owner, _)) => check(&mine, owning(ends, owner))?,
                    None => return Err(outside(*link)),
                },
                // The controller is the body's only driver of motion (B1 #2680).
                Change::Motion(h) if h.node == self.body => {
                    return Err(Refusal {
                        name: "motion-outside-controller",
                        detail: replica::world_model::show(h.node),
                    });
                }
                Change::Motion(h) => check(&mine, h.node)?,
            }
        }
        Ok(())
    }
}

fn owning(ends: [Id; 2], owner: End) -> Id {
    match owner {
        End::First => ends[0],
        End::Second => ends[1],
    }
}

impl<G: Geometry> Host for WorldHost<'_, G> {
    fn now(&self) -> Micros {
        self.count();
        self.now
    }

    fn body(&self) -> Id {
        self.count();
        self.body
    }

    fn read(&self, node: Id) -> Option<Seen> {
        self.count();
        if let Some(s) = self.geometry.read(node) {
            return Some(s);
        }
        let n = self.tree.node(self.tree.handle(node)?)?;
        Some(Seen {
            id: n.id(),
            kind: n.kind().clone(),
            parent: n.parent(),
            position: n.place().map_or(Vec3::ZERO, |p| p.position),
            fields: n.fields().clone(),
        })
    }

    fn field(&self, node: Id, field: u64) -> Option<Value> {
        self.count();
        if let Some(v) = self.geometry.field(node, field) {
            return v;
        }
        let n = self.tree.node(self.tree.handle(node)?)?;
        n.fields().get(&field).cloned()
    }

    fn position(&self, node: Id) -> Option<Vec3> {
        self.count();
        if let Some(p) = self.geometry.position(node) {
            return Some(p);
        }
        let n = self.tree.node(self.tree.handle(node)?)?;
        Some(n.place().map_or(Vec3::ZERO, |p| p.position))
    }

    fn ask(&self, q: &Ask) -> Option<Answer> {
        self.count();
        self.geometry.ask(self.body, q)
    }

    fn stand_near(&self, at: Vec3, reach: i64) -> Option<Vec3> {
        self.count();
        self.geometry.stand_near(self.body, at, reach)
    }

    fn legs(&self, node: Id, at: Vec3, reach: i64) -> Option<Vec<(Vec3, Option<Id>)>> {
        self.count();
        let legs = self.geometry.legs(self.body, node, at, reach)?;
        Some(legs.into_iter().map(|l| (l.to, l.link)).collect())
    }

    fn plan_walk(&self, step: usize, node: Id, at: Vec3, reach: i64) -> WalkPlan {
        self.count();
        self.geometry.plan_walk(self.body, step, node, at, reach)
    }

    fn set_timer(&mut self, after: Micros, name: Name) -> Id {
        self.count();
        let Some(minter) = self.minter.as_deref_mut() else {
            panic!("{BESIDE_ORDERED}: a skill stepped beside others set a timer");
        };
        // A scope's 2^64 counters cannot run out in a world's life; if they did, the timer is named by its body.
        let id = minter.mint().unwrap_or(self.body);
        self.staged.timers.push(Timer {
            body: self.body,
            id,
            due: self.now.saturating_add(after),
            name,
        });
        id
    }

    fn clear_timer(&mut self, timer: Id) {
        self.count();
        self.staged.cleared.push((self.body, timer));
    }

    fn draw(&mut self) -> u64 {
        self.count();
        if self.minter.is_none() {
            panic!("{BESIDE_ORDERED}: a skill stepped beside others drew");
        }
        self.staged.draws += 1;
        splitmix(self.seed ^ splitmix(self.staged.draws))
    }

    fn control(&mut self, input: ControllerInput) {
        self.count();
        match self.staged.controls.last_mut() {
            Some((b, d, last)) if *b == self.body && *d == self.driver => *last = input,
            _ => self.staged.controls.push((self.body, self.driver, input)),
        }
    }

    fn cross(&mut self, link: Id, speed: i64) {
        self.count();
        self.staged
            .crossings
            .push((self.body, self.driver, link, speed));
    }

    fn emit(&mut self, changes: Vec<Change>, meaning: Option<Event>) -> Result<(), Refusal> {
        self.count();
        self.own(&changes)?;
        self.staged.emits.push(Emit {
            body: self.body,
            changes,
            meaning,
        });
        Ok(())
    }
}

/// One tick's skill phase: steps every run once, in body id order, against `tree` as it stands (the tick's start),
/// and returns what they asked for, staged. Runs that end are taken out of `runs` and listed in [`Staged::ended`].
pub fn step(
    tree: &Tree,
    geometry: &impl Geometry,
    now: Micros,
    seed: u64,
    minter: &mut Minter,
    runs: &mut Vec<Run>,
) -> Staged {
    step_in_units(tree, geometry, now, seed, minter, runs, &mut Units::new())
}

/// [`step`], each skill's step one unit in K11's wrapper (`crate::unit`; K18 #3160): it stages into a [`Staged`] of
/// its own, kept only if it returns. A panic drops that stage and ends the run `unit-panicked`, its body idle; the
/// other runs and the tick go on. A skill whose unit is retired (its third panic) ends `unit-retired`.
pub fn step_in_units(
    tree: &Tree,
    geometry: &impl Geometry,
    now: Micros,
    seed: u64,
    minter: &mut Minter,
    runs: &mut Vec<Run>,
    units: &mut Units,
) -> Staged {
    let mut staged = Staged::default();
    runs.sort_by_key(|r| r.body);
    runs.retain_mut(|r| {
        let unit = r.skill.shape().name;
        let draws = staged.draws;
        let ran = units.run(
            unit.as_str(),
            r.body,
            &(),
            |_, out: &mut Vec<(Staged, Progress)>| {
                let mut own = Staged {
                    draws,
                    ..Staged::default()
                };
                let mut host = WorldHost {
                    tree,
                    geometry,
                    now,
                    seed,
                    body: r.body,
                    driver: r.driver,
                    minter: Some(&mut *minter),
                    staged: &mut own,
                    calls: Cell::new(0),
                };
                let progress = r.skill.step(&mut host);
                let calls = host.calls.get();
                own.calls += calls;
                out.push((own, progress));
            },
        );
        let (own, progress) = match ran {
            Ran::Done(mut v) => match v.pop() {
                Some(x) => x,
                None => return true,
            },
            Ran::Failed(e) => (Staged::default(), Progress::Failed(named(e.reason))),
            Ran::Refused(name) => (Staged::default(), Progress::Failed(named(name))),
        };
        staged.merge(own);
        match progress {
            Progress::Going => true,
            ended => {
                staged.ended.push((r.body, ended));
                false
            }
        }
    });
    staged
}

/// Lends `f` the host `body` sees under `driver`, outside the tick's skill phase, its calls staged and counted in
/// `staged` as [`step`]'s are: for a skill the world wakes on an event instead of stepping it each tick (F1 #2766).
#[allow(clippy::too_many_arguments)]
pub fn lend<T>(
    tree: &Tree,
    geometry: &impl Geometry,
    now: Micros,
    seed: u64,
    minter: &mut Minter,
    (body, driver): (Id, Driver),
    staged: &mut Staged,
    f: impl FnOnce(&mut dyn Host) -> T,
) -> T {
    let mut host = WorldHost {
        tree,
        geometry,
        now,
        seed,
        body,
        driver,
        minter: Some(minter),
        staged,
        calls: Cell::new(0),
    };
    let out = f(&mut host);
    host.staged.calls += host.calls.get();
    out
}

impl Staged {
    /// Adds one run's stage to the tick's, in order; its draws count on from where the tick's stood.
    fn merge(&mut self, own: Staged) {
        self.controls.extend(own.controls);
        self.crossings.extend(own.crossings);
        self.emits.extend(own.emits);
        self.timers.extend(own.timers);
        self.cleared.extend(own.cleared);
        self.ended.extend(own.ended);
        self.calls += own.calls;
        self.draws = self.draws.max(own.draws);
    }
}

/// Hands a tick's staged controller inputs to the controller, each under its run's driver: the one place a skill's
/// inputs go on (B1 #2680). An input whose driver does not hold the body's locomotion is refused by the controller and
/// changes nothing; the refusals are returned with their bodies.
pub fn hand_on(staged: &Staged, controller: &mut Controller) -> Vec<(Id, Refusal)> {
    hand_on_threads(staged, controller, 1)
}

/// [`hand_on`] on `threads` threads (N17b): the same refusals, in the same order.
pub fn hand_on_threads(
    staged: &Staged,
    controller: &mut Controller,
    threads: usize,
) -> Vec<(Id, Refusal)> {
    controller.set_velocities_on(&staged.controls, threads)
}

/// A crossing waits while another body stands within this of where it lands, µm (#4215).
pub use crate::controller::LANDING_ROOM;

/// Hands a tick's staged crossings on: for each, the world's [`Links`] gives the track (or opens a shut door, and the
/// body stands), and the controller carries the body along it under the run's driver. Refusals are returned with
/// their bodies; a refused crossing changes nothing.
pub fn carry(
    staged: &Staged,
    controller: &mut Controller,
    links: &mut impl Links,
    at: Micros,
) -> Vec<(Id, Refusal)> {
    carry_past(staged, controller, links, at, &BTreeSet::new())
}

/// [`carry`], with a crossing held while a body other than those in `queued` stands where it would land (#4215).
pub fn carry_past(
    staged: &Staged,
    controller: &mut Controller,
    links: &mut impl Links,
    at: Micros,
    queued: &BTreeSet<Id>,
) -> Vec<(Id, Refusal)> {
    let mut refused = Vec::new();
    // Those asking to cross this tick leave where they stand: a body at a link's far end asking the other way does not
    // hold a crossing toward it.
    let mut leaving: BTreeSet<Id> = staged.crossings.iter().map(|c| c.0).collect();
    leaving.extend(queued);
    for &(body, driver, link, speed) in &staged.crossings {
        let Some(b) = controller.body(body).copied() else {
            refused.push((
                body,
                Refusal {
                    name: "body-unknown",
                    detail: replica::world_model::show(body),
                },
            ));
            continue;
        };
        let r = match links.track(&b, link, speed, at) {
            Ok(Some(t))
                if links.in_turns(link)
                    || !controller.landing_taken(body, &t, LANDING_ROOM, &leaving) =>
            {
                controller.cross(body, driver, t)
            }
            // A shut door being opened, or a body standing where it would land (#4215): it stands and asks again.
            Ok(_) => controller.set(
                body,
                driver,
                Part::Velocity(Vec3::ZERO, replica::pose::Mode::Surface),
            ),
            Err(r) => Err(r),
        };
        if let Err(r) = r {
            refused.push((body, r));
        }
    }
    refused
}

/// Skills on bodies in the controller over a town, a tick at a time (T9c #3127).
pub struct Runner {
    pub controller: Controller,
    /// Each body's own fields: set by its skill's entries and by the world's rules (N10's ladder). The tree does not
    /// hold bodies yet.
    pub fields: BTreeMap<Id, BTreeMap<u64, Value>>,
    /// The running skills.
    pub runs: Vec<Run>,
    /// The bodies staying where they are by their own order (E3's order; a scripted marker here): no run moves them.
    pub staying: BTreeSet<Id>,
    pub tick: Micros,
    /// World time, µs: the end of the last tick.
    pub now: Micros,
    /// The runs that ended: when (the tick's start) and how.
    pub ended: BTreeMap<Id, (Micros, Progress)>,
    /// What each body was sent to, and the order it was sent for: it asks a standing spot near the point (N9) while
    /// its order lasts.
    pub asks: BTreeMap<Id, (Target, Id)>,
    /// The place each asker was granted (µm, the target node's frame).
    pub granted: BTreeMap<Id, Vec3>,
    /// The actual planner's route metrics, bound to the body and its current order (C29).
    route_metrics: BTreeMap<Id, (Id, crate::walk::town::RouteMetrics)>,
    /// The last tick's refusals, each of one body (the tick went on for the others), in the order they came; each
    /// refused body's run ended by the first one's name.
    pub refused: Vec<(Id, Refusal)>,
    /// The utterances the last tick's controller step started (B11), with when each ends: the world resolves their
    /// hearers (`crate::speech::heard`).
    pub said: Vec<(Id, Line, Micros)>,
    /// The bodies found off the ground after an edit (G3): held, standing, until they are walked out.
    pub off_ground: BTreeSet<Id>,
    /// The node each body stood on and that node's ground version, as of the last [`Runner::reground`] (G3).
    stood: BTreeMap<Id, (Id, u64)>,
    /// When [`Runner::reground`] last ran (the tick's start).
    grounded: Option<Micros>,
    /// The routes the world gave each body (`F_ROUTE`), counted.
    routes: BTreeMap<Id, u64>,
    seed: u64,
    minter: Minter,
    /// Each skill's step is a unit in K11's wrapper: a panic ends that run, a third retires the skill (K18 #3160).
    pub units: Units,
    /// Threads stepping the skills that may be stepped side by side ([`Skill::beside`], N17b #3255), the tick's own
    /// included; 1 steps them all on it. Whatever the count, every tick's outcome is the same.
    pub threads: usize,
    /// How many such skills one thread takes at a time, in body order. The outcome does not depend on it either.
    pub chunk: usize,
}

fn decode_int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

/// A body's waiting mark (`F_WAITING`, `[link, distance µm]`), from its fields.
pub fn waiting(fields: Option<&BTreeMap<u64, Value>>) -> Option<(Id, i64)> {
    let Some(Value::Array(a)) = fields?.get(&F_WAITING) else {
        return None;
    };
    let [l, g] = a.as_slice() else { return None };
    Some((read_id(l).ok()?, decode_int(g)?))
}

fn body_kind() -> Name {
    Name::new("souls:body").unwrap_or_else(|| unreachable!("a fixed name"))
}

/// A refusal's name as a run's end.
pub fn named(name: &str) -> Name {
    Name::new(name).unwrap_or_else(body_kind)
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

/// The `F_ROUTE` value of route `count`: `[count, [[x, y, z] or [x, y, z, link], ...]]`.
fn route_value(count: u64, legs: &[Leg]) -> Value {
    let legs = legs
        .iter()
        .map(|l| {
            let mut v = vec![int(l.to.x), int(l.to.y), int(l.to.z)];
            v.extend(l.link.map(|k| k.to_value()));
            Value::Array(v)
        })
        .collect();
    Value::Array(vec![Value::Uint(count), Value::Array(legs)])
}

/// One exact slot's reach question, tied to the pending move's order so an older answer cannot serve a new move.
#[derive(Clone, Debug)]
pub struct ReachQuestion {
    pub body: Id,
    pub at: Vec3,
    pub thing: Id,
    pub slot: u64,
    pub order: Id,
    pub points: [Vec3; 2],
}

/// Body, fixture, exact slot, and move order.
pub type ReachKey = (Id, Id, u64, Id);

/// What a tick asks the world's planner (K18b, #3175), read as of the tick's start, for the planner to answer
/// before the next tick: the route searches the clock does not run.
#[derive(Clone, Debug, Default)]
pub struct Wants {
    /// Non-default admitted classes of this exact body snapshot.
    pub classes: BTreeMap<Id, replica::kinds::sizes::Size>,
    /// The tick's end, world time: the spot tables are written for it.
    pub at: Micros,
    /// Every body's mark, for the spot tables (N9): `None` in a batch of reach questions alone, which writes none.
    pub marks: Option<Vec<Mark>>,
    /// The walks waiting for their place: the body as it stood, its target and its order.
    pub places: Vec<(Moved, Target, Id)>,
    /// The walkers that need a new line and whose straight way to the leg's end was not clear: the body as it stood
    /// and the leg's end.
    pub lines: Vec<(Moved, Vec3)>,
    /// Reach questions (B2, B3), retaining exact slot and pending move identity.
    pub reach: Vec<ReachQuestion>,
    /// Immutable map identity shared by every route, line, reach and form question in this batch.
    pub form_map: Option<std::sync::Arc<crate::ground::Versions>>,
    pub forms: Vec<crate::planner::FormQuestion>,
}

/// A walk's place and legs, or a refusal's name.
pub type Placed = Result<(Vec3, Vec<Leg>, crate::walk::town::RouteMetrics), &'static str>;

/// The lines a tick's walkers asked for: the body as it stood and the leg's end.
type Asked = RefCell<Vec<(Moved, Vec3)>>;

/// The planner's answers to a tick's [`Wants`], used by the next tick ([`Runner::tick_planned`]).
#[derive(Clone, Debug, Default)]
pub struct Planned {
    /// The originating batch map, shared with its authoritative caller.
    pub map: Option<std::sync::Arc<crate::ground::Versions>>,
    /// Each walk given an answer: its order, then its place and legs, or a refusal's name.
    pub places: BTreeMap<Id, (Id, Placed)>,
    /// Each walker's line (#3167's, found by the planning call `View::search`) toward the leg's end it asked for, or
    /// the search's refusal.
    pub lines: Found,
    /// Straight distances, µm, for exactly the body, fixture, slot and move order asked.
    pub reach: BTreeMap<ReachKey, [i64; 2]>,
    /// Route searches run for these answers (legs and lines).
    pub searched: u64,
    pub forms: BTreeMap<crate::planner::FormKey, crate::planner::FormAnswer>,
}

impl Planned {
    /// Discards answers from an obsolete map before they can enter a current cache. Searches remain counted.
    pub fn keep_map(&mut self, current: &std::sync::Arc<crate::ground::Versions>) {
        if self
            .map
            .as_ref()
            .is_none_or(|map| !std::sync::Arc::ptr_eq(map, current))
        {
            self.places.clear();
            self.lines.clear();
            self.reach.clear();
            self.forms.clear();
            self.map = None;
        }
    }

    /// Takes `later`'s answers over these. A different map cannot retain answers from its predecessor.
    pub fn merge(&mut self, later: Planned) {
        // Unstamped legacy answers cannot acquire a stamped cache's current identity.
        if self.map.is_some() && later.map.is_none() {
            self.searched += later.searched;
            return;
        }
        if let Some(map) = &later.map {
            self.keep_map(map);
            self.map = Some(std::sync::Arc::clone(map));
        }
        self.places.extend(later.places);
        self.lines.extend(later.lines);
        self.reach.extend(later.reach);
        for (key, answer) in later.forms {
            if self
                .forms
                .get(&key)
                .is_none_or(|old| old.generation <= answer.generation)
            {
                self.forms.insert(key, answer);
            }
        }
        self.searched += later.searched;
    }
}

/// The world a tick's skills ask: the town's answers and the runner's bodies.
struct Here<'a> {
    town: View<'a>,
    controller: &'a Controller,
    fields: &'a BTreeMap<Id, BTreeMap<u64, Value>>,
    settled: &'a BTreeSet<Id>,
    /// A body's kind, named once a tick, not at each read (#3213).
    kind: Name,
    /// With a planner (K18b): its lines of the last tick, and the lines asked for in this one. Without, the town
    /// searches the route itself.
    planned: Option<(&'a Planned, Asked)>,
}

impl Here<'_> {
    /// Where `me` aims next on its way to `to`, x and z µm.
    fn toward(&self, me: &Moved, to: Vec3) -> Result<[i64; 2], Refusal> {
        match &self.planned {
            None => self.town.corner(me, to),
            Some((planned, asked)) => self.town.corner_planned(
                me,
                to,
                &Plans {
                    found: &planned.lines,
                    asked,
                },
            ),
        }
    }
}

impl Geometry for Here<'_> {
    fn ask(&self, body: Id, q: &Ask) -> Option<Answer> {
        let me = self.controller.body(body)?;
        match q {
            Ask::Distance { .. } => None,
            Ask::Toward { to, .. } => self.toward(me, *to).ok().map(|[x, z]| {
                Answer::Point(Vec3::new(
                    x,
                    if [x, z] == [to.x, to.z] { to.y } else { 0 },
                    z,
                ))
            }),
            Ask::Near { radius } => Some(Answer::Near(near(self.controller, body, *radius))),
        }
    }

    fn read(&self, node: Id) -> Option<Seen> {
        let Some((b, carrying)) = self.controller.seen(node) else {
            return self.town.read_link(node);
        };
        let mut fields = self.fields.get(&node).cloned().unwrap_or_default();
        if let Some(l) = carrying {
            fields.insert(F_CROSSING, l.to_value());
        }
        if self.settled.contains(&node) {
            fields.insert(F_SETTLED, Value::Uint(1));
        }
        Some(Seen {
            id: node,
            kind: self.kind.clone(),
            parent: Some(node_of(b)),
            position: b.pose.position,
            fields,
        })
    }

    /// As [`Here::read`] shows it, without copying the body's other fields: each walker reads the waiting mark of
    /// every body near it each tick.
    fn field(&self, node: Id, field: u64) -> Option<Option<Value>> {
        let Some((_, carrying)) = self.controller.seen(node) else {
            return self
                .town
                .read_link(node)
                .map(|mut s| s.fields.remove(&field));
        };
        Some(match carrying {
            Some(l) if field == F_CROSSING => Some(l.to_value()),
            _ if field == F_SETTLED && self.settled.contains(&node) => Some(Value::Uint(1)),
            _ => self.fields.get(&node).and_then(|f| f.get(&field)).cloned(),
        })
    }

    fn position(&self, node: Id) -> Option<Vec3> {
        match self.controller.seen(node) {
            Some((b, _)) => Some(b.pose.position),
            None => self.town.read_link(node).map(|s| s.position),
        }
    }
}

/// The other bodies not carried across a link, on `body`'s node within `radius` of it (x and z), in id order, as
/// the controller's index holds them: where the mover left them at the end of the last tick (N16).
fn near(controller: &Controller, body: Id, radius: i64) -> Vec<Near> {
    let Some(me) = controller.body(body) else {
        return Vec::new();
    };
    let (node, p) = crate::index::place_of(me);
    let found = controller.near().bodies_within(node, p, radius);
    // Sized once: in a crowd each walker has many near it, every tick.
    let mut out = Vec::with_capacity(found.len());
    for (id, _) in found {
        if id == body {
            continue;
        }
        if let Some(b) = controller.body(id) {
            out.push(Near {
                id: b.id,
                position: b.pose.position,
                velocity: b.linear,
            });
        }
    }
    out
}

impl Runner {
    /// No bodies yet; ticks of `tick` µs.
    pub fn new(tick: Micros) -> Runner {
        Runner {
            controller: Controller::new(),
            fields: BTreeMap::new(),
            runs: Vec::new(),
            staying: BTreeSet::new(),
            tick,
            now: 0,
            ended: BTreeMap::new(),
            asks: BTreeMap::new(),
            granted: BTreeMap::new(),
            route_metrics: BTreeMap::new(),
            refused: Vec::new(),
            said: Vec::new(),
            off_ground: BTreeSet::new(),
            stood: BTreeMap::new(),
            grounded: None,
            routes: BTreeMap::new(),
            seed: 1,
            minter: Minter::new(Scope([0x9b; 16])),
            units: Units::new(),
            threads: 1,
            chunk: CHUNK,
        }
    }

    /// Adds a body of `family`, standing as the mover placed it, with no skill.
    pub fn add_body(&mut self, family: Family, body: Moved) -> Result<(), Refusal> {
        self.controller.add(family, body)
    }

    /// Forgets the routes given to a body taken out of the controller (a retirement, K10 #2673); the controller's
    /// spatial index drops it as it is taken out.
    pub fn forget(&mut self, body: Id) {
        self.routes.remove(&body);
        self.route_metrics.remove(&body);
    }

    /// Adds a body of `family`, standing as the mover placed it, and runs `skill` on it.
    pub fn add(
        &mut self,
        family: Family,
        body: Moved,
        skill: Box<dyn Skill>,
    ) -> Result<(), Refusal> {
        let who = body.id;
        self.add_body(family, body)?;
        self.start(who, skill)
    }

    /// Runs `skill` on `body`, under a new driver claiming what the skill's shape claims. The marks a run before it
    /// left on the body go (#3168): a route the world gave it (`F_ROUTE`; a new walk would take it for its own and
    /// walk the old route's legs from wherever it stands now), its waiting mark and the shoulder turn.
    pub fn start(&mut self, body: Id, skill: Box<dyn Skill>) -> Result<(), Refusal> {
        let driver = self.controller.claim(body, &skill.shape())?;
        if let Some(f) = self.fields.get_mut(&body) {
            f.remove(&F_ROUTE);
            f.remove(&F_WAITING);
            f.remove(&F_SHOULDER);
        }
        self.ended.remove(&body);
        self.asks.remove(&body);
        self.granted.remove(&body);
        self.route_metrics.remove(&body);
        self.runs.push(Run {
            body,
            driver,
            skill,
        });
        Ok(())
    }

    /// Runs `skill` on `body`, sent to `target` for the order `order` (N9): it asks a standing spot near the point,
    /// and once one is granted the world gives it the route there ([`Runner::route`]), or ends it by the refusal's
    /// name. An ask it made before is left.
    pub fn send(
        &mut self,
        body: Id,
        skill: Box<dyn Skill>,
        target: Target,
        order: Id,
    ) -> Result<(), Refusal> {
        if let Some(k) = self.runs.iter().position(|r| r.body == body) {
            let r = self.runs.remove(k);
            let _ = self.controller.release(body, r.driver);
        }
        self.start(body, skill)?;
        self.asks.insert(body, (target, order));
        self.granted.remove(&body);
        self.route_metrics.remove(&body);
        Ok(())
    }

    /// The world gives `body`'s walk a route (`F_ROUTE`), walked from its first leg.
    pub fn route(&mut self, body: Id, legs: &[Leg]) {
        let n = self.routes.entry(body).or_default();
        *n += 1;
        let v = route_value(*n, legs);
        self.fields.entry(body).or_default().insert(F_ROUTE, v);
    }

    /// Metrics from the existing plan for this exact active order. A late plan or a previous run never supplies a
    /// new act's deadline; no route or geometry search is performed by this accessor.
    pub fn route_metrics(&self, body: Id, order: Id) -> Option<crate::walk::town::RouteMetrics> {
        let (current, metrics) = self.route_metrics.get(&body)?;
        (*current == order
            && self.asks.get(&body).is_some_and(|(_, o)| *o == order)
            && self.running(body))
        .then_some(*metrics)
    }

    /// Whether `body` stands on the standing spot it was granted: its walk there arrived, and it still holds it.
    pub fn settled(&self, body: Id) -> bool {
        self.granted.contains_key(&body)
            && matches!(self.ended.get(&body), Some((_, Progress::Done)))
    }

    /// Whether a skill runs on `body`.
    pub fn running(&self, body: Id) -> bool {
        self.runs.iter().any(|r| r.body == body)
    }

    /// The bodies a skill runs on: [`Runner::running`] for many bodies at once, without a scan of the runs each.
    pub fn running_bodies(&self) -> BTreeSet<Id> {
        self.runs.iter().map(|r| r.body).collect()
    }

    /// The world ends `body`'s run by `name` (N10's last rung): its driver ends, and its walk's marks go.
    pub fn end(&mut self, body: Id, name: Name) {
        let Some(k) = self.runs.iter().position(|r| r.body == body) else {
            return;
        };
        let r = self.runs.remove(k);
        let _ = self.controller.release(body, r.driver);
        if let Some(f) = self.fields.get_mut(&body) {
            f.remove(&F_WAITING);
            f.remove(&F_SHOULDER);
        }
        self.asks.remove(&body);
        self.granted.remove(&body);
        self.route_metrics.remove(&body);
        self.ended.insert(body, (self.now, Progress::Failed(name)));
    }

    /// The world ends `body`'s order: its run, if any, and its ask (N9: the spot is released at the next tick).
    pub fn end_order(&mut self, body: Id) {
        if let Some(k) = self.runs.iter().position(|r| r.body == body) {
            let r = self.runs.remove(k);
            let _ = self.controller.release(body, r.driver);
        }
        self.asks.remove(&body);
        self.granted.remove(&body);
        self.route_metrics.remove(&body);
    }

    /// `body` stays where it is by its own order: its run, if any, ends unrecorded.
    pub fn stay(&mut self, body: Id) {
        if let Some(k) = self.runs.iter().position(|r| r.body == body) {
            let r = self.runs.remove(k);
            let _ = self.controller.release(body, r.driver);
        }
        self.route_metrics.remove(&body);
        self.staying.insert(body);
    }

    /// The other bodies not carried across a link, on `body`'s node within `radius` of it (x and z), in id order, as
    /// they stood at the end of the last tick.
    pub fn near(&self, body: Id, radius: i64) -> Vec<Near> {
        near(&self.controller, body, radius)
    }

    /// The paired edit already rebound these exact bodies off-clock; ordinary reground remains for other callers.
    pub fn prepared_ground(
        &mut self,
        bodies: &[(crate::controller::BuildBasis, Moved)],
        town: &Town,
    ) {
        for (before, _) in bodies {
            let node = before.moved.pose.frame.node;
            self.stood
                .insert(before.moved.id, (node, town.versions.of(node)));
        }
    }

    /// Changed ground (G3), at the start of a tick (once a tick): each body not carried whose node's ground version
    /// moved since it last stood (or that stood off the ground) is found again on that ground where it stands
    /// ([`Town::relocate`]), or marked off the ground and held. Nothing while no ground has changed.
    pub fn reground(&mut self, town: &Town) {
        if town.versions.is_empty() || self.grounded == Some(self.now) {
            return;
        }
        self.grounded = Some(self.now);
        let ids: Vec<Id> = self.controller.bodies().map(|b| b.id).collect();
        for who in ids {
            let Some(b) = self.controller.body(who).copied() else {
                continue;
            };
            let n = node_of(&b);
            let now = (n, town.versions.of(n));
            let off = self.off_ground.contains(&who);
            if self.controller.carried(who) || (self.stood.get(&who) == Some(&now) && !off) {
                continue;
            }
            match town.relocate(&b) {
                Ok(placed) if self.controller.regrounded(who, Some(placed)).is_ok() => {
                    if self.off_ground.remove(&who)
                        && let Some(f) = self.fields.get_mut(&who)
                    {
                        f.remove(&F_HELD);
                    }
                }
                _ => {
                    let _ = self.controller.regrounded(who, None);
                    if !off && self.running(who) {
                        self.fields
                            .entry(who)
                            .or_default()
                            .insert(F_HELD, Value::Uint(1));
                    }
                    self.off_ground.insert(who);
                }
            }
            self.stood.insert(who, now);
        }
    }

    /// One tick over `town`: the marks read for the turns, every skill stepped against the bodies as they stood at
    /// the tick's start, inputs and crossings handed on, the skills' entries set on their bodies, and the controller
    /// stepped.
    ///
    /// A refusal of one body mid-tick (its input, its crossing's track, the carry or its landing, its step on the
    /// surface) is that body's fault alone (#3275): it is kept in [`Runner::refused`], and the body's run ends by the
    /// refusal's name ([`Runner::end`]), so it does not ask again into the same refusal; every other body's tick is
    /// as it would be without it, and the tick returns `Ok`. A refusal of the world's own (the turns' or the spot
    /// tables' write) does not stop the tick either: the tick goes on to its end and returns it.
    pub fn tick(&mut self, town: &mut Town) -> Result<(), Refusal> {
        self.run(town, None).1
    }

    /// One tick over `town` with a planner (K18b, #3175): as [`Runner::tick`], but the clock runs no route search.
    /// The spot tables, a granted walk's legs and each walker's line come from `planned`, the planner's answers to
    /// the last tick's [`Wants`]; this tick's wants are returned, for the planner to answer before the next. A walk
    /// gets its place and legs a tick after it asks, and stands a tick at the start of each leg whose straight way
    /// is not clear, while its line is found.
    pub fn tick_planned(
        &mut self,
        town: &mut Town,
        planned: &Planned,
    ) -> (Wants, Result<(), Refusal>) {
        self.run(town, Some(planned))
    }

    fn run(&mut self, town: &mut Town, planned: Option<&Planned>) -> (Wants, Result<(), Refusal>) {
        let mut wants = Wants::default();
        let r = self.run_in(town, planned, &mut wants);
        (wants, r)
    }

    fn run_in(
        &mut self,
        town: &mut Town,
        planned: Option<&Planned>,
        wants: &mut Wants,
    ) -> Result<(), Refusal> {
        town.body_classes = self
            .controller
            .ids()
            .filter_map(|id| {
                let size = self.controller.build(id)?.size;
                (size != replica::kinds::sizes::Size::Standard).then_some((id, size))
            })
            .collect();
        wants.classes.clone_from(&town.body_classes);
        self.reground(town);
        let at = self.now + self.tick;
        // Read on the runner's threads (N17b): each mark reads one body alone.
        let bodies: Vec<&Moved> = self.controller.bodies().collect();
        let marks: Vec<Mark> = crate::par::map(&bodies, self.threads, CHUNK * 4, |b| Mark {
            who: b.id,
            node: node_of(b),
            at: b.pose.position,
            waiting: waiting(self.fields.get(&b.id)),
            crossing: self.controller.carrying(b.id),
            staying: self.staying.contains(&b.id),
            // An ask stands while its order lasts and the body is not held (walked out by the world).
            spot: self
                .asks
                .get(&b.id)
                .filter(|_| {
                    !self
                        .fields
                        .get(&b.id)
                        .is_some_and(|f| f.contains_key(&F_HELD))
                })
                .copied(),
        });
        drop(bodies);
        // The world's own refusals: the tick goes on, and the first is returned at its end. With a planner the spot
        // tables are its own (K18b).
        let world = town.turns(&marks, at).err();
        let world = match planned {
            None => world.or(town.spots(&marks, at).err()),
            Some(_) => world,
        };
        // A walk sent to a point gets its route once its place is granted; a refusal ends it by name.
        let running = self.running_bodies();
        let waiting: Vec<(Id, Target, Id)> = self
            .asks
            .iter()
            .filter(|(who, _)| running.contains(*who) && !self.granted.contains_key(who))
            .map(|(who, (t, o))| (*who, *t, *o))
            .collect();
        for (who, target, order) in waiting {
            let Some(body) = self.controller.body(who).copied() else {
                continue;
            };
            if let Some(planned) = planned {
                // The planner's answer to the last tick's ask, for this order; else asked again.
                match planned.places.get(&who) {
                    Some((o, Ok((p, legs, metrics)))) if *o == order => {
                        self.route_metrics.insert(who, (order, *metrics));
                        self.granted.insert(who, *p);
                        self.route(who, legs);
                    }
                    Some((o, Err(name))) if *o == order => self.end(who, named(name)),
                    _ => wants.places.push((body, target, order)),
                }
                continue;
            }
            match town.spot(who, &target) {
                Some(Ok(p)) => match town.plan_with_metrics(&body, target.node, p) {
                    Ok((legs, metrics)) => {
                        self.route_metrics.insert(who, (order, metrics));
                        self.granted.insert(who, p);
                        self.route(who, &legs);
                    }
                    Err(e) => self.end(who, named(e.name)),
                },
                Some(Err(name)) => self.end(who, named(name)),
                None => {}
            }
        }
        let settled: BTreeSet<Id> = self
            .granted
            .keys()
            .copied()
            .filter(|b| self.settled(*b))
            .collect();
        let drivers: BTreeMap<Id, Driver> = self.runs.iter().map(|r| (r.body, r.driver)).collect();
        // Each skill's step is a unit in K11's wrapper (K18 #3160): one that panics ends its own run by name.
        let staged = beside::step(
            town.split(self.threads),
            beside::Reads {
                controller: &self.controller,
                fields: &self.fields,
                settled: &settled,
                now: self.now,
                seed: self.seed,
                planned,
            },
            &mut self.minter,
            &mut self.runs,
            self.chunk,
            &mut self.units,
            &mut wants.lines,
        );
        if planned.is_some() {
            wants.at = at;
            wants.marks = Some(marks);
        }
        let mut refused = hand_on_threads(&staged, &mut self.controller, self.threads);
        // Those waiting at a narrow place stand in its queue; its owner's turns keep its far end clear (N8). A body
        // staying by its own order is passed (N10).
        let mut queued: BTreeSet<Id> = self
            .fields
            .iter()
            .filter(|(_, f)| crate::host::waiting(Some(f)).is_some())
            .map(|(id, _)| *id)
            .collect();
        queued.extend(&self.staying);
        refused.extend(carry_past(&staged, &mut self.controller, town, at, &queued));
        // The tick's end: each skill's own entries set its body's fields.
        for e in &staged.emits {
            for c in &e.changes {
                if let Change::Set {
                    node, field, to, ..
                } = c
                {
                    self.fields
                        .entry(*node)
                        .or_default()
                        .insert(*field, to.clone());
                }
            }
        }
        for (who, p) in &staged.ended {
            if let Some(&d) = drivers.get(who) {
                let _ = self.controller.release(*who, d);
            }
            self.route_metrics.remove(who);
            self.ended.insert(*who, (self.now, p.clone()));
        }
        let surfaces = replica::kinds::sizes::Size::ALL.map(|size| town.surfaces_for(size));
        let stepped = self.controller.step_on_selected(
            move |_, size| {
                surfaces[match size {
                    replica::kinds::sizes::Size::Small => 0,
                    replica::kinds::sizes::Size::Standard => 1,
                    replica::kinds::sizes::Size::Large => 2,
                    replica::kinds::sizes::Size::Giant => 3,
                }]
            },
            self.tick,
            at,
            self.threads,
        );
        refused.extend(stepped.refused);
        // Each refused body's run ends by its first refusal's name; the others' ticks are done already.
        for (who, r) in &refused {
            if self.running(*who) {
                self.end(*who, named(r.name));
            }
        }
        self.now = at;
        self.refused = refused;
        self.said = stepped.said;
        match world {
            Some(r) => Err(r),
            None => Ok(()),
        }
    }
}
