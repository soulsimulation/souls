//! Where a world's new Souls arrive, as its creator names it (god-mode audit #5006, row 37): one field of the world's
//! root node, [`F_ARRIVAL`], naming a place of the world (a node on the open ground with an outline or a line: an
//! imported place, or an area or path a creator laid). It is an ordinary field written by a creator's edit (so only
//! the world's creator writes it), logged and streamed as any set is, and undone like any other. Births ring round the
//! middle of the place it names from the next tick (`worldd` `answers` births), with no restart. The empty list (what
//! `souls-god arrival --clear` writes, and what an undo of the first set leaves) names none: Souls then arrive where
//! the world's host put them (`world.json`'s `arrival`, else its `entry`). A place removed since names none either.
//!
//! A set of anything else is refused `edit.arrival-unknown`, by name, with what was wrong.

use crate::encode::Value;
use crate::ids::Id;
use crate::pose::Vec3;
use crate::tree::Tree;
use std::collections::BTreeMap;

/// The arrival field, on the world's root node: a place's id, or the empty list for none.
pub const F_ARRIVAL: u64 = 92;
/// The refusal of an arrival that names no place of the world.
pub const UNKNOWN: &str = "edit.arrival-unknown";
/// A place's outline, `[[x, z] mm …]` (import-eden's field 11).
const OUTLINE: u64 = 11;
/// A path's or a line place's line, `[[x, z] mm …]` (import-eden's field 16).
const LINE: u64 = 16;
/// The fields [`middle`] reads of a place.
pub const READS: [u64; 2] = [OUTLINE, LINE];

/// What an arrival value names: a place's id, none (the empty list), or why it is neither.
pub fn read(v: &Value) -> Result<Option<Id>, String> {
    match v {
        Value::Array(a) if a.is_empty() => Ok(None),
        _ => crate::effects::read_id(v)
            .map(Some)
            .map_err(|_| "an arrival is a place's id, or the empty list for none".to_owned()),
    }
}

/// The middle of a place's outline (or line), mm, in its own frame: the middle of the box round it, as `worldd
/// arrival` takes a facts place's. None when it has neither.
pub fn middle(fields: &BTreeMap<u64, Value>) -> Option<(i64, i64)> {
    let points = match fields.get(&OUTLINE).or_else(|| fields.get(&LINE))? {
        Value::Array(p) => p,
        _ => return None,
    };
    let int = |v: &Value| match v {
        Value::Uint(n) => i64::try_from(*n).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    };
    let xz: Vec<(i64, i64)> = points
        .iter()
        .filter_map(|p| match p {
            Value::Array(p) => Some((int(p.first()?)?, int(p.get(1)?)?)),
            _ => None,
        })
        .collect();
    let x0 = xz.iter().map(|p| p.0).min()?;
    let x1 = xz.iter().map(|p| p.0).max()?;
    let z0 = xz.iter().map(|p| p.1).min()?;
    let z1 = xz.iter().map(|p| p.1).max()?;
    Some(((x0 + x1) / 2, (z0 + z1) / 2))
}

/// Whether a node of kind `kind` is the open ground (`eden:ground`, or a world's own `*:ground`), what places stand on.
pub fn is_ground(kind: &str) -> bool {
    crate::world_model::plain(kind).ends_with(":ground")
}

/// Whether a node with `fields` is a place Souls can arrive at, `on_ground` whether it stands on the open ground
/// ([`is_ground`]): it does, and it has an outline or a line.
pub fn is_place(fields: &BTreeMap<u64, Value>, on_ground: bool) -> bool {
    on_ground && middle(fields).is_some()
}

/// Where the creator's arrival puts new Souls in `tree`: the open ground's id and the place's middle on it, µm. None
/// when the world's root names no place, or the place it names is gone or no longer one.
pub fn point(tree: &Tree) -> Option<(Id, Vec3)> {
    let root = tree.node(tree.root())?;
    let place = read(root.fields().get(&F_ARRIVAL)?).ok()??;
    let node = tree.handle(place).and_then(|h| tree.node(h))?;
    let ground = node.parent()?;
    let g = tree.handle(ground).and_then(|h| tree.node(h))?;
    if !is_place(node.fields(), is_ground(g.kind().as_str())) {
        return None;
    }
    let (x, z) = middle(node.fields())?;
    let at = node.place().map_or(Vec3::ZERO, |p| p.position);
    Some((
        ground,
        Vec3::new(
            at.x.checked_add(x.checked_mul(1000)?)?,
            0,
            at.z.checked_add(z.checked_mul(1000)?)?,
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pts(p: &[(i64, i64)]) -> Value {
        let int = |n: i64| {
            u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
        };
        Value::Array(
            p.iter()
                .map(|&(x, z)| Value::Array(vec![int(x), int(z)]))
                .collect(),
        )
    }

    #[test]
    fn an_arrival_is_a_place_id_or_none() {
        let id = Id::new(crate::ids::Scope([7; 16]), 3).unwrap();
        assert_eq!(read(&id.to_value()), Ok(Some(id)));
        assert_eq!(read(&Value::Array(Vec::new())), Ok(None));
        assert!(read(&Value::Uint(3)).is_err());
    }

    #[test]
    fn a_place_is_on_the_open_ground_with_an_outline_or_a_line_and_its_middle_is_its_box_s() {
        let area = BTreeMap::from([(
            OUTLINE,
            pts(&[(-4_000, 2_000), (6_000, 2_000), (6_000, 8_000)]),
        )]);
        let line = BTreeMap::from([(LINE, pts(&[(0, 0), (10_000, -4_000)]))]);
        assert_eq!(middle(&area), Some((1_000, 5_000)));
        assert_eq!(middle(&line), Some((5_000, -2_000)));
        assert!(is_place(&area, true));
        assert!(is_place(&line, true));
        assert!(
            !is_place(&area, false),
            "a room's outline is not on the open ground"
        );
        assert!(!is_place(&BTreeMap::new(), true), "a thing has no outline");
        assert!(is_ground("eden:ground@1220ab") && is_ground("testworld:ground"));
        assert!(!is_ground("eden:room@1220ab") && !is_ground("eden:groundskeeper"));
    }
}
