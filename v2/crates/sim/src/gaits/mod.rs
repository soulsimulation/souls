//! Gaits (Engine v2 N11a, #2735): how fast a body goes, as data. A gait is a name, a speed along the surface in µm a
//! second, and the ground it may be used on. The mover (N6) takes the speed along the surface, so a body walking up a
//! hill covers the same distance on the ground as one on the flat; the steep cells it may not stand on are cut from the
//! open ground (`crate::ground`, [`crate::ground::STEEP`]).
//!
//! Starting values are today's (walk 1.35, jog 2.5, run 4.0 m/s). Every gait here is used on dry ground; wading and
//! swimming, with the ground under water they need, are N11b (#3198).

/// The ground a gait may be used on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ground {
    /// The open ground and floors, out of the water.
    Dry,
}

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

/// Every gait, slowest first.
pub const GAITS: [Gait; 3] = [WALK, JOG, RUN];

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

/// The speed a walk takes for a body's manner (E10, #2781): a gait of that name gives its speed; any other word, or
/// none, walks. A manner never changes where the body may go.
pub fn speed_of(manner: Option<&str>) -> i64 {
    manner.and_then(Gait::named).unwrap_or(WALK).speed
}
