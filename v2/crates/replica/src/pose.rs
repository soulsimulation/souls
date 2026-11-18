//! Pose, frames, support and who owns a thing's motion (contract T4; Engine v2 T4, #2644). The rules are numbered in
//! `v2/docs/pose.md`.
//!
//! A pose is a frame (a node, and the slot in it, if any), a position in micrometres, an orientation (a unit
//! quaternion as integers scaled by 2^30, with one sign rule) and what supports it. Every movable has one owner of its
//! motion: a slot, a mover, a track (a formula of world time, never accumulated) or, reserved, a physics island. A
//! hand-off names the old and new owner, the pose and the linear and angular velocity. Everything is integer: a
//! rotation is exact over the quaternion's own norm and rounded once, through 128 bits. Types, records and fixtures
//! only: no mover (N6), ground (N3), tracks at runtime (N14) or rides (N12).

use crate::encode::{Value, encode, to_hex};
use crate::ids::{Id, Scope};
use crate::time::Micros;
use std::collections::BTreeMap;
use std::fmt;

#[cfg(all(target_arch = "wasm32", feature = "vectors"))]
use wasm_bindgen::prelude::wasm_bindgen;

/// The scale of an orientation's four numbers: 2^30 is one (rule 4).
pub const UNIT: i64 = 1 << 30;

/// How far a quaternion's squared norm may be from 2^60 (rule 4): rounding four components moves it by at most
/// 2^31 + 1.
pub const NORM_TOLERANCE: i128 = 1 << 32;

/// Micrometres (or micrometres a second, or micro-radians a second) in a unit: a metre, a second, a radian.
pub const MICRO: i128 = 1_000_000;

/// Standard gravity, micrometres a second squared (9.80665 m/s²).
pub const STANDARD_GRAVITY: i64 = 9_806_650;

/// Why a pose, a record or a query was refused. Each has a name (`v2/docs/pose.md`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoseRefusal {
    /// An orientation whose squared norm is not within 2^32 of 2^60 (rule 4).
    OrientationNotUnit,
    /// An orientation that breaks the sign rule: the first non-zero of w, x, y, z must be positive (rule 4).
    OrientationSign,
    /// A whole multiple of a rotation's one byte form, not the form itself (rule 4).
    OrientationNotCanonical,
    /// A frame chain of more than 32 ancestors, as T2 limits it (`depth-over-limit`).
    DepthOverLimit,
    /// A support on a track whose motion is not owned by a rail track (rule 6).
    SupportNotTrack,
    /// A pose in a slot that is not supported by the slot, or supported by a slot it is not in (rule 6).
    SupportNotSlot,
    /// A surface support with a height below the surface (rule 6).
    HeightBelowSurface,
    /// A motion owner of a slot for a pose that is in no slot, or the reverse (rule 7).
    OwnerNotSlot,
    /// The physics island owner is reserved (rule 7).
    IslandReserved,
    /// A rail track's position needs its path, which is N14's (rule 8).
    RailNeedsPath,
    /// A track asked for a time before its start (rule 8).
    BeforeTrackStart,
    /// A movement mode other than walking on a surface (rule 11).
    ModeNotBuilt,
    /// A frame that names no node of the scene, or a slot its node does not have.
    FrameMissing,
    /// A node listed before its frame, or twice; a frame chain deeper than T2's 32; a hand-off into the movable's
    /// own subtree.
    FrameOrder,
    /// A result beyond 64 bits, or an intermediate beyond 128.
    OutOfRange,
    /// A value that is not the record it should be.
    NotARecord,
}

impl PoseRefusal {
    /// The refusal's name, as `v2/docs/pose.md` lists it.
    pub fn name(self) -> &'static str {
        match self {
            PoseRefusal::OrientationNotUnit => "orientation-not-unit",
            PoseRefusal::OrientationSign => "orientation-sign",
            PoseRefusal::OrientationNotCanonical => "orientation-not-canonical",
            PoseRefusal::DepthOverLimit => "depth-over-limit",
            PoseRefusal::SupportNotTrack => "support-not-track",
            PoseRefusal::SupportNotSlot => "support-not-slot",
            PoseRefusal::HeightBelowSurface => "height-below-surface",
            PoseRefusal::OwnerNotSlot => "owner-not-slot",
            PoseRefusal::IslandReserved => "island-reserved",
            PoseRefusal::RailNeedsPath => "rail-needs-path",
            PoseRefusal::BeforeTrackStart => "before-track-start",
            PoseRefusal::ModeNotBuilt => "mode-not-built",
            PoseRefusal::FrameMissing => "frame-missing",
            PoseRefusal::FrameOrder => "frame-order",
            PoseRefusal::OutOfRange => "out-of-range",
            PoseRefusal::NotARecord => "not-a-record",
        }
    }
}

impl fmt::Display for PoseRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl std::error::Error for PoseRefusal {}

type R<T> = Result<T, PoseRefusal>;

fn narrow(n: i128) -> R<i64> {
    i64::try_from(n).map_err(|_| PoseRefusal::OutOfRange)
}

fn mul(a: i128, b: i128) -> R<i128> {
    a.checked_mul(b).ok_or(PoseRefusal::OutOfRange)
}

fn add(a: i128, b: i128) -> R<i128> {
    a.checked_add(b).ok_or(PoseRefusal::OutOfRange)
}

/// `n / d` rounded to the nearest whole number, halves away from zero; `d` is positive (rule 3).
fn div_round(n: i128, d: i128) -> R<i128> {
    let half = d / 2;
    if n >= 0 {
        Ok(add(n, half)? / d)
    } else {
        Ok(-(add(n.checked_neg().ok_or(PoseRefusal::OutOfRange)?, half)? / d))
    }
}

/// The largest whole number whose square is at most `n` (Newton's method, integers only).
fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << (128 - n.leading_zeros()).div_ceil(2);
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Three integers: a position in micrometres, a velocity in micrometres a second, an angular velocity in
/// micro-radians a second or an acceleration in micrometres a second squared, by context (rule 2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Vec3 {
    pub x: i64,
    pub y: i64,
    pub z: i64,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 { x: 0, y: 0, z: 0 };

    pub fn new(x: i64, y: i64, z: i64) -> Vec3 {
        Vec3 { x, y, z }
    }

    fn wide(self) -> [i128; 3] {
        [self.x.into(), self.y.into(), self.z.into()]
    }

    fn from_wide(v: [i128; 3]) -> R<Vec3> {
        Ok(Vec3::new(narrow(v[0])?, narrow(v[1])?, narrow(v[2])?))
    }

    pub fn plus(self, o: Vec3) -> R<Vec3> {
        let (a, b) = (self.wide(), o.wide());
        Vec3::from_wide([a[0] + b[0], a[1] + b[1], a[2] + b[2]])
    }

    pub fn minus(self, o: Vec3) -> R<Vec3> {
        let (a, b) = (self.wide(), o.wide());
        Vec3::from_wide([a[0] - b[0], a[1] - b[1], a[2] - b[2]])
    }

    /// The largest difference of one component, as a whole number.
    pub fn apart(self, o: Vec3) -> i128 {
        let (a, b) = (self.wide(), o.wide());
        (0..3).map(|i| (a[i] - b[i]).abs()).max().unwrap_or(0)
    }

    /// `ω × r / 10^6`: the velocity, in micrometres a second, of a point `r` micrometres from an axis turning at
    /// `self` micro-radians a second.
    fn cross_micro(self, r: Vec3) -> R<Vec3> {
        let (w, r) = (self.wide(), r.wide());
        let c = |a: usize, b: usize| -> R<i128> {
            div_round(
                mul(w[a], r[b])?
                    .checked_sub(mul(w[b], r[a])?)
                    .ok_or(PoseRefusal::OutOfRange)?,
                MICRO,
            )
        };
        Vec3::from_wide([c(1, 2)?, c(2, 0)?, c(0, 1)?])
    }

    fn to_value(self) -> Value {
        Value::Array(vec![int(self.x), int(self.y), int(self.z)])
    }

    fn from_value(v: &Value) -> R<Vec3> {
        match v {
            Value::Array(a) if a.len() == 3 => Ok(Vec3::new(
                read_int(&a[0])?,
                read_int(&a[1])?,
                read_int(&a[2])?,
            )),
            _ => Err(PoseRefusal::NotARecord),
        }
    }
}

impl fmt::Display for Vec3 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}, {}, {}]", self.x, self.y, self.z)
    }
}

/// π scaled by 2^60, rounded down.
const PI_2_60: i128 = 3_622_009_729_038_561_421;

/// The sine and cosine of `x` radians, `x` and the results scaled by 2^60, by their power series in integers. `x` is
/// in [0, π]; terms are added until one is zero.
fn sin_cos_2_60(x: i128) -> R<(i128, i128)> {
    let one: i128 = 1 << 60;
    let x2 = mul(x, x)? / one;
    let (mut sin, mut cos) = (x, one);
    let (mut ts, mut tc) = (x, one);
    let mut k: i128 = 1;
    while ts != 0 || tc != 0 {
        tc = -(mul(tc, x2)? / one) / (k * (k + 1));
        ts = -(mul(ts, x2)? / one) / ((k + 1) * (k + 2));
        sin += ts;
        cos += tc;
        k += 2;
    }
    Ok((sin, cos))
}

/// Whether four numbers' squared norm is within 2^32 of 2^60 (rule 4).
fn in_band(q: [i128; 4]) -> bool {
    let n: i128 = q.iter().map(|c| c * c).sum();
    (n - (1i128 << 60)).abs() <= NORM_TOLERANCE
}

/// The sign rule: the first non-zero number positive.
fn signed(q: [i128; 4]) -> [i128; 4] {
    if q.iter().find(|n| **n != 0).is_some_and(|n| *n < 0) {
        q.map(|n| -n)
    } else {
        q
    }
}

/// The one byte form among the whole multiples of one direction (rule 4). `q` is g·p with p's numbers sharing no
/// factor; every k·p is the same rotation, and the form kept is the k whose squared norm is nearest 2^60, the smaller
/// on a tie. A rounded `q` almost always has g = 1 and is its own form; axis-aligned and symmetric turns are not.
fn canonical(q: [i128; 4]) -> [i128; 4] {
    let g = q.iter().fold(0i128, |a, c| {
        let (mut a, mut b) = (a, c.abs());
        while b != 0 {
            (a, b) = (b, a % b);
        }
        a
    });
    if g <= 1 {
        return q;
    }
    let p = q.map(|c| c / g);
    let pp: i128 = p.iter().map(|c| c * c).sum();
    let off = |k: i128| (k * k * pp - (1i128 << 60)).abs();
    let k0 = i128::try_from(isqrt(((1u128) << 60) / pp.unsigned_abs())).unwrap_or(1);
    let mut best = (k0 - 1).max(1);
    for k in k0..=k0 + 2 {
        if off(k) < off(best) {
            best = k;
        }
    }
    p.map(|c| c * best)
}

/// An orientation: a unit quaternion `w + xi + yj + zk` as four integers scaled by 2^30 (rule 4). A stored one is in
/// its one byte form: the sign rule (the first non-zero number is positive, so q and −q have one form) and the
/// canonical multiple (so 2^30 and 2^30 + 1 are not both the identity).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quat {
    w: i32,
    x: i32,
    y: i32,
    z: i32,
}

impl Quat {
    /// No turn.
    pub const IDENTITY: Quat = Quat {
        w: 1 << 30,
        x: 0,
        y: 0,
        z: 0,
    };

    /// The orientation, or refused as `orientation-not-unit`, `orientation-sign` or `orientation-not-canonical` (rule
    /// 4): a reader checks the one byte form of a rotation and refuses any other.
    pub fn new(w: i64, x: i64, y: i64, z: i64) -> R<Quat> {
        let part = |n: i64| i32::try_from(n).map_err(|_| PoseRefusal::OrientationNotUnit);
        let q = Quat {
            w: part(w)?,
            x: part(x)?,
            y: part(y)?,
            z: part(z)?,
        };
        if !in_band(q.wide()) {
            return Err(PoseRefusal::OrientationNotUnit);
        }
        if signed(q.wide()) != q.wide() || w == 0 && x == 0 && y == 0 && z == 0 {
            return Err(PoseRefusal::OrientationSign);
        }
        if canonical(q.wide()) != q.wide() {
            return Err(PoseRefusal::OrientationNotCanonical);
        }
        Ok(q)
    }

    /// A yaw (a turn about +y) of whole millidegrees, as SA-D3's `yaw_mdeg` writes it, in its one byte form. The half
    /// angle's sine and cosine come from an integer series in 2^60 fixed point: no float and no platform `sin`.
    pub fn from_yaw_mdeg(mdeg: i64) -> R<Quat> {
        // Half of the yaw, in radians scaled by 2^60: q and −q are one turn, so 360 degrees of yaw is enough.
        let x = i128::from(mdeg.rem_euclid(360_000)) * PI_2_60 / 360_000;
        let (sin, cos) = sin_cos_2_60(x)?;
        Quat::normalized([cos, 0, sin, 0])
    }

    pub fn parts(self) -> [i64; 4] {
        [self.w.into(), self.x.into(), self.y.into(), self.z.into()]
    }

    fn wide(self) -> [i128; 4] {
        [self.w.into(), self.x.into(), self.y.into(), self.z.into()]
    }

    fn norm(self) -> i128 {
        self.wide().iter().map(|n| n * n).sum()
    }

    /// The inverse turn: the conjugate, outside the sign rule, used only inside arithmetic.
    fn conjugate(self) -> Quat {
        Quat {
            w: self.w,
            x: -self.x,
            y: -self.y,
            z: -self.z,
        }
    }

    /// The four numbers `q`, of any scale, scaled to norm 2^30 through an integer square root and rounded, then put in
    /// their one byte form (rule 4). `q` is not zero.
    fn normalized(q: [i128; 4]) -> R<Quat> {
        let n: i128 = q.iter().try_fold(0i128, |s, c| add(s, mul(*c, *c)?))?;
        let n = u128::try_from(n).map_err(|_| PoseRefusal::OutOfRange)?;
        let root = i128::try_from(isqrt(n)).map_err(|_| PoseRefusal::OutOfRange)?;
        if root == 0 {
            return Err(PoseRefusal::OrientationNotUnit);
        }
        let mut out = [0i128; 4];
        for (o, c) in out.iter_mut().zip(q) {
            *o = div_round(mul(c, UNIT.into())?, root)?;
        }
        Quat::from_wide(canonical(signed(out)))
    }

    fn from_wide(q: [i128; 4]) -> R<Quat> {
        Quat::new(narrow(q[0])?, narrow(q[1])?, narrow(q[2])?, narrow(q[3])?)
    }

    /// `self ⊗ o` (turn by `o`, then by `self`). The product is divided by 2^30 and rounded, so a turn by the identity
    /// changes nothing; only a product whose norm has left the band goes through the square root (rule 4).
    pub fn then(self, o: Quat) -> R<Quat> {
        let [w1, x1, y1, z1] = self.wide();
        let [w2, x2, y2, z2] = o.wide();
        let product = [
            w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
            w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        ];
        let mut scaled = [0i128; 4];
        for (s, p) in scaled.iter_mut().zip(product) {
            *s = div_round(p, UNIT.into())?;
        }
        if in_band(scaled) {
            Quat::from_wide(canonical(signed(scaled)))
        } else {
            Quat::normalized(product)
        }
    }

    /// `v` turned by this orientation: exact over the quaternion's own norm, then rounded once (rule 3).
    pub fn rotate(self, v: Vec3) -> R<Vec3> {
        let [w, x, y, z] = self.wide();
        let m = [
            [
                w * w + x * x - y * y - z * z,
                2 * (x * y - w * z),
                2 * (x * z + w * y),
            ],
            [
                2 * (x * y + w * z),
                w * w - x * x + y * y - z * z,
                2 * (y * z - w * x),
            ],
            [
                2 * (x * z - w * y),
                2 * (y * z + w * x),
                w * w - x * x - y * y + z * z,
            ],
        ];
        let (v, n) = (v.wide(), self.norm());
        let mut out = [0i128; 3];
        for (o, row) in out.iter_mut().zip(m) {
            let s = add(
                add(mul(row[0], v[0])?, mul(row[1], v[1])?)?,
                mul(row[2], v[2])?,
            )?;
            *o = div_round(s, n)?;
        }
        Vec3::from_wide(out)
    }

    fn to_value(self) -> Value {
        Value::Array(self.parts().map(int).to_vec())
    }

    fn from_value(v: &Value) -> R<Quat> {
        match v {
            Value::Array(a) if a.len() == 4 => Quat::new(
                read_int(&a[0])?,
                read_int(&a[1])?,
                read_int(&a[2])?,
                read_int(&a[3])?,
            ),
            _ => Err(PoseRefusal::NotARecord),
        }
    }
}

/// A frame of reference: a node, and the slot in it if the pose is in one (rule 1). In a world it is the node's
/// parent and slot (T2, `v2/docs/world-model.md`), stored there once; a pose names it only where it travels alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Frame {
    pub node: Id,
    pub slot: Option<u64>,
}

/// What holds a pose where it is (rule 6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Support {
    /// A surface, and the height above it, in micrometres. Standing has height 0; hovering has more (settled at
    /// reconciliation: a hovering body is supported by the surface below it, with a height).
    Surface { surface: Id, height: i64 },
    /// The slot of the frame: the frame's own slot, never a second field (a held cup).
    Slot,
    /// A volume it floats or swims in (water, a tank).
    Volume { volume: Id },
    /// The rail of the track that owns its motion, named once, in the track.
    Track,
    /// Nothing: in flight.
    None,
}

/// A pose (rule 1): a frame, a position in micrometres, an orientation and what supports it, all in the frame's axes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pose {
    pub frame: Frame,
    pub position: Vec3,
    pub orientation: Quat,
    pub support: Support,
}

impl Pose {
    /// Checks support against the frame: a pose in a slot is supported by the slot and only then (rule 6), and a
    /// height is never below its surface.
    pub fn check(&self) -> R<()> {
        match (self.frame.slot.is_some(), self.support) {
            (true, Support::Slot) => Ok(()),
            (true, _) | (false, Support::Slot) => Err(PoseRefusal::SupportNotSlot),
            (false, Support::Surface { height, .. }) if height < 0 => {
                Err(PoseRefusal::HeightBelowSurface)
            }
            _ => Ok(()),
        }
    }
}

/// A closed-form track: a pose's position as a formula of world time, never accumulated (rule 8). Its orientation
/// stays the pose's; a track that turns needs an integer sine table and is N14's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Track {
    /// At rest where the pose is.
    Rest,
    /// From the pose's position at `t0`, at a constant velocity in micrometres a second.
    Straight { t0: Micros, velocity: Vec3 },
    /// Thrown from the pose's position at `t0` with `velocity`, under `gravity` (micrometres a second squared, in the frame's
    /// axes), and a spin carried as data (micro-radians a second) until N14 turns it.
    Thrown {
        t0: Micros,
        velocity: Vec3,
        gravity: Vec3,
        spin: Vec3,
    },
    /// Along a rail's path at a constant speed: `s0` micrometres along it at `t0`. The path is N14's.
    Rail {
        rail: Id,
        t0: Micros,
        s0: i64,
        speed: i64,
    },
}

impl Track {
    /// Position and velocity at world time `t`, for a track that starts (or rests) at its pose's position `start`
    /// (rule 8): the start is stored once, in the pose. One rounding per
    /// number: `p0 + (2·10^6·v·dt + g·dt²) / (2·10^12)`.
    pub fn at(&self, start: Vec3, t: Micros) -> R<(Vec3, Vec3)> {
        let since = |t0: Micros| -> R<i128> {
            let dt = i128::from(t) - i128::from(t0);
            if dt < 0 {
                Err(PoseRefusal::BeforeTrackStart)
            } else {
                Ok(dt)
            }
        };
        match *self {
            Track::Rest => Ok((start, Vec3::ZERO)),
            Track::Straight { t0, velocity } => {
                let dt = since(t0)?;
                let step = velocity
                    .wide()
                    .map(|v| mul(v, dt).and_then(|n| div_round(n, MICRO)));
                let step = Vec3::from_wide([step[0]?, step[1]?, step[2]?])?;
                Ok((start.plus(step)?, velocity))
            }
            Track::Thrown {
                t0,
                velocity,
                gravity,
                ..
            } => {
                let dt = since(t0)?;
                let (v, g) = (velocity.wide(), gravity.wide());
                let mut step = [0i128; 3];
                let mut vel = [0i128; 3];
                for i in 0..3 {
                    let n = add(mul(mul(2 * MICRO, v[i])?, dt)?, mul(g[i], mul(dt, dt)?)?)?;
                    step[i] = div_round(n, 2 * MICRO * MICRO)?;
                    vel[i] = add(v[i], div_round(mul(g[i], dt)?, MICRO)?)?;
                }
                Ok((start.plus(Vec3::from_wide(step)?)?, Vec3::from_wide(vel)?))
            }
            Track::Rail { .. } => Err(PoseRefusal::RailNeedsPath),
        }
    }

    /// The spin a track carries (micro-radians a second), zero but for a thrown track's.
    pub fn spin(&self) -> Vec3 {
        match self {
            Track::Thrown { spin, .. } => *spin,
            _ => Vec3::ZERO,
        }
    }
}

/// Who owns a movable's motion: exactly one (rule 7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// The slot it is in: it moves with its frame and has no motion of its own (a held cup).
    Slot,
    /// Its own mover (N6), steered by its own controller: a body's by its Soul's (or, while it is joined, by the joint
    /// skill that claims its movement), an activity node's by the joint skill. No driver is named, so no record can
    /// say that one body drives another (rule 7).
    Mover,
    /// A closed-form track.
    Track(Track),
    /// A physics island: reserved, refused.
    Island,
}

/// A movable as a scene holds it: its pose, the owner of its motion, the velocity a mover holds (in the frame's axes;
/// a slot's is zero and a track's comes from its formula) and the points of its slots in its own frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Movable {
    pub id: Id,
    pub pose: Pose,
    pub owner: Owner,
    pub linear: Vec3,
    pub angular: Vec3,
    pub slots: BTreeMap<u64, Vec3>,
}

impl Movable {
    /// The pose's support checks, and the owner fits the frame (rule 7).
    pub fn check(&self) -> R<()> {
        self.pose.check()?;
        let on_rail = matches!(self.owner, Owner::Track(Track::Rail { .. }));
        if (self.pose.support == Support::Track) != on_rail {
            return Err(PoseRefusal::SupportNotTrack);
        }
        match (self.pose.frame.slot.is_some(), self.owner) {
            (_, Owner::Island) => Err(PoseRefusal::IslandReserved),
            (true, Owner::Slot) | (false, Owner::Mover | Owner::Track(_)) => Ok(()),
            _ => Err(PoseRefusal::OwnerNotSlot),
        }
    }
}

/// A frame's or a movable's motion in the root frame at one world time: position, orientation, linear velocity
/// (micrometres a second) and angular velocity (micro-radians a second).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Motion {
    pub position: Vec3,
    pub orientation: Quat,
    pub linear: Vec3,
    pub angular: Vec3,
}

impl Motion {
    const ROOT: Motion = Motion {
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        linear: Vec3::ZERO,
        angular: Vec3::ZERO,
    };

    /// A child's local motion `local`, at `offset` (its slot's point) in this frame, carried into this frame's
    /// parent: one rounding per turned vector (rule 9).
    fn carry(&self, offset: Vec3, local: &Motion) -> R<Motion> {
        let arm = self.orientation.rotate(offset.plus(local.position)?)?;
        Ok(Motion {
            position: self.position.plus(arm)?,
            orientation: self.orientation.then(local.orientation)?,
            linear: self
                .linear
                .plus(self.angular.cross_micro(arm)?)?
                .plus(self.orientation.rotate(local.linear)?)?,
            angular: self.angular.plus(self.orientation.rotate(local.angular)?)?,
        })
    }

    /// The local motion, at `offset` in this frame, that `carry` takes to `world` (rule 9).
    fn local_of(&self, offset: Vec3, world: &Motion) -> R<Motion> {
        let back = self.orientation.conjugate();
        let arm = world.position.minus(self.position)?;
        Ok(Motion {
            position: back.rotate(arm)?.minus(offset)?,
            orientation: back.then(world.orientation)?,
            linear: back.rotate(
                world
                    .linear
                    .minus(self.linear)?
                    .minus(self.angular.cross_micro(arm)?)?,
            )?,
            angular: back.rotate(world.angular.minus(self.angular)?)?,
        })
    }
}

/// A hand-off (rule 10): at world time `at`, `node`'s motion passes from one owner to another, with its pose in the
/// new frame and its linear and angular velocity in the new frame's axes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HandOff {
    pub node: Id,
    pub at: Micros,
    pub from: Owner,
    pub to: Owner,
    pub pose: Pose,
    pub linear: Vec3,
    pub angular: Vec3,
}

/// A movement mode (rule 11). Only walking on a surface is built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Surface,
}

impl Mode {
    /// The mode a record's number names: 1 is walking on a surface; any other is refused as `mode-not-built`.
    pub fn from_number(n: u64) -> R<Mode> {
        match n {
            1 => Ok(Mode::Surface),
            _ => Err(PoseRefusal::ModeNotBuilt),
        }
    }
}

/// What a controller takes (rule 11): a velocity in three dimensions, in the body's frame, and a mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControllerInput {
    pub velocity: Vec3,
    pub mode: Mode,
}

/// A region's kind (rule 12). A link between two regions names the move that crosses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RegionKind {
    Ground,
    Water,
    Air,
}

/// A set of movables under one root frame, each listed after its frame. Walks are loops, never recursion.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scene {
    pub root: Id,
    movables: BTreeMap<Id, Movable>,
}

impl Scene {
    /// A scene, each movable checked and listed after its frame (`frame-order`, `frame-missing`), none with more
    /// than T2's 32 ancestors (`depth-over-limit`).
    pub fn new(root: Id, list: Vec<Movable>) -> R<Scene> {
        let mut movables = BTreeMap::new();
        let mut depth: BTreeMap<Id, u32> = BTreeMap::new();
        for m in list {
            m.check()?;
            if m.id == root || movables.contains_key(&m.id) {
                return Err(PoseRefusal::FrameOrder);
            }
            let f = m.pose.frame;
            if f.node != root {
                let parent: &Movable = movables.get(&f.node).ok_or(PoseRefusal::FrameOrder)?;
                if f.slot.is_some_and(|s| !parent.slots.contains_key(&s)) {
                    return Err(PoseRefusal::FrameMissing);
                }
            } else if f.slot.is_some() {
                return Err(PoseRefusal::FrameMissing);
            }
            let d = depth.get(&f.node).copied().unwrap_or(0) + 1;
            if d > crate::world_model::DEPTH_LIMIT {
                return Err(PoseRefusal::DepthOverLimit);
            }
            depth.insert(m.id, d);
            movables.insert(m.id, m);
        }
        Ok(Scene { root, movables })
    }

    pub fn get(&self, id: Id) -> Option<&Movable> {
        self.movables.get(&id)
    }

    /// The point of a frame's slot in its node's frame; the root's frame and no slot give zero.
    fn offset(&self, frame: Frame) -> R<Vec3> {
        match frame.slot {
            None => Ok(Vec3::ZERO),
            Some(s) => self
                .movables
                .get(&frame.node)
                .and_then(|m| m.slots.get(&s))
                .copied()
                .ok_or(PoseRefusal::FrameMissing),
        }
    }

    /// A movable's own motion in its frame at `t`, from its owner.
    fn local(&self, m: &Movable, t: Micros) -> R<Motion> {
        let (position, linear, angular) = match m.owner {
            Owner::Track(track) => {
                let (p, v) = track.at(m.pose.position, t)?;
                (p, v, track.spin())
            }
            Owner::Mover => (m.pose.position, m.linear, m.angular),
            Owner::Slot | Owner::Island => (m.pose.position, Vec3::ZERO, Vec3::ZERO),
        };
        Ok(Motion {
            position,
            orientation: m.pose.orientation,
            linear,
            angular,
        })
    }

    /// A node's motion in the root frame at world time `t` (the root's is zero), and the number of frames crossed to
    /// reach it: one carry, so one rounding of each turned vector, per frame (rule 9).
    pub fn motion(&self, id: Id, t: Micros) -> R<(Motion, u32)> {
        let mut chain = Vec::new();
        let mut at = id;
        while at != self.root {
            let m = self.movables.get(&at).ok_or(PoseRefusal::FrameMissing)?;
            chain.push(m);
            // The node's ancestors are the rest of the chain and the root: as many as the chain is long (T2).
            if chain.len() > crate::world_model::DEPTH_LIMIT as usize {
                return Err(PoseRefusal::DepthOverLimit);
            }
            at = m.pose.frame.node;
        }
        let crossed = u32::try_from(chain.len()).map_err(|_| PoseRefusal::OutOfRange)?;
        let mut world = Motion::ROOT;
        for m in chain.into_iter().rev() {
            world = world.carry(self.offset(m.pose.frame)?, &self.local(m, t)?)?;
        }
        Ok((world, crossed))
    }

    /// Hands `id`'s motion at `t` to `to` in `frame`, with `support`, adding `push` (micrometres a second, in the new
    /// frame's axes) to the velocity it keeps (rule 10). The movable's pose, owner and velocity in the new frame are
    /// what keeps its motion in the root frame, to one unit per frame crossed. Returns the hand-off and the frames
    /// crossed, old and new. A track handed to starts at `t` from the new pose with the new velocity. A slot or a
    /// rest track keeps the position only: its velocity, and the record's, is zero.
    pub fn hand_off(
        &mut self,
        id: Id,
        t: Micros,
        frame: Frame,
        support: Support,
        to: Owner,
        push: Vec3,
    ) -> R<(HandOff, u32)> {
        let m = self
            .movables
            .get(&id)
            .ok_or(PoseRefusal::FrameMissing)?
            .clone();
        let (world, old) = self.motion(id, t)?;
        // A movable is never handed into a frame inside itself (its own hand): the walk up would not end.
        let mut up = frame.node;
        while up != self.root {
            if up == id {
                return Err(PoseRefusal::FrameOrder);
            }
            up = self
                .movables
                .get(&up)
                .ok_or(PoseRefusal::FrameMissing)?
                .pose
                .frame
                .node;
        }
        let (new_frame, new) = self.motion(frame.node, t)?;
        let local = new_frame.local_of(self.offset(frame)?, &world)?;
        // A slot or a rest track carries no velocity: a catch ends the motion on purpose, and the record says so.
        let (linear, angular) = match to {
            Owner::Slot | Owner::Track(Track::Rest) => (Vec3::ZERO, Vec3::ZERO),
            _ => (local.linear.plus(push)?, local.angular),
        };
        let to = match to {
            Owner::Track(Track::Straight { .. }) => Owner::Track(Track::Straight {
                t0: t,
                velocity: linear,
            }),
            Owner::Track(Track::Thrown { gravity, .. }) => Owner::Track(Track::Thrown {
                t0: t,
                velocity: linear,
                gravity,
                spin: angular,
            }),
            other => other,
        };
        let pose = Pose {
            frame,
            position: local.position,
            orientation: local.orientation,
            support,
        };
        let moved = Movable {
            id,
            pose,
            owner: to,
            linear,
            angular,
            slots: m.slots.clone(),
        };
        moved.check()?;
        self.movables.insert(id, moved);
        Ok((
            HandOff {
                node: id,
                at: t,
                from: m.owner,
                to,
                pose,
                linear,
                angular,
            },
            old + new + 1,
        ))
    }
}

// Records (rule 13). Ids are T3's `[scope, counter]`; a fixture writes the counter only, in `FIXTURE_SCOPE_POSE`.

/// The scope a fixture's counters are minted in.
pub const FIXTURE_SCOPE_POSE: Scope = Scope([0xcc; 16]);

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: &Value) -> R<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).map_err(|_| PoseRefusal::OutOfRange),
        Value::Nint(n) => i64::try_from(*n)
            .map(|n| -1 - n)
            .map_err(|_| PoseRefusal::OutOfRange),
        _ => Err(PoseRefusal::NotARecord),
    }
}

fn map(pairs: Vec<(u64, Value)>) -> Value {
    Value::Map(pairs.into_iter().collect())
}

fn field(m: &BTreeMap<u64, Value>, k: u64) -> R<&Value> {
    m.get(&k).ok_or(PoseRefusal::NotARecord)
}

fn as_map(v: &Value) -> R<&BTreeMap<u64, Value>> {
    match v {
        Value::Map(m) => Ok(m),
        _ => Err(PoseRefusal::NotARecord),
    }
}

fn fixture_id(v: &Value) -> R<Id> {
    match v {
        Value::Uint(c) => Id::new(FIXTURE_SCOPE_POSE, *c).ok_or(PoseRefusal::OutOfRange),
        _ => Err(PoseRefusal::NotARecord),
    }
}

/// How a reader takes an id: a fixture's counter, or T3's stored `[h'<scope>', counter]`.
type IdOf = fn(&Value) -> R<Id>;

/// An id as T3 stores it, `[h'<scope>', counter]` (ids.md rule 3).
fn stored_id(v: &Value) -> R<Id> {
    match v {
        Value::Array(a) if a.len() == 2 => match (&a[0], &a[1]) {
            (Value::Bytes(s), Value::Uint(c)) => {
                let scope =
                    <[u8; 16]>::try_from(s.as_slice()).map_err(|_| PoseRefusal::NotARecord)?;
                Id::new(Scope(scope), *c).ok_or(PoseRefusal::OutOfRange)
            }
            _ => Err(PoseRefusal::NotARecord),
        },
        _ => Err(PoseRefusal::NotARecord),
    }
}

fn uint(v: &Value) -> R<u64> {
    match v {
        Value::Uint(u) => Ok(*u),
        _ => Err(PoseRefusal::NotARecord),
    }
}

impl Frame {
    fn to_value(self) -> Value {
        let mut a = vec![self.node.to_value()];
        a.extend(self.slot.map(Value::Uint));
        Value::Array(a)
    }

    fn read(v: &Value, id: IdOf) -> R<Frame> {
        match v {
            Value::Array(a) if a.len() == 1 || a.len() == 2 => Ok(Frame {
                node: id(&a[0])?,
                slot: a.get(1).map(uint).transpose()?,
            }),
            _ => Err(PoseRefusal::NotARecord),
        }
    }
}

impl Support {
    /// `{1: which, 2: node, 3: height}`: 1 surface, 2 slot, 3 volume, 4 track (the rail is the track's), 0 none.
    fn to_value(self) -> Value {
        match self {
            Support::None => map(vec![(1, Value::Uint(0))]),
            Support::Surface { surface, height } => map(vec![
                (1, Value::Uint(1)),
                (2, surface.to_value()),
                (3, int(height)),
            ]),
            Support::Slot => map(vec![(1, Value::Uint(2))]),
            Support::Volume { volume } => map(vec![(1, Value::Uint(3)), (2, volume.to_value())]),
            Support::Track => map(vec![(1, Value::Uint(4))]),
        }
    }

    fn read(v: &Value, id: IdOf) -> R<Support> {
        let m = as_map(v)?;
        match uint(field(m, 1)?)? {
            0 => Ok(Support::None),
            1 => Ok(Support::Surface {
                surface: id(field(m, 2)?)?,
                height: read_int(field(m, 3)?)?,
            }),
            2 => Ok(Support::Slot),
            3 => Ok(Support::Volume {
                volume: id(field(m, 2)?)?,
            }),
            4 => Ok(Support::Track),
            _ => Err(PoseRefusal::NotARecord),
        }
    }
}

impl Pose {
    /// `{1: frame, 2: position, 3: orientation, 4: support}`.
    pub fn to_value(self) -> Value {
        map(vec![
            (1, self.frame.to_value()),
            (2, self.position.to_value()),
            (3, self.orientation.to_value()),
            (4, self.support.to_value()),
        ])
    }

    fn read(v: &Value, id: IdOf) -> R<Pose> {
        let m = as_map(v)?;
        let pose = Pose {
            frame: Frame::read(field(m, 1)?, id)?,
            position: Vec3::from_value(field(m, 2)?)?,
            orientation: Quat::from_value(field(m, 3)?)?,
            support: Support::read(field(m, 4)?, id)?,
        };
        pose.check()?;
        Ok(pose)
    }
}

impl Track {
    /// `{1: which, 2: t0, 4: velocity, 5: gravity, 6: spin}` (2 straight, 3 thrown; the start is the pose's
    /// position); rest is `{1: 1}`; a rail is `{1: 4, 2: t0, 3: s0, 4: speed, 7: rail}`.
    fn to_value(self) -> Value {
        match self {
            Track::Rest => map(vec![(1, Value::Uint(1))]),
            Track::Straight { t0, velocity } => map(vec![
                (1, Value::Uint(2)),
                (2, int(t0)),
                (4, velocity.to_value()),
            ]),
            Track::Thrown {
                t0,
                velocity,
                gravity,
                spin,
            } => map(vec![
                (1, Value::Uint(3)),
                (2, int(t0)),
                (4, velocity.to_value()),
                (5, gravity.to_value()),
                (6, spin.to_value()),
            ]),
            Track::Rail {
                rail,
                t0,
                s0,
                speed,
            } => map(vec![
                (1, Value::Uint(4)),
                (2, int(t0)),
                (3, int(s0)),
                (4, int(speed)),
                (7, rail.to_value()),
            ]),
        }
    }

    fn read(m: &BTreeMap<u64, Value>, id: IdOf) -> R<Track> {
        let vec = |k| Vec3::from_value(field(m, k)?);
        match uint(field(m, 1)?)? {
            1 => Ok(Track::Rest),
            2 => Ok(Track::Straight {
                t0: read_int(field(m, 2)?)?,
                velocity: vec(4)?,
            }),
            3 => Ok(Track::Thrown {
                t0: read_int(field(m, 2)?)?,
                velocity: vec(4)?,
                gravity: vec(5)?,
                spin: vec(6)?,
            }),
            4 => Ok(Track::Rail {
                rail: id(field(m, 7)?)?,
                t0: read_int(field(m, 2)?)?,
                s0: read_int(field(m, 3)?)?,
                speed: read_int(field(m, 4)?)?,
            }),
            _ => Err(PoseRefusal::NotARecord),
        }
    }
}

impl Owner {
    /// `{1: which, 2: track}`: 1 slot, 2 mover (its own: no driver is named), 3 track, 4 island.
    pub fn to_value(self) -> Value {
        match self {
            Owner::Slot => map(vec![(1, Value::Uint(1))]),
            Owner::Mover => map(vec![(1, Value::Uint(2))]),
            Owner::Track(t) => map(vec![(1, Value::Uint(3)), (2, t.to_value())]),
            Owner::Island => map(vec![(1, Value::Uint(4))]),
        }
    }

    fn read(v: &Value, id: IdOf) -> R<Owner> {
        let m = as_map(v)?;
        match uint(field(m, 1)?)? {
            1 => Ok(Owner::Slot),
            2 => Ok(Owner::Mover),
            3 => Ok(Owner::Track(Track::read(as_map(field(m, 2)?)?, id)?)),
            4 => Err(PoseRefusal::IslandReserved),
            _ => Err(PoseRefusal::NotARecord),
        }
    }
}

impl HandOff {
    /// `{1: node, 2: at, 3: from, 4: to, 5: pose, 6: linear, 7: angular}`.
    pub fn to_value(self) -> Value {
        map(vec![
            (1, self.node.to_value()),
            (2, int(self.at)),
            (3, self.from.to_value()),
            (4, self.to.to_value()),
            (5, self.pose.to_value()),
            (6, self.linear.to_value()),
            (7, self.angular.to_value()),
        ])
    }
}

impl Pose {
    /// A stored pose (T6 reads these): T3 ids, checked, and in its one byte form, else `not-a-record`.
    pub fn from_value(v: &Value) -> R<Pose> {
        let pose = Pose::read(v, stored_id)?;
        if pose.to_value() != *v {
            return Err(PoseRefusal::NotARecord);
        }
        Ok(pose)
    }
}

impl HandOff {
    /// A stored hand-off (T6's motion sample): T3 ids, owners as [`Owner`] reads them (an island is refused), and
    /// in its one byte form, else `not-a-record`.
    pub fn from_value(v: &Value) -> R<HandOff> {
        let m = as_map(v)?;
        let h = HandOff {
            node: stored_id(field(m, 1)?)?,
            at: read_int(field(m, 2)?)?,
            from: Owner::read(field(m, 3)?, stored_id)?,
            to: Owner::read(field(m, 4)?, stored_id)?,
            pose: Pose::read(field(m, 5)?, stored_id)?,
            linear: Vec3::from_value(field(m, 6)?)?,
            angular: Vec3::from_value(field(m, 7)?)?,
        };
        if h.to_value() != *v {
            return Err(PoseRefusal::NotARecord);
        }
        Ok(h)
    }
}

/// Where a fixture says a node must be in the root frame at a world time, in micrometres.
pub type Expectation = (Id, Micros, Vec3);

/// A fixture scene: `{1: root, 2: [movable, ...], 3: [[node, t, [x, y, z]], ...]}`, each movable
/// `{1: id, 2: pose, 3: owner, 4: {slot: [x, y, z]}}` with counters for ids. Field 3 lists where each named node
/// must be in the root frame at world time t, in micrometres. Returns the scene and those checks.
pub fn scene_from_fixture(v: &Value) -> R<(Scene, Vec<Expectation>)> {
    let m = as_map(v)?;
    let root = fixture_id(field(m, 1)?)?;
    let Value::Array(list) = field(m, 2)? else {
        return Err(PoseRefusal::NotARecord);
    };
    let mut movables = Vec::new();
    for item in list {
        let r = as_map(item)?;
        let mut slots = BTreeMap::new();
        if let Some(s) = r.get(&4) {
            for (k, p) in as_map(s)? {
                slots.insert(*k, Vec3::from_value(p)?);
            }
        }
        movables.push(Movable {
            id: fixture_id(field(r, 1)?)?,
            pose: Pose::read(field(r, 2)?, fixture_id)?,
            owner: Owner::read(field(r, 3)?, fixture_id)?,
            linear: Vec3::ZERO,
            angular: Vec3::ZERO,
            slots,
        });
    }
    let scene = Scene::new(root, movables)?;
    let mut checks = Vec::new();
    if let Some(Value::Array(cs)) = m.get(&3) {
        for c in cs {
            match c {
                Value::Array(a) if a.len() == 3 => checks.push((
                    fixture_id(&a[0])?,
                    read_int(&a[1])?,
                    Vec3::from_value(&a[2])?,
                )),
                _ => return Err(PoseRefusal::NotARecord),
            }
        }
    }
    Ok((scene, checks))
}

/// The three fixtures, by file name.
pub const FIXTURES: [(&str, &str); 3] = [
    ("boat.diag", include_str!("../fixtures/pose/boat.diag")),
    ("hover.diag", include_str!("../fixtures/pose/hover.diag")),
    ("thrown.diag", include_str!("../fixtures/pose/thrown.diag")),
];

/// A fixture's value, its `#` comments left out.
pub fn fixture_value(text: &str) -> R<Value> {
    let bare: Vec<&str> = text
        .lines()
        .map(|l| l.split('#').next().unwrap_or(""))
        .collect();
    crate::encode::parse_diagnostic(&bare.join("\n")).map_err(|_| PoseRefusal::NotARecord)
}

/// The id a fixture's counter names.
pub fn fixture(counter: u64) -> Id {
    Id::new(FIXTURE_SCOPE_POSE, counter).unwrap_or_else(|| unreachable!("a small counter"))
}

/// The pose goldens, one per line, as `fixtures/pose/goldens.txt` holds them: the native test and the WASM build in
/// Node both compare this with that file. WASM exports it only with the `vectors` feature.
#[cfg_attr(all(target_arch = "wasm32", feature = "vectors"), wasm_bindgen)]
pub fn pose_goldens() -> String {
    let mut lines = Vec::new();
    match goldens(&mut lines) {
        Ok(()) => lines.join("\n") + "\n",
        Err(r) => format!("refused {r}\n"),
    }
}

fn line(lines: &mut Vec<String>, name: &str, m: &Motion) {
    lines.push(format!(
        "{name} p {} q {:?} v {} w {}",
        m.position,
        m.orientation.parts(),
        m.linear,
        m.angular
    ));
}

fn goldens(lines: &mut Vec<String>) -> R<()> {
    for (name, text) in FIXTURES {
        let (scene, checks) = scene_from_fixture(&fixture_value(text)?)?;
        for (id, t, _) in &checks {
            let (m, _) = scene.motion(*id, *t)?;
            line(lines, &format!("{name} node {} at {t}", id.counter()), &m);
        }
    }
    let drift = hand_offs(1_000)?;
    lines.push(format!(
        "drift-1000 position {} velocity {} orientation {} worst-step {}/{} last-hand-off {}",
        drift.position,
        drift.velocity,
        drift.orientation,
        drift.worst_step.0,
        drift.worst_step.1,
        drift.last
    ));
    Ok(())
}

/// What a run of hand-offs measured (rule 14).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Drift {
    /// The largest distance, per component in micrometres, between where a body is after the hand-offs and where
    /// exact arithmetic puts it.
    pub position: i128,
    /// The same for its velocity in the root frame, micrometres a second.
    pub velocity: i128,
    /// The same for its orientation, in 2^-30.
    pub orientation: i128,
    /// The largest change in the root frame across one hand-off, in units, against that hand-off's frames crossed:
    /// `(change, crossed)`, the worst ratio seen.
    pub worst_step: (i128, u32),
    /// The most frames one hand-off crossed.
    pub crossed: u32,
    /// The last hand-off's record, in hex.
    pub last: String,
}

/// Hands the body of `boat.diag` from the deck to the dock and back, `n` times, every 10 ms (rule 14). Between
/// hand-offs it keeps its pose in its frame (its mover, N6, is idle). Exact arithmetic: the deck moves a whole number
/// of micrometres in 10 ms, so where the body should be is a sum of integers.
pub fn hand_offs(n: u32) -> R<Drift> {
    let (mut scene, _) = scene_from_fixture(&fixture_value(FIXTURES[0].1)?)?;
    let (body, boat, dock) = (fixture(3), fixture(2), fixture(4));
    let step: Micros = 10_000;
    let (start, _) = scene.motion(body, 0)?;
    let mut truth = start.position;
    let orientation = start.orientation;
    let boat_velocity = match scene.get(boat).map(|m| m.owner) {
        Some(Owner::Track(Track::Straight { velocity, .. })) => velocity,
        _ => return Err(PoseRefusal::NotARecord),
    };
    let mut on_deck = true;
    let (mut worst, mut most) = ((0i128, 1u32), 0u32);
    let mut last = String::new();
    for i in 0..n {
        let t = i64::from(i) * step;
        if on_deck && i > 0 {
            truth = truth.plus(Vec3::from_wide(
                boat_velocity.wide().map(|v| v * i128::from(step) / MICRO),
            )?)?;
        }
        let (before, _) = scene.motion(body, t)?;
        let (frame, support) = if on_deck {
            (
                dock,
                Support::Surface {
                    surface: dock,
                    height: 0,
                },
            )
        } else {
            (
                boat,
                Support::Surface {
                    surface: boat,
                    height: 0,
                },
            )
        };
        let (h, crossed) = scene.hand_off(
            body,
            t,
            Frame {
                node: frame,
                slot: None,
            },
            support,
            Owner::Mover,
            Vec3::ZERO,
        )?;
        let (after, _) = scene.motion(body, t)?;
        let change = before
            .position
            .apart(after.position)
            .max(before.linear.apart(after.linear));
        if change * i128::from(worst.1) > worst.0 * i128::from(crossed) {
            worst = (change, crossed);
        }
        most = most.max(crossed);
        last = to_hex(&encode(&h.to_value()).map_err(|_| PoseRefusal::OutOfRange)?);
        on_deck = !on_deck;
    }
    // The body ends where the last hand-off left it; bring the truth to the same instant.
    let t = i64::from(n.saturating_sub(1)) * step;
    let (end, _) = scene.motion(body, t)?;
    let q = |a: Quat, b: Quat| {
        let (a, b) = (a.wide(), b.wide());
        (0..4).map(|i| (a[i] - b[i]).abs()).max().unwrap_or(0)
    };
    Ok(Drift {
        position: end.position.apart(truth),
        velocity: end.linear.apart(boat_velocity),
        orientation: q(end.orientation, orientation),
        worst_step: worst,
        crossed: most,
        last,
    })
}
