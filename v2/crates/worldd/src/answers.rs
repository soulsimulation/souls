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
//! **A move** (a walk, a sit or a rise, I4b #3156) is taken the same way, but goes to the world's bodies
//! ([`crate::bodies`]) instead of the checkers. At the next tick it starts, or is refused by name, and writes an entry
//! ([`MOVE_STARTED`]); the bodies step to the tick's world time; when it ends it writes another ([`MOVE_ENDED`], with
//! how) and is answered: a receipt naming both entries when done, else a refusal naming how it ended
//! (`claim-taken`, `resource-held`, `out-of-reach`, ...). One answer, at its end: I7's accept-then-resolve is not here.
//!
//! **A restart** starts from the newest checkpoint that verifies, when the world takes them (K5, K18c #3176): its
//! tree, and its carry (each actor's last sequence and kept answers, the next intent id, every body's pose and seat,
//! the tick); the log is opened at the checkpoint's durable place (K4b) and only the records after it are replayed.
//! Without one it replays the whole log onto the world as built. Either way each record's entries are applied, the
//! receipts index and the kept answers are rebuilt from it, and new intent ids follow the last one minted. A repeat
//! after a restart gets the answer it had; an intent that was open at the kill was never logged nor answered, and is
//! taken again when the gateway sends it again. A body the log last had in a seat is seated in it again, the seat held
//! in the slots table (`crate::bodies`).
//!
//! **Free text** goes to K16's text store first and the log holds its reference only (`{21: id}`, T8 rule 6). Words
//! come in an intent as T8's `{23: words}` (CBOR text is names only, so words are bytes). K16 has no store yet, so an
//! intent carrying words is refused `intent.text-not-stored` and logged without its intent: none of their bytes
//! reach the log (`a5_` test).
//!
//! **The world's tick** (K18, #3160). One loop per zone, run by K7's ticker at the clock's rate (one tick each
//! [`Config::tick`]; world time is real time in µs from the Unix epoch, rate one). Each tick, in the trunk's order
//! (T1: everything reads the state as of the tick's start, and what a tick writes is seen from the next):
//!
//! 0. the intents that arrived since the last tick are taken (the recorder's inputs, K12);
//! 1. due timers: acts whose deadline passed end `act.timed-out` (K9's due list); a move's phase timers fire;
//! 2. skills step through the host, each one unit in K11's wrapper (K13a, T9b/T9c; a panic ends that skill only);
//! 3. the controller steps the bodies (B1), moves and seats included (B2, B3);
//! 4. committed acts: the checks that came back are committed (I3, I4) and new moves start (I4b);
//! 5. the tick's input record, then its part, go to the log (K4, K12): the part carries the answers ([`ANSWERED`]),
//!    the bodies that moved ([`BODIES`]), the tick ([`TICK`]) and the zone's state hash after it ([`STATE`]);
//! 6. the frozen copy is published (K8);
//! 7. the answers thread appends and syncs the records, then hands the synced tick to the view tier (R3) and sends
//!    the answers;
//! 8. the auditor checks a slice of the tree (K11), at most [`AUDIT_TIME`] of it (K21); its faults are printed on
//!    its own thread.
//!
//! A checkpoint is taken by K5's rule (amount of log), between ticks: at the start of a tick, once every record
//! handed to the log is on the disk, so it never holds a change the log lacks. A tree holding changes no checkpoint
//! has (a first start from the log, or the log after the newest checkpoint) is checkpointed in [`start`], before the
//! clock and its watchdog start, so each later checkpoint and each tick's state hash hash only what changed (K20).
//! **Lockstep** ([`Config::lockstep`]) runs the same loop on a clock the caller moves ([`Event::RunTo`]) and waits for
//! every check before a tick, so a run fed the same inputs at the same ticks writes the same log: how K12's replay is
//! checked on the real loop.
//!
//! **Measures** (O4, #2694, `crate::measures`): each act carries its stamps from the socket to its answer, each
//! tick times the loop's own phases above ([`measures::PHASES`]), and every queue its oldest item; the answers thread
//! adds the block to each answer frame as it leaves, after the tick's records are on the disk, so the logged answer
//! never holds it. `health.json` is written by its own thread. [`Config::measures`] off takes no stamps and adds no
//! block. Intents enter through a [`Door`], which stamps them as they are read.
//!
//! Not here (K18's known limits): a route search and a move's checks still run on the clock thread (`sim::host`'s
//! runner plans a walk's route when its spot is granted; B3 checks a seat at commit); a walk or a sit in progress at
//! a kill is not resumed (its intent is taken again when sent again); one zone a process.
// worldd's real clock (`Real`): the one place the process reads time.
#![allow(clippy::disallowed_methods)]

use crate::bodies::{self, Asked, Bodies, Placed};
use crate::checkers::{self, Act, Candidate, Rules};
use crate::measures::{self, Measures, Stamps};
use crate::views::Tier;
use replica::apply::Replica;
use replica::effects::{Actor, Body, Cause, Effect, Envelope, Event as Named, Part, Refusal};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope, Version};
use replica::intents::{Answer, INTENT_MOST, Intent, Target};
use replica::pose::Pose;
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use replica::views::Redactions;
use replica::world_model::Audience;
use sim::audit::{Auditor, Fault};
use sim::checkpoint::{self, Blobs, Checkpoints};
use sim::clock::{Clock as Pace, Heartbeat, Ticker};
use sim::commit::acts::{Deadlines, Receipts, Seen, Sequences, expired};
use sim::commit::{Checks, Outcome, commit, mark_clock_thread};
use sim::frozen::Publisher;
use sim::log::{Durable, Log, Storage};
use sim::recorder::{self, Input};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type R<T> = Result<T, Refusal>;

/// Makes the world's bodies on the thread that steps them (a skill is not sent between threads), each standing where
/// the log last had it (`Placed`, empty on a first start; [`Bodies::add_body_at`]).
pub type MakeBodies = Box<dyn FnOnce(&Placed) -> R<Bodies> + Send>;

/// Where an answer frame goes: the connection the intent came on.
pub type Reply = Sender<Vec<u8>>;

/// The most the auditor's slice takes of a tick (K21, #3422): it stops there and carries on next tick.
pub const AUDIT_TIME: Duration = Duration::from_millis(2);

/// The field of a tick's part that lists the intents answered in it: `[{1: actor, 2: sequence, 3: intent id, 4:
/// answer frame, 5: intent}]`, 3 left out for an intent refused before it got an id, 5 for one whose intent holds
/// words.
pub const ANSWERED: u64 = 3;
/// The field of a tick's part that lists the bodies standing on a surface whose pose changed in the tick: `[[body,
/// pose], ...]` (K18): what a restart stands them at.
pub const BODIES: u64 = 4;
/// The field of a tick's part holding its tick number (K18): where a restart's ticker resumes.
pub const TICK: u64 = 5;
/// The field of a tick's part holding the zone's state hash after the tick (K18): [`state_hash`].
pub const STATE: u64 = 6;

pub enum Event {
    /// An intent's bytes as they came off the gateway's socket: taken at the start of the next tick.
    Arrival {
        bytes: Vec<u8>,
        reply: Reply,
        /// Its stamps so far and its key in the arrivals queue (default when measures are off): see [`Door`].
        stamps: Stamps,
        key: u64,
    },
    /// An intent taken at the start of tick `tick` (lockstep: a script or a replay of the recorder's inputs).
    ArrivalAt {
        tick: i64,
        bytes: Vec<u8>,
        reply: Reply,
    },
    /// Lockstep: run every tick up to and including `tick`, then report the zone's state on `done`.
    RunTo {
        tick: i64,
        done: Sender<Ran>,
    },
    Checked(Box<(Act, Checks)>),
    /// Holds the clock thread for this long: the stuck-thread run (O4 A4).
    Stall(Duration),
    Stop,
}

/// Where intents enter the world: stamps each as it is read, when measures are on (O4).
#[derive(Clone)]
pub struct Door {
    pub events: Sender<Event>,
    pub measures: Option<Arc<Measures>>,
}

impl Door {
    /// Hands an intent's bytes to the clock thread; false once the world has stopped.
    pub fn arrive(&self, bytes: Vec<u8>, reply: Reply) -> bool {
        let (stamps, key) = self
            .measures
            .as_ref()
            .map_or((Stamps::default(), 0), |m| m.arrive());
        self.events
            .send(Event::Arrival {
                bytes,
                reply,
                stamps,
                key,
            })
            .is_ok()
    }
}

/// Where a lockstep run stands after [`Event::RunTo`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ran {
    pub tick: i64,
    pub state: [u8; 32],
    /// Faults the auditor named so far, and units ended by a panic.
    pub faults: u64,
    pub panicked: u64,
    /// The bodies in a seat: (body, the seat's thing), in body order.
    pub seated: Vec<(Id, Id)>,
}

/// How a start found the world (K18c, #3176): from the newest checkpoint and the log after it, or the whole log.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Restart {
    /// The log record the checkpoint holds up to, when one was restored.
    pub checkpoint: Option<u64>,
    /// Log records read back (the input records included) and the parts of them applied to the tree.
    pub read: u64,
    pub applied: u64,
}

/// One actor's kept answers in a carry: its bytes, its last sequence, and its kept (sequence, answer frame) pairs.
type Kept = (Vec<u8>, u64, Vec<(u64, Vec<u8>)>);

/// What a restart needs besides the tree, kept in a checkpoint's seed (K5 keeps the seed opaque; K18c, #3176):
/// `{1: [[actor, last sequence, [[sequence, answer frame], ...]], ...], 2: next intent counter, 3: [body row, ...]
/// (`crate::bodies::row`), 4: the tick}`. Without it a restart from a checkpoint would forget the answers kept for
/// repeats and the bodies that had not moved since.
#[derive(Debug, Default)]
struct Carry {
    sequences: Vec<Kept>,
    next_intent: u64,
    placed: Placed,
    tick: i64,
}

impl Carry {
    fn of(sequences: &Sequences, next_intent: u64, placed: Placed, tick: i64) -> Carry {
        Carry {
            sequences: sequences
                .kept()
                .map(|(a, last, kept)| (a.to_vec(), last, kept.cloned().collect()))
                .collect(),
            next_intent,
            placed,
            tick,
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        let sequences = self
            .sequences
            .iter()
            .map(|(a, last, kept)| {
                Value::Array(vec![
                    Value::Bytes(a.clone()),
                    Value::Uint(*last),
                    Value::Array(
                        kept.iter()
                            .map(|(s, f)| {
                                Value::Array(vec![Value::Uint(*s), Value::Bytes(f.clone())])
                            })
                            .collect(),
                    ),
                ])
            })
            .collect();
        let mut m = BTreeMap::from([
            (1, Value::Array(sequences)),
            (2, Value::Uint(self.next_intent)),
            (
                3,
                Value::Array(
                    self.placed
                        .iter()
                        .map(|(id, (p, s))| bodies::row(*id, p, *s))
                        .collect(),
                ),
            ),
        ]);
        if let Ok(t) = u64::try_from(self.tick) {
            m.insert(4, Value::Uint(t));
        }
        encode(&Value::Map(m)).unwrap_or_default()
    }

    /// The carry a checkpoint's seed holds; an empty or unread seed carries nothing (a checkpoint from before K18c).
    fn read(seed: &[u8]) -> Option<Carry> {
        let Value::Map(m) = decode(seed).ok()?.value else {
            return None;
        };
        let mut c = Carry {
            tick: -1,
            ..Carry::default()
        };
        if let Some(Value::Array(rows)) = m.get(&1) {
            for r in rows {
                let Value::Array(r) = r else { continue };
                let [Value::Bytes(a), Value::Uint(last), Value::Array(kept)] = r.as_slice() else {
                    continue;
                };
                let kept = kept
                    .iter()
                    .filter_map(|k| match k {
                        Value::Array(p) => match p.as_slice() {
                            [Value::Uint(s), Value::Bytes(f)] => Some((*s, f.clone())),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect();
                c.sequences.push((a.clone(), *last, kept));
            }
        }
        if let Some(Value::Uint(n)) = m.get(&2) {
            c.next_intent = *n;
        }
        if let Some(Value::Array(rows)) = m.get(&3) {
            for (id, pose, stance) in rows.iter().filter_map(bodies::read_row) {
                c.placed.insert(id, (pose, stance));
            }
        }
        if let Some(Value::Uint(t)) = m.get(&4) {
            c.tick = i64::try_from(*t).unwrap_or(i64::MAX);
        }
        Some(c)
    }
}

pub struct Config {
    pub lineage: Scope,
    pub epoch: u64,
    /// The tick's length (K7: the loop runs at this rate).
    pub tick: Duration,
    /// The longest an act stays open, from its arrival, when its expiry is later.
    pub deadline: Micros,
    pub checkers: usize,
    /// `<actor hex> <sequence>` appended for each fresh intent, in the order taken (I1's restart bench).
    pub arrivals: Option<File>,
    /// Makes the world's bodies, on the clock thread, for move intents (I4b, #3156); without them a move is refused
    /// `intent.not-a-form-on-a-node`.
    pub bodies: Option<MakeBodies>,
    /// The clock that paces the loop; `None` is the machine's ([`Real`]). Ignored in lockstep.
    pub clock: Option<Box<dyn Pace + Send>>,
    /// Lockstep: ticks run only when asked ([`Event::RunTo`]), each after every check is back (K18).
    pub lockstep: bool,
    /// K5's checkpoints: their folder and the log bytes between two.
    pub checkpoints: Option<(PathBuf, u64)>,
    /// Starts the view tier (R3) on the log, which each synced tick is handed to.
    pub views: bool,
    /// Nodes the auditor checks a tick (K11).
    pub audit: usize,
    /// Stamps, the answers' block, tick phases and queue ages (O4). Off takes no stamps and adds no block.
    pub measures: bool,
    /// Where `health.json` is written every two seconds, when measures are on.
    pub health: Option<PathBuf>,
    /// Each log record once it is on the disk, input records included, in order (C1, #3365): `worldd serve`'s own
    /// view tier and shipper read them here, off the clock thread.
    pub synced: Option<Sender<Synced>>,
}

/// A record on the disk ([`Config::synced`]): its number in the log, its bytes, and whether it is the recorder's input
/// record (K12) rather than a tick's part.
pub struct Synced {
    pub record: u64,
    pub bytes: Vec<u8>,
    pub input: bool,
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
            bodies: None,
            clock: None,
            lockstep: false,
            checkpoints: None,
            views: false,
            audit: 64,
            measures: true,
            health: None,
            synced: None,
        }
    }
}

/// The running world: send it [`Event`]s; [`World::stop`] ends it once the answers already due are sent.
pub struct World {
    pub events: Sender<Event>,
    /// The tick and real time the last tick ended (K7): a watchdog reads it.
    pub beat: Arc<Heartbeat>,
    /// The view tier, when [`Config::views`]: subscribe to it.
    pub tier: Option<Arc<Tier>>,
    pub measures: Option<Arc<Measures>>,
    /// How this start found the world (K18c).
    pub restart: Restart,
    /// The log's durable mark: a tier of the caller's own waits on it (C1).
    pub durable: Durable,
    clock: Option<JoinHandle<()>>,
}

impl World {
    /// Where intents enter: [`serve`] reads the gateway's socket into it.
    pub fn door(&self) -> Door {
        Door {
            events: self.events.clone(),
            measures: self.measures.clone(),
        }
    }

    pub fn stop(mut self) {
        let _ = self.events.send(Event::Stop);
        if let Some(c) = self.clock.take() {
            let _ = c.join();
        }
    }
}

/// The machine's clock, in µs from the Unix epoch.
pub fn now() -> Micros {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}

/// The wall clock read once, at start, carried on by the monotonic clock (K7): µs from the Unix epoch, never a step.
#[derive(Clone, Copy, Debug)]
pub struct Real {
    wall0: Micros,
    mono0: Instant,
}

impl Real {
    /// Reads the wall clock, once.
    pub fn start() -> Real {
        Real {
            wall0: now(),
            mono0: Instant::now(),
        }
    }
}

impl Pace for Real {
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

/// Lockstep's clock: real time is what the caller last asked to run to; it never sleeps.
struct Stepped(Arc<Mutex<Micros>>);

impl Pace for Stepped {
    fn now(&mut self) -> Micros {
        *self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn sleep_until(&mut self, _: Micros) {}
}

/// The zone's state hash (K18; K20, #3395): `souls/fixture/1` over `[[[audience, state hash], ...], [[body, pose],
/// ...]]`: each audience's state hash as K5's seal gives it (`replica::tree::Tree::state_hashes`, the public one
/// first), worked out each tick from the nodes the tick changed, then the bodies the controller holds, since the tree
/// does not hold them yet.
pub fn state_hash(tree: &[(Audience, Hash)], bodies: &[(Id, Pose)]) -> [u8; 32] {
    let audience = |a: &Audience| match a {
        Audience::Everyone => Value::Map(BTreeMap::from([(1, Value::Uint(1))])),
        Audience::Of(id) => Value::Map(BTreeMap::from([(1, Value::Uint(2)), (2, id.to_value())])),
    };
    let v = Value::Array(vec![
        Value::Array(
            tree.iter()
                .map(|(a, h)| Value::Array(vec![audience(a), Value::Bytes(h.to_bytes())]))
                .collect(),
        ),
        Value::Array(
            bodies
                .iter()
                .map(|(id, p)| Value::Array(vec![id.to_value(), p.to_value()]))
                .collect(),
        ),
    ]);
    // The digest itself, past the multihash's two bytes.
    let h = Hash::of(Purpose::Fixture, &encode(&v).unwrap_or_default()).to_bytes();
    let mut out = [0; 32];
    out.copy_from_slice(&h[h.len() - 32..]);
    out
}

struct Open {
    actor: Actor,
    key: Vec<u8>,
    sequence: u64,
    body: Id,
    expiry: Micros,
    intent: Value,
    waiters: Vec<Reply>,
    stamps: Stamps,
}

/// An answer to send once its tick is on the disk: to whom, its frame as logged, and its stamps (O4).
type Out = (Vec<Reply>, Vec<u8>, Stamps);

/// One tick's records (its input record, then its part) and the answers they release once they are on the disk, with
/// the tick's start and when its records were handed to the log (when measures are on).
struct Tick {
    inputs: Option<Vec<u8>>,
    record: Option<Vec<u8>>,
    replies: Vec<Out>,
    started: Option<u64>,
    handed: Option<u64>,
}

struct Clock {
    replica: Replica,
    publisher: Arc<Publisher>,
    acts: Sender<Act>,
    answers: Sender<Tick>,
    sequences: Sequences,
    receipts: Receipts,
    deadlines: Deadlines,
    open: BTreeMap<Id, Open>,
    in_flight: BTreeMap<(Vec<u8>, u64), Id>,
    next_intent: u64,
    lineage: Scope,
    zone: Id,
    epoch: u64,
    deadline: Micros,
    arrivals: Option<File>,
    checked: Vec<(Act, Checks)>,
    replies: Vec<Out>,
    rows: Vec<Value>,
    effects: Vec<Effect>,
    parts: Vec<Arc<Part>>,
    bodies: Option<Bodies>,
    /// Move intents taken since the last tick, committed at the next (I4b).
    moving: Vec<(Id, Asked)>,
    /// Intents arrived since the last tick, taken at the start of the next; and those a script set for a tick.
    pending: Vec<(Vec<u8>, Reply, Stamps)>,
    scheduled: BTreeMap<i64, Vec<(Vec<u8>, Reply)>>,
    /// The tick's inputs, for the recorder (K12).
    inputs: Vec<Input>,
    /// Acts on the checkers' queue, not yet back (lockstep waits for none).
    outstanding: usize,
    auditor: Auditor,
    audit: usize,
    /// The auditor's faults, to the thread that prints them (K21).
    audit_faults: Sender<Vec<Fault>>,
    faults: u64,
    checkpoints: Option<Checkpoints>,
    /// Log records written, the input records included.
    records: u64,
    /// Log bytes handed since the last checkpoint's count, and the log's durable mark (K18c).
    since: u64,
    durable: Durable,
    tick: i64,
    measures: Option<Arc<Measures>>,
}

/// What an intent becomes: a form's act for the checkers, or a move for the bodies.
enum Taken {
    Form(Act),
    Move(Asked),
}

/// The event of the entry a move writes when it starts, and when it ends (field 2: how, by name).
pub const MOVE_STARTED: &str = "souls:move-started";
pub const MOVE_ENDED: &str = "souls:move-ended";

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

/// The body an intent drives: the Soul's own, or the one a creator names.
fn body_of(intent: &Intent) -> Result<Id, &'static str> {
    match (intent.actor, intent.body) {
        (Actor::Soul(s), _) => Ok(s),
        (Actor::Creator(_), Some(b)) => Ok(b),
        _ => Err("intent.no-body"),
    }
}

/// The act the checkers take for an intent: its verb's form on its target, then each fallback's, in rank order.
/// A walk, a sit or a rise goes to the bodies instead ([`crate::bodies`], I4b); orders are B7's.
fn act_of(intent: &Intent, id: u64, cause: Cause) -> Result<Act, &'static str> {
    let body = body_of(intent)?;
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
        (waiters, stamps): (Vec<Reply>, Stamps),
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
        self.replies.push((waiters, frame, stamps));
    }

    /// Ends open act `id` with `answer`.
    fn end(&mut self, id: Id, answer: impl FnOnce(&Clock) -> Answer) {
        let Some(o) = self.open.remove(&id) else {
            return;
        };
        self.in_flight.remove(&(o.key.clone(), o.sequence));
        self.deadlines.close(o.body, id);
        if let Some(m) = &self.measures {
            if o.stamps.0[2].is_none() {
                m.ended_unchecked(id.counter());
            }
            m.left_tick(id.counter());
        }
        let a = answer(self);
        self.answered(
            o.key,
            o.sequence,
            Some(id),
            Some(o.intent),
            &a,
            (o.waiters, o.stamps),
        );
    }

    fn arrival(&mut self, bytes: &[u8], reply: Reply, stamps: Stamps, now: Micros) {
        let intent = match Intent::read(bytes) {
            Ok(i) => i,
            Err(r) => {
                let f = self.frame(&Answer::Unread {
                    reason: name(r.name),
                });
                self.replies.push((vec![reply], f, stamps));
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
            Seen::Kept(f) => return self.replies.push((vec![reply], f, stamps)),
            Seen::Stale => {
                let f = self.frame(&self.refusal(actor, sequence, "intent.stale-seq"));
                return self.replies.push((vec![reply], f, stamps));
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
            return self.answered(key, sequence, None, None, &a, (vec![reply], stamps));
        }
        if expired(intent.expiry, now) {
            let a = self.refusal(actor, sequence, "intent.expired");
            return self.answered(key, sequence, None, Some(value), &a, (vec![reply], stamps));
        }
        let Some(id) = Id::new(self.lineage, self.next_intent) else {
            let a = self.refusal(actor, sequence, "intent.ids-exhausted");
            return self.answered(key, sequence, None, Some(value), &a, (vec![reply], stamps));
        };
        // A move goes to the bodies when the world has them (I4b); anything else is a form's act.
        let moved = match self.bodies {
            Some(_) => body_of(&intent).ok().and_then(|b| bodies::read(&intent, b)),
            None => None,
        };
        let taken = match moved {
            Some(m) => m.map(Taken::Move),
            None => act_of(&intent, self.next_intent, Cause::Intent(id)).map(Taken::Form),
        };
        let taken = match taken {
            Ok(t) => t,
            Err(reason) => {
                let a = self.refusal(actor, sequence, reason);
                return self.answered(key, sequence, None, Some(value), &a, (vec![reply], stamps));
            }
        };
        let body = match &taken {
            Taken::Form(a) => a.body,
            Taken::Move(m) => m.body,
        };
        self.next_intent += 1;
        // The recorder's input (K12): the intent by id and verb; its words, were there any, by reference only.
        self.inputs.push(Input::Intent {
            id,
            soul: body,
            verb: intent.verb.clone(),
            words: None,
        });
        self.deadlines.open(
            body,
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
                body,
                expiry: intent.expiry,
                intent: value,
                waiters: vec![reply],
                stamps,
            },
        );
        match taken {
            Taken::Form(act) => {
                self.outstanding += 1;
                if let Some(m) = &self.measures {
                    m.to_check(id.counter(), stamps.0[1]);
                }
                let _ = self.acts.send(act);
            }
            Taken::Move(m) => self.moving.push((id, m)),
        }
    }

    /// Writes the entry of open move `id`: event `event` with `{1: body, 2: how (once it ended; its name's bytes, since
    /// an event's text is a namespaced name), 3: [x, y, z] µm,
    /// 4: the node of its frame}`, where the body stands or sits. Its cause is the intent, so the receipt finds it.
    fn note(&mut self, id: Id, event: &str, how: Option<&str>, at: Micros) {
        let Some(o) = self.open.get(&id) else { return };
        let mut fields = BTreeMap::from([(1, o.body.to_value())]);
        if let Some(h) = how {
            fields.insert(2, Value::Bytes(h.as_bytes().to_vec()));
        }
        if let Some((node, p)) = self.bodies.as_ref().and_then(|b| b.pose(o.body)) {
            let i = |n: i64| {
                u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
            };
            fields.insert(3, Value::Array(vec![i(p.x), i(p.y), i(p.z)]));
            fields.insert(4, node.to_value());
        }
        let effect = Effect {
            envelope: Envelope {
                sequence: self.replica.version(),
                at,
                cause: Cause::Intent(id),
                actor: o.actor,
                audience: Audience::Everyone,
                node: self.replica.header().zone,
            },
            body: Body::Changes(Vec::new()),
            events: Some(vec![Named {
                name: name(event),
                fields,
                changes: Vec::new(),
                rest: BTreeMap::new(),
            }]),
            rest: BTreeMap::new(),
        };
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.replica.header().hash().to_bytes())),
            (2, Value::Array(vec![effect.to_value()])),
        ]));
        let part = encode(&v)
            .map_err(|e| Refusal {
                name: "encoding",
                detail: e.to_string(),
            })
            .and_then(|b| Part::read(&b))
            .and_then(|p| self.replica.apply(&p).map(|()| p));
        match part {
            Ok(p) => {
                self.receipts.index(&p.effects);
                self.effects.extend(p.effects.iter().cloned());
                self.parts.push(Arc::new(p));
            }
            Err(r) => eprintln!("worldd: a move's entry was not written: {r}"),
        }
    }

    /// Steps 1 to 3 for the bodies (I4b): their due timers, skills and controller, to world time `now`; each move that
    /// ended is answered: a receipt naming its entries when done, else its reason by name.
    fn step_bodies(&mut self, now: Micros) {
        let Some(b) = self.bodies.as_mut() else {
            return;
        };
        for (id, how) in b.step(now) {
            self.settle(id, how, now);
        }
    }

    /// Step 4 for moves (I4b): those taken since the last tick start, each refused by name or begun.
    fn start_moves(&mut self, now: Micros) {
        let Some(mut b) = self.bodies.take() else {
            return;
        };
        let mut asks = Vec::new();
        for (id, m) in std::mem::take(&mut self.moving) {
            let Some(o) = self.open.get(&id) else {
                continue;
            };
            let (actor, sequence) = (o.actor, o.sequence);
            if expired(o.expiry, now) {
                self.end(id, |c| c.refusal(actor, sequence, "intent.expired"));
            } else {
                asks.push((id, m));
            }
        }
        let started = b.start(asks);
        self.bodies = Some(b);
        for (id, r) in started {
            match r {
                Ok(()) => self.note(id, MOVE_STARTED, None, now),
                Err(r) => self.settle(id, Err(r.name.to_owned()), now),
            }
        }
    }

    /// Ends open move `id` as it ended: its entry, then its answer.
    fn settle(&mut self, id: Id, how: Result<(), String>, now: Micros) {
        let Some(o) = self.open.get(&id) else { return };
        let (actor, sequence) = (o.actor, o.sequence);
        match how {
            Ok(()) => {
                self.note(id, MOVE_ENDED, Some("done"), now);
                self.end(id, |c| Answer::Receipt {
                    actor,
                    sequence,
                    intent: id,
                    entries: c.receipts.entries(id).to_vec(),
                });
            }
            Err(reason) => {
                self.note(id, MOVE_ENDED, Some(&reason), now);
                self.end(id, |c| c.refusal(actor, sequence, &reason));
            }
        }
    }

    /// The zone's state hash now ([`state_hash`]): the tree's nodes changed since the last are hashed again.
    fn state(&mut self) -> [u8; 32] {
        let poses = self.bodies.as_ref().map(Bodies::poses).unwrap_or_default();
        let tree = self
            .replica
            .tree_for_seal()
            .state_hashes()
            .unwrap_or_default();
        state_hash(&tree, &poses)
    }

    /// A check came back (O4: its stamp and queues); kept for the next tick.
    fn checks_back(&mut self, act: Act, checks: Checks) {
        self.outstanding = self.outstanding.saturating_sub(1);
        if let Some(m) = &self.measures {
            let open = Id::new(self.lineage, act.id).and_then(|id| self.open.get_mut(&id));
            m.checked(act.id, open.map(|o| &mut o.stamps));
        }
        self.checked.push((act, checks));
    }

    /// One tick, `n`, at world time `now` (its start), in the trunk's order (the module's list). With measures on,
    /// each phase is timed on the machine's steady clock ([`measures::PHASES`]; O4, K18c).
    fn tick(&mut self, n: i64, now: Micros) {
        let on = self.measures.is_some();
        let mark = || on.then(measures::steady_us);
        let mut at = [None; measures::NPHASES + 1];
        at[0] = mark();
        // K5: a checkpoint once enough log has been written since the last, taken between ticks, here before the
        // tick and once every record handed to the log is on the disk (K18c): it never holds a change the log lacks.
        self.checkpoint();
        at[1] = mark();
        self.tick = n;
        // 0. What arrived since the last tick, and what a script set for this one, is taken now.
        for (bytes, reply, stamps) in std::mem::take(&mut self.pending) {
            self.arrival(&bytes, reply, stamps, now);
        }
        if let Some(due) = self.scheduled.remove(&n) {
            for (bytes, reply) in due {
                self.arrival(&bytes, reply, Stamps::default(), now);
            }
        }
        at[2] = mark();
        // 1. Due timers: acts whose deadline passed.
        while let Some(id) = self.deadlines.due(now) {
            if let Some(b) = self.bodies.as_mut() {
                b.cancel(id);
            }
            if let Some(o) = self.open.get(&id) {
                let (actor, sequence) = (o.actor, o.sequence);
                self.end(id, |c| c.refusal(actor, sequence, "act.timed-out"));
            }
        }
        at[3] = mark();
        // 1-3. The bodies' own timers, skills through the host, the controller.
        self.step_bodies(now);
        at[4] = mark();
        // 4. Committed acts: the checks back since the last tick, then the moves taken.
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
                    if let Some(m) = &self.measures {
                        m.left_tick(act.id);
                        m.to_check(act.id, None);
                    }
                    act.recheck = Some(version);
                    self.outstanding += 1;
                    let _ = self.acts.send(act);
                }
                Outcome::Refused { reason } => {
                    self.end(id, |c| c.refusal(actor, sequence, &reason));
                }
            }
        }
        self.start_moves(now);
        at[5] = mark();
        // 5. The tick's input record, then its part: effects, answers, the bodies that moved, the tick, the state.
        let inputs = match std::mem::take(&mut self.inputs) {
            i if i.is_empty() => None,
            i => recorder::record(u64::try_from(n).unwrap_or(0), &i).ok(),
        };
        let moved = self.bodies.as_mut().map(Bodies::moved).unwrap_or_default();
        let record =
            (!self.rows.is_empty() || !self.effects.is_empty() || !moved.is_empty()).then(|| {
                let state = self.state();
                let v = Value::Map(BTreeMap::from([
                    (1, Value::Bytes(self.replica.header().hash().to_bytes())),
                    (
                        2,
                        Value::Array(self.effects.drain(..).map(|e| e.to_value()).collect()),
                    ),
                    (ANSWERED, Value::Array(std::mem::take(&mut self.rows))),
                    (
                        BODIES,
                        Value::Array(
                            moved
                                .iter()
                                .map(|(id, p, s)| bodies::row(*id, p, *s))
                                .collect(),
                        ),
                    ),
                    (TICK, Value::Uint(u64::try_from(n).unwrap_or(0))),
                    (STATE, Value::Bytes(state.to_vec())),
                ]));
                encode(&v).unwrap_or_default()
            });
        at[6] = mark();
        // 6. The frozen copy, for the checkers and readers.
        if !self.parts.is_empty() {
            self.publisher.publish(std::mem::take(&mut self.parts));
        }
        // 7. The answers thread appends, syncs, hands the synced tick to the view tier, then answers.
        let replies = std::mem::take(&mut self.replies);
        let bytes = inputs.as_ref().map_or(0, Vec::len) + record.as_ref().map_or(0, Vec::len);
        let written = u64::from(inputs.is_some()) + u64::from(record.is_some());
        let handed = mark();
        if written > 0 || !replies.is_empty() {
            let _ = self.answers.send(Tick {
                inputs,
                record,
                replies,
                started: at[0],
                handed,
            });
        }
        self.records += written;
        self.since += bytes as u64;
        at[7] = mark();
        // 8. A slice of the auditor: faults named, nothing repaired, the clock never stopped. The slice stops at
        // AUDIT_TIME (K21, #3422), and its faults are printed on the auditor's own thread: a write to stderr can block
        // for hundreds of ms on a loaded machine, and printing them here once stalled the clock.
        let until = Instant::now() + AUDIT_TIME;
        let slice = self
            .auditor
            .slice_within(self.replica.tree(), self.audit, &mut || {
                Instant::now() >= until
            });
        self.faults += slice.faults.len() as u64;
        if !slice.faults.is_empty() {
            let _ = self.audit_faults.send(slice.faults);
        }
        at[8] = mark();
        if let Some(m) = &self.measures {
            let mut phases = [0; measures::NPHASES];
            for (i, p) in phases.iter_mut().enumerate() {
                if let (Some(a), Some(b)) = (at[i], at[i + 1]) {
                    *p = b.saturating_sub(a);
                }
            }
            m.tick(phases);
        }
    }

    /// K5's checkpoint, when due and the log is on the disk up to every record handed to it (K18c, #3176): the
    /// tree, where the log resumes (K4b) and what a restart needs besides the tree ([`Carry`], in the root's seed).
    fn checkpoint(&mut self) {
        let Some(c) = self.checkpoints.as_mut() else {
            return;
        };
        c.appended(std::mem::take(&mut self.since));
        let at = self.durable.at();
        if !c.due() || at.record < self.records {
            return;
        }
        let carry = Carry::of(
            &self.sequences,
            self.next_intent,
            self.bodies.as_ref().map(Bodies::placed).unwrap_or_default(),
            self.tick,
        );
        let version = Version {
            lineage: self.lineage,
            zone: self.zone,
            epoch: self.epoch,
            sequence: self.replica.version(),
        };
        let minter = Minter::at(self.lineage, self.next_intent);
        let Some(c) = self.checkpoints.as_mut() else {
            return;
        };
        if let Err(e) = c.take_at(
            self.replica.tree_for_seal(),
            version,
            self.records,
            Some((at, &minter)),
            &carry.to_bytes(),
        ) {
            eprintln!("worldd: a checkpoint was not taken: {e}");
        }
    }

    fn ran(&mut self) -> Ran {
        let panicked = self
            .bodies
            .as_ref()
            .map_or(0, |b| b.runner.units.ended.len() as u64);
        let mut seated: Vec<(Id, Id)> = self
            .bodies
            .as_ref()
            .map(|b| {
                b.slots
                    .seated()
                    .into_iter()
                    .map(|(b, t, _)| (b, t))
                    .collect()
            })
            .unwrap_or_default();
        seated.sort();
        Ran {
            tick: self.tick,
            state: self.state(),
            faults: self.faults,
            panicked,
            seated,
        }
    }
}

/// The answers thread: each tick's records appended and on the disk before its answers leave, then the part handed to
/// the view tier. A log that fails stops it for good: nothing is answered that is not on the disk.
fn answer_loop<S: Storage + 'static>(
    mut log: Log<S>,
    ticks: Receiver<Tick>,
    tier: Option<Arc<Tier>>,
    measures: Option<Arc<Measures>>,
    synced: Option<Sender<Synced>>,
) {
    for (k, t) in ticks.into_iter().enumerate() {
        let k = k as u64;
        if let Some(m) = &measures {
            m.queues[measures::LOG].enter(k, t.handed.unwrap_or_else(measures::steady_us));
        }
        let mut last = None;
        let mut appended = Vec::new();
        for (k, bytes) in [t.inputs, t.record].into_iter().enumerate() {
            let Some(bytes) = bytes else { continue };
            let copy = (k == 1 && tier.is_some()).then(|| bytes.clone());
            let kept = synced.as_ref().map(|_| bytes.clone());
            match log.append(bytes) {
                Ok(n) => {
                    last = Some(n);
                    if let (Some(tier), Some(b)) = (&tier, copy) {
                        tier.offer(n, b);
                    }
                    if let Some(b) = kept {
                        appended.push(Synced {
                            record: n,
                            bytes: b,
                            input: k == 0,
                        });
                    }
                }
                Err(e) => {
                    eprintln!("worldd: the log failed, nothing more is answered: {e}");
                    return;
                }
            }
        }
        if let Some(n) = last
            && let Err(e) = log.wait_durable(n + 1)
        {
            eprintln!("worldd: the log failed, nothing more is answered: {e}");
            return;
        }
        if let Some(tx) = &synced {
            for s in appended {
                let _ = tx.send(s);
            }
        }
        let synced = measures.as_ref().map(|_| measures::steady_us());
        for (waiters, frame, mut stamps) in t.replies {
            let frame = match &measures {
                Some(m) => {
                    stamps.0[3] = t.started;
                    stamps.0[4] = t.handed;
                    stamps.0[5] = synced;
                    stamps.0[6] = Some(measures::steady_us());
                    measures::with_block(frame, &m.answered(&stamps))
                }
                None => frame,
            };
            for w in waiters {
                let _ = w.send(frame.clone());
            }
        }
        if let Some(m) = &measures {
            m.queues[measures::LOG].leave(k);
        }
    }
}

/// What a restart reads back from the log besides the tree: each body's last pose and the last tick logged.
fn read_back(part: &Part, placed: &mut Placed, last: &mut Option<i64>) {
    if let Some(Value::Array(rows)) = part.rest.get(&BODIES) {
        for (id, pose, stance) in rows.iter().filter_map(bodies::read_row) {
            placed.insert(id, (pose, stance));
        }
    }
    if let Some(Value::Uint(n)) = part.rest.get(&TICK) {
        *last = Some(i64::try_from(*n).unwrap_or(i64::MAX));
    }
}

fn time(e: replica::time::TimeRefusal) -> Refusal {
    Refusal {
        name: "time",
        detail: e.name().to_string(),
    }
}

/// Opens the log in `storage`, replays it onto `world` (the world as built, before any record), and starts the
/// clock, answers and checker threads. The bodies are made where the log last had them, standing or seated, and the
/// ticker resumes after the last tick logged.
///
/// With [`Config::checkpoints`], a restart starts from the newest checkpoint that verifies (K5): its tree and its
/// carry ([`Carry`]: kept answers, the next intent id, the bodies, the tick), with the log opened at the checkpoint's
/// durable place (K4b) and only the records after it replayed ([`World::restart`] says how many).
pub fn start<S: Storage + 'static>(
    mut world: Replica,
    rules: Rules,
    storage: S,
    cfg: Config,
) -> R<World> {
    let restored = match &cfg.checkpoints {
        Some((dir, _)) if dir.exists() => checkpoint::restore(dir)?,
        _ => None,
    };
    for (name, why) in restored.iter().flat_map(|r| &r.rejected) {
        eprintln!("worldd: checkpoint {name} passed over: {why}");
    }
    let (log, found) = Log::open_at(
        storage,
        cfg.epoch,
        restored.as_ref().and_then(|r| r.root.log),
    )?;
    let mut sequences = Sequences::default();
    let mut receipts = Receipts::default();
    let mut next_intent = 1;
    let mut placed = Placed::new();
    let mut last = None;
    let mut restart = Restart::default();
    let mut blobs = Blobs::default();
    let records: &[Vec<u8>] = match restored {
        Some(r) => {
            let logged = found.first + found.records.len() as u64;
            if logged < r.root.record {
                // Not by K18c's rule (a checkpoint waits for the log's sync), but a log cut short by hand would.
                eprintln!(
                    "worldd: checkpoint at record {} is past the log's end ({logged}): its tree is kept",
                    r.root.record
                );
            }
            world = Replica::restored(world.header().clone(), r.tree, r.root.version.sequence);
            if let Some(c) = Carry::read(&r.root.seed) {
                for (actor, last_seq, kept) in c.sequences {
                    sequences.restore(&actor, last_seq, kept);
                }
                next_intent = c.next_intent.max(1);
                placed = c.placed;
                last = (c.tick >= 0).then_some(c.tick);
            }
            restart.checkpoint = Some(r.root.record);
            blobs = r.blobs;
            found.after(r.root.record)
        }
        None => &found.records,
    };
    restart.read = records.len() as u64;
    for record in records {
        // The recorder's input records are what the world was handed, not what it did (K12): passed by.
        if recorder::is_input(record) {
            continue;
        }
        let part = Part::read(record)?;
        if !part.effects.is_empty() {
            world.apply(&part)?;
        }
        restart.applied += 1;
        receipts.index(&part.effects);
        read_back(&part, &mut placed, &mut last);
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
    let records = found.first + found.records.len() as u64;
    let mut checkpoints = match &cfg.checkpoints {
        Some((dir, every)) => Some(Checkpoints::open(dir, *every, blobs)?),
        None => None,
    };
    // K20 (#3395): a tree holding changes no checkpoint has (a first start from the log, or the log after the newest
    // checkpoint) is sealed and checkpointed here, before the clock and its watchdog start: hashing the whole tree is
    // never a tick's work, and from here each tick's state hash and each checkpoint hash only what changed.
    if let Some(c) = checkpoints.as_mut()
        && !world.tree().sealed()
    {
        let at = log.durable_mark().at();
        if at.record >= records {
            let carry = Carry::of(&sequences, next_intent, placed.clone(), last.unwrap_or(-1));
            let version = Version {
                lineage: cfg.lineage,
                zone,
                epoch: cfg.epoch,
                sequence: world.version(),
            };
            let minter = Minter::at(cfg.lineage, next_intent);
            c.take_at(
                world.tree_for_seal(),
                version,
                records,
                Some((at, &minter)),
                &carry.to_bytes(),
            )?;
        }
    }
    let mut cfg = cfg;
    let make = cfg.bodies.take();
    let tick_us = i64::try_from(cfg.tick.as_micros()).unwrap_or(50_000).max(1);
    if 1_000_000 % tick_us != 0 {
        return Err(Refusal {
            name: "tick-rate",
            detail: format!("a tick of {tick_us} µs is not a whole number of ticks a second"),
        });
    }
    // World time is real time, µs from the Unix epoch (rate one); tick n starts at n ticks from it.
    let mapping = Mapping::new(0, 0, 1, 1).map_err(time)?;
    let line = Timeline::start(
        mapping,
        TickRate::new(0, 0, 1_000_000 / tick_us).map_err(time)?,
        Tempo::per_minute(0, 0, 120).map_err(time)?,
    )
    .map_err(time)?;
    let shared = Arc::new(Mutex::new(0));
    let mut pace: Box<dyn Pace + Send> = match (cfg.lockstep, cfg.clock.take()) {
        (true, _) => Box::new(Stepped(Arc::clone(&shared))),
        (false, Some(c)) => c,
        (false, None) => Box::new(Real::start()),
    };
    let real0 = pace.now();
    // A first start begins at the tick due now, not at the epoch's.
    let last = match (last, cfg.lockstep) {
        (Some(n), _) => Some(n),
        (None, true) => None,
        (None, false) => Some(real0.div_euclid(tick_us) - 1),
    };
    let mut ticker = Ticker::new(line, mapping, last, real0).map_err(time)?;
    let beat = Arc::new(Heartbeat::new(real0));
    let tier = match cfg.views {
        true => Some(Arc::new(Tier::start(
            world.header().clone(),
            world.tree().to_state(),
            Redactions::new([]),
            log.durable_mark(),
        )?)),
        false => None,
    };
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
    let measures = cfg.measures.then(|| Arc::new(Measures::default()));
    if let (Some(m), Some(path)) = (&measures, cfg.health.take()) {
        measures::write_health(Arc::clone(m), path, measures::EVERY);
    }
    let durable = log.durable_mark();
    let world_durable = log.durable_mark();
    let synced = cfg.synced.take();
    let (answers, ticks) = channel();
    let answer_tier = tier.clone();
    let answer_measures = measures.clone();
    let answering = thread::Builder::new()
        .name("answers".into())
        .spawn(move || answer_loop(log, ticks, answer_tier, answer_measures, synced))
        .map_err(io)?;
    let (audit_faults, faults_in) = channel::<Vec<Fault>>();
    thread::Builder::new()
        .name("audit".into())
        .spawn(move || {
            for f in faults_in.iter().flatten() {
                eprintln!("worldd: audit: {f:?}");
            }
        })
        .map_err(io)?;
    let clock_measures = measures.clone();
    // Built on the clock thread: skills (in the bodies) stay on the thread that steps them.
    let build = move || Clock {
        replica: world,
        publisher,
        acts,
        answers,
        sequences,
        receipts,
        deadlines: Deadlines::default(),
        open: BTreeMap::new(),
        in_flight: BTreeMap::new(),
        next_intent,
        lineage: cfg.lineage,
        zone,
        epoch: cfg.epoch,
        deadline: cfg.deadline,
        arrivals: cfg.arrivals,
        checked: Vec::new(),
        replies: Vec::new(),
        rows: Vec::new(),
        effects: Vec::new(),
        parts: Vec::new(),
        bodies: None,
        moving: Vec::new(),
        pending: Vec::new(),
        scheduled: BTreeMap::new(),
        inputs: Vec::new(),
        outstanding: 0,
        auditor: Auditor::new(),
        audit: cfg.audit,
        audit_faults,
        faults: 0,
        checkpoints,
        records,
        since: 0,
        durable,
        tick: last.unwrap_or(-1),
        measures: clock_measures,
    };
    let lockstep = cfg.lockstep;
    let thread_beat = Arc::clone(&beat);
    let clock = thread::Builder::new()
        .name("clock".into())
        .spawn(move || {
            mark_clock_thread();
            let beat = thread_beat;
            let mut c = build();
            if let Some(make) = make {
                match make(&placed) {
                    Ok(mut b) => {
                        let at = ticker.due().unwrap_or(0);
                        b.begin(at);
                        // Those the log last had in a seat sit in it again, the seat held (K18c).
                        for (body, why) in b.seat_placed(&placed, at) {
                            eprintln!(
                                "worldd: {} stands, not seated again: {why}",
                                replica::world_model::show(body)
                            );
                        }
                        c.bodies = Some(b);
                    }
                    Err(e) => eprintln!("worldd: the bodies did not start, moves are refused: {e}"),
                }
            }
            // The state this start resumes from, bodies included: after a kill it equals the last logged tick's (C1).
            let state = c.state();
            eprintln!(
                "worldd: started at tick {} state {}",
                c.tick,
                replica::encode::to_hex(&state)
            );
            // Takes one event; false once the world is to stop.
            let take = |c: &mut Clock, e: Event| -> Option<Sender<Ran>> {
                match e {
                    Event::Arrival {
                        bytes,
                        reply,
                        mut stamps,
                        key,
                    } => {
                        // Taken off the queue by the clock thread (O4's `world.in` ends here); its act starts at the
                        // next tick.
                        if let Some(m) = &c.measures {
                            m.taken(key, &mut stamps);
                        }
                        c.pending.push((bytes, reply, stamps))
                    }
                    Event::ArrivalAt { tick, bytes, reply } => {
                        c.scheduled.entry(tick).or_default().push((bytes, reply))
                    }
                    Event::Checked(k) => {
                        let (act, checks) = *k;
                        c.checks_back(act, checks);
                    }
                    Event::Stall(d) => thread::sleep(d),
                    Event::RunTo { done, .. } => return Some(done),
                    Event::Stop => {}
                }
                None
            };
            loop {
                if lockstep {
                    let Ok(e) = rx.recv() else { break };
                    let (to, done) = match e {
                        Event::Stop => break,
                        Event::RunTo { tick, done } => (tick, done),
                        e => {
                            take(&mut c, e);
                            continue;
                        }
                    };
                    let mut stop = false;
                    while ticker.next_tick() <= to && !stop {
                        // Every check back before the tick, so the same inputs commit at the same ticks.
                        while c.outstanding > 0 {
                            match rx.recv() {
                                Ok(Event::Stop) | Err(_) => {
                                    stop = true;
                                    break;
                                }
                                Ok(e) => {
                                    take(&mut c, e);
                                }
                            }
                        }
                        let Ok(due) = ticker.due() else { break };
                        *shared.lock().unwrap_or_else(|p| p.into_inner()) = due;
                        if let Err(e) = ticker.run_due(&mut *pace, &beat, &mut |n, s| c.tick(n, s))
                        {
                            eprintln!("worldd: {}", e.name());
                            stop = true;
                        }
                    }
                    let _ = done.send(c.ran());
                    if stop {
                        break;
                    }
                    continue;
                }
                // The ticks due by the clock run first, back to back when behind (K7), so a busy queue never starves
                // them; then events are taken until the next is due.
                if let Err(e) = ticker.run_due(&mut *pace, &beat, &mut |n, s| c.tick(n, s)) {
                    eprintln!("worldd: {}", e.name());
                    break;
                }
                let Ok(due) = ticker.due() else { break };
                let wait = due - pace.now();
                if wait <= 0 {
                    continue;
                }
                match rx.recv_timeout(Duration::from_micros(wait as u64)) {
                    Ok(Event::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                    Ok(Event::RunTo { done, .. }) => {
                        let _ = done.send(c.ran());
                    }
                    Ok(e) => {
                        take(&mut c, e);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                }
            }
            drop(c);
            let _ = answering.join();
        })
        .map_err(io)?;
    Ok(World {
        events,
        beat,
        tier,
        measures,
        restart,
        durable: world_durable,
        clock: Some(clock),
    })
}

/// Serves one connection of the gateway's local socket (I1's framing: a 4-byte big-endian length, then that many
/// bytes): each intent read goes through `world`'s door (stamped there, O4), each answer goes back on the same
/// connection, in the order sent.
pub fn serve(world: Door, mut stream: UnixStream) {
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
    let (reply, answers) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for frame in answers {
            let len = u32::try_from(frame.len()).unwrap_or(u32::MAX).to_be_bytes();
            if out.write_all(&len).is_err() || out.write_all(&frame).is_err() {
                return;
            }
        }
    });
    loop {
        let mut len = [0u8; 4];
        if stream.read_exact(&mut len).is_err() {
            return;
        }
        let len = u32::from_be_bytes(len) as usize;
        if len > INTENT_MOST as usize {
            return;
        }
        let mut bytes = vec![0u8; len];
        if stream.read_exact(&mut bytes).is_err() {
            return;
        }
        if !world.arrive(bytes, reply.clone()) {
            return;
        }
    }
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
        assert!(w.door().arrive(bytes, reply));
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

    /// A frame without its times (O4's field 3): the answer as logged.
    fn bare(frame: &[u8]) -> Vec<u8> {
        let Value::Map(mut m) = decode(frame).unwrap().value else {
            panic!("a frame")
        };
        assert!(
            m.remove(&replica::intents::ANSWER_TIMES).is_some(),
            "a frame with its times"
        );
        encode(&Value::Map(m)).unwrap()
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
            .filter(|r| !recorder::is_input(r))
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
        assert_eq!(
            bare(&again),
            bare(&first),
            "the kept answer (its times are its own)"
        );
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
        assert_eq!(bare(&again), bare(&kept), "kept across a restart");
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

    #[test]
    fn an_act_no_checker_answers_ends_timed_out_at_its_deadline() {
        let (w, pairs) = world(Held::new(Vec::new()), 0, 100_000);
        let started = Instant::now();
        let rx = send(&w, &toggle(pairs[3].0, pairs[3].1, 1, now() + 60_000_000));
        assert_eq!(reason(&answer(&rx)), "act.timed-out");
        assert!(started.elapsed() >= Duration::from_millis(100));
        w.stop();
    }

    // --- O4 (#2694): measures. A1 and A3 are the `measures` bench. ---------------------------------------------

    /// The log of `acts` acts sent one at a time, each after the last's answer, with measures on or off. Lockstep
    /// (K18): world time is the ticker's, so two runs log the same bytes.
    fn seeded_log(measures: bool, acts: u64) -> Vec<u8> {
        let store = Held::new(Vec::new());
        let w = toggles::World::build(1, 4, 0);
        let pairs = w.pairs.clone();
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.measures = measures;
        cfg.lockstep = true;
        let world =
            start(w.replica, toggles::rules(), store.clone(), cfg).expect("the world starts");
        for s in 1..=acts {
            let (body, thing) = pairs[(s % 4) as usize];
            let rx = send(&world, &toggle(body, thing, s / 4 + 1, 1_000_000_000_000));
            // Taken at the next tick, committed at the one after (its check back in between).
            let (done, ran) = channel();
            world
                .events
                .send(Event::RunTo {
                    tick: 2 * s as i64,
                    done,
                })
                .unwrap();
            ran.recv().unwrap();
            let f = answer(&rx);
            let Value::Map(m) = decode(&f).unwrap().value else {
                panic!("a frame")
            };
            assert_eq!(
                m.contains_key(&replica::intents::ANSWER_TIMES),
                measures,
                "the block rides the answer exactly when measures are on"
            );
            assert_eq!(read(&f).0, 1, "a receipt");
        }
        world.stop();
        store.bytes()
    }

    #[test]
    fn o4_a5_the_log_is_the_same_with_measures_on_and_off() {
        let on = seeded_log(true, 200);
        let off = seeded_log(false, 200);
        assert_eq!(
            recover(&on).unwrap().records.len(),
            400,
            "one input record (K12) and one part per act"
        );
        assert_eq!(
            replica::ids::sha256(&on),
            replica::ids::sha256(&off),
            "the log hash, measures on and off"
        );
    }

    /// `"<name>":{"items":n,"oldest_us":m}` in a health file: (n, m).
    fn queue(health: &str, name: &str) -> (u64, u64) {
        let at = health
            .find(&format!("\"{name}\":{{\"items\":"))
            .expect(name);
        let rest = &health[at + name.len() + 12..];
        let num = |s: &str| {
            s.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        };
        let items = num(rest);
        let rest = &rest[rest.find("\"oldest_us\":").unwrap() + 12..];
        (items.parse().unwrap(), num(rest).parse().unwrap())
    }

    #[test]
    fn o4_a2_a4_health_shows_phases_and_queues_and_updates_with_the_clock_stuck() {
        let dir = std::env::temp_dir().join(format!("o4-health-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("health.json");
        let w = toggles::World::build(1, 4, 0);
        let pairs = w.pairs.clone();
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.health = Some(path.clone());
        let world = start(w.replica, toggles::rules(), Held::new(Vec::new()), cfg).unwrap();
        let later = now() + 600_000_000;
        for s in 1..=20 {
            answer(&send(&world, &toggle(pairs[0].0, pairs[0].1, s, later)));
        }
        // A2: each tick's phases against the budget, and every queue's oldest item.
        thread::sleep(Duration::from_millis(2_100));
        let h = std::fs::read_to_string(&path).unwrap();
        assert!(h.contains("\"budget_us\":50000"), "{h}");
        for p in measures::PHASES {
            assert!(h.contains(&format!("\"{p}\":")), "phase {p}: {h}");
        }
        for p in measures::PARTS {
            assert!(
                h.contains(&format!("\"{p}\":{{\"count\":20,")),
                "part {p}: {h}"
            );
        }
        for q in measures::QUEUES {
            assert_eq!(queue(&h, q).0, 0, "queue {q} is empty at rest: {h}");
        }

        // A4: the clock thread held for 7 s; the health file keeps coming every 2 s, its arrivals ageing.
        world
            .events
            .send(Event::Stall(Duration::from_secs(7)))
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        let rx = send(&world, &toggle(pairs[1].0, pairs[1].1, 1, later));
        let start = Instant::now();
        let mut seen: Vec<(Duration, u64)> = Vec::new();
        let mut last = String::new();
        while start.elapsed() < Duration::from_millis(6_500) {
            let h = std::fs::read_to_string(&path).unwrap_or_default();
            if h != last && !h.is_empty() {
                seen.push((start.elapsed(), queue(&h, "arrivals").1));
                last = h;
            }
            thread::sleep(Duration::from_millis(20));
        }
        eprintln!(
            "o4 a4: health.json rewrites while the clock thread is held (since the hold, arrivals oldest µs): {seen:?}"
        );
        assert!(
            seen.len() >= 3,
            "written at least three times while stuck: {seen:?}"
        );
        for pair in seen.windows(2) {
            assert!(
                pair[1].0 - pair[0].0 <= Duration::from_millis(2_300),
                "every 2 s: {seen:?}"
            );
            assert!(
                pair[1].1 > pair[0].1,
                "the arrival waits, older each time: {seen:?}"
            );
        }
        assert!(seen.last().unwrap().1 >= 4_000_000, "{seen:?}");
        assert_eq!(
            read(&answer(&rx)).0,
            1,
            "answered once the clock thread is back"
        );
        world.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
