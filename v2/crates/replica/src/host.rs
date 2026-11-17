//! The host interface and the code hatch's shape (contract T9; Engine v2 T9, #2663). A skill touches the world through
//! [`Host`] and nothing else; the built-in skills in `v2/crates/skills` use the same trait, from a crate that depends
//! on `replica` alone. The rules are numbered in `v2/docs/bodies.md`. Running a hatch (F8) is not here.

use std::collections::BTreeMap;

use crate::bodies::SkillShape;
use crate::effects::{Change, Refusal};
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::pose::{Mode, Vec3};
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
}

/// A controller input (rule 7): a velocity in three dimensions in T4's units a second, and a movement mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Control {
    pub velocity: Vec3,
    pub mode: Mode,
}

/// How a skill's step ended (rule 3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Progress {
    Going,
    Done,
    Failed(Name),
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
    /// An answer about geometry, in integers.
    fn ask(&self, q: &Ask) -> Option<Vec3>;
    /// A timer on the body, due `after` microseconds of world time from now, named for what it is for.
    fn set_timer(&mut self, after: Micros, name: Name) -> Id;
    /// A draw from the world's random numbers (T1's seeded RNG).
    fn draw(&mut self) -> u64;
    /// A controller input for the body (B1 turns it into motion).
    fn control(&mut self, input: Control);
    /// A generic change to the body's own node (T6); the host refuses one to any other node (`write-outside-own`).
    fn emit(&mut self, change: Change) -> R<()>;
}

/// A skill (rule 2): its shape and its step. It keeps nothing outside itself, and its state in progress is never
/// stored: on a restart the intent is handed to the skill again, or ended with a named reason (rule 8).
pub trait Skill {
    fn shape(&self) -> SkillShape;
    fn step(&mut self, host: &mut dyn Host) -> Progress;
}

// --- The code hatch, shape only -----------------------------------------------------------------------------------

/// The most steps a hatch may declare (rule 9). F8 meters it by its own count, never the runtime's.
pub const HATCH_STEPS_MOST: u64 = 1_000_000;

/// What a hatch reads (rule 9): a field of the thing or an argument of the form, whole values only. It reads nothing
/// it did not declare.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Read {
    Field(u64),
    Argument(Name),
}

/// What a hatch answers (rule 9): a verdict (yes, or no with a named reason) or one field's new value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answers {
    Verdict,
    Field(u64),
}

/// The code hatch's shape (rule 9; SA-F9, #3000): one pure function, named by the hash of its module, its reads
/// declared, a step limit and what it answers. `{1: module hash, 2: [read, ...], 3: steps most, 4: answers,
/// 5: why}`, a read `{1: 1, 2: field}` or `{1: 2, 2: argument}`, answers `{1: 1}` a verdict or `{1: 2, 2: field}`.
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
    /// Reads a hatch, refusing by name: `hatch-not-a-record`, `hatch-module-not-hash`, `hatch-reads-nothing`,
    /// `hatch-steps-over-limit`.
    pub fn from_value(v: &Value) -> R<Hatch> {
        let not = || {
            refuse(
                "hatch-not-a-record",
                "{1: module, 2: reads, 3: steps most, 4: answers, 5: why}",
            )
        };
        let Value::Map(m) = v else { return not() };
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
                "hatch-steps-over-limit",
                format!("{steps_most}; at most {HATCH_STEPS_MOST}"),
            );
        }
        let answers = match m.get(&4) {
            Some(Value::Map(a)) => match (a.get(&1), a.get(&2)) {
                (Some(Value::Uint(1)), None) => Answers::Verdict,
                (Some(Value::Uint(2)), Some(Value::Uint(f))) => Answers::Field(*f),
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
