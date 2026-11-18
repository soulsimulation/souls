//! Where the log's bytes live, behind one small interface: append, sync, read, and cut back (recovery's only write).
//! [`FileStore`] is a file on the machine's disk; [`Mem`] is a disk in memory that the fault simulation drives (O5),
//! and the text store (K16) reuses: it drops what was not synced at a power cut, cuts writes and fails syncs.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use replica::effects::Refusal;

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
    /// Cuts the storage back to `len` bytes (recovery cutting a torn tail, then syncing).
    fn truncate(&mut self, len: u64) -> R<()>;
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

/// A log file on the machine's disk, held by an exclusive lock for as long as this lives (one writer per log).
/// A sync is `fdatasync` (`File::sync_data`; on macOS that is `F_FULLFSYNC`); a new file's directory is synced too.
#[derive(Debug)]
pub struct FileStore {
    file: File,
    path: PathBuf,
    failed: bool,
}

impl FileStore {
    /// Opens or creates the log at `path` and takes its lock (`log-locked` while another process holds it).
    pub fn open(path: &Path) -> R<FileStore> {
        let io = |e: std::io::Error| Refusal {
            name: "log-io",
            detail: format!("{}: {e}", path.display()),
        };
        let existed = path.exists();
        let file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(path)
            .map_err(io)?;
        if file.try_lock().is_err() {
            return refuse("log-locked", "another writer holds this log");
        }
        if !existed {
            // A new file's name is only durable once its directory is synced.
            let dir = path.parent().filter(|d| !d.as_os_str().is_empty());
            File::open(dir.unwrap_or(Path::new(".")))
                .and_then(|d| d.sync_all())
                .map_err(io)?;
        }
        Ok(FileStore {
            file,
            path: path.to_path_buf(),
            failed: false,
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
        self.file
            .write_all(bytes)
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
        let mut out = Vec::new();
        self.file
            .seek(SeekFrom::Start(0))
            .and_then(|_| self.file.read_to_end(&mut out))
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
        self.file.set_len(len).map_err(|e| self.io("log-io", e))
    }
}
