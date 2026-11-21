//! V3's acceptance (#2712) on W8's in-memory store: restore from archive objects alone (A1), bundles made again equal
//! the stored ones (A2), no words in objects or bundles (A4), and entry one of V18's corpus decodes (A5). The run
//! against an S3-compatible stand-in over HTTP is `cargo run -p archive -- prove` (`v2/docs/archive.md`).

use archive::script::{self, SAID};
use archive::{
    Archiver, Segment, fetch, rebuild_bundles, restore, state_hash, stored_bundles, words,
    words_in_bundle, words_in_object,
};
use directoryd::directory::store::{Memory, Store};
use replica::effects::{Header, schema_hash};
use replica::encode::{Name, decode, to_hex};
use replica::history::Bundle;
use std::cell::RefCell;
use std::rc::Rc;

const PREFIX: &str = "worlds/test/";

/// A small world over two world days: ticks a second apart for twelve minutes (three windows), then a few the next
/// day; small objects so there are several. Returns the store and the live state hash.
fn recorded() -> (Memory, String) {
    let store = Memory::default();
    let queue = Rc::new(RefCell::new(Vec::<Vec<u8>>::new()));
    let q = queue.clone();
    let mut w = script::world(
        3,
        10,
        Some(Box::new(move |b: &[u8]| q.borrow_mut().push(b.to_vec()))),
    );
    for t in (0..720u64).chain(86_400..86_430) {
        script::tick(&mut w, t * 20, 5, 7 * 20);
    }
    let root = w.tree.node(w.tree.root()).expect("root").id();
    let kind = w.tree.node(w.tree.root()).expect("root").kind().clone();
    let mut a = Archiver::open(&store, PREFIX, &w.header, root, kind).expect("opens");
    a.packer.set_target(20_000);
    for (n, p) in queue.borrow_mut().drain(..).enumerate() {
        a.push(n as u64, p).expect("archives");
    }
    a.flush().expect("flushes");
    (store, state_hash(&mut w.tree).expect("hash"))
}

#[test]
fn a1_a_world_rebuilt_from_archive_objects_alone_reaches_the_recorded_hash() {
    let (store, live) = recorded();
    let f = fetch(&store, PREFIX).expect("fetched");
    assert!(f.manifests.len() == 2, "two days, two manifests");
    assert!(f.segments.len() > 2, "several objects");
    let mut tree = restore(&f).expect("restored");
    assert_eq!(state_hash(&mut tree).expect("hash"), live);
}

#[test]
fn a2_bundles_made_again_from_the_archive_equal_the_stored_ones() {
    let (store, _) = recorded();
    let f = fetch(&store, PREFIX).expect("fetched");
    let stored = stored_bundles(&store, PREFIX, &f).expect("stored");
    let again = rebuild_bundles(&f).expect("made again");
    assert!(
        stored.len() >= 4,
        "three windows the first day, one the next"
    );
    let h = |b: &[Bundle]| b.iter().map(|b| to_hex(&b.hash())).collect::<Vec<_>>();
    assert_eq!(h(&stored), h(&again));
}

#[test]
fn a4_objects_and_bundles_hold_text_references_and_no_words() {
    let (store, _) = recorded();
    let keys = store.keys();
    let (mut objects, mut bundles, mut refs) = (0, 0, 0);
    for k in &keys {
        let bytes = store.get(k).expect("get").expect("there").bytes;
        if k.contains("archive/obj/") {
            assert_eq!(
                words_in_object(&bytes, &SAID).expect("scans"),
                Vec::<String>::new(),
                "{k}"
            );
            let body = Segment::body(&bytes).expect("body");
            refs += replica::audience::references(&decode(&body).expect("cbor").value).len();
            for r in Segment::read(&bytes).expect("object").records {
                refs += replica::audience::references(&decode(&r).expect("cbor").value).len();
            }
            objects += 1;
        } else if k.contains("bundles/") && !k.ends_with("/index") {
            let bytes = archive::bundle_body(&bytes).expect("inflates");
            assert_eq!(
                words_in_bundle(&bytes, &SAID).expect("scans"),
                Vec::<String>::new(),
                "{k}"
            );
            refs += replica::audience::references(&decode(&bytes).expect("cbor").value).len();
            bundles += 1;
        }
    }
    assert!(
        objects > 0 && bundles > 0 && refs > 0,
        "{objects} {bundles} {refs}"
    );
    // The scan finds words when they are there.
    let planted = format!("xx{}xx", SAID[0]);
    let v = replica::encode::Value::Map(
        [
            (21, script::reference(0)),
            (
                23,
                replica::encode::Value::Bytes(SAID[0].as_bytes().to_vec()),
            ),
        ]
        .into(),
    );
    assert_eq!(words(&v, planted.as_bytes(), &SAID).len(), 2);
}

/// Entry one of V18's corpus: `v2/tools/corpus/entries/1`.
const ENTRY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../corpus/entries/1");

fn hex(path: &str) -> Vec<u8> {
    let t = std::fs::read_to_string(format!("{ENTRY}/{path}")).expect("the corpus file");
    let t: String = t.split_whitespace().collect();
    (0..t.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&t[i..i + 2], 16).expect("hex"))
        .collect()
}

fn line<'a>(sheet: &'a str, key: &str) -> &'a str {
    sheet
        .lines()
        .find_map(|l| l.strip_prefix(&format!("{key}: ")))
        .unwrap_or_else(|| panic!("entry.txt lacks {key}"))
}

#[test]
fn a5_corpus_entry_one_decodes() {
    let sheet = std::fs::read_to_string(format!("{ENTRY}/entry.txt")).expect("entry.txt");
    let seg = Segment::read(&hex("segment.hex")).expect("the segment decodes");
    let header = Header::read(&seg.header).expect("its header");
    assert_eq!(line(&sheet, "build"), to_hex(&header.build));
    assert_eq!(line(&sheet, "schema"), to_hex(&header.schema));
    assert_eq!(line(&sheet, "schema"), to_hex(&schema_hash().to_bytes()));
    let kinds: Vec<&str> = header.kinds.iter().map(|k| k.as_str()).collect();
    assert_eq!(line(&sheet, "kinds"), kinds.join(" "));
    // Replayed from the root the sheet names, the segment reaches the state hash it names.
    let (root, kind) = (line(&sheet, "root"), line(&sheet, "root kind"));
    let root =
        replica::effects::read_id(&decode(&hex_str(root)).expect("an id").value).expect("an id");
    let mut tree =
        replica::tree::Tree::start(root, replica::encode::Name::new(kind).expect("a kind"));
    sim::checkpoint::replay(&mut tree, &header, &seg.records, 0).expect("replays");
    assert_eq!(
        line(&sheet, "state hash"),
        state_hash(&mut tree).expect("hash")
    );
    let bundle = Bundle::read(&hex("bundle.hex")).expect("the bundle decodes");
    assert_eq!(bundle.header, header.hash().to_bytes());
    assert!(bundle.records() > 0);
    assert_eq!(line(&sheet, "bundle sha256"), to_hex(&bundle.hash()));
}

fn hex_str(t: &str) -> Vec<u8> {
    (0..t.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&t[i..i + 2], 16).expect("hex"))
        .collect()
}

// W3c: a real filtered fork, not a sequence-adjusted empty world.
fn w3c_fork(
    tag: &str,
) -> (
    std::path::PathBuf,
    sim::checkpoint::fork::Forked,
    archive::Base,
) {
    use replica::encode::Value;
    use replica::ids::{Scope, Version};
    let root = std::env::temp_dir().join(format!("w3c-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut parent = script::World::new();
    let extra = replica::world_model::parse_kinds(
        r#"{1: "archive:world", 2: "place", 11: ["souls:room"]}"#,
    )
    .unwrap();
    let root_kind = Name::new(extra.keys().next().unwrap()).unwrap();
    parent.rules.kinds.extend(extra);
    let Value::Map(mut header) = decode(parent.header.stored()).unwrap().value else {
        panic!("header");
    };
    let Value::Array(kinds) = header.get_mut(&6).unwrap() else {
        panic!("kinds");
    };
    kinds.push(Value::Text(root_kind.clone()));
    parent.header = Header::read(&replica::encode::encode(&Value::Map(header)).unwrap()).unwrap();
    parent.tree = replica::tree::Tree::start(parent.header.zone, root_kind);
    parent.room(10, 3);
    let principal = parent.souls[0];
    let mut mapping = parent.entry(parent.header.zone, vec![]);
    mapping.body = replica::effects::Body::Time(vec![replica::time::TimeEffect::Mapping(
        replica::time::Mapping::new(0, 0, 1, 1).unwrap(),
    )]);
    parent.commit(vec![mapping]);
    let version = Version {
        lineage: parent.header.lineage,
        zone: parent.header.zone,
        epoch: parent.header.epoch,
        sequence: parent.tree.next(),
    };
    let mut checkpoints =
        sim::checkpoint::Checkpoints::open(&root.join("parent"), 1, Default::default()).unwrap();
    checkpoints
        .take(&mut parent.tree, version, 0, b"parent-seed")
        .unwrap();
    checkpoints.wait().unwrap();
    let fork = sim::checkpoint::fork::fork_with_kinds(
        &root.join("parent"),
        &root.join("child"),
        sim::checkpoint::fork::Request {
            through: principal,
            scope: Scope([0x59; 16]),
            seed: b"child-seed".to_vec(),
            real_us: 59_500_000,
            build: replica::ids::Hash::of(replica::ids::Purpose::Fixture, b"archive-test")
                .to_bytes(),
            every: 1,
        },
        &parent.header.kinds,
    )
    .unwrap();
    let bytes = std::fs::read(root.join("child/ckpt/ckpt-00000000000000000000")).unwrap();
    let base = archive::Base::read(fork.header.stored(), &bytes).unwrap();
    assert!(base.tree().unwrap().next() > 0);
    assert_eq!(base.record, 0);
    let initial = base.tree().unwrap();
    assert!(
        initial
            .node(initial.root())
            .unwrap()
            .kind()
            .as_str()
            .starts_with("archive:world@"),
        "real pinned non-place root"
    );
    assert!(!fork.bodies.is_empty(), "the real fork filters bodies");
    (root, fork, base)
}
fn w3c_change(
    header: &Header,
    tree: &mut replica::tree::Tree,
    at: i64,
    body: replica::effects::Body,
) -> Vec<u8> {
    use replica::effects::{Actor, Cause, Effect, Envelope};
    use replica::encode::{Value, encode};
    use replica::world_model::Audience;
    let effect = Effect {
        envelope: Envelope {
            sequence: tree.next(),
            at,
            node: header.zone,
            audience: Audience::Everyone,
            cause: Cause::World,
            actor: Actor::World,
        },
        body,
        events: Some(vec![replica::effects::Event {
            name: Name::new("archive:changed").unwrap(),
            fields: Default::default(),
            changes: vec![0],
            rest: Default::default(),
        }]),
        rest: Default::default(),
    };
    let bytes = encode(&Value::Map(
        [
            (1, Value::Bytes(header.hash().to_bytes())),
            (2, Value::Array(vec![effect.to_value()])),
        ]
        .into(),
    ))
    .unwrap();
    tree.apply(header, &replica::effects::Part::read(&bytes).unwrap())
        .unwrap();
    bytes
}
fn w3c_set(header: &Header, tree: &mut replica::tree::Tree, at: i64, value: u64) -> Vec<u8> {
    use replica::effects::{Body, Change, ChangeRec};
    use replica::encode::Value;
    w3c_change(
        header,
        tree,
        at,
        Body::Changes(vec![ChangeRec {
            change: Change::Set {
                node: header.zone,
                field: 77,
                to: Value::Uint(value),
                by: None,
            },
            rest: Default::default(),
        }]),
    )
}

fn w3c_append(fork: &mut sim::checkpoint::fork::Forked, raw: &[u8]) -> u64 {
    let n = fork.log.append(raw.to_vec()).unwrap();
    fork.log.wait_durable(n + 1).unwrap();
    n
}
fn w3c_checkpoint(
    root: &std::path::Path,
    fork: &mut sim::checkpoint::fork::Forked,
) -> archive::Base {
    let version = replica::ids::Version {
        sequence: fork.tree.next(),
        ..fork.version
    };
    let at = fork.log.durable_at();
    fork.checkpoints
        .take_at(
            &mut fork.tree,
            version,
            at.record,
            Some((at, &fork.minter)),
            b"later-seed",
        )
        .unwrap();
    fork.checkpoints.wait().unwrap();
    archive::Base::read(
        fork.header.stored(),
        &std::fs::read(root.join(format!("child/ckpt/ckpt-{:020}", at.record))).unwrap(),
    )
    .unwrap()
}

#[test]
fn w3c_initial_fork_base_matches_newest_checkpoint_and_complete_source() {
    let (scratch, mut fork, original) = w3c_fork("initial-base");
    let input = sim::recorder::record(1, &[sim::recorder::Input::Time { real: 1 }]).unwrap();
    w3c_append(&mut fork, &input);
    let raw = w3c_set(&fork.header, &mut fork.tree, 60_000_000, 7);
    w3c_append(&mut fork, &raw);
    let newest = w3c_checkpoint(&scratch, &mut fork);
    let recovered = sim::log::recover(&std::fs::read(scratch.join("child/log")).unwrap()).unwrap();
    let selected = archive::Base::initial_fork(
        &original.header,
        &original.checkpoint,
        &newest.checkpoint,
        &recovered,
    )
    .unwrap();
    assert_eq!(selected, original);
    assert_eq!(selected.record, 0);
    assert!(newest.record > 0);
    let mut missing = recovered.clone();
    missing.first = 1;
    missing.records.remove(0);
    assert_eq!(
        archive::Base::initial_fork(
            &original.header,
            &original.checkpoint,
            &newest.checkpoint,
            &missing
        )
        .unwrap_err()
        .name,
        "archive-source-missing"
    );
    let mut changed = original.checkpoint.clone();
    let last = changed.len() - 1;
    changed[last] ^= 1;
    assert!(
        archive::Base::initial_fork(&original.header, &changed, &newest.checkpoint, &recovered)
            .is_err()
    );
    // A valid K5 with unlogged state cannot replace proof of the exact canonical boundary.
    w3c_set(&fork.header, &mut fork.tree, 61_000_000, 9);
    let mismatched = w3c_checkpoint(&scratch, &mut fork);
    assert_eq!(
        archive::Base::initial_fork(
            &original.header,
            &original.checkpoint,
            &mismatched.checkpoint,
            &recovered
        )
        .unwrap_err()
        .name,
        "archive-source-mismatch"
    );
}

#[test]
fn w3c_actual_fork_base_physical_inputs_restart_store_only_and_rolling_seek() {
    use directoryd::directory::store::When;
    use replica::encode::{Value, encode};
    use replica::history::{DAY, public_snapshot};
    use replica::views::Redactions;
    let (_scratch, mut fork, base) = w3c_fork("restore");
    let store = Memory::default();
    let mut archive = Archiver::open_based(&store, PREFIX, &base).unwrap();
    let before = base.tree().unwrap().next();
    assert_eq!(archive.push(1, vec![0]).unwrap_err().name, "archive-gap");
    let mut wrong_header = base.header.clone();
    wrong_header[0] ^= 1;
    assert!(archive::Base::read(&wrong_header, &base.checkpoint).is_err());
    let mut wrong_checkpoint = base.checkpoint.clone();
    let last = wrong_checkpoint.len() - 1;
    wrong_checkpoint[last] ^= 1;
    assert!(archive::Base::read(&base.header, &wrong_checkpoint).is_err());
    let first = replica::effects::Part::read(&fork.head).unwrap();
    assert_eq!(
        first.effects[0].envelope.sequence, before,
        "the genuine first fork part follows its sealed base"
    );
    archive.push(0, fork.head.clone()).unwrap();
    let input = encode(&Value::Map(
        [
            (0, Value::Text(Name::new("souls:input").unwrap())),
            (1, Value::Uint(7)),
            (2, Value::Array(vec![])),
        ]
        .into(),
    ))
    .unwrap();
    assert!(sim::recorder::is_input(&input));
    assert_eq!(w3c_append(&mut fork, &input), 1);
    archive.push(1, input.clone()).unwrap();
    let one = w3c_set(&fork.header, &mut fork.tree, 59_500_000, 1);
    assert_eq!(w3c_append(&mut fork, &one), 2);
    archive.push(2, one.clone()).unwrap();
    archive.flush().unwrap();
    let f = fetch(&store, PREFIX).unwrap();
    let old = stored_bundles(&store, PREFIX, &f).unwrap();
    let old_bytes: Vec<_> = old
        .iter()
        .map(|b| (b.start, b.hash(), b.bytes().to_vec()))
        .collect();
    assert_eq!(archive.source_cursor(), 3);
    // A newer engine checkpoint is an input candidate, never a replacement for the original archive base.
    let newer = w3c_checkpoint(&_scratch, &mut fork);
    let mut archive = Archiver::open_based(&store, PREFIX, &newer).unwrap();
    assert_eq!(archive.source_cursor(), 3);
    assert!(
        archive.push(1, input).is_ok(),
        "an exact archived input is idempotent"
    );
    assert_eq!(
        archive.push(2, vec![0]).unwrap_err().name,
        "archive-source-mismatch"
    );
    let two = w3c_set(&fork.header, &mut fork.tree, 61_000_000, 2);
    assert_eq!(w3c_append(&mut fork, &two), 3);
    archive.push(3, two).unwrap();
    archive.flush().unwrap();
    let three = w3c_set(&fork.header, &mut fork.tree, 119_500_000, 3);
    assert_eq!(w3c_append(&mut fork, &three), 4);
    archive.push(4, three).unwrap();
    let four = w3c_set(&fork.header, &mut fork.tree, DAY + 1_000_000, 4);
    assert_eq!(w3c_append(&mut fork, &four), 5);
    archive.push(5, four).unwrap();
    archive.flush().unwrap();
    let fetched = fetch(&store, PREFIX).unwrap();
    assert_eq!(fetched.base.as_ref(), Some(&base));
    let mut restored = restore(&fetched).unwrap();
    assert_eq!(
        state_hash(&mut restored).unwrap(),
        state_hash(&mut fork.tree).unwrap()
    );
    let live = stored_bundles(&store, PREFIX, &fetched).unwrap();
    let rebuilt = rebuild_bundles(&fetched).unwrap();
    assert_eq!(
        live.iter().map(|b| b.hash()).collect::<Vec<_>>(),
        rebuilt.iter().map(|b| b.hash()).collect::<Vec<_>>()
    );
    for (start, hash, bytes) in old_bytes {
        let key = format!(
            "{PREFIX}bundles/{:08}/{:020}-{}",
            replica::history::day_of(start),
            start,
            to_hex(&hash)
        );
        assert_eq!(
            archive::bundle_body(&store.get(&key).unwrap().unwrap().bytes).unwrap(),
            bytes,
            "old cached bundle bytes survive extension"
        );
    }
    for (at, value) in [
        (59_500_000, 1),
        (61_000_000, 2),
        (119_500_000, 3),
        (DAY - 1, 3),
        (DAY + 1_000_000, 4),
    ] {
        let got = archive::seek(&store, PREFIX, &fork.header, at).unwrap();
        assert_eq!(
            got.state.nodes[&fork.header.zone].fields[&77],
            Value::Uint(value)
        );
        assert_eq!(
            public_snapshot(&got.state, &Redactions::default()),
            public_snapshot(
                &replica::history::seek::state_at(
                    rebuilt.iter().rev().find(|b| b.start <= at).unwrap(),
                    &fork.header,
                    at
                )
                .unwrap(),
                &Redactions::default()
            )
        );
    }
    assert_eq!(
        archive::seek(&store, PREFIX, &fork.header, 59_499_999)
            .err()
            .unwrap()
            .name,
        "history-none"
    );
    assert!(
        Archiver::open(
            &store,
            PREFIX,
            &fork.header,
            fork.header.zone,
            fork.header.kinds[0].clone()
        )
        .is_err()
    );
    // Rebuilding the public event/count indices from private archive bytes is exact too.
    for (key, bytes) in archive::rebuild_views(&fetched).unwrap() {
        assert_eq!(
            store.get(&format!("{PREFIX}{key}")).unwrap().unwrap().bytes,
            bytes
        );
    }
    let base_key = store
        .keys()
        .into_iter()
        .find(|k| k.contains("archive/base/"))
        .unwrap();
    let original = store.get(&base_key).unwrap().unwrap();
    store
        .put(&base_key, b"damaged", When::Is(&original.etag))
        .unwrap();
    assert_eq!(
        fetch(&store, PREFIX).err().unwrap().name,
        "archive-base-hash"
    );
    let changed = store.get(&base_key).unwrap().unwrap();
    store
        .put(&base_key, &original.bytes, When::Is(&changed.etag))
        .unwrap();
    assert_eq!(
        state_hash(&mut restore(&fetch(&store, PREFIX).unwrap()).unwrap()).unwrap(),
        state_hash(&mut fork.tree).unwrap()
    );
    let hashes: Vec<_> = store
        .keys()
        .iter()
        .filter(|k| {
            k.contains("archive/base/")
                || k.contains("archive/obj/")
                || k.contains("archive/range/")
        })
        .map(|k| (k.clone(), store.get(k).unwrap().unwrap().bytes))
        .collect();
    for (key, bytes) in hashes {
        assert!(store.put(&key, b"changed", When::Absent).is_err());
        assert_eq!(store.get(&key).unwrap().unwrap().bytes, bytes);
    }
}

fn w3c_effect(
    header: &Header,
    tree: &mut replica::tree::Tree,
    at: i64,
    node: replica::ids::Id,
    audience: replica::world_model::Audience,
    body: replica::effects::Body,
) -> Vec<u8> {
    use replica::effects::{Actor, Body, Cause, Effect, Envelope, Part};
    use replica::encode::{Value, encode};
    let events = matches!(
        &body,
        Body::Transfer(replica::effects::TransferRec::Arrive { .. })
    )
    .then(|| {
        vec![replica::effects::Event {
            name: Name::new("archive:arrived").unwrap(),
            fields: Default::default(),
            changes: vec![],
            rest: Default::default(),
        }]
    });
    let e = Effect {
        envelope: Envelope {
            sequence: tree.next(),
            at,
            node,
            audience,
            cause: Cause::World,
            actor: Actor::World,
        },
        body,
        events,
        rest: Default::default(),
    };
    let bytes = encode(&Value::Map(
        [
            (1, Value::Bytes(header.hash().to_bytes())),
            (2, Value::Array(vec![e.to_value()])),
        ]
        .into(),
    ))
    .unwrap();
    tree.apply(header, &Part::read(&bytes).unwrap()).unwrap();
    bytes
}

fn w3c_fork_effect(
    fork: &mut sim::checkpoint::fork::Forked,
    at: i64,
    node: replica::ids::Id,
    audience: replica::world_model::Audience,
    body: replica::effects::Body,
) -> Vec<u8> {
    let raw = w3c_effect(&fork.header, &mut fork.tree, at, node, audience, body);
    w3c_append(fork, &raw);
    raw
}

#[test]
fn w3c_carried_public_state_return_settle_arrive_duplicate_and_private_frontier_seek() {
    use replica::effects::{Body, Change, ChangeRec, TransferRec};
    use replica::encode::Value;
    use replica::history::public_snapshot;
    use replica::ids::{Id, Scope};
    use replica::pose::{HandOff, Owner, Vec3};
    use replica::views::Redactions;
    use replica::world_model::{Audience, End};
    let (scratch, mut fork, _original) = w3c_fork("flights");
    let h = fork.header.clone();
    let private = Id::new(Scope([0x6a; 16]), 1).unwrap();
    let room = fork
        .tree
        .to_state()
        .nodes
        .iter()
        .find(|(id, n)| **id != h.zone && n.kind.as_str().starts_with("souls:room@"))
        .map(|(id, _)| *id)
        .unwrap();
    let kind = |plain: &str| {
        h.kinds
            .iter()
            .find(|k| k.as_str().starts_with(plain))
            .unwrap()
            .clone()
    };
    let container = fork.minter.mint().unwrap();
    let child = fork.minter.mint().unwrap();
    let slotted = fork.minter.mint().unwrap();
    let owned_link = fork.minter.mint().unwrap();
    let make = |node, kind, pose, audience, fields| ChangeRec {
        change: Change::Create {
            node,
            kind,
            pose,
            audience,
            fields,
        },
        rest: Default::default(),
    };
    w3c_fork_effect(
        &mut fork,
        60_000_000,
        room,
        Audience::Of(private),
        Body::Changes(vec![make(
            container,
            kind("souls:body@"),
            script::world::pose(room, None, 0),
            Audience::Of(private),
            [(99, Value::Bytes(b"private-container-marker".to_vec()))].into(),
        )]),
    );
    w3c_fork_effect(
        &mut fork,
        60_000_000,
        container,
        Audience::Everyone,
        Body::Changes(vec![
            make(
                child,
                kind("souls:cup@"),
                script::world::pose(container, None, 2),
                Audience::Everyone,
                Default::default(),
            ),
            make(
                slotted,
                kind("souls:cup@"),
                script::world::pose(container, Some(2), 0),
                Audience::Everyone,
                Default::default(),
            ),
        ]),
    );
    w3c_fork_effect(
        &mut fork,
        60_000_000,
        child,
        Audience::Everyone,
        Body::Changes(vec![
            ChangeRec {
                change: Change::Motion(HandOff {
                    node: child,
                    at: 60_000_000,
                    from: Owner::Mover,
                    to: Owner::Mover,
                    pose: script::world::pose(container, None, 2),
                    linear: Vec3::new(17, 0, 0),
                    angular: Vec3::ZERO,
                }),
                rest: Default::default(),
            },
            ChangeRec {
                change: Change::Link {
                    link: owned_link,
                    ty: Name::new("souls:seen-with").unwrap(),
                    ends: [child, slotted],
                    owner: End::First,
                    audience: Audience::Everyone,
                },
                rest: Default::default(),
            },
        ]),
    );
    let transfer = fork.minter.mint().unwrap();
    w3c_fork_effect(
        &mut fork,
        61_000_000,
        container,
        Audience::Of(private),
        Body::Transfer(TransferRec::Leave {
            transfer,
            node: container,
            lineage: h.lineage,
            zone: h.zone,
            pose: script::world::pose(room, None, 0),
        }),
    );
    let base = w3c_checkpoint(&scratch, &mut fork);
    assert_eq!(base.record, 5);
    let store = Memory::default();
    let mut a = Archiver::open_based(&store, PREFIX, &base).unwrap();
    let mut truth = Vec::new();
    let ret = w3c_fork_effect(
        &mut fork,
        119_500_000,
        room,
        Audience::Of(private),
        Body::Transfer(TransferRec::Return {
            transfer,
            reason: Name::new("souls:returned").unwrap(),
        }),
    );
    a.push(5, ret).unwrap();
    truth.push((119_500_000, fork.tree.to_state()));
    a.flush().unwrap();
    let public_before = stored_bundles(&store, PREFIX, &fetch(&store, PREFIX).unwrap()).unwrap();
    let private_only = w3c_fork_effect(
        &mut fork,
        119_600_000,
        container,
        Audience::Of(private),
        Body::Changes(vec![ChangeRec {
            change: Change::Set {
                node: container,
                field: 99,
                to: Value::Bytes(b"private-only-change".to_vec()),
                by: None,
            },
            rest: Default::default(),
        }]),
    );
    a.push(6, private_only).unwrap();
    a.flush().unwrap();
    assert_eq!(
        stored_bundles(&store, PREFIX, &fetch(&store, PREFIX).unwrap()).unwrap(),
        public_before,
        "private-only change causes no new public bytes or timing observation"
    );
    let motion = |at, x| {
        Body::Changes(vec![ChangeRec {
            change: Change::Motion(HandOff {
                node: child,
                at,
                from: Owner::Mover,
                to: Owner::Mover,
                pose: script::world::pose(container, None, x),
                linear: Vec3::new(17, 0, 0),
                angular: Vec3::ZERO,
            }),
            rest: Default::default(),
        }])
    };
    let sample = w3c_fork_effect(
        &mut fork,
        120_000_000,
        child,
        Audience::Everyone,
        motion(120_000_000, 3),
    );
    a.push(7, sample).unwrap();
    let sampled_state = fork.tree.to_state();
    truth.push((120_000_000, sampled_state.clone()));
    let thinned = w3c_fork_effect(
        &mut fork,
        120_100_000,
        child,
        Audience::Everyone,
        motion(120_100_000, 4),
    );
    a.push(8, thinned).unwrap();
    a.flush().unwrap();
    assert_eq!(
        archive::seek(&store, PREFIX, &h, 120_100_000)
            .unwrap()
            .state
            .nodes[&child]
            .motion,
        sampled_state.nodes[&child].motion,
        "the existing Sampled rule retains the genuine earlier sample"
    );
    let sample = w3c_fork_effect(
        &mut fork,
        121_100_000,
        child,
        Audience::Everyone,
        motion(121_100_000, 5),
    );
    a.push(9, sample).unwrap();
    truth.push((121_100_000, fork.tree.to_state()));
    let flown = fork.minter.mint().unwrap();
    let leave = w3c_fork_effect(
        &mut fork,
        179_500_000,
        child,
        Audience::Everyone,
        Body::Transfer(TransferRec::Leave {
            transfer: flown,
            node: child,
            lineage: h.lineage,
            zone: h.zone,
            pose: script::world::pose(room, None, 4),
        }),
    );
    a.push(10, leave).unwrap();
    truth.push((179_500_000, fork.tree.to_state()));
    a.flush().unwrap();
    drop(a);
    let mut a = Archiver::open_based(&store, PREFIX, &base).unwrap();
    let arrive = w3c_fork_effect(
        &mut fork,
        239_500_000,
        room,
        Audience::Everyone,
        Body::Transfer(TransferRec::Arrive {
            transfer: flown,
            carried: vec![],
        }),
    );
    a.push(11, arrive).unwrap();
    truth.push((239_500_000, fork.tree.to_state()));
    let duplicate = w3c_fork_effect(
        &mut fork,
        239_600_000,
        room,
        Audience::Everyone,
        Body::Transfer(TransferRec::Arrive {
            transfer: flown,
            carried: vec![],
        }),
    );
    a.push(12, duplicate).unwrap();
    truth.push((239_600_000, fork.tree.to_state()));
    let settled = fork.minter.mint().unwrap();
    let leave = w3c_fork_effect(
        &mut fork,
        299_500_000,
        child,
        Audience::Everyone,
        Body::Transfer(TransferRec::Leave {
            transfer: settled,
            node: child,
            lineage: h.lineage,
            zone: h.zone,
            pose: script::world::pose(room, None, 8),
        }),
    );
    a.push(13, leave).unwrap();
    let settle = w3c_fork_effect(
        &mut fork,
        359_500_000,
        room,
        Audience::Everyone,
        Body::Transfer(TransferRec::Settle { transfer: settled }),
    );
    a.push(14, settle).unwrap();
    truth.push((359_500_000, fork.tree.to_state()));
    a.flush().unwrap();
    let f = fetch(&store, PREFIX).unwrap();
    assert_eq!(
        state_hash(&mut restore(&f).unwrap()).unwrap(),
        state_hash(&mut fork.tree).unwrap()
    );
    let bundles = stored_bundles(&store, PREFIX, &f).unwrap();
    assert_eq!(bundles, rebuild_bundles(&f).unwrap());
    for (at, state) in truth {
        let got = archive::seek(&store, PREFIX, &h, at).unwrap();
        // Existing public history displays live nodes; carry/opaque context remains in its reader between rows.
        let projected = replica::stream::public::project(&h, &state).unwrap();
        let expected = replica::history::seek::live_observation(&h, &projected).unwrap();
        assert_eq!(
            public_snapshot(&got.state, &Redactions::default()),
            public_snapshot(&expected, &Redactions::default()),
            "canonical visible state at{at}"
        );
        if at == 119_500_000 {
            assert_eq!(got.state.nodes[&slotted].slot, Some(2));
            assert_eq!(got.state.nodes[&child].motion, state.nodes[&child].motion);
            assert_eq!(got.state.nodes[&child].parent, Some(container));
            assert_eq!(got.state.links[&owned_link], state.links[&owned_link]);
        }
    }
    assert!(bundles.iter().any(|b| {if let Value::Map(view)=&b.view && let Some(Value::Array(records))=view.get(&8) {records.iter().filter_map(|v|w3c_view_effect(&h,v)).filter(|e|matches!(&e.body,Body::Changes(changes) if changes.iter().any(|c|matches!(&c.change,Change::Motion(_))))).count()>=2} else {false}}),"genuine public future motion samples reach the matching WASM corpus");
    let mut arrivals = 0;
    for (key, bytes) in archive::rebuild_views(&f).unwrap() {
        assert_eq!(
            store.get(&format!("{PREFIX}{key}")).unwrap().unwrap().bytes,
            bytes
        );
        if key.starts_with("history/everyone/events/") {
            arrivals += replica::history::events::EventIndex::read(&bytes)
                .unwrap()
                .rows
                .iter()
                .filter(|r| r.kind.as_str() == "archive:arrived")
                .count();
        }
    }
    assert_eq!(
        arrivals, 2,
        "both genuine arrival events, including the idempotent duplicate, remain visible"
    );
    for b in bundles {
        for word in [
            b"private-container-marker".as_slice(),
            b"private-only-change".as_slice(),
        ] {
            assert!(!b.bytes().windows(word.len()).any(|x| x == word));
        }
        let value = decode(b.bytes()).unwrap().value;
        assert!(
            !contains_value(&value, &private.to_value()),
            "private audience principal is absent"
        );
        assert!(
            !contains_value(&value, &transfer.to_value()),
            "private flight identity is absent"
        );
        if let Value::Map(mut observation) = b.observation.clone().unwrap() {
            let original = Value::Map(observation.clone());
            let Value::Array(rows) = observation.get_mut(&5).unwrap() else {
                panic!("rows");
            };
            if !rows.is_empty() {
                rows.remove(0);
                let missing = Bundle::new_based(
                    b.header.clone(),
                    b.start,
                    b.length,
                    b.snapshot.clone(),
                    b.view.clone(),
                    Value::Map(observation),
                )
                .unwrap();
                assert!(
                    replica::history::seek::state_at(&missing, &h, b.start + b.length - 1).is_err(),
                    "missing context row refused"
                );
                let Value::Map(mut wrong) = original else {
                    unreachable!()
                };
                let Value::Array(rows) = wrong.get_mut(&5).unwrap() else {
                    unreachable!()
                };
                let Value::Array(row) = &mut rows[0] else {
                    unreachable!()
                };
                row[4] = Value::Bytes(vec![0; 32]);
                let wrong = Bundle::new_based(
                    b.header.clone(),
                    b.start,
                    b.length,
                    b.snapshot.clone(),
                    b.view.clone(),
                    Value::Map(wrong),
                )
                .unwrap();
                assert!(
                    replica::history::seek::state_at(&wrong, &h, b.start + b.length - 1).is_err(),
                    "wrong prior digest refused"
                );
            }
        }
        assert!(words(&value, b.bytes(), &["private-container-marker"]).is_empty());
        // Bind the exact native seek corpus for the matching WASM-only caller check when explicitly requested.
        w3c_vectors(&h, &b);
    }
}

fn contains_value(value: &replica::encode::Value, needle: &replica::encode::Value) -> bool {
    use replica::encode::Value;
    value == needle
        || match value {
            Value::Map(m) => m.values().any(|v| contains_value(v, needle)),
            Value::Array(a) => a.iter().any(|v| contains_value(v, needle)),
            _ => false,
        }
}

#[test]
fn w3c_existing_text_store_redactions_refresh_publication_and_store_only_rebuild() {
    use replica::effects::{Body, Change, ChangeRec};
    use replica::encode::Value;
    use replica::ids::{Minter, Scope};
    use replica::world_model::Audience;
    let (scratch, mut fork, base) = w3c_fork("redactions");
    let text =
        sim::text::Store::open_dir(&scratch.join("words"), Minter::new(Scope([0x73; 16]))).unwrap();
    let reference = text
        .write(
            b"removed-reference-words",
            Audience::Everyone,
            fork.header.zone,
        )
        .unwrap();
    let reference_value = Value::Map([(replica::audience::REFERENCE, reference.to_value())].into());
    let raw = w3c_change(
        &fork.header,
        &mut fork.tree,
        60_000_000,
        Body::Changes(vec![ChangeRec {
            change: Change::Set {
                node: fork.header.zone,
                field: 88,
                to: reference_value.clone(),
                by: None,
            },
            rest: Default::default(),
        }]),
    );
    assert_eq!(w3c_append(&mut fork, &raw), 1);
    let store = Memory::default();
    let mut a =
        Archiver::open_based_with_redactions(&store, PREFIX, &base, text.redactions()).unwrap();
    a.push(0, fork.head.clone()).unwrap();
    a.push(1, raw).unwrap();
    a.flush().unwrap();
    let fetched = fetch(&store, PREFIX).unwrap();
    let old = stored_bundles(&store, PREFIX, &fetched).unwrap();
    let state = archive::seek(&store, PREFIX, &fork.header, 60_000_000)
        .unwrap()
        .state;
    assert_eq!(state.nodes[&fork.header.zone].fields[&88], reference_value);
    text.remove(
        reference,
        fork.header.zone,
        60_000_001,
        sim::text::Grade::Erased,
    )
    .unwrap();
    assert!(a.refresh_redactions(text.redactions()).unwrap());
    assert!(!a.refresh_redactions(text.redactions()).unwrap());
    let fresh = stored_bundles(&store, PREFIX, &fetched).unwrap();
    assert_ne!(
        fresh.iter().map(|b| b.hash()).collect::<Vec<_>>(),
        old.iter().map(|b| b.hash()).collect::<Vec<_>>()
    );
    let redacted = archive::seek(&store, PREFIX, &fork.header, 60_000_000)
        .unwrap()
        .state;
    assert_eq!(
        redacted.nodes[&fork.header.zone].fields[&88],
        text.redactions().scrub(reference_value)
    );
    assert_eq!(
        fresh,
        archive::rebuild_bundles_with_redactions(&fetched, text.redactions()).unwrap()
    );
    for bundle in &fresh {
        w3c_vectors(&fork.header, bundle);
    }
    for (key, bytes) in archive::rebuild_views_with_redactions(&fetched, text.redactions()).unwrap()
    {
        assert_eq!(
            store.get(&format!("{PREFIX}{key}")).unwrap().unwrap().bytes,
            bytes
        );
    }
    let reopened =
        Archiver::open_based_with_redactions(&store, PREFIX, &base, text.redactions()).unwrap();
    drop(reopened);
    assert_eq!(stored_bundles(&store, PREFIX, &fetched).unwrap(), fresh);
    for bundle in old {
        let key = format!(
            "{PREFIX}bundles/{:08}/{:020}-{}",
            replica::history::day_of(bundle.start),
            bundle.start,
            to_hex(&bundle.hash())
        );
        assert_eq!(
            archive::bundle_body(&store.get(&key).unwrap().unwrap().bytes).unwrap(),
            bundle.bytes(),
            "erasure never rewrites already immutable bytes"
        );
    }
    assert_eq!(
        state_hash(&mut restore(&fetched).unwrap()).unwrap(),
        state_hash(&mut fork.tree).unwrap(),
        "redaction changes views only"
    );
    for key in store
        .keys()
        .into_iter()
        .filter(|k| k.contains("bundles/") && !k.ends_with("/index"))
    {
        let body = archive::bundle_body(&store.get(&key).unwrap().unwrap().bytes).unwrap();
        assert!(
            words(
                &decode(&body).unwrap().value,
                &body,
                &["removed-reference-words"]
            )
            .is_empty()
        );
    }
}

/// The same native-result corpus feeds the real WASM export for carried and redacted history.
fn w3c_vectors(h: &Header, b: &Bundle) {
    use replica::effects::{Body, Change};
    use replica::encode::Value;
    if let Ok(path) = std::env::var("W3C_HISTORY_VECTORS") {
        let path = std::path::Path::new(&path);
        std::fs::create_dir_all(path).unwrap();

        let stem = format!("{}-{}", b.start, to_hex(&b.hash()));
        std::fs::write(path.join(format!("{stem}.header")), h.stored()).unwrap();
        std::fs::write(path.join(format!("{stem}.bundle")), b.bytes()).unwrap();
        for at in [b.start, b.start + b.length - 1] {
            let state = replica::history::seek::state_at(b, h, at).unwrap();
            let nodes = state
                .nodes
                .iter()
                .map(|(id, n)| {
                    let mut row = std::collections::BTreeMap::from([
                        (1, id.to_value()),
                        (2, Value::Text(n.kind.clone())),
                        (6, Value::Map(n.fields.clone())),
                    ]);
                    row.extend(n.parent.map(|p| (3, p.to_value())));
                    row.extend(n.slot.map(|s| (4, Value::Uint(s))));
                    row.extend(n.place.clone().map(|p| (7, p)));
                    row.extend(n.motion.clone().map(|m| (8, m)));
                    Value::Map(row)
                })
                .collect();
            let int = |n: i64| {
                if n >= 0 {
                    Value::Uint(n as u64)
                } else {
                    Value::Nint(n.unsigned_abs() - 1)
                }
            };
            let mut samples = Vec::new();
            if let Value::Map(view) = &b.view
                && let Some(Value::Array(records)) = view.get(&8)
            {
                for effect in records.iter().filter_map(|v| w3c_view_effect(h, v)) {
                    if let Body::Changes(changes) = effect.body {
                        for change in changes {
                            if let Change::Motion(motion) = change.change
                                && motion.at > at
                            {
                                let mut row = std::collections::BTreeMap::from([
                                    (1, motion.node.to_value()),
                                    (2, motion.pose.frame.node.to_value()),
                                    (4, int(motion.at)),
                                    (
                                        5,
                                        Value::Array(vec![
                                            int(motion.pose.position.x),
                                            int(motion.pose.position.y),
                                            int(motion.pose.position.z),
                                        ]),
                                    ),
                                ]);
                                row.extend(motion.pose.frame.slot.map(|s| (3, Value::Uint(s))));
                                samples.push(Value::Map(row));
                            }
                        }
                    }
                }
            }
            let expected = Value::Map(
                [
                    (1, Value::Bytes(state.hash().unwrap().to_bytes())),
                    (2, Value::Array(nodes)),
                    (3, Value::Array(samples)),
                    (4, int(b.start)),
                    (5, int(b.length)),
                ]
                .into(),
            );
            std::fs::write(
                path.join(format!("{stem}.{at}.expected")),
                replica::encode::encode(&expected).unwrap(),
            )
            .unwrap();
        }
    }
}

/// Decode the unchanged genuine view entry through the public canonical Part reader. Only the existing,
/// validated carried marker is a non-effect record; malformed effect records must fail this fixture.
fn w3c_view_effect(
    header: &Header,
    value: &replica::encode::Value,
) -> Option<replica::effects::Effect> {
    use replica::encode::{Value, encode};
    if let Value::Map(map) = value
        && map.contains_key(&0)
    {
        assert_eq!(map.len(), 1, "a carried marker is not an effect");
        assert!(
            replica::views::Carried::read(value)
                .expect("canonical carried record")
                .is_some()
        );
        return None;
    }
    let bytes = encode(&Value::Map(
        [
            (1, Value::Bytes(header.hash().to_bytes())),
            (2, Value::Array(vec![value.clone()])),
        ]
        .into(),
    ))
    .unwrap();
    let mut entries = replica::effects::Part::read(&bytes)
        .expect("canonical genuine view effect")
        .effects;
    assert_eq!(entries.len(), 1);
    entries.pop()
}

#[test]
fn w3655_legacy_empty_parts_preserve_day_source_and_reopen() {
    use archive::Packer;
    use replica::effects::Part;
    let store = Memory::default();
    let queued = Rc::new(RefCell::new(Vec::new()));
    let log = queued.clone();
    let mut world = script::world(
        1,
        0,
        Some(Box::new(move |b| log.borrow_mut().push(b.to_vec()))),
    );
    let boot = queued.borrow().len();
    script::tick(&mut world, 86_400 * 20 + 1, 1, 0);
    let before_empty = world.tree.to_state();
    let empty = script::tick(&mut world, 86_400 * 20 + 2, 0, 0);
    assert!(Part::read(&empty).unwrap().effects.is_empty());
    assert_eq!(
        world.tree.to_state(),
        before_empty,
        "empty parts invent no time or state"
    );
    script::tick(&mut world, 86_400 * 20 + 3, 0, 0);
    script::tick(&mut world, 2 * 86_400 * 20 + 1, 1, 0);
    script::tick(&mut world, 2 * 86_400 * 20 + 2, 0, 0);
    let records = queued.borrow().clone();
    assert_eq!(records.len(), boot + 5);
    let node = world.tree.node(world.tree.root()).unwrap();
    let (root, kind) = (node.id(), node.kind().clone());
    {
        let mut packer =
            Packer::open(&store, PREFIX, world.header.stored(), root, kind.clone()).unwrap();
        packer.set_target(1);
        for (n, raw) in records[..boot + 2].iter().enumerate() {
            packer.push(n as u64, raw.clone()).unwrap();
        }
        packer.flush().unwrap();
        assert_eq!(
            fetch(&store, PREFIX)
                .unwrap()
                .manifests
                .iter()
                .map(|m| m.day)
                .collect::<Vec<_>>(),
            [0, 1]
        );
    }
    let mut packer = Packer::open(&store, PREFIX, world.header.stored(), root, kind).unwrap();
    packer.set_target(1);
    for (n, raw) in records.iter().enumerate().skip(boot + 2) {
        packer.push(n as u64, raw.clone()).unwrap();
    }
    packer.flush().unwrap();
    let fetched = fetch(&store, PREFIX).unwrap();
    assert_eq!(
        fetched.manifests.iter().map(|m| m.day).collect::<Vec<_>>(),
        [0, 1, 2]
    );
    assert_eq!(
        fetched
            .manifests
            .iter()
            .map(|m| m.rows.iter().map(|r| r.count).sum::<u64>())
            .sum::<u64>(),
        records.len() as u64
    );
    let mut next = 0;
    let mut stored = Vec::new();
    for segment in &fetched.segments {
        assert_eq!(
            segment.first, next,
            "every accepted physical record is contiguous"
        );
        assert_eq!(segment.header, world.header.stored());
        next += segment.records.len() as u64;
        stored.extend(segment.records.clone());
    }
    assert_eq!(
        stored, records,
        "fetch validates original object checksums and exact source bytes"
    );
    assert_eq!(
        state_hash(&mut restore(&fetched).unwrap()).unwrap(),
        state_hash(&mut world.tree).unwrap()
    );
}

#[test]
fn w3655_legacy_empty_initial_part_keeps_named_refusals_and_store_unchanged() {
    use archive::Packer;
    use replica::effects::Part;
    let store = Memory::default();
    let mut world = script::world(0, 0, None);
    let empty = script::tick(&mut world, 0, 0, 0);
    assert!(Part::read(&empty).unwrap().effects.is_empty());
    let node = world.tree.node(world.tree.root()).unwrap();
    let (root, kind) = (node.id(), node.kind().clone());
    let mut packer = Packer::open(&store, PREFIX, world.header.stored(), root, kind).unwrap();
    packer.set_target(1);
    assert_eq!(
        packer.push(1, empty.clone()).unwrap_err().name,
        "archive-gap"
    );
    assert!(store.keys().is_empty());
    let malformed = vec![0xff];
    let expected = Part::read(&malformed).unwrap_err().name;
    assert_eq!(packer.push(0, malformed).unwrap_err().name, expected);
    assert!(store.keys().is_empty());
    packer.push(0, empty.clone()).unwrap();
    packer.flush().unwrap();
    let fetched = fetch(&store, PREFIX).unwrap();
    assert_eq!(fetched.manifests.len(), 1);
    assert_eq!(
        fetched.manifests[0].day, 0,
        "untimed initial metadata bucket is unchanged"
    );
    assert_eq!(fetched.segments[0].records, [empty]);
    let before = store
        .keys()
        .iter()
        .map(|k| (k.clone(), store.get(k).unwrap().unwrap().bytes))
        .collect::<Vec<_>>();
    assert_eq!(packer.push(2, vec![0xff]).unwrap_err().name, "archive-gap");
    assert_eq!(
        store
            .keys()
            .iter()
            .map(|k| (k.clone(), store.get(k).unwrap().unwrap().bytes))
            .collect::<Vec<_>>(),
        before
    );
}

/// #3755's regression on a recorded full-Eden fork: `ARCHIVE_EDEN` names a copy of a served world's store folder
/// (its `h/<world>/<lineage>/` archive is found in it; the open rewrites the same bytes into it). The based bundles
/// made row by row are byte-identical to the whole-state reference's; prints each one's cost per record, each
/// archive open's time and whether the bundles stored live are the same bytes. Run on Saturn, `--ignored`.
#[test]
#[ignore = "needs a recorded full-Eden store folder in ARCHIVE_EDEN"]
fn w3755_full_eden_bundles_row_by_row_equal_the_whole_state_reference() {
    use directoryd::directory::folder::Folder;
    use std::time::Instant;
    let root = std::path::PathBuf::from(std::env::var("ARCHIVE_EDEN").expect("ARCHIVE_EDEN"));
    let head = Folder::new(root.clone())
        .keys("h/")
        .into_iter()
        .find(|k| k.ends_with("/archive/head"))
        .expect("an archive in the store");
    // The served world's archive keys are relative to its own folder (worldd's `Under`).
    let store = Folder::new(root.join(head.trim_end_matches("archive/head")));
    let prefix = String::new();
    let f = fetch(&store, &prefix).expect("fetched");
    let base = f.base.clone().expect("a based archive (a fork)");
    let records = f
        .segments
        .iter()
        .flat_map(|s| &s.records)
        .filter(|r| !sim::recorder::is_input(r))
        .count();
    let entries: usize = f
        .segments
        .iter()
        .flat_map(|s| &s.records)
        .filter(|r| !sim::recorder::is_input(r))
        .map(|r| replica::effects::Part::read(r).unwrap().effects.len())
        .sum();
    let bytes = |b: &[Bundle]| b.iter().map(|b| b.bytes().to_vec()).collect::<Vec<_>>();
    let mut made = Vec::new();
    for whole in [false, true, false, true] {
        archive::whole_state_reference(whole);
        let t = Instant::now();
        let b = rebuild_bundles(&f).expect("made again");
        let took = t.elapsed();
        let t = Instant::now();
        drop(Archiver::open_based(&store, &prefix, &base).expect("opens"));
        let open = t.elapsed();
        eprintln!(
            "w3755: {} records ({entries} entries) after base record {}, {}: {} bundles in {:.3} s, {:.1} ms per \
             record; archive open {:.3} s",
            records,
            base.record,
            if whole { "whole-state reference" } else { "row by row" },
            b.len(),
            took.as_secs_f64(),
            took.as_secs_f64() * 1000.0 / records.max(1) as f64,
            open.as_secs_f64()
        );
        made.push(bytes(&b));
    }
    archive::whole_state_reference(false);
    assert!(!made[0].is_empty(), "the fork made public bundles");
    assert!(made.iter().all(|m| *m == made[0]), "byte-identical bundles");
    let stored = bytes(&stored_bundles(&store, &prefix, &f).expect("stored"));
    eprintln!(
        "w3755: {} bundles, {} bytes, byte-identical in both arms; stored live: {} bundles, {}",
        made[0].len(),
        made[0].iter().map(Vec::len).sum::<usize>(),
        stored.len(),
        if stored == made[0] { "EQUAL" } else { "DIFFER" }
    );
}
