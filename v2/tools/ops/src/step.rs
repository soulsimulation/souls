//! One step at a time on a machine (Engine v2 O16, #2809): a world's deploy and the gateway's upgrade never run in
//! the same step. Both take `$WORLDS_ROOT/step.lock`: a deploy shared (two worlds may deploy at once), an upgrade
//! exclusive. Neither waits: the one that finds the other refuses by name. The lock is the operating system's
//! (`flock`), so a process that dies lets it go.

// Two binaries include this module (`deploy`, `gateway-upgrade`); each uses its own half.
#![allow(dead_code)]

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

/// The lock's file in the machine's worlds folder.
pub const LOCK: &str = "step.lock";
/// The upgrade's refusal while a world deploys.
pub const WORLD_DEPLOYING: &str = "gateway-upgrade.world-deploying";
/// A deploy's refusal while the gateway is upgraded.
pub const GATEWAY_UPGRADING: &str = "deploy.gateway-upgrading";

fn open(root: &Path) -> Result<File, String> {
    std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(LOCK))
        .map_err(|e| format!("{LOCK}: {e}"))
}

fn held(r: Result<(), TryLockError>, refusal: &str) -> Result<(), String> {
    match r {
        Ok(()) => Ok(()),
        Err(TryLockError::WouldBlock) => Err(refusal.to_owned()),
        Err(TryLockError::Error(e)) => Err(format!("{LOCK}: {e}")),
    }
}

/// A world's deploy: held until the returned file drops. Refused while the gateway is upgraded.
pub fn deploying(root: &Path) -> Result<File, String> {
    let f = open(root)?;
    held(f.try_lock_shared(), GATEWAY_UPGRADING)?;
    Ok(f)
}

/// The gateway's upgrade: held until the returned file drops. Refused while any world deploys.
pub fn upgrading(root: &Path) -> Result<File, String> {
    let f = open(root)?;
    held(f.try_lock(), WORLD_DEPLOYING)?;
    Ok(f)
}
