//! A creator's edit committed (Engine v2 G1, #2746): the clock thread's share. `replica::edit::check` ran off the
//! clock on a frozen copy; here the clock thread confirms that what the edit touches is unchanged since it was planned
//! (`replica::edit::confirm`), mints the placed nodes' ids, and writes the batch as generic effects (T6) under one
//! cause, the edit's intent, with the creator as actor, through the one write path every act uses
//! ([`crate::commit::write`]): one part, applied whole or not at all, which the caller appends to the log as it does an
//! act's. It runs no search: the safety rule's verdict on its tick is lookups only.
//!
//! Each effect is written by its own node (T6 rule 6): a place by its parent, a move, set or remove by the node itself.
//! Operations in a row with the same writer and audience share one effect.
//!
//! The safety rule (G2's [`safety`], wired by #3280): [`plan`] runs off the clock after the check, writing the
//! would-be part on the copy (placed nodes under provisional ids, [`PROVISIONAL`], or, from the edit checker, the ids
//! its commit will mint, [`plan_classes`]) and handing it to
//! [`safety::guard`]. [`commit`] takes the plan and the bodies as they stand on its tick, and refuses the edit by the
//! first unsafe body's name ([`safety::Guard::judge`], lookups only) before it mints or writes anything.
//!
//! A terrain edit (G5's [`terrain`]) is guarded the same way: planned off the clock, its Souls and resting things
//! judged on the commit tick before the safety rule. A creator's weather is set through [`weather`].

pub mod safety;
pub mod terrain;
pub mod undo;
pub mod weather;

use crate::commit::{off_clock, write_guarded};
use crate::ground::Versions;
use crate::structure::Structure;
use crate::walk::town::{Basis, Rebuilt};
use replica::apply::Replica;
use replica::edit::{Checked, Op, Ref, Refused, confirm};
use replica::effects::{Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Minter, Scope};
use replica::kinds::sizes::Size;
use replica::pose::Frame;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::Audience;
use safety::{Guard, Known, Who, guard, guard_kept, guard_on};
use std::collections::BTreeMap;
use std::sync::Arc;

/// The scope of the ids a plan gives placed nodes on the copy: never minted for a node of a zone.
pub const PROVISIONAL: Scope = Scope([0xff; 16]);

/// A committed edit: its part, for the log and the views, and the receipt's map from each temporary name to the id
/// the engine minted for it.
#[derive(Clone, Debug)]
pub struct Committed {
    pub part: Arc<Part>,
    pub names: BTreeMap<u64, Id>,
}

/// An edit checked and guarded off the clock, ready for its commit tick.
pub struct Planned {
    pub checked: Checked,
    guard: Guard,
    classes: BTreeMap<Size, Guard>,
    terrain: Option<terrain::Guard>,
    map: Option<PlannedMap>,
}

/// The ground the guard built for a planned part on the checker's town (#3743), kept for the map preparation: it
/// installs this instead of building the same ground again when the part, its open ground, versions and basis are
/// the ones it prepares from ([`PlannedMap::reuse`]).
pub struct PlannedMap {
    part: Part,
    ground: Id,
    versions: Versions,
    basis: Basis,
    rebuilt: Rebuilt,
}

impl PlannedMap {
    /// The kept ground, when it is the ground `part` leaves on `ground` with `versions` and the very `basis` (shared
    /// handles, [`Basis::same`]): the same part byte for byte, so the same ids. Otherwise none, and the caller builds it.
    pub fn reuse(
        self,
        part: &Part,
        ground: Id,
        versions: &Versions,
        basis: &Basis,
    ) -> Option<Rebuilt> {
        let bytes = |p: &Part| encode(&p.to_value()).ok();
        (self.ground == ground
            && self.versions == *versions
            && self.basis.same(basis)
            && bytes(&self.part).is_some_and(|b| Some(b) == bytes(part)))
        .then_some(self.rebuilt)
    }
}

impl Planned {
    /// The ground the guard built, taken out to be reused or dropped off the clock (#3743).
    pub fn take_map(&mut self) -> Option<PlannedMap> {
        self.map.take()
    }
}

fn refused(name: &'static str, detail: impl Into<String>) -> Refused {
    Refused {
        op: None,
        name,
        detail: detail.into(),
    }
}

/// Off the clock thread, after `replica::edit::check` on the same copy: the safety rule's guard for the part the edit
/// would commit (see the module's notes). `ground` is the zone's open ground, none in a zone without one.
pub fn plan(checked: Checked, copy: &Replica, ground: Option<Id>) -> Result<Planned, Refused> {
    plan_with(checked, copy, ground, Minter::new(PROVISIONAL), |part| {
        Ok((guard(copy.tree(), copy.header(), ground, part)?, None))
    })
}

/// [`plan`] in a zone with a town (G2b, #3488): the guard cuts only what the edit can affect ([`safety::guard_on`]).
/// `known` is the town as it stood at the copy's version.
pub fn plan_on(checked: Checked, copy: &Replica, known: &Known) -> Result<Planned, Refused> {
    plan_with(
        checked,
        copy,
        Some(known.ground),
        Minter::new(PROVISIONAL),
        |part| Ok((guard_on(copy.tree(), copy.header(), part, known)?, None)),
    )
}

/// The same guarded plan, preparing every active non-default footprint off-clock. `names` is a copy of the minter
/// the commit will mint with (#3743), so the planned part has the ids the committed one will; on a town, the ground
/// the guard built is kept in the plan ([`Planned::take_map`]).
pub fn plan_classes(
    checked: Checked,
    copy: &Replica,
    ground: Option<Id>,
    known: Option<&Known<'_>>,
    sizes: impl IntoIterator<Item = Size>,
    names: Minter,
) -> Result<Planned, Refused> {
    let mut classes = BTreeMap::new();
    let planned = plan_with(checked, copy, ground, names, |part| {
        for size in sizes {
            if size != Size::Standard && !classes.contains_key(&size) {
                classes.insert(
                    size,
                    safety::guard_for(copy.tree(), copy.header(), ground, part, size)?,
                );
            }
        }
        match known {
            Some(k) => {
                let (g, rebuilt) = guard_kept(copy.tree(), copy.header(), part, k)?;
                let map = PlannedMap {
                    part: part.clone(),
                    ground: k.ground,
                    versions: k.versions.clone(),
                    basis: k.basis.clone(),
                    rebuilt,
                };
                Ok((g, Some(map)))
            }
            None => Ok((guard(copy.tree(), copy.header(), ground, part)?, None)),
        }
    })?;
    Ok(Planned { classes, ..planned })
}

fn plan_with(
    checked: Checked,
    copy: &Replica,
    ground: Option<Id>,
    mut minter: Minter,
    guard: impl FnOnce(&Part) -> Result<(Guard, Option<PlannedMap>), String>,
) -> Result<Planned, Refused> {
    off_clock();
    let names = names(&checked, &mut minter)?;
    let effects = effects(copy.tree(), copy.version(), &checked, &names, 0);
    let bytes = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(copy.header().hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ])))
    .map_err(|e| refused("encoding", e.to_string()))?;
    let part = Part::read(&bytes).map_err(|r| refused(r.name, r.detail))?;
    if let Some(g) = ground {
        on_ground(copy, g, &part)?;
    }
    let terrain = terrain::guard(copy.tree(), copy.header(), ground, &checked, &part)?;
    let (guard, map) = guard(&part).map_err(|e| refused("edit.unchecked", e))?;
    Ok(Planned {
        checked,
        guard,
        classes: BTreeMap::new(),
        terrain,
        map,
    })
}

/// A thing placed or moved off the world's open ground (#3958).
pub const OFF_GROUND: &str = "edit.off-ground";

/// Refuses, by [`OFF_GROUND`], a part that leaves a thing past the open ground `ground`'s extent
/// ([`crate::ground::open::off_ground`]), before any ground is cut for it: the walkers' maps are cut over the whole
/// extent, so a thing 100 km off would have the edit's check cut squares for minutes and every edit after it wait.
fn on_ground(copy: &Replica, ground: Id, part: &Part) -> Result<(), Refused> {
    let before = copy.tree();
    let changed = crate::ground::changed(before, part);
    if changed.is_empty() {
        return Ok(());
    }
    let mut after = before.frozen();
    // A part that does not apply is refused by the guard, which applies it again.
    if after.apply(copy.header(), part).is_err() {
        return Ok(());
    }
    match crate::ground::open::off_ground(before, &after, ground, &changed) {
        Ok(None) => Ok(()),
        Ok(Some(why)) => Err(refused(OFF_GROUND, why)),
        Err(e) => Err(refused("edit.unchecked", e)),
    }
}

/// Each placed node's temporary name and the id `minter` gives it.
fn names(checked: &Checked, minter: &mut Minter) -> Result<BTreeMap<u64, Id>, Refused> {
    let mut names = BTreeMap::new();
    for op in &checked.edit.ops {
        if let Op::Place { name, .. } | Op::Doorway { name, .. } | Op::Link { name, .. } = op {
            let id = minter
                .mint()
                .map_err(|e| refused("edit.ids-exhausted", e.to_string()))?;
            names.insert(*name, id);
        }
    }
    Ok(names)
}

/// Commits a planned edit on the live replica at world time `at` (see the module's notes), or refuses it whole: a
/// refusal changes nothing. `bodies` are the zone's Souls' bodies as they stand on this tick.
pub fn commit(
    live: &mut Replica,
    minter: &mut Minter,
    planned: &Planned,
    bodies: &[Who],
    at: Micros,
) -> Result<Committed, Refused> {
    commit_guarded(live, minter, planned, bodies, at, &Structure::default())
}

/// [`commit`], with the world's structure rule checked on the write (B18, `crate::structure`).
pub fn commit_guarded(
    live: &mut Replica,
    minter: &mut Minter,
    planned: &Planned,
    bodies: &[Who],
    at: Micros,
    structure: &Structure,
) -> Result<Committed, Refused> {
    commit_guarded_classes(
        live,
        minter,
        planned,
        bodies,
        at,
        structure,
        &BTreeMap::new(),
    )
}

pub fn commit_classes(
    live: &mut Replica,
    minter: &mut Minter,
    planned: &Planned,
    bodies: &[Who],
    at: Micros,
    classes: &BTreeMap<Id, Size>,
) -> Result<Committed, Refused> {
    commit_guarded_classes(
        live,
        minter,
        planned,
        bodies,
        at,
        &Structure::default(),
        classes,
    )
}
#[allow(clippy::too_many_arguments)]
fn commit_guarded_classes(
    live: &mut Replica,
    minter: &mut Minter,
    planned: &Planned,
    bodies: &[Who],
    at: Micros,
    structure: &Structure,
    classes: &BTreeMap<Id, Size>,
) -> Result<Committed, Refused> {
    let checked = &planned.checked;
    confirm(live, checked)?;
    if let Some(t) = &planned.terrain {
        t.judge(bodies)?;
    }
    let mut unsafe_ = Vec::new();
    for body in bodies {
        let size = classes.get(&body.body).copied().unwrap_or(Size::Standard);
        let guard = if size == Size::Standard {
            &planned.guard
        } else {
            match planned.classes.get(&size) {
                Some(guard) => guard,
                None if unsafe_.is_empty() => {
                    return Err(refused(
                        "edit.class-unchecked",
                        "the current body's footprint was not prepared",
                    ));
                }
                None => break,
            }
        };
        unsafe_.extend(guard.judge(std::slice::from_ref(body)));
    }
    if let Some(first) = unsafe_.first() {
        let detail = unsafe_.iter().map(|u| u.text()).collect::<Vec<_>>();
        return Err(refused(first.name, detail.join("\n")));
    }
    let names = names(checked, minter)?;
    let effects = effects(live.tree(), live.version(), checked, &names, at);
    let part = write_guarded(live, &effects, structure).map_err(|r| refused(r.name, r.detail))?;
    Ok(Committed { part, names })
}

/// The effects of a checked edit on `tree` at version `first`, its placed nodes under `names`.
fn effects(
    tree: &Tree,
    first: u64,
    checked: &Checked,
    names: &BTreeMap<u64, Id>,
    at: Micros,
) -> Vec<Effect> {
    let edit = &checked.edit;
    let audiences: BTreeMap<u64, Audience> = edit
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Place { name, audience, .. } => Some((*name, *audience)),
            _ => None,
        })
        .collect();
    let id = |r: Ref| match r {
        Ref::Node(id) => id,
        Ref::New(n) => names[&n],
    };
    let audience = |r: Ref| match r {
        Ref::New(n) => audiences[&n],
        Ref::Node(id) => names
            .iter()
            .find_map(|(name, minted)| {
                (*minted == id)
                    .then(|| audiences.get(name))
                    .flatten()
                    .copied()
            })
            .or_else(|| {
                tree.handle(id)
                    .and_then(|h| tree.node(h))
                    .map(|n| n.audience())
            })
            .unwrap_or(Audience::Everyone),
    };
    let mut frames: BTreeMap<Id, (Id, Option<u64>)> = BTreeMap::new();
    let mut fields: BTreeMap<(Id, u64), Value> = BTreeMap::new();
    let mut linked: BTreeMap<Id, [Id; 2]> = BTreeMap::new();
    let mut groups: Vec<(Id, Audience, Vec<Change>)> = Vec::new();
    for (index, op) in edit.ops.iter().enumerate() {
        if let Some(geometry) = checked.geometry.get(&index) {
            let wall = id(geometry.wall);
            fields.insert(
                (wall, crate::ground::scene::F_SOLIDS),
                geometry.solids.clone(),
            );
            groups.push((
                wall,
                audience(geometry.wall),
                vec![Change::Set {
                    node: wall,
                    field: crate::ground::scene::F_SOLIDS,
                    to: geometry.solids.clone(),
                    by: None,
                }],
            ));
        }
        if let Op::Doorway {
            name,
            door,
            from,
            to,
            at: [x, z],
            yaw,
            width,
            height,
            wall,
            closed,
            open,
        } = op
        {
            use crate::ground::scene::{DOORWAY, F_DOORWAYS, F_OPEN_DOOR_LINK};
            let (owner_audience, leaf_audience) = (audience(*from), audience(*door));
            let (from, to, door, link) = (id(*from), id(*to), id(*door), names[name]);
            let mut rows_list = match field(tree, &fields, from, F_DOORWAYS) {
                Value::Array(rows) => rows,
                _ => Vec::new(),
            };
            rows_list.push(Value::Array(vec![
                link.to_value(),
                Value::Text(Name::new("eden:door").unwrap()),
                int(*x),
                int(*z),
                int(*yaw),
                int(*width),
                int(*height),
            ]));
            let rows = Value::Array(rows_list);
            fields.insert((from, F_DOORWAYS), rows.clone());
            fields.insert((door, F_OPEN_DOOR_LINK), link.to_value());
            linked.insert(link, [from, to]);
            groups.push((
                from,
                owner_audience,
                vec![
                    Change::Link {
                        link,
                        ty: Name::new(DOORWAY).unwrap(),
                        ends: [from, to],
                        owner: replica::world_model::End::First,
                        audience: owner_audience,
                    },
                    Change::Set {
                        node: from,
                        field: F_DOORWAYS,
                        to: rows,
                        by: None,
                    },
                ],
            ));
            groups.push((
                door,
                leaf_audience,
                vec![
                    Change::Set {
                        node: door,
                        field: F_OPEN_DOOR_LINK,
                        to: link.to_value(),
                        by: None,
                    },
                    Change::Set {
                        node: door,
                        field: replica::edit::DOOR_GEOMETRY,
                        to: Value::Array(vec![
                            id(*wall).to_value(),
                            Value::Array(closed.clone()),
                            Value::Array(open.clone()),
                        ]),
                        by: None,
                    },
                ],
            ));
            continue;
        }
        if let Op::Link {
            name,
            ty,
            ends,
            owner,
            field: on,
            row,
            door,
        } = op
        {
            // #3728: the link, its row appended to its owner's field, and the door standing in it naming it.
            use crate::ground::scene::F_OPEN_DOOR_LINK;
            let end = usize::from(*owner == replica::world_model::End::Second);
            let (both, link) = ([id(ends[0]), id(ends[1])], names[name]);
            let (at, seen) = (both[end], audience(ends[end]));
            let mut rows = match field(tree, &fields, at, *on) {
                Value::Array(rows) => rows,
                _ => Vec::new(),
            };
            rows.push(Value::Array(
                std::iter::once(link.to_value())
                    .chain(row.iter().cloned())
                    .collect(),
            ));
            let rows = Value::Array(rows);
            fields.insert((at, *on), rows.clone());
            if end == 0 && *on == crate::ground::scene::F_DOORWAYS {
                linked.insert(link, both);
            }
            groups.push((
                at,
                seen,
                vec![
                    Change::Link {
                        link,
                        ty: ty.clone(),
                        ends: both,
                        owner: *owner,
                        audience: seen,
                    },
                    Change::Set {
                        node: at,
                        field: *on,
                        to: rows,
                        by: None,
                    },
                ],
            ));
            if let Some(door) = door {
                let d = id(*door);
                fields.insert((d, F_OPEN_DOOR_LINK), link.to_value());
                groups.push((
                    d,
                    audience(*door),
                    vec![Change::Set {
                        node: d,
                        field: F_OPEN_DOOR_LINK,
                        to: link.to_value(),
                        by: None,
                    }],
                ));
            }
            continue;
        }
        let (writer, seen_by, change) = match op {
            Op::Place {
                name,
                kind,
                parent,
                at,
                audience,
                fields,
            } => {
                let p = id(*parent);
                frames.insert(names[name], (p, at.slot));
                let change = Change::Create {
                    node: names[name],
                    kind: kind.clone(),
                    pose: at.pose(p),
                    audience: *audience,
                    fields: fields.clone(),
                };
                (p, *audience, change)
            }
            Op::Move { node, at } => {
                let n = id(*node);
                // Its frame as the batch has left it so far, else as the tree has it.
                let (parent, slot) = frames.get(&n).copied().unwrap_or_else(|| {
                    tree.handle(n)
                        .and_then(|h| tree.node(h))
                        .and_then(|x| x.parent().map(|p| (p, x.slot())))
                        .unwrap_or_else(|| unreachable!("the check found it"))
                });
                frames.insert(n, (parent, at.slot));
                let change = Change::Reparent {
                    node: n,
                    from: Frame { node: parent, slot },
                    pose: at.pose(parent),
                };
                (n, audience(*node), change)
            }
            Op::Set { node, field, to } => {
                let n = id(*node);
                let change = Change::Set {
                    node: n,
                    field: *field,
                    to: to.clone(),
                    by: None,
                };
                (n, audience(*node), change)
            }
            Op::Rows {
                node,
                field: on,
                rows,
            } => {
                // #3728: the field with the rows merged in, as one set (`replica::edit::merged_rows`); the check has
                // refused rows that do not merge, so the field as it is stands in for none.
                let n = id(*node);
                let now = field(tree, &fields, n, *on);
                let to = replica::edit::merged_rows(Some(&now), rows).unwrap_or(now);
                let change = Change::Set {
                    node: n,
                    field: *on,
                    to,
                    by: None,
                };
                (n, audience(*node), change)
            }
            Op::Remove { node } => {
                let n = id(*node);
                use crate::ground::scene::{DOORWAY, F_DOORWAYS, F_OPEN_DOOR_LINK};
                if let Ok(link) =
                    replica::effects::read_id(&field(tree, &fields, n, F_OPEN_DOOR_LINK))
                {
                    let ends = linked.get(&link).copied().or_else(|| {
                        tree.link(link)
                            .filter(|(ty, ..)| ty.as_str() == DOORWAY)
                            .map(|(_, ends, ..)| ends)
                    });
                    if let Some([owner, _]) = ends {
                        let mut rows = field(tree, &fields, owner, F_DOORWAYS);
                        if let Value::Array(ref mut rows_list) = rows {
                            rows_list.retain(|r| !matches!(r, Value::Array(r) if r.first() == Some(&link.to_value())));
                        }
                        fields.insert((owner, F_DOORWAYS), rows.clone());
                        groups.push((
                            owner,
                            audience(Ref::Node(owner)),
                            vec![
                                Change::Unlink { link },
                                Change::Set {
                                    node: owner,
                                    field: F_DOORWAYS,
                                    to: rows,
                                    by: None,
                                },
                            ],
                        ));
                        linked.remove(&link);
                    }
                }
                (n, audience(*node), Change::Remove { node: n })
            }
            Op::Doorway { .. } | Op::Link { .. } => unreachable!("handled above"),
        };
        match &change {
            Change::Create {
                node,
                fields: added,
                ..
            } => fields.extend(added.iter().map(|(k, v)| ((*node, *k), v.clone()))),
            Change::Set {
                node, field, to, ..
            } => {
                fields.insert((*node, *field), to.clone());
            }
            _ => {}
        }
        match groups.last_mut() {
            Some((w, a, changes)) if *w == writer && *a == seen_by => changes.push(change),
            _ => groups.push((writer, seen_by, vec![change])),
        }
    }
    groups
        .into_iter()
        .zip(first..)
        .map(|((node, audience, changes), sequence)| Effect {
            envelope: Envelope {
                sequence,
                at,
                cause: Cause::Intent(edit.intent),
                actor: edit.actor,
                audience,
                node,
            },
            body: Body::Changes(
                changes
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            ),
            events: None,
            rest: Rest::new(),
        })
        .collect()
}

fn field(tree: &Tree, staged: &BTreeMap<(Id, u64), Value>, node: Id, key: u64) -> Value {
    staged
        .get(&(node, key))
        .cloned()
        .or_else(|| {
            tree.handle(node)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.fields().get(&key).cloned())
        })
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

fn int(n: i64) -> Value {
    u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
}

#[cfg(test)]
mod doorway_lowering_tests {
    use super::*;
    use crate::ground::scene::{F_DOORWAYS, F_OPEN_DOOR_LINK, F_SOLIDS};
    use replica::edit::{DOOR_GEOMETRY, DoorGeometry, Edit};
    use replica::effects::Actor;

    /// #3728: a link operation lowers to the link, its row appended to the owner's field and the door naming it, in
    /// one part that passes its canonical reader; nothing else (no wall is cut).
    #[test]
    fn a_link_lowers_to_its_link_its_row_and_its_door() {
        let im = import_eden::load(&testworld::generate(1, 0).unwrap().text).unwrap();
        let header = import_eden::header(im.nodes["world"], &im.rules).unwrap();
        let door = im.nodes["door-building-to-b"];
        let leaf = im.tree.node(im.tree.handle(door).unwrap()).unwrap();
        let old = replica::effects::read_id(&leaf.fields()[&F_OPEN_DOOR_LINK]).unwrap();
        let (ty, [from, to], owner, _) = im.tree.link(old).unwrap();
        let owner_rows = |tree: &replica::tree::Tree| match tree
            .node(tree.handle(from).unwrap())
            .unwrap()
            .fields()
            .get(&F_DOORWAYS)
            .cloned()
        {
            Some(Value::Array(rows)) => rows,
            _ => Vec::new(),
        };
        let row = owner_rows(&im.tree)
            .into_iter()
            .find_map(|r| match r {
                Value::Array(r) if r.first() == Some(&old.to_value()) => Some(r[1..].to_vec()),
                _ => None,
            })
            .expect("the doorway's row at its owner");
        let checked = Checked {
            edit: Edit {
                claim: None,
                intent: Id::new(Scope([0xec; 16]), 1).unwrap(),
                actor: Actor::Creator(Id::new(Scope([0xed; 16]), 1).unwrap()),
                planned: 0,
                ops: vec![Op::Link {
                    name: 1,
                    ty: ty.clone(),
                    ends: [Ref::Node(from), Ref::Node(to)],
                    owner,
                    field: F_DOORWAYS,
                    row: row.clone(),
                    door: Some(Ref::Node(door)),
                }],
            },
            reads: Vec::new(),
            parents: Vec::new(),
            geometry: BTreeMap::new(),
        };
        let link = Id::new(Scope([0xee; 16]), 1).unwrap();
        let lowered = effects(&im.tree, 0, &checked, &BTreeMap::from([(1, link)]), 0);
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(header.hash().to_bytes())),
            (
                2,
                Value::Array(lowered.iter().map(Effect::to_value).collect()),
            ),
        ])))
        .unwrap();
        let part = Part::read(&bytes).expect("the lowered link's part passes its canonical reader");
        let mut want = owner_rows(&im.tree);
        want.push(Value::Array(
            std::iter::once(link.to_value()).chain(row).collect(),
        ));
        let mut seen = Vec::new();
        for effect in &part.effects {
            let Body::Changes(changes) = &effect.body else {
                continue;
            };
            for c in changes {
                match &c.change {
                    Change::Link { link: id, ends, .. } => {
                        assert_eq!((*id, *ends, effect.envelope.node), (link, [from, to], from));
                        seen.push("link");
                    }
                    Change::Set {
                        node,
                        field: F_DOORWAYS,
                        to: Value::Array(rows),
                        ..
                    } => {
                        assert_eq!(
                            (*node, rows),
                            (from, &want),
                            "the row is appended, the others kept"
                        );
                        seen.push("row");
                    }
                    Change::Set {
                        node,
                        field: F_OPEN_DOOR_LINK,
                        to: v,
                        ..
                    } => {
                        assert_eq!((*node, v), (door, &link.to_value()));
                        seen.push("door");
                    }
                    other => panic!("a link changes nothing else: {other:?}"),
                }
            }
        }
        assert_eq!(seen, ["link", "row", "door"]);
    }

    /// #3728: a rows operation lowers to one set of the whole field, each row merged over the one with its first two
    /// values (a land edit's changed tiles), the other rows kept.
    #[test]
    fn rows_lower_to_one_set_of_the_merged_field() {
        let im = import_eden::load(&testworld::generate(1, 0).unwrap().text).unwrap();
        let wall = im.nodes["building"];
        let Value::Array(rows) = im
            .tree
            .node(im.tree.handle(wall).unwrap())
            .unwrap()
            .fields()[&F_SOLIDS]
            .clone()
        else {
            panic!("solid rows")
        };
        let Value::Array(mut first) = rows[0].clone() else {
            panic!("a row")
        };
        first.push(Value::Uint(1));
        let added = Value::Array(vec![Value::Nint(9_999), Value::Nint(9_999)]);
        let checked = Checked {
            edit: Edit {
                intent: Id::new(Scope([0xec; 16]), 1).unwrap(),
                actor: Actor::Creator(Id::new(Scope([0xed; 16]), 1).unwrap()),
                planned: 0,
                ops: vec![Op::Rows {
                    node: Ref::Node(wall),
                    field: F_SOLIDS,
                    rows: vec![Value::Array(first.clone()), added.clone()],
                }],
            },
            reads: Vec::new(),
            parents: Vec::new(),
            geometry: BTreeMap::new(),
        };
        let lowered = effects(&im.tree, 0, &checked, &BTreeMap::new(), 0);
        let mut want = rows.clone();
        want[0] = Value::Array(first);
        want.push(added);
        let sets: Vec<_> = lowered
            .iter()
            .filter_map(|e| match &e.body {
                Body::Changes(c) => Some(c),
                _ => None,
            })
            .flatten()
            .map(|c| c.change.clone())
            .collect();
        assert_eq!(sets.len(), 1);
        assert!(
            matches!(&sets[0], Change::Set { node, field: F_SOLIDS, to: Value::Array(r), .. } if *node == wall && *r == want)
        );
    }

    #[test]
    fn g1f_lowered_doorway_part_uses_the_importers_qualified_row_label() {
        assert_eq!(
            DOOR_GEOMETRY, 100,
            "entries take 28 to 79 (replica::fields)"
        );
        let im = import_eden::load(&testworld::generate(1, 0).unwrap().text).unwrap();
        let header = import_eden::header(im.nodes["world"], &im.rules).unwrap();
        let door = im.nodes["door-building-to-b"];
        let leaf = im.tree.node(im.tree.handle(door).unwrap()).unwrap();
        let old_link = replica::effects::read_id(&leaf.fields()[&F_OPEN_DOOR_LINK]).unwrap();
        let (_, [from, to], ..) = im.tree.link(old_link).unwrap();
        let wall = im.nodes["building"];
        let solids = im
            .tree
            .node(im.tree.handle(wall).unwrap())
            .unwrap()
            .fields()[&F_SOLIDS]
            .clone();
        let Value::Array(rows) = &solids else {
            panic!("solid rows")
        };
        // Codec regression only: the served test separately proves authored geometry, admission and BUILDSAFE.
        let checked = Checked {
            edit: Edit {
                claim: None,
                intent: Id::new(Scope([0xec; 16]), 1).unwrap(),
                actor: Actor::Creator(Id::new(Scope([0xed; 16]), 1).unwrap()),
                planned: 0,
                ops: vec![Op::Doorway {
                    name: 1,
                    door: Ref::Node(door),
                    from: Ref::Node(from),
                    to: Ref::Node(to),
                    at: [1000, -550],
                    yaw: 0,
                    width: 1200,
                    height: 2100,
                    wall: Ref::Node(wall),
                    closed: vec![rows[0].clone()],
                    open: vec![rows[1].clone()],
                }],
            },
            reads: Vec::new(),
            parents: Vec::new(),
            geometry: BTreeMap::from([(
                0,
                DoorGeometry {
                    wall: Ref::Node(wall),
                    solids: solids.clone(),
                },
            )]),
        };
        let link = Id::new(Scope([0xee; 16]), 1).unwrap();
        let lowered = effects(&im.tree, 0, &checked, &BTreeMap::from([(1, link)]), 0);
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(header.hash().to_bytes())),
            (
                2,
                Value::Array(lowered.iter().map(Effect::to_value).collect()),
            ),
        ])))
        .unwrap();
        let part = Part::read(&bytes)
            .expect("the actual lowered doorway Part must pass its canonical reader");
        let mut saw = (false, false, false, false);
        for effect in &part.effects {
            let Body::Changes(changes) = &effect.body else {
                continue;
            };
            for change in changes {
                match &change.change {
                    Change::Link { link: id, ends, .. } => {
                        assert_eq!((*id, *ends), (link, [from, to]));
                        saw.0 = true;
                    }
                    Change::Set {
                        node,
                        field: F_DOORWAYS,
                        to: Value::Array(rows),
                        ..
                    } if *node == from => {
                        let Value::Array(row) = rows.last().unwrap() else {
                            panic!("doorway row")
                        };
                        assert_eq!(row[0], link.to_value());
                        assert_eq!(row[1], Value::Text(Name::new("eden:door").unwrap()));
                        saw.1 = true;
                    }
                    Change::Set {
                        node,
                        field: F_OPEN_DOOR_LINK,
                        to,
                        ..
                    } if *node == door => {
                        assert_eq!(*to, link.to_value());
                        saw.2 = true;
                    }
                    Change::Set {
                        node,
                        field: DOOR_GEOMETRY,
                        ..
                    } if *node == door => {
                        saw.3 = true;
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(saw, (true, true, true, true));
        println!(
            "G1f lowered Part canonical reader PASS; qualified eden:door row, exact link endpoints, leaf backlink and owned geometry present"
        );
    }
}
