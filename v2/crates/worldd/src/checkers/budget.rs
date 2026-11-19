//! Limits charged in checking time (Engine v2 I8, #2692). Each actor (a Soul, a creator, or the world: the intent's
//! actor, not a Soul id as such) has a bucket of checking time: it refills [`REFILL_NS_PER_S`] a second, at most
//! [`SAVED_NS`] saved, and each check takes out what it cost. A fast agent with cheap acts is never held; one whose
//! acts cost more than the refill is answered [`SLOW_DOWN`] with the wait, before any check or commit. A refusal for
//! load is an answer to the agent, never a world effect.
//!
//! - **What a check costs** is its counted work at declared prices ([`cost`]): [`DECIDE_NS`] per candidate decided and
//!   [`READ_NS`] per node read, priced from I3's measured check (declared on #2692). The same act costs the same on
//!   any machine, and the checker reads no clock.
//! - **A deposit** ([`DEPOSIT_NS`], one candidate's price) is taken when the intent is accepted and corrected to the
//!   counted cost after the check.
//! - **In turn** ([`Turns`]): the checker threads take one act from each actor with acts waiting in turn, so one
//!   actor's queue never delays another's.
//! - **Every answer carries the balance left** ([`Answer::left`]).
//! - **A replacement is free**: an intent that replaces one still waiting takes its place and its deposit; the one it
//!   replaces is answered [`Answered::Replaced`] and charged nothing.
//!
//! The bucket refills by the process's monotonic clock, read only here and only for admission: neither the clock nor
//! a balance reaches a check or a commit, so what the simulation sees is the same with budgets on or off.

use super::{Act, Rules, check};
use replica::effects::Actor;
use replica::ids::Id;
use sim::commit::Checks;
use sim::frozen::Publisher;
use std::collections::{BTreeMap, VecDeque};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

/// The allowance's refill: 20 ms of checking a second, in ns.
pub const REFILL_NS_PER_S: i64 = 20_000_000;
/// The most an actor saves: 100 ms, in ns. A new actor starts with it.
pub const SAVED_NS: i64 = 100_000_000;
/// The price of one candidate decided (one form rule run), in ns.
pub const DECIDE_NS: i64 = 4_000;
/// The price of one node read on the frozen copy, in ns.
pub const READ_NS: i64 = 1_000;
/// Taken when an intent is accepted, corrected after its check: one candidate and the two nodes it reads.
pub const DEPOSIT_NS: i64 = DECIDE_NS + 2 * READ_NS;
/// The answer to an intent whose actor has spent its allowance.
pub const SLOW_DOWN: &str = "soul.slow-down";

/// What `checks` cost: its counted work at the declared prices, in ns.
pub fn cost(checks: &Checks) -> i64 {
    let reads: usize = checks.candidates.iter().map(|c| c.reads.len()).sum();
    let price = |n: usize, each: i64| i64::try_from(n).unwrap_or(i64::MAX).saturating_mul(each);
    price(checks.candidates.len(), DECIDE_NS).saturating_add(price(reads, READ_NS))
}

/// One actor's allowance, in ns of checking; it may go below zero after a check that cost more than was left.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bucket {
    pub left: i64,
    /// The budget clock's reading at the last refill, ns.
    at: u64,
}

impl Bucket {
    pub fn full(now: u64) -> Bucket {
        Bucket {
            left: SAVED_NS,
            at: now,
        }
    }

    /// Adds what accrued since the last refill, up to [`SAVED_NS`].
    pub fn refill(&mut self, now: u64) {
        let since = i128::from(now.saturating_sub(self.at));
        let gained = since * i128::from(REFILL_NS_PER_S) / 1_000_000_000;
        let left = (i128::from(self.left) + gained).min(i128::from(SAVED_NS));
        self.left = i64::try_from(left).unwrap_or(SAVED_NS);
        self.at = self.at.max(now);
    }

    /// How long until the balance covers a deposit again (zero if it does).
    pub fn wait(&self) -> Duration {
        let short = u64::try_from(DEPOSIT_NS.saturating_sub(self.left)).unwrap_or(0);
        let ns = u128::from(short) * 1_000_000_000 / REFILL_NS_PER_S.unsigned_abs() as u128;
        Duration::from_nanos(u64::try_from(ns).unwrap_or(u64::MAX))
    }
}

/// What became of an intent.
#[derive(Debug)]
pub enum Answered {
    /// Checked; the clock thread commits it.
    Checked(Checks),
    /// Not checked: its actor's allowance is spent ([`SLOW_DOWN`]); it may send again after `wait`.
    SlowDown { wait: Duration },
    /// Not checked: the intent `by` took its place while it waited. Charged nothing.
    Replaced { by: u64 },
}

/// An answer to one intent, with its actor's balance after it, in ns of checking.
#[derive(Debug)]
pub struct Answer {
    pub act: Act,
    pub left: i64,
    pub answered: Answered,
}

/// An actor as a bucket's key: the intent's actor, whatever it is.
type Key = (u8, Option<Id>);

fn key(actor: Actor) -> Key {
    match actor {
        Actor::Soul(id) => (0, Some(id)),
        Actor::Creator(id) => (1, Some(id)),
        Actor::World => (2, None),
    }
}

/// An accepted intent waiting for a checker, with the deposit taken for it.
pub struct Waiting {
    pub act: Act,
    pub deposit: i64,
}

#[derive(Default)]
struct State {
    queues: BTreeMap<Key, VecDeque<Waiting>>,
    /// The actors with acts waiting, in the order they are served.
    ring: VecDeque<Key>,
    buckets: BTreeMap<Key, Bucket>,
    closed: bool,
}

/// The budget clock: monotonic ns since the budgets started.
pub type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// The process's monotonic clock, for admission only (the wall-clock rule, K7: it never reaches the simulation).
#[allow(clippy::disallowed_methods)] // Refilling an allowance is real time by nature; no check or commit reads it.
pub fn real_clock() -> Clock {
    let start = std::time::Instant::now();
    Box::new(move || u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX))
}

/// The actors' buckets and their queues: intents in, checker threads take them in turn.
pub struct Turns {
    state: Mutex<State>,
    ready: Condvar,
    clock: Clock,
    out: Sender<Answer>,
}

impl Turns {
    pub fn new(clock: Clock, out: Sender<Answer>) -> Turns {
        Turns {
            state: Mutex::new(State::default()),
            ready: Condvar::new(),
            clock,
            out,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn bucket(s: &mut State, k: Key, now: u64) -> &mut Bucket {
        let b = s.buckets.entry(k).or_insert_with(|| Bucket::full(now));
        b.refill(now);
        b
    }

    /// Takes an intent: it replaces the waiting act `replaces` names, if that act is still waiting; otherwise it is
    /// accepted with a deposit, or answered [`SLOW_DOWN`] if its actor's balance does not cover one.
    pub fn submit(&self, act: Act, replaces: Option<u64>) {
        let now = (self.clock)();
        let k = key(act.actor);
        let mut s = self.lock();
        let left = Self::bucket(&mut s, k, now).left;
        let slot = replaces.and_then(|id| {
            let q = s.queues.get_mut(&k)?;
            q.iter_mut().find(|w| w.act.id == id)
        });
        if let Some(w) = slot {
            let by = act.id;
            let old = std::mem::replace(&mut w.act, act);
            let answered = Answered::Replaced { by };
            self.answer(old, left, answered);
            return;
        }
        let b = Self::bucket(&mut s, k, now);
        if b.left < DEPOSIT_NS {
            let wait = b.wait();
            self.answer(act, left, Answered::SlowDown { wait });
            return;
        }
        b.left -= DEPOSIT_NS;
        let q = s.queues.entry(k).or_default();
        q.push_back(Waiting {
            act,
            deposit: DEPOSIT_NS,
        });
        if q.len() == 1 {
            s.ring.push_back(k);
        }
        self.ready.notify_one();
    }

    fn answer(&self, act: Act, left: i64, answered: Answered) {
        // A receiver gone means the process is ending; there is no one left to answer.
        let _ = self.out.send(Answer {
            act,
            left,
            answered,
        });
    }

    /// The next act to check: the first waiting actor's oldest act; that actor goes to the back of the turn. Blocks
    /// until one waits; `None` once [`Turns::close`] is called and none waits.
    pub fn next(&self) -> Option<Waiting> {
        let mut s = self.lock();
        loop {
            if let Some(k) = s.ring.pop_front() {
                let q = s.queues.get_mut(&k)?;
                let w = q.pop_front()?;
                if q.is_empty() {
                    s.queues.remove(&k);
                } else {
                    s.ring.push_back(k);
                }
                return Some(w);
            }
            if s.closed {
                return None;
            }
            s = self.ready.wait(s).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Corrects a deposit to what the check cost; the balance left.
    pub fn charge(&self, actor: Actor, deposit: i64, checks: &Checks) -> i64 {
        let now = (self.clock)();
        let mut s = self.lock();
        let b = Self::bucket(&mut s, key(actor), now);
        b.left = b.left.saturating_sub(cost(checks).saturating_sub(deposit));
        b.left
    }

    /// Checks a waiting act on `copy`, charges it and answers it.
    pub fn serve(&self, w: Waiting, copy: &impl replica::read::Read, rules: &Rules) {
        let checks = check(copy, rules, &w.act);
        let left = self.charge(w.act.actor, w.deposit, &checks);
        self.answer(w.act, left, Answered::Checked(checks));
    }

    /// The checker threads end once none waits.
    pub fn close(&self) {
        self.lock().closed = true;
        self.ready.notify_all();
    }
}

/// Checker threads behind budgets: intents in through [`Turns::submit`], one [`Answer`] out for each. The threads
/// end after [`Turns::close`].
pub fn start(
    threads: usize,
    publisher: Arc<Publisher>,
    rules: Arc<Rules>,
    clock: Clock,
) -> (Arc<Turns>, Receiver<Answer>) {
    let (out, answers) = channel();
    let turns = Arc::new(Turns::new(clock, out));
    for i in 0..threads {
        let (turns, publisher, rules) = (
            Arc::clone(&turns),
            Arc::clone(&publisher),
            Arc::clone(&rules),
        );
        thread::Builder::new()
            .name(format!("checker-{i}"))
            .spawn(move || {
                while let Some(w) = turns.next() {
                    let copy = match w.act.recheck {
                        Some(v) => publisher.wait_for(v, super::RECHECK_WAIT),
                        None => publisher.latest(),
                    };
                    turns.serve(w, &*copy, &rules);
                }
            })
            .unwrap_or_else(|e| panic!("a checker thread starts: {e}"));
    }
    (turns, answers)
}

#[cfg(test)]
mod tests {
    use super::super::toggles::{World, rules, toggle};
    use super::*;
    use replica::effects::Actor;
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

    /// A clock the test moves by hand.
    fn manual() -> (Arc<AtomicU64>, Clock) {
        let t = Arc::new(AtomicU64::new(0));
        let c = Arc::clone(&t);
        (t, Box::new(move || c.load(Relaxed)))
    }

    fn by(actor: Actor, mut act: Act) -> Act {
        act.actor = actor;
        act
    }

    fn left_of(t: &Turns, actor: Actor) -> i64 {
        t.lock().buckets[&key(actor)].left
    }

    #[test]
    fn a_bucket_refills_twenty_ms_a_second_up_to_a_hundred() {
        let mut b = Bucket::full(0);
        b.left = -10_000_000;
        b.refill(1_000_000_000);
        assert_eq!(b.left, 10_000_000);
        b.refill(60_000_000_000);
        assert_eq!(b.left, SAVED_NS);
    }

    /// A4: the replaced intent is answered `replaced` and charged nothing; the actor pays for one check, not two.
    #[test]
    fn a4_an_intent_that_replaces_one_waiting_is_charged_nothing() {
        let w = World::build(1, 2, 0);
        let soul = Actor::Soul(w.pairs[0].0);
        let ((b, l), (_, l2)) = (w.pairs[0], w.pairs[1]);
        let (_, clock) = manual();
        let (out, answers) = channel();
        let t = Turns::new(clock, out);
        t.submit(by(soul, toggle(1, b, l)), None);
        assert_eq!(left_of(&t, soul), SAVED_NS - DEPOSIT_NS);
        t.submit(by(soul, toggle(2, b, l2)), Some(1));
        assert_eq!(
            left_of(&t, soul),
            SAVED_NS - DEPOSIT_NS,
            "the replacement took nothing more"
        );
        let a = answers.try_recv().expect("the replaced intent is answered");
        assert!(matches!(a.answered, Answered::Replaced { by: 2 }));
        assert_eq!((a.act.id, a.left), (1, SAVED_NS - DEPOSIT_NS));
        let waiting = t.next().expect("the replacement waits in its place");
        assert_eq!(waiting.act.id, 2);
        t.serve(waiting, &w.replica, &rules());
        let a = answers.try_recv().expect("checked");
        let Answered::Checked(checks) = &a.answered else {
            panic!("{a:?}")
        };
        assert_eq!(
            a.left,
            SAVED_NS - cost(checks),
            "only the replacement's check was charged"
        );
        assert!(t.lock().ring.is_empty(), "nothing else waits");
    }

    /// An actor whose checks cost more than it has is answered `soul.slow-down` with the wait; another is not.
    #[test]
    fn a_spent_actor_slows_down_and_another_does_not() {
        let w = World::build(1, 2, 0);
        let (spender, other) = (Actor::Soul(w.pairs[0].0), Actor::Soul(w.pairs[1].0));
        let (b, l) = w.pairs[0];
        let (time, clock) = manual();
        let (out, answers) = channel();
        let t = Turns::new(clock, out);
        t.submit(by(spender, toggle(1, b, l)), None);
        let waiting = t.next().expect("waits");
        let mut checks = check(&w.replica, &rules(), &waiting.act);
        // As if it had decided enough candidates to cost the whole allowance and 10 ms more.
        let extra = (SAVED_NS + 10_000_000) / DECIDE_NS;
        let first = checks.candidates[0].clone();
        checks.candidates.extend((0..extra).map(|_| first.clone()));
        let left = t.charge(spender, waiting.deposit, &checks);
        assert!(left < -10_000_000, "{left}");
        t.submit(by(spender, toggle(2, b, l)), None);
        let a = answers.try_recv().expect("answered");
        let Answered::SlowDown { wait } = a.answered else {
            panic!("{a:?}")
        };
        // Back to a deposit at 20 ms a second.
        let expect = (DEPOSIT_NS - left) as u128 * 1_000_000_000 / REFILL_NS_PER_S as u128;
        assert_eq!(wait.as_nanos(), expect);
        assert_eq!(a.left, left);
        t.submit(by(other, toggle(3, w.pairs[1].0, w.pairs[1].1)), None);
        assert!(answers.try_recv().is_err(), "the other actor is accepted");
        assert_eq!(t.next().map(|w| w.act.id), Some(3));
        // After the wait, the spender is accepted again.
        time.store(u64::try_from(wait.as_nanos()).expect("ns"), Relaxed);
        t.submit(by(spender, toggle(4, b, l)), None);
        assert!(answers.try_recv().is_err());
        assert_eq!(t.next().map(|w| w.act.id), Some(4));
    }

    /// Checkers serve actors in turn: one actor's queue never delays another's.
    #[test]
    fn actors_are_served_in_turn() {
        let w = World::build(1, 2, 0);
        let (x, y) = (Actor::Soul(w.pairs[0].0), Actor::Creator(w.pairs[1].0));
        let (b, l) = w.pairs[0];
        let (_, clock) = manual();
        let (out, _answers) = channel();
        let t = Turns::new(clock, out);
        for id in 1..=3 {
            t.submit(by(x, toggle(id, b, l)), None);
        }
        t.submit(by(y, toggle(9, b, l)), None);
        let order: Vec<u64> = (0..4).filter_map(|_| t.next()).map(|w| w.act.id).collect();
        assert_eq!(order, vec![1, 9, 2, 3]);
    }

    /// A5's in-process half: what reaches the commit is the same with budgets on as without; the budget only adds the
    /// balance to the answer. (K12's repeat check across processes is on its own branch, #3159.)
    #[test]
    fn a5_budgets_change_nothing_a_commit_reads() {
        let w = World::build(2, 5, 3);
        let publisher = Arc::new(Publisher::new(&w.replica));
        let (_, clock) = manual();
        let (turns, answers) = start(3, Arc::clone(&publisher), Arc::new(rules()), clock);
        for (i, (b, l)) in w.pairs.iter().enumerate() {
            turns.submit(by(Actor::Soul(*b), toggle(i as u64, *b, *l)), None);
        }
        let mut seen = 0;
        for a in answers.iter().take(w.pairs.len()) {
            let Answered::Checked(budgeted) = a.answered else {
                panic!("{a:?}")
            };
            let direct = check(&w.replica, &rules(), &a.act);
            assert_eq!(format!("{budgeted:?}"), format!("{direct:?}"));
            assert_eq!(a.left, SAVED_NS - cost(&budgeted));
            seen += 1;
        }
        turns.close();
        assert_eq!(seen, w.pairs.len());
    }
}
