//! The world's side of walking (Engine v2 N7 #2655, N8 #2656, N9 #2678): the routes it plans for a walk, the turns it
//! keeps at narrow places and the standing spots it grants. The walk itself is a skill (`skills::route`, T9b #3120),
//! run through the host (`crate::host::Runner`, T9c #3127); its velocity and its crossings go through the controller.
//! Nothing here moves a body.
//!
//! - **Legs.** A walk is planned as legs: walk to a point, then cross a link, or arrive ([`World::plan`]).
//! - **Turns at a narrow place** (N8, `crate::links::turns`). At the start of each tick the world reads every body's
//!   mark as of the last tick ([`Mark`], [`World::turns`]): the link it waits for and how far from its near end (its
//!   own field, `replica::host::F_WAITING`), the link it is carried across, and whether it stays where it is by its
//!   own order. The owner of each link taken in turns writes who may enter, and the walk reads it on the link.
//! - **Standing spots** (N9, `crate::spots`). A walker sent to a point marks what it asks while its walk runs; at the
//!   start of each tick the world's spot tables read the marks of the last tick ([`World::spots`]) and grant each
//!   asker its own place near the point ([`World::spot`]). When it no longer asks (its walk ended) the place is
//!   released.
//! - **One trait.** What the world answers for walking goes through [`World`]; [`town::Town`] is it over N5's map,
//!   N6's surfaces and N4's links, doors, turns and spot tables.
//! - **Changed ground** (G3, #2760). An edit's ground is rebuilt off the clock thread and installed on the tick it
//!   commits ([`town::Town::rebuild`], [`town::Town::install`]); each plan records the ground it crossed with its
//!   versions. The runner finds its bodies again on the new ground (`crate::host::Runner::reground`) and the ladder
//!   plans the stale walks again (`crate::unstick`); the walk skill takes the new route as any other (`F_ROUTE`).
//! - **A form's walk that stalls** (C21, #3484, [`stall`]): one that gains less than a quarter metre toward its goal
//!   over 3 s ends `walk.blocked`, naming what blocks it.
//! - **Integers.** Positions in µm, time in µs.

pub mod stall;
pub mod town;

use crate::mover::Body;
use crate::spots::{Granted, Target};
use replica::effects::Refusal;
use replica::ids::Id;
use replica::pose::{Support, Vec3};
use replica::time::Micros;

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
    /// The world carries it: across `crossing`, or with no link (a rise's step off its seat, a climb out). Until the
    /// carry ends it may stand on no floor's ground (part way off a bench), so a standing spot it asks waits for that.
    pub carried: bool,
    pub staying: bool,
    pub spot: Option<(Target, Id)>,
}

/// One leg of a walk: walk to `to` (µm, in the frame of the node the body stands on), then cross `link`, or arrive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leg {
    pub to: Vec3,
    pub link: Option<Id>,
}

/// The world as walking reads it.
pub trait World {
    /// The legs from where `body` stands to `goal` (µm, the frame of node `node`), for a body with hands.
    fn plan(&mut self, body: &Body, node: Id, goal: Vec3) -> Result<Vec<Leg>, Refusal>;
    /// At the start of a tick ending at `at`: every body's mark as of the last tick, for the owners of the links
    /// taken in turns to write who may enter. A world with no such links needs nothing.
    fn turns(&mut self, _marks: &[Mark], _at: Micros) -> Result<(), Refusal> {
        Ok(())
    }
    /// At the start of a tick ending at `at`, after the turns: every body's mark as of the last tick, for the owners
    /// of the spot tables to grant and release standing spots (N9). A world without them grants none.
    fn spots(&mut self, _marks: &[Mark], _at: Micros) -> Result<(), Refusal> {
        Ok(())
    }
    /// What `who`, sent to `target`, was given: its place (the node it stands on, the point there, and whether it is
    /// an overflow point round a crowded target, A2-5) or a refusal's name; `None` until its ask is read.
    fn spot(&self, _who: Id, _target: &Target) -> Option<Result<Granted, &'static str>> {
        None
    }
    /// The walkers whose granted place a change of the ground took away since the last call (A2-5).
    fn revoked(&mut self) -> Vec<Id> {
        Vec::new()
    }
}

/// The node a body stands on.
pub fn node_of(b: &Body) -> Id {
    match b.pose.support {
        Support::Surface { surface, .. } => surface,
        _ => b.pose.frame.node,
    }
}
