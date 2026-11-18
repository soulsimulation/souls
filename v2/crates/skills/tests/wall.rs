//! A3 and A4 of Engine v2 T9 (#2663; `v2/docs/bodies.md` rule 8): a skill crate that names `sim`'s world state, or uses
//! `unsafe`, does not compile; one that reads a clock or keeps a global fails the scan by name. Each compile case is a
//! throwaway crate depending on `replica` alone, built by the same cargo, offline, under `target/skills-wall`.

use std::path::{Path, PathBuf};
use std::process::Command;

use skills::scan::scan;

/// A skill crate's root: `replica` is its one dependency, and it forbids `unsafe`.
fn case(name: &str, body: &str) -> (bool, String) {
    let v2 = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir: PathBuf = v2.join("target/skills-wall").join(name);
    std::fs::create_dir_all(dir.join("src")).expect("a folder");
    let replica = v2.join("crates/replica").canonicalize().expect("replica");
    let manifest = format!(
        "[package]\nname = \"wall-{name}\"\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
         [dependencies]\nreplica = {{ path = {:?} }}\n\n[workspace]\n",
        replica.display().to_string()
    );
    std::fs::write(dir.join("Cargo.toml"), manifest).expect("written");
    std::fs::write(
        dir.join("src/lib.rs"),
        format!("#![forbid(unsafe_code)]\n{body}\n"),
    )
    .expect("written");
    std::fs::copy(v2.join("Cargo.lock"), dir.join("Cargo.lock")).expect("the lock");
    let out = Command::new(env!("CARGO"))
        .args(["build", "--offline", "--quiet", "--color", "never"])
        .current_dir(&dir)
        .env("CARGO_TARGET_DIR", v2.join("target/skills-wall/target"))
        .output()
        .expect("cargo runs");
    let said = String::from_utf8_lossy(&out.stderr)
        .lines()
        .filter(|l| l.starts_with("error"))
        .collect::<Vec<_>>()
        .join("\n");
    (out.status.success(), said)
}

#[test]
fn a3_a_skill_crate_that_names_sim_or_uses_unsafe_does_not_compile() {
    // Step 0's control: the same crate, using only replica, compiles.
    let (ok, said) = case(
        "replica-only",
        "pub fn probe() -> u32 { replica::load_probe(1) }",
    );
    println!("replica only: compiles {ok} {said}");
    assert!(ok, "the wall's control case must compile: {said}");

    let (ok, said) = case(
        "names-sim",
        "pub fn peek() -> usize { core::mem::size_of::<sim::walk::Walker>() }",
    );
    println!("names sim's state: compiles {ok}\n{said}");
    assert!(
        !ok && said.contains("E0433") && said.contains("unresolved module or unlinked crate `sim`"),
        "{said}"
    );

    let (ok, said) = case(
        "unsafe",
        "pub fn poke(p: *const u8) -> u8 { unsafe { *p } }",
    );
    println!("uses unsafe: compiles {ok}\n{said}");
    assert!(!ok && said.contains("usage of an `unsafe` block"), "{said}");
}

#[test]
fn a4_a_skill_that_reads_a_clock_or_keeps_a_global_fails_the_scan_by_name() {
    let root = "#![forbid(unsafe_code)]\npub mod a;\n";
    let names = |files: &[&str]| {
        scan(root, files)
            .into_iter()
            .map(|f| f.name)
            .collect::<Vec<_>>()
    };
    for (what, src, want) in [
        (
            "reads a clock",
            "pub fn t() -> u128 { std::time::Instant::now().elapsed().as_nanos() }",
            "skill-reads-clock",
        ),
        (
            "reads a clock through a use",
            "use std::{time::UNIX_EPOCH};\npub fn t() { let _ = UNIX_EPOCH.elapsed(); }",
            "skill-reads-clock",
        ),
        (
            "keeps a static",
            "static mut COUNT: u64 = 0;",
            "skill-keeps-global",
        ),
        (
            "keeps a static, spaced oddly",
            "pub static\n\tX: u64 = 0;",
            "skill-keeps-global",
        ),
        (
            "after a quote char",
            "fn q() -> char { '\"' }\nstatic mut X: u64 = 0;",
            "skill-keeps-global",
        ),
        (
            "keeps a thread-local",
            "thread_local ! { static\tY: u64 = 0; }",
            "skill-keeps-global",
        ),
        (
            "reads the environment",
            "pub fn e() -> bool { std::env::var(\"X\").is_ok() }",
            "skill-reaches-out",
        ),
        (
            "iterates a hash",
            "use std::collections::HashMap;",
            "skill-uses-hash-order",
        ),
        (
            "hides std behind an alias",
            "use std as s;\npub fn e() -> bool { s::env::var(\"X\").is_ok() }",
            "skill-reaches-out",
        ),
        (
            "after a byte raw string",
            "pub fn b() -> &'static [u8] { br\"\\\" }\nstatic mut X: u64 = 0;",
            "skill-keeps-global",
        ),
        (
            "names the state harness",
            "use replica::effects::{State};",
            "skill-names-state",
        ),
    ] {
        let got = names(&[src]);
        println!("{what}: {got:?}");
        assert!(got.contains(&want), "{what}: {got:?}");
    }
    let clean = "// std::time and static are fine in a comment\npub fn name() -> &'static str { \"static \" }\nfn c() -> char { 'x' }";
    assert!(names(&[clean]).is_empty(), "{:?}", names(&[clean]));
    assert_eq!(
        scan("pub mod a;", &[]).first().map(|f| f.name),
        Some("skill-allows-unsafe")
    );
    // Every source file of the built-in skills, however many there are, passes it.
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<String> = Vec::new();
    let mut dirs = vec![src.clone()];
    while let Some(d) = dirs.pop() {
        for e in std::fs::read_dir(&d).expect("a folder") {
            let p = e.expect("an entry").path();
            if p.is_dir() {
                dirs.push(p);
            } else if p.extension().is_some_and(|x| x == "rs") && p != src.join("lib.rs") {
                files.push(std::fs::read_to_string(&p).expect("a source"));
            }
        }
    }
    let lib = std::fs::read_to_string(src.join("lib.rs")).expect("lib.rs");
    let refs: Vec<&str> = files.iter().map(String::as_str).collect();
    let faults = scan(&lib, &refs);
    println!(
        "v2/crates/skills/src: {} files, {} faults",
        files.len() + 1,
        faults.len()
    );
    assert!(faults.is_empty(), "{faults:?}");
}
