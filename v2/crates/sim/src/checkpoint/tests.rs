//! Checkpoints (K5, #2669). Each `aN_` test is one acceptance box; A1's and A5's timings are the `restart` bench
//! (`v2/tools/bench`). Run with `cargo test -p sim checkpoint -- --nocapture` to see what each saw.

use super::{Blobs, Checkpoints, replay, restore};
use crate::log::crc32c;
use replica::effects::{FIXTURE_HEADER, FIXTURES, Header, Part, Refusal, fixture_bytes};
use replica::encode::Name;
use replica::ids::{Scope, Version};
use replica::tree::Tree;
use std::fs;
use std::path::{Path, PathBuf};

fn header() -> Header {
    Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap()
}

fn part_bytes(name: &str) -> Vec<u8> {
    fixture_bytes(FIXTURES.iter().find(|(n, _)| *n == name).unwrap().1).unwrap()
}

fn root_kind(h: &Header) -> Name {
    h.kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .unwrap()
        .clone()
}

/// The tree after the base part and then `name` (the base alone for `0-base`).
fn tree(h: &Header, name: &str) -> Tree {
    let mut t = Tree::start(h.zone, root_kind(h));
    t.apply(h, &Part::read(&part_bytes("0-base")).unwrap())
        .unwrap();
    if name != "0-base" {
        t.apply(h, &Part::read(&part_bytes(name)).unwrap()).unwrap();
    }
    t
}

fn take(
    c: &mut Checkpoints,
    t: &mut Tree,
    h: &Header,
    record: u64,
    seed: &[u8],
) -> Result<(), Refusal> {
    let v = Version {
        lineage: Scope(h.lineage.0),
        zone: h.zone,
        epoch: 1,
        sequence: t.next(),
    };
    c.take(t, v, record, seed)
}

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("souls-k5-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
}

#[test]
fn a4_every_fixture_comes_back_with_its_state_and_its_state_hashes() {
    let h = header();
    for (name, _) in FIXTURES {
        let d = dir(&format!("a4-{name}"));
        let mut t = tree(&h, name);
        let mut c = Checkpoints::open(&d, 1, Blobs::default()).unwrap();
        take(&mut c, &mut t, &h, 2, b"seed").unwrap();
        c.wait().unwrap();
        let before = t.seal().unwrap().hashes();
        let mut r = restore(&d).unwrap().expect("a checkpoint");
        assert!(r.rejected.is_empty());
        assert_eq!(
            r.tree.to_state(),
            t.to_state(),
            "{name}: the state comes back"
        );
        let after = r.tree.seal().unwrap();
        assert!(
            after.nodes.is_empty(),
            "{name}: a restored tree has every hash"
        );
        assert_eq!(
            after.hashes(),
            before,
            "{name}: the state hashes, public and private apart"
        );
        assert_eq!((r.root.record, r.root.seed.as_slice()), (2, &b"seed"[..]));
        println!(
            "{name}: {} audiences, public state hash {}",
            before.len(),
            before.values().next().unwrap()
        );
        fs::remove_dir_all(&d).unwrap();
    }
}

#[test]
fn a_restart_replays_the_log_after_its_checkpoint() {
    let h = header();
    let d = dir("replay");
    let log = vec![part_bytes("0-base"), part_bytes("4-set")];
    let mut t = Tree::start(h.zone, root_kind(&h));
    replay(&mut t, &h, &log[..1], 0).unwrap();
    let mut c = Checkpoints::open(&d, 1, Blobs::default()).unwrap();
    take(&mut c, &mut t, &h, 1, b"").unwrap();
    c.wait().unwrap();
    replay(&mut t, &h, &log, 1).unwrap();
    let mut r = restore(&d).unwrap().unwrap();
    assert_eq!(replay(&mut r.tree, &h, &log, r.root.record).unwrap(), 1);
    assert_eq!(r.tree.to_state(), t.to_state());
    let hashes = t.seal().unwrap().hashes();
    assert_eq!(r.tree.seal().unwrap().hashes(), hashes);
    // Sealed a node at a time, the hashes are those of the same tree hashed whole.
    assert_eq!(tree(&h, "4-set").seal().unwrap().hashes(), hashes);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn a2_checkpoints_come_by_amount_of_log_and_a_still_hour_writes_nothing() {
    let h = header();
    let d = dir("a2");
    let mut t = tree(&h, "0-base");
    let mut c = Checkpoints::open(&d, 4096, Blobs::default()).unwrap();
    // An hour of ticks at 20 a second with nothing changing: nothing reaches the log, so nothing is due.
    for _ in 0..20 * 3600 {
        if c.due() {
            take(&mut c, &mut t, &h, 1, b"").unwrap();
        }
    }
    let s = c.wait().unwrap();
    let files = fs::read_dir(&d).unwrap().count();
    println!(
        "A2: a still hour (72,000 ticks): {} checkpoints, {} bytes, {files} files",
        s.taken, s.bytes
    );
    assert_eq!((s.taken, s.bytes, files), (0, 0, 0));
    // Log bytes, and only log bytes, bring one: 4,095 do not, 4,096 do.
    c.appended(4095);
    assert!(!c.due());
    c.appended(1);
    assert!(c.due());
    take(&mut c, &mut t, &h, 1, b"").unwrap();
    assert!(!c.due());
    assert!(c.wait().unwrap().bytes > 0);
    drop(c);
    fs::remove_dir_all(&d).unwrap();
}

/// Two checkpoints: record 1 after the base, record 2 after `4-set`. Returns the newer file's path.
fn two(d: &Path) -> PathBuf {
    let h = header();
    let mut t = tree(&h, "0-base");
    let mut c = Checkpoints::open(d, 1, Blobs::default()).unwrap();
    take(&mut c, &mut t, &h, 1, b"").unwrap();
    t.apply(&h, &Part::read(&part_bytes("4-set")).unwrap())
        .unwrap();
    take(&mut c, &mut t, &h, 2, b"").unwrap();
    c.wait().unwrap();
    d.join(format!("ckpt-{:020}", 2))
}

#[test]
fn a3_a_flipped_byte_is_rejected_by_name_and_the_one_before_is_used() {
    // A byte flipped anywhere: the file's checksum names it.
    let d = dir("a3-crc");
    let newer = two(&d);
    let mut b = fs::read(&newer).unwrap();
    let mid = b.len() / 2;
    b[mid] ^= 0x01;
    fs::write(&newer, &b).unwrap();
    let r = restore(&d).unwrap().unwrap();
    println!(
        "A3: flipped byte {mid} of 2: rejected {:?}; restored record {}",
        r.rejected, r.root.record
    );
    assert_eq!(r.rejected.len(), 1);
    assert_eq!(r.rejected[0].1.name, "checkpoint-crc");
    assert_eq!(r.root.record, 1);
    fs::remove_dir_all(&d).unwrap();

    // A byte flipped inside a record, the checksum made whole again: the record's hash names it.
    let d = dir("a3-hash");
    let newer = two(&d);
    let mut b = fs::read(&newer).unwrap();
    let end = b.len() - 4;
    b[end - 1] ^= 0x01; // the last byte of the last record held
    let sum = crc32c(0, &b[..end]).to_le_bytes();
    b[end..].copy_from_slice(&sum);
    fs::write(&newer, &b).unwrap();
    let r = restore(&d).unwrap().unwrap();
    println!(
        "A3: flipped inside a record of 2: rejected {:?}; restored record {}",
        r.rejected, r.root.record
    );
    assert_eq!(r.rejected.len(), 1);
    assert_eq!(r.rejected[0].1.name, "checkpoint-hash");
    assert_eq!(r.root.record, 1);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn the_last_two_are_kept() {
    let h = header();
    let d = dir("two");
    let mut t = tree(&h, "0-base");
    let mut c = Checkpoints::open(&d, 1, Blobs::default()).unwrap();
    for record in 1..=4 {
        take(&mut c, &mut t, &h, record, b"").unwrap();
    }
    c.wait().unwrap();
    let mut names: Vec<String> = fs::read_dir(&d)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [format!("ckpt-{:020}", 3), format!("ckpt-{:020}", 4)]
    );
    drop(c);
    fs::remove_dir_all(&d).unwrap();
}
