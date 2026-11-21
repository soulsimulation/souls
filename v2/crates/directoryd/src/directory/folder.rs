//! An object store in a folder, for one machine with no object store (a test machine, a laptop): each object a file
//! at its key, its ETag the SHA-256 of its bytes. A conditional write holds an exclusive lock on the folder's
//! `.lock` file from its read to its rename, so its condition holds across processes too (O9, #2828: two processes
//! on one machine stand in for two machines, and the directory's claim is decided here); a fleet uses the real store
//! ([`super::s3::S3`]). Moved here from `supervisor` (O20b, #3523), so the directory's own program can ship its stores
//! to a folder too; `supervisor::folder` names it still.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use super::store::{Object, R, Store, When, refuse};
use replica::encode::to_hex;
use replica::ids::sha256;

pub struct Folder {
    root: PathBuf,
    reachable: AtomicBool,
}

impl Folder {
    /// The folder at `root`, made if it is not there.
    pub fn new(root: PathBuf) -> Folder {
        let _ = std::fs::create_dir_all(&root);
        Folder {
            root,
            reachable: AtomicBool::new(true),
        }
    }

    /// Takes the folder out of reach (and back), as a store out of reach is: every call is then refused.
    pub fn set_reachable(&self, reachable: bool) {
        self.reachable.store(reachable, Ordering::SeqCst);
    }

    /// Every key under `prefix`, in order (the bucket's names).
    pub fn keys(&self, prefix: &str) -> Vec<String> {
        fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for e in entries.flatten() {
                let path = e.path();
                if path.is_dir() {
                    walk(root, &path, out);
                } else if let Ok(rel) = path.strip_prefix(root) {
                    let key = rel.to_string_lossy().into_owned();
                    if !key.starts_with('.') && !key.ends_with(".new") {
                        out.push(key);
                    }
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &self.root, &mut out);
        out.retain(|k| k.starts_with(prefix));
        out.sort();
        out
    }

    fn reach(&self) -> R<()> {
        if self.reachable.load(Ordering::SeqCst) && self.root.is_dir() {
            Ok(())
        } else {
            refuse("store-unreachable", format!("{}", self.root.display()))
        }
    }
}

impl Store for Folder {
    fn get(&self, key: &str) -> R<Option<Object>> {
        self.reach()?;
        match std::fs::read(self.root.join(key)) {
            Ok(bytes) => Ok(Some(Object {
                etag: to_hex(&sha256(&bytes)),
                bytes,
            })),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => refuse("store-error", format!("{key}: {e}")),
        }
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        self.reach()?;
        // Held until this function returns: no other process reads and writes between our read and our rename.
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.root.join(".lock"))
            .and_then(|f| f.lock().map(|()| f));
        let _lock = match lock {
            Ok(f) => f,
            Err(e) => return refuse("store-error", format!(".lock: {e}")),
        };
        let now = self.get(key)?.map(|o| o.etag);
        match (when, now.as_deref()) {
            (When::Absent, None) => {}
            (When::Is(e), Some(n)) if e == n => {}
            _ => {
                return refuse(
                    "precondition-failed",
                    format!("{key}: asked {when:?}, the folder holds {now:?}"),
                );
            }
        }
        let path = self.root.join(key);
        let tmp = path.with_extension("new");
        let wrote = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&tmp, bytes))
            .and_then(|()| std::fs::rename(&tmp, &path));
        match wrote {
            Ok(()) => Ok(to_hex(&sha256(bytes))),
            Err(e) => refuse("store-error", format!("{key}: {e}")),
        }
    }

    fn list(&self, prefix: &str) -> R<Vec<String>> {
        self.reach()?;
        Ok(self.keys(prefix))
    }

    fn delete(&self, key: &str) -> R<()> {
        self.reach()?;
        match std::fs::remove_file(self.root.join(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => refuse("store-error", format!("{key}: {e}")),
        }
    }
}
