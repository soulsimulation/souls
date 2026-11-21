//! The served world's log compactor (#3837; `sim::log` rule 9): on a thread of its own, the log's bytes before a place
//! every reader has passed are given back to the disk, so the log on the disk, and what a restart reads, stay bounded
//! however long the world runs.
//!
//! 1. **The floor is the slowest reader.** The oldest checkpoint kept (a restart falls back to it when the newest does
//!    not verify), the public stream's published parts, and with a store the shipper's directory mark and the
//!    archive's closed objects. A world with no checkpoint yet is never compacted.
//! 2. **Only at a durable place.** The writer's durable place is sampled each [`EVERY`]; the cut is the newest sample
//!    at or before the floor, so it is a record boundary whose chain checksum is known.
//! 3. **The grace.** A cut is made once it gives back at least [`MIN_DEAD`] bytes, so a restart reads at most that,
//!    plus what the slowest reader lags, whatever the world's age; and the log is rewritten seldom.
//! 4. **One at a time.** A copy handed to the writer is finished (or refused) before another is made.
//! 5. **The archive's part numbers** (V3 numbers the parts that are not inputs from 0) are not in the log: the cut
//!    file's note keeps the number of the first part after the cut, so a restart numbers on from there.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sim::log::compact::{self, Cut};
use sim::log::{At, Durable};

/// How often the compactor looks.
pub const EVERY: Duration = Duration::from_secs(2);

/// The least a cut gives back (bytes of log), unless `worldd serve --compact-after <bytes>` says otherwise.
pub const MIN_DEAD: u64 = 64 << 20;

/// Samples of the durable place kept (one each [`EVERY`] the log moved: over 2 hours).
const SAMPLES: usize = 4096;

/// The archive's part numbers, by the record each was taken from (rule 5), and how far its closed objects reach.
#[derive(Debug, Default)]
pub struct Parts {
    map: Mutex<VecDeque<(u64, u64)>>,
    next: AtomicU64,
    /// Parts `..durable` are in closed objects.
    pub durable: AtomicU64,
}

impl Parts {
    /// Starts numbering at `next` (the cut's note on a restart).
    pub fn new(next: u64) -> Parts {
        Parts {
            next: AtomicU64::new(next),
            durable: AtomicU64::new(next),
            ..Parts::default()
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<(u64, u64)>> {
        self.map.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Part `part` was taken from record `record`.
    pub fn sent(&self, record: u64, part: u64) {
        self.lock().push_back((record, part));
        self.next.store(part + 1, Ordering::Relaxed);
    }

    /// The first record whose part is not yet in a closed object (none: every part sent is).
    fn floor(&self) -> u64 {
        let durable = self.durable.load(Ordering::Relaxed);
        let map = self.lock();
        let i = map.partition_point(|(_, p)| *p < durable);
        map.get(i).map_or(u64::MAX, |(r, _)| *r)
    }

    /// The number of the first part at or after `record`.
    fn note(&self, record: u64) -> u64 {
        let map = self.lock();
        let i = map.partition_point(|(r, _)| *r < record);
        map.get(i)
            .map_or_else(|| self.next.load(Ordering::Relaxed), |(_, p)| *p)
    }

    fn trim(&self, record: u64) {
        let mut map = self.lock();
        while map.front().is_some_and(|(r, _)| *r < record) {
            map.pop_front();
        }
    }
}

/// The archive's floor: a fork's archive numbers by record, a world's by part.
#[derive(Clone)]
pub enum Archive {
    Records(Arc<AtomicU64>),
    Parts(Arc<Parts>),
}

/// What the floor is made of (rule 1).
pub struct Floors {
    pub checkpoints: PathBuf,
    /// Records `..stream` are in the public stream's published parts.
    pub stream: Arc<AtomicU64>,
    pub shipped: Option<worldd::shipping::Mark>,
    pub archive: Option<Archive>,
}

/// The oldest checkpoint kept in `dir`, by its record (`ckpt-<20 digits>`).
pub fn oldest_checkpoint(dir: &Path) -> Option<u64> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| {
            let name = e.ok()?.file_name();
            let digits = name.to_str()?.strip_prefix("ckpt-")?;
            (digits.len() == 20 && digits.bytes().all(|b| b.is_ascii_digit()))
                .then(|| digits.parse::<u64>().ok())
                .flatten()
        })
        .min()
}

impl Floors {
    fn floor(&self) -> Option<u64> {
        let mut floor = oldest_checkpoint(&self.checkpoints)?;
        floor = floor.min(self.stream.load(Ordering::Relaxed));
        if let Some(s) = &self.shipped {
            floor = floor.min(s.recorded());
        }
        match &self.archive {
            Some(Archive::Records(r)) => floor = floor.min(r.load(Ordering::Relaxed)),
            Some(Archive::Parts(p)) => floor = floor.min(p.floor()),
            None => {}
        }
        Some(floor)
    }
}

// A closed stdout or stderr (a reader that went away) never stops the compactor, as `println!` would.
fn say(line: std::fmt::Arguments<'_>) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout(), "{line}");
}

fn tell(line: std::fmt::Arguments<'_>) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// One look (rules 2 to 4): the cut to make now, if any.
fn choose(samples: &VecDeque<At>, floor: u64, kept_from: u64, min_dead: u64) -> Option<At> {
    let i = samples.partition_point(|a| a.record <= floor);
    let at = *samples.get(i.checked_sub(1)?)?;
    (at.offset >= kept_from.saturating_add(min_dead.max(1))).then_some(at)
}

/// Starts the compactor for the log at `log`; a cut gives back at least `min_dead` bytes.
pub fn spawn(log: PathBuf, durable: Durable, floors: Floors, min_dead: u64) {
    let started = std::thread::Builder::new()
        .name("log-compactor".into())
        .spawn(move || {
            let mut samples: VecDeque<At> = VecDeque::new();
            let mut pending = false;
            loop {
                std::thread::sleep(EVERY);
                if let Some(done) = durable.compacted() {
                    pending = false;
                    match done {
                        Ok(c) => {
                            say(format_args!(
                                "log: compacted, kept from record {} (byte {})",
                                c.at.record, c.at.offset
                            ));
                            if let Some(Archive::Parts(p)) = &floors.archive {
                                p.trim(c.at.record);
                            }
                        }
                        Err(e) => tell(format_args!("worldd: the log was not compacted: {e}")),
                    }
                }
                let now = durable.at();
                if samples.back().is_none_or(|a| a.record < now.record) {
                    samples.push_back(now);
                    if samples.len() > SAMPLES {
                        samples.pop_front();
                    }
                }
                if pending {
                    continue;
                }
                let Some(floor) = floors.floor() else {
                    continue;
                };
                let kept_from = match compact::read_cut(&log) {
                    Ok(c) => c.map_or(0, |c| c.at.offset),
                    Err(e) => {
                        tell(format_args!("worldd: the log's cut: {e}"));
                        continue;
                    }
                };
                let Some(at) = choose(&samples, floor, kept_from, min_dead) else {
                    continue;
                };
                let note = match &floors.archive {
                    Some(Archive::Parts(p)) => p.note(at.record),
                    _ => 0,
                };
                match compact::prepare(&log, Cut { at, note }, now) {
                    Ok(Some(p)) => {
                        durable.compact(p);
                        pending = true;
                    }
                    Ok(None) => {}
                    Err(e) => tell(format_args!("worldd: the log was not compacted: {e}")),
                }
                while samples.front().is_some_and(|a| a.record < at.record) {
                    samples.pop_front();
                }
            }
        });
    if let Err(e) = started {
        tell(format_args!(
            "worldd: the log's compactor did not start: {e}"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(record: u64, offset: u64) -> At {
        At {
            record,
            offset,
            crc: 0,
        }
    }

    #[test]
    fn i3837_the_cut_is_the_newest_sample_at_the_floor_and_only_past_the_grace() {
        let s: VecDeque<At> = [at(10, MIN_DEAD), at(20, 2 * MIN_DEAD), at(30, 3 * MIN_DEAD)]
            .into_iter()
            .collect();
        assert_eq!(choose(&s, 25, 0, MIN_DEAD), Some(at(20, 2 * MIN_DEAD)));
        assert_eq!(
            choose(&s, 9, 0, MIN_DEAD),
            None,
            "nothing at or before the floor"
        );
        assert_eq!(
            choose(&s, 25, MIN_DEAD + 1, MIN_DEAD),
            None,
            "less than the grace given back"
        );
    }

    #[test]
    fn i3837_archive_parts_floor_and_note() {
        let p = Parts::new(5);
        p.sent(100, 5);
        p.sent(103, 6);
        p.sent(104, 7);
        assert_eq!(p.floor(), 100, "nothing closed yet");
        p.durable.store(7, Ordering::Relaxed);
        assert_eq!(p.floor(), 104);
        assert_eq!(p.note(101), 6, "the first part at or after the record");
        assert_eq!(p.note(200), 8, "past every part sent: the next");
        p.durable.store(8, Ordering::Relaxed);
        assert_eq!(p.floor(), u64::MAX);
        p.trim(104);
        assert_eq!(p.note(0), 7);
    }
}
