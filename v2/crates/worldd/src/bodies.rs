//! A committed move reaches the body (Engine v2 I4b, #3156): walk, sit and rise from the gateway.
//!
//! [`crate::answers`] takes a move intent (a form's verb named `walk`, `sit` or `rise`, as `eden:sit`; T10 rule 4
//! keeps `souls:` verbs for the engine's own) like any act: an id, a deadline and a place in the next tick. At that
//! tick it is committed here, and the body is driven only through what already moves bodies (`v2/docs/bodies.md`): a
//! walk is N7's walk skill run behind the host (`sim::host::Runner`, T9b/T9c), sent to a point (N9); a sit is B3's
//! reserved seat and B2's sit move (`sim::slots`, `sim::moves`); a rise is B3's rise. Each steps the one controller
//! (B1). Nothing here sets a pose or a position.
//!
//! - **Checked off the clock, committed on it** (K18b, #3175). A move's checks are its own: the controller's claims
//!   (T9 rule 4), the reach (B2), the seat free and in reach (B3), a route (N7). The route searches and the reach
//!   distances run on the world's planner thread (`sim::planner`), from the bodies as a tick left them, and come
//!   back for the next tick: a walk gets its place and legs a tick after it starts; a sit or a rise is committed at
//!   the first tick after its reach is back, a tick later than asked. The clock commits: the claims, and the seat
//!   held or free and the distance against the move's reach, as B3 reserves a seat: one tick's sits are taken
//!   together, in B3's stable order. A move refused there ends by that name.
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
//! Not here: I7's accept-then-resolve (one answer, at the move's end), plans (I9).

use std::collections::BTreeMap;
use std::time::Duration;

use replica::bodies::Family;
use replica::effects::{Actor, Refusal, fixture_bytes};
use replica::encode::{Name, Value, decode};
use replica::host::Progress;
use replica::ids::{Id, Minter, Scope};
use replica::intents::{Intent, Target as Aim};
use replica::moves::{Effector, Move};
use replica::pose::{Pose, Support, Vec3};
use replica::time::Micros;
use sim::controller::Stance;
use sim::host::Runner;
use sim::host::{Planned, Wants};
use sim::mover::Body as Moved;
use sim::moves::{Fired, Instance, Moves, Reach};
use sim::planner::{Planner, Thread};
use sim::slots::{PlaceAt, Request, Slots};
use sim::spots::Target;
use sim::timers::DueList;
use sim::walk::town::Town;
use skills::route::Route;

type R<T> = Result<T, Refusal>;

const SIT: &str = include_str!("../../replica/fixtures/moves/sit.diag");
const RISE: &str = include_str!("../../replica/fixtures/moves/rise.diag");

/// A walk's speed, µm a second.
pub const WALK: i64 = 1_400_000;

/// What a move intent asks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    /// Walk to `point` (µm, the frame of `node`), or, with no point, to the stand point of `node`'s seat.
    Walk {
        node: Id,
        point: Option<Vec3>,
    },
    /// Sit on the seat of `thing`.
    Sit {
        thing: Id,
    },
    Rise,
}

/// A move intent read: who moves, and what it asks.
#[derive(Clone, Debug)]
pub struct Asked {
    pub body: Id,
    pub actor: Actor,
    pub ask: Ask,
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

/// Reads a move intent: `None` when its verb is not a move, else the ask or the reason it is not one. A walk's point
/// is parameter 1, `[x, y, z]` µm in its target's frame.
pub fn read(intent: &Intent, body: Id) -> Option<Result<Asked, &'static str>> {
    let node = match &intent.target {
        Some(Aim::Node(n)) => Some(*n),
        _ => None,
    };
    // A form's verb (T10 rule 4: `souls:` verbs are the engine's own), by its form: `eden:sit` as the T10 fixtures.
    let form = match intent.verb.as_str().split_once(':') {
        Some((ns, form)) if ns != "souls" => form,
        _ => return None,
    };
    let ask = match form {
        "walk" => node.ok_or("move.no-target").and_then(|node| {
            let point = match intent.parameters.get(&1) {
                None => None,
                Some(Value::Array(p)) => match p.iter().map(int).collect::<Option<Vec<_>>>() {
                    Some(p) if p.len() == 3 => Some(Vec3::new(p[0], p[1], p[2])),
                    _ => return Err("move.bad-point"),
                },
                Some(_) => return Err("move.bad-point"),
            };
            Ok(Ask::Walk { node, point })
        }),
        "sit" => node.ok_or("move.no-target").map(|thing| Ask::Sit { thing }),
        "rise" => Ok(Ask::Rise),
        _ => return None,
    };
    Some(ask.map(|ask| Asked {
        body,
        actor: intent.actor,
        ask,
    }))
}

#[derive(Clone, Copy, Debug)]
enum Live {
    Walk,
    Place(Instance),
}

/// The reach distances the planner found (K18b): by body and place, µm to the place's slot and stand points. The clock
/// reads them and computes none.
struct Reached<'a>(&'a BTreeMap<(Id, Id), [i64; 2]>);

impl Reach for Reached<'_> {
    fn distance(
        &self,
        body: Id,
        _: &Effector,
        _: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64> {
        let [place, stand] = self.0.get(&(body, target))?;
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
    sit: bool,
}

/// The world's bodies: a town, the runner of skills over it with the one controller, and the moves and seats.
pub struct Bodies {
    pub runner: Runner,
    pub town: Town,
    pub slots: Slots,
    moves: Moves,
    due: DueList,
    mint: Minter,
    sit: Move,
    rise: Move,
    /// The move each body is doing for an intent.
    live: BTreeMap<Id, (Id, Live)>,
    /// Intents ended between steps (a walk replaced): the intent and how.
    ended: Vec<(Id, Result<(), String>)>,
    /// Each body's pose as last written to the log ([`Bodies::moved`]).
    logged: BTreeMap<Id, Pose>,
    /// The planner thread: route searches and reach distances, off the clock (K18b, #3175).
    planner: Thread,
    /// How long a tick waits for each of the planner's batches: `None` as long as it takes (lockstep, the default),
    /// else a bound (a free-running clock never stops for the planner; a late batch is read at a later tick).
    pub wait: Option<Duration>,
    /// The planner's answers for the next tick.
    planned: Planned,
    /// The reach distances last found, by body and seat.
    reached: BTreeMap<(Id, Id), [i64; 2]>,
    /// Sits and rises waiting for their reach, in the order asked.
    waiting: Vec<Waiting>,
}

/// Where the log last had each body: its pose, and its stance when that pose is in a seat's slot (K18, #3160;
/// K18c, #3176). What a restart builds its bodies at.
pub type Placed = BTreeMap<Id, (Pose, Option<Stance>)>;

/// A body's row in a tick's part (K18's `answers::BODIES`): `[body, pose]`, or `[body, pose, stance]` in a seat
/// (1 sit, 2 lie).
pub fn row(body: Id, pose: &Pose, stance: Option<Stance>) -> Value {
    let mut r = vec![body.to_value(), pose.to_value()];
    match stance {
        Some(Stance::Sit) => r.push(Value::Uint(1)),
        Some(Stance::Lie) => r.push(Value::Uint(2)),
        _ => {}
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
            planned: Planned::default(),
            reached: BTreeMap::new(),
            waiting: Vec::new(),
            runner: Runner::new(tick),
            town,
            slots: Slots::new(),
            moves: Moves::new(),
            due: DueList::new(),
            mint: Minter::new(Scope([0xb4; 16])),
            sit: load(SIT)?,
            rise: load(RISE)?,
            live: BTreeMap::new(),
            ended: Vec::new(),
            logged: BTreeMap::new(),
        })
    }

    /// Adds a body of `family`, standing as the mover placed it.
    pub fn add_body(&mut self, family: Family, body: Moved) -> R<()> {
        self.runner.add_body(family, body)
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
    /// into it from where it was added, at body time `at`, and its seat is held again. A seat gone or taken leaves it
    /// standing, named in the result.
    pub fn seat_placed(&mut self, placed: &Placed, at: Micros) -> Vec<(Id, Refusal)> {
        let mut out = Vec::new();
        for (&body, (pose, stance)) in placed {
            if pose.support != Support::Slot || self.runner.controller.body(body).is_none() {
                continue;
            }
            let thing = pose.frame.node;
            let r = self.slots.restore(
                &mut self.runner.controller,
                body,
                thing,
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

    /// Every body in id order, those the controller steps and those resting in a seat's slot (which it keeps apart),
    /// each with its stance when in a slot.
    fn every(&self) -> Placed {
        let c = &self.runner.controller;
        let mut out: Placed = c.bodies().map(|b| (b.id, (b.pose, None))).collect();
        for (body, _, stance) in self.slots.seated() {
            if let Some(b) = c.body(body)
                && b.pose.support == Support::Slot
            {
                out.insert(body, (b.pose, Some(stance)));
            }
        }
        out
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

    /// The reach questions for the planner: each body's point (its feet, or its seat's point while it is in one) and
    /// its seat's seat and stand points, µm, as the bodies stand now.
    fn reach_of(&self, pairs: Vec<(Id, Id)>) -> Vec<(Id, Vec3, Id, [Vec3; 2])> {
        let c = &self.runner.controller;
        pairs
            .into_iter()
            .filter_map(|(b, t)| {
                let p = c.body(b)?.pose;
                let at = match (p.support, self.slots.held_by(b)) {
                    (Support::Slot, Some(h)) => self.slots.place(h)?.point,
                    _ => p.position,
                };
                let s = self.slots.place(t)?;
                Some((b, at, t, [s.point, s.stand().ok()?]))
            })
            .collect()
    }

    /// Route searches the planner ran so far, off the clock (K18b).
    pub fn searched(&self) -> u64 {
        self.planner.searched
    }

    /// The planner's answers to everything sent, taken for the next tick ([`Bodies::wait`]).
    fn take(&mut self) {
        let p = self.planner.take(self.wait);
        self.reached.extend(p.reach.iter().map(|(k, v)| (*k, *v)));
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

    /// Starts one tick's moves, each for its intent, at body time: refused ones come back with their reason by name.
    /// A walk starts now (its place and legs come from the planner); a sit or a rise waits for its reach, and comes
    /// back from the first call after the planner found it (K18b).
    pub fn start(&mut self, asks: Vec<(Id, Asked)>) -> Vec<(Id, R<()>)> {
        let mut out = Vec::new();
        let mut asked = Vec::new();
        for (id, a) in asks {
            if self.runner.controller.body(a.body).is_none() {
                out.push((id, Err(refusal("body-unknown", a.body))));
                continue;
            }
            match a.ask {
                Ask::Walk { node, point } => {
                    let goal = match point {
                        Some(p) => Ok(Target::new(node, p)),
                        None => match self.slots.place(node).map(|s| (s.floor, s.stand())) {
                            Some((floor, Ok(p))) => Ok(Target::new(floor, p)),
                            Some((_, Err(r))) => Err(r),
                            None => Err(refusal("move.no-point", node)),
                        },
                    };
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
                        sit: true,
                    });
                }
                Ask::Rise => {
                    self.replace(a.body);
                    let place = self.slots.held_by(a.body);
                    asked.push(Waiting {
                        id,
                        body: a.body,
                        place,
                        sit: false,
                    });
                }
            }
        }
        // The asks waiting from earlier ticks whose reach is back are committed; the new asks' reach goes to the
        // planner, for a later tick.
        out.extend(self.commit_waiting());
        let pairs: Vec<(Id, Id)> = asked
            .iter()
            .filter_map(|w| Some((w.body, w.place?)))
            .collect();
        for (b, t) in &pairs {
            self.reached.remove(&(*b, *t));
        }
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
                    self.reached.contains_key(&(w.body, t))
                        || self.reach_of(vec![(w.body, t)]).is_empty()
                })
            });
        self.waiting = still;
        let mut sits = Vec::new();
        for w in ready {
            if let (true, Some(thing)) = (w.sit, w.place) {
                sits.push((w.id, w.body, thing));
                continue;
            }
            let r = self.slots.rise(
                &mut self.runner.controller,
                &mut self.due,
                &mut self.mint,
                &mut self.moves,
                &Reached(&self.reached),
                w.body,
                &self.rise,
                now,
            );
            out.push((w.id, self.started(w.id, w.body, r)));
        }
        if !sits.is_empty() {
            let requests: Vec<Request> = sits
                .iter()
                .map(|&(_, body, thing)| Request {
                    body,
                    thing,
                    mv: &self.sit,
                    stance: Stance::Sit,
                })
                .collect();
            let done = self.slots.commit(
                &mut self.runner.controller,
                &mut self.due,
                &mut self.mint,
                &mut self.moves,
                &Reached(&self.reached),
                &requests,
                now,
            );
            // Taken in B3's stable order, and each matched back to its intent by its body.
            for (body, r) in done {
                if let Some(&(id, ..)) = sits.iter().find(|s| s.1 == body) {
                    out.push((id, self.started(id, body, r)));
                }
            }
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
                let fired = self.slots.fire(
                    &mut self.runner.controller,
                    &mut self.due,
                    &mut self.mint,
                    &mut self.moves,
                    &Reached(&self.reached),
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
            let planned = std::mem::take(&mut self.planned);
            let (mut wants, _) = self.runner.tick_planned(&mut self.town, &planned);
            // Every body in a seat move, with its seat: its reach for the next tick's phase timers.
            let seated: Vec<(Id, Id)> = self
                .live
                .iter()
                .filter(|(_, (_, l))| matches!(l, Live::Place(_)))
                .filter_map(|(b, _)| Some((*b, self.slots.held_by(*b)?)))
                .collect();
            wants.reach = self.reach_of(seated);
            self.planner.send(wants);
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

    /// Intent `id` timed out: its walk stops where the body is. A sit or a rise is short and runs to its end, so a
    /// seat is never left half taken.
    pub fn cancel(&mut self, id: Id) {
        self.waiting.retain(|w| w.id != id);
        let Some((&body, _)) = self
            .live
            .iter()
            .find(|(_, (i, l))| *i == id && matches!(l, Live::Walk))
        else {
            return;
        };
        self.runner.end_order(body);
        self.live.remove(&body);
    }
}

fn refusal(name: &'static str, node: Id) -> Refusal {
    Refusal {
        name,
        detail: replica::world_model::show(node),
    }
}
