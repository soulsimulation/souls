//! The log of effects (Engine v2 K4, #2668): 50 simulated power cuts, damage before the tail, a failed sync, the
//! lock and the epoch. The 50 process kills and the sync table are `v2/tools/log-crash`.
//! Run with `cargo test -p sim --test log -- --nocapture` to see each power cut's seed and outcome.

use sim::log::{
    FileStore, HEAD_LEN, HEADER_LEN, Header, Log, Mem, RESERVE, Storage, Torn, crc32c,
    encode_in_batch, recover,
};

/// splitmix64: the seeded numbers the runs draw from (never the world's, never the operating system's).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

/// Record `i` of a run: a length and bytes that only depend on the seed and `i`.
fn payload(seed: u64, i: u64) -> Vec<u8> {
    let mut r = Rng(seed ^ i.wrapping_mul(0x2545_F491_4F6C_DD1D));
    let len = 1 + r.below(300) as usize;
    (0..len).map(|_| r.next() as u8).collect()
}

/// Where each record starts, and where the last ends, for records `..n` of a run.
fn starts(seed: u64, n: u64) -> Vec<usize> {
    let mut at = vec![HEADER_LEN];
    for i in 0..n {
        at.push(at[i as usize] + HEAD_LEN + payload(seed, i).len());
    }
    at
}

#[test]
fn crc32c_is_castagnoli() {
    assert_eq!(crc32c(0, b"123456789"), 0xE306_9283);
}

#[test]
fn a_log_reopens_with_every_record() {
    let mem = Mem::default();
    let (mut log, found) = Log::open(mem.clone(), 1).unwrap();
    assert_eq!(found.records.len(), 0);
    for i in 0..100 {
        assert_eq!(log.append(payload(7, i)).unwrap(), i);
    }
    log.wait_durable(100).unwrap();
    log.close();
    let (mut log, found) = Log::open(mem.clone(), 1).unwrap();
    assert_eq!(found.torn, None);
    assert_eq!(
        found.records,
        (0..100).map(|i| payload(7, i)).collect::<Vec<_>>()
    );
    assert_eq!(log.append(payload(7, 100)).unwrap(), 100);
    log.wait_durable(101).unwrap();
}

/// K4b (#3136): a log opened from a checkpoint's place reads only from there, numbers its records from it, cuts a
/// torn tail after it, and goes on the chain; a place that does not belong to the log reads the whole log instead.
#[test]
fn a_log_opens_from_a_checkpoints_place() {
    let mem = Mem::default();
    let (mut log, _) = Log::open(mem.clone(), 1).unwrap();
    for i in 0..60 {
        log.append(payload(9, i)).unwrap();
    }
    log.wait_durable(60).unwrap();
    let place = log.durable_at();
    assert_eq!(place.record, 60);
    assert_eq!(place.offset as usize, starts(9, 60)[60]);
    for i in 60..100 {
        log.append(payload(9, i)).unwrap();
    }
    log.wait_durable(100).unwrap();
    log.close();
    // A torn record at the end.
    mem.0.lock().unwrap().bytes.extend_from_slice(&[7; 5]);
    let (mut log, found) = Log::open_at(mem.clone(), 1, Some(place)).unwrap();
    assert_eq!((found.first, found.start), (60, place.offset as usize));
    assert_eq!(
        found.records,
        (60..100).map(|i| payload(9, i)).collect::<Vec<_>>()
    );
    assert_eq!(found.after(70).len(), 30);
    assert_eq!(found.torn.map(|t| t.dropped), Some(5));
    assert_eq!(log.append(payload(9, 100)).unwrap(), 100);
    log.wait_durable(101).unwrap();
    log.close();
    let whole = recover(&mem.0.lock().unwrap().bytes).unwrap();
    assert_eq!(whole.records.len(), 101, "the chain goes on");
    // A place whose record does not continue the chain from its checksum: the whole log is read.
    let wrong = sim::log::At {
        crc: place.crc ^ 1,
        ..place
    };
    let (_, found) = Log::open_at(mem.clone(), 1, Some(wrong)).unwrap();
    assert_eq!((found.first, found.records.len()), (0, 101));
}

/// A2: 50 power cuts at random, with the writer running. Bytes after the last sync are dropped except a random
/// prefix (the last record cut at a random byte). Odd seeds cut a write part way; even seeds cut the power while a
/// sync is under way. After recovery no acknowledged
/// record is missing or changed, and the cut record, when there is one, is found exactly where it starts.
#[test]
fn a2_after_50_power_cuts_no_acknowledged_act_is_missing_and_every_cut_record_is_detected() {
    let (mut cut_records, mut clean) = (0, 0);
    for seed in 1..=50u64 {
        let mut r = Rng(seed);
        let mem = Mem::default();
        let (mut log, _) = Log::open(mem.clone(), 1).unwrap();
        let ticks = 20 + r.below(300);
        // Odd seeds cut a write part way; even ones cut the power while a sync is under way.
        let stall = 2 + r.below(10 + ticks / 8);
        if seed % 2 == 1 {
            mem.0.lock().unwrap().write_budget = Some(r.below(40_000) as usize);
        } else {
            mem.0.lock().unwrap().stall_sync = Some(stall);
        }
        let mut handed = 0;
        for i in 0..ticks {
            if log.append(payload(seed, i)).is_err() {
                break;
            }
            handed += 1;
            if seed % 2 == 1 && r.below(4) == 0 {
                let _ = log.wait_durable(1 + r.below(handed));
            }
        }
        if seed % 2 == 0 {
            while mem.0.lock().unwrap().syncs < stall && log.durable() < handed {
                std::thread::yield_now();
            }
        }
        let survived = {
            let mut disk = mem.0.lock().unwrap();
            let unsynced = (disk.bytes.len() - disk.durable) as u64;
            disk.power_cut(r.below(unsynced + 1) as usize)
        };
        let acked = log.durable();
        log.close();

        let found = recover(&survived).unwrap();
        assert!(
            found.records.len() as u64 >= acked,
            "seed {seed}: {acked} acknowledged, {} recovered",
            found.records.len()
        );
        for (i, rec) in found.records.iter().enumerate() {
            assert_eq!(
                rec,
                &payload(seed, i as u64),
                "seed {seed}: record {i} changed"
            );
        }
        let at = starts(seed, handed);
        let whole = at.iter().rposition(|&s| s <= survived.len()).unwrap();
        if at[whole] == survived.len() {
            assert_eq!(found.torn, None, "seed {seed}");
            clean += 1;
        } else {
            let torn = Torn {
                at: at[whole],
                dropped: survived.len() - at[whole],
            };
            assert_eq!(
                found.torn,
                Some(torn),
                "seed {seed}: the cut record is not detected"
            );
            cut_records += 1;
        }
        assert_eq!(found.records.len(), whole, "seed {seed}");
        // The log opens again over what survived, cut back to the last whole record.
        let (log, again) = Log::open(Mem::with(survived), 1).unwrap();
        assert_eq!(again.records.len(), whole);
        assert_eq!(log.durable(), whole as u64);
        println!(
            "power cut seed {seed}: {handed} handed, {acked} acknowledged, {whole} recovered, {}",
            found
                .torn
                .map_or("cut on a record's edge".into(), |t| format!(
                    "record {whole} cut at byte {} of {}, detected",
                    t.dropped,
                    HEAD_LEN + payload(seed, whole as u64).len()
                ))
        );
    }
    println!(
        "50 power cuts: {cut_records} cut a record (each detected), {clean} cut on a record's edge"
    );
}

fn eight_records() -> (Vec<u8>, Vec<usize>) {
    let mem = Mem::default();
    let (mut log, _) = Log::open(mem.clone(), 3).unwrap();
    // Each its own batch, so each is a batch's first record and damage before the last is told from a tear (rule 4).
    for i in 0..8 {
        log.append(payload(11, i)).unwrap();
        log.wait_durable(i + 1).unwrap();
    }
    log.close();
    let bytes = mem.0.lock().unwrap().bytes.clone();
    (bytes, starts(11, 8))
}

/// A3: every single-byte change in the header or in any record before the last is named as corruption, and opening
/// the log leaves its bytes exactly as they were. A record taken out of the middle is corruption too.
#[test]
fn a3_damage_before_the_tail_is_named_as_corruption_and_never_trimmed() {
    let (bytes, at) = eight_records();
    let last = at[7];
    let mut named = std::collections::BTreeMap::<&str, usize>::new();
    for i in 0..last {
        for flip in [0x01u8, 0x80] {
            let mut damaged = bytes.clone();
            damaged[i] ^= flip;
            let mem = Mem::with(damaged.clone());
            let err = Log::open(mem.clone(), 3)
                .err()
                .unwrap_or_else(|| panic!("byte {i} changed: opened without a word"));
            let want = if i < HEADER_LEN {
                "log-header-bad"
            } else {
                "log-corrupt"
            };
            assert_eq!(err.name, want, "byte {i}: {err}");
            assert_eq!(
                mem.0.lock().unwrap().bytes,
                damaged,
                "byte {i}: the log was trimmed"
            );
            *named.entry(err.name).or_default() += 1;
        }
    }
    // A record taken out of the middle: the next one checks but does not follow.
    let mut missing = bytes[..at[3]].to_vec();
    missing.extend_from_slice(&bytes[at[4]..]);
    let err = recover(&missing).unwrap_err();
    assert_eq!(err.name, "log-corrupt");
    println!("{named:?}; a missing record 3: {err}");
    // Damage in the last record is indistinguishable from a torn write, and is cut as one.
    let mut tail = bytes.clone();
    tail[last + HEAD_LEN] ^= 1;
    let found = recover(&tail).unwrap();
    assert_eq!(found.records.len(), 7);
    assert_eq!(found.torn.map(|t| t.at), Some(last));
}

/// A4: a sync fails. Nothing more is acknowledged, the writer never syncs that storage again, appends are refused by
/// name, and after a power cut every acknowledged record is there. The disk shows why: a retried sync would have
/// reported success without making anything durable.
#[test]
fn a4_after_a_failed_sync_nothing_more_is_acknowledged_and_the_sync_is_not_retried() {
    let mem = Mem::default();
    // Sync 1 is the new log's header; syncs 2 and 3 are the first two ticks; 4 fails.
    mem.0.lock().unwrap().fail_sync = Some(4);
    let (mut log, _) = Log::open(mem.clone(), 1).unwrap();
    for i in 0..2 {
        log.append(payload(5, i)).unwrap();
        log.wait_durable(i + 1).unwrap();
    }
    log.append(payload(5, 2)).unwrap();
    let err = log.wait_durable(3).unwrap_err();
    assert_eq!(err.name, "log-failed");
    assert!(err.detail.starts_with("sync-failed"), "{err}");
    assert_eq!(log.durable(), 2);
    let refused = log.append(payload(5, 3)).unwrap_err();
    assert_eq!(refused.name, "log-failed");
    assert_eq!(log.durable(), 2);
    assert_eq!(mem.0.lock().unwrap().syncs, 4, "the sync was retried");
    let mut storage = log.close();
    assert_eq!(mem.0.lock().unwrap().syncs, 4, "the sync was retried");
    // The trap a retry falls into: it reports success, and the bytes are still not durable.
    let durable = mem.0.lock().unwrap().durable;
    assert!(storage.sync().is_ok());
    assert_eq!(mem.0.lock().unwrap().durable, durable);
    let survived = mem.0.lock().unwrap().power_cut(usize::MAX);
    let found = recover(&survived).unwrap();
    assert_eq!(found.records, vec![payload(5, 0), payload(5, 1)]);
    println!("sync 4 failed: {err}; then {refused}; 4 syncs in all; recovered 2 of 2 acknowledged");
}

/// A file log: one exclusive lock, the epoch in its header, and its torn tail cut back on the disk.
#[test]
fn a_file_log_is_locked_holds_its_epoch_and_cuts_a_torn_tail() {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("k4-log-file");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("zone.log");
    let (mut log, _) = Log::open(FileStore::open(&path).unwrap(), 2).unwrap();
    assert_eq!(FileStore::open(&path).unwrap_err().name, "log-locked");
    for i in 0..10 {
        log.append(payload(9, i)).unwrap();
    }
    log.wait_durable(10).unwrap();
    let mut store = log.close();
    store.append(&[1, 2, 3, 4, 5]).unwrap();
    drop(store);
    assert_eq!(
        Log::open(FileStore::open(&path).unwrap(), 1)
            .err()
            .unwrap()
            .name,
        "epoch-stale"
    );
    assert_eq!(
        Log::open(FileStore::open(&path).unwrap(), 3)
            .err()
            .unwrap()
            .name,
        "epoch-other"
    );
    let (log, found) = Log::open(FileStore::open(&path).unwrap(), 2).unwrap();
    assert_eq!(found.records.len(), 10);
    assert_eq!(found.torn.map(|t| t.dropped), Some(5));
    drop(log);
    assert_eq!(std::fs::metadata(&path).unwrap().len() as usize, found.end);
}

/// #4973: writes into room already made reach the disk in any order of their pages until their sync returns. 200
/// power cuts during the last batch's sync: any of its 4 KiB pages lost (the room's zeros read in its place), and a
/// run of the room's zeros after it. Recovery never refuses, keeps every record synced before, and changes none.
/// A lost page followed by a later batch's first record is still corruption.
#[test]
fn i4973_a_batch_whose_later_pages_reached_the_disk_first_is_a_torn_tail() {
    const PAGE: usize = 4096;
    let big = |seed: u64, i: u64| {
        let mut r = Rng(seed ^ i.wrapping_mul(0x9E37_79B9));
        let len = 1 + r.below(3000) as usize;
        (0..len).map(|_| r.next() as u8).collect::<Vec<u8>>()
    };
    let (mut torn, mut whole_batches) = (0, 0);
    for seed in 1..=200u64 {
        let mut r = Rng(seed);
        let header = Header::new(1);
        let mut bytes = header.to_bytes().to_vec();
        let (mut prev, mut i) = (header.salt, 0u64);
        // Synced batches.
        for _ in 0..1 + r.below(6) {
            for k in 0..1 + r.below(5) {
                prev =
                    encode_in_batch(&mut bytes, header.salt, prev, &big(seed, i), k > 0).unwrap();
                i += 1;
            }
        }
        let (synced, durable) = (i, bytes.len());
        // The batch under way when the power went: some of its pages lost, the room's zeros after it.
        for k in 0..1 + r.below(12) {
            prev = encode_in_batch(&mut bytes, header.salt, prev, &big(seed, i), k > 0).unwrap();
            i += 1;
        }
        let first_page = durable / PAGE;
        let mut lost = false;
        for page in first_page..bytes.len().div_ceil(PAGE) {
            if r.below(2) == 0 {
                let from = (page * PAGE).max(durable);
                let to = ((page + 1) * PAGE).min(bytes.len());
                bytes[from..to].fill(0);
                lost = true;
            }
        }
        bytes.resize(bytes.len() + r.below(3 * PAGE as u64) as usize, 0);
        let found = recover(&bytes).unwrap_or_else(|e| panic!("seed {seed}: refused: {e}"));
        assert!(
            found.records.len() as u64 >= synced,
            "seed {seed}: {synced} synced, {} recovered",
            found.records.len()
        );
        for (k, rec) in found.records.iter().enumerate() {
            assert_eq!(rec, &big(seed, k as u64), "seed {seed}: record {k} changed");
        }
        if found.torn.is_some() {
            torn += 1;
        }
        if !lost {
            whole_batches += 1;
            assert_eq!(
                found.records.len() as u64,
                i,
                "seed {seed}: a whole batch is kept"
            );
        }
        let (_, again) = Log::open(Mem::with(bytes), 1).unwrap();
        assert_eq!(again.records.len(), found.records.len(), "seed {seed}");
    }
    println!(
        "200 power cuts during a batch's sync: {torn} cut a torn tail, {whole_batches} kept the whole batch"
    );

    // A lost page with a later batch's first record after it is damage, not a tear.
    let header = Header::new(1);
    let mut bytes = header.to_bytes().to_vec();
    let mut prev = header.salt;
    for b in 0..3 {
        for k in 0..2 {
            prev =
                encode_in_batch(&mut bytes, header.salt, prev, &big(9, b * 2 + k), k > 0).unwrap();
        }
    }
    bytes[HEADER_LEN + 100..HEADER_LEN + 200].fill(0);
    assert_eq!(recover(&bytes).unwrap_err().name, "log-corrupt");
}

/// #4973: a file log keeps room ahead of its end, zeros on the disk, and reads stop at the end. A process killed
/// leaves the room: it is a torn tail of zeros, cut on opening, every record kept. A clean close cuts the room off.
#[test]
fn i4973_a_file_log_keeps_room_ahead_a_kill_leaves_zeros_and_a_clean_close_cuts_them() {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("i4973-room");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("zone.log");
    let (mut log, _) = Log::open(FileStore::open(&path).unwrap(), 1).unwrap();
    for i in 0..200 {
        log.append(payload(4, i)).unwrap();
    }
    log.wait_durable(200).unwrap();
    let end = log.durable_at().offset;
    let len = std::fs::metadata(&path).unwrap().len();
    assert!(
        len >= end + RESERVE / 2,
        "room ahead: {len} long, the log ends at {end}"
    );
    // What a kill leaves on the disk: the file as it is now.
    let killed = dir.join("killed.log");
    std::fs::copy(&path, &killed).unwrap();
    let (log2, found) = Log::open(FileStore::open(&killed).unwrap(), 1).unwrap();
    assert_eq!(
        found.records,
        (0..200).map(|i| payload(4, i)).collect::<Vec<_>>()
    );
    assert_eq!(
        found.torn,
        Some(Torn {
            at: end as usize,
            dropped: (len - end) as usize
        })
    );
    drop(log2);
    // A clean close: the file ends where the log does, and reopens with no tail.
    let mut store = log.close();
    assert_eq!(
        store.read().unwrap().len() as u64,
        end,
        "reads stop at the end"
    );
    drop(store);
    assert_eq!(std::fs::metadata(&path).unwrap().len(), end);
    let (log, found) = Log::open(FileStore::open(&path).unwrap(), 1).unwrap();
    assert_eq!((found.records.len(), found.torn), (200, None));
    drop(log);
    // Without room every append grows the file, as before.
    let plain = dir.join("plain.log");
    let (mut log, _) = Log::open(FileStore::open_reserving(&plain, 0).unwrap(), 1).unwrap();
    log.append(payload(4, 0)).unwrap();
    log.wait_durable(1).unwrap();
    assert_eq!(
        std::fs::metadata(&plain).unwrap().len(),
        log.durable_at().offset
    );
}
