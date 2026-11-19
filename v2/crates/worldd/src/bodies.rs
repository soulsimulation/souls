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
//! - **Who hears** (#3369). After each step of the controller the bodies call `sim::speech::heard`, which brings every
//!   body's interest set up to date and gives each utterance the step started its hearers as they are then; the world
//!   writes each as `sim::speech::entry` says ([`Bodies::heard`]).
//!
//! Not here: I7's accept-then-resolve (one answer, at the move's end), plans (I9).

use std::collections::BTreeMap;

use replica::bodies::Family;
use replica::effects::{Actor, Refusal, fixture_bytes};
use replica::encode::{Name, Value, decode};
use replica::host::Progress;
use replica::ids::{Id, Minter, Scope};
use replica::intents::Intent;
use replica::move_check::{self, Seen, Verdict};
use replica::moves::{Effector, Move};
use replica::pose::{Pose, Support, Vec3};
use replica::select::{self, Spot};
use replica::speech::Said;
use replica::time::Micros;
use sim::commit::bind::{Bound, Slot, bind};
use sim::commit::spot;
use sim::controller::Stance;
use sim::host::Runner;
use sim::life::{Born, Life, Retired, Standing};
use sim::mover::Body as Moved;
use sim::moves::{Fired, Instance, Moves, Reach};
use sim::slots::{PlaceAt, Request, Slots};
use sim::speech::{self, Hearing};
use sim::spots::Target;
use sim::timers::DueList;
use sim::walk::town::Town;
use skills::route::Route;

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

/// Each body's point (its feet, or its seat's stand point while it is in one) and each seat's seat and stand point,
/// µm. A seat is taken from its stand point and left there (B3): its contacts (`souls:slot` for a sit or a lie,
/// `souls:stand` for a rise) are reached at the stand point, across x and z, so the seat's own offset from it (the
/// kind's model geometry, SEATDEF) is never counted against the body's reach (C17, #3453).
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
        let [_, stand] = self.1.get(&target)?;
        let b = match point.as_str() {
            "souls:slot" | "souls:stand" => stand,
            _ => return None,
        };
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        i64::try_from((d(a.x, b.x) + d(a.z, b.z)).isqrt()).ok()
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
    /// Every body's interest set (B11, R4), kept as the bodies move.
    hearing: Hearing,
    /// The utterances started since the world last took them, each with its speaker, its record (hearers resolved
    /// when it started) and the world time it started: the world writes each.
    pub heard: Vec<(Id, Said, Micros)>,
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
            lie: load(LIE)?,
            rise: load(RISE)?,
            live: BTreeMap::new(),
            ended: Vec::new(),
            took: BTreeMap::new(),
            logged: BTreeMap::new(),
            hearing: Hearing::new(),
            heard: Vec::new(),
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

    /// Every body the controller holds, in id order: those it steps and those resting in a seat's slot (which it keeps
    /// apart), a rising one included, each with its stance when in a slot.
    fn every(&self) -> Placed {
        let c = &self.runner.controller;
        c.ids()
            .filter_map(|id| {
                let b = c.body(id)?;
                let stance = match b.pose.support {
                    Support::Slot => self.slots.stance(id),
                    _ => None,
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

    fn geo(&self, bodies: &[Id], places: &[Id]) -> Geo {
        let c = &self.runner.controller;
        let points = bodies
            .iter()
            .filter_map(|&b| {
                let p = c.body(b)?.pose;
                let at = match (p.support, self.slots.held_by(b)) {
                    (Support::Slot, Some(t)) => self.slots.place(t)?.stand().ok()?,
                    _ => p.position,
                };
                Some((b, at))
            })
            .collect();
        let places = places
            .iter()
            .filter_map(|&t| {
                let s = self.slots.place(t)?;
                Some((t, [s.point, s.stand().ok()?]))
            })
            .collect();
        Geo(points, places)
    }

    /// A walk still going for an earlier intent gives way to a new move: it ends `claim-taken`.
    fn replace(&mut self, body: Id) {
        if let Some(&(old, Live::Walk)) = self.live.get(&body) {
            self.runner.end_order(body);
            self.live.remove(&body);
            self.ended.push((old, Err("claim-taken".into())));
        }
    }

    /// Where a walk to `node` goes: `point` in its frame; with none, the stand point of `node`'s seat; else a free
    /// standing spot in `node` (C14): its middle by E2's shared library (`replica::select`, a client's answer at the
    /// same version), for N9's table to grant the nearest free legal standing spot to, the same every run.
    fn goal(&self, node: Id, point: Option<Vec3>) -> R<Target> {
        if let Some(p) = point {
            return Ok(Target::new(node, p));
        }
        if let Some(s) = self.slots.place(node) {
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
            free: t.map(|t| self.slots.holder(t).is_none()),
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
                let free = |t: Id| self.slots.place(t).is_some() && self.slots.holder(t).is_none();
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
                        match self.goal(*node, *point) {
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
    /// started.
    pub fn start(&mut self, asks: Vec<(Id, Asked)>) -> Vec<(Id, R<()>)> {
        let now = self.runner.now;
        let mut out = Vec::new();
        let mut sits = Vec::new();
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
                    let goal = self.goal(node, point);
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
                    sits.push((id, a.body, thing, Stance::Sit));
                }
                Ask::Lie { thing } => {
                    self.replace(a.body);
                    sits.push((id, a.body, thing, Stance::Lie));
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
                .map(|&(_, body, thing, stance)| Request {
                    body,
                    thing,
                    mv: if stance == Stance::Lie {
                        &self.lie
                    } else {
                        &self.sit
                    },
                    stance,
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
            // Sits and lies, taken in B3's stable order, and each matched back to its intent by its body.
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
            let _ = self.runner.tick(&mut self.town);
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
        life.tick(now, &mut self.runner, &self.town.surfaces, standing, family)
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
        Ok((r, open))
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
