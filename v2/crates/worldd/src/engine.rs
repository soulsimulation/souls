//! The engine's own acts in a running world (Engine v2 C2, #3366): joint activities (B5) and their offers (E8), and
//! carrying together (B9), each asked by a Soul's intent through the gateway. No code here names a kind.
//!
//! - **Verbs.** An engine act is an act verb in its system's namespace ([`Verb::of`]): `activity:propose`, `:offer`,
//!   `:join`, `:accept`, `:decline`, `:start` and `:leave`, and `carry:lift` and `carry:set-down`. They are not
//!   `souls:` verbs: T10 rule 4 keeps those a closed list of moves, cancels and orders, and an intent with any other
//!   `souls:` verb is refused `order-unknown` before it reaches the world.
//! - **Parameters.** The target is the place (propose, offer), the activity (join, start, leave, lift, set down) or the
//!   offer (accept, decline). Propose: 1 the activity's kind. Offer: 1 the kind, 2 the asker's role, 3 the bodies
//!   asked (ids), 4 for a give the thing the asker holds (0.133 R4: accepting hands it over, `sim::activity::offer`). Join: 1 the role, 2 the revision (default 1). Lift: 1 the thing carried, 2 where its front goes (optional, `[x, y, z]` µm: the way there is swept first, 0.135 C2). Its two carriers are the
//!   activity's first two members, the first in front; each member after them carries beside it, at a grip between
//!   (0.135 C5: one at each grip, `carry-crew-too-large`; nobody joins while it is lifted, `carry-lifted`). Only a load is lifted, a kind whose entry states its grips
//!   (`lift-not-a-load`), and only in a carry, an activity whose kind has a slot 1 for a thing (`not-a-carry`, 0.135
//!   C4). `carrier:steer`, `carrier:stop` and `carrier:land` steer the
//!   boat the Soul sits in ([`crate::carrier`], #3603): the target the boat, steer's 1 a point `[x, z]` µm (land's 1
//!   optional, a point by its home).
//! - **Seating parts** (0.135 A2, [`crate::assembly`]): `part:take`, `part:unseat` and `part:put`, the target the crew's
//!   activity (its members, the first in front). Take and unseat: 1 the part, by at least its kind's carry crew and no
//!   more than its grips take (`carry-crew-too-small`, `carry-crew-too-large`). Seat: 1 the node it goes in, 2 its
//!   slot, or 3 a point `[x, y, z]` µm in that node's frame, 4 the parts it joins (ids; by default a bearing part
//!   joins the bay's standing parts, a resting one its bearing parts). Their commits go through the walkers' maps, so
//!   they are answered then.
//! - **Written once, as the Soul's.** Each system writes through its own writer onto a copy of the tree; its entries,
//!   caused by the intent and acted by its Soul, are applied to the world with the tick's other entries
//!   ([`Engine::out`]), so the intent's receipt names them. An act is answered at once: a receipt, or its refusal by
//!   name (a take or a seating once its commit is written, below; a lift that names where its front goes once its way
//!   comes back, [`WayAsk`]). A carry in progress is sampled each tick between
//!   its carriers ([`Engine::tick`]). A carry that breaks off (a carrier's leave, carriers drifted apart, a restart)
//!   sets its load down where it is and says why (0.135 C3).
//! - **A restart keeps its activities** (E26, #3329): once the bodies are back, [`Engine::restore`] reads them from
//!   their nodes and membership links, so a member speaks in one and leaves it as before. Open offers and carries in
//!   progress are not restored.
//!
//! A served world reads its activity kinds from its entries (`crate::serve::activity_kinds`) and births its Souls'
//! bodies as tree nodes (C3), so these acts run there as in a world given them (0.135 A2's served test,
//! `tests/edit_served.rs`).
//!
//! Not here: the view tier addressing an offer to the bodies asked (#3368's follow-up).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use replica::activity::ActivityKind;
use replica::effects::{Actor, Cause, Effect, Header, Refusal, read_id};
use replica::encode::{Name, Value};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::Vec3;
use replica::rules::json::Value as Json;
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use replica::tree::{Rules, Tree};
use replica::world_model::plain;
use replica::world_model::show;
use sim::activity::carry::{Carry, Fixed, Load, turn};
use sim::activity::{Activities, Ask};
use sim::controller::Controller;
use sim::moves::{Moves, Reach};
use sim::slots::Slots;
use sim::timers::DueList;

type R<T> = Result<T, Refusal>;

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// An engine act's verb.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    Propose,
    Offer,
    Join,
    Accept,
    Decline,
    Start,
    Leave,
    Lift,
    SetDown,
    /// A rider steers or lands the boat it sits in (#3603, [`crate::carrier`]).
    Steer,
    Land,
    Stop,
    /// A crew takes a part, takes one out of a bay, or asm the part it carries (0.135 A2, [`crate::assembly`]).
    Take,
    Unseat,
    Put,
}

impl Verb {
    /// Whether the act is answered once its entries are committed through the walkers' maps, not at once (a take or
    /// a seating, 0.135 A2).
    pub fn deferred(self) -> bool {
        matches!(self, Verb::Take | Verb::Unseat | Verb::Put)
    }

    /// The engine act a verb names, if it names one.
    pub fn of(verb: &str) -> Option<Verb> {
        Some(match verb {
            "activity:propose" => Verb::Propose,
            "activity:offer" => Verb::Offer,
            "activity:join" => Verb::Join,
            "activity:accept" => Verb::Accept,
            "activity:decline" => Verb::Decline,
            "activity:start" => Verb::Start,
            "activity:leave" => Verb::Leave,
            "carry:lift" => Verb::Lift,
            "carry:set-down" => Verb::SetDown,
            "carrier:steer" => Verb::Steer,
            "carrier:land" => Verb::Land,
            "carrier:stop" => Verb::Stop,
            "part:take" => Verb::Take,
            "part:unseat" => Verb::Unseat,
            "part:put" => Verb::Put,
            _ => return None,
        })
    }
}

/// An engine act as the clock thread takes it.
#[derive(Clone, Debug)]
pub struct Act {
    pub id: Id,
    pub soul: Id,
    pub body: Id,
    pub verb: Verb,
    pub target: Option<Id>,
    pub params: BTreeMap<u64, Value>,
}

/// A take waiting for its commit (0.135 A2): the crew's ground, its node's place and turn, its carriers' span, and
/// each side carrier's place at the part (C5).
type Taking = (Id, Vec3, replica::pose::Quat, i64, Vec<(Id, [i64; 2])>);

/// A carrying ground's fixed geometry and what it was read at (0.135 C7, [`Engine`]'s `fixed`): the walkers' ground
/// versions, and the carries on it, each by its activity and when it began.
type FixedRead = (sim::ground::Versions, Vec<(Id, Micros)>, Fixed);

/// The engine's systems, with their own due list, moves and minter.
pub struct Engine {
    header: Header,
    rules: Rules,
    kinds: Vec<ActivityKind>,
    activities: Activities,
    carries: BTreeMap<Id, Carry>,
    due: DueList,
    moves: Moves,
    mint: Minter,
    /// Entries written and not yet applied.
    out: Vec<Effect>,
    /// The boats steered off their own loops (#3603).
    steered: BTreeSet<Id>,
    /// Whether the rides' seat courses (N14) were written to their things at this start.

    /// The moves an activity's roles may name (0.134 T1): content's, [`crate::moves::library`].
    library: Vec<Move>,
    /// The world's clock, whose beats a dance's moves start on (0.134 T3): the world's own ([`Engine::with_beats`]).
    line: Timeline,
    /// The loads the world's entries state, by plain kind (0.135 C2, [`Engine::with_loads`]).
    loads: BTreeMap<String, Load>,
    /// The crews' seating, when the world's kinds join parts (0.135 A2, [`Engine::with_structure`]).
    asm: Option<crate::assembly::Assembly>,
    /// Each take waiting for its commit: the crew's ground, its node's pose and its audience, to start its carry.
    taking: BTreeMap<Id, Taking>,
    /// The entries the joined-part rule was read from, to read it again for the activities after a restart.
    joining: Option<Json>,
    /// Loads found riding a carry at a restart, set down at the first tick (0.135 C3): (activity, load).
    riding: Vec<(Id, Id)>,
    /// How often each retiring holder's set-down has been checked again (0.135 A2): its maps go stale as its body goes.
    retried: BTreeMap<Id, u8>,
    /// Each carrying ground's fixed geometry, with what it was read at (0.135 C7): the walkers' ground versions and the
    /// carries on it then, each by its activity and when it began. A take, a lift or a set-down moves a load off or
    /// onto its ground without changing a walker's map (`crate::assembly::Ready::town_part`), so the versions alone
    /// would keep a part just taken where it stood, and a load just set down out of the geometry, until the next
    /// seating (two crews taking two bents at once).
    fixed: BTreeMap<Id, FixedRead>,
    /// The way searches lifts asked since the last call to [`Engine::ways_asked`], in order.
    asked: Vec<WayAsk>,
    /// Each lift waiting for its way, by intent: the act, run again when the way comes back ([`Engine::way_back`]).
    waiting: BTreeMap<Id, Act>,
    /// Each way back and not yet read by its lift run again, by intent: what was asked, and the way or its refusal.
    found: BTreeMap<Id, (WayAsk, Way)>,
    /// The world's entries by kind ([`Engine::with_loads`]): a seat's slots, which a touch reaches a seated body at.
    entries: Json,
    /// Each lifted carry whose front has walked (`v2/docs/moving-group.md` rule 3): its front, which leads, the
    /// front's latest walk, and the turn that walk takes the crew through, if any. While the carry lasts its other
    /// carriers keep their places from the front, by follow orders `crate::answers` keeps ([`Engine::carry_follows`]).
    led: BTreeMap<Id, Led>,
    /// Why each led carry broke off (its load set down by the world), until [`Engine::led_over`] reads it.
    broke: BTreeMap<Id, &'static str>,
    /// Acts held while a carry's node is on a lift's or a set-down's track (#5067), by the carry: a set-down or a put
    /// asked during its lift, the last member's leave during its set-down (its node holds the load until it rests).
    /// Each runs again when the track ends ([`Engine::reruns`]), answered then.
    held: BTreeMap<Id, Vec<Act>>,
    /// Held acts whose track has ended, to be run again.
    rerun: Vec<Act>,
    /// Each crew's set-down on its way down, by the carry: its intent, answered when the load rests (#5067).
    answering: BTreeMap<Id, Id>,
    /// Set-downs whose load rests (or whose carry is gone), to be answered with their receipts.
    answered: Vec<Id>,
}

/// A lifted carry's front walking (moving-group rule 3): its body, its walk, and where that walk turns the crew: the
/// walk's goal and the carry's heading there (x, z on its ground's plan, from its back toward its front), when the walk
/// names one (walk parameter 3, the client's `carry to <bay> <slot>`) or goes to a pose of the carry's way (0.135 R2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Led {
    pub front: Id,
    pub walk: Id,
    pub turn: Option<([i64; 2], [i64; 2])>,
}

/// A carrier keeping its place in a led carry (moving-group rule 3): the carry, its front, the carrier's body and
/// Soul, its place in the carry's frame (`[along, across]` µm from the front, +along from the back toward the front,
/// +across as [`Carry::place_of`] has it), the carry's heading now (from its last sample) and the front's walk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Keeps {
    pub activity: Id,
    pub front: Id,
    pub walker: Id,
    pub soul: Id,
    pub place: [i64; 2],
    pub heading: [i64; 2],
    pub led: Led,
}

/// A place `[along, across]` in a carry's frame as an offset on the plan, the carry heading `h` (x, z, any length,
/// not zero): along `h` and across it (`[-h.z, h.x]`), as [`Carry::place_of`] reads a place.
pub fn on_plan(place: [i64; 2], h: [i64; 2]) -> [i64; 2] {
    let (h0, h1) = (i128::from(h[0]), i128::from(h[1]));
    let l = h0
        .saturating_mul(h0)
        .saturating_add(h1.saturating_mul(h1))
        .isqrt()
        .max(1);
    let (a, c) = (i128::from(place[0]), i128::from(place[1]));
    let v = |n: i128| i64::try_from(n / l).unwrap_or(0);
    [
        v(a.saturating_mul(h0).saturating_sub(c.saturating_mul(h1))),
        v(a.saturating_mul(h1).saturating_add(c.saturating_mul(h0))),
    ]
}

/// The most a walk's heading for its carry (parameter 3) may be on either axis, µm: a direction, read at any length
/// up to this; one beyond is no heading.
pub const HEADING_MOST: i64 = 1 << 40;

/// How near a pose of a carry's way (0.135 R2) its front's walk must go to turn the crew to that pose, µm: half the
/// way's lattice step.
pub const WAY_POSE_NEAR: i64 = turn::STEP / 2;

/// The kind of thing an activity of `kind` is played at (its entry's own, `<entry>_activity`), when its entry in
/// `entries` plays it through forms; None for one played anywhere (a touch, a dance) or a kind of no entry.
pub fn at_its_thing<'a>(entries: &'a Json, kind: &Name) -> Option<&'a str> {
    let entry = plain(kind.as_str()).strip_suffix("_activity")?;
    let (k, e) = entries.obj()?.iter().find(|(k, _)| k == entry)?;
    e.get("forms")
        .and_then(Json::obj)
        .is_some_and(|f| !f.is_empty())
        .then_some(k.as_str())
}

/// A lift's way, found: none for a straight way, else the poses of one that turns the load, or its refusal.
pub type Way = R<Option<Vec<turn::Ends>>>;

/// A lift's way (0.135 R2, off the clock): a lift that names where its front goes has its way swept and, when the
/// straight way clips, a way that turns the load searched ([`Load::way_to`]) on a thread of its own, never on the
/// world's clock. The lift is answered when the way comes back, in the order the ways were asked; in lockstep the
/// clock waits for it before the next tick, as for every check, so the same inputs land the lift at the same tick.
/// The same inputs give the same way on any thread.
#[derive(Clone, Debug)]
pub struct WayAsk {
    /// The lift's intent.
    pub intent: Id,
    pub load: Load,
    pub fixed: Arc<Fixed>,
    /// Where the front and the back carriers stand, and where the front goes, on the open ground's plan, µm.
    pub front: [i64; 2],
    pub back: [i64; 2],
    pub to: [i64; 2],
}

impl WayAsk {
    /// The sweep and the search, off the clock.
    pub fn search(&self) -> Way {
        self.load
            .way_to(&self.fixed, self.front, self.back, self.to)
    }

    /// Whether `other` asks the same search.
    fn same(&self, other: &WayAsk) -> bool {
        (self.intent, self.load, self.front, self.back, self.to)
            == (other.intent, other.load, other.front, other.back, other.to)
            && *self.fixed == *other.fixed
    }
}

/// Sets `carry`'s load down where the carry last had it, at rest on `ground`, and has the world say `why`
/// (`souls:carry-set-down`, 0.135 C3): on a set-down's track (#5067, [`Carry::release`]), so the caller keeps the carry
/// until it rests ([`Carry::lowering`]); a lift's track is ended by name first (`souls:lift-cancelled`) and the load
/// goes back along it to where it lay. A carry already on its way down keeps to its track and nothing is said. Its
/// entries are stamped with `by`'s intent and Soul, or the world's, and go in the activities' stream, so every entry
/// leaves the engine in the order it was written.
#[allow(clippy::too_many_arguments)]
fn break_off(
    carry: &mut Carry,
    activities: &mut Activities,
    tree: &mut Tree,
    now: Micros,
    here: Option<((Vec3, replica::pose::Quat), Option<i64>)>,
    why: &'static str,
    by: Option<(Id, Id)>,
) -> R<()> {
    if carry.lowering() {
        return Ok(());
    }
    let lift = carry.hoist.filter(|_| carry.lifting());
    let track = carry.release(tree, now, carry.ground, here, why)?;
    let mut effects: Vec<Effect> = carry.log.parts.drain(..).flatten().collect();
    for e in &mut effects {
        if let Some((intent, soul)) = by {
            e.envelope.cause = Cause::Intent(intent);
            e.envelope.actor = Actor::Soul(soul);
        }
    }
    activities.stream.extend(effects);
    activities.next = tree.next();
    let (actor, cause) = match by {
        Some((intent, soul)) => (Actor::Soul(soul), Cause::Intent(intent)),
        None => (Actor::World, Cause::World),
    };
    let (a, load) = (carry.activity, carry.board);
    if let Some(h) = lift {
        let w = (now, actor, cause);
        activities.carry_track(tree, a, load, "souls:lift-cancelled", (h.t0, now), Some(why), w)?;
    }
    if let Some(t) = track {
        let w = (now, actor, cause);
        activities.carry_track(tree, a, load, "souls:set-down", t, Some(why), w)?;
    }
    activities.carry_set_down(tree, a, load, why, (now, actor, cause))
}

/// Where bodies stand, read from the controller before a move needs them (0.134 T1): a move one member of an activity
/// aims at another reaches across x and z from feet to feet, on one floor; on two floors it reaches nothing. A seated,
/// lying or riding body is where its seat is ([`feet_of`]), as the served world's reach reads it, not at its slot
/// frame's zero.
struct Feet(BTreeMap<Id, (Id, [i64; 2])>);

impl Feet {
    fn of(
        c: &Controller,
        tree: &Tree,
        entries: &Json,
        bodies: impl IntoIterator<Item = Id>,
    ) -> Feet {
        Feet(
            bodies
                .into_iter()
                .filter_map(|b| c.body(b).map(|m| (b, feet_of(tree, entries, &m.pose))))
                .collect(),
        )
    }
}

/// Where a body with pose `pose` stands (0.135 E21, [`sim::reach::body_at`]): a seated, lying or riding one at its
/// slot's point of the thing it is in, carried from that thing's frame onto the node it is placed on; any other, or
/// one whose thing's entry or place is not found, where its pose has it.
fn feet_of(tree: &Tree, entries: &Json, pose: &replica::pose::Pose) -> (Id, [i64; 2]) {
    let thing = tree.handle(pose.frame.node).and_then(|h| tree.node(h));
    let within = thing
        .as_ref()
        .and_then(|n| crate::acts::entry_in(entries, tree, n));
    let on = |_: Id, p: Vec3| {
        let n = thing.as_ref()?;
        let place = n.place()?;
        let up = place
            .position
            .plus(place.orientation.rotate(p).ok()?)
            .ok()?;
        Some((n.parent()?, up))
    };
    let (floor, at) = sim::reach::body_at(pose, within.as_deref(), on).unwrap_or_else(|| {
        let node = match pose.support {
            replica::pose::Support::Surface { surface, .. } => surface,
            _ => pose.frame.node,
        };
        (node, pose.position)
    });
    (floor, [at.x, at.z])
}

impl Reach for Feet {
    fn distance(
        &self,
        body: Id,
        _: &Effector,
        _: Option<&Name>,
        target: Id,
        _: &Name,
    ) -> Option<i64> {
        let ((f, a), (g, b)) = (self.0.get(&body)?, self.0.get(&target)?);
        let (dx, dz) = (i128::from(a[0] - b[0]), i128::from(a[1] - b[1]));
        (f == g).then(|| i64::try_from((dx * dx + dz * dz).isqrt()).unwrap_or(i64::MAX))
    }
}

/// A point `[x, y, z]` µm, parameter `k`.
fn param_point(p: &BTreeMap<u64, Value>, k: u64, what: &'static str) -> R<Option<Vec3>> {
    let Some(v) = p.get(&k) else {
        return Ok(None);
    };
    let int = |v: &Value| match v {
        Value::Uint(n) => i64::try_from(*n).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    };
    match v {
        Value::Array(a) => match a.iter().map(int).collect::<Option<Vec<_>>>().as_deref() {
            Some([x, y, z]) => Ok(Some(Vec3::new(*x, *y, *z))),
            _ => Err(refusal(what, format!("parameter {k}: [x, y, z] µm"))),
        },
        _ => Err(refusal(what, format!("parameter {k}: [x, y, z] µm"))),
    }
}

fn param_id(p: &BTreeMap<u64, Value>, k: u64, what: &'static str) -> R<Id> {
    p.get(&k)
        .and_then(|v| read_id(v).ok())
        .ok_or_else(|| refusal(what, format!("parameter {k}: an id")))
}

fn param_name(p: &BTreeMap<u64, Value>, k: u64, what: &'static str) -> R<Name> {
    match p.get(&k) {
        Some(Value::Text(n)) => Ok(n.clone()),
        _ => Err(refusal(what, format!("parameter {k}: a name"))),
    }
}

/// A pinned activity kind uses a bounded plain name and binary SHA-256 multihash (C30); short names stay names.
fn param_kind(p: &BTreeMap<u64, Value>, k: u64, what: &'static str) -> R<Name> {
    match p.get(&k) {
        Some(Value::Array(pair)) => match pair.as_slice() {
            [Value::Text(plain), Value::Bytes(hash)]
                if !plain.as_str().is_empty()
                    && plain.as_str().len()
                        <= replica::intent_decode::LIMITS.text_bytes as usize
                    && !plain.as_str().contains('@')
                    && hash.len() == 34
                    && hash[..2] == [0x12, 0x20] =>
            {
                Name::new(&format!(
                    "{}@{}",
                    plain.as_str(),
                    replica::encode::to_hex(hash)
                ))
                .ok_or_else(|| refusal(what, "a pinned kind"))
            }
            _ => Err(refusal(what, "a plain name and binary SHA-256 multihash")),
        },
        _ => param_name(p, k, what),
    }
}

/// How far a crew's carriers' middle may be from where its refused set-in started for its carry to start again there.
const BACK_SLACK: i64 = 300_000;
/// How far out from a seated part, along the side it is laid on, its middle rests, µm.
const LAY_OUT: i64 = 2_200_000;
/// How often a retiring holder's set-down is checked again when its walkers' maps went stale (a body beside it moving,
/// or its own body leaving): about one a tick, so some 5 s; then its hold stays kept.
const RETRIES: u8 = 100;

/// How far apart two carriers stand along the ground, µm.
fn apart(f: Vec3, k: Vec3) -> i64 {
    let (dx, dz) = (i128::from(f.x - k.x), i128::from(f.z - k.z));
    i64::try_from((dx * dx + dz * dz).isqrt()).unwrap_or(i64::MAX)
}

/// Turns `a` and `b`, each standing on the same floor, to face each other: the facing of its legs, set by a driver
/// of them as a walk's end sets it (`Bodies::turn_to`). One seated, on another floor, within
/// [`sim::controller::FACE_NEAR`] of the other or whose legs something else drives (a walk, a follow, settled on the
/// ground: [`crate::bodies::turn_free`]) keeps its facing.
fn face_each_other(c: &mut Controller, a: Id, b: Id) {
    let at = |c: &Controller, x: Id| {
        c.body(x)
            .filter(|m| m.pose.frame.slot.is_none())
            .map(|m| (sim::index::place_of(m).0, m.pose.position))
    };
    let (Some((na, pa)), Some((nb, pb))) = (at(c, a), at(c, b)) else {
        return;
    };
    if na != nb {
        return;
    }
    for (body, from, to) in [(a, pa, pb), (b, pb, pa)] {
        if let Some(facing) = sim::controller::facing_toward(from, to) {
            crate::bodies::turn_free(c, body, facing);
        }
    }
}

/// Where the controller has a body: the node it stands on and its position there.
fn stands(c: &Controller, body: Id) -> R<(Id, Vec3)> {
    c.body(body)
        .map(|m| (sim::index::place_of(m).0, m.pose.position))
        .ok_or_else(|| refusal("body-unknown", show(body)))
}

impl Engine {
    /// The engine carrying each load whose kind `entries` states as its entry says (0.135 C2): `entries` is the
    /// world's kinds, an object of entries; one that is not a load (no bounds, fewer than two grips) is left out. The
    /// entries are kept, so a touch reaches a seated body at its seat (0.135 E21, [`feet_of`]).
    pub fn with_loads(mut self, entries: &Json) -> Engine {
        self.entries = entries.clone();
        for (_, e) in entries.obj().unwrap_or(&[]) {
            if let (Some(kind), Ok(load)) = (e.get("kind").and_then(Json::str), Load::of(e)) {
                self.loads.insert(kind.to_owned(), load);
            }
        }
        self
    }

    /// The earliest due time of the activities and the boats on their loops (O2: when a sleeping world must be up).
    pub fn next_due(&self) -> Option<Micros> {
        // B10: an unstarted activity's expiry is due too, so a sleeping world wakes to end it.
        match (self.due.next_due(), self.activities.next_expiry()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// The systems for a zone under `header`, checked by `rules`, with activities of `kinds`, minting ids of `scope`.
    pub fn new(header: Header, rules: Rules, kinds: Vec<ActivityKind>, scope: Scope) -> Engine {
        Engine {
            activities: Activities::new(header.clone(), rules.clone(), 0, kinds.clone()),
            kinds,
            header,
            rules,
            carries: BTreeMap::new(),
            due: DueList::new(),
            moves: Moves::new(),
            mint: Minter::new(scope),
            out: Vec::new(),
            steered: BTreeSet::new(),

            asm: None,
            taking: BTreeMap::new(),
            joining: None,
            library: crate::moves::library().unwrap_or_else(|r| {
                eprintln!("worldd: no moves for activities: {r}");
                Vec::new()
            }),
            line: Timeline::start(
                Mapping::new(0, 0, 1, 1).expect("rate one"),
                TickRate::new(0, 0, 20).expect("20 a second"),
                Tempo::per_minute(0, 0, 120).expect("120 a minute"),
            )
            .expect("a line from zero"),
            loads: BTreeMap::new(),
            riding: Vec::new(),
            retried: BTreeMap::new(),
            fixed: BTreeMap::new(),
            asked: Vec::new(),
            waiting: BTreeMap::new(),
            found: BTreeMap::new(),
            entries: Json::Null,
            led: BTreeMap::new(),
            broke: BTreeMap::new(),
            held: BTreeMap::new(),
            rerun: Vec::new(),
            answering: BTreeMap::new(),
            answered: Vec::new(),
        }
    }

    /// Whether act `id` waits for its way (a lift, [`WayAsk`]): it is answered when the way comes back.
    pub fn waits(&self, id: Id) -> bool {
        self.waiting.contains_key(&id)
            || self.held.values().flatten().any(|a| a.id == id)
            || self.answering.values().any(|i| *i == id)
    }

    /// The crews' set-downs whose load has come to rest since the last call (#5067), by intent: each answered now.
    pub fn answered(&mut self) -> Vec<Id> {
        std::mem::take(&mut self.answered)
    }

    /// The acts held while a carry's node was on a lift's or a set-down's track that has ended since the last call
    /// (#5067), in order: each to be run again and answered then.
    pub fn reruns(&mut self) -> Vec<Act> {
        std::mem::take(&mut self.rerun)
    }

    /// Holds act `a` until carry `activity`'s track ends (#5067).
    fn hold(&mut self, activity: Id, a: &Act) {
        self.held.entry(activity).or_default().push(a.clone());
    }

    /// Carry `activity`'s track has ended, or the carry is gone: its held acts run again, and its set-down is answered.
    fn unhold(&mut self, activity: Id) {
        if let Some(acts) = self.held.remove(&activity) {
            self.rerun.extend(acts);
        }
        self.answered.extend(self.answering.remove(&activity));
    }

    /// The lifts waiting for their ways, by intent.
    pub fn waiting_ids(&self) -> Vec<Id> {
        self.waiting.keys().copied().collect()
    }

    /// Lifts waiting for ways and ways back not yet read: what the engine keeps between ticks for them (0.135 R2).
    pub fn ways_kept(&self) -> (usize, usize) {
        (self.waiting.len(), self.found.len())
    }

    /// The way searches asked since the last call, in order, to be searched off the clock.
    pub fn ways_asked(&mut self) -> Vec<WayAsk> {
        std::mem::take(&mut self.asked)
    }

    /// A way come back for `ask`: the lift waiting for it, to be run again, which reads the way; none when the lift
    /// no longer waits (its deadline passed), and the way is dropped.
    pub fn way_back(&mut self, ask: WayAsk, way: Way) -> Option<Act> {
        let act = self.waiting.remove(&ask.intent)?;
        self.found.insert(ask.intent, (ask, way));
        Some(act)
    }

    /// Lift `id`'s deadline passed while it waited for its way: it waits no longer, and whether it was waiting.
    pub fn way_late(&mut self, id: Id) -> bool {
        self.found.remove(&id);
        self.waiting.remove(&id).is_some()
    }

    /// The engine on the world's own clock `line`, whose beats a dance's moves start on (0.134 T3).
    pub fn with_beats(mut self, line: Timeline) -> Engine {
        self.line = line;
        self
    }

    /// The roles' moves of the activities just started, aimed by each member at the other (0.134 T1). A refused one
    /// is left out, and the member plays its role without it.
    fn begin_moves(&mut self, tree: &mut Tree, c: &mut Controller, now: Micros) {
        let bodies = self.activities.beginning();
        if bodies.is_empty() {
            return;
        }
        // Two who begin a conversation (or any activity of two with no places) turn to face each other, each standing
        // on one floor, as a walk's end turns a body to what it came to (trial of 25 Nov).
        for [a, b] in self.activities.facing_pairs() {
            face_each_other(c, a, b);
        }
        let feet = Feet::of(c, tree, &self.entries, bodies);
        for (body, r) in self.activities.begin_moves(
            tree,
            c,
            &mut self.moves,
            &mut self.due,
            &mut self.mint,
            &self.library,
            &feet,
            &self.line,
            now,
        ) {
            eprintln!("worldd: {}'s move was not aimed: {r}", show(body));
        }
    }

    /// The engine seating parts by the joined-part rule `structure` (0.135 A2), when the world's kinds join any.
    /// The joined-part rule of the world's `entries` (B18) also guards the activities' own writes: a holder leaving a
    /// part that would then hang is refused `support.none`, as it is after a restart.
    pub fn with_structure(mut self, entries: &Json) -> Engine {
        let structure = sim::structure::Structure::from_entries;
        let asm = crate::assembly::Assembly::new(
            self.header.clone(),
            self.rules.clone(),
            structure(entries),
        );
        if asm.any() {
            self.activities.structure = structure(entries);
            self.asm = Some(asm);
            self.joining = Some(entries.clone());
        }
        self
    }

    /// The activities `live` holds after a restart (their nodes and membership links are in the log), so a member can
    /// still speak in one and leave it: each started one takes its members' role claims again through `c`.
    /// The things on a course are handed to `slots` with the courses the log left them (#3603).
    pub fn restore(&mut self, live: &Tree, c: &mut Controller, slots: &mut Slots) -> R<()> {
        let kinds = self.kinds.clone();
        self.activities =
            Activities::restore(self.header.clone(), self.rules.clone(), kinds, live, c)?;
        if let Some(e) = &self.joining {
            self.activities.structure = sim::structure::Structure::from_entries(e);
        }
        self.steered = crate::carrier::restore(live, slots)?;
        // 0.135 C3: a carry is not stored, so a load still riding its carry is set down at the first tick.
        for a in self.activities.ids() {
            let Some(h) = live.handle(a) else { continue };
            for &k in live.children(h).into_iter().flatten() {
                if let Some(n) = live.node(k)
                    && n.slot() == Some(sim::activity::carry::SLOT)
                {
                    self.riding.push((a, n.id()));
                }
            }
        }
        Ok(())
    }

    /// Runs act `a` at `now` on a copy of `live`, the bodies' controller `c`. Its entries wait in [`Engine::out`].
    pub fn act(
        &mut self,
        live: &Tree,
        c: &mut Controller,
        slots: &mut Slots,
        a: &Act,
        now: Micros,
    ) -> R<()> {
        // A way this act asked for, come back (a lift run again, [`Engine::way_back`]): taken here, so however the act
        // ends (refused before its way is read, say `carry-lifted`) nothing of it is kept.
        let found = self.found.remove(&a.id);
        if let Some(ask) = match a.verb {
            Verb::Steer => Some(crate::carrier::Ask::Steer),
            Verb::Land => Some(crate::carrier::Ask::Land),
            Verb::Stop => Some(crate::carrier::Ask::Stop),
            _ => None,
        } {
            let by = (Cause::Intent(a.id), Actor::Soul(a.soul));
            let e = crate::carrier::act(live, slots, ask, a.body, a.target, &a.params, now, by)?;
            if let Some(t) = a.target {
                self.steered.insert(t);
            }
            self.out.push(e);
            return Ok(());
        }
        let mut tree = live.frozen();
        let target = |what| a.target.ok_or_else(|| refusal(what, "a target node"));
        let ask = Ask {
            soul: a.soul,
            intent: a.id,
            at: now,
        };
        self.activities.next = tree.next();
        let e = &mut self.activities;
        match a.verb {
            Verb::Propose => {
                let kind = param_kind(&a.params, 1, "propose-needs-a-kind")?;
                e.propose(
                    &mut tree,
                    &mut self.mint,
                    ask,
                    &kind,
                    target("propose-needs-a-place")?,
                )?;
            }
            Verb::Offer => {
                let kind = param_kind(&a.params, 1, "offer-needs-a-kind")?;
                let role = param_name(&a.params, 2, "offer-needs-a-role")?;
                let asked: BTreeSet<Id> = match a.params.get(&3) {
                    Some(Value::Array(v)) => v.iter().filter_map(|x| read_id(x).ok()).collect(),
                    _ => BTreeSet::new(),
                };
                let place = target("offer-needs-a-place")?;
                // An activity its entry plays through forms on its own thing (a harvest's picks) is offered at a thing
                // of that kind: on the open ground no member would hold its role's link there, and every form refused.
                if let Some(at) = at_its_thing(&self.entries, &kind)
                    && tree
                        .handle(place)
                        .and_then(|h| tree.node(h))
                        .is_none_or(|n| plain(n.kind().as_str()) != at)
                {
                    return Err(refusal(
                        "together.at-its-thing",
                        format!(
                            "{} is played at a {at}, through its forms: offer it at one, not at {}",
                            plain(kind.as_str()),
                            show(place)
                        ),
                    ));
                }
                // A give (0.133 R4): 4 the thing the asker holds and hands over when the offer is accepted.
                let given = match a.params.get(&4) {
                    None => None,
                    Some(v) => Some(read_id(v).map_err(|_| Refusal {
                        name: "give-needs-a-thing",
                        detail: "parameter 4 is the thing given, an id".into(),
                    })?),
                };
                e.offer(
                    &mut tree,
                    &mut self.mint,
                    &mut self.due,
                    ask,
                    a.body,
                    &kind,
                    &role,
                    place,
                    asked,
                    given,
                )?;
            }
            Verb::Join => {
                let role = param_name(&a.params, 1, "join-needs-a-role")?;
                let revision = match a.params.get(&2) {
                    Some(Value::Uint(r)) => *r,
                    _ => 1,
                };
                let activity = target("join-needs-an-activity")?;
                e.join(
                    &mut tree,
                    &mut self.mint,
                    ask,
                    a.body,
                    activity,
                    &role,
                    revision,
                )?;
            }
            Verb::Accept => {
                let offer = target("accept-needs-an-offer")?;
                // 0.135 C5: nobody joins a crew's carry while its load is lifted; a replacement joins at a set-down.
                if self.carries.contains_key(&offer)
                    && e.offered(offer).is_some_and(|(k, _)| k.most > 2)
                {
                    return Err(refusal("carry-lifted", show(offer)));
                }
                // 0.134 T1: a touch starts only where its moves reach, read from the places the two will take when
                // it starts (0.135 G3), so two who walked up to each other touch: each steps to its place no farther
                // than the move reaches, and two farther apart are refused here, before anyone moves.
                // A dance (T3) touches nobody: its moves are at each member's own body. But its members take their
                // places together, within their role's `within` of the places' middle (0.135 G3), and one farther off
                // is left where it is: one who accepts from farther than twice that from the asker, or from another
                // floor (a seat), would be counted dancing while it stood 80 m off at a piano (trial of 25 Nov). It is
                // refused here, before anyone moves; it walks over and accepts again.
                if let Some((kind, asker)) = e.offered(offer).filter(|(k, _)| k.beat)
                    && let Some(within) = e
                        .offered_roles(offer)
                        .and_then(|[_, other]| kind.role(other))
                        .and_then(|r| r.within)
                {
                    let at = |b: Id| c.body(b).map(sim::index::place_of);
                    let apart = match (at(asker), at(a.body)) {
                        (Some((n0, p0)), Some((n1, p1))) if n0 == n1 => {
                            let (dx, dz) = (i128::from(p1[0] - p0[0]), i128::from(p1[1] - p0[1]));
                            Some((dx * dx + dz * dz).isqrt())
                        }
                        _ => None,
                    };
                    let most = i128::from(within) * 2;
                    if apart.is_none_or(|d| d > most) {
                        return Err(refusal(
                            "together.too-far",
                            format!(
                                "{}: {} from {}, its places are within {most} µm of each other: stand and walk over first",
                                plain(kind.name.as_str()),
                                apart.map_or("not on one floor".into(), |d| format!("{d} µm")),
                                show(asker),
                            ),
                        ));
                    }
                }
                if let Some((kind, asker)) = e.offered(offer).filter(|(k, _)| !k.beat) {
                    let mut feet = Feet::of(c, &tree, &self.entries, [asker, a.body]);
                    let pair = [asker, a.body];
                    let roles = e
                        .offered_roles(offer)
                        .map(|r| r.map(|n| kind.role(n)))
                        .unwrap_or_default();
                    let mut steps = Vec::new();
                    if let [Some(r0), Some(r1)] = roles {
                        let at = |b: Id| {
                            c.body(b)
                                .map(|m| (sim::index::place_of(m).0, m.pose.position))
                        };
                        let ahead =
                            sim::activity::places::ahead(&[(r0, at(pair[0])), (r1, at(pair[1]))]);
                        for (b, p) in pair.into_iter().zip(ahead) {
                            // A seated member is placed where it sits (`Bodies::take_places`).
                            let seated = c.body(b).is_none_or(|m| m.pose.frame.slot.is_some());
                            if let (Some(p), false, Some((_, now))) =
                                (p, seated, feet.0.get_mut(&b))
                            {
                                let (dx, dz) = (i128::from(now[0] - p.x), i128::from(now[1] - p.z));
                                steps.push((
                                    b,
                                    i64::try_from((dx * dx + dz * dz).isqrt()).unwrap_or(i64::MAX),
                                ));
                                *now = [p.x, p.z];
                            }
                        }
                    }
                    for mv in kind.roles.iter().filter_map(|r| r.mv.as_ref()) {
                        let Some(m) = self.library.iter().find(|m| m.name == *mv) else {
                            continue;
                        };
                        if let Some((b, step)) = steps.iter().find(|(_, s)| *s > m.reach) {
                            return Err(refusal(
                                "together.too-far",
                                format!(
                                    "{}: {} stands {step} µm from its place, it steps at most {} µm: walk up first",
                                    mv.as_str(),
                                    show(*b),
                                    m.reach
                                ),
                            ));
                        }
                        let held = Effector::Held;
                        match feet.distance(asker, &held, None, a.body, &m.contact) {
                            Some(d) if d <= m.reach => {}
                            d => {
                                return Err(refusal(
                                    "together.too-far",
                                    format!(
                                        "{}: {} µm apart, it reaches {} µm: stand closer, facing each other",
                                        mv.as_str(),
                                        d.map_or("not on one floor".into(), |d| d.to_string()),
                                        m.reach
                                    ),
                                ));
                            }
                        }
                    }
                }
                e.accept(
                    &mut tree,
                    &mut self.mint,
                    c,
                    &mut self.due,
                    ask,
                    a.body,
                    offer,
                )?;
            }
            Verb::Decline => {
                let offer = target("decline-needs-an-offer")?;
                e.decline(&mut tree, &mut self.due, ask, a.body, offer)?;
            }
            Verb::Start => e.start(&mut tree, c, ask, target("start-needs-an-activity")?)?,
            Verb::Leave => {
                let activity = target("leave-needs-an-activity")?;
                // 0.135 A2: while a crew's part is on its way in or back, or its take or seating waits for its commit,
                // the crew is not left; at any other time a leave breaks its carry off, as any carry's.
                if self.taking.contains_key(&activity)
                    || self.asm.as_ref().is_some_and(|s| s.busy(activity))
                {
                    return Err(refusal("crew.setting-in", show(activity)));
                }
                // #5067: the last member's leave waits while its carry's load is on its way down: the node holds it.
                if self.carries.get(&activity).is_some_and(Carry::lowering)
                    && self.activities.members(activity).is_some_and(|m| m.len() == 1)
                {
                    self.hold(activity, a);
                    return Ok(());
                }
                // 0.135 C3: a carrier's leave breaks the carry off; its load is set down where it is (a lift's track
                // ended by name and gone back down, #5067). A side carrier's with the load's crew left does not (C5).
                self.carrier_leaves(&mut tree, activity, a.body, now, (a.id, a.soul))?;
                let e = &mut self.activities;
                e.next = tree.next();
                e.leave(
                    &mut tree,
                    c,
                    &mut self.moves,
                    &mut self.due,
                    &mut self.mint,
                    ask,
                    a.body,
                    activity,
                )?;
                // A carry ends with its activity: what it carried stays where the last sample put it.
                if self.activities.members(activity).is_none() {
                    self.carries.remove(&activity);
                    self.unhold(activity);
                    if let Some(s) = self.asm.as_mut() {
                        s.ended(activity);
                    }
                }
            }
            Verb::Steer | Verb::Land | Verb::Stop => {}
            Verb::Take | Verb::Unseat | Verb::Put => {
                // A lone holder of a seated part lays it down beside its bay (0.135 A2): it cannot carry it alone, and
                // B18 would keep it holding the part for good.
                if a.verb == Verb::Unseat
                    && let Some(activity) = a.target
                    && let Some([m]) = self.activities.members(activity)
                    && m.body == a.body
                {
                    let part = param_id(&a.params, 1, "take-needs-a-part")?;
                    return self.lay_down(
                        &mut tree,
                        c,
                        (a.id, a.soul),
                        activity,
                        a.body,
                        part,
                        now,
                    );
                }
                let asm = self
                    .asm
                    .as_mut()
                    .ok_or_else(|| refusal("seating-off", "the world's kinds join no parts"))?;
                let activity = target("part-needs-a-crew")?;
                let members = self
                    .activities
                    .members(activity)
                    .ok_or_else(|| refusal("activity-missing", show(activity)))?;
                if !members.iter().any(|m| m.body == a.body) {
                    return Err(refusal("not-a-member", show(a.body)));
                }
                // A crew of any size the carry takes (0.135 C5): its first two are its front and back, its sides
                // walk beside the part.
                let (front, back) = match members {
                    [f, b, ..] => (f.body, b.body),
                    _ => {
                        return Err(refusal(
                            "crew.size",
                            format!("{} has {} members", show(activity), members.len()),
                        ));
                    }
                };
                let ((ground, f), (_, k)) = (stands(c, front)?, stands(c, back)?);
                let by = (a.id, a.soul);
                if a.verb == Verb::Put {
                    let carry = self
                        .carries
                        .get(&activity)
                        .ok_or_else(|| refusal("part.not-held", show(activity)))?;
                    // #5067: a put waits for the lift's track to end; none while the load goes down.
                    if carry.lifting() {
                        self.hold(activity, a);
                        return Ok(());
                    }
                    if carry.lowering() {
                        return Err(refusal("carry-setting-down", show(activity)));
                    }
                    let from = carry
                        .track
                        .last()
                        .map(|(_, p, q)| (*p, *q))
                        .ok_or_else(|| refusal("part.not-held", show(activity)))?;
                    let to = param_id(&a.params, 1, "part-needs-a-place")?;
                    let slot = match a.params.get(&2) {
                        Some(Value::Uint(n)) => Some(*n),
                        None => None,
                        _ => return Err(refusal("part-needs-a-place", "parameter 2: a slot")),
                    };
                    let point = param_point(&a.params, 3, "part-needs-a-place")?;
                    let joins = match a.params.get(&4) {
                        Some(Value::Array(v)) => Some(
                            v.iter()
                                .map(read_id)
                                .collect::<Result<Vec<_>, _>>()
                                .map_err(|_| refusal("part-joins", "parameter 4: ids"))?,
                        ),
                        None => None,
                        _ => return Err(refusal("part-joins", "parameter 4: ids")),
                    };
                    let reach = slots.reach_of(front).min(slots.reach_of(back));
                    let effects = asm.put(
                        &mut tree,
                        &self.activities,
                        &self.mint,
                        now,
                        by,
                        activity,
                        (to, slot, point),
                        joins,
                        reach,
                        from,
                        ground,
                        apart(f, k),
                    )?;
                    self.carries.remove(&activity);
                    self.push(effects, Some(by));
                } else {
                    if self.carries.contains_key(&activity) {
                        return Err(refusal("carry-lifted", show(activity)));
                    }
                    let part = param_id(&a.params, 1, "take-needs-a-part")?;
                    // A part is taken by as many as carry it (0.135 C6: its `carry_crew`, else its hold crew) and by no
                    // more than its grips take (C5): a shade cloth by four to six. Refused before anyone moves.
                    if let Some(load) = tree
                        .handle(part)
                        .and_then(|h| tree.node(h))
                        .and_then(|n| self.loads.get(plain(n.kind().as_str())).copied())
                    {
                        let n = members.len();
                        if (n as u64) < load.crew {
                            return Err(refusal(
                                "carry-crew-too-small",
                                format!("{n} taking {}; it takes {}", show(part), load.crew),
                            ));
                        }
                        if n > load.most() {
                            return Err(refusal(
                                "carry-crew-too-large",
                                format!(
                                    "{n} taking {}; its grips take {}",
                                    show(part),
                                    load.most()
                                ),
                            ));
                        }
                    }
                    let (at, turn) = asm.take(
                        &mut tree,
                        &self.activities,
                        &mut self.mint,
                        now,
                        by,
                        activity,
                        part,
                        (f, k),
                        ground,
                        a.verb == Verb::Unseat,
                        slots.reach_of(front).min(slots.reach_of(back)),
                    )?;
                    // A crew's sides (0.135 C5) carry beside the part from where they stand at the take.
                    let sides = members[2..]
                        .iter()
                        .map(|m| {
                            stands(c, m.body).map(|(_, at)| (m.body, Carry::place_of(f, k, at)))
                        })
                        .collect::<R<Vec<_>>>()?;
                    self.taking
                        .insert(activity, (ground, at, turn, apart(f, k), sides));
                }
            }
            Verb::Lift | Verb::SetDown => {
                let activity = target("carry-needs-an-activity")?;
                // 0.135 C4: a carry is an activity whose kind has the slot a load rides in, for a thing.
                let kind = tree
                    .handle(activity)
                    .and_then(|h| tree.node(h))
                    .map(|n| n.kind().as_str().to_owned())
                    .ok_or_else(|| refusal("activity-missing", show(activity)))?;
                let carries = self.rules.kinds.get(&kind).is_some_and(|k| {
                    k.owner == "activity"
                        && k.slots
                            .get(&sim::activity::carry::SLOT)
                            .is_some_and(|s| s.contains("thing"))
                });
                if !carries {
                    return Err(refusal("not-a-carry", plain(&kind).to_owned()));
                }
                let members = self
                    .activities
                    .members(activity)
                    .ok_or_else(|| refusal("activity-missing", show(activity)))?;
                if !members.iter().any(|m| m.body == a.body) {
                    return Err(refusal("not-a-member", show(a.body)));
                }
                let crew = members.len();
                let (front, back) = match members {
                    [f, b, ..] => (f.body, b.body),
                    _ => return Err(refusal("carry-needs-two", show(activity))),
                };
                // 0.135 C5: the members after the first two carry beside the load, in join order. Only a lift reads
                // where they stand: a set-down never waits on a side whose body is gone.
                let side_bodies: Vec<Id> = members[2..].iter().map(|m| m.body).collect();
                if !self.activities.started(activity) {
                    // Never without its reason: a member held by another activity, say, or no accept yet.
                    let why = self.activities.unstarted_why(activity).unwrap_or_default();
                    return Err(refusal(
                        "activity-not-started",
                        format!("{}: {why}", show(activity)),
                    ));
                }
                let ((ground, f), (_, k)) = (stands(c, front)?, stands(c, back)?);
                // #5067: a lift or a set-down asked while the load is on its way down waits until it rests; a set-down
                // asked during the lift waits for the lift's end.
                if let Some(c) = self.carries.get(&activity)
                    && (c.lowering() || (a.verb == Verb::SetDown && c.lifting()))
                {
                    self.hold(activity, a);
                    return Ok(());
                }
                let transfer = self
                    .mint
                    .mint()
                    .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
                if a.verb == Verb::Lift {
                    if self.carries.contains_key(&activity) {
                        return Err(refusal("carry-lifted", show(activity)));
                    }
                    let sides = side_bodies
                        .iter()
                        .map(|b| stands(c, *b).map(|(_, at)| (*b, at)))
                        .collect::<R<Vec<_>>>()?;
                    let board = param_id(&a.params, 1, "lift-needs-a-thing")?;
                    // 0.135 C2: a load whose kind has an entry is checked as it states, before anything is written.
                    let node = tree
                        .handle(board)
                        .and_then(|h| tree.node(h))
                        .ok_or_else(|| refusal("lift-needs-a-thing", show(board)))?;
                    // 0.135 C4: only a load, a kind whose entry states its grips and crew, is carried.
                    let mut load =
                        *self.loads.get(plain(node.kind().as_str())).ok_or_else(|| {
                            refusal(
                                "lift-not-a-load",
                                format!("{} ({})", show(board), plain(node.kind().as_str())),
                            )
                        })?;
                    let pose = |e| refusal("carry-pose", format!("{e:?}"));
                    // Its middle, wherever its origin is (a laid-flat upright's is at its end).
                    let (middle, axis, lay) = match (node.parent(), node.place()) {
                        (Some(p), Some(at)) if p == ground => {
                            let m = at.orientation.rotate(load.middle).map_err(pose)?;
                            let middle = Vec3::new(at.position.x + m.x, 0, at.position.z + m.z);
                            (
                                middle,
                                load.lies_along(at.orientation)?,
                                (at.position, at.orientation),
                            )
                        }
                        _ => {
                            return Err(refusal(
                                "carry-grip-out-of-reach",
                                format!(
                                    "{} is not on the floor its carriers stand on",
                                    show(board)
                                ),
                            ));
                        }
                    };
                    // Its grips along its own long axis; the front at its − end lifts it the other way round.
                    let axis = match axis {
                        Some(v)
                            if i128::from(v[0]) * i128::from(f.x - k.x)
                                + i128::from(v[1]) * i128::from(f.z - k.z)
                                < 0 =>
                        {
                            load = load.reversed()?;
                            Some([-v[0], -v[1]])
                        }
                        v => v,
                    };
                    let to = param_point(&a.params, 2, "lift-destination")?;
                    let fixed = match to {
                        Some(_) => Some(
                            Fixed::of(&tree, ground).map_err(|e| refusal("carry-geometry", e))?,
                        ),
                        None => None,
                    };
                    let xz = |v: Vec3| [v.x, v.z];
                    load.check_lift(crew, xz(f), xz(k), xz(middle), axis)?;
                    let on_plan: Vec<(Id, [i64; 2])> =
                        sides.iter().map(|(b, at)| (*b, xz(*at))).collect();
                    load.check_sides(crew, xz(f), xz(k), xz(middle), axis, &on_plan)?;
                    // 0.135 R2, off the clock: the way to a destination is swept, and when the straight way clips one
                    // that turns the load is searched, on the way thread; the lift waits for it, nothing written, and
                    // runs again when it comes back. A way asked for other inputs (a carrier moved since, the ground
                    // changed) is asked again.
                    let way = match (to, fixed) {
                        (Some(to), Some(fixed)) => {
                            let ask = WayAsk {
                                intent: a.id,
                                load,
                                fixed: Arc::new(fixed),
                                front: xz(f),
                                back: xz(k),
                                to: xz(to),
                            };
                            match found {
                                Some((asked, way)) if asked.same(&ask) => way?,
                                _ => {
                                    self.waiting.insert(a.id, a.clone());
                                    self.asked.push(ask);
                                    return Ok(());
                                }
                            }
                        }
                        _ => None,
                    };
                    let audience = tree
                        .handle(activity)
                        .and_then(|h| tree.node(h))
                        .map(|n| n.audience())
                        .ok_or_else(|| refusal("activity-missing", show(activity)))?;
                    let mut carry = Carry::new(
                        activity,
                        board,
                        ground,
                        audience,
                        self.header.clone(),
                        self.rules.clone(),
                    );
                    carry.load = load;
                    // #5067: the lift is a track from where the load lies up into its carriers' hands, said at once.
                    let times = carry.lift(&mut tree, now, f, k, lay, transfer)?;
                    carry.sides = sides
                        .iter()
                        .map(|(b, at)| (*b, Carry::place_of(f, k, *at)))
                        .collect();
                    self.take(&mut carry, Some((a.id, a.soul)));
                    self.activities.next = tree.next();
                    let by = (now, Actor::Soul(a.soul), Cause::Intent(a.id));
                    self.activities.carry_track(
                        &mut tree,
                        activity,
                        board,
                        "souls:lift",
                        times,
                        None,
                        by,
                    )?;
                    // 0.135 R2: a way that turns the load is kept on the carry and said to its carriers after the lift.
                    if let Some(way) = way {
                        self.activities
                            .carry_way(&mut tree, activity, board, &way, by)?;
                        carry.way = way;
                    }
                    self.carries.insert(activity, carry);
                } else {
                    let carry = self
                        .carries
                        .get_mut(&activity)
                        .ok_or_else(|| refusal("not-carried", show(activity)))?;
                    let by = (a.id, a.soul);
                    // A set-down's track straight down to rest, said at once; the load leaves the slot at its end.
                    let times = carry.set_down(&tree, now, ground, f, k, Some(by), transfer)?;
                    let board = carry.board;
                    // Answered when the load rests.
                    self.answering.insert(activity, a.id);
                    self.activities.next = tree.next();
                    let w = (now, Actor::Soul(a.soul), Cause::Intent(a.id));
                    self.activities.carry_track(
                        &mut tree,
                        activity,
                        board,
                        "souls:set-down",
                        times,
                        None,
                        w,
                    )?;
                    // A crew's part set down is no longer its own (0.135 A2).
                    if let Some(s) = self.asm.as_mut() {
                        s.ended(activity);
                    }
                }
            }
        }
        // A crew started on a part ends the kept holds on it (0.135 A2).
        if a.verb == Verb::Accept
            && let Some(t) = a.target
            && self.activities.started(t)
            && let Some(part) = tree
                .handle(t)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.parent())
        {
            self.unkeep(&mut tree, part, t, ask)?;
        }
        self.begin_moves(&mut tree, c, now);
        self.collect(Some((a.id, a.soul)));
        Ok(())
    }

    /// Carrier `body` leaves `activity` (a leave, or its retire), for `by`'s intent and Soul, before the leave is
    /// written: a carry it is in breaks off, its load set down where it is (`souls:partner-left`, 0.135 C3), unless
    /// it is a side carrier and the load's crew is left without it (0.135 C5), when the carry goes on with its place
    /// empty and the world says so (`souls:carry-going-on`, `souls:carrier-left`).
    fn carrier_leaves(
        &mut self,
        tree: &mut Tree,
        activity: Id,
        body: Id,
        now: Micros,
        by: (Id, Id),
    ) -> R<()> {
        // One who is not a member of the carry leaves nothing it holds.
        if !self
            .activities
            .members(activity)
            .is_some_and(|m| m.iter().any(|m| m.body == body))
        {
            return Ok(());
        }
        let Some(mut carry) = self.carries.remove(&activity) else {
            return Ok(());
        };
        if let Some(i) = carry.sides.iter().position(|(b, _)| *b == body)
            && (carry.sides.len() + 1) as u64 >= carry.load.crew
        {
            carry.sides.remove(i);
            let word = (now, Actor::Soul(by.1), Cause::Intent(by.0));
            let (load, e) = (carry.board, &mut self.activities);
            self.carries.insert(activity, carry);
            e.next = tree.next();
            return e.load_word(
                tree,
                activity,
                load,
                "souls:carry-going-on",
                "souls:carrier-left",
                word,
            );
        }
        break_off(
            &mut carry,
            &mut self.activities,
            tree,
            now,
            None,
            "souls:partner-left",
            Some(by),
        )?;
        // #5067: the load goes down on its track, its node kept until it rests. The last member going (a retire: a
        // leave of the last waits) takes the node with it, so its load is set down at once.
        let last = self
            .activities
            .members(activity)
            .is_some_and(|m| m.len() == 1);
        if last && carry.lowering() {
            if let Some(h) = carry.hoist.as_mut() {
                h.t1 = now;
            }
            let mint = &mut self.mint;
            carry.lower(tree, now, || {
                mint.mint()
                    .map_err(|e| refusal("id-counter-exhausted", e.to_string()))
            })?;
            let effects: Vec<Effect> = carry.log.parts.drain(..).flatten().collect();
            self.activities.stream.extend(effects);
            self.activities.next = tree.next();
            self.unhold(activity);
        } else if carry.lowering() {
            self.carries.insert(activity, carry);
        }
        // The front's own leave lets it walk on; a partner's stops the front's walk with the carry.
        if self.led.get(&activity).is_some_and(|l| l.front != body) {
            self.broke.insert(activity, "souls:partner-left");
        }
        if let Some(s) = self.asm.as_mut() {
            s.ended(activity);
        }
        Ok(())
    }

    fn take(&mut self, carry: &mut Carry, by: Option<(Id, Id)>) {
        let effects: Vec<Effect> = carry.log.parts.drain(..).flatten().collect();
        self.push(effects, by);
    }

    fn push(&mut self, effects: Vec<Effect>, by: Option<(Id, Id)>) {
        for mut e in effects {
            if let Some((intent, soul)) = by {
                e.envelope.cause = Cause::Intent(intent);
                e.envelope.actor = Actor::Soul(soul);
            }
            self.out.push(e);
        }
    }

    /// Moves the writers' entries to [`Engine::out`], caused by `by`'s intent and acted by its Soul.
    fn collect(&mut self, by: Option<(Id, Id)>) {
        let mut effects: Vec<Effect> = self.activities.stream.drain(..).collect();
        for c in self.carries.values_mut() {
            effects.extend(c.log.parts.drain(..).flatten());
        }
        self.push(effects, by);
    }

    /// The engine's part of a tick at `now`: its due timers (a leave let go, an offer or a pair lapsed), then one
    /// sample of each carry between its carriers, checked against the fixed geometry of its ground as the walkers'
    /// ground `versions` have it (0.135 C7).
    pub fn tick(
        &mut self,
        live: &Tree,
        c: &mut Controller,
        slots: &mut Slots,
        versions: &sim::ground::Versions,
        now: Micros,
    ) {
        if !self.steered.is_empty() {
            let home = crate::carrier::settle(live, slots, &mut self.steered, now);
            self.out.extend(home);
        }
        // A ride that flies a loop from its stop and was seeded with no course (Eden's launch balloon on a world seeded
        // before its rides flew) is given its course at the start's first tick: from now, at its home, so it stands
        // there for its boarding minute first and never jumps onto its loop.
        for (thing, mut c) in slots.courses_given() {
            let Some(n) = live.handle(thing).and_then(|h| live.node(h)) else {
                continue;
            };
            if n.fields().contains_key(&replica::schedule::F_COURSE) {
                continue;
            }
            // Its course was laid from where it stood at the start. A god edit that moved it since (and gave it no
            // seats, `import_eden::body_slots_of`) leaves it standing: the next start lays one from where it is.
            let home = c.stations.first().map_or(Vec3::ZERO, |s| s.at);
            if n.place().map(|p| p.position) != Some(home) {
                eprintln!(
                    "worldd: {} moved before its course was given: none given",
                    show(thing)
                );
                continue;
            }
            c.t0 = now;
            let e = slots.moving(thing, &c, home).and_then(|()| {
                crate::carrier::entry(
                    live,
                    thing,
                    vec![crate::carrier::set(
                        thing,
                        replica::schedule::F_COURSE,
                        c.to_value(),
                    )],
                    now,
                    Cause::World,
                    Actor::World,
                )
            });
            match e {
                Ok(e) => self.out.push(e),
                Err(r) => eprintln!("worldd: {}'s course is not written: {r}", show(thing)),
            }
        }
        // N14: the courses of the rides whose runs were registered (a start) or registered again (a god edit).
        let changed = slots.runs_changed();
        if !changed.is_empty() {
            self.out.extend(slot_courses(live, slots, &changed, now));
        }
        // N14: a ride's trip ends when its seats next come to a stop: what its start form set goes back (a cable car's
        // `under_way`), so a ride set off once is boarded again.
        for (thing, ends) in slots.trip_ended(now) {
            self.out.extend(trip_end(live, thing, &ends, now));
        }
        let mut tree = None;
        while let Some(t) = self.due.fire(now) {
            let tr = tree.get_or_insert_with(|| live.frozen());
            self.activities.next = tr.next();
            // A role's move (0.134 T1): its phases end here, and at contact its reach is asked again.
            let aimed = self
                .moves
                .instance_of(&t)
                .and_then(|n| self.moves.record(n));
            if let Some((body, target)) = aimed.map(|r| (r.body, r.target)) {
                let feet = Feet::of(c, tr, &self.entries, [body, target]);
                let _ = self.moves.fire(c, &mut self.due, &mut self.mint, &feet, &t);
                continue;
            }
            if self
                .activities
                .fire(c, &mut self.moves, &mut self.due, &t)
                .is_none()
            {
                let _ = self.activities.lapse(tr, c, &mut self.due, &t);
            }
        }
        if let Some(tr) = tree.as_mut() {
            self.begin_moves(tr, c, now);
        }
        // B10: a creator's edit that removed a thing took the activity bound to it: its members are let go at once.
        if self.activities.stranded(live) {
            let tr = tree.get_or_insert_with(|| live.frozen());
            self.activities.next = tr.next();
            for a in self.activities.release_gone(tr, c, now) {
                self.carries.remove(&a);
                self.unhold(a);
            }
        }
        // B10: an unstarted activity past its expiry that no offer or pair waits on (a proposal, or an offer a restart
        // did not keep) ends, with its role links.
        if self.activities.expiring(now) {
            let tr = tree.get_or_insert_with(|| live.frozen());
            self.activities.next = tr.next();
            self.activities.expire(tr, now);
        }
        let _ = self.activities.settle(c, &self.moves, &mut self.due);
        // A handshake, a hug or a high-five whose moves have ended ends: both arms free (0.134 T1).
        if self.activities.finishing() {
            let tr = tree.get_or_insert_with(|| live.frozen());
            self.activities.next = tr.next();
            for (body, r) in
                self.activities
                    .finish(tr, c, &mut self.moves, &mut self.due, &mut self.mint, now)
            {
                eprintln!("worldd: {} did not leave its touch: {r}", show(body));
            }
        }
        // 0.135 C3: loads found riding at a restart are set down where their carry last had them.
        for (activity, load) in std::mem::take(&mut self.riding) {
            let tr = tree.get_or_insert_with(|| live.frozen());
            let found = tr.handle(activity).and_then(|h| tr.node(h)).and_then(|n| {
                Some((
                    n.parent()?,
                    n.audience(),
                    n.place().map(|p| (p.position, p.orientation))?,
                ))
            });
            let Some((ground, audience, here)) = found else {
                continue;
            };
            let mut carry = Carry::new(
                activity,
                load,
                ground,
                audience,
                self.header.clone(),
                self.rules.clone(),
            );
            // 0.135 C4: set down the way it is held, as its entry states it.
            if let Some((l, held)) = tr.handle(load).and_then(|h| tr.node(h)).and_then(|n| {
                Some((
                    self.loads.get(plain(n.kind().as_str()))?,
                    n.place()?.orientation,
                ))
            }) {
                carry.load = l.held_turned(held).unwrap_or(Load { turn: held, ..*l });
            }
            // #5067: from where the node is, down a set-down's track to rest on its carriers' floor (a lift cut off
            // by the restart left the node between the floor and carrying height).
            let floor = self
                .activities
                .members(activity)
                .unwrap_or(&[])
                .iter()
                .find_map(|m| stands(c, m.body).ok())
                .map(|(_, at)| at.y);
            match break_off(
                &mut carry,
                &mut self.activities,
                tr,
                now,
                Some((here, floor)),
                "souls:world-restarted",
                None,
            ) {
                Ok(()) if carry.lowering() => {
                    self.carries.insert(activity, carry);
                }
                Ok(()) => {}
                Err(r) => eprintln!(
                    "worldd: {} was not set down after the restart: {r}",
                    show(load)
                ),
            }
        }
        if !self.carries.is_empty() {
            let tr = tree.get_or_insert_with(|| live.frozen());
            let mut gone = Vec::new();
            let mut apart = Vec::new();
            let mut step = Vec::new();
            let mut lower = Vec::new();
            for (activity, carry) in &self.carries {
                // #5067: a load on its way down keeps to its track, whoever has gone.
                if carry.lowering() {
                    lower.push(*activity);
                    continue;
                }
                let carriers = self
                    .activities
                    .members(*activity)
                    .map(|m| m.iter().map(|m| m.body).collect::<Vec<_>>());
                let (f, k) = match carriers.as_deref() {
                    Some([f, k, ..]) => (*f, *k),
                    _ => {
                        gone.push(*activity);
                        continue;
                    }
                };
                // A carrier with no body (retired, or gone from the world) has left (0.135 A2's review).
                let (Ok((_, f)), Ok((_, k))) = (stands(c, f), stands(c, k)) else {
                    gone.push(*activity);
                    continue;
                };
                // 0.135 C5: a side carrier with no body has left, as its ends.
                let mut sides = BTreeMap::new();
                for (b, _) in &carry.sides {
                    if let Ok((_, at)) = stands(c, *b) {
                        sides.insert(*b, at);
                    }
                }
                if sides.len() < carry.sides.len() {
                    gone.push(*activity);
                    continue;
                }
                // 0.135 C3: one stopped (or its connection is gone) while the other walked on; C5, a side carrier
                // drifted from its place.
                if carry.stretched(f, k) || carry.side_apart(f, k, &sides).is_some() {
                    apart.push(*activity);
                } else {
                    step.push((*activity, f, k));
                }
            }
            for (list, why) in [
                (gone, "souls:partner-left"),
                (apart, "souls:carriers-apart"),
            ] {
                for a in list {
                    let Some(mut carry) = self.carries.remove(&a) else {
                        continue;
                    };
                    match break_off(&mut carry, &mut self.activities, tr, now, None, why, None) {
                        // A crew's part set down is no longer its own (0.135 A2).
                        Ok(()) => {
                            if carry.lowering() {
                                self.carries.insert(a, carry);
                            }
                            if self.led.contains_key(&a) {
                                self.broke.insert(a, why);
                            }
                            if let Some(s) = self.asm.as_mut() {
                                s.ended(a);
                            }
                        }
                        Err(r) => eprintln!("worldd: a carry was not set down: {r}"),
                    }
                }
            }
            // 0.135 C7: every step is checked against its ground's fixed geometry, read again only when the walkers'
            // ground has changed since (`versions`, G3's) or a carry on it has begun or ended (a load taken, lifted or
            // set down, which no walker's map sees); each carry by its activity and when it began, as a crew's id
            // outlives its carry (set down, then taking another part). A step into it stops the carry, its load set
            // down where its last sample had it.
            let mut on: BTreeMap<Id, Vec<(Id, Micros)>> = BTreeMap::new();
            for (a, c) in &self.carries {
                let began = c.track.first().map_or(0, |s| s.0);
                on.entry(c.ground).or_default().push((*a, began));
            }
            let mut unread = BTreeMap::new();
            for (ground, carries) in on {
                let fresh = self
                    .fixed
                    .get(&ground)
                    .is_some_and(|(v, c, _)| v == versions && *c == carries);
                if fresh {
                    continue;
                }
                match Fixed::of(tr, ground) {
                    Ok(g) => {
                        self.fixed.insert(ground, (versions.clone(), carries, g));
                    }
                    Err(e) => {
                        self.fixed.remove(&ground);
                        unread.insert(ground, e);
                    }
                }
            }
            let mut blocked = Vec::new();
            for (activity, f, k) in step {
                let Some(carry) = self.carries.get_mut(&activity) else {
                    continue;
                };
                if let Some(e) = unread.get(&carry.ground) {
                    eprintln!("worldd: the carry {} stopped: {e}", show(activity));
                    blocked.push(activity);
                    continue;
                }
                let lifting = carry.hoist.filter(|_| carry.lifting());
                let done = match self.fixed.get(&carry.ground) {
                    Some((_, _, g)) => carry.step(tr, now, f, k, g),
                    None => Err(refusal("carry-geometry", show(carry.ground))),
                };
                // Every entry leaves in the order it was written: the carries' samples with the words between them.
                let (board, ended) = (carry.board, lifting.is_some() && !carry.lifting());
                self.activities
                    .stream
                    .extend(carry.log.parts.drain(..).flatten());
                if let (Some(h), true) = (lifting, ended) {
                    // #5067: the lift's track ended, the load in its carriers' hands.
                    self.activities.next = tr.next();
                    let w = (now, Actor::World, Cause::World);
                    if let Err(r) = self.activities.carry_track(
                        tr,
                        activity,
                        board,
                        "souls:lifted",
                        (h.t0, now),
                        None,
                        w,
                    ) {
                        eprintln!("worldd: a lift's end was not said: {r}");
                    }
                    self.unhold(activity);
                }
                match done {
                    Ok(()) => {}
                    Err(r) if r.name == "carry-load-blocked" || r.name == "carry-geometry" => {
                        eprintln!("worldd: the carry {} stopped: {r}", show(activity));
                        blocked.push(activity);
                    }
                    Err(r) => eprintln!("worldd: a carry's sample was not written: {r}"),
                }
            }
            for a in blocked {
                let Some(mut carry) = self.carries.remove(&a) else {
                    continue;
                };
                match break_off(
                    &mut carry,
                    &mut self.activities,
                    tr,
                    now,
                    None,
                    "souls:carry-blocked",
                    None,
                ) {
                    // A crew's part set down is no longer its own (0.135 A2).
                    Ok(()) => {
                        if carry.lowering() {
                            self.carries.insert(a, carry);
                        }
                        if self.led.contains_key(&a) {
                            self.broke.insert(a, "souls:carry-blocked");
                        }
                        if let Some(s) = self.asm.as_mut() {
                            s.ended(a);
                        }
                    }
                    Err(r) => eprintln!("worldd: a carry was not set down: {r}"),
                }
            }
            // #5067: each load on its way down, one sample a tick; at its track's end it rests, out of the crew's slot,
            // and the carry is over.
            for a in lower {
                let Some(carry) = self.carries.get_mut(&a) else {
                    continue;
                };
                let h = carry.hoist;
                let mint = &mut self.mint;
                let landed = carry.lower(tr, now, || {
                    mint.mint()
                        .map_err(|e| refusal("id-counter-exhausted", e.to_string()))
                });
                let by = h.and_then(|h| h.by);
                let effects: Vec<Effect> = carry.log.parts.drain(..).flatten().collect();
                let board = carry.board;
                for mut e in effects {
                    if let Some((intent, soul)) = by {
                        e.envelope.cause = Cause::Intent(intent);
                        e.envelope.actor = Actor::Soul(soul);
                    }
                    self.activities.stream.push(e);
                }
                match landed {
                    Ok(false) => {}
                    Ok(true) => {
                        self.carries.remove(&a);
                        self.unhold(a);
                        let Some(h) = h else { continue };
                        self.activities.next = tr.next();
                        let w = match by {
                            Some((intent, soul)) => (now, Actor::Soul(soul), Cause::Intent(intent)),
                            None => (now, Actor::World, Cause::World),
                        };
                        if let Err(r) = self.activities.carry_track(
                            tr,
                            a,
                            board,
                            "souls:released",
                            (h.t0, now),
                            None,
                            w,
                        ) {
                            eprintln!("worldd: a set-down's end was not said: {r}");
                        }
                    }
                    Err(r) => {
                        // Never stuck: a set-down that cannot be written is ended, its load where its last sample is.
                        eprintln!("worldd: a carry's set-down was not written: {r}");
                        self.carries.remove(&a);
                        self.unhold(a);
                    }
                }
            }
        }
        if let Some(s) = self.asm.as_mut()
            && s.setting_in()
        {
            let tr = tree.get_or_insert_with(|| live.frozen());
            s.due(tr, &self.activities, &mut self.mint, now);
        }
        if let Some(tr) = tree.as_mut() {
            self.stop_refused(tr, now);
            self.came_back(tr, c, now);
        }
        self.collect(None);
    }

    /// The seatings refused at their track's end or at their commit (0.135 A2): each crew's node handed back from its
    /// track to its mover where the track ended, and its carry started again from there, the part still in its slot.
    fn stop_refused(&mut self, tree: &mut Tree, now: Micros) {
        let Some(asm) = self.asm.as_mut() else { return };
        let mut written = std::mem::take(&mut asm.moved);
        for (activity, s) in std::mem::take(&mut asm.stopped) {
            let by = s.by;
            match asm.stop(tree, now, activity, s) {
                Ok(effects) => written.push((by, effects)),
                Err(r) => eprintln!(
                    "worldd: a refused seating was not stopped: {}: {r}",
                    show(activity)
                ),
            }
        }
        self.send(written);
    }

    fn send(&mut self, written: Vec<((Id, Id), Vec<Effect>)>) {
        for ((intent, soul), effects) in written {
            for mut e in effects {
                e.envelope.cause = Cause::Intent(intent);
                e.envelope.actor = Actor::Soul(soul);
                self.out.push(e);
            }
        }
    }

    /// The crews' nodes back where their refused set-in started (0.135 A2): each crew's carry starts again there when
    /// its carriers' middle is still within [`BACK_SLACK`] of it; else (they walked off meanwhile) it breaks off there
    /// and the part is set down where it is (C3), never pulled to where they went.
    fn came_back(&mut self, tree: &mut Tree, c: &Controller, now: Micros) {
        let Some(asm) = self.asm.as_mut() else { return };
        let back = asm.returned(tree, now);
        for (activity, s, effects) in back {
            self.send(vec![(s.by, effects)]);
            let Some(audience) = tree
                .handle(activity)
                .and_then(|h| tree.node(h))
                .map(|n| n.audience())
            else {
                continue;
            };
            let mut carry = Carry::new(
                activity,
                s.part,
                s.ground,
                audience,
                self.header.clone(),
                self.rules.clone(),
            );
            carry.track.push((now, s.start.0, s.start.1));
            carry.span = s.span;
            if let Some(l) = self.held_load(tree, s.part) {
                carry.load = l;
            }
            let middle = match self.activities.members(activity) {
                Some([f, k, ..]) => match (stands(c, f.body), stands(c, k.body)) {
                    (Ok((_, f)), Ok((_, k))) => Some([(f.x + k.x) / 2, (f.z + k.z) / 2]),
                    _ => None,
                },
                _ => None,
            };
            let near =
                middle.is_some_and(|m| apart(Vec3::new(m[0], 0, m[1]), s.start.0) <= BACK_SLACK);
            if near {
                self.carries.insert(activity, carry);
                continue;
            }
            match break_off(
                &mut carry,
                &mut self.activities,
                tree,
                now,
                None,
                "souls:carriers-apart",
                Some(s.by),
            ) {
                Ok(()) => {
                    if carry.lowering() {
                        self.carries.insert(activity, carry);
                    }
                    if let Some(asm) = self.asm.as_mut() {
                        asm.ended(activity);
                    }
                }
                Err(r) => eprintln!("worldd: a crew's part was not set down: {r}"),
            }
        }
    }

    /// Body `body` leaves the world (C3's retire, at `now`, for `intent` of `soul`): it leaves every activity it is a
    /// member of, as a leave (a carry it was in breaks off, `souls:partner-left`, its part set down where it is), so its
    /// partners are free to lay a part down, take it over or leave. The entries, to be written before the body goes.
    pub fn retiring(
        &mut self,
        live: &Tree,
        c: &mut Controller,
        body: Id,
        intent: Id,
        soul: Id,
        now: Micros,
    ) -> Vec<Effect> {
        let mut tree = live.frozen();
        let ask = Ask {
            soul,
            intent,
            at: now,
        };
        for activity in self.activities.ids() {
            let member = self
                .activities
                .members(activity)
                .is_some_and(|m| m.iter().any(|m| m.body == body));
            if !member {
                continue;
            }
            if let Err(r) = self.carrier_leaves(&mut tree, activity, body, now, (intent, soul)) {
                eprintln!("worldd: a carry was not set down at a retire: {r}");
            }
            self.activities.next = tree.next();
            let left = self.activities.leave(
                &mut tree,
                c,
                &mut self.moves,
                &mut self.due,
                &mut self.mint,
                ask,
                body,
                activity,
            );
            // The last holder of a part B18 would leave hanging: the part is set down as its retire's first step
            // (laid beside its bay, or where it stands), each part that hangs by it laid down before it, all checked by
            // B18 together; when that cannot be done whole, the structure is kept as it stands, its hold left for
            // another crew to take over. Named in the retire's entries; B18 is never broken by a Soul going.
            if left.as_ref().is_err_and(|r| r.name == "support.none")
                && let Some(part) = tree
                    .handle(activity)
                    .and_then(|h| tree.node(h))
                    .and_then(|n| n.parent())
            {
                match self.holder_left(&mut tree, c, body, activity, part, now, (intent, soul)) {
                    Ok(()) => continue,
                    Err(r) => eprintln!("worldd: a retiring holder's hold was not kept: {r}"),
                }
            }
            if let Err(r) = left {
                eprintln!(
                    "worldd: {} did not leave {} as it retired: {r}",
                    show(body),
                    show(activity)
                );
            }
            if self.activities.members(activity).is_none()
                && let Some(s) = self.asm.as_mut()
            {
                s.ended(activity);
            }
        }
        self.activities
            .stream
            .drain(..)
            .map(|mut e| {
                e.envelope.cause = Cause::Intent(intent);
                e.envelope.actor = Actor::Soul(soul);
                e
            })
            .collect()
    }

    /// The last holder `body` of crew `activity` leaves the world while it holds `part` in its bay (0.135 A2), for
    /// `by` (intent, Soul) at `now`. Its hold is kept at once: it keeps counting, for B18, the holders it has now
    /// ([`sim::structure::F_KEPT`]), so the bay stays as B18 had it once the body (and its membership link) is gone.
    /// When the structure can be set down ([`Engine::retire_plan`]), that set-down waits in `Assembly::ready` to be
    /// written as an unseat is, through the walkers' maps and G2 (`crate::answers`), the kept hold's node removed in
    /// the same part; refused there, or with no plan, the hold stays kept (`souls:holder-left-structure-kept`) until
    /// another crew holds, takes or unseats the part ([`Engine::unkeep`]).
    #[allow(clippy::too_many_arguments)]
    fn holder_left(
        &mut self,
        tree: &mut Tree,
        c: &Controller,
        body: Id,
        activity: Id,
        part: Id,
        now: Micros,
        by: (Id, Id),
    ) -> R<()> {
        let crew_audience = tree
            .handle(activity)
            .and_then(|h| tree.node(h))
            .map(|n| n.audience())
            .ok_or_else(|| refusal("activity-missing", show(activity)))?;
        let plan = self
            .retire_plan(tree, c, body, activity, part, crew_audience, now, by)
            .unwrap_or_else(|r| {
                eprintln!("worldd: a retiring holder's part has no set-down: {r}");
                None
            });
        let holding = tree
            .handle(activity)
            .and_then(|h| tree.links_of(h))
            .unwrap_or(&[])
            .iter()
            .filter(|e| tree.ty(e).as_str() == replica::activity::MEMBER)
            .count()
            .max(1) as u64;
        self.mark(tree, now, activity, crew_audience, holding)?;
        match (plan, self.asm.as_mut()) {
            (Some(effects), Some(asm)) => asm.ready.push(crate::assembly::Ready {
                intent: by.0,
                soul: by.1,
                activity,
                step: crate::assembly::Step::Retired,
                effects,
            }),
            _ => self.kept_word(tree, activity, part, now, by)?,
        }
        Ok(())
    }

    /// The world's word that kept hold `activity` on `part` stays (`souls:hold-kept`,
    /// `souls:holder-left-structure-kept`), for `by` at `now`.
    fn kept_word(
        &mut self,
        tree: &mut Tree,
        activity: Id,
        part: Id,
        now: Micros,
        by: (Id, Id),
    ) -> R<()> {
        self.activities.next = tree.next();
        self.activities.hold_kept(
            tree,
            activity,
            part,
            "souls:holder-left-structure-kept",
            (now, Actor::Soul(by.1), Cause::Intent(by.0)),
        )
    }

    /// How a retiring last holder's structure is set down (0.135 A2): each part joined to `part` in the bay (it would
    /// hang by it) laid down first as a lone holder's lay-down lays a part ([`Engine::lay_place`], with no reach), then
    /// `part` itself ([`Engine::holder_rest`]), the set-down named (`souls:carry-set-down`), and the crew's node
    /// removed: one part's entries, caused by `by`. B18 judges all of it together against the tree as it was. `None`
    /// when a part has no room or B18 refuses.
    #[allow(clippy::too_many_arguments)]
    fn retire_plan(
        &mut self,
        tree: &Tree,
        c: &Controller,
        body: Id,
        activity: Id,
        part: Id,
        crew_audience: replica::world_model::Audience,
        now: Micros,
        by: (Id, Id),
    ) -> R<Option<Vec<Effect>>> {
        let audience =
            |t: &Tree, id: Id| t.handle(id).and_then(|h| t.node(h)).map(|n| n.audience());
        let ground = stands(c, body)?.0;
        let mut scratch = tree.frozen();
        let mut laid: Vec<Effect> = Vec::new();
        let mut room = true;
        for hanging in self.joined_in_bay(tree, part) {
            let skip = self.joined_in_bay(&scratch, hanging);
            let Some(a) = audience(&scratch, hanging) else {
                room = false;
                break;
            };
            let Ok((_, place, yaw, load)) =
                self.lay_place(&scratch, c, body, hanging, false, &skip)
            else {
                room = false;
                break;
            };
            let mut carry = Carry::new(
                hanging,
                hanging,
                ground,
                a,
                self.header.clone(),
                self.rules.clone(),
            );
            // Its joints undone, each by the node that owns the link, then the part laid down.
            let unlinks = self.joints_of(&scratch, hanging, a);
            if !unlinks.is_empty() {
                carry.log.next = scratch.next();
                carry.log.write(&mut scratch, now, unlinks)?;
            }
            carry.load = load;
            carry.track.push((now, place, yaw));
            let transfer = self
                .mint
                .mint()
                .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
            carry.set_down_here(&mut scratch, now, ground, None, transfer)?;
            laid.extend(carry.log.parts.drain(..).flatten());
        }
        let rest = match room {
            true => self.holder_rest(&scratch, c, body, part, ground),
            false => None,
        };
        let (header, rules) = (self.header.clone(), self.rules.clone());
        let held = |load: Load, place: Vec3, yaw: replica::pose::Quat| {
            let mut carry = Carry::new(
                activity,
                part,
                ground,
                crew_audience,
                header.clone(),
                rules.clone(),
            );
            carry.load = load;
            carry.track.push((now, place, yaw));
            carry
        };
        // B18 on the whole set-down, as the tree was.
        let whole = match (&rest, self.asm.as_ref()) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some((load, place, yaw, _)), Some(asm)) => {
                let mut probe = held(*load, *place, *yaw);
                let mut t = scratch.frozen();
                let transfer = self
                    .mint
                    .mint()
                    .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
                probe.set_down_here(&mut t, now, ground, None, transfer)?;
                let mut all = laid.clone();
                all.extend(probe.log.parts.drain(..).flatten());
                asm.structure().check(tree, &all).is_ok()
            }
        };
        let Some((load, place, yaw, why)) = rest.filter(|_| whole) else {
            return Ok(None);
        };
        let mut effects = laid;
        let mut carry = held(load, place, yaw);
        let transfer = self
            .mint
            .mint()
            .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
        carry.set_down_here(&mut scratch, now, ground, None, transfer)?;
        effects.extend(carry.log.parts.drain(..).flatten());
        self.activities.next = scratch.next();
        let n = self.activities.stream.len();
        self.activities.carry_set_down(
            &mut scratch,
            activity,
            part,
            why,
            (now, Actor::Soul(by.1), Cause::Intent(by.0)),
        )?;
        effects.extend(self.activities.stream.drain(n..));
        {
            use replica::effects::{Body, Change, ChangeRec, Rest};
            let mut log = sim::slots::hands::Log::new(
                self.header.clone(),
                self.rules.clone(),
                scratch.next(),
            );
            log.write(
                &mut scratch,
                now,
                vec![(
                    activity,
                    crew_audience,
                    Body::Changes(vec![ChangeRec {
                        change: Change::Remove { node: activity },
                        rest: Rest::new(),
                    }]),
                )],
            )?;
            effects.extend(log.parts.drain(..).flatten());
        }
        for e in &mut effects {
            e.envelope.cause = Cause::Intent(by.0);
            e.envelope.actor = Actor::Soul(by.1);
        }
        Ok(Some(effects))
    }

    /// Sets crew `activity`'s kept holders ([`sim::structure::F_KEPT`]) to `holding` on `tree`, its entry added to the
    /// activities' entries.
    fn mark(
        &mut self,
        tree: &mut Tree,
        now: Micros,
        activity: Id,
        audience: replica::world_model::Audience,
        holding: u64,
    ) -> R<()> {
        use replica::effects::{Body, Change, ChangeRec, Rest};
        let mut log =
            sim::slots::hands::Log::new(self.header.clone(), self.rules.clone(), tree.next());
        let set = Change::Set {
            node: activity,
            field: sim::structure::F_KEPT,
            to: Value::Uint(holding),
            by: None,
        };
        log.write(
            tree,
            now,
            vec![(
                activity,
                audience,
                Body::Changes(vec![ChangeRec {
                    change: set,
                    rest: Rest::new(),
                }]),
            )],
        )?;
        self.activities.stream.extend(log.parts.drain(..).flatten());
        self.activities.next = tree.next();
        Ok(())
    }

    /// Another crew, `activity`, holds `part` now, or has taken or unseated it (0.135 A2): every kept hold on it (its
    /// last holder gone, [`Engine::holder_left`]) ends, its node removed and forgotten, for `ask`.
    fn unkeep(&mut self, tree: &mut Tree, part: Id, activity: Id, ask: Ask) -> R<()> {
        let kept: Vec<Id> = tree
            .handle(part)
            .and_then(|h| tree.children(h))
            .unwrap_or(&[])
            .iter()
            .filter_map(|h| tree.node(*h))
            .filter(|n| n.id() != activity)
            .filter(|n| {
                matches!(n.fields().get(&sim::structure::F_KEPT), Some(Value::Uint(k)) if *k > 0)
            })
            .map(|n| n.id())
            .collect();
        for k in kept {
            self.activities.next = tree.next();
            self.activities.forget(tree, k, ask)?;
            if let Some(s) = self.asm.as_mut() {
                s.ended(k);
            }
        }
        Ok(())
    }

    /// The parts of `part`'s bay joined to it (B18's joints): each would hang by it.
    fn joined_in_bay(&self, tree: &Tree, part: Id) -> Vec<Id> {
        let Some(s) = self.asm.as_ref().map(|a| a.structure()) else {
            return Vec::new();
        };
        let node = |id: Id| tree.handle(id).and_then(|h| tree.node(h));
        let Some(ph) = tree.handle(part) else {
            return Vec::new();
        };
        let bay = node(part).and_then(|n| n.parent());
        let mut out = Vec::new();
        for e in tree.links_of(ph).unwrap_or(&[]) {
            if !s.joint(tree.ty(e).as_str()) {
                continue;
            }
            let Some((_, ends, _, _)) = tree.link(e.link) else {
                continue;
            };
            let other = if ends[0] == part { ends[1] } else { ends[0] };
            let in_bay =
                node(other).is_some_and(|n| s.is_part(n.kind().as_str()) && n.parent() == bay);
            if in_bay && !out.contains(&other) {
                out.push(other);
            }
        }
        out
    }

    /// The entries undoing `part`'s joints, each written by the node that owns the link (as an unseat undoes them).
    fn joints_of(
        &self,
        tree: &Tree,
        part: Id,
        audience: replica::world_model::Audience,
    ) -> Vec<sim::slots::hands::Entry> {
        use replica::effects::{Body, Change, ChangeRec, Rest};
        let Some(s) = self.asm.as_ref().map(|a| a.structure()) else {
            return Vec::new();
        };
        let Some(ph) = tree.handle(part) else {
            return Vec::new();
        };
        tree.links_of(ph)
            .unwrap_or(&[])
            .iter()
            .filter(|e| s.joint(tree.ty(e).as_str()))
            .filter_map(|e| {
                let (_, ends, owner, _) = tree.link(e.link)?;
                let by = ends[usize::from(owner == replica::world_model::End::Second)];
                Some((
                    by,
                    audience,
                    Body::Changes(vec![ChangeRec {
                        change: Change::Unlink { link: e.link },
                        rest: Rest::new(),
                    }]),
                ))
            })
            .collect()
    }

    /// Where a retiring last holder `body` sets its seated `part` down on `ground` (0.135 A2): laid beside its bay
    /// when it is within reach and a side is free ([`Engine::lay_place`], `souls:holder-left`); else laid flat where
    /// it stands, as its entry lays it, when that resting outline is clear (`souls:holder-left-flat`); else left
    /// standing as it is (`souls:holder-left-standing`). Either of the last two rests on the part's own base, the
    /// ground under it (raised or sloped terrain included). Its load, the middle of its resting place at carrying
    /// height (C3's set-down takes it down from there), its turn, and why; `None` when it has no place on `ground`.
    fn holder_rest(
        &self,
        tree: &Tree,
        c: &Controller,
        body: Id,
        part: Id,
        ground: Id,
    ) -> Option<(Load, Vec3, replica::pose::Quat, &'static str)> {
        if let Ok((_, place, yaw, load)) = self.lay_place(tree, c, body, part, true, &[]) {
            return Some((load, place, yaw, "souls:holder-left"));
        }
        let entry = tree
            .handle(part)
            .and_then(|h| tree.node(h))
            .and_then(|n| self.loads.get(plain(n.kind().as_str())).copied())
            .unwrap_or_else(Load::board);
        let st = tree
            .handle(part)
            .zip(tree.handle(ground))
            .and_then(|(p, g)| sim::ground::scene::xform_to(tree, p, g).ok())?;
        let ax = st
            .rot
            .rotate(Vec3::new(1_000_000, 0, 0))
            .map_or([1_000_000, 0], |v| [v.x, v.z]);
        let yaw = sim::activity::carry::yaw_toward(ax).unwrap_or(replica::pose::Quat::IDENTITY);
        let a = [
            (i128::from(ax[0]) * i128::from(entry.half_length) / 1_000_000) as i64,
            (i128::from(ax[1]) * i128::from(entry.half_length) / 1_000_000) as i64,
        ];
        let flat = sim::activity::carry::outline(
            [st.pos.x + a[0], st.pos.z + a[1]],
            [st.pos.x - a[0], st.pos.z - a[1]],
            &entry,
        );
        let over = Vec3::new(st.pos.x, st.pos.y + sim::activity::carry::HEIGHT, st.pos.z);
        if self.room_at(tree, c, ground, part, &flat, body) {
            return Some((entry, over, yaw, "souls:holder-left-flat"));
        }
        let standing = Load {
            turn: st.rot,
            middle: Vec3::ZERO,
            rest: 0,
            ..entry
        };
        Some((
            standing,
            over,
            replica::pose::Quat::IDENTITY,
            "souls:holder-left-standing",
        ))
    }

    /// Where a lone holder `holder` lays its seated `part` down beside its bay (0.135 A2): its ground, the middle of
    /// its resting place at carrying height (C3's set-down takes it down from there), its turn, and its load. The holder
    /// must be within reach of it. The sides of the part in its bay's frame are tried out of the bay first, then the
    /// free side nearest the holder, never into the bay: each a resting place [`LAY_OUT`] out, the part lying along
    /// that side. A side is taken when the plan area the part sweeps from where it stands to where it rests (their
    /// hull, as C4's route check sweeps a lift) is clear of fixed geometry (`carry::Fixed`), of every other part the
    /// joined-part rule reads at any height, and of every body but its holder's, and its resting outline of its holder
    /// too; else `laydown.no-room`.
    #[allow(clippy::too_many_arguments)]
    fn lay_place(
        &self,
        tree: &Tree,
        c: &Controller,
        holder: Id,
        part: Id,
        reach: bool,
        skip: &[Id],
    ) -> R<(Id, Vec3, replica::pose::Quat, Load)> {
        use sim::activity::carry::{Fixed, Quad, outline, overlap};
        let node = |id: Id| tree.handle(id).and_then(|h| tree.node(h));
        let pn = node(part).ok_or_else(|| refusal("part-missing", show(part)))?;
        let load = self
            .loads
            .get(plain(pn.kind().as_str()))
            .copied()
            .unwrap_or_else(Load::board);
        let (ground, at) = stands(c, holder)?;
        let (ph, gh) = match (tree.handle(part), tree.handle(ground)) {
            (Some(p), Some(g)) => (p, g),
            _ => return Err(refusal("part-missing", show(part))),
        };
        let x = sim::ground::scene::xform_to(tree, ph, gh).map_err(|e| refusal("part-pose", e))?;
        if reach && apart(at, x.pos) > crate::assembly::GRASP {
            return Err(refusal("part.out-of-reach", show(part)));
        }
        let fixed = Fixed::of(tree, ground).map_err(|e| refusal("laydown.geometry", e))?;
        // Every other part the rule reads, at any height, as a square about its middle as wide as it is long.
        let is_part = |k: &str| self.asm.as_ref().is_some_and(|s| s.is_part(k));
        let mut others: Vec<Quad> = Vec::new();
        let mut stack = vec![tree.root()];
        while let Some(h) = stack.pop() {
            stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
            let Some(n) = tree.node(h) else { continue };
            if n.id() == part || skip.contains(&n.id()) || !is_part(n.kind().as_str()) {
                continue;
            }
            let Ok(o) = sim::ground::scene::xform_to(tree, h, gh) else {
                continue;
            };
            let l = self
                .loads
                .get(plain(n.kind().as_str()))
                .copied()
                .unwrap_or_else(Load::board);
            let m = o
                .rot
                .rotate(l.middle)
                .map_or(o.pos, |v| Vec3::new(o.pos.x + v.x, 0, o.pos.z + v.z));
            let r = l.half_length;
            others.push([
                [m.x - r, m.z - r],
                [m.x + r, m.z - r],
                [m.x + r, m.z + r],
                [m.x - r, m.z + r],
            ]);
        }
        // Bodies on this ground, in its frame (`place_of`), each a square of a body's radius; its holder apart.
        let radius = sim::ground::HUMAN_RADIUS * 1000;
        let square = |p: [i64; 2]| -> Quad {
            [
                [p[0] - radius, p[1] - radius],
                [p[0] + radius, p[1] - radius],
                [p[0] + radius, p[1] + radius],
                [p[0] - radius, p[1] + radius],
            ]
        };
        let (mut bodies, mut own) = (Vec::new(), None);
        for id in c.ids() {
            let Some(m) = c.body(id) else { continue };
            let (on, p) = sim::index::place_of(m);
            if on != ground {
                continue;
            }
            match id == holder {
                true => own = Some(square(p)),
                false => bodies.push(square(p)),
            }
        }
        // The part's own footprint where it stands, and its own fixed outlines, which it leaves.
        let (lx, lz) = (
            load.half_length.max(load.half_width),
            load.half_width.min(load.half_length),
        );
        let unit = |v: Vec3| x.rot.rotate(v).map(|r| [r.x, r.z]);
        let to_holder = [at.x - x.pos.x, at.z - x.pos.z];
        let bay_at = pn
            .parent()
            .and_then(|b| tree.handle(b))
            .and_then(|bh| sim::ground::scene::xform_to(tree, bh, gh).ok())
            .map_or(x.pos, |b| b.pos);
        let outward = [x.pos.x - bay_at.x, x.pos.z - bay_at.z];
        let dot = |d: &[i64; 2], v: [i64; 2]| {
            i128::from(d[0]) * i128::from(v[0]) + i128::from(d[1]) * i128::from(v[1])
        };
        // Each side as a vector LAY_OUT long, along the part's own axes (exact, not rounded to a diagonal).
        let mut sides: Vec<[i64; 2]> = [
            Vec3::new(LAY_OUT, 0, 0),
            Vec3::new(-LAY_OUT, 0, 0),
            Vec3::new(0, 0, LAY_OUT),
            Vec3::new(0, 0, -LAY_OUT),
        ]
        .into_iter()
        .filter_map(|v| unit(v).ok())
        .collect();
        sides.retain(|d| dot(d, outward) >= 0);
        sides.sort_by_key(|d| (dot(d, outward) <= 0, -dot(d, to_holder)));
        // Its own fixed outlines, and those of the parts it is joined to (`skip`, which it slides off): those lying
        // wholly within one of their plan footprints where they stand.
        let boxes: Vec<[i64; 4]> = std::iter::once(part)
            .chain(skip.iter().copied())
            .filter_map(|id| self.plan_box(tree, id, gh))
            .collect();
        let mine = |q: &Quad| {
            boxes.iter().any(|b| {
                q.iter()
                    .all(|p| p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3])
            })
        };
        let scaled = |d: [i64; 2], by: i64| {
            [
                (i128::from(d[0]) * i128::from(by) / i128::from(LAY_OUT)) as i64,
                (i128::from(d[1]) * i128::from(by) / i128::from(LAY_OUT)) as i64,
            ]
        };
        let free = sides.into_iter().find_map(|d| {
            let c0 = [x.pos.x + d[0], x.pos.z + d[1]];
            let along = [-d[1], d[0]];
            let a = scaled(along, load.half_length);
            let rest = outline(
                [c0[0] + a[0], c0[1] + a[1]],
                [c0[0] - a[0], c0[1] - a[1]],
                &load,
            );
            // The sweep: from the part's far edge behind where it stands to the far edge of where it rests, as wide as
            // the larger of the two.
            let (from, to) = (scaled(d, -lz), scaled(d, LAY_OUT + load.half_width));
            let mid = [
                x.pos.x + (from[0] + to[0]) / 2,
                x.pos.z + (from[1] + to[1]) / 2,
            ];
            let half_d = (LAY_OUT + load.half_width + lz) / 2;
            let e = scaled(d, half_d);
            let sweep_load = Load {
                half_length: half_d,
                half_width: load.half_length.max(lx),
                ..load
            };
            let sweep = outline(
                [mid[0] + e[0], mid[1] + e[1]],
                [mid[0] - e[0], mid[1] - e[1]],
                &sweep_load,
            );
            let fixed_hit = fixed
                .within([
                    sweep.iter().map(|p| p[0]).min().unwrap_or(0),
                    sweep.iter().map(|p| p[1]).min().unwrap_or(0),
                    sweep.iter().map(|p| p[0]).max().unwrap_or(0),
                    sweep.iter().map(|p| p[1]).max().unwrap_or(0),
                ])
                .into_iter()
                .filter(|q| !mine(q))
                .any(|q| overlap(&sweep, q));
            let clear = !fixed_hit
                && !others.iter().any(|q| overlap(&sweep, q))
                && !bodies.iter().any(|b| overlap(&sweep, b))
                && !own.as_ref().is_some_and(|b| overlap(&rest, b));
            clear.then_some((c0, along))
        });
        let Some((c0, along)) = free else {
            return Err(refusal("laydown.no-room", show(part)));
        };
        // At the ground's height where it rests (raised or sloped terrain), as C4's set-down rests a load at its
        // carriers' feet; read near its bay's base (its own, out of a bay), never near a far-off holder's feet.
        let base = sim::ground::scene::Terrain::within(
            tree,
            ground,
            [c0[0] - 1, c0[1] - 1, c0[0] + 1, c0[1] + 1],
        )
        .ok()
        .flatten();
        let floor = sim::ground::scene::Terrain::ground(base.as_ref(), c0[0], c0[1], bay_at.y);
        let place = Vec3::new(c0[0], floor + sim::activity::carry::HEIGHT, c0[1]);
        Ok((
            ground,
            place,
            sim::activity::carry::yaw_toward(along)?,
            load,
        ))
    }

    /// The plan box of part `id` where it stands, in the frame of ground `gh` (µm): its long axis's ends (its kind's
    /// load, C4) widened by its half width and 10 mm.
    fn plan_box(&self, tree: &Tree, id: Id, gh: replica::tree::Handle) -> Option<[i64; 4]> {
        let h = tree.handle(id)?;
        let l = self
            .loads
            .get(plain(tree.node(h)?.kind().as_str()))
            .copied()
            .unwrap_or_else(Load::board);
        let x = sim::ground::scene::xform_to(tree, h, gh).ok()?;
        let a = x.point(l.middle.plus(l.long).ok()?).ok()?;
        let b = x.point(l.middle.minus(l.long).ok()?).ok()?;
        let w = l.half_width + 10_000;
        Some([
            a.x.min(b.x) - w,
            a.z.min(b.z) - w,
            a.x.max(b.x) + w,
            a.z.max(b.z) + w,
        ])
    }

    /// Whether `quad` (a resting outline on `ground`, µm) is clear of fixed geometry (`part`'s own outlines aside), of
    /// every other part B18 reads, at any height, and of every body but `skip`'s.
    fn room_at(
        &self,
        tree: &Tree,
        c: &Controller,
        ground: Id,
        part: Id,
        quad: &sim::activity::carry::Quad,
        skip: Id,
    ) -> bool {
        use sim::activity::carry::{Fixed, overlap};
        let (Some(gh), Some(ph)) = (tree.handle(ground), tree.handle(part)) else {
            return false;
        };
        let Ok(fixed) = Fixed::of(tree, ground) else {
            return false;
        };
        let Ok(x) = sim::ground::scene::xform_to(tree, ph, gh) else {
            return false;
        };
        let hw = tree
            .node(ph)
            .and_then(|n| self.loads.get(plain(n.kind().as_str())))
            .map_or(0, |l| l.half_width)
            + 10_000;
        let mine = |q: &sim::activity::carry::Quad| {
            q.iter()
                .all(|p| (p[0] - x.pos.x).abs() <= hw && (p[1] - x.pos.z).abs() <= hw)
        };
        let b = [
            quad.iter().map(|p| p[0]).min().unwrap_or(0),
            quad.iter().map(|p| p[1]).min().unwrap_or(0),
            quad.iter().map(|p| p[0]).max().unwrap_or(0),
            quad.iter().map(|p| p[1]).max().unwrap_or(0),
        ];
        if fixed
            .within(b)
            .into_iter()
            .any(|q| !mine(q) && overlap(quad, q))
        {
            return false;
        }
        let is_part = |k: &str| self.asm.as_ref().is_some_and(|s| s.is_part(k));
        let mut stack = vec![tree.root()];
        while let Some(h) = stack.pop() {
            stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
            let Some(n) = tree.node(h) else { continue };
            if n.id() == part || !is_part(n.kind().as_str()) {
                continue;
            }
            let Ok(o) = sim::ground::scene::xform_to(tree, h, gh) else {
                continue;
            };
            let r = self
                .loads
                .get(plain(n.kind().as_str()))
                .map_or(1_000_000, |l| l.half_length);
            let sq = [
                [o.pos.x - r, o.pos.z - r],
                [o.pos.x + r, o.pos.z - r],
                [o.pos.x + r, o.pos.z + r],
                [o.pos.x - r, o.pos.z + r],
            ];
            if overlap(quad, &sq) {
                return false;
            }
        }
        let radius = sim::ground::HUMAN_RADIUS * 1000;
        !c.ids()
            .filter(|id| *id != skip)
            .filter_map(|id| c.body(id))
            .any(|m| {
                let (on, p) = sim::index::place_of(m);
                on == ground
                    && overlap(
                        quad,
                        &[
                            [p[0] - radius, p[1] - radius],
                            [p[0] + radius, p[1] - radius],
                            [p[0] + radius, p[1] + radius],
                            [p[0] - radius, p[1] + radius],
                        ],
                    )
            })
    }

    /// A lone holder `holder` of crew `activity` lays its seated `part` down beside its bay ([`Engine::lay_place`]), at
    /// rest as its kind's entry lays it (C3's set-down, C4's load); written through the walkers' maps as a seating is,
    /// and refused by B18 when another part hangs by it. Then its holder may leave.
    #[allow(clippy::too_many_arguments)]
    fn lay_down(
        &mut self,
        tree: &mut Tree,
        c: &Controller,
        by: (Id, Id),
        activity: Id,
        holder: Id,
        part: Id,
        now: Micros,
    ) -> R<()> {
        let node = |id: Id| tree.handle(id).and_then(|h| tree.node(h));
        let pn = node(part).ok_or_else(|| refusal("part-missing", show(part)))?;
        if node(activity).and_then(|n| n.parent()) != Some(part) {
            return Err(refusal("part.not-held", show(activity)));
        }
        let in_bay = pn.parent().and_then(&node).is_some_and(|b| {
            self.asm
                .as_ref()
                .is_some_and(|s| s.is_bay(b.kind().as_str()))
        });
        if !in_bay {
            return Err(refusal("part.not-seated", show(part)));
        }
        let audience = node(activity)
            .map(|n| n.audience())
            .ok_or_else(|| refusal("activity-missing", show(activity)))?;
        let (ground, place, yaw, load) = self.lay_place(tree, c, holder, part, true, &[])?;
        let mut carry = Carry::new(
            activity,
            part,
            ground,
            audience,
            self.header.clone(),
            self.rules.clone(),
        );
        carry.load = load;
        carry.track.push((now, place, yaw));
        let transfer = self
            .mint
            .mint()
            .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
        carry.set_down_here(tree, now, ground, None, transfer)?;
        let effects: Vec<Effect> = carry
            .log
            .parts
            .drain(..)
            .flatten()
            .map(|mut e| {
                e.envelope.cause = Cause::Intent(by.0);
                e.envelope.actor = Actor::Soul(by.1);
                e
            })
            .collect();
        let asm = self
            .asm
            .as_mut()
            .ok_or_else(|| refusal("seating-off", "the world's kinds join no parts"))?;
        asm.ready.push(crate::assembly::Ready {
            intent: by.0,
            soul: by.1,
            activity,
            step: crate::assembly::Step::Laid,
            effects,
        });
        Ok(())
    }

    /// A retiring holder's set-down `r` whose walkers' maps went stale before its commit (its own body left meanwhile,
    /// 0.135 A2): checked again, at most [`RETRIES`] times; `false` when it has been, and it is refused.
    pub fn retry(&mut self, r: crate::assembly::Ready) -> bool {
        let n = self.retried.entry(r.activity).or_insert(0);
        *n += 1;
        if *n > RETRIES {
            self.retried.remove(&r.activity);
            return false;
        }
        match self.asm.as_mut() {
            Some(asm) => {
                asm.ready.push(r);
                true
            }
            None => false,
        }
    }

    /// The load `part` is as its kind's entry states it, turned as it is held in its crew's slot (0.135 C4's
    /// `Load`), so a carry that breaks off sets it down the way it is held.
    fn held_load(&self, tree: &Tree, part: Id) -> Option<Load> {
        let n = tree.handle(part).and_then(|h| tree.node(h))?;
        let l = self.loads.get(plain(n.kind().as_str()))?;
        let turn = n.place()?.orientation;
        Some(l.held_turned(turn).unwrap_or(Load { turn, ..*l }))
    }

    /// The takes and seatings to commit through the walkers' maps (0.135 A2, `crate::answers`), and the seatings
    /// refused when their track ended (the intent, its Soul and why).
    pub fn assembled(&mut self) -> (Vec<crate::assembly::Ready>, Vec<(Id, Id, Refusal)>) {
        match self.asm.as_mut() {
            Some(s) => (std::mem::take(&mut s.ready), std::mem::take(&mut s.refused)),
            None => (Vec::new(), Vec::new()),
        }
    }

    /// A take or a seating was committed (`written`) or refused at its commit: a committed take starts its crew's
    /// carry (B9's samples between its carriers); a refused one leaves the crew holding nothing.
    pub fn part_written(
        &mut self,
        r: &crate::assembly::Ready,
        written: bool,
        now: Micros,
        live: &Tree,
    ) {
        let taking = self.taking.remove(&r.activity);
        if let Some(asm) = self.asm.as_mut() {
            asm.written(r.activity, r.step, written);
        }
        if r.step == crate::assembly::Step::Retired {
            self.retried.remove(&r.activity);
            // A retiring holder's structure set down (its kept hold's node gone with it) is forgotten here; refused
            // (by the walkers' maps, G2 or B18), the hold stays kept.
            if written {
                self.activities.forgotten(r.activity);
                if let Some(asm) = self.asm.as_mut() {
                    asm.ended(r.activity);
                }
                return;
            }
            let mut tree = live.frozen();
            let part = tree
                .handle(r.activity)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.parent());
            if let Some(part) = part {
                match self.kept_word(&mut tree, r.activity, part, now, (r.intent, r.soul)) {
                    Ok(()) => self.collect(Some((r.intent, r.soul))),
                    Err(e) => eprintln!("worldd: a kept hold was not named: {e}"),
                }
            }
            return;
        }
        if r.step != crate::assembly::Step::Taken {
            // A seating refused at its commit is stopped where its track ended.
            let mut tree = live.frozen();
            self.stop_refused(&mut tree, now);
            return;
        }
        let Some((ground, at, turn, span, sides)) = taking else {
            return;
        };
        let part = self
            .asm
            .as_ref()
            .and_then(|a| a.held.get(&r.activity).copied());
        let audience = live
            .handle(r.activity)
            .and_then(|h| live.node(h))
            .map(|n| n.audience());
        // A take or an unseat committed ends the kept holds on the part (0.135 A2): they rode out with it.
        if written && let Some(p) = part {
            let mut tree = live.frozen();
            let ask = Ask {
                soul: r.soul,
                intent: r.intent,
                at: now,
            };
            match self.unkeep(&mut tree, p, r.activity, ask) {
                Ok(()) => self.collect(Some((r.intent, r.soul))),
                Err(e) => eprintln!("worldd: a kept hold did not end at a take: {e}"),
            }
        }
        let Some(asm) = self.asm.as_mut() else {
            return;
        };
        match (written, part, audience) {
            (true, Some(part), Some(audience)) => {
                let mut carry = Carry::new(
                    r.activity,
                    part,
                    ground,
                    audience,
                    self.header.clone(),
                    self.rules.clone(),
                );
                carry.track.push((now, at, turn));
                // Its carriers' span at the take: a carry they let drift apart breaks off (0.135 C3).
                carry.span = span;
                carry.sides = sides;
                if let Some(l) = self.held_load(live, part) {
                    carry.load = l;
                }
                self.carries.insert(r.activity, carry);
            }
            _ => asm.written(r.activity, r.step, false),
        }
    }

    /// The follow `activity` is over (0.135 G2: its follower's order ended): its follower leaves it, as
    /// `activity:leave` does, caused by the intent that joined, and so the leader too. Its entries wait in
    /// [`Engine::out`].
    pub fn end_follow(&mut self, live: &Tree, c: &mut Controller, activity: Id, now: Micros) {
        let Some((_, _, follower, _, _)) = self
            .activities
            .following()
            .into_iter()
            .find(|f| f.0 == activity)
        else {
            return;
        };
        let Some(m) = self
            .activities
            .members(activity)
            .and_then(|ms| ms.iter().find(|m| m.body == follower).cloned())
        else {
            return;
        };
        let mut tree = live.frozen();
        self.activities.next = tree.next();
        let ask = Ask {
            soul: m.soul,
            intent: m.intent,
            at: now,
        };
        if let Err(r) = self.activities.leave(
            &mut tree,
            c,
            &mut self.moves,
            &mut self.due,
            &mut self.mint,
            ask,
            follower,
            activity,
        ) {
            eprintln!("worldd: {}'s follow did not end: {r}", show(follower));
        }
        self.collect(None);
    }

    /// A move `body` started for `intent` (a walk, a sit) at `now` (0.134 T2): if `body` holds hands, or dances on the
    /// beat (T3), it leaves that activity as `activity:leave` does, and both hands come free. Its entries wait in [`Engine::out`].
    /// The walk of a hold's leader (0.135 R1: the first of the two to walk) leads instead: the other walks beside it.
    /// A sit or a lie (`walk` false) never leads: by either member, it lets go.
    /// `goal`, for a walk: the node it goes to and its point there; `heading`, the walk's parameter 3 (moving-group
    /// rule 3: a carry's heading at the goal, from its back toward its front).
    #[allow(clippy::too_many_arguments)]
    pub fn walked(
        &mut self,
        live: &Tree,
        c: &mut Controller,
        body: Id,
        intent: Id,
        now: Micros,
        walk: bool,
        goal: Option<(Id, Vec3)>,
        heading: Option<[i64; 2]>,
    ) {
        // Carrying together (moving-group rule 3): the walk of a lifted carry's front leads its crew, turning it when
        // the walk names the carry's heading at its goal or goes to a pose of the way the lift found.
        if walk && let Some(a) = self.front_of(body) {
            let turn = self.turn_of(a, goal, heading);
            self.led.insert(
                a,
                Led {
                    front: body,
                    walk: intent,
                    turn,
                },
            );
            return;
        }
        if walk && self.activities.lead(&self.moves, body) {
            return;
        }
        let Some(activity) = self.activities.walk_leaves(&self.moves, body) else {
            return;
        };
        let Some(soul) = self
            .activities
            .members(activity)
            .and_then(|m| m.iter().find(|m| m.body == body))
            .map(|m| m.soul)
        else {
            return;
        };
        let mut tree = live.frozen();
        self.activities.next = tree.next();
        let ask = Ask {
            soul,
            intent,
            at: now,
        };
        if let Err(r) = self.activities.leave(
            &mut tree,
            c,
            &mut self.moves,
            &mut self.due,
            &mut self.mint,
            ask,
            body,
            activity,
        ) {
            eprintln!("worldd: {}'s walk did not let go: {r}", show(body));
        }
        self.collect(Some((intent, soul)));
    }

    /// The places still to take (0.135 G3, `sim::activity::places`), each activity's frame set from where its members
    /// stand in `c`, on their node (`sim::index::place_of`): `(activity, body, Soul, node, point, facing)`.
    pub fn pending_places(
        &mut self,
        c: &Controller,
    ) -> Vec<(Id, Id, Id, Id, Vec3, replica::pose::Quat)> {
        self.activities.pending_places(|b| {
            c.body(b)
                .map(|m| (sim::index::place_of(m).0, m.pose.position))
        })
    }

    /// Members that have taken their places (0.135 G3), by (activity, body): an activity's moves begin once all
    /// have, at `now` on a copy of `live`. Its entries wait in [`Engine::out`].
    pub fn placed(&mut self, live: &Tree, c: &mut Controller, done: &[(Id, Id)], now: Micros) {
        if done.is_empty() {
            return;
        }
        for &(a, b) in done {
            self.activities.placed(a, b);
        }
        let mut tree = live.frozen();
        self.activities.next = tree.next();
        self.begin_moves(&mut tree, c, now);
        self.collect(None);
    }

    /// Every follow running (0.135 G2): its activity, the leader's body, the follower's body and Soul, and the width
    /// of a place beside the leader (R1, hand in hand).
    pub fn following(&self) -> Vec<(Id, Id, Id, Id, Option<i64>)> {
        self.activities.following()
    }

    /// The lifted carry whose front is `body`, if any: the first member of a carry being sampled.
    fn front_of(&self, body: Id) -> Option<Id> {
        self.carries.keys().copied().find(|a| {
            self.activities
                .members(*a)
                .and_then(|m| m.first())
                .is_some_and(|m| m.body == body)
        })
    }

    /// Each load being carried, where its carry's last sample has it, as walkers keep apart from it (moving-group rule
    /// 3, [`sim::host::Carried`]): its outline as it is held, between its ends along the carry, at its carriers' feet,
    /// moving at its last two samples' pace; seen by every walker but its own carriers.
    pub fn carried_loads(&self) -> Vec<sim::host::Carried> {
        let mut out = Vec::new();
        for (a, carry) in &self.carries {
            let (Ok(Some((f, b))), Ok((plan, _))) = (carry.ends(), carry.load.as_held()) else {
                continue;
            };
            let Some(&(t1, c1, _)) = carry.track.last() else {
                continue;
            };
            let d = [f[0] - b[0], f[1] - b[1]];
            let l = (i128::from(d[0]).pow(2) + i128::from(d[1]).pow(2)).isqrt();
            if l == 0 {
                continue;
            }
            let h = |v: i64| {
                i64::try_from(i128::from(v) * i128::from(plan.half_length) / l).unwrap_or(0)
            };
            let mid = [(f[0] + b[0]) / 2, (f[1] + b[1]) / 2];
            let ends = (
                [mid[0] + h(d[0]), mid[1] + h(d[1])],
                [mid[0] - h(d[0]), mid[1] - h(d[1])],
            );
            let velocity = match carry
                .track
                .len()
                .checked_sub(2)
                .and_then(|k| carry.track.get(k))
            {
                Some(&(t0, c0, _)) if t1 > t0 => {
                    let v = |a: i64, b: i64| {
                        i64::try_from(i128::from(b - a) * 1_000_000 / i128::from(t1 - t0))
                            .unwrap_or(0)
                    };
                    Vec3::new(v(c0.x, c1.x), 0, v(c0.z, c1.z))
                }
                _ => Vec3::ZERO,
            };
            let carriers = self
                .activities
                .members(*a)
                .unwrap_or(&[])
                .iter()
                .map(|m| m.body)
                .collect();
            out.push(sim::host::Carried::new(
                carry.board,
                carry.ground,
                ends,
                plan.half_width,
                c1.y - sim::activity::carry::HEIGHT,
                velocity,
                carriers,
            ));
        }
        out
    }

    /// Where carry `a`'s front walk to `goal` turns its crew (moving-group rule 3): the goal on its ground's plan and
    /// the carry's heading there, `heading` when the walk names one (not zero), else the heading of a pose of the
    /// carry's way (0.135 R2) whose front is within [`WAY_POSE_NEAR`] of the goal: of several, the one turned least from
    /// the carry's heading now (the next pose of a way differs by one move). A named heading more than a quarter turn
    /// from the carry's now is a quarter turn, on its side: a crew turns at most that much in one walk. None for a walk to another node, or one
    /// that names no heading and goes to no pose of a way: the crew moves without turning.
    fn turn_of(
        &self,
        a: Id,
        goal: Option<(Id, Vec3)>,
        heading: Option<[i64; 2]>,
    ) -> Option<([i64; 2], [i64; 2])> {
        let carry = self.carries.get(&a)?;
        let (node, p) = goal?;
        if node != carry.ground {
            return None;
        }
        let at = [p.x, p.z];
        let now = carry
            .ends()
            .ok()
            .flatten()
            .map(|(f, b)| [i128::from(f[0] - b[0]), i128::from(f[1] - b[1])])?;
        if let Some(h) = heading.filter(|h| {
            *h != [0, 0]
                && h.iter()
                    .all(|c| c.unsigned_abs() <= HEADING_MOST.unsigned_abs())
        }) {
            // At most a quarter turn a walk: a heading farther round is turned square across the load, on its side.
            let (x, z) = (i128::from(h[0]), i128::from(h[1]));
            if x * now[0] + z * now[1] < 0 {
                let side = if now[0] * z - now[1] * x >= 0 { 1 } else { -1 };
                let c = |v: i128| i64::try_from(v).unwrap_or(0);
                return Some((at, [c(-now[1] * side), c(now[0] * side)]));
            }
            return Some((at, h));
        }
        let unit = |v: [i128; 2]| (v[0] * v[0] + v[1] * v[1]).isqrt().max(1);
        carry
            .way
            .iter()
            .filter(|(f, b)| {
                f != b
                    && (i128::from(f[0] - at[0]).pow(2) + i128::from(f[1] - at[1]).pow(2))
                        <= i128::from(WAY_POSE_NEAR).pow(2)
            })
            .map(|(f, b)| [f[0] - b[0], f[1] - b[1]])
            .max_by_key(|h| {
                let v = [i128::from(h[0]), i128::from(h[1])];
                (v[0] * now[0] + v[1] * now[1]) * 1_000_000 / (unit(v) * unit(now))
            })
            .map(|h| (at, h))
    }

    /// Carrying together (`v2/docs/moving-group.md` rule 3): every carrier of a lifted carry whose front has walked,
    /// but the front, that keeps a place from it ([`Keeps`]): the back `span` behind the front, each side at its place
    /// from the carry's middle at the lift or take ([`Carry::sides`]); a member with no place is left out.
    pub fn carry_follows(&self) -> Vec<Keeps> {
        let mut out = Vec::new();
        for (a, led) in &self.led {
            let Some(carry) = self.carries.get(a) else {
                continue;
            };
            let Ok(Some((f, b))) = carry.ends() else {
                continue;
            };
            let heading = [f[0] - b[0], f[1] - b[1]];
            if heading == [0, 0] {
                continue;
            }
            for (k, m) in self
                .activities
                .members(*a)
                .unwrap_or(&[])
                .iter()
                .enumerate()
            {
                let place = match k {
                    0 => continue,
                    1 => [-carry.span, 0],
                    _ => match carry.sides.iter().find(|(s, _)| *s == m.body) {
                        Some((_, [along, across])) => [along - carry.span / 2, *across],
                        None => continue,
                    },
                };
                if m.body == led.front {
                    continue;
                }
                out.push(Keeps {
                    activity: *a,
                    front: led.front,
                    walker: m.body,
                    soul: m.soul,
                    place,
                    heading,
                    led: *led,
                });
            }
        }
        out
    }

    /// The led carries that are over (set down, put, or broken off) since the last call, forgotten here: for each that
    /// broke off, its front's body, its walk and why (`souls:partner-left`, `souls:carriers-apart`,
    /// `souls:carry-blocked`), so the whole group stops with that one reason.
    pub fn led_over(&mut self) -> Vec<(Id, Id, &'static str)> {
        // A carry on its way down (#5067) is over for its front: its walk stops now, not when the load rests.
        let over: Vec<Id> = self
            .led
            .keys()
            .filter(|a| !self.carries.get(a).is_some_and(|c| !c.lowering()))
            .copied()
            .collect();
        let mut out = Vec::new();
        for a in over {
            let Some(led) = self.led.remove(&a) else {
                continue;
            };
            if let Some(why) = self.broke.remove(&a) {
                out.push((led.front, led.walk, why));
            }
        }
        self.broke.retain(|a, _| self.led.contains_key(a));
        out
    }

    /// The entries written since the last call, in order, to be numbered and applied.
    pub fn out(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.out)
    }
}

/// The entry that sets ride `thing`'s fields `ends` back (N14, a trip's end): those that hold another value; none when
/// every one holds it already or is unset.
fn trip_end(live: &Tree, thing: Id, ends: &[(u64, Value)], now: Micros) -> Option<Effect> {
    let node = live.handle(thing).and_then(|h| live.node(h))?;
    let changes: Vec<_> = ends
        .iter()
        .filter(|(n, to)| node.fields().get(n).is_some_and(|v| v != to))
        .map(|(n, to)| crate::carrier::set(thing, *n, to.clone()))
        .collect();
    if changes.is_empty() {
        return None;
    }
    match crate::carrier::entry(live, thing, changes, now, Cause::World, Actor::World) {
        Ok(e) => Some(e),
        Err(r) => {
            eprintln!("worldd: {}'s trip does not end: {r}", show(thing));
            None
        }
    }
}

/// The courses of the slots that move with their cabins (N14) of the rides `changed`, written onto each whose
/// [`replica::schedule::F_SEAT_COURSES`] is not what its slots run now (`slots`, from its entry), or cleared on one whose
/// slots no longer run (a ride a god edit moved where they do not): one entry of the world's a ride, so every copy and
/// the page read where each slot and its rider are. A restart with the same entries writes nothing.
fn slot_courses(live: &Tree, slots: &Slots, changed: &BTreeSet<Id>, now: Micros) -> Vec<Effect> {
    let mut by: BTreeMap<Id, BTreeMap<u64, Value>> =
        changed.iter().map(|t| (*t, BTreeMap::new())).collect();
    for (thing, slot, c) in slots.slot_courses() {
        if let Some(m) = by.get_mut(&thing) {
            m.insert(slot, c.to_value());
        }
    }
    let mut out = Vec::new();
    for (thing, courses) in by {
        let to = Value::Map(courses);
        let held = live
            .handle(thing)
            .and_then(|h| live.node(h))
            .map(|n| n.fields().get(&replica::schedule::F_SEAT_COURSES).cloned());
        let Some(held) = held else {
            continue;
        };
        if held.as_ref() == Some(&to) || (held.is_none() && to == Value::Map(BTreeMap::new())) {
            continue;
        }
        let e = crate::carrier::entry(
            live,
            thing,
            vec![crate::carrier::set(
                thing,
                replica::schedule::F_SEAT_COURSES,
                to,
            )],
            now,
            Cause::World,
            Actor::World,
        );
        match e {
            Ok(e) => out.push(e),
            Err(r) => eprintln!(
                "worldd: {}'s slot courses are not written: {r}",
                show(thing)
            ),
        }
    }
    out
}

#[cfg(test)]
mod kind_tests {
    use super::*;

    #[test]
    fn activity_kinds_preserve_the_exact_pin_and_short_names() {
        let plain = Name::new("souls:conversation").unwrap();
        let mut hash = vec![0x12, 0x20];
        hash.extend([7; 32]);
        let params = |v| BTreeMap::from([(1, v)]);
        let pair = |h| Value::Array(vec![Value::Text(plain.clone()), Value::Bytes(h)]);
        assert_eq!(
            param_kind(&params(pair(hash.clone())), 1, "bad")
                .unwrap()
                .as_str(),
            format!("souls:conversation@{}", replica::encode::to_hex(&hash))
        );
        assert_eq!(
            param_kind(&params(Value::Text(plain.clone())), 1, "bad").unwrap(),
            plain
        );
        for h in [
            vec![0; 34],
            hash[..33].to_vec(),
            [hash.as_slice(), &[0]].concat(),
        ] {
            assert_eq!(
                param_kind(&params(pair(h)), 1, "bad").unwrap_err().name,
                "bad"
            );
        }
    }
}

#[cfg(test)]
mod feet_tests {
    use super::*;
    use replica::pose::{Frame, Pose, Quat, Support};

    /// 0.135 E21 follow-up: a touch's reach to a seated Soul (an accept, a role's move) is from its seat. The testworld
    /// building (60 m west, turned 33°) read as a bench whose end seat is 9.5 m from its origin: a Soul standing 0.4 m
    /// from that seat is 0.4 m from the seated one, both ways, inside a handshake's reach; before, it was measured from
    /// the bench's origin, 9.5 m off.
    #[test]
    fn a_touch_reaches_a_seated_body_at_its_seat() {
        let generated = testworld::generate(1, 0).expect("the synthetic world");
        let imported = import_eden::load(&generated.text).expect("the imported world");
        let (ground, bench) = (imported.nodes["ground"], imported.nodes["building"]);
        let tree = &imported.tree;
        let node = tree.node(tree.handle(bench).unwrap()).unwrap();
        let end_x = testworld::BUILDING_LENGTH / 2 + 1_500;
        let entry = replica::rules::json::parse(&format!(
            r#"{{"slots":{{"middle":{{"admits":"body","at_mm":[0,450,0]}},"end":{{"admits":"body","at_mm":[{end_x},450,0]}}}}}}"#
        ))
        .unwrap();
        let entries = Json::Obj(vec![(plain(node.kind().as_str()).to_owned(), entry)]);
        let place = node.place().unwrap();
        let out = |x: i64, z: i64| {
            let d = place
                .orientation
                .rotate(Vec3::new(x * 1000, 0, z * 1000))
                .unwrap();
            place.position.plus(d).unwrap()
        };
        let seated = Pose {
            frame: Frame {
                node: bench,
                slot: Some(2),
            },
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: Support::Slot,
        };
        let standing = Pose {
            frame: Frame {
                node: ground,
                slot: None,
            },
            position: out(end_x, 400),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: ground,
                height: 0,
            },
        };
        let id = |n: u64| Id::new(Scope([0xce; 16]), n).unwrap();
        let feet = Feet(BTreeMap::from([
            (id(1), feet_of(tree, &entries, &seated)),
            (id(2), feet_of(tree, &entries, &standing)),
        ]));
        let d = |a, b| {
            feet.distance(
                id(a),
                &Effector::Held,
                None,
                id(b),
                &Name::new("p").unwrap(),
            )
            .expect("one floor")
        };
        let (to, from) = (d(2, 1), d(1, 2));
        println!("a touch from 0.4 m off the end slot: {to} µm, {from} µm back");
        assert!((to - 400_000).abs() <= 10_000, "to the seated Soul: {to}");
        assert_eq!(to, from);
        // With no entry for the bench its seat is not found: the old measure, from the bench's origin, 9.5 m off.
        assert_eq!(feet_of(tree, &Json::Null, &seated), (bench, [0, 0]));
    }
}
