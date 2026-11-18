//! An object store in a folder, for one machine with no object store (a test machine, a laptop): each object a file
//! at its key, its ETag the SHA-256 of its bytes. Its conditional writes hold for one writer at a time, which is all
//! a single machine's `supervisor pin` needs; a fleet uses the real store ([`directoryd::directory::s3::S3`]).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use directoryd::directory::store::{Object, R, Store, When, refuse};
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
}
