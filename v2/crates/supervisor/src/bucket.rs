//! The store a world's history, checkpoints and directory claims go to, from configuration (O3c, #3529): the offsite
//! bucket, or a folder standing in for it on one machine. The setting has the offsite bucket's form, the same as
//! O20b's `SOULS_BACKUP_URL` (#3523): `s3:https://<host>/<bucket>[/<prefix>]` (or the same without `s3:`), its keys in
//! `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` and its region in `AWS_DEFAULT_REGION`
//! ([`directoryd::directory::s3::S3::from_url`]); or `folder:<path>`, or a bare path, for O9's folder store. Neither
//! the URL nor a key is ever printed: [`Bucket::what`] names the kind of store only.

use std::path::PathBuf;

use directoryd::directory::s3::S3;
use directoryd::directory::store::{Object, R, Store, When};

use crate::folder::Folder;

/// The offsite bucket, or a folder standing in for it.
pub enum Bucket {
    S3(S3),
    Folder(Folder),
}

impl Bucket {
    /// The store `spec` names, its keys read through `var` (the process environment in [`Bucket::from_env`]).
    pub fn parse(spec: &str, var: impl Fn(&str) -> String) -> R<Bucket> {
        let spec = spec.trim();
        if let Some(p) = spec.strip_prefix("folder:") {
            return Ok(Bucket::Folder(Folder::new(PathBuf::from(p))));
        }
        if spec.starts_with("s3:") || spec.contains("://") {
            return S3::from_url(spec, var).map(Bucket::S3);
        }
        Ok(Bucket::Folder(Folder::new(PathBuf::from(spec))))
    }

    /// [`Bucket::parse`] with the keys from the process environment.
    pub fn from_env(spec: &str) -> R<Bucket> {
        Bucket::parse(spec, |k| std::env::var(k).unwrap_or_default())
    }

    /// What kind of store this is, for a line a person reads; never its address or its keys.
    pub fn what(&self) -> &'static str {
        match self {
            Bucket::S3(_) => "the offsite bucket",
            Bucket::Folder(_) => "a folder standing in for the offsite bucket",
        }
    }
}

impl Store for Bucket {
    fn get(&self, key: &str) -> R<Option<Object>> {
        match self {
            Bucket::S3(s) => s.get(key),
            Bucket::Folder(f) => f.get(key),
        }
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        match self {
            Bucket::S3(s) => s.put(key, bytes, when),
            Bucket::Folder(f) => f.put(key, bytes, when),
        }
    }

    fn list(&self, prefix: &str) -> R<Vec<String>> {
        match self {
            Bucket::S3(s) => s.list(prefix),
            Bucket::Folder(f) => f.list(prefix),
        }
    }
}

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
            let e = Bucket::parse(spec, keys).err().expect("refused");
            assert!(!e.detail.contains("secret-x") && !e.detail.contains("host.example"));
        }
        let wrong =
            Bucket::parse(&s.url("souls"), |_| "someone-else".to_owned()).expect("settings");
        let e = wrong.get("x").err().expect("refused");
        assert_eq!(e.name, "store-error");
        assert!(!e.detail.contains("someone-else"));
    }
}
