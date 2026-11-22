//! The store a world's history, checkpoints and directory claims go to, from configuration (O3c, #3529): the offsite
//! bucket, or a folder standing in for it on one machine. The setting has the offsite bucket's form, the same as
//! O20b's `SOULS_BACKUP_URL` (#3523): `s3:https://<host>/<bucket>[/<prefix>]` (or the same without `s3:`), its keys in
//! `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` and its region in `AWS_DEFAULT_REGION`
//! ([`directoryd::directory::s3::S3::from_url`], through [`Bucket::parse`]); or `folder:<path>`, or a bare path, for
//! O9's folder store. Neither the URL nor a key is ever printed: [`Bucket::what`] names the kind of store only. The
//! type is [`directoryd::backup::Bucket`], shared with O20b's shipper.

use directoryd::directory::store::{Object, R, Store, When};

/// The offsite bucket, or a folder standing in for it: O20b's type (#3523), one for both (O3c's `parse` and `list`).
pub use directoryd::backup::Bucket;

/// A store's keys under a prefix, as a store of their own (the history's folder, `h/<world>/<lineage>/`, whose day
/// index names each bundle by its key there).
#[derive(Clone)]
pub struct Under<S> {
    pub store: S,
    pub prefix: String,
}

impl<S: Store> Store for Under<S> {
    fn get(&self, key: &str) -> R<Option<Object>> {
        self.store.get(&format!("{}{key}", self.prefix))
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        self.store
            .put(&format!("{}{key}", self.prefix), bytes, when)
    }

    fn list(&self, prefix: &str) -> R<Vec<String>> {
        Ok(self
            .store
            .list(&format!("{}{prefix}", self.prefix))?
            .into_iter()
            .filter_map(|k| k.strip_prefix(&self.prefix).map(str::to_owned))
            .collect())
    }
    fn delete(&self, key: &str) -> R<()> {
        self.store.delete(&format!("{}{key}", self.prefix))
    }
}

/// How long a read made [`patiently`] waits before each try after the first: four tries, about 14 s of waiting, or
/// about 34 s in all when each try runs to the S3 client's 5 s timeout.
pub const WAITS: [std::time::Duration; 3] = [
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(4),
    std::time::Duration::from_secs(8),
];

std::thread_local! {
    static PATIENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Runs `f` with this thread's reads through a [`Patient`] store tried again when the store is out of reach (#1960):
/// a world's start makes many reads of the bucket, and one slow answer must not end it. Reads elsewhere, and writes,
/// are tried once, as before.
pub fn patiently<T>(f: impl FnOnce() -> T) -> T {
    let before = PATIENT.with(|p| p.replace(true));
    let out = f();
    PATIENT.with(|p| p.set(before));
    out
}

/// A store whose reads (`get`, `list`) made [`patiently`] are tried again after each of `waits` while the store
/// answers `store-unreachable` (no answer in time, or a 5xx); then that refusal, as the store gave it. Any other
/// answer, a refusal or not, is the store's at once. Writes and deletes pass through untouched.
#[derive(Clone)]
pub struct Patient<S> {
    pub store: S,
    pub waits: &'static [std::time::Duration],
}

impl<S> Patient<S> {
    pub fn new(store: S) -> Patient<S> {
        Patient {
            store,
            waits: &WAITS,
        }
    }

    fn read<T>(&self, what: &str, call: impl Fn(&S) -> R<T>) -> R<T> {
        let mut waits = self.waits.iter();
        loop {
            match call(&self.store) {
                Err(e) if e.name == "store-unreachable" && PATIENT.with(std::cell::Cell::get) => {
                    let Some(wait) = waits.next() else {
                        return Err(e);
                    };
                    eprintln!(
                        "store: {what}: out of reach ({}), trying again in {} s",
                        e.detail,
                        wait.as_secs_f32()
                    );
                    std::thread::sleep(*wait);
                }
                answer => return answer,
            }
        }
    }
}

impl<S: Store> Store for Patient<S> {
    fn get(&self, key: &str) -> R<Option<Object>> {
        self.read(key, |s| s.get(key))
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        self.store.put(key, bytes, when)
    }

    fn list(&self, prefix: &str) -> R<Vec<String>> {
        self.read(prefix, |s| s.list(prefix))
    }

    fn delete(&self, key: &str) -> R<()> {
        self.store.delete(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use directoryd::directory::stand_in::{KEY_ID, StandIn};

    fn keys(k: &str) -> String {
        match k {
            "AWS_ACCESS_KEY_ID" => KEY_ID.to_owned(),
            "AWS_SECRET_ACCESS_KEY" => "stand-in-secret".to_owned(),
            _ => String::new(),
        }
    }

    fn refusal<T>(r: R<T>) -> &'static str {
        r.err().map_or("accepted", |e| e.name)
    }

    /// The same four calls on both stores: put if absent, get, list by prefix (over several pages on the stand-in),
    /// and the claim's compare-and-swap.
    fn same_trait(store: &Bucket) {
        assert_eq!(store.get("a/x").expect("read"), None);
        let first = store.put("a/x", b"1", When::Absent).expect("created");
        assert_eq!(
            refusal(store.put("a/x", b"2", When::Absent)),
            "precondition-failed"
        );
        let second = store.put("a/x", b"3", When::Is(&first)).expect("swapped");
        assert_eq!(
            refusal(store.put("a/x", b"4", When::Is(&first))),
            "precondition-failed"
        );
        assert_eq!(
            refusal(store.put("a/gone", b"4", When::Is(&first))),
            "precondition-failed"
        );
        let got = store.get("a/x").expect("read").expect("there");
        assert_eq!((got.etag, got.bytes), (second, b"3".to_vec()));
        for k in ["a/y", "a/z/1", "a/z/2", "b/x", "ab"] {
            store.put(k, k.as_bytes(), When::Absent).expect("created");
        }
        assert_eq!(
            store.list("a/").expect("listed"),
            ["a/x", "a/y", "a/z/1", "a/z/2"]
        );
        assert_eq!(store.list("").expect("listed").len(), 6);
        let under = Under {
            store,
            prefix: "a/z/".to_owned(),
        };
        assert_eq!(under.list("").expect("listed"), ["1", "2"]);
        assert_eq!(
            under.get("1").expect("read").map(|o| o.bytes),
            Some(b"a/z/1".to_vec())
        );
    }

    #[test]
    fn o3c_a1_the_s3_store_and_the_folder_store_answer_alike() {
        let dir = std::env::temp_dir().join(format!("supervisor-bucket-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let folder = Bucket::parse(&format!("folder:{}", dir.display()), keys).expect("a folder");
        same_trait(&folder);
        let s = StandIn::start(2).expect("a stand-in");
        let bucket = Bucket::parse(&format!("{}/run", s.url("souls")), keys).expect("settings");
        assert_eq!(bucket.what(), "the offsite bucket");
        same_trait(&bucket);
        assert!(
            s.paths().iter().all(|p| p.starts_with("souls/run/")),
            "under the URL's prefix"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A3: a refusal never carries the address or a key; unsigned requests are refused by the stand-in.
    #[test]
    fn o3c_a3_settings_refusals_name_no_address_or_key() {
        let s = StandIn::start(10).expect("a stand-in");
        for spec in [
            "s3:https://who:secret-x@host.example/b",
            "s3:https://host.example",
        ] {
            let e = Bucket::parse(spec, keys)
                .err()
                .unwrap_or_else(|| panic!("refused"));
            assert!(!e.detail.contains("secret-x") && !e.detail.contains("host.example"));
        }
        let wrong =
            Bucket::parse(&s.url("souls"), |_| "someone-else".to_owned()).expect("settings");
        let e = wrong.get("x").expect_err("refused");
        assert_eq!(e.name, "store-error");
        assert!(!e.detail.contains("someone-else"));
    }

    /// A store that answers its first `refusals` calls with the refusal `name`, counting every call.
    struct Flaky {
        store: directoryd::directory::store::Memory,
        name: &'static str,
        refusals: std::sync::atomic::AtomicUsize,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl Flaky {
        fn new(name: &'static str, refusals: usize) -> Flaky {
            let store = directoryd::directory::store::Memory::default();
            store.put("k", b"v", When::Absent).expect("written");
            Flaky {
                store,
                name,
                refusals: refusals.into(),
                calls: 0.into(),
            }
        }

        fn answer<T>(&self, then: impl FnOnce() -> R<T>) -> R<T> {
            use std::sync::atomic::Ordering::SeqCst;
            self.calls.fetch_add(1, SeqCst);
            match self
                .refusals
                .fetch_update(SeqCst, SeqCst, |n| n.checked_sub(1))
            {
                Ok(_) => directoryd::directory::store::refuse(self.name, "flaky"),
                Err(_) => then(),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Store for Flaky {
        fn get(&self, key: &str) -> R<Option<Object>> {
            self.answer(|| self.store.get(key))
        }
        fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
            self.answer(|| self.store.put(key, bytes, when))
        }
        fn list(&self, prefix: &str) -> R<Vec<String>> {
            self.answer(|| self.store.list(prefix))
        }
    }

    const SHORT: [std::time::Duration; 3] = [std::time::Duration::from_millis(1); 3];

    fn patient(name: &'static str, refusals: usize) -> Patient<Flaky> {
        Patient {
            store: Flaky::new(name, refusals),
            waits: &SHORT,
        }
    }

    /// #1960: a read made patiently is tried four times while the store is out of reach, then refused as the store
    /// refused it; any other refusal, a write, and a read made outside `patiently`, are tried once.
    #[test]
    fn i1960_patient_reads_try_four_times_and_nothing_else_is_tried_again() {
        let p = patient("store-unreachable", 3);
        let got = patiently(|| p.get("k")).expect("the fourth try reads");
        assert_eq!(
            (got.map(|o| o.bytes), p.store.calls()),
            (Some(b"v".to_vec()), 4)
        );
        let p = patient("store-unreachable", 3);
        assert_eq!(patiently(|| p.list("")).expect("listed"), ["k"]);
        assert_eq!(p.store.calls(), 4);

        let p = patient("store-unreachable", 4);
        assert_eq!(refusal(patiently(|| p.get("k"))), "store-unreachable");
        assert_eq!(p.store.calls(), 4, "four tries, then the store's refusal");

        for name in ["store-error", "precondition-failed"] {
            let p = patient(name, 1);
            assert_eq!(refusal(patiently(|| p.get("k"))), name);
            assert_eq!(p.store.calls(), 1, "{name} is the store's answer at once");
        }
        let p = patient("store-unreachable", 1);
        assert_eq!(
            refusal(patiently(|| p.put("k", b"w", When::Absent))),
            "store-unreachable"
        );
        assert_eq!(p.store.calls(), 1, "a write is never tried again");
        let p = patient("store-unreachable", 1);
        assert_eq!(refusal(p.get("k")), "store-unreachable");
        assert_eq!(p.store.calls(), 1, "outside patiently, one try");
    }
}
