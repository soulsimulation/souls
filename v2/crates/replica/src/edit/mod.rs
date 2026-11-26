//! A creator's edit (Engine v2 G1, #2746): the intent and its checks. An edit is a batch of place, move, set and
//! remove operations and the version it was planned against. It is checked here, off the clock thread, on a frozen
//! copy ([`check`]), and committed on one tick by `sim::edit` as generic effects (T6) under one cause, with the
//! creator as actor, through the same write as every act (`sim::commit::write`), or refused whole.
//!
//! - **Who:** the world's one creator, and nobody else (`edit.not-the-creator`).
//! - **Marks:** an owner or access mark (`who_may::F_OWNER`, `F_ACCESS`, #3700) reads as one (`edit.owner-malformed`),
//!   and a tint (`tint::F_TINT`, 0.134 R4) as rows of a part and a colour (`edit.tint-malformed`).
//! - **Size:** at most [`OPS_MOST`] operations (`edit.too-many-operations`) and [`NODES_MOST`] changed nodes, a removed
//!   subtree counted whole (`edit.too-many-nodes`).
//! - **Structure:** a placed kind is known by its full `namespace:name@hash` (`edit.kind-unknown`), and the parent's
//!   kind admits it in the slot named (`edit.child-not-admitted`), as T2 rule 5 says; so does a move's new slot.
//! - **Planned against a version:** each node the batch moves, sets or removes (a removed node's subtree with it) must
//!   be unchanged since that version (its stamp no later), else `edit.stale`. Other nodes changing does not matter, so
//!   a busy world does not refuse every edit. A place's parent need only still be there.
//! - **Ids:** a placed node has a temporary name in the batch; the engine mints its id at commit, and the receipt maps
//!   each name to its id.
//!
//! A refusal names the failing operation by its place in the batch. Not here: overlap and support, the ground.
//! The safety rule (G2, #2761) is judged in `sim::edit::safety`; its failures' names and texts are here ([`Unsafe`]),
//! so a client reads the same names the world refuses by.
//!
//! - **Undo and redo** (G4, #2795) are batches like any other, committed by `sim::edit::undo`. Each names the batch it
//!   reverses by its cause, `Cause::Effect(first)`, where `first` is the sequence of that batch's first effect, with a
//!   creator acting ([`reverses`]).

pub mod claims;
pub mod wire;

use crate::apply::Replica;
use crate::effects::{Actor, Cause, Effect};
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::kinds::defined;
use crate::pose::{Frame, Pose, Quat, Support, Vec3};
use crate::read::Read;
use crate::world_model::{Audience, End, Kind, plain, show, takes};
use std::collections::{BTreeMap, BTreeSet};

/// The most operations a batch may carry.
pub const OPS_MOST: usize = 256;
/// The most nodes a batch may change.
pub const NODES_MOST: usize = 4096;

/// A node an operation names: one in the zone, or one placed earlier in the same batch, by its temporary name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Ref {
    Node(Id),
    New(u64),
}

/// Where a node goes in its parent's frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spot {
    pub slot: Option<u64>,
    pub position: Vec3,
    pub orientation: Quat,
    pub support: Support,
}

impl Spot {
    pub fn pose(&self, parent: Id) -> Pose {
        Pose {
            frame: Frame {
                node: parent,
                slot: self.slot,
            },
            position: self.position,
            orientation: self.orientation,
            support: self.support,
        }
    }
}

/// One operation of a batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    /// A new node, named `name` until the engine mints its id.
    Place {
        name: u64,
        kind: Name,
        parent: Ref,
        at: Spot,
        audience: Audience,
        fields: BTreeMap<u64, Value>,
    },
    /// A node to another spot in the same parent (a new parent is a crossing, T1).
    Move {
        node: Ref,
        at: Spot,
    },
    Set {
        node: Ref,
        field: u64,
        to: Value,
    },
    /// A node and its subtree.
    Remove {
        node: Ref,
    },
    /// A door leaf and its passage between two places. Geometry is in the owning building's axes, mm.
    Doorway {
        name: u64,
        door: Ref,
        from: Ref,
        to: Ref,
        at: [i64; 2],
        yaw: i64,
        width: i64,
        height: i64,
        wall: Ref,
        closed: Vec<Value>,
        open: Vec<Value>,
    },
    /// A link of type `ty` between two nodes that are there, owned by its `owner` end, with its row appended to the
    /// owner's `field` (`[link, ...row]`, as a doorway's or a stair's geometry is kept), and the door standing in it,
    /// if any, naming it in field 7 (#3728: an imported world's doorways and stairs). Nothing else changes: no wall is
    /// cut, so the geometry the link stands for is already there.
    Link {
        name: u64,
        ty: Name,
        ends: [Ref; 2],
        owner: End,
        field: u64,
        row: Vec<Value>,
        door: Option<Ref>,
    },
    /// Rows into a node's array field (#3728: a creator's land edit sends only the terrain tiles it changes): each
    /// row replaces the row whose first two values are its own, or is added after the rest. The field holds rows
    /// already (an array of arrays of at least two values each); the result is a set of the whole field.
    Rows {
        node: Ref,
        field: u64,
        rows: Vec<Value>,
    },
}

/// The field `now` with `rows` merged in, as [`Op::Rows`] says; `None` when `now` is not an array of rows or a row has
/// fewer than two values.
pub fn merged_rows(now: Option<&Value>, rows: &[Value]) -> Option<Value> {
    let key = |r: &Value| match r {
        Value::Array(r) if r.len() >= 2 => {
            crate::encode::encode(&Value::Array(r[..2].to_vec())).ok()
        }
        _ => None,
    };
    let Some(Value::Array(now)) = now else {
        return None;
    };
    let mut out = now.clone();
    let mut at = BTreeMap::new();
    for (i, r) in out.iter().enumerate() {
        at.insert(key(r)?, i);
    }
    for r in rows {
        let k = key(r)?;
        match at.get(&k) {
            Some(&i) => out[i] = r.clone(),
            None => {
                at.insert(k, out.len());
                out.push(r.clone());
            }
        }
    }
    Some(Value::Array(out))
}

/// The most values a link's row carries.
pub const LINK_ROW_MOST: usize = 16;

/// The most encoded bytes the fields a batch sets may hold, all together (`edit.too-large` above it). Each set and
/// each rows operation writes its whole field, so a grown field can outgrow what one log record holds (64 MB,
/// `sim::log::record::MAX_RECORD`); this keeps a batch's part well under it, with room for the rest of its tick.
pub const WRITTEN_MOST: usize = 16 << 20;

/// `written` and the encoded size of `to` together, or `edit.too-large` over [`WRITTEN_MOST`].
pub(crate) fn write_size(
    here: Option<usize>,
    written: usize,
    to: &Value,
) -> Result<usize, Refused> {
    let total = crate::encode::encode(to)
        .map_or(usize::MAX, |b| b.len())
        .saturating_add(written);
    if total > WRITTEN_MOST {
        return refuse(
            here,
            "edit.too-large",
            format!("the fields this batch sets come to {total} bytes, over {WRITTEN_MOST}"),
        );
    }
    Ok(total)
}

/// An edit intent: who sends it, its id (the cause of every effect it commits), the version of the zone it was planned
/// against, and its operations in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub intent: Id,
    pub actor: Actor,
    pub planned: u64,
    pub ops: Vec<Op>,
    /// The build claim it is sent under, by id (#3701, [`claims`]); none for the lead's own edits.
    pub claim: Option<Name>,
}

/// What an edit is checked against: the world's one creator, and the kinds it pins by full name.
#[derive(Clone, Debug)]
pub struct World {
    pub creator: Id,
    pub kinds: BTreeMap<String, Kind>,
}

/// A refused edit: the operation that failed, by its place in the batch (none for one about the whole batch), the
/// refusal's name and what it found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    pub op: Option<usize>,
    pub name: &'static str,
    pub detail: String,
}

fn refuse<T>(
    op: Option<usize>,
    name: &'static str,
    detail: impl Into<String>,
) -> Result<T, Refused> {
    Err(Refused {
        op,
        name,
        detail: detail.into(),
    })
}

/// An edit that passed its checks on a copy, with what the clock thread confirms at commit: for each operation, the
/// nodes whose stamps must be no later than the planned version, and the place parents that must still be there.
#[derive(Clone, Debug)]
pub struct Checked {
    pub edit: Edit,
    pub reads: Vec<(usize, Id)>,
    pub parents: Vec<(usize, Id)>,
    /// Wall fields prepared off-clock, indexed by the operation that installs them.
    pub geometry: BTreeMap<usize, DoorGeometry>,
}

#[derive(Clone, Debug)]
pub struct DoorGeometry {
    pub wall: Ref,
    pub solids: Value,
}

/// A doorway leaf's owned wall patch: [wall id, closed rows, open rows].
pub const DOOR_GEOMETRY: u64 = 100;
const SOLIDS: u64 = 12;
const GEOMETRY_MOST: usize = 64;
type OwnedDoor = (Ref, Vec<Value>, Vec<Value>, [Ref; 2]);

/// Only exact, unique authored rows are replaced; unrelated wall geometry is retained. Runs off-clock.
pub fn doorway_solids(
    current: &Value,
    before: &[Value],
    after: &[Value],
) -> Result<Value, &'static str> {
    let valid = |rows: &[Value]| {
        rows.len() <= GEOMETRY_MOST
            && rows.iter().all(|row| {
                matches!(row, Value::Array(row) if row.len() == 9 && row.iter().all(|n| match n {
                    Value::Uint(n) => *n <= (i64::MAX / 1000) as u64,
                    Value::Nint(n) => *n < (i64::MAX / 1000) as u64,
                    _ => false,
                }))
            })
    };
    if before.is_empty() || after.is_empty() || before == after || !valid(before) || !valid(after) {
        return Err("edit.doorway-geometry");
    }
    let Value::Array(current) = current else {
        return Err("edit.doorway-geometry");
    };
    let unique = |rows: &[Value]| {
        rows.iter()
            .enumerate()
            .all(|(i, row)| !rows[..i].contains(row))
    };
    if !unique(before)
        || !unique(after)
        || before
            .iter()
            .any(|row| current.iter().filter(|r| *r == row).count() != 1)
    {
        return Err("edit.doorway-wall-changed");
    }
    let mut result: Vec<_> = current
        .iter()
        .filter(|row| !before.contains(row))
        .cloned()
        .collect();
    if after.iter().any(|row| result.contains(row)) {
        return Err("edit.doorway-wall-changed");
    }
    result.extend_from_slice(after);
    Ok(Value::Array(result))
}

/// A placed node as the check tracks it through the batch.
struct New {
    kind: String,
    parent: Ref,
}

/// Checks `edit` on `copy` (see the module's notes). Runs off the clock thread.
pub fn check(mut edit: Edit, copy: &Replica, world: &World) -> Result<Checked, Refused> {
    if !claims::admits(&edit, copy, world.creator) {
        return refuse(
            None,
            "edit.not-the-creator",
            "only the world's creator edits it, or a claim's helper under that claim",
        );
    }
    if edit.ops.len() > OPS_MOST {
        return refuse(
            None,
            "edit.too-many-operations",
            format!("{} operations, over {OPS_MOST}", edit.ops.len()),
        );
    }
    let tree = copy.tree();
    // Every kind the world has: its boot kinds and the creator's own, by the one loader (#3697); and the definitions
    // this batch makes, checked and made canonical before anything else.
    let mut kinds = world.kinds.clone();
    kinds.extend(defined::kinds_in(tree));
    let made = define(&mut edit, copy)?;
    let mut defined_names: BTreeSet<String> = defined::nodes(tree)
        .into_iter()
        .map(|(_, full, _)| full)
        .collect();
    for (full, k, _, _) in made.values() {
        kinds.insert(full.clone(), k.clone());
        defined_names.insert(full.clone());
    }
    // Each new definition's forms create only kinds the world has, into slots that admit them, and fire no ring of
    // timers every tick (`kind.effects`): one record never makes every run fail (#3697 review).
    // A thing of a creator's kind stands as its kind's bounds say (#3697): its solids, unless the batch gives its own,
    // so walkers go round it and the safety rule (G2) judges what it would bury, as a boot thing's.
    let mut shapes = defined::solids_in(tree);
    shapes.extend(
        made.values()
            .filter_map(|(full, _, s, _)| Some((full.clone(), s.clone()?))),
    );
    for (i, (_, k, _, entry)) in &made {
        defined::effects_checked(entry, k, &kinds, &shapes).map_err(|(name, detail)| Refused {
            op: Some(*i),
            name,
            detail,
        })?;
    }
    for op in &mut edit.ops {
        if let Op::Place { kind, fields, .. } = op
            && let Some(s) = shapes.get(kind.as_str())
        {
            fields.entry(SOLIDS).or_insert_with(|| s.clone());
        }
    }
    let pinned = |k: &Name| {
        copy.header().kinds.contains(k)
            || defined::is_definition(k.as_str())
            || defined_names.contains(k.as_str())
    };
    let mut definitions_gone: Vec<(usize, String)> = Vec::new();
    let mut new: BTreeMap<u64, New> = BTreeMap::new();
    let mut links = BTreeSet::new();
    let mut doorways = BTreeSet::new();
    let mut gone: BTreeSet<Ref> = BTreeSet::new();
    let mut changed: BTreeSet<Ref> = BTreeSet::new();
    let mut reads = Vec::new();
    let mut parents = Vec::new();
    let mut geometry = BTreeMap::new();
    let mut fields: BTreeMap<(Ref, u64), Value> = BTreeMap::new();
    let mut owned: BTreeMap<Ref, OwnedDoor> = BTreeMap::new();
    let mut written = 0usize;
    for (i, op) in edit.ops.iter().enumerate() {
        let here = Some(i);
        // The kind of a node the batch names, and its parent, as the batch has left it so far.
        let named = |r: Ref| -> Result<(String, Option<Ref>), Refused> {
            if gone.contains(&r) {
                return refuse(
                    here,
                    "edit.node-missing",
                    format!("{r:?} is removed earlier in the batch"),
                );
            }
            match r {
                Ref::New(n) => new
                    .get(&n)
                    .map(|x| (x.kind.clone(), Some(x.parent)))
                    .map_or_else(
                        || refuse(here, "edit.name-unknown", format!("no place names {n}")),
                        Ok,
                    ),
                Ref::Node(id) => {
                    let h = tree.handle(id);
                    match h.and_then(|h| tree.node(h)) {
                        Some(n) => Ok((n.kind().as_str().to_owned(), n.parent().map(Ref::Node))),
                        None => refuse(here, "edit.node-missing", format!("{id:?} is not here")),
                    }
                }
            }
        };
        let value = |node: Ref, field: u64| {
            fields.get(&(node, field)).cloned().or_else(|| match node {
                Ref::Node(id) => tree
                    .handle(id)
                    .and_then(|h| tree.node(h))
                    .and_then(|n| n.fields().get(&field).cloned()),
                Ref::New(_) => None,
            })
        };
        // A place's outline and line as the batch has left them, and whether a node is the open ground (#5006).
        let place_fields = |node: Ref| -> BTreeMap<u64, Value> {
            crate::arrival::READS
                .iter()
                .filter_map(|&f| Some((f, value(node, f)?)))
                .collect()
        };
        let is_ground = |node: Ref| match node {
            Ref::Node(id) => tree
                .handle(id)
                .and_then(|h| tree.node(h))
                .is_some_and(|n| n.fields().contains_key(&crate::arrival::TILES)),
            Ref::New(_) => false,
        };
        let wall_of = |wall: Ref, ends: [Ref; 2]| -> Result<(), Refused> {
            let (kind, _) = named(wall)?;
            if !copy.header().kinds.iter().any(|k| k.as_str() == kind)
                || kinds.get(&kind).is_none_or(|k| k.owner != "thing")
            {
                return refuse(
                    here,
                    "edit.doorway-geometry",
                    "the wall is an exact pinned thing in this world",
                );
            }
            for mut end in ends {
                let mut contained = false;
                for _ in 0..64 {
                    if end == wall {
                        contained = true;
                        break;
                    }
                    let (_, parent) = named(end)?;
                    let Some(parent) = parent else { break };
                    end = parent;
                }
                if !contained {
                    return refuse(
                        here,
                        "edit.doorway-geometry",
                        "both places belong to the authored wall's building",
                    );
                }
            }
            Ok(())
        };
        let admits = |parent: &str, child: &str, slot: Option<u64>| -> Result<(), Refused> {
            let (Some(pk), Some(ck)) = (kinds.get(parent), kinds.get(child)) else {
                return refuse(here, "edit.kind-unknown", format!("{parent} or {child}"));
            };
            let list = match slot {
                Some(s) => pk.slots.get(&s),
                None => Some(&pk.children),
            };
            if list.is_some_and(|l| takes(l, plain(child), &ck.owner)) {
                Ok(())
            } else {
                refuse(
                    here,
                    "edit.child-not-admitted",
                    format!(
                        "{} does not admit {} (slot {slot:?})",
                        plain(parent),
                        plain(child)
                    ),
                )
            }
        };
        match op {
            Op::Place {
                name,
                kind,
                parent,
                at,
                fields: initial_fields,
                ..
            } => {
                if initial_fields.contains_key(&DOOR_GEOMETRY) {
                    return refuse(
                        here,
                        "edit.doorway-geometry",
                        "owned geometry is written only by the doorway operation",
                    );
                }
                let k = kind.as_str();
                // A kind defined later in the batch is not yet pinned here.
                let later = made.range(i..).any(|(_, (full, ..))| full == k);
                if !kinds.contains_key(k) || !pinned(kind) || later {
                    return refuse(
                        here,
                        "edit.kind-unknown",
                        format!("{k} is not pinned by this world"),
                    );
                }
                if new.contains_key(name) || links.contains(name) {
                    return refuse(here, "edit.name-twice", format!("{name} is placed twice"));
                }
                let (pk, _) = named(*parent)?;
                // A definition sits at the root, which `define` checked; nothing else admits one.
                if !defined::is_definition(k) {
                    admits(&pk, k, at.slot)?;
                }
                for (f, v) in initial_fields {
                    if let Err(why) = crate::who_may::check_mark(*f, v) {
                        return refuse(here, "edit.owner-malformed", why);
                    }
                    if let Err(why) = crate::tint::check(*f, v) {
                        return refuse(here, "edit.tint-malformed", why);
                    }
                }
                if let Ref::Node(p) = parent {
                    parents.push((i, *p));
                }
                new.insert(
                    *name,
                    New {
                        kind: k.to_owned(),
                        parent: *parent,
                    },
                );
                if initial_fields
                    .get(&7)
                    .is_some_and(|v| crate::effects::read_id(v).is_ok())
                {
                    doorways.insert(Ref::New(*name));
                }
                fields.extend(
                    initial_fields
                        .iter()
                        .map(|(k, v)| (*k, v.clone()))
                        .map(|(k, v)| ((Ref::New(*name), k), v)),
                );
                changed.insert(Ref::New(*name));
            }
            Op::Move { node, at } => {
                let (k, parent) = named(*node)?;
                let Some(parent) = parent else {
                    return refuse(here, "edit.root", "the zone's root does not move");
                };
                let (pk, _) = named(parent)?;
                admits(&pk, &k, at.slot)?;
                if let Ref::Node(id) = node {
                    reads.push((i, *id));
                }
                changed.insert(*node);
            }
            Op::Set { node, field, to } => {
                if *field == DOOR_GEOMETRY {
                    return refuse(
                        here,
                        "edit.doorway-geometry",
                        "owned geometry is written only by the doorway operation",
                    );
                }
                let (k, _) = named(*node)?;
                if defined::is_definition(&k) {
                    return refuse(
                        here,
                        "kind.invalid",
                        "a definition never changes: define the new revision",
                    );
                }
                // #3700: an owner or access mark is checked as it is written.
                if let Err(why) = crate::who_may::check_mark(*field, to) {
                    return refuse(here, "edit.owner-malformed", why);
                }
                if let Err(why) = crate::tint::check(*field, to) {
                    return refuse(here, "edit.tint-malformed", why);
                }
                // #5006: where new Souls arrive, on the world's root: a place of the world, or none.
                if *field == crate::arrival::F_ARRIVAL {
                    if named(*node)?.1.is_some() {
                        return refuse(
                            here,
                            crate::arrival::UNKNOWN,
                            "the arrival is set on the world's root",
                        );
                    }
                    let place = match crate::arrival::read(to) {
                        Ok(p) => p,
                        Err(why) => return refuse(here, crate::arrival::UNKNOWN, why),
                    };
                    if let Some(place) = place {
                        let is_place = matches!(named(Ref::Node(place)), Ok((_, Some(parent)))
                            if crate::arrival::is_place(&place_fields(Ref::Node(place)), is_ground(parent)));
                        if !is_place {
                            return refuse(
                                here,
                                crate::arrival::UNKNOWN,
                                format!(
                                    "{} is not a place of this world: an area or a line on the open ground",
                                    show(place)
                                ),
                            );
                        }
                    }
                }
                written = write_size(here, written, to)?;
                if let Ref::Node(id) = node {
                    reads.push((i, *id));
                }
                fields.insert((*node, *field), to.clone());
                changed.insert(*node);
                if *field == 7 {
                    if crate::effects::read_id(to).is_ok() {
                        doorways.insert(*node);
                    } else {
                        doorways.remove(node);
                    }
                }
            }
            Op::Rows { node, field, rows } => {
                if *field == DOOR_GEOMETRY || *field == 7 {
                    return refuse(
                        here,
                        "edit.rows",
                        "a door's link and owned geometry are not rows",
                    );
                }
                if rows.is_empty() {
                    return refuse(
                        here,
                        "edit.rows",
                        "a rows operation carries at least one row",
                    );
                }
                named(*node)?;
                let Some(to) = merged_rows(value(*node, *field).as_ref(), rows) else {
                    return refuse(
                        here,
                        "edit.rows",
                        "rows go into a field of rows, each at least two values",
                    );
                };
                if let Err(why) = crate::tint::check(*field, &to) {
                    return refuse(here, "edit.tint-malformed", why);
                }
                written = write_size(here, written, &to)?;
                if let Ref::Node(id) = node {
                    reads.push((i, *id));
                }
                fields.insert((*node, *field), to);
                changed.insert(*node);
            }
            Op::Link {
                name,
                ty,
                ends,
                owner,
                field,
                row,
                door,
            } => {
                if new.contains_key(name) || !links.insert(*name) {
                    return refuse(here, "edit.name-twice", format!("{name} is placed twice"));
                }
                if ty.as_str().starts_with("souls:") {
                    return refuse(
                        here,
                        "edit.link",
                        "the engine's own links are not made by an edit",
                    );
                }
                if *field == crate::tint::F_TINT {
                    return refuse(
                        here,
                        "edit.tint-malformed",
                        "a tint's rows are [part, rgb], never a link's",
                    );
                }
                if *field == DOOR_GEOMETRY
                    || *field == 7
                    || ends[0] == ends[1]
                    || row.len() > LINK_ROW_MOST
                {
                    return refuse(
                        here,
                        "edit.link",
                        format!(
                            "two distinct ends and a row of at most {LINK_ROW_MOST} values in a field other than 7 or {DOOR_GEOMETRY}"
                        ),
                    );
                }
                for end in ends {
                    named(*end)?;
                    if let Ref::Node(id) = end {
                        reads.push((i, *id));
                    }
                }
                let at = ends[usize::from(*owner == End::Second)];
                if !matches!(value(at, *field), None | Some(Value::Array(_))) {
                    return refuse(here, "edit.link", "the owner's field is not a list of rows");
                }
                changed.insert(at);
                if let Some(door) = door {
                    named(*door)?;
                    let linked = match door {
                        Ref::Node(id) => tree
                            .handle(*id)
                            .and_then(|h| tree.node(h))
                            .and_then(|n| {
                                n.fields()
                                    .get(&7)
                                    .and_then(|v| crate::effects::read_id(v).ok())
                            })
                            .is_some_and(|link| tree.link(link).is_some()),
                        Ref::New(_) => false,
                    };
                    if linked || !doorways.insert(*door) {
                        return refuse(here, "edit.doorway", "the door already has a doorway");
                    }
                    if let Ref::Node(id) = door {
                        reads.push((i, *id));
                    }
                    changed.insert(*door);
                }
            }
            Op::Doorway {
                name,
                door,
                from,
                to,
                at,
                width,
                height,
                wall,
                closed,
                open,
                ..
            } => {
                if new.contains_key(name) || !links.insert(*name) {
                    return refuse(here, "edit.name-twice", format!("{name} is placed twice"));
                }
                let (kind, parent) = named(*door)?;
                let already_linked = match door {
                    Ref::Node(id) => tree
                        .handle(*id)
                        .and_then(|h| tree.node(h))
                        .and_then(|n| {
                            n.fields()
                                .get(&7)
                                .and_then(|v| crate::effects::read_id(v).ok())
                        })
                        .is_some_and(|link| tree.link(link).is_some()),
                    Ref::New(_) => false,
                };
                if already_linked || !doorways.insert(*door) {
                    return refuse(here, "edit.doorway", "the door already has a doorway");
                }
                if parent != Some(*from)
                    || from == to
                    || *width <= 0
                    || *height <= 0
                    || at
                        .iter()
                        .chain([width, height])
                        .any(|n| n.checked_mul(1000).is_none())
                {
                    return refuse(
                        here,
                        "edit.doorway",
                        "a door belongs to its owning end; distinct ends and positive dimensions are required",
                    );
                }
                if !copy.header().kinds.iter().any(|k| k.as_str() == kind)
                    || kinds.get(&kind).is_none_or(|k| k.owner != "thing")
                {
                    return refuse(here, "edit.kind-unknown", kind);
                }
                for end in [*from, *to] {
                    let (kind, _) = named(end)?;
                    if kinds.get(&kind).is_none_or(|k| k.owner != "place") {
                        return refuse(here, "edit.doorway", "a doorway joins places");
                    }
                }
                wall_of(*wall, [*from, *to])?;
                let solids = doorway_solids(
                    &value(*wall, SOLIDS).unwrap_or(Value::Array(Vec::new())),
                    closed,
                    open,
                )
                .map_err(|name| Refused {
                    op: here,
                    name,
                    detail: "the exact authored closed wall rows must match".into(),
                })?;
                fields.insert((*wall, SOLIDS), solids.clone());
                geometry.insert(
                    i,
                    DoorGeometry {
                        wall: *wall,
                        solids,
                    },
                );
                owned.insert(*door, (*wall, closed.clone(), open.clone(), [*from, *to]));
                changed.insert(*wall);
                for r in [*door, *from, *to, *wall] {
                    if let Ref::Node(id) = r {
                        reads.push((i, id));
                    }
                }
                changed.extend([*door, *from]);
            }
            Op::Remove { node } => {
                let (rk, parent) = named(*node)?;
                if parent.is_none() {
                    return refuse(here, "edit.root", "the zone's root is not removed");
                }
                if defined::is_definition(&rk) {
                    let full = match node {
                        Ref::Node(id) => tree
                            .handle(*id)
                            .and_then(|h| tree.node(h))
                            .and_then(|n| defined::named(n.fields()).map(str::to_owned)),
                        Ref::New(n) => made
                            .iter()
                            .find(|(j, _)| matches!(&edit.ops[**j], Op::Place { name, .. } if name == n))
                            .map(|(_, (full, _, _, _))| full.clone()),
                    };
                    definitions_gone.extend(full.map(|f| (i, f)));
                }
                let patch = if let Some(patch) = owned.get(node) {
                    Some(patch.clone())
                } else if let Some(metadata) = value(*node, DOOR_GEOMETRY) {
                    let Value::Array(row) = metadata else {
                        return refuse(here, "edit.doorway-geometry", "owned geometry is an array");
                    };
                    let [wall, Value::Array(closed), Value::Array(open)] = row.as_slice() else {
                        return refuse(
                            here,
                            "edit.doorway-geometry",
                            "owned geometry is [wall,closed,open]",
                        );
                    };
                    let wall = crate::effects::read_id(wall).map_err(|_| Refused {
                        op: here,
                        name: "edit.doorway-geometry",
                        detail: "owned geometry wall is an id".into(),
                    })?;
                    let link = value(*node, 7).and_then(|v| crate::effects::read_id(&v).ok());
                    let Some((ty, ends, owner, _)) = link.and_then(|link| tree.link(link)) else {
                        return refuse(
                            here,
                            "edit.doorway-geometry",
                            "owned geometry requires its doorway link",
                        );
                    };
                    if ty.as_str() != "eden:doorway" || owner != crate::world_model::End::First {
                        return refuse(
                            here,
                            "edit.doorway-geometry",
                            "owned geometry requires its owned doorway",
                        );
                    }
                    Some((
                        Ref::Node(wall),
                        closed.clone(),
                        open.clone(),
                        ends.map(Ref::Node),
                    ))
                } else {
                    None
                };
                if let Some((wall, closed, open, ends)) = patch {
                    wall_of(wall, ends)?;
                    // Validate both encodings even if an incompatible current wall would refuse first.
                    doorway_solids(&Value::Array(closed.clone()), &closed, &open).map_err(
                        |name| Refused {
                            op: here,
                            name,
                            detail: "invalid stored doorway geometry".into(),
                        },
                    )?;
                    let solids = doorway_solids(
                        &value(wall, SOLIDS).unwrap_or(Value::Array(Vec::new())),
                        &open,
                        &closed,
                    )
                    .map_err(|name| Refused {
                        op: here,
                        name,
                        detail: "the owned open wall rows no longer match".into(),
                    })?;
                    fields.insert((wall, SOLIDS), solids.clone());
                    geometry.insert(i, DoorGeometry { wall, solids });
                    if let Ref::Node(wall) = wall {
                        reads.push((i, wall));
                    }
                    changed.insert(wall);
                }
                // A door's removal also changes its passage's owner; concurrent edits to its rows must be stale.
                if let Ref::Node(id) = node
                    && let Some(link) = tree.handle(*id).and_then(|h| tree.node(h)).and_then(|n| {
                        n.fields()
                            .get(&7)
                            .and_then(|v| crate::effects::read_id(v).ok())
                    })
                    && let Some((_, ends, owner, _)) = tree.link(link)
                {
                    reads.push((
                        i,
                        ends[usize::from(owner == crate::world_model::End::Second)],
                    ));
                }
                // The subtree on the copy (a placed node's is in the batch), each node read and changed.
                let mut stack: Vec<Ref> = vec![*node];
                while let Some(r) = stack.pop() {
                    if let Ref::Node(id) = r {
                        reads.push((i, id));
                        if let Some(cs) = tree.handle(id).and_then(|h| tree.children(h)) {
                            stack.extend(
                                cs.iter()
                                    .filter_map(|c| tree.node(*c))
                                    .map(|n| Ref::Node(n.id())),
                            );
                        }
                    }
                    stack.extend(
                        new.iter()
                            .filter(|(_, x)| x.parent == r)
                            .map(|(n, _)| Ref::New(*n)),
                    );
                    changed.insert(r);
                    gone.insert(r);
                    if changed.len() > NODES_MOST {
                        break;
                    }
                }
            }
        }
        if changed.len() > NODES_MOST {
            return refuse(
                here,
                "edit.too-many-nodes",
                format!("over {NODES_MOST} changed nodes"),
            );
        }
    }
    // `kind.in-use`: a removed definition's kind is still the kind of a thing the batch leaves (#3697).
    for (i, full) in &definitions_gone {
        let left = |r: Ref| {
            let mut at = Some(r);
            for _ in 0..crate::world_model::DEPTH_LIMIT + 1 {
                let Some(x) = at else { return true };
                if gone.contains(&x) {
                    return false;
                }
                at = match x {
                    Ref::New(n) => new.get(&n).map(|p| p.parent),
                    Ref::Node(id) => tree
                        .handle(id)
                        .and_then(|h| tree.node(h))
                        .and_then(|n| n.parent())
                        .map(Ref::Node),
                };
            }
            true
        };
        let placed = new
            .iter()
            .filter(|(_, x)| x.kind == *full)
            .map(|(n, _)| Ref::New(*n));
        let mut stack = vec![tree.root()];
        let mut users = Vec::new();
        while let Some(h) = stack.pop() {
            if let Some(n) = tree.node(h)
                && n.kind().as_str() == full
            {
                users.push(Ref::Node(n.id()));
            }
            stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
        }
        if let Some(user) = users.into_iter().chain(placed).find(|r| left(*r)) {
            return refuse(
                Some(*i),
                "kind.in-use",
                format!(
                    "{user:?} is still a {}; remove what uses it first",
                    plain(full)
                ),
            );
        }
        // A definition the batch leaves whose form still creates it.
        let gone_names: BTreeSet<&str> = definitions_gone.iter().map(|(_, f)| f.as_str()).collect();
        let kept = defined::nodes(tree)
            .into_iter()
            .filter(|(_, f, _)| !gone_names.contains(f.as_str()))
            .filter_map(|(_, f, b)| defined::stored(&f, &b))
            .map(|d| (d.full.clone(), d.entry.clone()))
            .chain(
                made.values()
                    .filter(|(f, ..)| !gone_names.contains(f.as_str()))
                    .map(|(f, _, _, e)| (f.clone(), e.clone())),
            );
        for (by, entry) in kept {
            if defined::creates(&entry).contains(&full.as_str()) {
                return refuse(
                    Some(*i),
                    "kind.in-use",
                    format!(
                        "{}'s forms still create a {}; remove or change it first",
                        plain(&by),
                        plain(full)
                    ),
                );
            }
        }
    }
    claims::judge(&edit, copy)?;
    Ok(Checked {
        edit,
        reads,
        parents,
        geometry,
    })
}

/// The definitions a batch makes (#3697), each a place of `souls:kind` at the zone's root holding its record as bytes
/// in field [`defined::ENTRY`]: checked ([`defined::read`]), and its fields made the canonical record and the full name
/// it defines, which every replica reads. By the operation that makes each: the full name and its rules.
/// By the operation that makes each definition: its full name, its rules and the solids a thing of it stands as.
type Made = BTreeMap<usize, (String, Kind, Option<Value>, crate::rules::json::Value)>;

fn define(edit: &mut Edit, copy: &Replica) -> Result<Made, Refused> {
    let tree = copy.tree();
    let root = tree.node(tree.root()).map(|n| n.id());
    let boot = defined::namespaces(copy.header().kinds.iter().map(Name::as_str));
    let mut there: BTreeMap<String, Vec<u8>> = defined::nodes(tree)
        .into_iter()
        .map(|(_, full, bytes)| (full, bytes))
        .collect();
    let mut made = BTreeMap::new();
    for (i, op) in edit.ops.iter_mut().enumerate() {
        let Op::Place {
            kind,
            parent,
            fields,
            audience,
            ..
        } = op
        else {
            continue;
        };
        if !defined::is_definition(kind.as_str()) {
            continue;
        }
        let no = |name, detail: String| Refused {
            op: Some(i),
            name,
            detail,
        };
        if root.is_none_or(|r| *parent != Ref::Node(r)) {
            return Err(no(
                "kind.invalid",
                "a kind is defined at the world's root".into(),
            ));
        }
        // Every copy (the public stream's among them) must hold a kind to apply a thing of it.
        if *audience != Audience::Everyone {
            return Err(no(
                "kind.audience",
                "a kind is defined for everyone: every copy applies things of it".into(),
            ));
        }
        let Some(Value::Bytes(sent)) = fields.get(&defined::ENTRY) else {
            return Err(no(
                "kind.invalid",
                "the definition is its souls-entry/1 record, as bytes".into(),
            ));
        };
        let d = defined::read(sent, &|ns| boot.contains(ns)).map_err(|(n, d)| no(n, d))?;
        if fields
            .keys()
            .any(|k| ![defined::NAME, defined::ENTRY].contains(k))
            || fields
                .get(&defined::NAME)
                .is_some_and(|n| *n != Value::Text(Name::new(&d.full).expect("a full name")))
        {
            return Err(no(
                "kind.invalid",
                format!("a definition holds its record and its full name {}", d.full),
            ));
        }
        if let Some(bytes) = there.get(&d.full) {
            let why = if *bytes == d.bytes {
                "is defined already: place it by that name"
            } else {
                "names other bytes here"
            };
            return Err(no("kind.collision", format!("{} {why}", d.full)));
        }
        there.insert(d.full.clone(), d.bytes.clone());
        *fields = BTreeMap::from([
            (
                defined::NAME,
                Value::Text(Name::new(&d.full).expect("a full name")),
            ),
            (defined::ENTRY, Value::Bytes(d.bytes)),
        ]);
        let solids = defined::solids_of(&d.entry);
        made.insert(i, (d.full, d.kind, solids, d.entry));
    }
    Ok(made)
}

/// Whether the nodes a checked edit read are unchanged since it was planned, on `live`: the first that is not, as the
/// refusal. Each place's parent must still be there.
pub fn confirm(live: &Replica, c: &Checked) -> Result<(), Refused> {
    for (i, id) in &c.reads {
        if live.stamp(*id) > c.edit.planned {
            return refuse(
                Some(*i),
                "edit.stale",
                format!("{id:?} changed after version {}", c.edit.planned),
            );
        }
    }
    for (i, id) in &c.parents {
        if live.tree().handle(*id).is_none() {
            return refuse(Some(*i), "edit.stale", format!("{id:?} is gone"));
        }
    }
    in_use_live(live, c)?;
    // The claim check reads the root's claims and every ancestor's pose, which the read set does not hold: run it
    // again on the live copy, so a claim committed since the check still binds (#3879 review). Cheap and deterministic.
    claims::judge(&c.edit, live)
}

/// `kind.in-use` again on the live copy (#3697 review): a thing a Soul's form made of a definition's kind after the
/// check, which the read set cannot hold, still refuses that definition's removal. Only a batch that removes a
/// definition pays for the walk.
fn in_use_live(live: &Replica, c: &Checked) -> Result<(), Refused> {
    let removed: Vec<(Option<usize>, Id)> = c
        .edit
        .ops
        .iter()
        .enumerate()
        .filter_map(|(i, op)| match op {
            Op::Remove {
                node: Ref::Node(id),
            } => Some((Some(i), *id)),
            _ => None,
        })
        .collect();
    in_use_on(live.tree(), &removed)
}

/// `kind.in-use` for removing `removed` (each with the operation that removes it, if any) from `tree`: a removed
/// definition whose kind is still the kind of a thing left. An edit's commit and an undo or redo (`sim::edit::undo`,
/// on the checker's copy and at the tick) both ask it, so no reversal removes a kind a thing still has (#3697
/// re-review). Only removing a definition pays for the walk.
pub fn in_use_on(tree: &crate::tree::Tree, removed: &[(Option<usize>, Id)]) -> Result<(), Refused> {
    let gone: Vec<(Option<usize>, String)> = removed
        .iter()
        .filter_map(|(i, id)| {
            let n = tree.node(tree.handle(*id)?)?;
            if !defined::is_definition(n.kind().as_str()) {
                return None;
            }
            defined::named(n.fields()).map(|f| (*i, f.to_owned()))
        })
        .collect();
    if gone.is_empty() {
        return Ok(());
    }
    let removed: BTreeSet<Id> = removed.iter().map(|(_, id)| *id).collect();
    let mut stack = vec![tree.root()];
    while let Some(h) = stack.pop() {
        let Some(n) = tree.node(h) else { continue };
        if removed.contains(&n.id()) {
            continue;
        }
        if let Some((i, full)) = gone.iter().find(|(_, f)| f == n.kind().as_str()) {
            return refuse(
                *i,
                "kind.in-use",
                format!(
                    "{:?} is still a {}; remove what uses it first",
                    n.id(),
                    plain(full)
                ),
            );
        }
        stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
    }
    Ok(())
}

/// The batch an undo or redo reverses, by the sequence of its first effect: a creator's effect caused by an earlier
/// effect. None for any other effect.
pub fn reverses(e: &Effect) -> Option<u64> {
    match (e.envelope.actor, e.envelope.cause) {
        (Actor::Creator(_), Cause::Effect(first)) => Some(first),
        _ => None,
    }
}

/// The safety rule's failures (G2, #2761): an edit, a thing set down, a lock or an undo that would bury a Soul's body,
/// change what it is using, or leave it no way out is refused before it commits, by one of these names.
pub const BURIES: &str = "edit.would-bury";
pub const IN_USE: &str = "edit.in-use";
pub const CUTS_OFF: &str = "edit.would-cut-off";

/// How a body uses a thing an edit touches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Use {
    /// Its pose is in one of the thing's slots (what it sits or lies in).
    In,
    /// Its support is the thing's surface (a counter, a table, a stair: a perch).
    On,
    /// The thing is a child of one of its body's slots (in its hand).
    Holds,
}

/// One body the safety rule finds unsafe: which failure, the Soul, where its body is (the node its pose is in, and the
/// point there, µm), and the thing it uses with how, when that is what the edit touches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unsafe {
    pub name: &'static str,
    pub soul: Id,
    pub node: Id,
    pub at: Vec3,
    pub thing: Option<(Id, Use)>,
}

/// Micrometres as metres to the centimetre.
fn metres(v: i64) -> String {
    let sign = if v < 0 { "-" } else { "" };
    let a = v.unsigned_abs();
    format!("{sign}{}.{:02}", a / 1_000_000, a % 1_000_000 / 10_000)
}

impl Unsafe {
    /// The refusal's text: the Soul, the place and a fix.
    pub fn text(&self) -> String {
        let soul = show(self.soul);
        let place = format!(
            "node {} at ({}, {}) m",
            show(self.node),
            metres(self.at.x),
            metres(self.at.z)
        );
        match (self.name, self.thing) {
            (IN_USE, Some((t, how))) => {
                let t = show(t);
                let (how, place) = match how {
                    // Its pose is in the thing's frame: the thing is the place.
                    Use::In => ("is in", String::new()),
                    Use::On => ("rests on", format!(", on {place}")),
                    Use::Holds => ("holds", format!(", on {place}")),
                };
                format!(
                    "Soul {soul} {how} {t}{place}; fix: leave {t} as it is until the Soul is done with it, or edit \
                     something else"
                )
            }
            (BURIES, _) => format!(
                "would bury Soul {soul} where it stands, on {place}; fix: keep what the edit places or moves clear \
                 of that spot by the body's radius, or make the edit once the Soul has moved"
            ),
            _ => format!(
                "would leave Soul {soul} no way out, on {place}; fix: keep a way from there to the open ground \
                 passable (a doorway, stair or gap a body can pass), or make the edit once the Soul has left"
            ),
        }
    }

    /// As a refusal of the whole batch.
    pub fn refused(&self) -> Refused {
        Refused {
            op: None,
            name: self.name,
            detail: self.text(),
        }
    }
}

#[cfg(test)]
mod doorway_geometry_tests {
    use super::*;
    fn row(x: u64) -> Value {
        Value::Array(vec![Value::Uint(x); 9])
    }
    #[test]
    fn doorway_solids_preserve_unrelated_rows_and_refuse_ambiguous_or_incompatible_patches() {
        let (closed, a, b, unrelated) = (row(1), row(2), row(3), row(4));
        let original = Value::Array(vec![unrelated.clone(), closed.clone()]);
        let open = doorway_solids(
            &original,
            std::slice::from_ref(&closed),
            &[a.clone(), b.clone()],
        )
        .unwrap();
        assert_eq!(
            open,
            Value::Array(vec![unrelated.clone(), a.clone(), b.clone()])
        );
        assert_eq!(
            doorway_solids(
                &open,
                &[a.clone(), b.clone()],
                std::slice::from_ref(&closed)
            )
            .unwrap(),
            original
        );
        assert_eq!(
            doorway_solids(
                &original,
                std::slice::from_ref(&a),
                std::slice::from_ref(&b)
            ),
            Err("edit.doorway-wall-changed")
        );
        assert_eq!(
            doorway_solids(
                &Value::Array(vec![closed.clone(), closed.clone()]),
                std::slice::from_ref(&closed),
                std::slice::from_ref(&a)
            ),
            Err("edit.doorway-wall-changed")
        );
        assert_eq!(
            doorway_solids(
                &original,
                &[closed.clone(), closed.clone()],
                std::slice::from_ref(&a)
            ),
            Err("edit.doorway-wall-changed")
        );
        assert_eq!(
            doorway_solids(&original, std::slice::from_ref(&closed), &[a.clone(), a]),
            Err("edit.doorway-wall-changed")
        );
        assert_eq!(
            doorway_solids(&original, &[closed], &[Value::Array(vec![])]),
            Err("edit.doorway-geometry")
        );
    }
}
