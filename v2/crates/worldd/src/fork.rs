//! The fork request (Engine v2 K6, #2670): `worldd fork --from <checkpoints> --to <new folder> --through <principal>`
//! starts the newest good checkpoint in `--from` as a new world in `--to` (`sim::checkpoint::fork`). The process
//! gives it what the engine may not make itself: a fresh lineage and minting scope and a seed from the operating
//! system's random source (T3 rule 1: never the world's random numbers, which a fork replays), and the real time of
//! the request, read once (T5 rule 10). A principal is written `<32 hex digits>:<counter>`. `--scope <32 hex digits>`
//! gives the lineage instead, when the directory has already named the world under it (W3).

use crate::watchdog::Real;
use replica::encode::{from_hex, to_hex};
use replica::ids::{Hash, Id, Purpose, Scope};
use sim::checkpoint::fork::{Request, fork, fork_with_kinds};
use sim::clock::Clock;
use std::io::Read;
use std::path::PathBuf;

/// Only the explicitly hash-pinned public catalogue may accompany a public fork.
fn catalogue_support(dir: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    use replica::encode::{Value, decode};
    let bytes = std::fs::read(dir.join("boot")).map_err(|e| e.to_string())?;
    let Value::Map(manifest) = decode(&bytes).map_err(|e| e.to_string())?.value else {
        return Err("template-bodies-invalid".into());
    };
    let Some(value) = manifest.get(&7) else {
        return Ok(None);
    };
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
    if replica::ids::sha256(&bytes).as_slice() != hash {
        return Err("template-bodies-mismatch".into());
    }
    skills::wear::Catalogue::read(
        std::str::from_utf8(&bytes).map_err(|_| "template-bodies-invalid")?,
    )
    .map_err(|_| "template-bodies-invalid")?;
    Ok(Some(bytes))
}

/// The fork's checkpoint interval: a checkpoint each 8 MiB of log (K5's bench constant).
const EVERY: u64 = 8 << 20;

/// `n` bytes from the operating system's random source.
fn random(n: usize) -> std::io::Result<Vec<u8>> {
    let mut b = vec![0; n];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b)
}

fn principal(s: &str) -> Option<Id> {
    let (scope, counter) = s.split_once(':')?;
    let scope: [u8; 16] = from_hex(scope).ok()?.try_into().ok()?;
    Id::new(Scope(scope), counter.parse().ok()?)
}

/// The fork request. Returns the exit code.
pub fn run(args: &[String]) -> i32 {
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|k| args.get(k + 1))
    };
    let (Some(from), Some(to), Some(through)) = (
        arg("--from").map(PathBuf::from),
        arg("--to").map(PathBuf::from),
        arg("--through").and_then(|p| principal(p)),
    ) else {
        eprintln!(
            "usage: worldd fork --from <checkpoints> --to <new folder> --through <32 hex>:<counter>"
        );
        return 2;
    };
    let given = arg("--scope").map(|s| from_hex(s).map_err(std::io::Error::other));
    let (scope, seed) = match (given.unwrap_or_else(|| random(16)), random(32)) {
        (Ok(s), Ok(seed)) => (Scope(s.try_into().unwrap_or([0; 16])), seed),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("worldd: fork: the random source: {e}");
            return 1;
        }
    };
    let mut real = Real::start();
    let real_us = real.now();
    let req = Request {
        through,
        scope,
        seed,
        real_us,
        // A stand-in for the build's hash until K14 names the real one.
        build: Hash::of(Purpose::Fixture, b"souls/worldd/0.0.0").to_bytes(),
        every: EVERY,
    };
    let template = arg("--template").map(PathBuf::from);
    // Validate all serving data and exact pins before the fork can create output.
    let pins = match template
        .as_ref()
        .map(|dir| crate::serve::template_pins(dir))
        .transpose()
    {
        Ok(pins) => pins,
        Err(e) => {
            eprintln!("worldd: fork: {e}");
            return 1;
        }
    };
    if let Some(dir) = &template
        && from != dir.join("ckpt")
    {
        eprintln!("worldd: fork: template-checkpoint-mismatch");
        return 1;
    }
    let bodies = match template
        .as_ref()
        .map(|dir| catalogue_support(dir))
        .transpose()
    {
        Ok(bodies) => bodies.flatten(),
        Err(error) => {
            eprintln!("worldd: fork: {error}");
            return 1;
        }
    };
    let result = match &pins {
        Some(pins) => fork_with_kinds(&from, &to, req, pins),
        None => fork(&from, &to, req),
    };
    match result {
        Ok(f) => {
            if let Some(template) = &template {
                let support = || -> Result<(), String> {
                    let cp = |name: &str| {
                        std::fs::copy(template.join(name), to.join(name))
                            .map(|_| ())
                            .map_err(|e| e.to_string())
                    };
                    cp("facts.json")?;
                    cp("boot")?;
                    if let Some(bytes) = &bodies {
                        std::fs::write(to.join("bodies.json"), bytes).map_err(|e| e.to_string())?;
                    }
                    for name in ["moves.json", "entry.json"] {
                        if template.join(name).exists() {
                            cp(name)?;
                        }
                    }
                    std::fs::create_dir_all(to.join("entries")).map_err(|e| e.to_string())?;
                    if template.join("entries").is_dir() {
                        for entry in std::fs::read_dir(template.join("entries"))
                            .map_err(|e| e.to_string())?
                        {
                            let entry = entry.map_err(|e| e.to_string())?;
                            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                                return Err("template-support-invalid".into());
                            }
                            std::fs::copy(entry.path(), to.join("entries").join(entry.file_name()))
                                .map_err(|e| e.to_string())?;
                        }
                    }
                    let entry = std::fs::read_to_string(to.join("entry.json"))
                        .unwrap_or_else(|_| "[0, 0]".into());
                    let creator = directoryd::accounts::principal_text(through).replace(':', "-");
                    let name = format!(
                        "{}-{}-{}",
                        to_hex(&scope.0),
                        to_hex(&f.header.zone.scope().0),
                        f.header.zone.counter()
                    );
                    let meta = format!(
                        "{{\"format\":\"souls/world/1\",\"name\":\"{name}\",\"fork\":true,\"souls_scope\":\"{}\",\"souls\":[],\"entry\":{entry},\"creator\":\"{creator}\"}}",
                        to_hex(&scope.0)
                    );
                    std::fs::write(to.join("world.json"), meta).map_err(|e| e.to_string())?;
                    std::fs::write(to.join("tokens"), b"").map_err(|e| e.to_string())?;
                    std::fs::rename(to.join("ckpt"), to.join("checkpoints"))
                        .map_err(|e| e.to_string())?;
                    Ok(())
                };
                if let Err(e) = support() {
                    eprintln!("worldd: fork: support-incomplete: {e}");
                    return 1;
                }
            }
            println!(
                "fork: lineage {} at sequence {}, {} bodies removed, {} things set down, {} bytes written, {} us",
                to_hex(&f.version.lineage.0),
                f.version.sequence,
                f.bodies.len(),
                f.set_down.len(),
                f.bytes,
                real.now() - real_us
            );
            0
        }
        Err(e) => {
            eprintln!("worldd: fork: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::encode::{Value, encode};
    use std::collections::BTreeMap;
    #[test]
    fn catalogue_support_rejects_tampering_and_legacy_does_not_copy_it() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.local")
            .join(format!("b15-fork-catalogue-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = br#"{"format":"souls/bodies/1","bodies":[]}"#;
        let mut boot = BTreeMap::new();
        std::fs::write(dir.join("boot"), encode(&Value::Map(boot.clone())).unwrap()).unwrap();
        std::fs::write(dir.join("bodies.json"), bytes).unwrap();
        assert_eq!(catalogue_support(&dir).unwrap(), None);
        boot.insert(7, Value::Bytes(replica::ids::sha256(bytes).to_vec()));
        std::fs::write(dir.join("boot"), encode(&Value::Map(boot.clone())).unwrap()).unwrap();
        assert_eq!(catalogue_support(&dir).unwrap(), Some(bytes.to_vec()));
        std::fs::write(dir.join("bodies.json"), b"{}").unwrap();
        assert_eq!(
            catalogue_support(&dir).unwrap_err(),
            "template-bodies-mismatch"
        );
        boot.insert(7, Value::Bytes(vec![0; 31]));
        std::fs::write(dir.join("boot"), encode(&Value::Map(boot)).unwrap()).unwrap();
        assert_eq!(
            catalogue_support(&dir).unwrap_err(),
            "template-bodies-invalid"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
