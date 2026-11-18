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
//! Not here: retiring N7's `Crowd` (T9c), handing intents back after a restart (K13b #3119), applying the staged
//! entries (the tick loop).

use std::cell::Cell;
use std::collections::BTreeSet;

use replica::effects::{Change, Event, Refusal};
use replica::encode::Name;
use replica::host::{Answer, Ask, Host, Progress, Seen, Skill};
use replica::ids::{Id, Minter};
use replica::pose::{ControllerInput, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::End;

use crate::controller::{Controller, Driver, Part, Track};
use crate::mover::Body as Moved;

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
