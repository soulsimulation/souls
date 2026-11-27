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
//! - **In a slot (B3).** [`Controller::slot_in`] hands a body from its surface into a slot and [`Controller::stand`]
//!   back, for the driver holding its legs. A body in a slot is kept apart from those the tick steps, so it costs a
//!   tick nothing; it is visited only to log an input that changed.
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
//! - **The world's own carry** ([`Controller::carry`], T9c #3127): the world carries a body by its own rule, with no
//!   driver: N10's walk-out to the nearest legal point, at the body's speed, collision off. It is a [`Track`] with no
//!   link, stepped like a crossing.
//! - **Standing still is not stepped.** A body with no velocity asked, none of its own and no track is left as it is:
//!   the mover would leave it so.
//!
//! Not here: moves themselves and cancel rules (B2), gateway intents (lane I), drawing (lane V), and the transfer
//! records of a crossing (N6's `mover::cross`).

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::index::Index;
use crate::mover::{Body as Moved, Surface};
use replica::bodies::{Body as Claims, Class, Family, SkillShape};
use replica::effects::Refusal;
use replica::encode::{Name, Value};
use replica::ids::Id;
use replica::kinds::sizes::{Build, Size};
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
/// `replica::speech::length_of`), whether it replaces the one under way or waits behind it, and its reach (E13).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub words: Id,
    pub length: Micros,
    pub replace: bool,
    pub reach: replica::speech::Reach,
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

    /// The bytes of [`Input::record`] (T0's encoding), written straight from the input: the same bytes as
    /// `encode(&self.record(at, body))`, without building the record a body a tick (#3213).
    pub fn bytes(&self, at: Micros, body: Id) -> Vec<u8> {
        // A gaze other than ahead (field 8, gaze and voice) is rare: the general encoder writes that record.
        if self.gaze != Gaze::Ahead
            && let Ok(bytes) = replica::encode::encode(&self.record(at, body))
        {
            return bytes;
        }
        let mut out = Vec::with_capacity(96);
        head(&mut out, 5, if self.moves.is_empty() { 6 } else { 7 });
        head(&mut out, 0, 1);
        int_bytes(&mut out, at);
        head(&mut out, 0, 2);
        head(&mut out, 4, 2);
        head(&mut out, 2, 16);
        out.extend_from_slice(&body.scope().0);
        head(&mut out, 0, body.counter());
        head(&mut out, 0, 3);
        head(&mut out, 4, 3);
        let v = self.velocity;
        for n in [v.x, v.y, v.z] {
            int_bytes(&mut out, n);
        }
        head(&mut out, 0, 4);
        head(&mut out, 4, 4);
        for n in self.facing.parts() {
            int_bytes(&mut out, n);
        }
        head(&mut out, 0, 5);
        head(
            &mut out,
            0,
            match self.mode {
                Mode::Surface => 1,
            },
        );
        head(&mut out, 0, 6);
        head(
            &mut out,
            0,
            match self.stance {
                Stance::Stand => 1,
                Stance::Sit => 2,
                Stance::Lie => 3,
            },
        );
        if !self.moves.is_empty() {
            head(&mut out, 0, 7);
            head(&mut out, 4, self.moves.len() as u64);
            for (r, mv) in &self.moves {
                head(&mut out, 4, 2);
                for t in [r.as_str(), mv.as_str()] {
                    head(&mut out, 3, t.len() as u64);
                    out.extend_from_slice(t.as_bytes());
                }
            }
        }
        out
    }
}

/// T0's head of an item: major type `major`, argument `arg`, in the shortest form (as `replica::encode` writes it).
fn head(out: &mut Vec<u8>, major: u8, arg: u64) {
    let m = major << 5;
    if arg < 24 {
        out.push(m | arg as u8);
    } else if let Ok(a) = u8::try_from(arg) {
        out.extend([m | 24, a]);
    } else if let Ok(a) = u16::try_from(arg) {
        out.push(m | 25);
        out.extend(a.to_be_bytes());
    } else if let Ok(a) = u32::try_from(arg) {
        out.push(m | 26);
        out.extend(a.to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend(arg.to_be_bytes());
    }
}

/// An integer as [`int`] makes it, written.
fn int_bytes(out: &mut Vec<u8>, n: i64) {
    match u64::try_from(n) {
        Ok(u) => head(out, 0, u),
        Err(_) => head(out, 1, n.unsigned_abs() - 1),
    }
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

/// A body standing this near what it would turn to face, µm, keeps its facing: it is on it ([`facing_toward`]).
pub const FACE_NEAR: i64 = 100_000;

/// The facing (its +x turned on the level) of a body standing at `at` that faces `to`, both in its frame, µm; none
/// within [`FACE_NEAR`] of it. The one rule for a body turning to what it came to (0.135): a walk's end at a thing or
/// another Soul (worldd's `Bodies::face`) and a form's walk to its stand point (`crate::forms`).
pub fn facing_toward(at: Vec3, to: Vec3) -> Option<Quat> {
    let d = [to.x - at.x, to.z - at.z];
    if i128::from(d[0]).pow(2) + i128::from(d[1]).pow(2) <= i128::from(FACE_NEAR).pow(2) {
        return None;
    }
    crate::activity::carry::yaw_toward(d).ok()
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
    /// Whether the carry waits at its end, for at most [`LANDING_WAIT`] ticks, while another body stands where it
    /// lands (#4215): a link not taken in turns, whose far end nobody keeps clear.
    pub hold: bool,
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
        let height = match body.pose.support {
            Support::Surface { height, .. } => height,
            Support::Slot | Support::Volume { .. } | Support::Track | Support::None => 0,
        };
        *body = on.place_built(
            body.id,
            frame,
            self.arrive.unwrap_or(p),
            body.pose.orientation,
            Build {
                hover_mm: height / 1000,
                ..Build::STANDARD
            },
        )?;
        body.linear = linear;
        Ok(true)
    }
}

struct Slot {
    build: Build,
    claims: Claims,
    moved: Moved,
    input: Input,
    logged: Option<Input>,
    /// Whether the input may differ from the one logged: set by every change, so an unchanged body costs no compare.
    touched: bool,
    track: Option<Track>,
    /// Ticks its carry has stood at the last point of its track, held while another body stands where it lands (#4215).
    landing: u32,
    voice: Voice,
}

/// Immutable admission basis. Resource claims, input and crossing state are checked again before a change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuildBasis {
    pub moved: Moved,
    pub build: Build,
    claims: Claims,
    input: Input,
    track: Option<Track>,
}

/// A captured admission basis and one opaque off-clock target-triangle certificate.
#[derive(Clone, Debug)]
pub struct PreparedRebind {
    pub before: BuildBasis,
    pub triangle: crate::mover::RebindTriangle,
}

/// A certificate's outcome (B12b): the rebinds to commit, or every guard held and a body only walked on.
#[derive(Debug)]
pub enum Certified {
    Ready(Vec<(BuildBasis, Moved)>),
    WalkedOn,
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
    /// The input log is not kept ([`Controller::forget_log`]).
    unlogged: bool,
    /// Where each body not being carried across a link stands, kept as the bodies move: "who is near" (N16). A body
    /// the world carries by its own rule (N10's walk-out) stays on its node, and in the index.
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
    /// The voice's utterance ends when its time is up, and the next waiting one starts (B11), listed in `said`.
    fn speak(&mut self, id: Id, at: Micros, said: &mut Vec<(Id, Line, Micros)>) {
        if self.voice.now.as_ref().is_some_and(|(_, ends)| *ends <= at) {
            self.voice.now = None;
        }
        if self.voice.now.is_none()
            && let Some(line) = self.voice.waiting.pop_front()
        {
            let ends = at.saturating_add(line.length);
            said.push((id, line.clone(), ends));
            self.voice.now = Some((line, ends));
        }
    }

    /// Logs the input if it changed since it was last logged. A record of fixed shape and depth: written straight
    /// (`Input::bytes`), it cannot be refused.
    fn log(&mut self, id: Id, at: Micros, log: &mut Vec<Logged>) {
        if self.touched && self.logged.as_ref() != Some(&self.input) {
            log.push(Logged {
                at,
                body: id,
                bytes: self.input.bytes(at, id),
            });
            self.logged = Some(self.input.clone());
        }
        self.touched = false;
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

    /// Keeps no input log from now on (#2803): [`Controller::log`] stays empty. A served world keeps its inputs in its
    /// own log (K12) and never reads this one, which would otherwise grow with every changed input for the world's
    /// life; the tests and tools that read it keep it.
    pub fn forget_log(&mut self) {
        self.unlogged = true;
        self.log = Vec::new();
    }

    /// No bodies yet, kept in `near` (N16: `Index::fixed()` turns splitting off).
    pub fn with_index(near: Index) -> Controller {
        Controller {
            near,
            ..Controller::default()
        }
    }

    /// Adds a body of `family`, standing as the mover placed it, with the neutral input facing as it faces.
    pub fn add(&mut self, family: Family, moved: Moved) -> R<()> {
        self.add_built(family, moved, Build::STANDARD)
    }

    /// Adds an already admitted body, using the surfaces prepared for this exact class.
    pub fn add_built(&mut self, family: Family, moved: Moved, build: Build) -> R<()> {
        if self.get(moved.id).is_some() {
            return refuse("body-duplicate", replica::world_model::show(moved.id));
        }
        let input = Input::neutral(moved.pose.orientation);
        self.near.put_moved(&moved);
        self.bodies.insert(
            moved.id,
            Slot {
                build,
                claims: Claims::new(family),
                moved,
                input,
                logged: None,
                touched: true,
                track: None,
                landing: 0,
                voice: Voice::default(),
            },
        );
        Ok(())
    }

    /// Takes `body` out, its claims, input and place among the near with it (a retirement, K10 #2673).
    pub fn remove(&mut self, body: Id) -> bool {
        self.woken.remove(&body);
        self.near.remove_body(body);
        let was = self
            .bodies
            .remove(&body)
            .or_else(|| self.rested.remove(&body));
        was.is_some()
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

    /// The admitted build, retained separately from the mover's position.
    pub fn build(&self, body: Id) -> Option<Build> {
        self.get(body).map(|s| s.build)
    }

    /// A bounded snapshot for an off-clock supported-size check.
    pub fn build_basis(&self, body: Id) -> Option<BuildBasis> {
        let s = self.get(body)?;
        Some(BuildBasis {
            moved: s.moved,
            build: s.build,
            claims: s.claims.clone(),
            input: s.input.clone(),
            track: s.track.clone(),
        })
    }

    /// Lookup-only validation; a refused or stale change has not touched any actor state.
    pub fn check_build(&self, basis: &BuildBasis) -> R<()> {
        if self.build_basis(basis.moved.id).as_ref() != Some(basis) {
            return refuse(
                "body-change-stale",
                "the body, claims, input or class changed",
            );
        }
        if basis.track.is_some() || basis.moved.pose.support == Support::Slot {
            return refuse("body-change-in-use", "the occupied support is in use");
        }
        Ok(())
    }

    /// Pairs the existing recorded write with a checked surface rebind, never a movement path.
    pub fn commit_build<T>(
        &mut self,
        basis: &BuildBasis,
        moved: Moved,
        build: Build,
        commit: impl FnOnce() -> R<T>,
    ) -> R<T> {
        self.check_build(basis)?;
        if moved.id != basis.moved.id
            || moved.pose.frame != basis.moved.pose.frame
            || moved.pose.position.x != basis.moved.pose.position.x
            || moved.pose.position.z != basis.moved.pose.position.z
            || moved
                .pose
                .position
                .y
                .checked_sub(basis.moved.pose.position.y)
                != build
                    .hover_mm
                    .checked_sub(basis.build.hover_mm)
                    .and_then(|h| h.checked_mul(1000))
            || moved.pose.orientation != basis.moved.pose.orientation
            || moved.linear != basis.moved.linear
        {
            return refuse("body-change-moved", "a body change cannot move the actor");
        }
        let value = commit()?;
        let s = self
            .bodies
            .get_mut(&moved.id)
            .expect("validated surface-owned body");
        s.moved = moved;
        s.build = build;
        s.touched = true;
        Ok(value)
    }

    /// Validates every precomputed topology rebind without searching or mutating the live actor.
    /// Validates unchanged admission state, then certifies the current point without moving it.
    pub fn certify_rebinds(&self, prepared: &[PreparedRebind]) -> R<Vec<(BuildBasis, Moved)>> {
        match self.certify_or_walked(prepared)? {
            Certified::Ready(out) => Ok(out),
            Certified::WalkedOn => refuse("edit.body-stale", "prepared triangle differs"),
        }
    }

    /// As `certify_rebinds`, but tells apart (B12b) the one case where every guard holds and a body's current point
    /// has only walked out of its prepared triangle: the caller may place the same bodies again off the clock.
    pub fn certify_or_walked(&self, prepared: &[PreparedRebind]) -> R<Certified> {
        let mut out = Vec::with_capacity(prepared.len());
        let mut walked = false;
        let mut seen = BTreeSet::new();
        for target in prepared {
            let before = &target.before;
            let Some(current) = self.build_basis(before.moved.id) else {
                return refuse("edit.body-stale", "prepared body missing");
            };
            if current.build != before.build
                || current.claims != before.claims
                || current.track != before.track
                || current.track.is_some()
                || current.moved.pose.frame != before.moved.pose.frame
                || current.moved.pose.support != before.moved.pose.support
                || !self.bodies.contains_key(&before.moved.id)
                || !seen.insert(before.moved.id)
            {
                return refuse("edit.body-stale", "prepared body changed");
            }
            match target.triangle.rebind(&current.moved) {
                Some(after) => out.push((current, after)),
                None if !target.triangle.contains(&current.moved) => walked = true,
                None => {
                    return Err(Refusal {
                        name: "edit.body-stale",
                        detail: "prepared triangle differs".into(),
                    });
                }
            }
        }
        if walked {
            return Ok(Certified::WalkedOn);
        }
        self.check_rebinds(&out)?;
        Ok(Certified::Ready(out))
    }

    pub fn check_rebinds(&self, prepared: &[(BuildBasis, Moved)]) -> R<()> {
        let mut seen = BTreeSet::new();
        for (before, after) in prepared {
            if !seen.insert(before.moved.id)
                || !self.bodies.contains_key(&before.moved.id)
                || self.build_basis(before.moved.id).as_ref() != Some(before)
                || after.id != before.moved.id
                || after.pose != before.moved.pose
                || after.linear != before.moved.linear
            {
                return refuse("edit.body-stale", "prepared body changed");
            }
        }
        Ok(())
    }
    pub fn commit_rebinds<T>(
        &mut self,
        prepared: &[(BuildBasis, Moved)],
        commit: impl FnOnce() -> R<T>,
    ) -> R<T> {
        self.check_rebinds(prepared)?;
        let value = commit()?;
        for (before, after) in prepared {
            let slot = self
                .bodies
                .get_mut(&before.moved.id)
                .expect("validated surface-owned actor");
            slot.moved.piece = after.piece;
            slot.moved.tri = after.tri;
        }
        Ok(value)
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
    pub fn slot_in(&mut self, body: Id, driver: Driver, frame: Frame, at: Micros) -> R<HandOff> {
        self.slot_in_at(body, driver, frame, Vec3::ZERO, at)
    }

    /// [`Controller::slot_in`] at `position` in the slot's frame, µm: the body's own place in a slot that holds several
    /// bodies (E16: a tent's two sleepers).
    pub fn slot_in_at(
        &mut self,
        body: Id,
        driver: Driver,
        frame: Frame,
        position: Vec3,
        at: Micros,
    ) -> R<HandOff> {
        let pose = Pose {
            frame,
            position,
            orientation: Quat::IDENTITY,
            support: Support::Slot,
        };
        let h = hand(&mut self.bodies, &mut self.rested, body, driver, at, pose)?;
        self.woken.insert(body);
        Ok(h)
    }

    /// The reverse of [`Controller::slot_in`]: hands `body` from its slot to `placed`, a surface's placement of it (its
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
        let across = track.link.is_some();
        s.track = Some(track);
        if across {
            self.near.remove_body(body);
        }
        Ok(())
    }

    /// The world's own rule when `body`'s node's ground was rebuilt (G3, #2760): it stands as `placed`, found again on
    /// the new ground where it stood (`moved` when that is anywhere else: never a move), or, standing on none
    /// (`None`), stands still until it is walked out.
    pub fn regrounded(&mut self, body: Id, placed: Option<Moved>) -> R<()> {
        let s = self.slot(body)?;
        match placed {
            Some(m) if m.pose.position != s.moved.pose.position => {
                return refuse("moved", replica::world_model::show(body));
            }
            Some(m) => s.moved = m,
            None => (s.input.velocity, s.moved.linear) = (Vec3::ZERO, Vec3::ZERO),
        }
        s.touched = true;
        Ok(())
    }

    /// `body` as the mover last left it, and the link it is being carried across, if any: [`Controller::body`] and
    /// [`Controller::carrying`] in one lookup.
    pub fn seen(&self, body: Id) -> Option<(&Moved, Option<Id>)> {
        let s = self.bodies.get(&body)?;
        Some((&s.moved, s.track.as_ref().and_then(|t| t.link)))
    }

    /// Whether a body other than `body` and those in `leaving`, not carried, stands within `room` (x and z) of where
    /// `track` lands it (#4215): a crossing waits rather than land one body on another.
    pub fn landing_taken(
        &self,
        body: Id,
        track: &Track,
        room: i64,
        leaving: &BTreeSet<Id>,
    ) -> bool {
        let Some(at) = track.arrive.or_else(|| track.line.last().copied()) else {
            return false;
        };
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        self.bodies.iter().any(|(id, s)| {
            let p = s.moved.pose.position;
            *id != body
                && !leaving.contains(id)
                && s.track.is_none()
                && crate::walk::node_of(&s.moved) == track.to
                && d(p.x, at.x) + d(p.z, at.z) < i128::from(room) * i128::from(room)
        })
    }

    /// The link `body` is being carried across, if any.
    pub fn carrying(&self, body: Id) -> Option<Id> {
        self.bodies.get(&body)?.track.as_ref().and_then(|t| t.link)
    }

    /// Whether `body` is being carried, across a link or by the world's own rule.
    pub fn carried(&self, body: Id) -> bool {
        self.bodies.get(&body).is_some_and(|s| s.track.is_some())
    }

    /// The spatial index of the bodies not being carried across a link, as the mover last left them (N16).
    pub fn near(&self) -> &Index {
        &self.near
    }

    /// The bodies as the mover last left them, in id order.
    pub fn bodies(&self) -> impl Iterator<Item = &Moved> {
        self.bodies.values().map(|s| &s.moved)
    }

    /// Every body the controller holds, each once: those it steps and those resting in a slot (seated, lying, rising).
    pub fn ids(&self) -> impl Iterator<Item = Id> + '_ {
        self.bodies.keys().chain(self.rested.keys()).copied()
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
            Part::Gaze(g) => {
                s.holds(driver, Class::Gaze)?;
                s.input.gaze = g;
            }
        }
        Ok(())
    }

    /// Sets each control's velocity and mode, as [`Controller::set`] with [`Part::Velocity`] does one at a time, and
    /// returns the refusals with their bodies, in order. Controls in body id order (as a tick stages them) are matched
    /// along the bodies in one walk, not looked up each (#3213); any other order is set one at a time.
    pub fn set_velocities(
        &mut self,
        controls: &[(Id, Driver, ControllerInput)],
    ) -> Vec<(Id, Refusal)> {
        self.set_velocities_on(controls, 1)
    }

    /// [`Controller::set_velocities`] on `threads` threads (N17b, #3255): controls in body id order are cut into runs
    /// that never split one body's, each run matched along its own bodies, and the refusals joined in order.
    pub fn set_velocities_on(
        &mut self,
        controls: &[(Id, Driver, ControllerInput)],
        threads: usize,
    ) -> Vec<(Id, Refusal)> {
        let mut refused = Vec::new();
        if !controls.is_sorted_by_key(|c| c.0) {
            for &(body, driver, input) in controls {
                if let Err(r) = self.set(body, driver, Part::Velocity(input.velocity, input.mode)) {
                    refused.push((body, r));
                }
            }
            return refused;
        }
        let mut slots: Vec<(Id, &mut Slot)> =
            self.bodies.iter_mut().map(|(&id, s)| (id, s)).collect();
        // Runs of controls, each starting at a new body, and the bodies from its first on.
        let mut cuts = vec![0];
        let mut i = BODIES;
        while i < controls.len() {
            while i < controls.len() && controls[i].0 == controls[i - 1].0 {
                i += 1;
            }
            if i < controls.len() {
                cuts.push(i);
            }
            i += BODIES;
        }
        let mut runs = Vec::with_capacity(cuts.len());
        let mut rest: &mut [(Id, &mut Slot)] = &mut slots;
        for (k, &c) in cuts.iter().enumerate() {
            let end = cuts.get(k + 1).copied().unwrap_or(controls.len());
            // This run's bodies: those before the next run's first.
            let n = cuts.get(k + 1).map_or(rest.len(), |&n| {
                rest.partition_point(|(id, _)| *id < controls[n].0)
            });
            let (mine, more) = std::mem::take(&mut rest).split_at_mut(n);
            rest = more;
            runs.push((&controls[c..end], mine));
        }
        for r in crate::par::map_mut(&mut runs, threads, 1, |(controls, slots)| {
            let mut refused = Vec::new();
            let mut slots = slots.iter_mut().peekable();
            for &(body, driver, input) in controls.iter() {
                while slots.next_if(|(id, _)| *id < body).is_some() {}
                let set = match slots.peek_mut() {
                    Some((id, s)) if *id == body => s.steers(driver).map(|()| {
                        s.input.velocity = input.velocity;
                        s.input.mode = input.mode;
                        s.touched = true;
                    }),
                    _ => refuse("body-unknown", replica::world_model::show(body)),
                };
                if let Err(r) = set {
                    refused.push((body, r));
                }
            }
            refused
        }) {
            refused.extend(r);
        }
        refused
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
        self.get(body)?.voice.now.as_ref()
    }

    /// One tick: each body on a surface, in id order, has its input logged if it changed, takes its facing, and is
    /// stepped by the mover of the surface it stands on. A body in a slot is visited only when its input changed, to
    /// log it. A body refused here is listed and stays where it was; the others go on.
    pub fn step(&mut self, surfaces: &BTreeMap<Id, Surface>, dt: Micros, at: Micros) -> Stepped {
        self.step_on(surfaces, dt, at, 1)
    }

    /// [`Controller::step`] with the bodies on surfaces stepped on `threads` threads (N17b, #3255): each body's step
    /// reads only itself and the surfaces, and what each gives (its log record, its sample, its refusal, its new place
    /// in "who is near") is joined in body order, so the tick is the same at any thread count.
    pub fn step_on(
        &mut self,
        surfaces: &BTreeMap<Id, Surface>,
        dt: Micros,
        at: Micros,
        threads: usize,
    ) -> Stepped {
        self.step_on_selected(|_, _| Some(surfaces), dt, at, threads)
    }

    /// The same controller step, selecting each body's exact admitted-class surface bank.
    pub fn step_on_selected<'a>(
        &mut self,
        surfaces: impl Fn(Id, Size) -> Option<&'a BTreeMap<Id, Surface>> + Sync,
        dt: Micros,
        at: Micros,
        threads: usize,
    ) -> Stepped {
        let mut out = Stepped::default();
        for id in std::mem::take(&mut self.woken) {
            if let Some(s) = self.rested.get_mut(&id) {
                s.speak(id, at, &mut out.said);
                if s.voice.now.is_some() || !s.voice.waiting.is_empty() {
                    // A seated body's voice still carries or waits: visited again next tick (B11 in a slot).
                    self.woken.insert(id);
                }
                s.log(id, at, &mut self.log);
            }
        }
        if self.unlogged {
            self.log.clear();
        }
        // A carry about to land waits at its track's end while another body stands where it would land, for at most
        // LANDING_WAIT ticks (#4215): never one body set down on another while it can be helped, never held for good.
        let mut hold: BTreeSet<Id> = BTreeSet::new();
        for (id, s) in &self.bodies {
            let Some(t) = s.track.as_ref().filter(|t| t.hold) else {
                continue;
            };
            if s.landing >= LANDING_WAIT {
                continue;
            }
            let reach = i128::from(t.speed) * i128::from(dt) / 1_000_000;
            let mut left = 0i128;
            let mut from = s.moved.pose.position;
            for &q in &t.line {
                left += dist2(from, q).isqrt();
                from = q;
            }
            let Some(at) = t.arrive.or_else(|| t.line.last().copied()) else {
                continue;
            };
            if left <= reach
                && self
                    .near
                    .bodies_within(t.to, [at.x, at.z], LANDING_ROOM)
                    .iter()
                    .any(|(o, _)| o != id)
            {
                hold.insert(*id);
            }
        }
        for (id, s) in self.bodies.iter_mut() {
            if hold.contains(id) {
                s.landing += 1;
            } else if s.track.is_none() {
                s.landing = 0;
            }
        }
        let mut slots: Vec<(Id, &mut Slot)> =
            self.bodies.iter_mut().map(|(&id, s)| (id, s)).collect();
        let hold = &hold;
        let step_run = |run: &mut [(Id, &mut Slot)]| {
            let mut o = Gave::default();
            for (id, s) in run.iter_mut() {
                match surfaces(*id, s.build.size) {
                    Some(_) if hold.contains(id) => {
                        // Held at its track's end: it stands there, still carried, out of "who is near".
                        s.speak(*id, at, &mut o.said);
                        s.log(*id, at, &mut o.log);
                        s.moved.linear = Vec3::ZERO;
                        o.put.push(false);
                    }
                    Some(on) => {
                        let put = s.step_one(*id, on, dt, at, &mut o);
                        o.put.push(put);
                    }
                    None => {
                        o.refused.push((
                            *id,
                            Refusal {
                                name: "body-class-unprepared",
                                detail: "the admitted class has no prepared surfaces".into(),
                            },
                        ));
                        o.put.push(false);
                    }
                }
            }
            o
        };
        let mut runs: Vec<&mut [(Id, &mut Slot)]> = slots.chunks_mut(BODIES).collect();
        let gave = crate::par::map_mut(&mut runs, threads, 1, |run| step_run(run));
        drop(runs);
        drop(slots);
        let mut put = Vec::with_capacity(self.bodies.len());
        out.samples
            .reserve(gave.iter().map(|g| g.samples.len()).sum::<usize>());
        self.log
            .reserve(gave.iter().map(|g| g.log.len()).sum::<usize>());
        for g in gave {
            out.said.extend(g.said);
            if !self.unlogged {
                self.log.extend(g.log);
            }
            out.samples.extend(g.samples);
            out.refused.extend(g.refused);
            put.extend(g.put);
        }
        self.near.put_moved_sorted(
            self.bodies
                .values()
                .zip(put)
                .filter(|(_, put)| *put)
                .map(|(s, _)| &s.moved),
        );
        out
    }
}

/// A carry waits at its track's end while another body stands within this of where it lands, µm: two personal radii
/// and slack, as the walk skill keeps them apart (`skills::route`, `ROOM` and `SLACK`, #4215).
pub const LANDING_ROOM: i64 = 315_000;
/// The most ticks a carry waits at its track's end for a body standing where it lands (2 s at 20 ticks a second).
pub const LANDING_WAIT: u32 = 40;

/// The most bodies one thread steps at a time in [`Controller::step_on`].
const BODIES: usize = 256;

/// What stepping a run of bodies gave, in body order, and whether each takes its new place in "who is near".
#[derive(Default)]
struct Gave {
    said: Vec<(Id, Line, Micros)>,
    log: Vec<Logged>,
    samples: Vec<HandOff>,
    refused: Vec<(Id, Refusal)>,
    put: Vec<bool>,
}

impl Slot {
    /// One body's step on its surface, as [`Controller::step`] gives it; whether it takes its new place in "who is
    /// near".
    fn step_one(
        &mut self,
        id: Id,
        surfaces: &BTreeMap<Id, Surface>,
        dt: Micros,
        at: Micros,
        o: &mut Gave,
    ) -> bool {
        self.speak(id, at, &mut o.said);
        self.log(id, at, &mut o.log);
        self.moved.pose.orientation = self.input.facing;
        if let Some(t) = self.track.as_mut() {
            match t.advance(&mut self.moved, surfaces, dt) {
                Ok(true) => {
                    self.track = None;
                    self.input.velocity = Vec3::ZERO;
                    // A changed input: logged at the next step (B2's `touched`).
                    self.touched = true;
                }
                Ok(false) => {}
                Err(r) => {
                    self.track = None;
                    o.refused.push((id, r));
                }
            }
            return self.track.as_ref().is_none_or(|t| t.link.is_none());
        }
        // Standing still with no velocity asked: the mover would leave it as it is.
        if self.input.velocity == Vec3::ZERO && self.moved.linear == Vec3::ZERO {
            return false;
        }
        let Support::Surface { surface, .. } = self.moved.pose.support else {
            o.refused.push((
                id,
                Refusal {
                    name: "support-not-surface",
                    detail: replica::world_model::show(id),
                },
            ));
            return false;
        };
        let Some(on) = surfaces.get(&surface) else {
            o.refused.push((
                id,
                Refusal {
                    name: "no-surface",
                    detail: replica::world_model::show(surface),
                },
            ));
            return false;
        };
        let input = ControllerInput {
            velocity: self.input.velocity,
            mode: self.input.mode,
        };
        match on.step(&mut self.moved, input, dt, at) {
            Ok(Some(h)) => o.samples.push(h),
            Ok(None) => {}
            Err(r) => o.refused.push((id, r)),
        }
        true
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use replica::encode::encode;
    use replica::ids::Scope;

    /// #3213: the input log's bytes written straight are T0's encoding of its record, for every shape of input.
    #[test]
    fn bytes_are_the_records_encoding() {
        let body = Id::new(Scope([0x9b; 16]), 70_000).expect("an id");
        let name = |n: &str| Name::new(n).expect("a name");
        let mut inputs = vec![Input::neutral(Quat::IDENTITY)];
        for (v, stance) in [
            (Vec3::new(1_400_000, 0, -23), Stance::Sit),
            (Vec3::new(-1, 24, -70_000_000_000), Stance::Lie),
            (Vec3::new(255, -256, 65_536), Stance::Stand),
        ] {
            let mut i = Input::neutral(Quat::IDENTITY);
            (i.velocity, i.stance) = (v, stance);
            inputs.push(i);
        }
        let mut held = Input::neutral(Quat::IDENTITY);
        held.moves
            .insert(name("souls:hand-left"), name("souls:wave"));
        held.moves
            .insert(name("souls:hand-right"), name("souls:hold"));
        inputs.push(held);
        for gaze in [
            Gaze::Point(Vec3::new(3_000_000, 1_600_000, 0)),
            Gaze::Node(body),
        ] {
            let mut i = Input::neutral(Quat::IDENTITY);
            i.gaze = gaze;
            inputs.push(i);
        }
        for at in [0, 23, 50_000, -7, 1 << 40] {
            for i in &inputs {
                let want = encode(&i.record(at, body)).expect("encodes");
                assert_eq!(i.bytes(at, body), want, "{i:?} at {at}");
            }
        }
    }
}

#[cfg(test)]
mod class_tests {
    use super::*;
    use crate::ground::Piece;
    use replica::bodies::{Class, Resource, Want};
    use replica::ids::Scope;
    fn fixture() -> (Id, Family, Surface) {
        let id = Id::new(Scope([0x65; 16]), 1).unwrap();
        let family = Family {
            name: Name::new("souls:humanoid").unwrap(),
            resources: vec![Resource {
                name: Name::new("souls:legs").unwrap(),
                class: Class::Locomotion,
                slot: None,
            }],
        };
        let pc = Piece {
            outline: vec![vec![
                [-10000, 0, -10000],
                [10000, 0, -10000],
                [10000, 0, 10000],
                [-10000, 0, 10000],
            ]],
            vertices: vec![
                [-10000, 0, -10000],
                [10000, 0, -10000],
                [10000, 0, 10000],
                [-10000, 0, 10000],
            ],
            triangles: vec![[0, 1, 2], [0, 2, 3]],
            ground: crate::gaits::Ground::Dry,
        };
        (id, family, Surface::new(id, vec![pc]))
    }
    #[test]
    fn admitted_hover_survives_the_first_and_following_controller_ticks() {
        let (id, family, surface) = fixture();
        let build = Build {
            size: Size::Large,
            hover_mm: 900,
            ..Build::STANDARD
        };
        let body = surface
            .place_built(
                id,
                Frame {
                    node: id,
                    slot: None,
                },
                Vec3::ZERO,
                Quat::IDENTITY,
                build,
            )
            .unwrap();
        let mut c = Controller::new();
        c.add_built(family, body, build).unwrap();
        let shape = SkillShape {
            name: Name::new("souls:walk").unwrap(),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: Vec::new(),
            cancelled_by: Vec::new(),
        };
        let driver = c.claim(id, &shape).unwrap();
        c.set(
            id,
            driver,
            Part::Velocity(Vec3::new(1_000, 0, 0), Mode::Surface),
        )
        .unwrap();
        let floors = BTreeMap::from([(id, surface)]);
        let mut previous_x = 0;
        for at in [50_000, 100_000] {
            let out = c.step_on_selected(
                |_, size| (size == Size::Large).then_some(&floors),
                50_000,
                at,
                1,
            );
            assert!(out.refused.is_empty());
            assert!(!out.samples.is_empty());
            assert!(c.body(id).unwrap().pose.position.x > previous_x);
            previous_x = c.body(id).unwrap().pose.position.x;
            assert_eq!(c.body(id).unwrap().pose.position.y, 900_000);
            assert_eq!(c.body(id).unwrap().pose.support, build.support(id));
        }
    }
    #[test]
    fn current_point_certificate_keeps_motion_and_refuses_changed_admission_atomically() {
        let (id, family, surface) = fixture();
        let pc = surface.pieces()[0].clone();
        let mut far = pc.clone();
        for v in &mut far.vertices {
            v[0] -= 100_000;
        }
        for ring in &mut far.outline {
            for v in ring {
                v[0] -= 100_000;
            }
        }
        let old = Surface::new(id, vec![far, pc]);
        let moved = old
            .place(
                id,
                Frame {
                    node: id,
                    slot: None,
                },
                Vec3::new(1_000_000, 0, -1_000_000),
                Quat::IDENTITY,
            )
            .unwrap();
        assert_eq!(moved.piece, 1);
        let mut c = Controller::new();
        c.add(family, moved).unwrap();
        let shape = SkillShape {
            name: Name::new("souls:walk").unwrap(),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: vec![],
            cancelled_by: vec![],
        };
        let driver = c.claim(id, &shape).unwrap();
        c.set(
            id,
            driver,
            Part::Velocity(Vec3::new(1_000, 0, 0), Mode::Surface),
        )
        .unwrap();
        let target = PreparedRebind {
            before: c.build_basis(id).unwrap(),
            triangle: surface.rebind_triangle(0, moved.tri, 0).unwrap(),
        };
        c.set(
            id,
            driver,
            Part::Velocity(Vec3::new(2_000, 0, 0), Mode::Surface),
        )
        .unwrap();
        c.set(
            id,
            driver,
            Part::Facing(Quat::from_yaw_mdeg(30_000).unwrap()),
        )
        .unwrap();
        assert_eq!(
            c.check_build(&target.before).unwrap_err().name,
            "body-change-stale"
        );
        let out = c.step(&BTreeMap::from([(id, old)]), 50_000, 50_000);
        assert!(out.refused.is_empty());
        let current = c.build_basis(id).unwrap();
        assert_ne!(
            current.moved.pose.position,
            target.before.moved.pose.position
        );
        assert_ne!(current.input.velocity, target.before.input.velocity);
        assert_ne!(current.input.facing, target.before.input.facing);
        let certified = c.certify_rebinds(std::slice::from_ref(&target)).unwrap();
        assert_eq!(certified[0].0, current);
        assert_eq!(certified[0].1.pose, current.moved.pose);
        assert_eq!(certified[0].1.linear, current.moved.linear);
        c.set(
            id,
            driver,
            Part::Velocity(Vec3::new(3_000, 0, 0), Mode::Surface),
        )
        .unwrap();
        let drifted = c.build_basis(id).unwrap();
        assert_eq!(
            c.check_rebinds(&certified).unwrap_err().name,
            "edit.body-stale"
        );
        assert_eq!(c.build_basis(id).unwrap(), drifted);
        c.set(
            id,
            driver,
            Part::Velocity(current.input.velocity, current.input.mode),
        )
        .unwrap();
        assert_eq!(c.build_basis(id).unwrap(), current);
        assert_eq!(
            c.commit_rebinds(&certified, || Err::<(), _>(Refusal {
                name: "paired-refusal",
                detail: String::new()
            }))
            .unwrap_err()
            .name,
            "paired-refusal"
        );
        assert_eq!(c.build_basis(id).unwrap(), current);
        c.commit_rebinds(&certified, || Ok(())).unwrap();
        let mut rebound = current.clone();
        rebound.moved.piece = 0;
        assert_eq!(c.build_basis(id).unwrap(), rebound);
        assert_eq!(c.input(id), Some(&current.input));
        assert_eq!(current.moved.piece, 1);
        assert_eq!(certified[0].1.piece, 0);
        for change in 0..7 {
            let slot = c.bodies.get_mut(&id).unwrap();
            match change {
                0 => slot.moved.pose.position.x = 100_000_000,
                1 => slot.moved.pose.position.y += 1,
                2 => slot.build.size = replica::kinds::sizes::Size::Large,
                3 => slot.moved.pose.frame.slot = Some(1),
                4 => slot.moved.pose.support = Support::Slot,
                5 => {
                    slot.track = Some(Track {
                        link: None,
                        line: vec![],
                        speed: 1,
                        to: id,
                        arrive: None,
                        hold: false,
                    })
                }
                _ => slot.moved.pose.frame.node = Id::new(Scope([0x66; 16]), 2).unwrap(),
            }
            let changed = c.build_basis(id).unwrap();
            assert_eq!(
                c.certify_rebinds(std::slice::from_ref(&target))
                    .unwrap_err()
                    .name,
                "edit.body-stale",
                "case {change}"
            );
            assert_eq!(c.build_basis(id).unwrap(), changed);
            let slot = c.bodies.get_mut(&id).unwrap();
            slot.moved = current.moved;
            slot.build = current.build;
            slot.input = current.input.clone();
            slot.track = current.track.clone();
        }
        c.claim(
            id,
            &SkillShape {
                name: Name::new("souls:observe").unwrap(),
                claims: vec![],
                blocks: vec![],
                cancelled_by: vec![],
            },
        )
        .unwrap();
        let changed = c.build_basis(id).unwrap();
        assert_ne!(changed.claims, current.claims);
        assert_eq!(
            c.certify_rebinds(&[target]).unwrap_err().name,
            "edit.body-stale"
        );
        assert_eq!(c.build_basis(id).unwrap(), changed);
    }

    #[test]
    fn a_body_that_walked_out_of_its_prepared_triangle_is_placed_again_on_the_kept_surfaces() {
        let (id, family, surface) = fixture();
        let frame = Frame {
            node: id,
            slot: None,
        };
        let moved = surface
            .place(id, frame, Vec3::new(-50_000, 0, 0), Quat::IDENTITY)
            .unwrap();
        let mut c = Controller::new();
        c.add(family, moved).unwrap();
        let shape = SkillShape {
            name: Name::new("souls:walk").unwrap(),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: Vec::new(),
            cancelled_by: Vec::new(),
        };
        let driver = c.claim(id, &shape).unwrap();
        c.set(
            id,
            driver,
            Part::Velocity(Vec3::new(1_000_000, 0, 0), Mode::Surface),
        )
        .unwrap();
        let before = c.build_basis(id).unwrap();
        let kept = crate::walk::town::RebindSurfaces(BTreeMap::from([(
            (before.build.size, id),
            (surface.clone(), 0),
        )]));
        let prepared = kept.place(std::slice::from_ref(&before)).unwrap();
        assert!(matches!(
            c.certify_or_walked(&prepared).unwrap(),
            Certified::Ready(_)
        ));
        let surfaces = BTreeMap::from([(id, surface)]);
        let mut at = 0;
        while prepared[0].triangle.contains(c.body(id).unwrap()) {
            at += 50_000;
            assert!(at < 100_000_000, "the body never left its triangle");
            assert!(c.step(&surfaces, 50_000, at).refused.is_empty());
        }
        let current = c.build_basis(id).unwrap();
        assert_ne!(current.moved.tri, before.moved.tri);
        // The old certificate refuses, by its existing name; the distinct outcome only says the body walked on.
        assert!(matches!(
            c.certify_or_walked(&prepared).unwrap(),
            Certified::WalkedOn
        ));
        assert_eq!(
            c.certify_rebinds(&prepared).unwrap_err().name,
            "edit.body-stale"
        );
        assert_eq!(c.build_basis(id).unwrap(), current);
        // Placed again, as it stands now, on the same kept surfaces: no rebuild, map or search.
        let again = kept.place(std::slice::from_ref(&current)).unwrap();
        let Certified::Ready(certified) = c.certify_or_walked(&again).unwrap() else {
            panic!("the reprepared certificate holds");
        };
        c.commit_rebinds(&certified, || Ok(())).unwrap();
        let mut expected = current.clone();
        expected.moved.piece = certified[0].1.piece;
        expected.moved.tri = certified[0].1.tri;
        assert_eq!(c.build_basis(id).unwrap(), expected);
        assert_eq!(c.input(id), Some(&current.input));
        assert_eq!(c.body(id).unwrap().pose, current.moved.pose);
        assert_eq!(c.body(id).unwrap().linear, current.moved.linear);
        let x = c.body(id).unwrap().pose.position.x;
        assert!(c.step(&surfaces, 50_000, at + 50_000).refused.is_empty());
        assert!(c.body(id).unwrap().pose.position.x > x);
        // A changed admission still refuses by its existing name, never as walked on.
        c.bodies.get_mut(&id).unwrap().moved.pose.position.y += 1;
        assert_eq!(
            c.certify_or_walked(&again).unwrap_err().name,
            "edit.body-stale"
        );
    }

    #[test]
    fn prepared_topology_rebind_preserves_active_state_and_moves_on_the_next_tick() {
        let (id, family, surface) = fixture();
        let pc = surface.pieces()[0].clone();
        let mut far = pc.clone();
        for v in &mut far.vertices {
            v[0] -= 100_000;
        }
        for ring in &mut far.outline {
            for v in ring {
                v[0] -= 100_000;
            }
        }
        let old = Surface::new(id, vec![far, pc]);
        let frame = Frame {
            node: id,
            slot: None,
        };
        let moved = old.place(id, frame, Vec3::ZERO, Quat::IDENTITY).unwrap();
        assert_eq!(moved.piece, 1);
        let mut c = Controller::new();
        c.add(family, moved).unwrap();
        let shape = SkillShape {
            name: Name::new("souls:walk").unwrap(),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: Vec::new(),
            cancelled_by: Vec::new(),
        };
        let driver = c.claim(id, &shape).unwrap();
        c.set(
            id,
            driver,
            Part::Velocity(Vec3::new(1_000, 0, 0), Mode::Surface),
        )
        .unwrap();
        let before = c.build_basis(id).unwrap();
        let mut after = surface
            .place(id, frame, Vec3::ZERO, Quat::IDENTITY)
            .unwrap();
        after.linear = moved.linear;
        assert_eq!(after.piece, 0);
        let prepared = vec![(before.clone(), after)];
        assert_eq!(
            c.commit_rebinds(&prepared, || Err::<(), _>(Refusal {
                name: "paired-refusal",
                detail: String::new()
            }))
            .unwrap_err()
            .name,
            "paired-refusal"
        );
        assert_eq!(c.build_basis(id).unwrap(), before);
        c.set(
            id,
            driver,
            Part::Velocity(Vec3::new(2_000, 0, 0), Mode::Surface),
        )
        .unwrap();
        let changed = c.build_basis(id).unwrap();
        assert_eq!(
            c.commit_rebinds(&prepared, || Ok(())).unwrap_err().name,
            "edit.body-stale"
        );
        assert_eq!(c.build_basis(id).unwrap(), changed);
        let current = vec![(changed.clone(), after)];
        c.commit_rebinds(&current, || Ok(())).unwrap();
        let mut expected = changed;
        expected.moved.piece = after.piece;
        expected.moved.tri = after.tri;
        assert_eq!(c.build_basis(id).unwrap(), expected);
        let out = c.step(&BTreeMap::from([(id, surface)]), 50_000, 50_000);
        assert!(out.refused.is_empty());
        assert!(!out.samples.is_empty());
        assert!(c.body(id).unwrap().pose.position.x > 0);
        c.slot_in(
            id,
            driver,
            Frame {
                node: id,
                slot: Some(1),
            },
            100_000,
        )
        .unwrap();
        let slot = c.build_basis(id).unwrap();
        let called = std::cell::Cell::new(false);
        assert_eq!(
            c.commit_rebinds(&[(slot.clone(), slot.moved)], || {
                called.set(true);
                Ok(())
            })
            .unwrap_err()
            .name,
            "edit.body-stale"
        );
        assert!(!called.get());
        assert_eq!(c.build_basis(id).unwrap(), slot);
    }

    #[test]
    fn refused_and_stale_build_commits_preserve_all_controller_state() {
        let (id, family, surface) = fixture();
        let moved = surface
            .place(
                id,
                Frame {
                    node: id,
                    slot: None,
                },
                Vec3::ZERO,
                Quat::IDENTITY,
            )
            .unwrap();
        let mut c = Controller::new();
        c.add(family, moved).unwrap();
        let basis = c.build_basis(id).unwrap();
        let small = Build {
            size: Size::Small,
            ..Build::STANDARD
        };
        let refusal = c
            .commit_build(&basis, moved, small, || {
                Err::<(), _>(Refusal {
                    name: "paired-refusal",
                    detail: String::new(),
                })
            })
            .unwrap_err();
        assert_eq!(refusal.name, "paired-refusal");
        assert_eq!(c.build_basis(id).unwrap(), basis);
        let shape = SkillShape {
            name: Name::new("souls:walk").unwrap(),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: Vec::new(),
            cancelled_by: Vec::new(),
        };
        let driver = c.claim(id, &shape).unwrap();
        c.set(
            id,
            driver,
            Part::Velocity(Vec3::new(1000, 0, 0), Mode::Surface),
        )
        .unwrap();
        let current = c.build_basis(id).unwrap();
        let called = std::cell::Cell::new(false);
        assert_eq!(
            c.commit_build(&basis, moved, small, || {
                called.set(true);
                Ok(())
            })
            .unwrap_err()
            .name,
            "body-change-stale"
        );
        assert!(!called.get());
        assert_eq!(c.build_basis(id).unwrap(), current);
    }
}
