//! Boarding links (Engine v2 N12, #2737): the link between the ground at a stop and a moving frame's deck
//! (`crate::tracks`). Getting on and off is a crossing of it, usable only while the frame stands at that stop.
//!
//! - **The grant is N8's.** A boarding link is narrow ([`super::turns`]): its owner, the moving node, writes who may
//!   cross from the facts of the last tick (T1). The deck end has room only while the frame dwells at the link's stop
//!   with at least [`CROSSING`] of its dwell left, so a body that reaches the link while the frame is away stands at
//!   it, waiting, and is granted the crossing when the frame stops there: standing in a queue (contract T10). The
//!   body holds no order with a time or a condition in it; the frame's stops and times are data on the frame.
//! - **The crossing is a hand-off** (T4 rule 10, `Scene::hand_off`) with T1's leave and arrive under one transfer
//!   id. On, the body becomes the frame's rider: its frame is the moving node's slot, owned by the slot, and its
//!   stored pose does not change while the frame moves. Off, it is handed to the ground's surface and its own mover.
//!   The hand-off keeps its motion in the root frame, pose and velocity; at a stop the frame is still, so stepping
//!   off adds no deck speed to the body's. A crossing while the frame is not standing at the stop, as the scene
//!   holds it at that time, is refused as `boarding-frame-away`: nobody is moved to a frame that is not there.
//! - **A crossing is never cut in half.** The grant is given only while [`CROSSING`] of the dwell is left, the time a
//!   granted body has to make it, so the frame never starts while a body is on the link.
//! - **Leaving is always accepted** (E23's rule 8, "at a stop"): a rider that asks to leave waits at the deck end and
//!   is granted the crossing at the next stop, which the loaded track promises within its stated time.

use super::turns::{Facts, Turns};
use super::{Kind, Link};
use crate::mover::{Body, Surface};
use crate::tracks::Table;
use replica::effects::{Refusal, TransferRec};
use replica::ids::{Id, Scope};
use replica::pose::{Frame, HandOff, Owner, Scene, Support, Track, Vec3};
use replica::time::Micros;
use replica::world_model::show;

type R<T> = Result<T, Refusal>;

/// The time a granted body has to make the crossing, µs: no grant is given with less of the dwell left.
pub const CROSSING: Micros = 2_000_000;

/// A boarding link: its id, the moving node that owns it, the station it serves, the slot of the moving node a body
/// boards into, the node of its ground end and its width (µm, under N8's narrow width).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Boarding {
    pub id: Id,
    pub frame: Id,
    pub station: usize,
    pub slot: u64,
    pub ground: Id,
    pub width: i64,
}

impl Boarding {
    /// The link as N8 takes it in turns: end 0 the ground, end 1 the deck, owned by the moving node.
    pub fn link(&self) -> Link {
        Link {
            id: self.id,
            kind: Kind::Boarding,
            nodes: [self.ground, self.frame],
            owner: self.frame,
            width: self.width,
            ends: [None, None],
            line: Vec::new(),
            door: None,
            blocked: None,
        }
    }

    /// Whether a crossing may be granted at world time `t`: the frame dwells at this link's station with at least
    /// [`CROSSING`] left.
    pub fn open(&self, table: &Table, t: Micros) -> R<bool> {
        Ok(table
            .stopped(t)?
            .is_some_and(|s| s.station == self.station && s.left >= CROSSING))
    }

    /// The owner writes the link's turns for world time `at` from the facts of the last tick: N8's grant, with room
    /// at either end only while the link is open.
    pub fn write(&self, turns: &mut Turns, table: &Table, facts: &Facts, at: Micros) -> R<()> {
        let open = self.open(table, at)?;
        let mut f = facts.clone();
        f.room = [f.room[0] && open, f.room[1] && open];
        turns.write(self.frame, &self.link(), &f, at)
    }

    /// `boarding-frame-away` unless the scene holds the frame standing where its track puts it at `at`, at this
    /// link's station.
    fn here(&self, scene: &Scene, table: &Table, at: Micros) -> R<()> {
        let stopped = table
            .stopped(at)?
            .is_some_and(|s| s.station == self.station);
        let held = scene.get(self.frame).is_some_and(|m| {
            m.owner == Owner::Track(Track::Rest)
                && table.at(at).is_ok_and(|(p, _)| p == m.pose.position)
        });
        if stopped && held {
            Ok(())
        } else {
            Err(Refusal {
                name: "boarding-frame-away",
                detail: format!("{} at {at} us", show(self.id)),
            })
        }
    }

    /// `body` crosses onto the frame at world time `at`: handed to the frame's slot, owned by it, keeping its motion
    /// in the root frame; T1's leave and arrive, inside zone `zone` of the world `lineage`, under the id `transfer`.
    #[allow(clippy::too_many_arguments)]
    pub fn board(
        &self,
        scene: &mut Scene,
        table: &Table,
        body: Id,
        at: Micros,
        transfer: Id,
        lineage: Scope,
        zone: Id,
    ) -> R<(HandOff, [TransferRec; 2])> {
        self.here(scene, table, at)?;
        let frame = Frame {
            node: self.frame,
            slot: Some(self.slot),
        };
        let mut next = scene.clone();
        let (h, _) = next
            .hand_off(body, at, frame, Support::Slot, Owner::Slot, Vec3::ZERO)
            .map_err(pose_refusal)?;
        *scene = next;
        Ok((h, recs(transfer, body, lineage, zone, h)))
    }

    /// `body`, a rider, crosses off the frame onto `ground` (in `frame`) at world time `at`: handed to the ground's
    /// surface and its own mover, keeping its motion in the root frame. `off-surface` when it would not stand on it.
    #[allow(clippy::too_many_arguments)]
    pub fn alight(
        &self,
        scene: &mut Scene,
        table: &Table,
        body: Id,
        ground: &Surface,
        frame: Frame,
        at: Micros,
        transfer: Id,
        lineage: Scope,
        zone: Id,
    ) -> R<(Body, HandOff, [TransferRec; 2])> {
        self.here(scene, table, at)?;
        let mut next = scene.clone();
        let support = Support::Surface {
            surface: ground.node,
            height: 0,
        };
        let (h, _) = next
            .hand_off(body, at, frame, support, Owner::Mover, Vec3::ZERO)
            .map_err(pose_refusal)?;
        let mut b = ground.place(body, frame, h.pose.position, h.pose.orientation)?;
        b.linear = h.linear;
        *scene = next;
        Ok((b, h, recs(transfer, body, lineage, zone, h)))
    }
}

fn pose_refusal(e: replica::pose::PoseRefusal) -> Refusal {
    Refusal {
        name: e.name(),
        detail: "the boarding crossing".into(),
    }
}

/// T1's leave and arrive of one crossing inside one zone.
fn recs(transfer: Id, node: Id, lineage: Scope, zone: Id, h: HandOff) -> [TransferRec; 2] {
    [
        TransferRec::Leave {
            transfer,
            node,
            lineage,
            zone,
            pose: h.pose,
        },
        TransferRec::Arrive {
            transfer,
            carried: Vec::new(),
        },
    ]
}
