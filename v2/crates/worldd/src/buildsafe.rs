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
//!   checker starts (while it waits for its first edit), then kept as each edit the clock commits leaves the ground
//!   ([`Moving::committed`]), so the map before an edit holds every edit committed before it. A zone without open
//!   ground, or whose town can't be built, is planned whole (`sim::edit::plan`), as before.
//! - **The one creator** (G1e). [`Creator`] holds the world's one creator as its directory record names it, read at
//!   the start and again on a change (`worldd serve`); every other actor's edit, and every edit while the record names
//!   none, is refused `edit.not-the-creator`.
//!
//! Not here: a body partway across a link on the tree (the tree holds no crossing), other body sizes, the stretch of
//! a walker's path between it and its next corner (it walks round what is put there).

use replica::apply::Replica;
use replica::effects::Part;
use replica::encode::encode;
use replica::ids::Id;
use replica::kinds::sizes::Size;
use replica::pose::{Frame, Pose, Support, Vec3};
use replica::tree::Rules;
use replica::world_model::{Kind, plain};
use sim::edit::safety::Who;
use sim::ground::Versions;
use sim::ground::scene::GROUND;
use sim::links::Doors;
use sim::routes::HANDS;
use sim::walk::town::{Basis, Rebuilt, Town};
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
/// and the edits it committed since the checker last took them (G1e).
#[derive(Default)]
pub struct Moving(Mutex<Arc<BodySnapshot>>, Mutex<Vec<Arc<Part>>>, AtomicU64);

/// The authoritative map's immutable preparation input. Basis clones only its existing shared handles.
#[derive(Default)]
pub struct BodySnapshot {
    pub bodies: Arc<Vec<Who>>,
    pub classes: BTreeMap<Id, Size>,
    pub movers: Vec<sim::controller::BuildBasis>,
    pub map: Option<Arc<MapBasis>>,
}

pub struct MapBasis {
    pub version: u64,
    pub ground: Id,
    pub stamp: Arc<Versions>,
    pub basis: Basis,
}

/// Two installations prepared off-clock from the same canonical part and authoritative basis.
pub struct PreparedMaps {
    pub part: Arc<Part>,
    pub before: Arc<Versions>,
    pub after: Arc<Versions>,
    pub live: Rebuilt,
    pub worker: Rebuilt,
    pub rebinds: Vec<sim::controller::PreparedRebind>,
    /// The (class, node) surfaces `rebinds` were placed on, kept for a reprepare (B12b) and released off the clock.
    pub surfaces: sim::walk::town::RebindSurfaces,
}

impl PreparedMaps {
    pub fn prepare(
        copy: &Replica,
        planned: &sim::edit::Planned,
        reserved: replica::ids::Minter,
        souls: &[Who],
        source: &MapBasis,
    ) -> Result<Self, replica::edit::Refused> {
        Self::prepare_classes(
            copy,
            planned,
            reserved,
            souls,
            source,
            &BTreeMap::new(),
            &[],
        )
    }
    pub fn prepare_classes(
        copy: &Replica,
        planned: &sim::edit::Planned,
        mut reserved: replica::ids::Minter,
        souls: &[Who],
        source: &MapBasis,
        classes: &BTreeMap<Id, Size>,
        movers: &[sim::controller::BuildBasis],
    ) -> Result<Self, replica::edit::Refused> {
        let mut preview = copy.frozen();
        let part =
            sim::edit::commit_classes(&mut preview, &mut reserved, planned, souls, 0, classes)?
                .part;
        Self::prepare_part(copy, part, source, movers)
    }

    /// The same preparation for a part already made off the clock (a set-down's, #3604), not an edit's plan.
    pub fn prepare_part(
        copy: &Replica,
        part: Arc<Part>,
        source: &MapBasis,
        movers: &[sim::controller::BuildBasis],
    ) -> Result<Self, replica::edit::Refused> {
        let rebuilt = Town::rebuild(
            copy.tree().frozen(),
            copy.header(),
            source.ground,
            &source.stamp,
            &source.basis,
            &part,
        )
        .map_err(|detail| replica::edit::Refused {
            op: None,
            name: "edit.map-unchecked",
            detail,
        })?;
        let (surfaces, rebinds) = rebuilt
            .prepare_rebind_surfaces(movers, source.ground)
            .map_err(|r| replica::edit::Refused {
                op: None,
                name: r.name,
                detail: r.detail,
            })?;
        let (live, worker) = rebuilt.into_pair();
        Ok(Self {
            part,
            before: Arc::clone(&source.stamp),
            after: Arc::new(live.versions.clone()),
            live,
            worker,
            rebinds,
            surfaces,
        })
    }

    /// Off the clock (B12b): places exactly the edit's affected bodies again, as they stand now, on the kept
    /// surfaces. Nothing else changes: the map, the part and the bodies judged are the ones first prepared.
    pub fn reprepare(
        &mut self,
        current: &[sim::controller::BuildBasis],
    ) -> Result<(), replica::edit::Refused> {
        let same = current.len() == self.rebinds.len()
            && current
                .iter()
                .zip(&self.rebinds)
                .all(|(c, r)| c.moved.id == r.before.moved.id);
        if !same {
            return Err(replica::edit::Refused {
                op: None,
                name: "edit.body-stale",
                detail: "affected bodies changed".into(),
            });
        }
        self.rebinds = self
            .surfaces
            .place(current)
            .map_err(|r| replica::edit::Refused {
                op: None,
                name: r.name,
                detail: r.detail,
            })?;
        Ok(())
    }
}

impl Moving {
    /// Clock thread: a shared map basis, never a geometry build or whole-tree copy.
    pub fn offer_map(&self, bodies: &Bodies, version: u64) {
        let map = Arc::new(MapBasis {
            version,
            ground: bodies.town.ground,
            stamp: Arc::clone(&bodies.form_map),
            basis: bodies.town.basis(),
        });
        let classes = bodies
            .runner
            .controller
            .ids()
            .filter_map(|id| {
                let size = bodies.runner.controller.build(id)?.size;
                (size != Size::Standard).then_some((id, size))
            })
            .collect();
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(BodySnapshot {
            bodies: Arc::new(moving(bodies)),
            classes,
            movers: bodies
                .runner
                .controller
                .bodies()
                .filter_map(|b| bodies.runner.controller.build_basis(b.id))
                .collect(),
            map: Some(map),
        });
    }

    pub fn map(&self) -> Option<Arc<MapBasis>> {
        self.current().map.clone()
    }

    /// Clock thread: the tick's bodies replace the last.
    pub fn offer(&self, bodies: Vec<Who>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(BodySnapshot {
            bodies: Arc::new(bodies),
            ..BodySnapshot::default()
        });
    }

    /// The newest bodies handed off.
    pub fn latest(&self) -> Arc<Vec<Who>> {
        Arc::clone(&self.current().bodies)
    }

    pub fn current(&self) -> Arc<BodySnapshot> {
        Arc::clone(&self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Clock thread: an edit committed as `part`, leaving the live replica at `version`.
    pub fn committed(&self, part: Arc<Part>, version: u64) {
        self.1.lock().unwrap_or_else(|e| e.into_inner()).push(part);
        self.2.fetch_max(version, Ordering::Release);
    }

    /// The version after the last edit committed: a copy at least as new holds every edit.
    pub fn edited(&self) -> u64 {
        self.2.load(Ordering::Acquire)
    }

    /// The edits committed since the last take, in order.
    pub fn take(&self) -> Vec<Arc<Part>> {
        std::mem::take(&mut *self.1.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// The world's one creator as its directory record names it (G1e): `None` while it names none. There is never more
/// than one: a change replaces it.
type CreatorReader = std::sync::Arc<dyn Fn() -> Option<Id> + Send + Sync>;
#[derive(Default)]
pub struct Creator(Mutex<Option<Id>>, Option<CreatorReader>);

impl std::fmt::Debug for Creator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Creator").field(&self.0).finish()
    }
}

impl Creator {
    pub fn new(creator: Option<Id>) -> Creator {
        Creator(Mutex::new(creator), None)
    }

    /// An existing off-clock admission reads the current authority, failing closed when unavailable.
    pub fn with_reader(creator: Option<Id>, read: CreatorReader) -> Creator {
        Creator(Mutex::new(creator), Some(read))
    }

    /// The creator now. No call is made from the clock thread.
    pub fn get(&self) -> Option<Id> {
        match &self.1 {
            Some(read) => read(),
            None => *self.0.lock().unwrap_or_else(|e| e.into_inner()),
        }
    }

    /// Replaces the creator; whether it changed.
    pub fn set(&self, creator: Option<Id>) -> bool {
        let mut c = self.0.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *c, creator) != creator
    }
}

/// The edit checker's own town (G1e), for G2b's guard on the town: built whole from a frozen copy once (3.1 s on
/// Eden), then kept as each committed edit leaves the ground, as the walkers' town is (G3b: `Town::rebuild`, then
/// `Town::install`, cutting again only the squares and floors the edit touches). An edit it can't install (its tree
/// is the copy's as built, without what else the world wrote since) has the town built whole again from a copy that
/// holds it. `None` inside: the copy's zone has no open ground or its town could not be built; edits are planned whole.
pub struct TownCopy {
    kinds: BTreeMap<String, Kind>,
    /// The version up to which it holds every committed edit, its open ground, and the town.
    built: Option<(u64, Option<Id>, Option<Town>)>,
}

/// The version after a part's last entry.
fn after(part: &Part) -> u64 {
    part.effects
        .last()
        .map_or(0, |e| e.envelope.sequence.saturating_add(1))
}

/// `part` with its entries numbered from `next`.
fn renumbered(part: &Part, next: u64) -> Option<Part> {
    let mut p = part.clone();
    for (k, e) in p.effects.iter_mut().enumerate() {
        e.envelope.sequence = next + k as u64;
    }
    Part::read(&encode(&p.to_value()).ok()?).ok()
}

impl TownCopy {
    pub fn new(kinds: BTreeMap<String, Kind>) -> TownCopy {
        TownCopy { kinds, built: None }
    }

    /// The town as of `copy` (whose open ground is `ground`) with the edits `committed` since the last call installed;
    /// built whole from `copy` when there is none yet, the ground differs, or an edit can't be installed. `copy` holds
    /// every edit committed. Off the clock thread.
    pub fn on(
        &mut self,
        copy: &Replica,
        ground: Option<Id>,
        committed: &[Arc<Part>],
    ) -> Option<&mut Town> {
        let mut whole = !matches!(&self.built, Some((_, g, _)) if *g == ground);
        if let Some((at, _, Some(town))) = &mut self.built {
            for p in committed {
                if after(p) <= *at {
                    continue;
                }
                // The town's tree has the edits, not what else the world wrote between them: the edit's entries are
                // numbered on from the town's own, as `Town::install` numbers them.
                let header = town.doors.header.clone();
                let installed = renumbered(p, town.doors.next).and_then(|p| {
                    let r = Town::rebuild(
                        town.tree.frozen(),
                        &header,
                        town.ground,
                        &town.versions,
                        &town.basis(),
                        &p,
                    )
                    .ok()?;
                    town.install(r, &p).ok()
                });
                if installed.is_none() {
                    whole = true;
                    break;
                }
                *at = after(p);
            }
        }
        if whole {
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
        self.built.as_mut().and_then(|(_, _, t)| t.as_mut())
    }
}
/// Clock thread: each body the controller holds, as G2 judges it: where it stands, sits or lies, the link it is being
/// carried across, and, while it walks, again standing at the next corner of its line.
pub fn moving(bodies: &Bodies) -> Vec<Who> {
    let (runner, town) = (&bodies.runner, &bodies.town);
    let mut out = Vec::new();
    for id in runner.controller.ids() {
        let Some(b) = runner.controller.body(id) else {
            continue;
        };
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

#[cfg(test)]
mod w16_authority_tests {
    use super::*;
    #[test]
    fn w16_current_reader_is_authoritative_and_unavailable_never_uses_cached_founder() {
        let a = Id::new(replica::ids::Scope([1; 16]), 0).unwrap();
        let b = Id::new(replica::ids::Scope([2; 16]), 0).unwrap();
        let current = Arc::new(Mutex::new(Some(a)));
        let read = current.clone();
        let creator = Creator::with_reader(Some(a), Arc::new(move || *read.lock().unwrap()));
        assert_eq!(creator.get(), Some(a));
        *current.lock().unwrap() = None;
        creator.set(Some(a));
        assert_eq!(creator.get(), None);
        *current.lock().unwrap() = Some(b);
        assert_eq!(creator.get(), Some(b));
        let standalone = Creator::new(Some(a));
        assert_eq!(standalone.get(), Some(a));
        standalone.set(Some(b));
        assert_eq!(standalone.get(), Some(b));
    }
}

#[cfg(test)]
mod class_snapshot_tests {
    use super::*;
    use replica::bodies::{Class, Family, Resource, SkillShape, Want};
    use replica::encode::Name;
    use replica::ids::Scope;
    use replica::kinds::sizes::Build;
    use replica::pose::Quat;
    #[test]
    fn seated_large_body_keeps_its_actual_class_and_current_pose_in_the_guard_snapshot() {
        let facts = testworld::generate(1, 0).unwrap();
        let imported = import_eden::load(&facts.text).unwrap();
        let root = imported.nodes["world"];
        let ground = imported.nodes["ground"];
        let header = import_eden::header(root, &imported.rules).unwrap();
        let next = imported.tree.to_state().next;
        let mut town = Town::new(
            imported.tree,
            ground,
            Doors::new(header, imported.rules, next),
        )
        .unwrap();
        town.prepare_classes([Size::Large]).unwrap();
        let id = Id::new(Scope([0x56; 16]), 1).unwrap();
        let build = Build {
            size: Size::Large,
            ..Build::STANDARD
        };
        let moved = town.surfaces_for(Size::Large).unwrap()[&ground]
            .place_built(
                id,
                Frame {
                    node: ground,
                    slot: None,
                },
                Vec3::new(-40_000_000, 0, 30_000_000),
                Quat::IDENTITY,
                build,
            )
            .unwrap();
        let mut bodies = Bodies::new(town, 50_000).unwrap();
        let family = Family {
            name: Name::new("souls:humanoid").unwrap(),
            resources: vec![Resource {
                name: Name::new("souls:legs").unwrap(),
                class: Class::Locomotion,
                slot: None,
            }],
        };
        bodies.add_body_built(family, moved, build).unwrap();
        let shape = SkillShape {
            name: Name::new("souls:sit").unwrap(),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: Vec::new(),
            cancelled_by: Vec::new(),
        };
        let driver = bodies.runner.controller.claim(id, &shape).unwrap();
        bodies
            .runner
            .controller
            .slot_in(
                id,
                driver,
                Frame {
                    node: ground,
                    slot: Some(1),
                },
                0,
            )
            .unwrap();
        assert_eq!(bodies.runner.controller.bodies().count(), 0);
        let moving = Moving::default();
        moving.offer_map(&bodies, 0);
        let snapshot = moving.current();
        assert_eq!(snapshot.classes.get(&id), Some(&Size::Large));
        assert_eq!(
            snapshot
                .bodies
                .iter()
                .find(|b| b.body == id)
                .unwrap()
                .pose
                .support,
            Support::Slot
        );
        assert!(
            snapshot.movers.is_empty(),
            "slot-owned actors are not surface-rebound"
        );
        assert_eq!(bodies.classes().get(&id), Some(&Size::Large));
    }
}
