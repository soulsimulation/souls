//! K7's watchdog (#2647), soft and hard: a tick held 600 ms is a stall the world says and runs on from, with no
//! exit; a tick held for good ends the process at the hard limit, exit 86 (`tick-stalled`). Runs `worldd --dir`, the
//! clock alone, with a tick blocked on purpose (`--stall-at`, `--stall-for`).

// Times the process it watches: the wall-clock rule (K7) binds the engine, not its tests.
#![allow(clippy::disallowed_methods)]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

/// Runs `worldd --dir` with `args`, gathering its output lines until `done` holds for one, the process ends, or 20 s
/// pass. Returns the lines and the exit code (`None`: still running, then killed).
///
/// The output ends (its pipe closes) a moment before the ended process can be waited for: the kernel closes its files
/// first. So once the output has ended, the exit code is waited for (to the same 20 s), not read once: a single
/// `try_wait` there can land in that moment, see the process still running and kill it (#3819's flake on CI).
fn run(name: &str, args: &[&str], done: impl Fn(&str) -> bool) -> (Vec<String>, Option<i32>) {
    let dir = std::env::temp_dir().join(format!("worldd-k7-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut child = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .arg("--dir")
        .arg(&dir)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("worldd starts");
    let out = child.stdout.take().expect("its output");
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    let until = Instant::now() + Duration::from_secs(20);
    let mut lines = Vec::new();
    let mut ended = false;
    while Instant::now() < until {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(l) => {
                let stop = done(&l);
                lines.push(l);
                if stop {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                ended = true;
                break;
            }
        }
    }
    let mut state = child.try_wait().expect("its state");
    while ended && state.is_none() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
        state = child.try_wait().expect("its state");
    }
    let code = match state {
        Some(s) => s.code(),
        None => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    };
    let _ = std::fs::remove_dir_all(&dir);
    (lines, code)
}

fn tick_of(line: &str) -> Option<i64> {
    line.strip_prefix("tick ")?.split(' ').next()?.parse().ok()
}

#[test]
fn k7_a_600_ms_stall_is_said_and_the_world_runs_on_with_no_exit() {
    let (lines, code) = run("soft", &["--stall-at", "20", "--stall-for", "600"], |l| {
        tick_of(l).is_some_and(|n| n >= 40)
    });
    let text = lines.join("\n");
    assert_eq!(code, None, "still running after the stall:\n{text}");
    let said = lines
        .iter()
        .position(|l| l.starts_with("watchdog: stalled: no tick for"))
        .expect(&text);
    let again = lines
        .iter()
        .position(|l| l.starts_with("watchdog: ticking again after a stall of"))
        .expect(&text);
    assert!(said < again, "{text}");
    assert!(!text.contains("tick-stalled"), "{text}");
    // Every tick from the blocked one on, none skipped.
    let after: Vec<i64> = lines
        .iter()
        .filter_map(|l| tick_of(l))
        .filter(|n| *n >= 20)
        .collect();
    assert_eq!(after, (20..=40).collect::<Vec<_>>(), "{text}");
}

#[test]
fn k7_a_tick_held_for_good_ends_the_process_at_the_hard_limit() {
    let t = Instant::now();
    let (lines, code) = run(
        "hard",
        &["--stall-at", "20", "--watchdog-hard-ms", "1500"],
        |_| false,
    );
    let text = lines.join("\n");
    assert_eq!(code, Some(86), "{text}");
    let said = lines
        .iter()
        .position(|l| l.starts_with("watchdog: stalled:"))
        .expect(&text);
    let ended = lines
        .iter()
        .position(|l| l.starts_with("watchdog: tick-stalled: no tick for"))
        .expect(&text);
    assert!(said < ended, "{text}");
    assert!(
        t.elapsed() < Duration::from_secs(10),
        "ended at the given hard limit, not the default"
    );
}
