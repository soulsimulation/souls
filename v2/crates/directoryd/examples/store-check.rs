//! `store-check`: tests that an S3-compatible store keeps the directory's two write conditions (`v2/docs/durability.md`,
//! "A store that ignores the conditions"), on one scratch key under `diag/`, which it deletes at the end:
//! create if absent, read, replace with the ETag read, replace with the ETag the write returned, replace with a wrong
//! ETag (must refuse), create if absent again (must refuse), delete. The store is the one the directory picks from
//! its environment (`DIRECTORY_STORE_URL` or the `DIRECTORY_STORE_*` settings) with each `--env-file` read over it.
//! It prints outcomes and refusal names only, never the store's address or keys. Exit 0 when every step went as it
//! must, 1 otherwise.
//!
//! ```text
//! cargo run -p directoryd --example store-check -- [--env-file <file>]...
//! ```

use std::collections::BTreeMap;

use directoryd::directory::s3::S3;
use directoryd::directory::store::{R, Store, When};

fn settings(files: &[String]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for f in files {
        let Ok(text) = std::fs::read_to_string(f) else {
            eprintln!("store-check: cannot read an --env-file");
            std::process::exit(2);
        };
        for line in text.lines() {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line);
            let Some((k, v)) = line.split_once('=') else {
                continue;
            };
            if line.starts_with('#') || k.trim().is_empty() {
                continue;
            }
            let v = v.trim();
            let v = [('"', '"'), ('\'', '\'')]
                .iter()
                .find_map(|(a, b)| v.strip_prefix(*a)?.strip_suffix(*b))
                .unwrap_or(v);
            out.insert(k.trim().to_owned(), v.to_owned());
        }
    }
    out
}

/// An ETag's shape, never its value: its length and whether it carries quotes or a weak mark.
fn shape(e: &str) -> String {
    format!(
        "len {}, quoted {}, weak {}, hex {}",
        e.len(),
        e.contains('"'),
        e.starts_with("W/"),
        e.chars().all(|c| c.is_ascii_hexdigit())
    )
}

/// One step's outcome: `ok` or the refusal's name and the answer's status, never its key.
fn outcome<T>(r: &R<T>) -> String {
    match r {
        Ok(_) => "ok".to_owned(),
        Err(e) => {
            let code = e.detail.rsplit(": ").next().filter(|d| d.starts_with("HTTP"));
            format!("refused {} ({})", e.name, code.unwrap_or("-"))
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut files = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match (a.as_str(), it.clone().next()) {
            ("--env-file", Some(f)) => {
                files.push(f.clone());
                it.next();
            }
            _ => {
                eprintln!("store-check [--env-file <file>]...");
                std::process::exit(2);
            }
        }
    }
    let file = settings(&files);
    let store = match S3::from_vars(|k| file.get(k).cloned().or_else(|| std::env::var(k).ok())) {
        Some(Ok(s)) => s,
        Some(Err(e)) => {
            eprintln!("store-check: {}", e.name);
            std::process::exit(2);
        }
        None => {
            eprintln!("store-check: no bucket in the environment");
            std::process::exit(2);
        }
    };
    let key = format!("diag/store-check-{}", std::process::id());
    let mut good = true;
    let mut step = |name: &str, out: String, want_ok: bool| {
        let ok = out == "ok";
        good &= ok == want_ok;
        println!(
            "{name}: {out}{}",
            if ok == want_ok { "" } else { "  <- not as it must" }
        );
    };

    let created = store.put(&key, b"one", When::Absent);
    step("put if absent", outcome(&created), true);
    let read = store.get(&key);
    step("get", outcome(&read), true);
    let read = read.ok().flatten();
    if let (Ok(c), Some(o)) = (&created, &read) {
        println!(
            "etag from put: {}; from get: {}; same: {}",
            shape(c),
            shape(&o.etag),
            *c == o.etag
        );
    }
    let etag = read.map(|o| o.etag).unwrap_or_default();
    let replaced = store.put(&key, b"two", When::Is(&etag));
    step("put if match (etag from get)", outcome(&replaced), true);
    if let Ok(e) = &replaced {
        let again = store.put(&key, b"three", When::Is(e));
        step("put if match (etag from put)", outcome(&again), true);
    }
    let wrong = store.put(&key, b"four", When::Is("0123456789abcdef0123456789abcdef"));
    step("put if match (wrong etag)", outcome(&wrong), false);
    let twice = store.put(&key, b"five", When::Absent);
    step("put if absent (present)", outcome(&twice), false);
    let gone = store.delete(&key);
    step("delete", outcome(&gone), true);
    let after = store.get(&key).map(|o| o.is_none());
    step(
        "gone after delete",
        match after {
            Ok(true) => "ok".to_owned(),
            Ok(false) => "still there".to_owned(),
            Err(e) => outcome::<()>(&Err(e)),
        },
        true,
    );
    std::process::exit(if good { 0 } else { 1 });
}
