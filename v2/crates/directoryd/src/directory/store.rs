//! The object store the directory's truth lives in (`v2/docs/durability.md` rules 7 and 12): objects by key, each
//! with an ETag, written only on one of two conditions. [`Memory`] is an in-memory store with the same refusals, for
//! tests; [`super::s3::S3`] is a real one over HTTP, and [`super::stand_in`] a local S3 stand-in for its tests.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use replica::effects::Refusal;
use replica::encode::to_hex;

pub type R<T> = Result<T, Refusal>;

pub fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// An object as read: its ETag (the version a conditional write names) and its bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Object {
    pub etag: String,
    pub bytes: Vec<u8>,
}

/// A write's condition, the only two the store is asked for: create only if absent (`If-None-Match: *`), or replace
/// only if the object is still the version read (`If-Match: <etag>`). There is no plain write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When<'a> {
    Absent,
    Is(&'a str),
}

/// An object store. Refusals by name: `precondition-failed` (the condition did not hold: HTTP 412, or 409 while
/// another conditional write to the key is in flight, or 404 for `If-Match` on a key that is gone),
/// `store-unreachable` (no answer, or the store says it is unavailable), `store-error` (any other answer).
pub trait Store {
    /// The object at `key`, or `None` when there is none.
    fn get(&self, key: &str) -> R<Option<Object>>;
    /// Writes `bytes` at `key` if `when` holds, atomically; returns the new ETag.
    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String>;
    /// Every key that starts with `prefix`, in order (O3c, #3529). A store that cannot list refuses,
    /// `store-cannot-list`.
    fn list(&self, prefix: &str) -> R<Vec<String>> {
        refuse(
            "store-cannot-list",
            format!("{prefix}: this store does not list"),
        )
    }
    /// Removes the object at `key`; none there is no refusal (#3833). A store that cannot delete refuses,
    /// `store-cannot-delete`.
    fn delete(&self, key: &str) -> R<()> {
        refuse(
            "store-cannot-delete",
            format!("{key}: this store does not delete"),
        )
    }

    /// The object at `key`'s length and ETag, without its bytes, or `None` when there is none. A store with no cheaper
    /// way reads the object.
    fn head(&self, key: &str) -> R<Option<(u64, String)>> {
        Ok(self.get(key)?.map(|o| (o.bytes.len() as u64, o.etag)))
    }

    /// Copies the object at `from` to `to`, a key that has none, inside the store; returns the copy's ETag. A store
    /// with no copy of its own reads the object and writes it create-only.
    fn copy(&self, from: &str, to: &str) -> R<String> {
        let Some(o) = self.get(from)? else {
            return refuse("store-error", format!("{from}: no object to copy"));
        };
        self.put(to, &o.bytes, When::Absent)
    }
}

/// Several machines' directories over one store.
impl<T: Store + ?Sized> Store for &T {
    fn get(&self, key: &str) -> R<Option<Object>> {
        (**self).get(key)
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        (**self).put(key, bytes, when)
    }

    fn list(&self, prefix: &str) -> R<Vec<String>> {
        (**self).list(prefix)
    }

    fn delete(&self, key: &str) -> R<()> {
        (**self).delete(key)
    }

    fn head(&self, key: &str) -> R<Option<(u64, String)>> {
        (**self).head(key)
    }

    fn copy(&self, from: &str, to: &str) -> R<String> {
        (**self).copy(from, to)
    }
}

/// An in-memory store with the store's refusals. Its ETag is the SHA-256 of the bytes, as a real store's is a hash
/// of the content. [`Memory::set_reachable`] takes it out of reach (and back): every call is then refused,
/// `store-unreachable`.
#[derive(Debug)]
pub struct Memory {
    objects: Mutex<BTreeMap<String, Object>>,
    reachable: AtomicBool,
}

impl Default for Memory {
    fn default() -> Memory {
        Memory {
            objects: Mutex::new(BTreeMap::new()),
            reachable: AtomicBool::new(true),
        }
    }
}

impl Memory {
    pub fn set_reachable(&self, reachable: bool) {
        self.reachable.store(reachable, Ordering::SeqCst);
    }

    /// Every key, in order: the directory's whole truth.
    pub fn keys(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Object>> {
        self.objects.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn reach(&self) -> R<()> {
        if self.reachable.load(Ordering::SeqCst) {
            Ok(())
        } else {
            refuse("store-unreachable", "the in-memory store is out of reach")
        }
    }
}

impl Store for Memory {
    fn get(&self, key: &str) -> R<Option<Object>> {
        self.reach()?;
        Ok(self.lock().get(key).cloned())
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        self.reach()?;
        let mut objects = self.lock();
        let now = objects.get(key).map(|o| o.etag.as_str());
        match (when, now) {
            (When::Absent, None) => {}
            (When::Is(e), Some(n)) if e == n => {}
            _ => {
                return refuse(
                    "precondition-failed",
                    format!("{key}: asked {when:?}, the store holds {now:?}"),
                );
            }
        }
        let etag = to_hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref());
        objects.insert(
            key.to_owned(),
            Object {
                etag: etag.clone(),
                bytes: bytes.to_vec(),
            },
        );
        Ok(etag)
    }

    fn list(&self, prefix: &str) -> R<Vec<String>> {
        self.reach()?;
        Ok(self
            .lock()
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect())
    }

    fn delete(&self, key: &str) -> R<()> {
        self.reach()?;
        self.lock().remove(key);
        Ok(())
    }
}
