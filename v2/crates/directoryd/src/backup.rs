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
//!   The restore is the `backup` crate's (`v2/tools/ops/backup`); the list, the seal and the shipper are here, so the
//!   programs that own the stores run the shipper themselves (O20b, #3523): the directory ([`run`] in `directoryd`'s
//!   `main`) and each world (`worldd serve`).
//! - **The bucket** is the one `SOULS_BACKUP_URL` names ([`Bucket::from_env`]): the offsite bucket in the form of the
//!   repository's `BACKUP_OFFSITE_URL` (`s3:https://<host>/<bucket>[/<prefix>]`, or the same without `s3:`), its keys
//!   in `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as the host's backup settings hold them; or `folder:<path>`, a
//!   folder standing in for it on one machine. With none set, a program ships nothing and says so once at start.

use std::collections::BTreeMap;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use crate::directory::folder::Folder;
use crate::directory::s3::S3;
use crate::directory::store::{Object, R, Store, When, refuse};
use replica::ids::sha256;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};

/// The list, as checked in.
pub const LIST: &str = include_str!("../../../tools/ops/stores.json");
/// Every copy's key starts with this ([`object_key`]).
pub const PREFIX: &str = "store/";
/// A world's folder in a path.
pub const WORLD: &str = "<world>";
/// The loss bar (#2812): at most five minutes of writes lost.
pub const LOSS_BAR_S: u64 = 300;

pub fn io<T>(what: &Path, r: std::io::Result<T>) -> R<T> {
    r.or_else(|e| refuse("io", format!("{}: {e}", what.display())))
}

// --- The list -----------------------------------------------------------------------------------------------------

/// How a store is copied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Copy {
    /// SQLite's online backup through the owning program (it holds the file exclusively).
    OwnerBackup,
    /// SQLite's online backup from a connection of the backup's own.
    SqliteBackup,
    /// A file written whole and renamed into place: read as it is.
    File,
    /// An append-only file: read as it is; at a restore the longer of two copies wins.
    Append,
    /// Every file of a folder.
    Files,
    /// K16's text store: `text`, then `uploads/`, then `removed`.
    TextStore,
    /// The log and its checkpoints: O3 ships them, not this.
    O3,
}

impl Copy {
    fn parse(s: &str) -> Option<Copy> {
        Some(match s {
            "owner-backup" => Copy::OwnerBackup,
            "sqlite-backup" => Copy::SqliteBackup,
            "file" => Copy::File,
            "append" => Copy::Append,
            "files" => Copy::Files,
            "text-store" => Copy::TextStore,
            "o3" => Copy::O3,
            _ => return None,
        })
    }
}

/// One line of the list.
#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub owner: String,
    /// Under the machine's data folder; a folder ends in `/`; `<world>` stands for each world's name.
    pub path: String,
    pub kind: String,
    pub copy: Copy,
    /// At most this often, when it changed.
    pub ship_s: u64,
}

/// Reads the list; refuses a line without a name, an owner, a path, a kind or a known copy.
pub fn list(text: &str) -> R<Vec<Entry>> {
    let v: serde_json::Value =
        serde_json::from_str(text).or_else(|e| refuse("stores-list", e.to_string()))?;
    let Some(rows) = v.get("stores").and_then(|s| s.as_array()) else {
        return refuse("stores-list", "no `stores` array");
    };
    let mut out = Vec::new();
    for row in rows {
        let s = |k: &str| row.get(k).and_then(|x| x.as_str()).map(str::to_owned);
        let (Some(name), Some(owner), Some(path), Some(kind), Some(copy)) =
            (s("name"), s("owner"), s("path"), s("kind"), s("copy"))
        else {
            return refuse(
                "stores-list",
                format!("a line needs name, owner, path, kind and copy: {row}"),
            );
        };
        let Some(copy) = Copy::parse(&copy) else {
            return refuse("stores-list", format!("{name}: unknown copy {copy}"));
        };
        let ship_s = row.get("ship_s").and_then(|x| x.as_u64()).unwrap_or(0);
        if copy != Copy::O3 && !(1..=LOSS_BAR_S).contains(&ship_s) {
            return refuse(
                "stores-list",
                format!("{name}: ship_s is 1 to {LOSS_BAR_S}"),
            );
        }
        out.push(Entry {
            name,
            owner,
            path,
            kind,
            copy,
            ship_s,
        });
    }
    Ok(out)
}

/// The checked-in list.
pub fn checked_in() -> R<Vec<Entry>> {
    list(LIST)
}

/// The list's lines for these worlds: `<world>` filled in, one line per world; O3's left out.
pub fn resolve(list: &[Entry], worlds: &[&str]) -> Vec<Entry> {
    let mut out = Vec::new();
    for e in list.iter().filter(|e| e.copy != Copy::O3) {
        if e.path.contains(WORLD) {
            for w in worlds {
                out.push(Entry {
                    path: e.path.replace(WORLD, w),
                    ..e.clone()
                });
            }
        } else {
            out.push(e.clone());
        }
    }
    out
}

/// Every file under `root` that no line of `list` covers (paths relative to `root`, sorted). A folder line covers
/// what is under it; an SQLite line its `-wal`, `-shm` and `-journal` files too.
pub fn unlisted(root: &Path, list: &[Entry]) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_string_lossy().into_owned());
            }
        }
    }
    let covers = |pattern: &str, sqlite: bool, file: &str| {
        let (p, f): (Vec<&str>, Vec<&str>) =
            (pattern.split('/').collect(), file.split('/').collect());
        let folder = pattern.ends_with('/');
        let p = if folder { &p[..p.len() - 1] } else { &p[..] };
        if f.len() < p.len() || (!folder && f.len() != p.len()) {
            return false;
        }
        p.iter().zip(&f).enumerate().all(|(i, (a, b))| {
            *a == WORLD
                || a == b
                || (!folder
                    && sqlite
                    && i == p.len() - 1
                    && ["-wal", "-shm", "-journal"]
                        .iter()
                        .any(|s| b.strip_prefix(*a) == Some(s)))
        })
    };
    let mut files = Vec::new();
    walk(root, root, &mut files);
    files.retain(|f| !list.iter().any(|e| covers(&e.path, e.kind == "sqlite", f)));
    files.sort();
    files
}

// --- Sealing ------------------------------------------------------------------------------------------------------

/// The key every copy is sealed with, derived from the recovery passphrase. The passphrase is kept off the machine
/// (the maintainer's password manager and the repository secret `BACKUP_RECOVERY_PASSWORD`).
pub struct Key(LessSafeKey);

const MAGIC: &[u8; 4] = b"SB1\n";
const ROUNDS: u32 = 100_000;

impl Key {
    pub fn from_passphrase(passphrase: &[u8]) -> R<Key> {
        if passphrase.len() < 16 {
            return refuse("backup-key", "the passphrase has at least 16 bytes");
        }
        let mut k = [0u8; 32];
        ring::pbkdf2::derive(
            ring::pbkdf2::PBKDF2_HMAC_SHA256,
            NonZeroU32::new(ROUNDS).unwrap_or(NonZeroU32::MIN),
            b"souls/backup/1",
            passphrase,
            &mut k,
        );
        let k = UnboundKey::new(&AES_256_GCM, &k).or_else(|_| refuse("backup-key", "aes"))?;
        Ok(Key(LessSafeKey::new(k)))
    }

    /// The key from the file `SOULS_BACKUP_KEY_FILE` names (its first line), if it is set.
    pub fn from_env() -> Option<R<Key>> {
        let path = std::env::var_os("SOULS_BACKUP_KEY_FILE")?;
        Some(
            io(Path::new(&path), std::fs::read_to_string(&path))
                .and_then(|t| Key::from_passphrase(t.lines().next().unwrap_or("").as_bytes())),
        )
    }

    /// `bytes` sealed for `key` (the object's key is bound in, so a copy cannot be put back under another store).
    pub fn seal(&self, key: &str, bytes: &[u8]) -> R<Vec<u8>> {
        let mut n = [0u8; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut n)
            .or_else(|_| refuse("backup-key", "no random nonce"))?;
        let mut body = bytes.to_vec();
        self.0
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(n),
                Aad::from(key.as_bytes()),
                &mut body,
            )
            .or_else(|_| refuse("backup-key", "seal"))?;
        let mut out = MAGIC.to_vec();
        out.extend_from_slice(&n);
        out.extend_from_slice(&body);
        Ok(out)
    }

    /// The bytes sealed under `key`, or `backup-sealed` when the key or the bytes are not the ones sealed.
    pub fn open(&self, key: &str, sealed: &[u8]) -> R<Vec<u8>> {
        let Some(rest) = sealed.strip_prefix(MAGIC.as_slice()) else {
            return refuse("backup-sealed", format!("{key}: not a sealed copy"));
        };
        if rest.len() < NONCE_LEN {
            return refuse("backup-sealed", format!("{key}: short"));
        }
        let (n, body) = rest.split_at(NONCE_LEN);
        let mut body = body.to_vec();
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(n);
        let plain = self
            .0
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(key.as_bytes()),
                &mut body,
            )
            .or_else(|_| {
                refuse(
                    "backup-sealed",
                    format!("{key}: the key or the bytes are not the ones sealed"),
                )
            })?;
        Ok(plain.to_vec())
    }
}

// --- Copies -------------------------------------------------------------------------------------------------------

/// A copy: each file's path under the store's own path (`""` for a store that is one file) and its bytes.
pub type Files = Vec<(String, Vec<u8>)>;

/// The owning program's copy of a store held exclusively: writes a consistent copy to the path given.
pub type Hook = Box<dyn Fn(&Path) -> Result<(), String> + Send + Sync>;

fn pack(files: &Files) -> Vec<u8> {
    let mut out = Vec::new();
    for (p, b) in files {
        out.extend_from_slice(&(p.len() as u32).to_be_bytes());
        out.extend_from_slice(p.as_bytes());
        out.extend_from_slice(&(b.len() as u64).to_be_bytes());
        out.extend_from_slice(b);
    }
    out
}

pub fn unpack(mut bytes: &[u8]) -> R<Files> {
    let mut out = Vec::new();
    let take = |b: &mut &[u8], n: usize| -> R<Vec<u8>> {
        if b.len() < n {
            return refuse("backup-sealed", "a copy cut short");
        }
        let (h, t) = b.split_at(n);
        *b = t;
        Ok(h.to_vec())
    };
    while !bytes.is_empty() {
        let n = u32::from_be_bytes(take(&mut bytes, 4)?.try_into().unwrap_or([0; 4])) as usize;
        let p = String::from_utf8(take(&mut bytes, n)?)
            .or_else(|_| refuse("backup-sealed", "a path"))?;
        if p.split('/').any(|s| s == "..") || p.starts_with('/') {
            return refuse("backup-sealed", format!("a path outside its store: {p}"));
        }
        let n = u64::from_be_bytes(take(&mut bytes, 8)?.try_into().unwrap_or([0; 8])) as usize;
        out.push((p, take(&mut bytes, n)?));
    }
    Ok(out)
}

pub fn read_if(path: &Path) -> R<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => refuse("io", format!("{}: {e}", path.display())),
    }
}

fn sqlite_backup(from: &Path, to: &Path) -> R<()> {
    let fail =
        |e: rusqlite::Error| refuse::<()>("sqlite-backup", format!("{}: {e}", from.display()));
    let src = match rusqlite::Connection::open_with_flags(
        from,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let mut dst = match rusqlite::Connection::open(to) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let b = match rusqlite::backup::Backup::new(&src, &mut dst) {
        Ok(b) => b,
        Err(e) => return fail(e),
    };
    b.run_to_completion(256, std::time::Duration::ZERO, None)
        .or_else(fail)
}

/// A consistent copy of `e` (its path under `root`), or `None` when the store is not there yet.
pub fn copy(
    root: &Path,
    e: &Entry,
    hooks: &BTreeMap<String, Hook>,
    staging: &Path,
) -> R<Option<Files>> {
    let at = root.join(&e.path);
    let one = |b: Option<Vec<u8>>| b.map(|b| vec![(String::new(), b)]);
    match e.copy {
        Copy::O3 => Ok(None),
        Copy::File | Copy::Append => Ok(one(read_if(&at)?)),
        Copy::OwnerBackup | Copy::SqliteBackup => {
            if e.copy == Copy::SqliteBackup && !at.exists() {
                return Ok(None);
            }
            io(staging, std::fs::create_dir_all(staging))?;
            let tmp = staging.join(format!("{}.copy", e.name));
            let _ = std::fs::remove_file(&tmp);
            if e.copy == Copy::OwnerBackup {
                let Some(hook) = hooks.get(&e.name) else {
                    return Ok(None);
                };
                hook(&tmp).or_else(|why| refuse("owner-backup", format!("{}: {why}", e.name)))?;
            } else {
                sqlite_backup(&at, &tmp)?;
            }
            let b = io(&tmp, std::fs::read(&tmp))?;
            let _ = std::fs::remove_file(&tmp);
            Ok(one(Some(b)))
        }
        Copy::Files => {
            if !at.is_dir() {
                return Ok(None);
            }
            let mut out = Vec::new();
            for f in unlisted(&at, &[]) {
                if let Some(b) = read_if(&at.join(&f))? {
                    out.push((f, b));
                }
            }
            Ok(Some(out))
        }
        Copy::TextStore => {
            // `text` first: every record in the copy then has its upload (synced and renamed before its record is
            // queued) unless the upload was erased since, and the removal list read last names every such erasure.
            let Some(text) = read_if(&at.join("text"))? else {
                return Ok(None);
            };
            let mut out = vec![("text".to_owned(), text)];
            let mut names: Vec<String> = std::fs::read_dir(at.join("uploads"))
                .map(|d| {
                    d.flatten()
                        .map(|f| f.file_name().to_string_lossy().into_owned())
                        .filter(|n| !n.ends_with(".incoming"))
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            for n in names {
                if let Some(b) = read_if(&at.join("uploads").join(&n))? {
                    out.push((format!("uploads/{n}"), b));
                }
            }
            out.push((
                "removed".to_owned(),
                read_if(&at.join("removed"))?.unwrap_or_default(),
            ));
            Ok(Some(out))
        }
    }
}

// --- Shipping -----------------------------------------------------------------------------------------------------

/// One store shipped.
#[derive(Clone, Debug)]
pub struct Shipped {
    pub name: String,
    pub key: String,
    pub bytes: u64,
}

/// Where a store's copy lives: `store/<name>` for the machine's, `store/worlds/<world>/<name>` for a world's (a key is
/// never a folder of another, as one store's path can be inside another's).
pub fn object_key(e: &Entry) -> String {
    let mut s = e.path.split('/');
    match (s.next(), s.next()) {
        (Some("worlds"), Some(w)) => format!("{PREFIX}worlds/{w}/{}", e.name),
        _ => format!("{PREFIX}{}", e.name),
    }
}

/// Ships a machine's stores: each when it has changed, at most every `ship_s` seconds. The caller reads the clock.
pub struct Shipper<S: Store> {
    pub bucket: S,
    pub key: Key,
    pub root: PathBuf,
    pub stores: Vec<Entry>,
    pub hooks: BTreeMap<String, Hook>,
    /// Taken off the front of each store's path before it is read under `root` (a world's own folder: `worlds/<world>/`,
    /// when `root` is that folder); its key keeps the whole path.
    pub strip: String,
    staging: PathBuf,
    /// Per store: when it was last looked at (µs) and the hash of what was last shipped.
    last: BTreeMap<String, (u64, [u8; 32])>,
}

impl<S: Store> Shipper<S> {
    /// `stores` already resolved for this machine's worlds ([`resolve`]).
    pub fn new(
        bucket: S,
        key: Key,
        root: PathBuf,
        stores: Vec<Entry>,
        staging: PathBuf,
    ) -> Shipper<S> {
        Shipper {
            bucket,
            key,
            root,
            stores,
            hooks: BTreeMap::new(),
            strip: String::new(),
            staging,
            last: BTreeMap::new(),
        }
    }

    /// Ships every store whose time has come and whose copy differs from the last one shipped.
    pub fn due(&mut self, now_us: u64) -> R<Vec<Shipped>> {
        let mut out = Vec::new();
        for e in &self.stores {
            let k = object_key(e);
            let (at, hash) = self.last.get(&k).copied().unwrap_or((0, [0; 32]));
            if at != 0 && now_us < at + e.ship_s * 1_000_000 {
                continue;
            }
            let local = Entry {
                path: e
                    .path
                    .strip_prefix(&self.strip)
                    .unwrap_or(&e.path)
                    .to_owned(),
                ..e.clone()
            };
            let Some(files) = copy(&self.root, &local, &self.hooks, &self.staging)? else {
                continue;
            };
            let plain = pack(&files);
            let h = sha256(&plain);
            self.last.insert(k.clone(), (now_us.max(1), h));
            if at != 0 && h == hash {
                continue;
            }
            let sealed = self.key.seal(&k, &plain)?;
            // One shipper writes a key: replace what it last read, or create it.
            let etag = self.bucket.get(&k)?.map(|o| o.etag);
            let when = etag.as_deref().map_or(When::Absent, When::Is);
            self.bucket.put(&k, &sealed, when)?;
            out.push(Shipped {
                name: e.name.clone(),
                key: k,
                bytes: sealed.len() as u64,
            });
        }
        Ok(out)
    }
}

// --- Running in the owning program (O20b, #3523) ------------------------------------------------------------------

/// The setting that names the bucket ([`Bucket::from_env`]).
pub const URL_ENV: &str = "SOULS_BACKUP_URL";
/// A shorter interval for a drill or a test, in seconds: each store ships at most this often (never less often than
/// the list says).
pub const SHIP_S_ENV: &str = "SOULS_BACKUP_SHIP_S";

/// The bucket a program's stores ship to: the offsite bucket, or a folder standing in for it.
pub enum Bucket {
    S3(S3),
    Folder(Folder),
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
}

impl Bucket {
    /// The bucket `SOULS_BACKUP_URL` names, or `None` when it is not set.
    pub fn from_env() -> Option<R<Bucket>> {
        let url = std::env::var(URL_ENV)
            .ok()
            .filter(|u| !u.trim().is_empty())?;
        Some(Bucket::parse(url.trim(), |k| {
            std::env::var(k).unwrap_or_default()
        }))
    }

    /// `folder:<path>`, or the offsite URL's form `[s3:]http(s)://<host>/<bucket>[/<prefix>]` with the keys from
    /// `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` and the region from `AWS_DEFAULT_REGION` (default `auto`, R2's).
    /// A refusal never repeats the URL: its host is a machine's address.
    pub fn parse(url: &str, var: impl Fn(&str) -> String) -> R<Bucket> {
        if let Some(p) = url.strip_prefix("folder:") {
            return Ok(Bucket::Folder(Folder::new(PathBuf::from(p))));
        }
        let form = || {
            refuse(
                "backup-settings",
                format!("{URL_ENV} is s3:https://<host>/<bucket>[/<prefix>] or folder:<path>"),
            )
        };
        let u = url.strip_prefix("s3:").unwrap_or(url);
        let Some((scheme, rest)) = u.split_once("://") else {
            return form();
        };
        let mut parts = rest.splitn(3, '/');
        let (Some(host), Some(bucket)) = (parts.next(), parts.next()) else {
            return form();
        };
        let prefix = match parts.next().map(|p| p.trim_matches('/')) {
            Some(p) if !p.is_empty() => format!("{p}/"),
            _ => String::new(),
        };
        let region = Some(var("AWS_DEFAULT_REGION"))
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| "auto".to_owned());
        S3::new(
            &format!("{scheme}://{host}"),
            bucket,
            &region,
            &var("AWS_ACCESS_KEY_ID"),
            &var("AWS_SECRET_ACCESS_KEY"),
            &prefix,
        )
        .map(Bucket::S3)
    }

    fn what(&self) -> &'static str {
        match self {
            Bucket::S3(_) => "the offsite bucket",
            Bucket::Folder(_) => "a folder standing in for the offsite bucket",
        }
    }
}

/// The checked-in list's lines that `owner` keeps, `<world>` filled in with `worlds` ([`resolve`]).
pub fn owned_by(owner: &str, worlds: &[&str]) -> R<Vec<Entry>> {
    Ok(resolve(&checked_in()?, worlds)
        .into_iter()
        .filter(|e| e.owner == owner)
        .collect())
}

#[allow(clippy::disallowed_methods)] // Operations: when a store last shipped is wall time; nothing here is on a tick.
fn unix_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

/// Starts `program`'s shipper on a thread of its own: once a second it ships each of `shipper.stores` whose time has
/// come and that changed ([`Shipper::due`]), saying a failure once until it ships again. The bucket is
/// `SOULS_BACKUP_URL`'s ([`Bucket::from_env`]) and the key `SOULS_BACKUP_KEY_FILE`'s. With no bucket set nothing ships;
/// a bucket set with no usable key, or a bucket refused, is refused here (a program refuses to start rather than run
/// thinking its stores are shipped). Returns the one line the program says at start.
pub fn run(
    program: &'static str,
    root: PathBuf,
    stores: Vec<Entry>,
    hooks: BTreeMap<String, Hook>,
    strip: &str,
) -> R<String> {
    let bucket = match Bucket::from_env() {
        None => {
            return Ok(format!(
                "{program}: backup: no bucket ({URL_ENV} is not set); its stores are not shipped"
            ));
        }
        Some(b) => b?,
    };
    let Some(key) = Key::from_env() else {
        return refuse(
            "backup-key",
            format!("{URL_ENV} is set but SOULS_BACKUP_KEY_FILE is not"),
        );
    };
    // A drill's or a test's shorter interval (`SOULS_BACKUP_SHIP_S`): never longer than the list's.
    let mut stores = stores;
    if let Some(s) = std::env::var(SHIP_S_ENV)
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        for e in &mut stores {
            e.ship_s = e.ship_s.min(s.max(1));
        }
    }
    let names: Vec<String> = stores.iter().map(|e| e.name.clone()).collect();
    let said = format!(
        "{program}: backup: shipping {} to {}",
        names.join(", "),
        bucket.what()
    );
    let staging = root.join(".backup-staging");
    let mut shipper = Shipper::new(bucket, key?, root, stores, staging);
    shipper.hooks = hooks;
    shipper.strip = strip.to_owned();
    std::thread::Builder::new()
        .name("backup".into())
        .spawn(move || {
            let mut failing: Option<String> = None;
            loop {
                match shipper.due(unix_us()) {
                    Ok(_) if failing.take().is_some() => {
                        eprintln!("{program}: backup: shipping again")
                    }
                    Ok(_) => {}
                    Err(e) => {
                        let why = format!("{}: {}", e.name, e.detail);
                        if failing.as_deref() != Some(why.as_str()) {
                            eprintln!("{program}: backup: not shipped, retried each second: {why}");
                        }
                        failing = Some(why);
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        })
        .or_else(|e| refuse("backup", e.to_string()))?;
    Ok(said)
}
