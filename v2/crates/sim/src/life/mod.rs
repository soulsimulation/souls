//! Births and retirements (Engine v2 K10, #2673): a body enters and leaves a world by one cheap path, so a wave of
//! joins never hurts the tick.
//!
//! - **A birth is effects only.** A new body id, a `souls:body-of` link from the body to its Soul, and the body posed
//!   on legal ground at a standing place by a declared entry ([`Standing`]). Pictures and briefs come later, from the
//!   log. A birth names its Soul and its entry, nothing else: no account id reaches its effects (T8).
//! - **The standing place** comes from [`Standing`]: a [`Ring`] of spots round each entry for now (N9 later). A spot
//!   the ground does not hold is passed over for the next.
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
    /// How many places to try for one birth before it waits for the next tick.
    fn tries(&self) -> u64;
}

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

/// Rings of twelve spots round each entry's point: the first `radius` µm out, each next ring `gap` µm further.
pub struct Ring {
    pub entries: BTreeMap<Id, (Id, Vec3)>,
    pub radius: i64,
    pub gap: i64,
    pub rings: u64,
}

impl Standing for Ring {
    fn spot(&self, entry: Id, i: u64) -> Option<(Id, Vec3)> {
        let &(node, c) = self.entries.get(&entry)?;
        let ring = (i / 12) % self.rings.max(1);
        let [dx, dz] = DIRS[(i % 12) as usize];
        let r = self.radius + self.gap * ring as i64;
        Some((
            node,
            Vec3::new(c.x + dx * r / 1000, c.y, c.z + dz * r / 1000),
        ))
    }
    fn tries(&self) -> u64 {
        12 * self.rings.max(1)
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
    /// The next standing place to try: births spread round their entry.
    next: u64,
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
            next: 0,
            per_tick: per_tick.max(1),
        }
    }

    /// The body of `soul` here, if it is embodied.
    pub fn body_of(&self, soul: Id) -> Option<Id> {
        self.embodied.get(&soul).map(|e| e.0)
    }

    /// The link from `soul`'s body to it, if it is embodied.
    pub fn link_of(&self, soul: Id) -> Option<Id> {
        self.embodied.get(&soul).map(|e| e.1)
    }

    /// Births waiting for a tick.
    pub fn waiting(&self) -> usize {
        self.waiting.len()
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
        let mut born = Vec::new();
        let mut again = Vec::new();
        while born.len() < self.per_tick {
            let Some(b) = self.waiting.pop_front() else {
                break;
            };
            match self.birth(b, now, runner, surfaces, standing, family) {
                Some(x) => born.push(x),
                None => again.push(b),
            }
        }
        self.waiting.extend(again);
        born
    }

    fn birth(
        &mut self,
        b: Birth,
        now: Micros,
        runner: &mut Runner,
        surfaces: &BTreeMap<Id, Surface>,
        standing: &impl Standing,
        family: &Family,
    ) -> Option<Born> {
        let mut placed: Option<Moved> = None;
        let next = self.minter.next();
        let body = Id::new(self.minter.scope(), next)?;
        for _ in 0..standing.tries() {
            let i = self.next;
            self.next = self.next.wrapping_add(1);
            let (node, at) = standing.spot(b.entry, i)?;
            let frame = Frame { node, slot: None };
            if let Some(s) = surfaces.get(&node)
                && let Ok(m) = s.place(body, frame, at, Quat::IDENTITY)
            {
                placed = Some(m);
                break;
            }
        }
        let moved = placed?;
        // Straight into the controller: the runner's grid of bodies is as of the last tick's end, and takes the body
        // in at this tick's end (a whole rebuild a birth would cost the clock about 0.2 ms with a thousand bodies).
        runner.controller.add(family.clone(), moved).ok()?;
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
