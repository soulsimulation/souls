//! A world going to sleep (Engine v2 O2, #2731): the world's side of the alarm daemon's socket.
//!
//! - **When:** a world still, with nothing due for [`QUIET_US`] ([`may_sleep`]). Agents' sockets live in the gateway
//!   and keep no world awake.
//! - **Order:** its checkpoint; then its alarm, a real time or "nothing due", written to the directory by the
//!   machine's alarm daemon and acknowledged; then it exits with [`EXIT_ASLEEP`], which its unit does not restart.
//!   An alarm not acknowledged is no sleep: the world stays up and tries again later, so no wake is ever missed.
//! - **Waking:** at start it says [`awake`], so the daemon learns how long a wake takes and wakes the next one that
//!   much early. World time never stops: a woken world catches up to now exactly (K9's jump) and commits each due
//!   change at its due time.
//!
//! The socket's lines, one asked and one answered per connection: `alarm <world> <due µs|none>` (answered `ok` once
//! written, or `no <reason>`), `wake <world>` (the gateway holding an intent; answered `ok`), `awake <world>`.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

/// Still and nothing due for this long (µs): the world may sleep.
pub const QUIET_US: i64 = 60_000_000;

/// The exit code of a world that went to sleep: its unit neither restarts it nor counts it a failure
/// (`RestartPreventExitStatus` and `SuccessExitStatus` in `worldd@.service`).
pub const EXIT_ASLEEP: i32 = 75;

/// How long a world waits for the daemon's answer.
const ANSWER_WITHIN: Duration = Duration::from_secs(5);

/// Whether a world may sleep at `now`: it is still, and nothing is due for [`QUIET_US`].
pub fn may_sleep(now: i64, next_due: Option<i64>, still: bool) -> bool {
    still && next_due.is_none_or(|d| d - now >= QUIET_US)
}

/// Puts `world` to sleep: `checkpoint` first, then its alarm (`next_due`, or none) through the daemon at `socket`.
/// `Ok` means the alarm is durable and the caller exits with [`EXIT_ASLEEP`]; an error means stay awake.
pub fn sleep(
    socket: &Path,
    world: &str,
    next_due: Option<i64>,
    checkpoint: impl FnOnce() -> std::io::Result<()>,
) -> Result<(), String> {
    checkpoint().map_err(|e| format!("checkpoint: {e}"))?;
    let due = next_due.map_or_else(|| "none".to_owned(), |d| d.to_string());
    match ask(socket, &format!("alarm {world} {due}"))?.as_str() {
        "ok" => Ok(()),
        other => Err(format!("alarm: {other}")),
    }
}

/// Tells the daemon `world` is up (best effort: a missed one only leaves the wake lead as it was).
pub fn awake(socket: &Path, world: &str) {
    let _ = ask(socket, &format!("awake {world}"));
}

/// As [`awake`], with how long its own start took (µs): the daemon learns a world's start even when it did not start
/// it (the first start, by its unit), so its first alarm already wakes it early enough (0.133 S3b).
pub fn awake_after(socket: &Path, world: &str, took_us: i64) {
    let _ = ask(socket, &format!("awake {world} {took_us}"));
}

/// Asks the daemon at `socket` to wake `world` now (the gateway, holding an intent for it).
pub fn wake(socket: &Path, world: &str) -> Result<(), String> {
    match ask(socket, &format!("wake {world}"))?.as_str() {
        "ok" => Ok(()),
        other => Err(format!("wake: {other}")),
    }
}

/// One line asked, one answered.
fn ask(socket: &Path, line: &str) -> Result<String, String> {
    let mut s = UnixStream::connect(socket).map_err(|e| format!("alarm daemon: {e}"))?;
    let _ = s.set_read_timeout(Some(ANSWER_WITHIN));
    s.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("alarm daemon: {e}"))?;
    let mut answer = String::new();
    BufReader::new(s)
        .read_line(&mut answer)
        .map_err(|e| format!("alarm daemon: {e}"))?;
    Ok(answer.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_world_sleeps_only_when_still_with_nothing_due_for_a_minute() {
        assert!(may_sleep(0, None, true));
        assert!(may_sleep(0, Some(QUIET_US), true));
        assert!(!may_sleep(0, Some(QUIET_US - 1), true));
        assert!(!may_sleep(0, None, false));
    }

    #[test]
    fn no_daemon_is_no_sleep() {
        let gone = std::env::temp_dir().join(format!("o2-no-daemon-{}.sock", std::process::id()));
        let mut checkpointed = false;
        let r = sleep(&gone, "w", Some(1), || {
            checkpointed = true;
            Ok(())
        });
        assert!(checkpointed, "the checkpoint comes first");
        assert!(r.is_err(), "no acknowledged alarm, no sleep");
    }
}
