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
//! Not here: effects (F2), reserving and stopping (F3), who may (F6), stages of long forms (F11).

use replica::effects::Refusal;
use replica::encode::Name;
use replica::host::{Host, Progress, Skill};
use replica::ids::Id;
use replica::pose::Vec3;
use replica::rules::json::Value;
use replica::time::Micros;

use crate::route::{Leg, Route};

/// One step of a form, bound. The closed list is SA-F1's (`walk_to`, `sit`, `rise`, `move`, `take`, `put`,
/// `use_held`, `wait`, `settle`); the kinds F1 builds are these three, the rest are refused by name at bind.
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
pub const NOT_BUILT: [&str; 6] = ["sit", "rise", "take", "put", "use_held", "settle"];

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
                "move" => {
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
}

impl Runner {
    pub fn new(steps: Vec<Step>, node: Id, limits: Limits) -> Runner {
        Runner {
            steps,
            node,
            limits,
            at: 0,
            timer: None,
            ended: false,
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
