//! The world model against its fixtures (Engine v2 T2, #2641; rules in `v2/docs/world-model.md`). Each `aN_` test is
//! one acceptance box; each test prints what it saw.

use replica::ids::{FIXTURE_SCOPE_A, Id};
use replica::world_model::{
    DEPTH_LIMIT, Draft, FIXTURE_KINDS, FIXTURE_SCOPE_SOULS, FIXTURES, Refusal, Viewer, World,
    check, parse_kinds, parse_world, show,
};

fn fixture(name: &str) -> &'static str {
    FIXTURES.iter().find(|(n, _)| *n == name).unwrap().1
}

fn draft(text: &str) -> Draft {
    parse_world(&parse_kinds(FIXTURE_KINDS).unwrap(), text).unwrap()
}

fn world(name: &str) -> World {
    check(&draft(fixture(name))).unwrap()
}

fn node(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_A, n).unwrap()
}

fn soul(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_SOULS, n).unwrap()
}

/// `text` with `from` replaced by `to`, where `from` occurs exactly once.
fn edit(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "{from:?} occurs once");
    text.replacen(from, to, 1)
}

/// A chain of crates `nodes` long under one place: the last crate has `nodes - 1` ancestors. Written flat, one record
/// per node, so the reader's nesting limit (32) does not bound it.
fn chain(nodes: u64) -> String {
    let kinds = "{1: \"souls:place\", 2: \"place\", 11: [\"souls:crate\"]}\n\
                 {1: \"souls:crate\", 2: \"thing\", 11: [\"souls:crate\"]}";
    let kinds = parse_kinds(kinds).unwrap();
    let mut w = String::from("{1: [], 2: {}, 3: [{1: 1, 2: \"souls:place\"}");
    for n in 2..=nodes {
        w.push_str(&format!(", {{1: {n}, 2: \"souls:crate\", 3: {}}}", n - 1));
    }
    w.push_str("], 4: []}");
    let d = parse_world(&kinds, &w).unwrap();
    match check(&d) {
        Ok(_) => "ok".into(),
        Err(r) => r.to_string(),
    }
}

#[test]
fn a1_the_five_fixtures_pass_the_check() {
    for (name, text) in FIXTURES {
        let w = check(&draft(text)).unwrap_or_else(|r| panic!("{name}: {r}"));
        let types: Vec<String> = w.links().map(|l| l.ty.clone()).collect();
        println!(
            "A1 {name}: passes, {} nodes, links {types:?}",
            w.node_count()
        );
    }
    let door = world("door.diag");
    let kind = &door.node(node(4)).unwrap().kind;
    println!("A1 a stored node's kind is T3's full name: {kind}");
    assert!(kind.starts_with("souls:door@1220"));
}

#[test]
fn a2_the_check_refuses_each_fault_by_name() {
    let refused = |text: &str| check(&draft(text)).unwrap_err();
    let faults: [(&str, Refusal); 4] = [
        // The boat's parent made the cabin inside it.
        (
            "tree-cycle",
            refused(&edit(
                fixture("boat.diag"),
                "{1: 2, 2: \"souls:boat\", 3: 1}",
                "{1: 2, 2: \"souls:boat\", 3: 3}",
            )),
        ),
        // The door's link pointed at a node that is not there.
        (
            "link-end-missing",
            refused(&edit(fixture("door.diag"), "3: [4, 3]", "3: [4, 99]")),
        ),
        // The kitchen made a child of the door, which admits nothing.
        (
            "child-not-admitted",
            refused(&edit(
                fixture("door.diag"),
                "{1: 3, 2: \"souls:room\", 3: 1,",
                "{1: 3, 2: \"souls:room\", 3: 4,",
            )),
        ),
        // The choir shown to its members only, and a membership link to everyone.
        (
            "link-audience-wider",
            refused(&edit(
                &edit(
                    fixture("membership.diag"),
                    "3: 1, 6: {1: \"choir\"}",
                    "3: 1, 5: 9, 6: {1: \"choir\"}",
                ),
                "3: [101, 2], 4: 1, 5: 9",
                "3: [101, 2], 4: 1, 5: \"everyone\"",
            )),
        ),
    ];
    for (want, r) in &faults {
        println!("A2 {r}");
        assert_eq!(r.name(), *want, "{r}");
    }
    let limit = u64::from(DEPTH_LIMIT);
    let at_limit = chain(limit + 1);
    let over = chain(limit + 2);
    println!("A2 a chain whose deepest node has {limit} ancestors: {at_limit}");
    println!("A2 one more: {over}");
    assert_eq!(at_limit, "ok");
    assert!(over.starts_with("depth-over-limit: "), "{over}");
    // A cycle with no root under it is found from any node, not only from one that has a root.
    let lone = edit(
        fixture("door.diag"),
        "{1: 1, 2: \"souls:place\"}",
        "{1: 1, 2: \"souls:place\", 3: 2}",
    );
    let r = refused(&lone);
    println!("A2 the place made a child of the hall: {r}");
    assert_eq!(r.name(), "tree-cycle");
}

#[test]
fn a3_a_link_is_listed_from_either_end_visiting_no_unrelated_node() {
    let cases = [
        ("door.diag", node(4), node(3), "leads-to"),
        ("boat.diag", node(5), node(4), "leads-to"),
        ("carried-load.diag", node(2), node(4), "carries"),
        ("ownership.diag", soul(100), node(4), "owns"),
        ("membership.diag", soul(100), node(2), "member"),
    ];
    for (name, a, b, ty) in cases {
        let w = world(name);
        let is_node = |id: Id| w.nodes().any(|n| n.id == id);
        let ends_are_nodes = (is_node(a), is_node(b));
        for ((from, to), from_is_node) in [((a, b), ends_are_nodes.0), ((b, a), ends_are_nodes.1)] {
            w.reset_reads();
            let listed = w.links_at(from, Viewer::Soul(soul(100)));
            let (node_reads, link_reads) = w.reads();
            let hit = listed.iter().find(|e| e.ty == ty && e.other == to);
            println!(
                "A3 {name}: from {} {} links, `{ty}` to {} {}, {node_reads} of {} nodes and {link_reads} of {} links read",
                show(from),
                listed.len(),
                show(to),
                if hit.is_some() { "listed" } else { "MISSING" },
                w.node_count(),
                w.link_count()
            );
            assert!(hit.is_some());
            assert_eq!(
                node_reads,
                u64::from(from_is_node),
                "only the asked node is read"
            );
            assert_eq!(
                link_reads, 0,
                "no link is read: the index entry carries what is listed"
            );
        }
    }
    // The counters see a scan: reading every link to find the ones at a node counts each.
    let w = world("carried-load.diag");
    w.reset_reads();
    let scanned = w.links().filter(|l| l.ends.contains(&node(4))).count();
    let (_, link_reads) = w.reads();
    println!(
        "A3 a scan for the same answer reads {link_reads} of {} links ({scanned} found)",
        w.link_count()
    );
    assert_eq!(link_reads, w.link_count());
    // The index carries the audience: who is in the choir is not listed to anyone else from the public choir.
    let w = world("membership.diag");
    let to_member = w.links_at(node(2), Viewer::Soul(soul(101))).len();
    let to_other = w.links_at(node(2), Viewer::Soul(soul(102))).len();
    let to_anyone = w.links_at(node(2), Viewer::Anyone).len();
    println!(
        "A3 membership.diag: the choir lists {to_member} links to a member, {to_other} to Soul 102, {to_anyone} to anyone"
    );
    assert_eq!((to_member, to_other, to_anyone), (2, 0, 0));
}

#[test]
fn a4_held_and_carried_things_are_children_and_nothing_has_two_parents() {
    // The cup in the body's right hand: a child of the body's slot 2, and no link joins the two.
    let w = world("ownership.diag");
    let cup = w.node(node(4)).unwrap();
    assert_eq!((cup.parent, cup.slot), (Some(node(3)), Some(2)));
    let between = |w: &World, a: Id, b: Id| {
        w.links()
            .filter(|l| l.ends.contains(&a) && l.ends.contains(&b))
            .count()
    };
    assert_eq!(between(&w, node(3), node(4)), 0);
    println!(
        "A4 ownership.diag: the cup's parent is {} slot 2, 0 links between body and cup",
        show(node(3))
    );
    // The sofa: a child of the carry activity; each carrier linked to the activity, none to the sofa.
    let w = world("carried-load.diag");
    let sofa = w.node(node(5)).unwrap();
    assert_eq!(sofa.parent, Some(node(4)));
    assert_eq!(w.links_at(node(5), Viewer::Anyone).len(), 0);
    for body in [node(2), node(3)] {
        assert_eq!(between(&w, body, node(4)), 1);
        assert_eq!(between(&w, body, node(5)), 0);
    }
    println!(
        "A4 carried-load.diag: the sofa's parent is the activity {}, 2 carriers linked to it, 0 links at the sofa",
        show(node(4))
    );
    // One parent each: every node is written once; a second record of the cup, in the other hand, is refused.
    for (name, text) in FIXTURES {
        let d = draft(text);
        let mut ids: Vec<Id> = d.nodes.iter().map(|n| n.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), d.nodes.len(), "{name}");
    }
    let twice = edit(
        fixture("ownership.diag"),
        "{1: 4, 2: \"souls:cup\", 3: 3, 4: 2},",
        "{1: 4, 2: \"souls:cup\", 3: 3, 4: 2}, {1: 4, 2: \"souls:cup\", 3: 3, 4: 1},",
    );
    let r = check(&draft(&twice)).unwrap_err();
    println!("A4 every fixture node written once; the cup written in both hands: {r}");
    assert_eq!(r.name(), "id-duplicate");
}

#[test]
fn a_slot_admits_by_category_read_from_the_childs_own_kind() {
    // The body's hands admit `thing`. A cup's and a key's kinds have owner `thing`; a body's kind has owner `family`.
    let held = edit(
        fixture("ownership.diag"),
        "{1: 5, 2: \"souls:key\", 3: 2}",
        "{1: 5, 2: \"souls:key\", 3: 3, 4: 1}",
    );
    let w = check(&draft(&held)).unwrap();
    println!(
        "category: a cup and a key, both things, in the body's two hands: passes, {} nodes",
        w.node_count()
    );
    let body_in_hand = edit(
        fixture("ownership.diag"),
        "{1: 5, 2: \"souls:key\", 3: 2}",
        "{1: 5, 2: \"souls:key\", 3: 2}, {1: 9, 2: \"souls:body\", 3: 3, 4: 1}",
    );
    let r = check(&draft(&body_in_hand)).unwrap_err();
    println!("category: a body in a hand that admits `thing`: {r}");
    assert_eq!(r.name(), "child-not-admitted");
    assert!(
        r.to_string()
            .contains("souls:body slot 1 does not admit souls:body")
    );
}
