//! Following another Soul (0.135 G2): an order the follower wrote by offering, and the leader agreed to by accepting
//! (TRUNK T10: "follow" is one of the closed list of orders the engine carries out). The activity's kind names the
//! role that follows ([`replica::activity::ActivityKind::follows`]); the other member leads.
//!
//! - **The place.** The follower's place is [`BEHIND`] from the leader, on the line from the leader to where the
//!   follower stands: as the leader walks away, behind it ([`place`]). The place is a target, never a constraint
//!   (`v2/docs/moving-group.md` rule 3).
//! - **Ordinary walks.** Each time the place has moved more than [`AGAIN`] from where the follower's last walk was
//!   going, the world sends the follower a new walk there, through the path every walk intent takes (worldd's
//!   `Bodies::follow`): so it never crosses fixed geometry and is never placed without walking ([`again`]).
//! - **Ending.** Either member leaves, and the follow is over for both. The follower's own walk (or sit) leaves it
//!   as a leave does; the leader's own walks are what it follows ([`crate::activity::Activities::walk_leaves`]).
//!
//! Not here: the leader's gait (0.135 G1), more than one follower, a door the leader closes behind it.

use replica::pose::Vec3;

/// How far behind its leader a follower walks, µm.
pub const BEHIND: i64 = 1_000_000;
/// How far the place may move from where the follower's walk is going before the world sends a new walk, µm.
pub const AGAIN: i64 = 500_000;

fn len(x: i64, z: i64) -> i64 {
    (i128::from(x).pow(2) + i128::from(z).pow(2)).isqrt() as i64
}

/// The follower's place: [`BEHIND`] from `leader`, toward where the follower stands at `follower` (on the plan;
/// the leader's own height). A follower standing on the leader keeps its own spot.
pub fn place(leader: Vec3, follower: Vec3) -> Vec3 {
    let (dx, dz) = (follower.x - leader.x, follower.z - leader.z);
    let d = len(dx, dz);
    if d == 0 {
        return follower;
    }
    let k = |v: i64| (i128::from(v) * i128::from(BEHIND) / i128::from(d)) as i64;
    Vec3::new(leader.x + k(dx), leader.y, leader.z + k(dz))
}

/// Whether the world sends the follower a new walk to `place`: its last walk was going to `aimed` (none: it has
/// not walked yet), and it stands at `at`. A new walk when the place has moved more than [`AGAIN`] from where it
/// was going; with no walk yet, when it stands more than [`AGAIN`] from the place.
pub fn again(aimed: Option<Vec3>, at: Vec3, place: Vec3) -> bool {
    let from = aimed.unwrap_or(at);
    len(place.x - from.x, place.z - from.z) > AGAIN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g2_the_place_is_a_metre_behind_and_a_walk_goes_again_past_half_a_metre() {
        let leader = Vec3::new(10_000_000, 0, 0);
        assert_eq!(
            place(leader, Vec3::new(0, 0, 0)),
            Vec3::new(9_000_000, 0, 0)
        );
        assert_eq!(
            place(leader, Vec3::new(10_000_000, 0, 4_000_000)),
            Vec3::new(10_000_000, 0, 1_000_000)
        );
        let p = Vec3::new(9_000_000, 0, 0);
        assert!(!again(Some(Vec3::new(9_400_000, 0, 0)), Vec3::ZERO, p));
        assert!(again(Some(Vec3::new(8_400_000, 0, 0)), Vec3::ZERO, p));
        assert!(!again(None, Vec3::new(9_200_000, 0, 0), p));
        assert!(again(None, Vec3::ZERO, p));
    }
}
