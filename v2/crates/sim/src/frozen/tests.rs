//! K8's acceptance (#2671): A3, a held copy never changes; A4, one query test runs unchanged on the frozen copy and on
//! the replica itself. A1 and A2 are the `frozen` bench's.

use super::Publisher;
use replica::apply::Replica;
use replica::effects::{FIXTURE_HEADER, FIXTURES, Part, fixture_bytes};
use replica::encode::{Value, encode};
use replica::ids::{Id, Scope};
use replica::read::Read;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

fn part(name: &str) -> Vec<u8> {
    let text = FIXTURES.iter().find(|(n, _)| *n == name).unwrap().1;
    fixture_bytes(text).unwrap()
}

/// The clock's tick: a part applied to the live replica, then handed to the publisher.
fn tick(live: &mut Replica, p: &Publisher, name: &str) {
    let part = Part::read(&part(name)).unwrap();
    live.apply(&part).unwrap();
    p.publish(vec![Arc::new(part)]);
}

/// The clock's tick from a part: applied to the live replica, then handed to the publisher.
fn tick_part(live: &mut Replica, p: &Publisher, part: Part) {
    live.apply(&part).unwrap();
    p.publish(vec![Arc::new(part)]);
}

/// T6's motion fixture (Soul 100's body walks in its room) as the entry at `sequence`.
fn walk(sequence: u64) -> Part {
    let mut part = Part::read(&part("7-motion")).unwrap();
    part.effects[0].envelope.sequence = sequence;
    Part::read(&encode(&part.to_value()).unwrap()).unwrap()
}

const WAIT: Duration = Duration::from_secs(10);

/// T6's base fixture and then its link fixture: R1's query world (`replica/tests/queries.txt`).
fn world() -> Replica {
    let mut r = Replica::start(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
    r.apply_bytes(&part("0-base")).unwrap();
    r.apply_bytes(&part("5-link")).unwrap();
    r
}

fn ee(n: u64) -> Id {
    Id::new(Scope([0xee; 16]), n).unwrap()
}

/// The one query test (A4), over the read interface: R1's cases (`queries.txt`) for a node, children, links and
/// path, and each node's version stamp.
fn queries(r: &impl Read) {
    let soul = Id::new(Scope([0xdd; 16]), 100).unwrap();
    assert_eq!(r.version(), 3);
    let stamps = [(ee(0), 2), (ee(4), 2), (ee(6), 3), (soul, 3), (ee(99), 0)];
    for (id, v) in stamps {
        assert_eq!(r.stamp(id), v, "{id:?}");
    }
    let Some(Value::Map(cup)) = r.node(ee(4)) else {
        panic!("the cup is a record")
    };
    assert_eq!(
        cup.get(&10),
        Some(&Value::Uint(2)),
        "its stamp, as field 10"
    );
    assert_eq!(r.node(ee(99)), None);
    assert_eq!(r.children(ee(1), None), Some(vec![ee(2), ee(6), ee(7)]));
    assert_eq!(r.children(ee(1), Some("souls:key")), Some(vec![ee(6)]));
    assert_eq!(r.children(ee(4), None), Some(vec![]));
    assert_eq!(r.children(ee(99), None), None);
    let at_soul: Vec<Id> = r.links(soul).iter().map(|l| l.link).collect();
    assert_eq!(at_soul, [ee(3), ee(5), ee(9)]);
    let at_key: Vec<Id> = r.links(ee(6)).iter().map(|l| l.link).collect();
    assert_eq!(at_key, [ee(9)]);
    assert_eq!(r.path(ee(4)), Some(vec![ee(4), ee(2), ee(1), ee(0)]));
    assert_eq!(r.path(ee(99)), None);
}

#[test]
fn a4_one_query_test_runs_on_the_replica_and_on_its_frozen_copy() {
    let live = world();
    queries(&live);
    // A whole copy, as the publisher starts.
    let p = Publisher::new(&live);
    queries(&*p.latest());
    // A copy the publishing thread built from the parts handed over, read on another thread.
    let mut live = Replica::start(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
    let p = Publisher::new(&live);
    tick(&mut live, &p, "0-base");
    tick(&mut live, &p, "5-link");
    queries(&live);
    let frozen = p.wait_for(3, WAIT);
    thread::spawn(move || queries(&*frozen)).join().unwrap();
    assert_eq!(p.counts().refused, 0);
    println!(
        "a4: the same query test passes on the replica, on a whole copy, and on a published copy on another thread"
    );
}

/// Everything the read interface can see of the fixture world's nodes, as bytes.
fn picture(r: &impl Read) -> Vec<u8> {
    let soul = Id::new(Scope([0xdd; 16]), 100).unwrap();
    let mut all = vec![Value::Uint(r.version())];
    for id in (0..10).map(ee).chain([soul]) {
        all.push(r.node(id).unwrap_or(Value::Uint(0)));
        all.push(Value::Uint(r.stamp(id)));
        let kids = r.children(id, None).unwrap_or_default();
        all.push(Value::Array(kids.into_iter().map(Id::to_value).collect()));
        let links = r.links(id).into_iter().map(|l| l.link.to_value());
        all.push(Value::Array(links.collect()));
    }
    encode(&Value::Array(all)).unwrap()
}

#[test]
fn a3_a_held_copy_does_not_change_while_the_clock_advances() {
    let mut live = Replica::start(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
    live.apply_bytes(&part("0-base")).unwrap();
    let p = Arc::new(Publisher::new(&live));
    let held = p.latest();
    let before = picture(&*held);

    // A reader on its own thread holds the copy across the clock's next tick.
    let tick_done = Arc::new(Barrier::new(2));
    let reader = {
        let (held, done) = (Arc::clone(&held), Arc::clone(&tick_done));
        thread::spawn(move || {
            let at_start = picture(&*held);
            done.wait();
            (at_start, picture(&*held), held.stamp(ee(6)))
        })
    };
    // The clock: a link to the key, then six steps of a walk, each applied to the live replica and handed over. The
    // publishing thread reuses spare copies as it goes, never the one held.
    tick(&mut live, &p, "5-link");
    for sequence in 3..9 {
        tick_part(&mut live, &p, walk(sequence));
    }
    let newest = p.wait_for(9, WAIT);
    tick_done.wait();
    let (reader_start, reader_end, key_stamp) = reader.join().unwrap();

    assert_eq!(reader_start, before);
    assert_eq!(reader_end, before, "the reader's copy is as it was");
    assert_eq!(
        picture(&*held),
        before,
        "and so is the clock thread's view of it"
    );
    assert_eq!((held.version(), key_stamp, live.stamp(ee(6))), (2, 2, 3));
    assert_eq!(
        picture(&*newest),
        picture(&live),
        "the newest copy is the live replica"
    );
    assert_ne!(picture(&*newest), before, "which changed");
    let c = p.counts();
    assert_eq!((newest.version(), c.refused), (9, 0));
    println!(
        "a3: a copy held on another thread stays at version 2 (the key's stamp 2) while the clock moves the live \
         replica to 9 over seven ticks; {} copies published, {} of them whole",
        c.published, c.whole
    );
}
