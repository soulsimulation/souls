//! Eden's template, saved once: `cargo run -p templates --release -- <eden facts> <out>` loads N1's import, takes
//! its checkpoint in `<out>/source` and publishes it as the template `eden-2026` in `<out>/eden-2026`.

use replica::encode::{Name, Value, decode, from_hex};
use replica::ids::sha256;
use std::io::Read;
use std::path::{Path, PathBuf};

use replica::ids::{Hash, Purpose, Scope};

fn random(n: usize) -> std::io::Result<Vec<u8>> {
    let mut b = vec![0; n];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b)
}

// The publish's real time is a recorded input of the template (T5 rule 10), read once here.
#[allow(clippy::disallowed_methods)]
fn real_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}

// Root-packaged zero-Soul public support is the publisher's trust boundary. The serving binary independently
// recomputes these runtime pins before making any child fork. No creator, authority, log or seeded state is copied.
type PublicSupport = (Vec<Name>, Vec<(PathBuf, Vec<u8>)>);

fn support(dir: &Path, facts: &[u8]) -> Result<PublicSupport, String> {
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(facts), Some(out)) = (args.get(1), args.get(2).map(PathBuf::from)) else {
        eprintln!("usage: templates <eden facts> <out>");
        std::process::exit(2);
    };
    let run = || -> Result<String, String> {
        let text = std::fs::read_to_string(facts).map_err(|e| e.to_string())?;
        let public_support = args
            .iter()
            .position(|a| a == "--support")
            .and_then(|i| args.get(i + 1))
            .map(|p| support(Path::new(p), text.as_bytes()))
            .transpose()?;
        let pins = public_support
            .as_ref()
            .map_or(&[][..], |(pins, _)| pins.as_slice());
        let mut im = import_eden::load(&text)?;
        let root = im.tree.node(im.tree.root()).ok_or("no root")?.id();
        templates::checkpoint(&mut im.tree, root.scope(), &out.join("source"))
            .map_err(|e| e.to_string())?;
        let scope: [u8; 16] = random(16)
            .map_err(|e| e.to_string())?
            .try_into()
            .map_err(|_| "16 bytes")?;
        let t = templates::publish_with_kinds(
            &out.join("source"),
            &out.join("eden-2026"),
            "eden-2026",
            Scope(scope),
            random(32).map_err(|e| e.to_string())?,
            real_us(),
            Hash::of(Purpose::Fixture, b"souls/worldd/0.0.0").to_bytes(),
            pins,
        )
        .map_err(|e| e.to_string())?;
        if let Some((_, files)) = public_support {
            for (relative, bytes) in files {
                let path = out.join("eden-2026").join(relative);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(path, bytes).map_err(|e| e.to_string())?;
            }
        }
        Ok(format!(
            "template {}: lineage {}, {} bytes, {} bodies removed",
            t.name,
            replica::encode::to_hex(&t.lineage.0),
            t.bytes,
            t.bodies.len()
        ))
    };
    match run() {
        Ok(s) => println!("{s}"),
        Err(e) => {
            eprintln!("templates: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::encode::encode;
    use std::collections::BTreeMap;
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
