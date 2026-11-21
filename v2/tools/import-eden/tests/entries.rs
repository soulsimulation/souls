//! Engine v2 C12 (#3427): Eden's things find their own Soul Actions entries. The exporter names today's built-in
//! defs `core:<name>` and authored ones `eden:eden_<name>`; the entries in `content/kinds` name both `eden:<name>`.
//! The importer names each kind as the entries do ([`import_eden::kind_name`]), so a world looks a thing's entry up
//! by its kind's plain name (as `worldd`'s acts do) and finds it.
//!
//! The Eden test needs the generated facts file: `cargo test -p import-eden --release -- --ignored --nocapture`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use import_eden::json::{self, Json};
use import_eden::kind_name;
use replica::world_model::plain;

#[test]
fn kinds_are_named_in_the_entries_namespace() {
    assert_eq!(kind_name("core:bike_rack"), "eden:bike_rack");
    assert_eq!(kind_name("eden:eden_big_wheel"), "eden:big_wheel");
    assert_eq!(kind_name("eden:floor"), "eden:floor");
    assert_eq!(kind_name("eden:eden_"), "eden:eden_");
    assert_eq!(kind_name("testworld:box"), "testworld:box");
}

/// Every `souls-entry/1` file under `dir`: kind -> file.
fn entries(dir: &Path, out: &mut BTreeMap<String, String>) {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            entries(&p, out);
        } else if p.extension().is_some_and(|x| x == "json") {
            let v = json::parse_skipping_fractions(&std::fs::read_to_string(&p).unwrap()).unwrap();
            if v.get("format").and_then(Json::str) == Some("souls-entry/1")
                && let Some(k) = v.get("kind").and_then(Json::str)
            {
                out.insert(k.to_owned(), p.display().to_string());
            }
        }
    }
}

/// The field numbers the import writes on Eden's nodes: every `pub const F_<NAME>: u64 = <n>;` in its source, read
/// from the file so the list cannot drift from the constants.
fn import_fields() -> BTreeMap<u64, String> {
    let src = std::fs::read_to_string(format!("{}/src/lib.rs", env!("CARGO_MANIFEST_DIR"))).unwrap();
    src.lines()
        .filter_map(|l| {
            let rest = l.trim().strip_prefix("pub const F_")?;
            let (name, n) = rest.split_once(": u64 = ")?;
            let n = n.split(';').next()?.trim().parse().ok()?;
            Some((n, format!("F_{name}")))
        })
        .collect()
}

/// A thing's entry fields and the import's fields share one numbering on the thing's node, so an entry's state field
/// numbered like an import field reads the import's value (today's id, def, name …) and its forms refuse or misbehave
/// on a served Eden (#1960: 99 of 173 Eden kinds with entries did). No entry's state field takes an import field's
/// number, but the door's, which are the engine's own door fields on purpose (`sim::links`: `open` is the import's
/// `F_OPEN`, and `locked` is `F_LOCKED`, a number the import gives only the open ground).
#[test]
fn no_entry_state_field_takes_a_number_the_import_writes() {
    let reserved = import_fields();
    assert!(reserved.len() > 20 && reserved.get(&1).map(String::as_str) == Some("F_ORIGIN"));
    let shared: [(&str, &str, u64); 2] = [
        ("eden:door", "open", sim::links::F_OPEN),
        ("eden:door", "locked", sim::links::F_LOCKED),
    ];
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let mut found = BTreeMap::new();
    entries(Path::new(&format!("{root}/content/kinds")), &mut found);
    let mut clash = Vec::new();
    for (kind, file) in &found {
        let v = json::parse_skipping_fractions(&std::fs::read_to_string(file).unwrap()).unwrap();
        let Some(Json::Obj(state)) = v.get("state") else {
            continue;
        };
        for (field, d) in state {
            let Some(n) = d.get("n").and_then(Json::int).and_then(|n| u64::try_from(n).ok()) else {
                continue;
            };
            if let Some(f) = reserved.get(&n)
                && !shared.contains(&(kind.as_str(), field.as_str(), n))
            {
                clash.push(format!("{kind} {field} = {n} ({f})"));
            }
        }
    }
    assert!(found.len() > 300, "the entries are found");
    assert!(clash.is_empty(), "state fields numbered as import fields:\n{}", clash.join("\n"));
}

#[test]
#[ignore = "needs the generated Eden 2026 facts file (see the module doc)"]
fn every_entry_naming_an_eden_kind_resolves_on_eden() {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let facts_path = std::env::var("EDEN_FACTS")
        .unwrap_or_else(|_| format!("{root}/.local/import-eden/eden-2026.facts.json"));
    let text = std::fs::read_to_string(&facts_path).expect("the Eden facts file");
    let facts = json::parse_skipping_fractions(&text).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let mut found = BTreeMap::new();
    entries(Path::new(&format!("{root}/content/kinds")), &mut found);

    // The kinds Eden's things are of, by plain name, as the world looks an entry up.
    let in_tree: BTreeSet<String> = im
        .nodes
        .values()
        .filter_map(|id| im.tree.node(im.tree.handle(*id)?))
        .map(|n| plain(n.kind().as_str()).to_owned())
        .collect();
    // An entry names an Eden kind when the bare name after its namespace is one of Eden's defs, whatever namespace
    // the exporter gave that def.
    let bare = |k: &str| {
        k.split_once(':')
            .map_or(k, |(_, n)| n)
            .trim_start_matches("eden_")
            .to_owned()
    };
    let eden: BTreeSet<String> = facts
        .get("kinds")
        .unwrap()
        .arr()
        .iter()
        .filter_map(|k| k.get("name").and_then(Json::str))
        .map(bare)
        .collect();
    let (mut resolved, mut refused, mut other) = (Vec::new(), Vec::new(), 0);
    for kind in found.keys() {
        if !eden.contains(&bare(kind)) {
            other += 1;
        } else if in_tree.contains(kind) {
            resolved.push(kind.clone());
        } else {
            refused.push(kind.clone());
        }
    }
    let things = im
        .nodes
        .values()
        .filter_map(|id| im.tree.node(im.tree.handle(*id)?))
        .filter(|n| found.contains_key(plain(n.kind().as_str())))
        .count();
    println!(
        "entries {}: naming an Eden kind {}, resolved {}, refused {} {:?}; naming no Eden kind {other}; \
         Eden's things with an entry {things}",
        found.len(),
        resolved.len() + refused.len(),
        resolved.len(),
        refused.len(),
        refused
    );
    assert!(refused.is_empty(), "refused: {refused:?}");
    assert!(resolved.len() > 100, "Eden's own entries resolve");
    assert!(
        resolved.contains(&"eden:bike_rack".to_owned())
            && resolved.contains(&"eden:bicycle".to_owned())
    );
}
