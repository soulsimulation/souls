//! `part:raise` and `part:lower` (#5067): a crew of two tilts a lying part up about its foot until it stands, held, and
//! lays a standing one down again. The rule is `sim::activity::carry::raise` (the scripted build's `raise.ts`).
//!
//! - **Who does what.** The Soul who asks is the lifter; the other member is the footer. The lifter stands beside the
//!   part's top end (to raise) or beside its base (to lower), the footer beside the base on the other side; each must
//!   reach its hold there or the act is refused `part.grip-out-of-reach`, naming it, before anything is written.
//! - **The commit** is a take's (`Assembly::pivot`): the crew's node is set at the part's foot, turned as the part
//!   is, and the part rides its slot, so nothing moves. The intent is answered then.
//! - **The track.** The world walks the lifter beside the part at `raise::PACE`, over ground checked for its body
//!   before it starts. Each tick the part is raised toward where the lifter has come ([`Raise::node`]), at most
//!   `raise::FOLLOW` and `raise::TURN` a tick: one motion sample of the crew's node, its position the foot (which never moves on the
//!   plan), its turn about the base line. A carrier who no longer reaches its hold turns a raise back: the lifter is
//!   walked back and the part laid down where it lay.
//! - **The end.** Standing, the part is put on the ground at its foot with its crew holding it (their node under it,
//!   `souls:held`): never free. That is a seating's commit, through the walkers' maps; refused there, the raise turns
//!   back. Lying, it is put where it lies and let go, as a carry sets its load down. A part that has not moved for
//!   [`STILL`] ticks goes on by itself, so a track always ends and its crew can leave.
//! - **Words.** `souls:carry-track` with `souls:raise` or `souls:lower` at the start (a raise turned back says
//!   `souls:lower` with why), `souls:raised` or `souls:lowered` at the end; `souls:carry-grips` in the phase
//!   `souls:raise` or `souls:lower`, then `souls:held` or `souls:released`.
//! - Not kept across a restart: a part found riding its crew's slot is set down as a carry's load is.

use replica::effects::{Actor, Cause};
use replica::ids::Id;
use replica::pose::Vec3;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{plain, show};
use sim::activity::carry::Carry;
use sim::activity::carry::grips::{self, Hold, Holds};
use sim::activity::carry::raise::{PACE, Raise};
use sim::controller::{Controller, Track};
use sim::ground::scene::xform_to;
use sim::slots::Slots;

use super::{
    Act, Engine, R, Verb, apart, face_holds, param_id, param_point, refusal, regrip, stands,
    way_is_ground,
};
use crate::assembly::{Carrier, Ready, Step, out_of_reach};

/// The grips' phase while a part is raised, and while it is lowered.
pub const RAISE: &str = "souls:raise";
pub const LOWER: &str = "souls:lower";
/// How near its end the lifter's walk has to come for the part to finish its turn, µm.
const NEAR: i64 = 60_000;
/// How many ticks a part may stay still on its way before it goes on without its lifter.
const STILL: u32 = 100;
/// Half the distance between a carrier's two hands along its post, µm.
const HAND_HALF: i64 = 100_000;

/// A part on its way up or down.
pub struct Raising {
    geo: Raise,
    part: Id,
    ground: Id,
    lifter: Id,
    footer: Id,
    /// Toward standing; else toward lying.
    up: bool,
    /// How far the part is raised: where its lifter is taken to be, µm from the base line ([`Raise::node`]).
    r: i64,
    /// The intent and the Soul that asked.
    by: (Id, Id),
    /// The crew's standing reach, µm.
    reach: i64,
    /// The node's writer, once the take is committed.
    carry: Option<Carry>,
    /// Whether the world has started the lifter's walk this way.
    walking: bool,
    /// Whether its end's commit is out, and for how many ticks it has not moved.
    settling: bool,
    still: u32,
    /// When its track began.
    since: Micros,
    /// The grip the lifter is said to hold: the kind's highest, its name and its point (the foot when it names none).
    grip: (String, Vec3),
}

impl Raising {
    fn goal(&self) -> i64 {
        if self.up { 0 } else { self.geo.spec.height }
    }

    /// The lifter and the footer where they stand, each with its hold now.
    fn carriers(&self, lifter: Vec3, footer: Vec3) -> R<[Carrier; 2]> {
        let h = self.geo.holds(self.r)?;
        Ok([
            Carrier {
                body: self.lifter,
                feet: lifter,
                reach: self.reach,
                grip: h[0],
            },
            Carrier {
                body: self.footer,
                feet: footer,
                reach: self.reach,
                grip: h[1],
            },
        ])
    }
}

impl Engine {
    /// The act `part:raise` (parameter 1 the part, lying on the crew's ground) or `part:lower` (the part the crew
    /// holds standing, or parameter 1; parameter 3 a direction on the plan to lay it toward, its own front when none),
    /// on `tree`. See the module's notes.
    pub(super) fn raise_act(
        &mut self,
        tree: &mut Tree,
        c: &Controller,
        slots: &Slots,
        town: &sim::walk::town::Town,
        a: &Act,
        now: Micros,
    ) -> R<()> {
        let up = a.verb == Verb::Raise;
        let activity = a
            .target
            .ok_or_else(|| refusal("part-needs-a-crew", "a target node"))?;
        if self.carries.contains_key(&activity) || self.raising.contains_key(&activity) {
            return Err(refusal("part.held", show(activity)));
        }
        let members: Vec<Id> = self
            .activities
            .members(activity)
            .ok_or_else(|| refusal("activity-missing", show(activity)))?
            .iter()
            .map(|m| m.body)
            .collect();
        if !members.contains(&a.body) {
            return Err(refusal("not-a-member", show(a.body)));
        }
        let held = tree
            .handle(activity)
            .and_then(|h| tree.node(h))
            .and_then(|n| n.parent());
        let part = match (a.params.contains_key(&1), up) {
            (true, _) => param_id(&a.params, 1, "raise-needs-a-part")?,
            (false, false) => held.ok_or_else(|| refusal("raise-needs-a-part", "parameter 1"))?,
            (false, true) => return Err(refusal("raise-needs-a-part", "parameter 1: a part")),
        };
        let node = tree
            .handle(part)
            .and_then(|h| tree.node(h))
            .ok_or_else(|| refusal("part-missing", show(part)))?;
        let spec = self
            .raise_specs
            .get(plain(node.kind().as_str()))
            .copied()
            .ok_or_else(|| {
                refusal(
                    "raise.no-foot",
                    format!("{} names no foot to turn about", show(part)),
                )
            })?;
        let grip = self
            .grips
            .get(plain(node.kind().as_str()))
            .and_then(|g| g.iter().max_by_key(|g| g.at.y))
            .map_or(("foot".to_owned(), Vec3::ZERO), |g| (g.name.clone(), g.at));
        let n = members.len() as u64;
        if n < spec.crew.max(2) {
            return Err(refusal(
                "raise.crew-too-small",
                format!("{n} at {}; it takes {}", show(part), spec.crew.max(2)),
            ));
        }
        if n > 2 {
            return Err(refusal(
                "raise.crew-too-large",
                format!(
                    "{n} at {}; a footer and a lifter turn it, two in all",
                    show(part)
                ),
            ));
        }
        let lifter = a.body;
        let footer = members
            .iter()
            .copied()
            .find(|b| *b != lifter)
            .ok_or_else(|| refusal("crew.size", show(activity)))?;
        let ((ground, lf), (other, ff)) = (stands(c, lifter)?, stands(c, footer)?);
        if other != ground {
            return Err(refusal(
                "raise.crew-apart",
                format!("{} and {} stand on two grounds", show(lifter), show(footer)),
            ));
        }
        // On the crew's own ground: lying there to be raised, standing there to be lowered.
        if node.parent() != Some(ground) {
            let (name, how) = match up {
                true => ("raise.not-lying", "lies"),
                false => ("raise.not-standing", "stands"),
            };
            return Err(refusal(
                name,
                format!("{} {how} on nothing its crew stands on", show(part)),
            ));
        }
        let at = tree
            .handle(part)
            .zip(tree.handle(ground))
            .ok_or_else(|| refusal("part-missing", show(part)))
            .and_then(|(p, g)| xform_to(tree, p, g).map_err(|e| refusal("part-pose", e)))?;
        let toward = param_point(&a.params, 3, "lower-toward")?.map(|v| [v.x, v.z]);
        let geo = match up {
            true => Raise::up(spec, at.pos, at.rot, lf)?,
            false => Raise::down(spec, at.pos, at.rot, toward, lf)?,
        };
        let mut ra = Raising {
            geo,
            part,
            ground,
            lifter,
            footer,
            up,
            r: if up { spec.height } else { 0 },
            by: (a.id, a.soul),
            reach: slots.reach_of(lifter).min(slots.reach_of(footer)),
            carry: None,
            walking: false,
            settling: false,
            still: 0,
            since: now,
            grip,
        };
        // Each reaches its hold from where it stands, or is named.
        out_of_reach(&ra.carriers(lf, ff)?, ra.geo.node(ra.r)?)?;
        // The lifter's walk beside the part, over ground its body stands on, all the way.
        let end = ra.geo.lifter_at(ra.goal());
        if c.carried(lifter) || !way_is_ground(c, town, ground, lifter, lf, end) {
            return Err(refusal(
                "raise.way-blocked",
                format!(
                    "{} has no ground to walk beside {} to ({}, {}) mm",
                    show(lifter),
                    show(part),
                    end.x / 1000,
                    end.z / 1000
                ),
            ));
        }
        let asm = self
            .asm
            .as_mut()
            .ok_or_else(|| refusal("seating-off", "the world's kinds join no parts"))?;
        asm.pivot(
            tree,
            &self.activities,
            &mut self.mint,
            now,
            ra.by,
            activity,
            part,
            ground,
        )?;
        ra.since = now;
        self.raising.insert(activity, ra);
        Ok(())
    }

    /// The holds of a part on its way, said in `phase`: the lifter's post where it holds it now, the footer's near the
    /// foot, each with two hands a hand's width apart along the post.
    fn raise_holds(&self, ra: &Raising, phase: &str, now: Micros) -> R<Holds> {
        let own = ra.geo.holds(ra.r)?;
        let h = ra.geo.spec.height;
        let hold = |body: Id, name: &str, at: Vec3, p: Vec3| Hold {
            body,
            grip: name.to_owned(),
            at,
            hands: [
                Vec3::new(p.x, (p.y - HAND_HALF).max(0), p.z),
                Vec3::new(p.x, (p.y + HAND_HALF).min(h), p.z),
            ],
        };
        Ok(Holds {
            load: ra.part,
            phase: phase.to_owned(),
            since: now,
            until: None,
            holds: vec![
                hold(ra.lifter, &ra.grip.0, ra.grip.1, own[0]),
                hold(ra.footer, "foot", Vec3::ZERO, own[1]),
            ],
        })
    }

    /// A raise's or a lowering's commit was written (`written`) or refused: its take starts its track; a part stood up
    /// is said raised and held; one refused there turns back.
    pub(super) fn raise_written(&mut self, r: &Ready, written: bool, now: Micros, live: &Tree) {
        if let Some(asm) = self.asm.as_mut() {
            asm.written(r.activity, r.step, written);
        }
        let Some(mut ra) = self.raising.remove(&r.activity) else {
            return;
        };
        let word = (now, Actor::Soul(r.soul), Cause::Intent(r.intent));
        match (r.step, written) {
            (Step::Taken, true) => {
                let Some(audience) = live
                    .handle(r.activity)
                    .and_then(|h| live.node(h))
                    .map(|n| n.audience())
                else {
                    return;
                };
                let mut carry = Carry::new(
                    r.activity,
                    ra.part,
                    ra.ground,
                    audience,
                    self.header.clone(),
                    self.rules.clone(),
                );
                if let Some(l) = self.held_load(live, ra.part) {
                    carry.load = l;
                }
                let mut tree = live.frozen();
                let phase = if ra.up { RAISE } else { LOWER };
                self.activities.next = tree.next();
                if let Err(e) = self.activities.carry_track(
                    &mut tree,
                    r.activity,
                    ra.part,
                    phase,
                    (now, now + ra.geo.time()),
                    None,
                    word,
                ) {
                    eprintln!("worldd: a raise's track was not said: {e}");
                }
                let said = self.raise_holds(&ra, phase, now).and_then(|h| {
                    self.activities.next = tree.next();
                    self.activities
                        .carry_grips(&mut tree, r.activity, &h, word)
                });
                if let Err(e) = said {
                    eprintln!("worldd: a raise's holds were not said: {e}");
                }
                ra.carry = Some(carry);
                ra.since = now;
                self.raising.insert(r.activity, ra);
                self.collect(Some((r.intent, r.soul)));
            }
            (Step::Seated, true) => {
                let mut tree = live.frozen();
                self.activities.next = tree.next();
                if let Err(e) = self.activities.carry_track(
                    &mut tree,
                    r.activity,
                    ra.part,
                    "souls:raised",
                    (ra.since, now),
                    None,
                    word,
                ) {
                    eprintln!("worldd: a raise's end was not said: {e}");
                }
                // Standing, its crew holds it on.
                if let Err(e) = regrip(
                    &mut self.activities,
                    &mut tree,
                    r.activity,
                    grips::HELD,
                    None,
                    word,
                ) {
                    eprintln!("worldd: a raise's holds were not said at its end: {e}");
                }
                self.collect(Some((r.intent, r.soul)));
            }
            (Step::Seated, false) => {
                ra.settling = false;
                ra.up = false;
                ra.walking = false;
                let mut tree = live.frozen();
                self.turned_back(&mut tree, r.activity, &ra, "souls:raise-refused", now);
                self.collect(None);
                self.raising.insert(r.activity, ra);
            }
            // A take refused at its commit: nothing was taken.
            _ => {}
        }
    }

    /// The world's word that a raise turned back, and why: `souls:carry-track` with `souls:lower`.
    fn turned_back(
        &mut self,
        tree: &mut Tree,
        activity: Id,
        ra: &Raising,
        why: &'static str,
        now: Micros,
    ) {
        let word = (now, Actor::World, Cause::World);
        self.activities.next = tree.next();
        if let Err(e) = self.activities.carry_track(
            tree,
            activity,
            ra.part,
            LOWER,
            (now, now + ra.geo.time()),
            Some(why),
            word,
        ) {
            eprintln!("worldd: a raise turned back was not said: {e}");
        }
        if let Err(e) = regrip(&mut self.activities, tree, activity, LOWER, None, word) {
            eprintln!("worldd: a raise's holds were not said as it turned back: {e}");
        }
    }

    /// One tick of every part on its way up or down, written on `tree`. See the module's notes.
    pub(super) fn raise_tick(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        town: &sim::walk::town::Town,
        now: Micros,
    ) {
        let crews: Vec<Id> = self.raising.keys().copied().collect();
        for activity in crews {
            let Some(mut ra) = self.raising.remove(&activity) else {
                continue;
            };
            let done = match ra.carry.is_some() && !ra.settling {
                true => self
                    .raise_step(tree, c, town, activity, &mut ra, now)
                    .unwrap_or_else(|e| {
                        eprintln!("worldd: a raise's tick was not written: {e}");
                        false
                    }),
                false => false,
            };
            if !done {
                self.raising.insert(activity, ra);
            }
        }
    }

    /// One tick of one part; whether it has been laid down and let go (its way is over).
    fn raise_step(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        town: &sim::walk::town::Town,
        activity: Id,
        ra: &mut Raising,
        now: Micros,
    ) -> R<bool> {
        let ground = ra.ground;
        let on = |c: &Controller, b: Id| {
            stands(c, b)
                .ok()
                .filter(|(g, _)| *g == ground)
                .map(|(_, p)| p)
        };
        let (lf, ff) = (on(c, ra.lifter), on(c, ra.footer));
        // A raise whose carrier no longer reaches its hold turns back: the part is laid down where it lay.
        let reaches = match (lf, ff) {
            (Some(l), Some(f)) => {
                out_of_reach(&ra.carriers(l, f)?, ra.geo.node(ra.r)?).is_ok()
            }
            _ => false,
        };
        if ra.up && !reaches {
            ra.up = false;
            ra.walking = false;
            self.turned_back(tree, activity, ra, "souls:carrier-out-of-reach", now);
        }
        let end = ra.geo.lifter_at(ra.goal());
        // The world walks the lifter beside the part, from where it is, over ground it stands on.
        if !ra.walking
            && let Some(l) = lf
            && way_is_ground(c, town, ra.ground, ra.lifter, l, end)
        {
            let track = Track {
                link: None,
                line: vec![end],
                speed: PACE,
                to: ra.ground,
                arrive: None,
                hold: false,
            };
            match c.carry_on(ra.lifter, track) {
                Ok(()) => ra.walking = true,
                Err(e) => eprintln!("worldd: {} was not walked beside its part: {e}", show(ra.lifter)),
            }
        }
        // The part follows its lifter, only ever the way it is going, a step a tick at most. With no lifter on its
        // ground it goes on by itself: never left part way.
        let want = match lf {
            Some(l) if apart(l, end) <= NEAR || ra.still >= STILL => ra.goal(),
            Some(l) => ra.geo.r_of(l),
            None => ra.goal(),
        };
        let want = if ra.up { want.min(ra.r) } else { want.max(ra.r) };
        let next = match want == ra.r {
            true => ra.r,
            false => ra.geo.spec.toward(ra.r, want),
        };
        let step = next - ra.r;
        ra.still = if step == 0 { ra.still.saturating_add(1) } else { 0 };
        if step != 0 {
            ra.r = next;
            let (p, q) = ra.geo.node(ra.r)?;
            if let Some(carry) = ra.carry.as_mut() {
                carry.turn_to(tree, now, p, q)?;
                self.activities
                    .stream
                    .extend(carry.log.parts.drain(..).flatten());
            }
        }
        // Each carrier faces its hold.
        if let (Some(l), Some(f)) = (lf, ff) {
            face_holds(c, &ra.carriers(l, f)?, ra.geo.node(ra.r)?);
        }
        if ra.r != ra.goal() {
            return Ok(false);
        }
        let (p, q) = ra.geo.node(ra.r)?;
        if !ra.up {
            // Lying: put where it lies and let go, as a carry sets its load down.
            let transfer = self
                .mint
                .mint()
                .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
            if let Some(carry) = ra.carry.as_mut() {
                carry.rest_at(tree, now, ra.ground, p, q, transfer)?;
                self.activities
                    .stream
                    .extend(carry.log.parts.drain(..).flatten());
            }
            let word = (now, Actor::World, Cause::World);
            self.activities.next = tree.next();
            self.activities.carry_track(
                tree,
                activity,
                ra.part,
                "souls:lowered",
                (ra.since, now),
                None,
                word,
            )?;
            if let Err(e) = regrip(
                &mut self.activities,
                tree,
                activity,
                grips::RELEASED,
                None,
                word,
            ) {
                eprintln!("worldd: a lowered part's holds were not let go: {e}");
            }
            if let Some(asm) = self.asm.as_mut() {
                asm.ended(activity);
            }
            return Ok(true);
        }
        // Standing: put on the ground at its foot with its crew holding it.
        let asm = self
            .asm
            .as_mut()
            .ok_or_else(|| refusal("seating-off", "the world's kinds join no parts"))?;
        let put = asm.settle(
            tree,
            &self.activities,
            &mut self.mint,
            now,
            ra.by,
            activity,
            ra.part,
            ra.ground,
            (p, q),
            ra.up,
            ra.reach,
        );
        match put {
            Ok(()) => ra.settling = true,
            Err(e) => {
                eprintln!("worldd: {} was not stood up: {e}", show(ra.part));
                ra.up = false;
                ra.walking = false;
                self.turned_back(tree, activity, ra, "souls:raise-refused", now);
            }
        }
        Ok(false)
    }
}
