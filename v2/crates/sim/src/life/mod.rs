//! Births and retirements (Engine v2 K10, #2673): a body enters and leaves a world by one cheap path, so a wave of
//! joins never hurts the tick.
//!
//! - **A birth is effects only.** A new body id, a `souls:body-of` link from the body to its Soul, and the body posed
//!   on legal ground at a standing place by a declared entry ([`Standing`]). Pictures and briefs come later, from the
//!   log. A birth names its Soul and its entry, nothing else: no account id reaches its effects (T8).
//! - **The standing place** comes from [`Standing`]: a [`Ring`] of spots round each entry for now (N9 later), tried
//!   nearest first. A spot is held while a body stands closer to it than two body radii (the spatial index walks use),
//!   and a held spot is passed over, as is one the ground does not hold (#4216). When every entry spot is held the
//!   birth takes the nearest free place on further rings ([`Standing::beyond`]); with none, it waits, named
//!   [`NO_FREE_PLACE`] ([`Life::held_back`]). Two bodies are never born on one point.
//! - **Carried, never dropped.** Births are taken in the order asked, at most [`Life::per_tick`] a tick; the rest wait
//!   for the next tick. Each born body says how long it waited. The budget is a count, not a reading of the clock: a
//!   birth's cost is measured (the `joins` bench), and the engine never reads wall time (K7).
//! - **One Soul, one body here.** A second birth for a Soul already embodied, or already waiting, is refused
//!   `soul-embodied`.
//! - **Retirement is one path** ([`Life::retire`]): the slot released (and the sit or rise under way cancelled), every
//!   timer of the body cancelled, its run and marks ended, the body taken out of the controller, the link ended and the
//!   node removed. Nothing else retires a body: a lost connection leaves it standing.
//!
//! Not here: pairing (W2), travel (X9), standing spots (N9), what a leaving body held (B4).

use std::collections::{BTreeMap, VecDeque};

use replica::bodies::Family;
use replica::effects::{Change, Refusal};
use replica::encode::Name;
use replica::ids::{Id, Minter, Scope};
use replica::kinds::sizes::{Build, Size};
use replica::pose::{Frame, Quat, Vec3};
use replica::time::Micros;
use replica::world_model::{Audience, End, show};

use crate::host::{Runner, named};
use crate::mover::{Body as Moved, Surface};
use crate::moves::Moves;
use crate::slots::Slots;
use crate::timers::{DueList, Timer};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// Where a body is born: the `i`-th standing place by an entry, as a node and a point (µm, the node's frame).
pub trait Standing {
    /// `None` when `entry` declares no place.
    fn spot(&self, entry: Id, i: u64) -> Option<(Id, Vec3)>;
    /// How many places to try for one birth before it waits for the next tick: the entry's own spots.
    fn tries(&self) -> u64;
    /// Further places, past the entry's own spots and further from it, tried when every one of those is held.
    fn beyond(&self) -> u64 {
        0
    }
}

/// Why a birth waits when every place by its entry, and every further one, is held.
pub const NO_FREE_PLACE: &str = "birth-no-free-place";

/// Rings tried past an entry's own when all of those are held.
pub const FAR_RINGS: u64 = 8;
/// Between neighbouring spots on a further ring, about, µm: the spot tables' pitch.
pub const FAR_PITCH: i64 = crate::spots::PITCH;

/// Twelve directions, a thousandth of a unit each (30° apart).
const DIRS: [[i64; 2]; 12] = [
    [1000, 0],
    [866, 500],
    [500, 866],
    [0, 1000],
    [-500, 866],
    [-866, 500],
    [-1000, 0],
    [-866, -500],
    [-500, -866],
    [0, -1000],
    [500, -866],
    [866, -500],
];

/// Rings of twelve spots round each entry's point: the first `radius` µm out, each next ring `gap` µm further. Spots
/// past the `rings` entry rings are the [`FAR_RINGS`] further out, each with as many spots as keep neighbours about
/// [`FAR_PITCH`] apart (integers only: points between two of the twelve directions, brought back to the ring).
pub struct Ring {
    pub entries: BTreeMap<Id, (Id, Vec3)>,
    pub radius: i64,
    pub gap: i64,
    pub rings: u64,
}

impl Ring {
    /// Spots between two of the twelve directions on ring `ring`: a twelfth of its length over [`FAR_PITCH`], at least 1.
    fn per_sector(&self, ring: u64) -> u64 {
        let r = self.radius + self.gap * ring as i64;
        // 2πr / 12 ≈ r × 0.5236.
        ((r * 5236 / 10_000) / FAR_PITCH).max(1) as u64
    }
}

impl Standing for Ring {
    fn spot(&self, entry: Id, i: u64) -> Option<(Id, Vec3)> {
        let &(node, c) = self.entries.get(&entry)?;
        let near = self.rings.max(1);
        let (ring, dx, dz) = if i < 12 * near {
            let [dx, dz] = DIRS[(i % 12) as usize];
            (i / 12, dx, dz)
        } else {
            let mut j = i - 12 * near;
            let mut ring = near;
            loop {
                if ring >= near + FAR_RINGS {
                    return None;
                }
                let n = self.per_sector(ring);
                if j < 12 * n {
                    break;
                }
                j -= 12 * n;
                ring += 1;
            }
            let n = self.per_sector(ring) as i64;
            let (sector, step) = ((j / n as u64) as usize, j as i64 % n);
            let [ax, az] = DIRS[sector];
            let [bx, bz] = DIRS[(sector + 1) % 12];
            let (x, z) = (ax * n + (bx - ax) * step, az * n + (bz - az) * step);
            let len = ((x * x + z * z) as u64).isqrt().max(1) as i64;
            (ring, x * 1000 / len, z * 1000 / len)
        };
        let r = self.radius + self.gap * ring as i64;
        Some((
            node,
            Vec3::new(c.x + dx * r / 1000, c.y, c.z + dz * r / 1000),
        ))
    }
    fn tries(&self) -> u64 {
        12 * self.rings.max(1)
    }
    fn beyond(&self) -> u64 {
        let near = self.rings.max(1);
        (near..near + FAR_RINGS)
            .map(|r| 12 * self.per_sector(r))
            .sum()
    }
}

/// A birth asked: the Soul, the entry it comes in by, and the world time it was asked (µs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Birth {
    pub soul: Id,
    pub entry: Id,
    pub asked: Micros,
}

/// A body born: its id, its Soul, its link, the effects that made it, and how long its birth waited (µs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Born {
    pub body: Id,
    pub soul: Id,
    pub link: Id,
    pub changes: Vec<Change>,
    pub waited: Micros,
}

/// A body retired: what it held and the effects that ended it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Retired {
    pub body: Id,
    /// The thing whose slot it held, if any.
    pub slot: Option<Id>,
    /// The timers it had pending, cancelled.
    pub timers: Vec<Timer>,
    /// The link ended, then the node removed.
    pub changes: Vec<Change>,
}

/// The Souls embodied here, and the births waiting for a tick.
pub struct Life {
    minter: Minter,
    /// Each embodied Soul's body and link.
    embodied: BTreeMap<Id, (Id, Id)>,
    waiting: VecDeque<Birth>,
    /// Each waiting Soul whose last try found every place held, and that reason's name.
    held_back: BTreeMap<Id, &'static str>,
    /// Births taken a tick, at most.
    pub per_tick: usize,
}

fn body_kind() -> Name {
    named("souls:body")
}

fn body_of_kind() -> Name {
    named("souls:body-of")
}

impl Life {
    /// Ids minted in `scope` (the world's); at most `per_tick` births a tick.
    pub fn new(scope: Scope, per_tick: usize) -> Life {
        Life {
            minter: Minter::new(scope),
            embodied: BTreeMap::new(),
            waiting: VecDeque::new(),
            held_back: BTreeMap::new(),
            per_tick: per_tick.max(1),
        }
    }

    /// The body of `soul` here, if it is embodied.
    pub fn body_of(&self, soul: Id) -> Option<Id> {
        self.embodied.get(&soul).map(|e| e.0)
    }

    /// Each embodied Soul and its body here, in id order.
    pub fn embodied(&self) -> impl Iterator<Item = (Id, Id)> + '_ {
        self.embodied.iter().map(|(soul, e)| (*soul, e.0))
    }

    /// The link from `soul`'s body to it, if it is embodied.
    pub fn link_of(&self, soul: Id) -> Option<Id> {
        self.embodied.get(&soul).map(|e| e.1)
    }

    /// Takes `soul` as embodied by `body` through `link`, as the log has it (a restart, C3 #3367).
    pub fn adopt(&mut self, soul: Id, body: Id, link: Id) {
        self.embodied.insert(soul, (body, link));
    }

    /// Births waiting for a tick.
    pub fn waiting(&self) -> usize {
        self.waiting.len()
    }

    /// Why `soul`'s birth waits, when its last try found every place held ([`NO_FREE_PLACE`]).
    pub fn held_back(&self, soul: Id) -> Option<&'static str> {
        self.held_back.get(&soul).copied()
    }

    /// Asks a birth; it is taken at a coming tick. `soul-embodied` when the Soul has a body here or one on the way.
    pub fn ask(&mut self, birth: Birth) -> R<()> {
        if let Some(&(b, _)) = self.embodied.get(&birth.soul) {
            return refuse(
                "soul-embodied",
                format!("{} is {}", show(birth.soul), show(b)),
            );
        }
        if self.waiting.iter().any(|w| w.soul == birth.soul) {
            return refuse(
                "soul-embodied",
                format!("{}: a birth is waiting", show(birth.soul)),
            );
        }
        self.waiting.push_back(birth);
        Ok(())
    }

    /// Takes this tick's births at world time `now`: each body posed at a standing place the ground holds and added
    /// to `runner` with no skill. A birth with no place the ground holds this tick, and any past the budget, waits.
    pub fn tick(
        &mut self,
        now: Micros,
        runner: &mut Runner,
        surfaces: &BTreeMap<Id, Surface>,
        standing: &impl Standing,
        family: &Family,
    ) -> Vec<Born> {
        self.tick_built(now, runner, surfaces, standing, family, &|_| {
            Build::STANDARD
        })
    }

    /// The same birth queue and placement path, using the configured admitted class before placement.
    pub fn tick_built(
        &mut self,
        now: Micros,
        runner: &mut Runner,
        floors: &dyn crate::mover::Floors,
        standing: &impl Standing,
        family: &Family,
        build_of: &impl Fn(Id) -> Build,
    ) -> Vec<Born> {
        let mut born = Vec::new();
        let mut again = Vec::new();
        while born.len() < self.per_tick {
            let Some(b) = self.waiting.pop_front() else {
                break;
            };
            match self.birth((b, build_of(b.soul)), now, runner, floors, standing, family) {
                Some(x) => born.push(x),
                None => again.push(b),
            }
        }
        self.waiting.extend(again);
        born
    }

    fn birth(
        &mut self,
        (b, build): (Birth, Build),
        now: Micros,
        runner: &mut Runner,
        floors: &dyn crate::mover::Floors,
        standing: &impl Standing,
        family: &Family,
    ) -> Option<Born> {
        let surfaces = floors.for_build(build)?;
        let mut placed: Option<Moved> = None;
        let next = self.minter.next();
        let body = Id::new(self.minter.scope(), next)?;
        // Held: a body closer than two body radii to the spot, as the index has it (bodies born this tick included).
        let clear = 2 * build.size.radius_mm().max(Size::Standard.radius_mm()) * 1000;
        let mut any = false;
        for i in 0..standing.tries() + standing.beyond() {
            let Some((node, at)) = standing.spot(b.entry, i) else {
                if i == 0 {
                    return None;
                }
                break;
            };
            any = true;
            if !runner
                .controller
                .near()
                .bodies_within(node, [at.x, at.z], clear)
                .is_empty()
            {
                continue;
            }
            let frame = Frame { node, slot: None };
            if let Some(s) = surfaces.get(&node)
                && let Ok(m) = s.place_built(body, frame, at, Quat::IDENTITY, build)
            {
                placed = Some(m);
                break;
            }
        }
        let Some(moved) = placed else {
            if any {
                self.held_back.insert(b.soul, NO_FREE_PLACE);
            }
            return None;
        };
        self.held_back.remove(&b.soul);
        // Straight into the controller: the runner's grid of bodies is as of the last tick's end, and takes the body
        // in at this tick's end (a whole rebuild a birth would cost the clock about 0.2 ms with a thousand bodies).
        runner
            .controller
            .add_built(family.clone(), moved, build)
            .ok()?;
        let body = self.minter.mint().ok()?;
        let link = self.minter.mint().ok()?;
        self.embodied.insert(b.soul, (body, link));
        let changes = vec![
            Change::Create {
                node: body,
                kind: body_kind(),
                pose: moved.pose,
                audience: Audience::Everyone,
                fields: BTreeMap::new(),
            },
            Change::Link {
                link,
                ty: body_of_kind(),
                ends: [body, b.soul],
                owner: End::First,
                audience: Audience::Everyone,
            },
        ];
        Some(Born {
            body,
            soul: b.soul,
            link,
            changes,
            waited: now - b.asked,
        })
    }

    /// Retires `soul`'s body at world time `at`, by the one path: its slot released (a sit or rise under way
    /// cancelled `retired`), every timer of it cancelled, its run, marks and unit ended, the body taken out of the
    /// controller, its link ended and its node removed. `soul-not-embodied` when it has no body here.
    pub fn retire(
        &mut self,
        soul: Id,
        at: Micros,
        runner: &mut Runner,
        slots: &mut Slots,
        moves: &mut Moves,
        due: &mut DueList,
    ) -> R<Retired> {
        let Some((body, link)) = self.embodied.remove(&soul) else {
            return refuse("soul-not-embodied", show(soul));
        };
        let slot = slots.release_body(body).map(|(thing, under_way)| {
            if let Some(i) = under_way {
                moves.cancel(&mut runner.controller, due, i, at, named("retired"));
            }
            thing
        });
        let timers = due.cancel_node(body);
        runner.runs.retain(|r| r.body != body);
        runner.fields.remove(&body);
        runner.staying.remove(&body);
        runner.ended.remove(&body);
        runner.asks.remove(&body);
        runner.granted.remove(&body);
        runner.units.stop(body);
        runner.controller.remove(body);
        runner.forget(body);
        Ok(Retired {
            body,
            slot,
            timers,
            changes: vec![Change::Unlink { link }, Change::Remove { node: body }],
        })
    }
}
