//! The directory (Engine v2 W8, #2729): its records (A1), two claims of one world (A2), a paused writer (A3), the
//! store out of reach (A4) and the truth in the store alone (A5). `cargo test -p directoryd --test directory`.
//!
//! A2 and A3 also run against a real S3-compatible store, the one the environment names (`DIRECTORY_STORE_*`, see
//! `directoryd::directory::s3::ENV`): `cargo test -p directoryd --test directory -- --ignored --nocapture`.

use std::sync::Barrier;
use std::sync::atomic::{AtomicBool, Ordering};

use directoryd::directory::s3::S3;
use directoryd::directory::store::{Memory, Object, R, Store, When};
use directoryd::directory::{Claim, Directory};
use replica::directory::{Place, SoulRecord, Token, WorldRecord};
use replica::encode::Name;
use replica::ids::{Id, Scope};
use replica::intents::build_hash;
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use sim::clock::{Fake, Heartbeat, Ticker};

fn zone() -> Id {
    Id::new(Scope([0xee; 16]), 0).expect("an id")
}

fn name(n: &str) -> Name {
    Name::new(n).expect("a name")
}

/// A fresh lineage, so runs against a real store never meet an earlier run's records.
fn lineage() -> [u8; 16] {
    Token::draw().expect("random").0
}

fn dir<S: Store>(store: S, machine: &str) -> Directory<S> {
    Directory::new(store, name(machine))
}

/// A world whose build is pinned and that nobody has claimed yet.
fn world<S: Store>(store: S, lineage: &[u8; 16]) {
    dir(store, "souls:pinner")
        .set_build(lineage, zone(), &build_hash(b"souls:build-1"))
        .expect("the first pin creates the record");
}

fn refusal<T: std::fmt::Debug>(r: R<T>) -> &'static str {
    r.expect_err("refused").name
}

/// A store that holds each machine's first write until both machines have read, so two claims read the same
/// version and race to write it.
struct Gate<'a, S: Store> {
    store: &'a S,
    both_read: &'a Barrier,
    held: AtomicBool,
}

impl<S: Store> Store for Gate<'_, S> {
    fn get(&self, key: &str) -> R<Option<Object>> {
        self.store.get(key)
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        if !self.held.swap(true, Ordering::SeqCst) {
            self.both_read.wait();
        }
        self.store.put(key, bytes, when)
    }
}

/// A2 on `store`: two machines claim one world at once. Exactly one is refused, `claimed-by-another`, and the record
/// holds the other's claim, epoch 1.
fn two_claims_one_refused<S: Store + Sync>(store: &S) {
    let lineage = lineage();
    world(store, &lineage);
    let both_read = Barrier::new(2);
    let results: Vec<R<Claim>> = std::thread::scope(|s| {
        let racers: Vec<_> = ["souls:machine-a", "souls:machine-b"]
            .into_iter()
            .map(|m| {
                let gate = Gate {
                    store,
                    both_read: &both_read,
                    held: AtomicBool::new(false),
                };
                s.spawn(move || dir(gate, m).claim(&lineage, zone()))
            })
            .collect();
        racers
            .into_iter()
            .map(|r| r.join().expect("no panic"))
            .collect()
    });
    let won: Vec<&Claim> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
    let refused: Vec<&str> = results
        .iter()
        .filter_map(|r| r.as_ref().err().map(|e| e.name))
        .collect();
    assert_eq!(won.len(), 1, "exactly one claim wins: {results:?}");
    assert_eq!(refused, ["claimed-by-another"]);
    let rec = dir(store, "souls:reader")
        .world(&lineage, zone())
        .expect("a record");
    let t = rec.current().expect("a claim in force");
    assert_eq!((t.epoch, t.token), (1, won[0].takeover.token));
    println!(
        "a2: two claims of one world: {} won epoch 1, the other refused {:?}",
        t.machine.as_str(),
        refused[0]
    );
}

/// A3 on `store`: a writer that paused while another claimed is refused at its next durable write, `claim-taken`,
/// and the record keeps the new claim and the mark it left; the new writer's ship then succeeds, after an alarm was
/// set between its claim and its ship.
fn a_paused_writer_is_refused<S: Store>(store: &S) {
    let lineage = lineage();
    world(store, &lineage);
    let mut a = dir(store, "souls:machine-a");
    let mut b = dir(store, "souls:machine-b");
    let mut ca = a.claim(&lineage, zone()).expect("a claims");
    a.ship(&mut ca, 2).expect("a ships 0 to 2");
    // a pauses; b claims from the mark plus one.
    let mut cb = b.claim(&lineage, zone()).expect("b claims");
    assert_eq!((cb.takeover.epoch, cb.takeover.from), (2, 3));
    // a resumes and ships what it wrote meanwhile.
    assert_eq!(refusal(a.ship(&mut ca, 5)), "claim-taken");
    let rec = b.world(&lineage, zone()).expect("a record");
    assert_eq!(rec.current().map(|t| t.token), Some(cb.takeover.token));
    assert_eq!(rec.mark, Some(2));
    b.set_alarm(&lineage, zone(), Some(1_763_500_000_000_000))
        .expect("an alarm");
    b.ship(&mut cb, 3)
        .expect("b ships 3 on the record's new version");
    let rec = b.world(&lineage, zone()).expect("a record");
    assert_eq!(
        (rec.mark, rec.wake, rec.takeovers.len()),
        (Some(3), Some(1_763_500_000_000_000), 2)
    );
    // And again: a is still refused, by the store's condition first, then by the token.
    assert_eq!(refusal(a.ship(&mut ca, 6)), "claim-taken");
    println!("a3: the paused writer of epoch 1 was refused claim-taken; epoch 2 shipped mark 3");
}

/// A1: a world's record carries where it runs, its epoch, when it must wake and its pinned build; a Soul's names
/// the one world it is in, or a transfer in transit, and moves only from where it is.
#[test]
fn a1_the_records_carry_their_fields() {
    let store = Memory::default();
    let (w1, w2) = (lineage(), lineage());
    let mut d = dir(&store, "souls:machine-a");
    d.set_build(&w1, zone(), &build_hash(b"souls:build-1"))
        .expect("pinned");
    let c = d.claim(&w1, zone()).expect("claimed");
    d.set_alarm(&w1, zone(), Some(1_763_500_000_000_000))
        .expect("an alarm");
    d.set_build(&w1, zone(), &build_hash(b"souls:build-2"))
        .expect("pinned again");
    let rec = d.world(&w1, zone()).expect("a record");
    let t = rec.current().expect("a claim");
    assert_eq!(t.machine.as_str(), "souls:machine-a", "where it runs");
    assert_eq!((t.epoch, t.token), (1, c.takeover.token), "its epoch");
    assert_eq!(rec.wake, Some(1_763_500_000_000_000), "when it must wake");
    assert_eq!(rec.build, build_hash(b"souls:build-2"), "its pinned build");
    assert_eq!(rec.writes, 3, "created, then three writes");
    d.set_alarm(&w1, zone(), None).expect("awake");
    assert_eq!(d.world(&w1, zone()).expect("a record").wake, None);

    let soul = Id::new(Scope([0x50; 16]), 7).expect("an id");
    let in_w1 = Place::World {
        lineage: w1,
        zone: zone(),
    };
    let moving = Place::Transit {
        transfer: [0x7a; 16],
    };
    let in_w2 = Place::World {
        lineage: w2,
        zone: zone(),
    };
    d.set_place(soul, None, in_w1.clone()).expect("placed");
    assert_eq!(
        refusal(d.set_place(soul, None, in_w2.clone())),
        "soul-moved"
    );
    d.set_place(soul, Some(&in_w1), moving.clone())
        .expect("in transit");
    assert_eq!(
        d.soul(soul).expect("read").map(|r| r.place),
        Some(moving.clone())
    );
    // A second move out of w1 (a second transfer of one Soul) is refused: it is no longer there.
    assert_eq!(
        refusal(d.set_place(soul, Some(&in_w1), in_w2.clone())),
        "soul-moved"
    );
    d.set_place(soul, Some(&moving), in_w2.clone())
        .expect("arrived");
    let rec = d.soul(soul).expect("read").expect("a record");
    assert_eq!((rec.place, rec.writes), (in_w2, 2));
    // Back where it was: other bytes, so another ETag (rule 10).
    let again = SoulRecord {
        soul,
        place: in_w1,
        writes: 3,
    };
    assert_eq!(
        SoulRecord::read(&again.to_bytes().expect("bytes")).expect("read"),
        again
    );
    assert_eq!(
        refusal(d.set_build(&w1, zone(), b"not a hash")),
        "build-not-a-hash"
    );
}

/// A2 on the in-memory store, twenty times.
#[test]
fn a2_of_two_claims_of_one_world_exactly_one_is_refused() {
    let store = Memory::default();
    for _ in 0..20 {
        two_claims_one_refused(&store);
    }
}

/// A3 on the in-memory store.
#[test]
fn a3_a_paused_writer_is_refused_at_its_next_durable_write() {
    a_paused_writer_is_refused(&Memory::default());
}

/// A4: with the store out of reach, a world's tick loop keeps ticking (100 ticks, none skipped), and every claim,
/// alarm, pin, move and ship is refused `store-unreachable`, though the cached copy holds the record. When the store
/// is back, nothing was decided in between, and the writer ships. A real store client to a closed port answers the
/// same refusal at once.
#[test]
fn a4_with_the_store_out_of_reach_a_world_keeps_ticking_and_nothing_is_decided() {
    let store = Memory::default();
    let w = lineage();
    world(&store, &w);
    let mut d = dir(&store, "souls:machine-a");
    let mut c = d.claim(&w, zone()).expect("claimed");
    d.ship(&mut c, 0).expect("shipped");
    let before = d.world(&w, zone()).expect("a record");
    let soul = Id::new(Scope([0x50; 16]), 1).expect("an id");

    store.set_reachable(false);
    const R0: Micros = 1_763_400_000_000_000;
    let m = Mapping::new(0, R0, 1, 1).expect("a mapping");
    let line = Timeline::start(
        m,
        TickRate::new(0, 0, 20).expect("a rate"),
        Tempo::per_minute(0, 0, 120).expect("a tempo"),
    )
    .expect("a line");
    let mut clock = Fake::new(R0, Vec::new());
    let mut ticker = Ticker::new(line, m, None, R0).expect("a ticker");
    let beat = Heartbeat::new(R0);
    let mut ticked = Vec::new();
    while ticked.len() < 100 {
        ticker
            .run_due(&mut clock, &beat, &mut |n, _| ticked.push(n))
            .expect("ticks");
        // Beside the loop, the writer tries to ship what the ticks wrote: refused, and the loop goes on.
        let next = u64::try_from(ticked.len()).expect("ticks");
        assert_eq!(refusal(d.ship(&mut c, next)), "store-unreachable");
        ticker.wait(&mut clock).expect("waits");
    }
    assert_eq!(ticked, (0..100).collect::<Vec<i64>>(), "no tick skipped");

    // The cached copy has the record, and decides nothing.
    assert_eq!(d.cached_world(&w, zone()), Some(before.clone()));
    let mut other = dir(&store, "souls:machine-b");
    assert_eq!(refusal(other.claim(&w, zone())), "store-unreachable");
    assert_eq!(
        refusal(d.set_alarm(&w, zone(), Some(1))),
        "store-unreachable"
    );
    assert_eq!(
        refusal(d.set_build(&w, zone(), &build_hash(b"souls:build-2"))),
        "store-unreachable"
    );
    let here = Place::World {
        lineage: w,
        zone: zone(),
    };
    assert_eq!(refusal(d.set_place(soul, None, here)), "store-unreachable");

    store.set_reachable(true);
    assert_eq!(
        d.world(&w, zone()).expect("a record"),
        before,
        "nothing was decided"
    );
    assert_eq!(d.soul(soul).expect("read"), None);
    d.ship(&mut c, 100).expect("ships once the store is back");

    // A real store client whose store does not answer.
    let gone = S3::new("http://127.0.0.1:1", "directory", "auto", "k", "s", "").expect("settings");
    assert_eq!(refusal(gone.get("world/x")), "store-unreachable");
    assert_eq!(
        refusal(gone.put("world/x", b"x", When::Absent)),
        "store-unreachable"
    );
}

/// A5: the directory's truth is the objects in the store. Dropping a machine's cached copy loses nothing: another
/// directory, with no cache, reads every record as written.
#[test]
fn a5_the_truth_is_objects_in_the_store_and_a_cache_loses_nothing() {
    let store = Memory::default();
    let w = lineage();
    let soul = Id::new(Scope([0x50; 16]), 2).expect("an id");
    let here = Place::World {
        lineage: w,
        zone: zone(),
    };
    let mut d = dir(&store, "souls:machine-a");
    d.set_build(&w, zone(), &build_hash(b"souls:build-1"))
        .expect("pinned");
    let mut c = d.claim(&w, zone()).expect("claimed");
    d.ship(&mut c, 9).expect("shipped");
    d.set_alarm(&w, zone(), Some(5)).expect("an alarm");
    d.set_place(soul, None, here.clone()).expect("placed");
    let rec = d.cached_world(&w, zone()).expect("cached");

    assert_eq!(
        store.keys(),
        [SoulRecord::key(soul), WorldRecord::key(&w, zone())],
        "two objects are the whole truth"
    );
    d.forget();
    assert_eq!(d.cached_world(&w, zone()), None);
    drop(d);
    let mut fresh = dir(&store, "souls:machine-c");
    assert_eq!(fresh.world(&w, zone()).expect("a record"), rec);
    assert_eq!(fresh.soul(soul).expect("read").map(|r| r.place), Some(here));
}

/// A2 and A3 against the store the environment names (`DIRECTORY_STORE_*`), and the store's own two refusals: a
/// second create-only write of one key, and a write naming a version that is gone. Ignored without one.
#[test]
#[ignore = "needs an S3-compatible store: DIRECTORY_STORE_ENDPOINT and the rest (s3::ENV)"]
fn against_the_store_in_use() {
    let store = S3::from_env()
        .expect("DIRECTORY_STORE_ENDPOINT is set")
        .expect("store settings");
    let key = format!("check/{}", Token::draw().expect("random").hex());
    let first = store.put(&key, b"1", When::Absent).expect("created");
    assert_eq!(
        refusal(store.put(&key, b"2", When::Absent)),
        "precondition-failed",
        "a second create-only write"
    );
    store
        .put(&key, b"3", When::Is(&first))
        .expect("replaced on the version read");
    assert_eq!(
        refusal(store.put(&key, b"4", When::Is(&first))),
        "precondition-failed",
        "a write naming a version that is gone"
    );
    println!("store: refused the second create-only write and the stale If-Match");
    for _ in 0..5 {
        two_claims_one_refused(&store);
    }
    a_paused_writer_is_refused(&store);
}
