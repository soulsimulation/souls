//! Engine v2 O20 (#2812): what is not in the log is backed up and comes back. Runbook:
//! `v2/docs/runbook/restore-stores.md`.
//!
//! - **The list** is `v2/tools/ops/stores.json`: each store a machine keeps outside a world's log, its path under the
//!   machine's data folder (`<world>` for each world's folder), its kind, how it is copied and how often it ships. A
//!   task that adds a store adds a line; [`unlisted`] names any file in a data folder no line covers, and the test in
//!   `tests/stores.rs` fails on it. The log and its checkpoints are listed as `o3`: O3 ships them, not this.
//! - **A copy is consistent:** an SQLite store by SQLite's online backup, never a file copy, through its owner when the
//!   owner holds it exclusively (the account store, `owner-backup`); a file written whole and renamed (`file`) as it
//!   is; the text store in the order that keeps it whole (`text`, then its uploads, then its removal list); an
//!   append-only file (`append`) as it is, the longer copy winning at a restore.
//! - **A store ships when it changes, at most every `ship_s` seconds**, to the world's bucket beside O3's `part/`
//!   pieces ([`object_key`]), sealed (AES-256-GCM) under a key derived from the recovery passphrase, which is kept off
//!   the machine (`BACKUP_RECOVERY_PASSWORD`). The bucket keeps the newest copy of each store.
//! - **Restoring** writes each copy back to its path and then opens the text store, which finishes every erasure its
//!   removal list names (K16 rule 6): words erased before the loss stay erased whatever copy of the words came back.

//!
//! The list, the seal, the copy and the shipper are `directoryd::backup`, re-exported here: they moved there in O20b
//! (#3523) so directoryd and `worldd serve` run the shipper themselves. The restore is this crate's.

use std::path::{Path, PathBuf};

pub use directoryd::backup::*;
use directoryd::directory::store::{R, Store, refuse};

// --- Restoring ----------------------------------------------------------------------------------------------------

/// One store restored.
#[derive(Clone, Debug)]
pub struct Restored {
    pub name: String,
    pub path: PathBuf,
    pub files: usize,
    pub bytes: u64,
}

/// Restores `stores` (resolved) from the bucket alone: each store's newest copy written to its path under `root`, with
/// `strip` taken off the front of the path first (a world's own folder: `worlds/<world>/`). A store with no copy is
/// skipped. Then each restored text store is opened, which finishes every erasure its removal list names. `key` is
/// needed only when a copy is found.
pub fn restore<S: Store>(
    bucket: &S,
    key: Option<&Key>,
    stores: &[Entry],
    root: &Path,
    strip: &str,
) -> R<Vec<Restored>> {
    let mut out = Vec::new();
    for e in stores.iter().filter(|e| e.copy != Copy::O3) {
        let k = object_key(e);
        let Some(obj) = bucket.get(&k)? else {
            continue;
        };
        let Some(key) = key else {
            return refuse("backup-key", format!("{k} is sealed and no key is given"));
        };
        let files = unpack(&key.open(&k, &obj.bytes)?)?;
        let rel = e.path.strip_prefix(strip).unwrap_or(&e.path);
        let at = root.join(rel.trim_end_matches('/'));
        let mut bytes = 0;
        for (p, b) in &files {
            let to = if p.is_empty() { at.clone() } else { at.join(p) };
            if let Some(dir) = to.parent() {
                io(dir, std::fs::create_dir_all(dir))?;
            }
            if e.copy == Copy::Append && read_if(&to)?.is_some_and(|have| have.len() >= b.len()) {
                continue;
            }
            if e.kind == "sqlite" {
                for s in ["-wal", "-shm", "-journal"] {
                    let mut side = to.clone().into_os_string();
                    side.push(s);
                    let _ = std::fs::remove_file(PathBuf::from(side));
                }
            }
            let tmp = to.with_extension("restoring");
            io(&tmp, std::fs::write(&tmp, b))?;
            io(&to, std::fs::rename(&tmp, &to))?;
            bytes += b.len() as u64;
        }
        out.push(Restored {
            name: e.name.clone(),
            path: at,
            files: files.len(),
            bytes,
        });
    }
    // The removal list again: opening the text store finishes each erasure it names (K16 rule 6).
    for r in &out {
        if stores
            .iter()
            .any(|e| e.name == r.name && e.copy == Copy::TextStore)
        {
            let minter = replica::ids::Minter::new(replica::ids::Scope([0; 16]));
            sim::text::Store::open_dir(&r.path, minter)?.close();
        }
    }
    Ok(out)
}

/// The world's own stores restored into its data folder `dir` (one step of O12's restore): the list's
/// `worlds/<world>/` lines, `<world>` being `world`. The key comes from `SOULS_BACKUP_KEY_FILE`.
pub fn restore_world<S: Store>(bucket: &S, world: &str, dir: &Path) -> R<Vec<Restored>> {
    let prefix = format!("worlds/{world}/");
    let stores: Vec<Entry> = resolve(&checked_in()?, &[world])
        .into_iter()
        .filter(|e| e.path.starts_with(&prefix))
        .collect();
    let key = Key::from_env().transpose()?;
    restore(bucket, key.as_ref(), &stores, dir, &prefix)
}
