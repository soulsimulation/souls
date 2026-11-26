//! The form runner (Engine v2 F1, #2766): one skill that carries out any form's steps from data. A form is the data
//! description of an act (`souls-entry/1`, read as R2's JSON, `replica::rules::json`); no code here names a kind, a
//! form or a move.
//!
//! - **Bound once.** [`bind`] turns a form's steps into a closed list of [`Step`]s, all or none, before the run
//!   starts: a step kind not in the list is refused by name (`step-unknown`), as is a point the kind does not declare
//!   (`point-unknown`). The node the form is done at may be a thing, a body or a kind of ground (E21): the runner only
//!   reads its position.
//! - **A cursor over the steps.** A step starts a walk (N7's walk skill, [`crate::route::Route`]) or a move (B2's,
//!   started by the world on the runner's request, [`Next::Move`]), or sets a timer for a pause, and then sleeps. The
//!   world wakes it ([`Runner::wake`]) only when that ends or a timer of its own fires: nothing polls, so a step in
//!   progress costs no tick.
//! - **A wait is a pause of a fixed length**, in microseconds of world time: never a wait for a time of day or a
//!   condition (T10). Its timer is its deadline.
//! - **Every step has a deadline**, a timer the runner sets when the step starts ([`Limits`]); passing it ends the run
//!   `deadline-passed`. Timers are keyed by run: the runner holds its own timer's id, and a wake by any other id (an
//!   old timer, a finished run) changes nothing.
//! - **The runner owns ending.** Every run ends with a name ([`Next::End`]): `done`, `deadline-passed`, or the name the
//!   walk or the move ended with (`out-of-reach`, `claim-taken`, ...). A form writes no exit.
//!
//! - **The effect's instant** (F2, #2767). The effect lands once, at the contact instant of the form's hand step (its
//!   last step, when that is a `move`, `take`, `put`, `sit` or `use_held` step, or a `sit` or `lie` followed only by
//!   waits, whose posture outlives the run: the world wakes the runner with [`Woke::Contact`] when that move's
//!   start-up ends), or, in any other form whose last step is not a hand step (a move then a wait, a repeated move
//!   then a rise), when the last step ends (E7). The runner only says when
//!   ([`Runner::take_effect`]); the world writes the effect, keyed by intent, and never twice (`sim::forms`). Stopped
//!   before that instant, a run has no effect, so a Soul that leaves during a later step (a wait, the next of several
//!   moves) gets none; stopped after, its effect stays. [`bind_effects`] binds a form's effects as generic sets, one
//!   field each.
//!
//! - **Leaving** (F3, #2768). The Soul's leave ([`Woke::Leave`]) is taken at once and ends the run `left` at the next
//!   stable moment: at once during a walk or a pause, and during a move at its next phase boundary (its contact or its
//!   end, within the step's deadline). A run left before its effect's instant has no effect.
//!
//! - **Amounts, take and put, make and remove** (F4, #2769). [`bind_effects_with`] binds a form's effects with its
//!   thing arguments: a `transfer` of an amount between two things ([`Effect::Transfer`]), a thing made into a hand or
//!   a slot ([`Effect::Make`]) and a thing removed ([`Effect::Remove`]). A `take` or `put` step is a hand step: it runs
//!   its move like a `move` step, and its contact is the instant of B4's transfer of the thing into a free hand or into
//!   a slot of the node ([`Effect::Take`], [`Effect::Put`]). The world works each out against the tree (`sim::forms`).
//!
//! - **Links** (F15, #3385). A `link` effect is a K5 link of the kind's link type from the actor (its Soul when the
//!   kind's link is `from: soul`, else its body) to the node, seen by everyone ([`Effect::Link`]); an `unlink` takes down the node's own
//!   links of that type, the actor's or every one ([`Effect::Unlink`]). They land at the effect's instant with the
//!   form's other effects, all or none.
//!
//! - **Arguments, names and declared points** (F14, #3384). [`bind_with`] and [`bind_effects_args`] bind a form with
//!   its act's arguments ([`Args`]): a step may aim at a name argument (a point, slot or area of the kind) or at a
//!   thing argument, whose place is read when the step starts; a `set` may write an `enum` value by name, and through
//!   an argument a value, a thing's id or words' reference (`{21: id}`, K16), to a field named or chosen by a field
//!   argument. A step's point is a point, a slot (its stand point, else its place) or a placed area; [`check`] refuses
//!   a form that names any other at import (`point-unknown`).
//!
//! - **Eden's own entries** (C12, #3427). A slot argument may come as the slot's number ([`bind_in`],
//!   [`bind_effects_in`]); a `put` may name its slot by argument; and a bare `take` or `put` moves the thing its form's
//!   `reparent` effect names.
//!
//! - **The hatch** (F8, #2823). A form whose rule data cannot express carries one pure function, named by its module's
//!   hash ([`bind_hatch`]); [`run_hatch`] runs it on its declared reads in `replica`'s one interpreter, so the world,
//!   the daemon and a page give the same verdict at the same counted steps. A hatch may answer several fields (a
//!   board's pieces, whose turn, the phase): with a yes, their new values, checked against their definitions.
//!
//! - **Turned things** (C13, #3440). A kind's points are in its own axes; the world turns a run's walk points by the
//!   node's orientation in the tree before the run starts ([`turn`]), so a thing turned 90 degrees is walked to on its
//!   turned front.
//!
//! - **No room at the point** (C15, #3447). A point a body cannot stand on (a chair's front under its table, a grip
//!   inside the thing, a bed's side against a wall) is walked to from the nearest place within [`REACH`] of it where a
//!   body may stand, as the world chooses it (`Host::stand_near`, N9's spot tables); with none, the walk to the point
//!   itself ends `souls:no-way`.
//!
//! - **Seats and indoors** (C17, #3453). A `sit` step (or a `lie`, or a `sit` into a slot whose posture is `lie`)
//!   asks the world to take the node's seat by B2's sit or lie move ([`Next::Sit`]), the gateway's own path; its
//!   contact is the effect's instant, and the form's `reparent` of the actor into that slot is the step's hand-off.
//!   A `walk_to` asks the world for its legs ([`Host::legs`]): the point carried onto the floor a body stands on and
//!   the route there across doors and stairs; before a sit, to a place within [`SIT_REACH`] of the stand point.
//!
//! - **Every step shape** (C25, #3496). A form with no steps lands its effects at once and ends `done`. A `walk_to`
//!   may name a thing or part argument as its point ([`bind_in`] takes the act's thing arguments too). A `rise` asks
//!   the world to stand the body up ([`Next::Rise`]): out of its seat by B3's rise, the form's `reparent` of the actor
//!   to `here` being its hand-off; from a ground posture; at once for a body already standing. A `settle` asks for a
//!   ground posture where the body stands ([`Next::Settle`]). A `use_held` is a hand step on the thing the body holds,
//!   ended `not-held` when it holds none.
//! - **Every effect content uses** (C24, #3495). A `timer` starts a form of the node later ([`Effect::Timer`]); a
//!   `set` with a `rate` writes a timed field's three numbers ([`Effect::Timed`]); a link has its kind's `most`; a
//!   set's value is checked against its field (`out-of-range`, `not-allowed`) and an enum's value is written as a
//!   name in the kind's namespace; a `reparent` no step carries is a take or a put of a thing, or the actor staying
//!   `here` ([`Effect::Here`]). A body goes into a seat only by a `sit` or `lie` step (`body-moves-by-step`).
//! - **Standing slots** (C33, #3598). A `reparent` of the actor into a slot that admits a body and names no posture is
//!   the body's hand-off into it on its feet, through the same seat hand-off as a sit ([`Step::Sit`] with `stand`,
//!   added after the form's steps); a `reparent` of the actor `here` with no `rise` hands it out by a rise first.
//!
//! Not here: who may (F6), stages of long forms (F11), a thing made or set down where there is no slot (E4).

use std::collections::BTreeMap;

use replica::effects::Refusal;
use replica::encode::{self, Name};
use replica::hatch::Loaded;
use replica::host::{Answers, Hatch, Host, Progress, Read, Skill};
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::rules::json::Value;
use replica::time::Micros;

use crate::route::{Leg, Route};

#[cfg(test)]
mod reach_tests;

/// One step of a form, bound. The closed list is SA-F1's (`walk_to`, `sit`, `rise`, `move`, `take`, `put`,
/// `use_held`, `wait`, `settle`), every one built (C25, #3496): F4's `take` and `put` are bound as a `move` (their
/// transfer is an effect, [`Effect::Take`] and [`Effect::Put`]), or as a [`Step::Hand`] when they name no move.
///
/// Where a step aims (F14, #3384): a name the kind declares (a point, a slot's stand point or its place, or a placed
/// area), the same through a name argument (`{"arg": ...}` of type `part`, `slot` or `field`), or a thing argument
/// (`on`), whose place the runner reads when the step starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Walk to a point of the node (or of thing `on`), µm in its frame. An `approach` is the walk the binding adds
    /// before a form's first move at a point ([`approach`]): when the world finds no way, the move is tried from where
    /// the body stands.
    WalkTo {
        point: Name,
        at: Vec3,
        on: Option<Id>,
        approach: bool,
        /// The way the body faces once there (0.135): its stand point's `yaw_mdeg` turning the node's +z, 1 m long,
        /// in the node's axes and turned with `at` ([`turn`]). None: toward the point, or the thing's origin for a
        /// body standing on the point (the world's turn, `sim::forms`).
        face: Option<Vec3>,
    },
    /// A move by name toward a point of the node (or of thing `on`); with no point, the move's own contact. With
    /// `repeat`, µs, the move starts again as each ends, with no pause, until that long has passed since the step
    /// began: the last whole move ends the step (a dance for a minute, [`for_us`]).
    Move {
        name: Name,
        at: Option<Name>,
        on: Option<Id>,
        repeat: Option<Micros>,
    },
    /// A `take` or `put` that names no move: a hand step whose contact is its start.
    Hand,
    /// A pause of a fixed length, µs.
    Wait(Micros),
    /// Sit, or lie, in slot `slot` of the node (C17), or of thing `on` (a slot argument on another thing, E14): B3's
    /// seat taken by B2's sit or lie move, as the gateway's sit takes it. It lies when the slot's posture is `lie` or
    /// the step is a `lie` (for a slot of another thing, when the step is a `lie`). With `stand`, the body is handed
    /// into a standing slot on its feet by the same hand-off (C33, #3598): no form writes this step, the binding adds
    /// it for a form's `reparent` of the actor into a standing slot ([`bind_with`]).
    Sit {
        slot: u64,
        lie: bool,
        stand: bool,
        on: Option<Id>,
    },
    /// Rise (C25, #3496): out of the body's seat by B3's rise, onto its stand point; up from a ground posture a
    /// `settle` took; nothing for a body already standing, as today's `stand` is. The form's `reparent` of the actor
    /// to `here` is the rise's own hand-off.
    Rise,
    /// Settle (C25, SA-G3): a ground posture, sitting or lying, taken where the body stands, with no slot. It holds
    /// until a rise or the body's next walk.
    Settle { lie: bool },
    /// Use the thing the form is done at, held in the body's hand (C25): a hand step with no move of its own, at once;
    /// `not-held` when the body does not hold it.
    UseHeld,
}

/// How far from a point a walk to it may end, µm, when a body cannot stand on the point itself (C15, #3447): an arm
/// (the longest reach a move may state) and a body, as today's engine counts a stand point's reach.
pub const REACH: i64 = replica::moves::REACH_MOST + 600_000;

/// How far from its aim the place an approach walk ([`approach`]) goes to may be, µm: an arm, a move's usual reach
/// (`content/moves`), as today's game looks for clear ground about the hand's point.
pub const APPROACH_REACH: i64 = 600_000;

/// How far short of the move's point, toward the body, the world aims an approach walk when the point lies on the
/// floor the body stands on ([`short_of`]), µm: a door's handle stands in its doorway, where no body stops, so the
/// walk aims at the clear ground before the door on the body's own side, as today's game finds clear ground by the
/// hand's point.
pub const APPROACH_SHORT: i64 = 500_000;

/// The point an approach before a bare `take` walks to ([`approach`], #4086): the thing's own origin, named apart from
/// any point an entry declares.
pub const TO_THING: &str = "souls:to-thing";

/// How far from its thing the place that approach goes to may be, µm: a cup in the middle of a counter or a table is
/// out of an arm's reach of every place a body may stand. With the approach's aim up to [`APPROACH_SHORT`] short of
/// the thing and the walk ending on its place ([`crate::route::AT_SPOT`]), the body ends within 1.45 m of the thing,
/// inside the world's reach for the hand's contact (half the thing's size and 1.5 m).
pub const HAND_REACH: i64 = 900_000;

/// How far from a seat's stand point the place a walk before a `sit` or `lie` step goes to may be (C17, #3453), µm:
/// the sit's and the lie's own reach (B2's data, a body's 0.6 m) less how near the walk comes to its end
/// ([`crate::route::AT_GOAL`]), so the seat is in reach where the walk stops.
pub const SIT_REACH: i64 = 600_000 - crate::route::AT_GOAL;

/// An argument of a Soul's act, as the world hands it to the forms (F14, #3384): a name from the kind's own lists (a
/// `part`, `slot`, `field` or `value` argument), a thing by its id (`thing`), words kept by their reference (`text`:
/// T8, K16's store holds the words and the intent carries `{21: id}`), or a whole number (`count`, `duration`). A
/// `slot` argument on another thing (`Slot`: a lecture's seat on a bench of its hall, a collage's patch on a board,
/// 0.135 E14) is that thing's id and the slot's number, 1 up in that thing's entry's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Arg {
    Name(String),
    Node(Id),
    Text(Id),
    Int(i64),
    Slot(Id, u64),
}

/// A form's arguments by name.
pub type Args = BTreeMap<String, Arg>;

fn name(t: &str) -> Name {
    Name::new(t).unwrap_or_else(|| unreachable!("a fixed name"))
}

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn text<'a>(v: Option<&'a Value>, what: &str) -> Result<&'a str, Refusal> {
    v.and_then(Value::str).ok_or_else(|| Refusal {
        name: "step-malformed",
        detail: format!("{what}: a name"),
    })
}

fn a_name(t: &str) -> Result<Name, Refusal> {
    Name::new(t).ok_or_else(|| Refusal {
        name: "step-malformed",
        detail: format!("{t}: not a name"),
    })
}

/// A place the kind declares by name, as µm in its frame (F14): a point (`points.<name>.at_mm`); a slot, at its stand
/// point when it names one, else at its own `at_mm`; or a placed area (`areas.<name>.at_mm`). Points, slots and areas
/// share one namespace. Anything else is `point-unknown`.
fn point(entry: &Value, p: &str) -> Result<Vec3, Refusal> {
    let at = |section: &str, name: &str| {
        entry
            .get(section)
            .and_then(|s| s.get(name))
            .and_then(|x| x.get("at_mm"))
    };
    let slot = entry.get("slots").and_then(|s| s.get(p));
    let stand = slot
        .and_then(|s| s.get("stand"))
        .and_then(Value::str)
        .and_then(|s| at("points", s));
    let mm = at("points", p)
        .or(stand)
        .or_else(|| at("slots", p))
        .or_else(|| at("areas", p))
        .and_then(Value::arr)
        .ok_or_else(|| Refusal {
            name: "point-unknown",
            detail: p.to_owned(),
        })?;
    let um = |v: &Value| match v {
        Value::Int(n) => i64::try_from(*n).ok().and_then(|n| n.checked_mul(1000)),
        _ => None,
    };
    match mm {
        [x, y, z] => match (um(x), um(y), um(z)) {
            (Some(x), Some(y), Some(z)) => Ok(Vec3::new(x, y, z)),
            _ => refuse(
                "point-unknown",
                format!("{p}: at_mm is not whole millimetres"),
            ),
        },
        _ => refuse("point-unknown", format!("{p}: at_mm is not [x, y, z]")),
    }
}

/// The way a body standing at point `p` faces (0.135): the point's `yaw_mdeg` (a slot's: its stand point's) turning
/// the kind's +z, 1 m long, in the kind's axes; none when the point names no yaw.
fn facing(entry: &Value, p: &str) -> Result<Option<Vec3>, Refusal> {
    let points = entry.get("points");
    let stand = entry
        .get("slots")
        .and_then(|s| s.get(p))
        .and_then(|s| s.get("stand"))
        .and_then(Value::str);
    let yaw = points
        .and_then(|s| s.get(p))
        .or_else(|| stand.and_then(|s| points.and_then(|x| x.get(s))))
        .and_then(|x| x.get("yaw_mdeg"));
    let Some(Value::Int(mdeg)) = yaw else {
        return Ok(None);
    };
    let bad = |e: replica::pose::PoseRefusal| Refusal {
        name: "point-unturnable",
        detail: format!("{p}: {e:?}"),
    };
    let mdeg = i64::try_from(*mdeg).map_err(|_| Refusal {
        name: "point-unturnable",
        detail: format!("{p}: yaw_mdeg out of range"),
    })?;
    let q = Quat::from_yaw_mdeg(mdeg).map_err(bad)?;
    q.rotate(Vec3::new(0, 0, 1_000_000)).map(Some).map_err(bad)
}

/// A move named in a form: a bare name is in the `souls` namespace, as the engine's moves are (B2).
fn move_name(t: &str) -> Result<Name, Refusal> {
    if t.contains(':') {
        a_name(t)
    } else {
        a_name(&format!("souls:{t}"))
    }
}

/// How often a repeated move's record for viewers is written again, µs: a viewer who comes in mid-dance draws it
/// within this long, and an hour's dance is 240 records, not one a move.
pub const REWRITE_US: Micros = 15_000_000;

/// The most a repeated move may go on, s (an hour): a Soul asked to keep on until told to stop asks for this, and
/// its `stop` ends it sooner.
pub const FOR_MOST_S: i64 = 3_600;

/// A move step's `for_s` (0.135): how long the move repeats, whole seconds from 1 to [`FOR_MOST_S`], as µs. Written
/// out, or `{"arg": a, "default": n}`: the act's whole number `a` (a `count` it takes, or the same digits as a name,
/// as `act dance for=60` sends them), else `default`. With no default, a move the act gives no `a` is done once
/// (None: a wave, unless asked to keep on waving). Refused `out-of-range`, `arg-not-a-number` or `step-malformed`.
fn for_us(v: &Value, args: &Args) -> Result<Option<Micros>, Refusal> {
    let n = match v {
        Value::Int(n) => i64::try_from(*n).unwrap_or(i64::MAX),
        _ => {
            let Some(a) = v.get("arg").and_then(Value::str) else {
                return refuse(
                    "step-malformed",
                    "move.for_s: whole seconds or {\"arg\": name, \"default\": seconds}",
                );
            };
            match (args.get(a), v.get("default")) {
                (Some(Arg::Int(n)), _) => *n,
                (Some(Arg::Name(t)), _) => match t.parse::<i64>() {
                    Ok(n) if t.bytes().all(|b| b.is_ascii_digit()) => n,
                    _ => return refuse("arg-not-a-number", format!("{a}: {t}")),
                },
                (Some(_), _) => return refuse("arg-not-a-number", a),
                (None, Some(Value::Int(n))) => i64::try_from(*n).unwrap_or(i64::MAX),
                (None, None) => return Ok(None),
                (None, Some(_)) => {
                    return refuse("step-malformed", "move.for_s.default: whole seconds");
                }
            }
        }
    };
    if !(1..=FOR_MOST_S).contains(&n) {
        return refuse(
            "out-of-range",
            format!("for: {n} s; from 1 to {FOR_MOST_S} s"),
        );
    }
    Ok(Some(n * 1_000_000))
}

/// Where a step aims (F14): a declared name, or `{"arg": a}` bound from `args`: a name argument as the declared name
/// it names, a thing argument as the thing itself (`on`; its own origin, read when the step starts), a slot argument on
/// another thing as that thing (the world aims a walk before a sit at the seat's own stand point). Refused
/// `arg-missing` for an argument not given, `point-unknown` for a name the kind does not declare, `step-malformed`
/// for any other value. Returns the name, its place in µm and the thing.
fn aim(
    entry: &Value,
    v: &Value,
    args: &Args,
    what: &str,
) -> Result<(Name, Vec3, Option<Id>), Refusal> {
    let named = |p: &str| Ok((a_name(p)?, point(entry, p)?, None));
    if let Some(p) = v.str() {
        return named(p);
    }
    let Some(a) = v.get("arg").and_then(Value::str) else {
        return refuse(
            "step-malformed",
            format!("{what}: a name or {{\"arg\": name}}"),
        );
    };
    match args.get(a) {
        Some(Arg::Name(p)) => named(p),
        Some(Arg::Node(id) | Arg::Slot(id, _)) => Ok((a_name(a)?, Vec3::ZERO, Some(*id))),
        Some(_) => refuse(
            "step-malformed",
            format!("{what}: argument {a} is not a place"),
        ),
        None => refuse("arg-missing", a),
    }
}

/// The import check (F14, #3384): every place a form of `entry` names in its steps (its stages' too) is one the kind
/// declares ([`point`]: a point, a slot or a placed area), whether written as a name or as a name argument whose
/// choices (`of`) the form lists. Run when a kind is imported, so a form that names an undeclared point is refused
/// there, by name, rather than when a Soul does it: `point-unknown` with `<form>: <name>`. A thing argument is the
/// world's to place and is not checked here.
pub fn check(entry: &Value) -> Result<(), Refusal> {
    for (form, f) in entry.get("forms").and_then(Value::obj).unwrap_or(&[]) {
        let stages = f.get("stages").and_then(Value::arr).unwrap_or(&[]);
        let steps = std::iter::once(f)
            .chain(stages)
            .flat_map(|x| x.get("steps").and_then(Value::arr).unwrap_or(&[]));
        for s in steps {
            for v in [s.get("point"), s.get("at")].into_iter().flatten() {
                let choices: Vec<&str> = match v.str() {
                    Some(p) => vec![p],
                    None => v
                        .get("arg")
                        .and_then(Value::str)
                        .and_then(|a| f.get("takes").and_then(|t| t.get(a)))
                        .and_then(|t| t.get("of"))
                        .and_then(Value::arr)
                        .unwrap_or(&[])
                        .iter()
                        .filter_map(Value::str)
                        .collect(),
                };
                for p in choices {
                    point(entry, p).map_err(|r| Refusal {
                        name: r.name,
                        detail: format!("{form}: {}", r.detail),
                    })?;
                }
            }
        }
    }
    Ok(())
}

/// Binds form `form` of the kind `entry` (a `souls-entry/1` entry) into its steps with no arguments ([`bind_with`]).
pub fn bind(entry: &Value, form: &str) -> Result<Vec<Step>, Refusal> {
    bind_with(entry, form, &Args::new())
}

/// Binds form `form` of the kind `entry` into its steps, all or none, with its act's arguments `args` (F14): a step's
/// point (`walk_to.point`, a move's `at`) is a declared name or an argument ([`Step`]); a move with no `at` aims at the
/// node with the move's own contact. A form with no steps binds to none: its effects land at once (C25, #3496).
///
/// Standing slots (C33, #3598): a form's `reparent` of the actor into a standing slot ([`standing`]) that no `sit`
/// or `lie` step carries is the body's hand-off into that slot on its feet, a [`Step::Sit`] with `stand` after the
/// form's own steps; a `reparent` of the actor `here` with no `rise` step is a [`Step::Rise`] before them, so a body
/// in a slot is handed out by B3's rise (at once for a body standing free). Into a seat (a slot with a posture) it
/// stays refused `body-moves-by-step` ([`bind_effects_args`]).
/// Refused: `form-unknown`, `step-unknown`, `step-malformed`, `point-unknown`, `arg-missing`.
pub fn bind_with(entry: &Value, form: &str, args: &Args) -> Result<Vec<Step>, Refusal> {
    let Some(f) = entry.get("forms").and_then(|fs| fs.get(form)) else {
        return refuse("form-unknown", form);
    };
    let steps = f.get("steps").and_then(Value::arr).unwrap_or(&[]);
    let mut bound = steps
        .iter()
        .map(|s| {
            let kind = text(s.get("step"), "step")?;
            match kind {
                "walk_to" => {
                    let Some(p) = s.get("point") else {
                        return refuse("step-malformed", "walk_to.point: a name");
                    };
                    let (point, at, on) = aim(entry, p, args, "walk_to.point")?;
                    let face = match on {
                        None => facing(entry, point.as_str())?,
                        Some(_) => None,
                    };
                    Ok(Step::WalkTo {
                        point,
                        at,
                        on,
                        approach: false,
                        face,
                    })
                }
                "take" | "put" if s.get("move").is_none() && s.get("at").is_none() => {
                    Ok(Step::Hand)
                }
                "take" | "put" if s.get("move").is_none() => Ok(Step::Hand),
                "sit" | "lie" => {
                    let at = s.get("slot").ok_or_else(|| Refusal {
                        name: "step-malformed",
                        detail: format!("{kind}.slot: a slot or {{\"arg\": name}}"),
                    })?;
                    let named = match at.get("arg").and_then(Value::str) {
                        Some(a) => match args.get(a) {
                            Some(Arg::Name(n)) => n.as_str(),
                            // A seat of another thing (E14): its number is that thing's; it lies by a `lie` step.
                            Some(&Arg::Slot(on, slot)) => {
                                return Ok(Step::Sit {
                                    slot,
                                    lie: kind == "lie",
                                    stand: false,
                                    on: Some(on),
                                });
                            }
                            Some(_) => {
                                return refuse(
                                    "step-malformed",
                                    format!("{kind}.slot: argument {a} is not a slot"),
                                );
                            }
                            None => return refuse("arg-missing", a),
                        },
                        None => text(Some(at), "sit.slot")?,
                    };
                    let slot = slot_n(entry, named)?;
                    let posture = entry
                        .get("slots")
                        .and_then(|ss| ss.get(named))
                        .and_then(|d| d.get("posture"))
                        .and_then(Value::str);
                    Ok(Step::Sit {
                        slot,
                        lie: kind == "lie" || posture == Some("lie"),
                        stand: false,
                        on: None,
                    })
                }
                "move" | "take" | "put" => {
                    let (at, on) = match s.get("at") {
                        Some(v) => {
                            let (at, _, on) = aim(entry, v, args, "move.at")?;
                            (on.is_none().then_some(at), on)
                        }
                        None => (None, None),
                    };
                    Ok(Step::Move {
                        name: move_name(text(s.get("move"), "move.move")?)?,
                        at,
                        on,
                        repeat: s
                            .get("for_s")
                            .map(|v| for_us(v, args))
                            .transpose()?
                            .flatten(),
                    })
                }
                "wait" => match s.get("us") {
                    Some(Value::Int(us)) if *us > 0 => {
                        Ok(Step::Wait(i64::try_from(*us).map_err(|_| Refusal {
                            name: "step-malformed",
                            detail: "wait.us: too long".into(),
                        })?))
                    }
                    _ => refuse("step-malformed", "wait.us: whole microseconds above zero"),
                },
                "rise" => Ok(Step::Rise),
                "settle" => match s.get("posture").and_then(Value::str) {
                    Some("sit") => Ok(Step::Settle { lie: false }),
                    Some("lie") => Ok(Step::Settle { lie: true }),
                    _ => refuse("step-malformed", "settle.posture: sit or lie"),
                },
                "use_held" => Ok(Step::UseHeld),
                k => refuse("step-unknown", k),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    approach(entry, f, &mut bound)?;
    approach_in_areas(entry, &mut bound)?;
    let into = stand_in(entry, f, args)?;
    if let Some((_, slot)) = into {
        bound.push(Step::Sit {
            slot,
            lie: false,
            stand: true,
            on: None,
        });
    }
    if rises_out(f, into.is_some()) {
        bound.insert(0, Step::Rise);
    }
    Ok(bound)
}

/// A form that starts with a move at one of the thing's points, with no walk before it (a door's `open` at its
/// handle, a lamp's `switch_on` at its switch), first walks to that point: the planner stops at the nearest place
/// within reach of it where a body may stand, as today's game walks to the stand point nearest the hand's point, else
/// the nearest clear ground, before it acts (0.131 parity, #3688); one that starts with a bare `take` walks to the
/// thing itself ([`TO_THING`], #4086). A form whose thing is in the actor's hand
/// (`held_by_actor` with no `thing`: a cup's sip, a kettle's pour) does not walk; one that needs a thing argument in
/// the hand (a sink's `wash` of a held bowl) still walks to its own point (0.135 E20).
fn approach(entry: &Value, f: &Value, bound: &mut Vec<Step>) -> Result<(), Refusal> {
    let held = f
        .get("needs")
        .and_then(Value::arr)
        .unwrap_or(&[])
        .iter()
        .any(|n| {
            n.get("need").and_then(Value::str) == Some("held_by_actor") && n.get("thing").is_none()
        });
    let Some(k) = bound.iter().position(|s| !matches!(s, Step::Wait(_))) else {
        return Ok(());
    };
    // A form that starts with a bare `take` (a hand step with no move: a cup's take) first walks to its thing, as
    // today's game walks to a thing before it picks it up (#4086, #4118): no take at a distance. The runner skips the
    // walk for a body already within reach, and measures the reach again at the hand step's contact.
    let bare_take = f
        .get("steps")
        .and_then(Value::arr)
        .and_then(|s| s.get(k))
        .and_then(|s| s.get("step"))
        .and_then(Value::str)
        == Some("take");
    if matches!(bound[k], Step::Hand) && bare_take && !held {
        let step = Step::WalkTo {
            point: name(TO_THING),
            at: Vec3::ZERO,
            on: None,
            approach: true,
            face: None,
        };
        bound.insert(k, step);
        return Ok(());
    }
    if let Step::Move {
        at: Some(p),
        on: None,
        ..
    } = &bound[k]
        && !held
    {
        let to = point(entry, p.as_str())?;
        let step = Step::WalkTo {
            point: p.clone(),
            at: Vec3::new(to.x, 0, to.z),
            on: None,
            approach: true,
            face: None,
        };
        bound.insert(k, step);
    }
    Ok(())
}

/// Point `to` moved `by` µm toward `from` across x and z, or left where it is when `from` is nearer than that.
pub fn short_of(to: Vec3, from: Vec3, by: i64) -> Vec3 {
    let (dx, dz) = (
        i128::from(from.x) - i128::from(to.x),
        i128::from(from.z) - i128::from(to.z),
    );
    let len = (dx * dx + dz * dz).isqrt();
    if len <= i128::from(by) {
        return to;
    }
    let step = |d: i128| i64::try_from(d * i128::from(by) / len).unwrap_or(0);
    Vec3::new(to.x + step(dx), to.y, to.z + step(dz))
}

/// An area is a place to be in, not a point to act from (C34, #3599): a move at a point of the thing right after a walk
/// to one of its areas first walks, within that area, to that point (the planner stops within reach of it), as
/// today's game walks to the stand point nearest the hand's point before it acts. The added walk keeps the area's name,
/// so the world plans it on the area's own room and floor, and aims at the move's point.
fn approach_in_areas(entry: &Value, bound: &mut Vec<Step>) -> Result<(), Refusal> {
    let is_area = |n: &Name| entry.get("areas").and_then(|a| a.get(n.as_str())).is_some();
    let mut k = 1;
    while k < bound.len() {
        if let (
            Step::WalkTo {
                point: area,
                on: None,
                ..
            },
            Step::Move {
                at: Some(p),
                on: None,
                ..
            },
        ) = (&bound[k - 1], &bound[k])
            && is_area(area)
            && area != p
        {
            // The point across the floor, at the area's height: the floor is the area's.
            let (to, floor) = (point(entry, p.as_str())?, point(entry, area.as_str())?);
            let step = Step::WalkTo {
                point: area.clone(),
                at: Vec3::new(to.x, floor.y, to.z),
                on: None,
                approach: false,
                face: None,
            };
            bound.insert(k, step);
            k += 1;
        }
        k += 1;
    }
    Ok(())
}

/// Whether slot `slot` of the kind `entry` is a standing slot (C33, #3598): it admits a body and names no posture
/// (a phone box's inside, a pool table's side, a balloon's basket).
fn standing(entry: &Value, slot: &str) -> bool {
    entry
        .get("slots")
        .and_then(|ss| ss.get(slot))
        .is_some_and(|d| {
            d.get("admits").and_then(Value::str) == Some("body") && d.get("posture").is_none()
        })
}

/// Form `f`'s `reparent` of the actor into a standing slot that no `sit` or `lie` step carries (C33, #3598): the
/// effect's index and the slot's number. A slot named through an argument is read from `args` (`arg-missing` without
/// it). `None` for any other form, a seat among them.
fn stand_in(entry: &Value, f: &Value, args: &Args) -> Result<Option<(usize, u64)>, Refusal> {
    let effects = f.get("effects").and_then(Value::arr).unwrap_or(&[]);
    let steps = f.get("steps").and_then(Value::arr).unwrap_or(&[]);
    for (i, e) in effects.iter().enumerate() {
        let Some(into) = e.get("into") else { continue };
        if e.get("change").and_then(Value::str) != Some("reparent")
            || e.get("what").and_then(Value::str) != Some("actor")
            || into.str() == Some("here")
        {
            continue;
        }
        let carried = steps.iter().any(|s| {
            matches!(s.get("step").and_then(Value::str), Some("sit" | "lie"))
                && s.get("slot") == Some(into)
        });
        if carried {
            continue;
        }
        let named = match into.get("arg").and_then(Value::str) {
            Some(a) => match args.get(a) {
                Some(Arg::Name(n)) => n.as_str(),
                Some(_) => {
                    return refuse("effect-malformed", format!("argument {a} is not a slot"));
                }
                None => return refuse("arg-missing", a),
            },
            None => match into.str() {
                Some(n) => n,
                None => continue,
            },
        };
        if standing(entry, named) {
            return Ok(Some((i, slot_n(entry, named)?)));
        }
    }
    Ok(None)
}

/// Whether form `f` hands the actor out of its slot (C33, #3598): it reparents the actor `here`, or into a standing
/// slot (`standing`: a stage's `step_up` from one spot to another, 0.135 E17), and has no `rise`, `sit` or `lie` step of
/// its own. Its run starts with a rise, done at once for a body standing, so a body in a slot of the thing is stood up
/// by the rise move before the form's own walk, never walked by legs the slot holds.
fn rises_out(f: &Value, standing: bool) -> bool {
    let effects = f.get("effects").and_then(Value::arr).unwrap_or(&[]);
    let steps = f.get("steps").and_then(Value::arr).unwrap_or(&[]);
    (standing
        || effects.iter().any(|e| {
            e.get("change").and_then(Value::str) == Some("reparent")
                && e.get("what").and_then(Value::str) == Some("actor")
                && e.get("into").and_then(Value::str) == Some("here")
        }))
        && !steps.iter().any(|s| {
            matches!(
                s.get("step").and_then(Value::str),
                Some("rise" | "sit" | "lie")
            )
        })
}

/// Turns the points bound `steps` walk to by `q`, the orientation of the node the form is done at (C13, #3440): an
/// entry's points are in the kind's own axes, and the runner adds them to the node's position, so a turned thing's
/// point is walked to on its turned side. `point-unturnable` when a point is too far out to turn.
pub fn turn(steps: &mut [Step], q: Quat) -> Result<(), Refusal> {
    for s in steps {
        // A thing argument's walk (`on`) aims at that thing's own origin: nothing to turn.
        if let Step::WalkTo {
            point,
            at,
            on: None,
            face,
            ..
        } = s
        {
            let unturnable = |e: replica::pose::PoseRefusal| Refusal {
                name: "point-unturnable",
                detail: format!("{}: {e:?}", point.as_str()),
            };
            *at = q.rotate(*at).map_err(unturnable)?;
            if let Some(f) = face {
                *f = q.rotate(*f).map_err(unturnable)?;
            }
        }
    }
    Ok(())
}

/// One effect of a form, bound. The world works each out at the effect's instant, against the tree (`sim::forms`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Field `field` (its number in the kind's `state`) of the node the form is done at is set to `to`.
    Set { field: u64, to: encode::Value },
    /// Field `field` of the node moved by `by` (`set ... by`, C22): refused when that leaves the kind's bounds.
    Add { field: u64, by: i64 },
    /// An amount of field `field` moved from `from` to `into` (F4): the least of what is asked, what the source has
    /// above its least and the room the target has left, written as the source's and the target's sets in one part.
    /// The field is named, not numbered: the two ends may be of kinds that number it differently, and the world finds
    /// its number on each end's own kind (E5). With `into_field`, the amount lands in that other field of the node
    /// itself (`from` and `into` both the node, #4103): a stock into a well.
    Transfer {
        field: Name,
        from: Of,
        into: Of,
        into_field: Option<Name>,
        amount: Amount,
    },
    /// A thing of kind `kind` made into `into`, refused when that is not free (F4), with the fields `set` gives it
    /// (#4104): each by name, read against the made kind's own field when the world makes it.
    Make {
        kind: Name,
        into: Place,
        set: Vec<(Name, Init)>,
    },
    /// Thing `what` removed: one the node contains or the body holds (F4).
    Remove { what: Of },
    /// A `take` step's transfer (B4's, at its contact): `what` into a free hand of the body.
    Take { what: Of },
    /// A `put` step's transfer (B4's, at its contact): `what`, held by the body, into slot `slot` of the node, or of
    /// thing `on` (a slot argument on another thing, E14).
    Put { what: Of, slot: u64, on: Option<Id> },
    /// A link of type `ty` (the tree's, `replica::audience::link_type`) from the actor to the node, owned by the node
    /// and seen by everyone (F15): its end the actor's Soul when `soul`, else its body. At most `most` of that type
    /// on the node (the kind's `most`, C24).
    Link {
        ty: Name,
        soul: bool,
        most: Option<u64>,
    },
    /// The node's own links of type `ty` taken down (F15): the actor's (its Soul's when `soul`, else its body's), or
    /// every one when `all`.
    Unlink { ty: Name, soul: bool, all: bool },
    /// Form `form` (`namespace:form`) of the node, started by the world `after` µs from the effect's instant (C24); it
    /// replaces that form's timer pending on the node.
    Timer { form: Name, after: Micros },
    /// A timed field (F5's three numbers) settled to the effect's instant and given rate `per_s`, from value `to`
    /// when given (C24).
    Timed {
        field: u64,
        to: Option<i64>,
        per_s: i64,
        default: replica::timed::Timed,
        bounds: replica::timed::Bounds,
    },
    /// The actor stays where it is (a `reparent` of the actor `here` no step carries, C24): nothing moves, and a body
    /// in a slot of the node is refused `body-seated`.
    Here,
}

/// A thing an effect names: the node the form is done at, or a thing argument, bound to its id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Of {
    This,
    Node(Id),
}

/// Where a made thing appears: a free hand of the body, or a slot of the node (its number, in the kind's order).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    Hand,
    Slot(u64),
}

/// How much a transfer asks: a whole number of the field's unit (zero, as a count argument may ask, moves nothing),
/// or all the room the target has left.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Amount {
    Units(i64),
    Room,
}

/// A made thing's field as its `create` sets it (#4104): a flag, a whole number, or a name (one of an enum's values),
/// as written or as a value argument gives it. The made kind is not the entry the form is bound from, so the world
/// reads it against the made kind's own field when it makes the thing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Init {
    Flag(bool),
    Int(i64),
    Name(String),
}

/// Binds form `form`'s effects with no thing arguments ([`bind_effects_with`]).
pub fn bind_effects(entry: &Value, form: &str) -> Result<Vec<Effect>, Refusal> {
    bind_effects_args(entry, form, &Args::new())
}

/// The number of field `field` in the kind's `state`.
fn field_n(entry: &Value, field: &str) -> Result<u64, Refusal> {
    let n = match entry
        .get("state")
        .and_then(|s| s.get(field))
        .and_then(|d| d.get("n"))
    {
        Some(Value::Int(n)) => u64::try_from(*n).ok(),
        _ => None,
    };
    n.ok_or_else(|| Refusal {
        name: "field-unknown",
        detail: field.to_owned(),
    })
}

/// A thing an effect names: `"this"` (or nothing), or `{"arg": name}` bound from `args` (`arg-missing` when not).
fn of(v: Option<&Value>, args: &Args) -> Result<Of, Refusal> {
    let Some(v) = v.filter(|v| v.str() != Some("this")) else {
        return Ok(Of::This);
    };
    match v.get("arg").and_then(Value::str) {
        Some(a) => match args.get(a) {
            Some(Arg::Node(id)) => Ok(Of::Node(*id)),
            Some(_) => refuse("effect-malformed", format!("argument {a} is not a thing")),
            None => refuse("arg-missing", a),
        },
        None => refuse("effect-malformed", "a thing is \"this\" or {\"arg\": name}"),
    }
}

/// A `set`'s field (F14): its name, or a field argument's choice (`{"arg": ...}`, F14).
fn set_field<'a>(e: &'a Value, args: &'a Args) -> Result<&'a str, Refusal> {
    let f = e.get("field");
    if let Some(name) = f.and_then(Value::str) {
        return Ok(name);
    }
    match f.and_then(|f| f.get("arg")).and_then(Value::str) {
        Some(a) => match args.get(a) {
            Some(Arg::Name(n)) => Ok(n),
            Some(_) => refuse("effect-malformed", format!("argument {a} is not a field")),
            None => refuse("arg-missing", a),
        },
        None => refuse("effect-malformed", "set.field: a name or {\"arg\": name}"),
    }
}

/// The namespace of the kind `entry` names (`eden` for `eden:bed`).
fn namespace(entry: &Value) -> &str {
    entry
        .get("kind")
        .and_then(Value::str)
        .and_then(|k| k.split_once(':'))
        .map_or("souls", |(ns, _)| ns)
}

/// The value a `set` writes to field `field` (F14), as the entry format allows it: a whole number (refused
/// `out-of-range` outside the field's `min` and `max`, C24) or a flag, a value of an `enum` field (refused
/// `not-allowed` when the field does not list it, and written as a name in the kind's namespace, `eden:seed`: the
/// log's only text is a name, C24), no words (`null`, `{}`) for a `text` field, and through an argument the same, a
/// thing's id or words' reference (`{21: id}`, K16) for a `text` field. A name for a `text` field is `not-allowed`.
/// Refused `effect-malformed` otherwise.
fn set_to(entry: &Value, field: &str, to: &Value, args: &Args) -> Result<encode::Value, Refusal> {
    let def = entry.get("state").and_then(|s| s.get(field));
    let ty = def.and_then(|d| d.get("type")).and_then(Value::str);
    let named = |v: &str| {
        let bare = v.split_once(':').map_or(v, |(_, b)| b);
        let listed = def
            .and_then(|d| d.get("values"))
            .and_then(Value::arr)
            .unwrap_or(&[])
            .iter()
            .any(|x| x.str() == Some(bare));
        match (
            ty,
            listed,
            Name::new(&format!("{}:{bare}", namespace(entry))),
        ) {
            (Some("enum"), true, Some(n)) => Ok(encode::Value::Text(n)),
            (Some("enum" | "text"), _, _) => refuse("not-allowed", format!("{field}: {v}")),
            _ => refuse("effect-malformed", format!("set.to: {field} takes no name")),
        }
    };
    let bound = |k: &str| match def.and_then(|d| d.get(k)) {
        Some(Value::Int(n)) => Some(*n),
        _ => None,
    };
    let int = |n: i128| {
        if bound("min").is_some_and(|m| n < m) || bound("max").is_some_and(|m| n > m) {
            return refuse("out-of-range", format!("{field}: {n}"));
        }
        match (u64::try_from(n), i64::try_from(n)) {
            (Ok(u), _) => Ok(encode::Value::Uint(u)),
            (_, Ok(i)) => Ok(encode::Value::Nint(i.unsigned_abs() - 1)),
            _ => refuse("effect-malformed", "set.to: out of range"),
        }
    };
    match to {
        Value::Bool(b) => Ok(encode::Value::Uint(u64::from(*b))),
        Value::Int(n) => int(*n),
        Value::Str(v) => named(v),
        // A text field set to nothing holds no words: no reference, `{}`.
        Value::Null if ty == Some("text") => Ok(encode::Value::Map(BTreeMap::new())),
        _ => match to.get("arg").and_then(Value::str) {
            Some(a) => match (args.get(a), ty) {
                (Some(Arg::Name(v)), _) => named(v),
                (Some(Arg::Int(n)), Some("int" | "duration")) => int(i128::from(*n)),
                (Some(Arg::Text(id)), Some("text")) => Ok(encode::Value::Map(BTreeMap::from([(
                    replica::audience::REFERENCE,
                    id.to_value(),
                )]))),
                (Some(Arg::Node(id)), _) => Ok(id.to_value()),
                (Some(_), _) => refuse(
                    "effect-malformed",
                    format!("set.to: argument {a} does not fit {field}"),
                ),
                (None, _) => refuse("arg-missing", a),
            },
            None => refuse(
                "effect-malformed",
                "set.to: a whole number, a flag, a name or {\"arg\": name}",
            ),
        },
    }
}

/// A slot of the kind by name: its number, 1, 2, ... in the entry's order (as `replica::kinds::entry` numbers it).
fn slot_n(entry: &Value, slot: &str) -> Result<u64, Refusal> {
    let slots = entry.get("slots").and_then(Value::obj).unwrap_or(&[]);
    (1u64..)
        .zip(slots)
        .find(|(_, (k, _))| k == slot)
        .map(|(n, _)| n)
        .ok_or_else(|| Refusal {
            name: "slot-unknown",
            detail: slot.to_owned(),
        })
}

/// Binds form `form`'s effects with its thing arguments alone (name to id, F4); see [`bind_effects_args`].
pub fn bind_effects_with(
    entry: &Value,
    form: &str,
    things: &BTreeMap<String, Id>,
) -> Result<Vec<Effect>, Refusal> {
    let args = things
        .iter()
        .map(|(k, id)| (k.clone(), Arg::Node(*id)))
        .collect();
    bind_effects_args(entry, form, &args)
}

/// A form's arguments as an intent carries them (C12, #3427): things by id, and slots of the node by number, 1, 2, ...
/// in the entry's order, each as the slot's name ([`Arg::Name`]). A number the kind has no slot for is `slot-unknown`.
/// An argument given both as a thing and as a number is that slot of that thing ([`Arg::Slot`], E14: a seat on a
/// bench of the hall), numbered in that thing's entry, which the world checks when the seat is taken.
pub fn args_in(
    entry: &Value,
    things: &BTreeMap<String, Id>,
    slots: &BTreeMap<String, u64>,
) -> Result<Args, Refusal> {
    let names = entry.get("slots").and_then(Value::obj).unwrap_or(&[]);
    let mut args: Args = things
        .iter()
        .map(|(k, id)| (k.clone(), Arg::Node(*id)))
        .collect();
    for (k, &n) in slots {
        if let Some(&on) = things.get(k) {
            args.insert(k.clone(), Arg::Slot(on, n));
            continue;
        }
        let slot = usize::try_from(n)
            .ok()
            .and_then(|n| n.checked_sub(1))
            .and_then(|i| names.get(i))
            .ok_or_else(|| Refusal {
                name: "slot-unknown",
                detail: format!("{k}: slot {n}"),
            })?;
        args.insert(k.clone(), Arg::Name(slot.0.clone()));
    }
    Ok(args)
}

/// [`bind_with`], with the form's thing arguments by id and its slot arguments by number (C12): a `walk_to` naming a
/// slot argument walks to that slot's `stand` point, or to the slot itself when it names none; one naming a thing
/// argument walks to that thing (C25, #3496).
pub fn bind_in(
    entry: &Value,
    form: &str,
    things: &BTreeMap<String, Id>,
    slots: &BTreeMap<String, u64>,
) -> Result<Vec<Step>, Refusal> {
    bind_with(entry, form, &args_in(entry, things, slots)?)
}

/// [`bind_effects_args`], with the form's thing arguments by id and its slot arguments by number (C12).
pub fn bind_effects_in(
    entry: &Value,
    form: &str,
    things: &BTreeMap<String, Id>,
    slots: &BTreeMap<String, u64>,
) -> Result<Vec<Effect>, Refusal> {
    bind_effects_args(entry, form, &args_in(entry, things, slots)?)
}

/// Binds form `form`'s effects, all or none, with its act's arguments `args`: first each `take` or `put` step's
/// transfer, in step order, then the form's `effects`: `set ... to` on the node (a field by name or through a field
/// argument; the value as [`set_to`] reads it, F14), `transfer` (between two things, or between two fields of the
/// node with `into_field`, #4103; its amount a whole number, `"room"` or a count argument), `create` into the actor's
/// hand or a slot (`into`: `"actor_hand"` or a slot's name; `set`, the made thing's fields, [`Init`], #4104),
/// `remove`, and `link` and `unlink` (`from`: `"actor"`, or `"all"` to unlink) of a
/// link the kind declares (F15), a `timer` (a form of the node the world starts later, C24), a `set` with a `rate`
/// ([`Effect::Timed`], C24) and a `reparent` no step carries (C24). Refused: `effect-not-built` for any other change
/// (a `create` `here` is E4's, a link not seen by everyone T8's), `field-unknown`, `slot-unknown`, `link-unknown`,
/// `form-unknown`, `arg-missing`, `out-of-range` and `not-allowed` for a value the field does not take,
/// `effect-malformed` for a value that is no value at all, an amount that is not a whole number (zero or more) or
/// `"room"`, or an `into_field` whose ends are not both the node or that names the field it leaves.
/// A `put` names its slot, or a slot argument (`{"arg": a}`). A `take` or `put` with no `what` moves the thing the
/// form's `reparent` effect into the same place names (the actor's hand, or that slot), else the node itself; that
/// `reparent` is the step's transfer, bound once (C12, #3427). A `reparent` no take, put, sit or lie carries is bound
/// alone (C24): a thing into the hand or a slot as a take or a put, the actor `here` as [`Effect::Here`]; the actor
/// into a standing slot is carried by the hand-off [`bind_with`] adds (C33, #3598), into a seat refused
/// `body-moves-by-step`.
pub fn bind_effects_args(entry: &Value, form: &str, args: &Args) -> Result<Vec<Effect>, Refusal> {
    let Some(f) = entry.get("forms").and_then(|fs| fs.get(form)) else {
        return refuse("form-unknown", form);
    };
    let effects = f.get("effects").and_then(Value::arr).unwrap_or(&[]);
    // The form's `reparent` into `into`, if it has one: its index.
    let reparent = |into: &Value| {
        effects.iter().position(|e| {
            e.get("change").and_then(Value::str) == Some("reparent") && e.get("into") == Some(into)
        })
    };
    // The body handed into the seat is a sit's own hand-off (C17): the form's `reparent` of the actor into that
    // slot is carried by the step, not written as an effect.
    let steps = f.get("steps").and_then(Value::arr).unwrap_or(&[]);
    let mut carried: Vec<usize> = steps
        .iter()
        .filter(|s| matches!(s.get("step").and_then(Value::str), Some("sit" | "lie")))
        .filter_map(|s| s.get("slot").and_then(&reparent))
        .filter(|&i| effects[i].get("what").and_then(Value::str) == Some("actor"))
        .collect();
    // So is a rise's (C25, #3496): the form's `reparent` of the actor to `here` is the body handed out of its seat.
    if steps
        .iter()
        .any(|s| s.get("step").and_then(Value::str) == Some("rise"))
        && let Some(i) = reparent(&Value::Str("here".into()))
        && effects[i].get("what").and_then(Value::str) == Some("actor")
    {
        carried.push(i);
    }
    // So is a standing slot's (C33, #3598): the hand-off [`bind_with`] adds after the form's steps.
    if let Some((i, _)) = stand_in(entry, f, args)? {
        carried.push(i);
    }
    let mut what = |s: &Value, into: &Value| match (s.get("what"), reparent(into)) {
        (Some(w), _) => of(Some(w), args),
        (None, Some(i)) => {
            carried.push(i);
            of(effects[i].get("what"), args)
        }
        (None, None) => Ok(Of::This),
    };
    let mut out = Vec::new();
    for s in f.get("steps").and_then(Value::arr).unwrap_or(&[]) {
        match s.get("step").and_then(Value::str) {
            Some("take") => out.push(Effect::Take {
                what: what(s, &Value::Str("actor_hand".into()))?,
            }),
            Some("put") => {
                let into = s.get("slot").ok_or_else(|| Refusal {
                    name: "step-malformed",
                    detail: "put.slot: a slot or {\"arg\": name}".into(),
                })?;
                let (slot, on) = match into.get("arg").and_then(Value::str) {
                    Some(a) => match args.get(a) {
                        Some(Arg::Name(n)) => (slot_n(entry, n)?, None),
                        Some(&Arg::Slot(on, slot)) => (slot, Some(on)),
                        Some(_) => {
                            return refuse("step-malformed", format!("argument {a} is not a slot"));
                        }
                        None => return refuse("arg-missing", a),
                    },
                    None => (slot_n(entry, text(Some(into), "put.slot")?)?, None),
                };
                out.push(Effect::Put {
                    what: what(s, into)?,
                    slot,
                    on,
                });
            }
            _ => {}
        }
    }
    for (i, e) in effects.iter().enumerate() {
        if carried.contains(&i) {
            continue;
        }
        let change = text(e.get("change"), "effect.change")?;
        out.push(match (change, e.get("to")) {
            ("set", _) if e.get("rate").is_some() => timed(entry, e)?,
            ("set", Some(to)) => {
                let name = set_field(e, args)?;
                Effect::Set {
                    field: field_n(entry, name)?,
                    to: set_to(entry, name, to, args)?,
                }
            }
            ("set", None) if e.get("by").is_some() => Effect::Add {
                field: field_n(entry, text(e.get("field"), "effect.field")?)?,
                by: match e.get("by") {
                    Some(Value::Int(n)) => i64::try_from(*n).ok(),
                    _ => None,
                }
                .ok_or_else(|| Refusal {
                    name: "effect-malformed",
                    detail: "set.by: a whole number".into(),
                })?,
            },
            ("transfer", _) => {
                let field = text(e.get("field"), "transfer.field")?;
                let (from, into) = (of(e.get("from"), args)?, of(e.get("into"), args)?);
                // Between two fields of one thing (#4103): both ends the node, and the field it lands in another.
                let into_field = match e.get("into_field") {
                    None => None,
                    Some(f) => {
                        let lands = text(Some(f), "transfer.into_field")?;
                        if (from, into) != (Of::This, Of::This) || lands == field {
                            return refuse(
                                "effect-malformed",
                                "transfer.into_field: another field of this one thing, from and into both \"this\"",
                            );
                        }
                        Some(a_name(lands)?)
                    }
                };
                Effect::Transfer {
                    field: a_name(field)?,
                    from,
                    into,
                    into_field,
                    amount: transfer_amount(e.get("amount"), args)?,
                }
            }
            ("create", _) => Effect::Make {
                kind: a_name(text(e.get("kind"), "create.kind")?)?,
                into: match text(e.get("into"), "create.into")? {
                    "actor_hand" => Place::Hand,
                    "here" => return refuse("effect-not-built", "create here"),
                    slot => Place::Slot(slot_n(entry, slot)?),
                },
                set: made_set(e.get("set"), args)?,
            },
            ("remove", _) => Effect::Remove {
                what: of(e.get("what"), args)?,
            },
            ("link" | "unlink", _) => link(entry, change, e)?,
            ("timer", _) => {
                let form = text(e.get("form"), "timer.form")?;
                let after = match e.get("after_us") {
                    Some(Value::Int(n)) if *n > 0 => i64::try_from(*n).ok(),
                    _ => None,
                }
                .ok_or_else(|| Refusal {
                    name: "effect-malformed",
                    detail: "timer.after_us: whole microseconds above zero".into(),
                })?;
                if entry.get("forms").and_then(|fs| fs.get(form)).is_none() {
                    return refuse("form-unknown", form);
                }
                Effect::Timer {
                    form: a_name(&format!("{}:{form}", namespace(entry)))?,
                    after,
                }
            }
            ("reparent", _) => reparent_alone(entry, e, args)?,
            (other, _) => return refuse("effect-not-built", other),
        });
    }
    Ok(out)
}

/// What a `transfer` asks (F4): a whole number (zero or more), `"room"`, or a count argument's number (`{"arg": a}`,
/// as content's spindles and caddies ask, #4103; a caddy's blend may ask 0 of one leaf, which moves nothing);
/// `effect-malformed` for anything else, `arg-missing` for an argument not given.
fn transfer_amount(v: Option<&Value>, args: &Args) -> Result<Amount, Refusal> {
    let malformed = || {
        refuse(
            "effect-malformed",
            "transfer.amount: a whole number (zero or more) or \"room\"",
        )
    };
    let units = |n: i128| match i64::try_from(n) {
        Ok(n) if n >= 0 => Ok(Amount::Units(n)),
        _ => malformed(),
    };
    match v {
        Some(Value::Int(n)) => units(*n),
        Some(v) if v.str() == Some("room") => Ok(Amount::Room),
        Some(v) => match v.get("arg").and_then(Value::str) {
            Some(a) => match args.get(a) {
                Some(Arg::Int(n)) => units(i128::from(*n)),
                Some(_) => refuse("effect-malformed", format!("argument {a} is not a count")),
                None => refuse("arg-missing", a),
            },
            None => malformed(),
        },
        None => malformed(),
    }
}

/// A `create`'s `set` (#4104): each made field by name, its value a flag, a whole number or a name as written, or a
/// value argument's (a candle's shape and colour chosen at the bench). `effect-malformed` for a `set` that is not a
/// list or a `to` that is not such a value, `step-malformed` for a `field` that is not a name, `arg-missing` for an
/// argument not given.
fn made_set(v: Option<&Value>, args: &Args) -> Result<Vec<(Name, Init)>, Refusal> {
    let Some(v) = v else {
        return Ok(Vec::new());
    };
    let malformed = |detail: String| Refusal {
        name: "effect-malformed",
        detail,
    };
    let list = v
        .arr()
        .ok_or_else(|| malformed("create.set: a list of {\"field\", \"to\"}".into()))?;
    list.iter()
        .map(|x| {
            let field = a_name(text(x.get("field"), "create.set.field")?)?;
            let to = match x.get("to") {
                Some(Value::Bool(b)) => Init::Flag(*b),
                Some(Value::Int(n)) => {
                    Init::Int(i64::try_from(*n).map_err(|_| malformed(format!("create.set: {n}")))?)
                }
                Some(Value::Str(s)) => Init::Name(s.clone()),
                Some(t) => match t.get("arg").and_then(Value::str) {
                    Some(a) => match args.get(a) {
                        Some(Arg::Name(s)) => Init::Name(s.clone()),
                        Some(Arg::Int(n)) => Init::Int(*n),
                        Some(_) => return Err(malformed(format!("argument {a} is not a value"))),
                        None => return refuse("arg-missing", a),
                    },
                    None => return Err(malformed("create.set.to: a value".into())),
                },
                None => return Err(malformed("create.set.to: a value".into())),
            };
            Ok((field, to))
        })
        .collect()
}

/// A `set` with a `rate` on a timed field (C24): F5's three numbers, settled at the effect's instant and given the
/// rate, from `to` when given (`out-of-range` outside the field's `min` and `max`).
fn timed(entry: &Value, e: &Value) -> Result<Effect, Refusal> {
    let name = text(e.get("field"), "effect.field")?;
    let def = entry.get("state").and_then(|s| s.get(name));
    let int = |v: Option<&Value>| match v {
        Some(Value::Int(n)) => i64::try_from(*n).ok(),
        _ => None,
    };
    let three = def.and_then(|d| d.get("default"));
    let at = |k: &str| int(three.and_then(|t| t.get(k)));
    let (Some(per_s), Some(value), Some(rate), Some(set_us)) =
        (int(e.get("rate")), at("value"), at("per_s"), at("set_us"))
    else {
        return refuse(
            "effect-malformed",
            format!("set {name}: a timed field and a whole rate"),
        );
    };
    let to = match e.get("to") {
        None => None,
        Some(v) => Some(int(Some(v)).ok_or_else(|| Refusal {
            name: "effect-malformed",
            detail: "set.to: a whole number".into(),
        })?),
    };
    let bounds = replica::timed::Bounds {
        min: int(def.and_then(|d| d.get("min"))),
        max: int(def.and_then(|d| d.get("max"))),
    };
    if to.is_some_and(|t| bounds.min.is_some_and(|m| t < m) || bounds.max.is_some_and(|m| t > m)) {
        return refuse("out-of-range", format!("{name}: {to:?}"));
    }
    Ok(Effect::Timed {
        field: field_n(entry, name)?,
        to,
        per_s,
        default: replica::timed::Timed {
            value,
            per_s: rate,
            set_us,
        },
        bounds,
    })
}

/// A `reparent` no step carries (C24): a thing into the actor's hand is a take, into a slot (by name or a slot
/// argument) a put; the actor `here` stays ([`Effect::Here`]). A body goes into a slot only by a `sit` or `lie` step,
/// never by an effect (`body-moves-by-step`), and a thing set down `here` is E4's (`no-slot-here`).
fn reparent_alone(entry: &Value, e: &Value, args: &Args) -> Result<Effect, Refusal> {
    let into = e.get("into").ok_or_else(|| Refusal {
        name: "effect-malformed",
        detail: "reparent.into: a place".into(),
    })?;
    let actor = e.get("what").and_then(Value::str) == Some("actor");
    match (actor, into.str()) {
        (true, Some("here")) => Ok(Effect::Here),
        (true, _) => refuse(
            "body-moves-by-step",
            "a body goes into a slot by a sit or lie step, not by an effect",
        ),
        (false, Some("actor_hand")) => Ok(Effect::Take {
            what: of(e.get("what"), args)?,
        }),
        (false, Some("here")) => refuse(
            "no-slot-here",
            "a thing set down where there is no slot (E4)",
        ),
        (false, _) => {
            let (slot, on) = match into.get("arg").and_then(Value::str) {
                Some(a) => match args.get(a) {
                    Some(Arg::Name(n)) => (slot_n(entry, n)?, None),
                    Some(&Arg::Slot(on, slot)) => (slot, Some(on)),
                    Some(_) => {
                        return refuse("effect-malformed", format!("argument {a} is not a slot"));
                    }
                    None => return refuse("arg-missing", a),
                },
                None => (slot_n(entry, text(Some(into), "reparent.into")?)?, None),
            };
            Ok(Effect::Put {
                what: of(e.get("what"), args)?,
                slot,
                on,
            })
        }
    }
}

/// A `link` or `unlink` effect `e` of the kind `entry` (F15): its link `link` read from the kind's `links`.
fn link(entry: &Value, change: &str, e: &Value) -> Result<Effect, Refusal> {
    let t = text(e.get("link"), "link.link")?;
    let Some(def) = entry.get("links").and_then(|l| l.get(t)) else {
        return refuse("link-unknown", t);
    };
    let kind = text(entry.get("kind"), "kind")?;
    let ty = a_name(&replica::audience::link_type(kind, t))?;
    let soul = def.get("from").and_then(Value::str) == Some("soul");
    let rule = def
        .get("audience")
        .and_then(|a| a.get("rule"))
        .and_then(Value::str)
        .unwrap_or_default();
    match (change, e.get("from").and_then(Value::str)) {
        // A link seen by its owner or its members needs that audience's node, which T8 writes.
        ("link", Some("actor")) if rule != "everyone" => {
            refuse("effect-not-built", format!("a {t} link seen by {rule}"))
        }
        ("link", Some("actor")) => Ok(Effect::Link {
            ty,
            soul,
            most: match def.get("most") {
                Some(Value::Int(n)) => u64::try_from(*n).ok(),
                _ => None,
            },
        }),
        ("unlink", Some(from @ ("actor" | "all"))) => Ok(Effect::Unlink {
            ty,
            soul,
            all: from == "all",
        }),
        _ => refuse(
            "effect-malformed",
            "link.from: \"actor\", or \"all\" to unlink",
        ),
    }
}

/// Binds form `form`'s hatch (F8, #2823), if it has one, into T9's shape (`replica::host::Hatch`, which refuses by
/// name): `{"module": "prov-<multihash hex>", "reads": [{"field": name} | {"arg": name}], "steps_most": n, "answers":
/// "verdict" | {"field": name} | {"fields": [name, ...]}, "why": key}`. A read of a field the kind does not declare is `field-unknown`.
pub fn bind_hatch(entry: &Value, form: &str) -> Result<Option<Hatch>, Refusal> {
    let Some(f) = entry.get("forms").and_then(|fs| fs.get(form)) else {
        return refuse("form-unknown", form);
    };
    let Some(h) = f.get("hatch") else {
        return Ok(None);
    };
    let field = |name: &str| {
        match entry
            .get("state")
            .and_then(|s| s.get(name))
            .and_then(|d| d.get("n"))
        {
            Some(Value::Int(n)) => u64::try_from(*n).map_err(|_| ()),
            _ => Err(()),
        }
        .map_err(|()| Refusal {
            name: "field-unknown",
            detail: name.to_owned(),
        })
    };
    let module = h
        .get("module")
        .and_then(Value::str)
        .and_then(|t| t.strip_prefix("prov-"))
        .filter(|t| t.len() % 2 == 0)
        .and_then(|t| {
            (0..t.len() / 2)
                .map(|i| u8::from_str_radix(&t[2 * i..2 * i + 2], 16).ok())
                .collect::<Option<Vec<u8>>>()
        })
        .unwrap_or_default();
    let mut reads = Vec::new();
    for r in h.get("reads").and_then(Value::arr).unwrap_or(&[]) {
        reads.push(
            match (
                r.get("field").and_then(Value::str),
                r.get("arg").and_then(Value::str),
            ) {
                (Some(f), None) => encode::Value::Map(
                    [
                        (1, encode::Value::Uint(1)),
                        (2, encode::Value::Uint(field(f)?)),
                    ]
                    .into(),
                ),
                (None, Some(a)) => encode::Value::Map(
                    [
                        (1, encode::Value::Uint(2)),
                        (2, encode::Value::Text(a_name(a)?)),
                    ]
                    .into(),
                ),
                _ => return refuse("hatch-not-a-record", "a read is {field} or {arg}"),
            },
        );
    }
    let answers = match h.get("answers") {
        Some(a) if a.str() == Some("verdict") => [(1, encode::Value::Uint(1))].into(),
        Some(a) => match (
            a.get("field").and_then(Value::str),
            a.get("fields").and_then(Value::arr),
        ) {
            (Some(f), None) => [
                (1, encode::Value::Uint(2)),
                (2, encode::Value::Uint(field(f)?)),
            ]
            .into(),
            (None, Some(fs)) => [
                (1, encode::Value::Uint(3)),
                (
                    2,
                    encode::Value::Array(
                        fs.iter()
                            .map(|f| match f.str() {
                                Some(f) => field(f).map(encode::Value::Uint),
                                None => refuse("hatch-not-a-record", "fields are names"),
                            })
                            .collect::<Result<_, _>>()?,
                    ),
                ),
            ]
            .into(),
            _ => {
                return refuse(
                    "hatch-not-a-record",
                    "answers is verdict, {field} or {fields}",
                );
            }
        },
        None => {
            return refuse(
                "hatch-not-a-record",
                "answers is verdict, {field} or {fields}",
            );
        }
    };
    let steps = match h.get("steps_most") {
        Some(Value::Int(n)) => u64::try_from(*n).unwrap_or(0),
        _ => 0,
    };
    let why = a_name(text(h.get("why"), "hatch.why")?)?;
    Hatch::from_value(&encode::Value::Map(
        [
            (1, encode::Value::Bytes(module)),
            (2, encode::Value::Array(reads)),
            (3, encode::Value::Uint(steps)),
            (4, encode::Value::Map(answers)),
            (5, encode::Value::Text(why)),
        ]
        .into(),
    ))
    .map(Some)
}

/// Field `n` of `entry`'s `state`: its name and definition.
fn field_def(entry: &Value, n: u64) -> Option<(&str, &Value)> {
    entry
        .get("state")
        .and_then(Value::obj)?
        .iter()
        .find(|(_, d)| matches!(d.get("n"), Some(Value::Int(m)) if *m == i128::from(n)))
        .map(|(k, d)| (k.as_str(), d))
}

/// A definition's enum values, bare.
fn enum_values(def: Option<&Value>) -> Option<&[Value]> {
    def.filter(|d| d.get("type").and_then(Value::str) == Some("enum"))
        .and_then(|d| d.get("values"))
        .and_then(Value::arr)
}

/// A read's value as the hatch's words: a whole number is one word, an enum's value its place in the field's
/// `values` (from 0), a list or a record its parts' words in order. `def` is the field's definition, when a field.
fn words(v: &encode::Value, def: Option<&Value>, into: &mut Vec<i64>) -> Result<(), Refusal> {
    let not = || Refusal {
        name: "hatch-read-not-a-number",
        detail: "a hatch reads whole numbers, enums, lists and records of them".into(),
    };
    let of = def.and_then(|d| d.get("of")).and_then(Value::obj);
    match v {
        encode::Value::Uint(n) => into.push(i64::try_from(*n).map_err(|_| not())?),
        encode::Value::Nint(n) => into.push(-1 - i64::try_from(*n).map_err(|_| not())?),
        encode::Value::Text(t) => {
            let bare = t.as_str().split_once(':').map_or(t.as_str(), |(_, b)| b);
            let at = enum_values(def)
                .and_then(|vs| vs.iter().position(|x| x.str() == Some(bare)))
                .ok_or_else(not)?;
            into.push(at as i64);
        }
        encode::Value::Array(vs) => vs.iter().try_for_each(|v| words(v, def, into))?,
        // A list's record: each part by its definition, in the list's `of` order.
        encode::Value::Map(m) => m.iter().try_for_each(|(k, v)| {
            let part = of
                .and_then(|o| o.get(usize::try_from(*k).ok()?.checked_sub(1)?))
                .map(|(_, d)| d);
            words(v, part, into)
        })?,
        encode::Value::Bytes(_) => return Err(not()),
    }
    Ok(())
}

/// The words a hatch is given for the values of its declared reads, in order (`replica::hatch`'s calling convention),
/// a field's read by its definition in `entry`: `hatch-reads-differ` when their number is not the declared one,
/// `hatch-read-not-a-number` for text or bytes.
pub fn hatch_words(
    entry: &Value,
    hatch: &Hatch,
    reads: &[encode::Value],
) -> Result<Vec<Vec<i64>>, Refusal> {
    if reads.len() != hatch.reads.len() {
        return refuse(
            "hatch-reads-differ",
            format!("{} declared, {} given", hatch.reads.len(), reads.len()),
        );
    }
    reads
        .iter()
        .zip(&hatch.reads)
        .map(|(v, r)| {
            let def = match r {
                Read::Field(n) => field_def(entry, *n).map(|(_, d)| d),
                Read::Argument(_) => None,
            };
            let mut w = Vec::new();
            words(v, def, &mut w).map(|()| w)
        })
        .collect()
}

/// A whole number as a value.
fn int_value(n: i64) -> encode::Value {
    match u64::try_from(n) {
        Ok(u) => encode::Value::Uint(u),
        Err(_) => encode::Value::Nint(n.unsigned_abs() - 1),
    }
}

/// A field's default, from its definition in the entry, as the value it would hold: a whole number or bool, an
/// enum's value by name, a list's records. Anything else is `hatch-read-not-a-number`.
fn default_value(entry: &Value, def: &Value, d: &Value) -> Result<encode::Value, Refusal> {
    let not = || Refusal {
        name: "hatch-read-not-a-number",
        detail: "a hatch reads whole numbers, enums, lists and records of them".into(),
    };
    Ok(match d {
        Value::Int(n) => int_value(i64::try_from(*n).map_err(|_| not())?),
        Value::Bool(b) => encode::Value::Uint(u64::from(*b)),
        Value::Str(v) => {
            encode::Value::Text(Name::new(&format!("{}:{v}", namespace(entry))).ok_or_else(not)?)
        }
        Value::Arr(rs) => {
            let of = def.get("of").and_then(Value::obj).unwrap_or(&[]);
            encode::Value::Array(
                rs.iter()
                    .map(|r| {
                        (1u64..)
                            .zip(of)
                            .map(|(k, (part, pd))| {
                                Ok((k, default_value(entry, pd, r.get(part).ok_or_else(not)?)?))
                            })
                            .collect::<Result<BTreeMap<_, _>, Refusal>>()
                            .map(encode::Value::Map)
                    })
                    .collect::<Result<_, _>>()?,
            )
        }
        _ => return Err(not()),
    })
}

/// The values of a hatch's declared reads, in order, for `run_hatch`: a field's from `fields` (the node's, by number),
/// else its default; an argument's from `args`, a whole number (`arg-missing` when the act gave none,
/// `hatch-read-not-a-number` for any other).
pub fn hatch_reads(
    entry: &Value,
    hatch: &Hatch,
    fields: &BTreeMap<u64, encode::Value>,
    args: &Args,
) -> Result<Vec<encode::Value>, Refusal> {
    hatch
        .reads
        .iter()
        .map(|r| match r {
            Read::Field(n) => match fields.get(n) {
                Some(v) => Ok(v.clone()),
                None => {
                    let Some((name, def)) = field_def(entry, *n) else {
                        return refuse("field-unknown", n.to_string());
                    };
                    match def.get("default") {
                        Some(d) => default_value(entry, def, d),
                        None => refuse("field-unknown", name.to_owned()),
                    }
                }
            },
            Read::Argument(a) => match args.get(a.as_str()) {
                Some(Arg::Int(n)) => Ok(int_value(*n)),
                Some(_) => refuse("hatch-read-not-a-number", a.as_str().to_owned()),
                None => refuse("arg-missing", a.as_str().to_owned()),
            },
        })
        .collect()
}

/// One plain value from a hatch's word, by its definition: an int or duration within its bounds, a bool 0 or 1, an
/// enum's value by its place. Anything else is `hatch-answer-malformed`.
fn plain_value(entry: &Value, name: &str, def: &Value, w: i64) -> Result<encode::Value, Refusal> {
    let bad = |why: &str| refuse("hatch-answer-malformed", format!("{name}: {w}; {why}"));
    let bound = |k: &str| match def.get(k) {
        Some(Value::Int(n)) => Some(*n),
        _ => None,
    };
    match def.get("type").and_then(Value::str) {
        Some("int" | "duration") => {
            let n = i128::from(w);
            if bound("min").is_some_and(|m| n < m) || bound("max").is_some_and(|m| n > m) {
                return bad("out of its bounds");
            }
            match u64::try_from(w) {
                Ok(u) => Ok(encode::Value::Uint(u)),
                Err(_) if def.get("type").and_then(Value::str) == Some("int") => {
                    Ok(encode::Value::Nint(w.unsigned_abs() - 1))
                }
                Err(_) => bad("a duration is not negative"),
            }
        }
        Some("bool") if (0..=1).contains(&w) => Ok(encode::Value::Uint(w as u64)),
        Some("enum") => {
            let bare = usize::try_from(w)
                .ok()
                .and_then(|i| enum_values(Some(def))?.get(i)?.str());
            match bare.and_then(|b| Name::new(&format!("{}:{b}", namespace(entry)))) {
                Some(n) => Ok(encode::Value::Text(n)),
                None => bad("not one of its values"),
            }
        }
        _ => bad("a hatch answers whole numbers, bools, enums and lists of them"),
    }
}

/// Field `n`'s new value from the words a hatch wrote for it: one word for a plain field, a list's records' words in
/// its `of` order, at most its `most` records. Anything else is `hatch-answer-malformed`.
fn field_value(entry: &Value, n: u64, w: &[i64]) -> Result<encode::Value, Refusal> {
    let Some((name, def)) = field_def(entry, n) else {
        return refuse("field-unknown", n.to_string());
    };
    if def.get("type").and_then(Value::str) != Some("list") {
        return match w {
            [w] => plain_value(entry, name, def, *w),
            _ => refuse(
                "hatch-answer-malformed",
                format!("{name}: {} words; one", w.len()),
            ),
        };
    }
    let of = def.get("of").and_then(Value::obj).unwrap_or(&[]);
    let most = match def.get("most") {
        Some(Value::Int(m)) => usize::try_from(*m).unwrap_or(0),
        _ => 0,
    };
    if of.is_empty() || !w.len().is_multiple_of(of.len()) || w.len() / of.len() > most {
        return refuse(
            "hatch-answer-malformed",
            format!(
                "{name}: {} words; records of {} words, at most {most}",
                w.len(),
                of.len()
            ),
        );
    }
    w.chunks(of.len())
        .map(|r| {
            (1u64..)
                .zip(of.iter().zip(r))
                .map(|(k, ((part, d), w))| Ok((k, plain_value(entry, part, d, *w)?)))
                .collect::<Result<BTreeMap<_, _>, Refusal>>()
                .map(encode::Value::Map)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(encode::Value::Array)
}

/// A hatch's verdict, the steps it took and, with a yes, the fields it answered with their new values, in its
/// declared order. A no refuses the act with the hatch's `why` (`hatch-said-no`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub yes: bool,
    pub steps: u64,
    pub sets: Vec<(u64, encode::Value)>,
}

/// Runs a form's hatch (F8) on the values of its declared reads, in order, through `module`, the hatch's module loaded
/// by its hash, with `entry` the kind's entry: the verdict and the fields it answers, or the hatch's own refusal
/// (`hatch-over-budget`, `hatch-trapped`, `hatch-output-malformed`, `hatch-answer-malformed`, ...). A fault is
/// contained in the call. A hatch that answers one field (`{field}`) answers its value, always a yes.
pub fn run_hatch(
    hatch: &Hatch,
    module: &Loaded,
    entry: &Value,
    reads: &[encode::Value],
) -> Result<Verdict, Refusal> {
    let fields: &[u64] = match &hatch.answers {
        Answers::Fields(fs) => fs,
        _ => &[],
    };
    let (ran, written) = module.run_writing(
        &hatch_words(entry, hatch, reads)?,
        hatch.steps_most,
        fields.len(),
    )?;
    if let Answers::Field(f) = hatch.answers {
        return Ok(Verdict {
            yes: true,
            steps: ran.steps,
            sets: vec![(f, field_value(entry, f, &[ran.answer])?)],
        });
    }
    let yes = match ran.answer {
        0 | 1 => ran.answer == 1,
        n => {
            return refuse(
                "hatch-answer-malformed",
                format!("{n}; a verdict is 1 or 0"),
            );
        }
    };
    let sets = fields
        .iter()
        .zip(&written)
        .map(|(f, w)| Ok((*f, field_value(entry, *f, w)?)))
        .collect::<Result<Vec<_>, Refusal>>()?;
    Ok(Verdict {
        yes,
        steps: ran.steps,
        sets,
    })
}

/// The refusal a hatch's no gives the act: `hatch-said-no`, with its `why`.
pub fn hatch_no(hatch: &Hatch) -> Refusal {
    Refusal {
        name: "hatch-said-no",
        detail: hatch.why.as_str().to_owned(),
    }
}

/// The deadlines of the steps that wait on the world, µs from the step's start. A pause's deadline is its own end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub walk: Micros,
    pub step_move: Micros,
    /// The walk's free speed, µm a second, and the world's tick, µs (N7's walk needs both).
    pub speed: i64,
    pub tick: Micros,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            walk: 60_000_000,
            step_move: 10_000_000,
            speed: 1_400_000,
            tick: 50_000,
        }
    }
}

/// Why the world wakes a runner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Woke {
    /// The run starts.
    Start,
    /// Retry a deferred walk plan, retaining the original walk deadline.
    Planning,
    /// A timer on the body fired, by id.
    Timer(Id),
    /// The walk the runner started ended.
    Walked(Progress),
    /// The move the runner asked for ended, with how (`done` when it ran to its end).
    Moved(Name),
    /// The move the runner asked for reached its contact instant (B2: the end of its first phase).
    Contact,
    /// The Soul leaves the run.
    Leave,
}

/// What the runner asks of the world after a wake.
pub enum Next {
    /// Run this walk skill on the body until it ends, then wake the runner with [`Woke::Walked`].
    Walk(Box<dyn Skill>),
    /// The current walk step awaits its off-clock geometry answer.
    Planning,
    /// Start move `name` toward point `at` of `node` (B2; with no point, the move's own contact), then wake the runner
    /// with [`Woke::Moved`].
    Move {
        name: Name,
        node: Id,
        at: Option<Name>,
    },
    /// Take the seat in slot `slot` of `node` by B2's sit (or lie) move through B3's seats, as the gateway's sit
    /// does (C17), then wake the runner with [`Woke::Contact`] at the hand-off and [`Woke::Moved`] at its end. With
    /// `stand`, a standing slot taken on the body's feet (C33, #3598).
    Sit {
        node: Id,
        slot: u64,
        lie: bool,
        stand: bool,
    },
    /// Rise (C25): out of the body's seat by B3's rise, or up from a ground posture, then wake the runner with
    /// [`Woke::Moved`]; at once `done` for a body standing.
    Rise,
    /// Take a ground posture where the body stands (C25), then wake the runner with [`Woke::Moved`].
    Settle { lie: bool },
    /// Nothing until the next wake.
    Sleep,
    /// The run is over, with its name. Whatever the run started and has not ended (a walk, a move, a timer) the world
    /// ends now.
    End(Name),
}

/// A form's run on one body, at one node: the cursor over its bound steps, and its one timer.
pub struct Runner {
    steps: Vec<Step>,
    node: Id,
    limits: Limits,
    /// The step in progress; `steps.len()` once ended.
    at: usize,
    /// The runner's timer: the step's deadline, or a pause's end.
    timer: Option<Id>,
    ended: bool,
    planning: bool,
    /// The hand step: the last step, when it is a `move`, [`Step::Hand`], `sit` or `use_held` step, or a `sit` followed
    /// only by waits, whose contact is the effect's instant; with none, the effect's instant is the last step's end.
    hand: Option<usize>,
    /// The effect's instant came and the world has not taken it; `effected` once it came.
    effect: bool,
    effected: bool,
    /// The Soul left during a move: the run ends `left` at the move's next phase boundary.
    leaving: bool,
    /// The approach walk in progress crossed a link (into a building, #3688): when it ends, the body approaches the
    /// point again from the floor it came onto.
    again: bool,
    /// When the step in progress began, µs: a repeated move ([`Step::Move`]'s `repeat`) goes on until its length
    /// has passed since then.
    since: Micros,
    /// The move asked for last is a repeat of the step's move that writes no record for viewers: neither its first nor
    /// one [`REWRITE_US`] after the last record ([`Runner::repeat`]).
    again_move: bool,
    /// When the step's record for viewers was last written, µs.
    recorded: Micros,
    /// A seat of another thing was handed in after the Soul left (E14): once the sit's move ends, the run takes the
    /// body out again by a rise, then ends `left`.
    backing: bool,
    /// That rise is under way: the run ends `left` when it ends, not at its contact, so the world writes the body
    /// standing (the rise's `done`) before the run is over.
    rising_out: bool,
}

impl Runner {
    pub fn new(steps: Vec<Step>, node: Id, limits: Limits) -> Runner {
        // The last step's contact: a hand step with a step after it (a wait, the next of repeated moves, a rise)
        // would land the effect before the run is done, so a Soul that leaves then would keep it (E7). A seat taken
        // and then only waited in is the one exception: the posture outlives the run, so its contact stays the
        // effect's instant (a swing's link to its swinger), and a leave during the waits keeps it (rule 10).
        let hand = steps
            .iter()
            .rposition(|s| {
                matches!(
                    s,
                    Step::Move { .. } | Step::Hand | Step::Sit { .. } | Step::UseHeld
                )
            })
            .filter(|&i| {
                i + 1 == steps.len()
                    || matches!(steps[i], Step::Sit { .. })
                        && steps[i + 1..].iter().all(|s| matches!(s, Step::Wait(_)))
            });
        Runner {
            steps,
            node,
            limits,
            at: 0,
            timer: None,
            ended: false,
            planning: false,
            hand,
            effect: false,
            effected: false,
            leaving: false,
            again: false,
            since: 0,
            again_move: false,
            recorded: 0,
            backing: false,
            rising_out: false,
        }
    }

    /// Whether the effect's instant came at the last wake: true once per run, at most, and only then.
    pub fn take_effect(&mut self) -> bool {
        std::mem::take(&mut self.effect)
    }

    fn effect_now(&mut self) {
        if !self.effected {
            self.effected = true;
            self.effect = true;
        }
    }

    /// The step in progress, if the run has not ended.
    pub fn step(&self) -> Option<&Step> {
        if self.ended {
            None
        } else {
            self.steps.get(self.at)
        }
    }

    /// The step after the one in progress, if the run has not ended and there is one.
    pub fn next_step(&self) -> Option<&Step> {
        self.step()?;
        self.steps.get(self.at + 1)
    }

    /// The step in progress is a repeated move (a dance for a minute): when the step began and its length, µs, and
    /// whether the move asked for last writes no record for viewers. The world writes a record at the first move and
    /// again at the first repeat [`REWRITE_US`] after the last one, each planned to the latest the step can end, and
    /// none for the other repeats; the run's end cuts it (0.135).
    pub fn repeat(&self) -> Option<(Micros, Micros, bool)> {
        match self.step()? {
            Step::Move {
                repeat: Some(r), ..
            } => Some((self.since, *r, self.again_move)),
            _ => None,
        }
    }

    /// The number of the step in progress, if the run has not ended.
    pub fn at(&self) -> Option<usize> {
        self.step().map(|_| self.at)
    }

    fn end(&mut self, host: &mut dyn Host, how: Name) -> Next {
        if let Some(t) = self.timer.take() {
            host.clear_timer(t);
        }
        self.ended = true;
        Next::End(how)
    }

    /// Starts step `self.at`, or ends the run `done` past the last.
    fn begin(&mut self, host: &mut dyn Host) -> Next {
        if !self.planning
            && let Some(t) = self.timer.take()
        {
            host.clear_timer(t);
        }
        let Some(step) = self.steps.get(self.at).cloned() else {
            if self.hand.is_none() {
                self.effect_now();
            }
            return self.end(host, name("done"));
        };
        match step {
            Step::WalkTo {
                at, on, approach, ..
            } => {
                // An approach to a hand step's thing is not walked by a body already within reach of it (#4086).
                if approach
                    && matches!(self.steps.get(self.at + 1), Some(Step::Hand))
                    && host.within_reach(self.node) == Some(true)
                {
                    self.planning = false;
                    return self.advance(host);
                }
                // A thing argument's place is read now, at the step's start (F14).
                let Some(node) = host.read(on.unwrap_or(self.node)) else {
                    return self.end(host, name("node-gone"));
                };
                let to = Vec3::new(
                    node.position.x.saturating_add(at.x),
                    node.position.y.saturating_add(at.y),
                    node.position.z.saturating_add(at.z),
                );
                // The world's legs to the point, or to the nearest place within reach where a body may stand, across
                // the links on the way (C17), the point in its node's parent's frame. A world that does not say: from
                // the nearest place within reach (C15), else to the point itself, on the ground the body stands on.
                let reach = match self.steps.get(self.at + 1) {
                    Some(Step::Sit { .. }) => SIT_REACH,
                    Some(Step::Hand) if approach => HAND_REACH,
                    _ if approach => APPROACH_REACH,
                    _ => REACH,
                };
                let plan = node.parent.map_or(replica::host::WalkPlan::Unplanned, |p| {
                    host.plan_walk(self.at, p, to, reach)
                });
                if self.timer.is_none() {
                    self.timer =
                        Some(host.set_timer(self.limits.walk, name("souls:form-deadline")));
                }
                let legs = match plan {
                    replica::host::WalkPlan::Pending => {
                        self.planning = true;
                        return Next::Planning;
                    }
                    replica::host::WalkPlan::Legs(l) if l.is_empty() && approach => {
                        // No way to the point: the move is tried from here, and judges its own reach.
                        self.planning = false;
                        return self.advance(host);
                    }
                    replica::host::WalkPlan::Legs(l) if l.is_empty() => {
                        return self.end(host, name("souls:no-way"));
                    }
                    // The planner's own refusal (the ground changed under the walk, its answer failed), approach or
                    // not: the form ends with that cause (S13d).
                    replica::host::WalkPlan::Refused(why) => {
                        self.planning = false;
                        return self.end(host, why);
                    }
                    replica::host::WalkPlan::Legs(l) => {
                        self.again = approach && !self.again && l.iter().any(|(_, k)| k.is_some());
                        l.into_iter().map(|(to, link)| Leg { to, link }).collect()
                    }
                    replica::host::WalkPlan::Unplanned => vec![Leg {
                        to: host.stand_near(to, reach).unwrap_or(to),
                        link: None,
                    }],
                };
                self.planning = false;
                let mut walk = Route::new(legs, self.limits.speed, self.limits.tick);
                // A walk right before a move ends on the point the move is reached from, as a walk to a granted
                // standing spot does (0.135 E20): AT_GOAL short of it, the move's point can be out of its reach.
                // An approach to a hand step's thing ends on its place too, so the body is within the world's reach
                // ([`HAND_REACH`]); a form's own walk before a bare hand step arrives as it did.
                let next = self.steps.get(self.at + 1);
                if matches!(next, Some(Step::Move { .. }))
                    || approach && matches!(next, Some(Step::Hand))
                {
                    walk.arrive = crate::route::AT_SPOT;
                }
                Next::Walk(Box::new(walk))
            }
            Step::Move {
                name: mv, at, on, ..
            } => {
                self.since = host.now();
                self.again_move = false;
                self.recorded = self.since;
                self.timer =
                    Some(host.set_timer(self.limits.step_move, name("souls:form-deadline")));
                Next::Move {
                    name: mv,
                    node: on.unwrap_or(self.node),
                    at,
                }
            }
            Step::Sit {
                slot,
                lie,
                stand,
                on,
            } => {
                self.timer =
                    Some(host.set_timer(self.limits.step_move, name("souls:form-deadline")));
                Next::Sit {
                    node: on.unwrap_or(self.node),
                    slot,
                    lie,
                    stand,
                }
            }
            // A hand's contact needs its thing within reach, however the steps before it ended (#4086): an approach
            // that found no way, a walk that stopped short, a thing moved meanwhile. Nothing is taken from afar.
            Step::Hand => {
                if host.within_reach(self.node) == Some(false) {
                    return self.end(host, name("out-of-reach"));
                }
                if self.hand == Some(self.at) {
                    self.effect_now();
                }
                self.advance(host)
            }
            Step::Wait(us) => {
                self.timer = Some(host.set_timer(us, name("souls:form-wait")));
                Next::Sleep
            }
            Step::Rise | Step::Settle { .. } => {
                self.timer =
                    Some(host.set_timer(self.limits.step_move, name("souls:form-deadline")));
                match step {
                    Step::Settle { lie } => Next::Settle { lie },
                    _ => Next::Rise,
                }
            }
            // The thing is in the body's hand: its parent in the tree is the body (B4's take).
            Step::UseHeld => {
                let body = host.body();
                if host.read(self.node).and_then(|n| n.parent) != Some(body) {
                    return self.end(host, name("not-held"));
                }
                if self.hand == Some(self.at) {
                    self.effect_now();
                }
                self.advance(host)
            }
        }
    }

    fn advance(&mut self, host: &mut dyn Host) -> Next {
        self.at += 1;
        self.again = false;
        self.begin(host)
    }

    /// Wakes the runner: it starts its next step, sleeps on, or ends. A wake that is not for the step in progress (a
    /// timer that is not the runner's, a walk's end during a move, anything after the end) changes nothing.
    pub fn wake(&mut self, host: &mut dyn Host, why: Woke) -> Next {
        if self.ended {
            return Next::Sleep;
        }
        let step = self.steps.get(self.at).cloned();
        // A move is left at its next phase boundary; anything else at once. A run left has no effect from then on.
        if why == Woke::Leave {
            if matches!(
                step,
                Some(Step::Move { .. } | Step::Sit { .. } | Step::Rise)
            ) {
                self.leaving = true;
                return Next::Sleep;
            }
            return self.end(host, name("left"));
        }
        if self.leaving {
            // A seat of another thing (E14) that its sit hands the body into after the Soul left has no effect, so the
            // Soul would keep that thing's seat with nothing it did there: the sit's move ends, then a rise takes the
            // body out onto the seat's stand point by B3's own rise (no teleport), and the run ends `left`.
            let other_seat = matches!(
                step,
                Some(Step::Sit {
                    on: Some(_),
                    stand: false,
                    ..
                })
            );
            return match why {
                Woke::Timer(id) if self.timer == Some(id) => {
                    self.timer = None;
                    self.end(host, name("left"))
                }
                Woke::Contact if self.rising_out => Next::Sleep,
                Woke::Contact if other_seat && !self.effected => {
                    self.backing = true;
                    Next::Sleep
                }
                Woke::Moved(how) if self.backing && how.as_str() == "done" => {
                    self.backing = false;
                    if let Some(t) = self.timer.take() {
                        host.clear_timer(t);
                    }
                    self.timer =
                        Some(host.set_timer(self.limits.step_move, name("souls:form-deadline")));
                    // The step in progress is the rise now, so the world writes the body standing when it ends.
                    self.steps[self.at] = Step::Rise;
                    self.rising_out = true;
                    Next::Rise
                }
                Woke::Contact | Woke::Moved(_) => self.end(host, name("left")),
                _ => Next::Sleep,
            };
        }
        match (why, step) {
            (Woke::Planning, Some(Step::WalkTo { .. })) if self.planning => self.begin(host),
            (Woke::Start, _) if self.at == 0 && self.timer.is_none() => self.begin(host),
            (Woke::Timer(id), Some(step)) if self.timer == Some(id) => {
                self.timer = None;
                match step {
                    Step::Wait(_) => self.advance(host),
                    _ => self.end(host, name("deadline-passed")),
                }
            }
            (Woke::Walked(p), Some(Step::WalkTo { .. })) => match p {
                // In through a link: the approach again, from the floor the body came onto (#3688).
                Progress::Done if self.again => self.begin(host),
                Progress::Done => self.advance(host),
                Progress::Failed(n) => self.end(host, n),
                Progress::Going => Next::Sleep,
            },
            (Woke::Contact, Some(Step::Move { .. } | Step::Sit { .. }))
                if self.hand == Some(self.at) =>
            {
                self.effect_now();
                Next::Sleep
            }
            // A repeated move that ran to its end starts again at once while its length has not passed.
            (
                Woke::Moved(how),
                Some(Step::Move {
                    name: mv,
                    at,
                    on,
                    repeat: Some(r),
                }),
            ) if how.as_str() == "done" && host.now().saturating_sub(self.since) < r => {
                if let Some(t) = self.timer.take() {
                    host.clear_timer(t);
                }
                self.timer =
                    Some(host.set_timer(self.limits.step_move, name("souls:form-deadline")));
                // A record again once REWRITE_US have passed since the last, so a viewer who comes in mid-dance (a
                // page opened, reloaded or caught up) is given it within that long; else none.
                let now = host.now();
                self.again_move = now.saturating_sub(self.recorded) < REWRITE_US;
                if !self.again_move {
                    self.recorded = now;
                }
                Next::Move {
                    name: mv,
                    node: on.unwrap_or(self.node),
                    at,
                }
            }
            (
                Woke::Moved(how),
                Some(Step::Move { .. } | Step::Sit { .. } | Step::Rise | Step::Settle { .. }),
            ) => {
                if how.as_str() == "done" {
                    self.advance(host)
                } else {
                    self.end(host, how)
                }
            }
            _ => Next::Sleep,
        }
    }
}
