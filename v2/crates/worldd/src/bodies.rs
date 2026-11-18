//! A committed move reaches the body (Engine v2 I4b, #3156): walk, sit and rise from the gateway.
//!
//! [`crate::answers`] takes a move intent (a form's verb named `walk`, `sit` or `rise`, as `eden:sit`; T10 rule 4
//! keeps `souls:` verbs for the engine's own) like any act: an id, a deadline and a place in the next tick. At that
//! tick it is committed here, and the body is driven only through what already moves bodies (`v2/docs/bodies.md`): a
//! walk is N7's walk skill run behind the host (`sim::host::Runner`, T9b/T9c), sent to a point (N9); a sit is B3's
//! reserved seat and B2's sit move (`sim::slots`, `sim::moves`); a rise is B3's rise. Each steps the one controller
//! (B1). Nothing here sets a pose or a position.
//!
//! - **Checked at commit.** A move's checks are its own: the controller's claims (T9 rule 4), the reach (B2), the seat
//!   free and in reach (B3), a route (N7). They are made on the clock thread when the move starts, as B3 reserves a
//!   seat: one tick's sits are taken together, in B3's stable order. A move refused there ends by that name.
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
use sim::mover::Body as Moved;
use sim::moves::{Fired, Instance, Moves, Reach};
use sim::slots::{Request, SeatAt, Slots};
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
    Seat(Instance),
}

/// Each body's point (its feet, or its seat's point while it is in one) and each seat's seat and stand point, µm.
struct Geo(BTreeMap<Id, Vec3>, BTreeMap<Id, [Vec3; 2]>);

impl Reach for Geo {
    fn distance(
        &self,
        body: Id,
        _: &Effector,
        _: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64> {
        let a = self.0.get(&body)?;
        let [seat, stand] = self.1.get(&target)?;
        let b = match point.as_str() {
            "souls:seat" => seat,
            "souls:stand" => stand,
            _ => return None,
        };
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        i64::try_from((d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt()).ok()
    }
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
        Ok(Bodies {
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
    pub fn add_seat(&mut self, seat: SeatAt) -> R<()> {
        self.slots.add(seat)
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

    fn geo(&self, bodies: &[Id], seats: &[Id]) -> Geo {
        let c = &self.runner.controller;
        let points = bodies
            .iter()
            .filter_map(|&b| {
                let p = c.body(b)?.pose;
                let at = match (p.support, self.slots.held_by(b)) {
                    (Support::Slot, Some(t)) => self.slots.seat(t)?.point,
                    _ => p.position,
                };
                Some((b, at))
            })
            .collect();
        let seats = seats
            .iter()
            .filter_map(|&t| {
                let s = self.slots.seat(t)?;
                Some((t, [s.point, s.stand().ok()?]))
            })
            .collect();
        Geo(points, seats)
    }

    /// A walk still going for an earlier intent gives way to a new move: it ends `claim-taken`.
    fn replace(&mut self, body: Id) {
        if let Some(&(old, Live::Walk)) = self.live.get(&body) {
            self.runner.end_order(body);
            self.live.remove(&body);
            self.ended.push((old, Err("claim-taken".into())));
        }
    }

    /// Starts one tick's moves, each for its intent, at body time: refused ones come back with their reason by name.
    pub fn start(&mut self, asks: Vec<(Id, Asked)>) -> Vec<(Id, R<()>)> {
        let now = self.runner.now;
        let mut out = Vec::new();
        let mut sits = Vec::new();
        for (id, a) in asks {
            if self.runner.controller.body(a.body).is_none() {
                out.push((id, Err(refusal("body-unknown", a.body))));
                continue;
            }
            match a.ask {
                Ask::Walk { node, point } => {
                    let goal = match point {
                        Some(p) => Ok(Target::new(node, p)),
                        None => match self.slots.seat(node).map(|s| (s.floor, s.stand())) {
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
                    sits.push((id, a.body, thing));
                }
                Ask::Rise => {
                    self.replace(a.body);
                    let thing = self.slots.held_by(a.body);
                    let geo = self.geo(&[a.body], &thing.into_iter().collect::<Vec<_>>());
                    let r = self.slots.rise(
                        &mut self.runner.controller,
                        &mut self.due,
                        &mut self.mint,
                        &mut self.moves,
                        &geo,
                        a.body,
                        &self.rise,
                        now,
                    );
                    out.push((id, self.started(id, a.body, r)));
                }
            }
        }
        if !sits.is_empty() {
            let bodies: Vec<Id> = sits.iter().map(|s| s.1).collect();
            let things: Vec<Id> = sits.iter().map(|s| s.2).collect();
            let geo = self.geo(&bodies, &things);
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
                &geo,
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
        self.live.insert(body, (id, Live::Seat(n)));
        Ok(())
    }

    /// Steps the bodies to world time `now`, a tick at a time, firing each move's phase timers as they fall due.
    /// Returns the intents whose moves ended: done, or the reason by name.
    pub fn step(&mut self, now: Micros) -> Vec<(Id, Result<(), String>)> {
        let mut out = std::mem::take(&mut self.ended);
        while self.runner.now + self.runner.tick <= now {
            // The tick's order (K18, #3160): due timers first, at the tick's start, then the skills through the
            // host and the controller.
            let at = self.runner.now;
            while let Some(t) = self.due.fire(at + 1) {
                let geo = self.geo(
                    &[t.node],
                    &self.slots.held_by(t.node).into_iter().collect::<Vec<_>>(),
                );
                let fired = self.slots.fire(
                    &mut self.runner.controller,
                    &mut self.due,
                    &mut self.mint,
                    &mut self.moves,
                    &geo,
                    &self.town.surfaces,
                    &t,
                );
                let Some(&(id, Live::Seat(n))) = self.live.get(&t.node) else {
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
            let _ = self.runner.tick(&mut self.town);
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
