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
//!   other than the body is read as of the previous tick, T1), keeping the distance along the trail inside the band.
//!   The leader walked it, so it is legal ground, and the follower does not aim at the leader through a wall. When the
//!   follower stops making way on the trail (it lacks an ability the trail needs), it asks for one route toward the
//!   leader (N5, through the host's `Toward`), walks to the point it is given, says so in an event
//!   ([`FELL_BACK`]), and goes back to the trail. Once per follow.
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

/// The ground distance (x and z) from `a` to `b`, µm.
fn apart(a: Vec3, b: Vec3) -> i64 {
    let (dx, dz) = (i128::from(b.x - a.x), i128::from(b.z - a.z));
    i64::try_from(isqrt(dx * dx + dz * dz)).unwrap_or(i64::MAX)
}

/// A velocity along (`dx`, `dz`) at `speed` µm a second; still when the direction is none.
fn along(dx: i64, dz: i64, speed: i64) -> Vec3 {
    let len = isqrt(i128::from(dx).pow(2) + i128::from(dz).pow(2));
    if len == 0 || speed <= 0 {
        return Vec3::ZERO;
    }
    let v = |c: i64| i64::try_from(i128::from(c) * i128::from(speed) / len).unwrap_or(0);
    Vec3::new(v(dx), 0, v(dz))
}

fn go(host: &mut dyn Host, velocity: Vec3) {
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
        }
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
        // The leader's pace, plus the gap to the band's middle closed in a second and a half.
        let speed = if behind <= near {
            0
        } else {
            (pace + (behind - mid) * 2 / 3).clamp(0, FAST)
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
