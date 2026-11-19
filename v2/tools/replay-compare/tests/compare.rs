//! A1 and A2 (K12, #2675) on a one-minute recording, so CI keeps them: three processes give one log hash, and a
//! seeded divergence is caught and located. The ten-minute run is `replay-compare record <dir> 10` then `compare`.

use std::path::Path;
use std::process::Command;

fn tool(args: &[&str]) -> (bool, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_replay-compare"))
        .args(args)
        .output()
        .expect("the tool runs");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    println!("{text}");
    (o.status.success(), text)
}

#[test]
fn a1_a2_three_processes_one_hash_and_a_seeded_divergence_located() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("k12-compare");
    let d = dir.to_str().unwrap();
    assert!(tool(&["record", d, "1"]).0);
    let (same, text) = tool(&["compare", d]);
    assert!(same && text.contains("same: three processes, one log hash"));
    let (same, text) = tool(&["compare", d, "--diverge-at", "610"]);
    assert!(!same);
    assert!(
        text.contains("first differing record")
            && text.contains("after the inputs of tick Some(610)"),
        "{text}"
    );
}
