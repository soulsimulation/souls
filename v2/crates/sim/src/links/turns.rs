//! Narrow places taken in turns (Engine v2 N8, #2656): where two bodies cannot pass, one direction at a time.
//!
//! - **Narrow.** A link under [`NARROW`] wide (the 1.0 m stair, a 0.9 m door). Its owning node holds its turn state
//!   ([`State`]): the direction it lets in, the walker granted entry, and the timeline of its turns.
//! - **Who writes.** Only the owning node writes the state, through [`Turns::write`], which refuses any other node by
//!   name (`turn-not-owner`). A walker never writes it: it marks itself waiting for the link, and the owner reads
//!   the marks of the last tick (T1, `v2/docs/TRUNK.md`), as [`Facts`], and writes its grants.
//! - **A grant.** One walker at a time, the waiting one nearest the end the link lets in, and only when the far end
//!   has room to step out into, every body inside going the same way is at least [`SPACING`] along, and no grant is
//!   outstanding.
//! - **A turn.** The direction changes when the link is empty and the other side waits, or, while the other side
//!   waits, after [`RUN`] walkers or [`RUN_TIME`] in one direction (then no more are let in, and it changes once the
//!   link is empty).
//! - **Still bodies.** A body staying in the link by its own order is no walker in its facts: it is never inside, and
//!   walkers pass it as they pass any still body (N7: other bodies are a preference, not a wall).
//! - **Crowded wide links** (0.133 A2-4). A wide link is taken in turns too while crowded ([`Turns::crowded`]): from
//!   the tick a walker marks itself waiting for it (the walk does so when bodies crowd its mouth) to the tick none
//!   waits for it and none is inside on its turn; then its state is dropped. Its grants wait for [`WIDE_SPACING`].
//!
//! Integers only: µm and µs. Not here: crowds in the open, rides (N12), the order to stay (E3), a walker that waits
//! too long (N10).

use super::Link;
use replica::effects::Refusal;
use replica::ids::Id;
use replica::time::Micros;
use replica::world_model::show;
use std::collections::{BTreeMap, BTreeSet};

/// A link under this width (µm) is taken in turns.
pub const NARROW: i64 = 1_200_000;
/// A grant waits until every body inside going the same way is this far along, µm.
pub const SPACING: i64 = 900_000;
/// A grant to a wide link taken in turns waits until every body inside going the same way is this far along, µm.
pub const WIDE_SPACING: i64 = 350_000;
/// The far end has room when no body that is not waiting for the link stands within this of its middle, µm.
pub const ROOM: i64 = 600_000;
/// Walkers let in one direction before the other side, waiting, gets its turn.
pub const RUN: u32 = 8;
/// Time one direction may run before the other side, waiting, gets its turn, µs.
pub const RUN_TIME: Micros = 10_000_000;

/// Whether a link is taken in turns.
pub fn narrow(l: &Link) -> bool {
    l.width < NARROW
}

/// What the owner reads of a link, as of the last tick: who waits at each end and how far from it (µm), who is
/// inside (the end it came in by and how far along, µm), and whether each end has room to step out into.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub waiting: [Vec<(i64, Id)>; 2],
    pub inside: Vec<(u8, i64, Id)>,
    pub room: [bool; 2],
}

/// One entry of a link's timeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Turn {
    /// The direction changed to let in from end `to`, with this many waiting at each end.
    Change {
        at: Micros,
        to: u8,
        waiting: [usize; 2],
    },
    /// `who`, waiting at end `end`, was let in.
    Grant { at: Micros, who: Id, end: u8 },
}

/// A narrow link's turn state, held by its owning node.
#[derive(Clone, Debug, Default)]
pub struct State {
    /// The end it lets in from.
    pub dir: Option<u8>,
    /// When the direction last changed, µs.
    pub since: Micros,
    /// Walkers let in since then.
    pub entered: u32,
    /// The walker let in and not yet inside.
    pub granted: Option<Id>,
    /// Every change and grant, in order.
    pub timeline: Vec<Turn>,
}

/// The turn states of the narrow links, by owning node and link.
#[derive(Default)]
pub struct Turns {
    pub owners: BTreeMap<Id, BTreeMap<Id, State>>,
    /// The wide links taken in turns while crowded (0.133 A2-4): from the tick a walker marks itself waiting for one
    /// (it does so when bodies crowd its mouth) to the tick none waits for it and none is inside.
    pub crowded: BTreeSet<Id>,
}

impl Turns {
    pub fn new() -> Turns {
        Turns::default()
    }

    /// The state of link `link`, if its owner has written one.
    pub fn state(&self, link: &Link) -> Option<&State> {
        self.owners.get(&link.owner)?.get(&link.id)
    }

    /// Drops link `link`'s state: a wide link no longer crowded is free again (A2-4).
    pub fn forget(&mut self, link: &Link) {
        if let Some(m) = self.owners.get_mut(&link.owner) {
            m.remove(&link.id);
        }
    }

    /// Whether `who` may enter `link` now: granted by its owner.
    pub fn granted(&self, link: &Link, who: Id) -> bool {
        self.state(link).is_some_and(|s| s.granted == Some(who))
    }

    /// The owner `owner` writes link `link`'s state for world time `at` from the facts of the last tick. Any node but
    /// the link's owner is refused (`turn-not-owner`).
    pub fn write(&mut self, owner: Id, link: &Link, f: &Facts, at: Micros) -> Result<(), Refusal> {
        if owner != link.owner {
            return Err(Refusal {
                name: "turn-not-owner",
                detail: format!("{} writes {}", show(owner), show(link.id)),
            });
        }
        let s = self
            .owners
            .entry(owner)
            .or_default()
            .entry(link.id)
            .or_default();
        // A grant ends when its walker is inside, or no longer waits.
        if let Some(g) = s.granted
            && (f.inside.iter().any(|i| i.2 == g) || !f.waiting.iter().flatten().any(|w| w.1 == g))
        {
            s.granted = None;
        }
        let waits = [!f.waiting[0].is_empty(), !f.waiting[1].is_empty()];
        let empty = f.inside.is_empty() && s.granted.is_none();
        let spent = |s: &State, d: u8| {
            waits[usize::from(1 - d)] && (s.entered >= RUN || at - s.since >= RUN_TIME)
        };
        if empty {
            let to = match s.dir {
                None => (0..2u8)
                    .filter(|&e| waits[usize::from(e)])
                    .max_by_key(|&e| (f.waiting[usize::from(e)].len(), 1 - e)),
                Some(d) if spent(s, d) || (!waits[usize::from(d)] && waits[usize::from(1 - d)]) => {
                    Some(1 - d)
                }
                d => d,
            };
            if to != s.dir {
                s.dir = to;
                s.since = at;
                s.entered = 0;
                if let Some(to) = to {
                    s.timeline.push(Turn::Change {
                        at,
                        to,
                        waiting: [f.waiting[0].len(), f.waiting[1].len()],
                    });
                }
            }
        }
        let Some(d) = s.dir else { return Ok(()) };
        // A wide link taken in turns while crowded (A2-4) lets the next one in sooner: two pass abreast in it.
        let spacing = if narrow(link) { SPACING } else { WIDE_SPACING };
        let clear = f
            .inside
            .iter()
            .all(|&(from, along, _)| from == d && along >= spacing);
        if s.granted.is_none()
            && !spent(s, d)
            && clear
            && f.room[usize::from(1 - d)]
            && let Some(&(_, who)) = f.waiting[usize::from(d)].iter().min()
        {
            s.granted = Some(who);
            s.entered += 1;
            s.timeline.push(Turn::Grant { at, who, end: d });
        }
        Ok(())
    }
}
