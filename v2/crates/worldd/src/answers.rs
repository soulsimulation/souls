//! The world takes intents, commits them at the next tick and answers after that tick's sync (Engine v2 I4, #2687;
//! the durability contract, `v2/docs/durability.md`: an act is acknowledged once it is on the machine's disk).
//!
//! Three threads, so the clock never waits on a disk or a rule:
//!
//! - **The clock thread** ([`start`]) takes each intent as it arrives: a repeat gets its kept answer or
//!   `intent.stale-seq` (`sim::commit::acts`), an expired one ends `intent.expired`, and a fresh one gets an id
//!   minted from the world's lineage, a deadline on the due list and a place on the checkers' queue (I3). At each tick
//!   it commits the checks that came back (`sim::commit::commit`), ends the acts whose deadline has passed
//!   (`act.timed-out`), and writes one record: a T6 part of the tick's entries, whose field [`ANSWERED`] lists every
//!   intent answered in the tick with its answer. Every entry an intent causes names it as its cause, so its receipt
//!   is found by that index. The logged intent is the intent as received, which holds no free text (below).
//! - **The answers thread** ([`answer_loop`]) owns the log: it appends each tick's record, waits until the record is
//!   on the disk, and only then sends that tick's answers. Answers leave in tick order, so a repeat answered from the
//!   kept table also waits for the sync of the tick that took it.
//! - **Checker threads** (`checkers`), as I3 left them.
//!
//! **A restart** replays the log: each record's entries are applied to the world as built, the receipts index and
//! each actor's last sequence and kept answers are rebuilt from it, and new intent ids follow the last one minted.
//! A repeat after a restart gets the answer it had; an intent that was open at the kill was never logged nor
//! answered, and is taken again when the gateway sends it again.
//!
//! **Free text** goes to K16's text store first and the log holds its reference only (`{21: id}`, T8 rule 6). Words
//! come in an intent as T8's `{23: words}` (CBOR text is names only, so words are bytes). K16 has no store yet, so an
//! intent carrying words is refused `intent.text-not-stored` and logged without its intent: none of their bytes
//! reach the log (`a5_` test).
//!
//! **Sync by hash** (R5b, #3164): a frame with key 20 is R5's sync request (`replica::sync::wire`), not an intent.
//! The clock thread answers it from the tree as last sealed, sealing first when the world has changed since, and
//! every record a seal gave is kept, so a client compares and descends over the place, which every actor is granted.
//! Its answer goes to the answers thread at once, behind every tick record already sent: it never shows a change
//! before the change is on the disk, and never waits for a tick.
//!
//! World time is the machine's clock in microseconds until the tick loop runs on K7's ticker.
// worldd's real clock: the tick loop and world time read the machine's clocks until K7's ticker drives them.
#![allow(clippy::disallowed_methods)]

use crate::checkers::{self, Act, Candidate, Rules};
use replica::apply::Replica;
use replica::effects::{Actor, Cause, Effect, Part, Refusal};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Answer, Intent, Target};
use replica::sync::{self, Records, Served, wire};
use replica::time::Micros;
use sim::commit::acts::{Deadlines, Receipts, Seen, Sequences, expired};
use sim::commit::{Checks, Outcome, commit, mark_clock_thread};
use sim::frozen::Publisher;
use sim::log::{Log, Storage};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Write;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type R<T> = Result<T, Refusal>;

/// Where an answer frame goes: the connection the intent came on.
pub type Reply = Sender<Vec<u8>>;

/// The field of a tick's part that lists the intents answered in it: `[{1: actor, 2: sequence, 3: intent id, 4:
/// answer frame, 5: intent}]`, 3 left out for an intent refused before it got an id, 5 for one whose intent holds
/// words.
pub const ANSWERED: u64 = 3;

pub enum Event {
    /// An intent's bytes as they came off the gateway's socket.
    Arrival {
        bytes: Vec<u8>,
        reply: Reply,
    },
    Checked(Box<(Act, Checks)>),
    Stop,
}

pub struct Config {
    pub lineage: Scope,
    pub epoch: u64,
    pub tick: Duration,
    /// The longest an act stays open, from its arrival, when its expiry is later.
    pub deadline: Micros,
    pub checkers: usize,
    /// `<actor hex> <sequence>` appended for each fresh intent, in the order taken (I1's restart bench).
    pub arrivals: Option<File>,
    /// `<version> <place hash hex>` appended after each tick that changed the world, the tree sealed for it (R5b's
    /// relay test checks a client's copy against it).
    pub roots: Option<File>,
}

impl Config {
    pub fn new(lineage: Scope, epoch: u64) -> Config {
        Config {
            lineage,
            epoch,
            tick: Duration::from_millis(50),
            deadline: 10_000_000,
            checkers: 2,
            arrivals: None,
            roots: None,
        }
    }
}

/// The running world: send it [`Event`]s; [`World::stop`] ends it once the answers already due are sent.
pub struct World {
    pub events: Sender<Event>,
    clock: Option<JoinHandle<()>>,
}

impl World {
    pub fn stop(mut self) {
        let _ = self.events.send(Event::Stop);
        if let Some(c) = self.clock.take() {
            let _ = c.join();
        }
    }
}

/// World time: the machine's clock, in microseconds.
pub fn now() -> Micros {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}

struct Open {
    actor: Actor,
    key: Vec<u8>,
    sequence: u64,
    body: Id,
    expiry: Micros,
    intent: Value,
    waiters: Vec<Reply>,
}

/// One tick's record and the answers it releases once it is on the disk.
struct Tick {
    record: Option<Vec<u8>>,
    replies: Vec<(Vec<Reply>, Vec<u8>)>,
}

struct Clock {
    replica: Replica,
    publisher: Arc<Publisher>,
    acts: Sender<Act>,
    answers: Sender<Tick>,
    sequences: Sequences,
    receipts: Receipts,
    deadlines: Deadlines,
    open: HashMap<Id, Open>,
    in_flight: HashMap<(Vec<u8>, u64), Id>,
    next_intent: u64,
    lineage: Scope,
    zone: Id,
    epoch: u64,
    deadline: Micros,
    arrivals: Option<File>,
    roots: Option<File>,
    /// Every record the tree's seals gave, and whether the world changed since the last seal (R5b).
    records: Records,
    unsealed: bool,
    checked: Vec<(Act, Checks)>,
    replies: Vec<(Vec<Reply>, Vec<u8>)>,
    rows: Vec<Value>,
    effects: Vec<Effect>,
    parts: Vec<Arc<Part>>,
}

fn name(s: &str) -> Name {
    Name::new(s).unwrap_or_else(|| Name::new("act.refused").expect("a name"))
}

/// An actor's encoded bytes, field 1 of the intent as received: the key of its sequences.
fn actor_key(bytes: &[u8]) -> Option<Vec<u8>> {
    match decode(bytes).ok()?.value {
        Value::Map(m) => encode(m.get(&1)?).ok(),
        _ => None,
    }
}

/// Whether a value holds words (T8's field 23) anywhere.
fn has_words(v: &Value) -> bool {
    match v {
        Value::Map(m) => m.contains_key(&23) || m.values().any(has_words),
        Value::Array(a) => a.iter().any(has_words),
        _ => false,
    }
}

/// The act the checkers take for an intent: its verb's form on its target, then each fallback's, in rank order.
/// Only a form's act on a node is checked so far; moves and orders are B7's and I7's.
fn act_of(intent: &Intent, id: u64, cause: Cause) -> Result<Act, &'static str> {
    let body = match (intent.actor, intent.body) {
        (Actor::Soul(s), _) => s,
        (Actor::Creator(_), Some(b)) => b,
        _ => return Err("intent.no-body"),
    };
    let candidate =
        |verb: &Name, target: &Option<Target>| match (verb.as_str().split_once(':'), target) {
            (Some((ns, form)), Some(Target::Node(this))) if ns != "souls" => Ok(Candidate {
                this: *this,
                form: form.to_owned(),
            }),
            _ => Err("intent.not-a-form-on-a-node"),
        };
    let mut candidates = vec![candidate(&intent.verb, &intent.target)?];
    for f in &intent.fallbacks {
        candidates.push(candidate(&f.verb, &f.target)?);
    }
    Ok(Act {
        id,
        cause,
        actor: intent.actor,
        body,
        candidates,
        recheck: None,
    })
}

impl Clock {
    fn version(&self) -> Value {
        Version {
            lineage: self.lineage,
            zone: self.zone,
            epoch: self.epoch,
            sequence: self.replica.version(),
        }
        .to_value()
    }

    fn frame(&self, answer: &Answer) -> Vec<u8> {
        encode(&Value::Map(
            [(1, self.version()), (2, answer.to_value())].into(),
        ))
        .unwrap_or_default()
    }

    fn refusal(&self, actor: Actor, sequence: u64, reason: &str) -> Answer {
        Answer::Refused {
            actor,
            sequence,
            reason: name(reason),
            now: self.version(),
            changed: Vec::new(),
        }
    }

    /// Records an answer: kept for repeats, logged with the tick, sent after the tick's sync.
    fn answered(
        &mut self,
        key: Vec<u8>,
        sequence: u64,
        id: Option<Id>,
        intent: Option<Value>,
        answer: &Answer,
        waiters: Vec<Reply>,
    ) {
        let frame = self.frame(answer);
        self.sequences.answered(&key, sequence, frame.clone());
        let mut row = BTreeMap::from([
            (1, Value::Bytes(key)),
            (2, Value::Uint(sequence)),
            (4, Value::Bytes(frame.clone())),
        ]);
        if let Some(id) = id {
            row.insert(3, id.to_value());
        }
        if let Some(i) = intent {
            row.insert(5, i);
        }
        self.rows.push(Value::Map(row));
        self.replies.push((waiters, frame));
    }

    /// Ends open act `id` with `answer`.
    fn end(&mut self, id: Id, answer: impl FnOnce(&Clock) -> Answer) {
        let Some(o) = self.open.remove(&id) else {
            return;
        };
        self.in_flight.remove(&(o.key.clone(), o.sequence));
        self.deadlines.close(o.body, id);
        let a = answer(self);
        self.answered(o.key, o.sequence, Some(id), Some(o.intent), &a, o.waiters);
    }

    /// Seals the tree if the world changed since the last seal, and keeps the records the seal gave.
    fn seal(&mut self) {
        if !self.unsealed {
            return;
        }
        if let Ok(sealed) = self.replica.seal() {
            self.records.keep(&sealed);
            self.unsealed = false;
        }
    }

    /// A sync request's answer (R5b), or none if `bytes` is not one: the place is granted to every actor.
    fn sync(&mut self, bytes: &[u8]) -> Option<Vec<u8>> {
        let Value::Map(mut m) = decode(bytes).ok()?.value else {
            return None;
        };
        let n = m.remove(&wire::ASK)?;
        if m.contains_key(&wire::IDS) {
            self.seal();
        }
        let now = self.version();
        let place = self.replica.header().zone;
        let mut src = Served {
            tree: self.replica.tree(),
            records: &self.records,
        };
        let mut a = sync::answer(&mut src, &[place], &m, now);
        a.insert(wire::ASK, n);
        encode(&Value::Map(a)).ok()
    }

    fn arrival(&mut self, bytes: &[u8], reply: Reply, now: Micros) {
        if let Some(f) = self.sync(bytes) {
            let _ = self.answers.send(Tick {
                record: None,
                replies: vec![(vec![reply], f)],
            });
            return;
        }
        let intent = match Intent::read(bytes) {
            Ok(i) => i,
            Err(r) => {
                let f = self.frame(&Answer::Unread {
                    reason: name(r.name),
                });
                self.replies.push((vec![reply], f));
                return;
            }
        };
        let Some(key) = actor_key(bytes) else { return };
        let (actor, sequence) = (intent.actor, intent.sequence);
        // Sent again while still open (a gateway's resend after a reconnect): answered once, to both.
        if let Some(id) = self.in_flight.get(&(key.clone(), sequence)) {
            if let Some(o) = self.open.get_mut(id) {
                o.waiters.push(reply);
            }
            return;
        }
        match self.sequences.seen(&key, sequence) {
            Seen::Kept(f) => return self.replies.push((vec![reply], f)),
            Seen::Stale => {
                let f = self.frame(&self.refusal(actor, sequence, "intent.stale-seq"));
                return self.replies.push((vec![reply], f));
            }
            Seen::Fresh => {}
        }
        if let Some(f) = self.arrivals.as_mut() {
            // One write per line, unbuffered, so a killed world leaves every line it took.
            let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
            let _ = f.write_all(format!("{hex} {sequence}\n").as_bytes());
        }
        let value = intent.to_value();
        if has_words(&value) {
            let a = self.refusal(actor, sequence, "intent.text-not-stored");
            return self.answered(key, sequence, None, None, &a, vec![reply]);
        }
        if expired(intent.expiry, now) {
            let a = self.refusal(actor, sequence, "intent.expired");
            return self.answered(key, sequence, None, Some(value), &a, vec![reply]);
        }
        let Some(id) = Id::new(self.lineage, self.next_intent) else {
            let a = self.refusal(actor, sequence, "intent.ids-exhausted");
            return self.answered(key, sequence, None, Some(value), &a, vec![reply]);
        };
        let act = match act_of(&intent, self.next_intent, Cause::Intent(id)) {
            Ok(a) => a,
            Err(reason) => {
                let a = self.refusal(actor, sequence, reason);
                return self.answered(key, sequence, None, Some(value), &a, vec![reply]);
            }
        };
        self.next_intent += 1;
        self.deadlines.open(
            act.body,
            id,
            intent.expiry.min(now.saturating_add(self.deadline)),
        );
        self.in_flight.insert((key.clone(), sequence), id);
        self.open.insert(
            id,
            Open {
                actor,
                key,
                sequence,
                body: act.body,
                expiry: intent.expiry,
                intent: value,
                waiters: vec![reply],
            },
        );
        let _ = self.acts.send(act);
    }

    fn tick(&mut self, now: Micros) {
        for (mut act, checks) in std::mem::take(&mut self.checked) {
            let Some(id) = Id::new(self.lineage, act.id) else {
                continue;
            };
            // Ended already (its deadline passed): the late check is dropped.
            let Some(o) = self.open.get(&id) else {
                continue;
            };
            let (actor, sequence) = (act.actor, o.sequence);
            if expired(o.expiry, now) {
                self.end(id, |c| c.refusal(actor, sequence, "intent.expired"));
                continue;
            }
            match commit(&mut self.replica, &checks, now) {
                Outcome::Applied { part, .. } => {
                    self.unsealed = true;
                    self.receipts.index(&part.effects);
                    self.effects.extend(part.effects.iter().cloned());
                    self.parts.push(part);
                    self.end(id, |c| Answer::Receipt {
                        actor,
                        sequence,
                        intent: id,
                        entries: c.receipts.entries(id).to_vec(),
                    });
                }
                Outcome::Recheck { version } => {
                    act.recheck = Some(version);
                    let _ = self.acts.send(act);
                }
                Outcome::Refused { reason } => {
                    self.end(id, |c| c.refusal(actor, sequence, &reason));
                }
            }
        }
        while let Some(id) = self.deadlines.due(now) {
            if let Some(o) = self.open.get(&id) {
                let (actor, sequence) = (o.actor, o.sequence);
                self.end(id, |c| c.refusal(actor, sequence, "act.timed-out"));
            }
        }
        let record = (!self.rows.is_empty() || !self.effects.is_empty()).then(|| {
            let v = Value::Map(BTreeMap::from([
                (1, Value::Bytes(self.replica.header().hash().to_bytes())),
                (
                    2,
                    Value::Array(self.effects.drain(..).map(|e| e.to_value()).collect()),
                ),
                (ANSWERED, Value::Array(std::mem::take(&mut self.rows))),
            ]));
            encode(&v).unwrap_or_default()
        });
        if !self.parts.is_empty() {
            if self.roots.is_some() {
                self.seal();
                let root = self.replica.tree().node(self.replica.tree().root());
                let hash = root.and_then(|n| n.sealed()).map(|h| h.to_bytes());
                let hex: String = hash
                    .unwrap_or_default()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                let line = format!("{} {hex}\n", self.replica.version());
                if let Some(f) = self.roots.as_mut() {
                    let _ = f.write_all(line.as_bytes());
                }
            }
            self.publisher.publish(std::mem::take(&mut self.parts));
        }
        let replies = std::mem::take(&mut self.replies);
        if record.is_some() || !replies.is_empty() {
            let _ = self.answers.send(Tick { record, replies });
        }
    }
}

/// The answers thread: each tick's record appended and on the disk before its answers leave. A log that fails
/// stops it for good: nothing is answered that is not on the disk.
fn answer_loop<S: Storage + 'static>(mut log: Log<S>, ticks: Receiver<Tick>) {
    for t in ticks {
        if let Some(record) = t.record
            && let Err(e) = log.append(record).and_then(|n| log.wait_durable(n + 1))
        {
            eprintln!("worldd: the log failed, nothing more is answered: {e}");
            return;
        }
        for (waiters, frame) in t.replies {
            for w in waiters {
                let _ = w.send(frame.clone());
            }
        }
    }
}

/// Opens the log in `storage`, replays it onto `world` (the world as built, before any record), and starts the
/// clock, answers and checker threads.
pub fn start<S: Storage + 'static>(
    mut world: Replica,
    rules: Rules,
    storage: S,
    cfg: Config,
) -> R<World> {
    let (log, found) = Log::open(storage, cfg.epoch)?;
    let mut sequences = Sequences::default();
    let mut receipts = Receipts::default();
    let mut next_intent = 1;
    for record in &found.records {
        let part = Part::read(record)?;
        if !part.effects.is_empty() {
            world.apply(&part)?;
        }
        receipts.index(&part.effects);
        let Some(Value::Array(rows)) = part.rest.get(&ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(m) = row else { continue };
            if let (Some(Value::Bytes(key)), Some(Value::Uint(seq)), Some(Value::Bytes(frame))) =
                (m.get(&1), m.get(&2), m.get(&4))
            {
                sequences.answered(key, *seq, frame.clone());
            }
            if let Some(id) = m.get(&3).and_then(|v| replica::effects::read_id(v).ok()) {
                next_intent = next_intent.max(id.counter() + 1);
            }
        }
    }
    let zone = Id::new(cfg.lineage, 0).ok_or(Refusal {
        name: "id-counter",
        detail: "the zone".into(),
    })?;
    let publisher = Arc::new(Publisher::new(&world));
    let (acts, checked) = checkers::start(cfg.checkers, Arc::clone(&publisher), Arc::new(rules));
    let (events, rx) = channel();
    let fwd = events.clone();
    thread::Builder::new()
        .name("checked".into())
        .spawn(move || {
            for (a, c) in checked {
                if fwd.send(Event::Checked(Box::new((a, c)))).is_err() {
                    break;
                }
            }
        })
        .map_err(io)?;
    let (answers, ticks) = channel();
    let answering = thread::Builder::new()
        .name("answers".into())
        .spawn(move || answer_loop(log, ticks))
        .map_err(io)?;
    let mut c = Clock {
        replica: world,
        publisher,
        acts,
        answers,
        sequences,
        receipts,
        deadlines: Deadlines::default(),
        open: HashMap::new(),
        in_flight: HashMap::new(),
        next_intent,
        lineage: cfg.lineage,
        zone,
        epoch: cfg.epoch,
        deadline: cfg.deadline,
        arrivals: cfg.arrivals,
        roots: cfg.roots,
        records: Records::default(),
        unsealed: true,
        checked: Vec::new(),
        replies: Vec::new(),
        rows: Vec::new(),
        effects: Vec::new(),
        parts: Vec::new(),
    };
    let tick = cfg.tick;
    let clock = thread::Builder::new()
        .name("clock".into())
        .spawn(move || {
            mark_clock_thread();
            let mut next = Instant::now() + tick;
            loop {
                // A tick is due before any more events are taken, so a busy queue never starves it.
                let at = Instant::now();
                if at >= next {
                    c.tick(now());
                    next = (next + tick).max(at);
                    continue;
                }
                match rx.recv_timeout(next - at) {
                    Ok(Event::Arrival { bytes, reply }) => c.arrival(&bytes, reply, now()),
                    Ok(Event::Checked(k)) => c.checked.push(*k),
                    Ok(Event::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {}
                }
            }
            c.tick(now());
            drop(c);
            let _ = answering.join();
        })
        .map_err(io)?;
    Ok(World {
        events,
        clock: Some(clock),
    })
}

fn io(e: std::io::Error) -> Refusal {
    Refusal {
        name: "thread",
        detail: e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    //! I4 (#2687): each `aN_` test is one acceptance box (A1 and A2 are the `act-latency` bench).
    use super::*;
    use crate::checkers::toggles;
    use replica::intents::Fallback;
    use sim::log::{Mem, recover};
    use std::sync::{Condvar, Mutex};

    const LINEAGE: Scope = Scope([9; 16]);

    /// A disk in memory whose sync waits while the test holds it.
    #[derive(Clone)]
    struct Held {
        mem: Mem,
        held: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Held {
        fn new(bytes: Vec<u8>) -> Held {
            Held {
                mem: Mem::with(bytes),
                held: Arc::new((Mutex::new(false), Condvar::new())),
            }
        }

        fn hold(&self, on: bool) {
            *self.held.0.lock().unwrap() = on;
            self.held.1.notify_all();
        }

        fn bytes(&self) -> Vec<u8> {
            self.mem.0.lock().unwrap().bytes.clone()
        }
    }

    impl Storage for Held {
        fn append(&mut self, bytes: &[u8]) -> R<()> {
            self.mem.append(bytes)
        }
        fn sync(&mut self) -> R<()> {
            let mut on = self.held.0.lock().unwrap();
            while *on {
                on = self.held.1.wait(on).unwrap();
            }
            drop(on);
            self.mem.sync()
        }
        fn read(&mut self) -> R<Vec<u8>> {
            self.mem.read()
        }
        fn truncate(&mut self, len: u64) -> R<()> {
            self.mem.truncate(len)
        }
    }

    fn world(store: Held, checkers: usize, deadline: Micros) -> (World, Vec<(Id, Id)>) {
        let w = toggles::World::build(1, 4, 0);
        let pairs = w.pairs.clone();
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.tick = Duration::from_millis(10);
        cfg.checkers = checkers;
        cfg.deadline = deadline;
        let world = start(w.replica, toggles::rules(), store, cfg).expect("the world starts");
        (world, pairs)
    }

    /// A toggle of the body's own: switch it on, or else off (a fallback).
    fn toggle(body: Id, thing: Id, sequence: u64, expiry: Micros) -> Intent {
        let n = |s: &str| Name::new(s).unwrap();
        Intent {
            actor: Actor::Soul(body),
            verb: n("r2:switch_on"),
            target: Some(Target::Node(thing)),
            parameters: BTreeMap::new(),
            sequence,
            basis: Version {
                lineage: LINEAGE,
                zone: Id::new(LINEAGE, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry,
            resources: Vec::new(),
            fallbacks: vec![Fallback {
                verb: n("r2:switch_off"),
                target: Some(Target::Node(thing)),
                parameters: BTreeMap::new(),
                resources: Vec::new(),
            }],
            replaces: None,
            body: None,
        }
    }

    fn send(w: &World, i: &Intent) -> Receiver<Vec<u8>> {
        let (reply, rx) = channel();
        let bytes = encode(&i.to_value()).unwrap();
        w.events.send(Event::Arrival { bytes, reply }).unwrap();
        rx
    }

    fn answer(rx: &Receiver<Vec<u8>>) -> Vec<u8> {
        rx.recv_timeout(Duration::from_secs(5)).expect("an answer")
    }

    /// (kind, field 4, entries) of an answer frame: kind 1 a receipt (intent id, entries), 2 a refusal (reason).
    fn read(frame: &[u8]) -> (u64, Value, Vec<u64>) {
        let Value::Map(m) = decode(frame).unwrap().value else {
            panic!("a frame")
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            panic!("an answer")
        };
        let entries = match a.get(&5) {
            Some(Value::Array(e)) if a.get(&3) == Some(&Value::Uint(1)) => e
                .iter()
                .map(|v| match v {
                    Value::Uint(n) => *n,
                    _ => panic!("an entry"),
                })
                .collect(),
            _ => Vec::new(),
        };
        match a.get(&3) {
            Some(Value::Uint(k)) => (*k, a.get(&4).cloned().unwrap(), entries),
            other => panic!("a kind: {other:?}"),
        }
    }

    fn reason(frame: &[u8]) -> String {
        match read(frame) {
            (2, Value::Text(t), _) => t.as_str().to_owned(),
            other => panic!("a refusal, not {other:?}"),
        }
    }

    /// The log's entries caused by intent `id`, by sequence.
    fn caused(log: &[u8], id: Id) -> Vec<u64> {
        recover(log)
            .unwrap()
            .records
            .iter()
            .flat_map(|r| Part::read(r).unwrap().effects)
            .filter(|e| e.envelope.cause == Cause::Intent(id))
            .map(|e| e.envelope.sequence)
            .collect()
    }

    #[test]
    fn a3_no_answer_leaves_before_its_ticks_sync() {
        let store = Held::new(Vec::new());
        let (w, pairs) = world(store.clone(), 2, 10_000_000);
        store.hold(true);
        let rx = send(&w, &toggle(pairs[0].0, pairs[0].1, 1, now() + 60_000_000));
        assert!(
            rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "no answer while the tick's sync is held"
        );
        store.hold(false);
        let (kind, id, entries) = read(&answer(&rx));
        assert_eq!(kind, 1, "a receipt once the sync returns");
        w.stop();
        let id = replica::effects::read_id(&id).unwrap();
        assert!(!entries.is_empty());
        assert_eq!(
            caused(&store.bytes(), id),
            entries,
            "the receipt names the log's entries"
        );
    }

    #[test]
    fn a4_a_repeat_gets_its_answer_an_old_one_is_stale_and_an_expiry_leaves_a_gap() {
        let store = Held::new(Vec::new());
        let (w, pairs) = world(store.clone(), 2, 10_000_000);
        let (body, thing) = pairs[1];
        let later = now() + 60_000_000;
        let first = answer(&send(&w, &toggle(body, thing, 1, later)));
        assert_eq!(read(&first).0, 1);
        let again = answer(&send(&w, &toggle(body, thing, 1, later)));
        assert_eq!(again, first, "the kept answer");
        let gone = answer(&send(&w, &toggle(body, thing, 2, 1)));
        assert_eq!(reason(&gone), "intent.expired");
        let next = answer(&send(&w, &toggle(body, thing, 3, later)));
        assert_eq!(read(&next).0, 1, "the gap is accepted");
        for s in 4..=(4 + sim::commit::acts::KEPT as u64) {
            answer(&send(&w, &toggle(body, thing, s, later)));
        }
        let old = answer(&send(&w, &toggle(body, thing, 3, later)));
        assert_eq!(reason(&old), "intent.stale-seq");
        let kept = answer(&send(&w, &toggle(body, thing, 20, later)));
        w.stop();

        // A restart replays the log: the repeat gets the same answer, and a new intent a new id.
        let (w, _) = world(Held::new(store.bytes()), 2, 10_000_000);
        let again = answer(&send(&w, &toggle(body, thing, 20, later)));
        assert_eq!(again, kept, "kept across a restart");
        let (k, id, _) = read(&answer(&send(&w, &toggle(body, thing, 21, later))));
        assert_eq!(k, 1);
        assert_ne!(id, read(&kept).1, "an id is never minted twice");
        w.stop();
    }

    #[test]
    fn a5_words_never_reach_the_log() {
        let store = Held::new(Vec::new());
        let (w, pairs) = world(store.clone(), 2, 10_000_000);
        let words = "meet me by the well at noon";
        let mut i = toggle(pairs[2].0, pairs[2].1, 1, now() + 60_000_000);
        let said = Value::Map([(23, Value::Bytes(words.as_bytes().to_vec()))].into());
        i.parameters.insert(1, said);
        assert_eq!(reason(&answer(&send(&w, &i))), "intent.text-not-stored");
        w.stop();
        let log = store.bytes();
        let n = recover(&log).unwrap().records.len();
        assert_eq!(n, 1, "the refusal is logged");
        assert!(
            !log.windows(words.len()).any(|b| b == words.as_bytes()),
            "none of the words' bytes are in the log"
        );
    }

    fn ask(w: &World, m: BTreeMap<u64, Value>) -> BTreeMap<u64, Value> {
        let (reply, rx) = channel();
        let bytes = encode(&Value::Map(m)).unwrap();
        w.events.send(Event::Arrival { bytes, reply }).unwrap();
        let Value::Map(a) = decode(&answer(&rx)).unwrap().value else {
            panic!("a map")
        };
        a
    }

    /// R5b A1 (#3164), the world's end: a client compares and descends through sync frames alone.
    fn sync_by_frames(w: &World, copy: &mut sync::Copy, place: Id) -> sync::Synced {
        let a = ask(
            w,
            BTreeMap::from([
                (wire::ASK, Value::Uint(1)),
                (wire::IDS, Value::Array(vec![])),
            ]),
        );
        assert_eq!(a.get(&wire::ASK), Some(&Value::Uint(1)));
        let (ids, hashes) = sync::read_hashes(&a).unwrap();
        assert_eq!(ids, vec![place], "granted the place");
        let mut d = copy.compare(&ids, hashes);
        loop {
            let asked = copy.ask(&mut d, wire::RECORDS_MOST);
            if asked.is_empty() {
                return copy.finish(d).unwrap();
            }
            let hs = asked.iter().cloned().map(Value::Bytes).collect();
            let a = ask(
                w,
                BTreeMap::from([
                    (wire::ASK, Value::Uint(2)),
                    (wire::RECORDS, Value::Array(hs)),
                ]),
            );
            copy.take(&mut d, &asked, sync::read_records(&a).unwrap())
                .unwrap();
        }
    }

    #[test]
    fn r5b_a1_answers_sync_requests_for_the_granted_place() {
        let roots = std::env::temp_dir().join(format!("worldd-r5b-roots-{}", std::process::id()));
        let _ = std::fs::remove_file(&roots);
        let built = toggles::World::build(1, 4, 0);
        let (place, pairs) = (built.replica.header().zone, built.pairs.clone());
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.tick = Duration::from_millis(10);
        cfg.roots = Some(File::create(&roots).unwrap());
        let w = start(built.replica, toggles::rules(), Mem::default(), cfg).unwrap();
        let mut copy = sync::Copy::default();
        let first = sync_by_frames(&w, &mut copy, place);
        assert_eq!(
            first.held, 10,
            "the place, its room, four bodies and their four toggles"
        );
        assert_eq!(first.fetched, 10);
        let receipt = answer(&send(
            &w,
            &toggle(pairs[0].0, pairs[0].1, 1, now() + 60_000_000),
        ));
        assert_eq!(read(&receipt).0, 1, "a receipt");
        let s = sync_by_frames(&w, &mut copy, place);
        assert_eq!(
            (s.changed, s.fetched, s.held),
            (1, 3, 10),
            "the place, the room and the one toggle switched"
        );
        let said = std::fs::read_to_string(&roots).unwrap();
        let last = said
            .lines()
            .last()
            .expect("a line for the tick that switched it");
        let hex: String = copy.roots()[&place]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            last.split(' ').nth(1),
            Some(hex.as_str()),
            "the world's hash"
        );
        let refused = ask(
            &w,
            BTreeMap::from([
                (wire::ASK, Value::Uint(3)),
                (wire::RECORDS, Value::Array(vec![Value::Uint(1)])),
            ]),
        );
        assert!(
            matches!(refused.get(&wire::REFUSED), Some(Value::Text(n)) if n.as_str() == "sync-ask")
        );
        let other = Id::new(Scope([9; 16]), 1).unwrap();
        let a = ask(
            &w,
            BTreeMap::from([
                (wire::ASK, Value::Uint(4)),
                (wire::IDS, Value::Array(vec![other.to_value()])),
            ]),
        );
        assert_eq!(sync::read_hashes(&a).unwrap().1, vec![None], "not granted");
        w.stop();
        let _ = std::fs::remove_file(&roots);
    }

    #[test]
    fn an_act_no_checker_answers_ends_timed_out_at_its_deadline() {
        let (w, pairs) = world(Held::new(Vec::new()), 0, 100_000);
        let started = Instant::now();
        let rx = send(&w, &toggle(pairs[3].0, pairs[3].1, 1, now() + 60_000_000));
        assert_eq!(reason(&answer(&rx)), "act.timed-out");
        assert!(started.elapsed() >= Duration::from_millis(100));
        w.stop();
    }
}
