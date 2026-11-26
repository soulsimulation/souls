//! N7's walk as a skill (Engine v2 N7 #2655, moved behind the host by T9b #3120): it walks a body along its route's
//! legs, keeping apart from the bodies near it, waiting its turn at a narrow link and crossing each link by asking the
//! world to carry it. It touches the world through `Host` alone, so it runs on any family with locomotion.
//!
//! - **A tick.** Aim at the next corner toward the leg's end (`Ask::Toward`), add a push away from every body within
//!   [`RANGE`] ahead of it, or beside or behind it within two spaces (`Ask::Near`: ids, positions and velocities as of
//!   the last tick; a body a [`LEVEL`] above or below, or one [`STANDING`], is left out), leaning right when one comes
//!   head-on, and hand the velocity on (`Host::control`). The push is resolved on the walker's own axes: forward, never
//!   below a tenth of free speed, and sideways; the sum never exceeds free speed.
//! - **Its own space** (#4215). Under the push, a hard guard: over a tick a walker closes on each body near it by at
//!   most half the gap beyond two radii ([`ROOM`] each), and not at all when already inside; the other keeps its own
//!   half, so no step ends inside another body's space. A step the guard holds is a wait, never a jump. Under the
//!   ladder's shoulder turn a body at rest is no longer guarded (E16), so one standing in the only way never walls a
//!   walker in.
//! - **A way round** (A2-2). Held [`DETOUR_AFTER`] ticks by a body standing ahead (seen at rest [`STANDING`] ticks),
//!   it walks first to a point beside that body, or sideways past the end of a row of them, that a straight walk
//!   reaches clear of every body; hemmed in, it steps back and looks again from there. A standing body never pushes it
//!   and never makes it yield. Held a step short of a link's near end (within [`NEAR_LINK`]), it asks to cross from
//!   there; it never stops as near as a crowd allows within [`MOUTH`] of where it landed from a link.
//! - **Crossing.** At a link's near end it asks the world to carry it (`Host::cross`); a shut door is opened for it by
//!   the world. While carried its body shows [`F_CROSSING`]; once that is gone, the next leg starts.
//! - **Turns at a narrow place** (N8, T9b A3). The link reads [`F_TURNS`] when it is taken in turns, and
//!   [`F_GRANTED`] names the body its owner lets in. Without leave the walker marks itself waiting, [`F_WAITING`] on
//!   its own body (`[link, distance µm]`), within [`MARK`] of the near end, and stands within [`QUEUE`] of it or
//!   behind a body waiting for the same link within [`BEHIND`] and nearer. Those waiting push only each other. A
//!   standing waiter steps aside, square to the line between them, for a walker let into a narrow place near it (for
//!   its own link, one farther from the end) and for a walker not waiting that touches it, so a queue never stands in
//!   a mouth or walls a walker in. A walker without leave inside [`KEEP`] of the near end steps back out of it. A wide
//!   link whose mouth is crowded ([`CROWD`] within [`CROWD_AT`]) is marked waiting for too, and taken in turns while
//!   anyone waits for it (0.133 A2-4).
//! - **As near as the crowd allows.** Held near its goal (within [`CROWDED`]) by a body at rest nearer it, the walk is
//!   done short of it and says so: [`F_SHORT`] on its body, which the world names in the walk's `done` (A2-4). A walk
//!   to its own granted spot (N9) ends short only when a body at rest stands on that spot (within two radii of it), or
//!   once held so [`CROWD_TICKS`] ticks in all: a way round and the world's ladder have had their turn first.
//! - **Along an edge.** The mover slides the part of a step past the ground's edge along it. A step that left the body
//!   where it was is tried next tick turned by 45 and then 70 degrees, either way (N7 tried them in the same tick on a
//!   copy; through the host the skill sees each result a tick later, T1). For [`SLID`] ticks after the mover slid it,
//!   the part of its step along that edge keeps within the guard's bounds too (#4215, A2-2).
//! - **N10's ladder** (T9c #3127) reaches the walk by fields the world sets on its body: [`F_SHOULDER`] (no body
//!   pushes it, and it squeezes past one at rest), [`F_ROUTE`] (a new route, walked from its first leg) and [`F_HELD`] (the world walks it out to legal
//!   ground: it stands and clears its mark). Ending the walk by name is the world's: the run is ended. A route taken,
//!   the walk leaves its count alone in [`F_ROUTE`] (`[count, []]`), so a read of the body copies no legs.
//! - **Sent to a point** (N9, [`Route::sent`]). The world's spot tables grant the walker a standing spot near the
//!   point and the world gives the route there as [`F_ROUTE`]; until then it stands. It arrives within [`AT_SPOT`] of
//!   its spot, no body pushes it within [`CALM`] of it, and those standing on their own spots ([`F_SETTLED`]) do not
//!   push it: it passes between them.
//!
//! Integers only: µm, µm a second, µs.

use replica::bodies::{Class, SkillShape, Want};
use replica::effects::{Change, read_id};
use replica::encode::{Name, Value};
use replica::host::{
    Answer, Ask, F_CROSSING, F_GRANTED, F_HELD, F_ROUTE, F_SETTLED, F_SHORT, F_SHOULDER, F_TURNS,
    F_WAITING, Host, Near, Progress, Skill,
};
use replica::ids::Id;
use replica::pose::{ControllerInput, Mode, Vec3};
use replica::time::Micros;

/// How far a body pushes, µm: from [`GAIN`] times the walker's free speed at no distance to nothing at this one.
pub const RANGE: i64 = 1_200_000;
/// A body's push at no distance, in free speeds.
pub const GAIN: i64 = 2;
/// The lean to the right when a body comes head-on, as a share of its push: `LEAN / 4`.
pub const LEAN: i64 = 2;
/// A leg's end is reached within this, µm: a link's near end.
pub const AT_LINK: i64 = 50_000;
/// A walk's goal is reached within this, µm.
pub const AT_GOAL: i64 = 300_000;
/// A walker without leave marks itself waiting for a narrow link within this of its near end, µm.
pub const MARK: i64 = 3_000_000;
/// A walker without leave stands within this of a narrow link's near end, µm.
pub const QUEUE: i64 = 1_200_000;
/// A walker held this near a link's near end, µm, asks to cross from where it stands (the carry's straight start is
/// this short).
pub const NEAR_LINK: i64 = 200_000;
/// A walker this near where it landed from a link, µm, is in the doorway's mouth: it does not stop there.
pub const MOUTH: i64 = 1_200_000;
/// A wide link's mouth is crowded with this many bodies within [`CROWD_AT`] of its near end (A2-4).
pub const CROWD: usize = 3;
/// How near a wide link's near end the bodies crowding its mouth stand, µm.
pub const CROWD_AT: i64 = 1_500_000;
/// A walker without leave keeps this far from a narrow link's near end, µm: its mouth is for the walker let in.
pub const KEEP: i64 = 400_000;
/// A walker without leave stands behind a waiting body for the same link this near and nearer the end, µm.
pub const BEHIND: i64 = 700_000;
/// A granted standing spot is reached within this, µm (N9).
pub const AT_SPOT: i64 = 50_000;
/// Within this of its granted standing spot, µm, no body pushes a walker (N9).
pub const CALM: i64 = 1_000_000;
/// A body's own space, µm: its personal radius, until the body def carries one (#4215). No step ends within two of
/// them (and [`SLACK`]) of another body, closer than it began.
pub const ROOM: i64 = 150_000;
/// Kept on top of two radii, µm: for the mover's rounding and for the part of a step it slides along a ground edge,
/// which the guard does not see (#4215).
pub const SLACK: i64 = 15_000;
/// A walker whose step the guard cut to under a quarter for this many ticks in a row yields (#4215).
pub const HOLD: u32 = 10;
/// A walker held this near its goal, µm, by a body at rest nearer the goal has arrived: the crowd there is as
/// near as it gets (#4215).
pub const CROWDED: i64 = 3_000_000;
/// A walk to its own granted spot (N9) held near it this many ticks in all, its spot not taken, ends as near as the
/// crowd allows: past a way round's ticks, [`DETOUR_AFTER`] and [`DETOUR_TICKS`] (0.133 A2-4).
pub const CROWD_TICKS: u32 = DETOUR_AFTER + DETOUR_TICKS;
/// A body this much above or below a walker, µm, stands on another level: it neither pushes nor holds it (#4215).
pub const LEVEL: i64 = 1_000_000;
/// A walker held this many ticks in a row by a body at rest ahead looks for a way round it (A2-2).
pub const DETOUR_AFTER: u32 = 6;
/// A body seen at rest this many ticks in a row is standing, not held for a moment.
pub const STANDING: u32 = 10;
/// The most ticks a walker keeps to a way round before it aims at its leg's end again.
pub const DETOUR_TICKS: u32 = 60;
/// A way round's point is reached within this, µm.
pub const AT_DETOUR: i64 = 100_000;
/// How far beyond two radii a way round passes a body at rest, µm.
pub const PASS: i64 = 100_000;
/// A walker the mover slid along a ground edge is taken to walk along it this many ticks.
pub const SLID: u32 = 10;
/// A yielding walker stands this many ticks while the lower id holding it is near.
pub const BACK: u32 = 10;

/// The turns a stalled step is tried at, in order: none, then 45 degrees either way, then 70 either way (cosine and
/// sine in thousandths).
const TURNS: [(i64, i64); 5] = [(1000, 0), (707, 707), (707, -707), (342, 940), (342, -940)];

/// One leg of a walk: walk to `to` (µm, the frame of the node the body stands on), then cross `link`, or arrive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leg {
    pub to: Vec3,
    pub link: Option<Id>,
}

/// Where a crossing stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Crossing {
    /// Asked for; not carried yet (the request is staged, or a door is being opened).
    Asked,
    /// Seen carried.
    Carried,
}

/// N7's walk along `legs` (planned by the world for the intent), at free speed `speed`, ticks of `tick`.
pub struct Route {
    pub legs: Vec<Leg>,
    pub speed: i64,
    pub tick: Micros,
    /// The leg walked now.
    pub leg: usize,
    /// The count of the last route the world gave it ([`F_ROUTE`]); 0 for the legs it started with.
    route: u64,
    /// Sent to a point (N9): its route, once given, ends at its own standing spot.
    spot: bool,
    crossing: Option<Crossing>,
    /// The mark last set on the body.
    waiting: Option<(Id, i64)>,
    /// Last tick's position, guarded step and turn tried, for a step the mover cut at an edge.
    last: Option<(Vec3, [i64; 2], usize)>,
    /// Its personal radius, µm (#4215).
    pub room: i64,
    /// Ticks into the window its progress is judged over, and where the window began.
    held: u32,
    window: Option<Vec3>,
    /// Yielding: the body it stands for and the ticks left.
    yielding: Option<(Id, u32)>,
    /// Standing aside while waiting: where it stood last tick and the side it steps to.
    aside: Option<(Vec3, i64)>,
    /// Ticks in a row a body at rest ahead has held it.
    blocked: u32,
    /// A way round a body at rest ahead (A2-2): the point it walks to first, the leg it was found on, ticks left.
    detour: Option<(Vec3, usize, u32)>,
    /// The bodies near and how many ticks in a row each has been seen at rest.
    resting: Vec<(Id, u32)>,
    /// A body it stepped back from, to find a way round once back.
    retry: Option<Vec3>,
    /// The line of the ground edge it slid along lately, and the ticks it is still taken to be there.
    slide: Option<([i64; 2], u32)>,
    /// The guard cut its last step to under half.
    short: bool,
    /// Where it last landed from a link.
    landed: Option<Vec3>,
    /// Ticks in all, on this route, a walk to its own spot was held near it by the crowd (A2-4).
    crowd: u32,
    /// How near its last leg's end the walk is done, µm: [`AT_GOAL`], or [`AT_SPOT`] for a form's walk right before a
    /// move, which ends on the stand point its move is reached from, not up to [`AT_GOAL`] short of it on the side
    /// it came from (0.135 E20). Held by the guard within [`AT_GOAL`] of its goal for [`HOLD`] ticks (a body standing
    /// by the stand point), it ends short there ([`F_SHORT`]). A walk to a granted spot ends within [`AT_SPOT`]
    /// whatever this says.
    pub arrive: i64,
}

impl Route {
    pub fn new(legs: Vec<Leg>, speed: i64, tick: Micros) -> Route {
        Route {
            legs,
            speed,
            tick,
            leg: 0,
            route: 0,
            spot: false,
            crossing: None,
            waiting: None,
            last: None,
            room: ROOM,
            held: 0,
            window: None,
            yielding: None,
            aside: None,
            blocked: 0,
            detour: None,
            resting: Vec::new(),
            retry: None,
            slide: None,
            short: false,
            landed: None,
            crowd: 0,
            arrive: AT_GOAL,
        }
    }

    /// A walk sent to a point (N9): it stands until the world gives it the route to its granted spot.
    pub fn sent(speed: i64, tick: Micros) -> Route {
        Route {
            spot: true,
            ..Route::new(Vec::new(), speed, tick)
        }
    }
}

fn name(t: &str) -> Name {
    Name::new(t).unwrap_or_else(|| unreachable!("a fixed name"))
}

fn len(v: [i64; 2]) -> i64 {
    let (x, z) = (i128::from(v[0]), i128::from(v[1]));
    i64::try_from((x * x + z * z).isqrt()).unwrap_or(i64::MAX)
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

/// A route the world gave the body ([`F_ROUTE`]) after route `taken`: its count and legs.
fn route_of(route: Option<Value>, taken: u64) -> Option<(u64, Vec<Leg>)> {
    let Value::Array(a) = route? else {
        return None;
    };
    let [Value::Uint(n), Value::Array(legs)] = a.as_slice() else {
        return None;
    };
    if *n <= taken {
        return None;
    }
    let mut out = Vec::new();
    for l in legs {
        let Value::Array(l) = l else { return None };
        let (to, link) = l.split_at_checked(3)?;
        let [x, y, z] = to else { return None };
        let link = match link {
            [] => None,
            [k] => Some(read_id(k).ok()?),
            _ => return None,
        };
        out.push(Leg {
            to: Vec3::new(read_int(x)?, read_int(y)?, read_int(z)?),
            link,
        });
    }
    Some((*n, out))
}

/// A body's waiting mark, `[link, distance]`, or none.
fn mark_of(host: &dyn Host, body: Id) -> Option<(Id, i64)> {
    let Value::Array(a) = host.field(body, F_WAITING)? else {
        return None;
    };
    let [l, g] = a.as_slice() else { return None };
    Some((read_id(l).ok()?, read_int(g)?))
}

/// The velocity a walker at `p` wants toward `aim`: free speed (less when the aim is nearer than a tick), pushed by
/// the bodies `near` (each with its distance), resolved on its own axes.
fn wanted(
    me: Id,
    p: [i64; 2],
    aim: [i64; 2],
    speed: i64,
    dt: Micros,
    near: &[(Near, i64)],
    lane: i64,
) -> [i64; 2] {
    let d = [i128::from(aim[0] - p[0]), i128::from(aim[1] - p[1])];
    let l = (d[0] * d[0] + d[1] * d[1]).isqrt();
    if l == 0 {
        return [0, 0];
    }
    let speed = i128::from(speed);
    let s = speed.min(l * 1_000_000 / i128::from(dt.max(1)));
    let r = [-d[1], d[0]];
    let (mut f, mut g) = (s, 0i128);
    for (n, dist) in near {
        let o = [
            i128::from(p[0] - n.position.x),
            i128::from(p[1] - n.position.z),
        ];
        let push = speed * i128::from(GAIN) * i128::from(RANGE - dist) / i128::from(RANGE);
        if *dist == 0 {
            // At one point: apart by id, the lower id to its right.
            g += if me < n.id { push } else { -push };
            continue;
        }
        let dist = i128::from(*dist);
        f += push * (o[0] * d[0] + o[1] * d[1]) / (dist * l);
        g += push * (o[0] * r[0] + o[1] * r[1]) / (dist * l);
        let ahead = o[0] * d[0] + o[1] * d[1] < 0;
        let toward = i128::from(n.velocity.x) * d[0] + i128::from(n.velocity.z) * d[1] < 0;
        if ahead && toward {
            g += push * i128::from(LEAN) / 4;
        } else if ahead && (o[0] * r[0] + o[1] * r[1]).abs() < i128::from(lane) * l {
            // A body ahead in its lane, not coming at it (standing, or going its way): it steps aside, on the side
            // it is already on, the lower id to its right when exactly behind (#4215).
            let side = o[0] * r[0] + o[1] * r[1];
            let right = side > 0 || (side == 0 && me < n.id);
            let lean = push * i128::from(LEAN) / 4;
            g += if right { lean } else { -lean };
        }
    }
    let floor = (speed / 10).min(s);
    let side = (s * s - floor * floor).isqrt();
    let g = g.clamp(-side, side);
    let f = f.clamp(floor, (s * s - g * g).isqrt().max(floor));
    let fit = |v: i128| i64::try_from(v).unwrap_or(0);
    [
        fit((f * d[0] + g * r[0]) / l),
        fit((f * d[1] + g * r[1]) / l),
    ]
}

/// `v` turned by `(cos, sin)` (thousandths) and shortened by the cosine.
fn turned(v: [i64; 2], (c, s): (i64, i64)) -> [i64; 2] {
    let r = [(v[0] * c - v[1] * s) / 1000, (v[0] * s + v[1] * c) / 1000];
    [r[0] * c / 1000, r[1] * c / 1000]
}

/// The velocity `v` of a walker at `p`, cut so that over a tick of `dt` it closes on each body `near` (as of the last
/// tick) by at most half the gap beyond `room` (two radii and slack), and not at all when inside it (#4215). The
/// other body keeps its own half from the same snapshot, so no pair ends a tick nearer than `room` that was not; one
/// already inside never gets nearer. Each cut takes only the excess toward that body (a slide, its side step kept);
/// a velocity still over a bound after three passes is a wait.
fn guard(
    p: [i64; 2],
    v: [i64; 2],
    dt: Micros,
    near: &[Near],
    room: i64,
    slide: Option<[i64; 2]>,
) -> [i64; 2] {
    let dt = i128::from(dt.max(1));
    let bounds: Vec<([i128; 2], i128, i128)> = near
        .iter()
        .filter_map(|n| {
            let u = [
                i128::from(n.position.x - p[0]),
                i128::from(n.position.z - p[1]),
            ];
            let gap = (u[0] * u[0] + u[1] * u[1]).isqrt();
            // At one point there is no way toward it: any step is apart.
            (gap > 0).then(|| (u, gap, (gap - i128::from(room)).max(0) / 2 * 1_000_000 / dt))
        })
        .collect();
    let mut v = [i128::from(v[0]), i128::from(v[1])];
    let over = |v: [i128; 2], (u, gap, most): &([i128; 2], i128, i128)| {
        v[0] * u[0] + v[1] * u[1] - most * gap
    };
    for _ in 0..3 {
        let mut cut = false;
        for b in &bounds {
            let e = over(v, b);
            if e > 0 {
                // Less e / gap² of u, rounded up: the speed toward it falls to its bound.
                let g2 = b.1 * b.1;
                v = [
                    v[0] - (e * b.0[0]).div_euclid(g2) - b.0[0].signum(),
                    v[1] - (e * b.0[1]).div_euclid(g2) - b.0[1].signum(),
                ];
                cut = true;
            }
        }
        if !cut {
            break;
        }
    }
    if bounds.iter().any(|b| over(v, b) > 0) {
        return [0, 0];
    }
    // Along an edge the mover slides the part of a step past it along the edge (its line `slide`): that part keeps
    // within each bound too, so any mix of the two does (#4215, A2-2). The step keeps `keep` millionths of itself.
    if let Some(t) = slide.map(|t| [i128::from(t[0]), i128::from(t[1])]) {
        let tl = (t[0] * t[0] + t[1] * t[1]).isqrt().max(1);
        let along = (v[0] * t[0] + v[1] * t[1]) / tl;
        let mut keep = 1_000_000i128;
        for (u, gap, most) in &bounds {
            // Its speed toward the body, times the gap, and the most it may be.
            let toward = along * ((t[0] * u[0] + t[1] * u[1]) / tl);
            let may = most * gap;
            if toward > may {
                keep = keep.min(may * 1_000_000 / toward);
            }
        }
        v = [v[0] * keep / 1_000_000, v[1] * keep / 1_000_000];
    }
    let fit = |v: i128| i64::try_from(v).unwrap_or(0);
    [fit(v[0]), fit(v[1])]
}

fn walk(host: &mut dyn Host, v: [i64; 2]) {
    host.control(ControllerInput {
        velocity: Vec3::new(v[0], 0, v[1]),
        mode: Mode::Surface,
    });
}

impl Route {
    /// Sets the body's waiting mark when it changes (an entry of its own node).
    fn mark(&mut self, host: &mut dyn Host, body: Id, m: Option<(Id, i64)>) {
        if m == self.waiting {
            return;
        }
        let to = match m {
            Some((l, g)) => Value::Array(vec![l.to_value(), int(g)]),
            None => Value::Array(Vec::new()),
        };
        let set = vec![Change::Set {
            node: body,
            field: F_WAITING,
            to,
            by: None,
        }];
        if host.emit(set, None).is_ok() {
            self.waiting = m;
        }
    }
}

impl Skill for Route {
    fn shape(&self) -> SkillShape {
        SkillShape {
            name: name("souls:walk"),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: Vec::new(),
            cancelled_by: vec![Class::Locomotion],
        }
    }

    /// The walk never draws and never sets a timer: the world may step it beside others (N17b, #3255).
    fn beside(&mut self) -> Option<&mut (dyn Skill + Send)> {
        Some(self)
    }

    fn step(&mut self, host: &mut dyn Host) -> Progress {
        let body = host.body();
        // Its own body field by field, not a whole read: a read copies every field each tick.
        let Some(p) = host.position(body) else {
            return Progress::Failed(name("souls:body-gone"));
        };
        // A new route from the world (N10's reroute): walked from its first leg.
        if let Some((n, legs)) = route_of(host.field(body, F_ROUTE), self.route) {
            (self.route, self.legs, self.leg) = (n, legs, 0);
            (self.crossing, self.last, self.crowd) = (None, None, 0);
            // Taken: the legs are the walk's own now. The field keeps the count alone, so a read of this body (each
            // walker near it reads it every tick) does not copy the legs (#3213).
            let taken = Value::Array(vec![Value::Uint(n), Value::Array(Vec::new())]);
            let _ = host.emit(
                vec![Change::Set {
                    node: body,
                    field: F_ROUTE,
                    to: taken,
                    by: None,
                }],
                None,
            );
        }
        // Held while the world walks it out: it stands, unmarked.
        if host.field(body, F_HELD).is_some() {
            self.mark(host, body, None);
            return Progress::Going;
        }
        let shoulder = host.field(body, F_SHOULDER).is_some();
        let Some(leg) = self.legs.get(self.leg).copied() else {
            // Sent to a point: it stands until its route is given.
            if self.spot && self.route == 0 {
                walk(host, [0, 0]);
                return Progress::Going;
            }
            return Progress::Done;
        };
        // A crossing: carried until the world stands it on the far side.
        if let Some(c) = self.crossing {
            let carried = host.field(body, F_CROSSING).is_some();
            match (c, carried) {
                (_, true) => {
                    self.crossing = Some(Crossing::Carried);
                    return Progress::Going;
                }
                (Crossing::Carried, false) => {
                    self.crossing = None;
                    self.last = None;
                    self.leg += 1;
                    self.landed = Some(p);
                    return Progress::Going;
                }
                (Crossing::Asked, false) => {
                    if let Some(link) = leg.link {
                        host.cross(link, self.speed);
                    }
                    return Progress::Going;
                }
            }
        }
        // A point on the way (a leg with no link that is not the last, E10 #2781) is passed without stopping.
        let mut leg = leg;
        while leg.link.is_none()
            && self.leg + 1 < self.legs.len()
            && len([leg.to.x - p.x, leg.to.z - p.z]) <= AT_GOAL
        {
            self.leg += 1;
            leg = self.legs[self.leg];
        }
        let gap = len([leg.to.x - p.x, leg.to.z - p.z]);
        // Leave to enter: the link's owner names who it lets in (A3).
        let (narrow, granted) = match leg.link.and_then(|l| host.read(l)) {
            Some(s) if s.fields.contains_key(&F_TURNS) => (
                true,
                s.fields.get(&F_GRANTED).and_then(|v| read_id(v).ok()) == Some(body),
            ),
            _ => (false, false),
        };
        let wait = narrow && !granted;
        // A body a level above or below (on a stair over it) is not in its way (#4215).
        let near: Vec<Near> = match host.ask(&Ask::Near { radius: RANGE }) {
            Some(Answer::Near(n)) => n
                .into_iter()
                .filter(|n| (n.position.y - p.y).abs() < LEVEL)
                .collect(),
            _ => Vec::new(),
        };
        // A wide link whose mouth is crowded is taken in turns too (A2-4): the walker marks itself waiting for it, and
        // from the next tick its owner keeps its turns.
        let crowded = leg.link.is_some()
            && !narrow
            && gap <= MARK
            && near
                .iter()
                .filter(|n| len([n.position.x - leg.to.x, n.position.z - leg.to.z]) <= CROWD_AT)
                .count()
                >= CROWD;
        let mark = match leg.link {
            Some(l) if (narrow || crowded) && gap <= MARK => Some((l, gap)),
            _ => None,
        };
        let dist = |n: &Near| len([p.x - n.position.x, p.z - n.position.z]);
        if wait {
            self.mark(host, body, mark);
            let behind = near
                .iter()
                .filter(|n| dist(n) < BEHIND)
                .any(|n| mark_of(host, n.id).is_some_and(|(l, g)| Some(l) == leg.link && g < gap));
            if gap < KEEP && gap > 0 {
                // In the mouth without leave (a grant it lost, or a push): it steps back out of it, so the walker
                // let in next reaches the end (N8's keep-clear, A2-2).
                let o = [p.x - leg.to.x, p.z - leg.to.z];
                let half = self.speed / 2;
                let want = [o[0] * half / gap, o[1] * half / gap];
                let step = guard(
                    [p.x, p.z],
                    want,
                    self.tick,
                    &near,
                    2 * self.room + SLACK,
                    None,
                );
                walk(host, step);
                return Progress::Going;
            }
            if gap <= QUEUE || (gap <= MARK && behind) {
                // A walker let into its own narrow place close by: it stands aside, square to the line between
                // them, so it never stands in the mouth that walker goes to (#4215, N8).
                let reach = 2 * (2 * self.room + SLACK);
                // For its own link, only one farther from the end than itself: one nearer it is not held by it.
                // A walker not waiting that it touches (within two spaces and two steps): it stands aside from that
                // one too, so a queue never walls a walker in (#4215).
                let touch = 2 * self.room + SLACK + 2 * self.speed * self.tick / 1_000_000;
                let by =
                    near.iter()
                        .filter(|n| dist(n) <= reach)
                        .find(|n| match mark_of(host, n.id) {
                            Some((l, g)) => {
                                (Some(l) != leg.link || g > gap)
                                    && host.read(l).and_then(|s| {
                                        s.fields.get(&F_GRANTED).and_then(|v| read_id(v).ok())
                                    }) == Some(n.id)
                            }
                            None => dist(n) <= touch,
                        });
                let Some(n) = by else {
                    self.aside = None;
                    walk(host, [0, 0]);
                    return Progress::Going;
                };
                let o = [p.x - n.position.x, p.z - n.position.z];
                let o = if o == [0, 0] {
                    if body < n.id { [1, 0] } else { [-1, 0] }
                } else {
                    o
                };
                // The side kept while it moves; turned over when the last step left it where it was (an edge).
                let side = match self.aside {
                    Some((q, s)) if q == p => -s,
                    Some((_, s)) => s,
                    None => {
                        if body < n.id {
                            1
                        } else {
                            -1
                        }
                    }
                };
                let l = len(o).max(1);
                let half = self.speed / 2;
                let want = [-o[1] * side * half / l, o[0] * side * half / l];
                let step = guard(
                    [p.x, p.z],
                    want,
                    self.tick,
                    &near,
                    2 * self.room + SLACK,
                    None,
                );
                self.aside = Some((p, side));
                walk(host, step);
                return Progress::Going;
            }
        }
        match leg.link {
            // Held a step short of the end by a body standing by the mouth: it asks from there (A2-2).
            Some(link) if (gap <= AT_LINK || (gap <= NEAR_LINK && self.short)) && !wait => {
                self.mark(host, body, None);
                walk(host, [0, 0]);
                host.cross(link, self.speed);
                self.crossing = Some(Crossing::Asked);
                return Progress::Going;
            }
            None if gap <= if self.spot { AT_SPOT } else { self.arrive } => {
                walk(host, [0, 0]);
                return Progress::Done;
            }
            _ => {}
        }
        if !wait {
            self.mark(host, body, mark);
        }
        // On a way round a body at rest (A2-2): its point, checked straight when it was found, until reached.
        let detour = match self.detour {
            Some((s, l, left))
                if l == self.leg && left > 0 && len([s.x - p.x, s.z - p.z]) > AT_DETOUR =>
            {
                self.detour = Some((s, l, left - 1));
                Some(s)
            }
            _ => {
                self.detour = None;
                None
            }
        };
        let aim = match detour {
            Some(s) => s,
            None => {
                let Some(Answer::Point(aim)) = host.ask(&Ask::Toward {
                    from: body,
                    to: leg.to,
                }) else {
                    return Progress::Failed(name("souls:no-way"));
                };
                aim
            }
        };
        // Those waiting at a narrow place make way: they push only others waiting. The shoulder turn, or the last
        // stretch to its own standing spot (N9): no body pushes it. Those standing on their own spots stand apart
        // already: a walker to its spot passes between them.
        let calm = self.spot && leg.link.is_none() && gap <= CALM;
        let mut pushers: Vec<(Near, i64)> = Vec::new();
        if !shoulder && !calm {
            for n in &near {
                let settled = self.spot && host.field(n.id, F_SETTLED).is_some();
                // A body ahead pushes; one beside or behind only when within two spaces: from farther it would
                // press the walker into an edge (#4215).
                let ahead =
                    (n.position.x - p.x) * (aim.x - p.x) + (n.position.z - p.z) * (aim.z - p.z) > 0;
                // A body standing does not push: the guard keeps its space and a way round passes it (A2-2).
                let standing = self
                    .resting
                    .iter()
                    .any(|(i, k)| *i == n.id && *k >= STANDING);
                if (ahead || (!wait && dist(n) <= 2 * (2 * self.room + SLACK)))
                    && (wait || mark_of(host, n.id).is_none())
                    && !settled
                    && !standing
                {
                    pushers.push((*n, dist(n)));
                }
            }
        }
        let v = wanted(
            body,
            [p.x, p.z],
            [aim.x, aim.z],
            self.speed,
            self.tick,
            &pushers,
            2 * self.room + SLACK,
        );
        // A step the mover cut to nothing last tick is tried turned this tick. The step kept is the guarded one: a
        // wait for another body's space is no edge, and is not turned (#4215).
        let turn = match self.last {
            Some((q, w, t)) if q == p && w != [0, 0] && v != [0, 0] => (t + 1) % TURNS.len(),
            _ => 0,
        };
        // The hard rule under the push: no step into another body's space (#4215).
        let room = 2 * self.room + SLACK;
        let mut want = turned(v, TURNS[turn]);
        // Yielding: held by a lower id, it stands a while, so the lowest id of a knot goes first.
        if let Some((from, left)) = self.yielding {
            if left > 0 && near.iter().any(|n| n.id == from) {
                want = [0, 0];
                self.yielding = Some((from, left - 1));
            } else {
                self.yielding = None;
            }
        }
        // The edge it slid along lately: its move last tick when the mover turned it from the step asked.
        self.slide = match self.last {
            Some((q, w, _)) if w != [0, 0] => {
                let moved = [p.x - q.x, p.z - q.z];
                let asked = [w[0] * self.tick / 1_000_000, w[1] * self.tick / 1_000_000];
                if moved != [0, 0] && len([moved[0] - asked[0], moved[1] - asked[1]]) > 1_000 {
                    Some((moved, SLID))
                } else {
                    self.slide.and_then(|(t, k)| (k > 1).then_some((t, k - 1)))
                }
            }
            _ => self.slide.and_then(|(t, k)| (k > 1).then_some((t, k - 1))),
        };
        // The shoulder turn (N10's rung, E16): a body at rest no longer holds it either, so one standing in the only
        // way (a doorway, the one gap, by its own order to stay) never walls it in: it squeezes past. Bodies on the
        // move keep their space.
        let passing: Vec<Near>;
        let guarded: &[Near] = if shoulder {
            passing = near
                .iter()
                .filter(|n| {
                    !self
                        .resting
                        .iter()
                        .any(|(i, k)| *i == n.id && *k >= STANDING)
                })
                .copied()
                .collect();
            &passing
        } else {
            &near
        };
        let step = guard(
            [p.x, p.z],
            want,
            self.tick,
            guarded,
            room,
            self.slide.map(|(t, _)| t),
        );
        // Held: the guard cut its step to under half (read at the leg's end next tick, A2-2).
        self.short = len(step) * 2 < len(want);
        // Judged over a window of HOLD ticks: a walker that got under a quarter of its free way, while a lower id
        // is near it ahead, yields to that one (one behind does not hold it, and one standing does not go first).
        self.held += 1;
        let start = *self.window.get_or_insert(p);
        if self.held >= HOLD {
            let moved = len([p.x - start.x, p.z - start.z]);
            let could = self.speed * self.tick * i64::from(HOLD) / 1_000_000;
            if self.yielding.is_none() && moved * 4 < could {
                let reach = 2 * room;
                let by = near
                    .iter()
                    .filter(|n| {
                        n.id < body
                            && dist(n) <= reach
                            && !self
                                .resting
                                .iter()
                                .any(|(i, k)| *i == n.id && *k >= STANDING)
                            && (n.position.x - p.x) * (aim.x - p.x)
                                + (n.position.z - p.z) * (aim.z - p.z)
                                > 0
                    })
                    .min_by_key(|n| (dist(n), n.id));
                if let Some(n) = by {
                    self.yielding = Some((n.id, BACK));
                }
            }
            (self.held, self.window) = (0, None);
        }
        // Held near its goal by a body at rest nearer it: as near as the crowd allows, it has arrived, short of the goal
        // ([`F_SHORT`] on its body).
        let last = leg.link.is_none() && self.leg + 1 == self.legs.len();
        // Never as near as the crowd allows in a doorway's mouth: one standing there would shut it (A2-2).
        let in_mouth = self
            .landed
            .is_some_and(|l| len([p.x - l.x, p.z - l.z]) < MOUTH);
        if last && !in_mouth && gap <= CROWDED && len(step) * 4 < len(want) {
            let reach = room + self.speed * self.tick / 1_000_000;
            let to_goal = |q: Vec3| len([leg.to.x - q.x, leg.to.z - q.z]);
            // A walk to its own granted spot is not held by others on theirs: it passes between them (N9).
            let held = near.iter().any(|n| {
                n.velocity.x == 0
                    && n.velocity.z == 0
                    && dist(n) <= reach
                    && to_goal(n.position) < gap
                    && mark_of(host, n.id).is_none()
                    && !(self.spot && host.field(n.id, F_SETTLED).is_some())
            });
            // A walk to its own granted spot ends short only when the spot is taken (a body at rest on it), or once
            // held near it CROWD_TICKS ticks in all: a way round, and the world's make-way, come first (A2-4).
            let taken = || {
                near.iter().any(|n| {
                    n.velocity.x == 0 && n.velocity.z == 0 && to_goal(n.position) < 2 * self.room
                })
            };
            let held = held
                && (!self.spot || taken() || {
                    self.crowd += 1;
                    self.crowd >= CROWD_TICKS
                });
            // A walk asked to end nearer than AT_GOAL (a form's walk before a move, 0.135 E20) that the guard holds
            // within AT_GOAL of its goal for HOLD ticks in all is as near as it gets: a body standing just past or
            // beside the stand point is not nearer the goal, so the rule above never ends it.
            let held = held
                || (!self.spot && self.arrive < AT_GOAL && gap <= AT_GOAL && {
                    self.crowd += 1;
                    self.crowd >= HOLD
                });
            if held {
                // It says so on its body: the world names it in the walk's `done` (A2-4).
                let _ = host.emit(
                    vec![Change::Set {
                        node: body,
                        field: F_SHORT,
                        to: Value::Uint(1),
                        by: None,
                    }],
                    None,
                );
                walk(host, [0, 0]);
                return Progress::Done;
            }
        }
        // Each body near: ticks in a row seen at rest (one standing, not one held for a moment).
        let was = std::mem::take(&mut self.resting);
        self.resting = near
            .iter()
            .filter(|n| n.velocity.x == 0 && n.velocity.z == 0)
            .map(|n| {
                let k = was.iter().find(|(i, _)| *i == n.id).map_or(0, |(_, k)| *k);
                (n.id, k.saturating_add(1))
            })
            .collect();
        // Back from a step back: a way round the body it stepped back from, from here (never back again).
        if self.detour.is_none()
            && let Some(b) = self.retry.take()
            && let Some((s, false)) = self.way_round(host, (p, aim), b, &near, wait)
        {
            self.detour = Some((s, self.leg, DETOUR_TICKS));
        }
        // Held by a body standing ahead: after DETOUR_AFTER ticks, a way round it (A2-2).
        if self.detour.is_none() {
            let close = room + 2 * self.speed * self.tick / 1_000_000;
            let standing = |id: Id| self.resting.iter().any(|(i, k)| *i == id && *k >= STANDING);
            let blocker = near
                .iter()
                .filter(|n| {
                    standing(n.id)
                        && dist(n) <= close
                        // One waiting in its turn is the queue: a walker waiting too stands behind it.
                        && !(wait && mark_of(host, n.id).is_some())
                        && (n.position.x - p.x) * (aim.x - p.x)
                            + (n.position.z - p.z) * (aim.z - p.z)
                            > 0
                })
                .min_by_key(|n| (dist(n), n.id));
            // Held: it gains less than a quarter of its free speed toward its aim this tick.
            let d = [aim.x - p.x, aim.z - p.z];
            let gains = (i128::from(step[0]) * i128::from(d[0])
                + i128::from(step[1]) * i128::from(d[1]))
                / i128::from(len(d).max(1));
            match blocker {
                Some(b) if gains * 4 < i128::from(self.speed) => {
                    self.blocked += 1;
                    if self.blocked >= DETOUR_AFTER {
                        self.blocked = 0;
                        if let Some((s, back)) =
                            self.way_round(host, (p, aim), b.position, &near, wait)
                        {
                            self.detour = Some((s, self.leg, DETOUR_TICKS));
                            self.yielding = None;
                            // Stepped back: from there it looks for a way round the same body at once.
                            self.retry = back.then_some(b.position);
                        }
                    }
                }
                _ => self.blocked = 0,
            }
        }
        self.last = Some((p, step, turn));
        walk(host, step);
        Progress::Going
    }
}

impl Route {
    /// A point beside `b` (a body at rest between the walker at `p` and its aim), clear of every body near and that a
    /// straight walk from `p` reaches (`Ask::Toward` answers it itself): first on the side away from `b`, then the
    /// other, each one, two and three passes out (A2-2).
    fn way_round(
        &self,
        host: &mut dyn Host,
        (p, aim): (Vec3, Vec3),
        b: Vec3,
        near: &[Near],
        wait: bool,
    ) -> Option<(Vec3, bool)> {
        let body = host.body();
        let d = [aim.x - p.x, aim.z - p.z];
        let l = len(d);
        if l == 0 {
            return None;
        }
        let pass = 2 * self.room + SLACK + PASS;
        // The side `b` is on, across the way (right of the walk's line positive).
        let r = [-d[1], d[0]];
        let on = (b.x - p.x) * r[0] + (b.z - p.z) * r[1];
        let first = if on > 0 || (on == 0 && body.counter().is_multiple_of(2)) {
            -1
        } else {
            1
        };
        for side in [first, -first] {
            for k in 1..=3 {
                let s = Vec3::new(
                    b.x + side * r[0] * k * pass / l + d[0] * pass / 2 / l,
                    p.y,
                    b.z + side * r[1] * k * pass / l + d[1] * pass / 2 / l,
                );
                // A walker on its way to wait its turn keeps closing on its link: a way round never takes it back.
                if !self.clear_to(p, s, near) || (wait && len([aim.x - s.x, aim.z - s.z]) >= l) {
                    continue;
                }
                match host.ask(&Ask::Toward { from: body, to: s }) {
                    Some(Answer::Point(q)) if q.x == s.x && q.z == s.z => return Some((s, false)),
                    _ => break,
                }
            }
        }
        // Against a row of bodies: sideways along it, a little back, to past its end on that side, from where the
        // way on is clear of it.
        for side in [first, -first] {
            let mut lat = 0;
            for n in near {
                let o = [n.position.x - p.x, n.position.z - p.z];
                let f = (o[0] * d[0] + o[1] * d[1]) / l;
                let across = side * (o[0] * r[0] + o[1] * r[1]) / l;
                let standing = self
                    .resting
                    .iter()
                    .any(|(i, k)| *i == n.id && *k >= STANDING);
                if standing && f > -pass && f < 2 * pass && across > -pass {
                    lat = lat.max(across);
                }
            }
            let out = lat + pass;
            let s = Vec3::new(
                p.x + side * r[0] * out / l - d[0] * pass / 2 / l,
                p.y,
                p.z + side * r[1] * out / l - d[1] * pass / 2 / l,
            );
            if !wait
                && self.clear_to(p, s, near)
                && matches!(host.ask(&Ask::Toward { from: body, to: s }), Some(Answer::Point(q)) if q.x == s.x && q.z == s.z)
            {
                return Some((s, false));
            }
        }
        // Hemmed in, no way round from here: a step back the way it came, to look again from there.
        let back = Vec3::new(p.x - d[0] * pass / l, p.y, p.z - d[1] * pass / l);
        if !wait
            && self.clear_to(p, back, near)
            && matches!(host.ask(&Ask::Toward { from: body, to: back }), Some(Answer::Point(q)) if q.x == back.x && q.z == back.z)
        {
            return Some((back, true));
        }
        None
    }

    /// Whether a straight walk from `p` to `s` keeps out of every near body's space: no point of it comes nearer a
    /// body than two radii, or than the body is now when that is less (A2-2).
    fn clear_to(&self, p: Vec3, s: Vec3, near: &[Near]) -> bool {
        let room = i128::from(2 * self.room + SLACK);
        let d = [i128::from(s.x - p.x), i128::from(s.z - p.z)];
        let l2 = d[0] * d[0] + d[1] * d[1];
        near.iter().all(|n| {
            let o = [
                i128::from(n.position.x - p.x),
                i128::from(n.position.z - p.z),
            ];
            let now2 = o[0] * o[0] + o[1] * o[1];
            let along = if l2 == 0 {
                0
            } else {
                ((o[0] * d[0] + o[1] * d[1]) * 1_000_000 / l2).clamp(0, 1_000_000)
            };
            let c = [d[0] * along / 1_000_000, d[1] * along / 1_000_000];
            let at2 = (o[0] - c[0]).pow(2) + (o[1] - c[1]).pow(2);
            at2 >= (room * room).min(now2)
        })
    }
}
