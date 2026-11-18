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

use replica::ids::Id;

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
}
