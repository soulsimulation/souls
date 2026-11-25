//! Postures and seats (Engine v2 B3, #2682): a body sits, lies and rises by moves (B2's data) that hand it between the
//! floor and a seat's slot through the controller, and a seat holds one body at each of its places.
//!
//! - **A seat** is one slot of a thing, with its kind's data ([`replica::moves::Place`]): the slot's height above the
//!   floor from the kind's model geometry, and a stand point. A seat higher than the body's standing reach
//!   ([`standing_reach`], today's SEATDEF: the overhead reach of its admitted build) is refused `place-out-of-reach`,
//!   by its height alone (#3600). The move's own reach is horizontal: how far the body is from the seat at contact.
//! - **Reserved at commit.** The requests of one tick are taken together ([`Slots::commit`]) and ordered by a stable
//!   key, the body's id and then the seat's, never by arrival. The first takes the seat; every later one is refused
//!   `place-taken`, naming the holder. The hold is a field of this table, keyed by the seat's thing and slot, so the
//!   holder is one lookup and never a scan.
//! - **A thing with several seats** (C19, #3457): a sofa's three, a bed's two sides, a bench's two. Each is its own
//!   place, keyed by (thing, slot). A request naming a slot takes that one; a request naming only the thing takes the
//!   free slot whose stand point is nearest the body (ties by slot number), picked in the tick's stable order, so three
//!   bodies asking for one sofa in one tick each get their own slot and a fourth is refused `place-taken`, naming the
//!   holders.
//! - **A slot that holds several bodies** (E16): a tent's `sleep` slot or a petanque circle declares `most` above one.
//!   Its seat has that many places ([`PlaceAt::more`]): the slot's own point, then the others its registration found,
//!   each a body's clearance apart and inside its thing. A body takes the lowest free place, and is handed into the slot
//!   at that place, so no two bodies are at one point; once every place is held the next is refused `place-taken`,
//!   naming the holders. A rise frees exactly that body's place.
//! - **Contact hands the body over.** At the sit's (or lie's) contact instant the body is handed from the floor into
//!   the slot ([`Controller::slot_in`], T4's hand-off from mover to slot) with the stance the request named; at the rise's
//!   contact it is handed back onto the floor ([`Controller::stand`]), standing, where it sat, and the world carries it
//!   to the seat's stand point by the rise's end ([`step_track`]): a step off the seat, never a jump. Postures are the
//!   controller's stance input: stand, sit, lie.
//! - **A seated body has no timer and no mover.** When the move is done, a driver with no timer ([`seated_shape`])
//!   holds its legs and its stance, and the controller's tick never visits it.
//! - **The engine releases the seat**, never the skill: when the holder rises (at the rise's contact), and when the
//!   sit is cancelled before contact (a later claim on its legs, `claim-taken`). A body is never left stuck: when a
//!   later claim cancels a sit after contact, or a rise before it, the body is handed back onto the floor at the stand
//!   point under that claim's driver and the seat is released, since a tick never steps a body in a slot.
//! - **Climbing out** (E11d). A rise whose stand point and the short search beside it ([`rise_point`]) are all off the
//!   floor (a boat moored with its stand point's side away from the bank, the floor cut back under a seat) is not
//!   refused while there is floor near: [`climb_point`] takes the thing's other stand points, then the nearest floor
//!   within [`CLIMB_BOUND`] of the seat, within a step's height of its floor and clear of standing bodies, by a
//!   straight line that passes off the floor only over water or the seat's thing's own boxes ([`Slots::footprint`]),
//!   never another cut (a wall, a fence, another hull). At the rise's
//!   contact the body is handed onto the floor's frame at the seat's point and the world carries it along that line
//!   at walking speed ([`Controller::carry`], N10's walk-out): it never appears there, and the climb is named
//!   ([`ClimbOut`], `climb-out`). With no such floor the rise ends `off-surface` and the body stays seated, its seat
//!   held: it acts seated, leaves the world as any seated body does, and rises once there is floor near again.
//! - **Rising onto a taken spot.** The stand point may be taken: [`clear_spot`] finds the nearest clear point, and the
//!   body walks there by the mover. It never appears there.
//!
//! - **A seat that moves with its cabin** (N14, [`Slots::run`]): a cable car's cabin, a big wheel's gondola. Its run is
//!   a course of the slot in its thing's frame (`crate::courses::rides::seat_runs`), read from the formula, never stepped;
//!   a seated body moves with it because its frame is the slot. It is taken only while it stands at its own stop (the
//!   one whose stand point a form walks its rider to), with [`crate::links::boarding::CROSSING`] of the stop left, its
//!   height there measured over the floor under that stop's stand point; a rise is started at any stop where riders get
//!   on and off, and stands the body at that stop's stand point. Anywhere else both are refused `boarding-frame-away` and the rider stays in its seat, carried on to the
//!   next stop; a body whose legs another claim took is never set down from a seat that is away from a stop.
//!
//! Not here: choosing among things (I5), queueing for one (B7), sitting where there is no seat (E3), sleep, a seat
//! edited away under its sitter (G2), writing the hold into the tree (the writer's).
//!
//! **Hands** (B4, #2739, [`hands`]) are slots of the same model: a slot of a node, named by a [`Frame`], holds one
//! occupant. A seat holds a body (this table, until the hold is written into the tree); a hand's slot, a shelf's or a
//! table's holds a thing, as a child of that slot in the tree. [`Slots::occupant`] answers who is in a slot for both,
//! so a thing is never put into a seat a body holds, and take and put refuse a filled slot by one name.

use std::collections::BTreeMap;

use replica::bodies::{Class, SkillShape, Want};
use replica::effects::Refusal;
use replica::encode::Name;
use replica::ids::{Id, Minter};
use replica::kinds::sizes::{Build, Size};
use replica::moves::{Move, Place};
use replica::pose::{Frame, HandOff, Quat, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::show;

use crate::controller::{Controller, Driver, Part, Stance};
use crate::mover::{Floors, Surface};
use crate::moves::{Fired, Instance, Moves, Reach};
use crate::timers::{DueList, Timer};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The step, µm, of the search out from a seat's stand point along its exit ([`rise_point`]).
pub const RISE_STEP: i64 = 10_000;

/// Where a body of `build` rising from the seat `at` stands on `floor` (#1960): the seat's stand point when the body
/// stands there, else the first point out from it along the seat's exit (from the slot to the stand point), every
/// [`RISE_STEP`], whose support and clearance hold, no farther from the stand point than the body's own clearance
/// radius for its class ([`rise_bound`]: a rise is a step off the seat, never a move). A chair whose stand point lies
/// in its own collider's clearance (Eden's `e_3403bec8`, 19 mm in) is risen from just past it. Bounded (at most
/// radius / step + 1 points), the same for the same inputs. `None`: nowhere within that bound.
pub fn rise_point(floor: &Surface, at: &PlaceAt, body: Id, build: Build) -> R<Option<Vec3>> {
    let frame = Frame {
        node: at.floor,
        slot: None,
    };
    let stand = at.stand()?;
    let (dx, dz) = (stand.x - at.point.x, stand.z - at.point.z);
    let len = (i128::from(dx) * i128::from(dx) + i128::from(dz) * i128::from(dz)).isqrt() as i64;
    // The exit: away from the slot through the stand point; a stand point on the slot exits the way the seat faces.
    let dir = if len > 0 {
        [dx * 1_000_000 / len, dz * 1_000_000 / len]
    } else {
        let f = at
            .facing
            .rotate(Vec3::new(0, 0, 1_000_000))
            .map_err(|e| Refusal {
                name: e.name(),
                detail: "a slot's facing".into(),
            })?;
        [f.x, f.z]
    };
    let bound = rise_bound(build);
    let mut k = 0;
    loop {
        if k * RISE_STEP > bound {
            return Ok(None);
        }
        let p = Vec3::new(
            stand.x + dir[0] * k * RISE_STEP / 1_000_000,
            0,
            stand.z + dir[1] * k * RISE_STEP / 1_000_000,
        );
        if floor.place_built(body, frame, p, at.facing, build).is_ok() {
            return Ok(Some(p));
        }
        k += 1;
    }
}

/// How far from a seat's stand point a rising body may stand, µm: its own clearance radius for its admitted class.
pub fn rise_bound(build: Build) -> i64 {
    build.size.radius_mm() * 1000
}

/// How far from its seat's point a body that cannot rise at the stand point climbs out, µm (E11d): a step off a boat
/// onto the bank, never a walk.
pub const CLIMB_BOUND: i64 = 3_000_000;

/// The grid, µm, on which the nearest floor within [`CLIMB_BOUND`] is searched.
pub const CLIMB_STEP: i64 = 100_000;

/// How often, µm, a climb out's line is sampled for the floor (a cut for a wall or a box is at least two body radii wide).
pub const CLIMB_SAMPLE: i64 = 50_000;

/// What a climb out is named in [`Slots::climbs`].
pub const CLIMB_OUT: &str = "climb-out";

/// A body that rose where its stand point and the short search beside it were off the floor (E11d), carried from its
/// seat's point to `to` on the floor at walking speed ([`crate::gaits::WALK`]), in a straight line, from `at`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClimbOut {
    pub body: Id,
    pub thing: Id,
    pub from: Vec3,
    pub to: Vec3,
    pub at: Micros,
}

/// A thing's own boxes on its floor (`crate::ground::scene::Solid`'s rings, µm, x and z in the floor's frame): what a
/// body climbing out of one of its seats may pass over ([`Slots::footprint`]).
pub type Footprint = Vec<[[i64; 2]; 4]>;

/// Whether `p` lies within `grow` of the convex ring `r` (x and z, µm): inside it, or that near one of its edges.
fn near_ring(r: &[[i64; 2]; 4], p: [i64; 2], grow: i64) -> bool {
    let o = |a: [i64; 2], b: [i64; 2]| {
        i128::from(b[0] - a[0]) * i128::from(p[1] - a[1])
            - i128::from(b[1] - a[1]) * i128::from(p[0] - a[0])
    };
    let sides: Vec<i128> = (0..4).map(|k| o(r[k], r[(k + 1) % 4])).collect();
    if sides.iter().all(|&s| s >= 0) || sides.iter().all(|&s| s <= 0) {
        return true;
    }
    let g = i128::from(grow);
    (0..4).any(|k| {
        let (a, b) = (r[k], r[(k + 1) % 4]);
        let (dx, dz) = (i128::from(b[0] - a[0]), i128::from(b[1] - a[1]));
        let (px, pz) = (i128::from(p[0] - a[0]), i128::from(p[1] - a[1]));
        let l2 = dx * dx + dz * dz;
        let t = if l2 == 0 {
            0
        } else {
            ((px * dx + pz * dz) * 1_000_000 / l2).clamp(0, 1_000_000)
        };
        let (cx, cz) = (dx * t / 1_000_000 - px, dz * t / 1_000_000 - pz);
        cx * cx + cz * cz <= g * g
    })
}

/// What a climb out (E11d) is checked against: the floor, the world's water on it ([`Floors::wet`]), the boxes of the
/// thing climbed out of, and whether a body already stands at a point; from where (`from`, x and z) and the height of
/// the floor it starts from (`base`).
struct Climb<'a> {
    floor: &'a Surface,
    floors: &'a dyn Floors,
    own: &'a [[[i64; 2]; 4]],
    taken: &'a dyn Fn(Vec3) -> bool,
    body: Id,
    node: Id,
    facing: Quat,
    from: Vec3,
    base: i64,
    build: Build,
}

impl Climb<'_> {
    fn frame(&self) -> Frame {
        Frame {
            node: self.node,
            slot: None,
        }
    }

    /// Where the body stands at `p` on the floor, when it may land there: a dry floor point within a step's height
    /// ([`crate::ground::STEP`]) of the floor it starts from, where no body stands, and never in ground sealed off from
    /// the main ground for its size ([`Floors::sealed`]), where it would be shut in.
    fn landing(&self, p: Vec3) -> Option<Vec3> {
        let b = self
            .floor
            .place_built(self.body, self.frame(), p, self.facing, self.build)
            .ok()?;
        let foot = b.pose.position.y - self.build.hover_mm * 1000;
        ((foot - self.base).abs() <= crate::ground::STEP * 1000
            && !(self.taken)(b.pose.position)
            && !self.floors.sealed(self.node, b.pose.position, self.build))
        .then_some(b.pose.position)
    }

    /// Whether the straight line from `from` to `to` is a way out, sampled every [`CLIMB_SAMPLE`]: each point off the
    /// floor lies over water or wading ground, or on the boxes of the thing climbed out of (grown by the body's
    /// clearance), never on another cut (a wall, a fence, a box, another hull); and once on the floor it stays on it.
    fn way_out(&self, to: Vec3) -> bool {
        let from = self.from;
        let grow = (self.build.size.radius_mm() + crate::ground::MARGIN + 10) * 1000;
        let (dx, dz) = (i128::from(to.x - from.x), i128::from(to.z - from.z));
        let len = (dx * dx + dz * dz).isqrt() as i64;
        let n = len / CLIMB_SAMPLE + 1;
        let mut on = false;
        for k in 0..=n {
            let p = Vec3::new(
                from.x + (dx * i128::from(k) / i128::from(n)) as i64,
                0,
                from.z + (dz * i128::from(k) / i128::from(n)) as i64,
            );
            let here = self
                .floor
                .place_built(self.body, self.frame(), p, self.facing, self.build)
                .is_ok();
            if on && !here {
                return false;
            }
            if !here
                && !self.floors.wet(self.node, p)
                && !self.own.iter().any(|r| near_ring(r, [p.x, p.z], grow))
            {
                return false;
            }
            on |= here;
        }
        on
    }

    /// Whether `p` is within [`CLIMB_BOUND`] of `from`.
    fn near(&self, p: Vec3) -> bool {
        let (dx, dz) = (i128::from(p.x - self.from.x), i128::from(p.z - self.from.z));
        dx * dx + dz * dz <= i128::from(CLIMB_BOUND) * i128::from(CLIMB_BOUND)
    }

    /// The nearest landing within [`CLIMB_BOUND`] of `from` with a way out, on a grid of [`CLIMB_STEP`] (ties by x,
    /// then z): a sealed pocket nearer is passed over for the nearest unsealed landing ([`Climb::landing`]).
    fn nearest(&self) -> Option<Vec3> {
        let n = CLIMB_BOUND / CLIMB_STEP;
        let mut grid: Vec<(i64, i64, i64)> = (-n..=n)
            .flat_map(|i| (-n..=n).map(move |j| (i * CLIMB_STEP, j * CLIMB_STEP)))
            .map(|(dx, dz)| (dx * dx + dz * dz, dx, dz))
            .filter(|(d2, ..)| *d2 <= CLIMB_BOUND * CLIMB_BOUND)
            .collect();
        grid.sort_unstable();
        grid.into_iter()
            .map(|(_, dx, dz)| Vec3::new(self.from.x + dx, 0, self.from.z + dz))
            .find_map(|p| self.landing(p).filter(|&l| self.way_out(l)))
    }
}

/// Where a body of `build` that cannot rise at its seat `at`'s stand point (nor beside it, [`rise_point`]) climbs out
/// to on `floor` (E11d), with a way out from the seat's point: first the stand points of the thing's other seats
/// (`others`, by slot), each with its own short search; then the nearest point of the floor within [`CLIMB_BOUND`] of
/// the seat's point, on a grid of [`CLIMB_STEP`] (ties by x, then z). A target is a dry floor point within a step's
/// height of the seat's floor where no body stands (`taken`), and the line to it passes only over water, wading
/// ground or the seat's thing's own boxes (`own`) before it reaches the floor. Bounded and the same for the same
/// inputs. `None`: no such floor within the bound.
#[allow(clippy::too_many_arguments)]
pub fn climb_point<'a>(
    floor: &Surface,
    floors: &dyn Floors,
    at: &PlaceAt,
    others: impl Iterator<Item = &'a PlaceAt>,
    own: &[[[i64; 2]; 4]],
    taken: &dyn Fn(Vec3) -> bool,
    body: Id,
    build: Build,
) -> R<Option<Vec3>> {
    let cl = Climb {
        floor,
        floors,
        own,
        taken,
        body,
        node: at.floor,
        facing: at.facing,
        from: Vec3::new(at.point.x, 0, at.point.z),
        base: at.point.y - at.place.height,
        build,
    };
    for o in others.filter(|o| o.floor == at.floor && o.place.slot != at.place.slot) {
        if let Some(p) = rise_point(floor, o, body, build)?
            && cl.near(p)
            && let Some(l) = cl.landing(p)
            && cl.way_out(l)
        {
            return Ok(Some(l));
        }
    }
    Ok(cl.nearest())
}

/// What a restart does with a body the log had standing ([`Slots::resume`], E11d).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resumed {
    /// On its floor: placed as it is.
    Stood,
    /// Off its floor (killed during a climb out): carried on, as a climb is, to this landing.
    Climbs(Vec3),
    /// Off its floor with no landing within [`CLIMB_BOUND`]: carried to the floor's nearest legal point
    /// ([`crate::ground::exits::nearest`]), the last resort, whose line is a way out all the same.
    Nearest(Vec3),
    /// Off its floor with no way out: never carried through a cut. The world seats it again in the seat it was
    /// climbing out of ([`Slots::over`]), so its next rise climbs out or is refused by name; with no such seat free it
    /// stands at the floor's nearest legal point (`worldd`'s `resume-placed`).
    Held,
}

impl Resumed {
    /// The landing the world carries the body to, if any.
    pub fn to(self) -> Option<Vec3> {
        match self {
            Resumed::Climbs(p) | Resumed::Nearest(p) => Some(p),
            Resumed::Stood | Resumed::Held => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Resumed::Stood => "stood",
            Resumed::Climbs(_) => CLIMB_OUT,
            Resumed::Nearest(_) => "resume-nearest",
            Resumed::Held => "resume-held",
        }
    }
}

/// A body at `at` on `floor` (`frame`'s node), placed: as the mover places it when it stands on the floor; else, off
/// the floor, where it is, its piece and triangle the floor's nearest legal point's (no step reads them before it is
/// carried or walks). `off-surface` only when the floor has no ground at all.
pub fn placed_off(
    floor: &Surface,
    id: Id,
    frame: Frame,
    at: Vec3,
    facing: Quat,
    build: Build,
) -> R<crate::mover::Body> {
    if let Ok(b) = floor.place_built(id, frame, at, facing, build) {
        return Ok(b);
    }
    let Some((_, to)) = crate::ground::exits::nearest(floor.pieces(), at) else {
        return refuse("off-surface", format!("({}, {}) µm: no ground", at.x, at.z));
    };
    let mut b = floor.place_built(id, frame, to, facing, build)?;
    b.pose.position.x = at.x;
    b.pose.position.z = at.z;
    b.pose.position.y = at.y;
    Ok(b)
}

/// A rise's step off its seat, µm, below which the body is stood at the stand point at once (less than a tick's walk).
pub const STEP_OFF_MIN: i64 = 50_000;

/// The world's carry of a rise's step off its seat: from where it sat (`from`, x and z) along a straight line to `to`
/// on `floor`, the seat's exit ([`rise_point`] searches along it), within `within` µs and at no less than walking
/// speed, at most four times it (a step longer than that, from a far place of a bench, outlasts the rise; a walk asked
/// meanwhile waits for its landing, [`crate::host::Runner`]). It lands as the stand point always has, without waiting
/// for a body standing near it. `None` for a step shorter than [`STEP_OFF_MIN`].
pub fn step_track(
    floor: Id,
    from: Vec3,
    to: Vec3,
    within: Micros,
) -> Option<crate::controller::Track> {
    let (dx, dz) = (i128::from(to.x - from.x), i128::from(to.z - from.z));
    let len = (dx * dx + dz * dz).isqrt() as i64;
    if len < STEP_OFF_MIN {
        return None;
    }
    // 1 mm/s over the exact speed: a tick's reach is rounded down, so the exact speed could land a tick late.
    let speed = if within > 0 {
        (len.saturating_mul(1_000_000) + within - 1) / within + 1_000
    } else {
        i64::MAX
    };
    Some(crate::controller::Track {
        speed: speed.clamp(crate::gaits::WALK.speed, 4 * crate::gaits::WALK.speed),
        hold: false,
        ..climb_track(floor, to)
    })
}

/// The world's carry of a climb out (E11d) or of its rest after a restart: along a straight line to `to` on `floor` at
/// walking speed, waiting at its end while another body stands there (#4215).
pub fn climb_track(floor: Id, to: Vec3) -> crate::controller::Track {
    crate::controller::Track {
        link: None,
        line: vec![to],
        speed: crate::gaits::WALK.speed,
        to: floor,
        arrive: None,
        hold: true,
    }
}

/// Today's standing reach of the standard 1.75 m body (`BODY_MODEL.overheadMax`, 2.06 m), µm: the highest seat top it
/// gets onto. Above it a body would have to climb.
pub const STANDARD_REACH: i64 = 2_060_000;

/// The build a body has until its admitted one is given ([`Slots::admit`]): today's walking body, 1.75 m.
pub const STANDARD_BUILD: Build = Build {
    size: Size::Standard,
    height_mm: 1_750,
    hover_mm: 0,
};

/// A body's standing reach, µm (today's `seatReach`, #1083): [`STANDARD_REACH`] scaled by its height over the standard
/// 1.75 m; a hovering body (a floater) reaches the standard height, unscaled.
pub fn standing_reach(build: Build) -> i64 {
    if build.hover_mm > 0 {
        return STANDARD_REACH;
    }
    let h = i128::from(build.height_mm.max(0));
    i64::try_from(i128::from(STANDARD_REACH) * h / i128::from(STANDARD_BUILD.height_mm))
        .unwrap_or(i64::MAX)
}

/// A seat where it is: its thing, its kind's data, its slot's point and facing in the floor's frame (µm), and the
/// floor's node, whose surface a body stands on to sit and is set back on.
#[derive(Clone, Debug)]
pub struct PlaceAt {
    pub thing: Id,
    pub place: Place,
    pub point: Vec3,
    pub facing: Quat,
    pub floor: Id,
    /// The slot's other places when it holds more than one body (E16, its `most`): each one's offset from the slot's
    /// point in the slot's own frame, µm. Empty for a slot of one body, held at its point.
    pub more: Vec<Vec3>,
}

impl PlaceAt {
    /// How many bodies the seat holds: its point and its other places.
    pub fn most(&self) -> u32 {
        u32::try_from(self.more.len()).map_or(u32::MAX, |n| n.saturating_add(1))
    }

    /// Place `k`'s position in the slot's frame, µm: 0 is the slot's point.
    pub fn spot(&self, k: u32) -> Vec3 {
        match k.checked_sub(1) {
            Some(i) => self.more.get(i as usize).copied().unwrap_or(Vec3::ZERO),
            None => Vec3::ZERO,
        }
    }

    /// The stand point in the floor's frame, µm (its height is the floor's, found when the body is placed).
    pub fn stand(&self) -> R<Vec3> {
        let [x, z] = self.place.stand;
        let d = self
            .facing
            .rotate(Vec3::new(x, 0, z))
            .map_err(|e| Refusal {
                name: e.name(),
                detail: "a stand point".into(),
            })?;
        Ok(Vec3::new(self.point.x + d.x, 0, self.point.z + d.z))
    }
}

/// One request of a tick: `body` asks to take the seat of `thing` in `slot` by move `mv`, to be held there in
/// `stance`; with no slot, the world picks the thing's free slot nearest the body (C19, #3457).
#[derive(Clone, Debug)]
pub struct Request<'a> {
    pub body: Id,
    pub thing: Id,
    pub slot: Option<u64>,
    pub mv: &'a Move,
    pub stance: Stance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// The sit or lie in progress; `in_slot` once its contact handed the body over.
    Lowering {
        instance: Instance,
        in_slot: bool,
    },
    /// In the slot, its legs held by a driver with no timer (none when another claim took them).
    Seated(Option<Driver>),
    Rising(Instance),
}

#[derive(Clone, Copy, Debug)]
struct Hold {
    body: Id,
    stance: Stance,
    state: State,
}

/// The claim that holds a seated body's legs and stance: no timer, nothing cancels it; [`Slots::rise`] ends it.
pub fn seated_shape() -> SkillShape {
    SkillShape {
        name: Name::new("souls:seated").unwrap_or_else(|| unreachable!("a literal name")),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: vec![],
        cancelled_by: vec![],
    }
}

/// A seat's key: its thing and its slot (C19, #3457).
type Key = (Id, u64);

/// A body's place in a seat (E16): the seat's thing and slot, and which of its places ([`PlaceAt::spot`]).
type Spot = (Id, u64, u32);

fn seat_of(s: Spot) -> Key {
    (s.0, s.1)
}

/// Every seat, and who holds each of its places.
#[derive(Default)]
pub struct Slots {
    places: BTreeMap<Key, PlaceAt>,
    held: BTreeMap<Spot, Hold>,
    by_body: BTreeMap<Id, Spot>,
    changed: Vec<Id>,
    /// The climbs out begun (E11d), drained by the world ([`Slots::climbs`]).
    climbs: Vec<ClimbOut>,
    /// Each seat's thing's own boxes on its floor, which a body climbing out of it may pass over (E11d).
    footprints: BTreeMap<Id, Footprint>,
    /// Each body's admitted build, as its adapter gave it; [`STANDARD_BUILD`] when none was.
    builds: BTreeMap<Id, Build>,
    /// The things that move on a course (a punt, #3603): their loaded tracks and their homes. A seat on one is taken
    /// only while it stands at its home with time to cross left, and left only there.
    moving: BTreeMap<Id, (crate::courses::Table, Vec3)>,
    /// The seats that move with their cabin (N14): each one's loaded run, and the seat as it stands at each station
    /// where riders get on and off.
    runs: BTreeMap<Key, Run>,
    /// The things whose runs were registered or retired since the world last asked ([`Slots::runs_changed`]).
    runs_changed: std::collections::BTreeSet<Id>,
    /// The stop each rise from a moving seat was started at: where it stands the body.
    rising: BTreeMap<Spot, PlaceAt>,
    /// What each ride's trip end sets back (`crate::courses::rides::trip_ends`), and whether its seats were between
    /// stops when last asked ([`Slots::trip_ended`]).
    trips: BTreeMap<Id, (Vec<(u64, replica::encode::Value)>, bool)>,
}

impl Slots {
    pub fn new() -> Slots {
        Slots::default()
    }

    /// Gives `body`'s admitted build, whose standing reach a seat's height is compared with ([`standing_reach`]).
    pub fn admit(&mut self, body: Id, build: Build) {
        self.builds.insert(body, build);
    }

    /// `body`'s standing reach, µm: its admitted build's, else the standard body's.
    pub fn reach_of(&self, body: Id) -> i64 {
        standing_reach(self.builds.get(&body).copied().unwrap_or(STANDARD_BUILD))
    }

    /// Thing `thing` moves on `course` (#3603, N12's boarding rule), its home at `home`: its seats are boarded only
    /// while it stands at its home with [`crate::links::boarding::CROSSING`] of the stop left, and left only while it
    /// stands there; else `boarding-frame-away`, and nobody moves. Called again when its course changes (a steer). A
    /// course that does not load is refused by its own name.
    pub fn moving(&mut self, thing: Id, course: &crate::courses::Course, home: Vec3) -> R<()> {
        self.moving.insert(thing, (course.load()?, home));
        Ok(())
    }

    /// The slot `slot` of `thing` moves with its cabin on `course` (N14, the thing's frame), standing where riders get on
    /// and off as `stops` says (each a station of the course and the place there, in the floor's frame); it is boarded at
    /// the stations `own` names (where a form walks its rider). Called again when its thing is registered again. A
    /// course that does not load is refused by its own name.
    pub fn run(
        &mut self,
        thing: Id,
        slot: u64,
        course: &crate::courses::Course,
        stops: Vec<(usize, PlaceAt)>,
        own: &std::collections::BTreeSet<usize>,
    ) -> R<()> {
        let table = course.load()?;
        self.runs.insert(
            (thing, slot),
            Run {
                course: course.clone(),
                table,
                stops: stops.into_iter().collect(),
                own: own.clone(),
            },
        );
        self.runs_changed.insert(thing);
        Ok(())
    }

    /// Every slot that moves with its cabin (N14), by thing and slot, with its course in the thing's frame.
    pub fn slot_courses(&self) -> impl Iterator<Item = (Id, u64, &crate::courses::Course)> {
        self.runs.iter().map(|(k, r)| (k.0, k.1, &r.course))
    }

    /// The things whose runs were registered or retired (a start, a god edit) since this was last asked: the world
    /// writes their courses again (N14).
    pub fn runs_changed(&mut self) -> std::collections::BTreeSet<Id> {
        std::mem::take(&mut self.runs_changed)
    }

    /// What the end of a trip of ride `thing` sets back (N14, `crate::courses::rides::trip_ends`): each field by number
    /// and its default. Called with its seats' runs.
    pub fn trip_ends(&mut self, thing: Id, ends: Vec<(u64, replica::encode::Value)>) {
        self.trips.insert(thing, (ends, false));
    }

    /// The rides whose seats came to a stop since this was last asked at an earlier `now` (N14): a trip ends there.
    /// Each with what its end sets back. A ride first asked about is taken as it stands, so a start ends no trip. A
    /// ride with no seats that move but that moves itself on a course (a balloon's loop aloft) ends its trip when it
    /// next stands at its home.
    pub fn trip_ended(&mut self, now: Micros) -> Vec<(Id, Vec<(u64, replica::encode::Value)>)> {
        let mut out = Vec::new();
        let things: Vec<Id> = self.trips.keys().copied().collect();
        for thing in things {
            let mut places = self.runs.range((thing, 0)..=(thing, u64::MAX)).peekable();
            let away = if places.peek().is_none() && self.moving.contains_key(&thing) {
                self.at_home(thing, now, 0).is_err()
            } else {
                places.any(|(_, r)| !matches!(r.table.stopped(now), Ok(Some(_))))
            };
            if let Some((ends, was)) = self.trips.get_mut(&thing) {
                if *was && !away && !ends.is_empty() {
                    out.push((thing, ends.clone()));
                }
                *was = away;
            }
        }
        out
    }

    /// Whether the seat of `thing` in `slot` moves with its cabin (N14).
    pub fn runs(&self, thing: Id, slot: u64) -> bool {
        self.runs.contains_key(&(thing, slot))
    }

    /// The place `key` as it stands now: `None` when it does not move (its place is its registered one); the place at
    /// the stop it stands at with `left` of the stop to spare, and whether that stop is its own (where it is boarded);
    /// else `boarding-frame-away`, saying when it is next back at its own stop.
    fn stop_now(&self, key: Key, now: Micros, left: Micros) -> R<Option<(&PlaceAt, bool)>> {
        let Some(r) = self.runs.get(&key) else {
            return Ok(None);
        };
        match r.table.stopped(now) {
            Ok(Some(s)) if s.left >= left => match r.stops.get(&s.station) {
                Some(p) => Ok(Some((p, r.own.contains(&s.station)))),
                None => refuse(
                    "boarding-frame-away",
                    format!(
                        "{} slot {}: it stands aloft{}",
                        show(key.0),
                        key.1,
                        back(r, now)
                    ),
                ),
            },
            _ => refuse(
                "boarding-frame-away",
                format!(
                    "{} slot {}: it is between stops{}",
                    show(key.0),
                    key.1,
                    back(r, now)
                ),
            ),
        }
    }

    /// Whether the slot `slot` of `thing` can be boarded at `now`: it does not move, or it stands at its own stop with a
    /// crossing's time of it left (N14). The free-slot choice skips one that cannot.
    pub fn at_own_stop(&self, thing: Id, slot: u64, now: Micros) -> bool {
        matches!(
            self.stop_now((thing, slot), now, crate::links::boarding::CROSSING),
            Ok(None | Some((_, true)))
        )
    }

    /// `boarding-frame-away` unless the moving `thing` stands at its home at `now` with `left` of its stop to spare.
    fn at_home(&self, thing: Id, now: Micros, left: Micros) -> R<()> {
        let Some((t, home)) = self.moving.get(&thing) else {
            return Ok(());
        };
        let here = t.at(now).map(|(p, _)| p);
        match (t.stopped(now), here) {
            (Ok(Some(s)), Ok(p)) if s.left >= left && p == *home => Ok(()),
            _ => refuse(
                "boarding-frame-away",
                format!(
                    "{} is not at its stop{}",
                    show(thing),
                    home_back(t, *home, now, left).map_or(String::new(), |b| format!(
                        "; back at its stop at {b} us, in {} s",
                        (b - now + 999_999) / 1_000_000
                    ))
                ),
            ),
        }
    }

    /// `boarding-frame-away` unless `thing`, when it moves on a course, stands at its home at `now` with
    /// [`crate::links::boarding::CROSSING`] of its stop left: asked before a form walks a body to it (#3603), so a body
    /// is never walked toward a boat that has left.
    pub fn boardable(&self, thing: Id, now: Micros) -> R<()> {
        self.at_home(thing, now, crate::links::boarding::CROSSING)
    }

    /// `boarding-frame-away` unless `thing`, when it moves on a course, stands at its home at `now`: where its riders
    /// rise from it. The refusal says when it is back there.
    pub fn leavable(&self, thing: Id, now: Micros) -> R<()> {
        self.at_home(thing, now, 0)
    }

    /// `boarding-frame-away` unless a seat of `thing` that moves with its cabin (N14) stands at its own stop at `now`
    /// with a crossing's time of it left (a thing with none is not asked): asked before a form that sits walks a body to
    /// it, so nobody is walked to a cabin that is away. The refusal says when the next is back at its stop, world µs, so
    /// a client can time itself.
    pub fn boardable_seat(&self, thing: Id, now: Micros) -> R<()> {
        let mut back: Option<Micros> = None;
        let mut any = false;
        for (_, r) in self.runs.range((thing, 0)..=(thing, u64::MAX)) {
            any = true;
            match next_own(r, now) {
                Some(from) if from <= now => return Ok(()),
                Some(from) => back = Some(back.map_or(from, |b| b.min(from))),
                None => {}
            }
        }
        if !any {
            return Ok(());
        }
        refuse(
            "boarding-frame-away",
            match back {
                Some(t) => format!(
                    "{}: its cabins are away; the next is back at its stop at {t} us",
                    show(thing)
                ),
                None => format!("{}: no cabin of it stops where it is boarded", show(thing)),
            },
        )
    }

    /// Seat ownership changes, drained by the world to wake standing queues.
    pub fn changes(&mut self) -> Vec<Id> {
        std::mem::take(&mut self.changed)
    }

    /// Gives `thing`'s own boxes on its seats' floor (E11d): a body climbing out of one of its seats may pass over
    /// them. A thing with none given is passed over only where there is water.
    pub fn footprint(&mut self, thing: Id, own: Footprint) {
        self.footprints.insert(thing, own);
    }

    /// What a restart does with a body the log had standing at `at` on `floor` (`frame`'s node), E11d. Standing on the
    /// floor, it stands ([`Resumed::Stood`]). Off it (a kill during a climb out), it climbs on by the climb's own rule
    /// from where it is: the nearest landing within [`CLIMB_BOUND`] whose line passes off the floor only over water
    /// or the boxes of a thing on that floor that hold `at` ([`Resumed::Climbs`]); else the floor's nearest legal
    /// point, when its line is such a way out ([`Resumed::Nearest`]); else it is left where it is
    /// ([`Resumed::Held`]): never carried through a cut. No body standing is asked of, since a restart adds them
    /// one by one; the carry waits at its end while one stands there.
    #[allow(clippy::too_many_arguments)]
    pub fn resume(
        &self,
        floors: &dyn Floors,
        floor: &Surface,
        id: Id,
        frame: Frame,
        at: Vec3,
        facing: Quat,
        build: Build,
    ) -> Resumed {
        // A body the log had in ground sealed off from the main ground (a pocket no walk from outside reaches) is not
        // left there: it is placed out of it like a body off its floor.
        let sealed = |p: Vec3| floors.sealed(frame.node, p, build);
        if floor.place_built(id, frame, at, facing, build).is_ok() && !sealed(at) {
            return Resumed::Stood;
        }
        let own: Vec<[[i64; 2]; 4]> = self
            .over(frame.node, at, build)
            .into_iter()
            .flat_map(|t| self.footprints[&t].iter().copied())
            .collect();
        let cl = Climb {
            floor,
            floors,
            own: &own,
            taken: &|_| false,
            body: id,
            node: frame.node,
            facing,
            from: Vec3::new(at.x, 0, at.z),
            base: at.y - build.hover_mm * 1000,
            build,
        };
        if let Some(l) = cl.nearest() {
            return Resumed::Climbs(l);
        }
        if let Some((_, to)) =
            crate::ground::exits::nearest_where(floor.pieces(), at, &|p| !sealed(p))
            && let Ok(b) = floor.place_built(id, frame, to, facing, build)
            && cl.way_out(b.pose.position)
        {
            return Resumed::Nearest(b.pose.position);
        }
        Resumed::Held
    }

    /// The things with seats on `floor` whose own boxes (grown by `build`'s clearance) hold `at`, by id: what a body
    /// standing off the floor there is over (E11d).
    pub fn over(&self, floor: Id, at: Vec3, build: Build) -> Vec<Id> {
        let grow = (build.size.radius_mm() + crate::ground::MARGIN + 10) * 1000;
        self.footprints
            .iter()
            .filter(|(thing, rings)| {
                self.place(**thing).is_some_and(|p| p.floor == floor)
                    && rings.iter().any(|r| near_ring(r, [at.x, at.z], grow))
            })
            .map(|(t, _)| *t)
            .collect()
    }

    /// The climbs out begun since the last call (E11d), in the order they began.
    pub fn climbs(&mut self) -> Vec<ClimbOut> {
        std::mem::take(&mut self.climbs)
    }

    /// Adds a seat (`place-duplicate` when its thing has one in that slot).
    pub fn add(&mut self, place: PlaceAt) -> R<()> {
        let key = (place.thing, place.place.slot);
        if self.places.contains_key(&key) {
            return refuse(
                "place-duplicate",
                format!("{} slot {}", show(place.thing), key.1),
            );
        }
        self.places.insert(key, place);
        Ok(())
    }

    /// Replaces an unoccupied thing's declared places after an edit; an empty list retires them.
    /// Occupied places and their body/hold indexes are never changed by an edit.
    pub fn replace(&mut self, thing: Id, places: Vec<PlaceAt>) -> R<()> {
        if self.holder(thing).is_some() {
            return refuse("place-taken", show(thing));
        }
        let mut next = BTreeMap::new();
        for p in places {
            if p.thing != thing || next.insert((thing, p.place.slot), p).is_some() {
                return refuse("place-duplicate", show(thing));
            }
        }
        self.places.retain(|(id, _), _| *id != thing);
        if self
            .runs
            .range((thing, 0)..=(thing, u64::MAX))
            .next()
            .is_some()
        {
            self.runs_changed.insert(thing);
        }
        self.runs.retain(|(id, _), _| *id != thing);
        self.trips.remove(&thing);
        self.places.extend(next);
        Ok(())
    }

    /// Seats registered, every slot counted.
    pub fn places(&self) -> usize {
        self.places.len()
    }

    /// The seat of `thing` in its lowest slot.
    pub fn place(&self, thing: Id) -> Option<&PlaceAt> {
        self.places_of(thing).next()
    }

    /// The seat of `thing` in `slot`.
    pub fn place_in(&self, thing: Id, slot: u64) -> Option<&PlaceAt> {
        self.places.get(&(thing, slot))
    }

    /// Every seat of `thing`, by slot.
    pub fn places_of(&self, thing: Id) -> impl Iterator<Item = &PlaceAt> {
        self.places
            .range((thing, 0)..=(thing, u64::MAX))
            .map(|(_, p)| p)
    }

    /// Who holds a seat of `thing`, its lowest held slot first.
    pub fn holder(&self, thing: Id) -> Option<Id> {
        self.holders(thing).first().copied()
    }

    /// Who holds the seat of `thing` in `slot`, its lowest held place first.
    pub fn holder_in(&self, thing: Id, slot: u64) -> Option<Id> {
        self.holders_in(thing, slot).first().copied()
    }

    /// Everyone holding a place of the seat of `thing` in `slot`, by place.
    pub fn holders_in(&self, thing: Id, slot: u64) -> Vec<Id> {
        self.held
            .range((thing, slot, 0)..=(thing, slot, u32::MAX))
            .map(|(_, h)| h.body)
            .collect()
    }

    /// Everyone holding a seat of `thing`, by slot and place.
    pub fn holders(&self, thing: Id) -> Vec<Id> {
        self.held
            .range((thing, 0, 0)..=(thing, u64::MAX, u32::MAX))
            .map(|(_, h)| h.body)
            .collect()
    }

    /// Whether the seat of `thing` in `slot` has no free place (E16: a tent with two sleepers, not one); false for a
    /// slot that is no seat.
    pub fn full(&self, thing: Id, slot: u64) -> bool {
        self.places.contains_key(&(thing, slot)) && self.free_spot((thing, slot)).is_none()
    }

    /// The lowest free place of the seat `key`, if it has one (E16).
    fn free_spot(&self, key: Key) -> Option<u32> {
        let most = self.places.get(&key)?.most();
        (0..most).find(|k| !self.held.contains_key(&(key.0, key.1, *k)))
    }

    /// The free slot of `thing` whose stand point is nearest where `body` stands (x and z), ties by slot number: the
    /// one a request naming only the thing takes (C19, #3457). None when every slot is held or it has none.
    pub fn free(&self, c: &Controller, body: Id, thing: Id) -> Option<u64> {
        self.free_unless(c, body, thing, &|_| false)
    }

    /// [`Slots::free`], skipping each slot `taken` says is taken (#4575: every place of it reserved by other runs).
    pub fn free_unless(
        &self,
        c: &Controller,
        body: Id,
        thing: Id,
        taken: &dyn Fn(u64) -> bool,
    ) -> Option<u64> {
        let from = c.body(body).map_or(Vec3::ZERO, |b| b.pose.position);
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        self.places_of(thing)
            .filter(|p| self.free_spot((thing, p.place.slot)).is_some() && !taken(p.place.slot))
            .filter_map(|p| {
                let s = p.stand().ok()?;
                Some((d(s.x, from.x) + d(s.z, from.z), p.place.slot))
            })
            .min()
            .map(|(_, slot)| slot)
    }

    /// Who is in slot `at` (a node and its slot): the body holding it when it is a seat, else the thing the tree
    /// holds there. None for a frame with no slot, or an empty one.
    pub fn occupant(&self, tree: &Tree, at: Frame) -> Option<Id> {
        let slot = at.slot?;
        self.places
            .get(&(at.node, slot))
            .and_then(|_| self.holder_in(at.node, slot))
            .or_else(|| in_slot(tree, at.node, slot))
    }

    /// The thing whose seat `body` holds, if any.
    pub fn held_by(&self, body: Id) -> Option<Id> {
        self.by_body.get(&body).map(|k| k.0)
    }

    /// The seat `body` holds, if any.
    pub fn held_place(&self, body: Id) -> Option<&PlaceAt> {
        self.places.get(&seat_of(*self.by_body.get(&body)?))
    }

    /// Releases the seat `body` holds (a retirement, K10 #2673): the seat's thing, and the sit or rise under way.
    pub fn release_body(&mut self, body: Id) -> Option<(Id, Option<Instance>)> {
        let key = self.by_body.remove(&body)?;
        self.rising.remove(&key);
        let under_way = match self.held.remove(&key)?.state {
            State::Lowering { instance, .. } | State::Rising(instance) => Some(instance),
            State::Seated(_) => None,
        };
        self.changed.push(key.0);
        Some((key.0, under_way))
    }

    /// Seats held.
    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }

    /// Commits one tick's requests at `now`, in the stable order (body id, then seat), whatever order they came in.
    /// Each is reserved and its move started, or refused by name: `place-unknown`, `place-taken` (naming the holder, or
    /// every holder when a request naming only the thing finds no slot free),
    /// `place-already-held` (the body holds another), `place-out-of-reach`, or the move's own refusals (B2).
    #[allow(clippy::too_many_arguments)]
    pub fn commit(
        &mut self,
        c: &mut Controller,
        due: &mut DueList,
        mint: &mut Minter,
        moves: &mut Moves,
        geo: &impl Reach,
        floors: &dyn crate::mover::Floors,
        requests: &[Request],
        now: Micros,
    ) -> Vec<(Id, R<Instance>)> {
        let mut order: Vec<&Request> = requests.iter().collect();
        order.sort_by_key(|r| (r.body, r.thing, r.slot));
        order
            .into_iter()
            .map(|r| (r.body, self.take(c, due, mint, moves, geo, floors, r, now)))
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn take(
        &mut self,
        c: &mut Controller,
        due: &mut DueList,
        mint: &mut Minter,
        moves: &mut Moves,
        geo: &impl Reach,
        floors: &dyn crate::mover::Floors,
        r: &Request,
        now: Micros,
    ) -> R<Instance> {
        self.at_home(r.thing, now, crate::links::boarding::CROSSING)?;
        let slot = match r.slot {
            Some(s) => s,
            // A slot that moves with its cabin and stands away from its own stop is not free to take now (N14).
            None => match self
                .free_unless(c, r.body, r.thing, &|s| !self.at_own_stop(r.thing, s, now))
            {
                Some(s) => s,
                None if self.place(r.thing).is_none() => {
                    return refuse("place-unknown", show(r.thing));
                }
                // A slot is free but its cabin is away: say when the next is back.
                None if self.free(c, r.body, r.thing).is_some() => {
                    self.boardable_seat(r.thing, now)?;
                    return refuse("boarding-frame-away", show(r.thing));
                }
                None => {
                    let by: Vec<String> = self.holders(r.thing).into_iter().map(show).collect();
                    return refuse(
                        "place-taken",
                        format!("{}: held by {}", show(r.thing), by.join(", ")),
                    );
                }
            },
        };
        let key = (r.thing, slot);
        let Some(at) = self.places.get(&key) else {
            return refuse("place-unknown", format!("{} slot {slot}", show(r.thing)));
        };
        let Some(spot) = self.free_spot(key) else {
            let by: Vec<String> = self
                .holders_in(r.thing, slot)
                .into_iter()
                .map(show)
                .collect();
            return refuse(
                "place-taken",
                format!("{}: held by {}", show(r.thing), by.join(", ")),
            );
        };
        if let Some(t) = self.by_body.get(&r.body) {
            return refuse(
                "place-already-held",
                format!("{} holds {}", show(r.body), show(t.0)),
            );
        }
        // A slot that moves with its cabin is boarded where it stands at its own stop, where the body was walked to, and
        // measured there (N14); at another stop it is left only.
        let at = match self.stop_now(key, now, crate::links::boarding::CROSSING)? {
            Some((_, false)) => {
                return refuse(
                    "boarding-frame-away",
                    format!(
                        "{} slot {slot}: its cabin stands at another stop{}",
                        show(r.thing),
                        self.runs
                            .get(&key)
                            .map_or(String::new(), |run| back(run, now))
                    ),
                );
            }
            Some((p, true)) => p,
            None => at,
        };
        let reach = self.reach_of(r.body);
        if at.place.height > reach {
            return refuse(
                "place-out-of-reach",
                format!(
                    "{}: {} µm above the floor, standing reach {} µm",
                    show(r.thing),
                    at.place.height,
                    reach
                ),
            );
        }
        // A body never sits where it cannot rise (#1960): somewhere within its reach out of the seat must hold it.
        let build = c.build(r.body).ok_or_else(|| Refusal {
            name: "body-missing",
            detail: show(r.body),
        })?;
        if let Some(floor) = floors.for_build(build).and_then(|f| f.get(&at.floor))
            && rise_point(floor, at, r.body, build)?.is_none()
        {
            return refuse(
                "place-no-stand-point",
                format!(
                    "{}: nowhere to stand on rising within {} µm of its stand point",
                    show(r.thing),
                    rise_bound(build)
                ),
            );
        }
        let instance = moves.start(c, due, mint, geo, r.body, r.mv, r.thing, now)?;
        let key = (r.thing, slot, spot);
        self.held.insert(
            key,
            Hold {
                body: r.body,
                stance: r.stance,
                state: State::Lowering {
                    instance,
                    in_slot: false,
                },
            },
        );
        self.by_body.insert(r.body, key);
        self.changed.push(key.0);
        Ok(instance)
    }

    /// The bodies in a slot, with the seat's thing and the stance: those whose sit has handed them over (seated, or
    /// in the slot with the sit still finishing). What a restart seats again (K18c, #3176).
    pub fn seated(&self) -> Vec<(Id, Id, Stance)> {
        self.held
            .iter()
            .filter(|(_, h)| {
                matches!(
                    h.state,
                    State::Seated(_) | State::Lowering { in_slot: true, .. }
                )
            })
            .map(|(k, h)| (h.body, k.0, h.stance))
            .collect()
    }

    /// The stance `body` holds its seat in, whether it is lowering, seated or rising: what a checkpoint keeps of a body
    /// in a slot.
    pub fn stance(&self, body: Id) -> Option<Stance> {
        self.held.get(self.by_body.get(&body)?).map(|h| h.stance)
    }

    /// Where in its seat `body` is held (E16): the seat's thing, slot and place; place 0 is the slot's point.
    pub fn spot_of(&self, body: Id) -> Option<(Id, u64, u32)> {
        self.by_body.get(&body).copied()
    }

    /// A restart (K18c, #3176): `body`, standing on the floor, is handed back into the seat of `thing` in `slot` (its
    /// lowest when none is named) at `at`, held there in `stance` by a driver with no timer, as a sit that finished
    /// leaves it. The hold is this table's again, so a rise or another sit sees the seat taken. In a slot of several
    /// places (E16) it is the place at `was`, the body's position in the slot's frame as the checkpoint had it, so a
    /// restart never moves a body to another place; the lowest free place only when that one is gone or taken, or no
    /// position was kept. `place-unknown`, `place-taken` or `place-already-held` as for a sit.
    pub fn restore(
        &mut self,
        c: &mut Controller,
        body: Id,
        (thing, slot): (Id, Option<u64>),
        was: Option<Vec3>,
        stance: Stance,
        at: Micros,
    ) -> R<()> {
        let place = match slot {
            Some(s) => self.place_in(thing, s),
            None => self.place(thing),
        };
        let Some(place) = place else {
            return refuse("place-unknown", show(thing));
        };
        let n = place.place.slot;
        let position = |k| place.spot(k);
        let own = was.and_then(|p| {
            (0..place.most())
                .find(|&k| place.spot(k) == p && !self.held.contains_key(&(thing, n, k)))
        });
        let Some(spot) = own.or_else(|| self.free_spot((thing, n))) else {
            let by: Vec<String> = self.holders_in(thing, n).into_iter().map(show).collect();
            return refuse(
                "place-taken",
                format!("{}: held by {}", show(thing), by.join(", ")),
            );
        };
        let position = position(spot);
        if self.by_body.contains_key(&body) {
            return refuse("place-already-held", show(body));
        }
        let key = (thing, n, spot);
        let frame = Frame {
            node: thing,
            slot: Some(n),
        };
        let d = c.claim(body, &seated_shape())?;
        c.slot_in_at(body, d, frame, position, at)?;
        c.set(body, d, Part::Stance(stance))?;
        self.held.insert(
            key,
            Hold {
                body,
                stance,
                state: State::Seated(Some(d)),
            },
        );
        self.by_body.insert(body, key);
        self.changed.push(key.0);
        Ok(())
    }

    /// Starts `body` rising from its seat by move `mv` at `now`: the seated driver ends and the rise claims the legs,
    /// holding the stance until contact. `not-seated` when it is in no seat or still on its way down.
    #[allow(clippy::too_many_arguments)]
    pub fn rise(
        &mut self,
        c: &mut Controller,
        due: &mut DueList,
        mint: &mut Minter,
        moves: &mut Moves,
        geo: &impl Reach,
        body: Id,
        mv: &Move,
        now: Micros,
    ) -> R<Instance> {
        let not_seated = || refuse("not-seated", show(body));
        let Some(&key) = self.by_body.get(&body) else {
            return not_seated();
        };
        let Some(hold) = self.held.get(&key).copied() else {
            return not_seated();
        };
        let State::Seated(driver) = hold.state else {
            return not_seated();
        };
        self.leavable(key.0, now)?;
        // From a seat that moves with its cabin, only at a stop, with time to stand up before it leaves (N14).
        let stop = self
            .stop_now(seat_of(key), now, crate::links::boarding::CROSSING)?
            .map(|(p, _)| p.clone());
        if let Some(d) = driver {
            c.release(body, d)?;
        }
        match moves.start(c, due, mint, geo, body, mv, key.0, now) {
            Ok(n) => {
                if let Some(d) = moves.driver(n) {
                    c.set(body, d, Part::Stance(hold.stance))?;
                }
                self.set(key, State::Rising(n));
                if let Some(p) = stop {
                    self.rising.insert(key, p);
                }
                Ok(n)
            }
            Err(r) => {
                self.sit_still(c, key);
                Err(r)
            }
        }
    }

    fn set(&mut self, key: Spot, state: State) {
        if let Some(h) = self.held.get_mut(&key) {
            h.state = state;
        }
    }

    fn release(&mut self, key: Spot) {
        self.rising.remove(&key);
        if let Some(h) = self.held.remove(&key) {
            self.by_body.remove(&h.body);
            self.changed.push(key.0);
        }
    }

    /// The body stays in the slot with no move: a driver with no timer holds its legs and its stance, if it can.
    fn sit_still(&mut self, c: &mut Controller, key: Spot) {
        let Some(h) = self.held.get(&key).copied() else {
            return;
        };
        let d = c.claim(h.body, &seated_shape()).ok();
        if let Some(d) = d {
            let _ = c.set(h.body, d, Part::Stance(h.stance));
        }
        self.set(key, State::Seated(d));
    }

    /// A body left in its slot while another driver holds its legs (a walk claimed them and cancelled the sit after
    /// contact, or the rise before it) would be stuck: a tick never steps a body in a slot. So it is handed back onto
    /// the floor at the stand point under that driver, standing, and the seat is released.
    fn give_way(
        &mut self,
        c: &mut Controller,
        at: &PlaceAt,
        floors: &dyn crate::mover::Floors,
        key: Spot,
        now: Micros,
    ) -> Option<R<HandOff>> {
        let h = self.held.get(&key).copied()?;
        if h.state != State::Seated(None) {
            return None;
        }
        // A seat away from a stop carries its rider on (N14); at a stop the body is set down at that stop's stand point.
        let stop = self
            .stop_now(seat_of(key), now, 0)
            .ok()?
            .map(|(p, _)| p.clone());
        let at = stop.as_ref().unwrap_or(at);
        let claims = c.claims(h.body)?;
        let leg = claims
            .family()
            .resources
            .iter()
            .find(|r| r.class == Class::Locomotion)?;
        let d = claims.holder(&leg.name)?;
        let handed = self.stand(c, at, floors, h.body, d, now, None);
        if handed.is_ok() {
            let _ = c.set(h.body, d, Part::Stance(Stance::Stand));
            self.release(key);
        }
        Some(handed)
    }

    /// Runs a due timer through [`Moves::fire`], then does what it means for a seat: at a sit's contact the body is
    /// handed into the slot, at a rise's onto the floor where it sat (its surface in `floors`) and carried to the stand
    /// point by the rise's end ([`step_track`]), and the seat is released; a sit done leaves it seated; a sit cancelled before contact releases the seat. Returns what the move
    /// did and the hand-off made, or why it could not be (the move is then cancelled by that name: a rise's body stays
    /// seated, a sit's seat is released).
    #[allow(clippy::too_many_arguments)]
    pub fn fire(
        &mut self,
        c: &mut Controller,
        due: &mut DueList,
        mint: &mut Minter,
        moves: &mut Moves,
        geo: &impl Reach,
        floors: &dyn crate::mover::Floors,
        t: &Timer,
    ) -> Option<(Fired, Option<R<HandOff>>)> {
        let fired = moves.fire(c, due, mint, geo, t)?;
        let Some(&key) = self.by_body.get(&t.node) else {
            return Some((fired, None));
        };
        let (hold, at) = (
            self.held.get(&key).copied()?,
            match self.rising.get(&key) {
                Some(p) => p.clone(),
                None => self.places.get(&seat_of(key))?.clone(),
            },
        );
        let instance = match hold.state {
            State::Lowering { instance, .. } | State::Rising(instance) => instance,
            State::Seated(_) => return Some((fired, None)),
        };
        let mine = matches!(fired, Fired::Phase { instance: n, .. } if n == instance)
            || moves.record(instance).is_none();
        if !mine {
            return Some((fired, None));
        }
        let (body, now) = (hold.body, t.due);
        let handed = match (&fired, hold.state) {
            (Fired::Phase { phase: 1, .. }, State::Lowering { .. }) => {
                let frame = Frame {
                    node: key.0,
                    slot: Some(key.1),
                };
                let d = moves.driver(instance).unwrap_or(0);
                let h = c
                    .slot_in_at(body, d, frame, at.spot(key.2), now)
                    .and_then(|h| c.set(body, d, Part::Stance(hold.stance)).map(|()| h));
                match &h {
                    Ok(_) => self.set(
                        key,
                        State::Lowering {
                            instance,
                            in_slot: true,
                        },
                    ),
                    // Refused into the slot (E11c review): the sit ends by that name and the seat is given back, so
                    // no seat is held by a body that never got into it.
                    Err(r) => {
                        moves.cancel(c, due, instance, now, lit(r.name));
                        self.release(key);
                    }
                }
                Some(h)
            }
            (Fired::Phase { phase: 1, .. }, State::Rising(_)) => {
                let d = moves.driver(instance).unwrap_or(0);
                // The step off the seat ends with the rise (its recovery): the body is on its feet by then.
                let by = moves
                    .record(instance)
                    .and_then(|r| r.ends.last().copied())
                    .filter(|&e| e != Micros::MAX);
                let h = self.stand(c, &at, floors, body, d, now, by);
                match &h {
                    Ok(_) => {
                        let _ = c.set(body, d, Part::Stance(Stance::Stand));
                        self.release(key);
                    }
                    Err(r) => {
                        moves.cancel(c, due, instance, now, lit(r.name));
                        self.sit_still(c, key);
                    }
                }
                Some(h)
            }
            (Fired::Done(_), State::Lowering { .. }) => {
                self.sit_still(c, key);
                None
            }
            (Fired::Cancelled(_), state) => self.cancelled(c, &at, floors, key, state, now),
            _ => None,
        };
        Some((fired, handed))
    }

    /// Cancels `instance`, `body`'s sit, lie or rise under way, as `how` (its form run ended: a leave, a deadline,
    /// E11b), and does for the seat what [`Slots::fire`] does for a move cancelled under it: a sit not yet in the slot
    /// releases the seat; a body in the slot is left seated (handed onto the floor at the stand point when another
    /// driver holds its legs). Whether the body holds the seat after; `None`, and nothing cancelled, when `instance`
    /// is not `body`'s seat move.
    #[allow(clippy::too_many_arguments)]
    pub fn cancel(
        &mut self,
        c: &mut Controller,
        due: &mut DueList,
        moves: &mut Moves,
        floors: &dyn crate::mover::Floors,
        body: Id,
        instance: Instance,
        now: Micros,
        how: Name,
    ) -> Option<bool> {
        let key = *self.by_body.get(&body)?;
        let hold = self.held.get(&key).copied()?;
        let (State::Lowering { instance: n, .. } | State::Rising(n)) = hold.state else {
            return None;
        };
        if n != instance {
            return None;
        }
        let at = self.places.get(&seat_of(key))?.clone();
        moves.cancel(c, due, instance, now, how);
        let _ = self.cancelled(c, &at, floors, key, hold.state, now);
        Some(self.by_body.contains_key(&body))
    }

    /// What a seat move cancelled in `state` leaves: the seat released before contact, else the body seated still.
    fn cancelled(
        &mut self,
        c: &mut Controller,
        at: &PlaceAt,
        floors: &dyn crate::mover::Floors,
        key: Spot,
        state: State,
        now: Micros,
    ) -> Option<R<HandOff>> {
        if let State::Lowering { in_slot: false, .. } = state {
            self.release(key);
            return None;
        }
        self.sit_still(c, key);
        self.give_way(c, at, floors, key, now)
    }

    /// Hands `body` from its seat `at` onto the floor under `driver`, standing: at the stand point or the first point
    /// out from it ([`rise_point`]); else it climbs out ([`climb_point`], E11d): handed onto the floor's frame at the
    /// seat's point and carried by the world at walking speed in a straight line to the floor, never appearing there
    /// ([`ClimbOut`]). `off-surface` when there is no floor within [`CLIMB_BOUND`] by a way out: the body stays seated.
    /// With `step_off` (a rise's contact; the time its move ends), a body rising at the stand point is put on its feet
    /// where it sat and carried there in a straight line by then, at walking speed or faster ([`step_track`]): standing
    /// up is a step off the seat, never a jump to the stand point. Without it (a claim that took the legs), it stands
    /// there at once.
    #[allow(clippy::too_many_arguments)]
    fn stand(
        &mut self,
        c: &mut Controller,
        at: &PlaceAt,
        floors: &dyn crate::mover::Floors,
        body: Id,
        driver: Driver,
        now: Micros,
        step_off: Option<Micros>,
    ) -> R<HandOff> {
        let build = c.build(body).ok_or_else(|| Refusal {
            name: "body-missing",
            detail: show(body),
        })?;
        let all = floors;
        let floors = floors.for_build(build).ok_or_else(|| Refusal {
            name: "body-class-unprepared",
            detail: "no prepared support surfaces".into(),
        })?;
        let Some(floor) = floors.get(&at.floor) else {
            return refuse("no-surface", show(at.floor));
        };
        let frame = Frame {
            node: at.floor,
            slot: None,
        };
        // A step off or a climb out starts from the body's own place in the seat (E16: a bench's places), never from
        // another.
        let mut here = at.clone();
        if !at.more.is_empty()
            && let Some(p) = c.body(body).map(|b| b.pose.position)
            && let Ok(d) = at.facing.rotate(Vec3::new(p.x, 0, p.z))
        {
            here.point.x += d.x;
            here.point.z += d.z;
        }
        if let Some(p) = rise_point(floor, at, body, build)? {
            let placed = floor.place_built(body, frame, p, at.facing, build)?;
            // The step's line is a way out, as a climb out's is: off the floor only over water or the seat's own thing,
            // never through another cut (a table in front of the chair); else it stands at the stand point at once.
            let own = self
                .footprints
                .get(&at.thing)
                .map_or(&[][..], Vec::as_slice);
            let clear = Climb {
                floor,
                floors: all,
                own,
                taken: &|_| false,
                body,
                node: at.floor,
                facing: at.facing,
                from: Vec3::new(here.point.x, 0, here.point.z),
                base: here.point.y - at.place.height,
                build,
            };
            let Some(track) = step_off
                .and_then(|by| step_track(at.floor, here.point, placed.pose.position, by - now))
                .filter(|_| clear.way_out(placed.pose.position))
            else {
                return c.stand(body, driver, placed, now);
            };
            let mut from = placed;
            from.pose.position.x = here.point.x;
            from.pose.position.z = here.point.z;
            let h = c.stand(body, driver, from, now)?;
            c.carry(body, track)?;
            return Ok(h);
        }
        let near = c.near();
        let taken = |p: Vec3| {
            near.bodies_within(at.floor, [p.x, p.z], crate::controller::LANDING_ROOM)
                .iter()
                .any(|(o, _)| *o != body)
        };
        let own = self
            .footprints
            .get(&at.thing)
            .map_or(&[][..], Vec::as_slice);
        let to = climb_point(
            floor,
            all,
            &here,
            self.places_of(at.thing),
            own,
            &taken,
            body,
            build,
        )?;
        let Some(to) = to else {
            return refuse(
                "off-surface",
                format!(
                    "{}: no floor within {CLIMB_BOUND} µm of the slot by a way out",
                    show(at.thing)
                ),
            );
        };
        let landed = floor.place_built(body, frame, to, at.facing, build)?;
        let mut placed = landed;
        placed.pose.position.x = here.point.x;
        placed.pose.position.z = here.point.z;
        let from = placed.pose.position;
        let h = c.stand(body, driver, placed, now)?;
        c.carry(body, climb_track(at.floor, landed.pose.position))?;
        self.climbs.push(ClimbOut {
            body,
            thing: at.thing,
            from,
            to: landed.pose.position,
            at: now,
        });
        Ok(h)
    }
}

/// One slot's run (N14): its course in the thing's frame, loaded; the place at each station where riders get on and
/// off; and the stations where it is boarded (its own stop).
#[derive(Clone, Debug)]
struct Run {
    course: crate::courses::Course,
    table: crate::courses::Table,
    stops: BTreeMap<usize, PlaceAt>,
    own: std::collections::BTreeSet<usize>,
}

/// When run `r` next stands at one of its own stops with a crossing's time of it left: `now` when it does now.
fn next_own(r: &Run, now: Micros) -> Option<Micros> {
    r.own
        .iter()
        .filter_map(|station| {
            r.table
                .next(now, Some(*station), 2)
                .into_iter()
                .map(|stop| (stop.arrives.max(now), stop.leaves))
                .find(|(from, leaves)| {
                    leaves.saturating_sub(*from) >= crate::links::boarding::CROSSING
                })
                .map(|(from, _)| from)
        })
        .min()
}

/// When the moving thing on `t` next stands at `home` (µm) with `left` of its stop to spare, world µs (now while it
/// does): at any station of its course that is its home (its own loop's first; a steered course's last, where it
/// stands for good).
fn home_back(t: &crate::courses::Table, home: Vec3, now: Micros, left: Micros) -> Option<Micros> {
    let homes: std::collections::BTreeSet<usize> = t
        .legs
        .iter()
        .filter(|l| l.from == home)
        .filter_map(|l| l.stop)
        .collect();
    homes
        .into_iter()
        .filter_map(|i| {
            t.next(now, Some(i), 2)
                .into_iter()
                .map(|stop| (stop.arrives.max(now), stop.leaves))
                .find(|(from, leaves)| leaves.saturating_sub(*from) >= left)
                .map(|(from, _)| from)
        })
        .min()
}

/// The words a refusal adds for a run away from its own stop: when it is back there, world µs, so a client can time
/// itself.
fn back(r: &Run, now: Micros) -> String {
    next_own(r, now).map_or(String::new(), |t| format!("; back at its stop at {t} us"))
}

fn lit(s: &'static str) -> Name {
    Name::new(s).unwrap_or_else(|| unreachable!("a literal name"))
}

/// The nearest point to `from` (µm, x and z) on `floor` at least `apart` µm from every point of `taken`, searched on
/// a grid of `step` µm out to `most` µm, nearest first (ties by x, then z): where a body that rose onto a taken stand
/// point walks. None when no such point is that near.
pub fn clear_spot(
    floor: &Surface,
    from: [i64; 2],
    taken: &[[i64; 2]],
    apart: i64,
    step: i64,
    most: i64,
) -> Option<[i64; 2]> {
    let n = most / step;
    let mut grid: Vec<(i64, i64, i64)> = (-n..=n)
        .flat_map(|i| (-n..=n).map(move |j| (i * step, j * step)))
        .map(|(dx, dz)| (dx * dx + dz * dz, dx, dz))
        .filter(|(d2, ..)| *d2 <= most * most)
        .collect();
    grid.sort_unstable();
    let frame = Frame {
        node: floor.node,
        slot: None,
    };
    let clear = |p: [i64; 2]| {
        taken.iter().all(|q| {
            let (dx, dz) = (i128::from(p[0] - q[0]), i128::from(p[1] - q[1]));
            dx * dx + dz * dz >= i128::from(apart) * i128::from(apart)
        })
    };
    grid.into_iter()
        .map(|(_, dx, dz)| [from[0] + dx, from[1] + dz])
        .find(|&p| {
            clear(p)
                && floor
                    .place(floor.node, frame, Vec3::new(p[0], 0, p[1]), Quat::IDENTITY)
                    .is_ok()
        })
}

pub mod hands;
pub use hands::{
    Cx, Entry, Hand, Holding, Log, free_hands, hands, in_slot, occupies, steer, transfer,
};

#[cfg(test)]
mod hands_tests;
#[cfg(test)]
mod tests;
