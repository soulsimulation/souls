//! The log's compaction (#3837, `sim::log` rule 9): the bytes before a cut go back to the disk, the offsets and
//! record numbers after it stay, and a crash at any point of the two phases reopens the same records.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use sim::log::compact::{Cut, cut_path, prepare, read_cut};
use sim::log::{At, FileStore, Log};

const BIG: usize = 64 << 10;

fn payload(i: u64) -> Vec<u8> {
    (0..BIG).map(|k| (i as usize * 31 + k) as u8).collect()
}

fn fresh(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("log")
}

/// A log of records `..n`, its writer still open, and the place after record `cut`.
fn written(path: &Path, cut: u64, n: u64) -> (Log<FileStore>, At) {
    let (mut log, _) = Log::open(FileStore::open(path).unwrap(), 1).unwrap();
    for i in 0..cut {
        log.append(payload(i)).unwrap();
    }
    log.wait_durable(cut).unwrap();
    let at = log.durable_at();
    for i in cut..n {
        log.append(payload(i)).unwrap();
    }
    log.wait_durable(n).unwrap();
    (log, at)
}

fn reopened(path: &Path) -> (u64, Vec<Vec<u8>>) {
    let (log, found) = Log::open(FileStore::open(path).unwrap(), 1).unwrap();
    drop(log);
    (found.first, found.records)
}

#[test]
fn i3837_a_compacted_log_reopens_from_its_cut_with_the_same_records_and_frees_the_blocks() {
    let path = fresh("i3837-compacted");
    let (mut log, at) = written(&path, 50, 100);
    assert_eq!(at.record, 50);
    let upto = log.durable_at();
    let p = prepare(&path, Cut { at, note: 7 }, upto)
        .unwrap()
        .expect("a copy");
    let durable = log.durable_mark();
    durable.compact(p);
    // The writer finishes it after its next sync, with the record appended meanwhile.
    log.append(payload(100)).unwrap();
    log.wait_durable(101).unwrap();
    // The copy is finished just after that sync returns: wait for its outcome.
    let done = (0..500)
        .find_map(|_| {
            durable.compacted().or_else(|| {
                std::thread::sleep(std::time::Duration::from_millis(10));
                None
            })
        })
        .expect("finished")
        .expect("compacted");
    assert_eq!(done.at, at);
    // Appends go to the compacted file from then on.
    for i in 101..110 {
        log.append(payload(i)).unwrap();
    }
    log.wait_durable(110).unwrap();
    drop(log);
    let meta = std::fs::metadata(&path).unwrap();
    let held = meta.blocks() * 512;
    let dead = at.offset;
    println!(
        "log: {} bytes long, {held} bytes on the disk, {dead} bytes before the cut",
        meta.len()
    );
    assert!(
        held + dead / 2 < meta.len(),
        "the bytes before the cut are a hole"
    );
    assert_eq!(read_cut(&path).unwrap().map(|c| c.note), Some(7));
    let (first, records) = reopened(&path);
    assert_eq!(first, 50);
    assert_eq!(records, (50..110).map(payload).collect::<Vec<_>>());
}

#[test]
fn i3837_a_crash_after_the_cut_file_and_before_the_rename_reopens_the_same_records() {
    let path = fresh("i3837-crash-between");
    let (log, at) = written(&path, 30, 60);
    let upto = log.durable_at();
    // Phase one done, phase two never: the process dies with its copy unfinished.
    let p = prepare(&path, Cut { at, note: 0 }, upto).unwrap().unwrap();
    drop(p);
    drop(log);
    assert!(path.with_file_name("log.compact").exists());
    let (first, records) = reopened(&path);
    assert_eq!(first, 30, "read from the cut, in the whole log");
    assert_eq!(records, (30..60).map(payload).collect::<Vec<_>>());
    assert!(
        !path.with_file_name("log.compact").exists(),
        "the unfinished copy is removed at the open"
    );
    // A checkpoint's place before the cut is passed over for the cut; one after it is used.
    let (log, found) =
        Log::open_at(FileStore::open(&path).unwrap(), 1, Some(At::default())).unwrap();
    drop(log);
    assert_eq!(found.first, 30);
}

#[test]
fn i3837_a_cut_that_does_not_check_is_refused_by_name_never_read_from_byte_0() {
    let path = fresh("i3837-cut-bad");
    let (log, at) = written(&path, 10, 20);
    let upto = log.durable_at();
    let wrong = At {
        crc: at.crc ^ 1,
        ..at
    };
    assert_eq!(
        prepare(&path, Cut { at: wrong, note: 0 }, upto)
            .unwrap_err()
            .name,
        "log-cut-bad"
    );
    drop(prepare(&path, Cut { at, note: 0 }, upto).unwrap());
    drop(log);
    let mut bytes = std::fs::read(cut_path(&path)).unwrap();
    bytes[3] ^= 0xff;
    std::fs::write(cut_path(&path), bytes).unwrap();
    let err = Log::open(FileStore::open(&path).unwrap(), 1).err().unwrap();
    assert_eq!(err.name, "log-cut-bad");
}
