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
//! - **The effect, once** (F2, #2767). A run carries its intent ([`Intent`]). When the runner says the effect's
//!   instant has come, each of the form's effects is written as one log entry ([`Forms::out`]): one generic set,
//!   caused by the intent, with a `souls:effect` event that holds its key (the effect's number, the intent's expiry and
//!   the digest of what it asked). The key is (intent id, effect number). An effect counts as applied only once the log
//!   holds it: the log's writer hands each entry back to [`Forms::logged`], and recovery after a restart is
//!   [`Forms::recover`] over the same entries, never a form run again. A key already written or waiting to be is
//!   never written again, so a resent intent, a doubled timer or a restart cannot apply an effect twice; a resend gets
//!   the first receipt ([`Asked::Applied`]), or the run in progress ([`Asked::Running`]). The same intent id with
//!   other contents is refused (`intent-key-reused`), and an intent past its expiry is refused (`intent-expired`):
//!   keys are kept until then ([`Forms::forget`]). The key is the intent, never the target the run chose.
//!
//! Not here: amounts, making and removing (F4), reserving and stopping (F3), who may (F6), a walk across a link (the walk's crossings are
//! not carried here yet), accepting the intent (I4).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event, Rest};
use replica::encode::{Name, Value};
use replica::host::Progress;
use replica::ids::{Id, Minter};
use replica::moves::Move;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::Audience;
use skills::form_runner::{self, Limits, Next, Runner, Step, Woke};

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

/// The intent a run carries out, as I4 accepted it: its id (the same for every resend), its expiry in world time, its
/// actor, and the digest of what it asked (its bytes' hash), which a resend must match.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Intent {
    pub id: Id,
    pub expiry: Micros,
    pub actor: Actor,
    pub digest: [u8; 32],
}

/// The first receipt for an intent's effects: the log sequences that carried them, by effect number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub intent: Id,
    pub entries: Vec<u64>,
}

/// How [`Forms::start`] answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Asked {
    /// A new run.
    Started(RunId),
    /// The intent's run is in progress: a resend joins it.
    Running(RunId),
    /// Every effect of the intent is in the log: the first receipt, again.
    Applied(Receipt),
}

/// The name of the event that carries an effect's key.
const KEY: &str = "souls:effect";

/// An intent's keys in the log.
struct Kept {
    digest: [u8; 32],
    expiry: Micros,
    /// Effect number to the log sequence that holds it.
    entries: BTreeMap<u64, u64>,
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

/// An effect entry's key, digest and expiry, when it is a form's effect: `((intent, number), digest, expiry)`.
fn key_of(e: &Effect) -> Option<((Id, u64), [u8; 32], Micros)> {
    let Cause::Intent(id) = e.envelope.cause else {
        return None;
    };
    let ev = e.events.as_ref()?.iter().find(|v| v.name.as_str() == KEY)?;
    let Some(Value::Uint(n)) = ev.fields.get(&1) else {
        return None;
    };
    let expiry = read_int(ev.fields.get(&2))?;
    let Some(Value::Bytes(d)) = ev.fields.get(&3) else {
        return None;
    };
    Some(((id, *n), d.as_slice().try_into().ok()?, expiry))
}

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
    node: Id,
    intent: Intent,
    effects: Vec<form_runner::Effect>,
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
    by_intent: BTreeMap<Id, RunId>,
    walks: Vec<Run>,
    last: RunId,
    /// Runs that ended, in order; the caller drains it.
    pub ended: Vec<Ended>,
    /// Effects written and not yet handed to the log, sequence 0: the log's writer numbers them, appends them and
    /// hands each back to [`Forms::logged`]. Until then they are not applied.
    pub out: Vec<Effect>,
    /// Keys written to [`Forms::out`] and not yet logged.
    pending: BTreeSet<(Id, u64)>,
    /// Keys in the log, by intent, until the intent's expiry.
    applied: BTreeMap<Id, Kept>,
    expiring: BTreeSet<(Micros, Id)>,
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

    /// The keys of a log, read back after a restart: every entry, in order, as [`Forms::logged`] reads it. No run is
    /// remade; a resent intent whose effects are here gets its first receipt.
    pub fn recover<'a>(log: impl IntoIterator<Item = &'a Effect>) -> Forms {
        let mut f = Forms::new();
        for e in log {
            f.logged(e);
        }
        f
    }

    /// The log holds entry `e` (numbered): a form's effect is applied from now on, and its sequence is its receipt.
    /// Any other entry changes nothing here.
    pub fn logged(&mut self, e: &Effect) {
        let Some(((id, n), digest, expiry)) = key_of(e) else {
            return;
        };
        self.pending.remove(&(id, n));
        let kept = self.applied.entry(id).or_insert_with(|| Kept {
            digest,
            expiry,
            entries: BTreeMap::new(),
        });
        kept.entries.entry(n).or_insert(e.envelope.sequence);
        self.expiring.insert((expiry, id));
    }

    /// Forgets the keys of intents whose expiry passed before `now`; a resend of one is refused `intent-expired`.
    pub fn forget(&mut self, now: Micros) {
        while let Some(&(at, id)) = self.expiring.first()
            && at < now
        {
            self.expiring.pop_first();
            if self.applied.get(&id).is_some_and(|k| k.expiry == at) {
                self.applied.remove(&id);
            }
        }
    }

    /// Hands an accepted form, bound into `steps` and `effects`, to a runner on `body` done at `node` for `intent`, and
    /// wakes it. A resend of an intent whose effects are all in the log gets the first receipt, and one whose run is in
    /// progress joins it. Refused: `intent-expired` past the intent's expiry, `intent-key-reused` for an intent id
    /// seen with other contents, `form-running` while the body has another run in progress.
    #[allow(clippy::too_many_arguments)]
    pub fn start<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        body: Id,
        node: Id,
        intent: Intent,
        steps: Vec<Step>,
        effects: Vec<form_runner::Effect>,
        limits: Limits,
        now: Micros,
    ) -> Result<Asked, replica::effects::Refusal> {
        let refuse = |name| {
            Err(replica::effects::Refusal {
                name,
                detail: replica::world_model::show(intent.id),
            })
        };
        if now > intent.expiry {
            return refuse("intent-expired");
        }
        if let Some(k) = self.applied.get(&intent.id) {
            if k.digest != intent.digest {
                return refuse("intent-key-reused");
            }
            if (0u64..)
                .zip(&effects)
                .all(|(n, _)| k.entries.contains_key(&n))
            {
                return Ok(Asked::Applied(Receipt {
                    intent: intent.id,
                    entries: k.entries.values().copied().collect(),
                }));
            }
        }
        if let Some(&run) = self.by_intent.get(&intent.id) {
            return match self.runs.get(&run) {
                Some(fr) if fr.intent.digest == intent.digest => Ok(Asked::Running(run)),
                _ => refuse("intent-key-reused"),
            };
        }
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
                node,
                intent,
                effects,
                runner: Runner::new(steps, node, limits),
                walk: None,
                mv: None,
            },
        );
        self.by_body.insert(body, run);
        self.by_intent.insert(intent.id, run);
        self.wake(w, run, Woke::Start, now);
        Ok(Asked::Started(run))
    }

    /// Writes run `run`'s effects at `at`, each one entry, but no key already written or waiting to be.
    fn emit(&mut self, run: RunId, at: Micros) {
        let Some(fr) = self.runs.get(&run) else {
            return;
        };
        let id = fr.intent.id;
        for (n, e) in (0u64..).zip(&fr.effects) {
            let done = self
                .applied
                .get(&id)
                .is_some_and(|k| k.entries.contains_key(&n));
            if done || !self.pending.insert((id, n)) {
                continue;
            }
            let key = Event {
                name: name(KEY),
                fields: BTreeMap::from([
                    (1, Value::Uint(n)),
                    (2, int(fr.intent.expiry)),
                    (3, Value::Bytes(fr.intent.digest.to_vec())),
                ]),
                changes: vec![0],
                rest: Rest::new(),
            };
            self.out.push(Effect {
                envelope: Envelope {
                    sequence: 0,
                    at,
                    cause: Cause::Intent(id),
                    actor: fr.intent.actor,
                    audience: Audience::Everyone,
                    node: fr.node,
                },
                body: Body::Changes(vec![ChangeRec {
                    change: Change::Set {
                        node: fr.node,
                        field: e.field,
                        to: e.to.clone(),
                        by: None,
                    },
                    rest: Rest::new(),
                }]),
                events: Some(vec![key]),
                rest: Rest::new(),
            });
        }
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
        if fr.runner.take_effect() {
            self.emit(run, now);
        }
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
        self.by_intent.remove(&fr.intent.id);
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
        self.forget(now);
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
            match f {
                Fired::Done(rec) | Fired::Cancelled(rec) => {
                    if let Some(&run) = self.by_body.get(&rec.body)
                        && let Some(fr) = self.runs.get_mut(&run)
                        && fr.mv.take().is_some()
                    {
                        let how = rec.ended.map_or_else(|| name("done"), |e| e.how);
                        self.wake(w, run, Woke::Moved(how), t.due);
                    }
                }
                // Phase 1 begins at the contact instant (B2).
                Fired::Phase { instance, phase: 1 } => {
                    if let Some(&run) = self.by_body.get(&t.node)
                        && self
                            .runs
                            .get(&run)
                            .is_some_and(|fr| fr.mv == Some(instance))
                    {
                        self.wake(w, run, Woke::Contact, t.due);
                    }
                }
                Fired::Phase { .. } => {}
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
