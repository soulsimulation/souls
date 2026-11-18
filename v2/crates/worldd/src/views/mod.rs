//! The view tier (Engine v2 R3, #2697; contract T7, `v2/docs/views.md` rules 4 and 5). Everything a client receives
//! is built here, from the log once it is on the disk, never by the clock thread, and once however many receive it.
//!
//! 1. **The clock thread hands over and goes on.** [`Tier::offer`] queues a tick's record (its number in K4's log and
//!    its T6 bytes) and returns; it never waits for the tier or the disk.
//! 2. **A tick is read once it is synced.** The tier's thread waits on K4's durable mark ([`sim::log::Durable`]) for
//!    each record, then applies its entries to its own state of the zone (T6's reference apply), one entry at a time,
//!    with the state just before and just after each, as T7's [`View::step`] needs. It reads nothing but the log.
//! 3. **One view, and one encoded frame a tick, per key in use:** (node, level, audience). Any number of subscribers
//!    of a key share its view and the bytes of its frame. An entry is fed only to the views of its own audience (and,
//!    for an arrival, to every `full` and `sampled` view, which may hold a carried node of theirs), except that the
//!    last entry of a tick is fed to all, so every view's position moves (rule 4). A view's output is the same.
//! 4. **Audience.** A key's audience is everyone or one audience id. A subscriber names its keys: the public one and
//!    one for each audience it is in (T8 says which), so a hall's public frame is built once and each private audience
//!    adds only its own small view. Every record and snapshot passes the redaction list (T8).
//! 5. **A frame is the view's output form** (T7 rule 2) holding the records written in that tick:
//!    `{1: node, 2: level, 3: audience, 4: header hash, 5: last sequence, 6: redaction list hash, 7: version, 8:
//!    [record, ...]}`. A counts view's open second is sent when a later second closes it.
//! 6. **Each subscriber's queue is bounded.** A subscriber that falls behind its bound has its queue emptied and is
//!    handed, after the tick, a snapshot of each of its keys at the view's position, then frames again. A subscriber
//!    that joins after the first tick gets the same snapshots first. A snapshot is the output form with field 9: for
//!    `full` and `sampled`, `{1: [[id, node], ...], 2: [[id, link], ...]}` (the key's subtree, its audience's nodes
//!    and the links of that audience at them, in T6's state layout); for `outline`, `{1: [[id, {1: kind, 2:
//!    parent}], ...]}`; for `counts`, none (its field 8 holds the open second).
//! 7. **No subscriber, no work.** A key whose subscribers are all gone loses its view; the tier only keeps its state.
//! 8. **A fault stays in the tier.** A tick that does not apply stops the tier and is named in [`Stats::fault`]; the
//!    clock goes on.
//!
//! Not here: budgets and the interest set (R4), the viewer's files (V1), words beside references (delivery, K16).

#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use replica::effects::{Body, Header, NodeState, Part, Refusal, State, TransferRec};
use replica::encode::{Value, encode};
use replica::ids::Id;
use replica::views::{Key, Level, Redactions, View};
use replica::world_model::{Audience, DEPTH_LIMIT};
use sim::log::Durable;

type R<T> = Result<T, Refusal>;

fn fault(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

fn bytes_of(v: &Value) -> R<Arc<[u8]>> {
    encode(v)
        .map(Arc::from)
        .map_err(|e| fault("encoding", e.to_string()))
}

/// What a subscriber is handed: a tick's frame of one key, or a snapshot of one key (rule 6). `record` is the log
/// record the view stands at. The bytes are shared by every subscriber of the key.
#[derive(Clone, Debug)]
pub enum Delivery {
    Frame {
        key: Key,
        record: u64,
        bytes: Arc<[u8]>,
    },
    Snapshot {
        key: Key,
        record: u64,
        bytes: Arc<[u8]>,
    },
}

#[derive(Debug, Default)]
struct Queue {
    items: VecDeque<Delivery>,
    behind: bool,
    most: usize,
    snapshots: u64,
}

#[derive(Debug)]
struct Inbox {
    keys: Vec<Key>,
    bound: usize,
    q: Mutex<Queue>,
    ready: Condvar,
}

impl Inbox {
    fn q(&self) -> MutexGuard<'_, Queue> {
        self.q.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Queues a frame; one past the bound empties the queue and marks the subscriber behind until its snapshot.
    fn push(&self, d: Delivery) {
        let mut q = self.q();
        if q.behind {
            return;
        }
        if q.items.len() >= self.bound {
            q.items.clear();
            q.behind = true;
            return;
        }
        q.items.push_back(d);
        q.most = q.most.max(q.items.len());
        self.ready.notify_all();
    }

    /// Replaces whatever is queued with snapshots, and frames follow again.
    fn resume(&self, snapshots: Vec<Delivery>) {
        let mut q = self.q();
        q.items.clear();
        q.items.extend(snapshots);
        q.behind = false;
        q.snapshots += 1;
        q.most = q.most.max(q.items.len());
        self.ready.notify_all();
    }

    fn behind(&self) -> bool {
        self.q().behind
    }
}

/// One subscriber: its keys and its bounded queue. Dropping it ends its subscription.
#[derive(Debug)]
pub struct Subscriber {
    inbox: Arc<Inbox>,
}

impl Subscriber {
    pub fn keys(&self) -> &[Key] {
        &self.inbox.keys
    }

    pub fn try_recv(&self) -> Option<Delivery> {
        self.inbox.q().items.pop_front()
    }

    /// The next delivery, waiting at most `wait` for one.
    pub fn recv_timeout(&self, wait: Duration) -> Option<Delivery> {
        let q = self.inbox.q();
        let (mut q, _) = self
            .inbox
            .ready
            .wait_timeout_while(q, wait, |q| q.items.is_empty())
            .unwrap_or_else(|p| p.into_inner());
        q.items.pop_front()
    }

    /// The most deliveries its queue has held at once.
    pub fn most(&self) -> usize {
        self.inbox.q().most
    }

    /// How many times it was handed snapshots (on joining late, or after falling behind).
    pub fn snapshots(&self) -> u64 {
        self.inbox.q().snapshots
    }
}

/// How long frames took to be ready after their tick's sync, in buckets of [`BUCKET_US`] up to [`BUCKETS`], the last
/// bucket holding everything later; and the ticks whose sync time is not known (an earlier sync made them durable
/// while the tier was busy), counted as late.
#[derive(Clone, Debug)]
pub struct Ready {
    pub buckets: Vec<u64>,
    pub unknown: u64,
}

pub const BUCKET_US: u64 = 100;
pub const BUCKETS: usize = 2_000;

impl Ready {
    /// The latency at quantile `per_mille`, in µs, as its bucket's upper edge; `None` when nothing was timed. An
    /// unknown tick counts as the latest.
    pub fn quantile_us(&self, per_mille: u64) -> Option<u64> {
        let n: u64 = self.buckets.iter().sum::<u64>() + self.unknown;
        if n == 0 {
            return None;
        }
        let want = (n * per_mille).div_ceil(1000).max(1);
        let mut seen = 0;
        for (i, c) in self.buckets.iter().enumerate() {
            seen += c;
            if seen >= want {
                return Some((i as u64 + 1) * BUCKET_US);
            }
        }
        Some(u64::MAX)
    }
}

/// What the tier has done.
#[derive(Clone, Debug)]
pub struct Stats {
    pub ticks: u64,
    /// Frames encoded: one per key in use per tick (rule 3).
    pub frames: u64,
    /// Snapshots encoded (rule 6), one per key per tick at most.
    pub snapshots: u64,
    pub ready: Ready,
    /// Why the tier stopped, if it did (rule 8).
    pub fault: Option<Refusal>,
}

enum Cmd {
    Tick { record: u64, bytes: Vec<u8> },
    Subscribe(Arc<Inbox>),
}

/// The view tier of one zone's log: its thread, and the queue the clock thread hands ticks to.
pub struct Tier {
    tx: Option<Sender<Cmd>>,
    stats: Arc<Mutex<Stats>>,
    thread: Option<JoinHandle<()>>,
}

impl Tier {
    /// Starts the tier on a log whose next record is the first after `start` (the zone's state then).
    pub fn start(
        header: Header,
        start: State,
        redactions: Redactions,
        durable: Durable,
    ) -> R<Tier> {
        let stats = Arc::new(Mutex::new(Stats {
            ticks: 0,
            frames: 0,
            snapshots: 0,
            ready: Ready {
                buckets: vec![0; BUCKETS],
                unknown: 0,
            },
            fault: None,
        }));
        let (tx, rx) = channel();
        let run = Run {
            header,
            before: start.clone(),
            after: start,
            redactions,
            durable,
            slots: Vec::new(),
            at: None,
            made: Vec::new(),
            stats: stats.clone(),
        };
        let thread = std::thread::Builder::new()
            .name("view-tier".into())
            .spawn(move || run.go(rx))
            .map_err(|e| fault("view-tier", format!("the thread did not start: {e}")))?;
        Ok(Tier {
            tx: Some(tx),
            stats,
            thread: Some(thread),
        })
    }

    /// Hands one tick's record to the tier (rule 1). Never waits; a stopped tier drops it.
    pub fn offer(&self, record: u64, bytes: Vec<u8>) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Cmd::Tick { record, bytes });
        }
    }

    /// Subscribes to `keys` with a queue of at most `bound` deliveries (at least one per key). It starts with the next
    /// tick; after the first tick it is handed a snapshot of each key first.
    pub fn subscribe(&self, keys: Vec<Key>, bound: usize) -> Subscriber {
        let inbox = Arc::new(Inbox {
            bound: bound.max(keys.len()).max(1),
            keys,
            q: Mutex::default(),
            ready: Condvar::new(),
        });
        if let Some(tx) = &self.tx {
            let _ = tx.send(Cmd::Subscribe(inbox.clone()));
        }
        Subscriber { inbox }
    }

    pub fn stats(&self) -> Stats {
        self.stats.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Ends the tier once it has read every tick handed to it, and gives its stats.
    pub fn close(mut self) -> Stats {
        self.tx = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        self.stats()
    }
}

impl Drop for Tier {
    fn drop(&mut self) {
        self.tx = None;
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// A key in use: its view and its subscribers.
struct Slot {
    key: Key,
    view: View,
    inboxes: Vec<Arc<Inbox>>,
}

/// The tier's thread.
struct Run {
    header: Header,
    before: State,
    after: State,
    redactions: Redactions,
    durable: Durable,
    slots: Vec<Slot>,
    /// The last record read.
    at: Option<u64>,
    /// The snapshots built at that record, each key's once however many readers need it.
    made: Vec<(Key, Arc<[u8]>)>,
    stats: Arc<Mutex<Stats>>,
}

impl Run {
    fn go(mut self, rx: Receiver<Cmd>) {
        while let Ok(cmd) = rx.recv() {
            let out = match cmd {
                Cmd::Tick { record, bytes } => self.tick(record, &bytes),
                Cmd::Subscribe(inbox) => self.subscribe(inbox),
            };
            if let Err(f) = out {
                self.stats().fault = Some(f);
                return;
            }
        }
    }

    fn stats(&self) -> MutexGuard<'_, Stats> {
        self.stats.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn subscribe(&mut self, inbox: Arc<Inbox>) -> R<()> {
        for key in &inbox.keys {
            match self.slots.iter_mut().find(|s| s.key == *key) {
                Some(s) => s.inboxes.push(inbox.clone()),
                None => self.slots.push(Slot {
                    key: *key,
                    view: View::new(*key, &self.header, &self.redactions),
                    inboxes: vec![inbox.clone()],
                }),
            }
        }
        if let Some(record) = self.at {
            let snaps = self.snapshots(&inbox, record)?;
            inbox.resume(snaps);
        }
        Ok(())
    }

    // Times frames from the sync (A4); the engine never reads this.
    #[allow(clippy::disallowed_methods)]
    fn tick(&mut self, record: u64, bytes: &[u8]) -> R<()> {
        let synced = self.durable.wait(record + 1)?;
        let part = Part::read(bytes)?;
        if part.header != self.header.hash().to_bytes() {
            return Err(fault("header-mismatch", "the record names another header"));
        }
        // No subscriber, no work (rule 7).
        self.slots.retain_mut(|s| {
            s.inboxes.retain(|i| Arc::strong_count(i) > 1);
            !s.inboxes.is_empty()
        });
        let last = part.effects.len().saturating_sub(1);
        for (i, e) in part.effects.iter().enumerate() {
            self.after.apply_entry(&self.header, e)?;
            let arrive = matches!(e.body, Body::Transfer(TransferRec::Arrive { .. }));
            for s in &mut self.slots {
                let carries = arrive && matches!(s.key.level, Level::Full | Level::Sampled);
                if s.key.audience == e.envelope.audience || carries || i == last {
                    s.view
                        .step(&self.before, e, &self.after, &self.redactions)?;
                }
            }
            self.before.apply_entry(&self.header, e)?;
        }
        self.at = Some(record);
        self.made.clear();
        let mut frames = 0u64;
        for s in &mut self.slots {
            let records = s.view.take();
            let mut out = s.view.output();
            out.records = records;
            let bytes = bytes_of(&out.to_value())?;
            frames += 1;
            for inbox in &s.inboxes {
                inbox.push(Delivery::Frame {
                    key: s.key,
                    record,
                    bytes: bytes.clone(),
                });
            }
        }
        // Readers that fell behind get snapshots.
        let mut behind: Vec<Arc<Inbox>> = Vec::new();
        for s in &self.slots {
            for inbox in &s.inboxes {
                if inbox.behind() && !behind.iter().any(|b| Arc::ptr_eq(b, inbox)) {
                    behind.push(inbox.clone());
                }
            }
        }
        for inbox in behind {
            let snaps = self.snapshots(&inbox, record)?;
            inbox.resume(snaps);
        }
        let now = Instant::now();
        let mut st = self.stats();
        st.ticks += 1;
        st.frames += frames;
        match synced {
            Some((from, at)) if record >= from => {
                let us = u64::try_from(now.duration_since(at).as_micros()).unwrap_or(u64::MAX);
                let b = usize::try_from(us / BUCKET_US).unwrap_or(BUCKETS - 1);
                st.ready.buckets[b.min(BUCKETS - 1)] += 1;
            }
            _ => st.ready.unknown += 1,
        }
        Ok(())
    }

    /// A snapshot of each of `inbox`'s keys at the current position, each key's built once at a record.
    fn snapshots(&mut self, inbox: &Inbox, record: u64) -> R<Vec<Delivery>> {
        let mut out = Vec::new();
        for key in &inbox.keys {
            let bytes = match self.made.iter().find(|(k, _)| k == key) {
                Some((_, b)) => b.clone(),
                None => {
                    let b = self.snapshot(*key)?;
                    self.made.push((*key, b.clone()));
                    self.stats().snapshots += 1;
                    b
                }
            };
            out.push(Delivery::Snapshot {
                key: *key,
                record,
                bytes,
            });
        }
        Ok(out)
    }

    /// One key's snapshot (rule 6), from its view's output form and the state at the view's position.
    fn snapshot(&self, key: Key) -> R<Arc<[u8]>> {
        let slot = self
            .slots
            .iter()
            .find(|s| s.key == key)
            .ok_or_else(|| fault("view-missing", "a snapshot of a key not in use"))?;
        let Value::Map(mut m) = slot.view.output().to_value() else {
            unreachable!("an output is a map")
        };
        let state = &self.after;
        let nodes: Vec<(&Id, &NodeState)> = state
            .nodes
            .iter()
            .filter(|(id, n)| n.audience == key.audience && under(state, **id, key.node))
            .collect();
        let pair = |id: &Id, v: Value| Value::Array(vec![id.to_value(), v]);
        let sub = match key.level {
            Level::Full | Level::Sampled => {
                let links = state
                    .links
                    .iter()
                    .filter(|(_, l)| {
                        l.audience == key.audience
                            && l.ends.iter().any(|e| nodes.iter().any(|(n, _)| *n == e))
                    })
                    .map(|(id, l)| {
                        let v = Value::Map(
                            [
                                (1, Value::Text(l.ty.clone())),
                                (
                                    2,
                                    Value::Array(vec![l.ends[0].to_value(), l.ends[1].to_value()]),
                                ),
                                (
                                    3,
                                    Value::Uint(u64::from(
                                        l.owner == replica::world_model::End::Second,
                                    )),
                                ),
                                (4, audience(l.audience)),
                            ]
                            .into(),
                        );
                        pair(id, v)
                    })
                    .collect();
                let nodes = nodes.iter().map(|(id, n)| pair(id, node(n))).collect();
                Some(Value::Map(
                    [(1, Value::Array(nodes)), (2, Value::Array(links))].into(),
                ))
            }
            Level::Outline => {
                let nodes = nodes
                    .iter()
                    .map(|(id, n)| {
                        let mut v = vec![(1, Value::Text(n.kind.clone()))];
                        v.extend(n.parent.map(|p| (2, p.to_value())));
                        pair(id, Value::Map(v.into_iter().collect()))
                    })
                    .collect();
                Some(Value::Map([(1, Value::Array(nodes))].into()))
            }
            Level::Counts => None,
        };
        if let Some(sub) = sub {
            m.insert(9, self.redactions.scrub(sub));
        }
        bytes_of(&Value::Map(m))
    }
}

fn audience(a: Audience) -> Value {
    match a {
        Audience::Everyone => Value::Map([(1, Value::Uint(1))].into()),
        Audience::Of(id) => Value::Map([(1, Value::Uint(2)), (2, id.to_value())].into()),
    }
}

/// A node in T6's state layout: `{1: kind, 2: parent, 3: slot, 4: audience, 5: fields, 6: place, 7: motion}`.
fn node(n: &NodeState) -> Value {
    let mut m: std::collections::BTreeMap<u64, Value> = [
        (1, Value::Text(n.kind.clone())),
        (4, audience(n.audience)),
        (5, Value::Map(n.fields.clone())),
    ]
    .into();
    m.extend(n.parent.map(|p| (2, p.to_value())));
    m.extend(n.slot.map(|s| (3, Value::Uint(s))));
    m.extend(n.place.clone().map(|p| (6, p)));
    m.extend(n.motion.clone().map(|p| (7, p)));
    Value::Map(m)
}

/// Whether `node` is `top` or under it, in `state`; a loop of at most T2's depth.
fn under(state: &State, node: Id, top: Id) -> bool {
    let mut at = Some(node);
    for _ in 0..=DEPTH_LIMIT {
        match at {
            Some(n) if n == top => return true,
            Some(n) => at = state.nodes.get(&n).and_then(|s| s.parent),
            None => return false,
        }
    }
    false
}
