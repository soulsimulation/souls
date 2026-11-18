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
//! Refusals: `spot-none-near` (no walkable place on the rings), `spot-none-free` (every place held or out of reach).
//! Not here: seats (B3), facing (B11), formations and conversation circles, spots described in words (E2), perches
//! and staying in a doorway or on a stair (E3), spots by a thing's kind (K3).

use replica::effects::{Actor, Cause, Refusal};
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::time::Micros;
use replica::world_model::show;
use std::collections::BTreeMap;

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
    held: BTreeMap<Id, (Target, usize)>,
    /// Per asker: the target it was refused, and the refusal's name.
    refused: BTreeMap<Id, (Target, &'static str)>,
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
    fn nearest(&mut self, g: &mut dyn Ground, ask: &Ask) -> Result<(usize, i64), &'static str> {
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
            .filter(|(_, p)| p.holder.is_none())
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

impl Spots {
    pub fn new() -> Spots {
        Spots::default()
    }

    /// The table of `target`, if its owner has made one.
    pub fn table(&self, target: &Target) -> Option<&Table> {
        self.owners.get(&target.node)?.get(&target.at)
    }

    /// What `who`, asking for `target`, was given: the place to stand (µm, the target node's frame) or a refusal's
    /// name; `None` until its ask is read.
    pub fn of(&self, who: Id, target: &Target) -> Option<Result<Vec3, &'static str>> {
        if let Some((t, i)) = self.held.get(&who)
            && t == target
        {
            return self.table(t).map(|tb| Ok(tb.places[*i].at));
        }
        match self.refused.get(&who) {
            Some((t, name)) if t == target => Some(Err(*name)),
            _ => None,
        }
    }

    /// The owners read the asks of the last tick (in id order) and write their tables for world time `at`: release
    /// what no ask holds any more, then grant each new ask its nearest free place.
    pub fn write(&mut self, g: &mut dyn Ground, asks: &[Ask], at: Micros) -> Result<(), Refusal> {
        let asking: BTreeMap<Id, &Ask> = asks.iter().map(|a| (a.who, a)).collect();
        // Releases: the holder asks for another target or none (it left), or has no mark (its order ended).
        let gone: Vec<(Id, &'static str)> = self
            .held
            .iter()
            .filter_map(|(who, (t, _))| match asking.get(who) {
                None => Some((*who, "order-ended")),
                Some(a) if a.target != *t => Some((*who, "spot-left")),
                Some(_) => None,
            })
            .collect();
        for (who, why) in gone {
            let (t, i) = self.held.remove(&who).expect("held");
            let p = self
                .owners
                .get_mut(&t.node)
                .and_then(|o| o.get_mut(&t.at))
                .map(|tb| &mut tb.places[i])
                .ok_or_else(|| Refusal {
                    name: "spot-table-missing",
                    detail: show(t.node),
                })?;
            p.holder = None;
            self.record.push(Entry::Release {
                at,
                who,
                target: t,
                place: (p.ring, p.k),
                why,
            });
        }
        self.refused
            .retain(|who, (t, _)| asking.get(who).is_some_and(|a| a.target == *t));
        // Grants, in id order, to each ask not yet answered.
        for a in asks {
            if self.held.contains_key(&a.who) || self.refused.contains_key(&a.who) {
                continue;
            }
            let t = a.target;
            let tb = self
                .owners
                .entry(t.node)
                .or_default()
                .entry(t.at)
                .or_insert_with(|| Table::new(g, t));
            match tb.nearest(g, a) {
                Ok((i, cost)) => {
                    let p = &mut tb.places[i];
                    p.holder = Some(a.who);
                    self.held.insert(a.who, (t, i));
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
                    self.refused.insert(a.who, (t, name));
                    self.record.push(Entry::Refuse {
                        at,
                        who: a.who,
                        target: t,
                        name,
                    });
                }
            }
        }
        Ok(())
    }
}
