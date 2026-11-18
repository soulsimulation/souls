//! The stop table (Engine v2 F3, #2768); see the library. Run from `v2/`: `cargo run -p form-stop` prints the table
//! (log files under `target/tmp/form-stop`). `die <log> <tick>` and `restart <log> <now>` are the two children it
//! runs for the kill rows.

use std::path::{Path, PathBuf};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["die", log, k] => form_stop::run_and_die(Path::new(log), k.parse().expect("a tick")),
        ["restart", log, now] => {
            let s = form_stop::Stage::restart(Path::new(log), now.parse().expect("a time"));
            println!("{}", s.report().cells().join("\t"));
        }
        rest => {
            let dir = rest
                .first()
                .map_or_else(|| PathBuf::from("target/tmp/form-stop"), PathBuf::from);
            let exe = std::env::current_exe().expect("this program");
            let (table, ok) = form_stop::table(&exe, &dir);
            print!("{table}");
            if !ok {
                std::process::exit(1);
            }
        }
    }
}
