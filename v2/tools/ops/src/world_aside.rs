//! `world-aside`: sets one world's objects in the directory's store aside, and puts them back. An operator's tool (not
//! the engine): a world re-seeded fresh under the same instance (0.132, the 22 Nov store's header no longer read by
//! today's build) cannot start on the store its old log shipped to, since the store's record holds the old log's mark
//! (`restart-gap`). Setting the old world's objects aside lets the fresh world claim from record 0; nothing is deleted
//! that has not first been copied and read back.
//!
//! ```text
//! world-aside <world> [--label <label>] [--dry-run]     each of the world's objects to aside/<label>/<key>
//! world-aside <world> --back <label> [--dry-run]       each object under aside/<label>/ back to its key
//! ```
//!
//! A world's objects (`<L>` its lineage, `<Z>` its zone as `<scope>-<counter>`, `<world>` its instance name): its
//! record `world/<L>/<Z>` (its pin, claims and mark), and every key under `ckpt/<L>/<Z>/`, `part/<L>/<Z>/`,
//! `stream-recovery/<L>/<Z>/` and `h/<world>/`. Its name record, list row and Souls' records are not its objects and
//! are not moved. The label defaults to the time, `YYYYMMDDTHHMMSSZ`.
//!
//! Each object is copied to its new key (create-only), read back and compared by length and SHA-256; only when every
//! copy checks are the originals deleted. A copy already there with the same bytes counts as made (a run stopped
//! halfway is finished by the next); one with other bytes refuses, changing nothing more. `--back` refuses a key the
//! world holds again (set the fresh world's objects aside first). The store is the one `deploy` and `supervisor` read:
//! the `DIRECTORY_STORE_*` variables' bucket, else the folder `$WORLDS_ROOT/directory`. Exits 0 on success, 1 on a
//! refusal, 2 on a usage error.
// Operations, not the engine: the default label is the wall clock.
#![allow(clippy::disallowed_methods)]

use std::path::PathBuf;

use directoryd::directory::s3::S3;
use directoryd::directory::store::{R, Store, When, refuse};
use replica::encode::to_hex;
use replica::ids::sha256;
use supervisor::World;
use supervisor::folder::Folder;

/// The keys that hold a world's objects: its record, then the prefixes under which the rest are.
fn places(world: &World) -> (String, [String; 4]) {
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

/// Every key the store holds for `world`, in order.
pub fn keys(store: &dyn Store, world: &World) -> R<Vec<String>> {
    let (record, prefixes) = places(world);
    let mut out = Vec::new();
    if store.get(&record)?.is_some() {
        out.push(record);
    }
    for p in &prefixes {
        out.extend(store.list(p)?);
    }
    Ok(out)
}

fn belongs(world: &World, key: &str) -> bool {
    let (record, prefixes) = places(world);
    key == record || prefixes.iter().any(|p| key.starts_with(p.as_str()))
}

/// One planned move: from `from` to `to`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Move {
    pub from: String,
    pub to: String,
}

/// The moves that set `world` aside under `label`.
pub fn plan_aside(store: &dyn Store, world: &World, label: &str) -> R<Vec<Move>> {
    Ok(keys(store, world)?
        .into_iter()
        .map(|k| Move {
            to: format!("aside/{label}/{k}"),
            from: k,
        })
        .collect())
}

/// The moves that put `world`'s objects under `aside/<label>/` back. A key there that is not the world's refuses.
pub fn plan_back(store: &dyn Store, world: &World, label: &str) -> R<Vec<Move>> {
    let prefix = format!("aside/{label}/");
    let mut out = Vec::new();
    for k in store.list(&prefix)? {
        let key = k[prefix.len()..].to_owned();
        if !belongs(world, &key) {
            return refuse(
                "aside-foreign-key",
                format!("{k} is not {}'s", world.name()),
            );
        }
        out.push(Move { from: k, to: key });
    }
    Ok(out)
}

/// What a run moved: objects and bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Moved {
    pub objects: usize,
    pub bytes: u64,
}

/// Copies every move's object to its new key and reads each copy back; then, only if every copy checks, deletes the
/// originals.
pub fn run(store: &dyn Store, moves: &[Move]) -> R<Moved> {
    // First, before anything is written: a new key that holds other bytes refuses the whole run.
    for m in moves {
        if let Some(there) = store.get(&m.to)? {
            let src = store.get(&m.from)?;
            if src.is_none_or(|s| sha256(&s.bytes) != sha256(&there.bytes)) {
                return refuse(
                    "aside-copy-differs",
                    format!(
                        "{} holds other bytes than {}; nothing was written or deleted",
                        m.to, m.from
                    ),
                );
            }
        }
    }
    let mut done = Moved::default();
    for m in moves {
        let Some(src) = store.get(&m.from)? else {
            return refuse("aside-source-gone", m.from.clone());
        };
        match store.put(&m.to, &src.bytes, When::Absent) {
            Ok(_) => {}
            // A copy left by a run stopped halfway: kept only if it is the same bytes (checked below).
            Err(e) if e.name == "precondition-failed" => {}
            Err(e) => return Err(e),
        }
        let copy = store.get(&m.to)?;
        let same = copy.as_ref().is_some_and(|c| {
            c.bytes.len() == src.bytes.len() && sha256(&c.bytes) == sha256(&src.bytes)
        });
        if !same {
            return refuse(
                "aside-copy-differs",
                format!("{} is not a copy of {}; nothing was deleted", m.to, m.from),
            );
        }
        done.objects += 1;
        done.bytes += src.bytes.len() as u64;
    }
    for m in moves {
        store.delete(&m.from)?;
    }
    Ok(done)
}

/// Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm), for the default label.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn label_now() -> String {
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let (y, m, d) = civil(s.div_euclid(86_400));
    let t = s.rem_euclid(86_400);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        t / 3600,
        t / 60 % 60,
        t % 60
    )
}

fn usage() -> ! {
    eprintln!(
        "usage: world-aside <world> [--label <label>] [--dry-run] | world-aside <world> --back <label> [--dry-run]"
    );
    std::process::exit(2)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let get = |n: &str| a.iter().position(|x| x == n).and_then(|k| a.get(k + 1));
    let world = World::parse(a.get(1).unwrap_or_else(|| usage())).unwrap_or_else(|e| {
        eprintln!("world-aside: {e}");
        std::process::exit(2)
    });
    let dry = a.iter().any(|x| x == "--dry-run");
    let back = get("--back").cloned();
    let label = back
        .clone()
        .or_else(|| get("--label").cloned())
        .unwrap_or_else(label_now);
    if label.is_empty()
        || !label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        eprintln!("world-aside: a label is letters, digits, - and _");
        std::process::exit(2)
    }
    let root = std::env::var_os("WORLDS_ROOT")
        .map_or_else(|| PathBuf::from("/var/lib/souls/worlds"), PathBuf::from);
    let s3;
    let folder;
    let store: &dyn Store = match S3::from_env() {
        Some(Ok(s)) => {
            s3 = s;
            &s3
        }
        Some(Err(e)) => {
            eprintln!("world-aside: {}: {}", e.name, e.detail);
            std::process::exit(2)
        }
        None => {
            folder = Folder::new(root.join("directory"));
            &folder
        }
    };
    let planned = match &back {
        Some(l) => plan_back(store, &world, l),
        None => plan_aside(store, &world, &label),
    };
    let moves = planned.unwrap_or_else(|e| {
        println!("refused: {}: {}", e.name, e.detail);
        std::process::exit(1)
    });
    let what = if back.is_some() {
        format!("back from aside/{label}/")
    } else {
        format!("aside to aside/{label}/")
    };
    if dry {
        for m in &moves {
            println!("would move {} -> {}", m.from, m.to);
        }
        println!(
            "dry run: {} objects of {} would move {what}; nothing changed",
            moves.len(),
            world.name()
        );
        return;
    }
    match run(store, &moves) {
        Ok(d) => println!(
            "moved {} objects ({} bytes) of {} {what}: each copied, read back and compared, then the original deleted",
            d.objects,
            d.bytes,
            world.name()
        ),
        Err(e) => {
            println!("refused: {}: {}", e.name, e.detail);
            std::process::exit(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORLD: &str = "cd5ce79e0e0cf90b312c5ba60b941f58-cd5ce79e0e0cf90b312c5ba60b941f58-0";
    const OTHER: &str = "aa5ce79e0e0cf90b312c5ba60b941f58-aa5ce79e0e0cf90b312c5ba60b941f58-0";

    fn folder(name: &str) -> (PathBuf, Folder) {
        let d = std::env::temp_dir().join(format!("world-aside-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        (d.clone(), Folder::new(d))
    }

    /// A world's objects as a folder store holds them after it shipped, and another world's beside them.
    fn shipped(s: &Folder) -> Vec<(String, Vec<u8>)> {
        let l = &WORLD[..32];
        let z = format!("{l}/{l}-0");
        let mine = vec![
            (format!("world/{z}"), b"record".to_vec()),
            (format!("ckpt/{z}/newest"), b"ckpt".to_vec()),
            (
                format!("part/{z}/00000000000000000001/x/00000000000000000000"),
                vec![7u8; 5000],
            ),
            (format!("stream-recovery/{z}/0/head"), b"head".to_vec()),
            (format!("h/{WORLD}/{l}/header"), b"header".to_vec()),
        ];
        for (k, v) in &mine {
            s.put(k, v, When::Absent).unwrap();
        }
        // Another world's record, and a key with this world's lineage at another counter: neither is this world's.
        let o = &OTHER[..32];
        let _ = s.put(&format!("world/{o}/{o}-0"), b"theirs", When::Absent);
        let _ = s.put(&format!("part/{l}/{l}-01/x"), b"x", When::Absent);
        mine
    }

    #[test]
    fn a_world_goes_aside_and_back_with_every_byte() {
        let (d, s) = folder("move");
        let w = World::parse(WORLD).unwrap();
        let mine = shipped(&s);
        let plan = plan_aside(&s, &w, "t1").unwrap();
        let mut from: Vec<_> = plan.iter().map(|m| m.from.clone()).collect();
        from.sort();
        let mut want: Vec<_> = mine.iter().map(|(k, _)| k.clone()).collect();
        want.sort();
        assert_eq!(from, want, "exactly the world's objects, no other world's");
        let moved = run(&s, &plan).unwrap();
        assert_eq!(moved.objects, 5);
        assert_eq!(moved.bytes, 6 + 4 + 5000 + 4 + 6);
        assert!(
            keys(&s, &w).unwrap().is_empty(),
            "the world holds nothing in the store"
        );
        for (k, v) in &mine {
            assert_eq!(s.get(&format!("aside/t1/{k}")).unwrap().unwrap().bytes, *v);
        }
        let o = &OTHER[..32];
        assert!(
            s.get(&format!("world/{o}/{o}-0")).unwrap().is_some(),
            "another world is untouched"
        );
        // Back: refused while the world holds a key again, then whole once it does not.
        s.put(&mine[0].0, b"fresh", When::Absent).unwrap();
        let back = plan_back(&s, &w, "t1").unwrap();
        assert_eq!(run(&s, &back).unwrap_err().name, "aside-copy-differs");
        assert_eq!(
            s.get(&mine[1].0).unwrap(),
            None,
            "a refused run deletes nothing"
        );
        s.delete(&mine[0].0).unwrap();
        assert_eq!(
            run(&s, &plan_back(&s, &w, "t1").unwrap()).unwrap().objects,
            5
        );
        for (k, v) in &mine {
            assert_eq!(s.get(k).unwrap().unwrap().bytes, *v);
        }
        assert!(s.list("aside/").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_dry_run_only_lists_and_a_stopped_run_is_finished() {
        let (d, s) = folder("dry");
        let w = World::parse(WORLD).unwrap();
        let mine = shipped(&s);
        let before = s.list("").unwrap();
        let plan = plan_aside(&s, &w, "t2").unwrap();
        assert_eq!(plan.len(), 5);
        assert_eq!(s.list("").unwrap(), before, "planning changes nothing");
        // A run stopped after one copy: the next finishes it, the copy counted as made.
        s.put(
            &plan[0].to,
            &mine.iter().find(|(k, _)| *k == plan[0].from).unwrap().1,
            When::Absent,
        )
        .unwrap();
        assert_eq!(run(&s, &plan).unwrap().objects, 5);
        // A copy with other bytes refuses and deletes nothing.
        let mine = shipped(&s);
        let plan = plan_aside(&s, &w, "t3").unwrap();
        s.put(&plan[2].to, b"other", When::Absent).unwrap();
        assert_eq!(run(&s, &plan).unwrap_err().name, "aside-copy-differs");
        for (k, _) in &mine {
            assert!(s.get(k).unwrap().is_some());
        }
        // A foreign key under the label refuses the way back.
        s.put("aside/t4/world/zz", b"z", When::Absent).unwrap();
        assert_eq!(
            plan_back(&s, &w, "t4").unwrap_err().name,
            "aside-foreign-key"
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn the_default_label_is_the_utc_time() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(20_415), (2025, 11, 23));
        let l = label_now();
        assert_eq!(l.len(), 16);
        assert!(l.ends_with('Z'));
    }
}
