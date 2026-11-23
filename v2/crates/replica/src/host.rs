//! The host interface and the code hatch's shape (contract T9; Engine v2 T9, #2663). A skill touches the world through
//! [`Host`] and nothing else; the built-in skills in `v2/crates/skills` use the same trait, from a crate that depends
//! on `replica` alone. The rules are numbered in `v2/docs/bodies.md`. Running a hatch (F8) is not here.

use std::collections::BTreeMap;

use crate::bodies::SkillShape;
use crate::effects::{Change, Event, Refusal};
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::pose::{ControllerInput, Vec3};
use crate::time::Micros;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// A node as a skill reads it (rule 7): its kind, parent, position in its parent's frame (T4's units) and fields. Its
/// own body is as of this tick; every other node as of the previous tick (T1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seen {
    pub id: Id,
    pub kind: Name,
    pub parent: Option<Id>,
    pub position: Vec3,
    pub fields: BTreeMap<u64, Value>,
}

/// A question about geometry (rule 7), a closed list: N lane's answers, never its data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    /// The straight distance between two nodes, in T4's units.
    Distance { from: Id, to: Id },
    /// The next point on a walkable route from a node toward a point in its parent's frame, or none.
    Toward { from: Id, to: Vec3 },
    /// The other bodies standing on the node the body stands on, within `radius` of it (T4's units), as of the
    /// previous tick (T1): for keeping apart (T9b, #3120). A body being carried across a link is on no node.
    Near { radius: i64 },
}

/// An answer, in integers (rule 7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Distance(i64),
    Point(Vec3),
    /// The bodies near, in id order.
    Near(Vec<Near>),
}

/// A body near the asker (rule 7, `Ask::Near`): its id, position in the shared node's frame and velocity, in T4's
/// units, as of the previous tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Near {
    pub id: Id,
    pub position: Vec3,
    pub velocity: Vec3,
}

/// A field the world shows on a body it is carrying across a link (rule 7, `Host::cross`): the link's id.
pub const F_CROSSING: u64 = 40;
/// A field a walker sets on its own body while it waits for a link taken in turns (N8): `[link id, distance µm]`.
pub const F_WAITING: u64 = 41;
/// A field the world shows on a link taken in turns, read with `Host::read(link)`: always 1 (T9b A3).
pub const F_TURNS: u64 = 42;
/// A field the world shows on a link taken in turns: the body its owner lets in now, if any (T9b A3).
pub const F_GRANTED: u64 = 43;
/// A field the world sets on a walker's body for N10's shoulder turn: 1 while no other body pushes it (T9c).
pub const F_SHOULDER: u64 = 44;
/// A field the world sets on a walker's body when it routes it again (N10, T9c): `[count, [leg, ...]]`, each leg
/// `[x, y, z]` or `[x, y, z, link]` (µm, then the link crossed at its end); a higher count than the walk last took
/// is a new route, walked from its first leg.
pub const F_ROUTE: u64 = 45;
/// A field the world sets on a walker's body while it walks it out to legal ground (N10's last rung, T9c): 1. The
/// walk stands meanwhile, and its mark is cleared.
pub const F_HELD: u64 = 46;
/// A field the world shows on a body standing on the standing spot it was granted (N9, T9c): 1. A walk to its own
/// spot passes between such bodies.
pub const F_SETTLED: u64 = 47;
/// The world-assigned queue spot on a body, `[x, y, z]` in its floor frame (B7).
pub const F_LINE: u64 = 48;
/// A field a walker sets on its own body when its walk ended as near its goal as the crowd there allows, not at it
/// (0.133 A2-4): 1. The world names it in the walk's `done` and takes it off.
pub const F_SHORT: u64 = 49;

/// How a skill's step ended (rule 7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Progress {
    Going,
    Done,
    Failed(Name),
}

/// A walk's geometry answer. Pending is distinct from an unsupported geometry interface or no legal route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WalkPlan {
    Pending,
    Unplanned,
    Legs(Vec<(Vec3, Option<Id>)>),
}

/// The one interface a skill touches the world through (rule 7). The world implements it; a test implements a fake.
/// It offers no clock but world time, no randomness but the world's draw, and no write but the skill's own body's.
pub trait Host {
    /// World time now, in microseconds (T5). Never a machine's clock.
    fn now(&self) -> Micros;
    /// The body this skill runs on.
    fn body(&self) -> Id;
    /// A node: the body as of this tick, any other as of the previous tick.
    fn read(&self, node: Id) -> Option<Seen>;
    /// One field of a node, as [`Host::read`] shows it: a world may answer without copying the rest of the node.
    fn field(&self, node: Id, field: u64) -> Option<Value> {
        self.read(node)?.fields.remove(&field)
    }
    /// A node's position, as [`Host::read`] shows it.
    fn position(&self, node: Id) -> Option<Vec3> {
        self.read(node).map(|s| s.position)
    }
    /// An answer about geometry, in integers, or none.
    fn ask(&self, q: &Ask) -> Option<Answer>;
    /// Where the body may stand within `reach` of `at` (µm, the frame of the node it stands on) to act there (C15,
    /// #3447): `at` itself, else the nearest such place; `None` when there is none, or the world does not say.
    fn stand_near(&self, _at: Vec3, _reach: i64) -> Option<Vec3> {
        None
    }
    /// The legs of a walk to point `at` of node `node`'s frame (µm), or to the nearest place within `reach` of it
    /// where a body may stand (C17, #3453): each leg a point (µm, the frame of the ground the body stands on then) and
    /// the link it then crosses, the last none. Empty when there is no way there; `None` when the world does not say.
    fn legs(&self, _node: Id, _at: Vec3, _reach: i64) -> Option<Vec<(Vec3, Option<Id>)>> {
        None
    }
    /// Plans one form step; a deferred world retries Pending without restarting its deadline.
    fn plan_walk(&self, _step: usize, node: Id, at: Vec3, reach: i64) -> WalkPlan {
        self.legs(node, at, reach)
            .map_or(WalkPlan::Unplanned, WalkPlan::Legs)
    }
    /// A timer on the body, due `after` microseconds of world time from now, named for what it is for (T6 rule 15).
    fn set_timer(&mut self, after: Micros, name: Name) -> Id;
    /// Clears a timer the skill set (fired or cancelled).
    fn clear_timer(&mut self, timer: Id);
    /// A draw from the world's random numbers (T1's seeded RNG).
    fn draw(&mut self) -> u64;
    /// A controller input for the body: T4's own type (B1 turns it into motion).
    fn control(&mut self, input: ControllerInput);
    /// Asks the world to carry the body across `link` by the link's move (T4: a link names the move that crosses
    /// it), at `speed` µm a second at most. A granted request, carried out after the phase by the controller, the body's one mover: while it is
    /// carried, its read shows [`F_CROSSING`] and its velocity inputs wait. A shut door in the link is opened for it
    /// by the world (the body as the acting Soul), and it stands that tick; the skill asks again the next.
    fn cross(&mut self, link: Id, speed: i64);
    /// One entry of the body's own node (T6 rule 6): generic changes, applied all or none, and what they meant. A
    /// change to any node but the body and those the same changes create under it is refused (`write-outside-own`).
    fn emit(&mut self, changes: Vec<Change>, meaning: Option<Event>) -> R<()>;
}

/// A skill (rule 7): its shape and its step. It keeps nothing outside itself, and its state in progress is never
/// stored: on a restart the intent is handed to the skill again, or ended with a named reason (rule 9). A skill only
/// asks; the claims it holds are made by the body (rule 4), so nothing a skill returns needs sealing.
pub trait Skill {
    fn shape(&self) -> SkillShape;
    fn step(&mut self, host: &mut dyn Host) -> Progress;
    /// This skill, if the world may step it on another thread, beside other bodies' skills (N17b, #3255): only a
    /// skill whose step never draws and never sets a timer (both are numbered in the tick's order; such a step is
    /// refused by a panic, at any thread count). `None`, the default, is stepped on the tick's own thread.
    fn beside(&mut self) -> Option<&mut (dyn Skill + Send)> {
        None
    }
}

// --- The code hatch, shape only -----------------------------------------------------------------------------------

/// The most steps a hatch may declare (rule 10). F8 meters it by its own count, never the runtime's.
pub const HATCH_STEPS_MOST: u64 = 1_000_000;

/// What a hatch reads (rule 10): a field of the thing or an argument of the form, whole values only. It reads nothing
/// it did not declare.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Read {
    Field(u64),
    Argument(Name),
}

/// The most fields one hatch may answer (rule 10).
pub const HATCH_FIELDS_MOST: usize = 8;

/// What a hatch answers (rule 10): a verdict (yes, or no with a named reason), one field's new value, or a verdict
/// and, with a yes, the new values of up to [`HATCH_FIELDS_MOST`] fields, each once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answers {
    Verdict,
    Field(u64),
    Fields(Vec<u64>),
}

/// The code hatch's shape (rule 10; SA-F9, #3000): one pure function, named by the hash of its module, its reads
/// declared, a step limit and what it answers. `{1: module hash, 2: [read, ...], 3: steps most, 4: answers,
/// 5: why}`, a read `{1: 1, 2: field}` or `{1: 2, 2: argument}`, answers `{1: 1}` a verdict, `{1: 2, 2: field}` or
/// `{1: 3, 2: [field, ...]}` a verdict and those fields' values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hatch {
    /// The module's SHA-256 multihash, 34 bytes (T3 rule 9).
    pub module: Vec<u8>,
    pub reads: Vec<Read>,
    pub steps_most: u64,
    pub answers: Answers,
    pub why: Name,
}

impl Hatch {
    /// Reads a hatch, refusing by name: `hatch-not-a-record` (unknown fields included), `hatch-module-not-hash`,
    /// `hatch-reads-nothing`, `hatch-steps-out-of-range` (none, or more than [`HATCH_STEPS_MOST`]).
    pub fn from_value(v: &Value) -> R<Hatch> {
        let not = || {
            refuse(
                "hatch-not-a-record",
                "{1: module, 2: reads, 3: steps most, 4: answers, 5: why}",
            )
        };
        let Value::Map(m) = v else { return not() };
        if m.keys().any(|k| *k > 5) {
            return not();
        }
        let module = match m.get(&1) {
            Some(Value::Bytes(b))
                if b.len() == 34 && b[0] == crate::ids::SHA2_256 && b[1] == 32 =>
            {
                b.clone()
            }
            _ => {
                return refuse(
                    "hatch-module-not-hash",
                    "a module is named by its SHA-256 multihash",
                );
            }
        };
        let Some(Value::Array(rs)) = m.get(&2) else {
            return not();
        };
        let mut reads = Vec::new();
        for r in rs {
            let Value::Map(r) = r else { return not() };
            reads.push(match (r.get(&1), r.get(&2)) {
                (Some(Value::Uint(1)), Some(Value::Uint(f))) => Read::Field(*f),
                (Some(Value::Uint(2)), Some(Value::Text(a))) => Read::Argument(a.clone()),
                _ => return not(),
            });
        }
        if reads.is_empty() {
            return refuse("hatch-reads-nothing", "a hatch declares what it reads");
        }
        let Some(Value::Uint(steps_most)) = m.get(&3) else {
            return not();
        };
        if *steps_most == 0 || *steps_most > HATCH_STEPS_MOST {
            return refuse(
                "hatch-steps-out-of-range",
                format!("{steps_most}; 1 to {HATCH_STEPS_MOST}"),
            );
        }
        let answers = match m.get(&4) {
            Some(Value::Map(a)) => match (a.get(&1), a.get(&2)) {
                (Some(Value::Uint(1)), None) => Answers::Verdict,
                (Some(Value::Uint(2)), Some(Value::Uint(f))) => Answers::Field(*f),
                (Some(Value::Uint(3)), Some(Value::Array(fs))) => {
                    let mut out: Vec<u64> = Vec::new();
                    for f in fs {
                        match f {
                            Value::Uint(f) if !out.contains(f) => out.push(*f),
                            _ => return not(),
                        }
                    }
                    if out.is_empty() || out.len() > HATCH_FIELDS_MOST {
                        return not();
                    }
                    Answers::Fields(out)
                }
                _ => return not(),
            },
            _ => return not(),
        };
        let Some(Value::Text(why)) = m.get(&5) else {
            return not();
        };
        Ok(Hatch {
            module,
            reads,
            steps_most: *steps_most,
            answers,
            why: why.clone(),
        })
    }
}
