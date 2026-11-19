//! The due list (Engine v2 K9, #2672): everything due later is a timer in one list ordered by world time, so a tick
//! with nothing due costs one look at the list's first key, and a world with nothing moving jumps to the next due time
//! instead of ticking through the gap (`v2/docs/time.md` rules 6 and 11, `v2/docs/effects.md` rule 15).
//!
//! - **A timer belongs to a node.** The list holds it as its key, (due time in µs, timer id), with its node and name.
//!   The tree holds the same timer as state, written by the node's timer records (effects.md rule 15), so a checkpoint
//!   carries it and [`DueList::from_state`] rebuilds the list from it. Removing a node drops the timers of its
//!   subtree from the tree's state in the remove's own commit (K2b, #3132), and [`DueList::cancel_under`] takes the
//!   same timers out of the list; no clears are written for them.
//! - **Ordered by (due, id).** Equal due times fire in timer id order. The id is the sequence: a zone's minter gives
//!   ids in the order timers are set, and the id is in the state, so the order survives a checkpoint without a counter
//!   of its own.
//! - **A timer fires with "now" equal to its due time** on both paths: [`DueList::fire`] hands back the earliest timer
//!   due before a bound, and the caller runs it at `due`. A tick fires what is due before the next tick's start (a
//!   timer due at t is handled in `tick_of(t)`); a timer set while firing that is due before the same bound fires in
//!   the same call, as it would in the same tick.
//! - **An idle world jumps.** When nothing needs per-tick work, the next tick worth running is
//!   [`DueList::next_tick`], the tick holding [`DueList::next_due`]; the ticks in between write nothing (no tick
//!   leaves a record of its own), so the jump's effects and state equal those of stepping every tick, at any tick
//!   rate. World time itself never stops: the mapping says what time it is, and the jump only skips empty work.
//! - **Catch-up in slices.** [`DueList::fire`] hands back one timer at a time, so a long catch-up stops at the clock's
//!   budget (K7) and resumes where it stopped.
//! - **Skills' timers** reach the list from the host's [`Staged`] through [`DueList::apply`]: sets, then clears.
//!
//! Not here: the tick loop that calls this and writes the entries, moves (B2), sleep and wake (O2), timed values (F5).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use replica::effects::{Refusal, TimerState};
use replica::encode::Name;
use replica::ids::Id;
use replica::time::{Micros, TimeRefusal, Timeline};
use replica::tree::Tree;
use replica::world_model::show;

use crate::host::Staged;

/// A pending timer: the node it belongs to, its id, the world time it is due (µs) and what it is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Timer {
    pub node: Id,
    pub id: Id,
    pub due: Micros,
    pub name: Name,
}

/// A timer's place in the due list: its due time, then its id.
pub type Key = (Micros, Id);

/// Every pending timer of a zone, ordered by [`Key`], with indexes by timer id and by node.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DueList {
    due: BTreeMap<Key, (Id, Name)>,
    by_id: HashMap<Id, Micros>,
    by_node: HashMap<Id, BTreeSet<Id>>,
}

fn refusal(name: &'static str, id: Id) -> Refusal {
    Refusal {
        name,
        detail: show(id),
    }
}

impl DueList {
    pub fn new() -> DueList {
        DueList::default()
    }

    /// The list a checkpoint's timers give (the tree's state, effects.md rule 15).
    pub fn from_state(timers: &BTreeMap<Id, TimerState>) -> DueList {
        let mut list = DueList::new();
        for (id, t) in timers {
            list.insert(t.node, *id, t.due, t.name.clone());
        }
        list
    }

    fn insert(&mut self, node: Id, id: Id, due: Micros, name: Name) {
        self.due.insert((due, id), (node, name));
        self.by_id.insert(id, due);
        self.by_node.entry(node).or_default().insert(id);
    }

    fn take(&mut self, key: Key) -> Option<Timer> {
        let (node, name) = self.due.remove(&key)?;
        self.by_id.remove(&key.1);
        if let Some(ids) = self.by_node.get_mut(&node) {
            ids.remove(&key.1);
            if ids.is_empty() {
                self.by_node.remove(&node);
            }
        }
        Some(Timer {
            node,
            id: key.1,
            due: key.0,
            name,
        })
    }

    /// Timers pending.
    pub fn len(&self) -> usize {
        self.due.len()
    }

    pub fn is_empty(&self) -> bool {
        self.due.is_empty()
    }

    /// Sets a timer, or refuses an id already pending (`id-duplicate`, as the tree does).
    pub fn set(&mut self, t: Timer) -> Result<(), Refusal> {
        if self.by_id.contains_key(&t.id) {
            return Err(refusal("id-duplicate", t.id));
        }
        self.insert(t.node, t.id, t.due, t.name);
        Ok(())
    }

    /// Cancels the timer at `key`, if one is there.
    pub fn cancel(&mut self, key: Key) -> Option<Timer> {
        self.take(key)
    }

    /// Clears timer `id` for its node `node`: `timer-missing` when none is pending, `not-own-node` when it is
    /// another node's (as the tree refuses a clear record).
    pub fn clear(&mut self, node: Id, id: Id) -> Result<Timer, Refusal> {
        let due = *self
            .by_id
            .get(&id)
            .ok_or_else(|| refusal("timer-missing", id))?;
        if self.due.get(&(due, id)).map(|(n, _)| *n) != Some(node) {
            return Err(refusal("not-own-node", id));
        }
        self.take((due, id))
            .ok_or_else(|| refusal("timer-missing", id))
    }

    /// The earliest due time pending.
    pub fn next_due(&self) -> Option<Micros> {
        self.due.first_key_value().map(|(k, _)| k.0)
    }

    /// The tick an idle world runs next, from tick `from`: the one holding the next due time, or `from` when that is
    /// already due. `None` with nothing pending.
    pub fn next_tick(&self, line: &Timeline, from: i64) -> Result<Option<i64>, TimeRefusal> {
        match self.next_due() {
            Some(t) => Ok(Some(line.tick_of(t)?.max(from))),
            None => Ok(None),
        }
    }

    /// Takes the earliest timer due before `before`, to be run with "now" at its due time; `None` when nothing is.
    /// A timer set while firing that is due before the same bound comes out of a later call, in key order.
    pub fn fire(&mut self, before: Micros) -> Option<Timer> {
        let key = *self.due.first_key_value()?.0;
        if key.0 >= before {
            return None;
        }
        self.take(key)
    }

    /// Cancels every timer of `node` and of the nodes below it in `tree`, and returns them in key order: the timers
    /// the remove of `node` drops from the tree's state when it commits. Called before the remove applies.
    pub fn cancel_under(&mut self, tree: &Tree, node: Id) -> Vec<Timer> {
        let mut gone = Vec::new();
        let mut walk: Vec<_> = tree.handle(node).into_iter().collect();
        while let Some(h) = walk.pop() {
            if let Some(n) = tree.node(h)
                && let Some(ids) = self.by_node.get(&n.id())
            {
                for id in ids.clone() {
                    let due = self.by_id[&id];
                    gone.extend(self.take((due, id)));
                }
            }
            walk.extend(tree.children(h).unwrap_or_default());
        }
        gone.sort_by_key(|t| (t.due, t.id));
        gone
    }

    /// Applies a tick's staged timers from the host (K13a): each set, then each clear, every one for the body that
    /// asked. Returns the refusals with their bodies; a refused one changes nothing.
    pub fn apply(&mut self, staged: &Staged) -> Vec<(Id, Refusal)> {
        let mut refused = Vec::new();
        for t in &staged.timers {
            let timer = Timer {
                node: t.body,
                id: t.id,
                due: t.due,
                name: t.name.clone(),
            };
            if let Err(r) = self.set(timer) {
                refused.push((t.body, r));
            }
        }
        for &(body, id) in &staged.cleared {
            if let Err(r) = self.clear(body, id) {
                refused.push((body, r));
            }
        }
        refused
    }
}
