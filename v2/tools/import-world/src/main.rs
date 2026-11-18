//! `import-world <facts.json>… [--json]`: one row per world, then each world's differences and things with no Soul
//! Actions entry. The one command that exports a backup and calls this is `node v2/tools/import-world/import-world.ts`.

use import_world::{World, row};

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
    format!(
        "{{\"world\": \"{}\", \"backup\": \"{}\", \"clean\": {}, \"loaded\": {}, \"hash\": \"{}\", \"nodes\": {}, \"links\": {}, \"rows\": {}, \"counts\": {{{}}}, \"uploads\": [{}], \"uploadsNamed\": {}, \"withEntry\": {}, \"noEntry\": [{}], \"differences\": [{}], \"history\": {}}}",
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
        w.history
    )
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let as_json = args.iter().any(|a| a == "--json");
    let files: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if files.is_empty() {
        eprintln!("usage: import-world <facts.json>… [--json]");
        std::process::exit(2);
    }
    let worlds: Vec<World> = files
        .iter()
        .map(|p| row(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{p}: {e}"))))
        .collect();
    if as_json {
        for w in &worlds {
            println!("{}", json(w));
        }
        return;
    }
    let c = |w: &World, k: &str| w.counts.get(k).copied().unwrap_or(0);
    println!(
        "| world | clean | things (rows) | rooms | floors | doors | doorways | stairs | windows | places | uploads (named) | differences (unexplained) | no entry: things (kinds) | named entry | hash |"
    );
    println!("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
    for w in &worlds {
        println!(
            "| {} | {} | {} ({}) | {} | {} | {} | {} | {} | {} | {} | {} ({}) | {} ({}) | {} ({}) | {} | `{}` |",
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
    }
}
