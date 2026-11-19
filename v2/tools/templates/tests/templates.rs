//! A world from a template or a fork (Engine v2 G9, #2798). Each `aN_` test is one acceptance box. The small world is
//! K6's: T8's audience fixture with Soul 100's body holding a cup, wearing a hat and holding creator Y's private key,
//! and Soul 101's body sitting at the table holding a cup. It is published as a template, and a world is made from
//! that template through the directory's create call (`directoryd::worlds::create`) and `worldd::start`, on an
//! in-memory object store. Run with `cargo test -p templates -- --nocapture`; A1 on Eden with
//! `cargo test --release -p templates a1 -- --ignored --nocapture` (needs the exported Eden facts file).

// A1 times a run from the request to the first served part: the one place this test reads a clock.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use directoryd::directory::store::{Memory, Store, When};
use directoryd::directory::{Claim, Directory};
use directoryd::worlds::create::{Create, NameRecord, Source, create, named};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Refusal, Rest, State,
    fixture_bytes,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::Tree;
use replica::world_model::{Audience, End, show};
use sim::checkpoint::fork::Request;
use sim::checkpoint::restore;
use templates::{Template, checkpoint, publish, scan, souls};
use worldd::start::{Started, start};

const HEADER: &str = include_str!("../../../crates/replica/fixtures/audience/header.diag");
const LOG: &str = include_str!("../../../crates/replica/fixtures/audience/log.diag");

fn id(scope: u8, n: u64) -> Id {
    Id::new(Scope([scope; 16]), n).expect("an id")
}

fn ee(n: u64) -> Id {
    id(0xee, n)
}

/// Creator X's and creator Y's principal ids.
fn x() -> Id {
    id(0x77, 1)
}

fn y() -> Id {
    id(0x88, 1)
}

fn build() -> Vec<u8> {
    Hash::of(Purpose::Fixture, b"souls/g9-test/1").to_bytes()
}

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

fn create_node(kind: Name, node: Id, frame: Id, slot: Option<u64>, audience: Audience) -> Change {
    Change::Create {
        node,
        kind,
        pose: Pose {
            frame: Frame { node: frame, slot },
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: if slot.is_some() {
                Support::Slot
            } else {
                Support::None
            },
        },
        audience,
        fields: BTreeMap::new(),
    }
}

/// K6's world, mid-carry and mid-sit (see the top).
fn world() -> (Header, Tree) {
    let h = Header::read(&fixture_bytes(HEADER).expect("bytes")).expect("a header");
    let mut t = Tree::start(h.zone, h.kinds[0].clone());
    t.apply(
        &h,
        &Part::read(&fixture_bytes(LOG).expect("bytes")).expect("a part"),
    )
    .expect("the fixture log applies");
    let key = kind(&h, "souls:key");
    let all = Audience::Everyone;
    let mine = Audience::Of(y());
    let more = [
        effect(
            t.next(),
            ee(2),
            all,
            vec![
                create_node(key.clone(), ee(20), ee(2), Some(2), all), // a cup in the right hand
                create_node(key.clone(), ee(21), ee(2), Some(3), all), // a hat, worn
            ],
        ),
        effect(
            t.next() + 1,
            ee(2),
            mine,
            vec![create_node(key.clone(), ee(24), ee(2), Some(1), mine)],
        ), // Y's key, left hand
        effect(
            t.next() + 2,
            ee(4),
            all,
            vec![
                create_node(kind(&h, "souls:body"), ee(22), ee(4), Some(1), all), // Soul 101 sits at the table
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
            vec![create_node(key, ee(25), ee(22), Some(2), all)],
        ), // its cup
    ];
    t.apply(&h, &part(&h, &more)).expect("the additions apply");
    (h, t)
}

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("souls-g9-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
}

/// 100 s after the fixture world's real anchor.
const REAL_US: i64 = 1_763_337_700_000_000;

/// The world `tree`, checkpointed in `d/source` and published as a template in `d/template`.
fn published(tree: &mut Tree, lineage: Scope, d: &Path) -> Template {
    checkpoint(tree, lineage, &d.join("source")).expect("checkpointed");
    publish(
        &d.join("source"),
        &d.join("template"),
        "fixture",
        Scope([0x7e; 16]),
        vec![0x7e; 32],
        REAL_US,
        build(),
    )
    .expect("published")
}

/// The newest checkpoint's state in `ckpt`.
fn state_in(ckpt: &Path) -> State {
    restore(ckpt)
        .expect("restores")
        .expect("a checkpoint")
        .tree
        .to_state()
}

/// The create call, with `worldd::start` as its fork: from `src` (a checkpoint folder) into `d/<name>`.
#[allow(clippy::too_many_arguments)] // a test helper: each argument is one field of the request
fn make(
    directory: &mut Directory<&Memory>,
    d: &Path,
    name: &str,
    creator: Id,
    source: Source,
    src: &Path,
    zone: Id,
    lineage: u8,
) -> Result<(Claim, Started), Refusal> {
    let w = d.join(name);
    create(
        directory,
        Create {
            name,
            creator,
            source,
            lineage: [lineage; 16],
            zone,
            build: &build(),
        },
        |_claim| {
            start(
                src,
                &w.join("world"),
                Request {
                    through: creator,
                    scope: Scope([lineage; 16]),
                    seed: vec![lineage; 32],
                    real_us: REAL_US,
                    build: build(),
                    every: 1 << 20,
                },
            )
        },
    )
}

fn machine(store: &Memory) -> Directory<&Memory> {
    Directory::new(store, Name::new("souls:machine-1").expect("a name"))
}

/// A2's check: every template node and link is in the world with the same record; a node made after the fork carries
/// the new world's scope.
fn ids_kept_and_new_scope(template: &State, s: &mut Started) {
    let world = s.forked.tree.to_state();
    for (k, n) in &template.nodes {
        assert_eq!(world.nodes.get(k), Some(n), "node {} kept", show(*k));
    }
    for (k, l) in &template.links {
        assert_eq!(world.links.get(k), Some(l), "link {} kept", show(*k));
    }
    assert_eq!(world.nodes.len(), template.nodes.len());
    let made = s.forked.minter.mint().expect("an id");
    let root = s.forked.tree.node(s.forked.tree.root()).expect("a root");
    let (zone, kind) = (root.id(), root.kind().clone());
    let p = part(
        &s.forked.header,
        &[effect(
            s.forked.tree.next(),
            zone,
            Audience::Everyone,
            vec![create_node(kind, made, zone, None, Audience::Everyone)],
        )],
    );
    s.forked
        .tree
        .apply(&s.forked.header, &p)
        .expect("a node made after the fork");
    assert_eq!(made.scope(), s.forked.version.lineage);
    assert!(
        template.nodes.keys().all(|k| k.scope() != made.scope()),
        "no template id carries the new scope"
    );
    println!(
        "A2: {} nodes, {} links kept with their ids; made after the fork: {} (scope {})",
        template.nodes.len(),
        template.links.len(),
        show(made),
        replica::encode::to_hex(&made.scope().0)
    );
}

#[test]
fn a2_its_own_lineage_and_scope_every_template_id_unchanged() {
    let (h, mut t) = world();
    let d = dir("a2");
    let tpl = published(&mut t, h.lineage, &d);
    let template = state_in(&d.join("template/ckpt"));
    let store = Memory::default();
    let mut directory = machine(&store);
    let (claim, mut s) = make(
        &mut directory,
        &d,
        "rehearsal",
        x(),
        Source::Template {
            lineage: tpl.lineage.0,
        },
        &d.join("template/ckpt"),
        tpl.zone,
        0xa2,
    )
    .expect("made");
    assert_eq!(claim.takeover.epoch, 1);
    assert_eq!(s.forked.header.lineage, Scope([0xa2; 16]));
    assert_ne!(s.forked.header.lineage, tpl.lineage);
    assert_ne!(tpl.lineage, h.lineage);
    assert!(!s.frame.is_empty(), "the first part is served");
    ids_kept_and_new_scope(&template, &mut s);
}

#[test]
fn a3_exactly_one_creator_and_the_name_claimed_before_the_fork() {
    let (h, mut t) = world();
    let d = dir("a3");
    let tpl = published(&mut t, h.lineage, &d);
    let src = Source::Template {
        lineage: tpl.lineage.0,
    };
    let ckpt = d.join("template/ckpt");
    let store = Memory::default();
    let mut directory = machine(&store);
    make(
        &mut directory,
        &d,
        "one",
        x(),
        src.clone(),
        &ckpt,
        tpl.zone,
        0xa3,
    )
    .expect("made");
    let rec = named(&directory, "one").expect("read").expect("a record");
    assert_eq!(rec.creator, x());
    // A second create of the name, by Y, is refused and changes nothing.
    let before = store.get(&NameRecord::key("one")).expect("read");
    let e = make(
        &mut directory,
        &d,
        "one",
        y(),
        src.clone(),
        &ckpt,
        tpl.zone,
        0xa4,
    )
    .err()
    .expect("refused");
    assert_eq!(e.name, "name-taken");
    assert_eq!(store.get(&NameRecord::key("one")).expect("read"), before);
    for reserved in ["eden", "api", "god", "assets"] {
        let e = make(
            &mut directory,
            &d,
            reserved,
            x(),
            src.clone(),
            &ckpt,
            tpl.zone,
            0xa5,
        )
        .err()
        .expect("refused");
        assert_eq!(e.name, "name-reserved", "{reserved}");
    }
    // A crash mid-fork: the name record, with its one creator, and the claimed world record are already there.
    let e = create(
        &mut directory,
        Create {
            name: "crashed",
            creator: x(),
            source: src,
            lineage: [0xa6; 16],
            zone: tpl.zone,
            build: &build(),
        },
        |_claim| -> Result<(), Refusal> {
            Err(Refusal {
                name: "crash",
                detail: "mid-fork".into(),
            })
        },
    )
    .expect_err("the fork failed");
    assert_eq!(e.name, "crash");
    let rec = named(&directory, "crashed")
        .expect("read")
        .expect("a record");
    assert_eq!((rec.creator, rec.lineage), (x(), [0xa6; 16]));
    let world = directory.world(&[0xa6; 16], tpl.zone).expect("its record");
    assert_eq!(world.current().map(|t| t.epoch), Some(1));
    println!(
        "A3: one creator {} per name; keys {:?}",
        show(rec.creator),
        store.keys()
    );
}

#[test]
fn a4_the_scan_finds_no_soul_body_held_seat_timer_or_private_field() {
    let (h, mut t) = world();
    let source = t.to_state();
    let gone = souls(&source);
    let found = scan(&source, &gone);
    println!("A4: the source holds {found:#?}");
    assert!(found.iter().any(|f| f.starts_with("body ")));
    assert!(found.iter().any(|f| f.starts_with("a seat held")));
    assert!(found.iter().any(|f| f.starts_with("link to a Soul")));
    assert!(found.iter().any(|f| f.starts_with("private node")));
    let d = dir("a4");
    let tpl = published(&mut t, h.lineage, &d);
    assert_eq!(tpl.bodies, vec![ee(2), ee(22)]);
    let template = state_in(&d.join("template/ckpt"));
    assert_eq!(scan(&template, &gone), Vec::<String>::new());
    let store = Memory::default();
    let mut directory = machine(&store);
    let (_, s) = make(
        &mut directory,
        &d,
        "clean",
        x(),
        Source::Template {
            lineage: tpl.lineage.0,
        },
        &d.join("template/ckpt"),
        tpl.zone,
        0xa4,
    )
    .expect("made");
    let world = s.forked.tree.to_state();
    assert_eq!(scan(&world, &gone), Vec::<String>::new());
    println!(
        "A4: the template and the new world: no finding ({} nodes, {} links, {} timers)",
        world.nodes.len(),
        world.links.len(),
        world.timers.len()
    );
}

#[test]
fn a5_a_creators_fork_of_their_own_world_carries_no_body_and_sets_down_what_they_held() {
    let (h, mut t) = world();
    let d = dir("a5");
    checkpoint(&mut t, h.lineage, &d.join("home")).expect("checkpointed");
    let gone = souls(&t.to_state());
    let store = Memory::default();
    // X's own world, as a running world's name record holds it.
    let home = NameRecord {
        name: "x-home".into(),
        lineage: h.lineage.0,
        zone: h.zone,
        creator: x(),
        source: h.lineage.0,
    };
    store
        .put(
            &NameRecord::key("x-home"),
            &home.to_bytes().expect("bytes"),
            When::Absent,
        )
        .expect("written");
    let mut directory = machine(&store);
    let own = Source::Own {
        name: "x-home".into(),
    };
    let e = make(
        &mut directory,
        &d,
        "not-mine",
        y(),
        own.clone(),
        &d.join("home"),
        h.zone,
        0xb4,
    )
    .err()
    .expect("refused");
    assert_eq!(e.name, "not-your-world");
    let (_, s) = make(
        &mut directory,
        &d,
        "x-rehearsal",
        x(),
        own,
        &d.join("home"),
        h.zone,
        0xb5,
    )
    .expect("made");
    let f = &s.forked;
    assert_eq!(f.bodies, vec![ee(2), ee(22)]);
    let world = f.tree.to_state();
    // No Soul, body or link to one; the only private record is X's own note, which X's own fork keeps (K6, T8).
    assert_eq!(scan(&world, &gone), vec!["private node ee:6".to_owned()]);
    assert_eq!(world.nodes[&ee(6)].audience, Audience::Of(x()));
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
            "A5: {} lies on {} at ({}, {}) um",
            show(thing),
            show(n.parent().expect("a parent")),
            p.position.x,
            p.position.z
        );
        assert_eq!((n.parent(), n.slot()), (Some(ee(1)), None));
        assert_eq!((p.position.x, p.position.z), at);
    }
    assert_eq!(
        named(&directory, "x-rehearsal")
            .expect("read")
            .map(|r| (r.creator, r.source)),
        Some((x(), h.lineage.0))
    );
}

fn eden_text() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first")
}

/// A1 on Eden's template: from the create request (name, record, claim, fork, first tick) to the first served part
/// on the disk. Two repeats, each a new world from the same template. A2 and A4 are checked on each world too.
#[test]
#[ignore = "needs the exported Eden facts file; run in release"]
fn a1_a_world_from_edens_template_serves_its_first_part_under_5_s() {
    let mut im = import_eden::load(&eden_text()).expect("Eden loads");
    let d = dir("a1");
    let root = im.tree.node(im.tree.root()).expect("a root").id();
    let (nodes, links) = im.tree.counts();
    let t0 = Instant::now();
    let tpl = published(&mut im.tree, root.scope(), &d);
    println!(
        "A1: Eden: {nodes} nodes, {links} links; template published once in {:.0} ms, {} bytes",
        t0.elapsed().as_secs_f64() * 1000.0,
        tpl.bytes
    );
    let template = state_in(&d.join("template/ckpt"));
    let gone = BTreeSet::new();
    assert_eq!(scan(&template, &gone), Vec::<String>::new());
    let store = Memory::default();
    let mut directory = machine(&store);
    println!("| repeat | request to first served part | first frame bytes | nodes |");
    println!("|---|---|---|---|");
    for repeat in 1..=2u8 {
        let t0 = Instant::now();
        let (_, mut s) = make(
            &mut directory,
            &d,
            &format!("eden-copy-{repeat}"),
            x(),
            Source::Template {
                lineage: tpl.lineage.0,
            },
            &d.join("template/ckpt"),
            tpl.zone,
            0xc0 + repeat,
        )
        .expect("made");
        let took = t0.elapsed();
        println!(
            "| {repeat} | **{:.0} ms** | {} | {} |",
            took.as_secs_f64() * 1000.0,
            s.frame.len(),
            s.forked.tree.counts().0
        );
        assert!(took < Duration::from_secs(5), "A1: under 5 s");
        assert_eq!(scan(&s.forked.tree.to_state(), &gone), Vec::<String>::new());
        ids_kept_and_new_scope(&template, &mut s);
    }
}
