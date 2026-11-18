//! The world's side of the host interface (Engine v2 K13a, #2676; contract T9, `v2/docs/bodies.md` rules 7 to 9).
//! Skills touch the world only through `replica::host::Host`; this module is the one place `sim` implements it, and
//! the one place a skill's controller inputs are handed on (to the controller, B1 #2680).
//!
//! - **One phase a tick.** [`step`] steps every running skill once, in its body's id order, against the tree as it
//!   stood at the tick's start: the tree is borrowed read-only for the whole phase, so nothing a skill does can change
//!   what another reads in the same tick (T1).
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
//!   near (a grid of the bodies as of the tick's start, in cells of [`CELL`]), and reads of bodies and links.
//!
//! Not here: handing intents back after a restart (K13b #3119), entries to the log, timers (K9).

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

use replica::bodies::Family;
use replica::effects::{Change, Event, Refusal, read_id};
use replica::encode::{Name, Value};
use replica::host::{
    Answer, Ask, F_CROSSING, F_HELD, F_ROUTE, F_SETTLED, F_SHOULDER, F_WAITING, Host, Near,
    Progress, Seen, Skill,
};
use replica::ids::{Id, Minter, Scope};
use replica::pose::{ControllerInput, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::End;

use crate::controller::{Controller, Driver, Part, Track};
use crate::mover::Body as Moved;
use crate::spots::Target;
use crate::walk::town::{Town, View};
use crate::walk::{Leg, Mark, World, node_of};

/// The N lane's answers to T9's closed list of geometry questions, asked for `body`.
pub trait Geometry {
    fn ask(&self, body: Id, q: &Ask) -> Option<Answer>;
    /// A node the world holds outside the tree for now (a body's pose in the controller, a link's turn state, T9b
    /// A3), as of the tick's start; `None` reads the tree.
    fn read(&self, _node: Id) -> Option<Seen> {
        None
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
    minter: &'a mut Minter,
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

    fn ask(&self, q: &Ask) -> Option<Answer> {
        self.count();
        self.geometry.ask(self.body, q)
    }

    fn set_timer(&mut self, after: Micros, name: Name) -> Id {
        self.count();
        // A scope's 2^64 counters cannot run out in a world's life; if they did, the timer is named by its body.
        let id = self.minter.mint().unwrap_or(self.body);
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
    let mut staged = Staged::default();
    runs.sort_by_key(|r| r.body);
    runs.retain_mut(|r| {
        let mut host = WorldHost {
            tree,
            geometry,
            now,
            seed,
            body: r.body,
            driver: r.driver,
            minter: &mut *minter,
            staged: &mut staged,
            calls: Cell::new(0),
        };
        let progress = r.skill.step(&mut host);
        let calls = host.calls.get();
        staged.calls += calls;
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

/// Hands a tick's staged controller inputs to the controller, each under its run's driver: the one place a skill's
/// inputs go on (B1 #2680). An input whose driver does not hold the body's locomotion is refused by the controller and
/// changes nothing; the refusals are returned with their bodies.
pub fn hand_on(staged: &Staged, controller: &mut Controller) -> Vec<(Id, Refusal)> {
    let mut refused = Vec::new();
    for &(body, driver, input) in &staged.controls {
        if let Err(r) = controller.set(body, driver, Part::Velocity(input.velocity, input.mode)) {
            refused.push((body, r));
        }
    }
    refused
}

/// Hands a tick's staged crossings on: for each, the world's [`Links`] gives the track (or opens a shut door, and the
/// body stands), and the controller carries the body along it under the run's driver. Refusals are returned with
/// their bodies; a refused crossing changes nothing.
pub fn carry(
    staged: &Staged,
    controller: &mut Controller,
    links: &mut impl Links,
    at: Micros,
) -> Vec<(Id, Refusal)> {
    let mut refused = Vec::new();
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
            Ok(Some(t)) => controller.cross(body, driver, t),
            Ok(None) => controller.set(
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

/// The cell of the runner's grid of bodies, µm: the walk's push range (`skills::route::RANGE`).
pub const CELL: i64 = 1_200_000;

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
    /// The routes the world gave each body (`F_ROUTE`), counted.
    routes: BTreeMap<Id, u64>,
    seed: u64,
    minter: Minter,
    /// The bodies not carried across a link, by node and cell of [`CELL`], as of the end of the last tick.
    grid: BTreeMap<(Id, i64, i64), Vec<Near>>,
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

fn key(node: Id, x: i64, z: i64) -> (Id, i64, i64) {
    (node, x.div_euclid(CELL), z.div_euclid(CELL))
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

/// The world a tick's skills ask: the town's answers and the runner's bodies.
struct Here<'a> {
    town: View<'a>,
    controller: &'a Controller,
    fields: &'a BTreeMap<Id, BTreeMap<u64, Value>>,
    grid: &'a BTreeMap<(Id, i64, i64), Vec<Near>>,
    settled: BTreeSet<Id>,
}

impl Geometry for Here<'_> {
    fn ask(&self, body: Id, q: &Ask) -> Option<Answer> {
        let me = self.controller.body(body)?;
        match q {
            Ask::Distance { .. } => None,
            Ask::Toward { to, .. } => self.town.corner(me, *to).ok().map(|[x, z]| {
                Answer::Point(Vec3::new(
                    x,
                    if [x, z] == [to.x, to.z] { to.y } else { 0 },
                    z,
                ))
            }),
            Ask::Near { radius } => Some(Answer::Near(near(
                self.grid,
                body,
                node_of(me),
                me.pose.position,
                *radius,
            ))),
        }
    }

    fn read(&self, node: Id) -> Option<Seen> {
        let Some(b) = self.controller.body(node) else {
            return self.town.read_link(node);
        };
        let mut fields = self.fields.get(&node).cloned().unwrap_or_default();
        if let Some(l) = self.controller.carrying(node) {
            fields.insert(F_CROSSING, l.to_value());
        }
        if self.settled.contains(&node) {
            fields.insert(F_SETTLED, Value::Uint(1));
        }
        Some(Seen {
            id: node,
            kind: body_kind(),
            parent: Some(node_of(b)),
            position: b.pose.position,
            fields,
        })
    }
}

/// The bodies in `grid` other than `body` on `node` within `radius` of `at` (x and z), in id order.
fn near(
    grid: &BTreeMap<(Id, i64, i64), Vec<Near>>,
    body: Id,
    node: Id,
    at: Vec3,
    radius: i64,
) -> Vec<Near> {
    let (_, i, j) = key(node, at.x, at.z);
    let k = (radius.max(0) + CELL - 1) / CELL;
    let r = i128::from(radius);
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    let mut out = Vec::new();
    for di in -k..=k {
        for dj in -k..=k {
            for n in grid.get(&(node, i + di, j + dj)).into_iter().flatten() {
                if n.id != body && d(at.x, n.position.x) + d(at.z, n.position.z) < r * r {
                    out.push(*n);
                }
            }
        }
    }
    out.sort_by_key(|n| n.id);
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
            routes: BTreeMap::new(),
            seed: 1,
            minter: Minter::new(Scope([0x9b; 16])),
            grid: BTreeMap::new(),
        }
    }

    /// Adds a body of `family`, standing as the mover placed it, with no skill.
    pub fn add_body(&mut self, family: Family, body: Moved) -> Result<(), Refusal> {
        self.controller.add(family, body)?;
        self.index();
        Ok(())
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

    /// Runs `skill` on `body`, under a new driver claiming what the skill's shape claims.
    pub fn start(&mut self, body: Id, skill: Box<dyn Skill>) -> Result<(), Refusal> {
        let driver = self.controller.claim(body, &skill.shape())?;
        self.ended.remove(&body);
        self.asks.remove(&body);
        self.granted.remove(&body);
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
        Ok(())
    }

    /// The world gives `body`'s walk a route (`F_ROUTE`), walked from its first leg.
    pub fn route(&mut self, body: Id, legs: &[Leg]) {
        let n = self.routes.entry(body).or_default();
        *n += 1;
        let v = route_value(*n, legs);
        self.fields.entry(body).or_default().insert(F_ROUTE, v);
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
    }

    /// `body` stays where it is by its own order: its run, if any, ends unrecorded.
    pub fn stay(&mut self, body: Id) {
        if let Some(k) = self.runs.iter().position(|r| r.body == body) {
            let r = self.runs.remove(k);
            let _ = self.controller.release(body, r.driver);
        }
        self.staying.insert(body);
    }

    /// The other bodies not carried across a link, on `body`'s node within `radius` of it (x and z), in id order, as
    /// they stood at the end of the last tick.
    pub fn near(&self, body: Id, radius: i64) -> Vec<Near> {
        let Some(b) = self.controller.body(body) else {
            return Vec::new();
        };
        near(&self.grid, body, node_of(b), b.pose.position, radius)
    }

    fn index(&mut self) {
        self.grid.clear();
        for b in self.controller.bodies() {
            if self.controller.carrying(b.id).is_some() {
                continue;
            }
            let p = b.pose.position;
            self.grid
                .entry(key(node_of(b), p.x, p.z))
                .or_default()
                .push(Near {
                    id: b.id,
                    position: p,
                    velocity: b.linear,
                });
        }
    }

    /// One tick over `town`: the marks read for the turns, every skill stepped against the bodies as they stood at
    /// the tick's start, inputs and crossings handed on, the skills' entries set on their bodies, and the controller
    /// stepped. The first refusal is returned once the tick is done; the others went on.
    pub fn tick(&mut self, town: &mut Town) -> Result<(), Refusal> {
        let at = self.now + self.tick;
        let marks: Vec<Mark> = self
            .controller
            .bodies()
            .map(|b| Mark {
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
            })
            .collect();
        town.turns(&marks, at)?;
        town.spots(&marks, at)?;
        // A walk sent to a point gets its route once its place is granted; a refusal ends it by name.
        let waiting: Vec<(Id, Target)> = self
            .asks
            .iter()
            .filter(|(who, _)| self.running(**who) && !self.granted.contains_key(who))
            .map(|(who, (t, _))| (*who, *t))
            .collect();
        for (who, target) in waiting {
            let Some(body) = self.controller.body(who).copied() else {
                continue;
            };
            match town.spot(who, &target) {
                Some(Ok(p)) => match town.plan(&body, target.node, p) {
                    Ok(legs) => {
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
        let staged = {
            let view = town.view();
            let tree = view.tree;
            let here = Here {
                town: view,
                controller: &self.controller,
                fields: &self.fields,
                grid: &self.grid,
                settled,
            };
            step(
                tree,
                &here,
                self.now,
                self.seed,
                &mut self.minter,
                &mut self.runs,
            )
        };
        let mut refused = hand_on(&staged, &mut self.controller);
        refused.extend(carry(&staged, &mut self.controller, town, at));
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
            self.ended.insert(*who, (self.now, p.clone()));
        }
        let stepped = self.controller.step(&town.surfaces, self.tick, at);
        refused.extend(stepped.refused);
        self.now = at;
        self.index();
        match refused.into_iter().next() {
            Some((_, r)) => Err(r),
            None => Ok(()),
        }
    }
}
