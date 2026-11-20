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
use sim::ground::scene::{FLOOR, ROOM};
use sim::slots::{PlaceAt, Slots};

pub struct Projection(Vec<(Ref, Vec<(PlaceAt, Ref)>)>);

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
        if Some(node) == ground || matches!(plain(n.kind().as_str()), FLOOR | ROOM) {
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
        for op in &plan.checked.edit.ops {
            let id = match op {
                Op::Place { name, .. } => committed.names[name],
                Op::Move { node, .. } | Op::Remove { node } => match node {
                    Ref::Node(id) => *id,
                    Ref::New(n) => committed.names[n],
                },
                // These do not change immutable declared slots or ancestor poses.
                Op::Set { .. } | Op::Doorway { .. } => continue,
            };
            subtree(copy.tree(), id, &mut affected);
            subtree(preview.tree(), id, &mut affected);
        }
        let ground = crate::buildsafe::open_ground(&preview);
        let mut deltas = Vec::new();
        for thing in affected {
            let mut places = Vec::new();
            if let Some(n) = preview
                .tree()
                .handle(thing)
                .and_then(|h| preview.tree().node(h))
            {
                let kind = plain(n.kind().as_str());
                if let Some(entry) = entries.get(kind) {
                    let one = Tree::start(thing, n.kind().clone());
                    let (slots, _) =
                        import_eden::body_slots(&one, &[(kind.to_owned(), entry.clone())]);
                    for slot in slots {
                        let Some((floor, point, facing)) =
                            on_floor(preview.tree(), ground, thing, slot.at)
                        else {
                            continue;
                        };
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
            deltas.push((named(thing), places));
        }
        Ok(Self(deltas))
    }

    /// Rechecked on the commit tick, before any replica or slot mutation.
    pub fn check(&self, slots: &Slots) -> Result<(), Refused> {
        for (thing, _) in &self.0 {
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
        for (thing, places) in self.0 {
            let thing = id(thing);
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
