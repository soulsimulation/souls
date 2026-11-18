//! Checkpoints and restart (Engine v2 K5, #2669; contract T11 in `v2/docs/TRUNK.md`, `v2/docs/durability.md` rule 13).
//! A world restarts from its newest good checkpoint and the log after it, so restart time follows the log since the
//! last checkpoint, never the world's age; and a world where nothing changes writes nothing.
//!
//! 1. **Taken by amount of log, never by the clock.** [`Checkpoints::appended`] counts the log bytes handed to the
//!    log; once they reach the interval, [`Checkpoints::due`] says so, and nothing else does. No log, no checkpoint:
//!    an idle world writes zero checkpoint bytes, and a busy one never owes more than one interval of replay.
//! 2. **Hashed on the clock thread, written off it.** [`Checkpoints::take`] seals the tree between ticks
//!    (`replica::tree`: only nodes marked changed are hashed again, each node's hash covering its record and its
//!    children's hashes, public and private apart) and hands the new records to the writer thread.
//! 3. **One file per checkpoint** (the issue's listed alternative; the format is not trunk): `ckpt-<record>`, the
//!    root record `{1: version, 2: log record, 3: seed, 4: [[audience, state hash], ...], 5: [[hash, bytes], ...]}`
//!    then its CRC-32C, little-endian. The version is T3's (lineage, zone, epoch, sequence); the log record is how
//!    many log records the checkpoint holds; the seed is the world's random state, opaque here. Field 5 is every
//!    record the root reaches. The writer keeps them in memory, so it writes the whole tree with one sync; a sync per
//!    node file costs about 5 ms each on macOS (`F_FULLFSYNC`), seconds for the thousand nodes a busy interval moves.
//! 4. **Written whole or not at all:** a temporary name, a sync, a rename, a sync of the directory. The last two are
//!    kept, the older deleted. The log is never cut here: it is the archive (T7).
//! 5. **Restart** ([`restore`]) reads the newest checkpoint that verifies (its CRC-32C, then every record against the
//!    hash that names it), else the one before, naming each it rejected; [`replay`] then applies the log after it.
//!    It brings back what the log holds: nodes, parents, links, holds, motion, timers, transfers and time. A skill in
//!    progress is not stored; handing each active intent back to its skill is K13's.
//! 6. **A failed write is final** for this process, as the log's sync is (`log` rule 6): the writer stops and says so.
//!
//! Not here: forks (K6), handing intents back (K13), client sync by hash (R5), shipping (O3).

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use replica::effects::{Header, Part, Refusal, read_id};
use replica::encode::{Value, decode, encode, to_hex};
use replica::ids::{Scope, Version};
use replica::tree::Tree;
use replica::world_model::Audience;

use crate::log::crc32c;

#[cfg(test)]
mod tests;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

const PREFIX: &str = "ckpt-";

/// A record held for the writer: its bytes, and the hashes it names below it (a node's children, an audience's tops).
#[derive(Clone, Debug)]
struct Blob {
    bytes: Vec<u8>,
    below: Vec<Vec<u8>>,
}

/// Every record a checkpoint reaches, by hash: what the writer writes, and what a restore hands it back.
#[derive(Clone, Debug, Default)]
pub struct Blobs(HashMap<Vec<u8>, Blob>);

impl Blobs {
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn put(&mut self, hash: Vec<u8>, bytes: Vec<u8>, below_field: u64) -> R<()> {
        let below = match decode(&bytes)
            .or_else(|e| refuse("checkpoint-record", e.to_string()))?
            .value
        {
            Value::Map(mut m) => match m.remove(&below_field) {
                Some(Value::Array(a)) => a
                    .into_iter()
                    .map(|v| match v {
                        Value::Bytes(b) => Ok(b),
                        _ => refuse("checkpoint-record", "a hash is not bytes"),
                    })
                    .collect::<R<_>>()?,
                _ => Vec::new(),
            },
            _ => return refuse("checkpoint-record", "a record is not a map"),
        };
        self.0.insert(hash, Blob { bytes, below });
        Ok(())
    }
}

fn audience_value(a: Audience) -> Value {
    match a {
        Audience::Everyone => Value::Map([(1, Value::Uint(1))].into()),
        Audience::Of(id) => Value::Map([(1, Value::Uint(2)), (2, id.to_value())].into()),
    }
}

fn read_audience(v: &Value) -> R<Audience> {
    let Value::Map(m) = v else {
        return refuse("checkpoint-root-bad", "an audience is not a map");
    };
    match (m.get(&1), m.get(&2)) {
        (Some(Value::Uint(1)), None) => Ok(Audience::Everyone),
        (Some(Value::Uint(2)), Some(id)) => Ok(Audience::Of(read_id(id)?)),
        _ => refuse(
            "checkpoint-root-bad",
            "an audience is 1 everyone or 2 an id",
        ),
    }
}

fn read_version(v: &Value) -> R<Version> {
    let bad = || {
        refuse(
            "checkpoint-root-bad",
            "a version is [lineage, zone, epoch, sequence]",
        )
    };
    let Value::Array(a) = v else { return bad() };
    match a.as_slice() {
        [
            Value::Bytes(l),
            zone,
            Value::Uint(epoch),
            Value::Uint(sequence),
        ] if l.len() == 16 => Ok(Version {
            lineage: Scope(l.as_slice().try_into().expect("16 bytes")),
            zone: read_id(zone)?,
            epoch: *epoch,
            sequence: *sequence,
        }),
        _ => bad(),
    }
}

/// What a checkpoint's root record says, besides the records it carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Root {
    /// T3's version of the last change it holds (its sequence is the next change's).
    pub version: Version,
    /// How many log records it holds: replay starts at this record.
    pub record: u64,
    pub seed: Vec<u8>,
    /// Each audience's state hash, the public audience first.
    pub audiences: Vec<(Audience, Vec<u8>)>,
}

/// The tree read back, where the log resumes, what was rejected on the way, and the records for the writer.
pub struct Restored {
    pub tree: Tree,
    pub root: Root,
    /// Each newer checkpoint that did not verify, by name (`checkpoint-crc`, `checkpoint-hash`, ...), newest first.
    pub rejected: Vec<(String, Refusal)>,
    pub blobs: Blobs,
}

/// The checkpoints in `dir`, newest first.
fn listed(dir: &Path) -> R<Vec<(u64, PathBuf)>> {
    let mut out = Vec::new();
    let entries = fs::read_dir(dir)
        .or_else(|e| refuse("checkpoint-io", format!("{}: {e}", dir.display())))?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(n) = name.strip_prefix(PREFIX).filter(|n| n.len() == 20)
            && let Ok(n) = n.parse::<u64>()
        {
            out.push((n, e.path()));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out)
}

/// Reads one checkpoint file and its tree, every record checked against its hash.
fn read_one(bytes: &[u8]) -> R<(Tree, Root, Blobs)> {
    if bytes.len() < 4 {
        return refuse("checkpoint-crc", "shorter than its checksum");
    }
    let (body, sum) = bytes.split_at(bytes.len() - 4);
    if crc32c(0, body).to_le_bytes() != sum {
        return refuse("checkpoint-crc", "the checksum does not match the bytes");
    }
    let Value::Map(mut m) = decode(body)
        .or_else(|e| refuse("checkpoint-root-bad", e.to_string()))?
        .value
    else {
        return refuse("checkpoint-root-bad", "not a map");
    };
    let mut field = |k: u64| {
        m.remove(&k)
            .map_or_else(|| refuse("checkpoint-root-bad", format!("field {k}")), Ok)
    };
    let version = read_version(&field(1)?)?;
    let (Value::Uint(record), Value::Bytes(seed), Value::Array(auds), Value::Array(recs)) =
        (field(2)?, field(3)?, field(4)?, field(5)?)
    else {
        return refuse("checkpoint-root-bad", "fields 2 to 5");
    };
    let mut audiences = Vec::new();
    for a in auds {
        match a {
            Value::Array(p) if p.len() == 2 => match &p[1] {
                Value::Bytes(h) => audiences.push((read_audience(&p[0])?, h.clone())),
                _ => return refuse("checkpoint-root-bad", "a state hash is not bytes"),
            },
            _ => return refuse("checkpoint-root-bad", "not [audience, hash]"),
        }
    }
    let mut stored: HashMap<Vec<u8>, Vec<u8>> = HashMap::with_capacity(recs.len());
    for r in recs {
        match r {
            Value::Array(mut p) if p.len() == 2 => match (p.pop(), p.pop()) {
                (Some(Value::Bytes(b)), Some(Value::Bytes(h))) => {
                    stored.insert(h, b);
                }
                _ => return refuse("checkpoint-root-bad", "not [hash, bytes]"),
            },
            _ => return refuse("checkpoint-root-bad", "not [hash, bytes]"),
        }
    }
    let tree = Tree::unseal(&audiences, &mut |h| {
        stored
            .get(h)
            .cloned()
            .map_or_else(|| refuse("checkpoint-missing", to_hex(h)), Ok)
    })?;
    // Every record it holds was checked on the way down; the writer carries them on.
    let mut blobs = Blobs::default();
    let tops: HashSet<&Vec<u8>> = audiences.iter().map(|(_, h)| h).collect();
    for (h, b) in stored {
        let field = if tops.contains(&h) { 2 } else { 10 };
        blobs.put(h, b, field)?;
    }
    let root = Root {
        version,
        record,
        seed,
        audiences,
    };
    Ok((tree, root, blobs))
}

/// The newest checkpoint in `dir` that verifies, else the one before (rule 5). `None` when there is none at all.
pub fn restore(dir: &Path) -> R<Option<Restored>> {
    let mut rejected = Vec::new();
    for (_, path) in listed(dir)? {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let read = fs::read(&path)
            .or_else(|e| refuse("checkpoint-io", format!("{name}: {e}")))
            .and_then(|b| read_one(&b));
        match read {
            Ok((tree, root, blobs)) => {
                return Ok(Some(Restored {
                    tree,
                    root,
                    rejected,
                    blobs,
                }));
            }
            Err(e) => rejected.push((name, e)),
        }
    }
    match rejected.is_empty() {
        true => Ok(None),
        false => refuse(
            "checkpoint-none-good",
            rejected
                .iter()
                .map(|(n, e)| format!("{n}: {e}"))
                .collect::<Vec<_>>()
                .join("; "),
        ),
    }
}

/// Applies the log's records from `from` on, each one tick's part (T6), as a viewer applies them (the writer checked
/// them when it committed them). Returns how many were applied.
pub fn replay(tree: &mut Tree, header: &Header, records: &[Vec<u8>], from: u64) -> R<u64> {
    let from = usize::try_from(from)
        .unwrap_or(usize::MAX)
        .min(records.len());
    for bytes in &records[from..] {
        tree.apply(header, &Part::read(bytes)?)?;
    }
    Ok((records.len() - from) as u64)
}

/// What the writer has done.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Checkpoints handed to the writer.
    pub taken: u64,
    /// Checkpoints on the disk.
    pub written: u64,
    /// Bytes written to checkpoint files, and syncs asked for.
    pub bytes: u64,
    pub syncs: u64,
    /// Why the writer stopped, for good.
    pub failed: Option<Refusal>,
}

#[derive(Default)]
struct Shared {
    stats: Mutex<Stats>,
    moved: Condvar,
}

impl Shared {
    fn stats(&self) -> std::sync::MutexGuard<'_, Stats> {
        self.stats.lock().unwrap_or_else(|p| p.into_inner())
    }
}

struct Job {
    root: Root,
    /// New records: `(hash, bytes, the field naming what is below)`.
    new: Vec<(Vec<u8>, Vec<u8>, u64)>,
}

/// A world's checkpoints: the trigger, on the clock thread, and the writer thread.
pub struct Checkpoints {
    every: u64,
    since: u64,
    tx: Option<Sender<Job>>,
    writer: Option<JoinHandle<()>>,
    shared: Arc<Shared>,
}

impl Checkpoints {
    /// Checkpoints in `dir` (created if absent), one every `every` bytes of log; `blobs` are a restore's records,
    /// or empty for a new world.
    pub fn open(dir: &Path, every: u64, blobs: Blobs) -> R<Checkpoints> {
        fs::create_dir_all(dir)
            .or_else(|e| refuse("checkpoint-io", format!("{}: {e}", dir.display())))?;
        let shared = Arc::new(Shared::default());
        let (tx, rx) = channel();
        let (sh, d) = (shared.clone(), dir.to_path_buf());
        let writer = std::thread::Builder::new()
            .name("checkpoint-writer".into())
            .spawn(move || write_loop(&d, rx, blobs, &sh))
            .or_else(|e| {
                refuse(
                    "checkpoint-io",
                    format!("the writer thread did not start: {e}"),
                )
            })?;
        Ok(Checkpoints {
            every: every.max(1),
            since: 0,
            tx: Some(tx),
            writer: Some(writer),
            shared,
        })
    }

    /// Counts `bytes` handed to the log: the only thing that brings a checkpoint closer.
    pub fn appended(&mut self, bytes: u64) {
        self.since = self.since.saturating_add(bytes);
    }

    /// The log has grown by the interval since the last checkpoint.
    pub fn due(&self) -> bool {
        self.since >= self.every
    }

    /// Log bytes since the last checkpoint.
    pub fn since(&self) -> u64 {
        self.since
    }

    /// Takes a checkpoint between ticks, on the clock thread: seals the tree and hands what is new to the writer.
    /// `version` and `record` say where the log stands (every change up to it is in the tree).
    pub fn take(&mut self, tree: &mut Tree, version: Version, record: u64, seed: &[u8]) -> R<()> {
        if let Some(f) = &self.shared.stats().failed {
            return refuse("checkpoint-failed", f.to_string());
        }
        let sealed = tree.seal()?;
        let mut new = Vec::new();
        // Only marked nodes were sealed: what changed since the last checkpoint, or a node hashed again unchanged.
        for (h, bytes) in sealed.nodes {
            new.push((h.to_bytes(), bytes, 10));
        }
        let mut audiences = Vec::new();
        for (a, h, bytes) in sealed.audiences {
            let h = h.to_bytes();
            new.push((h.clone(), bytes, 2));
            audiences.push((a, h));
        }
        let root = Root {
            version,
            record,
            seed: seed.to_vec(),
            audiences,
        };
        self.shared.stats().taken += 1;
        let tx = self.tx.as_ref().expect("open until closed");
        if tx.send(Job { root, new }).is_err() {
            return refuse("checkpoint-failed", "the writer stopped");
        }
        self.since = 0;
        Ok(())
    }

    pub fn stats(&self) -> Stats {
        self.shared.stats().clone()
    }

    /// Waits until every checkpoint taken is on the disk, or the writer has failed.
    pub fn wait(&self) -> R<Stats> {
        let mut s = self.shared.stats();
        loop {
            if let Some(f) = &s.failed {
                return refuse("checkpoint-failed", f.to_string());
            }
            if s.written >= s.taken {
                return Ok(s.clone());
            }
            s = self.shared.moved.wait(s).unwrap_or_else(|p| p.into_inner());
        }
    }
}

impl Drop for Checkpoints {
    fn drop(&mut self) {
        self.tx = None;
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
    }
}

fn io(path: &Path, e: std::io::Error) -> Refusal {
    Refusal {
        name: "checkpoint-io",
        detail: format!("{}: {e}", path.display()),
    }
}

/// The writer thread: each checkpoint becomes one file, written whole or not at all (rules 3, 4 and 6).
fn write_loop(dir: &Path, rx: Receiver<Job>, mut blobs: Blobs, shared: &Shared) {
    while let Ok(job) = rx.recv() {
        let out = write_one(dir, job, &mut blobs);
        let mut s = shared.stats();
        match out {
            Ok((bytes, syncs)) => {
                s.written += 1;
                s.bytes += bytes;
                s.syncs += syncs;
            }
            Err(e) => s.failed = Some(e),
        }
        shared.moved.notify_all();
        if s.failed.is_some() {
            break;
        }
    }
}

fn write_one(dir: &Path, job: Job, blobs: &mut Blobs) -> R<(u64, u64)> {
    for (h, bytes, below) in job.new {
        blobs.put(h, bytes, below)?;
    }
    // Every record the root reaches; the rest are dropped.
    let mut reached: HashSet<Vec<u8>> = HashSet::new();
    let mut stack: Vec<Vec<u8>> = job.root.audiences.iter().map(|(_, h)| h.clone()).collect();
    while let Some(h) = stack.pop() {
        let Some(b) = blobs.0.get(&h) else {
            return refuse("checkpoint-missing", to_hex(&h));
        };
        stack.extend(b.below.iter().filter(|c| !reached.contains(*c)).cloned());
        reached.insert(h);
    }
    blobs.0.retain(|h, _| reached.contains(h));
    let mut recs: Vec<(&Vec<u8>, &Blob)> = blobs.0.iter().collect();
    recs.sort_by(|a, b| a.0.cmp(b.0));
    let r = &job.root;
    let v = Value::Map(
        [
            (1, r.version.to_value()),
            (2, Value::Uint(r.record)),
            (3, Value::Bytes(r.seed.clone())),
            (
                4,
                Value::Array(
                    r.audiences
                        .iter()
                        .map(|(a, h)| {
                            Value::Array(vec![audience_value(*a), Value::Bytes(h.clone())])
                        })
                        .collect(),
                ),
            ),
            (
                5,
                Value::Array(
                    recs.into_iter()
                        .map(|(h, b)| {
                            Value::Array(vec![
                                Value::Bytes(h.clone()),
                                Value::Bytes(b.bytes.clone()),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]
        .into(),
    );
    let mut bytes = encode(&v).or_else(|e| refuse("encoding", e.to_string()))?;
    bytes.extend_from_slice(&crc32c(0, &bytes).to_le_bytes());
    let name = format!("{PREFIX}{:020}", r.record);
    let (tmp, path) = (dir.join(format!("{name}.tmp")), dir.join(&name));
    let mut f = File::create(&tmp).map_err(|e| io(&tmp, e))?;
    f.write_all(&bytes).map_err(|e| io(&tmp, e))?;
    f.sync_data().map_err(|e| io(&tmp, e))?;
    fs::rename(&tmp, &path).map_err(|e| io(&path, e))?;
    let sync_dir = || {
        File::open(dir)
            .and_then(|d| d.sync_all())
            .map_err(|e| io(dir, e))
    };
    sync_dir()?;
    // The last two are kept.
    let mut syncs = 2;
    let old: Vec<_> = listed(dir)?.into_iter().skip(2).collect();
    for (_, p) in &old {
        fs::remove_file(p).map_err(|e| io(p, e))?;
    }
    if !old.is_empty() {
        sync_dir()?;
        syncs += 1;
    }
    Ok((bytes.len() as u64, syncs))
}
