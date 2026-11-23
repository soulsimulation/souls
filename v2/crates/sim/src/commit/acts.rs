//! An act from its intent to its end (Engine v2 I4, #2687): repeats, receipts, deadlines and expiry. The world
//! process's tick loop (`worldd`'s `answers`) holds one of each and answers only after the tick's sync.
//!
//! - **Repeats, per actor** ([`Sequences`]): a sequence at or below the actor's last answered one returns the answer
//!   it had, if it is still kept, or `intent.stale-seq`. Gaps are allowed: an expired intent leaves one, and the next
//!   sequence is taken (Kafka's idempotent producer refuses gaps; this does not). The table is rebuilt from the log on
//!   a restart, so a repeat after a restart gets the same answer.
//! - **A receipt is not a table** ([`Receipts`]): it is the entries whose cause is the intent, found by an index on
//!   the cause, built as entries commit and again from the log on a restart. An intent's entries are read when it is
//!   answered; once it has ended they are dropped after [`KEEP_ENDED`] of world time, so the index stays bounded.
//! - **Every open act has a deadline on the due list** (K9's [`DueList`], [`Deadlines`]); at it the act ends
//!   `act.timed-out`.
//! - **Expiry** is world time, compared at arrival and again at commit ([`expired`]).

use crate::timers::{DueList, Timer};
use replica::effects::{Cause, Effect};
use replica::encode::Name;
use replica::ids::Id;
use replica::time::Micros;
use std::collections::{BTreeMap, VecDeque};

/// Answers kept per actor, to answer a repeat with.
pub const KEPT: usize = 16;

/// What an intent's sequence is to its actor's table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Seen {
    /// Above the last answered: taken.
    Fresh,
    /// Answered before, and that answer is kept: send it again.
    Kept(Vec<u8>),
    /// At or below the last answered, and its answer is no longer kept: `intent.stale-seq`.
    Stale,
}

#[derive(Default)]
struct Last {
    last: u64,
    kept: VecDeque<(u64, Vec<u8>)>,
}

/// Each actor's last answered sequence and its last [`KEPT`] answers, by the actor's encoded bytes.
#[derive(Default)]
pub struct Sequences {
    actors: BTreeMap<Vec<u8>, Last>,
}

impl Sequences {
    pub fn seen(&self, actor: &[u8], sequence: u64) -> Seen {
        let Some(l) = self.actors.get(actor) else {
            return Seen::Fresh;
        };
        if sequence > l.last {
            return Seen::Fresh;
        }
        match l.kept.iter().find(|(s, _)| *s == sequence) {
            Some((_, a)) => Seen::Kept(a.clone()),
            None => Seen::Stale,
        }
    }

    /// Each actor's last answered sequence and its kept answers, oldest first, by the actor's bytes: what a checkpoint
    /// carries so a restart from it keeps them (K18c, #3176).
    pub fn kept(
        &self,
    ) -> impl Iterator<Item = (&[u8], u64, impl Iterator<Item = &(u64, Vec<u8>)>)> {
        self.actors
            .iter()
            .map(|(a, l)| (a.as_slice(), l.last, l.kept.iter()))
    }

    /// Puts back one actor's last sequence and kept answers, oldest first, as [`Sequences::kept`] gave them.
    pub fn restore(&mut self, actor: &[u8], last: u64, kept: Vec<(u64, Vec<u8>)>) {
        let l = self.actors.entry(actor.to_vec()).or_default();
        l.last = l.last.max(last);
        l.kept = kept.into_iter().collect();
        while l.kept.len() > KEPT {
            l.kept.pop_front();
        }
    }

    /// Records the answer to `sequence`. A sequence never goes back: an older one answered late keeps the last.
    pub fn answered(&mut self, actor: &[u8], sequence: u64, answer: Vec<u8>) {
        let l = self.actors.entry(actor.to_vec()).or_default();
        l.last = l.last.max(sequence);
        l.kept.push_back((sequence, answer));
        if l.kept.len() > KEPT {
            l.kept.pop_front();
        }
    }
}

/// How long an ended intent's entries stay in [`Receipts`]: ten minutes of world time.
pub const KEEP_ENDED: Micros = 600_000_000;

/// The index from an intent to the entries it caused: its receipt.
#[derive(Default)]
pub struct Receipts {
    by_intent: BTreeMap<Id, Vec<u64>>,
    /// Intents answered since the last [`Receipts::trim`], not yet given an end time.
    ended: Vec<Id>,
    /// Ended intents with the world time they were first trimmed at, oldest first.
    ending: VecDeque<(Micros, Id)>,
}

impl Receipts {
    /// Indexes committed entries by their cause.
    pub fn index(&mut self, effects: &[Effect]) {
        for e in effects {
            if let Cause::Intent(id) = e.envelope.cause {
                self.by_intent
                    .entry(id)
                    .or_default()
                    .push(e.envelope.sequence);
            }
        }
    }

    /// The entries that carried out intent `id`, in log order.
    pub fn entries(&self, id: Id) -> &[u64] {
        self.by_intent.get(&id).map_or(&[], Vec::as_slice)
    }

    /// Intent `id` has had its last answer: its entries are dropped [`KEEP_ENDED`] after the next trim.
    pub fn ended(&mut self, id: Id) {
        self.ended.push(id);
    }

    /// Gives the intents ended since the last trim the world time `now`, then drops the entries of every intent
    /// that ended at least [`KEEP_ENDED`] before it.
    pub fn trim(&mut self, now: Micros) {
        self.ending.extend(self.ended.drain(..).map(|id| (now, id)));
        while let Some(&(at, id)) = self.ending.front() {
            if now.saturating_sub(at) < KEEP_ENDED {
                break;
            }
            self.ending.pop_front();
            self.by_intent.remove(&id);
        }
    }

    /// How many intents the index holds.
    pub fn len(&self) -> usize {
        self.by_intent.len()
    }

    /// Whether the index holds none.
    pub fn is_empty(&self) -> bool {
        self.by_intent.is_empty()
    }
}

/// The deadline timers' name on the due list.
pub const DEADLINE: &str = "souls:act-deadline";

/// Open acts' deadlines, as timers on K9's due list: one per intent, owned by the acting body.
#[derive(Default)]
pub struct Deadlines {
    due: DueList,
}

impl Deadlines {
    pub fn open(&mut self, body: Id, intent: Id, due: Micros) {
        let name = Name::new(DEADLINE).expect("a name");
        // An intent id is minted once, so it is never pending twice.
        let _ = self.due.set(Timer {
            node: body,
            id: intent,
            due,
            name,
        });
    }

    /// The act ended before its deadline.
    pub fn close(&mut self, body: Id, intent: Id) {
        let _ = self.due.clear(body, intent);
    }

    /// The next intent whose deadline is at or before `now`, taken off the list.
    pub fn due(&mut self, now: Micros) -> Option<Id> {
        self.due.fire(now.saturating_add(1)).map(|t| t.id)
    }

    pub fn len(&self) -> usize {
        self.due.len()
    }

    pub fn is_empty(&self) -> bool {
        self.due.is_empty()
    }
}

/// Whether an intent with this expiry (world time) has expired at `now`.
pub fn expired(expiry: Micros, now: Micros) -> bool {
    expiry <= now
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;

    #[test]
    fn a_repeat_gets_its_kept_answer_and_an_old_one_is_stale() {
        let mut s = Sequences::default();
        assert_eq!(s.seen(b"a", 1), Seen::Fresh);
        for q in 1..=(KEPT as u64 + 2) {
            s.answered(b"a", q, vec![q as u8]);
        }
        assert_eq!(
            s.seen(b"a", KEPT as u64 + 2),
            Seen::Kept(vec![KEPT as u8 + 2])
        );
        assert_eq!(s.seen(b"a", 1), Seen::Stale, "not kept any more");
        assert_eq!(s.seen(b"a", 100), Seen::Fresh, "a gap is allowed");
        assert_eq!(s.seen(b"b", 1), Seen::Fresh, "per actor");
    }

    #[test]
    fn a_deadline_fires_once_at_its_time_and_not_after_a_close() {
        let (a, b, body) = (
            Id::new(Scope([1; 16]), 1).unwrap(),
            Id::new(Scope([1; 16]), 2).unwrap(),
            Id::new(Scope([2; 16]), 0).unwrap(),
        );
        let mut d = Deadlines::default();
        d.open(body, a, 100);
        d.open(body, b, 50);
        d.close(body, b);
        assert_eq!(d.due(99), None);
        assert_eq!(d.due(100), Some(a));
        assert_eq!(d.due(1_000), None);
        assert!(expired(100, 100) && !expired(101, 100));
    }

    #[test]
    fn an_ended_intents_entries_are_dropped_ten_minutes_after_it_ends() {
        use replica::effects::{Actor, Body, Cause, Effect, Envelope};
        use replica::world_model::Audience;
        let id = |n| Id::new(Scope([3; 16]), n).unwrap();
        let effect = |sequence, intent| Effect {
            envelope: Envelope {
                sequence,
                at: 0,
                cause: Cause::Intent(intent),
                actor: Actor::World,
                audience: Audience::Everyone,
                node: id(0),
            },
            body: Body::Changes(Vec::new()),
            events: None,
            rest: replica::effects::Rest::new(),
        };
        let (done, open) = (id(1), id(2));
        let mut r = Receipts::default();
        r.index(&[effect(1, done), effect(2, open), effect(3, done)]);
        r.ended(done);
        r.trim(1_000);
        r.trim(1_000 + KEEP_ENDED - 1);
        assert_eq!(
            r.entries(done),
            &[1, 3],
            "kept for ten minutes after it ends"
        );
        r.trim(1_000 + KEEP_ENDED);
        assert_eq!(r.entries(done), &[] as &[u64], "dropped after ten minutes");
        assert_eq!(r.entries(open), &[2], "an open intent's entries stay");
        assert_eq!(r.len(), 1);
    }
}
