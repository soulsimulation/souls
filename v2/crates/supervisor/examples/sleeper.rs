//! A stand-in world for O2's runs (#2731): a world with nothing but a due list, which sleeps and wakes as a world
//! does (`supervisor::sleep`). The runs install it as a world's build, so the real unit and launcher start it.
//!
//! `sleeper --dir <state>`: the world's name is the folder's name; the alarm daemon's socket is
//! `$WORLDS_ROOT/alarms.sock` (or `--socket <path>`). `<state>/due` holds its due times, one per line (µs from the
//! Unix epoch): its checkpoint. Each due change is committed at its due time, never before, as a line
//! `<due> <committed at>` appended to `<state>/commits`. Still, with nothing due for a minute, it sleeps: checkpoint,
//! alarm, exit 75.
//!
//! Under systemd it says READY=1 once it has caught up, and WATCHDOG=1 while it waits.

// A stand-in world's real clock: it measures when a due change is committed against the wall clock.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeSet;
use std::io::Write;
use std::os::unix::net::UnixDatagram;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use supervisor::sleep::{EXIT_ASLEEP, awake, may_sleep, sleep};

fn now_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as i64)
}

fn notify(state: &str) {
    let Some(path) = std::env::var_os("NOTIFY_SOCKET") else {
        return;
    };
    if let Ok(s) = UnixDatagram::unbound() {
        let _ = s.send_to(state.as_bytes(), PathBuf::from(path));
    }
}

fn checkpoint(dir: &Path, due: &BTreeSet<i64>) -> std::io::Result<()> {
    let text: String = due.iter().map(|d| format!("{d}\n")).collect();
    let tmp = dir.join("due.new");
    std::fs::write(&tmp, text)?;
    std::fs::rename(tmp, dir.join("due"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|k| args.get(k + 1))
    };
    let Some(dir) = arg("--dir").map(PathBuf::from) else {
        eprintln!("usage: sleeper --dir <state> [--socket <alarms socket>]");
        std::process::exit(2);
    };
    let socket = arg("--socket").map_or_else(
        || PathBuf::from(std::env::var_os("WORLDS_ROOT").unwrap_or_default()).join("alarms.sock"),
        PathBuf::from,
    );
    let world = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("world")
        .to_owned();
    let _ = std::fs::create_dir_all(&dir);
    let mut due: BTreeSet<i64> = std::fs::read_to_string(dir.join("due"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect();
    let mut commits = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("commits"))
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("sleeper: commits: {e}");
            std::process::exit(1);
        }
    };
    notify("READY=1");
    awake(&socket, &world);
    loop {
        // Commit what is due, at its due time (overdue: now, as a world catching up does).
        let now = now_us();
        while let Some(&d) = due.first().filter(|d| **d <= now) {
            due.remove(&d);
            let _ = writeln!(commits, "{d} {}", now_us());
            let _ = commits.sync_data();
        }
        let next = due.first().copied();
        if may_sleep(now, next, true) {
            match sleep(&socket, &world, next, || checkpoint(&dir, &due)) {
                Ok(()) => {
                    println!("asleep: next due {next:?}");
                    std::process::exit(EXIT_ASLEEP);
                }
                Err(e) => eprintln!("sleeper: staying awake: {e}"),
            }
        }
        // Wait for the next due change (or a second, to try sleeping again), alive to the watchdog.
        let wait = next.map_or(1_000_000, |n| (n - now_us()).clamp(0, 1_000_000));
        notify("WATCHDOG=1");
        std::thread::sleep(Duration::from_micros(wait as u64));
    }
}
