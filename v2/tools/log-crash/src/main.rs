//! The log's runs on a real disk (Engine v2 K4, #2668). The power cuts run in memory, in `cargo test -p sim --test
//! log`; a killed process loses nothing the kernel holds, so only they test the sync.
//!
//! - `log-crash kill <dir> [runs]`: each run starts this program as a child that writes a log in `<dir>` and prints
//!   each acknowledgement, kills it at a random moment (seeded), recovers the log and checks that no acknowledged
//!   record is missing or changed. Seeds 1 to `runs` (default 50).
//! - `log-crash sync <dir> [rounds] [repeats] [bytes] [room MiB] [tick ms]`: times one append and one sync per tick,
//!   as the writer does (room made after a sync, `sim::log` rule 10), and prints the median, 99th percentile and
//!   longest (defaults 1,000 rounds, 2 repeats, 2,048 bytes a tick, the log's room, no pause between ticks). Room 0 is
//!   the file growing at every append, as before #4973; a tick of 50 paces it as the world's clock does.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use sim::log::{FileStore, Log, RESERVE, Storage, encode_record};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

/// Record `i` of a run: up to 4 KiB that depend only on the seed and `i`.
fn payload(seed: u64, i: u64) -> Vec<u8> {
    let mut r = Rng(seed ^ i.wrapping_mul(0x2545_F491_4F6C_DD1D));
    let len = 1 + r.below(4096) as usize;
    (0..len).map(|_| r.next() as u8).collect()
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("log-crash: {msg}");
    std::process::exit(1)
}

/// The child: writes ticks until it is killed, printing the durable mark each time it moves.
fn child(path: &Path, seed: u64) {
    let store = FileStore::open(path).unwrap_or_else(|e| fail(e));
    let (mut log, _) = Log::open(store, 1).unwrap_or_else(|e| fail(e));
    let mut out = std::io::stdout().lock();
    let mut told = 0;
    for i in 0.. {
        log.append(payload(seed, i)).unwrap_or_else(|e| fail(e));
        if i % 3 == 2 {
            log.wait_durable(i + 1).unwrap_or_else(|e| fail(e));
        }
        let d = log.durable();
        if d > told {
            told = d;
            let _ = writeln!(out, "{d}").and_then(|_| out.flush());
        }
    }
}

fn kill(dir: &Path, runs: u64) {
    let me = std::env::current_exe().unwrap_or_else(|e| fail(e));
    let mut least = u64::MAX;
    for seed in 1..=runs {
        let path = dir.join(format!("kill-{seed}.log"));
        let _ = std::fs::remove_file(&path);
        let mut r = Rng(seed);
        let after = Duration::from_millis(20 + r.below(400));
        let mut c = Command::new(&me)
            .arg("child")
            .arg(&path)
            .arg(seed.to_string())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| fail(e));
        std::thread::sleep(after);
        c.kill().unwrap_or_else(|e| fail(e));
        c.wait().unwrap_or_else(|e| fail(e));
        let acked = BufReader::new(c.stdout.take().expect("piped"))
            .lines()
            .map_while(Result::ok)
            .filter_map(|l| l.trim().parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        let store = FileStore::open(&path).unwrap_or_else(|e| fail(e));
        let (log, found) = Log::open(store, 1)
            .unwrap_or_else(|e| fail(format!("seed {seed}: recovery refused: {e}")));
        drop(log);
        let n = found.records.len() as u64;
        if n < acked {
            fail(format!("seed {seed}: {acked} acknowledged, {n} recovered"));
        }
        for (i, rec) in found.records.iter().enumerate() {
            if rec != &payload(seed, i as u64) {
                fail(format!("seed {seed}: record {i} changed"));
            }
        }
        least = least.min(n - acked);
        let torn = found.torn.map_or("no torn tail".into(), |t| {
            format!("a torn tail of {} bytes cut", t.dropped)
        });
        println!(
            "kill seed {seed}: killed after {} ms, {acked} acknowledged, {n} recovered, {torn}",
            after.as_millis()
        );
        let _ = std::fs::remove_file(&path);
    }
    println!(
        "{runs} kills: no acknowledged record missing or changed (fewest unacknowledged extra: {least})"
    );
}

// A tool that times the disk reads a clock itself (the wall-clock rule in v2/clippy.toml allows it by name).
#[allow(clippy::disallowed_methods)]
fn sync(dir: &Path, rounds: usize, repeats: usize, bytes: usize, room: u64, tick: u64) {
    println!(
        "sync table: {} ({}), {rounds} ticks of one append and one sync, {bytes} bytes a tick, {} MiB of room, \
         a tick each {tick} ms",
        std::env::consts::OS,
        if cfg!(target_os = "macos") {
            "F_FULLFSYNC"
        } else {
            "fdatasync"
        },
        room >> 20
    );
    println!("| repeat | median µs | p99 µs | longest µs |");
    println!("|---|---|---|---|");
    for rep in 1..=repeats {
        let path = dir.join(format!("sync-{rep}.log"));
        let _ = std::fs::remove_file(&path);
        let mut store = FileStore::open_reserving(&path, room).unwrap_or_else(|e| fail(e));
        store.reserve().unwrap_or_else(|e| fail(e));
        let mut prev = 0;
        let mut took = Vec::with_capacity(rounds);
        let start = Instant::now();
        for i in 0..rounds {
            let mut rec = Vec::new();
            prev = encode_record(&mut rec, 1, prev, &vec![i as u8; bytes.max(1)])
                .unwrap_or_else(|e| fail(e));
            let t = Instant::now();
            store.append(&rec).unwrap_or_else(|e| fail(e));
            store.sync().unwrap_or_else(|e| fail(e));
            took.push(t.elapsed().as_micros() as u64);
            store.reserve().unwrap_or_else(|e| fail(e));
            let next = start + Duration::from_millis(tick * (i as u64 + 1));
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
        }
        took.sort_unstable();
        let at = |q: usize| took[(took.len() * q / 100).min(took.len() - 1)];
        println!(
            "| {rep} | {} | {} | {} |",
            at(50),
            at(99),
            took[took.len() - 1]
        );
        drop(store);
        let _ = std::fs::remove_file(&path);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let num = |i: usize, d: u64| {
        args.get(i)
            .map_or(Ok(d), |s| s.parse::<u64>())
            .unwrap_or_else(|e| fail(e))
    };
    let dir = || {
        let d = Path::new(args.get(1).unwrap_or_else(|| fail("a directory is needed")));
        std::fs::create_dir_all(d).unwrap_or_else(|e| fail(e));
        d.to_path_buf()
    };
    match args.first().map(String::as_str) {
        Some("child") => child(
            Path::new(args.get(1).unwrap_or_else(|| fail("a log path is needed"))),
            num(2, 1),
        ),
        Some("kill") => kill(&dir(), num(2, 50)),
        Some("sync") => sync(
            &dir(),
            num(2, 1000) as usize,
            num(3, 2) as usize,
            num(4, 2048) as usize,
            num(5, RESERVE >> 20) << 20,
            num(6, 0),
        ),
        _ => fail(
            "usage: log-crash kill <dir> [runs] | sync <dir> [rounds] [repeats] [bytes] [room MiB] [tick ms]",
        ),
    }
}
