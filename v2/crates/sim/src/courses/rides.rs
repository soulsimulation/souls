//! The courses of the rides a world's entries declare (#3691): a kind's `ride` section (`content/kinds`, `souls-entry/1`:
//! `{stops, returns, speed_mm_s, ground, …}`) read as data, never by the kind's name. A ride whose stops are all one
//! point, that does not return along a line and whose ground is the air is a vehicle that lifts off its stop and comes
//! back to it: it flies today's loop round its own home (`apps/server/src/god/rides.ts` `balloonRoute`, the ring a
//! god's balloon flies): straight up above its home, a 150 m ring that rises and falls between 40 m and 80 m over the
//! ground beneath it, and straight down again, at the ride's own speed, waiting at its home for riders for a minute each
//! lap (a god balloon's wait on today's engine), so a few Souls told when it is back board it together. At its home is
//! the only stop, so riders board and leave there only (`crate::slots` `boardable`), as a punt's; a Soul refused there
//! while it is away is told when it is back. Its trip ends when it is home again: what its `start` form set goes back
//! ([`trip_ends`], `crate::slots::Slots::trip_ended`).
//!
//! A ride with two different stops (riders board at one point of the thing and leave at another) moves its riders inside
//! a thing that stays where it is: its seats move (N14, [`seat_runs`]). The thing gets no course; each seat gets its own,
//! in the thing's frame, on the ride's own clock, and a seated body rides it because its frame is the seat's slot:
//!
//! - **Across and back** (`returns` true: a cable car). A seat waits at the stop its stand point names, then runs to each
//!   other stop in the trip's order and back, waiting [`SEAT_STOP`] at each. At every stop it keeps the offset from the
//!   stop's stand point it has at its own, across the ground and in height over the floor under the stand point, so a
//!   cabin that waits at standing height beside the valley station waits at standing height beside the mountain
//!   station, on its own cable (two cabins never cross).
//! - **Round its ring** (`returns` false, three or more seats: a big wheel, a carousel). The seats' declared points are
//!   a ring in the order `seats` lists them; the ring turns one seat's step at a time and stands [`SEAT_STOP`] after
//!   each, every seat halfway between two declared points (its own and the one before), so at the bottom of a wheel two
//!   gondolas stand at the platform together.
//! - **Where riders get on and off.** A station is a stop of the seat's run where its height over the floor under its
//!   stand point (the ride's stop there across and back; the seat's own round a ring, the platform) is within the
//!   standard body's reach ([`crate::slots::STANDARD_REACH`]); a rider stands up there at that stand point. A seat is
//!   boarded only at a station whose stand point is its own (where a form walks its rider), and left at any. Everywhere
//!   else the seat is aloft: nobody boards and nobody leaves (`boarding-frame-away`, `crate::slots`), and a rider is
//!   carried on to the next such stop.
//!
//! Integer arithmetic only (T4): the ring's 16 directions are the punts' fixed table, no platform `sin` or `cos`.

use std::collections::BTreeMap;

use super::punts::{TURN16, ppm};
use super::{Course, Shape, Station};
use crate::slots::{PlaceAt, STANDARD_REACH};
use replica::moves::Place;
use replica::pose::Vec3;
use replica::rules::json::Value as Json;
use replica::time::Micros;

/// How long a ride waits at its stop for riders each lap, µs: a minute, twice a punt's 30 s.
pub const BOARDING: Micros = 60_000_000;
/// The ring's radius, µm (today's 150 m).
pub const RING: i64 = 150_000_000;
/// The ring's middle height over the ground beneath it, µm, and how far it rises and falls about it (today's 60 m and
/// 20 m: twice a lap between 40 m and 80 m).
pub const ALOFT: i64 = 60_000_000;
pub const SWELL: i64 = 20_000_000;

/// What a kind's `ride` section says that a course needs: whether its stops are one point, whether it returns along a
/// line, its speed (µm a second) and whether its ground is the air.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ride {
    pub one_stop: bool,
    pub returns: bool,
    pub speed: i64,
    pub air: bool,
}

impl Ride {
    /// The `ride` section of the entry `entry`, `None` when it has none or it is not well formed.
    pub fn of(entry: &Json) -> Option<Ride> {
        let r = entry.get("ride")?;
        let stops: Vec<&str> = r
            .get("stops")?
            .arr()?
            .iter()
            .filter_map(Json::str)
            .collect();
        let speed = match r.get("speed_mm_s")? {
            Json::Int(n) => i64::try_from(*n).ok()?.checked_mul(1000)?,
            _ => return None,
        };
        Some(Ride {
            one_stop: !stops.is_empty() && stops.iter().all(|s| *s == stops[0]),
            returns: matches!(r.get("returns"), Some(Json::Bool(true))),
            speed,
            air: r.get("ground").and_then(Json::str) == Some("air"),
        })
    }

    /// Whether the ride is a vehicle that flies a loop from its stop and back (see the module doc).
    pub fn loops_aloft(&self) -> bool {
        self.one_stop && !self.returns && self.air && self.speed > 0
    }
}

/// The ride's own course from `home` (µm, where the thing stands), starting at world time `t0`: today's loop aloft for a
/// ride that [`Ride::loops_aloft`], else `None`. `ground(x, z)`: the ground's height there (µm), `None` off the terrain.
pub fn course(
    ride: &Ride,
    home: Vec3,
    ground: impl Fn(i64, i64) -> Option<i64>,
    t0: Micros,
) -> Option<Course> {
    if !ride.loops_aloft() {
        return None;
    }
    // The ring starts and ends straight above home: its middle is RING toward -z, as today's.
    let ring = |k: usize| {
        let (c, s) = TURN16[k % 16];
        let (x, z) = (home.x + ppm(RING, s), home.z - RING + ppm(RING, c));
        let under = ground(x, z).unwrap_or(home.y).max(home.y);
        Vec3::new(x, under + ALOFT + ppm(SWELL, TURN16[(2 * k) % 16].1), z)
    };
    let mut stations = vec![Station {
        at: home,
        dwell: BOARDING,
    }];
    stations.extend((0..=16).map(|k| Station {
        at: ring(k),
        dwell: 0,
    }));
    let mut c = Course {
        stations,
        shape: Shape::Loop,
        speed: ride.speed,
        t0,
        within: Micros::MAX / 4,
    };
    // It states exactly the time from leaving its stop to coming back to it.
    let table = c.load().ok()?;
    c.within = table.period - BOARDING;
    c.load().ok()?;
    Some(c)
}

/// How long a ride's seats stand at each stop of their run (N14), µs: long enough for a rider to walk to a cable car's
/// valley station from beside it and sit, short enough that a big wheel's sixteen steps take under an hour.
pub const SEAT_STOP: Micros = 180_000_000;

/// One seat's run (N14): its slot, its course in the thing's frame (µm; what the thing stores and the page reads), and
/// the seat as it stands at each station where riders get on and off, in the floor's frame.
#[derive(Clone, Debug)]
pub struct SeatRun {
    pub slot: u64,
    pub course: Course,
    pub stops: Vec<(usize, PlaceAt)>,
    /// The stations where it is boarded, its own stop: across and back the one its stand point names, round a ring
    /// every station within reach. Their places stand the rider at the registered place's stand point.
    pub own: std::collections::BTreeSet<usize>,
    /// What a trip's end sets back ([`trip_ends`]): the same for every seat of a ride.
    pub ends: Vec<(u64, replica::encode::Value)>,
}

/// What a ride's trip set going and its end sets back (N14): each field its `start` form's effects `set` (a cable car's
/// `under_way`), with that field's default, by field number. A trip ends when its seats next come to a stop
/// (`crate::slots::Slots::trip_ended`), so a ride once set off is boardable again and never stays under way for good.
/// A bool or whole-number field only; another kind of field is left as its form set it.
pub fn trip_ends(entry: &Json) -> Vec<(u64, replica::encode::Value)> {
    use replica::encode::Value;
    let Some(start) = entry
        .get("ride")
        .and_then(|r| r.get("start"))
        .and_then(Json::str)
    else {
        return Vec::new();
    };
    let effects = entry
        .get("forms")
        .and_then(|f| f.get(start))
        .and_then(|f| f.get("effects"))
        .and_then(Json::arr)
        .unwrap_or(&[]);
    effects
        .iter()
        .filter(|e| e.get("change").and_then(Json::str) == Some("set"))
        .filter_map(|e| {
            let def = entry.get("state")?.get(e.get("field")?.str()?)?;
            let n = match def.get("n")? {
                Json::Int(n) => u64::try_from(*n).ok()?,
                _ => return None,
            };
            let to = match def.get("default")? {
                Json::Bool(b) => Value::Uint(u64::from(*b)),
                Json::Int(v) => match (u64::try_from(*v), i64::try_from(*v)) {
                    (Ok(u), _) => Value::Uint(u),
                    (_, Ok(i)) => Value::Nint(i.unsigned_abs() - 1),
                    _ => return None,
                },
                _ => return None,
            };
            Some((n, to))
        })
        .collect()
}

/// A point of the entry, `[x, y, z]` mm, in µm.
fn at_mm(v: Option<&Json>) -> Option<Vec3> {
    let a = v?.arr()?;
    let n = |k: usize| match a.get(k)? {
        Json::Int(n) => i64::try_from(*n).ok()?.checked_mul(1000),
        _ => None,
    };
    Some(Vec3::new(n(0)?, n(1)?, n(2)?))
}

/// The midpoint of `a` and `b`, halves toward zero.
fn mid(a: Vec3, b: Vec3) -> Vec3 {
    Vec3::new((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
}

/// Where a thing's riders' slots run (see the module doc), from its entry `entry`, starting at world time `t0`.
/// `registered`: each of its body slots as registered where the thing stands, by slot number (the entry's order, from
/// 1), `to_floor`
/// carries a point of the thing's frame into the floor's (µm), and `ground(x, z)` is the floor's height there (floor
/// frame, µm; `None`: the point's own height). A seat the ride does not list, or whose run does not load, has none; a
/// thing whose entry has no ride of two stops has none.
pub fn seat_runs(
    entry: &Json,
    registered: &BTreeMap<u64, PlaceAt>,
    to_floor: &dyn Fn(Vec3) -> Option<Vec3>,
    ground: &dyn Fn(i64, i64) -> Option<i64>,
    t0: Micros,
) -> Vec<SeatRun> {
    let Some(ride) = Ride::of(entry) else {
        return Vec::new();
    };
    if ride.one_stop || ride.speed <= 0 {
        return Vec::new();
    }
    let Some(r) = entry.get("ride") else {
        return Vec::new();
    };
    let names = |v: &Json| -> Vec<String> {
        v.arr()
            .unwrap_or(&[])
            .iter()
            .filter_map(Json::str)
            .map(str::to_owned)
            .collect()
    };
    let points = entry.get("points");
    let slots = entry.get("slots");
    let stop_names = r.get("stops").map(names).unwrap_or_default();
    // The slots it carries riders in: the section's list, beside `stops`, that names the entry's own slots.
    let listed: Vec<String> = r
        .obj()
        .unwrap_or(&[])
        .iter()
        .filter(|(k, _)| k != "stops")
        .map(|(_, v)| names(v))
        .find(|l| !l.is_empty() && l.iter().all(|n| slots.and_then(|s| s.get(n)).is_some()))
        .unwrap_or_default();
    let number = |name: &str| {
        (1u64..)
            .zip(slots?.obj()?)
            .find_map(|(n, (k, _))| (k == name).then_some(n))
    };
    // The ride's stops: each one's name and point (thing frame).
    let stops: Vec<(String, Vec3)> = stop_names
        .iter()
        .filter_map(|n| Some((n.clone(), at_mm(points?.get(n)?.get("at_mm"))?)))
        .collect();
    if stops.len() < 2 || stops.len() != stop_names.len() {
        return Vec::new();
    }
    // Each listed seat: its name, declared point and its own stand point's name.
    let declared: Vec<(String, Vec3, String)> = listed
        .iter()
        .filter_map(|n| {
            let s = slots?.get(n)?;
            Some((
                n.clone(),
                at_mm(s.get("at_mm"))?,
                s.get("stand")?.str()?.to_owned(),
            ))
        })
        .collect();
    let floor_y = |p: Vec3| -> Option<i64> {
        let f = to_floor(Vec3::new(p.x, 0, p.z))?;
        Some(ground(f.x, f.z).unwrap_or(f.y))
    };
    let ends = trip_ends(entry);
    let mut out = Vec::new();
    for (k, (name, point, own)) in declared.iter().enumerate() {
        let Some(base) = number(name).and_then(|n| registered.get(&n)) else {
            continue;
        };
        // The stations (thing frame) and, for each, the stand point it is left at.
        let (stations, shape): (Vec<(Vec3, Vec3)>, Shape) = if ride.returns {
            let Some(o) = stops.iter().position(|(n, _)| n == own) else {
                continue;
            };
            let (_, op) = &stops[o];
            let Some(g0) = floor_y(*op) else {
                continue;
            };
            let mut st = Vec::new();
            for j in 0..stops.len() {
                let (_, sp) = &stops[(o + j) % stops.len()];
                let Some(g) = floor_y(*sp) else {
                    break;
                };
                let at = Vec3::new(
                    sp.x + point.x - op.x,
                    point.y + (g - g0),
                    sp.z + point.z - op.z,
                );
                st.push((at, *sp));
            }
            (st, Shape::ThereAndBack)
        } else {
            let n = declared.len();
            if n < 3 {
                continue;
            }
            let ring: Vec<Vec3> = (0..n)
                .map(|j| mid(declared[(k + j + n - 1) % n].1, declared[(k + j) % n].1))
                .collect();
            // Its riders get on and off at its own stand point, the platform's.
            let Some(stand) = points.and_then(|p| at_mm(p.get(own)?.get("at_mm"))) else {
                continue;
            };
            let st = ring.into_iter().map(|p| (p, stand)).collect();
            (st, Shape::Loop)
        };
        if stations.len() < 2 {
            continue;
        }
        let mut course = Course {
            stations: stations
                .iter()
                .map(|(at, _)| Station {
                    at: *at,
                    dwell: SEAT_STOP,
                })
                .collect(),
            shape,
            speed: ride.speed,
            t0,
            within: Micros::MAX / 4,
        };
        // It states the time from leaving a stop to reaching the next: a stop is always reached within a lap.
        let Ok(table) = course.load() else {
            continue;
        };
        course.within = table.period;
        // Its own stations: across and back the first (its own stop, the trip starts there); round a ring every one.
        let own_station = |i: usize| !ride.returns || i == 0;
        // The registered place's stand point (moved clear of a wall or a doorway at registration, as the case may be),
        // in the floor's frame, where a form walks the rider and where it is set down at its own stop.
        let registered_stand = base.stand().ok();
        let [w, x, y, z] = base.facing.parts();
        let back = replica::pose::Quat::new(w, -x, -y, -z).ok();
        let at_stops = stations
            .iter()
            .enumerate()
            .filter_map(|(i, (at, stand))| {
                let p = to_floor(*at)?;
                let height = p.y - floor_y(*stand)?;
                if !(0..=STANDARD_REACH).contains(&height) {
                    return None;
                }
                let offset = match (own_station(i), registered_stand, back) {
                    (true, Some(s), Some(q)) => {
                        let d = q.rotate(Vec3::new(s.x - p.x, 0, s.z - p.z)).ok()?;
                        [d.x, d.z]
                    }
                    _ => [stand.x - at.x, stand.z - at.z],
                };
                Some((
                    i,
                    PlaceAt {
                        thing: base.thing,
                        place: Place {
                            slot: base.place.slot,
                            height,
                            stand: offset,
                        },
                        point: p,
                        facing: base.facing,
                        floor: base.floor,
                        more: base.more.clone(),
                    },
                ))
            })
            .collect::<Vec<_>>();
        let own = at_stops
            .iter()
            .map(|(i, _)| *i)
            .filter(|i| own_station(*i))
            .collect();
        out.push(SeatRun {
            slot: base.place.slot,
            course,
            stops: at_stops,
            own,
            ends: ends.clone(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::rules::json::parse;
    use replica::time::Micros;

    fn ride(text: &str) -> Ride {
        Ride::of(&parse(text).unwrap()).unwrap()
    }

    #[test]
    fn a_ride_that_comes_back_to_its_one_stop_flies_a_loop_aloft_and_others_get_none() {
        let air = ride(
            r#"{"ride":{"stops":["door","door"],"returns":false,"speed_mm_s":3000,"ground":"air"}}"#,
        );
        assert!(air.loops_aloft());
        let home = Vec3::new(290_000_000, 0, 65_000_000);
        let c = course(&air, home, |_, _| Some(0), 0).expect("a loop");
        let t = c.load().unwrap();
        // The ring round its home and the wait take about six and a half minutes, here at the ride's 3 m/s.
        assert!(
            (360_000_000..420_000_000).contains(&t.period),
            "{}",
            t.period
        );
        // At its home only it stops, for a minute; after that it is aloft, 40 m to 80 m up on the ring.
        let stopped = t.stopped(0).unwrap().expect("at its stop");
        assert_eq!(stopped.station, 0);
        assert_eq!(t.at(0).unwrap().0, home);
        let mut highest = 0;
        let mut lowest = i64::MAX;
        for s in (70..t.period / 1_000_000 - 40).map(|s| s * 1_000_000) {
            assert!(t.stopped(s).unwrap().is_none(), "no stop aloft at {s}");
            let p = t.at(s).unwrap().0;
            if (p.x - home.x).abs() > 1_000_000 || (p.z - home.z).abs() > 1_000_000 {
                highest = highest.max(p.y);
                lowest = lowest.min(p.y);
            }
        }
        assert!(
            lowest >= 39_000_000 && highest <= 80_000_000,
            "{lowest}..{highest}"
        );
        assert_eq!(c.within, t.period - BOARDING);
        // The ring rides over the ground beneath it: a hill under it lifts it.
        let hill = course(&air, home, |_, _| Some(30_000_000), 0).unwrap();
        assert!(hill.stations[5].at.y >= 30_000_000 + 40_000_000);
        // Two stops, a line back, the ground: each makes a ride that is not a loop aloft.
        for text in [
            r#"{"ride":{"stops":["boarding","alighting"],"returns":false,"speed_mm_s":1089,"ground":"level"}}"#,
            r#"{"ride":{"stops":["gate","exit_gate"],"returns":false,"speed_mm_s":1257,"ground":"level"}}"#,
            r#"{"ride":{"stops":["valley","mountain"],"returns":true,"speed_mm_s":5000,"ground":"air"}}"#,
            r#"{"ride":{"stops":["door","door"],"returns":false,"speed_mm_s":3000,"ground":"level"}}"#,
        ] {
            assert_eq!(course(&ride(text), home, |_, _| Some(0), 0), None, "{text}");
        }
        assert_eq!(Ride::of(&parse(r#"{"looks":{}}"#).unwrap()), None);
    }

    #[test]
    fn the_same_ride_and_home_give_the_same_course() {
        let air = ride(
            r#"{"ride":{"stops":["door","door"],"returns":false,"speed_mm_s":3000,"ground":"air"}}"#,
        );
        let home = Vec3::new(-20_000_000, 1_000_000, -9_000_000);
        let a = course(&air, home, |x, z| Some((x + z).rem_euclid(5_000_000)), 7).unwrap();
        let b = course(&air, home, |x, z| Some((x + z).rem_euclid(5_000_000)), 7).unwrap();
        assert_eq!(a, b);
        assert_eq!(Course::read(&a.to_value()), Some(a));
    }

    /// The seats of `entry` as a thing placed at the floor's origin, unturned, registers them: by slot number, each at
    /// its declared point, its stand point's offset from it.
    fn places_of(entry: &Json) -> BTreeMap<u64, PlaceAt> {
        let mm = |v: &Json| {
            let a = v.arr().unwrap();
            let n = |k: usize| match a[k] {
                Json::Int(n) => i64::try_from(n).unwrap() * 1000,
                _ => panic!("a whole mm"),
            };
            Vec3::new(n(0), n(1), n(2))
        };
        let thing = replica::ids::Id::new(replica::ids::Scope([0x14; 16]), 1).unwrap();
        (1u64..)
            .zip(entry.get("slots").unwrap().obj().unwrap())
            .map(|(n, (_, s))| {
                let at = mm(s.get("at_mm").unwrap());
                let stand = entry
                    .get("points")
                    .unwrap()
                    .get(s.get("stand").unwrap().str().unwrap());
                let st = mm(stand.unwrap().get("at_mm").unwrap());
                (
                    n,
                    PlaceAt {
                        thing,
                        place: Place {
                            slot: n,
                            height: at.y,
                            stand: [st.x - at.x, st.z - at.z],
                        },
                        point: at,
                        facing: replica::pose::Quat::IDENTITY,
                        floor: thing,
                        more: Vec::new(),
                    },
                )
            })
            .collect()
    }

    fn entry(name: &str) -> Json {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/rides");
        parse(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap()
    }

    #[test]
    fn n14_a_cable_cars_cabins_run_across_and_back_at_standing_height_at_each_station() {
        let e = entry("cable_car.json");
        let registered = places_of(&e);
        let flat = seat_runs(&e, &registered, &|p| Some(p), &|_, _| Some(0), 0);
        assert_eq!(flat.len(), 2, "both cabins");
        for r in &flat {
            assert_eq!(r.course.shape, Shape::ThereAndBack);
            let own = &registered[&r.slot];
            // It waits first where it is declared, at the valley station.
            assert_eq!(r.course.stations[0].at, own.point);
            let t = r.course.load().unwrap();
            assert!(matches!(t.stopped(0), Ok(Some(s)) if s.station == 0 && s.left == SEAT_STOP));
            // Both stations are stops where riders get on and off, at the cabin's height over the floor there.
            let stops: Vec<usize> = r.stops.iter().map(|(i, _)| *i).collect();
            assert_eq!(stops, vec![0, 1]);
            for (_, p) in &r.stops {
                assert_eq!(p.place.height, 450_000);
                let stand = p.stand().unwrap();
                let (dx, dz) = (stand.x - p.point.x, stand.z - p.point.z);
                assert!(
                    dx * dx / 1_000_000 + dz * dz / 1_000_000 < 9_000_000,
                    "beside its stand point"
                );
            }
            // The mountain station's stand point is where the far stop leaves its rider.
            let far = r.stops[1].1.stand().unwrap();
            assert_eq!((far.x, far.z), (5_000_000, -59_500_000));
        }
        // On a mountain the far stop rises with the ground under the mountain station, and stays at standing height.
        let hill = |_: i64, z: i64| Some(if z < 0 { 43_900_000 } else { 0 });
        let up = seat_runs(&e, &registered, &|p| Some(p), &hill, 0);
        assert_eq!(up[0].course.stations[1].at.y, 450_000 + 43_900_000);
        assert_eq!(up[0].stops[1].1.place.height, 450_000);
        // The same entry and ground give the same runs.
        let again = seat_runs(&e, &registered, &|p| Some(p), &hill, 0);
        assert_eq!(
            up.iter().map(|r| &r.course).collect::<Vec<_>>(),
            again.iter().map(|r| &r.course).collect::<Vec<_>>()
        );
    }

    #[test]
    fn n14_a_big_wheels_gondolas_turn_round_and_two_wait_at_the_platform_together() {
        let e = entry("big_wheel.json");
        let registered = places_of(&e);
        let runs = seat_runs(&e, &registered, &|p| Some(p), &|_, _| Some(0), 0);
        assert_eq!(runs.len(), 16);
        let at_platform = |r: &SeatRun, t: Micros| {
            let s = r.course.load().unwrap().stopped(t).unwrap();
            s.is_some_and(|s| r.stops.iter().any(|(i, _)| *i == s.station))
        };
        // At the start the two bottom gondolas (1 and 2) stand at the platform within reach; the rest are aloft.
        let low: Vec<u64> = runs
            .iter()
            .filter(|r| at_platform(r, 0))
            .map(|r| r.slot)
            .collect();
        assert_eq!(low, vec![1, 2]);
        for r in &runs {
            assert_eq!(r.course.shape, Shape::Loop);
            assert_eq!(
                r.stops.len(),
                2,
                "two stations of the ring are at the platform"
            );
            assert!(
                r.stops
                    .iter()
                    .all(|(_, p)| p.place.height <= STANDARD_REACH)
            );
        }
        // Each gondola comes round to the platform in its turn: gondola 9, at the top, after the wheel has turned half
        // way.
        let nine = &runs[8];
        let t = nine.course.load().unwrap();
        assert!(!at_platform(nine, 0));
        let stops: Vec<Micros> = t
            .legs
            .iter()
            .filter(|l| l.stop.is_some())
            .map(|l| l.start + 1)
            .collect();
        assert_eq!(stops.len(), 16, "it stops at every step");
        let first = stops.iter().position(|&s| at_platform(nine, s));
        assert_eq!(
            first,
            Some(8),
            "half the wheel round, eight steps, then the platform"
        );
        // The carousel's horses go round too, and every station is one to get on and off at.
        let c = entry("carousel.json");
        let horses = seat_runs(&c, &places_of(&c), &|p| Some(p), &|_, _| Some(0), 0);
        assert_eq!(horses.len(), 6);
        assert!(horses.iter().all(|r| r.stops.len() == 6));
    }

    /// N14 review: a slot is boarded at its own stations, marked by index, and stands its rider at the registered
    /// place's stand point there, as registration placed it (moved clear of a wall, or on a turned ride), never by
    /// matching recomputed points.
    #[test]
    fn n14_own_stations_are_marked_and_stand_the_rider_where_the_place_was_registered() {
        let near = |a: Vec3, b: Vec3| (a.x - b.x).abs() <= 1 && (a.z - b.z).abs() <= 1;
        // The cable car, its red cabin's stand point moved 500 mm at registration: its own stop is station 0, and the
        // rider is set down at the moved point there; at the mountain at the mountain station's.
        let e = entry("cable_car.json");
        let mut registered = places_of(&e);
        registered.get_mut(&1).unwrap().place.stand[0] += 500_000;
        let moved = registered[&1].stand().unwrap();
        let runs = seat_runs(&e, &registered, &|p| Some(p), &|_, _| Some(0), 0);
        let red = runs.iter().find(|r| r.slot == 1).unwrap();
        assert_eq!(red.own, std::collections::BTreeSet::from([0]));
        assert!(near(red.stops[0].1.stand().unwrap(), moved));
        assert!(near(
            red.stops[1].1.stand().unwrap(),
            Vec3::new(5_000_000, 0, -59_500_000)
        ));
        // The big wheel turned 37° where it stands: every station within reach is its own, and each stands the rider at
        // the registered stand point to the micrometre's rounding.
        let e = entry("big_wheel.json");
        let q = replica::pose::Quat::from_yaw_mdeg(37_000).unwrap();
        let registered: BTreeMap<u64, PlaceAt> = places_of(&e)
            .into_iter()
            .map(|(n, mut p)| {
                p.point = q.rotate(p.point).unwrap();
                p.facing = q;
                (n, p)
            })
            .collect();
        let runs = seat_runs(&e, &registered, &|p| q.rotate(p).ok(), &|_, _| Some(0), 0);
        for r in &runs {
            assert_eq!(r.own.len(), 2, "slot {}", r.slot);
            let own = registered[&r.slot].stand().unwrap();
            for (i, p) in &r.stops {
                assert!(r.own.contains(i));
                assert!(near(p.stand().unwrap(), own), "slot {} station {i}", r.slot);
            }
        }
    }
}
