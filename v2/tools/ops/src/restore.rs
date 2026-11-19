//! `ops restore <root> <even|uneven> <seed>`: one run of O12 (#2807), a world restored from the bucket alone.
//! Runbook: `v2/docs/runbook/restore.md`; the four runs are `v2/tools/ops/o12-restore.sh`.
//!
//! Two world processes on this machine stand in for two machines over one bucket (a folder store, O9's): machine-a
//! (`ops world source`, data in `<root>/a`) serves the benches' world under the scripted agents through the gate, its
//! log shipped by O3's shipper. At a random second from 30 to 60 the conductor kills machine-a (SIGKILL) and deletes
//! its data folder, and the clock starts; nothing reads machine-a again. Machine-b, holding only the build and the
//! bucket, runs the one restore command (`ops world target <root>/b <bucket> <t0> machine-b --restore`): fetch, check,
//! raise the epoch, start. The conductor, in the gateway's role, points the gate at the new epoch and releases what it
//! held. The clock stops at the first new act acknowledged. Then a returning machine-a is played: its record write on
//! the version it last read, its epoch at the gate, and an intent stamped with its epoch at the new writer; each must
//! be refused. One row of the restore table is printed.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};

use archive::{R, Shared, refuse};
use directoryd::directory::store::{Store, When};
use gatewayd::Gate;
use replica::directory::WorldRecord;
use supervisor::folder::Folder;

use crate::load::Load;
use crate::world::{self, unix_us};

/// The kill falls at a random second in this range (s from the start): past the first shipped checkpoint (20 s).
const KILL_LEAST: u64 = 30;
const KILL_MOST: u64 = 60;
/// How long machine-b serves before the run ends (s).
const AFTER: u64 = 20;
/// The bars: serving within 10 minutes of the loss; no lost act acknowledged more than 10 s before it.
const SERVE_BAR_US: u64 = 600_000_000;
const LOSS_BAR_US: u64 = worldd::shipping::LOSS_BAR_US;
/// The returning machine-a's intent.
const STALE_ID: u64 = u64::MAX;

fn io<T>(r: std::io::Result<T>) -> R<T> {
    r.or_else(|e| refuse("io", e.to_string()))
}

enum Msg {
    Line(usize, String),
    Exit(usize),
}

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
}

fn spawn(
    root: &Path,
    ix: usize,
    (role, dir, machine, flag): (&str, &str, &str, &str),
    t0: u64,
    tx: &Sender<Msg>,
) -> R<Proc> {
    let err = io(std::fs::File::create(root.join(format!("{machine}.err"))))?;
    let mut cmd = Command::new(io(std::env::current_exe())?);
    cmd.args(["world", role])
        .arg(root.join(dir))
        .arg(root.join("bucket"))
        .arg(t0.to_string())
        .arg(machine);
    if !flag.is_empty() {
        cmd.arg(flag);
    }
    let mut child = io(cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(err))
        .spawn())?;
    let out = child.stdout.take();
    let tx = tx.clone();
    std::thread::spawn(move || {
        if let Some(out) = out {
            for line in std::io::BufReader::new(out).lines() {
                let Ok(line) = line else { break };
                if tx.send(Msg::Line(ix, line)).is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(Msg::Exit(ix));
    });
    let stdin = child.stdin.take();
    Ok(Proc { child, stdin })
}

fn send(p: &mut Proc, line: &str) {
    if let Some(s) = &mut p.stdin {
        // A dead process's pipe refuses the write; its death arrives as Msg::Exit.
        let _ = writeln!(s, "{line}");
        let _ = s.flush();
    }
}

/// What machine-b said when it restored: records, bytes fetched, fetch/check/claim ms, hashes equal, state hash.
struct Restored {
    records: u64,
    bytes: u64,
    fetch_ms: u64,
    check_ms: u64,
    claim_ms: u64,
    equal: bool,
    hash: String,
}

fn secs(us: u64) -> String {
    format!("{:.2}", us as f64 / 1e6)
}

/// `ops restore <root> <even|uneven> <seed>`.
pub fn run(args: &[String]) -> R<()> {
    let [root, shape, seed] = args else {
        return refuse("usage", "ops restore <root> <even|uneven> <seed>");
    };
    let seed: u64 = seed.parse().or_else(|_| refuse("usage", "a seed"))?;
    let root = PathBuf::from(root);
    let _ = std::fs::remove_dir_all(&root);
    io(std::fs::create_dir_all(&root))?;
    let mut log = io(std::fs::File::create(root.join("conductor.log")))?;
    let bucket = Shared(Arc::new(Folder::new(root.join("bucket"))));
    let ids = world::ids();
    let key = WorldRecord::key(&ids.header.lineage.0, ids.header.zone);
    let mut load = Load::new(shape, seed)?;
    let (tx, rx) = channel();
    let t0 = unix_us();
    // The random second: the wall clock's low digits, never the world's numbers.
    let kill_at = (KILL_LEAST + t0 % (KILL_MOST - KILL_LEAST + 1)) * 1_000_000;
    let mut note = |s: &str| {
        let _ = writeln!(log, "{:.3} {s}", (unix_us() - t0) as f64 / 1e6);
    };
    let mut procs = vec![spawn(&root, 0, ("source", "a", "machine-a", ""), t0, &tx)?];
    note("spawn machine-a");
    let mut gate: Option<Gate> = None;
    let mut writer: Option<usize> = None;
    let (mut a_epoch, mut b_epoch) = (0u64, 0u64);
    let mut a_acks: Vec<(u64, u64)> = Vec::new();
    let mut killed: Option<u64> = None;
    let mut stale: Option<directoryd::directory::store::Object> = None;
    let mut restored: Option<Restored> = None;
    let (mut serving, mut first_act): (Option<u64>, Option<u64>) = (None, None);
    let (mut stale_store, mut stale_gate, mut stale_writer) =
        (None::<bool>, None::<bool>, None::<bool>);
    let mut stop_sent: Option<u64> = None;
    let mut b_acks = 0u64;
    let mut next_id = 0u64;
    loop {
        let now = unix_us();
        let rel = now - t0;
        // --- The agents act through the gate.
        if stop_sent.is_none()
            && let Some(g) = gate.as_mut()
        {
            for agent in load.acting(rel) {
                let id = next_id;
                next_id += 1;
                if let Some(s) = g.submit(id, agent as u32, now)
                    && let Some(w) = writer
                {
                    send(
                        &mut procs[w],
                        &format!("i {} {} {}", s.id, s.agent, s.epoch),
                    );
                }
            }
        }
        // --- The loss: every process of machine-a killed, its data folder deleted. Nothing reads it again.
        if killed.is_none() && writer == Some(0) && rel >= kill_at {
            // The version of the record machine-a last could have read: what a returning machine-a writes on.
            stale = bucket.get(&key)?;
            let _ = procs[0].child.kill();
            let _ = procs[0].child.wait();
            io(std::fs::remove_dir_all(root.join("a")))?;
            let at = unix_us();
            killed = Some(at);
            note("killed machine-a and deleted its data folder");
            if let Some(g) = gate.as_mut() {
                g.writer_died(a_epoch, at);
                g.hold();
            }
            writer = None;
            // Machine-b: the build and the bucket, nothing else. One command.
            procs.push(spawn(
                &root,
                1,
                ("target", "b", "machine-b", "--restore"),
                t0,
                &tx,
            )?);
            note("spawn machine-b --restore");
        }
        // --- A returning machine-a, five seconds after machine-b serves.
        if let Some(s) = serving
            && stale_writer.is_none()
            && stale_gate.is_none()
            && now.saturating_sub(s) > 5_000_000
        {
            stale_store = Some(match &stale {
                Some(o) => matches!(
                    bucket.put(&key, &o.bytes, When::Is(&o.etag)),
                    Err(e) if e.name == "precondition-failed"
                ),
                None => false,
            });
            stale_gate = Some(gate.as_mut().is_some_and(|g| g.point(a_epoch).is_err()));
            send(&mut procs[1], &format!("i {STALE_ID} 0 {a_epoch}"));
            note("a returning machine-a: record write, gate, intent");
        }
        if let Some(s) = serving
            && stop_sent.is_none()
            && now.saturating_sub(s) > AFTER * 1_000_000
        {
            send(&mut procs[1], "stop");
            stop_sent = Some(now);
            note("stop machine-b");
        }
        if stop_sent.is_some_and(|t| now.saturating_sub(t) > 30_000_000)
            || killed.is_some_and(|k| now.saturating_sub(k) > SERVE_BAR_US + 60_000_000)
        {
            note("gave up waiting");
            break;
        }
        // --- What the processes say.
        let Ok(msg) = rx.recv_timeout(std::time::Duration::from_millis(5)) else {
            continue;
        };
        let now = unix_us();
        match msg {
            Msg::Exit(ix) => {
                note(&format!("exit machine-{}", if ix == 0 { "a" } else { "b" }));
                if ix == 1 {
                    break;
                }
            }
            Msg::Line(ix, line) => {
                let f: Vec<&str> = line.split_whitespace().collect();
                match f.as_slice() {
                    ["serving", e, tick] => {
                        let e: u64 = e.parse().unwrap_or(0);
                        note(&format!(
                            "machine-{} serving epoch {e} from tick {tick}",
                            if ix == 0 { "a" } else { "b" }
                        ));
                        if ix == 0 {
                            a_epoch = e;
                            gate = Some(Gate::new(e));
                        } else {
                            b_epoch = e;
                            serving = Some(now);
                            // The gateway is told: it points at the new epoch and releases what it held.
                            if let Some(g) = gate.as_mut() {
                                if let Err(x) = g.point(e) {
                                    note(&x);
                                }
                                for s in g.release() {
                                    send(
                                        &mut procs[1],
                                        &format!("i {} {} {}", s.id, s.agent, s.epoch),
                                    );
                                }
                            }
                        }
                        writer = Some(ix);
                    }
                    ["ack", id, e, record, _] => {
                        let (Ok(id), Ok(e), Ok(record)) =
                            (id.parse::<u64>(), e.parse::<u64>(), record.parse::<u64>())
                        else {
                            continue;
                        };
                        if id == STALE_ID {
                            stale_writer = Some(false);
                            continue;
                        }
                        if let Some(g) = gate.as_mut() {
                            match g.acked(id, e, record, now) {
                                // An acknowledgement read after the kill was written before it.
                                Ok(()) if ix == 0 => {
                                    a_acks.push((record, killed.map_or(now, |k| k.min(now))))
                                }
                                Ok(()) => {
                                    b_acks += 1;
                                    first_act.get_or_insert(now);
                                }
                                Err(x) => note(&format!("gate refused an ack: {x}")),
                            }
                        }
                    }
                    ["refuse", id, name] => {
                        if *id == STALE_ID.to_string() {
                            stale_writer = Some(*name == "epoch-other");
                        } else if let (Some(g), Ok(id)) = (gate.as_mut(), id.parse::<u64>()) {
                            g.refused(id, name, now);
                        }
                    }
                    ["restored", records, bytes, fetch, check, claim, equal, hash] => {
                        note(&line);
                        let n = |s: &str| s.parse::<u64>().unwrap_or(0);
                        restored = Some(Restored {
                            records: n(records),
                            bytes: n(bytes),
                            fetch_ms: n(fetch),
                            check_ms: n(check),
                            claim_ms: n(claim),
                            equal: *equal == "true",
                            hash: (*hash).to_owned(),
                        });
                    }
                    ["stopped"] => {
                        note("machine-b stopped");
                        if ix == 1 {
                            break;
                        }
                    }
                    ["tick", _] | ["caught", ..] => {}
                    _ => note(&format!(
                        "machine-{}: {line}",
                        if ix == 0 { "a" } else { "b" }
                    )),
                }
            }
        }
    }
    for p in &mut procs {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    // --- The row.
    let Some(k) = killed else {
        return refuse("never-killed", "machine-a never served");
    };
    let Some(r) = restored else {
        let err = std::fs::read_to_string(root.join("machine-b.err")).unwrap_or_default();
        return refuse("never-restored", err.replace('\n', " "));
    };
    let lost: Vec<&(u64, u64)> = a_acks.iter().filter(|a| a.0 >= r.records).collect();
    let window = lost.iter().map(|a| k - a.1).max().unwrap_or(0);
    let archive: u64 = bucket
        .0
        .keys("")
        .iter()
        .filter_map(|key| std::fs::metadata(root.join("bucket").join(key)).ok())
        .map(|m| m.len())
        .sum();
    let serve = first_act.map(|t| t - k);
    let stale_all = [stale_store, stale_gate, stale_writer]
        .iter()
        .all(|s| *s == Some(true));
    let ok =
        serve.is_some_and(|s| s <= SERVE_BAR_US) && window <= LOSS_BAR_US && r.equal && stale_all;
    let yes = |b: Option<bool>| match b {
        Some(true) => "refused",
        Some(false) => "ACCEPTED",
        None => "not tried",
    };
    println!(
        "| {shape} | {seed} | {} | {} | {} | {} | {} | {} | none: this world writes no stream | {} | {} | {} acked, {} lost | {} | {} | {archive} | epoch {a_epoch} to {b_epoch}: record {}, gate {}, writer {} | {} |",
        secs(k - t0),
        secs(r.fetch_ms * 1000),
        secs(r.check_ms * 1000),
        secs(r.claim_ms * 1000),
        serving.map_or("never".into(), |s| secs(s - k)),
        serve.map_or("never".into(), secs),
        r.bytes,
        r.records,
        a_acks.len() + b_acks as usize,
        lost.len(),
        secs(window),
        if r.equal { "EQUAL" } else { "DIFFER" },
        yes(stale_store),
        yes(stale_gate),
        yes(stale_writer),
        if ok { "MET" } else { "UNMET" },
    );
    println!("state hash at record {}: {}", r.records, r.hash);
    if !ok {
        return refuse("restore-unmet", "see the row");
    }
    Ok(())
}
