//! The tree in memory (Engine v2 K2, #2646). Each `aN_` test is one acceptance box (A2's memory and A3's times are
//! the `tree` bench, `v2/tools/bench`); each test prints what it saw.

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, FIXTURE_HEADER, FIXTURES, Header,
    Part, Rest, State, fixture_bytes,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{FIXTURE_SCOPE_A, Id};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::{Rules, Tree};
use replica::world_model::{
    Audience, Draft, End, FIXTURE_KINDS, FIXTURE_SCOPE_SOULS, FIXTURES as WORLDS, check,
    parse_kinds, parse_world, show,
};
use std::collections::{BTreeMap, BTreeSet};

fn ee(n: u64) -> Id {
    Id::new(replica::ids::Scope([0xee; 16]), n).unwrap()
}

fn dd(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_SOULS, n).unwrap()
}

fn header() -> Header {
    Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap()
}

fn part(name: &str) -> Part {
    let text = FIXTURES.iter().find(|(n, _)| *n == name).unwrap().1;
    Part::read(&fixture_bytes(text).unwrap()).unwrap()
}

/// T2's fixture kinds as `commit` checks them, and the Souls T6's fixtures name.
fn rules() -> Rules {
    Rules {
        kinds: parse_kinds(FIXTURE_KINDS).unwrap(),
        souls: [dd(100), dd(101)].into(),
        audiences: BTreeMap::new(),
    }
}

fn kind(h: &Header, plain: &str) -> Name {
    h.kinds
        .iter()
        .find(|k| k.as_str().starts_with(&format!("{plain}@")))
        .unwrap()
        .clone()
}

/// The base world of T6's fixtures in a tree: a room under the root, a body in it holding a cup, a key and a crate.
fn base() -> (Header, Tree) {
    let h = header();
    let mut t = Tree::start(h.zone, kind(&h, "souls:place"));
    t.commit(&h, &part("0-base"), &rules()).unwrap();
    (h, t)
}

fn sorted(d: &Draft) -> Draft {
    let mut d = d.clone();
    d.nodes.sort_by_key(|n| n.id);
    d.links.sort_by_key(|l| l.id);
    d
}

#[test]
fn a1_t2s_fixtures_load_and_pass_t2s_check() {
    let kinds = parse_kinds(FIXTURE_KINDS).unwrap();
    for (name, text) in WORLDS {
        let draft = parse_world(&kinds, text).unwrap();
        let (tree, rules) = Tree::load(&draft).unwrap_or_else(|r| panic!("{name}: {r}"));
        let back = tree.to_draft(&rules);
        let world = check(&back).unwrap_or_else(|r| panic!("{name}: {r}"));
        assert_eq!(
            back,
            sorted(&draft),
            "{name}: the tree holds the world as written"
        );
        println!(
            "A1: {name}: {} nodes and {} links loaded through commit; T2's check passes ({} nodes, {} links)",
            tree.counts().0,
            tree.counts().1,
            world.node_count(),
            world.link_count()
        );
    }
}

#[test]
fn t6s_fixtures_give_the_harness_state_hashes_through_the_tree() {
    let h = header();
    let start = State::start(h.zone, kind(&h, "souls:place"));
    let mut s0 = start.clone();
    s0.apply(&h, &part("0-base")).unwrap();
    for (name, _) in FIXTURES {
        let p = part(name);
        let mut s = if name == "0-base" {
            start.clone()
        } else {
            s0.clone()
        };
        s.apply(&h, &p).unwrap();
        let mut t = if name == "0-base" {
            Tree::start(h.zone, kind(&h, "souls:place"))
        } else {
            base().1
        };
        t.apply(&h, &p).unwrap();
        assert_eq!(t.to_state(), s, "{name}: the tree's state is the harness's");
        let mut c = if name == "0-base" {
            Tree::start(h.zone, kind(&h, "souls:place"))
        } else {
            base().1
        };
        let committed = c
            .commit(&h, &p, &rules())
            .map_or_else(|r| r.to_string(), |()| "commits".into());
        println!(
            "T6 {name}: state {} through the tree and the harness; {committed}",
            s.hash().unwrap()
        );
    }
}

fn pose(parent: Id, slot: Option<u64>) -> Pose {
    Pose {
        frame: Frame { node: parent, slot },
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        support: if slot.is_some() {
            Support::Slot
        } else {
            Support::Surface {
                surface: parent,
                height: 0,
            }
        },
    }
}

fn effect(sequence: u64, node: Id, changes: Vec<Change>) -> Effect {
    Effect {
        envelope: Envelope {
            sequence,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
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

/// A part of `effects`, through its bytes, naming the fixtures' header.
fn part_of(h: &Header, effects: Vec<Effect>) -> Part {
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    Part::read(&encode(&v).unwrap()).unwrap()
}

#[test]
fn a4_a_handle_to_a_reused_slot_fails_and_a_remove_takes_its_links_from_the_far_ends() {
    let (h, mut t) = base();
    let next = t.to_state().next;
    let (room, key, crate_) = (ee(1), ee(6), ee(7));
    let old = t.handle(key).unwrap();
    // The key, linked to the crate (owned by the key) and owned by Soul 101 (owned by the key's end).
    let link = |l, ends, owner| Change::Link {
        link: ee(l),
        ty: Name::new("souls:tied-to").unwrap(),
        ends,
        owner,
        audience: Audience::Everyone,
    };
    let p = part_of(
        &h,
        vec![effect(
            next,
            key,
            vec![
                link(20, [key, crate_], End::First),
                link(21, [dd(101), key], End::Second),
            ],
        )],
    );
    t.commit(&h, &p, &rules()).unwrap();
    let at = |t: &Tree, end: Id| {
        t.links_at(end)
            .iter()
            .map(|e| show(e.link))
            .collect::<Vec<_>>()
    };
    println!(
        "A4: before: links at the crate {:?}, at Soul 101 {:?}",
        at(&t, crate_),
        at(&t, dd(101))
    );
    assert_eq!(at(&t, crate_), ["ee:20"]);
    assert_eq!(at(&t, dd(101)), ["ee:21"]);

    t.commit(
        &h,
        &part_of(
            &h,
            vec![effect(next + 1, key, vec![Change::Remove { node: key }])],
        ),
        &rules(),
    )
    .unwrap();
    println!(
        "A4: the key removed: links at the crate {:?}, at Soul 101 {:?}",
        at(&t, crate_),
        at(&t, dd(101))
    );
    assert!(at(&t, crate_).is_empty() && at(&t, dd(101)).is_empty());
    assert!(t.link(ee(20)).is_none() && t.link(ee(21)).is_none());

    let create = Change::Create {
        node: ee(30),
        kind: kind(&h, "souls:cup"),
        pose: pose(room, None),
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    };
    t.commit(
        &h,
        &part_of(&h, vec![effect(next + 2, room, vec![create])]),
        &rules(),
    )
    .unwrap();
    let new = t.handle(ee(30)).unwrap();
    println!("A4: old handle {old:?}, new node in the same slot {new:?}");
    assert_ne!(old, new, "the slot is reused under a new generation");
    assert!(t.node(old).is_none(), "the old handle fails");
    assert_eq!(t.node(new).unwrap().id(), ee(30));
}

#[test]
fn a3_listing_reads_one_node_and_no_link() {
    let (_, t) = base();
    let body = t.handle(ee(2)).unwrap();
    t.reset_reads();
    let links = t.links_of(body).unwrap();
    let children = t.children(body).unwrap();
    println!(
        "A3: the body's links {:?} and children {:?}: (node reads, link reads) = {:?}",
        links
            .iter()
            .map(|e| format!("{} {} {}", show(e.link), t.ty(e).as_str(), show(e.other)))
            .collect::<Vec<_>>(),
        children.len(),
        t.reads()
    );
    assert_eq!(t.reads(), (2, 0));
    t.reset_reads();
    let at_soul = t.links_at(dd(100));
    assert_eq!(at_soul.len(), 2);
    assert_eq!(
        t.reads(),
        (0, 0),
        "a Soul's links are read from its index alone"
    );
}

#[test]
fn a_refused_part_leaves_the_tree_as_it_was_and_commit_checks_each_change() {
    let (h, mut t) = base();
    let before = t.to_state();
    let next = before.next;
    let (room, body, crate_) = (ee(1), ee(2), ee(7));
    let set = |node, to: i64, by| Change::Set {
        node,
        field: 1,
        to: Value::Uint(to as u64),
        by: Some(by),
    };
    let cases: Vec<(&str, Vec<Effect>)> = vec![
        (
            "a create then a refusal",
            vec![
                effect(
                    next,
                    room,
                    vec![Change::Create {
                        node: ee(40),
                        kind: kind(&h, "souls:cup"),
                        pose: pose(room, None),
                        audience: Audience::Everyone,
                        fields: BTreeMap::new(),
                    }],
                ),
                effect(
                    next + 1,
                    room,
                    vec![
                        Change::Remove { node: room },
                        Change::Remove { node: crate_ },
                    ],
                ),
            ],
        ),
        (
            "a room in a hand",
            vec![effect(
                next,
                body,
                vec![Change::Create {
                    node: ee(41),
                    kind: kind(&h, "souls:room"),
                    pose: pose(body, Some(1)),
                    audience: Audience::Everyone,
                    fields: BTreeMap::new(),
                }],
            )],
        ),
        (
            "a self-link",
            vec![effect(
                next,
                body,
                vec![Change::Link {
                    link: ee(42),
                    ty: Name::new("souls:likes").unwrap(),
                    ends: [body, body],
                    owner: End::First,
                    audience: Audience::Everyone,
                }],
            )],
        ),
        (
            "a pour that does not balance",
            vec![effect(next, crate_, vec![set(crate_, 750, -250)])],
        ),
        (
            "a link to an end that is not here",
            vec![effect(
                next,
                body,
                vec![Change::Link {
                    link: ee(43),
                    ty: Name::new("souls:likes").unwrap(),
                    ends: [body, Id::new(FIXTURE_SCOPE_A, 9).unwrap()],
                    owner: End::First,
                    audience: Audience::Everyone,
                }],
            )],
        ),
    ];
    for (what, effects) in cases {
        let r = t.commit(&h, &part_of(&h, effects), &rules()).unwrap_err();
        println!("refused, {what}: {r}");
        assert_eq!(t.to_state(), before, "{what}: nothing changed");
    }
    let _: BTreeSet<Id> = BTreeSet::new();
}
