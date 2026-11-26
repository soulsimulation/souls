//! A template published from a facts file (N1's import) with the public serving support `worldd seed --souls 0` made
//! beside it: `templates <facts> <out> --name <name> [--support <seeded folder>]` (installed as `publish-template`).
//!
//! The tree is built with the entries `worldd seed` kept (`import_eden::load_with`), as `worldd` loads them: a kind
//! whose entry joins parts (a rack bay, a frame stand, a shade site, a loading spot) takes its slots, and its name's
//! hash, from its entry. Built from the facts alone, those kinds were pinned differently from the support's boot pins,
//! so `worldd fork --template` refused the template (`template-pins-mismatch`), and the joining kinds had no slots to
//! build into. Not yet as `worldd` builds a world: its courses step (`serve`'s `courses`: the punts it puts on the
//! water and the rides' courses) is not run, so a template of a world with punts or rides (Eden) has neither; and a
//! seed's code hatches (`hatches/`) are not carried.

use replica::encode::{Name, Value, decode, from_hex};
use replica::ids::{Hash, Purpose, Scope, sha256};
use replica::rules::json::{self, Value as Json};
use std::path::{Path, PathBuf};

use crate::Template;

// Root-packaged zero-Soul public support is the publisher's trust boundary. The serving binary independently
// recomputes these runtime pins before making any child fork. No creator, authority, log or seeded state is copied.
pub type PublicSupport = (Vec<Name>, Vec<(PathBuf, Vec<u8>)>);

pub fn support(dir: &Path, facts: &[u8]) -> Result<PublicSupport, String> {
    let manifest = std::fs::read(dir.join("boot")).map_err(|e| e.to_string())?;
    let Value::Map(m) = decode(&manifest).map_err(|e| e.to_string())?.value else {
        return Err("template-support-invalid".into());
    };
    if m.get(&1) != Some(&Value::Bytes(b"souls/public-boot/1".to_vec()))
        || m.get(&2) != Some(&Value::Bytes(sha256(facts).to_vec()))
        || !(4..=7).contains(&m.len())
    {
        return Err("template-support-mismatch".into());
    }
    let Some(Value::Array(pins)) = m.get(&3) else {
        return Err("template-pins-invalid".into());
    };
    if pins.is_empty() || pins.len() > 4096 {
        return Err("template-pins-invalid".into());
    }
    let mut kinds = Vec::new();
    for pin in pins {
        let Value::Text(pin) = pin else {
            return Err("template-pins-invalid".into());
        };
        let (name, hash) = pin
            .as_str()
            .rsplit_once('@')
            .ok_or("template-pins-invalid")?;
        if name.is_empty()
            // The catalogue's namespaces: content/kinds carries mars: kinds too, so a support seed pins them.
            || !["souls:", "eden:", "mars:"].iter().any(|ns| name.starts_with(ns))
            || !hash.starts_with("1220")
            || from_hex(hash).is_err()
            || hash.len() != 68
            || kinds
                .last()
                .is_some_and(|last: &Name| last.as_str() >= pin.as_str())
        {
            return Err("template-pins-invalid".into());
        }
        kinds.push(pin.clone());
    }
    let mut files = vec![
        (PathBuf::from("facts.json"), facts.to_vec()),
        (PathBuf::from("boot"), manifest.clone()),
    ];
    if std::fs::read(dir.join("facts.json")).map_err(|e| e.to_string())? != facts {
        return Err("template-support-mismatch".into());
    }
    let Some(Value::Array(entries)) = m.get(&4) else {
        return Err("template-support-invalid".into());
    };
    if entries.len() > 4096 {
        return Err("template-support-invalid".into());
    }
    for entry in entries {
        let Value::Array(pair) = entry else {
            return Err("template-support-invalid".into());
        };
        let [Value::Bytes(name), Value::Bytes(hash)] = pair.as_slice() else {
            return Err("template-support-invalid".into());
        };
        let name = std::str::from_utf8(name).map_err(|_| "template-support-invalid")?;
        if name.is_empty()
            || name.len() > 200
            || !name.ends_with(".json")
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || name.contains("..")
        {
            return Err("template-support-invalid".into());
        }
        let relative = PathBuf::from("entries").join(name);
        let path = dir.join(&relative);
        if !std::fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .is_file()
        {
            return Err("template-support-invalid".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if sha256(&bytes).as_slice() != hash {
            return Err("template-support-mismatch".into());
        }
        files.push((relative, bytes));
    }
    if let Some(Value::Bytes(hash)) = m.get(&5) {
        let bytes = std::fs::read(dir.join("moves.json")).map_err(|e| e.to_string())?;
        if sha256(&bytes).as_slice() != hash {
            return Err("template-support-mismatch".into());
        }
        files.push((PathBuf::from("moves.json"), bytes));
    }
    if let Some(Value::Bytes(hash)) = m.get(&6) {
        let bytes = std::fs::read(dir.join("entry.json")).map_err(|e| e.to_string())?;
        if sha256(&bytes).as_slice() != hash {
            return Err("template-support-mismatch".into());
        }
        files.push((PathBuf::from("entry.json"), bytes));
    }
    if let Some(value) = m.get(&7) {
        let Value::Bytes(hash) = value else {
            return Err("template-bodies-invalid".into());
        };
        let path = dir.join("bodies.json");
        if hash.len() != 32
            || !std::fs::symlink_metadata(&path)
                .map_err(|_| "template-bodies-invalid")?
                .is_file()
        {
            return Err("template-bodies-invalid".into());
        }
        let bytes = std::fs::read(&path).map_err(|_| "template-bodies-invalid")?;
        if sha256(&bytes).as_slice() != hash {
            return Err("template-bodies-mismatch".into());
        }
        skills::wear::Catalogue::read(
            std::str::from_utf8(&bytes).map_err(|_| "template-bodies-invalid")?,
        )
        .map_err(|_| "template-bodies-invalid")?;
        files.push((PathBuf::from("bodies.json"), bytes));
    }
    if m.keys().any(|key| !(1..=7).contains(key)) {
        return Err("template-support-invalid".into());
    }
    Ok((kinds, files))
}

/// Whether `name` may name a template: the catalogue's folder and the directory's key, a slug as the placement
/// initializer reads one (`[a-z0-9-]`, 1 to 40, not starting or ending with `-`).
pub fn valid_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The support's entries as `worldd` builds a world from them (`serve`'s `entries`, then `build`): each
/// `souls-entry/1` file under `entries/`, in name order, as `(kind, its JSON text)`. Other files are skipped, as there.
pub fn support_entries(files: &[(PathBuf, Vec<u8>)]) -> Result<Vec<(String, String)>, String> {
    let mut found: Vec<&(PathBuf, Vec<u8>)> = files
        .iter()
        .filter(|(p, _)| p.starts_with("entries") && p.extension().is_some_and(|x| x == "json"))
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = Vec::new();
    for (path, bytes) in found {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| format!("template-support-invalid: {} is not UTF-8", path.display()))?;
        let Ok(v) = json::parse(text) else { continue };
        if v.get("format").and_then(Json::str) != Some("souls-entry/1") {
            continue;
        }
        if let Some(kind) = v.get("kind").and_then(Json::str) {
            out.push((kind.to_owned(), v.to_json()));
        }
    }
    Ok(out)
}

/// Publishes `facts` as the template `name` in `out/<name>`, its source checkpoint in `out/<name>.source`, under the
/// fresh lineage `scope` (built in `out/.<name>.partial`, renamed when whole). With `support` (a folder `worldd seed --souls 0` made from the same facts), the tree is built
/// with its entries and the template carries its boot pins and public files; refused if either folder exists.
pub fn publish_facts(
    facts: &str,
    out: &Path,
    name: &str,
    support_dir: Option<&Path>,
    scope: Scope,
    seed: Vec<u8>,
    real_us: i64,
) -> Result<Template, String> {
    if !valid_name(name) {
        return Err(format!("template-name-invalid: {name}"));
    }
    // Published into a hidden sibling and renamed at the end, so a publish that fails part way never leaves a folder
    // with a `template` file the directory would list.
    let (dir, source, partial) = (
        out.join(name),
        out.join(format!("{name}.source")),
        out.join(format!(".{name}.partial")),
    );
    for d in [&dir, &source, &partial] {
        if std::fs::symlink_metadata(d).is_ok() {
            return Err(format!("template-exists: {}", d.display()));
        }
    }
    let public_support = support_dir
        .map(|p| support(p, facts.as_bytes()))
        .transpose()?;
    let (pins, files) = public_support.unwrap_or_default();
    let mut im = import_eden::load_with(facts, &support_entries(&files)?)?;
    let root = im.tree.node(im.tree.root()).ok_or("no root")?.id();
    crate::checkpoint(&mut im.tree, root.scope(), &source).map_err(|e| e.to_string())?;
    let t = crate::publish_with_kinds(
        &source,
        &partial,
        name,
        scope,
        seed,
        real_us,
        Hash::of(Purpose::Fixture, b"souls/worldd/0.0.0").to_bytes(),
        &pins,
    )
    .map_err(|e| e.to_string())?;
    for (relative, bytes) in files {
        let path = partial.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&partial, &dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::encode::encode;
    use std::collections::BTreeMap;
    #[test]
    fn a_template_is_named_by_a_slug() {
        for ok in ["mars-camp", "eden-2026", "a", &"x".repeat(40)] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "",
            "-mars",
            "mars-",
            "Mars",
            "mars camp",
            "../eden",
            "a.b",
            &"x".repeat(41),
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
        let out = PathBuf::from("/nonexistent");
        let refused = publish_facts("{}", &out, "Mars", None, Scope([0; 16]), vec![], 0);
        assert_eq!(refused.unwrap_err(), "template-name-invalid: Mars");
    }

    #[test]
    fn public_catalogue_is_hash_checked_and_legacy_support_is_unchanged() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.local")
            .join(format!("b15-template-catalogue-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let facts = b"{}";
        let mut boot = BTreeMap::from([
            (1, Value::Bytes(b"souls/public-boot/1".to_vec())),
            (2, Value::Bytes(sha256(facts).to_vec())),
            (
                3,
                Value::Array(vec![Value::Text(
                    Name::new(&format!("souls:body@1220{}", "00".repeat(32))).unwrap(),
                )]),
            ),
            (4, Value::Array(vec![])),
        ]);
        std::fs::write(dir.join("facts.json"), facts).unwrap();
        std::fs::write(dir.join("boot"), encode(&Value::Map(boot.clone())).unwrap()).unwrap();
        let legacy = support(&dir, facts).unwrap();
        assert_eq!(legacy.1.len(), 2);
        let catalogue = br#"{"format":"souls/bodies/1","bodies":[]}"#;
        std::fs::write(dir.join("bodies.json"), catalogue).unwrap();
        boot.insert(7, Value::Bytes(sha256(catalogue).to_vec()));
        std::fs::write(dir.join("boot"), encode(&Value::Map(boot.clone())).unwrap()).unwrap();
        let (_, files) = support(&dir, facts).unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(
            files.last().unwrap(),
            &(PathBuf::from("bodies.json"), catalogue.to_vec())
        );
        std::fs::write(dir.join("bodies.json"), b"{}").unwrap();
        assert_eq!(
            support(&dir, facts).unwrap_err(),
            "template-bodies-mismatch"
        );
        boot.insert(7, Value::Bytes(vec![0; 31]));
        std::fs::write(dir.join("boot"), encode(&Value::Map(boot)).unwrap()).unwrap();
        assert_eq!(support(&dir, facts).unwrap_err(), "template-bodies-invalid");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
