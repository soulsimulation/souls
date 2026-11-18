//! N7's walk as a skill (Engine v2 N7 #2655, moved behind the host by T9b #3120): it walks a body along its route's
//! legs, keeping apart from the bodies near it, waiting its turn at a narrow link and crossing each link by asking the
//! world to carry it. It touches the world through `Host` alone, so it runs on any family with locomotion.
//!
//! - **A tick.** Aim at the next corner toward the leg's end (`Ask::Toward`), add a push away from every body within
//!   [`RANGE`] (`Ask::Near`: ids, positions and velocities as of the last tick), leaning right when one comes
//!   head-on, and hand the velocity on (`Host::control`). The push is resolved on the walker's own axes: forward, never
//!   below a tenth of free speed, and sideways; the sum never exceeds free speed.
//! - **Crossing.** At a link's near end it asks the world to carry it (`Host::cross`); a shut door is opened for it by
//!   the world. While carried its body shows [`F_CROSSING`]; once that is gone, the next leg starts.
//! - **Turns at a narrow place** (N8, T9b A3). The link reads [`F_TURNS`] when it is taken in turns, and
//!   [`F_GRANTED`] names the body its owner lets in. Without leave the walker marks itself waiting, [`F_WAITING`] on
//!   its own body (`[link, distance µm]`), within [`MARK`] of the near end, and stands within [`QUEUE`] of it or
//!   behind a body waiting for the same link within [`BEHIND`] and nearer. Those waiting push only each other.
//! - **Along an edge.** The mover cuts a step at the ground's edge and does not slide. A step that left the body where
//!   it was is tried next tick turned by 45 and then 70 degrees, either way (N7 tried them in the same tick on a copy;
//!   through the host the skill sees each result a tick later, T1).
//! - **N10's ladder** (T9c #3127) reaches the walk by fields the world sets on its body: [`F_SHOULDER`] (no body
//!   pushes it), [`F_ROUTE`] (a new route, walked from its first leg) and [`F_HELD`] (the world walks it out to legal
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
    Answer, Ask, F_CROSSING, F_GRANTED, F_HELD, F_ROUTE, F_SETTLED, F_SHOULDER, F_TURNS, F_WAITING,
    Host, Near, Progress, Skill,
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
/// A walker without leave stands behind a waiting body for the same link this near and nearer the end, µm.
pub const BEHIND: i64 = 700_000;
/// A granted standing spot is reached within this, µm (N9).
pub const AT_SPOT: i64 = 50_000;
/// Within this of its granted standing spot, µm, no body pushes a walker (N9).
pub const CALM: i64 = 1_000_000;

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
    /// Last tick's position, velocity wanted and turn tried, for a step cut at an edge.
    last: Option<(Vec3, [i64; 2], usize)>,
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
fn route_of(me: &replica::host::Seen, taken: u64) -> Option<(u64, Vec<Leg>)> {
    let Value::Array(a) = me.fields.get(&F_ROUTE)? else {
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
    let s = host.read(body)?;
    let Value::Array(a) = s.fields.get(&F_WAITING)? else {
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

    fn step(&mut self, host: &mut dyn Host) -> Progress {
        let body = host.body();
        let Some(me) = host.read(body) else {
            return Progress::Failed(name("souls:body-gone"));
        };
        // A new route from the world (N10's reroute): walked from its first leg.
        if let Some((n, legs)) = route_of(&me, self.route) {
            (self.route, self.legs, self.leg) = (n, legs, 0);
            (self.crossing, self.last) = (None, None);
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
        if me.fields.contains_key(&F_HELD) {
            self.mark(host, body, None);
            return Progress::Going;
        }
        let shoulder = me.fields.contains_key(&F_SHOULDER);
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
            let carried = me.fields.contains_key(&F_CROSSING);
            match (c, carried) {
                (_, true) => {
                    self.crossing = Some(Crossing::Carried);
                    return Progress::Going;
                }
                (Crossing::Carried, false) => {
                    self.crossing = None;
                    self.last = None;
                    self.leg += 1;
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
        let p = me.position;
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
        let mark = match leg.link {
            Some(l) if narrow && gap <= MARK => Some((l, gap)),
            _ => None,
        };
        let near = match host.ask(&Ask::Near { radius: RANGE }) {
            Some(Answer::Near(n)) => n,
            _ => Vec::new(),
        };
        let dist = |n: &Near| len([p.x - n.position.x, p.z - n.position.z]);
        if wait {
            self.mark(host, body, mark);
            let behind = near
                .iter()
                .filter(|n| dist(n) < BEHIND)
                .any(|n| mark_of(host, n.id).is_some_and(|(l, g)| Some(l) == leg.link && g < gap));
            if gap <= QUEUE || (gap <= MARK && behind) {
                walk(host, [0, 0]);
                return Progress::Going;
            }
        }
        match leg.link {
            Some(link) if gap <= AT_LINK && !wait => {
                self.mark(host, body, None);
                walk(host, [0, 0]);
                host.cross(link, self.speed);
                self.crossing = Some(Crossing::Asked);
                return Progress::Going;
            }
            None if gap <= if self.spot { AT_SPOT } else { AT_GOAL } => {
                walk(host, [0, 0]);
                return Progress::Done;
            }
            _ => {}
        }
        if !wait {
            self.mark(host, body, mark);
        }
        let Some(Answer::Point(aim)) = host.ask(&Ask::Toward {
            from: body,
            to: leg.to,
        }) else {
            return Progress::Failed(name("souls:no-way"));
        };
        // Those waiting at a narrow place make way: they push only others waiting. The shoulder turn, or the last
        // stretch to its own standing spot (N9): no body pushes it. Those standing on their own spots stand apart
        // already: a walker to its spot passes between them.
        let calm = self.spot && leg.link.is_none() && gap <= CALM;
        let mut pushers: Vec<(Near, i64)> = Vec::new();
        if !shoulder && !calm {
            for n in &near {
                let settled = self.spot
                    && host
                        .read(n.id)
                        .is_some_and(|s| s.fields.contains_key(&F_SETTLED));
                if (wait || mark_of(host, n.id).is_none()) && !settled {
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
        );
        // A step cut to nothing last tick is tried turned this tick.
        let turn = match self.last {
            Some((q, w, t)) if q == p && w != [0, 0] && v != [0, 0] => (t + 1) % TURNS.len(),
            _ => 0,
        };
        self.last = Some((p, v, turn));
        walk(host, turned(v, TURNS[turn]));
        Progress::Going
    }
}
