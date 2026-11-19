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
//! come in an intent as T8's `{23: words}` (CBOR text is names only, so words are bytes). Each is kept in K16's store
//! ([`Config::text`]) and replaced by its reference before the intent is logged or acted on (V1b, #3361,
//! [`crate::words`]): none of their bytes reach the log (`a5_` test). A `say`, a `whisper` or a `describe` writes its
//! entry at once and is answered with a receipt after its tick's sync.
//!
//! **Sync by hash** (R5b, #3164): a frame with key 20 is R5's sync request (`replica::sync::wire`), not an intent.
//! The clock thread answers it from the tree as last sealed, sealing first when the world has changed since, and
//! every record a seal gave is kept, so a client compares and descends over the place, which every actor is granted.
//! Its answer goes to the answers thread at once, behind every tick record already sent: it never shows a change
//! before the change is on the disk, and never waits for a tick.
//!
//! **The world's tick** (K18, #3160). One loop per zone, run by K7's ticker at the clock's rate (one tick each
//! [`Config::tick`]; world time is real time in µs from the Unix epoch, rate one). Each tick, in the trunk's order
//! (T1: everything reads the state as of the tick's start, and what a tick writes is seen from the next):
//!
//! 0. the intents that arrived since the last tick are taken (the recorder's inputs, K12);
//! 1. due timers: acts whose deadline passed end `act.timed-out` (K9's due list); the world node's light, day and
//!    weather timers due before the next tick fire at their due times and write their entries (E6, #3369; a first
//!    start writes [`Config::sky`] when the node holds no settings); loose things' ends due fire likewise (F10b,
//!    [`crate::loose`]); a move's phase timers fire;
//! 2. skills step through the host, each one unit in K11's wrapper (K13a, T9b/T9c; a panic ends that skill only);
//! 3. the controller steps the bodies (B1), moves and seats included (B2, B3); each utterance a step started is
//!    written with its hearers (`sim::speech::heard`, B11, #3369);
//! 4. committed acts: the checks that came back are committed (I3, I4), then the checked edits (G1b, `sim::edit`;
//!    each counts as outstanding, so lockstep waits for it as for an act), and new moves start (I4b); what they made
//!    loose gets its end, and what they made kept loses it (F10b, [`crate::loose`]);
//! 5. the tick's input record, then its part, go to the log (K4, K12): the part carries the answers ([`ANSWERED`]),
//!    the bodies that moved ([`BODIES`]), the tick ([`TICK`]) and the zone's state hash after it ([`STATE`]);
//! 6. the frozen copy is published (K8);
//! 7. the answers thread appends and syncs the records, then hands the synced tick to the view tier (R3) and sends
//!    the answers;
//! 8. the auditor checks a slice of the tree (K11).
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
//! **Off the clock** (K18b, #3175). The clock runs no rule check, no route search and no reach check: the checkers
//! run the rules (I3), and the bodies' planner thread (`sim::planner`) writes the spot tables, plans a walk's legs,
//! finds each walker's line and measures each reach, from the bodies as a tick left them, for the next tick. A
//! lockstep tick waits for the planner's answers to the last one as it waits for every check, so a run fed the same
//! inputs repeats; a free-running one waits at most a tenth of a tick for each batch and reads a late one at a later
//! tick, so the clock never stops for the planner.
//!
//! Not here (K18's known limits): a walk or a sit in progress at a kill is not resumed (its intent is taken again
//! when sent again); one zone a process.
// worldd's real clock (`Real`): the one place the process reads time.
#![allow(clippy::disallowed_methods)]

use crate::bodies::{self, Ask, Asked, Bodies, Placed};
use crate::checkers::{self, Act, Candidate, Rules, SpotAct};
use crate::loose::Ends;
use crate::measures::{self, Measures, Stamps};
use crate::views::Tier;
use crate::words;
use replica::apply::Replica;
use replica::edit::{self, Edit, Refused};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event as Named, Part, Refusal, Rest,
    TimerRec,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope, Version};
use replica::intents::{Answer, INTENT_MOST, Intent, Kind, Target};
use replica::pose::Pose;
use replica::select::Answer as Answered;
use replica::select::Spot;
use replica::select::wire::SPOT;
use replica::sky::{self, Sky};
use replica::sync::{self, Records, Served, wire};
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use replica::views::Redactions;
use replica::world_model::Audience;
use sim::audit::Auditor;
use sim::checkpoint::{self, Blobs, Checkpoints};
use sim::clock::{Clock as Pace, Heartbeat, Ticker};
use sim::commit::acts::{Deadlines, Receipts, Seen, Sequences, expired};
use sim::commit::spot::{self, Spot as Bound};
use sim::commit::{Checks, Outcome, commit, mark_clock_thread};
use sim::daylight::{self, Daylight, Write as Fire};
use sim::edit::Planned;
use sim::frozen::Publisher;
use sim::log::{Durable, Log, Storage};
use sim::recorder::{self, Input};
use sim::speech;
use sim::text::Store;
use sim::timers::{DueList, Timer};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type R<T> = Result<T, Refusal>;

fn recs_of(changes: Vec<Change>) -> Vec<ChangeRec> {
    changes
        .into_iter()
        .map(|change| ChangeRec {
            change,
            rest: Rest::new(),
        })
        .collect()
}

/// Makes the world's bodies on the thread that steps them (a skill is not sent between threads), each standing where
/// the log last had it (`Placed`, empty on a first start; [`Bodies::add_body_at`]).
pub type MakeBodies = Box<dyn FnOnce(&Placed) -> R<Bodies> + Send>;

/// Where an answer frame goes: the connection the intent came on.
pub type Reply = Sender<Vec<u8>>;

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
    /// An edit checked off the clock thread on a frozen copy (G1b): to commit at the next tick, or its refusal.
    Edited(Box<(Id, Result<Planned, Refused>)>),
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
    /// Route searches the bodies' planner ran, off the clock (K18b).
    pub searched: u64,
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
    /// `<version> <place hash hex>` appended after each tick that changed the world, the tree sealed for it (R5b's
    /// relay test checks a client's copy against it).
    pub roots: Option<File>,
    /// Stamps, the answers' block, tick phases and queue ages (O4). Off takes no stamps and adds no block.
    pub measures: bool,
    /// Where `health.json` is written every two seconds, when measures are on.
    pub health: Option<PathBuf>,
    /// The world's one creator and the kinds it pins, for edit intents (G1b, #3362); without them every edit is
    /// refused `edit.not-the-creator`.
    pub edits: Option<edit::World>,
    /// The day, night and weather (E6) a start writes on the world node when it holds none; a world node that holds
    /// its settings keeps them. `None`: a world without settings has no sky.
    pub sky: Option<daylight::Config>,
    /// The view subscriptions' tier (#3292), handed each tick's part once it is on the disk.
    pub served: Option<crate::views::served::Feed>,
    /// K16's text store, where an intent's words are kept (V1b); a store in memory when none is given.
    pub text: Option<Arc<Store>>,
    /// Called once at start with the log's durable mark; what it gives is handed each part record as it is appended
    /// (its number and bytes): a view tier's `offer`, so a stream writer follows the world (V1b).
    pub follow: Option<Follow>,
    /// Each log record once it is on the disk, input records included, in order (C1, #3365): `worldd serve`'s own
    /// view tier and shipper read them here, off the clock thread.
    pub synced: Option<Sender<Synced>>,
    /// How long a free-running tick waits for each of the bodies' planner batches (K18b); `None` is a tenth of a tick.
    pub planner_wait: Option<Duration>,
    /// A replay's planner batches (K18b): the recorder's `Planned` inputs, body time µs and batches taken there.
    pub planned: BTreeMap<u64, u64>,
}

/// A record on the disk ([`Config::synced`]): its number in the log, its bytes, and whether it is the recorder's input
/// record (K12) rather than a tick's part.
pub struct Synced {
    pub record: u64,
    pub bytes: Vec<u8>,
    pub input: bool,
}

/// See [`Config::follow`]: what each appended record (its number and bytes) is handed to.
pub type Offer = Box<dyn FnMut(u64, Vec<u8>) + Send>;
/// See [`Config::follow`].
pub type Follow = Box<dyn FnOnce(Durable) -> Offer + Send>;

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
            roots: None,
            measures: true,
            health: None,
            edits: None,
            synced: None,
            planner_wait: None,
            planned: BTreeMap::new(),
            sky: None,
            served: None,
            text: None,
            follow: None,
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
    /// Sync answers (R5b): sent as they are, with no block.
    bare: Vec<(Vec<Reply>, Vec<u8>)>,
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
    roots: Option<File>,
    /// Every record the tree's seals gave, and whether the world changed since the last seal (R5b).
    kept: Records,
    unsealed: bool,
    /// The nodes R5b's seals hashed since the last checkpoint: the next checkpoint writes them too, as its own seal
    /// finds only what changed after them.
    fresh: Vec<(Hash, Vec<u8>)>,
    checked: Vec<(Act, Checks)>,
    replies: Vec<Out>,
    rows: Vec<Value>,
    effects: Vec<Effect>,
    parts: Vec<Arc<Part>>,
    bodies: Option<Bodies>,
    /// Move intents taken since the last tick, committed at the next (I4b).
    moving: Vec<(Id, Asked)>,
    /// Where edits go to be checked off the clock thread, when the world takes edits (G1b).
    edits: Option<Sender<(Id, Edit)>>,
    /// Edits checked since the last tick, committed (or refused) at the next.
    edited: Vec<(Id, Result<Planned, Refused>)>,
    /// Intents arrived since the last tick, taken at the start of the next; and those a script set for a tick.
    pending: Vec<(Vec<u8>, Reply, Stamps)>,
    scheduled: BTreeMap<i64, Vec<(Vec<u8>, Reply)>>,
    /// The tick's inputs, for the recorder (K12).
    inputs: Vec<Input>,
    /// Acts on the checkers' queue, not yet back (lockstep waits for none).
    outstanding: usize,
    auditor: Auditor,
    audit: usize,
    faults: u64,
    checkpoints: Option<Checkpoints>,
    /// Log records written, the input records included.
    records: u64,
    /// Log bytes handed since the last checkpoint's count, and the log's durable mark (K18c).
    since: u64,
    durable: Durable,
    tick: i64,
    measures: Option<Arc<Measures>>,
    /// K16's store, where words are kept (V1b).
    text: Arc<Store>,
    /// The world node's day, night and weather (E6, #3369), when the world has them.
    sky: Option<Heavens>,
    /// The tick's length, µs: a tick fires the sky's timers due before the next tick's start (K9).
    tick_us: Micros,
    /// Loose things' ends (F10b, #3476), and the ends of owner's links the tick's acts ended.
    loose: Ends,
    unlinked: Vec<Id>,
}

/// The world node's sky in the running tick (E6, #3369): its three timers on K9's due list, each fired at its due time
/// by the tick that holds it, and each fire's entries written on the world node.
struct Heavens {
    daylight: Daylight,
    /// The world node's timers: `souls:light`, `souls:day`, `souls:weather`.
    due: DueList,
    /// Each timer's id now, by name: a fire clears it and sets the next.
    timers: BTreeMap<Name, Id>,
    mint: Minter,
    /// A first start writes the settings and the first light, date and weather at its first tick.
    first: bool,
}

/// The scope the sky's timer ids are minted in.
const SKY_TIMERS: Scope = Scope([0xe6; 16]);

impl Heavens {
    /// The sky of `replica`'s world node: its settings as the node holds them (a restart rebuilds the due list from
    /// the timers the tree holds), else `new`'s, written at the first tick; `None` with neither.
    fn of(replica: &Replica, new: Option<daylight::Config>) -> Option<Heavens> {
        let tree = replica.tree();
        let root = tree.node(tree.root())?;
        let world = root.id();
        let (cfg, first) = match daylight::Config::read(root.fields()) {
            Some(c) => (c, false),
            None => (new?, true),
        };
        let names = [sky::T_LIGHT, sky::T_DAY, sky::T_WEATHER];
        let mut due = DueList::new();
        let mut timers = BTreeMap::new();
        let mut mint = Minter::new(SKY_TIMERS);
        for (id, t) in tree.timers() {
            if t.node == world && names.contains(&t.name.as_str()) {
                let _ = due.set(Timer {
                    node: world,
                    id: *id,
                    due: t.due,
                    name: t.name.clone(),
                });
                timers.insert(t.name.clone(), *id);
                if id.scope() == SKY_TIMERS {
                    mint.past(id.counter());
                }
            }
        }
        Some(Heavens {
            daylight: Daylight::new(cfg, world),
            due,
            timers,
            mint,
            first,
        })
    }
}

/// What an intent becomes: a form's act for the checkers, a move for the bodies, or an edit for the edit checker.
enum Taken {
    Form(Act),
    Move(Asked),
    Edit(Edit),
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
        spot: None,
    })
}

/// A walk or a sit aimed at a described spot (selector 2 of I5's list, E2 #2709): `None` for any other intent, else
/// the act a checker resolves the spot for on its copy, or the spot's refusal by name.
fn spot_of(intent: &Intent, id: u64, cause: Cause) -> Option<Result<Act, &'static str>> {
    let target @ Target::Selector(SPOT, _) = intent.target.as_ref()? else {
        return None;
    };
    let sit = match intent.verb.as_str().split_once(':') {
        Some((ns, "sit")) if ns != "souls" => true,
        Some((ns, "walk")) if ns != "souls" => false,
        _ => return None,
    };
    Some(Spot::read(target).map_err(|r| r.name).and_then(|spot| {
        Ok(Act {
            id,
            cause,
            actor: intent.actor,
            body: body_of(intent)?,
            candidates: Vec::new(),
            recheck: None,
            spot: Some(Box::new(SpotAct {
                sit,
                spot,
                resolved: None,
            })),
        })
    }))
}

/// Binds a resolved spot once, at commit (`sim::commit::spot`): a slot is sat in (or walked to), a thing or a point
/// is walked to, as N9's target in the frame of the node it stands in. Refused by the checker's name.
fn bind_spot(s: Box<SpotAct>, body: Id, actor: Actor) -> Result<Asked, String> {
    let r = s
        .resolved
        .ok_or("spot.unresolved")?
        .map_err(|r| r.name.to_owned())?;
    let ask = match (spot::once(&r), s.sit, r.answer) {
        (Bound::Slot { thing, .. }, true, _) | (_, true, Answered::Thing { thing, .. }) => {
            Ask::Sit { thing }
        }
        (Bound::Slot { thing, .. }, false, _) => Ask::Walk {
            node: thing,
            point: None,
        },
        (Bound::Stand(t), false, _) => Ask::Walk {
            node: t.node,
            point: Some(t.point()),
        },
        (Bound::Stand(_), true, _) => return Err("spot.not-a-slot".into()),
    };
    Ok(Asked { body, actor, ask })
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
            op: None,
        }
    }

    /// An edit's refusal: its name, and the operation that failed by its place in the batch.
    fn edit_refusal(&self, actor: Actor, sequence: u64, r: &Refused) -> Answer {
        Answer::Refused {
            actor,
            sequence,
            reason: name(r.name),
            now: self.version(),
            changed: Vec::new(),
            op: r.op.map(|o| o as u64),
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

    /// Seals the tree if the world changed since the last seal, and keeps the records the seal gave.
    fn seal(&mut self) {
        if !self.unsealed {
            return;
        }
        if let Ok(sealed) = self.replica.seal() {
            self.kept.keep(&sealed);
            if self.checkpoints.is_some() {
                self.fresh.extend(sealed.nodes);
            }
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
            records: &self.kept,
        };
        let mut a = sync::answer(&mut src, &[place], &m, now);
        a.insert(wire::ASK, n);
        encode(&Value::Map(a)).ok()
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
        let mut value = intent.to_value();
        let form = words::form(&intent);
        // A turn into an activity is its members' alone: refused before its words are kept when the speaker is not one.
        let mut members = BTreeSet::new();
        if let words::Form::Members(activity) = form {
            match body_of(&intent).and_then(|b| words::members(self.replica.tree(), activity, b)) {
                Ok(m) => members = m,
                Err(reason) => {
                    let a = self.refusal(actor, sequence, reason);
                    return self.answered(key, sequence, None, None, &a, (vec![reply], stamps));
                }
            }
        }
        let mut kept = Vec::new();
        if has_words(&value) {
            // The words go to the store and the intent is logged with their references (V1b); refused, it is logged
            // without its intent.
            let r = match body_of(&intent) {
                Ok(b) => words::keep(value, &self.text, words::audience(form, b), b, &mut kept)
                    .map_err(|r| r.name),
                Err(e) => Err(e),
            };
            value = match r {
                Ok(v) => v,
                Err(reason) => {
                    let a = self.refusal(actor, sequence, reason);
                    return self.answered(key, sequence, None, None, &a, (vec![reply], stamps));
                }
            };
        }
        if expired(intent.expiry, now) {
            let a = self.refusal(actor, sequence, "intent.expired");
            return self.answered(key, sequence, None, Some(value), &a, (vec![reply], stamps));
        }
        let Some(id) = Id::new(self.lineage, self.next_intent) else {
            let a = self.refusal(actor, sequence, "intent.ids-exhausted");
            return self.answered(key, sequence, None, Some(value), &a, (vec![reply], stamps));
        };
        // A say, a whisper or a describe writes its entry now and is answered after its tick's sync (V1b).
        if form != words::Form::Other {
            let entry = match body_of(&intent) {
                Ok(b) if self.replica.node(b).is_some() => {
                    let env = words::envelope(self.replica.version(), now, id, actor, b);
                    words::entry(form, &value, &kept, b, members, env)
                }
                Ok(_) => Some(Err("intent.no-body")),
                Err(e) => Some(Err(e)),
            };
            if let Some(entry) = entry {
                let reason = match entry {
                    Ok(e) => self.write(e).err().map(|r| r.name),
                    Err(r) => Some(r),
                };
                let a = match reason {
                    None => {
                        self.next_intent += 1;
                        Answer::Receipt {
                            actor,
                            sequence,
                            intent: id,
                            entries: self.receipts.entries(id).to_vec(),
                            names: BTreeMap::new(),
                        }
                    }
                    Some(r) => self.refusal(actor, sequence, r),
                };
                let id = matches!(a, Answer::Receipt { .. }).then_some(id);
                return self.answered(key, sequence, id, Some(value), &a, (vec![reply], stamps));
            }
        }
        // A move goes to the bodies when the world has them (I4b); anything else is a form's act.
        let moved = match self.bodies {
            Some(_) => body_of(&intent).ok().and_then(|b| bodies::read(&intent, b)),
            None => None,
        };
        let spotted = match self.bodies {
            Some(_) => spot_of(&intent, self.next_intent, Cause::Intent(id)),
            None => None,
        };
        let taken = match (spotted, moved, intent.kind()) {
            (Some(a), _, _) => a.map(Taken::Form),
            (None, Some(m), _) => m.map(Taken::Move),
            // An edit (G1b): checked off the clock thread, committed at a tick through `sim::edit`.
            (None, None, Ok(Kind::Edit)) => match (&self.edits, edit::wire::edit_of(&intent, id)) {
                (Some(_), Some(e)) => Ok(Taken::Edit(e)),
                (None, _) => Err("edit.not-the-creator"),
                (_, None) => Err("intent.not-an-edit"),
            },
            (None, None, _) => {
                act_of(&intent, self.next_intent, Cause::Intent(id)).map(Taken::Form)
            }
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
            // An edit drives no body: its deadline is kept under its actor.
            Taken::Edit(e) => match e.actor {
                Actor::Soul(a) | Actor::Creator(a) => a,
                Actor::World => self.zone,
            },
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
            Taken::Edit(e) => {
                if let Some(tx) = &self.edits
                    && tx.send((id, e)).is_ok()
                {
                    self.outstanding += 1;
                }
            }
        }
    }

    /// The tick's checked edits (G1b): each still open is committed through `sim::edit` on the live replica, as
    /// generic effects under its intent, and answered with a receipt carrying the map from names to ids; or refused
    /// whole, naming the failing operation. Placed nodes take their ids from the world's lineage, on the counter its
    /// intent ids use, so the two never meet.
    fn edits(&mut self, now: Micros) {
        for (id, checked) in std::mem::take(&mut self.edited) {
            let Some(o) = self.open.get(&id) else {
                continue;
            };
            let (actor, sequence) = (o.actor, o.sequence);
            if expired(o.expiry, now) {
                self.end(id, |c| c.refusal(actor, sequence, "intent.expired"));
                continue;
            }
            let committed = checked.and_then(|c| {
                let mut minter = Minter::at(self.lineage, self.next_intent);
                let done = sim::edit::commit(&mut self.replica, &mut minter, &c, &[], now);
                self.next_intent = minter.next();
                done
            });
            match committed {
                Ok(c) => {
                    self.unsealed = true;
                    self.receipts.index(&c.part.effects);
                    self.effects.extend(c.part.effects.iter().cloned());
                    self.parts.push(c.part);
                    self.end(id, |k| Answer::Receipt {
                        actor,
                        sequence,
                        intent: id,
                        entries: k.receipts.entries(id).to_vec(),
                        names: c.names,
                    });
                }
                Err(r) => self.end(id, |k| k.edit_refusal(actor, sequence, &r)),
            }
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
        if let Err(r) = self.write(effect) {
            eprintln!("worldd: a move's entry was not written: {r}");
        }
    }

    /// Applies one entry the world writes itself (a move's, or words', V1b), indexed for receipts and logged with the
    /// tick.
    fn write(&mut self, effect: Effect) -> R<()> {
        let changes = matches!(&effect.body, Body::Changes(c) if !c.is_empty());
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.replica.header().hash().to_bytes())),
            (2, Value::Array(vec![effect.to_value()])),
        ]));
        let p = encode(&v)
            .map_err(|e| Refusal {
                name: "encoding",
                detail: e.to_string(),
            })
            .and_then(|b| Part::read(&b))
            .and_then(|p| self.replica.apply(&p).map(|()| p))?;
        self.unsealed |= changes;
        self.receipts.index(&p.effects);
        self.effects.extend(p.effects.iter().cloned());
        self.parts.push(Arc::new(p));
        Ok(())
    }

    /// Writes the world's own entries (its utterances, its sky), each envelope's sequence set in turn, as one part
    /// applied to the world and logged with the tick. A part the world refuses is not written, and is named.
    fn write_own(&mut self, effects: Vec<Effect>, what: &str) {
        let first = self.replica.version();
        let effects: Vec<Value> = effects
            .into_iter()
            .zip(first..)
            .map(|(mut e, sequence)| {
                e.envelope.sequence = sequence;
                e.to_value()
            })
            .collect();
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.replica.header().hash().to_bytes())),
            (2, Value::Array(effects)),
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
                self.unsealed = true;
                self.effects.extend(p.effects.iter().cloned());
                self.parts.push(Arc::new(p));
            }
            Err(r) => eprintln!("worldd: {what} was not written: {r}"),
        }
    }

    /// An envelope of the world's own, at `at` on node `node` (its sequence is set when written).
    fn own(node: Id, at: Micros) -> Envelope {
        Envelope {
            sequence: 0,
            at,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node,
        }
    }

    /// One fire's two entries on the world node at `at` (E6): its changes with its event, then its old timer cleared
    /// and the next set; the next goes on the due list.
    fn put_sky(&mut self, at: Micros, w: Fire) {
        let Some(h) = self.sky.as_mut() else { return };
        let Ok(id) = h.mint.mint() else {
            eprintln!("worldd: the sky's timer ids are spent");
            return;
        };
        let world = h.daylight.world;
        let mut recs = Vec::new();
        if let Some(old) = h.timers.insert(w.timer.clone(), id) {
            recs.push(TimerRec::Clear { timer: old });
        }
        recs.push(TimerRec::Set {
            timer: id,
            due: w.next,
            name: w.timer.clone(),
        });
        let _ = h.due.set(Timer {
            node: world,
            id,
            due: w.next,
            name: w.timer,
        });
        let changes = Effect {
            envelope: Clock::own(world, at),
            body: Body::Changes(recs_of(w.changes)),
            events: w.event.map(|e| vec![e]),
            rest: Rest::new(),
        };
        let timers = Effect {
            envelope: Clock::own(world, at),
            body: Body::Timers(recs),
            events: None,
            rest: Rest::new(),
        };
        self.write_own(vec![changes, timers], "the sky");
    }

    /// Step 1 for the world node's sky (E6, #3369): a first start's settings and first light, date and weather at
    /// world time `now`; then each of its timers due before the next tick's start, fired at its due time against what
    /// the node announces then, in K9's order. Nothing runs between changes, so a world that catches up 48 hours
    /// writes what one stepped writes.
    fn fire_sky(&mut self, now: Micros) {
        let Some(h) = self.sky.as_mut() else { return };
        if std::mem::take(&mut h.first) {
            let world = h.daylight.world;
            let sets = h
                .daylight
                .cfg
                .fields()
                .into_iter()
                .map(|(field, to)| Change::Set {
                    node: world,
                    field,
                    to,
                    by: None,
                })
                .collect();
            let started = h.daylight.start(now);
            let settings = Effect {
                envelope: Clock::own(world, now),
                body: Body::Changes(recs_of(sets)),
                events: None,
                rest: Rest::new(),
            };
            self.write_own(vec![settings], "the sky's settings");
            match started {
                Ok(writes) => {
                    for w in writes {
                        self.put_sky(now, w);
                    }
                }
                Err(r) => eprintln!("worldd: the sky did not start: {r}"),
            }
        }
        let before = now + self.tick_us;
        loop {
            let Some(h) = self.sky.as_mut() else { return };
            let Some(t) = h.due.fire(before) else { return };
            let tree = self.replica.tree();
            let announced = tree.node(tree.root()).and_then(|n| Sky::read(n.fields()));
            let Some(announced) = announced else {
                eprintln!(
                    "worldd: the world node announces no sky; {} not fired",
                    t.name.as_str()
                );
                continue;
            };
            match h.daylight.fire(&t.name, t.due, &announced) {
                Ok(w) => self.put_sky(t.due, w),
                Err(r) => eprintln!("worldd: the sky's {} did not fire: {r}", t.name.as_str()),
            }
        }
    }

    /// Step 1 for loose things (F10b, #3476): each end due before the next tick's start, written at its due time.
    fn fire_loose(&mut self, now: Micros) {
        let before = now + self.tick_us;
        while let Some(e) = self.loose.next(self.replica.tree(), before) {
            self.write_own(vec![e], "a loose thing's end");
        }
    }

    /// After step 4 (F10b, #3476): each thing the tick's acts made loose gets its end, each made kept loses it.
    fn set_loose(&mut self, now: Micros) {
        if self.loose.idle() {
            return;
        }
        let mut nodes = Ends::touched(&self.effects);
        nodes.extend(self.unlinked.drain(..));
        let timers = self.loose.after(self.replica.tree(), nodes, now);
        if !timers.is_empty() {
            self.write_own(timers, "loose things' timers");
        }
    }

    /// Steps 1 to 3 for the bodies (I4b): their due timers, skills and controller, to world time `now`; each move that
    /// ended is answered: a receipt naming its entries when done, else its reason by name. Each utterance a step
    /// started is written with its hearers (B11, #3369): the speaker's entry, as `sim::speech::entry` makes it.
    fn step_bodies(&mut self, now: Micros) {
        let Some(b) = self.bodies.as_mut() else {
            return;
        };
        let ended = b.step(now);
        // Where the planner's answers came back late (K18b), for the recorder: a replay takes them at the same tick.
        for (at, taken) in b.late() {
            self.inputs.push(Input::Planned {
                at: u64::try_from(at).unwrap_or(0),
                taken,
            });
        }
        let heard = std::mem::take(&mut b.heard);
        for (speaker, said, at) in heard {
            let e = speech::entry(Clock::own(speaker, at), speaker, &said);
            self.write_own(vec![e], "an utterance");
        }
        for (id, how) in ended {
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
                    names: BTreeMap::new(),
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
        // 1. The world node's sky: its timers due in this tick, each at its due time (E6, #3369).
        self.fire_sky(now);
        // 1. Loose things' ends due in this tick, each at its due time (F10b, #3476).
        self.fire_loose(now);
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
            // A described spot is bound here, once; the move then starts with this tick's moves.
            if let Some(s) = act.spot.take() {
                match bind_spot(s, act.body, actor) {
                    Ok(asked) => self.moving.push((id, asked)),
                    Err(reason) => self.end(id, |c| c.refusal(actor, sequence, &reason)),
                }
                continue;
            }
            if !self.loose.idle() {
                let changes = checks.candidates.iter().flat_map(|c| &c.changes);
                let ends = Ends::unlinking(self.replica.tree(), changes);
                self.unlinked.extend(ends);
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
                        names: BTreeMap::new(),
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
        // 4b. Checked edits (G1b): committed through `sim::edit`, or refused whole.
        self.edits(now);
        self.start_moves(now);
        // 4. What the tick's acts made loose or kept: its timers, in the same tick (F10b, #3476).
        self.set_loose(now);
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
        if record.is_some() {
            self.unsealed = true;
        }
        at[6] = mark();
        // 6. The frozen copy, for the checkers and readers.
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
                bare: Vec::new(),
            });
        }
        self.records += written;
        self.since += bytes as u64;
        at[7] = mark();
        // 8. A slice of the auditor: faults named, nothing repaired, the clock never stopped.
        let slice = self.auditor.slice(self.replica.tree(), self.audit);
        for f in &slice.faults {
            eprintln!("worldd: audit: {f:?}");
        }
        self.faults += slice.faults.len() as u64;
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
        // One seal for both: what R5b's seals hashed since the last checkpoint, then what changed after.
        let taken = self.replica.seal().and_then(|mut sealed| {
            self.kept.keep(&sealed);
            self.unsealed = false;
            let mut nodes = std::mem::take(&mut self.fresh);
            nodes.append(&mut sealed.nodes);
            sealed.nodes = nodes;
            c.take_sealed(
                sealed,
                version,
                self.records,
                Some((at, &minter)),
                &carry.to_bytes(),
            )
        });
        if let Err(e) = taken {
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
            searched: self.bodies.as_ref().map_or(0, Bodies::searched),
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
    served: Option<crate::views::served::Feed>,
    mut follow: Option<Offer>,
) {
    for (k, t) in ticks.into_iter().enumerate() {
        let k = k as u64;
        if let Some(m) = &measures {
            m.queues[measures::LOG].enter(k, t.handed.unwrap_or_else(measures::steady_us));
        }
        let mut last = None;
        let mut appended = Vec::new();
        let mut durable_part = None;
        for (k, bytes) in [t.inputs, t.record].into_iter().enumerate() {
            let Some(bytes) = bytes else { continue };
            // Parts only (not the recorder's input records) go to the view tier and to what follows the world.
            let part = k == 1;
            let copy = (part && tier.is_some()).then(|| bytes.clone());
            let kept = (part && follow.is_some()).then(|| bytes.clone());
            let sent = synced.as_ref().map(|_| bytes.clone());
            if part && served.is_some() {
                durable_part = Some(bytes.clone());
            }
            match log.append(bytes) {
                Ok(n) => {
                    last = Some(n);
                    if let (Some(tier), Some(b)) = (&tier, copy) {
                        tier.offer(n, b);
                    }
                    if let (Some(f), Some(b)) = (follow.as_mut(), kept) {
                        f(n, b);
                    }
                    if let Some(b) = sent {
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
        if let (Some(v), Some(r)) = (&served, durable_part) {
            v.record(r);
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
        for (waiters, frame) in t.bare {
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
        // Nodes an edit placed took their ids on the intents' counter (G1b): never give one out again.
        for e in &part.effects {
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    if let Change::Create { node, .. } = c.change
                        && node.scope() == cfg.lineage
                    {
                        next_intent = next_intent.max(node.counter() + 1);
                    }
                }
            }
        }
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
    let tick = cfg.tick;
    let planner_wait = cfg.planner_wait;
    let planned_at: BTreeMap<Micros, u64> = std::mem::take(&mut cfg.planned)
        .into_iter()
        .map(|(at, n)| (i64::try_from(at).unwrap_or(i64::MAX), n))
        .collect();
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
    let loose = Ends::start(
        world.tree(),
        crate::loose::lives(&rules.kinds),
        zone,
        world.version(),
    )?;
    let publisher = Arc::new(Publisher::new(&world));
    let (events, rx) = channel();
    let edits = cfg
        .edits
        .take()
        .map(|w| edit_checker(w, Arc::clone(&publisher), events.clone()))
        .transpose()?;
    let (acts, checked) = checkers::start(cfg.checkers, Arc::clone(&publisher), Arc::new(rules));
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
    let text = match cfg.text.take() {
        Some(t) => t,
        None => Arc::new(crate::words::in_memory(cfg.lineage)?),
    };
    let follow = cfg.follow.take().map(|f| f(log.durable_mark()));
    let durable = log.durable_mark();
    let world_durable = log.durable_mark();
    let synced = cfg.synced.take();
    let (answers, ticks) = channel();
    let answer_tier = tier.clone();
    let answer_measures = measures.clone();
    let served = cfg.served.take();
    let answering = thread::Builder::new()
        .name("answers".into())
        .spawn(move || {
            answer_loop(
                log,
                ticks,
                answer_tier,
                answer_measures,
                synced,
                served,
                follow,
            )
        })
        .map_err(io)?;
    let sky = Heavens::of(&world, cfg.sky.take());
    let clock_measures = measures.clone();
    // R5b's first seal hashes every node: taken here, before the clock runs, so no tick waits on it (a big world's
    // whole tree, sealed at its first sync request, held the clock past K7's watchdog). Later seals hash what changed.
    let first = world.seal()?;
    let mut kept = Records::default();
    kept.keep(&first);
    let fresh = if cfg.checkpoints.is_some() {
        first.nodes
    } else {
        Vec::new()
    };
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
        roots: cfg.roots,
        kept,
        unsealed: false,
        fresh,
        checked: Vec::new(),
        replies: Vec::new(),
        rows: Vec::new(),
        effects: Vec::new(),
        parts: Vec::new(),
        bodies: None,
        moving: Vec::new(),
        edits,
        edited: Vec::new(),
        pending: Vec::new(),
        scheduled: BTreeMap::new(),
        inputs: Vec::new(),
        outstanding: 0,
        auditor: Auditor::new(),
        audit: cfg.audit,
        faults: 0,
        checkpoints,
        records,
        since: 0,
        durable,
        tick: last.unwrap_or(-1),
        measures: clock_measures,
        sky,
        tick_us,
        text,
        loose,
        unlinked: Vec::new(),
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
                        // A free-running clock waits at most a tenth of a tick for each planner batch (K18b); a
                        // replay takes the batches where the recorder says the live run took them.
                        if !lockstep {
                            b.wait = Some(planner_wait.unwrap_or(tick / 10));
                        }
                        b.schedule = planned_at;
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
                        // A sync request (R5b) is answered at once, behind every tick already handed to the
                        // answers thread; it is not an intent and never reaches the recorder.
                        if let Some(f) = c.sync(&bytes) {
                            let _ = c.answers.send(Tick {
                                inputs: None,
                                record: None,
                                replies: Vec::new(),
                                started: None,
                                handed: None,
                                bare: vec![(vec![reply], f)],
                            });
                        } else {
                            c.pending.push((bytes, reply, stamps))
                        }
                    }
                    Event::ArrivalAt { tick, bytes, reply } => {
                        c.scheduled.entry(tick).or_default().push((bytes, reply))
                    }
                    Event::Checked(k) => {
                        let (act, checks) = *k;
                        c.checks_back(act, checks);
                    }
                    Event::Edited(k) => {
                        c.outstanding = c.outstanding.saturating_sub(1);
                        c.edited.push(*k);
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

/// The edit checker's thread (G1b): each edit is checked (`replica::edit::check`) and planned (`sim::edit::plan`, G2's
/// safety guard) on the newest frozen copy that stands at the version it was planned against, or after a second
/// whatever it stands at, never on the live tree. The toggles world has no open ground (`None`); its commit is judged
/// against no Soul's body yet (G1b leaves the bodies' list to a later task).
fn edit_checker(
    world: edit::World,
    publisher: Arc<Publisher>,
    events: Sender<Event>,
) -> R<Sender<(Id, Edit)>> {
    let (tx, rx) = channel::<(Id, Edit)>();
    thread::Builder::new()
        .name("edit-check".into())
        .spawn(move || {
            for (id, e) in rx {
                let copy = publisher.wait_for(e.planned, Duration::from_secs(1));
                let checked =
                    edit::check(e, &copy, &world).and_then(|c| sim::edit::plan(c, &copy, None));
                if events.send(Event::Edited(Box::new((id, checked)))).is_err() {
                    break;
                }
            }
        })
        .map_err(io)?;
    Ok(tx)
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

    /// The answer on `rx`. The deadline only stops a hung test: a loaded runner can take seconds per tick.
    fn answer(rx: &Receiver<Vec<u8>>) -> Vec<u8> {
        rx.recv_timeout(Duration::from_secs(30)).expect("an answer")
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
        // Kept in K16's store and logged by reference (V1b, #3361): the act goes on as any other.
        assert_eq!(read(&answer(&send(&w, &i))).0, 1);
        w.stop();
        let log = store.bytes();
        let records = recover(&log).unwrap().records;
        let refs: Vec<_> = records
            .iter()
            .flat_map(|r| replica::audience::references(&decode(r).unwrap().value))
            .collect();
        assert!(!refs.is_empty(), "the intent is logged with its reference");
        assert!(
            !log.windows(words.len()).any(|b| b == words.as_bytes()),
            "none of the words' bytes are in the log"
        );
    }

    fn ask(w: &World, m: BTreeMap<u64, Value>) -> BTreeMap<u64, Value> {
        let (reply, rx) = channel();
        let bytes = encode(&Value::Map(m)).unwrap();
        assert!(w.door().arrive(bytes, reply));
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

    // --- G1b (#3362): edits on K18's loop. -----------------------------------------------------------------------

    /// The log of a creator placing a thing in the room and removing it, and a Soul's refused edit, in lockstep: each
    /// edit taken at one tick and committed at the next (its check back in between). The answers' kinds, in order.
    fn edits_log() -> (Vec<u8>, Vec<u64>) {
        use replica::edit::wire::{VERB, parameters};
        use replica::edit::{Op, Ref, Spot};
        use replica::pose::{Quat, Support, Vec3};
        let store = Held::new(Vec::new());
        let w = toggles::World::build(1, 0, 0);
        let tree = w.replica.tree();
        let room = tree
            .children(tree.root())
            .and_then(|c| c.first())
            .and_then(|h| tree.node(*h))
            .map(|n| n.id())
            .expect("a room");
        let kinds = toggles::kinds();
        let item = kinds
            .keys()
            .find(|k| k.starts_with("souls:item@"))
            .map(|k| Name::new(k).unwrap())
            .unwrap();
        let creator = Id::new(Scope([0xc0; 16]), 1).unwrap();
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.lockstep = true;
        cfg.measures = false;
        cfg.edits = Some(edit::World { creator, kinds });
        let world = start(w.replica, toggles::rules(), store.clone(), cfg).unwrap();
        let intent = |actor: Actor, sequence: u64, planned: u64, op: Op| Intent {
            actor,
            verb: Name::new(VERB).unwrap(),
            target: None,
            parameters: parameters(&[op]),
            sequence,
            basis: Version {
                lineage: LINEAGE,
                zone: Id::new(LINEAGE, 0).unwrap(),
                epoch: 1,
                sequence: planned,
            }
            .to_value(),
            expiry: i64::MAX,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
        };
        let place = Op::Place {
            name: 1,
            kind: item,
            parent: Ref::Node(room),
            at: Spot {
                slot: None,
                position: Vec3::new(1_000_000, 0, 0),
                orientation: Quat::IDENTITY,
                support: Support::None,
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        let mut kinds_seen = Vec::new();
        let mut run = |i: Intent, tick: i64| {
            let rx = send(&world, &i);
            let (done, ran) = channel();
            world.events.send(Event::RunTo { tick, done }).unwrap();
            ran.recv().unwrap();
            let f = answer(&rx);
            kinds_seen.push(read(&f).0);
            f
        };
        let placed = run(intent(Actor::Creator(creator), 1, 0, place.clone()), 2);
        let Value::Map(m) = decode(&placed).unwrap().value else {
            panic!("a frame")
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            panic!("an answer")
        };
        let Some(Value::Map(names)) = a.get(&6) else {
            panic!("the receipt's names: {a:?}")
        };
        let thing = replica::effects::read_id(&names[&1]).unwrap();
        let remove = Op::Remove {
            node: Ref::Node(thing),
        };
        // Planned against the version the place's answer gave.
        let Some(Value::Array(v)) = m.get(&1) else {
            panic!("a version")
        };
        let Some(Value::Uint(planned)) = v.get(3) else {
            panic!("a sequence")
        };
        run(intent(Actor::Creator(creator), 2, *planned, remove), 4);
        let soul = Actor::Soul(Id::new(Scope([0xdd; 16]), 1).unwrap());
        run(intent(soul, 1, 0, place), 6);
        world.stop();
        (store.bytes(), kinds_seen)
    }

    #[test]
    fn g1b_edits_are_recorded_and_a_lockstep_run_logs_the_same_bytes() {
        let (a, kinds) = edits_log();
        let (b, _) = edits_log();
        assert_eq!(kinds, [1, 1, 2], "place, remove, a Soul's refused edit");
        let records = recover(&a).unwrap().records;
        let verbs: Vec<String> = recorder::inputs(&records)
            .unwrap()
            .into_iter()
            .flat_map(|(_, i)| i)
            .filter_map(|i| match i {
                Input::Intent { verb, .. } => Some(verb.as_str().to_owned()),
                _ => None,
            })
            .collect();
        println!("recorded inputs: {verbs:?}; log {} bytes", a.len());
        assert_eq!(
            verbs, ["souls:edit"; 3],
            "every edit is one of the recorder's inputs"
        );
        assert_eq!(
            replica::ids::sha256(&a),
            replica::ids::sha256(&b),
            "the same edits at the same ticks write the same log"
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

    /// `"written":n` in a health file: which write of the file it is.
    fn written(health: &str) -> u64 {
        let at = health.find("\"written\":").expect("written") + 10;
        health[at..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap()
    }

    /// Reads the health file at `path` until `done` holds for it. The deadline only stops a hung test: the health
    /// thread and this one may be starved for seconds on a loaded runner, so no bound here is a measure.
    fn health_until(
        path: &std::path::Path,
        what: &str,
        mut done: impl FnMut(&str) -> bool,
    ) -> String {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let h = std::fs::read_to_string(path).unwrap_or_default();
            if !h.is_empty() && done(&h) {
                return h;
            }
            assert!(Instant::now() < deadline, "{what} within 30 s: {h}");
            thread::sleep(Duration::from_millis(20));
        }
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
        // A2: each tick's phases against the budget, and every queue's oldest item, in the first write after the 20
        // answers (the file is written every 2 s; on a loaded runner, later).
        let h = health_until(&path, "a write after the 20 answers", |h| {
            measures::PARTS
                .iter()
                .all(|p| h.contains(&format!("\"{p}\":{{\"count\":20,")))
        });
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

        // A4: the clock thread held for 12 s; the health file keeps coming every 2 s, its arrival waiting and ageing.
        // Stuck is read from the file itself (the arrival still queued: only the clock thread takes it) and the
        // writes are counted by its own `written`, so a starved reader misses none of them and sees no false gap.
        world
            .events
            .send(Event::Stall(Duration::from_secs(12)))
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        let rx = send(&world, &toggle(pairs[1].0, pairs[1].1, 1, later));
        // (write, arrivals oldest µs) of each health file read while the arrival waits.
        let mut seen: Vec<(u64, u64)> = Vec::new();
        health_until(
            &path,
            "the arrival taken once the clock thread is back",
            |h| {
                let (items, oldest) = queue(h, "arrivals");
                if items == 0 {
                    return !seen.is_empty();
                }
                if seen.last().is_none_or(|s| s.0 != written(h)) {
                    seen.push((written(h), oldest));
                }
                false
            },
        );
        eprintln!(
            "o4 a4: health.json writes while the clock thread is held (write, arrivals oldest µs): {seen:?}"
        );
        let (first, last) = (seen[0], seen[seen.len() - 1]);
        assert!(
            last.0 - first.0 >= 2,
            "written at least three times while stuck: {seen:?}"
        );
        let every = u64::try_from(measures::EVERY.as_micros()).unwrap();
        for pair in seen.windows(2) {
            assert!(
                pair[1].1 >= pair[0].1 + (pair[1].0 - pair[0].0) * every,
                "every 2 s, the arrival older each time: {seen:?}"
            );
        }
        assert!(last.1 >= 4_000_000, "{seen:?}");
        assert_eq!(
            read(&answer(&rx)).0,
            1,
            "answered once the clock thread is back"
        );
        world.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
