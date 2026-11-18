//! History bundles (Engine v2 V3, #2712; contract T7): what a browser plays back, packed from the archive. A bundle is
//! a view (T7), so its format may change; the archive it is made from (`v2/tools/archive`) is the format kept for
//! ever. The layout is in `v2/docs/archive.md`.
//!
//! 1. **A bundle** is one window of world time, one to five minutes, of the public view at the history level, with
//!    the public state at its start: `{1: format, 2: header hash, 3: start µs, 4: length µs, 5: snapshot, 6: view}`.
//!    The view is T7's output form (`views.rs`); the snapshot is `{1: [[id, node], ...], 2: [[id, link], ...]}` in
//!    T6's state layout, the public nodes and links only, each reference passed through the redaction list.
//! 2. **A day index** names a day's bundles: `{1: format, 2: day, 3: [[start µs, key, SHA-256], ...]}`. The store
//!    holds each bundle deflated (`v2/tools/archive`, #3284); the SHA-256 is of its bytes here, before deflate.
//! 3. **No words.** A bundle carries text references (`{21: id}`), never the words (T8): words reach a viewer only
//!    beside a reference, at delivery.
//!
//! Not here: building bundles from the log and storing them (`v2/tools/archive`), seeking (V4), the page (V9).

pub mod events;
pub mod seek;

use std::collections::BTreeMap;

use crate::effects::{Refusal, State, read_id};
use crate::encode::{Value, decode, encode};
use crate::ids::{Id, sha256};
use crate::views::Redactions;
use crate::world_model::{Audience, End};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The bundle and day-index format this build writes and reads.
pub const FORMAT: u64 = 1;

/// The longest window a bundle covers, µs (five minutes); the shortest is one minute.
pub const WINDOW_MOST: i64 = 300_000_000;
pub const WINDOW_LEAST: i64 = 60_000_000;

/// One world day, µs: a day index covers the bundles that start in it.
pub const DAY: i64 = 86_400_000_000;

fn enc(v: &Value) -> R<Vec<u8>> {
    encode(v).or_else(|e| refuse("encoding", e.to_string()))
}

fn dec(bytes: &[u8]) -> R<Value> {
    decode(bytes)
        .map(|d| d.value)
        .or_else(|e| refuse("encoding", e.to_string()))
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: &Value, what: &str) -> R<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).or_else(|_| refuse("history-bad", what.to_owned())),
        Value::Nint(n) => i64::try_from(*n)
            .map(|n| -1 - n)
            .or_else(|_| refuse("history-bad", what.to_owned())),
        _ => refuse("history-bad", format!("{what} is not an integer")),
    }
}

fn audience(a: Audience) -> Value {
    match a {
        Audience::Everyone => Value::Map([(1, Value::Uint(1))].into()),
        Audience::Of(id) => Value::Map([(1, Value::Uint(2)), (2, id.to_value())].into()),
    }
}

/// The public state of a zone (rule 1): its nodes and links whose audience is everyone, references scrubbed.
pub fn public_snapshot(state: &State, redactions: &Redactions) -> Value {
    let nodes = state
        .nodes
        .iter()
        .filter(|(_, n)| n.audience == Audience::Everyone)
        .map(|(id, n)| {
            let mut m = vec![
                (1, Value::Text(n.kind.clone())),
                (4, audience(n.audience)),
                (5, Value::Map(n.fields.clone())),
            ];
            m.extend(n.parent.map(|p| (2, p.to_value())));
            m.extend(n.slot.map(|s| (3, Value::Uint(s))));
            m.extend(n.place.clone().map(|p| (6, p)));
            m.extend(n.motion.clone().map(|p| (7, p)));
            Value::Array(vec![id.to_value(), Value::Map(m.into_iter().collect())])
        })
        .collect();
    let links = state
        .links
        .iter()
        .filter(|(_, l)| l.audience == Audience::Everyone)
        .map(|(id, l)| {
            let m = BTreeMap::from([
                (1, Value::Text(l.ty.clone())),
                (
                    2,
                    Value::Array(vec![l.ends[0].to_value(), l.ends[1].to_value()]),
                ),
                (3, Value::Uint(u64::from(l.owner == End::Second))),
                (4, audience(l.audience)),
            ]);
            Value::Array(vec![id.to_value(), Value::Map(m)])
        })
        .collect();
    redactions.scrub(Value::Map(BTreeMap::from([
        (1, Value::Array(nodes)),
        (2, Value::Array(links)),
    ])))
}

/// A history bundle (rule 1), with the bytes it was read from or written as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bundle {
    pub header: Vec<u8>,
    pub start: i64,
    pub length: i64,
    pub snapshot: Value,
    pub view: Value,
    stored: Vec<u8>,
}

impl Bundle {
    /// A bundle of the window `start..start + length`; refused unless the window is one to five minutes.
    pub fn new(
        header: Vec<u8>,
        start: i64,
        length: i64,
        snapshot: Value,
        view: Value,
    ) -> R<Bundle> {
        if !(WINDOW_LEAST..=WINDOW_MOST).contains(&length) {
            return refuse("history-window", format!("{length} µs"));
        }
        let v = Value::Map(BTreeMap::from([
            (1, Value::Uint(FORMAT)),
            (2, Value::Bytes(header.clone())),
            (3, int(start)),
            (4, int(length)),
            (5, snapshot.clone()),
            (6, view.clone()),
        ]));
        let stored = enc(&v)?;
        Ok(Bundle {
            header,
            start,
            length,
            snapshot,
            view,
            stored,
        })
    }

    pub fn read(bytes: &[u8]) -> R<Bundle> {
        let b = Bundle::parse(bytes)?;
        if b.stored != bytes {
            return refuse("history-bad", "a bundle not in its one encoding");
        }
        Ok(b)
    }

    /// Reads a bundle a day index names by `hash` (V4's seek): the hash is checked, and stands for the check of its
    /// one encoding, which [`Bundle::read`] makes by writing it again.
    pub fn read_named(bytes: &[u8], hash: &[u8; 32]) -> R<Bundle> {
        if sha256(bytes) != *hash {
            return refuse(
                "history-hash",
                "a bundle that is not the one its index names",
            );
        }
        Bundle::parse(bytes)
    }

    fn parse(bytes: &[u8]) -> R<Bundle> {
        let Value::Map(mut m) = dec(bytes)? else {
            return refuse("history-bad", "a bundle is a map");
        };
        let mut take = |k: u64| {
            m.remove(&k)
                .map_or_else(|| refuse("history-bad", format!("a bundle lacks {k}")), Ok)
        };
        if take(1)? != Value::Uint(FORMAT) {
            return refuse("history-format", "a bundle of another format");
        }
        let Value::Bytes(header) = take(2)? else {
            return refuse("history-bad", "a header hash is bytes");
        };
        let (start, length) = (
            read_int(&take(3)?, "a start")?,
            read_int(&take(4)?, "a length")?,
        );
        if !(WINDOW_LEAST..=WINDOW_MOST).contains(&length) {
            return refuse("history-window", format!("{length} µs"));
        }
        Ok(Bundle {
            header,
            start,
            length,
            snapshot: take(5)?,
            view: take(6)?,
            stored: bytes.to_vec(),
        })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.stored
    }

    /// SHA-256 of its bytes: what a day index names it by, and what a bundle made again must equal.
    pub fn hash(&self) -> [u8; 32] {
        sha256(&self.stored)
    }

    /// How many records its view holds.
    pub fn records(&self) -> usize {
        match &self.view {
            Value::Map(m) => match m.get(&8) {
                Some(Value::Array(a)) => a.len(),
                _ => 0,
            },
            _ => 0,
        }
    }
}

/// The world day `at` falls in.
pub fn day_of(at: i64) -> i64 {
    at.div_euclid(DAY)
}

/// A day's index of bundles (rule 2).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DayIndex {
    pub day: i64,
    /// Each bundle: its start, its key in the store and its SHA-256, in order of start.
    pub bundles: Vec<(i64, String, [u8; 32])>,
}

impl DayIndex {
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let rows = self
            .bundles
            .iter()
            .map(|(s, k, h)| {
                Value::Array(vec![
                    int(*s),
                    Value::Bytes(k.as_bytes().to_vec()),
                    Value::Bytes(h.to_vec()),
                ])
            })
            .collect();
        enc(&Value::Map(BTreeMap::from([
            (1, Value::Uint(FORMAT)),
            (2, int(self.day)),
            (3, Value::Array(rows)),
        ])))
    }

    pub fn read(bytes: &[u8]) -> R<DayIndex> {
        fn bad<T>() -> R<T> {
            refuse("history-bad", "a day index is {1: format, 2: day, 3: rows}")
        }
        let Value::Map(m) = dec(bytes)? else {
            return bad();
        };
        let (Some(Value::Uint(FORMAT)), Some(day), Some(Value::Array(rows))) =
            (m.get(&1), m.get(&2), m.get(&3))
        else {
            return bad();
        };
        let mut out = DayIndex {
            day: read_int(day, "a day")?,
            bundles: Vec::new(),
        };
        for r in rows {
            let Value::Array(r) = r else { return bad() };
            let [s, Value::Bytes(k), Value::Bytes(h)] = r.as_slice() else {
                return bad();
            };
            let key = String::from_utf8(k.clone()).or_else(|_| bad())?;
            let hash: [u8; 32] = h.as_slice().try_into().or_else(|_| bad())?;
            out.bundles.push((read_int(s, "a start")?, key, hash));
        }
        Ok(out)
    }
}

/// The node ids of a snapshot (rule 1), for a reader checking what it holds.
pub fn snapshot_nodes(snapshot: &Value) -> R<Vec<Id>> {
    match snapshot {
        Value::Map(m) => match m.get(&1) {
            Some(Value::Array(rows)) => rows
                .iter()
                .map(|r| match r {
                    Value::Array(p) if p.len() == 2 => read_id(&p[0]),
                    _ => refuse("history-bad", "a snapshot row is [id, node]"),
                })
                .collect(),
            _ => refuse("history-bad", "a snapshot lacks its nodes"),
        },
        _ => refuse("history-bad", "a snapshot is a map"),
    }
}
