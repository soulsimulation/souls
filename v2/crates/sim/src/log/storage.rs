//! Where the log's bytes live, behind one small interface: append, sync, read, and cut back (recovery's only write).
//! [`FileStore`] is a file on the machine's disk; [`Mem`] is a disk in memory that the fault simulation drives (O5),
//! and the text store (K16) reuses: it drops what was not synced at a power cut, cuts writes and fails syncs.

use std::fs::{File, OpenOptions};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use replica::effects::Refusal;

use super::compact::{Prepared, compact_path, finish, read_cut};
use super::record::At;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The storage a log is written to. One writer at a time; a failed sync is final (`v2/crates/sim/src/log/mod.rs`,
/// rule 6), and the log never calls `sync` again on storage whose sync failed.
pub trait Storage: Send {
    /// Writes `bytes` after the last byte.
    fn append(&mut self, bytes: &[u8]) -> R<()>;
    /// Puts every byte appended so far on the disk itself; once it returns Ok they survive a power cut.
    fn sync(&mut self) -> R<()>;
    /// Every byte, synced or not, as the operating system would read them back.
    fn read(&mut self) -> R<Vec<u8>>;
    /// At most `max` bytes from byte `at` on (none past the end): a restart reads the header and the log after its
    /// checkpoint, not the bytes between (K4b). Storage that can seek reads only those.
    fn read_from(&mut self, at: u64, max: usize) -> R<Vec<u8>> {
        let all = self.read()?;
        let from = usize::try_from(at).unwrap_or(usize::MAX).min(all.len());
        Ok(all[from..from.saturating_add(max).min(all.len())].to_vec())
    }
    /// Cuts the storage back to `len` bytes (recovery cutting a torn tail, then syncing).
    fn truncate(&mut self, len: u64) -> R<()>;
    /// Makes room ahead of the end, written and synced, so the appends and syncs that follow change no file metadata
    /// (rule 10). Called by the writer after a sync, never before an acknowledgement. A failed sync here is final as
    /// any other is; room that could not be written is not an error (the appends then grow the file themselves).
    fn reserve(&mut self) -> R<()> {
        Ok(())
    }
    /// Where a compacted log starts (rule 9): none for storage that was never compacted.
    fn cut(&mut self) -> R<Option<At>> {
        Ok(None)
    }
    /// Finishes a compacted copy (rule 9) with every byte appended so far, and appends to it from then on. The flag
    /// says the failure is final, as a failed sync is.
    fn compact(&mut self, p: Prepared) -> Result<(), (Refusal, bool)> {
        drop(p);
        Err((
            Refusal {
                name: "compact-unsupported",
                detail: "this storage is not compacted".into(),
            },
            false,
        ))
    }
}

/// The disk behind [`Mem`]: its bytes, how many of them are durable, and the faults set on it.
#[derive(Clone, Debug, Default)]
pub struct MemDisk {
    pub bytes: Vec<u8>,
    /// Bytes `..durable` survive a power cut.
    pub durable: usize,
    /// Syncs asked for, failed ones included.
    pub syncs: u64,
    /// The sync with this number (from 1) fails: its bytes are never made durable, and, as Linux does, every later
    /// sync reports success without making them durable (the trap a retry falls into).
    pub fail_sync: Option<u64>,
    /// Appends stop after this many more bytes: the append that crosses it writes the bytes before and fails.
    pub write_budget: Option<usize>,
    /// The sync with this number (from 1) never returns until the power is cut: a power cut lands while bytes are
    /// written and not yet synced.
    pub stall_sync: Option<u64>,
    /// Set by a failed sync: the first byte that may never reach the disk.
    pub lost_from: Option<usize>,
    /// Set by a power cut: everything fails until the disk is read back as a new [`Mem`].
    pub off: bool,
}

impl MemDisk {
    /// A power cut: bytes after the last sync are dropped, except the first `keep` of them, which reached the disk
    /// (a write torn at a random byte). Returns the bytes that survive.
    pub fn power_cut(&mut self, keep: usize) -> Vec<u8> {
        // After a failed sync nothing past the durable bytes reaches the disk.
        let unsynced = self.bytes.len() - self.durable;
        let survive = if self.lost_from.is_some() {
            self.durable
        } else {
            self.durable + keep.min(unsynced)
        };
        self.bytes.truncate(survive);
        self.durable = self.bytes.len();
        self.off = true;
        self.bytes.clone()
    }
}

/// A disk in memory, shared so a test or the fault simulation can cut its power while a writer uses it.
#[derive(Clone, Debug, Default)]
pub struct Mem(pub Arc<Mutex<MemDisk>>);

impl Mem {
    /// A disk holding `bytes`, all durable: what a machine reads back after a restart.
    pub fn with(bytes: Vec<u8>) -> Mem {
        let durable = bytes.len();
        Mem(Arc::new(Mutex::new(MemDisk {
            bytes,
            durable,
            ..MemDisk::default()
        })))
    }

    fn disk(&self) -> std::sync::MutexGuard<'_, MemDisk> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl Storage for Mem {
    fn append(&mut self, bytes: &[u8]) -> R<()> {
        let mut d = self.disk();
        if d.off {
            return refuse("power-lost", "the disk has no power");
        }
        if let Some(budget) = d.write_budget {
            if bytes.len() > budget {
                d.bytes.extend_from_slice(&bytes[..budget]);
                d.write_budget = Some(0);
                return refuse(
                    "write-cut",
                    format!("{budget} of {} bytes written", bytes.len()),
                );
            }
            d.write_budget = Some(budget - bytes.len());
        }
        d.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn sync(&mut self) -> R<()> {
        let mut d = self.disk();
        if d.off {
            return refuse("power-lost", "the disk has no power");
        }
        d.syncs += 1;
        if d.stall_sync == Some(d.syncs) {
            while !d.off {
                drop(d);
                std::thread::yield_now();
                d = self.disk();
            }
            return refuse("power-lost", "the power was cut during the sync");
        }
        if d.fail_sync == Some(d.syncs) {
            d.lost_from = Some(d.durable);
            return refuse("sync-failed", format!("sync {} failed (EIO)", d.syncs));
        }
        if d.lost_from.is_none() {
            d.durable = d.bytes.len();
        }
        Ok(())
    }

    fn read(&mut self) -> R<Vec<u8>> {
        let d = self.disk();
        if d.off {
            return refuse("power-lost", "the disk has no power");
        }
        Ok(d.bytes.clone())
    }

    fn truncate(&mut self, len: u64) -> R<()> {
        let mut d = self.disk();
        if d.off {
            return refuse("power-lost", "the disk has no power");
        }
        let len = len as usize;
        d.bytes.truncate(len);
        d.durable = d.durable.min(len);
        Ok(())
    }
}

/// How far ahead of its end a [`FileStore::open`] keeps zeros on the disk (rule 10): refilled once less than half is
/// left, so one refill a [`RESERVE`] / 2 of log.
pub const RESERVE: u64 = 16 << 20;

/// Zeros written a piece at a time when room is made.
const ZEROS: [u8; 1 << 16] = [0; 1 << 16];

/// A log file on the machine's disk, held by an exclusive lock for as long as this lives (one writer per log).
/// A sync is `fdatasync` (`File::sync_data`; on macOS that is `F_FULLFSYNC`); a new file's directory is synced too.
///
/// Appends write at the log's own end into room already written with zeros and synced ([`Storage::reserve`]), so a
/// sync writes data only: no size or block of the file changes, and `fdatasync` waits for no filesystem journal
/// commit, which on ext4 would first write every other process's pending data (#4973). Reads stop at the end. A
/// clean close (drop) cuts the zeros off; after a crash they are a torn tail, cut by recovery (rule 4).
#[derive(Debug)]
pub struct FileStore {
    file: File,
    path: PathBuf,
    failed: bool,
    /// Where the next append writes: the end of what was written.
    end: u64,
    /// The file's length: bytes `end..len` are zeros (or, after a crash, the torn tail recovery cuts).
    len: u64,
    /// How much room to keep ahead of `end`; 0 keeps none.
    reserve: u64,
}

impl FileStore {
    /// Opens or creates the log at `path` and takes its lock (`log-locked` while another process holds it), keeping
    /// [`RESERVE`] of room ahead of its end.
    pub fn open(path: &Path) -> R<FileStore> {
        FileStore::open_reserving(path, RESERVE)
    }

    /// As [`FileStore::open`], keeping `reserve` bytes of room ahead of the end (0: none, every append grows the file).
    pub fn open_reserving(path: &Path, reserve: u64) -> R<FileStore> {
        let io = |e: std::io::Error| Refusal {
            name: "log-io",
            detail: format!("{}: {e}", path.display()),
        };
        let existed = path.exists();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(io)?;
        if file.try_lock().is_err() {
            return refuse("log-locked", "another writer holds this log");
        }
        // A compacted copy a crash left unfinished (rule 9): the log and its cut file stand without it.
        match std::fs::remove_file(compact_path(path)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(io(e)),
            _ => {}
        }
        if !existed {
            // A new file's name is only durable once its directory is synced.
            let dir = path.parent().filter(|d| !d.as_os_str().is_empty());
            File::open(dir.unwrap_or(Path::new(".")))
                .and_then(|d| d.sync_all())
                .map_err(io)?;
        }
        let len = file.metadata().map_err(io)?.len();
        Ok(FileStore {
            file,
            path: path.to_path_buf(),
            failed: false,
            end: len,
            len,
            reserve,
        })
    }

    fn io(&self, name: &'static str, e: std::io::Error) -> Refusal {
        Refusal {
            name,
            detail: format!("{}: {e}", self.path.display()),
        }
    }
}

impl Storage for FileStore {
    fn append(&mut self, bytes: &[u8]) -> R<()> {
        if self.failed {
            return refuse(
                "log-failed",
                "a sync failed on this file; it takes nothing more",
            );
        }
        let at = self.end;
        // Past the room, the write grows the file and its sync commits that, as an append always did.
        self.end += bytes.len() as u64;
        self.len = self.len.max(self.end);
        self.file
            .write_all_at(bytes, at)
            .map_err(|e| self.io("write-failed", e))
    }

    fn sync(&mut self) -> R<()> {
        if self.failed {
            // Never retried: after a failed sync Linux marks the pages clean, and a retry "succeeds" with them gone.
            return refuse(
                "log-failed",
                "a sync failed on this file; it is never retried",
            );
        }
        self.file.sync_data().map_err(|e| {
            self.failed = true;
            self.io("sync-failed", e)
        })
    }

    fn read(&mut self) -> R<Vec<u8>> {
        self.read_from(0, usize::MAX)
    }

    fn read_from(&mut self, at: u64, max: usize) -> R<Vec<u8>> {
        let to = self.end.min(at.saturating_add(max as u64));
        let mut out = vec![0; to.saturating_sub(at) as usize];
        self.file
            .read_exact_at(&mut out, at)
            .map_err(|e| self.io("log-io", e))?;
        Ok(out)
    }

    fn truncate(&mut self, len: u64) -> R<()> {
        if self.failed {
            return refuse(
                "log-failed",
                "a sync failed on this file; it takes nothing more",
            );
        }
        self.file.set_len(len).map_err(|e| self.io("log-io", e))?;
        (self.end, self.len) = (len, len);
        Ok(())
    }

    fn reserve(&mut self) -> R<()> {
        if self.failed || self.len - self.end >= self.reserve / 2 {
            return Ok(());
        }
        let to = self.end + self.reserve;
        let mut at = self.len;
        while at < to {
            let n = (to - at).min(ZEROS.len() as u64) as usize;
            if self.file.write_all_at(&ZEROS[..n], at).is_err() {
                // A full disk: no room made, and the appends grow the file as before. What was written is zeros.
                break;
            }
            at += n as u64;
        }
        if at == self.len {
            return Ok(());
        }
        self.sync()?;
        self.len = at;
        Ok(())
    }

    fn cut(&mut self) -> R<Option<At>> {
        Ok(read_cut(&self.path)?.map(|c| c.at))
    }

    fn compact(&mut self, p: Prepared) -> Result<(), (Refusal, bool)> {
        if self.failed || p.log != self.path {
            return Err((
                Refusal {
                    name: "log-cut-bad",
                    detail: "not this log's copy, or the log has failed".into(),
                },
                false,
            ));
        }
        match finish(&self.file, self.end, p) {
            Ok(file) => {
                // The copy ends at the end: its room is made again after the next sync.
                self.file = file;
                self.len = self.end;
                Ok(())
            }
            Err((e, fatal)) => {
                self.failed |= fatal;
                Err((e, fatal))
            }
        }
    }
}

impl Drop for FileStore {
    /// A clean close cuts the room off, so the file ends where the log does. Best effort: after a crash, or if this
    /// fails, the zeros are a torn tail that recovery cuts (rule 4).
    fn drop(&mut self) {
        if !self.failed && self.len > self.end && self.file.set_len(self.end).is_ok() {
            let _ = self.file.sync_data();
        }
    }
}
