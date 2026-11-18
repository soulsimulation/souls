//! `scan-ids --ids <file> <path>...`: scans every file under the paths for the identities in `<file>`, one a line
//! (account ids, provider subjects, emails), and exits 1 on any hit. See README.md.

use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: scan-ids --ids <file, one identity a line> <path>...";
    let (Some(flag), Some(file)) = (args.first(), args.get(1)) else {
        eprintln!("{usage}");
        std::process::exit(2);
    };
    if flag != "--ids" || args.len() < 3 {
        eprintln!("{usage}");
        std::process::exit(2);
    }
    let ids: Vec<Vec<u8>> = match std::fs::read_to_string(file) {
        Ok(t) => t
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| l.as_bytes().to_vec())
            .collect(),
        Err(e) => {
            eprintln!("scan-ids: the identities: {e}");
            std::process::exit(2);
        }
    };
    let paths: Vec<PathBuf> = args[2..].iter().map(PathBuf::from).collect();
    match scan_ids::scan(&paths, &ids) {
        Ok(r) => {
            for h in &r.hits {
                println!(
                    "hit: {} +{}: identity {} as {}",
                    h.path.display(),
                    h.offset,
                    h.needle + 1,
                    h.form
                );
            }
            println!(
                "scan-ids: {} identities in {} forms, {} files, {} bytes: {} hits",
                ids.len(),
                r.forms,
                r.files,
                r.bytes,
                r.hits.len()
            );
            std::process::exit(i32::from(!r.hits.is_empty()));
        }
        Err(e) => {
            eprintln!("scan-ids: {e}");
            std::process::exit(2);
        }
    }
}
