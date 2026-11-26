//! `store-copy`: copies the objects one store setting names to the store another settings file names under the same
//! setting, and checks the copy by count and size; or writes, reads and deletes one object under a probe prefix. An
//! operator's tool (not the engine), for `v2/tools/ops/store-switch.sh` (0.133 ST2): the worlds' bucket moved to
//! another provider, the old one only read.
//!
//! ```text
//! store-copy copy --from <settings> --to <settings> --setting <NAME> [--world <world>]... [--skip <prefix>]... [--manifest <file>] [--dry-run]
//! store-copy probe --settings <settings> --setting <NAME>
//! ```
//!
//! A settings file is `KEY=value` lines, systemd's `EnvironmentFile=` form (`export ` and quotes allowed), as
//! `/etc/souls/secrets.env` is. `<NAME>` is the setting that names the bucket: `DIRECTORY_STORE_URL` (read as the
//! directory reads it, [`S3::from_vars`]: the URL, else the `DIRECTORY_STORE_*` settings), or `SOULS_BACKUP_URL` or
//! `WORLDD_STORE` (the offsite form, [`S3::from_url`]); each file's keys and region are its own. Only a bucket is
//! copied: a `folder:` store refuses. Keys are read from the files by path and never printed; neither is an endpoint,
//! a bucket or a prefix: output names the setting only.
//!
//! `copy` lists every key under the source (or, with `--world`, only that world's keys, as `world-aside` names them,
//! and the same keys under every store generation, `g/<label>/`, where a rebuilt world's are: #4954), and for each one: none at the target is written create-only; one there with the same length and ETag (or, when
//! the ETags differ, the same SHA-256) counts as made; one there with other bytes (a record written again since the
//! last run) is replaced on its ETag. So a run stopped halfway is finished by the next. With `--manifest`, each key's
//! ETag at the target as this tool last wrote or matched it is appended to the file (`<etag> <key>` lines), and a key
//! whose target ETag has changed since is the target's own newer write (a world already moved, writing there): it is
//! kept, never replaced, and counted. It then reads the target back and prints the source's count and bytes against
//! the target's for the same keys; exit 1 when they differ. The source is only read. Every call is tried again with back-off while a store is out of reach. `--dry-run` lists and compares
//! by length and ETag only, writing nothing. `--skip <prefix>` (repeatable, under the setting's own prefix, e.g.
//! `aside/`) leaves the keys under it out of the copy and of the count, and the result line says how many.
//!
//! `probe` writes one object under `probe/store-switch/<time>/`, reads it back, deletes it and lists the prefix
//! empty. Exits 0 on success, 1 on a refusal or a check that failed, 2 on a usage or settings error.
// Operations, not the engine: the probe's key and the back-off read the wall clock.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::time::Duration;

use directoryd::directory::s3::{S3, URL_ENV};
use directoryd::directory::store::{R, Store, When, refuse};
use replica::encode::to_hex;
use replica::ids::sha256;
use supervisor::World;

/// The largest object copied: 4 GiB (a world's stream-recovery objects pass ureq's 10 MiB).
const OBJECT_LIMIT: u64 = 4 << 30;
/// Each request's bound; a stalled phase is given up on sooner and tried again.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);
const RETRIES: u32 = 6;
const FIRST_WAIT: Duration = Duration::from_secs(2);
/// The settings a bucket's address may be read from: the only lines of a settings file kept.
const NAMES: [&str; 3] = [URL_ENV, "SOULS_BACKUP_URL", "WORLDD_STORE"];

fn usage() -> ! {
    eprintln!(
        "usage: store-copy copy --from <settings> --to <settings> --setting <NAME> [--world <world>]... [--skip <prefix>]... [--dry-run]\n       store-copy probe --settings <settings> --setting <NAME>"
    );
    std::process::exit(2)
}

/// The `KEY=value` lines of a settings file (`export ` and one pair of quotes allowed; `#` lines skipped).
pub fn settings(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim();
        let v = match v.as_bytes() {
            [q @ (b'"' | b'\''), .., e] if q == e && v.len() > 1 => &v[1..v.len() - 1],
            _ => v,
        };
        out.insert(k.trim().to_owned(), v.to_owned());
    }
    out
}

/// The bucket `name` names in `vars`, for an operator's whole-object copies. A refusal never repeats a value.
pub fn store(vars: &BTreeMap<String, String>, name: &str) -> R<S3> {
    let get = |k: &str| vars.get(k).cloned();
    let var = |k: &str| vars.get(k).cloned().unwrap_or_default();
    let s3 = if name == URL_ENV {
        match S3::from_vars(get) {
            Some(s) => s?,
            None => return refuse("store-settings", format!("{name} is not set")),
        }
    } else if NAMES.contains(&name) {
        let Some(url) = vars.get(name).filter(|u| !u.trim().is_empty()) else {
            return refuse("store-settings", format!("{name} is not set"));
        };
        let url = url.trim();
        if !(url.starts_with("s3:") || url.contains("://")) {
            return refuse(
                "store-settings",
                format!("{name} is a folder, not a bucket"),
            );
        }
        S3::from_url(url, var)?
    } else {
        return refuse("store-settings", format!("{name} names no bucket"));
    };
    Ok(s3.for_operator(OBJECT_LIMIT, CALL_TIMEOUT))
}

/// `f`, tried again while the store is out of reach (`store-unreachable`); any other refusal ends it.
fn tried<T>(what: &str, f: impl Fn() -> R<T>) -> R<T> {
    let mut wait = FIRST_WAIT;
    let mut left = RETRIES;
    loop {
        match f() {
            Err(e) if e.name == "store-unreachable" && left > 0 => {
                eprintln!(
                    "store-copy: {what}: out of reach, trying again in {} s",
                    wait.as_secs()
                );
                std::thread::sleep(wait);
                wait *= 2;
                left -= 1;
            }
            r => return r,
        }
    }
}

/// A world's keys, as `world-aside` names them: its record (one key) and four prefixes.
fn world_places(world: &World) -> (String, [String; 4]) {
    let zone = format!(
        "{}/{}-{}",
        to_hex(&world.lineage),
        to_hex(&world.zone.scope().0),
        world.zone.counter()
    );
    (
        format!("world/{zone}"),
        [
            format!("ckpt/{zone}/"),
            format!("part/{zone}/"),
            format!("stream-recovery/{zone}/"),
            format!("h/{}/", world.name()),
        ],
    )
}

/// Whether `key` is one of `world`'s own objects under a store generation (#4954): `g/<label>/<k>`, `k` a key the world
/// owns ([`World::owns`]). A rebuilt world's objects are all there, under the label its folder names.
fn in_generation(world: &World, key: &str) -> bool {
    key.strip_prefix("g/")
        .and_then(|k| k.split_once('/'))
        .is_some_and(|(label, k)| !label.is_empty() && world.owns(k))
}

/// The keys to copy: every key under the source, or only the worlds' own, under every store generation too.
fn source_keys(from: &dyn Store, worlds: &[World]) -> R<Vec<String>> {
    if worlds.is_empty() {
        return tried("the listing", || from.list(""));
    }
    let generations = tried("the listing", || from.list("g/"))?;
    let mut out = Vec::new();
    for w in worlds {
        out.extend(generations.iter().filter(|k| in_generation(w, k)).cloned());
        let (record, prefixes) = world_places(w);
        out.extend(
            tried("the listing", || from.list(&record))?
                .into_iter()
                .filter(|k| *k == record),
        );
        for p in &prefixes {
            out.extend(tried("the listing", || from.list(p))?);
        }
    }
    Ok(out)
}

/// `keys` without those under any of `skip` (prefixes under the setting's own, e.g. `aside/`): what is copied and
/// counted, and how many were left out.
pub fn without(keys: Vec<String>, skip: &[String]) -> (Vec<String>, u64) {
    let before = keys.len() as u64;
    let kept: Vec<String> = keys
        .into_iter()
        .filter(|k| !skip.iter().any(|p| k.starts_with(p.as_str())))
        .collect();
    let left = before - kept.len() as u64;
    (kept, left)
}

/// What a copy did, and the check after it.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Copied {
    /// The source's keys and their bytes (a key gone from the source meanwhile is not counted).
    pub objects: u64,
    pub bytes: u64,
    pub written: u64,
    pub replaced: u64,
    pub same: u64,
    /// Keys written at the target since this tool last wrote them there (the manifest's): kept as they are.
    pub kept: u64,
    /// The target's count and bytes of the same keys, after.
    pub held: u64,
    pub held_bytes: u64,
}

fn same_bytes(from: &dyn Store, to: &dyn Store, key: &str) -> R<bool> {
    let a = tried(key, || from.get(key))?;
    let b = tried(key, || to.get(key))?;
    Ok(matches!((a, b), (Some(a), Some(b)) if sha256(&a.bytes) == sha256(&b.bytes)))
}

/// The manifest's lines: each key's target ETag as last written or matched (a later line wins).
pub fn manifest(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|l| l.split_once(' '))
        .map(|(e, k)| (k.to_owned(), e.to_owned()))
        .collect()
}

/// Copies `keys` from `from` to `to` (see the module's text); with `dry`, only compares by length and ETag. `seen` is
/// the manifest read so far; `note` is given each key's target ETag as written or matched.
pub fn copy(
    from: &dyn Store,
    to: &dyn Store,
    keys: &[String],
    dry: bool,
    seen: &BTreeMap<String, String>,
    note: &mut dyn FnMut(&str, &str),
) -> R<Copied> {
    let mut c = Copied::default();
    let mut lengths = BTreeMap::new();
    for key in keys {
        let Some(src) = tried(key, || from.head(key))? else {
            continue;
        };
        let there = tried(key, || to.head(key))?;
        // Written at the target since this tool last left it: the target's own newer write, never replaced.
        if let (Some(t), Some(e)) = (&there, seen.get(key))
            && *e != t.1
        {
            c.kept += 1;
            continue;
        }
        c.objects += 1;
        c.bytes += src.0;
        lengths.insert(key.clone(), src.0);
        let matches = match &there {
            Some(t) if t.0 == src.0 && !src.1.is_empty() && t.1 == src.1 => true,
            Some(t) if t.0 == src.0 && !dry => same_bytes(from, to, key)?,
            _ => false,
        };
        if matches {
            c.same += 1;
            if let Some(t) = &there {
                note(key, &t.1);
            }
            continue;
        }
        if dry {
            match there {
                Some(_) => c.replaced += 1,
                None => c.written += 1,
            }
            continue;
        }
        let Some(o) = tried(key, || from.get(key))? else {
            continue;
        };
        let etag = match &there {
            None => {
                c.written += 1;
                tried(key, || to.put(key, &o.bytes, When::Absent))?
            }
            Some(t) => {
                c.replaced += 1;
                tried(key, || to.put(key, &o.bytes, When::Is(&t.1)))?
            }
        };
        note(key, &etag);
        // The object as written: its length (a record replaced again since is copied by the next run).
        lengths.insert(key.clone(), o.bytes.len() as u64);
        if (c.written + c.replaced) % 100 == 0 {
            eprintln!(
                "store-copy: {} of {} keys done",
                c.same + c.written + c.replaced,
                keys.len()
            );
        }
    }
    if dry {
        return Ok(c);
    }
    // The check: the target holds every key, at the length written.
    for (key, len) in &lengths {
        if let Some(t) = tried(key, || to.head(key))?
            && t.0 == *len
        {
            c.held += 1;
            c.held_bytes += t.0;
        }
    }
    Ok(c)
}

/// Writes one object under a fresh probe prefix, reads it back, deletes it and lists the prefix empty.
pub fn probe(store: &dyn Store, prefix: &str) -> R<()> {
    let key = format!("{prefix}check");
    let bytes = format!("store-switch probe {prefix}").into_bytes();
    store.put(&key, &bytes, When::Absent)?;
    let back = store.get(&key)?;
    if back.map(|o| o.bytes) != Some(bytes) {
        return refuse("probe-read", "the object read back is not the one written");
    }
    store.delete(&key)?;
    if !store.list(prefix)?.is_empty() {
        return refuse(
            "probe-left",
            "the probe prefix is not empty after the delete",
        );
    }
    Ok(())
}

fn read_settings(path: &str) -> BTreeMap<String, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => settings(&t),
        Err(e) => {
            eprintln!("store-copy: a settings file cannot be read: {}", e.kind());
            std::process::exit(2)
        }
    }
}

fn open(vars: &BTreeMap<String, String>, name: &str) -> S3 {
    store(vars, name).unwrap_or_else(|e| {
        eprintln!("store-copy: {}: {}", e.name, e.detail);
        std::process::exit(2)
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |k: &str| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let Some(name) = get("--setting") else {
        usage()
    };
    match args.first().map(String::as_str) {
        Some("copy") => {
            let (Some(from), Some(to)) = (get("--from"), get("--to")) else {
                usage()
            };
            let mut worlds = Vec::new();
            for (i, a) in args.iter().enumerate() {
                if a == "--world" {
                    let w = args.get(i + 1).and_then(|w| World::parse(w).ok());
                    let Some(w) = w else { usage() };
                    worlds.push(w);
                }
            }
            let mut skip = Vec::new();
            for (i, a) in args.iter().enumerate() {
                if a == "--skip" {
                    let Some(p) = args
                        .get(i + 1)
                        .filter(|p| !p.is_empty() && !p.starts_with("--"))
                    else {
                        usage()
                    };
                    skip.push(p.clone());
                }
            }
            let dry = args.iter().any(|a| a == "--dry-run");
            let (src, dst) = (
                open(&read_settings(&from), &name),
                open(&read_settings(&to), &name),
            );
            let path = get("--manifest");
            let seen = path
                .as_deref()
                .map(|p| manifest(&std::fs::read_to_string(p).unwrap_or_default()))
                .unwrap_or_default();
            let mut out = match (&path, dry) {
                (Some(p), false) => Some(
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(p)
                        .unwrap_or_else(|e| {
                            eprintln!("store-copy: the manifest cannot be opened: {}", e.kind());
                            std::process::exit(2)
                        }),
                ),
                _ => None,
            };
            let mut note = |k: &str, e: &str| {
                if let Some(f) = out.as_mut() {
                    use std::io::Write as _;
                    let _ = writeln!(f, "{e} {k}");
                }
            };
            let mut left = 0;
            let run = source_keys(&src, &worlds).and_then(|all| {
                let (keys, n) = without(all, &skip);
                left = n;
                copy(&src, &dst, &keys, dry, &seen, &mut note)
            });
            let c = run.unwrap_or_else(|e| {
                println!("store-copy: {name}: refused: {}: {}", e.name, e.detail);
                std::process::exit(1)
            });
            let what = if worlds.is_empty() {
                "every key".to_owned()
            } else {
                format!("{} world(s)' keys", worlds.len())
            };
            let what = if skip.is_empty() {
                what
            } else {
                format!("{what}, {left} skipped under {}", skip.join(" "))
            };
            if dry {
                println!(
                    "store-copy: {name} ({what}): dry run: source {} objects, {} bytes; {} already at the target, {} to write, {} to replace, {} newer there; nothing written",
                    c.objects, c.bytes, c.same, c.written, c.replaced, c.kept
                );
                return;
            }
            let ok = c.held == c.objects && c.held_bytes == c.bytes;
            println!(
                "store-copy: {name} ({what}): source {} objects, {} bytes; target holds {} of them, {} bytes ({} written, {} replaced, {} already there, {} newer there and kept): {}",
                c.objects,
                c.bytes,
                c.held,
                c.held_bytes,
                c.written,
                c.replaced,
                c.same,
                c.kept,
                if ok {
                    "count and size match"
                } else {
                    "MISMATCH"
                }
            );
            if !ok {
                std::process::exit(1)
            }
        }
        Some("probe") => {
            let Some(file) = get("--settings") else {
                usage()
            };
            let s = open(&read_settings(&file), &name);
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis());
            match probe(&s, &format!("probe/store-switch/{t}/")) {
                Ok(()) => println!(
                    "store-copy: {name}: probe write, read back, delete and empty listing: ok"
                ),
                Err(e) => {
                    println!(
                        "store-copy: {name}: probe refused: {}: {}",
                        e.name, e.detail
                    );
                    std::process::exit(1)
                }
            }
        }
        _ => usage(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use directoryd::directory::stand_in::{KEY_ID, StandIn};

    fn vars(url: &str) -> BTreeMap<String, String> {
        settings(&format!(
            "# test\nexport DIRECTORY_STORE_URL=\"{url}\"\nAWS_ACCESS_KEY_ID={KEY_ID}\nAWS_SECRET_ACCESS_KEY='s=e'\n"
        ))
    }

    /// soul.game's move (25 Nov 2026): `--skip aside/ --skip stream-recovery/` copies the rest and leaves those
    /// out of the copy and of its count, so the check compares only what was copied.
    #[test]
    fn skipped_prefixes_are_neither_copied_nor_counted() {
        let (a, b) = (StandIn::start(2).unwrap(), StandIn::start(2).unwrap());
        let src = store(&vars(&format!("{}/dir", a.url("old"))), URL_ENV).unwrap();
        let dst = store(&vars(&format!("{}/dir", b.url("new"))), URL_ENV).unwrap();
        for (k, v) in [
            ("world/x", "r1"),
            ("h/w/0", "aaaa"),
            ("aside/reseed-1/h/w/0", "old"),
            ("stream-recovery/x/head", "hd"),
            ("stream-recovery/x/objects/00", "obj"),
            ("aside-not/x", "kept: not under aside/"),
        ] {
            src.put(k, v.as_bytes(), When::Absent).unwrap();
        }
        let skip = ["aside/".to_owned(), "stream-recovery/".to_owned()];
        let (keys, left) = without(source_keys(&src, &[]).unwrap(), &skip);
        assert_eq!(left, 3);
        assert_eq!(keys.len(), 3, "{keys:?}");
        let none = BTreeMap::new();
        let c = copy(&src, &dst, &keys, false, &none, &mut |_, _| {}).unwrap();
        assert_eq!((c.objects, c.written, c.held), (3, 3, 3));
        let mut there = dst.list("").unwrap();
        there.sort();
        assert_eq!(there, ["aside-not/x", "h/w/0", "world/x"]);
        assert_eq!(
            without(vec!["a/1".into()], &[]),
            (vec!["a/1".to_owned()], 0)
        );
    }

    #[test]
    fn copies_resumes_replaces_and_checks() {
        let (a, b) = (StandIn::start(2).unwrap(), StandIn::start(2).unwrap());
        let src = store(&vars(&format!("{}/dir", a.url("old"))), URL_ENV).unwrap();
        let dst = store(&vars(&format!("{}/dir", b.url("new"))), URL_ENV).unwrap();
        for (k, v) in [("world/x", "r1"), ("h/w/0", "aaaa"), ("ckpt/x/1", "bbbbbb")] {
            src.put(k, v.as_bytes(), When::Absent).unwrap();
        }
        let keys = source_keys(&src, &[]).unwrap();
        assert_eq!(keys.len(), 3);
        let lines = std::cell::RefCell::new(String::new());
        let mut note = |k: &str, e: &str| lines.borrow_mut().push_str(&format!("{e} {k}\n"));
        let none = BTreeMap::new();
        let dry = copy(&src, &dst, &keys, true, &none, &mut |_, _| {}).unwrap();
        assert_eq!(
            (dry.written, b.paths().len()),
            (3, 0),
            "a dry run writes nothing"
        );
        let c = copy(&src, &dst, &keys, false, &none, &mut note).unwrap();
        assert_eq!(
            (c.objects, c.bytes, c.written, c.held, c.held_bytes),
            (3, 12, 3, 3, 12)
        );
        // Resumed: nothing written again. A record written again at the source is replaced at the target.
        let r = src.get("world/x").unwrap().unwrap();
        src.put("world/x", b"r2", When::Is(&r.etag)).unwrap();
        let seen = manifest(&lines.borrow());
        let c = copy(&src, &dst, &keys, false, &seen, &mut note).unwrap();
        assert_eq!((c.same, c.replaced, c.written), (2, 1, 0));
        assert_eq!(dst.get("world/x").unwrap().unwrap().bytes, b"r2");
        // A key written at the target since (a moved world's own newer record) is kept, not replaced by the source's.
        let t = dst.get("h/w/0").unwrap().unwrap();
        dst.put("h/w/0", b"newer-at-target", When::Is(&t.etag))
            .unwrap();
        let seen = manifest(&lines.borrow());
        let c = copy(&src, &dst, &keys, false, &seen, &mut note).unwrap();
        assert_eq!((c.kept, c.objects, c.held), (1, 2, 2));
        assert_eq!(dst.get("h/w/0").unwrap().unwrap().bytes, b"newer-at-target");
        assert!(
            b.paths().iter().all(|p| p.starts_with("new/dir/")),
            "{:?}",
            b.paths()
        );
        probe(&dst, "probe/store-switch/1/").unwrap();
        assert_eq!(b.paths().len(), 3, "the probe leaves nothing");
    }

    /// #4954: a rebuilt world's own objects are under its store generation, `g/<label>/`. A move's per-world catch-up
    /// (`--world`) copies them with the keys as they are (the old world's, which an undo serves again), and none of
    /// another world's or the directory's.
    #[test]
    fn a_worlds_store_generation_is_copied_with_it() {
        let (a, b) = (StandIn::start(2).unwrap(), StandIn::start(2).unwrap());
        let src = store(&vars(&format!("{}/dir", a.url("old"))), URL_ENV).unwrap();
        let dst = store(&vars(&format!("{}/dir", b.url("new"))), URL_ENV).unwrap();
        let (l, s) = ("ab".repeat(16), "01".repeat(16));
        let w = World::parse(&format!("{l}-{s}-7")).unwrap();
        let other = World::parse(&format!("{l}-{s}-8")).unwrap();
        let (z, name) = (format!("{l}/{s}-7"), w.name());
        let ours = [
            format!("world/{z}"),
            format!("part/{z}/0/t/1"),
            format!("g/20261126T120000Z/world/{z}"),
            format!("g/20261126T120000Z/ckpt/{z}/5"),
            format!("g/20261126T120000Z/part/{z}/0/t/1"),
            format!("g/20261126T120000Z/stream-recovery/{z}/head"),
            format!("g/20261126T120000Z/h/{name}/{l}/archive/head"),
        ];
        let theirs = [
            format!("g/20261126T120000Z/world/{l}/{s}-8"),
            format!("g/20261126T120000Z/part/{l}/{s}-70/x"),
            format!("g/20261126T120000Z/h/{}/x", other.name()),
            "g/20261126T120000Z/world-name/eden".to_owned(),
            format!("g//world/{z}"),
            "world-name/eden".to_owned(),
        ];
        for k in ours.iter().chain(&theirs) {
            src.put(k, k.as_bytes(), When::Absent).unwrap();
        }
        let mut keys = source_keys(&src, &[w]).unwrap();
        keys.sort();
        let mut want = ours.to_vec();
        want.sort();
        assert_eq!(keys, want);
        let none = BTreeMap::new();
        let c = copy(&src, &dst, &keys, false, &none, &mut |_, _| {}).unwrap();
        assert_eq!((c.objects, c.written, c.held), (7, 7, 7));
        let mut there = dst.list("").unwrap();
        there.sort();
        assert_eq!(there, want);
        assert_eq!(
            dst.get(&ours[4]).unwrap().map(|o| o.bytes),
            Some(ours[4].as_bytes().to_vec())
        );
    }

    #[test]
    fn a_folder_or_an_unset_setting_refuses() {
        let v = settings("SOULS_BACKUP_URL=folder:/tmp/x\n");
        assert_eq!(
            store(&v, "SOULS_BACKUP_URL").err().unwrap().name,
            "store-settings"
        );
        assert_eq!(store(&v, URL_ENV).err().unwrap().name, "store-settings");
        assert_eq!(store(&v, "OTHER").err().unwrap().name, "store-settings");
    }
}
