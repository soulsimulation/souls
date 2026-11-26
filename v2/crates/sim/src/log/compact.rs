//! Compaction (rule 9, #3837): the log's bytes before a place every reader has passed are given back to the disk,
//! so a world's log on the disk, and what a restart reads, stay bounded however long the world runs.
//!
//! 1. **Same offsets, same record numbers.** The compacted log is the header, a hole, then the bytes from the cut on,
//!    each at the offset it had: a checkpoint's place (rule 8) still names the same bytes, and no reader renumbers.
//!    The hole is a sparse file's: the disk holds no blocks for it (ext4, xfs, tmpfs and APFS all do this).
//! 2. **The cut file** (`<log>.cut`) names the first place kept: `[record, offset, chain checksum, note]` and its
//!    CRC-32C, little-endian. The note is the caller's (worldd keeps its archive's part count there). A log with a cut
//!    file is read from it (`Log::open`), never from byte 0, whose records are gone.
//! 3. **Two phases, the clock never waits.** [`prepare`] runs on any thread: it checks the place continues the chain,
//!    writes the cut file (whole: a temporary name, a sync, a rename, a sync of the directory), then copies the bytes
//!    from the cut to a durable place into `<log>.compact` behind the hole, locked, and syncs it. The log's writer
//!    then finishes it between two syncs (`Durable::compact`): the bytes appended since, a sync, a rename over the
//!    log, a sync of the directory, and it appends to the new file from then on.
//! 4. **A crash at any point recovers exactly.** Before the cut file's rename: the old log and the old cut. After it:
//!    the cut names a place in the whole log, which still reads from there. After the log's rename: the compacted
//!    log, read from the same place. A `<log>.compact` left by a crash is removed when the log is next opened.
//! 5. **Only what every reader has passed.** Which place that is (the oldest checkpoint kept, and the copies that
//!    follow the log off the clock) is the caller's to say; this never chooses one.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use replica::effects::Refusal;

use super::record::{At, HEAD_LEN, HEADER_LEN, crc32c};

type R<T> = Result<T, Refusal>;

const CUT_LEN: usize = 32;

/// The first place a compacted log keeps, and the caller's note on it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cut {
    pub at: At,
    pub note: u64,
}

impl Cut {
    fn to_bytes(self) -> [u8; CUT_LEN] {
        let mut b = [0u8; CUT_LEN];
        b[0..8].copy_from_slice(&self.at.record.to_le_bytes());
        b[8..16].copy_from_slice(&self.at.offset.to_le_bytes());
        b[16..20].copy_from_slice(&self.at.crc.to_le_bytes());
        b[20..28].copy_from_slice(&self.note.to_le_bytes());
        let c = crc32c(0, &b[..28]);
        b[28..32].copy_from_slice(&c.to_le_bytes());
        b
    }

    fn read(b: &[u8]) -> Option<Cut> {
        if b.len() != CUT_LEN || crc32c(0, &b[..28]).to_le_bytes() != b[28..32] {
            return None;
        }
        let u64_at = |i: usize| u64::from_le_bytes(b[i..i + 8].try_into().expect("8 bytes"));
        Some(Cut {
            at: At {
                record: u64_at(0),
                offset: u64_at(8),
                crc: u32::from_le_bytes(b[16..20].try_into().expect("4 bytes")),
            },
            note: u64_at(20),
        })
    }
}

fn beside(log: &Path, ext: &str) -> PathBuf {
    let mut s = log.as_os_str().to_owned();
    s.push(ext);
    PathBuf::from(s)
}

/// `<log>.cut`.
pub fn cut_path(log: &Path) -> PathBuf {
    beside(log, ".cut")
}

/// `<log>.compact`, the compacted copy being made.
pub(super) fn compact_path(log: &Path) -> PathBuf {
    beside(log, ".compact")
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> Refusal + '_ {
    move |e| Refusal {
        name: "log-io",
        detail: format!("{}: {e}", path.display()),
    }
}

/// The log's cut, if it was ever compacted. A cut file that does not check is refused (`log-cut-bad`): the bytes
/// before its place may be gone, so the log is never read from byte 0 instead.
pub fn read_cut(log: &Path) -> R<Option<Cut>> {
    let path = cut_path(log);
    match fs::read(&path) {
        Ok(b) => Cut::read(&b).map(Some).ok_or_else(|| Refusal {
            name: "log-cut-bad",
            detail: format!("{}: the cut file does not check", path.display()),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io(&path)(e)),
    }
}

pub(super) fn sync_dir(path: &Path) -> std::io::Result<()> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty());
    File::open(dir.unwrap_or(Path::new("."))).and_then(|d| d.sync_all())
}

/// A compacted copy, made up to a durable place, for the log's writer to finish ([`crate::log::Durable::compact`]).
#[derive(Debug)]
pub struct Prepared {
    pub(super) file: File,
    pub(super) tmp: PathBuf,
    pub(super) log: PathBuf,
    /// The cut the copy keeps from.
    pub cut: Cut,
    /// The durable place the copy reaches; the writer copies what follows.
    pub(super) upto: At,
}

/// Phase one (rule 3): checks `cut` continues the log's chain, writes the cut file, and copies the log's bytes from
/// `cut` to `upto` (a durable place, so whole records that are on the disk) into a locked `<log>.compact`. `None` when
/// the log is already cut at or after `cut`.
pub fn prepare(log: &Path, cut: Cut, upto: At) -> R<Option<Prepared>> {
    if upto.offset < cut.at.offset || upto.record < cut.at.record {
        return Err(Refusal {
            name: "log-cut-bad",
            detail: format!("the cut {:?} is after the durable place {:?}", cut.at, upto),
        });
    }
    if cut.at.offset < HEADER_LEN as u64 {
        return Ok(None);
    }
    if read_cut(log)?.is_some_and(|old| old.at.offset >= cut.at.offset) {
        return Ok(None);
    }
    let mut src = File::open(log).map_err(io(log))?;
    let mut header = vec![0u8; HEADER_LEN];
    src.read_exact(&mut header).map_err(io(log))?;
    if upto.offset >= cut.at.offset + HEAD_LEN as u64 {
        let mut head = [0u8; HEAD_LEN];
        src.seek(SeekFrom::Start(cut.at.offset))
            .and_then(|_| src.read_exact(&mut head))
            .map_err(io(log))?;
        if u32::from_le_bytes(head[4..8].try_into().expect("4 bytes")) != cut.at.crc {
            return Err(Refusal {
                name: "log-cut-bad",
                detail: format!("record {} does not continue the chain there", cut.at.record),
            });
        }
    }
    // The cut file first: its place reads the same in the whole log and in the compacted one.
    let cut_file = cut_path(log);
    let cut_tmp = beside(log, ".cut.tmp");
    (|| -> std::io::Result<()> {
        let mut f = File::create(&cut_tmp)?;
        f.write_all(&cut.to_bytes())?;
        f.sync_all()?;
        fs::rename(&cut_tmp, &cut_file)?;
        sync_dir(&cut_file)
    })()
    .map_err(io(&cut_file))?;
    let tmp = compact_path(log);
    match fs::remove_file(&tmp) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(io(&tmp)(e)),
        _ => {}
    }
    let file = OpenOptions::new()
        .read(true)
        .append(true)
        .create_new(true)
        .open(&tmp)
        .map_err(io(&tmp))?;
    if file.try_lock().is_err() {
        return Err(Refusal {
            name: "log-locked",
            detail: format!("{}: held by another", tmp.display()),
        });
    }
    (|| -> std::io::Result<()> {
        (&file).write_all(&header)?;
        // The hole: no blocks on the disk, the same offsets after it.
        file.set_len(cut.at.offset)?;
        src.seek(SeekFrom::Start(cut.at.offset))?;
        let copied = std::io::copy(&mut (&src).take(upto.offset - cut.at.offset), &mut &file)?;
        if copied != upto.offset - cut.at.offset {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "the log is shorter than its durable place",
            ));
        }
        file.sync_all()
    })()
    .map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io(&tmp)(e)
    })?;
    Ok(Some(Prepared {
        file,
        tmp,
        log: log.to_path_buf(),
        cut,
        upto,
    }))
}

/// Phase two, on the writer between syncs (rule 3): `from`, the log as it stands with every byte synced, gets its
/// bytes after `p.upto` copied, then the copy replaces it. `Err` with `sync-failed` once the rename may not be durable:
/// from then on the writer must stop, as after a failed sync (rule 6). Any other `Err` leaves the log as it was.
pub(super) fn finish(from: &File, p: Prepared) -> Result<File, (Refusal, bool)> {
    let Prepared {
        file,
        tmp,
        log,
        upto,
        ..
    } = p;
    let soft = |e: std::io::Error| {
        let _ = fs::remove_file(&tmp);
        (io(&tmp)(e), false)
    };
    let len = from.metadata().map_err(soft)?.len();
    if file.metadata().map_err(soft)?.len() != upto.offset || len < upto.offset {
        let _ = fs::remove_file(&tmp);
        return Err((
            Refusal {
                name: "log-cut-bad",
                detail: "the compacted copy does not end at its place".into(),
            },
            false,
        ));
    }
    (|| -> std::io::Result<()> {
        let mut src = from;
        src.seek(SeekFrom::Start(upto.offset))?;
        std::io::copy(&mut src.take(len - upto.offset), &mut &file)?;
        file.sync_data()
    })()
    .map_err(soft)?;
    fs::rename(&tmp, &log).map_err(soft)?;
    // The new name is only durable once its directory is synced; until then appends to it could be lost.
    sync_dir(&log).map_err(|e| {
        (
            Refusal {
                name: "sync-failed",
                detail: format!("{}: the directory after compaction: {e}", log.display()),
            },
            true,
        )
    })?;
    Ok(file)
}
