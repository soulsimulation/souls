//! The `resync` bench (Engine v2 R5, #2699): a client that was away six hours becomes current.
//!
//! K5's world (`src/world.rs`: 100 rooms, 1,000 bodies, 10,000 cups) is built and sealed, and a client takes its
//! copy of its scope: the room its body stands in (R4's follow scope), and, as a second line, the whole place. The
//! world then runs six world hours from a recorded log: each world second one part moves 84 bodies chosen by a seeded
//! generator (5,040 acts a minute, the tranche's burst), so every body has moved many times. The log is made once,
//! from the seed, under `--dir` (a run artifact, never a tracked file) and replayed by every run. The world seals,
//! and the client comes back: its cursor is six hours old, so the gateway cannot resume it (I1's `Kept`, holding the
//! last frames); it loads the checking library by the world's build hash (`node client/src/sync/library.mjs`, in a
//! worker) and compares and descends (`replica::sync`). Timed from the client's start to its copy equal to the
//! world's, its root hashes checked against the world's.
//!
//! Two arms, `--repeats` each: `cached` (the world's build is in the client's cache) and `build-changed` (the world
//! names another build, which the client downloads and checks). Bytes are counted each way, with what a snapshot of
//! the scope (a sync from nothing) would have fetched beside them. No network: the world's answers are in-process,
//! so add one round trip per round.
//!
//! Run from `v2/`, with the checker built (`checker-artifact` in tools/ci.sh):
//!   CARGO_TARGET_DIR=target/checker cargo build -p replica --release --target wasm32-unknown-unknown --features checker
//!   cargo run -p bench --release --bin resync -- --dir target/resync \
//!     --checker target/checker/wasm32-unknown-unknown/release/replica.wasm [--hours 6] [--repeats 2]

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

#[path = "../src/world.rs"]
mod world;

use gatewayd::resume::{Cursor, Kept, Resume};
use replica::effects::{Change, Effect, Part};
use replica::encode::to_hex;
use replica::ids::{Id, Scope, Version};
use replica::intents::build_hash;
use replica::pose::{HandOff, Owner, Vec3};
use replica::sync::{Copy, Records, Served, Start, Synced, start};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use world::{World, build, pose};

/// Bodies moved each world second.
const MOVERS: usize = 84;
const SEED: u64 = 0x5eed_2699;

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

fn second(w: &mut World, rng: &mut Rng, s: u64) -> Vec<Effect> {
    (0..MOVERS)
        .map(|_| {
            let ix = (rng.next() % w.bodies.len() as u64) as usize;
            let (b, room) = (w.bodies[ix], w.rooms[ix / 10]);
            let x = (rng.next() % 10_000) as i64;
            let sample = Change::Motion(HandOff {
                node: b,
                at: s as i64 * 1_000_000,
                from: Owner::Mover,
                to: Owner::Mover,
                pose: pose(room, None, x),
                linear: Vec3::new((rng.next() % 2_000) as i64 - 1_000, 0, 0),
                angular: Vec3::ZERO,
            });
            w.entry(b, vec![sample])
        })
        .collect()
}

/// Records the six hours once, from the seed: each part's bytes, length first.
fn record(path: &Path, hours: u64) {
    if path.exists() {
        return;
    }
    let t0 = Instant::now();
    let mut w = build(1);
    let tmp = path.with_extension("tmp");
    let mut out = BufWriter::new(std::fs::File::create(&tmp).expect("log"));
    let mut rng = Rng(SEED);
    let mut bytes = 0u64;
    for s in 1..=hours * 3600 {
        let e = second(&mut w, &mut rng, s);
        let b = w.commit(e);
        out.write_all(&(b.len() as u32).to_le_bytes())
            .expect("writes");
        out.write_all(&b).expect("writes");
        bytes += b.len() as u64;
    }
    out.flush().expect("flushes");
    drop(out);
    std::fs::rename(&tmp, path).expect("renames");
    println!(
        "recorded {} parts, {} entries, {:.1} MB, in {:.0} ms",
        hours * 3600,
        hours * 3600 * MOVERS as u64,
        bytes as f64 / 1e6,
        ms(t0.elapsed())
    );
}

fn parts(path: &Path) -> Vec<Vec<u8>> {
    let mut r = BufReader::new(std::fs::File::open(path).expect("the log"));
    let mut out = Vec::new();
    let mut len = [0u8; 4];
    while r.read_exact(&mut len).is_ok() {
        let mut b = vec![0u8; u32::from_le_bytes(len) as usize];
        r.read_exact(&mut b).expect("a whole part");
        out.push(b);
    }
    out
}

fn version(w: &World, epoch: u64) -> Version {
    Version {
        lineage: Scope(w.header.lineage.0),
        zone: w.header.zone,
        epoch,
        sequence: w.tree.next(),
    }
}

fn hash_of(w: &World, id: Id) -> Option<Vec<u8>> {
    w.tree
        .node(w.tree.handle(id)?)?
        .sealed()
        .map(|h| h.to_bytes())
}

struct Library {
    ms: f64,
    downloaded: u64,
    json: String,
}

fn library(dir: &Path, build: &str) -> Library {
    let t0 = Instant::now();
    let out = Command::new("node")
        .arg("client/src/sync/library.mjs")
        .arg("--cache")
        .arg(dir.join("cache"))
        .arg("--build")
        .arg(build)
        .arg("--store")
        .arg(dir.join("store"))
        .output()
        .expect("node");
    let ms = ms(t0.elapsed());
    let json = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert!(
        out.status.success(),
        "the library: {json} {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let downloaded = json
        .split("\"downloaded\":")
        .nth(1)
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Library {
        ms,
        downloaded,
        json,
    }
}

fn line(
    arm: &str,
    r: usize,
    scope: &str,
    ms_total: f64,
    lib: Option<&Library>,
    s: &Synced,
    snapshot: &Synced,
) {
    println!(
        "{arm} repeat={r} scope={scope} total_ms={ms_total:.1} library_ms={:.1} library_bytes={} rounds={} \
         changed={} fetched={} held={} sent={} got={} snapshot_got={} equal=true",
        lib.map_or(0.0, |l| l.ms),
        lib.map_or(0, |l| l.downloaded),
        s.rounds,
        s.changed,
        s.fetched,
        s.held,
        s.sent,
        s.got,
        snapshot.got
    );
}

fn run(dir: &Path, log: &[Vec<u8>], arm: &str, build: &str, r: usize) {
    // The world and the client's copy before it went away.
    let mut w = build_world();
    let mut records = Records::default();
    records.keep(&w.tree.seal().expect("seals"));
    let (room, place) = (w.rooms[0], w.tree.node(w.tree.root()).expect("root").id());
    let mut copies = [(room, Copy::default()), (place, Copy::default())];
    for (id, c) in &mut copies {
        c.sync(
            &[*id],
            &mut Served {
                tree: &w.tree,
                records: &records,
            },
        )
        .expect("first sync");
    }
    let cursor = version(&w, 1);
    // Six hours of the world, replayed; the gateway keeps the last frames it sent.
    let t0 = Instant::now();
    let mut kept = Kept::default();
    let skip = log.len().saturating_sub(gatewayd::resume::KEPT);
    for (i, b) in log.iter().enumerate() {
        w.tree
            .apply(&w.header, &Part::read(b).expect("a part"))
            .expect("applies");
        // Every frame passes through the gateway; only the last ones' bytes matter, as it lets the rest go.
        let at = Cursor::from_value(&version(&w, 1).to_value()).expect("a version");
        kept.push(at, if i >= skip { b.clone() } else { Vec::new() });
    }
    let replay = t0.elapsed();
    let t1 = Instant::now();
    records.keep(&w.tree.seal().expect("seals"));
    let seal = t1.elapsed();
    if r == 1 && arm == "cached" {
        println!(
            "world: {} parts replayed in {:.0} ms, sealed in {:.0} ms, {} records kept",
            log.len(),
            ms(replay),
            ms(seal),
            records.len()
        );
    }
    let world_now = version(&w, 1);
    for (i, (id, copy)) in copies.iter_mut().enumerate() {
        // The client comes back.
        let t = Instant::now();
        let resumed = match start(Some(&cursor), &world_now) {
            Start::Cursor => {
                matches!(
                    kept.resume(
                        &Cursor::from_value(&cursor.to_value()).expect("a cursor"),
                        1
                    ),
                    Resume::Resumed(_)
                )
            }
            Start::FromTop => false,
        };
        assert!(!resumed, "a six-hour-old cursor is not held");
        let lib = (i == 0).then(|| library(dir, build));
        let s = copy
            .sync(
                &[*id],
                &mut Served {
                    tree: &w.tree,
                    records: &records,
                },
            )
            .expect("syncs");
        let total = ms(t.elapsed());
        assert_eq!(
            copy.roots().get(id),
            hash_of(&w, *id).as_ref(),
            "the copy equals the world"
        );
        assert_eq!(copy.reach().expect("whole").len(), s.held);
        let snapshot = Copy::default()
            .sync(
                &[*id],
                &mut Served {
                    tree: &w.tree,
                    records: &records,
                },
            )
            .expect("a snapshot");
        line(
            arm,
            r,
            if i == 0 { "room" } else { "place" },
            total,
            lib.as_ref(),
            &s,
            &snapshot,
        );
        if let Some(l) = &lib
            && r == 1
        {
            println!("  library: {}", l.json);
        }
    }
}

fn build_world() -> World {
    build(1)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let (Some(dir), Some(checker)) = (arg("--dir"), arg("--checker")) else {
        eprintln!(
            "usage: resync --dir <folder> --checker <replica.wasm> [--hours 6] [--repeats 2]"
        );
        std::process::exit(2);
    };
    let hours: u64 = arg("--hours").map_or(6, |h| h.parse().expect("hours"));
    let repeats: usize = arg("--repeats").map_or(2, |h| h.parse().expect("repeats"));
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(dir.join("store")).expect("dir");
    // The world's builds: this one, and another (the same module with a custom section, so another hash).
    let bytes = std::fs::read(&checker).expect("the checker");
    let mut other = bytes.clone();
    let name = b"souls:other-build";
    other.extend_from_slice(&[0x00, (1 + name.len() + 8) as u8, name.len() as u8]);
    other.extend_from_slice(name);
    other.extend_from_slice(&SEED.to_le_bytes());
    let (this, that) = (to_hex(&build_hash(&bytes)), to_hex(&build_hash(&other)));
    std::fs::write(dir.join("store").join(format!("{this}.wasm")), &bytes).expect("store");
    std::fs::write(dir.join("store").join(format!("{that}.wasm")), &other).expect("store");
    println!("builds: this {this} ({} bytes), other {that}", bytes.len());
    let log_path = dir.join(format!("log-{hours}h"));
    record(&log_path, hours);
    let log = parts(&log_path);
    // The cache holds this build: a first load primes it.
    library(&dir, &this);
    for (arm, build) in [("cached", &this), ("build-changed", &that)] {
        for r in 1..=repeats {
            let _ = std::fs::remove_file(dir.join("cache").join(format!("{that}.wasm")));
            run(&dir, &log, arm, build, r);
        }
    }
}
