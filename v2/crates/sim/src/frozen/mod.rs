//! A frozen copy for readers (Engine v2 K8, #2671): an unchanging copy of the zone as of the last tick published,
//! which reader threads (checkers, I3) query while the clock goes on. It is a [`Replica`], so it answers the same read
//! interface ([`replica::read::Read`]) as the live one, each node's version stamp included, and carries its version.
//!
//! - **The clock thread hands over the tick's parts** ([`Publisher::publish`]): a channel send, nothing copied. A
//!   whole copy of K2's bench world measured 1.3 to 2.6 ms (the `frozen` bench, `v2/tools/bench/src/frozen.rs`),
//!   over Step 0's 0.5 ms, so the clock never copies.
//! - **A publishing thread of its own applies them to a spare copy** and publishes it: spares are the copies earlier
//!   publishes replaced, reused once no reader holds them, and caught up from the parts kept since. Only when every
//!   spare is held does it copy the newest whole ([`Replica::frozen`]), on its own thread.
//! - **Published behind a plain lock** holding an [`Arc`]: a reader takes the pointer and may keep it as long as it
//!   likes; the copy never changes. The lock is held only to swap or clone the pointer.
//! - **Old copies are freed or reused off the clock thread**: by the publishing thread, or by the last reader to drop
//!   one.
//!
//! A copy applies what the live replica applied, so it never refuses a part. If one does, that copy is dropped, the
//! refusal is counted ([`Counts::refused`]) and the newest good copy stays published: a reader may read an old copy,
//! never a wrong one, and the clock never waits.

use replica::apply::Replica;
use replica::effects::Part;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
mod tests;

/// A copy readers hold: it never changes.
pub type Frozen = Arc<Replica>;

/// Spare copies kept for reuse. A reader holding more than this many old copies costs a whole copy, not a wrong one.
const SPARES: usize = 4;

/// What the publishing thread has done.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    /// Copies published, the first included.
    pub published: u64,
    /// Of those, made by copying the newest whole because no spare was free.
    pub whole: u64,
    /// Parts a copy refused (always 0 unless a copy and the live replica disagree).
    pub refused: u64,
    /// Time the publishing thread spent building copies, in nanoseconds.
    pub busy_ns: u64,
}

struct Shared {
    latest: Mutex<Frozen>,
    published: Condvar,
    published_n: AtomicU64,
    whole: AtomicU64,
    refused: AtomicU64,
    busy_ns: AtomicU64,
}

/// Where the clock thread publishes and readers take the newest copy.
pub struct Publisher {
    shared: Arc<Shared>,
    ticks: Sender<Vec<Arc<Part>>>,
}

impl Publisher {
    /// Publishes a whole copy of `live` and starts the publishing thread, which ends when the publisher is dropped.
    pub fn new(live: &Replica) -> Publisher {
        let shared = Arc::new(Shared {
            latest: Mutex::new(Arc::new(live.frozen())),
            published: Condvar::new(),
            published_n: AtomicU64::new(1),
            whole: AtomicU64::new(1),
            refused: AtomicU64::new(0),
            busy_ns: AtomicU64::new(0),
        });
        let (ticks, rx) = channel();
        let s = Arc::clone(&shared);
        thread::Builder::new()
            .name("frozen-publish".into())
            .spawn(move || run(&s, &rx))
            .unwrap_or_else(|e| panic!("the publishing thread starts: {e}"));
        Publisher { shared, ticks }
    }

    /// The clock thread, at the end of a tick: the parts it applied this tick, in order. A copy with them is
    /// published shortly after, on the publishing thread.
    pub fn publish(&self, parts: Vec<Arc<Part>>) {
        // The thread is gone only if it panicked; the copies then stop at the last one published.
        let _ = self.ticks.send(parts);
    }

    /// A reader: the newest copy published.
    pub fn latest(&self) -> Frozen {
        Arc::clone(
            &self
                .shared
                .latest
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        )
    }

    /// The newest copy once it stands at `version` or later, or after `limit` whatever it stands at.
    pub fn wait_for(&self, version: u64, limit: Duration) -> Frozen {
        let guard = self
            .shared
            .latest
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let (guard, _) = self
            .shared
            .published
            .wait_timeout_while(guard, limit, |f| f.version() < version)
            .unwrap_or_else(PoisonError::into_inner);
        Arc::clone(&guard)
    }

    pub fn counts(&self) -> Counts {
        let s = &self.shared;
        Counts {
            published: s.published_n.load(Relaxed),
            whole: s.whole.load(Relaxed),
            refused: s.refused.load(Relaxed),
            busy_ns: s.busy_ns.load(Relaxed),
        }
    }
}

/// The sequence of a part's first entry and the version after its last; none for a part with no entries.
fn span(p: &Part) -> Option<(u64, u64)> {
    let first = p.effects.first()?.envelope.sequence;
    let last = p.effects.last()?.envelope.sequence;
    Some((first, last + 1))
}

/// The publishing thread: for each tick handed over (and any queued behind it), a spare caught up, or a whole copy of
/// the newest, then published.
// Times its own busy share for `Counts::busy_ns` (a measure, never a verdict); K7's wall-clock rule allows it by name.
#[allow(clippy::disallowed_methods)]
fn run(s: &Shared, ticks: &Receiver<Vec<Arc<Part>>>) {
    // Every part after the oldest version a spare or the newest copy stands at.
    let mut kept: VecDeque<Arc<Part>> = VecDeque::new();
    let mut spares: Vec<Frozen> = Vec::new();
    while let Ok(parts) = ticks.recv() {
        kept.extend(parts);
        kept.extend(ticks.try_iter().flatten());
        let started = Instant::now();
        let latest = Arc::clone(&s.latest.lock().unwrap_or_else(PoisonError::into_inner));
        let mut copy = None;
        for spare in std::mem::take(&mut spares) {
            match copy {
                None => match Arc::try_unwrap(spare) {
                    Ok(r) => copy = Some(r),
                    Err(held) => spares.push(held),
                },
                Some(_) => spares.push(spare),
            }
        }
        let mut copy = copy.unwrap_or_else(|| {
            s.whole.fetch_add(1, Relaxed);
            latest.frozen()
        });
        let mut ok = true;
        for p in &kept {
            if span(p).is_some_and(|(first, _)| first >= copy.version()) && copy.apply(p).is_err() {
                s.refused.fetch_add(1, Relaxed);
                ok = false;
                break;
            }
        }
        if ok {
            let old = {
                let mut l = s.latest.lock().unwrap_or_else(PoisonError::into_inner);
                std::mem::replace(&mut *l, Arc::new(copy))
            };
            s.published.notify_all();
            s.published_n.fetch_add(1, Relaxed);
            spares.insert(0, old);
        }
        drop(latest);
        // The oldest spares go; dropping one a reader holds leaves it to that reader.
        spares.truncate(SPARES);
        let oldest = spares
            .iter()
            .map(|f| f.version())
            .chain([s
                .latest
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .version()])
            .min()
            .unwrap_or(0);
        while kept
            .front()
            .is_some_and(|p| span(p).is_none_or(|(_, end)| end <= oldest))
        {
            kept.pop_front();
        }
        let ns = u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX);
        s.busy_ns.fetch_add(ns, Relaxed);
    }
}
