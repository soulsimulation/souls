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

/// The world time of a record: its last entry's.
fn record_at(bytes: &[u8]) -> R<i64> {
    Ok(Part::read(bytes)?
        .effects
        .last()
        .map_or(0, |e| e.envelope.at))
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
}

impl Head {
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        enc(&map(vec![
            (1, Value::Uint(FORMAT)),
            (2, self.root.to_value()),
            (3, Value::Text(self.kind.clone())),
            (4, text(&self.newest)),
        ]))
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
        })
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
            writes: Writes::default(),
        };
        if let Some(h) = p.store.get(&p.key("head"))? {
            p.head_etag = Some(h.etag);
            let newest = Head::read(&h.bytes)?.newest;
            let Some(m) = p.store.get(&newest)? else {
                return refuse("archive-missing", newest);
            };
            let manifest = Manifest::read(&m.bytes)?;
            if let Some(r) = manifest.rows.iter().rev().find(|r| r.epoch == epoch) {
                p.next = r.first + r.count;
            }
            p.day = Some((manifest, Some(m.etag)));
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
        let day = day_of(record_at(&bytes)?);
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
        let key = self.key(&format!("obj/{:010}-{:020}", self.epoch, seg.first));
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
pub struct Bundler {
    header: Option<Header>,
    redactions: Redactions,
    before: State,
    after: State,
    root: Id,
    open: Option<(i64, Value, View)>,
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
        }
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
}

impl<S: Store> Shelf<S> {
    pub fn new(store: S, prefix: &str) -> Shelf<S> {
        Shelf {
            store,
            prefix: prefix.to_owned(),
            day: None,
            etags: BTreeMap::new(),
            writes: Writes::default(),
        }
    }

    /// Writes a view of the event index or the coarse levels (V4) at `key` under the prefix, over its last version.
    pub fn put_view(&mut self, key: &str, bytes: &[u8]) -> R<()> {
        let key = format!("{}{key}", self.prefix);
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
        let key = format!("{}bundles/{day:08}/{:020}", self.prefix, b.start);
        put(&self.store, &key, &bundle_stored(b), None)?;
        self.writes.bundles += 1;
        let (ix, _) = self.day.get_or_insert_with(|| {
            (
                DayIndex {
                    day,
                    bundles: Vec::new(),
                },
                None,
            )
        });
        ix.bundles.push((b.start, key, b.hash()));
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
}

impl<S: Store + Clone> Archiver<S> {
    pub fn open(store: S, prefix: &str, header: &Header, root: Id, kind: Name) -> R<Archiver<S>> {
        Ok(Archiver {
            packer: Packer::open(store.clone(), prefix, header.stored(), root, kind.clone())?,
            shelf: Shelf::new(store, prefix),
            bundler: Bundler::new(root, kind),
            indexer: Indexer::default(),
            header: header.clone(),
        })
    }
}

impl<S: Store> Archiver<S> {
    /// Takes record `n` of the log, once durable.
    pub fn push(&mut self, n: u64, bytes: Vec<u8>) -> R<()> {
        for b in self.bundler.feed(&self.header, &bytes)? {
            self.shelf.put(&b)?;
        }
        for e in &Part::read(&bytes)?.effects {
            for (k, v) in self.indexer.feed(e)? {
                self.shelf.put_view(&k, &v)?;
            }
        }
        self.packer.push(n, bytes)
    }

    /// Closes what is open: the object, the window and the day's index.
    pub fn flush(&mut self) -> R<()> {
        self.packer.flush()?;
        if let Some(b) = self.bundler.finish()? {
            self.shelf.put(&b)?;
        }
        for (k, v) in self.indexer.finish()? {
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
    let mut next = Some(head.newest.clone());
    while let Some(k) = next {
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
            let at = expect.entry(r.epoch).or_insert(0);
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
    })
}

/// The world rebuilt from what was fetched: its root, then every record replayed in order (K5's replay).
pub fn restore(f: &Fetched) -> R<Tree> {
    let mut tree = Tree::start(f.head.root, f.head.kind.clone());
    for s in &f.segments {
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
    let mut b = Bundler::new(f.head.root, f.head.kind.clone());
    let mut out = Vec::new();
    for s in &f.segments {
        let h = Header::read(&s.header)?;
        for r in &s.records {
            out.extend(b.feed(&h, r)?);
        }
    }
    out.extend(b.finish()?);
    Ok(out)
}

/// The bundles stored for the days the archive covers: each day index read, each bundle checked against its hash.
pub fn stored_bundles<S: Store>(store: &S, prefix: &str, f: &Fetched) -> R<Vec<Bundle>> {
    let mut out = Vec::new();
    let mut days: Vec<i64> = f.manifests.iter().map(|m| m.day).collect();
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
    let mut ix = Indexer::default();
    let mut out = BTreeMap::new();
    for s in &f.segments {
        for r in &s.records {
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
