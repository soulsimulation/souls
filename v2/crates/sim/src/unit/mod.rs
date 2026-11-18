//! Units (Engine v2 K11, #2674): a fault stays where it happened. A unit is one piece of code run for a body (a
//! skill step, a timer handler, an act's commit). It runs in one wrapper: it reads the world through a shared
//! reference and writes only to a stage, which the caller applies only if the unit returns. A panic drops the stage,
//! ends the unit by name and leaves its body idle; the clock, the other bodies and the world go on. A unit's third
//! failure retires it: it is refused (`unit-retired`) from then on.
//!
//! `catch_unwind` catches unwinding panics only (native builds unwind: `v2/Cargo.toml`). An abort, a stack overflow
//! or a failed allocation ends the process, and K7's supervisor restarts it; so does a panic outside a unit. Units
//! hold no lock, so none is poisoned.

use replica::ids::Id;
use std::collections::{BTreeMap, BTreeSet};
use std::panic::{AssertUnwindSafe, catch_unwind};

/// The failures after which a unit is retired.
pub const STRIKES: u8 = 3;

/// A unit ended by a failure: which, on which body, why, and what that did to the unit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub unit: String,
    pub body: Id,
    /// `unit-panicked`.
    pub reason: &'static str,
    /// The panic's message.
    pub message: String,
    /// The unit's failures so far, this one included.
    pub strikes: u8,
    /// This failure retired it.
    pub retired: bool,
}

/// What running a unit gave.
#[derive(Debug, PartialEq, Eq)]
pub enum Ran<T> {
    /// It returned: its staged writes, for the caller to apply.
    Done(Vec<T>),
    /// It panicked: its stage is dropped and it has ended.
    Failed(Ended),
    /// It was not run, by name (`unit-retired`).
    Refused(&'static str),
}

/// The units running on bodies, each unit's failures, and the units retired.
#[derive(Clone, Debug, Default)]
pub struct Units {
    running: BTreeMap<Id, String>,
    strikes: BTreeMap<String, u8>,
    retired: BTreeSet<String>,
    /// Every unit ended by a failure, in order.
    pub ended: Vec<Ended>,
}

impl Units {
    pub fn new() -> Units {
        Units::default()
    }

    /// Starts `unit` on `body` (a skill the body runs from tick to tick), in place of what it ran.
    pub fn start(&mut self, body: Id, unit: &str) -> Result<(), &'static str> {
        if self.retired.contains(unit) {
            return Err("unit-retired");
        }
        self.running.insert(body, unit.to_string());
        Ok(())
    }

    /// Ends what `body` runs, as done.
    pub fn stop(&mut self, body: Id) {
        self.running.remove(&body);
    }

    /// The unit `body` runs; none when it is idle.
    pub fn running(&self, body: Id) -> Option<&str> {
        self.running.get(&body).map(String::as_str)
    }

    pub fn is_retired(&self, unit: &str) -> bool {
        self.retired.contains(unit)
    }

    /// Runs `unit` for `body` once: `step` reads `world` and writes only to the stage. Its writes come back only if it
    /// returns. On a panic the stage is dropped, the unit ends by name, its body is idle, and the failure counts
    /// against it.
    pub fn run<W: ?Sized, T>(
        &mut self,
        unit: &str,
        body: Id,
        world: &W,
        step: impl FnOnce(&W, &mut Vec<T>),
    ) -> Ran<T> {
        if self.retired.contains(unit) {
            // A body still running a retired unit is idle from here.
            if self.running(body) == Some(unit) {
                self.running.remove(&body);
            }
            return Ran::Refused("unit-retired");
        }
        let mut stage = Vec::new();
        // The world is behind a shared reference and the stage is dropped on a panic, so nothing half-written can
        // be seen after one.
        match catch_unwind(AssertUnwindSafe(|| step(world, &mut stage))) {
            Ok(()) => Ran::Done(stage),
            Err(payload) => {
                drop(stage);
                let message = payload
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_default();
                let strikes = self.strikes.entry(unit.to_string()).or_insert(0);
                *strikes += 1;
                let strikes = *strikes;
                let retired = strikes >= STRIKES;
                if retired {
                    self.retired.insert(unit.to_string());
                }
                if self.running(body) == Some(unit) {
                    self.running.remove(&body);
                }
                let e = Ended {
                    unit: unit.to_string(),
                    body,
                    reason: "unit-panicked",
                    message,
                    strikes,
                    retired,
                };
                self.ended.push(e.clone());
                Ran::Failed(e)
            }
        }
    }
}
