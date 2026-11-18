//! The world process's clock and its watchdog (Engine v2 K7, #2647).
//!
//! - **The real clock** ([`Real`]): the wall clock read once, at start, carried on by the monotonic clock (`Instant`),
//!   so a step of the wall clock while the world runs moves nothing. It is the only place the process reads time;
//!   `sim` reads it through `sim::clock::Clock`.
//! - **The loop** ([`run`]): the world's time line, its state (the real anchor and the last tick, in a folder until
//!   the durable log, K4), and `sim::clock::Ticker`, which sleeps to absolute deadlines and catches up back to back.
//!   On a restart world time is the later of the wall clock's and the last logged, and the next tick is the one after
//!   the last logged, so no tick is skipped.
//! - **The watchdog** ([`watch`]): a second thread reads the heartbeat; when no tick has ended for the limit, it says
//!   so by name (`tick-stalled`) and ends the process with [`EXIT_TICK_STALLED`]. A supervisor restarts it
//!   (`v2/tools/stall-test` in the test; systemd in production). It ends the process with `exit`, not `abort`: a
//!   memory dump could eat the two seconds a restart has.
//!
//! The world here holds only its time line: loading a world's state is K5's.

// The process's real clock: the one place it reads time (the wall-clock rule, K7).
#![allow(clippy::disallowed_methods)]

use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use sim::clock::{Clock, Heartbeat, Ticker};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The exit code of a process the watchdog ended: a tick stalled.
pub const EXIT_TICK_STALLED: i32 = 86;
/// No tick for this long ends the process, ms (ten ticks at 20 a second).
pub const LIMIT_MS: i64 = 500;
/// Ticks a second.
const RATE: i64 = 20;

/// The wall clock read once at start, carried on by the monotonic clock: µs from the Unix epoch.
#[derive(Clone, Copy, Debug)]
pub struct Real {
    wall0: Micros,
    mono0: Instant,
}

impl Real {
    /// Reads the wall clock, once.
    pub fn start() -> Real {
        let wall0 = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_micros() as Micros);
        Real {
            wall0,
            mono0: Instant::now(),
        }
    }
}

impl Clock for Real {
    fn now(&mut self) -> Micros {
        self.wall0 + self.mono0.elapsed().as_micros() as Micros
    }

    fn sleep_until(&mut self, t: Micros) {
        let wait = t - self.now();
        if wait > 0 {
            std::thread::sleep(Duration::from_micros(wait as u64));
        }
    }
}

/// Watches the heartbeat on its own thread: no tick ended for [`LIMIT_MS`] ends the process by name.
pub fn watch(beat: Arc<Heartbeat>, mut real: Real, limit_ms: i64) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(10));
            let (tick, at) = beat.read();
            let quiet = (real.now() - at) / 1000;
            if quiet > limit_ms {
                println!("watchdog: tick-stalled: no tick for {quiet} ms after tick {tick}");
                eprintln!("worldd: tick-stalled: no tick for {quiet} ms after tick {tick}");
                std::process::exit(EXIT_TICK_STALLED);
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
        eprintln!("usage: worldd --dir <state folder> [--stall-at <tick>] [--watchdog-ms <ms>]");
        return 2;
    };
    let stall_at: Option<i64> = arg("--stall-at").and_then(|v| v.parse().ok());
    let limit = arg("--watchdog-ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(LIMIT_MS);
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
    watch(beat.clone(), real, limit);
    let mut failed = None;
    loop {
        let mut tick = |n: i64, start: Micros| {
            if stall_at == Some(n) {
                println!("stall: blocking tick {n}");
                loop {
                    std::thread::park();
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
