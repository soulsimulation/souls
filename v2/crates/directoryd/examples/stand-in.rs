//! The local S3 stand-in ([`directoryd::directory::stand_in`]) as a process, for a script's dry run (0.133 ST2,
//! `v2/tools/ops/tests/store-switch-dry-run.sh`): `cargo run -p directoryd --example stand-in -- <n>` starts `n`
//! stand-ins on loopback, prints one line per stand-in, `stand-in <i> s3:http://127.0.0.1:<port>`, and serves until its
//! standard input closes. Then it prints each one's objects, `<i> <bucket>/<key>`, and exits. Its key id is
//! [`directoryd::directory::stand_in::KEY_ID`]; it holds everything in memory and never stands for a real bucket.

use std::io::{Read, Write};

use directoryd::directory::stand_in::StandIn;

fn main() -> std::io::Result<()> {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|n| n.parse().ok())
        .unwrap_or(1);
    let all: Vec<StandIn> = (0..n)
        .map(|_| StandIn::start(100))
        .collect::<Result<_, _>>()?;
    let mut out = std::io::stdout();
    for (i, s) in all.iter().enumerate() {
        let url = s.url("x");
        writeln!(out, "stand-in {i} {}", url.trim_end_matches("/x"))?;
    }
    out.flush()?;
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    for (i, s) in all.iter().enumerate() {
        for p in s.paths() {
            writeln!(out, "{i} {p}")?;
        }
    }
    Ok(())
}
