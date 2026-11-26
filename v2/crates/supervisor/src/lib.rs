//! A world's supervisor (Engine v2 O1, #2730): each world is its own process, `worldd@<world>.service`, with its own
//! limits and its own pinned build, restarted alone and for ever (`v2/tools/ops/units/worldd@.service`).
//!
//! - **The launcher** ([`pin`], [`build_path`]): the unit's `ExecStart`. It reads the world's pin from its directory
//!   record (W8), through this machine's cached copy when the store is out of reach, so an unreachable store holds no
//!   world down, and runs `builds/<hash>/worldd serve` on the world's folder (C1, #3365). A build that is not on the
//!   machine is a failed start like any other, `build.missing`, and is retried.
//! - **The restart record and the health record** ([`health`]): a world that cannot start writes nothing, so the
//!   supervisor keeps its own. A world started five times in five minutes and not serving is `restart-loop`, with
//!   its count, its last exit and its next try.
//!
//! - **Deploy and roll back** ([`deploy`], O7 #2804): a rehearsal on a scratch copy, a canary watch, and a rollback
//!   the machine takes on a fault, refused when the old build cannot read what the new one wrote.
//!
//! There is no start limit, no breaker and no resting state: systemd retries every failure, with a delay that grows
//! from [`RESTART_SEC_MS`] to [`RESTART_MAX_MS`].
//!
//! Moving a live world to another machine (O9, #2828) is [`moving`].
//!
//! - **Sleep and wake** (O2, #2731; [`sleep`], [`alarm`], [`wake`]): a still world with nothing due for a minute
//!   checkpoints, leaves its next due time in the directory and exits; the machine's alarm daemon wakes it before
//!   that time, or at once for an intent the gateway holds. Runbook: `v2/docs/runbook/sleep-and-wake.md`.

pub mod alarm;
pub mod bucket;
pub mod deploy;
pub mod folder;
pub mod health;
pub mod moving;
pub mod sleep;
pub mod wake;

use std::path::{Path, PathBuf};

use directoryd::directory::Directory;
use directoryd::directory::store::Store;
use replica::durability::WorldRecord;
use replica::encode::{Name, from_hex, to_hex};
use replica::ids::{Id, SHA2_256, Scope, sha256};

/// The first restart delay, ms (the unit's `RestartSec`).
pub const RESTART_SEC_MS: i64 = 100;
/// The longest restart delay, ms (the unit's `RestartMaxDelaySec`): a failing world is tried again at least this often.
pub const RESTART_MAX_MS: i64 = 29_000;
/// Restarts over which the delay grows from the first to the longest (the unit's `RestartSteps`).
pub const RESTART_STEPS: i64 = 10;

/// The launcher's own exit codes, which the health record names.
pub const EXIT_PIN_MISSING: i32 = 77;
pub const EXIT_BUILD_MISSING: i32 = 78;
pub const EXIT_BUILD_MISMATCH: i32 = 79;

/// A world by its unit's instance name: `<lineage>-<zone scope>-<zone counter>`, the two 16-byte parts in hex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct World {
    pub lineage: [u8; 16],
    pub zone: Id,
}

impl World {
    pub fn parse(name: &str) -> Result<World, String> {
        let bad = || format!("world name {name:?}: expected <32 hex>-<32 hex>-<counter>");
        let mut parts = name.split('-');
        let (Some(l), Some(s), Some(c), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(bad());
        };
        let sixteen = |h: &str| -> Option<[u8; 16]> { from_hex(h).ok()?.try_into().ok() };
        let (Some(lineage), Some(scope), Some(counter)) = (sixteen(l), sixteen(s), c.parse().ok())
        else {
            return Err(bad());
        };
        let zone = Id::new(Scope(scope), counter).ok_or_else(bad)?;
        Ok(World { lineage, zone })
    }

    pub fn name(&self) -> String {
        format!(
            "{}-{}-{}",
            to_hex(&self.lineage),
            to_hex(&self.zone.scope().0),
            self.zone.counter()
        )
    }

    /// Whether `key` is one of this world's own objects in the directory's store: its record `world/<L>/<Z>` (its
    /// pin, claims and mark) and every key under `ckpt/<L>/<Z>/`, `part/<L>/<Z>/`, `stream-recovery/<L>/<Z>/` and
    /// `h/<world>/` (`<L>` its lineage, `<Z>` its zone as `<scope>-<counter>`). Its name record, list row and Souls'
    /// records are the directory's, not its own.
    pub fn owns(&self, key: &str) -> bool {
        let zone = format!(
            "{}/{}-{}",
            to_hex(&self.lineage),
            to_hex(&self.zone.scope().0),
            self.zone.counter()
        );
        let under = |p: &str| {
            key.strip_prefix(p)
                .and_then(|k| k.strip_prefix(zone.as_str()))
                .is_some_and(|k| k.starts_with('/'))
        };
        key.strip_prefix("world/") == Some(zone.as_str())
            || under("ckpt/")
            || under("part/")
            || under("stream-recovery/")
            || key
                .strip_prefix("h/")
                .and_then(|k| k.strip_prefix(self.name().as_str()))
                .is_some_and(|k| k.starts_with('/'))
    }
}

/// The file in a world's folder that names its store generation (#4954): the place in the directory's store its own
/// objects ([`World::owns`]) are under, `g/<label>/` ([`bucket::Generation`]). A rebuilt world is seeded with a fresh
/// label, so it starts on an empty place and nothing of the old world's moves; the old folder, set aside, still names
/// the old place (no file: the keys as they are), so putting it back is the whole undo. `worldd serve`, the launcher's
/// pin and `deploy` read it.
pub const GENERATION_FILE: &str = "generation";

/// The store generation `folder` names ([`GENERATION_FILE`]): `None` without the file. A file that cannot be read, or
/// holds anything but one label of 1 to 64 letters, digits, `.`, `_` or `-`, refuses: a world is never served from a
/// place it did not name.
pub fn generation(folder: &Path) -> Result<Option<String>, String> {
    let path = folder.join(GENERATION_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("generation-unreadable: {}: {e}", path.display())),
    };
    let label = text.trim();
    let ok = !label.is_empty()
        && label.len() <= 64
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-');
    if ok {
        Ok(Some(label.to_owned()))
    } else {
        Err(format!(
            "generation-bad: {} holds no label (1 to 64 of A-Z a-z 0-9 . _ -)",
            path.display()
        ))
    }
}

/// The world's folder on this machine, `$WORLDS_ROOT/worlds/<world>`.
pub fn world_folder(root: &Path, world: &World) -> PathBuf {
    root.join("worlds").join(world.name())
}

/// A build's hash: the multihash (SHA-256) of its `worldd` file's bytes, 34 bytes, as `sha256sum` gives with `1220`
/// in front.
pub fn build_hash(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![SHA2_256, 32];
    out.extend_from_slice(&sha256(bytes));
    out
}

/// Where a build's `worldd` lives on this machine.
pub fn build_path(root: &Path, build: &[u8]) -> PathBuf {
    root.join("builds").join(to_hex(build)).join("worldd")
}

/// Where this machine keeps its cached copy of a world's record: one per store generation, so a folder put back by an
/// undo never starts on the pin a rebuilt world's record held.
fn cache_path(root: &Path, world: &World) -> PathBuf {
    match generation(&world_folder(root, world)) {
        Ok(Some(label)) => root.join("cache").join(format!("{}@{label}", world.name())),
        _ => root.join("cache").join(world.name()),
    }
}

/// Where the pin came from: the store, or this machine's cached copy because the store was out of reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum From {
    Store,
    Cache,
}

/// The world's pinned build, from its directory record. A record read from the store is kept as this machine's cached
/// copy; when the store is out of reach (or answers with an error) the cached copy is used. No record and no copy is
/// `pin.missing`.
pub fn pin<S: Store>(store: S, root: &Path, world: &World) -> Result<(Vec<u8>, From), String> {
    let mut directory = Directory::new(store, machine());
    match directory.world(&world.lineage, world.zone) {
        Ok(record) => {
            let path = cache_path(root, world);
            // A cache that cannot be written loses nothing but the next start's way round an unreachable store.
            if let Ok(bytes) = record.to_bytes() {
                let _ = std::fs::create_dir_all(root.join("cache"));
                let _ = health::write_synced(&path, &bytes);
            }
            Ok((record.build, From::Store))
        }
        Err(r) if r.name == "store-unreachable" || r.name == "store-error" => {
            let bytes = std::fs::read(cache_path(root, world))
                .map_err(|_| format!("pin.missing: the store: {}, and no cached copy", r.name))?;
            let record = WorldRecord::read(&bytes)
                .map_err(|e| format!("pin.missing: the cached copy: {}", e.name))?;
            Ok((record.build, From::Cache))
        }
        Err(r) => Err(format!("pin.missing: {}: {}", r.name, r.detail)),
    }
}

/// Pins `build` for `world` in the store (W8's `set_build`).
pub fn set_pin<S: Store>(store: S, world: &World, build: &[u8]) -> Result<(), String> {
    Directory::new(store, machine())
        .set_build(&world.lineage, world.zone, build)
        .map_err(|r| format!("{}: {}", r.name, r.detail))
}

/// The supervisor only reads records and pins builds, which name no machine.
fn machine() -> Name {
    Name::new("souls:supervisor").unwrap_or_else(|| unreachable!("a name"))
}

/// A known local archive fence wins even during a Store outage. An unavailable Store otherwise leaves the
/// established pin-cache path intact; the caller still requires its ordinary valid cached pin/build.
pub fn archive_guard<S: Store>(store: S, fences: &Path, world: &World) -> Result<(), String> {
    let fence = fences.join(world.name());
    match std::fs::symlink_metadata(&fence) {
        Ok(meta) => {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("archive-fence-invalid".into());
            }
            let bytes = std::fs::read(&fence).map_err(|_| "archive-fence-unreadable")?;
            return directoryd::worlds::list::archive::check_fence(&bytes, &world.name())
                .map_err(|e| e.name.to_owned());
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("archive-fence-unreadable".into()),
    }
    match directoryd::worlds::list::archive::instance_blocked(&store, &world.lineage, world.zone) {
        Ok(false) => Ok(()),
        Ok(true) => Err("world-archived".into()),
        Err(e) if e.name == "store-unreachable" || e.name == "store-error" => Ok(()),
        Err(e) => Err(e.name.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::Folder;

    fn world() -> World {
        World {
            lineage: [0xab; 16],
            zone: Id::new(Scope([0x01; 16]), 7).expect("an id"),
        }
    }

    #[test]
    fn a_world_name_reads_back() {
        let w = world();
        assert_eq!(World::parse(&w.name()), Ok(w));
        assert!(World::parse("a-b-c").is_err());
    }

    /// #4954: a world rebuilt on a fresh store generation reads and writes its own objects under `g/<label>/` and the
    /// directory's keys as they are; the old world's objects are never read, written or moved, and the folder without
    /// the file (the undo) is the old world's store again, record, pin and all.
    #[test]
    fn a_fresh_generation_starts_on_an_empty_place_and_moves_nothing() {
        use bucket::Generation;
        use directoryd::directory::store::When;
        let dir =
            std::env::temp_dir().join(format!("supervisor-generation-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Folder::new(dir.join("directory"));
        let w = world();
        let (l, z) = ("ab".repeat(16), format!("{}-7", "01".repeat(16)));
        assert!(w.owns(&format!("world/{l}/{z}")));
        assert!(w.owns(&format!("part/{l}/{z}/0/t/1")));
        assert!(w.owns(&format!("h/{}/{l}/archive/head", w.name())));
        assert!(!w.owns(&format!("world/{l}/{z}0")), "another zone's");
        assert!(!w.owns(&format!("part/{l}/{z}7/x")), "another zone's");
        assert!(!w.owns("world-name/eden"), "the directory's");

        // The old world: pinned, with a part and a name record of the directory's.
        let old = build_hash(b"old");
        set_pin(&store, &w, &old).expect("pinned");
        let part = format!("part/{l}/{z}/0/t/1");
        store.put(&part, b"old part", When::Absent).expect("a part");
        store
            .put("world-name/eden", b"name", When::Absent)
            .expect("a name");
        let before = store.list("").expect("listed");

        let folder = world_folder(&dir, &w);
        std::fs::create_dir_all(&folder).expect("a folder");
        assert_eq!(generation(&folder), Ok(None));
        std::fs::write(folder.join(GENERATION_FILE), "20261126T120000Z\n").expect("written");
        let label = generation(&folder).expect("read");
        assert_eq!(label.as_deref(), Some("20261126T120000Z"));
        let fresh = Generation::new(&store, w, label.as_deref());
        assert!(
            pin(&fresh, &dir, &w)
                .unwrap_err()
                .starts_with("pin.missing"),
            "the fresh place holds no record"
        );
        assert_eq!(fresh.get(&part).expect("read"), None, "nor the old part");
        assert_eq!(
            fresh.list(&format!("part/{l}/{z}/")).expect("listed"),
            Vec::<String>::new()
        );
        assert_eq!(
            fresh.get("world-name/eden").expect("read").map(|o| o.bytes),
            Some(b"name".to_vec()),
            "the directory's keys as they are"
        );
        let new = build_hash(b"new");
        set_pin(&fresh, &w, &new).expect("pinned");
        fresh
            .put(&part, b"new part", When::Absent)
            .expect("a part of its own");
        assert_eq!(pin(&fresh, &dir, &w).map(|p| p.0), Ok(new));
        assert_eq!(
            fresh.list(&format!("part/{l}/{z}/")).expect("listed"),
            vec![part.clone()]
        );
        // Nothing of the old world's was touched: every key it had holds the same bytes, and the new ones are all
        // under g/<label>/.
        let after = store.list("").expect("listed");
        for k in &before {
            assert!(after.contains(k), "{k} stayed");
        }
        assert!(
            after
                .iter()
                .filter(|k| !before.contains(k))
                .all(|k| k.starts_with("g/20261126T120000Z/"))
        );
        assert_eq!(
            store.get(&part).expect("read").map(|o| o.bytes),
            Some(b"old part".to_vec())
        );

        // The undo: the folder without the file is the old world's place again, its pin with it.
        std::fs::remove_file(folder.join(GENERATION_FILE)).expect("removed");
        let back = Generation::new(&store, w, generation(&folder).expect("read").as_deref());
        assert_eq!(pin(&back, &dir, &w).map(|p| p.0), Ok(old));
        std::fs::write(folder.join(GENERATION_FILE), "../x").expect("written");
        assert!(
            generation(&folder)
                .unwrap_err()
                .starts_with("generation-bad")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pin_comes_from_the_cache_when_the_store_is_out_of_reach() {
        let dir = std::env::temp_dir().join(format!("supervisor-pin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Folder::new(dir.join("directory"));
        let w = world();
        let build = build_hash(b"a build");
        assert!(
            pin(&store, &dir, &w)
                .unwrap_err()
                .starts_with("pin.missing")
        );
        set_pin(&store, &w, &build).expect("pinned");
        assert_eq!(pin(&store, &dir, &w), Ok((build.clone(), From::Store)));
        store.set_reachable(false);
        assert_eq!(pin(&store, &dir, &w), Ok((build, From::Cache)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
