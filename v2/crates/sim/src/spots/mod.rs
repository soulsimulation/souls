//! Standing spots, approach, and a crowd around a point (Engine v2 N9, #2678): each body sent to a point gets its
//! own legal place to stand near it, so thirty sent to one point form a crowd, not a knot.
//!
//! - **Places.** Round a target, on rings [`PITCH`] apart out to [`RINGS`] of them, `⌊2πk⌋` places on ring `k` (so
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
//!   ground) is bound to the nearest clear place beside it the same way.
//! - **Recorded as the engine's.** Each grant is an [`Entry::Grant`] with the actor the world and the cause the
//!   asker's order; the same marks give the same grants every run (integers, id order, no hashing).
//! - **Released** when its holder no longer asks for it: it left (its mark asks for another target or none,
//!   `spot-left`) or its order ended (no mark, `order-ended`).
//!
//! - **A place to act from** (C15, #3447, [`within`]). A form's walk to a point a body cannot stand on goes to the
//!   nearest place within the body's reach of it, by the same rule on finer rings ([`REACH_PITCH`]), held by no one:
//!   the act is brief, and the walk keeps bodies apart.
//!
//! Refusals: `spot-none-near` (no walkable place on the rings), `spot-none-free` (every place held or out of reach).
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
/// The weight of a place's straight gap to the target against the walk to it.
pub const WEIGHT: i64 = 3;
/// A place is joined to a clear target when walked to from it within this many times their straight gap, plus a pitch.
pub const DETOUR: i64 = 2;

/// The ground as the spot tables read it. All µm.
pub trait Ground {
    /// Where a body may stand at `p` on `node`: the point on its walkable ground there, and that point in the ground's
    /// frame; `None` off it.
    fn stand(&self, node: Id, p: Vec3) -> Option<(Vec3, Vec3)>;
    /// Whether `p` on `node` lies in a doorway or on a stair.
    fn passage(&self, node: Id, p: Vec3) -> bool;
    /// The walking distance from `a` on node `an` to `b` on node `bn`, never through a wall; `None` with no way there.
    fn walk(&mut self, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64>;
}

/// The same geometry questions selected for one admitted footprint. Reservations are never stored here.
pub trait ClassGround {
    fn stand(&self, size: Size, node: Id, p: Vec3) -> Option<(Vec3, Vec3)>;
    fn passage(&self, size: Size, node: Id, p: Vec3) -> bool;
    fn walk(&mut self, size: Size, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64>;
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

/// An asker, as its mark of the last tick says: where it stands (µm, its node's frame), what it asks, for which order.
#[derive(Clone, Copy, Debug)]
pub struct Ask {
    pub who: Id,
    pub order: Id,
    pub node: Id,
    pub from: Vec3,
    pub target: Target,
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
}

#[derive(Clone, Copy)]
struct Held {
    target: Target,
    index: usize,
    size: Size,
    at: Vec3,
    world: Vec3,
    place: (u16, u16),
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
    /// The places round `target`: on walkable ground, out of doorways and off stairs.
    pub fn new(g: &dyn Ground, target: Target) -> Table {
        let t = target.point();
        let mut places = Vec::new();
        for ring in 0..=RINGS {
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
        for (bound, ring, k, i) in order {
            if best.is_some_and(|b| bound > b.0) {
                break;
            }
            if self.clear && !self.joined(g, t, i) {
                continue;
            }
            let Some(walk) = g.walk(ask.node, ask.from, t.node, self.places[i].at) else {
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

/// Where a body may stand to act at `target` (C15, #3447): the target itself when a body may stand there; else the
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
    if g.stand(target.node, t).is_some() {
        return Some(t);
    }
    let from = from.and_then(|(node, p)| Some((node, p, g.stand(node, p)?.1)));
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
    for (bound, ring, k, at) in order {
        if best.is_some_and(|b| bound > b.0) {
            break;
        }
        let Some(walk) = g.walk(node, p, target.node, at) else {
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
        if let Some(held) = self.held.get(&who)
            && &held.target == target
        {
            return Some(Ok(held.at));
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
                match table.places.iter().position(|p| p.at == h.at) {
                    Some(index) => {
                        table.places[index].holder = Some(who);
                        self.held.insert(who, Held { index, ..h });
                    }
                    None => {
                        self.held.remove(&who);
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
        for (who, why) in gone {
            let held = self.held.remove(&who).expect("held");
            let table = if held.size == Size::Standard {
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
            match tb.nearest(&mut g, a, &blocked) {
                Ok((i, cost)) => {
                    let p = &mut tb.places[i];
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
