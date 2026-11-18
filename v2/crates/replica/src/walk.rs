//! How to move (Engine v2 E10, #2781): a body's manner, and the fields of a walk intent that shape its way.
//!
//! - **Manner.** A word on the body ([`F_MANNER`]), set by a `souls:manner` act ([`set_manner`]): an entry of the
//!   body's own node, so it is recorded as a fact, kept until changed, and read by every later walk ([`manner`]). A
//!   gait of that name (N11, `sim::gaits`) gives the walk its speed; any other word is kept as it is and drawn
//!   (E11). A manner never changes where a body may go.
//! - **The way.** A walk intent's parameters ([`Way`]): up to [`VIA_MOST`] places passed in order without stopping
//!   (`via`), a named path or shore walked along (`along`), a loop round a place (`round`) or to and fro between two
//!   places (`between`), the last two with a stated number of laps, at most [`LAPS_MOST`]. The walk ends when its laps
//!   are done or at the intent's expiry (T10's envelope). One shape per walk.
//! - A stop is a node (a place, found by its outline or line) or a point on the open ground, `[x, z]` µm.
//!
//! The world turns a way into points and routes (`sim::routes::way`); each point is one more route search, charged.

use std::collections::BTreeMap;

use crate::effects::{Change, Refusal, read_id};
use crate::encode::{Name, Value};
use crate::ids::Id;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// A body's manner: one word, kept until changed (E10).
pub const F_MANNER: u64 = 50;
/// The act that sets a body's manner; its parameter [`P_MANNER`] is the word.
pub const MANNER: &str = "souls:manner";
/// A walk.
pub const WALK: &str = "souls:walk";

/// A manner act's word.
pub const P_MANNER: u64 = 1;
/// A walk's places passed in order: `[stop, ...]`, at most [`VIA_MOST`].
pub const P_VIA: u64 = 2;
/// A walk along a named path or shore: a node.
pub const P_ALONG: u64 = 3;
/// A loop round a place: a node.
pub const P_ROUND: u64 = 4;
/// To and fro between two stops: `[stop, stop]`.
pub const P_BETWEEN: u64 = 5;
/// The laps of a loop or a to-and-fro: a whole number from 1 to [`LAPS_MOST`].
pub const P_LAPS: u64 = 6;

/// The most places a walk passes on its way.
pub const VIA_MOST: usize = 8;
/// The most laps one intent may ask.
pub const LAPS_MOST: u32 = 20;

/// A place a walk passes: a node, or a point on the open ground (x, z µm).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    Node(Id),
    Point([i64; 2]),
}

/// The shape of a walk's way.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Shape {
    /// Straight to the goal by the shortest route (N5).
    Direct,
    /// Through these places, in order.
    Via(Vec<Stop>),
    /// Along this path or shore.
    Along(Id),
    /// Round this place, `laps` times.
    Round { place: Id, laps: u32 },
    /// There and back between two stops, `laps` times.
    Between { ends: [Stop; 2], laps: u32 },
}

/// A walk intent's way: its shape, read from the intent's parameters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Way {
    pub shape: Shape,
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

impl Stop {
    pub fn to_value(self) -> Value {
        match self {
            Stop::Node(id) => id.to_value(),
            Stop::Point([x, z]) => Value::Map(BTreeMap::from([(1, int(x)), (2, int(z))])),
        }
    }

    pub fn read(v: &Value) -> R<Stop> {
        match v {
            Value::Map(m) => match (m.get(&1).and_then(read_int), m.get(&2).and_then(read_int)) {
                (Some(x), Some(z)) if m.len() == 2 => Ok(Stop::Point([x, z])),
                _ => refuse("way-stop-not-read", "a point is {1: x, 2: z} µm"),
            },
            _ => read_id(v).map(Stop::Node),
        }
    }
}

fn laps(p: &BTreeMap<u64, Value>) -> R<u32> {
    let Some(v) = p.get(&P_LAPS) else {
        return Ok(1);
    };
    match v {
        Value::Uint(n) if *n >= 1 && *n <= u64::from(LAPS_MOST) => Ok(*n as u32),
        _ => refuse(
            "way-laps",
            format!("laps are a whole number from 1 to {LAPS_MOST}"),
        ),
    }
}

impl Way {
    /// The way a walk intent's parameters ask. More than one shape, more than [`VIA_MOST`] places, laps on a shape
    /// with none or laps out of range are each refused by name.
    pub fn read(p: &BTreeMap<u64, Value>) -> R<Way> {
        let given = [P_VIA, P_ALONG, P_ROUND, P_BETWEEN]
            .iter()
            .filter(|k| p.contains_key(k))
            .count();
        if given > 1 {
            return refuse(
                "way-one-shape",
                "via, along, round and between are one per walk",
            );
        }
        let looped = p.contains_key(&P_ROUND) || p.contains_key(&P_BETWEEN);
        if p.contains_key(&P_LAPS) && !looped {
            return refuse("way-laps-without-loop", "laps go with round or between");
        }
        let shape = if let Some(v) = p.get(&P_VIA) {
            let Value::Array(a) = v else {
                return refuse("way-stop-not-read", "via is a list");
            };
            if a.is_empty() || a.len() > VIA_MOST {
                return refuse(
                    "way-too-many-via",
                    format!("{} places; a walk passes 1 to {VIA_MOST}", a.len()),
                );
            }
            Shape::Via(a.iter().map(Stop::read).collect::<R<_>>()?)
        } else if let Some(v) = p.get(&P_ALONG) {
            Shape::Along(read_id(v)?)
        } else if let Some(v) = p.get(&P_ROUND) {
            Shape::Round {
                place: read_id(v)?,
                laps: laps(p)?,
            }
        } else if let Some(v) = p.get(&P_BETWEEN) {
            let ends = match v {
                Value::Array(a) if a.len() == 2 => [Stop::read(&a[0])?, Stop::read(&a[1])?],
                _ => return refuse("way-stop-not-read", "between is two stops"),
            };
            Shape::Between {
                ends,
                laps: laps(p)?,
            }
        } else {
            Shape::Direct
        };
        Ok(Way { shape })
    }

    /// The parameters that ask this way: [`Way::read`] gives it back.
    pub fn to_params(&self) -> BTreeMap<u64, Value> {
        let mut p = BTreeMap::new();
        match &self.shape {
            Shape::Direct => {}
            Shape::Via(s) => {
                p.insert(
                    P_VIA,
                    Value::Array(s.iter().map(|s| s.to_value()).collect()),
                );
            }
            Shape::Along(id) => {
                p.insert(P_ALONG, id.to_value());
            }
            Shape::Round { place, laps } => {
                p.insert(P_ROUND, place.to_value());
                p.insert(P_LAPS, Value::Uint(u64::from(*laps)));
            }
            Shape::Between { ends, laps } => {
                p.insert(
                    P_BETWEEN,
                    Value::Array(vec![ends[0].to_value(), ends[1].to_value()]),
                );
                p.insert(P_LAPS, Value::Uint(u64::from(*laps)));
            }
        }
        p
    }
}

/// The manner a `souls:manner` act's parameters name: one non-empty word.
pub fn manner_word(p: &BTreeMap<u64, Value>) -> R<Name> {
    match p.get(&P_MANNER) {
        Some(Value::Text(w)) if !w.as_str().is_empty() && w.as_str().len() <= 32 => Ok(w.clone()),
        _ => refuse(
            "manner-not-a-word",
            "a manner is one word of up to 32 letters",
        ),
    }
}

/// The change that sets `body`'s manner to `word`: an entry of the body's own node, recorded as a fact.
pub fn set_manner(body: Id, word: Name) -> Change {
    Change::Set {
        node: body,
        field: F_MANNER,
        to: Value::Text(word),
        by: None,
    }
}

/// A body's manner, from its fields; none when it has not been set.
pub fn manner(fields: &BTreeMap<u64, Value>) -> Option<&Name> {
    match fields.get(&F_MANNER) {
        Some(Value::Text(w)) => Some(w),
        _ => None,
    }
}
