//! Day, night, weather and the calendar on the world's own node (Engine v2 E6, #2755): the fields that hold them and
//! the named events that announce a change, so a copy that applies the log reads the same light, date and weather as
//! the world. `sim::daylight` decides what to write and when.
//!
//! - **Settings** are fields the world's start (or a creator) writes: the length of a calendar day in world seconds,
//!   the civil time at world time 0, the zone's UTC offsets from the world time each starts, the light table (the
//!   boundaries of the day, in µs after local midnight, each with the light it begins), the weather's seed, and the
//!   end of a weather a creator set (G5 writes it; this defines it).
//! - **What the world announces** is a field each, with the world time of its next change: the light; the date and
//!   weekday; the weather's kind and its whole-number levels (0 to 100) of cloud, rain and wind.
//! - **Local time** is world time through the calendar: civil µs = origin + world µs · 86,400 / day length, on T5's
//!   rising [`Line`] (rounds down; its inverse rounds up), plus the offset in force. Nothing reads a machine's clock.
//!   A day of 23 or 25 hours is an offset change inside it; a new day is the local date rising, never 86,400 s later.
//! - **Facts, not judgments.** The light's names come from the world's own table; nothing here says when to act.

use std::collections::BTreeMap;

use crate::encode::{Name, Value};
use crate::time::{Fraction, Line, Micros, TimeRefusal};

/// World seconds in a calendar day (86,400 on a real-time world).
pub const F_DAY_S: u64 = 60;
/// Civil µs since 1970-01-01T00:00 UTC at world time 0.
pub const F_CIVIL_ORIGIN: u64 = 61;
/// `[[world µs, offset µs], ...]`, ascending: the zone's UTC offset from each world time on; the first is in force
/// from the world's start.
pub const F_OFFSETS: u64 = 62;
/// `[[µs after local midnight, light], ...]`, ascending: each boundary of the day and the light it begins. Before the
/// first boundary, the last one's light holds.
pub const F_LIGHT_TABLE: u64 = 63;
/// The world's seed for the weather table.
pub const F_SEED: u64 = 64;
/// A creator's weather holds until this world time (G5); the table resumes there.
pub const F_WEATHER_UNTIL: u64 = 65;
// 66 to 68 on the root are the clock's mapping (`crate::time::F_CLOCK_WORLD`, E7b).

/// How the sky is drawn (V19c, #3521; 88 to 90 since #3695, as the clock's mapping holds 66 to 68 on the same node):
/// settings no rule reads, carried for a page to draw today's sky. The month and
/// day the sky is drawn on, `[month, day]`, whatever the calendar's date (today's `state.time.calendar`: Eden's sky is
/// always 5 June); the year and the hour stay the calendar's.
pub const F_SKY_DATE: u64 = 88;
/// The sky palette's name (today's `state.sky.palette`, as `souls:<palette>`).
pub const F_PALETTE: u64 = 89;
/// The morning mist: `[peak, half-width, strength]`, the peak and half-width in µs after local midnight and the
/// strength 0 to 100 (today's `morningMist`: 06:30, 2.5 h, 100).
pub const F_MIST: u64 = 90;
/// A creator's staged hour (`souls-god time HH:MM`): the local time of day, µs after local midnight, a page draws the
/// sky and its light at, for a staged scene; the text `souls:live` (or no field) draws the world's own time. Display
/// only, like 88 to 90: no rule reads it, and world time, a Soul's clock and the calendar never change for it.
pub const F_SKY_HOUR: u64 = 91;
/// The creator's last lightning strike (#3695, today's `strike`): `[x, z, at]`, the point in mm on the world's open
/// ground and the world time it struck. A page draws the bolt and plays the thunder once, near `at`; nothing reads it.
pub const F_STRIKE: u64 = 69;

/// The value a creator's sky field on the world node reads as unset, so an undo can take back the batch that added it
/// (T6 has no unset; `sim::edit::undo`): a creator's weather that ended at world time 0, which `sim::daylight` reads
/// as none, and no strike, as both page readers read a list that is not three numbers. Only on the world's root node:
/// a content kind may number a thing's own state field 65 or 69 (`crate::fields`).
pub fn unset_on_world(field: u64) -> Option<Value> {
    match field {
        F_WEATHER_UNTIL => Some(Value::Uint(0)),
        F_STRIKE => Some(Value::Array(Vec::new())),
        _ => None,
    }
}

/// The light now, and the world time it next changes.
pub const F_LIGHT: u64 = 70;
pub const F_LIGHT_NEXT: u64 = 71;
/// The local date `[year, month, day]`, its ISO weekday (1 Monday to 7 Sunday), and the world time of the next day.
pub const F_DATE: u64 = 72;
pub const F_WEEKDAY: u64 = 73;
pub const F_DAY_NEXT: u64 = 74;
/// The weather's kind, its levels of cloud, rain and wind (0 to 100), and the world time it next changes.
pub const F_WEATHER: u64 = 75;
pub const F_CLOUD: u64 = 76;
pub const F_RAIN: u64 = 77;
pub const F_WIND: u64 = 78;
pub const F_WEATHER_NEXT: u64 = 79;

/// The named events, and the names of the world node's three timers.
pub const EV_LIGHT: &str = "souls:light-changed";
pub const EV_DAY: &str = "souls:new-day";
pub const EV_WEATHER: &str = "souls:weather-changed";
pub const T_LIGHT: &str = "souls:light";
pub const T_DAY: &str = "souls:day";
pub const T_WEATHER: &str = "souls:weather";

/// One civil day, µs.
pub const DAY_US: i64 = 86_400_000_000;

pub fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

pub fn as_int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn pairs(v: &Value) -> Option<Vec<(i64, &Value)>> {
    let Value::Array(rows) = v else { return None };
    rows.iter()
        .map(|r| match r {
            Value::Array(p) if p.len() == 2 => Some((as_int(&p[0])?, &p[1])),
            _ => None,
        })
        .collect()
}

/// How world time becomes local time: the day's length, the civil origin and the zone's offsets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Calendar {
    pub day_s: i64,
    pub origin: Micros,
    pub offsets: Vec<(Micros, Micros)>,
}

impl Calendar {
    /// The calendar the world node's fields hold, or `None` when a setting is missing or malformed.
    pub fn read(f: &BTreeMap<u64, Value>) -> Option<Calendar> {
        let offsets = pairs(f.get(&F_OFFSETS)?)?
            .into_iter()
            .map(|(t, o)| Some((t, as_int(o)?)))
            .collect::<Option<Vec<_>>>()?;
        let c = Calendar {
            day_s: as_int(f.get(&F_DAY_S)?)?,
            origin: as_int(f.get(&F_CIVIL_ORIGIN)?)?,
            offsets,
        };
        (c.line().is_ok() && !c.offsets.is_empty() && c.offsets.is_sorted_by_key(|o| o.0))
            .then_some(c)
    }

    pub fn fields(&self) -> Vec<(u64, Value)> {
        let offsets = self
            .offsets
            .iter()
            .map(|&(t, o)| Value::Array(vec![int(t), int(o)]))
            .collect();
        vec![
            (F_DAY_S, int(self.day_s)),
            (F_CIVIL_ORIGIN, int(self.origin)),
            (F_OFFSETS, Value::Array(offsets)),
        ]
    }

    /// Civil (UTC) µs from world µs: rises, rounds down; `x_of` gives the first world µs reaching a civil time.
    pub fn line(&self) -> Result<Line, TimeRefusal> {
        Ok(Line::new(
            0,
            self.origin,
            Fraction::new(86_400, self.day_s)?,
        ))
    }

    /// The offset in force at world time `t`, and the world time the next one starts, if any.
    pub fn segment(&self, t: Micros) -> (Micros, Option<Micros>) {
        let i = self.offsets.partition_point(|o| o.0 <= t);
        let o = self.offsets[i.saturating_sub(1)].1;
        (o, self.offsets.get(i).map(|n| n.0))
    }

    /// Local wall time at world time `t`, µs since 1970-01-01T00:00 local.
    pub fn local(&self, t: Micros) -> Result<Micros, TimeRefusal> {
        Ok(self.line()?.y_at(t)? + self.segment(t).0)
    }
}

/// The day number (since 1970-01-01) of a civil date (H. Hinnant's `days_from_civil`).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// The civil date `[year, month, day]` of a day number, and its ISO weekday (1 Monday to 7 Sunday).
pub fn civil_from_days(z: i64) -> ([i64; 3], i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    ([y, m, d], (z - 719_468 + 3).rem_euclid(7) + 1)
}

/// What a copy reads from the world node: the announced light, date and weather, each with its next change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sky {
    pub light: Name,
    pub light_next: Micros,
    pub date: [i64; 3],
    pub weekday: i64,
    pub day_next: Micros,
    pub weather: Name,
    pub levels: [i64; 3],
    pub weather_next: Micros,
}

impl Sky {
    /// The announced fields, or `None` before the world has announced them.
    pub fn read(f: &BTreeMap<u64, Value>) -> Option<Sky> {
        let n = |k| f.get(&k).and_then(as_int);
        let name = |k| match f.get(&k) {
            Some(Value::Text(t)) => Some(t.clone()),
            _ => None,
        };
        let date = match f.get(&F_DATE)? {
            Value::Array(d) if d.len() == 3 => [as_int(&d[0])?, as_int(&d[1])?, as_int(&d[2])?],
            _ => return None,
        };
        Some(Sky {
            light: name(F_LIGHT)?,
            light_next: n(F_LIGHT_NEXT)?,
            date,
            weekday: n(F_WEEKDAY)?,
            day_next: n(F_DAY_NEXT)?,
            weather: name(F_WEATHER)?,
            levels: [n(F_CLOUD)?, n(F_RAIN)?, n(F_WIND)?],
            weather_next: n(F_WEATHER_NEXT)?,
        })
    }
}

/// The morning mist's shape: its peak and half-width (µs after local midnight) and its strength, 0 to 100.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mist {
    pub peak: Micros,
    pub half: Micros,
    pub strength: i64,
}

/// How a world's sky is drawn (V19c): each setting optional; a world without them is drawn on its calendar's date,
/// with the default sky and no morning mist.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Presentation {
    pub date: Option<[i64; 2]>,
    pub palette: Option<Name>,
    pub mist: Option<Mist>,
}

impl Presentation {
    /// The settings the world node's fields hold; a malformed one reads as absent.
    pub fn read(f: &BTreeMap<u64, Value>) -> Presentation {
        let date = match f.get(&F_SKY_DATE) {
            Some(Value::Array(d)) if d.len() == 2 => as_int(&d[0])
                .zip(as_int(&d[1]))
                .map(|(m, d)| [m, d])
                .filter(|&[m, d]| month_day(m, d)),
            _ => None,
        };
        let palette = match f.get(&F_PALETTE) {
            Some(Value::Text(n)) => Some(n.clone()),
            _ => None,
        };
        let mist = match f.get(&F_MIST) {
            Some(Value::Array(v)) if v.len() == 3 => {
                match (as_int(&v[0]), as_int(&v[1]), as_int(&v[2])) {
                    (Some(peak), Some(half), Some(strength)) => Some(Mist {
                        peak,
                        half,
                        strength,
                    })
                    .filter(|m| {
                        (0..DAY_US).contains(&m.peak)
                            && m.half > 0
                            && (0..=100).contains(&m.strength)
                    }),
                    _ => None,
                }
            }
            _ => None,
        };
        Presentation {
            date,
            palette,
            mist,
        }
    }

    /// The settings as the world node's fields (the ones set).
    pub fn fields(&self) -> Vec<(u64, Value)> {
        let mut f = Vec::new();
        f.extend(
            self.date
                .map(|[m, d]| (F_SKY_DATE, Value::Array(vec![int(m), int(d)]))),
        );
        f.extend(self.palette.clone().map(|n| (F_PALETTE, Value::Text(n))));
        f.extend(self.mist.map(|m| {
            let v = vec![int(m.peak), int(m.half), int(m.strength)];
            (F_MIST, Value::Array(v))
        }));
        f
    }
}

/// A month and day some year has (29 February included).
fn month_day(m: i64, d: i64) -> bool {
    const DAYS: [i64; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    (1..=12).contains(&m) && (1..=DAYS[(m - 1) as usize]).contains(&d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_presentation_round_trips_and_refuses_malformed_settings() {
        let p = Presentation {
            date: Some([6, 5]),
            palette: Name::new("souls:eden-summer"),
            mist: Some(Mist {
                peak: 23_400_000_000,
                half: 9_000_000_000,
                strength: 100,
            }),
        };
        let f: BTreeMap<u64, Value> = p.fields().into_iter().collect();
        assert_eq!(Presentation::read(&f), p);
        assert_eq!(
            Presentation::read(&BTreeMap::new()),
            Presentation::default()
        );
        assert!(Presentation::default().fields().is_empty());
        let bad = BTreeMap::from([
            (F_SKY_DATE, Value::Array(vec![int(2), int(30)])),
            (F_MIST, Value::Array(vec![int(DAY_US), int(1), int(50)])),
        ]);
        assert_eq!(Presentation::read(&bad), Presentation::default());
    }

    #[test]
    fn civil_dates_round_trip() {
        assert_eq!(civil_from_days(0), ([1970, 1, 1], 4));
        assert_eq!(days_from_civil(2026, 11, 18), 20_775);
        assert_eq!(civil_from_days(20_775), ([2026, 11, 18], 3));
        for z in [-800_000, -1, 59, 60, 11_016, 2_932_896] {
            let ([y, m, d], _) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
    }
}
