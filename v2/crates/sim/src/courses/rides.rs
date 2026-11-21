//! The courses of the rides a world's entries declare (#3691): a kind's `ride` section (`content/kinds`, `souls-entry/1`:
//! `{stops, returns, speed_mm_s, ground, …}`) read as data, never by the kind's name. A ride whose stops are all one
//! point, that does not return along a line and whose ground is the air is a vehicle that lifts off its stop and comes
//! back to it: it flies today's loop round its own home (`apps/server/src/god/rides.ts` `balloonRoute`, the ring a
//! god's balloon flies): straight up above its home, a 150 m ring that rises and falls between 40 m and 80 m over the
//! ground beneath it, and straight down again, at the ride's own speed, waiting at its home for riders for 30 s each lap.
//! At its home is the only stop, so riders board and leave there only (`crate::slots` `boardable`), as a punt's.
//!
//! A ride with two different stops (riders board at one point of the thing and leave at another) moves its riders inside
//! a thing that stays where it is: a frame that turns, or seats that move, which a course does not express (N14). It
//! gets no course here.
//!
//! Integer arithmetic only (T4): the ring's 16 directions are the punts' fixed table, no platform `sin` or `cos`.

use super::punts::{TURN16, ppm};
use super::{Course, Shape, Station};
use replica::pose::Vec3;
use replica::rules::json::Value as Json;
use replica::time::Micros;

/// How long a ride waits at its stop for riders each lap, µs (a punt's 30 s).
pub const BOARDING: Micros = 30_000_000;
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

#[cfg(test)]
mod tests {
    use super::*;
    use replica::rules::json::parse;

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
        // Today's ring round its home takes about six minutes, here at the ride's 3 m/s.
        assert!(
            (330_000_000..390_000_000).contains(&t.period),
            "{}",
            t.period
        );
        // At its home only it stops, for 30 s; after that it is aloft, 40 m to 80 m up on the ring.
        let stopped = t.stopped(0).unwrap().expect("at its stop");
        assert_eq!(stopped.station, 0);
        assert_eq!(t.at(0).unwrap().0, home);
        let mut highest = 0;
        let mut lowest = i64::MAX;
        for s in (40..t.period / 1_000_000 - 40).map(|s| s * 1_000_000) {
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
}
