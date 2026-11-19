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
//! Not here: who may (F6), stages of long forms (F11), a thing made or set down where there is no slot (E4).

use std::collections::BTreeMap;

use replica::effects::Refusal;
use replica::encode::{self, Name};
use replica::host::{Host, Progress, Skill};
use replica::ids::Id;
use replica::pose::Vec3;
use replica::rules::json::Value;
use replica::time::Micros;

use crate::route::{Leg, Route};

/// One step of a form, bound. The closed list is SA-F1's (`walk_to`, `sit`, `rise`, `move`, `take`, `put`,
/// `use_held`, `wait`, `settle`); the kinds F1 builds are these three, and F4's `take` and `put` are bound as a `move`
/// (their transfer is an effect, [`Effect::Take`] and [`Effect::Put`]). The rest are refused by name at bind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Walk to a point of the node, µm in the node's frame.
    WalkTo { point: Name, at: Vec3 },
    /// A move by name toward a point of the node.
    Move { name: Name, at: Name },
    /// A pause of a fixed length, µs.
    Wait(Micros),
}

/// The step kinds of SA-F1's closed list that later tasks build. A form that has one is refused `step-not-built`.
pub const NOT_BUILT: [&str; 4] = ["sit", "rise", "use_held", "settle"];

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

/// A point of the kind, `points.<name>.at_mm`, as µm.
fn point(entry: &Value, p: &str) -> Result<Vec3, Refusal> {
    let mm = entry
        .get("points")
        .and_then(|ps| ps.get(p))
        .and_then(|pt| pt.get("at_mm"))
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

/// Binds form `form` of the kind `entry` (a `souls-entry/1` entry) into its steps, all or none: `form-unknown`,
/// `form-has-no-steps`, `step-not-built` (with the step's kind), `step-unknown`, `step-malformed`, `point-unknown`.
pub fn bind(entry: &Value, form: &str) -> Result<Vec<Step>, Refusal> {
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
                    let p = text(s.get("point"), "walk_to.point")?;
                    Ok(Step::WalkTo {
                        point: a_name(p)?,
                        at: point(entry, p)?,
                    })
                }
                "move" | "take" | "put" => {
                    let at = text(s.get("at"), "move.at")?;
                    point(entry, at)?;
                    Ok(Step::Move {
                        name: move_name(text(s.get("move"), "move.move")?)?,
                        at: a_name(at)?,
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

/// One effect of a form, bound. The world works each out at the effect's instant, against the tree (`sim::forms`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Field `field` (its number in the kind's `state`) of the node the form is done at is set to `to`.
    Set { field: u64, to: encode::Value },
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
    bind_effects_with(entry, form, &BTreeMap::new())
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
fn of(v: Option<&Value>, args: &BTreeMap<String, Id>) -> Result<Of, Refusal> {
    let Some(v) = v.filter(|v| v.str() != Some("this")) else {
        return Ok(Of::This);
    };
    match v.get("arg").and_then(Value::str) {
        Some(a) => args.get(a).map(|id| Of::Node(*id)).ok_or_else(|| Refusal {
            name: "arg-missing",
            detail: a.to_owned(),
        }),
        None => refuse("effect-malformed", "a thing is \"this\" or {\"arg\": name}"),
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

/// Binds form `form`'s effects, all or none, with its thing arguments `args` (name to id): first each `take` or `put`
/// step's transfer, in step order, then the form's `effects`: `set ... to` on the node, `transfer`, `create` into the
/// actor's hand or a slot (`into`: `"actor_hand"` or a slot's name), `remove`, and `link` and `unlink` (`from`:
/// `"actor"`, or `"all"` to unlink) of a link the kind declares. Refused: `effect-not-built` for any other change (a
/// `create` `here` is E4's, a link not seen by everyone T8's), `field-unknown`, `slot-unknown`, `link-unknown`, `arg-missing`, `effect-malformed` for a
/// value that is not a whole number or a flag (a flag is 0 or 1), or an amount that is not a whole number above zero
/// or `"room"`.
pub fn bind_effects_with(
    entry: &Value,
    form: &str,
    args: &BTreeMap<String, Id>,
) -> Result<Vec<Effect>, Refusal> {
    let Some(f) = entry.get("forms").and_then(|fs| fs.get(form)) else {
        return refuse("form-unknown", form);
    };
    let mut out = Vec::new();
    for s in f.get("steps").and_then(Value::arr).unwrap_or(&[]) {
        match s.get("step").and_then(Value::str) {
            Some("take") => out.push(Effect::Take {
                what: of(s.get("what"), args)?,
            }),
            Some("put") => out.push(Effect::Put {
                what: of(s.get("what"), args)?,
                slot: slot_n(entry, text(s.get("slot"), "put.slot")?)?,
            }),
            _ => {}
        }
    }
    for e in f.get("effects").and_then(Value::arr).unwrap_or(&[]) {
        let change = text(e.get("change"), "effect.change")?;
        out.push(match (change, e.get("to")) {
            ("set", Some(to)) => {
                let field = field_n(entry, text(e.get("field"), "effect.field")?)?;
                let to = match to {
                    Value::Bool(b) => encode::Value::Uint(u64::from(*b)),
                    Value::Int(n) => match (u64::try_from(*n), i64::try_from(*n)) {
                        (Ok(u), _) => encode::Value::Uint(u),
                        (_, Ok(i)) => encode::Value::Nint(i.unsigned_abs() - 1),
                        _ => return refuse("effect-malformed", "set.to: out of range"),
                    },
                    _ => return refuse("effect-malformed", "set.to: a whole number or a flag"),
                };
                Effect::Set { field, to }
            }
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
    /// Start move `name` toward point `at` of `node` (B2), then wake the runner with [`Woke::Moved`].
    Move { name: Name, node: Id, at: Name },
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
    /// The hand step: the first `move` step, whose contact is the effect's instant.
    hand: Option<usize>,
    /// The effect's instant came and the world has not taken it; `effected` once it came.
    effect: bool,
    effected: bool,
    /// The Soul left during a move: the run ends `left` at the move's next phase boundary.
    leaving: bool,
}

impl Runner {
    pub fn new(steps: Vec<Step>, node: Id, limits: Limits) -> Runner {
        let hand = steps.iter().position(|s| matches!(s, Step::Move { .. }));
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
            Step::WalkTo { at, .. } => {
                let Some(node) = host.read(self.node) else {
                    return self.end(host, name("node-gone"));
                };
                let to = Vec3::new(
                    node.position.x.saturating_add(at.x),
                    node.position.y.saturating_add(at.y),
                    node.position.z.saturating_add(at.z),
                );
                self.timer = Some(host.set_timer(self.limits.walk, name("souls:form-deadline")));
                let leg = Leg { to, link: None };
                Next::Walk(Box::new(Route::new(
                    vec![leg],
                    self.limits.speed,
                    self.limits.tick,
                )))
            }
            Step::Move { name: mv, at } => {
                self.timer =
                    Some(host.set_timer(self.limits.step_move, name("souls:form-deadline")));
                Next::Move {
                    name: mv,
                    node: self.node,
                    at,
                }
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
            if matches!(step, Some(Step::Move { .. })) {
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
            (Woke::Contact, Some(Step::Move { .. })) if self.hand == Some(self.at) => {
                self.effect_now();
                Next::Sleep
            }
            (Woke::Moved(how), Some(Step::Move { .. })) => {
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
