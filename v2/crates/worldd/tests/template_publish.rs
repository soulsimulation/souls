//! A template published from a seed's public support (`templates::publish_facts`, installed as `publish-template`) is
//! one this build's `worldd fork --template` accepts: its sealed header's kind pins are the seed's boot pins. The world
//! is a rack bay and an upright (import-eden's joining fixture), kinds whose entries join parts, so their pins follow
//! their entries (0.135): published from the facts alone, those pins differed and the fork was refused
//! `template-pins-mismatch` (0.142, the Mars camp's rack, shade and loading yards).

use std::path::{Path, PathBuf};
use std::process::Command;

use replica::ids::Scope;
use replica::rules::json;

/// A rack bay and an upright standing on the ground: no slots in the facts.
const FACTS: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [
    {"ref": "t-bay@1", "hash": "aa", "name": "mars:rack_bay", "form": "point"},
    {"ref": "t-upright@1", "hash": "bb", "name": "mars:rack_upright", "form": "point"}
  ],
  "things": [
    {"id": "e_bay", "def": "t-bay@1", "ref": "t-bay@1", "parent": null, "pose": [0, 0, 0, 0],
     "world": [0, 0, 0, 0], "scale_ppm": 1000000},
    {"id": "e_upright", "def": "t-upright@1", "ref": "t-upright@1", "parent": null, "pose": [3000, 0, 0, 0],
     "world": [3000, 0, 0, 0], "scale_ppm": 1000000}
  ],
  "doors": [],
  "places": [],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 2},
  "byRef": {"t-bay@1": 1, "t-upright@1": 1}
}"#;

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

/// The construction kinds and the body, as the repository has them.
fn entries(d: &Path) -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    for f in std::fs::read_dir(root.join("construction")).unwrap() {
        let p = f.unwrap().path();
        std::fs::copy(&p, entries.join(p.file_name().unwrap())).unwrap();
    }
    std::fs::copy(
        root.join("body/humanoid.json"),
        entries.join("humanoid.json"),
    )
    .unwrap();
    entries
}

fn worldd(args: &[&str], paths: &[(&str, &Path)]) -> std::process::Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_worldd"));
    c.args(args);
    for (flag, p) in paths {
        c.arg(flag).arg(p);
    }
    c.output().expect("worldd runs")
}

#[test]
fn a_template_published_from_a_seed_forks_with_the_seeds_pins() {
    let d = scratch("tpl-publish");
    let facts = FACTS;
    let path = d.join("facts.json");
    std::fs::write(&path, facts).unwrap();
    let support = d.join("support");
    let seeded = worldd(
        &["seed", "--souls", "0", "--at", "0,0"],
        &[
            ("--facts", &path),
            ("--entries", &entries(&d)),
            ("--dir", &support),
        ],
    );
    assert!(
        seeded.status.success(),
        "seed: {}",
        String::from_utf8_lossy(&seeded.stderr)
    );

    // The yard's kinds are named by their entries: the facts alone pin some of them otherwise.
    let (_, files) = templates::support(&support, facts.as_bytes()).expect("the seed's support");
    let kept = templates::support_entries(&files).unwrap();
    let names = |im: import_eden::Import| im.rules.kinds.into_keys().collect::<Vec<_>>();
    let bare = names(import_eden::load(facts).unwrap());
    let joined = names(import_eden::load_with(facts, &kept).unwrap());
    assert!(
        joined.iter().any(|k| !bare.contains(k)),
        "the bay and the upright are kinds whose entries join parts"
    );

    let out = d.join("out");
    let t = templates::publish_facts(
        facts,
        &out,
        "yard",
        Some(&support),
        Scope([7; 16]),
        vec![1; 32],
        0,
    )
    .expect("published");
    assert_eq!(t.name, "yard");
    let template = out.join("yard");
    for f in ["template", "header", "boot", "facts.json", "entry.json"] {
        assert!(template.join(f).is_file(), "{f}");
    }
    assert!(out.join("yard.source").is_dir());
    let again = templates::publish_facts(
        facts,
        &out,
        "yard",
        Some(&support),
        Scope([8; 16]),
        vec![1; 32],
        0,
    );
    assert!(
        again.unwrap_err().starts_with("template-exists"),
        "a template is never written over"
    );

    let forked = d.join("forked");
    let fork = worldd(
        &[
            "fork",
            "--through",
            &format!("{}:1", "ab".repeat(16)),
            "--scope",
            &"cd".repeat(16),
        ],
        &[
            ("--from", &template.join("ckpt")),
            ("--template", &template),
            ("--to", &forked),
        ],
    );
    assert!(
        fork.status.success(),
        "fork: {}",
        String::from_utf8_lossy(&fork.stderr)
    );
    let meta = json::parse(&std::fs::read_to_string(forked.join("world.json")).unwrap()).unwrap();
    assert_eq!(meta.get("fork"), Some(&json::Value::Bool(true)));
    std::fs::remove_dir_all(d).unwrap();
}
