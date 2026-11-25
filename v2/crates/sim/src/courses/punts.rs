//! Where a world's rowing punts are moored (#3603): today's punt/1 search (`packages/engine-mars/src/punt.ts`), ported
//! to the open ground's waters and terrain. One punt per standing water (a ring; a river drawn as a line and a width
//! has none, as today). Its shore edges are tried longest first, each edge at least 7 m: the punt's home is 2.2 m
//! out from the edge's middle, on the water's level; the boarding plank's dry end 0.9 m in from it, and each rider's
//! exit 1.45 m in and 0.85 m to either side. Its own route is today's loop, 2.2 m to 10 m out and back, sized 5, 4, 3
//! or 2 m until the whole hull stays on water deep enough to float it at every second of the loop, as a course: the
//! home a stop where riders board for 30 s, the loop rowed at today's pace (at most 0.6 m/s). The plank and both exits
//! need dry ground, a standing disc of it round each.
//!
//! Integer arithmetic only (T4): the loop's 16 directions are a fixed table, no platform `sin` or `cos`.

use std::collections::BTreeMap;

use super::{Course, Shape, Station};
use crate::ground::{Terrain, Water};
use replica::effects::{Refusal, read_id};
use replica::encode::Value;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::sky::{as_int, int};
use replica::time::Micros;

type Xz = [i64; 2];

/// Water at least this deep floats a punt, µm (today's 0.12 m).
pub const FLOAT_DEPTH: i64 = 120_000;
/// The hull's reach from its centre, µm: 16 points at 1.75 m round it stay on floating water.
pub const HULL: i64 = 1_750_000;
/// How long the punt waits at its home for riders, µs (today's 30 s).
pub const BOARDING: i64 = 30_000_000;
/// The loop's time, today's 150 s, and the fastest it is rowed, µm a second (today's 0.6 m/s).
pub const LAP: i64 = 150_000_000;
pub const ROWING: i64 = 600_000;

/// cos and sin of k/16 of a turn, parts per million.
pub(super) const TURN16: [(i64, i64); 16] = [
    (1_000_000, 0),
    (923_880, 382_683),
    (707_107, 707_107),
    (382_683, 923_880),
    (0, 1_000_000),
    (-382_683, 923_880),
    (-707_107, 707_107),
    (-923_880, 382_683),
    (-1_000_000, 0),
    (-923_880, -382_683),
    (-707_107, -707_107),
    (-382_683, -923_880),
    (0, -1_000_000),
    (382_683, -923_880),
    (707_107, -707_107),
    (923_880, -382_683),
];

/// A punt's mooring: its water, its home on the water (µm, at the water's level), the direction from the bank out
/// over the water (parts per million), the boarding plank's dry end, each rider's exit, and its own course.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mooring {
    pub water: Id,
    pub home: Vec3,
    pub out: Xz,
    pub door: Vec3,
    pub exits: [Vec3; 2],
    pub course: Course,
}

fn inside(r: &[Xz], p: Xz) -> bool {
    let mut c = false;
    for k in 0..r.len() {
        let (a, b) = (r[k], r[(k + 1) % r.len()]);
        if (a[1] > p[1]) != (b[1] > p[1]) {
            let lhs = i128::from(p[0] - a[0]) * i128::from(b[1] - a[1]);
            let rhs = i128::from(b[0] - a[0]) * i128::from(p[1] - a[1]);
            if (b[1] > a[1] && lhs < rhs) || (b[1] < a[1] && lhs > rhs) {
                c = !c;
            }
        }
    }
    c
}

/// `v` scaled by `ppm` parts per million, rounded.
pub(super) fn ppm(v: i64, ppm: i64) -> i64 {
    let n = i128::from(v) * i128::from(ppm);
    i64::try_from(if n >= 0 {
        (n + 500_000) / 1_000_000
    } else {
        -((-n + 500_000) / 1_000_000)
    })
    .unwrap_or(0)
}

/// The moorings of `waters` over `terrain` (none: the open ground is flat at 0), one per water that has one, in the
/// waters' order. `clear(p)`: whether a body may stand at dry point `p` (no solid there).
pub fn moorings(
    waters: &[Water],
    terrain: Option<&Terrain>,
    clear: impl Fn(Vec3) -> bool,
) -> Vec<Mooring> {
    waters
        .iter()
        .filter(|w| w.ring.len() >= 3)
        .filter_map(|w| mooring(w, terrain, &clear))
        .collect()
}

/// The moorings of the open ground `ground` of `tree` (#3603): its terrain and the standing waters among its places.
/// No thing is read: a plank among furniture is not refused yet (today's obstacle check).
pub fn moorings_of(tree: &replica::tree::Tree, ground: Id) -> Result<Vec<Mooring>, String> {
    let (waters, terrain) = waters_of(tree, ground)?;
    Ok(moorings(&waters, terrain.as_ref(), |_| true))
}

/// The standing and running waters among the places of the open ground `ground` of `tree`, and its terrain.
pub fn waters_of(
    tree: &replica::tree::Tree,
    ground: Id,
) -> Result<(Vec<Water>, Option<Terrain>), String> {
    let terrain = Terrain::of(tree, ground)?;
    let gh = tree.handle(ground).ok_or("no ground")?;
    let mut waters = Vec::new();
    for &c in tree.children(gh).unwrap_or(&[]) {
        let water = tree.node(c).is_some_and(|n| {
            matches!(n.fields().get(&crate::ground::scene::F_PLACE_OF),
                Some(replica::encode::Value::Text(t)) if t.as_str() == "eden:water")
        });
        if !water {
            continue;
        }
        let s = crate::ground::Scene::of_child(tree, gh, c, terrain.as_ref())?;
        waters.extend(s.waters);
    }
    Ok((waters, terrain))
}

/// cos and sin of k/32 of a turn, parts per million (today's 32 plank directions).
fn turn32(k: usize) -> (i64, i64) {
    const Q: [i64; 9] = [
        1_000_000, 980_785, 923_880, 831_470, 707_107, 555_570, 382_683, 195_090, 0,
    ];
    let k = k % 32;
    let (c, s) = match k / 8 {
        0 => (Q[k % 8], Q[8 - k % 8]),
        1 => (-Q[8 - k % 8], Q[k % 8]),
        2 => (-Q[k % 8], -Q[8 - k % 8]),
        _ => (Q[8 - k % 8], -Q[k % 8]),
    };
    (c, s)
}

fn mooring(w: &Water, terrain: Option<&Terrain>, clear: &impl Fn(Vec3) -> bool) -> Option<Mooring> {
    let ground = |x: i64, z: i64| terrain.and_then(|t| t.height_at(x, z)).unwrap_or(0);
    let wet = |x: i64, z: i64| inside(&w.ring, [x, z]) && w.level - ground(x, z) >= FLOAT_DEPTH;
    // Dry bank: off the water, or ground inside its outline that the water does not cover.
    let bank = |x: i64, z: i64| {
        (!inside(&w.ring, [x, z]) || ground(x, z) >= w.level).then(|| Vec3::new(x, ground(x, z), z))
    };
    let dry = |p: Xz| -> Option<Vec3> {
        let v = bank(p[0], p[1])?;
        let disc = TURN16
            .iter()
            .step_by(2)
            .all(|&(c, s)| bank(p[0] + ppm(300_000, c), p[1] + ppm(300_000, s)).is_some());
        (disc && clear(v)).then_some(v)
    };
    let floats = |p: Vec3| {
        TURN16
            .iter()
            .all(|&(c, s)| wet(p.x + ppm(HULL, c), p.z + ppm(HULL, s)))
    };
    // Today's loop from `home`, `n` out over the water and `t` along the bank, at radius 5, 4, 3 or 2 m: the first
    // whose hull floats at every second of it.
    let looped = |home: Vec3, n: Xz, t: Xz| -> Option<Course> {
        for radius in [5_000_000i64, 4_000_000, 3_000_000, 2_000_000] {
            let key = |k: usize| {
                let (c, s) = TURN16[k % 16];
                let out = radius - ppm(radius, c);
                let along = ppm(ppm(radius, 650_000), s);
                Vec3::new(
                    home.x + ppm(out, n[0]) + ppm(along, t[0]),
                    w.level,
                    home.z + ppm(out, n[1]) + ppm(along, t[1]),
                )
            };
            let stations: Vec<Station> = (0..16)
                .map(|k| Station {
                    at: key(k),
                    dwell: if k == 0 { BOARDING } else { 0 },
                })
                .collect();
            let length: i64 = (0..16)
                .map(|k| {
                    let (p, q) = (key(k), key(k + 1));
                    let d = [i128::from(q.x - p.x), i128::from(q.z - p.z)];
                    (d[0] * d[0] + d[1] * d[1]).isqrt() as i64
                })
                .sum();
            let course = Course {
                stations,
                shape: Shape::Loop,
                speed: (length * 1_000_000 / LAP).clamp(1, ROWING),
                t0: 0,
                within: LAP * 4,
            };
            let Ok(table) = course.load() else { continue };
            let mut at = 0;
            let mut ok = true;
            while at < table.period {
                if !table.at(at).is_ok_and(|(p, _)| floats(p)) {
                    ok = false;
                    break;
                }
                at += 1_000_000;
            }
            if ok {
                return Some(course);
            }
        }
        None
    };
    let r = &w.ring;
    let area: i128 = (0..r.len())
        .map(|i| {
            let (a, b) = (r[i], r[(i + 1) % r.len()]);
            i128::from(a[0]) * i128::from(b[1]) - i128::from(b[0]) * i128::from(a[1])
        })
        .sum();
    let sign: i64 = if area > 0 { 1 } else { -1 };
    let mut edges: Vec<(i64, usize)> = (0..r.len())
        .map(|i| {
            let (a, b) = (r[i], r[(i + 1) % r.len()]);
            let d = [i128::from(b[0] - a[0]), i128::from(b[1] - a[1])];
            ((d[0] * d[0] + d[1] * d[1]).isqrt() as i64, i)
        })
        .collect();
    edges.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    for (len, i) in edges {
        if len < 7_000_000 {
            break;
        }
        let (a, b) = (r[i], r[(i + 1) % r.len()]);
        // Unit directions in parts per million: along the edge, and out over the water.
        let t = [
            (b[0] - a[0]) * 1_000_000 / len,
            (b[1] - a[1]) * 1_000_000 / len,
        ];
        let n = [-t[1] * sign, t[0] * sign];
        let mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        let at = |inward: i64, along: i64| {
            [
                mid[0] + ppm(inward, n[0]) + ppm(along, t[0]),
                mid[1] + ppm(inward, n[1]) + ppm(along, t[1]),
            ]
        };
        let (Some(door), Some(ea), Some(eb)) = (
            dry(at(-900_000, 0)),
            dry(at(-1_450_000, -850_000)),
            dry(at(-1_450_000, 850_000)),
        ) else {
            continue;
        };
        let h = at(2_200_000, 0);
        let home = Vec3::new(h[0], w.level, h[1]);
        if let Some(course) = looped(home, n, t) {
            return Some(Mooring {
                water: w.place,
                home,
                out: n,
                door,
                exits: [ea, eb],
                course,
            });
        }
    }
    shelf(w, &floats, &dry, &looped)
}

/// Today's shelf search (L1): a water whose long sides all have shallows wider than a plank, at most 200 m by 200 m:
/// every home on a 0.5 m lattice where the hull floats, nearest the water's middle first, its plank's dry end in any
/// of 32 directions 3.1 m out (today also tries 2.8, 2.5 and 2.2 m; the punt's kind has its plank at 3.1 m, as the
/// shore search's punts have it); at most 400 loops tried.
fn shelf(
    w: &Water,
    floats: &impl Fn(Vec3) -> bool,
    dry: &impl Fn(Xz) -> Option<Vec3>,
    looped: &impl Fn(Vec3, Xz, Xz) -> Option<Course>,
) -> Option<Mooring> {
    let r = &w.ring;
    let (x0, x1) = (r.iter().map(|p| p[0]).min()?, r.iter().map(|p| p[0]).max()?);
    let (z0, z1) = (r.iter().map(|p| p[1]).min()?, r.iter().map(|p| p[1]).max()?);
    if i128::from(x1 - x0) * i128::from(z1 - z0) > 40_000 * 1_000_000_000_000 {
        return None;
    }
    let k = r.len() as i64;
    let (cx, cz) = (
        r.iter().map(|p| p[0]).sum::<i64>() / k,
        r.iter().map(|p| p[1]).sum::<i64>() / k,
    );
    const S: i64 = 500_000;
    let mut homes = Vec::new();
    let mut z = z0;
    while z <= z1 + S {
        let mut x = x0;
        while x <= x1 + S {
            let h = Vec3::new(x, w.level, z);
            if inside(r, [x, z]) && floats(h) {
                homes.push(h);
            }
            x += S;
        }
        z += S;
    }
    let d2 = |h: &Vec3| {
        let (dx, dz) = (i128::from(h.x - cx), i128::from(h.z - cz));
        dx * dx + dz * dz
    };
    homes.sort_by(|a, b| d2(a).cmp(&d2(b)).then(a.x.cmp(&b.x)).then(a.z.cmp(&b.z)));
    let mut tried = 0;
    for home in homes {
        for k in 0..32 {
            let (c, s) = turn32(k);
            let (d, t) = ([c, s], [-s, c]);
            let n = [-c, -s];
            for out in [3_100_000i64] {
                let at = |o: i64, along: i64| {
                    [
                        home.x + ppm(o, d[0]) + ppm(along, t[0]),
                        home.z + ppm(o, d[1]) + ppm(along, t[1]),
                    ]
                };
                let Some(door) = dry(at(out, 0)) else {
                    continue;
                };
                let (Some(ea), Some(eb)) = (
                    dry(at(out + 550_000, -850_000)),
                    dry(at(out + 550_000, 850_000)),
                ) else {
                    continue;
                };
                if let Some(course) = looped(home, n, t) {
                    return Some(Mooring {
                        water: w.place,
                        home,
                        out: n,
                        door,
                        exits: [ea, eb],
                        course,
                    });
                }
                tried += 1;
                if tried > 400 {
                    return None;
                }
                break;
            }
        }
    }
    None
}

// Steering (#3603): today's `carrier_steer` on a punt (`mars/viewer/engine/vehicles/carrier.ts`). A seated rider
// steers toward a point: one straight leg over water deep enough to float it, ending 3 m short of the first shore on
// the way. Landing rows it back along its wake, then on round the rest of the lap it left, to its home. Every steer is
// a new course run once ([`Shape::Once`]) from where the punt is, so every copy reads the same positions.

/// The farthest from its home a punt is steered toward, µm (today's 1200 m).
pub const STEER_RANGE: i64 = 1_200_000_000;
/// A steered leg ends this far short of the first shore on its way, µm (today's 3 m).
pub const SHORT_OF_SHORE: i64 = 3_000_000;

/// A punt steered off its own loop: who steers it, the loop it left (its home is the loop's first station), the world
/// time it left it, and where each steer started (its wake), oldest first. Kept as the punt's
/// [`replica::schedule::F_STEER`] field, `{1: by, 2: own course, 3: left µs, 4: [[x, y, z] …]}`; an empty map while it
/// is on its own loop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Steer {
    pub by: Id,
    pub own: Course,
    pub left: Micros,
    pub wake: Vec<Vec3>,
}

impl Steer {
    /// The punt's home: its own loop's first station.
    pub fn home(&self) -> Vec3 {
        self.own.stations.first().map_or(Vec3::ZERO, |s| s.at)
    }

    pub fn to_value(&self) -> Value {
        let xyz = |p: &Vec3| Value::Array(vec![int(p.x), int(p.y), int(p.z)]);
        Value::Map(BTreeMap::from([
            (1, self.by.to_value()),
            (2, self.own.to_value()),
            (3, int(self.left)),
            (4, Value::Array(self.wake.iter().map(xyz).collect())),
        ]))
    }

    /// The steer a punt's field holds; `None` for an empty map (on its own loop) or anything else.
    pub fn read(v: &Value) -> Option<Steer> {
        let Value::Map(m) = v else { return None };
        let Value::Array(wake) = m.get(&4)? else {
            return None;
        };
        let wake = wake
            .iter()
            .map(|p| match p {
                Value::Array(p) => match p.as_slice() {
                    [x, y, z] => Some(Vec3::new(as_int(x)?, as_int(y)?, as_int(z)?)),
                    _ => None,
                },
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Steer {
            by: read_id(m.get(&1)?).ok()?,
            own: Course::read(m.get(&2)?)?,
            left: as_int(m.get(&3)?)?,
            wake,
        })
    }
}

/// Whether the hull's middle at (x, z) is on water deep enough to float it, of any of `waters`.
fn floating(waters: &[Water], terrain: Option<&Terrain>, x: i64, z: i64) -> bool {
    let ground = terrain.and_then(|t| t.height_at(x, z)).unwrap_or(0);
    waters
        .iter()
        .any(|w| w.ring.len() >= 3 && inside(&w.ring, [x, z]) && w.level - ground >= FLOAT_DEPTH)
}

/// Where a punt at `from` can row toward `to` in a straight line over water (today's `waterReach`): `to` itself, or the
/// last whole metre of floating water [`SHORT_OF_SHORE`] short of the first shore on the way; `None` when that leaves
/// it less than 2 m to go. Within half a metre it stays where it is.
pub fn reach(waters: &[Water], terrain: Option<&Terrain>, from: Vec3, to: Xz) -> Option<Vec3> {
    let (dx, dz) = (i128::from(to[0] - from.x), i128::from(to[1] - from.z));
    let len = (dx * dx + dz * dz).isqrt() as i64;
    if len < 500_000 {
        return Some(from);
    }
    let along = |s: i64| {
        let k = |d: i128| (d * i128::from(s) / i128::from(len)) as i64;
        Vec3::new(from.x + k(dx), from.y, from.z + k(dz))
    };
    let mut ok = 0;
    let mut s = 1_000_000;
    while s <= len {
        let p = along(s);
        if !floating(waters, terrain, p.x, p.z) {
            break;
        }
        ok = s;
        s += 1_000_000;
    }
    if ok >= len - 1_000_000 {
        return Some(Vec3::new(to[0], from.y, to[1]));
    }
    let keep = ok - SHORT_OF_SHORE;
    (keep >= 2_000_000).then(|| along(keep))
}

/// A course rowed once at [`ROWING`] from `here` through `points` from world time `now`, standing at the last for good.
/// It states the time to that last stop as its `within`.
pub fn once(here: Vec3, points: &[Vec3], now: Micros) -> Result<Course, Refusal> {
    let points: Vec<(Vec3, Micros)> = points.iter().map(|&p| (p, 0)).collect();
    once_through(here, &points, now, ROWING)
}

/// A course run once from `here` through `points` (each a point and how long it stands there, µs) from world time
/// `now` at `speed` (µm a second), standing at the last for good: [`once`] with holds on the way, at the thing's own
/// pace. It states the time to that last stop as its `within`.
pub fn once_through(
    here: Vec3,
    points: &[(Vec3, Micros)],
    now: Micros,
    speed: i64,
) -> Result<Course, Refusal> {
    let mut stations = vec![Station { at: here, dwell: 0 }];
    for &(p, dwell) in points {
        match stations.last_mut() {
            Some(s) if s.at == p => s.dwell = s.dwell.max(dwell),
            _ => stations.push(Station { at: p, dwell }),
        }
    }
    if stations.len() < 2 {
        stations.push(Station { at: here, dwell: 0 });
    }
    let mut c = Course {
        stations,
        shape: Shape::Once,
        speed,
        t0: now,
        within: Micros::MAX / 8,
    };
    let t = c.load()?;
    c.within = t.legs.last().map_or(0, |l| l.start).max(1);
    c.load()?;
    Ok(c)
}

/// The points a course run once still goes through after world time `now`, the hold it stands in left out, ending at
/// its last station: the way on from where it is. `None` for a course that is not run once, before it starts, or
/// while a hold not yet begun lies ahead (on its way out to where a steer holds it, the way on is not the way home).
pub fn rest_of(c: &Course, now: Micros) -> Option<Vec<Vec3>> {
    if c.shape != Shape::Once {
        return None;
    }
    let t = c.load().ok()?;
    let phase = now.checked_sub(t.t0).filter(|p| *p >= 0)?;
    let last = t.legs.len().checked_sub(1)?;
    if t.legs[..last]
        .iter()
        .any(|l| l.stop.is_some() && l.start > phase)
    {
        return None;
    }
    let mut pts: Vec<Vec3> = t
        .legs
        .iter()
        .filter(|l| l.stop.is_none() && l.start + l.dur > phase)
        .map(|l| l.to)
        .collect();
    let last = c.stations.last()?.at;
    if pts.last() != Some(&last) {
        pts.push(last);
    }
    Some(pts)
}

/// The way a steered punt rows back to its home (today's return): back along its wake, then round the rest of the lap
/// it left (none when it left from its home), ending at its home.
pub fn back(s: &Steer) -> Vec<Vec3> {
    let mut pts: Vec<Vec3> = s.wake.iter().rev().copied().collect();
    if let Ok(t) = s.own.load()
        && s.left >= t.t0
        && !matches!(t.stopped(s.left), Ok(Some(st)) if st.station == 0)
    {
        let phase = (s.left - t.t0) % t.period;
        pts.extend(
            t.legs
                .iter()
                .filter(|l| l.stop.is_none() && l.start + l.dur > phase)
                .map(|l| l.to),
        );
    }
    if pts.last() != Some(&s.home()) {
        pts.push(s.home());
    }
    pts
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pond 20 m by 12 m, 1 m deep on flat ground: its punt is moored on a long side, its home 2.2 m out from the
    /// side's middle at the water's level, the plank and the exits on dry ground, and the loop on water all the way.
    /// A pond too small for any loop, and a river drawn as a line, have none.
    #[test]
    fn a_pond_has_a_mooring_on_a_long_side_and_a_puddle_none() {
        let m = 1_000_000;
        let pond = |w: i64, d: i64| Water {
            place: Id::new(replica::ids::Scope([0x36; 16]), 1).unwrap(),
            ring: vec![[0, 0], [w * m, 0], [w * m, d * m], [0, d * m]],
            line: Vec::new(),
            width: 0,
            level: m,
        };
        let found = moorings(&[pond(20, 12)], None, |_| true);
        assert_eq!(found.len(), 1, "{found:?}");
        let p = &found[0];
        println!(
            "mooring: home {:?} out {:?} door {:?} exits {:?}",
            p.home, p.out, p.door, p.exits
        );
        assert_eq!(p.home.y, m, "at the water's level");
        assert!(
            p.home.z == 2_200_000 || p.home.z == 12 * m - 2_200_000,
            "2.2 m out from a long side"
        );
        assert!(
            !inside(&pond(20, 12).ring, [p.door.x, p.door.z]),
            "the plank's end is dry"
        );
        let t = p.course.load().expect("a course");
        assert_eq!(
            t.stopped(0).unwrap().map(|s| s.station),
            Some(0),
            "boarding at home first"
        );
        assert!(p.course.speed <= ROWING);
        assert!(
            moorings(&[pond(6, 6)], None, |_| true).is_empty(),
            "no side 7 m long"
        );
        let mut river = pond(20, 12);
        river.ring.clear();
        assert!(
            moorings(&[river], None, |_| true).is_empty(),
            "a river has none"
        );
        assert!(
            moorings(&[pond(20, 12)], None, |_| false).is_empty(),
            "a bank with no room to stand"
        );
    }

    /// #3603: a steer over the pond. Toward a point on the water it goes there; toward the far bank it stops 3 m short of
    /// it, on whole metres; toward the bank beside it, with less than 2 m to go, it is refused. The course it rows is
    /// run once at 0.6 m/s and stands at its end for good; the way back retraces the wake, then the rest of the lap.
    #[test]
    fn a_steer_rows_over_water_and_stops_short_of_the_shore() {
        let m = 1_000_000;
        let pond = Water {
            place: Id::new(replica::ids::Scope([0x36; 16]), 1).unwrap(),
            ring: vec![[0, 0], [40 * m, 0], [40 * m, 12 * m], [0, 12 * m]],
            line: Vec::new(),
            width: 0,
            level: m,
        };
        let w = [pond];
        let from = Vec3::new(5 * m, m, 6 * m);
        assert_eq!(
            reach(&w, None, from, [20 * m, 6 * m]),
            Some(Vec3::new(20 * m, m, 6 * m))
        );
        let short = reach(&w, None, from, [60 * m, 6 * m]).expect("short of the far bank");
        assert_eq!(
            (short.x, short.z),
            (36 * m, 6 * m),
            "3 m short of x 40 m: {short:?}"
        );
        assert_eq!(
            reach(&w, None, Vec3::new(5 * m, m, 2 * m), [5 * m, -20 * m]),
            None,
            "the near bank 2 m off"
        );
        let c = once(from, &[short], 1_000 * m).expect("a course");
        let t = c.load().unwrap();
        assert_eq!(c.shape, Shape::Once);
        assert_eq!(t.at(1_000 * m).unwrap().0, from, "it starts where it is");
        let gone = 1_000 * m + 52 * m; // 31 m at 0.6 m/s, and a little more
        assert_eq!(t.at(gone).unwrap().0, short, "and stands at its end");
        assert_eq!(t.stopped(gone * 2).unwrap().map(|s| s.station), Some(1));
        let own = moorings(&w, None, |_| true).remove(0).course;
        let home = own.stations[0].at;
        let left_at = own.load().unwrap().legs[1].start + 1; // just after it set off round its loop
        let s = Steer {
            by: Id::new(replica::ids::Scope([0x36; 16]), 9).unwrap(),
            own: own.clone(),
            left: left_at,
            wake: vec![from, short],
        };
        assert_eq!(Steer::read(&s.to_value()), Some(s.clone()));
        let way = back(&s);
        assert_eq!(&way[..2], &[short, from], "back along the wake");
        assert_eq!(way.last(), Some(&home), "home last");
        assert_eq!(way.len(), 2 + 16, "and the whole lap it had just begun");
        let from_home = Steer {
            left: 0,
            ..s.clone()
        };
        assert_eq!(
            back(&from_home),
            vec![short, from, home],
            "no lap from its home stop"
        );
    }
}
