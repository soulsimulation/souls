//! Members take their places when a group activity starts (0.135 G3). A role may say where its members stand, in
//! the activity's own frame ([`replica::activity::Role::stands`]: a point and a facing each, the k-th member the
//! k-th). When such an activity starts, its frame is set once from where its members stand: its origin their middle,
//! turned so the first member's place lies the way that member stands from the middle (so nobody crosses over).
//! Each member then walks to its place by an ordinary walk and turns to its facing (worldd's `Bodies::take_places`);
//! the activity's moves begin once every member has taken its place ([`super::Activities::placed`]).

use replica::effects::Refusal;
use replica::pose::{Quat, Vec3};

type R<T> = Result<T, Refusal>;

fn len(x: i64, z: i64) -> i64 {
    (i128::from(x).pow(2) + i128::from(z).pow(2)).isqrt() as i64
}

/// The yaw (millidegrees) that turns +x toward `(x, z)`, to the nearest millidegree: an integer search over T4's
/// rotation, as `carry::yaw_toward`, so no float.
pub fn yaw_of(x: i64, z: i64) -> R<i64> {
    let q = crate::activity::carry::yaw_toward([x, z])?;
    // The millidegree whose rotation is `q`: found by its effect on +x, searched in whole degrees then refined.
    let target = q.rotate(Vec3::new(1 << 20, 0, 0)).map_err(pose)?;
    let off = |m: i64| -> R<i128> {
        let v = Quat::from_yaw_mdeg(m)
            .map_err(pose)?
            .rotate(Vec3::new(1 << 20, 0, 0))
            .map_err(pose)?;
        Ok(i128::from(v.x - target.x).pow(2) + i128::from(v.z - target.z).pow(2))
    };
    let mut best = (0, i128::MAX);
    for d in 0..360 {
        let e = off(d * 1000)?;
        if e < best.1 {
            best = (d * 1000, e);
        }
    }
    let base = best.0;
    for m in base - 1000..=base + 1000 {
        let e = off(m)?;
        if e < best.1 {
            best = (m, e);
        }
    }
    Ok(best.0)
}

fn pose(e: replica::pose::PoseRefusal) -> Refusal {
    Refusal {
        name: "place-pose",
        detail: format!("{e:?}"),
    }
}

/// An activity's frame: its origin (µm, the ground's frame) and its turn (millidegrees of yaw).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame {
    pub origin: Vec3,
    pub yaw: i64,
}

impl Frame {
    /// The frame for members standing at `at` whose first takes the place `first` (in the activity's frame): its
    /// origin their middle, turned so `first` lies the way that member stands from the middle.
    pub fn of(at: &[Vec3], first: Vec3) -> R<Frame> {
        let n = at.len().max(1) as i64;
        let sum = at.iter().fold((0i64, 0i64), |s, p| (s.0 + p.x, s.1 + p.z));
        let origin = Vec3::new(sum.0 / n, at.first().map_or(0, |p| p.y), sum.1 / n);
        let Some(a) = at.first() else {
            return Ok(Frame { origin, yaw: 0 });
        };
        let (ux, uz) = (a.x - origin.x, a.z - origin.z);
        if len(ux, uz) == 0 || len(first.x, first.z) == 0 {
            return Ok(Frame { origin, yaw: 0 });
        }
        Ok(Frame {
            origin,
            yaw: yaw_of(ux, uz)? - yaw_of(first.x, first.z)?,
        })
    }

    /// Where a place `p` with facing `yaw` (in the activity's frame) is: a point on the ground and a facing.
    pub fn place(&self, p: Vec3, yaw: i64) -> R<(Vec3, Quat)> {
        let q = Quat::from_yaw_mdeg(self.yaw).map_err(pose)?;
        let d = q.rotate(Vec3::new(p.x, 0, p.z)).map_err(pose)?;
        let at = Vec3::new(self.origin.x + d.x, self.origin.y, self.origin.z + d.z);
        let facing = Quat::from_yaw_mdeg((self.yaw + yaw).rem_euclid(360_000)).map_err(pose)?;
        Ok((at, facing))
    }
}

/// Where each member of a pair will stand once it has taken its place, before the pair starts (0.134 T1's accept
/// reads a touch's reach from there). `members` are in the order the activity will hold them, each with its role
/// and where it stands now (its node and position, `sim::index::place_of`; none when not known). The rule is
/// [`super::Activities::pending_places`]' for members none of whom holds a stand yet: the k-th member of a role takes
/// its role's k-th stand; the frame is set from where all of them stand, on one node, turned by the first member
/// given a stand. A member keeps where it stands (none) when its role names no stand or none is left, when the
/// members are not all on one node, when the frame cannot be set, or when it stands farther from the middle than its
/// role's `within`.
pub fn ahead(
    members: &[(&replica::activity::Role, Option<(replica::ids::Id, Vec3)>)],
) -> Vec<Option<Vec3>> {
    let mut stands = Vec::new();
    for (i, (role, _)) in members.iter().enumerate() {
        let k = members[..i]
            .iter()
            .filter(|(r, _)| r.name == role.name)
            .count();
        stands.push(role.stands.get(k).copied());
    }
    let none = vec![None; members.len()];
    let Some(pos) = members.iter().map(|m| m.1).collect::<Option<Vec<_>>>() else {
        return none;
    };
    let Some(node) = pos.first().map(|p| p.0) else {
        return none;
    };
    if pos.iter().any(|p| p.0 != node) {
        return none;
    }
    let first = stands
        .iter()
        .find_map(|s| s.map(|s| s.0))
        .unwrap_or(Vec3::ZERO);
    let pts: Vec<Vec3> = pos.iter().map(|p| p.1).collect();
    let Ok(f) = Frame::of(&pts, first) else {
        return none;
    };
    members
        .iter()
        .zip(stands)
        .zip(pts)
        .map(|(((role, _), s), p)| {
            let (dx, dz) = (i128::from(p.x - f.origin.x), i128::from(p.z - f.origin.z));
            let near = role
                .within
                .is_none_or(|w| dx * dx + dz * dz <= i128::from(w).pow(2));
            let (at, yaw) = s.filter(|_| near)?;
            f.place(at, yaw).ok().map(|(p, _)| p)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: i64 = 1_000_000;

    /// Two members facing each other 0.6 m apart take hold hands' places, side by side 0.5 m apart, the first where
    /// it stood: no one crosses over.
    #[test]
    fn g3_the_frame_keeps_each_member_on_its_side() {
        let at = [Vec3::new(0, 0, 0), Vec3::new(600_000, 0, 0)];
        let first = Vec3::new(-250_000, 0, 0);
        let f = Frame::of(&at, first).unwrap();
        assert_eq!(f.origin, Vec3::new(300_000, 0, 0));
        let (p1, q1) = f.place(first, 0).unwrap();
        let (p2, q2) = f.place(Vec3::new(250_000, 0, 0), 0).unwrap();
        assert!(
            (p1.x - 50_000).abs() < 2_000 && p1.z.abs() < 2_000,
            "{p1:?}"
        );
        assert!(
            (p2.x - 550_000).abs() < 2_000 && p2.z.abs() < 2_000,
            "{p2:?}"
        );
        assert_eq!(q1, q2, "both face the same way");
        // Turned a quarter: the first member stands north of the middle.
        let at = [Vec3::new(0, 0, M), Vec3::new(0, 0, -M)];
        let f = Frame::of(&at, first).unwrap();
        let (p1, _) = f.place(first, 0).unwrap();
        assert!(
            p1.x.abs() < 2_000 && (p1.z - 250_000).abs() < 2_000,
            "{p1:?}"
        );
    }
}
