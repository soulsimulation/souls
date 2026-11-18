//! Forms on the world's side (Engine v2 F1, #2766): an accepted form, bound into steps, is handed to the form runner
//! (`skills::form_runner`) on its body, and the runner is woken by events alone. No code here names a kind, a form or
//! a move.
//!
//! - **Woken, never stepped.** A run is woken through the host ([`crate::host::lend`]) when it starts, when its walk
//!   ends, when its move ends and when one of its own timers fires; between those it costs nothing. Timers are keyed
//!   by run: a timer's id finds its run, and a finished run's ids are gone, so an old timer wakes nothing.
//! - **What the runner asks for**, the world does through its one path for each: a walk is a skill run under a
//!   driver the controller gives (stepped by [`crate::host::step`] with every other skill, its inputs handed on to
//!   the controller); a move is started by B2's [`Moves::start`] toward the form's point, with its refusals by name;
//!   its timers go to K9's due list. A walk or move refused at its start is handed back to the runner, which ends the
//!   run with the refusal's name.
//! - **Ending.** The runner ends every run with a name ([`Ended`]); what the run started and has not ended (a walk, a
//!   move, a timer) the world ends with it, so no driver or timer outlives its run.
//!
//! Not here: effects (F2), reserving and stopping (F3), who may (F6), a walk across a link (the walk's crossings are
//! not carried here yet), accepting the intent (I4).

use std::collections::{BTreeMap, HashMap};

use replica::encode::Name;
use replica::host::Progress;
use replica::ids::{Id, Minter};
use replica::moves::Move;
use replica::time::Micros;
use replica::tree::Tree;
use skills::form_runner::{Limits, Next, Runner, Step, Woke};

use crate::controller::{Controller, Driver};
use crate::host::{Geometry, Run, Staged, hand_on, lend, step};
use crate::moves::{Fired, Instance, Moves, Reach};
use crate::timers::{DueList, Timer};

/// What a form's run reaches in the world: the tree as of the tick's start, the geometry's answers, the controller,
/// the due list, the moves in progress and the moves' library (data), and the seed of the tick's draws.
pub struct World<'a, G, R> {
    pub tree: &'a Tree,
    pub geometry: &'a G,
    pub reach: &'a R,
    pub controller: &'a mut Controller,
    pub due: &'a mut DueList,
    pub mint: &'a mut Minter,
    pub moves: &'a mut Moves,
    pub library: &'a [Move],
    pub seed: u64,
}

/// A run's number, unique in [`Forms`].
pub type RunId = u64;

/// A run that ended, with its name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub run: RunId,
    pub body: Id,
    pub at: Micros,
    pub how: Name,
}

struct FormRun {
    body: Id,
    runner: Runner,
    /// The walk's driver while the runner's walk runs.
    walk: Option<Driver>,
    /// The move in progress the runner asked for.
    mv: Option<Instance>,
}

/// Every form's run in progress, with the walks they started.
#[derive(Default)]
pub struct Forms {
    runs: BTreeMap<RunId, FormRun>,
    by_body: BTreeMap<Id, RunId>,
    by_timer: HashMap<Id, RunId>,
    walks: Vec<Run>,
    last: RunId,
    /// Runs that ended, in order; the caller drains it.
    pub ended: Vec<Ended>,
}

fn name(t: &str) -> Name {
    Name::new(t).unwrap_or_else(|| unreachable!("a refusal's name is a name"))
}

impl Forms {
    pub fn new() -> Forms {
        Forms::default()
    }

    /// Runs in progress.
    pub fn len(&self) -> usize {
        self.runs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    /// Walks in progress, stepped each tick by [`Forms::tick`].
    pub fn walking(&self) -> usize {
        self.walks.len()
    }

    /// Hands an accepted form, bound into `steps`, to a runner on `body` done at `node`, and wakes it: refused
    /// `form-running` while the body has a run in progress.
    pub fn start<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        body: Id,
        node: Id,
        steps: Vec<Step>,
        limits: Limits,
        now: Micros,
    ) -> Result<RunId, replica::effects::Refusal> {
        if self.by_body.contains_key(&body) {
            return Err(replica::effects::Refusal {
                name: "form-running",
                detail: replica::world_model::show(body),
            });
        }
        self.last += 1;
        let run = self.last;
        self.runs.insert(
            run,
            FormRun {
                body,
                runner: Runner::new(steps, node, limits),
                walk: None,
                mv: None,
            },
        );
        self.by_body.insert(body, run);
        self.wake(w, run, Woke::Start, now);
        Ok(run)
    }

    fn wake<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        run: RunId,
        why: Woke,
        now: Micros,
    ) {
        let Some(fr) = self.runs.get_mut(&run) else {
            return;
        };
        let mut staged = Staged::default();
        // The runner drives nothing: it is lent the host under no driver.
        let next = lend(
            w.tree,
            w.geometry,
            now,
            w.seed,
            w.mint,
            (fr.body, 0),
            &mut staged,
            |h| fr.runner.wake(h, why),
        );
        for t in &staged.timers {
            self.by_timer.insert(t.id, run);
        }
        for (_, id) in &staged.cleared {
            self.by_timer.remove(id);
        }
        if !w.due.apply(&staged).is_empty() {
            return self.finish(w, run, name("timer-refused"), now);
        }
        self.handle(w, run, next, now);
    }

    fn handle<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        run: RunId,
        next: Next,
        now: Micros,
    ) {
        let Some(fr) = self.runs.get_mut(&run) else {
            return;
        };
        let body = fr.body;
        match next {
            Next::Sleep => {}
            Next::End(how) => self.finish(w, run, how, now),
            Next::Walk(skill) => match w.controller.claim(body, &skill.shape()) {
                Ok(driver) => {
                    fr.walk = Some(driver);
                    self.walks.push(Run {
                        body,
                        driver,
                        skill,
                    });
                }
                Err(r) => self.wake(w, run, Woke::Walked(Progress::Failed(name(r.name))), now),
            },
            Next::Move { name: mv, node, at } => {
                let Some(found) = w.library.iter().find(|m| m.name == mv) else {
                    return self.wake(w, run, Woke::Moved(name("move-unknown")), now);
                };
                let mut found = found.clone();
                found.contact = at;
                match w.moves.start(
                    w.controller,
                    w.due,
                    w.mint,
                    w.reach,
                    body,
                    &found,
                    node,
                    now,
                ) {
                    Ok(n) => fr.mv = Some(n),
                    Err(r) => self.wake(w, run, Woke::Moved(name(r.name)), now),
                }
            }
        }
    }

    /// Ends run `run` as `how`: its walk stopped and its driver released, its move cancelled, its timers cleared.
    fn finish<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        run: RunId,
        how: Name,
        now: Micros,
    ) {
        let Some(fr) = self.runs.remove(&run) else {
            return;
        };
        self.by_body.remove(&fr.body);
        if let Some(d) = fr.walk {
            self.walks.retain(|r| r.body != fr.body);
            let _ = w.controller.release(fr.body, d);
        }
        if let Some(n) = fr.mv {
            w.moves
                .cancel(w.controller, w.due, n, now, name("form-ended"));
        }
        let mine: Vec<Id> = self
            .by_timer
            .iter()
            .filter(|(_, r)| **r == run)
            .map(|(id, _)| *id)
            .collect();
        for id in mine {
            self.by_timer.remove(&id);
            let _ = w.due.clear(fr.body, id);
        }
        self.ended.push(Ended {
            run,
            body: fr.body,
            at: now,
            how,
        });
    }

    /// The tick's part for forms: the walks runs started are stepped with the host, their inputs handed on to the
    /// controller, and a walk that ended wakes its run. With no walk in progress it does nothing.
    pub fn tick<G: Geometry, R: Reach>(&mut self, w: &mut World<'_, G, R>, now: Micros) {
        if self.walks.is_empty() {
            return;
        }
        let staged = step(w.tree, w.geometry, now, w.seed, w.mint, &mut self.walks);
        let _ = hand_on(&staged, w.controller);
        let _ = w.due.apply(&staged);
        for (body, p) in staged.ended {
            let Some(&run) = self.by_body.get(&body) else {
                continue;
            };
            if let Some(fr) = self.runs.get_mut(&run)
                && let Some(d) = fr.walk.take()
            {
                let _ = w.controller.release(body, d);
            }
            self.wake(w, run, Woke::Walked(p), now);
        }
    }

    /// Runs a timer the due list handed back, at its due time: a move's phase timer (B2's [`Moves::fire`]; a move's
    /// end wakes its run) or a run's own timer. Returns whether it was either; any other timer is the caller's.
    pub fn fire<G: Geometry, R: Reach>(&mut self, w: &mut World<'_, G, R>, t: &Timer) -> bool {
        if let Some(f) = w.moves.fire(w.controller, w.due, w.mint, w.reach, t) {
            if let Fired::Done(rec) | Fired::Cancelled(rec) = f
                && let Some(&run) = self.by_body.get(&rec.body)
                && let Some(fr) = self.runs.get_mut(&run)
                && fr.mv.take().is_some()
            {
                let how = rec.ended.map_or_else(|| name("done"), |e| e.how);
                self.wake(w, run, Woke::Moved(how), t.due);
            }
            return true;
        }
        let Some(run) = self.by_timer.remove(&t.id) else {
            return false;
        };
        self.wake(w, run, Woke::Timer(t.id), t.due);
        true
    }
}

#[cfg(test)]
mod tests;
