//! `cargo run -p body-script [-- <script>]`: runs a script (default `square.script`) twice through the controller and
//! prints both log hashes, refusals, and the table of log bytes per walking body per second (Engine v2 B1, #2680).

use body_script::{hex, parse, run};

fn main() -> Result<(), String> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/square.script").to_string());
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    let script = parse(&text)?;
    let a = run(&script)?;
    let b = run(&script)?;
    println!("run 1 log sha256 {}", hex(&a.hash));
    println!("run 2 log sha256 {}", hex(&b.hash));
    for r in &a.refused {
        println!("refused {r}");
    }
    println!();
    println!(
        "| body | family | walking s | input records | input B | input B/s | motion samples | samples B | samples B/s | ends at (mm) |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|");
    for r in &a.bodies {
        let s = r.walking as f64 / 1e6;
        println!(
            "| {} | {} | {:.1} | {} | {} | {:.1} | {} | {} | {:.0} | ({}, {}) |",
            r.name,
            r.family,
            s,
            r.records.len(),
            r.record_bytes,
            r.record_bytes as f64 / s,
            r.samples,
            r.sample_bytes,
            r.sample_bytes as f64 / s,
            r.end.x / 1000,
            r.end.z / 1000,
        );
    }
    if a.hash != b.hash {
        return Err("the two runs differ".into());
    }
    Ok(())
}
