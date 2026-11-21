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

use super::{Course, Shape, Station};
use crate::ground::{Terrain, Water};
use replica::ids::Id;
use replica::pose::Vec3;

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
const TURN16: [(i64, i64); 16] = [
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
fn ppm(v: i64, ppm: i64) -> i64 {
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
    Ok(moorings(&waters, terrain.as_ref(), |_| true))
}

fn mooring(w: &Water, terrain: Option<&Terrain>, clear: &impl Fn(Vec3) -> bool) -> Option<Mooring> {
    let ground = |x: i64, z: i64| terrain.and_then(|t| t.height_at(x, z)).unwrap_or(0);
    let wet = |x: i64, z: i64| inside(&w.ring, [x, z]) && w.level - ground(x, z) >= FLOAT_DEPTH;
    let bank = |x: i64, z: i64| (!inside(&w.ring, [x, z])).then(|| Vec3::new(x, ground(x, z), z));
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
        let dry = |p: Xz| -> Option<Vec3> {
            let v = bank(p[0], p[1])?;
            let disc = TURN16
                .iter()
                .step_by(2)
                .all(|&(c, s)| bank(p[0] + ppm(300_000, c), p[1] + ppm(300_000, s)).is_some());
            (disc && clear(v)).then_some(v)
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
        for radius in [5_000_000i64, 4_000_000, 3_000_000, 2_000_000] {
            // Today's loop: k/16 of a turn, out `radius * (1 - cos)` and along `0.65 * radius * sin`.
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
            let speed = (length * 1_000_000 / LAP).clamp(1, ROWING);
            let course = Course {
                stations,
                shape: Shape::Loop,
                speed,
                t0: 0,
                within: LAP * 4,
            };
            let Ok(table) = course.load() else { continue };
            let floats = |p: Vec3| {
                TURN16
                    .iter()
                    .all(|&(c, s)| wet(p.x + ppm(HULL, c), p.z + ppm(HULL, s)))
            };
            let mut t = 0;
            let mut ok = true;
            while t < table.period {
                if !table.at(t).is_ok_and(|(p, _)| floats(p)) {
                    ok = false;
                    break;
                }
                t += 1_000_000;
            }
            if ok {
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
    }
    None
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
}
