//! The open ground read again only where a change was (Engine v2 G3b, #3449). Cutting the whole of Eden's open ground
//! takes seconds; a set-down or an edit on it changes a few squares.
//!
//! - **By child.** [`Index`] keeps the open ground's scene as the parts its children give (`Scene::of_child`: a named
//!   place's water or outline, or everything standing in one child's subtree), each with its bounds, and the ground's
//!   own doorways. [`Scene::of`] is the same parts in the children's order, so a scene put together from some of them
//!   lists its boxes in the order the whole one does, and each square is cut from the same boxes in the same order.
//! - **What a change cuts again** ([`Index::recut`]): the children holding the nodes a part changes, read again from
//!   the tree it leaves, and the squares that meet their old or new bounds, grown by [`affect`] and by the reach of
//!   any doorway near them (a box beside a doorway sets how deep it is). Those squares are cut from a scene of the
//!   parts that meet them, grown by [`SELECT`] and twice the widest doorway, on the terrain under it alone.
//! - **What it gives back**: each square's dry pieces and its doorways' meets. A square's water pieces are cut from
//!   the waters and the ground cover only, so they are kept; the shores between them and the new dry pieces are
//!   found again by the route map (`crate::routes::Map::replace_squares`). A doorway whose meets changed has its
//!   building read again on the new meets (`crate::walk::town`).
//! - **When it cannot** (refused with why: the whole open ground is built again): the ground node itself, a water, a
//!   named place's outline or ground cover is changed (the water and the squares' extent are cut from them), or a
//!   changed square lies outside the squares cut so far.

use super::Turn;
use super::scene::{Doorway, Scene, Terrain, Xz};
use super::{Meet, OpenGround, Piece, SQUARE, prepare};
use replica::ids::Id;
use replica::tree::{Handle, Tree};
use replica::world_model::show;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

/// How far past a changed child's bounds its squares are cut again, µm, at least: more than a standard body's radius
/// with its margin, which a box is grown by. A larger body's cut reaches further ([`affect`]).
pub const AFFECT: i64 = 1_000_000;
/// What [`AFFECT`] keeps past a standard body's clearance (280 mm radius, its margin and 1 mm), µm: kept past every
/// class's.
const AFFECT_SLACK: i64 =
    AFFECT - (replica::kinds::sizes::Size::Standard.radius_mm() + super::MARGIN + 1) * 1000;

/// How far past a changed child's bounds its squares are cut again for a body of `radius` mm (S13b): [`AFFECT`], or
/// the body's clearance (the radius, its margin and 1 mm, which a box is grown by) with the same slack when that
/// reaches further, as a giant's does.
pub fn affect(radius: i64) -> i64 {
    AFFECT.max((radius + super::MARGIN + 1) * 1000 + AFFECT_SLACK)
}
/// How far past the squares cut again their scene reaches, besides twice the widest doorway, µm: a doorway's depth is
/// set by the boxes either side of it, and its passage reaches past the wall.
pub const SELECT: i64 = 4_000_000;
/// How far past its middle a doorway's cut can reach, besides half its width, µm: the wall's depth, the passage past
/// it and a body's radius.
const DOOR_REACH: i64 = 3_000_000;

/// One child's part of the open ground's scene, and its bounds (x and z, µm), none when it holds no geometry.
#[derive(Clone)]
struct Part {
    scene: Arc<Scene>,
    bb: Option<[i64; 4]>,
}

/// The open ground's scene by child (see the module's notes). Cheap to clone.
#[derive(Clone)]
pub struct Index {
    ground: Id,
    parts: Arc<BTreeMap<Id, Part>>,
    gates: Arc<Vec<Doorway>>,
    terrain: Option<Arc<Terrain>>,
    /// Half the widest doorway, µm.
    widest: i64,
}

/// A square cut again: where it is, its dry pieces, its doorways' meets and, per piece and triangle, whether it
/// lies on the terrain.
pub type Square = ((i32, i32), Vec<Piece>, Vec<Meet>, Vec<Vec<bool>>);

/// The squares a change cuts again: each with its dry pieces, the doorways' meets on them and, per piece and
/// triangle, whether it lies on the terrain; and the index as the change leaves it.
pub struct Recut {
    pub squares: Vec<Square>,
    pub index: Index,
    /// Whether the open ground's own doorways (its gates, placed by the buildings whose rooms they lead into) changed:
    /// a building with a doorway onto the ground placed, moved or removed (S13).
    pub gates_moved: bool,
}

impl Index {
    /// Whether `other` is this very index (the same shared handles), for [`crate::walk::town::Basis::same`].
    pub fn same(&self, other: &Index) -> bool {
        self.ground == other.ground
            && Arc::ptr_eq(&self.parts, &other.parts)
            && Arc::ptr_eq(&self.gates, &other.gates)
            && self.widest == other.widest
    }
}

fn grow(b: [i64; 4], d: i64) -> [i64; 4] {
    [b[0] - d, b[1] - d, b[2] + d, b[3] + d]
}

fn meets(a: &[i64; 4], b: &[i64; 4]) -> bool {
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

fn join(a: Option<[i64; 4]>, b: [i64; 4]) -> [i64; 4] {
    match a {
        None => b,
        Some(a) => [
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[2].max(b[2]),
            a[3].max(b[3]),
        ],
    }
}

fn ring_bb(bb: &mut Option<[i64; 4]>, ring: &[Xz]) {
    for p in ring {
        *bb = Some(join(*bb, [p[0], p[1], p[0], p[1]]));
    }
}

/// A doorway's reach on the open ground: its middle, grown by half its width and [`DOOR_REACH`].
fn door_bb(d: &Doorway) -> [i64; 4] {
    grow(
        [d.at[0], d.at[1], d.at[0], d.at[1]],
        d.width / 2 + DOOR_REACH,
    )
}

fn bounds(s: &Scene) -> Option<[i64; 4]> {
    let mut bb = None;
    for b in &s.solids {
        ring_bb(&mut bb, &b.ring);
    }
    for f in s.footprints.iter().chain(&s.covers) {
        ring_bb(&mut bb, &f.ring);
    }
    for d in &s.doorways {
        bb = Some(join(bb, door_bb(d)));
    }
    for w in &s.waters {
        ring_bb(&mut bb, &w.ring);
        ring_bb(&mut bb, &w.line);
        bb = bb.map(|b| grow(b, w.width / 2));
    }
    for a in &s.areas {
        ring_bb(&mut bb, a);
    }
    bb
}

/// How far past the open ground's extent a thing may stand on a ground with no terrain, µm (#3958): 100 m.
pub const REACH: i64 = 100_000_000;

/// Why the nodes `changed` leave something off the open ground `ground` (#3958), read from the tree `after` they were
/// changed into from `before`: a child of the ground whose geometry reaches past the ground's extent. The extent is
/// the box the terrain's tiles cover, or, with no terrain, the box of the ground's children's origins grown by
/// [`REACH`], each joined with the changed children's old bounds (a thing already there may stay). The open ground is
/// cut in squares over its whole extent, so a thing far off it would have the walkers' maps cut squares without end.
pub fn off_ground(
    before: &Tree,
    after: &Tree,
    ground: Id,
    changed: &[Id],
) -> Result<Option<String>, String> {
    let (Some(gb), Some(ga)) = (before.handle(ground), after.handle(ground)) else {
        return Ok(None);
    };
    let index = Index {
        ground,
        parts: Arc::default(),
        gates: Arc::default(),
        terrain: None,
        widest: 0,
    };
    // A terrain edit may grow the ground (`expand`, `land extend`): things may reach as far as it reaches after.
    let terrain = match (
        Terrain::extent(before, ground)?,
        Terrain::extent(after, ground)?,
    ) {
        (Some(a), Some(b)) => Some(join(Some(a), b)),
        (a, b) => a.or(b),
    };
    let mut extent = match terrain {
        Some(t) => Some(t),
        None => {
            let mut bb = None;
            for &c in before.children(gb).unwrap_or(&[]) {
                if let Some(p) = before.node(c).and_then(|n| n.place()) {
                    let (x, z) = (p.position.x, p.position.z);
                    bb = Some(join(bb, [x, z, x, z]));
                }
            }
            bb.map(|b| grow(b, REACH))
        }
    };
    for k in index.children(before, changed) {
        if let Some(h) = before.handle(k)
            && let Some(b) = reach(before, gb, h)?
        {
            extent = Some(join(extent, b));
        }
    }
    let Some(extent) = extent else {
        return Ok(None);
    };
    for k in index.children(after, changed) {
        let Some(h) = after.handle(k) else { continue };
        let Some(b) = reach(after, ga, h)? else {
            continue;
        };
        if b[0] < extent[0] || b[1] < extent[1] || b[2] > extent[2] || b[3] > extent[3] {
            return Ok(Some(format!(
                "{} reaches x {} to {} mm, z {} to {} mm, past the open ground's x {} to {} mm, z {} to {} mm",
                show(k),
                b[0] / 1000,
                b[2] / 1000,
                b[1] / 1000,
                b[3] / 1000,
                extent[0] / 1000,
                extent[2] / 1000,
                extent[1] / 1000,
                extent[3] / 1000
            )));
        }
    }
    Ok(None)
}

/// Where the ground's child at `h` reaches on the ground's plan (ground at `gh`), µm: the box of its geometry, or, with
/// none (a thing no walker meets, a loose beam), its origin.
fn reach(tree: &Tree, gh: Handle, h: Handle) -> Result<Option<[i64; 4]>, String> {
    if let Some(b) = bounds(&Scene::of_child(tree, gh, h, None)?) {
        return Ok(Some(b));
    }
    Ok(super::scene::xform_to(tree, h, gh)
        .ok()
        .map(|x| [x.pos.x, x.pos.z, x.pos.x, x.pos.z]))
}

/// The square (i, j) as a box, µm.
fn square_bb((i, j): (i32, i32)) -> [i64; 4] {
    let s = SQUARE * 1000;
    let (x, z) = (i64::from(i) * s, i64::from(j) * s);
    [x, z, x + s, z + s]
}

impl Index {
    /// The open ground `ground` of `tree`, by child.
    pub fn of(tree: &Tree, ground: Id) -> Result<Index, String> {
        let gh = tree.handle(ground).ok_or("no such ground")?;
        let terrain = Terrain::of(tree, ground)?.map(Arc::new);
        let mut parts = BTreeMap::new();
        for &c in tree.children(gh).ok_or("the ground")? {
            let id = tree.node(c).ok_or("a node that is gone")?.id();
            let scene = Scene::of_child(tree, gh, c, terrain.as_deref())?;
            let bb = bounds(&scene);
            parts.insert(
                id,
                Part {
                    scene: Arc::new(scene),
                    bb,
                },
            );
        }
        let gates = Scene::ground_doorways(tree, gh)?;
        let widest = parts
            .values()
            .flat_map(|p| &p.scene.doorways)
            .chain(&gates)
            .map(|d| d.width / 2)
            .max()
            .unwrap_or(0);
        Ok(Index {
            ground,
            parts: Arc::new(parts),
            gates: Arc::new(gates),
            terrain,
            widest,
        })
    }

    /// The child of the ground that holds `node` in `tree` (itself when it is one); `None` for the ground itself or a
    /// node not on it.
    fn child_of(&self, tree: &Tree, node: Id) -> Option<Id> {
        let mut up = node;
        loop {
            let p = tree.node(tree.handle(up)?)?.parent()?;
            if p == self.ground {
                return Some(up);
            }
            up = p;
        }
    }

    /// The open ground it indexes.
    pub fn ground(&self) -> Id {
        self.ground
    }

    /// The children of the ground holding the nodes `ids` in `tree`.
    pub fn children(&self, tree: &Tree, ids: &[Id]) -> BTreeSet<Id> {
        ids.iter().filter_map(|&n| self.child_of(tree, n)).collect()
    }

    /// The squares the nodes `changed` change, cut again from the tree `after` (`before`: the children of the ground
    /// that held them in the tree they were changed on, [`Index::children`]), for a body of `radius` mm; `cut`: the squares cut so far, with their meets. `None` when the whole open
    /// ground must be built again, with why (see the module's notes).
    pub fn recut(
        &self,
        before: &BTreeSet<Id>,
        after: &Tree,
        changed: &[Id],
        radius: i64,
        cut: &dyn Fn((i32, i32)) -> Option<Vec<Meet>>,
    ) -> Result<Recut, &'static str> {
        let gh = after.handle(self.ground).ok_or("no ground")?;
        let mut kids = before.clone();
        for &n in changed {
            if n == self.ground {
                return Err("the ground itself");
            }
            kids.extend(self.child_of(after, n));
        }
        let mut parts = (*self.parts).clone();
        let mut changed_bb: Option<[i64; 4]> = None;
        for &k in &kids {
            let old = parts.remove(&k);
            let new = match after.handle(k) {
                Some(h) if after.node(h).and_then(|n| n.parent()) == Some(self.ground) => {
                    let scene = Scene::of_child(after, gh, h, self.terrain.as_deref())
                        .map_err(|_| "a child that cannot be read")?;
                    let bb = bounds(&scene);
                    Some(Part {
                        scene: Arc::new(scene),
                        bb,
                    })
                }
                _ => None,
            };
            for p in old.iter().chain(&new) {
                let s = &p.scene;
                if !s.waters.is_empty() || !s.areas.is_empty() || !s.covers.is_empty() {
                    return Err("a water, a place's outline or ground cover");
                }
                if let Some(b) = p.bb {
                    changed_bb = Some(join(changed_bb, b));
                }
            }
            if let Some(p) = new {
                parts.insert(k, p);
            }
        }
        // The ground's doorways are placed by the buildings they lead into (`Scene::ground_doorways`): read again, and
        // where one changed, the squares about it before and after are cut again with the change (S13).
        let gates = Scene::ground_doorways(after, gh).map_err(|_| "the ground's doorways")?;
        let gates_moved = gates != *self.gates;
        let gates = if gates_moved {
            for d in self.gates.iter().filter(|d| !gates.contains(d)) {
                changed_bb = Some(join(changed_bb, door_bb(d)));
            }
            for d in gates.iter().filter(|d| !self.gates.contains(d)) {
                changed_bb = Some(join(changed_bb, door_bb(d)));
            }
            Arc::new(gates)
        } else {
            self.gates.clone()
        };
        let widest = parts
            .values()
            .flat_map(|p| &p.scene.doorways)
            .chain(gates.iter())
            .map(|d| d.width / 2)
            .max()
            .unwrap_or(0);
        let index = Index {
            ground: self.ground,
            parts: Arc::new(parts),
            gates,
            terrain: self.terrain.clone(),
            widest,
        };
        let Some(changed_bb) = changed_bb else {
            return Ok(Recut {
                squares: Vec::new(),
                index,
                gates_moved,
            });
        };
        // The change, grown, and every doorway near it (a box beside one sets its depth).
        let mut affect = grow(changed_bb, affect(radius));
        let doors = index.doorways(gh, after);
        for d in &doors {
            let b = door_bb(d);
            if meets(&b, &affect) {
                affect = join(Some(affect), b);
            }
        }
        let sq = SQUARE * 1000;
        let mut squares = Vec::new();
        for j in affect[1].div_euclid(sq)..=affect[3].div_euclid(sq) {
            for i in affect[0].div_euclid(sq)..=affect[2].div_euclid(sq) {
                squares.push((i as i32, j as i32));
            }
        }
        let mut window: Option<[i64; 4]> = None;
        for &s in &squares {
            cut(s).ok_or("a square not cut before")?;
            window = Some(join(window, square_bb(s)));
        }
        let window = grow(window.ok_or("no square")?, SELECT + 2 * self.widest);
        let mut scene = Scene {
            open: true,
            terrain: Terrain::within(after, self.ground, window).map_err(|_| "the terrain")?,
            ..Scene::default()
        };
        for &c in after.children(gh).ok_or("no ground")? {
            let Some(id) = after.node(c).map(|n| n.id()) else {
                continue;
            };
            if let Some(p) = index.parts.get(&id)
                && p.bb.is_some_and(|b| meets(&b, &window))
            {
                scene.add((*p.scene).clone());
            }
        }
        scene.doorways.extend(
            index
                .gates
                .iter()
                .filter(|d| meets(&door_bb(d), &window))
                .cloned(),
        );
        let terrain = scene.terrain.clone();
        let mut open = OpenGround(
            prepare(&scene, radius, Turn::NONE).map_err(|_| "the scene")?,
            None,
        );
        open.1 = terrain;
        let mut out = Vec::new();
        for (i, j) in squares {
            let p = open.cut_square(i, j);
            let on = open.on_terrain(&p.pieces);
            out.push(((i, j), p.pieces, p.meets, on));
        }
        Ok(Recut {
            squares: out,
            index,
            gates_moved,
        })
    }

    /// Every doorway of the open ground's scene, in its order.
    fn doorways(&self, gh: replica::tree::Handle, tree: &Tree) -> Vec<Doorway> {
        let mut out = Vec::new();
        for &c in tree.children(gh).unwrap_or(&[]) {
            if let Some(p) = tree.node(c).and_then(|n| self.parts.get(&n.id())) {
                out.extend(p.scene.doorways.iter().cloned());
            }
        }
        out.extend(self.gates.iter().cloned());
        out
    }
}
