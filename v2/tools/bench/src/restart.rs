//! The `restart` bench (Engine v2 K5, #2669): a world of 10,000 things and 1,000 bodies (`world`, the tranche's
//! target counts, larger than N1's import) is built and then kept busy, its parts appended to a real log and a
//! checkpoint taken at each interval of log; the process is killed (SIGKILL) with one interval of log after its last
//! checkpoint; a new process restores, replays and runs its first tick. Timed from the spawn to the first tick, after
//! one interval and after ten, two repeats each (A1); the state hashes before the kill and after the restart (A4);
//! the longest tick while checkpointing (A5). Run from `v2/`: `cargo run -p bench --release --bin restart`; it works
//! under `target/restart-bench`. Declared on #2669.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

mod world;

use replica::effects::{Change, Effect, Header, Part};
use replica::encode::{Value, encode};
use replica::ids::{Scope, Version};
use replica::pose::{HandOff, Owner, Vec3};
use sim::checkpoint::{Checkpoints, replay, restore};
use sim::log::{FileStore, Log};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};
use world::{World, pose};

/// The interval: a checkpoint each 8 MiB of log.
const EVERY: u64 = 8 << 20;
/// Bodies moved each tick (each its own entry with one motion sample).
const MOVERS: usize = 100;

fn part_bytes(h: &Header, entries: &[Effect]) -> Vec<u8> {
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (
            2,
            Value::Array(entries.iter().map(Effect::to_value).collect()),
        ),
    ]));
    encode(&v).expect("bytes")
}

/// One busy tick's entries: `MOVERS` bodies, in turn, each a step along its room.
fn tick_entries(w: &mut World, tick: u64) -> Vec<Effect> {
    let n = w.bodies.len();
    (0..MOVERS)
        .map(|i| {
            let ix = (tick as usize * MOVERS + i) % n;
            let (b, room) = (w.bodies[ix], w.rooms[ix / 10]);
            let x = (ix % 10) as i64 * 1000 + (tick % 1000) as i64;
            let sample = Change::Motion(HandOff {
                node: b,
                at: tick as i64 * 50_000,
                from: Owner::Mover,
                to: Owner::Mover,
                pose: pose(room, None, x),
                linear: Vec3::new(20_000, 0, 0),
                angular: Vec3::ZERO,
            });
            w.entry(b, vec![sample])
        })
        .collect()
}

fn version(h: &Header, next: u64) -> Version {
    Version {
        lineage: Scope(h.lineage.0),
        zone: h.zone,
        epoch: 1,
        sequence: next,
    }
}

fn hashes(t: &mut replica::tree::Tree) -> String {
    t.seal()
        .expect("seals")
        .hashes()
        .values()
        .map(|h| h.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// The writing process: builds, runs until `intervals` checkpoints are taken and one more interval of log (short of
/// the next checkpoint) is written, prints `ready`, and waits to be killed.
fn run(dir: &Path, intervals: u64) {
    let (mut log, _) =
        Log::open(FileStore::open(&dir.join("log")).expect("log"), 1).expect("opens");
    let mut c =
        Checkpoints::open(&dir.join("ckpt"), EVERY, Default::default()).expect("checkpoints");
    let queue: Rc<RefCell<Vec<Vec<u8>>>> = Rc::default();
    let q = queue.clone();
    let mut w = World::new();
    w.log = Some(Box::new(move |b: &[u8]| q.borrow_mut().push(b.to_vec())));
    let mut records = 0u64;
    let mut log_bytes = 0u64;
    // Hands what was committed to the log, and takes a checkpoint when the log has grown by the interval.
    let mut flush = |w: &mut World, log: &mut Log<FileStore>, c: &mut Checkpoints| -> bool {
        let mut took = false;
        for b in queue.borrow_mut().drain(..) {
            c.appended(b.len() as u64);
            log_bytes += b.len() as u64;
            log.append(b).expect("appends");
            records += 1;
            if c.due() {
                let v = version(&w.header, w.tree.next());
                c.take(&mut w.tree, v, records, &[0x5e; 32]).expect("takes");
                took = true;
            }
        }
        took
    };
    for _ in 0..100 {
        w.room(10, 90);
        flush(&mut w, &mut log, &mut c);
    }
    let (mut tick, mut ticks) = (0u64, 0u64);
    // The longest tick: taking the world's first checkpoint (every node hashed), taking a later one (only what
    // changed), while one is being written, and the others.
    let mut longest = [Duration::ZERO; 4];
    loop {
        let entries = tick_entries(&mut w, tick);
        let bytes = part_bytes(&w.header, &entries);
        let last = c.stats().taken >= intervals && c.since() + bytes.len() as u64 >= EVERY;
        if last {
            // The next tick would take a checkpoint: stop here, one interval after the last, and leave this tick
            // for the restarted process to run first.
            w.next -= entries.len() as u64;
            std::fs::write(dir.join("next-part"), &bytes).expect("writes");
            break;
        }
        let t0 = Instant::now();
        let s = c.stats();
        let (first, writing) = (s.taken == 0, s.written < s.taken);
        w.commit(entries);
        let took = flush(&mut w, &mut log, &mut c);
        let d = t0.elapsed();
        let slot = match (took, first, writing) {
            (true, true, _) => 0,
            (true, false, _) => 1,
            (false, _, true) => 2,
            _ => 3,
        };
        longest[slot] = longest[slot].max(d);
        tick += 1;
        ticks += 1;
    }
    log.wait_durable(log.durable().max(1)).expect("durable");
    let s = c.wait().expect("written");
    let ckpt_bytes = std::fs::read_dir(dir.join("ckpt"))
        .expect("dir")
        .flatten()
        .map(|e| e.metadata().map_or(0, |m| m.len()))
        .max()
        .unwrap_or(0);
    let (nodes, links) = w.tree.counts();
    println!(
        "ready hashes={} nodes={nodes} links={links} records={records} log_mb={:.1} ckpt_mb={:.2} taken={} ticks={ticks} \
         first_ms={:.2} take_ms={:.2} writing_ms={:.2} other_ms={:.2}",
        hashes(&mut w.tree),
        log_bytes as f64 / 1e6,
        ckpt_bytes as f64 / 1e6,
        s.taken,
        ms(longest[0]),
        ms(longest[1]),
        ms(longest[2]),
        ms(longest[3]),
    );
    // Waits for the kill; the log is durable and the checkpoints on the disk.
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

/// The restarted process: restore, open the log, replay, hash, first tick.
fn restart(dir: &Path) {
    let t0 = Instant::now();
    let header = World::new().header;
    let r = restore(&dir.join("ckpt"))
        .expect("restores")
        .expect("a checkpoint");
    let mut tree = r.tree;
    let t1 = Instant::now();
    let (mut log, found) =
        Log::open(FileStore::open(&dir.join("log")).expect("log"), 1).expect("opens");
    let t2 = Instant::now();
    let replayed = replay(&mut tree, &header, &found.records, r.root.record).expect("replays");
    let t3 = Instant::now();
    let h = hashes(&mut tree);
    let _c = Checkpoints::open(&dir.join("ckpt"), EVERY, r.blobs).expect("checkpoints");
    let t4 = Instant::now();
    let next = std::fs::read(dir.join("next-part")).expect("the next tick");
    tree.apply(&header, &Part::read(&next).expect("a part"))
        .expect("applies");
    log.append(next).expect("appends");
    let t5 = Instant::now();
    println!(
        "tick hashes={h} rejected={} replayed={replayed} restore_ms={:.1} log_open_ms={:.1} replay_ms={:.1} \
         hash_ms={:.1} tick_ms={:.2}",
        r.rejected.len(),
        ms(t1 - t0),
        ms(t2 - t1),
        ms(t3 - t2),
        ms(t4 - t3),
        ms(t5 - t4),
    );
    log.wait_durable(log.durable() + 1).expect("durable");
}

fn field<'a>(line: &'a str, key: &str) -> &'a str {
    line.split(' ')
        .find_map(|kv| kv.strip_prefix(&format!("{key}=")))
        .unwrap_or("?")
}

fn first_line(child: &mut std::process::Child, prefix: &str) -> String {
    let out = child.stdout.take().expect("piped");
    for line in BufReader::new(out).lines() {
        let line = line.expect("a line");
        if line.starts_with(prefix) {
            return line;
        }
    }
    panic!("no {prefix} line");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("run") => return run(Path::new(&args[2]), args[3].parse().expect("intervals")),
        Some("restart") => return restart(Path::new(&args[2])),
        _ => {}
    }
    let me = std::env::current_exe().expect("this program");
    let base = PathBuf::from(args.get(1).map_or("target/restart-bench", String::as_str));
    println!(
        "## A1, A4: restart after one interval and after ten (a checkpoint each {} MiB of log)",
        EVERY >> 20
    );
    println!();
    println!(
        "| intervals | repeat | log MB | checkpoint MB | spawn to first tick | restore | log open | replay (records) \
         | hash | first tick | hashes before kill = after restart |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|");
    let mut a5 = Vec::new();
    for intervals in [1u64, 10] {
        for repeat in 1..=2 {
            let dir = base.join(format!("{intervals}-{repeat}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("dir");
            let mut writer = Command::new(&me)
                .args(["run", dir.to_str().expect("a path"), &intervals.to_string()])
                .stdout(Stdio::piped())
                .spawn()
                .expect("spawns");
            let ready = first_line(&mut writer, "ready");
            writer.kill().expect("killed");
            writer.wait().expect("ended");
            let t0 = Instant::now();
            let mut child = Command::new(&me)
                .args(["restart", dir.to_str().expect("a path")])
                .stdout(Stdio::piped())
                .spawn()
                .expect("spawns");
            let tick = first_line(&mut child, "tick");
            let took = t0.elapsed();
            child.wait().expect("ended");
            let same = field(&ready, "hashes") == field(&tick, "hashes");
            println!(
                "| {intervals} | {repeat} | {} | {} | **{:.0} ms** | {} ms | {} ms | {} ms ({}) | {} ms | {} ms | {} |",
                field(&ready, "log_mb"),
                field(&ready, "ckpt_mb"),
                ms(took),
                field(&tick, "restore_ms"),
                field(&tick, "log_open_ms"),
                field(&tick, "replay_ms"),
                field(&tick, "replayed"),
                field(&tick, "hash_ms"),
                field(&tick, "tick_ms"),
                if same { "yes" } else { "**no**" },
            );
            a5.push((intervals, repeat, ready));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    println!();
    println!(
        "## A5: the longest tick (each tick: {MOVERS} motion samples committed and handed to the log)"
    );
    println!();
    println!(
        "| intervals | repeat | nodes, links | ticks | checkpoints | taking the first (every node hashed) \
         | taking a later one | while one is written | others |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");
    for (intervals, repeat, r) in a5 {
        println!(
            "| {intervals} | {repeat} | {}, {} | {} | {} | {} ms | {} ms | {} ms | {} ms |",
            field(&r, "nodes"),
            field(&r, "links"),
            field(&r, "ticks"),
            field(&r, "taken"),
            field(&r, "first_ms"),
            field(&r, "take_ms"),
            field(&r, "writing_ms"),
            field(&r, "other_ms"),
        );
    }
}
