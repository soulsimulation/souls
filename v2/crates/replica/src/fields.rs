//! The node field numbers the engine and the import keep for themselves: one list, so content cannot take them.
//!
//! A Soul Actions entry numbers its kind's state fields on the thing's own node, beside the fields the import and
//! the engine write there. An entry field numbered like one of those reads the engine's value and the engine's checks
//! (an edit refuses a set of [`crate::edit::DOOR_GEOMETRY`], for one) refuse the creator's. Entries number their state
//! in [`ENTRY_FIELDS`] (from 28, `content/kinds`, #3843); engine fields a thing carries sit outside it, new ones at
//! [`ENGINE_THING_FIELDS`] or above. `import-eden`'s `entries` test refuses an entry state field that takes a number [`reserved`] keeps on
//! things, and the crates that define these numbers test that this list names them.

/// Which nodes a reserved number is kept on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum On {
    /// Any thing's node (or any node at all): an entry's state field must not take it.
    Thing,
    /// A Soul's body.
    Body,
    /// A link (a doorway, a stair).
    Link,
    /// The world's root node.
    World,
    /// A place node (a landform).
    Place,
}

/// A reserved field: its number, the constant that names it and where it lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserved {
    pub n: u64,
    pub name: &'static str,
    pub on: On,
}

/// The numbers an entry's state fields take: above the import's 1 to 27, below the engine's 80 to 87.
pub const ENTRY_FIELDS: std::ops::Range<u64> = 28..80;
/// The first number of the block new engine fields take.
pub const ENGINE_THING_FIELDS: u64 = 100;

const fn r(n: u64, name: &'static str, on: On) -> Reserved {
    Reserved { n, name, on }
}

/// Every engine-reserved node field number above the import's (the import's `F_*`, 1 to 27, are all on things and
/// are listed by `import-eden`'s own constants).
const RESERVED: &[Reserved] = &[
    r(28, "sim::edit::terrain landform parameters", On::Place),
    r(30, "worldd::words::NAME", On::Body),
    r(31, "worldd::words::DESCRIPTION", On::Body),
    r(32, "skills::wear::BODY", On::Body),
    r(33, "skills::wear::LOOK", On::Body),
    r(crate::host::F_CROSSING, "host::F_CROSSING", On::Body),
    r(crate::host::F_WAITING, "host::F_WAITING", On::Body),
    r(crate::host::F_TURNS, "host::F_TURNS", On::Link),
    r(crate::host::F_GRANTED, "host::F_GRANTED", On::Link),
    r(crate::host::F_SHOULDER, "host::F_SHOULDER", On::Body),
    r(crate::host::F_ROUTE, "host::F_ROUTE", On::Body),
    r(crate::host::F_HELD, "host::F_HELD", On::Body),
    r(crate::host::F_SETTLED, "host::F_SETTLED", On::Body),
    r(crate::host::F_LINE, "host::F_LINE", On::Body),
    r(crate::walk::F_MANNER, "walk::F_MANNER", On::Body),
    r(crate::sky::F_DAY_S, "sky::F_DAY_S", On::World),
    r(crate::sky::F_CIVIL_ORIGIN, "sky::F_CIVIL_ORIGIN", On::World),
    r(crate::sky::F_OFFSETS, "sky::F_OFFSETS", On::World),
    r(crate::sky::F_LIGHT_TABLE, "sky::F_LIGHT_TABLE", On::World),
    r(crate::sky::F_SEED, "sky::F_SEED", On::World),
    r(
        crate::sky::F_WEATHER_UNTIL,
        "sky::F_WEATHER_UNTIL",
        On::World,
    ),
    r(crate::sky::F_SKY_DATE, "sky::F_SKY_DATE", On::World),
    r(crate::sky::F_PALETTE, "sky::F_PALETTE", On::World),
    r(crate::sky::F_MIST, "sky::F_MIST", On::World),
    r(crate::sky::F_SKY_HOUR, "sky::F_SKY_HOUR", On::World),
    r(crate::sky::F_STRIKE, "sky::F_STRIKE", On::World),
    r(crate::time::F_CLOCK_WORLD, "time::F_CLOCK_WORLD", On::World),
    r(crate::time::F_CLOCK_REAL, "time::F_CLOCK_REAL", On::World),
    r(crate::time::F_CLOCK_RATE, "time::F_CLOCK_RATE", On::World),
    r(crate::sky::F_LIGHT, "sky::F_LIGHT", On::World),
    r(crate::sky::F_LIGHT_NEXT, "sky::F_LIGHT_NEXT", On::World),
    r(crate::sky::F_DATE, "sky::F_DATE", On::World),
    r(crate::sky::F_WEEKDAY, "sky::F_WEEKDAY", On::World),
    r(crate::sky::F_DAY_NEXT, "sky::F_DAY_NEXT", On::World),
    r(crate::sky::F_WEATHER, "sky::F_WEATHER", On::World),
    r(crate::sky::F_CLOUD, "sky::F_CLOUD", On::World),
    r(crate::sky::F_RAIN, "sky::F_RAIN", On::World),
    r(crate::sky::F_WIND, "sky::F_WIND", On::World),
    r(crate::sky::F_WEATHER_NEXT, "sky::F_WEATHER_NEXT", On::World),
    r(crate::arrival::F_ARRIVAL, "arrival::F_ARRIVAL", On::World),
    r(crate::schedule::F_COURSE, "schedule::F_COURSE", On::Thing),
    r(crate::schedule::F_HOURS, "schedule::F_HOURS", On::Thing),
    r(crate::schedule::F_PLACE, "schedule::F_PLACE", On::Thing),
    r(crate::schedule::F_START, "schedule::F_START", On::Thing),
    r(crate::schedule::F_END, "schedule::F_END", On::Thing),
    r(crate::schedule::F_TEXT, "schedule::F_TEXT", On::Thing),
    r(
        crate::schedule::F_POSTED_BY,
        "schedule::F_POSTED_BY",
        On::Thing,
    ),
    r(crate::schedule::F_STEER, "schedule::F_STEER", On::Thing),
    r(crate::edit::DOOR_GEOMETRY, "edit::DOOR_GEOMETRY", On::Thing),
    // Kept for fields in review (21 Nov): a place's aliases (#3904), district plans, build claims and land-use zones
    // on the zone's root (#3879, #3913), and the owner and access marks any node may carry (#3913).
    r(101, "F_ALIASES (#3904)", On::Place),
    r(102, "import_eden::F_DEF_BODIES", On::Thing),
    r(103, "import_eden::F_GROUND_PALETTE", On::Thing),
    r(140, "edit::claims F_DISTRICTS (#3879)", On::Place),
    r(141, "edit::claims F_CLAIMS (#3879)", On::Place),
    r(142, "F_ZONES (#3913)", On::Place),
    r(143, "who_may::F_OWNER (#3913)", On::Thing),
    r(144, "who_may::F_ACCESS (#3913)", On::Thing),
    // 0.134 R4: a creator's tint on a thing or one of its parts (`souls-god recolor`).
    r(crate::tint::F_TINT, "tint::F_TINT", On::Thing),
];

/// Every engine-reserved node field number above the import's, in the order listed.
pub fn reserved() -> &'static [Reserved] {
    RESERVED
}

/// The reserved field numbered `n` on things, if one is.
pub fn on_things(n: u64) -> Option<&'static Reserved> {
    RESERVED.iter().find(|f| f.n == n && f.on == On::Thing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_number_is_kept_twice_on_the_same_nodes() {
        for (i, a) in RESERVED.iter().enumerate() {
            for b in &RESERVED[..i] {
                assert!(
                    a.n != b.n || (a.on != b.on && a.on != On::Thing && b.on != On::Thing),
                    "{} and {} both take {}",
                    a.name,
                    b.name,
                    a.n
                );
            }
        }
    }

    #[test]
    fn engine_fields_on_things_sit_outside_the_entries_range() {
        for f in RESERVED.iter().filter(|f| f.on == On::Thing) {
            assert!(
                !ENTRY_FIELDS.contains(&f.n),
                "{} = {} is in the entries' range",
                f.name,
                f.n
            );
        }
        const { assert!(crate::edit::DOOR_GEOMETRY >= ENGINE_THING_FIELDS) };
    }
}
