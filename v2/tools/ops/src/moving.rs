//! `ops move`: one live move (O9, #2828) under 1,000 scripted agents, the conductor in the role of the supervisor
//! and the gateway. Two world processes (`ops world`) on this machine stand in for two machines: machine-a (the
//! source, data in `<root>/a`) and machine-b (the target, `<root>/b`), over one bucket, a folder store with a
//! cross-process lock (`<root>/bucket`) that holds the directory record and the shipped log.
//!
//! The source starts, the agents act through the gate for `MOVE_AT` seconds, then the four steps of
//! `supervisor::moving` run, and the agents go on until `RUN` seconds. With `--kill <side>:<step>` that side's process
//! is killed (SIGKILL) as the step starts, and the conductor recovers as the supervisor does: the record's claim in
//! force says who owns the world, and the owner is restarted if it died. The row printed checks the gate's ledger
//! against the bucket, the ticks both processes ran, and the directory's history against the bucket's names.

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use archive::script::TICK;
use archive::{R, Shared, refuse};
use directoryd::directory::store::Store;
use gatewayd::{End, Gate};
use replica::directory::WorldRecord;
use replica::encode::Name;
use supervisor::folder::Folder;
use supervisor::moving::{self, Sealed, Side, Step};

use crate::load::Load;
use crate::world::{self, pieces_from, unix_us};

/// When the move starts, and when the run ends (s from the start). The first checkpoint ships 20 s in (O3).
const MOVE_AT: u64 = 30;
const RUN: u64 = 50;
/// The bars: acts pause under 5 s; the world serves within 10 s of a kill.
const PAUSE_BAR_US: u64 = 5_000_000;
const SERVE_BAR_US: u64 = 10_000_000;

fn io<T>(r: std::io::Result<T>) -> R<T> {
    r.or_else(|e| refuse("io", e.to_string()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Before,
    Preparing,
    Draining,
    Fencing,
    Starting,
    After,
}

enum Msg {
    Line(usize, String),
    Exit(usize),
}

/// A world process: its side, its stdin, whether it lives, and the epoch it claimed.
struct Proc {
    side: Side,
    child: Child,
    stdin: Option<ChildStdin>,
    alive: bool,
    epoch: u64,
    drained: bool,
}

struct Conductor {
    root: PathBuf,
    t0: u64,
    procs: Vec<Proc>,
    tx: Sender<Msg>,
    log: std::fs::File,
}

impl Conductor {
    fn spawn(&mut self, side: Side, restart: bool) -> R<usize> {
        let (role, dir, machine) = match side {
            Side::Source => ("source", "a", "machine-a"),
            Side::Target => ("target", "b", "machine-b"),
        };
        let err = io(std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join(format!("{role}.err"))))?;
        let mut cmd = Command::new(io(std::env::current_exe())?);
        cmd.arg("world")
            .arg(role)
            .arg(self.root.join(dir))
            .arg(self.root.join("bucket"))
            .arg(self.t0.to_string())
            .arg(machine);
        if restart {
            cmd.arg("--restart");
        }
        let mut child = io(cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(err))
            .spawn())?;
        let ix = self.procs.len();
        let stdout = child.stdout.take();
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            if let Some(out) = stdout {
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
        self.procs.push(Proc {
            side,
            child,
            stdin,
            alive: true,
            epoch: 0,
            drained: false,
        });
        self.note(&format!(
            "spawn {role} #{ix}{}",
            if restart { " (restart)" } else { "" }
        ));
        Ok(ix)
    }

    fn send(&mut self, ix: usize, line: &str) {
        if let Some(s) = &mut self.procs[ix].stdin {
            // A dead process's pipe refuses the write; its death arrives as Msg::Exit.
            let _ = writeln!(s, "{line}");
            let _ = s.flush();
        }
    }

    fn kill(&mut self, ix: usize) {
        let _ = self.procs[ix].child.kill();
        self.note(&format!("kill #{ix} ({:?})", self.procs[ix].side));
    }

    fn note(&mut self, s: &str) {
        let _ = writeln!(self.log, "{} {s}", (unix_us() - self.t0) / 1000);
    }

    /// The live process of `side`, if any.
    fn live(&self, side: Side) -> Option<usize> {
        (0..self.procs.len())
            .rev()
            .find(|&i| self.procs[i].side == side && self.procs[i].alive)
    }
}

/// An acknowledgement: intent, agent, epoch, record, tick.
struct Ack {
    agent: u32,
    epoch: u64,
    record: u64,
    tick: u64,
}

/// `ops move <root> <even|uneven> <seed> [--kill <side>:<step>]`.
pub fn run(args: &[String]) -> R<()> {
    let [root, shape, seed, rest @ ..] = args else {
        return refuse(
            "usage",
            "ops move <root> <even|uneven> <seed> [--kill <source|target>:<step>]",
        );
    };
    let seed: u64 = seed.parse().or_else(|_| refuse("usage", "a seed"))?;
    let kill = match rest {
        [k, spec] if k == "--kill" => {
            let (s, t) = spec.split_once(':').unwrap_or(("", ""));
            let side = match s {
                "source" => Side::Source,
                "target" => Side::Target,
                _ => return refuse("usage", "--kill source|target:<step>"),
            };
            Some((
                side,
                Step::parse(t)
                    .ok_or_else(|| world::err("usage", "a step: prepare, drain, fence, resume"))?,
            ))
        }
        [] => None,
        _ => return refuse("usage", "--kill source|target:<step>"),
    };
    let root = PathBuf::from(root);
    let _ = std::fs::remove_dir_all(&root);
    io(std::fs::create_dir_all(&root))?;
    let (tx, rx): (Sender<Msg>, Receiver<Msg>) = channel();
    let t0 = unix_us();
    let mut c = Conductor {
        root: root.clone(),
        t0,
        procs: Vec::new(),
        tx,
        log: io(std::fs::File::create(root.join("conductor.log")))?,
    };
    let bucket = Shared(Arc::new(Folder::new(root.join("bucket"))));
    let ids = world::ids();
    let (lineage, zone) = (ids.header.lineage.0, ids.header.zone);
    let target_machine = Name::new("machine-b").unwrap_or_else(|| unreachable!("a name"));
    let mut load = Load::new(shape, seed)?;
    let mut gate: Option<Gate> = None;
    let mut phase = Phase::Before;
    let mut writer: Option<usize> = None;
    let mut source_epoch = 0u64;
    let mut sealed: Option<Sealed> = None;
    let mut abort = false;
    let mut killed_at: Option<u64> = None;
    let (mut hold_at, mut release_at) = (None::<u64>, None::<u64>);
    let mut acks: BTreeMap<u64, Ack> = BTreeMap::new();
    let mut ack_times: Vec<(u64, u64)> = Vec::new();
    let mut ticks: BTreeMap<u64, Vec<Side>> = BTreeMap::new();
    let mut claims: Vec<(u64, u32, Side)> = Vec::new();
    let mut caught: Option<(u64, u64)> = None;
    let mut first_target_tick: Option<u64> = None;
    let mut next_id = 0u64;
    let mut stopping: Option<u64> = None;
    let mut stop_sent_at: Option<u64> = None;
    let mut log_lines: Vec<String> = Vec::new();
    c.spawn(Side::Source, false)?;

    let check_kill = |c: &mut Conductor, step: Step, killed_at: &mut Option<u64>| {
        if let Some((side, s)) = kill
            && s == step
            && let Some(ix) = c.live(side)
        {
            c.kill(ix);
            *killed_at = Some(unix_us());
        }
    };

    loop {
        let now = unix_us();
        let rel = now - t0;
        // --- The agents act through the gate.
        if gate.is_some() && stopping.is_none() {
            for agent in load.acting(rel) {
                let id = next_id;
                next_id += 1;
                let Some(g) = gate.as_mut() else { break };
                if let Some(s) = g.submit(id, agent as u32, now)
                    && let Some(w) = writer
                {
                    c.send(w, &format!("i {} {} {}", s.id, s.agent, s.epoch));
                }
            }
        }
        // --- The move starts.
        if phase == Phase::Before && rel >= MOVE_AT * 1_000_000 && writer.is_some() {
            let t = c.spawn(Side::Target, false)?;
            c.send(t, "prepare");
            phase = Phase::Preparing;
            c.note("step prepare");
            check_kill(&mut c, Step::Prepare, &mut killed_at);
        }
        // --- The run ends: no new intents; wait for the open ones, then stop the writer.
        if stopping.is_none() && rel >= RUN * 1_000_000 && phase == Phase::After {
            stopping = Some(now);
        }
        if let (Some(t), None) = (stopping, stop_sent_at) {
            let open = gate.as_ref().map_or(0, Gate::open);
            if (open == 0 || now - t > 5_000_000)
                && let Some(w) = writer
            {
                c.send(w, "stop");
                stop_sent_at = Some(now);
                c.note("stop");
            }
        }
        if stop_sent_at.is_some_and(|t| now - t > 30_000_000) || rel > (RUN + 120) * 1_000_000 {
            c.note("gave up waiting");
            break;
        }
        // --- What the processes say.
        let msg = match rx.recv_timeout(std::time::Duration::from_millis(5)) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let now = unix_us();
        match msg {
            Msg::Exit(ix) => {
                if !c.procs[ix].alive {
                    continue;
                }
                c.procs[ix].alive = false;
                let side = c.procs[ix].side;
                let epoch = c.procs[ix].epoch;
                c.note(&format!("exit #{ix} {side:?} epoch {epoch}"));
                if stop_sent_at.is_some() && writer == Some(ix) {
                    break;
                }
                if let Some(g) = gate.as_mut() {
                    g.writer_died(epoch, now);
                    // Requests wait while no one serves.
                    if writer == Some(ix) {
                        g.hold();
                        hold_at.get_or_insert(now);
                    }
                }
                if writer == Some(ix) {
                    writer = None;
                }
                // The supervisor's decision: the record's claim in force names the owner.
                match (side, phase) {
                    (Side::Source, Phase::Preparing | Phase::Draining) => {
                        if let Some(t) = c.live(Side::Target) {
                            c.send(t, "stop");
                        }
                        phase = Phase::After;
                        c.spawn(Side::Source, true)?;
                    }
                    // The fence in flight decides: fenced, the target goes on; unfenced, the source restarts.
                    (Side::Source, Phase::Fencing) => {}
                    (Side::Source, _) => {}
                    (Side::Target, Phase::Preparing | Phase::Draining) => {
                        phase = Phase::After;
                        abort = true;
                        if let Some(s) = c.live(Side::Source)
                            && c.procs[s].drained
                        {
                            c.send(s, "resume");
                        }
                    }
                    (Side::Target, Phase::Fencing | Phase::Starting) => {
                        let (owner, e) =
                            moving::owner(&bucket, &lineage, zone, source_epoch, &target_machine)?;
                        c.note(&format!("owner after the kill: {owner:?} epoch {e}"));
                        phase = Phase::After;
                        match owner {
                            Side::Target => {
                                c.spawn(Side::Target, true)?;
                            }
                            Side::Source => {
                                abort = true;
                                if let Some(s) = c.live(Side::Source) {
                                    c.send(s, "resume");
                                } else {
                                    c.spawn(Side::Source, true)?;
                                }
                            }
                        }
                    }
                    (Side::Target, _) => {}
                }
            }
            Msg::Line(ix, line) => {
                let f: Vec<&str> = line.split_whitespace().collect();
                let side = c.procs[ix].side;
                match f.as_slice() {
                    ["tick", n] => {
                        if let Ok(n) = n.parse::<u64>() {
                            if side == Side::Target {
                                first_target_tick.get_or_insert(n);
                            }
                            ticks.entry(n).or_default().push(side);
                        }
                    }
                    ["ack", id, e, record, tick] => {
                        let (Ok(id), Ok(e), Ok(record), Ok(tick)) = (
                            id.parse::<u64>(),
                            e.parse::<u64>(),
                            record.parse::<u64>(),
                            tick.parse::<u64>(),
                        ) else {
                            continue;
                        };
                        if let Some(g) = gate.as_mut() {
                            match g.acked(id, e, record, now) {
                                Ok(()) => {
                                    let agent = g.ledger[&id].agent;
                                    acks.insert(
                                        id,
                                        Ack {
                                            agent,
                                            epoch: e,
                                            record,
                                            tick,
                                        },
                                    );
                                    ack_times.push((now, e));
                                }
                                Err(e) => log_lines.push(format!("gate refused an ack: {e}")),
                            }
                        }
                    }
                    ["refuse", id, name] => {
                        if let (Some(g), Ok(id)) = (gate.as_mut(), id.parse::<u64>()) {
                            g.refused(id, name, now);
                        }
                    }
                    ["claimed", e, pid] => {
                        let e = e.parse().unwrap_or(0);
                        c.procs[ix].epoch = e;
                        claims.push((e, pid.parse().unwrap_or(0), side));
                        c.note(&format!("claimed epoch {e} by #{ix} {side:?}"));
                    }
                    ["serving", e, tick] => {
                        let e: u64 = e.parse().unwrap_or(0);
                        c.note(&format!(
                            "serving epoch {e} from tick {tick} by #{ix} {side:?}"
                        ));
                        c.procs[ix].drained = false;
                        if gate.is_none() {
                            gate = Some(Gate::new(e));
                            source_epoch = e;
                        }
                        writer = Some(ix);
                        if let Some(g) = gate.as_mut() {
                            if let Err(e) = g.point(e) {
                                log_lines.push(e);
                            }
                            let sends = g.release();
                            for s in sends {
                                c.send(ix, &format!("i {} {} {}", s.id, s.agent, s.epoch));
                            }
                        }
                        if hold_at.is_some() && release_at.is_none() {
                            release_at = Some(now);
                        }
                        if phase == Phase::Starting {
                            phase = Phase::After;
                        }
                    }
                    ["prepared", rec, ms] => {
                        c.note(&format!("prepared through record {rec} in {ms} ms"));
                        if phase == Phase::Preparing
                            && let Some(s) = c.live(Side::Source)
                        {
                            if let Some(g) = gate.as_mut() {
                                g.hold();
                            }
                            hold_at = Some(now);
                            c.send(s, "drain");
                            phase = Phase::Draining;
                            c.note("step drain");
                            check_kill(&mut c, Step::Drain, &mut killed_at);
                        }
                    }
                    ["drained", rest @ ..] => {
                        c.procs[ix].drained = true;
                        let s = Sealed::parse(rest);
                        c.note(&format!("drained {}", rest.join(" ")));
                        if abort || phase != Phase::Draining {
                            c.send(ix, "resume");
                        } else if let (Some(s), Some(t)) = (s, c.live(Side::Target)) {
                            c.send(t, &format!("fence {} {}", s.line(), c.procs[ix].epoch));
                            sealed = Some(s);
                            phase = Phase::Fencing;
                            c.note("step fence");
                            check_kill(&mut c, Step::Fence, &mut killed_at);
                        }
                    }
                    ["fenced", e, ms] => {
                        c.note(&format!("fenced epoch {e} in {ms} ms"));
                        if let Some(s) = c.live(Side::Source) {
                            c.send(s, "stop");
                        }
                        c.send(ix, "start");
                        phase = Phase::Starting;
                        c.note("step resume");
                        check_kill(&mut c, Step::Resume, &mut killed_at);
                    }
                    ["unfenced", ..] => {
                        c.note(&line);
                        abort = true;
                        phase = Phase::After;
                        c.send(ix, "stop");
                        match c.live(Side::Source) {
                            Some(s) => c.send(s, "resume"),
                            None => {
                                c.spawn(Side::Source, true)?;
                            }
                        }
                    }
                    ["caught", owed, ms] if side == Side::Target => {
                        caught = Some((owed.parse().unwrap_or(0), ms.parse().unwrap_or(0)));
                    }
                    ["stopped"] => {
                        c.note(&format!("stopped #{ix}"));
                        c.procs[ix].alive = false;
                        if writer == Some(ix) && stop_sent_at.is_some() {
                            break;
                        }
                    }
                    _ => log_lines.push(format!("#{ix}: {line}")),
                }
            }
        }
    }
    for ix in 0..c.procs.len() {
        let _ = c.procs[ix].child.wait_timeout_or_kill();
    }
    // --- The checks.
    let gate = gate.ok_or_else(|| world::err("never-served", "the source never served"))?;
    let rec = match bucket.get(&WorldRecord::key(&lineage, zone))? {
        Some(o) => WorldRecord::read(&o.bytes)?,
        None => return refuse("record-missing", "no directory record"),
    };
    let keys = bucket.0.keys("part/");
    let history = moving::history(&rec, &keys);
    let chain = pieces_from(&bucket, &rec, 0)?;
    let mut by_record: BTreeMap<u64, &Vec<u8>> = BTreeMap::new();
    for p in &chain {
        for (i, b) in p.records.iter().enumerate() {
            by_record.insert(p.first + i as u64, b);
        }
    }
    let mut missing = 0u64;
    for a in acks.values() {
        let body = ids.bodies[a.agent as usize];
        let at = a.tick as i64 * TICK;
        let found = by_record
            .get(&a.record)
            .and_then(|b| replica::effects::Part::read(b).ok())
            .is_some_and(|p| {
                p.effects
                    .iter()
                    .any(|e| e.envelope.node == body && e.envelope.at == at)
            });
        if !found {
            missing += 1;
        }
    }
    let mut ends: BTreeMap<String, u64> = BTreeMap::new();
    let (mut held, mut held_wait) = (0u64, 0u64);
    for e in gate.ledger.values() {
        let name = match &e.end {
            Some(End::Acked { .. }) => "acked".to_owned(),
            Some(End::Refused { name, .. }) => name.clone(),
            None => "open".to_owned(),
        };
        *ends.entry(name).or_default() += 1;
        if e.held {
            held += 1;
            if let Some(End::Acked { at, .. }) = &e.end {
                held_wait = held_wait.max(at - e.submitted);
            }
        }
    }
    ack_times.sort_unstable();
    let gap = ack_times
        .windows(2)
        .map(|w| w[1].0 - w[0].0)
        .max()
        .unwrap_or(0);
    let dup = ticks.values().filter(|v| v.len() > 1).count();
    let last_tick = ticks.keys().next_back().copied().unwrap_or(0);
    let skipped = (0..=last_tick).filter(|t| !ticks.contains_key(t)).count();
    let stop_tick = stop_sent_at.map_or(0, |t| (t - t0) / TICK as u64);
    let src_acks = acks.values().filter(|a| a.epoch == source_epoch).count();
    let tgt_acks = acks.len() - src_acks;
    let one_claimant = {
        let mut seen = BTreeMap::new();
        claims
            .iter()
            .all(|(e, pid, _)| *seen.entry(*e).or_insert(*pid) == *pid)
    };
    let hist = match &history {
        Ok(h) => h
            .iter()
            .map(|e| {
                format!(
                    "{} {} from {} ({} pieces)",
                    e.epoch, e.machine, e.from, e.pieces
                )
            })
            .collect::<Vec<_>>()
            .join("; "),
        Err(e) => format!("BROKEN: {e}"),
    };
    let a5 = history.is_ok() && one_claimant;
    let open = ends.get("open").copied().unwrap_or(0);
    let ends_s = ends
        .iter()
        .map(|(k, v)| format!("{k} {v}"))
        .collect::<Vec<_>>()
        .join(", ");
    for l in &log_lines {
        c.note(l);
    }
    match kill {
        None => {
            let s = sealed.clone();
            let continuous = s
                .as_ref()
                .is_some_and(|s| first_target_tick == Some(s.tick + 1));
            let (owed, owed_ms) = caught.unwrap_or((0, 0));
            let lag = stop_tick.saturating_sub(last_tick);
            let pause_ok = held_wait < PAUSE_BAR_US && gap < PAUSE_BAR_US;
            let ledger_ok = missing == 0 && open == 0 && tgt_acks > 0;
            let ticks_ok = dup == 0 && skipped == 0 && continuous && lag <= 2;
            let ok = pause_ok && ledger_ok && ticks_ok && a5;
            println!(
                "| {shape} | {seed} | {} | {held} | {:.2} | {:.2} | {src_acks} + {tgt_acks} | {missing} | {ends_s} | {} | {} at record {} | {owed} in {owed_ms} ms | 0 to {last_tick}: {dup} repeated, {skipped} skipped; lag {lag} | {hist} | {} |",
                gate.ledger.len(),
                held_wait as f64 / 1e6,
                gap as f64 / 1e6,
                hold_at.zip(release_at).map_or("-".into(), |(h, r)| format!(
                    "{:.2} s",
                    (r - h) as f64 / 1e6
                )),
                s.as_ref()
                    .map_or("-".into(), |s| format!("tick {}", s.tick)),
                s.as_ref().map_or(0, |s| s.records),
                if ok { "MET" } else { "UNMET" },
            );
            if !ok {
                return refuse("move-unmet", "see the row");
            }
        }
        Some((side, step)) => {
            let current = rec.current();
            let owner = current.map_or("-".into(), |t| {
                format!("{} epoch {}", t.machine.as_str(), t.epoch)
            });
            // Serving again: the first acknowledgement after the kill from the epoch the record names at the end
            // (an acknowledgement the dead process wrote before it died does not count).
            let serve_us = killed_at.and_then(|k| {
                ack_times
                    .iter()
                    .find(|(at, e)| *at > k && current.is_some_and(|t| t.epoch == *e))
                    .map(|(at, _)| at - k)
            });
            let served_by_owner = acks
                .values()
                .last()
                .is_some_and(|a| current.is_some_and(|t| t.epoch == a.epoch));
            let ok = serve_us.is_some_and(|s| s < SERVE_BAR_US)
                && served_by_owner
                && a5
                && missing == 0
                && open == 0;
            println!(
                "| {side:?} at {} | {shape} | {owner} | {} | {missing} | {ends_s} | {hist} | {} |",
                step.name(),
                serve_us.map_or("never".into(), |s| format!("{:.2} s", s as f64 / 1e6)),
                if ok { "MET" } else { "UNMET" },
            );
            if !ok {
                return refuse("kill-unmet", "see the row");
            }
        }
    }
    Ok(())
}

trait WaitOrKill {
    fn wait_timeout_or_kill(&mut self) -> std::io::Result<()>;
}

impl WaitOrKill for Child {
    /// Waits up to 10 s for the process to exit, then kills it.
    fn wait_timeout_or_kill(&mut self) -> std::io::Result<()> {
        for _ in 0..200 {
            if self.try_wait()?.is_some() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        self.kill()?;
        self.wait().map(|_| ())
    }
}
