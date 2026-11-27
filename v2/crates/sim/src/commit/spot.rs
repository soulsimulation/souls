//! A described spot bound at commit (Engine v2 E2, #2709), beside N9's standing spots. A checker resolves the spot
//! on its copy with the shared library (`replica::select`), so its answer is the client's at the same version; the
//! clock thread binds that answer once, here, and the act carries what was bound to its end. Bound once, a spot
//! never flips mid-walk between two near-equal answers.
//!
//! - **A slot** the description picked is bound as I5 binds a selector's few ([`bind`]): free, it is the act's slot;
//!   taken since the check, the act goes back for one re-check as I5's does.
//! - **A thing or a point** becomes N9's target in the frame of the node the spot stands in. The walker asks N9's
//!   table for it, and the table's owner grants the nearest legal standing spot (on walkable ground, never in a
//!   doorway or on a stair), recorded as the engine's choice (`crate::spots::Entry::Grant`, the world its actor) where
//!   the tables keep their record (a served world's keep none, `crate::spots::Spots::forget_record`).
//!   The client does not load the ground, so for a point its verdict is unknown until then (R2).

use replica::ids::Id;
use replica::select::{Answer, Resolved};

use super::bind::{Bound, Slot, bind};
use crate::spots::Target;

/// What a resolved spot binds to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Spot {
    /// Slot `slot` of `thing`.
    Slot { thing: Id, slot: u64 },
    /// A standing spot near this target, for N9's table to grant.
    Stand(Target),
}

/// The binding of a resolved spot, made once at commit.
pub fn once(r: &Resolved) -> Spot {
    match r.answer {
        Answer::Slot { thing, slot, .. } => Spot::Slot { thing, slot },
        Answer::Thing { .. } | Answer::Point { .. } => Spot::Stand(Target::new(r.frame, r.local)),
    }
}

/// Binds a slot spot on the live table: `free` is its one lookup, as I5's [`bind`].
pub fn bind_slot(thing: Id, free: impl Fn(Id) -> bool, version: u64, rechecked: bool) -> Bound {
    bind(
        &[Slot::Selected {
            few: vec![thing],
            free: 1,
        }],
        free,
        version,
        rechecked,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;
    use replica::pose::Vec3;

    fn id(n: u64) -> Id {
        Id::new(Scope([5; 16]), n).unwrap()
    }

    #[test]
    fn a_point_becomes_n9s_target_and_a_slot_binds_as_i5s() {
        let r = Resolved {
            answer: Answer::Point { at: [1, 2] },
            frame: id(1),
            local: Vec3::new(3, 0, 4),
        };
        assert_eq!(
            once(&r),
            Spot::Stand(Target::new(id(1), Vec3::new(3, 0, 4)))
        );
        let s = Resolved {
            answer: Answer::Slot {
                thing: id(7),
                slot: 2,
                at: [0, 0],
            },
            ..r
        };
        assert_eq!(
            once(&s),
            Spot::Slot {
                thing: id(7),
                slot: 2
            }
        );
        assert_eq!(
            bind_slot(id(7), |_| true, 3, false),
            Bound::Slot {
                rank: 0,
                thing: id(7)
            }
        );
        assert_eq!(
            bind_slot(id(7), |_| false, 3, false),
            Bound::Recheck { version: 3 }
        );
    }
}
