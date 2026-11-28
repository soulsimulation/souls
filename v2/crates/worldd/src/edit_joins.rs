//! A creator's place of a part into a bay's slot makes the joints a Soul's `part:put` into that slot makes (racks,
//! lane C): the bay's seated parts of the kinds it rests on, at its level ([`crate::assembly::default_joins`], the
//! put's own function), each a bare link (`Op::Link` with `bare`, the link alone, as a Soul's joint is). The parts a
//! place sees seated are the bay's before the batch and those the batch placed before it, so a batch that places
//! frames, then beams, joists and sheets is joined as a crew would build it, and one that places the beams first
//! leaves them joined to nothing. The batch is then checked whole, and the structure rule (`sim::structure`) judges it
//! at its commit, as it judges a Soul's put: a part left hanging refuses the batch `support.none`, naming it.
//!
//! A place whose batch already names its joints (bare links from it, `souls-god.mjs place --joins` or a batch op's
//! `joins`) keeps them, never filtered, as `part:put --joins`. Either way each joint is refused
//! `connectors-do-not-mate` where the two kinds' connectors do not mate, as a put's is, and is of the world's joint type.
//!
//! The joints are added after the creator's operations (as [`crate::buildsafe::with_buildings`] adds a building's
//! rooms), so a refusal names the creator's operations by their places in the batch.

use std::collections::{BTreeMap, BTreeSet};

use replica::apply::Replica;
use replica::edit::{self, Edit, Op, Ref, Refused, World};
use replica::encode::{Name, Value};
use replica::ids::{Id, Minter};
use replica::world_model::{End, show};
use sim::structure::Structure;

fn refused(op: Option<usize>, name: &'static str, detail: String) -> Refused {
    Refused { op, name, detail }
}

/// The batch with each place of a part into a bay's slot joined as a Soul's put joins it (see the module's notes).
/// A batch with no such place is left as it is; one the world's check would refuse is left for that check to refuse.
pub fn with_joins(
    batch: &mut Edit,
    copy: &Replica,
    world: &World,
    structure: &Structure,
    ground: Option<Id>,
) -> Result<(), Refused> {
    let kinds: BTreeMap<u64, Name> = batch
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Place { name, kind, .. } => Some((*name, kind.clone())),
            _ => None,
        })
        .collect();
    let kind_in_copy = |id: Id| {
        let tree = copy.tree();
        tree.handle(id)
            .and_then(|h| tree.node(h))
            .map(|n| n.kind().clone())
    };
    let kind_of = |r: Ref| match r {
        Ref::Node(id) => kind_in_copy(id),
        Ref::New(n) => kinds.get(&n).cloned(),
    };
    // The places into a bay's slot of a part the structure rule reads: (op index, name, part kind, bay, slot).
    let places: Vec<(usize, u64, Name, Ref, u64)> = batch
        .ops
        .iter()
        .enumerate()
        .filter_map(|(i, op)| match op {
            Op::Place {
                name,
                kind,
                parent,
                at,
                ..
            } => {
                let k = at.slot?;
                let bay = kind_of(*parent)?;
                (structure.is_bay(bay.as_str()) && structure.is_part(kind.as_str()))
                    .then(|| (i, *name, kind.clone(), *parent, k))
            }
            _ => None,
        })
        .collect();
    if places.is_empty() {
        return Ok(());
    }
    // The joints the batch names: bare links owned by a part it places.
    let mut named: BTreeMap<u64, Vec<(usize, Ref)>> = BTreeMap::new();
    for (i, op) in batch.ops.iter().enumerate() {
        if let Op::Link {
            ends: [Ref::New(p), other],
            owner: End::First,
            bare: true,
            ..
        } = op
        {
            named.entry(*p).or_default().push((i, *other));
        }
    }
    let ty = structure.joint_type().and_then(Name::new);
    // Named joints are checked as a put's are: of the world's joint type, between kinds whose connectors mate.
    for (i, op) in batch.ops.iter().enumerate() {
        let Op::Link {
            ty: t,
            ends: [Ref::New(p), other],
            owner: End::First,
            bare: true,
            ..
        } = op
        else {
            continue;
        };
        let Some((_, _, pk, ..)) = places.iter().find(|(_, n, ..)| n == p) else {
            continue;
        };
        if ty.as_ref() != Some(t) {
            return Err(refused(
                Some(i),
                "joint-undeclared",
                format!(
                    "a part's joint is a link of type {}, not {}",
                    ty.as_ref().map_or("(none declared)", Name::as_str),
                    t.as_str()
                ),
            ));
        }
        let ok = kind_of(*other)
            .ok_or_else(|| refused(Some(i), "edit.node-missing", "the joint's other end".into()))?;
        structure
            .mates(pk.as_str(), ok.as_str())
            .map_err(|r| refused(Some(i), r.name, r.detail))?;
    }
    let defaulted: Vec<_> = places
        .iter()
        .filter(|(_, n, ..)| !named.contains_key(n))
        .cloned()
        .collect();
    // The batch as it would stand, on a copy (no structure rule: only where its parts would be). A batch the world's
    // check refuses is left for that check.
    let Ok(planned) =
        edit::check(batch.clone(), copy, world).and_then(|c| sim::edit::plan(c, copy, ground))
    else {
        return Ok(());
    };
    let mut preview = copy.frozen();
    let Ok(committed) = sim::edit::commit(
        &mut preview,
        &mut Minter::new(sim::edit::PROVISIONAL),
        &planned,
        &[],
        0,
    ) else {
        return Ok(());
    };
    let tree = preview.tree();
    // Each placed node's place in the batch, and its name there.
    let order: BTreeMap<Id, (usize, u64)> = batch
        .ops
        .iter()
        .enumerate()
        .filter_map(|(i, op)| match op {
            Op::Place { name, .. } => committed.names.get(name).map(|id| (*id, (i, *name))),
            _ => None,
        })
        .collect();
    let mut next = batch
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Place { name, .. } | Op::Doorway { name, .. } | Op::Link { name, .. } => {
                Some(*name)
            }
            _ => None,
        })
        .max()
        .unwrap_or(0);
    let mut added = Vec::new();
    for (i, name, pk, bay, k) in defaulted {
        let bay_id = match bay {
            Ref::Node(id) => id,
            Ref::New(n) => committed.names[&n],
        };
        let Some(th) = tree.handle(bay_id) else {
            continue;
        };
        // Seated before this place: in the bay before the batch, or placed by an earlier operation of it.
        let seated = |id: Id| order.get(&id).is_none_or(|(j, _)| *j < i);
        let joins = crate::assembly::default_joins(tree, structure, th, pk.as_str(), k, &seated);
        if joins.is_empty() {
            continue;
        }
        let ty = ty
            .clone()
            .ok_or_else(|| refused(Some(i), "joint-undeclared", pk.as_str().to_owned()))?;
        let mut seen = BTreeSet::new();
        for other in joins.into_iter().filter(|o| seen.insert(*o)) {
            let ok = tree
                .handle(other)
                .and_then(|h| tree.node(h))
                .map(|n| n.kind().clone())
                .ok_or_else(|| refused(Some(i), "edit.node-missing", show(other)))?;
            structure
                .mates(pk.as_str(), ok.as_str())
                .map_err(|r| refused(Some(i), r.name, r.detail))?;
            next = next.checked_add(1).ok_or_else(|| {
                refused(
                    Some(i),
                    "edit.too-many-operations",
                    "no name left for a joint".into(),
                )
            })?;
            added.push(Op::Link {
                name: next,
                ty: ty.clone(),
                ends: [
                    Ref::New(name),
                    order
                        .get(&other)
                        .map_or(Ref::Node(other), |(_, n)| Ref::New(*n)),
                ],
                owner: End::First,
                field: 0,
                row: Vec::<Value>::new(),
                door: None,
                bare: true,
            });
        }
    }
    batch.ops.extend(added);
    // The structure rule on the joined batch, on a copy: a part it leaves hanging refuses it here, the operation that
    // places the part named and its kind and slot written where the world's verdict names a node not minted yet. The
    // commit judges it again on its tick.
    let verdict = edit::check(batch.clone(), copy, world)
        .and_then(|c| sim::edit::plan(c, copy, ground))
        .and_then(|p| {
            sim::edit::commit_guarded(
                &mut copy.frozen(),
                &mut Minter::new(sim::edit::PROVISIONAL),
                &p,
                &[],
                0,
                structure,
            )
        });
    match verdict {
        Err(r) if r.name.starts_with("support.") => Err(placed_named(r, &order, &places)),
        _ => Ok(()),
    }
}

/// `r` with each node the batch places written as the operation that places it, its kind and its slot (the first
/// one named is the refusal's operation).
fn placed_named(
    mut r: Refused,
    order: &BTreeMap<Id, (usize, u64)>,
    places: &[(usize, u64, Name, Ref, u64)],
) -> Refused {
    let shown: BTreeMap<String, (usize, u64)> =
        order.iter().map(|(id, at)| (show(*id), *at)).collect();
    let mut first = None;
    let mut out = String::new();
    let mut rest = r.detail.as_str();
    // Each id as `show` writes it (`ff:12`), read whole: its scope byte, a colon and every digit after it.
    while let Some(at) = rest.find(':') {
        let digits = rest[at + 1..]
            .find(|c: char| !c.is_ascii_digit())
            .map_or(rest.len(), |e| at + 1 + e);
        let start = at.saturating_sub(2);
        let token = rest.get(start..digits).filter(|_| digits > at + 1);
        match token.and_then(|t| shown.get(t)) {
            Some((i, name)) => {
                first.get_or_insert(*i);
                let what = places.iter().find(|(_, n, ..)| n == name).map_or(
                    format!("operation {i}"),
                    |(_, _, kind, _, k)| {
                        format!(
                            "operation {i} ({} in slot {k})",
                            replica::world_model::plain(kind.as_str())
                        )
                    },
                );
                out.push_str(&rest[..start]);
                out.push_str(&what);
            }
            None => out.push_str(&rest[..digits]),
        }
        rest = &rest[digits..];
    }
    out.push_str(rest);
    r.detail = out;
    r.op = first.or(r.op);
    r
}
