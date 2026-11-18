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
//! 4. **Recovery reads forward.** A record that does not check with nothing valid after it is a torn tail: it is
//!    reported ([`Torn`]), cut back and synced. One that does not check with any valid record after it, a valid
//!    record out of the chain, or a damaged header with bytes after it, is corruption: refused by name
//!    (`log-corrupt`, `log-header-bad`) and never trimmed (SQLite, TigerBeetle and Redis draw the same line;
//!    `v2/docs/tranche/K-core.md`, facts 1, 3 and 4).
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
//!
//! The kill and power-cut runner and the sync table are `v2/tools/log-crash`. Not here: shipping off the machine
//! (O3), views (R3), packing (V3), a full disk (O10), checkpoints (K5).

mod record;
mod storage;

pub use record::{
    At, HEAD_LEN, HEADER_LEN, Header, MAX_RECORD, Recovered, Torn, crc32c, encode_record, recover,
    recover_from,
};
pub use storage::{FileStore, Mem, MemDisk, Storage};

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

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
        let from = match at {
            Some(a) => {
                let head = storage.read_from(0, HEADER_LEN)?;
                let tail = storage.read_from(a.offset, usize::MAX)?;
                recover_from(&head, &tail, a)?
            }
            None => None,
        };
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
        let mut m = self.shared.marks();
        loop {
            if m.durable >= n {
                return Ok(());
            }
            if let Some(f) = &m.failed {
                return refuse("log-failed", f.to_string());
            }
            m = self.shared.moved.wait(m).unwrap_or_else(|p| p.into_inner());
        }
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
            match encode_record(&mut buf, salt, chain, &bytes) {
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
        shared.moved.notify_all();
        if m.failed.is_some() {
            break;
        }
    }
    storage
}
