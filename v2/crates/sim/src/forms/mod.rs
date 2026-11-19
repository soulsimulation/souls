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
//! - **Reserved, and ended in one entry** (F3, #2768). Accepting a form writes one entry at commit, in arrival order:
//!   a `souls:form-started` event and, when the form is done at a thing, the reservation, a `souls:reserves` link from
//!   the body to the thing. A form done on the body itself or on ground marked [`Forms::shared`] reserves nothing. A
//!   second Soul asking for a reserved thing is refused `thing-reserved`, naming the holder and one next act. However
//!   a run ends, one entry removes the reservation and names the ending (a `souls:form-ended` event with its name),
//!   and the world ends the run's walk, move and timers with it: no path frees one alone. Ending never undoes an
//!   effect.
//! - **Stopped three ways.** The Soul leaves ([`Forms::leave`]: taken at once, done at the next stable moment, the
//!   runner's rule); the thing or the body is removed ([`Forms::gone`]: the removal took the link with it, so the
//!   ending has no unlink); the process dies ([`Forms::recover`]: every run the log shows started and not ended is
//!   ended `restart` and its thing freed; nothing is resumed).
//! - **Every hold has a holder** ([`holders`]): the check the fault simulation (O5) runs, here after every stop.
//!
//! - **Who may** (F6, #2771). [`Forms::commit`] is a Soul's act's way in: it binds the form, checks who may at
//!   commit ([`may`]) whatever the client said, and starts the run. The test is R2's ([`replica::who_may`]), one code
//!   for the client and the world, read from the form's `who`: anyone, the holder, the world alone, or the ends of a
//!   link of a type the thing's kind declares (its owner, a member, the Soul whose turn it is). On the tree, a kind's
//!   link `t` is the type `<the kind's namespace>:t`, except its `owner`: that is `souls:owns`, the one owner relation
//!   the `owner` audience rule reads too (`replica::audience::link_type`, #3265). A body is its Soul by
//!   `souls:body-of`. A refusal, `not-permitted`, names who may: the rule, and the ends' names only when the asker is
//!   in the links' audience.
//!   Ownership changing mid-form changes nothing: it is checked once, at commit.
//!
//! - **Amounts, take and put, make and remove** (F4, #2769, [`amounts`]). At the effect's instant each effect is
//!   worked out against the tree and the entries already written this tick: an amount moved between two things as the
//!   source's and the target's sets, a take or a put as B4's transfer, a thing made into a hand or a slot, a thing the
//!   node contains or the body holds removed. One effect's entries are one part, the first carrying its key; what
//!   [`Forms::out`] holds at the tick's end is appended as one part. A refused effect writes nothing (none of the run's
//!   effects) and ends the run with the refusal's name. The amount fields come from the kinds ([`Forms::kinds`]) and
//!   the transfer's zone from its header ([`Forms::zone`]).
//!
//! - **A long form commits in stages** (F11, #2774). A form with `stages` (each its own `steps` and `effects`) names
//!   an `int` field of its kind as its stage field (`stage`), the number of stages done. When a stage's steps end, one
//!   entry writes that stage's effects and the stage field together, under one key (intent, stage number; F2), so
//!   every committed state is a legal place to stop: a stage ends only when its steps have (a move at its end, never
//!   half done). The last stage sets the field back to 0. A run is never resumed (F3): stopped any way, it keeps the
//!   stages it committed and holds nothing, and the next run, by anyone, starts at the stage the thing's own field
//!   names ([`Forms::start_stages`]).
//!
//! - **Places and links** (C17, #3453). A `sit` (or `lie`) step takes the world's seat by B3's [`Slots`] and B2's sit
//!   or lie move, the gateway's own path: [`World::places`] lends the places table and the floors, a seat's timers fire
//!   through [`Slots::fire`] so its contact hands the body into the slot, and the move's end wakes the run. A walk's
//!   crossings are kept for the caller to carry ([`Forms::crossings`], `crate::host::carry`), so a form walks
//!   indoors across doors and stairs.
//!
//! Not here: accepting the intent (I4),
//! queueing for a reserved thing (B7), things for several users, a thing made or set down where there is no slot (E4).

pub mod amounts;

use std::collections::{BTreeMap, BTreeSet};

use replica::audience;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event, Header, Refusal, Rest, read_id,
};
use replica::encode::{Name, Value};
use replica::host::Progress;
use replica::ids::{Id, Minter};
use replica::moves::Move;
use replica::pose::Vec3;
use replica::time::Micros;
use replica::tree::Tree;
use replica::who_may::{self, Answer, Who};
use replica::world_model::{Audience, End, show};
use skills::form_runner::{self, Limits, Next, Runner, Step, Woke};

use crate::controller::{Controller, Driver};
use crate::host::{Geometry, Run, Staged, hand_on, lend, step};
use crate::mover::Surface;
use crate::moves::{Fired, Instance, Moves, Reach};
use crate::slots::{PlaceAt, Request, Slots, hands};
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
    /// The world's places and floors, for a `sit` step (C17); `None` where the world has none.
    pub places: Option<Places<'a>>,
}

/// The places a form's sit takes (B3's table, the gateway's own) and the floors a body is set back on.
pub struct Places<'a> {
    pub slots: &'a mut Slots,
    pub floors: &'a BTreeMap<Id, Surface>,
}

/// A seat's reach for one body, as the gateway's sit measures it (`worldd`'s bodies): a seat is taken from its stand
/// point and left there (B3), so its contacts are at the stand point ([`PlaceAt::stand`]), measured across x and z
/// from where the body stands (its seat's stand point while it is in one); any other target as `inner`.
struct SeatReach<'b, R> {
    inner: &'b R,
    body: Id,
    from: Vec3,
    place: Option<(Id, Vec3)>,
}

impl<R: Reach> Reach for SeatReach<'_, R> {
    fn distance(
        &self,
        body: Id,
        effector: &replica::moves::Effector,
        limb: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64> {
        let Some((_, to)) = self.place.filter(|p| p.0 == target && body == self.body) else {
            return self.inner.distance(body, effector, limb, target, point);
        };
        if !matches!(point.as_str(), "souls:slot" | "souls:stand") {
            return self.inner.distance(body, effector, limb, target, point);
        }
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        i64::try_from((d(self.from.x, to.x) + d(self.from.z, to.z)).isqrt()).ok()
    }

    fn tip(&self, body: Id, limb: &Name) -> Option<Name> {
        self.inner.tip(body, limb)
    }
}

/// [`SeatReach`] for `body` and the seat `place` of `slots`, over `inner`.
fn seat_reach<'b, R: Reach>(
    inner: &'b R,
    c: &Controller,
    slots: &Slots,
    body: Id,
    place: Option<&PlaceAt>,
) -> SeatReach<'b, R> {
    let at = |p: &PlaceAt| p.stand().ok();
    let from = c.body(body).map_or(Vec3::ZERO, |b| {
        match (b.pose.support, slots.held_place(body)) {
            (replica::pose::Support::Slot, Some(p)) => at(p).unwrap_or(b.pose.position),
            _ => b.pose.position,
        }
    });
    SeatReach {
        inner,
        body,
        from,
        place: place.and_then(|p| Some((p.thing, at(p)?))),
    }
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
/// A run's start and its end: fields 1 the run, 2 the body, and on the end 3 the ending's name.
const STARTED: &str = "souls:form-started";
const ENDED: &str = "souls:form-ended";
/// The reservation's link type: from the body to the thing.
pub(crate) const RESERVES: &str = "souls:reserves";

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
    /// The thing it reserves and the link's id, while the link stands.
    held: Option<(Id, Id)>,
    /// A long form's stages, and the one in progress (F11).
    long: Option<Long>,
}

/// One stage of a long form, bound (F11): its steps, and the effects written with its end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stage {
    pub steps: Vec<Step>,
    pub effects: Vec<form_runner::Effect>,
}

/// A long form, bound (F11): its stage field (its number in the kind's `state`) and its stages, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stages {
    pub field: u64,
    pub list: Vec<Stage>,
}

/// A long form's run: its stages, the one in progress, and the deadlines each stage's runner gets.
struct Long {
    stages: Stages,
    at: usize,
    limits: Limits,
}

/// Binds form `form` of `entry` as a long form (F11): `None` when it has no `stages`. Each stage binds as a form of its
/// own would ([`form_runner::bind`], [`form_runner::bind_effects`]), all or none. Refused: `form-unknown`,
/// `form-has-no-stages`, `stage-field-unknown` (the form's `stage` names no `int` field of the kind),
/// `effect-not-built` (a stage's effect that is not a set: F4's are not carried in stages), and the binders' refusals.
pub fn bind_stages(
    entry: &replica::rules::json::Value,
    form: &str,
) -> Result<Option<Stages>, Refusal> {
    use replica::rules::json::Value as J;
    let refuse = |name, detail: &str| {
        Err(Refusal {
            name,
            detail: detail.to_owned(),
        })
    };
    let Some(f) = entry.get("forms").and_then(|fs| fs.get(form)) else {
        return refuse("form-unknown", form);
    };
    let Some(list) = f.get("stages").and_then(J::arr) else {
        return Ok(None);
    };
    if list.is_empty() {
        return refuse("form-has-no-stages", form);
    }
    let named = f.get("stage").and_then(J::str).unwrap_or_default();
    let def = entry.get("state").and_then(|s| s.get(named));
    let field = match (
        def.and_then(|d| d.get("n")),
        def.and_then(|d| d.get("type")).and_then(J::str),
    ) {
        (Some(J::Int(n)), Some("int")) => u64::try_from(*n).ok(),
        _ => None,
    };
    let Some(field) = field else {
        return refuse("stage-field-unknown", named);
    };
    let part = |k: &str| entry.get(k).cloned().unwrap_or(J::Obj(Vec::new()));
    let list = list
        .iter()
        .map(|stage| {
            // The stage as a form of its own, with the kind's points and state.
            let one = J::Obj(vec![
                ("points".into(), part("points")),
                ("state".into(), part("state")),
                (
                    "forms".into(),
                    J::Obj(vec![(form.to_owned(), stage.clone())]),
                ),
            ]);
            let effects = form_runner::bind_effects(&one, form)?;
            // A stage commits its sets with the stage field in one entry; F4's amounts, takes and puts are not
            // carried in stages.
            if let Some(e) = effects
                .iter()
                .find(|e| !matches!(e, form_runner::Effect::Set { .. }))
            {
                return Err(Refusal {
                    name: "effect-not-built",
                    detail: format!("a stage's effects are sets: {e:?}"),
                });
            }
            Ok(Stage {
                steps: form_runner::bind(&one, form)?,
                effects,
            })
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    Ok(Some(Stages { field, list }))
}

/// A run as its entries name it: started, and (once it ends) ended.
struct Open {
    run: RunId,
    body: Id,
    node: Id,
    intent: Id,
    actor: Actor,
    /// The reservation's link, while it stands.
    link: Option<Id>,
}

/// Every form's run in progress, with the walks they started.
#[derive(Default)]
pub struct Forms {
    runs: BTreeMap<RunId, FormRun>,
    by_body: BTreeMap<Id, RunId>,
    by_timer: BTreeMap<Id, RunId>,
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
    /// Reserved things, to the run that holds each.
    reserved: BTreeMap<Id, RunId>,
    /// Nodes a form reserves nothing at: kinds of ground (E21).
    shared: BTreeSet<Id>,
    /// The kinds' amount fields (F4).
    limits: amounts::Limits,
    /// The zone's header, for B4's transfer.
    header: Option<Header>,
    /// The crossings the walks asked for this tick (C17): the caller carries them (`crate::host::carry`) and clears
    /// the list.
    pub crossings: Vec<(Id, Driver, Id, i64)>,
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

    /// The keys of a log, read back after a restart at `now`: every entry, in order, as [`Forms::logged`] reads it. No
    /// run is remade; a resent intent whose effects are here gets its first receipt. Every run the log shows started
    /// and not ended is ended `restart` now, in the order it started: its ending entry, which frees its thing, is in
    /// [`Forms::out`], and its end in [`Forms::ended`].
    pub fn recover<'a>(log: impl IntoIterator<Item = &'a Effect>, now: Micros) -> Forms {
        let mut f = Forms::new();
        let mut open: BTreeMap<RunId, Open> = BTreeMap::new();
        for e in log {
            f.logged(e);
            for c in e.changes() {
                if let Change::Remove { node } = c.change {
                    for o in open
                        .values_mut()
                        .filter(|o| o.body == node || o.node == node)
                    {
                        o.link = None;
                    }
                }
            }
            for ev in e.events.iter().flatten() {
                let Some(Value::Uint(run)) = ev.fields.get(&1) else {
                    continue;
                };
                match ev.name.as_str() {
                    STARTED => {
                        let (Some(Ok(body)), Cause::Intent(intent)) =
                            (ev.fields.get(&2).map(read_id), e.envelope.cause)
                        else {
                            continue;
                        };
                        let link = e.changes().iter().find_map(|c| match c.change {
                            Change::Link { link, .. } => Some(link),
                            _ => None,
                        });
                        f.last = f.last.max(*run);
                        open.insert(
                            *run,
                            Open {
                                run: *run,
                                body,
                                node: e.envelope.node,
                                intent,
                                actor: e.envelope.actor,
                                link,
                            },
                        );
                    }
                    ENDED => {
                        open.remove(run);
                    }
                    _ => {}
                }
            }
        }
        for o in open.into_values() {
            f.write_end(&o, now, name("restart"));
            f.ended.push(Ended {
                run: o.run,
                body: o.body,
                at: now,
                how: name("restart"),
            });
        }
        f
    }

    /// Marks `node` as ground: a form done there reserves nothing (E21).
    pub fn shared(&mut self, node: Id) {
        self.shared.insert(node);
    }

    /// The body whose run holds thing `thing`, if one does.
    pub fn holder(&self, thing: Id) -> Option<Id> {
        let run = self.reserved.get(&thing)?;
        self.runs.get(run).map(|fr| fr.body)
    }

    /// The number of the step in progress of `body`'s run.
    pub fn at(&self, body: Id) -> Option<usize> {
        let run = self.by_body.get(&body)?;
        self.runs.get(run)?.runner.at()
    }

    /// The Soul on `body` leaves its run: taken at once (`form-not-running` when there is none), and the run ends
    /// `left` at the next stable moment (the runner's rule).
    pub fn leave<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        body: Id,
        now: Micros,
    ) -> Result<(), Refusal> {
        let Some(&run) = self.by_body.get(&body) else {
            return Err(Refusal {
                name: "form-not-running",
                detail: show(body),
            });
        };
        self.wake(w, run, Woke::Leave, now);
        Ok(())
    }

    /// Node `node` was removed (its removal is logged, with every link that ends in it): a run on it as a body ends
    /// `body-gone`, and a run that reserves it ends `thing-gone`. The removal took the reservation with it, so the
    /// ending entry has no unlink.
    pub fn gone<G: Geometry, R: Reach>(&mut self, w: &mut World<'_, G, R>, node: Id, now: Micros) {
        let runs = [
            self.by_body.get(&node).map(|r| (*r, "body-gone")),
            self.reserved.get(&node).map(|r| (*r, "thing-gone")),
        ];
        for (run, how) in runs.into_iter().flatten() {
            if let Some(fr) = self.runs.get_mut(&run) {
                // The thing is gone, so the body writes the ending.
                if how == "thing-gone" {
                    fr.node = fr.body;
                }
                if let Some((thing, _)) = fr.held.take() {
                    self.reserved.remove(&thing);
                }
            }
            self.finish(w, run, name(how), now);
        }
    }

    /// Writes the entry that ends run `o`: its reservation removed (when its link still stands) and its ending named,
    /// in the `souls` namespace when it has none (an entry's text is a namespaced name, or the entry is not read).
    fn write_end(&mut self, o: &Open, at: Micros, how: Name) {
        let how = match how.as_str().contains(':') {
            true => how,
            false => name(&format!("souls:{}", how.as_str())),
        };
        let changes = o
            .link
            .map(|link| ChangeRec {
                change: Change::Unlink { link },
                rest: Rest::new(),
            })
            .into_iter()
            .collect();
        let fields = BTreeMap::from([
            (1, Value::Uint(o.run)),
            (2, o.body.to_value()),
            (3, Value::Bytes(how.as_str().as_bytes().to_vec())),
        ]);
        self.out.push(entry(o, at, changes, name(ENDED), fields));
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
    /// wakes it; the points it walks to are turned by the node's orientation in the tree ([`form_runner::turn`]). A
    /// resend of an intent whose effects are all in the log gets the first receipt, and one whose run is in progress
    /// joins it. Refused: `intent-expired` past the intent's expiry, `intent-key-reused` for an intent id
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
        self.open(w, body, node, intent, steps, effects, None, limits, now)
    }

    /// Hands a long form ([`bind_stages`]) to a runner on `body` done at `node` for `intent`, from the stage the
    /// thing's stage field names on the tree (0 when unset or past the last), and wakes it (F11). A resend joins the
    /// run in progress, or gets the first receipt once the last stage is in the log; after a run that stopped, it
    /// starts again from the thing. Refused as [`Forms::start`] is.
    #[allow(clippy::too_many_arguments)]
    pub fn start_stages<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        body: Id,
        node: Id,
        intent: Intent,
        stages: Stages,
        limits: Limits,
        now: Micros,
    ) -> Result<Asked, Refusal> {
        let refuse = |name| {
            Err(Refusal {
                name,
                detail: show(intent.id),
            })
        };
        if now > intent.expiry {
            return refuse("intent-expired");
        }
        if let Some(&run) = self.by_intent.get(&intent.id) {
            return match self.runs.get(&run) {
                Some(fr) if fr.intent.digest == intent.digest => Ok(Asked::Running(run)),
                _ => refuse("intent-key-reused"),
            };
        }
        if let Some(k) = self.applied.get(&intent.id) {
            if k.digest != intent.digest {
                return refuse("intent-key-reused");
            }
            if k.entries.contains_key(&(stages.list.len() as u64 - 1)) {
                return Ok(Asked::Applied(Receipt {
                    intent: intent.id,
                    entries: k.entries.values().copied().collect(),
                }));
            }
        }
        let done = w
            .tree
            .handle(node)
            .and_then(|h| w.tree.node(h))
            .and_then(|n| match n.fields().get(&stages.field) {
                Some(Value::Uint(d)) => usize::try_from(*d).ok(),
                _ => None,
            })
            .filter(|d| *d < stages.list.len())
            .unwrap_or(0);
        let steps = stages.list[done].steps.clone();
        let long = Long {
            stages,
            at: done,
            limits,
        };
        self.open(
            w,
            body,
            node,
            intent,
            steps,
            Vec::new(),
            Some(long),
            limits,
            now,
        )
    }

    /// The number of the stage in progress of `body`'s run, when it is a long form's.
    pub fn stage(&self, body: Id) -> Option<usize> {
        let run = self.by_body.get(&body)?;
        self.runs.get(run)?.long.as_ref().map(|l| l.at)
    }

    /// Opens a run once its intent is known to be new: refused `form-running` or `thing-reserved`, else reserved,
    /// started and woken.
    #[allow(clippy::too_many_arguments)]
    fn open<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        body: Id,
        node: Id,
        intent: Intent,
        steps: Vec<Step>,
        effects: Vec<form_runner::Effect>,
        long: Option<Long>,
        limits: Limits,
        now: Micros,
    ) -> Result<Asked, Refusal> {
        if self.by_body.contains_key(&body) {
            return Err(replica::effects::Refusal {
                name: "form-running",
                detail: replica::world_model::show(body),
            });
        }
        // A turned thing's points are walked to turned with it (C13, #3440).
        let mut steps = steps;
        if node != body
            && let Some(p) = w.tree.handle(node).and_then(|h| w.tree.node(h)?.place())
        {
            form_runner::turn(&mut steps, p.orientation)?;
        }
        let reserves = node != body && !self.shared.contains(&node);
        if reserves && let Some(holder) = self.holder(node) {
            return Err(Refusal {
                name: "thing-reserved",
                detail: format!(
                    "{} is held by {}; next: wait until it is free, then ask again",
                    show(node),
                    show(holder)
                ),
            });
        }
        let link = match reserves {
            true => Some(w.mint.mint().map_err(|e| Refusal {
                name: "id-counter-exhausted",
                detail: e.to_string(),
            })?),
            false => None,
        };
        self.last += 1;
        let run = self.last;
        let open = Open {
            run,
            body,
            node,
            intent: intent.id,
            actor: intent.actor,
            link,
        };
        let changes = link
            .map(|link| ChangeRec {
                change: Change::Link {
                    link,
                    ty: name(RESERVES),
                    ends: [body, node],
                    owner: End::Second,
                    audience: Audience::Everyone,
                },
                rest: Rest::new(),
            })
            .into_iter()
            .collect();
        let fields = BTreeMap::from([(1, Value::Uint(run)), (2, body.to_value())]);
        self.out
            .push(entry(&open, now, changes, name(STARTED), fields));
        if link.is_some() {
            self.reserved.insert(node, run);
        }
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
                held: link.map(|l| (node, l)),
                long,
            },
        );
        self.by_body.insert(body, run);
        self.by_intent.insert(intent.id, run);
        self.wake(w, run, Woke::Start, now);
        Ok(Asked::Started(run))
    }

    /// A Soul's act on `node`, at commit: form `form` of the thing's kind `entry` (a `souls-entry/1` entry) is bound,
    /// who may is checked on the tree as it stands ([`may`], with `audiences` the members of each audience and `names`
    /// the directory's names), and the run starts ([`Forms::start`]). A resend of an intent already accepted is not
    /// checked again. Refused: the binder's refusals, `not-permitted` naming who may, and [`Forms::start`]'s.
    #[allow(clippy::too_many_arguments)]
    pub fn commit<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        audiences: &BTreeMap<Id, BTreeSet<Id>>,
        names: &dyn Fn(Id) -> Option<String>,
        body: Id,
        node: Id,
        entry: &replica::rules::json::Value,
        form: &str,
        intent: Intent,
        limits: Limits,
        now: Micros,
    ) -> Result<Asked, Refusal> {
        let args = form_runner::Args::new();
        self.commit_with(
            w, audiences, names, body, node, entry, form, &args, intent, limits, now,
        )
    }

    /// [`Forms::commit`] with the act's arguments `args` (F14, #3384), bound into the form's steps and effects
    /// ([`form_runner::bind_with`], [`form_runner::bind_effects_args`]). Refused as [`Forms::commit`] is, and
    /// `arg-missing` for an argument the form uses and the act does not give.
    #[allow(clippy::too_many_arguments)]
    pub fn commit_with<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        audiences: &BTreeMap<Id, BTreeSet<Id>>,
        names: &dyn Fn(Id) -> Option<String>,
        body: Id,
        node: Id,
        entry: &replica::rules::json::Value,
        form: &str,
        args: &form_runner::Args,
        intent: Intent,
        limits: Limits,
        now: Micros,
    ) -> Result<Asked, Refusal> {
        // A long form (F11) binds as its stages; any other as its steps and effects.
        let bound = match bind_stages(entry, form)? {
            Some(stages) => Err(stages),
            None => Ok((
                form_runner::bind_with(entry, form, args)?,
                form_runner::bind_effects_args(entry, form, args)?,
            )),
        };
        let known =
            self.by_intent.contains_key(&intent.id) || self.applied.contains_key(&intent.id);
        if !known {
            may(w.tree, audiences, names, body, node, entry, form)?;
        }
        match bound {
            Ok((steps, effects)) => self.start(w, body, node, intent, steps, effects, limits, now),
            Err(stages) => self.start_stages(w, body, node, intent, stages, limits, now),
        }
    }

    /// The amount fields of `kinds` (K3's, with their least and capacity), which F4's transfers read. Called after
    /// [`Forms::new`] or [`Forms::recover`], and again when kinds load.
    pub fn kinds(&mut self, kinds: &replica::kinds::Kinds) {
        self.limits = amounts::limits(kinds);
    }

    /// The zone's header, which B4's transfer (a take or a put) writes under.
    pub fn zone(&mut self, header: Header) {
        self.header = Some(header);
    }

    /// Writes run `run`'s effects at `at`, but no key already written or waiting to be. Each effect's entries, worked
    /// out against the tree and what is already in [`Forms::out`], go in order, the first carrying its key; they are
    /// one part. All of the run's effects or none: a refusal takes back what this call wrote and is returned.
    fn emit(
        &mut self,
        tree: &Tree,
        controller: &Controller,
        mint: &mut Minter,
        run: RunId,
        at: Micros,
    ) -> Result<(), Refusal> {
        let Some(fr) = self.runs.get(&run) else {
            return Ok(());
        };
        let id = fr.intent.id;
        let hands: Vec<u64> = controller
            .claims(fr.body)
            .map(|b| hands(b.family()).iter().map(|h| h.slot).collect())
            .unwrap_or_default();
        let reserved: Vec<Id> = self
            .reserved
            .iter()
            .filter(|(_, r)| **r != run)
            .map(|(t, _)| *t)
            .collect();
        let (len, mut keys) = (self.out.len(), Vec::new());
        for (n, e) in (0u64..).zip(&fr.effects) {
            let done = self
                .applied
                .get(&id)
                .is_some_and(|k| k.entries.contains_key(&n));
            if done || self.pending.contains(&(id, n)) {
                continue;
            }
            let cx = amounts::Cx {
                view: amounts::View {
                    tree,
                    out: &self.out,
                },
                limits: &self.limits,
                header: self.header.as_ref(),
                body: fr.body,
                hands: &hands,
                node: fr.node,
                reserved: &reserved,
            };
            let entries = match cx.entries(mint, e) {
                Ok(x) => x,
                Err(r) => {
                    self.out.truncate(len);
                    return Err(r);
                }
            };
            keys.push((id, n));
            for (i, (node, audience, body)) in entries.into_iter().enumerate() {
                let key = (i == 0).then(|| Event {
                    name: name(KEY),
                    fields: BTreeMap::from([
                        (1, Value::Uint(n)),
                        (2, int(fr.intent.expiry)),
                        (3, Value::Bytes(fr.intent.digest.to_vec())),
                    ]),
                    changes: match &body {
                        Body::Changes(c) => (0..c.len() as u64).collect(),
                        _ => Vec::new(),
                    },
                    rest: Rest::new(),
                });
                self.out.push(Effect {
                    envelope: Envelope {
                        sequence: 0,
                        at,
                        cause: Cause::Intent(id),
                        actor: fr.intent.actor,
                        audience,
                        node,
                    },
                    body,
                    events: key.map(|k| vec![k]),
                    rest: Rest::new(),
                });
            }
        }
        self.pending.extend(keys);
        Ok(())
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
        let effect = match fr.runner.take_effect() {
            true => self.emit(w.tree, w.controller, w.mint, run, now),
            false => Ok(()),
        };
        for t in &staged.timers {
            self.by_timer.insert(t.id, run);
        }
        for (_, id) in &staged.cleared {
            self.by_timer.remove(id);
        }
        if !w.due.apply(&staged).is_empty() {
            return self.finish(w, run, name("timer-refused"), now);
        }
        if let Err(r) = effect {
            return self.finish(w, run, name(r.name), now);
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
        let long = fr.long.is_some();
        match next {
            Next::Sleep => {}
            Next::End(how) if long && how.as_str() == "done" => self.stage_done(w, run, now),
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
            Next::Sit { node, slot, lie } => {
                let mv = name(if lie { "souls:lie" } else { "souls:sit" });
                let (Some(found), Some(places)) =
                    (w.library.iter().find(|m| m.name == mv), w.places.as_mut())
                else {
                    return self.wake(w, run, Woke::Moved(name("place-unknown")), now);
                };
                let place = places.slots.place_in(node, slot);
                if place.is_none() {
                    return self.wake(w, run, Woke::Moved(name("place-unknown")), now);
                }
                let geo = seat_reach(w.reach, w.controller, places.slots, body, place);
                let request = Request {
                    body,
                    thing: node,
                    slot: Some(slot),
                    mv: found,
                    stance: if lie {
                        crate::controller::Stance::Lie
                    } else {
                        crate::controller::Stance::Sit
                    },
                };
                let taken = places
                    .slots
                    .commit(w.controller, w.due, w.mint, w.moves, &geo, &[request], now)
                    .pop()
                    .map_or_else(
                        || Err(name("place-unknown")),
                        |(_, r)| r.map_err(|e| name(e.name)),
                    );
                match taken {
                    Ok(n) => fr.mv = Some(n),
                    Err(how) => self.wake(w, run, Woke::Moved(how), now),
                }
            }
            Next::Move { name: mv, node, at } => {
                let Some(found) = w.library.iter().find(|m| m.name == mv) else {
                    return self.wake(w, run, Woke::Moved(name("move-unknown")), now);
                };
                let mut found = found.clone();
                if let Some(at) = at {
                    found.contact = at;
                }
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

    /// A long form's stage ended (F11): one entry writes its effects and the stage field, keyed (intent, stage number),
    /// unless that key is written or waiting to be; then the next stage's runner starts, or after the last the run
    /// ends `done`.
    fn stage_done<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        run: RunId,
        now: Micros,
    ) {
        let Some(fr) = self.runs.get_mut(&run) else {
            return;
        };
        let Some(long) = fr.long.as_mut() else {
            return;
        };
        let at = long.at;
        let last = at + 1 == long.stages.list.len();
        let key = (fr.intent.id, at as u64);
        let written = self
            .applied
            .get(&key.0)
            .is_some_and(|k| k.entries.contains_key(&key.1));
        if !written && self.pending.insert(key) {
            let stage = &long.stages.list[at];
            let next = if last { 0 } else { at as u64 + 1 };
            let sets = stage
                .effects
                .iter()
                .filter_map(|e| match e {
                    form_runner::Effect::Set { field, to } => Some((*field, to.clone())),
                    _ => None,
                })
                .chain([(long.stages.field, Value::Uint(next))]);
            let changes: Vec<ChangeRec> = sets
                .map(|(field, to)| ChangeRec {
                    change: Change::Set {
                        node: fr.node,
                        field,
                        to,
                        by: None,
                    },
                    rest: Rest::new(),
                })
                .collect();
            let fields = BTreeMap::from([
                (1, Value::Uint(key.1)),
                (2, int(fr.intent.expiry)),
                (3, Value::Bytes(fr.intent.digest.to_vec())),
            ]);
            let open = Open {
                run,
                body: fr.body,
                node: fr.node,
                intent: fr.intent.id,
                actor: fr.intent.actor,
                link: None,
            };
            self.out.push(entry(&open, now, changes, name(KEY), fields));
        }
        if last {
            return self.finish(w, run, name("done"), now);
        }
        long.at += 1;
        fr.runner = Runner::new(long.stages.list[at + 1].steps.clone(), fr.node, long.limits);
        self.wake(w, run, Woke::Start, now);
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
        if let Some((thing, _)) = fr.held {
            self.reserved.remove(&thing);
        }
        // A removal this tick (a run's own effect, F4) took the thing and its link: the ending has no unlink, and the
        // body writes it.
        let removed = amounts::View {
            tree: w.tree,
            out: &self.out,
        }
        .removed(fr.node);
        let o = Open {
            run,
            body: fr.body,
            node: if removed { fr.body } else { fr.node },
            intent: fr.intent.id,
            actor: fr.intent.actor,
            link: fr.held.filter(|_| !removed).map(|(_, l)| l),
        };
        self.write_end(&o, now, how.clone());
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
        self.crossings.extend(staged.crossings.iter().copied());
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
        // A seat's move fires through the places (C17): its contact hands the body into the slot, a rise's out.
        let fired = match w.places.as_mut() {
            Some(s) if s.slots.held_by(t.node).is_some() => {
                let geo = seat_reach(
                    w.reach,
                    w.controller,
                    s.slots,
                    t.node,
                    s.slots.held_place(t.node),
                );
                s.slots
                    .fire(w.controller, w.due, w.mint, w.moves, &geo, s.floors, t)
                    .map(|(f, _)| f)
            }
            _ => w.moves.fire(w.controller, w.due, w.mint, w.reach, t),
        };
        if let Some(f) = fired {
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

/// The type of a body's link to its Soul (contract T2).
const BODY_OF: &str = "souls:body-of";

/// Who may, on the world's side (F6): whether `body` may do form `form` of `entry` at `node`, as the tree stands. The
/// test is [`who_may::test`], the client's own. The actor's Soul is the far end of the body's `souls:body-of` link,
/// and the asker is that Soul (or the body, with none). The thing's links of the rule's type are read whatever their
/// audience; the refusal names their ends only when the asker is a member of every one's audience (`audiences`, as
/// resolved when written), and otherwise names the group alone. A refusal never holds an account id: ends are Soul or
/// body ids, named by `names` (the directory's names), else shown as ids. Refused: `form-unknown`, `who-unknown` (a
/// `who` outside the closed list), `not-permitted` with the sentence.
pub fn may(
    tree: &Tree,
    audiences: &BTreeMap<Id, BTreeSet<Id>>,
    names: &dyn Fn(Id) -> Option<String>,
    body: Id,
    node: Id,
    entry: &replica::rules::json::Value,
    form: &str,
) -> Result<(), Refusal> {
    let refuse = |name, detail: String| Err(Refusal { name, detail });
    let Some(f) = entry.get("forms").and_then(|fs| fs.get(form)) else {
        return refuse("form-unknown", form.to_owned());
    };
    let Some(who) = Who::read(f) else {
        return refuse("who-unknown", form.to_owned());
    };
    let soul = tree
        .links_at(body)
        .iter()
        .find(|e| tree.ty(e).as_str() == BODY_OF)
        .map(|e| e.other);
    let asker = soul.unwrap_or(body);
    let thing = tree.handle(node).and_then(|h| tree.node(h));
    let holds = thing.as_ref().and_then(|n| n.parent()) == Some(body);
    let (ends, seen) = match (&who, &thing) {
        (Who::Link(t), Some(n)) => {
            let ty = audience::link_type(n.kind().as_str(), t);
            let links: Vec<_> = tree
                .links_at(node)
                .iter()
                .filter(|e| tree.ty(e).as_str() == ty)
                .collect();
            let seen = links.iter().all(|e| match e.audience {
                Audience::Everyone => true,
                Audience::Of(a) => {
                    a == asker || audiences.get(&a).is_some_and(|m| m.contains(&asker))
                }
            });
            (links.iter().map(|e| e.other).collect(), seen)
        }
        _ => (Vec::new(), false),
    };
    match who_may::test(&who, &body, soul.as_ref(), holds, Some(&ends)) {
        Answer::Yes => Ok(()),
        Answer::No | Answer::Unknown => {
            let named: Vec<String> = ends
                .iter()
                .map(|e| names(*e).unwrap_or_else(|| show(*e)))
                .collect();
            let words = who_may::sentence(&who, seen.then_some(named.as_slice()));
            refuse("not-permitted", format!("who may: {words}"))
        }
    }
}

/// One entry of run `o` at `at`: `changes`, and one event, `event`, that names them all.
fn entry(
    o: &Open,
    at: Micros,
    changes: Vec<ChangeRec>,
    event: Name,
    fields: BTreeMap<u64, Value>,
) -> Effect {
    let named = (0..changes.len() as u64).collect();
    Effect {
        envelope: Envelope {
            sequence: 0,
            at,
            cause: Cause::Intent(o.intent),
            actor: o.actor,
            audience: Audience::Everyone,
            node: o.node,
        },
        body: Body::Changes(changes),
        events: Some(vec![Event {
            name: event,
            fields,
            changes: named,
            rest: Rest::new(),
        }]),
        rest: Rest::new(),
    }
}

/// A hold with no holder, as [`holders`] finds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Orphan {
    /// A reservation the log leaves standing whose run is not in progress.
    Reservation { link: Id, body: Id, thing: Id },
    /// A run in progress whose reservation the log does not hold.
    Run { run: RunId, body: Id },
    /// A driver on a body that no run in progress holds, as its walk or through its move.
    Driver { body: Id, driver: Driver },
}

/// The reservations a log leaves standing, link to `[body, thing]`: every `souls:reserves` link, less those unlinked
/// and those with an end removed. (A removed node's subtree is the tree's to know; the forms remove things one by one.)
pub fn reservations<'a>(log: impl IntoIterator<Item = &'a Effect>) -> BTreeMap<Id, [Id; 2]> {
    let mut held = BTreeMap::new();
    for e in log {
        for c in e.changes() {
            match &c.change {
                Change::Link { link, ty, ends, .. } if ty.as_str() == RESERVES => {
                    held.insert(*link, *ends);
                }
                Change::Unlink { link } => {
                    held.remove(link);
                }
                Change::Remove { node } => held.retain(|_, ends| !ends.contains(node)),
                _ => {}
            }
        }
    }
    held
}

/// Every hold has a holder: each reservation `log` leaves standing belongs to the run in progress that reserves that
/// thing from that body, each such run's reservation is in the log, and each driver on a body is held by the body's
/// run in progress (its walk, or the move it started). Run it once the tick's entries are logged; it returns what has
/// no holder. It reads every body the controller has, so in a world where other skills drive bodies too it speaks for
/// the forms' bodies only.
pub fn holders<'a>(
    forms: &Forms,
    controller: &Controller,
    moves: &Moves,
    log: impl IntoIterator<Item = &'a Effect>,
) -> Vec<Orphan> {
    let mut out = Vec::new();
    let held = reservations(log);
    for (&link, &[body, thing]) in &held {
        let ok = forms
            .reserved
            .get(&thing)
            .and_then(|r| forms.runs.get(r))
            .is_some_and(|fr| fr.held == Some((thing, link)) && fr.body == body);
        if !ok {
            out.push(Orphan::Reservation { link, body, thing });
        }
    }
    for (&run, fr) in &forms.runs {
        if fr.held.is_some_and(|(_, l)| !held.contains_key(&l)) {
            out.push(Orphan::Run { run, body: fr.body });
        }
    }
    for b in controller.bodies() {
        let Some(claims) = controller.claims(b.id) else {
            continue;
        };
        let fr = forms.by_body.get(&b.id).and_then(|r| forms.runs.get(r));
        let moving = fr
            .and_then(|fr| fr.mv)
            .is_some_and(|n| moves.record(n).is_some());
        for &driver in claims.running().keys() {
            if !(moving || fr.is_some_and(|fr| fr.walk == Some(driver))) {
                out.push(Orphan::Driver { body: b.id, driver });
            }
        }
    }
    out
}

#[cfg(test)]
mod amounts_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod who_tests;
