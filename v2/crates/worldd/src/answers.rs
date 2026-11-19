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
//! **A restart** replays the log: each record's entries are applied to the world as built, the receipts index and
//! each actor's last sequence and kept answers are rebuilt from it, and new intent ids follow the last one minted.
//! A repeat after a restart gets the answer it had; an intent that was open at the kill was never logged nor
//! answered, and is taken again when the gateway sends it again.
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
//! **Measures** (O4, #2694, `crate::measures`): each act carries its stamps from the socket to its answer, each
//! tick times its phases, and every queue its oldest item; the answers thread adds the block to each answer frame as
//! it leaves, after the tick's record is on the disk, so the logged answer never holds it. `health.json` is written
//! by its own thread. [`Config::measures`] off takes no stamps and adds no block.
//!
//! World time is the machine's clock in microseconds until the tick loop runs on K7's ticker ([`Config::now`]).
// worldd's real clock: the tick loop and world time read the machine's clocks until K7's ticker drives them.
#![allow(clippy::disallowed_methods)]

use crate::bodies::{self, Ask, Asked, Bodies};
use crate::checkers::{self, Act, Candidate, Rules, SpotAct};
use crate::measures::{self, Measures, Stamps};
use crate::words;
use replica::apply::Replica;
use replica::effects::{Actor, Body, Cause, Effect, Envelope, Event as Named, Part, Refusal};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Answer, INTENT_MOST, Intent, Target};
use replica::select::Answer as Answered;
use replica::select::Spot;
use replica::select::wire::SPOT;
use replica::sync::{self, Records, Served, wire};
use replica::time::Micros;
use replica::world_model::Audience;
use sim::commit::acts::{Deadlines, Receipts, Seen, Sequences, expired};
use sim::commit::spot::{self, Spot as Bound};
use sim::commit::{Checks, Outcome, commit, mark_clock_thread};
use sim::frozen::Publisher;
use sim::log::{Durable, Log, Storage};
use sim::text::Store;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type R<T> = Result<T, Refusal>;

/// Makes the world's bodies on the thread that steps them (a skill is not sent between threads).
pub type MakeBodies = Box<dyn FnOnce() -> R<Bodies> + Send>;

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
        /// Its stamps so far and its key in the arrivals queue (default when measures are off): see [`Door`].
        stamps: Stamps,
        key: u64,
    },
    Checked(Box<(Act, Checks)>),
    /// Holds the clock thread for this long: the stuck-thread run (O4 A4).
    Stall(Duration),
    Stop,
}

/// Where intents enter the world: stamps each as it is read, when measures are on.
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
    /// Stamps, the answers' block, tick phases and queue ages (O4). Off takes no stamps and adds no block.
    pub measures: bool,
    /// Where `health.json` is written every two seconds, when measures are on.
    pub health: Option<PathBuf>,
    /// World time (the machine's clock, [`now`]; a test gives a fixed one so two runs log the same bytes).
    pub now: fn() -> Micros,
    /// Makes the world's bodies, on the clock thread, for move intents (I4b, #3156); without them a move is refused
    /// `intent.not-a-form-on-a-node`.
    pub bodies: Option<MakeBodies>,
    /// K16's text store, where an intent's words are kept (V1b); a store in memory when none is given.
    pub text: Option<Arc<Store>>,
    /// Called once at start with the log's durable mark; what it gives is handed each record as it is appended (its
    /// number and bytes): a view tier's `offer`, so a stream writer follows the world (V1b).
    pub follow: Option<Follow>,
    /// The view tier, handed each tick's record once it is on the disk (#3292).
    pub views: Option<crate::views::served::Feed>,
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
            roots: None,
            measures: true,
            health: None,
            now,
            bodies: None,
            text: None,
            follow: None,
            views: None,
        }
    }
}

/// The running world: send it [`Event`]s; [`World::stop`] ends it once the answers already due are sent.
pub struct World {
    pub events: Sender<Event>,
    pub measures: Option<Arc<Measures>>,
    clock: Option<JoinHandle<()>>,
}

impl World {
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
    stamps: Stamps,
}

/// An answer to send once its tick is on the disk: to whom, its frame as logged, and its stamps.
type Out = (Vec<Reply>, Vec<u8>, Stamps);

/// One tick's record and the answers it releases once it is on the disk, with the tick's start and when it was
/// handed to the log (when measures are on).
struct Tick {
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
    replies: Vec<Out>,
    rows: Vec<Value>,
    measures: Option<Arc<Measures>>,
    effects: Vec<Effect>,
    parts: Vec<Arc<Part>>,
    bodies: Option<Bodies>,
    /// Move intents taken since the last tick, committed at the next (I4b).
    moving: Vec<(Id, Asked)>,
    /// K16's store, where words are kept (V1b).
    text: Arc<Store>,
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

    fn arrival(&mut self, bytes: &[u8], reply: Reply, mut stamps: Stamps, key: u64, now: Micros) {
        if let Some(m) = &self.measures {
            m.taken(key, &mut stamps);
        }
        if let Some(f) = self.sync(bytes) {
            let _ = self.answers.send(Tick {
                record: None,
                replies: Vec::new(),
                started: None,
                handed: None,
                bare: vec![(vec![reply], f)],
            });
            return;
        }
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
                    words::entry(form, &value, &kept, b, env)
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
        let taken = match (spotted, moved) {
            (Some(a), _) => a.map(Taken::Form),
            (None, Some(m)) => m.map(Taken::Move),
            (None, None) => act_of(&intent, self.next_intent, Cause::Intent(id)).map(Taken::Form),
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
        if let Some(m) = &self.measures {
            m.to_check(id.counter(), stamps.0[1]);
        }
        match taken {
            Taken::Form(act) => {
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

    /// The tick's moves (I4b): those taken since the last tick start, the bodies step to `now`, and each move that
    /// ended is answered: a receipt naming its entries when done, else its reason by name.
    fn moves(&mut self, now: Micros) {
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
        let Some(b) = self.bodies.as_mut() else {
            return;
        };
        for (id, how) in b.step(now) {
            self.settle(id, how, now);
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

    /// A check came back: kept for the next tick.
    fn checks_back(&mut self, act: Act, checks: Checks) {
        if let Some(m) = &self.measures {
            let open = Id::new(self.lineage, act.id).and_then(|id| self.open.get_mut(&id));
            m.checked(act.id, open.map(|o| &mut o.stamps));
        }
        self.checked.push((act, checks));
    }

    fn tick(&mut self, now: Micros) {
        let started = self.measures.as_ref().map(|_| measures::steady_us());
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
                    if let Some(m) = &self.measures {
                        m.left_tick(act.id);
                        m.to_check(act.id, None);
                    }
                    act.recheck = Some(version);
                    let _ = self.acts.send(act);
                }
                Outcome::Refused { reason } => {
                    self.end(id, |c| c.refusal(actor, sequence, &reason));
                }
            }
        }
        let committed = started.map(|_| measures::steady_us());
        self.moves(now);
        while let Some(id) = self.deadlines.due(now) {
            if let Some(b) = self.bodies.as_mut() {
                b.cancel(id);
            }
            if let Some(o) = self.open.get(&id) {
                let (actor, sequence) = (o.actor, o.sequence);
                self.end(id, |c| c.refusal(actor, sequence, "act.timed-out"));
            }
        }
        let deadlines = started.map(|_| measures::steady_us());
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
        let recorded = started.map(|_| measures::steady_us());
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
        let handed = started.map(|_| measures::steady_us());
        if let (Some(m), Some(t0), Some(t1), Some(t2), Some(t3), Some(t4)) = (
            &self.measures,
            started,
            committed,
            deadlines,
            recorded,
            handed,
        ) {
            let us = |a: u64, b: u64| b.saturating_sub(a);
            m.tick([us(t0, t1), us(t1, t2), us(t2, t3), us(t3, t4)]);
        }
        let replies = std::mem::take(&mut self.replies);
        if record.is_some() || !replies.is_empty() {
            let _ = self.answers.send(Tick {
                record,
                replies,
                started,
                handed,
                bare: Vec::new(),
            });
        }
    }
}

/// The answers thread: each tick's record appended and on the disk before its answers leave. A log that fails
/// stops it for good: nothing is answered that is not on the disk.
fn answer_loop<S: Storage + 'static>(
    mut log: Log<S>,
    ticks: Receiver<Tick>,
    measures: Option<Arc<Measures>>,
    mut follow: Option<Offer>,
    views: Option<crate::views::served::Feed>,
) {
    for (n, t) in ticks.into_iter().enumerate() {
        let n = n as u64;
        if let Some(m) = &measures {
            m.queues[measures::LOG].enter(n, t.handed.unwrap_or_else(measures::steady_us));
        }
        if let Some(record) = t.record {
            let kept = follow.as_ref().map(|_| record.clone());
            let copy = views.as_ref().map(|v| (v, record.clone()));
            let appended = log.append(record);
            if let (Ok(n), Some(f), Some(r)) = (&appended, follow.as_mut(), kept) {
                f(*n, r);
            }
            if let Err(e) = appended.and_then(|n| log.wait_durable(n + 1)) {
                eprintln!("worldd: the log failed, nothing more is answered: {e}");
                return;
            }
            if let Some((v, r)) = copy {
                v.record(r);
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
        for (waiters, frame) in t.bare {
            for w in waiters {
                let _ = w.send(frame.clone());
            }
        }
        if let Some(m) = &measures {
            m.queues[measures::LOG].leave(n);
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
    let mut cfg = cfg;
    let make = cfg.bodies.take();
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
    if let (Some(m), Some(path)) = (&measures, cfg.health) {
        measures::write_health(Arc::clone(m), path, measures::EVERY);
    }
    let text = match cfg.text.take() {
        Some(t) => t,
        None => Arc::new(crate::words::in_memory(cfg.lineage)?),
    };
    let follow = cfg.follow.take().map(|f| f(log.durable_mark()));
    let (answers, ticks) = channel();
    let (m, views) = (measures.clone(), cfg.views.take());
    let answering = thread::Builder::new()
        .name("answers".into())
        .spawn(move || answer_loop(log, ticks, m, follow, views))
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
        measures: clock_measures,
        bodies: None,
        moving: Vec::new(),
        text,
    };
    let tick = cfg.tick;
    let now = cfg.now;
    let clock = thread::Builder::new()
        .name("clock".into())
        .spawn(move || {
            mark_clock_thread();
            let mut c = build();
            if let Some(make) = make {
                match make() {
                    Ok(mut b) => {
                        b.begin(now());
                        c.bodies = Some(b);
                    }
                    Err(e) => eprintln!("worldd: the bodies did not start, moves are refused: {e}"),
                }
            }
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
                    Ok(Event::Arrival {
                        bytes,
                        reply,
                        stamps,
                        key,
                    }) => c.arrival(&bytes, reply, stamps, key, now()),
                    Ok(Event::Checked(k)) => {
                        let (act, checks) = *k;
                        c.checks_back(act, checks);
                    }
                    Ok(Event::Stall(d)) => thread::sleep(d),
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
        measures,
        clock: Some(clock),
    })
}

/// Serves one connection of the gateway's local socket (I1's framing: a 4-byte big-endian length, then that many
/// bytes): each intent read goes to `world`, each answer goes back on the same connection, in the order sent.
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

    /// A fixed world time, so two runs log the same bytes.
    fn fixed() -> Micros {
        1_000_000_000_000
    }

    /// The log of `acts` acts sent one at a time, each after the last's answer, with measures on or off.
    fn seeded_log(measures: bool, acts: u64) -> Vec<u8> {
        let store = Held::new(Vec::new());
        let w = toggles::World::build(1, 4, 0);
        let pairs = w.pairs.clone();
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.tick = Duration::from_millis(2);
        cfg.measures = measures;
        cfg.now = fixed;
        let world =
            start(w.replica, toggles::rules(), store.clone(), cfg).expect("the world starts");
        for s in 1..=acts {
            let (body, thing) = pairs[(s % 4) as usize];
            let f = answer(&send(
                &world,
                &toggle(body, thing, s / 4 + 1, fixed() + 60_000_000),
            ));
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
            200,
            "one record per act"
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
