//! The restart record and the health record, kept by the supervisor because a world that cannot start writes none.
//!
//! - **The restart record** (`health/<world>.log`): one line per event, `<ms> start`, `<ms> ready` (the world said it
//!   serves), `<ms> exit <what>` (a failure) or `<ms> stop` (a planned stop, no failure). The launcher writes `start`,
//!   the unit's `ExecStartPost` `ready` and its `ExecStopPost` the end. The last [`KEEP`] lines are kept.
//! - **The health record** (`health/<world>.json`), judged from it at each event by [`judge`]: `running`, `starting`,
//!   `restarting`, or `restart-loop` for a world started [`LOOP_STARTS`] times in [`LOOP_WINDOW_MS`] that is not
//!   serving, with its count, its last exit and its next try.

use std::path::{Path, PathBuf};

use crate::{
    EXIT_BUILD_MISMATCH, EXIT_BUILD_MISSING, EXIT_PIN_MISSING, RESTART_MAX_MS, RESTART_SEC_MS,
    RESTART_STEPS,
};

/// Starts within [`LOOP_WINDOW_MS`] that make a world not serving a `restart-loop`.
pub const LOOP_STARTS: usize = 5;
pub const LOOP_WINDOW_MS: i64 = 5 * 60 * 1000;
/// Lines of the restart record kept.
pub const KEEP: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Start,
    Ready,
    Exit(String),
    Stop,
}

/// What the health record says of one world.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Health {
    pub state: &'static str,
    /// Starts within the last five minutes.
    pub count: usize,
    /// Failures since the world last served.
    pub failures: i64,
    pub last_exit: Option<String>,
    /// When the next try is due, ms, while the world waits for one.
    pub next_try: Option<i64>,
}

/// systemd's delay before restart `n` (0 the first): from [`RESTART_SEC_MS`] growing exponentially to
/// [`RESTART_MAX_MS`] over [`RESTART_STEPS`] restarts.
pub fn delay_ms(n: i64) -> i64 {
    if n >= RESTART_STEPS {
        return RESTART_MAX_MS;
    }
    let ratio = RESTART_MAX_MS as f64 / RESTART_SEC_MS as f64;
    (RESTART_SEC_MS as f64 * ratio.powf(n as f64 / RESTART_STEPS as f64)) as i64
}

/// The health record judged from the restart record at `now`.
pub fn judge(events: &[(i64, Event)], now: i64) -> Health {
    let count = events
        .iter()
        .filter(|(t, e)| *e == Event::Start && now - t < LOOP_WINDOW_MS)
        .count();
    let since_ready = events
        .iter()
        .rposition(|(_, e)| *e == Event::Ready)
        .map_or(0, |k| k + 1);
    let failures = events[since_ready..]
        .iter()
        .filter(|(_, e)| matches!(e, Event::Exit(_)))
        .count() as i64;
    let last_exit = events.iter().rev().find_map(|(_, e)| match e {
        Event::Exit(what) => Some(what.clone()),
        _ => None,
    });
    let last = events.last();
    let next_try = match last {
        Some((t, Event::Exit(_))) => Some(t + delay_ms(failures - 1)),
        _ => None,
    };
    let state = match last.map(|(_, e)| e) {
        Some(Event::Ready) => "running",
        Some(Event::Stop) => "stopped",
        _ if count >= LOOP_STARTS => "restart-loop",
        Some(Event::Exit(_)) => "restarting",
        _ => "starting",
    };
    Health {
        state,
        count,
        failures,
        last_exit,
        next_try,
    }
}

/// How a unit's main process ended, from what systemd hands `ExecStopPost`: `$SERVICE_RESULT`, `$EXIT_CODE` and
/// `$EXIT_STATUS`. `None` is a planned stop, no failure.
pub fn exit_name(result: &str, code: &str, status: &str) -> Option<String> {
    if result == "success" {
        return None;
    }
    let named = match (code, status.parse::<i32>().ok()) {
        ("exited", Some(EXIT_PIN_MISSING)) => "pin.missing",
        ("exited", Some(EXIT_BUILD_MISSING)) => "build.missing",
        ("exited", Some(EXIT_BUILD_MISMATCH)) => "build.mismatch",
        ("exited", Some(86)) => "tick-stalled",
        ("exited", Some(87)) => "disk-failed",
        _ => result,
    };
    Some(format!("{named} ({code} {status})"))
}

fn log_path(root: &Path, world: &str) -> PathBuf {
    root.join("health").join(format!("{world}.log"))
}

pub fn record_path(root: &Path, world: &str) -> PathBuf {
    root.join("health").join(format!("{world}.json"))
}

/// The restart record, oldest first; lines it cannot read are skipped.
pub fn read(root: &Path, world: &str) -> Vec<(i64, Event)> {
    let text = std::fs::read_to_string(log_path(root, world)).unwrap_or_default();
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, ' ');
            let t = parts.next()?.parse().ok()?;
            let e = match (parts.next()?, parts.next()) {
                ("start", _) => Event::Start,
                ("ready", _) => Event::Ready,
                ("stop", _) => Event::Stop,
                ("exit", Some(what)) => Event::Exit(what.to_owned()),
                _ => return None,
            };
            Some((t, e))
        })
        .collect()
}

/// Adds `event` to the restart record at `now` and writes the health record again. Returns the health record.
pub fn record(root: &Path, world: &str, now: i64, event: Event) -> std::io::Result<Health> {
    let mut events = read(root, world);
    events.push((now, event));
    let from = events.len().saturating_sub(KEEP);
    let events = &events[from..];
    let mut text = String::new();
    for (t, e) in events {
        let line = match e {
            Event::Start => format!("{t} start\n"),
            Event::Ready => format!("{t} ready\n"),
            Event::Stop => format!("{t} stop\n"),
            Event::Exit(what) => format!("{t} exit {}\n", what.replace('\n', " ")),
        };
        text.push_str(&line);
    }
    std::fs::create_dir_all(root.join("health"))?;
    write_whole(&log_path(root, world), &text)?;
    let health = judge(events, now);
    write_whole(&record_path(root, world), &to_json(world, now, &health))?;
    Ok(health)
}

fn write_whole(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("new");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// The health record as one line of JSON.
pub fn to_json(world: &str, at: i64, h: &Health) -> String {
    let opt_str = |s: &Option<String>| {
        s.as_ref().map_or("null".to_owned(), |s| {
            format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
        })
    };
    let opt_num = |n: Option<i64>| n.map_or("null".to_owned(), |n| n.to_string());
    format!(
        "{{\"world\":\"{world}\",\"at\":{at},\"state\":\"{}\",\"count\":{},\"failures\":{},\"last_exit\":{},\"next_try\":{}}}\n",
        h.state,
        h.count,
        h.failures,
        opt_str(&h.last_exit),
        opt_num(h.next_try)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_failed_starts_in_five_minutes_are_a_restart_loop() {
        let mut events = vec![(0, Event::Start), (10, Event::Ready)];
        for k in 0..5 {
            events.push((
                1000 + k * 100,
                Event::Exit("build.missing (exited 78)".into()),
            ));
            events.push((1050 + k * 100, Event::Start));
        }
        events.push((2000, Event::Exit("build.missing (exited 78)".into())));
        let h = judge(&events, 2001);
        assert_eq!(h.state, "restart-loop");
        assert_eq!(h.count, 6);
        assert_eq!(h.failures, 6);
        assert_eq!(h.last_exit.as_deref(), Some("build.missing (exited 78)"));
        assert_eq!(h.next_try, Some(2000 + delay_ms(5)));
        // Serving again ends the loop.
        events.push((2100, Event::Start));
        events.push((2200, Event::Ready));
        assert_eq!(judge(&events, 2201).state, "running");
    }

    #[test]
    fn the_delay_grows_to_its_longest_and_stays() {
        assert_eq!(delay_ms(0), RESTART_SEC_MS);
        assert!((1..RESTART_STEPS).all(|n| delay_ms(n) > delay_ms(n - 1)));
        assert_eq!(delay_ms(RESTART_STEPS), RESTART_MAX_MS);
        assert_eq!(delay_ms(1000), RESTART_MAX_MS);
    }

    #[test]
    fn a_planned_stop_is_no_failure() {
        assert_eq!(exit_name("success", "exited", "0"), None);
        assert_eq!(
            exit_name("exit-code", "exited", "78").as_deref(),
            Some("build.missing (exited 78)")
        );
        assert_eq!(
            exit_name("oom-kill", "killed", "KILL").as_deref(),
            Some("oom-kill (killed KILL)")
        );
        assert_eq!(
            exit_name("exit-code", "exited", "87").as_deref(),
            Some("disk-failed (exited 87)")
        );
        assert_eq!(
            exit_name("exit-code", "exited", "86").as_deref(),
            Some("tick-stalled (exited 86)")
        );
    }
}
