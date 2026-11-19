//! replay-compare (Engine v2 K12, #2675): one build, one checkpoint and one recording of inputs write the same log
//! every time; on a mismatch, the first differing record.
//!
//! ```text
//! replay-compare record <dir> [minutes]          the checkpoint (<dir>/ckpt) and a seeded input recording
//!                                                (<dir>/recording.log) of `minutes` under load (default 10)
//! replay-compare run <dir> <out> [--jitter] [--diverge-at <tick>]
//!                                                one run: restore, feed the recording to the clock thread, write
//!                                                <out>/run.log (inputs and effects), print its hash
//! replay-compare compare <dir> [--diverge-at <tick>]
//!                                                three runs in three processes at once, the third with random delays
//!                                                in its feeding thread (and the seeded divergence, if asked); the
//!                                                three hashes, then "same" or the first differing record (exit 1)
//! ```
//!
//! The clock thread is the run's main thread: it alone steps the world. A feeding thread hands it each tick's inputs
//! over a channel, as intents and edits arrive from outside, and the log's writer thread writes and syncs; with
//! `--jitter` the feeding thread sleeps at random. The hash covers effect records only (`sim::recorder`); times
//! printed are measures and are in no hashed byte. `--diverge-at` seeds a divergence: births at that tick draw
//! their place with the wrong counter.

// The tool times its runs and draws its jitter from the process's own randomness: measures, never in the log.
#![allow(clippy::disallowed_methods)]

mod world;

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc::sync_channel;
use std::time::{Duration, Instant};

use replica::effects::{Part, Refusal};
use replica::encode::to_hex;
use replica::ids::{Scope, Version};
use sim::checkpoint::{Blobs, Checkpoints, restore};
use sim::log::{FileStore, Log, recover};
use sim::recorder::{self, Difference, effect_hash, first_difference};

use world::{World, header, script, start};

/// The world's seed, kept in its checkpoint, and the script's, apart from it.
const WORLD_SEED: &[u8] = b"k12-world-seed";
const SCRIPT_SEED: &[u8] = b"k12-script-seed";

type R<T> = Result<T, Refusal>;

fn io(what: &Path) -> impl Fn(std::io::Error) -> Refusal + '_ {
    move |e| Refusal {
        name: "io",
        detail: format!("{}: {e}", what.display()),
    }
}

fn fresh_log(path: &Path) -> R<Log<FileStore>> {
    let _ = std::fs::remove_file(path);
    Ok(Log::open(FileStore::open(path)?, 1)?.0)
}

fn read_log(path: &Path) -> R<Vec<Vec<u8>>> {
    Ok(recover(&std::fs::read(path).map_err(io(path))?)?.records)
}

/// `record`: the checkpoint, then the seeded recording, as input records in a log of its own.
fn record(dir: &Path, minutes: u64) -> R<()> {
    let ckpt = dir.join("ckpt");
    let _ = std::fs::remove_dir_all(&ckpt);
    std::fs::create_dir_all(&ckpt).map_err(io(&ckpt))?;
    let h = header();
    let mut tree = start(&h);
    let mut c = Checkpoints::open(&ckpt, 1, Blobs::default())?;
    let v = Version {
        lineage: Scope(h.lineage.0),
        zone: h.zone,
        epoch: 1,
        sequence: tree.next(),
    };
    c.take(&mut tree, v, 0, WORLD_SEED)?;
    c.wait()?;
    let path = dir.join("recording.log");
    let mut log = fresh_log(&path)?;
    let (mut ticks, mut inputs) = (0, 0);
    for (tick, i) in script(minutes, SCRIPT_SEED) {
        recorder::append(&mut log, tick, &i)?;
        ticks += 1;
        inputs += i.len();
    }
    log.wait_durable(ticks)?;
    log.close();
    println!(
        "recorded {minutes} min: {ticks} ticks with inputs, {inputs} inputs ({:.0} a minute), to {}",
        inputs as f64 / minutes as f64,
        path.display()
    );
    Ok(())
}

/// The process's own randomness, for the jitter (a new seed in each process).
fn jitter_source() -> impl FnMut() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let s = std::collections::hash_map::RandomState::new();
    let mut n = 0u64;
    move || {
        n += 1;
        let mut h = s.build_hasher();
        h.write_u64(n);
        h.finish()
    }
}

/// `run`: restore the checkpoint, feed the recording to the clock thread, write the run's log, print its hash.
fn run(dir: &Path, out: &Path, jitter: bool, diverge_at: Option<u64>) -> R<()> {
    let began = Instant::now();
    let restored = restore(&dir.join("ckpt"))?.ok_or_else(|| Refusal {
        name: "checkpoint-none",
        detail: "no checkpoint: run `record` first".into(),
    })?;
    let recording = recorder::inputs(&read_log(&dir.join("recording.log"))?)?;
    let mut world = World::new(header(), restored.tree, &restored.root.seed);
    world.diverge_at = diverge_at;
    std::fs::create_dir_all(out).map_err(io(out))?;
    let path = out.join("run.log");
    let mut log = fresh_log(&path)?;

    let (tx, rx) = sync_channel(64);
    let feeder = std::thread::Builder::new()
        .name("feeder".into())
        .spawn(move || {
            let mut rnd = jitter_source();
            let mut slept = Duration::ZERO;
            for t in recording {
                if jitter && rnd().is_multiple_of(8) {
                    let d = Duration::from_micros(rnd() % 400);
                    std::thread::sleep(d);
                    slept += d;
                }
                if tx.send(t).is_err() {
                    break;
                }
            }
            slept
        })
        .map_err(|e| Refusal {
            name: "thread",
            detail: e.to_string(),
        })?;
    let mut records = 0;
    for (tick, inputs) in rx {
        if recorder::append(&mut log, tick, &inputs)?.is_some() {
            records += 1;
        }
        if let Some(part) = world.step(tick, &inputs)? {
            log.append(part)?;
            records += 1;
        }
    }
    let slept = feeder.join().expect("the feeder");
    log.wait_durable(records)?;
    log.close();
    let records = read_log(&path)?;
    println!(
        "hash {} records {} effects {} jitter {} ({} ms slept) took {} ms",
        to_hex(&effect_hash(&records)),
        records.len(),
        records.iter().filter(|r| !recorder::is_input(r)).count(),
        if jitter { "on" } else { "off" },
        slept.as_millis(),
        began.elapsed().as_millis()
    );
    Ok(())
}

/// The first differing effect inside two differing parts, shown whole.
fn show(d: &Difference, names: [&str; 2]) {
    println!(
        "first differing record: effect record {} (log record {} in {}, {} in {}), after the inputs of tick {:?}",
        d.effect, d.records[0], names[0], d.records[1], names[1], d.ticks[0]
    );
    let parts: Vec<Option<Part>> = d
        .bytes
        .iter()
        .map(|b| b.as_ref().and_then(|b| Part::read(b).ok()))
        .collect();
    match (&parts[0], &parts[1]) {
        (Some(a), Some(b)) => {
            let i = (0..a.effects.len().max(b.effects.len()))
                .find(|&i| a.effects.get(i) != b.effects.get(i))
                .unwrap_or(0);
            println!("  its effect {i}:");
            println!("  {}: {:?}", names[0], a.effects.get(i));
            println!("  {}: {:?}", names[1], b.effects.get(i));
        }
        _ => {
            for (n, b) in names.iter().zip(&d.bytes) {
                println!(
                    "  {n}: {}",
                    b.as_ref().map_or("(the log ends)".into(), |b| to_hex(b))
                );
            }
        }
    }
}

/// `compare`: three runs in three processes at once; their hashes; the first differing record, if any.
fn compare(dir: &Path, diverge_at: Option<u64>) -> R<bool> {
    let exe = std::env::current_exe().map_err(io(dir))?;
    let runs: Vec<(PathBuf, Vec<String>)> = (1..=3)
        .map(|n| {
            let out = dir.join(format!("run-{n}"));
            let mut args = vec![
                "run".into(),
                dir.display().to_string(),
                out.display().to_string(),
            ];
            if n == 3 {
                args.push("--jitter".into());
                if let Some(t) = diverge_at {
                    args.extend(["--diverge-at".into(), t.to_string()]);
                }
            }
            (out, args)
        })
        .collect();
    let children = runs
        .iter()
        .map(|(_, args)| {
            Command::new(&exe)
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
        })
        .collect::<Vec<_>>();
    let mut logs = Vec::new();
    for ((out, _), child) in runs.iter().zip(children) {
        let o = child.and_then(|c| c.wait_with_output()).map_err(io(&exe))?;
        print!("{}: {}", out.display(), String::from_utf8_lossy(&o.stdout));
        if !o.status.success() {
            return Err(Refusal {
                name: "run-failed",
                detail: String::from_utf8_lossy(&o.stderr).into_owned(),
            });
        }
        logs.push(read_log(&out.join("run.log"))?);
    }
    let names = ["run-1", "run-2", "run-3"];
    let mut same = true;
    for (i, j) in [(0, 1), (0, 2)] {
        if let Some(d) = first_difference(&logs[i], &logs[j]) {
            same = false;
            show(&d, [names[i], names[j]]);
        }
    }
    println!(
        "{}",
        if same {
            "same: three processes, one log hash"
        } else {
            "DIFFERENT"
        }
    );
    Ok(same)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let value = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .and_then(|v| v.parse::<u64>().ok())
    };
    let out = match args.first().map(String::as_str) {
        Some("record") if args.len() >= 2 => record(
            Path::new(&args[1]),
            args.get(2).and_then(|m| m.parse().ok()).unwrap_or(10),
        )
        .map(|_| true),
        Some("run") if args.len() >= 3 => run(
            Path::new(&args[1]),
            Path::new(&args[2]),
            flag("--jitter"),
            value("--diverge-at"),
        )
        .map(|_| true),
        Some("compare") if args.len() >= 2 => compare(Path::new(&args[1]), value("--diverge-at")),
        _ => {
            eprintln!(
                "usage: replay-compare record <dir> [minutes] | run <dir> <out> [--jitter] [--diverge-at <tick>] | compare <dir> [--diverge-at <tick>]"
            );
            return ExitCode::from(2);
        }
    };
    match out {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(1)
        }
    }
}
