//! A committed move reaches the body (Engine v2 I4b, #3156): walk, sit, lie and rise from the gateway.
//!
//! [`crate::answers`] takes a move intent (a form's verb named `walk`, `sit`, `lie` or `rise`, as `eden:sit`; T10 rule 4
//! keeps `souls:` verbs for the engine's own) like any act: an id, a deadline and a place in the next tick. At that
//! tick it is committed here, and the body is driven only through what already moves bodies (`v2/docs/bodies.md`): a
//! walk is N7's walk skill run behind the host (`sim::host::Runner`, T9b/T9c), sent to a point (N9); a sit is B3's
//! reserved seat and B2's sit move (`sim::slots`, `sim::moves`); a lie is the same with B2's lie move and the stance
//! lie (C4, #3368); a rise is B3's rise. Each steps the one controller
//! (B1). Nothing here sets a pose or a position.
//!
//! - **Checked off the clock, committed on it** (K18b, #3175). A move's checks are its own: the controller's claims
//!   (T9 rule 4), the reach (B2), the seat free and in reach (B3), a route (N7). The route searches and the reach
//!   distances run on the world's planner thread (`sim::planner`), from the bodies as a tick left them, and come
//!   back for the next tick: a walk's place question goes in the tick it starts, with the bodies as that tick left
//!   them (#4974), so it gets its place and legs at the next tick; a sit or a rise is committed at
//!   the first tick after its reach is back, a tick later than asked. The clock commits: the claims, and the seat
//!   held or free and the distance against the move's reach, as B3 reserves a seat: one tick's sits are taken
//!   together, in B3's stable order. A move refused there ends by that name.
//! - **A thing with several seats** (C19, #3457). A sit names a thing; the world picks its free slot whose stand point
//!   is nearest the body (`Slots::free`, ties by slot), so three Souls share a sofa, each in its own slot, and a fourth
//!   is refused `place-taken`. A walk to a thing with no point goes to that slot's stand point. A restart hands each
//!   seated body back into the slot its logged pose names.

//! - **Ends by name.** A walk ends when its skill does: done, or failed by name. A sit or a rise ends when its move
//!   does: `done`, or cancelled by name (`claim-taken`, `out-of-reach`). A new move on a body whose walk is still
//!   going ends that walk `claim-taken`.
//! - **World time.** Bodies step in ticks of their own, of the world's tick length, caught up to the clock's world
//!   time at each tick: a late tick steps them more than once, never skips a step. Move phases are timers on K9's due
//!   list, fired against the same time.
//!
//! - **In the log** (K18, #3160). Each tick's part lists the bodies whose pose changed ([`Bodies::moved`]), a body in
//!   a seat with its stance ([`row`]); a restart builds each where the log last had it standing
//!   ([`Bodies::add_body_at`]) and hands each that sat back into its seat ([`Bodies::seat_placed`], K18c #3176), so
//!   the seat is held in the slots table again and a rise or another sit sees it. A body being carried across a link
//!   is not written while it crosses: its pose then lies on neither end's ground, so the log keeps where it last
//!   stood until it lands (#4669: a kill mid-crossing once left every later restart refusing every move).
//!
//! - **Seen moving** (#3799). After each step the world writes each body's motion on its node, as T4's samples: at
//!   each hand-off (a start, a stop, a turn, a seat taken or left, a new floor) and every [`KEYFRAME_US`] while it
//!   moves; a change of frame is a leave and an arrive inside the zone first. So the tree, interest and the public
//!   stream follow the bodies ([`Bodies::motion`]).
//!
//! - **Who hears** (#3369). After each step of the controller the bodies call `sim::speech::heard`, which brings every
//!   body's interest set up to date and gives each utterance the step started its hearers as they are then; the world
//!   writes each as `sim::speech::entry` says ([`Bodies::heard`]).
//!
//! Not here: I7's accept-then-resolve (one answer, at the move's end), plans (I9).

use sim::ground::Versions;
use sim::planner::{FormAnswer, FormKey, FormQuestion};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use replica::bodies::Family;
use replica::bodies::{Class, SkillShape, Want};
use replica::effects::Effect;
use replica::effects::{Actor, Refusal, fixture_bytes};
use replica::encode::{Name, Value, decode};
use replica::host::Progress;
use replica::ids::{Id, Minter, Scope};
use replica::intents::Intent;
use replica::kinds::sizes::{Build, Size};
use replica::move_check::{self, Seen, Verdict};
use replica::moves::{Effector, Move};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::select::{self, Spot};
use replica::speech::Said;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::Audience;
use sim::commit::bind::{Bound, Slot, bind};
use sim::commit::spot;
use sim::controller::Stance;
use sim::controller::{Driver, Part};
use sim::host::Runner;
use sim::host::{Batches, Planned, ReachKey, ReachQuestion, Wants};
use sim::life::{Born, Life, Retired, Standing};
use sim::mover::Body as Moved;
use sim::moves::{Fired, Instance, Moves, Reach};
use sim::planner::{Planner, Thread};
use sim::slots::{PlaceAt, Request, Slots};
use sim::speech::{self, Hearing};
use sim::spots::Target;
use sim::timers::DueList;
use sim::walk::town::Town;
use skills::route::Route;
use skills::wind_down::{self, Do, Ground, Order, Phase, WindDown};

type R<T> = Result<T, Refusal>;

const SIT: &str = include_str!("../../replica/fixtures/moves/sit.diag");
const RISE: &str = include_str!("../../replica/fixtures/moves/rise.diag");
const LIE: &str = include_str!("../../replica/fixtures/moves/lie.diag");

/// A walk's speed, µm a second: `sim::gaits`' walk.
pub const WALK: i64 = sim::gaits::WALK.speed;
/// #5254: how far from the point it was sent to a walk may end and be an arrival, mm (walks end within 0.3 m of their
/// goal), and how many times one that ends further off is sent again, while bodies move off its way, before it answers
/// `walk.stopped-short`.
pub const STOPPED_SHORT_MM: u64 = 400;
pub const WALK_AGAIN: u8 = 6;
/// How long after a walk stopped short it is sent again, µs: bodies in its way have time to move off (six times, three
/// seconds).
pub const WALK_AGAIN_AFTER: Micros = 500_000;

/// The speed of a walk at `gait` (0.135 G1): that gait's, or a walk's when it names none.
pub fn speed(gait: Option<&str>) -> i64 {
    gait.and_then(sim::gaits::Gait::named)
        .map_or(WALK, |g| g.speed)
}

pub use replica::move_check::Ask;

/// A move intent read: who moves, and what it asks, then its ranked fallbacks (moves of the same form on other
/// targets, C14 #3442).
#[derive(Clone, Debug)]
pub struct Asked {
    pub body: Id,
    pub actor: Actor,
    pub ask: Ask,
    pub fallbacks: Vec<Ask>,
}

/// Whether `v` is a form's arguments: a list of `[name, value]` pairs, a name as bytes.
fn form_args(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(a)) => a.first().is_some_and(
            |p| matches!(p, Value::Array(kv) if matches!(kv.first(), Some(Value::Bytes(_)))),
        ),
        _ => false,
    }
}

/// Reads a move intent (`replica::move_check::read`, the client's own reading): `None` when its verb is not a move,
/// else the ask and its fallbacks or the reason it is not one. A walk's point is parameter 1, `[x, y, z]` µm in its
/// target's frame.
pub fn read(intent: &Intent, body: Id) -> Option<Result<Asked, &'static str>> {
    // A sit or a lie naming a form's arguments (`[[name, value], ...]`, its seat) is the entry's own form, run by the
    // form runner with its walk (C17, #3453); a bare one is the move, unless its thing's entry declares that form's
    // walk to a free slot (`Acts::fixture_sit`).
    if matches!(intent.verb.as_str().split_once(':'), Some((ns, "sit" | "lie")) if ns != "souls")
        && form_args(intent.parameters.get(&1))
    {
        return None;
    }
    Some(move_check::read(intent)?.map(|mut asks| {
        let ask = asks.remove(0);
        Asked {
            body,
            actor: intent.actor,
            ask,
            fallbacks: asks,
        }
    }))
}

#[derive(Clone, Copy, Debug)]
enum Live {
    Walk,
    Place(Instance),
}

/// Only the exact slot and pending move's planner answer may supply a reach check.
struct Reached<'a> {
    cache: &'a BTreeMap<ReachKey, [i64; 2]>,
    order: Option<Id>,
    slot: Option<u64>,
}

impl Reach for Reached<'_> {
    fn distance(
        &self,
        body: Id,
        _effector: &Effector,
        _part: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64> {
        let [place, stand] = self.cache.get(&(body, target, self.slot?, self.order?))?;
        match point.as_str() {
            "souls:slot" => Some(*place),
            "souls:stand" => Some(*stand),
            _ => None,
        }
    }
}

/// A sit or a rise asked, waiting for its reach from the planner: its intent, its body, the place (none for a rise
/// from no place).
#[derive(Clone, Copy, Debug)]
struct Waiting {
    id: Id,
    body: Id,
    place: Option<Id>,
    /// A sit's or a lie's stance; `None` for a rise.
    stance: Option<Stance>,
}

/// The skill that turns a body where it stands: it takes all its legs for the turn and gives them back.
fn face_skill() -> SkillShape {
    SkillShape {
        name: Name::new("souls:face").unwrap_or_else(|| unreachable!("a name")),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: Vec::new(),
        cancelled_by: Vec::new(),
    }
}

/// Turns `body` to `facing` where it stands, only when the turn takes its legs from nothing: a walk, a follow, a body
/// settled on the ground or any other driver of its legs keeps them, and the body keeps its facing (review of #4925:
/// the turn as two begin to talk ended the follow one of them was in). For a turn as an activity begins or a form
/// starts; a walk's end turns with [`Bodies::face`].
pub(crate) fn turn_free(c: &mut sim::controller::Controller, body: Id, facing: Quat) {
    let turn = face_skill();
    let free = c
        .claims(body)
        .and_then(|k| k.plan(Driver::MAX, &turn).ok())
        .is_some_and(|s| s.cancelled.is_empty());
    if free && let Ok(d) = c.claim(body, &turn) {
        let _ = c.set(body, d, Part::Facing(facing));
        let _ = c.release(body, d);
    }
}

/// The world's bodies: a town, the runner of skills over it with the one controller, and the moves and seats.
pub struct Bodies {
    pub runner: Runner,
    pub town: Town,
    pub slots: Slots,
    pub orders: sim::orders::Orders,
    moves: Moves,
    due: DueList,
    mint: Minter,
    sit: Move,
    lie: Move,
    rise: Move,
    /// The move each body is doing for an intent.
    live: BTreeMap<Id, (Id, Live)>,
    /// Intents ended between steps (a walk replaced): the intent and how.
    ended: Vec<(Id, Result<(), String>)>,
    /// The walks that ended `done` as near their goal as a crowd there allows (A2-4), until the answer is written.
    pub short: BTreeSet<Id>,
    /// #5254: each walk to a point that ended more than [`STOPPED_SHORT_MM`] from it, how far (mm) and whether a crowd
    /// held it off, until its answer is written: it answers `walk.stopped-short`, never as an arrival.
    pub stopped_short: BTreeMap<Id, (u64, bool)>,
    /// #5254: each walk done at a place moved off the point it was sent to (that point in a passage's clearance or off
    /// its ground), how far, mm, and the passage it cleared (the thing it belongs to and its kind; none off the
    /// ground), until its answer is written.
    pub goal_moved: BTreeMap<Id, (u64, Option<(Id, sim::links::Kind)>)>,
    /// How many times each such walk was sent again while bodies moved round its goal ([`WALK_AGAIN`]).
    walked_again: BTreeMap<Id, u8>,
    /// The candidate each started intent took: its rank in the ranked list and its target (C14).
    took: BTreeMap<Id, (usize, Option<Id>)>,
    /// Each started walk's target, and the point on it when it was sent to one, kept to its end however it ends
    /// (0.133): how far from it a done walk ended is measured then.
    walked_to: BTreeMap<Id, (Id, Option<Vec3>)>,
    /// How far from its target each done walk ended, mm, until its end is written ([`Bodies::away`]).
    away_of: BTreeMap<Id, u64>,
    /// Each body's pose as last written to the log ([`Bodies::moved`]).
    logged: BTreeMap<Id, Pose>,
    /// Each body's motion as the world last wrote it to its node ([`Bodies::motion`]); read from the tree when absent.
    shown: BTreeMap<Id, Shown>,
    /// The planner thread: route searches and reach distances, off the clock (K18b, #3175).
    planner: Thread,
    /// How long a tick waits for each of the planner's batches: `None` as long as it takes (lockstep, the default),
    /// else a bound (a free-running clock never stops for the planner; a late batch is read at a later tick).
    pub wait: Option<Duration>,
    /// A replay's record of the planner (K18b): at these body times, take only this many batches (each other body
    /// tick takes every batch out, waiting as long as it takes). Read from the recorder's `Planned` inputs.
    pub schedule: BTreeMap<Micros, u64>,
    /// Where a free-running clock took fewer batches than were out, for the recorder: body time and batches taken.
    late: Vec<(Micros, u64)>,
    /// The planner's answers for the next tick; a queue's approach reads them too (`crate::orders::step`, B7c).
    pub(crate) planned: Planned,
    /// Batches sent to the planner and taken back so far (S8): a request still out is not asked again.
    sent: u64,
    taken: u64,
    /// The lines queues asked of the planner still out (S8): the spot asked and the batch it went in (B7c).
    order_out: BTreeMap<Id, (Vec3, u64)>,
    /// Form questions out at the planner (S8): each cursor's generation and the batch it went in.
    forms_out: BTreeMap<FormKey, (u64, u64)>,
    pub(crate) form_map: Arc<Versions>,
    pub(crate) form_answers: BTreeMap<FormKey, FormAnswer>,
    pub(crate) form_questions: BTreeMap<FormKey, FormQuestion>,
    /// The reach distances last found, by body and seat.
    reached: BTreeMap<ReachKey, [i64; 2]>,
    /// Sits and rises waiting for their reach, in the order asked.
    waiting: Vec<Waiting>,
    /// Every body's interest set (B11, R4), kept as the bodies move.
    hearing: Hearing,
    /// The utterances started since the world last took them, each with its speaker, its record (hearers resolved
    /// when it started) and the world time it started: the world writes each.
    pub heard: Vec<(Id, Said, Micros)>,
    /// The wind-down (B16, #2751): the one rule by which the world moves a body its agent did not order.
    pub wind: WindDown,
    /// Its records since the world last took them, cause and actor the world; and the never-stuck ladder's (0.133 N1,
    /// [`crate::unstick`]), which the world writes the same way.
    pub wind_log: Vec<Effect>,
    /// What a restart did with each body the log had where it may not stand (E11d, killed during a climb out), or
    /// could not place again where the log had it, by name: `climb-out` or `resume-nearest` (carried on along a clean
    /// way), `resume-seated` (back in the place it was climbing out of), `resume-seated-other` (that place taken:
    /// another free place of its thing), `resume-placed` (standing at its floor's nearest free legal point),
    /// `resume-stood` (logged seated, its seat taken or gone: standing) or `resume-entry` (standing at the world's entry).
    /// Each is also an entry on the body ([`crate::unstick::restarted`]).
    pub resumed: Vec<(Id, &'static str)>,
    /// The restart's entries the next step writes: body, how, node, from and to ([`Bodies::restarted_as`]).
    restarts: Vec<(Id, &'static str, Id, Vec3, Vec3)>,
    /// The bodies placed at their floor's nearest legal point with no clean way on, each with its floor, where the log
    /// had it and its build: [`Bodies::begin`] seats each again or leaves it standing there.
    held_off: Vec<(Id, Id, Vec3, Build)>,
    /// The never-stuck ladder over the bodies' walks (0.133 N1).
    pub unstuck: crate::unstick::Unstuck,
    /// The rule's own move going on each body, by its intent id.
    wind_moves: BTreeMap<Id, Id>,
    /// Each member's walk to its place in an activity (0.135 G3), by (activity, body).
    place_moves: BTreeMap<(Id, Id), Id>,
    /// Each body the rule put to sleep on the ground: the driver holding it lying.
    sleeping: BTreeMap<Id, Driver>,
    /// The things with a seat in each room, by kind (#3178): under the floor each seat is on and each node above its
    /// thing, and under its plain kind and the entry it goes by. A sit by kind looks its room and kind up here
    /// ([`Bodies::seat_by_kind`]), never scans the tree.
    rooms: Rooms,
}

/// [`Bodies::rooms`]: (room, kind) to the things with a seat there.
type Rooms = BTreeMap<(Id, String), BTreeSet<Id>>;

/// Files `thing`, its seat on `floor`, in `rooms` as `tree` holds it ([`Bodies::rooms`]).
fn file(rooms: &mut Rooms, tree: &Tree, thing: Id, floor: Id) {
    let node = |id: Id| tree.node(tree.handle(id)?);
    let Some(n) = node(thing) else {
        return;
    };
    let plain = replica::world_model::plain(n.kind().as_str()).to_owned();
    let entry = import_eden::entry_name(n.kind().as_str(), n.fields());
    let entry = entry.split('@').next().unwrap_or(entry).to_owned();
    let mut room = Some(floor);
    let mut up = n.parent();
    for _ in 0..64 {
        let Some(r) = room else { break };
        for k in [&plain, &entry] {
            rooms.entry((r, k.clone())).or_default().insert(thing);
        }
        room = up;
        up = up.and_then(|u| node(u)?.parent());
    }
}

/// Where the log last had each body: its pose, and its stance when that pose is in a seat's slot (K18, #3160;
/// K18c, #3176). What a restart builds its bodies at.
pub type Placed = BTreeMap<Id, (Pose, Option<Stance>)>;

/// The bodies whose pose changed since the tick's record last read them, a seated one with its stance
/// ([`Bodies::moved`]).
pub type MovedRows = Vec<(Id, Pose, Option<Stance>)>;

/// About how often a moving body's motion is written while nothing else about it changes (#3799): 200 ms of world
/// time, counted in whole ticks.
pub const KEYFRAME_US: Micros = 200_000;

/// A body's motion as the world last wrote it on its node (#3799): its pose, its velocity and when.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Shown {
    pose: Pose,
    linear: Vec3,
    at: Micros,
    audience: Audience,
}

impl Shown {
    /// What the tree holds of `body`'s motion: its place in its parent's frame, and its last sample's velocity and time.
    fn of(tree: &Tree, body: Id) -> Option<Shown> {
        let n = tree.node(tree.handle(body)?)?;
        let place = n.place()?;
        let pose = Pose {
            frame: Frame {
                node: n.parent()?,
                slot: n.slot(),
            },
            position: place.position,
            orientation: place.orientation,
            support: place.support,
        };
        let (linear, at) = n
            .moved()
            .map_or((Vec3::ZERO, Micros::MIN), |m| (m.linear, m.at));
        Some(Shown {
            pose,
            linear,
            at,
            audience: n.audience(),
        })
    }
}

/// One body's motion to write this tick (#3799): T4's sample on its node, after a change of parent to `to` when its
/// frame changed (into a seat's slot, out of one, onto another floor).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sample {
    pub audience: Audience,
    pub to: Option<Pose>,
    pub handoff: HandOff,
}

/// Whether the walk turned or changed pace between two velocities: on the ground plane, more than about 7 degrees
/// of heading, or a speed outside three quarters to four thirds of the last.
fn turned(a: Vec3, b: Vec3) -> bool {
    let (ax, az, bx, bz) = (
        i128::from(a.x),
        i128::from(a.z),
        i128::from(b.x),
        i128::from(b.z),
    );
    let (dot, cross) = (ax * bx + az * bz, ax * bz - az * bx);
    let (a2, b2) = (ax * ax + az * az, bx * bx + bz * bz);
    dot <= 0 || cross * cross * 64 > dot * dot || b2 * 16 < a2 * 9 || b2 * 9 > a2 * 16
}

/// A body's row in a tick's part (K18's `answers::BODIES`): `[body, pose]`, or `[body, pose, stance]` in a seat
/// (1 sit, 2 lie, 3 stand in a standing slot, #3598).
pub fn row(body: Id, pose: &Pose, stance: Option<Stance>) -> Value {
    let mut r = vec![body.to_value(), pose.to_value()];
    match stance {
        Some(Stance::Sit) => r.push(Value::Uint(1)),
        Some(Stance::Lie) => r.push(Value::Uint(2)),
        Some(Stance::Stand) => r.push(Value::Uint(3)),
        None => {}
    }
    Value::Array(r)
}

/// A row read back: the body, its pose and its stance in a seat.
pub fn read_row(v: &Value) -> Option<(Id, Pose, Option<Stance>)> {
    let Value::Array(p) = v else { return None };
    let (id, pose, rest) = match p.as_slice() {
        [id, pose, rest @ ..] => (id, pose, rest),
        _ => return None,
    };
    let stance = match rest {
        [Value::Uint(1)] => Some(Stance::Sit),
        [Value::Uint(2)] => Some(Stance::Lie),
        [Value::Uint(3)] => Some(Stance::Stand),
        _ => None,
    };
    Some((
        replica::effects::read_id(id).ok()?,
        Pose::from_value(pose).ok()?,
        stance,
    ))
}

fn load(text: &str) -> R<Move> {
    let v = decode(&fixture_bytes(text)?)
        .map_err(|e| Refusal {
            name: "move-unread",
            detail: e.to_string(),
        })?
        .value;
    Move::from_value(&v)
}

impl Bodies {
    /// No bodies yet, over `town`, stepped in ticks of `tick` µs.
    pub fn new(town: Town, tick: Micros) -> R<Bodies> {
        let copy = town.copy().map_err(|e| Refusal {
            name: "planner-town",
            detail: e,
        })?;
        Bodies::with_planner(town, copy, tick)
    }

    /// No bodies yet, over `town`, with `copy` (built by [`Town::copy`]) the planner's town (K18b): a world builds the
    /// copy with its town, before its clock and watchdog start, as a large town takes a while to build.
    pub fn with_planner(mut town: Town, mut copy: Town, tick: Micros) -> R<Bodies> {
        // The spot tables' record is a test's: a served world keeps none (#2803).
        town.spots.forget_record();
        copy.spots.forget_record();
        let planner = Thread::spawn(Planner::new(copy)).map_err(|e| Refusal {
            name: "planner-thread",
            detail: e.to_string(),
        })?;
        Ok(Bodies {
            planner,
            wait: None,
            schedule: BTreeMap::new(),
            late: Vec::new(),
            planned: Planned::default(),
            sent: 0,
            taken: 0,
            order_out: BTreeMap::new(),
            forms_out: BTreeMap::new(),
            reached: BTreeMap::new(),
            waiting: Vec::new(),
            // The controller's input log is a test's: a served world keeps its inputs in its own log (#2803).
            runner: {
                let mut runner = Runner::new(tick);
                runner.controller.forget_log();
                runner
            },
            form_map: Arc::new(town.versions.clone()),
            form_answers: BTreeMap::new(),
            form_questions: BTreeMap::new(),
            town,
            slots: Slots::new(),
            orders: sim::orders::Orders::new(),
            moves: Moves::new(),
            due: DueList::new(),
            mint: Minter::new(Scope([0xb4; 16])),
            sit: load(SIT)?,
            lie: load(LIE)?,
            rise: load(RISE)?,
            live: BTreeMap::new(),
            ended: Vec::new(),
            short: BTreeSet::new(),
            stopped_short: BTreeMap::new(),
            goal_moved: BTreeMap::new(),
            walked_again: BTreeMap::new(),
            took: BTreeMap::new(),
            walked_to: BTreeMap::new(),
            away_of: BTreeMap::new(),
            logged: BTreeMap::new(),
            shown: BTreeMap::new(),
            hearing: Hearing::new(),
            heard: Vec::new(),
            // A test world shortens the wind-down's clocks (seconds: wander, zombie, leg min, leg max, bound).
            wind: WindDown::new(
                std::env::var("WORLDD_WIND_DOWN")
                    .ok()
                    .and_then(|t| WindDown::knobs_from(&t))
                    .unwrap_or(wind_down::KNOBS),
            ),
            wind_log: Vec::new(),
            resumed: Vec::new(),
            restarts: Vec::new(),
            held_off: Vec::new(),
            unstuck: crate::unstick::Unstuck::default(),
            wind_moves: BTreeMap::new(),
            place_moves: BTreeMap::new(),
            sleeping: BTreeMap::new(),
            rooms: BTreeMap::new(),
        })
    }

    pub fn classes(&self) -> BTreeMap<Id, Size> {
        self.runner
            .controller
            .ids()
            .filter_map(|id| {
                let size = self.runner.controller.build(id)?.size;
                (size != Size::Standard).then_some((id, size))
            })
            .collect()
    }

    pub(crate) fn wear_basis(&self, body: Id) -> R<sim::controller::BuildBasis> {
        let basis = self
            .runner
            .controller
            .build_basis(body)
            .ok_or_else(|| refusal("body-unknown", body))?;
        self.runner.controller.check_build(&basis)?;
        if self.runner.running(body)
            || self.live.contains_key(&body)
            || self.orders.open(body).is_some()
            || self.slots.held_by(body).is_some()
        {
            return Err(refusal("body-change-in-use", body));
        }
        Ok(basis)
    }
    pub(crate) fn commit_wear<T>(
        &mut self,
        basis: &sim::controller::BuildBasis,
        build: Build,
        moved: Moved,
        commit: impl FnOnce() -> R<T>,
    ) -> R<T> {
        self.wear_basis(basis.moved.id)?;
        let value = self
            .runner
            .controller
            .commit_build(basis, moved, build, commit)?;
        self.town.set_class(basis.moved.id, build.size);
        self.form_map = Arc::new(self.town.versions.clone());
        self.planned.keep_map(&self.form_map);
        self.reached.clear();
        self.form_answers.clear();
        Ok(value)
    }

    /// Confirms the exact authoritative preparation basis before any replica write.
    pub(crate) fn check_map(
        &self,
        maps: &crate::buildsafe::PreparedMaps,
    ) -> Result<(), replica::edit::Refused> {
        match self.check_map_or_walked(maps)? {
            None => Ok(()),
            Some(_) => Err(replica::edit::Refused {
                op: None,
                name: "edit.body-stale",
                detail: "prepared triangle differs".into(),
            }),
        }
    }

    /// As `check_map`, but when every guard holds and an affected body only walked out of its prepared triangle
    /// (B12b), the current bases of exactly the prepared bodies, in order, for a reprepare off the clock.
    pub(crate) fn check_map_or_walked(
        &self,
        maps: &crate::buildsafe::PreparedMaps,
    ) -> Result<Option<Vec<sim::controller::BuildBasis>>, replica::edit::Refused> {
        if !Arc::ptr_eq(&maps.before, &self.form_map) {
            return Err(replica::edit::Refused {
                op: None,
                name: "edit.stale",
                detail: "the prepared map changed".into(),
            });
        }
        let current: BTreeSet<_> = self
            .runner
            .controller
            .bodies()
            .filter_map(|body| self.runner.controller.build_basis(body.id))
            .filter(|b| maps.live.affects(b, self.town.ground))
            .map(|b| b.moved.id)
            .collect();
        let prepared: BTreeSet<_> = maps
            .rebinds
            .iter()
            .map(|target| target.before.moved.id)
            .collect();
        if current != prepared {
            return Err(replica::edit::Refused {
                op: None,
                name: "edit.body-stale",
                detail: "affected bodies changed".into(),
            });
        }
        let certified = self
            .runner
            .controller
            .certify_or_walked(&maps.rebinds)
            .map_err(|r| replica::edit::Refused {
                op: None,
                name: r.name,
                detail: r.detail,
            })?;
        self.town
            .check_install(&maps.live)
            .map_err(|r| replica::edit::Refused {
                op: None,
                name: r.name,
                detail: r.detail,
            })?;
        match certified {
            sim::controller::Certified::Ready(_) => Ok(None),
            sim::controller::Certified::WalkedOn => maps
                .rebinds
                .iter()
                .map(|t| self.runner.controller.build_basis(t.before.moved.id))
                .collect::<Option<Vec<_>>>()
                .map(Some)
                .ok_or(replica::edit::Refused {
                    op: None,
                    name: "edit.body-stale",
                    detail: "prepared body missing".into(),
                }),
        }
    }

    /// Pairs the town transaction with the existing live edit write. Every input refusal leaves both unchanged.
    pub(crate) fn commit_map(
        &mut self,
        maps: crate::buildsafe::PreparedMaps,
        commit: impl FnOnce() -> Result<sim::edit::Committed, replica::edit::Refused>,
    ) -> Result<sim::edit::Committed, replica::edit::Refused> {
        self.check_map(&maps)?;
        let rebinds = self
            .runner
            .controller
            .certify_rebinds(&maps.rebinds)
            .map_err(|r| replica::edit::Refused {
                op: None,
                name: r.name,
                detail: r.detail,
            })?;
        let mut refused = None;
        let town = &mut self.town;
        let done = self
            .runner
            .controller
            .commit_rebinds(&rebinds, || {
                town.install_then(maps.live, &maps.part, || {
                    commit().map_err(|r| {
                        let error = Refusal {
                            name: r.name,
                            detail: r.detail.clone(),
                        };
                        refused = Some(r);
                        error
                    })
                })
            })
            .map_err(|r| {
                refused.unwrap_or(replica::edit::Refused {
                    op: None,
                    name: r.name,
                    detail: r.detail,
                })
            })?;
        self.planner
            .install(maps.before, maps.worker, Arc::clone(&done.part));
        self.runner.prepared_ground(&rebinds, &self.town);
        self.form_map = maps.after;
        self.planned.keep_map(&self.form_map);
        self.reached.clear();
        self.form_answers.clear();
        Ok(done)
    }

    /// Adds a body of `family`, standing as the mover placed it.
    pub fn add_body(&mut self, family: Family, body: Moved) -> R<()> {
        self.add_body_built(family, body, Build::STANDARD)
    }
    pub fn add_body_built(&mut self, family: Family, body: Moved, build: Build) -> R<()> {
        self.town.surfaces_for(build.size).ok_or_else(|| Refusal {
            name: "body-class-unprepared",
            detail: "no prepared geometry".into(),
        })?;
        let id = body.id;
        self.runner.controller.add_built(family, body, build)?;
        self.wind.add(id, self.runner.now);
        self.town.set_class(body.id, build.size);
        Ok(())
    }

    /// Adds a seat, and its thing to the rooms it is in ([`Bodies::seat_by_kind`]).
    pub fn add_place(&mut self, place: PlaceAt) -> R<()> {
        let (thing, floor) = (place.thing, place.floor);
        self.slots.add(place)?;
        file(&mut self.rooms, &self.town.tree, thing, floor);
        Ok(())
    }

    /// Files the seats a creator's edit installed (`crate::edit_places`), as `tree` (the live tree) holds them, in the
    /// rooms a sit by kind looks up. A thing with no seat is passed over.
    pub fn file_seats(&mut self, tree: &Tree, things: impl IntoIterator<Item = Id>) {
        for t in things {
            if let Some(floor) = self.slots.place(t).map(|p| p.floor) {
                file(&mut self.rooms, tree, t, floor);
            }
        }
    }

    /// Whether `room` holds a seat of `kind` (taken or free; [`Bodies::seat_by_kind`]).
    pub fn has_kind(&self, room: Id, kind: &str) -> bool {
        self.rooms
            .get(&(room, kind.to_owned()))
            .is_some_and(|t| t.iter().any(|t| self.slots.place(*t).is_some()))
    }

    /// The thing a sit by kind takes in `room` (#3178; I5's selector, any free slot of a kind in a node, nearest the
    /// body, ties by id): of the things of `kind` (any, for none) with a seat there that `fits` (its form, as the
    /// caller reads it), the one whose free slot nearest `body` (C19's pick) is nearest, ties by thing. A slot
    /// `taken` names is not free. Bound at commit on the clock thread, one sit at a time, so each of a tick's sits
    /// sees the seats taken before it: one lookup per seat of that kind in the room, no rule run. With it, the square
    /// of that free slot's distance from the body, µm² ([`Bodies::seat_gap`]). `None` when none there is free.
    pub fn seat_by_kind(
        &self,
        room: Id,
        kind: Option<&str>,
        body: Id,
        fits: &dyn Fn(Id) -> bool,
        taken: &dyn Fn(Id, u64) -> bool,
    ) -> Option<(Id, i128)> {
        let c = &self.runner.controller;
        let pose = c.body(body)?.pose;
        let from = (pose.frame.node, pose.position, room == self.town.ground);
        let mut best: Option<(i128, Id)> = None;
        // A thing filed under two kinds (its plain kind and its entry's) is met twice with any kind: the same key.
        let things: Box<dyn Iterator<Item = Id> + '_> = match kind {
            Some(k) => Box::new(self.rooms.get(&(room, k.to_owned()))?.iter().copied()),
            None => Box::new(
                self.rooms
                    .range((room, String::new())..)
                    .take_while(move |((r, _), _)| *r == room)
                    .flat_map(|(_, t)| t.iter().copied()),
            ),
        };
        for t in things {
            let Some(s) = self.slots.free_unless(c, body, t, &|s| taken(t, s)) else {
                continue;
            };
            let Some(gap) = self
                .slots
                .place_in(t, s)
                .and_then(|p| self.seat_gap(from, p))
            else {
                continue;
            };
            let key = (gap, t);
            // `fits` reads the tree and the entries: asked only of a seat nearer than the best so far.
            if best.is_none_or(|b| key < b) && fits(t) {
                best = Some(key);
            }
        }
        best.map(|(gap, t)| (t, gap))
    }

    /// The thing of `kind` with a seat in `room` that `may` (the asker may use it), taken or free, whose seat stands
    /// nearest `body` (ties by thing), with that distance squared, µm² ([`Bodies::seat_gap`]): where a sit by kind
    /// that found none free is told they are.
    pub fn nearest_of_kind(
        &self,
        room: Id,
        kind: &str,
        body: Id,
        may: &dyn Fn(Id) -> bool,
    ) -> Option<(Id, i128)> {
        let pose = self.runner.controller.body(body)?.pose;
        let from = (pose.frame.node, pose.position, room == self.town.ground);
        self.rooms
            .get(&(room, kind.to_owned()))?
            .iter()
            .filter(|t| may(**t))
            .flat_map(|t| {
                self.slots
                    .places_of(*t)
                    .filter_map(move |p| Some((self.seat_gap(from, p)?, *t)))
            })
            .min()
            .map(|(gap, t)| (t, gap))
    }

    /// The square of the distance on the ground plane, µm², from `from` (a body's frame node, its position there, and
    /// whether the sit by kind is asked on the open ground) to seat `p`'s standing point. On the open ground, a seat on
    /// another floor than the body's frame (a hall's floor) is moved into that frame by the poses between
    /// (`xform_to`). Elsewhere (indoors), and where that frame is not above the seat's floor (a seated body's frame is
    /// its seat's thing), its point is read in its own floor's frame, as C19's pick reads it.
    fn seat_gap(&self, from: (Id, Vec3, bool), p: &sim::slots::PlaceAt) -> Option<i128> {
        let mut at = p.stand().ok()?;
        if from.2 && p.floor != from.0 {
            let t = &self.town.tree;
            let moved = t
                .handle(p.floor)
                .zip(t.handle(from.0))
                .and_then(|(f, to)| sim::ground::scene::xform_to(t, f, to).ok())
                .and_then(|x| x.point(at).ok());
            at = moved.unwrap_or(at);
        }
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        Some(d(at.x, from.1.x) + d(at.z, from.1.z))
    }

    /// Where `body` is: the node of its frame (its floor, or the thing whose slot it sits in) and its position there.
    pub fn pose(&self, body: Id) -> Option<(Id, Vec3)> {
        let p = self.runner.controller.body(body)?.pose;
        Some((p.frame.node, p.position))
    }

    /// Adds a body of `family`: where the log last had it standing (`placed`, K18 #3160), else as the mover placed it.
    /// A body that sat is added standing as the mover placed it; [`Bodies::seat_placed`] then seats it.
    pub fn add_body_at(&mut self, family: Family, body: Moved, placed: &Placed) -> R<()> {
        self.add_body_at_built(family, body, placed, Build::STANDARD)
    }
    pub fn add_body_at_built(
        &mut self,
        family: Family,
        body: Moved,
        placed: &Placed,
        build: Build,
    ) -> R<()> {
        let surfaces = self.town.surfaces_for(build.size).ok_or_else(|| Refusal {
            name: "body-class-unprepared",
            detail: "no prepared geometry".into(),
        })?;
        let mut resume = None;
        let body = match placed.get(&body.id) {
            Some((p, _)) => match p.support {
                Support::Surface { surface, .. } => match surfaces.get(&surface) {
                    // A body the log had where it may not stand (killed mid-climb out of a seat, E11d) climbs on by
                    // the climb's own rule from where it was (`sim::slots::Resumed`); with no clean way on it is never
                    // carried through a cut: it is placed at its floor's nearest legal point, and [`Bodies::begin`]
                    // seats it again or leaves it standing there, named. Never refused while its floor holds a point,
                    // so one body never stops the others starting.
                    Some(s) => {
                        let r = self.slots.resume(
                            &self.town,
                            s,
                            body.id,
                            p.frame,
                            p.position,
                            p.orientation,
                            build,
                        );
                        let clean = r.to();
                        match r {
                            sim::slots::Resumed::Stood => {}
                            sim::slots::Resumed::Held => resume = Some((surface, None, r)),
                            _ => resume = clean.map(|to| (surface, Some(to), r)),
                        }
                        if matches!(r, sim::slots::Resumed::Held) {
                            let m = legal_near(
                                &self.town,
                                s,
                                body.id,
                                p.frame,
                                p.position,
                                p.orientation,
                                build,
                            )?;
                            self.free_near(s, m, build)
                        } else {
                            sim::slots::placed_off(
                                s,
                                body.id,
                                p.frame,
                                p.position,
                                p.orientation,
                                build,
                            )?
                        }
                    }
                    None => {
                        return Err(Refusal {
                            name: "no-surface",
                            detail: "recorded support is unavailable".into(),
                        });
                    }
                },
                _ => body,
            },
            None => body,
        };
        // A body placed away from where the log had it is logged as the log had it, so its next row heals the log.
        let id = body.id;
        let logged = match (&resume, placed.get(&id)) {
            (Some((_, None, _)), Some((p, _))) => *p,
            _ => body.pose,
        };
        self.logged.insert(id, logged);
        self.add_body_built(family.clone(), body, build)?;
        let from = logged.position;
        match resume {
            Some((floor, Some(to), r)) => {
                match self
                    .runner
                    .controller
                    .carry(id, sim::slots::climb_track(floor, to))
                {
                    Ok(()) => self.restarted_as(id, r.name(), floor, from, to),
                    // Not carried after all: never left where it may not stand. Placed at its floor's nearest free
                    // legal point, as with no clean way on; with none, taken out again and refused, so the restart
                    // places it by its last resort ([`Bodies::add_body_at_entry`]).
                    Err(e) => {
                        let near = self
                            .runner
                            .controller
                            .body(id)
                            .map(|b| b.pose)
                            .and_then(|p| {
                                let s = self.town.surfaces_for(build.size)?.get(&floor)?;
                                let m = legal_near(
                                    &self.town,
                                    s,
                                    id,
                                    p.frame,
                                    p.position,
                                    p.orientation,
                                    build,
                                )
                                .ok()?;
                                Some(self.free_near(s, m, build))
                            });
                        self.runner.controller.remove(id);
                        let Some(m) = near else {
                            self.logged.remove(&id);
                            return Err(e);
                        };
                        self.add_body_built(family, m, build)?;
                        self.held_off.push((id, floor, from, build));
                    }
                }
            }
            Some((floor, None, _)) => self.held_off.push((id, floor, from, build)),
            None => {}
        }
        Ok(())
    }

    /// Restart (E11d), with world time `now`: each body [`Bodies::add_body_at_built`] placed at its floor's nearest
    /// legal point, having no clean way on from where the log had it, is seated again in the place it was climbing
    /// out of. A climb starts at its place and goes straight away from it, so that is the place of the things the body
    /// was over nearest where the log had it (ties by thing, slot, place); held there by the place's own position
    /// (`restore`'s `was`), else, taken, another free place of that thing, named. Its next rise climbs out or is
    /// refused by name. A place that moves with its cabin (N14) is never taken while the cabin is away from its own
    /// stop: the body would ride off with it. With none free the body stands where it was placed, `resume-placed`,
    /// and its next walk is answered from there.
    fn reseat_held(&mut self, now: Micros) {
        for (id, floor, at, build) in std::mem::take(&mut self.held_off) {
            if self.runner.controller.body(id).is_none() {
                continue;
            }
            let d = |p: Vec3| i128::from(p.x - at.x).pow(2) + i128::from(p.z - at.z).pow(2);
            let mut left: Vec<(i128, Id, u64, u32, Vec3)> = Vec::new();
            for thing in self.slots.over(floor, at, build) {
                for pl in self.slots.places_of(thing) {
                    for k in 0..pl.most() {
                        let spot = pl.spot(k);
                        let Ok(off) = pl.facing.rotate(Vec3::new(spot.x, 0, spot.z)) else {
                            continue;
                        };
                        let w = Vec3::new(pl.point.x + off.x, 0, pl.point.z + off.z);
                        left.push((d(w), thing, pl.place.slot, k, spot));
                    }
                }
            }
            left.sort_by_key(|&(d, thing, slot, k, _)| (d, thing, slot, k));
            let seated = left.first().copied().and_then(|(_, thing, slot, k, spot)| {
                let slots = std::iter::once(slot).chain(
                    self.slots
                        .places_of(thing)
                        .map(|p| p.place.slot)
                        .filter(|s| *s != slot)
                        .collect::<Vec<_>>(),
                );
                for s in slots {
                    if !self.slots.at_own_stop(thing, s, now) {
                        continue;
                    }
                    if self
                        .slots
                        .restore(
                            &mut self.runner.controller,
                            id,
                            (thing, Some(s)),
                            Some(spot),
                            sim::controller::Stance::Sit,
                            now,
                        )
                        .is_ok()
                    {
                        let same = self.slots.spot_of(id) == Some((thing, slot, k));
                        return Some((
                            thing,
                            if same {
                                "resume-seated"
                            } else {
                                "resume-seated-other"
                            },
                        ));
                    }
                }
                None
            });
            let Some(to) = self.runner.controller.body(id).map(|b| b.pose.position) else {
                continue;
            };
            match seated {
                Some((thing, how)) => self.restarted_as(id, how, thing, at, to),
                None => self.restarted_as(id, "resume-placed", floor, at, to),
            }
        }
    }

    /// What a restart did with `body`, by name `how` (`resumed`), and the entry on it the next tick writes: on `node`,
    /// from where the log had it to where it is placed or carried.
    fn restarted_as(&mut self, body: Id, how: &'static str, node: Id, from: Vec3, to: Vec3) {
        eprintln!(
            "worldd: restart: {} {how}: from ({}, {}) to ({}, {}) µm",
            replica::world_model::show(body),
            from.x,
            from.z,
            to.x,
            to.z
        );
        self.resumed.push((body, how));
        self.restarts.push((body, how, node, from, to));
    }

    /// `moved`, a body a restart places on `floor` (not yet added), moved to the nearest point of that floor at least
    /// [`RESTART_APART`] from every body standing there (`sim::slots::clear_spot`, within 5 m), so two bodies placed
    /// at one nearest point never stand in each other; left where it is when no such point is near.
    fn free_near(&self, floor: &sim::mover::Surface, moved: Moved, build: Build) -> Moved {
        let p = moved.pose;
        let taken: Vec<[i64; 2]> = self
            .runner
            .controller
            .bodies()
            .filter(|b| b.id != moved.id && b.pose.frame == p.frame)
            .map(|b| [b.pose.position.x, b.pose.position.z])
            .collect();
        let apart = |q: &[i64; 2]| {
            let (dx, dz) = (
                i128::from(q[0] - p.position.x),
                i128::from(q[1] - p.position.z),
            );
            dx * dx + dz * dz >= i128::from(RESTART_APART).pow(2)
        };
        if taken.iter().all(apart) {
            return moved;
        }
        // Never into ground sealed off from the main ground: the nearest clear point that is not.
        let open = |q: [i64; 2]| {
            let at = Vec3::new(q[0], p.position.y, q[1]);
            !sim::mover::Floors::sealed(&self.town, p.frame.node, at, build)
        };
        sim::slots::clear_spot_where(
            floor,
            [p.position.x, p.position.z],
            &taken,
            RESTART_APART,
            100_000,
            5_000_000,
            &open,
        )
        .and_then(|q| {
            floor
                .place_built(
                    moved.id,
                    p.frame,
                    Vec3::new(q[0], 0, q[1]),
                    p.orientation,
                    build,
                )
                .ok()
        })
        .unwrap_or(moved)
    }

    /// A restart's last resort for a body it cannot place again on its own ground (its floor or seat gone, no legal
    /// point on that floor, its support one no body stands on again): placed at the world's `entry`, where Souls are
    /// born, else at the ground's nearest legal point to it, named `resume-entry`, from where the log had it
    /// (`logged`). Refused only when the ground holds no point for its build.
    pub fn add_body_at_entry(
        &mut self,
        family: Family,
        id: Id,
        build: Build,
        entry: Vec3,
        logged: &Pose,
    ) -> R<()> {
        let ground = self.town.ground;
        let frame = Frame {
            node: ground,
            slot: None,
        };
        let s = self
            .town
            .surfaces_for(build.size)
            .and_then(|s| s.get(&ground))
            .ok_or_else(|| Refusal {
                name: "no-surface",
                detail: "the ground for its build".into(),
            })?;
        let moved = legal_near(&self.town, s, id, frame, entry, logged.orientation, build)?;
        let moved = self.free_near(s, moved, build);
        let to = moved.pose.position;
        self.logged.insert(id, *logged);
        self.add_body_built(family, moved, build)?;
        self.restarted_as(id, "resume-entry", ground, logged.position, to);
        Ok(())
    }

    /// Restart, after the seats are added (K18c, #3176): each body the log last had in a seat's slot is handed back
    /// into that slot (its pose's frame names the thing and the slot, C19) from where it was added, at body time `at`,
    /// and its seat is held again. A seat gone or taken leaves it
    /// standing, named in the result.
    pub fn seat_placed(&mut self, placed: &Placed, at: Micros) -> Vec<(Id, Refusal)> {
        let mut out = Vec::new();
        for (&body, (pose, stance)) in placed {
            if pose.support != Support::Slot || self.runner.controller.body(body).is_none() {
                continue;
            }
            let r = self.slots.restore(
                &mut self.runner.controller,
                body,
                (pose.frame.node, pose.frame.slot),
                Some(pose.position),
                stance.unwrap_or(Stance::Sit),
                at,
            );
            match r {
                Ok(()) => {
                    if let Some(b) = self.runner.controller.body(body) {
                        self.logged.insert(body, b.pose);
                    }
                }
                // Its seat gone or taken: it stands where it was added, its seat's stand point or the nearest legal
                // point to it (`serve`'s `recorded_body`), named `resume-stood` on the body. Logged as the log had it
                // (seated), so its next row heals the log.
                Err(e) => {
                    if let Some(b) = self.runner.controller.body(body).map(|b| b.pose) {
                        self.logged.insert(body, *pose);
                        self.restarted_as(
                            body,
                            "resume-stood",
                            b.frame.node,
                            pose.position,
                            b.position,
                        );
                    }
                    out.push((body, e));
                }
            }
        }
        out
    }

    /// Every body the controller holds, in id order: those it steps and those resting in a seat's slot (which it keeps
    /// apart), a rising one included, each with its stance when in a slot.
    fn every(&self) -> Placed {
        let c = &self.runner.controller;
        c.ids()
            .filter_map(|id| {
                let b = c.body(id)?;
                // A body carried across a link follows the link's line in the frame of the floor it set out from,
                // past that floor's edge: it is kept where it last stood until it lands, so a restart never finds it
                // off its ground. The world's own carries (a step aside, a walk-out) stay on their ground and are
                // written as they go.
                let pose = match self.logged.get(&id) {
                    Some(p) if c.carrying(id).is_some() => *p,
                    _ => b.pose,
                };
                let stance = match pose.support {
                    Support::Slot => self.slots.stance(id),
                    _ => self.sleeping.contains_key(&id).then_some(Stance::Lie),
                };
                Some((id, (pose, stance)))
            })
            .collect()
    }

    /// Where each body is now, a seated one with its stance: what a checkpoint carries (K18c, #3176).
    /// No body moving for an intent or for the wind-down, and no sit or rise waiting for its reach (O2).
    pub fn still(&self) -> bool {
        self.live.is_empty() && self.wind_moves.is_empty() && self.waiting.is_empty()
    }

    /// The earliest due time of the bodies (O2): a move's phase timers and the wind-down's next step.
    pub fn next_due(&self) -> Option<Micros> {
        [self.due.next_due(), self.wind.next()]
            .into_iter()
            .flatten()
            .min()
    }

    pub fn placed(&self) -> Placed {
        self.every()
    }

    /// The bodies whose pose changed since the last call, in id order, a body in a seat's slot with its stance: what
    /// the tick's record keeps of them (K18), so a restart stands each where it last stood or seats it again.
    pub fn moved(&mut self) -> Vec<(Id, Pose, Option<Stance>)> {
        self.moved_and_poses().0
    }

    /// [`Bodies::moved`] and [`Bodies::poses`] from one pass over the bodies: the tick's record reads both. The poses
    /// are those `poses` gives after `moved` (a carried body's is where it was last logged, which `moved` keeps).
    pub fn moved_and_poses(&mut self) -> (MovedRows, Vec<(Id, Pose)>) {
        let every = self.every();
        let mut out = Vec::new();
        let mut poses = Vec::with_capacity(every.len());
        for (id, (pose, stance)) in every {
            poses.push((id, pose));
            if !matches!(pose.support, Support::Surface { .. } | Support::Slot) {
                continue;
            }
            if self.logged.get(&id) != Some(&pose) {
                self.logged.insert(id, pose);
                out.push((id, pose, stance));
            }
        }
        (out, poses)
    }

    /// The bodies' motion to write on their nodes at this tick's end (#3799), in id order: a sample at each hand-off
    /// (a start, a stop, a turn or change of pace, a change of frame or support, a still body set somewhere new), and
    /// one at least every [`KEYFRAME_US`] of world time, in whole ticks, while a body moves. A still or seated body
    /// writes nothing. Each is compared with what its node last had from here, read from `tree` when not kept (a
    /// first tick, a restart), so a restart decides as the run it continues. A sample the world could not write is
    /// still kept as written, so it is not tried again each tick. Pose and velocity only: no intent, target
    /// or route. A body with no node in `tree` is left out.
    pub fn motion(&mut self, tree: &Tree) -> Vec<Sample> {
        let (at, tick) = (self.runner.now, self.runner.tick.max(1));
        let every = (KEYFRAME_US + tick - 1) / tick * tick;
        let c = &self.runner.controller;
        let mut ids: Vec<Id> = c.ids().collect();
        ids.sort_unstable();
        let mut out = Vec::new();
        for id in ids {
            let Some(b) = c.body(id) else { continue };
            let in_slot = b.pose.support == Support::Slot;
            if !in_slot && !matches!(b.pose.support, Support::Surface { .. }) {
                continue;
            }
            let Some(was) = self.shown.get(&id).copied().or_else(|| Shown::of(tree, id)) else {
                continue;
            };
            let linear = if in_slot { Vec3::ZERO } else { b.linear };
            let (moving, moved) = (linear != Vec3::ZERO, was.linear != Vec3::ZERO);
            let frame = b.pose.frame != was.pose.frame;
            let handoff = frame
                || b.pose.support != was.pose.support
                || moving != moved
                || (moving && turned(was.linear, linear))
                || (!moving && b.pose != was.pose);
            let keyframe = moving && at.saturating_sub(was.at) >= every;
            if !(handoff || keyframe) {
                continue;
            }
            let owner = |s: Support| {
                if s == Support::Slot {
                    Owner::Slot
                } else {
                    Owner::Mover
                }
            };
            self.shown.insert(
                id,
                Shown {
                    pose: b.pose,
                    linear,
                    at,
                    audience: was.audience,
                },
            );
            out.push(Sample {
                audience: was.audience,
                to: frame.then_some(b.pose),
                handoff: HandOff {
                    node: id,
                    at,
                    from: owner(was.pose.support),
                    to: owner(b.pose.support),
                    pose: b.pose,
                    linear,
                    angular: Vec3::ZERO,
                },
            });
        }
        out
    }

    /// Every body's pose as the controller holds it, in id order, a seated one's included (K18c), one crossing a link
    /// where it last stood ([`Bodies::placed`]): part of the zone's state hash, so a restart's state equals the last
    /// record's.
    pub fn poses(&self) -> Vec<(Id, Pose)> {
        self.every()
            .into_iter()
            .map(|(id, (p, _))| (id, p))
            .collect()
    }

    /// Body time starts at world time `now`.
    pub fn begin(&mut self, now: Micros) {
        self.runner.now = now;
        self.reseat_held(now);
    }

    /// Ask each candidate slot with its own identity. Both contacts use the stand point across x/z (C17/C19),
    /// never seat height or another slot's geometry. Availability remains authoritative at commit.
    fn reach_of(&self, pairs: Vec<(Id, Id, Id)>) -> Vec<ReachQuestion> {
        let c = &self.runner.controller;
        let mut questions = Vec::new();
        for (body, thing, order) in pairs {
            let Some(p) = c.body(body).map(|b| b.pose) else {
                continue;
            };
            let at = match (p.support, self.slots.held_place(body)) {
                (Support::Slot, Some(s)) => match s.stand() {
                    Ok(p) => p,
                    Err(_) => continue,
                },
                _ => p.position,
            };
            for s in self.slots.places_of(thing) {
                let Ok(stand) = s.stand() else { continue };
                let stand = Vec3::new(stand.x, 0, stand.z);
                questions.push(ReachQuestion {
                    body,
                    at: Vec3::new(at.x, 0, at.z),
                    thing,
                    slot: s.place.slot,
                    order,
                    points: [stand, stand],
                });
            }
        }
        questions
    }

    /// Route searches the planner ran so far, off the clock (K18b).
    pub fn searched(&self) -> u64 {
        self.planner.searched
    }

    /// Body times and batch counts where a free-running clock took fewer of the planner's batches than were out, since
    /// the last call: the recorder's `Planned` inputs (K18b).
    pub fn late(&mut self) -> Vec<(Micros, u64)> {
        std::mem::take(&mut self.late)
    }

    /// Hands a batch to the planner, counted (S8).
    fn send(&mut self, w: Wants) {
        let before = self.planner.pending();
        self.planner.send(w);
        self.sent += (self.planner.pending() - before) as u64;
    }

    /// The planner's answers taken for the next tick: those [`Bodies::schedule`] names for this body tick, else every
    /// batch out, waiting at most [`Bodies::wait`] for each; a shortfall is kept for the recorder.
    fn take(&mut self) {
        let at = self.runner.now;
        let before = self.planner.pending();
        let mut p = match self.schedule.remove(&at) {
            Some(n) => self
                .planner
                .take_n(usize::try_from(n).unwrap_or(usize::MAX)),
            None => {
                let out = self.planner.pending();
                let p = self.planner.take(self.wait);
                let left = self.planner.pending();
                if left > 0 {
                    self.late.push((at, (out - left) as u64));
                }
                p
            }
        };
        self.taken += (before - self.planner.pending()) as u64;
        // A previous map's route, line, reach or form result cannot enter any current cache.
        p.keep_map(&self.form_map);
        // A replaced move's in-flight answer cannot be used by a newer order on the same body/fixture/slot.
        p.reach.retain(|(body, thing, slot, order), _| {
            self.waiting
                .iter()
                .any(|w| w.body == *body && w.place == Some(*thing) && w.id == *order)
                || (self
                    .live
                    .get(body)
                    .is_some_and(|(id, l)| id == order && matches!(l, Live::Place(_)))
                    && self
                        .slots
                        .held_place(*body)
                        .is_some_and(|p| p.thing == *thing && p.place.slot == *slot))
        });
        self.reached.extend(p.reach.iter().map(|(k, v)| (*k, *v)));
        for (key, answer) in std::mem::take(&mut p.forms) {
            if self
                .form_answers
                .get(&key)
                .is_none_or(|old| old.generation <= answer.generation)
            {
                self.form_answers.insert(key, answer);
            }
        }
        self.planned.merge(p);
    }

    /// A walk still going, or a sit or a rise still waiting for its reach, for an earlier intent gives way to a new
    /// move: it ends `claim-taken`.
    fn replace(&mut self, body: Id) {
        if let Some(k) = self.waiting.iter().position(|w| w.body == body) {
            let w = self.waiting.remove(k);
            self.ended.push((w.id, Err("claim-taken".into())));
        }
        if let Some(&(old, Live::Walk)) = self.live.get(&body) {
            self.runner.end_order(body);
            self.live.remove(&body);
            self.walked_to.remove(&old);
            self.ended.push((old, Err("claim-taken".into())));
        }
    }

    /// A walk to point `p` of the open ground (FOR-FABLE 14, `walk x,z`): to the ground a body may stand on at that
    /// point on the plan, the open ground's or a floor's, whichever is nearest the walker's own level (a Soul on a
    /// frame's standing place sent to a point 2 m from its foot climbs down; one on a deck sent to a point on it stays
    /// up). A point in a doorway's or a stair's clearance is walked to as before (#5254: moved out to a walker's
    /// clearance, ended `walk.goal-moved`), and so is one with no ground under it within a walker's goal tolerance
    /// of ground a body stands on ([`STOPPED_SHORT_MM`]); farther, it is refused `walk.no-ground-there`, naming the
    /// nearest point the walker may stand on and reach on the spot tables' rings out to 7 m (map lookups only).
    fn ground_point(&mut self, body: Id, p: Vec3) -> R<Target> {
        let ground = self.town.ground;
        let Some(b) = self.runner.controller.body(body).cloned() else {
            return Ok(Target::new(ground, p));
        };
        if self.town.passage_at(ground, p).is_some() {
            return Ok(Target::new(ground, p));
        }
        let view = self.town.view_for(body)?;
        if let Some((node, at)) = view.level_under(&b, p) {
            return Ok(Target::new(node, at));
        }
        let near = i64::try_from(STOPPED_SHORT_MM).unwrap_or(0) * 1000;
        if view
            .standable_near(&b, p, sim::spots::REACH_PITCH, near)
            .is_some()
        {
            return Ok(Target::new(ground, p));
        }
        let (pitch, far) = (sim::spots::PITCH, sim::spots::PITCH * sim::spots::RINGS);
        let nearest = match view.standable_near(&b, p, pitch, far) {
            Some(s) => format!(
                "the nearest point to stand on: x={} z={} mm",
                s.x / 1000,
                s.z / 1000
            ),
            None => format!("no point to stand on within {} m of it", far / 1_000_000),
        };
        Err(Refusal {
            name: "walk.no-ground-there",
            detail: format!(
                "no ground to stand on at x={} z={} mm; {nearest}",
                p.x / 1000,
                p.z / 1000
            ),
        })
    }

    /// Where a walk to `node` goes: `point` in its frame; with none, the stand point of `node`'s seat; else a free
    /// standing spot in `node` (C14): its middle by E2's shared library (`replica::select`, a client's answer at the
    /// same version), for N9's table to grant the nearest free legal standing spot to, the same every run.
    fn goal(&mut self, body: Id, node: Id, point: Option<Vec3>) -> R<Target> {
        if let Some(p) = point {
            if node == self.town.ground {
                return self.ground_point(body, p);
            }
            return Ok(Target::new(node, p));
        }
        // The stand point of the free slot the world picks for `body` (C19), else of the thing's seat.
        let place = self
            .slots
            .free(&self.runner.controller, body, node)
            .and_then(|slot| self.slots.place_in(node, slot))
            .or_else(|| self.slots.place(node));
        if let Some(s) = place {
            return s.stand().map(|p| Target::new(s.floor, p));
        }
        // 0.133 Q2: a walk to another Soul's body ends beside it, at speaking distance on the walker's side (a seated
        // one: at the thing it sits in); a walk to a building ends inside it, in its main room.
        if node != body
            && let Some((frame, at)) = self.pose(node)
        {
            if self.slots.held_by(node).is_some() {
                return self.goal(body, frame, None);
            }
            let from = self.pose(body).filter(|(f, _)| *f == frame).map(|(_, p)| p);
            return Ok(Target::new(frame, beside(at, from, SPEAKING)));
        }
        // The world's root is the whole world, not somewhere in it: refused by name, never its largest room.
        let tree = &self.town.tree;
        if tree.node(tree.root()).is_some_and(|n| n.id() == node) {
            return Err(refusal("move.whole-world", node));
        }
        // A landform or another place on the ground (a range, a sea, a lake, a wood, a square, a path): a walk to it
        // ends at its edge, on the open ground, wherever the walker stands (a floor too). First on it at the point of
        // its edge nearest the walker, when its middle is ground the walker may stand on and reach: an area
        // [`select::GAP`] inside its outline, a line on itself, so a walk to a square, a wood or a path ends on it.
        // Where that is no place to stand or the walker's walk cannot reach it (a sea, a ridge), from the point stood back [`select::GAP`] outside its edge (a wide line's side) it steps back
        // toward the walker a metre at a time to the first point a body may stand on that the walker's walk may reach
        // (`View::stand_reached`, no route search): the nearest walkable point at its edge on the walker's way there.
        // A walker already within it, or with no such point nearer it, is there.
        if let Some((half, area)) = place_half_width(tree, node)
            && let Some((frame, at)) = self.pose(body)
            && let Some(ground) = tree
                .handle(node)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.parent())
        {
            let here = select::point_in(tree, frame, at, ground)?;
            let gap = select::gap(tree, node, ground, here)?;
            if gap <= half {
                return Ok(Target::new(frame, at));
            }
            let (edge, middle) = select::nearest_in(tree, node, ground, here)?;
            let (dx, dz) = (here.x - edge.x, here.z - edge.z);
            let len = (i128::from(dx).pow(2) + i128::from(dz).pow(2))
                .isqrt()
                .max(1);
            let along = |s: i128| {
                let s = s.min(len);
                let k = |d: i64| i64::try_from(i128::from(d) * s / len).unwrap_or(0);
                Vec3::new(edge.x + k(dx), 0, edge.z + k(dz))
            };
            let first = i128::from(half.saturating_add(select::GAP));
            let on = if area { -i128::from(select::GAP) } else { 0 };
            let from = (frame, at);
            // On it only when it is ground to stand on: its middle is (a square, a wood, a path), not a sea's or a
            // mountain's (its slopes may be on the map and still no way up).
            let walkable = self
                .town
                .view_for(body)?
                .stand_reached(ground, middle, from)
                .is_some();
            // First-day round 2 (0.139): a district round water (a harbour, its middle the sea between its piers) is
            // walked into by the nearest area it holds whose middle the walker may stand on and reach (its
            // boardwalk), the same way; stood back from, it ended over its border, in the park beside it. Only an
            // area within [`INNER_REACH`] of the edge the walker comes to: a river's bridge far along it is not.
            if area
                && !walkable
                && let Some(inner) =
                    inner_ground(&mut self.town, body, node, ground, here, edge, from)?
            {
                return self.goal(body, inner, None);
            }
            let view = self.town.view_for(body)?;
            let mut tries = walkable
                .then_some(on)
                .into_iter()
                .chain((0..).map(|k| first + k * 1_000_000));
            while let Some(s) = tries.next().filter(|s| *s < len) {
                if let Some(p) = view.stand_reached(ground, along(s), from) {
                    return Ok(Target::new(ground, p));
                }
            }
            // None nearer it that the walker may reach: it stands as near as it can get.
            return Ok(Target::new(frame, at));
        }
        let node = main_room(&self.town.tree, node).unwrap_or(node);
        let r = select::resolve(&self.town.tree, &Spot::Middle(node), None, &|_, _| false)?;
        match spot::once(&r) {
            spot::Spot::Stand(t) => Ok(t),
            spot::Spot::Slot { .. } => Err(refusal("move.no-point", node)),
        }
    }

    /// What the world knows of `ask` by `body`, for `replica::move_check::check`, the check a client runs (R8).
    fn seen(&self, body: Id, ask: &Ask) -> Seen {
        let t = ask.target();
        Seen {
            has: t.is_some_and(|t| {
                self.slots.place(t).is_some() || self.town.tree.handle(t).is_some()
            }),
            seated: Some(self.slots.held_by(body).is_some()),
            free: t.and_then(|t| {
                self.slots.place(t)?;
                Some(self.slots.free(&self.runner.controller, body, t).is_some())
            }),
        }
    }

    /// The candidate of `a`'s ranked list that is taken, and its rank (C14): a sit's or a lie's through I5's
    /// selector (`sim::commit::bind`, named slots: the first free one binds), a walk's the first with somewhere to go.
    fn bind(&mut self, a: &Asked) -> R<(usize, Ask)> {
        if a.fallbacks.is_empty() {
            return Ok((0, a.ask.clone()));
        }
        let list: Vec<&Ask> = std::iter::once(&a.ask).chain(&a.fallbacks).collect();
        match a.ask {
            Ask::Sit { .. } | Ask::Lie { .. } => {
                let slots: Vec<Slot> = list
                    .iter()
                    .filter_map(|k| k.target().map(Slot::Named))
                    .collect();
                let free = |t: Id| {
                    self.slots
                        .free(&self.runner.controller, a.body, t)
                        .is_some()
                };
                match bind(&slots, free, 0, true) {
                    Bound::Slot { rank, .. } => Ok((rank, list[rank].clone())),
                    Bound::Ended(n) => Err(Refusal {
                        name: n,
                        detail: format!("none of the {} free", slots.len()),
                    }),
                    Bound::Recheck { .. } => Err(refusal("place-taken", a.body)),
                }
            }
            Ask::Walk { .. } => {
                let mut last = None;
                for (rank, k) in list.iter().enumerate() {
                    if let Ask::Walk { node, point, .. } = k {
                        match self.goal(a.body, *node, *point) {
                            Ok(_) => return Ok((rank, (*k).clone())),
                            Err(r) => last = Some(r),
                        }
                    }
                }
                Err(last.unwrap_or_else(|| refusal("move.no-point", a.body)))
            }
            Ask::Rise => Ok((0, Ask::Rise)),
        }
    }

    /// How far from its target done walk `id` ended, mm, once (0.133): taken when its end is written.
    pub fn away(&mut self, id: Id) -> Option<u64> {
        self.away_of.remove(&id)
    }

    /// The walks whose target or end distance is still kept: none once every walk has ended and been written.
    pub fn walks_kept(&self) -> usize {
        self.walked_to.len() + self.away_of.len() + self.walked_again.len()
    }

    /// How far `body` stands from point `p` (µm, the frame of node `node`) on the level, mm; `None` when it stands in
    /// another frame.
    fn gap_to(&self, body: Id, node: Id, p: Vec3) -> Option<u64> {
        let (frame, at) = self.pose(body)?;
        (frame == node)
            .then(|| (i128::from(p.x - at.x).pow(2) + i128::from(p.z - at.z).pow(2)).isqrt() / 1000)
            .and_then(|mm| u64::try_from(mm).ok())
    }

    /// The gap from where `body` stands to `target`'s shape (0 inside its area), or to a body it walked to, mm; none
    /// when the two are in different frames and `target` is a body.
    fn gap_of(&self, target: Id, body: Id) -> Option<u64> {
        let (frame, at) = self.pose(body)?;
        let gap = match self.pose(target) {
            Some((f, p)) if f == frame => {
                ((i128::from(p.x - at.x).pow(2) + i128::from(p.z - at.z).pow(2)).isqrt()) as i64
            }
            Some(_) => return None,
            None => select::gap(&self.town.tree, target, frame, at).ok()?,
        };
        u64::try_from(gap / 1000).ok()
    }

    /// 0.135: a body whose walk to `target` is done turns to face it, as a person does on arriving: toward a thing's
    /// origin or another Soul's body (the thing it sits in, when seated), on the level. A walk to a place it ends in
    /// (the ground, a room, a building's main room, a point on one) turns it to what is there instead: the nearest
    /// thing standing within [`NOTABLE_NEAR`] of it ([`notable_near`]), its facing kept when there is none. A walk to a
    /// place on the ground that ends outside it (at a range's or a sea's edge) turns it to the nearest point of that
    /// place's shape, or its middle when it stands right at it. One ending
    /// within [`sim::controller::FACE_NEAR`] of what it faces keeps its facing ([`sim::controller::facing_toward`], the
    /// one rule a form's walk keeps too). The turn is its legs' facing input, set by a driver of them, as a place's
    /// facing is ([`Self::take_places`]).
    fn face(&mut self, body: Id, target: Id) {
        use sim::ground::scene::{GROUND, PLACE, ROOM};
        let Some((frame, at)) = self.pose(body) else {
            return;
        };
        let tree = &self.town.tree;
        let place = tree.handle(target).is_some_and(|h| {
            h == tree.root()
                || tree.node(h).is_some_and(|n| {
                    let kind = n.kind().as_str().split('@').next().unwrap_or_default();
                    [GROUND, PLACE, ROOM].contains(&kind)
                })
        });
        if target == body {
            return;
        }
        // A place it walked to from outside (a range, a sea): its edge, the nearest point of it, else its middle when
        // it stands on that edge.
        let edge = place_half_width(tree, target)
            .filter(|(half, _)| select::gap(tree, target, frame, at).is_ok_and(|g| g > *half))
            .and_then(|_| select::nearest_in(tree, target, frame, at).ok());
        let to = if let Some((near, middle)) = edge {
            let d = i128::from(near.x - at.x).pow(2) + i128::from(near.z - at.z).pow(2);
            Some(if d > i128::from(sim::controller::FACE_NEAR).pow(2) {
                near
            } else {
                middle
            })
        } else if place || main_room(tree, target).is_some() {
            let c = &self.runner.controller;
            notable_near(tree, frame, at, &|id| c.body(id).is_some())
        } else {
            self.toward(target, frame)
        };
        self.turn_to(body, at, to);
    }

    /// `body`, standing, turns to face `target` (another Soul's body, or a thing of `live`, the tree it acts in) as a
    /// walk's end turns it ([`Self::face`]): a form's move made toward it (`bow_to toward=<Soul>`) begins facing it. A
    /// seated or lying body keeps its facing, and so does one within [`sim::controller::FACE_NEAR`] of it or one whose
    /// legs something else drives ([`turn_free`]).
    pub(crate) fn face_to(&mut self, live: &replica::tree::Tree, body: Id, target: Id) {
        let standing = self
            .runner
            .controller
            .body(body)
            .is_some_and(|m| m.pose.frame.slot.is_none());
        let Some((frame, at)) = self.pose(body).filter(|_| standing && target != body) else {
            return;
        };
        let to = match self.pose(target) {
            Some((f, p)) if f == frame => Some(p),
            _ => self
                .toward(target, frame)
                .or_else(|| select::origin_in(live, target, frame).ok()),
        };
        if let Some(facing) = to.and_then(|to| sim::controller::facing_toward(at, to)) {
            turn_free(&mut self.runner.controller, body, facing);
        }
    }

    /// Where `target`, a thing or another Soul's body, is in `frame`'s axes, on the level: its origin, or the thing it
    /// sits in when it is seated or lying ([`Bodies::face`]).
    fn toward(&self, target: Id, frame: Id) -> Option<Vec3> {
        let tree = &self.town.tree;
        match self.pose(target) {
            Some((f, p)) if f == frame => Some(p),
            // seated or lying: the thing it is in
            Some(_) => self
                .slots
                .held_by(target)
                .and_then(|t| select::origin_in(tree, t, frame).ok()),
            None => select::origin_in(tree, target, frame).ok(),
        }
    }

    /// Turns `body`, standing at `at`, to face `to` (both in its frame's axes); nothing when there is nowhere to face or
    /// it is already on it ([`sim::controller::facing_toward`]).
    fn turn_to(&mut self, body: Id, at: Vec3, to: Option<Vec3>) {
        let Some(facing) = to.and_then(|to| sim::controller::facing_toward(at, to)) else {
            return;
        };
        let c = &mut self.runner.controller;
        if let Ok(d) = c.claim(body, &face_skill()) {
            let _ = c.set(body, d, Part::Facing(facing));
            let _ = c.release(body, d);
        }
    }

    /// The candidate intent `id` took when it started, its rank in its ranked list and its target, read once.
    pub fn took(&mut self, id: Id) -> Option<(usize, Option<Id>)> {
        self.took.remove(&id)
    }

    /// Starts one tick's moves, each for its intent, at body time: refused ones come back with their reason by name.
    /// A ranked list is bound first, the move taken is checked as a client checks it (`replica::move_check`), then
    /// started (C14). A walk starts now (its place and legs come from the planner, asked at its next body tick); a sit
    /// or a rise waits for its reach, and comes back from the first call after the planner found it (K18b).
    pub fn start(&mut self, asks: Vec<(Id, Asked)>) -> Vec<(Id, R<()>)> {
        self.start_with(asks, false)
    }

    /// The world's commit of one tick's gateway moves (step 4, after the bodies stepped): as [`Bodies::start`], and
    /// the new walks' place questions go to the planner now, with the bodies as the tick left them (#4974): the next
    /// tick reads their place and legs, so each walk is planned and its act answered a tick after it starts, not two.
    /// Moves started inside a body step (the wind-down's walks) are asked with that step's own wants already.
    pub fn start_committed(&mut self, asks: Vec<(Id, Asked)>) -> Vec<(Id, R<()>)> {
        self.start_with(asks, true)
    }

    fn start_with(&mut self, asks: Vec<(Id, Asked)>, ask_now: bool) -> Vec<(Id, R<()>)> {
        let mut out = Vec::new();
        let mut asked = Vec::new();
        let mut walked = Vec::new();
        for (id, a) in asks {
            if self.runner.controller.body(a.body).is_none() {
                out.push((id, Err(refusal("body-unknown", a.body))));
                continue;
            }
            let (rank, ask) = match self.bind(&a) {
                Ok(t) => t,
                Err(r) => {
                    out.push((id, Err(r)));
                    continue;
                }
            };
            if let Verdict::No(n) = move_check::check(&ask, &self.seen(a.body, &ask)) {
                out.push((id, Err(refusal(n, ask.target().unwrap_or(a.body)))));
                continue;
            }
            self.took.insert(id, (rank, ask.target()));
            if let (Ask::Walk { point, .. }, Some(t)) = (&ask, ask.target()) {
                self.walked_to.insert(id, (t, *point));
            }
            match ask {
                Ask::Walk { node, point, gait } => {
                    let goal = self.goal(a.body, node, point);
                    // A point on the open ground walked to on a floor above it (FOR-FABLE 14) is that floor's point:
                    // how far from it the walk ends, and its resends, are read there.
                    if let (Ok(g), Some(_)) = (&goal, point) {
                        self.walked_to.insert(id, (g.node, Some(g.point())));
                    }
                    self.replace(a.body);
                    let walk = Box::new(Route::sent(speed(gait), self.runner.tick));
                    let r = goal.and_then(|g| self.runner.send(a.body, walk, g, id));
                    if r.is_ok() {
                        self.live.insert(a.body, (id, Live::Walk));
                        walked.push((a.body, id));
                    } else {
                        self.walked_to.remove(&id);
                    }
                    out.push((id, r));
                }
                Ask::Sit { thing } => {
                    self.replace(a.body);
                    asked.push(Waiting {
                        id,
                        body: a.body,
                        place: Some(thing),
                        stance: Some(Stance::Sit),
                    });
                }
                Ask::Lie { thing } => {
                    self.replace(a.body);
                    asked.push(Waiting {
                        id,
                        body: a.body,
                        place: Some(thing),
                        stance: Some(Stance::Lie),
                    });
                }
                Ask::Rise => {
                    self.replace(a.body);
                    let place = self.slots.held_by(a.body);
                    asked.push(Waiting {
                        id,
                        body: a.body,
                        place,
                        stance: None,
                    });
                }
            }
        }
        // The asks waiting from earlier ticks whose reach is back are committed; the new asks' reach goes to the
        // planner, for a later tick.
        out.extend(self.commit_waiting());
        let pairs: Vec<(Id, Id, Id)> = asked
            .iter()
            .filter_map(|w| Some((w.body, w.place?, w.id)))
            .collect();
        self.reached
            .retain(|(body, _, _, _), _| !asked.iter().any(|w| w.body == *body));
        // Committed by the world's step 4, the new walks' place questions go with them, now (#4974).
        let mut wants = if ask_now {
            self.runner.ask_places(&walked, self.sent)
        } else {
            Wants::default()
        };
        if !pairs.is_empty() || !wants.places.is_empty() {
            if wants.places.is_empty() {
                wants.classes = self.town.body_classes.clone();
            }
            if !pairs.is_empty() {
                wants.reach = self.reach_of(pairs);
            }
            wants.form_map = Some(Arc::clone(&self.form_map));
            self.send(wants);
        }
        self.waiting.extend(asked);
        out
    }

    /// Commits the sits and rises whose reach the planner has found since they were asked: the rises in the order
    /// asked, then the sits together in B3's stable order.
    fn commit_waiting(&mut self) -> Vec<(Id, R<()>)> {
        let now = self.runner.now;
        let mut out = Vec::new();
        let (ready, still): (Vec<Waiting>, Vec<Waiting>) = std::mem::take(&mut self.waiting)
            .into_iter()
            // Ready: its reach is back, or there is none to ask (no such seat or body: B3 refuses it by name).
            .partition(|w| {
                w.place.is_none_or(|t| {
                    self.slots
                        .places_of(t)
                        .filter(|p| p.stand().is_ok())
                        .all(|p| self.reached.contains_key(&(w.body, t, p.place.slot, w.id)))
                        || self.reach_of(vec![(w.body, t, w.id)]).is_empty()
                })
            });
        self.waiting = still;
        let mut sits = Vec::new();
        for w in ready {
            if let (Some(stance), Some(thing)) = (w.stance, w.place) {
                sits.push((w.id, w.body, thing, stance));
                continue;
            }
            let reach = Reached {
                cache: &self.reached,
                order: Some(w.id),
                slot: self.slots.held_place(w.body).map(|p| p.place.slot),
            };
            let r = self.slots.rise(
                &mut self.runner.controller,
                &mut self.due,
                &mut self.mint,
                &mut self.moves,
                &reach,
                w.body,
                &self.rise,
                now,
            );
            out.push((w.id, self.started(w.id, w.body, r)));
        }
        // Preserve C19's stable request order and nearest currently free slot; each distance is keyed to that slot.
        sits.sort_by_key(|s| (s.1, s.2));
        for (id, body, thing, stance) in sits {
            // A slot whose cabin is away from its own stop is not free now (N14).
            let slots = &self.slots;
            let slot = slots.free_unless(&self.runner.controller, body, thing, &|s| {
                !slots.at_own_stop(thing, s, now)
            });
            let reach = Reached {
                cache: &self.reached,
                order: Some(id),
                slot,
            };
            let request = Request {
                body,
                thing,
                slot,
                mv: if stance == Stance::Lie {
                    &self.lie
                } else {
                    &self.sit
                },
                stance,
            };
            let r = self
                .slots
                .commit(
                    &mut self.runner.controller,
                    &mut self.due,
                    &mut self.mint,
                    &mut self.moves,
                    &reach,
                    &self.town,
                    &[request],
                    now,
                )
                .pop()
                .map_or_else(|| Err(refusal("place-unknown", thing)), |(_, r)| r);
            out.push((id, self.started(id, body, r)));
        }
        out
    }

    fn started(&mut self, id: Id, body: Id, r: R<Instance>) -> R<()> {
        let n = r?;
        self.live.insert(body, (id, Live::Place(n)));
        Ok(())
    }

    /// Whether act `act`'s sit, lie or rise move is under way (#5019 follow-up: its act is answered accepted then).
    pub fn placing(&self, act: Id) -> bool {
        self.live
            .values()
            .any(|(id, l)| *id == act && matches!(l, Live::Place(_)))
    }

    /// Steps the bodies to world time `now`, a tick at a time, firing each move's phase timers as they fall due.
    /// Returns the intents whose moves ended: done, or the reason by name.
    pub fn step(&mut self, now: Micros) -> Vec<(Id, Result<(), String>)> {
        let mut out = std::mem::take(&mut self.ended);
        // What the restart did with each body it could not leave where the log had it: written with the first tick.
        let at = self.runner.now;
        for (body, how, node, from, to) in std::mem::take(&mut self.restarts) {
            self.wind_log
                .push(crate::unstick::restarted(at, body, how, node, from, to));
        }
        while self.runner.now + self.runner.tick <= now {
            // The planner's answers to the last tick's wants (K18b): this tick reads them.
            self.take();
            // The tick's order (K18, #3160): due timers first, at the tick's start, then the skills through the
            // host and the controller.
            let at = self.runner.now;
            while let Some(t) = self.due.fire(at + 1) {
                let reach = Reached {
                    cache: &self.reached,
                    order: self.live.get(&t.node).map(|(id, _)| *id),
                    slot: self.slots.held_place(t.node).map(|p| p.place.slot),
                };
                let fired = self.slots.fire(
                    &mut self.runner.controller,
                    &mut self.due,
                    &mut self.mint,
                    &mut self.moves,
                    &reach,
                    &self.town,
                    &t,
                );
                let Some(&(id, Live::Place(n))) = self.live.get(&t.node) else {
                    continue;
                };
                if self.moves.record(n).is_some() {
                    continue;
                }
                let how = match &fired {
                    Some((Fired::Done(r) | Fired::Cancelled(r), _)) => r
                        .ended
                        .as_ref()
                        .map_or("cancelled".into(), |e| e.how.as_str().to_owned()),
                    Some((_, Some(Err(r)))) => r.name.to_owned(),
                    _ => "cancelled".into(),
                };
                self.live.remove(&t.node);
                out.push((id, if how == "done" { Ok(()) } else { Err(how) }));
            }
            // A refusal of one body's input is the controller's and leaves the others going; its walk ends by name.
            // A skill that panics is ended by K11's wrapper in the runner (`unit-panicked`); the tick goes on.
            let order_lines = crate::orders::step(self, at);
            self.wind_step(at);
            let mut planned = std::mem::take(&mut self.planned);
            planned.batches = Some(Batches {
                taken: self.taken,
                next: self.sent,
            });
            self.unstuck.planned(&self.runner, &planned);
            let (mut wants, _) = self.runner.tick_planned(&mut self.town, &planned);
            // A queue's approach whose straight way was not clear asks the same planner batch for its line (B7c), and
            // as a walker's, asks again only once the batch it went in has been taken without it (S8).
            if let Some(batch) = planned.batches {
                let out = &mut self.order_out;
                out.retain(|_, (_, sent)| *sent >= batch.taken);
                wants
                    .lines
                    .extend(order_lines.into_iter().filter(|(body, to)| {
                        if out.get(&body.id).is_some_and(|(t, _)| t == to) {
                            return false;
                        }
                        out.insert(body.id, (*to, batch.next));
                        true
                    }));
            }
            // The never-stuck ladder (0.133 N1): walk-outs, then each walker's rungs; its records are the world's.
            let rungs = self.unstuck.after(&mut self.runner, &mut self.town);
            self.wind_log.extend(rungs);
            // Every body in a seat move, with its seat: its reach for the next tick's phase timers.
            let mut seated: Vec<(Id, Id, Id)> = self
                .live
                .iter()
                .filter(|(_, (_, l))| matches!(l, Live::Place(_)))
                .filter_map(|(b, (id, _))| Some((*b, self.slots.held_by(*b)?, *id)))
                .collect();
            // A discarded obsolete reach is asked again for the same still-waiting move and exact slot.
            seated.extend(
                self.waiting
                    .iter()
                    .filter_map(|w| Some((w.body, w.place?, w.id))),
            );
            wants.reach = self.reach_of(seated);
            // One metadata snapshot per map revision, shared by all form questions in the batch.
            if *self.form_map != self.town.versions {
                self.form_map = Arc::new(self.town.versions.clone());
                self.form_answers.clear();
            }
            wants.form_map = Some(Arc::clone(&self.form_map));
            wants.forms = fresh_forms(
                &mut self.forms_out,
                std::mem::take(&mut self.form_questions),
                &self.form_answers,
                self.taken,
                self.sent,
            );
            debug_assert_eq!(planned.batches.map(|b| b.next), Some(self.sent));
            self.send(wants);
            // Who hears each utterance the step started, as the bodies stand after it (B11, #3369): every body in the
            // zone, a seated or lying one included (#3393).
            let said = std::mem::take(&mut self.runner.said);
            let c = &self.runner.controller;
            let ids: Vec<Id> = c.ids().collect();
            let at = self.runner.now;
            for (speaker, s) in speech::heard(&mut self.hearing, c.near(), ids, &said) {
                self.heard.push((speaker, s, at));
            }
            let walks: Vec<(Id, Id)> = self
                .live
                .iter()
                .filter(|(_, (_, l))| matches!(l, Live::Walk))
                .map(|(b, (id, _))| (*b, *id))
                .collect();
            for (body, id) in walks {
                let how = match self.runner.ended.get(&body) {
                    Some((_, Progress::Done)) => {
                        // As near as the crowd allows (A2-4): named in the walk's `done`, then taken off the body.
                        if self
                            .runner
                            .fields
                            .get_mut(&body)
                            .and_then(|f| f.remove(&replica::host::F_SHORT))
                            .is_some()
                        {
                            self.short.insert(id);
                        }
                        Ok(())
                    }
                    // A walk whose legs a newer claim took (its Soul's bow or dance: the controller cancels the walk's
                    // driver) is replaced, and says so as [`Self::replace`] does (#4171), not `resource-not-held`.
                    Some((_, Progress::Failed(n))) if n.as_str() == "resource-not-held" => {
                        Err("claim-taken".to_owned())
                    }
                    Some((_, Progress::Failed(n))) => Err(n.as_str().to_owned()),
                    Some((_, Progress::Going)) => continue,
                    None if self.runner.running(body) => continue,
                    None => Err("claim-taken".to_owned()),
                };
                // #5254: a walk to a point that ended short of it is sent again while bodies may be moving off its way,
                // [`WALK_AGAIN`] times (some three seconds); then it answers how far short it stopped, and why.
                // #5254: one that came to the place it was granted off the point it was sent to is done there and says
                // so (`goal_moved`): that point in a doorway's or a stair's clearance, moved out to [`sim::spots::CLEAR`]
                // off the passage (A3), however far that is; or off its ground, nearer than a walker's goal tolerance.
                if how.is_ok()
                    && !self.short.contains(&id)
                    && let Some(&(t, Some(p))) = self.walked_to.get(&id)
                    && let Some(g) = self.runner.granted.get(&body).copied()
                    && let (Some(asked), Some(there)) =
                        (self.gap_to(body, t, p), self.gap_to(body, t, g))
                    && asked > 50
                    && there <= 50
                {
                    match self.town.passage_at(t, p) {
                        Some(why) => {
                            self.goal_moved.insert(id, (asked, Some(why)));
                        }
                        None if asked <= STOPPED_SHORT_MM => {
                            self.goal_moved.insert(id, (asked, None));
                        }
                        None => {}
                    }
                }
                if how.is_ok()
                    && !self.goal_moved.contains_key(&id)
                    && let Some(&(t, Some(p))) = self.walked_to.get(&id)
                    && let Some(mm) = self.gap_to(body, t, p).filter(|mm| *mm > STOPPED_SHORT_MM)
                {
                    let crowd = self.short.contains(&id);
                    let n = self.walked_again.get(&id).copied().unwrap_or(0);
                    // Sent again half a second after it stopped, so bodies in its way have time to move off.
                    let since = self
                        .runner
                        .ended
                        .get(&body)
                        .map_or(Micros::MAX, |(at, _)| self.runner.now.saturating_sub(*at));
                    if n < WALK_AGAIN && since < WALK_AGAIN_AFTER {
                        continue;
                    }
                    if n < WALK_AGAIN {
                        self.walked_again.insert(id, n + 1);
                        let goal = self.goal(body, t, Some(p));
                        let walk = Box::new(Route::sent(WALK, self.runner.tick));
                        if goal
                            .and_then(|g| self.runner.send(body, walk, g, id))
                            .is_ok()
                        {
                            self.short.remove(&id);
                            continue;
                        }
                    }
                    self.stopped_short.insert(id, (mm, crowd));
                }
                self.walked_again.remove(&id);
                self.live.remove(&body);
                // 0.133: its target goes however it ended; a done walk keeps how far from it it ended, for its end,
                // and ends facing it (0.135)
                if let Some((t, point)) = self.walked_to.remove(&id).filter(|_| how.is_ok()) {
                    // From the point it was sent to (a grip's place on the ground), not from the ground node it named; a walk
                    // that ended in another frame (overflowed from a floor onto the open ground) as before.
                    let gap = point
                        .and_then(|p| self.gap_to(body, t, p))
                        .or_else(|| self.gap_of(t, body));
                    if let Some(mm) = gap {
                        self.away_of.insert(id, mm);
                    }
                    self.face(body, t);
                }
                out.push((id, how));
            }
        }
        // A walk sent again that was then replaced, cancelled or retired keeps no count (review of #5268).
        let live: BTreeSet<Id> = self.live.values().map(|(id, _)| *id).collect();
        self.walked_again.retain(|id, _| live.contains(id));
        out
    }

    /// The moves that ended between steps (a walk replaced by a new move, `claim-taken`), taken now, so the world
    /// writes each ending in the tick its walk stopped.
    pub fn replaced(&mut self) -> Vec<(Id, Result<(), String>)> {
        std::mem::take(&mut self.ended)
    }

    /// The only way is blocked (0.132 A2-3, Gene's decision: no Soul is left stuck): walker `walker`'s walk stalled,
    /// and each still body on its line within [`sim::unstick::NEAR`] of it (no walk, no move, no seat, no order to stay,
    /// not carried) is stepped aside by the world, by the smallest step that clears the line to the corner it aims at
    /// (`sim::unstick::aside`), at walking speed in a straight line. Returns each body stepped aside, from where to
    /// where; none when nothing could be.
    pub fn make_way(&mut self, walker: Id) -> Vec<(Id, Vec3, Vec3)> {
        let Some(me) = self.runner.controller.body(walker).copied() else {
            return Vec::new();
        };
        let node = sim::walk::node_of(&me);
        let Some((_, aim, _)) = self
            .town
            .next_corner_toward(walker)
            .filter(|(n, _, _)| *n == node)
        else {
            return Vec::new();
        };
        let here = me.pose.position;
        let line = (here, Vec3::new(aim[0], here.y, aim[1]));
        let c = &self.runner.controller;
        let still: Vec<(Id, Vec3)> = c
            .bodies()
            .filter(|b| {
                b.id != walker
                    && sim::walk::node_of(b) == node
                    && b.pose.support != Support::Slot
                    && !self.runner.running(b.id)
                    && !self.runner.staying.contains(&b.id)
                    && !c.carried(b.id)
                    && !self.live.contains_key(&b.id)
                    && self.slots.held_by(b.id).is_none()
                    && c.claims(b.id).is_some_and(|k| k.running().is_empty())
            })
            .map(|b| (b.id, b.pose.position))
            .filter(|(_, at)| {
                let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
                (d(at.x, here.x) + d(at.z, here.z)).isqrt() < i128::from(sim::unstick::NEAR)
            })
            .collect();
        let mut moved: Vec<(Id, Vec3, Vec3)> = Vec::new();
        for (s, from) in still {
            let taken: Vec<Vec3> = self
                .runner
                .controller
                .bodies()
                .filter(|b| b.id != s && sim::walk::node_of(b) == node)
                .map(|b| b.pose.position)
                .chain(moved.iter().map(|&(_, _, to)| to))
                .collect();
            let Some(to) = sim::unstick::aside(&self.town, node, from, line, &taken) else {
                continue;
            };
            let track = sim::controller::Track {
                link: None,
                line: vec![to],
                speed: WALK,
                to: node,
                arrive: None,
                hold: false,
            };
            if self.runner.controller.carry(s, track).is_ok() {
                moved.push((s, from, to));
            }
        }
        moved
    }

    /// The move `body` is making of its own (a walk, or a walk to its place), by its intent, if any.
    pub fn moving(&self, body: Id) -> Option<Id> {
        self.live.get(&body).map(|(id, _)| *id)
    }

    /// Intent `id` ended (its deadline passed): its walk stops where the body is, now ([`Cut::Stopped`]). A sit, a lie
    /// or a rise is short and runs to its end, so a seat is never left half taken ([`Cut::Finishing`]): the world
    /// ends the act when its move ends. `None`: no move is going for it.
    pub fn cancel(&mut self, id: Id) -> Option<Cut> {
        self.waiting.retain(|w| w.id != id);
        let (&body, &(_, live)) = self.live.iter().find(|(_, (i, _))| *i == id)?;
        if !matches!(live, Live::Walk) {
            return Some(Cut::Finishing);
        }
        self.runner.end_order(body);
        self.live.remove(&body);
        self.walked_to.remove(&id);
        Some(Cut::Stopped)
    }

    /// Births into this world's controller (K10, C3 #3367): the births `life` takes at world time `now`, each body
    /// posed at a standing place of `standing` the town's ground holds.
    pub fn births(
        &mut self,
        life: &mut Life,
        now: Micros,
        standing: &impl Standing,
        family: &Family,
    ) -> Vec<Born> {
        let born = life.tick(now, &mut self.runner, &self.town.surfaces, standing, family);
        for b in &born {
            self.wind.add(b.body, now);
        }
        born
    }

    pub fn births_built(
        &mut self,
        life: &mut Life,
        now: Micros,
        standing: &impl Standing,
        family: &Family,
        build_of: &impl Fn(Id) -> Build,
    ) -> Vec<Born> {
        let born = life.tick_built(
            now,
            &mut self.runner,
            &self.town,
            standing,
            family,
            build_of,
        );
        for b in &born {
            self.town.set_class(b.body, build_of(b.soul).size);
        }
        born
    }

    /// Retires `soul`'s body by K10's one path at world time `at` ([`Life::retire`]): its seat freed, its timers and
    /// its run ended, the body out of the controller; and the intent it was moving for, if any, which then ends.
    pub fn retire(&mut self, life: &mut Life, soul: Id, at: Micros) -> R<(Retired, Option<Id>)> {
        let r = life.retire(
            soul,
            at,
            &mut self.runner,
            &mut self.slots,
            &mut self.moves,
            &mut self.due,
        )?;
        let open = self.live.remove(&r.body).map(|(intent, _)| intent);
        if let Some(i) = open {
            self.walked_to.remove(&i);
            self.away_of.remove(&i);
        }
        self.logged.remove(&r.body);
        self.shown.remove(&r.body);
        self.wind.remove(r.body);
        self.wind_moves.remove(&r.body);
        self.sleeping.remove(&r.body);
        self.place_moves.retain(|(_, b), _| *b != r.body);
        Ok((r, open))
    }
}

/// `id` placed on `floor` at `at`, else at the floor's nearest legal point to it by the walk-out's rule
/// (`sim::ground::exits::nearest`): a point it may stand on, placed there at once (a restart, not a move), or
/// `off-surface` when the floor holds none for its build. Never ground sealed off from the main ground (`floors`'
/// [`sim::mover::Floors::sealed`]: a pocket no walk from outside reaches), so a restart never shuts a body in.
pub fn legal_near(
    floors: &dyn sim::mover::Floors,
    floor: &sim::mover::Surface,
    id: Id,
    frame: Frame,
    at: Vec3,
    facing: Quat,
    build: Build,
) -> R<Moved> {
    let sealed = |p: Vec3| floors.sealed(frame.node, p, build);
    if !sealed(at)
        && let Ok(b) = floor.place_built(id, frame, at, facing, build)
    {
        return Ok(b);
    }
    let (_, to) = sim::ground::exits::nearest_where(floor.pieces(), at, &|p| !sealed(p))
        .ok_or_else(|| Refusal {
            name: "off-surface",
            detail: format!("({}, {}) µm: no legal point on its floor", at.x, at.z),
        })?;
    floor.place_built(id, frame, to, facing, build)
}

/// The wind-down's view of the world (B16, #2751): the bodies as the controller holds them and the open ground.
struct WindGround<'a> {
    b: &'a Bodies,
}

/// How near another body a spot may be, µm: room to stand, and room to lie down.
const ROOM: i64 = 800_000;
/// How far apart a restart places two bodies, µm: two bodies' width (`sim::slots::clear_spot`'s apart for a rise).
const RESTART_APART: i64 = 560_000;
const ROOM_LYING: i64 = 1_500_000;

impl Ground for WindGround<'_> {
    fn at(&self, body: Id) -> Option<[i64; 2]> {
        let p = self.b.runner.controller.body(body)?.pose;
        if !matches!(p.support, Support::Surface { .. }) || p.frame.slot.is_some() {
            return None;
        }
        if p.frame.node == self.b.town.ground {
            return Some([p.position.x, p.position.z]);
        }
        // On a building's floor: where that is on the open ground.
        let place = self
            .b
            .town
            .buildings
            .iter()
            .find(|bl| bl.floors.contains_key(&p.frame.node))?
            .place;
        let q = place.point(p.position).ok()?;
        Some([q.x, q.z])
    }

    fn held(&self, body: Id) -> bool {
        let c = &self.b.runner.controller;
        self.b.orders.open(body).is_some()
            || self.b.waiting.iter().any(|w| w.body == body)
            || self
                .b
                .live
                .get(&body)
                .is_some_and(|(id, _)| self.b.wind_moves.get(&body) != Some(id))
            || c.carried(body)
            || c.carrying(body).is_some()
    }

    fn walking(&self, body: Id) -> bool {
        self.b.wind_moves.get(&body).is_some_and(|id| {
            self.b
                .live
                .get(&body)
                .is_some_and(|(i, l)| i == id && matches!(l, Live::Walk))
        })
    }

    fn aboard(&self, body: Id) -> bool {
        self.b.runner.controller.body(body).is_some_and(|m| {
            matches!(
                m.pose.support,
                Support::Track | Support::Volume { .. } | Support::None
            )
        })
    }

    fn clear(&self, p: [i64; 2], lying: bool) -> bool {
        let room = if lying { ROOM_LYING } else { ROOM };
        self.outdoors(p)
            && self.b.runner.controller.bodies().all(|m| {
                let q = m.pose.position;
                m.pose.frame.node != self.b.town.ground
                    || (i128::from(q.x - p[0])).pow(2) + (i128::from(q.z - p[1])).pow(2)
                        >= i128::from(room).pow(2)
            })
    }

    fn outdoors(&self, p: [i64; 2]) -> bool {
        let ground = self.b.town.ground;
        self.b.town.surfaces.get(&ground).is_some_and(|s| {
            let frame = Frame {
                node: ground,
                slot: None,
            };
            s.place(
                ground,
                frame,
                Vec3::new(p[0], 0, p[1]),
                replica::pose::Quat::IDENTITY,
            )
            .is_ok()
        })
    }

    fn centre(&self) -> [i64; 2] {
        let mut n = 0i128;
        let (mut x, mut z) = (0i128, 0i128);
        for bl in &self.b.town.buildings {
            x += i128::from(bl.place.pos.x);
            z += i128::from(bl.place.pos.z);
            n += 1;
        }
        if n == 0 {
            return [0, 0];
        }
        [
            i64::try_from(x / n).unwrap_or(0),
            i64::try_from(z / n).unwrap_or(0),
        ]
    }
}

fn asleep_shape() -> SkillShape {
    SkillShape {
        name: Name::new("souls:asleep").unwrap_or_else(|| unreachable!("a literal name")),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: vec![],
        cancelled_by: vec![],
    }
}

impl Bodies {
    /// The wind-down's moves due at body time `at` (B16): each through the moves every intent takes (a rise, N7's
    /// walk to a point on the open ground), or a lie where the body stands; each written as the world's record.
    /// Nothing is read when nothing is due: a sleeping body costs no tick time.
    fn wind_step(&mut self, at: Micros) {
        if self.wind.next().is_none_or(|t| t > at) {
            return;
        }
        let mut wind = std::mem::take(&mut self.wind);
        let orders = wind.step(at, &WindGround { b: self });
        self.wind = wind;
        for o in orders {
            self.wind_do(&o, at);
        }
    }

    fn wind_do(&mut self, o: &Order, at: Micros) {
        let body = o.body;
        for d in &o.what {
            match *d {
                Do::Stop => {
                    if let Some(id) = self.wind_moves.remove(&body) {
                        self.cancel(id);
                    }
                }
                Do::Stand => {
                    self.wake_ground(body);
                    if self.slots.held_by(body).is_some() {
                        self.wind_move(body, Ask::Rise);
                    }
                }
                Do::Walk([x, z]) => {
                    let node = self.town.ground;
                    self.wind_move(
                        body,
                        Ask::Walk {
                            node,
                            point: Some(Vec3::new(x, 0, z)),
                            gait: None,
                        },
                    );
                }
                Do::Lie => self.lie_ground(body),
            }
        }
        if let Some(s) = self.wind.state(body) {
            let e = wind_down::record(o, s, at, 0);
            self.wind_log.push(e);
        }
    }

    /// A walk the world starts for `body` to `to` on `node`, in its axes, under `id` (0.135 G3): N7's walk as an
    /// intent's, but nothing else is committed with it, so no other body's waiting sit, lie or rise result is taken or
    /// lost (that is [`Bodies::start`]'s, with its answers).
    fn walk_own(&mut self, body: Id, node: Id, to: Vec3, id: Id) -> R<()> {
        let goal = self.goal(body, node, Some(Vec3::new(to.x, 0, to.z)));
        self.replace(body);
        let walk = Box::new(Route::sent(WALK, self.runner.tick));
        let r = goal.and_then(|g| self.runner.send(body, walk, g, id));
        if r.is_ok() {
            self.live.insert(body, (id, Live::Walk));
        }
        r
    }

    /// Members taking their places (0.135 G3, `sim::activity::places`): `(activity, body, Soul, node, place,
    /// facing)`, the place in `node`'s axes. Each walks there by the path every walk intent takes
    /// ([`Bodies::start`]), as its Soul's own, then turns to its facing; one already within 5 cm only turns. The
    /// place is a target, never a constraint: a walk that ends short, or cannot start, still ends the taking, and a
    /// seated member, or one no longer on `node`, is placed where it is. A walk to a place no longer in `todo` (its
    /// member left) ends. Returns the members that have taken their places, by (activity, body).
    pub fn take_places(&mut self, todo: &[(Id, Id, Id, Id, Vec3, Quat)]) -> Vec<(Id, Id)> {
        let gone: Vec<((Id, Id), Id)> = self
            .place_moves
            .iter()
            .filter(|((a, b), _)| !todo.iter().any(|t| (t.0, t.1) == (*a, *b)))
            .map(|(k, id)| (*k, *id))
            .collect();
        for ((a, body), id) in gone {
            self.place_moves.remove(&(a, body));
            if self.live.get(&body).is_some_and(|(i, _)| *i == id) {
                self.runner.end_order(body);
                self.live.remove(&body);
            }
        }
        let mut done = Vec::new();
        for &(activity, body, _, node, to, facing) in todo {
            let Some(m) = self.runner.controller.body(body) else {
                done.push((activity, body));
                continue;
            };
            if m.pose.frame.slot.is_some() || sim::index::place_of(m).0 != node {
                done.push((activity, body));
                continue;
            }
            let at = m.pose.position;
            let (dx, dz) = (i128::from(at.x - to.x), i128::from(at.z - to.z));
            // Within a granted spot's reach of it (`AT_SPOT`, where any walk to it ends): a member farther walks, so
            // two members end at most twice that off the distance their places keep (0.134 item 5).
            let near = dx * dx + dz * dz <= i128::from(skills::route::AT_SPOT).pow(2);
            if let Some(&id) = self.place_moves.get(&(activity, body)) {
                let moving = self.live.get(&body).is_some_and(|(i, _)| *i == id)
                    || self.waiting.iter().any(|w| w.id == id);
                if moving {
                    continue;
                }
                self.place_moves.remove(&(activity, body));
            } else if !near
                && let Ok(id) = self.mint.mint()
                && self.walk_own(body, node, to, id).is_ok()
            {
                self.place_moves.insert((activity, body), id);
                continue;
            }
            // Arrived (or the walk could not start): turn to the place's facing, by a driver of its legs.
            let c = &mut self.runner.controller;
            let turn = SkillShape {
                name: Name::new("souls:take-place").unwrap_or_else(|| unreachable!("a name")),
                claims: vec![Want::All(Class::Locomotion)],
                blocks: Vec::new(),
                cancelled_by: Vec::new(),
            };
            if let Ok(d) = c.claim(body, &turn) {
                let _ = c.set(body, d, Part::Facing(facing));
                let _ = c.release(body, d);
                self.logged.remove(&body);
            }
            done.push((activity, body));
        }
        done
    }

    /// One move of the rule's, by the path every move intent takes ([`Bodies::start`]), under a fresh id.
    fn wind_move(&mut self, body: Id, ask: Ask) {
        let Ok(id) = self.mint.mint() else { return };
        let started = self.start(vec![(
            id,
            Asked {
                body,
                actor: Actor::World,
                ask,
                fallbacks: Vec::new(),
            },
        )]);
        if started.iter().all(|(_, r)| r.is_ok()) {
            self.wind_moves.insert(body, id);
        }
    }

    /// The body lies down where it stands on the ground and is held lying, with no end.
    fn lie_ground(&mut self, body: Id) {
        if self.sleeping.contains_key(&body) || self.slots.held_by(body).is_some() {
            return;
        }
        let c = &mut self.runner.controller;
        if let Ok(d) = c.claim(body, &asleep_shape()) {
            if c.set(body, d, Part::Stance(Stance::Lie)).is_ok() {
                self.sleeping.insert(body, d);
                // Its row carries the lying stance from this tick.
                self.logged.remove(&body);
            } else {
                let _ = c.release(body, d);
            }
        }
    }

    /// A body the rule held lying stands where it is.
    fn wake_ground(&mut self, body: Id) {
        if let Some(d) = self.sleeping.remove(&body) {
            let _ = self.runner.controller.release(body, d);
            self.logged.remove(&body);
        }
    }

    /// Its agent acted at `now` (B16 A2): a body the rule held is let go on this tick, its walk stopped where it is and
    /// its lie ended, so the act runs; the world writes that it woke.
    pub fn agent_acted(&mut self, body: Id, now: Micros) {
        if self.wind.acted(body, now).is_none() {
            return;
        }
        if let Some(id) = self.wind_moves.remove(&body) {
            self.cancel(id);
        }
        self.wake_ground(body);
        if let Some(s) = self.wind.state(body) {
            let o = Order {
                body,
                phase: Phase::Woken,
                what: Vec::new(),
            };
            self.wind_log.push(wind_down::record(&o, s, now, 0));
        }
    }

    /// Restart (B16): the rule rebuilt from the records and agent acts replayed (`body_of` names a Soul's body), every
    /// body in the controller; a body asleep lies down again where it was.
    /// A body `placed` has lying on the ground (only the rule lays one there) with no record since the checkpoint is
    /// asleep.
    pub fn wind_resume<'a>(
        &mut self,
        effects: impl IntoIterator<Item = &'a Effect>,
        body_of: impl Fn(Id) -> Option<Id>,
        placed: &Placed,
        now: Micros,
        since: Micros,
        born: &BTreeMap<Id, Micros>,
    ) {
        let ids: Vec<Id> = self.runner.controller.ids().collect();
        self.wind
            .resume_since(effects, body_of, ids.iter().copied(), now, since, born);
        for (body, (pose, stance)) in placed {
            if *stance == Some(Stance::Lie)
                && matches!(pose.support, Support::Surface { .. })
                && self.wind.state(*body).is_some_and(|s| s.wander.is_none())
            {
                self.wind
                    .asleep(*body, [pose.position.x, pose.position.z], now);
            }
        }
        for body in ids {
            if self.wind.state(body).is_some_and(|s| s.slept) {
                self.lie_ground(body);
            }
        }
    }
}

/// What ending an intent did to its move ([`Bodies::cancel`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cut {
    /// Its walk stopped where the body stands.
    Stopped,
    /// Its sit, lie or rise runs to its end, a few seconds at most.
    Finishing,
}

fn refusal(name: &'static str, node: Id) -> Refusal {
    Refusal {
        name,
        detail: replica::world_model::show(node),
    }
}

/// The form questions to send in batch `next` (S8): one question per cursor out at the planner at a time. While one
/// is out (sent in a batch at or after `taken`), the cursor's question is not sent, whatever its generation: a body
/// nudged while it waits asks a new generation every tick, and each would be a full search. Once that batch has been
/// taken, the cursor's current question goes (its form queues it each tick until answered); a stale generation's
/// answer is refused where it is read (`Planning::receive`). A question whose answer of the same generation has come
/// back and waits in `answered` for its form to read it (later in the tick: the form's queue is last tick's) is not
/// sent again either.
pub(crate) fn fresh_forms(
    out: &mut BTreeMap<FormKey, (u64, u64)>,
    questions: BTreeMap<FormKey, FormQuestion>,
    answered: &BTreeMap<FormKey, FormAnswer>,
    taken: u64,
    next: u64,
) -> Vec<FormQuestion> {
    out.retain(|_, (_, sent)| *sent >= taken);
    questions
        .into_values()
        .filter(|q| {
            if out.contains_key(&q.key)
                || answered
                    .get(&q.key)
                    .is_some_and(|a| a.generation == q.generation)
            {
                return false;
            }
            out.insert(q.key, (q.generation, next));
            true
        })
        .collect()
}

#[cfg(test)]
mod map_tests {
    use super::*;
    use replica::apply::Replica;
    use replica::edit::{Edit, Op, Ref};
    use replica::effects::{
        Actor, Body as EffectBody, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest,
    };
    use replica::encode::encode;
    use replica::world_model::Audience;

    #[test]
    fn k18d_actual_live_edit_and_town_install_refuse_atomically() {
        let mut imported = import_eden::load(&testworld::generate(1, 0).unwrap().text).unwrap();
        imported.rules.kinds.extend(
            replica::world_model::parse_kinds(&format!(
                "{{1: \"souls:place\", 2: \"place\", 11: [\"{}\"]}}",
                import_eden::GROUND,
            ))
            .unwrap(),
        );
        let root = imported.nodes["world"];
        let ground = imported.nodes["ground"];
        let floor = imported.nodes["building/floor-0"];
        let door = imported.nodes["door-building-narrow"];
        let rules = imported.rules;
        let header = import_eden::header(root, &rules).unwrap();
        let version = imported.tree.next();
        let mut live = Replica::restored(header.clone(), imported.tree, version);
        let town = Town::new(
            live.tree().frozen(),
            ground,
            sim::links::Doors::new(header, rules.clone(), version),
        )
        .unwrap();
        let mut bodies = Bodies::new(town, 50_000).unwrap();
        let creator = Id::new(Scope([0x95; 16]), 1).unwrap();
        let world = replica::edit::World {
            creator,
            kinds: rules.kinds,
        };
        let edit = Edit {
            claim: None,
            intent: Id::new(Scope([0x95; 16]), 2).unwrap(),
            actor: Actor::Creator(creator),
            planned: live.version(),
            ops: vec![Op::Set {
                node: Ref::Node(floor),
                field: import_eden::F_STAIRS,
                to: Value::Array(Vec::new()),
            }],
        };
        let checked = replica::edit::check(edit, &live, &world).unwrap();
        let planned =
            sim::edit::plan_on(checked, &live, &sim::edit::safety::Known::of(&bodies.town))
                .unwrap();
        let minter = Minter::new(Scope([0x95; 16]));
        let source = crate::buildsafe::MapBasis {
            version: live.version(),
            ground,
            stamp: Arc::clone(&bodies.form_map),
            basis: bodies.town.basis(),
        };
        let mut invalid =
            crate::buildsafe::PreparedMaps::prepare(&live, &planned, minter.clone(), &[], &source)
                .unwrap();
        let refused =
            crate::buildsafe::PreparedMaps::prepare(&live, &planned, minter.clone(), &[], &source)
                .unwrap();
        let stale =
            crate::buildsafe::PreparedMaps::prepare(&live, &planned, minter.clone(), &[], &source)
                .unwrap();
        let mut bad = (*invalid.part).clone();
        let EffectBody::Changes(changes) = &mut bad.effects[0].body else {
            unreachable!()
        };
        changes[0].change = Change::Set {
            node: Id::new(Scope([0x96; 16]), 999).unwrap(),
            field: 99,
            to: Value::Uint(1),
            by: None,
        };
        invalid.part = Arc::new(Part::read(&encode(&bad.to_value()).unwrap()).unwrap());

        // Independent runtime state changes after preparation, without changing the map's geometry identity.
        let link = replica::effects::read_id(
            &bodies
                .town
                .tree
                .node(bodies.town.tree.handle(door).unwrap())
                .unwrap()
                .fields()[&sim::ground::scene::F_OPEN_DOOR_LINK],
        )
        .unwrap();
        bodies
            .town
            .doors
            .ask(door, link, Cause::World, Actor::Creator(creator));
        bodies.town.doors.flush(&mut bodies.town.tree, 0).unwrap();
        let live_before = live.tree().to_state();
        let town_before = bodies.town.tree.to_state();
        let stamp_before = Arc::clone(&bodies.form_map);
        let called = std::cell::Cell::new(false);
        let mut reserved = minter.clone();
        assert!(
            bodies
                .commit_map(invalid, || {
                    called.set(true);
                    sim::edit::commit(&mut live, &mut reserved, &planned, &[], 0)
                })
                .is_err()
        );
        assert!(!called.get());
        assert_eq!(live.tree().to_state(), live_before);
        assert_eq!(bodies.town.tree.to_state(), town_before);
        assert!(Arc::ptr_eq(&bodies.form_map, &stamp_before));
        assert_eq!(bodies.planner.pending(), 0);

        // A real concurrent live write changes the read stamp; the real edit's confirm refuses after staging.
        let effect = Effect {
            envelope: Envelope {
                sequence: live.version(),
                at: 0,
                cause: Cause::World,
                actor: Actor::Creator(creator),
                audience: Audience::Everyone,
                node: floor,
            },
            body: EffectBody::Changes(vec![ChangeRec {
                change: Change::Set {
                    node: floor,
                    field: 99,
                    to: Value::Uint(1),
                    by: None,
                },
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        };
        sim::commit::write(&mut live, &[effect]).unwrap();
        let changed_live = live.tree().to_state();
        let mut reserved = minter.clone();
        let error = bodies
            .commit_map(refused, || {
                sim::edit::commit(&mut live, &mut reserved, &planned, &[], 0)
            })
            .unwrap_err();
        assert_eq!(error.name, "edit.stale");
        assert_eq!(live.tree().to_state(), changed_live);
        assert_eq!(bodies.town.tree.to_state(), town_before);
        assert!(Arc::ptr_eq(&bodies.form_map, &stamp_before));
        assert_eq!(bodies.planner.pending(), 0);
        assert_eq!(
            bodies
                .town
                .tree
                .node(bodies.town.tree.handle(door).unwrap())
                .unwrap()
                .fields()[&sim::links::F_OPEN],
            Value::Uint(1)
        );

        bodies.form_map = Arc::new(bodies.town.versions.clone());
        let mut reserved = minter;
        let error = bodies
            .commit_map(stale, || {
                sim::edit::commit(&mut live, &mut reserved, &planned, &[], 0)
            })
            .unwrap_err();
        assert_eq!(error.name, "edit.stale");
        assert_eq!(live.tree().to_state(), changed_live);
        assert_eq!(bodies.town.tree.to_state(), town_before);
        println!(
            "K18d: invalid staged part, real live edit.stale and obsolete map identity leave both trees/map/worker unchanged; independently opened door preserved"
        );
    }
}

/// How far from another Soul a walk to its body ends, µm (0.133 Q2): near enough to talk, out of its space.
const SPEAKING: i64 = 1_200_000;

/// The point `d` from `at` toward `from` (the walker), on the level; along +z when the walker is elsewhere or on it.
fn beside(at: Vec3, from: Option<Vec3>, d: i64) -> Vec3 {
    let (dx, dz) = from.map_or((0, 0), |f| (f.x - at.x, f.z - at.z));
    let len = (i128::from(dx) * i128::from(dx) + i128::from(dz) * i128::from(dz)).isqrt() as i64;
    if len < 1_000 {
        return Vec3::new(at.x, at.y, at.z + d);
    }
    Vec3::new(at.x + dx * d / len, at.y, at.z + dz * d / len)
}

/// How far around a body a walk to a place looks for what to face, µm ([`notable_near`]): a few steps, so a Soul faces
/// what is beside it, never a thing across the square.
const NOTABLE_NEAR: i64 = 6_000_000;

/// What a body standing at `at` in `frame` (its floor) faces after a walk to a place (0.136): the nearest thing standing
/// there, by its origin on the level within [`NOTABLE_NEAR`] and farther than [`sim::controller::FACE_NEAR`], the
/// lower id on a tie. A thing standing there is one on the floor itself or in a room on it, with solids of its own (a
/// fountain, a bench, a tree, a table; not ground cover, a path or a lawn), that holds no room (not a building, whose
/// wall is not what a Soul came to look at) and is not a body (`body`). One pass over the floor's things and its rooms'
/// things, so the same tree gives the same answer. None when nothing stands near: the body keeps its facing.
fn notable_near(tree: &Tree, frame: Id, at: Vec3, body: &dyn Fn(Id) -> bool) -> Option<Vec3> {
    use sim::ground::scene::{DOORWAY, F_SOLIDS, FLOOR, GROUND, PLACE, ROOM, WINDOW};
    let near = i128::from(NOTABLE_NEAR).pow(2);
    let off = i128::from(sim::controller::FACE_NEAR).pow(2);
    let h = tree.handle(frame)?;
    let mut todo: Vec<(replica::tree::Handle, bool)> = vec![(h, true)];
    let mut best: Option<(i128, Id, Vec3)> = None;
    while let Some((h, top)) = todo.pop() {
        for c in tree.children(h).unwrap_or_default() {
            let Some(n) = tree.node(*c) else { continue };
            let full = n.kind().as_str();
            let kind = full.split_once('@').map_or(full, |(k, _)| k);
            if kind == ROOM && top {
                todo.push((*c, false));
                continue;
            }
            if [GROUND, PLACE, ROOM, FLOOR, WINDOW, DOORWAY].contains(&kind) || body(n.id()) {
                continue;
            }
            if !matches!(n.fields().get(&F_SOLIDS), Some(Value::Array(s)) if !s.is_empty()) {
                continue;
            }
            let Ok(p) = select::origin_in(tree, n.id(), frame) else {
                continue;
            };
            let d = i128::from(p.x - at.x).pow(2) + i128::from(p.z - at.z).pow(2);
            if d <= off || d > near || best.is_some_and(|(b, id, _)| (b, id) <= (d, n.id())) {
                continue;
            }
            if main_room(tree, n.id()).is_some() {
                continue;
            }
            best = Some((d, n.id(), p));
        }
    }
    best.map(|(_, _, p)| p)
}

/// Whether `node` is a place on the open ground of its own (a landform, a water, an area, a path: a child of the ground
/// with an outline or a line and no solids, seats or floors, nor rooms within it), which a walk goes to the edge of
/// (`Bodies::goal`) and faces (`Bodies::face`): how far its edge lies from its shape, µm (0 for an outline, half a
/// line's width when the walkers' tree keeps it, else 0), and whether it is an area (an outline) rather than a line.
fn place_half_width(tree: &Tree, node: Id) -> Option<(i64, bool)> {
    use sim::ground::scene::{F_LINE_WIDTH, GROUND};
    let n = tree.node(tree.handle(node)?)?;
    let on_ground = n
        .parent()
        .and_then(|p| tree.node(tree.handle(p)?))
        .is_some_and(|g| g.kind().as_str().split('@').next() == Some(GROUND));
    let f = n.fields();
    let built = [select::F_SOLIDS, select::F_SLOTS, select::F_SURFACES]
        .iter()
        .any(|k| f.contains_key(k));
    if !on_ground || built || main_room(tree, node).is_some() {
        return None;
    }
    if f.contains_key(&select::F_OUTLINE) {
        return Some((0, true));
    }
    f.contains_key(&select::F_LINE).then(|| {
        let mm = match f.get(&F_LINE_WIDTH) {
            Some(Value::Uint(w)) => i64::try_from(*w).unwrap_or(0),
            _ => 0,
        };
        (mm.saturating_mul(500), false)
    })
}

/// How far from the point of a place's edge nearest the walker an area within it may lie and still be walked into in
/// its stead ([`inner_ground`]), µm: the harbour's boardwalk lies 9.5 m in from the edge a walker from the park comes
/// to; the west river's stone bridge, 200 m along the river from a walker by the fishing hamlet, is not where a walk to
/// the river ends.
const INNER_REACH: i64 = 20_000_000;

/// The area within area `node` (a child of `ground` too, [`place_half_width`]) whose middle the walker at `from` may
/// stand on and reach, within [`INNER_REACH`] of `edge` (the point of `node`'s edge nearest the walker), nearest the
/// walker's point `here` (both `ground`'s frame), the first by id on a tie; none when no such area lies within it.
/// Read off the tree first, then checked on the walker's map.
fn inner_ground(
    town: &mut Town,
    body: Id,
    node: Id,
    ground: Id,
    here: Vec3,
    edge: Vec3,
    from: (Id, Vec3),
) -> R<Option<Id>> {
    let tree = &town.tree;
    let within: Vec<(i64, Id, Vec3)> = tree
        .handle(ground)
        .and_then(|g| tree.children(g))
        .unwrap_or_default()
        .iter()
        .filter_map(|c| tree.node(*c).map(|n| n.id()))
        .filter(|c| *c != node && place_half_width(tree, *c) == Some((0, true)))
        .filter(|c| select::gap(tree, *c, ground, edge).is_ok_and(|g| g <= INNER_REACH))
        .filter(|c| select::within(tree, *c, node).unwrap_or(false))
        .filter_map(|c| {
            let (_, middle) = select::nearest_in(tree, c, ground, here).ok()?;
            Some((select::gap(tree, c, ground, here).ok()?, c, middle))
        })
        .collect();
    if within.is_empty() {
        return Ok(None);
    }
    let view = town.view_for(body)?;
    Ok(within
        .into_iter()
        .filter(|(.., middle)| view.stand_reached(ground, *middle, from).is_some())
        .min_by_key(|(gap, c, _)| (*gap, *c))
        .map(|(_, c, _)| c))
}

/// A building's main room (0.133 Q2): of the rooms within it (a room's kind, at most three levels down), the one with
/// the largest outline, the first by id on a tie; none when `node` holds no room, or is one, or is the ground or a named
/// place (they hold buildings: a walk to them ends on them, never in a building's room).
fn main_room(tree: &Tree, node: Id) -> Option<Id> {
    use sim::ground::scene::{GROUND, PLACE, ROOM};
    let is = |n: &replica::tree::NodeRef<'_>, kind: &str| {
        n.kind().as_str().split('@').next() == Some(kind)
    };
    let room = |n: &replica::tree::NodeRef<'_>| is(n, ROOM);
    let h = tree.handle(node)?;
    let n = tree.node(h)?;
    if room(&n) || is(&n, GROUND) || is(&n, PLACE) {
        return None;
    }
    let mut todo: Vec<(replica::tree::Handle, u8)> = vec![(h, 0)];
    let mut best: Option<(i128, Id)> = None;
    while let Some((h, depth)) = todo.pop() {
        for c in tree.children(h).unwrap_or_default() {
            let Some(n) = tree.node(*c) else { continue };
            if room(&n) {
                let a = select::area2(tree, n.id()).unwrap_or(0);
                if best.is_none_or(|(b, id)| a > b || a == b && n.id() < id) {
                    best = Some((a, n.id()));
                }
            } else if depth < 2 {
                todo.push((*c, depth + 1));
            }
        }
    }
    best.map(|(_, id)| id)
}

#[cfg(test)]
mod beside_tests {
    use super::*;

    /// 0.133 Q2: a walk to another Soul ends at speaking distance on the walker's side, or along +z with no side.
    #[test]
    fn beside_a_body_is_speaking_distance_toward_the_walker() {
        let at = Vec3::new(10_000_000, 0, 0);
        assert_eq!(
            beside(at, Some(Vec3::new(0, 0, 0)), SPEAKING),
            Vec3::new(10_000_000 - SPEAKING, 0, 0)
        );
        assert_eq!(
            beside(at, None, SPEAKING),
            Vec3::new(10_000_000, 0, SPEAKING)
        );
        assert_eq!(
            beside(at, Some(at), SPEAKING),
            Vec3::new(10_000_000, 0, SPEAKING)
        );
        let p = beside(at, Some(Vec3::new(13_000_000, 0, 4_000_000)), SPEAKING);
        let d = (i128::from(p.x - at.x).pow(2) + i128::from(p.z - at.z).pow(2)).isqrt() as i64;
        assert!((SPEAKING - 2..=SPEAKING).contains(&d), "{d}");
    }
}
