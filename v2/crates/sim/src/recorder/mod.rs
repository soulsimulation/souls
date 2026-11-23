//! The flight recorder (Engine v2 K12, #2675): everything handed to the clock thread from outside is written to the
//! log (K4) as an **input record**, with the tick that took it, so any run can be fed back from its checkpoint and
//! its inputs, and one build writes the same log every time. A developer's tool, not a promise that two builds or two
//! machines agree.
//!
//! 1. **An input record** is `{0: "souls:input", 1: tick, 2: [input, ...]}` in T0's bytes, one per tick that took
//!    any input, appended before that tick's effects. Key 0 is never a part's (T6 parts are `{1: header, 2: effects}`),
//!    so [`is_input`] tells the two apart from the first bytes, and K5's replay passes input records by.
//! 2. **The inputs** ([`Input`]): T5's mapping to real time, a birth, an edit, an intent, and where a free-running
//!    clock read the bodies' planner batches late (K18b, #3175: a replay in lockstep takes them at the same body
//!    tick, so the planner's timing is part of the record). **Words are never
//!    recorded:** an intent's words are their reference (T8, K16: `{21: reference}`), so the type has no place for
//!    text, and an edit whose value holds words holds their reference too.
//! 3. **The log hash** ([`effect_hash`]) covers effect records only: input records and measures stay out of it, so
//!    two runs that took the same inputs and made the same effects hash the same.
//! 4. **The first difference** ([`first_difference`]) names the first effect record two logs disagree on: its place
//!    among the effects, its record number in each log, and the tick of the inputs before it.
//!
//! The world's draws are `crate::random`'s; the lints that keep `sim` repeatable are in `v2/clippy.toml`; the
//! three-process comparison is `v2/tools/replay-compare`.

use std::collections::BTreeMap;

use replica::effects::Refusal;
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, sha256};

use crate::log::{Log, Storage};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The text that marks an input record (key 0).
pub const MARK: &str = "souls:input";

/// One thing handed to the clock thread from outside.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    /// T5's mapping to real time: the real microsecond the world's clock was read at.
    Time { real: u64 },
    /// A birth of a thing of `kind`, asked by `by` (a creator's principal or a Soul).
    Birth { by: Id, kind: Name },
    /// A field's new value on a node. A value that carries words carries their reference, `{21: reference}`.
    Edit {
        by: Id,
        node: Id,
        field: u64,
        to: Value,
    },
    /// An intent (T10) by a Soul: its id, its verb, and its words by reference only (T8).
    Intent {
        id: Id,
        soul: Id,
        verb: Name,
        words: Option<Id>,
    },
    /// K18b (#3175): at body time `at` a free-running clock took only the first `taken` of the planner's batches
    /// outstanding (the rest came back late, for a later tick). Recorded only then: at every other body tick each
    /// outstanding batch is taken, as lockstep takes them.
    Planned { at: u64, taken: u64 },
}

/// Words held by reference, as T8 writes them: `{21: reference}`.
pub fn words_ref(reference: Id) -> Value {
    Value::Map(BTreeMap::from([(21, reference.to_value())]))
}

fn map(pairs: Vec<(u64, Value)>) -> Value {
    Value::Map(pairs.into_iter().collect())
}

impl Input {
    pub fn to_value(&self) -> Value {
        match self {
            Input::Time { real } => map(vec![(1, Value::Uint(1)), (2, Value::Uint(*real))]),
            Input::Birth { by, kind } => map(vec![
                (1, Value::Uint(2)),
                (2, by.to_value()),
                (3, Value::Text(kind.clone())),
            ]),
            Input::Edit {
                by,
                node,
                field,
                to,
            } => map(vec![
                (1, Value::Uint(3)),
                (2, by.to_value()),
                (3, node.to_value()),
                (4, Value::Uint(*field)),
                (5, to.clone()),
            ]),
            Input::Intent {
                id,
                soul,
                verb,
                words,
            } => {
                let mut p = vec![
                    (1, Value::Uint(4)),
                    (2, id.to_value()),
                    (3, soul.to_value()),
                    (4, Value::Text(verb.clone())),
                ];
                if let Some(w) = words {
                    p.push((5, words_ref(*w)));
                }
                map(p)
            }
            Input::Planned { at, taken } => map(vec![
                (1, Value::Uint(5)),
                (2, Value::Uint(*at)),
                (3, Value::Uint(*taken)),
            ]),
        }
    }

    fn read(v: Value) -> R<Input> {
        let Value::Map(mut m) = v else {
            return refuse("input-bad", "an input is a map");
        };
        let mut take = |k: u64| {
            m.remove(&k)
                .ok_or_else(|| bad(format!("an input lacks field {k}")))
        };
        let uint = |v: Value| match v {
            Value::Uint(n) => Ok(n),
            _ => Err(bad("not an unsigned integer")),
        };
        let id = |v: Value| replica::effects::read_id(&v);
        let name = |v: Value| match v {
            Value::Text(n) => Ok(n),
            _ => Err(bad("not a name")),
        };
        let input = match uint(take(1)?)? {
            1 => Input::Time {
                real: uint(take(2)?)?,
            },
            2 => Input::Birth {
                by: id(take(2)?)?,
                kind: name(take(3)?)?,
            },
            3 => Input::Edit {
                by: id(take(2)?)?,
                node: id(take(3)?)?,
                field: uint(take(4)?)?,
                to: take(5)?,
            },
            4 => Input::Intent {
                id: id(take(2)?)?,
                soul: id(take(3)?)?,
                verb: name(take(4)?)?,
                words: match m.remove(&5) {
                    Some(Value::Map(mut w)) if w.len() == 1 => Some(id(w
                        .remove(&21)
                        .ok_or_else(|| bad("words are {21: ref}"))?)?),
                    Some(_) => return refuse("input-bad", "words are {21: reference}"),
                    None => None,
                },
            },
            5 => Input::Planned {
                at: uint(take(2)?)?,
                taken: uint(take(3)?)?,
            },
            n => return refuse("input-bad", format!("input kind {n}")),
        };
        if !m.is_empty() {
            return refuse("input-bad", "an input with fields left over");
        }
        Ok(input)
    }
}

fn bad(detail: impl Into<String>) -> Refusal {
    Refusal {
        name: "input-bad",
        detail: detail.into(),
    }
}

/// The input record for `tick` (rule 1).
pub fn record(tick: u64, inputs: &[Input]) -> R<Vec<u8>> {
    let v = map(vec![
        (0, Value::Text(Name::new(MARK).expect("a name"))),
        (1, Value::Uint(tick)),
        (
            2,
            Value::Array(inputs.iter().map(Input::to_value).collect()),
        ),
    ]);
    encode(&v).or_else(|e| refuse("encoding", e.to_string()))
}

/// Whether a log record is an input record (rule 1): a map whose first key is 0 and holds [`MARK`].
pub fn is_input(bytes: &[u8]) -> bool {
    let mut head = vec![0x00, 0x60 | MARK.len() as u8];
    head.extend_from_slice(MARK.as_bytes());
    bytes.first().is_some_and(|b| b >> 5 == 5) && bytes[1..].starts_with(&head)
}

/// An input record's tick and inputs.
pub fn read(bytes: &[u8]) -> R<(u64, Vec<Input>)> {
    let v = decode(bytes)
        .or_else(|e| refuse("encoding", e.to_string()))?
        .value;
    let Value::Map(mut m) = v else {
        return refuse("input-bad", "an input record is a map");
    };
    if m.remove(&0) != Some(Value::Text(Name::new(MARK).expect("a name"))) {
        return refuse("input-bad", "not an input record");
    }
    let tick = match m.remove(&1) {
        Some(Value::Uint(t)) => t,
        _ => return refuse("input-bad", "an input record's tick"),
    };
    let inputs = match m.remove(&2) {
        Some(Value::Array(a)) => a.into_iter().map(Input::read).collect::<R<Vec<_>>>()?,
        _ => return refuse("input-bad", "an input record's inputs"),
    };
    Ok((tick, inputs))
}

/// The recording in a log's records: each tick that took inputs, in order.
pub fn inputs(records: &[Vec<u8>]) -> R<Vec<(u64, Vec<Input>)>> {
    records
        .iter()
        .filter(|r| is_input(r))
        .map(|r| read(r))
        .collect()
}

/// Appends `tick`'s inputs to `log` as one input record, if there are any; returns its record number.
pub fn append<S: Storage + 'static>(
    log: &mut Log<S>,
    tick: u64,
    inputs: &[Input],
) -> R<Option<u64>> {
    match inputs.is_empty() {
        true => Ok(None),
        false => log.append(record(tick, inputs)?).map(Some),
    }
}

/// The log hash (rule 3): SHA-256 chained over each effect record's length and bytes; input records are left out.
pub fn effect_hash(records: &[Vec<u8>]) -> [u8; 32] {
    let mut h = sha256(b"souls-effect-log/1");
    for r in records.iter().filter(|r| !is_input(r)) {
        let mut b = h.to_vec();
        b.extend_from_slice(&(r.len() as u64).to_le_bytes());
        b.extend_from_slice(r);
        h = sha256(&b);
    }
    h
}

/// Where two logs first disagree (rule 4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Difference {
    /// The place among effect records (0 for the first).
    pub effect: u64,
    /// Its record number in each log.
    pub records: [u64; 2],
    /// The tick of the last input record before it in each log (`None` before any).
    pub ticks: [Option<u64>; 2],
    /// The two records' bytes (`None` where one log ends first).
    pub bytes: [Option<Vec<u8>>; 2],
}

fn effects(records: &[Vec<u8>]) -> Vec<(u64, Option<u64>, &Vec<u8>)> {
    let mut tick = None;
    let mut out = Vec::new();
    for (n, r) in records.iter().enumerate() {
        match is_input(r) {
            true => tick = read(r).ok().map(|(t, _)| t),
            false => out.push((n as u64, tick, r)),
        }
    }
    out
}

/// The first effect record on which logs `a` and `b` differ, or `None` if their effects are the same.
pub fn first_difference(a: &[Vec<u8>], b: &[Vec<u8>]) -> Option<Difference> {
    let (ea, eb) = (effects(a), effects(b));
    let i =
        (0..ea.len().max(eb.len())).find(|&i| ea.get(i).map(|e| e.2) != eb.get(i).map(|e| e.2))?;
    let at = |e: &[(u64, Option<u64>, &Vec<u8>)], other: &[Vec<u8>]| {
        e.get(i).map_or((other.len() as u64, None, None), |x| {
            (x.0, x.1, Some(x.2.clone()))
        })
    };
    let (ra, ta, ba) = at(&ea, a);
    let (rb, tb, bb) = at(&eb, b);
    Some(Difference {
        effect: i as u64,
        records: [ra, rb],
        ticks: [ta, tb],
        bytes: [ba, bb],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;

    fn id(s: u8, n: u64) -> Id {
        Id::new(Scope([s; 16]), n).unwrap()
    }

    #[test]
    fn an_input_record_reads_back_and_is_told_from_a_part() {
        let inputs = vec![
            Input::Time {
                real: 1_763_337_600_000_000,
            },
            Input::Birth {
                by: id(0x77, 1),
                kind: Name::new("souls:crate").unwrap(),
            },
            Input::Edit {
                by: id(0x77, 1),
                node: id(0xee, 4),
                field: 1,
                to: Value::Uint(9),
            },
            Input::Intent {
                id: id(0xdd, 9),
                soul: id(0xdd, 100),
                verb: Name::new("say").unwrap(),
                words: Some(id(0xcc, 3)),
            },
        ];
        let r = record(42, &inputs).unwrap();
        assert!(is_input(&r));
        assert_eq!(read(&r).unwrap(), (42, inputs));
        let part = encode(&map(vec![
            (1, Value::Bytes(vec![1; 34])),
            (2, Value::Array(vec![])),
        ]))
        .unwrap();
        assert!(!is_input(&part));
        assert_eq!(
            effect_hash(&[r.clone(), part.clone()]),
            effect_hash(&[part])
        );
    }

    /// A3: an intent that carries words is recorded with their reference only.
    #[test]
    fn a3_words_are_recorded_by_their_reference_only() {
        let words = "meet me by the fountain at noon";
        // A stand-in for K16's store: the words go there, the intent carries what it hands back.
        let mut store: BTreeMap<Id, String> = BTreeMap::new();
        let reference = id(0xcc, 1);
        store.insert(reference, words.into());
        let intent = Input::Intent {
            id: id(0xdd, 1),
            soul: id(0xdd, 100),
            verb: Name::new("say").unwrap(),
            words: Some(reference),
        };
        let r = record(7, std::slice::from_ref(&intent)).unwrap();
        for w in words.split(' ').filter(|w| w.len() > 3) {
            assert!(
                !r.windows(w.len()).any(|x| x == w.as_bytes()),
                "the record holds {w:?}"
            );
        }
        let (_, back) = read(&r).unwrap();
        let Input::Intent {
            words: Some(got), ..
        } = back[0]
        else {
            panic!("an intent with words");
        };
        assert_eq!(
            store[&got], words,
            "the reference finds the words in the store"
        );
        println!(
            "A3: {} bytes recorded for a {}-byte sentence: {}",
            r.len(),
            words.len(),
            replica::encode::to_hex(&r)
        );
    }

    #[test]
    fn the_first_difference_is_named() {
        let inp = |t| record(t, &[Input::Time { real: t }]).unwrap();
        let a = vec![inp(1), vec![0xa0, 1], inp(2), vec![0xa0, 2], vec![0xa0, 3]];
        let mut b = a.clone();
        b[3] = vec![0xa0, 9];
        let d = first_difference(&a, &b).unwrap();
        assert_eq!(
            (d.effect, d.records, d.ticks),
            (1, [3, 3], [Some(2), Some(2)])
        );
        assert_eq!(first_difference(&a, &a), None);
        let d = first_difference(&a, &a[..4]).unwrap();
        assert_eq!((d.effect, d.bytes[1].clone()), (2, None));
    }
}
