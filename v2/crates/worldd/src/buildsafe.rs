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
//! - **Moving bodies** (G1d, #3462). The world's bodies ([`crate::bodies`], I4b) are not written to the tree, so the
//!   clock thread hands off, each tick, every body the controller holds as the controller has it ([`moving`]): where
//!   it stands, sits or lies, the link it is being carried across, and for a walker, the next corner of its line of
//!   corners as a second pose (`sim::walk::town`). The hand-off is a pointer swap ([`Moving`]), as the views take a
//!   tick and go on; the edit checker reads the newest, which is never older than the copy at the planned version
//!   (both are handed off at the end of a tick, the bodies first), and [`judged`] puts them in place of the tree's
//!   older copy of the same bodies.
//!
//! - **The town G2b's guard reads** (G1e, #3532). The edit checker plans each edit with `sim::edit::plan_on`, which
//!   cuts only what the edit can affect, on a town of its own ([`TownCopy`]) built from a frozen copy: once when the
//!   checker starts (while it waits for its first edit), and again from a newer copy once an edit has committed since
//!   ([`Moving::edited`]), so the map before an edit holds every edit committed before it. A zone without open ground,
//!   or whose town can't be built, is planned whole (`sim::edit::plan`), as before.
//! - **The one creator** (G1e). [`Creator`] holds the world's one creator as its directory record names it, read at
//!   the start and again on a change (`worldd serve`); every other actor's edit, and every edit while the record names
//!   none, is refused `edit.not-the-creator`.
//!
//! Not here: a body partway across a link on the tree (the tree holds no crossing), other body sizes, the stretch of
//! a walker's path between it and its next corner (it walks round what is put there).

use replica::apply::Replica;
use replica::ids::Id;
use replica::pose::{Frame, Pose, Support, Vec3};
use replica::tree::Rules;
use replica::world_model::{Kind, plain};
use sim::edit::safety::Who;
use sim::ground::scene::GROUND;
use sim::links::Doors;
use sim::routes::HANDS;
use sim::walk::town::Town;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::bodies::Bodies;

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

/// The bodies the clock thread last handed off (G1d): written once a tick by a pointer swap, read by the edit checker;
/// and the version after the last edit it committed (G1e).
#[derive(Default)]
pub struct Moving(Mutex<Arc<Vec<Who>>>, AtomicU64);

impl Moving {
    /// Clock thread: the tick's bodies replace the last.
    pub fn offer(&self, bodies: Vec<Who>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(bodies);
    }

    /// The newest bodies handed off.
    pub fn latest(&self) -> Arc<Vec<Who>> {
        Arc::clone(&self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Clock thread: an edit committed, leaving the live replica at `version`.
    pub fn committed(&self, version: u64) {
        self.1.fetch_max(version, Ordering::Release);
    }

    /// The version after the last edit committed: the edit checker's town is built again from a copy at least as new.
    pub fn edited(&self) -> u64 {
        self.1.load(Ordering::Acquire)
    }
}

/// The world's one creator as its directory record names it (G1e): `None` while it names none. There is never more
/// than one: a change replaces it.
#[derive(Debug, Default)]
pub struct Creator(Mutex<Option<Id>>);

impl Creator {
    pub fn new(creator: Option<Id>) -> Creator {
        Creator(Mutex::new(creator))
    }

    /// The creator now.
    pub fn get(&self) -> Option<Id> {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Replaces the creator; whether it changed.
    pub fn set(&self, creator: Option<Id>) -> bool {
        let mut c = self.0.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *c, creator) != creator
    }
}

/// The edit checker's own town (G1e), for G2b's guard on the town: built from a frozen copy, and built again from a
/// newer copy once an edit has committed after the copy it was built from. `None` inside: the copy's zone has no open
/// ground or its town could not be built, and edits are planned whole.
pub struct TownCopy {
    kinds: BTreeMap<String, Kind>,
    /// The version of the copy it was built from, its open ground, and the town.
    built: Option<(u64, Option<Id>, Option<Town>)>,
}

impl TownCopy {
    pub fn new(kinds: BTreeMap<String, Kind>) -> TownCopy {
        TownCopy { kinds, built: None }
    }

    /// The town as of `copy` (whose open ground is `ground`), built again when the one held is older than `edited`
    /// (the version after the last edit committed). Off the clock thread: a build cuts the whole ground.
    pub fn on(&mut self, copy: &Replica, ground: Option<Id>, edited: u64) -> Option<&Town> {
        let fresh = self
            .built
            .as_ref()
            .is_some_and(|(at, g, _)| *at >= edited && *g == ground);
        if !fresh {
            let rules = Rules {
                kinds: self.kinds.clone(),
                ..Rules::default()
            };
            let town = ground.and_then(|g| {
                let doors = Doors::new(copy.header().clone(), rules, copy.version());
                Town::new(copy.tree().frozen(), g, doors).ok()
            });
            self.built = Some((copy.version(), ground, town));
        }
        self.built.as_ref().and_then(|(_, _, t)| t.as_ref())
    }
}

/// Clock thread: each body the controller holds, as G2 judges it: where it stands, sits or lies, the link it is being
/// carried across, and, while it walks, again standing at the next corner of its line.
pub fn moving(bodies: &Bodies) -> Vec<Who> {
    let (runner, town) = (&bodies.runner, &bodies.town);
    let mut out = Vec::new();
    for b in runner.controller.bodies() {
        let who = Who {
            soul: b.id,
            body: b.id,
            pose: b.pose,
            has: HANDS,
            crossing: runner.controller.carrying(b.id),
        };
        out.push(who);
        let Some((node, [x, z])) = runner
            .running(b.id)
            .then(|| town.next_corner(b.id))
            .flatten()
        else {
            continue;
        };
        let y = if node == b.pose.frame.node {
            b.pose.position.y
        } else {
            0
        };
        out.push(Who {
            pose: Pose {
                frame: Frame { node, slot: None },
                position: Vec3::new(x, y, z),
                orientation: b.pose.orientation,
                support: Support::Surface {
                    surface: node,
                    height: 0,
                },
            },
            crossing: None,
            ..who
        });
    }
    out
}

/// The Souls G2 judges: the tree's bodies (`tree`, from [`souls`]), except those handed off as moving, which are
/// judged where the controller has them instead (the tree's copy of a body the controller holds is older).
pub fn judged(tree: Vec<Who>, moving: &[Who]) -> Vec<Who> {
    let held: BTreeSet<Id> = moving.iter().map(|w| w.body).collect();
    tree.into_iter()
        .filter(|w| !held.contains(&w.body))
        .chain(moving.iter().copied())
        .collect()
}
