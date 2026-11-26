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
//!   the body to the thing. A form done on the body itself or on ground marked [`Forms::shared`], or one that only
//!   walks to its thing and waits there ([`only_there`]: a warm by a fire, a bridge's cross), reserves nothing. A
//!   second Soul asking for a reserved thing is refused `thing-reserved`, naming the holder and one next act. A form
//!   that only takes seats (#4575, [`slots_taken`]: a bench's `sit`, a boat's `board`) holds those seats and not its
//!   whole thing, so two Souls sit on one bench at once; the second racing for the same seat is refused
//!   `place-taken`, and a form that holds the whole thing (a carry) and a seat's run refuse each other
//!   `thing-reserved`. A seat's form that also sets a field of its thing (a ride's `under_way`) still holds only its
//!   seats, so four Souls board one balloon at once. The log's reservation link is the same either way. However
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
//! - **Links** (F15, #3385, `links`). A `link` effect writes a K5 link of the kind's type from the actor (its Soul or
//!   its body, as the kind's link is from) to the thing, owned by the thing and seen by everyone; an `unlink` takes
//!   down the thing's own links of that type, the actor's or every one (with none, it changes nothing). Written with the
//!   form's other effects at their instant, all or none: a run that fails before it, or whose other effect is
//!   refused, links nothing.
//!
//! - **Places and links** (C17, #3453). A `sit` (or `lie`) step takes the world's seat by B3's [`Slots`] and B2's sit
//!   or lie move, the gateway's own path: [`World::places`] lends the places table and the floors, a seat's timers fire
//!   through [`Slots::fire`] so its contact hands the body into the slot, and the move's end wakes the run. A walk's
//!   crossings are kept for the caller to carry ([`Forms::crossings`], `crate::host::carry`), so a form walks
//!   indoors across doors and stairs.
//! - **Standing slots** (C33, #3598). A form's hand-off into a standing slot (a phone box's inside, a pool table's
//!   side, a balloon's basket) takes the slot through the same [`Slots`] table, on the body's feet: B2's rise move,
//!   held in the standing stance. A full slot is refused `place-taken`, a slot the world has not placed
//!   `place-unknown`, and the body stays where it stood.
//!
//! - **A run's deadline** (C20, #3469). A run's longest time is its steps' own ([`span`]): each walk's, move's or
//!   sit's deadline as the runner sets it, each pause's length, and room for the tick that wakes each. A run is due
//!   by its start plus that ([`Forms::due`]), so the act it carries out is given the time its walk and its own
//!   duration take, from when it starts.
//!
//! - **Rise and settle** (C25, #3496). A `rise` stands a seated body up by B3's [`Slots::rise`] and the library's rise
//!   move (its end wakes the run), a settled one at once, and is done at once for a body standing. A `settle` claims
//!   the body's legs in a sitting or lying stance where it stands, with no slot; the claim outlives the run, and a
//!   rise or any later claim on the legs (a walk) ends it.
//!
//! Not here: accepting the intent (I4),
//! queueing for a reserved thing (B7), things for several users, a thing made or set down where there is no slot (E4).

pub mod amounts;
mod links;
pub mod stock;

pub use stock::{Stocked, Stocks};

use std::collections::{BTreeMap, BTreeSet};

use replica::audience;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event, Header, Refusal, Rest, read_id,
};
use replica::encode::{Name, Value};
use replica::host::{Progress, Skill};
use replica::ids::{Id, Minter};
use replica::moves::Move;
use replica::pose::Vec3;
use replica::time::Micros;
use replica::tree::Tree;
use replica::who_may::{self, Answer, Who};
use replica::world_model::{Audience, End, plain, show};
use skills::form_runner::{self, Limits, Next, Runner, Step, Woke};

use crate::controller::{Controller, Driver, Part};
use crate::host::{Geometry, Run, Staged, hand_on, lend, step};
use crate::moves::{Fired, Instance, Moves, Reach};
use crate::slots::{PlaceAt, Request, Slots, hands};
use crate::timers::{DueList, Timer};

/// A form's `create` with its kind as the zone's header pins it (`<kind>@<hash>`), the name every other entry gives
/// its kind: an entry naming a kind's plain name is refused (`name-not-pinned`). `None` for any other effect, a kind
/// already pinned, or one the header does not pin (its create is then refused by name, as before).
fn pin_made(header: Option<&Header>, e: &form_runner::Effect) -> Option<form_runner::Effect> {
    let form_runner::Effect::Make { kind, into, set } = e else {
        return None;
    };
    if kind.as_str().contains('@') {
        return None;
    }
    let pinned = header?
        .kinds
        .iter()
        .find(|n| plain(n.as_str()) == kind.as_str())?;
    Some(form_runner::Effect::Make {
        kind: pinned.clone(),
        into: *into,
        set: set.clone(),
    })
}

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
    pub floors: &'a dyn crate::mover::Floors,
}

/// A seat's reach for one body, as the gateway's sit measures it (`worldd`'s bodies): a seat is taken from its stand
/// point and left there (B3), so its contacts are at the stand point ([`PlaceAt::stand`]), measured across x and z
/// from where the body stands (its seat's stand point while it is in one), when it stands on the seat's own floor;
/// from any other floor (the one below or above), and any other target, as `inner` measures it, height and all.
struct SeatReach<'b, R> {
    inner: &'b R,
    body: Id,
    from: Vec3,
    /// The floor the body stands on (its seat's while it is in one).
    on: Option<Id>,
    place: Option<(Id, Vec3, Id)>,
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
        let Some((_, to, _)) = self
            .place
            .filter(|p| p.0 == target && body == self.body && self.on == Some(p.2))
        else {
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
    let (from, on) = c.body(body).map_or((Vec3::ZERO, None), |b| {
        match (b.pose.support, slots.held_place(body)) {
            (replica::pose::Support::Slot, Some(p)) => {
                (at(p).unwrap_or(b.pose.position), Some(p.floor))
            }
            _ => (b.pose.position, Some(crate::walk::node_of(b))),
        }
    });
    SeatReach {
        inner,
        body,
        from,
        on,
        place: place.and_then(|p| Some((p.thing, at(p)?, p.floor))),
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
/// The event of the entry that records a run's move as it starts (B2's record, field 3): observed by viewers only.
const MOVED: &str = "souls:form-move";
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
    /// The seats it reserves in place of its whole thing ([`slots_taken`], #4575): each one's thing and slot. Empty
    /// for a run that reserves its whole thing, or nothing.
    slots_held: Vec<(Id, u64)>,
    /// When the run is due to have ended, world time: its start plus its steps' [`span`] (C20).
    due: Micros,
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

/// A Soul's new act waiting for its own run's posture step to end (#4187), its run number given when it was taken.
struct Waiting {
    run: RunId,
    node: Id,
    intent: Intent,
    steps: Vec<Step>,
    effects: Vec<form_runner::Effect>,
    long: Option<Long>,
    limits: Limits,
}

/// 0.135: the facing a run's body takes when its walk step is done, by [`crate::controller::facing_toward`] (the one
/// rule a walk to a thing keeps too): the way the step's stand point says (its `face`), else toward the walk's point,
/// else (on the point) toward the thing's origin. The node is read as the runner read it (the world's geometry, else
/// the tree), the point in its parent's frame; a body standing in another frame has it carried over through the tree.
/// None for a body in a slot, a node gone, or nothing to turn to.
fn arrival<G: Geometry, R>(w: &World<'_, G, R>, fr: &FormRun) -> Option<replica::pose::Quat> {
    let Some(Step::WalkTo { at, on, face, .. }) = fr.runner.step() else {
        return None;
    };
    let b = w.controller.body(fr.body)?;
    if b.pose.frame.slot.is_some() {
        return None;
    }
    let node = on.unwrap_or(fr.node);
    let (parent, origin) = match w.geometry.read(node) {
        Some(s) => (s.parent?, s.position),
        None => {
            let n = w.tree.node(w.tree.handle(node)?)?;
            (n.parent()?, n.place().map_or(Vec3::ZERO, |p| p.position))
        }
    };
    let frame = b.pose.frame.node;
    let here = |p: Vec3| {
        if parent == frame {
            Some(p)
        } else {
            replica::select::point_in(w.tree, parent, p, frame).ok()
        }
    };
    let add = |a: Vec3, b: Vec3| {
        Vec3::new(
            a.x.saturating_add(b.x),
            a.y.saturating_add(b.y),
            a.z.saturating_add(b.z),
        )
    };
    let point = add(origin, *at);
    let toward =
        |p: Vec3| here(p).and_then(|to| crate::controller::facing_toward(b.pose.position, to));
    match face {
        Some(f) => {
            // the stand point's way, from wherever the walk ended (a body cannot stand there: the nearest place)
            let to = here(add(point, *f))?;
            let from = here(point)?;
            crate::controller::facing_toward(from, to)
        }
        None => toward(point).or_else(|| toward(origin)),
    }
}

/// The seats a form done at `node` reserves in place of its whole thing (#4575), read from the form's entry as bound:
/// each `sit` or `lie` step's slot, and the standing slot a `reparent` of the actor hands it into, on the thing the
/// step names (E14) or `node`. A form reserves only those when taking them is all it does to the thing: every step a
/// walk, a seat taken or left, or a wait, and every effect a link or unlink of the actor's own or a field of the thing
/// set to a value (a ride's `under_way`: riders who set it off together all set it so; a balloon's `ride` holds its
/// rider's place in the basket, never the basket). Any other step or effect (a move or a hand at the thing, a field
/// moved by an amount, an amount, a take or put, a make or removal, a timer, an unlink of everyone's links) or a long
/// form's stages reserves the whole thing, as does a form that takes no seat: a carry takes it into a hand. Empty for
/// those.
fn slots_taken(
    node: Id,
    steps: &[Step],
    effects: &[form_runner::Effect],
    long: bool,
) -> Vec<(Id, u64)> {
    use form_runner::Effect as E;
    let only_seats = !long
        && steps.iter().all(|s| {
            matches!(
                s,
                Step::WalkTo { .. } | Step::Sit { .. } | Step::Rise | Step::Wait(_)
            )
        })
        && effects.iter().all(|e| {
            matches!(
                e,
                E::Link { .. } | E::Unlink { all: false, .. } | E::Set { .. }
            )
        });
    let mut taken: Vec<(Id, u64)> = steps
        .iter()
        .filter_map(|s| match s {
            Step::Sit { slot, on, .. } => Some((on.unwrap_or(node), *slot)),
            _ => None,
        })
        .filter(|_| only_seats)
        .collect();
    taken.sort_unstable();
    taken.dedup();
    taken
}

/// Whether a form with `steps` and `effects` only goes to its thing and stays there a while (a warm by a campfire, a
/// bridge's cross, a building's walk to a room): every step a walk or a wait, no effect and no long form's stages. It
/// moves, seats and changes nothing of the thing, so it reserves nothing there: several Souls warm at one fire at once,
/// and sit on its logs while others warm. Any move, seat, hand or change of the thing reserves as before.
fn only_there(steps: &[Step], effects: &[form_runner::Effect], long: bool) -> bool {
    !long
        && effects.is_empty()
        && steps
            .iter()
            .all(|s| matches!(s, Step::WalkTo { .. } | Step::Wait(_)))
}

/// Whether `step` changes the body's posture (a seat taken or left, a ground posture): a run in one is let finish it.
fn posture(step: &Step) -> bool {
    matches!(step, Step::Sit { .. } | Step::Rise | Step::Settle { .. })
}

/// Every form's run in progress, with the walks they started.
#[derive(Default)]
pub struct Forms {
    runs: BTreeMap<RunId, FormRun>,
    by_body: BTreeMap<Id, RunId>,
    by_timer: BTreeMap<Id, RunId>,
    by_intent: BTreeMap<Id, RunId>,
    walks: Vec<Run>,
    planning: BTreeSet<RunId>,
    last: RunId,
    /// Runs that ended, in order; the caller drains it.
    pub ended: Vec<Ended>,
    /// Runs of acts that waited on a posture step (#4187), started since: the caller drains it and gives each its
    /// deadline and progress answer, as it does a run that starts when taken.
    pub late: Vec<RunId>,
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
    /// Reserved seats, by thing and slot, to the runs that hold each (#4575): a slot of more than one place (E16) is
    /// reserved by as many runs as it has places.
    slot_runs: BTreeMap<(Id, u64), BTreeSet<RunId>>,
    /// Each seat run's own thing, to the seat runs done at it (#4575): held shared, so a whole-thing form, a removal
    /// and F4's in-use check see the run there, while another seat run is not kept from its own seat by it.
    sharing: BTreeMap<Id, BTreeSet<RunId>>,
    /// Nodes a form reserves nothing at: kinds of ground (E21).
    shared: BTreeSet<Id>,
    /// The kinds' amount fields (F4).
    limits: amounts::Limits,
    /// Every kind's state fields, which a made thing's fields are read against (#4104).
    defs: amounts::Defs,
    /// The zone's header, for B4's transfer.
    header: Option<Header>,
    /// The crossings the walks asked for this tick (C17): the caller carries them (`crate::host::carry`) and clears
    /// the list.
    pub crossings: Vec<(Id, Driver, Id, i64)>,
    /// Bodies in a ground posture a `settle` took (C25), with the driver that holds it: a rise ends it, and so does
    /// any later claim on the body's legs (a walk), which stands it up.
    settled: BTreeMap<Id, Driver>,
    /// By body, a Soul's new act waiting for its run's posture step to end (#4187).
    waiting: BTreeMap<Id, Waiting>,
    /// The number of each kind's `posture` field, by the kind's full name: a seat a thing's form takes or leaves
    /// writes it on the body ([`Forms::seat_posture`]).
    postures: BTreeMap<String, u64>,
    /// Runs whose rise ended while the world still carries their body out of the seat (E11d, a climb out): each is
    /// woken by how its move ended once the body stands on the floor ([`Forms::tick`]).
    landing: BTreeMap<RunId, Name>,
    /// The slots each kind declares, by the kind's full name: a slot argument on another thing names one of these
    /// (E14, [`other_slots`]).
    slots_of: BTreeMap<String, BTreeSet<u64>>,
    /// The world's stocked containers (#4837): a `create` of a stock's kind at one gives the made thing its carried
    /// fields ([`Forms::stocks`]).
    stocks: std::sync::Arc<Stocks>,
}

/// Each slot argument on another thing (E14: a lecture's seat on a bench, a collage's patch on a board) is checked as
/// the form's own thing is, before anything starts: the form's entry takes that argument as a `slot` (`arg-type`
/// otherwise); the thing is no body (`slot-of-a-body`: a form never puts into, or seats in, another Soul); it is not
/// private to someone else (#3700's `object.private`, as a bare sit on it is refused); and its kind declares the slot
/// (`slot-unknown`), or the world holds it as a seat.
fn other_slots<G: Geometry, R: Reach>(
    w: &World<'_, G, R>,
    slots_of: &BTreeMap<String, BTreeSet<u64>>,
    body: Id,
    entry: &replica::rules::json::Value,
    form: &str,
    args: &form_runner::Args,
) -> Result<(), Refusal> {
    let refuse = |name, detail: String| Err(Refusal { name, detail });
    let takes = entry
        .get("forms")
        .and_then(|fs| fs.get(form))
        .and_then(|f| f.get("takes"));
    let asker = w
        .tree
        .links_at(body)
        .iter()
        .find(|e| w.tree.ty(e).as_str() == BODY_OF)
        .map_or(body, |e| e.other);
    for (key, arg) in args {
        let &form_runner::Arg::Slot(on, n) = arg else {
            continue;
        };
        let ty = takes
            .and_then(|t| t.get(key))
            .and_then(|t| t.get("type"))
            .and_then(replica::rules::json::Value::str);
        if ty != Some("slot") {
            return refuse(
                "arg-type",
                format!("{key}: the form takes no slot by this name"),
            );
        }
        let a_body = w.controller.body(on).is_some()
            || w.tree
                .links_at(on)
                .iter()
                .any(|e| w.tree.ty(e).as_str() == BODY_OF);
        if a_body {
            return refuse("slot-of-a-body", format!("{key}: {} is a body", show(on)));
        }
        if let Some(words) = replica::who_may::private_to(w.tree, on, asker) {
            return refuse("object.private", format!("{key}: who may: {words}"));
        }
        let held = w
            .places
            .as_ref()
            .is_some_and(|p| p.slots.place_in(on, n).is_some());
        let kind = w
            .tree
            .handle(on)
            .and_then(|h| w.tree.node(h))
            .map(|t| t.kind().as_str().to_owned());
        let declared = kind
            .as_deref()
            .and_then(|k| slots_of.get(k))
            .is_some_and(|s| s.contains(&n));
        if !held && !declared {
            return refuse("slot-unknown", format!("{key}: slot {n} of {}", show(on)));
        }
    }
    Ok(())
}

/// The state field a body's kind keeps its posture in (`stand`, `sit`, `lie`, ...), by name.
const POSTURE: &str = "posture";

/// The claim that holds a settled body's legs and its ground posture (C25, #3496): any later claim on its legs ends
/// it, and the body stands.
fn settled_shape() -> replica::bodies::SkillShape {
    use replica::bodies::{Class, SkillShape, Want};
    SkillShape {
        name: name("souls:settled"),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: vec![],
        cancelled_by: vec![Class::Locomotion],
    }
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

    /// When run `run` is due to have ended, world time (C20): its start plus its steps' [`span`]. `None` once it
    /// ended.
    pub fn due(&self, run: RunId) -> Option<Micros> {
        self.runs.get(&run).map(|r| r.due)
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

    /// Whether intent `intent` is one the forms hold: its run in progress, or its effects applied.
    pub fn known(&self, intent: Id) -> bool {
        self.by_intent.contains_key(&intent) || self.applied.contains_key(&intent)
    }

    /// Marks `node` as ground: a form done there reserves nothing (E21).
    pub fn shared(&mut self, node: Id) {
        self.shared.insert(node);
    }

    /// The body whose run holds thing `thing`, if one does: the whole thing, else shared as a seat run's own thing,
    /// else one of its seats (#4575).
    pub fn holder(&self, thing: Id) -> Option<Id> {
        let run = self
            .reserved
            .get(&thing)
            .or_else(|| self.sharing.get(&thing).and_then(|runs| runs.first()))
            .or_else(|| {
                self.slot_runs
                    .range((thing, 0)..=(thing, u64::MAX))
                    .find_map(|(_, runs)| runs.first())
            })?;
        self.runs.get(run).map(|fr| fr.body)
    }

    /// The bodies whose runs hold the seat of `thing` in `slot` (#4575), by run.
    pub fn seat_holders(&self, thing: Id, slot: u64) -> Vec<Id> {
        self.slot_runs
            .get(&(thing, slot))
            .into_iter()
            .flatten()
            .filter_map(|r| self.runs.get(r).map(|fr| fr.body))
            .collect()
    }

    /// Whether every place of the seat of `thing` in `slot` is held or reserved by someone other than `body`: a body
    /// in it, or another run on its way to it (#4575). A pick of a free seat skips such a seat.
    pub fn seat_taken(&self, slots: &Slots, thing: Id, slot: u64, body: Id) -> bool {
        let most = slots
            .place_in(thing, slot)
            .map_or(1, |p| usize::try_from(p.most()).unwrap_or(usize::MAX));
        let mut taken: BTreeSet<Id> = slots.holders_in(thing, slot).into_iter().collect();
        taken.extend(self.seat_holders(thing, slot));
        taken.remove(&body);
        taken.len() >= most
    }

    /// A body other than `body` whose seat run uses `thing`, if one does: it holds a seat of `thing`, or `thing` is
    /// the run's own (shared, E14's lecture whose `attend` seats on a bench).
    fn other_seat_holder(&self, thing: Id, body: Id) -> Option<Id> {
        self.slot_runs
            .range((thing, 0)..=(thing, u64::MAX))
            .flat_map(|(_, runs)| runs)
            .chain(self.sharing.get(&thing).into_iter().flatten())
            .filter_map(|r| self.runs.get(r).map(|fr| fr.body))
            .find(|b| *b != body)
    }

    /// Frees run `run`'s reservations: its whole thing's, its own thing's shared hold and its seats'.
    fn unreserve(&mut self, run: RunId, held: Option<(Id, Id)>, taken: &[(Id, u64)]) {
        if let Some((thing, _)) = held
            && self.reserved.get(&thing) == Some(&run)
        {
            self.reserved.remove(&thing);
        }
        if let Some((thing, _)) = held
            && let Some(runs) = self.sharing.get_mut(&thing)
        {
            runs.remove(&run);
            if runs.is_empty() {
                self.sharing.remove(&thing);
            }
        }
        for key in taken {
            if let Some(runs) = self.slot_runs.get_mut(key) {
                runs.remove(&run);
                if runs.is_empty() {
                    self.slot_runs.remove(key);
                }
            }
        }
    }

    /// Current form identity for off-clock questions: intent, stage and step.
    pub fn planning_context(&self) -> BTreeMap<Id, (Id, usize, usize)> {
        self.runs
            .values()
            .filter_map(|fr| {
                Some((
                    fr.body,
                    (
                        fr.intent.id,
                        fr.long.as_ref().map_or(0, |l| l.at),
                        fr.runner.at()?,
                    ),
                ))
            })
            .collect()
    }

    /// Each body's run whose step in progress is a walk to a named point (C34, #3599): the step's number, the node the
    /// point is the node's own (the run's, or a thing argument's) and the point's name, so the world can resolve a
    /// building's named area onto its own room and floor before the walk is planned.
    pub fn walks(&self) -> BTreeMap<Id, (usize, Id, Name)> {
        self.runs
            .values()
            .filter_map(|fr| match fr.runner.step()? {
                Step::WalkTo { point, on, .. } => Some((
                    fr.body,
                    (fr.runner.at()?, on.unwrap_or(fr.node), point.clone()),
                )),
                _ => None,
            })
            .collect()
    }

    /// The bodies whose step in progress is a walk that is to be there, not to act from there: no `move`, `sit` or
    /// `lie` comes next. The world may end such a walk to an area anywhere within reach of the area's circle.
    pub fn goal_walks(&self) -> BTreeSet<Id> {
        self.runs
            .values()
            .filter(|fr| {
                matches!(fr.runner.step(), Some(Step::WalkTo { .. }))
                    && !matches!(
                        fr.runner.next_step(),
                        Some(Step::Move { .. } | Step::Sit { .. })
                    )
            })
            .map(|fr| fr.body)
            .collect()
    }

    /// Each body whose step in progress is a walk right before a `move`: the move's name, so the world can end the walk
    /// within that move's own reach of the thing (#4072: a `touch` on a long bench).
    pub fn walk_moves(&self) -> BTreeMap<Id, Name> {
        self.runs
            .values()
            .filter_map(|fr| match (fr.runner.step()?, fr.runner.next_step()?) {
                (Step::WalkTo { .. }, Step::Move { name, .. }) => Some((fr.body, name.clone())),
                _ => None,
            })
            .collect()
    }

    /// The bodies whose run's step in progress is an approach walk, the walk the binding adds before a form's first
    /// move at a point (#3688), so the world can aim it at clear ground on the body's side of that point.
    pub fn approaches(&self) -> std::collections::BTreeSet<Id> {
        self.runs
            .values()
            .filter(|fr| matches!(fr.runner.step(), Some(Step::WalkTo { approach: true, .. })))
            .map(|fr| fr.body)
            .collect()
    }

    /// Each body's run whose step in progress is a walk to its node's own point right before a `sit` or `lie` into a
    /// slot of that node, or a walk to another thing right before a `sit` or `lie` into that thing's slot (E14): the
    /// step's number, the seat's thing and the slot. The world aims that walk at the seat's own stand point, as its
    /// places hold it (moved clear when the entry's point is blocked), not the entry's point.
    pub fn seat_walks(&self) -> BTreeMap<Id, (usize, Id, u64)> {
        self.runs
            .values()
            .filter_map(|fr| match (fr.runner.step()?, fr.runner.next_step()?) {
                (
                    Step::WalkTo { on, .. },
                    Step::Sit {
                        slot, on: place, ..
                    },
                ) if on == place => {
                    Some((fr.body, (fr.runner.at()?, place.unwrap_or(fr.node), *slot)))
                }
                _ => None,
            })
            .collect()
    }

    /// Whether `body` has a run open, or an act waiting for one (#4187).
    pub fn running(&self, body: Id) -> bool {
        self.by_body.contains_key(&body) || self.waiting.contains_key(&body)
    }

    /// Whether form `form` of `node`'s kind `entry` is for those its `who` link names (`who: {link: t}`), takes down
    /// the actor's own link of that type, and `body`'s own run in progress is on `node` and links it so: a swing
    /// walked to and not yet sat in, whose `get_off` is the swinger's. Who may lets that body through ([`Forms::may_or_linking`]): its new act ends the run as any new act
    /// does, so asking to get off on the way stops the swing instead of being refused while it goes on.
    pub fn linking(
        &self,
        body: Id,
        node: Id,
        entry: &replica::rules::json::Value,
        form: &str,
    ) -> bool {
        let f = entry.get("forms").and_then(|fs| fs.get(form));
        let (Some(Who::Link(t)), Some(kind)) = (
            f.and_then(Who::read),
            entry.get("kind").and_then(|k| k.str()),
        ) else {
            return false;
        };
        // Only a way off: a form that takes down the actor's own link of that type (get_off, get_up, leave). Any
        // other form of those the link names (a see-saw's push, a board's page) stays theirs alone.
        let unlinks = f
            .and_then(|f| f.get("effects"))
            .and_then(|e| e.arr())
            .is_some_and(|es| {
                es.iter().any(|e| {
                    e.get("change").and_then(|c| c.str()) == Some("unlink")
                        && e.get("link").and_then(|l| l.str()) == Some(t.as_str())
                        && e.get("from").and_then(|a| a.str()) == Some("actor")
                })
            });
        if !unlinks {
            return false;
        }
        let ty = audience::link_type(kind, &t);
        self.by_body
            .get(&body)
            .and_then(|run| self.runs.get(run))
            .is_some_and(|fr| {
                fr.node == node
                    && fr.effects.iter().any(|e| {
                        matches!(e, form_runner::Effect::Link { ty: l, .. } if l.as_str() == ty)
                    })
            })
    }

    /// [`may`], or yes for a body whose own run on `node` links it as the form's `who` asks ([`Forms::linking`]).
    #[allow(clippy::too_many_arguments)]
    pub fn may_or_linking(
        &self,
        tree: &Tree,
        audiences: &BTreeMap<Id, BTreeSet<Id>>,
        names: &dyn Fn(Id) -> Option<String>,
        body: Id,
        node: Id,
        entry: &replica::rules::json::Value,
        form: &str,
    ) -> Result<(), Refusal> {
        may(tree, audiences, names, body, node, entry, form).or_else(|r| {
            if r.name == "not-permitted" && self.linking(body, node, entry, form) {
                Ok(())
            } else {
                Err(r)
            }
        })
    }

    /// The number of the step in progress of `body`'s run.
    pub fn at(&self, body: Id) -> Option<usize> {
        let run = self.by_body.get(&body)?;
        self.runs.get(run)?.runner.at()
    }

    /// Whether `body`'s run is in a hand step (a `move`, `take`, `put` or `hand` step): one a walk of its own Soul does
    /// not end by its claim on the legs, so the world leaves it (intents rule 10, 0.134 I4).
    pub fn in_hand_move(&self, body: Id) -> bool {
        self.by_body
            .get(&body)
            .and_then(|run| self.runs.get(run))
            .and_then(|fr| fr.runner.step())
            .is_some_and(|s| matches!(s, Step::Move { .. } | Step::Hand))
    }

    /// Whether `body`'s run is in a repeated move (a dance for a while, or held until the Soul's next act).
    pub fn in_repeat(&self, body: Id) -> bool {
        self.by_body
            .get(&body)
            .and_then(|run| self.runs.get(run))
            .and_then(|fr| fr.runner.step())
            .is_some_and(|s| {
                matches!(
                    s,
                    Step::Move {
                        repeat: Some(_),
                        ..
                    }
                )
            })
    }

    /// The Soul on `body` leaves its run: taken at once (`form-not-running` when there is none), and the run ends
    /// `left` at the next stable moment (the runner's rule). When `intent` names the act waiting on that run (#4187),
    /// only the waiting act is left: it ends `left` now and never starts, and the run goes on.
    pub fn leave<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        body: Id,
        intent: Option<Id>,
        now: Micros,
    ) -> Result<(), Refusal> {
        if let Some(p) = self.waiting.get(&body)
            && Some(p.intent.id) == intent
        {
            let run = p.run;
            self.waiting.remove(&body);
            self.ended.push(Ended {
                run,
                body,
                at: now,
                how: name("left"),
            });
            return Ok(());
        }
        let Some(&run) = self.by_body.get(&body) else {
            return Err(Refusal {
                name: "form-not-running",
                detail: show(body),
            });
        };
        self.wake(w, run, Woke::Leave, now);
        Ok(())
    }

    /// The world ends the walk of `body`'s run as `how` (C21, #3484: a walk that stalled, `walk.blocked`): the walk
    /// stops and its driver is released now, and the run ends by the runner's own rule for a walk's ending, in this
    /// tick. Whether the body's run had a walk in progress.
    pub fn stall<G: Geometry, R: Reach>(
        &mut self,
        w: &mut World<'_, G, R>,
        body: Id,
        how: &str,
        now: Micros,
    ) -> bool {
        let Some(&run) = self.by_body.get(&body) else {
            return false;
        };
        let Some(d) = self.runs.get_mut(&run).and_then(|fr| fr.walk.take()) else {
            return false;
        };
        self.walks.retain(|r| r.body != body);
        let _ = w.controller.release(body, d);
        self.wake(w, run, Woke::Walked(Progress::Failed(name(how))), now);
        true
    }

    /// Node `node` was removed (its removal is logged, with every link that ends in it): a run on it as a body ends
    /// `body-gone`, and a run that reserves it ends `thing-gone`. The removal took the reservation with it, so the
    /// ending entry has no unlink.
    pub fn gone<G: Geometry, R: Reach>(&mut self, w: &mut World<'_, G, R>, node: Id, now: Micros) {
        if let Some(p) = self.waiting.remove(&node) {
            self.ended.push(Ended {
                run: p.run,
                body: node,
                at: now,
                how: name("body-gone"),
            });
        }
        // A run that holds a seat of the thing, or holds it shared as its own (#4575), ends with it, as one that
        // holds the whole thing does.
        let seated: BTreeSet<RunId> = self
            .slot_runs
            .range((node, 0)..=(node, u64::MAX))
            .flat_map(|(_, runs)| runs.iter().copied())
            .chain(self.sharing.get(&node).into_iter().flatten().copied())
            .collect();
        let runs = [
            self.by_body.get(&node).map(|r| (*r, "body-gone")),
            self.reserved.get(&node).map(|r| (*r, "thing-gone")),
        ]
        .into_iter()
        .flatten()
        .chain(seated.into_iter().map(|r| (r, "thing-gone")));
        for (run, how) in runs.collect::<Vec<_>>() {
            if let Some(fr) = self.runs.get_mut(&run) {
                // The thing is gone, so the body writes the ending; a seat of another thing (E14) gone leaves the
                // form's own thing and its link standing, so that ending unlinks it as any other does.
                if how == "thing-gone" && fr.node == node {
                    fr.node = fr.body;
                }
                if how == "body-gone" || fr.node == fr.body {
                    let held = fr.held.take();
                    let taken = std::mem::take(&mut fr.slots_held);
                    self.unreserve(run, held, &taken);
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
    /// seen with other contents, `form-running` while the body has a run of another actor in progress (its own Soul's
    /// run is left for the new one, #4187).
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
        self.open(
            w, body, node, intent, steps, effects, None, limits, now, None,
        )
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
            None,
        )
    }

    /// The number of the stage in progress of `body`'s run, when it is a long form's.
    pub fn stage(&self, body: Id) -> Option<usize> {
        let run = self.by_body.get(&body)?;
        self.runs.get(run)?.long.as_ref().map(|l| l.at)
    }

    /// Opens a run once its intent is known to be new: refused `form-running` or `thing-reserved`, else reserved,
    /// started and woken. A Soul's new act preempts its own run in progress (#4187): once nothing else refuses it, the
    /// old run is left now, as a cancel leaves it (`left`, its move cut, its reservation freed), and the new one
    /// starts in the same instant. `form-running` stays for a run of another actor on the body.
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
        given: Option<RunId>,
    ) -> Result<Asked, Refusal> {
        if let Some(p) = self.waiting.get(&body)
            && p.intent.id == intent.id
        {
            return Ok(Asked::Running(p.run));
        }
        let running = self.by_body.get(&body).copied();
        if let Some(old) = running
            && !(matches!(intent.actor, Actor::Soul(_))
                && self
                    .runs
                    .get(&old)
                    .is_some_and(|fr| fr.intent.actor == intent.actor))
        {
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
        // A move on the body itself (a wave, a stretch) is made where it stands: no approach walk to its own point,
        // which a seated body's legs would refuse (`resource-held`, #4143). So is a move on the thing whose seat or
        // standing slot the body is in (a motorboat's key from its helm, a phone box's door from inside it): its legs
        // are the seat's. The move's reach is the world's, from the seat to the point (worldd's `Sight::reach_in_slot`), so
        // a seat out of reach of the point is refused `out-of-reach` (0.135 E13).
        // A form that leaves the body in that slot (no rise or sit of its own, nor the rise the binding adds to a form
        // that moves the actor, `form_runner::rises_out`) is done from inside: its own walks to the thing's points are
        // dropped too (a phone box opened from inside, 0.135 E17), never walked by legs the slot holds.
        let in_its_slot = w.places.as_ref().and_then(|p| p.slots.held_by(body)) == Some(node);
        let stays = in_its_slot
            && !steps
                .iter()
                .any(|s| matches!(s, Step::Rise | Step::Sit { .. }));
        if node == body || in_its_slot {
            steps.retain(|s| match s {
                Step::WalkTo {
                    on: None, approach, ..
                } => !*approach && !stays,
                _ => true,
            });
        }
        // Trial 0.137: a form at another thing by a body a seat, a bed or a standing slot holds (a seated Soul's
        // `take` of a book stack) walks there first, on legs the slot holds, which its hold refused `resource-held`.
        // It rises first instead, by the rise move (as a form that moves the actor does, `rises_out`), as a sit at a
        // seat walks there by itself. A form with a rise, a sit or a settle of its own keeps its steps; a walk the
        // runner would skip (an approach to a hand step's thing already within reach, #4086) needs no rise, so that
        // take is made from the seat.
        let rises_elsewhere = node != body
            && !in_its_slot
            && w.places
                .as_ref()
                .is_some_and(|p| p.slots.held_by(body).is_some())
            && !steps
                .iter()
                .any(|s| matches!(s, Step::Rise | Step::Sit { .. } | Step::Settle { .. }))
            && steps.iter().enumerate().any(|(k, s)| match s {
                Step::WalkTo { approach, .. } => {
                    !(*approach
                        && matches!(steps.get(k + 1), Some(Step::Hand))
                        && w.geometry.within_reach(body, node) == Some(true))
                }
                _ => false,
            });
        if rises_elsewhere {
            steps.insert(0, Step::Rise);
        }
        // A form that would rise the body out of a slot of the node and link it to the node, asked by an actor already
        // linked so (a stage's `step_up` by a Soul on it), is refused before any step, by R2's name: nothing rises or
        // walks for an act whose effect cannot be (0.135 E17). Only on that rise-first path: elsewhere the link effect
        // is as it was.
        let soul = match intent.actor {
            Actor::Soul(s) => s,
            _ => body,
        };
        let rises_first = (in_its_slot && !stays) || rises_elsewhere;
        let mut unlinked: Vec<&Name> = Vec::new();
        for e in effects.iter().filter(|_| rises_first) {
            if let form_runner::Effect::Unlink { ty, .. } = e {
                unlinked.push(ty);
            }
            if let form_runner::Effect::Link { ty, soul: s, .. } = e
                && !unlinked.contains(&ty)
            {
                let end = if *s { soul } else { body };
                if w.tree
                    .links_at(node)
                    .iter()
                    .any(|l| w.tree.ty(l) == ty && l.other == end)
                {
                    return Err(Refusal {
                        name: "already_linked",
                        detail: format!(
                            "{} is already a {} of {}",
                            show(end),
                            ty.as_str(),
                            show(node)
                        ),
                    });
                }
            }
        }
        let reserves = node != body
            && !self.shared.contains(&node)
            && !only_there(&steps, &effects, long.is_some());
        // A form that only takes seats reserves those seats, not its whole thing (#4575): two Souls sit on one bench
        // at once, while a form that moves, carries or changes the thing holds all of it.
        let taken = match reserves {
            true => slots_taken(node, &steps, &effects, long.is_some()),
            false => Vec::new(),
        };
        let reserved = |thing: Id, holder: Id| Refusal {
            name: "thing-reserved",
            detail: format!(
                "{} is held by {}; next: wait until it is free, then ask again",
                show(thing),
                show(holder)
            ),
        };
        // The body's own run, which this act preempts, holds nothing against it.
        let whole_holder = |forms: &Forms, thing: Id| {
            forms
                .reserved
                .get(&thing)
                .and_then(|r| forms.runs.get(r))
                .map(|fr| fr.body)
                .filter(|h| *h != body)
        };
        if reserves
            && taken.is_empty()
            && let Some(holder) =
                whole_holder(self, node).or_else(|| self.other_seat_holder(node, body))
        {
            return Err(reserved(node, holder));
        }
        // A seat run's own thing, held whole by another run (a lecture's `finish` under way), refuses it too.
        if !taken.is_empty()
            && let Some(holder) = whole_holder(self, node)
        {
            return Err(reserved(node, holder));
        }
        for &(thing, slot) in &taken {
            if let Some(holder) = whole_holder(self, thing) {
                return Err(reserved(thing, holder));
            }
            // A seat is taken once another run reserves each of its places (one, or a slot's `most`, E16): the
            // second Soul racing for one seat is refused here, by the seat's own name, and stands where it stood. A
            // seat a body already sits in is the sit step's to refuse, as before.
            let most = w
                .places
                .as_ref()
                .and_then(|p| p.slots.place_in(thing, slot))
                .map_or(1, |p| usize::try_from(p.most()).unwrap_or(usize::MAX));
            let mut taken: BTreeSet<Id> = self.seat_holders(thing, slot).into_iter().collect();
            taken.remove(&body);
            if taken.len() >= most {
                return Err(Refusal {
                    name: "place-taken",
                    detail: format!(
                        "slot {slot} of {} is taken by {}; next: ask for another place, or wait until it is free",
                        show(thing),
                        taken
                            .iter()
                            .map(|b| show(*b))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                });
            }
        }
        if let Some(old) = running {
            // A seat taken or left, or a ground posture, runs to its end first, as a cancel lets it: the body is never
            // left half seated nor moved off a legal path. The new act waits, numbered now, and starts as the old run
            // is left after that step (`wake`); a later act takes its place, and the one it replaces ends `left`.
            if self
                .runs
                .get(&old)
                .and_then(|fr| fr.runner.step())
                .is_some_and(posture)
            {
                self.last += 1;
                let run = self.last;
                let waiting = Waiting {
                    run,
                    node,
                    intent,
                    steps,
                    effects,
                    long,
                    limits,
                };
                if let Some(p) = self.waiting.insert(body, waiting) {
                    self.ended.push(Ended {
                        run: p.run,
                        body,
                        at: now,
                        how: name("left"),
                    });
                }
                return Ok(Asked::Started(run));
            }
            self.finish(w, old, name("left"), now);
        }
        let link = match reserves {
            true => Some(w.mint.mint().map_err(|e| Refusal {
                name: "id-counter-exhausted",
                detail: e.to_string(),
            })?),
            false => None,
        };
        let run = given.unwrap_or_else(|| {
            self.last += 1;
            self.last
        });
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
        if link.is_some() && taken.is_empty() {
            self.reserved.insert(node, run);
        }
        for key in &taken {
            self.slot_runs.entry(*key).or_default().insert(run);
        }
        if link.is_some() && !taken.is_empty() {
            self.sharing.entry(node).or_default().insert(run);
        }
        let due = now.saturating_add(span(&steps, &limits));
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
                slots_held: taken,
                long,
                due,
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
            self.may_or_linking(w.tree, audiences, names, body, node, entry, form)?;
            other_slots(w, &self.slots_of, body, entry, form, args)?;
        }
        match bound {
            Ok((steps, effects)) => self.start(w, body, node, intent, steps, effects, limits, now),
            Err(stages) => self.start_stages(w, body, node, intent, stages, limits, now),
        }
    }

    /// [`other_slots`] for a caller that binds the arguments itself and starts with [`Forms::start`] (worldd's acts,
    /// E14b): each slot argument on another thing is refused by name as [`Forms::commit`] refuses it.
    pub fn other_slots<G: Geometry, R: Reach>(
        &self,
        w: &World<'_, G, R>,
        body: Id,
        entry: &replica::rules::json::Value,
        form: &str,
        args: &form_runner::Args,
    ) -> Result<(), Refusal> {
        other_slots(w, &self.slots_of, body, entry, form, args)
    }

    /// The amount fields of `kinds` (K3's, with their least and capacity), which F4's transfers read, and every
    /// state field, which a made thing's fields are read against (#4104). Called after [`Forms::new`] or
    /// [`Forms::recover`], and again when kinds load.
    pub fn kinds(&mut self, kinds: &replica::kinds::Kinds) {
        self.limits = amounts::limits(kinds);
        self.defs = amounts::defs(kinds);
        self.postures = kinds
            .admits()
            .keys()
            .filter_map(|k| kinds.get(k))
            .filter_map(|def| {
                let (n, _) = def.state.iter().find(|(_, f)| f.name.as_str() == POSTURE)?;
                Some((def.name.as_str().to_owned(), *n))
            })
            .collect();
        self.slots_of = kinds
            .admits()
            .keys()
            .filter_map(|k| kinds.get(k))
            .map(|def| {
                (
                    def.name.as_str().to_owned(),
                    def.slots.keys().copied().collect(),
                )
            })
            .collect();
    }

    /// A seat a thing's form took or left (its sit or lie, or its rise, ended `done`) is written on the body's
    /// `posture` field, when its kind has one: the slot's `sit` or `lie`, or `stand`. A body's own form writes its
    /// posture in its own effects, so nothing is written for it here.
    fn seat_posture(&mut self, tree: &Tree, run: RunId, at: Micros) {
        let Some(fr) = self.runs.get(&run) else {
            return;
        };
        if fr.node == fr.body {
            return;
        }
        let to = match fr.runner.step() {
            Some(Step::Sit {
                lie, stand: false, ..
            }) => {
                if *lie {
                    "lie"
                } else {
                    "sit"
                }
            }
            Some(Step::Rise) => "stand",
            _ => return,
        };
        let kind = tree
            .handle(fr.body)
            .and_then(|h| tree.node(h))
            .map(|n| n.kind().as_str().to_owned());
        let Some(&field) = kind.as_deref().and_then(|k| self.postures.get(k)) else {
            return;
        };
        self.out.push(Effect {
            envelope: Envelope {
                sequence: 0,
                at,
                cause: Cause::Intent(fr.intent.id),
                actor: fr.intent.actor,
                audience: Audience::Everyone,
                node: fr.body,
            },
            body: Body::Changes(vec![ChangeRec {
                change: Change::Set {
                    node: fr.body,
                    field,
                    to: Value::Text(name(to)),
                    by: None,
                },
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        });
    }

    /// The zone's header, which B4's transfer (a take or a put) writes under.
    pub fn zone(&mut self, header: Header) {
        self.header = Some(header);
    }

    /// The world's stocked containers (#4837, [`stock`]): a `create` of a stock's kind at one of them gives the made
    /// thing the fields of the row at the top of its pile. Called after [`Forms::new`] or [`Forms::recover`].
    pub fn stocks(&mut self, stocks: std::sync::Arc<Stocks>) {
        self.stocks = stocks;
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
        // A thing another run holds a seat of, or holds shared as its seat run's own (#4575), is in use as one it
        // holds whole is.
        let reserved: Vec<Id> = self
            .reserved
            .iter()
            .filter(|(_, r)| **r != run)
            .map(|(t, _)| *t)
            .chain(
                self.slot_runs
                    .iter()
                    .filter(|(_, rs)| rs.iter().any(|r| *r != run))
                    .map(|((t, _), _)| *t),
            )
            .chain(
                self.sharing
                    .iter()
                    .filter(|(_, rs)| rs.iter().any(|r| *r != run))
                    .map(|(t, _)| *t),
            )
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
                defs: &self.defs,
                header: self.header.as_ref(),
                body: fr.body,
                soul: match fr.intent.actor {
                    Actor::Soul(s) => s,
                    _ => fr.body,
                },
                hands: &hands,
                node: fr.node,
                reserved: &reserved,
                now: at,
                stocks: &self.stocks,
            };
            let made = pin_made(self.header.as_ref(), e);
            let entries = match cx.entries(mint, made.as_ref().unwrap_or(e)) {
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
        // A run a new act waits on is left once its posture step is done (#4187).
        if !matches!(next, Next::End(_))
            && let Some(fr) = self.runs.get(&run)
            && self.waiting.contains_key(&fr.body)
            && !fr.runner.step().is_some_and(posture)
        {
            return self.finish(w, run, name("left"), now);
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
        // The route claim a plan was awaited with (`Next::Planning`) belongs to the walk: a step that is not a walk
        // (an approach with no way goes straight to its move) gives it back, so a Soul's own walk during that move
        // leaves the run at the move's phase end, as rule 10 says, and a move that moves the body is not its own rival
        // (S11 review).
        if !matches!(next, Next::Walk(_) | Next::Planning | Next::Sleep)
            && !self.walks.iter().any(|r| r.body == body)
            && let Some(d) = fr.walk.take()
        {
            let _ = w.controller.release(body, d);
        }
        match next {
            Next::Sleep => {}
            Next::Planning => {
                // Claim the same walk resources at the original step start. An older walk is cancelled/neutralized
                // now, so it cannot keep moving the sampled body while this form awaits its plan.
                if fr.walk.is_none() {
                    match w
                        .controller
                        .claim(body, &skills::route::Route::sent(0, 0).shape())
                    {
                        Ok(driver) => fr.walk = Some(driver),
                        Err(r) => return self.finish(w, run, name(r.name), now),
                    }
                }
                self.planning.insert(run);
            }
            Next::End(how) if long && how.as_str() == "done" => self.stage_done(w, run, now),
            Next::End(how) => self.finish(w, run, how, now),
            Next::Walk(skill) => match fr
                .walk
                .take()
                .map_or_else(|| w.controller.claim(body, &skill.shape()), Ok)
            {
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
            // A standing slot (C33, #3598) is taken by the same hand-off on the body's feet: B2's rise move (the body
            // stays upright; its contact hands it into the slot) held in the standing stance.
            Next::Sit {
                node,
                slot,
                lie,
                stand,
            } => {
                let mv = name(match (stand, lie) {
                    (true, _) => "souls:rise",
                    (false, true) => "souls:lie",
                    (false, false) => "souls:sit",
                });
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
                    stance: match (stand, lie) {
                        (true, _) => crate::controller::Stance::Stand,
                        (false, true) => crate::controller::Stance::Lie,
                        (false, false) => crate::controller::Stance::Sit,
                    },
                };
                let taken = places
                    .slots
                    .commit(
                        w.controller,
                        w.due,
                        w.mint,
                        w.moves,
                        &geo,
                        places.floors,
                        &[request],
                        now,
                    )
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
            // A ground posture where the body stands (C25, SA-G3): its legs held in that stance until a rise or a walk.
            Next::Settle { lie } => {
                let stance = if lie {
                    crate::controller::Stance::Lie
                } else {
                    crate::controller::Stance::Sit
                };
                if let Some(d) = self.settled.remove(&body) {
                    let _ = w.controller.release(body, d);
                }
                let held = w.controller.claim(body, &settled_shape()).and_then(|d| {
                    w.controller
                        .set(body, d, crate::controller::Part::Stance(stance))
                        .map(|()| d)
                });
                match held {
                    Ok(d) => {
                        self.settled.insert(body, d);
                        self.wake(w, run, Woke::Moved(name("done")), now);
                    }
                    Err(r) => self.wake(w, run, Woke::Moved(name(r.name)), now),
                }
            }
            // Out of a seat by B3's rise (its end wakes the run, [`Forms::fire`]); up from a ground posture, or a body
            // standing, at once (C25).
            Next::Rise => {
                let seated = w.places.as_ref().and_then(|p| p.slots.held_by(body));
                // A body in a seat rises from it (0.135 E21): a ground posture it settled into before was ended by the
                // walk to the seat, which claimed its legs, so the record of it is dropped, not released.
                if let Some(d) = self.settled.remove(&body)
                    && seated.is_none()
                {
                    let _ = w.controller.release(body, d);
                    return self.wake(w, run, Woke::Moved(name("done")), now);
                }
                let Some(_) = seated else {
                    return self.wake(w, run, Woke::Moved(name("done")), now);
                };
                let (Some(found), Some(places)) = (
                    w.library.iter().find(|m| m.name.as_str() == "souls:rise"),
                    w.places.as_mut(),
                ) else {
                    return self.wake(w, run, Woke::Moved(name("move-unknown")), now);
                };
                let geo = seat_reach(
                    w.reach,
                    w.controller,
                    places.slots,
                    body,
                    places.slots.held_place(body),
                );
                match places.slots.rise(
                    w.controller,
                    w.due,
                    w.mint,
                    w.moves,
                    &geo,
                    body,
                    found,
                    now,
                ) {
                    Ok(n) => fr.mv = Some(n),
                    Err(r) => self.wake(w, run, Woke::Moved(name(r.name)), now),
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
                // A move made from a seat (`Move::seated`: a stretch, a slump) by a body in a seat, a bed or a standing
                // slot leaves its legs where the slot holds them (#4143): it neither claims nor blocks them, which the
                // slot's hold would refuse `resource-held` while the client's form rules say yes. Every other move (a
                // jump, a dance, a bow) still claims the legs, and the seat's hold refuses it: a gateway sit writes no
                // `posture`, so a form's posture need alone would let it play through the seat.
                if found.seated
                    && w.places
                        .as_ref()
                        .is_some_and(|p| p.slots.held_by(body).is_some())
                {
                    use replica::bodies::{Class, Want};
                    found.claims.retain(|c| {
                        !matches!(
                            c,
                            Want::All(Class::Locomotion) | Want::One(Class::Locomotion)
                        )
                    });
                    found.blocks.retain(|c| *c != Class::Locomotion);
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
                    Ok(n) => {
                        fr.mv = Some(n);
                        // A repeated move (a dance for a minute) is a record for viewers at its first move and again
                        // every `REWRITE_US` (a viewer who comes in mid-dance draws it from the next), each planned to
                        // the latest its step can end (its start, its length and one more move); the other repeats
                        // write nothing, and the run's end (`souls:form-ended`) is where it stopped (0.135).
                        let repeat = fr.runner.repeat();
                        if let Some(r) = w
                            .moves
                            .record(n)
                            .filter(|_| !repeat.is_some_and(|(_, _, again)| again))
                        {
                            let mut r = r.clone();
                            let one = r.ends.last().map_or(0, |l| l.saturating_sub(r.start));
                            if let (Some((since, length, _)), Some(last)) =
                                (repeat, r.ends.last_mut())
                            {
                                *last = since.saturating_add(length).saturating_add(one);
                            }
                            if let Some(t) = w.reach.aimed(body, &r.contact) {
                                r.target = t;
                            }
                            let o = Open {
                                run,
                                body,
                                node: fr.node,
                                intent: fr.intent.id,
                                actor: fr.intent.actor,
                                link: None,
                            };
                            let fields = BTreeMap::from([
                                (1, Value::Uint(run)),
                                (2, body.to_value()),
                                (3, as_bytes(r.to_value())),
                            ]);
                            self.out
                                .push(entry(&o, now, Vec::new(), name(MOVED), fields));
                        }
                    }
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
        self.planning.remove(&run);
        self.landing.remove(&run);
        let Some(fr) = self.runs.get_mut(&run) else {
            return;
        };
        let body = fr.body;
        if let Some(d) = fr.walk.take() {
            self.walks.retain(|r| r.body != body);
            let _ = w.controller.release(body, d);
        }
        // A seat's move ends through the places (E11b), as a cancel under it does in `Slots::fire`: a sit not yet in
        // the slot gives the seat back, a body in the slot is left seated, never half sat with its seat held.
        if let Some(n) = fr.mv.take() {
            let sitting = matches!(fr.runner.step(), Some(Step::Sit { .. }));
            let held = w.places.as_mut().and_then(|p| {
                p.slots.cancel(
                    w.controller,
                    w.due,
                    w.moves,
                    p.floors,
                    body,
                    n,
                    now,
                    name("form-ended"),
                )
            });
            match held {
                Some(true) if sitting => self.seat_posture(w.tree, run, now),
                Some(_) => {}
                None => {
                    w.moves
                        .cancel(w.controller, w.due, n, now, name("form-ended"));
                }
            }
        }
        let Some(fr) = self.runs.remove(&run) else {
            return;
        };
        self.by_body.remove(&fr.body);
        self.by_intent.remove(&fr.intent.id);
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
        self.unreserve(run, fr.held, &fr.slots_held);
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
        if let Some(p) = self.waiting.remove(&fr.body) {
            let (body, run) = (fr.body, p.run);
            let opened = self.open(
                w,
                body,
                p.node,
                p.intent,
                p.steps,
                p.effects,
                p.long,
                p.limits,
                now,
                Some(run),
            );
            match opened {
                Ok(_) => self.late.push(run),
                Err(r) => self.ended.push(Ended {
                    run,
                    body,
                    at: now,
                    how: name(r.name),
                }),
            }
        }
    }

    /// The tick's part for forms: the walks runs started are stepped with the host, their inputs handed on to the
    /// controller, and a walk that ended wakes its run. With no walk in progress it does nothing.
    pub fn tick<G: Geometry, R: Reach>(&mut self, w: &mut World<'_, G, R>, now: Micros) {
        self.forget(now);
        for run in std::mem::take(&mut self.planning) {
            let cancelled = self.runs.get(&run).is_some_and(|fr| {
                fr.walk.is_some_and(|driver| {
                    !w.controller
                        .claims(fr.body)
                        .is_some_and(|c| c.running().contains_key(&driver))
                })
            });
            if cancelled {
                self.finish(w, run, name("claim-taken"), now);
                continue;
            }
            self.wake(w, run, Woke::Planning, now);
        }
        let landed: Vec<RunId> = self
            .landing
            .keys()
            .filter(|run| {
                self.runs
                    .get(run)
                    .is_none_or(|fr| !w.controller.carried(fr.body))
            })
            .copied()
            .collect();
        for run in landed {
            if let Some(how) = self.landing.remove(&run)
                && self.runs.contains_key(&run)
            {
                self.wake(w, run, Woke::Moved(how), now);
            }
        }
        // A run whose walk is running (an entry in the walks) and lost its claim on the legs (its Soul's own walk took
        // them, intents rule 10) ends `claim-taken`, as one waiting for its plan does (S11): its walk's inputs went
        // nowhere, it asked no way, so C21's watch never saw it, and the run stood at its walk step, its act never
        // answered. A run in any other step holds no route claim (`handle` gives it back), so a move in progress is
        // left at its phase end instead.
        let walking: BTreeSet<Id> = self.walks.iter().map(|r| r.body).collect();
        let lost: Vec<RunId> = self
            .runs
            .iter()
            .filter(|(run, fr)| {
                !self.planning.contains(run)
                    && walking.contains(&fr.body)
                    && fr.walk.is_some_and(|driver| {
                        !w.controller
                            .claims(fr.body)
                            .is_some_and(|c| c.running().contains_key(&driver))
                    })
            })
            .map(|(run, _)| *run)
            .collect();
        for run in lost {
            self.finish(w, run, name("claim-taken"), now);
        }
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
                // 0.135: there, it turns the way its stand point says (or to the point, or the thing), by the walk's
                // own driver of its legs, before it lets them go
                if p == Progress::Done
                    && let Some(q) = arrival(w, fr)
                {
                    let _ = w.controller.set(body, d, Part::Facing(q));
                }
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
                    .map(|(f, h)| (f, h.and_then(Result::err)))
            }
            _ => w
                .moves
                .fire(w.controller, w.due, w.mint, w.reach, t)
                .map(|f| (f, None)),
        };
        if let Some((f, refused)) = fired {
            match f {
                Fired::Done(rec) | Fired::Cancelled(rec) => {
                    if let Some(&run) = self.by_body.get(&rec.body)
                        && let Some(fr) = self.runs.get_mut(&run)
                        && fr.mv.take().is_some()
                    {
                        let how = rec.ended.map_or_else(|| name("done"), |e| e.how);
                        if how.as_str() == "done" {
                            self.seat_posture(w.tree, run, t.due);
                        }
                        if how.as_str() == "done" && w.controller.carried(rec.body) {
                            // A rise that climbs out (E11d): its run goes on once the body stands on the floor.
                            self.landing.insert(run, how);
                        } else {
                            self.wake(w, run, Woke::Moved(how), t.due);
                        }
                    }
                }
                // Phase 1 begins at the contact instant (B2). A hand-off the places refused there (a rise with no
                // floor to stand on, a sit the slot would not take) cancelled the move: its run ends now by the
                // refusal's name (E11c), not at its deadline waiting on a move that is gone.
                Fired::Phase { instance, phase: 1 } => {
                    if let Some(&run) = self.by_body.get(&t.node)
                        && let Some(fr) = self.runs.get_mut(&run)
                        && fr.mv == Some(instance)
                    {
                        match refused {
                            Some(r) => {
                                fr.mv = None;
                                self.wake(w, run, Woke::Moved(name(r.name)), t.due);
                            }
                            None => self.wake(w, run, Woke::Contact, t.due),
                        }
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

/// The longest a run of `steps` takes under `limits`, µs (C20, #3469): each step's own deadline as the runner sets it
/// (a walk's [`Limits::walk`], a move's or a sit's [`Limits::step_move`]), each pause's length, and two ticks for each
/// step and the run's end, for the wakes that end them. A run the runner leaves running ends by its own name before
/// then (`deadline-passed`, or its walk's or move's ending).
pub fn span(steps: &[Step], limits: &Limits) -> Micros {
    let wakes = i64::try_from(steps.len())
        .unwrap_or(i64::MAX)
        .saturating_add(1)
        .saturating_mul(limits.tick.saturating_mul(2));
    steps
        .iter()
        .map(|s| match s {
            Step::WalkTo { .. } => limits.walk,
            // A repeated move (a dance for a minute) runs its length and its last move past it.
            Step::Move {
                repeat: Some(r), ..
            } => r.saturating_add(limits.step_move),
            Step::Move { .. } | Step::Sit { .. } | Step::Rise | Step::Settle { .. } => {
                limits.step_move
            }
            Step::Wait(us) => *us,
            Step::Hand | Step::UseHeld => 0,
        })
        .fold(wakes, i64::saturating_add)
}

/// The type of a body's link to its Soul (contract T2).
const BODY_OF: &str = "souls:body-of";
/// A Soul's body's kind (plain): a thing whose parent is one is in its hand.
const BODY: &str = "souls:body";

/// Who may, on the world's side (F6): whether `body` may do form `form` of `entry` at `node`, as the tree stands. The
/// test is [`who_may::test`], the client's own. The actor's Soul is the far end of the body's `souls:body-of` link,
/// and the asker is that Soul (or the body, with none). The thing's links of the rule's type are read whatever their
/// audience; the refusal names their ends only when the asker is a member of every one's audience (`audiences`, as
/// resolved when written), and otherwise names the group alone. A refusal never holds an account id: ends are Soul or
/// body ids, named by `names` (the directory's names), else shown as ids. Refused: `form-unknown`, `who-unknown` (a
/// `who` outside the closed list), `object.private` (a private thing not the asker's, #3700), `not-permitted` with the
/// sentence. For `who: holder`, the holder is a body with the thing in a hand, or a body seated in a vehicle's drive
/// seat ([`drives`]) while no body carries it: a rider steers, a passenger does not, and there is never a second holder.
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
    // #3700: a private thing (its own mark, or its nearest marked ancestor's) is its owner's alone, whatever its form.
    if let Some(words) = replica::who_may::private_to(tree, node, asker) {
        return refuse("object.private", format!("who may: {words}"));
    }
    let thing = tree.handle(node).and_then(|h| tree.node(h));
    // One holder (E10b): a thing whose parent is a body is in that body's hand and is its alone, so a body seated in
    // its drive seat while someone carries it does not hold it too, and the carrier can always put it down.
    let parent = thing.as_ref().and_then(|n| n.parent());
    let carried = parent
        .and_then(|p| tree.handle(p))
        .and_then(|h| tree.node(h))
        .is_some_and(|p| plain(p.kind().as_str()) == BODY);
    let holds = parent == Some(body) || (!carried && drives(tree, body, node, entry));
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

/// `body` sits in `node`'s drive seat (SA-F14, E10): its entry's `vehicle.drive` names one body slot, and a body held
/// there is the vehicle's holder for `who: holder`, as a thing in a hand is held. Every other body slot is a
/// passenger's and does not count. Slots are numbered from 1 in the entry's order, as their places are registered
/// (`import_eden::body_slots_of`), and a seated body is the thing's child in that slot.
fn drives(tree: &Tree, body: Id, node: Id, entry: &replica::rules::json::Value) -> bool {
    use replica::rules::json::Value as J;
    let Some(drive) = entry
        .get("vehicle")
        .and_then(|v| v.get("drive"))
        .and_then(J::str)
    else {
        return false;
    };
    let slots = entry.get("slots").and_then(J::obj).unwrap_or(&[]);
    let Some(slot) = (1u64..)
        .zip(slots)
        .find(|(_, (s, _))| s == drive)
        .map(|(n, _)| n)
    else {
        return false;
    };
    tree.handle(body)
        .and_then(|h| tree.node(h))
        .is_some_and(|b| b.parent() == Some(node) && b.slot() == Some(slot))
}

/// `v` with every text as bytes: a move record's names (a contact point such as `grip`) need not be namespaced, and an
/// entry's texts must be (rule 10), so the record goes out as `souls:act-ended`'s how does (#3741).
fn as_bytes(v: Value) -> Value {
    match v {
        Value::Text(t) => Value::Bytes(t.as_str().as_bytes().to_vec()),
        Value::Array(a) => Value::Array(a.into_iter().map(as_bytes).collect()),
        Value::Map(m) => Value::Map(m.into_iter().map(|(k, v)| (k, as_bytes(v))).collect()),
        v => v,
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
    // A run holds its link's thing whole, or shared with the seats it reserves (#4575).
    let holds = |fr: &FormRun, run: RunId, thing: Id| match fr.slots_held.is_empty() {
        true => forms.reserved.get(&thing) == Some(&run),
        false => {
            forms
                .sharing
                .get(&thing)
                .is_some_and(|rs| rs.contains(&run))
                && fr
                    .slots_held
                    .iter()
                    .all(|k| forms.slot_runs.get(k).is_some_and(|rs| rs.contains(&run)))
        }
    };
    let by_link: BTreeMap<Id, RunId> = forms
        .runs
        .iter()
        .filter_map(|(r, fr)| fr.held.map(|(_, l)| (l, *r)))
        .collect();
    for (&link, &[body, thing]) in &held {
        let ok = by_link.get(&link).is_some_and(|r| {
            forms.runs.get(r).is_some_and(|fr| {
                fr.held == Some((thing, link)) && fr.body == body && holds(fr, *r, thing)
            })
        });
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
mod links_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod who_tests;
