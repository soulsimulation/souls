//! The archive packed and shipped, and history bundles made from it (Engine v2 V3, #2712; contract T7). The log is
//! what is kept for ever; everything here but the archive objects is a view that can be made again from them. The
//! object layout and the write sum are in `v2/docs/archive.md`.
//!
//! 1. **A packer off the clock thread** ([`Archiver::spawn`]) is handed each record once it is durable (K4), as R3's
//!    tier is, and packs records into **archive objects**: deflate of `{1: format, 2: T6 header bytes, 3: first
//!    record, 4: [record, ...]}`, then the CRC-32C of the compressed bytes, little-endian. An object closes at
//!    [`TARGET`] bytes of records, when a record falls in a new world day, or at shutdown. Objects are written once
//!    (create only) and never changed.
//! 2. **A manifest per world day** names that day's objects with their SHA-256 and the previous day's manifest; a
//!    **head** names the world's root and its kind (where replay starts) and the newest manifest. A manifest is
//!    rewritten as its day gains objects; the head only when a new day begins.
//! 3. **Bundles** ([`Bundler`], formats in `replica::history`) are the public view at the history level, one
//!    minute of world time each, with a public snapshot at each start, and a **day index** per day, written when the
//!    day closes and at shutdown. A window with no public record writes no bundle: **a still world writes nothing.**
//!    A bundle is stored deflated ([`bundle_stored`], #3284); its day index names the SHA-256 of its bytes before.
//! 4. **No words** (T8): records hold text by reference, and so do objects and bundles; [`words`] scans for them.
//! 5. **Restore** ([`fetch`], [`restore`]) reads the head, the manifests and the objects, checks each against its
//!    hash and checksum, and replays the records from the root with K5's [`replay`]: no local file is read.
//!
//! The store is W8's: an S3-compatible bucket (R2) over HTTP, or its in-memory stand-in. Never production's bucket
//! from a test. Not here: ten-second shipping (O3), serving a restored world (O12), seeking (V4), removal (W7).

use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;

use directoryd::directory::store::{Store, When};
use miniz_oxide::deflate::compress_to_vec;
use miniz_oxide::inflate::decompress_to_vec_with_limit;
use replica::audience::{REFERENCE, WORDS};
use replica::effects::{Header, Part, Refusal, State, read_id};
use replica::encode::{Name, Value, decode, encode};
use replica::history::events::Indexer;
use replica::history::{Bundle, DayIndex, WINDOW_LEAST, day_of, public_snapshot};
use replica::ids::{Id, sha256};
use replica::stream::public::{digest, observation_delta, project};
use replica::tree::Tree;
use replica::views::{Key, Level, Redactions, View};
use replica::world_model::Audience;
use sim::checkpoint::replay;
use sim::log::crc32c;

pub mod script;

pub type R<T> = Result<T, Refusal>;

pub fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The S3-compatible store named by `ARCHIVE_STORE_ENDPOINT`, `_BUCKET`, `_REGION` (default `auto`),
/// `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` and `_PREFIX`: a local stand-in or a scratch bucket, never production's.
pub fn store() -> R<directoryd::directory::s3::S3> {
    let var = |k: &str| std::env::var(format!("ARCHIVE_STORE_{k}")).unwrap_or_default();
    if var("ENDPOINT").is_empty() {
        return refuse("store-settings", "ARCHIVE_STORE_ENDPOINT is not set");
    }
    let region = Some(var("REGION")).filter(|r| !r.is_empty());
    directoryd::directory::s3::S3::new(
        &var("ENDPOINT"),
        &var("BUCKET"),
        region.as_deref().unwrap_or("auto"),
        &var("ACCESS_KEY_ID"),
        &var("SECRET_ACCESS_KEY"),
        &var("PREFIX"),
    )
}

fn enc(v: &Value) -> R<Vec<u8>> {
    encode(v).or_else(|e| refuse("encoding", e.to_string()))
}

fn dec(bytes: &[u8]) -> R<Value> {
    decode(bytes)
        .map(|d| d.value)
        .or_else(|e| refuse("encoding", e.to_string()))
}

fn map(pairs: Vec<(u64, Value)>) -> Value {
    Value::Map(pairs.into_iter().collect())
}

fn text(s: &str) -> Value {
    Value::Bytes(s.as_bytes().to_vec())
}

fn read_text(v: Option<&Value>, what: &str) -> R<String> {
    match v {
        Some(Value::Bytes(b)) => {
            String::from_utf8(b.clone()).or_else(|_| refuse("archive-bad", what.to_owned()))
        }
        _ => refuse("archive-bad", format!("{what} is missing")),
    }
}

fn read_u64(v: Option<&Value>, what: &str) -> R<u64> {
    match v {
        Some(Value::Uint(u)) => Ok(*u),
        _ => refuse("archive-bad", format!("{what} is not a count")),
    }
}

/// The archive format this build writes and reads: objects, manifests and the head.
pub const FORMAT: u64 = 1;

/// An object closes once it holds this many bytes of records (64 MiB; some minutes of a busy world's log).
pub const TARGET: usize = 64 << 20;

/// The most bytes an object may inflate to: twice the target, as one record past it may be large.
const INFLATE_MOST: usize = 2 * TARGET + (16 << 20);

/// An archive object as read (rule 1): the header its records name, its first record's number and the records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    pub header: Vec<u8>,
    pub first: u64,
    pub records: Vec<Vec<u8>>,
}

impl Segment {
    /// Its stored bytes: deflate of the CBOR body, then that's CRC-32C.
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let body = enc(&map(vec![
            (1, Value::Uint(FORMAT)),
            (2, Value::Bytes(self.header.clone())),
            (3, Value::Uint(self.first)),
            (
                4,
                Value::Array(self.records.iter().cloned().map(Value::Bytes).collect()),
            ),
        ]))?;
        let mut out = compress_to_vec(&body, 6);
        out.extend_from_slice(&crc32c(0, &out).to_le_bytes());
        Ok(out)
    }

    /// The body an object's bytes hold, checked by its CRC-32C and inflated.
    pub fn body(bytes: &[u8]) -> R<Vec<u8>> {
        if bytes.len() < 4 {
            return refuse("archive-crc", "shorter than its checksum");
        }
        let (z, sum) = bytes.split_at(bytes.len() - 4);
        if crc32c(0, z).to_le_bytes() != sum {
            return refuse("archive-crc", "the checksum does not match the bytes");
        }
        decompress_to_vec_with_limit(z, INFLATE_MOST)
            .or_else(|e| refuse("archive-inflate", format!("{e:?}")))
    }

    pub fn read(bytes: &[u8]) -> R<Segment> {
        let Value::Map(mut m) = dec(&Segment::body(bytes)?)? else {
            return refuse("archive-bad", "an object is a map");
        };
        if m.get(&1) != Some(&Value::Uint(FORMAT)) {
            return refuse("archive-format", "an object of another format");
        }
        let (Some(Value::Bytes(header)), Some(Value::Uint(first)), Some(Value::Array(recs))) =
            (m.remove(&2), m.remove(&3), m.remove(&4))
        else {
            return refuse(
                "archive-bad",
                "an object is {1, 2: header, 3: first, 4: records}",
            );
        };
        let records = recs
            .into_iter()
            .map(|r| match r {
                Value::Bytes(b) => Ok(b),
                _ => refuse("archive-bad", "a record is bytes"),
            })
            .collect::<R<_>>()?;
        Ok(Segment {
            header,
            first,
            records,
        })
    }
}

/// Object writes a world made, by what they were (`v2/docs/archive.md`, the write sum).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Writes {
    pub objects: u64,
    pub manifests: u64,
    pub heads: u64,
    pub bundles: u64,
    pub indexes: u64,
    /// The event index's hours and the coarse levels (V4).
    pub views: u64,
}

impl Writes {
    pub fn total(&self) -> u64 {
        self.objects + self.manifests + self.heads + self.bundles + self.indexes + self.views
    }

    fn add(&mut self, o: Writes) {
        self.objects += o.objects;
        self.manifests += o.manifests;
        self.heads += o.heads;
        self.bundles += o.bundles;
        self.indexes += o.indexes;
        self.views += o.views;
    }
}

/// One store shared by the packer and the shelf, on the archiver's thread.
pub struct Shared<S>(pub std::sync::Arc<S>);

impl<S> Clone for Shared<S> {
    fn clone(&self) -> Self {
        Shared(self.0.clone())
    }
}

impl<S: Store> Store for Shared<S> {
    fn get(&self, key: &str) -> R<Option<directoryd::directory::store::Object>> {
        self.0.get(key)
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        self.0.put(key, bytes, when)
    }

    fn list(&self, prefix: &str) -> R<Vec<String>> {
        self.0.list(prefix)
    }
}

/// Writes `bytes` at `key`: create only when `etag` is none, else only over that version. Returns the new ETag.
fn put<S: Store>(store: &S, key: &str, bytes: &[u8], etag: Option<&str>) -> R<String> {
    store.put(key, bytes, etag.map_or(When::Absent, When::Is))
}

/// The last entry's world time, when the record has an entry. Empty parts carry no observation time.
fn record_at(bytes: &[u8]) -> R<Option<i64>> {
    Ok(Part::read(bytes)?.effects.last().map(|e| e.envelope.at))
}

/// One row of a day's manifest: an object's key, its epoch, first record, record count and SHA-256.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub key: String,
    pub epoch: u64,
    pub first: u64,
    pub count: u64,
    pub sha256: [u8; 32],
}

/// A day's manifest (rule 2): `{1: format, 2: day, 3: [[key, epoch, first, count, SHA-256], ...], 4: previous}`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Manifest {
    pub day: i64,
    pub rows: Vec<Row>,
    pub previous: Option<String>,
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

impl Manifest {
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let rows = self
            .rows
            .iter()
            .map(|r| {
                Value::Array(vec![
                    text(&r.key),
                    Value::Uint(r.epoch),
                    Value::Uint(r.first),
                    Value::Uint(r.count),
                    Value::Bytes(r.sha256.to_vec()),
                ])
            })
            .collect();
        let mut m = vec![
            (1, Value::Uint(FORMAT)),
            (2, int(self.day)),
            (3, Value::Array(rows)),
        ];
        m.extend(self.previous.as_deref().map(|p| (4, text(p))));
        enc(&map(m))
    }

    pub fn read(bytes: &[u8]) -> R<Manifest> {
        let Value::Map(m) = dec(bytes)? else {
            return refuse("archive-bad", "a manifest is a map");
        };
        let day = match m.get(&2) {
            Some(Value::Uint(u)) => *u as i64,
            Some(Value::Nint(n)) => -1 - *n as i64,
            _ => return refuse("archive-bad", "a manifest's day"),
        };
        let Some(Value::Array(rows)) = m.get(&3) else {
            return refuse("archive-bad", "a manifest's rows");
        };
        let rows = rows
            .iter()
            .map(|r| match r {
                Value::Array(p) if p.len() == 5 => Ok(Row {
                    key: read_text(p.first(), "a key")?,
                    epoch: read_u64(p.get(1), "an epoch")?,
                    first: read_u64(p.get(2), "a first record")?,
                    count: read_u64(p.get(3), "a count")?,
                    sha256: match &p[4] {
                        Value::Bytes(b) => b
                            .as_slice()
                            .try_into()
                            .or_else(|_| refuse("archive-bad", "a SHA-256"))?,
                        _ => return refuse("archive-bad", "a SHA-256"),
                    },
                }),
                _ => refuse("archive-bad", "a manifest row"),
            })
            .collect::<R<_>>()?;
        let previous = m
            .get(&4)
            .map(|p| read_text(Some(p), "a previous manifest"))
            .transpose()?;
        Ok(Manifest {
            day,
            rows,
            previous,
        })
    }
}

/// The head (rule 2): `{1: format, 2: root id, 3: root kind, 4: newest manifest}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Head {
    pub root: Id,
    pub kind: Name,
    pub newest: String,
    pub base: Option<[u8; 32]>,
}

impl Head {
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let mut fields = vec![
            (1, Value::Uint(FORMAT)),
            (2, self.root.to_value()),
            (3, Value::Text(self.kind.clone())),
            (4, text(&self.newest)),
        ];
        fields.extend(self.base.map(|b| (5, Value::Bytes(b.to_vec()))));
        enc(&map(fields))
    }

    pub fn read(bytes: &[u8]) -> R<Head> {
        let Value::Map(m) = dec(bytes)? else {
            return refuse("archive-bad", "a head is a map");
        };
        let (Some(root), Some(Value::Text(kind))) = (m.get(&2), m.get(&3)) else {
            return refuse("archive-bad", "a head is {2: root, 3: kind, 4: newest}");
        };
        Ok(Head {
            root: read_id(root)?,
            kind: kind.clone(),
            newest: read_text(m.get(&4), "the newest manifest")?,
            base: m
                .get(&5)
                .map(|v| match v {
                    Value::Bytes(b) => b
                        .as_slice()
                        .try_into()
                        .or_else(|_| refuse("archive-base", "base digest")),
                    _ => refuse("archive-base", "base digest"),
                })
                .transpose()?,
        })
    }
}

/// Exact trusted K5/header recovery source; private and immutable, never a public bundle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Base {
    pub header: Vec<u8>,
    pub checkpoint: Vec<u8>,
    pub record: u64,
}
impl Base {
    pub fn read(header: &[u8], checkpoint: &[u8]) -> R<Self> {
        let h = Header::read(header)?;
        let restored = sim::checkpoint::read_bytes(checkpoint)?;
        let root = restored
            .tree
            .node(restored.tree.root())
            .ok_or_else(|| Refusal {
                name: "archive-base",
                detail: "checkpoint root missing".into(),
            })?;
        if restored.root.version.lineage != h.lineage
            || restored.root.version.zone != h.zone
            || restored.root.version.epoch != h.epoch
            || restored.root.version.sequence != restored.tree.next()
            || root.id() != h.zone
            || !h.kinds.contains(root.kind())
        {
            return refuse(
                "archive-base-mismatch",
                "checkpoint identity/version/root pin",
            );
        }
        Ok(Self {
            header: header.to_vec(),
            checkpoint: checkpoint.to_vec(),
            record: restored.root.record,
        })
    }
    /// First publication of a filtered fork uses its original sealed record-zero base. Engine recovery still
    /// uses its newest checkpoint; both routes must reach exactly the same canonical state and durable boundary.
    pub fn initial_fork(
        header: &[u8],
        original: &[u8],
        newest: &[u8],
        found: &sim::log::Recovered,
    ) -> R<Self> {
        let base = Self::read(header, original)?;
        let latest = Self::read(header, newest)?;
        let h = Header::read(header)?;
        let initial = sim::checkpoint::read_bytes(original)?;
        let log = found.header.as_ref().ok_or_else(|| Refusal {
            name: "archive-source-missing",
            detail: "fork log header".into(),
        })?;
        if base.record != 0
            || found.first != 0
            || log.epoch != h.epoch
            || initial.root.log
                != Some(sim::log::At {
                    record: 0,
                    offset: sim::log::HEADER_LEN as u64,
                    crc: log.salt,
                })
            || latest.record > found.records.len() as u64
        {
            return refuse(
                "archive-source-missing",
                "original fork boundary or contiguous source",
            );
        }
        let check_pins = |tree: &Tree| -> R<()> {
            let state = tree.to_state();
            if state
                .nodes
                .values()
                .chain(state.in_flight.values().flat_map(|f| f.nodes.values()))
                .any(|n| !h.kinds.contains(&n.kind))
            {
                return refuse(
                    "archive-base-mismatch",
                    "checkpoint definition pin absent from exact header",
                );
            }
            Ok(())
        };
        let mut from_original = base.tree()?;
        let mut from_latest = latest.tree()?;
        check_pins(&from_original)?;
        check_pins(&from_latest)?;
        for (record, bytes) in found.records.iter().enumerate() {
            if record as u64 == latest.record
                && state_hash(&mut from_original)? != state_hash(&mut from_latest)?
            {
                return refuse(
                    "archive-source-mismatch",
                    "original replay differs from newest checkpoint",
                );
            }
            if sim::recorder::is_input(bytes) {
                sim::recorder::read(bytes)?;
            } else {
                let part = Part::read(bytes)?;
                from_original.apply(&h, &part)?;
                if record as u64 >= latest.record {
                    from_latest.apply(&h, &part)?;
                }
            }
        }
        if state_hash(&mut from_original)? != state_hash(&mut from_latest)? {
            return refuse(
                "archive-source-mismatch",
                "original and newest final replay differ",
            );
        }
        Ok(base)
    }
    pub fn tree(&self) -> R<Tree> {
        Ok(sim::checkpoint::read_bytes(&self.checkpoint)?.tree)
    }
    pub fn bytes(&self) -> R<Vec<u8>> {
        enc(&map(vec![
            (1, Value::Uint(1)),
            (2, Value::Bytes(self.header.clone())),
            (3, Value::Bytes(self.checkpoint.clone())),
        ]))
    }
    fn stored(bytes: &[u8]) -> R<Self> {
        let Value::Map(m) = dec(bytes)? else {
            return refuse("archive-base", "base map");
        };
        let (Some(Value::Uint(1)), Some(Value::Bytes(h)), Some(Value::Bytes(c))) =
            (m.get(&1), m.get(&2), m.get(&3))
        else {
            return refuse("archive-base", "base fields");
        };
        Self::read(h, c)
    }
}

// --- The packer ---------------------------------------------------------------------------------------------------

/// Packs durable records into archive objects and keeps the manifests and the head (rules 1 and 2).
pub struct Packer<S: Store> {
    store: S,
    prefix: String,
    target: usize,
    header: Vec<u8>,
    epoch: u64,
    root: Id,
    kind: Name,
    open: Vec<Vec<u8>>,
    open_first: u64,
    open_bytes: usize,
    open_day: i64,
    next: u64,
    day: Option<(Manifest, Option<String>)>,
    head_etag: Option<String>,
    base: Option<[u8; 32]>,
    pub writes: Writes,
}

impl<S: Store> Packer<S> {
    /// A packer for the world whose root is `root` (of `kind`), its log's records named by `header` (T6's stored
    /// bytes), writing keys under `prefix`. A world already archived resumes after its newest object of this epoch.
    pub fn open(store: S, prefix: &str, header: &[u8], root: Id, kind: Name) -> R<Packer<S>> {
        let epoch = Header::read(header)?.epoch;
        let mut p = Packer {
            store,
            prefix: prefix.to_owned(),
            target: TARGET,
            header: header.to_vec(),
            epoch,
            root,
            kind,
            open: Vec::new(),
            open_first: 0,
            open_bytes: 0,
            open_day: 0,
            next: 0,
            day: None,
            head_etag: None,
            base: None,
            writes: Writes::default(),
        };
        if let Some(h) = p.store.get(&p.key("head"))? {
            p.head_etag = Some(h.etag);
            let head = Head::read(&h.bytes)?;
            if head.base.is_some() {
                return refuse("archive-based-head", "use the based archive reader");
            }
            let newest = head.newest;
            let Some(m) = p.store.get(&newest)? else {
                return refuse("archive-missing", newest);
            };
            let manifest = Manifest::read(&m.bytes)?;
            p.open_day = manifest.day;
            if let Some(r) = manifest.rows.iter().rev().find(|r| r.epoch == epoch) {
                p.next = r.first + r.count;
            }
            p.day = Some((manifest, Some(m.etag)));
        }
        p.open_first = p.next;
        Ok(p)
    }

    fn open_based(store: S, prefix: &str, base: &Base) -> R<Self> {
        let header = Header::read(&base.header)?;
        let tree = base.tree()?;
        let root = tree.node(tree.root()).ok_or_else(|| Refusal {
            name: "archive-base",
            detail: "root missing".into(),
        })?;
        let bytes = base.bytes()?;
        let hash = sha256(&bytes);
        let mut p = Self {
            store,
            prefix: prefix.into(),
            target: TARGET,
            header: base.header.clone(),
            epoch: header.epoch,
            root: root.id(),
            kind: root.kind().clone(),
            open: Vec::new(),
            open_first: base.record,
            open_bytes: 0,
            open_day: 0,
            next: base.record,
            day: None,
            head_etag: None,
            base: Some(hash),
            writes: Writes::default(),
        };
        let key = p.key(&format!("base/{}", replica::encode::to_hex(&hash)));
        immutable_store(&p.store, &key, &bytes)?;
        if let Some(old) = p.store.get(&p.key("head"))? {
            let h = Head::read(&old.bytes)?;
            if h.base != Some(hash) || h.root != p.root || h.kind != p.kind {
                return refuse("archive-base-mismatch", "durable archive base differs");
            }
            p.head_etag = Some(old.etag);
            if !h.newest.is_empty() {
                let m = get(&p.store, &h.newest)?;
                let m = Manifest::read(&m)?;
                let row = m.rows.last().ok_or_else(|| Refusal {
                    name: "archive-gap",
                    detail: "empty based range".into(),
                })?;
                p.next = row.first.checked_add(row.count).ok_or_else(|| Refusal {
                    name: "archive-gap",
                    detail: "range overflow".into(),
                })?;
                p.open_day = m.day;
                p.day = Some((m, Some(h.newest)));
            }
        } else {
            let h = Head {
                root: p.root,
                kind: p.kind.clone(),
                newest: String::new(),
                base: Some(hash),
            };
            p.head_etag = Some(p.store.put(&p.key("head"), &h.to_bytes()?, When::Absent)?);
            p.writes.heads += 1;
        }
        p.open_first = p.next;
        Ok(p)
    }

    /// The bytes of records an object closes at (a test sets it small).
    pub fn set_target(&mut self, bytes: usize) {
        self.target = bytes.max(1);
    }

    fn key(&self, rest: &str) -> String {
        format!("{}archive/{rest}", self.prefix)
    }

    /// Takes record `n` of the log, once durable. A record already archived is passed over; a gap is refused.
    pub fn push(&mut self, n: u64, bytes: Vec<u8>) -> R<()> {
        if n < self.next {
            return Ok(());
        }
        if n > self.next {
            return refuse("archive-gap", format!("record {n} after {}", self.next));
        }
        let day = if self.base.is_some() && sim::recorder::is_input(&bytes) {
            sim::recorder::read(&bytes)?;
            self.open_day
        } else {
            record_at(&bytes)?.map_or(self.open_day, day_of)
        };
        if !self.open.is_empty() && day != self.open_day {
            self.close()?;
        }
        self.open_day = day;
        self.open_bytes += bytes.len();
        self.open.push(bytes);
        self.next += 1;
        if self.open_bytes >= self.target {
            self.close()?;
        }
        Ok(())
    }

    /// Closes the open object, if any (at shutdown, or a test's end).
    pub fn flush(&mut self) -> R<()> {
        if self.open.is_empty() {
            return Ok(());
        }
        self.close()
    }

    fn close(&mut self) -> R<()> {
        let seg = Segment {
            header: self.header.clone(),
            first: self.open_first,
            records: std::mem::take(&mut self.open),
        };
        let bytes = seg.to_bytes()?;
        let key = if self.base.is_some() {
            self.key(&format!(
                "obj/{:010}-{:020}-{}",
                self.epoch,
                seg.first,
                replica::encode::to_hex(&sha256(&bytes))
            ))
        } else {
            self.key(&format!("obj/{:010}-{:020}", self.epoch, seg.first))
        };
        put(&self.store, &key, &bytes, None)?;
        self.writes.objects += 1;
        let row = Row {
            key,
            epoch: self.epoch,
            first: seg.first,
            count: seg.records.len() as u64,
            sha256: sha256(&bytes),
        };
        self.open_first = self.next;
        self.open_bytes = 0;
        if let Some(base) = self.base {
            let previous = self.day.as_ref().and_then(|(_, key)| key.clone());
            let manifest = Manifest {
                day: self.open_day,
                rows: vec![row],
                previous,
            };
            let key = self.key(&format!(
                "range/{:010}-{:020}-{}",
                self.epoch,
                seg.first,
                replica::encode::to_hex(&sha256(&bytes))
            ));
            immutable_store(&self.store, &key, &manifest.to_bytes()?)?;
            let head = Head {
                root: self.root,
                kind: self.kind.clone(),
                newest: key.clone(),
                base: Some(base),
            };
            self.head_etag = Some(put(
                &self.store,
                &self.key("head"),
                &head.to_bytes()?,
                self.head_etag.as_deref(),
            )?);
            self.day = Some((manifest, Some(key)));
            self.writes.manifests += 1;
            self.writes.heads += 1;
            return Ok(());
        }
        let new_day = match &self.day {
            Some((m, _)) => m.day != self.open_day,
            None => true,
        };
        if new_day {
            let previous = self
                .day
                .as_ref()
                .map(|(m, _)| self.key(&format!("day/{:08}", m.day)));
            let m = Manifest {
                day: self.open_day,
                rows: Vec::new(),
                previous,
            };
            self.day = Some((m, None));
        }
        let (m, etag) = self.day.as_mut().expect("a day is open");
        m.rows.push(row);
        let mkey = format!("{}archive/day/{:08}", self.prefix, m.day);
        *etag = Some(put(&self.store, &mkey, &m.to_bytes()?, etag.as_deref())?);
        self.writes.manifests += 1;
        if new_day {
            let head = Head {
                root: self.root,
                kind: self.kind.clone(),
                newest: mkey,
                base: None,
            };
            let hkey = self.key("head");
            self.head_etag = Some(put(
                &self.store,
                &hkey,
                &head.to_bytes()?,
                self.head_etag.as_deref(),
            )?);
            self.writes.heads += 1;
        }
        Ok(())
    }
}

// --- Bundles ------------------------------------------------------------------------------------------------------

/// How long a bundle's window is, µs: one minute (V4, #2713). A seek fetches a snapshot and one whole bundle, and at
/// the busiest load a five-minute bundle alone is past what the reference link carries in two seconds
/// (`v2/docs/archive.md`, seeking).
pub const WINDOW: i64 = WINDOW_LEAST;

/// Builds bundles from records (rule 3): the root's public view at the history level ([`Level::Sampled`]: motion
/// thinned to one sample a second per node, R3's lowest level that still draws motion), in windows of [`WINDOW`] of
/// world time, each with the public snapshot at its start.
#[derive(Clone)]
struct BasedWindow {
    start: i64,
    snapshot: Value,
    view: View,
    baseline: Value,
    observed: Value,
    cursor: (u64, u64),
    rows: Vec<Value>,
    base_hash: [u8; 32],
}
#[derive(Default)]
struct BasedHistory {
    anchor: Option<i64>,
    open: Option<BasedWindow>,
    base_hash: [u8; 32],
}

pub struct Bundler {
    header: Option<Header>,
    redactions: Redactions,
    before: State,
    after: State,
    root: Id,
    open: Option<(i64, Value, View)>,
    based: Option<BasedHistory>,
}

impl Bundler {
    pub fn new(root: Id, kind: Name) -> Bundler {
        let s = State::start(root, kind);
        Bundler {
            header: None,
            redactions: Redactions::default(),
            before: s.clone(),
            after: s,
            root,
            open: None,
            based: None,
        }
    }

    pub fn from_base(base: &Base) -> R<Self> {
        Self::from_base_with_redactions(base, Redactions::default())
    }
    pub fn from_base_with_redactions(base: &Base, redactions: Redactions) -> R<Self> {
        let tree = base.tree()?;
        let state = tree.to_state();
        Ok(Self {
            header: Some(Header::read(&base.header)?),
            redactions,
            before: state.clone(),
            after: state,
            root: tree
                .node(tree.root())
                .ok_or_else(|| Refusal {
                    name: "archive-base",
                    detail: "root missing".into(),
                })?
                .id(),
            open: None,
            based: Some(BasedHistory {
                base_hash: sha256(&base.bytes()?),
                ..BasedHistory::default()
            }),
        })
    }
    fn projected(&self, header: &Header, state: &State) -> R<Value> {
        let t = std::time::Instant::now();
        let p = project(header, state)?;
        let a = t.elapsed().as_millis();
        let public = self.redactions.scrub(p);
        let b = t.elapsed().as_millis();
        replica::stream::public::validate_projection(header, &public)?;
        let d0 = std::time::Instant::now();
        let _ = digest(&public);
        eprintln!("PROF projected project {a} scrub {} validate {} ms; digest {} ms", b - a, t.elapsed().as_millis() - b, d0.elapsed().as_millis());
        Ok(public)
    }
    fn close_based(&self, header: &Header, open: BasedWindow) -> R<Option<Bundle>> {
        if open.rows.is_empty() && open.view.output().records.is_empty() {
            return Ok(None);
        }
        let terminal = open
            .rows
            .last()
            .and_then(|r| {
                if let Value::Array(r) = r {
                    Some(Value::Array(r[..2].to_vec()))
                } else {
                    None
                }
            })
            .unwrap_or_else(|| {
                Value::Array(vec![Value::Uint(open.cursor.0), Value::Uint(open.cursor.1)])
            });
        let published = open
            .rows
            .last()
            .and_then(|r| {
                if let Value::Array(r) = r {
                    r.get(2)
                } else {
                    None
                }
            })
            .and_then(|v| {
                if let Value::Uint(n) = v {
                    Some(*n)
                } else {
                    None
                }
            });
        let observation = map(vec![
            (1, Value::Uint(1)),
            (2, Value::Bytes(header.hash().to_bytes())),
            (3, open.baseline),
            (
                4,
                Value::Array(vec![Value::Uint(open.cursor.0), Value::Uint(open.cursor.1)]),
            ),
            (5, Value::Array(open.rows)),
            (6, Value::Bytes(digest(&open.observed)?)),
            (7, terminal),
            (8, Value::Bytes(open.base_hash.to_vec())),
        ]);
        let mut view = open.view.output();
        // Unseen entries advance the internal sampler, but cannot make a private-only public bundle update.
        view.position.sequence = published;
        Bundle::new_based(
            header.hash().to_bytes(),
            open.start,
            WINDOW,
            open.snapshot,
            view.to_value(),
            observation,
        )
        .map(Some)
    }
    fn feed_based(&mut self, header: &Header, record: u64, bytes: &[u8]) -> R<Vec<Bundle>> {
        let tw = std::time::Instant::now();
        let mut tp = std::time::Duration::ZERO; let mut ts = std::time::Duration::ZERO; let mut ta = std::time::Duration::ZERO; let mut td = std::time::Duration::ZERO;
        let part = Part::read(bytes)?;
        let mut whole = self.before.clone();
        whole.apply(header, &part)?;
        eprintln!("PROF feed record {record}: {} effects, whole {} ms", part.effects.len(), tw.elapsed().as_millis());
        let mut mode = self.based.take().ok_or_else(|| Refusal {
            name: "archive-base",
            detail: "based builder missing".into(),
        })?;
        let result = (|| {
            let mut done = Vec::new();
            for (offset, e) in part.effects.iter().enumerate() {
                let t = std::time::Instant::now();
                self.after.apply_entry(header, e)?;
                ta += t.elapsed(); let t = std::time::Instant::now();
                let old = self.projected(header, &self.before)?;
                let after = self.projected(header, &self.after)?;
                tp += t.elapsed();
                let start = match mode.anchor {
                    Some(anchor) => e
                        .envelope
                        .at
                        .checked_sub(anchor)
                        .and_then(|n| n.div_euclid(WINDOW).checked_mul(WINDOW))
                        .and_then(|n| anchor.checked_add(n))
                        .ok_or_else(|| Refusal {
                            name: "history-window",
                            detail: "rolling range overflow".into(),
                        })?,
                    None => e.envelope.at,
                };
                let same = mode.open.as_ref().is_some_and(|o| o.start == start);
                let mut probe = (!same).then(|| {
                    View::new(
                        Key {
                            node: self.root,
                            level: Level::Sampled,
                            audience: Audience::Everyone,
                        },
                        header,
                        &self.redactions,
                    )
                });
                let view = if same {
                    &mut mode.open.as_mut().expect("open window").view
                } else {
                    probe.as_mut().expect("candidate view")
                };
                let prior = view.output().records.len();
                let t = std::time::Instant::now();
                view.step(&self.before, e, &self.after, &self.redactions)?;
                ts += t.elapsed();
                let kept = view.output().records.len() != prior;
                let mut old_visible = old.clone();
                let mut after_visible = after.clone();
                if let Value::Map(m) = &mut old_visible {
                    m.remove(&1);
                }
                if let Value::Map(m) = &mut after_visible {
                    m.remove(&1);
                }
                let thinned = matches!(&e.body,replica::effects::Body::Changes(cs) if !cs.is_empty() && cs.iter().all(|c|matches!(&c.change,replica::effects::Change::Motion(_))))
                    && !kept;
                let observe = kept || (!thinned && old_visible != after_visible);
                let t = std::time::Instant::now();
                if observe {
                    mode.anchor.get_or_insert(e.envelope.at);
                    if !same {
                        if let Some(open) = mode.open.take() {
                            done.extend(self.close_based(header, open)?);
                        }
                        mode.open = Some(BasedWindow {
                            start,
                            snapshot: public_snapshot(
                                &replica::history::seek::live_observation(header, &old)?,
                                &self.redactions,
                            ),
                            view: probe.take().expect("candidate view"),
                            baseline: old.clone(),
                            observed: old,
                            cursor: (record, offset as u64),
                            rows: Vec::new(),
                            base_hash: mode.base_hash,
                        });
                    }
                    let open = mode.open.as_mut().expect("observation window");
                    let delta = observation_delta(header, &open.observed, &after)?;
                    open.rows.push(Value::Array(vec![
                        Value::Uint(record),
                        Value::Uint(offset as u64 + 1),
                        Value::Uint(e.envelope.sequence),
                        int(e.envelope.at),
                        Value::Bytes(digest(&open.observed)?),
                        Value::Bytes(digest(&after)?),
                        delta,
                    ]));
                    open.observed = after;
                }
                td += t.elapsed();
                self.before.apply_entry(header, e)?;
            }
            eprintln!("PROF feed record {record}: apply {} project {} step {} observe {} total {} ms", ta.as_millis(), tp.as_millis(), ts.as_millis(), td.as_millis(), tw.elapsed().as_millis());
            Ok(done)
        })();
        self.based = Some(mode);
        result
    }

    fn close(&mut self) -> R<Option<Bundle>> {
        let (Some((start, snapshot, view)), Some(h)) = (self.open.take(), &self.header) else {
            return Ok(None);
        };
        let out = view.output();
        if out.records.is_empty() {
            return Ok(None);
        }
        Bundle::new(h.hash().to_bytes(), start, WINDOW, snapshot, out.to_value()).map(Some)
    }

    /// Feeds one record (a T6 part, named by `header`); returns the bundles it closed.
    pub fn feed(&mut self, header: &Header, bytes: &[u8]) -> R<Vec<Bundle>> {
        let mut done = Vec::new();
        if self.header.as_ref().map(|h| h.hash()) != Some(header.hash()) {
            done.extend(self.close()?);
            self.header = Some(header.clone());
        }
        let part = Part::read(bytes)?;
        for e in &part.effects {
            let start = e.envelope.at.div_euclid(WINDOW) * WINDOW;
            if self.open.as_ref().is_some_and(|(s, _, _)| *s != start) {
                done.extend(self.close()?);
            }
            if self.open.is_none() {
                let key = Key {
                    node: self.root,
                    level: Level::Sampled,
                    audience: Audience::Everyone,
                };
                let view = View::new(key, header, &self.redactions);
                let snap = public_snapshot(&self.before, &self.redactions);
                self.open = Some((start, snap, view));
            }
            self.after.apply_entry(header, e)?;
            if let Some((_, _, v)) = &mut self.open {
                v.step(&self.before, e, &self.after, &self.redactions)?;
            }
            self.before.apply_entry(header, e)?;
        }
        Ok(done)
    }

    /// Closes the open window (at shutdown).
    pub fn finish(&mut self) -> R<Option<Bundle>> {
        if let Some(mode) = &mut self.based {
            let open = mode.open.clone();
            return match open {
                Some(open) => self.close_based(self.header.as_ref().expect("based header"), open),
                None => Ok(None),
            };
        }
        self.close()
    }
}

/// The most bytes a stored bundle may inflate to, as for an archive object.
const BUNDLE_MOST: usize = INFLATE_MOST;

/// A bundle's stored bytes (#3284): deflate (RFC 1951) of its bytes. Its snapshot is most of a quiet minute's bundle
/// and deflates to about a twentieth; the index names the hash of the bytes before, so a bundle made again from the
/// archive is checked by what it holds, not by how it was compressed.
pub fn bundle_stored(b: &Bundle) -> Vec<u8> {
    compress_to_vec(b.bytes(), 6)
}

/// A bundle's bytes from its stored bytes, inflated up to a limit; check them by the hash its index names.
pub fn bundle_body(stored: &[u8]) -> R<Vec<u8>> {
    decompress_to_vec_with_limit(stored, BUNDLE_MOST)
        .or_else(|e| refuse("history-inflate", format!("{e:?}")))
}

/// Stores bundles and a day index per day (rule 3).
pub struct Shelf<S: Store> {
    store: S,
    prefix: String,
    day: Option<(DayIndex, Option<String>)>,
    /// The ETag of each view written here (V4's event index and coarse levels), to write over it.
    etags: BTreeMap<String, String>,
    pub writes: Writes,
    based: bool,
}

impl<S: Store> Shelf<S> {
    pub fn new(store: S, prefix: &str) -> Shelf<S> {
        Shelf {
            store,
            prefix: prefix.to_owned(),
            day: None,
            etags: BTreeMap::new(),
            writes: Writes::default(),
            based: false,
        }
    }

    fn new_based(store: S, prefix: &str) -> Self {
        let mut shelf = Self::new(store, prefix);
        shelf.based = true;
        shelf
    }

    /// Writes a view of the event index or the coarse levels (V4) at `key` under the prefix, over its last version.
    pub fn put_view(&mut self, key: &str, bytes: &[u8]) -> R<()> {
        let key = format!("{}{key}", self.prefix);
        if self.based
            && !self.etags.contains_key(&key)
            && let Some(old) = self.store.get(&key)?
        {
            self.etags.insert(key.clone(), old.etag);
        }
        let e = put(
            &self.store,
            &key,
            bytes,
            self.etags.get(&key).map(String::as_str),
        )?;
        self.etags.insert(key, e);
        self.writes.views += 1;
        Ok(())
    }

    fn index_key(&self, day: i64) -> String {
        format!("{}bundles/{day:08}/index", self.prefix)
    }

    fn write_index(&mut self) -> R<()> {
        let Some((ix, etag)) = &self.day else {
            return Ok(());
        };
        let key = self.index_key(ix.day);
        let e = put(&self.store, &key, &ix.to_bytes()?, etag.as_deref())?;
        self.writes.indexes += 1;
        if let Some((_, etag)) = &mut self.day {
            *etag = Some(e);
        }
        Ok(())
    }

    pub fn put(&mut self, b: &Bundle) -> R<()> {
        let day = day_of(b.start);
        if self.day.as_ref().is_some_and(|(ix, _)| ix.day != day) {
            self.write_index()?;
            self.day = None;
        }
        let key = if b.observation.is_some() {
            format!(
                "{}bundles/{day:08}/{:020}-{}",
                self.prefix,
                b.start,
                replica::encode::to_hex(&b.hash())
            )
        } else {
            format!("{}bundles/{day:08}/{:020}", self.prefix, b.start)
        };
        if b.observation.is_some() {
            immutable_store(&self.store, &key, &bundle_stored(b))?;
        } else {
            put(&self.store, &key, &bundle_stored(b), None)?;
        }
        self.writes.bundles += 1;
        if self.day.is_none() {
            let existing = if self.based {
                self.store.get(&self.index_key(day))?
            } else {
                None
            };
            self.day = Some(match existing {
                Some(object) => (DayIndex::read(&object.bytes)?, Some(object.etag)),
                None => (
                    DayIndex {
                        day,
                        bundles: Vec::new(),
                    },
                    None,
                ),
            });
        }
        let (ix, _) = self.day.as_mut().expect("day index");
        if b.observation.is_some() {
            ix.bundles.retain(|(start, _, _)| *start != b.start);
        }
        ix.bundles.push((b.start, key, b.hash()));
        if self.based {
            ix.bundles.sort_by_key(|(start, _, _)| *start);
        }
        Ok(())
    }

    /// Writes the open day's index (at shutdown; the day may gain bundles later, and its index is then rewritten).
    pub fn flush(&mut self) -> R<()> {
        self.write_index()
    }
}

/// A record handed to the archiver: its number in the log and its bytes.
pub type Record = (u64, Vec<u8>);

/// The packer, the bundler and the shelf together, as a world runs them.
pub struct Archiver<S: Store> {
    pub packer: Packer<S>,
    pub shelf: Shelf<S>,
    bundler: Bundler,
    indexer: Indexer,
    header: Header,
    based: Option<(Tree, BTreeMap<u64, Vec<u8>>, Base)>,
}

impl<S: Store + Clone> Archiver<S> {
    pub fn open(store: S, prefix: &str, header: &Header, root: Id, kind: Name) -> R<Archiver<S>> {
        Ok(Archiver {
            packer: Packer::open(store.clone(), prefix, header.stored(), root, kind.clone())?,
            shelf: Shelf::new(store, prefix),
            bundler: Bundler::new(root, kind),
            indexer: Indexer::default(),
            header: header.clone(),
            based: None,
        })
    }
}

impl<S: Store + Clone> Archiver<S> {
    /// The original durable base wins on reopen; a newer ordinary checkpoint never replaces it.
    pub fn open_based(store: S, prefix: &str, candidate: &Base) -> R<Self> {
        Self::open_based_with_redactions(store, prefix, candidate, Redactions::default())
    }
    pub fn open_based_with_redactions(
        store: S,
        prefix: &str,
        candidate: &Base,
        redactions: Redactions,
    ) -> R<Self> {
        let t0 = std::time::Instant::now();
        macro_rules! t { ($n:expr) => { eprintln!("PROF archive {} {} ms", $n, t0.elapsed().as_millis()) } }
        let checked = Base::read(&candidate.header, &candidate.checkpoint)?;
        if checked.record != candidate.record {
            return refuse("archive-base-mismatch", "checkpoint cursor differs");
        }
        let fetched = if store.get(&format!("{prefix}archive/head"))?.is_some() {
            Some(fetch(&store, prefix)?)
        } else {
            None
        };
        t!("fetched");
        let base = match &fetched {
            Some(f) => f.base.clone().ok_or_else(|| Refusal {
                name: "archive-unbased-head",
                detail: "cannot implicitly convert a legacy archive".into(),
            })?,
            None => candidate.clone(),
        };
        if base.header != candidate.header {
            return refuse("archive-base-mismatch", "current world header differs");
        }
        let header = Header::read(&base.header)?;
        let canonical = match &fetched {
            Some(f) => restore(f)?,
            None => base.tree()?,
        };
        t!("canonical");
        let mut out = Self {
            packer: Packer::open_based(store.clone(), prefix, &base)?,
            shelf: Shelf::new_based(store, prefix),
            bundler: Bundler::from_base_with_redactions(&base, redactions.clone())?,
            indexer: Indexer::new(redactions.clone()),
            header,
            based: Some((canonical, BTreeMap::new(), base)),
        };
        t!("constructed");
        if let Some(f) = fetched {
            for segment in f.segments {
                for (offset, raw) in segment.records.into_iter().enumerate() {
                    let n = segment.first + offset as u64;
                    if sim::recorder::is_input(&raw) {
                        sim::recorder::read(&raw)?;
                    }
                    out.based.as_mut().expect("based archive").1.insert(n, raw);
                }
            }
        }
        t!("known");
        out.refresh_redactions_inner(redactions, true)?;
        t!("refreshed");
        Ok(out)
    }
}

impl<S: Store> Archiver<S> {
    /// Takes record `n` of the log, once durable.
    pub fn source_cursor(&self) -> u64 {
        self.packer.next
    }
    pub fn is_based(&self) -> bool {
        self.based.is_some()
    }
    pub fn source_base(&self) -> u64 {
        self.based.as_ref().map_or(0, |(_, _, base)| base.record)
    }
    /// The existing authoritative text Store is consulted by the caller before publication. Rebuild only the
    /// derived public views when that list changes; private base/source and old hash-addressed bundles stay exact.
    pub fn refresh_redactions(&mut self, redactions: Redactions) -> R<bool> {
        self.refresh_redactions_inner(redactions, false)
    }
    fn refresh_redactions_inner(&mut self, redactions: Redactions, force: bool) -> R<bool> {
        let Some((_, known, base)) = &self.based else {
            return Ok(false);
        };
        if !force && self.bundler.redactions.hash() == redactions.hash() {
            return Ok(false);
        }
        let t0 = std::time::Instant::now();
        let mut bundler = Bundler::from_base_with_redactions(base, redactions.clone())?;
        eprintln!("PROF refresh bundler {} ms, {} known", t0.elapsed().as_millis(), known.len());
        let mut indexer = Indexer::new(redactions);
        let mut bundles = Vec::new();
        let mut views = BTreeMap::new();
        for (n, raw) in known {
            if sim::recorder::is_input(raw) {
                sim::recorder::read(raw)?;
                continue;
            }
            bundles.extend(bundler.feed_based(&self.header, *n, raw)?);
            for effect in &Part::read(raw)?.effects {
                views.extend(indexer.feed(effect)?);
            }
        }
        eprintln!("PROF refresh fed {} ms", t0.elapsed().as_millis());
        bundles.extend(bundler.finish()?);
        views.extend(indexer.clone().finish()?);
        // A removed event may leave an old mutable index with no surviving rows. Publish its canonical empty form.
        for key in self
            .shelf
            .store
            .list(&format!("{}history/everyone/", self.shelf.prefix))?
        {
            let Some(relative) = key.strip_prefix(&self.shelf.prefix) else {
                continue;
            };
            if views.contains_key(relative) {
                continue;
            }
            let raw = get(&self.shelf.store, &key)?;
            let bytes = if relative.starts_with("history/everyone/events/") {
                let mut index = replica::history::events::EventIndex::read(&raw)?;
                index.rows.clear();
                index.split.clear();
                index.to_bytes()?
            } else if relative.starts_with("history/everyone/counts/") {
                let counts = replica::history::events::Counts::read(&raw)?;
                replica::history::events::Counts::new(counts.span).to_bytes()?
            } else {
                continue;
            };
            views.insert(relative.to_owned(), bytes);
        }
        eprintln!("PROF refresh listed {} ms {} bundles {} views", t0.elapsed().as_millis(), bundles.len(), views.len());
        // Derive/validate everything before publishing any replacement index.
        for bundle in bundles {
            self.shelf.put(&bundle)?;
        }
        for (key, bytes) in views {
            self.shelf.put_view(&key, &bytes)?;
        }
        self.shelf.flush()?;
        eprintln!("PROF refresh published {} ms", t0.elapsed().as_millis());
        self.bundler = bundler;
        self.indexer = indexer;
        Ok(true)
    }
    /// Publish the existing open public window/index without inventing effects or forcing a private packing cut.
    pub fn publish_open(&mut self) -> R<()> {
        if let Some(bundle) = self.bundler.finish()? {
            self.shelf.put(&bundle)?;
        }
        for (k, v) in self.indexer.clone().finish()? {
            self.shelf.put_view(&k, &v)?;
        }
        self.shelf.flush()
    }
    fn feed_public(&mut self, n: u64, bytes: &[u8]) -> R<()> {
        let bundles = if self.bundler.based.is_some() {
            self.bundler.feed_based(&self.header, n, bytes)?
        } else {
            self.bundler.feed(&self.header, bytes)?
        };
        for bundle in bundles {
            self.shelf.put(&bundle)?;
        }
        for e in &Part::read(bytes)?.effects {
            for (k, v) in self.indexer.feed(e)? {
                self.shelf.put_view(&k, &v)?;
            }
        }
        Ok(())
    }
    pub fn push(&mut self, n: u64, bytes: Vec<u8>) -> R<()> {
        if let Some((tree, known, _)) = &mut self.based {
            if n < self.packer.next {
                return if known.get(&n) == Some(&bytes) {
                    Ok(())
                } else {
                    refuse(
                        "archive-source-mismatch",
                        "duplicate physical source differs",
                    )
                };
            }
            if n != self.packer.next {
                return refuse("archive-gap", "physical source does not follow");
            }
            if sim::recorder::is_input(&bytes) {
                sim::recorder::read(&bytes)?;
            } else {
                tree.apply(&self.header, &Part::read(&bytes)?)?;
            }
        }
        if !(self.based.is_some() && sim::recorder::is_input(&bytes)) {
            self.feed_public(n, &bytes)?;
        }
        self.packer.push(n, bytes.clone())?;
        if let Some((_, known, _)) = &mut self.based {
            known.insert(n, bytes);
        }
        Ok(())
    }

    /// Closes what is open: the object, the window and the day's index.
    pub fn flush(&mut self) -> R<()> {
        self.packer.flush()?;
        if let Some(b) = self.bundler.finish()? {
            self.shelf.put(&b)?;
        }
        let views = if self.based.is_some() {
            self.indexer.clone().finish()?
        } else {
            self.indexer.finish()?
        };
        for (k, v) in views {
            self.shelf.put_view(&k, &v)?;
        }
        self.shelf.flush()
    }

    /// The open day's event index and counts as they stand, without closing them (a running world's, R16b).
    pub fn open_views(&self) -> R<Vec<(String, Vec<u8>)>> {
        self.indexer.clone().finish()
    }

    pub fn writes(&self) -> Writes {
        let mut w = self.packer.writes;
        w.add(self.shelf.writes);
        w
    }
}

impl<S: Store + Send + 'static> Archiver<S> {
    /// Runs the archiver on its own thread, off the clock thread (rule 1): it is sent each record once durable, and
    /// flushes when the sender is dropped. The handle gives its writes back, or the refusal that stopped it.
    pub fn spawn(mut self) -> (Sender<Record>, JoinHandle<R<Writes>>) {
        let (tx, rx): (Sender<Record>, Receiver<Record>) = channel();
        let h = std::thread::spawn(move || {
            for (n, bytes) in rx {
                self.push(n, bytes)?;
            }
            self.flush()?;
            Ok(self.writes())
        });
        (tx, h)
    }
}

// --- Restore ------------------------------------------------------------------------------------------------------

/// What the store holds for a world: its head, its manifests oldest first and every object, checked.
pub struct Fetched {
    pub head: Head,
    pub manifests: Vec<Manifest>,
    pub segments: Vec<Segment>,
    pub log: Vec<String>,
    pub base: Option<Base>,
}

fn immutable_store<S: Store>(store: &S, key: &str, bytes: &[u8]) -> R<()> {
    match store.put(key, bytes, When::Absent) {
        Ok(_) => Ok(()),
        Err(e) if e.name == "precondition-failed" => match store.get(key)? {
            Some(o) if o.bytes == bytes => Ok(()),
            _ => Err(e),
        },
        Err(e) => Err(e),
    }
}

fn get<S: Store>(store: &S, key: &str) -> R<Vec<u8>> {
    match store.get(key)? {
        Some(o) => Ok(o.bytes),
        None => refuse("archive-missing", key.to_owned()),
    }
}

/// Reads a world's archive from the store alone (rule 5): the head, each manifest back to the first, and each object,
/// checked against the SHA-256 its manifest names and its CRC-32C; records must run on without a gap in each epoch.
pub fn fetch<S: Store>(store: &S, prefix: &str) -> R<Fetched> {
    let mut log = Vec::new();
    let head = Head::read(&get(store, &format!("{prefix}archive/head"))?)?;
    log.push(format!(
        "head: root {}, newest {}",
        replica::world_model::show(head.root),
        head.newest
    ));
    let mut manifests = Vec::new();
    let base = match head.base {
        Some(hash) => {
            let bytes = get(
                store,
                &format!("{prefix}archive/base/{}", replica::encode::to_hex(&hash)),
            )?;
            if sha256(&bytes) != hash {
                return refuse("archive-base-hash", "base digest differs");
            }
            let base = Base::stored(&bytes)?;
            let tree = base.tree()?;
            let root = tree.node(tree.root()).ok_or_else(|| Refusal {
                name: "archive-base",
                detail: "root missing".into(),
            })?;
            if root.id() != head.root || *root.kind() != head.kind {
                return refuse("archive-base-mismatch", "head root differs");
            }
            Some(base)
        }
        None => None,
    };
    let mut next = (!head.newest.is_empty()).then(|| head.newest.clone());
    let mut visited = std::collections::BTreeSet::new();
    while let Some(k) = next {
        if !visited.insert(k.clone()) {
            return refuse("archive-gap", "manifest cycle");
        }
        let m = Manifest::read(&get(store, &k)?)?;
        next = m.previous.clone();
        manifests.push(m);
    }
    manifests.reverse();
    let mut segments = Vec::new();
    let mut expect: BTreeMap<u64, u64> = BTreeMap::new();
    for m in &manifests {
        for r in &m.rows {
            let bytes = get(store, &r.key)?;
            if sha256(&bytes) != r.sha256 {
                return refuse("archive-hash", r.key.clone());
            }
            let s = Segment::read(&bytes)?;
            if let Some(base) = &base
                && (s.header != base.header || r.epoch != Header::read(&base.header)?.epoch)
            {
                return refuse("archive-base-mismatch", "range header or epoch differs");
            }
            let at = expect
                .entry(r.epoch)
                .or_insert(base.as_ref().map_or(0, |b| b.record));
            if s.first != *at || r.first != s.first || s.records.len() as u64 != r.count {
                return refuse(
                    "archive-gap",
                    format!("{}: records {} after {}", r.key, s.first, *at),
                );
            }
            *at += r.count;
            log.push(format!(
                "object {}: {} records from {}, {} bytes, sha256 {} checked",
                r.key,
                r.count,
                r.first,
                bytes.len(),
                replica::encode::to_hex(&r.sha256)
            ));
            segments.push(s);
        }
    }
    log.push(format!(
        "{} manifests, {} objects, {} records",
        manifests.len(),
        segments.len(),
        segments.iter().map(|s| s.records.len()).sum::<usize>()
    ));
    Ok(Fetched {
        head,
        manifests,
        segments,
        log,
        base,
    })
}

/// The world rebuilt from what was fetched: its root, then every record replayed in order (K5's replay).
pub fn restore(f: &Fetched) -> R<Tree> {
    let mut tree = match &f.base {
        Some(base) => base.tree()?,
        None => Tree::start(f.head.root, f.head.kind.clone()),
    };
    for s in &f.segments {
        if f.base.is_some() {
            for raw in &s.records {
                if sim::recorder::is_input(raw) {
                    sim::recorder::read(raw)?;
                }
            }
        }
        replay(&mut tree, &Header::read(&s.header)?, &s.records, 0)?;
    }
    Ok(tree)
}

/// A tree's state hashes, each audience's, joined (the public one first), as K5's restart bench prints them.
pub fn state_hash(tree: &mut Tree) -> R<String> {
    Ok(tree
        .seal()?
        .hashes()
        .values()
        .map(|h| h.to_string())
        .collect::<Vec<_>>()
        .join(","))
}

/// Bundles made again from what was fetched, as the archiver made them live.
pub fn rebuild_bundles(f: &Fetched) -> R<Vec<Bundle>> {
    rebuild_bundles_with_redactions(f, Redactions::default())
}
pub fn rebuild_bundles_with_redactions(f: &Fetched, redactions: Redactions) -> R<Vec<Bundle>> {
    let mut b = match &f.base {
        Some(base) => Bundler::from_base_with_redactions(base, redactions)?,
        None => Bundler::new(f.head.root, f.head.kind.clone()),
    };
    let mut out = Vec::new();
    for s in &f.segments {
        let h = Header::read(&s.header)?;
        for (offset, r) in s.records.iter().enumerate() {
            if f.base.is_some() && sim::recorder::is_input(r) {
                sim::recorder::read(r)?;
                continue;
            }
            out.extend(if f.base.is_some() {
                b.feed_based(&h, s.first + offset as u64, r)?
            } else {
                b.feed(&h, r)?
            });
        }
    }
    out.extend(b.finish()?);
    Ok(out)
}

/// The bundles stored for the days the archive covers: each day index read, each bundle checked against its hash.
pub fn stored_bundles<S: Store>(store: &S, prefix: &str, f: &Fetched) -> R<Vec<Bundle>> {
    let mut out = Vec::new();
    let mut days: Vec<i64> = f.manifests.iter().map(|m| m.day).collect();
    if f.base.is_some() {
        for segment in &f.segments {
            for raw in &segment.records {
                if sim::recorder::is_input(raw) {
                    continue;
                }
                for effect in Part::read(raw)?.effects {
                    days.push(day_of(effect.envelope.at));
                    if let Some(before) = effect.envelope.at.checked_sub(WINDOW - 1) {
                        days.push(day_of(before));
                    }
                }
            }
        }
    }
    days.sort_unstable();
    days.dedup();
    for d in days {
        let Some(ix) = store.get(&format!("{prefix}bundles/{d:08}/index"))? else {
            continue;
        };
        for (_, key, hash) in DayIndex::read(&ix.bytes)?.bundles {
            let b = Bundle::read(&bundle_body(&get(store, &key)?)?)?;
            if b.hash() != hash {
                return refuse("history-hash", key);
            }
            out.push(b);
        }
    }
    Ok(out)
}

// --- Words --------------------------------------------------------------------------------------------------------

/// Where words appear in `v` or its `raw` bytes (rule 4): a reference carrying words beside it (`{21: id, 23: ...}`),
/// or any of `known` (words the world's text store holds) anywhere in the bytes. Empty when there are none.
pub fn words(v: &Value, raw: &[u8], known: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![v];
    while let Some(v) = stack.pop() {
        match v {
            Value::Map(m) => {
                if m.contains_key(&REFERENCE) && m.contains_key(&WORDS) {
                    found.push("a reference with words beside it".to_owned());
                }
                stack.extend(m.values());
            }
            Value::Array(a) => stack.extend(a.iter()),
            _ => {}
        }
    }
    for w in known {
        if raw.windows(w.len()).any(|x| x == w.as_bytes()) {
            found.push(format!("the words {w:?}"));
        }
    }
    found
}

/// Words in an archive object (its inflated body) or a bundle's bytes; see [`words`].
pub fn words_in_object(bytes: &[u8], known: &[&str]) -> R<Vec<String>> {
    let body = Segment::body(bytes)?;
    let mut found = words(&dec(&body)?, &body, known);
    for r in Segment::read(bytes)?.records {
        found.extend(words(&dec(&r)?, &r, known));
    }
    Ok(found)
}

pub fn words_in_bundle(bytes: &[u8], known: &[&str]) -> R<Vec<String>> {
    Ok(words(&dec(bytes)?, bytes, known))
}

// --- Seeking and the event index (V4, #2713) ----------------------------------------------------------------------

/// The event index and the coarse levels made again from what was fetched, as the archiver made them live: each
/// view's key (under the prefix) and its last bytes.
pub fn rebuild_views(f: &Fetched) -> R<BTreeMap<String, Vec<u8>>> {
    rebuild_views_with_redactions(f, Redactions::default())
}
pub fn rebuild_views_with_redactions(
    f: &Fetched,
    redactions: Redactions,
) -> R<BTreeMap<String, Vec<u8>>> {
    let mut ix = Indexer::new(redactions);
    let mut out = BTreeMap::new();
    for s in &f.segments {
        for r in &s.records {
            if f.base.is_some() && sim::recorder::is_input(r) {
                sim::recorder::read(r)?;
                continue;
            }
            for e in &Part::read(r)?.effects {
                out.extend(ix.feed(e)?);
            }
        }
    }
    out.extend(ix.finish()?);
    Ok(out)
}

/// What a seek fetched: the public state at its moment, the bytes and the requests it took.
pub struct Seeked {
    pub state: State,
    pub bytes: u64,
    pub requests: u32,
    /// The keys it read, in order.
    pub keys: Vec<String>,
}

/// The public state at world time `at` (µs), from the store alone and cold: the day's index, then the bundle that
/// holds `at` (the last that starts at or before it), checked by its hash and applied up to `at`. A day with none
/// before `at` sends it to the day before, back to a year.
pub fn seek<S: Store>(store: &S, prefix: &str, header: &Header, at: i64) -> R<Seeked> {
    let (mut bytes, mut requests, mut keys) = (0u64, 0u32, Vec::new());
    let day = day_of(at);
    for d in (day - replica::history::events::YEAR_DAYS..=day).rev() {
        requests += 1;
        let k = format!("{prefix}bundles/{d:08}/index");
        let Some(o) = store.get(&k)? else {
            continue;
        };
        keys.push(k);
        bytes += o.bytes.len() as u64;
        let ix = DayIndex::read(&o.bytes)?;
        let Some((_, key, hash)) = replica::history::seek::nearest(&ix, at) else {
            continue;
        };
        let b = get(store, key)?;
        requests += 1;
        bytes += b.len() as u64;
        let b = Bundle::read_named(&bundle_body(&b)?, hash)?;
        return Ok(Seeked {
            state: replica::history::seek::state_at(&b, header, at)?,
            bytes,
            requests,
            keys: [keys, vec![key.clone()]].concat(),
        });
    }
    refuse(
        "history-none",
        format!("no bundle in the year before {at} µs"),
    )
}
