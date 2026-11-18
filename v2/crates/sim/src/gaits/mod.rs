//! Gaits (Engine v2 N11a, #2735): how fast a body goes, as data. A gait is a name, a speed along the surface in µm a
//! second, and the ground it may be used on. The mover (N6) takes the speed along the surface, so a body walking up a
//! hill covers the same distance on the ground as one on the flat; the steep cells it may not stand on are cut from the
//! open ground (`crate::ground`, [`crate::ground::STEEP`]).
//!
//! Starting values are today's (walk 1.35, jog 2.5, run 4.0, wade 0.9, swim 0.8 m/s). Walk, jog and run are used on
//! dry ground; wading on ground under at most [`WADE_DEPTH`] of water, swimming on the water's surface where it is
//! deeper (N11b, #3198: the open ground's water pieces, `crate::ground::OpenGround::cut_water`).

/// The ground a gait may be used on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ground {
    /// The open ground and floors, out of the water.
    Dry,
    /// Ground under water no deeper than [`WADE_DEPTH`]: a body stands on the bed.
    Wading,
    /// A water's surface where it is deeper: a body swims at the water's level.
    Water,
}

/// The deepest water a body wades in, µm (today's 0.3 m); deeper is swimming.
pub const WADE_DEPTH: i64 = 300_000;

/// A gait: its name, its speed along the surface (µm a second) and the ground it may be used on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gait {
    pub name: &'static str,
    pub speed: i64,
    pub on: &'static [Ground],
}

pub const WALK: Gait = Gait {
    name: "walk",
    speed: 1_350_000,
    on: &[Ground::Dry],
};
pub const JOG: Gait = Gait {
    name: "jog",
    speed: 2_500_000,
    on: &[Ground::Dry],
};
pub const RUN: Gait = Gait {
    name: "run",
    speed: 4_000_000,
    on: &[Ground::Dry],
};

pub const WADE: Gait = Gait {
    name: "wade",
    speed: 900_000,
    on: &[Ground::Wading],
};
pub const SWIM: Gait = Gait {
    name: "swim",
    speed: 800_000,
    on: &[Ground::Water],
};

/// Every gait on dry ground, slowest first, then wading and swimming.
pub const GAITS: [Gait; 5] = [WALK, JOG, RUN, WADE, SWIM];

impl Gait {
    /// The gait called `name`.
    pub fn named(name: &str) -> Option<Gait> {
        GAITS.into_iter().find(|g| g.name == name)
    }

    /// Whether the gait may be used on `ground`.
    pub fn allowed(&self, ground: Ground) -> bool {
        self.on.contains(&ground)
    }
}
