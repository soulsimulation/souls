//! Running moves (Engine v2 B2, #2681): a move is data (`replica::moves::Move`), and the engine runs it on timers
//! alone. No code here names a move.
//!
//! - **A claim through the controller.** Starting a move is a driver on the body (B1's [`Controller::claim`]) with the
//!   move's own claims, blocks and cancels, so a refusal is T9's by name and nothing else moves the body. The move is
//!   set on each resource it holds ([`Part::Move`]), and ending it, however it ends, releases the driver: those parts
//!   go back to neutral.
//! - **Reach first.** Before any claim, the distance from the effector to the thing's contact point is asked of the
//!   geometry ([`Reach`]): one distance, no limbs solved. Beyond the move's reach it is refused `out-of-reach` with the
//!   distance and the reach, and nothing changes. At contact the distance is asked again; beyond reach then, the move
//!   is cancelled `out-of-reach`.
//! - **One timer per phase end**, in K9's due list, keyed by the move's instance. Nothing polls: a tick with moves in
//!   progress and none at a phase boundary costs the due list's one look at its first key.
//! - **Cancelled by a claim.** A later claim that takes the move's resources ends its driver (T9 rule 4). The move
//!   learns it when its next phase timer fires and ends as `claim-taken` then; [`Moves::cancel`] ends one at once.
//!
//! Not here: contact with a body (B6), seats (B3), holding (B4), the beat (B8), a move waiting for its resource.

use std::collections::BTreeMap;
use std::path::Path;

use replica::effects::{Refusal, fixture_bytes};
use replica::encode::{Name, decode};
use replica::ids::{Id, Minter};
use replica::moves::{Effector, Ended, Move, MoveRecord};
use replica::time::Micros;

use crate::controller::{Controller, Driver, Part};
use crate::timers::{DueList, Key, Timer};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn name(s: &'static str) -> Name {
    Name::new(s).unwrap_or_else(|| unreachable!("a literal name"))
}

/// The geometry's answer to the one question a move asks: the straight distance, µm, from `body`'s effector (`limb`
/// is the resource the move holds, for [`Effector::Held`] and [`Effector::HeldPoint`]) to the point named `point` of
/// the thing `target`, or none when either is unknown. The N lane answers it; the engine solves no limbs.
pub trait Reach {
    fn distance(
        &self,
        body: Id,
        effector: &Effector,
        limb: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64>;
}

/// A move's number, unique in [`Moves`].
pub type Instance = u64;

/// What a timer firing did to a move.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fired {
    /// Phase `phase` began; at phase 1 that instant is contact.
    Phase { instance: Instance, phase: usize },
    /// The last phase ended; the move released what it held. The record has `ended` set.
    Done(MoveRecord),
    /// The move was cancelled at this boundary (`claim-taken`, `out-of-reach`); it released what it held.
    Cancelled(MoveRecord),
}

struct Live {
    mv: Move,
    driver: Driver,
    phase: usize,
    timer: Key,
    record: MoveRecord,
}

/// Every move in progress, with the due list's timers that end their phases.
#[derive(Default)]
pub struct Moves {
    live: BTreeMap<Instance, Live>,
    by_timer: BTreeMap<Id, Instance>,
    last: Instance,
}

/// Reads every `.diag` move in `dir`, in file order: the engine's moves come from data.
pub fn load(dir: &Path) -> Result<Vec<Move>, String> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "diag"))
        .collect();
    files.sort();
    files
        .iter()
        .map(|f| {
            let at = |e: String| format!("{}: {e}", f.display());
            let text = std::fs::read_to_string(f).map_err(|e| at(e.to_string()))?;
            let bytes = fixture_bytes(&text).map_err(|r| at(r.to_string()))?;
            let v = decode(&bytes).map_err(|r| at(r.to_string()))?.value;
            Move::from_value(&v).map_err(|r| at(r.to_string()))
        })
        .collect()
}

fn timer_name() -> Name {
    name("souls:move-phase")
}

impl Moves {
    pub fn new() -> Moves {
        Moves::default()
    }

    /// Moves in progress.
    pub fn len(&self) -> usize {
        self.live.len()
    }

    pub fn is_empty(&self) -> bool {
        self.live.is_empty()
    }

    /// The record of move `instance` in progress.
    pub fn record(&self, instance: Instance) -> Option<&MoveRecord> {
        self.live.get(&instance).map(|l| &l.record)
    }

    /// Starts `mv` on `body` toward point `mv.contact` of `target` at `now`, all or none: the reach is asked first
    /// (`out-of-reach`, `reach-unknown`), then the claim is made through the controller (T9's refusals by name), the
    /// move set on each resource it holds, and its first phase's end set as a timer (`id-counter-exhausted`).
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &mut self,
        c: &mut Controller,
        due: &mut DueList,
        mint: &mut Minter,
        geo: &impl Reach,
        body: Id,
        mv: &Move,
        target: Id,
        now: Micros,
    ) -> R<Instance> {
        let shape = mv.shape();
        let Some(claims) = c.claims(body) else {
            return refuse("body-unknown", replica::world_model::show(body));
        };
        let holds = claims.plan(Driver::MAX, &shape)?.holds;
        let limb = holds.first();
        let Some(d) = geo.distance(body, &mv.effector, limb, target, &mv.contact) else {
            return refuse(
                "reach-unknown",
                format!(
                    "{}: {} of {}",
                    mv.name.as_str(),
                    mv.contact.as_str(),
                    replica::world_model::show(target)
                ),
            );
        };
        if d > mv.reach {
            return refuse(
                "out-of-reach",
                format!(
                    "{}: {d} µm to {} of {}, reach {} µm",
                    mv.name.as_str(),
                    mv.contact.as_str(),
                    replica::world_model::show(target),
                    mv.reach
                ),
            );
        }
        let id = mint.mint().map_err(|e| Refusal {
            name: "id-counter-exhausted",
            detail: e.to_string(),
        })?;
        let driver = c.claim(body, &shape)?;
        let record = MoveRecord::planned(mv, body, holds, target, now);
        let first = record.ends[0];
        let set = record
            .limbs
            .iter()
            .try_for_each(|r| c.set(body, driver, Part::Move(r.clone(), Some(mv.name.clone()))))
            .and_then(|()| {
                due.set(Timer {
                    node: body,
                    id,
                    due: first,
                    name: timer_name(),
                })
            });
        if let Err(r) = set {
            let _ = c.release(body, driver);
            return Err(r);
        }
        self.last += 1;
        let n = self.last;
        self.by_timer.insert(id, n);
        self.live.insert(
            n,
            Live {
                mv: mv.clone(),
                driver,
                phase: 0,
                timer: (first, id),
                record,
            },
        );
        Ok(n)
    }

    fn end(
        &mut self,
        c: &mut Controller,
        n: Instance,
        at: Micros,
        how: Name,
    ) -> Option<MoveRecord> {
        let mut l = self.live.remove(&n)?;
        self.by_timer.remove(&l.timer.1);
        let _ = c.release(l.record.body, l.driver);
        l.record.ended = Some(Ended { at, how });
        Some(l.record)
    }

    /// Ends move `instance` now, as `how`: its timer cleared and its driver released.
    pub fn cancel(
        &mut self,
        c: &mut Controller,
        due: &mut DueList,
        instance: Instance,
        at: Micros,
        how: Name,
    ) -> Option<MoveRecord> {
        let key = self.live.get(&instance)?.timer;
        due.cancel(key);
        self.end(c, instance, at, how)
    }

    /// Runs a timer the due list handed back, at its due time: `None` when it is not a move's. The phase it ends
    /// gives way to the next, whose end becomes the move's one timer, or the move is done. A move whose driver a later
    /// claim ended is cancelled `claim-taken`; at contact the reach is asked again, and beyond it the move is
    /// cancelled `out-of-reach`.
    pub fn fire(
        &mut self,
        c: &mut Controller,
        due: &mut DueList,
        mint: &mut Minter,
        geo: &impl Reach,
        t: &Timer,
    ) -> Option<Fired> {
        let n = *self.by_timer.get(&t.id)?;
        let l = self.live.get(&n)?;
        let body = l.record.body;
        let still = c
            .claims(body)
            .is_some_and(|cl| cl.running().contains_key(&l.driver));
        if !still {
            return self
                .end(c, n, t.due, name("claim-taken"))
                .map(Fired::Cancelled);
        }
        let phase = l.phase + 1;
        if phase == 1 {
            let limb = l.record.limbs.first();
            let near = geo
                .distance(body, &l.mv.effector, limb, l.record.target, &l.mv.contact)
                .is_some_and(|d| d <= l.mv.reach);
            if !near {
                return self
                    .end(c, n, t.due, name("out-of-reach"))
                    .map(Fired::Cancelled);
            }
        }
        if phase == l.mv.phases.len() {
            return self.end(c, n, t.due, name("done")).map(Fired::Done);
        }
        let next = l.record.ends[phase];
        let Ok(id) = mint.mint() else {
            return self
                .end(c, n, t.due, name("id-counter-exhausted"))
                .map(Fired::Cancelled);
        };
        if due
            .set(Timer {
                node: body,
                id,
                due: next,
                name: timer_name(),
            })
            .is_err()
        {
            return self
                .end(c, n, t.due, name("id-duplicate"))
                .map(Fired::Cancelled);
        }
        self.by_timer.remove(&t.id);
        self.by_timer.insert(id, n);
        if let Some(l) = self.live.get_mut(&n) {
            l.phase = phase;
            l.timer = (next, id);
        }
        Some(Fired::Phase { instance: n, phase })
    }
}

#[cfg(test)]
mod tests;
