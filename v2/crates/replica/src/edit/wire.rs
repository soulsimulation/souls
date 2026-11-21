//! An edit as T10 carries it (Engine v2 G1b, #3362; `v2/docs/intents.md` rule 15): an intent whose verb is
//! [`VERB`], the batch in its parameters as `{1: [operation, ...]}`, planned against the version in its basis. The
//! gateway and the owner's client read it with every other intent (`intent_decode`); the world turns it into an
//! [`Edit`] ([`edit_of`]), checks it (`edit::check`) and commits it (`sim::edit`).
//!
//! - **place** `{1: 1, 2: name, 3: kind's plain name, 4: kind's hash, 5: parent, 6: spot, 7: audience, 8: fields}`,
//!   7 left out for everyone (else the audience's id) and 8 when empty;
//! - **move** `{1: 2, 2: node, 3: spot}`; **set** `{1: 3, 2: node, 3: field, 4: value}`; **remove** `{1: 4, 2: node}`.
//! - **doorway** `{1: 5, 2: name, 3: door, 4: from, 5: to, 6: [x,z], 7: yaw, 8: width, 9: height, 10: wall,
//!   11: closed, 12: open}`: paired passage metadata, the leaf's backlink and its owned wall solid-row patch,
//!   millimetres/millidegrees in the owning building's frame.
//!
//! An undo or a redo (G4) is the same verb with `{2: 1}` (undo) or `{2: 2}` (redo) and nothing else; a batch may carry
//! its build's name and its step's (`{3: build, 4: step}`, both UTF-8 bytes, 1 to [`STEP_NAME_MOST`] each: words are
//! bytes, T8) so the world keeps it as that build's step.
//!
//! A node is an id (`[scope, counter]`) or, for one placed earlier in the batch, its temporary name (an integer). A
//! spot is `{1: position, 2: orientation, 3: support, 4: slot}` as T4's pose writes them, 4 left out when none.

use super::{Edit, OPS_MOST, Op, Ref, Spot};
use crate::effects::{Actor, read_id};
use crate::encode::{Name, Value, from_hex, to_hex};
use crate::ids::{Id, Scope};
use crate::intents::Intent;
use crate::pose::{Frame, Pose};
use crate::world_model::Audience;
use std::collections::BTreeMap;

/// The verb of an edit intent.
pub const VERB: &str = "souls:edit";
/// The parameter that holds the batch.
pub const OPS: u64 = 1;
/// The parameter that asks for an undo ([`UNDO_ONE`]) or a redo ([`REDO_ONE`]) instead of a batch.
pub const UNDO: u64 = 2;
pub const UNDO_ONE: u64 = 1;
pub const REDO_ONE: u64 = 2;
/// A batch's build and step names (G4's builds with steps).
pub const BUILD: u64 = 3;
pub const STEP: u64 = 4;
/// The longest build or step name, in bytes.
pub const STEP_NAME_MOST: usize = 64;

/// What an edit intent asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Asked {
    /// A batch, with its build's name and its step's when it is a build's step.
    Batch(Vec<Op>, Option<(String, String)>),
    Undo,
    Redo,
}

type R<T> = Result<T, String>;

fn map(pairs: Vec<(u64, Value)>) -> Value {
    Value::Map(pairs.into_iter().collect())
}

/// A frame for reading and writing a spot through T4's pose codec; its node is never written.
fn frame(slot: Option<u64>) -> Frame {
    Frame {
        node: Id::new(Scope([0; 16]), 0).unwrap_or_else(|| unreachable!("counter 0 is an id")),
        slot,
    }
}

fn spot(s: &Spot) -> Value {
    let Value::Map(mut p) = Pose {
        frame: frame(s.slot),
        position: s.position,
        orientation: s.orientation,
        support: s.support,
    }
    .to_value() else {
        unreachable!("a pose is a map")
    };
    let mut m: Vec<(u64, Value)> = [2, 3, 4]
        .into_iter()
        .zip(1..)
        .filter_map(|(from, to)| p.remove(&from).map(|v| (to, v)))
        .collect();
    m.extend(s.slot.map(|n| (4, Value::Uint(n))));
    map(m)
}

fn read_spot(v: &Value) -> R<Spot> {
    let Value::Map(m) = v else {
        return Err("a spot is a map".into());
    };
    if m.keys().any(|k| !(1..=4).contains(k)) {
        return Err("a spot is {1: position, 2: orientation, 3: support, 4: slot}".into());
    }
    let slot = match m.get(&4) {
        None => None,
        Some(Value::Uint(n)) => Some(*n),
        Some(_) => return Err("a spot's slot".into()),
    };
    let mut p = BTreeMap::from([(1, Value::Uint(0))]);
    for (from, to) in [(1, 2), (2, 3), (3, 4)] {
        p.insert(to, m.get(&from).ok_or("a spot's field is missing")?.clone());
    }
    let mut frame_value = vec![frame(slot).node.to_value()];
    frame_value.extend(slot.map(Value::Uint));
    p.insert(1, Value::Array(frame_value));
    let pose = Pose::from_value(&Value::Map(p)).map_err(|e| format!("a spot: {e}"))?;
    Ok(Spot {
        slot,
        position: pose.position,
        orientation: pose.orientation,
        support: pose.support,
    })
}

fn node(r: Ref) -> Value {
    match r {
        Ref::Node(id) => id.to_value(),
        Ref::New(n) => Value::Uint(n),
    }
}

fn read_node(v: Option<&Value>) -> R<Ref> {
    match v {
        Some(Value::Uint(n)) => Ok(Ref::New(*n)),
        Some(a @ Value::Array(_)) => read_id(a).map(Ref::Node).map_err(|r| r.to_string()),
        _ => Err("a node is an id or a name placed in the batch".into()),
    }
}

fn uint(v: Option<&Value>, what: &str) -> R<u64> {
    match v {
        Some(Value::Uint(n)) => Ok(*n),
        _ => Err(format!("{what} is an integer")),
    }
}

fn op(o: &Op) -> Value {
    match o {
        Op::Place {
            name,
            kind,
            parent,
            at,
            audience,
            fields,
        } => {
            let (plain, hash) = match kind.as_str().split_once('@').map(|(p, h)| (p, from_hex(h))) {
                Some((p, Ok(h))) => (p, Some(h)),
                _ => (kind.as_str(), None),
            };
            let plain = Name::new(plain).unwrap_or_else(|| kind.clone());
            let mut m = vec![
                (1, Value::Uint(1)),
                (2, Value::Uint(*name)),
                (3, Value::Text(plain)),
            ];
            m.extend(hash.map(|h| (4, Value::Bytes(h))));
            m.push((5, node(*parent)));
            m.push((6, spot(at)));
            if let Audience::Of(a) = audience {
                m.push((7, a.to_value()));
            }
            if !fields.is_empty() {
                m.push((8, Value::Map(fields.clone())));
            }
            map(m)
        }
        Op::Move { node: n, at } => map(vec![(1, Value::Uint(2)), (2, node(*n)), (3, spot(at))]),
        Op::Set { node: n, field, to } => map(vec![
            (1, Value::Uint(3)),
            (2, node(*n)),
            (3, Value::Uint(*field)),
            (4, to.clone()),
        ]),
        Op::Remove { node: n } => map(vec![(1, Value::Uint(4)), (2, node(*n))]),
        Op::Doorway {
            name,
            door,
            from,
            to,
            at,
            yaw,
            width,
            height,
            wall,
            closed,
            open,
        } => map(vec![
            (1, Value::Uint(5)),
            (2, Value::Uint(*name)),
            (3, node(*door)),
            (4, node(*from)),
            (5, node(*to)),
            (6, Value::Array(at.iter().map(|n| int(*n)).collect())),
            (7, int(*yaw)),
            (8, int(*width)),
            (9, int(*height)),
            (10, node(*wall)),
            (11, Value::Array(closed.clone())),
            (12, Value::Array(open.clone())),
        ]),
    }
}

fn read_op(v: &Value) -> R<Op> {
    let Value::Map(m) = v else {
        return Err("an operation is a map".into());
    };
    let only = |keys: &[u64], what: &str| {
        if m.keys().all(|k| keys.contains(k)) {
            Ok(())
        } else {
            Err(format!("{what}'s fields are {keys:?}"))
        }
    };
    match uint(m.get(&1), "an operation's kind")? {
        1 => {
            only(&[1, 2, 3, 4, 5, 6, 7, 8], "a place")?;
            let Some(Value::Text(plain)) = m.get(&3) else {
                return Err("a place's kind".into());
            };
            let kind = match m.get(&4) {
                None => plain.clone(),
                Some(Value::Bytes(h)) => Name::new(&format!("{}@{}", plain.as_str(), to_hex(h)))
                    .ok_or("a place's kind is not a name")?,
                Some(_) => return Err("a place's kind hash is bytes".into()),
            };
            Ok(Op::Place {
                name: uint(m.get(&2), "a place's name")?,
                kind,
                parent: read_node(m.get(&5))?,
                at: read_spot(m.get(&6).ok_or("a place's spot")?)?,
                audience: match m.get(&7) {
                    None => Audience::Everyone,
                    Some(a) => Audience::Of(read_id(a).map_err(|r| r.to_string())?),
                },
                fields: match m.get(&8) {
                    None => BTreeMap::new(),
                    Some(Value::Map(f)) if !f.is_empty() => f.clone(),
                    Some(_) => return Err("a place's fields are a map, left out when empty".into()),
                },
            })
        }
        2 => {
            only(&[1, 2, 3], "a move")?;
            Ok(Op::Move {
                node: read_node(m.get(&2))?,
                at: read_spot(m.get(&3).ok_or("a move's spot")?)?,
            })
        }
        3 => {
            only(&[1, 2, 3, 4], "a set")?;
            Ok(Op::Set {
                node: read_node(m.get(&2))?,
                field: uint(m.get(&3), "a set's field")?,
                to: m.get(&4).ok_or("a set's value")?.clone(),
            })
        }
        4 => {
            only(&[1, 2], "a remove")?;
            Ok(Op::Remove {
                node: read_node(m.get(&2))?,
            })
        }
        5 => {
            only(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "a doorway")?;
            let Some(Value::Array(at)) = m.get(&6) else {
                return Err("a doorway's at is [x, z] mm".into());
            };
            if at.len() != 2 {
                return Err("a doorway's at is [x, z] mm".into());
            }
            Ok(Op::Doorway {
                name: uint(m.get(&2), "a doorway's name")?,
                door: read_node(m.get(&3))?,
                from: read_node(m.get(&4))?,
                to: read_node(m.get(&5))?,
                at: [read_int(Some(&at[0]))?, read_int(Some(&at[1]))?],
                yaw: read_int(m.get(&7))?,
                width: read_int(m.get(&8))?,
                height: read_int(m.get(&9))?,
                wall: read_node(m.get(&10))?,
                closed: match m.get(&11) {
                    Some(Value::Array(rows)) => rows.clone(),
                    _ => return Err("a doorway's closed solid rows".into()),
                },
                open: match m.get(&12) {
                    Some(Value::Array(rows)) => rows.clone(),
                    _ => return Err("a doorway's open solid rows".into()),
                },
            })
        }
        n => Err(format!(
            "operation kind {n}: 1 place, 2 move, 3 set, 4 remove, 5 doorway"
        )),
    }
}

fn int(n: i64) -> Value {
    u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
}

fn read_int(v: Option<&Value>) -> R<i64> {
    match v {
        Some(Value::Uint(n)) => {
            i64::try_from(*n).map_err(|_| "a doorway number exceeds i64".into())
        }
        Some(Value::Nint(n)) => i64::try_from(*n)
            .map(|n| -1 - n)
            .map_err(|_| "a doorway number exceeds i64".into()),
        _ => Err("a doorway number is an integer".into()),
    }
}

/// The batch as an edit intent's parameters: `{1: [operation, ...]}`.
pub fn parameters(ops: &[Op]) -> BTreeMap<u64, Value> {
    BTreeMap::from([(OPS, Value::Array(ops.iter().map(op).collect()))])
}

/// The parameters of what `asked` asks for, as [`asked`] reads them.
pub fn parameters_of(asked: &Asked) -> BTreeMap<u64, Value> {
    match asked {
        Asked::Undo => BTreeMap::from([(UNDO, Value::Uint(UNDO_ONE))]),
        Asked::Redo => BTreeMap::from([(UNDO, Value::Uint(REDO_ONE))]),
        Asked::Batch(ops, step) => {
            let mut p = parameters(ops);
            if let Some((b, s)) = step {
                p.insert(BUILD, Value::Bytes(b.clone().into_bytes()));
                p.insert(STEP, Value::Bytes(s.clone().into_bytes()));
            }
            p
        }
    }
}

/// Reads an edit intent's parameters: one to [`OPS_MOST`] operations, each in its one byte form. The detail of a
/// refusal says what was wrong.
pub fn read(parameters: &BTreeMap<u64, Value>) -> R<Vec<Op>> {
    match asked(parameters)? {
        Asked::Batch(ops, _) => Ok(ops),
        _ => Err("an undo or a redo carries no batch".into()),
    }
}

fn step_name(b: &[u8]) -> Option<String> {
    (!b.is_empty() && b.len() <= STEP_NAME_MOST)
        .then(|| String::from_utf8(b.to_vec()).ok())
        .flatten()
}

/// Reads what an edit intent's parameters ask for: `{2: 1}` an undo, `{2: 2}` a redo, else a batch
/// (`{1: [...]}`, with `{3: build, 4: step}` both or neither).
pub fn asked(parameters: &BTreeMap<u64, Value>) -> R<Asked> {
    if let Some(u) = parameters.get(&UNDO) {
        return match (u, parameters.len()) {
            (Value::Uint(UNDO_ONE), 1) => Ok(Asked::Undo),
            (Value::Uint(REDO_ONE), 1) => Ok(Asked::Redo),
            _ => Err("an undo is {2: 1} and a redo {2: 2}, alone".into()),
        };
    }
    let step = match (parameters.get(&BUILD), parameters.get(&STEP)) {
        (None, None) => None,
        (Some(Value::Bytes(b)), Some(Value::Bytes(s))) => match (step_name(b), step_name(s)) {
            (Some(b), Some(s)) => Some((b, s)),
            _ => {
                return Err(format!(
                    "a build or step name is 1 to {STEP_NAME_MOST} bytes of UTF-8"
                ));
            }
        },
        _ => return Err("a build's step is {3: build, 4: step}, both bytes".into()),
    };
    let named = if step.is_some() { 3 } else { 1 };
    let (Some(Value::Array(a)), true) = (parameters.get(&OPS), parameters.len() == named) else {
        return Err("an edit's parameters are {1: [operation, ...]}".into());
    };
    if a.is_empty() || a.len() > OPS_MOST {
        return Err(format!("1 to {OPS_MOST} operations, not {}", a.len()));
    }
    let ops = a.iter().map(read_op).collect::<R<Vec<_>>>()?;
    if parameters_equal(&ops, a) {
        Ok(Asked::Batch(ops, step))
    } else {
        Err("an operation is not in its one byte form".into())
    }
}

fn parameters_equal(ops: &[Op], a: &[Value]) -> bool {
    ops.len() == a.len() && ops.iter().zip(a).all(|(o, v)| op(o) == *v)
}

/// The edit an intent carries, given the id the world minted for it: its actor, the sequence of its basis as the
/// version it was planned against, and its operations. None if the intent is not an edit, or its basis or batch
/// cannot be read (the decoder refuses both first).
pub fn edit_of(intent: &Intent, id: Id) -> Option<Edit> {
    if intent.verb.as_str() != VERB || intent.actor == Actor::World {
        return None;
    }
    let Value::Array(basis) = &intent.basis else {
        return None;
    };
    let Some(Value::Uint(planned)) = basis.get(3) else {
        return None;
    };
    Some(Edit {
        intent: id,
        actor: intent.actor,
        planned: *planned,
        ops: read(&intent.parameters).ok()?,
    })
}
