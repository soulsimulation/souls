//! A served world going to sleep (Engine v2 O2, #2731; 0.133 S3b): `worldd serve --sleep <alarm socket>`, as the
//! launcher starts it (`supervisor launch`). The world's side of `supervisor::sleep`, on a thread of its own:
//!
//! - **At start**, once it serves, it tells the alarm daemon it is `awake` and how long its start took, so the daemon
//!   learns how early to wake it, even before it has woken it once.
//! - **Each second** it reads the clock's [`Quiet`]: still (no intent in hand, no body moving for one) and the next
//!   due time over the world's due lists. Still for [`QUIET_US`] on end, with nothing due within it
//!   ([`may_sleep`]), the world sleeps: the log durable to its last record (a restart replays from the newest
//!   checkpoint and the records after it, as after any restart, K18c), then its alarm acknowledged by the daemon, then
//!   [`before_exit`], then exit [`EXIT_ASLEEP`]. An alarm not acknowledged is no sleep: it stays up and waits another
//!   quiet spell.
//! - An intent sent while it sleeps is held by its gateway, which asks the daemon to wake it (`gatewayd --wake`).
//!
//! Runbook: `v2/docs/runbook/sleep-and-wake.md`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sim::log::Durable;
use supervisor::sleep::{EXIT_ASLEEP, QUIET_US, awake_after, may_sleep, sleep};
use worldd::answers::{Quiet, now};

/// How often the watch reads the clock's [`Quiet`].
const LOOK: Duration = Duration::from_secs(1);

/// The last thing a world does before it exits asleep. S4w's hook: the public stream's writer leaves its pointer
/// saying the world is still until its next due change (`next_due`, world time µs; none: nothing is due). Nothing yet.
pub fn before_exit(_next_due: Option<i64>) {}

/// Starts the watch for the world `name` (its folder's name, the unit's instance), the daemon at `socket`.
pub fn watch(name: String, socket: PathBuf, quiet: Arc<Quiet>, durable: Durable, took_us: i64) {
    std::thread::Builder::new()
        .name("sleep".into())
        .spawn(move || {
            awake_after(&socket, &name, took_us);
            let mut since: Option<i64> = None;
            loop {
                std::thread::sleep(LOOK);
                let (still, next, records) = quiet.read();
                let t = now();
                if !still {
                    since = None;
                    continue;
                }
                let from = *since.get_or_insert(t);
                if t - from < QUIET_US || !may_sleep(t, next, still) {
                    continue;
                }
                let made_durable = || {
                    durable
                        .wait(records)
                        .map(|_| ())
                        .map_err(|r| std::io::Error::other(format!("{r:?}")))
                };
                match sleep(&socket, &name, next, made_durable) {
                    Ok(()) => {
                        before_exit(next);
                        println!("asleep: next due {next:?}");
                        std::process::exit(EXIT_ASLEEP);
                    }
                    Err(e) => {
                        eprintln!("worldd: staying awake: {e}");
                        since = None;
                    }
                }
            }
        })
        .expect("the sleep thread");
}
