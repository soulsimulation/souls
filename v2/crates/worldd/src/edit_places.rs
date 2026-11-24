//! G1f: declared places prepared on the edit checker's copy. The clock only remaps minted ids and applies deltas.

use std::collections::{BTreeMap, BTreeSet};

use replica::apply::Replica;
use replica::edit::{Op, Ref, Refused};
use replica::ids::{Id, Minter};
use replica::pose::{Quat, Vec3};
use replica::rules::json::Value as Json;
use replica::tree::Tree;
use replica::world_model::plain;
use sim::edit::Planned;
use sim::ground::scene::FLOOR;
use sim::slots::{PlaceAt, Slots};

/// One edited thing's places, each with its floor, and its own boxes (E11d).
type Delta = (Ref, Vec<(PlaceAt, Ref)>, sim::slots::Footprint);

/// The edited things' places, and the refreshed boxes of each thing above an edited one (E11d: a box placed, moved or
/// removed under a seat's thing changes what a climb out of it may pass over).
pub struct Projection(Vec<Delta>, Vec<(Id, sim::slots::Footprint)>);

fn subtree(tree: &Tree, id: Id, out: &mut BTreeSet<Id>) {
    let mut next: Vec<_> = tree.handle(id).into_iter().collect();
    while let Some(h) = next.pop() {
        if let Some(n) = tree.node(h) {
            out.insert(n.id());
        }
        next.extend(tree.children(h).unwrap_or(&[]).iter().copied());
    }
}

fn on_floor(
    tree: &Tree,
    ground: Option<Id>,
    mut node: Id,
    mut at: Vec3,
) -> Option<(Id, Vec3, Quat)> {
    let mut turn = Quat::IDENTITY;
    for _ in 0..64 {
        let n = tree.node(tree.handle(node)?)?;
        if Some(node) == ground || plain(n.kind().as_str()) == FLOOR {
            return Some((node, at, turn));
        }
        let p = n.place()?;
        at = p.position.plus(p.orientation.rotate(at).ok()?).ok()?;
        turn = p.orientation.then(turn).ok()?;
        node = n.parent()?;
    }
    None
}

impl Projection {
    /// Only changed subtrees are visited. Canonical slot parsing sees one affected thing, never the whole world.
    pub fn prepare(copy: &Replica, plan: &Planned, entries: &Json) -> Result<Self, Refused> {
        sim::commit::off_clock();
        let mut preview = copy.frozen();
        let committed = sim::edit::commit(
            &mut preview,
            &mut Minter::new(sim::edit::PROVISIONAL),
            plan,
            &[],
            0,
        )?;
        let named = |id| {
            committed
                .names
                .iter()
                .find(|(_, v)| **v == id)
                .map_or(Ref::Node(id), |(n, _)| Ref::New(*n))
        };
        let mut affected = BTreeSet::new();
        let mut edited = Vec::new();
        for op in &plan.checked.edit.ops {
            let id = match op {
                Op::Place { name, .. } => committed.names[name],
                Op::Move { node, .. } | Op::Remove { node } => match node {
                    Ref::Node(id) => *id,
                    Ref::New(n) => committed.names[n],
                },
                // These do not change immutable declared slots or ancestor poses.
                Op::Set { .. } | Op::Rows { .. } | Op::Doorway { .. } | Op::Link { .. } => continue,
            };
            subtree(copy.tree(), id, &mut affected);
            subtree(preview.tree(), id, &mut affected);
            edited.push(id);
        }
        let ground = crate::buildsafe::open_ground(&preview);
        let mut above = BTreeSet::new();
        for id in edited {
            for tree in [copy.tree(), preview.tree()] {
                let mut at = tree
                    .handle(id)
                    .and_then(|h| tree.node(h))
                    .and_then(|n| n.parent());
                while let Some(a) = at.filter(|a| Some(*a) != ground) {
                    above.insert(a);
                    at = tree
                        .handle(a)
                        .and_then(|h| tree.node(h))
                        .and_then(|n| n.parent());
                }
            }
        }
        let refresh = above
            .into_iter()
            .filter(|a| !affected.contains(a))
            .filter_map(|a| {
                let (floor, ..) = on_floor(preview.tree(), ground, a, Vec3::ZERO)?;
                (floor != a).then(|| (a, crate::places::footprint(preview.tree(), a, floor)))
            })
            .collect();
        let mut deltas = Vec::new();
        for thing in affected {
            let mut places = Vec::new();
            let mut own = Vec::new();
            if let Some(n) = preview
                .tree()
                .handle(thing)
                .and_then(|h| preview.tree().node(h))
            {
                // The entry the thing names in field 27 (a Mars seat borrows `eden:chair`), else its kind's: a moved
                // seat keeps its places as start-up gave them, at its own slots.
                let entry_kind = import_eden::entry_name(n.kind().as_str(), n.fields());
                if let Some(entry) = entries.get(entry_kind) {
                    let slots = import_eden::body_slots_of(
                        thing,
                        n.kind().as_str(),
                        n.fields(),
                        &[(entry_kind.to_owned(), entry.clone())],
                    );
                    for slot in slots {
                        let Some((floor, point, facing)) =
                            on_floor(preview.tree(), ground, thing, slot.at)
                        else {
                            continue;
                        };
                        if own.is_empty() {
                            own = crate::places::footprint(preview.tree(), thing, floor);
                        }
                        places.push((
                            PlaceAt {
                                thing,
                                place: replica::moves::Place {
                                    slot: slot.slot,
                                    height: slot.at.y.max(0),
                                    stand: [slot.stand.x - slot.at.x, slot.stand.z - slot.at.z],
                                },
                                point,
                                facing,
                                floor,
                            },
                            named(floor),
                        ));
                    }
                }
            }
            deltas.push((named(thing), places, own));
        }
        Ok(Self(deltas, refresh))
    }

    /// Rechecked on the commit tick, before any replica or slot mutation.
    pub fn check(&self, slots: &Slots) -> Result<(), Refused> {
        for (thing, ..) in &self.0 {
            if let Ref::Node(id) = thing
                && slots.holder(*id).is_some()
            {
                return Err(Refused {
                    op: None,
                    name: replica::edit::IN_USE,
                    detail: "an edited place is occupied".into(),
                });
            }
        }
        Ok(())
    }

    pub fn install(
        self,
        slots: &mut Slots,
        names: &BTreeMap<u64, Id>,
    ) -> Result<(), replica::effects::Refusal> {
        // Canonical slots have unique numbers, names come from this exact commit, and check() just confirmed
        // occupancy on this tick. No body step interleaves commit and install, so legal prepared input cannot
        // fail replacement after the replica has committed.
        let id = |r| match r {
            Ref::Node(id) => id,
            Ref::New(n) => names[&n],
        };
        for (thing, own) in self.1 {
            if slots.place(thing).is_some() {
                slots.footprint(thing, own);
            }
        }
        for (thing, places, own) in self.0 {
            let thing = id(thing);
            slots.footprint(thing, own);
            let places = places
                .into_iter()
                .map(|(mut p, floor)| {
                    p.thing = thing;
                    p.floor = id(floor);
                    p
                })
                .collect();
            slots.replace(thing, places)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #3826: a seat in a room is placed on the room's floor. Rooms are not map patches: a seat placed on the room
    /// had no standing place round it, and an ordinary walk to it was refused `spot-none-near`.
    #[test]
    fn a_seat_in_a_room_stands_on_the_rooms_floor() {
        let im = import_eden::load(&testworld::generate(1, 0).unwrap().text).unwrap();
        let (room, floor) = (im.nodes["building/r0a"], im.nodes["building/floor-0"]);
        let kind = |id| {
            plain(
                im.tree
                    .node(im.tree.handle(id).unwrap())
                    .unwrap()
                    .kind()
                    .as_str(),
            )
            .to_owned()
        };
        assert_eq!(
            (kind(room).as_str(), kind(floor).as_str()),
            (sim::ground::scene::ROOM, FLOOR)
        );
        let (on, ..) = on_floor(&im.tree, Some(im.nodes["ground"]), room, Vec3::ZERO)
            .expect("a floor under the room");
        assert_eq!(on, floor);
    }
}
