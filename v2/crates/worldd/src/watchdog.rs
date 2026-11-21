//! The world process's clock and its watchdog (Engine v2 K7, #2647).
//!
//! - **The real clock** ([`Real`]): the wall clock read once, at start, carried on by the monotonic clock (`Instant`),
//!   so a step of the wall clock while the world runs moves nothing. It is the only place the process reads time;
//!   `sim` reads it through `sim::clock::Clock`.
//! - **The loop** ([`run`]): the world's time line, its state (the real anchor and the last tick, in a folder until
//!   the durable log, K4), and `sim::clock::Ticker`, which sleeps to absolute deadlines and catches up back to back.
//!   On a restart world time is the later of the wall clock's and the last logged, and the next tick is the one after
//!   the last logged, so no tick is skipped.
//! - **The watchdog** ([`watch`]): a second thread reads the heartbeat. When no tick has ended for the soft limit
//!   ([`LIMIT_MS`]) the world is **stalled**: the watchdog says so by name (`watchdog: stalled`), counts it in
//!   `health.json` (`stalled`, [`worldd::measures::STALLS`]) and keeps running, and it says when ticks come again (a
//!   busy host's pause is not a reason to restart a world with hundreds of Souls in it). Only when no tick has ended
//!   for the hard limit ([`HARD_MS`]) is the clock **wedged**: it says so (`tick-stalled`) and ends the process with
//!   [`EXIT_TICK_STALLED`], and a supervisor restarts it (`v2/tools/stall-test` in the test; systemd in production).
//!   Through a stall it still tells systemd it is alive, so systemd's own 5 s watchdog ends only a process whose
//!   watchdog thread is frozen too. It ends the process with `exit`, not `abort`: a memory dump could eat the two
//!   seconds a restart has.
//!
//! The world here holds only its time line: loading a world's state is K5's.

// The process's real clock: the one place it reads time (the wall-clock rule, K7).
#![allow(clippy::disallowed_methods)]

use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use sim::clock::{Clock, Heartbeat, Ticker};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// The exit code of a process the watchdog ended: a tick stalled.
pub const EXIT_TICK_STALLED: i32 = 86;
/// No tick for this long is a stall, said and counted, ms (ten ticks at 20 a second). The world keeps running.
pub const LIMIT_MS: i64 = 500;
/// No tick for this long is a wedged clock, which ends the process, ms. A host's pause seen in CI was 505 ms (two
/// runners, 21 Nov 2026); the longest real hold of a world's thread on record was 11 s (a 100-agent join burst in
/// the first engine, #2631), which recovered on its own. Past both, a wedged clock is still restarted within about
/// 17 s (this, then K7's 2 s restart).
pub const HARD_MS: i64 = 15_000;
/// Ticks a second.
const RATE: i64 = 20;
/// The wall clock read once at start, carried on by the monotonic clock: µs from the Unix epoch. The world's loop
/// paces itself by the same clock (`worldd::answers`, K18).
pub use worldd::answers::Real;

/// What the watchdog does on one look at the heartbeat.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// Ticking, or still stalled and already said.
    Quiet,
    /// A stall began: no tick for the soft limit.
    Stalled,
    /// Ticks again after a stall of this many ms.
    Again(i64),
    /// No tick for the hard limit: the process ends.
    Wedged,
}

/// The watchdog's state between looks: the soft and hard limits, and the stall under way.
#[derive(Debug)]
struct Watch {
    soft: i64,
    hard: i64,
    stalled: bool,
    longest: i64,
}

impl Watch {
    fn new(soft: i64, hard: i64) -> Watch {
        Watch { soft, hard: hard.max(soft), stalled: false, longest: 0 }
    }

    /// One look: `quiet` ms since the last tick ended.
    fn look(&mut self, quiet: i64) -> Verdict {
        if quiet > self.hard {
            return Verdict::Wedged;
        }
        if quiet > self.soft {
            self.longest = self.longest.max(quiet);
            if self.stalled {
                return Verdict::Quiet;
            }
            self.stalled = true;
            return Verdict::Stalled;
        }
        if self.stalled {
            self.stalled = false;
            return Verdict::Again(std::mem::take(&mut self.longest));
        }
        Verdict::Quiet
    }
}

/// Watches the heartbeat on its own thread: no tick for `limit_ms` is a stall, said and counted, and the world runs
/// on; no tick for [`HARD_MS`] (or `limit_ms`, if longer) ends the process by name.
pub fn watch(beat: Arc<Heartbeat>, real: Real, limit_ms: i64) {
    watch_to(beat, real, limit_ms, HARD_MS);
}

/// [`watch`] with its hard limit given (`--watchdog-hard-ms`).
pub fn watch_to(beat: Arc<Heartbeat>, mut real: Real, limit_ms: i64, hard_ms: i64) {
    let stalls = &worldd::measures::STALLS;
    std::thread::spawn(move || {
        let mut w = Watch::new(limit_ms, hard_ms);
        for k in 1u64.. {
            std::thread::sleep(Duration::from_millis(10));
            let (tick, at) = beat.read();
            let quiet = (real.now() - at) / 1000;
            match w.look(quiet) {
                Verdict::Wedged => {
                    println!("watchdog: tick-stalled: no tick for {quiet} ms after tick {tick}");
                    eprintln!("worldd: tick-stalled: no tick for {quiet} ms after tick {tick}");
                    std::process::exit(EXIT_TICK_STALLED);
                }
                Verdict::Stalled => {
                    println!(
                        "watchdog: stalled: no tick for {quiet} ms after tick {tick}; running on (ends at {} ms)",
                        w.hard
                    );
                    eprintln!("worldd: stalled: no tick for {quiet} ms after tick {tick}; running on");
                    stalls.began(quiet);
                }
                Verdict::Again(ms) => {
                    println!("watchdog: ticking again after a stall of {ms} ms, at tick {tick}");
                    eprintln!("worldd: ticking again after a stall of {ms} ms");
                    stalls.ended(ms);
                }
                Verdict::Quiet if w.stalled => stalls.now(quiet),
                Verdict::Quiet => {}
            }
            // Short of the hard limit: alive, told to the service manager twice a second (O1, #2730).
            if k % 50 == 0 {
                crate::alive();
            }
        }
    });
}

fn read_i64(p: &Path) -> Option<i64> {
    std::fs::read_to_string(p).ok()?.trim().parse().ok()
}

/// Writes `v` to `p` whole: to a file beside it, then renamed over it.
fn write_i64(p: &Path, v: i64) -> std::io::Result<()> {
    let tmp = p.with_extension("new");
    std::fs::write(&tmp, format!("{v}\n"))?;
    std::fs::rename(&tmp, p)
}

/// The process: `worldd --dir <state> [--stall-at <tick>] [--watchdog-ms <ms>]`. Returns the exit code.
pub fn run(args: &[String]) -> i32 {
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|k| args.get(k + 1))
    };
    let Some(dir) = arg("--dir").map(PathBuf::from) else {
        eprintln!(
            "usage: worldd --dir <state folder> [--stall-at <tick> [--stall-for <ms>]] [--watchdog-ms <ms>] \
             [--watchdog-hard-ms <ms>]"
        );
        return 2;
    };
    let stall_at: Option<i64> = arg("--stall-at").and_then(|v| v.parse().ok());
    let limit = arg("--watchdog-ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(LIMIT_MS);
    let hard = arg("--watchdog-hard-ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(HARD_MS);
    // `--stall-for <ms>` holds the blocked tick that long and lets it end; without it the block never ends.
    let stall_for: Option<u64> = arg("--stall-for").and_then(|v| v.parse().ok());
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("worldd: state folder: {e}");
        return 1;
    }
    let mut real = Real::start();
    let now = real.now();
    // The world's start: its real anchor, written once (the mapping's real anchor, a recorded input, T5 rule 10).
    let anchor_file = dir.join("anchor");
    let anchor = match read_i64(&anchor_file) {
        Some(a) => a,
        None => {
            if let Err(e) = write_i64(&anchor_file, now) {
                eprintln!("worldd: anchor: {e}");
                return 1;
            }
            now
        }
    };
    let last_file = dir.join("last");
    let last = read_i64(&last_file);
    let started = Mapping::new(0, anchor, 1, 1).and_then(|m| {
        let line = Timeline::start(m, TickRate::new(0, 0, RATE)?, Tempo::per_minute(0, 0, 120)?)?;
        Ticker::new(line, m, last, now)
    });
    let mut ticker = match started {
        Ok(t) => t,
        Err(e) => {
            eprintln!("worldd: {}", e.name());
            return 1;
        }
    };
    println!(
        "start: next tick {}, world time {} us, last logged {:?}",
        ticker.next_tick(),
        ticker.world(),
        last
    );
    let beat = Arc::new(Heartbeat::new(now));
    watch_to(beat.clone(), real, limit, hard);
    crate::ready();
    let mut failed = None;
    loop {
        let mut tick = |n: i64, start: Micros| {
            if stall_at == Some(n) {
                println!("stall: blocking tick {n}");
                match stall_for {
                    Some(ms) => std::thread::sleep(Duration::from_millis(ms)),
                    None => loop {
                        std::thread::park();
                    },
                }
            }
            if let Err(e) = write_i64(&last_file, n) {
                failed = Some(e);
            }
            println!("tick {n} {start}");
        };
        if let Err(e) = ticker.run_due(&mut real, &beat, &mut tick) {
            eprintln!("worldd: {}", e.name());
            return 1;
        }
        if let Some(e) = failed.take() {
            eprintln!("worldd: last tick: {e}");
            return 1;
        }
        let s = ticker.stats;
        if s.ticks % RATE as u64 == 0 {
            println!(
                "stats: ticks {} last {} us max {} us overruns {} lag {} us max lag {} us",
                s.ticks, s.last_tick_us, s.max_tick_us, s.overruns, s.lag_us, s.max_lag_us
            );
        }
        if let Err(e) = ticker.wait(&mut real) {
            eprintln!("worldd: {}", e.name());
            return 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stall_past_the_soft_limit_is_said_once_and_runs_on() {
        let mut w = Watch::new(500, HARD_MS);
        assert_eq!(w.look(10), Verdict::Quiet);
        assert_eq!(w.look(501), Verdict::Stalled);
        assert_eq!(w.look(600), Verdict::Quiet, "said once");
        assert_eq!(w.look(14_999), Verdict::Quiet, "short of the hard limit it runs on");
        assert_eq!(w.look(3), Verdict::Again(14_999));
        assert_eq!(w.look(3), Verdict::Quiet);
        assert_eq!(w.look(700), Verdict::Stalled, "a second stall is said again");
    }

    #[test]
    fn no_tick_past_the_hard_limit_ends_it() {
        let mut w = Watch::new(500, HARD_MS);
        assert_eq!(w.look(501), Verdict::Stalled);
        assert_eq!(w.look(HARD_MS + 1), Verdict::Wedged);
        // A hard limit under the soft one is the soft one: the old behaviour, ended at the first stall.
        let mut old = Watch::new(500, 0);
        assert_eq!(old.look(500), Verdict::Quiet);
        assert_eq!(old.look(501), Verdict::Wedged);
    }
}
