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
