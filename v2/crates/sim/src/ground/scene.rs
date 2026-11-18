//! What one node's ground is cut from, read from K2's tree (`replica::tree`) into the node's own frame, in
//! micrometres: its floor surfaces, the boxes of every thing that stands on it, its doorways, and on the open ground
//! its waters and the footprints of the buildings on it. Nothing here is stored: a [`Scene`] is read, cut and dropped.
//!
//! The field numbers and kind names are N1's import (#2649, `v2/tools/import-eden/src/lib.rs`), which N2's test world (#2650) shares;
//! `tests/ground.rs` checks that they are equal to the importer's.

use i_overlay::core::overlay_rule::OverlayRule;
use replica::encode::Value;
use replica::ids::{Id, Scope, sha256};
use replica::pose::{Quat, Vec3};
use replica::tree::{Handle, Tree};
use replica::world_model::plain;

use super::{P, STEP, ccw, op};

pub const F_OPEN_DOOR_LINK: u64 = 7; // a door thing: the doorway link it stands in (N1's F_DOORWAY)
pub const F_OUTLINE: u64 = 11;
pub const F_SOLIDS: u64 = 12;
pub const F_SURFACES: u64 = 14;
pub const F_LINE: u64 = 16;
pub const F_LINE_WIDTH: u64 = 17;
pub const F_WATER_LEVEL: u64 = 18;
pub const F_PLACE_OF: u64 = 20;
pub const F_DOORWAYS: u64 = 22;

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
/// open edge, `across` pointing off the floor; its link is derived ([`step_id`]), never a link of the tree.
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
        chain.push(Xform {
            pos: p.position,
            rot: p.orientation,
        });
        at = n
            .parent()
            .and_then(|p| tree.handle(p))
            .ok_or("a node outside the frame")?;
    }
    let mut x = Xform::IDENTITY;
    for c in chain.iter().rev() {
        x = x.then(*c)?;
    }
    Ok(x)
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

/// Ground cover: the floor `floor` holds no room (no walls bound it) and every surface of it lies within [`STEP`] of
/// the ground, read in `frame` (the open ground's, whose height is 0 until N11, #2735, brings terrain). Its surfaces
/// in `frame` when it is; `None` when it is a floor of its own.
fn cover_of(tree: &Tree, floor: Handle, frame: Handle) -> Result<Option<Vec<Surface>>, String> {
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
    let low = !s.is_empty() && s.iter().all(|f| f.y.abs() <= STEP * 1000);
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
    mut footprints: Option<&mut Vec<Surface>>,
) -> Result<(), String> {
    let mut stack = vec![top];
    while let Some(h) = stack.pop() {
        let n = tree.node(h).ok_or("a node that is gone")?;
        let k = plain(n.kind().as_str());
        if k == FLOOR
            && let Some(f) = footprints.as_deref_mut()
        {
            match cover_of(tree, h, frame)? {
                Some(c) => s.covers.extend(c),
                None => {
                    let thing = n.parent().and_then(|p| tree.handle(p)).ok_or("a floor")?;
                    let x = xform_to(tree, thing, frame)?;
                    f.extend(surfaces_of(tree, h, &x)?);
                    s.doorways.extend(steps_of(tree, h, &x, &x)?);
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
/// (`to_ground` moves the thing's frame into the ground's; the ground is at 0 until N11, #2735, brings terrain): a
/// porch's front, an arcade's open side. Each is a doorway of no depth on the edge, moved into the scene's frame by
/// `x`; N3 cuts its passage as a doorway's, less the boxes, so a wall or a rail along an edge leaves nothing to cross.
fn steps_of(
    tree: &Tree,
    floor: Handle,
    x: &Xform,
    to_ground: &Xform,
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
            if on_plane(to_ground, mid, y)?.y.abs() > STEP * 1000 {
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

impl Scene {
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
                            if cover_of(tree, h, a)?.is_some() {
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
                if let Some(g) = on_ground {
                    let to_ground = xform_to(tree, thing, g)?;
                    s.doorways
                        .extend(steps_of(tree, h, &Xform::IDENTITY, &to_ground)?);
                }
            }
            GROUND => {
                s.open = true;
                let mut footprints = Vec::new();
                for &c in tree.children(h).ok_or("the ground")? {
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
                        continue;
                    }
                    things_below(tree, c, h, true, &mut s, Some(&mut footprints))?;
                }
                s.footprints = footprints;
                doorways_at(tree, &[h], h, &mut s)?;
            }
            k => return Err(format!("{k} has no ground of its own")),
        }
        Ok(s)
    }
}
