//! What G2's safety rule judges a creator's edit against (Engine v2 G1c, #3456): the zone's real Souls and its open
//! ground, read off the clock thread from the frozen copy at the edit's planned version (BUILDSAFE: an edit that would
//! bury a Soul, cut it off or change what it uses is refused, not repaired).
//!
//! - **The open ground** is the node of the open ground's kind (`sim::ground::scene::GROUND`) nearest the root; a
//!   zone without one has none, and the rule then judges only what each body uses.
//! - **A Soul** is a node whose kind the world's kinds give the owner `family` (a body; `replica::world_model`). A
//!   Soul's intents name its body (`answers`'s `body_of`), so the body's id names the Soul. Its pose is where it
//!   stands, sits or lies: its frame (parent and slot) and its place there. What it holds, G2 reads from its slots on
//!   the same tree. Its abilities are today's walking body's, hands (`sim::walk::town` routes with them).
//!
//! Not here: a body partway across a link (the tree holds no crossing; none is passed), other body sizes.

use replica::apply::Replica;
use replica::ids::Id;
use replica::pose::{Frame, Pose};
use replica::world_model::{Kind, plain};
use sim::edit::safety::Who;
use sim::ground::scene::GROUND;
use sim::routes::HANDS;
use std::collections::{BTreeMap, VecDeque};

/// The owner of a body's kind (the entry format's `family`).
const FAMILY: &str = "family";

/// The zone's open ground on `copy`: the first node of the open ground's kind, breadth first from the root.
pub fn open_ground(copy: &Replica) -> Option<Id> {
    let tree = copy.tree();
    let mut queue = VecDeque::from([tree.root()]);
    while let Some(h) = queue.pop_front() {
        let n = tree.node(h)?;
        if plain(n.kind().as_str()) == GROUND {
            return Some(n.id());
        }
        queue.extend(tree.children(h).unwrap_or_default());
    }
    None
}

/// Every Soul's body on `copy`, in the tree's order (breadth first), as G2 judges it.
pub fn souls(copy: &Replica, kinds: &BTreeMap<String, Kind>) -> Vec<Who> {
    let tree = copy.tree();
    let mut out = Vec::new();
    let mut queue = VecDeque::from([tree.root()]);
    while let Some(h) = queue.pop_front() {
        let Some(n) = tree.node(h) else { continue };
        queue.extend(tree.children(h).unwrap_or_default());
        if kinds
            .get(n.kind().as_str())
            .is_none_or(|k| k.owner != FAMILY)
        {
            continue;
        }
        let (Some(parent), Some(place)) = (n.parent(), n.place()) else {
            continue;
        };
        out.push(Who {
            soul: n.id(),
            body: n.id(),
            pose: Pose {
                frame: Frame {
                    node: parent,
                    slot: n.slot(),
                },
                position: place.position,
                orientation: place.orientation,
                support: place.support,
            },
            has: HANDS,
            crossing: None,
        });
    }
    out
}
