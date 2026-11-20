//! Postures and seats (Engine v2 B3, #2682): a body sits, lies and rises by moves (B2's data) that hand it between the
//! floor and a seat's slot through the controller, and a seat holds one body.
//!
//! - **A seat** is one slot of a thing, with its kind's data ([`replica::moves::Place`]): the slot's height above the
//!   floor from the kind's model geometry, and a stand point. A seat higher than the move's reach (the body's standing
//!   reach) is refused `place-out-of-reach`, by its height alone.
//! - **Reserved at commit.** The requests of one tick are taken together ([`Slots::commit`]) and ordered by a stable
//!   key, the body's id and then the seat's, never by arrival. The first takes the seat; every later one is refused
//!   `place-taken`, naming the holder. The hold is a field of this table, keyed by the seat's thing and slot, so the
//!   holder is one lookup and never a scan.
//! - **A thing with several seats** (C19, #3457): a sofa's three, a bed's two sides, a bench's two. Each is its own
//!   place, keyed by (thing, slot). A request naming a slot takes that one; a request naming only the thing takes the
//!   free slot whose stand point is nearest the body (ties by slot number), picked in the tick's stable order, so three
//!   bodies asking for one sofa in one tick each get their own slot and a fourth is refused `place-taken`, naming the
//!   holders.
//! - **Contact hands the body over.** At the sit's (or lie's) contact instant the body is handed from the floor into
//!   the slot ([`Controller::slot_in`], T4's hand-off from mover to slot) with the stance the request named; at the rise's
//!   contact it is handed back onto the floor at the seat's stand point ([`Controller::stand`]), standing. Postures
//!   are the controller's stance input: stand, sit, lie.
//! - **A seated body has no timer and no mover.** When the move is done, a driver with no timer ([`seated_shape`])
//!   holds its legs and its stance, and the controller's tick never visits it.
//! - **The engine releases the seat**, never the skill: when the holder rises (at the rise's contact), and when the
//!   sit is cancelled before contact (a later claim on its legs, `claim-taken`). A body is never left stuck: when a
//!   later claim cancels a sit after contact, or a rise before it, the body is handed back onto the floor at the stand
//!   point under that claim's driver and the seat is released, since a tick never steps a body in a slot.
//! - **Rising onto a taken spot.** The stand point may be taken: [`clear_spot`] finds the nearest clear point, and the
//!   body walks there by the mover. It never appears there.
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
use replica::moves::{Move, Place};
use replica::pose::{Frame, HandOff, Quat, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::show;

use crate::controller::{Controller, Driver, Part, Stance};
use crate::mover::Surface;
use crate::moves::{Fired, Instance, Moves, Reach};
use crate::timers::{DueList, Timer};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
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
}

impl PlaceAt {
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

/// Every seat, and who holds each.
#[derive(Default)]
pub struct Slots {
    places: BTreeMap<Key, PlaceAt>,
    held: BTreeMap<Key, Hold>,
    by_body: BTreeMap<Id, Key>,
    changed: Vec<Id>,
}

impl Slots {
    pub fn new() -> Slots {
        Slots::default()
    }

    /// Seat ownership changes, drained by the world to wake standing queues.
    pub fn changes(&mut self) -> Vec<Id> {
        std::mem::take(&mut self.changed)
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

    /// Who holds the seat of `thing` in `slot`: one lookup.
    pub fn holder_in(&self, thing: Id, slot: u64) -> Option<Id> {
        self.held.get(&(thing, slot)).map(|h| h.body)
    }

    /// Everyone holding a seat of `thing`, by slot.
    pub fn holders(&self, thing: Id) -> Vec<Id> {
        self.held
            .range((thing, 0)..=(thing, u64::MAX))
            .map(|(_, h)| h.body)
            .collect()
    }

    /// The free slot of `thing` whose stand point is nearest where `body` stands (x and z), ties by slot number: the
    /// one a request naming only the thing takes (C19, #3457). None when every slot is held or it has none.
    pub fn free(&self, c: &Controller, body: Id, thing: Id) -> Option<u64> {
        let from = c.body(body).map_or(Vec3::ZERO, |b| b.pose.position);
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        self.places_of(thing)
            .filter(|p| !self.held.contains_key(&(thing, p.place.slot)))
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
        self.places.get(self.by_body.get(&body)?)
    }

    /// Releases the seat `body` holds (a retirement, K10 #2673): the seat's thing, and the sit or rise under way.
    pub fn release_body(&mut self, body: Id) -> Option<(Id, Option<Instance>)> {
        let key = self.by_body.remove(&body)?;
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
        requests: &[Request],
        now: Micros,
    ) -> Vec<(Id, R<Instance>)> {
        let mut order: Vec<&Request> = requests.iter().collect();
        order.sort_by_key(|r| (r.body, r.thing, r.slot));
        order
            .into_iter()
            .map(|r| (r.body, self.take(c, due, mint, moves, geo, r, now)))
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
        r: &Request,
        now: Micros,
    ) -> R<Instance> {
        let slot = match r.slot {
            Some(s) => s,
            None => match self.free(c, r.body, r.thing) {
                Some(s) => s,
                None if self.place(r.thing).is_none() => {
                    return refuse("place-unknown", show(r.thing));
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
        if let Some(h) = self.held.get(&key) {
            return refuse(
                "place-taken",
                format!("{}: held by {}", show(r.thing), show(h.body)),
            );
        }
        if let Some(t) = self.by_body.get(&r.body) {
            return refuse(
                "place-already-held",
                format!("{} holds {}", show(r.body), show(t.0)),
            );
        }
        if at.place.height > r.mv.reach {
            return refuse(
                "place-out-of-reach",
                format!(
                    "{}: {} µm above the floor, standing reach {} µm",
                    show(r.thing),
                    at.place.height,
                    r.mv.reach
                ),
            );
        }
        let instance = moves.start(c, due, mint, geo, r.body, r.mv, r.thing, now)?;
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

    /// A restart (K18c, #3176): `body`, standing on the floor, is handed back into the seat of `thing` in `slot` (its
    /// lowest when none is named) at `at`, held there in `stance` by a driver with no timer, as a sit that finished
    /// leaves it. The hold is this table's again, so a rise or another sit sees the seat taken. `place-unknown`,
    /// `place-taken` or `place-already-held` as for a sit.
    pub fn restore(
        &mut self,
        c: &mut Controller,
        body: Id,
        (thing, slot): (Id, Option<u64>),
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
        let key = (thing, place.place.slot);
        if let Some(h) = self.held.get(&key) {
            return refuse(
                "place-taken",
                format!("{}: held by {}", show(thing), show(h.body)),
            );
        }
        if self.by_body.contains_key(&body) {
            return refuse("place-already-held", show(body));
        }
        let frame = Frame {
            node: thing,
            slot: Some(place.place.slot),
        };
        let d = c.claim(body, &seated_shape())?;
        c.slot_in(body, d, frame, at)?;
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
        if let Some(d) = driver {
            c.release(body, d)?;
        }
        match moves.start(c, due, mint, geo, body, mv, key.0, now) {
            Ok(n) => {
                if let Some(d) = moves.driver(n) {
                    c.set(body, d, Part::Stance(hold.stance))?;
                }
                self.set(key, State::Rising(n));
                Ok(n)
            }
            Err(r) => {
                self.sit_still(c, key);
                Err(r)
            }
        }
    }

    fn set(&mut self, key: Key, state: State) {
        if let Some(h) = self.held.get_mut(&key) {
            h.state = state;
        }
    }

    fn release(&mut self, key: Key) {
        if let Some(h) = self.held.remove(&key) {
            self.by_body.remove(&h.body);
            self.changed.push(key.0);
        }
    }

    /// The body stays in the slot with no move: a driver with no timer holds its legs and its stance, if it can.
    fn sit_still(&mut self, c: &mut Controller, key: Key) {
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
        key: Key,
        now: Micros,
    ) -> Option<R<HandOff>> {
        let h = self.held.get(&key).copied()?;
        if h.state != State::Seated(None) {
            return None;
        }
        let claims = c.claims(h.body)?;
        let leg = claims
            .family()
            .resources
            .iter()
            .find(|r| r.class == Class::Locomotion)?;
        let d = claims.holder(&leg.name)?;
        let handed = self.stand(c, at, floors, h.body, d, now);
        if handed.is_ok() {
            let _ = c.set(h.body, d, Part::Stance(Stance::Stand));
            self.release(key);
        }
        Some(handed)
    }

    /// Runs a due timer through [`Moves::fire`], then does what it means for a seat: at a sit's contact the body is
    /// handed into the slot, at a rise's onto the floor at the stand point (its surface in `floors`) and the seat is
    /// released; a sit done leaves it seated; a sit cancelled before contact releases the seat. Returns what the move
    /// did and the hand-off made, or why it could not be (the rise is then cancelled and the body stays seated).
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
            self.places.get(&key)?.clone(),
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
                    .slot_in(body, d, frame, now)
                    .and_then(|h| c.set(body, d, Part::Stance(hold.stance)).map(|()| h));
                if h.is_ok() {
                    self.set(
                        key,
                        State::Lowering {
                            instance,
                            in_slot: true,
                        },
                    );
                }
                Some(h)
            }
            (Fired::Phase { phase: 1, .. }, State::Rising(_)) => {
                let d = moves.driver(instance).unwrap_or(0);
                let h = self.stand(c, &at, floors, body, d, now);
                match &h {
                    Ok(_) => {
                        let _ = c.set(body, d, Part::Stance(Stance::Stand));
                        self.release(key);
                    }
                    Err(_) => {
                        moves.cancel(c, due, instance, now, lit("stand-point-off-floor"));
                        self.sit_still(c, key);
                    }
                }
                Some(h)
            }
            (Fired::Done(_), State::Lowering { .. }) => {
                self.sit_still(c, key);
                None
            }
            (Fired::Cancelled(_), State::Lowering { in_slot: false, .. }) => {
                self.release(key);
                None
            }
            (Fired::Cancelled(_), _) => {
                self.sit_still(c, key);
                self.give_way(c, &at, floors, key, now)
            }
            _ => None,
        };
        Some((fired, handed))
    }

    fn stand(
        &self,
        c: &mut Controller,
        at: &PlaceAt,
        floors: &dyn crate::mover::Floors,
        body: Id,
        driver: Driver,
        now: Micros,
    ) -> R<HandOff> {
        let build = c.build(body).ok_or_else(|| Refusal {
            name: "body-missing",
            detail: show(body),
        })?;
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
        let placed = floor.place_built(body, frame, at.stand()?, at.facing, build)?;
        c.stand(body, driver, placed, now)
    }
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
