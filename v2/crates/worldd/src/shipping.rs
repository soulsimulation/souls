//! Shipping the log off the machine (Engine v2 O3, #2732; contract T11, `v2/docs/durability.md` rules 1, 2, 8 and 9).
//! Every sealed piece of a world's log reaches the bucket within seconds, and the world knows exactly how far.
//! Runbook: `v2/docs/runbook/log-shipping.md`.
//!
//! 1. **A shipper off the clock thread** ([`Shipper::spawn`]) is handed each record once it is on the disk (K4's
//!    durable mark), with the number of acts it holds and whether one of them waits for the off-machine mark. The
//!    clock thread never waits on it: it hands records over and reads [`Mark`].
//! 2. **A piece is sealed** when its oldest record has waited [`LOSS_BAR_US`] less the upload's measured time (the
//!    slowest of the last [`MEASURED`] uploads) and [`SEAL_MARGIN_US`], at [`SEAL_BYTES`], or at once when a record
//!    holds an act that cannot be undone. So no acknowledged act is older than 10 s when its piece lands, a world that never rests uploads a
//!    piece about every 10 s, and **a world with no new records uploads nothing.**
//! 3. **A piece is one object,** created only, at T11's part name `part/<lineage>/<zone>/<epoch>/<token>/<record>`
//!    (`replica::durability::part_key`), its sequence the log record it starts at: `{1: format, 2: T6 header bytes,
//!    3: first record, 4: [record, ...]}` in T0's CBOR, then the CRC-32C of those bytes, little-endian. A create
//!    refused because the name exists is this claim's own earlier ship when the bytes are the same, else `part-exists`.
//! 4. **Two marks.** On the provider's success the shipper moves `landed` (records off the machine) and the log's
//!    off-machine gauge. The directory record's mark (`Directory::ship`, one more write) is moved only when a landed
//!    record holds an act that cannot be undone, and whenever the checkpoint pointer moves (O3b, #3458), to the last
//!    record landed; [`Mark::recorded`] is what such an act waits for (T11 rule 2). A piece past the record's mark is
//!    still history for a restore of the claim in force; a takeover's `from` cuts it. A takeover that landed nothing
//!    at its own `from` cuts nothing ([`piece_at`]): a restore that died before its first upload loses no records.
//! 5. **Checkpoints** (K5's files, one file each, so one object each) are shipped from the world's checkpoint folder:
//!    the newest whose records are all landed, at most one each [`CHECKPOINT_GAP_US`], at
//!    `ckpt/<lineage>/<zone>/<epoch>/<token>/<record>`, then a pointer `ckpt/<lineage>/<zone>/newest`, `{1: format,
//!    2: checkpoint key, 3: its record, 4: the record of the piece the log resumes in}`, replaced on its ETag. A
//!    rebuild ([`fetch`]) reads the pointer, one checkpoint and the pieces after it, never a world's whole life.
//! 6. **Two gauges** ([`Gauges`]): the seconds the oldest record not yet off the machine has waited, and its acts.
//!
//! Not here: an unreachable bucket (O10: a failed upload is kept and tried again at the next poll), the restore
//! command, the epoch raise and the restore gate (O12), deleting pieces once V3's packed objects cover them (the store
//! has no delete yet), liveness heartbeats of the directory record (the supervisor's, O1 and O2).

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use directoryd::directory::store::{Store, When};
use directoryd::directory::{Claim, Directory};
use replica::directory::WorldRecord;
use replica::durability::{Takeover, part_key};
use replica::effects::Refusal;
use replica::encode::{Value, decode, encode};
use replica::ids::Id;
use sim::log::crc32c;

#[cfg(test)]
mod tests;

pub type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The format of a piece and of the checkpoint pointer.
pub const FORMAT: u64 = 1;
/// No acknowledged act is older than this when its piece lands (the loss bar, µs).
pub const LOSS_BAR_US: u64 = 10_000_000;
/// A piece seals at this many bytes of records, whatever its age.
pub const SEAL_BYTES: usize = 8 << 20;
/// The upload time assumed before any upload is measured (µs).
pub const FIRST_UPLOAD_US: u64 = 1_000_000;
/// Two polls: a record reaches the shipper up to a poll after it is acknowledged, and a due piece is seen up to a
/// poll late (µs).
pub const SEAL_MARGIN_US: u64 = 100_000;
/// The seal age never falls below this (µs), however slow the uploads were.
pub const SEAL_AGE_LEAST_US: u64 = 1_000_000;
/// The seal age is the loss bar less the slowest of this many latest uploads.
pub const MEASURED: usize = 16;
/// A checkpoint is shipped at most this often (µs): ten minutes.
pub const CHECKPOINT_GAP_US: u64 = 600_000_000;
/// How often the shipper's thread looks at its records and the checkpoint folder.
pub const POLL: Duration = Duration::from_millis(50);

/// Elapsed time in µs, the shipper's only clock (the loss bar and the upload's time are real time, never world time).
pub trait Clock: Send {
    fn now_us(&self) -> u64;
}

/// Real elapsed time since the shipper started.
pub struct Wall(std::time::Instant);

impl Wall {
    #[allow(clippy::disallowed_methods)] // The loss bar is wall time: an upload takes real seconds (K7 allows it here).
    pub fn start() -> Wall {
        Wall(std::time::Instant::now())
    }
}

impl Clock for Wall {
    #[allow(clippy::disallowed_methods)] // As above: the seal age and the upload's time are measured in real time.
    fn now_us(&self) -> u64 {
        self.0.elapsed().as_micros() as u64
    }
}

// --- A piece ------------------------------------------------------------------------------------------------------

/// A piece of the log: records from `first`, with the T6 header bytes they name, so it replays with nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Piece {
    pub header: Vec<u8>,
    pub first: u64,
    pub records: Vec<Vec<u8>>,
}

fn with_crc(body: Vec<u8>) -> Vec<u8> {
    let mut out = body;
    let sum = crc32c(0, &out).to_le_bytes();
    out.extend_from_slice(&sum);
    out
}

fn checked(bytes: &[u8], what: &'static str) -> R<BTreeMap<u64, Value>> {
    if bytes.len() < 4 {
        return refuse(what, "shorter than its checksum");
    }
    let (body, sum) = bytes.split_at(bytes.len() - 4);
    if crc32c(0, body).to_le_bytes() != sum {
        return refuse(what, "the checksum does not match the bytes");
    }
    match decode(body).map(|d| d.value) {
        Ok(Value::Map(m)) => Ok(m),
        Ok(_) => refuse(what, "not a map"),
        Err(e) => refuse(what, e.to_string()),
    }
}

fn enc(v: &Value) -> R<Vec<u8>> {
    encode(v).or_else(|e| refuse("encoding", e.to_string()))
}

impl Piece {
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let v = Value::Map(BTreeMap::from([
            (1, Value::Uint(FORMAT)),
            (2, Value::Bytes(self.header.clone())),
            (3, Value::Uint(self.first)),
            (
                4,
                Value::Array(self.records.iter().cloned().map(Value::Bytes).collect()),
            ),
        ]));
        Ok(with_crc(enc(&v)?))
    }

    pub fn read(bytes: &[u8]) -> R<Piece> {
        let mut m = checked(bytes, "piece-bad")?;
        let (Some(Value::Uint(FORMAT)), Some(Value::Bytes(header)), Some(Value::Uint(first))) =
            (m.remove(&1), m.remove(&2), m.remove(&3))
        else {
            return refuse("piece-bad", "fields 1 to 3");
        };
        let Some(Value::Array(rs)) = m.remove(&4) else {
            return refuse("piece-bad", "field 4");
        };
        let mut records = Vec::with_capacity(rs.len());
        for r in rs {
            match r {
                Value::Bytes(b) => records.push(b),
                _ => return refuse("piece-bad", "a record is not bytes"),
            }
        }
        Ok(Piece {
            header,
            first,
            records,
        })
    }
}

// --- Names --------------------------------------------------------------------------------------------------------

fn zone_key(lineage: &[u8; 16], zone: Id) -> String {
    WorldRecord::key(lineage, zone)
        .trim_start_matches("world/")
        .to_owned()
}

/// A checkpoint's name: the part name of the record it holds up to, under `ckpt/`.
pub fn checkpoint_key(lineage: &[u8; 16], zone: Id, t: &Takeover, record: u64) -> String {
    format!(
        "ckpt/{}",
        part_key(lineage, zone, t, record).trim_start_matches("part/")
    )
}

/// The pointer to the newest shipped checkpoint.
pub fn pointer_key(lineage: &[u8; 16], zone: Id) -> String {
    format!("ckpt/{}/newest", zone_key(lineage, zone))
}

/// The pointer: the newest shipped checkpoint, the record it holds up to, and the first record of the piece the log
/// resumes in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pointer {
    pub checkpoint: String,
    pub record: u64,
    pub from: u64,
}

impl Pointer {
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let v = Value::Map(BTreeMap::from([
            (1, Value::Uint(FORMAT)),
            (2, Value::Bytes(self.checkpoint.as_bytes().to_vec())),
            (3, Value::Uint(self.record)),
            (4, Value::Uint(self.from)),
        ]));
        Ok(with_crc(enc(&v)?))
    }

    pub fn read(bytes: &[u8]) -> R<Pointer> {
        let mut m = checked(bytes, "pointer-bad")?;
        let (
            Some(Value::Uint(FORMAT)),
            Some(Value::Bytes(k)),
            Some(Value::Uint(record)),
            Some(Value::Uint(from)),
        ) = (m.remove(&1), m.remove(&2), m.remove(&3), m.remove(&4))
        else {
            return refuse("pointer-bad", "fields 1 to 4");
        };
        let checkpoint = String::from_utf8(k).or_else(|_| refuse("pointer-bad", "field 2"))?;
        Ok(Pointer {
            checkpoint,
            record,
            from,
        })
    }
}

// --- The marks and the gauges ------------------------------------------------------------------------------------

/// The two gauges: how long the oldest record not yet off the machine has waited, and how many acts wait.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Gauges {
    pub unshipped_us: u64,
    pub unshipped_acts: u64,
}

/// What the shipper has written, by kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Uploads {
    pub pieces: u64,
    pub marks: u64,
    pub checkpoints: u64,
    pub pointers: u64,
}

impl Uploads {
    pub fn total(&self) -> u64 {
        self.pieces + self.marks + self.checkpoints + self.pointers
    }
}

#[derive(Debug, Default)]
struct Marks {
    landed: u64,
    recorded: u64,
    gauges: Gauges,
    uploads: Uploads,
    upload_us: u64,
    error: Option<Refusal>,
}

/// The shipper's marks, for the clock thread and for operators: read without waiting.
#[derive(Clone, Debug, Default)]
pub struct Mark(Arc<Mutex<Marks>>);

impl Mark {
    fn lock(&self) -> std::sync::MutexGuard<'_, Marks> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Records `..landed()` are in the bucket.
    pub fn landed(&self) -> u64 {
        self.lock().landed
    }

    /// Records `..recorded()` are under the directory record's mark: an act that cannot be undone in a record below
    /// it may be acknowledged.
    pub fn recorded(&self) -> u64 {
        self.lock().recorded
    }

    pub fn gauges(&self) -> Gauges {
        self.lock().gauges
    }

    pub fn uploads(&self) -> Uploads {
        self.lock().uploads
    }

    /// The upload time the seal age is reckoned with (µs).
    pub fn upload_us(&self) -> u64 {
        self.lock().upload_us
    }

    /// The last upload that failed, until one succeeds.
    pub fn error(&self) -> Option<Refusal> {
        self.lock().error.clone()
    }
}

/// The seal age for an upload time (µs).
pub fn seal_age(upload_us: u64) -> u64 {
    LOSS_BAR_US
        .saturating_sub(upload_us + SEAL_MARGIN_US)
        .max(SEAL_AGE_LEAST_US)
}

// --- The shipper --------------------------------------------------------------------------------------------------

/// A record handed to the shipper: its number in the log, its bytes, its acts, and whether one of them cannot be
/// undone (it waits for the directory's mark).
pub struct Item {
    pub record: u64,
    pub bytes: Vec<u8>,
    pub acts: u64,
    pub stakes: bool,
}

/// Ships one world's log, as one claim (rule 8: its pieces are named by the claim's epoch and token).
pub struct Shipper<S: Store, C: Clock> {
    dir: Directory<S>,
    claim: Claim,
    lineage: [u8; 16],
    zone: Id,
    header: Vec<u8>,
    clock: C,
    pending: Vec<Vec<u8>>,
    pending_bytes: usize,
    pending_acts: u64,
    oldest: Option<u64>,
    first: u64,
    stakes: bool,
    recent: VecDeque<u64>,
    starts: BTreeMap<u64, u64>,
    checkpoints: Option<PathBuf>,
    checkpoint_gap: u64,
    checkpoint_at: Option<u64>,
    checkpoint_shipped: Option<u64>,
    pointer_etag: Option<String>,
    mark: Mark,
}

impl<S: Store, C: Clock> Shipper<S, C> {
    /// A shipper for the world `lineage`/`zone` under `claim`, its records named by `header` (T6's stored bytes),
    /// starting at record `first` (the records before it are off the machine already).
    pub fn open(
        dir: Directory<S>,
        claim: Claim,
        lineage: [u8; 16],
        zone: Id,
        header: &[u8],
        first: u64,
        clock: C,
    ) -> R<Shipper<S, C>> {
        let pointer_etag = dir.store.get(&pointer_key(&lineage, zone))?.map(|o| o.etag);
        let mark = Mark::default();
        {
            let mut m = mark.lock();
            m.landed = first;
            m.recorded = first;
            m.upload_us = FIRST_UPLOAD_US;
        }
        Ok(Shipper {
            dir,
            claim,
            lineage,
            zone,
            header: header.to_vec(),
            clock,
            pending: Vec::new(),
            pending_bytes: 0,
            pending_acts: 0,
            oldest: None,
            first,
            stakes: false,
            recent: VecDeque::new(),
            starts: BTreeMap::new(),
            checkpoints: None,
            checkpoint_gap: CHECKPOINT_GAP_US,
            checkpoint_at: None,
            checkpoint_shipped: None,
            pointer_etag,
            mark,
        })
    }

    /// Ships K5's checkpoints from `dir`, at most one each `gap` µs.
    pub fn checkpoints(mut self, dir: &Path, gap: u64) -> Shipper<S, C> {
        self.checkpoints = Some(dir.to_path_buf());
        self.checkpoint_gap = gap;
        self
    }

    pub fn mark(&self) -> Mark {
        self.mark.clone()
    }

    /// Keeps its marks in `mark`, one handed out before the shipper opened (R17: a world that listens before the
    /// store answers gives its compactor the marks first; at nothing landed they hold the whole log).
    pub fn sharing(mut self, mark: &Mark) -> Shipper<S, C> {
        *mark.lock() = std::mem::take(&mut *self.mark.lock());
        self.mark = mark.clone();
        self
    }

    /// The seal age: the loss bar less the slowest recent upload and the margin, never below [`SEAL_AGE_LEAST_US`].
    pub fn seal_age(&self) -> u64 {
        seal_age(self.mark.upload_us())
    }

    /// Takes record `item.record` of the log, once on the disk. Records come in order; one already shipped is passed
    /// over, and a gap is refused.
    pub fn push(&mut self, item: Item) -> R<()> {
        let next = self.first + self.pending.len() as u64;
        if item.record < next {
            return Ok(());
        }
        if item.record > next {
            return refuse("ship-gap", format!("record {} after {next}", item.record));
        }
        self.oldest.get_or_insert(self.clock.now_us());
        self.pending_bytes += item.bytes.len();
        self.pending_acts += item.acts;
        self.stakes |= item.stakes;
        self.pending.push(item.bytes);
        Ok(())
    }

    /// Seals and uploads a piece when one is due, ships a checkpoint when one is due, and updates the gauges.
    pub fn poll(&mut self) -> R<()> {
        let now = self.clock.now_us();
        let due = match self.oldest {
            Some(t) => {
                self.stakes
                    || self.pending_bytes >= SEAL_BYTES
                    || now.saturating_sub(t) >= self.seal_age()
            }
            None => false,
        };
        let out = if due { self.ship_piece() } else { Ok(()) };
        let out = out.and_then(|_| self.ship_checkpoint());
        let now = self.clock.now_us();
        let mut m = self.mark.lock();
        m.gauges = Gauges {
            unshipped_us: self.oldest.map_or(0, |t| now.saturating_sub(t)),
            unshipped_acts: self.pending_acts,
        };
        m.error = out.as_ref().err().cloned();
        out
    }

    /// Seals and uploads whatever is waiting, and ships the newest checkpoint if one is due (at a graceful stop).
    pub fn flush(&mut self) -> R<()> {
        if !self.pending.is_empty() {
            self.ship_piece()?;
        }
        self.ship_checkpoint()
    }

    fn create(&self, key: &str, bytes: &[u8]) -> R<()> {
        match self.dir.store.put(key, bytes, When::Absent) {
            Ok(_) => Ok(()),
            Err(e) if e.name == "precondition-failed" => match self.dir.store.get(key)? {
                // The same bytes under this claim's token: an earlier ship of ours, retried (rule 8).
                Some(o) if o.bytes == bytes => Ok(()),
                _ => refuse("part-exists", key.to_owned()),
            },
            Err(e) => Err(e),
        }
    }

    fn ship_piece(&mut self) -> R<()> {
        let piece = Piece {
            header: self.header.clone(),
            first: self.first,
            records: self.pending.clone(),
        };
        let bytes = piece.to_bytes()?;
        let key = part_key(&self.lineage, self.zone, &self.claim.takeover, self.first);
        let t0 = self.clock.now_us();
        self.create(&key, &bytes)?;
        let took = self.clock.now_us().saturating_sub(t0);
        let count = self.pending.len() as u64;
        self.starts.insert(self.first, count);
        self.first += count;
        let stakes = std::mem::take(&mut self.stakes);
        self.pending.clear();
        self.pending_bytes = 0;
        self.pending_acts = 0;
        self.oldest = None;
        self.recent.push_back(took);
        if self.recent.len() > MEASURED {
            self.recent.pop_front();
        }
        {
            let mut m = self.mark.lock();
            m.landed = self.first;
            m.uploads.pieces += 1;
            m.upload_us = self.recent.iter().copied().max().unwrap_or(took);
        }
        if stakes {
            // The directory's mark names the last record stored (inclusive, rule 9).
            self.dir.ship(&mut self.claim, self.first - 1)?;
            let mut m = self.mark.lock();
            m.recorded = self.first;
            m.uploads.marks += 1;
        }
        Ok(())
    }

    /// The newest checkpoint file in the folder: `ckpt-<record>`, its record as 20 digits (K5 rule 3).
    fn newest_checkpoint(&self) -> Option<(u64, PathBuf)> {
        let dir = self.checkpoints.as_ref()?;
        std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let n = name.strip_prefix("ckpt-").filter(|n| n.len() == 20)?;
                Some((n.parse::<u64>().ok()?, e.path()))
            })
            .max_by_key(|(n, _)| *n)
    }

    fn ship_checkpoint(&mut self) -> R<()> {
        let now = self.clock.now_us();
        if self
            .checkpoint_at
            .is_some_and(|t| now.saturating_sub(t) < self.checkpoint_gap)
        {
            return Ok(());
        }
        let Some((record, path)) = self.newest_checkpoint() else {
            return Ok(());
        };
        if self.checkpoint_shipped.is_some_and(|s| s >= record) || record > self.first {
            return Ok(());
        }
        // K5 keeps two files and deletes the older; one gone between the listing and the read waits for the next poll.
        let Ok(bytes) = std::fs::read(&path) else {
            return Ok(());
        };
        // The piece the log resumes in: the landed one holding `record`, or the next one when it starts there.
        let from = self
            .starts
            .range(..=record)
            .next_back()
            .filter(|(s, c)| record < *s + *c)
            .map_or(record, |(s, _)| *s);
        let key = checkpoint_key(&self.lineage, self.zone, &self.claim.takeover, record);
        self.create(&key, &bytes)?;
        let pointer = Pointer {
            checkpoint: key,
            record,
            from,
        }
        .to_bytes()?;
        let when = match &self.pointer_etag {
            Some(e) => When::Is(e),
            None => When::Absent,
        };
        let etag = self
            .dir
            .store
            .put(&pointer_key(&self.lineage, self.zone), &pointer, when)?;
        self.pointer_etag = Some(etag);
        self.checkpoint_shipped = Some(record);
        self.checkpoint_at = Some(now);
        self.starts = self.starts.split_off(&from);
        {
            let mut m = self.mark.lock();
            m.uploads.checkpoints += 1;
            m.uploads.pointers += 1;
        }
        // The directory's mark follows the pointer (O3b, #3458): to the last record landed, at or past the
        // checkpoint, so a takeover's `from` is never before the pointer and a reader from record 0 still reads this
        // claim's pieces up to it.
        if self.first > 0 && self.mark.recorded() < self.first {
            self.dir.ship(&mut self.claim, self.first - 1)?;
            let mut m = self.mark.lock();
            m.recorded = self.first;
            m.uploads.marks += 1;
        }
        Ok(())
    }
}

impl<S: Store + Send + 'static, C: Clock + 'static> Shipper<S, C> {
    /// Runs the shipper on its own thread: it is sent each record once on the disk, looks every [`POLL`], and ships
    /// what is left when the sender is dropped. A failed upload is kept and tried again at the next poll; the last
    /// failure is on [`Mark::error`]. The handle gives back what it wrote, or the refusal that stopped it.
    pub fn spawn(mut self) -> (Sender<Item>, Mark, JoinHandle<R<Uploads>>) {
        let (tx, rx): (Sender<Item>, Receiver<Item>) = channel();
        let mark = self.mark();
        let h = std::thread::spawn(move || {
            loop {
                match rx.recv_timeout(POLL) {
                    Ok(item) => {
                        self.push(item)?;
                        while let Ok(item) = rx.try_recv() {
                            self.push(item)?;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                // An upload that failed is tried again at the next poll (O10 owns an unreachable bucket).
                let _ = self.poll();
            }
            self.flush()?;
            Ok(self.mark.uploads())
        });
        (tx, mark, h)
    }
}

// --- A rebuild's fetch ------------------------------------------------------------------------------------------

/// What a rebuild reads from the bucket: the world's directory record, the newest shipped checkpoint (its record
/// and bytes), and the pieces from the one the log resumes in, in order.
pub struct Fetched {
    pub record: WorldRecord,
    pub checkpoint: Option<(u64, Vec<u8>)>,
    pub pieces: Vec<Piece>,
    pub log: Vec<String>,
}

/// Reads a world from the bucket alone: its directory record, the checkpoint pointer, that one checkpoint, and each
/// piece of the claim in force at its record (rule 8), from the piece the log resumes in until none follows. A piece
/// whose bytes do not check, or that does not start where the last ended, is refused.
pub fn fetch<S: Store>(store: &S, lineage: &[u8; 16], zone: Id) -> R<Fetched> {
    let mut log = Vec::new();
    let Some(rec) = store.get(&WorldRecord::key(lineage, zone))? else {
        return refuse("record-missing", WorldRecord::key(lineage, zone));
    };
    let record = WorldRecord::read(&rec.bytes)?;
    log.push(format!(
        "directory record: epoch {}, mark {:?}",
        record.current().map_or(0, |t| t.epoch),
        record.mark
    ));
    let mut checkpoint = None;
    let mut at = 0;
    if let Some(p) = store.get(&pointer_key(lineage, zone))? {
        let p = Pointer::read(&p.bytes)?;
        let Some(c) = store.get(&p.checkpoint)? else {
            return refuse("checkpoint-missing", p.checkpoint);
        };
        log.push(format!(
            "checkpoint {}: record {}, {} bytes; the log resumes in the piece at {}",
            p.checkpoint,
            p.record,
            c.bytes.len(),
            p.from
        ));
        checkpoint = Some((p.record, c.bytes));
        at = p.from;
    }
    let mut pieces = Vec::new();
    while let Some((key, p, bytes)) = piece_at(store, &record, at)? {
        log.push(format!(
            "piece {key}: records {} to {}, {bytes} bytes",
            p.first,
            p.first + p.records.len() as u64 - 1,
        ));
        at += p.records.len() as u64;
        pieces.push(p);
    }
    log.push(format!(
        "fetched: {} checkpoint, {} pieces, through record {at}",
        u64::from(checkpoint.is_some()),
        pieces.len()
    ));
    Ok(Fetched {
        record,
        checkpoint,
        pieces,
        log,
    })
}

/// The piece of history that starts at record `at` (its name, the piece, its size): the one of the claim in force
/// there (rule 8), or, when that claim has no piece at `at` and none at its own first record either, the one of the
/// claim before it (O3b, #3458). A takeover that died before its first upload landed nothing, so the records past
/// the mark are still its predecessor's, and the next takeover reads them. A piece that does not start at `at`, or
/// holds no records, is refused (`piece-gap`).
pub fn piece_at<S: Store>(
    store: &S,
    rec: &WorldRecord,
    at: u64,
) -> R<Option<(String, Piece, usize)>> {
    for t in rec.takeovers.iter().rev().filter(|t| t.from <= at) {
        let key = part_key(&rec.lineage, rec.zone, t, at);
        if let Some(o) = store.get(&key)? {
            let p = Piece::read(&o.bytes)?;
            if p.first != at || p.records.is_empty() {
                return refuse("piece-gap", format!("{key}: starts at {}", p.first));
            }
            return Ok(Some((key, p, o.bytes.len())));
        }
        // No piece here: the claim's history ends here, unless it landed nothing at its own first record.
        if t.from != at
            && store
                .get(&part_key(&rec.lineage, rec.zone, t, t.from))?
                .is_some()
        {
            return Ok(None);
        }
    }
    Ok(None)
}

/// A restart's claim (O3b, #3458, as the ops tool's restart, `ops world --restart`): a new epoch from the
/// directory's mark plus one, which is where its shipping resumes, the records before it being off the machine under
/// the mark. Refused `restart-gap` when the records this machine holds (`held`) do not reach it.
pub fn take_over<S: Store>(
    dir: &mut Directory<S>,
    lineage: &[u8; 16],
    zone: Id,
    held: std::ops::Range<u64>,
) -> R<Claim> {
    let claim = dir.claim(lineage, zone)?;
    let from = claim.takeover.from;
    if from < held.start || from > held.end {
        return refuse(
            "restart-gap",
            format!(
                "the claim starts at {from}; this machine holds {} to {}",
                held.start, held.end
            ),
        );
    }
    Ok(claim)
}
