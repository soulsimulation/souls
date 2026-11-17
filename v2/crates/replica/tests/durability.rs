//! Durability twice, one writer by epoch, and the directory (Engine v2 T11, #2665; `v2/docs/durability.md`): against a
//! fake directory and fake stores, one of two writers writes, a paused writer is refused by the store, an effect that
//! cannot be undone waits for the off-machine mark, and the directory record changes only by conditional writes.

use replica::durability::{
    SoulRecord, Stakes, Store, When, WorldRecord, change, read_record, readable,
};
use replica::effects::fixture_bytes;
use replica::encode::Name;
use replica::ids::{Id, Scope};
use replica::intents::build_hash;

const RECORD: &str = include_str!("../fixtures/durability/record.diag");
const LEASE: u64 = 10_000_000;

fn zone() -> Id {
    Id::new(Scope([0xee; 16]), 0).expect("an id")
}

/// A directory holding one world that nobody runs yet: epoch 0.
fn directory() -> Store {
    let mut store = Store::default();
    let rec = WorldRecord {
        zone: zone(),
        runs_on: Name::new("souls:nobody").expect("a name"),
        epoch: 0,
        from: 0,
        mark: None,
        wake: None,
        build: build_hash(b"souls:build-1"),
    };
    store
        .put(
            &WorldRecord::key(zone()),
            rec.to_bytes().expect("bytes"),
            When::Absent,
        )
        .expect("created");
    store
}

fn writer(machine: &str) -> replica::durability::Writer {
    replica::durability::Writer::new(machine, zone(), LEASE)
}

#[test]
fn a1_of_two_writers_one_writes_and_the_store_refuses_the_other() {
    let mut store = directory();
    let (mut a, mut b) = (writer("souls:machine-a"), writer("souls:machine-b"));
    // Both start at once: both read the record before either writes.
    let read = read_record(&store, zone()).expect("a record");
    let ra = a.claim_from(&mut store, read.clone()).map_err(|r| r.name);
    let rb = b.claim_from(&mut store, read).map_err(|r| r.name);
    println!("machine a claims: {ra:?}; machine b claims: {rb:?}");
    assert_eq!(ra, Ok(1));
    assert_eq!(rb, Err("precondition-failed"));
    a.write(Stakes::Disk).expect("a writes");
    a.ship(&mut store).expect("a ships");
    // b ignores its own refusal and writes as if it held epoch 1: the store refuses it, not b's own check.
    b.epoch = Some(1);
    b.write(Stakes::Disk).expect("b's own disk takes it");
    let next = b.ship(&mut store).map_err(|r| (r.name, r.detail));
    println!("b writes anyway: {next:?}");
    assert_eq!(next.map_err(|r| r.0), Err("precondition-failed"));
    let (_, rec) = read_record(&store, zone()).expect("a record");
    assert_eq!(
        (rec.runs_on.as_str(), rec.epoch, rec.mark),
        ("souls:machine-a", 1, Some(0))
    );
}

#[test]
fn a2_a_writer_paused_past_its_lease_is_refused_by_the_store() {
    let mut store = directory();
    let (mut a, mut b) = (writer("souls:machine-a"), writer("souls:machine-b"));
    let mut line = Vec::new();
    a.claim(&mut store).expect("a claims");
    for _ in 0..3 {
        a.write(Stakes::Disk).expect("a writes");
    }
    a.ship(&mut store).expect("a ships");
    line.push(format!(
        "t0  a holds epoch 1, writes 0..=2, ships: mark 2, acknowledged {:?}",
        a.acknowledged
    ));
    a.elapse(LEASE + 1);
    line.push("t1  a pauses past its lease (measured on a's own clock)".to_owned());
    let e = b.claim(&mut store).expect("b claims");
    let (_, rec) = read_record(&store, zone()).expect("a record");
    line.push(format!(
        "t2  b claims: epoch {e}, from sequence {}",
        rec.from
    ));
    b.write(Stakes::Disk).expect("b writes");
    b.ship(&mut store).expect("b ships");
    line.push(format!(
        "t3  b writes 3, ships: mark {:?}",
        read_record(&store, zone()).unwrap().1.mark
    ));
    let s = a.write(Stakes::Disk).expect("a's own disk takes it");
    line.push(format!(
        "t4  a resumes, writes {s} to its own disk: acknowledged {:?} (its lease lapsed)",
        a.acknowledged
    ));
    let r = a.ship(&mut store).map_err(|r| r.name);
    line.push(format!("t5  a ships: {r:?}"));
    let (kept, ignored) = readable(&store, zone()).expect("parts");
    line.push(format!(
        "t6  a reader keeps {kept:?} and ignores {ignored:?}"
    ));
    for l in &line {
        println!("{l}");
    }
    assert_eq!(r, Err("precondition-failed"));
    assert!(!a.acknowledged.contains(&s));
    assert_eq!(ignored, vec![(1, 3, "superseded-epoch")]);
    assert!(kept.contains(&(2, 3)));
    let (_, rec) = read_record(&store, zone()).expect("a record");
    assert_eq!((rec.epoch, rec.mark), (2, Some(3)));
}

#[test]
fn a3_an_effect_that_cannot_be_undone_waits_for_the_off_machine_mark() {
    let mut store = directory();
    let mut a = writer("souls:machine-a");
    a.claim(&mut store).expect("a claims");
    let swap = a.write(Stakes::Disk).expect("a swap");
    let travel = a
        .write(Stakes::OffMachine)
        .expect("travel to another world");
    println!(
        "on the disk: acknowledged {:?}, waiting {:?}",
        a.acknowledged, a.waiting
    );
    assert!(a.acknowledged.contains(&swap));
    assert!(!a.acknowledged.contains(&travel));
    let mark = a.ship(&mut store).expect("shipped");
    println!(
        "off the machine (mark {mark}): acknowledged {:?}",
        a.acknowledged
    );
    assert!(a.acknowledged.contains(&travel));
}

#[test]
fn a4_the_directory_record_holds_its_fields_and_changes_only_by_conditional_writes() {
    let rec = WorldRecord::read(&fixture_bytes(RECORD).expect("bytes")).expect("a record");
    println!(
        "where {}, epoch {}, from {}, mark {:?}, wake {:?}, build {}",
        rec.runs_on.as_str(),
        rec.epoch,
        rec.from,
        rec.mark,
        rec.wake,
        replica::encode::to_hex(&rec.build)
    );
    assert_eq!(rec.runs_on.as_str(), "souls:machine-a");
    assert_eq!((rec.epoch, rec.wake), (4, Some(1_795_000_000_000_000)));
    assert_eq!(rec.build.len(), 34);
    assert_eq!(
        rec.to_bytes().expect("bytes"),
        fixture_bytes(RECORD).expect("bytes")
    );

    // Every field changes only by a write conditional on the version read: a claim and a build change race, and the
    // store lets one through; the loser reads again.
    let mut store = directory();
    let (v, now) = read_record(&store, zone()).expect("a record");
    let mut pinned = now.clone();
    pinned.build = build_hash(b"souls:build-2");
    let mut woken = now.clone();
    woken.wake = Some(1_795_000_000_000_000);
    let first = change(&mut store, zone(), v, &pinned).map(|_| "ok");
    let second = change(&mut store, zone(), v, &woken).map_err(|r| r.name);
    println!("pin a build: {first:?}; set a wake on the same read: {second:?}");
    assert_eq!(second, Err("precondition-failed"));
    let (v2, now) = read_record(&store, zone()).expect("a record");
    assert_eq!(now.build, build_hash(b"souls:build-2"));
    let mut woken = now;
    woken.wake = Some(1);
    assert!(change(&mut store, zone(), v2, &woken).is_ok());
    // A record cannot be created twice.
    let again = store
        .put(&WorldRecord::key(zone()), vec![0xa0], When::Absent)
        .map_err(|r| r.name);
    assert_eq!(again, Err("precondition-failed"));
    // Where each Soul is: a small record of its own.
    let soul = SoulRecord {
        soul: Id::new(Scope([0xdd; 16]), 100).expect("an id"),
        lineage: vec![0xee; 16],
        zone: zone(),
    };
    assert!(soul.to_bytes().is_ok());
}
