//! A crew seats a part in a bay and takes it out again (Engine v2 B19, #3340): the carry (B9) ends in a slot with the
//! part's joints made, and starts from one with its joints undone. No code here names a kind; which parts stand and
//! which join is B18's reading of the kinds (`crate::structure`).
//!
//! - **The crew is a joint activity** (B5) of two members or more, its node the carry's frame (B9): the part rides the
//!   node's slot [`SLOT`], a frame standing with a carrier at each column, a beam level with a carrier at each end; a
//!   crew's sides (0.135 C5, the members after its first two) walk beside it. Every step below asks for at least
//!   [`CREW`] members of a started activity (`crew.size`, `crew.not-started`), so no part moves without its crew.
//! - **Taking** ([`Seating::take`]): from wherever the part is (a stand's slot, the ground, a bay's slot) into the
//!   crew node's slot, in one commit: each joint at the part undone (written by the node that owns the link), the
//!   crew's node set on the ground where the carry starts (moved off the part when the crew held it), and the part's
//!   change of parent (T1's leave and arrive under one transfer id). Taking out of a bay is this, checked by B18.
//! - **Setting in** ([`Seating::set_in`]): at the slot, the crew's node is handed from its mover to a straight track
//!   (T4, `v2/docs/pose.md` rule 8) at constant orientation, from where the carry ended to where the part is in its
//!   slot. The part rides the node's slot all the way, so it has one motion owner at every moment (rule 7): the slot,
//!   whose frame is moved first by the carry's mover, then by the track.
//! - **Seating** ([`Seating::put`]): when the track ends, one commit: the part's change of parent into the slot, its
//!   joints made, and either the crew's node moved under the part, so its members hold it (B18 counts a started
//!   activity on a part, with its membership links, as its holders), or the node's track ended at rest. Holders let go
//!   with B5's leave, which B18 refuses by name until the part stands.
//! - **Refused before anyone moves** ([`Seating::check`]): `crew.size`, `slot.occupied` (another part in the slot),
//!   `reach.too-high` (the slot's height above the crew's standing reach), and B18's refusals of the seating as it
//!   would be committed, and `site.occupied` when a body stands where the part would be (N19, #3341). Every commit
//!   here goes through [`Seating::write`], the structure rule's guarded write, which asks for G3's rebuild of the
//!   ground when one is kept ([`Seating::rebuild`]): a seated part is fixed geometry to walkers.
//! - **A way out is G2's, not this check's.** [`Seating::check`] finds only a body standing where the part would be.
//!   Whether the seating would leave a Soul with no way out (a bay's last beam closing round it) is judged where the
//!   walkers' ground is: a running world commits every take and seating through the walkers' maps, and G2's rule
//!   (`crate::edit::safety::check_on`, the one creator edits use) refuses it there by name, `edit.would-cut-off`
//!   naming the Soul, before it commits (`worldd::answers`, the part check; worldd's
//!   `a2_souls_take_put_and_unseat_rack_parts_by_intents`).
//!
//! Not here: ladders, raising from lying, three carriers, decks and stairs, the gathering walk, a crew member who leaves
//! between steps (B5's leave; a new member joins the next activity).

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Refusal, Rest,
    TransferRec,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Minter};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Track, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, show};

use super::Activities;
pub use super::carry::SLOT;
use crate::ground::HUMAN_RADIUS;
use crate::ground::scene::stands_in;
use crate::slots::hands::{Entry, in_slot};
use crate::structure::Structure;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn minted(mint: &mut Minter) -> R<Id> {
    mint.mint().map_err(|e| Refusal {
        name: "id-counter-exhausted",
        detail: e.to_string(),
    })
}

/// A crew's least size: two carriers, one at each column of a frame or each end of a beam. The carry's kind bounds the
/// most (a crew carrying with its sides, 0.135 C5).
pub const CREW: usize = 2;

/// Where a part goes, and what it joins there.
#[derive(Clone, Debug)]
pub struct Target {
    /// Its new parent and slot: a bay's slot, a stand's, or the ground with none.
    pub to: Frame,
    /// Its pose in that frame: zero and unturned in a slot, where it lies on the ground.
    pub place: Vec3,
    pub turn: Quat,
    /// Where the crew's node is when the part reaches it, µm in the ground's frame; its height is the slot's height
    /// above the ground the crew stand on.
    pub at: Vec3,
    /// The joints it makes: each a link type and the part it joins.
    pub joins: Vec<(Name, Id)>,
    /// Whether the crew stay on as its holders (a frame), their node moved under it.
    pub hold: bool,
}

/// The crew's writer: every commit, guarded by the structure rule.
pub struct Seating {
    pub header: Header,
    pub rules: Rules,
    pub structure: Structure,
    pub ground: Id,
    pub audience: Audience,
    /// Every part committed, in order.
    pub parts: Vec<Vec<Effect>>,
    /// The track each crew node is on while it sets a part in.
    tracks: BTreeMap<Id, Owner>,
    /// G3's rebuild, asked for by each commit when the ground is kept (N19, #3341): a seated part is fixed geometry.
    pub rebuild: Option<crate::ground::Rebuild>,
    /// Each kind's section 11 bounds, by full name (`replica::kinds::Kinds::most`): a crew that would stay on as a
    /// part's holders is refused when the part already holds that many crews (`crew.over-most`). Empty: unbounded.
    pub most: BTreeMap<String, BTreeMap<String, u64>>,
}

fn leave(header: &Header, transfer: Id, node: Id, pose: Pose) -> Body {
    Body::Transfer(TransferRec::Leave {
        transfer,
        node,
        lineage: header.lineage,
        zone: header.zone,
        pose,
    })
}

fn arrive(transfer: Id) -> Body {
    Body::Transfer(TransferRec::Arrive {
        transfer,
        carried: Vec::new(),
    })
}

fn changes(cs: Vec<Change>) -> Body {
    Body::Changes(
        cs.into_iter()
            .map(|change| ChangeRec {
                change,
                rest: Rest::new(),
            })
            .collect(),
    )
}

fn on(node: Id, position: Vec3, orientation: Quat, support: Support) -> Pose {
    Pose {
        frame: Frame { node, slot: None },
        position,
        orientation,
        support,
    }
}

impl Seating {
    pub fn new(
        header: Header,
        rules: Rules,
        structure: Structure,
        ground: Id,
        audience: Audience,
    ) -> Seating {
        Seating {
            header,
            rules,
            structure,
            ground,
            audience,
            parts: Vec::new(),
            tracks: BTreeMap::new(),
            rebuild: None,
            most: BTreeMap::new(),
        }
    }

    fn part(&self, tree: &Tree, at: Micros, entries: Vec<Entry>) -> R<(Part, Vec<Effect>)> {
        let effects: Vec<Effect> = entries
            .into_iter()
            .zip(tree.next()..)
            .map(|((node, audience, body), sequence)| Effect {
                envelope: Envelope {
                    sequence,
                    at,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience,
                    node,
                },
                body,
                events: None,
                rest: Rest::new(),
            })
            .collect();
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(effects.iter().map(Effect::to_value).collect()),
            ),
        ])))
        .or_else(|e| refuse("encoding", e.to_string()))?;
        Ok((Part::read(&bytes)?, effects))
    }

    /// Commits `entries` as one part, all or none, refused first by the structure rule (B18) when it would leave a
    /// part of a bay unsupported, then by T2 at commit.
    pub fn write(&mut self, tree: &mut Tree, at: Micros, entries: Vec<Entry>) -> R<()> {
        let (part, effects) = self.part(tree, at, entries)?;
        self.structure.check(tree, &part.effects)?;
        let before = self.rebuild.as_ref().map(|_| tree.frozen());
        tree.commit(&self.header, &part, &self.rules)?;
        self.parts.push(effects);
        if let (Some(rebuild), Some(before)) = (self.rebuild.as_mut(), before) {
            rebuild(before, &part)?;
        }
        Ok(())
    }

    /// The crew of `activity`: at least [`CREW`] members of a started activity.
    fn crew(acts: &Activities, activity: Id) -> R<()> {
        let n = acts.members(activity).map_or(0, <[_]>::len);
        if n < CREW {
            return refuse(
                "crew.size",
                format!(
                    "{} has {n} members; a part is moved by {CREW} or more",
                    show(activity)
                ),
            );
        }
        if !acts.started(activity) {
            let why = acts.unstarted_why(activity).unwrap_or_default();
            return refuse("crew.not-started", format!("{}: {why}", show(activity)));
        }
        Ok(())
    }

    /// `crew.over-most`: `part`'s kind bounds the children of the crew's kind (section 11) and it already holds that
    /// many, so `activity`'s node cannot stay on under it as its holders.
    fn within_most(&self, tree: &Tree, activity: Id, part: Id) -> R<()> {
        let plain = |k: &Name| k.as_str().split('@').next().unwrap_or("").to_owned();
        let kind_of = |id: Id| {
            tree.handle(id)
                .and_then(|h| tree.node(h))
                .map(|n| n.kind().clone())
        };
        let (Some(pk), Some(ak)) = (kind_of(part), kind_of(activity)) else {
            return Ok(());
        };
        let crew = plain(&ak);
        let Some(&most) = self.most.get(pk.as_str()).and_then(|b| b.get(&crew)) else {
            return Ok(());
        };
        let held = tree
            .handle(part)
            .and_then(|h| tree.children(h))
            .unwrap_or(&[])
            .iter()
            .filter_map(|h| tree.node(*h))
            .filter(|n| n.id() != activity && plain(n.kind()) == crew)
            .count();
        if u64::try_from(held).unwrap_or(u64::MAX) >= most {
            return refuse(
                "crew.over-most",
                format!(
                    "{} already holds {held} {crew} (its kind holds at most {most})",
                    show(part)
                ),
            );
        }
        Ok(())
    }

    /// The refusals before anyone moves, for `part` to go to `target` with `activity`'s crew, whose standing reach is
    /// `reach` µm: `crew.size`, `crew.over-most` (B19's bound, section 11), `slot.occupied`, `reach.too-high`, `site.occupied` (a body stands where the part would
    /// be, N19), then B18's on the seating as it would be committed. Not a way out: G2 judges that at the commit.
    #[allow(clippy::too_many_arguments)]
    pub fn check(
        &self,
        tree: &Tree,
        acts: &Activities,
        mint: &mut Minter,
        activity: Id,
        part: Id,
        target: &Target,
        reach: i64,
    ) -> R<()> {
        let n = acts.members(activity).map_or(0, <[_]>::len);
        if n < CREW {
            return refuse(
                "crew.size",
                format!(
                    "{} has {n} members; a part is moved by {CREW} or more",
                    show(activity)
                ),
            );
        }
        if target.hold {
            self.within_most(tree, activity, part)?;
        }
        if let Some(slot) = target.to.slot
            && let Some(other) = in_slot(tree, target.to.node, slot)
            && other != part
        {
            return refuse(
                "slot.occupied",
                format!(
                    "slot {slot} of {} holds {}",
                    show(target.to.node),
                    show(other)
                ),
            );
        }
        if target.at.y > reach {
            return refuse(
                "reach.too-high",
                format!(
                    "{} µm above the ground, standing reach {reach} µm",
                    target.at.y
                ),
            );
        }
        let body = |k: &str| self.rules.kinds.get(k).is_some_and(|d| d.owner == "family");
        let (to, place, turn) = (target.to, target.place, target.turn);
        let r = stands_in(
            tree,
            self.ground,
            part,
            to,
            place,
            turn,
            HUMAN_RADIUS,
            &body,
        );
        if let Some(who) = r.or_else(|e| refuse("seating.unread", e))? {
            return refuse(
                "site.occupied",
                format!("{} stands where {} would be", show(who), show(part)),
            );
        }
        let entries = self.entries(tree, mint, activity, part, target, 0)?;
        let (p, _) = self.part(tree, 0, entries)?;
        self.structure.check(tree, &p.effects)
    }

    /// Takes `part` into `activity`'s slot, the crew's node set on the ground at `frame` (its position and turn, µm in
    /// the ground's frame) and the part at `inside` in the slot (its position, µm, and its turn there: a part that lies
    /// is held by its middle between its carriers, #5067): one commit, its joints undone with it.
    #[allow(clippy::too_many_arguments)]
    pub fn take(
        &mut self,
        tree: &mut Tree,
        acts: &Activities,
        mint: &mut Minter,
        at: Micros,
        activity: Id,
        part: Id,
        frame: (Vec3, Quat),
        inside: (Vec3, Quat),
    ) -> R<()> {
        Self::crew(acts, activity)?;
        let a = self.audience;
        let (ph, ah) = match (tree.handle(part), tree.handle(activity)) {
            (Some(p), Some(a)) => (p, a),
            _ => return refuse("part-missing", show(part)),
        };
        let mut out: Vec<Entry> = Vec::new();
        // The crew's node on the ground where the carry starts: moved off the part it held, or its mover's sample.
        let held = tree.node(ah).and_then(|n| n.parent()) == Some(part);
        let pose = on(
            self.ground,
            frame.0,
            frame.1,
            Support::Surface {
                surface: self.ground,
                height: 0,
            },
        );
        if held {
            let id = minted(mint)?;
            out.push((activity, a, leave(&self.header, id, activity, pose)));
            out.push((self.ground, a, arrive(id)));
        } else {
            out.push((
                activity,
                a,
                changes(vec![Change::Motion(HandOff {
                    node: activity,
                    at,
                    from: Owner::Mover,
                    to: Owner::Mover,
                    pose,
                    linear: Vec3::ZERO,
                    angular: Vec3::ZERO,
                })]),
            ));
        }
        // Its joints undone, each by the node that owns the link.
        for e in tree.links_of(ph).unwrap_or(&[]) {
            if !self.structure.joint(tree.ty(e).as_str()) {
                continue;
            }
            let Some((_, ends, owner, _)) = tree.link(e.link) else {
                continue;
            };
            let by = ends[usize::from(owner == End::Second)];
            out.push((by, a, changes(vec![Change::Unlink { link: e.link }])));
        }
        let id = minted(mint)?;
        let into = Pose {
            frame: Frame {
                node: activity,
                slot: Some(SLOT),
            },
            position: inside.0,
            orientation: inside.1,
            support: Support::Slot,
        };
        out.push((part, a, leave(&self.header, id, part, into)));
        out.push((activity, a, arrive(id)));
        self.write(tree, at, out)?;
        self.tracks.remove(&activity);
        Ok(())
    }

    /// Hands the crew's node from its mover to a straight track at constant orientation `turn`, from `from` at `t0` to
    /// `to` at `t1` (µm in the ground's frame): the part goes from the carry's frame to its slot's pose.
    #[allow(clippy::too_many_arguments)]
    pub fn set_in(
        &mut self,
        tree: &mut Tree,
        acts: &Activities,
        activity: Id,
        t0: Micros,
        from: Vec3,
        turn: Quat,
        to: Vec3,
        t1: Micros,
    ) -> R<()> {
        Self::crew(acts, activity)?;
        let dt = i128::from(t1 - t0).max(1);
        let v = |a: i64, b: i64| (i128::from(b - a) * 1_000_000 / dt) as i64;
        let velocity = Vec3::new(v(from.x, to.x), v(from.y, to.y), v(from.z, to.z));
        let track = Owner::Track(Track::Straight { t0, velocity });
        let e = (
            activity,
            self.audience,
            changes(vec![Change::Motion(HandOff {
                node: activity,
                at: t0,
                from: Owner::Mover,
                to: track,
                pose: on(self.ground, from, turn, Support::Track),
                linear: velocity,
                angular: Vec3::ZERO,
            })]),
        );
        self.write(tree, t0, vec![e])?;
        self.tracks.insert(activity, track);
        Ok(())
    }

    fn entries(
        &self,
        tree: &Tree,
        mint: &mut Minter,
        activity: Id,
        part: Id,
        target: &Target,
        at: Micros,
    ) -> R<Vec<Entry>> {
        let a = self.audience;
        let mut out: Vec<Entry> = Vec::new();
        let id = minted(mint)?;
        let support = match target.to.slot {
            Some(_) => Support::Slot,
            None => Support::Surface {
                surface: target.to.node,
                height: 0,
            },
        };
        let into = Pose {
            frame: target.to,
            position: target.place,
            orientation: target.turn,
            support,
        };
        out.push((part, a, leave(&self.header, id, part, into)));
        out.push((target.to.node, a, arrive(id)));
        if !target.joins.is_empty() {
            let mut links = Vec::new();
            for (ty, other) in &target.joins {
                links.push(Change::Link {
                    link: minted(mint)?,
                    ty: ty.clone(),
                    ends: [part, *other],
                    owner: End::First,
                    audience: a,
                });
            }
            out.push((part, a, changes(links)));
        }
        if target.hold {
            let id = minted(mint)?;
            let pose = on(
                part,
                Vec3::ZERO,
                Quat::IDENTITY,
                Support::Surface {
                    surface: part,
                    height: 0,
                },
            );
            out.push((activity, a, leave(&self.header, id, activity, pose)));
            out.push((part, a, arrive(id)));
        } else if tree.handle(activity).is_some() {
            let turn = tree
                .handle(activity)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.place())
                .map_or(Quat::IDENTITY, |p| p.orientation);
            out.push((
                activity,
                a,
                changes(vec![Change::Motion(HandOff {
                    node: activity,
                    at,
                    from: self.tracks.get(&activity).copied().unwrap_or(Owner::Mover),
                    to: Owner::Track(Track::Rest),
                    pose: on(self.ground, target.at, turn, Support::Track),
                    linear: Vec3::ZERO,
                    angular: Vec3::ZERO,
                })]),
            ));
        }
        Ok(out)
    }

    /// Puts `part` from the crew's slot into `target` at `at`, when the set-in track ends: one commit, the part's
    /// change of parent with its joints made, and the crew holding it or their node at rest.
    #[allow(clippy::too_many_arguments)]
    pub fn put(
        &mut self,
        tree: &mut Tree,
        acts: &Activities,
        mint: &mut Minter,
        at: Micros,
        activity: Id,
        part: Id,
        target: &Target,
    ) -> R<()> {
        Self::crew(acts, activity)?;
        let entries = self.entries(tree, mint, activity, part, target, at)?;
        self.write(tree, at, entries)?;
        self.tracks.remove(&activity);
        Ok(())
    }
}
