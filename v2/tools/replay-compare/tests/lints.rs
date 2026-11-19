//! A4 (K12, #2675): a seeded `HashMap`, `HashSet`, `Instant::now`, `SystemTime::now` and `thread_rng` each fail the
//! build by name under `v2/clippy.toml`. The seeds sit in a scratch crate under the workspace's target directory,
//! linted with `v2/clippy.toml` as `sim` is (`CLIPPY_CONF_DIR`), with a stand-in `rand` crate so `rand::thread_rng`
//! resolves offline. Run with `cargo test -p replay-compare --test lints -- --nocapture` to see the five errors.

use std::fs;
use std::path::Path;
use std::process::Command;

const SEEDS: &str = r#"
pub fn hash_map() -> usize { std::collections::HashMap::<u8, u8>::new().len() }
pub fn hash_set() -> usize { std::collections::HashSet::<u8>::new().len() }
pub fn instant() -> std::time::Instant { std::time::Instant::now() }
pub fn system_time() -> std::time::SystemTime { std::time::SystemTime::now() }
pub fn thread_rng() -> u64 { rand::thread_rng() }
"#;

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn a4_each_seeded_violation_fails_the_build_by_name() {
    let v2 = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("k12-lint-seeds");
    let _ = fs::remove_dir_all(&dir);
    write(
        &dir.join("Cargo.toml"),
        "[package]\nname = \"sim-seeded\"\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
         [dependencies]\nrand = { path = \"rand\" }\n\n[workspace]\n",
    );
    write(&dir.join("src/lib.rs"), SEEDS);
    write(
        &dir.join("rand/Cargo.toml"),
        "[package]\nname = \"rand\"\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n",
    );
    write(
        &dir.join("rand/src/lib.rs"),
        "pub fn thread_rng() -> u64 { 4 }\n",
    );
    let out = Command::new("cargo")
        .args(["clippy", "--offline", "--quiet", "--", "-D", "warnings"])
        .current_dir(&dir)
        .env("CLIPPY_CONF_DIR", &v2)
        .env("CARGO_TARGET_DIR", dir.join("target"))
        .output()
        .expect("cargo clippy runs");
    let err = String::from_utf8_lossy(&out.stderr);
    for line in err.lines().filter(|l| l.starts_with("error")) {
        println!("{line}");
    }
    assert!(!out.status.success(), "the seeded crate must fail:\n{err}");
    for name in [
        "disallowed type `std::collections::HashMap`",
        "disallowed type `std::collections::HashSet`",
        "disallowed method `std::time::Instant::now`",
        "disallowed method `std::time::SystemTime::now`",
        "disallowed method `rand::thread_rng`",
    ] {
        assert!(
            err.lines()
                .any(|l| l.starts_with("error") && l.contains(name)),
            "no error names {name}:\n{err}"
        );
    }
}
