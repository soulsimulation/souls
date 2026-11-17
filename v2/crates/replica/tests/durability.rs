//! Durability twice, one writer by epoch, and the directory (Engine v2 T11, #2665; `v2/docs/durability.md`): against a
//! fake directory and fake stores, one of two writers writes (on two machines or on one), a paused writer is refused
//! by the store, an effect that cannot be undone waits for the off-machine mark, and the directory record changes only
//! by conditional writes.

use replica::durability::{
    Readable, SoulRecord, Stakes, Store, Takeover, Token, When, WorldRecord, Writer, change,
    part_key, read_record, readable,
};
use replica::effects::fixture_bytes;
use replica::encode::Name;
use replica::ids::{Id, Scope};
use replica::intents::build_hash;

const RECORD: &str = include_str!("../fixtures/durability/record.diag");
const LEASE: u64 = 10_000_000;
const WORLD: [u8; 16] = [0xee; 16];

fn zone() -> Id {
    Id::new(Scope([0xee; 16]), 0).expect("an id")
}

/// A directory holding one world of `lineage` that nobody has claimed.
fn directory(store: &mut Store, lineage: [u8; 16]) {
    let rec = WorldRecord {
        lineage,
        zone: zone(),
        takeovers: Vec::new(),
        mark: None,
        wake: None,
        build: build_hash(b"souls:build-1"),
        writes: 0,
    };
    store
        .put(
            &WorldRecord::key(&lineage, zone()),
            rec.to_bytes().expect("bytes"),
            When::Absent,
        )
        .expect("created");
}

fn world() -> Store {
    let mut s = Store::default();
    directory(&mut s, WORLD);
    s
}

fn writer(machine: &str) -> Writer {
    Writer::new(machine, WORLD, zone(), LEASE)
}

fn record(store: &Store) -> WorldRecord {
    read_record(store, &WORLD, zone()).expect("a record").1
}

fn parts(store: &Store) -> Readable {
    readable(store, &WORLD, zone()).expect("parts")
}

#[test]
fn a1_of_two_writers_one_writes_and_the_store_refuses_the_other() {
    // On two machines, and as two processes on one machine: a claim is its token, not its machine.
    for (ma, mb) in [
        ("souls:machine-a", "souls:machine-b"),
        ("souls:machine-a", "souls:machine-a"),
    ] {
        let mut store = world();
        let (mut a, mut b) = (writer(ma), writer(mb));
        // Both start at once: both read the record before either writes.
        let read = read_record(&store, &WORLD, zone()).expect("a record");
        let ra = a.claim_from(&mut store, read.clone()).map_err(|r| r.name);
        let rb = b.claim_from(&mut store, read).map_err(|r| r.name);
        println!("{ma} claims: {ra:?}; {mb} claims: {rb:?}");
        assert_eq!(ra, Ok(1));
        assert_eq!(rb, Err("precondition-failed"));
        // b ignores its own refusal and ships travel first, as if it held epoch 1 under the token it drew.
        b.claim = Some(Takeover {
            epoch: 1,
            from: 0,
            machine: b.machine.clone(),
            token: Token::draw().expect("a token"),
        });
        b.next = 0;
        let lost = b.write(Stakes::OffMachine).expect("b's own disk takes it");
        let next = b.ship(&mut store).map_err(|r| r.name);
        println!(
            "  b ships anyway, first: {next:?}; b acknowledged travel: {}",
            b.acknowledged.contains(&lost)
        );
        assert_eq!(next, Err("precondition-failed"));
        assert!(!b.acknowledged.contains(&lost));
        // a then writes travel at the same sequence and ships under its own claim's token: acknowledged.
        let travel = a.write(Stakes::OffMachine).expect("travel");
        let shipped = a.ship(&mut store).map_err(|r| r.name);
        println!("  a ships: {shipped:?}; acknowledged {:?}", a.acknowledged);
        assert_eq!(shipped, Ok(Some(0)));
        assert!(a.acknowledged.contains(&travel));
        let r = parts(&store);
        println!("  a reader keeps {:?} and ignores {:?}", r.kept, r.ignored);
        assert_eq!(r.kept, vec![(1, 0)]);
        assert_eq!(r.ignored, vec![(1, 0, "superseded-epoch")]);
        assert!(r.unreadable.is_empty());
        assert_eq!(record(&store).current(), a.claim.as_ref());
    }
}

#[test]
fn a_heartbeat_changes_the_records_bytes() {
    // A real store's version is a hash of the bytes: a heartbeat that wrote back what it read would look, to a
    // machine waiting to claim, like a writer that stopped.
    let mut store = world();
    let mut a = writer("souls:machine-a");
    a.claim(&mut store).expect("a claims");
    a.write(Stakes::Disk).expect("0");
    a.ship(&mut store).expect("a ships");
    let key = WorldRecord::key(&WORLD, zone());
    let before = store.get(&key).expect("a record").1;
    a.elapse(LEASE - 1);
    let beat = a.ship(&mut store).map_err(|r| r.name);
    let after = store.get(&key).expect("a record").1;
    println!(
        "heartbeat: {beat:?}; writes {} -> {}",
        WorldRecord::read(&before).expect("a record").writes,
        record(&store).writes
    );
    assert_eq!(beat, Ok(Some(0)));
    assert_ne!(before, after);
}

#[test]
fn a_machine_name_with_a_slash_keeps_its_parts_readable() {
    let mut store = world();
    let mut a = writer("souls:rack/7");
    a.claim(&mut store).expect("a claims");
    for _ in 0..3 {
        a.write(Stakes::Disk).expect("a writes");
    }
    let shipped = a.ship(&mut store).map_err(|r| r.name);
    // A key under the zone's prefix that is not a part's name is named, not skipped.
    let token = a.claim.as_ref().expect("a claim").token.hex();
    let stray = part_key(&WORLD, zone(), a.claim.as_ref().expect("a claim"), 9)
        .replace(&token, "not-a-token");
    store
        .put(&stray, vec![0xa0], When::Absent)
        .expect("a stray key");
    let r = parts(&store);
    println!(
        "souls:rack/7 ships {shipped:?}; a reader keeps {:?}, ignores {:?}, cannot read {:?}",
        r.kept, r.ignored, r.unreadable
    );
    assert_eq!(shipped, Ok(Some(2)));
    assert_eq!(r.kept, vec![(1, 0), (1, 1), (1, 2)]);
    assert!(r.ignored.is_empty());
    assert_eq!(r.unreadable, vec![stray]);
}

#[test]
fn a_part_name_under_ones_own_token_is_a_retry_and_any_other_stops_the_ship() {
    let mut store = world();
    let mut a = writer("souls:machine-a");
    a.claim(&mut store).expect("a claims");
    a.write(Stakes::Disk).expect("0");
    a.ship(&mut store).expect("a ships 0");
    // a ships again: every part of its claim is sent again, and the one already there (0) is its own, retried.
    a.write(Stakes::Disk).expect("1");
    let retried = a.ship(&mut store).map_err(|r| r.name);
    // A name under a's token holding other bytes is not a's: the ship stops.
    a.write(Stakes::Disk).expect("2");
    let claim = a.claim.clone().expect("a claim");
    let taken = part_key(&WORLD, zone(), &claim, 2);
    store
        .put(&taken, vec![0xa0], When::Absent)
        .expect("planted");
    let stopped = a.ship(&mut store).map_err(|r| r.name);
    println!("ship again over its own parts: {retried:?}; over another's bytes: {stopped:?}");
    assert_eq!(retried, Ok(Some(1)));
    assert_eq!(stopped, Err("part-exists"));
    assert_eq!(record(&store).mark, Some(1));
}

#[test]
fn a2_a_writer_paused_past_its_lease_is_refused_by_the_store() {
    let mut store = world();
    let (mut a, mut b, mut c) = (
        writer("souls:machine-a"),
        writer("souls:machine-b"),
        writer("souls:machine-c"),
    );
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
    line.push(format!(
        "t2  b claims: epoch {e}, from sequence {}",
        record(&store).current().unwrap().from
    ));
    b.write(Stakes::Disk).expect("b writes");
    b.ship(&mut store).expect("b ships");
    line.push(format!(
        "t3  b writes 3, ships: mark {:?}",
        record(&store).mark
    ));
    let s = a.write(Stakes::Disk).expect("a's own disk takes it");
    line.push(format!(
        "t4  a resumes, writes {s} to its own disk: acknowledged {:?} (its lease lapsed)",
        a.acknowledged
    ));
    let r = a.ship(&mut store).map_err(|r| r.name);
    line.push(format!("t5  a ships: {r:?}"));
    let Readable { kept, ignored, .. } = parts(&store);
    line.push(format!(
        "t6  a reader keeps {kept:?} and ignores {ignored:?}"
    ));
    c.claim(&mut store).expect("c claims");
    let Readable {
        kept: kept3,
        ignored: ignored3,
        ..
    } = parts(&store);
    line.push(format!(
        "t7  c claims epoch 3; a reader still keeps {kept3:?} and ignores {ignored3:?}"
    ));
    for l in &line {
        println!("{l}");
    }
    assert_eq!(r, Err("precondition-failed"));
    assert!(!a.acknowledged.contains(&s));
    assert_eq!(ignored, vec![(1, 3, "superseded-epoch")]);
    assert!(kept.contains(&(2, 3)));
    assert_eq!(
        (kept3, ignored3),
        (kept, ignored),
        "a third epoch changes nothing already read"
    );
    assert_eq!(record(&store).mark, Some(3));
}

#[test]
fn a3_an_effect_that_cannot_be_undone_waits_for_the_off_machine_mark() {
    let mut store = world();
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
    // A build pinned between ships does not strand the writer: it reads again and the mark moves.
    let (v, mut rec) = read_record(&store, &WORLD, zone()).expect("a record");
    rec.build = build_hash(b"souls:build-2");
    change(&mut store, v, &rec).expect("the build is pinned");
    let mark = a.ship(&mut store).expect("shipped");
    println!(
        "off the machine (mark {mark:?}): acknowledged {:?}",
        a.acknowledged
    );
    assert!(a.acknowledged.contains(&travel));
}

#[test]
fn a_machine_that_claims_again_keeps_no_entry_past_its_takeover() {
    let mut store = world();
    let mut a = writer("souls:machine-a");
    a.claim(&mut store).expect("a claims");
    for _ in 0..3 {
        a.write(Stakes::Disk).expect("a writes");
    }
    a.ship(&mut store).expect("a ships");
    a.write(Stakes::Disk).expect("3, not shipped");
    a.write(Stakes::Disk).expect("4, not shipped");
    a.claim(&mut store).expect("a claims again, from 3");
    a.write(Stakes::Disk).expect("a writes 3 again");
    a.ship(&mut store).expect("a ships");
    let Readable { kept, ignored, .. } = parts(&store);
    println!("after claiming again: keeps {kept:?}, ignores {ignored:?}");
    assert_eq!(kept, vec![(1, 0), (1, 1), (1, 2), (2, 3)]);
    assert!(ignored.is_empty());
}

#[test]
fn a4_the_directory_record_holds_its_fields_and_changes_only_by_conditional_writes() {
    let rec = WorldRecord::read(&fixture_bytes(RECORD).expect("bytes")).expect("a record");
    let t = rec.current().expect("a claim");
    println!(
        "where {}, epoch {}, takeovers {}, mark {:?}, wake {:?}, build {}",
        t.machine.as_str(),
        t.epoch,
        rec.takeovers.len(),
        rec.mark,
        rec.wake,
        replica::encode::to_hex(&rec.build)
    );
    assert_eq!(
        (t.machine.as_str(), t.epoch, t.from),
        ("souls:machine-a", 4, 1200)
    );
    assert_eq!(rec.wake, Some(1_795_000_000_000_000));
    assert_eq!(rec.build.len(), 34);
    assert_eq!(rec.in_force(500).map(|t| t.epoch), Some(2));
    assert_eq!(
        rec.to_bytes().expect("bytes"),
        fixture_bytes(RECORD).expect("bytes")
    );

    // Every field changes only by a write conditional on the version read: a build change and a wake race on one
    // read, and the store lets one through; the loser reads again.
    let mut store = world();
    let (v, now) = read_record(&store, &WORLD, zone()).expect("a record");
    let mut pinned = now.clone();
    pinned.build = build_hash(b"souls:build-2");
    let mut woken = now;
    woken.wake = Some(1_795_000_000_000_000);
    let first = change(&mut store, v, &pinned).map(|_| "ok");
    let second = change(&mut store, v, &woken).map_err(|r| r.name);
    println!("pin a build: {first:?}; set a wake on the same read: {second:?}");
    assert_eq!(second, Err("precondition-failed"));
    let (v2, mut now) = read_record(&store, &WORLD, zone()).expect("a record");
    assert_eq!(now.build, build_hash(b"souls:build-2"));
    now.wake = Some(1);
    assert!(change(&mut store, v2, &now).is_ok());
    // A record is created once; a fork's record, of its own lineage, sits beside its parent's.
    let again = store
        .put(&WorldRecord::key(&WORLD, zone()), vec![0xa0], When::Absent)
        .map_err(|r| r.name);
    assert_eq!(again, Err("precondition-failed"));
    directory(&mut store, [0xaa; 16]);
    assert!(read_record(&store, &[0xaa; 16], zone()).is_ok());
    // Where each Soul is: a small record of its own.
    let soul = SoulRecord {
        soul: Id::new(Scope([0xdd; 16]), 100).expect("an id"),
        lineage: WORLD.to_vec(),
        zone: zone(),
    };
    assert!(soul.to_bytes().is_ok());
    let _ = Name::new("souls:unused");
}
