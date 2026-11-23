//! D6 (0.132): a served world stopped by SIGTERM or SIGINT leaves one line naming the signal, and still ends by that
//! signal, as before (no new shutdown behaviour).

use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::time::Duration;

fn worldd() -> Command {
    Command::new(env!("CARGO_BIN_EXE_worldd"))
}

fn scratch(tag: &str) -> PathBuf {
    // Short: a Unix socket's path is at most 104 bytes on macOS.
    let d = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

/// N2's test world, seeded into `d/w`.
fn seeded(d: &Path) -> PathBuf {
    let facts = d.join("facts.json");
    std::fs::write(
        &facts,
        testworld::generate(1, 0).expect("the test world").text,
    )
    .expect("facts");
    let dir = d.join("w");
    let out = worldd()
        .args(["seed", "--facts"])
        .arg(&facts)
        .arg("--dir")
        .arg(&dir)
        .args(["--souls", "0"])
        .output()
        .expect("seed runs");
    assert!(
        out.status.success(),
        "seed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    dir
}

/// Serves `dir` until it listens, sends it `signal` by its pid, and gives its exit status and every line it wrote.
// A real process on the real clock: the wait for its line is real time.
#[allow(clippy::disallowed_methods)]
fn stopped_by(dir: &Path, socket: &Path, signal: &str) -> (std::process::ExitStatus, Vec<String>) {
    let mut child = worldd()
        .args(["serve", "--dir"])
        .arg(dir)
        .arg("--socket")
        .arg(socket)
        .env_remove("SOULS_BACKUP_URL")
        .env_remove("SOULS_BACKUP_KEY_FILE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("worldd serve starts");
    let (tx, lines) = channel();
    let mut readers = Vec::new();
    for pipe in [
        Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
        Box::new(child.stderr.take().unwrap()),
    ] {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for l in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = tx.send(l);
            }
        }));
    }
    drop(tx);
    let mut all = Vec::new();
    loop {
        let l = lines
            .recv_timeout(Duration::from_secs(60))
            .expect("worldd serve listens within 60 s");
        let ready = l.starts_with("listening");
        all.push(l);
        if ready {
            break;
        }
    }
    let kill = Command::new("kill")
        .args([signal, &child.id().to_string()])
        .status()
        .expect("kill runs");
    assert!(kill.success());
    let status = child.wait().expect("worldd serve ends");
    for r in readers {
        let _ = r.join();
    }
    all.extend(lines.try_iter());
    (status, all)
}

#[test]
fn d6_a_sigterm_or_sigint_leaves_one_line_and_ends_by_that_signal() {
    let d = scratch("d6");
    let dir = seeded(&d);
    for (signal, number, line) in [
        ("-TERM", 15, "worldd: stopped by SIGTERM"),
        ("-INT", 2, "worldd: stopped by SIGINT"),
    ] {
        let (status, all) = stopped_by(&dir, &d.join("w.sock"), signal);
        assert_eq!(
            all.iter().filter(|l| *l == line).count(),
            1,
            "one line naming the signal: {all:?}"
        );
        assert_eq!(
            status.signal(),
            Some(number),
            "it still ends by the signal, as before: {status:?}"
        );
    }
    let _ = std::fs::remove_dir_all(&d);
}
