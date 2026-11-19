//! Deploy and roll back one world (Engine v2 O7, #2804): a new build reaches one world at a time, and a bad one is
//! taken back by the machine. Runbook: `v2/docs/runbook/deploy-and-roll-back.md`.
//!
//! 1. **Rehearse** ([`rehearse`]): on a scratch copy of the world's log, never the served one, the new build starts
//!    from the log as it stood `window` records ago and is fed the intents those records took (the recorded inputs,
//!    I4's [`ANSWERED`] rows). It passes when it starts, gives every fed intent a named end and gives the probe act a
//!    receipt. Invariants, not hashes: two builds fed the same inputs need not write the same bytes.
//! 2. **Canary** ([`watch`]): the world's pin is set to the new build (one conditional write, W8) and the world is
//!    restarted. It must serve within `start_within` and give the probe act a receipt within `answer_within`, every
//!    `every`, for `window`. The first miss is a fault, by name: `canary.not-serving`, `canary.unanswered`,
//!    `canary.refused` (with the world's reason).
//! 3. **Roll back** ([`roll_back`]): code rolls back, data never. If the new build wrote any record, the old build
//!    must read every schema the new one writes (T6), or the rollback is refused `rollback.schema-unread` and the
//!    world keeps running what it runs. Otherwise the pin goes back and the world is restarted.
//!
//! A build's folder is `builds/<hash>/`; it is started as the launcher starts it, `worldd --dir <state>`, and
//! `worldd schemas` prints `reads <hash>` and `writes <hash>` lines. The served log is `<state>/world.log`, its
//! gateway socket `<state>/w.sock`. A rehearsal runs with `WORLDD_REHEARSAL=1` in its environment.
// Deploying is operations, not the engine: its windows and timelines are wall-clock time (the wall-clock rule, K7).
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use directoryd::directory::store::Store;
use replica::encode::{Value, decode, encode, to_hex};
use replica::ids::sha256;
use replica::intents::Intent;
use sim::log::{FileStore, Log, recover};

use crate::{World, build_path, pin, set_pin};

/// The field of a world's tick record that lists the intents it answered (`worldd::answers::ANSWERED`): rows
/// `{1: actor, 2: sequence, 3: intent id, 4: answer frame, 5: intent}`.
pub const ANSWERED: u64 = 3;

/// The served log of a world's state folder.
pub fn log_path(state: &Path) -> PathBuf {
    state.join("world.log")
}

/// The world's gateway socket in its state folder.
pub fn socket_path(state: &Path) -> PathBuf {
    state.join("w.sock")
}

/// A world's state folder on this machine.
pub fn state_path(root: &Path, world: &World) -> PathBuf {
    root.join("worlds").join(world.name())
}

/// Real time in microseconds since 1970, the clock intents' expiries are on.
pub fn now_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as i64)
}

/// A known-good act on the world, sent again with a new sequence each time: a healthy world gives it a receipt.
/// Its sequences are real microseconds, so they only grow, across restarts and rehearsals alike.
pub struct Probe {
    pub intent: Intent,
}

impl Probe {
    fn next(&mut self) -> Vec<u8> {
        let t = now_us();
        self.intent.sequence = self.intent.sequence.max(t as u64 - 1) + 1;
        self.intent.expiry = t + 5_000_000;
        encode(&self.intent.to_value()).unwrap_or_default()
    }
}

/// How a world answered: a receipt, a refusal by name, or a frame that is neither.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum End {
    Receipt,
    Refused(String),
    Unnamed,
}

/// The (sequence, end) of an answer frame `{1: version, 2: answer}`.
pub fn read_answer(frame: &[u8]) -> Option<(u64, End)> {
    let Value::Map(m) = decode(frame).ok()?.value else {
        return None;
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        return None;
    };
    let Some(Value::Uint(s)) = a.get(&2) else {
        return None;
    };
    let end = match (a.get(&3), a.get(&4)) {
        (Some(Value::Uint(1)), _) => End::Receipt,
        (_, Some(Value::Text(t))) => End::Refused(t.as_str().to_owned()),
        _ => End::Unnamed,
    };
    Some((*s, end))
}

fn send(s: &mut UnixStream, bytes: &[u8]) -> bool {
    let len = u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes();
    s.write_all(&len).is_ok() && s.write_all(bytes).is_ok()
}

/// One frame, or `None` when the socket closes or `wait` passes.
fn read_frame(s: &mut UnixStream, wait: Duration) -> Option<Vec<u8>> {
    read_or_closed(s, wait).ok()
}

/// One frame; `Err(true)` when `wait` passed, `Err(false)` when the socket closed.
fn read_or_closed(s: &mut UnixStream, wait: Duration) -> Result<Vec<u8>, bool> {
    let timed_out = |e: std::io::Error| {
        matches!(
            e.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        )
    };
    s.set_read_timeout(Some(wait.max(Duration::from_millis(1))))
        .map_err(|_| false)?;
    let mut len = [0u8; 4];
    s.read_exact(&mut len).map_err(timed_out)?;
    let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut frame).map_err(timed_out)?;
    Ok(frame)
}

fn connect(socket: &Path, within: Duration) -> Option<UnixStream> {
    let until = Instant::now() + within;
    loop {
        if let Ok(s) = UnixStream::connect(socket) {
            return Some(s);
        }
        if Instant::now() >= until {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The canary's declared health.
#[derive(Clone, Copy, Debug)]
pub struct Canary {
    /// How long the world must stay healthy.
    pub window: Duration,
    /// How long a restarted world has to serve.
    pub start_within: Duration,
    /// How long each probe has for its receipt.
    pub answer_within: Duration,
    /// How often the probe is sent.
    pub every: Duration,
}

/// Sends the probe and waits for its answer; the fault by name when it is not a receipt in time.
fn probe_once(s: &mut UnixStream, probe: &mut Probe, within: Duration) -> Result<(), String> {
    let bytes = probe.next();
    let seq = probe.intent.sequence;
    if !send(s, &bytes) {
        return Err("canary.not-serving: the socket closed".into());
    }
    let until = Instant::now() + within;
    loop {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!(
                "canary.unanswered: no answer within {} ms",
                within.as_millis()
            ));
        }
        let frame = match read_or_closed(s, left) {
            Ok(f) => f,
            Err(false) => return Err("canary.not-serving: the socket closed".into()),
            Err(true) => {
                return Err(format!(
                    "canary.unanswered: no answer within {} ms",
                    within.as_millis()
                ));
            }
        };
        match read_answer(&frame) {
            Some((q, End::Receipt)) if q == seq => return Ok(()),
            Some((q, End::Refused(r))) if q == seq => return Err(format!("canary.refused: {r}")),
            Some((q, End::Unnamed)) if q == seq => {
                return Err("canary.refused: an unnamed answer".into());
            }
            _ => {}
        }
    }
}

/// Watches the world behind `socket` for the canary's window; `Ok` when it stayed healthy, else the first fault.
/// With `until_healthy`, ends `Ok` at the first receipt instead (a rolled-back world serving again).
pub fn watch(
    socket: &Path,
    c: &Canary,
    probe: &mut Probe,
    until_healthy: bool,
) -> Result<(), String> {
    let end = Instant::now() + c.window;
    let mut link: Option<UnixStream> = None;
    loop {
        let s = match link.as_mut() {
            Some(s) => s,
            None => match connect(socket, c.start_within) {
                Some(s) => link.insert(s),
                None => {
                    return Err(format!(
                        "canary.not-serving: no socket within {} ms",
                        c.start_within.as_millis()
                    ));
                }
            },
        };
        match probe_once(s, probe, c.answer_within) {
            Ok(()) if until_healthy => return Ok(()),
            Ok(()) => {}
            // A world that died after it served is reached again, within the start limit, or is not serving.
            Err(e) if e.starts_with("canary.not-serving") && Instant::now() < end => {
                link = None;
                continue;
            }
            Err(e) => return Err(e),
        }
        if Instant::now() >= end {
            return Ok(());
        }
        std::thread::sleep(c.every);
    }
}

/// What a rehearsal did, for the deploy's record.
#[derive(Clone, Debug)]
pub struct Rehearsal {
    pub scratch: PathBuf,
    /// Records copied onto the scratch log, and the recorded intents fed after them.
    pub copied: usize,
    pub fed: usize,
    /// Fed intents that reached a named end, and how many were receipts.
    pub ended: usize,
    pub receipts: usize,
    /// The refusals among them, by name.
    pub refused: std::collections::BTreeMap<String, usize>,
    /// The served log: its length and SHA-256 when the rehearsal began, and whether those bytes were the same after.
    pub served_len: usize,
    pub served_sha: String,
    pub served_kept: bool,
}

struct Killed(Child);

impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Runs `build` on a scratch copy of the log at `served` (into `scratch`, which it empties): the log as it stood
/// `window` records before its end, then the intents those last records took, in order, then the probe.
pub fn rehearse(
    build: &Path,
    served: &Path,
    scratch: &Path,
    window: usize,
    c: &Canary,
    probe: &mut Probe,
) -> Result<Rehearsal, String> {
    let bytes = std::fs::read(served).map_err(|e| format!("rehearsal.no-log: {e}"))?;
    let (served_len, served_sha) = (bytes.len(), to_hex(&sha256(&bytes)));
    let found = recover(&bytes).map_err(|e| format!("rehearsal.log-unread: {e}"))?;
    let epoch = found.header.map_or(1, |h| h.epoch);
    let keep = found.records.len().saturating_sub(window);
    // The recorded intents, one group per tick that took them, fed a tick at a time as they first arrived.
    let mut fed: Vec<Vec<Vec<u8>>> = Vec::new();
    for r in &found.records[keep..] {
        let Ok(Value::Map(part)) = decode(r).map(|d| d.value) else {
            continue;
        };
        let Some(Value::Array(rows)) = part.get(&ANSWERED) else {
            continue;
        };
        let tick: Vec<Vec<u8>> = rows
            .iter()
            .filter_map(|row| match row {
                Value::Map(m) => encode(m.get(&5)?).ok(),
                _ => None,
            })
            .collect();
        if !tick.is_empty() {
            fed.push(tick);
        }
    }
    let total: usize = fed.iter().map(Vec::len).sum();
    let _ = std::fs::remove_dir_all(scratch);
    std::fs::create_dir_all(scratch).map_err(|e| format!("rehearsal.scratch: {e}"))?;
    let copy = log_path(scratch);
    let store = FileStore::open(&copy).map_err(|e| format!("rehearsal.scratch: {e}"))?;
    let (mut log, _) = Log::open(store, epoch).map_err(|e| format!("rehearsal.scratch: {e}"))?;
    for r in &found.records[..keep] {
        log.append(r.clone())
            .map_err(|e| format!("rehearsal.scratch: {e}"))?;
    }
    log.wait_durable(keep as u64)
        .map_err(|e| format!("rehearsal.scratch: {e}"))?;
    drop(log.close());

    let child = Command::new(build)
        .arg("--dir")
        .arg(scratch)
        .env("WORLDD_REHEARSAL", "1")
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("rehearsal.no-start: {e}"))?;
    let _child = Killed(child);
    let mut s = connect(&socket_path(scratch), c.start_within)
        .ok_or("rehearsal.no-start: the build did not serve the scratch copy")?;
    let (mut ended, mut receipts, mut refused) = (0, 0, std::collections::BTreeMap::new());
    for tick in &fed {
        for b in tick {
            if !send(&mut s, b) {
                return Err("rehearsal.no-start: the socket closed".into());
            }
        }
        let (goal, until) = (ended + tick.len(), Instant::now() + c.answer_within * 4);
        while ended < goal {
            let Some(frame) = read_frame(&mut s, until.saturating_duration_since(Instant::now()))
            else {
                break;
            };
            match read_answer(&frame) {
                Some((_, End::Receipt)) => {
                    ended += 1;
                    receipts += 1;
                }
                Some((_, End::Refused(r))) => {
                    ended += 1;
                    *refused.entry(r).or_default() += 1;
                }
                _ => {}
            }
        }
    }
    if ended < total {
        return Err(format!(
            "rehearsal.unanswered: {} of {total} recorded intents reached no named end",
            total - ended
        ));
    }
    probe_once(&mut s, probe, c.answer_within).map_err(|e| format!("rehearsal.{e}"))?;
    let after = std::fs::read(served).unwrap_or_default();
    let served_kept =
        after.len() >= served_len && to_hex(&sha256(&after[..served_len])) == served_sha;
    Ok(Rehearsal {
        scratch: scratch.to_path_buf(),
        copied: keep,
        fed: total,
        ended,
        receipts,
        refused,
        served_len,
        served_sha,
        served_kept,
    })
}

/// The schemas a build reads and writes, as `worldd schemas` prints them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Schemas {
    pub reads: BTreeSet<String>,
    pub writes: BTreeSet<String>,
}

pub fn schemas(build: &Path) -> Result<Schemas, String> {
    let out = Command::new(build)
        .arg("schemas")
        .output()
        .map_err(|e| format!("rollback.schemas-unknown: {e}"))?;
    let mut s = Schemas::default();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        match line.split_once(' ') {
            Some(("reads", h)) => s.reads.insert(h.trim().to_owned()),
            Some(("writes", h)) => s.writes.insert(h.trim().to_owned()),
            _ => false,
        };
    }
    if !out.status.success() || s.reads.is_empty() {
        return Err(format!(
            "rollback.schemas-unknown: {} did not name the schemas it reads",
            build.display()
        ));
    }
    Ok(s)
}

/// Whether the world may go back to `old` after `new` ran: always when `new` wrote nothing, else only when `old`
/// reads every schema `new` writes.
pub fn rollback_check(old: &Schemas, new: &Schemas, new_wrote: bool) -> Result<(), String> {
    let unread: Vec<&String> = new.writes.difference(&old.reads).collect();
    if new_wrote && !unread.is_empty() {
        return Err(format!(
            "rollback.schema-unread: the new build wrote records in schema {unread:?}, which the old build does not read"
        ));
    }
    Ok(())
}

/// How a world's process is restarted.
pub trait Unit {
    fn restart(&mut self) -> Result<(), String>;
}

/// `worldd@<world>.service` under systemd (O1). `--no-block`: a build that never says READY must not hold the deploy.
pub struct Systemd(pub String);

impl Unit for Systemd {
    fn restart(&mut self) -> Result<(), String> {
        let unit = format!("worldd@{}.service", self.0);
        let st = Command::new("systemctl")
            .args(["restart", "--no-block", &unit])
            .status()
            .map_err(|e| format!("restart: {e}"))?;
        st.success()
            .then_some(())
            .ok_or_else(|| format!("restart: systemctl restart {unit}: {st}"))
    }
}

/// A deploy's timeline: milliseconds from its start, and what happened.
#[derive(Clone, Debug, Default)]
pub struct Timeline(pub Vec<(u128, String)>);

/// How a deploy ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ended {
    /// The new build passed the canary and stays pinned.
    Kept,
    /// The canary found `fault` and the world runs the old build again, healthy.
    RolledBack { fault: String },
    /// The rehearsal failed: the pin never moved.
    NotDeployed { why: String },
    /// A rollback was needed or asked and refused; the world runs what it ran.
    Refused { why: String },
}

/// The records in the world's served log now.
pub fn records(state: &Path) -> usize {
    std::fs::read(log_path(state))
        .ok()
        .and_then(|b| recover(&b).ok())
        .map_or(0, |f| f.records.len())
}

/// One world, one deploy.
pub struct Deploy<'a> {
    pub store: &'a dyn Store,
    pub root: &'a Path,
    pub world: World,
    pub canary: Canary,
    /// Records of the served log the rehearsal replays.
    pub window: usize,
}

impl Deploy<'_> {
    fn path(&self, build: &[u8]) -> PathBuf {
        build_path(self.root, build)
    }

    /// Rehearses `new`, pins it, restarts the world and watches it; rolls back to the build it replaced on a fault.
    pub fn run(
        &self,
        new: &[u8],
        unit: &mut dyn Unit,
        probe: &mut Probe,
    ) -> (Ended, Timeline, Option<Rehearsal>) {
        let t0 = Instant::now();
        let mut tl = Timeline::default();
        let mut note = |s: String| tl.0.push((t0.elapsed().as_millis(), s));
        let state = state_path(self.root, &self.world);
        let old = match pin(self.store, self.root, &self.world) {
            Ok((b, _)) => b,
            Err(e) => return (Ended::NotDeployed { why: e }, tl, None),
        };
        // Short, so its socket's path fits (104 bytes on macOS): one rehearsal of a build at a time on a machine.
        let scratch = self.root.join("rehearsals").join(&to_hex(new)[..16]);
        let r = match rehearse(
            &self.path(new),
            &log_path(&state),
            &scratch,
            self.window,
            &self.canary,
            probe,
        ) {
            Ok(r) => r,
            Err(why) => {
                note(format!("rehearsal failed: {why}"));
                return (Ended::NotDeployed { why }, tl, None);
            }
        };
        note(format!(
            "rehearsed on a scratch copy: {} records copied, {} recorded intents fed, {} named ends",
            r.copied, r.fed, r.ended
        ));
        let before = records(&state);
        if let Err(why) = set_pin(self.store, &self.world, new) {
            return (Ended::NotDeployed { why }, tl, Some(r));
        }
        note(format!("pinned {}", &to_hex(new)[..16]));
        if let Err(why) = unit.restart() {
            return (Ended::NotDeployed { why }, tl, Some(r));
        }
        note("restarted: the canary watch begins".into());
        let fault = match watch(&socket_path(&state), &self.canary, probe, false) {
            Ok(()) => {
                note(format!(
                    "healthy for {} ms: kept",
                    self.canary.window.as_millis()
                ));
                return (Ended::Kept, tl, Some(r));
            }
            Err(f) => f,
        };
        note(format!("fault: {fault}"));
        let wrote = records(&state) > before;
        match self.roll_back(&old, new, wrote, unit, probe, &mut note) {
            Ok(()) => (Ended::RolledBack { fault }, tl, Some(r)),
            Err(why) => (Ended::Refused { why }, tl, Some(r)),
        }
    }

    /// Takes the world from `new` back to `old`: the schema check, the pin, the restart, and a watch until it serves.
    pub fn roll_back(
        &self,
        old: &[u8],
        new: &[u8],
        new_wrote: bool,
        unit: &mut dyn Unit,
        probe: &mut Probe,
        note: &mut dyn FnMut(String),
    ) -> Result<(), String> {
        let check = schemas(&self.path(old))
            .and_then(|o| Ok((o, schemas(&self.path(new))?)))
            .and_then(|(o, n)| rollback_check(&o, &n, new_wrote));
        if let Err(why) = check {
            note(format!("rollback refused: {why}"));
            return Err(why);
        }
        set_pin(self.store, &self.world, old)?;
        note(format!("pinned back {}", &to_hex(old)[..16]));
        unit.restart()?;
        note("restarted".into());
        let back = Canary {
            window: Duration::from_secs(60),
            ..self.canary
        };
        let state = state_path(self.root, &self.world);
        watch(&socket_path(&state), &back, probe, true)?;
        note("serving again: the probe has its receipt".into());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(reads: &[&str], writes: &[&str]) -> Schemas {
        Schemas {
            reads: reads.iter().map(|x| x.to_string()).collect(),
            writes: writes.iter().map(|x| x.to_string()).collect(),
        }
    }

    #[test]
    fn a4_a_rollback_to_a_build_that_cannot_read_the_new_schema_is_refused_by_name() {
        let (old, new) = (s(&["a"], &["a"]), s(&["a", "b"], &["b"]));
        let e = rollback_check(&old, &new, true).unwrap_err();
        assert!(e.starts_with("rollback.schema-unread"), "{e}");
        // Nothing written by the new build: nothing the old one must read.
        assert_eq!(rollback_check(&old, &new, false), Ok(()));
        assert_eq!(rollback_check(&new, &old, true), Ok(()));
    }
}
