//! The shipper on a fake clock and the in-memory store (O3, #2732).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use directoryd::directory::Directory;
use directoryd::directory::store::Memory;
use replica::encode::Name;
use replica::ids::{Id, Scope};

use super::*;

#[derive(Clone, Default)]
struct Fake(Arc<AtomicU64>);

impl Fake {
    fn advance(&self, us: u64) {
        self.0.fetch_add(us, Ordering::SeqCst);
    }
}

impl Clock for Fake {
    fn now_us(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

const LINEAGE: [u8; 16] = [0x11; 16];

fn zone() -> Id {
    Id::new(Scope([0x22; 16]), 1).expect("an id")
}

fn shipper(store: &Memory, clock: Fake) -> Shipper<&Memory, Fake> {
    let mut dir = Directory::new(store, Name::new("machine-a").expect("a name"));
    dir.set_build(&LINEAGE, zone(), &[0x12; 34]).expect("pins");
    let claim = dir.claim(&LINEAGE, zone()).expect("claims");
    Shipper::open(dir, claim, LINEAGE, zone(), b"header", 0, clock).expect("opens")
}

fn item(record: u64, stakes: bool) -> Item {
    Item {
        record,
        bytes: record.to_le_bytes().to_vec(),
        acts: 2,
        stakes,
    }
}

/// A world that acts every 50 ms tick: a piece about every 10 s, none holding an act older than 10 s when it lands,
/// and the rebuild's fetch reads every record back in order.
#[test]
fn a1_pieces_land_inside_the_loss_bar() {
    let store = Memory::default();
    let clock = Fake::default();
    let mut s = shipper(&store, clock.clone());
    let mark = s.mark();
    let mut acked: Vec<(u64, u64)> = Vec::new();
    let mut worst = 0;
    for n in 0..1_200u64 {
        s.push(item(n, false)).expect("pushes");
        acked.push((n, clock.now_us()));
        let before = mark.landed();
        s.poll().expect("polls");
        for &(r, t) in &acked[before as usize..mark.landed() as usize] {
            assert!(r < mark.landed());
            worst = worst.max(clock.now_us() - t);
        }
        clock.advance(50_000);
    }
    assert!(worst <= LOSS_BAR_US, "an act {worst} µs old when it landed");
    let up = mark.uploads();
    assert!((6..=7).contains(&up.pieces), "{up:?}");
    assert_eq!(up.marks, 0, "no act with stakes, no directory write");
    let f = fetch(&store, &LINEAGE, zone()).expect("fetches");
    let got: Vec<Vec<u8>> = f.pieces.iter().flat_map(|p| p.records.clone()).collect();
    assert_eq!(got.len() as u64, mark.landed());
    assert!(
        got.iter()
            .enumerate()
            .all(|(i, b)| *b == (i as u64).to_le_bytes())
    );
    assert!(mark.gauges().unshipped_us < LOSS_BAR_US);
}

/// An act that cannot be undone seals its piece at the next poll and moves the directory's mark before it is
/// released.
#[test]
fn a2_stakes_wait_for_the_directory_mark() {
    let store = Memory::default();
    let clock = Fake::default();
    let mut s = shipper(&store, clock.clone());
    let mark = s.mark();
    s.push(item(0, false)).expect("pushes");
    s.push(item(1, true)).expect("pushes");
    assert_eq!(mark.recorded(), 0);
    s.poll().expect("polls");
    assert_eq!((mark.landed(), mark.recorded()), (2, 2));
    let f = fetch(&store, &LINEAGE, zone()).expect("fetches");
    assert_eq!(f.record.mark, Some(1));
    assert_eq!(mark.uploads().marks, 1);
}

/// A rebuild fetches the one newest checkpoint and only the pieces from the one the log resumes in.
#[test]
fn a3_one_checkpoint_and_the_pieces_after_it() {
    let dir = std::env::temp_dir().join(format!("o3-ckpt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a folder");
    let store = Memory::default();
    let clock = Fake::default();
    let mut s = shipper(&store, clock.clone()).checkpoints(&dir, 0);
    for n in 0..30u64 {
        s.push(item(n, false)).expect("pushes");
        if n % 10 == 9 {
            clock.advance(LOSS_BAR_US);
            s.poll().expect("polls");
        }
        if n == 14 {
            std::fs::write(dir.join(format!("ckpt-{:020}", 15)), b"checkpoint 15").expect("writes");
        }
    }
    let f = fetch(&store, &LINEAGE, zone()).expect("fetches");
    let (record, bytes) = f.checkpoint.expect("a checkpoint");
    assert_eq!((record, bytes.as_slice()), (15, &b"checkpoint 15"[..]));
    let firsts: Vec<u64> = f.pieces.iter().map(|p| p.first).collect();
    assert_eq!(
        firsts,
        vec![10, 20],
        "the piece holding record 15, then the next"
    );
    assert_eq!(s.mark().uploads().checkpoints, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A still world (no new records, no new checkpoint) uploads nothing for ten minutes.
#[test]
fn a4_a_still_world_uploads_nothing() {
    let dir = std::env::temp_dir().join(format!("o3-still-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a folder");
    let store = Memory::default();
    let clock = Fake::default();
    let mut s = shipper(&store, clock.clone()).checkpoints(&dir, 0);
    s.push(item(0, false)).expect("pushes");
    std::fs::write(dir.join(format!("ckpt-{:020}", 1)), b"checkpoint 1").expect("writes");
    s.flush().expect("flushes");
    let before = s.mark().uploads();
    let keys = store.keys().len();
    for _ in 0..12_000 {
        clock.advance(50_000);
        s.poll().expect("polls");
    }
    assert_eq!(s.mark().uploads(), before, "ten minutes, nothing new");
    assert_eq!(store.keys().len(), keys);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The records from 0 as a full-history reader reads them, each with its number.
fn from_zero(store: &Memory) -> Vec<(u64, Vec<u8>)> {
    let key = WorldRecord::key(&LINEAGE, zone());
    let rec = WorldRecord::read(&store.get(&key).expect("reads").expect("a record").bytes)
        .expect("a record");
    let (mut at, mut out) = (0, Vec::new());
    while let Some((_, p, _)) = piece_at(store, &rec, at).expect("a piece") {
        for r in p.records {
            out.push((at, r));
            at += 1;
        }
    }
    out
}

/// O3b (#3458) A4: the directory's mark moves with the checkpoint pointer, and a restore that died before its first
/// upload leaves a claim the next restore reads past: no record past the mark is lost, and the history read from
/// record 0 holds every record once, in order.
#[test]
fn o3b_a4_mark_follows_the_pointer_and_an_empty_claim_loses_nothing() {
    let dir = std::env::temp_dir().join(format!("o3b-a4-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a folder");
    let store = Memory::default();
    let clock = Fake::default();
    let mut a = shipper(&store, clock.clone()).checkpoints(&dir, 0);
    for n in 0..30u64 {
        a.push(item(n, false)).expect("pushes");
        if n % 10 == 9 {
            clock.advance(LOSS_BAR_US);
            a.poll().expect("polls");
        }
        if n == 14 {
            std::fs::write(dir.join(format!("ckpt-{:020}", 15)), b"checkpoint 15").expect("writes");
        }
    }
    // The pointer moved once (checkpoint 15, after the piece at 10 landed): the mark is the last record landed then.
    let f = fetch(&store, &LINEAGE, zone()).expect("fetches");
    assert_eq!(f.record.mark, Some(19), "the mark follows the pointer");
    assert_eq!(a.mark().recorded(), 20);
    // A restore claims and dies before its first upload: a claim from 20 with no piece.
    let mut b = Directory::new(&store, Name::new("machine-b").expect("a name"));
    assert_eq!(b.claim(&LINEAGE, zone()).expect("claims").takeover.from, 20);
    // The next restore still reads the lost writer's pieces past the mark.
    let f = fetch(&store, &LINEAGE, zone()).expect("fetches");
    let got: Vec<u64> = f.pieces.iter().map(|p| p.first).collect();
    assert_eq!(got, vec![10, 20], "the pieces past the mark are read");
    let mut c = Directory::new(&store, Name::new("machine-c").expect("a name"));
    let claim = c.claim(&LINEAGE, zone()).expect("claims");
    assert_eq!(claim.takeover.from, 20);
    let mut s =
        Shipper::open(c, claim, LINEAGE, zone(), b"header", 20, clock.clone()).expect("opens");
    for p in &f.pieces {
        for (i, r) in p.records.iter().enumerate() {
            let record = p.first + i as u64;
            s.push(Item {
                record,
                bytes: r.clone(),
                acts: 2,
                stakes: false,
            })
            .expect("pushes");
        }
    }
    s.flush().expect("flushes");
    let all = from_zero(&store);
    assert_eq!(all.len(), 30, "every record from 0");
    for (n, (at, r)) in all.iter().enumerate() {
        assert_eq!(
            (*at, r.as_slice()),
            (n as u64, &item(n as u64, false).bytes[..])
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A piece is read back only when its checksum holds.
#[test]
fn a_piece_checks_its_bytes() {
    let p = Piece {
        header: b"h".to_vec(),
        first: 7,
        records: vec![vec![1, 2], vec![3]],
    };
    let mut b = p.to_bytes().expect("bytes");
    assert_eq!(Piece::read(&b).expect("reads"), p);
    b[3] ^= 1;
    assert_eq!(Piece::read(&b).map_err(|e| e.name), Err("piece-bad"));
}
