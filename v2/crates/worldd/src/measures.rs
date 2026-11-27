//! Measures from day one (Engine v2 O4, #2694): where an act's time went, each tick's phases against its budget, and
//! every queue's oldest item, so a slow act or a late tick can be placed by program, phase and queue.
//!
//! - **Stamps** ([`Stamps`]): each act carries readings of this machine's steady clock ([`steady_us`]), taken where
//!   it changes hands: read off the gateway's socket, taken by the clock thread, its check back, the tick that commits
//!   it, that tick's record handed to the log, synced, and handed to the gateway's socket. The parts are the µs
//!   between consecutive stamps ([`PARTS`]). The gateway is one local socket away, on the same machine and clock, so
//!   it places the link's time from the first and last stamps (`gatewayd::times`); a stamp is never subtracted from
//!   another machine's. A pair out of order is counted (`inverted`), never hidden as zero.
//! - **The block rides the answer frame,** field [`replica::intents::ANSWER_TIMES`]: `[first stamp, six parts]`,
//!   added on the answers thread after the tick's record is on the disk. The logged answer is the frame without it:
//!   timings never enter a hashed record or the simulation (T6, K12). The gateway turns the first stamp into parts
//!   before a client sees it.
//! - **Histograms** of each part and each tick phase are atomics shared with a writer thread, which writes
//!   `health.json` every [`EVERY`] whatever the clock thread is doing: a clock thread stuck on purpose still shows,
//!   in the arrivals queue's oldest item.
//! - **Labels** are the closed lists below: no Soul, account or token is ever a label.
//!
//! The clock thread's share per act is two clock readings and five queue entries ([`Measures::taken`],
//! [`Measures::to_check`], [`Measures::checked`], [`Measures::left_tick`]); every subtraction and histogram write is
//! on the answers thread.
// The health file's time of day is a measure, not world time (the wall-clock rule, K7, binds the engine;
// v2/clippy.toml).
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// This machine's steady clock, µs: `CLOCK_MONOTONIC`, one clock for every process on the machine, so the gateway
/// and the world may subtract each other's stamps. Not `Instant`, which is a process's own and cannot be sent.
pub fn steady_us() -> u64 {
    let t = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
    let (s, ns) = (
        u64::try_from(t.tv_sec).unwrap_or(0),
        u64::try_from(t.tv_nsec).unwrap_or(0),
    );
    s * 1_000_000 + ns / 1_000
}

/// An act's parts in the world process, in order: the block's integers.
pub const PARTS: [&str; 6] = [
    "world.in",  // read off the gateway's socket -> taken by the clock thread
    "check",     // taken -> its (last) check back at the clock thread
    "tick.wait", // check back -> the start of the tick that commits it
    "commit",    // tick start -> the tick's record handed to the log
    "log.sync",  // handed -> on the disk
    "world.out", // on the disk -> its answer handed to the gateway's socket (its writer)
];
/// A tick's phases, in the loop's order (K18's tick, `crate::answers`; K18c #3176): a checkpoint when one is due
/// (between ticks, so first), the intents taken, due timers, the bodies (skills and the controller), committed acts
/// and new moves, the tick's records, the frozen copy and the hand-off to the answers thread, the auditor's slice.
pub const PHASES: [&str; 8] = [
    "checkpoint",
    "take",
    "timers",
    "bodies",
    "commit",
    "record",
    "publish",
    "audit",
];
/// How many phases a tick has.
pub const NPHASES: usize = PHASES.len();
/// The world process's queues.
pub const QUEUES: [&str; 4] = [
    "arrivals", // read off the socket, not yet taken by the clock thread
    "checks",   // sent to the checkers, not yet back
    "tick",     // checked, waiting for the tick that commits it
    "log",      // ticks handed to the log, not yet on the disk and answered
];
pub const ARRIVALS: usize = 0;
pub const CHECKS: usize = 1;
pub const TICK: usize = 2;
pub const LOG: usize = 3;
/// A tick's budget, µs.
pub const BUDGET_US: u64 = 50_000;
/// How often `health.json` is written.
pub const EVERY: Duration = Duration::from_secs(2);

/// An act's stamps, in [`PARTS`]' order plus one: a missing stamp is the one before it (a part of zero).
#[derive(Clone, Copy, Debug, Default)]
pub struct Stamps(pub [Option<u64>; 7]);

impl Stamps {
    /// Arrived now: read off the socket.
    pub fn arrived() -> Stamps {
        let mut s = Stamps::default();
        s.0[0] = Some(steady_us());
        s
    }

    /// The parts in µs, and whether any pair was out of order.
    pub fn parts(&self) -> ([u64; 6], bool) {
        let mut out = [0u64; 6];
        let mut inverted = false;
        let mut last = self.0[0];
        for (i, slot) in self.0.iter().enumerate().skip(1) {
            let at = slot.or(last);
            if let (Some(a), Some(b)) = (last, at) {
                // `checked_sub`, not a saturating one, which would hide swapped stamps as zero.
                match b.checked_sub(a) {
                    Some(d) => out[i - 1] = d,
                    None => inverted = true,
                }
            }
            last = at;
        }
        (out, inverted)
    }
}

/// A histogram of µs: four buckets to each power of two, so a quantile is within a quarter of its value.
pub struct Hist {
    buckets: Vec<AtomicU64>,
    count: AtomicU64,
    sum: AtomicU64,
    max: AtomicU64,
}

const BUCKETS: usize = 64 * 4;

fn bucket(us: u64) -> usize {
    if us < 4 {
        return us as usize;
    }
    let log = 63 - us.leading_zeros() as usize;
    (log - 1) * 4 + ((us >> (log - 2)) & 3) as usize
}

fn bucket_top(b: usize) -> u64 {
    if b < 4 {
        return b as u64;
    }
    let (log, sub) = (b / 4 + 1, (b % 4) as u64);
    ((4 + sub + 1) << (log - 2)).saturating_sub(1)
}

impl Default for Hist {
    fn default() -> Hist {
        Hist {
            buckets: (0..BUCKETS).map(|_| AtomicU64::new(0)).collect(),
            count: AtomicU64::new(0),
            sum: AtomicU64::new(0),
            max: AtomicU64::new(0),
        }
    }
}

impl Hist {
    pub fn record(&self, us: u64) {
        self.buckets[bucket(us)].fetch_add(1, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        self.sum.fetch_add(us, Ordering::Relaxed);
        self.max.fetch_max(us, Ordering::Relaxed);
    }

    /// The value at quantile `q` (0 to 1), as its bucket's top, µs.
    pub fn quantile(&self, q: f64) -> u64 {
        let n = self.count.load(Ordering::Relaxed);
        if n == 0 {
            return 0;
        }
        let want = ((n as f64) * q).ceil().max(1.0) as u64;
        let mut seen = 0;
        for (b, c) in self.buckets.iter().enumerate() {
            seen += c.load(Ordering::Relaxed);
            if seen >= want {
                return bucket_top(b).min(self.max.load(Ordering::Relaxed));
            }
        }
        self.max.load(Ordering::Relaxed)
    }

    fn json(&self, out: &mut String) {
        let n = self.count.load(Ordering::Relaxed);
        let mean = self.sum.load(Ordering::Relaxed).checked_div(n).unwrap_or(0);
        let _ = write!(
            out,
            "{{\"count\":{n},\"mean_us\":{mean},\"p50_us\":{},\"p99_us\":{},\"max_us\":{}}}",
            self.quantile(0.5),
            self.quantile(0.99),
            self.max.load(Ordering::Relaxed)
        );
    }
}

/// A queue's items by key, with the instant each entered: its oldest item's age is read by the health thread.
#[derive(Default)]
pub struct Queue(Mutex<BTreeMap<u64, u64>>);

impl Queue {
    pub fn enter(&self, key: u64, at: u64) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, at);
    }

    pub fn leave(&self, key: u64) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key);
    }

    /// Items, and the oldest's age at `now`, µs.
    pub fn oldest(&self, now: u64) -> (usize, u64) {
        let q = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let oldest = q.values().min().map_or(0, |t| now.saturating_sub(*t));
        (q.len(), oldest)
    }
}

/// The world process's measures, shared by the clock, answers and health threads.
#[derive(Default)]
pub struct Measures {
    pub parts: [Hist; 6],
    pub phases: [Hist; NPHASES],
    pub ticks: Hist,
    pub queues: [Queue; 4],
    /// The last tick's phases, µs.
    last: [AtomicU64; NPHASES],
    over_budget: AtomicU64,
    inverted: AtomicU64,
    /// Keys for arrivals, minted where they are read.
    next_arrival: AtomicU64,
    /// `health.json` writes so far.
    pub written: AtomicU64,
    /// The Souls embodied in the world as the last tick left them, plus one; 0 before a tick has set it (or in a world
    /// with no joins). `souls` in `health.json`: the number a world's card on the home page shows (26 Nov).
    souls: AtomicU64,
}

impl Measures {
    /// An arrival read off the socket: its stamps and its key in the arrivals queue.
    pub fn arrive(&self) -> (Stamps, u64) {
        let s = Stamps::arrived();
        let key = self.next_arrival.fetch_add(1, Ordering::Relaxed);
        if let Some(at) = s.0[0] {
            self.queues[ARRIVALS].enter(key, at);
        }
        (s, key)
    }

    /// Clock thread: arrival `key` taken.
    pub fn taken(&self, key: u64, stamps: &mut Stamps) {
        stamps.0[1] = Some(steady_us());
        self.queues[ARRIVALS].leave(key);
    }

    /// Clock thread: act `act` sent to the checkers (again, after a recheck), at `at`.
    pub fn to_check(&self, act: u64, at: Option<u64>) {
        self.queues[CHECKS].enter(act, at.unwrap_or_else(steady_us));
    }

    /// Clock thread: act `act`'s check came back; it waits for the tick.
    pub fn checked(&self, act: u64, stamps: Option<&mut Stamps>) {
        let now = steady_us();
        if let Some(s) = stamps {
            s.0[2] = Some(now);
        }
        self.queues[CHECKS].leave(act);
        self.queues[TICK].enter(act, now);
    }

    /// Clock thread: act `act` left the tick's queue (committed, ended, or sent to be checked again).
    pub fn left_tick(&self, act: u64) {
        self.queues[TICK].leave(act);
    }

    /// Clock thread: act `act` ended before its check came back (its deadline passed).
    pub fn ended_unchecked(&self, act: u64) {
        self.queues[CHECKS].leave(act);
    }

    /// Clock thread: a tick's phases, µs.
    pub fn tick(&self, phases: [u64; NPHASES]) {
        let total: u64 = phases.iter().sum();
        for (i, us) in phases.iter().enumerate() {
            self.phases[i].record(*us);
            self.last[i].store(*us, Ordering::Relaxed);
        }
        self.ticks.record(total);
        if total > BUDGET_US {
            self.over_budget.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Clock thread: the Souls embodied in the world after a tick (`None`: a world with no joins, no field).
    pub fn souls(&self, n: Option<usize>) {
        let v = n.map_or(0, |n| u64::try_from(n).unwrap_or(u64::MAX - 1) + 1);
        self.souls.store(v, Ordering::Relaxed);
    }

    /// Answers thread: an answer's stamps complete; its parts recorded and returned as the block, `[first stamp,
    /// six parts]`.
    pub fn answered(&self, stamps: &Stamps) -> [u64; 7] {
        let (parts, inverted) = stamps.parts();
        if inverted {
            self.inverted.fetch_add(1, Ordering::Relaxed);
        }
        for (h, us) in self.parts.iter().zip(parts) {
            h.record(us);
        }
        let mut block = [stamps.0[0].unwrap_or(0), 0, 0, 0, 0, 0, 0];
        block[1..].copy_from_slice(&parts);
        block
    }

    /// The health file's text at `now`.
    pub fn health(&self, now: u64) -> String {
        let unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let mut o = String::with_capacity(2048);
        let _ = write!(
            o,
            "{{\"at_unix_ms\":{unix_ms},\"written\":{},\"budget_us\":{BUDGET_US},\"ticks\":",
            self.written.load(Ordering::Relaxed) + 1
        );
        self.ticks.json(&mut o);
        let _ = write!(
            o,
            ",\"over_budget\":{},\"inverted_stamps\":{},\"last_tick_us\":{{",
            self.over_budget.load(Ordering::Relaxed),
            self.inverted.load(Ordering::Relaxed)
        );
        for (i, name) in PHASES.iter().enumerate() {
            let sep = if i == 0 { "" } else { "," };
            let _ = write!(
                o,
                "{sep}\"{name}\":{}",
                self.last[i].load(Ordering::Relaxed)
            );
        }
        o.push_str("},\"phases\":{");
        for (i, name) in PHASES.iter().enumerate() {
            let sep = if i == 0 { "" } else { "," };
            let _ = write!(o, "{sep}\"{name}\":");
            self.phases[i].json(&mut o);
        }
        o.push_str("},\"parts\":{");
        for (i, name) in PARTS.iter().enumerate() {
            let sep = if i == 0 { "" } else { "," };
            let _ = write!(o, "{sep}\"{name}\":");
            self.parts[i].json(&mut o);
        }
        o.push_str("},\"queues\":{");
        for (i, name) in QUEUES.iter().enumerate() {
            let sep = if i == 0 { "" } else { "," };
            let (items, oldest) = self.queues[i].oldest(now);
            let _ = write!(
                o,
                "{sep}\"{name}\":{{\"items\":{items},\"oldest_us\":{oldest}}}"
            );
        }
        o.push_str("},\"stalled\":");
        STALLS.json(&mut o);
        clock_json(&mut o);
        DISK.json(&mut o);
        o.push_str(",\"sync\":");
        SYNCS.json(&mut o);
        o.push_str(",\"audit\":");
        AUDIT.json(&mut o);
        STREAM.json("stream", &mut o);
        BACKUP.json("stream_backup", &mut o);
        CLEANUP.json(&mut o);
        SHIPPING.json("shipping", &mut o);
        ARCHIVE.json_with("archive", &ARCHIVE_QUEUE.fields(), &mut o);
        HISTORY_EXPORT.json(&mut o);
        CREATOR.json("creator", &mut o);
        EDIT_CHECKS.json(&mut o);
        if let Some(n) = self.souls.load(Ordering::Relaxed).checked_sub(1) {
            let _ = write!(o, ",\"souls\":{n}");
        }
        o.push_str("}\n");
        o
    }
}

/// How far the world's clock runs ahead of the machine's, ms (O10, #2806): set by a restart that found the machine's
/// clock behind its last logged tick, and by the watchdog, which compares the two each second. Under a second either
/// way is `steady`; past it, `stepped` (`clock` in `health.json`).
pub static CLOCK_AHEAD_MS: AtomicI64 = AtomicI64::new(0);

/// `,"clock":{"state":"steady"}`, or `stepped` with how far the world's clock is ahead of the machine's.
fn clock_json(o: &mut String) {
    let ahead = CLOCK_AHEAD_MS.load(Ordering::Relaxed);
    if ahead.abs() < 1000 {
        o.push_str(",\"clock\":{\"state\":\"steady\"}");
    } else {
        let _ = write!(
            o,
            ",\"clock\":{{\"state\":\"stepped\",\"ahead_ms\":{ahead}}}"
        );
    }
}

/// Free space under the world (`disk` in `health.json`, #2806 follow-up): `low` before the disk is full, so an
/// operator hears of it while the world still writes. Written by the disk watch (`worldd serve`), read by the health
/// writer and by the log's compactor, which gives back what the store already holds sooner while it is low.
pub struct Disk {
    /// Whether the disk has been read yet: no field before.
    read: std::sync::atomic::AtomicBool,
    low: std::sync::atomic::AtomicBool,
    free: AtomicU64,
    total: AtomicU64,
    low_bytes: AtomicU64,
    low_pct: AtomicU64,
    /// Times the disk went low since the start.
    went_low: AtomicU64,
}

/// This process's disk.
pub static DISK: Disk = Disk {
    read: std::sync::atomic::AtomicBool::new(false),
    low: std::sync::atomic::AtomicBool::new(false),
    free: AtomicU64::new(0),
    total: AtomicU64::new(0),
    low_bytes: AtomicU64::new(0),
    low_pct: AtomicU64::new(0),
    went_low: AtomicU64::new(0),
};

/// The default `disk.low` threshold: under 1 GiB free, or under 5 % of the disk free.
pub const DISK_LOW_BYTES: u64 = 1 << 30;
pub const DISK_LOW_PCT: u64 = 5;

/// Whether a disk with `free` of `total` bytes free is low, given whether it `was` low: under either threshold is low;
/// once low, it is cleared only past both by a tenth more, so a disk at the line is said once, not at each read.
pub fn disk_low(free: u64, total: u64, low_bytes: u64, low_pct: u64, was: bool) -> bool {
    let (bytes, pct) = if was {
        (
            low_bytes.saturating_add(low_bytes / 10),
            low_pct.saturating_mul(11),
        )
    } else {
        (low_bytes, low_pct.saturating_mul(10))
    };
    // Percent in tenths, so the tenth's margin holds for small percentages too.
    let tenths = u128::from(free) * 1000 / u128::from(total.max(1));
    free < bytes || tenths < u128::from(pct)
}

impl Disk {
    /// A reading: `free` of `total` bytes, against the threshold. Whether the disk is low now, and whether that
    /// changed with this reading.
    pub fn reading(&self, free: u64, total: u64, low_bytes: u64, low_pct: u64) -> (bool, bool) {
        let was = self.low.load(Ordering::Relaxed);
        let low = disk_low(free, total, low_bytes, low_pct, was);
        self.free.store(free, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
        self.low_bytes.store(low_bytes, Ordering::Relaxed);
        self.low_pct.store(low_pct, Ordering::Relaxed);
        self.low.store(low, Ordering::Relaxed);
        self.read.store(true, Ordering::Relaxed);
        if low && !was {
            self.went_low.fetch_add(1, Ordering::Relaxed);
        }
        (low, low != was)
    }

    /// Whether the disk is low.
    pub fn is_low(&self) -> bool {
        self.low.load(Ordering::Relaxed)
    }

    /// Free bytes at the last reading.
    pub fn free(&self) -> u64 {
        self.free.load(Ordering::Relaxed)
    }

    /// `,"disk":{"state":"ok"|"low","free_bytes":n,"total_bytes":n,"free_pct":n,"low_bytes":n,"low_pct":n,
    /// "went_low":n}`, or nothing before the first reading. `free_pct` in whole percent, rounded down.
    fn json(&self, o: &mut String) {
        if !self.read.load(Ordering::Relaxed) {
            return;
        }
        let l = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let (free, total) = (l(&self.free), l(&self.total));
        let pct = u128::from(free) * 100 / u128::from(total.max(1));
        let _ = write!(
            o,
            ",\"disk\":{{\"state\":\"{}\",\"free_bytes\":{free},\"total_bytes\":{total},\"free_pct\":{pct},\
             \"low_bytes\":{},\"low_pct\":{},\"went_low\":{}}}",
            if self.is_low() { "low" } else { "ok" },
            l(&self.low_bytes),
            l(&self.low_pct),
            l(&self.went_low)
        );
    }
}

/// The clock's stalls (K7): no tick for the watchdog's soft limit, the world running on. One per process, written by
/// the watchdog thread and read by `health.json`'s writer.
pub struct Stalls {
    /// ms without a tick in the stall under way; 0 while ticking.
    now_ms: AtomicU64,
    /// Stalls that ended, and the longest of them, ms.
    count: AtomicU64,
    longest_ms: AtomicU64,
}

/// This process's stalls.
pub static STALLS: Stalls = Stalls {
    now_ms: AtomicU64::new(0),
    count: AtomicU64::new(0),
    longest_ms: AtomicU64::new(0),
};

impl Stalls {
    /// A stall began, `ms` without a tick so far.
    pub fn began(&self, ms: i64) {
        self.now(ms);
    }

    /// The stall under way, `ms` without a tick so far.
    pub fn now(&self, ms: i64) {
        self.now_ms
            .store(u64::try_from(ms).unwrap_or(0), Ordering::Relaxed);
    }

    /// The stall ended after `ms`.
    pub fn ended(&self, ms: i64) {
        self.now_ms.store(0, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
        self.longest_ms
            .fetch_max(u64::try_from(ms).unwrap_or(0), Ordering::Relaxed);
    }

    /// `{"now_ms":n,"ended":n,"longest_ms":n}`: `now_ms` over 0 while the world is stalled.
    pub fn json(&self, o: &mut String) {
        let _ = write!(
            o,
            "{{\"now_ms\":{},\"ended\":{},\"longest_ms\":{}}}",
            self.now_ms.load(Ordering::Relaxed),
            self.count.load(Ordering::Relaxed),
            self.longest_ms.load(Ordering::Relaxed)
        );
    }
}

/// The edit checker's stages (#5216), in order: the bodies and the published copy it waits for (`basis`), the edit's
/// check, the checker's town brought up to the copy, the plan with G2's guard (BUILDSAFE), the places and the Souls
/// judged, and the walkers' maps.
pub const EDIT_STAGES: [&str; 6] = ["basis", "check", "town", "plan", "places", "maps"];
pub const EDIT_BASIS: usize = 0;
pub const EDIT_CHECK: usize = 1;
pub const EDIT_TOWN: usize = 2;
pub const EDIT_PLAN: usize = 3;
pub const EDIT_PLACES: usize = 4;
pub const EDIT_MAPS: usize = 5;

/// One edit's check on the checker's thread: its time by stage (each [`EditStages::end`] closes the stage named, from
/// the end of the one before; a stage never reached, the edit refused before it, stays 0), and the ground its maps
/// were prepared from ([`EditStages::ground`]).
pub struct EditStages {
    at: std::cell::Cell<u64>,
    us: [std::cell::Cell<u64>; 6],
    ground: std::cell::Cell<Option<EditGround>>,
}

/// The ground built for one edit: whether the whole open ground was built again (and why), else how many of its
/// squares were cut again and how many buildings read again. The work an edit's check does, whatever the machine.
#[derive(Clone, Copy)]
struct EditGround {
    whole: bool,
    why: Option<&'static str>,
    squares: usize,
    buildings: usize,
}

impl EditStages {
    pub fn start() -> EditStages {
        EditStages {
            at: std::cell::Cell::new(steady_us()),
            us: Default::default(),
            ground: std::cell::Cell::new(None),
        }
    }

    pub fn end(&self, stage: usize) {
        let now = steady_us();
        self.us[stage].set(now.saturating_sub(self.at.get()));
        self.at.set(now);
    }

    /// The ground the edit's maps were prepared from.
    pub fn ground(&self, whole: bool, why: Option<&'static str>, squares: usize, buildings: usize) {
        self.ground.set(Some(EditGround {
            whole,
            why,
            squares,
            buildings,
        }));
    }
}

/// The edit checker's thread (#5216): the edits on it now (waiting or being checked) against the most it takes, the
/// edits refused because it was full, the edits it has checked, the last one's time by stage and its ground (the
/// squares cut again and the buildings read again, or the whole), the longest check, and the edits whose ground was
/// built whole with the last one's reason. One per process, written by the clock (the line) and the checker's thread
/// (the rest) and read by `health.json`'s writer (`edit_check`).
pub struct EditChecks {
    waiting: AtomicU64,
    most: AtomicU64,
    refused: AtomicU64,
    checked: AtomicU64,
    last_us: [AtomicU64; 6],
    longest_us: AtomicU64,
    /// The last edit's ground, and the last reason a whole ground was built.
    last: Mutex<(Option<EditGround>, Option<&'static str>)>,
    wholes: AtomicU64,
}

/// This process's edit checks.
pub static EDIT_CHECKS: EditChecks = EditChecks {
    waiting: AtomicU64::new(0),
    most: AtomicU64::new(0),
    refused: AtomicU64::new(0),
    checked: AtomicU64::new(0),
    last_us: [const { AtomicU64::new(0) }; 6],
    longest_us: AtomicU64::new(0),
    last: Mutex::new((None, None)),
    wholes: AtomicU64::new(0),
};

impl EditChecks {
    /// Clock thread: `n` edits are on the checker's thread, which takes at most `most`.
    pub fn waiting(&self, n: usize, most: usize) {
        self.waiting.store(n as u64, Ordering::Relaxed);
        self.most.store(most as u64, Ordering::Relaxed);
    }

    /// Clock thread: an edit was refused because the checker's thread was full.
    pub fn refused(&self) {
        self.refused.fetch_add(1, Ordering::Relaxed);
    }

    /// The checker's thread: an edit's check ended, committed or refused.
    pub fn checked(&self, stages: &EditStages) {
        let mut total = 0;
        for (last, us) in self.last_us.iter().zip(&stages.us) {
            last.store(us.get(), Ordering::Relaxed);
            total += us.get();
        }
        self.longest_us.fetch_max(total, Ordering::Relaxed);
        let ground = stages.ground.get();
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        last.0 = ground;
        if let Some(g) = ground.filter(|g| g.whole) {
            self.wholes.fetch_add(1, Ordering::Relaxed);
            last.1 = Some(g.why.unwrap_or("a building that cannot be read alone"));
        }
        drop(last);
        self.checked.fetch_add(1, Ordering::Relaxed);
    }

    /// `,"edit_check":{"waiting":n,"most":n,"refused_busy":n,"checked":n,"longest_us":n,"last_us":{<stage>:n,...},
    /// "last_ground":{"whole":false,"squares":n,"buildings":n},"whole":{"count":n,"why":"..."}}`; `last_ground` only
    /// when the last edit had its maps prepared, `why` once a whole ground was built.
    pub fn json(&self, o: &mut String) {
        let _ = write!(
            o,
            ",\"edit_check\":{{\"waiting\":{},\"most\":{},\"refused_busy\":{},\"checked\":{},\"longest_us\":{},\"last_us\":{{",
            self.waiting.load(Ordering::Relaxed),
            self.most.load(Ordering::Relaxed),
            self.refused.load(Ordering::Relaxed),
            self.checked.load(Ordering::Relaxed),
            self.longest_us.load(Ordering::Relaxed)
        );
        for (i, name) in EDIT_STAGES.iter().enumerate() {
            let sep = if i == 0 { "" } else { "," };
            let _ = write!(
                o,
                "{sep}\"{name}\":{}",
                self.last_us[i].load(Ordering::Relaxed)
            );
        }
        o.push('}');
        let (ground, why) = *self.last.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(g) = ground {
            let _ = write!(
                o,
                ",\"last_ground\":{{\"whole\":{},\"squares\":{},\"buildings\":{}}}",
                g.whole, g.squares, g.buildings
            );
        }
        let _ = write!(
            o,
            ",\"whole\":{{\"count\":{}",
            self.wholes.load(Ordering::Relaxed)
        );
        if let Some(why) = why {
            let _ = write!(o, ",\"why\":\"{why}\"");
        }
        o.push_str("}}");
    }
}

/// The auditor (K11) and its printer (#3422): passes ended, slices cut short by `answers::AUDIT_TIME`, and the fault
/// lines the clock queued for the printer, printed, and dropped because the queue was full or the printer gone (the
/// clock never waits for it). One per process, written by the clock and the printer threads.
pub struct Audit {
    passes: AtomicU64,
    cut: AtomicU64,
    sent: AtomicU64,
    printed: AtomicU64,
    dropped: AtomicU64,
}

/// This process's auditor.
pub static AUDIT: Audit = Audit {
    passes: AtomicU64::new(0),
    cut: AtomicU64::new(0),
    sent: AtomicU64::new(0),
    printed: AtomicU64::new(0),
    dropped: AtomicU64::new(0),
};

impl Audit {
    /// Clock thread: a slice ended, cut short by time or not, with the auditor's passes so far.
    pub fn slice(&self, cut: bool, passes: u64) {
        self.passes.store(passes, Ordering::Relaxed);
        if cut {
            self.cut.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Clock thread: a line queued.
    pub fn sent(&self) {
        self.sent.fetch_add(1, Ordering::Relaxed);
    }

    /// Clock thread: a line dropped.
    pub fn dropped(&self) {
        self.dropped.fetch_add(1, Ordering::Relaxed);
    }

    /// Printer thread: a line printed.
    pub fn printed(&self) {
        self.printed.fetch_add(1, Ordering::Relaxed);
    }

    /// Lines dropped so far.
    pub fn drops(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// `{"passes":n,"cut_slices":n,"limit":n,"queued":n,"printed":n,"dropped":n}`: `limit` the lines the queue
    /// holds; `queued` the lines sent and not yet printed, the one being printed included (so up to `limit` + 1).
    pub fn json(&self, o: &mut String) {
        let printed = self.printed.load(Ordering::Relaxed);
        let _ = write!(
            o,
            "{{\"passes\":{},\"cut_slices\":{},\"limit\":{},\"queued\":{},\"printed\":{printed},\"dropped\":{}}}",
            self.passes.load(Ordering::Relaxed),
            self.cut.load(Ordering::Relaxed),
            crate::answers::AUDIT_LINES,
            self.sent.load(Ordering::Relaxed).saturating_sub(printed),
            self.drops()
        );
    }
}

/// The sync thread's copy (`crate::syncs`, #1960): its seals, the records requests refused `sync-unknown-hash` (a
/// record replaced longer ago than its window), and how far back each window of replaced records reached at the last
/// seal, in seals and ms (`replica::sync::Records::windows`). One per process, written by the sync thread.
pub struct Syncs {
    seals: AtomicU64,
    unknown_hash: AtomicU64,
    small_seals: AtomicU64,
    small_ms: AtomicU64,
    big_seals: AtomicU64,
    big_ms: AtomicU64,
}

/// This process's sync copy.
pub static SYNCS: Syncs = Syncs {
    seals: AtomicU64::new(0),
    unknown_hash: AtomicU64::new(0),
    small_seals: AtomicU64::new(0),
    small_ms: AtomicU64::new(0),
    big_seals: AtomicU64::new(0),
    big_ms: AtomicU64::new(0),
};

impl Syncs {
    /// A seal, and how far back the windows reach after it: seals and ms.
    pub fn sealed(&self, small: u64, small_ms: u128, big: u64, big_ms: u128) {
        let ms = |v: u128| u64::try_from(v).unwrap_or(u64::MAX);
        self.seals.fetch_add(1, Ordering::Relaxed);
        self.small_seals.store(small, Ordering::Relaxed);
        self.small_ms.store(ms(small_ms), Ordering::Relaxed);
        self.big_seals.store(big, Ordering::Relaxed);
        self.big_ms.store(ms(big_ms), Ordering::Relaxed);
    }

    /// A records request refused `sync-unknown-hash`.
    pub fn unknown_hash(&self) {
        self.unknown_hash.fetch_add(1, Ordering::Relaxed);
    }

    /// `{"seals":n,"unknown_hash":n,"small_window":{"seals":n,"ms":n},"big_window":{"seals":n,"ms":n}}`.
    pub fn json(&self, o: &mut String) {
        let l = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let _ = write!(
            o,
            "{{\"seals\":{},\"unknown_hash\":{},\"small_window\":{{\"seals\":{},\"ms\":{}}},\"big_window\":{{\"seals\":{},\"ms\":{}}}}}",
            l(&self.seals),
            l(&self.unknown_hash),
            l(&self.small_seals),
            l(&self.small_ms),
            l(&self.big_seals),
            l(&self.big_ms)
        );
    }
}

/// The public stream's state (R12), set by `worldd serve`'s stream thread: `recovering` until its first flush,
/// `serving` after it, and `degraded` while its recovery is refused, with the fault, the tries refused so far and the
/// wait before the next; `stopped` with its fault if it ends after serving. A degraded world stays up with no viewers;
/// a crash loop would hide the fault. Unset (no
/// field in `health.json`) where no public stream runs.
pub struct Stream(Mutex<String>);

/// This process's public stream.
pub static STREAM: Stream = Stream(Mutex::new(String::new()));

/// R15: the stream's recovery chain, backed up to the store behind it (`stream_backup` in `health.json`). Viewers read
/// the stream from this machine's disk, so a store that stalls or refuses shows here, not in `stream`.
pub static BACKUP: Stream = Stream(Mutex::new(String::new()));

/// The stream's clean-up of old generations from the store (#3833, #4954; `stream_cleanup` in `health.json`): the old
/// generations not read yet (`generations`, each standing for its objects, about a thousand), the deletes in line
/// (`waiting`), those of them waiting to be tried again after a refusal (`retrying`), and the deletes the store
/// answered and the refusals since the start. One per process, written by the clean-up's own thread each second,
/// whether or not it may delete; absent until it first runs.
pub struct Cleanup {
    on: std::sync::atomic::AtomicBool,
    generations: AtomicU64,
    waiting: AtomicU64,
    retrying: AtomicU64,
    deleted: AtomicU64,
    refused: AtomicU64,
}

/// This process's stream clean-up.
pub static CLEANUP: Cleanup = Cleanup {
    on: std::sync::atomic::AtomicBool::new(false),
    generations: AtomicU64::new(0),
    waiting: AtomicU64::new(0),
    retrying: AtomicU64::new(0),
    deleted: AtomicU64::new(0),
    refused: AtomicU64::new(0),
};

impl Cleanup {
    /// How the clean-up stands now.
    pub fn set(&self, generations: u64, waiting: u64, retrying: u64, deleted: u64, refused: u64) {
        self.generations.store(generations, Ordering::Relaxed);
        self.waiting.store(waiting, Ordering::Relaxed);
        self.retrying.store(retrying, Ordering::Relaxed);
        self.deleted.store(deleted, Ordering::Relaxed);
        self.refused.store(refused, Ordering::Relaxed);
        self.on.store(true, Ordering::Relaxed);
    }

    /// `,"stream_cleanup":{"generations":n,"waiting":n,"retrying":n,"deleted":n,"refused":n}`, or nothing before it
    /// runs.
    fn json(&self, o: &mut String) {
        if !self.on.load(Ordering::Relaxed) {
            return;
        }
        let l = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let _ = write!(
            o,
            ",\"stream_cleanup\":{{\"generations\":{},\"waiting\":{},\"retrying\":{},\"deleted\":{},\"refused\":{}}}",
            l(&self.generations),
            l(&self.waiting),
            l(&self.retrying),
            l(&self.deleted),
            l(&self.refused)
        );
    }
}

/// R17: the start's reads of the store that the world no longer waits on (`shipping`, `archive` and `creator` in
/// `health.json`): `degraded` with the fault, the tries so far and the wait before the next while the store does not
/// answer, `current` once it did, `stopped` with the fault if that helper ended on a refusal of another kind. The world
/// listens and serves meanwhile; its log on the disk is the truth, and shipping catches up from it.
pub static SHIPPING: Stream = Stream(Mutex::new(String::new()));
/// R17: the history archive's open (its header, bundle index and public history), as [`SHIPPING`].
pub static ARCHIVE: Stream = Stream(Mutex::new(String::new()));
/// R17: the creator's record in the directory, as [`SHIPPING`]. While it is degraded, edits fail closed.
pub static CREATOR: Stream = Stream(Mutex::new(String::new()));

/// The public history mirror's faults (`history_export` in `health.json`): keys the archiver stored but could not copy
/// into the world's public history directory, the count and the last key with its fault. The store holds the truth;
/// a key the mirror refuses is skipped and the world goes on. No field until the first fault. The keys refused so far
/// (at most [`EXPORT_KEYS_HELD`]) are held so each is logged once, not at every write of it.
pub struct ExportFaults(Mutex<(u64, String, std::collections::BTreeSet<String>)>);

/// The most refused keys [`ExportFaults`] remembers; past it, a newly refused key is logged at each refusal.
pub const EXPORT_KEYS_HELD: usize = 4096;

/// This process's public history mirror.
pub static HISTORY_EXPORT: ExportFaults = ExportFaults(Mutex::new((
    0,
    String::new(),
    std::collections::BTreeSet::new(),
)));

impl ExportFaults {
    /// `key` was not mirrored, refused with `fault`; whether this is its first refusal (to log).
    pub fn fault(&self, key: &str, fault: &str) -> bool {
        let mut f = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f.0 += 1;
        f.1 = format!("{key}: {fault}");
        if f.2.contains(key) {
            return false;
        }
        if f.2.len() < EXPORT_KEYS_HELD {
            f.2.insert(key.to_owned());
        }
        true
    }

    /// The faults so far.
    pub fn count(&self) -> u64 {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).0
    }

    /// `,"history_export":{"faults":n,"last":"<key>: <fault>"}`, or nothing before the first fault.
    fn json(&self, o: &mut String) {
        let f = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if f.0 > 0 {
            let _ = write!(
                o,
                ",\"history_export\":{{\"faults\":{},\"last\":\"{}\"}}",
                f.0,
                quoted(&f.1)
            );
        }
    }
}

/// The history archiver's backlog (`archive.queued`, `archive.queued_bytes` and `archive.in_log` in `health.json`):
/// the parts waiting in its channel and their bytes (at most the window), and the records past them left in the log on
/// the disk for it to read once it has caught up (`worldd serve`'s handover sets them, under its own lock).
pub struct Backlog(Mutex<(u64, u64, u64)>);

/// This process's archiver's backlog.
pub static ARCHIVE_QUEUE: Backlog = Backlog(Mutex::new((0, 0, 0)));

impl Backlog {
    /// The backlog as it stands now.
    pub fn set(&self, queued: u64, queued_bytes: u64, in_log: u64) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = (queued, queued_bytes, in_log);
    }

    /// `"queued":n,"queued_bytes":n,"in_log":n`.
    fn fields(&self) -> String {
        let (q, b, l) = *self.0.lock().unwrap_or_else(|e| e.into_inner());
        format!("\"queued\":{q},\"queued_bytes\":{b},\"in_log\":{l}")
    }
}

impl Stream {
    pub fn recovering(&self) {
        self.set("{\"state\":\"recovering\"}".to_owned());
    }

    pub fn serving(&self) {
        self.set("{\"state\":\"serving\"}".to_owned());
    }

    /// R17: the store answered this start read.
    pub fn current(&self) {
        self.set("{\"state\":\"current\"}".to_owned());
    }

    /// Its recovery refused `fault` for the `tries`th time; the next try in `next_try_ms`.
    pub fn degraded(&self, fault: &str, tries: u64, next_try_ms: u64) {
        self.set(format!(
            "{{\"state\":\"degraded\",\"fault\":\"{}\",\"tries\":{tries},\"next_try_ms\":{next_try_ms}}}",
            quoted(fault)
        ));
    }

    /// A running helper's write (the archiver's) the store did not answer, `tries` times so far, the last with `fault`;
    /// it is tried again in `next_try_ms`, and what comes meanwhile waits in order.
    pub fn behind(&self, fault: &str, tries: u64, next_try_ms: u64) {
        self.set(format!(
            "{{\"state\":\"behind\",\"fault\":\"{}\",\"tries\":{tries},\"next_try_ms\":{next_try_ms}}}",
            quoted(fault)
        ));
    }

    /// It stopped on `fault` after serving; the world goes on without it.
    pub fn stopped(&self, fault: &str) {
        self.set(format!(
            "{{\"state\":\"stopped\",\"fault\":\"{}\"}}",
            quoted(fault)
        ));
    }

    pub fn is_degraded(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .starts_with("{\"state\":\"degraded\"")
    }

    /// Whether the public stream still recovers its history ([`Stream::recovering`]).
    pub fn is_recovering(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .starts_with("{\"state\":\"recovering\"")
    }

    /// Whether a running helper waits for the store ([`Stream::behind`]).
    pub fn is_behind(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .starts_with("{\"state\":\"behind\"")
    }

    fn set(&self, json: String) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = json;
    }

    /// How the stream's backup stands ([`BACKUP`]).
    pub fn backup(&self, state: &crate::view_out::BackupState) {
        self.set(match state {
            crate::view_out::BackupState::Current => "{\"state\":\"current\"}".to_owned(),
            crate::view_out::BackupState::Degraded {
                fault,
                tries,
                next_try_ms,
                behind,
                behind_bytes,
            } => format!(
                "{{\"state\":\"degraded\",\"fault\":\"{}\",\"tries\":{tries},\"next_try_ms\":{next_try_ms},\"behind\":{behind},\"behind_bytes\":{behind_bytes}}}",
                quoted(fault)
            ),
            crate::view_out::BackupState::Fenced { fault } => format!(
                "{{\"state\":\"fenced\",\"fault\":\"{}\"}}",
                quoted(fault)
            ),
        });
    }

    /// `,"<name>":{...}`, or nothing while unset.
    fn json(&self, name: &str, o: &mut String) {
        let s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !s.is_empty() {
            o.push_str(&format!(",\"{name}\":"));
            o.push_str(&s);
        }
    }

    /// As [`Stream::json`], with `fields` (`"k":v,...`) last inside the object.
    fn json_with(&self, name: &str, fields: &str, o: &mut String) {
        let s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(inside) = s.strip_suffix('}') {
            o.push_str(&format!(",\"{name}\":{inside},{fields}}}"));
        }
    }
}

/// `text` as the inside of a JSON string.
fn quoted(text: &str) -> String {
    let mut q = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '"' => q.push_str("\\\""),
            '\\' => q.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(q, "\\u{:04x}", c as u32);
            }
            c => q.push(c),
        }
    }
    q
}

/// Writes `health.json` at `path` every `every`, by a temporary file and a rename, until the process ends. It
/// takes no lock the clock thread holds for longer than a queue entry.
pub fn write_health(m: Arc<Measures>, path: PathBuf, every: Duration) {
    let tmp = path.with_extension("json.tmp");
    let _ = thread::Builder::new().name("health".into()).spawn(move || {
        loop {
            let text = m.health(steady_us());
            if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, &path).is_ok() {
                m.written.fetch_add(1, Ordering::Relaxed);
            }
            thread::sleep(every);
        }
    });
}

/// Appends the block to an encoded answer frame `{1: version, 2: answer}` as field 3: `[first stamp, µs, ...]`.
/// A frame of any other shape is left as it is.
pub fn with_block(mut frame: Vec<u8>, parts: &[u64]) -> Vec<u8> {
    // A map of two entries (0xa2) whose keys run 1, 2: field 3 goes after them, keeping the keys in order.
    if frame.first() != Some(&0xa2) {
        return frame;
    }
    let block = replica::encode::Value::Array(
        parts
            .iter()
            .map(|p| replica::encode::Value::Uint(*p))
            .collect(),
    );
    let Ok(bytes) = replica::encode::encode(&block) else {
        return frame;
    };
    frame[0] = 0xa3;
    frame.push(replica::intents::ANSWER_TIMES as u8);
    frame.extend(bytes);
    frame
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::encode::{Value, decode};

    #[test]
    fn a_disk_is_low_under_either_threshold_and_cleared_past_both_with_a_margin() {
        const G: u64 = 1 << 30;
        // 100 GiB disk, 1 GiB and 5 %.
        let low = |free: u64, was| disk_low(free, 100 * G, G, 5, was);
        assert!(!low(10 * G, false), "10 % free is not low");
        assert!(low(4 * G, false), "under 5 % is low");
        assert!(!low(5 * G, false), "at 5 % is not low");
        assert!(low(5 * G, true), "once low, 5 % is still low (the margin)");
        assert!(!low(6 * G, true), "cleared past 5.5 %");
        // A small disk: the bytes threshold binds first.
        assert!(
            disk_low(900 << 20, 10 * G, G, 5, false),
            "900 MiB of 10 GiB is low"
        );
        assert!(
            disk_low(1100 << 20, 10 * G, G, 5, true),
            "under 1.1 GiB stays low"
        );
        assert!(
            !disk_low(1200 << 20, 10 * G, G, 5, true),
            "cleared past 1.1 GiB and 5.5 %"
        );
        // Zero thresholds never say low; an unread total is not a division by zero.
        assert!(!disk_low(0, 0, 0, 0, false));
    }

    #[test]
    fn the_disk_gauge_says_its_state_once_read() {
        let d = Disk {
            read: std::sync::atomic::AtomicBool::new(false),
            low: std::sync::atomic::AtomicBool::new(false),
            free: AtomicU64::new(0),
            total: AtomicU64::new(0),
            low_bytes: AtomicU64::new(0),
            low_pct: AtomicU64::new(0),
            went_low: AtomicU64::new(0),
        };
        let mut o = String::new();
        d.json(&mut o);
        assert_eq!(o, "", "no field before the first reading");
        assert_eq!(d.reading(50, 100, 10, 20), (false, false));
        assert_eq!(
            d.reading(5, 100, 10, 20),
            (true, true),
            "entering is a change"
        );
        assert_eq!(
            d.reading(5, 100, 10, 20),
            (true, false),
            "staying low is not"
        );
        d.json(&mut o);
        assert_eq!(
            o,
            ",\"disk\":{\"state\":\"low\",\"free_bytes\":5,\"total_bytes\":100,\"free_pct\":5,\"low_bytes\":10,\
             \"low_pct\":20,\"went_low\":1}"
        );
        assert_eq!(
            d.reading(90, 100, 10, 20),
            (false, true),
            "leaving is a change"
        );
    }

    #[test]
    fn buckets_hold_their_values() {
        for us in [0, 1, 3, 4, 5, 7, 8, 100, 1_000, 49_999, 50_000, 1 << 40] {
            let b = bucket(us);
            assert!(bucket_top(b) >= us, "{us} in bucket {b}");
            assert!(
                b == 0 || bucket_top(b - 1) < us,
                "{us} is past bucket {}",
                b - 1
            );
        }
    }

    /// The archiver behind a store that does not answer says so in `health.json`, with the parts waiting for it.
    #[test]
    fn an_archive_behind_says_its_fault_and_the_parts_that_wait() {
        let (archive, queue) = (
            Stream(Mutex::new(String::new())),
            Backlog(Mutex::new((0, 0, 0))),
        );
        let json = || {
            let mut o = String::new();
            archive.json_with("archive", &queue.fields(), &mut o);
            o
        };
        assert_eq!(json(), "", "unset: no field");
        archive.behind("store-unreachable: k: timeout: receive response", 3, 4000);
        queue.set(2, 25, 7);
        assert_eq!(
            json(),
            ",\"archive\":{\"state\":\"behind\",\"fault\":\"store-unreachable: k: timeout: receive response\",\"tries\":3,\"next_try_ms\":4000,\"queued\":2,\"queued_bytes\":25,\"in_log\":7}"
        );
        archive.current();
        assert_eq!(
            json(),
            ",\"archive\":{\"state\":\"current\",\"queued\":2,\"queued_bytes\":25,\"in_log\":7}"
        );
    }

    /// The Souls embodied as the last tick left them are `souls` in `health.json`; never set, no field (26 Nov).
    #[test]
    fn the_souls_in_the_world_are_in_the_health_file() {
        let m = Measures::default();
        let health = |m: &Measures| m.health(steady_us());
        assert!(!health(&m).contains("\"souls\""), "unset: no field");
        m.souls(Some(4));
        assert!(health(&m).ends_with(",\"souls\":4}\n"), "{}", health(&m));
        m.souls(Some(0));
        assert!(
            health(&m).ends_with(",\"souls\":0}\n"),
            "none embodied is 0, not unset"
        );
        m.souls(None);
        assert!(!health(&m).contains("\"souls\""));
    }

    /// A key the public history mirror could not hold is counted in `health.json`, by its key; none, no field.
    #[test]
    fn a_history_export_fault_is_counted_by_its_key() {
        let faults = ExportFaults(Mutex::new((0, String::new(), Default::default())));
        let json = || {
            let mut o = String::new();
            faults.json(&mut o);
            o
        };
        assert_eq!(json(), "");
        assert!(faults.fault(
            "history/everyone/events/00020781/05",
            "history-export: directory symlink or type mismatch"
        ));
        // The same key again is counted, not logged again.
        assert!(!faults.fault(
            "history/everyone/events/00020781/05",
            "history-export: directory symlink or type mismatch",
        ));
        assert!(faults.fault("history/everyone/events/00020781/06", "another key"));
        assert_eq!(
            json(),
            ",\"history_export\":{\"faults\":3,\"last\":\"history/everyone/events/00020781/06: another key\"}"
        );
    }

    #[test]
    fn a_missing_stamp_is_a_zero_part_and_a_swapped_pair_is_counted() {
        let t = steady_us();
        let ms = |n: u64| n * 1_000;
        let mut s = Stamps([
            Some(t),
            Some(t + ms(1)),
            None,
            Some(t + ms(3)),
            None,
            None,
            Some(t + ms(10)),
        ]);
        let (p, inv) = s.parts();
        assert!(!inv);
        assert_eq!(p, [1_000, 0, 2_000, 0, 0, 7_000]);
        s.0[2] = Some(t + ms(5));
        assert!(
            s.parts().1,
            "a check back after the tick began is out of order"
        );
    }

    #[test]
    fn the_block_is_field_3_of_the_frame() {
        let frame = replica::encode::encode(&Value::Map(
            [(1, Value::Uint(7)), (2, Value::Uint(8))].into(),
        ))
        .unwrap();
        let with = with_block(frame, &[1, 2, 3]);
        let Value::Map(m) = decode(&with).unwrap().value else {
            panic!("a map")
        };
        assert_eq!(
            m.get(&3),
            Some(&Value::Array(vec![
                Value::Uint(1),
                Value::Uint(2),
                Value::Uint(3)
            ]))
        );
        assert_eq!(
            replica::encode::encode(&Value::Map(m)).unwrap(),
            with,
            "still canonical"
        );
    }
}
