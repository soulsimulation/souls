//! What one node's ground is cut from, read from K2's tree (`replica::tree`) into the node's own frame, in
//! micrometres: its floor surfaces, the boxes of every thing that stands on it, its doorways, and on the open ground
//! its waters and the footprints of the buildings on it. Nothing here is stored: a [`Scene`] is read, cut and dropped.
//!
//! The field numbers and kind names are N1's import (#2649, `v2/tools/import-eden/src/lib.rs`), which N2's test world (#2650) shares;
//! `tests/ground.rs` checks that they are equal to the importer's.

use i_overlay::core::overlay_rule::OverlayRule;
use replica::encode::Value;
use replica::ids::{Id, Scope, sha256};
use replica::pose::{Frame, Quat, Vec3};
use replica::tree::{Handle, Tree};
use replica::world_model::plain;

use super::{BODY_HIGH, BODY_LOW, P, STEP, ccw, op};

pub const F_OPEN_DOOR_LINK: u64 = 7; // a door thing: the doorway link it stands in (N1's F_DOORWAY)
pub const F_OUTLINE: u64 = 11;
pub const F_SOLIDS: u64 = 12;
pub const F_SLOTS: u64 = 13;
pub const F_SURFACES: u64 = 14;
pub const F_LINE: u64 = 16;
pub const F_LINE_WIDTH: u64 = 17;
pub const F_WATER_LEVEL: u64 = 18;
pub const F_PLACE_OF: u64 = 20;
pub const F_DOORWAYS: u64 = 22;
pub const F_TILE_SIZE: u64 = 24;
pub const F_TILES: u64 = 25;

pub const GROUND: &str = "eden:ground";
pub const FLOOR: &str = "eden:floor";
pub const ROOM: &str = "eden:room";
pub const WINDOW: &str = "eden:window";
pub const PLACE: &str = "eden:place";
pub const DOORWAY: &str = "eden:doorway";
const WATER: &str = "eden:water";

/// A point on the ground plane of the node's frame, micrometres: x and z.
pub type Xz = [i64; 2];

/// A floor surface at height `y`.
#[derive(Clone, Debug)]
pub struct Surface {
    pub y: i64,
    pub ring: Vec<Xz>,
}

/// An oriented box: its four corners on the ground plane and its height span, all in the node's frame.
#[derive(Clone, Debug)]
pub struct Solid {
    pub ring: [Xz; 4],
    pub y0: i64,
    pub y1: i64,
}

/// A doorway at this node: the link, its centre, a metre along its wall (`along`) and through it (`across`), its
/// width and the height of the floor it opens from. A step ([`steps_of`]) is a doorway of no depth on a low floor's
/// open edge, `across` pointing off the floor, or between two of a floor's surfaces ([`inner_steps_of`]); its link is
/// derived ([`step_id`]), never a link of the tree.
#[derive(Clone, Debug)]
pub struct Doorway {
    pub link: Id,
    pub at: Xz,
    pub along: Xz,
    pub across: Xz,
    pub width: i64,
    pub y: i64,
    pub step: bool,
}

/// A water on the open ground: its own outline (a ring, or a line and a width) and its level, kept for N11 (#2735).
#[derive(Clone, Debug)]
pub struct Water {
    pub place: Id,
    pub ring: Vec<Xz>,
    pub line: Vec<Xz>,
    pub width: i64,
    pub level: i64,
}

/// One node's ground, read from the tree. `open` is the open ground: its edges are no walls, so it is not shrunk.
#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub open: bool,
    pub surfaces: Vec<Surface>,
    pub solids: Vec<Solid>,
    /// Floors of buildings standing on the open ground: never open ground (each is a node of its own).
    pub footprints: Vec<Surface>,
    /// Ground cover on the open ground (footpaths, lawns, beds, shores, piers): floors with no room whose every
    /// surface is within [`STEP`] of the ground. They are walked as the open ground, over water too (a pier).
    pub covers: Vec<Surface>,
    pub doorways: Vec<Doorway>,
    pub waters: Vec<Water>,
    /// The outlines of the open ground's other named places (a square, a park): open ground, which they only widen
    /// the extent of, so an empty square is cut as well as one with things on it.
    pub areas: Vec<Vec<Xz>>,
    /// The open ground's terrain (N1b), on the open ground, or under a floor's thing that stands on it: what a
    /// footprint, a doorway or a step to the ground is measured from (#3227).
    pub terrain: Option<Terrain>,
}

/// The open ground's terrain (N1b, #3197), read from its node's `F_TILE_SIZE` and `F_TILES` (N1's import, byte for
/// byte as exported): square tiles of `side` µm, each with (n + 1)² heights at side / n spacing, sampled bilinearly,
/// and n² cells, each with a class byte (today's media codes, which the engine does not name). Read on demand, so a
/// [`Scene`] that has no use for the heights does not copy them. A point off every tile has no terrain (`None`).
#[derive(Clone, Default)]
pub struct Terrain {
    pub side: i64,
    tiles: std::collections::HashMap<(i64, i64), Tile>,
}

#[derive(Clone)]
struct Tile {
    /// Samples a side, n + 1.
    n: usize,
    /// (n + 1)² heights, µm: a row of x for each z.
    heights: Vec<i64>,
    /// n² class bytes, the same order.
    classes: Vec<u8>,
}

impl std::fmt::Debug for Terrain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Terrain({} tiles of {} µm)", self.tiles.len(), self.side)
    }
}

/// The cell of a tile holding a point: the tile, the cell's column and row, and the point's offset into the cell (µm).
struct At<'a> {
    tile: &'a Tile,
    i: usize,
    j: usize,
    u: i64,
    v: i64,
}

impl Terrain {
    /// The terrain of node `id` (the open ground), or `None` when it holds none.
    pub fn of(tree: &Tree, id: Id) -> Result<Option<Terrain>, String> {
        Terrain::read(tree, id, None)
    }

    /// As [`Terrain::of`], only the tiles that meet the box `[x0, z0, x1, z1]` (µm): the ground under one thing.
    pub fn within(tree: &Tree, id: Id, bb: [i64; 4]) -> Result<Option<Terrain>, String> {
        Terrain::read(tree, id, Some(bb))
    }

    fn read(tree: &Tree, id: Id, bb: Option<[i64; 4]>) -> Result<Option<Terrain>, String> {
        let n = tree
            .node(tree.handle(id).ok_or("no such node")?)
            .ok_or("no such node")?;
        let (Some(side), Some(rows)) = (
            n.fields().get(&F_TILE_SIZE).and_then(int),
            n.fields().get(&F_TILES),
        ) else {
            return Ok(None);
        };
        let side = side * 1000;
        if side <= 0 {
            return Err("a terrain tile of no size".into());
        }
        let mut tiles = std::collections::HashMap::new();
        for r in row(rows) {
            let [tx, tz, Value::Bytes(h), Value::Bytes(c)] = row(r) else {
                return Err("a terrain tile is [tx, tz, heights, classes]".into());
            };
            let k = (int(tx).ok_or("a tile's tx")?, int(tz).ok_or("a tile's tz")?);
            let out = |b: [i64; 4]| {
                (k.0 + 1) * side < b[0]
                    || k.0 * side > b[2]
                    || (k.1 + 1) * side < b[1]
                    || k.1 * side > b[3]
            };
            if bb.is_some_and(out) {
                continue;
            }
            let n = c.len().isqrt();
            if n == 0 || n * n != c.len() || h.len() != (n + 1) * (n + 1) * 4 {
                return Err("a terrain tile's heights and classes do not agree".into());
            }
            let heights = h
                .chunks_exact(4)
                .map(|b| i64::from(i32::from_le_bytes([b[0], b[1], b[2], b[3]])) * 1000)
                .collect();
            let tile = Tile {
                n,
                heights,
                classes: c.clone(),
            };
            tiles.insert(k, tile);
        }
        Ok(Some(Terrain { side, tiles }))
    }

    /// The cell holding (x, z), µm. A point on a tile's far edge, with no tile beyond, is on the tile's last cell.
    fn at(&self, x: i64, z: i64) -> Option<At<'_>> {
        let key = |p: i64| p.div_euclid(self.side);
        let (mut tx, mut tz) = (key(x), key(z));
        if !self.tiles.contains_key(&(tx, tz)) && x.rem_euclid(self.side) == 0 {
            tx -= 1;
        }
        if !self.tiles.contains_key(&(tx, tz)) && z.rem_euclid(self.side) == 0 {
            tz -= 1;
        }
        let tile = self.tiles.get(&(tx, tz))?;
        let cell = self.side / tile.n as i64;
        let (fx, fz) = (x - tx * self.side, z - tz * self.side);
        let last = tile.n as i64 - 1;
        let (i, j) = ((fx / cell).min(last), (fz / cell).min(last));
        Some(At {
            tile,
            i: i as usize,
            j: j as usize,
            u: fx - i * cell,
            v: fz - j * cell,
        })
    }

    /// The heights at a cell's four corners, µm: (i, j), (i + 1, j), (i, j + 1), (i + 1, j + 1).
    fn corners(a: &At) -> [i64; 4] {
        let w = a.tile.n + 1;
        let h = |i: usize, j: usize| a.tile.heights[j * w + i];
        [
            h(a.i, a.j),
            h(a.i + 1, a.j),
            h(a.i, a.j + 1),
            h(a.i + 1, a.j + 1),
        ]
    }

    /// The ground's height at (x, z), µm: bilinear between the four samples of the cell holding it, as today's
    /// `Terrain.sample` reads a tile, rounded to the nearest micrometre.
    pub fn height_at(&self, x: i64, z: i64) -> Option<i64> {
        let a = self.at(x, z)?;
        let s = i128::from(self.side / a.tile.n as i64);
        let [h00, h10, h01, h11] = Self::corners(&a).map(i128::from);
        let (u, v) = (i128::from(a.u), i128::from(a.v));
        let sum = h00 * (s - u) * (s - v) + h10 * u * (s - v) + h01 * (s - u) * v + h11 * u * v;
        let d = s * s;
        i64::try_from((sum + d / 2).div_euclid(d)).ok()
    }

    /// The slope of the cell holding (x, z): its mean rise across x and across z, combined, in parts per million
    /// (1,000,000 is a rise of a metre over a metre).
    pub fn slope_at(&self, x: i64, z: i64) -> Option<i64> {
        let a = self.at(x, z)?;
        let s = self.side / a.tile.n as i64;
        let [h00, h10, h01, h11] = Self::corners(&a);
        // Twice the mean rise over the cell's width, scaled to parts per million.
        let gx = i128::from(h10 - h00 + h11 - h01) * 500_000 / i128::from(s);
        let gz = i128::from(h01 - h00 + h11 - h10) * 500_000 / i128::from(s);
        i64::try_from((gx * gx + gz * gz).isqrt()).ok()
    }

    /// The class byte of the cell holding (x, z).
    pub fn class_at(&self, x: i64, z: i64) -> Option<u8> {
        let a = self.at(x, z)?;
        a.tile.classes.get(a.j * a.tile.n + a.i).copied()
    }

    /// The open ground's height at (x, z) under something at height `y`, µm: of the terrain's height (`t`) and 0, the
    /// nearer `y` (#3227). The open ground is the terrain, but ground cover over water (a pier, a shore) is at 0 over a
    /// bed far below, as N11a's mover reads it; 0 off the terrain or with none.
    pub fn ground(t: Option<&Terrain>, x: i64, z: i64, y: i64) -> i64 {
        match t.and_then(|t| t.height_at(x, z)) {
            Some(h) if (y - h).abs() < y.abs() => h,
            _ => 0,
        }
    }

    /// The tiles held.
    pub fn tiles(&self) -> usize {
        self.tiles.len()
    }
}

/// A rigid move from one frame to another, micrometres (T4's integer arithmetic).
#[derive(Clone, Copy, Debug)]
pub struct Xform {
    pub pos: Vec3,
    pub rot: Quat,
}

impl Xform {
    pub const IDENTITY: Xform = Xform {
        pos: Vec3::ZERO,
        rot: Quat::IDENTITY,
    };

    pub fn point(&self, p: Vec3) -> Result<Vec3, String> {
        let r = self.rot.rotate(p).map_err(|e| format!("{e:?}"))?;
        self.pos.plus(r).map_err(|e| format!("{e:?}"))
    }

    fn then(&self, child: Xform) -> Result<Xform, String> {
        Ok(Xform {
            pos: self.point(child.pos)?,
            rot: self.rot.then(child.rot).map_err(|e| format!("{e:?}"))?,
        })
    }
}

fn kind_of(tree: &Tree, h: Handle) -> String {
    tree.node(h)
        .map(|n| plain(n.kind().as_str()).to_owned())
        .unwrap_or_default()
}

/// The move from node `from` to its ancestor `frame` (the poses between, composed from the top down).
pub fn xform_to(tree: &Tree, from: Handle, frame: Handle) -> Result<Xform, String> {
    let mut chain = Vec::new();
    let mut at = from;
    while at != frame {
        let n = tree.node(at).ok_or("a node that is gone")?;
        let p = n.place().ok_or("a node outside the frame")?;
        let parent = n
            .parent()
            .and_then(|p| tree.handle(p))
            .ok_or("a node outside the frame")?;
        // A thing in a slot stands from the slot's point (T4's carry, as the import writes it since #3285).
        let point = match n.slot() {
            Some(sl) => slot_point(tree, parent, sl).ok_or("a slot its parent does not have")?,
            None => Vec3::ZERO,
        };
        chain.push(Xform {
            pos: point.plus(p.position).map_err(|e| format!("{e:?}"))?,
            rot: p.orientation,
        });
        at = parent;
    }
    let mut x = Xform::IDENTITY;
    for c in chain.iter().rev() {
        x = x.then(*c)?;
    }
    Ok(x)
}

/// Slot `n`'s point (`F_SLOTS`' `[n, x, y, z, …]` mm, the thing's frame) of node `h`, µm.
fn slot_point(tree: &Tree, h: Handle, n: u64) -> Option<Vec3> {
    let node = tree.node(h)?;
    let rows = node.fields().get(&F_SLOTS).map(row)?;
    rows.iter().map(row).find_map(|r| {
        (r.first().and_then(int)? == i64::try_from(n).ok()?).then_some(())?;
        let at = |k: usize| r.get(k).and_then(int).map(|v| v * 1000);
        Some(Vec3::new(at(1)?, at(2)?, at(3)?))
    })
}

/// Each slot of node `h` and its point in the frame of its ancestor `frame`, µm (none when it has no slots).
pub fn slot_points(tree: &Tree, h: Handle, frame: Handle) -> Result<Vec<(u64, Vec3)>, String> {
    let Some(rows) = tree.node(h).and_then(|n| n.fields().get(&F_SLOTS)).map(row) else {
        return Ok(Vec::new());
    };
    let x = xform_to(tree, h, frame)?;
    let mut out = Vec::new();
    for r in rows.iter().map(row) {
        let Some(n) = r.first().and_then(int).and_then(|n| u64::try_from(n).ok()) else {
            continue;
        };
        if let Some(p) = slot_point(tree, h, n) {
            out.push((n, x.point(p)?));
        }
    }
    Ok(out)
}

/// The boxes of every node of the subtree at `h`, in the frame of its ancestor `frame`.
pub fn solids_under(tree: &Tree, h: Handle, frame: Handle) -> Result<Vec<Solid>, String> {
    let mut out = Vec::new();
    let mut stack = vec![h];
    while let Some(at) = stack.pop() {
        solids_of(tree, at, &xform_to(tree, at, frame)?, &mut out)?;
        stack.extend(tree.children(at).unwrap_or(&[]).iter().copied());
    }
    Ok(out)
}

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

fn ring_mm(v: &Value) -> Result<Vec<Xz>, String> {
    row(v)
        .iter()
        .map(|p| match row(p) {
            [x, z, ..] => Ok([
                int(x).ok_or("a point")? * 1000,
                int(z).ok_or("a point")? * 1000,
            ]),
            _ => Err("a point is [x, z]".to_owned()),
        })
        .collect()
}

fn on_plane(x: &Xform, p: Xz, y: i64) -> Result<Vec3, String> {
    x.point(Vec3::new(p[0], y, p[1]))
}

fn yaw(mdeg: i64) -> Result<Quat, String> {
    Quat::from_yaw_mdeg(mdeg).map_err(|e| format!("{e:?}"))
}

/// The boxes of node `h` (an N1 `solids` row each), moved into the frame by `x`.
fn solids_of(tree: &Tree, h: Handle, x: &Xform, out: &mut Vec<Solid>) -> Result<(), String> {
    let Some(v) = tree
        .node(h)
        .and_then(|n| n.fields().get(&F_SOLIDS).cloned())
    else {
        return Ok(());
    };
    for r in row(&v) {
        let n: Vec<i64> = row(r).iter().map(|v| int(v).unwrap_or(0) * 1000).collect();
        let [cx, cz, hx, hz, yaw_um, y0, y1, ..] = n[..] else {
            return Err("a solid is [cx, cz, hx, hz, yaw, y0, y1, …]".into());
        };
        let b = Xform {
            pos: Vec3::new(cx, 0, cz),
            rot: yaw(yaw_um / 1000)?,
        };
        let w = x.then(b)?;
        let c = |u: i64, v: i64| on_plane(&w, [u, v], 0).map(|p| [p.x, p.z]);
        out.push(Solid {
            ring: [c(-hx, -hz)?, c(hx, -hz)?, c(hx, hz)?, c(-hx, hz)?],
            y0: y0 + w.pos.y,
            y1: y1 + w.pos.y,
        });
    }
    Ok(())
}

/// A floor's surfaces (N1's `F_SURFACES`, in the frame of the floor's thing), moved by `x`.
fn surfaces_of(tree: &Tree, floor: Handle, x: &Xform) -> Result<Vec<Surface>, String> {
    let Some(v) = tree
        .node(floor)
        .and_then(|n| n.fields().get(&F_SURFACES).cloned())
    else {
        return Ok(Vec::new());
    };
    row(&v)
        .iter()
        .map(|s| match row(s) {
            [y, ring] => {
                let y = int(y).ok_or("a surface's y")? * 1000;
                let ring = ring_mm(ring)?
                    .into_iter()
                    .map(|p| on_plane(x, p, y).map(|q| [q.x, q.z]))
                    .collect::<Result<_, _>>()?;
                Ok(Surface {
                    y: on_plane(x, [0, 0], y)?.y,
                    ring,
                })
            }
            _ => Err("a surface is [y, ring]".to_owned()),
        })
        .collect()
}

/// How far the surface `s` (in the open ground's frame) lies above the open ground under the middle of its ring
/// ([`Terrain::ground`], #3227).
pub fn above_ground(t: Option<&Terrain>, s: &Surface) -> i64 {
    let n = s.ring.len().max(1) as i64;
    let (x, z) = s
        .ring
        .iter()
        .fold((0, 0), |(x, z), p| (x + p[0] / n, z + p[1] / n));
    s.y - Terrain::ground(t, x, z, s.y)
}

/// Ground cover: the floor `floor` holds no room (no walls bound it) and every surface of it lies within [`STEP`] of
/// the ground under it, read in `frame` (the open ground's, on its terrain `t`). Its surfaces in `frame` when it is;
/// `None` when it is a floor of its own.
fn cover_of(
    tree: &Tree,
    floor: Handle,
    frame: Handle,
    t: Option<&Terrain>,
) -> Result<Option<Vec<Surface>>, String> {
    let kids = tree.children(floor).ok_or("a node that is gone")?;
    if kids.iter().any(|&c| kind_of(tree, c) == ROOM) {
        return Ok(None);
    }
    let thing = tree
        .node(floor)
        .and_then(|n| n.parent())
        .and_then(|p| tree.handle(p))
        .ok_or("a floor")?;
    let s = surfaces_of(tree, floor, &xform_to(tree, thing, frame)?)?;
    let low = !s.is_empty() && s.iter().all(|f| above_ground(t, f).abs() <= STEP * 1000);
    Ok(low.then_some(s))
}

/// Every thing in the subtree at `top` (itself included), in the frame `frame`: its boxes, and, when `footprints` is
/// given, the floors it holds as footprints, or as cover when they are ground cover. A door standing in a doorway is the link's, never an obstacle. Floors are
/// not walked into when footprints are taken (their things stand on those floors, not here).
fn things_below(
    tree: &Tree,
    top: Handle,
    frame: Handle,
    world_shapes: bool,
    s: &mut Scene,
    footprints: Option<&mut Vec<Surface>>,
) -> Result<(), String> {
    let t = s.terrain.take();
    let r = things_below_on(tree, top, frame, world_shapes, s, footprints, t.as_ref());
    s.terrain = t;
    r
}

/// [`things_below`] on the terrain `t` (the scene's own is not read).
fn things_below_on(
    tree: &Tree,
    top: Handle,
    frame: Handle,
    world_shapes: bool,
    s: &mut Scene,
    mut footprints: Option<&mut Vec<Surface>>,
    t: Option<&Terrain>,
) -> Result<(), String> {
    let mut stack = vec![top];
    while let Some(h) = stack.pop() {
        let n = tree.node(h).ok_or("a node that is gone")?;
        if carried(tree, h) {
            continue;
        }
        let k = plain(n.kind().as_str());
        if k == FLOOR
            && let Some(f) = footprints.as_deref_mut()
        {
            match cover_of(tree, h, frame, t)? {
                Some(c) => s.covers.extend(c),
                None => {
                    let thing = n.parent().and_then(|p| tree.handle(p)).ok_or("a floor")?;
                    let x = xform_to(tree, thing, frame)?;
                    f.extend(surfaces_of(tree, h, &x)?);
                    let steps = steps_of(tree, h, &x, &x, t)?;
                    s.doorways.extend(steps);
                }
            }
            continue;
        }
        if k != FLOOR && k != ROOM && k != WINDOW && k != PLACE {
            let door = n.fields().contains_key(&F_OPEN_DOOR_LINK);
            if !door {
                // A path or area thing at the root of the open ground carries world-frame geometry (N1's export).
                let shaped =
                    n.fields().contains_key(&F_OUTLINE) || n.fields().contains_key(&F_LINE);
                let x = if world_shapes && shaped && h == top {
                    Xform::IDENTITY
                } else {
                    xform_to(tree, h, frame)?
                };
                solids_of(tree, h, &x, &mut s.solids)?;
            }
        }
        stack.extend(
            tree.children(h)
                .ok_or("a node that is gone")?
                .iter()
                .copied(),
        );
    }
    Ok(())
}

/// Whether node `h` rides a slot its parent gives no point for (N19, #3341): a body's hands, a crew's carry. It is
/// carried, so neither it nor what it holds is fixed geometry; a part seated in a bay's slot (a point) is.
fn carried(tree: &Tree, h: Handle) -> bool {
    let Some(n) = tree.node(h) else {
        return false;
    };
    let (Some(sl), Some(p)) = (n.slot(), n.parent().and_then(|p| tree.handle(p))) else {
        return false;
    };
    slot_point(tree, p, sl).is_none()
}

/// Whether `p` lies within `r` of the ring `ring` (inside it, or within `r` of an edge), µm.
pub fn within(ring: &[Xz], p: Xz, r: i64) -> bool {
    if inside(ring, p) {
        return true;
    }
    let r2 = i128::from(r) * i128::from(r);
    (0..ring.len()).any(|k| {
        let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
        let (ex, ez) = (i128::from(b[0] - a[0]), i128::from(b[1] - a[1]));
        let (px, pz) = (i128::from(p[0] - a[0]), i128::from(p[1] - a[1]));
        let len2 = ex * ex + ez * ez;
        let t = if len2 == 0 {
            0
        } else {
            (px * ex + pz * ez).clamp(0, len2)
        };
        // The nearest point on the edge, as a fraction t / len2 of it.
        let (dx, dz) = if len2 == 0 {
            (px, pz)
        } else {
            (px - ex * t / len2, pz - ez * t / len2)
        };
        dx * dx + dz * dz <= r2
    })
}

/// The first body standing where `part` would be with the pose `place`, `turn` in the frame `to` (N19, #3341): a
/// node `body` says is one (by its kind), whose centre, read in the frame of `ground`, lies within `radius` mm of a
/// box of the part whose height span meets the body's ([`BODY_LOW`] to [`BODY_HIGH`] above its feet). The seating
/// refuses such a seat before the lift (`site.occupied`), as G2 refuses an edit that would bury a Soul.
#[allow(clippy::too_many_arguments)]
pub fn stands_in(
    tree: &Tree,
    ground: Id,
    part: Id,
    to: Frame,
    place: Vec3,
    turn: Quat,
    radius: i64,
    body: &dyn Fn(&str) -> bool,
) -> Result<Option<Id>, String> {
    let g = tree.handle(ground).ok_or("no such ground")?;
    let th = tree.handle(to.node).ok_or("no such frame")?;
    let ph = tree.handle(part).ok_or("no such part")?;
    let at = match to.slot {
        Some(sl) => slot_point(tree, th, sl).ok_or("a slot its parent does not have")?,
        None => Vec3::ZERO,
    };
    let x = xform_to(tree, th, g)?.then(Xform {
        pos: at.plus(place).map_err(|e| format!("{e:?}"))?,
        rot: turn,
    })?;
    let mut boxes = Vec::new();
    solids_of(tree, ph, &x, &mut boxes)?;
    let mut stack = vec![g];
    while let Some(h) = stack.pop() {
        let n = tree.node(h).ok_or("a node that is gone")?;
        stack.extend(
            tree.children(h)
                .ok_or("a node that is gone")?
                .iter()
                .copied(),
        );
        if h == g || !body(n.kind().as_str()) {
            continue;
        }
        let Ok(w) = xform_to(tree, h, g) else {
            continue;
        };
        let p = w.pos;
        let hit = boxes.iter().any(|s| {
            s.y1 > p.y + BODY_LOW * 1000
                && s.y0 < p.y + BODY_HIGH * 1000
                && within(&s.ring, [p.x, p.z], radius * 1000)
        });
        if hit {
            return Ok(Some(n.id()));
        }
    }
    Ok(None)
}

/// The doorway rows (N1's `F_DOORWAYS`, at each link's owning end) of every doorway link at `ends`, in `frame`.
fn doorways_at(tree: &Tree, ends: &[Handle], frame: Handle, s: &mut Scene) -> Result<(), String> {
    for &e in ends {
        for entry in tree.links_of(e).ok_or("a node that is gone")? {
            if tree.ty(entry).as_str() != DOORWAY {
                continue;
            }
            let (_, [owner, _], ..) = tree.link(entry.link).ok_or("a link that is gone")?;
            let oh = tree.handle(owner).ok_or("a doorway's owner")?;
            let on = tree.node(oh).ok_or("a doorway's owner")?;
            // A doorway's row is in its thing's frame; its height is the room's floor.
            let (thing, room_y) = if plain(on.kind().as_str()) == ROOM {
                let floor = on.parent().and_then(|p| tree.handle(p)).ok_or("a room")?;
                let thing = tree
                    .node(floor)
                    .and_then(|f| f.parent())
                    .and_then(|p| tree.handle(p))
                    .ok_or("a floor")?;
                (thing, on.place().map_or(0, |p| p.position.y))
            } else {
                (oh, 0)
            };
            let x = xform_to(tree, thing, frame)?;
            let rows = on.fields().get(&F_DOORWAYS).map(row).unwrap_or(&[]);
            let Some(r) = rows
                .iter()
                .find(|r| row(r).first() == Some(&entry.link.to_value()))
            else {
                return Err(format!(
                    "doorway {} has no row at its owner",
                    replica::world_model::show(entry.link)
                ));
            };
            let r = row(r);
            let n = |k: usize| r.get(k).and_then(int).ok_or("a doorway row");
            let (ax, az, yaw_mdeg, width) = (n(2)? * 1000, n(3)? * 1000, n(4)?, n(5)? * 1000);
            let d = Xform {
                pos: Vec3::new(ax, room_y, az),
                rot: yaw(yaw_mdeg)?,
            };
            let w = x.then(d)?;
            let at = on_plane(&w, [0, 0], 0)?;
            let al = w
                .rot
                .rotate(Vec3::new(1_000_000, 0, 0))
                .map_err(|e| format!("{e:?}"))?;
            let ac = w
                .rot
                .rotate(Vec3::new(0, 0, 1_000_000))
                .map_err(|e| format!("{e:?}"))?;
            if s.doorways.iter().any(|d| d.link == entry.link) {
                continue;
            }
            s.doorways.push(Doorway {
                link: entry.link,
                at: [at.x, at.z],
                along: [al.x, al.z],
                across: [ac.x, ac.z],
                width,
                y: at.y,
                step: false,
            });
        }
    }
    Ok(())
}

/// A step's link: derived, never minted, so that the floor's scene and the open ground's name the same step. Its
/// scope is the first 16 bytes of the SHA-256 of a label and the floor's id; its counter is the edge's number.
pub fn step_id(floor: Id, edge: u64) -> Id {
    let mut input = b"souls:step\0".to_vec();
    input.extend_from_slice(&floor.scope().0);
    input.extend_from_slice(&floor.counter().to_be_bytes());
    let h = sha256(&input);
    let mut scope = [0u8; 16];
    scope.copy_from_slice(&h[..16]);
    Id::new(Scope(scope), edge).expect("an edge's number is below 2^53")
}

/// Whether `p` lies inside the ring `r` (µm, crossing count, exact on integers).
fn inside(r: &[Xz], p: Xz) -> bool {
    let mut c = false;
    for k in 0..r.len() {
        let (a, b) = (r[k], r[(k + 1) % r.len()]);
        if (a[1] > p[1]) != (b[1] > p[1]) {
            let lhs = i128::from(p[0] - a[0]) * i128::from(b[1] - a[1]);
            let rhs = i128::from(b[0] - a[0]) * i128::from(p[1] - a[1]);
            if (b[1] > a[1] && lhs < rhs) || (b[1] < a[1] && lhs > rhs) {
                c = !c;
            }
        }
    }
    c
}

/// The steps off the floor `floor` of a thing standing on the open ground: each edge of the outline of its surfaces
/// (their union, in the thing's frame) where the surface it bounds lies within [`STEP`] of the open ground's height
/// there (`to_ground` moves the thing's frame into the ground's; the ground's height is its terrain's, `t`, or 0): a
/// porch's front, an arcade's open side. Each is a doorway of no depth on the edge, moved into the scene's frame by
/// `x`; N3 cuts its passage as a doorway's, less the boxes, so a wall or a rail along an edge leaves nothing to cross.
fn steps_of(
    tree: &Tree,
    floor: Handle,
    x: &Xform,
    to_ground: &Xform,
    t: Option<&Terrain>,
) -> Result<Vec<Doorway>, String> {
    let id = tree.node(floor).ok_or("a node that is gone")?.id();
    let own = surfaces_of(tree, floor, &Xform::IDENTITY)?;
    // The surfaces are whole millimetres (N1), so the grid holds them exactly.
    let grid = |p: &Xz| P::new((p[0] / 1000) as i32, (p[1] / 1000) as i32);
    let rings: Vec<Vec<P>> = own
        .iter()
        .map(|s| ccw(s.ring.iter().map(grid).collect()))
        .collect();
    let mut out = Vec::new();
    let mut edge = 0u64;
    for c in op(&rings, &[], OverlayRule::Union).iter().flatten() {
        for k in 0..c.len() {
            let (a, b) = (c[k], c[(k + 1) % c.len()]);
            let n = edge;
            edge += 1;
            let (ex, ez) = (i64::from(b.x - a.x), i64::from(b.y - a.y));
            let len = (ex * ex + ez * ez).isqrt();
            if len == 0 {
                continue;
            }
            let mid = [
                (i64::from(a.x) + i64::from(b.x)) * 500,
                (i64::from(a.y) + i64::from(b.y)) * 500,
            ];
            // The floor lies on the edge's left (outer rings counter-clockwise, holes clockwise): its surface is the
            // highest holding the point 2 mm that way.
            let into = [mid[0] - ez * 2000 / len, mid[1] + ex * 2000 / len];
            let Some(y) = own
                .iter()
                .filter(|s| inside(&s.ring, into))
                .map(|s| s.y)
                .max()
            else {
                continue;
            };
            let g = on_plane(to_ground, mid, y)?;
            if (g.y - Terrain::ground(t, g.x, g.z, g.y)).abs() > STEP * 1000 {
                continue;
            }
            let at = on_plane(x, mid, y)?;
            let turn = |v: [i64; 2]| {
                x.rot
                    .rotate(Vec3::new(v[0], 0, v[1]))
                    .map(|r| [r.x, r.z])
                    .map_err(|e| format!("{e:?}"))
            };
            out.push(Doorway {
                link: step_id(id, n),
                at: [at.x, at.z],
                along: turn([ex * 1_000_000 / len, ez * 1_000_000 / len])?,
                across: turn([ez * 1_000_000 / len, -ex * 1_000_000 / len])?,
                width: len * 1000,
                y: at.y,
                step: true,
            });
        }
    }
    Ok(out)
}

/// Where an inner step's link counters start ([`inner_steps_of`]), above any outline edge's number.
const INNER: u64 = 1 << 40;

/// The steps inside a floor: where two of its surfaces share a stretch of edge (within 2 mm of one line, at least
/// 10 mm long) and lie apart in height by no more than [`STEP`], what a body steps over (a bridge's deck, its quads
/// each 100 to 145 mm above the last). Each is a doorway of no depth on that stretch, at the height between the two,
/// whose link joins the floor to itself (N4 reads both its ends on the floor's patch). Its link is derived as a step
/// off the floor's outline is ([`step_id`]), counted from [`INNER`]. Surfaces of one height are one surface already;
/// surfaces further apart are joined only by a stair.
fn inner_steps_of(floor: Id, own: &[Surface]) -> Vec<Doorway> {
    let mut out = Vec::new();
    let mut k = INNER;
    for (i, s) in own.iter().enumerate() {
        for t in &own[i + 1..] {
            let dy = (s.y - t.y).abs();
            if dy == 0 || dy > STEP * 1000 {
                continue;
            }
            for e in 0..s.ring.len() {
                let (a, b) = (s.ring[e], s.ring[(e + 1) % s.ring.len()]);
                let (ex, ez) = (i128::from(b[0] - a[0]), i128::from(b[1] - a[1]));
                let len = (ex * ex + ez * ez).isqrt();
                if len == 0 {
                    continue;
                }
                for f in 0..t.ring.len() {
                    let (c, d) = (t.ring[f], t.ring[(f + 1) % t.ring.len()]);
                    // Off the line through a and b, and along it from a, µm.
                    let off =
                        |p: Xz| (ex * i128::from(p[1] - a[1]) - ez * i128::from(p[0] - a[0])) / len;
                    let on =
                        |p: Xz| (ex * i128::from(p[0] - a[0]) + ez * i128::from(p[1] - a[1])) / len;
                    if off(c).abs() > 2_000 || off(d).abs() > 2_000 {
                        continue;
                    }
                    let (lo, hi) = (on(c).min(on(d)).max(0), on(c).max(on(d)).min(len));
                    if hi - lo < 10_000 {
                        continue;
                    }
                    let at = |u: i128| [a[0] + (ex * u / len) as i64, a[1] + (ez * u / len) as i64];
                    let unit = |v: i128| (v * 1_000_000 / len) as i64;
                    out.push(Doorway {
                        link: step_id(floor, k),
                        at: at((lo + hi) / 2),
                        along: [unit(ex), unit(ez)],
                        across: [unit(ez), -unit(ex)],
                        width: (hi - lo) as i64,
                        y: (s.y + t.y) / 2,
                        step: true,
                    });
                    k += 1;
                }
            }
        }
    }
    out
}

impl Scene {
    /// The part of the open ground's scene (at `ground`, on its terrain `t`) that its child `c` gives: a named place's
    /// water or outline, or everything standing in the subtree at `c`. [`Scene::of`] is these parts in the children's
    /// order, then the ground's own doorways ([`Scene::ground_doorways`]); G3b (#3449) reads again only the parts of
    /// the children a change touches (`crate::ground::open`).
    pub fn of_child(
        tree: &Tree,
        ground: Handle,
        c: Handle,
        t: Option<&Terrain>,
    ) -> Result<Scene, String> {
        let mut s = Scene {
            open: true,
            ..Scene::default()
        };
        let n = tree.node(c).ok_or("a node that is gone")?;
        if plain(n.kind().as_str()) == PLACE {
            if n.fields()
                .get(&F_PLACE_OF)
                .is_some_and(|v| matches!(v, Value::Text(t) if t.as_str() == WATER))
            {
                let f = n.fields();
                s.waters.push(Water {
                    place: n.id(),
                    ring: f
                        .get(&F_OUTLINE)
                        .map(ring_mm)
                        .transpose()?
                        .unwrap_or_default(),
                    line: f.get(&F_LINE).map(ring_mm).transpose()?.unwrap_or_default(),
                    width: f.get(&F_LINE_WIDTH).and_then(int).unwrap_or(0) * 1000,
                    level: f.get(&F_WATER_LEVEL).and_then(int).unwrap_or(0) * 1000,
                });
            } else if let Some(r) = n.fields().get(&F_OUTLINE) {
                s.areas.push(ring_mm(r)?);
            }
            return Ok(s);
        }
        let mut footprints = Vec::new();
        things_below_on(tree, c, ground, true, &mut s, Some(&mut footprints), t)?;
        s.footprints = footprints;
        Ok(s)
    }

    /// The open ground's own doorways (its gates' rows), as [`Scene::of`] reads them last.
    pub fn ground_doorways(tree: &Tree, ground: Handle) -> Result<Vec<Doorway>, String> {
        let mut s = Scene::default();
        doorways_at(tree, &[ground], ground, &mut s)?;
        Ok(s.doorways)
    }

    /// Appends `part`'s geometry to this scene's, each list after its own (the terrain is kept).
    pub fn add(&mut self, part: Scene) {
        self.surfaces.extend(part.surfaces);
        self.solids.extend(part.solids);
        self.footprints.extend(part.footprints);
        self.covers.extend(part.covers);
        self.doorways.extend(part.doorways);
        self.waters.extend(part.waters);
        self.areas.extend(part.areas);
    }
    /// The ground of node `id`: a floor (its surfaces, everything its building holds, its doorways) or the open ground
    /// (everything on it, the footprints of its buildings, its ground cover, its doorways, its waters). Anything else
    /// has no ground, and nor has a floor that is ground cover on the open ground (`ground-cover`): it is walked as the
    /// open ground, so a body on it stays on the open ground and crossing its edge is no transfer.
    pub fn of(tree: &Tree, id: Id) -> Result<Scene, String> {
        let h = tree.handle(id).ok_or("no such node")?;
        let mut s = Scene::default();
        match kind_of(tree, h).as_str() {
            FLOOR => {
                let n = tree.node(h).ok_or("no such node")?;
                let p = n.place().ok_or("a floor with no place")?;
                if p.position != Vec3::ZERO || p.orientation != Quat::IDENTITY {
                    return Err("a floor not at its building's origin".into());
                }
                let thing = n.parent().and_then(|p| tree.handle(p)).ok_or("a floor")?;
                // The open ground the thing stands on, when no floor lies between (as the ground takes footprints).
                let mut on_ground = None;
                let mut up = Some(thing);
                while let Some(a) = up {
                    match kind_of(tree, a).as_str() {
                        GROUND => {
                            // The terrain under the floor's surfaces, read in the ground's frame.
                            let w = surfaces_of(tree, h, &xform_to(tree, thing, a)?)?;
                            let mut bb = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
                            for p in w.iter().flat_map(|s| &s.ring) {
                                bb = [
                                    bb[0].min(p[0]),
                                    bb[1].min(p[1]),
                                    bb[2].max(p[0]),
                                    bb[3].max(p[1]),
                                ];
                            }
                            let g = tree.node(a).ok_or("the ground")?.id();
                            s.terrain = Terrain::within(tree, g, bb)?;
                            if cover_of(tree, h, a, s.terrain.as_ref())?.is_some() {
                                return Err("ground-cover: walked as the open ground".into());
                            }
                            on_ground = Some(a);
                            break;
                        }
                        FLOOR => break,
                        _ => {}
                    }
                    up = tree
                        .node(a)
                        .and_then(|x| x.parent())
                        .and_then(|p| tree.handle(p));
                }
                s.surfaces = surfaces_of(tree, h, &Xform::IDENTITY)?;
                if s.surfaces.is_empty() {
                    return Err("a floor with no surfaces".into());
                }
                things_below(tree, thing, thing, false, &mut s, None)?;
                let mut ends = vec![h];
                ends.extend(tree.children(h).ok_or("a floor")?.iter().copied());
                doorways_at(tree, &ends, thing, &mut s)?;
                s.doorways.extend(inner_steps_of(id, &s.surfaces));
                if let Some(g) = on_ground {
                    let to_ground = xform_to(tree, thing, g)?;
                    let steps =
                        steps_of(tree, h, &Xform::IDENTITY, &to_ground, s.terrain.as_ref())?;
                    s.doorways.extend(steps);
                }
            }
            GROUND => {
                s.open = true;
                s.terrain = Terrain::of(tree, id)?;
                for &c in tree.children(h).ok_or("the ground")? {
                    let part = Scene::of_child(tree, h, c, s.terrain.as_ref())?;
                    s.add(part);
                }
                doorways_at(tree, &[h], h, &mut s)?;
            }
            k => return Err(format!("{k} has no ground of its own")),
        }
        Ok(s)
    }
}
