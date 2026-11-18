//! Moves as data (Engine v2 B2, #2681): every timed thing a body does is one [`Move`] read from data, and the engine
//! runs it on timers alone (`sim::moves`). No code names a move.
//!
//! - **What a move states.** Its name and revision; what it claims, blocks and is cancelled by (T9's own terms,
//!   `v2/docs/bodies.md` rules 2 to 4, so a move is a claim like any skill's); its phases, each a name and a length in
//!   microseconds, never ticks; its effector (the part that reaches) and its reach in µm; and the contact point it
//!   reaches for, by name, on the thing it acts on (K3's named points).
//! - **Phases.** A phase includes its start and excludes its end. Contact is one instant: the end of the first phase
//!   (start-up), which is the start of the second. A contact that lasts is a phase after it. At least two phases.
//! - **Reach** is one distance from the effector, asked of the geometry; the engine solves no limbs. It is at most
//!   [`REACH_MOST`]: a straight arm pops in the viewer, so a move reaches less than a full arm.
//! - **The record** ([`MoveRecord`]) is what the log carries of one move in progress: the move and its revision, the
//!   limbs it holds, the thing and the contact point, its start and each phase's end, and, once over, how it ended.
//!
//! Decoded from `{1: name, 2: revision, 3: [want, ...], 4: [class, ...] blocks, 5: [class, ...] cancelled by,
//! 6: [{1: phase, 2: µs}, ...], 7: effector, 8: reach µm, 9: contact point}`, a want `{1: 1 every | 2 one | 3 named,
//! 2: class number or resource name}`, an effector `{1: 1}` the body, `{1: 2}` the resource the move holds, or
//! `{1: 3, 2: point}` a named point of the thing held in it. Fixtures: `v2/crates/replica/fixtures/moves/`.

use std::collections::BTreeMap;

use crate::bodies::{Class, SkillShape, Want};
use crate::effects::Refusal;
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::time::Micros;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The longest reach a move may state, µm: under a full arm, so the viewer's arm never pops straight.
pub const REACH_MOST: i64 = 700_000;

/// The part a move reaches with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effector {
    /// 1: the body itself (its root), reaching a seat.
    Body,
    /// 2: the resource the move holds (a hand).
    Held,
    /// 3: a named point of the thing held in that resource (a jug's spout); reach is measured from it.
    HeldPoint(Name),
}

/// One phase: its name and length, µs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Phase {
    pub name: Name,
    pub length: Micros,
}

/// A move, as data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Move {
    pub name: Name,
    pub revision: u64,
    pub claims: Vec<Want>,
    pub blocks: Vec<Class>,
    pub cancelled_by: Vec<Class>,
    pub phases: Vec<Phase>,
    pub effector: Effector,
    /// µm.
    pub reach: i64,
    pub contact: Name,
}

fn class(v: &Value) -> R<Class> {
    match v {
        Value::Uint(n) => Class::from_number(*n),
        _ => refuse("not-a-move", "a class is a number"),
    }
}

fn classes(v: Option<&Value>) -> R<Vec<Class>> {
    match v {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) => a.iter().map(class).collect(),
        Some(_) => refuse("not-a-move", "a list of classes"),
    }
}

fn uint(v: Option<&Value>, what: &str) -> R<u64> {
    match v {
        Some(Value::Uint(n)) => Ok(*n),
        _ => refuse("not-a-move", format!("{what} is a whole number")),
    }
}

fn text(v: Option<&Value>, what: &str) -> R<Name> {
    match v {
        Some(Value::Text(t)) => Ok(t.clone()),
        _ => refuse("not-a-move", format!("{what} is a name")),
    }
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

impl Move {
    /// Reads a move, refusing by name: `not-a-move` (unknown fields included), `class-unknown`,
    /// `move-phases-too-few` (fewer than two), `move-phase-empty` (a length of zero), `move-reach-out-of-range`
    /// (none, or above [`REACH_MOST`]).
    pub fn from_value(v: &Value) -> R<Move> {
        let Value::Map(m) = v else {
            return refuse("not-a-move", "a move is a map");
        };
        if let Some(k) = m.keys().find(|k| **k == 0 || **k > 9) {
            return refuse("not-a-move", format!("field {k}"));
        }
        let name = text(m.get(&1), "the name")?;
        let revision = uint(m.get(&2), "the revision")?;
        let Some(Value::Array(ws)) = m.get(&3) else {
            return refuse("not-a-move", "claims are a list of wants");
        };
        let mut claims = Vec::new();
        for w in ws {
            let Value::Map(w) = w else {
                return refuse("not-a-move", "a want is a map");
            };
            claims.push(match (w.get(&1), w.get(&2)) {
                (Some(Value::Uint(1)), Some(c)) => Want::All(class(c)?),
                (Some(Value::Uint(2)), Some(c)) => Want::One(class(c)?),
                (Some(Value::Uint(3)), Some(Value::Text(r))) => Want::Named(r.clone()),
                _ => return refuse("not-a-move", "a want is {1: 1|2|3, 2: class or name}"),
            });
        }
        if claims.is_empty() {
            return refuse("not-a-move", "a move claims something");
        }
        let blocks = classes(m.get(&4))?;
        let cancelled_by = classes(m.get(&5))?;
        let Some(Value::Array(ps)) = m.get(&6) else {
            return refuse("not-a-move", "phases are a list");
        };
        let mut phases = Vec::new();
        for p in ps {
            let Value::Map(p) = p else {
                return refuse("not-a-move", "a phase is {1: name, 2: µs}");
            };
            let pname = text(p.get(&1), "a phase's name")?;
            let length = uint(p.get(&2), "a phase's length")?;
            if length == 0 {
                return refuse("move-phase-empty", pname.as_str());
            }
            let length =
                i64::try_from(length).or_else(|_| refuse("not-a-move", "a phase's length"))?;
            phases.push(Phase {
                name: pname,
                length,
            });
        }
        if phases.len() < 2 {
            return refuse(
                "move-phases-too-few",
                format!("{}: start-up, then at least one more", name.as_str()),
            );
        }
        let effector = match m.get(&7) {
            Some(Value::Map(e)) => match (e.get(&1), e.get(&2)) {
                (Some(Value::Uint(1)), None) => Effector::Body,
                (Some(Value::Uint(2)), None) => Effector::Held,
                (Some(Value::Uint(3)), Some(Value::Text(p))) => Effector::HeldPoint(p.clone()),
                _ => return refuse("not-a-move", "an effector is {1: 1|2} or {1: 3, 2: point}"),
            },
            _ => return refuse("not-a-move", "a move has an effector"),
        };
        let reach = uint(m.get(&8), "the reach")?;
        let reach = i64::try_from(reach).unwrap_or(i64::MAX);
        if reach == 0 || reach > REACH_MOST {
            return refuse(
                "move-reach-out-of-range",
                format!("{}: {reach} µm; 1 to {REACH_MOST}", name.as_str()),
            );
        }
        let contact = text(m.get(&9), "the contact point")?;
        Ok(Move {
            name,
            revision,
            claims,
            blocks,
            cancelled_by,
            phases,
            effector,
            reach,
            contact,
        })
    }

    /// The move as a claim on a body (T9 rule 3).
    pub fn shape(&self) -> SkillShape {
        SkillShape {
            name: self.name.clone(),
            claims: self.claims.clone(),
            blocks: self.blocks.clone(),
            cancelled_by: self.cancelled_by.clone(),
        }
    }

    /// The whole move's length, µs.
    pub fn length(&self) -> Micros {
        self.phases.iter().map(|p| p.length).sum()
    }
}

/// How a move ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub at: Micros,
    /// `done`, or the name of what cancelled it.
    pub how: Name,
}

/// What the log carries of one move: which move and revision, the limbs it holds, the thing it acts on and the
/// contact point, when it started and when each phase ends (the first is contact), and, once over, how it ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MoveRecord {
    pub body: Id,
    pub name: Name,
    pub revision: u64,
    pub limbs: Vec<Name>,
    pub target: Id,
    pub contact: Name,
    pub start: Micros,
    pub ends: Vec<Micros>,
    pub ended: Option<Ended>,
}

impl MoveRecord {
    /// The record planned for `mv` on `body`, holding `limbs`, started at `start`.
    pub fn planned(mv: &Move, body: Id, limbs: Vec<Name>, target: Id, start: Micros) -> MoveRecord {
        let mut at = start;
        let ends = mv
            .phases
            .iter()
            .map(|p| {
                at += p.length;
                at
            })
            .collect();
        MoveRecord {
            body,
            name: mv.name.clone(),
            revision: mv.revision,
            limbs,
            target,
            contact: mv.contact.clone(),
            start,
            ends,
            ended: None,
        }
    }

    /// When contact is: the end of the first phase.
    pub fn contact_at(&self) -> Micros {
        self.ends[0]
    }

    /// `{1: body, 2: move, 3: revision, 4: [limb, ...], 5: target, 6: contact point, 7: start, 8: [phase end, ...],
    /// 9: {1: at, 2: how}}`, 9 only once it has ended.
    pub fn to_value(&self) -> Value {
        let mut m = BTreeMap::from([
            (1, self.body.to_value()),
            (2, Value::Text(self.name.clone())),
            (3, Value::Uint(self.revision)),
            (
                4,
                Value::Array(self.limbs.iter().cloned().map(Value::Text).collect()),
            ),
            (5, self.target.to_value()),
            (6, Value::Text(self.contact.clone())),
            (7, int(self.start)),
            (8, Value::Array(self.ends.iter().map(|t| int(*t)).collect())),
        ]);
        if let Some(e) = &self.ended {
            m.insert(
                9,
                Value::Map(BTreeMap::from([
                    (1, int(e.at)),
                    (2, Value::Text(e.how.clone())),
                ])),
            );
        }
        Value::Map(m)
    }
}

/// A seat (Engine v2 B3, #2682): one slot of a thing, as its kind's data. Its height above the floor the thing stands on
/// comes from the kind's model geometry (SEATDEF), and its stand point is where a body stands to sit down and is set
/// back on rising, in the slot's frame (x and z). Decoded from `{1: slot, 2: height mm, 3: [x, z] mm}`; fixture
/// `v2/crates/replica/fixtures/seats/`. A seat holds one body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub slot: u64,
    /// µm above the floor, never below it.
    pub height: i64,
    /// µm, x and z in the slot's frame.
    pub stand: [i64; 2],
}

impl Place {
    /// Reads a seat, refusing anything else as `not-a-place` (unknown fields included).
    pub fn from_value(v: &Value) -> R<Place> {
        let um = |v: &Value| match v {
            Value::Uint(n) => i64::try_from(*n).ok()?.checked_mul(1000),
            Value::Nint(n) => (-1 - i64::try_from(*n).ok()?).checked_mul(1000),
            _ => None,
        };
        let Value::Map(m) = v else {
            return refuse("not-a-place", "a place is a map");
        };
        if let Some(k) = m.keys().find(|k| **k == 0 || **k > 3) {
            return refuse("not-a-place", format!("field {k}"));
        }
        let stand = match m.get(&3) {
            Some(Value::Array(a)) if a.len() == 2 => (um(&a[0]), um(&a[1])),
            _ => (None, None),
        };
        match (m.get(&1), m.get(&2).and_then(um), stand) {
            (Some(Value::Uint(slot)), Some(height), (Some(x), Some(z))) if height >= 0 => {
                Ok(Place {
                    slot: *slot,
                    height,
                    stand: [x, z],
                })
            }
            _ => refuse(
                "not-a-place",
                "{1: slot, 2: height mm (not below the floor), 3: [x, z] mm}",
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::fixture_bytes;
    use crate::encode::{decode, encode};
    use crate::ids::{Minter, Scope};

    const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/moves");

    /// Every fixture move, read by file, never by name.
    fn fixtures() -> Vec<Move> {
        let mut files: Vec<_> = std::fs::read_dir(DIR)
            .expect("the fixtures")
            .map(|e| e.expect("an entry").path())
            .filter(|p| p.extension().is_some_and(|x| x == "diag"))
            .collect();
        files.sort();
        files
            .iter()
            .map(|f| {
                let text = std::fs::read_to_string(f).expect("a file");
                let v = decode(&fixture_bytes(&text).expect("bytes"))
                    .expect("decodes")
                    .value;
                Move::from_value(&v).unwrap_or_else(|r| panic!("{}: {r}", f.display()))
            })
            .collect()
    }

    #[test]
    fn every_fixture_reads_and_its_record_encodes() {
        let moves = fixtures();
        assert_eq!(moves.len(), 5);
        let mut mint = Minter::new(Scope([0x2b; 16]));
        let (body, target) = (mint.mint().expect("id"), mint.mint().expect("id"));
        for mv in &moves {
            let shape = mv.shape();
            assert_eq!(shape.name, mv.name);
            let mut r = MoveRecord::planned(mv, body, vec![], target, 1_000);
            assert_eq!(r.contact_at(), 1_000 + mv.phases[0].length);
            assert_eq!(*r.ends.last().expect("an end"), 1_000 + mv.length());
            r.ended = Some(Ended {
                at: r.contact_at(),
                how: Name::new("done").expect("a name"),
            });
            let bytes = encode(&r.to_value()).expect("encodes");
            assert_eq!(decode(&bytes).expect("decodes").value, r.to_value());
        }
    }

    #[test]
    fn a_bad_move_is_refused_by_name() {
        let good = |reach: u64, phases: Vec<u64>| {
            let ps = phases
                .iter()
                .map(|n| {
                    Value::Map(BTreeMap::from([
                        (1, Value::Text(Name::new("p").expect("n"))),
                        (2, Value::Uint(*n)),
                    ]))
                })
                .collect();
            Value::Map(BTreeMap::from([
                (1, Value::Text(Name::new("m").expect("n"))),
                (2, Value::Uint(1)),
                (
                    3,
                    Value::Array(vec![Value::Map(BTreeMap::from([
                        (1, Value::Uint(2)),
                        (2, Value::Uint(2)),
                    ]))]),
                ),
                (6, Value::Array(ps)),
                (7, Value::Map(BTreeMap::from([(1, Value::Uint(2))]))),
                (8, Value::Uint(reach)),
                (9, Value::Text(Name::new("q").expect("n"))),
            ]))
        };
        assert!(Move::from_value(&good(600_000, vec![1, 1])).is_ok());
        let name = |v| Move::from_value(&v).expect_err("refused").name;
        assert_eq!(name(good(700_001, vec![1, 1])), "move-reach-out-of-range");
        assert_eq!(name(good(0, vec![1, 1])), "move-reach-out-of-range");
        assert_eq!(name(good(1, vec![1])), "move-phases-too-few");
        assert_eq!(name(good(1, vec![1, 0])), "move-phase-empty");
        let Value::Map(mut m) = good(1, vec![1, 1]) else {
            unreachable!()
        };
        m.insert(10, Value::Uint(0));
        assert_eq!(name(Value::Map(m)), "not-a-move");
    }
}
