//! What G2's safety rule judges a creator's edit against (Engine v2 G1c, #3456): the zone's real Souls and its open
//! ground, read off the clock thread from the frozen copy at the edit's planned version (BUILDSAFE: an edit that would
//! bury a Soul, cut it off or change what it uses is refused, not repaired).
//!
//! - **The open ground** is the node of the open ground's kind (`sim::ground::scene::GROUND`) nearest the root; a
//!   zone without one has none, and the rule then judges only what each body uses.
//! - **A Soul** is a node whose kind the world's kinds give the owner `family` (a body; `replica::world_model`). A
//!   Soul's intents name its body (`answers`'s `body_of`), so the body's id names the Soul. Its pose is where it
//!   stands, sits or lies: its frame (parent and slot) and its place there. What it holds, G2 reads from its slots on
//!   the same tree. Its abilities are today's walking body's, hands and the climb (`sim::walk::water::WALKER`, which
//!   `sim::walk::town` routes with).
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
//! - **A thing placed new** ([`stand_as_kinds`]). A place of a boot kind carries no solids of its own (the old page
//!   and `souls-god place` send none), so before the check it is given its kind's walk outline from its entry's
//!   bounds: G2 then refuses it on a standing Soul (`edit.would-bury`), as it refuses an existing thing moved there.
//!   It is given its kind's slot points too, as the import gives a seeded thing's, so a stand or a bay placed live
//!   holds its parts at those points and a crew can take and seat them (`part-pose` otherwise).
//!
//! Not here: a body partway across a link on the tree (the tree holds no crossing), other body sizes, the stretch of
//! a walker's path between it and its next corner (it walks round what is put there).

use replica::apply::Replica;
use replica::effects::Part;
use replica::encode::encode;
use replica::ids::Id;
use replica::kinds::sizes::Size;
use replica::pose::{Frame, Pose, Support, Vec3};
use replica::rules::json::Value as Json;
use replica::tree::Rules;
use replica::world_model::{Kind, plain};
use sim::edit::safety::Who;
use sim::ground::Versions;
use sim::ground::scene::{F_SLOTS, F_SOLIDS, GROUND};
use sim::links::Doors;
use sim::walk::town::{Basis, Rebuilt, Town};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

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

/// A thing placed new stands as its kind's bounds say: each place of a boot kind whose entry (in `entries`, by the
/// entry the thing names, else its kind's plain name) gives `geometry.bounds_mm` gets its walk outline as its solids
/// (N1's field 12), unless the batch gives its own. Without it a placed thing has no footprint when the edit is
/// checked, so G2 would let it land on a standing Soul; with it, G2 judges what it would bury before it commits
/// (`edit.would-bury`, naming the Soul) and walkers go round it, as `replica::edit::check` does for a creator's kind.
///
/// Its slot points (field 13) too, unless the batch gives its own, as the import writes a seeded thing's
/// ([`replica::kinds::defined::slots_of`]): without them a part on a stand or in a bay placed live has no point to
/// stand from, so a crew's `part:take` of it is refused `part-pose` and a `part:put` into it `slot.unknown`. A thing
/// whose slots take parts (`structure`'s, ones that stand or bear) gets no walk box. A bay is the frame its seated
/// parts make, and they cut the ground once seated, as in a bay seeded from a world's facts; a box would keep its
/// builders out. A frame stand is the low rest its parts stand on, walked over as a seeded one is; a box would stop a
/// crew's carry (`carry-load-blocked`) where the part comes down into it, and the put would be refused `part.not-held`.
pub fn stand_as_kinds(
    edit: &mut replica::edit::Edit,
    entries: &Json,
    structure: &sim::structure::Structure,
    parts: &BTreeSet<u64>,
) {
    for op in &mut edit.ops {
        let replica::edit::Op::Place {
            name, kind, fields, ..
        } = op
        else {
            continue;
        };
        // A placed building's own parts (`with_buildings`) stand as its plan says, as a template's do.
        if parts.contains(name) {
            continue;
        }
        let Some(entry) = entries.get(import_eden::entry_name(kind.as_str(), fields)) else {
            continue;
        };
        let (solids, slots) = (
            replica::kinds::defined::solids_of(entry),
            replica::kinds::defined::slots_of(entry),
        );
        if let Some(s) = solids
            && !holds_parts(entry, structure)
        {
            fields.entry(F_SOLIDS).or_insert(s);
        }
        if let Some(s) = slots {
            fields.entry(F_SLOTS).or_insert(s);
        }
    }
}

/// A building placed new brings its rooms (#5006, row 20): each place of a kind whose entry keeps a `building` section
/// (`import_eden::placed`) gets, in the same batch, its walls, floors, rooms, windows, doors, doorways and stairs, as
/// a template's building has them, so a Soul can walk in, up and out of one a creator placed. A place of a kind whose
/// entry declares ways instead (`geometry.floors`, `stairs`, `ladders`: a frame, a sheet, a stair flight) gets the
/// floors and the stair and ladder links the import gives a seeded thing of it (`import_eden::placed::way_ops`), so
/// a Soul walks up a creator-placed bay's stair onto its deck and climbs its frames. The operations are added
/// after the batch's own, so a refusal still names the creator's operations by their places; the world then checks,
/// judges (BUILDSAFE: a Soul standing where a wall or floor would go refuses the whole place) and records the batch
/// as one edit, and one undo takes it all back.
///
/// Left as it is: a place that gives its own solids (a clone's or an import's copy, which brings its own rooms in its
/// next edits), one whose batch already places a floor in it, a kind the world does not let hold a floor, every place
/// in a world that pins no floor or room kind, and a helper's edit under a build claim. The world reserved the parts'
/// ids when it took the edit in ([`parts_ids`]); a batch its parts would take over `OPS_MOST` is refused at the
/// building's place, saying so. A plan the mapping cannot read refuses the edit
/// (`edit.building-plan`), never placing a shell. Gives the batch names of the parts it placed, which
/// [`stand_as_kinds`] leaves as the plan has them (a structural window is no furniture window's box).
pub fn with_buildings(
    edit: &mut replica::edit::Edit,
    entries: &Json,
    kinds: &BTreeMap<String, Kind>,
) -> Result<BTreeSet<u64>, replica::edit::Refused> {
    use import_eden::placed::{Parts, ops};
    use replica::edit::{Op, Ref};
    use sim::ground::scene::{FLOOR, ROOM, WINDOW};
    const DOOR: &str = "eden:door";
    let pinned = |p: &str| kinds.keys().find(|k| plain(k) == p).map(String::as_str);
    let (Some(floor), Some(room)) = (pinned(FLOOR), pinned(ROOM)) else {
        return Ok(BTreeSet::new());
    };
    let admits = |parent: &str, child: &str, category: Option<&str>| {
        kinds.get(parent).is_some_and(|k| {
            k.children.contains(child) || category.is_some_and(|c| k.children.contains(c))
        })
    };
    // A helper's edit under a build claim keeps its places as they are: an outside doorway's far end, the open ground,
    // is judged at the world's origin, outside every claim, so its building would be refused whole.
    if edit.claim.is_some() {
        return Ok(BTreeSet::new());
    }
    let Some(mut next) = edit
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Place { name, .. } | Op::Doorway { name, .. } | Op::Link { name, .. } => {
                Some(*name)
            }
            _ => None,
        })
        .max()
        .unwrap_or(0)
        .checked_add(1)
    else {
        return Ok(BTreeSet::new());
    };
    let floored: BTreeSet<u64> = edit
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Place {
                kind,
                parent: Ref::New(p),
                ..
            } if plain(kind.as_str()) == FLOOR => Some(*p),
            _ => None,
        })
        .collect();
    let mut added = Vec::new();
    let edit_len = edit.ops.len();
    for (k, op) in edit.ops.iter_mut().enumerate() {
        let Op::Place {
            name,
            kind,
            parent,
            fields,
            ..
        } = op
        else {
            continue;
        };
        let Some(entry) = entries.get(import_eden::entry_name(kind.as_str(), fields)) else {
            continue;
        };
        // A kind that declares ways (racks, lane C: a frame's ladders and standing places, a sheet's top, a stair
        // flight) brings the floors and the stair and ladder links the import gives a seeded thing of it.
        if entry.get("building").is_none() {
            if fields.contains_key(&F_SOLIDS)
                || floored.contains(name)
                || !admits(kind.as_str(), FLOOR, None)
            {
                continue;
            }
            let more = import_eden::placed::way_ops(entry, Ref::New(*name), floor, &mut next)
                .map_err(|detail| replica::edit::Refused {
                    op: Some(k),
                    name: "edit.building-plan",
                    detail: format!("{}: its ways could not be read: {detail}", plain(kind.as_str())),
                })?;
            if edit_len + added.len() + more.len() > replica::edit::OPS_MOST {
                return Err(replica::edit::Refused {
                    op: Some(k),
                    name: "edit.too-many-operations",
                    detail: format!(
                        "{} brings {} parts (its floors and their ways), which takes this batch over {}: place fewer in one batch",
                        plain(kind.as_str()),
                        more.len(),
                        replica::edit::OPS_MOST
                    ),
                });
            }
            added.extend(more);
            continue;
        }
        if fields.contains_key(&F_SOLIDS)
            || floored.contains(name)
            || !admits(kind.as_str(), FLOOR, None)
        {
            continue;
        }
        let door = pinned(DOOR).filter(|d| admits(kind.as_str(), plain(d), Some("thing")));
        let parts = Parts {
            floor,
            room,
            window: pinned(WINDOW),
            door,
        };
        let more =
            ops(entry, Ref::New(*name), *parent, fields, &parts, &mut next).map_err(|detail| {
                replica::edit::Refused {
                    op: Some(k),
                    name: "edit.building-plan",
                    detail: format!(
                        "{}: its rooms could not be read: {detail}",
                        plain(kind.as_str())
                    ),
                }
            })?;
        if edit_len + added.len() + more.len() > replica::edit::OPS_MOST {
            return Err(replica::edit::Refused {
                op: Some(k),
                name: "edit.too-many-operations",
                detail: format!(
                    "{} brings {} parts (floors, rooms, doors and their ways), which takes this batch over {}: place fewer buildings in one batch",
                    plain(kind.as_str()),
                    more.len(),
                    replica::edit::OPS_MOST
                ),
            });
        }
        added.extend(more);
    }
    let parts = added
        .iter()
        .filter_map(|op| match op {
            Op::Place { name, .. } => Some(*name),
            _ => None,
        })
        .collect();
    edit.ops.extend(added);
    Ok(parts)
}

/// The most new ids each building kind's place can mint with its parts, by entry name
/// (`import_eden::placed::ids_most`): what the world reserves for each such place when it takes an edit in. A kind
/// that declares a link (a part that joins: a beam, a joist, a sheet) may be placed into a bay's slot, where the
/// world adds a joint to each part it rests on ([`crate::edit_joins`]): at most one per other slot of the bay, so as
/// many as the most slots any kind's entry names kinds for.
pub fn ids_most(entries: &Json) -> BTreeMap<String, u64> {
    let all = entries.obj().unwrap_or(&[]);
    let bay_slots = all
        .iter()
        .filter_map(|(_, e)| e.get("slots").and_then(Json::obj))
        .filter(|s| s.iter().any(|(_, x)| x.get("kinds").is_some()))
        .map(|s| s.len() as u64)
        .max()
        .unwrap_or(0);
    all.iter()
        .filter_map(|(k, e)| {
            let joins = e
                .get("links")
                .and_then(Json::obj)
                .is_some_and(|l| !l.is_empty());
            let parts = import_eden::placed::ids_most(e).or_else(|| import_eden::placed::way_ids_most(e));
            match (parts, joins) {
                (None, false) => None,
                (p, j) => Some((k.clone(), p.unwrap_or(0) + if j { bay_slots } else { 0 })),
            }
        })
        .collect()
}

/// How many ids `edit`'s places of building kinds may mint with their parts beyond its own operations' ([`ids_most`]),
/// as [`with_buildings`] would add them, and its places of parts the joints [`crate::edit_joins`] adds. Under a build
/// claim no building brings parts, but a part placed into a bay's slot is still joined: the count is the same, at most
/// a few ids more than are minted.
pub fn parts_ids(edit: &replica::edit::Edit, most: &BTreeMap<String, u64>) -> u64 {
    edit.ops
        .iter()
        .filter_map(|op| match op {
            replica::edit::Op::Place { kind, fields, .. } => most
                .get(import_eden::entry_name(kind.as_str(), fields))
                .copied(),
            _ => None,
        })
        .fold(0, u64::saturating_add)
}

/// Whether a kind's entry has a slot that takes a part `structure` reads (one that stands or one that bears): a bay's,
/// a frame stand's.
fn holds_parts(entry: &Json, structure: &sim::structure::Structure) -> bool {
    entry
        .get("slots")
        .and_then(Json::obj)
        .unwrap_or(&[])
        .iter()
        .filter_map(|(_, s)| s.get("kinds").and_then(Json::arr))
        .flatten()
        .filter_map(Json::str)
        .any(|k| structure.is_part(k))
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
            has: sim::walk::water::WALKER,
            crossing: None,
        });
    }
    out
}

/// The bodies the clock thread last handed off (G1d): written once a tick by a pointer swap, read by the edit checker;
/// and the edits it committed since the checker last took them (G1e), with the edit checker's town as the boot built
/// it (#3743), handed off once.
///
/// The clock builds a snapshot only when the edit checker has asked for one since the last ([`Moving::fresh`], S10):
/// at 750 bodies a build cost 2-3.7 ms of every tick, and edits are rare. Each check job carries the tick it was sent
/// at; the checker uses a snapshot built at that tick or later, waiting for the clock's next build when it has none,
/// and never one older.
#[derive(Default)]
pub struct Moving(
    Mutex<Arc<BodySnapshot>>,
    Mutex<Taken>,
    AtomicU64,
    AtomicBool,
    Asked,
);

/// The edit checker's asks for a fresh snapshot (S10): whether one is wanted, and the tick the newest was built at,
/// which a waiting checker watches; and whether the clock has stopped, so a checker waiting with no deadline wakes.
#[derive(Default)]
pub struct Asked {
    wanted: AtomicBool,
    built: Mutex<u64>,
    done: Condvar,
    closed: AtomicBool,
}

/// What the clock thread handed the edit checker since it last took (#3743): the town to seed its own with, once,
/// and each edit committed, in order.
#[derive(Default)]
pub struct Taken {
    pub seed: Option<(u64, Town)>,
    pub parts: Vec<Committed>,
}

/// An edit committed (G1e), with the ground prepared for it for the edit checker's town to install (#3743): the
/// third copy of the ground [`PreparedMaps`] built, so that town is not built again. None when no map was prepared.
pub struct Committed {
    pub part: Arc<Part>,
    pub map: Option<Rebuilt>,
}

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
    /// The edit checker's copy (#3743), handed back with the committed part ([`Moving::committed`]).
    pub checker: Option<Rebuilt>,
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
            None,
            reserved,
            souls,
            source,
            &BTreeMap::new(),
            &[],
        )
    }
    /// `kept` is the ground the plan's guard built (#3743): installed instead of building it again when it is for the
    /// same part on the same open ground, versions and basis ([`sim::edit::PlannedMap::reuse`]); otherwise built here.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_classes(
        copy: &Replica,
        planned: &sim::edit::Planned,
        kept: Option<sim::edit::PlannedMap>,
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
        let kept = kept.and_then(|k| k.reuse(&part, source.ground, &source.stamp, &source.basis));
        Self::prepare_rebuilt(copy, part, source, movers, kept)
    }

    /// The same preparation for a part already made off the clock (a set-down's, #3604), not an edit's plan.
    pub fn prepare_part(
        copy: &Replica,
        part: Arc<Part>,
        source: &MapBasis,
        movers: &[sim::controller::BuildBasis],
    ) -> Result<Self, replica::edit::Refused> {
        Self::prepare_rebuilt(copy, part, source, movers, None)
    }

    /// The ground for `part`: `kept` when the plan's guard already built it (#3743), else built here; then the rebinds.
    fn prepare_rebuilt(
        copy: &Replica,
        part: Arc<Part>,
        source: &MapBasis,
        movers: &[sim::controller::BuildBasis],
        kept: Option<Rebuilt>,
    ) -> Result<Self, replica::edit::Refused> {
        let rebuilt = match kept {
            Some(r) => r,
            None => Town::rebuild(
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
            })?,
        };
        let (surfaces, rebinds) = rebuilt
            .prepare_rebind_surfaces(movers, source.ground)
            .map_err(|r| replica::edit::Refused {
                op: None,
                name: r.name,
                detail: r.detail,
            })?;
        let (live, worker) = rebuilt.into_pair();
        let checker = Some(live.copy());
        Ok(Self {
            part,
            before: Arc::clone(&source.stamp),
            after: Arc::new(live.versions.clone()),
            live,
            worker,
            checker,
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
    /// Clock thread: a shared map basis, never a geometry build or whole-tree copy. The first offer, at boot before the
    /// first tick, also hands the edit checker a memory copy of the town to seed its own with (#3743).
    /// `tick` is the tick whose bodies these are: the snapshot is that tick's.
    pub fn offer_map(&self, bodies: &Bodies, version: u64, tick: u64) {
        // Seeded already and nobody asked since the last: nothing to build (S10).
        if self.3.load(Ordering::Acquire) && !self.4.wanted.swap(false, Ordering::AcqRel) {
            return;
        }
        self.build(bodies, version, tick);
    }

    /// Clock thread, as it stops (its queue to the checker dropped, for any reason): no snapshot comes any more, so a
    /// checker waiting for one wakes and refuses its job (S10c).
    pub fn close(&self) {
        let _built = self.4.built.lock().unwrap_or_else(|e| e.into_inner());
        self.4.closed.store(true, Ordering::Release);
        self.4.done.notify_all();
    }

    /// Clock thread: whether the edit checker has asked for a snapshot since the last build (S10).
    pub fn asked(&self) -> bool {
        self.4.wanted.load(Ordering::Acquire)
    }

    /// Clock thread: the edit checker will want a snapshot (a check job is sent): the next offer builds one.
    pub fn want(&self) {
        self.4.wanted.store(true, Ordering::Release);
    }

    fn build(&self, bodies: &Bodies, version: u64, tick: u64) {
        if !self.3.swap(true, Ordering::AcqRel) {
            let town = bodies.town.duplicate();
            self.1.lock().unwrap_or_else(|e| e.into_inner()).seed = Some((version, town));
        }
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
        let mut built = self.4.built.lock().unwrap_or_else(|e| e.into_inner());
        *built = (*built).max(tick);
        self.4.done.notify_all();
    }

    /// Edit checker: the bodies as the clock had them at tick `need` or later (S10): a check job's sending tick. With
    /// no such snapshot yet it asks and waits for the clock's next build, at most `wait`; past that it is `Err` with
    /// the newest there is, which a check must refuse by a name its sender may try again (`edit.stale`), never use.
    /// With no `wait` (lockstep) it waits as long as the build takes, so the answer never depends on the machine's
    /// speed: a lockstep clock builds the asked snapshot before it runs another tick. Either wait ends, `Err`, once
    /// the clock has stopped ([`Moving::close`]).
    pub fn fresh(
        &self,
        need: u64,
        wait: Option<std::time::Duration>,
    ) -> Result<Arc<BodySnapshot>, Arc<BodySnapshot>> {
        let built = self.4.built.lock().unwrap_or_else(|e| e.into_inner());
        if *built < need {
            self.4.wanted.store(true, Ordering::Release);
        }
        let built = match wait {
            Some(wait) => {
                self.4
                    .done
                    .wait_timeout_while(built, wait, |n| {
                        *n < need && !self.4.closed.load(Ordering::Acquire)
                    })
                    .unwrap_or_else(|e| e.into_inner())
                    .0
            }
            None => self
                .4
                .done
                .wait_while(built, |n| {
                    *n < need && !self.4.closed.load(Ordering::Acquire)
                })
                .unwrap_or_else(|e| e.into_inner()),
        };
        let ok = *built >= need;
        drop(built);
        if ok {
            Ok(self.current())
        } else {
            Err(self.current())
        }
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

    /// Clock thread: an edit committed as `part`, leaving the live replica at `version`, with the ground prepared for
    /// it for the edit checker's town (#3743).
    pub fn committed(&self, part: Arc<Part>, version: u64, map: Option<Rebuilt>) {
        self.1
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .parts
            .push(Committed { part, map });
        self.2.fetch_max(version, Ordering::Release);
    }

    /// The version after the last edit committed: a copy at least as new holds every edit.
    pub fn edited(&self) -> u64 {
        self.2.load(Ordering::Acquire)
    }

    /// The edits committed since the last take, in order, and the seed when it is new.
    pub fn take(&self) -> Taken {
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

/// The edit checker's own town (G1e), for G2b's guard on the town: seeded at boot with a memory copy of the town the
/// boot built (#3743), or, in a world without bodies, built whole from a frozen copy for the first edit (4.5 s on
/// Eden). It is kept as each committed edit leaves the ground, as the walkers' town is: by installing the ground
/// prepared for the edit ([`Committed::map`], #3743), else as G3b does (`Town::rebuild`, then `Town::install`,
/// cutting again only the squares and floors the edit touches). An edit it can't install (its tree is the copy's as
/// built, without what else the world wrote since) has the town built whole again from a copy that holds it. `None`
/// inside: the copy's zone has no open ground or its town could not be built; edits are planned whole.
pub struct TownCopy {
    kinds: BTreeMap<String, Kind>,
    /// The version up to which it holds every committed edit, its open ground, and the town.
    built: Option<(u64, Option<Id>, Option<Town>)>,
    /// The edits handed off and not yet installed, in order ([`TownCopy::add`]).
    pending: Vec<Committed>,
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
        TownCopy {
            kinds,
            built: None,
            pending: Vec::new(),
        }
    }

    /// What the clock thread handed off since the last take ([`Moving::take`]): the seed replaces the town, and the
    /// edits wait for the next [`TownCopy::on`]. Every take is added, so no committed edit is missed.
    pub fn add(&mut self, taken: Taken) {
        if let Some((version, town)) = taken.seed {
            self.built = Some((version, Some(town.ground), Some(town)));
        }
        self.pending.extend(taken.parts);
    }

    /// The town as of `copy` (whose open ground is `ground`) with the edits added since the last call installed;
    /// built whole from `copy` when there is none yet (unless `idle`: then it waits for its seed or an edit), the ground
    /// differs, or an edit can't be installed. `copy` holds every edit committed. Off the clock thread.
    pub fn on(&mut self, copy: &Replica, ground: Option<Id>, idle: bool) -> Option<&mut Town> {
        if idle && self.built.is_none() {
            return None;
        }
        let committed = std::mem::take(&mut self.pending);
        let mut whole = !matches!(&self.built, Some((_, g, _)) if *g == ground);
        if let Some((at, _, Some(town))) = &mut self.built {
            for Committed { part: p, map } in committed {
                if after(&p) <= *at {
                    continue;
                }
                // The ground prepared for the edit, as the walkers' town installs it (#3743).
                if let Some(r) = map
                    && town.install(r, &p).is_ok()
                {
                    *at = after(&p);
                    continue;
                }
                // The town's tree has the edits, not what else the world wrote between them: the edit's entries are
                // numbered on from the town's own, as `Town::install` numbers them.
                let header = town.doors.header.clone();
                let installed = renumbered(&p, town.doors.next).and_then(|p| {
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
                *at = after(&p);
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
            has: sim::walk::water::WALKER,
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
        moving.offer_map(&bodies, 0, 0);
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

        // S10: after the seed, the clock builds a snapshot only when the edit checker asks, and what the checker gets
        // is the one built at the tick it needs or later: the same map and bodies an offer at every tick gives.
        moving.offer_map(&bodies, 7, 7);
        assert_eq!(
            moving.current().map.as_ref().map(|m| m.version),
            Some(0),
            "not asked: not built"
        );
        let asked = std::sync::Arc::new(moving);
        let reader = {
            let m = std::sync::Arc::clone(&asked);
            std::thread::spawn(move || m.fresh(7, Some(std::time::Duration::from_secs(5))))
        };
        while !asked.asked() {
            std::thread::yield_now();
        }
        asked.offer_map(&bodies, 8, 8);
        let Ok(got) = reader.join().unwrap() else {
            panic!("built at tick 8, past the 7 it needed")
        };
        assert_eq!(
            got.map.as_ref().map(|m| m.version),
            Some(8),
            "the next tick's map"
        );
        let every = Moving::default();
        every.offer_map(&bodies, 8, 8);
        let want = every.current();
        assert_eq!(got.classes, want.classes);
        assert_eq!(got.bodies.len(), want.bodies.len());
        for (a, b) in got.bodies.iter().zip(want.bodies.iter()) {
            assert_eq!((a.body, a.pose, a.crossing), (b.body, b.pose, b.crossing));
        }
        // Queued jobs sent at tick 8 (a burst of five seatings): each has the snapshot it needs at once, no tick apart.
        for _ in 0..5 {
            assert!(
                asked.fresh(8, Some(std::time::Duration::ZERO)).is_ok(),
                "no wait for a job sent at the built tick"
            );
        }
        // A free-running clock that stalls past the wait: the checker gets no snapshot older than its job's tick.
        let late = asked.fresh(9, Some(std::time::Duration::from_millis(100)));
        assert!(late.is_err(), "refused, not checked on tick 8's bodies");
        assert!(asked.asked(), "and the next tick builds one");
        // S10c: a checker waiting with no deadline (lockstep) wakes, refused, once the clock stops.
        let waiting = {
            let m = std::sync::Arc::clone(&asked);
            std::thread::spawn(move || m.fresh(9, None))
        };
        asked.close();
        assert!(
            waiting.join().unwrap().is_err(),
            "the clock stopped: refused, never blocked"
        );
    }
}

#[cfg(test)]
mod checker_town_tests {
    use super::*;
    use replica::effects::{
        Actor, Body as EffectBody, Cause, Change, ChangeRec, Effect, Envelope, Rest,
    };
    use replica::encode::Value;
    use replica::world_model::Audience;

    /// A 1 m crate's box set as `node`'s only box, numbered `sequence`.
    fn crate_box(header: &replica::effects::Header, node: Id, sequence: u64, h: u64) -> Part {
        let row = [0u64, 0, 500, 500, 0, 0, h];
        let change = Change::Set {
            node,
            field: import_eden::F_SOLIDS,
            to: Value::Array(vec![Value::Array(
                row.iter().map(|&v| Value::Uint(v)).collect(),
            )]),
            by: None,
        };
        let id = |c| Id::new(replica::ids::Scope([0x37; 16]), c).unwrap();
        let e = Effect {
            envelope: Envelope {
                sequence,
                at: 0,
                cause: Cause::Intent(id(1)),
                actor: Actor::Creator(id(2)),
                audience: Audience::Everyone,
                node,
            },
            body: EffectBody::Changes(vec![ChangeRec {
                change,
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        };
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(header.hash().to_bytes())),
            (2, Value::Array(vec![e.to_value()])),
        ])))
        .unwrap();
        Part::read(&bytes).unwrap()
    }

    /// #3743: every edit the clock thread hands off reaches the checker's town, including those taken while the
    /// checker handled a Wear job or refused an edit (no town call between the takes); the first installs the ground
    /// prepared for it, the second is rebuilt as G1e does.
    #[test]
    fn edits_taken_between_checks_still_reach_the_checkers_town() {
        let facts = testworld::generate(1, 0).unwrap();
        let imported = import_eden::load(&facts.text).unwrap();
        let (root, ground) = (imported.nodes["world"], imported.nodes["ground"]);
        let header = import_eden::header(root, &imported.rules).unwrap();
        let next = imported.tree.to_state().next;
        let t = &imported.tree;
        let things: Vec<Id> = t
            .children(t.handle(ground).unwrap())
            .unwrap_or_default()
            .iter()
            .filter_map(|&c| t.node(c))
            .filter(|n| n.fields().contains_key(&import_eden::F_SOLIDS))
            .map(|n| n.id())
            .take(2)
            .collect();
        assert_eq!(things.len(), 2, "two things with solids on the open ground");
        let copy = Replica::restored(header.clone(), imported.tree.frozen(), next);
        let town = Town::new(
            imported.tree,
            ground,
            Doors::new(header.clone(), imported.rules.clone(), next),
        )
        .unwrap();
        let mut checker = TownCopy::new(imported.rules.kinds.clone());
        let moving = Moving::default();
        moving.1.lock().unwrap().seed = Some((next, town.duplicate()));
        checker.add(moving.take());

        let first = crate_box(&header, things[0], next, 1_200);
        let prepared = Town::rebuild(
            town.tree.frozen(),
            &header,
            ground,
            &town.versions,
            &town.basis(),
            &first,
        )
        .unwrap();
        moving.committed(Arc::new(first), next + 1, Some(prepared));
        // A Wear job or a refused edit: taken, no town call.
        checker.add(moving.take());
        let second = crate_box(&header, things[1], next + 1, 900);
        moving.committed(Arc::new(second), next + 2, None);
        checker.add(moving.take());

        let built = checker.on(&copy, Some(ground), false).expect("the town");
        for (thing, h) in [(things[0], 1_200u64), (things[1], 900)] {
            let n = built.tree.node(built.tree.handle(thing).unwrap()).unwrap();
            let solids = n.fields().get(&import_eden::F_SOLIDS).unwrap();
            assert!(
                format!("{solids:?}").contains(&h.to_string()),
                "edit on {thing:?} reached the town: {solids:?}"
            );
        }
        assert_eq!(checker.built.as_ref().map(|b| b.0), Some(next + 2));
    }
}
