//! Ids, names and hashes against their fixtures (Engine v2 T3, #2640; rules in `v2/docs/ids.md`). The WASM build
//! gives the same golden file in Node (the `ids-goldens` step of `v2/tools/ci.sh`).

use replica::encode::to_hex;
use replica::ids::{
    FIXTURE_CUP, FIXTURE_KETTLE, FIXTURE_SCOPE_A, FIXTURE_SCOPE_B, Hash, Held, Id, KindSource,
    Minter, Purpose, Scope, arrive, fork_then_travel_back, ids_goldens, name_kinds, sha256,
};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

fn fixture(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/ids")
        .join(name);
    fs::read_to_string(path).unwrap()
}

/// The kettle's full name when the kettle's and the cup's texts are these.
fn kettle(kettle: &str, cup: &str) -> String {
    let kinds = [kettle, cup].map(|t| KindSource::parse(t).unwrap());
    name_kinds(&kinds).unwrap()["souls:kettle"].to_string()
}

/// `text` with `from` replaced by `to`, where `from` occurs exactly once.
fn edit(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "{from:?} occurs once");
    text.replacen(from, to, 1)
}

#[test]
fn a1_fork_then_travel_back_gives_no_two_nodes_in_a_one_id() {
    let a = fork_then_travel_back();
    let ids: BTreeSet<_> = a.iter().map(|n| n.id).collect();
    assert_eq!(ids.len(), a.len(), "every node in A has its own id");
    for n in &a {
        let scope = if n.id.scope() == FIXTURE_SCOPE_A {
            "a"
        } else {
            "b"
        };
        let origin = n
            .origin
            .map(|o| format!(", origin a:{}", o.counter()))
            .unwrap_or_default();
        println!("A holds {scope}:{}{origin}", n.id.counter());
    }
    // Node a:2 came back from B while A still held it: it has a fresh id and keeps a:2 as its origin.
    let back = a.iter().find(|n| n.origin.is_some()).unwrap();
    assert_eq!(back.origin.unwrap().counter(), 2);
    assert_eq!(back.id.scope(), FIXTURE_SCOPE_A);
    assert_eq!(back.id.counter(), 5);
    // B's own new node arrived under B's scope, which A had never seen, and kept its id.
    assert!(
        a.iter()
            .any(|n| n.id.scope() != FIXTURE_SCOPE_A && n.origin.is_none())
    );
    println!("A1: {} nodes in A, {} distinct ids", a.len(), ids.len());
}

#[test]
fn a2_a_kinds_hash_changes_with_its_meaning_and_nothing_else() {
    let (k, cup) = (fixture("kettle.diag"), fixture("cup.diag"));
    assert_eq!(
        (k.as_str(), cup.as_str()),
        (FIXTURE_KETTLE, FIXTURE_CUP),
        "the committed kinds are the ones compiled in"
    );
    let base = kettle(&k, &cup);
    println!("base {base}");

    let changes: [(&str, String, String); 9] = [
        (
            "a field's type",
            edit(&k, r#""water_g", 2: "int""#, r#""water_g", 2: "count""#),
            cup.clone(),
        ),
        (
            "a field's default",
            edit(&k, "3: 20000", "3: 25000"),
            cup.clone(),
        ),
        (
            "a field's audience",
            edit(&k, r#"4: "holder""#, r#"4: "owner""#),
            cup.clone(),
        ),
        (
            "a field's number",
            edit(&k, r#"2: {1: "heat_mc""#, r#"3: {1: "heat_mc""#),
            cup.clone(),
        ),
        (
            "a field added",
            edit(
                &k,
                r#"4: "holder"}"#,
                r#"4: "holder"}, 3: {1: "lid", 2: "int", 3: 0, 4: "public"}"#,
            ),
            cup.clone(),
        ),
        (
            "a point",
            edit(&k, "[0, 90, 120]", "[0, 95, 120]"),
            cup.clone(),
        ),
        (
            "a form",
            edit(&k, r#"["fill", 1]"#, r#"["fill", 1], ["wait", 2000000]"#),
            cup.clone(),
        ),
        (
            "the geometry",
            edit(&k, "1111111111'", "1111111112'"),
            cup.clone(),
        ),
        ("a referenced kind", k.clone(), edit(&cup, "3: 0", "3: 250")),
    ];
    for (what, kettle_text, cup_text) in &changes {
        let changed = kettle(kettle_text, cup_text);
        println!("change of meaning, {what}: {changed}");
        assert_ne!(changed, base, "{what} changes the hash");
    }

    let renamed =
        std::env::temp_dir().join(format!("t3-a-different-name-{}.diag", std::process::id()));
    fs::write(&renamed, &k).unwrap();
    let from_other_file = fs::read_to_string(&renamed).unwrap();
    fs::remove_file(&renamed).unwrap();
    let non_changes: [(&str, String); 5] = [
        (
            "key order",
            edit(
                &k,
                "    1: {1: \"water_g\", 2: \"int\", 3: 0, 4: \"public\"},\n    2: {1: \"heat_mc\", 2: \"int\", 3: 20000, 4: \"holder\"}\n",
                "    2: {4: \"holder\", 3: 20000, 2: \"int\", 1: \"heat_mc\"},\n    1: {1: \"water_g\", 2: \"int\", 3: 0, 4: \"public\"}\n",
            ),
        ),
        (
            "comments",
            k.lines()
                .map(|l| l.split('#').next().unwrap())
                .collect::<Vec<_>>()
                .join("\n")
                + "\n# a new comment\n",
        ),
        ("spacing", k.replace(": ", " :\t ").replace('{', "{\n  ")),
        ("file name", from_other_file),
        (
            "a look beside the kind (SA-F1)",
            edit(&k, "kettle-steel", "kettle-copper"),
        ),
    ];
    for (what, text) in &non_changes {
        assert!(*what == "file name" || text != &k, "{what} edits the text");
        let same = kettle(text, &cup);
        println!("non-change, {what}: {same}");
        assert_eq!(same, base, "{what} keeps the hash");
    }
    println!(
        "A2: {} changes of meaning, each a new hash; {} non-changes, each the same",
        changes.len(),
        non_changes.len()
    );
}

#[test]
fn a3_goldens_match_the_committed_file() {
    let got = ids_goldens();
    print!("{got}");
    assert_eq!(
        got,
        fixture("goldens.txt"),
        "native goldens equal fixtures/ids/goldens.txt"
    );
    // SHA-256 itself, against FIPS 180-4's examples.
    assert_eq!(
        to_hex(&sha256(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        to_hex(&sha256(
            b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
        )),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
    // Public and private state are hashed apart: the same bytes under the two labels give two hashes.
    assert_ne!(
        Hash::of(Purpose::StatePublic, b"\xa0"),
        Hash::of(Purpose::StatePrivate, b"\xa0")
    );
    println!("A3: native goldens equal the committed file");
}

#[test]
fn a4_kinds_in_a_circle_are_refused_by_name() {
    let kind = |name: &str, refers: &str| {
        KindSource::parse(&format!("{{1: \"{name}\", 10: {{1: \"{refers}\"}}}}")).unwrap()
    };
    let circle = [kind("t:a", "t:b"), kind("t:b", "t:c"), kind("t:c", "t:a")];
    let refused = name_kinds(&circle).unwrap_err();
    println!("A4: {refused}");
    assert_eq!(refused.name(), "kind-circular");
    assert_eq!(
        refused.to_string(),
        "kind-circular: t:a -> t:b -> t:c -> t:a"
    );
    let alone = name_kinds(&[kind("t:a", "t:a")]).unwrap_err();
    println!("A4: {alone}");
    assert_eq!(alone.to_string(), "kind-circular: t:a -> t:a");
}

#[test]
fn two_zone_writers_in_one_world_mint_from_two_scopes() {
    // Rule 1: the world's first zone mints from the world's scope; a second zone writer gets its own.
    let (mut first, mut second) = (Minter::new(FIXTURE_SCOPE_A), Minter::new(Scope([0xcc; 16])));
    let mut ids = BTreeSet::new();
    for _ in 0..1000 {
        assert!(ids.insert(first.mint().unwrap()));
        assert!(ids.insert(second.mint().unwrap()));
    }
    // Had the second writer minted from the world's scope, its first id would be the first writer's.
    assert_eq!(
        Minter::new(FIXTURE_SCOPE_A).mint(),
        Minter::new(FIXTURE_SCOPE_A).mint()
    );
    println!("rule 1: two zone writers, {} ids, all distinct", ids.len());
}

#[test]
fn an_id_never_names_two_things_in_one_worlds_history() {
    // Rule 6, the path from the trunk review: A's a:2 travels to C; B's copy of a:2 (forked before) arrives in A;
    // then the original comes home from C. "Ever held" renames both arrivals, so a:2 names one thing in A's history.
    let (mut mint_a, mut held_a) = (Minter::new(FIXTURE_SCOPE_A), Held::default());
    let mut history = Vec::new();
    for _ in 0..4 {
        let id = mint_a.mint().unwrap();
        held_a.minted(id);
        history.push(id);
    }
    let held_b = held_a.clone(); // B is forked from A and holds a copy of a:2.
    let a2 = history[2];
    let (mut mint_c, mut held_c) = (Minter::new(Scope([0xcc; 16])), Held::default());
    let in_c = arrive(a2, &mut held_c, &mut mint_c).unwrap();
    assert_eq!(
        (in_c.id, in_c.origin),
        (a2, None),
        "C never held a:2: it keeps its id"
    );
    assert!(
        held_b.knows(a2) && held_a.knows(a2),
        "a:2 left A, and A still counts it as held"
    );
    let copy_from_b = arrive(a2, &mut held_a, &mut mint_a).unwrap();
    let home_from_c = arrive(in_c.id, &mut held_a, &mut mint_a).unwrap();
    for (what, arrived) in [
        ("B's copy", copy_from_b),
        ("the original, home", home_from_c),
    ] {
        println!(
            "rule 6: {what} of a:2 arrives in A as a:{}, origin a:2",
            arrived.id.counter()
        );
        assert_eq!(arrived.origin, Some(a2));
        history.push(arrived.id);
    }
    let distinct: BTreeSet<_> = history.iter().collect();
    assert_eq!(
        distinct.len(),
        history.len(),
        "every id A ever held names one thing"
    );
    // An id from a scope A never minted from arrives once under its own id; a second arrival of it is renamed.
    let foreign = Minter::new(FIXTURE_SCOPE_B).mint().unwrap();
    assert_eq!(
        arrive(foreign, &mut held_a, &mut mint_a).unwrap().origin,
        None
    );
    assert_eq!(
        arrive(foreign, &mut held_a, &mut mint_a).unwrap().origin,
        Some(foreign)
    );
}

#[test]
fn the_sections_beside_a_kind_have_their_own_hash() {
    // Rule 15: a look changes the souls/kind-beside/1 hash and not the kind's name.
    let cup = KindSource::parse(FIXTURE_CUP).unwrap();
    let named = |kettle: &str| {
        let kinds = [KindSource::parse(kettle).unwrap(), cup.clone()];
        name_kinds(&kinds).unwrap().remove("souls:kettle").unwrap()
    };
    let steel = named(FIXTURE_KETTLE);
    let copper = named(&edit(FIXTURE_KETTLE, "kettle-steel", "kettle-copper"));
    println!(
        "rule 15: steel beside {}, copper beside {}",
        steel.beside.unwrap(),
        copper.beside.unwrap()
    );
    assert_eq!(steel.hash, copper.hash);
    assert_ne!(steel.beside, copper.beside);
    assert_eq!(
        name_kinds(&[cup]).unwrap()["souls:cup"].beside,
        None,
        "no beside sections, no beside hash"
    );
    assert_ne!(
        Hash::of(Purpose::KindBeside, b"\xa0"),
        Hash::of(Purpose::Kind, b"\xa0")
    );
}

#[test]
fn a_model_is_hashed_apart_from_geometry() {
    // V17 (#2717): a stored model has its own label; v2/tools/import-eden/bake/bake.ts names files by this hash.
    assert_eq!(Purpose::Model.label(), "souls/model/1");
    assert_ne!(
        Hash::of(Purpose::Model, b"\xa0"),
        Hash::of(Purpose::Geometry, b"\xa0")
    );
    assert_eq!(
        Hash::of(Purpose::Model, b"\xa0").to_string(),
        "1220528068ccf7eb949f2747eaa35b723deb926e0580688e573affb8a350f7c9104c"
    );
}

#[test]
fn kind_names_are_lower_case() {
    // Rule 12: SA-F1's pattern, so no two kinds differ only in case.
    for bad in [
        "Souls:kettle",
        "souls:Kettle",
        "souls:ket-tle",
        "so_uls:kettle",
        "souls:kettle@1220",
        "souls:1k",
    ] {
        let refused = KindSource::parse(&format!("{{1: \"{bad}\"}}")).unwrap_err();
        assert_eq!(refused.name(), "kind-source", "{bad}");
    }
    assert!(KindSource::parse("{1: \"mars-college:bench_2\"}").is_ok());
}

/// #3213: `Id`'s order is the order its derived byte-by-byte compare gave (scope bytes, then counter), on random ids,
/// on scopes that share their first bytes (so each byte position decides some pairs), and on equal ones.
#[test]
fn id_order_is_the_bytes_order() {
    let mut s = 0x2a_u64;
    let mut next = || {
        s = s.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = s;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    };
    let mut ids = Vec::new();
    for _ in 0..400 {
        let mut b = [0u8; 16];
        for c in b.chunks_mut(8) {
            c.copy_from_slice(&next().to_le_bytes());
        }
        if next() % 2 == 0 {
            let keep = (next() % 17) as usize;
            for x in &mut b[keep..] {
                *x = 0;
            }
        }
        let counter = if next() % 3 == 0 {
            next() % 4
        } else {
            next() % (1 << 53)
        };
        ids.push(Id::new(Scope(b), counter).unwrap());
    }
    ids.push(ids[0]);
    let old = |a: &Id, b: &Id| (a.scope().0, a.counter()).cmp(&(b.scope().0, b.counter()));
    for a in &ids {
        for b in &ids {
            assert_eq!(a.cmp(b), old(a, b), "{a:?} {b:?}");
            assert_eq!(a.partial_cmp(b), Some(old(a, b)));
            assert_eq!(a.scope().cmp(&b.scope()), a.scope().0.cmp(&b.scope().0));
        }
    }
}
