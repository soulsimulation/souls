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
//! how) and is answered: a receipt naming its entries when done, else a refusal naming how it ended
//! (`claim-taken`, `resource-held`, `out-of-reach`, ...). A gateway walk (C29) gets its planned route's time at walking
//! speed, plus a margin and crossings, with no total cap and never beyond the intent's expiry. Its deadline is written
//! as C20's entry and it receives C20's one progress answer if still going at 10 s. C21's watch ends a stalled walk
//! `walk.blocked`; waiting at a link and being carried do not count as stalled walking.
//! No move outlives its act: a walk still going at its act's deadline stops in that tick and ends `act.timed-out`; a
//! sit, a lie or a rise runs to its end (a seat is never left half taken) and ends so then; a walk a new move
//! replaces ends `claim-taken` in the tick the new move starts.
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
//! **Joins and leaves** (C3, #3367; K10's one path, `sim::life`), when [`Config::join`] is given: a Soul's first
//! intent asks its body's birth and waits for it. At the start of a coming tick (K10's budget a tick) the body is born
//! by its entry: a `souls:body` node on the ground at a standing place, linked `souls:body-of` to its Soul, and the
//! controller's. A first intent of verb [`JOIN`] carries the body's name and description as words (parameters 1 and
//! 2, kept as a describe's) and the node is created with their references ([`words::NAME`], [`words::DESCRIPTION`]);
//! the join is answered with the birth's entry. Any other first intent is taken once the body is born. [`LEAVE`]
//! retires the body by K10's path: its seat freed, its timers and run ended, its link ended and its node removed.
//! After a restart a Soul's body is found again by its `souls:body-of` link.
//!
//! **The directory's word** (W11b, #3511; [`crate::directory`]): [`Event::Directory`] hands the world the directory's
//! Souls file. At the next tick, after its births, each Soul it names that has a body here is brought in line with it
//! by an intent of its own: a retired Soul's [`LEAVE`], a Soul whose saved words differ from its body's a
//! [`DESCRIBE`]. They go the way any intent goes, under a key of their own ([`notice_key`]) so they never take a
//! sequence of the Soul's agent, and are answered on the event's reply. A retired Soul is never born again: its intent
//! is refused `soul-retired`.
//!
//! **Sync by hash** (R5b, #3164): a frame with key 20 is R5's sync request (`replica::sync::wire`), not an intent.
//! The [`Door`] hands it to the sync thread (`crate::syncs`, C16 #3450), never to the clock thread: it answers from
//! its own sealed copy of the zone, which takes each tick's parts from the answers thread once they are on the disk,
//! so a client compares and descends over the place, which every actor is granted. An answer never shows a change
//! before the change is on the disk, never waits for a tick, and never delays one.
//!
//! **The world's tick** (K18, #3160). One loop per zone, run by K7's ticker at the clock's rate (one tick each
//! [`Config::tick`]; world time starts as real time in µs from the Unix epoch, rate one, and [`Config::rate`] may
//! apply another at a start, published on the zone root). Each tick, in the trunk's order
//! (T1: everything reads the state as of the tick's start, and what a tick writes is seen from the next):
//!
//! 0. the intents that arrived since the last tick are taken (the recorder's inputs, K12);
//! 1. due timers: acts whose deadline passed end `act.timed-out` (K9's due list); at a start's first tick, the
//!    mapping it applies, as its time effect and the zone root's fields (E7b, #3516); the world node's light, day and
//!    weather timers due before the next tick fire at their due times and write their entries (E6, #3369; a first
//!    start writes [`Config::sky`] when the node holds no settings); loose things' ends due fire likewise (F10b,
//!    [`crate::loose`]); a move's phase timers fire;
//! 2. skills step through the host, each one unit in K11's wrapper (K13a, T9b/T9c; a panic ends that skill only);
//! 3. the controller steps the bodies (B1), moves and seats included (B2, B3); each utterance a step started is
//!    written with its hearers (`sim::speech::heard`, B11, #3369); each body's motion is written on its node, world-caused,
//!    at each hand-off and every 200 ms while it moves ([`crate::bodies::Bodies::motion`], #3799);
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
//! every check, and for the checkers' copy to stand at the live version, before a tick, so a run fed the same inputs
//! at the same ticks writes the same log: how K12's replay is checked on the real loop.
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

use crate::acts::{self, Acts};
use crate::bodies::{self, Ask, Asked, Bodies, Cut, Placed};
use crate::buildsafe;
use crate::checkers::{self, Act, Candidate, Rules, SpotAct};
use crate::directory::Directory;
use crate::engine::{self, Engine};
use crate::loose::Ends;
use crate::measures::{self, Measures, Stamps};
use crate::syncs::{self, ToSync};
use crate::views::Tier;
use crate::words;
use replica::apply::Replica;
use replica::bodies::Family;
use replica::edit::{self, Edit, Refused};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event as Named, Part, Refusal, Rest,
    TimerRec, TransferRec,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope, Version};
use replica::intents::{Answer, BULK_MOST, Intent, Kind, Target};
use replica::pose::Pose;
use replica::pose::{Frame, Quat, Support, Vec3};
use replica::select::Answer as Answered;
use replica::select::Spot;
use replica::select::wire::SPOT;
use replica::sky::{self, Sky};
use replica::sync::Records;
use replica::time::{Mapping, Micros, Tempo, TickRate, TimeEffect, Timeline};
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
use sim::edit::safety::{Known, Who};
use sim::frozen::Publisher;
use sim::life::{Birth, Life, Ring};
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

/// The entries of `samples` (#3799), numbered from `first`: per body, its leave and its arrive at its new parent when
/// its frame changed (the transfer named from the leave's own number, which a zone gives once), then its sample.
fn motion_effects(
    header: &replica::effects::Header,
    first: u64,
    samples: &[bodies::Sample],
) -> Vec<Effect> {
    let h = replica::ids::sha256(
        format!(
            "souls/worldd/motion/{}",
            replica::world_model::show(header.zone)
        )
        .as_bytes(),
    );
    let mut scope = [0u8; 16];
    scope.copy_from_slice(&h[..16]);
    let entry = |node: Id, s: &bodies::Sample, body: Body| Effect {
        envelope: Envelope {
            sequence: 0,
            at: s.handoff.at,
            cause: Cause::World,
            actor: Actor::World,
            audience: s.audience,
            node,
        },
        body,
        events: None,
        rest: Rest::new(),
    };
    let mut out = Vec::new();
    for s in samples {
        let node = s.handoff.node;
        if let Some(pose) = s.to
            && let Some(transfer) = Id::new(Scope(scope), first + out.len() as u64)
        {
            out.push(entry(
                node,
                s,
                Body::Transfer(TransferRec::Leave {
                    transfer,
                    node,
                    lineage: header.lineage,
                    zone: header.zone,
                    pose,
                }),
            ));
            out.push(entry(
                pose.frame.node,
                s,
                Body::Transfer(TransferRec::Arrive {
                    transfer,
                    carried: Vec::new(),
                }),
            ));
        }
        // A sample at rest (a stop, a seat taken, a still body set somewhere new) leaves the node still where it is: the
        // same frame and pose again as a reparent, so the tree holds it as a still node's place (its record's pose, R5)
        // and not as a motion that never ends.
        let mut changes = vec![ChangeRec {
            change: Change::Motion(s.handoff),
            rest: Rest::new(),
        }];
        if s.handoff.linear == Vec3::ZERO {
            changes.push(ChangeRec {
                change: Change::Reparent {
                    node,
                    from: s.handoff.pose.frame,
                    pose: s.handoff.pose,
                },
                rest: Rest::new(),
            });
        }
        out.push(entry(node, s, Body::Changes(changes)));
    }
    out
}

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
pub type MakeBuiltBodies =
    Box<dyn FnOnce(&Placed, &BTreeMap<Id, replica::kinds::sizes::Build>) -> R<Bodies> + Send>;

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
    /// Lockstep: run every tick up to and including `tick`, then report the zone's state on `done`, once every tick
    /// run is on the disk and in the sync copy, as a receipt is (so a sync asked after it sees the run's changes).
    RunTo {
        tick: i64,
        done: Sender<Ran>,
    },
    Checked(Box<(Act, Checks)>),
    /// An edit checked off the clock thread on a frozen copy (G1b): to commit at the next tick with the Souls' bodies
    /// read from that copy (G1c), or its refusal.
    Edited(Box<(Id, Result<Checked, Refused>)>),
    Worn(Box<(WearRequest, R<sim::mover::Body>)>),
    /// A set-down checked off the clock thread by the edit checker's thread (E4's caller, #3604), with the walkers'
    /// maps prepared from its part when it changes what walkers go round, or its refusal.
    SetDown(Box<(Id, R<SetDownChecked>)>),
    /// The directory's Souls file as it now reads, and where the answers to the intents it causes go (W11b).
    Directory(Box<(Directory, Reply)>),
    /// A gateway connection that is told each Soul's wind-down word (#3784): now, all of them, then each change.
    States(Reply),
    /// Holds the clock thread for this long: the stuck-thread run (O4 A4).
    Stall(Duration),
    Stop,
}

/// Where intents enter the world: stamps each as it is read, when measures are on (O4).
#[derive(Clone)]
pub struct Door {
    pub events: Sender<Event>,
    pub measures: Option<Arc<Measures>>,
    syncs: Sender<ToSync>,
}

impl Door {
    /// Hands an intent's bytes to the clock thread, and a sync request's to the sync thread (C16); false once the
    /// world has stopped.
    pub fn arrive(&self, bytes: Vec<u8>, reply: Reply) -> bool {
        if let Some(ask) = syncs::ask_of(&bytes) {
            return self.syncs.send(ToSync::Ask(ask, reply)).is_ok();
        }
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

/// How long a lockstep tick waits for the checkers' copy to stand at the live version: only a bound on a publisher
/// that refused a part; a loaded machine catches up well within it.
const PUBLISHED_WAIT: Duration = Duration::from_secs(60);
/// How long the edit checker waits for an edit before it builds its town again, when an edit has committed since.
const EDIT_IDLE: Duration = Duration::from_millis(100);

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
    orders: Vec<Value>,
}

impl Carry {
    fn of(
        sequences: &Sequences,
        next_intent: u64,
        placed: Placed,
        tick: i64,
        orders: &[Effect],
    ) -> Carry {
        Carry {
            sequences: sequences
                .kept()
                .map(|(a, last, kept)| (a.to_vec(), last, kept.cloned().collect()))
                .collect(),
            next_intent,
            placed,
            tick,
            orders: orders.iter().map(Effect::to_value).collect(),
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
        if !self.orders.is_empty() {
            m.insert(5, Value::Array(self.orders.clone()));
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
        if let Some(Value::Array(rows)) = m.get(&5) {
            c.orders = rows.clone();
        }
        Some(c)
    }
}

/// Keep only active order starts in original arrival order, including across checkpoint/tail overlap.
fn remember_orders(active: &mut Vec<Effect>, effects: &[Effect]) {
    for e in effects {
        for ev in e.events.iter().flatten() {
            let Some(id) = ev.fields.get(&1) else {
                continue;
            };
            if ev.name.as_str() == "souls:order-ended" {
                active.retain(|e| {
                    !e.events
                        .iter()
                        .flatten()
                        .any(|ev| ev.fields.get(&1) == Some(id))
                });
            } else if ev.name.as_str() == "souls:order"
                && !active.iter().any(|e| {
                    e.events
                        .iter()
                        .flatten()
                        .any(|ev| ev.fields.get(&1) == Some(id))
                })
            {
                active.push(e.clone());
            }
        }
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
    /// `<actor hex> <sequence>` appended for each fresh intent, in the order taken (I1's restart bench); ` reflex`
    /// follows when the Soul's client sent it on its own (#3764).
    pub arrivals: Option<File>,
    /// Makes the world's bodies, on the clock thread, for move intents (I4b, #3156); without them a move is refused
    /// `intent.not-a-form-on-a-node`.
    pub bodies: Option<MakeBodies>,
    pub built_bodies: Option<MakeBuiltBodies>,
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
    /// The world's one creator as its directory record names it (G1e, #3532), read again on a change: in place of
    /// `edits`'s creator, and while it names none every edit is refused `edit.not-the-creator`.
    pub creator: Option<Arc<buildsafe::Creator>>,
    /// The day, night and weather (E6) a start writes on the world node when it holds none; a world node that holds
    /// its settings keeps them. `None`: a world without settings has no sky.
    pub sky: Option<daylight::Config>,
    /// The view subscriptions' tier (#3292), handed each tick's part once it is on the disk.
    pub served: Option<crate::views::served::Feed>,
    /// K16's text store, where an intent's words are kept (V1b); a store in memory when none is given.
    pub text: Option<Arc<Store>>,
    /// Immutable imported public name bytes, attached only to delivered public record references off the clock.
    pub public_names: Arc<crate::views::names::PublicNames>,
    /// The closed kinds of the world's entries: what one holds stays out of other Souls' sync answers (#3915).
    pub closed: crate::closed::Closed,
    /// Called once at start with the log's durable mark; what it gives is handed each part record as it is appended
    /// (its number and bytes): a view tier's `offer`, so a stream writer follows the world (V1b).
    pub follow: Option<Follow>,
    /// Each log record once it is on the disk, input records included, in order (C1, #3365): `worldd serve`'s own
    /// view tier and shipper read them here, off the clock thread.
    pub synced: Option<Sender<Synced>>,
    /// The clock's rate, world µs per real µs as `(num, den)` (E7b, #3516). With one, the mapping in force is
    /// published on the zone root ([`replica::time::F_CLOCK_WORLD`]) with its time effect, at the first tick of each
    /// start that applies a mapping: a first start's (world time is real time), or a new one when the rate differs
    /// from the last logged, continuous with it. `None`: world time is real time and nothing is published.
    pub rate: Option<(i64, i64)>,
    /// How long a free-running tick waits for each of the bodies' planner batches (K18b); `None` is a tenth of a tick.
    pub planner_wait: Option<Duration>,
    /// A replay's planner batches (K18b): the recorder's `Planned` inputs, body time µs and batches taken there.
    pub planned: BTreeMap<u64, u64>,
    /// The world's rules and its activity kinds, for the engine's own acts (C2: activities, offers, carrying);
    /// without them those acts are refused `engine-acts-off`.
    pub engine: Option<(replica::tree::Rules, Vec<replica::activity::ActivityKind>)>,
    /// Joins and leaves (C3, #3367): a Soul's first intent births its body here; none, the Souls' bodies are the
    /// ones [`Config::bodies`] makes.
    pub join: Option<Join>,
    /// Existing B15 recorded body catalogue and birth choices.
    pub wear: Option<Wearing>,
    /// The code hatches' modules the world ships (`<world>/hatches/*.wasm`, #3713): its forms' hatches run in them.
    pub hatches: Vec<Vec<u8>>,
}

#[derive(Clone)]
pub struct Wearing {
    pub catalogue: skills::wear::Catalogue,
    pub born: BTreeMap<Id, [u8; 32]>,
}

/// Where and how Souls' bodies are born (C3, #3367).
pub struct Join {
    /// The node bodies stand on (the open ground) and the entry's point there, µm: births ring round it.
    pub entry: (Id, Vec3),
    /// The body's family (its resources: legs, hands).
    pub family: Family,
    /// The body node's kind, by its full name as the world's header pins it.
    pub kind: Name,
    /// Births taken a tick, at most (K10's budget).
    pub per_tick: usize,
}

/// A Soul's join (C3): its first intent, whose words name its body.
pub const JOIN: &str = "life:join";
/// A Soul's leave (C3): its body retired.
pub const LEAVE: &str = "life:leave";
/// A Soul's saved words given to its body (W11b): a describe (V1b), its name parameter 1, its description 2.
pub const DESCRIBE: &str = "life:describe";

/// The key the directory's intents for `soul` are numbered under (W11b): not its agent's, so they never take one of
/// its sequences.
pub fn notice_key(soul: Id) -> Vec<u8> {
    let mut k = b"directory:".to_vec();
    k.extend(encode(&soul.to_value()).unwrap_or_default());
    k
}
/// The link from a body to its Soul (K10).
const BODY_OF: &str = "souls:body-of";

/// The births and the intents waiting for them (C3).
struct Lives {
    life: Life,
    ring: Ring,
    entry: Id,
    family: Family,
    kind: Name,
    /// The ids of a leave's set-downs (their transfers).
    mint: Minter,
    /// Intents of Souls whose body is not born yet, by Soul, in the order they came.
    unborn: Vec<(Id, Vec<u8>, Reply, Stamps)>,
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
            built_bodies: None,
            clock: None,
            lockstep: false,
            checkpoints: None,
            views: false,
            audit: 64,
            roots: None,
            measures: true,
            health: None,
            edits: None,
            creator: None,
            synced: None,
            planner_wait: None,
            planned: BTreeMap::new(),
            sky: None,
            served: None,
            text: None,
            public_names: Arc::new(Default::default()),
            closed: Default::default(),
            follow: None,
            rate: None,
            engine: None,
            join: None,
            wear: None,
            hatches: Vec::new(),
        }
    }
}

/// The running world: send it [`Event`]s; [`World::stop`] ends it once the answers already due are sent.
pub struct World {
    pub events: Sender<Event>,
    /// Where sync requests go (C16): the sync thread, not the clock.
    syncs: Sender<ToSync>,
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
            syncs: self.syncs.clone(),
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
    /// Its deadline at its arrival, world time.
    due: Micros,
    /// A form or gateway walk: its own deadline, from its start (C20/C29).
    run_due: Option<Micros>,
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
    /// The tick's parts, handed to the sync thread once its records are on the disk (C16).
    parts: Vec<Arc<Part>>,
    /// Answers sent as they are, with no block: a form act's progress (C20).
    bare: Vec<(Vec<Reply>, Vec<u8>)>,
    /// A lockstep run's report, sent after every tick before it is on the disk and in the sync copy.
    ran: Option<(Sender<Ran>, Ran)>,
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
    /// Whether the world changed since the last seal (the roots file's and the checkpoints').
    unsealed: bool,
    /// The nodes the roots file's seals hashed since the last checkpoint: the next checkpoint writes them too, as its
    /// own seal finds only what changed after them.
    fresh: Vec<(Hash, Vec<u8>)>,
    checked: Vec<(Act, Checks)>,
    replies: Vec<Out>,
    /// Progress answers (C20), by act: sent after the tick's sync with its answers, as they are, never kept or logged;
    /// one whose act ends in the same tick is dropped, as its answer says more.
    progress: Vec<(Id, Vec<Reply>, Vec<u8>)>,
    rows: Vec<Value>,
    effects: Vec<Effect>,
    parts: Vec<Arc<Part>>,
    bodies: Option<Bodies>,
    /// Move intents taken since the last tick, committed at the next (I4b).
    moving: Vec<(Id, Asked)>,
    /// Gateway walks with route deadlines and the shared C21 stall watch (C29).
    walks: BTreeMap<Id, acts::Walk>,
    /// Acts whose deadline passed while their sit, lie or rise was going: each ends `act.timed-out` when its move
    /// ends, so no move outlives its act.
    overdue: BTreeSet<Id>,
    /// Where edits and set-downs go to be checked off the clock thread (G1b, #3604): with the world's edits, its
    /// wear or its engine; and whether it takes edits.
    edits: Option<Sender<CheckJob>>,
    editing: bool,
    /// Set-downs checked since the last tick, committed (or refused) at the next (#3604).
    set_down: Vec<(Id, R<SetDownChecked>)>,
    /// Edits checked since the last tick, committed (or refused) at the next.
    edited: Vec<(Id, Result<Checked, Refused>)>,
    /// Where the edit checker reads the bodies the controller holds, handed off each tick (G1d).
    walkers: Option<Arc<buildsafe::Moving>>,
    /// Soul Actions (C2, #3366): the forms in progress, and the form acts taken since the last tick, committed at
    /// the next through the form runner when the world has bodies.
    forms: Acts,
    forming: Vec<(Id, Act, sim::forms::Intent, acts::Args)>,
    /// The engine's own acts (C2): joint activities, offers, carrying; and those taken since the last tick.
    engine: Option<Engine>,
    engine_acts: Vec<engine::Act>,
    /// Engine acts written this tick, answered with a receipt once their entries are applied.
    engine_done: Vec<Id>,
    order_records: Vec<Effect>,
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
    /// The mappings this start applies and the one in force, written at its first tick (E7b, [`Config::rate`]).
    clock: Option<Publish>,
    /// Joins and leaves (C3), when the world births its Souls' bodies.
    life: Option<Lives>,
    wear: Option<Wearing>,
    birth_builds: BTreeMap<Id, replica::kinds::sizes::Build>,
    worn: Vec<(WearRequest, R<sim::mover::Body>)>,
    /// The directory's word (W11b): its file as last read and where its answers go, and the Souls to bring in line
    /// with it at the next tick.
    directory: Option<(Directory, Reply)>,
    told: BTreeSet<Id>,
    /// #3784: the gateway connections told of the Souls' wind-down words, and the words they were last told (an
    /// embodied Soul that is idle, a zombie or asleep; none is awake).
    states_to: Vec<Reply>,
    states: BTreeMap<Id, &'static str>,
    /// Loose things' ends (F10b, #3476), and the ends of owner's links the tick's acts ended.
    loose: Ends,
    unlinked: Vec<Id>,
}

enum CheckJob {
    Edit(Id, Edit, Minter),
    /// A Soul's set-down (#3604).
    SetDown(crate::setdown::Ask),
    Wear(Box<WearRequest>),
    /// B12b: the same checked edit back, an affected body having walked out of its prepared triangle; placed again
    /// on its kept surfaces as the bodies stand now, nothing else prepared again.
    Reprepare(Box<(Id, Checked, Vec<sim::controller::BuildBasis>)>),
    /// B12b: kept surfaces the clock is done with, dropped here rather than on the clock.
    Release(Vec<sim::walk::town::RebindSurfaces>),
}

#[derive(Clone, PartialEq)]
struct WearRecord {
    kind: Name,
    parent: Option<Id>,
    slot: Option<u64>,
    audience: Audience,
    fields: BTreeMap<u64, Value>,
}
fn wear_record(copy: &Replica, body: Id) -> Result<WearRecord, &'static str> {
    let n = copy
        .tree()
        .handle(body)
        .and_then(|h| copy.tree().node(h))
        .ok_or("intent.no-body")?;
    Ok(WearRecord {
        kind: n.kind().clone(),
        parent: n.parent(),
        slot: n.slot(),
        audience: n.audience(),
        fields: n.fields().clone(),
    })
}
pub struct WearRequest {
    id: Id,
    version: u64,
    ground: Id,
    map: Arc<sim::ground::Versions>,
    surfaces: sim::walk::town::Basis,
    basis: sim::controller::BuildBasis,
    record: WearRecord,
    preset: skills::wear::Preset,
}
impl WearRequest {
    fn check(&self, copy: &Replica) -> R<sim::mover::Body> {
        let error = |name| Refusal {
            name,
            detail: "body change basis".into(),
        };
        if copy.version() < self.version
            || wear_record(copy, self.basis.moved.id).map_err(error)? != self.record
        {
            return Err(error("body-change-stale"));
        }
        let mut old = self.basis.build;
        sim::ground::sizes::change_size(
            copy.tree(),
            self.ground,
            self.basis.moved.pose.frame.node,
            self.basis.moved.id,
            self.basis.moved.pose.position,
            &mut old,
            self.preset.build.size,
        )?;
        let surface = self.surfaces.surface(
            self.preset.build.size,
            self.basis.moved.pose.frame.node,
            self.ground,
        )?;
        let mut moved = surface.place_built(
            self.basis.moved.id,
            self.basis.moved.pose.frame,
            self.basis.moved.pose.position,
            self.basis.moved.pose.orientation,
            self.preset.build,
        )?;
        moved.linear = self.basis.moved.linear;
        Ok(moved)
    }
}

/// An edit planned off the clock, and the Souls' bodies its commit is judged against (G2's rule, G1c).
type Checked = (
    Planned,
    Vec<Who>,
    BTreeMap<Id, replica::kinds::sizes::Size>,
    Minter,
    Option<buildsafe::PreparedMaps>,
    crate::edit_places::Projection,
);

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

/// Reserves only existing creator name counters at recorded intake; the live counter never rewinds.
fn reserve_edit(edit: &Edit, lineage: Scope, next: &mut u64) -> Result<Minter, Refused> {
    let reserved = Minter::at(lineage, *next);
    let mut end = reserved.clone();
    for op in &edit.ops {
        if matches!(op, edit::Op::Place { .. } | edit::Op::Doorway { .. }) {
            end.mint().map_err(|e| Refused {
                op: None,
                name: "edit.ids-exhausted",
                detail: e.to_string(),
            })?;
            *next = end.next();
        }
    }
    Ok(reserved)
}

/// What an intent becomes: a form's act for the checkers, a move for the bodies, or an edit or a set-down for the
/// edit checker.
enum Taken {
    Form(Act),
    Move(Asked),
    Edit(Edit),
    Engine(engine::Act),
    SetDown(crate::setdown::Ask),
}

/// A set-down checked off the clock, and the walkers' maps prepared from its part when it puts down a thing walkers
/// go round (the same handoff an edit's commit takes: `buildsafe::PreparedMaps`, `Bodies::commit_map`).
type SetDownChecked = (crate::setdown::Checked, Option<buildsafe::PreparedMaps>);

/// A form's arguments from an intent's parameter 1: `[[name as bytes, id or slot number], ...]`, a thing by its id
/// (F4) and a slot of the node by its number, 1, 2, ... in its entry's order (C12).
fn keep_arg_names(intent: &mut Value) {
    let Value::Map(intent) = intent else { return };
    let Some(Value::Map(parameters)) = intent.get_mut(&4) else {
        return;
    };
    let Some(Value::Array(pairs)) = parameters.get_mut(&1) else {
        return;
    };
    for pair in pairs {
        let Value::Array(pair) = pair else { continue };
        let [Value::Bytes(key), value] = pair.as_mut_slice() else {
            continue;
        };
        if !key.is_empty()
            && std::str::from_utf8(key).is_ok()
            && let Value::Text(name) = value
            && !name.as_str().contains(':')
        {
            *value = Value::Bytes(name.as_str().as_bytes().to_vec());
        }
    }
}

fn thing_args(intent: &Value) -> Result<acts::Args, &'static str> {
    let mut args = acts::Args::default();
    let pairs = match intent {
        Value::Map(intent) => match intent.get(&4) {
            Some(Value::Map(parameters)) => parameters.get(&1),
            _ => None,
        },
        _ => None,
    };
    let Some(Value::Array(pairs)) = pairs else {
        return Ok(args);
    };
    let mut seen = BTreeSet::new();
    for p in pairs {
        let Value::Array(kv) = p else {
            return Err("arg-malformed");
        };
        let [Value::Bytes(k), v] = kv.as_slice() else {
            return Err("arg-malformed");
        };
        let k = String::from_utf8(k.clone()).map_err(|_| "arg-malformed")?;
        if k.is_empty() {
            return Err("arg-malformed");
        }
        if !seen.insert(k.clone()) {
            return Err("arg-ambiguous");
        }
        use skills::form_runner::Arg;
        match v {
            Value::Uint(n) => drop(args.slots.insert(k, *n)),
            Value::Bytes(b) => {
                let n = std::str::from_utf8(b).map_err(|_| "arg-malformed")?;
                if n.is_empty() || Name::new(n).is_none() {
                    return Err("arg-malformed");
                }
                args.values.insert(k, Arg::Name(n.to_owned()));
            }
            Value::Text(n) => drop(args.values.insert(k, Arg::Name(n.as_str().to_owned()))),
            Value::Map(m) if m.len() == 1 => {
                let id = m
                    .get(&replica::audience::REFERENCE)
                    .ok_or("arg-malformed")
                    .and_then(|v| replica::effects::read_id(v).map_err(|_| "arg-malformed"))?;
                args.values.insert(k, Arg::Text(id));
            }
            _ => {
                args.things.insert(
                    k,
                    replica::effects::read_id(v).map_err(|_| "arg-malformed")?,
                );
            }
        }
    }
    Ok(args)
}

/// The event of the entry that names how a form's run ended (C2): field 1 the body, 2 how, by name.
pub const FORM_ENDED: &str = "souls:act-ended";

/// The event of the entry a move writes when it starts, and when it ends (field 2: how, by name).
pub const MOVE_STARTED: &str = "souls:move-started";
pub const MOVE_ENDED: &str = "souls:move-ended";
/// How an act still going at its deadline ends (C8), and the move it drove with it.
pub const TIMED_OUT: &str = "act.timed-out";
/// How an act its own Soul stopped ends (#3705, a `souls:cancel` naming it), and the walk it drove with it.
pub const STOPPED: &str = "act.stopped";

/// The event a form or gateway walk writes when planned (C20/C29): field 1 the body, 5 the act's
/// deadline, world time µs (its start plus its steps' span or planned route time). Its cause is the intent, so the
/// act's receipt names it.
pub const ACT_DEADLINE: &str = "souls:act-deadline";

/// The answer's field of a progress answer that holds how long the act has left, µs ([`progress`]).
pub const LEFT: u64 = 5;

/// A progress answer (C20, #3469): `{1: version, 2: {1: actor, 2: sequence, 3: 3, 4: intent id, 5: µs left}}`, T10's
/// accepted (`replica::intents::Answer::Accepted`) with how long the act has left until its deadline. It is not the
/// act's answer: that follows, by the deadline, and a repeat is never given this one. Sent, with no block, when a
/// form or gateway walk is still running at its arrival deadline and its own deadline is later.
pub fn progress(version: &Value, actor: Actor, sequence: u64, intent: Id, left: Micros) -> Vec<u8> {
    let mut answer = match (Answer::Accepted {
        actor,
        sequence,
        intent,
    })
    .to_value()
    {
        Value::Map(m) => m,
        _ => BTreeMap::new(),
    };
    answer.insert(LEFT, Value::Uint(u64::try_from(left).unwrap_or(0)));
    encode(&Value::Map(
        [(1, version.clone()), (2, Value::Map(answer))].into(),
    ))
    .unwrap_or_default()
}

/// The backstop refusal of an intent holding a text that is not a name (#3765).
const TEXT_NOT_A_NAME: &str = "intent.text-not-a-name";

/// An answered intent as its row logs it. The writer runs the reader's check (#3765): an intent holding a text that
/// is not a name, which every intake refuses first, is logged as its encoded bytes, never as a text the log's reader
/// refuses, and named.
fn logged_intent(intent: Value) -> Value {
    match replica::effects::not_a_name(&intent) {
        None => intent,
        Some(t) => {
            eprintln!(
                "worldd: an answered intent holds text-not-a-name {t:?}: logged as its bytes"
            );
            Value::Bytes(encode(&intent).unwrap_or_default())
        }
    }
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
fn act_of(intent: &Intent, body: Id, id: u64, cause: Cause) -> Result<Act, &'static str> {
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
fn spot_of(
    intent: &Intent,
    body: Result<Id, &'static str>,
    id: u64,
    cause: Cause,
) -> Option<Result<Act, &'static str>> {
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
            body: body?,
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
    Ok(Asked {
        body,
        actor,
        ask,
        fallbacks: Vec::new(),
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
            row.insert(5, logged_intent(i));
        }
        self.rows.push(Value::Map(row));
        self.replies.push((waiters, frame, stamps));
    }

    /// Ends open act `id` with `answer`.
    fn end(&mut self, id: Id, answer: impl FnOnce(&Clock) -> Answer) {
        let Some(o) = self.open.remove(&id) else {
            return;
        };
        self.walks.remove(&id);
        self.in_flight.remove(&(o.key.clone(), o.sequence));
        self.deadlines.close(o.body, id);
        self.progress.retain(|p| p.0 != id);
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

    /// Seals the tree if the world changed since the last seal (the roots file, R5b's relay test).
    fn seal(&mut self) {
        if !self.unsealed {
            return;
        }
        if let Ok(sealed) = self.replica.seal() {
            if self.checkpoints.is_some() {
                self.fresh.extend(sealed.nodes);
            }
            self.unsealed = false;
        }
    }

    fn arrival(&mut self, bytes: &[u8], reply: Reply, stamps: Stamps, now: Micros) {
        self.arrival_as(bytes, None, reply, stamps, now);
    }

    /// An intent's arrival, numbered under `key` when given (the directory's, W11b), else its actor's.
    fn arrival_as(
        &mut self,
        bytes: &[u8],
        key: Option<Vec<u8>>,
        reply: Reply,
        stamps: Stamps,
        now: Micros,
    ) {
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
        let Some(key) = key.or_else(|| actor_key(bytes)) else {
            return;
        };
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
        // A Soul with no body here waits for its birth (C3); a leave has nothing to retire.
        if let Some(soul) = self.unborn(&intent) {
            if intent.verb.as_str() == LEAVE {
                let a = self.refusal(actor, sequence, "soul-not-embodied");
                return self.answered(key, sequence, None, None, &a, (vec![reply], stamps));
            }
            // A Soul its owner retired is never born again (W11b).
            if self
                .directory
                .as_ref()
                .is_some_and(|(d, _)| d.retired.contains(&soul))
            {
                let a = self.refusal(actor, sequence, "soul-retired");
                return self.answered(key, sequence, None, None, &a, (vec![reply], stamps));
            }
            if let Some(l) = self.life.as_mut() {
                let entry = l.entry;
                // Refused `soul-embodied` only when a birth is already waiting: this intent waits with it.
                let _ = l.life.ask(Birth {
                    soul,
                    entry,
                    asked: now,
                });
                l.unborn.push((soul, bytes.to_vec(), reply, stamps));
            }
            return;
        }
        if let Some(f) = self.arrivals.as_mut() {
            // One write per line, unbuffered, so a killed world leaves every line it took.
            let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
            // A reflex (#3764) is named: its Soul's client sent it, not its agent.
            let reflex = if intent.reflex { " reflex" } else { "" };
            let _ = f.write_all(format!("{hex} {sequence}{reflex}\n").as_bytes());
        }
        if intent.verb.as_str() == skills::wear::VERB {
            return self.wear(&intent, key, (reply, stamps), now);
        }
        let mut value = intent.to_value();
        keep_arg_names(&mut value);
        // Every text the intent would be logged with must be a name the log's reader takes (#3765). A malformed word
        // (an act's `sit_down:undefined`, a form argument, an edit's or a set-down's) is a backstop: the intent's own
        // checks keep their names, and one that passes them all is refused `intent.text-not-a-name` where it would be
        // taken, before anything is written, logged without its intent. Words are bytes (T8), so none is a text.
        let unnamed = replica::effects::not_a_name(&value).is_some();
        let form = words::form(&intent);
        // A turn into an activity is its members' alone: refused before its words are kept when the speaker is not one.
        let mut members = BTreeSet::new();
        if let words::Form::Members(activity) = form {
            match self
                .body_of(&intent)
                .and_then(|b| words::members(self.replica.tree(), activity, b))
            {
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
            let r = match self.body_of(&intent) {
                Ok(b) => {
                    // Words a form writes into a field everyone reads are everyone's (#3712).
                    let public =
                        match (form, &intent.target) {
                            (words::Form::Other, Some(Target::Node(node))) => self
                                .forms
                                .public_words(self.replica.tree(), *node, intent.verb.as_str()),
                            _ => false,
                        };
                    let audience = match public {
                        true => Audience::Everyone,
                        false => words::audience(form, b),
                    };
                    words::keep(value, &self.text, audience, b, &mut kept).map_err(|r| r.name)
                }
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
        // B16: an agent's act (never a reflex, #3764) wakes a body the wind-down holds, on this tick; the act then runs.
        if let (true, Ok(body)) = (intent.agent_act(), self.body_of(&intent))
            && let Some(b) = self.bodies.as_mut()
        {
            b.agent_acted(body, now);
        }
        // A leave retires the Soul's body (C3).
        if let (Actor::Soul(soul), true) =
            (actor, intent.verb.as_str() == LEAVE && self.life.is_some())
        {
            if unnamed {
                let a = self.refusal(actor, sequence, TEXT_NOT_A_NAME);
                return self.answered(key, sequence, None, None, &a, (vec![reply], stamps));
            }
            return self.leave(
                soul,
                id,
                (key, sequence, value),
                &intent,
                (reply, stamps),
                now,
            );
        }
        // A say, a whisper or a describe writes its entry now and is answered after its tick's sync (V1b).
        if form != words::Form::Other {
            let entry = match self.body_of(&intent) {
                Ok(b) if self.replica.node(b).is_some() => {
                    let env = words::envelope(self.replica.version(), now, id, actor, b);
                    words::entry(form, &value, &kept, b, members, env)
                }
                Ok(_) => Some(Err("intent.no-body")),
                Err(e) => Some(Err(e)),
            };
            if let Some(entry) = entry {
                if unnamed && entry.is_ok() {
                    let a = self.refusal(actor, sequence, TEXT_NOT_A_NAME);
                    return self.answered(key, sequence, None, None, &a, (vec![reply], stamps));
                }
                let reason = match entry {
                    Ok(e) => {
                        // A private turn's public record goes in the same part (#3775).
                        let public = words::public_record(form, &e);
                        let all = std::iter::once(e).chain(public).collect();
                        self.write_all(all).err().map(|r| r.name)
                    }
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
        // #3705 (today's `stop`): a cancel naming an open act of the same actor ends it where the body stands, as its
        // deadline would: a walk stops in this tick (`act.stopped`), a form's run is left, and a sit, a lie or a rise,
        // short, runs to its end. The cancel is answered with a receipt and recorded as an input, so a replay agrees.
        if intent.verb.as_str() == "souls:cancel"
            && let Some((&open, o)) = self
                .open
                .iter()
                .find(|(_, o)| o.actor == actor && Some(o.sequence) == intent.replaces)
        {
            let (stopped, body) = (o.sequence, o.body);
            let cut = self.bodies.as_mut().and_then(|b| b.cancel(open));
            self.forms
                .leave(self.replica.tree(), self.bodies.as_mut(), body, now);
            if cut == Some(Cut::Stopped) {
                self.note(open, MOVE_ENDED, Some(STOPPED), now);
            }
            if cut != Some(Cut::Finishing) {
                self.end(open, |c| c.refusal(actor, stopped, STOPPED));
            }
            self.next_intent += 1;
            self.inputs.push(Input::Intent {
                id,
                soul: body,
                verb: intent.verb.clone(),
                words: None,
            });
            let a = Answer::Receipt {
                actor,
                sequence,
                intent: id,
                entries: Vec::new(),
                names: BTreeMap::new(),
            };
            return self.answered(
                key,
                sequence,
                Some(id),
                Some(value),
                &a,
                (vec![reply], stamps),
            );
        }
        // Standing orders are accepted once and recorded now; their later inputs and named ends are logged.
        if matches!(intent.kind(), Ok(Kind::Order)) || intent.verb.as_str() == "souls:cancel" {
            let result = self
                .body_of(&intent)
                .map_err(|name| Refusal {
                    name,
                    detail: String::new(),
                })
                .and_then(|body| match self.bodies.as_mut() {
                    Some(_) if unnamed => Err(Refusal {
                        name: TEXT_NOT_A_NAME,
                        detail: String::new(),
                    }),
                    Some(b) => crate::orders::accept(b, &intent, body, id, now),
                    None => Err(Refusal {
                        name: "orders-off",
                        detail: String::new(),
                    }),
                });
            let effects = self
                .bodies
                .as_mut()
                .map(|b| std::mem::take(&mut b.orders.log))
                .unwrap_or_default();
            let result = result.and_then(|()| self.write_all(effects));
            let answer = match result {
                Ok(()) => {
                    self.next_intent += 1;
                    self.inputs.push(Input::Intent {
                        id,
                        soul: self.body_of(&intent).unwrap_or(self.zone),
                        verb: intent.verb.clone(),
                        words: None,
                    });
                    Answer::Receipt {
                        actor,
                        sequence,
                        intent: id,
                        entries: self.receipts.entries(id).to_vec(),
                        names: BTreeMap::new(),
                    }
                }
                Err(r) => self.refusal(actor, sequence, r.name),
            };
            let accepted = matches!(answer, Answer::Receipt { .. }).then_some(id);
            return self.answered(
                key,
                sequence,
                accepted,
                Some(value),
                &answer,
                (vec![reply], stamps),
            );
        }
        // A move goes to the bodies when the world has them (I4b); anything else is a form's act.
        let moved = match self.bodies {
            Some(_) if !self.forms.fixture_sit(self.replica.tree(), &intent) => self
                .body_of(&intent)
                .ok()
                .and_then(|b| bodies::read(&intent, b)),
            _ => None,
        };
        let spotted = match self.bodies {
            Some(_) => spot_of(
                &intent,
                self.body_of(&intent),
                self.next_intent,
                Cause::Intent(id),
            ),
            None => None,
        };
        let verb = engine::Verb::of(intent.verb.as_str());
        let taken = match (spotted, moved, verb, intent.kind()) {
            (Some(a), _, _, _) => a.map(Taken::Form),
            (None, Some(m), _, _) => m.map(Taken::Move),
            // The engine's own acts (C2): activities, offers and carrying, by verb.
            (None, None, Some(v), _) => self.body_of(&intent).map(|body| {
                Taken::Engine(engine::Act {
                    id,
                    soul: match actor {
                        Actor::Soul(s) => s,
                        _ => body,
                    },
                    body,
                    verb: v,
                    target: match &intent.target {
                        Some(Target::Node(n)) => Some(*n),
                        _ => None,
                    },
                    params: intent.parameters.clone(),
                })
            }),
            // An edit (G1b): checked off the clock thread, committed at a tick through `sim::edit`.
            (None, None, None, Ok(Kind::Edit)) => {
                match (self.editing, edit::wire::edit_of(&intent, id)) {
                    (true, Some(e)) => Ok(Taken::Edit(e)),
                    (false, _) => Err("edit.not-the-creator"),
                    (_, None) => Err("intent.not-an-edit"),
                }
            }
            // A Soul puts its held thing down (E4, #3604): checked off the clock thread, committed at a tick.
            (None, None, None, _) if intent.verb.as_str() == crate::setdown::VERB => {
                match (&self.edits, self.body_of(&intent)) {
                    (None, _) => Err("setdown-off"),
                    (Some(_), Err(e)) => Err(e),
                    (Some(_), Ok(body)) => {
                        crate::setdown::read(&intent, id, body, self.replica.version(), now)
                            .map(Taken::SetDown)
                    }
                }
            }
            (None, None, None, _) => self.body_of(&intent).and_then(|body| {
                act_of(&intent, body, self.next_intent, Cause::Intent(id)).map(Taken::Form)
            }),
        };
        let taken = match taken {
            Ok(t) => t,
            Err(reason) => {
                let a = self.refusal(actor, sequence, reason);
                return self.answered(key, sequence, None, Some(value), &a, (vec![reply], stamps));
            }
        };
        let form_args = if matches!(&taken, Taken::Form(a) if self.bodies.is_some() && a.spot.is_none())
        {
            match thing_args(&value) {
                Ok(args) => args,
                Err(reason) => {
                    let a = self.refusal(actor, sequence, reason);
                    return self.answered(key, sequence, None, None, &a, (vec![reply], stamps));
                }
            }
        } else {
            acts::Args::default()
        };
        if unnamed {
            let a = self.refusal(actor, sequence, TEXT_NOT_A_NAME);
            return self.answered(key, sequence, None, None, &a, (vec![reply], stamps));
        }
        let body = match &taken {
            Taken::Form(a) => a.body,
            Taken::Move(m) => m.body,
            // An edit drives no body: its deadline is kept under its actor.
            Taken::Edit(e) => match e.actor {
                Actor::Soul(a) | Actor::Creator(a) => a,
                Actor::World => self.zone,
            },
            Taken::Engine(a) => a.body,
            Taken::SetDown(a) => a.body,
        };
        self.next_intent += 1;
        // The recorder's input (K12): the intent by id and verb; its words, were there any, by reference only.
        self.inputs.push(Input::Intent {
            id,
            soul: body,
            verb: intent.verb.clone(),
            words: None,
        });
        let due = intent.expiry.min(now.saturating_add(self.deadline));
        self.deadlines.open(body, id, due);
        self.in_flight.insert((key.clone(), sequence), id);
        self.open.insert(
            id,
            Open {
                actor,
                key,
                sequence,
                body,
                expiry: intent.expiry,
                due,
                run_due: None,
                intent: value,
                waiters: vec![reply],
                stamps,
            },
        );
        match taken {
            // A move aimed at a described spot (E2) is resolved by a checker even with bodies, and bound at commit.
            Taken::Form(act) if self.bodies.is_none() || act.spot.is_some() => {
                self.outstanding += 1;
                if let Some(m) = &self.measures {
                    m.to_check(id.counter(), stamps.0[1]);
                }
                let _ = self.acts.send(act);
            }
            Taken::Move(m) => self.moving.push((id, m)),
            // With bodies, a form's act goes to the form runner at the next tick (C2), not to the checkers.
            Taken::Form(act) => {
                let i = acts::intent(id, intent.expiry, actor, bytes);
                self.forming.push((id, act, i, form_args));
            }
            Taken::Engine(a) => self.engine_acts.push(a),
            Taken::Edit(e) => match reserve_edit(&e, self.lineage, &mut self.next_intent) {
                Ok(reserved) => {
                    if let Some(tx) = &self.edits
                        && tx.send(CheckJob::Edit(id, e, reserved)).is_ok()
                    {
                        self.outstanding += 1;
                    }
                }
                Err(r) => self.end(id, |c| c.edit_refusal(actor, sequence, &r)),
            },
            Taken::SetDown(a) => {
                if let Some(tx) = &self.edits
                    && tx.send(CheckJob::SetDown(a)).is_ok()
                {
                    self.outstanding += 1;
                }
            }
        }
    }

    /// The tick's checked set-downs (#3604): each still open, its thing still in the same hand and its new parent
    /// still there, is judged by G2's kept guard against the bodies as they stand now (lookups only) and written as
    /// one part under its intent, answered with one receipt; else refused by name, the thing left in the hand. One
    /// that puts down a thing walkers go round commits through the walkers' prepared maps as an edit does
    /// (`Bodies::commit_map`): the town they route on and the planner's copy take the same part, or nothing is written
    /// (`edit.map-unchecked` when no maps were prepared).
    fn set_downs(&mut self, now: Micros) {
        let mut kept = Vec::new();
        for (id, checked) in std::mem::take(&mut self.set_down) {
            let mut checked = checked;
            let mut keep = |c: &mut R<SetDownChecked>| {
                if let Ok((_, Some(maps))) = c {
                    kept.push(std::mem::take(&mut maps.surfaces));
                }
            };
            let Some(o) = self.open.get(&id) else {
                keep(&mut checked);
                continue;
            };
            let (actor, sequence) = (o.actor, o.sequence);
            if expired(o.expiry, now) {
                keep(&mut checked);
                self.end(id, |c| c.refusal(actor, sequence, "intent.expired"));
                continue;
            }
            let soul = match actor {
                Actor::Soul(s) => s,
                _ => o.body,
            };
            if let (Ok((_, Some(maps))), Some(b)) = (&checked, &self.bodies)
                && let Err(r) = b.check_map(maps)
            {
                keep(&mut checked);
                let name = r.name;
                self.end(id, |c| c.refusal(actor, sequence, name));
                continue;
            }
            let done = checked.and_then(|(c, maps)| {
                crate::setdown::still_held(self.replica.tree(), &c)?;
                let bodies = match &self.bodies {
                    Some(b) => buildsafe::judged(c.souls, &buildsafe::moving(b)),
                    None => c.souls,
                };
                crate::setdown::verdict(&c.guard.judge(&bodies))?;
                let header = self.replica.header().clone();
                let p = sim::setdown::part(&header, 0, now, soul, Cause::Intent(id), c.entries)?;
                let replica = &mut self.replica;
                let write = || {
                    applied(replica, p.effects)
                        .map(|p| sim::edit::Committed {
                            part: Arc::new(p),
                            names: BTreeMap::new(),
                        })
                        .map_err(|r| Refused {
                            op: None,
                            name: r.name,
                            detail: r.detail,
                        })
                };
                let done = match (&mut self.bodies, maps, c.walk) {
                    (Some(b), Some(maps), _) => b.commit_map(maps, write),
                    // A thing walkers go round never reaches the world without its maps.
                    (Some(_), None, true) => Err(Refused {
                        op: None,
                        name: "edit.map-unchecked",
                        detail: "no walkers' map was prepared for the set-down".into(),
                    }),
                    _ => write(),
                };
                done.map_err(|r| Refusal {
                    name: r.name,
                    detail: r.detail,
                })
            });
            match done {
                Ok(c) => {
                    self.unsealed = true;
                    // The edit checker's town takes it too, as an edit's commit (G1e).
                    if let Some(w) = &self.walkers {
                        // A set-down hands no prepared ground on; the checker's town installs its part as G3b does.
                        w.committed(Arc::clone(&c.part), self.replica.version(), None);
                    }
                    self.receipts.index(&c.part.effects);
                    self.effects.extend(c.part.effects.iter().cloned());
                    self.parts.push(c.part);
                    self.end(id, |k| Answer::Receipt {
                        actor,
                        sequence,
                        intent: id,
                        entries: k.receipts.entries(id).to_vec(),
                        names: BTreeMap::new(),
                    });
                }
                Err(r) => self.end(id, |c| c.refusal(actor, sequence, r.name)),
            }
        }
        if !kept.is_empty()
            && let Some(tx) = &self.edits
        {
            let _ = tx.send(CheckJob::Release(kept));
        }
    }

    /// The tick's checked edits (G1b): each still open is committed through `sim::edit` on the live replica, as
    /// generic effects under its intent, and answered with a receipt carrying the map from names to ids; or refused
    /// whole, naming the failing operation. Placed nodes take their ids from the world's lineage, on the counter its
    /// intent ids use, so the two never meet.
    fn edits(&mut self, now: Micros) {
        let mut kept = Vec::new();
        let mut keep = |checked: &mut Result<Checked, Refused>| {
            if let Ok((.., Some(maps), _)) = checked {
                kept.push(std::mem::take(&mut maps.surfaces));
            }
        };
        for (id, mut checked) in std::mem::take(&mut self.edited) {
            let Some(o) = self.open.get(&id) else {
                keep(&mut checked);
                continue;
            };
            let (actor, sequence) = (o.actor, o.sequence);
            if expired(o.expiry, now) {
                keep(&mut checked);
                self.end(id, |c| c.refusal(actor, sequence, "intent.expired"));
                continue;
            }
            // Every guard first; a body that only walked on sends the same edit back to be placed again (B12b).
            let walked = match (&self.bodies, &checked) {
                (Some(b), Ok((.., Some(maps), _))) => b.check_map_or_walked(maps),
                _ => Ok(None),
            };
            let checked = match walked {
                Ok(Some(bases)) => {
                    let Ok(k) = checked else { unreachable!() };
                    let job = CheckJob::Reprepare(Box::new((id, k, bases)));
                    match self.edits.as_ref().map(|tx| tx.send(job).is_ok()) {
                        Some(true) => {
                            self.outstanding += 1;
                            continue;
                        }
                        _ => Err(Refused {
                            op: None,
                            name: "edit.body-stale",
                            detail: "prepared triangle differs".into(),
                        }),
                    }
                }
                Ok(None) => {
                    keep(&mut checked);
                    checked
                }
                Err(r) => {
                    keep(&mut checked);
                    Err(r)
                }
            };
            // #3695: a creator's weather (plain sets on the world node) is checked here and, once committed, written
            // through E6's weather (`sim::edit::weather::set`): its event and its timer follow the creator's record.
            let weather = match &checked {
                Ok((c, ..)) => self.weather_asked(&c.checked.edit.ops, now),
                Err(_) => Ok(None),
            };
            let (checked, weather) = match weather {
                Err(r) => {
                    let mut checked = checked;
                    keep(&mut checked);
                    (Err(r), None)
                }
                Ok(w) => (checked, w),
            };
            let committed = checked.and_then(|(c, souls, classes, mut reserved, maps, places)| {
                if let Some(b) = &self.bodies {
                    places.check(&b.slots)?;
                }
                let current = self
                    .bodies
                    .as_ref()
                    .map(|b| buildsafe::judged(souls.clone(), &buildsafe::moving(b)));
                let current_classes = self.bodies.as_ref().map(Bodies::classes);
                let mut commit = || {
                    sim::edit::commit_classes(
                        &mut self.replica,
                        &mut reserved,
                        &c,
                        current.as_deref().unwrap_or(&souls),
                        now,
                        current_classes.as_ref().unwrap_or(&classes),
                    )
                };
                let done = match (&mut self.bodies, maps) {
                    (Some(b), Some(mut maps)) => {
                        let mine = maps.checker.take();
                        b.commit_map(maps, commit).map(|c| (c, mine))
                    }
                    // Every edit a world with walkers commits reaches their town: none without its maps.
                    (Some(_), None) => Err(Refused {
                        op: None,
                        name: "edit.map-unchecked",
                        detail: "no walkers' map was prepared for the edit".into(),
                    }),
                    (None, _) => commit().map(|c| (c, None)),
                };
                done.map(|(c, mine)| (c, mine, places))
            });
            match committed {
                Ok((c, mine, places)) => {
                    if let Some(b) = &mut self.bodies
                        && let Err(e) = places.install(&mut b.slots, &c.names)
                    {
                        self.faults += 1;
                        eprintln!("worldd: edit places {}", e.name);
                    }
                    self.unsealed = true;
                    // The edit checker's town installs the ground prepared for this edit (#3743), or is built again
                    // from a copy with it (G1e).
                    if let Some(w) = &self.walkers {
                        w.committed(Arc::clone(&c.part), self.replica.version(), mine);
                    }
                    self.receipts.index(&c.part.effects);
                    self.effects.extend(c.part.effects.iter().cloned());
                    self.parts.push(c.part);
                    if let Some(w) = weather {
                        self.put_weather(now, w);
                    }
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
        if !kept.is_empty()
            && let Some(tx) = &self.edits
        {
            let _ = tx.send(CheckJob::Release(kept));
        }
    }

    /// B15's existing hash-only record, checked off-clock and committed without mutating refused actors.
    fn wear(
        &mut self,
        intent: &Intent,
        key: Vec<u8>,
        (reply, stamps): (Reply, Stamps),
        now: Micros,
    ) {
        let (actor, sequence) = (intent.actor, intent.sequence);
        let preset = match (&self.wear, skills::wear::asked(&intent.parameters)) {
            (None, _) => Err("wear.off"),
            (Some(w), Some(name)) => w.catalogue.find(&name).cloned().ok_or("body-unknown"),
            _ => Err("body-unknown"),
        };
        let mut logged = intent.clone();
        logged.parameters.clear();
        if let Ok(p) = &preset {
            logged.parameters.insert(1, Value::Bytes(p.hash.to_vec()));
        } else {
            logged.parameters.remove(&1);
        }
        let value = logged.to_value();
        let prepared = preset.and_then(|preset| {
            if expired(intent.expiry, now) {
                return Err("intent.expired");
            }
            let body = self.body_of(intent)?;
            let record = wear_record(&self.replica, body)?;
            let w = self.wear.as_ref().ok_or("wear.off")?;
            let old = w
                .catalogue
                .build_of(record.fields.get(&skills::wear::BODY))?;
            let b = self.bodies.as_ref().ok_or("intent.no-body")?;
            let basis = b.wear_basis(body).map_err(|r| r.name)?;
            if basis.build != old {
                return Err("body-change-stale");
            }
            b.town
                .surfaces_for(preset.build.size)
                .ok_or("body-class-unprepared")?;
            let id = Id::new(self.lineage, self.next_intent).ok_or("intent.ids-exhausted")?;
            Ok(WearRequest {
                id,
                version: self.replica.version(),
                ground: b.town.ground,
                map: Arc::clone(&b.form_map),
                surfaces: b.town.basis(),
                basis,
                record,
                preset,
            })
        });
        let request = match prepared {
            Ok(r) => r,
            Err(reason) => {
                let answer = self.refusal(actor, sequence, reason);
                return self.answered(
                    key,
                    sequence,
                    None,
                    Some(value),
                    &answer,
                    (vec![reply], stamps),
                );
            }
        };
        let id = request.id;
        let body = request.basis.moved.id;
        self.next_intent += 1;
        let due = intent.expiry.min(now.saturating_add(self.deadline));
        self.deadlines.open(body, id, due);
        self.inputs.push(Input::Intent {
            id,
            soul: body,
            verb: intent.verb.clone(),
            words: None,
        });
        self.in_flight.insert((key.clone(), sequence), id);
        self.open.insert(
            id,
            Open {
                actor,
                key,
                sequence,
                body,
                expiry: intent.expiry,
                due,
                run_due: None,
                intent: value,
                waiters: vec![reply],
                stamps,
            },
        );
        if let Some(tx) = &self.edits
            && tx.send(CheckJob::Wear(Box::new(request))).is_ok()
        {
            self.outstanding += 1;
        } else {
            self.end(id, |c| c.refusal(actor, sequence, "size-not-checked"));
        }
    }

    fn wears(&mut self, now: Micros) {
        for (request, checked) in std::mem::take(&mut self.worn) {
            let id = request.id;
            let Some(open) = self.open.get(&id) else {
                continue;
            };
            let (actor, sequence) = (open.actor, open.sequence);
            let result = checked.and_then(|moved| {
                let error = |name| Refusal {
                    name,
                    detail: "body change basis".into(),
                };
                if expired(open.expiry, now) {
                    return Err(error("intent.expired"));
                }
                if wear_record(&self.replica, request.basis.moved.id).map_err(error)?
                    != request.record
                {
                    return Err(error("body-change-stale"));
                }
                let bodies = self
                    .bodies
                    .as_mut()
                    .ok_or_else(|| error("intent.no-body"))?;
                if !Arc::ptr_eq(&bodies.form_map, &request.map) {
                    return Err(error("body-change-stale"));
                }
                bodies.wear_basis(request.basis.moved.id)?;
                let effect = Effect {
                    envelope: words::envelope(
                        self.replica.version(),
                        now,
                        id,
                        actor,
                        request.basis.moved.id,
                    ),
                    body: Body::Changes(vec![ChangeRec {
                        change: skills::wear::change(request.basis.moved.id, &request.preset.hash),
                        rest: Rest::new(),
                    }]),
                    events: None,
                    rest: Rest::new(),
                };
                let live = &mut self.replica;
                bodies.commit_wear(&request.basis, request.preset.build, moved, || {
                    sim::commit::write(live, &[effect])
                })
            });
            match result {
                Ok(part) => {
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
                Err(r) => self.end(id, |c| c.refusal(actor, sequence, r.name)),
            }
        }
    }

    /// The body an intent drives: with joins (C3), a Soul's born body, else as [`body_of`] says.
    fn body_of(&self, intent: &Intent) -> Result<Id, &'static str> {
        match (intent.actor, &self.life) {
            (Actor::Soul(s), Some(l)) => l.life.body_of(s).ok_or("intent.no-body"),
            _ => body_of(intent),
        }
    }

    /// The Soul of `intent` when it has no body here yet (C3). A body the log has for it (its `souls:body-of` link,
    /// after a restart) is taken back first.
    fn unborn(&mut self, intent: &Intent) -> Option<Id> {
        let Actor::Soul(soul) = intent.actor else {
            return None;
        };
        let l = self.life.as_mut()?;
        if l.life.body_of(soul).is_some() {
            return None;
        }
        let tree = self.replica.tree();
        let found = tree
            .links_at(soul)
            .iter()
            .filter(|e| tree.ty(e).as_str() == BODY_OF)
            .find_map(|e| {
                let (_, [body, _], _, _) = tree.link(e.link)?;
                tree.handle(body)?;
                Some((body, e.link))
            });
        match found {
            Some((body, link)) => {
                l.life.adopt(soul, body, link);
                None
            }
            None => Some(soul),
        }
    }

    /// #3784: each embodied Soul's wind-down word, compared with what the gateways were last told; only a change is
    /// sent, as one frame ([`states_frame`]), to every gateway connection still open. A Soul now awake, or gone, is
    /// told `awake`.
    fn tell_states(&mut self) {
        let (Some(l), Some(b)) = (self.life.as_ref(), self.bodies.as_ref()) else {
            return;
        };
        let mut now = BTreeMap::new();
        for (soul, body) in l.life.embodied() {
            let word = match b.wind.word(body) {
                Some(skills::wind_down::Word::Idle) => "idle",
                Some(skills::wind_down::Word::Zombie) => "zombie",
                Some(skills::wind_down::Word::Asleep) => "asleep",
                _ => continue,
            };
            now.insert(soul, word);
        }
        if now == self.states {
            return;
        }
        let mut changed: Vec<(Id, &'static str)> = now
            .iter()
            .filter(|(s, w)| self.states.get(s) != Some(w))
            .map(|(s, w)| (*s, *w))
            .collect();
        changed.extend(
            self.states
                .keys()
                .filter(|s| !now.contains_key(s))
                .map(|s| (*s, "awake")),
        );
        self.states = now;
        let frame = states_frame(&changed);
        self.states_to.retain(|r| r.send(frame.clone()).is_ok());
    }

    /// The directory's word, at a tick's start after its births (W11b): each Soul told of since the last tick that has
    /// a body here is retired when the directory retired it, or given its saved words when its body's differ, by an
    /// intent of its own taken as any intent is, under [`notice_key`]. A Soul with no body here is left alone.
    fn notices(&mut self, now: Micros) {
        let told = std::mem::take(&mut self.told);
        let Some((d, reply)) = self.directory.as_ref().map(|(d, r)| (d.clone(), r.clone())) else {
            return;
        };
        if self.life.is_none() {
            return;
        }
        for soul in told {
            let (verb, parameters) = if d.retired.contains(&soul) {
                (LEAVE, BTreeMap::new())
            } else if let Some(w) = d.words.get(&soul) {
                let said = |n: &Option<Vec<u8>>| {
                    n.as_ref().map(|b| {
                        Value::Map(BTreeMap::from([(words::WORDS, Value::Bytes(b.clone()))]))
                    })
                };
                let p: BTreeMap<u64, Value> = [(1, said(&w.name)), (2, said(&w.description))]
                    .into_iter()
                    .filter_map(|(k, v)| Some((k, v?)))
                    .collect();
                (DESCRIBE, p)
            } else {
                continue;
            };
            let Some(verb) = Name::new(verb) else {
                continue;
            };
            let mut intent = Intent {
                actor: Actor::Soul(soul),
                verb,
                target: None,
                parameters,
                sequence: 0,
                basis: self.version(),
                expiry: now.saturating_add(self.deadline),
                resources: Vec::new(),
                fallbacks: Vec::new(),
                replaces: None,
                body: None,
                reflex: false,
            };
            // Only a Soul with a body here (its link after a restart included); the directory never births one.
            if self.unborn(&intent).is_some() {
                continue;
            }
            if intent.verb.as_str() == DESCRIBE {
                let body = self.life.as_ref().and_then(|l| l.life.body_of(soul));
                if intent.parameters.is_empty()
                    || body.is_some_and(|b| self.says(b, &d.words[&soul]))
                {
                    continue;
                }
            }
            let key = notice_key(soul);
            intent.sequence = self
                .sequences
                .kept()
                .find(|(k, _, _)| *k == key.as_slice())
                .map_or(1, |(_, last, _)| last + 1);
            let Ok(bytes) = encode(&intent.to_value()) else {
                continue;
            };
            self.arrival_as(&bytes, Some(key), reply.clone(), Stamps::default(), now);
        }
    }

    /// Whether `body`'s public name and description already read as the saved words `w` (a word not saved agrees).
    fn says(&self, body: Id, w: &crate::directory::Words) -> bool {
        let tree = self.replica.tree();
        let Some(n) = tree.handle(body).and_then(|h| tree.node(h)) else {
            return false;
        };
        let reads = |field: u64, want: &Option<Vec<u8>>| {
            let Some(want) = want else { return true };
            let r = match n.fields().get(&field) {
                Some(Value::Map(m)) => m.get(&replica::audience::REFERENCE),
                _ => None,
            };
            r.and_then(|r| replica::effects::read_id(r).ok())
                .and_then(|r| self.text.read(r, &[]).ok())
                .is_some_and(|got| &got == want)
        };
        reads(words::NAME, &w.name) && reads(words::DESCRIPTION, &w.description)
    }

    /// This tick's births (C3, K10): each body born, its node and link written, a join among its Soul's waiting
    /// intents answered with that entry, and its other intents taken now.
    fn births(&mut self, now: Micros) {
        let (Some(l), Some(b)) = (self.life.as_mut(), self.bodies.as_mut()) else {
            return;
        };
        if l.life.waiting() == 0 {
            return;
        }
        let mut born = b.births_built(&mut l.life, now, &l.ring, &l.family, &|soul| {
            self.birth_builds
                .get(&soul)
                .copied()
                .unwrap_or(skills::wear::DEFAULT)
        });
        let mut taken = Vec::new();
        for x in &mut born {
            // The world's body kind, as its header pins it (K10 writes the plain name).
            for c in &mut x.changes {
                if let Change::Create {
                    kind, node, fields, ..
                } = c
                {
                    *kind = l.kind.clone();
                    if *node == x.body
                        && let Some(hash) = self.wear.as_ref().and_then(|w| w.born.get(&x.soul))
                    {
                        fields.insert(skills::wear::BODY, Value::Bytes(hash.to_vec()));
                    }
                }
            }
            let (mine, rest) = std::mem::take(&mut l.unborn)
                .into_iter()
                .partition(|h| h.0 == x.soul);
            l.unborn = rest;
            taken.push((x.clone(), mine));
        }
        for (x, mine) in taken {
            let mut later: Vec<(Vec<u8>, Reply, Stamps)> = Vec::new();
            let mut join = None;
            for (_, bytes, reply, stamps) in mine {
                let is_join =
                    join.is_none() && Intent::read(&bytes).is_ok_and(|i| i.verb.as_str() == JOIN);
                if is_join {
                    join = Some((bytes, reply, stamps));
                } else {
                    later.push((bytes, reply, stamps));
                }
            }
            self.told.insert(x.soul);
            self.born(x, join, now);
            for (bytes, reply, stamps) in later {
                self.arrival(&bytes, reply, stamps, now);
            }
        }
    }

    /// Writes one birth: the body's node (named by `join`'s words when it is one) and its link to its Soul. A join is
    /// answered with that entry; one sent again, or stale, is answered as any repeat.
    fn born(&mut self, x: sim::life::Born, join: Option<(Vec<u8>, Reply, Stamps)>, now: Micros) {
        let mut changes = x.changes;
        let mut cause = (Cause::World, Actor::World);
        let mut answer = None;
        if let Some((bytes, reply, stamps)) = join {
            let read = Intent::read(&bytes).ok().zip(actor_key(&bytes));
            match read.map(|(i, k)| {
                let fresh = matches!(self.sequences.seen(&k, i.sequence), Seen::Fresh);
                (i, k, fresh)
            }) {
                Some((intent, key, true)) if !expired(intent.expiry, now) => {
                    let mut kept = Vec::new();
                    let value = words::keep(
                        intent.to_value(),
                        &self.text,
                        Audience::Everyone,
                        x.body,
                        &mut kept,
                    );
                    if let (Ok(value), Some(id)) = (value, Id::new(self.lineage, self.next_intent))
                    {
                        self.next_intent += 1;
                        if let Some(Change::Create { fields, .. }) = changes.first_mut() {
                            fields.extend(words::naming(&value));
                        }
                        cause = (Cause::Intent(id), intent.actor);
                        self.inputs.push(Input::Intent {
                            id,
                            soul: x.body,
                            verb: intent.verb.clone(),
                            words: None,
                        });
                        answer = Some((id, intent, key, value, reply, stamps));
                    } else {
                        // Words refused: the body is born unnamed, and the join is taken as any intent.
                        self.arrival(&bytes, reply, stamps, now);
                    }
                }
                _ => self.arrival(&bytes, reply, stamps, now),
            }
        }
        let node = match changes.first() {
            Some(Change::Create { pose, .. }) => pose.frame.node,
            _ => self.replica.header().zone,
        };
        let effect = Effect {
            envelope: Envelope {
                sequence: self.replica.version(),
                at: now,
                cause: cause.0,
                actor: cause.1,
                audience: Audience::Everyone,
                node,
            },
            body: Body::Changes(
                changes
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            ),
            events: None,
            rest: Rest::new(),
        };
        let written = self.write(effect);
        if let Err(r) = &written {
            eprintln!("worldd: a birth was not written: {r}");
        }
        if let Some((id, intent, key, value, reply, stamps)) = answer {
            let a = match written {
                Ok(()) => Answer::Receipt {
                    actor: intent.actor,
                    sequence: intent.sequence,
                    intent: id,
                    entries: self.receipts.entries(id).to_vec(),
                    names: BTreeMap::new(),
                },
                Err(r) => self.refusal(intent.actor, intent.sequence, r.name),
            };
            self.answered(
                key,
                intent.sequence,
                Some(id),
                Some(value),
                &a,
                (vec![reply], stamps),
            );
        }
    }

    /// A leave (C3): `soul`'s body retired by K10's path, its link ended and its node removed in one entry, the move
    /// it was making ended `retired`; answered with that entry, or refused by name.
    fn leave(
        &mut self,
        soul: Id,
        id: Id,
        (key, sequence, value): (Vec<u8>, u64, Value),
        intent: &Intent,
        (reply, stamps): (Reply, Stamps),
        now: Micros,
    ) {
        let actor = intent.actor;
        // The entry is the body's own (T6 rule 6: it writes its own node and link).
        let mut node = self.replica.header().zone;
        let mut held = Vec::new();
        if let Some(body) = self.life.as_ref().and_then(|l| l.life.body_of(soul)) {
            node = body;
            held = self.held(body);
            // A form's run on the body is left first, while the body is still the controller's.
            self.forms
                .leave(self.replica.tree(), self.bodies.as_mut(), body, now);
        }
        let retired = match (self.life.as_mut(), self.bodies.as_mut()) {
            (Some(l), Some(b)) => b.retire(&mut l.life, soul, now),
            _ => Err(Refusal {
                name: "soul-not-embodied",
                detail: String::new(),
            }),
        };
        let (r, open) = match retired {
            Ok(x) => x,
            Err(r) => {
                let a = self.refusal(actor, sequence, r.name);
                return self.answered(key, sequence, None, Some(value), &a, (vec![reply], stamps));
            }
        };
        self.next_intent += 1;
        self.inputs.push(Input::Intent {
            id,
            soul: r.body,
            verb: intent.verb.clone(),
            words: None,
        });
        // What it held is set down where it stood (a leave of its hand and an arrive on the ground, in the same part),
        // before the node goes: a leave never takes a thing out of the world with the body.
        let header = self.replica.header().clone();
        let mut effects = Vec::new();
        for (thing, pose) in held {
            let Some(transfer) = self.life.as_mut().and_then(|l| l.mint.mint().ok()) else {
                continue;
            };
            let entry = |node, body| Effect {
                envelope: words::envelope(0, now, id, actor, node),
                body,
                events: None,
                rest: Rest::new(),
            };
            let on = pose.frame.node;
            effects.push(entry(
                thing,
                Body::Transfer(TransferRec::Leave {
                    transfer,
                    node: thing,
                    lineage: header.lineage,
                    zone: header.zone,
                    pose,
                }),
            ));
            effects.push(entry(
                on,
                Body::Transfer(TransferRec::Arrive {
                    transfer,
                    carried: Vec::new(),
                }),
            ));
        }
        effects.push(Effect {
            envelope: words::envelope(0, now, id, actor, node),
            body: Body::Changes(
                r.changes
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            ),
            events: None,
            rest: Rest::new(),
        });
        let a = match self.write_all(effects) {
            Ok(()) => Answer::Receipt {
                actor,
                sequence,
                intent: id,
                entries: self.receipts.entries(id).to_vec(),
                names: BTreeMap::new(),
            },
            Err(e) => self.refusal(actor, sequence, e.name),
        };
        if let Some(i) = open
            && let Some(o) = self.open.get(&i)
        {
            let (actor, sequence) = (o.actor, o.sequence);
            self.end(i, |c| c.refusal(actor, sequence, "retired"));
        }
        self.answered(
            key,
            sequence,
            Some(id),
            Some(value),
            &a,
            (vec![reply], stamps),
        );
    }

    /// What `body` holds (its node's children) and, for each, its pose set down on the node the body stands on,
    /// where it stands (C3: a leave never takes a thing out of the world with the body).
    fn held(&self, body: Id) -> Vec<(Id, Pose)> {
        let tree = self.replica.tree();
        let Some(h) = tree.handle(body) else {
            return Vec::new();
        };
        let Some(n) = tree.node(h) else {
            return Vec::new();
        };
        let (Some(parent), Some(birth)) = (n.parent(), n.place()) else {
            return Vec::new();
        };
        let at = match self.bodies.as_ref().and_then(|b| b.pose(body)) {
            Some((on, p)) if on == parent => p,
            _ => birth.position,
        };
        tree.children(h)
            .unwrap_or(&[])
            .iter()
            .filter_map(|&c| {
                let c = tree.node(c)?;
                let pose = Pose {
                    frame: Frame {
                        node: parent,
                        slot: None,
                    },
                    position: Vec3::new(at.x, 0, at.z),
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: parent,
                        height: 0,
                    },
                };
                Some((c.id(), pose))
            })
            .collect()
    }

    /// Writes the entry of open move `id`: event `event` with `{1: body, 2: how (once it ended; its name's bytes, since
    /// an event's text is a namespaced name), 3: [x, y, z] µm,
    /// 4: the node of its frame}`, where the body stands or sits. A move started also names the candidate of its ranked
    /// list it took (C14): `5: its rank` (0 the intent's own) and `6: its target`. Its cause is the intent, so the
    /// receipt finds it.
    fn note(&mut self, id: Id, event: &str, how: Option<&str>, at: Micros) {
        self.note_with(id, event, how, None, at);
    }

    /// [`Clock::note`], with field 5 the act's deadline, world time µs, when given (C20).
    fn note_with(
        &mut self,
        id: Id,
        event: &str,
        how: Option<&str>,
        due: Option<Micros>,
        at: Micros,
    ) {
        let Some(o) = self.open.get(&id) else { return };
        let mut fields = BTreeMap::from([(1, o.body.to_value())]);
        if let Some((rank, target)) = self.bodies.as_mut().and_then(|b| b.took(id)) {
            fields.insert(5, Value::Uint(rank as u64));
            if let Some(t) = target {
                fields.insert(6, t.to_value());
            }
        }
        if let Some(h) = how {
            fields.insert(2, Value::Bytes(h.as_bytes().to_vec()));
        }
        if let Some(d) = due.and_then(|d| u64::try_from(d).ok()) {
            fields.insert(5, Value::Uint(d));
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
        self.write_all(vec![effect])
    }

    /// Applies entries the world writes itself as one part, whole or not at all, each numbered in turn from the
    /// replica's version.
    fn write_all(&mut self, effects: Vec<Effect>) -> R<()> {
        let changes = effects
            .iter()
            .any(|e| !matches!(&e.body, Body::Changes(c) if c.is_empty()));
        let p = applied(&mut self.replica, effects)?;
        self.unsealed |= changes;
        self.receipts.index(&p.effects);
        self.effects.extend(p.effects.iter().cloned());
        self.parts.push(Arc::new(p));
        Ok(())
    }

    /// Writes the world's own entries (its utterances, its sky), each envelope's sequence set in turn, as one part
    /// applied to the world and logged with the tick. A part the world refuses is not written, and is named.
    fn write_own(&mut self, effects: Vec<Effect>, what: &str) {
        if let Err(r) = self.try_own(effects) {
            eprintln!("worldd: {what} was not written: {r}");
        }
    }

    /// [`Clock::write_own`], the refusal handed back.
    fn try_own(&mut self, effects: Vec<Effect>) -> R<()> {
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
        let p = part?;
        self.unsealed = true;
        self.effects.extend(p.effects.iter().cloned());
        self.parts.push(Arc::new(p));
        Ok(())
    }

    /// The bodies' motion on their nodes, at step 3 (#3799): each sample [`Bodies::motion`] gives, world-caused, in the node's
    /// audience, after a change of parent (T1's leave and arrive inside the zone) when its frame changed. One part for
    /// the tick; when the world refuses it, each body's in a part of its own, a refused one named.
    fn write_motion(&mut self) {
        let Some(b) = self.bodies.as_mut() else {
            return;
        };
        let samples = b.motion(self.replica.tree());
        if samples.is_empty() {
            return;
        }
        let all = motion_effects(self.replica.header(), self.replica.version(), &samples);
        if self.try_own(all).is_ok() {
            return;
        }
        for s in samples {
            let one = motion_effects(
                self.replica.header(),
                self.replica.version(),
                std::slice::from_ref(&s),
            );
            if let Err(r) = self.try_own(one) {
                eprintln!(
                    "worldd: {}'s motion was not written: {r}",
                    replica::world_model::show(s.handoff.node)
                );
            }
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

    /// The creator's weather a batch asks for (#3695), checked against world time `now`: none when it sets no weather
    /// field on the world node; refused when it sets some but not all, a level is outside 0 to 100, its end is not
    /// after now, or the world has no sky.
    fn weather_asked(
        &self,
        ops: &[edit::Op],
        now: Micros,
    ) -> Result<Option<sim::edit::weather::Asked>, Refused> {
        let tree = self.replica.tree();
        let Some(world) = tree.node(tree.root()).map(|n| n.id()) else {
            return Ok(None);
        };
        let Some(asked) = sim::edit::weather::asked(ops, world) else {
            return Ok(None);
        };
        let asked = asked?;
        if self.sky.is_none() {
            return Err(Refused {
                op: None,
                name: sim::edit::weather::NO_SKY,
                detail: "this world's node has no sky".into(),
            });
        }
        sim::edit::weather::check(asked.levels, now, asked.until)?;
        Ok(Some(asked))
    }

    /// After the creator's batch commits: E6's weather write (its event, and the weather timer set for its end).
    fn put_weather(&mut self, now: Micros, w: sim::edit::weather::Asked) {
        let Some(h) = self.sky.as_mut() else { return };
        match sim::edit::weather::set(&mut h.daylight, w.kind, w.levels, now, w.until) {
            Ok(write) => self.put_sky(now, write),
            Err(r) => eprintln!("worldd: the creator's weather was not set: {}", r.name),
        }
    }

    /// The mapping this start applies, as its time effect and the zone root's fields in one part (E7b, #3516).
    fn put_clock(&mut self, now: Micros) {
        let Some((applied, latest)) = self.clock.take() else {
            return;
        };
        let zone = self.replica.header().zone;
        let mut effects = Vec::new();
        if !applied.is_empty() {
            effects.push(Effect {
                envelope: Clock::own(zone, now),
                body: Body::Time(applied.into_iter().map(TimeEffect::Mapping).collect()),
                events: None,
                rest: Rest::new(),
            });
        }
        let sets = latest
            .fields()
            .into_iter()
            .map(|(field, to)| Change::Set {
                node: zone,
                field,
                to,
                by: None,
            })
            .collect();
        effects.push(Effect {
            envelope: Clock::own(zone, now),
            body: Body::Changes(recs_of(sets)),
            events: None,
            rest: Rest::new(),
        });
        self.write_own(effects, "the clock's mapping");
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
        let mut ended = b.step(now);
        let orders = std::mem::take(&mut b.orders.log);
        let wind = std::mem::take(&mut b.wind_log);
        let mut deadlines = Vec::new();
        for (id, walk) in &mut self.walks {
            let (due, blocked) = walk.step(b, now);
            if let Some(due) = due {
                deadlines.push((*id, due));
            }
            if blocked && b.cancel(*id) == Some(Cut::Stopped) {
                ended.push((*id, Err(acts::BLOCKED.to_owned())));
            }
        }
        // Where the planner's answers came back late (K18b), for the recorder: a replay takes them at the same tick.
        for (at, taken) in b.late() {
            self.inputs.push(Input::Planned {
                at: u64::try_from(at).unwrap_or(0),
                taken,
            });
        }
        let heard = std::mem::take(&mut b.heard);
        if !orders.is_empty() {
            self.write_own(orders, "standing orders");
        }
        if !wind.is_empty() {
            self.write_own(wind, "the wind-down");
        }
        for (speaker, said, at) in heard {
            let e = speech::entry(Clock::own(speaker, at), speaker, &said);
            self.write_own(vec![e], "an utterance");
        }
        for (id, due) in deadlines {
            self.run_started(id, due, now);
        }
        for (id, how) in ended {
            self.settle(id, how, now);
        }
        let tick = u64::try_from(self.tick).unwrap_or(0);
        self.forms
            .tick(self.replica.tree(), self.bodies.as_mut(), tick, now);
        if let (Some(e), Some(b)) = (self.engine.as_mut(), self.bodies.as_mut()) {
            e.tick(
                self.replica.tree(),
                &mut b.runner.controller,
                &mut b.slots,
                now,
            );
        }
    }

    /// Hands the form acts taken since the last tick to the form runner (C2): each starts its run, joins the one
    /// going for its intent, gets its first receipt again, or is refused by name.
    fn start_forms(&mut self, now: Micros) {
        let tick = u64::try_from(self.tick).unwrap_or(0);
        for (id, act, intent, args) in std::mem::take(&mut self.forming) {
            let Some(o) = self.open.get(&id) else {
                continue;
            };
            let (actor, sequence) = (o.actor, o.sequence);
            if expired(o.expiry, now) {
                self.end(id, |c| c.refusal(actor, sequence, "intent.expired"));
                continue;
            }
            let candidates: Vec<(Id, String)> = act
                .candidates
                .iter()
                .map(|c| (c.this, c.form.clone()))
                .collect();
            let r = self.forms.start(
                self.replica.tree(),
                self.bodies.as_mut(),
                act.body,
                &candidates,
                &args,
                intent,
                tick,
                now,
            );
            match r {
                Ok(sim::forms::Asked::Applied(_)) => self.form_ended(id, "done".into(), None, now),
                Ok(sim::forms::Asked::Started(run)) => self.form_started(id, run, now),
                Ok(_) => {}
                Err(r) => self.end(id, |c| c.refusal(actor, sequence, r.name)),
            }
        }
        for a in std::mem::take(&mut self.engine_acts) {
            let Some(o) = self.open.get(&a.id) else {
                continue;
            };
            let (actor, sequence) = (o.actor, o.sequence);
            let r = match (self.engine.as_mut(), self.bodies.as_mut()) {
                (Some(e), Some(b)) => e.act(
                    self.replica.tree(),
                    &mut b.runner.controller,
                    &mut b.slots,
                    &a,
                    now,
                ),
                _ => Err(Refusal {
                    name: "engine-acts-off",
                    detail: "the world has no rules or no bodies for them".into(),
                }),
            };
            match r {
                Ok(()) => self.engine_done.push(a.id),
                Err(r) => self.end(a.id, |c| c.refusal(actor, sequence, r.name)),
            }
        }
    }

    /// Numbers and applies what the forms wrote (F2's log hook: each entry handed back as logged), then answers the
    /// intents whose runs ended. One part for the tick; when the world refuses it, each intent's entries go in a part
    /// of their own, and an act whose entries are refused is refused by that name, its run left and nothing of it
    /// written.
    fn write_forms(&mut self, now: Micros) {
        let mut effects = self.forms.out();
        if let Some(e) = self.engine.as_mut() {
            effects.extend(e.out());
        }
        if !effects.is_empty() && self.commit_forms(effects.clone()).is_err() {
            let mut groups: Vec<(Option<Id>, Vec<Effect>)> = Vec::new();
            for e in effects {
                let of = match e.envelope.cause {
                    Cause::Intent(id) => Some(id),
                    _ => None,
                };
                match groups.iter_mut().find(|(g, _)| *g == of) {
                    Some((_, g)) => g.push(e),
                    None => groups.push((of, vec![e])),
                }
            }
            for (of, group) in groups {
                let Err(r) = self.commit_forms(group.clone()) else {
                    continue;
                };
                eprintln!("worldd: a form's entries were not written: {r}");
                self.forms.unwritten(&group);
                let Some(o) = of.and_then(|id| self.open.get(&id).map(|o| (id, o))) else {
                    continue;
                };
                let (id, actor, sequence, body) = (o.0, o.1.actor, o.1.sequence, o.1.body);
                self.forms
                    .leave(self.replica.tree(), self.bodies.as_mut(), body, now);
                self.end(id, |c| c.refusal(actor, sequence, r.name));
            }
        }
        for id in std::mem::take(&mut self.engine_done) {
            let Some(o) = self.open.get(&id) else {
                continue;
            };
            let (actor, sequence) = (o.actor, o.sequence);
            let entries = self.receipts.entries(id).to_vec();
            if entries.is_empty() {
                self.end(id, |c| c.refusal(actor, sequence, "act.not-written"));
            } else {
                self.end(id, |_| Answer::Receipt {
                    actor,
                    sequence,
                    intent: id,
                    entries,
                    names: BTreeMap::new(),
                });
            }
        }
        for (id, how, why) in self.forms.ended() {
            self.form_ended(id, how, why, now);
        }
    }

    /// `effects` numbered from the replica's next sequence and applied as one part, each handed to the forms as
    /// logged; or the world's refusal, nothing written.
    fn commit_forms(&mut self, mut effects: Vec<Effect>) -> R<()> {
        for (k, e) in effects.iter_mut().enumerate() {
            e.envelope.sequence = self.replica.version() + k as u64;
        }
        let part = sim::commit::write(&mut self.replica, &effects)?;
        self.unsealed = true;
        for e in &part.effects {
            self.forms.forms.logged(e);
        }
        self.receipts.index(&part.effects);
        self.effects.extend(part.effects.iter().cloned());
        self.parts.push(part);
        Ok(())
    }

    /// A form's run started (C20, #3469): its act's deadline becomes the run's own, its start plus its steps' span
    /// (`sim::forms::span`: its walk, its moves and its pauses), written as an [`ACT_DEADLINE`] entry its receipt
    /// names. The due list keeps the sooner of that and the deadline set at its arrival: an act still running at its
    /// arrival deadline with a later run deadline is answered in progress then ([`Clock::still_running`]).
    fn form_started(&mut self, id: Id, run: sim::forms::RunId, now: Micros) {
        let Some(due) = self.forms.forms.due(run) else {
            return;
        };
        self.run_started(id, due, now);
    }

    /// C20's deadline entry and single progress answer also serve a planned gateway walk (C29).
    fn run_started(&mut self, id: Id, due: Micros, now: Micros) {
        let Some(o) = self.open.get_mut(&id) else {
            return;
        };
        let due = due.min(o.expiry);
        o.run_due = Some(due);
        let (body, first) = (o.body, o.due.min(due));
        self.deadlines.close(body, id);
        self.deadlines.open(body, id, first);
        self.note_with(id, ACT_DEADLINE, None, Some(due), now);
    }

    /// A deadline of act `id` passed at `now` (C20): when it is a form's act whose run's deadline is later, its
    /// deadline moves there and it is answered in progress ([`progress`]), so the gateway waits for it rather than
    /// answering `act.timed-out` itself. Whether it did.
    fn still_running(&mut self, id: Id, now: Micros) -> bool {
        let Some(o) = self.open.get(&id) else {
            return false;
        };
        let Some(due) = o.run_due.filter(|d| *d > now) else {
            return false;
        };
        let frame = progress(
            &self.version(),
            o.actor,
            o.sequence,
            id,
            due.saturating_sub(now),
        );
        self.progress.push((id, o.waiters.clone(), frame));
        self.deadlines.open(o.body, id, due);
        true
    }

    /// A form's run ended: an entry naming how (and for a walk that stalled, what blocked it: C21), then its intent's
    /// answer, a receipt when `done`.
    fn form_ended(&mut self, id: Id, how: String, why: Option<String>, now: Micros) {
        let Some(o) = self.open.get(&id) else { return };
        let (actor, sequence) = (o.actor, o.sequence);
        let noted = why.map_or_else(|| how.clone(), |w| format!("{how}: {w}"));
        self.note(id, FORM_ENDED, Some(&noted), now);
        if how == "done" {
            self.end(id, |c| Answer::Receipt {
                actor,
                sequence,
                intent: id,
                entries: c.receipts.entries(id).to_vec(),
                names: BTreeMap::new(),
            });
        } else {
            self.end(id, |c| c.refusal(actor, sequence, &how));
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
        for (&body, &(_, id)) in &b.runner.asks {
            if started.iter().any(|(i, r)| *i == id && r.is_ok()) {
                self.walks.insert(id, acts::Walk::new(body, id, now));
            }
        }
        // A walk a new move replaced stopped in this tick: its end is written now, before the new move's start.
        let replaced = b.replaced();
        self.bodies = Some(b);
        for (id, how) in replaced {
            self.settle(id, how, now);
        }
        for (id, r) in started {
            match r {
                Ok(()) => self.note(id, MOVE_STARTED, None, now),
                Err(r) => {
                    if let Some(b) = self.bodies.as_mut() {
                        b.took(id);
                    }
                    self.settle(id, Err(r.name.to_owned()), now);
                }
            }
        }
    }

    /// Ends open move `id` as it ended: its entry, then its answer. A move whose act's deadline passed while it
    /// went ends `act.timed-out`, however it ended.
    fn settle(&mut self, id: Id, how: Result<(), String>, now: Micros) {
        let Some(o) = self.open.get(&id) else { return };
        let how = match self.overdue.remove(&id) {
            true => Err(TIMED_OUT.to_owned()),
            false => how,
        };
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
        // 0. This tick's births (C3) and the intents that waited for them; then what arrived since the last tick, and
        // what a script set for this one, is taken now.
        self.births(now);
        self.notices(now);
        self.tell_states();
        for (bytes, reply, stamps) in std::mem::take(&mut self.pending) {
            self.arrival(&bytes, reply, stamps, now);
        }
        if let Some(due) = self.scheduled.remove(&n) {
            for (bytes, reply) in due {
                self.arrival(&bytes, reply, Stamps::default(), now);
            }
        }
        at[2] = mark();
        // 1. Due timers: acts whose deadline passed. A walk going for one stops in this tick and its end is written
        // by the deadline's name; a sit, a lie or a rise runs to its end, and the act ends with it.
        while let Some(id) = self.deadlines.due(now) {
            // A form's act whose run is due later is answered in progress, and kept to the run's deadline (C20).
            if self.still_running(id, now) {
                continue;
            }
            let Some(o) = self.open.get(&id) else {
                continue;
            };
            let (actor, sequence, body) = (o.actor, o.sequence, o.body);
            let cut = self.bodies.as_mut().and_then(|b| b.cancel(id));
            // A form's run whose act timed out is left: it ends at its next stable moment (F3).
            self.forms
                .leave(self.replica.tree(), self.bodies.as_mut(), body, now);
            match cut {
                Some(Cut::Stopped) => self.note(id, MOVE_ENDED, Some(TIMED_OUT), now),
                Some(Cut::Finishing) => {
                    self.overdue.insert(id);
                    continue;
                }
                None => {}
            }
            self.end(id, |c| c.refusal(actor, sequence, TIMED_OUT));
        }
        // 1. The clock's mapping, when this start applies one (E7b, #3516); then the world node's sky: its timers due
        // in this tick, each at its due time (E6, #3369).
        self.put_clock(now);
        self.fire_sky(now);
        // 1. Loose things' ends due in this tick, each at its due time (F10b, #3476).
        self.fire_loose(now);
        at[3] = mark();
        // 1-3. The bodies' own timers, skills through the host, the controller; then their motion on their nodes.
        self.step_bodies(now);
        self.write_motion();
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
        self.wears(now);
        // 4c. Checked set-downs (#3604): committed with lookups only, or refused by name.
        self.set_downs(now);
        self.start_forms(now);
        self.start_moves(now);
        self.write_forms(now);
        // 4. What the tick's acts made loose or kept: its timers, in the same tick (F10b, #3476).
        self.set_loose(now);
        // The bodies as they stand after the tick's steps and starts, for the edit checker (G1d): before the tick's
        // frozen copy (6).
        if let (Some(w), Some(b)) = (&self.walkers, &self.bodies) {
            w.offer_map(b, self.replica.version());
        }
        at[5] = mark();
        remember_orders(&mut self.order_records, &self.effects);
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
        let parts = std::mem::take(&mut self.parts);
        if !parts.is_empty() {
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
            self.publisher.publish(parts.clone());
        }
        // 7. The answers thread appends, syncs, hands the synced tick to the view tier, then answers.
        let replies = std::mem::take(&mut self.replies);
        let bytes = inputs.as_ref().map_or(0, Vec::len) + record.as_ref().map_or(0, Vec::len);
        let written = u64::from(inputs.is_some()) + u64::from(record.is_some());
        let handed = mark();
        let progress: Vec<_> = std::mem::take(&mut self.progress)
            .into_iter()
            .map(|(_, to, frame)| (to, frame))
            .collect();
        if written > 0 || !replies.is_empty() || !progress.is_empty() || !parts.is_empty() {
            let _ = self.answers.send(Tick {
                inputs,
                record,
                replies,
                started: at[0],
                handed,
                bare: progress,
                parts,
                ran: None,
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
            &self.order_records,
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
        // One seal for both: what the roots file's seals hashed since the last checkpoint, then what changed after.
        let taken = self.replica.seal().and_then(|mut sealed| {
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

// Diagnostic only: enabled on the I/O threads, never by the deterministic clock. No payload or actor id leaves.
fn delivery_trace(enabled: bool, stage: &str, frame: &[u8], outcome: &str) {
    if !enabled {
        return;
    }
    let Ok(d) = decode(frame) else { return };
    let Value::Map(m) = d.value else { return };
    let Some(Value::Map(a)) = m.get(&2) else {
        return;
    };
    let (Some(actor), Some(Value::Uint(sequence)), Some(Value::Uint(kind))) =
        (a.get(&1), a.get(&2), a.get(&3))
    else {
        return;
    };
    let Ok(actor) = encode(actor) else { return };
    let actor = replica::encode::to_hex(&replica::ids::sha256(&actor));
    let version = match m.get(&1) {
        Some(Value::Array(v)) => v.last().and_then(|v| match v {
            Value::Uint(n) => Some(*n),
            _ => None,
        }),
        _ => None,
    };
    eprintln!(
        "worldd: join-delivery stage={stage} actor-hash={actor} sequence={sequence} kind={kind} version={version:?} outcome={outcome}"
    );
}

/// The answers thread: each tick's records appended and on the disk before its answers leave, then the part handed to
/// the view tier. A log that fails stops it for good: nothing is answered that is not on the disk.
// Each argument is one consumer of the durable tick (views, follower, served feed, sync thread); a struct would only
// rename them.
#[allow(clippy::too_many_arguments)]
fn answer_loop<S: Storage + 'static>(
    mut log: Log<S>,
    ticks: Receiver<Tick>,
    tier: Option<Arc<Tier>>,
    measures: Option<Arc<Measures>>,
    synced: Option<Sender<Synced>>,
    served: Option<crate::views::served::Feed>,
    mut follow: Option<Offer>,
    syncs: Sender<ToSync>,
) {
    let trace = std::env::var_os("SOULS_JOIN_DELIVERY_TRACE").is_some_and(|v| v == "1");
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
        if trace {
            for (_, frame, _) in &t.replies {
                delivery_trace(trace, "log-wait", frame, "appended");
            }
        }
        if let Some(n) = last
            && let Err(e) = log.wait_durable(n + 1)
        {
            eprintln!("worldd: the log failed, nothing more is answered: {e}");
            return;
        }
        if trace {
            for (_, frame, _) in &t.replies {
                delivery_trace(trace, "log-durable", frame, "ready");
            }
        }
        if let Some(tx) = &synced {
            for s in appended {
                let _ = tx.send(s);
            }
        }
        if let (Some(v), Some(r)) = (&served, durable_part) {
            v.record(r);
        }
        // The sync thread's copy takes the tick once it is on the disk, before its answers leave (C16).
        if !t.parts.is_empty() {
            let _ = syncs.send(ToSync::Parts(t.parts));
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
                let sent = w.send(frame.clone());
                delivery_trace(
                    trace,
                    "reply-channel",
                    &frame,
                    if sent.is_ok() { "queued" } else { "closed" },
                );
            }
        }
        for (waiters, frame) in t.bare {
            for w in waiters {
                let _ = w.send(frame.clone());
            }
        }
        if let Some((done, ran)) = t.ran {
            let _ = done.send(ran);
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

/// The mappings a start applies, and the one in force, for its first tick to write (E7b).
type Publish = (Vec<Mapping>, Mapping);

/// The world's time line at a start (E7b, #3516): the first mapping (world time is real time), then each the log
/// holds; with a rate (`Config::rate`), a new mapping at real time `real0` when the last one's rate differs, on its
/// line, so world time does not jump. Gives the line, the mapping in force, and what the first tick writes: the
/// mappings this start applies, and the one in force, when either is new or the root's fields do not hold it.
fn timeline(
    world: &Replica,
    rate: Option<(i64, i64)>,
    real0: Micros,
    tick_us: Micros,
) -> R<(Timeline, Mapping, Option<Publish>)> {
    let first = Mapping::new(0, 0, 1, 1).map_err(time)?;
    let start = |m| -> R<Timeline> {
        let ticks = TickRate::new(0, 0, 1_000_000 / tick_us).map_err(time)?;
        Timeline::start(m, ticks, Tempo::per_minute(0, 0, 120).map_err(time)?).map_err(time)
    };
    let Some((num, den)) = rate else {
        return Ok((start(first)?, first, None));
    };
    let tree = world.tree();
    let logged: Vec<Mapping> = tree
        .time()
        .iter()
        .filter_map(|t| match t {
            TimeEffect::Mapping(m) => Some(*m),
            _ => None,
        })
        .collect();
    let mut line = start(logged.first().copied().unwrap_or(first))?;
    for m in logged.iter().skip(1) {
        line.apply(TimeEffect::Mapping(*m), m.world_us)
            .map_err(time)?;
    }
    let mut last = logged.last().copied().unwrap_or(first);
    let mut applied = if logged.is_empty() {
        vec![first]
    } else {
        Vec::new()
    };
    if last.rate() != Mapping::new(0, 0, num, den).map_err(time)?.rate() {
        let m = Mapping::new(last.world_at(real0).map_err(time)?, real0, num, den).map_err(time)?;
        line.apply(TimeEffect::Mapping(m), m.world_us)
            .map_err(time)?;
        applied.push(m);
        last = m;
    }
    let held = tree
        .node(tree.root())
        .and_then(|n| Mapping::from_fields(n.fields()));
    let publish = (!applied.is_empty() || held != Some(last)).then_some((applied, last));
    Ok((line, last, publish))
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
    let mut order_records = Vec::new();
    // B16: the wind-down's records and the Souls' acts replayed, to rebuild it.
    let mut wind_records: Vec<Effect> = Vec::new();
    // A compacted log (#3837) holds no records before its cut: only a checkpoint at or after it can start the world.
    let held_from = found.first;
    if held_from > restored.as_ref().map_or(0, |r| r.root.record) {
        return Err(Refusal {
            name: "log-compacted-past-checkpoint",
            detail: format!(
                "the log is kept from record {held_from}, and no checkpoint that verifies starts there or later"
            ),
        });
    }
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
                if !c.orders.is_empty() {
                    let v = Value::Map(BTreeMap::from([
                        (1, Value::Bytes(world.header().hash().to_bytes())),
                        (2, Value::Array(c.orders)),
                    ]));
                    let bytes = encode(&v).map_err(|e| Refusal {
                        name: "encoding",
                        detail: e.to_string(),
                    })?;
                    order_records = Part::read(&bytes)?.effects;
                }
                last = (c.tick >= 0).then_some(c.tick);
            }
            restart.checkpoint = Some(r.root.record);
            blobs = r.blobs;
            found.after(r.root.record)
        }
        None => &found.records,
    };
    restart.read = records.len() as u64;
    let first = found.first + (found.records.len() - records.len()) as u64;
    for (n, record) in (first..).zip(records) {
        // The recorder's input records are what the world was handed, not what it did (K12): passed by.
        if recorder::is_input(record) {
            continue;
        }
        // A record its reader refuses stops the restart, named with its place; the log is kept as written (#3765).
        let part = Part::read(record).map_err(|r| Refusal {
            name: "log-record-unreadable",
            detail: format!(
                "record {n} of the log: {r}; the log is kept as written, nothing is dropped or repaired"
            ),
        })?;
        if !part.effects.is_empty() {
            world.apply(&part)?;
        }
        restart.applied += 1;
        receipts.index(&part.effects);
        remember_orders(&mut order_records, &part.effects);
        wind_records.extend(
            part.effects
                .iter()
                .filter(|e| {
                    matches!(e.envelope.actor, Actor::Soul(_))
                        || skills::wind_down::read(e).is_some()
                })
                .cloned(),
        );
        read_back(&part, &mut placed, &mut last);
        // Nodes an edit placed took their ids on the intents' counter (G1b): never give one out again.
        for e in &part.effects {
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    if let Change::Create { node, .. } | Change::Link { link: node, .. } = c.change
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
    // Active starts are carried by the checkpoint; later starts/ends have just replayed above.
    let order_parts = if order_records.is_empty() {
        Vec::new()
    } else {
        let value = Value::Map(BTreeMap::from([
            (1, Value::Bytes(world.header().hash().to_bytes())),
            (
                2,
                Value::Array(order_records.iter().map(Effect::to_value).collect()),
            ),
        ]));
        vec![Part::read(&encode(&value).map_err(|e| Refusal {
            name: "encoding",
            detail: e.to_string(),
        })?)?]
    };
    let zone = world.header().zone;
    let records = found.first + found.records.len() as u64;
    // Restored trees retain sealed hashes: their unchanged records will not be emitted by the next seal.
    // Keep the validated blobs for sync before the checkpoint writer takes ownership of them.
    let mut kept = Records::default();
    kept.extend(blobs.records());
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
            let carry = Carry::of(
                &sequences,
                next_intent,
                placed.clone(),
                last.unwrap_or(-1),
                &order_records,
            );
            let version = Version {
                lineage: cfg.lineage,
                zone,
                epoch: cfg.epoch,
                sequence: world.version(),
            };
            let minter = Minter::at(cfg.lineage, next_intent);
            let sealed = world.seal()?;
            kept.keep(&sealed);
            c.take_sealed(
                sealed,
                version,
                records,
                Some((at, &minter)),
                &carry.to_bytes(),
            )?;
        }
    }
    let mut cfg = cfg;
    let make = cfg.bodies.take();
    let make_built = cfg.built_bodies.take();
    let recorded_builds = placed
        .keys()
        .filter_map(|&body| world.tree().handle(body).map(|_| body))
        .map(|body| {
            let node = world
                .tree()
                .node(world.tree().handle(body).expect("existing body"));
            let worn = node
                .as_ref()
                .and_then(|n| n.fields().get(&skills::wear::BODY));
            let build = match &cfg.wear {
                Some(w) => w.catalogue.build_of(worn),
                None if worn.is_none() => Ok(skills::wear::DEFAULT),
                None => Err("body-unknown"),
            }
            .map_err(|name| Refusal {
                name,
                detail: "recorded body catalogue".into(),
            })?;
            Ok((body, build))
        })
        .collect::<R<BTreeMap<_, _>>>()?;
    if make_built.is_none()
        && recorded_builds
            .values()
            .any(|build| *build != skills::wear::DEFAULT)
    {
        return Err(Refusal {
            name: "body-class-unprepared",
            detail: "recorded builds require the class-aware bodies caller".into(),
        });
    }
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
    let shared = Arc::new(Mutex::new(0));
    let mut pace: Box<dyn Pace + Send> = match (cfg.lockstep, cfg.clock.take()) {
        (true, _) => Box::new(Stepped(Arc::clone(&shared))),
        (false, Some(c)) => c,
        (false, None) => Box::new(Real::start()),
    };
    let real0 = pace.now();
    // World time starts as real time, µs from the Unix epoch (rate one); tick n starts at n ticks from it. The logged
    // mappings follow, and the configured rate's (E7b).
    let (line, mapping, publish) = timeline(&world, cfg.rate, real0, tick_us)?;
    if cfg.rate.is_some() {
        eprintln!(
            "worldd: clock world {} real {} rate {}/{}",
            mapping.world_us,
            mapping.real_us,
            mapping.rate().num(),
            mapping.rate().den()
        );
    }
    // A first start begins at the tick due now, not at the epoch's.
    let last = match (last, cfg.lockstep) {
        (Some(n), _) => Some(n),
        (None, true) => None,
        (None, false) => Some(
            line.tick_of(line.world_at(real0).map_err(time)?)
                .map_err(time)?
                - 1,
        ),
    };
    // Body time is the next world tick start, not the real-time deadline returned by Ticker::due.
    let body_start = line.tick_start(last.map_or(0, |n| n + 1)).map_err(time)?;
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
    let (kinds, library) = (rules.kinds.clone(), acts::library()?);
    let (header, engine_header) = (world.header().clone(), world.header().clone());
    // The ids the forms and the engine mint (links, transfers, things made): a scope of their own for each start,
    // from the zone and the version the world starts at, so ids minted before a restart are never minted again.
    let scope = |purpose: &str| {
        let h = replica::ids::sha256(
            format!(
                "souls/worldd/{purpose}/{}/{}",
                replica::world_model::show(world.header().zone),
                world.version()
            )
            .as_bytes(),
        );
        let mut s = [0u8; 16];
        s.copy_from_slice(&h[..16]);
        Scope(s)
    };
    let (forms_scope, engine_scope) = (scope("forms"), scope("engine"));
    let life = cfg.join.take().map(|j| {
        let entry = j.entry.0;
        Lives {
            life: Life::new(scope("life"), j.per_tick),
            ring: Ring {
                entries: BTreeMap::from([(entry, j.entry)]),
                radius: 1_000_000,
                gap: 1_000_000,
                rings: 8,
            },
            entry,
            family: j.family,
            kind: j.kind,
            mint: Minter::new(scope("leave")),
            unborn: Vec::new(),
        }
    });
    let birth_builds = cfg
        .wear
        .as_ref()
        .map(|w| {
            w.born
                .iter()
                .map(|(&soul, hash)| {
                    w.catalogue
                        .get(hash)
                        .map(|p| (soul, p.build))
                        .ok_or_else(|| Refusal {
                            name: "body-unknown",
                            detail: "unknown recorded birth body".into(),
                        })
                })
                .collect::<R<BTreeMap<_, _>>>()
        })
        .transpose()?
        .unwrap_or_default();
    let engine_parts = cfg.engine.take();
    let (events, rx) = channel();
    // The edit checker's thread checks edits (with a creator), wear, and set-downs (with the engine's rules, #3604).
    let editing = cfg.edits.is_some();
    let set_downs = engine_parts
        .as_ref()
        .map(|(r, _)| (r.clone(), Minter::new(scope("setdown"))));
    let walkers = (editing || cfg.wear.is_some() || set_downs.is_some())
        .then(|| Arc::new(buildsafe::Moving::default()));
    let creator = cfg.creator.take();
    let edits = walkers
        .clone()
        .map(|m| {
            edit_checker(
                cfg.edits.take(),
                set_downs,
                creator,
                Arc::clone(&publisher),
                m,
                events.clone(),
                rules.kinds.clone(),
            )
        })
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
    let served = cfg.served.take();
    // Seal any remaining changes before the clock runs. The sync thread (C16) starts from the sealed world and
    // one complete cache: restored records, the pre-clock checkpoint's records, and this seal's incremental records.
    let first = world.seal()?;
    kept.keep(&first);
    let syncs = syncs::start(
        world.frozen(),
        kept,
        (cfg.lineage, zone, cfg.epoch),
        Arc::clone(&cfg.public_names),
        Arc::clone(&text),
        std::mem::take(&mut cfg.closed),
    )
    .map_err(io)?;
    let fresh = if cfg.checkpoints.is_some() {
        first.nodes
    } else {
        Vec::new()
    };
    let (answers, ticks) = channel();
    let answer_tier = tier.clone();
    let answer_measures = measures.clone();
    let answer_syncs = syncs.clone();
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
                answer_syncs,
            )
        })
        .map_err(io)?;
    let sky = Heavens::of(&world, cfg.sky.take());
    let clock_measures = measures.clone();
    // Built on the clock thread: skills (in the bodies) stay on the thread that steps them.
    let hatches = std::mem::take(&mut cfg.hatches);
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
        unsealed: false,
        fresh,
        checked: Vec::new(),
        replies: Vec::new(),
        progress: Vec::new(),
        rows: Vec::new(),
        effects: Vec::new(),
        parts: Vec::new(),
        bodies: None,
        moving: Vec::new(),
        walks: BTreeMap::new(),
        overdue: BTreeSet::new(),
        edits,
        editing,
        set_down: Vec::new(),
        edited: Vec::new(),
        walkers,
        forms: {
            let mut acts = Acts::new(kinds, library, header, forms_scope);
            // Checked at boot by `serve` (`Acts::hatches` refuses a module by name); a refused one is not loaded.
            let _ = acts.hatches(&hatches);
            acts
        },
        forming: Vec::new(),
        engine: engine_parts
            .map(|(rules, kinds)| Engine::new(engine_header, rules, kinds, engine_scope)),
        engine_acts: Vec::new(),
        engine_done: Vec::new(),
        order_records,
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
        clock: publish,
        life,
        wear: cfg.wear.take(),
        birth_builds,
        worn: Vec::new(),
        directory: None,
        told: BTreeSet::new(),
        states_to: Vec::new(),
        states: BTreeMap::new(),
        loose,
        unlinked: Vec::new(),
    };
    let lockstep = cfg.lockstep;
    let thread_beat = Arc::clone(&beat);
    let clock_syncs = syncs.clone();
    let clock = thread::Builder::new()
        .name("clock".into())
        .spawn(move || {
            mark_clock_thread();
            let beat = thread_beat;
            let mut c = build();
            // With joins (C3), a body the log placed is stood again only while its node is in the tree: a retired
            // body's last row outlives it.
            let mut placed = placed;
            if c.life.is_some() {
                let tree = c.replica.tree();
                placed.retain(|id, _| tree.handle(*id).is_some());
            }
            let made = match (make_built, make) {
                (Some(make), _) => Some(make(&placed, &recorded_builds)),
                (None, Some(make)) => Some(make(&placed)),
                _ => None,
            };
            if let Some(made) = made {
                match made {
                    Ok(mut b) => {
                        let at = body_start;
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
                        if let Err(r) = crate::orders::resume(&mut b, &order_parts, at) {
                            eprintln!("worldd: standing orders were not restored: {r}");
                        }
                        b.wind_resume(
                            &wind_records,
                            |s| c.life.as_ref().and_then(|l| l.life.body_of(s)),
                            &placed,
                            at,
                        );
                        if let Some(w) = &c.walkers {
                            w.offer_map(&b, c.replica.version());
                        }
                        c.bodies = Some(b);
                        // The activities the log holds, so their members speak in them and leave them again (E26).
                        if let (Some(e), Some(b)) = (c.engine.as_mut(), c.bodies.as_mut())
                            && let Err(r) =
                                e.restore(c.replica.tree(), &mut b.runner.controller, &mut b.slots)
                        {
                            eprintln!("worldd: the activities were not restored: {r}");
                        }
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
                        // A sync request (R5b) sent past the door is handed to the sync thread (C16); it is not an
                        // intent and never reaches the recorder.
                        if let Some(ask) = syncs::ask_of(&bytes) {
                            let _ = clock_syncs.send(ToSync::Ask(ask, reply));
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
                    Event::Worn(k) => {
                        c.outstanding = c.outstanding.saturating_sub(1);
                        c.worn.push(*k);
                    }
                    Event::SetDown(k) => {
                        c.outstanding = c.outstanding.saturating_sub(1);
                        c.set_down.push(*k);
                    }
                    Event::Directory(d) => {
                        let (d, reply) = *d;
                        c.told.extend(d.souls());
                        c.directory = Some((d, reply));
                    }
                    Event::States(r) => {
                        let all: Vec<(Id, &'static str)> =
                            c.states.iter().map(|(s, w)| (*s, *w)).collect();
                        if r.send(states_frame(&all)).is_ok() {
                            c.states_to.push(r);
                        }
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
                        // And the checkers' copy caught up with the live tree: it is published on its own thread, and
                        // an act checked on a copy behind it is rechecked a tick later, so the commit tick (and the
                        // log) would depend on that thread's speed.
                        let live = c.replica.version();
                        c.publisher.wait_for(live, PUBLISHED_WAIT);
                        let Ok(due) = ticker.due() else { break };
                        *shared.lock().unwrap_or_else(|p| p.into_inner()) = due;
                        if let Err(e) = ticker.run_due(&mut *pace, &beat, &mut |n, s| c.tick(n, s))
                        {
                            eprintln!("worldd: {}", e.name());
                            stop = true;
                        }
                    }
                    // Through the answers thread, behind the run's ticks: the report is an answer the caller holds.
                    let ran = Tick {
                        inputs: None,
                        record: None,
                        replies: Vec::new(),
                        started: None,
                        handed: None,
                        parts: Vec::new(),
                        bare: Vec::new(),
                        ran: Some((done, c.ran())),
                    };
                    if let Err(e) = c.answers.send(ran)
                        && let Some((done, ran)) = e.0.ran
                    {
                        let _ = done.send(ran);
                    }
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
        syncs,
        beat,
        tier,
        measures,
        restart,
        durable: world_durable,
        clock: Some(clock),
    })
}

/// The edit checker's thread (G1b): each edit is checked (`replica::edit::check`) and planned (`sim::edit::plan_on`,
/// G2's safety guard on the town, G2b) on the newest frozen copy that stands at the version it was planned against
/// (and after the last edit committed), or after a second whatever it stands at, never on the live tree. G2 is given
/// that copy's open ground and its Souls' bodies ([`crate::buildsafe`], G1c), with the bodies the controller holds as
/// the clock last handed them off, walkers and the next corner of each walker's line among them (G1d): the plan cuts
/// only what the edit can affect on the checker's own town ([`buildsafe::TownCopy`], G1e), and the commit judges the
/// bodies (lookups only), so an edit that would bury a Soul, cut it off or change what it uses is refused by name,
/// naming the Soul. While no edit waits, the town is built (again) ahead of the next. With `creator` (G1e), the
/// creator is the one it names now.
///
/// The same thread checks a Soul's set-down (#3604, [`crate::setdown::check`]) on the same town, with the engine's
/// rules: a world with the engine and no creator has the thread for set-downs alone, and refuses every edit.
fn edit_checker(
    mut world: Option<edit::World>,
    mut set_downs: Option<(replica::tree::Rules, Minter)>,
    creator: Option<Arc<buildsafe::Creator>>,
    publisher: Arc<Publisher>,
    walkers: Arc<buildsafe::Moving>,
    events: Sender<Event>,
    entries: replica::rules::json::Value,
) -> R<Sender<CheckJob>> {
    let (tx, rx) = channel::<CheckJob>();
    // The Souls' kinds: the edit world's, else the engine's rules' (a world checking set-downs alone, #3604).
    let kinds = match (&world, &set_downs) {
        (Some(w), _) => w.kinds.clone(),
        (None, Some((r, _))) => r.kinds.clone(),
        (None, None) => BTreeMap::new(),
    };
    thread::Builder::new()
        .name("edit-check".into())
        .spawn(move || {
            let mut town = buildsafe::TownCopy::new(kinds.clone());
            loop {
                let next = match rx.recv_timeout(EDIT_IDLE) {
                    Err(RecvTimeoutError::Disconnected) => break,
                    Ok(CheckJob::Release(kept)) => {
                        drop(kept);
                        continue;
                    }
                    // B12b: only placing, on the surfaces kept with the edit; no check, plan, rebuild or map.
                    Ok(CheckJob::Reprepare(job)) => {
                        let (id, mut checked, bases) = *job;
                        let placed = match checked.4.as_mut() {
                            Some(maps) => maps.reprepare(&bases),
                            None => Err(Refused {
                                op: None,
                                name: "edit.body-stale",
                                detail: "prepared triangle differs".into(),
                            }),
                        };
                        let result = placed.map(|()| checked);
                        if events.send(Event::Edited(Box::new((id, result)))).is_err() {
                            break;
                        }
                        continue;
                    }
                    next => next,
                };
                // Each edit committed since, on the town; a copy that holds them all, for a town built whole.
                town.add(walkers.take());
                let edited = walkers.edited();
                let job = match next {
                    Ok(job) => job,
                    Err(_) => {
                        let copy = publisher.wait_for(edited, Duration::from_secs(1));
                        town.on(&copy, buildsafe::open_ground(&copy), true);
                        continue;
                    }
                };
                let (id, e, reserved) = match job {
                    CheckJob::Edit(id, e, reserved) => (id, e, reserved),
                    // A Soul's set-down (#3604): E4's plan, part and G2's rule on the town, off the clock; and, for a
                    // thing walkers go round, the walkers' maps from the same basis an edit's are prepared from.
                    CheckJob::SetDown(a) => {
                        let snapshot = walkers.current();
                        let needed = snapshot
                            .map
                            .as_ref()
                            .map_or(edited, |m| edited.max(m.version))
                            .max(a.planned);
                        let copy = publisher.wait_for(needed, Duration::from_secs(1));
                        let ground = buildsafe::open_ground(&copy);
                        let checked = match &mut set_downs {
                            _ if copy.version() < needed => Err(Refusal {
                                name: "edit.stale",
                                detail: "the published copy has not reached the map basis".into(),
                            }),
                            Some((rules, mint)) => {
                                let souls = buildsafe::souls(&copy, &kinds);
                                let bodies = buildsafe::judged(souls.clone(), &snapshot.bodies);
                                let t = town.on(&copy, ground, false);
                                crate::setdown::check(&a, &copy, t, rules, mint, &bodies, souls)
                            }
                            None => Err(Refusal {
                                name: "setdown-off",
                                detail: String::new(),
                            }),
                        };
                        let checked = checked.and_then(|c| {
                            let maps = match (&snapshot.map, c.walk) {
                                (Some(source), true) => {
                                    let p = sim::setdown::part(
                                        copy.header(),
                                        copy.version(),
                                        a.at,
                                        a.soul,
                                        Cause::Intent(a.id),
                                        c.entries.clone(),
                                    )?;
                                    let maps = buildsafe::PreparedMaps::prepare_part(
                                        &copy,
                                        Arc::new(p),
                                        source,
                                        &snapshot.movers,
                                    )
                                    .map_err(|r| Refusal {
                                        name: r.name,
                                        detail: r.detail,
                                    })?;
                                    Some(maps)
                                }
                                _ => None,
                            };
                            Ok((c, maps))
                        });
                        if events
                            .send(Event::SetDown(Box::new((a.id, checked))))
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    CheckJob::Reprepare(_) | CheckJob::Release(_) => continue,
                    CheckJob::Wear(request) => {
                        let request = *request;
                        let copy = publisher.wait_for(request.version, Duration::from_secs(1));
                        let result = request.check(&copy);
                        if events
                            .send(Event::Worn(Box::new((request, result))))
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                };
                let snapshot = walkers.current();
                let source = snapshot.map.as_ref();
                let needed = source
                    .as_ref()
                    .map_or(edited, |m| edited.max(m.version))
                    .max(e.planned);
                let copy = publisher.wait_for(needed, Duration::from_secs(1));
                let ground = buildsafe::open_ground(&copy);
                let Some(world) = world.as_mut() else {
                    let r = Err(Refused {
                        op: None,
                        name: "edit.not-the-creator",
                        detail: "the world takes no edits".into(),
                    });
                    if events.send(Event::Edited(Box::new((id, r)))).is_err() {
                        break;
                    }
                    continue;
                };
                let who = creator.as_ref().map_or(Some(world.creator), |c| c.get());
                let checked = match who {
                    _ if copy.version() < needed => Err(Refused {
                        op: None,
                        name: "edit.stale",
                        detail: "the published copy has not reached the map basis".into(),
                    }),
                    Some(c) => {
                        world.creator = c;
                        edit::check(e, &copy, world)
                    }
                    None => Err(Refused {
                        op: None,
                        name: "edit.not-the-creator",
                        detail: "the world's record names no creator".into(),
                    }),
                };
                let checked = checked
                    .and_then(|c| {
                        let known = town.on(&copy, ground, false).map(|t| Known::of(t));
                        // Planned with the ids the commit will mint, so its guard's ground is the map's (#3743).
                        sim::edit::plan_classes(
                            c,
                            &copy,
                            ground,
                            known.as_ref(),
                            snapshot.classes.values().copied(),
                            reserved.clone(),
                        )
                    })
                    .and_then(|mut p| {
                        let kept = p.take_map();
                        let places = crate::edit_places::Projection::prepare(&copy, &p, &entries)?;
                        let tree = buildsafe::souls(&copy, &world.kinds);
                        let souls = buildsafe::judged(tree, &snapshot.bodies);
                        let maps = source
                            .map(|source| {
                                buildsafe::PreparedMaps::prepare_classes(
                                    &copy,
                                    &p,
                                    kept,
                                    reserved.clone(),
                                    &souls,
                                    source,
                                    &snapshot.classes,
                                    &snapshot.movers,
                                )
                            })
                            .transpose()?;
                        Ok((p, souls, snapshot.classes.clone(), reserved, maps, places))
                    });
                if events.send(Event::Edited(Box::new((id, checked)))).is_err() {
                    break;
                }
            }
        })
        .map_err(io)?;
    Ok(tx)
}

/// `effects` numbered from the replica's next sequence, made one part and applied to it: the part, or the refusal.
fn applied(replica: &mut Replica, mut effects: Vec<Effect>) -> R<Part> {
    for (k, e) in effects.iter_mut().enumerate() {
        e.envelope.sequence = replica.version() + k as u64;
    }
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(replica.header().hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    encode(&v)
        .map_err(|e| Refusal {
            name: "encoding",
            detail: e.to_string(),
        })
        .and_then(|b| Part::read(&b))
        .and_then(|p| replica.apply(&p).map(|()| p))
}

/// The key of a frame to the gateway that carries Souls' wind-down words (#3784; gatewayd's `world_link` reads it):
/// `{30: [[grant bytes, word], ..]}`, sent only on a connection that asked with [`states_ask`]; the grant `soul-<scope hex>-<counter>` as the tokens file writes it, the word
/// `idle`, `zombie`, `asleep` or `awake`.
pub const STATES: u64 = 30;

/// The frame a gateway sends to be told the Souls' words: `{30: []}`.
pub fn states_ask() -> Vec<u8> {
    encode(&Value::Map(BTreeMap::from([(
        STATES,
        Value::Array(Vec::new()),
    )])))
    .unwrap_or_default()
}

/// A frame of Souls' words ([`STATES`]).
pub fn states_frame(words: &[(Id, &str)]) -> Vec<u8> {
    let rows = words
        .iter()
        .filter_map(|(soul, word)| {
            let grant = format!(
                "soul-{}-{}",
                replica::encode::to_hex(&soul.scope().0),
                soul.counter()
            );
            Some(Value::Array(vec![
                Value::Bytes(grant.into_bytes()),
                Value::Text(Name::new(word)?),
            ]))
        })
        .collect();
    encode(&Value::Map(BTreeMap::from([(STATES, Value::Array(rows))]))).unwrap_or_default()
}

/// Serves one connection of the gateway's local socket (I1's framing: a 4-byte big-endian length, then that many
/// bytes): each intent read goes through `world`'s door (stamped there, O4), each answer goes back on the same
/// connection, in the order sent.
pub fn serve(world: Door, mut stream: UnixStream) {
    let trace = std::env::var_os("SOULS_JOIN_DELIVERY_TRACE").is_some_and(|v| v == "1");
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
    let (reply, answers) = channel::<Vec<u8>>();
    let ask = states_ask();
    std::thread::spawn(move || {
        for frame in answers {
            delivery_trace(trace, "native-write-start", &frame, "ready");
            let len = u32::try_from(frame.len()).unwrap_or(u32::MAX).to_be_bytes();
            if out.write_all(&len).is_err() || out.write_all(&frame).is_err() {
                delivery_trace(trace, "native-write", &frame, "failed");
                return;
            }
            delivery_trace(trace, "native-write", &frame, "sent");
        }
    });
    loop {
        let mut len = [0u8; 4];
        if stream.read_exact(&mut len).is_err() {
            return;
        }
        let len = u32::from_be_bytes(len) as usize;
        // A creator's bulk edit (#3695) is the largest frame the gateway hands on; `Intent::read` keeps every other
        // intent to the frame limit.
        if len > BULK_MOST as usize {
            return;
        }
        let mut bytes = vec![0u8; len];
        if stream.read_exact(&mut bytes).is_err() {
            return;
        }
        // #3784: a gateway with a directory asks to be told the Souls' wind-down words, now and on each change.
        if bytes == ask {
            if world.events.send(Event::States(reply.clone())).is_err() {
                return;
            }
            continue;
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
    use replica::sync::{self, wire};
    use sim::log::{Mem, recover};
    use std::sync::{Condvar, Mutex};

    /// #3784: the frame of Souls' words names each by its grant, as the tokens file does, with its word.
    #[test]
    fn a3784_a_states_frame_names_each_soul_by_its_grant() {
        let soul = Id::new(Scope([0x4d; 16]), 3).unwrap();
        let frame = states_frame(&[(soul, "asleep"), (soul, "awake")]);
        let Value::Map(m) = decode(&frame).unwrap().value else {
            panic!("a map")
        };
        let Some(Value::Array(rows)) = m.get(&STATES) else {
            panic!("rows under STATES")
        };
        let grant = format!("soul-{}-3", "4d".repeat(16));
        assert_eq!(
            rows,
            &vec![
                Value::Array(vec![
                    Value::Bytes(grant.clone().into_bytes()),
                    Value::Text(Name::new("asleep").unwrap())
                ]),
                Value::Array(vec![
                    Value::Bytes(grant.into_bytes()),
                    Value::Text(Name::new("awake").unwrap())
                ]),
            ]
        );
    }

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
            reflex: false,
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
            reflex: false,
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

    /// #3695: a creator's weather is five plain sets on the world node; once committed, E6's weather event follows and
    /// its timer is due at the creator's end. A level over 100 is refused by name and changes nothing.
    #[test]
    fn a_creators_weather_commits_with_e6s_event_and_its_end_on_the_timer() {
        use replica::edit::wire::{VERB, parameters};
        use replica::edit::{Op, Ref};
        use replica::sky::{self, int};
        let store = Held::new(Vec::new());
        let w = toggles::World::build(1, 0, 0);
        let initial = w.replica.frozen();
        let root = w.replica.tree().node(w.replica.tree().root()).unwrap().id();
        let creator = Id::new(Scope([0xc0; 16]), 1).unwrap();
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.lockstep = true;
        cfg.measures = false;
        cfg.edits = Some(edit::World {
            creator,
            kinds: toggles::kinds(),
        });
        let cal = sky::Calendar {
            day_s: 86_400,
            origin: 0,
            offsets: vec![(0, 0)],
        };
        cfg.sky = Some(sim::daylight::Config::today(cal, 3695));
        let world = start(w.replica, toggles::rules(), store.clone(), cfg).unwrap();
        let until: i64 = 40 * 3_600_000_000;
        let weather = |rain: i64| {
            [
                (
                    sky::F_WEATHER,
                    Value::Text(Name::new("souls:storm").unwrap()),
                ),
                (sky::F_CLOUD, int(100)),
                (sky::F_RAIN, int(rain)),
                (sky::F_WIND, int(80)),
                (sky::F_WEATHER_UNTIL, int(until)),
            ]
            .into_iter()
            .map(|(field, to)| Op::Set {
                node: Ref::Node(root),
                field,
                to,
            })
            .collect::<Vec<_>>()
        };
        let intent = |sequence: u64, planned: u64, ops: &[Op]| Intent {
            actor: Actor::Creator(creator),
            verb: Name::new(VERB).unwrap(),
            target: None,
            parameters: parameters(ops),
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
            reflex: false,
        };
        // (kind, reason, the version the answer gives)
        let run = |i: Intent, tick: i64| {
            let rx = send(&world, &i);
            let (done, ran) = channel();
            world.events.send(Event::RunTo { tick, done }).unwrap();
            ran.recv().unwrap();
            let f = answer(&rx);
            let Value::Map(m) = decode(&f).unwrap().value else {
                panic!("a frame")
            };
            let Some(Value::Array(v)) = m.get(&1) else {
                panic!("a version")
            };
            let Some(Value::Uint(version)) = v.get(3) else {
                panic!("a sequence")
            };
            let (kind, reason, _) = read(&f);
            (kind, reason, *version)
        };
        // The sky's first start wrote the world node after version 0: planned before it, the batch is stale.
        let (kind, reason, now) = run(intent(1, 0, &weather(90)), 2);
        assert_eq!(
            (kind, reason),
            (2, Value::Text(Name::new("edit.stale").unwrap()))
        );
        let (kind, reason, now) = run(intent(2, now, &weather(101)), 4);
        assert_eq!(kind, 2, "a level of 101 is refused");
        assert_eq!(
            reason,
            Value::Text(Name::new("edit.weather-level").unwrap())
        );
        let (kind, _, _) = run(intent(3, now, &weather(90)), 6);
        assert_eq!(kind, 1, "the storm is set");
        world.stop();
        let mut live = initial;
        let mut events = Vec::new();
        for bytes in recover(&store.bytes()).unwrap().records {
            if !recorder::is_input(&bytes) {
                let part = replica::effects::Part::read(&bytes).unwrap();
                for e in &part.effects {
                    for ev in e.events.iter().flatten() {
                        events.push((e.envelope.actor, ev.name.as_str().to_owned()));
                    }
                }
                live.apply(&part).unwrap();
            }
        }
        let tree = live.tree();
        let node = tree.node(tree.root()).unwrap();
        let f = node.fields();
        assert_eq!(
            f.get(&sky::F_WEATHER),
            Some(&Value::Text(Name::new("souls:storm").unwrap()))
        );
        assert_eq!(f.get(&sky::F_RAIN), Some(&int(90)));
        assert_eq!(
            f.get(&sky::F_WEATHER_NEXT),
            Some(&int(until)),
            "the next change is the creator's end"
        );
        let due: Vec<_> = tree
            .timers()
            .iter()
            .filter(|(_, t)| t.name.as_str() == sky::T_WEATHER)
            .map(|(_, t)| t.due)
            .collect();
        assert_eq!(due, [until], "one weather timer, due at the end");
        assert_eq!(
            events.last().map(|(_, n)| n.as_str()),
            Some(sky::EV_WEATHER),
            "E6's weather event follows the creator's record"
        );
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

    /// K18d reservations are taken by recorded intake, independent of checker completion. Interleaved normal
    /// intents and refused edits never reuse those counters; replay and restart preserve published names.
    #[test]
    fn k18d_reservations_interleave_record_replay_and_recover_without_aliasing() {
        use replica::edit::wire::{VERB, parameters};
        use replica::edit::{Op, Ref, Spot};
        use replica::pose::{Quat, Support, Vec3};
        let fixture = toggles::World::build(1, 1, 0);
        let room = fixture
            .replica
            .tree()
            .children(fixture.replica.tree().root())
            .unwrap()[0];
        let room = fixture.replica.tree().node(room).unwrap().id();
        let kinds = toggles::kinds();
        let item = Name::new(kinds.keys().find(|k| k.starts_with("souls:item@")).unwrap()).unwrap();
        let creator = Id::new(Scope([0xc1; 16]), 1).unwrap();
        let place = |actor, sequence| Intent {
            actor,
            verb: Name::new(VERB).unwrap(),
            target: None,
            parameters: parameters(&[Op::Place {
                name: 1,
                kind: item.clone(),
                parent: Ref::Node(room),
                at: Spot {
                    slot: None,
                    position: Vec3::new(sequence as i64 * 1_000_000, 0, 0),
                    orientation: Quat::IDENTITY,
                    support: Support::None,
                },
                audience: Audience::Everyone,
                fields: BTreeMap::new(),
            }]),
            sequence,
            basis: Version {
                lineage: LINEAGE,
                zone: Id::new(LINEAGE, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: i64::MAX,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let cfg = || {
            let mut cfg = Config::new(LINEAGE, 1);
            cfg.lockstep = true;
            cfg.measures = false;
            cfg.edits = Some(edit::World {
                creator,
                kinds: kinds.clone(),
            });
            cfg
        };
        let scripted: Vec<(i64, Vec<u8>)> = vec![
            (
                1,
                encode(&place(Actor::Creator(creator), 1).to_value()).unwrap(),
            ),
            (
                1,
                encode(&toggle(fixture.pairs[0].0, fixture.pairs[0].1, 1, i64::MAX).to_value())
                    .unwrap(),
            ),
            (
                1,
                encode(
                    &place(Actor::Creator(Id::new(Scope([0xc2; 16]), 1).unwrap()), 1).to_value(),
                )
                .unwrap(),
            ),
            (
                3,
                encode(&place(Actor::Creator(creator), 2).to_value()).unwrap(),
            ),
        ];
        let execute = |script: &[(i64, Vec<u8>)]| {
            let store = Held::new(Vec::new());
            let world = start(
                toggles::World::build(1, 1, 0).replica,
                toggles::rules(),
                store.clone(),
                cfg(),
            )
            .unwrap();
            let answers: Vec<_> = script
                .iter()
                .map(|(tick, bytes)| {
                    let (reply, rx) = channel();
                    world
                        .events
                        .send(Event::ArrivalAt {
                            tick: *tick,
                            bytes: bytes.clone(),
                            reply,
                        })
                        .unwrap();
                    rx
                })
                .collect();
            let (done, ran) = channel();
            world.events.send(Event::RunTo { tick: 5, done }).unwrap();
            ran.recv_timeout(Duration::from_secs(30)).unwrap();
            let frames: Vec<_> = answers.iter().map(answer).collect();
            world.stop();
            (store.bytes(), frames)
        };
        let (logged, frames) = execute(&scripted);
        assert_eq!(
            frames.iter().map(|f| read(f).0).collect::<Vec<_>>(),
            [1, 1, 2, 1]
        );
        let answer_fields = |frame: &[u8]| {
            let Value::Map(mut frame) = decode(frame).unwrap().value else {
                panic!("frame")
            };
            let Value::Map(answer) = frame.remove(&2).unwrap() else {
                panic!("answer")
            };
            answer
        };
        let placed = |frame: &[u8]| {
            let fields = answer_fields(frame);
            let Value::Map(names) = &fields[&6] else {
                panic!("names")
            };
            replica::effects::read_id(&names[&1]).unwrap()
        };
        let first = placed(&frames[0]);
        let second = placed(&frames[3]);
        let normal = replica::effects::read_id(&answer_fields(&frames[1])[&4]).unwrap();
        assert_ne!(
            first, normal,
            "a normal intent cannot consume the in-flight edit's name"
        );
        assert!(
            second.counter() > normal.counter() + 2,
            "the refused edit's intent and reserved name leave distinct counters"
        );
        let records = recover(&logged).unwrap().records;
        let mut input_bytes = BTreeMap::new();
        for record in records.iter().filter(|r| !recorder::is_input(r)) {
            let part = Part::read(record).unwrap();
            let Some(Value::Array(rows)) = part.rest.get(&ANSWERED) else {
                continue;
            };
            for row in rows {
                let Value::Map(fields) = row else { continue };
                if let (Some(id), Some(input)) = (fields.get(&3), fields.get(&5)) {
                    input_bytes.insert(
                        replica::effects::read_id(id).unwrap(),
                        encode(input).unwrap(),
                    );
                }
            }
        }
        let replay: Vec<_> = recorder::inputs(&records)
            .unwrap()
            .into_iter()
            .flat_map(|(tick, inputs)| {
                inputs
                    .into_iter()
                    .filter_map(|input| match input {
                        Input::Intent { id, .. } => Some((tick as i64, input_bytes[&id].clone())),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(replay, scripted);
        let (again, replayed) = execute(&replay);
        assert_eq!(
            recorder::effect_hash(&records),
            recorder::effect_hash(&recover(&again).unwrap().records)
        );
        assert_eq!(placed(&replayed[0]), first);
        assert_eq!(placed(&replayed[3]), second);

        let store = Held::new(logged);
        let world = start(
            toggles::World::build(1, 1, 0).replica,
            toggles::rules(),
            store,
            cfg(),
        )
        .unwrap();
        let received = send(&world, &place(Actor::Creator(creator), 3));
        let (done, ran) = channel();
        world.events.send(Event::RunTo { tick: 8, done }).unwrap();
        ran.recv_timeout(Duration::from_secs(30)).unwrap();
        let after = placed(&answer(&received));
        assert!(
            after.counter() > second.counter(),
            "recovery does not reuse a published name"
        );
        world.stop();
        // A doorway's published name is a link, and its retirement must not make that name reusable.
        let fixture = toggles::World::build(1, 1, 0);
        let root = fixture
            .replica
            .tree()
            .node(fixture.replica.tree().root())
            .unwrap()
            .id();
        let link = Id::new(LINEAGE, 9_000).unwrap();
        let store = Held::new(Vec::new());
        let (mut log, _) = sim::log::Log::open(store.clone(), 1).unwrap();
        let mut admitted = fixture.replica.tree().frozen();
        let admitted_rules = replica::tree::Rules {
            kinds: toggles::kinds(),
            ..Default::default()
        };
        for (k, change) in [
            Change::Link {
                link,
                ty: Name::new("souls:tied-to").unwrap(),
                ends: [root, room],
                owner: replica::world_model::End::First,
                audience: Audience::Everyone,
            },
            Change::Unlink { link },
        ]
        .into_iter()
        .enumerate()
        {
            let effect = Effect {
                envelope: Envelope {
                    sequence: fixture.replica.version() + k as u64,
                    at: 0,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node: root,
                },
                body: Body::Changes(vec![ChangeRec {
                    change,
                    rest: BTreeMap::new(),
                }]),
                events: None,
                rest: BTreeMap::new(),
            };
            let bytes = encode(&Value::Map(BTreeMap::from([
                (1, Value::Bytes(fixture.replica.header().hash().to_bytes())),
                (2, Value::Array(vec![effect.to_value()])),
            ])))
            .unwrap();
            // Same canonical T6 link type as the tree fixtures; real entry/kind/endpoint/ownership rules apply.
            admitted
                .commit(
                    fixture.replica.header(),
                    &Part::read(&bytes).unwrap(),
                    &admitted_rules,
                )
                .unwrap();
            let record = log.append(bytes).unwrap();
            log.wait_durable(record).unwrap();
        }
        drop(log);
        let world = start(fixture.replica, toggles::rules(), store, cfg()).unwrap();
        let received = send(&world, &place(Actor::Creator(creator), 1));
        let (done, ran) = channel();
        world.events.send(Event::RunTo { tick: 2, done }).unwrap();
        ran.recv_timeout(Duration::from_secs(30)).unwrap();
        assert!(
            placed(&answer(&received)).counter() > link.counter(),
            "a retired published link name is never minted again after recovery"
        );
        world.stop();
        println!("K18d: reserved place/normal/refusal/replay/restart IDs remain distinct");
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

    // --- E7b (#3516): the clock's mapping on the zone root. ----------------------------------------------------

    /// The mapping the root record of a copy holds.
    fn root_mapping(copy: &sync::Copy, place: Id) -> Option<Mapping> {
        let rec = copy.record(copy.roots().get(&place)?)?;
        let Value::Map(m) = decode(rec).ok()?.value else {
            return None;
        };
        let Some(Value::Map(f)) = m.get(&6) else {
            return None;
        };
        Mapping::from_fields(f)
    }

    /// A lockstep lamps world at `rate`, run to tick `to`, then its root's mapping as a Soul's copy syncs it.
    fn clock_run(store: Held, rate: (i64, i64), to: i64) -> Option<Mapping> {
        let w = toggles::World::build(1, 4, 0);
        let place = w.replica.header().zone;
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.lockstep = true;
        cfg.measures = false;
        cfg.rate = Some(rate);
        let world = start(w.replica, toggles::rules(), store, cfg).expect("the world starts");
        let (done, ran) = channel();
        world.events.send(Event::RunTo { tick: to, done }).unwrap();
        ran.recv().unwrap();
        // A Soul's copy: the scope the world grants every actor is the place, the zone's root (`sync_by_frames`).
        let mut copy = sync::Copy::default();
        sync_by_frames(&world, &mut copy, place);
        world.stop();
        root_mapping(&copy, place)
    }

    #[test]
    fn w3b_a_mapped_free_running_fork_ticks_answers_and_restarts_without_a_gap() {
        // A filtered fork retains a world clock far below its real-time anchor and has no logged tick yet.
        struct MappedPace {
            real: Micros,
            zero: std::sync::OnceLock<Instant>,
        }
        impl Pace for MappedPace {
            fn now(&mut self) -> Micros {
                self.real + self.zero.get_or_init(Instant::now).elapsed().as_micros() as Micros
            }
            fn sleep_until(&mut self, _: Micros) {}
        }
        let real = 1_000_000_000_000;
        let first_mapping = Mapping::new(0, real - 1_000_000, 1, 1).unwrap();
        let mapping = Mapping::new(1_000_000, real, 1, 1).unwrap();
        let mappings = [first_mapping, mapping].map(TimeEffect::Mapping);
        let mut seed = toggles::World::build(1, 1, 0);
        let pair = seed.pairs[0];
        let effect = Effect {
            envelope: Envelope {
                sequence: seed.replica.version(),
                at: mapping.world_us,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node: seed.replica.header().zone,
            },
            body: Body::Time(mappings.to_vec()),
            events: None,
            rest: Rest::new(),
        };
        let part = Part::read(
            &encode(&Value::Map(BTreeMap::from([
                (1, Value::Bytes(seed.replica.header().hash().to_bytes())),
                (2, Value::Array(vec![effect.to_value()])),
            ])))
            .unwrap(),
        )
        .unwrap();
        seed.replica.apply(&part).unwrap();
        let store = Held::new(Vec::new());
        let mut last_logged = None;
        for restart in 0..2 {
            let mut cfg = Config::new(LINEAGE, 1);
            cfg.measures = true;
            cfg.rate = Some((1, 1));
            cfg.clock = Some(Box::new(MappedPace {
                real: real + restart * 1_000_000,
                zero: std::sync::OnceLock::new(),
            }));
            let world = start(seed.replica.frozen(), toggles::rules(), store.clone(), cfg).unwrap();
            let response = answer(&send(
                &world,
                &toggle(pair.0, pair.1, restart as u64 + 1, 60_000_000),
            ));
            let beat = Arc::clone(&world.beat);
            let measured = Arc::clone(world.measures.as_ref().unwrap());
            world.stop();
            // Joined clock: measures and heartbeat now describe exactly the same completed ticks.
            let beat = beat.read();
            let health = replica::rules::json::parse(&measured.health(0)).unwrap();
            let Some(replica::rules::json::Value::Int(count)) =
                health.get("ticks").and_then(|t| t.get("count"))
            else {
                panic!("actual completed tick count: {health:?}");
            };
            let first = last_logged.map_or(20, |tick| tick + 1);
            assert_eq!(
                *count,
                i128::from(beat.0 - first + 1),
                "every due tick runs, including idle catch-up"
            );
            assert_eq!(read(&response).0, 1, "mapped free-running act is admitted");
            assert!(beat.0 >= 20, "the mapped clock advances: {beat:?}");
            assert!(
                beat.0 <= mapping.world_at(beat.1).unwrap().div_euclid(50_000),
                "heartbeat never precedes its start on the preserved world line: {beat:?}"
            );
            last_logged = recover(&store.bytes())
                .unwrap()
                .records
                .iter()
                .filter(|bytes| !recorder::is_input(bytes))
                .filter_map(|bytes| match Part::read(bytes).unwrap().rest.get(&TICK) {
                    Some(Value::Uint(tick)) => Some(*tick as i64),
                    _ => None,
                })
                .next_back();
            assert!(last_logged.is_some(), "receipt's actual logged tick");
        }
        let mut replay = seed.replica.frozen();
        let mut ticks = Vec::new();
        for bytes in recover(&store.bytes()).unwrap().records {
            if recorder::is_input(&bytes) {
                continue;
            }
            let part = Part::read(&bytes).unwrap();
            if let Some(Value::Uint(tick)) = part.rest.get(&TICK) {
                ticks.push(*tick);
            }
            replay.apply(&part).unwrap();
        }
        assert_eq!(
            ticks.first(),
            Some(&20),
            "first tick is due on the preserved world line"
        );
        assert!(
            ticks.windows(2).all(|w| w[1] > w[0]),
            "persisted ticks increase; idle ticks need no record: {ticks:?}"
        );
        assert_eq!(replay.tree().time(), &mappings);
        let tree = replay.tree();
        assert_eq!(
            Mapping::from_fields(tree.node(tree.root()).unwrap().fields()),
            Some(mapping)
        );
    }

    #[test]
    fn e7b_a1_a3_the_mapping_is_on_the_root_with_its_effect_and_a_replay_gives_the_same() {
        let store = Held::new(Vec::new());
        let first = clock_run(store.clone(), (1, 1), 3);
        assert_eq!(first, Mapping::new(0, 0, 1, 1).ok(), "A1: a first start's");
        // A restart at another rate applies a new mapping, continuous with the last; one at the same rate writes none.
        let store = Held::new(store.bytes());
        let second = clock_run(store.clone(), (2, 1), 6).expect("A1: the new mapping");
        assert_eq!(second.rate(), Mapping::new(0, 0, 2, 1).unwrap().rate());
        let store = Held::new(store.bytes());
        assert_eq!(
            clock_run(store.clone(), (2, 1), 9),
            Some(second),
            "A1: kept"
        );
        let log = store.bytes();
        let parts: Vec<Part> = recover(&log)
            .unwrap()
            .records
            .iter()
            .filter(|r| !recorder::is_input(r))
            .map(|r| Part::read(r).unwrap())
            .collect();
        // A1: each mapping's time effect and the root's fields are in one part.
        let mut written = Vec::new();
        for p in &parts {
            let time: Vec<TimeEffect> = p
                .effects
                .iter()
                .filter_map(|e| match &e.body {
                    Body::Time(t) => Some(t.clone()),
                    _ => None,
                })
                .flatten()
                .collect();
            if time.is_empty() {
                continue;
            }
            let sets = p.effects.iter().any(|e| match &e.body {
                Body::Changes(c) => c.iter().any(|c| {
                    matches!(c.change, Change::Set { field, .. } if field == replica::time::F_CLOCK_WORLD)
                }),
                _ => false,
            });
            assert!(sets, "A1: the fields in the effect's part");
            written.extend(time);
        }
        let want = [first.unwrap(), second].map(TimeEffect::Mapping);
        println!("E7b A1: mappings written {written:?}");
        assert_eq!(written, want, "A1: one effect for each mapping applied");
        // A3: the log replayed onto the world as built gives the same root fields.
        let mut replayed = toggles::World::build(1, 4, 0).replica;
        for p in &parts {
            replayed.apply(p).unwrap();
        }
        let tree = replayed.tree();
        let root = tree.node(tree.root()).unwrap();
        assert_eq!(
            Mapping::from_fields(root.fields()),
            Some(second),
            "A3: the same on replay"
        );
    }
}

#[cfg(test)]
mod standing_order_carry_tests {
    use super::*;

    fn effect(intent: Id, ended: bool) -> Effect {
        Effect {
            envelope: Envelope {
                sequence: 0,
                at: 1,
                cause: Cause::Intent(intent),
                actor: Actor::Soul(intent),
                audience: Audience::Everyone,
                node: intent,
            },
            body: Body::Changes(Vec::new()),
            events: Some(vec![replica::effects::Event {
                name: name(if ended {
                    "souls:order-ended"
                } else {
                    "souls:order"
                }),
                fields: BTreeMap::from([
                    (1, intent.to_value()),
                    (
                        2,
                        Value::Text(name(if ended {
                            "souls:order-cancelled"
                        } else {
                            "souls:hold"
                        })),
                    ),
                ]),
                changes: Vec::new(),
                rest: Rest::new(),
            }]),
            rest: Rest::new(),
        }
    }

    #[test]
    fn carry_preserves_fifo_ignores_overlap_and_forgets_ended_orders() {
        let a = Id::new(Scope([0x73; 16]), 1).unwrap();
        let b = Id::new(Scope([0x73; 16]), 2).unwrap();
        let mut active = Vec::new();
        remember_orders(&mut active, &[effect(a, false), effect(b, false)]);
        remember_orders(&mut active, &[effect(a, false)]); // checkpoint/tail overlap is idempotent.
        assert_eq!(
            active.iter().map(|e| e.envelope.node).collect::<Vec<_>>(),
            vec![a, b]
        );
        let carry = Carry::of(&Sequences::default(), 1, Placed::new(), 0, &active);
        let bytes = carry.to_bytes();
        assert_eq!(Carry::read(&bytes).unwrap().orders, carry.orders);
        let Value::Map(mut old) = decode(&bytes).unwrap().value else {
            panic!("carry")
        };
        old.remove(&5);
        assert!(
            Carry::read(&encode(&Value::Map(old)).unwrap())
                .unwrap()
                .orders
                .is_empty(),
            "older carry reads without orders"
        );
        remember_orders(&mut active, &[effect(a, true)]);
        assert_eq!(
            active.iter().map(|e| e.envelope.node).collect::<Vec<_>>(),
            vec![b],
            "cancelled order cannot restart"
        );
    }
}

#[cfg(test)]
mod no_brick_tests {
    //! #3765 A4: the writer of an answered row against the log's reader, over many intent words.
    use super::*;

    /// Text the encoding allows (rule 6), so each word could arrive in an intent.
    const ALPHABET: &[u8] = b"abcdefgxyzABCZ0189_-.:/@";

    /// A tick record holding one answered row whose intent carries `word` as its verb and as a form argument.
    fn record(row_intent: Value) -> Vec<u8> {
        let row = Value::Map(BTreeMap::from([
            (1, Value::Bytes(vec![1])),
            (2, Value::Uint(1)),
            (4, Value::Bytes(vec![2])),
            (5, row_intent),
        ]));
        encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(Hash::of(Purpose::Header, b"h").to_bytes())),
            (2, Value::Array(Vec::new())),
            (ANSWERED, Value::Array(vec![row])),
        ])))
        .unwrap()
    }

    #[test]
    fn every_logged_intent_word_reads_back() {
        let mut seed: u64 = 0x3765;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let (mut names, mut not_names) = (0, 0);
        for _ in 0..20_000 {
            // Half the words are near-names: lowercase parts round one colon, as a client means them.
            let near = next() % 2 == 0;
            let alphabet: &[u8] = if near { b"abcxyz019_-" } else { ALPHABET };
            let len = 1 + (next() % 24) as usize;
            let mut word: String = (0..len)
                .map(|_| alphabet[(next() % alphabet.len() as u64) as usize] as char)
                .collect();
            if near {
                word.insert(0, 'a');
                word.insert(1 + (next() % len as u64) as usize, ':');
            }
            let text = Value::Text(Name::new(&word).expect("the alphabet is names' bytes"));
            let intent = Value::Map(BTreeMap::from([
                (2, text.clone()),
                (
                    4,
                    Value::Map(BTreeMap::from([(
                        1,
                        Value::Array(vec![Value::Array(vec![
                            Value::Bytes(b"thing".to_vec()),
                            text,
                        ])]),
                    )])),
                ),
            ]));
            // Intake's check and the reader agree: what intake passes, the reader reads as written.
            let raw = Part::read(&record(intent.clone()));
            let refused = replica::effects::not_a_name(&intent).is_some();
            assert_eq!(raw.is_err(), refused, "intake and reader agree on {word:?}");
            if refused {
                not_names += 1
            } else {
                names += 1
            }
            // The writer never logs what the reader refuses, and keeps a name as it is.
            let logged = logged_intent(intent.clone());
            Part::read(&record(logged.clone()))
                .unwrap_or_else(|r| panic!("{word:?} logged unreadable: {r}"));
            if !refused {
                assert_eq!(logged, intent, "a name is logged as written");
            }
        }
        assert!(
            names > 100 && not_names > 100,
            "both kinds tried: {names} names, {not_names} not"
        );
    }
}
