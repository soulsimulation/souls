//! Close quarters (Engine v2 N13, #2723): four inputs on the legs for short-range movement by velocity, with no
//! route search. Each is a skill: it claims all the body's locomotion and moves it only by controller inputs (B1), so
//! the mover (N6) is the one thing that moves it and ground is the only hard limit.
//!
//! - **Step** (direction, distance): moves the body the distance along the direction and ends, `Done`. A step that
//!   is stopped or turned aside by the edge of the ground ends short, by name ([`WALLED`]), where it stands; it does
//!   not walk on along the wall.
//! - **Circle** (centre, side): walks round the centre at the distance it started at, the centre on the side named.
//! - **Go near** (target, distance): walks straight toward the target until it is that far from it, then stands, and
//!   closes again when the target moves off.
//! - **Follow** (leader, band): walks the leader's trail, the points the leader stood on as read each tick (a node
//!   other than the body is read as of the previous tick, T1), keeping the distance along the trail inside the band,
//!   at the leader's gait (its pace, up to [`FASTEST`]). The leader walked it, so it is legal ground, and the follower does not aim at the leader through a wall. When the
//!   follower stops making way on the trail (it lacks an ability the trail needs), it asks for one route toward the
//!   leader (N5, through the host's `Toward`), walks to the point it is given, says so in an event
//!   ([`FELL_BACK`]), and goes back to the trail. Once per follow.
//!
//!   A follow may instead keep a place **beside** the leader (0.135 R1, walking hand in hand,
//!   `v2/docs/moving-group.md` rule 3): a point the given width to the side of the leader's heading, the heading
//!   being the way the leader last walked, the side being the one the follower stood on when the leader first moved.
//!   The place is a target the follower walks to, never a constraint; a follower farther than [`LET_GO`] from it, or
//!   whose leader it cannot see (another frame: through a door, onto a deck), for [`LET_GO_TICKS`] ends, by name
//!   ([`LOST_PLACE`]): it could not keep its place, so it lets go. When the leader turns back (its heading more than
//!   90° from the last), the side is taken again from where the follower stands, and a way to the place that would
//!   pass within [`KEEP_APART`] of the leader goes round it: the follower never walks through the leader.
//!
//!   Or a place **at** a fixed offset from the leader on the plan (carrying together, moving-group rule 3): the
//!   follower's place in a group that moves as its leader walks, such as a carry's crew whose front walks. The place is
//!   a target, as beside, and a place not kept ends the same way ([`LOST_PLACE`]). With a **turn** (a leader's goal
//!   and the offset there), the group turns as the leader goes: the offset swings from the first to the second, about
//!   the leader, by the share of the way to its goal the leader has walked since the follow began, and keeps its
//!   length ([`Follow::turning`]). The follower is fed its place's own pace, so a place that swings faster than the
//!   leader walks is kept as closely.
//!
//! Circle, go near and follow end only when replaced (another skill claims the legs; they are `cancelled_by`
//! locomotion), cancelled (the body releases them) or expired (`until`, world time). None of them ever picks a new
//! target: the target is the one the agent ordered, held for the input's life. A target that is gone, or in another
//! frame, is waited for standing still.
//!
//! Positions are in the body's parent's frame, in T4's units (µm); the height part is the surface's and is not
//! steered. Not here: contact and reactions (B6), the order's lifetime (B7), dance timing (B8), crossing a link
//! (T9b, #3120).

use replica::bodies::{Class, SkillShape, Want};
use replica::effects::Event;
use replica::encode::Name;
use replica::host::{Answer, Ask, Host, Progress, Skill};
use replica::ids::Id;
use replica::pose::{ControllerInput, Mode, Vec3};
use replica::time::{MICROS_PER_SECOND, Micros};
use std::collections::BTreeMap;

/// Walking pace, µm a second.
pub const SPEED: i64 = 1_400_000;
/// The most a follower or a body going near walks at while it closes, µm a second.
pub const FAST: i64 = 2_400_000;
/// The fastest gait on dry ground (`sim::gaits`' run), µm a second: a follower keeps up with a leader who runs.
pub const FASTEST: i64 = 4_000_000;
/// The tick a step assumes before it has seen two (µs); after that it measures them by world time.
pub const TICK: Micros = 50_000;
/// How near the stated distance counts as done, µm.
pub const THERE: i64 = 10_000;
/// How far off its line, or how far short of a tick's move, a step may be before it counts as walled, µm.
pub const OFF_LINE: i64 = 20_000;
/// The spacing of the points a follower keeps of its leader's trail, µm.
pub const TRAIL_GAP: i64 = 200_000;
/// A trail point counts as reached this near, µm.
pub const REACHED: i64 = 300_000;
/// The most trail points a follower keeps (a leader 400 m ahead).
pub const TRAIL_MOST: usize = 2_000;
/// Ticks a follower may make less than a quarter of the way it asked for before it falls back to a route.
pub const STALL: u32 = 10;
/// A follower beside its leader (0.135 R1, hand in hand) farther than this from its place, µm, is not keeping it.
pub const LET_GO: i64 = 1_500_000;
/// Ticks a follower beside its leader may be farther than [`LET_GO`] from its place before it lets go (2 s).
pub const LET_GO_TICKS: u32 = 40;
/// A follower beside its leader never walks nearer the leader's middle than this, µm: two body radii's room.
pub const KEEP_APART: i64 = 350_000;
/// A follower beside its leader that could not keep its place ends with this name.
pub const LOST_PLACE: &str = "souls:follow-lost-place";

/// A step that met the edge of the ground ends with this name.
pub const WALLED: &str = "souls:step-walled";
/// A follower that fell back to a route says so with an event of this name.
pub const FELL_BACK: &str = "souls:follow-fell-back";

fn name(t: &str) -> Name {
    Name::new(t).unwrap_or_else(|| unreachable!("a fixed name"))
}

fn isqrt(n: i128) -> i128 {
    if n <= 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// The offset `from` swung toward `to` about the origin by `k` of `of` (0 is `from`, `of` is `to`), keeping `from`'s
/// length: each half of the swing is the two ends' weighted sum made that long again (at most a quarter turn, so the
/// sum is never short), the half way their sum (or, for ends opposite, `from` turned a quarter). Integers only.
pub fn swung(from: [i64; 2], to: [i64; 2], k: i64, of: i64) -> [i64; 2] {
    let (k, of) = (i128::from(k.clamp(0, of.max(1))), i128::from(of.max(1)));
    let f = [i128::from(from[0]), i128::from(from[1])];
    let t = [i128::from(to[0]), i128::from(to[1])];
    let length = isqrt(f[0] * f[0] + f[1] * f[1]);
    let mut mid = [f[0] + t[0], f[1] + t[1]];
    if mid == [0, 0] {
        mid = [-f[1], f[0]];
    }
    let (a, b, k) = if 2 * k <= of {
        (f, mid, 2 * k)
    } else {
        (mid, t, 2 * k - of)
    };
    let v = [a[0] * (of - k) + b[0] * k, a[1] * (of - k) + b[1] * k];
    let l = isqrt(v[0] * v[0] + v[1] * v[1]);
    if l == 0 {
        return from;
    }
    let c = |x: i128| i64::try_from(x * length / l).unwrap_or(0);
    [c(v[0]), c(v[1])]
}

/// The ground distance (x and z) from `a` to `b`, µm.
pub(crate) fn apart(a: Vec3, b: Vec3) -> i64 {
    let (dx, dz) = (i128::from(b.x - a.x), i128::from(b.z - a.z));
    i64::try_from(isqrt(dx * dx + dz * dz)).unwrap_or(i64::MAX)
}

/// How near the straight way from `a` to `b` passes `c`, on the ground, µm.
fn passes(a: Vec3, b: Vec3, c: Vec3) -> i64 {
    let (dx, dz) = (i128::from(b.x - a.x), i128::from(b.z - a.z));
    let (cx, cz) = (i128::from(c.x - a.x), i128::from(c.z - a.z));
    let len = dx * dx + dz * dz;
    if len == 0 {
        return apart(a, c);
    }
    let t = ((cx * dx + cz * dz) * 1_000_000 / len).clamp(0, 1_000_000);
    let near = Vec3::new(
        a.x + i64::try_from(dx * t / 1_000_000).unwrap_or(0),
        a.y,
        a.z + i64::try_from(dz * t / 1_000_000).unwrap_or(0),
    );
    apart(near, c)
}

/// A velocity along (`dx`, `dz`) at `speed` µm a second; still when the direction is none.
pub(crate) fn along(dx: i64, dz: i64, speed: i64) -> Vec3 {
    let len = isqrt(i128::from(dx).pow(2) + i128::from(dz).pow(2));
    if len == 0 || speed <= 0 {
        return Vec3::ZERO;
    }
    let v = |c: i64| i64::try_from(i128::from(c) * i128::from(speed) / len).unwrap_or(0);
    Vec3::new(v(dx), 0, v(dz))
}

pub(crate) fn go(host: &mut dyn Host, velocity: Vec3) {
    host.control(ControllerInput {
        velocity,
        mode: Mode::Surface,
    });
}

/// Every close-quarters input claims all the legs and is replaced by any other skill that claims one.
fn shape(n: &str) -> SkillShape {
    SkillShape {
        name: name(n),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: Vec::new(),
        cancelled_by: vec![Class::Locomotion],
    }
}

/// Whether an input with expiry `until` has expired: it then stands and ends, `Done`.
fn expired(host: &mut dyn Host, until: Option<Micros>) -> bool {
    if until.is_some_and(|u| host.now() >= u) {
        go(host, Vec3::ZERO);
        return true;
    }
    false
}

/// What an input is aimed at: a point in the body's parent's frame, or a node, read where it stood last tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Point(Vec3),
    Node(Id),
}

/// Where `t` is in `parent`'s frame, or none when it is gone or in another frame.
fn locate(host: &dyn Host, t: Target, parent: Option<Id>) -> Option<Vec3> {
    match t {
        Target::Point(p) => Some(p),
        Target::Node(n) => host
            .read(n)
            .filter(|s| s.parent == parent)
            .map(|s| s.position),
    }
}

// --- Step --------------------------------------------------------------------------------------------------------

/// One step: `distance` µm along (`direction.x`, `direction.z`), at walking pace, then it ends.
pub struct Step {
    pub direction: Vec3,
    pub distance: i64,
    /// Where it began, and where the body stood, when, and how far it asked to go, at its last step.
    start: Option<Vec3>,
    last: Option<(Vec3, Micros, i64)>,
}

impl Step {
    pub fn new(direction: Vec3, distance: i64) -> Step {
        Step {
            direction,
            distance,
            start: None,
            last: None,
        }
    }
}

impl Skill for Step {
    fn shape(&self) -> SkillShape {
        shape("souls:step")
    }

    fn step(&mut self, host: &mut dyn Host) -> Progress {
        let body = host.body();
        let Some(me) = host.read(body) else {
            return Progress::Failed(name("souls:body-gone"));
        };
        let (ux, uz) = (i128::from(self.direction.x), i128::from(self.direction.z));
        let len = isqrt(ux * ux + uz * uz);
        if len == 0 || self.distance <= 0 {
            return Progress::Failed(name("souls:step-no-direction"));
        }
        let start = *self.start.get_or_insert(me.position);
        let (dx, dz) = (
            i128::from(me.position.x - start.x),
            i128::from(me.position.z - start.z),
        );
        // How far along the line, and how far off it, the body stands (µm).
        let gone = i64::try_from((dx * ux + dz * uz) / len).unwrap_or(0);
        let off = i64::try_from(((dx * uz - dz * ux) / len).abs()).unwrap_or(i64::MAX);
        let now = host.now();
        let mut dt = TICK;
        if let Some((was, at, asked)) = self.last {
            dt = (now - at).max(1);
            let made = apart(was, me.position);
            if off > OFF_LINE || (asked > 0 && made * 2 < asked) {
                go(host, Vec3::ZERO);
                return Progress::Failed(name(WALLED));
            }
        }
        let left = self.distance - gone;
        if left <= THERE {
            go(host, Vec3::ZERO);
            return Progress::Done;
        }
        // At pace, or slower on the last tick so it ends on the distance.
        let speed = SPEED.min(
            i64::try_from(i128::from(left) * i128::from(MICROS_PER_SECOND) / i128::from(dt))
                .unwrap_or(SPEED),
        );
        let asked = i64::try_from(i128::from(speed) * i128::from(dt) / 1_000_000).unwrap_or(0);
        self.last = Some((me.position, now, asked));
        go(host, along(self.direction.x, self.direction.z, speed));
        Progress::Going
    }
}

// --- Circle ------------------------------------------------------------------------------------------------------

/// Which side of the body the centre is kept on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

/// Walks round `centre` at the distance it started at, the centre on `side`, until replaced, cancelled or `until`.
pub struct Circle {
    pub centre: Target,
    pub side: Side,
    pub until: Option<Micros>,
    radius: Option<i64>,
}

impl Circle {
    pub fn new(centre: Target, side: Side, until: Option<Micros>) -> Circle {
        Circle {
            centre,
            side,
            until,
            radius: None,
        }
    }
}

impl Skill for Circle {
    fn shape(&self) -> SkillShape {
        shape("souls:circle")
    }

    fn step(&mut self, host: &mut dyn Host) -> Progress {
        if expired(host, self.until) {
            return Progress::Done;
        }
        let body = host.body();
        let Some(me) = host.read(body) else {
            return Progress::Failed(name("souls:body-gone"));
        };
        let Some(c) = locate(host, self.centre, me.parent) else {
            go(host, Vec3::ZERO);
            return Progress::Going;
        };
        let (dx, dz) = (me.position.x - c.x, me.position.z - c.z);
        let r = apart(c, me.position);
        let radius = *self.radius.get_or_insert(r);
        if r == 0 {
            go(host, Vec3::ZERO);
            return Progress::Going;
        }
        // Along the circle, the centre on the side named (y up: left of a heading (fx, fz) is (fz, -fx)); and toward
        // the radius it began at, closing the gap in half a second.
        let (tx, tz) = match self.side {
            Side::Left => (dz, -dx),
            Side::Right => (-dz, dx),
        };
        let t = along(tx, tz, SPEED);
        let fix = (radius - r).clamp(-SPEED, SPEED) * 2;
        let n = along(dx, dz, fix.abs());
        let s = if fix < 0 { -1 } else { 1 };
        go(host, Vec3::new(t.x + s * n.x, 0, t.z + s * n.z));
        Progress::Going
    }
}

// --- Go near -----------------------------------------------------------------------------------------------------

/// Walks straight toward `target` until `distance` from it, then stands; until replaced, cancelled or `until`.
pub struct Near {
    pub target: Target,
    pub distance: i64,
    pub until: Option<Micros>,
}

impl Skill for Near {
    fn shape(&self) -> SkillShape {
        shape("souls:go-near")
    }

    fn step(&mut self, host: &mut dyn Host) -> Progress {
        if expired(host, self.until) {
            return Progress::Done;
        }
        let body = host.body();
        let Some(me) = host.read(body) else {
            return Progress::Failed(name("souls:body-gone"));
        };
        let Some(t) = locate(host, self.target, me.parent) else {
            go(host, Vec3::ZERO);
            return Progress::Going;
        };
        let gap = apart(me.position, t) - self.distance;
        // Slowing as it comes in, so it stops on the distance: the gap closed in half a second, at most FAST.
        let speed = if gap <= THERE { 0 } else { (gap * 2).min(FAST) };
        go(host, along(t.x - me.position.x, t.z - me.position.z, speed));
        Progress::Going
    }
}

// --- Follow ------------------------------------------------------------------------------------------------------

/// Walks `leader`'s trail, keeping the distance along it within `band` (µm, nearest and furthest); until replaced,
/// cancelled or `until`.
pub struct Follow {
    pub leader: Id,
    pub band: (i64, i64),
    pub until: Option<Micros>,
    /// The leader's trail, oldest first: the points it stood on, [`TRAIL_GAP`] apart.
    trail: Vec<Vec3>,
    /// The leader where it was last read, and when.
    seen: Option<(Vec3, Micros)>,
    /// Where the body stood at its last step, when, and the speed it asked for.
    last: Option<(Vec3, Micros, i64)>,
    stalled: u32,
    /// The point a fall-back route gave, while it walks there.
    route: Option<Vec3>,
    /// Route searches asked for: zero, or one after a fall-back.
    pub routes: u32,
    /// The width of a place beside the leader, µm (0.135 R1), instead of its trail.
    pub beside: Option<i64>,
    /// Beside: the leader where its heading was last taken, the heading (x, z), and the side (1 right, -1 left).
    heading: Option<(Vec3, Option<(i64, i64)>)>,
    side: i64,
    /// Beside: ticks in a row farther than [`LET_GO`] from its place.
    far: u32,
    /// A place at this offset from the leader on the plan (x, z), µm, instead of its trail: carrying together.
    pub at: Option<[i64; 2]>,
    /// With `at`: the leader's goal (x, z) and the offset there, µm; the place turns from `at` to it as the leader
    /// nears its goal ([`Follow::turning`]).
    pub turn: Option<([i64; 2], [i64; 2])>,
    /// Turning: the leader's distance to its goal when the follow first saw it, µm.
    first: Option<i64>,
    /// With `at`: the place at the last step, and when, for its pace.
    place: Option<(Vec3, Micros)>,
}

impl Follow {
    pub fn new(leader: Id, band: (i64, i64), until: Option<Micros>) -> Follow {
        Follow {
            leader,
            band,
            until,
            trail: Vec::new(),
            seen: None,
            last: None,
            stalled: 0,
            route: None,
            routes: 0,
            beside: None,
            heading: None,
            side: 0,
            far: 0,
            at: None,
            turn: None,
            first: None,
            place: None,
        }
    }

    /// Follows `leader` keeping a place `offset` from it on the plan (x, z, µm), until `until`: a walker in a group
    /// that moves as its leader walks, without turning (carrying together, `v2/docs/moving-group.md` rule 3).
    pub fn at(leader: Id, offset: [i64; 2], until: Option<Micros>) -> Follow {
        Follow {
            at: Some(offset),
            ..Follow::new(leader, (0, 0), until)
        }
    }

    /// As [`Follow::at`], the group turning as the leader goes: the offset is `offset` where the leader stands when the
    /// follow begins and `end` once it reaches `goal` (x, z, µm, the frame the leader is located in), between them
    /// swung about the leader by the share of the way it has walked ([`swung`]). A carry's crew whose front walks its
    /// load square into a slot, or along a way that turns it (moving-group rule 3).
    pub fn turning(
        leader: Id,
        offset: [i64; 2],
        goal: [i64; 2],
        end: [i64; 2],
        until: Option<Micros>,
    ) -> Follow {
        Follow {
            turn: Some((goal, end)),
            ..Follow::at(leader, offset, until)
        }
    }

    /// The offset of the place now, the leader at `them`: `offset`, or with a turn, swung toward its end by the share
    /// of the way to the goal walked since the first step.
    fn offset_now(&mut self, them: Vec3, offset: [i64; 2]) -> [i64; 2] {
        let Some((goal, end)) = self.turn else {
            return offset;
        };
        let left = apart(them, Vec3::new(goal[0], them.y, goal[1]));
        let first = *self.first.get_or_insert(left);
        if first == 0 {
            return end;
        }
        swung(offset, end, first - left.min(first), first)
    }

    /// One step toward the place `offset` from the leader at `them`: at the place's own pace (the leader's, or more
    /// while the place swings) plus the gap closed in a second and a half, at most that pace or a jog's, as beside.
    fn step_at(
        &mut self,
        host: &mut dyn Host,
        me: Vec3,
        them: Vec3,
        pace: i64,
        offset: [i64; 2],
    ) -> Progress {
        let offset = self.offset_now(them, offset);
        let place = Vec3::new(
            them.x.saturating_add(offset[0]),
            me.y,
            them.z.saturating_add(offset[1]),
        );
        let now = host.now();
        // The place's own pace: the leader's, and the swing's while it turns.
        let pace = match self.place.replace((place, now)) {
            Some((was, at)) if now > at && self.turn.is_some() => i64::try_from(
                i128::from(apart(was, place)) * i128::from(MICROS_PER_SECOND)
                    / i128::from(now - at),
            )
            .unwrap_or(pace)
            .max(pace),
            _ => pace,
        };
        let gap = apart(me, place);
        if self.lost(host, gap > LET_GO) {
            return Progress::Failed(name(LOST_PLACE));
        }
        let speed = if gap <= THERE && pace == 0 {
            0
        } else {
            (pace + gap * 2 / 3).clamp(0, pace.clamp(FAST, FASTEST))
        };
        go(host, along(place.x - me.x, place.z - me.z, speed));
        Progress::Going
    }

    /// Follows `leader` keeping a place `width` µm beside it (0.135 R1), until `until`.
    pub fn beside(leader: Id, width: i64, until: Option<Micros>) -> Follow {
        Follow {
            beside: Some(width),
            ..Follow::new(leader, (0, 0), until)
        }
    }

    /// The place beside the leader at `them` for the body at `me`, or none until the leader has walked: its heading
    /// is taken from each [`TRAIL_GAP`] it walks, and the side is fixed the first time.
    fn place(&mut self, me: Vec3, them: Vec3, width: i64) -> Option<Vec3> {
        let (from, _) = *self.heading.get_or_insert((them, None));
        if apart(from, them) >= TRAIL_GAP {
            let h = (them.x - from.x, them.z - from.z);
            // A heading turned back (more than 90°) takes the side again from where the follower stands, so the
            // follower keeps its own side of the leader and never crosses through it.
            let back = self.heading.and_then(|h| h.1).is_some_and(|(px, pz)| {
                i128::from(px) * i128::from(h.0) + i128::from(pz) * i128::from(h.1) < 0
            });
            if self.side == 0 || back {
                // The side the follower stands on: the sign of the heading crossed with leader to follower.
                let cross = i128::from(h.0) * i128::from(me.z - them.z)
                    - i128::from(h.1) * i128::from(me.x - them.x);
                self.side = if cross > 0 { -1 } else { 1 };
            }
            self.heading = Some((them, Some(h)));
        }
        let (hx, hz) = self.heading.and_then(|h| h.1)?;
        // (hz, -hx) is square to the heading; the side found above turns it to the follower's side.
        let side = along(hz * self.side, -hx * self.side, width);
        Some(Vec3::new(them.x + side.x, me.y, them.z + side.z))
    }

    /// One step beside the leader (0.135 R1): toward the place at the leader's pace plus the gap closed in a second
    /// and a half, at most the leader's gait.
    fn step_beside(
        &mut self,
        host: &mut dyn Host,
        me: Vec3,
        them: Vec3,
        pace: i64,
        width: i64,
    ) -> Progress {
        let Some(place) = self.place(me, them, width) else {
            go(host, Vec3::ZERO);
            return Progress::Going;
        };
        let gap = apart(me, place);
        if self.lost(host, gap > LET_GO) {
            return Progress::Failed(name(LOST_PLACE));
        }
        let speed = if gap <= THERE && pace == 0 {
            0
        } else {
            (pace + gap * 2 / 3).clamp(0, pace.clamp(FAST, FASTEST))
        };
        // Never through the leader's body: a way to the place that passes nearer its middle than [`KEEP_APART`]
        // goes round it instead, by a point on the circle of the place's width halfway to the place.
        let aim = if passes(me, place, them) < KEEP_APART {
            let to = |p: Vec3| along(p.x - them.x, p.z - them.z, width);
            let (u, w) = (to(me), to(place));
            let mid = if u.x + w.x == 0 && u.z + w.z == 0 {
                along(u.z, -u.x, width)
            } else {
                along(u.x + w.x, u.z + w.z, width)
            };
            Vec3::new(them.x + mid.x, me.y, them.z + mid.z)
        } else {
            place
        };
        go(host, along(aim.x - me.x, aim.z - me.z, speed));
        Progress::Going
    }

    /// Beside (0.135 R1): counts a tick in which the follower is not keeping its place (`off`: too far from it, or
    /// its leader unseen); true, standing still, once it has been off for [`LET_GO_TICKS`] in a row.
    fn lost(&mut self, host: &mut dyn Host, off: bool) -> bool {
        self.far = if off { self.far + 1 } else { 0 };
        if self.far >= LET_GO_TICKS {
            go(host, Vec3::ZERO);
            return true;
        }
        false
    }

    /// The distance along the trail from `me` to the leader at `them`, µm.
    fn behind(&self, me: Vec3, them: Vec3) -> i64 {
        let mut d = 0;
        let mut at = me;
        for p in self.trail.iter().chain(std::iter::once(&them)) {
            d += apart(at, *p);
            at = *p;
        }
        d
    }

    /// One route toward the leader (N5, through the host), said in an event: the follow's one fall-back.
    fn fall_back(&mut self, host: &mut dyn Host, body: Id, them: Vec3) {
        self.routes += 1;
        if let Some(Answer::Point(p)) = host.ask(&Ask::Toward {
            from: body,
            to: them,
        }) {
            self.route = Some(p);
        }
        // The trail it could not walk is dropped; a new one starts from where the leader stands now.
        self.trail.clear();
        let event = Event {
            name: name(FELL_BACK),
            fields: BTreeMap::new(),
            changes: Vec::new(),
            rest: BTreeMap::new(),
        };
        // An event with no changes touches nothing outside the body, so the host has no reason to refuse it.
        let _ = host.emit(Vec::new(), Some(event));
    }
}

impl Skill for Follow {
    fn shape(&self) -> SkillShape {
        shape("souls:follow")
    }

    fn step(&mut self, host: &mut dyn Host) -> Progress {
        if expired(host, self.until) {
            return Progress::Done;
        }
        let body = host.body();
        let Some(me) = host.read(body) else {
            return Progress::Failed(name("souls:body-gone"));
        };
        let (me, parent) = (me.position, me.parent);
        let now = host.now();
        let Some(them) = locate(host, Target::Node(self.leader), parent) else {
            go(host, Vec3::ZERO);
            // Beside (0.135 R1): a leader gone from sight (through a door, onto a deck) is a place not kept.
            if (self.beside.is_some() || self.at.is_some()) && self.lost(host, true) {
                return Progress::Failed(name(LOST_PLACE));
            }
            return Progress::Going;
        };
        // The leader's pace, from where it was read last.
        let pace = match self.seen {
            Some((was, at)) if now > at => i64::try_from(
                i128::from(apart(was, them)) * i128::from(MICROS_PER_SECOND) / i128::from(now - at),
            )
            .unwrap_or(0),
            _ => 0,
        };
        self.seen = Some((them, now));
        if let Some(offset) = self.at {
            return self.step_at(host, me, them, pace, offset);
        }
        if let Some(width) = self.beside {
            return self.step_beside(host, me, them, pace, width);
        }
        if self
            .trail
            .last()
            .is_none_or(|p| apart(*p, them) >= TRAIL_GAP)
        {
            if self.trail.len() >= TRAIL_MOST {
                self.trail.remove(0);
            }
            self.trail.push(them);
        }
        while self.trail.len() > 1 && apart(me, self.trail[0]) < REACHED {
            self.trail.remove(0);
        }
        // Made way? Less than a quarter of what it asked for, STALL ticks running, is a trail it cannot walk.
        if let Some((was, at, speed)) = self.last
            && speed > 0
            && now > at
        {
            let asked = i128::from(speed) * i128::from(now - at) / i128::from(MICROS_PER_SECOND);
            if i128::from(apart(was, me)) * 4 < asked {
                self.stalled += 1;
            } else {
                self.stalled = 0;
            }
        }
        if self.stalled >= STALL && self.routes == 0 {
            self.stalled = 0;
            self.fall_back(host, body, them);
        }
        if self.route.is_some_and(|p| apart(me, p) < REACHED) {
            self.route = None;
        }
        let behind = self.behind(me, them);
        let (near, far) = self.band;
        let mid = (near + far) / 2;
        // The leader's pace, plus the gap to the band's middle closed in a second and a half; at most the leader's
        // gait (its pace, to the fastest gait), and never under FAST while it closes (0.135 G2: the leader's gait).
        let speed = if behind <= near {
            0
        } else {
            (pace + (behind - mid) * 2 / 3).clamp(0, pace.clamp(FAST, FASTEST))
        };
        let aim = self
            .route
            .or_else(|| self.trail.first().copied())
            .unwrap_or(them);
        self.last = Some((me, now, speed));
        go(host, along(aim.x - me.x, aim.z - me.z, speed));
        Progress::Going
    }
}
