//! Where a world's new Souls arrive, as its creator names it (god-mode audit #5006, row 37): one field of the world's
//! root node, [`F_ARRIVAL`], naming a place of the world (a node on the open ground with an outline or a line: an
//! imported place, or an area or path a creator laid). It is an ordinary field written by a creator's edit (so only
//! the world's creator writes it), logged and streamed as any set is, and undone like any other. Births ring round the
//! middle of the place it names from the next tick (`worldd` `answers` births), with no restart. The empty list (what
//! `souls-god arrival --clear` writes, and what an undo of the first set leaves) names none: Souls then arrive where
//! the world's host put them (`world.json`'s `arrival`, else its `entry`). A place removed since names none either.
//!
//! A set of anything else is refused `edit.arrival-unknown`, by name, with what was wrong. A place Souls born at could not
//! walk away from is refused when the set is made: its middle cut off from the world's entry ([`CUT_OFF`]), or no
//! ground to stand on round it ([`NO_GROUND`]). Births check again, since the world changes after a set: a place gone
//! bad puts them where the host would, and at the world's entry when that is walled off or built over too.

use crate::encode::Value;
use crate::ids::Id;
use crate::pose::Vec3;
use crate::tree::Tree;
use std::collections::BTreeMap;

/// The arrival field, on the world's root node: a place's id, or the empty list for none.
pub const F_ARRIVAL: u64 = 92;
/// The refusal of an arrival that names no place of the world.
pub const UNKNOWN: &str = "edit.arrival-unknown";
/// The refusal of an arrival whose middle is on ground no walk from the world's entry reaches (a walled pen): Souls
/// born there could not leave. `worldd` checks it on its town when the set is made.
pub const CUT_OFF: &str = "edit.arrival-cut-off";
/// The refusal of an arrival with no spot births try round it (16 m) that a Soul can stand on and walk from: every join
/// would wait for ground. `worldd` checks it on its town when the set is made.
pub const NO_GROUND: &str = "edit.arrival-no-ground";
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
    // In i128: two far ends of an i64 never overflow their sum (a creator's values reach the clock's births).
    let mid = |a: i64, b: i64| i64::try_from((i128::from(a) + i128::from(b)) / 2).ok();
    Some((mid(x0, x1)?, mid(z0, z1)?))
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
    point_of(tree, read(root.fields().get(&F_ARRIVAL)?).ok()??)
}

/// Where Souls arriving at `place` are born round in `tree`: the open ground's id and the place's middle on it, µm.
/// None when it is gone or not a place.
pub fn point_of(tree: &Tree, place: Id) -> Option<(Id, Vec3)> {
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

    #[test]
    fn the_middle_of_far_ends_never_overflows() {
        let far = BTreeMap::from([(OUTLINE, pts(&[(i64::MAX, i64::MAX), (i64::MAX - 2, -1)]))]);
        assert_eq!(middle(&far), Some((i64::MAX - 1, (i64::MAX - 1) / 2)));
    }
}
