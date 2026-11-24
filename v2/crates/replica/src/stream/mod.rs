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
//!    `{1: number, 2: from µs, 3: to µs, 4: first sequence, 5: entries, 6: packed T6 part, 7: state hash, 8: [[first,
//!    count], ...], 9: [carried record, ...]}`, 7 when carried, 8 when the view skipped entries (rule 6), 9 when a
//!    subtree came in (rule 7).
//! 3. **The pointer** ([`Pointer`]) is the one file that changes: the newest part, the period, the header's hash, the
//!    newest part's end in world time, world time against wall time, and "quiet until" for a still world.
//!    `{1: newest, 2: period µs, 3: header hash, 4: newest's end µs, 5: anchor world µs, 6: anchor wall ms, 7: quiet
//!    until µs}`, 1 and 4 once a part is written, 7 when quiet.
//! 4. **Words never travel in parts.** A part is T6 bytes, whose text items are names only (T6 rule 10); free text is
//!    a reference (T8, `{21: id}`). A public stream's words travel beside it, one text file per part
//!    (`worldd::view_out` rule 10); the reader's event query ([`Player::events`]) gives the part's events, whose
//!    references a page looks up in that file (V1b, #3361).
//! 5. **The reader** ([`Player`]) applies parts in number order to R1's replica, refuses a part out of order by name,
//!    and checks each carried hash. It keeps the part's motion samples, every one in entry order ([`Player::samples`]),
//!    so a page draws a body through each of them, not only through its state after the part (V6, #2715).
//! 6. **A view's gaps are declared, never guessed.** A view skips the entries it does not hold (another audience's, or
//!    outside its node; T7 rule 4), so its sequences jump. A part lists each jump before its entries as `[first,
//!    count]`, and the reader's replica accepts exactly those (`Replica::apply_gaps`); a jump a part does not declare
//!    is still refused as `sequence-gap`, so a lost part is never skipped. A stream with no gaps has no field 8.
//! 7. **A subtree carried in lands with its arrive.** When an arrival lands in a view that did not hold its leave, the
//!    view writes the subtree as it was in flight, and where it lands, before the arrive (T7 rule 4, views revision 2).
//!    The part that holds the arrive holds that record, as the view wrote it, in field 9; the reader puts the subtree
//!    in flight just before the arrive of its sequence, which lands it (`Replica::apply_view`). A carried record that
//!    names no destination (revision 1) is refused as `carried-no-destination`.

//!
//! 8. **Checkpoint public observations** (#3639, [`public::PublicPlayer`]). The old constructor and fields retain
//!    their meanings. An explicit pointer field8 is a 32-byte SHA-256 baseline/generation id. Its immutable files
//!    are `g/<hex>/baseline`, `baseline.text`, and numbered parts/text. A baseline is
//!    `{1: 1, 2: exact header hash, 3: authorized projection, 4: physical source cursor}`, with `5: the directory
//!    claim's epoch` when a writer under a claim made it (R16): two claims' writers never make one address, even at
//!    the same state and cursor. A reader takes either form; the epoch changes nothing it plays. The projection retains
//!    exact root kind/fields, live nodes/links, public flight context, public timers/time and opaque public flying
//!    nodes/owned links; it never includes the global arrived ledger or private ancestors. Opaque references are not nodes.
//!    Public queries keep all six R1 shapes; unresolved frame paths refuse `frame-unavailable` without stopping
//!    other queries. Node hashes keep their existing labeled public-node contract; observation digests are
//!    separately SHA-256 over the authorized projection, never a private/global state hash.
//! 9. **One canonical producer, one observer.** Only after validating the WHOLE actual canonical source Part does
//!    the producer attach field10 context beside the unchanged R3 public effects/events. Context is
//!    `{1: 1, 2: baseline digest, 3: prior projection digest, 4: result digest, 5: projection delta,
//!    6: complete physical cursor, 7: [[actual duplicate-Arrive sequence, visible transfer], ...],
//!    8: [[authorized changed node, version], ...]}`. Deltas replace scalar/time fields and upsert/remove id rows
//!    for nodes, links, flights and timers. The trusted producer authorizes observations; a hash alone does not.
//!    The public observer stores them atomically, preserving actual motion samples/events, public sequence gaps
//!    and terminal private gaps, without a second engine apply, manufactured history or private transfer ledger.
//! 10. **Continuity.** Immutable old headers/parts remain at their addresses. An optional pointer field9
//!     `[legacy public version, legacy next-part count, legacy projection digest]` requires an open legacy reader
//!     to drain and compare its actual public state before installing the successor baseline. The browser reconciles baseline nodes through a separate
//!     snapshot callback with no part time, samples, events or playback counters. That terminal may
//!     lie within a physical source Part: the producer validates the whole Part first, retains its original bytes,
//!     and accounts for its genuine remainder once. Baseline/public and complete source cursors are distinct.
//!     A normal restart recovers the same generation, cursor and exact public bytes from the existing private
//!     Store; a newer ordinary checkpoint never replaces that generation's source. Missing/corrupt source is a
//!     named refusal, never a quiet pointer or a ready stream. No epoch, core transfer or retention policy changes.
//! 11. **Generations roll over** (#3825). Every `SOULS_STREAM_GENERATION_PARTS` parts (240 by default, 2 minutes of a busy world) the public
//!     writer closes its generation: the next baseline is the public state at that moment, at the same source cursor,
//!     so its digest is the old generation's last. The pointer then names the new generation (field8) with field9's
//!     handoff for the old one and field10, the old generation's id. A new viewer installs only the newest baseline;
//!     a live viewer on the generation field10 names drains it to field9's part count, checks the version and
//!     digest, and installs the new baseline, so it crosses with no gap. A viewer further behind starts again from
//!     the newest baseline. The boundary is a part count and each rollover is in the recovery chain, so a restart
//!     publishes the same bytes. The current and previous generations are always kept; older ones are removed once
//!     their last write is `SOULS_STREAM_PRUNE_GRACE_S` (600) seconds old. World time and the tick are untouched.

pub mod lz;
pub mod public;
#[cfg(all(target_arch = "wasm32", not(feature = "checker")))]
mod wasm;

use std::collections::BTreeMap;

use crate::apply::Replica;
use crate::effects::{Body, Change, Flight, Header, Part, Refusal};
use crate::encode::{Value, decode, encode, to_hex};
use crate::ids::Id;
use crate::pose::HandOff;
use crate::time::Micros;
use crate::views::{Carried, Key};
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

fn read_gaps(v: Option<&Value>) -> R<Vec<(u64, u64)>> {
    let Some(v) = v else {
        return Ok(Vec::new());
    };
    let Value::Array(a) = v else {
        return refuse("stream-record", "a part's gaps are not a list");
    };
    a.iter()
        .map(|g| match g {
            Value::Array(p) if p.len() == 2 => Ok((
                read_uint(p.first(), "a gap's first")?,
                read_uint(p.get(1), "a gap's count")?,
            )),
            _ => refuse("stream-record", "a gap is [first, count]"),
        })
        .collect()
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
    /// The sequences the view skipped before this part's entries, `(first, count)` in order (rule 6).
    pub gaps: Vec<(u64, u64)>,
    /// The subtrees carried in, each the view's carried record, landed by the arrive of its sequence (rule 7).
    pub carried: Vec<Value>,
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
        if !self.gaps.is_empty() {
            let pairs = self
                .gaps
                .iter()
                .map(|(f, c)| Value::Array(vec![Value::Uint(*f), Value::Uint(*c)]));
            m.insert(8, Value::Array(pairs.collect()));
        }
        if !self.carried.is_empty() {
            m.insert(9, Value::Array(self.carried.clone()));
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
            gaps: read_gaps(m.get(&8))?,
            carried: match m.get(&9) {
                None => Vec::new(),
                Some(Value::Array(a)) => a.clone(),
                Some(_) => {
                    return refuse("stream-record", "a part's carried subtrees are not a list");
                }
            },
        })
    }

    /// Its carried subtrees as flights landing in `header`'s zone, each with the sequence of the arrive that lands it.
    pub fn flights(&self, header: &Header) -> R<Vec<(u64, Flight)>> {
        self.carried
            .iter()
            .map(|r| match Carried::read(r)? {
                Some(c) => Ok((c.sequence, c.flight(header)?)),
                None => refuse("stream-record", "a carried subtree is not a carried record"),
            })
            .collect()
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
    events: Vec<Value>,
}

impl Player {
    /// A reader at the stream's start, from the header's stored bytes.
    pub fn start(header: &[u8]) -> R<Player> {
        Ok(Player {
            replica: Replica::start(header)?,
            next: 0,
            samples: Vec::new(),
            events: Vec::new(),
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

    /// The event query (V1b, #3361): the named events of the part played last, in entry order, each as `{1: name, 2:
    /// fields, 3: the node of its entry, 4: at µs, 5: the entry's sequence}`. A `souls:said` event's words are a
    /// reference (`{21: id}`); the part's text file beside it holds the public words (`worldd::view_out`).
    pub fn events(&self) -> &[Value] {
        &self.events
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
        let flights = sp.flights(self.replica.header())?;
        self.replica.apply_view(&part, &sp.gaps, &flights)?;
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
        self.events = part
            .effects
            .iter()
            .flat_map(|e| {
                e.events.iter().flatten().map(|ev| {
                    Value::Map(BTreeMap::from([
                        (1, Value::Text(ev.name.clone())),
                        (2, Value::Map(ev.fields.clone())),
                        (3, e.envelope.node.to_value()),
                        (4, int(e.envelope.at)),
                        (5, Value::Uint(e.envelope.sequence)),
                    ]))
                })
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
