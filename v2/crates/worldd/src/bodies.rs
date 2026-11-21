//! A committed move reaches the body (Engine v2 I4b, #3156): walk, sit, lie and rise from the gateway.
//!
//! [`crate::answers`] takes a move intent (a form's verb named `walk`, `sit`, `lie` or `rise`, as `eden:sit`; T10 rule 4
//! keeps `souls:` verbs for the engine's own) like any act: an id, a deadline and a place in the next tick. At that
//! tick it is committed here, and the body is driven only through what already moves bodies (`v2/docs/bodies.md`): a
//! walk is N7's walk skill run behind the host (`sim::host::Runner`, T9b/T9c), sent to a point (N9); a sit is B3's
//! reserved seat and B2's sit move (`sim::slots`, `sim::moves`); a lie is the same with B2's lie move and the stance
//! lie (C4, #3368); a rise is B3's rise. Each steps the one controller
//! (B1). Nothing here sets a pose or a position.
//!
//! - **Checked off the clock, committed on it** (K18b, #3175). A move's checks are its own: the controller's claims
//!   (T9 rule 4), the reach (B2), the seat free and in reach (B3), a route (N7). The route searches and the reach
//!   distances run on the world's planner thread (`sim::planner`), from the bodies as a tick left them, and come
//!   back for the next tick: a walk gets its place and legs a tick after it starts; a sit or a rise is committed at
//!   the first tick after its reach is back, a tick later than asked. The clock commits: the claims, and the seat
//!   held or free and the distance against the move's reach, as B3 reserves a seat: one tick's sits are taken
//!   together, in B3's stable order. A move refused there ends by that name.
//! - **A thing with several seats** (C19, #3457). A sit names a thing; the world picks its free slot whose stand point
//!   is nearest the body (`Slots::free`, ties by slot), so three Souls share a sofa, each in its own slot, and a fourth
//!   is refused `place-taken`. A walk to a thing with no point goes to that slot's stand point. A restart hands each
//!   seated body back into the slot its logged pose names.

//! - **Ends by name.** A walk ends when its skill does: done, or failed by name. A sit or a rise ends when its move
//!   does: `done`, or cancelled by name (`claim-taken`, `out-of-reach`). A new move on a body whose walk is still
//!   going ends that walk `claim-taken`.
//! - **World time.** Bodies step in ticks of their own, of the world's tick length, caught up to the clock's world
//!   time at each tick: a late tick steps them more than once, never skips a step. Move phases are timers on K9's due
//!   list, fired against the same time.
//!
//! - **In the log** (K18, #3160). Each tick's part lists the bodies whose pose changed ([`Bodies::moved`]), a body in
//!   a seat with its stance ([`row`]); a restart builds each where the log last had it standing
//!   ([`Bodies::add_body_at`]) and hands each that sat back into its seat ([`Bodies::seat_placed`], K18c #3176), so
//!   the seat is held in the slots table again and a rise or another sit sees it.
//!
//! - **Who hears** (#3369). After each step of the controller the bodies call `sim::speech::heard`, which brings every
//!   body's interest set up to date and gives each utterance the step started its hearers as they are then; the world
//!   writes each as `sim::speech::entry` says ([`Bodies::heard`]).
//!
//! Not here: I7's accept-then-resolve (one answer, at the move's end), plans (I9).

use sim::ground::Versions;
use sim::planner::{FormAnswer, FormKey, FormQuestion};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use replica::bodies::Family;
use replica::bodies::{Class, SkillShape, Want};
use replica::effects::Effect;
use replica::effects::{Actor, Refusal, fixture_bytes};
use replica::encode::{Name, Value, decode};
use replica::host::Progress;
use replica::ids::{Id, Minter, Scope};
use replica::intents::Intent;
use replica::move_check::{self, Seen, Verdict};
use replica::moves::{Effector, Move};
use replica::pose::Frame;
use replica::pose::{Pose, Support, Vec3};
use replica::select::{self, Spot};
use replica::speech::Said;
use replica::time::Micros;
use sim::commit::bind::{Bound, Slot, bind};
use sim::commit::spot;
use sim::controller::Stance;
use sim::controller::{Driver, Part};
use sim::host::Runner;
use sim::host::{Planned, ReachKey, ReachQuestion, Wants};
use sim::life::{Born, Life, Retired, Standing};
use sim::mover::Body as Moved;
use sim::moves::{Fired, Instance, Moves, Reach};
use sim::planner::{Planner, Thread};
use sim::slots::{PlaceAt, Request, Slots};
use sim::speech::{self, Hearing};
use sim::spots::Target;
use sim::timers::DueList;
use sim::walk::town::Town;
use skills::route::Route;
use skills::wind_down::{self, Do, Ground, Order, Phase, WindDown};

type R<T> = Result<T, Refusal>;

const SIT: &str = include_str!("../../replica/fixtures/moves/sit.diag");
const RISE: &str = include_str!("../../replica/fixtures/moves/rise.diag");
const LIE: &str = include_str!("../../replica/fixtures/moves/lie.diag");

/// A walk's speed, µm a second.
pub const WALK: i64 = 1_400_000;

pub use replica::move_check::Ask;

/// A move intent read: who moves, and what it asks, then its ranked fallbacks (moves of the same form on other
/// targets, C14 #3442).
#[derive(Clone, Debug)]
pub struct Asked {
    pub body: Id,
    pub actor: Actor,
    pub ask: Ask,
    pub fallbacks: Vec<Ask>,
}

/// Whether `v` is a form's arguments: a list of `[name, value]` pairs, a name as bytes.
fn form_args(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(a)) => a.first().is_some_and(
            |p| matches!(p, Value::Array(kv) if matches!(kv.first(), Some(Value::Bytes(_)))),
        ),
        _ => false,
    }
}

/// Reads a move intent (`replica::move_check::read`, the client's own reading): `None` when its verb is not a move,
/// else the ask and its fallbacks or the reason it is not one. A walk's point is parameter 1, `[x, y, z]` µm in its
/// target's frame.
pub fn read(intent: &Intent, body: Id) -> Option<Result<Asked, &'static str>> {
    // A sit naming a form's arguments (`[[name, value], ...]`, its seat) is the entry's own form, run by the form
    // runner with its walk (C17, #3453); a bare sit is the move.
    if matches!(intent.verb.as_str().split_once(':'), Some((ns, "sit")) if ns != "souls")
        && form_args(intent.parameters.get(&1))
    {
        return None;
    }
    Some(move_check::read(intent)?.map(|mut asks| {
        let ask = asks.remove(0);
        Asked {
            body,
            actor: intent.actor,
            ask,
            fallbacks: asks,
        }
    }))
}

#[derive(Clone, Copy, Debug)]
enum Live {
    Walk,
    Place(Instance),
}

/// Only the exact slot and pending move's planner answer may supply a reach check.
struct Reached<'a> {
    cache: &'a BTreeMap<ReachKey, [i64; 2]>,
    order: Option<Id>,
    slot: Option<u64>,
}

impl Reach for Reached<'_> {
    fn distance(
        &self,
        body: Id,
        _effector: &Effector,
        _part: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64> {
        let [place, stand] = self.cache.get(&(body, target, self.slot?, self.order?))?;
        match point.as_str() {
            "souls:slot" => Some(*place),
            "souls:stand" => Some(*stand),
            _ => None,
        }
    }
}

/// A sit or a rise asked, waiting for its reach from the planner: its intent, its body, the place (none for a rise
/// from no place).
#[derive(Clone, Copy, Debug)]
struct Waiting {
    id: Id,
    body: Id,
    place: Option<Id>,
    /// A sit's or a lie's stance; `None` for a rise.
    stance: Option<Stance>,
}

/// The world's bodies: a town, the runner of skills over it with the one controller, and the moves and seats.
pub struct Bodies {
    pub runner: Runner,
    pub town: Town,
    pub slots: Slots,
    pub orders: sim::orders::Orders,
    moves: Moves,
    due: DueList,
    mint: Minter,
    sit: Move,
    lie: Move,
    rise: Move,
    /// The move each body is doing for an intent.
    live: BTreeMap<Id, (Id, Live)>,
    /// Intents ended between steps (a walk replaced): the intent and how.
    ended: Vec<(Id, Result<(), String>)>,
    /// The candidate each started intent took: its rank in the ranked list and its target (C14).
    took: BTreeMap<Id, (usize, Option<Id>)>,
    /// Each body's pose as last written to the log ([`Bodies::moved`]).
    logged: BTreeMap<Id, Pose>,
    /// The planner thread: route searches and reach distances, off the clock (K18b, #3175).
    planner: Thread,
    /// How long a tick waits for each of the planner's batches: `None` as long as it takes (lockstep, the default),
    /// else a bound (a free-running clock never stops for the planner; a late batch is read at a later tick).
    pub wait: Option<Duration>,
    /// A replay's record of the planner (K18b): at these body times, take only this many batches (each other body
    /// tick takes every batch out, waiting as long as it takes). Read from the recorder's `Planned` inputs.
    pub schedule: BTreeMap<Micros, u64>,
    /// Where a free-running clock took fewer batches than were out, for the recorder: body time and batches taken.
    late: Vec<(Micros, u64)>,
    /// The planner's answers for the next tick.
    planned: Planned,
    pub(crate) form_map: Arc<Versions>,
    pub(crate) form_answers: BTreeMap<FormKey, FormAnswer>,
    pub(crate) form_questions: BTreeMap<FormKey, FormQuestion>,
    /// The reach distances last found, by body and seat.
    reached: BTreeMap<ReachKey, [i64; 2]>,
    /// Sits and rises waiting for their reach, in the order asked.
    waiting: Vec<Waiting>,
    /// Every body's interest set (B11, R4), kept as the bodies move.
    hearing: Hearing,
    /// The utterances started since the world last took them, each with its speaker, its record (hearers resolved
    /// when it started) and the world time it started: the world writes each.
    pub heard: Vec<(Id, Said, Micros)>,
    /// The wind-down (B16, #2751): the one rule by which the world moves a body its agent did not order.
    pub wind: WindDown,
    /// Its records since the world last took them, cause and actor the world.
    pub wind_log: Vec<Effect>,
    /// The rule's own move going on each body, by its intent id.
    wind_moves: BTreeMap<Id, Id>,
    /// Each body the rule put to sleep on the ground: the driver holding it lying.
    sleeping: BTreeMap<Id, Driver>,
}

/// Where the log last had each body: its pose, and its stance when that pose is in a seat's slot (K18, #3160;
/// K18c, #3176). What a restart builds its bodies at.
pub type Placed = BTreeMap<Id, (Pose, Option<Stance>)>;

/// A body's row in a tick's part (K18's `answers::BODIES`): `[body, pose]`, or `[body, pose, stance]` in a seat
/// (1 sit, 2 lie, 3 stand in a standing slot, #3598).
pub fn row(body: Id, pose: &Pose, stance: Option<Stance>) -> Value {
    let mut r = vec![body.to_value(), pose.to_value()];
    match stance {
        Some(Stance::Sit) => r.push(Value::Uint(1)),
        Some(Stance::Lie) => r.push(Value::Uint(2)),
        Some(Stance::Stand) => r.push(Value::Uint(3)),
        None => {}
    }
    Value::Array(r)
}

/// A row read back: the body, its pose and its stance in a seat.
pub fn read_row(v: &Value) -> Option<(Id, Pose, Option<Stance>)> {
    let Value::Array(p) = v else { return None };
    let (id, pose, rest) = match p.as_slice() {
        [id, pose, rest @ ..] => (id, pose, rest),
        _ => return None,
    };
    let stance = match rest {
        [Value::Uint(1)] => Some(Stance::Sit),
        [Value::Uint(2)] => Some(Stance::Lie),
        [Value::Uint(3)] => Some(Stance::Stand),
        _ => None,
    };
    Some((
        replica::effects::read_id(id).ok()?,
        Pose::from_value(pose).ok()?,
        stance,
    ))
}

fn load(text: &str) -> R<Move> {
    let v = decode(&fixture_bytes(text)?)
        .map_err(|e| Refusal {
            name: "move-unread",
            detail: e.to_string(),
        })?
        .value;
    Move::from_value(&v)
}

impl Bodies {
    /// No bodies yet, over `town`, stepped in ticks of `tick` µs.
    pub fn new(town: Town, tick: Micros) -> R<Bodies> {
        let copy = town.copy().map_err(|e| Refusal {
            name: "planner-town",
            detail: e,
        })?;
        Bodies::with_planner(town, copy, tick)
    }

    /// No bodies yet, over `town`, with `copy` (built by [`Town::copy`]) the planner's town (K18b): a world builds the
    /// copy with its town, before its clock and watchdog start, as a large town takes a while to build.
    pub fn with_planner(town: Town, copy: Town, tick: Micros) -> R<Bodies> {
        let planner = Thread::spawn(Planner::new(copy)).map_err(|e| Refusal {
            name: "planner-thread",
            detail: e.to_string(),
        })?;
        Ok(Bodies {
            planner,
            wait: None,
            schedule: BTreeMap::new(),
            late: Vec::new(),
            planned: Planned::default(),
            reached: BTreeMap::new(),
            waiting: Vec::new(),
            runner: Runner::new(tick),
            form_map: Arc::new(town.versions.clone()),
            form_answers: BTreeMap::new(),
            form_questions: BTreeMap::new(),
            town,
            slots: Slots::new(),
            orders: sim::orders::Orders::new(),
            moves: Moves::new(),
            due: DueList::new(),
            mint: Minter::new(Scope([0xb4; 16])),
            sit: load(SIT)?,
            lie: load(LIE)?,
            rise: load(RISE)?,
            live: BTreeMap::new(),
            ended: Vec::new(),
            took: BTreeMap::new(),
            logged: BTreeMap::new(),
            hearing: Hearing::new(),
            heard: Vec::new(),
            // A test world shortens the wind-down's clocks (seconds: wander, zombie, leg min, leg max, bound).
            wind: WindDown::new(
                std::env::var("WORLDD_WIND_DOWN")
                    .ok()
                    .and_then(|t| WindDown::knobs_from(&t))
                    .unwrap_or(wind_down::KNOBS),
            ),
            wind_log: Vec::new(),
            wind_moves: BTreeMap::new(),
            sleeping: BTreeMap::new(),
        })
    }

    /// Adds a body of `family`, standing as the mover placed it.
    pub fn add_body(&mut self, family: Family, body: Moved) -> R<()> {
        let id = body.id;
        self.runner.add_body(family, body)?;
        self.wind.add(id, self.runner.now);
        Ok(())
    }

    /// Adds a seat.
    pub fn add_place(&mut self, place: PlaceAt) -> R<()> {
        self.slots.add(place)
    }

    /// Where `body` is: the node of its frame (its floor, or the thing whose slot it sits in) and its position there.
    pub fn pose(&self, body: Id) -> Option<(Id, Vec3)> {
        let p = self.runner.controller.body(body)?.pose;
        Some((p.frame.node, p.position))
    }

    /// Adds a body of `family`: where the log last had it standing (`placed`, K18 #3160), else as the mover placed it.
    /// A body that sat is added standing as the mover placed it; [`Bodies::seat_placed`] then seats it.
    pub fn add_body_at(&mut self, family: Family, body: Moved, placed: &Placed) -> R<()> {
        let body = match placed.get(&body.id) {
            Some((p, _)) => match p.support {
                Support::Surface { surface, .. } => match self.town.surfaces.get(&surface) {
                    Some(s) => s.place(body.id, p.frame, p.position, p.orientation)?,
                    None => body,
                },
                _ => body,
            },
            None => body,
        };
        self.logged.insert(body.id, body.pose);
        self.add_body(family, body)
    }

    /// Restart, after the seats are added (K18c, #3176): each body the log last had in a seat's slot is handed back
    /// into that slot (its pose's frame names the thing and the slot, C19) from where it was added, at body time `at`,
    /// and its seat is held again. A seat gone or taken leaves it
    /// standing, named in the result.
    pub fn seat_placed(&mut self, placed: &Placed, at: Micros) -> Vec<(Id, Refusal)> {
        let mut out = Vec::new();
        for (&body, (pose, stance)) in placed {
            if pose.support != Support::Slot || self.runner.controller.body(body).is_none() {
                continue;
            }
            let r = self.slots.restore(
                &mut self.runner.controller,
                body,
                (pose.frame.node, pose.frame.slot),
                stance.unwrap_or(Stance::Sit),
                at,
            );
            match r {
                Ok(()) => {
                    if let Some(b) = self.runner.controller.body(body) {
                        self.logged.insert(body, b.pose);
                    }
                }
                Err(e) => out.push((body, e)),
            }
        }
        out
    }

    /// Every body the controller holds, in id order: those it steps and those resting in a seat's slot (which it keeps
    /// apart), a rising one included, each with its stance when in a slot.
    fn every(&self) -> Placed {
        let c = &self.runner.controller;
        c.ids()
            .filter_map(|id| {
                let b = c.body(id)?;
                let stance = match b.pose.support {
                    Support::Slot => self.slots.stance(id),
                    _ => self.sleeping.contains_key(&id).then_some(Stance::Lie),
                };
                Some((id, (b.pose, stance)))
            })
            .collect()
    }

    /// Where each body is now, a seated one with its stance: what a checkpoint carries (K18c, #3176).
    pub fn placed(&self) -> Placed {
        self.every()
    }

    /// The bodies whose pose changed since the last call, in id order, a body in a seat's slot with its stance: what
    /// the tick's record keeps of them (K18), so a restart stands each where it last stood or seats it again.
    pub fn moved(&mut self) -> Vec<(Id, Pose, Option<Stance>)> {
        let mut out = Vec::new();
        for (id, (pose, stance)) in self.every() {
            if !matches!(pose.support, Support::Surface { .. } | Support::Slot) {
                continue;
            }
            if self.logged.get(&id) != Some(&pose) {
                self.logged.insert(id, pose);
                out.push((id, pose, stance));
            }
        }
        out
    }

    /// Every body's pose as the controller holds it, in id order, a seated one's included (K18c): part of the zone's
    /// state hash.
    pub fn poses(&self) -> Vec<(Id, Pose)> {
        self.every()
            .into_iter()
            .map(|(id, (p, _))| (id, p))
            .collect()
    }

    /// Body time starts at world time `now`.
    pub fn begin(&mut self, now: Micros) {
        self.runner.now = now;
    }

    /// Ask each candidate slot with its own identity. Both contacts use the stand point across x/z (C17/C19),
    /// never seat height or another slot's geometry. Availability remains authoritative at commit.
    fn reach_of(&self, pairs: Vec<(Id, Id, Id)>) -> Vec<ReachQuestion> {
        let c = &self.runner.controller;
        let mut questions = Vec::new();
        for (body, thing, order) in pairs {
            let Some(p) = c.body(body).map(|b| b.pose) else {
                continue;
            };
            let at = match (p.support, self.slots.held_place(body)) {
                (Support::Slot, Some(s)) => match s.stand() {
                    Ok(p) => p,
                    Err(_) => continue,
                },
                _ => p.position,
            };
            for s in self.slots.places_of(thing) {
                let Ok(stand) = s.stand() else { continue };
                let stand = Vec3::new(stand.x, 0, stand.z);
                questions.push(ReachQuestion {
                    body,
                    at: Vec3::new(at.x, 0, at.z),
                    thing,
                    slot: s.place.slot,
                    order,
                    points: [stand, stand],
                });
            }
        }
        questions
    }

    /// Route searches the planner ran so far, off the clock (K18b).
    pub fn searched(&self) -> u64 {
        self.planner.searched
    }

    /// Body times and batch counts where a free-running clock took fewer of the planner's batches than were out, since
    /// the last call: the recorder's `Planned` inputs (K18b).
    pub fn late(&mut self) -> Vec<(Micros, u64)> {
        std::mem::take(&mut self.late)
    }

    /// The planner's answers taken for the next tick: those [`Bodies::schedule`] names for this body tick, else every
    /// batch out, waiting at most [`Bodies::wait`] for each; a shortfall is kept for the recorder.
    fn take(&mut self) {
        let at = self.runner.now;
        let mut p = match self.schedule.remove(&at) {
            Some(n) => self
                .planner
                .take_n(usize::try_from(n).unwrap_or(usize::MAX)),
            None => {
                let out = self.planner.pending();
                let p = self.planner.take(self.wait);
                let left = self.planner.pending();
                if left > 0 {
                    self.late.push((at, (out - left) as u64));
                }
                p
            }
        };
        // A replaced move's in-flight answer cannot be used by a newer order on the same body/fixture/slot.
        p.reach.retain(|(body, thing, slot, order), _| {
            self.waiting
                .iter()
                .any(|w| w.body == *body && w.place == Some(*thing) && w.id == *order)
                || (self
                    .live
                    .get(body)
                    .is_some_and(|(id, l)| id == order && matches!(l, Live::Place(_)))
                    && self
                        .slots
                        .held_place(*body)
                        .is_some_and(|p| p.thing == *thing && p.place.slot == *slot))
        });
        self.reached.extend(p.reach.iter().map(|(k, v)| (*k, *v)));
        for (key, answer) in std::mem::take(&mut p.forms) {
            if self
                .form_answers
                .get(&key)
                .is_none_or(|old| old.generation <= answer.generation)
            {
                self.form_answers.insert(key, answer);
            }
        }
        self.planned.merge(p);
    }

    /// A walk still going, or a sit or a rise still waiting for its reach, for an earlier intent gives way to a new
    /// move: it ends `claim-taken`.
    fn replace(&mut self, body: Id) {
        if let Some(k) = self.waiting.iter().position(|w| w.body == body) {
            let w = self.waiting.remove(k);
            self.ended.push((w.id, Err("claim-taken".into())));
        }
        if let Some(&(old, Live::Walk)) = self.live.get(&body) {
            self.runner.end_order(body);
            self.live.remove(&body);
            self.ended.push((old, Err("claim-taken".into())));
        }
    }

    /// Where a walk to `node` goes: `point` in its frame; with none, the stand point of `node`'s seat; else a free
    /// standing spot in `node` (C14): its middle by E2's shared library (`replica::select`, a client's answer at the
    /// same version), for N9's table to grant the nearest free legal standing spot to, the same every run.
    fn goal(&self, body: Id, node: Id, point: Option<Vec3>) -> R<Target> {
        if let Some(p) = point {
            return Ok(Target::new(node, p));
        }
        // The stand point of the free slot the world picks for `body` (C19), else of the thing's seat.
        let place = self
            .slots
            .free(&self.runner.controller, body, node)
            .and_then(|slot| self.slots.place_in(node, slot))
            .or_else(|| self.slots.place(node));
        if let Some(s) = place {
            return s.stand().map(|p| Target::new(s.floor, p));
        }
        let r = select::resolve(&self.town.tree, &Spot::Middle(node), None, &|_, _| false)?;
        match spot::once(&r) {
            spot::Spot::Stand(t) => Ok(t),
            spot::Spot::Slot { .. } => Err(refusal("move.no-point", node)),
        }
    }

    /// What the world knows of `ask` by `body`, for `replica::move_check::check`, the check a client runs (R8).
    fn seen(&self, body: Id, ask: &Ask) -> Seen {
        let t = ask.target();
        Seen {
            has: t.is_some_and(|t| {
                self.slots.place(t).is_some() || self.town.tree.handle(t).is_some()
            }),
            seated: Some(self.slots.held_by(body).is_some()),
            free: t.and_then(|t| {
                self.slots.place(t)?;
                Some(self.slots.free(&self.runner.controller, body, t).is_some())
            }),
        }
    }

    /// The candidate of `a`'s ranked list that is taken, and its rank (C14): a sit's or a lie's through I5's
    /// selector (`sim::commit::bind`, named slots: the first free one binds), a walk's the first with somewhere to go.
    fn bind(&self, a: &Asked) -> R<(usize, Ask)> {
        if a.fallbacks.is_empty() {
            return Ok((0, a.ask.clone()));
        }
        let list: Vec<&Ask> = std::iter::once(&a.ask).chain(&a.fallbacks).collect();
        match a.ask {
            Ask::Sit { .. } | Ask::Lie { .. } => {
                let slots: Vec<Slot> = list
                    .iter()
                    .filter_map(|k| k.target().map(Slot::Named))
                    .collect();
                let free = |t: Id| {
                    self.slots
                        .free(&self.runner.controller, a.body, t)
                        .is_some()
                };
                match bind(&slots, free, 0, true) {
                    Bound::Slot { rank, .. } => Ok((rank, list[rank].clone())),
                    Bound::Ended(n) => Err(Refusal {
                        name: n,
                        detail: format!("none of the {} free", slots.len()),
                    }),
                    Bound::Recheck { .. } => Err(refusal("place-taken", a.body)),
                }
            }
            Ask::Walk { .. } => {
                let mut last = None;
                for (rank, k) in list.iter().enumerate() {
                    if let Ask::Walk { node, point } = k {
                        match self.goal(a.body, *node, *point) {
                            Ok(_) => return Ok((rank, (*k).clone())),
                            Err(r) => last = Some(r),
                        }
                    }
                }
                Err(last.unwrap_or_else(|| refusal("move.no-point", a.body)))
            }
            Ask::Rise => Ok((0, Ask::Rise)),
        }
    }

    /// The candidate intent `id` took when it started, its rank in its ranked list and its target, read once.
    pub fn took(&mut self, id: Id) -> Option<(usize, Option<Id>)> {
        self.took.remove(&id)
    }

    /// Starts one tick's moves, each for its intent, at body time: refused ones come back with their reason by name.
    /// A ranked list is bound first, the move taken is checked as a client checks it (`replica::move_check`), then
    /// started (C14). A walk starts now (its place and legs come from the planner); a sit or a rise waits for its
    /// reach, and comes back from the first call after the planner found it (K18b).
    pub fn start(&mut self, asks: Vec<(Id, Asked)>) -> Vec<(Id, R<()>)> {
        let mut out = Vec::new();
        let mut asked = Vec::new();
        for (id, a) in asks {
            if self.runner.controller.body(a.body).is_none() {
                out.push((id, Err(refusal("body-unknown", a.body))));
                continue;
            }
            let (rank, ask) = match self.bind(&a) {
                Ok(t) => t,
                Err(r) => {
                    out.push((id, Err(r)));
                    continue;
                }
            };
            if let Verdict::No(n) = move_check::check(&ask, &self.seen(a.body, &ask)) {
                out.push((id, Err(refusal(n, ask.target().unwrap_or(a.body)))));
                continue;
            }
            self.took.insert(id, (rank, ask.target()));
            match ask {
                Ask::Walk { node, point } => {
                    let goal = self.goal(a.body, node, point);
                    self.replace(a.body);
                    let walk = Box::new(Route::sent(WALK, self.runner.tick));
                    let r = goal.and_then(|g| self.runner.send(a.body, walk, g, id));
                    if r.is_ok() {
                        self.live.insert(a.body, (id, Live::Walk));
                    }
                    out.push((id, r));
                }
                Ask::Sit { thing } => {
                    self.replace(a.body);
                    asked.push(Waiting {
                        id,
                        body: a.body,
                        place: Some(thing),
                        stance: Some(Stance::Sit),
                    });
                }
                Ask::Lie { thing } => {
                    self.replace(a.body);
                    asked.push(Waiting {
                        id,
                        body: a.body,
                        place: Some(thing),
                        stance: Some(Stance::Lie),
                    });
                }
                Ask::Rise => {
                    self.replace(a.body);
                    let place = self.slots.held_by(a.body);
                    asked.push(Waiting {
                        id,
                        body: a.body,
                        place,
                        stance: None,
                    });
                }
            }
        }
        // The asks waiting from earlier ticks whose reach is back are committed; the new asks' reach goes to the
        // planner, for a later tick.
        out.extend(self.commit_waiting());
        let pairs: Vec<(Id, Id, Id)> = asked
            .iter()
            .filter_map(|w| Some((w.body, w.place?, w.id)))
            .collect();
        self.reached
            .retain(|(body, _, _, _), _| !asked.iter().any(|w| w.body == *body));
        if !pairs.is_empty() {
            let reach = self.reach_of(pairs);
            self.planner.send(Wants {
                reach,
                ..Wants::default()
            });
        }
        self.waiting.extend(asked);
        out
    }

    /// Commits the sits and rises whose reach the planner has found since they were asked: the rises in the order
    /// asked, then the sits together in B3's stable order.
    fn commit_waiting(&mut self) -> Vec<(Id, R<()>)> {
        let now = self.runner.now;
        let mut out = Vec::new();
        let (ready, still): (Vec<Waiting>, Vec<Waiting>) = std::mem::take(&mut self.waiting)
            .into_iter()
            // Ready: its reach is back, or there is none to ask (no such seat or body: B3 refuses it by name).
            .partition(|w| {
                w.place.is_none_or(|t| {
                    self.slots
                        .places_of(t)
                        .filter(|p| p.stand().is_ok())
                        .all(|p| self.reached.contains_key(&(w.body, t, p.place.slot, w.id)))
                        || self.reach_of(vec![(w.body, t, w.id)]).is_empty()
                })
            });
        self.waiting = still;
        let mut sits = Vec::new();
        for w in ready {
            if let (Some(stance), Some(thing)) = (w.stance, w.place) {
                sits.push((w.id, w.body, thing, stance));
                continue;
            }
            let reach = Reached {
                cache: &self.reached,
                order: Some(w.id),
                slot: self.slots.held_place(w.body).map(|p| p.place.slot),
            };
            let r = self.slots.rise(
                &mut self.runner.controller,
                &mut self.due,
                &mut self.mint,
                &mut self.moves,
                &reach,
                w.body,
                &self.rise,
                now,
            );
            out.push((w.id, self.started(w.id, w.body, r)));
        }
        // Preserve C19's stable request order and nearest currently free slot; each distance is keyed to that slot.
        sits.sort_by_key(|s| (s.1, s.2));
        for (id, body, thing, stance) in sits {
            let slot = self.slots.free(&self.runner.controller, body, thing);
            let reach = Reached {
                cache: &self.reached,
                order: Some(id),
                slot,
            };
            let request = Request {
                body,
                thing,
                slot,
                mv: if stance == Stance::Lie {
                    &self.lie
                } else {
                    &self.sit
                },
                stance,
            };
            let r = self
                .slots
                .commit(
                    &mut self.runner.controller,
                    &mut self.due,
                    &mut self.mint,
                    &mut self.moves,
                    &reach,
                    &[request],
                    now,
                )
                .pop()
                .map_or_else(|| Err(refusal("place-unknown", thing)), |(_, r)| r);
            out.push((id, self.started(id, body, r)));
        }
        out
    }

    fn started(&mut self, id: Id, body: Id, r: R<Instance>) -> R<()> {
        let n = r?;
        self.live.insert(body, (id, Live::Place(n)));
        Ok(())
    }

    /// Steps the bodies to world time `now`, a tick at a time, firing each move's phase timers as they fall due.
    /// Returns the intents whose moves ended: done, or the reason by name.
    pub fn step(&mut self, now: Micros) -> Vec<(Id, Result<(), String>)> {
        let mut out = std::mem::take(&mut self.ended);
        while self.runner.now + self.runner.tick <= now {
            // The planner's answers to the last tick's wants (K18b): this tick reads them.
            self.take();
            // The tick's order (K18, #3160): due timers first, at the tick's start, then the skills through the
            // host and the controller.
            let at = self.runner.now;
            while let Some(t) = self.due.fire(at + 1) {
                let reach = Reached {
                    cache: &self.reached,
                    order: self.live.get(&t.node).map(|(id, _)| *id),
                    slot: self.slots.held_place(t.node).map(|p| p.place.slot),
                };
                let fired = self.slots.fire(
                    &mut self.runner.controller,
                    &mut self.due,
                    &mut self.mint,
                    &mut self.moves,
                    &reach,
                    &self.town.surfaces,
                    &t,
                );
                let Some(&(id, Live::Place(n))) = self.live.get(&t.node) else {
                    continue;
                };
                if self.moves.record(n).is_some() {
                    continue;
                }
                let how = match &fired {
                    Some((Fired::Done(r) | Fired::Cancelled(r), _)) => r
                        .ended
                        .as_ref()
                        .map_or("cancelled".into(), |e| e.how.as_str().to_owned()),
                    Some((_, Some(Err(r)))) => r.name.to_owned(),
                    _ => "cancelled".into(),
                };
                self.live.remove(&t.node);
                out.push((id, if how == "done" { Ok(()) } else { Err(how) }));
            }
            // A refusal of one body's input is the controller's and leaves the others going; its walk ends by name.
            // A skill that panics is ended by K11's wrapper in the runner (`unit-panicked`); the tick goes on.
            crate::orders::step(self, at);
            self.wind_step(at);
            let planned = std::mem::take(&mut self.planned);
            let (mut wants, _) = self.runner.tick_planned(&mut self.town, &planned);
            // Every body in a seat move, with its seat: its reach for the next tick's phase timers.
            let seated: Vec<(Id, Id, Id)> = self
                .live
                .iter()
                .filter(|(_, (_, l))| matches!(l, Live::Place(_)))
                .filter_map(|(b, (id, _))| Some((*b, self.slots.held_by(*b)?, *id)))
                .collect();
            wants.reach = self.reach_of(seated);
            // One metadata snapshot per map revision, shared by all form questions in the batch.
            if *self.form_map != self.town.versions {
                self.form_map = Arc::new(self.town.versions.clone());
                self.form_answers.clear();
            }
            wants.form_map = Some(Arc::clone(&self.form_map));
            wants.forms = std::mem::take(&mut self.form_questions)
                .into_values()
                .collect();
            self.planner.send(wants);
            // Who hears each utterance the step started, as the bodies stand after it (B11, #3369): every body in the
            // zone, a seated or lying one included (#3393).
            let said = std::mem::take(&mut self.runner.said);
            let c = &self.runner.controller;
            let ids: Vec<Id> = c.ids().collect();
            let at = self.runner.now;
            for (speaker, s) in speech::heard(&mut self.hearing, c.near(), ids, &said) {
                self.heard.push((speaker, s, at));
            }
            let walks: Vec<(Id, Id)> = self
                .live
                .iter()
                .filter(|(_, (_, l))| matches!(l, Live::Walk))
                .map(|(b, (id, _))| (*b, *id))
                .collect();
            for (body, id) in walks {
                let how = match self.runner.ended.get(&body) {
                    Some((_, Progress::Done)) => Ok(()),
                    Some((_, Progress::Failed(n))) => Err(n.as_str().to_owned()),
                    Some((_, Progress::Going)) => continue,
                    None if self.runner.running(body) => continue,
                    None => Err("claim-taken".to_owned()),
                };
                self.live.remove(&body);
                out.push((id, how));
            }
        }
        out
    }

    /// The moves that ended between steps (a walk replaced by a new move, `claim-taken`), taken now, so the world
    /// writes each ending in the tick its walk stopped.
    pub fn replaced(&mut self) -> Vec<(Id, Result<(), String>)> {
        std::mem::take(&mut self.ended)
    }

    /// Intent `id` ended (its deadline passed): its walk stops where the body is, now ([`Cut::Stopped`]). A sit, a lie
    /// or a rise is short and runs to its end, so a seat is never left half taken ([`Cut::Finishing`]): the world
    /// ends the act when its move ends. `None`: no move is going for it.
    pub fn cancel(&mut self, id: Id) -> Option<Cut> {
        self.waiting.retain(|w| w.id != id);
        let (&body, &(_, live)) = self.live.iter().find(|(_, (i, _))| *i == id)?;
        if !matches!(live, Live::Walk) {
            return Some(Cut::Finishing);
        }
        self.runner.end_order(body);
        self.live.remove(&body);
        Some(Cut::Stopped)
    }

    /// Births into this world's controller (K10, C3 #3367): the births `life` takes at world time `now`, each body
    /// posed at a standing place of `standing` the town's ground holds.
    pub fn births(
        &mut self,
        life: &mut Life,
        now: Micros,
        standing: &impl Standing,
        family: &Family,
    ) -> Vec<Born> {
        let born = life.tick(now, &mut self.runner, &self.town.surfaces, standing, family);
        for b in &born {
            self.wind.add(b.body, now);
        }
        born
    }

    /// Retires `soul`'s body by K10's one path at world time `at` ([`Life::retire`]): its seat freed, its timers and
    /// its run ended, the body out of the controller; and the intent it was moving for, if any, which then ends.
    pub fn retire(&mut self, life: &mut Life, soul: Id, at: Micros) -> R<(Retired, Option<Id>)> {
        let r = life.retire(
            soul,
            at,
            &mut self.runner,
            &mut self.slots,
            &mut self.moves,
            &mut self.due,
        )?;
        let open = self.live.remove(&r.body).map(|(intent, _)| intent);
        self.logged.remove(&r.body);
        self.wind.remove(r.body);
        self.wind_moves.remove(&r.body);
        self.sleeping.remove(&r.body);
        Ok((r, open))
    }
}

/// The wind-down's view of the world (B16, #2751): the bodies as the controller holds them and the open ground.
struct WindGround<'a> {
    b: &'a Bodies,
}

/// How near another body a spot may be, µm: room to stand, and room to lie down.
const ROOM: i64 = 800_000;
const ROOM_LYING: i64 = 1_500_000;

impl Ground for WindGround<'_> {
    fn at(&self, body: Id) -> Option<[i64; 2]> {
        let p = self.b.runner.controller.body(body)?.pose;
        if !matches!(p.support, Support::Surface { .. }) || p.frame.slot.is_some() {
            return None;
        }
        if p.frame.node == self.b.town.ground {
            return Some([p.position.x, p.position.z]);
        }
        // On a building's floor: where that is on the open ground.
        let place = self
            .b
            .town
            .buildings
            .iter()
            .find(|bl| bl.floors.contains_key(&p.frame.node))?
            .place;
        let q = place.point(p.position).ok()?;
        Some([q.x, q.z])
    }

    fn held(&self, body: Id) -> bool {
        let c = &self.b.runner.controller;
        self.b.orders.open(body).is_some()
            || self.b.waiting.iter().any(|w| w.body == body)
            || self
                .b
                .live
                .get(&body)
                .is_some_and(|(id, _)| self.b.wind_moves.get(&body) != Some(id))
            || c.carried(body)
            || c.carrying(body).is_some()
    }

    fn walking(&self, body: Id) -> bool {
        self.b.wind_moves.get(&body).is_some_and(|id| {
            self.b
                .live
                .get(&body)
                .is_some_and(|(i, l)| i == id && matches!(l, Live::Walk))
        })
    }

    fn aboard(&self, body: Id) -> bool {
        self.b.runner.controller.body(body).is_some_and(|m| {
            matches!(
                m.pose.support,
                Support::Track | Support::Volume { .. } | Support::None
            )
        })
    }

    fn clear(&self, p: [i64; 2], lying: bool) -> bool {
        let room = if lying { ROOM_LYING } else { ROOM };
        self.outdoors(p)
            && self.b.runner.controller.bodies().all(|m| {
                let q = m.pose.position;
                m.pose.frame.node != self.b.town.ground
                    || (i128::from(q.x - p[0])).pow(2) + (i128::from(q.z - p[1])).pow(2)
                        >= i128::from(room).pow(2)
            })
    }

    fn outdoors(&self, p: [i64; 2]) -> bool {
        let ground = self.b.town.ground;
        self.b.town.surfaces.get(&ground).is_some_and(|s| {
            let frame = Frame {
                node: ground,
                slot: None,
            };
            s.place(
                ground,
                frame,
                Vec3::new(p[0], 0, p[1]),
                replica::pose::Quat::IDENTITY,
            )
            .is_ok()
        })
    }

    fn centre(&self) -> [i64; 2] {
        let mut n = 0i128;
        let (mut x, mut z) = (0i128, 0i128);
        for bl in &self.b.town.buildings {
            x += i128::from(bl.place.pos.x);
            z += i128::from(bl.place.pos.z);
            n += 1;
        }
        if n == 0 {
            return [0, 0];
        }
        [
            i64::try_from(x / n).unwrap_or(0),
            i64::try_from(z / n).unwrap_or(0),
        ]
    }
}

fn asleep_shape() -> SkillShape {
    SkillShape {
        name: Name::new("souls:asleep").unwrap_or_else(|| unreachable!("a literal name")),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: vec![],
        cancelled_by: vec![],
    }
}

impl Bodies {
    /// The wind-down's moves due at body time `at` (B16): each through the moves every intent takes (a rise, N7's
    /// walk to a point on the open ground), or a lie where the body stands; each written as the world's record.
    /// Nothing is read when nothing is due: a sleeping body costs no tick time.
    fn wind_step(&mut self, at: Micros) {
        if self.wind.next().is_none_or(|t| t > at) {
            return;
        }
        let mut wind = std::mem::take(&mut self.wind);
        let orders = wind.step(at, &WindGround { b: self });
        self.wind = wind;
        for o in orders {
            self.wind_do(&o, at);
        }
    }

    fn wind_do(&mut self, o: &Order, at: Micros) {
        let body = o.body;
        for d in &o.what {
            match *d {
                Do::Stop => {
                    if let Some(id) = self.wind_moves.remove(&body) {
                        self.cancel(id);
                    }
                }
                Do::Stand => {
                    self.wake_ground(body);
                    if self.slots.held_by(body).is_some() {
                        self.wind_move(body, Ask::Rise);
                    }
                }
                Do::Walk([x, z]) => {
                    let node = self.town.ground;
                    self.wind_move(
                        body,
                        Ask::Walk {
                            node,
                            point: Some(Vec3::new(x, 0, z)),
                        },
                    );
                }
                Do::Lie => self.lie_ground(body),
            }
        }
        if let Some(s) = self.wind.state(body) {
            let e = wind_down::record(o, s, at, 0);
            self.wind_log.push(e);
        }
    }

    /// One move of the rule's, by the path every move intent takes ([`Bodies::start`]), under a fresh id.
    fn wind_move(&mut self, body: Id, ask: Ask) {
        let Ok(id) = self.mint.mint() else { return };
        let started = self.start(vec![(
            id,
            Asked {
                body,
                actor: Actor::World,
                ask,
                fallbacks: Vec::new(),
            },
        )]);
        if started.iter().all(|(_, r)| r.is_ok()) {
            self.wind_moves.insert(body, id);
        }
    }

    /// The body lies down where it stands on the ground and is held lying, with no end.
    fn lie_ground(&mut self, body: Id) {
        if self.sleeping.contains_key(&body) || self.slots.held_by(body).is_some() {
            return;
        }
        let c = &mut self.runner.controller;
        if let Ok(d) = c.claim(body, &asleep_shape()) {
            if c.set(body, d, Part::Stance(Stance::Lie)).is_ok() {
                self.sleeping.insert(body, d);
                // Its row carries the lying stance from this tick.
                self.logged.remove(&body);
            } else {
                let _ = c.release(body, d);
            }
        }
    }

    /// A body the rule held lying stands where it is.
    fn wake_ground(&mut self, body: Id) {
        if let Some(d) = self.sleeping.remove(&body) {
            let _ = self.runner.controller.release(body, d);
            self.logged.remove(&body);
        }
    }

    /// Its agent acted at `now` (B16 A2): a body the rule held is let go on this tick, its walk stopped where it is and
    /// its lie ended, so the act runs; the world writes that it woke.
    pub fn agent_acted(&mut self, body: Id, now: Micros) {
        if self.wind.acted(body, now).is_none() {
            return;
        }
        if let Some(id) = self.wind_moves.remove(&body) {
            self.cancel(id);
        }
        self.wake_ground(body);
        if let Some(s) = self.wind.state(body) {
            let o = Order {
                body,
                phase: Phase::Woken,
                what: Vec::new(),
            };
            self.wind_log.push(wind_down::record(&o, s, now, 0));
        }
    }

    /// Restart (B16): the rule rebuilt from the records and agent acts replayed (`body_of` names a Soul's body), every
    /// body in the controller; a body asleep lies down again where it was.
    /// A body `placed` has lying on the ground (only the rule lays one there) with no record since the checkpoint is
    /// asleep.
    pub fn wind_resume<'a>(
        &mut self,
        effects: impl IntoIterator<Item = &'a Effect>,
        body_of: impl Fn(Id) -> Option<Id>,
        placed: &Placed,
        now: Micros,
    ) {
        let ids: Vec<Id> = self.runner.controller.ids().collect();
        self.wind.resume(effects, body_of, ids.iter().copied(), now);
        for (body, (pose, stance)) in placed {
            if *stance == Some(Stance::Lie)
                && matches!(pose.support, Support::Surface { .. })
                && self.wind.state(*body).is_some_and(|s| s.wander.is_none())
            {
                self.wind
                    .asleep(*body, [pose.position.x, pose.position.z], now);
            }
        }
        for body in ids {
            if self.wind.state(body).is_some_and(|s| s.slept) {
                self.lie_ground(body);
            }
        }
    }
}

/// What ending an intent did to its move ([`Bodies::cancel`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cut {
    /// Its walk stopped where the body stands.
    Stopped,
    /// Its sit, lie or rise runs to its end, a few seconds at most.
    Finishing,
}

fn refusal(name: &'static str, node: Id) -> Refusal {
    Refusal {
        name,
        detail: replica::world_model::show(node),
    }
}
