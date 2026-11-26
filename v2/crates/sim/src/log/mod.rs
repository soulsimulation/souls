//! The log of effects, the one commit point (Engine v2 K4, #2668; contracts T7 and T11 in `v2/docs/TRUNK.md`).
//! Every change to a world is appended here, checksummed, and is on the disk before anyone is told it happened.
//!
//! 1. **Storage is one small interface** ([`Storage`]: append, sync, read, cut back): a file ([`FileStore`]) and a
//!    disk in memory with faults ([`Mem`]) that the fault simulation (O5) and the text store (K16) reuse.
//! 2. **A log is a header, then records.** The header holds T11's epoch and its own CRC-32C, the salt. A record is
//!    `[length, previous checksum, checksum, T6 bytes]`, its checksum CRC-32C over the salt, the length, the previous
//!    record's checksum and the bytes, so a record checks by itself and its place in the chain checks too. A record
//!    never holds free text: words are held by their reference (T8, K16).
//! 3. **One append and one sync per tick, on the writer thread.** The clock thread hands over a tick's bytes and goes
//!    on; the writer appends what has queued and syncs once. The **durable mark** (records on the disk) moves only
//!    after a sync returns, and it alone releases acknowledgements: an act is acknowledged once its record is under
//!    it (T11 rule 1). A second mark, **off the machine**, is kept for the copy O3 ships.
//! 4. **Recovery reads forward.** A record that does not check with nothing valid after it but records of its own
//!    batch is a torn tail: it is reported ([`Torn`]), cut back and synced. A record after the first of its writer's
//!    batch carries [`CONT`], so a batch whose sync never returned, and whose later pages reached the disk before its
//!    earlier ones (writes into room already made, rule 10, are not ordered by the filesystem), is a torn tail too.
//!    One that does not check with the first record of a batch after it, a valid record out of the chain, or a
//!    damaged header with bytes after it, is corruption: refused by name (`log-corrupt`, `log-header-bad`) and never
//!    trimmed (SQLite, TigerBeetle and Redis draw the same line; `v2/docs/tranche/K-core.md`, facts 1, 3 and 4).
//!    Damage inside the last batch reads as a tear, as damage to the last record always did.
//! 5. **One writer per log, by an exclusive lock** on the file, and by its epoch: opening a log with a lower epoch
//!    than its header's is `epoch-stale` (T11 rule 8); a higher epoch starts a new log (`epoch-other`).
//! 6. **A failed sync is final.** After it nothing more is acknowledged from that file, the writer stops, and the
//!    sync is never retried on it: Linux marks the pages clean after a failed sync and reports it once, so a retry
//!    "succeeds" with the data gone (<https://wiki.postgresql.org/wiki/Fsync_Errors>).
//! 7. **Sync rules:** `fdatasync` covers a file's changed size; a new file also needs its directory synced; on
//!    macOS only `F_FULLFSYNC` reaches the disk, so disk numbers are measured on Linux (K-core.md, fact 8).
//! 8. **A restart reads from its checkpoint** (K4b, #3136): the writer keeps the durable place ([`At`]: record,
//!    byte, chain checksum), a checkpoint stores it, and [`Log::open_at`] reads the header and the bytes from there
//!    on, so opening takes the same time however long the log is. What follows is judged as in rule 4; the bytes
//!    before are the checkpoint's, not read. A place whose record does not continue the chain from its checksum
//!    means the two do not belong together, and the whole log is read instead.
//! 9. **Compaction** (#3837, [`compact`]): the bytes before a place every reader has passed are given back to the
//!    disk, the offsets after it unchanged. A compacted log is opened from its cut (or a later place), never from byte
//!    0; a place before the cut is passed over for the cut, and a cut that does not check is `log-cut-bad`.
//! 10. **A tick's sync waits for no other process** (#4973). A file's sync that changes its size or blocks needs a
//!    filesystem journal commit, and on ext4 (`data=ordered`) a commit first writes every other process's pending
//!    data: a build or a backup on the same disk held every answer for seconds. So [`FileStore`] keeps room ahead of
//!    the log's end, zeros written and synced ([`Storage::reserve`], [`RESERVE`]), and appends write into it: a sync
//!    writes the tick's data and flushes the drive, nothing more. The writer makes room after a sync, once less than
//!    half is left; that sync, one in each `RESERVE / 2` of log, still commits. Readers stop at the end (the zeros
//!    are no records: rule 4); a clean close cuts them off. What is durable, and when an act is answered, is
//!    unchanged: after its record's sync returns.
//!
//! The kill and power-cut runner and the sync table are `v2/tools/log-crash`. Not here: shipping off the machine
//! (O3), views (R3), packing (V3), a full disk (O10), checkpoints (K5).

pub mod compact;
mod record;
mod storage;

pub use record::{
    At, CONT, HEAD_LEN, HEADER_LEN, Header, MAX_RECORD, Recovered, Torn, crc32c, encode_in_batch,
    encode_record, recover, recover_from,
};
pub use storage::{FileStore, Mem, MemDisk, RESERVE, Storage};

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use replica::effects::Refusal;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

#[derive(Debug, Default)]
struct Marks {
    /// Records on the disk (records `..durable`).
    durable: u64,
    /// Where they end (rule 8).
    at: At,
    /// Records off the machine (O3 moves it).
    off_machine: u64,
    /// The failure that stopped the writer, for good.
    failed: Option<Refusal>,
    /// The last sync: the durable mark before it, and when it returned (R3's view tier times frames from it).
    synced: Option<(u64, Instant)>,
    /// A compacted copy for the writer to finish (rule 9), and how the last one ended.
    compact: Option<compact::Prepared>,
    compacted: Option<Result<compact::Cut, Refusal>>,
}

#[derive(Debug, Default)]
struct Shared {
    marks: Mutex<Marks>,
    moved: Condvar,
}

impl Shared {
    fn marks(&self) -> std::sync::MutexGuard<'_, Marks> {
        self.marks.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn wait(&self, n: u64) -> R<Option<(u64, Instant)>> {
        let mut m = self.marks();
        loop {
            if m.durable >= n {
                return Ok(m.synced);
            }
            if let Some(f) = &m.failed {
                return refuse("log-failed", f.to_string());
            }
            m = self.moved.wait(m).unwrap_or_else(|p| p.into_inner());
        }
    }
}

/// The durable mark, for a thread other than the clock thread (the view tier, R3 #2697): it reads a tick only once
/// the tick is on the disk.
#[derive(Clone, Debug)]
pub struct Durable(Arc<Shared>);

impl Durable {
    /// Waits until records `..n` are on the disk (or `log-failed`). Returns the last sync: the mark before it and when
    /// it returned; a record below that mark was made durable by an earlier sync.
    pub fn wait(&self, n: u64) -> R<Option<(u64, Instant)>> {
        self.0.wait(n)
    }

    /// Where the durable records end now (rule 8), without waiting: a checkpoint taken on another thread keeps it
    /// (K18c, #3176).
    pub fn at(&self) -> At {
        self.0.marks().at
    }

    /// Hands a compacted copy ([`compact::prepare`]) to the writer, which finishes it after its next sync (rule 9).
    /// A copy handed earlier and not yet finished is replaced.
    pub fn compact(&self, p: compact::Prepared) {
        self.0.marks().compact = Some(p);
    }

    /// How the last compaction the writer finished ended, taken: its cut, or why it did not happen.
    pub fn compacted(&self) -> Option<Result<compact::Cut, Refusal>> {
        self.0.marks().compacted.take()
    }
}

/// An open log: recovered, its torn tail cut, and its writer thread running.
pub struct Log<S: Storage + 'static> {
    tx: Option<Sender<Vec<u8>>>,
    shared: Arc<Shared>,
    writer: Option<JoinHandle<S>>,
    next: u64,
}

impl<S: Storage + 'static> Log<S> {
    /// Recovers the log in `storage` (rule 4) and starts its writer. An empty log gets a header for `epoch`.
    /// Returns what recovery found; its records are numbered from 0 and new ones follow them.
    pub fn open(storage: S, epoch: u64) -> R<(Log<S>, Recovered)> {
        Log::open_at(storage, epoch, None)
    }

    /// As [`Log::open`], reading from `at` (a checkpoint's place) when it is given and belongs to this log (rule 8):
    /// what it returns are the records from `at.record` on (`Recovered::first`), and new ones follow them.
    pub fn open_at(mut storage: S, epoch: u64, at: Option<At>) -> R<(Log<S>, Recovered)> {
        // A compacted log (rule 9) is read from its cut, or from a later place; never from byte 0.
        let cut = storage.cut()?;
        let mut from = None;
        for a in [at, cut].into_iter().flatten() {
            if cut.is_some_and(|c| a.offset < c.offset) {
                continue;
            }
            let head = storage.read_from(0, HEADER_LEN)?;
            let tail = storage.read_from(a.offset, usize::MAX)?;
            from = recover_from(&head, &tail, a)?;
            if from.is_some() {
                break;
            }
        }
        if from.is_none()
            && let Some(c) = cut
        {
            return refuse(
                "log-cut-bad",
                format!(
                    "the log's cut at record {} does not continue its chain",
                    c.record
                ),
            );
        }
        let found = match from {
            Some(f) => f,
            None => recover(&storage.read()?)?,
        };
        let header = match found.header {
            Some(h) if h.epoch > epoch => {
                return refuse(
                    "epoch-stale",
                    format!("epoch {epoch} after the log's {}", h.epoch),
                );
            }
            Some(h) if h.epoch < epoch => {
                return refuse(
                    "epoch-other",
                    format!(
                        "epoch {epoch} on a log of epoch {}: a new epoch starts a new log",
                        h.epoch
                    ),
                );
            }
            Some(h) => h,
            None => Header::new(epoch),
        };
        if let Some(t) = found.torn {
            storage.truncate(t.at as u64)?;
        }
        if found.header.is_none() {
            storage.append(&header.to_bytes())?;
        }
        if found.torn.is_some() || found.header.is_none() {
            storage.sync()?;
        }
        // Room for the first ticks, before any is answered (rule 10).
        storage.reserve()?;
        let shared = Arc::new(Shared::default());
        let next = found.first + found.records.len() as u64;
        // A new log's first record follows the header: its previous checksum is the salt.
        let durable = match found.header {
            Some(_) => At {
                record: next,
                offset: found.end as u64,
                crc: found.last_crc,
            },
            None => At {
                record: 0,
                offset: HEADER_LEN as u64,
                crc: header.salt,
            },
        };
        {
            let mut m = shared.marks();
            m.durable = next;
            m.at = durable;
        }
        let (tx, rx) = channel();
        let (sh, salt) = (shared.clone(), header.salt);
        let writer = std::thread::Builder::new()
            .name("log-writer".into())
            .spawn(move || write_loop(storage, rx, sh, salt, durable))
            .map_err(|e| Refusal {
                name: "log-io",
                detail: format!("the writer thread did not start: {e}"),
            })?;
        Ok((
            Log {
                tx: Some(tx),
                shared,
                writer: Some(writer),
                next,
            },
            found,
        ))
    }

    /// Hands one tick's T6 bytes to the writer; returns the record's number. Never waits for the disk.
    pub fn append(&mut self, bytes: Vec<u8>) -> R<u64> {
        if let Some(f) = &self.shared.marks().failed {
            return refuse("log-failed", f.to_string());
        }
        if bytes.is_empty() || bytes.len() > MAX_RECORD {
            return refuse(
                "record-size",
                format!("{} bytes (1 to {MAX_RECORD})", bytes.len()),
            );
        }
        let tx = self.tx.as_ref().expect("open until closed");
        if tx.send(bytes).is_err() {
            let f = self.shared.marks().failed.clone();
            return refuse(
                "log-failed",
                f.map_or("the writer stopped".into(), |f| f.to_string()),
            );
        }
        self.next += 1;
        Ok(self.next - 1)
    }

    /// The durable mark: records `..durable()` are on the disk, and acts in them may be acknowledged.
    pub fn durable(&self) -> u64 {
        self.shared.marks().durable
    }

    /// Where the durable records end (rule 8): what a checkpoint keeps, so a restart reads the log from there.
    pub fn durable_at(&self) -> At {
        self.shared.marks().at
    }

    /// Waits until records `..n` are on the disk, or the writer has failed (`log-failed`).
    pub fn wait_durable(&self, n: u64) -> R<()> {
        self.shared.wait(n).map(|_| ())
    }

    /// A handle on the durable mark that another thread may hold and wait on.
    pub fn durable_mark(&self) -> Durable {
        Durable(self.shared.clone())
    }

    /// Why the writer stopped, if it did.
    pub fn failed(&self) -> Option<Refusal> {
        self.shared.marks().failed.clone()
    }

    /// The off-machine mark: records `..off_machine()` are stored off the machine.
    pub fn off_machine(&self) -> u64 {
        self.shared.marks().off_machine
    }

    /// Moves the off-machine mark (O3, once it has shipped records `..n`); it never passes the durable mark.
    pub fn set_off_machine(&self, n: u64) {
        let mut m = self.shared.marks();
        m.off_machine = m.off_machine.max(n.min(m.durable));
        self.shared.moved.notify_all();
    }

    /// Stops the writer once it has written what was handed to it, and gives the storage back.
    pub fn close(mut self) -> S {
        self.tx = None;
        self.writer
            .take()
            .expect("open until closed")
            .join()
            .unwrap_or_else(|p| std::panic::resume_unwind(p))
    }
}

impl<S: Storage + 'static> Drop for Log<S> {
    fn drop(&mut self) {
        self.tx = None;
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
    }
}

/// The writer thread: everything queued becomes one append and one sync (rule 3); a failure stops it for good (rule 6).
fn write_loop<S: Storage>(
    mut storage: S,
    rx: Receiver<Vec<u8>>,
    shared: Arc<Shared>,
    salt: u32,
    mut at: At,
) -> S {
    let mut buf = Vec::new();
    while let Ok(first) = rx.recv() {
        buf.clear();
        let mut n = 0u64;
        let mut chain = at.crc;
        let mut out = Ok(());
        for bytes in std::iter::once(first).chain(rx.try_iter()) {
            match encode_in_batch(&mut buf, salt, chain, &bytes, n > 0) {
                Ok(c) => chain = c,
                Err(e) => {
                    out = Err(e);
                    break;
                }
            }
            n += 1;
        }
        let out = out
            .and_then(|_| storage.append(&buf))
            .and_then(|_| storage.sync());
        let mut m = shared.marks();
        match out {
            Ok(()) => {
                // Read by worldd's view tier to time frames from the sync, never by the engine.
                #[allow(clippy::disallowed_methods)]
                let now = Instant::now();
                m.synced = Some((at.record, now));
                at = At {
                    record: at.record + n,
                    offset: at.offset + buf.len() as u64,
                    crc: chain,
                };
                m.durable = at.record;
                m.at = at;
            }
            Err(e) => m.failed = Some(e),
        }
        let p = if m.failed.is_none() {
            m.compact.take()
        } else {
            None
        };
        shared.moved.notify_all();
        if m.failed.is_some() {
            break;
        }
        drop(m);
        // Rule 9: a compacted copy is finished here, between two syncs, so it holds every byte appended.
        if let Some(p) = p {
            let cut = p.cut;
            let out = storage.compact(p);
            let mut m = shared.marks();
            m.compacted = Some(match out {
                Ok(()) => Ok(cut),
                Err((e, fatal)) => {
                    if fatal {
                        m.failed = Some(e.clone());
                    }
                    Err(e)
                }
            });
            shared.moved.notify_all();
            if m.failed.is_some() {
                break;
            }
        }
        // Rule 10: room for the next ticks (a compacted copy's included), made after the answers were released.
        if let Err(e) = storage.reserve() {
            shared.marks().failed = Some(e);
            shared.moved.notify_all();
            break;
        }
    }
    storage
}
