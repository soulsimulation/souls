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
//! - **Waits.** [`Thread::take`] waits for the answers to everything sent, as long as it takes: what a tick reads
//!   never depends on the threads' timing, so a run fed the same inputs repeats, lockstep or free-running. The
//!   planner works while the clock commits, records and waits for its next tick.

use crate::host::{Planned, Wants};
use crate::walk::World;
use crate::walk::town::Town;
use replica::pose::Vec3;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;

/// The straight distance, µm, from `a` to `b`: a reach check (B2), the planner's.
pub fn reach(a: Vec3, b: Vec3) -> i64 {
    crate::commit::off_clock();
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    i64::try_from((d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt()).unwrap_or(i64::MAX)
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
                        .plan(body, target.node, p)
                        .map(|legs| (p, legs))
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
        for (body, at, place, [s, stand]) in &w.reach {
            out.reach
                .insert((*body, *place), [reach(*at, *s), reach(*at, *stand)]);
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

    /// The answers to every batch sent and not yet taken, later answers over earlier, waiting as long as it takes.
    pub fn take(&mut self) -> Planned {
        let mut all = Planned::default();
        while self.out > 0 {
            let Ok(p) = self.answers.recv() else {
                self.out = 0;
                break;
            };
            self.out -= 1;
            match p {
                Some(p) => {
                    self.searched += p.searched;
                    all.merge(p);
                }
                None => self.panicked += 1,
            }
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
