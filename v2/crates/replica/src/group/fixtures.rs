//! The five moving groups of `v2/docs/moving-group.md` ("The fixtures"), each a [`Scene`] with ids as counters in
//! fixture scope A. Lengths are µm in the group's frame (+x to the front, +z to the side, T4 rule 5). The table on
//! the page maps the six tasks that build on the group (B9, B14, E5, E9, E12, N12) to these.

use super::{Belonging, Group, Leave, Member, Outline, Scene};
use crate::ids::{FIXTURE_SCOPE_A, Id};
use crate::pose::Vec3;

fn id(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_A, n).expect("below 2^53")
}

/// The place, a node of the world that stays put: every walker's parent and every group node's.
const PLACE: u64 = 1;

fn walker(n: u64, x: i64, z: i64, steers: bool) -> Member {
    Member {
        node: id(n),
        belongs: Belonging::Walker {
            place: Vec3 { x, y: 0, z },
        },
        steers,
    }
}

fn rider(n: u64, steers: bool) -> Member {
    Member {
        node: id(n),
        belongs: Belonging::Rider,
        steers,
    }
}

/// A scene with one group on node `g`: riders are `g`'s children, walkers and `g` the place's.
fn scene(g: u64, track: bool, members: Vec<Member>, outline: Outline, leave: Leave) -> Scene {
    let mut parents = std::collections::BTreeMap::new();
    parents.insert(id(g), id(PLACE));
    for m in &members {
        let parent = match m.belongs {
            Belonging::Rider => id(g),
            Belonging::Walker { .. } => id(PLACE),
        };
        parents.insert(m.node, parent);
    }
    Scene {
        parents,
        groups: vec![Group {
            node: id(g),
            track,
            members,
            outline,
            leave: Some(leave),
        }],
    }
}

/// A 2 m load carried by two bodies (B9): the carry activity is the group (node 10), the load rides it (11), the
/// carriers walk at its ends (12 in front leads, 13 behind). Rigid: 3.3 m by 0.56 m with the carriers.
pub fn carried_load() -> Scene {
    scene(
        10,
        false,
        vec![
            rider(11, false),
            walker(12, 1_350_000, 0, true),
            walker(13, -1_350_000, 0, false),
        ],
        Outline::Rigid {
            half_length: 1_650_000,
            half_width: 280_000,
        },
        Leave::StopAndSetDown,
    )
}

/// A 2 m by 0.9 m thing pushed by one body (E5): the push activity (20), the thing riding ahead of the grip (21),
/// the pusher walking behind it and leading (22). Rigid: the thing and the pusher, 2.7 m by 0.9 m.
pub fn pushed_thing() -> Scene {
    scene(
        20,
        false,
        vec![rider(21, false), walker(22, -1_350_000, 0, true)],
        Outline::Rigid {
            half_length: 1_350_000,
            half_width: 450_000,
        },
        Leave::StopAndSetDown,
    )
}

/// Two bodies side by side (E9): the walk-together activity (30), each walker 0.4 m to a side of its centre, the
/// first leading. Loose: at a narrow place they fall into single file in member order.
pub fn pair_side_by_side() -> Scene {
    scene(
        30,
        false,
        vec![walker(31, 0, -400_000, true), walker(32, 0, 400_000, false)],
        Outline::Loose,
        Leave::CloseUp,
    )
}

/// A rowed vessel with a rower and a passenger (E12): the vessel is the group (40), with its own mover; the rower
/// rides in its drive slot and drives (41), the passenger rides (42). Rigid: its hull, 3 m by 1.2 m.
pub fn rowed_with_passenger() -> Scene {
    scene(
        40,
        false,
        vec![rider(41, true), rider(42, false)],
        Outline::Rigid {
            half_length: 1_500_000,
            half_width: 600_000,
        },
        Leave::AtStop,
    )
}

/// A ride on a track (N12): the ride is the group (50), its track owns its motion and no member steers; one body
/// rides it (51). Rigid: its car, 2 m by 1.5 m.
pub fn ride_on_track() -> Scene {
    scene(
        50,
        true,
        vec![rider(51, false)],
        Outline::Rigid {
            half_length: 1_000_000,
            half_width: 750_000,
        },
        Leave::AtStop,
    )
}

/// The five, by the names the page uses.
pub fn all() -> Vec<(&'static str, Scene)> {
    vec![
        ("carried-load", carried_load()),
        ("pushed-thing", pushed_thing()),
        ("pair-side-by-side", pair_side_by_side()),
        ("rowed-with-passenger", rowed_with_passenger()),
        ("ride-on-track", ride_on_track()),
    ]
}
