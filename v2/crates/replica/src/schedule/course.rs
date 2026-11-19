//! A moving node's track (Engine v2 N12, #2737; moved here from `sim::courses` by E7, #2756): the formula the node
//! stores as data and every copy reads, so the world, the client and the page compute the same positions and the
//! same timetable from it. Nothing is stepped or written per tick, and no timetable is stored: [`Table::next`] reads
//! the next stops from the formula.
//!
//! - **The formula.** A [`Course`] is a list of stations (a point in the parent's frame, µm, and a dwell, µs: a
//!   stop dwells, a waypoint does not), a shape (a loop, or a line there and back), a speed and a start time. Loaded
//!   ([`Course::load`]) it is a fixed [`Table`] of legs, each a dwell or a straight move, with whole-microsecond
//!   durations. The node's position at world time `t` is read from the table by integer interpolation, one rounding
//!   per number (T4 rule 3). Orientation is constant (T4 rule 8); no platform `sin` or `cos` is used.
//! - **Stops.** A loaded track states the time within which a stop is always reached (`within`); a table with a gap
//!   between stops longer than that, or with no stop, is refused at load as `track-no-stop-within`.
//! - **Stored** as the node's field [`super::F_COURSE`]: `{1: [[[x, y, z], dwell], ...], 2: shape (1 a loop, 2 there
//!   and back), 3: speed µm/s, 4: start µs, 5: within µs}` ([`Course::to_value`], [`Course::read`]).

use crate::effects::Refusal;
use crate::encode::Value;
use crate::ids::Id;
use crate::pose::{Frame, Movable, Owner, Pose, Quat, Support, Track, Vec3};
use crate::sky::{as_int, int};
use crate::time::Micros;
use std::collections::BTreeMap;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

const MICRO: i128 = 1_000_000;

/// `n / d`, halves away from zero (T4 rule 3); `d` is positive.
fn div_round(n: i128, d: i128) -> i128 {
    if n >= 0 {
        (n + d / 2) / d
    } else {
        -((-n + d / 2) / d)
    }
}

/// A point of a track: where it is in the parent's frame (µm), and how long the frame stands there (µs). A station
/// with a dwell is a stop; one without is a waypoint the frame passes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Station {
    pub at: Vec3,
    pub dwell: Micros,
}

/// How the stations are run: in a loop (the last back to the first), or along a line and back again (the end
/// stations dwell once a turn, the others once each way).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Loop,
    ThereAndBack,
}

/// A track as the moving node stores it: data, read by its formula, never stepped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Course {
    pub stations: Vec<Station>,
    pub shape: Shape,
    /// Speed between stations, µm a second.
    pub speed: i64,
    /// World time the first station's dwell begins, µs.
    pub t0: Micros,
    /// The time within which a stop is always reached, µs: what the track states and its load checks.
    pub within: Micros,
}

/// One leg of a loaded track: from `from` to `to` (equal for a dwell), starting `start` µs into the lap and lasting
/// `dur` µs; a dwell names its station.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leg {
    pub from: Vec3,
    pub to: Vec3,
    pub start: Micros,
    pub dur: Micros,
    pub stop: Option<usize>,
}

/// A loaded track: the fixed table of legs one lap runs, its period and its start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Table {
    pub legs: Vec<Leg>,
    pub period: Micros,
    pub t0: Micros,
}

/// Where the frame stands while it dwells: the station, and the time left of the dwell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stopped {
    pub station: usize,
    pub left: Micros,
}

impl Course {
    /// The fixed table, checked: at least two stations and a positive speed (`track-malformed`), and a stop
    /// reached from any time within `within` (`track-no-stop-within`).
    pub fn load(&self) -> R<Table> {
        let n = self.stations.len();
        if n < 2 || self.speed <= 0 || self.stations.iter().any(|s| s.dwell < 0) {
            return refuse(
                "track-malformed",
                format!(
                    "{n} stations at {} um/s: a track needs two and a speed",
                    self.speed
                ),
            );
        }
        let order: Vec<usize> = match self.shape {
            Shape::Loop => (0..n).collect(),
            Shape::ThereAndBack => (0..n).chain((1..n - 1).rev()).collect(),
        };
        let mut legs = Vec::new();
        let mut at: Micros = 0;
        for (k, &i) in order.iter().enumerate() {
            let s = self.stations[i];
            if s.dwell > 0 {
                legs.push(Leg {
                    from: s.at,
                    to: s.at,
                    start: at,
                    dur: s.dwell,
                    stop: Some(i),
                });
                at += s.dwell;
            }
            let next = self.stations[order[(k + 1) % order.len()]].at;
            let d = [next.x - s.at.x, next.y - s.at.y, next.z - s.at.z].map(i128::from);
            let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).isqrt();
            if len == 0 {
                continue;
            }
            // Whole microseconds, rounded up: the frame never goes faster than its speed.
            let speed = i128::from(self.speed);
            let dur = Micros::try_from((len * MICRO + speed - 1) / speed).map_err(|_| Refusal {
                name: "track-malformed",
                detail: "a leg too long".into(),
            })?;
            legs.push(Leg {
                from: s.at,
                to: next,
                start: at,
                dur,
                stop: None,
            });
            at += dur;
        }
        let table = Table {
            legs,
            period: at,
            t0: self.t0,
        };
        let longest = table.longest_without_stop();
        match longest {
            Some(gap) if gap <= self.within => Ok(table),
            _ => refuse(
                "track-no-stop-within",
                match longest {
                    Some(gap) => format!("{gap} us between stops, {} us stated", self.within),
                    None => "no station dwells".into(),
                },
            ),
        }
    }
}

impl Table {
    /// The longest time from the end of one dwell to the start of the next, round the lap (`None`: no dwell).
    fn longest_without_stop(&self) -> Option<Micros> {
        let dwells: Vec<&Leg> = self.legs.iter().filter(|l| l.stop.is_some()).collect();
        let first = dwells.first()?;
        let mut longest = 0;
        for (k, d) in dwells.iter().enumerate() {
            let end = d.start + d.dur;
            let next = dwells
                .get(k + 1)
                .map_or(first.start + self.period, |n| n.start);
            longest = longest.max(next - end);
        }
        Some(longest)
    }

    /// The leg the frame is on at world time `t`, and how far into it (µs). `before-track-start` before `t0`.
    fn leg(&self, t: Micros) -> R<(&Leg, Micros)> {
        if t < self.t0 {
            return refuse(
                "before-track-start",
                format!("{t} us, the track starts at {}", self.t0),
            );
        }
        let phase = (t - self.t0) % self.period;
        let k = self.legs.partition_point(|l| l.start <= phase) - 1;
        let leg = &self.legs[k];
        Ok((leg, phase - leg.start))
    }

    /// The frame's position (µm, in the parent's frame) and velocity (µm a second) at world time `t`: a formula of
    /// the time, one rounding per number.
    pub fn at(&self, t: Micros) -> R<(Vec3, Vec3)> {
        let (leg, into) = self.leg(t)?;
        if leg.stop.is_some() {
            return Ok((leg.from, Vec3::ZERO));
        }
        let (a, b) = (leg.from, leg.to);
        let dur = i128::from(leg.dur);
        let step = |a: i64, b: i64| -> (i64, i64) {
            let d = i128::from(b - a);
            let p = i128::from(a) + div_round(d * i128::from(into), dur);
            let v = div_round(d * MICRO, dur);
            // Both lie between the leg's ends, and a speed in µm a second fits: the casts cannot fail.
            (p as i64, v as i64)
        };
        let [x, y, z] = [step(a.x, b.x), step(a.y, b.y), step(a.z, b.z)];
        Ok((Vec3::new(x.0, y.0, z.0), Vec3::new(x.1, y.1, z.1)))
    }

    /// The station the frame dwells at at world time `t`, and the time left of that dwell, if it is stopped.
    pub fn stopped(&self, t: Micros) -> R<Option<Stopped>> {
        let (leg, into) = self.leg(t)?;
        Ok(leg.stop.map(|station| Stopped {
            station,
            left: leg.dur - into,
        }))
    }

    /// The moving node as T4's scene holds it at world time `t`: its pose at the formula's position, owned at rest
    /// while it dwells and by a straight track from there while it moves, so a rider's motion at `t` comes from its
    /// frame (`Scene::motion`). A view read from the table, never stored.
    pub fn movable(
        &self,
        id: Id,
        frame: Frame,
        support: Support,
        orientation: Quat,
        slots: BTreeMap<u64, Vec3>,
        t: Micros,
    ) -> R<Movable> {
        let (position, linear) = self.at(t)?;
        let owner = if linear == Vec3::ZERO {
            Owner::Track(Track::Rest)
        } else {
            Owner::Track(Track::Straight {
                t0: t,
                velocity: linear,
            })
        };
        Ok(Movable {
            id,
            pose: Pose {
                frame,
                position,
                orientation,
                support,
            },
            owner,
            linear,
            angular: Vec3::ZERO,
            slots,
        })
    }
}

/// One stop of the timetable: the station, when the frame arrives there and when it leaves, world µs. A stop in
/// progress at the time asked about has arrived already.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stop {
    pub station: usize,
    pub arrives: Micros,
    pub leaves: Micros,
}

impl Table {
    /// The next `n` stops from world time `t` (at `station` only, when given), read from the formula: a stop the
    /// frame stands at, at `t`, comes first. Empty when the station never dwells.
    pub fn next(&self, t: Micros, station: Option<usize>, n: usize) -> Vec<Stop> {
        let dwells: Vec<(usize, &Leg)> = self
            .legs
            .iter()
            .filter_map(|l| l.stop.map(|s| (s, l)))
            .filter(|(s, _)| station.is_none_or(|w| w == *s))
            .collect();
        let mut out = Vec::new();
        // The start of the lap `t` falls in (the first lap, before the track starts).
        let mut lap = if t < self.t0 {
            self.t0
        } else {
            t - (t - self.t0) % self.period
        };
        while !dwells.is_empty() && out.len() < n {
            for &(s, leg) in &dwells {
                let arrives = lap.saturating_add(leg.start);
                let leaves = arrives.saturating_add(leg.dur);
                if leaves > t && out.len() < n {
                    out.push(Stop {
                        station: s,
                        arrives,
                        leaves,
                    });
                }
            }
            let Some(next) = lap.checked_add(self.period) else {
                break;
            };
            lap = next;
        }
        out
    }
}

impl Course {
    /// The track as the node's field stores it (the module's notes).
    pub fn to_value(&self) -> Value {
        let xyz = |p: Vec3| Value::Array(vec![int(p.x), int(p.y), int(p.z)]);
        let stations = self
            .stations
            .iter()
            .map(|s| Value::Array(vec![xyz(s.at), int(s.dwell)]))
            .collect();
        let shape = match self.shape {
            Shape::Loop => 1,
            Shape::ThereAndBack => 2,
        };
        Value::Map(BTreeMap::from([
            (1, Value::Array(stations)),
            (2, Value::Uint(shape)),
            (3, int(self.speed)),
            (4, int(self.t0)),
            (5, int(self.within)),
        ]))
    }

    /// The track a node's field holds, or `None` when it is not one. [`Course::load`] checks it.
    pub fn read(v: &Value) -> Option<Course> {
        let Value::Map(m) = v else { return None };
        let n = |k| m.get(&k).and_then(as_int);
        let Value::Array(rows) = m.get(&1)? else {
            return None;
        };
        let station = |r: &Value| -> Option<Station> {
            let Value::Array(r) = r else { return None };
            let [Value::Array(p), dwell] = r.as_slice() else {
                return None;
            };
            let [x, y, z] = p.as_slice() else { return None };
            Some(Station {
                at: Vec3::new(as_int(x)?, as_int(y)?, as_int(z)?),
                dwell: as_int(dwell)?,
            })
        };
        Some(Course {
            stations: rows.iter().map(station).collect::<Option<Vec<_>>>()?,
            shape: match n(2)? {
                1 => Shape::Loop,
                2 => Shape::ThereAndBack,
                _ => return None,
            },
            speed: n(3)?,
            t0: n(4)?,
            within: n(5)?,
        })
    }
}
