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
use std::sync::atomic::{AtomicU64, Ordering};
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
        o.push_str(",\"sync\":");
        SYNCS.json(&mut o);
        o.push_str("}\n");
        o
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
