//! Loose things end in a served world (Engine v2 F10b, #3476): F10's [`sim::expiry::Loose`] wired into the tick.
//!
//! - **Lifetimes** are the world's entries' (`"loose": {"us": µs}`, by the kind's plain name, [`lives`]): a served
//!   world's tree kinds are its importer's, so they are matched by plain name, as the checkers match entries.
//! - **After the tick's commits** ([`Ends::after`]): every node an effect of the tick created, removed, moved (a
//!   reparent, a transfer's leave or arrive) or linked, and both ends of each owner's link the tick ended
//!   ([`Ends::unlinking`], read before the unlink applies), is tested by [`Loose::changed_by`]. A set-down, a take
//!   and an unlink are all such commits, by whatever path they come. The timers it sets or clears are written as the
//!   world's own entries in the same tick, so they are state (`v2/docs/effects.md` rule 15) and in the log.
//! - **In step 1** ([`Ends::next`]), each `souls:loose-ends` timer due before the next tick fires at its due time:
//!   a thing still loose ends by F10's one effect ([`sim::expiry::expired`]); one kept since has its timer cleared.
//! - **A start** ([`Ends::start`]) rebuilds the pending ends from the timers the tree holds, a checkpoint's and the
//!   log's after it: nothing is recomputed, so replaying the log gives the same tree.
//!
//! A world whose entries give no kind a lifetime does nothing here: no scan, no timer.
//!
//! Not here: an intent's target waiting (no accepted intent holds a thing in this loop yet; a run's reservation is
//! read from the tree, and a thing that waits keeps its timer, F10's known limit).

use std::collections::{BTreeMap, BTreeSet};

use replica::audience::OWNS;
use replica::effects::{Body, Change, Effect, Envelope, TimerRec, TransferRec};
use replica::ids::{Id, Minter, Scope, sha256};
use replica::rules::json::Value as Json;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{Audience, plain};
use sim::expiry::{Fired, Loose, expired};
use sim::timers::DueList;

/// Each kind's lifetime loose, µs, by plain name, from the world's entries (`souls-entry/1`, as `Rules::kinds`
/// holds them): a kind with `"loose": {"us": n}`, n > 0. `{"ever": true}` and no section are for ever.
pub fn lives(kinds: &Json) -> BTreeMap<String, Micros> {
    let mut out = BTreeMap::new();
    if let Json::Obj(rows) = kinds {
        for (kind, entry) in rows {
            if let Some(Json::Int(us)) = entry.get("loose").and_then(|l| l.get("us"))
                && let Ok(us) = Micros::try_from(*us)
                && us > 0
            {
                out.insert(kind.clone(), us);
            }
        }
    }
    out
}

/// The world's loose things' ends: F10's [`Loose`], its own due list and its timers' minter.
pub struct Ends {
    loose: Loose,
    due: DueList,
    mint: Minter,
    lives: BTreeMap<String, Micros>,
}

impl Ends {
    /// The ends a tree holds (a restart's, rebuilt from its timers), with the world's lifetimes. Timer ids are minted
    /// in a scope of this start's own (the zone and the version started at), so a restart never mints one again.
    pub fn start(
        tree: &Tree,
        lives: BTreeMap<String, Micros>,
        zone: Id,
        version: u64,
    ) -> Result<Ends, replica::effects::Refusal> {
        let mut due = DueList::new();
        let loose = Loose::rebuild(tree, &mut due)?;
        let mut scope = [0u8; 16];
        scope.copy_from_slice(
            &sha256(format!("souls/worldd/loose-ends/{zone:?}/{version}").as_bytes())[..16],
        );
        Ok(Ends {
            loose,
            due,
            mint: Minter::new(Scope(scope)),
            lives,
        })
    }

    /// Whether nothing can be loose here: no kind has a lifetime and no end is pending.
    pub fn idle(&self) -> bool {
        self.lives.is_empty() && self.loose.is_empty()
    }

    /// The earliest pending end (O2: when a sleeping world must be up).
    pub fn next_due(&self) -> Option<Micros> {
        self.due.next_due()
    }

    /// Things with an end pending.
    pub fn pending(&self) -> usize {
        self.loose.len()
    }

    /// The thing's pending end, if any.
    pub fn due(&self, node: Id) -> Option<Micros> {
        self.loose.due(node)
    }

    /// Both ends of each owner's link these changes end, read on `tree` before they apply (after, the link is gone).
    pub fn unlinking<'a>(tree: &Tree, changes: impl IntoIterator<Item = &'a Change>) -> Vec<Id> {
        let mut out = Vec::new();
        for c in changes {
            if let Change::Unlink { link } = c
                && let Some((ty, ends, ..)) = tree.link(*link)
                && plain(ty.as_str()) == OWNS
            {
                out.extend(ends);
            }
        }
        out
    }

    /// The nodes whose being loose or kept these effects may have changed.
    pub fn touched(effects: &[Effect]) -> BTreeSet<Id> {
        let mut out = BTreeSet::new();
        let change = |c: &Change, out: &mut BTreeSet<Id>| match c {
            Change::Create { node, .. }
            | Change::Remove { node }
            | Change::Reparent { node, .. } => {
                out.insert(*node);
            }
            Change::Link { ends, .. } => out.extend(ends),
            Change::Set { .. } | Change::Unlink { .. } | Change::Motion(_) => {}
        };
        for e in effects {
            match &e.body {
                Body::Changes(cs) => cs.iter().for_each(|c| change(&c.change, &mut out)),
                Body::Transfer(TransferRec::Leave { node, .. }) => {
                    out.insert(*node);
                }
                Body::Transfer(TransferRec::Arrive { carried, .. }) => {
                    carried.iter().for_each(|c| change(&c.change, &mut out))
                }
                _ => {}
            }
        }
        out
    }

    /// After the tick's commits at `now`: each node in `nodes` that became loose gets its end, one that became kept
    /// has it cancelled. Returns the timer entries to write in this tick, one per thing, on the thing.
    pub fn after(
        &mut self,
        tree: &Tree,
        nodes: impl IntoIterator<Item = Id>,
        now: Micros,
    ) -> Vec<Effect> {
        let lives = &self.lives;
        let life = |k: &str| lives.get(plain(k)).copied();
        let mut out = Vec::new();
        for node in nodes {
            let rec = self
                .loose
                .changed_by(&mut self.due, &mut self.mint, tree, &life, node, now);
            match rec {
                // A thing removed takes its timers with it: nothing to clear.
                Ok(Some(rec)) => {
                    if let Some(n) = tree.handle(node).and_then(|h| tree.node(h)) {
                        out.push(timers(node, n.audience(), now, rec));
                    }
                }
                Ok(None) => {}
                Err(r) => eprintln!("worldd: a loose thing's end was not set: {r}"),
            }
        }
        out
    }

    /// The next entry step 1 writes for a timer due before `before`: a loose thing's end (F10's one effect, at the
    /// timer's due time), or the timer of a thing kept since cleared. `None` once nothing more is due.
    pub fn next(&mut self, tree: &Tree, before: Micros) -> Option<Effect> {
        while let Some(t) = self.due.fire(before) {
            // Another system's timer, or one already let go: passed by.
            let Some(fired) = self.loose.fire(tree, &t, |_| false) else {
                continue;
            };
            match fired {
                Fired::Ends(node) => {
                    let Some(n) = tree.handle(node).and_then(|h| tree.node(h)) else {
                        continue;
                    };
                    let audience = n.audience();
                    self.due.cancel_under(tree, node);
                    self.loose.removed(node);
                    return Some(expired(node, audience, 0, t.due));
                }
                Fired::Cleared(node, rec) => {
                    if let Some(n) = tree.handle(node).and_then(|h| tree.node(h)) {
                        return Some(timers(node, n.audience(), t.due, rec));
                    }
                }
                Fired::Waits(_) => {}
            }
        }
        None
    }
}

/// A world's own timer entry on `node` at `at` (its sequence is set when written).
fn timers(node: Id, audience: Audience, at: Micros, rec: TimerRec) -> Effect {
    Effect {
        envelope: Envelope {
            sequence: 0,
            at,
            cause: replica::effects::Cause::World,
            actor: replica::effects::Actor::World,
            audience,
            node,
        },
        body: Body::Timers(vec![rec]),
        events: None,
        rest: replica::effects::Rest::new(),
    }
}
