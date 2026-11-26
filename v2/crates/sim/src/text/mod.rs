//! The text store (Engine v2 K16, #2677; contract T8 in `v2/docs/TRUNK.md`, rules in `v2/docs/audience.md`): every
//! word of free text and every upload, kept apart from the log by a minted reference, with the redaction list every
//! view consults.
//!
//! 1. **A reference is minted** from the store's own [`Minter`] (T3: a scope and a counter), never made from the
//!    words: a hash of a short sentence is guessed, and outlives a removal as a fingerprint (T8 rule 7).
//! 2. **One store per world, in two files behind K4's [`Storage`]:** `text`, the words, and `removed`, the redaction
//!    list. A record is `[length, CRC-32C of length and body, body]`, the body `kind, reference, audience, author,
//!    payload`: the audience as resolved when written (T8 rule 1, so a later member is never shown old words), the
//!    author as a principal id (never an account id), and the words. Each record checks by itself, unchained, so an
//!    erasure can rewrite one record and leave the rest as they were. An upload is one file, `uploads/<reference>`,
//!    synced and renamed into place before its record is queued; the record holds its length (G6 names assets by
//!    content hash; not here).
//! 3. **A reference is returned only once its record is on the disk.** Writers queue records; one writer thread
//!    appends what has queued and syncs once (K4's group commit), then releases every writer whose record that sync
//!    covered. A failed sync is final: nothing more is written or returned (K4 rule 6). [`Store::write_queued`]
//!    returns at once with the record's number; its caller waits ([`Store::wait`]) before it hands the reference on.
//! 4. **Reading is one function, [`Store::read`]:** a reference and the ids the reader is in (its own principal and
//!    each audience node it is a member of, a line's included: T8 rules 1 and 7) give the words, or a refusal by
//!    name: `text-unknown`, `not-entitled`, `removed`. No view opens the files; a view is built with
//!    [`Store::redactions`] and delivered through `read`.
//! 5. **The redaction list is append-only and never holds words:** each entry is a reference, who removed it, when,
//!    and a grade. **Hidden** can be undone ([`Store::restore`]); **erased** cannot, and its bytes are deleted. The
//!    entry is synced before anything else happens, so the list is the truth throughout.
//! 6. **Erasing overwrites in place, then syncs** (not mark-and-compact): the record's words become zeros, then its
//!    checksum is written again (an upload's file is deleted). A power cut between leaves a record that does not
//!    check: on opening, a record whose reference is erased is accepted whatever its checksum, and the overwrite is
//!    finished. The log of effects holds only references, so no byte of it changes (T8 rule 9).
//! 7. **Opening reads both files forward.** A record that does not check, with no record after it that checks and
//!    begins a batch, is a torn tail: cut back and synced (bytes after the last sync, never a returned reference). A
//!    record after the first of the writer's batch carries [`CONT`] in its length, as the log's do (K4 rules 4 and
//!    10): the `text` file is written into room made ahead of its end, so a batch whose sync never returned may have
//!    reached the disk in any order of its pages. One that does not check with a batch's first record after it is
//!    `text-corrupt`, refused and never trimmed.
//!
//! Not here: a fork opening its parent's store (T8 rule 10, K6), checking and naming uploads (G6), who may remove
//! whose words and purging caches (W7), the view tier (R3), copies off the machine (O20).

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;

use replica::effects::Refusal;
use replica::ids::{Id, Minter, Scope};
use replica::views::Redactions;
use replica::world_model::Audience;

use crate::log::{CONT, FileStore, Mem, Storage, crc32c};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The largest sentence or upload the store takes, bytes.
pub const MAX_TEXT: usize = 1 << 20;
/// Room kept ahead of the `text` file's end (K4 rule 10); the redaction list keeps none (it is not synced per tick).
pub const TEXT_RESERVE: u64 = 4 << 20;

const KIND_TEXT: u8 = 1;
const KIND_UPLOAD: u8 = 2;
const KIND_REMOVAL: u8 = 3;
/// `[length u32, crc u32]` before each body.
const FRAME: usize = 8;
const ID_LEN: usize = 24;
/// kind, reference, audience (a tag and an id), author.
const META: usize = 1 + ID_LEN + 1 + ID_LEN + ID_LEN;
/// kind, reference, by, when, grade.
const REMOVAL: usize = 1 + 2 * ID_LEN + 8 + 1;

// --- Grades and removals ------------------------------------------------------------------------------------------

/// How words are removed (rule 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grade {
    /// A hidden reference shown again.
    Restored = 0,
    /// Hidden from every view; the bytes stay and it can be undone.
    Hidden = 1,
    /// Hidden for good, and the stored bytes deleted.
    Erased = 2,
}

impl Grade {
    fn of(b: u8) -> Option<Grade> {
        [Grade::Restored, Grade::Hidden, Grade::Erased]
            .into_iter()
            .find(|g| *g as u8 == b)
    }
}

/// One entry of the redaction list: a reference, who removed it (a principal id), when (µs of real time, a recorded
/// input) and how. Never the words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Removal {
    pub reference: Id,
    pub by: Id,
    pub when_us: u64,
    pub grade: Grade,
}

// --- Bytes ----------------------------------------------------------------------------------------------------------

fn put_id(out: &mut Vec<u8>, id: Id) {
    out.extend_from_slice(&id.scope().0);
    out.extend_from_slice(&id.counter().to_le_bytes());
}

fn get_id(b: &[u8]) -> Option<Id> {
    let scope: [u8; 16] = b.get(..16)?.try_into().ok()?;
    let counter = u64::from_le_bytes(b.get(16..ID_LEN)?.try_into().ok()?);
    Id::new(Scope(scope), counter)
}

/// Frames `body`, marked [`CONT`] when it is not the first record of the writer's batch (rule 7).
fn frame(out: &mut Vec<u8>, body: &[u8], cont: bool) {
    let len = (body.len() as u32 | if cont { CONT } else { 0 }).to_le_bytes();
    let crc = crc32c(crc32c(0, &len), body);
    out.extend_from_slice(&len);
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(body);
}

fn meta(kind: u8, reference: Id, audience: Audience, author: Id) -> Vec<u8> {
    let mut b = Vec::with_capacity(META);
    b.push(kind);
    put_id(&mut b, reference);
    match audience {
        Audience::Everyone => {
            b.push(0);
            b.extend_from_slice(&[0; ID_LEN]);
        }
        Audience::Of(a) => {
            b.push(1);
            put_id(&mut b, a);
        }
    }
    put_id(&mut b, author);
    b
}

/// A text record's body read back: kind, reference, audience, author.
fn read_meta(b: &[u8]) -> Option<(u8, Id, Audience, Id)> {
    if b.len() < META || ![KIND_TEXT, KIND_UPLOAD].contains(&b[0]) {
        return None;
    }
    let audience = match b[1 + ID_LEN] {
        0 => Audience::Everyone,
        _ => Audience::Of(get_id(&b[2 + ID_LEN..])?),
    };
    Some((
        b[0],
        get_id(&b[1..])?,
        audience,
        get_id(&b[2 + 2 * ID_LEN..])?,
    ))
}

fn read_removal(b: &[u8]) -> Option<Removal> {
    if b.len() != REMOVAL || b[0] != KIND_REMOVAL {
        return None;
    }
    Some(Removal {
        reference: get_id(&b[1..])?,
        by: get_id(&b[1 + ID_LEN..])?,
        when_us: u64::from_le_bytes(b[1 + 2 * ID_LEN..][..8].try_into().ok()?),
        grade: Grade::of(b[REMOVAL - 1])?,
    })
}

/// One record read back: where it starts, and its body.
struct Raw<'a> {
    at: usize,
    body: &'a [u8],
}

/// The record at `at` if it checks by itself: its body, and whether it carries [`CONT`].
fn checks(b: &[u8], at: usize) -> Option<(&[u8], bool)> {
    let head = b.get(at..at + FRAME)?;
    let word = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
    let crc = u32::from_le_bytes([head[4], head[5], head[6], head[7]]);
    let len = (word & !CONT) as usize;
    if len == 0 || len > META + MAX_TEXT {
        return None;
    }
    let body = b.get(at + FRAME..at + FRAME + len)?;
    (crc32c(crc32c(0, &head[..4]), body) == crc).then_some((body, word & CONT != 0))
}

/// Reads records forward (rule 7). A record that does not check is kept when `accept` takes its body (an erasure cut
/// short); otherwise, with no record after it that checks and begins a batch, it is a torn tail (`Some(at)`: cut back
/// to `at`), and with one, `text-corrupt`.
fn scan<'a>(
    b: &'a [u8],
    name: &str,
    accept: impl Fn(&[u8]) -> bool,
) -> R<(Vec<Raw<'a>>, Option<usize>)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < b.len() {
        let Some(head) = b.get(at..at + FRAME) else {
            return Ok((out, Some(at)));
        };
        let len = (u32::from_le_bytes([head[0], head[1], head[2], head[3]]) & !CONT) as usize;
        let body = b.get(at + FRAME..at + FRAME + len);
        let kept = match body {
            Some(body) if checks(b, at).is_some() || accept(body) => Some(body),
            _ => None,
        };
        let Some(body) = kept else {
            // None starts after the last byte that is not 0 (a length is never 0): the room's zeros are not read.
            let last = b.iter().rposition(|&x| x != 0).map_or(at, |l| l + 1);
            if let Some(q) = (at + 1..last).find(|&q| checks(b, q).is_some_and(|c| !c.1)) {
                return refuse(
                    "text-corrupt",
                    format!(
                        "{name}: the record at byte {at} does not check and a record at byte {q} follows"
                    ),
                );
            }
            return Ok((out, Some(at)));
        };
        out.push(Raw { at, body });
        at += FRAME + len;
    }
    Ok((out, None))
}

// --- Where the bytes live -----------------------------------------------------------------------------------------

/// The storage of one of the store's files: on the machine's disk, or in memory with faults (K4's [`Mem`]).
pub enum Disk {
    File(FileStore),
    Mem(Mem),
}

impl Storage for Disk {
    fn append(&mut self, bytes: &[u8]) -> R<()> {
        match self {
            Disk::File(f) => f.append(bytes),
            Disk::Mem(m) => m.append(bytes),
        }
    }
    fn sync(&mut self) -> R<()> {
        match self {
            Disk::File(f) => f.sync(),
            Disk::Mem(m) => m.sync(),
        }
    }
    fn read(&mut self) -> R<Vec<u8>> {
        match self {
            Disk::File(f) => f.read(),
            Disk::Mem(m) => m.read(),
        }
    }
    fn truncate(&mut self, len: u64) -> R<()> {
        match self {
            Disk::File(f) => f.truncate(len),
            Disk::Mem(m) => m.truncate(len),
        }
    }
    fn reserve(&mut self) -> R<()> {
        match self {
            Disk::File(f) => f.reserve(),
            Disk::Mem(m) => m.reserve(),
        }
    }
}

/// A second way into the `text` file, beside the writer's: reads at a place, and erasure's overwrite.
enum Place {
    Dir(PathBuf, File),
    Mem(Mem),
}

fn io(e: std::io::Error) -> Refusal {
    Refusal {
        name: "text-io",
        detail: e.to_string(),
    }
}

impl Place {
    fn read_at(&self, at: u64, len: usize) -> R<Vec<u8>> {
        match self {
            Place::Dir(_, f) => {
                let mut out = vec![0; len];
                f.read_exact_at(&mut out, at).map_err(io)?;
                Ok(out)
            }
            Place::Mem(m) => {
                let d = lock(&m.0);
                let from = at as usize;
                match d.bytes.get(from..from + len) {
                    Some(b) if !d.off => Ok(b.to_vec()),
                    _ => refuse("text-io", "past the end, or no power"),
                }
            }
        }
    }

    /// Writes `bytes` over the file at `at`, and syncs.
    fn overwrite(&self, at: u64, bytes: &[u8]) -> R<()> {
        match self {
            Place::Dir(_, f) => {
                f.write_all_at(bytes, at).map_err(io)?;
                f.sync_data().map_err(io)
            }
            Place::Mem(m) => {
                let mut d = lock(&m.0);
                let from = at as usize;
                let off = d.off;
                match d.bytes.get_mut(from..from + bytes.len()) {
                    Some(b) if !off => {
                        b.copy_from_slice(bytes);
                        Ok(())
                    }
                    _ => refuse("text-io", "past the end, or no power"),
                }
            }
        }
    }

    fn uploads(&self) -> R<PathBuf> {
        match self {
            Place::Dir(d, _) => Ok(d.join("uploads")),
            Place::Mem(_) => refuse("uploads-need-a-folder", "an upload is a file of its own"),
        }
    }
}

fn sync_dir(dir: &Path) -> R<()> {
    File::open(dir).and_then(|d| d.sync_all()).map_err(io)
}

fn upload_name(r: Id) -> String {
    let hex: String = r.scope().0.iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex}-{}", r.counter())
}

// --- The writer (rule 3) ------------------------------------------------------------------------------------------

#[derive(Default)]
struct Queue {
    /// Framed records not yet handed to the writer.
    buf: Vec<u8>,
    /// Records queued so far, and how many of them are on the disk.
    queued: u64,
    durable: u64,
    /// The byte where the next queued record starts.
    end: u64,
    /// Syncs that returned.
    syncs: u64,
    failed: Option<Refusal>,
    closing: bool,
}

#[derive(Default)]
struct Shared {
    q: Mutex<Queue>,
    work: Condvar,
    done: Condvar,
}

fn write_loop(mut disk: Disk, shared: Arc<Shared>) {
    let mut buf = Vec::new();
    loop {
        let n = {
            let mut q = lock(&shared.q);
            while q.buf.is_empty() && !q.closing {
                q = shared.work.wait(q).unwrap_or_else(|p| p.into_inner());
            }
            if q.buf.is_empty() {
                return;
            }
            buf.clear();
            std::mem::swap(&mut buf, &mut q.buf);
            q.queued
        };
        let out = disk.append(&buf).and_then(|_| disk.sync());
        let mut q = lock(&shared.q);
        match out {
            Ok(()) => {
                q.durable = n;
                q.syncs += 1;
            }
            // Never retried (K4 rule 6).
            Err(e) => q.failed = Some(e),
        }
        shared.done.notify_all();
        if q.failed.is_some() {
            return;
        }
        drop(q);
        // Room for the next batches (K4 rule 10), made after the writers were released.
        if let Err(e) = disk.reserve() {
            lock(&shared.q).failed = Some(e);
            shared.done.notify_all();
            return;
        }
    }
}

// --- The store ----------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Entry {
    kind: u8,
    audience: Audience,
    /// The record's first byte, its body's length, and its number: it is on the disk once `durable` reaches `n`.
    at: u64,
    len: u32,
    n: u64,
}

struct Index {
    minter: Minter,
    entries: BTreeMap<Id, Entry>,
    /// The latest removal of each reference not restored.
    removed: BTreeMap<Id, Removal>,
    /// Every entry of the redaction list, in order.
    history: Vec<Removal>,
    /// The `removed` file, written and synced under this lock.
    list: Disk,
}

/// A world's text store, open: recovered, its torn tails cut, its writer running.
pub struct Store {
    place: Place,
    index: Mutex<Index>,
    shared: Arc<Shared>,
    writer: Option<JoinHandle<()>>,
}

impl Store {
    /// Opens or creates the store in folder `dir` (`text`, `removed`, `uploads/`). `minter` mints its references; a
    /// reopened store goes on after the highest counter of that scope it holds.
    pub fn open_dir(dir: &Path, minter: Minter) -> R<Store> {
        fs::create_dir_all(dir.join("uploads")).map_err(io)?;
        let text = FileStore::open_reserving(&dir.join("text"), TEXT_RESERVE)?;
        let list = FileStore::open_reserving(&dir.join("removed"), 0)?;
        let rw = OpenOptions::new()
            .read(true)
            .write(true)
            .open(dir.join("text"))
            .map_err(io)?;
        Store::open(
            Disk::File(text),
            Disk::File(list),
            Place::Dir(dir.to_path_buf(), rw),
            minter,
        )
    }

    /// Opens the store on two disks in memory (K4's [`Mem`]), for the fault simulation. It takes no uploads.
    pub fn open_mem(text: Mem, list: Mem, minter: Minter) -> R<Store> {
        Store::open(
            Disk::Mem(text.clone()),
            Disk::Mem(list),
            Place::Mem(text),
            minter,
        )
    }

    fn open(mut text: Disk, mut list: Disk, place: Place, mut minter: Minter) -> R<Store> {
        // The redaction list first: erasures cut short are known by it (rule 6).
        let bytes = list.read()?;
        let (raws, torn) = scan(&bytes, "removed", |_| false)?;
        let (mut removed, mut history) = (BTreeMap::new(), Vec::new());
        for r in &raws {
            let Some(e) = read_removal(r.body) else {
                return refuse("text-corrupt", format!("removed: record at byte {}", r.at));
            };
            match e.grade {
                Grade::Restored => removed.remove(&e.reference),
                _ => removed.insert(e.reference, e),
            };
            history.push(e);
        }
        if let Some(at) = torn {
            list.truncate(at as u64)?;
            list.sync()?;
        }
        let erased = |b: &[u8]| {
            read_meta(b).is_some_and(|(_, r, _, _)| {
                removed
                    .get(&r)
                    .is_some_and(|e: &Removal| e.grade == Grade::Erased)
            })
        };

        let bytes = text.read()?;
        let (raws, torn) = scan(&bytes, "text", erased)?;
        let mut entries = BTreeMap::new();
        let mut finish = Vec::new();
        for (i, r) in raws.iter().enumerate() {
            let Some((kind, id, audience, _author)) = read_meta(r.body) else {
                return refuse("text-corrupt", format!("text: record at byte {}", r.at));
            };
            if erased(r.body) && r.body[META..].iter().any(|x| *x != 0) {
                finish.push(id);
            }
            if id.scope() == minter.scope() {
                minter.past(id.counter());
            }
            let e = Entry {
                kind,
                audience,
                at: r.at as u64,
                len: r.body.len() as u32,
                n: i as u64 + 1,
            };
            entries.insert(id, e);
        }
        let end = match torn {
            Some(at) => {
                text.truncate(at as u64)?;
                text.sync()?;
                at
            }
            None => bytes.len(),
        };
        // Room for the first batches, before any reference is returned (K4 rule 10).
        text.reserve()?;
        let n = raws.len() as u64;
        let shared = Arc::new(Shared {
            q: Mutex::new(Queue {
                queued: n,
                durable: n,
                end: end as u64,
                ..Queue::default()
            }),
            ..Shared::default()
        });
        let sh = shared.clone();
        let writer = std::thread::Builder::new()
            .name("text-writer".into())
            .spawn(move || write_loop(text, sh))
            .map_err(io)?;
        let store = Store {
            place,
            index: Mutex::new(Index {
                minter,
                entries,
                removed,
                history,
                list,
            }),
            shared,
            writer: Some(writer),
        };
        for id in finish {
            let e = lock(&store.index).entries[&id];
            store.wipe(id, e)?;
        }
        Ok(store)
    }

    fn mint(&self) -> R<Id> {
        lock(&self.index)
            .minter
            .mint()
            .or_else(|e| refuse("id-counter-exhausted", e.to_string()))
    }

    /// Queues one record under `reference`, then waits until it is on the disk (rule 3).
    fn put(
        &self,
        reference: Id,
        kind: u8,
        audience: Audience,
        author: Id,
        payload: &[u8],
    ) -> R<Id> {
        let n = self.queue(reference, kind, audience, author, payload)?;
        self.wait(n).map(|_| reference)
    }

    /// Queues one record under `reference` and returns its number, without waiting for the disk.
    fn queue(
        &self,
        reference: Id,
        kind: u8,
        audience: Audience,
        author: Id,
        payload: &[u8],
    ) -> R<u64> {
        if payload.len() > MAX_TEXT {
            return refuse(
                "text-size",
                format!("{} bytes (at most {MAX_TEXT})", payload.len()),
            );
        }
        let mut body = meta(kind, reference, audience, author);
        body.extend_from_slice(payload);
        let n = {
            let mut ix = lock(&self.index);
            let mut q = lock(&self.shared.q);
            if let Some(f) = &q.failed {
                return refuse("text-failed", f.to_string());
            }
            let at = q.end;
            // The writer takes the whole queue as one batch: a record queued behind another is not its first.
            let cont = !q.buf.is_empty();
            frame(&mut q.buf, &body, cont);
            q.end += (FRAME + body.len()) as u64;
            q.queued += 1;
            let n = q.queued;
            let len = body.len() as u32;
            ix.entries.insert(
                reference,
                Entry {
                    kind,
                    audience,
                    at,
                    len,
                    n,
                },
            );
            n
        };
        self.shared.work.notify_one();
        Ok(n)
    }

    /// Waits until records `..=n` are on the disk, or the writer has failed (`text-failed`).
    pub fn wait(&self, n: u64) -> R<()> {
        let mut q = lock(&self.shared.q);
        while q.durable < n {
            if let Some(f) = &q.failed {
                return refuse("text-failed", f.to_string());
            }
            q = self.shared.done.wait(q).unwrap_or_else(|p| p.into_inner());
        }
        Ok(())
    }

    /// How many records were queued, and how many of them are on the disk: [`Store::wait`] on the first waits for all.
    pub fn marks(&self) -> (u64, u64) {
        let q = lock(&self.shared.q);
        (q.queued, q.durable)
    }

    /// As [`Store::write`], without waiting for the disk (rule 3 then binds its caller): the reference, and the record's
    /// number to [`Store::wait`] on before the reference is handed on. The words read as `text-unknown` until then.
    pub fn write_queued(&self, words: &[u8], audience: Audience, author: Id) -> R<(Id, u64)> {
        let r = self.mint()?;
        self.queue(r, KIND_TEXT, audience, author, words)
            .map(|n| (r, n))
    }

    /// Keeps `words` for `audience` (as resolved when written, T8 rule 1), by `author` (a principal id). Returns
    /// their reference once they are on the disk.
    pub fn write(&self, words: &[u8], audience: Audience, author: Id) -> R<Id> {
        let r = self.mint()?;
        self.put(r, KIND_TEXT, audience, author, words)
    }

    /// Keeps an upload as a file of its own, named by a fresh reference, synced and renamed into place before its
    /// record is queued; returns the reference once the record is on the disk too.
    pub fn upload(&self, bytes: &[u8], audience: Audience, author: Id) -> R<Id> {
        let dir = self.place.uploads()?;
        let r = self.mint()?;
        let name = upload_name(r);
        let tmp = dir.join(format!("{name}.incoming"));
        let mut f = File::create(&tmp).map_err(io)?;
        f.write_all(bytes).and_then(|_| f.sync_data()).map_err(io)?;
        fs::rename(&tmp, dir.join(name)).map_err(io)?;
        sync_dir(&dir)?;
        let len = (bytes.len() as u64).to_le_bytes();
        self.put(r, KIND_UPLOAD, audience, author, &len)
    }

    /// The one read (rule 4): the words under `reference` for a reader in the ids `reader` (its own principal and the
    /// audience nodes it is a member of). Refused as `text-unknown`, `not-entitled` or `removed`.
    pub fn read(&self, reference: Id, reader: &[Id]) -> R<Vec<u8>> {
        let ix = lock(&self.index);
        let Some(e) = ix.entries.get(&reference).copied() else {
            return refuse("text-unknown", "no words under this reference");
        };
        let entitled = match e.audience {
            Audience::Everyone => true,
            Audience::Of(a) => reader.contains(&a),
        };
        if !entitled {
            return refuse("not-entitled", "the reader is not in the words' audience");
        }
        if let Some(r) = ix.removed.get(&reference) {
            let how = if r.grade == Grade::Erased {
                "erased"
            } else {
                "hidden"
            };
            return refuse("removed", how);
        }
        drop(ix);
        if lock(&self.shared.q).durable < e.n {
            return refuse("text-unknown", "not on the disk yet");
        }
        match e.kind {
            KIND_UPLOAD => fs::read(self.place.uploads()?.join(upload_name(reference))).map_err(io),
            _ => self
                .place
                .read_at(e.at + (FRAME + META) as u64, e.len as usize - META),
        }
    }

    /// Removes the words under `reference` (rule 5): the redaction list's entry is synced first; an erasure then
    /// deletes the bytes (rule 6). Refused as `text-unknown`, `erased` (erased words stay erased) or `not-removed`.
    pub fn remove(&self, reference: Id, by: Id, when_us: u64, grade: Grade) -> R<()> {
        let mut ix = lock(&self.index);
        let Some(e) = ix.entries.get(&reference).copied() else {
            return refuse("text-unknown", "no words under this reference");
        };
        if lock(&self.shared.q).durable < e.n {
            return refuse("text-unknown", "not on the disk yet");
        }
        match (ix.removed.get(&reference).map(|r| r.grade), grade) {
            (Some(Grade::Erased), _) => return refuse("erased", "erased words stay erased"),
            (None, Grade::Restored) => return refuse("not-removed", "nothing to restore"),
            _ => {}
        }
        let mut body = vec![KIND_REMOVAL];
        put_id(&mut body, reference);
        put_id(&mut body, by);
        body.extend_from_slice(&when_us.to_le_bytes());
        body.push(grade as u8);
        let mut rec = Vec::new();
        frame(&mut rec, &body, false);
        ix.list.append(&rec).and_then(|_| ix.list.sync())?;
        let r = Removal {
            reference,
            by,
            when_us,
            grade,
        };
        match grade {
            Grade::Restored => ix.removed.remove(&reference),
            _ => ix.removed.insert(reference, r),
        };
        ix.history.push(r);
        drop(ix);
        if grade == Grade::Erased {
            self.wipe(reference, e)?;
        }
        Ok(())
    }

    /// Shows hidden words again (rule 5); erased words are refused as `erased`.
    pub fn restore(&self, reference: Id, by: Id, when_us: u64) -> R<()> {
        self.remove(reference, by, when_us, Grade::Restored)
    }

    /// Deletes an erased reference's bytes (rule 6): a sentence's words become zeros, then its checksum is written
    /// again, each synced; an upload's file goes.
    fn wipe(&self, reference: Id, e: Entry) -> R<()> {
        if e.kind == KIND_UPLOAD {
            let dir = self.place.uploads()?;
            return match fs::remove_file(dir.join(upload_name(reference))) {
                Ok(()) => sync_dir(&dir),
                Err(x) if x.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(x) => Err(io(x)),
            };
        }
        let head = self.place.read_at(e.at, FRAME)?;
        let cont = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) & CONT != 0;
        let mut body = self.place.read_at(e.at + FRAME as u64, META)?;
        body.resize(e.len as usize, 0);
        let mut rec = Vec::new();
        frame(&mut rec, &body, cont);
        self.place
            .overwrite(e.at + (FRAME + META) as u64, &rec[FRAME + META..])?;
        self.place.overwrite(e.at, &rec[..FRAME])
    }

    /// The redaction list every view is built with (T7; T8 rule 8): the references hidden or erased now.
    pub fn redactions(&self) -> Redactions {
        Redactions::new(lock(&self.index).removed.keys().copied())
    }

    /// Every entry of the redaction list, in the order written.
    pub fn removals(&self) -> Vec<Removal> {
        lock(&self.index).history.clone()
    }

    /// Syncs the writer has made, for the bench's table.
    pub fn syncs(&self) -> u64 {
        lock(&self.shared.q).syncs
    }

    /// Stops the writer once it has written what was queued.
    pub fn close(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        lock(&self.shared.q).closing = true;
        self.shared.work.notify_all();
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        self.stop();
    }
}
