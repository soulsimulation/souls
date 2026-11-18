//! Forks (Engine v2 K6, #2670): any checkpoint starts as a new world. Each `aN_` test is one acceptance box. The world
//! is T8's audience fixture (`replica/fixtures/audience/`) with, on top, Soul 100's body holding a cup (right hand),
//! wearing a hat and holding creator Y's private key (left hand), and Soul 101's body sitting at the table holding a
//! cup: a fork taken mid-carry and mid-sit. Run with `cargo test -p sim --test fork -- --nocapture`; A1 on Eden with
//! `cargo test --release -p sim --test fork -- --ignored --nocapture` (needs the exported Eden facts file).

// A1 times a run from the request to the first tick: the one place this test reads a clock.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, fixture_bytes,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope, Version};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::Tree;
use replica::world_model::{Audience, End, show};
use sim::checkpoint::fork::{EPOCH, Forked, Request, fork};
use sim::checkpoint::{Blobs, Checkpoints, replay, restore};
use sim::log::{FileStore, Log};

const HEADER: &str = include_str!("../../replica/fixtures/audience/header.diag");
const LOG: &str = include_str!("../../replica/fixtures/audience/log.diag");

fn id(scope: u8, n: u64) -> Id {
    Id::new(Scope([scope; 16]), n).expect("an id")
}

fn ee(n: u64) -> Id {
    id(0xee, n)
}

/// Creator X's and creator Y's principal ids.
const X: (u8, u64) = (0x77, 1);
const Y: (u8, u64) = (0x88, 1);

fn kind(h: &Header, plain: &str) -> Name {
    h.kinds
        .iter()
        .find(|k| k.as_str().starts_with(&format!("{plain}@")))
        .expect("a kind")
        .clone()
}

fn part(h: &Header, effects: &[Effect]) -> Part {
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    Part::read(&encode(&v).expect("bytes")).expect("a part")
}

fn effect(seq: u64, node: Id, audience: Audience, changes: Vec<Change>) -> Effect {
    Effect {
        envelope: Envelope {
            sequence: seq,
            at: 8_000_000,
            cause: Cause::World,
            actor: Actor::World,
            audience,
            node,
        },
        body: Body::Changes(
            changes
                .into_iter()
                .map(|change| ChangeRec {
                    change,
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: None,
        rest: Rest::new(),
    }
}

fn create(h: &Header, node: Id, kind_: &str, frame: Id, slot: u64, audience: Audience) -> Change {
    Change::Create {
        node,
        kind: kind(h, kind_),
        pose: Pose {
            frame: Frame {
                node: frame,
                slot: Some(slot),
            },
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: Support::Slot,
        },
        audience,
        fields: BTreeMap::new(),
    }
}

/// The world, mid-carry and mid-sit (see the top).
fn world() -> (Header, Tree) {
    let h = Header::read(&fixture_bytes(HEADER).expect("bytes")).expect("a header");
    let mut t = Tree::start(h.zone, h.kinds[0].clone());
    t.apply(
        &h,
        &Part::read(&fixture_bytes(LOG).expect("bytes")).expect("a part"),
    )
    .expect("the fixture log applies");
    let y = Audience::Of(id(Y.0, Y.1));
    let all = Audience::Everyone;
    let more = [
        effect(
            t.next(),
            ee(2),
            all,
            vec![
                create(&h, ee(20), "souls:key", ee(2), 2, all), // a cup in the right hand
                create(&h, ee(21), "souls:key", ee(2), 3, all), // a hat, worn
            ],
        ),
        effect(
            t.next() + 1,
            ee(2),
            y,
            vec![create(&h, ee(24), "souls:key", ee(2), 1, y)],
        ), // Y's key, left hand
        effect(
            t.next() + 2,
            ee(4),
            all,
            vec![
                create(&h, ee(22), "souls:body", ee(4), 1, all), // Soul 101's body sits at the table
                Change::Link {
                    link: ee(23),
                    ty: Name::new("souls:body-of").expect("a name"),
                    ends: [ee(22), id(0xdd, 101)],
                    owner: End::First,
                    audience: all,
                },
            ],
        ),
        effect(
            t.next() + 3,
            ee(22),
            all,
            vec![create(&h, ee(25), "souls:key", ee(22), 2, all)],
        ), // its cup
    ];
    t.apply(&h, &part(&h, &more)).expect("the additions apply");
    (h, t)
}

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("souls-k6-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
}

/// The parent's checkpoint in `d`.
fn checkpoint(t: &mut Tree, lineage: Scope, d: &Path) {
    let zone = t.node(t.root()).expect("a root").id();
    let mut c = Checkpoints::open(d, 1 << 20, Blobs::default()).expect("opens");
    let v = Version {
        lineage,
        zone,
        epoch: 1,
        sequence: t.next(),
    };
    c.take(t, v, 1, b"the parent's seed").expect("taken");
    c.wait().expect("written");
}

fn request(through: Id, scope: u8) -> Request {
    Request {
        through,
        scope: Scope([scope; 16]),
        seed: vec![scope; 32],
        // 100 s after the fixture world's real anchor.
        real_us: 1_763_337_700_000_000,
        build: Hash::of(Purpose::Fixture, b"souls/k6-test/1").to_bytes(),
        every: 1 << 20,
    }
}

/// Every file under `d`, by name.
fn files(d: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![d.to_path_buf()];
    while let Some(p) = stack.pop() {
        for e in fs::read_dir(&p).expect("a folder").flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let name = path.strip_prefix(d).expect("under").display().to_string();
                out.insert(name, fs::read(&path).expect("read"));
            }
        }
    }
    out
}

fn holds(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn forked(name: &str, through: (u8, u64), scope: u8) -> (Header, Tree, PathBuf, Forked) {
    let (h, mut t) = world();
    let d = dir(name);
    checkpoint(&mut t, h.lineage, &d.join("parent"));
    let f = fork(
        &d.join("parent"),
        &d.join("fork"),
        request(id(through.0, through.1), scope),
    )
    .expect("forks");
    (h, t, d, f)
}

#[test]
fn a2_a_new_lineage_and_scope_carried_ids_kept_and_no_id_shared_afterwards() {
    let (h, parent, _d, mut f) = forked("a2", X, 0xf1);
    assert_eq!(f.version.lineage, Scope([0xf1; 16]));
    assert_ne!(f.version.lineage, h.lineage);
    assert_eq!(f.header.lineage, Scope([0xf1; 16]));
    let before = parent.to_state();
    let after = f.tree.to_state();
    // Carried nodes keep their ids: every node and link in the fork is the parent's, by the same id and record.
    for (i, n) in &after.nodes {
        let p = &before.nodes[i];
        assert_eq!(
            (&p.kind, p.audience, &p.fields),
            (&n.kind, n.audience, &n.fields)
        );
    }
    assert!(after.links.keys().all(|i| before.links.contains_key(i)));
    println!(
        "A2: the fork carries {} of the parent's {} nodes and {} of its {} links, ids kept",
        after.nodes.len(),
        before.nodes.len(),
        after.links.len(),
        before.links.len()
    );
    // Things made on either side afterwards: the parent's writer mints in its scope, the fork's in its own; a
    // second fork of the same checkpoint in a third.
    let (_, _, _, mut g) = forked("a2-second", X, 0xf2);
    let mut parent_minter = Minter::new(h.lineage);
    let mint = |m: &mut Minter| {
        (0..10_000)
            .map(|_| m.mint().expect("an id"))
            .collect::<BTreeSet<Id>>()
    };
    let (p, a, b) = (
        mint(&mut parent_minter),
        mint(&mut f.minter),
        mint(&mut g.minter),
    );
    let carried: BTreeSet<Id> = before
        .nodes
        .keys()
        .chain(before.links.keys())
        .copied()
        .collect();
    assert!(p.is_disjoint(&a) && p.is_disjoint(&b) && a.is_disjoint(&b));
    assert!(a.is_disjoint(&carried) && b.is_disjoint(&carried));
    println!(
        "A2: 10,000 ids minted on each of three sides (parent, fork, second fork): none shared, none carried"
    );
}

#[test]
fn a3_the_fork_holds_no_private_state_of_anyone_but_the_forker() {
    let x = Audience::Of(id(X.0, X.1));
    for (forker, other, name) in [(X, Y, "a3-x"), (Y, X, "a3-y")] {
        let (_, _, d, f) = forked(name, forker, 0xf3);
        let me = Audience::Of(id(forker.0, forker.1));
        let s = f.tree.to_state();
        let audiences: BTreeSet<Audience> = s
            .nodes
            .values()
            .map(|n| n.audience)
            .chain(s.links.values().map(|l| l.audience))
            .collect();
        println!(
            "A3: fork through {}: audiences {:?}",
            show(id(forker.0, forker.1)),
            audiences
                .iter()
                .map(|a| match a {
                    Audience::Everyone => "everyone".to_string(),
                    Audience::Of(i) => show(*i),
                })
                .collect::<Vec<_>>()
        );
        assert!(
            audiences
                .iter()
                .all(|a| *a == Audience::Everyone || *a == me)
        );
        // The other creator's note and key, and the players' hand (a game neither creator plays), are absent; the
        // forker's own note is there.
        // Y's key, held by Soul 100's body, is set down in Y's fork and absent from X's.
        assert!(f.tree.handle(ee(16)).is_none(), "the players' hand");
        let (mine, theirs) = if me == x {
            (ee(6), ee(7))
        } else {
            (ee(7), ee(6))
        };
        assert!(f.tree.handle(mine).is_some() && f.tree.handle(theirs).is_none());
        let key = f
            .tree
            .handle(ee(24))
            .and_then(|k| f.tree.node(k))
            .map(|n| n.parent());
        assert_eq!(key, (me != x).then_some(Some(ee(1))), "Y's key");
        // Not one byte of the other creator's id in anything the fork wrote; the parent's files hold it.
        let other_scope = [other.0; 16];
        let written = files(&d.join("fork"));
        assert!(written.values().all(|b| !holds(b, &other_scope)));
        assert!(
            files(&d.join("parent"))
                .values()
                .any(|b| holds(b, &other_scope))
        );
        println!(
            "A3: none of the fork's {} files holds the other creator's id; the parent's checkpoint does",
            written.len()
        );
    }
}

#[test]
fn a4_no_body_no_seat_held_by_one_and_what_each_held_rests_where_it_stood() {
    let (h, _, d, f) = forked("a4", X, 0xf4);
    println!(
        "A4: bodies removed {:?}",
        f.bodies.iter().map(|b| show(*b)).collect::<Vec<_>>()
    );
    assert_eq!(f.bodies, vec![ee(2), ee(22)]);
    let s = f.tree.to_state();
    let bytes = encode(&s.to_value()).expect("bytes");
    for b in [ee(2), ee(22)] {
        assert!(f.tree.handle(b).is_none());
        assert!(
            !holds(&bytes, &encode(&b.to_value()).expect("bytes")),
            "no record names a body"
        );
    }
    assert!(s.links.values().all(|l| l.ty.as_str() != "souls:body-of"));
    // Mid-sit: the table's seat is free.
    assert!(
        s.nodes
            .values()
            .all(|n| n.parent != Some(ee(4)) || n.slot != Some(1)),
        "a seat held"
    );
    // Mid-carry: the cup and hat rest on the floor where Soul 100's body stood; the seated body's cup where its
    // seat stands. Y's key is not the forker's to see, so it is not in the fork at all.
    let room = f.tree.handle(ee(1)).expect("the room");
    for (thing, at) in [
        (ee(20), (2_000_000, 1_000_000)),
        (ee(21), (2_000_000, 1_000_000)),
        (ee(25), (-1_000_000, 2_000_000)),
    ] {
        let n = f
            .tree
            .node(f.tree.handle(thing).expect("set down"))
            .expect("live");
        let p = n.place().expect("a place");
        println!(
            "A4: {} rests on {} at ({}, {}, {}) um, on the surface of {}",
            show(thing),
            show(n.parent().unwrap()),
            p.position.x,
            p.position.y,
            p.position.z,
            show(ee(1))
        );
        assert_eq!((n.parent(), n.slot()), (Some(ee(1)), None));
        assert_eq!((p.position.x, p.position.z), at);
        assert_eq!(
            p.support,
            Support::Surface {
                surface: ee(1),
                height: 0
            }
        );
    }
    assert!(f.tree.children(room).expect("live").len() >= 3);
    assert_eq!(
        f.set_down,
        vec![(ee(20), ee(1)), (ee(21), ee(1)), (ee(25), ee(1))]
    );
    // The fork comes back from its own files the same: its checkpoint, then the head of its log.
    let Forked {
        tree,
        log,
        checkpoints,
        ..
    } = f;
    drop(checkpoints);
    log.close();
    let r = restore(&d.join("fork/ckpt"))
        .expect("restores")
        .expect("a checkpoint");
    let header = Header::read(&fs::read(d.join("fork/header")).expect("read")).expect("a header");
    let (_, found) =
        Log::open(FileStore::open(&d.join("fork/log")).expect("opens"), EPOCH).expect("opens");
    let mut back = r.tree;
    assert_eq!(
        replay(&mut back, &header, &found.records, r.root.record).expect("replays"),
        1
    );
    assert_eq!(back.to_state(), tree.to_state(), "restored from its files");
    assert_ne!(header.lineage, h.lineage);
}

#[test]
fn a5_the_bytes_the_fork_wrote_and_the_parents_files_unchanged() {
    let (h, mut t) = world();
    let d = dir("a5");
    checkpoint(&mut t, h.lineage, &d.join("parent"));
    let before = files(&d.join("parent"));
    let f = fork(
        &d.join("parent"),
        &d.join("fork"),
        request(id(X.0, X.1), 0xf5),
    )
    .expect("forks");
    assert_eq!(
        files(&d.join("parent")),
        before,
        "the parent's files are unchanged"
    );
    let written = files(&d.join("fork"));
    for (name, b) in &written {
        println!("A5: fork wrote {name}: {} bytes", b.len());
    }
    let total: usize = written.values().map(Vec::len).sum();
    println!(
        "A5: {total} bytes in all ({} counted by the fork); the parent's {} files unchanged",
        f.bytes,
        before.len()
    );
    assert_eq!(total as u64, f.bytes);
}

fn eden_text() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first")
}

/// A1 on the Eden import's newest checkpoint: from the request to the end of the fork's first tick (one part, appended
/// and durable). Two repeats, each a fresh fork of the same checkpoint.
#[test]
#[ignore = "needs the exported Eden facts file; run in release"]
fn a1_a_fork_of_edens_newest_checkpoint_runs_its_first_tick_under_a_second() {
    let mut im = import_eden::load(&eden_text()).expect("Eden loads");
    let (nodes, links) = im.tree.counts();
    let d = dir("a1");
    let lineage = im.tree.node(im.tree.root()).expect("a root").id().scope();
    checkpoint(&mut im.tree, lineage, &d.join("parent"));
    let parent = files(&d.join("parent"));
    println!(
        "A1: Eden: {nodes} nodes, {links} links; parent checkpoint {} bytes",
        parent.values().map(Vec::len).sum::<usize>()
    );
    println!(
        "| repeat | fork (restore, view, checkpoint, head, durable) | first tick | request to first tick | bytes written |"
    );
    println!("|---|---|---|---|---|");
    for repeat in 1..=2 {
        let t0 = Instant::now();
        let mut f = fork(
            &d.join("parent"),
            &d.join(format!("fork-{repeat}")),
            request(id(X.0, X.1), 0xa0 + repeat),
        )
        .expect("forks");
        let t1 = Instant::now();
        let root = f.tree.node(f.tree.root()).expect("a root").id();
        let tick = part(
            &f.header,
            &[effect(f.tree.next(), root, Audience::Everyone, Vec::new())],
        );
        f.tree
            .apply(&f.header, &tick)
            .expect("the first tick applies");
        f.log.append(tick.stored().to_vec()).expect("appends");
        f.log.wait_durable(2).expect("durable");
        let t2 = Instant::now();
        let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
        println!(
            "| {repeat} | {:.1} ms | {:.2} ms | **{:.1} ms** | {} |",
            ms(t1 - t0),
            ms(t2 - t1),
            ms(t2 - t0),
            f.bytes
        );
        assert!(t2 - t0 < std::time::Duration::from_secs(1), "A1: under 1 s");
    }
    assert_eq!(
        files(&d.join("parent")),
        parent,
        "the parent's files are unchanged"
    );
}
