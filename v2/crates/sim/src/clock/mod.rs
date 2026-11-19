//! The clock (Engine v2 K7, #2647): one thread advances world time in ticks, paced by a clock that cannot jump, and
//! never lets world time go back (`v2/docs/time.md`, rules 10 and 11).
//!
//! - **Time enters through one interface,** [`Clock`]: real time in microseconds on the world's real line, and a
//!   sleep until an absolute real time. The process gives the real one (`worldd`: the wall clock read once at start,
//!   carried on by a monotonic clock); tests and the fault simulation (O5) give [`Fake`]. Nothing in `sim` reads a
//!   clock of its own: `v2/crates/sim/clippy.toml` refuses `Instant::now` and `SystemTime::now` by name.
//! - **Never backwards.** A reading earlier than the last is taken as the last, and world time is the later of what
//!   the mapping gives for real time now and the world time already reached (on a restart, the last logged), so
//!   world time never decreases, whatever the clock does.
//! - **Absolute deadlines.** Tick n is due at its start's real time (the mapping's line, through [`Line`]); the loop
//!   sleeps until that, never for a period, so a late wake does not push later ticks back.
//! - **Catching up.** After an overrun, or a restart that owes ticks, ticks run back to back until the world has
//!   caught up: every tick runs, at its own start, and none is skipped or slowed. The lag (world time owed) is
//!   exposed with tick durations and overruns ([`Stats`]).
//! - **The heartbeat** ([`Heartbeat`]) is written after every tick: the tick and the real time it ended. A watchdog
//!   on another thread (`worldd`) reads it and ends the process by name when it stops; a supervisor restarts it.
//!
//! Not here: timers (K9), per-world limits (O1), measures (O4), what to do when the clock jumps (O10), the durable
//! log (K4) that holds the last world time a restart reads.

use replica::time::{Line, Mapping, Micros, TimeRefusal, Timeline};
use std::sync::atomic::{AtomicI64, Ordering};

/// Real time, and a wait for it: the only way time enters `sim`.
pub trait Clock {
    /// Real time now, µs on the world's real line (a mapping's real anchor is on the same line).
    fn now(&mut self) -> Micros;
    /// Waits until real time `t` (returns at once when it has passed).
    fn sleep_until(&mut self, t: Micros);
}

/// A clock run by a script: each reading is the next of `steps` added to the last (a step may be negative: a clock
/// that goes back; a step read after a tick is what the tick cost), then the last again; a sleep jumps straight to
/// its deadline.
#[derive(Clone, Debug)]
pub struct Fake {
    pub at: Micros,
    pub steps: Vec<Micros>,
    pub next: usize,
}

impl Fake {
    pub fn new(at: Micros, steps: Vec<Micros>) -> Fake {
        Fake { at, steps, next: 0 }
    }
}

impl Clock for Fake {
    fn now(&mut self) -> Micros {
        if let Some(s) = self.steps.get(self.next) {
            self.at += s;
            self.next += 1;
        }
        self.at
    }

    fn sleep_until(&mut self, t: Micros) {
        self.at = self.at.max(t);
    }
}

/// What the loop has done, for anyone to read: tick durations, overruns and the world lag.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Ticks run.
    pub ticks: u64,
    /// The last tick's duration and the longest, real µs.
    pub last_tick_us: Micros,
    pub max_tick_us: Micros,
    /// Ticks that took longer than a tick (the real time from their start to the next's).
    pub overruns: u64,
    /// World time owed when the last tick started (world time now less that tick's start), µs, and the most owed.
    pub lag_us: Micros,
    pub max_lag_us: Micros,
}

/// The last tick done and the real time it ended, written after every tick and read by a watchdog on another thread.
#[derive(Debug)]
pub struct Heartbeat {
    pub tick: AtomicI64,
    pub at: AtomicI64,
}

impl Heartbeat {
    /// No tick done yet (tick −1), at real time `at`.
    pub fn new(at: Micros) -> Heartbeat {
        Heartbeat {
            tick: AtomicI64::new(-1),
            at: AtomicI64::new(at),
        }
    }

    fn beat(&self, tick: i64, at: Micros) {
        self.tick.store(tick, Ordering::Relaxed);
        self.at.store(at, Ordering::Release);
    }

    /// The last tick done and when it ended.
    pub fn read(&self) -> (i64, Micros) {
        let at = self.at.load(Ordering::Acquire);
        (self.tick.load(Ordering::Relaxed), at)
    }
}

/// The tick loop of one world: its time line, the mapping in force, the next tick, the world time reached and the
/// last real time read.
pub struct Ticker {
    line: Timeline,
    mapping: Mapping,
    next: i64,
    world: Micros,
    real: Micros,
    pub stats: Stats,
}

impl Ticker {
    /// The loop of a world whose time line is `line` (with `mapping` the mapping in force), at real time `now`. On a
    /// restart, `last` is the last tick logged: the next is the one after it, and world time is the later of the
    /// mapping's for `now` and that tick's start, so it never goes back. With none, the world starts at tick 0.
    pub fn new(
        line: Timeline,
        mapping: Mapping,
        last: Option<i64>,
        now: Micros,
    ) -> Result<Ticker, TimeRefusal> {
        let next = last.map_or(0, |n| n + 1);
        let logged = match last {
            Some(n) => line.tick_start(n)?,
            None => 0,
        };
        let world = line.world_at(now)?.max(logged);
        Ok(Ticker {
            line,
            mapping,
            next,
            world,
            real: now,
            stats: Stats::default(),
        })
    }

    /// The next tick to run.
    pub fn next_tick(&self) -> i64 {
        self.next
    }

    /// The world time reached: it never decreases.
    pub fn world(&self) -> Micros {
        self.world
    }

    /// The real time the world reaches world time `t` (the first real microsecond at or after it).
    pub fn real_of(&self, t: Micros) -> Result<Micros, TimeRefusal> {
        Line::new(
            self.mapping.real_us,
            self.mapping.world_us,
            self.mapping.rate(),
        )
        .x_of(t)
    }

    /// Reads the clock, never backwards, and carries world time forward to it.
    fn read(&mut self, clock: &mut dyn Clock) -> Result<Micros, TimeRefusal> {
        self.real = clock.now().max(self.real);
        self.world = self.line.world_at(self.real)?.max(self.world);
        Ok(self.real)
    }

    /// Runs every tick due by real time now, back to back, each at its own start: `tick(n, start)`. After each, the
    /// clock is read again, so a loop behind keeps running until it has caught up. Returns how many ran.
    pub fn run_due(
        &mut self,
        clock: &mut dyn Clock,
        beat: &Heartbeat,
        tick: &mut dyn FnMut(i64, Micros),
    ) -> Result<u64, TimeRefusal> {
        self.read(clock)?;
        let mut ran = 0;
        loop {
            let start = self.line.tick_start(self.next)?;
            if start > self.world {
                return Ok(ran);
            }
            let t0 = self.real;
            let lag = self.world - start;
            tick(self.next, start);
            let t1 = self.read(clock)?;
            let length =
                self.real_of(self.line.tick_start(self.next + 1)?)? - self.real_of(start)?;
            let s = &mut self.stats;
            s.ticks += 1;
            s.last_tick_us = t1 - t0;
            s.max_tick_us = s.max_tick_us.max(t1 - t0);
            s.overruns += u64::from(t1 - t0 > length);
            s.lag_us = lag;
            s.max_lag_us = s.max_lag_us.max(lag);
            beat.beat(self.next, t1);
            self.next += 1;
            ran += 1;
        }
    }

    /// Sleeps until the next tick is due: its start's real time, an absolute deadline.
    pub fn wait(&mut self, clock: &mut dyn Clock) -> Result<(), TimeRefusal> {
        clock.sleep_until(self.due()?);
        Ok(())
    }

    /// The real time the next tick is due: a loop that takes work while it waits (K18's zone loop) waits until it.
    pub fn due(&self) -> Result<Micros, TimeRefusal> {
        self.real_of(self.line.tick_start(self.next)?)
    }
}
