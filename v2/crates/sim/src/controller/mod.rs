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
//! - **Carried across a link** (T9b #3120). A link names the move that crosses it (T4); the world turns a skill's
//!   `Host::cross` into a [`Track`] (`crate::host::carry`), and the controller carries the body along it, at most its
//!   speed times the tick, then stands it on the far node's surface. Velocity inputs wait meanwhile.
//! - **Gaze and voice** (B11 #2742). Where a body looks ([`Gaze`]: a node, a point or ahead) is part of its input,
//!   set by the driver holding its gaze resources and logged when it changes. Its voice carries one utterance at a
//!   time ([`Line`], [`Controller::say`]): a new one replaces the one under way or waits behind it, by the intent's
//!   `replace`, and each lasts its length, one timer. A tick lists the utterances it started ([`Stepped::said`]); the
//!   world resolves their hearers and writes them (`crate::speech`).
//! - **A dry run** ([`Controller::probe`]): what one step would do to a copy of a body, moving nothing. The world's
//!   geometry answers use it (is a straight walk clear?), so the mover has no caller but this module.
//!
//! Not here: moves themselves and cancel rules (B2), gateway intents (lane I), drawing (lane V), the transfer
//! records of a crossing (N6's `mover::cross`), and N7's `Crowd`, which keeps its own bodies until T9c retires it
//! (it steps them through [`Controller::probe`] and [`Track::advance`]).

use std::collections::{BTreeMap, VecDeque};

use crate::index::Index;
use crate::mover::{Body as Moved, Surface};
use replica::bodies::{Body as Claims, Class, Family, SkillShape};
use replica::effects::Refusal;
use replica::encode::{Name, Value, encode};
use replica::ids::Id;
use replica::pose::{ControllerInput, Frame, HandOff, Mode, Quat, Support, Vec3};
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

/// Where a body looks: a node, a point in its frame (µm), or ahead. Record `{1: 1 ahead | 2 node | 3 point, 2: node or
/// [x, y, z]}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gaze {
    Ahead,
    Node(Id),
    Point(Vec3),
}

impl Gaze {
    fn record(&self) -> Value {
        let (n, at) = match self {
            Gaze::Ahead => return Value::Map(BTreeMap::from([(1, Value::Uint(1))])),
            Gaze::Node(id) => (2, id.to_value()),
            Gaze::Point(p) => (3, Value::Array(vec![int(p.x), int(p.y), int(p.z)])),
        };
        Value::Map(BTreeMap::from([(1, Value::Uint(n)), (2, at)]))
    }
}

/// One utterance for a voice to carry: the reference its words are kept under, how long it lasts (from its words,
/// `replica::speech::length_of`), and whether it replaces the one under way or waits behind it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub words: Id,
    pub length: Micros,
    pub replace: bool,
}

/// A body's voice: the utterance under way, until when, and those waiting, in order.
#[derive(Clone, Debug, Default)]
struct Voice {
    now: Option<(Line, Micros)>,
    waiting: VecDeque<Line>,
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
    /// Where it looks: the gaze resources.
    pub gaze: Gaze,
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
            gaze: Gaze::Ahead,
            moves: BTreeMap::new(),
        }
    }

    /// The log record of this input for `body` at `at`: `{1: at, 2: body, 3: [vx, vy, vz], 4: [w, x, y, z],
    /// 5: mode, 6: stance, 7: [[resource, move], ...], 8: gaze}`, 7 left out when no resource has a move and 8 when it
    /// looks ahead.
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
        if self.gaze != Gaze::Ahead {
            m.insert(8, self.gaze.record());
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
    /// Where it looks: the gaze resources.
    Gaze(Gaze),
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
    /// The utterances started this tick, in body order, with when each ends: the world resolves their hearers and
    /// writes them (`crate::speech`).
    pub said: Vec<(Id, Line, Micros)>,
}

/// A carry across a link by its move (T9b #3120): a line to follow at a speed, then standing on a node's surface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Track {
    pub link: Id,
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
    pub fn advance(
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
    track: Option<Track>,
    voice: Voice,
}

/// Every body's claims, input and mover state; the only way any of them is moved or posed.
#[derive(Default)]
pub struct Controller {
    bodies: BTreeMap<Id, Slot>,
    /// The last driver number given.
    drivers: Driver,
    log: Vec<Logged>,
    /// Where each body not being carried stands, kept as the bodies move: "who is near" (N16).
    near: Index,
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
            let gaze = self.input.gaze;
            let moves = std::mem::take(&mut self.input.moves);
            self.input = Input {
                moves,
                gaze,
                ..Input::neutral(facing)
            };
        }
        if Self::covers(family, Class::Gaze, held) {
            self.input.gaze = Gaze::Ahead;
        }
        if Self::covers(family, Class::Voice, held) {
            self.voice = Voice::default();
        }
        for r in held {
            self.input.moves.remove(r);
        }
    }

    /// Whether `held` names a resource of `class`.
    fn covers(family: &Family, class: Class, held: &[Name]) -> bool {
        family
            .resources
            .iter()
            .any(|r| r.class == class && held.contains(&r.name))
    }

    /// Whether `driver` holds a resource of `class` (`resource-missing` when the body has none).
    fn holds(&self, driver: Driver, class: Class) -> R<()> {
        let family = self.claims.family();
        let mut of = family
            .resources
            .iter()
            .filter(|r| r.class == class)
            .peekable();
        if of.peek().is_none() {
            return refuse(
                "resource-missing",
                format!("{} has no {class:?}", family.name.as_str()),
            );
        }
        if of.any(|r| self.claims.holder(&r.name) == Some(driver)) {
            return Ok(());
        }
        refuse(
            "resource-not-held",
            format!("{class:?} is not held by driver {driver}"),
        )
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
        self.near.put_moved(&moved);
        self.bodies.insert(
            moved.id,
            Slot {
                claims: Claims::new(family),
                moved,
                input,
                logged: None,
                track: None,
                voice: Voice::default(),
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
        let s = self.slot(body)?;
        s.steers(driver)?;
        if let Some(t) = &s.track {
            return refuse("crossing-under-way", replica::world_model::show(t.link));
        }
        s.input.velocity = Vec3::ZERO;
        s.track = Some(track);
        self.near.remove_body(body);
        Ok(())
    }

    /// The link `body` is being carried across, if any.
    pub fn carrying(&self, body: Id) -> Option<Id> {
        self.bodies.get(&body)?.track.as_ref().map(|t| t.link)
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
            Part::Gaze(g) => {
                s.holds(driver, Class::Gaze)?;
                s.input.gaze = g;
            }
        }
        Ok(())
    }

    /// Gives `body`'s voice an utterance, if `driver` holds a voice resource: with `replace` it ends the one under way
    /// and any waiting, and starts on the next step; else it waits behind them.
    pub fn say(&mut self, body: Id, driver: Driver, line: Line) -> R<()> {
        let s = self.slot(body)?;
        s.holds(driver, Class::Voice)?;
        if line.length <= 0 {
            return refuse("utterance-empty", format!("{} µs", line.length));
        }
        if line.replace {
            s.voice = Voice::default();
        }
        s.voice.waiting.push_back(line);
        Ok(())
    }

    /// The utterance `body`'s voice carries now, and when it ends.
    pub fn saying(&self, body: Id) -> Option<&(Line, Micros)> {
        self.bodies.get(&body)?.voice.now.as_ref()
    }

    /// One tick: each body, in id order, has its input logged if it changed, takes its facing, and is stepped by
    /// the mover of the surface it stands on. A body refused here is listed and stays where it was; the others go on.
    pub fn step(&mut self, surfaces: &BTreeMap<Id, Surface>, dt: Micros, at: Micros) -> Stepped {
        let mut out = Stepped::default();
        for (&id, s) in self.bodies.iter_mut() {
            if s.voice.now.as_ref().is_some_and(|(_, ends)| *ends <= at) {
                s.voice.now = None;
            }
            if s.voice.now.is_none()
                && let Some(line) = s.voice.waiting.pop_front()
            {
                let ends = at.saturating_add(line.length);
                out.said.push((id, line.clone(), ends));
                s.voice.now = Some((line, ends));
            }
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
            if let Some(t) = s.track.as_mut() {
                match t.advance(&mut s.moved, surfaces, dt) {
                    Ok(true) => {
                        s.track = None;
                        s.input.velocity = Vec3::ZERO;
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
