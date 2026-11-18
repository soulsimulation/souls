//! Values that change with time (Engine v2 F5, #2770): the value-now function the world and every viewer share.
//!
//! - **Three stored whole numbers.** A timed value is its value, its rate per second and the world time it was set
//!   ([`Timed`]). Between changes nothing is written: its value at any time is a pure function of the three, the
//!   time and the kind's limits ([`Bounds`]), so a viewer draws from the same three the world keeps.
//! - **The value at t** is `clamp(clamp(value) + trunc(per_s × (t − set_us) / 1,000,000), min, max)`: whole units
//!   accrued, the division truncated toward zero so rising and falling are symmetric (SA-F5a, #2845). A time before
//!   `set_us` is refused (`time_before_set`).
//! - **The crossing of a level** (at least L, at most L) from a time is that time if the level is already met, else
//!   the first whole microsecond at which the value meets it (`set_us + ceil(|L − value| × 1,000,000 / |per_s|)`),
//!   or none: the rate is zero or points away, or a limit stops it short of L.
//! - **No overflow after a long sleep.** Everything is worked in 128 bits: a product of two 64-bit numbers fits, and
//!   a value or time beyond the signed 64-bit range is refused (`beyond_i64`), never wrapped.
//!
//! The shared cases: `packages/form-rules/cases/timed/` (format `souls-timed-cases/1`).

use crate::encode::Value;
use crate::time::{MICROS_PER_SECOND, Micros};

/// A timed value as stored: its value, its rate per second and the world time it was set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Timed {
    pub value: i64,
    pub per_s: i64,
    pub set_us: Micros,
}

/// The limits the kind gives a timed value (empty, full): none means unbounded on that side.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bounds {
    pub min: Option<i64>,
    pub max: Option<i64>,
}

/// A level the kind names (boiling): met when the value is at least, or at most, the number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    AtLeast(i64),
    AtMost(i64),
}

/// Why a timed value's question was refused, by name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimedRefusal {
    /// A time before the value was set.
    TimeBeforeSet,
    /// A value or a time outside the signed 64-bit range.
    BeyondI64,
}

impl TimedRefusal {
    pub fn name(self) -> &'static str {
        match self {
            TimedRefusal::TimeBeforeSet => "time_before_set",
            TimedRefusal::BeyondI64 => "beyond_i64",
        }
    }
}

const PER_S: i128 = MICROS_PER_SECOND as i128;

fn narrow(n: i128) -> Result<i64, TimedRefusal> {
    i64::try_from(n).map_err(|_| TimedRefusal::BeyondI64)
}

impl Bounds {
    fn clamp(self, v: i128) -> i128 {
        let v = self.max.map_or(v, |m| v.min(i128::from(m)));
        self.min.map_or(v, |m| v.max(i128::from(m)))
    }
}

impl Level {
    /// Whether value `v` meets the level.
    pub fn met(self, v: i64) -> bool {
        match self {
            Level::AtLeast(l) => v >= l,
            Level::AtMost(l) => v <= l,
        }
    }
}

impl Timed {
    /// Its value at world time `t`.
    pub fn at(self, b: Bounds, t: Micros) -> Result<i64, TimedRefusal> {
        if t < self.set_us {
            return Err(TimedRefusal::TimeBeforeSet);
        }
        let dt = i128::from(t) - i128::from(self.set_us);
        let accrued = i128::from(self.per_s) * dt / PER_S;
        narrow(b.clamp(b.clamp(i128::from(self.value)) + accrued))
    }

    /// The first world time at or after `from` at which the value meets `level`; `None` when it never does.
    pub fn crossing(
        self,
        b: Bounds,
        level: Level,
        from: Micros,
    ) -> Result<Option<Micros>, TimedRefusal> {
        if level.met(self.at(b, from)?) {
            return Ok(Some(from));
        }
        let start = b.clamp(i128::from(self.value));
        let rate = i128::from(self.per_s);
        let gap = match level {
            Level::AtLeast(l) if rate > 0 && b.max.is_none_or(|m| m >= l) => i128::from(l) - start,
            Level::AtMost(l) if rate < 0 && b.min.is_none_or(|m| m <= l) => start - i128::from(l),
            _ => return Ok(None),
        };
        let rate = rate.abs();
        let after = (gap * PER_S + rate - 1) / rate;
        narrow(i128::from(self.set_us) + after).map(Some)
    }

    /// The value settled to `now` with a new rate: its value then, `per_s`, set at `now`. Any change goes through
    /// here, so the three numbers always describe the value from their own `set_us` on.
    pub fn settle(self, b: Bounds, now: Micros, per_s: i64) -> Result<Timed, TimedRefusal> {
        Ok(Timed {
            value: self.at(b, now)?,
            per_s,
            set_us: now,
        })
    }

    /// As a field's value: `[value, per_s, set_us]`.
    pub fn to_value(self) -> Value {
        Value::Array([self.value, self.per_s, self.set_us].map(int).to_vec())
    }

    /// Read back from a field's value; `None` when it is not three whole numbers in range.
    pub fn from_value(v: &Value) -> Option<Timed> {
        let Value::Array(a) = v else { return None };
        let [value, per_s, set_us] = a.as_slice() else {
            return None;
        };
        Some(Timed {
            value: read_int(value)?,
            per_s: read_int(per_s)?,
            set_us: read_int(set_us)?,
        })
    }
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::json::{Value as J, parse};

    const CASES: &str = include_str!("../../../../packages/form-rules/cases/timed/kettle.json");
    const KIND: &str =
        include_str!("../../../../packages/form-rules/cases/kinds/test/timed_kettle.json");

    fn int(v: Option<&J>) -> Option<i128> {
        match v? {
            J::Int(n) => Some(*n),
            _ => None,
        }
    }

    /// What a case expects: a whole number, null, or a refusal by name.
    fn expect(v: &J) -> Result<Option<i128>, String> {
        match v {
            J::Null => Ok(None),
            J::Int(n) => Ok(Some(*n)),
            _ => Err(v.get("bad").and_then(J::str).expect("a refusal").to_owned()),
        }
    }

    /// A time from the cases: one outside 64 bits is refused before it reaches the function.
    fn time(n: i128) -> Result<Micros, String> {
        i64::try_from(n).map_err(|_| TimedRefusal::BeyondI64.name().to_owned())
    }

    fn named<T>(r: Result<T, TimedRefusal>) -> Result<T, String> {
        r.map_err(|e| e.name().to_owned())
    }

    /// Every value and crossing in SA-F5a's shared cases, with the kind's limits (#2845).
    #[test]
    fn f5_shared_cases() {
        let kind = parse(KIND).expect("the kind");
        let cases = parse(CASES).expect("the cases");
        assert_eq!(
            cases.get("format").and_then(J::str),
            Some("souls-timed-cases/1")
        );
        let mut checked = 0;
        for case in cases.get("cases").and_then(J::arr).expect("cases") {
            let field = case.get("field").and_then(J::str).expect("a field");
            let f = kind
                .get("state")
                .and_then(|s| s.get(field))
                .expect("the field");
            let narrow = |v: Option<&J>| int(v).map(|n| i64::try_from(n).expect("in range"));
            let b = Bounds {
                min: narrow(f.get("min")),
                max: narrow(f.get("max")),
            };
            let s = case.get("stored").expect("stored");
            let t = Timed {
                value: narrow(s.get("value")).expect("value"),
                per_s: narrow(s.get("per_s")).expect("per_s"),
                set_us: narrow(s.get("set_us")).expect("set_us"),
            };
            let label = case.get("name").and_then(J::str).expect("a name");
            for v in case.get("values").and_then(J::arr).expect("values") {
                let [at, want] = v.arr().expect("a pair") else {
                    panic!("a pair")
                };
                let got = time(int(Some(at)).expect("a time"))
                    .and_then(|at| named(t.at(b, at)))
                    .map(|v| Some(i128::from(v)));
                assert_eq!(got, expect(want), "{label}: value at {}", at.to_json());
                checked += 1;
            }
            for c in case.get("crossings").and_then(J::arr).expect("crossings") {
                let level = match (int(c.get("at_least")), int(c.get("at_most"))) {
                    (Some(l), None) => Level::AtLeast(i64::try_from(l).expect("a level")),
                    (None, Some(l)) => Level::AtMost(i64::try_from(l).expect("a level")),
                    _ => panic!("{label}: one level"),
                };
                let got = time(int(c.get("from_us")).expect("from_us"))
                    .and_then(|from| named(t.crossing(b, level, from)))
                    .map(|o| o.map(i128::from));
                assert_eq!(
                    got,
                    expect(c.get("expect").expect("expect")),
                    "{label}: {}",
                    c.to_json()
                );
                checked += 1;
            }
        }
        assert!(checked > 40, "{checked} checked");
    }

    /// Settling keeps the value continuous, and the three numbers survive a field's value.
    #[test]
    fn f5_settle_and_value() {
        let b = Bounds {
            min: Some(20_000),
            max: Some(100_000),
        };
        let t = Timed {
            value: 20_000,
            per_s: 533,
            set_us: 7_000_000,
        };
        let s = t.settle(b, 8_000_000, -50).expect("settles");
        assert_eq!(
            s,
            Timed {
                value: 20_533,
                per_s: -50,
                set_us: 8_000_000
            }
        );
        assert_eq!(s.at(b, 8_000_000), t.at(b, 8_000_000));
        assert_eq!(Timed::from_value(&s.to_value()), Some(s));
        let neg = Timed {
            value: -5,
            per_s: i64::MIN,
            set_us: -1,
        };
        assert_eq!(Timed::from_value(&neg.to_value()), Some(neg));
    }
}
