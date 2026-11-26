//! Standing spots, approach, and a crowd around a point (Engine v2 N9, #2678): each body sent to a point gets its
//! own legal place to stand near it, so thirty sent to one point form a crowd, not a knot.
//!
//! - **Places.** Round a target, on rings [`PITCH`] apart out to [`RINGS`] of them (on out to [`OVERFLOW`], to the first
//!   ring with one, when those have none: a pond's bank), `⌊2πk⌋` places on ring `k` (so
//!   neighbours on a ring are at least about a pitch apart), the target itself ring 0. A place is kept only where the
//!   target's node has walkable ground ([`Ground::stand`]), and never in a doorway or on a stair
//!   ([`Ground::passage`]). That rule is about the engine's choice only: a body whose own order is to stay in a
//!   doorway is not a walker here, and nothing here refuses it.
//! - **One table per target, owned by the target's node** ([`Spots::owners`]); a place has one holder. A walker never
//!   writes it: it marks what it asks (the walk skill's `Mark::spot`), and at the start of each tick the owner reads
//!   the marks of the last tick (T1) and grants, in id order, as N8's turns do ([`Spots::write`]).
//! - **Nearest** is by walking, never through a wall: the free place with the least walking distance from where the
//!   asker stands ([`Ground::walk`]) plus [`WEIGHT`] times its straight gap to the target, ties by (ring, place). The
//!   walk keeps a place behind a wall far; the weight fills the rings nearest the target first. When the target is
//!   itself clear ground, a place must also be joined to it on foot: a walk between them within [`DETOUR`] times
//!   their straight gap plus a pitch. A target that is not (in a box, a wall, a doorway, on a stair, on water, off the
//!   ground) is bound to the nearest clear place beside it the same way, and so is a clear target the asker's walk
//!   does not reach (a pocket of ground walled in by a desk's legs and the chairs round it, #4072).
//! - **Recorded as the engine's.** Each grant is an [`Entry::Grant`] with the actor the world and the cause the
//!   asker's order; the same marks give the same grants every run (integers, id order, no hashing).
//! - **Released** when its holder no longer asks for it: it left (its mark asks for another target or none,
//!   `spot-left`) or its order ended (no mark, `order-ended`), and when its walk there ended short of it, as near as
//!   the crowd allows (0.133 A2-4: no mark, `order-ended`; the body is not settled).
//!
//! - **A place to act from** (C15, #3447, [`within`]). A form's walk to a point a body cannot stand on goes to the
//!   nearest place within the body's reach of it, by the same rule on finer rings ([`REACH_PITCH`]), held by no one:
//!   the act is brief, and the walk keeps bodies apart. A form's walk to a thing with a footprint (its entry's
//!   bounds, [`footprint`]: a workbench, a shelf against a wall, a window in one) goes to the nearest place within
//!   that reach of its outline, not of its middle; a walk to be at a walkable one ([`walkable`]: a stage, a rug, a
//!   deck) ends on it ([`within_footprint`], #4072).
//!
//! - **Overflow** (0.133 A2-5, a crowded meetup ends as near as the crowd allows, never refused). When every place
//!   of a target is held or kept for another's room, and one of those its walk reaches, the asker is granted the
//!   nearest free standing point on the open ground round it ([`Ground::overflow_at`]), on rings [`PITCH`] apart out
//!   to [`OVERFLOW`], by the same cost, none within half a pitch of the target's own places nor in another body's
//!   space, and each joined on foot to the target's centre there (or, where no body stands at it, to the target's
//!   own place nearest it) within [`DETOUR`] times their straight gap plus a pitch, so never behind a wall or in a
//!   room. A target the asker cannot reach at all does not overflow: it is refused `spot-none-free` as before. It is held and released like
//!   any place, and kept across a change of the ground while its point is still one; a holder whose place a change
//!   took away is released (`ground-changed`) and named to the runner ([`Spots::revoked`]), which plans it again.
//!   The walk there ends `done`, as near as the crowd allows ([`Granted::overflow`]). One pass chooses at most
//!   [`OVERFLOW_EACH`] overflow points; the rest of a burst are answered in the passes after, never refused.
//!
//! Refusals: `spot-none-near` (no walkable place on the rings, nor on the rings past them out to [`OVERFLOW`]), `spot-none-free` (every place held or out of reach,
//! and no free standing point within [`OVERFLOW`] of the target either).
//! Not here: seats (B3), facing (B11), formations and conversation circles, spots described in words (E2), perches
//! and staying in a doorway or on a stair (E3), spots by a thing's kind (K3).

use replica::effects::{Actor, Cause, Refusal};
use replica::ids::Id;
use replica::kinds::sizes::Size;
use replica::pose::{Quat, Vec3};
use replica::time::Micros;
use replica::world_model::show;
use std::collections::{BTreeMap, BTreeSet};

/// Between rings, and between neighbouring places on a ring, µm.
pub const PITCH: i64 = 700_000;
/// Rings round the target (ring 0 is the target).
pub const RINGS: i64 = 10;
/// No place within this of a link's end, nor within half the link's width and half this of its line, µm: the engine
/// never stops a walker in a doorway or on a stair.
pub const CLEAR: i64 = 700_000;
/// How far round a crowded target its overflow points lie, µm (A2-5): a walker is refused `spot-none-free` only when
/// no free standing point is within this.
pub const OVERFLOW: i64 = 15_000_000;
/// The most overflow points one pass of the tables chooses (A2-5): a burst beyond it is answered over the next passes,
/// so the other answers of a planner's batch never wait behind a crowd moment.
pub const OVERFLOW_EACH: usize = 4;
/// Bodies this far apart in height stand on different levels: neither keeps the other from a place, µm.
const LEVEL: i64 = 1_000_000;
/// The weight of a place's straight gap to the target against the walk to it.
pub const WEIGHT: i64 = 3;
/// A place is joined to a clear target when walked to from it within this many times their straight gap, plus a pitch.
pub const DETOUR: i64 = 2;
/// A search for a place to stand gives up after this many route searches that find no way (#4072). A place the ground
/// already knows no walk reaches ([`Ground::may_reach`], a lookup) is skipped without one and is not counted, so a
/// target cut off from the asker (a floor with no way up) costs lookups, and at most this many failed searches.
pub const MISSES_MOST: usize = 64;

/// The ground as the spot tables read it. All µm.
pub trait Ground {
    /// Where a body may stand at `p` on `node`: the point on its walkable ground there, and that point in the ground's
    /// frame; `None` off it.
    fn stand(&self, node: Id, p: Vec3) -> Option<(Vec3, Vec3)>;
    /// Whether `p` on `node` lies in a doorway or on a stair.
    fn passage(&self, node: Id, p: Vec3) -> bool;
    /// The walking distance from `a` on node `an` to `b` on node `bn`, never through a wall; `None` with no way there.
    fn walk(&mut self, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64>;
    /// Whether a walk from `a` to `b` may find a way: `false` only when none can (no portal or link joins them),
    /// told without a route search (#4072). A ground that cannot tell says `true`.
    fn may_reach(&self, _an: Id, _a: Vec3, _bn: Id, _b: Vec3) -> bool {
        true
    }
    /// Where a crowded target `p` on `node` overflows to (A2-5): each node whose walkable ground is round it, in the
    /// order tried, and the point there. None, the default: it does not overflow.
    fn overflow_at(&self, _node: Id, _p: Vec3) -> Vec<(Id, Vec3)> {
        Vec::new()
    }
}

/// The same geometry questions selected for one admitted footprint. Reservations are never stored here.
pub trait ClassGround {
    fn stand(&self, size: Size, node: Id, p: Vec3) -> Option<(Vec3, Vec3)>;
    fn passage(&self, size: Size, node: Id, p: Vec3) -> bool;
    fn walk(&mut self, size: Size, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64>;
    fn may_reach(&self, _size: Size, _an: Id, _a: Vec3, _bn: Id, _b: Vec3) -> bool {
        true
    }
    fn overflow_at(&self, _size: Size, _node: Id, _p: Vec3) -> Vec<(Id, Vec3)> {
        Vec::new()
    }
}
struct Selected<'a> {
    ground: &'a mut dyn ClassGround,
    size: Size,
}
impl Ground for Selected<'_> {
    fn stand(&self, node: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        self.ground.stand(self.size, node, p)
    }
    fn passage(&self, node: Id, p: Vec3) -> bool {
        self.ground.passage(self.size, node, p)
    }
    fn walk(&mut self, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64> {
        self.ground.walk(self.size, an, a, bn, b)
    }
    fn may_reach(&self, an: Id, a: Vec3, bn: Id, b: Vec3) -> bool {
        self.ground.may_reach(self.size, an, a, bn, b)
    }
    fn overflow_at(&self, node: Id, p: Vec3) -> Vec<(Id, Vec3)> {
        self.ground.overflow_at(self.size, node, p)
    }
}
struct Standard<'a>(&'a mut dyn Ground);
impl ClassGround for Standard<'_> {
    fn stand(&self, size: Size, node: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        (size == Size::Standard)
            .then(|| self.0.stand(node, p))
            .flatten()
    }
    fn passage(&self, _size: Size, node: Id, p: Vec3) -> bool {
        self.0.passage(node, p)
    }
    fn walk(&mut self, size: Size, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64> {
        (size == Size::Standard)
            .then(|| self.0.walk(an, a, bn, b))
            .flatten()
    }
    fn may_reach(&self, _size: Size, an: Id, a: Vec3, bn: Id, b: Vec3) -> bool {
        self.0.may_reach(an, a, bn, b)
    }
    fn overflow_at(&self, _size: Size, node: Id, p: Vec3) -> Vec<(Id, Vec3)> {
        self.0.overflow_at(node, p)
    }
}

/// A target: a point (µm) in the frame of a node (a floor, or the open ground).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Target {
    pub node: Id,
    pub at: [i64; 3],
}

impl Target {
    pub fn new(node: Id, at: Vec3) -> Target {
        Target {
            node,
            at: [at.x, at.y, at.z],
        }
    }

    pub fn point(&self) -> Vec3 {
        Vec3::new(self.at[0], self.at[1], self.at[2])
    }
}

/// What an asker was granted: the node it stands on there, the point (µm, that node's frame), and whether it is an
/// overflow point round a crowded target rather than one of the target's own places (A2-5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Granted {
    pub node: Id,
    pub at: Vec3,
    pub overflow: bool,
}

/// One place round a target.
#[derive(Clone, Debug)]
pub struct Place {
    pub ring: u16,
    pub k: u16,
    /// Where a body stands, µm, the target node's frame.
    pub at: Vec3,
    pub holder: Option<Id>,
    /// The same point in the ground's frame.
    world: Vec3,
    /// Joined to a clear target on foot (computed on first need).
    joined: Option<bool>,
}

/// One target's places.
#[derive(Clone, Debug)]
pub struct Table {
    /// Whether the target is itself clear ground.
    pub clear: bool,
    pub places: Vec<Place>,
}

/// An asker, as its mark of the last tick says: where it stands (µm, its node's frame), what it asks, for which order,
/// and whether the world is carrying it, across a link (a stair, a doorway, #4171) or off a seat (a rise's step off, a
/// climb out): then it may stand on no floor's ground until it lands, and a new ask waits for that instead of being
/// refused.
#[derive(Clone, Copy, Debug)]
pub struct Ask {
    pub who: Id,
    pub order: Id,
    pub node: Id,
    pub from: Vec3,
    pub target: Target,
    pub carried: bool,
}

/// The record of the tables' changes, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    /// `who` was granted place (ring, k) at `to` for `target`, at a cost (µm): the engine's choice.
    Grant {
        at: Micros,
        who: Id,
        target: Target,
        place: (u16, u16),
        to: Vec3,
        cost: i64,
        cause: Cause,
        actor: Actor,
    },
    /// The place `who` held was released, and why.
    Release {
        at: Micros,
        who: Id,
        target: Target,
        place: (u16, u16),
        why: &'static str,
    },
    /// `who` asked for `target` and was refused by name.
    Refuse {
        at: Micros,
        who: Id,
        target: Target,
        name: &'static str,
    },
}

/// The spot tables, by owning node and target, with what each asker holds or was refused.
#[derive(Default)]
pub struct Spots {
    pub owners: BTreeMap<Id, BTreeMap<[i64; 3], Table>>,
    pub record: Vec<Entry>,
    /// Per asker: the target and place it holds.
    held: BTreeMap<Id, Held>,
    /// Geometry caches only: every class uses the one held/refused/record authority below.
    sized: BTreeMap<(Size, Target), Table>,
    invalid_geometry: bool,
    /// Per asker: the target it was refused, and the refusal's name.
    refused: BTreeMap<Id, (Target, Size, &'static str)>,
    /// Each crowded target's overflow points (A2-5), by class: for each ground round it, in the order tried, where
    /// they lie and their table.
    overflow: BTreeMap<(Size, Target), Vec<(Round, Table)>>,
    /// The askers whose place a change of the ground took away (`ground-changed`), until the runner reads them: it
    /// lets go of their old grant and plans each again ([`Spots::revoked`]).
    revoked: Vec<Id>,
}

/// Where a crowded target's overflow points lie on one ground (A2-5): its centre there (the target's point in that
/// node's frame) and in the ground's frame, and the anchor each point must be joined to on foot: the centre where a
/// body may stand on it, else the target's own place nearest it.
#[derive(Clone, Copy, Debug)]
struct Round {
    centre: Target,
    centre_world: Vec3,
    anchor: (Id, Vec3),
    anchor_world: Vec3,
}

#[derive(Clone, Copy)]
struct Held {
    target: Target,
    index: usize,
    size: Size,
    at: Vec3,
    world: Vec3,
    place: (u16, u16),
    /// The node it stands on, and the overflow table its place is in, if it is an overflow point (A2-5).
    node: Id,
    overflow: Option<usize>,
}

/// The straight distance in x and z, µm.
pub fn flat(a: Vec3, b: Vec3) -> i64 {
    (i128::from(a.x - b.x).pow(2) + i128::from(a.z - b.z).pow(2)).isqrt() as i64
}

/// The distance from `p` to the segment `a`–`b`, x and z, µm.
pub fn to_segment(p: Vec3, a: Vec3, b: Vec3) -> i64 {
    let (ex, ez) = (i128::from(b.x - a.x), i128::from(b.z - a.z));
    let l2 = (ex * ex + ez * ez).max(1);
    let t = (i128::from(p.x - a.x) * ex + i128::from(p.z - a.z) * ez).clamp(0, l2);
    let at = Vec3::new(a.x + (ex * t / l2) as i64, 0, a.z + (ez * t / l2) as i64);
    flat(Vec3::new(p.x, 0, p.z), at)
}

impl Table {
    /// The places round `target`: on walkable ground, out of doorways and off stairs. A target with no place on its
    /// [`RINGS`] (the middle of a pond wider than they reach) has the rings go on out to [`OVERFLOW`], to the first ring
    /// that has one, so a walk to it ends on its nearest bank instead of being refused (0.133 Q1).
    pub fn new(g: &dyn Ground, target: Target) -> Table {
        let t = target.point();
        let mut places = Vec::new();
        for ring in 0..=OVERFLOW / PITCH {
            if ring > RINGS && !places.is_empty() {
                break;
            }
            let n = if ring == 0 { 1 } else { 6_283 * ring / 1_000 };
            for k in 0..n {
                let off = Quat::from_yaw_mdeg(k * 360_000 / n)
                    .and_then(|q| q.rotate(Vec3::new(0, 0, ring * PITCH)))
                    .unwrap_or(Vec3::ZERO);
                let p = Vec3::new(t.x + off.x, t.y, t.z + off.z);
                let Some((at, world)) = g.stand(target.node, p) else {
                    continue;
                };
                if g.passage(target.node, at) {
                    continue;
                }
                places.push(Place {
                    ring: ring as u16,
                    k: k as u16,
                    at,
                    holder: None,
                    world,
                    joined: None,
                });
            }
        }
        Table {
            clear: g.stand(target.node, t).is_some() && !g.passage(target.node, t),
            places,
        }
    }

    /// The grounds a crowded target `t` overflows onto ([`Ground::overflow_at`]), each with its points; `own` is the
    /// target's own table. A ground with no anchor (no standing at its centre and no own place) gives none.
    fn rounds(g: &dyn Ground, t: Target, own: &Table) -> Vec<(Round, Table)> {
        g.overflow_at(t.node, t.point())
            .into_iter()
            .filter_map(|(node, p)| {
                let worlds: Vec<Vec3> = own.places.iter().map(|q| q.world).collect();
                let tb = Table::around(g, node, p, &worlds);
                // The overflow lies on the open ground, whose frame is the ground's: its centre is `p` there.
                let (anchor, anchor_world) = match g.stand(node, p) {
                    Some((at, w)) if !g.passage(node, at) => ((node, at), w),
                    _ => {
                        let q = own
                            .places
                            .iter()
                            .min_by_key(|q| (flat(q.world, p), q.ring, q.k))?;
                        ((t.node, q.at), q.world)
                    }
                };
                let centre_world = p;
                Some((
                    Round {
                        centre: Target::new(node, p),
                        centre_world,
                        anchor,
                        anchor_world,
                    },
                    tb,
                ))
            })
            .collect()
    }

    /// The free overflow point of round `r` nearest `ask` (whose place on the ground's frame is `a`), by the cost of
    /// [`Table::nearest`] measured to the centre, joined on foot to the anchor within [`DETOUR`] times their straight
    /// gap plus a pitch, and clear of every body in `held` (the ground's frame, and how far each keeps others off).
    fn nearest_round(
        &mut self,
        g: &mut dyn Ground,
        ask: &Ask,
        a: Vec3,
        r: &Round,
        held: &[(Vec3, i64)],
    ) -> Option<(usize, i64)> {
        let node = r.centre.node;
        let gap = |p: &Place| flat(p.world, r.centre_world);
        let mut order: Vec<(i64, u16, u16, usize)> = self
            .places
            .iter()
            .enumerate()
            .filter(|(_, p)| p.holder.is_none())
            .map(|(i, p)| (flat(p.world, a) + WEIGHT * gap(p), p.ring, p.k, i))
            .collect();
        order.sort_unstable();
        let mut best: Option<(i64, u16, u16, usize)> = None;
        let mut misses = 0;
        for (bound, ring, k, i) in order {
            if best.is_some_and(|b| bound > b.0) {
                break;
            }
            let (at, world) = (self.places[i].at, self.places[i].world);
            if held
                .iter()
                .any(|(h, c)| (h.y - world.y).abs() < LEVEL && flat(*h, world) < *c)
                || !g.may_reach(ask.node, ask.from, node, at)
            {
                continue;
            }
            let joined = *self.places[i].joined.get_or_insert_with(|| {
                g.walk(node, at, r.anchor.0, r.anchor.1)
                    .is_some_and(|w| w <= DETOUR * flat(world, r.anchor_world) + PITCH)
            });
            if !joined {
                continue;
            }
            let Some(walk) = g.walk(ask.node, ask.from, node, at) else {
                misses += 1;
                if misses >= MISSES_MOST {
                    break;
                }
                continue;
            };
            let key = (walk + WEIGHT * gap(&self.places[i]), ring, k, i);
            if best.is_none_or(|b| key < b) {
                best = Some(key);
            }
        }
        best.map(|(cost, .., i)| (i, cost))
    }

    /// Whether the target's own places failed `ask` for the crowd alone (A2-5): one held by another, or kept from it
    /// for another's room (`blocked`), is one its walk reaches (and, for a clear target, joined to it). A target the
    /// asker cannot reach at all is no crowd: it does not overflow.
    fn crowded(&mut self, g: &mut dyn Ground, ask: &Ask, blocked: &BTreeSet<usize>) -> bool {
        let Some((_, a)) = g.stand(ask.node, ask.from) else {
            return false;
        };
        let t = ask.target;
        let mut taken: Vec<(i64, usize)> = self
            .places
            .iter()
            .enumerate()
            .filter(|(i, p)| p.holder.is_some() || blocked.contains(i))
            .map(|(i, p)| (flat(p.world, a), i))
            .collect();
        taken.sort_unstable();
        let mut misses = 0;
        for (_, i) in taken {
            let at = self.places[i].at;
            if !g.may_reach(ask.node, ask.from, t.node, at) || self.clear && !self.joined(g, t, i) {
                continue;
            }
            if g.walk(ask.node, ask.from, t.node, at).is_some() {
                return true;
            }
            misses += 1;
            if misses >= MISSES_MOST {
                return false;
            }
        }
        false
    }

    /// The overflow points round a crowded target (A2-5): on `node`'s walkable ground about `p`, rings [`PITCH`]
    /// apart out to [`OVERFLOW`], out of doorways and off stairs, none within half a pitch of `own` (the target's own
    /// places, the ground's frame).
    fn around(g: &dyn Ground, node: Id, p: Vec3, own: &[Vec3]) -> Table {
        let mut places = Vec::new();
        for ring in 0..=OVERFLOW / PITCH {
            let n = if ring == 0 { 1 } else { 6_283 * ring / 1_000 };
            for k in 0..n {
                let off = Quat::from_yaw_mdeg(k * 360_000 / n)
                    .and_then(|q| q.rotate(Vec3::new(0, 0, ring * PITCH)))
                    .unwrap_or(Vec3::ZERO);
                let q = Vec3::new(p.x + off.x, p.y, p.z + off.z);
                let Some((at, world)) = g.stand(node, q) else {
                    continue;
                };
                if g.passage(node, at) || own.iter().any(|o| flat(*o, world) < PITCH / 2) {
                    continue;
                }
                places.push(Place {
                    ring: ring as u16,
                    k: k as u16,
                    at,
                    holder: None,
                    world,
                    joined: None,
                });
            }
        }
        Table {
            clear: false,
            places,
        }
    }

    /// The free place nearest `ask` (module docs), with its cost (µm), or a refusal's name.
    fn nearest(
        &mut self,
        g: &mut dyn Ground,
        ask: &Ask,
        blocked: &BTreeSet<usize>,
    ) -> Result<(usize, i64), &'static str> {
        if self.places.is_empty() {
            return Err("spot-none-near");
        }
        let Some((_, a)) = g.stand(ask.node, ask.from) else {
            return Err("spot-none-free");
        };
        let found = self.nearest_by(g, ask, a, blocked, self.clear);
        // A clear target the asker's walk does not reach (a pocket under a desk, #4072) is bound to the nearest place
        // beside it, as a target in a box is. A crowd that holds every joined place of a reached target is still
        // refused.
        match found {
            Err(_)
                if self.clear
                    && g.walk(ask.node, ask.from, ask.target.node, ask.target.point())
                        .is_none() =>
            {
                self.nearest_by(g, ask, a, blocked, false)
            }
            r => r,
        }
    }

    /// [`Table::nearest`] from the asker's place in the ground's frame `a`; with `joined`, only places joined on foot
    /// to the target count.
    fn nearest_by(
        &mut self,
        g: &mut dyn Ground,
        ask: &Ask,
        a: Vec3,
        blocked: &BTreeSet<usize>,
        joined: bool,
    ) -> Result<(usize, i64), &'static str> {
        let t = ask.target;
        let gap = |p: &Place| flat(p.at, t.point());
        // Free places by a bound below their cost: the straight way there plus the weighted gap.
        let mut order: Vec<(i64, u16, u16, usize)> = self
            .places
            .iter()
            .enumerate()
            .filter(|(i, p)| p.holder.is_none() && !blocked.contains(i))
            .map(|(i, p)| (flat(p.world, a) + WEIGHT * gap(p), p.ring, p.k, i))
            .collect();
        order.sort_unstable();
        let mut best: Option<(i64, u16, u16, usize)> = None;
        let mut misses = 0;
        for (bound, ring, k, i) in order {
            if best.is_some_and(|b| bound > b.0) {
                break;
            }
            if !g.may_reach(ask.node, ask.from, t.node, self.places[i].at)
                || joined && !self.joined(g, t, i)
            {
                continue;
            }
            let Some(walk) = g.walk(ask.node, ask.from, t.node, self.places[i].at) else {
                misses += 1;
                if misses >= MISSES_MOST {
                    break;
                }
                continue;
            };
            let key = (walk + WEIGHT * gap(&self.places[i]), ring, k, i);
            if best.is_none_or(|b| key < b) {
                best = Some(key);
            }
        }
        best.map(|(cost, .., i)| (i, cost)).ok_or("spot-none-free")
    }

    /// Whether place `i` is joined on foot to the (clear) target `t`.
    fn joined(&mut self, g: &mut dyn Ground, t: Target, i: usize) -> bool {
        if let Some(j) = self.places[i].joined {
            return j;
        }
        let at = self.places[i].at;
        // Walked from the place to the target: a target on a vertex of the ground's squares is reached from every
        // side, though not every straight step leaves it.
        let j = g
            .walk(t.node, at, t.node, t.point())
            .is_some_and(|w| w <= DETOUR * flat(at, t.point()) + PITCH);
        self.places[i].joined = Some(j);
        j
    }
}

/// Between the rings [`within`] tries, and between neighbouring places on a ring, µm.
pub const REACH_PITCH: i64 = 100_000;

/// Where a body may stand to act at `target` (C15, #3447): the target itself when a body may stand there and the
/// asker's walk reaches it (#4072); else the
/// nearest place within `reach` of it, on rings [`REACH_PITCH`] apart (`⌊2πk⌋` places on ring `k`), on walkable
/// ground and out of doorways and off stairs, as a table's places are. Nearest as a table's nearest: the least walk
/// from `from` (the asker's node and where it stands) plus [`WEIGHT`] times the place's gap to the target, ties by
/// (ring, place), a place with no walk there skipped; with no `from`, by the gap alone. `None` when no place is.
pub fn within(
    g: &mut dyn Ground,
    target: Target,
    reach: i64,
    from: Option<(Id, Vec3)>,
) -> Option<Vec3> {
    let t = target.point();
    let from = from.and_then(|(node, p)| Some((node, p, g.stand(node, p)?.1)));
    // A point a body may stand on is its own place, unless the asker's walk cannot reach it (a pocket under a desk,
    // walled in by its legs and the chairs round it, #4072): then the rings are tried, and the point is kept only
    // when none of them is reached either.
    let standable = g.stand(target.node, t).is_some();
    if standable && from.is_none_or(|(node, p, _)| g.walk(node, p, target.node, t).is_some()) {
        return Some(t);
    }
    let found = rings(g, target, reach, from);
    if found.is_none() && standable {
        return Some(t);
    }
    found
}

/// A thing's footprint by its entry (#4072): the box its `geometry.bounds_mm` (whole mm `[x, y, z]`) gives, centred on
/// the thing's origin, as its four corners in the thing's own frame (µm, y 0, in order round it), and its height (µm).
/// The one rule for a thing's footprint: the reach a move at the thing is judged by and the place a form's walk to it
/// goes to ([`within_footprint`]) both read it. `None` when the entry gives no bounds.
pub fn footprint(entry: &replica::rules::json::Value) -> Option<([Vec3; 4], i64)> {
    let mm = |v: &replica::rules::json::Value| match v {
        replica::rules::json::Value::Int(n) => i64::try_from(*n).ok()?.checked_mul(1000),
        _ => None,
    };
    let [x, y, z] = entry.get("geometry")?.get("bounds_mm")?.arr()? else {
        return None;
    };
    let (x, y, z) = (mm(x)? / 2, mm(y)?, mm(z)? / 2);
    let c = |u: i64, v: i64| Vec3::new(u, 0, v);
    Some(([c(-x, -z), c(x, -z), c(x, z), c(-x, z)], y))
}

/// How far `p` is from the closed outline `ring` (its corners in order) across x and z, µm: 0 inside it.
pub fn to_outline(p: Vec3, ring: &[Vec3]) -> i64 {
    let k = ring.len();
    let mut odd = false;
    for i in 0..k {
        let (a, b) = (ring[i], ring[(i + 1) % k]);
        if (a.z > p.z) != (b.z > p.z) {
            let x = i128::from(a.x)
                + i128::from(b.x - a.x) * i128::from(p.z - a.z) / i128::from(b.z - a.z);
            if i128::from(p.x) < x {
                odd = !odd;
            }
        }
    }
    if odd {
        return 0;
    }
    (0..k)
        .map(|i| to_segment(p, ring[i], ring[(i + 1) % k]))
        .min()
        .unwrap_or(i64::MAX)
}

/// The most places [`within_footprint`] tries on one band round an outline: on a long one they are spread out, so
/// the work does not grow with its size (a court's, a hill's).
pub const BAND_PLACES: i64 = 48;

/// How far inside a walkable thing's outline a walk onto it ends at the least ([`within_footprint`] with `on`), µm: a
/// body's width, so the body stands on it, not on its edge.
pub const ON_DEPTH: i64 = 400_000;

/// Where a body may stand to be at, or act at, a thing whose footprint is `ring` (#4072: its corners in `target`'s
/// node's frame, in order round it; `target` its middle).
///
/// - **Beside it** (`on` false): the nearest place within `reach` of its outline, not of its middle, so a long
///   workbench, a shelf against a wall or a window in one is reached from wherever beside it the asker's walk gets
///   to. The places lie on bands round the outline, its edges moved out by 0, [`REACH_PITCH`], … `reach`, each edge's
///   line run on that far past both its corners.
/// - **On it** (`on`, a walkable thing a body goes to: a stage, a rug, a deck, a court): the nearest place inside its
///   outline, on bands moved in by [`ON_DEPTH`], then a pitch more each, to `reach`; with none reached, beside it as
///   above.
///
/// On each band at most [`BAND_PLACES`] places, a pitch apart or spread evenly round a longer band. Kept, as
/// [`within`]'s rings are, on walkable ground, out of doorways and off stairs. Nearest as [`within`]'s: the least walk
/// from `from` plus [`WEIGHT`] times the place's gap to the outline (0 inside it; a place off a walkable thing, its edge
/// too, counts `reach` more), ties by (band, edge, place); with no `from`, by the gap alone. With no such place,
/// [`within`] at the middle, so a thing reached before still is.
pub fn within_footprint(
    g: &mut dyn Ground,
    target: Target,
    ring: &[Vec3],
    on: bool,
    reach: i64,
    from: Option<(Id, Vec3)>,
) -> Option<Vec3> {
    let t = target.point();
    let k = ring.len();
    let walker = from.and_then(|(node, p)| Some((node, p, g.stand(node, p)?.1)));
    // Twice the outline's signed area: its sign says which side of each edge is outside.
    let area: i128 = (0..k)
        .map(|i| {
            let (a, b) = (ring[i], ring[(i + 1) % k]);
            i128::from(a.x) * i128::from(b.z) - i128::from(b.x) * i128::from(a.z)
        })
        .sum();
    let out = if area > 0 { 1 } else { -1 };
    let lens: Vec<i64> = (0..k).map(|i| flat(ring[i], ring[(i + 1) % k])).collect();
    // The bands, by how far out each lies (in when below 0).
    let mut bands: Vec<i64> = Vec::new();
    if on {
        bands.extend(
            (0..)
                .map(|n| -ON_DEPTH - n * REACH_PITCH)
                .take_while(|d| -d <= reach),
        );
    }
    bands.extend((0..=reach / REACH_PITCH).map(|n| n * REACH_PITCH));
    // What a place's gap to the outline counts, on band `d`: off a walkable thing (its edge too), more than any place
    // on it.
    let cost = |gap: i64, d: i64| {
        if on && d >= 0 {
            WEIGHT * (gap + reach)
        } else {
            WEIGHT * gap
        }
    };
    let mut seen = BTreeSet::new();
    // Places by a bound below their cost: the straight way there plus the weighted gap.
    let mut order: Vec<(i64, (usize, usize, i64), Vec3)> = Vec::new();
    for (band, &d) in bands.iter().enumerate() {
        let whole: i64 = lens.iter().map(|l| (l + 2 * d).max(0)).sum();
        let step = REACH_PITCH.max((whole + BAND_PLACES - 1) / BAND_PLACES);
        for i in 0..k {
            let (a, b, len) = (ring[i], ring[(i + 1) % k], lens[i]);
            if len == 0 || len + 2 * d <= 0 {
                continue;
            }
            // The edge's line moved out by `d`, at `s` µm along it from `a`.
            let scale = |e: i64, by: i64| {
                i64::try_from(i128::from(e) * i128::from(by) / i128::from(len)).unwrap_or(0)
            };
            let at = |s: i64| {
                let along = |u: i64, v: i64| u + scale(v - u, s);
                let n = |e: i64| scale(e, d);
                Vec3::new(
                    along(a.x, b.x) + out * n(b.z - a.z),
                    t.y,
                    along(a.z, b.z) - out * n(b.x - a.x),
                )
            };
            for j in 0..=(len + 2 * d) / step {
                let p = at(j * step - d);
                // A place on a band in is as deep inside as the band (not past the far side of a narrow thing).
                let shallow = || {
                    (0..k)
                        .map(|e| to_segment(p, ring[e], ring[(e + 1) % k]))
                        .min()
                        .is_none_or(|x| x < -d - 1)
                };
                if to_outline(p, ring) > reach || (d < 0 && shallow()) {
                    continue;
                }
                let Some((at, world)) = g.stand(target.node, p) else {
                    continue;
                };
                if !seen.insert([at.x, at.y, at.z]) || g.passage(target.node, at) {
                    continue;
                }
                order.push((
                    cost(to_outline(at, ring), d) + walker.map_or(0, |(_, _, w)| flat(world, w)),
                    (band, i, j),
                    at,
                ));
            }
        }
    }
    order.sort_unstable_by_key(|&(bound, key, _)| (bound, key));
    let best = match walker {
        None => order.first().map(|o| o.2),
        Some((node, p, _)) => {
            let mut best: Option<(i64, (usize, usize, i64), Vec3)> = None;
            let mut misses = 0;
            for (bound, key, at) in order {
                if best.is_some_and(|b| bound > b.0) {
                    break;
                }
                // As `within`'s rings: a place the ground knows no walk reaches costs no search and no miss.
                if !g.may_reach(node, p, target.node, at) {
                    continue;
                }
                let Some(walk) = g.walk(node, p, target.node, at) else {
                    misses += 1;
                    if misses >= MISSES_MOST {
                        break;
                    }
                    continue;
                };
                let c = walk + cost(to_outline(at, ring), bands[key.0]);
                if best.is_none_or(|b| (c, key) < (b.0, b.1)) {
                    best = Some((c, key, at));
                }
            }
            best.map(|b| b.2)
        }
    };
    // None found (the bands are sampled, and a search gives up after [`MISSES_MOST`] misses): [`within`] at the middle,
    // so a thing reached before is still reached. A target cut off from the asker costs it lookups, not searches.
    best.or_else(|| within(g, target, reach, from))
}

/// Whether a body goes onto a thing to be at it (#4072), by its entry: it is a place (`owner: place`: a deck, a pier, a
/// terrace); it has an area that allows `stand`; it is no taller than a step ([`crate::ground::STEP`]) and wide enough
/// to stand on (a rug, a mat; not a bowl); or a slot a body stands in (one that admits a body with no posture) lies inside its footprint (a stage's spots, a
/// court's sides). A bed (its mattress allows only `lie` and `sit`) and a pool table (its players' slots stand round
/// it) are not. A walk to be at a walkable thing ends on it ([`within_footprint`] with `on`).
pub fn walkable(entry: &replica::rules::json::Value) -> bool {
    use replica::rules::json::Value as J;
    let mm = |v: &J| match v {
        J::Int(n) => i64::try_from(*n).ok(),
        _ => None,
    };
    let place = entry.get("owner").and_then(J::str) == Some("place");
    let stand = match entry.get("areas") {
        Some(J::Obj(areas)) => areas
            .iter()
            .any(|(_, a)| a.get("allows").and_then(|x| x.get("stand")).is_some()),
        _ => false,
    };
    let bounds = entry
        .get("geometry")
        .and_then(|g| g.get("bounds_mm"))
        .and_then(J::arr)
        .and_then(|b| match b {
            [x, y, z] => Some([mm(x)?, mm(y)?, mm(z)?]),
            _ => None,
        });
    // Low, and wide enough to stand on a body's width in from its edge (not a bowl).
    let wide = 2 * ON_DEPTH / 1000;
    let low = bounds.is_some_and(|[x, y, z]| y <= crate::ground::STEP && x >= wide && z >= wide);
    let standing = match (entry.get("slots"), bounds) {
        (Some(J::Obj(slots)), Some([x, _, z])) => slots.iter().any(|(_, s)| {
            let inside = match s.get("at_mm").and_then(J::arr) {
                Some([sx, _, sz]) => {
                    mm(sx).is_some_and(|v| 2 * v.abs() <= x)
                        && mm(sz).is_some_and(|v| 2 * v.abs() <= z)
                }
                _ => false,
            };
            s.get("admits").and_then(J::str) == Some("body") && s.get("posture").is_none() && inside
        }),
        _ => false,
    };
    place || stand || low || standing
}

/// [`within`]'s rings: the place within `reach` of `target` nearest by the asker's walk, or by the gap alone.
fn rings(
    g: &mut dyn Ground,
    target: Target,
    reach: i64,
    from: Option<(Id, Vec3, Vec3)>,
) -> Option<Vec3> {
    let t = target.point();
    // Places by a bound below their cost: the straight way there plus the weighted gap.
    let mut order: Vec<(i64, i64, i64, Vec3)> = Vec::new();
    for ring in 1..=reach / REACH_PITCH {
        let n = 6_283 * ring / 1_000;
        for k in 0..n {
            let off = Quat::from_yaw_mdeg(k * 360_000 / n)
                .and_then(|q| q.rotate(Vec3::new(0, 0, ring * REACH_PITCH)))
                .unwrap_or(Vec3::ZERO);
            let Some((at, world)) = g.stand(target.node, Vec3::new(t.x + off.x, t.y, t.z + off.z))
            else {
                continue;
            };
            if g.passage(target.node, at) {
                continue;
            }
            let gap = WEIGHT * flat(at, t);
            order.push((
                gap + from.map_or(0, |(_, _, a)| flat(world, a)),
                ring,
                k,
                at,
            ));
        }
    }
    order.sort_unstable_by_key(|&(bound, ring, k, _)| (bound, ring, k));
    let Some((node, p, _)) = from else {
        return order.first().map(|o| o.3);
    };
    let mut best: Option<(i64, i64, i64, Vec3)> = None;
    let mut misses = 0;
    for (bound, ring, k, at) in order {
        if best.is_some_and(|b| bound > b.0) {
            break;
        }
        if !g.may_reach(node, p, target.node, at) {
            continue;
        }
        let Some(walk) = g.walk(node, p, target.node, at) else {
            misses += 1;
            if misses >= MISSES_MOST {
                break;
            }
            continue;
        };
        let key = (walk + WEIGHT * flat(at, t), ring, k, at);
        if best.is_none_or(|b| (key.0, key.1, key.2) < (b.0, b.1, b.2)) {
            best = Some(key);
        }
    }
    best.map(|b| b.3)
}

impl Spots {
    pub fn new() -> Spots {
        Spots::default()
    }

    /// Prepared geometry changed; retain shared physical holders until they are revalidated against it.
    pub fn invalidate_geometry(&mut self) {
        self.owners.clear();
        self.sized.clear();
        self.overflow.clear();
        self.refused.clear();
        self.invalid_geometry = true;
    }

    /// The table of `target`, if its owner has made one.
    pub fn table(&self, target: &Target) -> Option<&Table> {
        self.owners.get(&target.node)?.get(&target.at)
    }

    /// What `who`, asking for `target`, was given: the place to stand (µm, the target node's frame) or a refusal's
    /// name; `None` until its ask is read.
    pub fn of(&self, who: Id, target: &Target) -> Option<Result<Vec3, &'static str>> {
        self.granted(who, target).map(|r| r.map(|g| g.at))
    }

    /// The askers whose place a change of the ground took away since the last call (A2-5's review): each lets go of
    /// its grant and is planned again from the place it is granted next.
    pub fn revoked(&mut self) -> Vec<Id> {
        std::mem::take(&mut self.revoked)
    }

    /// As [`Spots::of`], with the node the place stands on and whether it is an overflow point (A2-5).
    pub fn granted(&self, who: Id, target: &Target) -> Option<Result<Granted, &'static str>> {
        if let Some(held) = self.held.get(&who)
            && &held.target == target
        {
            return Some(Ok(Granted {
                node: held.node,
                at: held.at,
                overflow: held.overflow.is_some(),
            }));
        }
        match self.refused.get(&who) {
            Some((t, _, name)) if t == target => Some(Err(*name)),
            _ => None,
        }
    }

    /// The owners read the asks of the last tick (in id order) and write their tables for world time `at`: release
    /// what no ask holds any more, then grant each new ask its nearest free place.
    pub fn write(&mut self, g: &mut dyn Ground, asks: &[Ask], at: Micros) -> Result<(), Refusal> {
        self.write_sized(
            &mut Standard(g),
            &asks
                .iter()
                .map(|a| (*a, Size::Standard))
                .collect::<Vec<_>>(),
            at,
        )
    }

    /// One release/grant pass in the existing caller order, with shared physical occupancy across class caches.
    pub fn write_sized(
        &mut self,
        grounds: &mut dyn ClassGround,
        asks: &[(Ask, Size)],
        at: Micros,
    ) -> Result<(), Refusal> {
        if self.invalid_geometry {
            let holders: Vec<_> = self.held.iter().map(|(&id, &h)| (id, h)).collect();
            for (who, h) in holders {
                let selected = Selected {
                    ground: grounds,
                    size: h.size,
                };
                let table = if h.size == Size::Standard {
                    self.owners
                        .entry(h.target.node)
                        .or_default()
                        .entry(h.target.at)
                        .or_insert_with(|| Table::new(&selected, h.target))
                } else {
                    self.sized
                        .entry((h.size, h.target))
                        .or_insert_with(|| Table::new(&selected, h.target))
                };
                // An overflow point is kept as any place is: found again, on its node, in the rebuilt rounds (A2-5).
                let kept = match h.overflow {
                    None => table.places.iter().position(|p| p.at == h.at).map(|index| {
                        table.places[index].holder = Some(who);
                        Held { index, ..h }
                    }),
                    Some(_) => {
                        let rounds = self
                            .overflow
                            .entry((h.size, h.target))
                            .or_insert_with(|| Table::rounds(&selected, h.target, table));
                        rounds.iter_mut().enumerate().find_map(|(k, (r, tb))| {
                            let index = tb.places.iter().position(|p| p.at == h.at)?;
                            (r.centre.node == h.node).then(|| {
                                tb.places[index].holder = Some(who);
                                Held {
                                    index,
                                    overflow: Some(k),
                                    ..h
                                }
                            })
                        })
                    }
                };
                match kept {
                    Some(held) => {
                        self.held.insert(who, held);
                    }
                    None => {
                        self.held.remove(&who);
                        self.revoked.push(who);
                        self.record.push(Entry::Release {
                            at,
                            who,
                            target: h.target,
                            place: h.place,
                            why: "ground-changed",
                        });
                    }
                }
            }
            self.invalid_geometry = false;
        }
        let asking: BTreeMap<Id, (&Ask, Size)> =
            asks.iter().map(|(a, size)| (a.who, (a, *size))).collect();
        let gone: Vec<(Id, &'static str)> = self
            .held
            .iter()
            .filter_map(|(who, held)| match asking.get(who) {
                None => Some((*who, "order-ended")),
                Some((a, _)) if a.target != held.target => Some((*who, "spot-left")),
                Some((_, size)) if *size != held.size => Some((*who, "body-class-changed")),
                Some(_) => None,
            })
            .collect();
        let mut refused = None;
        // Overflow points chosen in this pass (A2-5): a burst beyond [`OVERFLOW_EACH`] waits for the next pass.
        let mut overflowed = 0;
        for (who, why) in gone {
            let held = self.held.remove(&who).expect("held");
            let table = if let Some(k) = held.overflow {
                self.overflow
                    .get_mut(&(held.size, held.target))
                    .and_then(|o| o.get_mut(k).map(|(_, tb)| tb))
            } else if held.size == Size::Standard {
                self.owners
                    .get_mut(&held.target.node)
                    .and_then(|m| m.get_mut(&held.target.at))
            } else {
                self.sized.get_mut(&(held.size, held.target))
            };
            let Some(p) = table.and_then(|tb| tb.places.get_mut(held.index)) else {
                refused.get_or_insert(Refusal {
                    name: "spot-table-missing",
                    detail: show(held.target.node),
                });
                continue;
            };
            p.holder = None;
            self.record.push(Entry::Release {
                at,
                who,
                target: held.target,
                place: (p.ring, p.k),
                why,
            });
        }
        self.refused.retain(|who, (t, size, _)| {
            asking
                .get(who)
                .is_some_and(|(a, s)| a.target == *t && s == size)
        });
        for (a, size) in asks {
            if self.held.contains_key(&a.who) || self.refused.contains_key(&a.who) {
                continue;
            }
            // Carried by the world (part way up a stair, #4171; stepping off a bench, still at the seat's point) the
            // asker may be on no piece of ground, and every place would be refused `spot-none-free` though none is
            // held. It is asked again each tick and answered once it lands.
            if a.carried {
                continue;
            }
            let t = a.target;
            let mut g = Selected {
                ground: grounds,
                size: *size,
            };
            let tb = if *size == Size::Standard {
                self.owners
                    .entry(t.node)
                    .or_default()
                    .entry(t.at)
                    .or_insert_with(|| Table::new(&g, t))
            } else {
                self.sized
                    .entry((*size, t))
                    .or_insert_with(|| Table::new(&g, t))
            };
            // Standard/standard keeps the existing exact table policy. Every pair involving another class
            // must retain the existing standard clearance beyond the sum of its admitted radii.
            let blocked = tb
                .places
                .iter()
                .enumerate()
                .filter_map(|(i, p)| {
                    self.held
                        .values()
                        .any(|h| {
                            // A body on an overflow point keeps its space from every table's places (A2-5).
                            if h.overflow.is_some() {
                                let c = (size.radius_mm() + h.size.radius_mm() + 140) * 1000;
                                return (h.world.y - p.world.y).abs() < LEVEL
                                    && flat(h.world, p.world) < c;
                            }
                            if h.target.node != t.node
                                || (*size == Size::Standard && h.size == Size::Standard)
                            {
                                return false;
                            }
                            let clearance = (size.radius_mm() + h.size.radius_mm() + 140) * 1000;
                            let dx = i128::from(p.world.x - h.world.x);
                            let dz = i128::from(p.world.z - h.world.z);
                            dx * dx + dz * dz < i128::from(clearance) * i128::from(clearance)
                        })
                        .then_some(i)
                })
                .collect();
            // The target's own places all held or out of reach: the nearest free overflow point round it (A2-5).
            let mut found = tb
                .nearest(&mut g, a, &blocked)
                .map(|(i, cost)| (i, cost, None));
            if found == Err("spot-none-free") && tb.crowded(&mut g, a, &blocked) {
                // A burst of overflow asks (a crowd moment) is spread over passes: each choice costs route searches,
                // and with a planner every other answer of the batch waits for them. The rest are answered next pass,
                // none refused (A2-5's review).
                if overflowed >= OVERFLOW_EACH {
                    continue;
                }
                overflowed += 1;
                let rounds = self
                    .overflow
                    .entry((*size, t))
                    .or_insert_with(|| Table::rounds(&g, t, tb));
                if let Some((_, asker)) = g.stand(a.node, a.from) {
                    let r = (*size).radius_mm();
                    // Each ground round it in turn: the bodies holding a place near it, and how far each keeps others.
                    for (k, (round, otb)) in rounds.iter_mut().enumerate() {
                        // Every body that could keep a point within OVERFLOW off: the widest room two bodies keep.
                        let reach = OVERFLOW
                            + Size::ALL
                                .iter()
                                .map(|z| (2 * z.radius_mm() + 140) * 1000)
                                .max()
                                .unwrap_or(0);
                        let held: Vec<(Vec3, i64)> = self
                            .held
                            .values()
                            .filter(|h| flat(h.world, round.centre_world) <= reach)
                            .map(|h| (h.world, (r + h.size.radius_mm() + 140) * 1000))
                            .collect();
                        if let Some((i, cost)) = otb.nearest_round(&mut g, a, asker, round, &held) {
                            found = Ok((i, cost, Some(k)));
                            break;
                        }
                    }
                }
            }
            match found {
                Ok((i, cost, overflow)) => {
                    let (node, p) = match overflow {
                        Some(k) => {
                            let (r, otb) = &mut self
                                .overflow
                                .get_mut(&(*size, t))
                                .expect("the overflow tables")[k];
                            (r.centre.node, &mut otb.places[i])
                        }
                        None => {
                            let tb = if *size == Size::Standard {
                                self.owners.get_mut(&t.node).and_then(|m| m.get_mut(&t.at))
                            } else {
                                self.sized.get_mut(&(*size, t))
                            };
                            (t.node, &mut tb.expect("the table").places[i])
                        }
                    };
                    p.holder = Some(a.who);
                    self.held.insert(
                        a.who,
                        Held {
                            target: t,
                            index: i,
                            size: *size,
                            at: p.at,
                            world: p.world,
                            place: (p.ring, p.k),
                            node,
                            overflow,
                        },
                    );
                    self.record.push(Entry::Grant {
                        at,
                        who: a.who,
                        target: t,
                        place: (p.ring, p.k),
                        to: p.at,
                        cost,
                        cause: Cause::Intent(a.order),
                        actor: Actor::World,
                    });
                }
                Err(name) => {
                    self.refused.insert(a.who, (t, *size, name));
                    self.record.push(Entry::Refuse {
                        at,
                        who: a.who,
                        target: t,
                        name,
                    });
                }
            }
        }
        refused.map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests;
