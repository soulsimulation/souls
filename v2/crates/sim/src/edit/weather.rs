//! A creator's weather (Engine v2 G5, #2762): the creator's edit that sets E6's one weather field on the world node
//! (`crate::daylight`, `replica::sky`), with its end on the world node's timer list (K9). It makes no second field.
//!
//! [`set`] gives what one fire of E6's weather timer gives ([`Write`]): the kind and its levels of cloud, rain and wind,
//! the end (`sky::F_WEATHER_UNTIL`) and the time of the next change, which is that end, announced by E6's named event
//! (`souls:weather-changed`) for everyone, and `souls:weather` due at the end. The caller writes it as it writes a
//! fire (the change with its event, then the timer cleared and set again), with the creator as actor and the edit's
//! intent as cause. When the timer fires at the end, E6's table resumes (`Daylight::fire`). Weather changes nothing
//! else here: light and warmth are not modelled, and a body moves as before.

use crate::daylight::{Daylight, Write};
use replica::edit::Refused;
use replica::effects::{Change, Event, Rest};
use replica::encode::{Name, Value};
use replica::sky::{self, int};
use replica::time::Micros;

/// A level of cloud, rain or wind outside 0 to 100.
pub const LEVEL: &str = "edit.weather-level";
/// A weather whose end is not after the time it is set.
pub const ENDED: &str = "edit.weather-ended";

fn refused(name: &'static str, detail: String) -> Refused {
    Refused {
        op: None,
        name,
        detail,
    }
}

/// The creator's weather `kind` with `levels` (cloud, rain, wind, each 0 to 100) from world time `at` until `until`,
/// on `sky`'s world node: the write, and `sky`'s settings now hold the end, so its own fires keep the weather until
/// then.
pub fn set(
    sky: &mut Daylight,
    kind: Name,
    levels: [i64; 3],
    at: Micros,
    until: Micros,
) -> Result<Write, Refused> {
    if let Some(l) = levels.iter().find(|l| !(0..=100).contains(*l)) {
        return Err(refused(LEVEL, format!("{l} is not from 0 to 100")));
    }
    if until <= at {
        return Err(refused(
            ENDED,
            format!("the weather would end at {until} µs, not after {at} µs"),
        ));
    }
    let [cloud, rain, wind] = levels;
    let sets = [
        (sky::F_WEATHER, Value::Text(kind.clone())),
        (sky::F_CLOUD, int(cloud)),
        (sky::F_RAIN, int(rain)),
        (sky::F_WIND, int(wind)),
        (sky::F_WEATHER_UNTIL, int(until)),
        (sky::F_WEATHER_NEXT, int(until)),
    ];
    let changes: Vec<Change> = sets
        .into_iter()
        .map(|(field, to)| Change::Set {
            node: sky.world,
            field,
            to,
            by: None,
        })
        .collect();
    sky.cfg.until = Some(until);
    let name = |s: &str| Name::new(s).expect("a constant name");
    Ok(Write {
        timer: name(sky::T_WEATHER),
        changes,
        event: Some(Event {
            name: name(sky::EV_WEATHER),
            fields: [
                (1, Value::Text(kind)),
                (2, int(cloud)),
                (3, int(rain)),
                (4, int(wind)),
            ]
            .into_iter()
            .collect(),
            changes: (0..5).collect(),
            rest: Rest::new(),
        }),
        next: until,
    })
}

#[cfg(test)]
mod tests;
