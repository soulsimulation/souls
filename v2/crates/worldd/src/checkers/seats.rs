//! Resolving a slot's ranked list off the clock (Engine v2 I5, #2690). A checker takes an act's candidates, named
//! slots and selectors (`replica::selector`), and resolves each selector on its copy of the seats to its best
//! [`FEW`] by the selector's own rule; the clock thread then binds them in rank order (`sim::commit::bind`), one
//! lookup each. The scan of a room's slots happens here, never on the clock thread ([`off_clock`]).
//!
//! The copy is [`SeatsSeen`]: the seats as built (their thing, room, kind and point) and the set held at a version.
//! The holds are B3's table (`sim::slots`), not yet in the tree, so the clock publishes that set as it publishes K8's
//! frozen copy.
//!
//! **A described spot** (selector 2, E2 #2709) is resolved here too ([`spot`]): on the checker's frozen copy of the
//! tree, by the shared library (`replica::select`), so the answer is the client's at the same version. The clock
//! thread binds it once, at commit (`sim::commit::spot`, `crate::answers`).

use std::collections::HashSet;
use std::sync::Arc;

use replica::effects::Refusal;
use replica::encode::Name;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::select::{Resolved, Spot, position};
use replica::selector::{FEW, Selector, best};
use replica::tree::Tree;
use sim::commit::bind::Slot;
use sim::commit::off_clock;

/// One seat as built: its thing, the room (node) it is in, its kind and its slot's point in the room's frame, µm.
#[derive(Clone, Debug)]
pub struct SeatRow {
    pub thing: Id,
    pub room: Id,
    pub kind: Name,
    pub point: Vec3,
}

/// A checker's copy of the seats: as built, and the things whose seat was held at `version`.
#[derive(Clone, Debug)]
pub struct SeatsSeen {
    pub version: u64,
    pub seats: Arc<Vec<SeatRow>>,
    pub held: Arc<HashSet<Id>>,
}

/// A candidate as the agent wrote it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Wanted {
    Named(Id),
    Select(Selector),
}

/// Resolves `wanted` for a body at `body` (the room's frame) on `seen`, in rank order.
pub fn resolve(seen: &SeatsSeen, body: Vec3, wanted: &[Wanted]) -> Vec<Slot> {
    wanted
        .iter()
        .map(|w| match w {
            Wanted::Named(t) => Slot::Named(*t),
            Wanted::Select(s) => {
                off_clock();
                let Selector::FreeSlot { kind, node, rule } = s;
                let free = seen.seats.iter().filter(|r| {
                    r.room == *node && r.kind == *kind && !seen.held.contains(&r.thing)
                });
                let count = free.clone().count();
                Slot::Selected {
                    few: best(*rule, body, free.map(|r| (r.thing, r.point)), FEW),
                    free: count,
                }
            }
        })
        .collect()
}

/// Resolves described spot `spot` for `body` on `copy`, a checker's frozen copy, with the shared library: the answer a
/// client gives at the same version. The body is "me" when it is a node of the copy. Refused by the library's own
/// names (`spot.none`, `spot.no-front`, ...). `held(thing, slot)` is the slots taken, as the copy knows them.
pub fn spot(
    copy: &Tree,
    spot: &Spot,
    body: Id,
    held: &dyn Fn(Id, u64) -> bool,
) -> Result<Resolved, Refusal> {
    off_clock();
    replica::select::resolve(copy, spot, position(copy, body).ok(), held)
}

impl super::SpotAct {
    /// Resolves this act's spot on a checker's copy ([`spot`]). B3's holds are not in the copy yet (as for
    /// [`SeatsSeen`]), so a slot taken since is caught when it is bound, at commit.
    pub fn resolve(&mut self, copy: &Tree, body: Id) {
        self.resolved = Some(spot(copy, &self.spot, body, &|_, _| false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;
    use replica::selector::Rule;
    use sim::commit::bind::{Bound, NONE_FREE, bind};

    fn id(n: u64) -> Id {
        Id::new(Scope([9; 16]), n).unwrap()
    }

    #[test]
    fn a_selector_resolves_to_the_nearest_free_of_its_kind_in_its_room_and_binds_in_order() {
        let chair = Name::new("eden:chair").unwrap();
        let row = |n: u64, room: u64, kind: &Name, x: i64| SeatRow {
            thing: id(n),
            room: id(room),
            kind: kind.clone(),
            point: Vec3::new(x, 0, 0),
        };
        let seats = vec![
            row(10, 1, &chair, 1),
            row(11, 1, &chair, 2),
            row(12, 2, &chair, 0),
            row(13, 1, &Name::new("eden:bed").unwrap(), 0),
            row(14, 1, &chair, 3),
            row(15, 1, &chair, 4),
        ];
        let seen = SeatsSeen {
            version: 1,
            seats: Arc::new(seats),
            held: Arc::new(HashSet::from([id(10)])),
        };
        let any = Wanted::Select(Selector::FreeSlot {
            kind: chair,
            node: id(1),
            rule: Rule::Nearest,
        });
        let list = resolve(
            &seen,
            Vec3::new(0, 0, 0),
            &[Wanted::Named(id(10)), any.clone()],
        );
        assert_eq!(
            list[1],
            Slot::Selected {
                few: vec![id(11), id(14), id(15)],
                free: 3
            }
        );
        // 11 was taken after the check: the next of the few binds, at the selector's rank.
        let live = |t: Id| t != id(10) && t != id(11);
        assert_eq!(
            bind(&list, live, 2, false),
            Bound::Slot {
                rank: 1,
                thing: id(14)
            }
        );
        let full = SeatsSeen {
            held: Arc::new(HashSet::from([id(10), id(11), id(14), id(15)])),
            ..seen
        };
        let list = resolve(&full, Vec3::new(0, 0, 0), &[any]);
        assert_eq!(bind(&list, |_| false, 2, false), Bound::Ended(NONE_FREE));
    }
}
