//! V4's acceptance (#2713) on W8's in-memory store: a seek gives the public state at its moment exactly, the event
//! index holds time, kind, node and actor only (A3), and the index and coarse levels made again from the archive equal
//! the stored ones by hash (A4). The seek table and the sizes (A1, A2, A5) are `cargo run -p archive --release -- seek`.

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

use archive::script::{self, SAID};
use archive::{Archiver, fetch, rebuild_views, seek, words};
use directoryd::directory::store::{Memory, Store};
use replica::effects::{Actor, Header, Part, State, read_id};
use replica::encode::{Value, decode};
use replica::history::events::{Counts, EventIndex, Span, counts_key, events_key};
use replica::history::public_snapshot;
use replica::ids::sha256;
use replica::views::Redactions;

const PREFIX: &str = "worlds/test/";

/// A small world over two world days (as V3's test): ticks a second apart for twelve minutes, then a few the next
/// day; five bodies step each tick and one speaks each seven seconds. Returns the store, the header and the log.
fn recorded() -> (Memory, Header, Vec<Vec<u8>>, State) {
    recorded_with(7, 30)
}

/// As [`recorded`], with a Soul speaking each `say` seconds and `next` seconds of ticks the next day.
fn recorded_with(say: u64, next: u64) -> (Memory, Header, Vec<Vec<u8>>, State) {
    let store = Memory::default();
    let queue = Rc::new(RefCell::new(Vec::<Vec<u8>>::new()));
    let q = queue.clone();
    let mut w = script::world(
        3,
        10,
        Some(Box::new(move |b: &[u8]| q.borrow_mut().push(b.to_vec()))),
    );
    let root = w.tree.node(w.tree.root()).expect("root").id();
    let kind = w.tree.node(w.tree.root()).expect("root").kind().clone();
    for t in (0..720u64).chain(86_400..86_400 + next) {
        script::tick(&mut w, t * 20, 5, say * 20);
    }
    let mut a = Archiver::open(&store, PREFIX, &w.header, root, kind.clone()).expect("opens");
    a.packer.set_target(20_000);
    let log: Vec<Vec<u8>> = queue.borrow_mut().drain(..).collect();
    for (n, p) in log.iter().enumerate() {
        a.push(n as u64, p.clone()).expect("archives");
    }
    a.flush().expect("flushes");
    (store, w.header.clone(), log, State::start(root, kind))
}

/// The public state at `at`, from the whole log.
fn truth(header: &Header, log: &[Vec<u8>], start: &State, at: i64) -> Value {
    let mut s = start.clone();
    for p in log {
        let part = Part::read(p).expect("a part");
        for e in &part.effects {
            if e.envelope.at <= at {
                s.apply_entry(header, e).expect("applies");
            }
        }
    }
    public_snapshot(&s, &Redactions::default())
}

#[test]
fn a_seek_gives_the_public_state_at_its_moment() {
    let (store, header, log, start) = recorded();
    // Inside windows, on a window's first second, after the last window of a day (no bundle until the next), and on
    // the next day. Not in the first three seconds: there a body's built pose and its first step are samples less
    // than a second apart, and the history level keeps one sample a second (R3's `sampled`), so the step is not in
    // history until the body's next one, three seconds on.
    let moments = [
        3_000_000,
        5_000_000,
        59_999_999,
        60_000_000,
        61_500_000,
        333_333_333,
        719_000_000,
        5_000_000_000,
        86_400_000_000 + 10_000_000,
        86_400_000_000 + 40_000_000,
    ];
    for at in moments {
        let got = seek(&store, PREFIX, &header, at).expect("seeks");
        assert_eq!(
            public_snapshot(&got.state, &Redactions::default()),
            truth(&header, &log, &start, at),
            "at {at} µs"
        );
        assert!(got.requests >= 2 && got.bytes > 0);
    }
    assert_eq!(
        seek(&store, PREFIX, &header, -1).err().map(|e| e.name),
        Some("history-none")
    );
}

#[test]
fn a3_the_event_index_holds_time_kind_node_and_actor_only() {
    let (store, _, _, _) = recorded();
    // Every public node any bundle's snapshot holds.
    let ids: BTreeSet<replica::ids::Id> = {
        store
            .keys()
            .iter()
            .filter(|k| k.contains("bundles/") && !k.ends_with("/index"))
            .flat_map(|k| {
                let b = replica::history::Bundle::read(
                    &archive::bundle_body(&store.get(k).unwrap().unwrap().bytes).expect("inflates"),
                )
                .expect("a bundle");
                replica::history::snapshot_nodes(&b.snapshot).expect("nodes")
            })
            .collect()
    };
    let mut rows = 0;
    for k in store.keys().iter().filter(|k| k.contains("/events/")) {
        let bytes = store.get(k).expect("get").expect("there").bytes;
        // Read generically: every row is exactly [time, kind number, node, actor], and nothing else is in the map.
        let Value::Map(m) = decode(&bytes).expect("cbor").value else {
            panic!("{k} is a map")
        };
        // Format, day, hour (an hour's object), kinds, rows, split hours (a day's): no other field.
        assert!(m.keys().all(|k| (1..=6).contains(k)), "{k}: {:?}", m.keys());
        assert!(
            [2, 3, 6]
                .iter()
                .filter_map(|f| m.get(f))
                .all(|v| matches!(v, Value::Uint(_) | Value::Array(_))),
            "{k}"
        );
        let Some(Value::Array(rs)) = m.get(&5) else {
            panic!("rows")
        };
        for r in rs {
            let Value::Array(p) = r else { panic!("a row") };
            assert_eq!(p.len(), 4, "{k}: {r:?}");
            assert!(matches!(p[0], Value::Uint(_)) && matches!(p[1], Value::Uint(_)));
            // The node is a public node; the actor is a Soul that is one too, or the world: no other id at all.
            assert!(
                ids.contains(&read_id(&p[2]).expect("an id")),
                "{k}: node {:?}",
                p[2]
            );
            match &p[3] {
                Value::Array(a) if a.len() == 2 && a[0] == Value::Uint(1) => {
                    assert!(
                        ids.contains(&read_id(&a[1]).expect("an id")),
                        "{k}: actor {:?}",
                        a[1]
                    )
                }
                Value::Array(a) if a.as_slice() == [Value::Uint(3)] => {}
                other => panic!("{k}: actor {other:?}"),
            }
            rows += 1;
        }
        // No text: no reference, no words.
        assert!(replica::audience::references(&Value::Map(m.clone())).is_empty());
        assert_eq!(
            words(&Value::Map(m), &bytes, &SAID),
            Vec::<String>::new(),
            "{k}"
        );
        let ix = EventIndex::read(&bytes).expect("an event index");
        assert!(
            ix.rows
                .iter()
                .all(|r| r.kind.as_str() == "souls:said" && matches!(r.actor, Actor::Soul(_)))
        );
    }
    // One speech each seven seconds of 720, and 30 the next day: 103 + 5.
    assert_eq!(rows, 103 + 5, "{rows}");
    // The coarse levels count the same events.
    let total = |key: String| -> u64 {
        Counts::read(&store.get(&format!("{PREFIX}{key}")).unwrap().unwrap().bytes)
            .expect("counts")
            .counts
            .values()
            .sum()
    };
    assert_eq!(total(counts_key(Span::Day(0))), 103);
    assert_eq!(total(counts_key(Span::Day(1))), 5);
    assert_eq!(total(counts_key(Span::Year(0))), 108);
}

#[test]
fn a4_the_index_and_coarse_levels_made_again_equal_the_stored_ones() {
    // The first world's events fit in each day's object; the second's next day has an hour of 1,100 events, which
    // takes an object of its own.
    for (say, next, objects) in [(7, 30, 2 + 2 + 1), (1, 1_100, 3 + 2 + 1)] {
        let (store, _, _, _) = recorded_with(say, next);
        let f = fetch(&store, PREFIX).expect("fetched");
        let again = rebuild_views(&f).expect("made again");
        let stored: Vec<String> = store
            .keys()
            .into_iter()
            .filter(|k| k.starts_with(&format!("{PREFIX}history/")))
            .collect();
        let made: Vec<String> = again.keys().map(|k| format!("{PREFIX}{k}")).collect();
        assert_eq!(stored, made);
        assert_eq!(
            made.len(),
            objects,
            "events by day (and hour), counts by day, a year's"
        );
        for (k, v) in &again {
            let s = store
                .get(&format!("{PREFIX}{k}"))
                .expect("get")
                .expect("there");
            assert_eq!(sha256(&s.bytes), sha256(v), "{k}");
        }
        let day1 = EventIndex::read(&again[&events_key(1, None)]).expect("day 1");
        if next > 1_000 {
            assert_eq!((day1.split.as_slice(), day1.rows.len()), (&[0][..], 0));
            let h = EventIndex::read(&again[&events_key(1, Some(0))]).expect("hour 0");
            assert_eq!(h.rows.len(), 1_100);
        } else {
            assert_eq!((day1.split.len(), day1.rows.len()), (0, 5));
        }
    }
}
