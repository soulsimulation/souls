//! The world's side of walking (Engine v2 N7 #2655, N8 #2656): the routes it plans for a walk, and the turns it keeps
//! at narrow places. The walk itself is a skill (`skills::route`, T9b #3120), run through the host
//! (`crate::host::Runner`, T9c #3127); its velocity and its crossings go through the controller. Nothing here moves a
//! body.
//!
//! - **Legs.** A walk is planned as legs: walk to a point, then cross a link, or arrive ([`World::plan`]).
//! - **Turns at a narrow place** (N8, `crate::links::turns`). At the start of each tick the world reads every body's
//!   mark as of the last tick ([`Mark`], [`World::turns`]): the link it waits for and how far from its near end (its
//!   own field, `replica::host::F_WAITING`), the link it is carried across, and whether it stays where it is by its
//!   own order. The owner of each link taken in turns writes who may enter, and the walk reads it on the link.
//! - **One trait.** What the world answers for walking goes through [`World`]; [`town::Town`] is it over N5's map,
//!   N6's surfaces and N4's links, doors and turns.
//! - **Integers.** Positions in µm, time in µs.

pub mod town;

use crate::mover::Body;
use replica::effects::Refusal;
use replica::ids::Id;
use replica::pose::{Support, Vec3};
use replica::time::Micros;

/// One body as the world reads it at the start of a tick (as it stood at the end of the last): where it is, the
/// link it waits for and how far from that link's near end (µm), the link it is crossing, and whether it stays
/// where it is by its own order.
#[derive(Clone, Copy, Debug)]
pub struct Mark {
    pub who: Id,
    pub node: Id,
    pub at: Vec3,
    pub waiting: Option<(Id, i64)>,
    pub crossing: Option<Id>,
    pub staying: bool,
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
}

/// The node a body stands on.
pub fn node_of(b: &Body) -> Id {
    match b.pose.support {
        Support::Surface { surface, .. } => surface,
        _ => b.pose.frame.node,
    }
}
