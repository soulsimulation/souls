//! The form runner (Engine v2 F1, #2766): one skill that carries out any form's steps from data. A form is the data
//! description of an act (`souls-entry/1`, read as R2's JSON, `replica::rules::json`); no code here names a kind, a
//! form or a move.
//!
//! - **Bound once.** [`bind`] turns a form's steps into a closed list of [`Step`]s, all or none, before the run
//!   starts: a step kind not built yet is refused by name (`step-not-built`), as is a point the kind does not declare
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
//!   first `move` step: the world wakes the runner with [`Woke::Contact`] when that move's start-up ends), or, in a
//!   form with no hand step, when the last step ends. The runner only says when ([`Runner::take_effect`]); the world
//!   writes the effect, keyed by intent, and never twice (`sim::forms`). Stopped before that instant, a run has no
//!   effect; stopped after, its effect stays. [`bind_effects`] binds a form's effects as generic sets, one field each.
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
//!   the daemon and a page give the same verdict at the same counted steps.
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
//! Not here: who may (F6), stages of long forms (F11), a thing made or set down where there is no slot (E4).

use std::collections::BTreeMap;

use replica::effects::Refusal;
use replica::encode::{self, Name};
use replica::hatch::Loaded;
use replica::host::{Answers, Hatch, Host, Progress, Skill};
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::rules::json::Value;
use replica::time::Micros;

use crate::route::{Leg, Route};

/// One step of a form, bound. The closed list is SA-F1's (`walk_to`, `sit`, `rise`, `move`, `take`, `put`,
/// `use_held`, `wait`, `settle`); the kinds F1 builds are these, and F4's `take` and `put` are bound as a `move`
/// (their transfer is an effect, [`Effect::Take`] and [`Effect::Put`]), or as a [`Step::Hand`] when they name no
/// move. The rest are refused by name at bind.
///
/// Where a step aims (F14, #3384): a name the kind declares (a point, a slot's stand point or its place, or a placed
/// area), the same through a name argument (`{"arg": ...}` of type `part`, `slot` or `field`), or a thing argument
/// (`on`), whose place the runner reads when the step starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Walk to a point of the node (or of thing `on`), µm in its frame.
    WalkTo {
        point: Name,
        at: Vec3,
        on: Option<Id>,
    },
    /// A move by name toward a point of the node (or of thing `on`); with no point, the move's own contact.
    Move {
        name: Name,
        at: Option<Name>,
        on: Option<Id>,
    },
    /// A `take` or `put` that names no move: a hand step whose contact is its start.
    Hand,
    /// A pause of a fixed length, µs.
    Wait(Micros),
    /// Sit, or lie, in slot `slot` of the node (C17): B3's seat taken by B2's sit or lie move, as the gateway's sit
    /// takes it. It lies when the slot's posture is `lie` or the step is a `lie`.
    Sit { slot: u64, lie: bool },
}

/// How far from a point a walk to it may end, µm, when a body cannot stand on the point itself (C15, #3447): an arm
/// (the longest reach a move may state) and a body, as today's engine counts a stand point's reach.
pub const REACH: i64 = replica::moves::REACH_MOST + 600_000;

/// How far from a seat's stand point the place a walk before a `sit` or `lie` step goes to may be (C17, #3453), µm:
/// the sit's and the lie's own reach (B2's data, a body's 0.6 m) less how near the walk comes to its end
/// ([`crate::route::AT_GOAL`]), so the seat is in reach where the walk stops.
pub const SIT_REACH: i64 = 600_000 - crate::route::AT_GOAL;

/// An argument of a Soul's act, as the world hands it to the forms (F14, #3384): a name from the kind's own lists (a
/// `part`, `slot`, `field` or `value` argument), a thing by its id (`thing`), words kept by their reference (`text`:
/// T8, K16's store holds the words and the intent carries `{21: id}`), or a whole number (`count`, `duration`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Arg {
    Name(String),
    Node(Id),
    Text(Id),
    Int(i64),
}

/// A form's arguments by name.
pub type Args = BTreeMap<String, Arg>;

/// The step kinds of SA-F1's closed list that later tasks build. A form that has one is refused `step-not-built`.
pub const NOT_BUILT: [&str; 3] = ["rise", "use_held", "settle"];

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

/// A move named in a form: a bare name is in the `souls` namespace, as the engine's moves are (B2).
fn move_name(t: &str) -> Result<Name, Refusal> {
    if t.contains(':') {
        a_name(t)
    } else {
        a_name(&format!("souls:{t}"))
    }
}

/// Where a step aims (F14): a declared name, or `{"arg": a}` bound from `args`: a name argument as the declared name
/// it names, a thing argument as the thing itself (`on`; its own origin, read when the step starts). Refused
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
        Some(Arg::Node(id)) => Ok((a_name(a)?, Vec3::ZERO, Some(*id))),
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
/// node with the move's own contact. Refused: `form-unknown`, `form-has-no-steps`, `step-not-built` (with the step's
/// kind), `step-unknown`, `step-malformed`, `point-unknown`, `arg-missing`.
pub fn bind_with(entry: &Value, form: &str, args: &Args) -> Result<Vec<Step>, Refusal> {
    let Some(f) = entry.get("forms").and_then(|fs| fs.get(form)) else {
        return refuse("form-unknown", form);
    };
    let steps = f.get("steps").and_then(Value::arr).unwrap_or(&[]);
    if steps.is_empty() {
        return refuse("form-has-no-steps", form);
    }
    steps
        .iter()
        .map(|s| {
            let kind = text(s.get("step"), "step")?;
            match kind {
                "walk_to" => {
                    let Some(p) = s.get("point") else {
                        return refuse("step-malformed", "walk_to.point: a name");
                    };
                    let (point, at, on) = aim(entry, p, args, "walk_to.point")?;
                    Ok(Step::WalkTo { point, at, on })
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
                k if NOT_BUILT.contains(&k) => refuse("step-not-built", k),
                k => refuse("step-unknown", k),
            }
        })
        .collect()
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
        } = s
        {
            *at = q.rotate(*at).map_err(|e| Refusal {
                name: "point-unturnable",
                detail: format!("{}: {e:?}", point.as_str()),
            })?;
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
    Transfer {
        field: u64,
        from: Of,
        into: Of,
        amount: Amount,
    },
    /// A thing of kind `kind` made into `into`, refused when that is not free (F4).
    Make { kind: Name, into: Place },
    /// Thing `what` removed: one the node contains or the body holds (F4).
    Remove { what: Of },
    /// A `take` step's transfer (B4's, at its contact): `what` into a free hand of the body.
    Take { what: Of },
    /// A `put` step's transfer (B4's, at its contact): `what`, held by the body, into slot `slot` of the node.
    Put { what: Of, slot: u64 },
    /// A link of type `ty` (the tree's, `replica::audience::link_type`) from the actor to the node, owned by the node
    /// and seen by everyone (F15): its end the actor's Soul when `soul`, else its body.
    Link { ty: Name, soul: bool },
    /// The node's own links of type `ty` taken down (F15): the actor's (its Soul's when `soul`, else its body's), or
    /// every one when `all`.
    Unlink { ty: Name, soul: bool, all: bool },
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

/// How much a transfer asks: a whole number of the field's unit, above zero, or all the room the target has left.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Amount {
    Units(i64),
    Room,
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

/// The value a `set` writes to field `field` (F14), as the entry format allows it: a whole number or a flag, a value
/// of an `enum` field (a name, refused `value-unknown` when the field does not list it), no words (`null`, `{}`) for a
/// `text` field, and through an argument the same, a thing's id or words' reference (`{21: id}`, K16) for a `text`
/// field. Refused `effect-malformed` otherwise.
fn set_to(entry: &Value, field: &str, to: &Value, args: &Args) -> Result<encode::Value, Refusal> {
    let def = entry.get("state").and_then(|s| s.get(field));
    let ty = def.and_then(|d| d.get("type")).and_then(Value::str);
    let named = |v: &str| {
        let listed = def
            .and_then(|d| d.get("values"))
            .and_then(Value::arr)
            .unwrap_or(&[])
            .iter()
            .any(|x| x.str() == Some(v));
        match (ty, listed, Name::new(v)) {
            (Some("enum"), true, Some(n)) => Ok(encode::Value::Text(n)),
            (Some("enum"), _, _) => refuse("value-unknown", format!("{field}: {v}")),
            _ => refuse("effect-malformed", format!("set.to: {field} takes no name")),
        }
    };
    let int = |n: i128| match (u64::try_from(n), i64::try_from(n)) {
        (Ok(u), _) => Ok(encode::Value::Uint(u)),
        (_, Ok(i)) => Ok(encode::Value::Nint(i.unsigned_abs() - 1)),
        _ => refuse("effect-malformed", "set.to: out of range"),
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
fn args_in(
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

/// [`bind_with`], with the form's slot arguments by number (C12): a `walk_to` naming a slot argument walks to that
/// slot's `stand` point, or to the slot itself when it names none.
pub fn bind_in(
    entry: &Value,
    form: &str,
    slots: &BTreeMap<String, u64>,
) -> Result<Vec<Step>, Refusal> {
    bind_with(entry, form, &args_in(entry, &BTreeMap::new(), slots)?)
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
/// argument; the value as [`set_to`] reads it, F14), `transfer`, `create` into the actor's hand or a slot (`into`:
/// `"actor_hand"` or a slot's name), `remove`, and `link` and `unlink` (`from`: `"actor"`, or `"all"` to unlink) of a
/// link the kind declares (F15). Refused: `effect-not-built` for any other change (a `create` `here` is E4's, a link
/// not seen by everyone T8's), `field-unknown`, `slot-unknown`, `link-unknown`, `arg-missing`, `value-unknown`,
/// `effect-malformed` for a value the field cannot take, or an amount that is not a whole number above zero or
/// `"room"`.
/// A `put` names its slot, or a slot argument (`{"arg": a}`). A `take` or `put` with no `what` moves the thing the
/// form's `reparent` effect into the same place names (the actor's hand, or that slot), else the node itself; that
/// `reparent` is the step's transfer, bound once (C12, #3427). A `reparent` no take or put carries is
/// `effect-not-built`.
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
                let slot = match into.get("arg").and_then(Value::str) {
                    Some(a) => match args.get(a) {
                        Some(Arg::Name(n)) => slot_n(entry, n)?,
                        Some(_) => {
                            return refuse("step-malformed", format!("argument {a} is not a slot"));
                        }
                        None => return refuse("arg-missing", a),
                    },
                    None => slot_n(entry, text(Some(into), "put.slot")?)?,
                };
                out.push(Effect::Put {
                    what: what(s, into)?,
                    slot,
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
            // Between two fields of one thing is not built here.
            ("transfer", _) if e.get("into_field").is_some() => {
                return refuse("effect-not-built", "transfer into_field");
            }
            ("transfer", _) => Effect::Transfer {
                field: field_n(entry, text(e.get("field"), "transfer.field")?)?,
                from: of(e.get("from"), args)?,
                into: of(e.get("into"), args)?,
                amount: match e.get("amount") {
                    Some(Value::Int(n)) if *n > 0 => match i64::try_from(*n) {
                        Ok(n) => Amount::Units(n),
                        Err(_) => return refuse("effect-malformed", "transfer.amount: too large"),
                    },
                    Some(v) if v.str() == Some("room") => Amount::Room,
                    _ => {
                        return refuse(
                            "effect-malformed",
                            "transfer.amount: a whole number above zero or \"room\"",
                        );
                    }
                },
            },
            ("create", _) => Effect::Make {
                kind: a_name(text(e.get("kind"), "create.kind")?)?,
                into: match text(e.get("into"), "create.into")? {
                    "actor_hand" => Place::Hand,
                    "here" => return refuse("effect-not-built", "create here"),
                    slot => Place::Slot(slot_n(entry, slot)?),
                },
            },
            ("remove", _) => Effect::Remove {
                what: of(e.get("what"), args)?,
            },
            ("link" | "unlink", _) => link(entry, change, e)?,
            (other, _) => return refuse("effect-not-built", other),
        });
    }
    Ok(out)
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
        ("link", Some("actor")) => Ok(Effect::Link { ty, soul }),
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
/// "verdict" | {"field": name}, "why": key}`. A read of a field the kind does not declare is `field-unknown`.
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
        Some(a) => match a.get("field").and_then(Value::str) {
            Some(f) => [
                (1, encode::Value::Uint(2)),
                (2, encode::Value::Uint(field(f)?)),
            ]
            .into(),
            None => return refuse("hatch-not-a-record", "answers is verdict or {field}"),
        },
        None => return refuse("hatch-not-a-record", "answers is verdict or {field}"),
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

/// A read's value as the hatch's words: a whole number is one word, a list or a record its parts' words in order.
fn words(v: &encode::Value, into: &mut Vec<i64>) -> Result<(), Refusal> {
    let not = || Refusal {
        name: "hatch-read-not-a-number",
        detail: "a hatch reads whole numbers, lists and records of them".into(),
    };
    match v {
        encode::Value::Uint(n) => into.push(i64::try_from(*n).map_err(|_| not())?),
        encode::Value::Nint(n) => into.push(-1 - i64::try_from(*n).map_err(|_| not())?),
        encode::Value::Array(vs) => vs.iter().try_for_each(|v| words(v, into))?,
        encode::Value::Map(m) => m.values().try_for_each(|v| words(v, into))?,
        encode::Value::Bytes(_) | encode::Value::Text(_) => return Err(not()),
    }
    Ok(())
}

/// The words a hatch is given for the values of its declared reads, in order (`replica::hatch`'s calling convention):
/// `hatch-reads-differ` when their number is not the declared one, `hatch-read-not-a-number` for text or bytes.
pub fn hatch_words(hatch: &Hatch, reads: &[encode::Value]) -> Result<Vec<Vec<i64>>, Refusal> {
    if reads.len() != hatch.reads.len() {
        return refuse(
            "hatch-reads-differ",
            format!("{} declared, {} given", hatch.reads.len(), reads.len()),
        );
    }
    reads
        .iter()
        .map(|v| {
            let mut w = Vec::new();
            words(v, &mut w).map(|()| w)
        })
        .collect()
}

/// A hatch's verdict and the steps it took. A no refuses the act with the hatch's `why` (`hatch-said-no`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub yes: bool,
    pub steps: u64,
}

/// Runs a form's hatch (F8) on the values of its declared reads, in order, through `module`, the hatch's module loaded
/// by its hash: the verdict, or the hatch's own refusal (`hatch-over-budget`, `hatch-trapped`, ...). A fault is
/// contained in the call. A hatch that answers a field's value is `hatch-answer-not-built`.
pub fn run_hatch(
    hatch: &Hatch,
    module: &Loaded,
    reads: &[encode::Value],
) -> Result<Verdict, Refusal> {
    if hatch.answers != Answers::Verdict {
        return refuse("hatch-answer-not-built", "a hatch answers a verdict");
    }
    let ran = module.run(&hatch_words(hatch, reads)?, hatch.steps_most)?;
    match ran.answer {
        0 | 1 => Ok(Verdict {
            yes: ran.answer == 1,
            steps: ran.steps,
        }),
        n => refuse(
            "hatch-answer-malformed",
            format!("{n}; a verdict is 1 or 0"),
        ),
    }
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
    /// Start move `name` toward point `at` of `node` (B2; with no point, the move's own contact), then wake the runner
    /// with [`Woke::Moved`].
    Move {
        name: Name,
        node: Id,
        at: Option<Name>,
    },
    /// Take the seat in slot `slot` of `node` by B2's sit (or lie) move through B3's seats, as the gateway's sit
    /// does (C17), then wake the runner with [`Woke::Contact`] at the hand-off and [`Woke::Moved`] at its end.
    Sit { node: Id, slot: u64, lie: bool },
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
    /// The hand step: the first `move` (or [`Step::Hand`]) step, whose contact is the effect's instant.
    hand: Option<usize>,
    /// The effect's instant came and the world has not taken it; `effected` once it came.
    effect: bool,
    effected: bool,
    /// The Soul left during a move: the run ends `left` at the move's next phase boundary.
    leaving: bool,
}

impl Runner {
    pub fn new(steps: Vec<Step>, node: Id, limits: Limits) -> Runner {
        let hand = steps
            .iter()
            .position(|s| matches!(s, Step::Move { .. } | Step::Hand | Step::Sit { .. }));
        Runner {
            steps,
            node,
            limits,
            at: 0,
            timer: None,
            ended: false,
            hand,
            effect: false,
            effected: false,
            leaving: false,
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
        if let Some(t) = self.timer.take() {
            host.clear_timer(t);
        }
        let Some(step) = self.steps.get(self.at).cloned() else {
            if self.hand.is_none() {
                self.effect_now();
            }
            return self.end(host, name("done"));
        };
        match step {
            Step::WalkTo { at, on, .. } => {
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
                    _ => REACH,
                };
                let legs = match node.parent.and_then(|p| host.legs(p, to, reach)) {
                    Some(l) if l.is_empty() => return self.end(host, name("souls:no-way")),
                    Some(l) => l.into_iter().map(|(to, link)| Leg { to, link }).collect(),
                    None => vec![Leg {
                        to: host.stand_near(to, reach).unwrap_or(to),
                        link: None,
                    }],
                };
                self.timer = Some(host.set_timer(self.limits.walk, name("souls:form-deadline")));
                Next::Walk(Box::new(Route::new(
                    legs,
                    self.limits.speed,
                    self.limits.tick,
                )))
            }
            Step::Move { name: mv, at, on } => {
                self.timer =
                    Some(host.set_timer(self.limits.step_move, name("souls:form-deadline")));
                Next::Move {
                    name: mv,
                    node: on.unwrap_or(self.node),
                    at,
                }
            }
            Step::Sit { slot, lie } => {
                self.timer =
                    Some(host.set_timer(self.limits.step_move, name("souls:form-deadline")));
                Next::Sit {
                    node: self.node,
                    slot,
                    lie,
                }
            }
            Step::Hand => {
                if self.hand == Some(self.at) {
                    self.effect_now();
                }
                self.advance(host)
            }
            Step::Wait(us) => {
                self.timer = Some(host.set_timer(us, name("souls:form-wait")));
                Next::Sleep
            }
        }
    }

    fn advance(&mut self, host: &mut dyn Host) -> Next {
        self.at += 1;
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
            if matches!(step, Some(Step::Move { .. } | Step::Sit { .. })) {
                self.leaving = true;
                return Next::Sleep;
            }
            return self.end(host, name("left"));
        }
        if self.leaving {
            return match why {
                Woke::Timer(id) if self.timer == Some(id) => {
                    self.timer = None;
                    self.end(host, name("left"))
                }
                Woke::Contact | Woke::Moved(_) => self.end(host, name("left")),
                _ => Next::Sleep,
            };
        }
        match (why, step) {
            (Woke::Start, _) if self.at == 0 && self.timer.is_none() => self.begin(host),
            (Woke::Timer(id), Some(step)) if self.timer == Some(id) => {
                self.timer = None;
                match step {
                    Step::Wait(_) => self.advance(host),
                    _ => self.end(host, name("deadline-passed")),
                }
            }
            (Woke::Walked(p), Some(Step::WalkTo { .. })) => match p {
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
            (Woke::Moved(how), Some(Step::Move { .. } | Step::Sit { .. })) => {
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
