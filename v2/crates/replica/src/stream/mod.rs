//! The viewer's stream (Engine v2 V1, #2710): the public view written as small numbered files that a reader plays with
//! no other connection, and the reader, the same code natively and in WASM.
//!
//! 1. **Where.** A key's stream is the directory `<lineage>/<zone>/<epoch>/<node>/<level>/<audience>/` ([`dir`]),
//!    holding numbered parts and one pointer. A restore that lost acts starts a new epoch, so a cached part of the old
//!    one never describes what did not happen. The bundle's header (T6) is written once, at
//!    `<lineage>/<zone>/<epoch>/headers/<hash>` ([`header_path`]); a part names it by hash, inside its T6 part.
//! 2. **A part** ([`StreamPart`]) is the view's records of one [`PERIOD_US`] stretch of world time, as one T6 part,
//!    packed ([`lz`]). Parts are numbered 0, 1, 2, … in the order written, never by world time: a world that is still
//!    writes no part, and a world that jumps ahead (K9) does not leave holes in the numbers. Every [`HASH_EVERY`]th
//!    part (numbers 9, 19, …) carries the state hash (`hash.rs`) of the view's copy after it, so a reader checks it
//!    holds the same state. A part never changes once written; a reader may cache it for a year.
//!    `{1: number, 2: from µs, 3: to µs, 4: first sequence, 5: entries, 6: packed T6 part, 7: state hash}`, 7 when
//!    carried.
//! 3. **The pointer** ([`Pointer`]) is the one file that changes: the newest part, the period, the header's hash, the
//!    newest part's end in world time, world time against wall time, and "quiet until" for a still world.
//!    `{1: newest, 2: period µs, 3: header hash, 4: newest's end µs, 5: anchor world µs, 6: anchor wall ms, 7: quiet
//!    until µs}`, 1 and 4 once a part is written, 7 when quiet.
//! 4. **Words never travel in parts.** A part is T6 bytes, whose text items are names only (T6 rule 10); free text is
//!    a reference (T8, `{21: id}`). Words reach an entitled audience by another path (W4), not here.
//! 5. **The reader** ([`Player`]) applies parts in number order to R1's replica, refuses a part out of order by name,
//!    and checks each carried hash. It keeps the part's motion samples, every one in entry order ([`Player::samples`]),
//!    so a page draws a body through each of them, not only through its state after the part (V6, #2715).

pub mod lz;
#[cfg(all(target_arch = "wasm32", not(feature = "checker")))]
mod wasm;

use std::collections::BTreeMap;

use crate::apply::Replica;
use crate::effects::{Body, Change, Header, Part, Refusal};
use crate::encode::{Value, decode, encode, to_hex};
use crate::ids::Id;
use crate::pose::HandOff;
use crate::time::Micros;
use crate::views::Key;
use crate::world_model::Audience;

type R<T> = Result<T, Refusal>;

/// The world time one part covers.
pub const PERIOD_US: Micros = 500_000;
/// How often a part carries the state hash: numbers 9, 19, 29, …
pub const HASH_EVERY: u64 = 10;
/// The pointer's file name, in the stream's directory.
pub const POINTER: &str = "pointer";

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: Option<&Value>, what: &str) -> R<i64> {
    match v {
        Some(Value::Uint(u)) => {
            i64::try_from(*u).or_else(|_| refuse("stream-record", what.to_owned()))
        }
        Some(Value::Nint(n)) => i64::try_from(*n)
            .map(|n| -1 - n)
            .or_else(|_| refuse("stream-record", what.to_owned())),
        _ => refuse("stream-record", format!("{what} is missing")),
    }
}

fn read_uint(v: Option<&Value>, what: &str) -> R<u64> {
    match v {
        Some(Value::Uint(u)) => Ok(*u),
        _ => refuse("stream-record", format!("{what} is missing")),
    }
}

fn read_bytes(v: Option<&Value>, what: &str) -> R<Vec<u8>> {
    match v {
        Some(Value::Bytes(b)) => Ok(b.clone()),
        _ => refuse("stream-record", format!("{what} is missing")),
    }
}

fn read_map(bytes: &[u8], what: &str) -> R<BTreeMap<u64, Value>> {
    match decode(bytes)
        .or_else(|e| refuse("encoding", e.to_string()))?
        .value
    {
        Value::Map(m) => Ok(m),
        _ => refuse("stream-record", format!("{what} is not a map")),
    }
}

fn bytes_of(v: Value) -> R<Vec<u8>> {
    encode(&v).or_else(|e| refuse("encoding", e.to_string()))
}

fn id_hex(id: Id) -> String {
    format!("{}-{}", to_hex(&id.scope().0), id.counter())
}

/// A key's stream directory, relative to the root the files are served from (rule 1).
pub fn dir(header: &Header, key: &Key) -> String {
    let audience = match key.audience {
        Audience::Everyone => "everyone".to_owned(),
        Audience::Of(id) => id_hex(id),
    };
    format!(
        "{}/{}/{}/{}/{}/{audience}",
        to_hex(&header.lineage.0),
        id_hex(header.zone),
        header.epoch,
        id_hex(key.node),
        key.level.number()
    )
}

/// Where the bundle's header is written, relative to the same root (rule 1).
pub fn header_path(header: &Header) -> String {
    format!(
        "{}/{}/{}/headers/{}",
        to_hex(&header.lineage.0),
        id_hex(header.zone),
        header.epoch,
        header.hash()
    )
}

/// One numbered part (rule 2). `part` is the T6 part's bytes, unpacked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamPart {
    pub number: u64,
    pub from: Micros,
    pub to: Micros,
    pub first: u64,
    pub entries: u64,
    pub part: Vec<u8>,
    pub hash: Option<Vec<u8>>,
}

impl StreamPart {
    /// The file's bytes, the T6 part packed inside.
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let mut m = BTreeMap::from([
            (1, Value::Uint(self.number)),
            (2, int(self.from)),
            (3, int(self.to)),
            (4, Value::Uint(self.first)),
            (5, Value::Uint(self.entries)),
            (6, Value::Bytes(lz::pack(&self.part))),
        ]);
        if let Some(h) = &self.hash {
            m.insert(7, Value::Bytes(h.clone()));
        }
        bytes_of(Value::Map(m))
    }

    /// A part from a file's bytes, its T6 part unpacked (not yet read).
    pub fn read(bytes: &[u8]) -> R<StreamPart> {
        let m = read_map(bytes, "a stream part")?;
        Ok(StreamPart {
            number: read_uint(m.get(&1), "a part's number")?,
            from: read_int(m.get(&2), "a part's start")?,
            to: read_int(m.get(&3), "a part's end")?,
            first: read_uint(m.get(&4), "a part's first sequence")?,
            entries: read_uint(m.get(&5), "a part's entries")?,
            part: lz::unpack(&read_bytes(m.get(&6), "a part's effects")?)?,
            hash: m
                .get(&7)
                .map(|v| read_bytes(Some(v), "a part's hash"))
                .transpose()?,
        })
    }
}

/// The one file that changes (rule 3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pointer {
    pub newest: Option<u64>,
    pub period: Micros,
    pub header: Vec<u8>,
    pub newest_to: Option<Micros>,
    pub anchor_world: Micros,
    pub anchor_wall_ms: u64,
    pub quiet_until: Option<Micros>,
}

impl Pointer {
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let mut m = BTreeMap::from([
            (2, int(self.period)),
            (3, Value::Bytes(self.header.clone())),
            (5, int(self.anchor_world)),
            (6, Value::Uint(self.anchor_wall_ms)),
        ]);
        m.extend(self.newest.map(|n| (1, Value::Uint(n))));
        m.extend(self.newest_to.map(|t| (4, int(t))));
        m.extend(self.quiet_until.map(|t| (7, int(t))));
        bytes_of(Value::Map(m))
    }

    pub fn read(bytes: &[u8]) -> R<Pointer> {
        let m = read_map(bytes, "a pointer")?;
        Ok(Pointer {
            newest: m
                .get(&1)
                .map(|v| read_uint(Some(v), "the newest"))
                .transpose()?,
            period: read_int(m.get(&2), "the period")?,
            header: read_bytes(m.get(&3), "the header")?,
            newest_to: m
                .get(&4)
                .map(|v| read_int(Some(v), "the newest's end"))
                .transpose()?,
            anchor_world: read_int(m.get(&5), "the anchor's world time")?,
            anchor_wall_ms: read_uint(m.get(&6), "the anchor's wall time")?,
            quiet_until: m
                .get(&7)
                .map(|v| read_int(Some(v), "quiet until"))
                .transpose()?,
        })
    }

    /// The same as JSON, for a page: numbers, and the header's hash in hex. Microsecond times stay below 2^53.
    pub fn to_json(&self) -> String {
        let opt = |v: Option<i64>| v.map_or("null".to_owned(), |n| n.to_string());
        format!(
            r#"{{"newest":{},"period":{},"header":"{}","newestTo":{},"anchorWorld":{},"anchorWallMs":{},"quietUntil":{}}}"#,
            self.newest.map_or("null".to_owned(), |n| n.to_string()),
            self.period,
            to_hex(&self.header),
            opt(self.newest_to),
            self.anchor_world,
            self.anchor_wall_ms,
            opt(self.quiet_until)
        )
    }
}

/// What playing one part did (rule 5). `hash` is whether a carried hash matched, none when the part carries none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Played {
    pub number: u64,
    pub from: Micros,
    pub to: Micros,
    pub entries: u64,
    pub version: u64,
    pub hash: Option<bool>,
}

impl Played {
    pub fn to_json(&self) -> String {
        format!(
            r#"{{"number":{},"from":{},"to":{},"entries":{},"version":{},"hash":{}}}"#,
            self.number,
            self.from,
            self.to,
            self.entries,
            self.version,
            self.hash.map_or("null".to_owned(), |h| h.to_string())
        )
    }
}

/// A reader of one stream: R1's replica and the number it expects next (rule 5).
pub struct Player {
    replica: Replica,
    next: u64,
    samples: Vec<HandOff>,
}

impl Player {
    /// A reader at the stream's start, from the header's stored bytes.
    pub fn start(header: &[u8]) -> R<Player> {
        Ok(Player {
            replica: Replica::start(header)?,
            next: 0,
            samples: Vec::new(),
        })
    }

    pub fn next(&self) -> u64 {
        self.next
    }

    pub fn replica(&self) -> &Replica {
        &self.replica
    }

    /// The motion samples of the part played last, every one, in entry order (V6, #2715).
    pub fn samples(&self) -> &[HandOff] {
        &self.samples
    }

    /// Plays one part's file bytes: the next number only, whole or not at all.
    pub fn play(&mut self, bytes: &[u8]) -> R<Played> {
        let sp = StreamPart::read(bytes)?;
        if sp.number != self.next {
            return refuse(
                "stream-gap",
                format!("part {} when {} was next", sp.number, self.next),
            );
        }
        let part = Part::read(&sp.part)?;
        if part.header != self.replica.header().hash().to_bytes() {
            return refuse("header-mismatch", "the part names another header");
        }
        self.replica.apply(&part)?;
        self.next += 1;
        self.samples = part
            .effects
            .iter()
            .filter_map(|e| match &e.body {
                Body::Changes(cs) => Some(cs),
                _ => None,
            })
            .flatten()
            .filter_map(|c| match &c.change {
                Change::Motion(h) => Some(*h),
                _ => None,
            })
            .collect();
        let hash = match &sp.hash {
            Some(h) => Some(*h == crate::hash::state_hash(self.replica.tree())?.to_bytes()),
            None => None,
        };
        Ok(Played {
            number: sp.number,
            from: sp.from,
            to: sp.to,
            entries: sp.entries,
            version: self.replica.version(),
            hash,
        })
    }
}
