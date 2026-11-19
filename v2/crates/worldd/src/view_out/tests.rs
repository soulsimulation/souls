//! The stream writer (Engine v2 V1, #2710): a player plays every part in order and holds the writer's state at every
//! tenth; a jump in world time leaves no hole in the numbers; parts carry references, never words (A5); and a writer
//! killed mid-write leaves no broken part under a final name (A4). A1 to A3 are `v2/tools/stream-check`, live in a
//! headless browser. Run with `cargo test -p worldd view_out -- --nocapture` to see the numbers.

use super::*;
use replica::audience::references;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, FIXTURE_HEADER, Rest, fixture_bytes,
    texts,
};
use replica::ids::{Id, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::stream::Player;
use replica::views::Level;
use replica::world_model::Audience;
use std::process::Command;

fn header() -> Header {
    Header::read(&fixture_bytes(FIXTURE_HEADER).expect("bytes")).expect("a header")
}

fn key(h: &Header) -> Key {
    Key {
        node: h.zone,
        level: Level::Full,
        audience: Audience::Everyone,
    }
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("v2-view-out-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).expect("a scratch folder");
    d
}

fn entry(seq: u64, at: i64, node: Id, change: Change) -> Value {
    Effect {
        envelope: Envelope {
            sequence: seq,
            at,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node,
        },
        body: Body::Changes(vec![ChangeRec {
            change,
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    }
    .to_value()
}

fn create(h: &Header, node: Id) -> Change {
    Change::Create {
        node,
        kind: h.kinds[0].clone(),
        pose: Pose {
            frame: Frame {
                node: h.zone,
                slot: None,
            },
            position: Vec3::new(0, 0, 0),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: h.zone,
                height: 0,
            },
        },
        audience: Audience::Everyone,
        fields: [(1, Value::Uint(0))].into(),
    }
}

fn set(node: Id, field: u64, to: Value) -> Change {
    Change::Set {
        node,
        field,
        to,
        by: None,
    }
}

fn frame(records: Vec<Value>) -> Vec<u8> {
    encode(&Value::Map([(8, Value::Array(records))].into())).expect("bytes")
}

fn ids() -> Vec<Id> {
    (0..3)
        .map(|i| Id::new(Scope([0x71; 16]), i).expect("an id"))
        .collect()
}

/// Every file in a stream's directory, sorted: its name and bytes.
fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<(String, Vec<u8>)> = fs::read_dir(dir)
        .expect("the stream")
        .map(|e| {
            let e = e.expect("an entry");
            let name = e.file_name().into_string().expect("a name");
            (name, fs::read(e.path()).expect("its bytes"))
        })
        .collect();
    out.sort();
    out
}

#[test]
fn a_player_plays_every_part_and_holds_the_same_state() {
    let h = header();
    let root = scratch("play");
    let mut w = Writer::create(&root, &h, &key(&h), (0, 1_000_000)).expect("a writer");
    let n = ids();
    let mut seq = 0;
    let mut next = |at, node, c| {
        seq += 1;
        entry(seq - 1, at, node, c)
    };
    w.frame(&frame(
        n.iter().map(|i| next(0, h.zone, create(&h, *i))).collect(),
    ))
    .expect("written");
    let reference = Id::new(Scope([0x72; 16]), 9).expect("a reference");
    // 20 ticks a second for 12.5 s, and after tick 120 the world was still for a minute (K9's jump).
    for t in 1..=250i64 {
        let at = t * 50_000 + if t > 120 { 60_000_000 } else { 0 };
        let node = n[(t % 3) as usize];
        let c = if t == 100 {
            set(node, 2, Value::Map([(21, reference.to_value())].into()))
        } else {
            set(node, 1, Value::Uint(t as u64))
        };
        w.frame(&frame(vec![next(at, node, c)])).expect("written");
    }
    w.flush().expect("flushed");
    let written = w.written().clone();
    assert_eq!(written.entries, 253);
    assert_eq!(
        written.parts, 27,
        "one part per half second with entries; none for the still minute"
    );

    let dir = w.dir().to_path_buf();
    let hb = fs::read(root.join(stream::header_path(&h))).expect("the header, written once");
    let mut p = Player::start(&hb).expect("a player");
    let ptr = Pointer::read(&fs::read(dir.join(POINTER)).expect("a pointer")).expect("reads");
    assert_eq!(ptr.newest, Some(written.parts - 1));
    assert_eq!(ptr.header, h.hash().to_bytes());
    let mut hashed = 0;
    let mut refs = 0;
    for i in 0..written.parts {
        let bytes = fs::read(dir.join(i.to_string())).expect("a part");
        if i == 3 {
            let later = fs::read(dir.join("5")).expect("a later part");
            let e = p.play(&later).expect_err("out of order");
            assert_eq!(e.name, "stream-gap");
        }
        let played = p.play(&bytes).expect("plays");
        assert_eq!(played.number, i);
        if played.hash.is_some() {
            assert_eq!(played.hash, Some(true), "part {i}'s hash");
            hashed += 1;
        }
        // A5: the part's text items are names (T6 rule 10), and free text is a reference.
        let sp = StreamPart::read(&bytes).expect("reads");
        let v = decode(&sp.part).expect("decodes").value;
        assert!(
            texts(&v)
                .iter()
                .all(|t| replica::encode::Name::new(t).is_some())
        );
        refs += references(&v).len();
    }
    assert_eq!(hashed, 2, "parts 9 and 19 carry the hash");
    assert_eq!(refs, 1);
    assert_eq!(p.replica().version(), 253);
    assert_eq!(
        replica::hash::state_hash(p.replica().tree()).expect("a hash"),
        replica::hash::state_hash(w.copy.tree()).expect("a hash")
    );
    println!(
        "view_out: {} parts, {} entries, bytes per part {:?}",
        written.parts, written.entries, written.bytes
    );
    let _ = fs::remove_dir_all(&root);
}

/// The child of the kill test: writes big parts until it is killed. Does nothing unless `V1_KILL_DIR` is set.
#[test]
fn kill_child() {
    let Ok(root) = std::env::var("V1_KILL_DIR") else {
        return;
    };
    let h = header();
    let mut w = Writer::create(Path::new(&root), &h, &key(&h), (0, 0)).expect("a writer");
    let n = ids();
    w.frame(&frame(
        n.iter()
            .enumerate()
            .map(|(s, i)| entry(s as u64, 0, h.zone, create(&h, *i)))
            .collect(),
    ))
    .expect("written");
    let mut x: u64 = 0x2710;
    for t in 1..=3u64 {
        // 1 MB that packing barely shrinks.
        let big: Vec<u8> = (0..1 << 20)
            .map(|_| {
                x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                (x >> 56) as u8
            })
            .collect();
        let c = set(n[0], 3, Value::Bytes(big));
        w.frame(&frame(vec![entry(2 + t, t as i64 * 500_000, n[0], c)]))
            .expect("written");
    }
    w.flush().expect("flushed");
    // Then the last part, rewritten under new numbers the writer's way as fast as it goes, so that a kill lands inside
    // a write (packing a part in a debug build takes far longer than writing it).
    let last = fs::read(w.dir().join("3")).expect("part 3");
    for i in 4u64.. {
        write_whole(&w.dir().join(i.to_string()), &last).expect("written");
    }
}

#[test]
fn a_writer_killed_mid_write_leaves_no_broken_part() {
    let h = header();
    let base = scratch("kill");
    let exe = std::env::current_exe().expect("this test binary");
    let (mut parts, mut temps) = (0, 0);
    for round in 0..20u64 {
        let root = base.join(round.to_string());
        let mut child = Command::new(&exe)
            .args(["view_out::tests::kill_child", "--exact", "--test-threads=1"])
            .env("V1_KILL_DIR", &root)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("the child");
        std::thread::sleep(Duration::from_millis(150 + (round * 37) % 250));
        child.kill().expect("killed");
        let _ = child.wait();
        let dir = root.join(stream::dir(&h, &key(&h)));
        if !dir.exists() {
            continue;
        }
        let hb = fs::read(root.join(stream::header_path(&h))).expect("the header");
        Header::read(&hb).expect("the header is whole");
        for (name, bytes) in files(&dir) {
            if name.ends_with(".tmp") {
                temps += 1;
            } else if name == POINTER {
                Pointer::read(&bytes).expect("the pointer is whole");
            } else {
                let sp = StreamPart::read(&bytes).expect("a whole part");
                Part::read(&sp.part).expect("its effects read");
                parts += 1;
            }
        }
    }
    println!(
        "view_out kill test: 20 kills, {parts} whole parts read, {temps} half-written temporary files left"
    );
    assert!(parts > 0);
    assert!(temps > 0, "no kill landed inside a write");
    let _ = fs::remove_dir_all(&base);
}

const DAY: &str = include_str!("../../../replica/fixtures/views/1-day.diag");

/// T7's fixture log (T6's base, then a day with private notes and transfers) and the view of `key` built over it.
fn fixture_view(key: Key) -> Vec<(i64, Value)> {
    use replica::effects::{FIXTURES, State};
    use replica::views::{Redactions, build};
    let h = header();
    let root = h
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .expect("the root's kind")
        .clone();
    let start = State::start(h.zone, root);
    let parts: Vec<Part> = [FIXTURES[0].1, DAY]
        .iter()
        .map(|t| Part::read(&fixture_bytes(t).expect("bytes")).expect("a part"))
        .collect();
    let out = build(&start, &h, &parts, &[key], &Redactions::default()).expect("the view");
    out.into_iter().next().expect("one").records
}

/// #3239 A1: the public views of a log with private entries (T7's fixture day: aa:1's notes are entries 7, 8 and 14)
/// skip them; the writer declares each jump, and a player plays every part to the end, holding the writer's state.
/// A2: the same part without its declaration, or with a wrong one, is refused by name and applies nothing.
#[test]
fn a_view_that_skips_private_entries_plays_to_the_end() {
    let h = header();
    let note = encode(&Id::new(Scope([0xee; 16]), 20).expect("an id").to_value()).expect("bytes");
    for (node, level) in [
        (0, Level::Full),
        (0, Level::Sampled),
        (1, Level::Full),
        (7, Level::Full),
        (7, Level::Sampled),
    ] {
        let key = Key {
            node: Id::new(Scope([0xee; 16]), node).expect("an id"),
            level,
            audience: Audience::Everyone,
        };
        let records = fixture_view(key);
        let root = scratch(&format!("gaps-{node}-{}", level.number()));
        let mut w = Writer::create(&root, &h, &key, (0, 0)).expect("a writer");
        for (_, r) in &records {
            w.frame(&frame(vec![r.clone()])).expect("written");
        }
        w.flush().expect("flushed");
        let hb = fs::read(root.join(stream::header_path(&h))).expect("the header");
        let mut p = Player::start(&hb).expect("a player");
        let mut declared = Vec::new();
        let mut carried = 0;
        for i in 0..w.written().parts {
            let bytes = fs::read(w.dir().join(i.to_string())).expect("a part");
            let sp = StreamPart::read(&bytes).expect("reads");
            assert!(
                !sp.part.windows(note.len()).any(|x| x == note.as_slice())
                    && !bytes.windows(note.len()).any(|x| x == note.as_slice()),
                "the public stream names aa:1's note"
            );
            carried += sp.carried.len();
            if !sp.gaps.is_empty() {
                let at = p.replica().version();
                let bare = StreamPart {
                    gaps: Vec::new(),
                    ..sp.clone()
                };
                let e = p
                    .play(&bare.to_bytes().expect("bytes"))
                    .expect_err("undeclared");
                assert_eq!(e.name, "sequence-gap", "{e}");
                let (first, count) = sp.gaps[0];
                let wrong = StreamPart {
                    gaps: vec![(first, count + 1)],
                    ..sp.clone()
                };
                let e = p
                    .play(&wrong.to_bytes().expect("bytes"))
                    .expect_err("wrong");
                assert_eq!(e.name, "sequence-gap", "{e}");
                let extra = StreamPart {
                    gaps: [sp.gaps.clone(), vec![(u64::MAX - 1, 1)]].concat(),
                    ..sp.clone()
                };
                let e = p
                    .play(&extra.to_bytes().expect("bytes"))
                    .expect_err("unmet");
                assert_eq!(e.name, "gap-unmet", "{e}");
                assert_eq!(p.replica().version(), at, "a refused part applies nothing");
                assert_eq!(p.next(), i);
            }
            declared.extend(sp.gaps.iter().copied());
            let played = p.play(&bytes).expect("plays");
            assert_ne!(played.hash, Some(false), "part {i}'s hash");
        }
        let held = replica::hash::state_hash(p.replica().tree()).expect("a hash");
        println!(
            "view_out gaps: node ee:{node} level {}: {} records, {} parts, declared gaps {declared:?}, {carried} subtrees carried in, played to version {}, state hash {held} (writer's {})",
            level.number(),
            records.len(),
            w.written().parts,
            p.replica().version(),
            replica::hash::state_hash(w.copy.tree()).expect("a hash"),
        );
        assert!(!declared.is_empty(), "the view skipped aa:1's entries");
        assert_eq!(
            held,
            replica::hash::state_hash(w.copy.tree()).expect("a hash")
        );
        if node == 7 {
            // #3248 A2: the crate's view held neither leave; the key and the cushion are carried in and land on it.
            assert_eq!(carried, 2, "the key and the cushion are carried in");
            let tree = p.replica().tree();
            for landed in [6, 12] {
                let n = tree
                    .handle(Id::new(Scope([0xee; 16]), landed).expect("an id"))
                    .and_then(|h| tree.node(h))
                    .expect("landed");
                assert_eq!(n.parent(), Some(key.node), "ee:{landed} is on the crate");
            }
        }
        let _ = fs::remove_dir_all(&root);
    }
}

/// #3248 A3: a revision 1 carried record (no destination) still reads, and the writer still refuses it by name, as
/// it does a carried record no arrive follows (aa:1's view of the crate: its note came in a public cushion).
#[test]
fn a_carried_record_without_a_destination_or_an_arrive_is_refused() {
    let h = header();
    let crate_ = Id::new(Scope([0xee; 16]), 7).expect("an id");
    let public = Key {
        node: crate_,
        level: Level::Full,
        audience: Audience::Everyone,
    };
    let old: Vec<Value> = fixture_view(public)
        .into_iter()
        .map(|(_, r)| match r {
            Value::Map(mut m) => {
                if let Some(Value::Map(c)) = m.get_mut(&0) {
                    c.remove(&4);
                }
                Value::Map(m)
            }
            r => r,
        })
        .collect();
    let first = old
        .iter()
        .find_map(|r| replica::views::Carried::read(r).expect("reads"))
        .expect("a carried record");
    assert_eq!(first.pose, None, "revision 1 names no destination");
    assert_eq!(
        first.flight(&h).expect_err("no destination").name,
        "carried-no-destination"
    );
    let root = scratch("carried-rev1");
    let mut w = Writer::create(&root, &h, &public, (0, 0)).expect("a writer");
    let e = old
        .iter()
        .try_for_each(|r| w.frame(&frame(vec![r.clone()])))
        .expect_err("refused");
    assert_eq!(e.name, "stream-carried", "{e}");
    let private = Key {
        audience: Audience::Of(Id::new(Scope([0xaa; 16]), 1).expect("an id")),
        ..public
    };
    let mut w = Writer::create(&root, &h, &private, (0, 0)).expect("a writer");
    let e = fixture_view(private)
        .into_iter()
        .try_for_each(|(_, r)| w.frame(&frame(vec![r])))
        .and_then(|()| w.flush())
        .expect_err("refused");
    println!(
        "view_out: a revision 1 carried record and one with no arrive: both {}",
        e.name
    );
    assert_eq!(e.name, "stream-carried", "{e}");
    let _ = fs::remove_dir_all(&root);
}

/// A2 at R1's replica: a view's part applied as if it skipped nothing is refused as `sequence-gap`.
#[test]
fn an_undeclared_gap_is_refused_by_the_replica() {
    let h = header();
    let key = key(&h);
    let root = scratch("undeclared");
    let mut w = Writer::create(&root, &h, &key, (0, 0)).expect("a writer");
    for (_, r) in fixture_view(key) {
        w.frame(&frame(vec![r])).expect("written");
    }
    w.flush().expect("flushed");
    let mut r = Replica::start(h.stored()).expect("a replica");
    let mut refused = None;
    for i in 0..w.written().parts {
        let sp = StreamPart::read(&fs::read(w.dir().join(i.to_string())).expect("a part"))
            .expect("reads");
        if let Err(e) = r.apply(&Part::read(&sp.part).expect("a part")) {
            refused = Some((i, e.name));
            break;
        }
    }
    println!("view_out: the replica without declarations refused {refused:?}");
    assert!(matches!(refused, Some((_, "sequence-gap"))));
    let _ = fs::remove_dir_all(&root);
}

fn part_of(h: &Header, records: Vec<Value>) -> Part {
    let v = Value::Map(
        [
            (1, Value::Bytes(h.hash().to_bytes())),
            (2, Value::Array(records)),
        ]
        .into(),
    );
    Part::read(&encode(&v).expect("bytes")).expect("a part")
}

/// #3300 A1 and A2: a small world (three things, a link, the root's field, 41 entries) is checkpointed and forked
/// (K6). The writer starts at the fork's head: part 0 holds the fork's state, numbered just below its next sequence
/// with the sequences before declared as one gap, and carries the state hash. Then 10 s of ticks, 20 a second, go
/// through the view tier (R3) to the writer, and a fresh reader plays every part to the live world's state hash.
#[test]
fn a_fork_streams_from_its_head_and_a_fresh_reader_holds_the_live_state() {
    use crate::views::Tier;
    use replica::ids::{Hash, Purpose, Version};
    use replica::tree::Tree;
    use replica::views::Redactions;
    use sim::checkpoint::fork::{Request, fork};
    use sim::checkpoint::{Blobs, Checkpoints};

    let h = header();
    let place = h
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .expect("a place kind")
        .clone();
    let n = ids();
    // The parent: three things, a link between two, the root's field, then 36 ticks of changes.
    let mut t = Tree::start(h.zone, place);
    let mut parent: Vec<Value> = n
        .iter()
        .enumerate()
        .map(|(s, i)| entry(s as u64, 0, h.zone, create(&h, *i)))
        .collect();
    let link = Change::Link {
        link: Id::new(Scope([0x71; 16]), 9).expect("an id"),
        ty: replica::encode::Name::new("souls:near").expect("a name"),
        ends: [n[0], n[1]],
        owner: replica::world_model::End::First,
        audience: Audience::Everyone,
    };
    parent.push(entry(3, 0, n[0], link));
    parent.push(entry(4, 0, h.zone, set(h.zone, 3, Value::Uint(7))));
    for s in 5..41u64 {
        let node = n[(s % 3) as usize];
        parent.push(entry(
            s,
            s as i64 * 50_000,
            node,
            set(node, 1, Value::Uint(s)),
        ));
    }
    t.apply(&h, &part_of(&h, parent))
        .expect("the parent applies");
    let d = scratch("fork");
    let mut c = Checkpoints::open(&d.join("parent"), 1 << 20, Blobs::default()).expect("opens");
    let v = Version {
        lineage: h.lineage,
        zone: h.zone,
        epoch: 1,
        sequence: t.next(),
    };
    c.take(&mut t, v, 1, b"the parent's seed").expect("taken");
    c.wait().expect("written");
    let mut f = fork(
        &d.join("parent"),
        &d.join("fork"),
        Request {
            through: Id::new(Scope([0x77; 16]), 1).expect("an id"),
            scope: Scope([0xf3; 16]),
            seed: vec![0xf3; 32],
            real_us: 1_763_337_700_000_000,
            build: Hash::of(Purpose::Fixture, b"souls/3300-test/1").to_bytes(),
            every: 1 << 20,
        },
    )
    .expect("forks");
    let head = f.tree.next();
    assert!(head > 41, "the fork starts mid-sequence, after its head");

    // A1: the writer starts at the fork's head, from the state the tier starts on.
    let key = key(&f.header);
    let tier = Tier::start(
        f.header.clone(),
        f.tree.to_state(),
        Redactions::default(),
        f.log.durable_mark(),
    )
    .expect("a tier");
    let sub = tier.subscribe(vec![key], 1 << 12);
    let root = d.join("stream");
    let w = Writer::fork(&root, &f.header, &key, (0, 1_000_000), &f.tree.to_state())
        .expect("a fork's writer");
    let stop = Arc::new(AtomicBool::new(false));
    let following = follow(w, sub, stop.clone());

    // A2: 10 s of ticks, 20 a second, each written to the fork's log and handed to the tier.
    for tick in 1..=200i64 {
        let seq = f.tree.next();
        let e = if tick % 50 == 0 {
            entry(
                seq,
                tick * 50_000,
                h.zone,
                set(h.zone, 3, Value::Uint(tick as u64)),
            )
        } else {
            let node = n[(tick % 3) as usize];
            entry(
                seq,
                tick * 50_000,
                node,
                set(node, 1, Value::Uint(tick as u64)),
            )
        };
        let p = part_of(&f.header, vec![e]);
        f.tree.apply(&f.header, &p).expect("the tick applies");
        let record = f.log.append(p.stored().to_vec()).expect("appended");
        tier.offer(record, p.stored().to_vec());
    }
    let stats = tier.close();
    assert!(stats.fault.is_none(), "{:?}", stats.fault);
    stop.store(true, Ordering::Relaxed);
    let w = following.join().expect("joined").expect("the writer wrote");

    // A1: part 0 carries the fork's header (its kinds added) and its whole state.
    let hb = fs::read(root.join(stream::header_path(&w.header))).expect("the header");
    let written = Header::read(&hb).expect("a header");
    assert_eq!(
        (written.lineage, written.zone, written.epoch, &written.build),
        (
            f.header.lineage,
            f.header.zone,
            f.header.epoch,
            &f.header.build
        )
    );
    let p0 = StreamPart::read(&fs::read(w.dir().join("0")).expect("part 0")).expect("reads");
    assert!(p0.hash.is_some(), "part 0 carries the state hash");
    assert_eq!(
        p0.first + p0.entries,
        head,
        "part 0 ends at the fork's head"
    );
    assert_eq!(p0.gaps, vec![(0, p0.first)]);

    // A2: a fresh reader plays every part and holds the live world's state.
    let mut p = Player::start(&hb).expect("a player");
    let mut hashed = 0;
    for i in 0..w.written().parts {
        let played = p
            .play(&fs::read(w.dir().join(i.to_string())).expect("a part"))
            .expect("plays");
        if played.hash.is_some() {
            assert_eq!(played.hash, Some(true), "part {i}'s hash");
            hashed += 1;
        }
    }
    let live = replica::hash::state_hash(&f.tree).expect("a hash");
    assert_eq!(p.replica().version(), f.tree.next());
    assert_eq!(
        replica::hash::state_hash(p.replica().tree()).expect("a hash"),
        live
    );
    assert_eq!(
        replica::hash::state_hash(w.copy.tree()).expect("a hash"),
        live
    );
    println!(
        "view_out fork: head at sequence {head}; part 0: {} entries from {} (gap {:?}), {} bytes; {} parts for 10 s, \
         {hashed} hashes checked; the reader at version {} holds the live state {live}",
        p0.entries,
        p0.first,
        p0.gaps,
        w.written().bytes[0],
        w.written().parts,
        p.replica().version()
    );
    let _ = fs::remove_dir_all(&d);
}
