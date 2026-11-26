//! The world's planner (Engine v2 K18b, #3175): route searches and reach checks off the clock (I3's rule: checks run
//! off the clock, and the clock only commits).
//!
//! - **Its own town.** The planner holds a copy of the town ([`Town::copy`], built again from a frozen copy of the
//!   tree): its own N5 map and N9 spot tables. A route for a body with hands never reads a door's open or shut state
//!   (N4: a shut door needs hands, and the walker has them), so nothing the clock commits today changes its answers;
//!   a world whose ground changes would send it the change first.
//! - **A tick later.** After each tick the clock hands over that tick's [`Wants`] (`sim::host::Runner::tick_planned`):
//!   every body's mark, the walks waiting for their place, the walkers that need a new line (#3167: a new leg, pushed
//!   off their line, at a line's end, a refused check) and whose straight way was not clear, and the world's reach
//!   questions; and in a tick that starts walks, those walks' places with every body's mark as the tick left them
//!   (#4974), so a walk is planned at the next tick. The planner writes the spot tables from the marks, then answers
//!   each: a walk's place and legs
//!   ([`Town::plan`]), a walker's line ([`Town::line`], #3167's planning call `View::search`) and a straight distance
//!   for each reach question. The next tick reads the answers ([`Planned`]); a walker keeps its line until it needs a
//!   new one, as on one thread.
//! - **Guarded.** N5's route search calls `crate::commit::off_clock`: on the clock thread it panics in a debug build,
//!   and is counted in a release build.
//! - **Stale ground.** A walker sent with piece numbers its node's ground no longer holds (a change cut its squares or
//!   its floor again and numbered the pieces anew, S13c) is found again where it stands and answered from there; one
//!   that stands on no ground now is refused [`GROUND_CHANGED`] for that walk alone.
//! - **Contained.** A panic in one question's answer is caught there (S13d): that walk, line or form question alone is
//!   refused [`FAILED`], and the batch's other questions are answered as ever. A panic outside them (the spot tables'
//!   writing) refuses every walk, line and form question in the batch [`FAILED`]. No act is left waiting, and the
//!   planner goes on.
//! - **One answer each.** Every question a batch asks gets exactly one answer, or waits only where the world holds
//!   it back on purpose (S13d). Nothing is counted: what is refused follows from the planner's own state, so a replay
//!   refuses the same questions at the same ticks.
//!   - A walk's place the spot tables did not answer waits while they hold it back on purpose: a Soul part way up a
//!     stair (#4171), a crowd's overflow spread over passes (A2-5), a body the world holds. A walk for a body whose
//!     class has no tables is never answered, so it is refused [`UNPREPARED`] in the batch that asks.
//!   - A batch on a map the planner does not hold is left unanswered while the planner is current: it is a batch from
//!     before a change, whose answers the clock drops. Once an install of a committed map has failed, the planner
//!     stays behind for good, so each question on a map it does not hold is refused [`MAP_STALE`].
//!   - A form's walk the planner cannot plan for the body's class is refused [`UNPREPARED`]. A refused form walk
//!     carries its refusal, so the form ends with the planner's own name, not `souls:no-way`.
//! - **Waits.** [`Thread::take`] waits for the answers to everything sent. In lockstep as long as it takes, so what a
//!   tick reads never depends on the threads' timing and a run fed the same inputs at the same ticks repeats (K12's
//!   replay). A free-running clock never stops for the planner: it waits at most a bound for each batch, and a batch
//!   late is merged into a later take (its walkers stand, its grants and sits wait). Where it took fewer batches than
//!   were out, the flight recorder keeps the body tick and the count (K12's input `Planned`), and a replay in
//!   lockstep takes exactly those there ([`Thread::take_n`]), so it lands each batch at the tick the live run did and
//!   ends in the same state. The planner works while the clock commits, records and waits for its next tick.

use crate::host::{Planned, Wants};
use crate::walk::World;
use crate::walk::town::{Rebuilt, Town};
use replica::effects::{Part, Refusal};
use replica::ids::Id;
use replica::pose::{Support, Vec3};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::Duration;

/// A walk's refusal when its walker stands on no ground now: the ground changed under it after the tick that asked.
pub const GROUND_CHANGED: &str = "walk.ground-changed";
/// A walk, line or form question's refusal when its answer panicked (outside any one question: the whole batch's).
pub const FAILED: &str = "planner.failed";
/// Each question's refusal on a map the planner does not hold, once an install has left it behind.
pub const MAP_STALE: &str = "planner.map-stale";
/// A walk's refusal when the body's class has no prepared geometry: no table or route can answer it.
pub const UNPREPARED: &str = "body-class-unprepared";

/// The straight distance, µm, from `a` to `b`: a reach check (B2), the planner's.
pub fn reach(a: Vec3, b: Vec3) -> i64 {
    crate::commit::off_clock();
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    i64::try_from((d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt()).unwrap_or(i64::MAX)
}

/// Exact form order and cursor, separate from a gateway walk on the same body.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct FormKey {
    pub body: replica::ids::Id,
    pub intent: replica::ids::Id,
    pub stage: usize,
    pub step: usize,
    pub kind: FormKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FormKind {
    Walk,
    Line,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormQuery {
    Walk {
        node: replica::ids::Id,
        at: Vec3,
        reach: i64,
        /// The thing the walk's move acts on, when its own doorway may be stood in (a door's knock, #3688).
        door: Option<replica::ids::Id>,
        /// The footprint of the thing a form's walk goes to, its corners in `node`'s frame (`at` its middle), and
        /// whether the walk ends on it: the walk ends within `reach` of its outline, not of `at`, or on it (#4072,
        /// [`crate::spots::within_footprint`]).
        ring: Option<([Vec3; 4], bool)>,
        /// An approach's aim (#3688): `at` moved short toward the body, in `node`'s frame. The walk ends near it when a
        /// body may stand there, else near `at`. Chosen here, not on the clock: finding a place to stand is a route
        /// search.
        aim: Option<Vec3>,
    },
    Line {
        to: Vec3,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormQuestion {
    pub key: FormKey,
    pub generation: u64,
    pub body: crate::mover::Body,
    pub query: FormQuery,
}

#[derive(Clone, Debug)]
pub enum FormResult {
    /// The walk's legs (none: no way there), or the planner's refusal, which the form ends with (S13d).
    Walk(Result<Vec<crate::walk::Leg>, Refusal>),
    Line(Result<crate::walk::town::Line, replica::effects::Refusal>),
}

#[derive(Clone, Debug)]
pub struct FormAnswer {
    pub generation: u64,
    /// The same immutable snapshot as the originating batch, checked by identity on the clock.
    pub map: std::sync::Arc<crate::ground::Versions>,
    pub result: FormResult,
}

/// Bounded worker-only breadcrumbs for the direct-ground handoff. No clock is read and no world content is emitted.
#[derive(Default)]
struct GroundTrace {
    remaining: usize,
    batch: u64,
    active: bool,
}

impl GroundTrace {
    fn begin(&mut self, w: &Wants) {
        self.active = self.remaining > 0
            && (!w.places.is_empty()
                || w.marks
                    .as_ref()
                    .is_some_and(|ms| ms.iter().any(|m| m.spot.is_some())));
        if self.active {
            self.batch = self.batch.saturating_add(1);
            self.line("dequeue", || {
                format!(
                    "marks={} asked={} places={}",
                    w.marks.as_ref().map_or(0, Vec::len),
                    w.marks
                        .as_ref()
                        .map_or(0, |ms| ms.iter().filter(|m| m.spot.is_some()).count()),
                    w.places.len()
                )
            });
        }
    }

    fn line(&mut self, stage: &'static str, detail: impl FnOnce() -> String) {
        if !self.active || self.remaining == 0 {
            return;
        }
        let line = format!(
            "planner: ground-handoff batch={} stage={} {}",
            self.batch,
            stage,
            detail()
        );
        let bytes = line.len() + 1;
        if bytes > self.remaining {
            self.remaining = 0;
            return;
        }
        self.remaining -= bytes;
        eprintln!("{line}");
    }

    fn key(body: replica::ids::Id, order: replica::ids::Id) -> String {
        let mut bytes = Vec::with_capacity(48);
        for id in [body, order] {
            bytes.extend_from_slice(&id.scope().0);
            bytes.extend_from_slice(&id.counter().to_le_bytes());
        }
        replica::encode::to_hex(&replica::ids::sha256(&bytes))
    }
}

/// The planner over its own town.
pub struct Planner {
    pub town: Town,
    /// Whether an install of a committed map failed: the planner's map then stays behind the clock's for good.
    behind: bool,
    /// Questions whose answers panicked, caught there (each refused [`FAILED`]).
    pub panics: u64,
    /// A test's forced panic in this body's answers.
    #[cfg(test)]
    fault: Option<Id>,
}

impl Planner {
    pub fn new(town: Town) -> Planner {
        Planner {
            town,
            behind: false,
            panics: 0,
            #[cfg(test)]
            fault: None,
        }
    }

    #[cfg(test)]
    fn fault(&self, body: Id) {
        assert!(
            self.fault != Some(body),
            "a forced panic in one body's answer"
        );
    }

    #[cfg(not(test))]
    fn fault(&self, _: Id) {}

    /// `answer`'s result, or `failed`'s when it panics: one question's panic is caught there (S13d).
    fn isolated<T>(
        &mut self,
        answer: impl FnOnce(&mut Self) -> T,
        failed: impl FnOnce() -> T,
    ) -> T {
        match catch_unwind(AssertUnwindSafe(|| answer(&mut *self))) {
            Ok(t) => t,
            Err(_) => {
                self.panics += 1;
                failed()
            }
        }
    }

    /// Installs a committed map made from `before`. One that fails (the planner's map is not `before`, the install
    /// refused or panicked) leaves the planner behind the clock for good: from then each question on a map it does
    /// not hold is refused [`MAP_STALE`] (S13d).
    pub fn install(
        &mut self,
        before: &crate::ground::Versions,
        rebuilt: Rebuilt,
        part: &Part,
    ) -> Result<(), &'static str> {
        let installed = catch_unwind(AssertUnwindSafe(|| {
            if *before != self.town.versions {
                return Err(MAP_STALE);
            }
            self.town.install(rebuilt, part).map_err(|r| r.name)
        }))
        .unwrap_or(Err(FAILED));
        self.behind |= installed.is_err();
        installed
    }

    /// Answers one tick's wants: the spot tables written from its marks, then each waiting walk's place and legs,
    /// each walker's line and each reach question.
    pub fn answer(&mut self, w: &Wants) -> Planned {
        self.answer_traced(w, &mut GroundTrace::default())
    }

    /// `body` on the planner's ground as it stands (S13c): as sent while its piece and triangle still hold where it
    /// stands, else found again there ([`Town::relocate`]), or refused [`GROUND_CHANGED`] when it stands on none. A
    /// body not on a surface, or on a node this ground has no surface for, is sent on as it is (its own refusals).
    fn standing(&self, body: &crate::mover::Body) -> Result<crate::mover::Body, Refusal> {
        let Support::Surface { surface, .. } = body.pose.support else {
            return Ok(*body);
        };
        let Some(s) = self
            .town
            .surfaces_for(self.town.size_of(body.id))
            .and_then(|s| s.get(&surface))
        else {
            return Ok(*body);
        };
        let p = [body.pose.position.x, body.pose.position.z];
        if s.inside(body.piece, body.tri, p) {
            return Ok(*body);
        }
        self.town.relocate(body).map_err(|r| Refusal {
            name: GROUND_CHANGED,
            detail: format!("the ground changed under the walk: {}", r.name),
        })
    }

    fn answer_traced(&mut self, w: &Wants, trace: &mut GroundTrace) -> Planned {
        let mut out = Planned::default();
        trace.begin(w);
        if let Some(map) = &w.form_map {
            if **map != self.town.versions {
                // The install of a committed map comes before the batches on it (FIFO): while the planner is current,
                // a batch on another map is one from before a change, whose answers the clock drops. Behind for good
                // (an install failed), each question is refused by name rather than asked again for ever (S13d).
                if self.behind {
                    return refused(w, MAP_STALE, "the planner's map stays behind the batch's");
                }
                return out;
            }
            out.map = Some(Arc::clone(map));
        }
        self.town.body_classes.clone_from(&w.classes);
        if let Some(marks) = &w.marks {
            trace.line("spots-start", String::new);
            let result = self.town.spots(marks, w.at);
            trace.line("spots-end", || {
                format!("result={}", result.as_ref().err().map_or("ok", |r| r.name))
            });
            if let Err(r) = result {
                eprintln!("planner: the spot tables were not written: {}", r.name);
            }
            out.revoked = self.town.revoked();
        }
        for (body, target, order) in &w.places {
            let placed = self.isolated(
                |me| me.place(body, target, *order, trace, &mut out.searched),
                || Some(Err(FAILED)),
            );
            if let Some(r) = placed {
                out.places.insert(body.id, (*order, r));
            }
        }
        for (body, to) in &w.lines {
            let line = self.isolated(
                |me| {
                    me.fault(body.id);
                    let b = me.standing(body)?;
                    out.searched += 1;
                    me.town.line(&b, *to)
                },
                || Err(refusal(FAILED)),
            );
            out.lines.insert(body.id, (*to, line));
        }
        for q in &w.reach {
            out.reach.insert(
                (q.body, q.thing, q.slot, q.order),
                [reach(q.at, q.points[0]), reach(q.at, q.points[1])],
            );
        }
        if let Some(map) = &w.form_map
            && **map == self.town.versions
        {
            for q in &w.forms {
                let result = self.isolated(
                    |me| me.form(q, &mut out.searched),
                    || refused_form(q, refusal(FAILED)),
                );
                out.forms.insert(
                    q.key,
                    FormAnswer {
                        generation: q.generation,
                        map: Arc::clone(map),
                        result,
                    },
                );
            }
        }
        out
    }

    /// A waiting walk's place and legs, or a refusal's name; `None` while the spot tables hold its place back on
    /// purpose (S13d).
    fn place(
        &mut self,
        body: &crate::mover::Body,
        target: &crate::spots::Target,
        order: Id,
        trace: &mut GroundTrace,
        searched: &mut u64,
    ) -> Option<crate::host::Placed> {
        self.fault(body.id);
        let key = || format!("key={}", GroundTrace::key(body.id, order));
        let r = match self.town.spot(body.id, target) {
            Some(Ok(p)) => {
                trace.line("lookup-grant", key);
                *searched += 1;
                trace.line("route-start", key);
                let result = self
                    .town
                    .plan_with_metrics(body, p.node, p.at)
                    .map(|(legs, metrics)| (p, legs, metrics))
                    .map_err(|e| e.name);
                trace.line("route-end", || {
                    format!(
                        "{} result={}",
                        key(),
                        result.as_ref().err().copied().unwrap_or("ok")
                    )
                });
                result
            }
            Some(Err(name)) => {
                trace.line("lookup-refusal", || format!("{} result={name}", key()));
                Err(name)
            }
            None => {
                trace.line("lookup-none", key);
                // The tables hold a place back on purpose (a Soul the world carries, mid-stair or off a seat, #4171; a crowd's overflow spread over
                // passes, A2-5; a body the world holds asks none): the walk waits. A class with no tables is never
                // answered, and its ask fails every Soul's pass (`Town::spots`): refused now, by name.
                if self.town.surfaces_for(self.town.size_of(body.id)).is_some() {
                    return None;
                }
                Err(UNPREPARED)
            }
        };
        Some(r)
    }

    /// A form question's answer: its walk's legs or its line, from where the body stands, or the planner's refusal.
    fn form(&mut self, q: &FormQuestion, searched: &mut u64) -> FormResult {
        self.fault(q.body.id);
        let body = match self.standing(&q.body) {
            Ok(b) => b,
            Err(r) => return refused_form(q, r),
        };
        *searched += 1;
        match q.query {
            FormQuery::Walk {
                node,
                at,
                reach,
                door,
                ring,
                aim,
            } => {
                let view = match self.town.view_for(body.id) {
                    Ok(v) => v,
                    // A body class the planner has no geometry for: refused by name, never left unanswered (S13d).
                    Err(r) => return FormResult::Walk(Err(r)),
                };
                let legs = view
                    .on_floor(node, at)
                    .and_then(|(floor, at, _)| {
                        // A ring is given on the floor itself (`node` is the floor).
                        let ring = ring.as_ref().filter(|_| floor == node);
                        let near = |at| {
                            view.stand_near_shape(
                                floor,
                                at,
                                ring.map(|(r, on)| (&r[..], *on)),
                                reach,
                                Some(&body),
                                door,
                            )
                        };
                        // An aim, like a ring, is given on the floor itself.
                        let to = aim
                            .filter(|_| floor == node)
                            .and_then(near)
                            .or_else(|| near(at))
                            .or_else(|| (floor == crate::walk::node_of(&body)).then_some(at))?;
                        view.plan(&body, floor, to).ok()
                    })
                    .unwrap_or_default();
                FormResult::Walk(Ok(legs))
            }
            FormQuery::Line { to } => FormResult::Line(self.town.line(&body, to)),
        }
    }
}

fn refusal(name: &'static str) -> Refusal {
    Refusal {
        name,
        detail: match name {
            FAILED => "the planner's answer to this question panicked".into(),
            _ => "the planner could not answer".into(),
        },
    }
}

/// A form question refused by name: its walk or its line, so the form ends with that name (S13d).
fn refused_form(q: &FormQuestion, r: Refusal) -> FormResult {
    match q.query {
        FormQuery::Walk { .. } => FormResult::Walk(Err(r)),
        FormQuery::Line { .. } => FormResult::Line(Err(r)),
    }
}

/// Every walk, line and form question in `w` refused `name` (a batch whose answers panicked outside any one
/// question, S13c, or on a map the planner stays behind, S13d), each reach question answered (a straight distance),
/// stamped with the batch's map so the tick that asked takes them.
fn refused(w: &Wants, name: &'static str, detail: &str) -> Planned {
    let r = || Refusal {
        name,
        detail: detail.into(),
    };
    let mut out = Planned {
        map: w.form_map.clone(),
        ..Planned::default()
    };
    for (body, _, order) in &w.places {
        out.places.insert(body.id, (*order, Err(name)));
    }
    for (body, to) in &w.lines {
        out.lines.insert(body.id, (*to, Err(r())));
    }
    for q in &w.reach {
        out.reach.insert(
            (q.body, q.thing, q.slot, q.order),
            [reach(q.at, q.points[0]), reach(q.at, q.points[1])],
        );
    }
    if let Some(map) = &w.form_map {
        for q in &w.forms {
            out.forms.insert(
                q.key,
                FormAnswer {
                    generation: q.generation,
                    map: Arc::clone(map),
                    result: refused_form(q, r()),
                },
            );
        }
    }
    out
}

/// The answers to a batch whose answers panicked outside any one question: each refused [`FAILED`].
fn failed(w: &Wants) -> Planned {
    refused(w, FAILED, "the planner's answers to this batch panicked")
}

/// One batch's answers, or, when `answer` panics, [`failed`]'s; and whether it panicked.
fn answer_batch(w: &Wants, answer: impl FnOnce(&Wants) -> Planned) -> (Planned, bool) {
    match catch_unwind(AssertUnwindSafe(|| answer(w))) {
        Ok(p) => (p, false),
        Err(_) => (failed(w), true),
    }
}

enum Input {
    Wants(Wants),
    Map {
        before: Arc<crate::ground::Versions>,
        rebuilt: Box<Rebuilt>,
        part: Arc<Part>,
    },
}

/// A planner on a thread of its own.
pub struct Thread {
    wants: Option<Sender<Input>>,
    /// A batch's answers, and how many of its questions (or the batch itself) panicked, each refused [`FAILED`].
    answers: Receiver<(Planned, u64)>,
    /// Batches sent and not yet taken.
    out: usize,
    handle: Option<JoinHandle<()>>,
    /// Questions (or whole batches) whose answers panicked, each refused [`FAILED`] (S13d: one question each).
    pub panicked: u64,
    /// Route searches the planner ran, in the batches taken.
    pub searched: u64,
}

impl Thread {
    /// Starts `planner` on a thread named `planner`.
    pub fn spawn(mut planner: Planner) -> std::io::Result<Thread> {
        let (wtx, wrx) = channel::<Input>();
        let (ptx, prx) = channel::<(Planned, u64)>();
        let handle = std::thread::Builder::new()
            .name("planner".into())
            .spawn(move || {
                // Read once on this worker, never on the clock thread; all formatting/hashing stays here.
                let mut trace = GroundTrace {
                    remaining: if std::env::var("SOULS_GROUND_HANDOFF_TRACE").as_deref() == Ok("1")
                    {
                        64 * 1024
                    } else {
                        0
                    },
                    ..GroundTrace::default()
                };
                for input in wrx {
                    let w = match input {
                        Input::Wants(w) => w,
                        Input::Map {
                            before,
                            rebuilt,
                            part,
                        } => {
                            if let Err(name) = planner.install(&before, *rebuilt, &part) {
                                eprintln!("planner: committed map not installed: {name}");
                            }
                            continue;
                        }
                    };
                    let before = planner.panics;
                    let (p, panicked) = answer_batch(&w, |w| planner.answer_traced(w, &mut trace));
                    if panicked {
                        eprintln!(
                            "planner: a batch's answers panicked; each question refused {FAILED}"
                        );
                    }
                    let questions = planner.panics - before;
                    if questions > 0 {
                        eprintln!(
                            "planner: {questions} questions' answers panicked; each refused {FAILED}"
                        );
                    }
                    let count = p.places.len();
                    let sent = ptx.send((p, questions + u64::from(panicked)));
                    trace.line("answer-send", || {
                        format!(
                            "places={count} result={}",
                            if sent.is_ok() { "ok" } else { "closed" }
                        )
                    });
                    if sent.is_err() {
                        return;
                    }
                }
            })?;
        Ok(Thread {
            wants: Some(wtx),
            answers: prx,
            out: 0,
            handle: Some(handle),
            panicked: 0,
            searched: 0,
        })
    }

    /// Hands one tick's wants over.
    pub fn send(&mut self, w: Wants) {
        if let Some(tx) = &self.wants
            && tx.send(Input::Wants(w)).is_ok()
        {
            self.out += 1;
        }
    }

    /// FIFO map control, before later wants and without an answer batch.
    pub fn install(&self, before: Arc<crate::ground::Versions>, rebuilt: Rebuilt, part: Arc<Part>) {
        if let Some(tx) = &self.wants {
            let _ = tx.send(Input::Map {
                before,
                rebuilt: Box::new(rebuilt),
                part,
            });
        }
    }

    /// Batches sent and not yet taken.
    pub fn pending(&self) -> usize {
        self.out
    }

    /// The answers to the first `n` batches not yet taken (or every one, if fewer), later over earlier, waiting as long
    /// as it takes: a replay taking the batches a free-running clock took ([`crate::recorder::Input::Planned`]).
    pub fn take_n(&mut self, n: usize) -> Planned {
        let mut all = Planned::default();
        for _ in 0..n.min(self.out) {
            let Ok(p) = self.answers.recv() else {
                self.out = 0;
                break;
            };
            self.out -= 1;
            self.merge(&mut all, p);
        }
        all
    }

    fn merge(&mut self, all: &mut Planned, (p, panicked): (Planned, u64)) {
        self.panicked += panicked;
        self.searched += p.searched;
        all.merge(p);
    }

    /// The answers to every batch sent and not yet taken, later answers over earlier: waiting as long as it takes
    /// (`None`), or up to `wait` for each; a batch not back in time is taken by a later call.
    pub fn take(&mut self, wait: Option<Duration>) -> Planned {
        let mut all = Planned::default();
        while self.out > 0 {
            let p = match wait {
                None => self
                    .answers
                    .recv()
                    .map_err(|_| RecvTimeoutError::Disconnected),
                Some(d) => self.answers.recv_timeout(d),
            };
            let p = match p {
                Ok(p) => p,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    self.out = 0;
                    break;
                }
            };
            self.out -= 1;
            self.merge(&mut all, p);
        }
        all
    }
}

impl Drop for Thread {
    fn drop(&mut self) {
        self.wants = None;
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod answers_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::ReachQuestion;
    use crate::mover::Body;
    use crate::spots::Target;
    use replica::ids::Scope;
    use replica::pose::{Frame, Pose, Quat};

    fn id(n: u64) -> Id {
        Id::new(Scope([7; 16]), n).unwrap()
    }

    fn body(n: u64, node: Id) -> Body {
        Body {
            id: id(n),
            pose: Pose {
                frame: Frame { node, slot: None },
                position: Vec3::new(1_000_000, 0, 2_000_000),
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: node,
                    height: 0,
                },
            },
            linear: Vec3::ZERO,
            piece: 0,
            tri: 0,
        }
    }

    /// S13c: a batch whose answers panic answers every walk, line and form question in it by name, and every reach
    /// question, stamped with the batch's map: no act in it is left waiting for an answer that never comes.
    #[test]
    fn a_batch_that_panics_answers_every_question_in_it_by_name() {
        let node = id(1);
        let map = Arc::new(crate::ground::Versions::default());
        let (a, b) = (body(10, node), body(11, node));
        let to = Vec3::new(5_000_000, 0, 2_000_000);
        let key = |b: &Body, kind| FormKey {
            body: b.id,
            intent: id(20),
            stage: 0,
            step: 0,
            kind,
        };
        let w = Wants {
            places: vec![
                (a, Target::new(node, to), id(20)),
                (b, Target::new(node, to), id(21)),
            ],
            lines: vec![(a, to), (b, to)],
            reach: vec![ReachQuestion {
                body: a.id,
                at: a.pose.position,
                thing: id(30),
                slot: 0,
                order: id(20),
                points: [to, a.pose.position],
            }],
            form_map: Some(Arc::clone(&map)),
            forms: vec![
                FormQuestion {
                    key: key(&a, FormKind::Walk),
                    generation: 3,
                    body: a,
                    query: FormQuery::Walk {
                        node,
                        at: to,
                        reach: 0,
                        door: None,
                        ring: None,
                        aim: None,
                    },
                },
                FormQuestion {
                    key: key(&b, FormKind::Line),
                    generation: 4,
                    body: b,
                    query: FormQuery::Line { to },
                },
            ],
            ..Wants::default()
        };
        let (p, panicked) = answer_batch(&w, |_| panic!("a forced panic in the batch"));
        assert!(panicked);
        assert!(Arc::ptr_eq(p.map.as_ref().unwrap(), &map));
        for (who, order) in [(a.id, id(20)), (b.id, id(21))] {
            let (o, placed) = &p.places[&who];
            assert_eq!((*o, placed.as_ref().err()), (order, Some(&FAILED)));
            let (t, line) = &p.lines[&who];
            assert_eq!(*t, to);
            assert_eq!(line.as_ref().unwrap_err().name, FAILED);
        }
        assert_eq!(p.reach[&(a.id, id(30), 0, id(20))], [4_000_000, 0]);
        let walk = &p.forms[&key(&a, FormKind::Walk)];
        assert_eq!(walk.generation, 3);
        assert!(matches!(&walk.result, FormResult::Walk(Err(r)) if r.name == FAILED));
        let line = &p.forms[&key(&b, FormKind::Line)];
        assert_eq!(line.generation, 4);
        assert!(matches!(&line.result, FormResult::Line(Err(r)) if r.name == FAILED));

        // The same batch answered without a panic is the answer's own.
        let (q, panicked) = answer_batch(&w, |_| Planned::default());
        assert!(!panicked && q.places.is_empty() && q.lines.is_empty());
    }
}
