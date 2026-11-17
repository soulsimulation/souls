//! Ids, names and hashes against their fixtures (Engine v2 T3, #2640; rules in `v2/docs/ids.md`). The WASM build
//! gives the same golden file in Node (the `ids-goldens` step of `v2/tools/ci.sh`).

use replica::encode::to_hex;
use replica::ids::{
    FIXTURE_CUP, FIXTURE_KETTLE, FIXTURE_SCOPE_A, Hash, KindSource, Purpose, fork_then_travel_back,
    ids_goldens, name_kinds, sha256,
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
