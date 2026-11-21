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

thread_local! {
    /// Replays with the whole-state reference path instead of the tree-reading one (#3667's regression).
    pub(super) static WHOLE_STATE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

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
    // The ticks are offered at once, so the world's clock stands at their start (rule 11 never cuts early here).
    let following = follow(w, sub, stop.clone(), || 0);

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

/// W3d: a checkpoint is an existing world, not a new motionless fork. Its canonical public seed must carry the
/// recorded hand-off, exact slot, pending timer and mappings, while a pending slowdown governs quiet publication.
#[test]
fn w3d_checkpoint_motion_timers_privacy_and_pending_mapping_play_canonically() {
    use replica::effects::TimerRec;
    use replica::ids::Version;
    use replica::pose::{HandOff, Owner};
    use replica::time::Mapping;
    use replica::tree::Tree;
    use sim::checkpoint::{Blobs, Checkpoints, restore};

    let h = header();
    let root_kind = h
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .unwrap()
        .clone();
    let mut tree = Tree::start(h.zone, root_kind);
    let n = ids();
    let private = Audience::Of(n[0]);
    let real = 1_000_000_000_000;
    let timer = Id::new(Scope([0xe6; 16]), 0).unwrap();
    let private_timer = Id::new(Scope([0xe7; 16]), 0).unwrap();
    let public_link = Id::new(Scope([0xe8; 16]), 0).unwrap();
    let private_link = Id::new(Scope([0xe8; 16]), 1).unwrap();
    let seated = Id::new(Scope([0x71; 16]), 3).unwrap();
    let mut child = create(&h, n[1]);
    let Change::Create { pose, .. } = &mut child else {
        unreachable!()
    };
    pose.frame = Frame {
        node: n[0],
        slot: None,
    };
    pose.support = Support::Surface {
        surface: n[0],
        height: 0,
    };
    let recorded = HandOff {
        node: n[1],
        at: 3_000_000,
        from: Owner::Mover,
        to: Owner::Mover,
        pose: *pose,
        linear: Vec3::new(123, 0, 456),
        angular: Vec3::new(0, 789, 0),
    };
    let mut slotted = create(&h, seated);
    let Change::Create { pose, .. } = &mut slotted else {
        unreachable!()
    };
    pose.frame = Frame {
        node: n[0],
        slot: Some(7),
    };
    pose.support = Support::Slot;
    let mut hidden = create(&h, n[2]);
    let Change::Create {
        audience, fields, ..
    } = &mut hidden
    else {
        unreachable!()
    };
    *audience = private;
    fields.insert(
        77,
        Value::Text(Name::new("private:never-published").unwrap()),
    );
    let body = |sequence, at, node, audience, body| {
        Effect {
            envelope: Envelope {
                sequence,
                at,
                cause: Cause::World,
                actor: Actor::World,
                audience,
                node,
            },
            body,
            events: None,
            rest: Rest::new(),
        }
        .to_value()
    };
    let mut hidden_entry = entry(3, 0, h.zone, hidden);
    let Value::Map(m) = &mut hidden_entry else {
        unreachable!()
    };
    m.insert(
        5,
        Value::Map([(1, Value::Uint(2)), (2, n[0].to_value())].into()),
    );
    let mapping = TimeEffect::Mapping(Mapping::new(0, real, 1, 1).unwrap());
    let initial = vec![
        entry(0, 0, h.zone, create(&h, n[0])),
        entry(1, 0, n[0], child),
        entry(2, 0, n[0], slotted),
        hidden_entry,
        entry(4, 3_000_000, n[1], Change::Motion(recorded)),
        body(
            5,
            3_000_000,
            h.zone,
            Audience::Everyone,
            Body::Time(vec![mapping]),
        ),
        body(
            6,
            3_000_000,
            n[1],
            Audience::Everyone,
            Body::Timers(vec![TimerRec::Set {
                timer,
                due: 10_000_000,
                name: Name::new("souls:light").unwrap(),
            }]),
        ),
        body(
            7,
            3_000_000,
            n[2],
            private,
            Body::Timers(vec![TimerRec::Set {
                timer: private_timer,
                due: 10_000_000,
                name: Name::new("private:never-published").unwrap(),
            }]),
        ),
        entry(
            8,
            3_000_000,
            n[0],
            Change::Link {
                link: public_link,
                ty: Name::new("souls:near").unwrap(),
                ends: [n[0], n[1]],
                owner: End::First,
                audience: Audience::Everyone,
            },
        ),
        body(
            9,
            3_000_000,
            n[2],
            private,
            Body::Changes(vec![ChangeRec {
                change: Change::Link {
                    link: private_link,
                    ty: Name::new("private:never-published").unwrap(),
                    ends: [n[2], n[1]],
                    owner: End::First,
                    audience: private,
                },
                rest: Rest::new(),
            }]),
        ),
    ];
    tree.apply(&h, &part_of(&h, initial)).unwrap();
    let d = scratch("w3d-resume");
    let mut checkpoints =
        Checkpoints::open(&d.join("checkpoints"), 1 << 20, Blobs::default()).unwrap();
    let version = Version {
        lineage: h.lineage,
        zone: h.zone,
        epoch: h.epoch,
        sequence: tree.next(),
    };
    checkpoints
        .take(&mut tree, version, 4, b"checkpoint fixture")
        .unwrap();
    checkpoints.wait().unwrap();
    let restored = restore(&d.join("checkpoints")).unwrap().unwrap();
    assert_eq!(restored.root.record, 4);
    let state = restored.tree.to_state();
    let key = key(&h);
    assert!(matches!(
        Writer::fork(&d.join("strict-fork"), &h, &key, (0, 0), &state),
        Err(Refusal {
            name: "stream-start-moving",
            ..
        })
    ));
    assert!(
        !d.join("strict-fork").exists(),
        "the fork guard remains before publication"
    );
    let mut writer = Writer::resume(
        &d.join("views"),
        &h,
        &key,
        (real + 5_000_000, 1_000_005_000),
        &state,
    )
    .unwrap();
    assert_eq!(writer.anchor, (5_000_000, 1_000_005_000));
    let state_copy = writer.copy.tree().to_state();
    assert_eq!(
        state_copy.nodes[&n[1]], state.nodes[&n[1]],
        "exact non-slot frame/pose/nonzero hand-off"
    );
    assert_eq!(state_copy.nodes[&seated], state.nodes[&seated]);
    assert_eq!(state_copy.nodes[&seated].slot, Some(7));
    assert_eq!(state_copy.timers[&timer], state.timers[&timer]);
    assert!(!state_copy.nodes.contains_key(&n[2]));
    assert!(!state_copy.timers.contains_key(&private_timer));
    assert_eq!(state_copy.links[&public_link], state.links[&public_link]);
    assert!(!state_copy.links.contains_key(&private_link));
    assert_eq!(state_copy.time, state.time);

    let slower = TimeEffect::Mapping(Mapping::new(5_000_000, real + 5_000_000, 1, 2).unwrap());
    let changes = vec![
        body(
            10,
            5_000_000,
            n[1],
            Audience::Everyone,
            Body::Timers(vec![TimerRec::Clear { timer }]),
        ),
        body(
            11,
            5_000_000,
            h.zone,
            Audience::Everyone,
            Body::Time(vec![slower]),
        ),
    ];
    tree.apply(&h, &part_of(&h, changes.clone())).unwrap();
    writer.frame(&frame(changes)).unwrap();
    writer.idle_observed(real + 6_400_000).unwrap();
    assert_eq!(
        writer.written().parts,
        1,
        "pending slowdown has not settled window5; old mapping would cut it"
    );
    assert_eq!(writer.quiet_until, None, "no old-mapping future quiet time");
    writer.idle_observed(real + 8_000_000).unwrap();
    assert_eq!(writer.written().parts, 2);
    assert_eq!(writer.quiet_until, Some(6_250_000));
    assert_eq!(writer.copy.tree().time(), tree.time());

    let hb = fs::read(d.join("views").join(stream::header_path(&writer.header))).unwrap();
    let mut player = Player::start(&hb).unwrap();
    for number in 0..writer.written().parts {
        let bytes = fs::read(writer.dir().join(number.to_string())).unwrap();
        let result = player.play(&bytes).unwrap();
        if let Some(hash) = result.hash {
            assert!(hash);
        }
    }
    let played = player.replica().tree().to_state();
    assert_eq!(played.nodes[&n[1]], state.nodes[&n[1]]);
    assert_eq!(played.nodes[&seated], state.nodes[&seated]);
    assert_eq!(played.nodes[&seated].slot, Some(7));
    assert!(!played.nodes.contains_key(&n[2]));
    assert!(!played.timers.contains_key(&timer));
    assert!(!played.timers.contains_key(&private_timer));
    let public = |tree: &Tree| {
        tree.state_hashes_whole()
            .unwrap()
            .into_iter()
            .find(|(audience, _)| *audience == Audience::Everyone)
            .unwrap()
            .1
    };
    assert_eq!(public(player.replica().tree()), public(&tree));
    assert_eq!(player.replica().version(), tree.next());
    fs::remove_dir_all(d).unwrap();
}

/// V5b (#3460) A1 and A3: told the world's time, a writer with nothing to write marks its pointer quiet up to world-now
/// at least once a second and writes no empty part; the stretch of a burst after a still while is written once its time
/// has passed, within the page's lag, and the marks resume after it.
#[test]
fn a_still_world_is_marked_quiet_and_a_burst_after_it_is_written() {
    let h = header();
    let root = scratch("quiet");
    let mut w = Writer::create(&root, &h, &key(&h), (0, 0)).expect("a writer");
    let n = ids();
    let ptr = |w: &Writer| {
        Pointer::read(&fs::read(w.dir().join(POINTER)).expect("a pointer")).expect("read")
    };
    let mut marks: Vec<(i64, i64)> = Vec::new();
    let mut burst_written = None;
    // A record at 0.1 s, then a still world until 30 s, a burst at 30.2 s, still again until 40 s; told every 20 ms.
    for now in (0..=40_000_000i64).step_by(20_000) {
        if now == 100_000 {
            w.frame(&frame(vec![entry(0, now, h.zone, create(&h, n[0]))]))
                .expect("taken");
        }
        if now == 30_200_000 {
            w.frame(&frame(vec![entry(
                1,
                now,
                n[0],
                set(n[0], 1, Value::Uint(7)),
            )]))
            .expect("taken");
        }
        let before = w.written().parts;
        w.idle(now).expect("told");
        if w.written().parts > before && now > 30_000_000 {
            burst_written = Some(now);
        }
        if let Some(q) = ptr(&w).quiet_until {
            assert!(q <= now, "quiet until {q} is past world-now {now}");
            if marks.last().is_none_or(|m| m.1 != q) {
                marks.push((now, q));
            }
        }
    }
    // A1: two parts, the first record's and the burst's; none empty.
    assert_eq!(w.written().parts, 2);
    assert_eq!(w.written().entries, 2);
    assert!(!w.dir().join("2").exists());
    // A1: the pointer says "quiet" at least once a second through each still while, and never more than 1 s behind.
    let still = |from: i64, to: i64| {
        marks
            .iter()
            .filter(|m| m.0 >= from && m.0 <= to)
            .copied()
            .collect::<Vec<_>>()
    };
    for (from, to) in [(1_000_000, 30_000_000), (31_000_000, 40_000_000)] {
        let m = still(from, to);
        assert!(
            m.len() as i64 >= (to - from) / 1_000_000,
            "{} marks in {from}..{to}",
            m.len()
        );
        for p in m.windows(2) {
            assert!(
                p[1].0 - p[0].0 <= 1_000_000,
                "marks at {} and {} are more than 1 s apart",
                p[0].0,
                p[1].0
            );
        }
        for (at, q) in m {
            assert!(
                at - q <= 1_000_000,
                "at {at} the pointer is quiet only until {q}"
            );
        }
    }
    // A3: the burst's part is written within 1 s of its world time (the page plays 2 s behind), its stretch whole.
    let written = burst_written.expect("the burst was written");
    assert!(
        written - 30_200_000 <= 1_000_000,
        "the burst was written at {written}"
    );
    let p = ptr(&w);
    assert_eq!(p.newest, Some(1));
    assert_eq!(p.newest_to, Some(30_500_000));
    assert!(p.quiet_until.is_some_and(|q| q >= 39_000_000));
    println!(
        "V5b: {} quiet marks over 40 s of world time; the burst at 30.2 s written at {:.2} s",
        marks.len(),
        written as f64 / 1e6
    );
}

// #3639: the actual canonical producer and the shared native/WASM observer contract.
fn w3e_packet(h: &Header, effects: Vec<Effect>) -> Vec<u8> {
    wire(Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ])))
    .unwrap()
}
fn w3e_effect(seq: u64, node: Id, audience: Audience, body: Body) -> Effect {
    Effect {
        envelope: Envelope {
            sequence: seq,
            at: seq as i64 * 50_000,
            node,
            audience,
            cause: Cause::World,
            actor: Actor::World,
        },
        body,
        events: None,
        rest: Rest::new(),
    }
}
fn w3e_create(h: &Header, seq: u64, node: Id, parent: Id, audience: Audience) -> Effect {
    let mut change = create(h, node);
    if let Change::Create {
        pose, audience: a, ..
    } = &mut change
    {
        pose.frame.node = parent;
        pose.support = Support::Surface {
            surface: parent,
            height: 0,
        };
        *a = audience;
    }
    w3e_effect(
        seq,
        parent,
        audience,
        Body::Changes(vec![ChangeRec {
            change,
            rest: Rest::new(),
        }]),
    )
}
fn w3e_checkpoint(d: &Path, h: &Header, copy: &mut Replica, record: u64) -> Vec<u8> {
    use replica::ids::Version;
    let mut cp =
        sim::checkpoint::Checkpoints::open(d, 1, sim::checkpoint::Blobs::default()).unwrap();
    let version = Version {
        lineage: h.lineage,
        zone: h.zone,
        epoch: h.epoch,
        sequence: copy.version(),
    };
    cp.take(copy.tree_for_seal(), version, record, &[]).unwrap();
    cp.wait().unwrap();
    fs::read(d.join(format!("ckpt-{record:020}"))).unwrap()
}
fn w3e_query(which: u64, arg: Value) -> Vec<u8> {
    wire(Value::Map(BTreeMap::from([
        (1, Value::Uint(which)),
        (2, arg),
    ])))
    .unwrap()
}
// Canonical query bytes with only the audience projection applied; opaque path references stay explicit.
fn w3e_compare_transfer_queries(public: &PublicPlayer, canonical: &Replica, authorized: &[Id]) {
    for id in authorized {
        let Some(Value::Map(mut node)) = canonical.node(*id) else {
            continue;
        };
        if let Some(Value::Array(links)) = node.get_mut(&9) {
            links.retain(|l| matches!(l,Value::Array(r) if r.get(3)==Some(&Value::Map(BTreeMap::from([(1, Value::Uint(1))]))) && r.get(2).is_some_and(|i| authorized.iter().any(|id|i==&id.to_value()))));
        }
        assert_eq!(
            public.query(&w3e_query(1, id.to_value())).unwrap(),
            wire(Value::Map(node.clone())).unwrap(),
            "canonical node/version bytes"
        );
        node.remove(&10);
        let hash = replica::ids::Hash::of(
            replica::ids::Purpose::StatePublic,
            &wire(Value::Map(node)).unwrap(),
        );
        assert_eq!(
            public.query(&w3e_query(6, id.to_value())).unwrap(),
            wire(Value::Bytes(hash.to_bytes())).unwrap()
        );
        let children = canonical
            .children(*id, None)
            .unwrap()
            .into_iter()
            .filter(|i| authorized.contains(i))
            .map(Id::to_value)
            .collect();
        assert_eq!(
            public.query(&w3e_query(2, id.to_value())).unwrap(),
            wire(Value::Array(children)).unwrap()
        );
        let links = canonical
            .links(*id)
            .into_iter()
            .filter(|l| {
                l.audience == Audience::Everyone && l.ends.iter().all(|i| authorized.contains(i))
            })
            .map(|l| {
                Value::Array(vec![
                    l.link.to_value(),
                    Value::Text(l.ty),
                    Value::Array(l.ends.iter().map(|i| i.to_value()).collect()),
                    Value::Uint(u64::from(l.owner == replica::world_model::End::Second)),
                    Value::Map(BTreeMap::from([(1, Value::Uint(1))])),
                ])
            })
            .collect();
        assert_eq!(
            public.query(&w3e_query(3, id.to_value())).unwrap(),
            wire(Value::Array(links)).unwrap()
        );
        let path = canonical.path(*id).unwrap();
        if path.iter().all(|i| authorized.contains(i)) {
            assert_eq!(
                public.query(&w3e_query(4, id.to_value())).unwrap(),
                canonical.query(&w3e_query(4, id.to_value())).unwrap()
            );
        } else {
            assert_eq!(
                public.query(&w3e_query(4, id.to_value())).unwrap_err().name,
                "frame-unavailable"
            );
        }
    }
    for since in 0..=canonical.version() {
        let changed = canonical
            .changed_since(since)
            .into_iter()
            .filter(|(i, _)| authorized.contains(i))
            .map(|(i, v)| Value::Array(vec![i.to_value(), Value::Uint(v)]))
            .collect();
        assert_eq!(
            public.query(&w3e_query(5, Value::Uint(since))).unwrap(),
            wire(Value::Array(changed)).unwrap(),
            "canonical public changed_since {since}"
        );
    }
}

#[test]
fn w3e_exact_imported_root_frontier_queries_and_whole_part_refusal() {
    let mut value = if let Value::Map(m) = header().to_value() {
        m
    } else {
        unreachable!()
    };
    let root = Name::new(
        "eden:world@1220e1771ee3471091196ed3afb3796e05602c106a5e95aae791d1d5ba0ba5c01b86",
    )
    .unwrap();
    if let Some(Value::Array(kinds)) = value.get_mut(&6) {
        kinds.push(Value::Text(root.clone()));
    }
    let h = Header::read(&wire(Value::Map(value)).unwrap()).unwrap();
    let mut actual = Replica::restored(h.clone(), replica::tree::Tree::start(h.zone, root), 0);
    let d = scratch("w3e-root");
    let cp = w3e_checkpoint(&d.join("cp"), &h, &mut actual, 0);
    let store = directoryd::directory::store::Memory::default();
    let private = Id::new(Scope([91; 16]), 1).unwrap();
    let child = Id::new(Scope([92; 16]), 1).unwrap();
    let audience = Audience::Of(private);
    let words = Arc::new(
        Store::open_dir(
            &d.join("words"),
            replica::ids::Minter::at(Scope([58; 16]), 0),
        )
        .unwrap(),
    );
    let said = words
        .write(b"public event words", Audience::Everyone, child)
        .unwrap();
    let whisper = words
        .write(b"private never published", audience, private)
        .unwrap();
    let mut out = PublicWriter::open(
        PublicStart {
            root: &d.join("views"),
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 0,
            checkpoint: Some(cp),
            text: Some(words),
            clock_seed: None,
            history: None,
        },
        &store,
    )
    .unwrap();
    let mut secret = w3e_create(&h, 0, private, h.zone, audience);
    let mut public = w3e_create(&h, 1, child, private, Audience::Everyone);
    for (effect, reference) in [(&mut secret, whisper), (&mut public, said)] {
        effect.events = Some(vec![replica::effects::Event {
            name: Name::new("souls:said").unwrap(),
            fields: BTreeMap::from([(1, Value::Map(BTreeMap::from([(21, reference.to_value())])))]),
            changes: Vec::new(),
            rest: Rest::new(),
        }]);
    }
    let bytes = w3e_packet(&h, vec![secret, public]);
    actual.apply_bytes(&bytes).unwrap();
    out.push(0, &bytes).unwrap();
    out.flush().unwrap();
    assert_eq!(
        out.public_player().state(),
        &project(&h, &actual.tree().to_state()).unwrap()
    );
    let text = fs::read(out.generation_dir().join("0.text")).unwrap();
    let Value::Array(text) = decode(&text).unwrap().value else {
        panic!("text")
    };
    assert_eq!(
        text,
        vec![Value::Array(vec![
            said.to_value(),
            Value::Bytes(b"public event words".to_vec())
        ])],
        "actual public event words survive without private event words"
    );
    assert_eq!(out.public_player().events().len(), 1);
    let node = out
        .public_player()
        .query(&w3e_query(1, child.to_value()))
        .unwrap();
    let Value::Map(node) = decode(&node).unwrap().value else {
        panic!("node")
    };
    assert_eq!(node[&3], private.to_value());
    assert_eq!(
        out.public_player()
            .query(&w3e_query(1, private.to_value()))
            .unwrap_err()
            .name,
        "node-missing"
    );
    assert_eq!(
        out.public_player()
            .query(&w3e_query(4, child.to_value()))
            .unwrap_err()
            .name,
        "frame-unavailable"
    );
    for which in [2, 3, 6] {
        out.public_player()
            .query(&w3e_query(which, h.zone.to_value()))
            .unwrap();
    }
    out.public_player()
        .query(&w3e_query(5, Value::Uint(0)))
        .unwrap();
    let before = out.public_player().hash().unwrap();
    let cursor = out.source_cursor();
    let head = store.get(&format!("{}head", out.prefix)).unwrap().unwrap();
    let bad = w3e_packet(
        &h,
        vec![
            w3e_effect(
                2,
                child,
                Audience::Everyone,
                Body::Changes(vec![ChangeRec {
                    change: Change::Set {
                        node: child,
                        field: 77,
                        to: Value::Uint(1),
                        by: None,
                    },
                    rest: Rest::new(),
                }]),
            ),
            w3e_effect(4, child, Audience::Everyone, Body::Changes(Vec::new())),
        ],
    );
    assert_eq!(out.push(1, &bad).unwrap_err().name, "sequence-gap");
    assert_eq!(out.source_cursor(), cursor);
    assert_eq!(out.public_player().hash().unwrap(), before);
    assert_eq!(
        store.get(&format!("{}head", out.prefix)).unwrap().unwrap(),
        head
    );
}

#[test]
fn w3e_public_and_private_root_flights_return_settle_arrive_and_duplicate_events() {
    use replica::effects::{Event, TransferRec};
    for private_root in [false, true] {
        for ending in ["return", "settle", "arrive"] {
            let h = header();
            let d = scratch(&format!("w3e-flight-{private_root}-{ending}"));
            let mut actual = Replica::start(h.stored()).unwrap();
            let carrier = Id::new(Scope([81; 16]), 1).unwrap();
            let child = Id::new(Scope([82; 16]), 1).unwrap();
            let transfer = Id::new(Scope([83; 16]), 1).unwrap();
            let hidden = Audience::Of(carrier);
            let aud = if private_root {
                hidden
            } else {
                Audience::Everyone
            };
            let moving = if private_root { child } else { carrier };
            let parent = if private_root { carrier } else { h.zone };
            let motion = HandOff {
                node: moving,
                at: 100_000,
                from: replica::pose::Owner::Mover,
                to: replica::pose::Owner::Mover,
                pose: Pose {
                    frame: Frame {
                        node: parent,
                        slot: None,
                    },
                    position: Vec3::new(123, 0, 456),
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: parent,
                        height: 0,
                    },
                },
                linear: Vec3::new(1000, 0, 2000),
                angular: Vec3::ZERO,
            };
            let slotted = Id::new(Scope([84; 16]), 7).unwrap();
            let mut slot = create(&h, slotted);
            if let Change::Create { pose, .. } = &mut slot {
                pose.frame.slot = Some(7);
                pose.support = Support::Slot;
            }
            let branch = Id::new(Scope([85; 16]), 1).unwrap();
            let frontier = Id::new(Scope([86; 16]), 1).unwrap();
            let public_link = Id::new(Scope([87; 16]), 1).unwrap();
            let private_link = Id::new(Scope([88; 16]), 1).unwrap();
            let link = Change::Link {
                link: public_link,
                ty: Name::new("souls:near").unwrap(),
                ends: [moving, frontier],
                owner: End::First,
                audience: Audience::Everyone,
            };
            let secret = Change::Link {
                link: private_link,
                ty: Name::new("private:never-published").unwrap(),
                ends: [branch, frontier],
                owner: End::First,
                audience: hidden,
            };
            let first = w3e_packet(
                &h,
                vec![
                    w3e_create(&h, 0, carrier, h.zone, aud),
                    w3e_create(
                        &h,
                        1,
                        child,
                        carrier,
                        if private_root {
                            Audience::Everyone
                        } else {
                            hidden
                        },
                    ),
                    w3e_effect(
                        2,
                        moving,
                        Audience::Everyone,
                        Body::Changes(vec![ChangeRec {
                            change: Change::Motion(motion),
                            rest: Rest::new(),
                        }]),
                    ),
                    w3e_effect(
                        3,
                        h.zone,
                        Audience::Everyone,
                        Body::Changes(vec![ChangeRec {
                            change: slot,
                            rest: Rest::new(),
                        }]),
                    ),
                    w3e_create(&h, 4, branch, carrier, hidden),
                    w3e_create(&h, 5, frontier, branch, Audience::Everyone),
                    w3e_effect(
                        6,
                        moving,
                        Audience::Everyone,
                        Body::Changes(vec![ChangeRec {
                            change: link,
                            rest: Rest::new(),
                        }]),
                    ),
                    w3e_effect(
                        7,
                        branch,
                        hidden,
                        Body::Changes(vec![ChangeRec {
                            change: secret,
                            rest: Rest::new(),
                        }]),
                    ),
                ],
            );
            actual.apply_bytes(&first).unwrap();
            let destination = Pose {
                frame: Frame {
                    node: h.zone,
                    slot: None,
                },
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: h.zone,
                    height: 0,
                },
            };
            let leave = w3e_packet(
                &h,
                vec![w3e_effect(
                    8,
                    carrier,
                    aud,
                    Body::Transfer(TransferRec::Leave {
                        transfer,
                        node: carrier,
                        lineage: h.lineage,
                        zone: h.zone,
                        pose: destination,
                    }),
                )],
            );
            actual.apply_bytes(&leave).unwrap();
            // One real writer retains the validated blobs that earlier seals may reference.
            let cp_dir = d.join("cp");
            let mut checkpoints =
                sim::checkpoint::Checkpoints::open(&cp_dir, 1, sim::checkpoint::Blobs::default())
                    .unwrap();
            let mut checkpoint = |copy: &mut Replica, record: u64| {
                let version = replica::ids::Version {
                    lineage: h.lineage,
                    zone: h.zone,
                    epoch: h.epoch,
                    sequence: copy.version(),
                };
                checkpoints
                    .take(copy.tree_for_seal(), version, record, &[])
                    .unwrap();
                checkpoints
                    .wait()
                    .unwrap_or_else(|e| panic!("flight checkpoint record {record}: {e:?}"));
                fs::read(cp_dir.join(format!("ckpt-{record:020}"))).unwrap()
            };
            let cp = checkpoint(&mut actual, 2);
            // Match the ordinary checkpoint's canonical baseline: live nodes take its version; flying
            // nodes are not fabricated into the restored change index and retain canonical fallback zero.
            let mut actual = Replica::restored(h.clone(), actual.tree().frozen(), actual.version());
            let authorized = [h.zone, moving, frontier, slotted];
            let store = directoryd::directory::store::Memory::default();
            let mut out = PublicWriter::open(
                PublicStart {
                    root: &d.join("views"),
                    header: &h,
                    key: key(&h),
                    initial: actual.frozen(),
                    record: 2,
                    checkpoint: Some(cp),
                    text: None,
                    clock_seed: None,
                    history: None,
                },
                &store,
            )
            .unwrap();
            let public_bytes = wire(out.public_player().state().clone()).unwrap();
            let snapshot = decode(&out.public_player().snapshot().unwrap())
                .unwrap()
                .value;
            let Value::Array(snapshot) = snapshot else {
                panic!("snapshot")
            };
            assert!(snapshot.iter().any(|n|matches!(n,Value::Map(m) if m.get(&1)==Some(&slotted.to_value())&&m.get(&4)==Some(&Value::Uint(7)))));
            let projection = out.public_player().state();
            assert_eq!(projection, &project(&h, &actual.tree().to_state()).unwrap());
            let contains = |id: Id| {
                let encoded = wire(id.to_value()).unwrap();
                public_bytes.windows(encoded.len()).any(|w| w == encoded)
            };
            assert!(
                contains(public_link),
                "a private-root flight still carries its actual owned public links"
            );
            assert!(!contains(private_link));
            let Value::Map(projection) = projection else {
                panic!("projection")
            };
            let pairs = |v: &Value| {
                let Value::Array(rows) = v else {
                    panic!("pairs")
                };
                rows.iter()
                    .map(|r| {
                        let Value::Array(p) = r else { panic!("pair") };
                        (replica::effects::read_id(&p[0]).unwrap(), p[1].clone())
                    })
                    .collect::<BTreeMap<_, _>>()
            };
            let carried = if private_root {
                assert!(!contains(transfer));
                let nodes = pairs(&projection[&8]);
                assert_eq!(
                    nodes.len(),
                    2,
                    "two independent public frontiers in one private flight"
                );
                nodes
            } else {
                let flight = pairs(&projection[&4]);
                let Value::Map(f) = &flight[&transfer] else {
                    panic!("flight")
                };
                pairs(&f[&5])
            };
            let recorded = NodeState::read(&carried[&moving]).unwrap();
            let state = actual.tree().to_state();
            assert_eq!(recorded, state.in_flight[&transfer].nodes[&moving]);
            assert!(recorded.motion.is_some());
            assert_eq!(
                NodeState::read(&carried[&frontier]).unwrap().parent,
                Some(branch)
            );
            for id in [moving, frontier, h.zone] {
                let query = w3e_query(3, id.to_value());
                assert_eq!(
                    out.public_player().query(&query).unwrap(),
                    actual.query(&query).unwrap(),
                    "flying link query keeps canonical live-index semantics"
                );
            }
            w3e_compare_transfer_queries(out.public_player(), &actual, &authorized);
            // A newer ordinary checkpoint while the transfer is still in flight must not reset public
            // query versions. Remove every local public/recovery file and recover only the original Store.
            let advance = w3e_packet(
                &h,
                vec![w3e_effect(
                    9,
                    h.zone,
                    Audience::Everyone,
                    Body::Changes(Vec::new()),
                )],
            );
            actual.apply_bytes(&advance).unwrap();
            out.push(2, &advance).unwrap();
            out.flush().unwrap();
            let baseline = out.baseline.clone();
            let dir = out.generation_dir();
            let old_part = fs::read(dir.join("0")).unwrap();
            let newer = checkpoint(&mut actual, 3);
            drop(out);
            fs::remove_dir_all(d.join("views")).unwrap();
            let mut out = PublicWriter::open(
                PublicStart {
                    root: &d.join("views"),
                    header: &h,
                    key: key(&h),
                    initial: Replica::restored(h.clone(), actual.tree().frozen(), actual.version()),
                    record: 3,
                    checkpoint: Some(newer),
                    text: None,
                    clock_seed: None,
                    history: None,
                },
                &store,
            )
            .unwrap();
            assert_eq!(fs::read(dir.join("0")).unwrap(), old_part);
            w3e_compare_transfer_queries(out.public_player(), &actual, &authorized);
            let end = match ending {
                "return" => TransferRec::Return {
                    transfer,
                    reason: Name::new("souls:returned").unwrap(),
                },
                "settle" => TransferRec::Settle { transfer },
                _ => TransferRec::Arrive {
                    transfer,
                    carried: Vec::new(),
                },
            };
            let bytes = w3e_packet(&h, vec![w3e_effect(10, h.zone, aud, Body::Transfer(end))]);
            actual.apply_bytes(&bytes).unwrap();
            out.push(3, &bytes).unwrap();
            out.flush().unwrap();
            w3e_compare_transfer_queries(out.public_player(), &actual, &authorized);
            if ending == "return" {
                let bytes = fs::read(dir.join("1")).unwrap();
                for mode in ["wrong historical", "unrelated", "missing"] {
                    let mut reader = PublicPlayer::start(h.stored(), &baseline).unwrap();
                    reader.play(&old_part).unwrap();
                    let before = reader.hash().unwrap();
                    let before_version = reader.version();
                    let before_next = reader.next();
                    let mut part = object_map(&bytes).unwrap();
                    let mut context = object_map(&obj_bytes(&part, 10).unwrap()).unwrap();
                    let Value::Array(rows) = context.get_mut(&8).unwrap() else {
                        panic!("version rows")
                    };
                    match mode {
                        "wrong historical" => {
                            let row=rows.iter_mut().find(|r|matches!(r,Value::Array(p) if p.first()==Some(&moving.to_value()))).unwrap();
                            let Value::Array(row) = row else {
                                unreachable!()
                            };
                            row[1] = Value::Uint(1);
                        }
                        "unrelated" => {
                            rows.push(Value::Array(vec![slotted.to_value(), Value::Uint(0)]))
                        }
                        _ => rows.retain(
                            |r| !matches!(r,Value::Array(p) if p.first()==Some(&moving.to_value())),
                        ),
                    }
                    part.insert(10, Value::Bytes(wire(Value::Map(context)).unwrap()));
                    assert_eq!(
                        reader
                            .play(&wire(Value::Map(part)).unwrap())
                            .unwrap_err()
                            .name,
                        "public-stream-record",
                        "{mode}"
                    );
                    assert_eq!(reader.hash().unwrap(), before);
                    assert_eq!(reader.version(), before_version);
                    assert_eq!(reader.next(), before_next);
                }
                // A later live->Leave->Return retains a genuine known version, including through a newer
                // checkpoint taken while flying and a second Store-only cold reopen.
                let leave = w3e_packet(
                    &h,
                    vec![w3e_effect(
                        11,
                        carrier,
                        aud,
                        Body::Transfer(TransferRec::Leave {
                            transfer: Id::new(Scope([89; 16]), 1).unwrap(),
                            node: carrier,
                            lineage: h.lineage,
                            zone: h.zone,
                            pose: destination,
                        }),
                    )],
                );
                actual.apply_bytes(&leave).unwrap();
                out.push(4, &leave).unwrap();
                out.flush().unwrap();
                let cp = checkpoint(&mut actual, 5);
                drop(out);
                fs::remove_dir_all(d.join("views")).unwrap();
                let mut recovered = PublicWriter::open(
                    PublicStart {
                        root: &d.join("views"),
                        header: &h,
                        key: key(&h),
                        initial: Replica::restored(
                            h.clone(),
                            actual.tree().frozen(),
                            actual.version(),
                        ),
                        record: 5,
                        checkpoint: Some(cp),
                        text: None,
                        clock_seed: None,
                        history: None,
                    },
                    &store,
                )
                .unwrap();
                let returned = w3e_packet(
                    &h,
                    vec![w3e_effect(
                        12,
                        h.zone,
                        aud,
                        Body::Transfer(TransferRec::Return {
                            transfer: Id::new(Scope([89; 16]), 1).unwrap(),
                            reason: Name::new("souls:returned").unwrap(),
                        }),
                    )],
                );
                actual.apply_bytes(&returned).unwrap();
                recovered.push(5, &returned).unwrap();
                recovered.flush().unwrap();
                w3e_compare_transfer_queries(recovered.public_player(), &actual, &authorized);
                out = recovered;
            }
            assert_eq!(
                out.public_player().state(),
                &project(&h, &actual.tree().to_state()).unwrap()
            );
            if ending == "arrive" && !private_root {
                let mut duplicate = w3e_effect(
                    11,
                    h.zone,
                    aud,
                    Body::Transfer(TransferRec::Arrive {
                        transfer,
                        carried: Vec::new(),
                    }),
                );
                duplicate.events = Some(vec![Event {
                    name: Name::new("souls:arrived-again").unwrap(),
                    fields: BTreeMap::new(),
                    changes: Vec::new(),
                    rest: Rest::new(),
                }]);
                let bytes = w3e_packet(&h, vec![duplicate]);
                actual.apply_bytes(&bytes).unwrap();
                out.push(4, &bytes).unwrap();
                out.flush().unwrap();
                assert_eq!(out.public_player().events().len(), 1);
                assert_eq!(out.public_player().version(), 12);
                w3e_compare_transfer_queries(out.public_player(), &actual, &authorized);
                assert_eq!(
                    out.public_player().state(),
                    &project(&h, &actual.tree().to_state()).unwrap()
                );
            }
        }
    }
}

#[test]
fn w3e_store_only_restart_preserves_old_bytes_cursor_and_live_reader() {
    let h = header();
    let d = scratch("w3e-cold");
    let views = d.join("views");
    let store = directoryd::directory::store::Memory::default();
    let mut actual = Replica::start(h.stored()).unwrap();
    let mut out = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    )
    .unwrap();
    let body = Id::new(Scope([71; 16]), 1).unwrap();
    let first = w3e_packet(
        &h,
        vec![w3e_create(&h, 0, body, h.zone, Audience::Everyone)],
    );
    actual.apply_bytes(&first).unwrap();
    out.push(0, &first).unwrap();
    out.flush().unwrap();
    let baseline = out.baseline.clone();
    let dir = out.generation_dir();
    let old = fs::read(dir.join("0")).unwrap();
    let header_bytes = fs::read(views.join(stream::header_path(&h))).unwrap();
    let mut open = PublicPlayer::start(&header_bytes, &baseline).unwrap();
    open.play(&old).unwrap();
    drop(out);
    let cp = w3e_checkpoint(&d.join("newer-cp"), &h, &mut actual, 1);
    // No local public files or recovery metadata remain. The newest ordinary checkpoint is deliberately newer
    // than the generation source; recovery must use the Store's exact source and existing immutable bytes.
    fs::remove_dir_all(&views).unwrap();
    let mut recovered = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 1,
            checkpoint: Some(cp),
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    )
    .unwrap();
    assert_eq!(fs::read(dir.join("0")).unwrap(), old);
    assert_eq!(
        fs::read(views.join(stream::header_path(&h))).unwrap(),
        header_bytes
    );
    assert_eq!(recovered.source_cursor(), 1);
    let next = w3e_packet(
        &h,
        vec![w3e_effect(
            1,
            body,
            Audience::Everyone,
            Body::Changes(vec![ChangeRec {
                change: Change::Set {
                    node: body,
                    field: 40,
                    to: Value::Uint(9),
                    by: None,
                },
                rest: Rest::new(),
            }]),
        )],
    );
    actual.apply_bytes(&next).unwrap();
    recovered.push(1, &next).unwrap();
    recovered.flush().unwrap();
    let bytes = fs::read(dir.join("1")).unwrap();
    open.play(&bytes).unwrap();
    assert_eq!(open.state(), recovered.public_player().state());
    let mut fresh = PublicPlayer::start(h.stored(), &baseline).unwrap();
    fresh.play(&old).unwrap();
    fresh.play(&bytes).unwrap();
    assert_eq!(fresh.hash().unwrap(), open.hash().unwrap());
    assert_eq!(fs::read(dir.join("0")).unwrap(), old);
    let mut untouched = PublicPlayer::start(h.stored(), &baseline).unwrap();
    let before = untouched.hash().unwrap();
    let mut corrupted = object_map(&old).unwrap();
    corrupted.insert(7, Value::Bytes(vec![0; 32]));
    assert_eq!(
        untouched
            .play(&wire(Value::Map(corrupted)).unwrap())
            .unwrap_err()
            .name,
        "public-stream-record"
    );
    assert_eq!(untouched.hash().unwrap(), before);
    let mut corrupted = object_map(&old).unwrap();
    let mut context = object_map(&obj_bytes(&corrupted, 10).unwrap()).unwrap();
    context.insert(2, Value::Bytes(vec![0; 32]));
    corrupted.insert(10, Value::Bytes(wire(Value::Map(context)).unwrap()));
    assert_eq!(
        untouched
            .play(&wire(Value::Map(corrupted)).unwrap())
            .unwrap_err()
            .name,
        "public-stream-record"
    );
    assert_eq!(untouched.hash().unwrap(), before);
}

#[test]
fn w3e_complete_query_bytes_keep_nonzero_restored_baseline_and_untouched_node_versions() {
    let h = header();
    let d = scratch("w3e-query");
    let store = directoryd::directory::store::Memory::default();
    let mut actual = Replica::start(h.stored()).unwrap();
    let body = Id::new(Scope([60; 16]), 1).unwrap();
    let other = Id::new(Scope([60; 16]), 2).unwrap();
    let link = Id::new(Scope([60; 16]), 3).unwrap();
    actual
        .apply_bytes(&w3e_packet(
            &h,
            vec![
                w3e_create(&h, 0, body, h.zone, Audience::Everyone),
                w3e_create(&h, 1, other, h.zone, Audience::Everyone),
            ],
        ))
        .unwrap();
    let cp = w3e_checkpoint(&d.join("cp"), &h, &mut actual, 1);
    // A public checkpoint is an observation baseline, with the same documented changed-at semantics as the
    // existing canonical restored replica: every live node starts at that baseline version, not a guessed past.
    let mut actual = Replica::restored(h.clone(), actual.tree().frozen(), actual.version());
    let mut out = PublicWriter::open(
        PublicStart {
            root: &d.join("views"),
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 1,
            checkpoint: Some(cp),
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    )
    .unwrap();
    let compare = |public: &PublicPlayer, canonical: &Replica, ids: &[Id]| {
        for id in ids {
            for which in [1, 2, 3, 4, 6] {
                let q = w3e_query(which, id.to_value());
                assert_eq!(
                    public.query(&q).unwrap(),
                    canonical.query(&q).unwrap(),
                    "exact public query {which}"
                );
            }
        }
        for since in [0, 1, 2, 3, 4, 5] {
            let q = w3e_query(5, Value::Uint(since));
            assert_eq!(
                public.query(&q).unwrap(),
                canonical.query(&q).unwrap(),
                "exact change query since {since}"
            );
        }
    };
    compare(out.public_player(), &actual, &[h.zone, body, other]);
    let bytes = w3e_packet(
        &h,
        vec![w3e_effect(
            2,
            body,
            Audience::Everyone,
            Body::Changes(vec![ChangeRec {
                change: set(body, 40, Value::Uint(7)),
                rest: Rest::new(),
            }]),
        )],
    );
    actual.apply_bytes(&bytes).unwrap();
    out.push(1, &bytes).unwrap();
    out.flush().unwrap();
    compare(out.public_player(), &actual, &[h.zone, body, other]);
    let Value::Map(root) = decode(
        &out.public_player()
            .query(&w3e_query(1, h.zone.to_value()))
            .unwrap(),
    )
    .unwrap()
    .value
    else {
        panic!("root")
    };
    assert_eq!(
        root[&10],
        Value::Uint(2),
        "an untouched root does not advance with the public version"
    );
    let bytes = w3e_packet(
        &h,
        vec![w3e_effect(
            3,
            body,
            Audience::Everyone,
            Body::Changes(vec![ChangeRec {
                change: Change::Link {
                    link,
                    ty: Name::new("souls:near").unwrap(),
                    ends: [body, other],
                    owner: End::First,
                    audience: Audience::Everyone,
                },
                rest: Rest::new(),
            }]),
        )],
    );
    actual.apply_bytes(&bytes).unwrap();
    out.push(2, &bytes).unwrap();
    out.flush().unwrap();
    compare(out.public_player(), &actual, &[h.zone, body, other]);
    let bytes = w3e_packet(
        &h,
        vec![w3e_effect(
            4,
            other,
            Audience::Everyone,
            Body::Changes(vec![ChangeRec {
                change: Change::Remove { node: other },
                rest: Rest::new(),
            }]),
        )],
    );
    actual.apply_bytes(&bytes).unwrap();
    out.push(3, &bytes).unwrap();
    out.flush().unwrap();
    compare(out.public_player(), &actual, &[h.zone, body]);
    assert_eq!(
        out.public_player()
            .query(&w3e_query(1, other.to_value()))
            .unwrap_err()
            .name,
        "node-missing"
    );
}

#[test]
fn w3e_legacy_terminal_inside_source_part_keeps_exact_private_remainder() {
    let h = header();
    let d = scratch("w3e-legacy");
    let views = d.join("views");
    let initial = Replica::start(h.stored()).unwrap();
    let body = Id::new(Scope([61; 16]), 1).unwrap();
    let hidden = Id::new(Scope([62; 16]), 1).unwrap();
    let public = w3e_create(&h, 0, body, h.zone, Audience::Everyone);
    let private = w3e_create(&h, 1, hidden, h.zone, Audience::Of(hidden));
    let original = w3e_packet(&h, vec![public.clone(), private]);
    let mut legacy = Writer::create(&views, &h, &key(&h), (0, 0)).unwrap();
    legacy.frame(&frame(vec![public.to_value()])).unwrap();
    legacy.flush().unwrap();
    let old = fs::read(legacy.dir().join("0")).unwrap();
    let mut old_reader = Player::start(h.stored()).unwrap();
    old_reader.play(&old).unwrap();
    assert_eq!(old_reader.replica().version(), 1);
    let history = sim::log::Recovered {
        header: None,
        first: 0,
        start: 0,
        records: vec![original],
        end: 0,
        last_crc: 0,
        torn: None,
    };
    let store = directoryd::directory::store::Memory::default();
    let mut out = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial,
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: Some(&history),
        },
        &store,
    )
    .unwrap();
    assert_eq!(out.source_cursor(), 1);
    assert_eq!(out.public_player().version(), 1);
    assert_eq!(out.canonical.version(), 2);
    assert_eq!(
        out.player.hash().unwrap(),
        digest(&project(&h, &old_reader.replica().tree().to_state()).unwrap()).unwrap()
    );
    out.flush().unwrap();
    assert_eq!(out.public_player().version(), 2);
    assert!(out.public_player().events().is_empty());
    assert_eq!(fs::read(legacy.dir().join("0")).unwrap(), old);
    let remainder = fs::read(out.generation_dir().join("0")).unwrap();
    let part = StreamPart::read(&remainder).unwrap();
    assert_eq!(part.entries, 0);
    assert_eq!(part.gaps, vec![(1, 1)]);
    drop(out);
    fs::remove_dir_all(&views).unwrap();
    let mut recovered = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: Replica::start(h.stored()).unwrap(),
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    )
    .unwrap();
    assert_eq!(recovered.public_player().version(), 2);
    assert_eq!(fs::read(legacy.dir().join("0")).unwrap(), old);
    assert_eq!(
        fs::read(recovered.generation_dir().join("0")).unwrap(),
        remainder
    );
    recovered.flush().unwrap();
}

#[derive(Default)]
struct W3eFaultStore {
    inner: directoryd::directory::store::Memory,
    fail_head: std::cell::Cell<bool>,
    missing: std::cell::RefCell<Option<String>>,
    corrupt: std::cell::RefCell<Option<String>>,
}
impl ObjectStore for W3eFaultStore {
    fn get(&self, key: &str) -> R<Option<directoryd::directory::store::Object>> {
        if self.missing.borrow().as_deref() == Some(key) {
            return Ok(None);
        }
        let mut object = self.inner.get(key)?;
        if self.corrupt.borrow().as_deref() == Some(key)
            && let Some(o) = &mut object
        {
            o.bytes.push(0);
        }
        Ok(object)
    }
    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        if key.ends_with("/head") && self.fail_head.get() {
            return Err(fault(
                "store-unreachable",
                "injected publication interruption",
            ));
        }
        self.inner.put(key, bytes, when)
    }
    fn list(&self, prefix: &str) -> R<Vec<String>> {
        self.inner.list(prefix)
    }
}

#[test]
fn w3e_publication_interruptions_and_corrupt_or_missing_recovery_never_publish_false_ready() {
    let h = header();
    let d = scratch("w3e-atomic");
    let views = d.join("views");
    let store = W3eFaultStore::default();
    let actual = Replica::start(h.stored()).unwrap();
    let mut out = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    )
    .unwrap();
    let pointer = fs::read(out.dir.join(POINTER)).unwrap();
    let initial_head = store.get(&format!("{}head", out.prefix)).unwrap().unwrap();
    let body = Id::new(Scope([59; 16]), 1).unwrap();
    let bytes = w3e_packet(
        &h,
        vec![w3e_create(&h, 0, body, h.zone, Audience::Everyone)],
    );
    out.push(0, &bytes).unwrap();
    store.fail_head.set(true);
    assert_eq!(out.flush().unwrap_err().name, "store-unreachable");
    assert_eq!(fs::read(out.dir.join(POINTER)).unwrap(), pointer);
    assert!(!out.generation_dir().join("0").exists());
    assert_eq!(
        store.get(&format!("{}head", out.prefix)).unwrap().unwrap(),
        initial_head
    );
    drop(out);
    store.fail_head.set(false);
    let mut out = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    )
    .unwrap();
    // The conditional head commits before local publication. An interrupted/mismatched local file is never
    // overwritten; a clean cold restore recovers exactly the committed bytes, including its source cursor.
    out.push(0, &bytes).unwrap();
    let dir = out.generation_dir();
    fs::write(dir.join("0"), b"unpublished interruption").unwrap();
    assert_eq!(out.flush().unwrap_err().name, "stream-immutable");
    assert_eq!(
        fs::read(dir.join("0")).unwrap(),
        b"unpublished interruption"
    );
    drop(out);
    fs::remove_dir_all(&views).unwrap();
    let out = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    )
    .unwrap();
    assert_eq!(out.public_player().version(), 1);
    assert_eq!(out.source_cursor(), 1);
    let valid = fs::read(dir.join("0")).unwrap();
    assert_ne!(valid, b"unpublished interruption");
    let prefix = out.prefix.clone();
    drop(out);
    fs::remove_dir_all(&views).unwrap();
    let head = object_map(&store.get(&format!("{prefix}head")).unwrap().unwrap().bytes).unwrap();
    let required = format!(
        "{prefix}objects/{}",
        replica::encode::to_hex(&obj_bytes(&head, 1).unwrap())
    );
    store.missing.replace(Some(required.clone()));
    let result = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    );
    assert!(matches!(
        result,
        Err(Refusal {
            name: "stream-recovery-missing",
            ..
        })
    ));
    assert!(!views.join(stream::dir(&h, &key(&h))).join(POINTER).exists());
    store.missing.replace(None);
    store.corrupt.replace(Some(required));
    let result = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual,
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    );
    assert!(matches!(
        result,
        Err(Refusal {
            name: "stream-recovery-hash",
            ..
        })
    ));
    assert!(!views.join(stream::dir(&h, &key(&h))).join(POINTER).exists());
}

#[test]
fn w3e_first_durable_mapping_timers_and_pending_slowdown_remain_authoritative() {
    let h = header();
    let d = scratch("w3e-time");
    let views = d.join("views");
    let real = 1_000_000_000_000;
    let mapping = Mapping::new(0, real, 1, 1).unwrap();
    let mut actual = Replica::start(h.stored()).unwrap();
    let cp = w3e_checkpoint(&d.join("cp"), &h, &mut actual, 0);
    let store = directoryd::directory::store::Memory::default();
    let mut out = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 0,
            checkpoint: Some(cp),
            text: None,
            clock_seed: Some(mapping),
            history: None,
        },
        &store,
    )
    .unwrap();
    let body = Id::new(Scope([57; 16]), 1).unwrap();
    let timer = Id::new(Scope([57; 16]), 2).unwrap();
    let first = w3e_packet(
        &h,
        vec![
            w3e_effect(
                0,
                h.zone,
                Audience::Everyone,
                Body::Time(vec![TimeEffect::Mapping(mapping)]),
            ),
            w3e_create(&h, 1, body, h.zone, Audience::Everyone),
            w3e_effect(
                2,
                body,
                Audience::Everyone,
                Body::Timers(vec![TimerRec::Set {
                    timer,
                    due: 10_000_000,
                    name: Name::new("souls:light").unwrap(),
                }]),
            ),
        ],
    );
    actual.apply_bytes(&first).unwrap();
    out.push(0, &first).unwrap();
    out.flush().unwrap();
    for which in [1, 2, 3, 4, 6] {
        assert_eq!(
            out.public_player()
                .query(&w3e_query(which, body.to_value()))
                .unwrap(),
            actual.query(&w3e_query(which, body.to_value())).unwrap(),
            "complete query ABI {which}"
        );
    }
    assert_eq!(
        out.public_player()
            .query(&w3e_query(5, Value::Uint(0)))
            .unwrap(),
        actual.query(&w3e_query(5, Value::Uint(0))).unwrap()
    );
    let mut clear = w3e_effect(
        3,
        body,
        Audience::Everyone,
        Body::Timers(vec![TimerRec::Clear { timer }]),
    );
    clear.envelope.at = 5_000_000;
    let mut slow = w3e_effect(
        4,
        h.zone,
        Audience::Everyone,
        Body::Time(vec![TimeEffect::Mapping(
            Mapping::new(5_000_000, real + 5_000_000, 1, 2).unwrap(),
        )]),
    );
    slow.envelope.at = 5_000_000;
    let later = w3e_packet(&h, vec![clear, slow]);
    actual.apply_bytes(&later).unwrap();
    out.push(1, &later).unwrap();
    let previous = fs::read(out.dir.join(POINTER)).unwrap();
    out.idle(real + 6_400_000).unwrap();
    assert_eq!(
        out.public_player().next(),
        1,
        "pending slowdown has not settled its stretch"
    );
    assert_eq!(
        fs::read(out.dir.join(POINTER)).unwrap(),
        previous,
        "pending visibility cannot publish old-mapping quiet time"
    );
    out.idle(real + 8_000_000).unwrap();
    assert_eq!(out.public_player().next(), 2);
    assert_eq!(
        out.public_player().state(),
        &project(&h, &actual.tree().to_state()).unwrap()
    );
    let pointer = Pointer::read(&fs::read(out.dir.join(POINTER)).unwrap()).unwrap();
    assert_eq!(pointer.quiet_until, Some(6_250_000));
    let mut reader = PublicPlayer::start(h.stored(), &out.baseline).unwrap();
    for n in 0..2 {
        reader
            .play(&fs::read(out.generation_dir().join(n.to_string())).unwrap())
            .unwrap();
    }
    assert_eq!(reader.state(), out.public_player().state());
}

#[test]
fn w3e_older_eligible_checkpoint_and_takeover_aware_original_source_bridge_legacy_terminal() {
    let h = header();
    let d = scratch("w3e-earlier");
    let views = d.join("views");
    let checkpoints = d.join("checkpoints");
    let mut actual = Replica::start(h.stored()).unwrap();
    let older = w3e_checkpoint(&checkpoints, &h, &mut actual, 0);
    let body = Id::new(Scope([55; 16]), 1).unwrap();
    let hidden = Id::new(Scope([56; 16]), 1).unwrap();
    let public = w3e_create(&h, 0, body, h.zone, Audience::Everyone);
    let original = w3e_packet(
        &h,
        vec![
            public.clone(),
            w3e_create(&h, 1, hidden, h.zone, Audience::Of(hidden)),
        ],
    );
    actual.apply_bytes(&original).unwrap();
    let newer = w3e_checkpoint(&checkpoints, &h, &mut actual, 1);
    let mut legacy = Writer::create(&views, &h, &key(&h), (0, 0)).unwrap();
    legacy.frame(&frame(vec![public.to_value()])).unwrap();
    legacy.flush().unwrap();
    let old = fs::read(legacy.dir().join("0")).unwrap();
    let history = sim::log::Recovered {
        header: None,
        first: 2,
        start: 0,
        records: Vec::new(),
        end: 0,
        last_crc: 0,
        torn: None,
    };
    let store = directoryd::directory::store::Memory::default();
    let takeover = replica::durability::Takeover {
        epoch: h.epoch,
        from: 0,
        machine: Name::new("fixture-authority").unwrap(),
        token: replica::durability::Token([7; 16]),
    };
    let successor = replica::durability::Takeover {
        epoch: h.epoch + 1,
        from: 1,
        machine: Name::new("fixture-successor").unwrap(),
        token: replica::durability::Token([8; 16]),
    };
    let authority = replica::directory::WorldRecord {
        lineage: h.lineage.0,
        zone: h.zone,
        takeovers: vec![takeover.clone(), successor.clone()],
        mark: Some(1),
        wake: None,
        build: h.build.clone(),
        writes: 2,
    };
    store
        .put(
            &replica::directory::WorldRecord::key(&h.lineage.0, h.zone),
            &authority.to_bytes().unwrap(),
            When::Absent,
        )
        .unwrap();
    let superseded = w3e_packet(
        &h,
        vec![w3e_effect(
            999,
            body,
            Audience::Everyone,
            Body::Changes(Vec::new()),
        )],
    );
    let piece = crate::shipping::Piece {
        header: h.stored().to_vec(),
        first: 0,
        records: vec![original, superseded],
    };
    let piece_key = replica::durability::part_key(&h.lineage.0, h.zone, &takeover, 0);
    store
        .put(&piece_key, &piece.to_bytes().unwrap(), When::Absent)
        .unwrap();
    let mut start = PublicStart {
        root: &views,
        header: &h,
        key: key(&h),
        initial: actual.frozen(),
        record: 1,
        checkpoint: Some(newer),
        text: None,
        clock_seed: None,
        history: Some(&history),
    };
    start.earlier_legacy_checkpoint(&checkpoints).unwrap();
    assert_eq!(start.record, 0);
    assert_eq!(start.initial.version(), 0);
    assert_eq!(start.checkpoint.as_ref().unwrap(), &older);
    assert_eq!(actual.version(), 2, "the engine's newest copy is untouched");
    // The engine's normal K5 writer retains only its newest two files. Captured public source bytes must survive
    // that pruning; no observer IO is allowed to depend on the earlier pathname after answers starts.
    let restored = sim::checkpoint::read_bytes(start.checkpoint.as_ref().unwrap()).unwrap();
    assert_eq!(
        capture_checkpoint(
            &checkpoints.join("ckpt-00000000000000000000"),
            &restored.root
        )
        .unwrap(),
        older
    );
    let selected_root = restored.root;
    let mut newest = sim::checkpoint::restore(&checkpoints).unwrap().unwrap();
    let mut writer = sim::checkpoint::Checkpoints::open(&checkpoints, 1, newest.blobs).unwrap();
    writer
        .take(&mut newest.tree, newest.root.version, 2, &[])
        .unwrap();
    writer.wait().unwrap();
    assert!(
        !checkpoints.join("ckpt-00000000000000000000").exists(),
        "normal pruning removed the captured source"
    );
    assert_eq!(
        capture_checkpoint(
            &checkpoints.join("ckpt-00000000000000000000"),
            &selected_root
        )
        .unwrap_err()
        .name,
        "stream-source-missing"
    );
    assert_eq!(
        sim::checkpoint::read_bytes(start.checkpoint.as_ref().unwrap())
            .unwrap()
            .root,
        selected_root
    );
    let next = w3e_packet(
        &h,
        vec![w3e_effect(
            2,
            body,
            Audience::Everyone,
            Body::Changes(vec![ChangeRec {
                change: set(body, 40, Value::Uint(9)),
                rest: Rest::new(),
            }]),
        )],
    );
    let piece = crate::shipping::Piece {
        header: h.stored().to_vec(),
        first: 1,
        records: vec![next],
    };
    store
        .put(
            &replica::durability::part_key(&h.lineage.0, h.zone, &successor, 1),
            &piece.to_bytes().unwrap(),
            When::Absent,
        )
        .unwrap();
    let mut out = PublicWriter::open(start, &store).unwrap();
    assert_eq!(out.public_player().version(), 1);
    assert_eq!(out.source_cursor(), 1);
    out.bridge_to(2).unwrap();
    assert_eq!(out.source_cursor(), 2);
    out.flush().unwrap();
    assert_eq!(out.public_player().version(), 3);
    assert_eq!(fs::read(legacy.dir().join("0")).unwrap(), old);
}

#[test]
fn w3e_bootstrap_source_diagnostics_name_missing_changed_header_and_part() {
    let h = header();
    let d = scratch("w3e-source-stages");
    let views = d.join("views");
    let checkpoints = d.join("checkpoints");
    let mut actual = Replica::start(h.stored()).unwrap();
    let checkpoint = w3e_checkpoint(&checkpoints, &h, &mut actual, 0);
    let root = sim::checkpoint::read_bytes(&checkpoint).unwrap().root;
    let checkpoint_path = checkpoints.join("ckpt-00000000000000000000");
    let mut wrong = root.clone();
    wrong.record = 1;
    assert_eq!(
        capture_checkpoint(&checkpoint_path, &wrong)
            .unwrap_err()
            .name,
        "stream-source-changed"
    );
    fs::write(&checkpoint_path, b"damaged checkpoint").unwrap();
    let invalid = capture_checkpoint(&checkpoint_path, &root).unwrap_err();
    assert_eq!(invalid.name, "stream-source-invalid");
    assert!(
        invalid
            .detail
            .starts_with("selected checkpoint validation:")
    );
    fs::write(&checkpoint_path, &checkpoint).unwrap();
    let body = Id::new(Scope([57; 16]), 1).unwrap();
    let public = w3e_create(&h, 0, body, h.zone, Audience::Everyone);
    let mut legacy = Writer::create(&views, &h, &key(&h), (0, 0)).unwrap();
    legacy.frame(&frame(vec![public.to_value()])).unwrap();
    legacy.flush().unwrap();
    let select = || {
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 0,
            checkpoint: Some(checkpoint.clone()),
            text: None,
            clock_seed: None,
            history: None,
        }
        .earlier_legacy_checkpoint(&checkpoints)
    };
    let header_path = views.join(stream::header_path(&h));
    let header_bytes = fs::read(&header_path).unwrap();
    fs::remove_file(&header_path).unwrap();
    let missing = select().unwrap_err();
    assert_eq!(missing.name, "stream-source-missing");
    assert!(missing.detail.starts_with("legacy header bytes:"));
    fs::write(&header_path, b"damaged header").unwrap();
    let invalid = select().unwrap_err();
    assert_eq!(invalid.name, "stream-source-invalid");
    assert!(invalid.detail.starts_with("legacy header validation:"));
    fs::write(&header_path, header_bytes).unwrap();
    fs::write(legacy.dir().join("0"), b"damaged part").unwrap();
    let invalid = select().unwrap_err();
    assert_eq!(invalid.name, "stream-source-invalid");
    assert!(invalid.detail.starts_with("legacy part validation:"));
    fs::remove_file(legacy.dir().join("0")).unwrap();
    let missing = select().unwrap_err();
    assert_eq!(missing.name, "stream-source-missing");
    assert!(missing.detail.starts_with("legacy part bytes:"));
}

/// #3667: the public writer replays a recorded log entry by entry, reading its tree instead of building a whole state
/// per entry. Its public output (every part and text file, the baseline and the public state) is byte-identical to the
/// whole-state replay's (the code before the change, kept as the test's reference), on a log with a migration cut
/// inside a source part, several entries per part, transfers that leave, arrive, arrive again, return and settle, an
/// arrival from another zone and a private entry.
#[test]
fn replay_reads_the_tree_and_publishes_the_same_bytes_as_the_whole_state_path() {
    let reference = replay_output(true);
    let tree = replay_output(false);
    println!(
        "3667 replay output: whole state {} bytes, tree {} bytes, {}",
        reference.len(),
        tree.len(),
        if reference == tree {
            "equal"
        } else {
            "DIFFERENT"
        }
    );
    assert!(reference.len() > 1000, "the log published");
    assert!(reference == tree, "the tree-reading replay differs");
}

fn replay_output(whole_state: bool) -> Vec<u8> {
    use replica::effects::TransferRec;
    WHOLE_STATE.set(whole_state);
    let h = header();
    let d = scratch(&format!("3667-replay-{whole_state}"));
    let views = d.join("views");
    let n = |s: u8| Id::new(Scope([0x90 + s; 16]), 1).unwrap();
    let (body, hidden, carrier, child, foreign) = (n(1), n(2), n(3), n(4), n(5));
    let (t1, t2, t3, t4) = (n(6), n(7), n(8), n(9));
    let everyone = Audience::Everyone;
    let destination = Pose {
        frame: Frame {
            node: h.zone,
            slot: None,
        },
        position: Vec3::new(5, 0, 5),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: h.zone,
            height: 0,
        },
    };
    let leave = |seq: u64, node: Id, transfer: Id| {
        w3e_effect(
            seq,
            node,
            everyone,
            Body::Transfer(TransferRec::Leave {
                transfer,
                node,
                lineage: h.lineage,
                zone: h.zone,
                pose: destination,
            }),
        )
    };
    let end = |seq: u64, rec: TransferRec| w3e_effect(seq, h.zone, everyone, Body::Transfer(rec));
    let change = |seq: u64, node: Id, audience: Audience, c: Change| {
        w3e_effect(
            seq,
            node,
            audience,
            Body::Changes(vec![ChangeRec {
                change: c,
                rest: Rest::new(),
            }]),
        )
    };
    let public = w3e_create(&h, 0, body, h.zone, everyone);
    // The legacy stream ends after entry 0, inside the first source part: the migration cut.
    let original = w3e_packet(
        &h,
        vec![
            public.clone(),
            w3e_create(&h, 1, hidden, h.zone, Audience::Of(hidden)),
            w3e_create(&h, 2, carrier, h.zone, everyone),
            w3e_create(&h, 3, child, carrier, everyone),
        ],
    );
    let mut legacy = Writer::create(&views, &h, &key(&h), (0, 0)).unwrap();
    legacy.frame(&frame(vec![public.to_value()])).unwrap();
    legacy.flush().unwrap();
    let history = sim::log::Recovered {
        header: None,
        first: 0,
        start: 0,
        records: vec![original],
        end: 0,
        last_crc: 0,
        torn: None,
    };
    let store = directoryd::directory::store::Memory::default();
    let mut out = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: Replica::start(h.stored()).unwrap(),
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: Some(&history),
        },
        &store,
    )
    .unwrap();
    out.flush().unwrap();
    let mut source = Replica::start(h.stored()).unwrap();
    source.apply_bytes(&history.records[0]).unwrap();
    let foreign_create = match w3e_create(&h, 0, foreign, h.zone, everyone).body {
        Body::Changes(cs) => cs,
        _ => unreachable!(),
    };
    let log = vec![
        vec![
            leave(4, carrier, t1),
            change(5, body, everyone, set(body, 1, Value::Uint(7))),
        ],
        vec![end(
            6,
            TransferRec::Arrive {
                transfer: t1,
                carried: Vec::new(),
            },
        )],
        vec![end(
            7,
            TransferRec::Arrive {
                transfer: t1,
                carried: Vec::new(),
            },
        )],
        vec![
            leave(8, child, t2),
            // A return is written by the node the subtree left.
            w3e_effect(
                9,
                carrier,
                everyone,
                Body::Transfer(TransferRec::Return {
                    transfer: t2,
                    reason: Name::new("souls:returned").unwrap(),
                }),
            ),
        ],
        vec![leave(10, body, t3)],
        vec![end(11, TransferRec::Settle { transfer: t3 })],
        vec![end(
            12,
            TransferRec::Arrive {
                transfer: t4,
                carried: foreign_create,
            },
        )],
        vec![change(
            13,
            hidden,
            Audience::Of(hidden),
            set(hidden, 1, Value::Uint(3)),
        )],
    ];
    for (i, effects) in log.into_iter().enumerate() {
        let bytes = w3e_packet(&h, effects);
        source.apply_bytes(&bytes).unwrap();
        out.push(i as u64 + 1, &bytes).unwrap();
        out.flush().unwrap();
    }
    let mut all = Vec::new();
    for (name, bytes) in files(&out.generation_dir()) {
        all.extend(name.into_bytes());
        all.extend(bytes);
    }
    all.extend(&out.baseline);
    all.extend(wire(out.public_player().state().clone()).unwrap());
    WHOLE_STATE.set(false);
    all
}

/// #3822: parts played deferred (no digest worked out each) make the same state as parts played checked, and one
/// `verify` refuses a deferred run whose state is not the one the newest part claims.
#[test]
fn i3822_deferred_parts_make_the_checked_state_and_a_wrong_one_is_refused_once_verified() {
    let h = header();
    let d = scratch("i3822-deferred");
    let views = d.join("views");
    let store = directoryd::directory::store::Memory::default();
    let mut actual = Replica::start(h.stored()).unwrap();
    let mut out = PublicWriter::open(
        PublicStart {
            root: &views,
            header: &h,
            key: key(&h),
            initial: actual.frozen(),
            record: 0,
            checkpoint: None,
            text: None,
            clock_seed: None,
            history: None,
        },
        &store,
    )
    .unwrap();
    let body = Id::new(Scope([72; 16]), 1).unwrap();
    let mut packets = vec![w3e_packet(
        &h,
        vec![w3e_create(&h, 0, body, h.zone, Audience::Everyone)],
    )];
    for n in 1..6u64 {
        packets.push(w3e_packet(
            &h,
            vec![w3e_effect(
                n,
                body,
                Audience::Everyone,
                Body::Changes(vec![ChangeRec {
                    change: Change::Set {
                        node: body,
                        field: 40,
                        to: Value::Uint(n),
                        by: None,
                    },
                    rest: Rest::new(),
                }]),
            )],
        ));
    }
    for (n, p) in packets.iter().enumerate() {
        actual.apply_bytes(p).unwrap();
        out.push(n as u64, p).unwrap();
        out.flush().unwrap();
    }
    let baseline = out.baseline.clone();
    let dir = out.generation_dir();
    let parts: Vec<Vec<u8>> = (0..packets.len())
        .map(|n| fs::read(dir.join(n.to_string())).unwrap())
        .collect();
    let mut checked = PublicPlayer::start(h.stored(), &baseline).unwrap();
    let mut deferred = PublicPlayer::start(h.stored(), &baseline).unwrap();
    for p in &parts {
        checked.play(p).unwrap();
    }
    for p in &parts[..parts.len() - 1] {
        deferred.play_deferred(p).unwrap();
    }
    deferred.verify().unwrap();
    // The newest part played checked after deferred ones works the digest out from the state too.
    deferred.play(&parts[parts.len() - 1]).unwrap();
    assert_eq!(deferred.state(), checked.state());
    assert_eq!(deferred.hash().unwrap(), checked.hash().unwrap());
    assert_eq!(
        deferred
            .query(
                &wire(Value::Map(BTreeMap::from([
                    (1, Value::Uint(5)),
                    (2, Value::Uint(0))
                ])))
                .unwrap()
            )
            .unwrap(),
        checked
            .query(
                &wire(Value::Map(BTreeMap::from([
                    (1, Value::Uint(5)),
                    (2, Value::Uint(0))
                ])))
                .unwrap()
            )
            .unwrap()
    );
    // A part whose delta does not make the state its digest claims: played deferred it is taken, and refused at verify.
    let last = parts.len() - 1;
    let mut corrupted = object_map(&parts[last]).unwrap();
    let mut context = object_map(&obj_bytes(&corrupted, 10).unwrap()).unwrap();
    let Some(Value::Map(delta)) = context.get_mut(&5) else {
        panic!("a part's context holds its delta")
    };
    let Some(Value::Uint(v)) = delta.get(&1).cloned() else {
        panic!("the delta holds the version")
    };
    delta.insert(1, Value::Uint(v + 7));
    corrupted.insert(10, Value::Bytes(wire(Value::Map(context)).unwrap()));
    let corrupted = wire(Value::Map(corrupted)).unwrap();
    let mut wrong = PublicPlayer::start(h.stored(), &baseline).unwrap();
    for p in &parts[..last] {
        wrong.play_deferred(p).unwrap();
    }
    wrong.play_deferred(&corrupted).unwrap();
    assert_eq!(wrong.verify().unwrap_err().name, "stream-digest");
    assert_eq!(
        wrong.verify().unwrap_err().name,
        "stream-digest",
        "a refused state stays refused"
    );
    // Played checked, the same part is refused at once.
    let mut strict = PublicPlayer::start(h.stored(), &baseline).unwrap();
    for p in &parts[..last] {
        strict.play(p).unwrap();
    }
    assert_eq!(
        strict.play(&corrupted).unwrap_err().name,
        "public-stream-record"
    );
}

/// #3825: a run of `records` records, one part each, generations of 3 parts, with the writer reopened from the Store
/// after each record listed in `restarts`. Returns every generation's files, the pointer's generation fields and the
/// generations named in the order they began.
#[allow(clippy::type_complexity)]
fn i3825_run(
    tag: &str,
    records: u64,
    restarts: &[u64],
    grace: Duration,
) -> (
    BTreeMap<String, Vec<(String, Vec<u8>)>>,
    BTreeMap<u64, Value>,
    Vec<String>,
) {
    let h = header();
    let d = scratch(&format!("i3825-{tag}"));
    let views = d.join("views");
    let store = directoryd::directory::store::Memory::default();
    let open = || {
        let mut w = PublicWriter::open(
            PublicStart {
                root: &views,
                header: &h,
                key: key(&h),
                initial: Replica::start(h.stored()).unwrap(),
                record: 0,
                checkpoint: None,
                text: None,
                clock_seed: None,
                history: None,
            },
            &store,
        )
        .unwrap();
        w.generation_parts = 3;
        w.prune_grace = grace;
        w
    };
    let body = Id::new(Scope([72; 16]), 1).unwrap();
    let mut out = open();
    let mut began = vec![replica::encode::to_hex(&replica::ids::sha256(
        &out.baseline,
    ))];
    for r in 0..records {
        let effect = if r == 0 {
            w3e_create(&h, 0, body, h.zone, Audience::Everyone)
        } else {
            w3e_effect(
                r,
                body,
                Audience::Everyone,
                Body::Changes(vec![ChangeRec {
                    change: set(body, 40, Value::Uint(r)),
                    rest: Rest::new(),
                }]),
            )
        };
        out.push(r, &w3e_packet(&h, vec![effect])).unwrap();
        out.flush().unwrap();
        let g = replica::encode::to_hex(&replica::ids::sha256(&out.baseline));
        if began.last() != Some(&g) {
            began.push(g);
        }
        if restarts.contains(&r) {
            drop(out);
            out = open();
        }
    }
    let mut gens = BTreeMap::new();
    for e in fs::read_dir(views.join(stream::dir(&h, &key(&h))).join("g")).unwrap() {
        let e = e.unwrap();
        gens.insert(e.file_name().into_string().unwrap(), files(&e.path()));
    }
    let pointer =
        object_map(&fs::read(views.join(stream::dir(&h, &key(&h))).join(POINTER)).unwrap())
            .unwrap()
            .into_iter()
            .filter(|(k, _)| [1, 8, 9, 10].contains(k))
            .collect();
    (gens, pointer, began)
}

/// #3825 A1, A3, A4: the public writer closes a generation every 3 parts and starts the next from a baseline of the
/// public state then, naming the old one and its end in the pointer; a viewer that played the old generation to its
/// end holds the state the new baseline holds (the same digest), and plays on from it with no gap. Generations before
/// the previous one are pruned after the grace, never the previous one. A writer reopened from the Store after every
/// record, across each rollover, writes the same bytes and pointer as one never stopped.
#[test]
fn i3825_generations_roll_over_prune_after_the_grace_and_restart_with_the_same_bytes() {
    let (gens, pointer, began) = i3825_run("straight", 11, &[], Duration::from_secs(3600));
    // 11 parts: generations of 3, 3, 3 and 2 parts.
    assert_eq!(began.len(), 4, "a new generation every 3 parts");
    assert_eq!(gens.len(), 4, "nothing pruned inside the grace");
    for (i, g) in began.iter().enumerate() {
        let names: Vec<&str> = gens[g].iter().map(|(n, _)| n.as_str()).collect();
        let parts = if i == 3 { 2 } else { 3 };
        let mut want = vec!["baseline".to_owned(), "baseline.text".to_owned()];
        for n in 0..parts {
            want.push(n.to_string());
            want.push(format!("{n}.text"));
        }
        want.sort();
        assert_eq!(
            names, want,
            "generation {i} holds its baseline and its parts"
        );
    }
    // The pointer names the newest generation, its newest part, and the handoff from the one before.
    let hex = |v: &Value| match v {
        Value::Bytes(b) => replica::encode::to_hex(b),
        _ => panic!("bytes"),
    };
    assert_eq!(hex(&pointer[&8]), began[3]);
    assert_eq!(hex(&pointer[&10]), began[2]);
    assert_eq!(pointer[&1], Value::Uint(1));
    let Value::Array(handoff) = &pointer[&9] else {
        panic!("a handoff")
    };
    assert_eq!(
        handoff[1],
        Value::Uint(3),
        "the old generation ends after its 3 parts"
    );
    // A live viewer crosses every generation: it drains the old one, its version and digest are the handoff's, and
    // the new baseline's digest is the same; it then plays the new generation's parts from there.
    let h = header();
    let bytes = |g: &str, n: &str| {
        gens[g]
            .iter()
            .find(|(name, _)| name == n)
            .unwrap()
            .1
            .clone()
    };
    let mut live = PublicPlayer::start(h.stored(), &bytes(&began[0], "baseline")).unwrap();
    for (i, g) in began.iter().enumerate() {
        if i > 0 {
            let next = PublicPlayer::start(h.stored(), &bytes(g, "baseline")).unwrap();
            assert_eq!(
                next.hash().unwrap(),
                live.hash().unwrap(),
                "no gap at generation {i}"
            );
            assert_eq!(next.version(), live.version());
            assert_eq!(next.record(), live.record());
            // A live viewer goes on without the new baseline; a wrong digest is refused.
            let id = replica::encode::from_hex(g).unwrap();
            let digest = live.hash().unwrap();
            assert_eq!(
                live.cross(&id, &[0; 32]).unwrap_err().name,
                "stream-handoff-state"
            );
            live.cross(&id, &digest).unwrap();
        }
        let parts = if i == 3 { 2 } else { 3 };
        for n in 0..parts {
            live.play(&bytes(g, &n.to_string())).unwrap();
        }
    }
    assert_eq!(
        handoff[0],
        Value::Uint(
            PublicPlayer::start(h.stored(), &bytes(&began[3], "baseline"))
                .unwrap()
                .version()
        )
    );
    // A writer reopened from the Store after every record, rollovers included, writes the same files and pointer.
    let (again, pointer_again, began_again) = i3825_run(
        "restarted",
        11,
        &(0..11).collect::<Vec<_>>(),
        Duration::from_secs(3600),
    );
    assert_eq!(began_again, began);
    assert_eq!(again, gens, "a restart publishes the same bytes");
    assert_eq!(pointer_again, pointer);
    // With no grace, only the current and the previous generation stay.
    let (pruned, _, _) = i3825_run("pruned", 11, &[], Duration::ZERO);
    assert_eq!(
        pruned.keys().collect::<Vec<_>>(),
        {
            let mut kept = vec![&began[2], &began[3]];
            kept.sort();
            kept
        },
        "the previous generation is kept, older ones pruned"
    );
    assert_eq!(pruned[&began[3]], gens[&began[3]]);
}
