//! Seating a part by intents (0.135 A2; B19's seating, #3340, in a running world): a crew of two Souls takes a part,
//! carries it, seats it in a bay's slot with its joints made, and takes it out again. No code here names a kind:
//! which parts stand, which bear, which kinds are bays and which connectors mate is B18's reading of the world's
//! entries (`sim::structure`).
//!
//! - **Verbs** ([`crate::engine::Verb`]): `part:take` and `part:unseat` (target the crew's activity, 1 the part) and
//!   `part:put` (target the activity; 1 the node it goes in, 2 its slot there, or 3 a point `[x, y, z]` µm in that
//!   node's frame; 4 the parts it joins, ids, when not the bay's standing parts, or for a resting part its bearing
//!   ones).
//! - **Take** ([`Assembly::take`]): the part, within [`GRASP`] of the middle of its two carriers, goes into the crew's
//!   slot in one commit (B19's take: its joints undone, a holding crew's node moved off it), keeping the turn it had.
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
//!   a body's hand (`part.in-a-hand`), not riding or held by another activity (`part.held-by-another`), and within
//!   its carriers' standing reach (`reach.too-high`).
//! - **Put from close by** (`part.out-of-reach` beyond [`PUT_REACH`] of where the part goes): the set-in track is
//!   short and straight.
//! - **A seating refused at its track's end or at its commit** stops where its track has it then, and goes back along
//!   a straight track to where its set-in started ([`Assembly::stop`]); there it is handed back to the crew's carry
//!   ([`Assembly::returned`]), and the crew may put again. The part never leaves its crew's slot. While a part is on its
//!   way in or back, or its seating waits for its commit, its crew is not left (`crew.setting-in`, `crate::engine`);
//!   otherwise a leave breaks the carry off and the part is set down where it is (C3), so no part goes with an
//!   activity that ends.
//!
//! Not here: the gathering walk (each Soul walks to its end), a procedure or blueprint, more than one bay.

use std::collections::BTreeMap;

use replica::effects::{Actor, Cause, Effect, Header, Refusal};
use replica::encode::Name;
use replica::ids::{Id, Minter};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Track, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, show};
use sim::activity::Activities;
use sim::activity::carry::{HEIGHT, yaw_toward};
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

/// How far the part's middle may be from the middle of its two carriers, along the ground, µm.
pub const GRASP: i64 = 1_500_000;
/// How far, along the ground, the crew's node may be from where the part goes when it is put: the set-in track is
/// short and straight, not a way to move a part across the world.
pub const PUT_REACH: i64 = 1_000_000;
/// The set-in track's pace, µm a second, and its shortest and longest time.
const SET_IN_PACE: i64 = 500_000;
const SET_IN_LEAST: Micros = 1_000_000;
const SET_IN_MOST: Micros = 4_000_000;

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
    track: Owner,
    /// Where the set-in track started (the crew's node between its carriers), when, and its velocity, µm a second.
    pub start: (Vec3, Quat),
    t0: Micros,
    velocity: Vec3,
    pub end: (Vec3, Quat),
    /// Between its carriers along the ground when the put was asked, µm: the carry's span when it starts again.
    pub span: i64,
}

/// The crews' seating in a running world.
pub struct Assembly {
    seating: Seating,
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
    /// Crews' nodes going back along a track to where their set-in started, and when each gets there.
    returning: BTreeMap<Id, (Setting, Micros, Owner)>,
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

/// The conjugate of a unit quaternion: its inverse turn.
fn conj(q: Quat) -> R<Quat> {
    let [w, x, y, z] = q.parts();
    Quat::new(w, -x, -y, -z).map_err(|e| refusal("part-pose", format!("{e:?}")))
}

impl Assembly {
    pub fn new(header: Header, rules: Rules, structure: Structure) -> Assembly {
        Assembly {
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
    /// [`Assembly::ready`]. Returns the crew's node's pose, where its carry starts.
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
        let middle = Vec3::new(
            (front.x + back.x) / 2,
            (front.y + back.y) / 2,
            (front.z + back.z) / 2,
        );
        within_reach(at.pos.y - middle.y, reach)?;
        let (dx, dz) = (
            i128::from(at.pos.x - middle.x),
            i128::from(at.pos.z - middle.z),
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
        let frame = Vec3::new(middle.x, middle.y + HEIGHT, middle.z);
        self.aim(tree, activity, ground)?;
        self.seating
            .take(tree, acts, mint, now, activity, part, (frame, turn), inside)?;
        self.drain(by, activity, Step::Taken);
        self.held.insert(activity, part);
        Ok((frame, turn))
    }

    /// `part:put` by crew `activity`, its node now at `from` on `ground` and its members reaching `reach` µm: the
    /// part to `to`'s slot `slot` (or to `point` in `to`'s frame), joined to `joins` (by default, a bearing part to the
    /// bay's standing parts). Refused before anyone moves; else the set-in track is written on `tree` and the seating
    /// waits for its end ([`Assembly::due`]).
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
    ) -> R<Vec<Effect>> {
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
        // By default a bearing part joins the bay's standing parts; a resting one (a cloth) the bay's bearing parts
        // (its rails), which it rests on.
        let rests = s.rests(pk.as_str());
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
                .collect(),
            None => Vec::new(),
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
            turn: Quat::IDENTITY,
            at,
            joins: joined,
            hold: bay && s.stands(pk.as_str()),
        };
        self.aim(tree, activity, ground)?;
        self.seating.check(
            tree,
            acts,
            &mut mint.clone(),
            activity,
            part,
            &target,
            reach,
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
        let (dx, dy, dz) = (
            i128::from(at.x - from.0.x),
            i128::from(at.y - from.0.y),
            i128::from(at.z - from.0.z),
        );
        let far = i64::try_from((dx * dx + dy * dy + dz * dz).isqrt()).unwrap_or(i64::MAX);
        let span = (far / SET_IN_PACE * 1_000_000).clamp(SET_IN_LEAST, SET_IN_MOST);
        self.seating
            .set_in(tree, acts, activity, now, from.0, from.1, at, now + span)?;
        let effects = self.seating.parts.drain(..).flatten().collect();
        // The track as `Seating::set_in` writes it, to hand the node back from it if the seating is refused.
        let v = |a: i64, b: i64| (i128::from(b - a) * 1_000_000 / i128::from(span)) as i64;
        let velocity = Vec3::new(v(from.0.x, at.x), v(from.0.y, at.y), v(from.0.z, at.z));
        self.setting.insert(
            activity,
            Setting {
                part,
                target,
                due: now + span,
                by,
                ground,
                reach,
                track: Owner::Track(Track::Straight { t0: now, velocity }),
                start: from,
                t0: now,
                velocity,
                end: (at, from.1),
                span: apart,
            },
        );
        Ok(effects)
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
            let Some(mut s) = self.setting.remove(&activity) else {
                continue;
            };
            // The node stops at the slot as its track ends, whatever its seating's fate: no track runs on past it.
            let rest = Owner::Track(Track::Rest);
            match self.hand_off(
                tree,
                s.due,
                activity,
                s.ground,
                (s.track, rest),
                s.end,
                Vec3::ZERO,
            ) {
                Ok(effects) => {
                    self.moved.push((s.by, effects));
                    s.track = rest;
                }
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
        let gone = i128::from(now.min(s.due).saturating_sub(s.t0));
        let at = |a: i64, v: i64| a + (i128::from(v) * gone / 1_000_000) as i64;
        let here = Vec3::new(
            at(s.start.0.x, s.velocity.x),
            at(s.start.0.y, s.velocity.y),
            at(s.start.0.z, s.velocity.z),
        );
        let (dx, dy, dz) = (
            i128::from(s.start.0.x - here.x),
            i128::from(s.start.0.y - here.y),
            i128::from(s.start.0.z - here.z),
        );
        let far = i64::try_from((dx * dx + dy * dy + dz * dz).isqrt()).unwrap_or(i64::MAX);
        let span = (far / SET_IN_PACE * 1_000_000).clamp(SET_IN_LEAST, SET_IN_MOST);
        let v = |d: i128| (d * 1_000_000 / i128::from(span)) as i64;
        let back = Vec3::new(v(dx), v(dy), v(dz));
        let track = Owner::Track(Track::Straight {
            t0: now,
            velocity: back,
        });
        let effects = self.hand_off(
            tree,
            now,
            activity,
            s.ground,
            (s.track, track),
            (here, s.end.1),
            back,
        )?;
        self.returning.insert(activity, (s, now + span, track));
        Ok(effects)
    }

    /// The crews' nodes back where their set-in started by `now`, written on `tree`: each handed from its return track
    /// to its mover there, with the setting it came back from, so the engine starts its carry again.
    pub fn returned(&mut self, tree: &mut Tree, now: Micros) -> Vec<(Id, Setting, Vec<Effect>)> {
        let due: Vec<Id> = self
            .returning
            .iter()
            .filter(|(_, (_, at, _))| *at <= now)
            .map(|(a, _)| *a)
            .collect();
        let mut out = Vec::new();
        for activity in due {
            let Some((s, at, track)) = self.returning.remove(&activity) else {
                continue;
            };
            match self.hand_off(
                tree,
                at,
                activity,
                s.ground,
                (track, Owner::Mover),
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
