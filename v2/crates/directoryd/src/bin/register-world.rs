//! `register-world`: puts an imported world (Eden, placed by `place-world.sh`) in the directory's list, in the store
//! the directory reads, and in the world-authority map (the 0.131 switch, #1960 B3). The rules:
//! [`directoryd::worlds::list::register`]. Runbook: v2/docs/runbook/install.md, "An imported world in the directory".
//!
//! ```text
//! register-world <name> --instance <placed instance> --creator <principal> [--label <text>] [--alias <name>]...
//!                [--env-file <file>]... [--authority <world-authority map>]
//! ```
//!
//! The store is the one `directoryd` picks from its environment: the bucket `DIRECTORY_STORE_URL` (or the
//! `DIRECTORY_STORE_*` settings) names, else the folder `DIRECTORYD_WORLD_STORE`. Each `--env-file` (`KEY=value`
//! lines, as the unit's `EnvironmentFile=`) is read over this process's environment, so the operator names the unit's
//! files. It prints which kind of store it wrote, never its address. Run as root on a folder store, it hands what it
//! made to the folder's owner, as the directory (user `souls`) must go on writing them. Exit 0 when the world is
//! registered (written or already there), 2 on a refusal, which names why and changes nothing.

use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use directoryd::directory::folder::Folder;
use directoryd::directory::s3::S3;
use directoryd::directory::store::{R, refuse};
use directoryd::worlds::list::register::{Imported, authorize, instance, principal, register};
use directoryd::worlds::list::{WORLD_STORE_DEFAULT, WORLD_STORE_ENV};

const USAGE: &str = "register-world <name> --instance <placed instance> --creator <principal> [--label <text>] \
                     [--alias <name>]... [--env-file <file>]... [--authority <world-authority map>]";

fn settings(files: &[String]) -> R<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for f in files {
        let text =
            std::fs::read_to_string(f).or_else(|e| refuse("env-file", format!("{f}: {e}")))?;
        for line in text.lines() {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line);
            let Some((k, v)) = line.split_once('=') else {
                continue;
            };
            if line.starts_with('#') || k.is_empty() {
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
    Ok(out)
}

/// Hands what a root run made in the folder store to the folder's owner.
fn hand_over(root: &Path, name: &str) -> R<()> {
    let owner = std::fs::metadata(root).or_else(|e| refuse("store-error", e.to_string()))?;
    for p in [
        ".lock",
        "world-name",
        &format!("world-name/{name}"),
        "world-list",
    ] {
        let p = root.join(p);
        let Ok(m) = std::fs::symlink_metadata(&p) else {
            continue;
        };
        if (m.uid(), m.gid()) != (owner.uid(), owner.gid()) {
            std::os::unix::fs::lchown(&p, Some(owner.uid()), Some(owner.gid())).or_else(|e| {
                refuse(
                    "store-owner",
                    format!(
                        "{}: {e}: run it as the store folder's owner or root",
                        p.display()
                    ),
                )
            })?;
        }
    }
    Ok(())
}

fn run(args: &[String]) -> R<String> {
    let mut name = None;
    let (mut inst, mut creator, mut label, mut authority) = (None, None, None, None);
    let (mut aliases, mut files) = (Vec::new(), Vec::new());
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = || it.next().cloned().ok_or(());
        let got = match a.as_str() {
            "--instance" => value().map(|v| inst = Some(v)),
            "--creator" => value().map(|v| creator = Some(v)),
            "--label" => value().map(|v| label = Some(v)),
            "--alias" => value().map(|v| aliases.push(v)),
            "--env-file" => value().map(|v| files.push(v)),
            "--authority" => value().map(|v| authority = Some(PathBuf::from(v))),
            s if !s.starts_with('-') && name.is_none() => {
                name = Some(s.to_owned());
                Ok(())
            }
            _ => Err(()),
        };
        if got.is_err() {
            return refuse("usage", USAGE);
        }
    }
    let (Some(name), Some(inst), Some(creator)) = (name, inst, creator) else {
        return refuse("usage", USAGE);
    };
    if authority.is_none() && !aliases.is_empty() {
        return refuse("usage", "--alias goes with --authority");
    }
    let Some((lineage, zone)) = instance(&inst) else {
        return refuse(
            "instance-not-allowed",
            "<32 hex>-<32 hex>-<n>, as place-world.sh placed it",
        );
    };
    let Some(creator) = principal(&creator) else {
        return refuse("creator-not-allowed", "<32 hex>:<n> or <32 hex>-<n>");
    };
    let label = label.unwrap_or_else(|| {
        let mut c = name.chars();
        c.next()
            .map(|f| f.to_uppercase().chain(c).collect())
            .unwrap_or_default()
    });
    let set = settings(&files)?;
    let var = |k: &str| {
        set.get(k)
            .cloned()
            .or_else(|| std::env::var(k).ok())
            .filter(|v| !v.is_empty())
    };
    let imported = Imported {
        name: &name,
        label: &label,
        lineage,
        zone,
        creator,
        // The row's `made`, the directory's own clock reading (as a create's).
        now: directoryd::accounts::serve::now(),
    };
    let (store, done) = match S3::from_vars(var) {
        Some(bucket) => (
            "the offsite bucket".to_owned(),
            register(&bucket?, &imported)?,
        ),
        None => {
            let root =
                PathBuf::from(var(WORLD_STORE_ENV).unwrap_or_else(|| WORLD_STORE_DEFAULT.into()));
            if !root.is_dir() {
                // Never made here: a folder made by root would shut the directory out of its own store.
                return refuse(
                    "store-missing",
                    format!("{}: no such folder", root.display()),
                );
            }
            let done = register(&Folder::new(root.clone()), &imported);
            hand_over(&root, &name)?;
            (format!("the folder {}", root.display()), done?)
        }
    };
    let mut said = format!(
        "register-world: {name} (instance {}…, creator {}) in {store}: name record {}, list row {}",
        &inst[..12],
        directoryd::accounts::principal_text(creator),
        done.record,
        done.row
    );
    if let Some(path) = authority {
        let changed = authorize(&path, &name, &inst, creator, &aliases)?;
        said.push_str(&format!(
            "; authority map {}{}",
            if changed { "written" } else { "kept" },
            if aliases.is_empty() {
                String::new()
            } else {
                format!(" (aliases {})", aliases.join(", "))
            }
        ));
    }
    Ok(said)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(said) => println!("{said}"),
        Err(e) => {
            eprintln!("register-world: refused: {}: {}", e.name, e.detail);
            std::process::exit(2);
        }
    }
}
