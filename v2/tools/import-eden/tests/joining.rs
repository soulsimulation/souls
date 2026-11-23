//! 0.135 (ahead of lane A's A2): a kind whose entry joins parts takes its slots from its entry. A served world's kinds
//! were the facts' alone, so a rack bay had no slots and nothing could be seated in it.
use import_eden::{load, load_with};
use replica::world_model::plain;
use std::collections::{BTreeMap, BTreeSet};

/// A world of a rack bay and an upright standing on the ground, and a chair: no slots in the facts.
const FACTS: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [
    {"ref": "t-bay@1", "hash": "aa", "name": "mars:rack_bay", "form": "point"},
    {"ref": "t-upright@1", "hash": "bb", "name": "mars:rack_upright", "form": "point"},
    {"ref": "core-chair@1", "hash": "cc", "name": "core:chair", "form": "point"}
  ],
  "things": [
    {"id": "e_bay", "def": "t-bay@1", "ref": "t-bay@1", "parent": null, "pose": [0, 0, 0, 0],
     "world": [0, 0, 0, 0], "scale_ppm": 1000000},
    {"id": "e_upright", "def": "t-upright@1", "ref": "t-upright@1", "parent": null, "pose": [3000, 0, 0, 0],
     "world": [3000, 0, 0, 0], "scale_ppm": 1000000},
    {"id": "e_chair", "def": "core-chair@1", "ref": "core-chair@1", "parent": null, "pose": [6000, 0, 0, 0],
     "world": [6000, 0, 0, 0], "scale_ppm": 1000000}
  ],
  "doors": [],
  "places": [],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 3},
  "byRef": {"t-bay@1": 1, "t-upright@1": 1, "core-chair@1": 1}
}"#;

/// The construction entries as the repository has them, by file name.
fn construction() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../content/kinds/construction");
    let mut out: Vec<(String, String)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| {
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                std::fs::read_to_string(&p).unwrap(),
            )
        })
        .collect();
    out.sort();
    out
}

fn kind<'a>(
    im: &'a import_eden::Import,
    name: &str,
) -> (&'a String, &'a replica::world_model::Kind) {
    im.rules
        .kinds
        .iter()
        .find(|(k, _)| plain(k) == name)
        .expect("the kind")
}

#[test]
fn a_joining_kind_takes_its_slots_from_its_entry() {
    let entries = construction();
    let bare = load(FACTS).expect("loads");
    let joined = load_with(FACTS, &entries).expect("loads with the entries");
    // The bay's slots, numbered and admitting as its entry says (K3's reader).
    let bay = entries.iter().find(|(n, _)| n == "rack_bay.json").unwrap();
    let text = replica::kinds::entry::entry_to_kind(&bay.1).expect("the bay's kind");
    let mut kinds = replica::kinds::Kinds::default();
    kinds.load(&[("bay", text.as_str())]);
    let def = kinds
        .admits()
        .into_keys()
        .find_map(|k| kinds.get(&k).cloned())
        .expect("the bay");
    let want: BTreeMap<u64, BTreeSet<String>> = def
        .slots
        .iter()
        .map(|(n, s)| (*n, s.admits.clone()))
        .collect();
    assert_eq!(want.len(), 6, "two uprights and four beams");
    assert!(
        kind(&bare, "mars:rack_bay").1.slots.is_empty(),
        "the facts alone give it none"
    );
    let (name, got) = kind(&joined, "mars:rack_bay");
    assert_eq!(got.slots, want, "{name}");
    assert!(
        got.slots.values().any(|a| a.contains("mars:rack_upright"))
            && got.slots.values().any(|a| a.contains("mars:rack_beam")),
        "its slots admit uprights and beams: {:?}",
        got.slots
    );
    // Its name follows its entry; a kind with no entry is the facts'.
    assert_ne!(kind(&bare, "mars:rack_bay").0, name);
    // An upright's entry names the crew that holds it among its children (0.135 A2): it admits that activity too.
    let (upright, got) = kind(&joined, "mars:rack_upright");
    assert_ne!(kind(&bare, "mars:rack_upright").0, upright);
    assert!(
        got.children.contains("mars:rack_upright_activity") && got.children.contains("thing"),
        "{:?}",
        got.children
    );
    assert_eq!(kind(&bare, "eden:chair").0, kind(&joined, "eden:chair").0);
}
