//! Seating a part by intents (0.135 A2; B19's seating, #3340, in a running world): a crew of two Souls takes a part,
//! carries it, seats it in a bay's slot with its joints made, and takes it out again. No code here names a kind:
//! which parts stand, which bear, which kinds are bays and which connectors mate is B18's reading of the world's
//! entries (`sim::structure`).
//!
//! - **Verbs** ([`crate::engine::Verb`]): `part:take` and `part:unseat` (target the crew's activity, 1 the part) and
//!   `part:put` (target the activity; 1 the node it goes in, 2 its slot there, or 3 a point `[x, y, z]` µm in that
//!   node's frame; 4 the parts it joins, ids, when not the bay's standing parts, or for a resting part its bearing
//!   ones).
//! - **Take** ([`Assembly::take`]): the part, within [`GRASP`] of the middle of its two carriers and each carrier
//!   within reach of the hold the carry's rule gives it ([`Crew`], below), goes into the crew's slot in one commit
//!   (B19's take: its joints undone, a holding crew's node moved off it), keeping the turn it had; one that lies is
//!   held by its middle between its carriers, one that stands by its foot. The commit moves nothing: the crew's node
//!   is set where the part is, and its carry then takes it into its carriers' hands on a track, one motion sample a
//!   tick, as a lift does (`sim::activity::carry::Carry::take_up`, said `souls:carry-track`).
//!   `part:unseat` is the same take for a part in a bay. The crew's carry (B9's samples) starts once it is committed.
//! - **Put** ([`Assembly::put`]): refused before anyone moves by B19's check (`crew.size`, `slot.occupied`,
//!   `reach.too-high`, B18's `support.none`), by `connectors-do-not-mate` for a join the kinds' connectors do not
//!   allow, and by the world's rules for the seating as it would be committed (a slot that does not admit the part,
//!   `child-not-admitted`). Then the crew's node goes on B19's straight set-in track to the slot, and when the track
//!   ends ([`Assembly::due`]) the part is seated: its change of parent, its joints, and the crew holding it (a standing
//!   part in a bay) or at rest, in one commit.
//! - **Through the walkers' maps.** A take and a seating change what walkers go round, so their entries are not
//!   written with the tick's others: they wait in [`Assembly::ready`] and the clock commits each through the walkers'
//!   prepared maps (`crate::answers`, as a set-down's), so the ground is rebuilt with the commit. There G2's rule
//!   (`sim::edit::safety::check_on`, as for a creator's edit) refuses a seating that would bury a Soul or leave it no
//!   way out (`edit.would-cut-off`, naming the Soul) before it commits; it is then stopped as below. The set-in track,
//!   which moves only the crew's node, is written as any engine act's entries are.
//!
//! - **Only a crew takes, only a part, only one nobody else has** ([`Assembly::take`]): the activity must be a kind
//!   a standing part admits as its holders (`part.not-a-crew`), the thing a part B18 reads (`part.not-a-part`), not in
//!   a body's hand (`part.in-a-hand`), not riding or held by another activity (`part.held-by-another`), within
//!   its carriers' standing reach (`reach.too-high`), and every carrier within reach of its own hold
//!   (`part.grip-out-of-reach`, naming the carrier).
//! - **Put from close by** (`part.out-of-reach` beyond [`PUT_REACH`] of where the part goes): the set-in track is
//!   short and straight.
//! - **A seating refused at its track's end or at its commit** stops where its track has it then, and goes back along
//!   a straight track to where its set-in started ([`Assembly::stop`]); there it is handed back to the crew's carry
//!   ([`Assembly::returned`]), and the crew may put again. The part never leaves its crew's slot. While a part is on its
//!   way in or back, or its seating waits for its commit, its crew is not left (`crew.setting-in`, `crate::engine`);
//!   otherwise a leave breaks the carry off and the part is set down where it is (C3), so no part goes with an
//!   activity that ends.
//!
//! - **Every carrier within reach of its hold (#5067).** A carrier's reach is measured to where it holds the part, the
//!   middle of its two hands as its hold is said (`sim::activity::carry::grips::assign`), from its feet: at most
//!   [`GRIP_REACH`] on the plan and its standing reach above them ([`Carrier`], [`out_of_reach`]).
//!   - **At the take** ([`Crew`]): every carrier, its front, its back and each side, must reach its hold as the crew
//!     will hold the part (in its slot, between its front and its back), or the take is refused
//!     `part.grip-out-of-reach`, naming the carrier and how far it is, before anything is written. A frame that stands
//!     is held at its edges along the line its carriers stand on, so it is taken from beside its edges, not from its
//!     faces. The lift (`carry:lift`, `crate::engine`) checks the same holds, `carry-grip-out-of-reach`. Not checked:
//!     each carrier's reach of its hold where the part is before the take; it comes to their middle on the take's
//!     track, from up to [`GRASP`] off.
//!   - **At the put** ([`ways`]): every carrier must be within reach where the set-in track starts
//!     (`part.grip-out-of-reach`, naming it: one who stepped away walks back to its grip, an ordinary walk, and the crew
//!     puts again). On the track each carrier either stands or walks beside the part, keeping its place from it
//!     ([`Walk`]: the world carries its body along a straight line on its ground at the track's own pace, as it
//!     carries a body out of a seat, so it is where its hold is all the way). A set-in that moves the part less than
//!     [`WALK_LEAST`] on the plan moves nobody. Beyond that a side carrier walks with the part when the straight way
//!     beside it is ground it can stand on, else it stands; the front and the back stand when they reach their holds
//!     at both ends of the track (on a straight track a carrier who stands is farthest from its hold at one end or the
//!     other), else they walk with it. A carrier who can neither stand within reach nor walk beside the part refuses
//!     the put by name before anyone moves. No carrier is exempt: none is named as holding on a track while out of
//!     reach. A seating refused at its track's end or its commit takes its walkers back with the part.
//!   - **While a set-in runs**, a carrier who moves out of reach stops it by name: it goes back as a refused seating
//!     does, to where it started, which every carrier could reach; there its carry goes on, or breaks off when its
//!     carriers have gone (`crate::engine`).
//!
//! Not here: the gathering walk (each Soul walks to its end), a procedure or blueprint, more than one bay.

use std::collections::BTreeMap;

use replica::effects::{Actor, Cause, Effect, Header, Refusal};
use replica::encode::Name;
use replica::ids::{Id, Minter};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, show};
use sim::activity::Activities;
use sim::activity::carry::grips::{self, Grip};
use sim::activity::carry::{Carry, GRIP_REACH, HEIGHT, Load, between, yaw_toward};
use sim::activity::seating::{Seating, Target};
use sim::ground::scene::{slot_points, xform_to};
use sim::structure::Structure;

type R<T> = Result<T, Refusal>;

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// How far the part may be from the middle of its two carriers, along the ground, µm: its middle when it lies, its
/// origin when it stands.
pub const GRASP: i64 = 1_500_000;
/// How far, along the ground, the crew's node may be from where the part goes when it is put: the set-in track is
/// short and straight, not a way to move a part across the world.
pub const PUT_REACH: i64 = 1_000_000;
/// How far on the plan a set-in must move its part before any carrier walks with it, µm: a tick's step. Under it the
/// part is set in between carriers who stand (a frame lowered into its slot, a cloth raised onto its rails).
pub const WALK_LEAST: i64 = 50_000;
/// How long before its set-in track ends a carrier walking beside the part is where it stands at the end, µs: two
/// ticks, so the seating's commit finds every body at rest.
const WALK_EARLY: Micros = 100_000;
/// The set-in track's pace, µm a second, and its shortest time (#5067: a part set in, or unseated out of its slot, at
/// a crew's pace, never in a quarter of a second): `distance / 0.4 m/s`, at least 0.6 s, in whole ticks.
pub const SET_IN_PACE: i64 = 400_000;
pub const SET_IN_LEAST: Micros = 600_000;

/// How long a set-in (or an unseat's way out, or a set-in's way back) that moves its crew's node `far` µm takes, µs:
/// at [`SET_IN_PACE`], at least [`SET_IN_LEAST`], in whole ticks.
pub fn set_in_time(far: i64) -> Micros {
    let tick = i128::from(sim::activity::carry::HOIST_TICK);
    let us = (i128::from(far.max(0)) * 1_000_000 / i128::from(SET_IN_PACE)).max(i128::from(SET_IN_LEAST));
    i64::try_from((us + tick - 1) / tick * tick).unwrap_or(Micros::MAX)
}

/// How far apart two points are, µm.
fn dist(a: Vec3, b: Vec3) -> i64 {
    let d = |p: i64, q: i64| i128::from(p - q).pow(2);
    i64::try_from((d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt()).unwrap_or(i64::MAX)
}

/// Which step a part of entries is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Taken,
    Seated,
    /// A lone holder's frame laid down beside its bay (0.135 A2's third review).
    Laid,
    /// A retiring last holder's structure set down, its kept hold's node removed (0.135 A2, after review nine).
    Retired,
}

/// A take or a seating, to be committed through the walkers' maps: its intent and Soul, its crew, its entries.
#[derive(Clone, Debug)]
pub struct Ready {
    pub intent: Id,
    pub soul: Id,
    pub activity: Id,
    pub step: Step,
    pub effects: Vec<Effect>,
}

impl Ready {
    /// The seating as the walkers' ground sees it: the part's move and its joints, without the crew's node, which no
    /// walkers' map holds (their tree takes only what changes geometry). A take is not written to their map at all, so
    /// to them a part stays where it last rested until it is seated again.
    pub fn town_part(&self) -> Vec<Effect> {
        use replica::effects::{Body, Change, TransferRec};
        let crew = self.activity;
        let kept: std::collections::BTreeSet<Id> = self
            .effects
            .iter()
            .filter_map(|e| match &e.body {
                Body::Transfer(TransferRec::Leave { transfer, node, .. }) if *node != crew => {
                    Some(*transfer)
                }
                _ => None,
            })
            .collect();
        self.effects
            .iter()
            .filter(|e| e.envelope.node != crew)
            .filter(|e| match &e.body {
                Body::Transfer(TransferRec::Leave { node, .. }) => *node != crew,
                Body::Transfer(TransferRec::Arrive { transfer, .. }) => kept.contains(transfer),
                Body::Changes(cs) => cs.iter().all(|c| match &c.change {
                    Change::Link { ends, .. } => !ends.contains(&crew),
                    _ => true,
                }),
                _ => true,
            })
            .cloned()
            .collect()
    }
}

/// A crew setting its part in: where it goes, when the track ends, whose intent asked, its crew's reach, and the
/// track its node is on and where that ends, to stop it there if the seating is refused.
#[derive(Clone, Debug)]
pub struct Setting {
    pub part: Id,
    target: Target,
    due: Micros,
    pub by: (Id, Id),
    pub ground: Id,
    reach: i64,
    /// Where the set-in track started (the crew's node between its carriers) and when, and where it ends: the node's
    /// pose that has the part, in its slot as it is held, exactly where it is seated (#5067). Its samples go from one to
    /// the other a tick at a time, the position in a straight line and the turn blended (`carry::between`).
    pub start: (Vec3, Quat),
    t0: Micros,
    pub end: (Vec3, Quat),
    /// Between its carriers along the ground when the put was asked, µm: the carry's span when it starts again.
    pub span: i64,
    /// Its carriers where its track started, every one within reach of its hold there (#5067): they stay within reach.
    pub holding: Vec<Id>,
    /// Its carriers who walk beside the part on the track, each from where it stood to where it stands at the end.
    pub walks: Vec<Walk>,
}

/// The crews' seating in a running world.
pub struct Assembly {
    seating: Seating,
    /// The kinds a slot seats turned either way ([`symmetric_kinds`]).
    pub symmetric: std::collections::BTreeSet<String>,
    /// The part each crew holds in its slot, taken and committed (or waiting to be).
    pub held: BTreeMap<Id, Id>,
    setting: BTreeMap<Id, Setting>,
    /// Seatings written at their track's end and waiting for their commit.
    committing: BTreeMap<Id, Setting>,
    /// Takes and seatings waiting for their commit, in order.
    pub ready: Vec<Ready>,
    /// Seatings refused when their track ended: the intent, its Soul and why.
    pub refused: Vec<(Id, Id, Refusal)>,
    /// Seatings refused at their track's end or at their commit, by crew: to be stopped ([`Assembly::stop`]).
    pub stopped: Vec<(Id, Setting)>,
    /// Entries written at a track's end (the node at rest at the slot), by intent and Soul, for the engine to send.
    pub moved: Vec<((Id, Id), Vec<Effect>)>,
    /// Crews' nodes going back to where their set-in started: the setting, when each gets there, and where and when
    /// its way back began.
    returning: BTreeMap<Id, (Setting, Micros, (Vec3, Quat), Micros)>,
}

fn kind_of(tree: &Tree, id: Id) -> R<Name> {
    tree.handle(id)
        .and_then(|h| tree.node(h))
        .map(|n| n.kind().clone())
        .ok_or_else(|| refusal("part-missing", show(id)))
}

/// `reach.too-high` when a part `above` µm over its carriers' feet is beyond their standing `reach`.
fn within_reach(above: i64, reach: i64) -> R<()> {
    if above > reach {
        return Err(refusal(
            "reach.too-high",
            format!("{above} µm above its carriers' feet, standing reach {reach} µm"),
        ));
    }
    Ok(())
}

/// A carrier holding a crew's part, for the reach of its grip (#5067 item 3): its body, where its feet are on the crew's
/// ground, its standing reach, and where it holds the part in the crew's node's frame (µm).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Carrier {
    pub body: Id,
    pub feet: Vec3,
    pub reach: i64,
    pub grip: Vec3,
}

/// `part.grip-out-of-reach`, naming the first of `carriers` that would not reach where it holds the part with the crew's
/// node at `node` (on the crew's ground, µm): more than [`GRIP_REACH`] from it on the plan, or it more than the
/// carrier's standing reach above its feet.
pub fn out_of_reach(carriers: &[Carrier], node: (Vec3, Quat)) -> R<()> {
    for c in carriers {
        let g = node
            .1
            .rotate(c.grip)
            .map_err(|e| refusal("part-pose", format!("{e:?}")))?;
        let at = Vec3::new(node.0.x + g.x, node.0.y + g.y, node.0.z + g.z);
        let (dx, dz) = (i128::from(at.x - c.feet.x), i128::from(at.z - c.feet.z));
        let off = (dx * dx + dz * dz).isqrt();
        let up = at.y - c.feet.y;
        if off > i128::from(GRIP_REACH) || up > c.reach {
            return Err(refusal(
                "part.grip-out-of-reach",
                format!(
                    "{} would stand {} mm from its grip, {} mm below it; at most {} mm and {} mm",
                    show(c.body),
                    off / 1000,
                    up / 1000,
                    GRIP_REACH / 1000,
                    c.reach / 1000
                ),
            ));
        }
    }
    Ok(())
}

/// A carrier's walk beside its crew's part on a set-in track or its way back (#5067): its body, where it stands when
/// the track starts and when it ends, on the crew's ground (µm), and its pace, µm a second. The world carries its
/// body along that straight line (`sim::controller::Track`), never a jump.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Walk {
    pub body: Id,
    pub from: Vec3,
    pub to: Vec3,
    pub speed: i64,
}

impl Walk {
    /// The same walk the other way, in `span` µs: the way back of a seating refused.
    pub fn back(&self, span: Micros) -> Walk {
        Walk {
            body: self.body,
            from: self.to,
            to: self.from,
            speed: pace(self.from, self.to, span),
        }
    }
}

/// The pace, µm a second, that takes a body from `a` to `b` on the plan [`WALK_EARLY`] before `span` µs are over.
fn pace(a: Vec3, b: Vec3, span: Micros) -> i64 {
    let far = (i128::from(b.x - a.x).pow(2) + i128::from(b.z - a.z).pow(2)).isqrt();
    let time = i128::from((span - WALK_EARLY).max(WALK_EARLY));
    // Rounded up: never a step late.
    i64::try_from((far * 1_000_000 + time - 1) / time)
        .unwrap_or(i64::MAX)
        .max(1)
}

/// Who stands and who walks on a set-in track from `from` to `to` (the crew's node's position at each end, its turn
/// `turn` all the way), of `carriers`, the crew's `ends` its front and its back (#5067, see the module's notes).
/// `walkable(body, a, b)`: whether `body` may walk the straight way from `a` to `b` on its ground now. Each walk from
/// where the carrier stands to the same place from the part at the track's end; its pace is set by the track's time
/// ([`Walk::back`], [`Assembly::put`]). `part.grip-out-of-reach`, naming the carrier, when one is out of reach where
/// the track starts, or could neither stand within reach to its end nor walk beside the part.
pub fn ways(
    carriers: &[Carrier],
    ends: [Id; 2],
    from: Vec3,
    to: Vec3,
    turn: Quat,
    walkable: &dyn Fn(Id, Vec3, Vec3) -> bool,
) -> R<Vec<Walk>> {
    ways_turning(carriers, ends, from, to, (turn, turn), walkable)
}

/// [`ways`] for a set-in whose node turns from `turns.0` where it starts to `turns.1` where it ends (#5067: the part
/// seated turned as its slot is): each carrier's reach at the end is judged with the end's turn.
pub fn ways_turning(
    carriers: &[Carrier],
    ends: [Id; 2],
    from: Vec3,
    to: Vec3,
    (turn, end_turn): (Quat, Quat),
    walkable: &dyn Fn(Id, Vec3, Vec3) -> bool,
) -> R<Vec<Walk>> {
    out_of_reach(carriers, (from, turn))?;
    let turn = end_turn;
    let (dx, dz) = (to.x - from.x, to.z - from.z);
    let far = (i128::from(dx).pow(2) + i128::from(dz).pow(2)).isqrt();
    if far <= i128::from(WALK_LEAST) {
        out_of_reach(carriers, (to, turn))?;
        return Ok(Vec::new());
    }
    let mut walks = Vec::new();
    for c in carriers {
        let beside = Vec3::new(c.feet.x + dx, c.feet.y, c.feet.z + dz);
        let stands = out_of_reach(&[*c], (to, turn));
        let walks_it = match (ends.contains(&c.body), &stands) {
            // The front and the back stand when they can.
            (true, Ok(())) => false,
            _ => walkable(c.body, c.feet, beside),
        };
        if walks_it {
            walks.push(Walk {
                body: c.body,
                from: c.feet,
                to: beside,
                speed: 0,
            });
        } else if let Err(r) = stands {
            return Err(refusal(
                r.name,
                format!(
                    "{}; and the way beside the part, to ({}, {}) mm, is not ground it can walk",
                    r.detail,
                    beside.x / 1000,
                    beside.z / 1000
                ),
            ));
        }
    }
    Ok(walks)
}

/// Of `parts` seated in `bay` (node `th`), those at the level under its slot `k` (#5067): whose slot points are the
/// highest at or under slot `k`'s (within 10 mm), in the bay's own frame. All of them when none is under it.
fn at_level(tree: &Tree, th: replica::tree::Handle, k: u64, parts: Vec<Id>) -> Vec<Id> {
    let y = |n: u64| sim::ground::scene::slot_point(tree, th, n).map(|p| p.y);
    let Some(own) = y(k) else { return parts };
    let height = |id: &Id| {
        tree.handle(*id)
            .and_then(|h| tree.node(h))
            .and_then(|n| n.slot())
            .and_then(y)
    };
    let under = parts
        .iter()
        .filter_map(height)
        .filter(|h| *h <= own + 10_000)
        .max();
    match under {
        Some(top) => parts
            .into_iter()
            .filter(|p| height(p).is_some_and(|h| (h - top).abs() <= 10_000))
            .collect(),
        None => parts,
    }
}

/// The words a put's `part.grip-out-of-reach` ends with, then `x=<mm> z=<mm> mm`, when the put would be admitted with
/// the crew's node there on its ground (#5067): a contract, read by the client's `part put`.
pub const ADMITTED_AT: &str = "admitted with the crew's node at";
/// The step and the extent of [`admitted_from`]'s search about where the part goes, µm.
const ADMIT_STEP: i64 = 50_000;
/// How far inside a carrier's reach the place [`admitted_from`] names leaves each one who stands, µm.
const ADMIT_MARGIN: i64 = 50_000;

/// Where, nearest `from` on the plan, crew `carriers` (ends `ends`) whose node goes from there to `to` on a set-in
/// would be admitted (#5067): the whole crew moved together, each carrier the same way as its node, and [`ways`] asked
/// of it there, within [`PUT_REACH`] of `to`. None when nowhere within it is.
pub fn admitted_from(
    carriers: &[Carrier],
    ends: [Id; 2],
    from: (Vec3, Quat),
    (to, end_turn): (Vec3, Quat),
    walkable: &dyn Fn(Id, Vec3, Vec3) -> bool,
) -> Option<Vec3> {
    // Moving the whole crew keeps every carrier's reach where the set-in starts: one out of reach there is not helped.
    if out_of_reach(carriers, from).is_err() {
        return None;
    }
    let n = PUT_REACH / ADMIT_STEP;
    let mut spots: Vec<(i128, i64, i64)> = (-n..=n)
        .flat_map(|i| (-n..=n).map(move |k| (i * ADMIT_STEP, k * ADMIT_STEP)))
        .filter(|(dx, dz)| i128::from(*dx).pow(2) + i128::from(*dz).pow(2) <= i128::from(PUT_REACH).pow(2))
        .map(|(dx, dz)| {
            let (x, z) = (to.x + dx, to.z + dz);
            (i128::from(x - from.0.x).pow(2) + i128::from(z - from.0.z).pow(2), x, z)
        })
        .collect();
    spots.sort_unstable();
    spots.into_iter().find_map(|(_, x, z)| {
        let d = (x - from.0.x, z - from.0.z);
        let moved: Vec<Carrier> = carriers
            .iter()
            .map(|c| Carrier {
                feet: Vec3::new(c.feet.x + d.0, c.feet.y, c.feet.z + d.1),
                ..*c
            })
            .collect();
        let at = Vec3::new(x, from.0.y, z);
        // With a margin: every carrier who stands to the end (walks for no one) is [`ADMIT_MARGIN`] inside its reach
        // there, judged with its feet that much further off its grip, so a walk that ends a few centimetres off still
        // reaches.
        let walks = ways_turning(&moved, ends, at, to, (from.1, end_turn), walkable).ok()?;
        let standing: Vec<Carrier> = moved
            .iter()
            .filter(|c| !walks.iter().any(|w| w.body == c.body))
            .map(|c| {
                let g = end_turn.rotate(c.grip).unwrap_or(c.grip);
                let grip = [to.x + g.x, to.z + g.z];
                let (dx, dz) = (i128::from(c.feet.x - grip[0]), i128::from(c.feet.z - grip[1]));
                let d = (dx * dx + dz * dz).isqrt().max(1);
                let k = |v: i128| (v * (d + i128::from(ADMIT_MARGIN)) / d) as i64;
                Carrier {
                    feet: Vec3::new(grip[0] + k(dx), c.feet.y, grip[1] + k(dz)),
                    ..*c
                }
            })
            .collect();
        out_of_reach(&standing, (to, end_turn)).is_ok().then_some(at)
    })
}

/// A take, written (#5067): the crew's node's pose where the part was taken (`from`: the part did not move), its pose
/// between its carriers at carrying height (`to`: where its carry's track takes it), where the part lay on the crew's
/// ground (`lay`), and each carrier with its hold in the node's frame.
#[derive(Clone, Debug)]
pub struct Taken {
    pub from: (Vec3, Quat),
    pub to: (Vec3, Quat),
    pub lay: (Vec3, Quat),
    pub carriers: Vec<Carrier>,
    /// Whether the part rested on the crew's ground itself (not in a bay's slot or a stand's): where a take broken off
    /// on its track may set it back.
    pub rested: bool,
}

/// A carrier where it stands (#5067): its body, its feet on the crew's ground (µm) and its standing reach (µm).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stood {
    pub body: Id,
    pub feet: Vec3,
    pub reach: i64,
}

/// A crew at a load it would take or lift, for each carrier's reach of its own hold (#5067): the load's grips and the
/// load as its entry states them, its front, its back and its side carriers in join order, each where it stands.
#[derive(Clone, Copy, Debug)]
pub struct Crew<'a> {
    pub grips: &'a [Grip],
    pub load: &'a Load,
    pub front: Stood,
    pub back: Stood,
    pub sides: &'a [Stood],
}

impl Crew<'_> {
    /// Each carrier with the hold the carry's rule gives it ([`grips::assign`], exactly as it will be said), the load
    /// held at `held` in the crew's slot (its position and turn in the crew's node's frame, µm): where it holds the load
    /// (the middle of its hands) in that frame.
    pub fn carriers(&self, held: (Vec3, Quat)) -> R<Vec<Carrier>> {
        let (f, k) = (self.front.feet, self.back.feet);
        let places: Vec<(Id, [i64; 2])> = self
            .sides
            .iter()
            .map(|s| (s.body, Carry::place_of(f, k, s.feet)))
            .collect();
        let holds = grips::assign(
            self.grips,
            self.load,
            held,
            self.front.body,
            self.back.body,
            &places,
        )?;
        let pose = |e| refusal("part-pose", format!("{e:?}"));
        let ends = [self.front, self.back];
        let mut out = Vec::new();
        for h in &holds {
            let Some(s) = ends.iter().chain(self.sides).find(|s| s.body == h.body) else {
                continue;
            };
            let g = held.1.rotate(h.middle()).map_err(pose)?;
            out.push(Carrier {
                body: s.body,
                feet: s.feet,
                reach: s.reach,
                grip: Vec3::new(held.0.x + g.x, held.0.y + g.y, held.0.z + g.z),
            });
        }
        Ok(out)
    }
}

/// A crew's node on its set-in track or its way back (#5067 item 3, [`Assembly::tracks`]): its crew, where the node is
/// on its ground (µm), when the track ends, whether it is the way back, and its carriers, held to their reach on it.
#[derive(Clone, Copy, Debug)]
pub struct OnTrack<'a> {
    pub activity: Id,
    pub node: (Vec3, Quat),
    pub until: Micros,
    pub back: bool,
    pub holding: &'a [Id],
}

/// The conjugate of a unit quaternion: its inverse turn.
fn conj(q: Quat) -> R<Quat> {
    let [w, x, y, z] = q.parts();
    // A half turn (w 0) is written with its other sign, its one byte form (as the deck lane's #5256 has it).
    Quat::new(w, -x, -y, -z)
        .or_else(|_| Quat::new(-w, x, y, z))
        .map_err(|e| refusal("part-pose", format!("{e:?}")))
}

/// The kinds (plain names) whose entries say they are the same turned a half turn about their upright
/// (`state.symmetry`'s default `front_back`, #5067): seated in a slot turned either way, the nearer.
pub fn symmetric_kinds(entries: &replica::rules::json::Value) -> std::collections::BTreeSet<String> {
    use replica::rules::json::Value as Json;
    entries
        .obj()
        .unwrap_or(&[])
        .iter()
        .filter_map(|(_, e)| {
            let sym = e
                .get("state")
                .and_then(|s| s.get("symmetry"))
                .and_then(|f| f.get("default"))
                .and_then(Json::str);
            (sym == Some("front_back")).then(|| e.get("kind").and_then(Json::str).map(str::to_owned))?
        })
        .collect()
}

impl Assembly {
    pub fn new(header: Header, rules: Rules, structure: Structure) -> Assembly {
        Assembly {
            symmetric: std::collections::BTreeSet::new(),
            // The ground and audience are each crew's own, set as it acts ([`Assembly::aim`]).
            seating: Seating::new(
                header.clone(),
                rules,
                structure,
                header.zone,
                Audience::Everyone,
            ),
            held: BTreeMap::new(),
            setting: BTreeMap::new(),
            committing: BTreeMap::new(),
            ready: Vec::new(),
            refused: Vec::new(),
            stopped: Vec::new(),
            moved: Vec::new(),
            returning: BTreeMap::new(),
        }
    }

    /// Whether `kind` is a part B18 reads.
    pub fn is_part(&self, kind: &str) -> bool {
        self.seating.structure.is_part(kind)
    }

    /// Whether `kind` is a bay (B18's reading).
    pub fn is_bay(&self, kind: &str) -> bool {
        self.seating.structure.is_bay(kind)
    }

    /// The joined-part rule (B18) the crews' seating is checked by.
    pub fn structure(&self) -> &Structure {
        &self.seating.structure
    }

    /// Whether the world's kinds join parts at all.
    pub fn any(&self) -> bool {
        !self.seating.structure.kinds().0.is_empty()
    }

    fn aim(&mut self, tree: &Tree, activity: Id, ground: Id) -> R<()> {
        self.seating.ground = ground;
        self.seating.audience = tree
            .handle(activity)
            .and_then(|h| tree.node(h))
            .map(|n| n.audience())
            .ok_or_else(|| refusal("activity-missing", show(activity)))?;
        Ok(())
    }

    fn drain(&mut self, by: (Id, Id), activity: Id, step: Step) {
        let effects: Vec<Effect> = self
            .seating
            .parts
            .drain(..)
            .flatten()
            .map(|mut e| {
                e.envelope.cause = Cause::Intent(by.0);
                e.envelope.actor = Actor::Soul(by.1);
                e
            })
            .collect();
        self.ready.push(Ready {
            intent: by.0,
            soul: by.1,
            activity,
            step,
            effects,
        });
    }

    /// `part:take` (`unseat` false) or `part:unseat` (true) by crew `activity`, whose carriers stand at `front` and
    /// `back` on `ground` (µm in its frame): the part into the crew's slot, written on `tree` and waiting in
    /// [`Assembly::ready`]. `crew`, for a part that is a load with grips: every carrier where it stands, each refused
    /// `part.grip-out-of-reach` by name when it does not reach its hold as the crew will hold the part (#5067), before
    /// anything is written. The crew's node is written where the part is ([`Taken`]); its carry takes it from there.
    #[allow(clippy::too_many_arguments)]
    pub fn take(
        &mut self,
        tree: &mut Tree,
        acts: &Activities,
        mint: &mut Minter,
        now: Micros,
        by: (Id, Id),
        activity: Id,
        part: Id,
        (front, back): (Vec3, Vec3),
        ground: Id,
        unseat: bool,
        reach: i64,
        crew: Option<&Crew>,
    ) -> R<Taken> {
        if self.held.contains_key(&activity) {
            return Err(refusal("part.held", show(activity)));
        }
        let s = &self.seating.structure;
        if !s.is_crew(kind_of(tree, activity)?.as_str()) {
            return Err(refusal("part.not-a-crew", show(activity)));
        }
        if !s.is_part(kind_of(tree, part)?.as_str()) {
            return Err(refusal("part.not-a-part", show(part)));
        }
        let ph = tree
            .handle(part)
            .ok_or_else(|| refusal("part-missing", show(part)))?;
        let owner = |id: Id| {
            kind_of(tree, id).ok().and_then(|k| {
                self.seating
                    .rules
                    .kinds
                    .get(k.as_str())
                    .map(|d| d.owner.clone())
            })
        };
        if let Some(p) = tree.node(ph).and_then(|n| n.parent()) {
            match owner(p).as_deref() {
                Some("family") => return Err(refusal("part.in-a-hand", show(p))),
                Some("activity") if p != activity => {
                    return Err(refusal("part.held-by-another", show(p)));
                }
                _ => {}
            }
        }
        if let Some(other) = tree
            .children(ph)
            .unwrap_or(&[])
            .iter()
            .filter_map(|h| tree.node(*h))
            .map(|n| n.id())
            // A hold of fewer than two may be taken over: its holder cannot carry the part out alone.
            .find(|c| {
                *c != activity
                    && owner(*c).as_deref() == Some("activity")
                    && acts.members(*c).map_or(0, <[_]>::len) >= 2
            })
        {
            return Err(refusal("part.held-by-another", show(other)));
        }
        let gh = tree
            .handle(ground)
            .ok_or_else(|| refusal("part-missing", show(ground)))?;
        let in_bay = tree
            .node(ph)
            .and_then(|n| n.parent())
            .map(|p| kind_of(tree, p))
            .transpose()?
            .is_some_and(|k| self.seating.structure.is_bay(k.as_str()));
        match (unseat, in_bay) {
            (true, false) => return Err(refusal("part.not-seated", show(part))),
            (false, true) => return Err(refusal("part.seated", show(part))),
            _ => {}
        }
        let at = xform_to(tree, ph, gh).map_err(|e| refusal("part-pose", e))?;
        let rested = tree.node(ph).and_then(|n| n.parent()) == Some(ground);
        let middle = Vec3::new(
            (front.x + back.x) / 2,
            (front.y + back.y) / 2,
            (front.z + back.z) / 2,
        );
        within_reach(at.pos.y - middle.y, reach)?;
        // A part that lies is measured, and held, by its middle (a laid frame's origin is its foot, 1.2 m from it), as
        // the lift measures it; one that stands, or one of no entry, by its origin.
        let pose = |e| refusal("part-pose", format!("{e:?}"));
        let lies = match crew {
            Some(c) => c.load.lies_along(at.rot)?.is_some(),
            None => false,
        };
        let off = match crew {
            Some(c) if lies => at.rot.rotate(c.load.middle).map_err(pose)?,
            _ => Vec3::ZERO,
        };
        let (dx, dz) = (
            i128::from(at.pos.x + off.x - middle.x),
            i128::from(at.pos.z + off.z - middle.z),
        );
        if dx * dx + dz * dz > i128::from(GRASP).pow(2) {
            return Err(refusal(
                "part.out-of-reach",
                format!(
                    "{} is {} mm from the middle of its carriers",
                    show(part),
                    (dx * dx + dz * dz).isqrt() / 1000
                ),
            ));
        }
        let turn = yaw_toward([front.x - back.x, front.z - back.z])?;
        let inside = conj(turn)?
            .then(at.rot)
            .map_err(|e| refusal("part-pose", format!("{e:?}")))?;
        // A part that lies (a frame laid flat, whose origin is its foot) is held by its middle between its carriers, as a
        // lift holds it: its origin at their middle would put both its grips on one side of them, out of one's reach.
        // One that stands, or whose origin is over its middle already (a beam), is held where its origin is.
        let slot = match crew {
            Some(c) if lies => {
                let m = inside.rotate(c.load.middle).map_err(pose)?;
                Vec3::new(-m.x, 0, -m.z)
            }
            _ => Vec3::ZERO,
        };
        // #5067: the carry's own height: a part that stands as it is held is lifted clear of the ground, any other
        // carried where a standing body holds it (`Load::held_at`).
        let height = match crew {
            Some(c) => c.load.held_at(slot, inside)?.carried,
            None => HEIGHT,
        };
        let frame = Vec3::new(middle.x, middle.y + height, middle.z);
        // #5067: every carrier reaches the hold the carry's rule gives it, as the crew will hold the part (the node
        // between its front and its back, the part in its slot turned as it is).
        let carriers = match crew {
            Some(crew) => crew.carriers((slot, inside))?,
            None => Vec::new(),
        };
        out_of_reach(&carriers, (frame, turn))?;
        // The crew's node is set where the part is, so its change of parent moves nothing (#5067): from there the
        // crew's carry takes it into its carriers' hands on a track (`Carry::take_up`), never in one step.
        let off = turn.rotate(slot).map_err(pose)?;
        let from = Vec3::new(at.pos.x - off.x, at.pos.y - off.y, at.pos.z - off.z);
        self.aim(tree, activity, ground)?;
        self.seating.take(
            tree,
            acts,
            mint,
            now,
            activity,
            part,
            (from, turn),
            (slot, inside),
        )?;
        self.drain(by, activity, Step::Taken);
        self.held.insert(activity, part);
        Ok(Taken {
            from: (from, turn),
            to: (frame, turn),
            lay: (at.pos, at.rot),
            carriers,
            rested,
        })
    }

    /// The take of `part:raise` and `part:lower` (#5067): `part`, lying or standing on `ground`, into crew `activity`'s
    /// slot with the crew's node set where the part is, turned as it is, so the part rides it unturned at its origin
    /// (its foot) and nothing moves. Written on `tree` and waiting in [`Assembly::ready`] as a take. Returns where the
    /// part is on `ground`.
    #[allow(clippy::too_many_arguments)]
    pub fn pivot(
        &mut self,
        tree: &mut Tree,
        acts: &Activities,
        mint: &mut Minter,
        now: Micros,
        by: (Id, Id),
        activity: Id,
        part: Id,
        ground: Id,
    ) -> R<(Vec3, Quat)> {
        if self.held.contains_key(&activity) {
            return Err(refusal("part.held", show(activity)));
        }
        let s = &self.seating.structure;
        if !s.is_crew(kind_of(tree, activity)?.as_str()) {
            return Err(refusal("part.not-a-crew", show(activity)));
        }
        if !s.is_part(kind_of(tree, part)?.as_str()) {
            return Err(refusal("part.not-a-part", show(part)));
        }
        let (ph, gh) = match (tree.handle(part), tree.handle(ground)) {
            (Some(p), Some(g)) => (p, g),
            _ => return Err(refusal("part-missing", show(part))),
        };
        let owner = |id: Id| {
            kind_of(tree, id).ok().and_then(|k| {
                self.seating
                    .rules
                    .kinds
                    .get(k.as_str())
                    .map(|d| d.owner.clone())
            })
        };
        // Another crew of two or more on the part holds it: theirs to raise or lower.
        if let Some(other) = tree
            .children(ph)
            .unwrap_or(&[])
            .iter()
            .filter_map(|h| tree.node(*h))
            .map(|n| n.id())
            .find(|c| {
                *c != activity
                    && owner(*c).as_deref() == Some("activity")
                    && acts.members(*c).map_or(0, <[_]>::len) >= 2
            })
        {
            return Err(refusal("part.held-by-another", show(other)));
        }
        let at = xform_to(tree, ph, gh).map_err(|e| refusal("part-pose", e))?;
        self.aim(tree, activity, ground)?;
        self.seating.take(
            tree,
            acts,
            mint,
            now,
            activity,
            part,
            (at.pos, at.rot),
            (Vec3::ZERO, Quat::IDENTITY),
        )?;
        self.drain(by, activity, Step::Taken);
        self.held.insert(activity, part);
        Ok((at.pos, at.rot))
    }

    /// The end of a raise or a lowering (#5067): crew `activity`'s `part` out of its slot onto `ground` at `at` (its
    /// position and turn there), its crew holding it on (`hold`: a part stood up, their node under it) or their node at
    /// rest (one laid down). No track: the part is there already. Checked as a seating is (`site.occupied` when a body
    /// stands where it would be), then written on `tree` and waiting in [`Assembly::ready`] as a seating.
    #[allow(clippy::too_many_arguments)]
    pub fn settle(
        &mut self,
        tree: &mut Tree,
        acts: &Activities,
        mint: &mut Minter,
        now: Micros,
        by: (Id, Id),
        activity: Id,
        part: Id,
        ground: Id,
        at: (Vec3, Quat),
        hold: bool,
        reach: i64,
    ) -> R<()> {
        let target = Target {
            to: Frame {
                node: ground,
                slot: None,
            },
            place: at.0,
            turn: at.1,
            at: at.0,
            joins: Vec::new(),
            hold,
        };
        self.aim(tree, activity, ground)?;
        let done = self
            .seating
            .check(
                tree,
                acts,
                &mut mint.clone(),
                activity,
                part,
                &target,
                reach,
                &[],
            )
            .and_then(|()| {
                self.seating
                    .put(tree, acts, mint, now, activity, part, &target)
            });
        if let Err(r) = done {
            self.seating.parts.clear();
            return Err(r);
        }
        self.drain(by, activity, Step::Seated);
        Ok(())
    }

    /// The end of a raise into a bay's slot (#5067): crew `activity`'s `part`, standing at `at` (the slot's point on
    /// the crew's ground, the part slid there), seated in slot `k` of `bay` with its crew holding it, their node under it.
    /// Checked as a seating is (`slot.occupied`, `site.occupied`, the bay's rules), then written on `tree` and waiting
    /// in [`Assembly::ready`] as a seating. A standing part in a bay is joined to nothing by default, as a put's is.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_into(
        &mut self,
        tree: &mut Tree,
        acts: &Activities,
        mint: &mut Minter,
        now: Micros,
        by: (Id, Id),
        activity: Id,
        part: Id,
        (bay, k, at, turned): (Id, u64, Vec3, Quat),
        ground: Id,
        reach: i64,
    ) -> R<()> {
        self.aim(tree, activity, ground)?;
        // Turned as the slot, or a half turn from it for a part the same either way (`turned`: its pose on the ground).
        let turn = {
            let (bh, gh) = tree
                .handle(bay)
                .zip(tree.handle(ground))
                .ok_or_else(|| refusal("part-nowhere", show(bay)))?;
            let x = xform_to(tree, bh, gh).map_err(|e| refusal("part-pose", e))?;
            conj(x.rot)?
                .then(turned)
                .map_err(|e| refusal("part-pose", format!("{e:?}")))?
        };
        let target = Target {
            to: Frame {
                node: bay,
                slot: Some(k),
            },
            place: Vec3::ZERO,
            turn,
            at,
            joins: Vec::new(),
            hold: true,
        };
        let done = self
            .seating
            .check(tree, acts, &mut mint.clone(), activity, part, &target, reach, &[])
            .and_then(|()| self.seating.put(tree, acts, mint, now, activity, part, &target));
        if let Err(r) = done {
            self.seating.parts.clear();
            return Err(r);
        }
        self.drain(by, activity, Step::Seated);
        Ok(())
    }

    /// `part:put` by crew `activity`, its node now at `from` on `ground` and its members reaching `reach` µm: the
    /// part to `to`'s slot `slot` (or to `point` in `to`'s frame), joined to `joins` (by default, a bearing part to the
    /// bay's standing parts, a resting part to its bearing ones). `carriers`: everyone holding the part, each within
    /// reach of its hold where the set-in track starts, and to its end standing within reach or walking beside the part
    /// ([`ways`], `walkable` as there), or the put is refused `part.grip-out-of-reach` (#5067). Refused before anyone
    /// moves; else the set-in track is written on `tree`, the seating waits for its end ([`Assembly::due`]), and the
    /// walks returned are the caller's to start.
    #[allow(clippy::too_many_arguments)]
    pub fn put(
        &mut self,
        tree: &mut Tree,
        acts: &Activities,
        mint: &Minter,
        now: Micros,
        by: (Id, Id),
        activity: Id,
        (to, slot, point): (Id, Option<u64>, Option<Vec3>),
        joins: Option<Vec<Id>>,
        reach: i64,
        from: (Vec3, Quat),
        ground: Id,
        apart: i64,
        carriers: &[Carrier],
        walkable: &dyn Fn(Id, Vec3, Vec3) -> bool,
    ) -> R<(Vec<Effect>, Vec<Walk>)> {
        let part = *self
            .held
            .get(&activity)
            .ok_or_else(|| refusal("part.not-held", show(activity)))?;
        if self.busy(activity) {
            return Err(refusal("part.setting-in", show(activity)));
        }
        let s = &self.seating.structure;
        let (pk, tk) = (kind_of(tree, part)?, kind_of(tree, to)?);
        let (th, gh) = match (tree.handle(to), tree.handle(ground)) {
            (Some(t), Some(g)) => (t, g),
            _ => return Err(refusal("part-nowhere", show(to))),
        };
        let bay = slot.is_some() && s.is_bay(tk.as_str());
        let (place, at) = match (slot, point) {
            (Some(k), _) => {
                let at = slot_points(tree, th, gh)
                    .map_err(|e| refusal("part-pose", e))?
                    .into_iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, p)| p)
                    .ok_or_else(|| {
                        refusal("slot.unknown", format!("{} has no slot {k}", show(to)))
                    })?;
                (Vec3::ZERO, at)
            }
            (None, Some(p)) => {
                let x = xform_to(tree, th, gh).map_err(|e| refusal("part-pose", e))?;
                (p, x.point(p).map_err(|e| refusal("part-pose", e))?)
            }
            (None, None) => return Err(refusal("part-needs-a-place", "parameter 2 or 3")),
        };
        let (dx, dz) = (i128::from(at.x - from.0.x), i128::from(at.z - from.0.z));
        if dx * dx + dz * dz > i128::from(PUT_REACH).pow(2) {
            return Err(refusal(
                "part.out-of-reach",
                format!(
                    "{} mm from where it would go",
                    (dx * dx + dz * dz).isqrt() / 1000
                ),
            ));
        }
        // #5067: where the set-in's track ends, the crew's node posed so the part, in its slot as it is held, is
        // exactly where it is seated (at `at`, turned as `to` is): it is never moved or turned at the commit.
        let pose = |e| refusal("part-pose", format!("{e:?}"));
        let held = tree
            .handle(part)
            .and_then(|h| tree.node(h))
            .and_then(|n| n.place())
            .ok_or_else(|| refusal("part.not-held", show(part)))?;
        let x = xform_to(tree, th, gh).map_err(|e| refusal("part-pose", e))?;
        // A part the same turned a half turn about its upright is seated turned the nearer way to how it is held now
        // (#5067: `symmetry` `front_back`).
        let half = Quat::from_yaw_mdeg(180_000).map_err(pose)?;
        let seat_turn = match slot.is_some() && self.symmetric.contains(replica::world_model::plain(pk.as_str())) {
            true => {
                let now = from.1.then(held.orientation).map_err(pose)?;
                let ax = |q: Quat| q.rotate(Vec3::new(1 << 20, 0, 0)).map_err(pose);
                let (a, b) = (ax(now)?, ax(x.rot)?);
                if i128::from(a.x) * i128::from(b.x) + i128::from(a.z) * i128::from(b.z) < 0 {
                    half
                } else {
                    Quat::IDENTITY
                }
            }
            false => Quat::IDENTITY,
        };
        let end = {
            let q = x
                .rot
                .then(seat_turn)
                .map_err(pose)?
                .then(conj(held.orientation)?)
                .map_err(pose)?;
            let o = q.rotate(held.position).map_err(pose)?;
            (Vec3::new(at.x - o.x, at.y - o.y, at.z - o.z), q)
        };
        // #5067: every carrier is within reach of its hold where the set-in starts, and to its end stands within reach
        // or walks beside the part. One who can do neither is refused by name, never named as holding.
        let holding = carriers.to_vec();
        let ends = match acts.members(activity) {
            Some([f, b, ..]) => [f.body, b.body],
            _ => return Err(refusal("crew.size", show(activity))),
        };
        let mut walks = match ways_turning(carriers, ends, from.0, end.0, (from.1, end.1), walkable) {
            Ok(w) => w,
            // #5067: refused, it says where the crew's node would be admitted from, nearest where it is: the same
            // admission (`ways`) with the whole crew there, so a client carries it there and asks again.
            Err(mut r) if r.name == "part.grip-out-of-reach" => {
                if let Some(p) = admitted_from(carriers, ends, from, end, walkable) {
                    r.detail = format!("{}; {ADMITTED_AT} x={} z={} mm", r.detail, p.x / 1000, p.z / 1000);
                }
                return Err(r);
            }
            Err(r) => return Err(r),
        };
        // By default a bearing part joins the bay's standing parts; a resting one (a cloth) the bay's bearing parts
        // (its rails), which it rests on.
        let rests = s.rests(pk.as_str());
        let named = joins.is_some();
        let joins = match joins {
            Some(j) => j,
            None if bay && !s.stands(pk.as_str()) => tree
                .children(th)
                .unwrap_or(&[])
                .iter()
                .filter_map(|h| tree.node(*h))
                .filter(|n| {
                    let k = n.kind().as_str();
                    n.slot().is_some() && if rests { s.bears(k) } else { s.stands(k) }
                })
                .map(|n| n.id())
                .collect::<Vec<_>>(),
            None => Vec::new(),
        };
        // #5067: a resting part joins only those at its own level: the ones whose slots are highest at or under its
        // own (a joist the two beams it lies on, not the two below them).
        // Joins named by the put are its own (`--joins`): never filtered.
        let joins = match (rests, slot, named) {
            (true, Some(k), false) => at_level(tree, th, k, joins),
            _ => joins,
        };
        let mut joined = Vec::new();
        for other in joins {
            s.mates(pk.as_str(), kind_of(tree, other)?.as_str())?;
            let ty = s
                .joint_type()
                .and_then(Name::new)
                .ok_or_else(|| refusal("joint-undeclared", pk.as_str()))?;
            joined.push((ty, other));
        }
        let target = Target {
            to: Frame { node: to, slot },
            place,
            turn: seat_turn,
            at,
            joins: joined,
            hold: bay && s.stands(pk.as_str()),
        };
        self.aim(tree, activity, ground)?;
        // Those who will walk beside the part are not where they stand now when it is seated: left out here, counted
        // when its track ends ([`Assembly::due`]).
        let walking: Vec<Id> = walks.iter().map(|w| w.body).collect();
        self.seating.check(
            tree,
            acts,
            &mut mint.clone(),
            activity,
            part,
            &target,
            reach,
            &walking,
        )?;
        // The seating as it would be committed, on a copy: the world's own rules refuse it now, not at the track's end.
        let mut copy = tree.frozen();
        self.seating.put(
            &mut copy,
            acts,
            &mut mint.clone(),
            now,
            activity,
            part,
            &target,
        )?;
        self.seating.parts.clear();
        // #5067: a track as a lift's is, its node's samples written a tick at a time ([`Assembly::step`]) from here,
        // where the carry's last sample has it.
        let span = set_in_time(dist(from.0, end.0));
        let effects = Vec::new();
        for w in &mut walks {
            w.speed = pace(w.from, w.to, span);
        }
        self.setting.insert(
            activity,
            Setting {
                part,
                target,
                due: now + span,
                by,
                ground,
                reach,
                start: from,
                t0: now,
                end,
                span: apart,
                holding: holding.iter().map(|c| c.body).collect(),
                walks: walks.clone(),
            },
        );
        Ok((effects, walks))
    }

    /// Where each crew's node is on its set-in track or its way back at `now` (#5067 item 3).
    pub fn tracks(&self, now: Micros) -> Vec<OnTrack<'_>> {
        let on = |from, to, times| between(from, to, times, now).unwrap_or(to);
        let going = self.setting.iter().map(|(a, s)| OnTrack {
            activity: *a,
            node: on(s.start, s.end, (s.t0, s.due)),
            until: s.due,
            back: false,
            holding: &s.holding,
        });
        let back = self
            .returning
            .iter()
            .map(|(a, (s, end, from, t0))| OnTrack {
                activity: *a,
                node: on(*from, s.start, (*t0, *end)),
                until: *end,
                back: true,
                holding: &s.holding,
            });
        going.chain(back).collect()
    }

    /// One tick `now` of every crew's set-in track and way back (#5067 item 3): one motion sample of each crew's node
    /// where its track has it, written on `tree`, by the put's intent and Soul. A track's last sample is written at its
    /// end ([`Assembly::due`], [`Assembly::returned`]).
    pub fn step(&mut self, tree: &mut Tree, now: Micros) -> Vec<((Id, Id), Vec<Effect>)> {
        let on: Vec<(Id, (Id, Id), Id, (Vec3, Quat))> = self
            .tracks(now)
            .into_iter()
            .filter(|t| now < t.until)
            .filter_map(|t| {
                let s = self
                    .setting
                    .get(&t.activity)
                    .or_else(|| self.returning.get(&t.activity).map(|r| &r.0))?;
                Some((t.activity, s.by, s.ground, t.node))
            })
            .collect();
        let mut out = Vec::new();
        for (activity, by, ground, node) in on {
            match self.hand_off(
                tree,
                now,
                activity,
                ground,
                (Owner::Mover, Owner::Mover),
                node,
                Vec3::ZERO,
            ) {
                Ok(e) => out.push((by, e)),
                Err(r) => eprintln!("worldd: a set-in's sample was not written: {r}"),
            }
        }
        out
    }

    /// When crew `activity`'s set-in track began and ended, while its seating waits for its commit (#5067).
    pub fn set_in_times(&self, activity: Id) -> Option<(Id, Micros, Micros)> {
        self.committing.get(&activity).map(|s| (s.part, s.t0, s.due))
    }

    /// Stops crew `activity`'s set-in by `why` (#5067 item 3: a carrier out of reach of its grip): refused to the put's
    /// intent and stopped as a seating refused at its track's end is ([`Assembly::stop`]).
    pub fn refuse_set_in(&mut self, activity: Id, why: Refusal) {
        if let Some(s) = self.setting.remove(&activity) {
            self.refused.push((s.by.0, s.by.1, why));
            self.stopped.push((activity, s));
        }
    }

    /// Whether a crew is setting a part in.
    pub fn setting_in(&self) -> bool {
        !self.setting.is_empty() || !self.returning.is_empty()
    }

    /// Whether crew `activity`'s part is on its way in or back, or its seating waits for its commit: then the crew is
    /// not left and does not put again.
    pub fn busy(&self, activity: Id) -> bool {
        self.setting.contains_key(&activity)
            || self.committing.contains_key(&activity)
            || self.returning.contains_key(&activity)
    }

    /// The seatings whose track has ended by `now`, written on `tree`: each waits in [`Assembly::ready`], or is refused
    /// into [`Assembly::refused`], the part left in its crew's slot.
    pub fn due(&mut self, tree: &mut Tree, acts: &Activities, mint: &mut Minter, now: Micros) {
        let ended: Vec<Id> = self
            .setting
            .iter()
            .filter(|(_, s)| s.due <= now)
            .map(|(a, _)| *a)
            .collect();
        for activity in ended {
            let Some(s) = self.setting.remove(&activity) else {
                continue;
            };
            // The node's last sample at its track's end, the part exactly where it is seated, whatever its seating's
            // fate: no track runs on past it.
            match self.hand_off(
                tree,
                s.due,
                activity,
                s.ground,
                (Owner::Mover, Owner::Mover),
                s.end,
                Vec3::ZERO,
            ) {
                Ok(effects) => self.moved.push((s.by, effects)),
                Err(r) => eprintln!("worldd: a set-in track was not ended: {r}"),
            }
            // Checked again as the world is now: another crew may have filled the slot, or a Soul stepped in.
            let done = self.aim(tree, activity, s.ground).and_then(|()| {
                self.seating.check(
                    tree,
                    acts,
                    &mut mint.clone(),
                    activity,
                    s.part,
                    &s.target,
                    s.reach,
                    &[],
                )?;
                self.seating
                    .put(tree, acts, mint, s.due, activity, s.part, &s.target)
            });
            match done {
                Ok(()) => {
                    self.drain(s.by, activity, Step::Seated);
                    self.committing.insert(activity, s);
                }
                Err(r) => {
                    self.seating.parts.clear();
                    self.refused.push((s.by.0, s.by.1, r));
                    self.stopped.push((activity, s));
                }
            }
        }
    }

    /// A take's or a seating's commit was written (`written`) or refused: a refused take's crew holds nothing; a
    /// seated part leaves its crew; a refused seating is stopped ([`Assembly::stop`]).
    pub fn written(&mut self, activity: Id, step: Step, written: bool) {
        match (step, written) {
            (Step::Taken, false) => {
                self.held.remove(&activity);
            }
            (Step::Seated, true) => {
                self.committing.remove(&activity);
                self.held.remove(&activity);
            }
            (Step::Seated, false) => {
                if let Some(s) = self.committing.remove(&activity) {
                    self.stopped.push((activity, s));
                }
            }
            (Step::Taken, true) | (Step::Laid, _) | (Step::Retired, _) => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn hand_off(
        &mut self,
        tree: &mut Tree,
        now: Micros,
        activity: Id,
        ground: Id,
        (from, to): (Owner, Owner),
        (position, orientation): (Vec3, Quat),
        linear: Vec3,
    ) -> R<Vec<Effect>> {
        self.aim(tree, activity, ground)?;
        let support = match to {
            Owner::Mover => Support::Surface {
                surface: ground,
                height: 0,
            },
            _ => Support::Track,
        };
        let pose = Pose {
            frame: Frame {
                node: ground,
                slot: None,
            },
            position,
            orientation,
            support,
        };
        let change = replica::effects::Change::Motion(HandOff {
            node: activity,
            at: now,
            from,
            to,
            pose,
            linear,
            angular: Vec3::ZERO,
        });
        let body = replica::effects::Body::Changes(vec![replica::effects::ChangeRec {
            change,
            rest: replica::effects::Rest::new(),
        }]);
        let audience = self.seating.audience;
        self.seating
            .write(tree, now, vec![(activity, audience, body)])?;
        Ok(self.seating.parts.drain(..).flatten().collect())
    }

    /// Stops crew `activity`'s refused seating `s` at `now`, writing on `tree`: its node, where its set-in track has it
    /// now, handed to a straight track back to where the set-in started, the part still in its slot
    /// ([`Assembly::returned`] hands it back to the carry there). Never a jump.
    pub fn stop(
        &mut self,
        tree: &mut Tree,
        now: Micros,
        activity: Id,
        s: Setting,
    ) -> R<Vec<Effect>> {
        // From where its track has it now, back to where it started, a sample a tick (#5067: blended as the set-in is).
        let here = between(s.start, s.end, (s.t0, s.due), now.min(s.due))?;
        let span = set_in_time(dist(here.0, s.start.0));
        let effects = self.hand_off(
            tree,
            now,
            activity,
            s.ground,
            (Owner::Mover, Owner::Mover),
            here,
            Vec3::ZERO,
        )?;
        self.returning.insert(activity, (s, now + span, here, now));
        Ok(effects)
    }

    /// The crews' nodes back where their set-in started by `now`, written on `tree`: each handed from its return track
    /// to its mover there, with the setting it came back from, so the engine starts its carry again.
    pub fn returned(&mut self, tree: &mut Tree, now: Micros) -> Vec<(Id, Setting, Vec<Effect>)> {
        let due: Vec<Id> = self
            .returning
            .iter()
            .filter(|(_, (_, at, _, _))| *at <= now)
            .map(|(a, _)| *a)
            .collect();
        let mut out = Vec::new();
        for activity in due {
            let Some((s, at, _, _)) = self.returning.remove(&activity) else {
                continue;
            };
            match self.hand_off(
                tree,
                at,
                activity,
                s.ground,
                (Owner::Mover, Owner::Mover),
                s.start,
                Vec3::ZERO,
            ) {
                Ok(effects) => out.push((activity, s, effects)),
                Err(r) => {
                    eprintln!("worldd: a crew's node did not come back: {r}");
                    self.seating.parts.clear();
                }
            }
        }
        out
    }

    /// The crew's activity ended: whatever it held stays where it is.
    pub fn ended(&mut self, activity: Id) {
        self.held.remove(&activity);
        self.setting.remove(&activity);
        self.committing.remove(&activity);
        self.returning.remove(&activity);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #5067 item 3: a carrier whose grip a track would take beyond its reach, on the plan or above it, is named.
    #[test]
    fn a_carrier_out_of_reach_of_its_grip_is_named() {
        let body = Id::new(replica::ids::Scope([1; 16]), 5).expect("an id");
        let c = Carrier {
            body,
            feet: Vec3::ZERO,
            reach: 2_060_000,
            grip: Vec3::new(350_000, 0, 0),
        };
        let node = |x: i64, y: i64| (Vec3::new(x, y, 0), Quat::IDENTITY);
        assert_eq!(out_of_reach(&[c], node(0, HEIGHT)), Ok(()));
        assert_eq!(
            out_of_reach(&[c], node(GRIP_REACH - 350_000, HEIGHT)),
            Ok(())
        );
        for (x, y) in [(GRIP_REACH - 349_999, HEIGHT), (0, 2_060_001)] {
            let r = out_of_reach(&[c], node(x, y)).expect_err("out of reach");
            assert_eq!(r.name, "part.grip-out-of-reach");
            assert!(r.detail.contains(&show(body)), "{}", r.detail);
        }
    }

    /// #5067: a frame that stands is taken from beside its edges (its own x), each carrier within reach of the edge it
    /// holds; from 2.2 m off its faces each is named out of reach, 2.16 m from its hold.
    #[test]
    fn a_standing_frames_carriers_reach_it_from_beside_its_edges_not_from_its_faces() {
        use replica::rules::json;
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../content/kinds/construction/rack_upright.json");
        let e = json::parse(&std::fs::read_to_string(p).expect("the entry")).expect("json");
        let (load, grips) = (
            Load::of(&e).expect("a load"),
            grips::grips_of(&e).expect("grips"),
        );
        let id = |n| Id::new(replica::ids::Scope([1; 16]), n).expect("an id");
        let stood = |n, x: i64, z: i64| Stood {
            body: id(n),
            feet: Vec3::new(x, 0, z),
            reach: 2_060_000,
        };
        // The frame stands at the origin, its width along x; the take keeps its turn in the crew's slot.
        let taken = |front: Stood, back: Stood| {
            let turn = yaw_toward([front.feet.x - back.feet.x, front.feet.z - back.feet.z])?;
            let crew = Crew {
                grips: &grips,
                load: &load,
                front,
                back,
                sides: &[],
            };
            let node = (Vec3::new(0, sim::activity::carry::STAND_LIFT, 0), turn);
            out_of_reach(&crew.carriers((Vec3::ZERO, conj(turn)?))?, node)
        };
        assert_eq!(
            taken(stood(1, 1_100_000, 0), stood(2, -1_100_000, 0)),
            Ok(())
        );
        let r = taken(stood(1, 0, 2_200_000), stood(2, 0, -2_200_000)).expect_err("out of reach");
        assert_eq!(r.name, "part.grip-out-of-reach");
        assert!(r.detail.contains(&show(id(1))), "{}", r.detail);
        assert!(
            r.detail.contains("2162 mm") || r.detail.contains("2161 mm"),
            "{}",
            r.detail
        );
    }

    /// #5067: on a set-in track that moves the part on the plan, its side carriers walk beside it and its front and its
    /// back stand while they reach their holds at both ends; a carrier who can neither stand within reach nor walk is
    /// named before anyone moves; a track straight down moves nobody.
    #[test]
    fn on_a_set_in_track_each_carrier_stands_within_reach_or_walks_beside_the_part() {
        let id = |n| Id::new(replica::ids::Scope([1; 16]), n).expect("an id");
        let c = |n, x: i64, z: i64, gx: i64, gz: i64| Carrier {
            body: id(n),
            feet: Vec3::new(x, 0, z),
            reach: 2_060_000,
            grip: Vec3::new(gx, 0, gz),
        };
        // A beam along z in the crew's slot: its ends 0.35 m beyond their grips, a side either side of it 0.45 m off
        // its middle line, each holding its edge.
        let crew = [
            c(1, 0, 1_447_000, 0, 1_097_000),
            c(2, 0, -1_447_000, 0, -1_097_000),
            c(3, -450_000, -400_000, -25_500, -400_000),
            c(4, 450_000, 400_000, 25_500, 400_000),
        ];
        let (ends, from, turn) = ([id(1), id(2)], Vec3::new(0, HEIGHT, 0), Quat::IDENTITY);
        let open = |_: Id, _: Vec3, _: Vec3| true;
        let walled = |_: Id, _: Vec3, _: Vec3| false;
        let who = |w: &[Walk]| w.iter().map(|w| w.body).collect::<Vec<_>>();
        // Straight down: nobody walks.
        assert_eq!(
            ways(&crew, ends, from, Vec3::ZERO, turn, &open),
            Ok(Vec::new())
        );
        // 0.45 m east: the sides walk beside it, the ends stand, 0.57 m from their holds at its end.
        let east = Vec3::new(450_000, 0, 0);
        let w = ways(&crew, ends, from, east, turn, &open).expect("admitted");
        assert_eq!(who(&w), [id(3), id(4)]);
        assert_eq!(
            (w[0].to, w[1].to),
            (Vec3::new(0, 0, -400_000), Vec3::new(900_000, 0, 400_000))
        );
        assert_eq!(pace(w[0].from, w[0].to, 1_000_000), 500_000);
        assert_eq!(w[0].back(1_000_000).to, w[0].from);
        // No ground beside it: the west side would be 0.87 m from its hold where the track ends. Named, nothing moved.
        let r = ways(&crew, ends, from, east, turn, &walled).expect_err("out of reach");
        assert_eq!(r.name, "part.grip-out-of-reach");
        assert!(r.detail.contains(&show(id(3))), "{}", r.detail);
        // The east side alone stands when it cannot walk: the part comes toward it, within its reach.
        let three = [crew[0], crew[1], crew[3]];
        assert_eq!(
            ways(&three, ends, from, east, turn, &walled),
            Ok(Vec::new())
        );
        // 0.9 m east the ends cannot stand either (0.96 m): the whole crew walks beside it, or is refused by name.
        let far = Vec3::new(900_000, 0, 0);
        let w = ways(&crew, ends, from, far, turn, &open).expect("admitted");
        assert_eq!(who(&w), [id(1), id(2), id(3), id(4)]);
        let r = ways(&crew, ends, from, far, turn, &walled).expect_err("out of reach");
        assert!(r.detail.contains(&show(id(1))), "{}", r.detail);
        // #5067 item 4: refused, the nearest place the crew's node would be admitted from, the same `ways` with the
        // whole crew there: with nobody able to walk, where every carrier stands within reach where the set-in ends.
        let at = admitted_from(&crew, ends, (from, turn), (far, turn), &walled).expect("a place");
        assert!(ways(&crew.map(|c| Carrier { feet: Vec3::new(c.feet.x + at.x, 0, c.feet.z + at.z), ..c }), ends, at, far, turn, &walled).is_ok());
        assert!(at.x > 0 && at.x < far.x && at.z == 0 && at.y == from.y, "toward where it goes: {at:?}");
        // Nowhere within a metre of where it goes, a crew none of whose carriers reaches its hold at the start.
        let off = [c(1, 0, 3_000_000, 0, 1_097_000), crew[1]];
        assert_eq!(admitted_from(&off, ends, (from, turn), (far, turn), &walled), None);
        // Out of reach where the track would start: refused whoever could walk.
        let mut off = crew;
        off[1].feet.z -= 400_000;
        let r = ways(&off, ends, from, east, turn, &open).expect_err("out of reach");
        assert!(r.detail.contains(&show(id(2))), "{}", r.detail);
    }

    /// A take of a part above its carriers' standing reach is refused by name (the served test world has none that
    /// high: its frames stand on a low stand and its beams lie on the ground).
    #[test]
    fn a_part_above_standing_reach_is_refused_by_name() {
        let reach = sim::slots::standing_reach(sim::slots::STANDARD_BUILD);
        assert!(within_reach(reach, reach).is_ok());
        let r = within_reach(reach + 1, reach).expect_err("refused");
        assert_eq!(r.name, "reach.too-high");
    }
}
