//! Engine v2 K7 (#2647): the stall test's own restarter. It starts `worldd` with its tick blocked on purpose at a
//! tick, waits for the watchdog to end it, starts a new `worldd` on the same state, and times the block to the new
//! process's first tick. The bar is 2 s. A watchdog inside a frozen process sees nothing, so this restarter also
//! kills a process that prints nothing for 1.5 s.
//!
//!   cargo build --release -p worldd -p stall-test
//!   target/release/stall-test --dir ../.local/stall-test [--repeats 2] [--stall-at 40]
//!
//! Each repeat starts a fresh state folder under `--dir`. Exit 0 when every repeat ticks again within 2 s at the tick
//! that was blocked (none skipped), 1 otherwise.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this tool.
#![allow(clippy::disallowed_methods)]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

/// A process that prints nothing for this long is frozen: the restarter kills it.
const SILENT: Duration = Duration::from_millis(1_500);
const BAR: Duration = Duration::from_secs(2);

/// Starts `worldd` on `dir`, its lines sent with the time each arrived; `None` on its end.
fn start(
    worldd: &PathBuf,
    dir: &PathBuf,
    stall_at: Option<i64>,
) -> (Child, Receiver<Option<(Instant, String)>>) {
    let mut cmd = Command::new(worldd);
    cmd.arg("--dir")
        .arg(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(n) = stall_at {
        cmd.arg("--stall-at").arg(n.to_string());
    }
    let mut child = cmd.spawn().expect("worldd starts");
    let out = child.stdout.take().expect("its output");
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if tx.send(Some((Instant::now(), line))).is_err() {
                return;
            }
        }
        let _ = tx.send(None);
    });
    (child, rx)
}

/// The next line, or the process's end (`None`), killing a process silent for [`SILENT`].
fn next(child: &mut Child, rx: &Receiver<Option<(Instant, String)>>) -> Option<(Instant, String)> {
    match rx.recv_timeout(SILENT) {
        Ok(v) => v,
        Err(RecvTimeoutError::Timeout) => {
            println!(
                "  restarter: no line for {} ms: killed as frozen",
                SILENT.as_millis()
            );
            let _ = child.kill();
            None
        }
        Err(RecvTimeoutError::Disconnected) => None,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|k| args.get(k + 1))
    };
    let Some(root) = arg("--dir").map(PathBuf::from) else {
        eprintln!(
            "usage: stall-test --dir <folder> [--repeats 2] [--stall-at 40] [--worldd <path>]"
        );
        std::process::exit(2);
    };
    let repeats: usize = arg("--repeats").and_then(|v| v.parse().ok()).unwrap_or(2);
    let stall_at: i64 = arg("--stall-at").and_then(|v| v.parse().ok()).unwrap_or(40);
    let worldd = arg("--worldd").map(PathBuf::from).unwrap_or_else(|| {
        std::env::current_exe()
            .expect("this program's path")
            .with_file_name("worldd")
    });
    let mut ok = true;
    for r in 1..=repeats {
        let dir = root.join(format!("run-{r}"));
        let _ = std::fs::remove_dir_all(&dir);
        // The first process: ticks, then blocks at `stall_at` until its watchdog ends it.
        let (mut child, rx) = start(&worldd, &dir, Some(stall_at));
        let mut blocked = None;
        while let Some((at, line)) = next(&mut child, &rx) {
            if line.starts_with("stall:") || line.starts_with("watchdog:") {
                println!("  {line}");
            }
            if line.starts_with("stall:") {
                blocked = Some(at);
            }
        }
        let status = child.wait().expect("worldd ends");
        let ended = Instant::now();
        let Some(blocked) = blocked else {
            println!("repeat {r}: the tick never blocked ({status})");
            ok = false;
            continue;
        };
        // The new process, on the same state: its first tick.
        let (mut child, rx) = start(&worldd, &dir, None);
        let mut first = None;
        while let Some((at, line)) = next(&mut child, &rx) {
            if line.starts_with("start:") {
                println!("  {line}");
            }
            if let Some(n) = line.strip_prefix("tick ") {
                let n: i64 = n
                    .split(' ')
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(-1);
                first = Some((at, n));
                break;
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        let Some((at, n)) = first else {
            println!("repeat {r}: the new process never ticked");
            ok = false;
            continue;
        };
        let took = at - blocked;
        let pass = took < BAR && n == stall_at;
        ok &= pass;
        println!(
            "repeat {r}: blocked at tick {stall_at}; the watchdog ended it {} ms after the block ({status}); the new \
             process started {} ms after that and ran tick {n} {} ms after the block: {}",
            (ended - blocked).as_millis(),
            (at - ended).as_millis(),
            took.as_millis(),
            if pass { "pass" } else { "FAIL" }
        );
    }
    std::process::exit(if ok { 0 } else { 1 });
}
