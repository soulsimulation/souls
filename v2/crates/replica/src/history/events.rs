//! The event index and the coarse levels (Engine v2 V4, #2713): how a viewer finds events by time without reading the
//! history. Both are views (T7), made from T6's named events, so both are keyed by audience; only the public
//! audience's are built here (T8). The layout is in `v2/docs/archive.md`.
//!
//! 1. **The event index** lists public named events, one row each: time, kind (the event's name), node and actor (a
//!    Soul, a creator or the world, as T6's envelope names it). Nothing else: no fields, so no text reference and no
//!    words, and no account id (a creator is named by a principal id, T8). An effect whose audience is not everyone
//!    gives no row, and neither does one whose node or actor is on the redaction list. It is split by world hour: an
//!    hour of [`SPLIT`] events or more is an object of its own, and a day's object holds the rest of its rows and
//!    names those hours, so a quiet world writes one object a day. `{1: format, 2: day, 3: hour (an hour's object),
//!    4: [kind, ...], 5: [[at µs, kind number, node, actor], ...], 6: [split hour, ...] (a day's, when any)}`, the
//!    kinds listed once, in order of first use.
//! 2. **Coarse levels** count those events by kind: per ten minutes for a day, and per day for a year (365 world
//!    days). `{1: format, 2: span (1 a day, 2 a year), 3: day or year, 4: [kind, ...], 5: [[slot, kind number,
//!    count], ...]}`, rows in order of slot, then kind number. A day's timeline is drawn from its counts alone.

use std::collections::BTreeMap;

use crate::effects::{Actor, Effect, Refusal};
use crate::encode::{Name, Value, decode, encode};
use crate::ids::Id;
use crate::views::Redactions;
use crate::world_model::Audience;

use super::{DAY, day_of};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The event index and coarse-level format this build writes and reads.
pub const FORMAT: u64 = 1;

/// A world hour, µs: the event index is split by hour.
pub const HOUR: i64 = 3_600_000_000;

/// A day's coarse level counts per ten minutes of world time.
pub const TEN_MINUTES: i64 = 600_000_000;

/// A year's coarse level counts per world day, over this many days.
pub const YEAR_DAYS: i64 = 365;

/// The public audience's name in keys: the views here are keyed by audience, and only this one is built.
pub const PUBLIC: &str = "everyone";

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: &Value) -> R<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).or_else(|_| refuse("history-bad", "an integer")),
        Value::Nint(n) => i64::try_from(*n)
            .map(|n| -1 - n)
            .or_else(|_| refuse("history-bad", "an integer")),
        _ => refuse("history-bad", "an integer"),
    }
}

fn enc(v: &Value) -> R<Vec<u8>> {
    encode(v).or_else(|e| refuse("encoding", e.to_string()))
}

fn actor(a: Actor) -> Value {
    match a {
        Actor::Soul(id) => Value::Array(vec![Value::Uint(1), id.to_value()]),
        Actor::Creator(id) => Value::Array(vec![Value::Uint(2), id.to_value()]),
        Actor::World => Value::Array(vec![Value::Uint(3)]),
    }
}

fn read_actor(v: &Value) -> R<Actor> {
    match v {
        Value::Array(a) => match a.as_slice() {
            [Value::Uint(1), id] => Ok(Actor::Soul(crate::effects::read_id(id)?)),
            [Value::Uint(2), id] => Ok(Actor::Creator(crate::effects::read_id(id)?)),
            [Value::Uint(3)] => Ok(Actor::World),
            _ => refuse("history-bad", "an actor is [1, soul], [2, creator] or [3]"),
        },
        _ => refuse("history-bad", "an actor is an array"),
    }
}

/// One row of the event index (rule 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub at: i64,
    pub kind: Name,
    pub node: Id,
    pub actor: Actor,
}

/// The public rows an effect gives (rule 1): one per named event, when its audience is everyone and neither its node
/// nor its actor is redacted.
pub fn rows(e: &Effect, redactions: &Redactions) -> Vec<Row> {
    let env = e.envelope;
    let hidden = |a: Actor| match a {
        Actor::Soul(id) | Actor::Creator(id) => redactions.contains(id),
        Actor::World => false,
    };
    if env.audience != Audience::Everyone || redactions.contains(env.node) || hidden(env.actor) {
        return Vec::new();
    }
    e.events
        .iter()
        .flatten()
        .map(|ev| Row {
            at: env.at,
            kind: ev.name.clone(),
            node: env.node,
            actor: env.actor,
        })
        .collect()
}

/// Kinds numbered in order of first use.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Kinds(Vec<Name>);

impl Kinds {
    fn number(&mut self, k: &Name) -> u64 {
        let i = self.0.iter().position(|x| x == k).unwrap_or_else(|| {
            self.0.push(k.clone());
            self.0.len() - 1
        });
        i as u64
    }

    fn value(&self) -> Value {
        Value::Array(self.0.iter().cloned().map(Value::Text).collect())
    }

    fn read(v: Option<&Value>) -> R<Kinds> {
        let Some(Value::Array(a)) = v else {
            return refuse("history-bad", "a list of kinds");
        };
        a.iter()
            .map(|k| match k {
                Value::Text(n) => Ok(n.clone()),
                _ => refuse("history-bad", "a kind is a name"),
            })
            .collect::<R<_>>()
            .map(Kinds)
    }

    fn get(&self, v: &Value) -> R<Name> {
        match v {
            Value::Uint(i) => self
                .0
                .get(*i as usize)
                .cloned()
                .map_or_else(|| refuse("history-bad", "a kind number past the list"), Ok),
            _ => refuse("history-bad", "a kind number"),
        }
    }
}

fn map_of(bytes: &[u8], what: &str) -> R<BTreeMap<u64, Value>> {
    match decode(bytes).map(|d| d.value) {
        Ok(Value::Map(m)) if m.get(&1) == Some(&Value::Uint(FORMAT)) => Ok(m),
        Ok(_) => refuse("history-bad", format!("{what} of format {FORMAT}")),
        Err(e) => refuse("encoding", e.to_string()),
    }
}

/// An hour with at least this many public events has an object of its own (rule 1); fewer go in its day's object.
pub const SPLIT: usize = 1_000;

/// An object of the public event index (rule 1): an hour's (`hour` set), or a day's, which holds the rows of the
/// day's hours that have no object of their own and names those that do (`split`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EventIndex {
    pub day: i64,
    pub hour: Option<i64>,
    pub split: Vec<i64>,
    pub rows: Vec<Row>,
}

impl EventIndex {
    /// The day and hour `at` falls in.
    pub fn of(at: i64) -> (i64, i64) {
        let day = day_of(at);
        (day, (at - day * DAY) / HOUR)
    }

    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let mut kinds = Kinds::default();
        let rows = self
            .rows
            .iter()
            .map(|r| {
                Value::Array(vec![
                    int(r.at),
                    Value::Uint(kinds.number(&r.kind)),
                    r.node.to_value(),
                    actor(r.actor),
                ])
            })
            .collect();
        let mut m = BTreeMap::from([
            (1, Value::Uint(FORMAT)),
            (2, int(self.day)),
            (4, kinds.value()),
            (5, Value::Array(rows)),
        ]);
        m.extend(self.hour.map(|h| (3, int(h))));
        if !self.split.is_empty() {
            m.insert(
                6,
                Value::Array(self.split.iter().map(|h| int(*h)).collect()),
            );
        }
        enc(&Value::Map(m))
    }

    /// Reads an object of the index; a row of anything but time, kind, node and actor is refused.
    pub fn read(bytes: &[u8]) -> R<EventIndex> {
        let m = map_of(bytes, "an event index")?;
        let kinds = Kinds::read(m.get(&4))?;
        let (Some(day), Some(Value::Array(rows))) = (m.get(&2), m.get(&5)) else {
            return refuse("history-bad", "an event index is {2: day, 5: rows}");
        };
        let rows = rows
            .iter()
            .map(|r| match r {
                Value::Array(p) if p.len() == 4 => Ok(Row {
                    at: read_int(&p[0])?,
                    kind: kinds.get(&p[1])?,
                    node: crate::effects::read_id(&p[2])?,
                    actor: read_actor(&p[3])?,
                }),
                _ => refuse("history-bad", "a row is [at, kind, node, actor]"),
            })
            .collect::<R<_>>()?;
        let split = match m.get(&6) {
            Some(Value::Array(h)) => h.iter().map(read_int).collect::<R<_>>()?,
            None => Vec::new(),
            _ => return refuse("history-bad", "a day's split hours"),
        };
        Ok(EventIndex {
            day: read_int(day)?,
            hour: m.get(&3).map(read_int).transpose()?,
            split,
            rows,
        })
    }
}

/// What a coarse level covers (rule 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Span {
    /// A world day, counted per ten minutes (slots 0 to 143).
    Day(i64),
    /// A year of [`YEAR_DAYS`] world days, counted per day (slots 0 to 364).
    Year(i64),
}

impl Span {
    /// The slot `at` falls in, in the span of its kind that holds it.
    pub fn slot(self, at: i64) -> i64 {
        match self {
            Span::Day(_) => (at - day_of(at) * DAY) / TEN_MINUTES,
            Span::Year(_) => day_of(at).rem_euclid(YEAR_DAYS),
        }
    }

    pub fn day(at: i64) -> Span {
        Span::Day(day_of(at))
    }

    pub fn year(at: i64) -> Span {
        Span::Year(day_of(at).div_euclid(YEAR_DAYS))
    }
}

/// A coarse level (rule 2): counts of public events by slot and kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Counts {
    pub span: Span,
    pub counts: BTreeMap<(i64, Name), u64>,
}

impl Counts {
    pub fn new(span: Span) -> Counts {
        Counts {
            span,
            counts: BTreeMap::new(),
        }
    }

    pub fn add(&mut self, r: &Row) {
        *self
            .counts
            .entry((self.span.slot(r.at), r.kind.clone()))
            .or_default() += 1;
    }

    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let mut kinds = Kinds::default();
        let mut rows: Vec<(i64, u64, u64)> = self
            .counts
            .iter()
            .map(|((s, k), n)| (*s, kinds.number(k), *n))
            .collect();
        rows.sort();
        let (span, n) = match self.span {
            Span::Day(d) => (1, d),
            Span::Year(y) => (2, y),
        };
        enc(&Value::Map(BTreeMap::from([
            (1, Value::Uint(FORMAT)),
            (2, Value::Uint(span)),
            (3, int(n)),
            (4, kinds.value()),
            (
                5,
                Value::Array(
                    rows.into_iter()
                        .map(|(s, k, n)| Value::Array(vec![int(s), Value::Uint(k), Value::Uint(n)]))
                        .collect(),
                ),
            ),
        ])))
    }

    pub fn read(bytes: &[u8]) -> R<Counts> {
        let m = map_of(bytes, "a coarse level")?;
        let kinds = Kinds::read(m.get(&4))?;
        let span = match (m.get(&2), m.get(&3)) {
            (Some(Value::Uint(1)), Some(n)) => Span::Day(read_int(n)?),
            (Some(Value::Uint(2)), Some(n)) => Span::Year(read_int(n)?),
            _ => return refuse("history-bad", "a span is 1 a day or 2 a year"),
        };
        let Some(Value::Array(rows)) = m.get(&5) else {
            return refuse("history-bad", "a coarse level's rows");
        };
        let mut c = Counts::new(span);
        for r in rows {
            let Value::Array(p) = r else {
                return refuse("history-bad", "a row is [slot, kind, count]");
            };
            let [s, k, Value::Uint(n)] = p.as_slice() else {
                return refuse("history-bad", "a row is [slot, kind, count]");
            };
            c.counts.insert((read_int(s)?, kinds.get(k)?), *n);
        }
        Ok(c)
    }
}

/// The store keys of the public views here, under a world's prefix.
pub fn events_key(day: i64, hour: Option<i64>) -> String {
    match hour {
        Some(h) => format!("history/{PUBLIC}/events/{day:08}/{h:02}"),
        None => format!("history/{PUBLIC}/events/{day:08}"),
    }
}

pub fn counts_key(span: Span) -> String {
    match span {
        Span::Day(d) => format!("history/{PUBLIC}/counts/day/{d:08}"),
        Span::Year(y) => format!("history/{PUBLIC}/counts/year/{y:04}"),
    }
}

/// Builds the event index and the coarse levels from effects in log order (rules 1 and 2), giving each object's key and
/// bytes as it closes: an hour of [`SPLIT`] events or more when a later hour's event arrives; the day's object, its
/// counts and the year's when a later day's does. [`Indexer::finish`] gives what is open. A quiet world so writes
/// three objects a day.
#[derive(Clone, Default)]
pub struct Indexer {
    redactions: Redactions,
    hour: Option<EventIndex>,
    day: Option<EventIndex>,
    counts: Option<Counts>,
    year: Option<Counts>,
}

impl Indexer {
    pub fn new(redactions: Redactions) -> Indexer {
        Indexer {
            redactions,
            ..Indexer::default()
        }
    }

    pub fn feed(&mut self, e: &Effect) -> R<Vec<(String, Vec<u8>)>> {
        let mut out = Vec::new();
        for r in rows(e, &self.redactions) {
            let (day, hour) = EventIndex::of(r.at);
            if self
                .hour
                .as_ref()
                .is_some_and(|h| (h.day, h.hour) != (day, Some(hour)))
            {
                out.extend(self.close_hour()?);
            }
            if self
                .counts
                .as_ref()
                .is_some_and(|c| c.span != Span::day(r.at))
            {
                out.extend(self.close_day()?);
            }
            if self
                .year
                .as_ref()
                .is_some_and(|c| c.span != Span::year(r.at))
            {
                self.year = None;
            }
            self.hour
                .get_or_insert_with(|| EventIndex {
                    day,
                    hour: Some(hour),
                    ..EventIndex::default()
                })
                .rows
                .push(r.clone());
            self.counts
                .get_or_insert_with(|| Counts::new(Span::day(r.at)))
                .add(&r);
            self.year
                .get_or_insert_with(|| Counts::new(Span::year(r.at)))
                .add(&r);
        }
        Ok(out)
    }

    /// Closes the open hour: an object of its own when it holds [`SPLIT`] events or more, else its rows join its
    /// day's object.
    fn close_hour(&mut self) -> R<Option<(String, Vec<u8>)>> {
        let Some(h) = self.hour.take() else {
            return Ok(None);
        };
        let d = self.day.get_or_insert_with(|| EventIndex {
            day: h.day,
            ..EventIndex::default()
        });
        if h.rows.len() < SPLIT {
            d.rows.extend(h.rows);
            return Ok(None);
        }
        d.split.extend(h.hour);
        Ok(Some((events_key(h.day, h.hour), h.to_bytes()?)))
    }

    /// Closes the open day: its hour, its object, its counts, and the year's counts as they stand.
    fn close_day(&mut self) -> R<Vec<(String, Vec<u8>)>> {
        let mut out: Vec<_> = self.close_hour()?.into_iter().collect();
        if let Some(d) = self.day.take() {
            out.push((events_key(d.day, None), d.to_bytes()?));
        }
        if let Some(c) = self.counts.take() {
            out.push((counts_key(c.span), c.to_bytes()?));
        }
        if let Some(y) = &self.year {
            out.push((counts_key(y.span), y.to_bytes()?));
        }
        Ok(out)
    }

    /// Everything open, as it stands (at shutdown).
    pub fn finish(&mut self) -> R<Vec<(String, Vec<u8>)>> {
        self.close_day()
    }
}
