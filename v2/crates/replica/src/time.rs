//! World time (contract T5; Engine v2 T5, #2643). The rules are numbered in `v2/docs/time.md`.
//!
//! World time is a signed 64-bit count of microseconds from the world's start ([`Micros`]). Three effects in the log
//! say how it relates to everything else: the [`Mapping`] to real time, the [`TickRate`] and the [`Tempo`]. Each is
//! a line: an anchor and a whole-number ratio, so tick n and beat k are computed from the anchor by multiplying then
//! dividing through 128 bits, never by adding a rounded period. Every fraction's parts fit 32 bits, so a product is
//! below 2^96 and the arithmetic cannot overflow before its result is checked against 64 bits. Types, effects and
//! fixtures only: no clock thread (K7), no due list (K9), no moves on the beat (B8).

use crate::encode::{Value, to_hex};
use std::fmt;

#[cfg(all(target_arch = "wasm32", feature = "vectors"))]
use wasm_bindgen::prelude::wasm_bindgen;

/// World time, or a duration: microseconds from the world's start (rule 1). Also real time, in a mapping, as
/// microseconds from the Unix epoch as the machine read it.
pub type Micros = i64;

/// Microseconds in a second.
pub const MICROS_PER_SECOND: i64 = 1_000_000;

/// Why a time effect or a query was refused. Each has a name (`v2/docs/time.md`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeRefusal {
    /// A mapping rate of zero or below: world time would stop or run back (rule 3).
    MappingRateNotPositive,
    /// A tick rate of zero or below.
    TickRateNotPositive,
    /// A tick rate above one a microsecond: two ticks would start on one microsecond.
    TickRateAboveMicrosecond,
    /// A tempo whose period is zero or below.
    TempoPeriodNotPositive,
    /// A tempo whose period is shorter than a microsecond: two beats would fall on one microsecond.
    TempoPeriodBelowMicrosecond,
    /// A fraction's numerator or denominator above 2^32 − 1 (rule 5).
    FractionTooWide,
    /// A new mapping whose world anchor is not the world time the mapping before gives at its real anchor (rule 3).
    MappingNotContinuous,
    /// A new tick rate that does not start on a tick of the rate before (rule 6).
    TickRateNotOnATick,
    /// A new tempo that does not start on a beat of the tempo before (rule 7).
    TempoNotOnABeat,
    /// An effect anchored before the effect it follows.
    AnchorBeforePrevious,
    /// A world's start whose effects are not anchored at world time 0, tick 0 and beat 0.
    StartNotAtZero,
    /// A time before the world's start, which has no tick or beat.
    BeforeWorldStart,
    /// A result beyond 64 bits (rule 5).
    OutOfRange,
    /// A value that is not a time effect.
    NotATimeEffect,
}

impl TimeRefusal {
    /// The refusal's name, as `v2/docs/time.md` lists it.
    pub fn name(self) -> &'static str {
        match self {
            TimeRefusal::MappingRateNotPositive => "mapping-rate-not-positive",
            TimeRefusal::TickRateNotPositive => "tick-rate-not-positive",
            TimeRefusal::TickRateAboveMicrosecond => "tick-rate-above-microsecond",
            TimeRefusal::TempoPeriodNotPositive => "tempo-period-not-positive",
            TimeRefusal::TempoPeriodBelowMicrosecond => "tempo-period-below-microsecond",
            TimeRefusal::FractionTooWide => "fraction-too-wide",
            TimeRefusal::MappingNotContinuous => "mapping-not-continuous",
            TimeRefusal::TickRateNotOnATick => "tick-rate-not-on-a-tick",
            TimeRefusal::TempoNotOnABeat => "tempo-not-on-a-beat",
            TimeRefusal::AnchorBeforePrevious => "anchor-before-previous",
            TimeRefusal::StartNotAtZero => "start-not-at-zero",
            TimeRefusal::BeforeWorldStart => "before-world-start",
            TimeRefusal::OutOfRange => "out-of-range",
            TimeRefusal::NotATimeEffect => "not-a-time-effect",
        }
    }
}

impl fmt::Display for TimeRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl std::error::Error for TimeRefusal {}

/// A positive fraction whose parts fit 32 bits (rule 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fraction {
    num: u32,
    den: u32,
}

impl Fraction {
    /// The fraction `num / den`, or `not_positive` when it is zero or below (a denominator of zero included), or
    /// `fraction-too-wide`.
    fn new(num: i64, den: i64, not_positive: TimeRefusal) -> Result<Fraction, TimeRefusal> {
        if num <= 0 || den <= 0 {
            return Err(not_positive);
        }
        match (u32::try_from(num), u32::try_from(den)) {
            (Ok(num), Ok(den)) => Ok(Fraction { num, den }),
            _ => Err(TimeRefusal::FractionTooWide),
        }
    }

    pub fn num(self) -> u32 {
        self.num
    }

    pub fn den(self) -> u32 {
        self.den
    }

    fn to_value(self) -> Value {
        Value::Array(vec![
            Value::Uint(u64::from(self.num)),
            Value::Uint(u64::from(self.den)),
        ])
    }
}

/// A line: `y = y0 + (x − x0) · p / q`, read either way with one rounding rule (rule 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Line {
    x0: i64,
    y0: i64,
    p: u32,
    q: u32,
}

impl Line {
    /// The whole y reached at x: rounded down.
    fn y_at(self, x: i64) -> Result<i64, TimeRefusal> {
        let product = (i128::from(x) - i128::from(self.x0)) * i128::from(self.p);
        narrow(i128::from(self.y0) + product.div_euclid(i128::from(self.q)))
    }

    /// The first whole x at which y is reached: rounded up.
    fn x_of(self, y: i64) -> Result<i64, TimeRefusal> {
        let product = (i128::from(y) - i128::from(self.y0)) * i128::from(self.q);
        narrow(i128::from(self.x0) - (-product).div_euclid(i128::from(self.p)))
    }
}

fn narrow(n: i128) -> Result<i64, TimeRefusal> {
    i64::try_from(n).map_err(|_| TimeRefusal::OutOfRange)
}

/// How world time follows real time from an anchor (rule 3): world microseconds per real microsecond, as a fraction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mapping {
    pub world_us: Micros,
    pub real_us: Micros,
    pub rate: Fraction,
}

impl Mapping {
    /// A mapping, refused as `mapping-rate-not-positive` when `num / den` is zero or below.
    pub fn new(
        world_us: Micros,
        real_us: Micros,
        num: i64,
        den: i64,
    ) -> Result<Mapping, TimeRefusal> {
        let rate = Fraction::new(num, den, TimeRefusal::MappingRateNotPositive)?;
        Ok(Mapping {
            world_us,
            real_us,
            rate,
        })
    }

    fn line(self) -> Line {
        Line {
            x0: self.real_us,
            y0: self.world_us,
            p: self.rate.num,
            q: self.rate.den,
        }
    }
}

/// The tick rate from an anchor (rule 6): tick `anchor_tick` starts at `anchor_us`, and `per_s` ticks follow a second.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickRate {
    pub anchor_us: Micros,
    pub anchor_tick: i64,
    per_s: u32,
}

impl TickRate {
    /// A tick rate, refused when `per_s` is zero or below or above a million.
    pub fn new(anchor_us: Micros, anchor_tick: i64, per_s: i64) -> Result<TickRate, TimeRefusal> {
        if per_s <= 0 {
            return Err(TimeRefusal::TickRateNotPositive);
        }
        let per_s = u32::try_from(per_s)
            .ok()
            .filter(|r| i64::from(*r) <= MICROS_PER_SECOND)
            .ok_or(TimeRefusal::TickRateAboveMicrosecond)?;
        Ok(TickRate {
            anchor_us,
            anchor_tick,
            per_s,
        })
    }

    pub fn per_s(self) -> u32 {
        self.per_s
    }

    fn line(self) -> Line {
        Line {
            x0: self.anchor_us,
            y0: self.anchor_tick,
            p: self.per_s,
            q: 1_000_000,
        }
    }
}

/// The tempo from an anchor (rule 7): beat `anchor_beat` falls at `anchor_us`, and a beat lasts `period`
/// microseconds, a fraction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tempo {
    pub anchor_us: Micros,
    pub anchor_beat: i64,
    pub period: Fraction,
}

impl Tempo {
    /// A tempo whose beat lasts `num / den` microseconds, refused when that is zero or below or under one.
    pub fn new(
        anchor_us: Micros,
        anchor_beat: i64,
        num: i64,
        den: i64,
    ) -> Result<Tempo, TimeRefusal> {
        let period = Fraction::new(num, den, TimeRefusal::TempoPeriodNotPositive)?;
        if period.num < period.den {
            return Err(TimeRefusal::TempoPeriodBelowMicrosecond);
        }
        Ok(Tempo {
            anchor_us,
            anchor_beat,
            period,
        })
    }

    /// A tempo of `per_minute` beats a minute: a period of 60,000,000 / `per_minute` microseconds, kept as that
    /// fraction, never rounded.
    pub fn per_minute(
        anchor_us: Micros,
        anchor_beat: i64,
        per_minute: i64,
    ) -> Result<Tempo, TimeRefusal> {
        Tempo::new(anchor_us, anchor_beat, 60 * MICROS_PER_SECOND, per_minute)
    }

    fn line(self) -> Line {
        Line {
            x0: self.anchor_us,
            y0: self.anchor_beat,
            p: self.period.den,
            q: self.period.num,
        }
    }
}

/// One of the three time effects (rule 2), as the log records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeEffect {
    Mapping(Mapping),
    TickRate(TickRate),
    Tempo(Tempo),
}

/// Field numbers of a time effect's map (rule 8).
const FIELD_WHICH: u64 = 1;
const FIELD_ANCHOR: u64 = 2;
const FIELD_AT: u64 = 3;
const FIELD_RATE: u64 = 4;

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: Option<&Value>) -> Result<i64, TimeRefusal> {
    match v {
        Some(Value::Uint(u)) => i64::try_from(*u).map_err(|_| TimeRefusal::OutOfRange),
        Some(Value::Nint(n)) => i64::try_from(*n)
            .map(|n| -1 - n)
            .map_err(|_| TimeRefusal::OutOfRange),
        _ => Err(TimeRefusal::NotATimeEffect),
    }
}

fn read_pair(v: Option<&Value>) -> Result<(i64, i64), TimeRefusal> {
    match v {
        Some(Value::Array(a)) if a.len() == 2 => Ok((read_int(a.first())?, read_int(a.get(1))?)),
        _ => Err(TimeRefusal::NotATimeEffect),
    }
}

impl TimeEffect {
    /// The effect as a profile value: `{1: which, 2: anchor, 3: at, 4: rate}` (rule 8).
    pub fn to_value(self) -> Value {
        let (which, anchor, at, rate) = match self {
            TimeEffect::Mapping(m) => (1, m.world_us, m.real_us, m.rate.to_value()),
            TimeEffect::TickRate(t) => (
                2,
                t.anchor_us,
                t.anchor_tick,
                Value::Uint(u64::from(t.per_s)),
            ),
            TimeEffect::Tempo(t) => (3, t.anchor_us, t.anchor_beat, t.period.to_value()),
        };
        Value::Map(
            [
                (FIELD_WHICH, Value::Uint(which)),
                (FIELD_ANCHOR, int(anchor)),
                (FIELD_AT, int(at)),
                (FIELD_RATE, rate),
            ]
            .into(),
        )
    }

    /// The effect a profile value holds, checked as its constructor checks it: a negative rate is refused by name.
    pub fn from_value(v: &Value) -> Result<TimeEffect, TimeRefusal> {
        let Value::Map(m) = v else {
            return Err(TimeRefusal::NotATimeEffect);
        };
        if m.keys().any(|k| !(FIELD_WHICH..=FIELD_RATE).contains(k)) {
            return Err(TimeRefusal::NotATimeEffect);
        }
        let anchor = read_int(m.get(&FIELD_ANCHOR))?;
        let at = read_int(m.get(&FIELD_AT))?;
        let rate = m.get(&FIELD_RATE);
        match m.get(&FIELD_WHICH) {
            Some(Value::Uint(1)) => {
                let (num, den) = read_pair(rate)?;
                Mapping::new(anchor, at, num, den).map(TimeEffect::Mapping)
            }
            Some(Value::Uint(2)) => {
                TickRate::new(anchor, at, read_int(rate)?).map(TimeEffect::TickRate)
            }
            Some(Value::Uint(3)) => {
                let (num, den) = read_pair(rate)?;
                Tempo::new(anchor, at, num, den).map(TimeEffect::Tempo)
            }
            _ => Err(TimeRefusal::NotATimeEffect),
        }
    }
}

/// A world's time line: every time effect applied so far, each kind in the order applied (rules 2 to 7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Timeline {
    mappings: Vec<Mapping>,
    ticks: Vec<TickRate>,
    tempos: Vec<Tempo>,
}

impl Timeline {
    /// A world's start: one effect of each kind, anchored at world time 0, tick 0 and beat 0.
    pub fn start(mapping: Mapping, ticks: TickRate, tempo: Tempo) -> Result<Timeline, TimeRefusal> {
        if mapping.world_us != 0
            || (ticks.anchor_us, ticks.anchor_tick) != (0, 0)
            || (tempo.anchor_us, tempo.anchor_beat) != (0, 0)
        {
            return Err(TimeRefusal::StartNotAtZero);
        }
        Ok(Timeline {
            mappings: vec![mapping],
            ticks: vec![ticks],
            tempos: vec![tempo],
        })
    }

    /// Applies a later effect, or refuses it by name and changes nothing. Each takes over from the one before
    /// exactly where that one's line is: world time does not jump, and a tick or beat is neither skipped nor split.
    pub fn apply(&mut self, effect: TimeEffect) -> Result<(), TimeRefusal> {
        match effect {
            TimeEffect::Mapping(m) => {
                let last = *self.mappings.last().ok_or(TimeRefusal::StartNotAtZero)?;
                if m.real_us < last.real_us {
                    return Err(TimeRefusal::AnchorBeforePrevious);
                }
                if last.line().y_at(m.real_us)? != m.world_us {
                    return Err(TimeRefusal::MappingNotContinuous);
                }
                self.mappings.push(m);
            }
            TimeEffect::TickRate(t) => {
                let last = *self.ticks.last().ok_or(TimeRefusal::StartNotAtZero)?;
                if t.anchor_tick < last.anchor_tick {
                    return Err(TimeRefusal::AnchorBeforePrevious);
                }
                if last.line().x_of(t.anchor_tick)? != t.anchor_us {
                    return Err(TimeRefusal::TickRateNotOnATick);
                }
                self.ticks.push(t);
            }
            TimeEffect::Tempo(t) => {
                let last = *self.tempos.last().ok_or(TimeRefusal::StartNotAtZero)?;
                if t.anchor_beat < last.anchor_beat {
                    return Err(TimeRefusal::AnchorBeforePrevious);
                }
                if last.line().x_of(t.anchor_beat)? != t.anchor_us {
                    return Err(TimeRefusal::TempoNotOnABeat);
                }
                self.tempos.push(t);
            }
        }
        Ok(())
    }

    /// The world time a recorded real-time reading maps to (rule 3), from the last mapping anchored at or before it.
    pub fn world_at(&self, real_us: Micros) -> Result<Micros, TimeRefusal> {
        let m = self
            .mappings
            .iter()
            .rev()
            .find(|m| m.real_us <= real_us)
            .or(self.mappings.first())
            .ok_or(TimeRefusal::StartNotAtZero)?;
        m.line().y_at(real_us)
    }

    /// The tick whose span holds world time `t`: `[tick_start(n), tick_start(n + 1))` (rule 6).
    pub fn tick_of(&self, t: Micros) -> Result<i64, TimeRefusal> {
        let r = last_at(&self.ticks, |r| r.anchor_us <= t, t)?;
        r.line().y_at(t)
    }

    /// The world time tick `n` starts: the first microsecond at or after its exact start.
    pub fn tick_start(&self, n: i64) -> Result<Micros, TimeRefusal> {
        let r = last_at(&self.ticks, |r| r.anchor_tick <= n, n)?;
        r.line().x_of(n)
    }

    /// The last beat at or before world time `t` (rule 7).
    pub fn beat_of(&self, t: Micros) -> Result<i64, TimeRefusal> {
        let tempo = last_at(&self.tempos, |p| p.anchor_us <= t, t)?;
        tempo.line().y_at(t)
    }

    /// The world time beat `k` falls on: the first microsecond at or after its exact time.
    pub fn beat_time(&self, k: i64) -> Result<Micros, TimeRefusal> {
        let tempo = last_at(&self.tempos, |p| p.anchor_beat <= k, k)?;
        tempo.line().x_of(k)
    }
}

/// The last of `lines` that `holds`; a query below zero is before the world's start.
fn last_at<T: Copy>(lines: &[T], holds: impl Fn(&T) -> bool, query: i64) -> Result<T, TimeRefusal> {
    if query < 0 {
        return Err(TimeRefusal::BeforeWorldStart);
    }
    lines
        .iter()
        .rev()
        .copied()
        .find(holds)
        .ok_or(TimeRefusal::BeforeWorldStart)
}

/// Beat 1,000,000 at 130 a minute, the two ways Step 0 compares: adding the rounded period a million times, and
/// multiplying then dividing (rule 4). Returns `(by adding, by the line)`.
pub fn beat_a_million_two_ways() -> Result<(Micros, Micros), TimeRefusal> {
    let period = (60 * MICROS_PER_SECOND + 65) / 130; // 461,538.46 rounded to the nearest microsecond
    let mut added: Micros = 0;
    for _ in 0..1_000_000 {
        added = added.checked_add(period).ok_or(TimeRefusal::OutOfRange)?;
    }
    let line = Timeline::start(
        Mapping::new(0, 0, 1, 1)?,
        TickRate::new(0, 0, 20)?,
        Tempo::per_minute(0, 0, 130)?,
    )?;
    Ok((added, line.beat_time(1_000_000)?))
}

/// The time goldens, one per line, as `fixtures/time/goldens.txt` holds them: the native test and the WASM build in
/// Node both compare this with that file. WASM exports it only with the `vectors` feature.
#[cfg_attr(all(target_arch = "wasm32", feature = "vectors"), wasm_bindgen)]
pub fn time_goldens() -> String {
    let mut lines = Vec::new();
    match goldens(&mut lines) {
        Ok(()) => lines.join("\n") + "\n",
        Err(r) => format!("refused {r}\n"),
    }
}

fn goldens(lines: &mut Vec<String>) -> Result<(), TimeRefusal> {
    let (added, line) = beat_a_million_two_ways()?;
    lines.push(format!("beat-1000000-at-130-by-adding {added}"));
    lines.push(format!("beat-1000000-at-130 {line}"));
    let mut world = Timeline::start(
        Mapping::new(0, 1_763_337_600_000_000, 1, 1)?,
        TickRate::new(0, 0, 20)?,
        Tempo::per_minute(0, 0, 130)?,
    )?;
    world.apply(TimeEffect::TickRate(TickRate::new(1_000_000, 20, 30)?))?;
    lines.push(format!("tick-31-at-30 {}", world.tick_start(31)?));
    lines.push(format!(
        "tick-of-1033333-at-30 {}",
        world.tick_of(1_033_333)?
    ));
    lines.push(format!(
        "world-at-real-plus-90s {}",
        world.world_at(1_763_337_690_000_000)?
    ));
    for (name, effect) in [
        ("mapping-effect", TimeEffect::Mapping(world.mappings[0])),
        ("tick-rate-effect", TimeEffect::TickRate(world.ticks[1])),
        ("tempo-effect", TimeEffect::Tempo(world.tempos[0])),
    ] {
        let bytes =
            crate::encode::encode(&effect.to_value()).map_err(|_| TimeRefusal::OutOfRange)?;
        lines.push(format!("{name} {}", to_hex(&bytes)));
    }
    Ok(())
}
