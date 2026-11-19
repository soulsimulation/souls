//! Day, night, weather and the date (Engine v2 E6, #2755): the world's own node announces each change of light, each
//! change of weather and each new day as one effect with a named event, and nothing runs in between.
//!
//! - **Three timers on the world node** (K9): `souls:light`, `souls:day` and `souls:weather`, each due at its field's
//!   next change. A fire runs with "now" at its due time, writes the new value with its event and the time of the next
//!   change, and its caller clears the fired timer and sets the next. A world that jumps 48 hours writes the same
//!   effects at the same world times as one stepped, because every value is a function of world time alone.
//! - **One table for the light** (`replica::sky::F_LIGHT_TABLE`), data on the world node. Today's server cut the day
//!   three ways (`edge/events`, `edge/eyes/sight.ts`, `edge/perception/here.ts`); the default is sight.ts's, the one
//!   the picture and the caption use, with its 05:30 light named dawn as here.ts names it.
//! - **The date** is local time's day ([`replica::sky::Calendar`]), from world time alone. A new day is the date
//!   rising past the one announced, so a day of 23 or 25 hours writes one, and a fall back across midnight none.
//! - **The weather** is what a creator set until its end (G5); otherwise a kind per two-hour slot of local time, drawn
//!   from the world's seed by (day, slot), with today's regimes and weights (`edge/eyes/sight.ts`) as whole numbers and
//!   its rule that a shower lasts one slot. The kind's levels of cloud, rain and wind are whole numbers.
//!
//! Not here: seasons, sun and shade, warmth, weather that changes movement, and the tick loop that writes entries.

use std::collections::BTreeMap;

use replica::effects::{Change, Event, Refusal, Rest};
use replica::encode::{Name, Value};
use replica::ids::Id;
use replica::sky::{self, Calendar, DAY_US, Sky, as_int, int};
use replica::time::{Micros, TimeRefusal};

const HOUR_US: i64 = 3_600_000_000;
const SLOT_US: i64 = 2 * HOUR_US;
/// Edges looked through for a change before a timer is set anyway (its fire then writes no event).
const MOST_EDGES: usize = 10_000;

const KINDS: [&str; 6] = [
    "souls:clear",
    "souls:cloudy",
    "souls:rain",
    "souls:wind",
    "souls:fog",
    "souls:storm",
];
/// Each kind's cloud, rain and wind, 0 to 100.
const LEVELS: [[i64; 3]; 6] = [
    [10, 0, 10],
    [75, 0, 20],
    [90, 60, 30],
    [30, 0, 70],
    [60, 0, 5],
    [100, 90, 80],
];
/// Today's regimes (fair, unsettled, misty, breezy) and each one's weights for the kinds, per 10,000.
const REGIMES: [u64; 4] = [340, 260, 200, 200];
const WEIGHTS: [[u64; 6]; 4] = [
    [6400, 2400, 50, 1150, 0, 0],
    [2200, 4200, 1150, 2100, 0, 350],
    [3300, 3000, 150, 0, 3550, 0],
    [4200, 2000, 150, 3600, 0, 50],
];
/// Today's light table (`edge/eyes/sight.ts`), local minutes.
const TODAY: [(i64, &str); 5] = [
    (330, "souls:dawn"),
    (420, "souls:day"),
    (1080, "souls:evening"),
    (1170, "souls:dusk"),
    (1260, "souls:night"),
];

fn name(s: &str) -> Name {
    Name::new(s).expect("a constant name")
}

fn time(e: TimeRefusal) -> Refusal {
    Refusal {
        name: e.name(),
        detail: "the world's calendar".into(),
    }
}

fn mix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

fn pick(weights: &[u64], draw: u64) -> usize {
    let mut x = draw % weights.iter().sum::<u64>().max(1);
    for (i, &w) in weights.iter().enumerate() {
        if x < w {
            return i;
        }
        x -= w;
    }
    weights.len() - 1
}

fn wet(k: usize) -> bool {
    k == 2 || k == 5
}

/// The world's settings: its calendar, its light table, its weather seed and the end of a creator's weather.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub cal: Calendar,
    pub table: Vec<(Micros, Name)>,
    pub seed: u64,
    pub until: Option<Micros>,
}

impl Config {
    /// Today's light table and weather, on `cal`.
    pub fn today(cal: Calendar, seed: u64) -> Config {
        let table = TODAY
            .iter()
            .map(|&(m, n)| (m * 60_000_000, name(n)))
            .collect();
        Config {
            cal,
            table,
            seed,
            until: None,
        }
    }

    /// The settings the world node's fields hold, or `None` when one is missing or malformed.
    pub fn read(f: &BTreeMap<u64, Value>) -> Option<Config> {
        let Value::Array(rows) = f.get(&sky::F_LIGHT_TABLE)? else {
            return None;
        };
        let table = rows
            .iter()
            .map(|r| match r {
                Value::Array(p) if p.len() == 2 => match &p[1] {
                    Value::Text(n) => Some((as_int(&p[0])?, n.clone())),
                    _ => None,
                },
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        let ok = !table.is_empty()
            && table.is_sorted_by_key(|r| r.0)
            && table.iter().all(|r| (0..DAY_US).contains(&r.0));
        ok.then_some(Config {
            cal: Calendar::read(f)?,
            table,
            seed: u64::try_from(as_int(f.get(&sky::F_SEED)?)?).ok()?,
            until: f.get(&sky::F_WEATHER_UNTIL).and_then(as_int),
        })
    }

    /// The settings as the world node's fields.
    pub fn fields(&self) -> Vec<(u64, Value)> {
        let table = self
            .table
            .iter()
            .map(|(t, n)| Value::Array(vec![int(*t), Value::Text(n.clone())]))
            .collect();
        let mut f = self.cal.fields();
        f.push((sky::F_LIGHT_TABLE, Value::Array(table)));
        f.push((sky::F_SEED, int(i64::try_from(self.seed).unwrap_or(0))));
        f.extend(self.until.map(|u| (sky::F_WEATHER_UNTIL, int(u))));
        f
    }

    /// The light at local time `l`.
    pub fn light(&self, l: Micros) -> usize {
        let tod = l.rem_euclid(DAY_US);
        self.table
            .partition_point(|r| r.0 <= tod)
            .checked_sub(1)
            .unwrap_or(self.table.len() - 1)
    }

    /// The local time after `l` at which the light may change: its next boundary.
    fn light_edge(&self, l: Micros) -> Micros {
        let (day, tod) = (l.div_euclid(DAY_US) * DAY_US, l.rem_euclid(DAY_US));
        match self.table.iter().find(|r| r.0 > tod) {
            Some(r) => day + r.0,
            None => day + DAY_US + self.table[0].0,
        }
    }

    fn slot_kind(&self, day: i64, slot: i64, dry: bool) -> usize {
        let regime = pick(&REGIMES, mix(self.seed ^ mix(day as u64 ^ 7919 << 32)));
        let mut w = WEIGHTS[regime];
        if slot == 2 || slot == 3 {
            w[4] = w[4] * 22 / 10;
        } else if (5..=8).contains(&slot) {
            w[4] /= 4;
        }
        if (6..=8).contains(&slot) {
            w[2] = w[2] * 13 / 10;
            w[5] = w[5] * 18 / 10;
        }
        if dry {
            w[2] = 0;
            w[5] = 0;
        }
        pick(
            &w,
            mix(self.seed ^ mix(day as u64) ^ mix(slot as u64 * 131 + 17)),
        )
    }

    /// The table's weather at local time `l`: a kind per two-hour slot, and a shower lasts one slot.
    pub fn weather(&self, l: Micros) -> usize {
        let (day, slot) = (l.div_euclid(DAY_US), l.rem_euclid(DAY_US) / SLOT_US);
        let k = self.slot_kind(day, slot, false);
        let before = if slot > 0 {
            self.slot_kind(day, slot - 1, false)
        } else {
            self.slot_kind(day - 1, DAY_US / SLOT_US - 1, false)
        };
        if wet(k) && wet(before) {
            self.slot_kind(day, slot, true)
        } else {
            k
        }
    }

    /// The first world time after `now` at which `changed(value(local))` holds, where `edge(l)` is the next local
    /// time after `l` at which the value may change. Local time rises inside each offset's span and may jump at the
    /// next, so each span is walked edge by edge and its end checked on its own.
    fn next_change(
        &self,
        now: Micros,
        value: impl Fn(Micros) -> usize,
        changed: impl Fn(usize) -> bool,
        edge: impl Fn(Micros) -> Micros,
    ) -> Result<Micros, TimeRefusal> {
        let line = self.cal.line()?;
        let mut t = now;
        let mut at = now;
        for _ in 0..MOST_EDGES {
            let (o, end) = self.cal.segment(t);
            let l = line.y_at(t)? + o;
            at = line.x_of(edge(l) - o)?;
            match end {
                Some(end) if at >= end => {
                    if changed(value(self.cal.local(end)?)) {
                        return Ok(end);
                    }
                    t = end;
                }
                _ => {
                    if changed(value(line.y_at(at)? + o)) {
                        return Ok(at);
                    }
                    t = at;
                }
            }
        }
        Ok(at)
    }
}

/// What one fire writes on the world node: its changes, the named event when a value changed, and when this timer is
/// next due.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Write {
    pub timer: Name,
    pub changes: Vec<Change>,
    pub event: Option<Event>,
    pub next: Micros,
}

/// The world node's day, night, weather and date. `runs` counts its evaluations: one per fire, none in between.
pub struct Daylight {
    pub cfg: Config,
    pub world: Id,
    pub runs: u64,
}

impl Daylight {
    pub fn new(cfg: Config, world: Id) -> Daylight {
        Daylight {
            cfg,
            world,
            runs: 0,
        }
    }

    fn write(
        &self,
        timer: &str,
        event: &str,
        sets: Vec<(u64, Value)>,
        fields: Vec<(u64, Value)>,
        next: (u64, Micros),
    ) -> Write {
        let n = sets.len() as u64;
        let changes: Vec<Change> = sets
            .into_iter()
            .chain([(next.0, int(next.1))])
            .map(|(field, to)| Change::Set {
                node: self.world,
                field,
                to,
                by: None,
            })
            .collect();
        Write {
            timer: name(timer),
            event: (n > 0).then(|| Event {
                name: name(event),
                fields: fields.into_iter().collect(),
                changes: (0..n).collect(),
                rest: Rest::new(),
            }),
            changes,
            next: next.1,
        }
    }

    fn light(&self, t: Micros, now: Option<&Name>) -> Result<Write, TimeRefusal> {
        let c = &self.cfg;
        let i = c.light(c.cal.local(t)?);
        let new = &c.table[i].1;
        let next = c.next_change(
            t,
            |l| c.light(l),
            |j| c.table[j].1 != *new,
            |l| c.light_edge(l),
        )?;
        let sets = if now == Some(new) {
            Vec::new()
        } else {
            vec![(sky::F_LIGHT, Value::Text(new.clone()))]
        };
        let fields = vec![(1, Value::Text(new.clone())), (2, int(next))];
        Ok(self.write(
            sky::T_LIGHT,
            sky::EV_LIGHT,
            sets,
            fields,
            (sky::F_LIGHT_NEXT, next),
        ))
    }

    fn day(&self, t: Micros, now: Option<[i64; 3]>) -> Result<Write, TimeRefusal> {
        let c = &self.cfg;
        let day = c.cal.local(t)?.div_euclid(DAY_US);
        let shown = now
            .map_or(i64::MIN, |[y, m, d]| sky::days_from_civil(y, m, d))
            .max(day);
        let next = c.next_change(
            t,
            |l| usize::from(l.div_euclid(DAY_US) > shown),
            |v| v == 1,
            |l| (l.div_euclid(DAY_US) + 1) * DAY_US,
        )?;
        let (date, weekday) = sky::civil_from_days(shown);
        let date = Value::Array(date.iter().map(|&n| int(n)).collect());
        let sets = if now.is_some_and(|[y, m, d]| sky::days_from_civil(y, m, d) >= day) {
            Vec::new()
        } else {
            vec![(sky::F_DATE, date.clone()), (sky::F_WEEKDAY, int(weekday))]
        };
        let fields = vec![(1, date), (2, int(weekday))];
        Ok(self.write(
            sky::T_DAY,
            sky::EV_DAY,
            sets,
            fields,
            (sky::F_DAY_NEXT, next),
        ))
    }

    fn weather(&self, t: Micros, now: Option<&Name>) -> Result<Write, TimeRefusal> {
        let c = &self.cfg;
        if let Some(until) = c.until.filter(|&u| u > t) {
            return Ok(self.write(
                sky::T_WEATHER,
                sky::EV_WEATHER,
                Vec::new(),
                Vec::new(),
                (sky::F_WEATHER_NEXT, until),
            ));
        }
        let k = c.weather(c.cal.local(t)?);
        let next = c.next_change(
            t,
            |l| c.weather(l),
            |j| j != k,
            |l| (l.div_euclid(SLOT_US) + 1) * SLOT_US,
        )?;
        let kind = name(KINDS[k]);
        let [cloud, rain, wind] = LEVELS[k];
        let sets = if now == Some(&kind) {
            Vec::new()
        } else {
            vec![
                (sky::F_WEATHER, Value::Text(kind.clone())),
                (sky::F_CLOUD, int(cloud)),
                (sky::F_RAIN, int(rain)),
                (sky::F_WIND, int(wind)),
            ]
        };
        let fields = vec![
            (1, Value::Text(kind)),
            (2, int(cloud)),
            (3, int(rain)),
            (4, int(wind)),
        ];
        Ok(self.write(
            sky::T_WEATHER,
            sky::EV_WEATHER,
            sets,
            fields,
            (sky::F_WEATHER_NEXT, next),
        ))
    }

    /// The world's first light, date and weather at world time `t`: three writes, each with its event.
    pub fn start(&mut self, t: Micros) -> Result<[Write; 3], Refusal> {
        self.runs += 3;
        Ok([
            self.light(t, None).map_err(time)?,
            self.day(t, None).map_err(time)?,
            self.weather(t, None).map_err(time)?,
        ])
    }

    /// Runs the timer `timer` at its due time `t`, against what the world node announces now.
    pub fn fire(&mut self, timer: &Name, t: Micros, now: &Sky) -> Result<Write, Refusal> {
        self.runs += 1;
        match timer.as_str() {
            sky::T_LIGHT => self.light(t, Some(&now.light)),
            sky::T_DAY => self.day(t, Some(now.date)),
            sky::T_WEATHER => self.weather(t, Some(&now.weather)),
            _ => {
                return Err(Refusal {
                    name: "timer-unknown",
                    detail: timer.as_str().to_owned(),
                });
            }
        }
        .map_err(time)
    }
}
