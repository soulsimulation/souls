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
//! - **In a slot (B3).** [`Controller::seat`] hands a body from its surface into a slot and [`Controller::stand`]
//!   back, for the driver holding its legs. A body in a slot is kept apart from those the tick steps, so it costs a
//!   tick nothing; it is visited only to log an input that changed.
//!
//! - **Carried across a link** (T9b #3120). A link names the move that crosses it (T4); the world turns a skill's
//!   `Host::cross` into a [`Track`] (`crate::host::carry`), and the controller carries the body along it, at most its
//!   speed times the tick, then stands it on the far node's surface. Velocity inputs wait meanwhile.
//! - **A dry run** ([`Controller::probe`]): what one step would do to a copy of a body, moving nothing. The world's
//!   geometry answers use it (is a straight walk clear?), so the mover has no caller but this module.
//!
//! - **The world's own carry** ([`Controller::carry`], T9c #3127): the world carries a body by its own rule, with no
//!   driver: N10's walk-out to the nearest legal point, at the body's speed, collision off. It is a [`Track`] with no
//!   link, stepped like a crossing.
//! - **Standing still is not stepped.** A body with no velocity asked, none of its own and no track is left as it is:
//!   the mover would leave it so.
//!
//! Not here: moves themselves and cancel rules (B2), gateway intents (lane I), drawing (lane V), and the transfer
//! records of a crossing (N6's `mover::cross`).

use std::collections::{BTreeMap, BTreeSet};

use crate::index::Index;
use crate::mover::{Body as Moved, Surface};
use replica::bodies::{Body as Claims, Class, Family, SkillShape};
use replica::effects::Refusal;
use replica::encode::{Name, Value, encode};
use replica::ids::Id;
use replica::pose::{ControllerInput, Frame, HandOff, Mode, Owner, Pose, Quat, Support, Vec3};
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

/// A carry across a link by its move (T9b #3120), or by the world's own rule (N10's walk-out): a line to follow at a
/// speed, then standing on a node's surface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Track {
    /// The link crossed; none for the world's own carry.
    pub link: Option<Id>,
    /// The points left to follow, µm, in the frame of the node the body stands on when it begins.
    pub line: Vec<Vec3>,
    /// µm a second.
    pub speed: i64,
    /// The node it stands on at the end.
    pub to: Id,
    /// Where on `to` it stands (that node's frame) when the line is in another frame; else the line's last point.
    pub arrive: Option<Vec3>,
}

fn dist2(a: Vec3, b: Vec3) -> i128 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)
}

impl Track {
    /// One tick along the line, at most speed times `dt`: `true` once the body stands on `to`'s surface.
    fn advance(
        &mut self,
        body: &mut Moved,
        surfaces: &BTreeMap<Id, Surface>,
        dt: Micros,
    ) -> R<bool> {
        if dt <= 0 {
            return refuse("tick-not-positive", format!("{dt} µs"));
        }
        let mut reach = i128::from(self.speed) * i128::from(dt) / 1_000_000;
        let mut p = body.pose.position;
        while let Some(&next) = self.line.first() {
            let d = dist2(p, next).isqrt();
            if d <= reach {
                reach -= d;
                p = next;
                self.line.remove(0);
                continue;
            }
            let part = |a: i64, b: i64| a + (i128::from(b - a) * reach / d) as i64;
            p = Vec3::new(part(p.x, next.x), part(p.y, next.y), part(p.z, next.z));
            break;
        }
        let old = body.pose.position;
        let v = |a: i64, b: i64| ((i128::from(b - a) * 1_000_000) / i128::from(dt)) as i64;
        body.linear = Vec3::new(v(old.x, p.x), v(old.y, p.y), v(old.z, p.z));
        body.pose.position = p;
        if !self.line.is_empty() {
            return Ok(false);
        }
        let Some(on) = surfaces.get(&self.to) else {
            return refuse("no-surface", replica::world_model::show(self.to));
        };
        let linear = body.linear;
        let frame = Frame {
            node: self.to,
            slot: None,
        };
        *body = on.place(
            body.id,
            frame,
            self.arrive.unwrap_or(p),
            body.pose.orientation,
        )?;
        body.linear = linear;
        Ok(true)
    }
}

struct Slot {
    claims: Claims,
    moved: Moved,
    input: Input,
    logged: Option<Input>,
    /// Whether the input may differ from the one logged: set by every change, so an unchanged body costs no compare.
    touched: bool,
    track: Option<Track>,
}

/// Every body's claims, input and mover state; the only way any of them is moved or posed.
#[derive(Default)]
pub struct Controller {
    bodies: BTreeMap<Id, Slot>,
    /// Bodies in a slot (a seat, B3): no mover, so a tick never visits them, unless their input changed (`woken`).
    rested: BTreeMap<Id, Slot>,
    woken: BTreeSet<Id>,
    /// The last driver number given.
    drivers: Driver,
    log: Vec<Logged>,
    /// Where each body not being carried stands, kept as the bodies move: "who is near" (N16).
    near: Index,
}

/// Moves `body` from one of the controller's maps to the other, at rest in `pose`, for the driver steering it.
fn hand(
    from: &mut BTreeMap<Id, Slot>,
    to: &mut BTreeMap<Id, Slot>,
    body: Id,
    driver: Driver,
    at: Micros,
    pose: Pose,
) -> R<HandOff> {
    let into_slot = pose.support == Support::Slot;
    let Some(s) = from.get(&body) else {
        let not = if into_slot {
            "support-not-surface"
        } else {
            "support-not-slot"
        };
        return refuse(not, replica::world_model::show(body));
    };
    s.steers(driver)?;
    let Some(mut s) = from.remove(&body) else {
        unreachable!("found above")
    };
    s.moved.pose = pose;
    s.moved.linear = Vec3::ZERO;
    s.touched = true;
    to.insert(body, s);
    let (from, to) = if into_slot {
        (Owner::Mover, Owner::Slot)
    } else {
        (Owner::Slot, Owner::Mover)
    };
    Ok(HandOff {
        node: body,
        at,
        from,
        to,
        pose,
        linear: Vec3::ZERO,
        angular: Vec3::ZERO,
    })
}

impl Slot {
    /// Logs the input if it changed since it was last logged.
    fn log(&mut self, id: Id, at: Micros, log: &mut Vec<Logged>) -> R<()> {
        if self.touched && self.logged.as_ref() != Some(&self.input) {
            let bytes = encode(&self.input.record(at, id)).map_err(|e| Refusal {
                name: "encoding",
                detail: e.to_string(),
            })?;
            log.push(Logged {
                at,
                body: id,
                bytes,
            });
            self.logged = Some(self.input.clone());
        }
        self.touched = false;
        Ok(())
    }

    /// The parts `held` covered go back to neutral: locomotion to standing still, each resource's move to none.
    fn neutral(&mut self, held: &[Name]) {
        self.touched = true;
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
        if self.get(moved.id).is_some() {
            return refuse("body-duplicate", replica::world_model::show(moved.id));
        }
        let input = Input::neutral(moved.pose.orientation);
        self.near.put_moved(&moved);
        self.bodies.insert(
            moved.id,
            Slot {
                claims: Claims::new(family),
                moved,
                input,
                logged: None,
                touched: true,
                track: None,
            },
        );
        Ok(())
    }

    fn slot(&mut self, body: Id) -> R<&mut Slot> {
        if let Some(s) = self.rested.get_mut(&body) {
            self.woken.insert(body);
            return Ok(s);
        }
        match self.bodies.get_mut(&body) {
            Some(s) => Ok(s),
            None => refuse("body-unknown", replica::world_model::show(body)),
        }
    }

    fn get(&self, body: Id) -> Option<&Slot> {
        self.bodies.get(&body).or_else(|| self.rested.get(&body))
    }

    /// The body as the mover last left it, or as it sits in its slot.
    pub fn body(&self, body: Id) -> Option<&Moved> {
        self.get(body).map(|s| &s.moved)
    }

    /// The body's input now.
    pub fn input(&self, body: Id) -> Option<&Input> {
        self.get(body).map(|s| &s.input)
    }

    /// The body's claims (T9's view: who holds what).
    pub fn claims(&self, body: Id) -> Option<&Claims> {
        self.get(body).map(|s| &s.claims)
    }

    /// Hands `body` from its surface into `frame`, a slot, at `at`, for the driver holding all its locomotion
    /// (`resource-not-held`): its motion's owner becomes the slot (T4 rule 10), it is at the slot's point, and a tick
    /// no longer steps it. `support-not-surface` when it is in a slot already.
    pub fn seat(&mut self, body: Id, driver: Driver, frame: Frame, at: Micros) -> R<HandOff> {
        let pose = Pose {
            frame,
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: Support::Slot,
        };
        let h = hand(&mut self.bodies, &mut self.rested, body, driver, at, pose)?;
        self.woken.insert(body);
        Ok(h)
    }

    /// The reverse of [`Controller::seat`]: hands `body` from its slot to `placed`, a surface's placement of it (its
    /// seat's stand point), at rest. `support-not-slot` when it is in no slot.
    pub fn stand(&mut self, body: Id, driver: Driver, placed: Moved, at: Micros) -> R<HandOff> {
        let h = hand(
            &mut self.rested,
            &mut self.bodies,
            body,
            driver,
            at,
            placed.pose,
        )?;
        self.woken.remove(&body);
        if let Some(s) = self.bodies.get_mut(&body) {
            s.moved = placed;
        }
        Ok(h)
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

    /// What one step of `input` for `dt` would do to a copy of `body` on `surface`: a dry run that moves nothing.
    pub fn probe(
        surface: &Surface,
        body: &Moved,
        input: ControllerInput,
        dt: Micros,
        at: Micros,
    ) -> R<Moved> {
        let mut b = *body;
        surface.step(&mut b, input, dt, at)?;
        Ok(b)
    }

    /// Carries `body` along `track` from the next step, if `driver` holds its locomotion; its velocity input goes to
    /// still. `crossing-under-way` when it is already carried.
    pub fn cross(&mut self, body: Id, driver: Driver, track: Track) -> R<()> {
        self.slot(body)?.steers(driver)?;
        self.carry(body, track)
    }

    /// The world carries `body` along `track` from the next step by its own rule, with no driver (N10's walk-out);
    /// its velocity input goes to still. `crossing-under-way` when it is already carried.
    pub fn carry(&mut self, body: Id, track: Track) -> R<()> {
        let s = self.slot(body)?;
        if s.track.is_some() {
            return refuse("crossing-under-way", replica::world_model::show(body));
        }
        s.input.velocity = Vec3::ZERO;
        s.touched = true;
        s.track = Some(track);
        self.near.remove_body(body);
        Ok(())
    }

    /// The link `body` is being carried across, if any.
    pub fn carrying(&self, body: Id) -> Option<Id> {
        self.bodies.get(&body)?.track.as_ref().and_then(|t| t.link)
    }

    /// Whether `body` is being carried, across a link or by the world's own rule.
    pub fn carried(&self, body: Id) -> bool {
        self.bodies.get(&body).is_some_and(|s| s.track.is_some())
    }

    /// The spatial index of the bodies not being carried, as the mover last left them (N16).
    pub fn near(&self) -> &Index {
        &self.near
    }

    /// The bodies as the mover last left them, in id order.
    pub fn bodies(&self) -> impl Iterator<Item = &Moved> {
        self.bodies.values().map(|s| &s.moved)
    }

    /// Sets one part of `body`'s input, if `driver` holds its resources (`resource-not-held`, `resource-missing`).
    pub fn set(&mut self, body: Id, driver: Driver, part: Part) -> R<()> {
        let s = self.slot(body)?;
        s.touched = true;
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

    /// One tick: each body on a surface, in id order, has its input logged if it changed, takes its facing, and is
    /// stepped by the mover of the surface it stands on. A body in a slot is visited only when its input changed, to
    /// log it. A body refused here is listed and stays where it was; the others go on.
    pub fn step(&mut self, surfaces: &BTreeMap<Id, Surface>, dt: Micros, at: Micros) -> Stepped {
        let mut out = Stepped::default();
        for id in std::mem::take(&mut self.woken) {
            if let Some(s) = self.rested.get_mut(&id)
                && let Err(r) = s.log(id, at, &mut self.log)
            {
                out.refused.push((id, r));
            }
        }
        for (&id, s) in self.bodies.iter_mut() {
            if let Err(r) = s.log(id, at, &mut self.log) {
                out.refused.push((id, r));
                continue;
            }
            s.moved.pose.orientation = s.input.facing;
            if let Some(t) = s.track.as_mut() {
                match t.advance(&mut s.moved, surfaces, dt) {
                    Ok(true) => {
                        s.track = None;
                        s.input.velocity = Vec3::ZERO;
                        s.touched = true;
                    }
                    Ok(false) => {}
                    Err(r) => {
                        s.track = None;
                        out.refused.push((id, r));
                    }
                }
                if s.track.is_none() {
                    self.near.put_moved(&s.moved);
                }
                continue;
            }
            // Standing still with no velocity asked: the mover would leave it as it is.
            if s.input.velocity == Vec3::ZERO && s.moved.linear == Vec3::ZERO {
                continue;
            }
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
            self.near.put_moved(&s.moved);
        }
        out
    }
}
