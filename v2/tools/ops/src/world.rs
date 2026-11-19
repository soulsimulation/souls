//! `ops world`: one world process of a move (O9, #2828), the benches' world (1,000 bodies, 9,000 things; O3's drill
//! world) with its log (K4) and checkpoints (K5) in its own data folder, shipped by worldd's shipper (O3) under its
//! own claim. It reads commands on stdin and answers on stdout, one line each:
//!
//! ```text
//! in:  i <id> <agent> <epoch>      an intent, stamped with the epoch the gate sent it under
//!      drain                       source: run what is queued, seal and ship the last piece, move the mark, stop
//!      resume                      source: the move failed before the fence; ship and tick again
//!      prepare                     target: fetch the newest checkpoint and the pieces after it, while the source runs
//!      fence <sealed> <epoch>      target: fetch the last pieces, prove the exact version, claim (supervisor::moving)
//!      start                       target: open the log, start the clock at the next tick and pay the time owed
//!      stop                        ship what is left and exit
//! out: claimed <epoch> <pid>, serving <epoch> <tick>, tick <n>, ack <id> <epoch> <record> <tick>,
//!      refuse <id> <name>, prepared <record> <ms>, drained <sealed>, fenced <epoch> <ms>, unfenced <name>,
//!      caught <owed ticks> <ms>, stopped
//! ```
//!
//! Tick `n` is due at `t0 + n × 50 ms` of real time (the world's mapping, `v2/docs/time.md`); a world behind runs its
//! owed ticks back to back. `--restart` rebuilds a world whose process died: from its own folder (its log, after its
//! base record) and the bucket (the records before), then claims a new epoch.

use std::cell::RefCell;
use std::collections::{BTreeSet, VecDeque};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;

use archive::script::{self, TICK, World};
use archive::{R, Shared, refuse};
use directoryd::directory::store::Store;
use directoryd::directory::{Claim, Directory};
use replica::directory::WorldRecord;
use replica::durability::part_key;
use replica::effects::{Effect, Part, Refusal};
use replica::encode::{Name, to_hex};
use replica::ids::{Scope, Version};
use replica::pose::{HandOff, Owner, Vec3};
use sim::checkpoint::{Blobs, Checkpoints, replay};
use sim::log::{FileStore, Log};
use supervisor::folder::Folder;
use supervisor::moving::{self, Sealed};
use worldd::shipping::{self, Item, Mark, Piece, Shipper, Uploads, Wall};

/// The world's rooms (ten bodies each) and things per room: 1,000 bodies and 9,000 things.
pub const ROOMS: usize = 100;
pub const THINGS: usize = 90;
/// K5's interval: a checkpoint each 256 KiB of log (O3's drill).
const EVERY: u64 = 256 << 10;
/// A checkpoint shipped at most each 20 s (O3's drill).
const GAP_US: u64 = 20_000_000;
/// A build hash for the directory record (the scripted world's build is not pinned anywhere).
const BUILD: [u8; 34] = [0x12; 34];

pub type Bucket = Shared<Folder>;

fn io<T>(r: std::io::Result<T>) -> R<T> {
    r.or_else(|e| refuse("io", e.to_string()))
}

/// Real time, µs since 1970: the world's mapping from ticks to real time is in it.
#[allow(clippy::disallowed_methods)] // Operations: the clock's mapping to real time is wall time (K7 allows it here).
pub fn unix_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

pub fn err(name: &'static str, detail: &str) -> Refusal {
    Refusal {
        name,
        detail: detail.to_owned(),
    }
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn tick_of(at: i64) -> u64 {
    (at / TICK).max(0) as u64
}

/// One act: body `ix` takes a step at tick `tick` (O3's drill act).
fn step(w: &mut World, ix: usize, tick: u64) -> Effect {
    let (b, room) = (w.bodies[ix], w.rooms[ix / 10]);
    let at = tick as i64 * TICK;
    let x = (ix % 10) as i64 * 1000 + (tick % 1000) as i64;
    let mut e = w.entry(
        b,
        vec![replica::effects::Change::Motion(HandOff {
            node: b,
            at,
            from: Owner::Mover,
            to: Owner::Mover,
            pose: script::world::pose(room, None, x),
            linear: Vec3::new(20_000, 0, 0),
            angular: Vec3::ZERO,
        })],
    );
    e.envelope.at = at;
    e
}

/// The exact version a tree holds.
pub fn version_of(w: &World, records: u64, tick: u64) -> R<Sealed> {
    Ok(Sealed {
        records,
        next: w.tree.next(),
        hash: to_hex(&replica::hash::state_hash(&w.tree)?.to_bytes()),
        tick,
    })
}

/// The pieces in force from record `at` on, in order, until none follows (O3's fetch, from any record).
pub fn pieces_from<S: Store>(store: &S, rec: &WorldRecord, mut at: u64) -> R<Vec<Piece>> {
    let mut out = Vec::new();
    while let Some(t) = rec.in_force(at) {
        let key = part_key(&rec.lineage, rec.zone, t, at);
        let Some(o) = store.get(&key)? else {
            break;
        };
        let p = Piece::read(&o.bytes)?;
        if p.first != at || p.records.is_empty() {
            return refuse("piece-gap", format!("{key}: starts at {}", p.first));
        }
        at += p.records.len() as u64;
        out.push(p);
    }
    Ok(out)
}

/// A world rebuilt: its tree in `w`, the records it holds, the last tick a record names, and the checkpoint's records.
struct Rebuilt {
    w: World,
    records: u64,
    last_tick: Option<u64>,
    blobs: Blobs,
}

/// The scripted world built without a log: its ids (rooms, bodies) and header, which every process shares.
pub fn ids() -> World {
    ids_world()
}

fn ids_world() -> World {
    script::world(ROOMS, THINGS, None)
}

/// Replays `records` (numbered from `first`) on `w` from record `from` on, noting the last tick they name.
fn apply(
    w: &mut World,
    first: u64,
    records: &[Vec<u8>],
    from: u64,
    last: &mut Option<u64>,
) -> R<u64> {
    let skip = from.saturating_sub(first);
    let header = w.header.clone();
    replay(&mut w.tree, &header, records, skip)?;
    for b in records.iter().skip(skip as usize) {
        if let Some(at) = Part::read(b)?.effects.iter().map(|e| e.envelope.at).max() {
            *last = Some(tick_of(at));
        }
    }
    Ok(first + records.len() as u64)
}

/// From the bucket alone: the newest shipped checkpoint and the pieces in force after it, up to `upto` records.
fn from_bucket(
    store: &Bucket,
    lineage: &[u8; 16],
    zone: replica::ids::Id,
    scratch: &Path,
    upto: Option<u64>,
) -> R<Rebuilt> {
    let f = shipping::fetch(store, lineage, zone)?;
    let mut w = ids_world();
    let (mut records, mut blobs, mut last) = (0, Blobs::default(), None);
    if let Some((at, bytes)) = &f.checkpoint {
        let _ = std::fs::remove_dir_all(scratch);
        io(std::fs::create_dir_all(scratch))?;
        io(std::fs::write(
            scratch.join(format!("ckpt-{at:020}")),
            bytes,
        ))?;
        let Some(r) = sim::checkpoint::restore(scratch)? else {
            return refuse("checkpoint-missing", "the shipped checkpoint did not read");
        };
        let _ = std::fs::remove_dir_all(scratch);
        w.tree = r.tree;
        blobs = r.blobs;
        records = r.root.record;
    } else {
        w.tree = World::new().tree;
    }
    for p in &f.pieces {
        let end = p.first + p.records.len() as u64;
        let take = match upto {
            Some(u) if end > u => &p.records[..(u.saturating_sub(p.first)) as usize],
            _ => &p.records[..],
        };
        if p.first + take.len() as u64 <= records {
            continue;
        }
        records = apply(&mut w, p.first, take, records, &mut last)?;
    }
    w.next = w.tree.next();
    Ok(Rebuilt {
        w,
        records,
        last_tick: last,
        blobs,
    })
}

/// A record appended, not yet on the disk: its number, bytes, acts, the intents it holds and its tick.
type Pending = (u64, Vec<u8>, u64, Vec<u64>, u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// The target before its fence: no claim, no clock.
    Waiting,
    Serving,
    Draining,
    /// The source after its drain: it writes nothing.
    Drained,
}

/// The process's writer: its world, log, checkpoints, shipper and claim.
struct Writer {
    store: Bucket,
    machine: Name,
    dir: PathBuf,
    t0: u64,
    w: World,
    queue_parts: Rc<RefCell<Vec<Vec<u8>>>>,
    lineage: [u8; 16],
    zone: replica::ids::Id,
    log: Option<Log<FileStore>>,
    base: u64,
    appended: u64,
    ckpts: Option<Checkpoints>,
    blobs: Option<Blobs>,
    ship: Option<(Sender<Item>, Mark, JoinHandle<R<Uploads>>)>,
    claim: Option<Claim>,
    epoch: u64,
    pending: VecDeque<Pending>,
    intents: VecDeque<(u64, u32)>,
    tick: u64,
    state: State,
    sealed: Option<Sealed>,
    owed: Option<(u64, u64)>,
}

impl Writer {
    fn new(store: Bucket, machine: Name, dir: &Path, t0: u64, w: World) -> Writer {
        let (lineage, zone) = (w.header.lineage.0, w.header.zone);
        Writer {
            store,
            machine,
            dir: dir.to_path_buf(),
            t0,
            w,
            queue_parts: Rc::default(),
            lineage,
            zone,
            log: None,
            base: 0,
            appended: 0,
            ckpts: None,
            blobs: None,
            ship: None,
            claim: None,
            epoch: 0,
            pending: VecDeque::new(),
            intents: VecDeque::new(),
            tick: 0,
            state: State::Waiting,
            sealed: None,
            owed: None,
        }
    }

    fn directory(&self) -> Directory<Bucket> {
        Directory::new(self.store.clone(), self.machine.clone())
    }

    fn hook_log(&mut self) {
        let q = self.queue_parts.clone();
        self.w.log = Some(Box::new(move |b: &[u8]| q.borrow_mut().push(b.to_vec())));
    }

    fn claimed(&mut self, claim: Claim) {
        self.epoch = claim.takeover.epoch;
        say(&format!("claimed {} {}", self.epoch, std::process::id()));
        self.claim = Some(claim);
    }

    /// Opens the shipper under the claim at record `first`.
    fn open_shipper(&mut self, first: u64) -> R<()> {
        let claim = self
            .claim
            .clone()
            .ok_or_else(|| err("unclaimed", "no claim to ship under"))?;
        let shipper = Shipper::open(
            self.directory(),
            claim,
            self.lineage,
            self.zone,
            self.w.header.stored(),
            first,
            Wall::start(),
        )?
        .checkpoints(&self.dir.join("ckpt"), GAP_US);
        self.ship = Some(shipper.spawn());
        Ok(())
    }

    /// Opens the local log, with `base` the global number of its first record, and the checkpoint writer.
    fn open_log(&mut self, base: u64) -> R<Vec<Vec<u8>>> {
        io(std::fs::create_dir_all(&self.dir))?;
        if base > 0 {
            io(std::fs::write(self.dir.join("base"), base.to_string()))?;
        }
        let (log, found) = Log::open(FileStore::open(&self.dir.join("log"))?, 1)?;
        self.base = base;
        self.appended = base + found.records.len() as u64;
        self.log = Some(log);
        let blobs = self.blobs.take().unwrap_or_default();
        self.ckpts = Some(Checkpoints::open(&self.dir.join("ckpt"), EVERY, blobs)?);
        Ok(found.records)
    }

    fn start_clock(&mut self, tick: u64) {
        self.tick = tick;
        self.state = State::Serving;
        let due = self.t0 + tick * TICK as u64;
        let now = unix_us();
        self.owed = Some((now.saturating_sub(due) / TICK as u64, now));
        say(&format!("serving {} {tick}", self.epoch));
    }

    // --- Ticks and acknowledgements ------------------------------------------------------------------------------

    fn run_tick(&mut self) -> R<()> {
        let tick = self.tick;
        let mut seen = BTreeSet::new();
        let mut ids = Vec::new();
        let mut later = VecDeque::new();
        let mut entries = Vec::new();
        while let Some((id, agent)) = self.intents.pop_front() {
            // A body steps at most once a tick: a second intent for it waits for the next.
            if !seen.insert(agent) {
                later.push_back((id, agent));
                continue;
            }
            entries.push(step(&mut self.w, agent as usize, tick));
            ids.push(id);
        }
        self.intents = later;
        if !entries.is_empty() {
            self.w.commit(entries);
        }
        let parts: Vec<Vec<u8>> = self.queue_parts.borrow_mut().drain(..).collect();
        let log = self
            .log
            .as_mut()
            .ok_or_else(|| err("no-log", "ticking with no log"))?;
        let count = parts.len();
        for (i, p) in parts.into_iter().enumerate() {
            let acts = Part::read(&p)?.effects.len() as u64;
            if let Some(c) = &mut self.ckpts {
                c.appended(p.len() as u64);
            }
            let record = self.base + log.append(p.clone())?;
            self.appended = record + 1;
            let mine = if i + 1 == count {
                std::mem::take(&mut ids)
            } else {
                Vec::new()
            };
            self.pending.push_back((record, p, acts, mine, tick));
        }
        if let Some(c) = &mut self.ckpts
            && c.due()
        {
            let v = Version {
                lineage: Scope(self.lineage),
                zone: self.zone,
                epoch: self.epoch,
                sequence: self.w.tree.next(),
            };
            c.take(&mut self.w.tree, v, self.appended, &[])?;
        }
        say(&format!("tick {tick}"));
        self.tick += 1;
        Ok(())
    }

    /// Acknowledges what is on the disk and hands it to the shipper.
    fn ack(&mut self) -> R<()> {
        let Some(log) = &self.log else {
            return Ok(());
        };
        let durable = self.base + log.durable();
        while self.pending.front().is_some_and(|p| p.0 < durable) {
            let Some((record, bytes, acts, ids, tick)) = self.pending.pop_front() else {
                break;
            };
            for id in ids {
                say(&format!("ack {id} {} {record} {tick}", self.epoch));
            }
            if let Some((tx, _, _)) = &self.ship {
                tx.send(Item {
                    record,
                    bytes,
                    acts,
                    stakes: false,
                })
                .or_else(|_| refuse("ship-stopped", "the shipper stopped"))?;
            }
        }
        Ok(())
    }

    /// Waits for every record on the disk, acknowledges, and lets the shipper ship what is left and stop.
    fn seal(&mut self) -> R<()> {
        if let Some(log) = &self.log {
            log.wait_durable(self.appended - self.base)?;
        }
        self.ack()?;
        if let Some((tx, _, h)) = self.ship.take() {
            drop(tx);
            h.join().unwrap_or_else(|p| std::panic::resume_unwind(p))?;
        }
        Ok(())
    }

    // --- Commands ------------------------------------------------------------------------------------------------

    fn command(&mut self, line: &str, scratch: &Path) -> R<bool> {
        let f: Vec<&str> = line.split_whitespace().collect();
        match f.as_slice() {
            ["i", id, agent, epoch] => {
                let (Ok(id), Ok(agent), Ok(epoch)) = (
                    id.parse::<u64>(),
                    agent.parse::<u32>(),
                    epoch.parse::<u64>(),
                ) else {
                    return Ok(true);
                };
                if epoch != self.epoch || !matches!(self.state, State::Serving | State::Draining) {
                    // Whoever stores checks the number: an intent for another epoch is never written here.
                    say(&format!("refuse {id} epoch-other"));
                } else {
                    self.intents.push_back((id, agent));
                }
            }
            ["drain"] if self.state == State::Serving => self.state = State::Draining,
            ["resume"] if self.state == State::Drained => {
                let Some(s) = self.sealed.take() else {
                    return refuse("unsealed", "resume before a drain");
                };
                let mut d = self.directory();
                let mut claim = self
                    .claim
                    .take()
                    .ok_or_else(|| err("unclaimed", "resume with no claim"))?;
                // The claim's version is read again: the mark moved at the drain.
                d.ship(&mut claim, s.records - 1)?;
                self.claim = Some(claim);
                self.open_shipper(s.records)?;
                self.start_clock(s.tick + 1);
            }
            ["prepare"] => {
                let t = unix_us();
                let r = from_bucket(&self.store, &self.lineage, self.zone, scratch, None)?;
                self.w = r.w;
                self.appended = r.records;
                self.blobs = Some(r.blobs);
                say(&format!(
                    "prepared {} {}",
                    r.records,
                    (unix_us() - t) / 1000
                ));
            }
            ["fence", rest @ ..] if rest.len() == 5 => {
                let t = unix_us();
                let (Some(sealed), Ok(source)) =
                    (Sealed::parse(&rest[..4]), rest[4].parse::<u64>())
                else {
                    return refuse("usage", line.to_owned());
                };
                let got = self.fence(&sealed, source);
                match got {
                    Ok(claim) => {
                        self.claimed(claim);
                        self.sealed = Some(sealed);
                        say(&format!("fenced {} {}", self.epoch, (unix_us() - t) / 1000));
                    }
                    Err(e) => say(&format!(
                        "unfenced {} {}",
                        e.name,
                        e.detail.replace('\n', " ")
                    )),
                }
            }
            ["start"] if self.claim.is_some() && self.state == State::Waiting => {
                let Some(s) = self.sealed.clone() else {
                    return refuse("unsealed", "start before a fence");
                };
                self.open_log(s.records)?;
                self.hook_log();
                self.open_shipper(s.records)?;
                self.start_clock(s.tick + 1);
            }
            ["stop"] => {
                if matches!(self.state, State::Serving | State::Draining) {
                    self.seal()?;
                }
                if let Some(c) = &self.ckpts {
                    c.wait()?;
                }
                say("stopped");
                return Ok(false);
            }
            _ => eprintln!("world: ignored {line:?} in {:?}", self.state),
        }
        Ok(true)
    }

    /// Step 3 on the target: the pieces after what it prepared, the exact version, then the claim.
    fn fence(&mut self, sealed: &Sealed, source: u64) -> R<Claim> {
        let rec = self.directory().world(&self.lineage, self.zone)?;
        let mut last = None;
        for p in pieces_from(&self.store, &rec, self.appended)? {
            self.appended = apply(&mut self.w, p.first, &p.records, self.appended, &mut last)?;
        }
        self.w.next = self.w.tree.next();
        let reached = version_of(&self.w, self.appended, sealed.tick)?;
        let mut d = self.directory();
        moving::fence(&mut d, &self.lineage, self.zone, source, sealed, &reached)
    }

    /// Step 2 on the source, once its queue is empty: seal, ship, move the mark to the last record, report.
    fn drained(&mut self) -> R<()> {
        self.seal()?;
        let mut claim = self
            .claim
            .take()
            .ok_or_else(|| err("unclaimed", "drain with no claim"))?;
        let mut d = self.directory();
        d.ship(&mut claim, self.appended - 1)?;
        self.claim = Some(claim);
        let s = version_of(&self.w, self.appended, self.tick - 1)?;
        say(&format!("drained {}", s.line()));
        self.sealed = Some(s);
        self.state = State::Drained;
        Ok(())
    }

    fn serve(&mut self, rx: Receiver<String>, scratch: &Path) -> R<()> {
        loop {
            loop {
                match rx.try_recv() {
                    Ok(line) => {
                        if !self.command(&line, scratch)? {
                            return Ok(());
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    // The conductor is gone: stop as on `stop`.
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        self.command("stop", scratch)?;
                        return Ok(());
                    }
                }
            }
            let mut wait = 5_000u64;
            if matches!(self.state, State::Serving | State::Draining) {
                let due = self.t0 + self.tick * TICK as u64;
                let now = unix_us();
                if now >= due {
                    self.run_tick()?;
                    self.ack()?;
                    if self.state == State::Draining && self.intents.is_empty() {
                        self.drained()?;
                    }
                    continue;
                }
                if let Some((owed, since)) = self.owed.take() {
                    say(&format!("caught {owed} {}", (now - since) / 1000));
                }
                wait = wait.min(due - now);
            }
            self.ack()?;
            std::thread::sleep(std::time::Duration::from_micros(wait));
        }
    }
}

fn stdin_lines() -> Receiver<String> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

/// `ops world <source|target> <dir> <bucket> <t0 µs> <machine> [--restart]`.
pub fn run(args: &[String]) -> R<()> {
    let [role, dir, bucket, t0, machine, rest @ ..] = args else {
        return refuse(
            "usage",
            "ops world <source|target> <dir> <bucket> <t0> <machine> [--restart]",
        );
    };
    let dir = PathBuf::from(dir);
    let t0: u64 = t0
        .parse()
        .or_else(|_| refuse("usage", "t0 is µs since 1970"))?;
    let machine = Name::new(machine).ok_or_else(|| err("usage", "a machine name"))?;
    let restart = rest.iter().any(|a| a == "--restart");
    let store = Shared(Arc::new(Folder::new(PathBuf::from(bucket))));
    let scratch = dir.with_extension("scratch");
    let rx = stdin_lines();
    let mut wr;
    if restart {
        wr = restart_world(store, machine, &dir, t0, &scratch)?;
    } else if role == "source" {
        // A new world: built here, its build's parts the first records of the log.
        wr = Writer::new(store, machine, &dir, t0, World::new());
        wr.hook_log();
        for _ in 0..ROOMS {
            wr.w.room(10, THINGS);
        }
        let mut d = wr.directory();
        d.set_build(&wr.lineage, wr.zone, &BUILD)?;
        let claim = d.claim(&wr.lineage, wr.zone)?;
        wr.claimed(claim);
        wr.open_log(0)?;
        let parts: Vec<Vec<u8>> = wr.queue_parts.borrow_mut().drain(..).collect();
        let log = wr.log.as_mut().ok_or_else(|| err("no-log", ""))?;
        for p in parts {
            let acts = Part::read(&p)?.effects.len() as u64;
            let record = log.append(p.clone())?;
            wr.pending.push_back((record, p, acts, Vec::new(), 0));
        }
        wr.appended = wr.pending.len() as u64;
        wr.open_shipper(0)?;
        wr.start_clock(0);
    } else {
        wr = Writer::new(store, machine, &dir, t0, ids_world());
    }
    wr.serve(rx, &scratch)
}

/// A world whose process died, rebuilt and claimed again: its log after its base record, and the bucket before it.
fn restart_world(store: Bucket, machine: Name, dir: &Path, t0: u64, scratch: &Path) -> R<Writer> {
    let base: Option<u64> = std::fs::read_to_string(dir.join("base"))
        .ok()
        .and_then(|s| s.trim().parse().ok());
    let has_log = dir.join("log").exists();
    let mut wr = Writer::new(store.clone(), machine, dir, t0, ids_world());
    let (lineage, zone) = (wr.lineage, wr.zone);
    let mut last = None;
    let (tree_from, base) = match (base, has_log) {
        // The source's own folder: its newest local checkpoint, then its log.
        (None, true) => {
            let r = sim::checkpoint::restore(&dir.join("ckpt"))?;
            match r {
                Some(r) => {
                    wr.w.tree = r.tree;
                    wr.blobs = Some(r.blobs);
                    (r.root.record, 0)
                }
                None => {
                    wr.w.tree = World::new().tree;
                    (0, 0)
                }
            }
        }
        // A target: the bucket up to its base, then its log; or the bucket alone when it never opened one.
        (b, _) => {
            let r = from_bucket(&store, &lineage, zone, scratch, b)?;
            wr.w = r.w;
            wr.blobs = Some(r.blobs);
            last = r.last_tick;
            (r.records, b.unwrap_or(r.records))
        }
    };
    let records = wr.open_log(base)?;
    let mut at = tree_from.max(base);
    at = apply(&mut wr.w, base, &records, at, &mut last)?.max(at);
    // The last tick a record names, though the checkpoint holds it (a tick with no acts writes no record).
    if let Some(b) = records.last()
        && let Some(t) = Part::read(b)?.effects.iter().map(|e| e.envelope.at).max()
    {
        last = Some(last.map_or(tick_of(t), |l| l.max(tick_of(t))));
    }
    wr.appended = at;
    wr.w.next = wr.w.tree.next();
    let mut d = wr.directory();
    let claim = d.claim(&lineage, zone)?;
    let from = claim.takeover.from;
    wr.claimed(claim);
    if from < base || from > wr.appended {
        return refuse(
            "restart-gap",
            format!(
                "the claim starts at {from}; this machine holds {base} to {}",
                wr.appended
            ),
        );
    }
    wr.open_shipper(from)?;
    if let Some((tx, _, _)) = &wr.ship {
        for (i, b) in records.iter().enumerate() {
            let record = base + i as u64;
            if record >= from {
                let acts = Part::read(b)?.effects.len() as u64;
                tx.send(Item {
                    record,
                    bytes: b.clone(),
                    acts,
                    stakes: false,
                })
                .or_else(|_| refuse("ship-stopped", "the shipper stopped"))?;
            }
        }
    }
    wr.hook_log();
    wr.start_clock(last.map_or(0, |t| t + 1));
    Ok(wr)
}
