//! Terrain and water (Engine v2 G5, #2762): a creator's landform (a hill, a range, a lake, a river) as an edit.
//!
//! - **The batch.** The creator's client expands a landform (`v2/client/src/creator/terrain`) with today's
//!   `packages/ground` as a tool (`v2/tools/terrain`): one place node for the landform under the open ground (its
//!   parameters, and for a lake or a pond the water itself: a place of water with its outline and level, as N1 imports
//!   Eden's waters), the open ground's tiles with the changed ones patched (`F_TILES`, N1's bytes), and a move for
//!   each thing resting on the changed ground, lifted or lowered by the ground's change under its origin. Undoing the
//!   batch (G4) takes the node away and gives the ground its tiles back.
//! - **The ground follows** through G3: `F_TILES` is a field the open ground is cut from, so the commit rebuilds the
//!   open ground off the clock and the walks planned on it are planned again (`crate::walk::town::Town::rebuild`).
//!   Steep cells (N11a) and water (N11b) are cut as they always are, and each route keeps to the ground its body's
//!   abilities allow (N5's masks), so a body that cannot wade goes round a pond.
//! - **What is refused**, by name ([`REFUSED`]), whole, before anything is minted or written:
//!   - [`UNDER_SOUL`]: a Soul's body stands on the open ground within its radius of a cell whose height the edit
//!     changes. Judged on the commit tick against the bodies as they stand then ([`Guard::judge`], lookups only).
//!   - [`UNDER_BUILDING`]: a thing holding a floor with a room stands where the ground changes (the box round its
//!     floors' surfaces, on the open ground): the ground is not re-terraced under a building (today's server does not
//!     re-check a joined or load-bearing part under a terrain edit either, `docs/architecture/godmode.md`).
//!   - [`UNSETTLED`]: a thing resting on the open ground whose origin's ground the edit raises or lowers, and which the
//!     batch does not move by exactly that change (a pose change written in the batch, never a silent move).
//!   - [`MALFORMED`]: the tiles cannot be read, their size changes, or their sample counts differ.
//! - **The heights compared** are N1's samples: a cell changes when one of its four corners does.
//!
//! Not here: erosion, tides, weather that changes movement, a terrain edit under a body that is not standing on the
//! open ground (a body in a seat is judged by G2's in-use rule, as the seat's move is), a landform that only adds a
//! water over unchanged ground under a Soul.

#[cfg(test)]
mod tests;

use super::safety::Who;
use crate::ground::scene::{
    F_SURFACES, F_TILE_SIZE, F_TILES, FLOOR, PLACE, ROOM, Terrain, xform_to,
};
use crate::ground::{HUMAN_RADIUS, MARGIN};
use replica::edit::{Checked, Op, Ref, Refused};
use replica::effects::{Header, Part};
use replica::encode::Value;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::tree::{Handle, Tree};
use replica::world_model::{plain, show};
use std::collections::{BTreeMap, BTreeSet};

/// A Soul's body stands where the ground changes.
pub const UNDER_SOUL: &str = "edit.terrain-under-soul";
/// A building stands where the ground changes.
pub const UNDER_BUILDING: &str = "edit.terrain-under-building";
/// A thing resting where the ground changes is not moved with it.
pub const UNSETTLED: &str = "edit.terrain-unsettled";
/// The tiles cannot be read, or their size or sample counts change.
pub const MALFORMED: &str = "edit.terrain-malformed";
/// Every refusal a terrain edit has of its own (A3's list).
pub const REFUSED: [&str; 4] = [UNDER_SOUL, UNDER_BUILDING, UNSETTLED, MALFORMED];

fn refused(name: &'static str, detail: impl Into<String>) -> Refused {
    Refused {
        op: None,
        name,
        detail: detail.into(),
    }
}

/// A terrain edit as planned off the clock: the open ground, the cells whose heights change (by global cell index,
/// each `cell` µm a side), and each thing resting there that the batch leaves where it was, with the height it should
/// have been lifted to.
#[derive(Clone, Debug)]
pub struct Guard {
    ground: Id,
    cell: i64,
    cells: BTreeSet<(i64, i64)>,
    unsettled: Vec<(Id, i64)>,
}

/// The tiles of the open ground `g` in `tree`: each (tx, tz) with its samples a side and its heights, mm.
type Tiles = BTreeMap<(i64, i64), (usize, Vec<i32>)>;

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn row(v: &Value) -> &[Value] {
    match v {
        Value::Array(a) => a,
        _ => &[],
    }
}

fn tiles(tree: &Tree, g: Handle) -> Result<(Option<i64>, Tiles), String> {
    let node = tree.node(g).ok_or("the open ground is gone")?;
    let f = node.fields();
    let size = f.get(&F_TILE_SIZE).and_then(int);
    let mut out = Tiles::new();
    for r in f.get(&F_TILES).map(row).unwrap_or(&[]) {
        let [tx, tz, Value::Bytes(h), Value::Bytes(c)] = row(r) else {
            return Err("a terrain tile is [tx, tz, heights, classes]".into());
        };
        let n = c.len().isqrt();
        if n == 0 || n * n != c.len() || h.len() != (n + 1) * (n + 1) * 4 {
            return Err("a terrain tile's heights and classes do not agree".into());
        }
        let heights = h
            .chunks_exact(4)
            .map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        let key = (int(tx).ok_or("a tile's tx")?, int(tz).ok_or("a tile's tz")?);
        out.insert(key, (n, heights));
    }
    Ok((size, out))
}

/// The cells, by global index, whose corners differ between `old` and `new` (a missing tile is flat at 0), and their
/// samples a side.
fn changed(old: &Tiles, new: &Tiles) -> Result<(usize, BTreeSet<(i64, i64)>), String> {
    let mut n_all = None;
    let mut cells = BTreeSet::new();
    let keys: BTreeSet<(i64, i64)> = old.keys().chain(new.keys()).copied().collect();
    for k in keys {
        let (a, b) = (old.get(&k), new.get(&k));
        let n = b.or(a).map_or(0, |t| t.0);
        if a.is_some_and(|a| a.0 != n) || n_all.is_some_and(|m| m != n) {
            return Err("terrain tiles of different sample counts".into());
        }
        n_all = Some(n);
        if a.map(|t| &t.1) == b.map(|t| &t.1) {
            continue;
        }
        let w = n + 1;
        let at = |t: Option<&(usize, Vec<i32>)>, i: usize| t.map_or(0, |t| t.1[i]);
        for j in 0..w {
            for i in 0..w {
                if at(a, j * w + i) == at(b, j * w + i) {
                    continue;
                }
                // The cells this sample is a corner of.
                for (di, dj) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let (ci, cj) = (i as i64 - di, j as i64 - dj);
                    let n = n as i64;
                    if (0..n).contains(&ci) && (0..n).contains(&cj) {
                        cells.insert((k.0 * n + ci, k.1 * n + cj));
                    }
                }
            }
        }
    }
    Ok((n_all.unwrap_or(1), cells))
}

/// Whether `node` holds a floor with a room: a building, never re-terraced.
fn building(tree: &Tree, h: Handle) -> Vec<Handle> {
    let mut floors = Vec::new();
    let mut stack = vec![h];
    while let Some(x) = stack.pop() {
        let kids = tree.children(x).unwrap_or(&[]);
        let kind = |c: Handle| tree.node(c).map(|n| plain(n.kind().as_str()).to_owned());
        if kind(x).as_deref() == Some(FLOOR)
            && kids.iter().any(|&c| kind(c).as_deref() == Some(ROOM))
        {
            floors.push(x);
        }
        stack.extend(kids.iter().copied());
    }
    floors
}

/// The box `[x0, z0, x1, z1]` (µm, the open ground's frame) round the surfaces of `floors`.
fn bounds(tree: &Tree, g: Handle, floors: &[Handle]) -> Result<[i64; 4], String> {
    let mut bb = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
    for &f in floors {
        let x = xform_to(tree, f, g)?;
        let rows = tree
            .node(f)
            .and_then(|n| n.fields().get(&F_SURFACES).cloned());
        for s in rows.as_ref().map(row).unwrap_or(&[]) {
            let [y, ring] = row(s) else {
                return Err("a surface is [y, ring]".into());
            };
            let y = int(y).ok_or("a surface's y")? * 1000;
            for p in row(ring) {
                let [px, pz, ..] = row(p) else {
                    return Err("a point is [x, z]".into());
                };
                let (px, pz) = (int(px).ok_or("a point")?, int(pz).ok_or("a point")?);
                let q = x.point(Vec3::new(px * 1000, y, pz * 1000))?;
                bb = [
                    bb[0].min(q.x),
                    bb[1].min(q.z),
                    bb[2].max(q.x),
                    bb[3].max(q.z),
                ];
            }
        }
    }
    Ok(bb)
}

impl Guard {
    /// Whether a changed cell meets the box `[x0, z0, x1, z1]` (µm).
    fn meets(&self, bb: [i64; 4]) -> bool {
        let c = |v: i64| v.div_euclid(self.cell);
        let (i0, j0, i1, j1) = (c(bb[0]), c(bb[1]), c(bb[2]), c(bb[3]));
        if (i1 - i0 + 1).saturating_mul(j1 - j0 + 1) > self.cells.len() as i64 {
            return self
                .cells
                .iter()
                .any(|&(i, j)| (i0..=i1).contains(&i) && (j0..=j1).contains(&j));
        }
        (i0..=i1).any(|i| (j0..=j1).any(|j| self.cells.contains(&(i, j))))
    }

    /// The cells whose heights change.
    pub fn cells(&self) -> usize {
        self.cells.len()
    }

    /// On the commit tick, lookups only: refuses the edit by the first Soul whose body stands on the open ground within
    /// its radius of a changed cell ([`UNDER_SOUL`]), then by the things it leaves where they were ([`UNSETTLED`]).
    pub fn judge(&self, bodies: &[Who]) -> Result<(), Refused> {
        let r = (HUMAN_RADIUS + MARGIN) * 1000;
        let under: Vec<&Who> = bodies
            .iter()
            .filter(|w| w.pose.frame.node == self.ground && w.pose.frame.slot.is_none())
            .filter(|w| {
                let p = w.pose.position;
                self.meets([p.x - r, p.z - r, p.x + r, p.z + r])
            })
            .collect();
        if !under.is_empty() {
            let text: Vec<String> = under
                .iter()
                .map(|w| {
                    let p = w.pose.position;
                    format!(
                        "{} stands at ({}, {}) mm, where the ground changes",
                        show(w.soul),
                        p.x / 1000,
                        p.z / 1000
                    )
                })
                .collect();
            return Err(refused(UNDER_SOUL, text.join("\n")));
        }
        let left: Vec<String> = self
            .unsettled
            .iter()
            .filter(|(t, _)| !bodies.iter().any(|w| w.body == *t))
            .map(|(t, y)| {
                format!(
                    "{} rests where the ground changes; the batch must move it to y = {y} µm",
                    show(*t)
                )
            })
            .collect();
        if !left.is_empty() {
            return Err(refused(UNSETTLED, left.join("\n")));
        }
        Ok(())
    }
}

/// Off the clock thread, on the frozen copy `before`, with the would-be `part` of `checked`: the guard of an edit that
/// sets the open ground's tiles, none for any other edit. Refuses a building on the changed ground and malformed
/// tiles here; the Souls and the resting things are judged on the commit tick ([`Guard::judge`]).
pub fn guard(
    before: &Tree,
    header: &Header,
    ground: Option<Id>,
    checked: &Checked,
    part: &Part,
) -> Result<Option<Guard>, Refused> {
    let Some(ground) = ground else {
        return Ok(None);
    };
    let sets_tiles = checked.edit.ops.iter().any(|op| {
        matches!(op, Op::Set { node: Ref::Node(n), field, .. } | Op::Rows { node: Ref::Node(n), field, .. }
            if *n == ground && (*field == F_TILES || *field == F_TILE_SIZE))
    });
    if !sets_tiles {
        return Ok(None);
    }
    let bad = |e: String| refused(MALFORMED, e);
    let mut after = before.frozen();
    after
        .apply(header, part)
        .map_err(|e| bad(format!("{}: {}", e.name, e.detail)))?;
    let (gb, ga) = (
        before
            .handle(ground)
            .ok_or_else(|| bad("no open ground".into()))?,
        after
            .handle(ground)
            .ok_or_else(|| bad("no open ground".into()))?,
    );
    let ((size0, old), (size1, new)) = (
        tiles(before, gb).map_err(bad)?,
        tiles(&after, ga).map_err(bad)?,
    );
    let Some(size) = size1 else {
        return Err(bad("the open ground's tiles have no size".into()));
    };
    if size <= 0 || size0.is_some_and(|s| s != size) {
        return Err(bad(format!(
            "the tile size changes from {size0:?} to {size} mm"
        )));
    }
    let (n, cells) = changed(&old, &new).map_err(bad)?;
    let guard = Guard {
        ground,
        cell: size * 1000 / n as i64,
        cells,
        unsettled: Vec::new(),
    };
    let (t0, t1) = (
        Terrain::of(before, ground).map_err(bad)?,
        Terrain::of(&after, ground).map_err(bad)?,
    );
    let height =
        |t: &Option<Terrain>, p: Vec3| t.as_ref().and_then(|t| t.height_at(p.x, p.z)).unwrap_or(0);
    let mut unsettled = Vec::new();
    for &c in before.children(gb).unwrap_or(&[]) {
        let Some(node) = before.node(c) else { continue };
        if plain(node.kind().as_str()) == PLACE {
            continue;
        }
        let floors = building(before, c);
        if !floors.is_empty() {
            let bb = bounds(before, gb, &floors).map_err(bad)?;
            if bb[0] <= bb[2] && guard.meets(bb) {
                return Err(refused(
                    UNDER_BUILDING,
                    format!("{} stands where the ground changes", show(node.id())),
                ));
            }
            continue;
        }
        let (Some(p), None) = (node.place(), node.slot()) else {
            continue;
        };
        let rise = height(&t1, p.position) - height(&t0, p.position);
        if rise == 0 {
            continue;
        }
        let want = p.position.y + rise;
        let now = after
            .handle(node.id())
            .and_then(|h| after.node(h))
            .and_then(|n| n.place());
        let lifted = now.is_some_and(|q| {
            q.position == Vec3::new(p.position.x, want, p.position.z)
                && q.orientation == p.orientation
        });
        if !lifted {
            unsettled.push((node.id(), want));
        }
    }
    Ok(Some(Guard { unsettled, ..guard }))
}
