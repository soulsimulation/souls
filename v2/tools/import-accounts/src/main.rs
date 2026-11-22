//! `import-accounts <backup set> [--world <file.db>]… --out <dir> [--bodies <catalogue>] [--json]`: brings a stage's accounts, Souls and
//! creators into `<dir>`, and prints the release owner's rows (counts only). Exits 1 when the import is not clean.
//! See README.md.

use std::path::PathBuf;

fn main() {
    let usage = "usage: import-accounts <backup set> [--world <file.db>]... --out <dir> [--bodies <catalogue>] [--json]";
    let mut args = std::env::args().skip(1);
    let (mut set, mut extra, mut out, mut bodies, mut json) = (None, Vec::new(), None, None, false);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--world" => extra.extend(args.next().map(PathBuf::from)),
            "--out" => out = args.next().map(PathBuf::from),
            "--bodies" => {
                let Some(path) = args.next() else {
                    eprintln!("{usage}");
                    std::process::exit(2)
                };
                if path.starts_with('-') {
                    eprintln!("{usage}");
                    std::process::exit(2)
                }
                bodies = Some(PathBuf::from(path));
            }
            "--json" => json = true,
            _ if set.is_none() && !a.starts_with("--") => set = Some(PathBuf::from(a)),
            _ => {
                eprintln!("{usage}");
                std::process::exit(2);
            }
        }
    }
    let (Some(set), Some(out)) = (set, out) else {
        eprintln!("{usage}");
        std::process::exit(2);
    };
    let r = match import_accounts::import_with_bodies(&set, &extra, &out, bodies.as_deref()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("import-accounts: {e}");
            std::process::exit(1);
        }
    };
    if json {
        let worlds: Vec<_> = r
            .worlds
            .iter()
            .map(|w| {
                serde_json::json!({
                    "world": w.world, "live": w.live, "retired": w.retired, "brought": w.brought,
                    "unowned": w.unowned, "operatorTest": w.operator, "noKind": w.no_kind,
                    "defaulted": w.defaulted, "creator": w.creator, "equal": w.equal,
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::json!({
                "stage": r.stage, "forks": r.forks, "aliases": r.aliases, "conflicts": r.conflicts,
                "accountsEqual": r.accounts_equal, "worlds": worlds, "hash": r.hash, "clean": r.clean(),
            })
        );
    } else {
        println!(
            "accounts: {} stage, {} old worlds', {} aliases, {} conflicts, equal {}",
            r.stage, r.forks, r.aliases, r.conflicts, r.accounts_equal
        );
        println!(
            "| world | live | retired | brought | unowned | operator test | no kind (by preset) | default body (by reason) | creator | equal |"
        );
        println!("|---|---|---|---|---|---|---|---|---|---|");
        let counts = |m: &std::collections::BTreeMap<String, usize>| {
            let v: Vec<String> = m.iter().map(|(p, n)| format!("{p} {n}")).collect();
            if v.is_empty() {
                "0".to_owned()
            } else {
                v.join(", ")
            }
        };
        for w in &r.worlds {
            println!(
                "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
                w.world,
                w.live,
                w.retired,
                w.brought,
                w.unowned,
                w.operator,
                counts(&w.no_kind),
                counts(&w.defaulted),
                w.creator,
                w.equal
            );
        }
        println!("hash {}  clean {}", r.hash, r.clean());
    }
    if !r.clean() {
        std::process::exit(1);
    }
}
