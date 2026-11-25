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
        got.children.contains("mars:carry_activity") && got.children.contains("thing"),
        "{:?}",
        got.children
    );
    assert_eq!(kind(&bare, "eden:chair").0, kind(&joined, "eden:chair").0);
}

/// A world map's `with` row (export/with.ts): today's guitar stand bakes no slot, so the facts give it its entry's
/// cradle and a guitar of the entry's own kind in it. The import admits it there, so the stand's `take` finds it.
#[test]
fn a_with_thing_sits_in_its_holders_slot() {
    const WITH: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [
    {"ref": "eden-guitar-stand@1", "hash": "aa", "name": "eden:guitar_stand", "form": "point"},
    {"ref": "entry:eden:guitar", "hash": "bb", "name": "eden:guitar", "form": "point"}
  ],
  "things": [
    {"id": "e_stand", "def": "eden-guitar-stand@1", "ref": "eden-guitar-stand@1", "parent": null, "pose": [0, 0, 0, 0],
     "world": [0, 0, 0, 0], "scale_ppm": 1000000, "entry": "eden:guitar_stand",
     "slots": [{"n": 1, "id": "cradle", "kind": "thing", "at": [0, 300, 0], "yaw": 0}]},
    {"id": "e_stand-with-1", "def": "eden:guitar", "ref": "entry:eden:guitar", "parent": "e_stand",
     "slot": {"n": 1, "id": "cradle"}, "pose": [0, 300, 0, 0], "scale_ppm": 1000000, "entry": "eden:guitar"}
  ],
  "doors": [],
  "places": [],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 2},
  "byRef": {"eden-guitar-stand@1": 1, "entry:eden:guitar": 1}
}"#;
    let im = load(WITH).expect("loads");
    let h = im
        .tree
        .handle(im.nodes["e_stand-with-1"])
        .expect("the guitar");
    let guitar = im.tree.node(h).expect("live");
    assert_eq!(plain(guitar.kind().as_str()), "eden:guitar");
    assert_eq!(guitar.parent(), Some(im.nodes["e_stand"]), "in the stand");
    assert_eq!(guitar.slot(), Some(1), "in its cradle");
    assert!(
        im.left_out.is_empty() && im.notes.is_empty(),
        "{:?} {:?}",
        im.left_out,
        im.notes
    );
}
