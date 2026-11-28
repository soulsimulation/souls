//! Raising a lying part about its foot until it stands, and laying it down again (#5067): the rule of the scripted
//! build (`mars/viewer/engine/construction/raise.ts`, `lying.ts`), in whole numbers.
//!
//! - **The part.** Its entry names a `foot` point at its origin and how many raise it (`state.raise_crew`, [`Spec`]).
//!   Lying, its length (its own y) is flat on the ground; its foot is the pivot and its base line (its own x, through
//!   the feet of its posts) the axis it turns about. The foot never moves on the plan.
//! - **The crew.** A footer stands beside the base, [`SIDE`] beyond one post, and holds that post [`FOOT_HOLD`] up
//!   from the foot. The lifter starts beside the top end, [`SIDE`] beyond the other post, and walks toward the base on a
//!   straight line beside the part, its hands on its post no higher than [`LIFT_HAND`] above the ground: at the post's
//!   top while that is lower, then sliding down the post as it comes upright.
//! - **The lifter paces the turn.** How far the lifter is from the base line along the part (`r`) says how far the
//!   part is raised ([`Spec::tilt`]): its hold is always beside it, [`SIDE`] from its feet. At the top end the part
//!   lies; at the base it stands. Lowering is the same walk the other way.
//!
//! Lengths are µm; directions are vectors of length [`M`].

use replica::pose::{Quat, Vec3};
use replica::rules::json::Value as Json;

use super::{R, blend, pose_refusal, refuse};

/// A unit direction's length, and µm in a metre.
pub const M: i64 = 1_000_000;
/// How high above the ground the lifter's hands are at most, µm (the scripted build's `LIFT_HAND`: under a standing
/// body's overhead reach).
pub const LIFT_HAND: i64 = 1_900_000;
/// How far beyond a post's outer face the footer and the lifter stand, µm (the scripted build's hold stations): 80 mm
/// clear of the ground the standing part takes about it, so a carrier a few centimetres off its place still stands
/// on ground when it stands.
pub const SIDE: i64 = 420_000;
/// How far up its post from the foot the footer holds, µm: within its reach while the part lies and while it stands.
pub const FOOT_HOLD: i64 = 400_000;
/// The lifter's pace beside the part, µm a second (the scripted build's bound is 0.6 m/s): slow enough that the part,
/// which turns no faster than [`TURN`] a tick, is never more than 0.35 m behind its lifter.
pub const PACE: i64 = 400_000;
/// How far the part's long axis turns in one tick at most, as the distance its direction (of length [`M`]) moves:
/// about 0.9 degrees, a quarter turn in five seconds at 20 ticks a second (the scripted build's `RAISE_RATE`). Near
/// lying, a step of the lifter's is a large turn of the part; this keeps its top to 40 mm a tick.
pub const TURN: i64 = 16_000;
/// How far the part's turn follows the lifter in one tick at most, as a distance of the lifter's along the part, µm:
/// twice its pace at 20 ticks a second, so the part catches up with a lifter who starts a step from the end and is
/// never turned in one step.
pub const FOLLOW: i64 = 50_000;
/// Half of a quarter turn's sine and cosine, in thousand-millionths: the weights that turn a tilt into a blend.
const S45: i128 = 707_106_781;
const C45: i128 = 292_893_219;

/// What a raise needs of a part's kind: its height from the foot (its long side), half its width across its posts,
/// half its thickness (how high its origin is while it lies on its face), and how many raise it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spec {
    pub height: i64,
    pub half_width: i64,
    pub half_thick: i64,
    pub crew: u64,
}

impl Spec {
    /// The raise an entry (`souls-entry/1`) states: a point named `foot` at its origin, `geometry.bounds_mm` with its
    /// height its longest side, and `state.raise_crew`'s default (two when it says none). None for any other entry.
    pub fn of(entry: &Json) -> Option<Spec> {
        let foot = entry.get("points")?.get("foot")?.get("at_mm")?.arr()?;
        if !foot.iter().all(|v| matches!(v, Json::Int(0))) || foot.len() != 3 {
            return None;
        }
        let b: Vec<i64> = entry
            .get("geometry")?
            .get("bounds_mm")?
            .arr()?
            .iter()
            .filter_map(|v| match v {
                Json::Int(n) => i64::try_from(*n).ok(),
                _ => None,
            })
            .collect();
        let [w, h, d] = b[..] else { return None };
        if h < w || h < d || h <= 0 {
            return None;
        }
        let crew = match entry
            .get("state")
            .and_then(|s| s.get("raise_crew"))
            .and_then(|c| c.get("default"))
        {
            Some(Json::Int(n)) => u64::try_from(*n).ok()?,
            _ => 2,
        };
        Some(Spec {
            height: h * 1000,
            half_width: w * 500,
            half_thick: d * 500,
            crew,
        })
    }

    /// The part's long axis in the plane it turns in, with the lifter `r` µm from the base line along it (0 at the
    /// base, the part standing; its height, the part lying): how far it leans along the ground and how far it rises,
    /// a direction of length [`M`]. The lifter holds the post's top while that is no higher than [`LIFT_HAND`], else
    /// the point of the post at that height.
    pub fn tilt(&self, r: i64) -> [i64; 2] {
        let h = i128::from(self.height);
        let r = i128::from(r.clamp(0, self.height));
        let m = i128::from(M);
        let hand = i128::from(LIFT_HAND);
        // Where the post's top is at the hands' height.
        let top = if h > hand {
            (h * h - hand * hand).isqrt()
        } else {
            0
        };
        let (lean, rise, len) = if r >= top {
            (r, (h * h - r * r).isqrt(), h)
        } else {
            (r, hand, (r * r + hand * hand).isqrt())
        };
        let len = len.max(1);
        [(lean * m / len) as i64, (rise * m / len) as i64]
    }

    /// How far up its post from the foot the lifter holds at `tilt`, µm.
    pub fn hold_up(&self, tilt: [i64; 2]) -> i64 {
        if tilt[1] <= 0 {
            return self.height;
        }
        let s = i128::from(LIFT_HAND) * i128::from(M) / i128::from(tilt[1]);
        i64::try_from(s).unwrap_or(self.height).min(self.height)
    }

    /// Where the part is raised to next, on its way from `r` toward `want` (each the lifter's distance from the base
    /// line, µm): no further than [`FOLLOW`] and turned no more than [`TURN`], found by halving. `want` when that is
    /// within both.
    pub fn toward(&self, r: i64, want: i64) -> i64 {
        let far = |a: i64, b: i64| {
            let (p, q) = (self.tilt(a), self.tilt(b));
            (i128::from(p[0] - q[0]).pow(2) + i128::from(p[1] - q[1]).pow(2)).isqrt()
        };
        let to = r + (want - r).clamp(-FOLLOW, FOLLOW);
        if far(r, to) <= i128::from(TURN) {
            return to;
        }
        // `ok` is within the turn, `out` is not.
        let (mut ok, mut out) = (r, to);
        while (out - ok).abs() > 1 {
            let mid = ok + (out - ok) / 2;
            if far(r, mid) <= i128::from(TURN) {
                ok = mid;
            } else {
                out = mid;
            }
        }
        // Never stuck: at least a micrometre the way it is going.
        if ok == r { out } else { ok }
    }

    /// How far beside the part's middle line the footer and the lifter stand, µm.
    pub fn beside(&self) -> i64 {
        self.half_width + SIDE
    }
}

/// A part's raise on the ground: where its foot is, how it lies and how it stands, and the lines its crew stands on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Raise {
    pub spec: Spec,
    /// The foot on the ground's plan (x and z), and the ground's height there (y).
    pub foot: Vec3,
    /// The part's turn lying and standing, on the ground.
    pub lie: Quat,
    pub stand: Quat,
    /// From the foot toward the top of the lying part, on the plan (x, z), length [`M`].
    pub along: [i64; 2],
    /// Along the base line, toward the lifter's side, on the plan (x, z), length [`M`].
    pub side: [i64; 2],
}

fn plan(q: Quat, v: Vec3) -> R<[i64; 2]> {
    let w = q.rotate(v).map_err(pose_refusal)?;
    let len = (i128::from(w.x).pow(2) + i128::from(w.z).pow(2))
        .isqrt()
        .max(1);
    let unit = |c: i64| (i128::from(c) * i128::from(M) / len) as i64;
    Ok([unit(w.x), unit(w.z)])
}

impl Raise {
    /// The raise of a part lying at `at` turned `lie` on its ground (its origin, the foot, half its thickness above
    /// the ground), the lifter standing at `lifter`: it stands turned about its base line until its length is upright,
    /// its width where it was. Refused `raise.not-lying` when its length is not flat on the ground.
    pub fn up(spec: Spec, at: Vec3, lie: Quat, lifter: Vec3) -> R<Raise> {
        let y = lie.rotate(Vec3::new(0, M, 0)).map_err(pose_refusal)?;
        if y.y.abs() > M / 20 {
            return refuse(
                "raise.not-lying",
                format!("its length rises {} mm in a metre", y.y / 1000),
            );
        }
        let along = plan(lie, Vec3::new(0, M, 0))?;
        let x = plan(lie, Vec3::new(M, 0, 0))?;
        let stand = super::yaw_toward(x)?;
        let foot = Vec3::new(at.x, at.y - spec.half_thick, at.z);
        Ok(Raise::sided(spec, foot, lie, stand, along, x, lifter))
    }

    /// The lowering of a part standing at `at` turned `stand` on its ground, the lifter standing at `lifter`: it is
    /// laid toward `toward` (a direction on the plan; its own front, +z, when none or when that is along its base
    /// line), turned about its base line until its length is flat. Refused `raise.not-standing` when its length is
    /// not upright.
    pub fn down(
        spec: Spec,
        at: Vec3,
        stand: Quat,
        toward: Option<[i64; 2]>,
        lifter: Vec3,
    ) -> R<Raise> {
        let y = stand.rotate(Vec3::new(0, M, 0)).map_err(pose_refusal)?;
        if y.y < M - M / 100 {
            return refuse(
                "raise.not-standing",
                format!("its length rises {} mm in a metre", y.y / 1000),
            );
        }
        let front = plan(stand, Vec3::new(0, 0, M))?;
        let x = plan(stand, Vec3::new(M, 0, 0))?;
        let back = toward.is_some_and(|t| {
            i128::from(t[0]) * i128::from(front[0]) + i128::from(t[1]) * i128::from(front[1]) < 0
        });
        // A quarter turn about its own x: its length to its own +z, or to its −z.
        let half = 759_250_125;
        let quarter =
            Quat::new(half, if back { -half } else { half }, 0, 0).map_err(pose_refusal)?;
        let lie = stand.then(quarter).map_err(pose_refusal)?;
        let along = if back { [-front[0], -front[1]] } else { front };
        Ok(Raise::sided(spec, at, lie, stand, along, x, lifter))
    }

    /// The raise a part is on, found from its crew's node alone (a world started again part way): the node at `p`
    /// turned `q` on its ground, the part riding it unturned at its foot. Where it would stand and how it would lie
    /// are read from the turn; how far it is raised is the `r` whose tilt is nearest (a node upright, a raise on its
    /// last tick, is lowered toward its own front). The caller tells it from a part carried standing, whose node is
    /// at carrying height, not at the foot (review of #5264: a node within 8 degrees of upright was left to a carry's
    /// set-down, which lifted the part 1.2 m and dropped it).
    pub fn resume(spec: Spec, p: Vec3, q: Quat) -> R<Option<(Raise, i64)>> {
        let y = q.rotate(Vec3::new(0, M, 0)).map_err(pose_refusal)?;
        let x = plan(q, Vec3::new(M, 0, 0))?;
        let stand = super::yaw_toward(x)?;
        let front = plan(stand, Vec3::new(0, 0, M))?;
        let back =
            i128::from(y.x) * i128::from(front[0]) + i128::from(y.z) * i128::from(front[1]) < 0;
        let half = 759_250_125;
        let quarter =
            Quat::new(half, if back { -half } else { half }, 0, 0).map_err(pose_refusal)?;
        let lie = stand.then(quarter).map_err(pose_refusal)?;
        let along = if back { [-front[0], -front[1]] } else { front };
        // The tilt only rises as `r` falls: the least `r` that rises no more than the part does.
        let (mut lo, mut hi) = (0, spec.height);
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if spec.tilt(mid)[1] > y.y.max(0) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let r = if y.y >= M { 0 } else { hi };
        let up = i128::from(spec.half_thick) * i128::from(spec.tilt(r)[0]) / i128::from(M);
        let foot = Vec3::new(p.x, p.y - up as i64, p.z);
        let lifter = Vec3::new(p.x + x[0], p.y, p.z + x[1]);
        Ok(Some((
            Raise::sided(spec, foot, lie, stand, along, x, lifter),
            r,
        )))
    }

    fn sided(
        spec: Spec,
        foot: Vec3,
        lie: Quat,
        stand: Quat,
        along: [i64; 2],
        x: [i64; 2],
        lifter: Vec3,
    ) -> Raise {
        let d = i128::from(lifter.x - foot.x) * i128::from(x[0])
            + i128::from(lifter.z - foot.z) * i128::from(x[1]);
        let side = if d < 0 { [-x[0], -x[1]] } else { x };
        Raise {
            spec,
            foot,
            lie,
            stand,
            along,
            side,
        }
    }

    /// Whether the lifter stands on the part's own +x side.
    fn plus(&self) -> R<bool> {
        let x = plan(self.stand, Vec3::new(M, 0, 0))?;
        Ok(i128::from(x[0]) * i128::from(self.side[0])
            + i128::from(x[1]) * i128::from(self.side[1])
            > 0)
    }

    fn at(&self, across: i64, along: i64) -> Vec3 {
        let v = |k: usize| {
            (i128::from(self.side[k]) * i128::from(across)
                + i128::from(self.along[k]) * i128::from(along))
                / i128::from(M)
        };
        Vec3::new(
            self.foot.x + v(0) as i64,
            self.foot.y,
            self.foot.z + v(1) as i64,
        )
    }

    /// Where the lifter stands with the part raised to `r`: beside its post, `r` from the base line.
    pub fn lifter_at(&self, r: i64) -> Vec3 {
        self.at(self.spec.beside(), r.clamp(0, self.spec.height))
    }

    /// Where the footer stands: beside the other post, on the base line.
    pub fn footer_at(&self) -> Vec3 {
        self.at(-self.spec.beside(), 0)
    }

    /// How far a body at `p` is from the base line along the part, µm, within the part's length.
    pub fn r_of(&self, p: Vec3) -> i64 {
        let d = (i128::from(p.x - self.foot.x) * i128::from(self.along[0])
            + i128::from(p.z - self.foot.z) * i128::from(self.along[1]))
            / i128::from(M);
        (d as i64).clamp(0, self.spec.height)
    }

    /// The crew's node raised to `r` (the part rides its slot with its foot at the node's origin, unturned): at the
    /// foot, which settles from half the part's thickness above the ground, lying, onto it, standing; turned between
    /// lying and standing as [`Spec::tilt`] says.
    pub fn node(&self, r: i64) -> R<(Vec3, Quat)> {
        let [lean, rise] = self.spec.tilt(r);
        // The blend's weight that turns it `rise` of the way up (a quarter turn's blend is not even in its angle), in
        // millionths: small enough for the blend's own squares.
        let n = i128::from(rise);
        let d = (S45 * i128::from(M + lean) + C45 * i128::from(rise)) / 1_000_000_000;
        let q = blend(self.lie, self.stand, n, d.max(1))?;
        let up = i128::from(self.spec.half_thick) * i128::from(lean) / i128::from(M);
        Ok((
            Vec3::new(self.foot.x, self.foot.y + up as i64, self.foot.z),
            q,
        ))
    }

    /// Where the lifter and the footer hold the part raised to `r`, each in the part's own frame (µm): the lifter's
    /// post at [`Spec::hold_up`], the footer's at [`FOOT_HOLD`].
    pub fn holds(&self, r: i64) -> R<[Vec3; 2]> {
        let w = if self.plus()? {
            self.spec.half_width
        } else {
            -self.spec.half_width
        };
        let up = self.spec.hold_up(self.spec.tilt(r));
        Ok([
            Vec3::new(w, up, 0),
            Vec3::new(-w, FOOT_HOLD.min(self.spec.height), 0),
        ])
    }

    /// How long the lifter's walk from one end to the other takes at [`PACE`], µs.
    pub fn time(&self) -> i64 {
        (i128::from(self.spec.height) * 1_000_000 / i128::from(PACE)) as i64
    }
}

#[cfg(test)]
mod tests {
    use replica::rules::json::parse;

    use super::*;

    fn upright() -> Spec {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../content/kinds/construction/rack_upright.json");
        Spec::of(&parse(&std::fs::read_to_string(root).unwrap()).unwrap()).expect("a raise")
    }

    /// The rack upright states its foot and its raise crew; a beam states neither.
    #[test]
    fn the_upright_states_its_raise_and_a_beam_none() {
        assert_eq!(
            upright(),
            Spec {
                height: 2_438_000,
                half_width: 609_500,
                half_thick: 38_000,
                crew: 2
            }
        );
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../content/kinds/construction/rack_beam.json");
        assert_eq!(
            Spec::of(&parse(&std::fs::read_to_string(root).unwrap()).unwrap()),
            None
        );
    }

    /// The lifter's place says the tilt: lying at the top end, standing at the base, its hands never above 1.9 m and
    /// never off the post, the tilt a unit direction that only rises as the lifter comes in.
    #[test]
    fn the_tilt_follows_the_lifter_and_its_hands_stay_under_reach() {
        let s = upright();
        assert_eq!(s.tilt(s.height), [M, 0]);
        assert_eq!(s.tilt(0), [0, M]);
        let mut last = -1;
        for r in (0..=s.height).rev().step_by(10_000) {
            let [lean, rise] = s.tilt(r);
            let len = (i128::from(lean).pow(2) + i128::from(rise).pow(2)).isqrt() as i64;
            assert!((len - M).abs() <= 2, "a unit direction at {r}: {len}");
            assert!(rise >= last, "it only rises: {rise} after {last} at {r}");
            last = rise;
            let up = s.hold_up([lean, rise]);
            assert!(up <= s.height && up > 0);
            let hand = i128::from(up) * i128::from(rise) / i128::from(M);
            assert!(
                hand <= i128::from(LIFT_HAND) + 2,
                "hands {hand} µm up at {r}"
            );
            // The hold is beside the lifter: as far along the ground as it stands.
            let out = i128::from(up) * i128::from(lean) / i128::from(M);
            assert!(
                (out - i128::from(r)).abs() <= 10,
                "the hold {out} along, the lifter {r}"
            );
        }
        assert_eq!(s.hold_up(s.tilt(0)), LIFT_HAND);
    }

    /// A frame lying east of its foot along +z is raised about its base line: the foot stays where it is on the plan,
    /// the node turns from lying to standing, its length rising all the way, and both carriers stay within 0.7 m of
    /// their holds. Laid down again from standing, it lies as it lay.
    #[test]
    fn the_foot_stays_put_and_both_carriers_stay_within_reach() {
        let s = upright();
        // Lying: its own y along world +z, its own x along world +x, its face up.
        let half = 759_250_125;
        let lie = Quat::new(half, half, 0, 0).unwrap();
        let at = Vec3::new(5 * M, s.half_thick, -3 * M);
        let lifter = Vec3::new(5 * M + s.beside(), 0, -3 * M + s.height);
        let up = Raise::up(s, at, lie, lifter).unwrap();
        assert_eq!(up.foot, Vec3::new(5 * M, 0, -3 * M));
        assert_eq!(up.along, [0, M]);
        assert_eq!(up.side, [M, 0]);
        assert_eq!(up.lifter_at(s.height), lifter);
        assert_eq!(up.footer_at(), Vec3::new(5 * M - s.beside(), 0, -3 * M));
        assert_eq!(up.r_of(lifter), s.height);
        assert_eq!(up.node(s.height).unwrap(), (at, lie));
        let (p, q) = up.node(0).unwrap();
        assert_eq!((p, q), (up.foot, up.stand));
        assert_eq!(q.rotate(Vec3::new(0, M, 0)).unwrap().y, M, "standing");
        let mut rise = -1;
        for r in (0..=s.height).rev().step_by(25_000) {
            let (p, q) = up.node(r).unwrap();
            assert_eq!((p.x, p.z), (at.x, at.z), "the foot stays put");
            assert!(p.y >= 0 && p.y <= s.half_thick);
            let y = q.rotate(Vec3::new(0, M, 0)).unwrap();
            assert!(y.x.abs() <= 2_000, "it turns about its base line: {y:?}");
            assert!(
                y.y >= rise - 2_000,
                "its length rises: {} after {rise}",
                y.y
            );
            rise = y.y;
            // As the tilt says, within a hundredth.
            let [lean, up_] = s.tilt(r);
            assert!(
                (y.z - lean).abs() <= 10_000 && (y.y - up_).abs() <= 10_000,
                "{y:?} at {r}"
            );
            let holds = up.holds(r).unwrap();
            for (feet, hold) in [(up.lifter_at(r), holds[0]), (up.footer_at(), holds[1])] {
                let g = q.rotate(hold).unwrap();
                let off = (i128::from(p.x + g.x - feet.x).pow(2)
                    + i128::from(p.z + g.z - feet.z).pow(2))
                .isqrt();
                assert!(off <= 700_000, "{off} µm from its hold at {r}");
                assert!(p.y + g.y <= LIFT_HAND + 45_000);
            }
        }
        let down = Raise::down(s, up.foot, up.stand, Some([0, M]), up.lifter_at(0)).unwrap();
        assert_eq!((down.along, down.side), (up.along, up.side));
        let (p, q) = down.node(s.height).unwrap();
        assert_eq!(p, at);
        let y = q.rotate(Vec3::new(0, M, 0)).unwrap();
        assert!(
            y.y.abs() <= 10 && (y.z - M).abs() <= 10,
            "lying toward +z again: {y:?}"
        );
        // Toward its back, the other way.
        let back = Raise::down(s, up.foot, up.stand, Some([0, -M]), up.lifter_at(0)).unwrap();
        assert_eq!(back.along, [0, -M]);
    }

    /// The part turns no more than [`TURN`] a tick and follows no further than [`FOLLOW`], from lying to standing and
    /// back, and always gets there: about five seconds each way at 20 ticks a second.
    #[test]
    fn the_part_turns_a_step_a_tick_and_arrives() {
        let s = upright();
        for (from, to) in [(s.height, 0), (0, s.height)] {
            let (mut r, mut ticks) = (from, 0);
            while r != to {
                let next = s.toward(r, to);
                assert!(next != r && (next - r).abs() <= FOLLOW, "{r} to {next}");
                assert!(
                    (next - to).abs() < (r - to).abs(),
                    "toward its end: {r} to {next}"
                );
                let (a, b) = (s.tilt(r), s.tilt(next));
                let far = (i128::from(a[0] - b[0]).pow(2) + i128::from(a[1] - b[1]).pow(2)).isqrt();
                assert!(far <= i128::from(TURN) + 2, "{far} at {r}");
                r = next;
                ticks += 1;
                assert!(ticks < 400, "never ends");
            }
            assert!(
                (90..=200).contains(&ticks),
                "{ticks} ticks from {from} to {to}"
            );
        }
        // Within both: all the way at once.
        assert_eq!(s.toward(1_000_000, 1_010_000), 1_010_000);
    }

    /// A world started again finds a raise from its crew's node: the same foot, the same lying and standing turns, and
    /// how far it was raised, within a few millimetres of the lifter's walk, from lying to within a few degrees of
    /// standing (review of #5264: the last 0.27 m were left to a carry's set-down); a node upright is a raise at its end.
    #[test]
    fn a_raise_part_way_is_found_again_from_its_node() {
        let s = upright();
        let half = 759_250_125;
        let lie = Quat::new(half, half, 0, 0).unwrap();
        let at = Vec3::new(5 * M, s.half_thick, -3 * M);
        let lifter = Vec3::new(5 * M + s.beside(), 0, -3 * M + s.height);
        let up = Raise::up(s, at, lie, lifter).unwrap();
        for r in [
            s.height, 2_000_000, 1_500_000, 900_000, 600_000, 250_000, 100_000,
        ] {
            let (p, q) = up.node(r).unwrap();
            let (found, at_r) = Raise::resume(s, p, q).unwrap().expect("a raise");
            assert!((at_r - r).abs() <= 60_000, "raised to {at_r}, was {r}");
            assert_eq!((found.along, found.stand), (up.along, up.stand), "at {r}");
            assert!(
                (found.foot.x, found.foot.z) == (up.foot.x, up.foot.z)
                    && found.foot.y.abs() <= 1_000,
                "its foot: {:?}",
                found.foot
            );
            let (a, b) = (found.node(at_r).unwrap(), (p, q));
            let tip = |q: Quat| q.rotate(Vec3::new(0, s.height, 0)).unwrap();
            let (ta, tb) = (tip(a.1), tip(b.1));
            let off = (i128::from(ta.x - tb.x).pow(2)
                + i128::from(ta.y - tb.y).pow(2)
                + i128::from(ta.z - tb.z).pow(2))
            .isqrt();
            assert!(
                off <= 40_000,
                "no jump as it goes on: its top {off} µm off at {r}"
            );
        }
        let (found, at_r) = Raise::resume(s, up.foot, up.stand)
            .unwrap()
            .expect("a raise at its end");
        assert_eq!(
            (at_r, found.node(0).unwrap()),
            (0, (up.foot, up.stand)),
            "standing, where it stands"
        );
    }

    /// A part whose length is not flat is not raised, and one not upright is not lowered, each by name.
    #[test]
    fn a_part_not_lying_or_not_standing_is_refused_by_name() {
        let s = upright();
        let r = Raise::up(s, Vec3::ZERO, Quat::IDENTITY, Vec3::ZERO).unwrap_err();
        assert_eq!(r.name, "raise.not-lying");
        let half = 759_250_125;
        let lie = Quat::new(half, half, 0, 0).unwrap();
        let r = Raise::down(s, Vec3::ZERO, lie, None, Vec3::ZERO).unwrap_err();
        assert_eq!(r.name, "raise.not-standing");
    }
}
