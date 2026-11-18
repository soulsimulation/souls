//! `cargo run -p testworld --release -- [--seed S] [--things N] [--out DIR]`, from `v2/`: writes the test world as
//! N1's facts file and its manifest beside it, then reads the file back and loads it through N1's loader (K2's tree,
//! through commit), and prints the manifest, the load time and the file's SHA-256.

use import_eden::{count, load};
use std::time::Instant;
use testworld::{generate, manifest};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed: u64 =
        arg(&args, "--seed").map_or(1, |s| s.parse().expect("--seed is a whole number"));
    let things: usize =
        arg(&args, "--things").map_or(0, |s| s.parse().expect("--things is a whole number"));
    let dir = arg(&args, "--out").unwrap_or_else(|| "../.local/testworld".to_owned());
    let w = generate(seed, things).unwrap_or_else(|e| panic!("{e}"));
    std::fs::create_dir_all(&dir).expect("the output folder");
    let base = format!("{dir}/testworld-s{seed}-t{things}");
    let facts = format!("{base}.facts.json");
    let man = manifest(seed, things, &w);
    std::fs::write(&facts, &w.text).expect("the facts file");
    std::fs::write(format!("{base}.manifest.txt"), &man).expect("the manifest");
    print!("{man}");

    let t0 = Instant::now();
    let src = std::fs::read_to_string(&facts).expect("the facts file");
    let im = load(&src).unwrap_or_else(|e| panic!("load refused: {e}"));
    let ms = t0.elapsed().as_secs_f64() * 1e3;
    let (nodes, links) = im.tree.counts();
    println!(
        "loaded {nodes} nodes and {links} links in {ms:.1} ms (read, parse and commit with T2's checks)"
    );
    let (rows, ..) = count(&im);
    for r in &rows {
        println!("tree {}: {} (file says {})", r.what, r.tree, r.bake);
    }
    println!("notes: {}", im.notes.len());
}
