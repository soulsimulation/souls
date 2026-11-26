//! Deploy and roll back one world (Engine v2 O7, #2804): a new build reaches one world at a time, and a bad one is
//! taken back by the machine. Runbook: `v2/docs/runbook/deploy-and-roll-back.md`.
//!
//! 1. **Rehearse** ([`rehearse`]): on a scratch copy of the world's folder, never the served one, the new build starts
//!    as `worldd serve` from the log as it stood `window` records ago and is fed the intents those records took (the recorded inputs,
//!    I4's [`ANSWERED`] rows). It passes when it starts, gives every fed intent a named end and answers the probe
//!    ([`Probe`]). Invariants, not hashes: two builds fed the same inputs need not write the same bytes.
//! 2. **Canary** ([`watch`]): the world's pin is set to the new build (one conditional write, W8) and the world is
//!    restarted. It must serve within `start_within` and answer the probe within `answer_within`, every
//!    `every`, for `window`. The first miss is a fault, by name: `canary.not-serving`, `canary.unanswered`,
//!    `canary.refused` (with the world's reason).
//! 3. **Roll back** ([`roll_back`]): code rolls back, data never. If the new build wrote any record, the old build
//!    must read every schema the new one writes (T6), or the rollback is refused `rollback.schema-unread` and the
//!    world keeps running what it runs. Otherwise the pin goes back and the world is restarted.
//!
//! A release's library entries for the world, when it staged them (`<state>/entries.next`, `worldd entries stage`),
//! go with the build: the rehearsal runs on them, the restart after the pin takes them (the world's own kept as
//! `entries.before`), and a rollback puts the world's own back only when the new build wrote nothing.
//!
//! A build's folder is `builds/<hash>/`; it is started as the launcher starts it, `worldd serve --dir <state>` (C1,
//! #3365), and `worldd schemas` prints `reads <hash>` and `writes <hash>` lines. The served log is `<state>/log`; the
//! world's socket is the placed world's `<root>/../run/<world>.sock` (`place-world.sh`), else `<state>/gateway.sock`.
//! A rehearsal runs with `WORLDD_REHEARSAL=1` in its environment and serves `<scratch>/gateway.sock` (O18b, #3498).
//! Its environment is otherwise cleared to a few process basics ([`REHEARSAL_ENV`]), so whatever build it runs never
//! sees the shared store or the backup bucket, claims nothing and ships nothing: the live world's claim, epoch and
//! archive stay as they were.
// Deploying is operations, not the engine: its windows and timelines are wall-clock time (the wall-clock rule, K7).
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use directoryd::directory::store::Store;
use replica::effects::{Actor, read_id};
use replica::encode::Name;
use replica::encode::{Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, sha256};
use replica::intents::Intent;
use replica::sync::wire;
use sim::log::{FileStore, Log, recover};

use crate::{World, build_path, pin, set_pin};

/// The field of a world's tick record that lists the intents it answered (`worldd::answers::ANSWERED`): rows
/// `{1: actor, 2: sequence, 3: intent id, 4: answer frame, 5: intent}`.
pub const ANSWERED: u64 = 3;

/// The served log of a world's state folder.
pub fn log_path(state: &Path) -> PathBuf {
    state.join("log")
}

/// The gateway socket `worldd serve` binds in a folder when none is named.
pub fn socket_path(state: &Path) -> PathBuf {
    state.join("gateway.sock")
}

/// The socket a world on this machine serves: a placed world's (`place-world.sh` names it in `WORLDD_SOCKET`, under
/// `<root>/../run/`, since a world folder's path is too long for one), else its folder's own.
pub fn served_socket(root: &Path, world: &World) -> PathBuf {
    let run = root.join("../run");
    if run.is_dir() {
        run.join(format!("{}.sock", world.name()))
    } else {
        socket_path(&state_path(root, world))
    }
}

/// The only settings of the deploy's environment a rehearsal's build is given (with `WORLDD_REHEARSAL=1`): the
/// process basics `worldd serve` needs on any machine. Everything else is cleared, so the build never sees the shared
/// store a served world claims and ships its history to (`$WORLDD_STORE`, the directory's `$DIRECTORY_STORE_URL` and
/// their keys), the backup bucket, the live socket, the live pin (`$WORLDD_BUILD`) or the service manager
/// (`$NOTIFY_SOCKET`). With the store, a build serving the scratch copy would take the live world's claim at a new
/// epoch (`worldd::shipping::take_over`) and write the live archive. Cleared by the deploy, not left to the build, so a
/// build that predates this rule (a rollback's) and a setting added later are kept out too.
pub const REHEARSAL_ENV: [&str; 8] = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "RUST_LOG",
    "RUST_BACKTRACE",
];

/// What `worldd serve` reads from a world's folder besides its log and checkpoints: copied into a rehearsal's scratch
/// folder. A fork's `boot` pins its support (its facts, entries, kinds, `moves.json`, `entry.json` and `bodies.json`)
/// and `serve` refuses a fork without it or with any of them changed (`served-fork-support-mismatch`); every world
/// reads its entry, its body catalogue and the code hatches its entries name.
const FOLDER: [&str; 10] = [
    "world.json",
    "facts.json",
    "header",
    "header.kinds",
    "moves.json",
    "entries",
    "boot",
    "entry.json",
    "bodies.json",
    "hatches",
];

/// Whether a world's folder is a fork's: one made from a template or another world (`worldd fork --template`, which
/// writes `"fork": true` in its `world.json`). A fork starts from its checkpoint, not from an import's part.
fn is_fork(state: &Path) -> bool {
    std::fs::read_to_string(state.join("world.json")).is_ok_and(|t| {
        t.split_whitespace()
            .collect::<String>()
            .contains("\"fork\":true")
    })
}

/// A world's checkpoints (`checkpoints/ckpt-<record, 20 digits>`), by the log record each was taken at, oldest first.
fn checkpoints(state: &Path) -> Vec<(u64, PathBuf)> {
    let mut out: Vec<(u64, PathBuf)> = std::fs::read_dir(state.join("checkpoints"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let n = name.strip_prefix("ckpt-").filter(|n| n.len() == 20)?;
            Some((n.parse().ok()?, e.path()))
        })
        .collect();
    out.sort();
    out
}

/// A release's library entries for a world (`worldd entries stage`): `<state>/entries.next`, the world's whole
/// `entries/` with the release's changes. When it is there, the rehearsal runs on it instead of the world's own, and
/// the restart after the pin takes it ([`swap_entries`]); otherwise the world keeps the entries it has.
pub const ENTRIES_NEXT: &str = "entries.next";
/// Where a deploy that took [`ENTRIES_NEXT`] keeps the entries it replaced: `<state>/entries.before`.
pub const ENTRIES_BEFORE: &str = "entries.before";

/// Swaps `<state>/entries` for [`ENTRIES_NEXT`] (`forward`), the replaced ones kept as [`ENTRIES_BEFORE`], or back.
/// Two renames in one folder; the world is restarted right after either, so it reads one whole set. When the second
/// fails, the first is undone: the world is never left without `entries/`.
pub fn swap_entries(state: &Path, forward: bool) -> std::io::Result<()> {
    let (live, next, before) = (
        state.join("entries"),
        state.join(ENTRIES_NEXT),
        state.join(ENTRIES_BEFORE),
    );
    // (where the live set goes, what comes in)
    let (out, cur) = if forward {
        let _ = std::fs::remove_dir_all(&before);
        (&before, &next)
    } else {
        (&next, &before)
    };
    std::fs::rename(&live, out)?;
    std::fs::rename(cur, &live).inspect_err(|_| {
        let _ = std::fs::rename(out, &live);
    })
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
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

/// What the canary sends a world, again and again: a healthy world answers it within `answer_within`.
///
/// Releases use [`Probe::Operator`]: a separate unpaired identity enters through C3/K10, commits an ordinary
/// `eden:describe` on its own body, and retires through the same lifecycle. A durable, locked recovery receipt
/// precedes every send, so interrupted watches recover the same pending actor before creating another body.
/// [`Probe::Ask`] remains the non-mutating root-sync diagnostic; [`Probe::Act`] is for a caller-owned test body.
pub enum Probe {
    /// The sync ask's number, counted up.
    Ask(u64),
    Act(Box<Intent>),
    /// O18d: a fresh, unpaired operator identity, with crash recovery owned by its deployment receipt.
    Operator(OperatorProbe),
}

impl Probe {
    pub fn operator(receipt: &Path) -> Result<Self, String> {
        OperatorProbe::open(receipt).map(Self::Operator)
    }

    /// The bytes to send, and the number its answer carries.
    fn next(&mut self) -> Option<(Vec<u8>, u64)> {
        match self {
            Probe::Ask(n) => {
                *n += 1;
                let ask = [
                    (wire::ASK, Value::Uint(*n)),
                    (wire::IDS, Value::Array(Vec::new())),
                ];
                Some((encode(&Value::Map(ask.into())).unwrap_or_default(), *n))
            }
            Probe::Act(intent) => {
                let t = now_us();
                intent.sequence = intent.sequence.max(t as u64 - 1) + 1;
                intent.expiry = t + 5_000_000;
                Some((
                    encode(&intent.to_value()).unwrap_or_default(),
                    intent.sequence,
                ))
            }
            Probe::Operator(_) => None,
        }
    }

    /// The end `frame` names when it answers the probe sent as `n`; `None` for any other frame.
    fn answered(&self, frame: &[u8], n: u64) -> Option<End> {
        match self {
            Probe::Ask(_) => {
                let Value::Map(m) = decode(frame).ok()?.value else {
                    return None;
                };
                if m.get(&wire::ASK) != Some(&Value::Uint(n)) {
                    return None;
                }
                // The world's version, and its root's hash as sealed now.
                let root = match m.get(&wire::IDS) {
                    Some(Value::Array(h)) => {
                        matches!(h.as_slice(), [Value::Bytes(b)] if !b.is_empty())
                    }
                    _ => false,
                };
                Some(match m.get(&wire::REFUSED) {
                    Some(Value::Text(r)) => End::Refused(r.as_str().to_owned()),
                    _ if root && m.contains_key(&1) => End::Receipt,
                    _ => End::Unnamed,
                })
            }
            Probe::Act(_) => read_answer(frame).and_then(|(q, e)| (q == n).then_some(e)),
            Probe::Operator(_) => None,
        }
    }
}

/// A narrow recovery receipt, not a user profile or pairing. The stable sibling lock is held even while the
/// receipt is atomically replaced; two watches can never share the identity or its sequence.
pub struct OperatorProbe {
    receipt: PathBuf,
    _lock: File,
    actor: Id,
    sequence: u64,
    pending: bool,
    joined: bool,
    basis: Option<Value>,
}

impl OperatorProbe {
    fn open(receipt: &Path) -> Result<Self, String> {
        let parent = receipt.parent().ok_or("canary.probe-receipt: no parent")?;
        std::fs::create_dir_all(parent).map_err(|e| format!("canary.probe-receipt: {e}"))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(receipt.with_extension("probe.lock"))
            .map_err(|e| format!("canary.probe-receipt: {e}"))?;
        lock.try_lock()
            .map_err(|_| "canary.probe-busy: another watch owns the probe".to_owned())?;
        let saved = match std::fs::read(receipt) {
            Ok(b) => {
                let Value::Map(m) = decode(&b)
                    .map_err(|_| "canary.probe-receipt: invalid record")?
                    .value
                else {
                    return Err("canary.probe-receipt: invalid record".into());
                };
                let actor = m
                    .get(&1)
                    .and_then(|v| read_id(v).ok())
                    .ok_or("canary.probe-receipt: no actor")?;
                let (Some(Value::Uint(sequence)), Some(Value::Uint(1..=3))) =
                    (m.get(&2), m.get(&3))
                else {
                    return Err("canary.probe-receipt: invalid pending phase".into());
                };
                Some((actor, *sequence))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("canary.probe-receipt: {e}")),
        };
        let (actor, sequence, pending) = match saved {
            Some((actor, sequence)) => (actor, sequence, true),
            None => {
                let mut scope = [0; 16];
                File::open("/dev/urandom")
                    .and_then(|mut f| f.read_exact(&mut scope))
                    .map_err(|e| format!("canary.probe-identity: {e}"))?;
                (
                    Id::new(Scope(scope), 1).ok_or("canary.probe-identity: invalid identity")?,
                    0,
                    false,
                )
            }
        };
        Ok(Self {
            receipt: receipt.to_path_buf(),
            _lock: lock,
            actor,
            sequence,
            pending,
            joined: false,
            basis: None,
        })
    }

    fn save(&mut self, phase: u64) -> Result<(), String> {
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, self.actor.to_value()),
            (2, Value::Uint(self.sequence)),
            (3, Value::Uint(phase)),
        ])))
        .map_err(|e| format!("canary.probe-receipt: {e}"))?;
        let temporary = self.receipt.with_extension("probe.tmp");
        let mut f = File::create(&temporary).map_err(|e| format!("canary.probe-receipt: {e}"))?;
        f.write_all(&bytes)
            .and_then(|()| f.sync_all())
            .map_err(|e| format!("canary.probe-receipt: {e}"))?;
        std::fs::rename(&temporary, &self.receipt)
            .map_err(|e| format!("canary.probe-receipt: {e}"))?;
        self.sync_parent()?;
        self.pending = true;
        Ok(())
    }

    fn sync_parent(&self) -> Result<(), String> {
        File::open(
            self.receipt
                .parent()
                .ok_or("canary.probe-receipt: no parent")?,
        )
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("canary.probe-receipt: {e}"))
    }

    fn version(&mut self, s: &mut UnixStream, within: Duration) -> Result<(), String> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("canary.probe-sequence-exhausted")?;
        let n = self.sequence;
        let bytes = encode(&Value::Map(BTreeMap::from([
            (wire::ASK, Value::Uint(n)),
            (wire::IDS, Value::Array(Vec::new())),
        ])))
        .map_err(|e| format!("canary.probe-encoding: {e}"))?;
        if !send(s, &bytes) {
            return Err("canary.not-serving: the socket closed".into());
        }
        let until = Instant::now() + within;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("canary.unanswered: operator probe".into());
            }
            let frame = read_or_closed(s, left).map_err(|timeout| {
                if timeout {
                    "canary.unanswered: probe version"
                } else {
                    "canary.not-serving: the socket closed"
                }
            })?;
            let Ok(Value::Map(m)) = decode(&frame).map(|d| d.value) else {
                continue;
            };
            if m.get(&wire::ASK) != Some(&Value::Uint(n)) {
                continue;
            }
            let Some(Value::Array(v)) = m.get(&1) else {
                return Err("canary.refused: no world version".into());
            };
            if v.len() != 4 {
                return Err("canary.refused: invalid world version".into());
            }
            self.basis = Some(Value::Array(v.clone()));
            return Ok(());
        }
    }

    fn act(
        &mut self,
        s: &mut UnixStream,
        verb: &str,
        phase: u64,
        words: &[(u64, &str)],
        within: Duration,
    ) -> Result<(), String> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("canary.probe-sequence-exhausted")?;
        // The receipt precedes IO: even a lost join acknowledgement is recoverable under this same actor.
        self.save(phase)?;
        let intent = Intent {
            actor: Actor::Soul(self.actor),
            verb: Name::new(verb).ok_or("canary.probe-verb")?,
            target: None,
            parameters: words
                .iter()
                .map(|(k, text)| {
                    (
                        *k,
                        Value::Map(BTreeMap::from([(
                            23,
                            Value::Bytes(text.as_bytes().to_vec()),
                        )])),
                    )
                })
                .collect(),
            sequence: self.sequence,
            basis: self.basis.clone().ok_or("canary.probe-version")?,
            expiry: now_us() + 5_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let bytes =
            encode(&intent.to_value()).map_err(|e| format!("canary.probe-encoding: {e}"))?;
        if !send(s, &bytes) {
            return Err("canary.not-serving: the socket closed".into());
        }
        let until = Instant::now() + within;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("canary.unanswered: operator probe".into());
            }
            let frame = read_or_closed(s, left).map_err(|timeout| {
                if timeout {
                    "canary.unanswered: operator act"
                } else {
                    "canary.not-serving: the socket closed"
                }
            })?;
            let Ok(Value::Map(m)) = decode(&frame).map(|d| d.value) else {
                continue;
            };
            let Some(Value::Map(a)) = m.get(&2) else {
                continue;
            };
            if a.get(&2) != Some(&Value::Uint(self.sequence)) {
                continue;
            }
            let actor = Value::Map(BTreeMap::from([
                (1, Value::Uint(1)),
                (2, self.actor.to_value()),
            ]));
            if a.get(&1) != Some(&actor) {
                return Err("canary.refused: wrong probe actor".into());
            }
            match a.get(&3) {
                Some(Value::Uint(1)) => {
                    let entries = match a.get(&5) {
                        Some(Value::Array(v)) => v,
                        _ => return Err("canary.refused: no committed entries".into()),
                    };
                    // An idempotent join is a lifecycle acknowledgement, not the canary's legal-act proof.
                    // Describe and retirement must still name their committed effects.
                    if (verb != "life:join" && entries.is_empty())
                        || entries.iter().any(|v| !matches!(v, Value::Uint(_)))
                        || a.get(&4).and_then(|v| read_id(v).ok()).is_none()
                    {
                        return Err("canary.refused: no committed probe receipt".into());
                    }
                    return Ok(());
                }
                Some(Value::Uint(2)) => {
                    let reason = match a.get(&4) {
                        Some(Value::Text(n)) => n.as_str(),
                        _ => "unnamed",
                    };
                    return Err(format!("canary.refused: {reason}"));
                }
                Some(Value::Uint(3)) => continue,
                _ => return Err("canary.refused: an unnamed probe answer".into()),
            }
        }
    }

    fn join(&mut self, s: &mut UnixStream, within: Duration) -> Result<(), String> {
        self.act(
            s,
            "life:join",
            1,
            &[
                (1, "Operator release probe"),
                (2, "Temporary operator-owned canary body"),
            ],
            within,
        )?;
        self.joined = true;
        Ok(())
    }

    fn sample(&mut self, s: &mut UnixStream, within: Duration) -> Result<(), String> {
        self.version(s, within)?;
        if !self.joined {
            self.join(s, within)?;
        }
        self.act(
            s,
            "eden:describe",
            2,
            &[(2, "Operator release canary: committed legal action")],
            within,
        )
    }

    fn retire(&mut self, s: &mut UnixStream, within: Duration) -> Result<(), String> {
        if !self.pending {
            return Ok(());
        }
        self.version(s, within)?;
        // An uncertain birth must first reach its ordinary join barrier. An early not-embodied leave could race
        // the queued birth and would NOT prove cleanup. Repeated join is C3's own idempotent naming operation.
        if !self.joined {
            self.join(s, within)?;
        }
        self.act(s, "life:leave", 3, &[], within)?;
        std::fs::remove_file(&self.receipt).map_err(|e| format!("canary.probe-receipt: {e}"))?;
        self.sync_parent()?;
        self.pending = false;
        self.joined = false;
        Ok(())
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

/// [`connect`], ending early with `exited`'s fault (the world's process ended), asked at most each half second.
fn connect_or_exit(
    socket: &Path,
    within: Duration,
    exited: &mut dyn FnMut() -> Option<String>,
) -> Result<UnixStream, String> {
    let until = Instant::now() + within;
    loop {
        if let Some(s) = connect(socket, Duration::from_millis(500).min(within)) {
            return Ok(s);
        }
        if let Some(fault) = exited() {
            return Err(fault);
        }
        if Instant::now() >= until {
            return Err(format!(
                "canary.not-serving: no socket within {} ms",
                within.as_millis()
            ));
        }
    }
}

/// How long a world has to serve when its limits name no bound (R17, 0.133): a start whose store is slow (one write in
/// twenty stalls 30 to 60 s on production's) waits for it with back-off and must not be judged on 30 s. A real fault
/// still fails at once: the process ending ([`Unit::exited`], `canary.exited`) or a refused probe.
pub const START_WITHIN: Duration = Duration::from_secs(120);

/// The start bound in a world's limits drop-in (`worldd@<world>.service.d/limits.conf`, written from
/// `world-limits.json` by `v2/tools/ops/world-limits.mjs`): its `Environment=WORLD_START_WITHIN_S=<s>` line, else
/// [`START_WITHIN`]. A world that loads longer (Eden) is given its own bound; one that hangs still fails.
pub fn start_within(limits: Option<&str>) -> Duration {
    limits
        .into_iter()
        .flat_map(str::lines)
        .filter_map(|l| l.trim().strip_prefix("Environment=WORLD_START_WITHIN_S="))
        .filter_map(|s| s.trim().parse::<u64>().ok())
        .find(|s| (1..=3600).contains(s))
        .map_or(START_WITHIN, Duration::from_secs)
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
    if let Probe::Operator(p) = probe {
        return p.sample(s, within);
    }
    let (bytes, seq) = probe.next().ok_or("canary.probe: no request")?;
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
        match probe.answered(&frame, seq) {
            Some(End::Receipt) => return Ok(()),
            Some(End::Refused(r)) => return Err(format!("canary.refused: {r}")),
            Some(End::Unnamed) => return Err("canary.refused: an unnamed answer".into()),
            None => {}
        }
    }
}

/// The first probe of a world that has just started (or of a rehearsal's copy fed nothing): a world listens once its
/// clock's first tick is done and then catches up, tick by tick, the time since its log's last record (world time never
/// stops). A quiet world's catch-up is that whole quiet stretch: 1dad on 0.136.0's move, 144k ticks after two quiet
/// hours, longer than a tick's 2 s (`canary.unanswered: operator act`); Eden's rehearsal copy over 400k. So the probe has
/// the start bound, and one whose intent (5 s, real time) expired in the catch-up (`intent.expired`) is sent again, a new
/// intent, until the world answers one or the bound ends. Any other refusal, or no answer, fails as before, and only a
/// receipt passes.
fn probe_after_start(s: &mut UnixStream, probe: &mut Probe, c: &Canary) -> Result<(), String> {
    let until = Instant::now() + c.start_within;
    loop {
        let left = until.saturating_duration_since(Instant::now());
        match probe_once(s, probe, left.max(c.answer_within)) {
            Err(e) if e == "canary.refused: intent.expired" && !left.is_zero() => {}
            r => return r,
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
    watch_unit(socket, c, probe, until_healthy, &mut || None)
}

/// [`watch`], failing at once with `exited`'s fault while it waits for the socket: a world whose process ended is a
/// real fault, never a slow start (R17).
pub fn watch_unit(
    socket: &Path,
    c: &Canary,
    probe: &mut Probe,
    until_healthy: bool,
    exited: &mut dyn FnMut() -> Option<String>,
) -> Result<(), String> {
    // A new watch resolves its interrupted predecessor before it can birth anything else. Failure preserves the
    // exact owned identity for the rollback's watch; neither an unknown body nor a lost ACK discards the receipt.
    cleanup_operator(socket, c, probe, exited)?;
    let result = watch_inner(socket, c, probe, until_healthy, exited);
    let cleanup = cleanup_operator(socket, c, probe, exited);
    match (result, cleanup) {
        (Ok(()), r) => r,
        (Err(e), Ok(())) => Err(e),
        (Err(e), Err(cleanup)) => Err(format!("{e}; {cleanup}")),
    }
}

fn cleanup_operator(
    socket: &Path,
    c: &Canary,
    probe: &mut Probe,
    exited: &mut dyn FnMut() -> Option<String>,
) -> Result<(), String> {
    let Probe::Operator(p) = probe else {
        return Ok(());
    };
    if !p.pending {
        return Ok(());
    }
    let mut s = connect_or_exit(socket, c.start_within, exited).map_err(|e| {
        format!("canary.probe-pending: retirement awaits the world serving again ({e})")
    })?;
    p.retire(&mut s, c.answer_within)
        .map_err(|e| format!("canary.probe-pending: {e}"))
}

fn watch_inner(
    socket: &Path,
    c: &Canary,
    probe: &mut Probe,
    until_healthy: bool,
    exited: &mut dyn FnMut() -> Option<String>,
) -> Result<(), String> {
    let end = Instant::now() + c.window;
    let mut link: Option<UnixStream> = None;
    // The first probe after each connect meets the start's catch-up ([`probe_after_start`]); later ones a tick's bound.
    let mut started = false;
    loop {
        let s = match link.as_mut() {
            Some(s) => s,
            None => {
                started = false;
                link.insert(connect_or_exit(socket, c.start_within, exited)?)
            }
        };
        let probed = if started {
            probe_once(s, probe, c.answer_within)
        } else {
            probe_after_start(s, probe, c)
        };
        match probed {
            Ok(()) if until_healthy => return Ok(()),
            Ok(()) => started = true,
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
    /// An earlier rehearsal of this build left its scratch probe receipt and its copy is no longer served: the receipt
    /// was dropped with the copy (`rehearsal.probe-dropped`).
    pub dropped_probe: bool,
}

struct Killed(Child);

impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Runs `build` as `worldd serve` on a scratch copy of the world's folder `state` (into `scratch`, which it empties):
/// its log as it stood `window` records before its end, then the intents those last records took, in order, then the
/// probe. An imported world's checkpoints are not copied: the build replays the copied log from its start, the
/// import's part. A fork's are, those its copied log reaches: a fork starts from its checkpoint.
pub fn rehearse(
    build: &Path,
    state: &Path,
    scratch: &Path,
    window: usize,
    c: &Canary,
    probe: &mut Probe,
) -> Result<Rehearsal, String> {
    let served = &log_path(state);
    let bytes = std::fs::read(served).map_err(|e| format!("rehearsal.no-log: {e}"))?;
    let (served_len, served_sha) = (bytes.len(), to_hex(&sha256(&bytes)));
    let found = recover(&bytes).map_err(|e| format!("rehearsal.log-unread: {e}"))?;
    let epoch = found.header.map_or(1, |h| h.epoch);
    // A served world's first record is its import's part, the world from empty (C1): always copied.
    let mut keep = found
        .records
        .len()
        .saturating_sub(window)
        .max(found.records.len().min(1));
    // A fork's first record follows its checkpoint (K6), and `serve` starts a fork from its checkpoint or refuses it
    // (`served-fork-checkpoint-missing`): the copy takes the checkpoints its copied log reaches. Only the last two are
    // kept, so a fork whose oldest is later than the window's start has its copy start there.
    let forked = if is_fork(state) {
        checkpoints(state)
    } else {
        Vec::new()
    };
    if let Some(&(oldest, _)) = forked.first() {
        keep = keep.max(usize::try_from(oldest).map_or(keep, |n| n.min(found.records.len())));
    }
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
    let receipt = scratch.join("operator.probe");
    let mut dropped_probe = false;
    if matches!(probe, Probe::Operator(_)) && receipt.exists() {
        // Its lock first: a rehearsal of this build still running owns it (`canary.probe-busy`).
        let mut previous = Probe::operator(&receipt)?;
        // A scratch probe's body lives only in the scratch copy, emptied below. A copy still served (an interrupted
        // deploy's build, left running) retires it as any watch does; one no longer served never can, and waiting on
        // its socket refused every later rehearsal of this build (`canary.probe-pending`). Its receipt goes with the
        // copy, by name in the deploy's record.
        if UnixStream::connect(socket_path(scratch)).is_ok() {
            cleanup_operator(&socket_path(scratch), c, &mut previous, &mut || None)?;
        } else {
            dropped_probe = true;
        }
    }
    let _ = std::fs::remove_dir_all(scratch);
    std::fs::create_dir_all(scratch).map_err(|e| format!("rehearsal.scratch: {e}"))?;
    for name in FOLDER {
        if state.join(name).exists() {
            copy_tree(&state.join(name), &scratch.join(name))
                .map_err(|e| format!("rehearsal.scratch: {name}: {e}"))?;
        }
    }
    for (_, ckpt) in forked.iter().filter(|(n, _)| *n <= keep as u64) {
        let to = scratch.join("checkpoints");
        std::fs::create_dir_all(&to)
            .and_then(|()| std::fs::copy(ckpt, to.join(ckpt.file_name().unwrap_or_default())))
            .map_err(|e| format!("rehearsal.scratch: {}: {e}", ckpt.display()))?;
    }
    // The release's entries, when it staged some: the new build is rehearsed with what its restart will read.
    if state.join(ENTRIES_NEXT).is_dir() {
        let _ = std::fs::remove_dir_all(scratch.join("entries"));
        copy_tree(&state.join(ENTRIES_NEXT), &scratch.join("entries"))
            .map_err(|e| format!("rehearsal.scratch: {ENTRIES_NEXT}: {e}"))?;
    }
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

    let err = std::fs::File::create(scratch.join("worldd.err"))
        .map_err(|e| format!("rehearsal.scratch: {e}"))?;
    let mut serve = Command::new(build);
    // Only the settings in [`REHEARSAL_ENV`]: never the live store, backup, socket, pin or service manager.
    serve.env_clear();
    for k in REHEARSAL_ENV {
        if let Some(v) = std::env::var_os(k) {
            serve.env(k, v);
        }
    }
    let child = serve
        .arg("serve")
        .arg("--dir")
        .arg(scratch)
        .arg("--socket")
        .arg(socket_path(scratch))
        .env("WORLDD_REHEARSAL", "1")
        .stdout(Stdio::null())
        // What the build says goes beside its scratch copy, out of the deploy's timeline.
        .stderr(err)
        .spawn()
        .map_err(|e| format!("rehearsal.no-start: {e}"))?;
    let _child = Killed(child);
    let mut s = connect(&socket_path(scratch), c.start_within)
        .ok_or("rehearsal.no-start: the build did not serve the scratch copy")?;
    let (mut ended, mut receipts, mut refused) = (0, 0, std::collections::BTreeMap::new());
    for (n, tick) in fed.iter().enumerate() {
        for b in tick {
            if !send(&mut s, b) {
                return Err("rehearsal.no-start: the socket closed".into());
            }
        }
        // The copy answers nothing until its clock has caught up, back to back, from the tick its copied log ends at
        // to now: on a quiet world the window's records can span hours, so the first answers have the world's start
        // bound, not a tick's. Answers that come late count with a later tick's; the last tick waits for them all.
        let wait = if n == 0 {
            c.start_within
        } else {
            c.answer_within * 4
        };
        let goal = if n + 1 == fed.len() {
            total
        } else {
            ended + tick.len()
        };
        let until = Instant::now() + wait;
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
    // Rehearsal owns a different identity from the live window, and uses the same recoverable lifecycle contract.
    let mut own = if matches!(probe, Probe::Operator(_)) {
        Some(Probe::operator(&receipt)?)
    } else {
        None
    };
    let checking = own.as_mut().unwrap_or(probe);
    // With no recorded intent fed (a quiet window, as Eden's on 0.136), the probe is the copy's first ask and meets
    // its catch-up ([`probe_after_start`]). After a fed intent's answer it has a tick's.
    let checked = if fed.is_empty() {
        probe_after_start(&mut s, checking, c)
    } else {
        probe_once(&mut s, checking, c.answer_within)
    };
    let cleaned = cleanup_operator(&socket_path(scratch), c, checking, &mut || None);
    match (checked, cleaned) {
        (Ok(()), r) => r,
        (Err(e), Ok(())) => Err(e),
        (Err(e), Err(cleanup)) => Err(format!("{e}; {cleanup}")),
    }
    .map_err(|e| format!("rehearsal.{e}"))?;
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
        dropped_probe,
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

    /// `canary.exited` with what it saw once the world's process has ended since [`Unit::restart`], so the canary
    /// waiting for a slow start fails at once on an exit (R17); `None` while it runs, or where it cannot tell.
    fn exited(&mut self) -> Option<String> {
        None
    }
}

/// `worldd@<world>.service` under systemd (O1). `--no-block`: a build that never says READY must not hold the deploy.
/// The second field is the lowest `NRestarts` seen since the restart ([`Unit::exited`]).
pub struct Systemd(pub String, pub Option<u64>);

impl Systemd {
    pub fn new(world: String) -> Systemd {
        Systemd(world, None)
    }

    fn unit(&self) -> String {
        format!("worldd@{}.service", self.0)
    }

    /// systemd's count of the unit's automatic restarts (`Restart=always`): one more each time its process ends.
    fn restarts(&self) -> Option<u64> {
        let out = Command::new("systemctl")
            .args(["show", "--property=NRestarts", "--value", &self.unit()])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
}

impl Unit for Systemd {
    fn restart(&mut self) -> Result<(), String> {
        let unit = self.unit();
        let st = Command::new("systemctl")
            .args(["restart", "--no-block", &unit])
            .status()
            .map_err(|e| format!("restart: {e}"))?;
        self.1 = self.restarts();
        st.success()
            .then_some(())
            .ok_or_else(|| format!("restart: systemctl restart {unit}: {st}"))
    }

    fn exited(&mut self) -> Option<String> {
        let now = self.restarts()?;
        let unit = self.unit();
        exits_since(&mut self.1, now, &unit)
    }
}

/// [`Systemd::exited`]'s rule on a reading `now` of `NRestarts`: the lowest count seen (`low`) is the start's, since a
/// manual restart may reset the count after it was first read; a count above it means the process ended.
fn exits_since(low: &mut Option<u64>, now: u64, unit: &str) -> Option<String> {
    let least = *low.get_or_insert(now);
    if now > least {
        return Some(format!(
            "canary.exited: {unit} ended while starting ({} automatic restarts since the deploy's)",
            now - least
        ));
    }
    *low = Some(least.min(now));
    None
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

    /// The rehearsal alone (`deploy --rehearse-only`): `new` on a scratch copy of the world, as [`Deploy::run`]
    /// begins. It reads neither the store nor the pin, restarts nothing and writes only under `rehearsals/`.
    pub fn rehearse(&self, new: &[u8], probe: &mut Probe) -> Result<Rehearsal, String> {
        // Short, so its socket's path fits (104 bytes on macOS): one rehearsal of a build at a time on a machine.
        let scratch = self.root.join("rehearsals").join(&to_hex(new)[..16]);
        rehearse(
            &self.path(new),
            &state_path(self.root, &self.world),
            &scratch,
            self.window,
            &self.canary,
            probe,
        )
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
        let r = match self.rehearse(new, probe) {
            Ok(r) => r,
            Err(why) => {
                note(format!("rehearsal failed: {why}"));
                return (Ended::NotDeployed { why }, tl, None);
            }
        };
        if r.dropped_probe {
            note(
                "rehearsal.probe-dropped: a probe receipt of an earlier rehearsal no longer served"
                    .into(),
            );
        }
        note(format!(
            "rehearsed on a scratch copy: {} records copied, {} recorded intents fed, {} named ends",
            r.copied, r.fed, r.ended
        ));
        let before = records(&state);
        if let Err(why) = set_pin(self.store, &self.world, new) {
            return (Ended::NotDeployed { why }, tl, Some(r));
        }
        note(format!("pinned {}", &to_hex(new)[..16]));
        // The release's entries go in between the pin and the restart, so only the new build reads them. A swap that
        // fails leaves the world its own entries, as a deploy without them.
        let swapped = state.join(ENTRIES_NEXT).is_dir()
            && match swap_entries(&state, true) {
                Ok(()) => {
                    note(format!(
                        "entries: the release's; the world's own kept in {ENTRIES_BEFORE}"
                    ));
                    true
                }
                Err(e) => {
                    note(format!(
                        "entries: not swapped ({e}): the world keeps its own"
                    ));
                    false
                }
            };
        if let Err(why) = unit.restart() {
            // Not restarted onto them: the world's own go back, as a deploy that never took them.
            if swapped && swap_entries(&state, false).is_ok() {
                note("entries: the world's own put back".into());
            }
            return (Ended::NotDeployed { why }, tl, Some(r));
        }
        note("restarted: the canary watch begins".into());
        let socket = served_socket(self.root, &self.world);
        let fault = match watch_unit(&socket, &self.canary, probe, false, &mut || unit.exited()) {
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
        // Code rolls back, data never: the world's own entries go back only when the new build wrote nothing under
        // the release's (a body may already hold a slot only they declare).
        if swapped {
            if wrote {
                note("entries: the release's kept: the new build wrote records under them".into());
            } else {
                match swap_entries(&state, false) {
                    Ok(()) => note("entries: the world's own put back".into()),
                    Err(e) => note(format!("entries: the release's kept, not put back: {e}")),
                }
            }
        }
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
        watch(&served_socket(self.root, &self.world), &back, probe, true)?;
        note("serving again: the probe is answered".into());
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

    #[test]
    fn a2_the_start_bound_is_the_worlds_own_else_120_s() {
        // What world-limits.mjs writes for Eden (world-limits.test.mjs checks the same text).
        let eden = "# Written by world-limits.mjs from world-limits.json (world eden); edit that file, not this one.\n\
                    [Service]\nMemoryMax=8G\nEnvironment=WORLD_START_WITHIN_S=600\n";
        assert_eq!(start_within(Some(eden)), Duration::from_secs(600));
        assert_eq!(start_within(None), START_WITHIN);
        // R17: a slow store's start, not the unit's 30 s.
        assert_eq!(START_WITHIN, Duration::from_secs(120));
        assert_eq!(
            start_within(Some("[Service]\nMemoryMax=8G\n")),
            START_WITHIN
        );
        // Out of range or not a number: the unit's bound, never an unbounded wait.
        for bad in ["0", "3601", "ten", ""] {
            let t = format!("[Service]\nEnvironment=WORLD_START_WITHIN_S={bad}\n");
            assert_eq!(start_within(Some(&t)), START_WITHIN, "{bad}");
        }
    }

    /// R17: `NRestarts` read after the deploy's restart is the start's count; one more is an exit. A count that drops
    /// (systemd reset it at the manual restart, after it was first read) becomes the start's, and an exit after it still
    /// shows. No reading at all is no answer.
    #[test]
    fn r17_an_exit_is_a_restart_count_above_the_lowest_seen() {
        let u = "worldd@w.service";
        let mut low = Some(5);
        assert_eq!(exits_since(&mut low, 5, u), None);
        let e = exits_since(&mut low, 6, u).expect("an exit");
        assert!(
            e.starts_with("canary.exited: worldd@w.service ended"),
            "{e}"
        );
        assert!(e.contains("(1 automatic restarts"), "{e}");
        // Reset after the first reading: 0 is the start's, 0 again is no exit, 1 is one.
        let mut low = Some(5);
        assert_eq!(exits_since(&mut low, 0, u), None);
        assert_eq!(low, Some(0));
        assert_eq!(exits_since(&mut low, 0, u), None);
        assert!(exits_since(&mut low, 1, u).is_some());
        // No reading at the restart: the first one is the start's.
        let mut low = None;
        assert_eq!(exits_since(&mut low, 3, u), None);
        assert!(exits_since(&mut low, 4, u).is_some());
    }

    /// R17: the canary's wait for a slow start ends at once when the world's process ends, with that fault, and
    /// otherwise reaches a world that serves late or fails at its bound.
    #[test]
    fn r17_the_start_wait_fails_at_once_on_an_exit_and_waits_out_a_slow_start() {
        let dir = std::env::temp_dir().join(format!("r17-wait-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("w.sock");
        let _ = std::fs::remove_file(&sock);
        // An exit 1 s in: the fault within about half a second of it, far under the 120 s bound.
        let t0 = Instant::now();
        let mut exited = || {
            (t0.elapsed() >= Duration::from_secs(1))
                .then(|| "canary.exited: worldd@w ended".to_owned())
        };
        let e = connect_or_exit(&sock, START_WITHIN, &mut exited).unwrap_err();
        assert!(e.starts_with("canary.exited"), "{e}");
        assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
        // No exit, a socket 1.5 s in: reached.
        let late = sock.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            std::os::unix::net::UnixListener::bind(&late).unwrap()
        });
        assert!(connect_or_exit(&sock, Duration::from_secs(5), &mut || None).is_ok());
        drop(t.join().unwrap());
        std::fs::remove_file(&sock).unwrap();
        // No exit, no socket: not serving at the bound.
        let e = connect_or_exit(&sock, Duration::from_millis(800), &mut || None).unwrap_err();
        assert!(
            e.starts_with("canary.not-serving: no socket within 800 ms"),
            "{e}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fake build of the catch-up test: this test binary, run as that test's child.
    const CHILD: &str = "SOULS_REHEARSAL_CATCH_UP_CHILD";
    const NAME: &str = "deploy::tests::a_copy_that_answers_only_after_catching_up_passes_and_a_silent_one_is_refused";

    /// 0.134.0: a quiet world's copy caught its clock up for longer than a tick's wait before it answered the first
    /// fed intent; every later answer then counted for the tick after it and the last was never waited for, so a
    /// build that ended all 192 was refused `rehearsal.unanswered: 1 of 192`. The first answers have the start bound,
    /// the last tick waits for every answer, and a build that answers nothing is still refused.
    #[test]
    fn a_copy_that_answers_only_after_catching_up_passes_and_a_silent_one_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        if let Some(sock) = std::env::var_os(CHILD) {
            // The fake build: serves the socket, answers nothing for `delay` (catching up), then ends each intent.
            let delay = std::env::var("SOULS_REHEARSAL_DELAY_MS").unwrap();
            // `<ms>x`: the first ask came while the copy caught up, so it expired before it was taken (0.136's Eden).
            let (delay, mut expire) = match delay.strip_suffix('x') {
                Some(d) => (d.to_owned(), true),
                None => (delay, false),
            };
            let listener = std::os::unix::net::UnixListener::bind(sock).unwrap();
            let (mut s, _) = listener.accept().unwrap();
            let Ok(ms) = delay.parse::<u64>() else {
                loop {
                    std::thread::park();
                }
            };
            std::thread::sleep(Duration::from_millis(ms));
            while let Ok(frame) = read_or_closed(&mut s, Duration::from_secs(30)) {
                let Value::Map(m) = decode(&frame).unwrap().value else {
                    panic!("a map")
                };
                let answer = match m.get(&wire::ASK) {
                    Some(n) if std::mem::take(&mut expire) => Value::Map(BTreeMap::from([
                        (wire::ASK, n.clone()),
                        (
                            wire::REFUSED,
                            Value::Text(Name::new("intent.expired").unwrap()),
                        ),
                    ])),
                    Some(n) => Value::Map(BTreeMap::from([
                        (1, Value::Uint(1)),
                        (wire::ASK, n.clone()),
                        (wire::IDS, Value::Array(vec![Value::Bytes(vec![1])])),
                    ])),
                    None => Value::Map(BTreeMap::from([(
                        2,
                        Value::Map(BTreeMap::from([
                            (2, m[&2].clone()),
                            (3, Value::Uint(2)),
                            (4, Value::Text(Name::new("intent.expired").unwrap())),
                        ])),
                    )])),
                };
                assert!(send(&mut s, &encode(&answer).unwrap()));
            }
            std::process::exit(0);
        }
        let dir = std::env::temp_dir().join(format!("catch-up-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = dir.join("w");
        std::fs::create_dir_all(&state).unwrap();
        // The import's part, then three ticks that each answered one intent (its sequence is all the fake reads).
        let (mut log, _) = Log::open(FileStore::open(&log_path(&state)).unwrap(), 1).unwrap();
        log.append(encode(&Value::Map(BTreeMap::new())).unwrap())
            .unwrap();
        for seq in 1..=3 {
            let intent = Value::Map(BTreeMap::from([(2, Value::Uint(seq))]));
            let row = Value::Map(BTreeMap::from([(5, intent)]));
            let part = Value::Map(BTreeMap::from([(ANSWERED, Value::Array(vec![row]))]));
            log.append(encode(&part).unwrap()).unwrap();
        }
        log.wait_durable(4).unwrap();
        drop(log.close());
        let exe = std::env::current_exe().unwrap();
        let quoted = format!("'{}'", exe.to_string_lossy().replace('\'', "'\\''"));
        // A tick's wait is 4 × 200 ms; the copy answers 1.5 s in, well within its 5 s start bound.
        let c = Canary {
            window: Duration::from_secs(1),
            start_within: Duration::from_secs(5),
            answer_within: Duration::from_millis(200),
            every: Duration::from_millis(100),
        };
        let rehearse_with = |state: &Path, delay: &str| {
            // The rehearsal clears the build's environment, so the script names what the fake reads.
            let build = dir.join(format!("build-{delay}"));
            std::fs::write(
                &build,
                format!(
                    "#!/bin/sh\nexport {CHILD}=\"$5\" SOULS_REHEARSAL_DELAY_MS={delay}\n\
                     exec {quoted} --exact {NAME} --nocapture\n"
                ),
            )
            .unwrap();
            std::fs::set_permissions(&build, std::fs::Permissions::from_mode(0o755)).unwrap();
            let mut probe = Probe::Ask(0);
            rehearse(&build, state, &dir.join("r"), 3, &c, &mut probe)
        };
        let r = rehearse_with(&state, "1500").expect("every fed intent ended, late or not");
        assert_eq!((r.copied, r.fed, r.ended), (1, 3, 3));
        assert_eq!(r.refused.get("intent.expired"), Some(&3));
        let e = rehearse_with(&state, "never").unwrap_err();
        assert_eq!(
            e, "rehearsal.unanswered: 3 of 3 recorded intents reached no named end",
            "a copy that never answers is still refused"
        );
        // 0.136's Eden: a window of quiet records feeds no intent, so the probe was the copy's first ask and met its
        // catch-up with a tick's wait (`rehearsal.canary.unanswered`). The probe then has the start bound.
        let quiet = dir.join("q");
        std::fs::create_dir_all(&quiet).unwrap();
        let (mut log, _) = Log::open(FileStore::open(&log_path(&quiet)).unwrap(), 1).unwrap();
        for _ in 0..4 {
            log.append(encode(&Value::Map(BTreeMap::new())).unwrap())
                .unwrap();
        }
        log.wait_durable(4).unwrap();
        drop(log.close());
        let r = rehearse_with(&quiet, "1500").expect("the probe is answered after the catch-up");
        assert_eq!((r.copied, r.fed, r.ended), (1, 0, 0));
        assert!(
            rehearse_with(&quiet, "never").is_err(),
            "a quiet copy that never answers is still refused"
        );
        // 0.136 on 02d99b61: the probe sent during the catch-up expired before the copy took it
        // (`rehearsal.canary.refused: intent.expired`). It is sent again, and the copy caught up answers it.
        let r =
            rehearse_with(&quiet, "1500x").expect("a probe expired in the catch-up is sent again");
        assert_eq!((r.copied, r.fed, r.ended), (1, 0, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `deploy --rehearse-only`: the rehearsal alone passes or fails as a deploy's would, and moves no pin, restarts
    /// nothing and writes nothing outside `rehearsals/`: the world's folder, its build and the store stay as they were.
    #[test]
    fn a_rehearsal_alone_moves_no_pin_and_writes_only_its_scratch() {
        use directoryd::directory::store::Memory;
        use std::os::unix::fs::PermissionsExt;
        fn files(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    files(&p, out);
                } else if p.is_file() {
                    // Not the scratch copy's socket.
                    out.insert(p.clone(), std::fs::read(&p).unwrap());
                }
            }
        }
        // Short: the scratch socket, `<root>/rehearsals/<16 hex>/gateway.sock`, must fit 104 bytes on macOS.
        let root = std::env::temp_dir().join(format!("ro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let world = World {
            lineage: [7; 16],
            zone: Id::new(Scope([8; 16]), 1).unwrap(),
        };
        let state = state_path(&root, &world);
        std::fs::create_dir_all(&state).unwrap();
        // The import's part, then two ticks that each answered one intent.
        let (mut log, _) = Log::open(FileStore::open(&log_path(&state)).unwrap(), 1).unwrap();
        log.append(encode(&Value::Map(BTreeMap::new())).unwrap())
            .unwrap();
        for seq in 1..=2 {
            let intent = Value::Map(BTreeMap::from([(2, Value::Uint(seq))]));
            let row = Value::Map(BTreeMap::from([(5, intent)]));
            let part = Value::Map(BTreeMap::from([(ANSWERED, Value::Array(vec![row]))]));
            log.append(encode(&part).unwrap()).unwrap();
        }
        log.wait_durable(3).unwrap();
        drop(log.close());
        let (old, new) = (crate::build_hash(b"old"), crate::build_hash(b"new"));
        let store = Memory::default();
        set_pin(&store, &world, &old).unwrap();
        // The new build staged by hash: the catch-up test's fake, answering at once.
        let build = build_path(&root, &new);
        std::fs::create_dir_all(build.parent().unwrap()).unwrap();
        let exe = std::env::current_exe().unwrap();
        let quoted = format!("'{}'", exe.to_string_lossy().replace('\'', "'\\''"));
        std::fs::write(
            &build,
            format!(
                "#!/bin/sh\nexport {CHILD}=\"$5\" SOULS_REHEARSAL_DELAY_MS=0\n\
                 exec {quoted} --exact {NAME} --nocapture\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&build, std::fs::Permissions::from_mode(0o755)).unwrap();
        // The world's entries and the release's staged ones: the rehearsal runs on the release's.
        for (d, text) in [("entries", "old"), (ENTRIES_NEXT, "new")] {
            std::fs::create_dir_all(state.join(d)).unwrap();
            std::fs::write(state.join(d).join("a.json"), text).unwrap();
        }
        let mut before = BTreeMap::new();
        files(&root, &mut before);
        let d = Deploy {
            store: &store,
            root: &root,
            world,
            canary: Canary {
                window: Duration::from_secs(1),
                start_within: Duration::from_secs(5),
                answer_within: Duration::from_millis(200),
                every: Duration::from_millis(100),
            },
            window: 2,
        };
        let r = d
            .rehearse(&new, &mut Probe::Ask(0))
            .expect("the rehearsal passes");
        assert_eq!((r.copied, r.fed, r.ended), (1, 2, 2));
        assert!(r.served_kept, "{r:?}");
        assert!(r.scratch.starts_with(root.join("rehearsals")), "{r:?}");
        assert_eq!(
            std::fs::read_to_string(r.scratch.join("entries/a.json")).unwrap(),
            "new",
            "rehearsed on the release's entries"
        );
        let mut after = BTreeMap::new();
        files(&root, &mut after);
        after.retain(|p, _| !p.starts_with(root.join("rehearsals")));
        assert_eq!(after, before, "nothing outside rehearsals/ was written");
        assert_eq!(
            pin(&store, &root, &world).unwrap().0,
            old,
            "the pin never moved"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The restart's swap: the release's entries in, the world's own kept beside them, and back.
    #[test]
    fn the_release_s_entries_swap_in_and_back_whole() {
        let state = std::env::temp_dir().join(format!("swap-entries-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&state);
        let read = |d: &str| std::fs::read_to_string(state.join(d).join("a.json")).unwrap();
        for (d, text) in [
            ("entries", "old"),
            (ENTRIES_BEFORE, "older"),
            (ENTRIES_NEXT, "new"),
        ] {
            std::fs::create_dir_all(state.join(d)).unwrap();
            std::fs::write(state.join(d).join("a.json"), text).unwrap();
        }
        swap_entries(&state, true).unwrap();
        assert_eq!(
            (read("entries"), read(ENTRIES_BEFORE)),
            ("new".into(), "old".into())
        );
        assert!(!state.join(ENTRIES_NEXT).exists());
        swap_entries(&state, false).unwrap();
        assert_eq!(
            (read("entries"), read(ENTRIES_NEXT)),
            ("old".into(), "new".into())
        );
        assert!(!state.join(ENTRIES_BEFORE).exists());
        // Nothing to swap in: the second rename fails, and the first is undone.
        std::fs::remove_dir_all(state.join(ENTRIES_NEXT)).unwrap();
        assert!(swap_entries(&state, true).is_err());
        assert_eq!(read("entries"), "old", "never left without entries");
        let _ = std::fs::remove_dir_all(&state);
    }

    /// 0.136.0's move: 1dad restarted on the new build catching up two quiet hours, and the live watch's first operator
    /// act had a tick's 2 s (`canary.unanswered: operator act`); the old build, restarted from the new one's records,
    /// had nothing to catch up. A world that answers its first ask only after catching up, and that ask expired, is
    /// watched healthy; one that never answers still fails.
    #[test]
    fn a_watch_waits_out_a_restarted_worlds_catch_up_and_fails_a_silent_one() {
        let dir = std::env::temp_dir().join(format!("catch-up-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = Canary {
            window: Duration::from_millis(600),
            start_within: Duration::from_secs(5),
            answer_within: Duration::from_millis(200),
            every: Duration::from_millis(100),
        };
        // A world that catches up for `delay` ms, then answers asks; its first ask expired in the catch-up.
        let world = |sock: PathBuf, delay: Option<u64>| {
            let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
            std::thread::spawn(move || {
                let (mut s, _) = listener.accept().unwrap();
                let Some(ms) = delay else {
                    std::thread::sleep(Duration::from_secs(8));
                    return;
                };
                std::thread::sleep(Duration::from_millis(ms));
                let mut expire = true;
                while let Ok(frame) = read_or_closed(&mut s, Duration::from_secs(10)) {
                    let Value::Map(m) = decode(&frame).unwrap().value else {
                        panic!("a map")
                    };
                    let n = m[&wire::ASK].clone();
                    let answer = if std::mem::take(&mut expire) {
                        Value::Map(BTreeMap::from([
                            (wire::ASK, n),
                            (
                                wire::REFUSED,
                                Value::Text(Name::new("intent.expired").unwrap()),
                            ),
                        ]))
                    } else {
                        Value::Map(BTreeMap::from([
                            (1, Value::Uint(1)),
                            (wire::ASK, n),
                            (wire::IDS, Value::Array(vec![Value::Bytes(vec![1])])),
                        ]))
                    };
                    if !send(&mut s, &encode(&answer).unwrap()) {
                        return;
                    }
                }
            })
        };
        let sock = dir.join("late.sock");
        let t = world(sock.clone(), Some(1500));
        watch(&sock, &c, &mut Probe::Ask(0), false).expect("healthy once caught up");
        drop(t);
        let sock = dir.join("silent.sock");
        let _t = world(sock.clone(), None);
        assert!(
            watch(&sock, &c, &mut Probe::Ask(0), false).is_err(),
            "a world that never answers still fails"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a2_the_wait_serves_a_late_world_within_its_bound_and_fails_a_hung_one_at_it() {
        let dir = std::env::temp_dir().join(format!("4013-wait-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("w.sock");
        let _ = std::fs::remove_file(&sock);
        // A world that serves after 1.5 s: reached under a 3 s bound, where a 1 s bound would have failed it.
        let late = sock.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            std::os::unix::net::UnixListener::bind(&late).unwrap()
        });
        assert!(connect(&sock, Duration::from_secs(1)).is_none());
        assert!(connect(&sock, Duration::from_secs(3)).is_some());
        let listener = t.join().unwrap();
        // A world that never serves fails at its bound, not before and not much after.
        drop(listener);
        std::fs::remove_file(&sock).unwrap();
        let t0 = Instant::now();
        assert!(connect(&sock, Duration::from_millis(800)).is_none());
        let took = t0.elapsed();
        assert!(
            took >= Duration::from_millis(800) && took < Duration::from_millis(1500),
            "{took:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
