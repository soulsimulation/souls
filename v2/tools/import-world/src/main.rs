//! `import-world <facts.json>… [--json] [--arrival <x m>,<z m>] [--entries <dir>] [--no-ways]`: one row per world,
//! then each world's differences, things with no Soul Actions entry and one-way floors and seats (W9, #4085: walked
//! from the arrival point, default 0,0; seats' stand points from the entries, default the repository's
//! `content/kinds`). The one command that exports a backup and calls this is `node v2/tools/import-world/import-world.ts`.

use import_world::ways::{self, Opts};
use import_world::{World, row_with};

fn esc(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => vec!['\\', '"'],
            '\\' => vec!['\\', '\\'],
            c if (c as u32) < 0x20 => format!("\\u{:04x}", c as u32).chars().collect(),
            c => vec![c],
        })
        .collect()
}

fn json(w: &World) -> String {
    let counts: Vec<String> = w
        .counts
        .iter()
        .map(|(k, v)| format!("\"{}\": {v}", esc(k)))
        .collect();
    let diffs: Vec<String> = w
        .differences
        .iter()
        .map(|d| {
            let ids: Vec<String> = d.ids.iter().map(|i| format!("\"{}\"", esc(i))).collect();
            format!(
                "{{\"what\": \"{}\", \"ids\": [{}], \"reason\": \"{}\", \"explained\": {}}}",
                esc(&d.what),
                ids.join(", "),
                esc(&d.reason),
                d.explained
            )
        })
        .collect();
    let none: Vec<String> = w
        .no_entry
        .iter()
        .map(|(k, (why, ids))| {
            let ids: Vec<String> = ids.iter().map(|i| format!("\"{}\"", esc(i))).collect();
            format!(
                "{{\"def\": \"{}\", \"why\": \"{}\", \"ids\": [{}]}}",
                esc(k),
                esc(why),
                ids.join(", ")
            )
        })
        .collect();
    let ups: Vec<String> = w.uploads.iter().map(|u| format!("\"{u}\"")).collect();
    let ways = match &w.ways {
        None => "null".to_owned(),
        Some(Err(e)) => format!("{{\"error\": \"{}\"}}", esc(e)),
        Some(Ok(o)) => {
            let ones: Vec<String> = o
                .one_way
                .iter()
                .map(|t| format!("{{\"name\": \"{}\", \"why\": \"{}\"}}", esc(&t.name), esc(&t.why)))
                .collect();
            format!(
                "{{\"targets\": {}, \"unreached\": {}, \"oneWay\": [{}]}}",
                o.targets,
                o.unreached.len(),
                ones.join(", ")
            )
        }
    };
    format!(
        "{{\"world\": \"{}\", \"backup\": \"{}\", \"clean\": {}, \"loaded\": {}, \"hash\": \"{}\", \"nodes\": {}, \"links\": {}, \"rows\": {}, \"counts\": {{{}}}, \"uploads\": [{}], \"uploadsNamed\": {}, \"withEntry\": {}, \"noEntry\": [{}], \"differences\": [{}], \"history\": {}, \"ways\": {}}}",
        esc(&w.world),
        w.backup_sha256,
        w.clean(),
        w.loaded,
        w.hash,
        w.nodes,
        w.links,
        w.rows,
        counts.join(", "),
        ups.join(", "),
        w.uploads_named,
        w.with_entry,
        none.join(", "),
        diffs.join(", "),
        w.history,
        ways
    )
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let as_json = args.iter().any(|a| a == "--json");
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
    };
    let valued = ["--arrival", "--entries"];
    let files: Vec<&String> = args
        .iter()
        .enumerate()
        .filter(|(i, a)| !a.starts_with("--") && (*i == 0 || !valued.contains(&args[i - 1].as_str())))
        .map(|(_, a)| a)
        .collect();
    if files.is_empty() {
        eprintln!(
            "usage: import-world <facts.json>… [--json] [--arrival <x m>,<z m>] [--entries <dir>] [--no-ways]"
        );
        std::process::exit(2);
    }
    let arrival = value("--arrival").map_or([0, 0], |a| {
        let m = |v: &str| {
            (v.trim().parse::<f64>().expect("--arrival <x m>,<z m>") * 1000.0).round() as i64
        };
        let (x, z) = a.split_once(',').expect("--arrival <x m>,<z m>");
        [m(x), m(z)]
    });
    let opts = (!args.iter().any(|a| a == "--no-ways")).then(|| {
        let dir = value("--entries").cloned().unwrap_or_else(|| {
            format!("{}/../../../content/kinds", env!("CARGO_MANIFEST_DIR"))
        });
        let mut entries = Vec::new();
        ways::entries(std::path::Path::new(&dir), &mut entries)
            .unwrap_or_else(|e| panic!("--entries {dir}: {e}"));
        Opts { arrival, entries }
    });
    let worlds: Vec<World> = files
        .iter()
        .map(|p| {
            row_with(
                &std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{p}: {e}")),
                opts.as_ref(),
            )
        })
        .collect();
    if as_json {
        for w in &worlds {
            println!("{}", json(w));
        }
        return;
    }
    let c = |w: &World, k: &str| w.counts.get(k).copied().unwrap_or(0);
    println!(
        "| world | clean | things (rows) | rooms | floors | doors | doorways | stairs | windows | places | uploads (named) | differences (unexplained) | no entry: things (kinds) | named entry | one-way (walked) | hash |"
    );
    println!("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
    for w in &worlds {
        println!(
            "| {} | {} | {} ({}) | {} | {} | {} | {} | {} | {} | {} | {} ({}) | {} ({}) | {} ({}) | {} | {} | `{}` |",
            w.world,
            if w.clean() { "yes" } else { "**no**" },
            c(w, "things"),
            w.rows,
            c(w, "rooms"),
            c(w, "floors"),
            c(w, "doors"),
            c(w, "doorways"),
            c(w, "stairs"),
            c(w, "windows"),
            c(w, "places"),
            w.uploads.len(),
            w.uploads_named,
            w.differences.len(),
            w.differences.iter().filter(|d| !d.explained).count(),
            w.no_entry_things(),
            w.no_entry.len(),
            w.with_entry,
            match &w.ways {
                None => "not walked".to_owned(),
                Some(Err(_)) => "**not walked**".to_owned(),
                Some(Ok(o)) => format!("{} ({})", o.one_way.len(), o.targets),
            },
            &w.hash.get(..16).unwrap_or(&w.hash),
        );
    }
    for w in &worlds {
        println!("\n## {}\n\nhash {}\n", w.world, w.hash);
        println!("differences ({}):\n", w.differences.len());
        for d in &w.differences {
            println!(
                "- {}{}: {} [{}]",
                if d.explained { "" } else { "**unexplained** " },
                d.what,
                d.reason,
                d.ids.join(" ")
            );
        }
        println!("\nthings with no entry ({}):\n", w.no_entry_things());
        println!("| kind | n | why | ids |\n|---|---:|---|---|");
        for (k, (why, ids)) in &w.no_entry {
            println!("| {k} | {} | {why} | {} |", ids.len(), ids.join(" "));
        }
        match &w.ways {
            None => {}
            Some(Err(e)) => println!("\none-way floors and seats: not walked: {e}"),
            Some(Ok(o)) => {
                println!(
                    "\none-way floors and seats ({}; {} walked to from the arrival point [{}, {}] mm, {} not reached):\n",
                    o.one_way.len(),
                    o.targets,
                    o.arrival[0],
                    o.arrival[1],
                    o.unreached.len()
                );
                for t in &o.one_way {
                    println!("- {}: {}", t.name, t.why);
                }
                println!("\nnot reached ({}):\n", o.unreached.len());
                for t in &o.unreached {
                    println!("- {}: {}", t.name, t.why);
                }
            }
        }
    }
}
