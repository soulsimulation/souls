//! The controller (Engine v2 B1, #2680): the only way a body is moved or posed. It holds every body's mover state
//! (N6's `mover::Body`) privately, so nothing else can move one, and it is the one caller of the mover.
//!
//! - **Claims, one driver per resource.** A driver is a claim on a body's resources, made with T9's own rules
//!   (`replica::bodies`, `v2/docs/bodies.md` rules 2 to 4): a second driver asking for a held resource is refused by
//!   T9's name (`resource-held`, `resource-blocked`), and the first driver's input stands. So a body can walk, carry
//!   and talk at once, each under its own driver. A driver is a skill, through the host (`crate::host::hand_on`), or a
//!   script (`v2/tools/body-script`).
//! - **One input type for every family** ([`Input`]): a velocity in three dimensions in the frame's axes and a
//!   movement mode (T4's `ControllerInput`), a facing, a stance, and one move per resource. Velocity, facing, mode
//!   and stance belong to the body's locomotion resources: only the driver holding all of them sets them. A move
//!   belongs to the resource it names. A family differs in how it answers: a body with no hands has no hand move.
//!   Anything else is refused as `resource-not-held` or `resource-missing`.
//! - **Neutral.** A resource no driver holds gets the neutral input: standing still, hands down (no move). Facing
//!   is kept. A neutral input never moves a body: its velocity is zero.
//! - **Logged when it changes.** A body's input enters the log only when it differs from the last one logged, so a
//!   body walking a straight line adds no record ([`Logged`]). The log holds inputs, not motion: the mover's motion
//!   samples are its own output.
//!
//! Not here: moves themselves and cancel rules (B2), gateway intents (lane I), drawing (lane V), N7's walk, which
//! still steps the mover itself until T9b (#3120) moves it behind the host.

use std::collections::BTreeMap;

use crate::mover::{Body as Moved, Surface};
use replica::bodies::{Body as Claims, Class, Family, SkillShape};
use replica::effects::Refusal;
use replica::encode::{Name, Value, encode};
use replica::ids::Id;
use replica::pose::{ControllerInput, HandOff, Mode, Quat, Support, Vec3};
use replica::time::Micros;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// A driver: the number of its claim on a body (T9's instance number), unique in the controller.
pub type Driver = u64;

/// How the body holds itself. Record numbers 1 stand, 2 sit, 3 lie.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stance {
    Stand,
    Sit,
    Lie,
}

/// What a body is driven by: the same type for every family.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Input {
    /// µm a second, in the axes of the frame the body is in (T4 rule 11).
    pub velocity: Vec3,
    pub mode: Mode,
    /// The body's orientation in its frame.
    pub facing: Quat,
    pub stance: Stance,
    /// One move per resource, by resource name; a resource with none is at rest (B2 says what a move is).
    pub moves: BTreeMap<Name, Name>,
}

impl Input {
    /// The neutral input, facing `facing`: standing still, hands down.
    pub fn neutral(facing: Quat) -> Input {
        Input {
            velocity: Vec3::ZERO,
            mode: Mode::Surface,
            facing,
            stance: Stance::Stand,
            moves: BTreeMap::new(),
        }
    }

    /// The log record of this input for `body` at `at`: `{1: at, 2: body, 3: [vx, vy, vz], 4: [w, x, y, z],
    /// 5: mode, 6: stance, 7: [[resource, move], ...]}`, 7 left out when no resource has a move.
    pub fn record(&self, at: Micros, body: Id) -> Value {
        let ints = |v: &[i64]| Value::Array(v.iter().map(|n| int(*n)).collect());
        let v = self.velocity;
        let mut m = BTreeMap::from([
            (1, int(at)),
            (2, body.to_value()),
            (3, ints(&[v.x, v.y, v.z])),
            (4, ints(&self.facing.parts())),
            (
                5,
                Value::Uint(match self.mode {
                    Mode::Surface => 1,
                }),
            ),
            (
                6,
                Value::Uint(match self.stance {
                    Stance::Stand => 1,
                    Stance::Sit => 2,
                    Stance::Lie => 3,
                }),
            ),
        ]);
        if !self.moves.is_empty() {
            let moves = self
                .moves
                .iter()
                .map(|(r, mv)| Value::Array(vec![Value::Text(r.clone()), Value::Text(mv.clone())]))
                .collect();
            m.insert(7, Value::Array(moves));
        }
        Value::Map(m)
    }
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

/// One part of an input, set by the driver that holds its resources.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Part {
    /// Velocity and mode: the locomotion resources.
    Velocity(Vec3, Mode),
    /// Facing: the locomotion resources.
    Facing(Quat),
    /// Stance: the locomotion resources.
    Stance(Stance),
    /// A move for the named resource, or none (at rest).
    Move(Name, Option<Name>),
}

/// An input record in the log: when, whose, and its bytes (T0's encoding of [`Input::record`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Logged {
    pub at: Micros,
    pub body: Id,
    pub bytes: Vec<u8>,
}

/// What one tick of the controller did: the mover's motion samples, and the bodies whose step was refused (each
/// refused alone; the others stepped).
#[derive(Debug, Default)]
pub struct Stepped {
    pub samples: Vec<HandOff>,
    pub refused: Vec<(Id, Refusal)>,
}

struct Slot {
    claims: Claims,
    moved: Moved,
    input: Input,
    logged: Option<Input>,
}

/// Every body's claims, input and mover state; the only way any of them is moved or posed.
#[derive(Default)]
pub struct Controller {
    bodies: BTreeMap<Id, Slot>,
    /// The last driver number given.
    drivers: Driver,
    log: Vec<Logged>,
}

impl Slot {
    /// The parts `held` covered go back to neutral: locomotion to standing still, each resource's move to none.
    fn neutral(&mut self, held: &[Name]) {
        let family = self.claims.family();
        let locomotion = family
            .resources
            .iter()
            .any(|r| r.class == Class::Locomotion && held.contains(&r.name));
        if locomotion {
            let facing = self.input.facing;
            let moves = std::mem::take(&mut self.input.moves);
            self.input = Input {
                moves,
                ..Input::neutral(facing)
            };
        }
        for r in held {
            self.input.moves.remove(r);
        }
    }

    /// Whether `driver` holds every locomotion resource of the body.
    fn steers(&self, driver: Driver) -> R<()> {
        let family = self.claims.family();
        let mut legs = family
            .resources
            .iter()
            .filter(|r| r.class == Class::Locomotion)
            .peekable();
        if legs.peek().is_none() {
            return refuse(
                "resource-missing",
                format!("{} has no locomotion", family.name.as_str()),
            );
        }
        for r in legs {
            if self.claims.holder(&r.name) != Some(driver) {
                return refuse(
                    "resource-not-held",
                    format!("{} is not held by driver {driver}", r.name.as_str()),
                );
            }
        }
        Ok(())
    }
}

impl Controller {
    pub fn new() -> Controller {
        Controller::default()
    }

    /// Adds a body of `family`, standing as the mover placed it, with the neutral input facing as it faces.
    pub fn add(&mut self, family: Family, moved: Moved) -> R<()> {
        if self.bodies.contains_key(&moved.id) {
            return refuse("body-duplicate", replica::world_model::show(moved.id));
        }
        let input = Input::neutral(moved.pose.orientation);
        self.bodies.insert(
            moved.id,
            Slot {
                claims: Claims::new(family),
                moved,
                input,
                logged: None,
            },
        );
        Ok(())
    }

    fn slot(&mut self, body: Id) -> R<&mut Slot> {
        match self.bodies.get_mut(&body) {
            Some(s) => Ok(s),
            None => refuse("body-unknown", replica::world_model::show(body)),
        }
    }

    /// The body as the mover last left it.
    pub fn body(&self, body: Id) -> Option<&Moved> {
        self.bodies.get(&body).map(|s| &s.moved)
    }

    /// The body's input now.
    pub fn input(&self, body: Id) -> Option<&Input> {
        self.bodies.get(&body).map(|s| &s.input)
    }

    /// The body's claims (T9's view: who holds what).
    pub fn claims(&self, body: Id) -> Option<&Claims> {
        self.bodies.get(&body).map(|s| &s.claims)
    }

    /// The input log, in order.
    pub fn log(&self) -> &[Logged] {
        &self.log
    }

    /// A new driver on `body`, claiming what `shape` claims, all or none (T9 rule 4). A resource another driver
    /// holds is refused by T9's name unless that driver gives way; a driver that gives way ends, and the parts it
    /// held go back to neutral.
    pub fn claim(&mut self, body: Id, shape: &SkillShape) -> R<Driver> {
        let n = self.drivers + 1;
        let s = self.slot(body)?;
        let before = s.claims.running().clone();
        let started = s.claims.start(n, shape)?;
        for c in started.cancelled {
            if let Some(i) = before.get(&c) {
                s.neutral(&i.holds);
            }
        }
        self.drivers = n;
        Ok(n)
    }

    /// Ends `driver` on `body`: it releases all it holds, and those parts go back to neutral.
    pub fn release(&mut self, body: Id, driver: Driver) -> R<()> {
        let s = self.slot(body)?;
        let held = s.claims.end(driver);
        s.neutral(&held);
        Ok(())
    }

    /// Sets one part of `body`'s input, if `driver` holds its resources (`resource-not-held`, `resource-missing`).
    pub fn set(&mut self, body: Id, driver: Driver, part: Part) -> R<()> {
        let s = self.slot(body)?;
        match part {
            Part::Velocity(v, mode) => {
                s.steers(driver)?;
                s.input.velocity = v;
                s.input.mode = mode;
            }
            Part::Facing(q) => {
                s.steers(driver)?;
                s.input.facing = q;
            }
            Part::Stance(st) => {
                s.steers(driver)?;
                s.input.stance = st;
            }
            Part::Move(r, mv) => {
                let family = s.claims.family();
                if !family.resources.iter().any(|x| x.name == r) {
                    return refuse(
                        "resource-missing",
                        format!("{} has no {}", family.name.as_str(), r.as_str()),
                    );
                }
                if s.claims.holder(&r) != Some(driver) {
                    return refuse(
                        "resource-not-held",
                        format!("{} is not held by driver {driver}", r.as_str()),
                    );
                }
                match mv {
                    Some(mv) => s.input.moves.insert(r, mv),
                    None => s.input.moves.remove(&r),
                };
            }
        }
        Ok(())
    }

    /// One tick: each body, in id order, has its input logged if it changed, takes its facing, and is stepped by
    /// the mover of the surface it stands on. A body refused here is listed and stays where it was; the others go on.
    pub fn step(&mut self, surfaces: &BTreeMap<Id, Surface>, dt: Micros, at: Micros) -> Stepped {
        let mut out = Stepped::default();
        for (&id, s) in self.bodies.iter_mut() {
            if s.logged.as_ref() != Some(&s.input) {
                match encode(&s.input.record(at, id)) {
                    Ok(bytes) => self.log.push(Logged {
                        at,
                        body: id,
                        bytes,
                    }),
                    Err(e) => {
                        out.refused.push((
                            id,
                            Refusal {
                                name: "encoding",
                                detail: e.to_string(),
                            },
                        ));
                        continue;
                    }
                }
                s.logged = Some(s.input.clone());
            }
            s.moved.pose.orientation = s.input.facing;
            let Support::Surface { surface, .. } = s.moved.pose.support else {
                out.refused.push((
                    id,
                    Refusal {
                        name: "support-not-surface",
                        detail: replica::world_model::show(id),
                    },
                ));
                continue;
            };
            let Some(on) = surfaces.get(&surface) else {
                out.refused.push((
                    id,
                    Refusal {
                        name: "no-surface",
                        detail: replica::world_model::show(surface),
                    },
                ));
                continue;
            };
            let input = ControllerInput {
                velocity: s.input.velocity,
                mode: s.input.mode,
            };
            match on.step(&mut s.moved, input, dt, at) {
                Ok(Some(h)) => out.samples.push(h),
                Ok(None) => {}
                Err(r) => out.refused.push((id, r)),
            }
        }
        out
    }
}
