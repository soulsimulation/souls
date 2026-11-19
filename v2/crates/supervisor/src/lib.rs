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
//! There is no start limit, no breaker and no resting state: systemd retries every failure, with a delay that grows
//! from [`RESTART_SEC_MS`] to [`RESTART_MAX_MS`].

pub mod folder;
pub mod health;

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

/// Where this machine keeps its cached copy of a world's record.
fn cache_path(root: &Path, world: &World) -> PathBuf {
    root.join("cache").join(world.name())
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
                let tmp = path.with_extension("new");
                if std::fs::write(&tmp, bytes).is_ok() {
                    let _ = std::fs::rename(&tmp, &path);
                }
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
