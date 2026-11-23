//! The machine's alarm daemon (Engine v2 O2, #2731): `supervisor alarms`, one per machine
//! (`souls-alarms.service`), the one writer of its alarm record ([`crate::alarm`]) and the one that wakes sleeping
//! worlds.
//!
//! - **At start** it reads the record and arms every alarm, overdue first: a world whose alarm came due while the
//!   daemon or the machine was down is woken at once. A killed daemon or a reboot loses no alarm.
//! - **Early by the wake and the queue:** a world is woken at its due time less the longest wake measured lately and
//!   a quarter more (start to `awake`, or the world's own start when its unit started it; at least [`WAKE_FLOOR_US`])
//!   less [`START_US`] for each other world due within a second either side of it, so 100 worlds due in one second
//!   are started in order and each is up before its due change. A woken world waits for
//!   its due time; it never commits early.
//! - **By an intent:** `wake <world>` (the gateway holds an intent for it) starts the world now. Nothing else wakes
//!   one: a viewer never reaches this socket.
//! - **Idle:** with nothing to fire it blocks on its queue, re-reading the wall clock at least every
//!   [`RECHECK_US`], so a stepped clock moves an alarm by at most that much (clock jumps are O10's).
//!
//! Waking is [`Waker`]: `systemctl start --no-block worldd@<world>.service` on a machine ([`Systemd`]), or a program
//! given the world's name ([`Program`]).

use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use directoryd::directory::store::Store;

use crate::alarm::Record;

/// The shortest lead a world is woken with, µs: before any wake is measured, and the floor after.
pub const WAKE_FLOOR_US: i64 = 500_000;
/// The extra lead for each other world due within a second either side of this one, µs: systemd starts units one at
/// a time, and O2's runs measured 30 to 68 ms a start on a loaded 2-processor machine. A crowd of 100 is woken about
/// 8 s early, which costs nothing: a world never commits early.
pub const START_US: i64 = 80_000;
/// The longest the daemon blocks before it reads the wall clock again, µs.
pub const RECHECK_US: i64 = 1_000_000;
/// Wakes measured that the lead is the longest of.
const MEASURED: usize = 16;

/// Starts worlds: every world due at once in one call, so a crowd costs one start request, not one per world.
pub trait Waker {
    fn wake(&mut self, worlds: &[String]);
}

/// `systemctl start --no-block worldd@<world>.service ...`, all in one call: a world already running is left as it
/// is. One call per world measured about 20 ms each, so 100 due in one second were started over 2 s (O2's runs). Not
/// waited for: the daemon's loop never blocks on systemd.
pub struct Systemd;

impl Waker for Systemd {
    fn wake(&mut self, worlds: &[String]) {
        if worlds.is_empty() {
            return;
        }
        let child = Command::new("systemctl")
            .args(["start", "--no-block"])
            .args(worlds.iter().map(|w| format!("worldd@{w}.service")))
            .stdin(Stdio::null())
            .spawn();
        let n = worlds.len();
        match child {
            // Reaped on its own thread, so the loop goes on while systemd queues the starts.
            Ok(mut c) => {
                std::thread::spawn(move || {
                    if !c.wait().is_ok_and(|s| s.success()) {
                        eprintln!("alarms: wake of {n} worlds: systemctl failed");
                    }
                });
            }
            Err(e) => eprintln!("alarms: wake of {n} worlds: {e}"),
        }
    }
}

/// A program run with the world's name, not waited for (a machine without systemd).
pub struct Program(pub String);

impl Waker for Program {
    fn wake(&mut self, worlds: &[String]) {
        for world in worlds {
            let r = Command::new(&self.0)
                .arg(world)
                .stdin(Stdio::null())
                .spawn();
            if let Err(e) = r {
                eprintln!("alarms: wake {world}: {e}");
            }
        }
    }
}

/// What the socket hands the daemon; each carries where its answer goes.
pub enum Msg {
    Alarm(String, Option<i64>, Sender<String>),
    Wake(String, Sender<String>),
    /// A world up, with how long its own start took (µs) when it says.
    Awake(String, Option<i64>),
}

/// Reads one line from each connection to `socket` and hands it on; answers what comes back.
pub fn listen(socket: &Path, to: Sender<Msg>) -> std::io::Result<()> {
    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket)?;
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let to = to.clone();
            std::thread::spawn(move || {
                let mut line = String::new();
                let Ok(mut s) = stream.try_clone() else {
                    return;
                };
                if BufReader::new(stream).read_line(&mut line).is_err() {
                    return;
                }
                let (tx, rx) = mpsc::channel();
                let msg = match line.split_whitespace().collect::<Vec<_>>()[..] {
                    ["alarm", world, "none"] => Some(Msg::Alarm(world.into(), None, tx)),
                    ["alarm", world, due] => due
                        .parse()
                        .ok()
                        .map(|d| Msg::Alarm(world.into(), Some(d), tx)),
                    ["wake", world] => Some(Msg::Wake(world.into(), tx)),
                    ["awake", world] => {
                        let _ = to.send(Msg::Awake(world.into(), None));
                        let _ = s.write_all(b"ok\n");
                        return;
                    }
                    ["awake", world, took] => {
                        let _ = to.send(Msg::Awake(world.into(), took.parse().ok()));
                        let _ = s.write_all(b"ok\n");
                        return;
                    }
                    _ => None,
                };
                let answer = match msg {
                    Some(m) => match to.send(m) {
                        Ok(()) => rx.recv().unwrap_or_else(|_| "no gone".into()),
                        Err(_) => "no gone".into(),
                    },
                    None => format!("no unread {:?}", line.trim()),
                };
                let _ = s.write_all(format!("{answer}\n").as_bytes());
            });
        }
    });
    Ok(())
}

/// The daemon's state: the record, the worlds woken and not yet asleep again, the wakes measured.
pub struct Daemon<S: Store> {
    pub record: Record<S>,
    /// Worlds woken (by alarm or intent), with when, until they set a new alarm.
    fired: BTreeMap<String, i64>,
    wakes: VecDeque<i64>,
}

impl<S: Store> Daemon<S> {
    pub fn new(record: Record<S>) -> Daemon<S> {
        Daemon {
            record,
            fired: BTreeMap::new(),
            wakes: VecDeque::new(),
        }
    }

    /// The lead a world is woken with: the longest wake measured lately and a quarter more (a large world's start
    /// varies by a second or two: 0.133 S3b measured imported Eden at 9.7 to 11.7 s), at least [`WAKE_FLOOR_US`].
    pub fn lead(&self) -> i64 {
        let longest = self.wakes.iter().copied().max().unwrap_or(0);
        (longest + longest / 4).max(WAKE_FLOOR_US)
    }

    /// Each armed alarm's wake time, in the order of the due times (overdue first): its due time less the lead and
    /// the queue (every other world due within a second either side, started with it), and no later than the wake
    /// time of any world due after it.
    pub fn plan(&self) -> Vec<(i64, String)> {
        let mut due: Vec<(i64, &String)> = self
            .record
            .alarms
            .iter()
            .filter(|(w, _)| !self.fired.contains_key(*w))
            .filter_map(|(w, d)| d.map(|d| (d, w)))
            .collect();
        due.sort();
        let lead = self.lead();
        let mut out: Vec<(i64, String)> = due
            .iter()
            .map(|(d, w)| {
                let lo = due.partition_point(|(e, _)| *e < d - 1_000_000);
                let hi = due.partition_point(|(e, _)| *e <= d + 1_000_000);
                let queue = (hi - lo - 1) as i64;
                (d - lead - queue * START_US, (*w).clone())
            })
            .collect();
        // A world is never woken after one due later than it: the queue keeps the order of the due times.
        for k in (1..out.len()).rev() {
            out[k - 1].0 = out[k - 1].0.min(out[k].0);
        }
        out
    }

    /// Wakes every world whose wake time has come; returns when the next one is.
    pub fn fire(&mut self, now: i64, waker: &mut dyn Waker) -> Option<i64> {
        let mut due = Vec::new();
        let mut next = None;
        for (at, world) in self.plan() {
            if at > now {
                next = Some(at);
                break;
            }
            due.push(world);
        }
        waker.wake(&due);
        for world in due {
            self.fired.insert(world, now);
        }
        next
    }

    /// Handles one message from the socket.
    pub fn handle(&mut self, msg: Msg, now: i64, waker: &mut dyn Waker) {
        match msg {
            Msg::Alarm(world, due, answer) => {
                let r = self.record.set(&world, due);
                if r.is_ok() {
                    self.fired.remove(&world);
                }
                let _ = answer.send(r.map_or_else(|e| format!("no {e}"), |()| "ok".into()));
            }
            Msg::Wake(world, answer) => {
                waker.wake(std::slice::from_ref(&world));
                self.fired.entry(world).or_insert(now);
                let _ = answer.send("ok".into());
            }
            Msg::Awake(world, took) => {
                // Measured from the daemon's wake when it woke the world, else the world's own start (0.133 S3b).
                let measured = self.fired.get(&world).map(|at| now - at).or(took);
                if let Some(m) = measured {
                    self.wakes.push_back(m);
                    if self.wakes.len() > MEASURED {
                        self.wakes.pop_front();
                    }
                }
            }
        }
    }

    /// Runs until the socket's sender is gone: fires what is due, then waits for a message or the next wake time.
    pub fn run(&mut self, rx: &Receiver<Msg>, waker: &mut dyn Waker, mut now: impl FnMut() -> i64) {
        loop {
            let t = now();
            let next = self.fire(t, waker);
            let wait = next.map_or(RECHECK_US, |n| (n - t).clamp(0, RECHECK_US));
            match rx.recv_timeout(Duration::from_micros(wait as u64)) {
                Ok(msg) => self.handle(msg, now(), waker),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use directoryd::directory::store::Memory;

    #[derive(Default)]
    struct Woken(Vec<String>);

    impl Waker for Woken {
        fn wake(&mut self, worlds: &[String]) {
            self.0.extend_from_slice(worlds);
        }
    }

    fn daemon(store: &Memory) -> Daemon<&Memory> {
        Daemon::new(Record::load(store, "m").expect("loaded"))
    }

    #[test]
    fn overdue_alarms_fire_first_at_start_and_nothing_due_never_fires() {
        let store = Memory::default();
        let mut d = daemon(&store);
        d.record.set("late", Some(1_000_000)).expect("set");
        d.record.set("later", Some(2_000_000)).expect("set");
        d.record.set("future", Some(100_000_000)).expect("set");
        d.record.set("idle", None).expect("set");
        // A restarted daemon: the record is all it has.
        let mut d = daemon(&store);
        let mut w = Woken::default();
        let next = d.fire(50_000_000, &mut w);
        assert_eq!(w.0, ["late", "later"]);
        assert_eq!(next, Some(100_000_000 - WAKE_FLOOR_US));
        // Fired once: not again until the world sleeps again.
        assert_eq!(d.fire(60_000_000, &mut w), next);
        assert_eq!(w.0.len(), 2);
    }

    #[test]
    fn a_world_due_in_a_crowded_second_is_woken_earlier() {
        let store = Memory::default();
        let mut d = daemon(&store);
        for k in 0..100 {
            d.record
                .set(&format!("w{k:03}"), Some(10_000_000 + k * 5_000))
                .expect("set");
        }
        let plan = d.plan();
        // Each of the crowd is woken its lead and 99 starts early: the first of it too.
        let early = WAKE_FLOOR_US + 99 * START_US;
        assert_eq!(plan[0], (10_000_000 - early, "w000".to_owned()));
        assert_eq!(plan[99], (10_495_000 - early, "w099".to_owned()));
        assert!(plan.windows(2).all(|p| p[0].0 <= p[1].0 && p[0].1 < p[1].1));
    }

    #[test]
    fn the_lead_is_the_longest_wake_measured() {
        let store = Memory::default();
        let mut d = daemon(&store);
        let mut w = Woken::default();
        let (tx, _rx) = mpsc::channel();
        d.handle(Msg::Wake("a".into(), tx), 0, &mut w);
        d.handle(Msg::Awake("a".into(), None), 900_000, &mut w);
        assert_eq!(d.lead(), 1_125_000);
        assert_eq!(w.0, ["a"]);
    }

    #[test]
    fn a_world_started_by_its_unit_says_how_long_its_start_took() {
        let store = Memory::default();
        let mut d = daemon(&store);
        let mut w = Woken::default();
        // Not woken by the daemon: its own measure is the one it has.
        d.handle(Msg::Awake("eden".into(), Some(10_000_000)), 0, &mut w);
        assert_eq!(d.lead(), 12_500_000);
        d.handle(Msg::Awake("other".into(), None), 0, &mut w);
        assert_eq!(
            d.lead(),
            12_500_000,
            "an awake with no measure measures nothing"
        );
    }
}
