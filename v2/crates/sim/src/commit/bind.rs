//! Ranked fallbacks for a slot (Engine v2 I5, #2690): the clock thread binds the first candidate of an act's ranked
//! list that holds. A candidate is a named slot or a selector (`replica::selector`) a checker has already resolved
//! on its copy to its best few, in rank order. Binding confirms them in that order, one lookup each (B3's holder is a
//! field, never a scan), and names what it bound: the candidate's rank and the slot.
//!
//! - A named slot that is taken gives way to the next candidate.
//! - A selector whose few were all taken since its check (and whose checker saw some free) goes back for one re-check
//!   on a newer copy, as I3's stale read set does; still taken after it, the act is refused `stale`.
//! - A selector whose checker saw no free slot ends the list `seat.none-free`, a named end: the agent is told there
//!   is no seat, not refused into a second turn.
//! - A list of named slots only, all taken, is refused `seat-taken`, as B3 names it.
//!
//! **Bursts** (I5b, #3178). When many sends resolve on one copy, their few overlap and most would go back and end
//! `stale`. So a selector whose few were all taken is resolved again at commit, by the clock thread, from
//! [`FreeIndex`]: the free slots of each room and kind, kept as slots are taken and given back. The index is exact,
//! so a burst fills every free slot and the rest end `seat.none-free` by name. A sit from the gateway has no checker
//! yet, so its selector is resolved here at commit too.

use std::collections::{BTreeMap, BTreeSet};

use replica::encode::Name;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::selector::{FEW, Rule, Selector, best};

/// The end of a list exhausted with no slot free.
pub const NONE_FREE: &str = "seat.none-free";

/// One candidate as the clock thread takes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Slot {
    /// A slot the agent named.
    Named(Id),
    /// A selector, resolved by a checker: its best few in rank order, and how many free slots it saw.
    Selected { few: Vec<Id>, free: usize },
}

/// What binding did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Bound {
    /// The candidate of this rank bound this slot: the receipt names both.
    Slot { rank: usize, thing: Id },
    /// Check the selectors again on a copy at this version or newer.
    Recheck { version: u64 },
    /// The list ended by this name: [`NONE_FREE`], `seat-taken` or `stale`.
    Ended(&'static str),
}

/// Binds `candidates` in rank order; `free` is the live table's one lookup, `version` the live table's version and
/// `rechecked` whether the selectors were already checked again once.
pub fn bind(
    candidates: &[Slot],
    free: impl Fn(Id) -> bool,
    version: u64,
    rechecked: bool,
) -> Bound {
    let (mut stale, mut none) = (false, false);
    for (rank, c) in candidates.iter().enumerate() {
        match c {
            Slot::Named(t) if free(*t) => return Bound::Slot { rank, thing: *t },
            Slot::Named(_) => {}
            Slot::Selected { few, free: seen } => {
                if let Some(&thing) = few.iter().find(|t| free(**t)) {
                    return Bound::Slot { rank, thing };
                }
                if *seen == 0 {
                    none = true;
                } else {
                    stale = true;
                }
            }
        }
    }
    match (stale, none, rechecked) {
        (true, _, false) => Bound::Recheck { version },
        (_, true, _) => Bound::Ended(NONE_FREE),
        (true, false, true) => Bound::Ended("stale"),
        (false, false, _) => Bound::Ended("seat-taken"),
    }
}

/// A grid cell of the index, µm on a side: a room's slots are bucketed by cell in its floor plane (x, z).
const CELL: i64 = 2_000_000;

type Cell = (i64, i64);

fn cell_of(p: Vec3) -> Cell {
    (p.x.div_euclid(CELL), p.z.div_euclid(CELL))
}

struct Room {
    cells: BTreeMap<Cell, BTreeSet<Id>>,
    free: usize,
    /// The cells any slot of the room was ever in: a query stops at their bounds.
    low: Cell,
    high: Cell,
}

/// The free slots of each room and kind (I5b, #3178): what the clock thread resolves a selector from at commit. Each
/// lookup is a field or a cell; a nearest query visits the cells in rings out from the body's cell, and stops when no
/// unseen cell can hold a slot nearer than the few it has, or at the room's bounds.
#[derive(Default)]
pub struct FreeIndex {
    slots: BTreeMap<Id, ((Id, Name), Vec3, bool)>,
    rooms: BTreeMap<(Id, Name), Room>,
}

impl FreeIndex {
    pub fn new() -> FreeIndex {
        FreeIndex::default()
    }

    /// Adds a free slot: its thing, the room (node) it is in, its kind and its point in the room's frame, µm.
    pub fn add(&mut self, thing: Id, room: Id, kind: Name, point: Vec3) {
        let key = (room, kind);
        let c = cell_of(point);
        let r = self.rooms.entry(key.clone()).or_insert(Room {
            cells: BTreeMap::new(),
            free: 0,
            low: c,
            high: c,
        });
        r.low = (r.low.0.min(c.0), r.low.1.min(c.1));
        r.high = (r.high.0.max(c.0), r.high.1.max(c.1));
        // In as taken, then given back: one path keeps the counts.
        self.slots.insert(thing, (key, point, true));
        self.give_back(thing);
    }

    fn set(&mut self, thing: Id, taken: bool) {
        let Some((key, point, was)) = self.slots.get_mut(&thing) else {
            return;
        };
        if *was == taken {
            return;
        }
        *was = taken;
        let Some(r) = self.rooms.get_mut(key) else {
            return;
        };
        let c = cell_of(*point);
        if taken {
            r.free -= 1;
            if let Some(set) = r.cells.get_mut(&c) {
                set.remove(&thing);
                if set.is_empty() {
                    r.cells.remove(&c);
                }
            }
        } else {
            r.free += 1;
            r.cells.entry(c).or_default().insert(thing);
        }
    }

    /// The slot of `thing` is taken.
    pub fn take(&mut self, thing: Id) {
        self.set(thing, true);
    }

    /// The slot of `thing` is free again.
    pub fn give_back(&mut self, thing: Id) {
        self.set(thing, false);
    }

    /// Free slots of `kind` in `room`.
    pub fn free(&self, room: Id, kind: &Name) -> usize {
        self.rooms.get(&(room, kind.clone())).map_or(0, |r| r.free)
    }

    /// Resolves `selector` for a body at `body` (the room's frame) at commit: its best [`FEW`] by its rule, and the
    /// free slots it had, as a checker hands them over; and the cells visited.
    pub fn resolve(&self, selector: &Selector, body: Vec3) -> (Slot, usize) {
        let Selector::FreeSlot { kind, node, rule } = selector;
        let Some(r) = self.rooms.get(&(*node, kind.clone())) else {
            return (
                Slot::Selected {
                    few: Vec::new(),
                    free: 0,
                },
                0,
            );
        };
        match rule {
            Rule::Nearest => {
                let d2 = |p: Vec3| {
                    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
                    d(p.x, body.x) + d(p.y, body.y) + d(p.z, body.z)
                };
                let (cx, cz) = cell_of(body);
                let mut seen: Vec<(Id, Vec3)> = Vec::new();
                let mut kth: Vec<i128> = Vec::new();
                let (mut visited, mut ring) = (0, 0i64);
                loop {
                    // Every cell at Chebyshev distance `ring` from the body's cell, inside the room's bounds.
                    for x in (cx - ring).max(r.low.0)..=(cx + ring).min(r.high.0) {
                        for z in (cz - ring).max(r.low.1)..=(cz + ring).min(r.high.1) {
                            if (x - cx).abs() != ring && (z - cz).abs() != ring {
                                continue;
                            }
                            visited += 1;
                            for t in r.cells.get(&(x, z)).into_iter().flatten() {
                                let p = self.slots[t].1;
                                seen.push((*t, p));
                                kth.push(d2(p));
                            }
                        }
                    }
                    // An unseen cell is at least `ring` cells away on one axis: no nearer than ring * CELL.
                    let bound = i128::from(ring * CELL) * i128::from(ring * CELL);
                    let enough = kth.len() >= FEW.min(r.free) && {
                        kth.sort_unstable();
                        kth.get(FEW.min(r.free).saturating_sub(1))
                            .is_none_or(|d| *d <= bound)
                    };
                    let past = cx - ring <= r.low.0
                        && cx + ring >= r.high.0
                        && cz - ring <= r.low.1
                        && cz + ring >= r.high.1;
                    if enough || past {
                        break;
                    }
                    ring += 1;
                }
                let few = best(*rule, body, seen.into_iter(), FEW);
                (Slot::Selected { few, free: r.free }, visited)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;

    fn id(n: u64) -> Id {
        Id::new(Scope([3; 16]), n).unwrap()
    }

    #[test]
    fn the_first_candidate_that_holds_binds_and_is_named() {
        let free = |t: Id| t != id(1) && t != id(2);
        let list = [
            Slot::Named(id(1)),
            Slot::Selected {
                few: vec![id(2), id(3), id(4)],
                free: 3,
            },
        ];
        assert_eq!(
            bind(&list, free, 7, false),
            Bound::Slot {
                rank: 1,
                thing: id(3)
            }
        );
        assert_eq!(bind(&list[..1], free, 7, false), Bound::Ended("seat-taken"));
    }

    #[test]
    fn an_exhausted_list_ends_none_free_or_goes_back_once() {
        let taken = |_: Id| false;
        let none = [
            Slot::Named(id(1)),
            Slot::Selected {
                few: vec![],
                free: 0,
            },
        ];
        assert_eq!(bind(&none, taken, 7, false), Bound::Ended(NONE_FREE));
        let few = [Slot::Selected {
            few: vec![id(2)],
            free: 1,
        }];
        assert_eq!(bind(&few, taken, 7, false), Bound::Recheck { version: 7 });
        assert_eq!(bind(&few, taken, 8, true), Bound::Ended("stale"));
    }

    #[test]
    fn the_index_resolves_the_nearest_free_and_keeps_up_with_takes() {
        let kind = Name::new("test:slot").unwrap();
        let room = id(100);
        let mut ix = FreeIndex::new();
        // A row of slots 1 m apart along x, from 0 to 29 m: 15 cells of the grid.
        for n in 0..30u64 {
            ix.add(
                id(n),
                room,
                kind.clone(),
                Vec3::new(n as i64 * 1_000_000, 0, 0),
            );
        }
        let any = Selector::FreeSlot {
            kind: kind.clone(),
            node: room,
            rule: Rule::Nearest,
        };
        let at = Vec3::new(20_400_000, 0, 0);
        let (s, visited) = ix.resolve(&any, at);
        assert_eq!(
            s,
            Slot::Selected {
                few: vec![id(20), id(21), id(19)],
                free: 30
            }
        );
        assert!(
            visited <= 3,
            "a ring or two of cells, not the room: {visited}"
        );
        for n in 15..30 {
            ix.take(id(n));
        }
        let (s, _) = ix.resolve(&any, at);
        assert_eq!(
            s,
            Slot::Selected {
                few: vec![id(14), id(13), id(12)],
                free: 15
            },
            "taken slots are left out; the nearest free are further off"
        );
        ix.give_back(id(29));
        assert_eq!(ix.free(room, &kind), 16);
        for n in 0..30 {
            ix.take(id(n));
        }
        let (s, _) = ix.resolve(&any, at);
        assert_eq!(bind(&[s], |_| true, 1, false), Bound::Ended(NONE_FREE));
    }
}
