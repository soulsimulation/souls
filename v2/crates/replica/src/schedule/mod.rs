//! The schedules a world publishes (Engine v2 E7, #2756; contract T10): a ride's timetable, a place's hours and the
//! calendar's entries, read from any copy of the world with no request, so an agent's client schedules itself. The
//! engine holds no order that waits for a time or a condition; nothing here says when to act or whether something is
//! "open". Each reading is a plain list of world times (T5, µs).
//!
//! - **A ride's timetable is not stored.** A moving node keeps its track as data ([`F_COURSE`], N12's formula,
//!   [`course`]); [`stops`] reads the next stops from it: the station, when the frame arrives and when it leaves.
//! - **Hours** are a field on the thing or place they belong to ([`F_HOURS`]): at most [`HOURS_MOST`] rows, each
//!   one-off, `[1, from, to]` in world µs, or weekly, `[2, weekdays, from, to]`: a mask of ISO weekdays (bit 0
//!   Monday to bit 6 Sunday) and µs after local midnight, `to` at most a day after `from`. [`hours`] gives the spans
//!   that overlap a window, in world µs, through the world's calendar (`crate::sky::Calendar`, on the root).
//! - **The calendar** is a node whose children are its entries. An entry is a node with its place ([`F_PLACE`]), a
//!   start and an end in world µs ([`F_START`], [`F_END`]), its text by reference ([`F_TEXT`], `{21: id}`, T8) and
//!   who posted it ([`F_POSTED_BY`]). [`calendar`] lists the entries that overlap a window, by start. A live world
//!   held 8,273: the window bounds the answer, never the calendar.
//!
//! Refused by name: `node-missing`, `schedule-missing` (the node has no such field), `schedule-malformed`,
//! `window-too-long` (over [`WINDOW_MOST`] local days), and the track's own load refusals.
//!
//! Not here: reminders (the world never schedules for a mind), posting and interest (`sim::calendar`), the
//! calendar's page, any start time or condition on an intent.

pub mod course;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use crate::audience::reference;
use crate::effects::{Refusal, read_id};
use crate::encode::Value;
use crate::ids::Id;
use crate::read::Read;
use crate::sky::{Calendar, DAY_US, as_int, civil_from_days};
use crate::time::Micros;
use course::{Course, Stop};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// A moving node's track ([`course`]).
pub const F_COURSE: u64 = 80;
/// A thing's or a place's hours (the module's notes).
pub const F_HOURS: u64 = 81;
/// A calendar entry's place, start, end (world µs), text by reference and who posted it.
pub const F_PLACE: u64 = 82;
pub const F_START: u64 = 83;
pub const F_END: u64 = 84;
pub const F_TEXT: u64 = 85;
pub const F_POSTED_BY: u64 = 86;
/// A moving node steered off its own course (a punt, #3603): who steers it, the course it left, when, and its wake
/// (`sim::courses::punts::Steer`); an empty map while it is on its own course.
pub const F_STEER: u64 = 87;
/// The courses of a ride's seats that move with their cabins (N14, `sim::courses::rides::seat_runs`): `{slot: course}`,
/// each a [`course::Course`] of the slot's point in its thing's frame, as [`F_COURSE`] is a node's. Written by the world
/// from the ride's entry; the page reads where a seat and its rider are from it.
pub const F_SEAT_COURSES: u64 = 88;

/// The most rows hours may hold.
pub const HOURS_MOST: usize = 64;
/// The most local days a window may cover.
pub const WINDOW_MOST: i64 = 400;
/// The most stops one reading gives.
pub const STOPS_MOST: usize = 64;

/// A node's fields, from the copy.
fn fields(r: &impl Read, node: Id) -> R<BTreeMap<u64, Value>> {
    match r.node(node) {
        Some(Value::Map(mut m)) => match m.remove(&6) {
            Some(Value::Map(f)) => Ok(f),
            _ => Ok(BTreeMap::new()),
        },
        _ => refuse("node-missing", crate::world_model::show(node)),
    }
}

fn field(f: &BTreeMap<u64, Value>, k: u64, node: Id) -> R<&Value> {
    f.get(&k).ok_or_else(|| Refusal {
        name: "schedule-missing",
        detail: format!("{} has no field {k}", crate::world_model::show(node)),
    })
}

fn malformed<T>(node: Id, what: &str) -> R<T> {
    refuse(
        "schedule-malformed",
        format!("{}: {what}", crate::world_model::show(node)),
    )
}

/// The next `n` stops (at most [`STOPS_MOST`]) of the moving node `ride` from world time `from`, at `station` only
/// when given (a boarding point's station), read from its track's formula.
pub fn stops(
    r: &impl Read,
    ride: Id,
    station: Option<usize>,
    from: Micros,
    n: usize,
) -> R<Vec<Stop>> {
    let f = fields(r, ride)?;
    let Some(c) = Course::read(field(&f, F_COURSE, ride)?) else {
        return malformed(ride, "its track");
    };
    Ok(c.load()?.next(from, station, n.min(STOPS_MOST)))
}

/// One row of hours.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hours {
    /// From and to, world µs.
    Once(Micros, Micros),
    /// ISO weekdays (bit 0 Monday), from and to, µs after local midnight.
    Weekly(u8, Micros, Micros),
}

impl Hours {
    pub fn to_value(self) -> Value {
        let i = crate::sky::int;
        Value::Array(match self {
            Hours::Once(a, b) => vec![Value::Uint(1), i(a), i(b)],
            Hours::Weekly(d, a, b) => vec![Value::Uint(2), Value::Uint(u64::from(d)), i(a), i(b)],
        })
    }

    fn read(v: &Value) -> Option<Hours> {
        let Value::Array(r) = v else { return None };
        let n: Vec<i64> = r.iter().map(as_int).collect::<Option<_>>()?;
        let h = match n.as_slice() {
            [1, a, b] if a < b => Hours::Once(*a, *b),
            [2, d, a, b]
                if (1..128).contains(d) && (0..DAY_US).contains(a) && a < b && b - a <= DAY_US =>
            {
                Hours::Weekly(u8::try_from(*d).ok()?, *a, *b)
            }
            _ => return None,
        };
        Some(h)
    }
}

/// The first world µs whose local time is at least `local` (µs since 1970-01-01T00:00 local).
fn world_of(cal: &Calendar, local: Micros) -> R<Micros> {
    let line = cal.line().map_err(time_refusal)?;
    let mut best: Option<Micros> = None;
    for &(_, o) in &cal.offsets {
        let t = line.x_of(local - o).map_err(time_refusal)?;
        if cal.local(t).map_err(time_refusal)? >= local {
            best = Some(best.map_or(t, |b| b.min(t)));
        }
    }
    best.ok_or_else(|| Refusal {
        name: "schedule-malformed",
        detail: format!("no world time reaches local {local}"),
    })
}

fn time_refusal(e: crate::time::TimeRefusal) -> Refusal {
    Refusal {
        name: e.name(),
        detail: "the world's calendar".into(),
    }
}

/// The world's calendar, from the root of `node`'s zone.
fn world_calendar(r: &impl Read, node: Id) -> R<Calendar> {
    let root = r
        .path(node)
        .and_then(|p| p.last().copied())
        .ok_or_else(|| Refusal {
            name: "node-missing",
            detail: crate::world_model::show(node),
        })?;
    let f = fields(r, root)?;
    Calendar::read(&f).map_or_else(|| malformed(root, "the world's calendar"), Ok)
}

/// The spans of `node`'s hours that overlap world times `[from, to)`, as `(from, to)` in world µs, by start. The rows
/// are the field's; the spans are what they mean in this world's calendar.
pub fn hours(r: &impl Read, node: Id, from: Micros, to: Micros) -> R<Vec<(Micros, Micros)>> {
    let f = fields(r, node)?;
    let Value::Array(rows) = field(&f, F_HOURS, node)? else {
        return malformed(node, "its hours");
    };
    if rows.len() > HOURS_MOST {
        return malformed(node, "too many rows of hours");
    }
    let Some(rows) = rows.iter().map(Hours::read).collect::<Option<Vec<_>>>() else {
        return malformed(node, "a row of hours");
    };
    let cal = world_calendar(r, node)?;
    let day = |t| {
        cal.local(t)
            .map(|l| l.div_euclid(DAY_US))
            .map_err(time_refusal)
    };
    // The day before the window's first, for a span that runs past midnight into it.
    let (d0, d1) = (day(from)? - 1, day(to)?);
    if d1 - d0 > WINDOW_MOST {
        return refuse("window-too-long", format!("{} local days", d1 - d0));
    }
    let mut out = Vec::new();
    for row in rows {
        match row {
            Hours::Once(a, b) => out.push((a, b)),
            Hours::Weekly(days, a, b) => {
                for d in d0..=d1 {
                    if days & (1 << (civil_from_days(d).1 - 1)) != 0 {
                        out.push((
                            world_of(&cal, d * DAY_US + a)?,
                            world_of(&cal, d * DAY_US + b)?,
                        ));
                    }
                }
            }
        }
    }
    out.retain(|&(a, b)| a < to && b > from);
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// A calendar entry as a copy reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: Id,
    pub place: Id,
    pub start: Micros,
    pub end: Micros,
    /// The words' reference (T8): a view or delivery gives the words to an audience entitled to them.
    pub text: Id,
    pub posted_by: Id,
}

impl Entry {
    /// The entry a node's fields hold, or `None` when they are not one.
    pub fn read(id: Id, f: &BTreeMap<u64, Value>) -> Option<Entry> {
        let n = |k| f.get(&k).and_then(as_int);
        let e = Entry {
            id,
            place: read_id(f.get(&F_PLACE)?).ok()?,
            start: n(F_START)?,
            end: n(F_END)?,
            text: reference(f.get(&F_TEXT)?)?,
            posted_by: read_id(f.get(&F_POSTED_BY)?).ok()?,
        };
        (e.start < e.end).then_some(e)
    }
}

/// The entries of the calendar node `calendar` that overlap world times `[from, to)`, by start and then id. A child
/// that is not an entry is `schedule-malformed`.
pub fn calendar(r: &impl Read, calendar: Id, from: Micros, to: Micros) -> R<Vec<Entry>> {
    let Some(kids) = r.children(calendar, None) else {
        return refuse("node-missing", crate::world_model::show(calendar));
    };
    let mut out = Vec::new();
    for id in kids {
        let Some(e) = Entry::read(id, &fields(r, id)?) else {
            return malformed(id, "a calendar entry");
        };
        if e.start < to && e.end > from {
            out.push(e);
        }
    }
    out.sort_by_key(|e| (e.start, e.id));
    Ok(out)
}
