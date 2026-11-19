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
//!   questions. The planner writes the spot tables from the marks, then answers each: a walk's place and legs
//!   ([`Town::plan`]), a walker's line ([`Town::line`], #3167's planning call `View::search`) and a straight distance
//!   for each reach question. The next tick reads the answers ([`Planned`]); a walker keeps its line until it needs a
//!   new one, as on one thread.
//! - **Guarded.** N5's route search calls `crate::commit::off_clock`: on the clock thread it panics in a debug build,
//!   and is counted in a release build.
//! - **Contained.** A panic in one batch's answers is caught: that batch is answered with nothing (the walks stand
//!   and ask again), and the planner goes on.
//! - **Waits.** [`Thread::take`] waits for the answers to everything sent. In lockstep as long as it takes, so what a
//!   tick reads never depends on the threads' timing and a run fed the same inputs at the same ticks repeats (K12's
//!   replay). A free-running clock never stops for the planner: it waits at most a bound for each batch, and a batch
//!   late is merged into a later take (its walkers stand, its grants and sits wait). Where it took fewer batches than
//!   were out, the flight recorder keeps the body tick and the count (K12's input `Planned`), and a replay in
//!   lockstep takes exactly those there ([`Thread::take_n`]), so it lands each batch at the tick the live run did and
//!   ends in the same state. The planner works while the clock commits, records and waits for its next tick.

use crate::host::{Planned, Wants};
use crate::walk::World;
use crate::walk::town::Town;
use replica::pose::Vec3;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::Duration;

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
    Walk(Vec<crate::walk::Leg>),
    Line(Result<crate::walk::town::Line, replica::effects::Refusal>),
}

#[derive(Clone, Debug)]
pub struct FormAnswer {
    pub generation: u64,
    /// The same immutable snapshot as the originating batch, checked by identity on the clock.
    pub map: std::sync::Arc<crate::ground::Versions>,
    pub result: FormResult,
}

/// The planner over its own town.
pub struct Planner {
    pub town: Town,
}

impl Planner {
    pub fn new(town: Town) -> Planner {
        Planner { town }
    }

    /// Answers one tick's wants: the spot tables written from its marks, then each waiting walk's place and legs,
    /// each walker's line and each reach question.
    pub fn answer(&mut self, w: &Wants) -> Planned {
        let mut out = Planned::default();
        if let Some(map) = &w.form_map {
            if **map != self.town.versions {
                return out;
            }
            out.map = Some(std::sync::Arc::clone(map));
        }
        if let Some(marks) = &w.marks
            && let Err(r) = self.town.spots(marks, w.at)
        {
            eprintln!("planner: the spot tables were not written: {}", r.name);
        }
        for (body, target, order) in &w.places {
            let r = match self.town.spot(body.id, target) {
                Some(Ok(p)) => {
                    out.searched += 1;
                    self.town
                        .plan_with_metrics(body, target.node, p)
                        .map(|(legs, metrics)| (p, legs, metrics))
                        .map_err(|e| e.name)
                }
                Some(Err(name)) => Err(name),
                None => continue,
            };
            out.places.insert(body.id, (*order, r));
        }
        for (body, to) in &w.lines {
            out.searched += 1;
            out.lines.insert(body.id, (*to, self.town.line(body, *to)));
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
                out.searched += 1;
                let result = match q.query {
                    FormQuery::Walk { node, at, reach } => {
                        let view = self.town.view();
                        let legs = view
                            .on_floor(node, at)
                            .and_then(|(floor, at, _)| {
                                let to = view.stand_near(floor, at, reach, Some(&q.body)).or_else(
                                    || (floor == crate::walk::node_of(&q.body)).then_some(at),
                                )?;
                                view.plan(&q.body, floor, to).ok()
                            })
                            .unwrap_or_default();
                        FormResult::Walk(legs)
                    }
                    FormQuery::Line { to } => FormResult::Line(self.town.line(&q.body, to)),
                };
                out.forms.insert(
                    q.key,
                    FormAnswer {
                        generation: q.generation,
                        map: std::sync::Arc::clone(map),
                        result,
                    },
                );
            }
        }
        out
    }
}

/// A planner on a thread of its own.
pub struct Thread {
    wants: Option<Sender<Wants>>,
    /// A batch's answers, or `None` when they panicked.
    answers: Receiver<Option<Planned>>,
    /// Batches sent and not yet taken.
    out: usize,
    handle: Option<JoinHandle<()>>,
    /// Batches whose answers panicked (answered with nothing).
    pub panicked: u64,
    /// Route searches the planner ran, in the batches taken.
    pub searched: u64,
}

impl Thread {
    /// Starts `planner` on a thread named `planner`.
    pub fn spawn(mut planner: Planner) -> std::io::Result<Thread> {
        let (wtx, wrx) = channel::<Wants>();
        let (ptx, prx) = channel::<Option<Planned>>();
        let handle = std::thread::Builder::new()
            .name("planner".into())
            .spawn(move || {
                for w in wrx {
                    let p = catch_unwind(AssertUnwindSafe(|| planner.answer(&w))).ok();
                    if p.is_none() {
                        eprintln!("planner: a batch's answers panicked; answered with nothing");
                    }
                    if ptx.send(p).is_err() {
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
            && tx.send(w).is_ok()
        {
            self.out += 1;
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

    fn merge(&mut self, all: &mut Planned, p: Option<Planned>) {
        match p {
            Some(p) => {
                self.searched += p.searched;
                all.merge(p);
            }
            None => self.panicked += 1,
        }
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
