//! Moving frames on a track (Engine v2 N12, #2737): a node that moves on a track, which bodies board, are carried
//! by and leave. It is E23's moving group (`v2/docs/moving-group.md`): the node's frame moves, each body on it is
//! the group's rider (its child at a fixed pose, owned by its slot), the track is the one steerer and the rule for
//! leaving is "at a stop". This module adds only what a track needs: the formula, its stops and the check at load.
//! The boarding link is `crate::links::boarding`. The formula itself is in `replica::schedule::course` (moved there by
//! E7, #2756), so every copy reads the same positions and timetable from the node's field.
//!
//! - **The formula.** A [`Course`] is a list of stations (a point in the parent's frame, µm, and a dwell, µs: a
//!   stop dwells, a waypoint does not), a shape (a loop, or a line there and back), a speed and a start time. Loaded
//!   ([`Course::load`]) it is a fixed [`Table`] of legs, each a dwell or a straight move, with whole-microsecond
//!   durations. The node's position at world time `t` is read from the table by integer interpolation, one rounding
//!   per number (T4 rule 3): nothing is accumulated, and nothing is written per tick for the node or its riders.
//!   Two runs, a replay and a restart read the same table at the same times and agree to the micrometre.
//! - **Orientation is constant** (T4 rule 8): a frame that turns needs an integer sine table and is N14's. No
//!   platform `sin` or `cos` is used, so the server and the browser agree.
//! - **Stops.** A loaded track states the time within which a stop is always reached (`within`); a table with a
//!   gap between stops longer than that, or with no stop, is refused at load as `track-no-stop-within`. That bound
//!   is what E23's "at a stop" leave rule promises a leaver, and what E7 publishes as the timetable.
//! - **The group.** [`group`] reads the node and its riders as E23's [`Group`]: a track, riders only, a rigid outline
//!   and [`Leave::AtStop`]. It defines no membership, steering or leaving of its own; `Scene::check` checks it.
//!
//! Not here: steering a frame freely (E12), the frame's slots (B3), the timetable an agent reads
//! (`replica::schedule::stops`, E7), a frame that turns (N14), drawing.

pub mod punts;
pub mod rides;

use replica::group::{Belonging, Group, Leave, Member, Outline};
use replica::ids::Id;
pub use replica::schedule::course::{Course, Leg, Shape, Station, Stop, Stopped, Table};

/// The moving node `node` and the bodies on it as E23's group: its track steers, each body is a rider (its child,
/// owned by its slot), the outline is rigid, and a body leaves at a stop, which the loaded table promises within its
/// stated time.
pub fn group(node: Id, riders: &[Id], half_length: i64, half_width: i64) -> Group {
    Group {
        node,
        track: true,
        members: riders
            .iter()
            .map(|&r| Member {
                node: r,
                belongs: Belonging::Rider,
                steers: false,
            })
            .collect(),
        outline: Outline::Rigid {
            half_length,
            half_width,
        },
        leave: Some(Leave::AtStop),
    }
}
