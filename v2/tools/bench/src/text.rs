//! The `text` bench (Engine v2 K16, #2677): writes offered to the text store at a fixed rate from many threads, each
//! returning its reference only once the batch holding it is synced (`v2/crates/sim/src/text/mod.rs`, rule 3). Prints
//! a row per repeat: writes done, the rate reached, the time from write to reference (median and 99th percentile) and
//! the syncs a second. Declared on #2677. Run from `v2/`:
//! `cargo run -p bench --release --bin text -- <dir> [rate 10000] [seconds 60] [repeats 2] [threads 128]`.
//! A sync is `fdatasync` on Linux and `F_FULLFSYNC` on macOS (K4).

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use replica::ids::{Id, Minter, Scope};
use replica::world_model::Audience;
use sim::text::Store;

fn arg(args: &[String], i: usize, default: u64) -> u64 {
    args.get(i).and_then(|a| a.parse().ok()).unwrap_or(default)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(args.get(1).map_or("target/text-bench", |s| s.as_str()));
    let (rate, seconds, repeats, threads) = (
        arg(&args, 2, 10_000),
        arg(&args, 3, 60),
        arg(&args, 4, 2),
        arg(&args, 5, 128),
    );
    println!(
        "text store: {rate} writes/s offered for {seconds} s from {threads} threads, {repeats} repeats, on {} ({})",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!(
        "| repeat | writes | writes/s | p50 ms | p99 ms | max ms | syncs/s | writes per sync | bar |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");
    let mut pass = true;
    for repeat in 1..=repeats {
        let d = dir.join(format!("run-{repeat}"));
        let _ = std::fs::remove_dir_all(&d);
        let store = Arc::new(Store::open_dir(&d, Minter::new(Scope([0x7e; 16]))).expect("opens"));
        let author = Id::new(Scope([0xdd; 16]), 1).expect("an id");
        let start = Instant::now() + Duration::from_millis(50);
        let end = start + Duration::from_secs(seconds);
        let workers: Vec<_> = (0..threads)
            .map(|t| {
                let store = store.clone();
                std::thread::spawn(move || {
                    let mut lat = Vec::new();
                    for k in 0.. {
                        // Write k of thread t is due at (k * threads + t) / rate seconds after the start.
                        let due =
                            start + Duration::from_nanos((k * threads + t) * 1_000_000_000 / rate);
                        if due >= end {
                            break;
                        }
                        let now = Instant::now();
                        if due > now {
                            std::thread::sleep(due - now);
                        }
                        let words =
                            format!("thread {t} says line {k} of the bench, about forty bytes");
                        let t0 = Instant::now();
                        store
                            .write(words.as_bytes(), Audience::Everyone, author)
                            .expect("written");
                        lat.push(t0.elapsed().as_micros() as u64);
                    }
                    lat
                })
            })
            .collect();
        let mut lat: Vec<u64> = workers
            .into_iter()
            .flat_map(|w| w.join().expect("a writer"))
            .collect();
        let took = start.elapsed().as_secs_f64();
        let syncs = store.syncs();
        lat.sort_unstable();
        let q = |p: f64| lat[((lat.len() as f64 * p) as usize).min(lat.len() - 1)] as f64 / 1000.0;
        let done = lat.len() as f64 / took;
        let ok = done >= rate as f64 * 0.99;
        pass &= ok;
        println!(
            "| {repeat} | {} | {done:.0} | {:.2} | {:.2} | {:.2} | {:.0} | {:.1} | {} |",
            lat.len(),
            q(0.5),
            q(0.99),
            q(1.0),
            syncs as f64 / took,
            lat.len() as f64 / syncs.max(1) as f64,
            if ok { "met" } else { "unmet" }
        );
        drop(store);
        let _ = std::fs::remove_dir_all(&d);
    }
    println!(
        "{}",
        if pass {
            "every repeat sustained the rate"
        } else {
            "a repeat fell short of the rate"
        }
    );
}
