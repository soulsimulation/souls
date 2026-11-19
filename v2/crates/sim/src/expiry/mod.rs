//! A loose thing that nobody keeps comes to an end (Engine v2 F10, #2773): a made thing lasts while it is kept; a
//! loose, unowned thing has an end, which its kind gives. No code here names a kind.
//!
//! - **Kept is a test on data** ([`kept`]): an owner's link at the thing (`souls:owns`, the one owner relation), or a
//!   parent that holds it in a slot (a hand is one). Anything else is loose.
//! - **The lifetime is the kind's** (section 19, [`replica::kinds::KindDef::loose`]), in µs; none is for ever.
//! - **One timer, no visits.** A change that may make a thing loose or kept (an unlink, a set-down, a take, a link)
//!   calls [`Loose::changed`]: a thing that becomes loose with a lifetime gets one timer on K9's due list
//!   ([`ENDS`]), due its lifetime later; one that becomes kept has its timer cancelled. The timer records it returns
//!   go in the same commit, so the timer is state (`v2/docs/effects.md` rule 15). Nothing reads the thing in between,
//!   so pending things cost a tick nothing: a tick with nothing due looks at the list's first key alone.
//! - **At the timer, test again.** [`Loose::fire`] runs at the due time: a thing still loose and free ends, by
//!   [`expired`]: one effect, the world its actor, that removes it with the event [`EXPIRED`]. Its subtree and links go
//!   with it (T2 rule 3), and the remove drops its timers. A thing kept by then has its timer cleared.
//! - **Busy waits.** A thing reserved by a run (`souls:reserves`, F3), or the target of an accepted intent (the
//!   caller says which), waits: [`Loose::released`] ends it when that ends, if it is still loose.
//! - **Undo** brings a removed thing back under its own id; the caller calls [`Loose::changed`] for it, and its timer
//!   starts again.
//!
//! Not here: the tick loop that calls this, decay looks, wear, things a creator placed, ending a walk to a thing that
//! ends (F3's), a thing a Soul needs to get out (E16's: its kind takes no lifetime).

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};

use replica::audience::OWNS;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event, Refusal, Rest, TimerRec,
};
use replica::encode::Name;
use replica::ids::{Id, Minter};
use replica::kinds::Kinds;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{plain, show};

use crate::timers::{DueList, Key, Timer};

/// The timer's name: a loose thing's end.
pub const ENDS: &str = "souls:loose-ends";
/// The event of the effect that ends it: the issue's `thing.expired`, spelt as the log's names are (`namespace:name`,
/// no dot; `v2/docs/effects.md` rule 10).
pub const EXPIRED: &str = "souls:thing_expired";
/// A run's reservation of a thing (F3).
pub const RESERVES: &str = "souls:reserves";

fn name(n: &str) -> Name {
    Name::new(n).unwrap_or_else(|| unreachable!("a name"))
}

fn has_link(tree: &Tree, node: Id, ty: &str) -> bool {
    tree.links_at(node)
        .iter()
        .any(|e| plain(tree.ty(e).as_str()) == ty)
}

/// Whether `node` is kept: an owner's link at it, or held in a slot of its parent. A node not in the tree is not.
pub fn kept(tree: &Tree, node: Id) -> bool {
    let Some(n) = tree.handle(node).and_then(|h| tree.node(h)) else {
        return false;
    };
    n.slot().is_some() || has_link(tree, node, OWNS)
}

/// How long a thing of kind `kind` (its full name) lasts loose, µs; `None` for ever, a kind not loaded included.
pub fn lifetime(kinds: &Kinds, kind: &str) -> Option<Micros> {
    kinds.get(kind).and_then(|k| k.loose)
}

/// What a timer came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fired {
    /// Still loose and free: write [`expired`] for it.
    Ends(Id),
    /// Kept again, or gone: the timer's clear record, by the thing's entry.
    Cleared(Id, TimerRec),
    /// Reserved or a target: it waits for [`Loose::released`].
    Waits(Id),
}

/// Every loose thing's pending end, by thing, with the things waiting on a run or an intent.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Loose {
    pending: BTreeMap<Id, Key>,
    by_timer: BTreeMap<Id, Id>,
    waiting: BTreeSet<Id>,
}

impl Loose {
    pub fn new() -> Loose {
        Loose::default()
    }

    /// The pending ends a tree holds, after a restart (from a checkpoint and the log after it): each [`ENDS`] timer
    /// goes back on `due` and is fired as before. Nothing is recomputed: a thing's end is the timer its set-down wrote.
    pub fn rebuild(tree: &Tree, due: &mut DueList) -> Result<Loose, Refusal> {
        let mut l = Loose::new();
        for (id, t) in tree.timers() {
            if t.name.as_str() != ENDS {
                continue;
            }
            due.set(Timer {
                node: t.node,
                id: *id,
                due: t.due,
                name: t.name.clone(),
            })?;
            l.pending.insert(t.node, (t.due, *id));
            l.by_timer.insert(*id, t.node);
        }
        Ok(l)
    }

    /// Things with an end pending.
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// The thing's pending end, if any.
    pub fn due(&self, node: Id) -> Option<Micros> {
        self.pending.get(&node).map(|k| k.0)
    }

    /// Things waiting on a run or an intent.
    pub fn waiting(&self) -> impl Iterator<Item = Id> + '_ {
        self.waiting.iter().copied()
    }

    /// After a change at `now` that may have made `node` loose or kept: a loose thing of a kind with a lifetime and
    /// no end pending gets one timer, due its lifetime later; a kept thing, or one whose kind lasts for ever, has its
    /// timer cancelled. Returns the timer record for the thing's entry in the same commit, if any.
    pub fn changed(
        &mut self,
        due: &mut DueList,
        mint: &mut Minter,
        tree: &Tree,
        kinds: &Kinds,
        node: Id,
        now: Micros,
    ) -> Result<Option<TimerRec>, Refusal> {
        self.changed_by(due, mint, tree, &|k| lifetime(kinds, k), node, now)
    }

    /// [`Loose::changed`], each kind's lifetime given by `life` (its full name in, µs out; `None` for ever): a world
    /// that reads lifetimes from its entries by plain name (`worldd`'s) rather than from loaded [`Kinds`].
    pub fn changed_by(
        &mut self,
        due: &mut DueList,
        mint: &mut Minter,
        tree: &Tree,
        life: &dyn Fn(&str) -> Option<Micros>,
        node: Id,
        now: Micros,
    ) -> Result<Option<TimerRec>, Refusal> {
        let Some(n) = tree.handle(node).and_then(|h| tree.node(h)) else {
            return Ok(self.cancel(due, node));
        };
        let life = life(n.kind().as_str());
        let Some(life) = life.filter(|_| !kept(tree, node)) else {
            self.waiting.remove(&node);
            return Ok(self.cancel(due, node));
        };
        if self.pending.contains_key(&node) || self.waiting.contains(&node) {
            return Ok(None);
        }
        let id = mint.mint().map_err(|_| Refusal {
            name: "ids-exhausted",
            detail: show(node),
        })?;
        let at = now.saturating_add(life);
        due.set(Timer {
            node,
            id,
            due: at,
            name: name(ENDS),
        })?;
        self.pending.insert(node, (at, id));
        self.by_timer.insert(id, node);
        Ok(Some(TimerRec::Set {
            timer: id,
            due: at,
            name: name(ENDS),
        }))
    }

    fn cancel(&mut self, due: &mut DueList, node: Id) -> Option<TimerRec> {
        let key = self.pending.remove(&node)?;
        self.by_timer.remove(&key.1);
        due.cancel(key);
        Some(TimerRec::Clear { timer: key.1 })
    }

    /// Runs a timer the due list handed back, at its due time. `None` for another system's timer. `busy` says whether
    /// a thing is the target of an accepted intent; a run's reservation is read from the tree.
    pub fn fire(&mut self, tree: &Tree, t: &Timer, busy: impl Fn(Id) -> bool) -> Option<Fired> {
        let node = self.by_timer.remove(&t.id)?;
        self.pending.remove(&node);
        if tree.handle(node).is_none() || kept(tree, node) {
            return Some(Fired::Cleared(node, TimerRec::Clear { timer: t.id }));
        }
        if busy(node) || has_link(tree, node, RESERVES) {
            self.waiting.insert(node);
            return Some(Fired::Waits(node));
        }
        Some(Fired::Ends(node))
    }

    /// A run or intent on `node` ended: a thing that waited and is still loose ends now (`true`: write
    /// [`expired`]). One kept by then waits no more and keeps no end.
    pub fn released(&mut self, tree: &Tree, node: Id) -> bool {
        self.waiting.remove(&node)
            && tree.handle(node).is_some()
            && !kept(tree, node)
            && !has_link(tree, node, RESERVES)
    }

    /// Forgets `node`, removed by anything (its timers leave the due list with K9's `cancel_under`).
    pub fn removed(&mut self, node: Id) {
        if let Some(key) = self.pending.remove(&node) {
            self.by_timer.remove(&key.1);
        }
        self.waiting.remove(&node);
    }
}

/// The one effect that ends loose thing `node` at `at`: its entry (audience `audience`, the thing's), the world its
/// actor and cause, one remove, and the event [`EXPIRED`] naming the thing.
pub fn expired(
    node: Id,
    audience: replica::world_model::Audience,
    sequence: u64,
    at: Micros,
) -> Effect {
    Effect {
        envelope: Envelope {
            sequence,
            at,
            cause: Cause::World,
            actor: Actor::World,
            audience,
            node,
        },
        body: Body::Changes(vec![ChangeRec {
            change: Change::Remove { node },
            rest: Rest::new(),
        }]),
        events: Some(vec![Event {
            name: name(EXPIRED),
            fields: BTreeMap::from([(1, node.to_value())]),
            changes: vec![0],
            rest: Rest::new(),
        }]),
        rest: Rest::new(),
    }
}
