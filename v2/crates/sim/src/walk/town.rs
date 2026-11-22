//! The world's side of walking over the engine as it stands: N5's map for routes and lines, N6's surfaces, N4's links
//! and door writer for crossings, all read from K2's tree. It answers the walk skill's questions ([`View`]) and gives
//! the controller its tracks ([`Links`]); it never moves a body.
//!
//! - **Legs.** The route (N5, a body with hands) from where the body stands to the goal; each link it crosses is a
//!   leg's end, at the link's near end on the node the body stands on (N4, read with the open ground: a doorway
//!   between a building and the open ground has one end on each).
//! - **The next corner** (#3167: a fixed cost a tick). Each walker keeps a line of corners toward its leg's end: the
//!   leg's end when a straight walk on the body's surface reaches it (N6's walk, on a copy of the body), else the
//!   first line of the route from where it stands (on the open ground, on to the next portal the route crosses), each
//!   corner between its ends aimed at [`ROUND`] out from its turn (#3473). It moves on as each corner is reached
//!   ([`AT_CORNER`]), and a new line is searched for ([`View::search`], counted in [`Spent`]) only for a new leg's
//!   end or node, when the walker is pushed more than [`OFF_LINE`] off it, at the end
//!   of a line that stops short of the leg's end, or when a straight walk to the next corner, checked once in
//!   [`CHECK`] calls, is refused.
//! - **A crossing.** At the near end: a shut door is asked to open and the opening written at the end of that tick
//!   (N4's writer, the world as the cause and the walker as the Soul), and the body stands. Then the controller
//!   carries it along the
//!   link's line at its speed, never a longer step than speed times the tick, and stands on the far floor's surface
//!   at the line's end. The line is followed in the frame of the node the body stands on: a body coming in from the
//!   open ground follows it placed on the ground by the building's frame, and stands at the far end on the floor; a
//!   body going out follows it in the building's frame and stands at the far end on the open ground.
//! - **Changed ground** (G3, #2760). [`Town::rebuild`] runs off the clock thread on a copy of the tree: it applies a
//!   part as it will commit, finds the nodes whose ground it changes (`crate::ground::touched`) and bumps their
//!   versions. When the open ground is untouched it reads again only the buildings whose floors the part touches, on
//!   the open ground as last cut ([`Basis`], #3276). When the open ground alone is touched it cuts again only the
//!   squares the change meets (G3b, #3449, `crate::ground::open`), which the install puts on the route map and the
//!   ground's surface in place of the old ones (`Map::replace_squares`, `Surface::replace`). Otherwise (a water, ground
//!   cover, a square by water, a doorway's meets changed: [`Rebuilt::why`]) it builds the ground, the links and the
//!   route map whole from the tree as the part leaves it. It reads what the part changes in the tree it is given
//!   before applying the part to it, so it makes no second copy of the tree, and it panics on the clock thread in a
//!   debug build (`crate::commit::off_clock`). [`Town::install`] runs on the tick the part commits: it commits the part
//!   through the zone's one write and, in the same call, swaps the ground in or replaces the buildings read again on
//!   the route map ([`Map::replace`]), so no tick sees new geometry over old ground. Each plan records the ground it
//!   crossed, each node with its version ([`Town::planned_on`]); the install lists the walks planned on the changed
//!   ground ([`Town::stale`]), and the ladder plans them again (`crate::unstick`).
//! - **Turns** (N8). A link under 1.2 m wide is taken in turns (`crate::links::turns`): at the start of each tick
//!   the marks of the last are read into each such link's facts (who waits at which end and how far from it, who is
//!   inside and how far along, whether each end has room to step out into), and its owning node writes who may
//!   enter. Who is inside is every body the controller carries across the link, from the end it went in by and the
//!   point it began at (recorded when the world gives its track). Without turns ([`Town::turns`] `None`) every link
//!   is free, as N7 walked them.
//! - **Standing spots** (N9, `crate::spots`). The marks of the last tick that ask a spot are read into the tables of
//!   their targets' nodes. A place is never in a doorway or on a stair: none within `spots::CLEAR` of a link's end on
//!   the target's node, or within half the link's width and half that of its line (placed on the open ground by its
//!   building's frame).

use super::{Leg, Mark, World, node_of};
use crate::controller::{Controller, Track};
use crate::ground::open::Index;
use crate::ground::scene::{FLOOR, xform_to};
use crate::ground::{
    HUMAN_RADIUS, Meet, OpenGround, Piece, Terrain, Versions, changed, exits, grounds,
};
use crate::host::Links;
use crate::links::turns::{Facts, ROOM, Turns, narrow};
use crate::links::{
    Building, Doors, F_OPEN, Kind, Open, SquareMeet, back, floor_joins, ground_doors,
};
use crate::mover::{Body, Surface};
use crate::routes::{HANDS, Hop, Map, Mask, Route, Scratch, Spot, on_pieces};
use crate::spots::{Ask, CLEAR, ClassGround, Ground, Spots, Target, flat, to_segment};
use replica::effects::{Actor, Cause, Header, Part, Refusal};
use replica::encode::{Value, encode};
use replica::host::{F_GRANTED, F_TURNS, Seen};
use replica::ids::Id;
use replica::kinds::sizes::Size;
use replica::pose::{ControllerInput, Frame, Mode, Quat, Support, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{plain, show};
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// How far a leg's end may lie off the ground and still be aimed at, mm: a link's end on its piece's edge.
const AT_EDGE: i64 = 20;
/// How far a crossing's landing may be moved onto the far surface, µm: less than a body's radius (#3168).
const LAND: i64 = HUMAN_RADIUS * 1000;
/// How far from a link's near end a crossing may be asked, µm (the walk asks within 50 mm of it, #3168).
const REACH: i64 = 1_000_000;

/// The squared distance across the ground (x and z), µm².
fn flat2(a: Vec3, b: Vec3) -> i128 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    d(a.x, b.x) + d(a.z, b.z)
}

/// A crossing the controller carries: the end it went in by, and where the body stood when it began.
struct Crossing {
    from: u8,
    start: Vec3,
}

/// What finding the next corner cost (#3167): the calls, the searches and the straight-walk checks, counted always;
/// their time in ns only when the town is given a [`Town::meter`] (a bench's; the engine reads no clock).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Spent {
    /// `corner` calls, and their time.
    pub corners: u64,
    pub corner_ns: u64,
    /// Straight-walk checks (`clear`), and their time.
    pub clears: u64,
    pub clear_ns: u64,
    /// Route searches (`Map::route`), and their time.
    pub searches: u64,
    pub search_ns: u64,
    /// Lines searched for ([`View::search`]: a straight-walk check to `to`, then a route search unless it passed), by
    /// why: a new `to` or node (a new leg, order or target), pushed off the line, at the end of a line that stops
    /// short of `to` (where the route leaves the piece it began on), and a straight walk to the next corner refused.
    pub lines_new: u64,
    pub lines_off: u64,
    pub lines_end: u64,
    pub lines_blocked: u64,
}

impl Spent {
    /// Adds what `o` counted: a thread's costs joined to the town's (N17b). Times are summed across threads.
    pub fn add(&mut self, o: &Spent) {
        self.corners += o.corners;
        self.corner_ns += o.corner_ns;
        self.clears += o.clears;
        self.clear_ns += o.clear_ns;
        self.searches += o.searches;
        self.search_ns += o.search_ns;
        self.lines_new += o.lines_new;
        self.lines_off += o.lines_off;
        self.lines_end += o.lines_end;
        self.lines_blocked += o.lines_blocked;
    }
}

/// The engine as the walk skill reads it.
pub struct Town {
    pub tree: Tree,
    /// Geometry only: ownership, turns, spots, lines and the tree remain singular.
    classes: BTreeMap<Size, Geometry>,
    /// Non-default classes of the current controller snapshot (also sent to the planner).
    pub body_classes: BTreeMap<Id, Size>,
    pub ground: Id,
    pub map: Map,
    /// Each node's surface for the mover: the open ground (every square), and every floor that cuts.
    pub surfaces: BTreeMap<Id, Surface>,
    pub buildings: Vec<Building>,
    pub doors: Doors,
    /// The turn states of the narrow links, written by their owners; `None` walks every link free.
    pub turns: Option<Turns>,
    /// The standing spots' tables, by owning node (N9).
    pub spots: Spots,
    /// A monotonic ns reader for timing [`Spent`], given by a bench; `None` (the engine's own) times nothing.
    pub meter: Option<fn() -> u64>,
    /// What the next corners cost so far.
    pub spent: Cell<Spent>,
    /// Each walker's line of corners (#3167), kept from the search that found it.
    lines: Vec<(Id, Line)>,
    /// One route search scratch per thread asking (N17b, #3255): the first is [`Town::view`]'s.
    scratches: Vec<ClassScratch>,
    crossings: BTreeMap<Id, Crossing>,
    /// Where each link is in `buildings` (building, link), the first that holds it: read every tick by each walker
    /// with a link ahead, so not searched for (#3213).
    link_at: BTreeMap<Id, (usize, usize)>,
    /// Each node's ground version (G3).
    pub versions: Versions,
    /// What a building read again off the clock thread needs of the open ground ([`Town::basis`]).
    basis: Basis,
    /// Each square's pieces of the open ground's surface, by number (G3b).
    square_pieces: BTreeMap<(i32, i32), Vec<u32>>,
    /// The ground each body's last plan crossed, in order: each node with its version then (G3).
    planned: BTreeMap<Id, Vec<(Id, u64)>>,
    /// The open ground's squares each body's last plan crossed, in order (G3b): a change that cuts squares again
    /// leaves the walks that cross none of them as they are, and ranks the others by how soon they reach one.
    planned_squares: BTreeMap<Id, Vec<(i32, i32)>>,
    /// The walks planned on ground the last installs changed, not yet planned again: each body with how soon its
    /// route reaches the change (its index in the ground the plan crossed; 0 for the node it stood on).
    pub stale: BTreeMap<Id, usize>,
}

/// What a rebuild off the clock thread reads besides the tree (#3276): the open ground as cut (each square's pieces,
/// its meets and its doors) and each building read, with its links. Cheap to clone: it is shared, not copied.
type TerrainFlags = BTreeMap<(i32, i32), Vec<Vec<bool>>>;

#[derive(Clone)]
pub struct Basis {
    size: Size,
    classes: BTreeMap<Size, Basis>,
    layout: Arc<SurfaceLayout>,
    floors: Arc<BTreeMap<Id, Arc<Surface>>>,
    flags: Arc<TerrainFlags>,
    open: Arc<OpenCut>,
    /// The open ground's scene by child, to cut again only the squares a change touches (G3b, #3449).
    index: Index,
    known: Arc<BTreeMap<Id, BTreeSet<Id>>>,
    /// Where each building reaches on the open ground ([`reach`]).
    reach: Arc<BTreeMap<Id, [i64; 4]>>,
    /// The buildings that share a step with another's floor (#3227): never read again alone.
    joined: Arc<BTreeSet<Id>>,
}

#[derive(Clone, Default)]
struct SurfaceLayout {
    count: u32,
    squares: BTreeMap<(i32, i32), Vec<u32>>,
}
#[derive(Clone)]
struct OpenCut {
    squares: BTreeMap<(i32, i32), Arc<Vec<Piece>>>,
    meets: Vec<SquareMeet>,
    doors: BTreeMap<Id, Id>,
    terrain: Option<Arc<Terrain>>,
}

impl Basis {
    /// Whether `other` is this very basis (the same shared handles, #3743), not merely an equal one: a rebuild on
    /// either gives the same ground with the same piece numbers.
    pub fn same(&self, other: &Basis) -> bool {
        self.size == other.size
            && Arc::ptr_eq(&self.layout, &other.layout)
            && Arc::ptr_eq(&self.floors, &other.floors)
            && Arc::ptr_eq(&self.flags, &other.flags)
            && Arc::ptr_eq(&self.open, &other.open)
            && self.index.same(&other.index)
            && Arc::ptr_eq(&self.known, &other.known)
            && Arc::ptr_eq(&self.reach, &other.reach)
            && Arc::ptr_eq(&self.joined, &other.joined)
            && self.classes.len() == other.classes.len()
            && self
                .classes
                .iter()
                .zip(&other.classes)
                .all(|((a, x), (b, y))| a == b && x.same(y))
    }

    /// Reconstructs only the requested immutable surface off-clock, preserving its actual live piece numbers.
    pub fn surface(&self, size: Size, node: Id, ground: Id) -> Result<Surface, Refusal> {
        crate::commit::off_clock();
        let basis = if size == Size::Standard {
            self
        } else {
            self.classes
                .get(&size)
                .ok_or_else(|| refusal("body-class-unprepared", "missing prepared class"))?
        };
        if node != ground {
            return basis
                .floors
                .get(&node)
                .map(|s| s.as_ref().clone())
                .ok_or_else(|| refusal("no-surface", "missing prepared floor"));
        }
        let empty = Piece {
            outline: Vec::new(),
            vertices: Vec::new(),
            triangles: Vec::new(),
            ground: crate::gaits::Ground::Dry,
        };
        let mut pieces = vec![empty; basis.layout.count as usize];
        let mut flags = vec![Vec::new(); pieces.len()];
        for (sq, indices) in &basis.layout.squares {
            let source = basis
                .open
                .squares
                .get(sq)
                .ok_or_else(|| refusal("body-class-unprepared", "missing square"))?;
            if source.len() != indices.len() {
                return Err(refusal("body-class-unprepared", "square layout mismatch"));
            }
            for (k, &index) in indices.iter().enumerate() {
                pieces[index as usize] = source[k].clone();
                flags[index as usize] = basis
                    .flags
                    .get(sq)
                    .and_then(|v| v.get(k))
                    .cloned()
                    .unwrap_or_default();
            }
        }
        let mut surface = Surface::new(ground, pieces);
        if let Some(t) = &basis.open.terrain {
            surface = surface.on_terrain_shared(Arc::clone(t), flags);
        }
        Ok(surface)
    }
    /// The open ground's square `sq` as last cut: its dry pieces.
    pub fn square(&self, sq: (i32, i32)) -> Option<&[Piece]> {
        self.open.squares.get(&sq).map(|p| p.as_slice())
    }
}

/// How far past its floors and steps a building's reach is taken, µm: more than a step carried across an edge onto
/// another thing's floor (#3227, `crate::links::floor_joins`).
const JOIN_REACH: i64 = 1_000_000;

/// The box (x and z on the open ground, µm: least x, least z, most x, most z) holding building `b`'s floors and its
/// loose steps, grown by [`JOIN_REACH`]: two buildings whose boxes are apart share no step from one's floor onto the
/// other's (#3227), so only those whose boxes meet are read again to look for one.
fn reach(b: &Building) -> Option<[i64; 4]> {
    let floors = b.floors.values().flat_map(|(_, p)| &p.pieces);
    let corners = floors.flat_map(|pc| &pc.vertices).map(|v| {
        let m = |c: i32| i64::from(c) * 1000;
        Vec3::new(m(v[0]), m(v[1]), m(v[2]))
    });
    let steps = b.loose.iter().flat_map(|s| {
        [s.end.a, s.end.b]
            .into_iter()
            .chain(s.stair.as_ref().map(|t| t.top))
    });
    let mut out: Option<[i64; 4]> = None;
    for p in corners.chain(steps) {
        let w = b.place.point(p).ok()?;
        let r = out.get_or_insert([w.x, w.z, w.x, w.z]);
        *r = [r[0].min(w.x), r[1].min(w.z), r[2].max(w.x), r[3].max(w.z)];
    }
    out.map(|r| {
        [
            r[0] - JOIN_REACH,
            r[1] - JOIN_REACH,
            r[2] + JOIN_REACH,
            r[3] + JOIN_REACH,
        ]
    })
}

/// Whether boxes `a` and `b` meet.
fn overlap(a: [i64; 4], b: [i64; 4]) -> bool {
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

/// The ground as a part will leave it, built off the clock thread ([`Town::rebuild`]) and installed on the tick the
/// part commits ([`Town::install`]).
pub struct Rebuilt {
    /// The nodes whose ground the part changes.
    pub touched: BTreeSet<Id>,
    pub versions: Versions,
    pub fresh: Fresh,
    classes: BTreeMap<Size, Geometry>,
    after: Basis,
    before_layout: Arc<SurfaceLayout>,
    /// Why the whole ground was built for a change on the open ground, when it was (G3b).
    pub why: Option<&'static str>,
}

impl Rebuilt {
    /// Two independently mutable installations of one checked rebuild. Immutable basis handles stay shared;
    /// all mutable geometry and route storage is copied here, before either installation reaches the clock.
    pub fn into_pair(self) -> (Self, Self) {
        let other = self.copy();
        (self, other)
    }

    /// One more independently mutable installation of this rebuild (#3743: the edit checker's town takes the third),
    /// copied as [`Rebuilt::into_pair`] copies: immutable basis handles shared, mutable geometry copied.
    pub fn copy(&self) -> Self {
        crate::commit::off_clock();
        Self {
            touched: self.touched.clone(),
            versions: self.versions.clone(),
            fresh: self.fresh.clone(),
            classes: self.classes.clone(),
            after: self.after.clone(),
            before_layout: Arc::clone(&self.before_layout),
            why: self.why,
        }
    }

    pub fn affects(&self, basis: &crate::controller::BuildBasis, ground: Id) -> bool {
        if !matches!(basis.moved.pose.support, Support::Surface { .. }) {
            return false;
        }
        if basis.build.size != Size::Standard {
            return true;
        }
        let node = basis.moved.pose.frame.node;
        match &self.fresh {
            Fresh::Whole(_) => true,
            Fresh::Buildings(bs) => bs.iter().any(|(b, _)| b.floors.contains_key(&node)),
            Fresh::Squares(squares, _, bs) => {
                bs.iter().any(|(b, _)| b.floors.contains_key(&node))
                    || node == ground
                        && squares.iter().any(|(sq, _, _)| {
                            self.before_layout
                                .squares
                                .get(sq)
                                .is_some_and(|v| v.contains(&basis.moved.piece))
                        })
            }
        }
    }
    pub fn prepare_rebinds(
        &self,
        bases: &[crate::controller::BuildBasis],
        ground: Id,
    ) -> Result<Vec<crate::controller::PreparedRebind>, Refusal> {
        let (surfaces, rebinds) = self.prepare_rebind_surfaces(bases, ground)?;
        drop(surfaces);
        Ok(rebinds)
    }

    /// Builds, once, each (class, node) surface the affected bodies stand on, and places them on it (B12b). The
    /// surfaces are kept so a body that walked on can be placed again without building anything.
    pub fn prepare_rebind_surfaces(
        &self,
        bases: &[crate::controller::BuildBasis],
        ground: Id,
    ) -> Result<(RebindSurfaces, Vec<crate::controller::PreparedRebind>), Refusal> {
        crate::commit::off_clock();
        let mut surfaces = BTreeMap::new();
        let affected: Vec<_> = bases
            .iter()
            .filter(|b| self.affects(b, ground))
            .cloned()
            .collect();
        for before in &affected {
            let key = (before.build.size, before.moved.pose.frame.node);
            if let std::collections::btree_map::Entry::Vacant(entry) = surfaces.entry(key) {
                let prepared = if key == (Size::Standard, ground) {
                    if let Fresh::Squares(sq, basis, _) = &self.fresh {
                        let mut surface = Surface::new(
                            ground,
                            sq.iter()
                                .flat_map(|(_, pcs, _)| pcs.iter().cloned())
                                .collect(),
                        );
                        if let Some(t) = &basis.open.terrain {
                            surface = surface.on_terrain_shared(
                                Arc::clone(t),
                                sq.iter()
                                    .flat_map(|(_, _, on)| on.iter().cloned())
                                    .collect(),
                            );
                        }
                        (surface, self.before_layout.count)
                    } else {
                        (self.after.surface(key.0, key.1, ground)?, 0)
                    }
                } else {
                    (self.after.surface(key.0, key.1, ground)?, 0)
                };
                entry.insert(prepared);
            }
        }
        let surfaces = RebindSurfaces(surfaces);
        let rebinds = surfaces.place(&affected)?;
        Ok((surfaces, rebinds))
    }

    /// Whether the whole ground was built again (the open ground was touched, or a building could not be read
    /// again alone), not only the touched buildings.
    pub fn whole(&self) -> bool {
        matches!(self.fresh, Fresh::Whole(..))
    }

    /// The open ground's squares cut again alone (G3b), none when the whole was built.
    pub fn cut_squares(&self) -> Vec<(i32, i32)> {
        match &self.fresh {
            Fresh::Squares(sq, ..) => sq.iter().map(|(k, ..)| *k).collect(),
            _ => Vec::new(),
        }
    }

    /// How many of the open ground's squares were cut again alone (G3b): 0 when none, or when the whole was built.
    pub fn squares(&self) -> usize {
        match &self.fresh {
            Fresh::Squares(sq, ..) => sq.len(),
            _ => 0,
        }
    }
}

/// The (class, node) surfaces an edit's affected bodies were placed on off the clock (B12b): kept, unchanged, so
/// the same bodies can be placed again where they now stand with no rebuild, map or search beyond the placing.
#[derive(Default)]
pub struct RebindSurfaces(pub(crate) BTreeMap<(Size, Id), (Surface, u32)>);

impl RebindSurfaces {
    /// Places exactly these bodies on the kept surfaces: their current point, unchanged; refused when a body's
    /// class or node has no kept surface, or the placing would change its support.
    pub fn place(
        &self,
        bases: &[crate::controller::BuildBasis],
    ) -> Result<Vec<crate::controller::PreparedRebind>, Refusal> {
        crate::commit::off_clock();
        let mut out = Vec::with_capacity(bases.len());
        for before in bases {
            let key = (before.build.size, before.moved.pose.frame.node);
            let Some((surface, offset)) = self.0.get(&key) else {
                return Err(refusal("edit.body-stale", "prepared body changed"));
            };
            let mut moved = surface.place_built(
                before.moved.id,
                before.moved.pose.frame,
                before.moved.pose.position,
                before.moved.pose.orientation,
                before.build,
            )?;
            moved.linear = before.moved.linear;
            let triangle = surface.rebind_triangle(moved.piece, moved.tri, *offset)?;
            if moved.pose != before.moved.pose {
                return Err(refusal(
                    "edit.body-support-changed",
                    "prepared support differs",
                ));
            }
            out.push(crate::controller::PreparedRebind {
                before: before.clone(),
                triangle,
            });
        }
        Ok(out)
    }
}

/// A square of the open ground cut again: where it is, its dry pieces and, per piece and triangle, whether it lies
/// on the terrain.
pub type Square = ((i32, i32), Vec<Piece>, Vec<Vec<bool>>);

/// The ground a rebuild built: the whole, or what it cut again (read by G2's guard, G2b #3488).
#[derive(Clone)]
pub enum Fresh {
    Whole(Box<Assembled>),
    /// The open ground's squares cut again (G3b, #3449): each with its dry pieces and, per piece and triangle,
    /// whether it lies on the terrain; and the basis as they leave it.
    Squares(Vec<Square>, Basis, Vec<(Building, BTreeMap<Id, Surface>)>),
    /// Each touched building read again, with its floors' surfaces.
    Buildings(Vec<(Building, BTreeMap<Id, Surface>)>),
}

/// The route map, each node's surface, the buildings, the basis for a rebuild, and each square's pieces of the open
/// ground's surface.
pub type Assembled = (
    Map,
    BTreeMap<Id, Surface>,
    Vec<Building>,
    Basis,
    BTreeMap<(i32, i32), Vec<u32>>,
);

/// One class's geometry, without a second tree, controller, reservations or turn state.
#[derive(Clone)]
struct Geometry {
    map: Map,
    surfaces: BTreeMap<Id, Surface>,
    buildings: Vec<Building>,
    basis: Basis,
    link_at: BTreeMap<Id, (usize, usize)>,
}
type GeometryRead<'a> = (
    &'a Map,
    &'a BTreeMap<Id, Surface>,
    &'a [Building],
    &'a BTreeMap<Id, (usize, usize)>,
);
impl Geometry {
    fn from((map, surfaces, buildings, basis, _square_pieces): Assembled) -> Self {
        let link_at = link_index(&buildings);
        Self {
            map,
            surfaces,
            buildings,
            basis,
            link_at,
        }
    }
}

/// Scratch caches never cross class/map identity.
#[derive(Default)]
pub struct ClassScratch {
    standard: Scratch,
    other: BTreeMap<Size, Scratch>,
}

/// Where each link is in `buildings`: the first building, and its first link, with that id.
fn link_index(buildings: &[Building]) -> BTreeMap<Id, (usize, usize)> {
    let mut at = BTreeMap::new();
    for (i, b) in buildings.iter().enumerate() {
        for (j, l) in b.links.iter().enumerate() {
            at.entry(l.id).or_insert((i, j));
        }
    }
    at
}

/// Link `id` in `buildings`, by the index [`link_index`] made of them.
fn find_link<'b>(
    link_at: &BTreeMap<Id, (usize, usize)>,
    buildings: &'b [Building],
    id: Id,
) -> Option<&'b crate::links::Link> {
    let &(i, j) = link_at.get(&id)?;
    buildings.get(i)?.links.get(j).filter(|l| l.id == id)
}

impl Town {
    /// Everything on the open ground `ground`; openings are written by `doors`.
    pub fn new(tree: Tree, ground: Id, doors: Doors) -> Result<Town, String> {
        let versions = Versions::default();
        let (map, surfaces, buildings, basis, square_pieces) =
            Town::assemble(&tree, ground, &versions)?;
        let link_at = link_index(&buildings);
        Ok(Town {
            tree,
            classes: BTreeMap::new(),
            body_classes: BTreeMap::new(),
            ground,
            map,
            surfaces,
            buildings,
            link_at,
            doors,
            turns: Some(Turns::new()),
            spots: Spots::new(),
            meter: None,
            spent: Cell::new(Spent::default()),
            lines: Vec::new(),
            scratches: vec![ClassScratch::default()],
            crossings: BTreeMap::new(),
            versions,
            basis,
            square_pieces,
            planned: BTreeMap::new(),
            planned_squares: BTreeMap::new(),
            stale: BTreeMap::new(),
        })
    }

    /// The tree and the ground as N9's spot tables read it, for a reader that is not a walker (E4's set-down, #2772).
    pub fn with_ground<T>(&mut self, f: impl FnOnce(&Tree, &mut dyn Ground) -> T) -> T {
        let Town {
            map,
            tree,
            buildings,
            ground,
            surfaces,
            ..
        } = self;
        let tree: &Tree = tree;
        let mut g = Grounds {
            tree,
            map: MapRef::Own(map),
            surfaces,
            buildings,
            ground: *ground,
            boxes: OnceCell::new(),
            door: None,
        };
        f(tree, &mut g)
    }

    /// What [`Town::rebuild`] reads besides the tree, as the ground stands now.
    pub fn basis(&self) -> Basis {
        let mut basis = self.basis.clone();
        basis.classes = self
            .classes
            .iter()
            .map(|(&size, g)| (size, g.basis.clone()))
            .collect();
        basis
    }

    /// Off-clock startup preparation, only for classes admitted by the configured catalogue.
    pub fn prepare_classes(&mut self, sizes: impl IntoIterator<Item = Size>) -> Result<(), String> {
        for size in sizes {
            if size != Size::Standard && !self.classes.contains_key(&size) {
                crate::commit::off_clock();
                let g = Self::assemble_for(&self.tree, self.ground, &self.versions, size)?;
                self.classes.insert(size, Geometry::from(g));
            }
        }
        Ok(())
    }

    pub fn surfaces_for(&self, size: Size) -> Option<&BTreeMap<Id, Surface>> {
        if size == Size::Standard {
            Some(&self.surfaces)
        } else {
            self.classes.get(&size).map(|g| &g.surfaces)
        }
    }

    pub fn size_of(&self, body: Id) -> Size {
        self.body_classes
            .get(&body)
            .copied()
            .unwrap_or(Size::Standard)
    }

    /// A successful class change invalidates that body's line; refused changes never call this.
    pub fn set_class(&mut self, body: Id, size: Size) {
        if size == Size::Standard {
            self.body_classes.remove(&body);
        } else {
            self.body_classes.insert(body, size);
        }
        self.lines.retain(|(id, _)| *id != body);
        self.planned.remove(&body);
        self.planned_squares.remove(&body);
    }

    fn keep_scratches(&mut self) {
        for s in &mut self.scratches {
            self.map.keep(&mut s.standard);
            for (size, scratch) in &mut s.other {
                if let Some(g) = self.classes.get_mut(size) {
                    g.map.keep(scratch);
                }
            }
        }
    }

    /// The ground `body`'s last plan crossed, each node with its version then.
    pub fn planned_on(&self, body: Id) -> &[(Id, u64)] {
        self.planned.get(&body).map_or(&[], Vec::as_slice)
    }

    /// The corner `body`'s line aims at next: the node it was searched on and x and z there, µm (read only).
    pub fn next_corner(&self, body: Id) -> Option<(Id, [i64; 2])> {
        self.next_corner_toward(body).map(|(node, c, _)| (node, c))
    }

    /// [`Town::next_corner`] with the leg's end the line goes toward, x and z µm in the same node's frame: what C21's
    /// stall watch measures a walk's progress against (a route with crossings has a leg's end short of its goal).
    /// `None` for the leg's end of a line forgotten on a planner's thread (`Lines::forget`: aimed at no point), whose
    /// kept corner is still given.
    pub fn next_corner_toward(&self, body: Id) -> Option<(Id, [i64; 2], Option<[i64; 2]>)> {
        let i = self.lines.binary_search_by_key(&body, |e| e.0).ok()?;
        let l = &self.lines[i].1;
        let to = (l.to.x != i64::MIN).then_some([l.to.x, l.to.z]);
        Some((l.node, *l.points.get(l.next)?, to))
    }

    /// Off the clock thread: the ground as `part` leaves the tree `base` (a copy of this town's, as it stands when
    /// the part is checked; `header` is the zone's), with the versions of the nodes it touches bumped from `versions`.
    /// When the open ground is not touched, only the buildings whose floors are touched are read again, on the open
    /// ground in `basis` (#3276); otherwise, or when one of them cannot be read alone, the whole ground is built.
    pub fn rebuild(
        mut base: Tree,
        header: &Header,
        ground: Id,
        versions: &Versions,
        basis: &Basis,
        part: &Part,
    ) -> Result<Rebuilt, String> {
        Town::rebuild_on(&mut base, header, ground, versions, basis, part)
    }

    /// [`Town::rebuild`] on a copy the caller keeps: `base` is left as the part leaves it (G3b, #3449). Dropping a
    /// whole copy of Eden's tree costs tens of milliseconds, so a caller that reuses its copies (K8's spares) or drops
    /// them elsewhere does not pay it here.
    pub fn rebuild_on(
        base: &mut Tree,
        header: &Header,
        ground: Id,
        versions: &Versions,
        basis: &Basis,
        part: &Part,
    ) -> Result<Rebuilt, String> {
        crate::commit::off_clock();
        // What the part changes is read in the tree before it is applied to it in place: no second copy (G3b).
        let ids = changed(base, part);
        let mut touched = BTreeSet::new();
        grounds(base, &ids, &mut touched);
        let kids = basis.index.children(base, &ids);
        let parent = |t: &Tree, n: Id| t.handle(n).and_then(|h| t.node(h)).and_then(|n| n.parent());
        let parents: BTreeMap<Id, Id> = touched
            .iter()
            .filter_map(|&f| Some((f, parent(base, f)?)))
            .collect();
        base.apply(header, part)
            .map_err(|e| format!("{}: {}", e.name, e.detail))?;
        grounds(base, &ids, &mut touched);
        let mut versions = versions.clone();
        versions.bump(&touched);
        let mut why = None;
        let fresh = if touched.contains(&ground) {
            let r = if touched.len() == 1 {
                Town::recut(&kids, base, &ids, basis)
            } else {
                Err("the open ground and a building")
            };
            match r {
                Ok(f) => f,
                Err(w) => {
                    why = Some(w);
                    Fresh::Whole(Box::new(Town::assemble_for(
                        base, ground, &versions, basis.size,
                    )?))
                }
            }
        } else {
            match Town::reread(&parents, base, ground, &touched, basis) {
                Some(bs) => Fresh::Buildings(bs),
                None => Fresh::Whole(Box::new(Town::assemble_for(
                    base, ground, &versions, basis.size,
                )?)),
            }
        };
        let classes: BTreeMap<Size, Geometry> = basis
            .classes
            .keys()
            .map(|&size| {
                Self::assemble_for(base, ground, &versions, size).map(|g| (size, Geometry::from(g)))
            })
            .collect::<Result<_, _>>()?;
        let mut after = match &fresh {
            Fresh::Whole(g) => g.3.clone(),
            Fresh::Squares(_, next, _) => next.clone(),
            Fresh::Buildings(_) => basis.clone(),
        };
        if !matches!(&fresh, Fresh::Whole(_)) {
            let mut layout = (*basis.layout).clone();
            let mut flags = (*basis.flags).clone();
            let mut floors = (*basis.floors).clone();
            let buildings = match &fresh {
                Fresh::Squares(squares, _, bs) => {
                    for (sq, pcs, on) in squares {
                        layout.squares.insert(
                            *sq,
                            (layout.count..layout.count + pcs.len() as u32).collect(),
                        );
                        layout.count += pcs.len() as u32;
                        flags.insert(*sq, on.clone());
                    }
                    bs
                }
                Fresh::Buildings(bs) => bs,
                Fresh::Whole(_) => unreachable!(),
            };
            for (_building, surfaces) in buildings {
                // Removed floors are absent from the canonical tree; stale immutable sources cannot be selected.
                floors.retain(|id, _| base.handle(*id).is_some());
                for (id, surface) in surfaces {
                    floors.insert(*id, Arc::new(surface.clone()));
                }
            }
            after.layout = Arc::new(layout);
            after.flags = Arc::new(flags);
            after.floors = Arc::new(floors);
        }
        after.classes = classes
            .iter()
            .map(|(&size, g)| (size, g.basis.clone()))
            .collect();
        Ok(Rebuilt {
            after,
            before_layout: Arc::clone(&basis.layout),
            classes,
            touched,
            versions,
            fresh,
            why,
        })
    }

    /// The open ground's squares `part` changes, cut again alone from `after` (G3b, #3449, `crate::ground::open`),
    /// with the basis as they leave it; refused with why when the whole ground must be built (a change the index
    /// cannot cut alone).
    fn recut(
        before: &BTreeSet<Id>,
        after: &Tree,
        ids: &[Id],
        basis: &Basis,
    ) -> Result<Fresh, &'static str> {
        let open = &basis.open;
        let cut = |sq: (i32, i32)| {
            if !open.squares.contains_key(&sq) {
                return None;
            }
            Some(
                open.meets
                    .iter()
                    .filter(|(s, _)| *s == sq)
                    .map(|(_, m)| m.clone())
                    .collect(),
            )
        };
        let r = basis
            .index
            .recut(before, after, ids, basis.size.radius_mm(), &cut)?;
        let mut cut_open = (**open).clone();
        let mut squares = Vec::new();
        // The links whose meets on a square cut again changed: their buildings are read again on the new meets.
        let mut moved = BTreeSet::new();
        for (sq, pieces, meets, on) in r.squares {
            let old: Vec<Meet> = cut(sq).unwrap_or_default();
            if old != meets {
                let links = old.iter().chain(&meets).map(|m| m.link);
                for l in links.collect::<BTreeSet<_>>() {
                    let of = |v: &[Meet]| {
                        v.iter()
                            .filter(|m| m.link == l)
                            .cloned()
                            .collect::<Vec<_>>()
                    };
                    if of(&old) != of(&meets) {
                        moved.insert(l);
                    }
                }
                cut_open.meets.retain(|(s, _)| *s != sq);
                cut_open.meets.extend(meets.into_iter().map(|m| (sq, m)));
            }
            cut_open.squares.insert(sq, Arc::new(pieces.clone()));
            squares.push((sq, pieces, on));
        }
        // In the order a whole cut lists them: by square, z then x, and in each square as cut.
        cut_open.meets.sort_by_key(|(s, _)| (s.1, s.0));
        let basis = Basis {
            open: Arc::new(cut_open),
            index: r.index,
            ..basis.clone()
        };
        let ground = basis.index.ground();
        let (mut things, mut gates) = (BTreeSet::new(), false);
        for l in moved {
            // A link no building holds is the open ground's own: a gate.
            match basis
                .known
                .iter()
                .find(|(t, ls)| **t != ground && ls.contains(&l))
            {
                Some((t, _)) => {
                    things.insert(*t);
                }
                None => gates = true,
            }
        }
        let mut buildings = if things.is_empty() {
            Vec::new()
        } else {
            Town::read_again(after, ground, &things, &basis)
                .ok_or("a building on changed meets that cannot be read alone")?
        };
        if gates {
            buildings.push(Town::gates(after, ground, &basis).ok_or("the gates cannot be read")?);
        }
        Ok(Fresh::Squares(squares, basis, buildings))
    }

    /// Each building whose floors are in `touched`, read again from `after` on the open ground of `basis`, with its
    /// floors' surfaces; `None` when the whole ground must be built: the open ground is touched, a building is new,
    /// gone or cannot be read, shares a step with another building's floor before the edit or after, or a link of the open ground's meets
    /// joins or leaves a building (the gates change).
    fn reread(
        before: &BTreeMap<Id, Id>,
        after: &Tree,
        ground: Id,
        touched: &BTreeSet<Id>,
        basis: &Basis,
    ) -> Option<Vec<(Building, BTreeMap<Id, Surface>)>> {
        if touched.contains(&ground) {
            return None;
        }
        let parent = |t: &Tree, n: Id| t.handle(n).and_then(|h| t.node(h)).and_then(|n| n.parent());
        let mut things = BTreeSet::new();
        for &f in touched {
            things.insert(parent(after, f).or_else(|| before.get(&f).copied())?);
        }
        Town::read_again(after, ground, &things, basis)
    }

    /// The open ground's own links (its gates) read again from `after` on the open ground of `basis` (G3b).
    fn gates(after: &Tree, ground: Id, basis: &Basis) -> Option<(Building, BTreeMap<Id, Surface>)> {
        let open = &basis.open;
        let on =
            |sq: (i32, i32), p: [i64; 2]| open.squares.get(&sq).is_some_and(|ps| on_pieces(ps, p));
        let o = Open {
            ground,
            place: crate::ground::scene::Xform::IDENTITY,
            meets: &open.meets,
            on: &on,
            doors: &open.doors,
            terrain: open.terrain.as_deref(),
        };
        let all: BTreeSet<Id> = basis
            .known
            .iter()
            .filter(|(t, _)| **t != ground)
            .flat_map(|(_, ls)| ls.iter().copied())
            .collect();
        Some((Building::of_ground(after, o, &all).ok()?, BTreeMap::new()))
    }

    /// Each building of `things` read again from `after` on the open ground of `basis`, with its floors' surfaces;
    /// `None` as [`Town::reread`] says.
    fn read_again(
        after: &Tree,
        ground: Id,
        things: &BTreeSet<Id>,
        basis: &Basis,
    ) -> Option<Vec<(Building, BTreeMap<Id, Surface>)>> {
        let gh = after.handle(ground)?;
        let open = &basis.open;
        let on =
            |sq: (i32, i32), p: [i64; 2]| open.squares.get(&sq).is_some_and(|ps| on_pieces(ps, p));
        let read = |thing: Id| {
            let o = Open {
                ground,
                place: xform_to(after, after.handle(thing)?, gh).ok()?,
                meets: &open.meets,
                on: &on,
                doors: &open.doors,
                terrain: open.terrain.as_deref(),
            };
            Building::read_sized(after, thing, Some(o), basis.size.radius_mm()).ok()
        };
        let mut out = Vec::new();
        for &thing in things {
            let old = basis.known.get(&thing)?;
            // A building that shared a step with another's floor (#3227) before the edit: the whole.
            if basis.joined.contains(&thing) {
                return None;
            }
            let b = read(thing)?;
            // Or after it: the buildings within its reach are read again, and none may share a step with it.
            let new = reach(&b)?;
            let near = basis
                .reach
                .iter()
                .filter(|(o, r)| **o != thing && overlap(new, **r))
                .map(|(o, _)| read(*o))
                .collect::<Option<Vec<_>>>()?;
            if !near.is_empty() {
                let bs: Vec<&Building> = std::iter::once(&b).chain(&near).collect();
                let joins = floor_joins(&bs);
                if joins.iter().any(|(i, l)| {
                    *i == 0
                        || l.ends
                            .iter()
                            .flatten()
                            .any(|e| b.floors.contains_key(&e.floor))
                }) {
                    return None;
                }
            }
            let now: BTreeSet<Id> = b.links.iter().map(|l| l.id).collect();
            if old
                .symmetric_difference(&now)
                .any(|l| open.meets.iter().any(|m| m.1.link == *l))
            {
                return None;
            }
            let surfaces = b
                .floors
                .iter()
                .map(|(&f, (_, patch))| (f, Surface::new(f, patch.pieces.clone())))
                .collect();
            out.push((b, surfaces));
        }
        Some(out)
    }

    /// Lookup-only preflight before the caller commits the same prepared map and part.
    pub fn check_install(&self, r: &Rebuilt) -> Result<(), Refusal> {
        if !r.classes.keys().eq(self.classes.keys()) {
            return Err(refusal(
                "body-class-unprepared",
                "class geometry changed since preparation",
            ));
        }
        if let Fresh::Squares(sq, ..) = &r.fresh {
            let keys: Vec<(i32, i32)> = sq.iter().map(|(k, ..)| *k).collect();
            let link_of = |id: Id| find_link(&self.link_at, &self.buildings, id).cloned();
            self.map
                .check_squares(self.ground, &keys, &link_of)
                .map_err(|e| refusal("ground-changed", e))?;
        }
        Ok(())
    }

    /// On the tick `part` commits: commits it through the zone's one write, its effects numbered from the zone's next
    /// sequence (doors may have opened since it was checked), and installs the ground `r` built for it, in the same
    /// call: the whole ground swapped in, or each building read again replaced on the map. The walks planned on the
    /// changed ground are listed in [`Town::stale`], and the lines of corners on it are dropped. A refused part
    /// installs nothing.
    pub fn install(&mut self, r: Rebuilt, part: &Part) -> Result<(), Refusal> {
        self.install_then(r, part, || Ok(()))
    }

    /// All map and tree input checks precede the paired live write. Its refusal rolls the town tree back;
    /// its success leaves only installation of already checked geometry, with no fallible input check.
    pub fn install_then<T>(
        &mut self,
        r: Rebuilt,
        part: &Part,
        commit: impl FnOnce() -> Result<T, Refusal>,
    ) -> Result<T, Refusal> {
        // What the threads' route searches found joins the map before it changes (N17b): no scratch outlives its map.
        self.keep_scratches();
        self.check_install(&r)?;
        let mut p = part.clone();
        for (k, e) in p.effects.iter_mut().enumerate() {
            e.envelope.sequence = self.doors.next + k as u64;
        }
        let bytes = encode(&p.to_value()).map_err(|e| refusal("encoding", e.to_string()))?;
        let committed = self.tree.commit_then(
            &self.doors.header,
            &Part::read(&bytes)?,
            &self.doors.rules,
            commit,
        )?;
        self.doors.next += part.effects.len() as u64;
        let Rebuilt {
            mut touched,
            versions,
            fresh,
            classes,
            after,
            ..
        } = r;
        self.classes = classes;
        for scratch in &mut self.scratches {
            scratch.other.clear();
        }
        self.spots.invalidate_geometry();
        // A change that cuts squares again changes the open ground there only (and the buildings read again).
        let cut: Option<BTreeSet<(i32, i32)>> = match &fresh {
            Fresh::Squares(sq, _, bs) => {
                touched.extend(bs.iter().flat_map(|(b, _)| b.floors.keys().copied()));
                Some(sq.iter().map(|(k, ..)| *k).collect())
            }
            _ => None,
        };
        match fresh {
            Fresh::Whole(g) => {
                let (map, surfaces, buildings, basis, square_pieces) = *g;
                self.map = map;
                self.surfaces = surfaces;
                self.buildings = buildings;
                self.basis = basis;
                self.square_pieces = square_pieces;
            }
            Fresh::Squares(squares, basis, bs) => {
                let ground = self.ground;
                let link_of = |id: Id| find_link(&self.link_at, &self.buildings, id).cloned();
                let cut = squares
                    .iter()
                    .map(|(sq, pieces, _)| (*sq, pieces.clone()))
                    .collect();
                self.map
                    .replace_squares(ground, versions.of(ground), cut, &link_of)
                    .expect("the same map and links passed check_install before the paired write");
                let (mut drop, mut add, mut on) = (Vec::new(), Vec::new(), Vec::new());
                for (sq, pieces, flags) in &squares {
                    drop.extend(self.square_pieces.get(sq).into_iter().flatten().copied());
                    add.extend(pieces.iter().cloned());
                    on.extend(flags.iter().cloned());
                }
                if let Some(s) = self.surfaces.get_mut(&ground) {
                    let mut next = s.replace(&drop, add, on);
                    for (sq, pieces, _) in &squares {
                        let n = pieces.len() as u32;
                        self.square_pieces.insert(*sq, (next..next + n).collect());
                        next += n;
                    }
                }
                self.basis = basis;
                self.put_buildings(bs, &versions);
            }
            Fresh::Buildings(bs) => self.put_buildings(bs, &versions),
        }
        self.basis = after;
        self.link_at = link_index(&self.buildings);
        self.versions = versions;
        let ground = self.ground;
        // How far along its squares a walk first reaches a square cut again (0: where it starts), if it does.
        let reaches = |who: &Id| match &cut {
            None => Some(0),
            Some(cut) => self
                .planned_squares
                .get(who)
                .and_then(|s| s.iter().position(|q| cut.contains(q))),
        };
        let changed = |n: &Id| touched.contains(n) && (*n != ground || cut.is_none());
        let mut stale = Vec::new();
        for (&who, planned) in &self.planned {
            let mut rank = None;
            for (k, (n, _)) in planned.iter().enumerate() {
                if changed(n) {
                    rank = Some(k);
                    break;
                }
                if *n == ground
                    && touched.contains(n)
                    && let Some(r) = reaches(&who)
                {
                    rank = Some(k + r);
                    break;
                }
            }
            if let Some(rank) = rank {
                stale.push((who, rank));
            }
        }
        for (who, rank) in stale {
            let r = self.stale.entry(who).or_insert(rank);
            *r = (*r).min(rank);
        }
        // A line of corners on the open ground is dropped when it runs within a metre of a square cut again.
        let sq = crate::ground::SQUARE * 1000;
        let near: Vec<[i64; 4]> = cut
            .iter()
            .flatten()
            .map(|&(i, j)| {
                let (x, z) = (i64::from(i) * sq, i64::from(j) * sq);
                [
                    x - 1_000_000,
                    z - 1_000_000,
                    x + sq + 1_000_000,
                    z + sq + 1_000_000,
                ]
            })
            .collect();
        let crosses = |l: &Line| {
            l.points.windows(2).any(|w| {
                let b = [
                    w[0][0].min(w[1][0]),
                    w[0][1].min(w[1][1]),
                    w[0][0].max(w[1][0]),
                    w[0][1].max(w[1][1]),
                ];
                near.iter().any(|n| overlap(*n, b))
            })
        };
        self.lines.retain(|(_, l)| {
            !(changed(&l.node) || (l.node == ground && touched.contains(&ground) && crosses(l)))
        });
        Ok(committed)
    }

    /// Each building read again replaced on the route map, its floors' surfaces with it.
    fn put_buildings(&mut self, bs: Vec<(Building, BTreeMap<Id, Surface>)>, versions: &Versions) {
        let known = Arc::make_mut(&mut self.basis.known);
        let reaches = Arc::make_mut(&mut self.basis.reach);
        for (b, surfaces) in bs {
            self.map.replace(&b, &|n| versions.of(n));
            known.insert(b.thing, b.links.iter().map(|l| l.id).collect());
            if let Some(r) = reach(&b) {
                reaches.insert(b.thing, r);
            }
            self.surfaces.extend(surfaces);
            match self.buildings.iter().position(|o| o.thing == b.thing) {
                Some(i) => {
                    let old = std::mem::replace(&mut self.buildings[i], b);
                    for f in old.floors.keys() {
                        if !self.buildings[i].floors.contains_key(f) {
                            self.surfaces.remove(f);
                        }
                    }
                }
                None => self.buildings.push(b),
            }
        }
    }

    /// The route map, each node's surface, the buildings and the basis for a rebuild, read from `tree` at `versions`.
    fn assemble(tree: &Tree, ground: Id, versions: &Versions) -> Result<Assembled, String> {
        Self::assemble_for(tree, ground, versions, Size::Standard)
    }
    fn assemble_for(
        tree: &Tree,
        ground: Id,
        versions: &Versions,
        size: Size,
    ) -> Result<Assembled, String> {
        let map = Map::build_for(tree, ground, size, &|n| versions.of(n))?;
        let mut surfaces = BTreeMap::new();
        let open = OpenGround::of(tree, ground, size.radius_mm())?;
        let terrain = open.terrain().cloned().map(Arc::new);
        let (mut pieces, mut meets, mut squares) = (Vec::new(), Vec::new(), BTreeMap::new());
        let mut square_pieces = BTreeMap::new();
        let mut square_flags = BTreeMap::new();
        for (i, j) in open.squares() {
            let p = open.cut_square(i, j);
            let first = pieces.len() as u32;
            square_flags.insert((i, j), open.on_terrain(&p.pieces));
            square_pieces.insert((i, j), (first..first + p.pieces.len() as u32).collect());
            squares.insert((i, j), Arc::new(p.pieces.clone()));
            pieces.extend(p.pieces);
            meets.extend(p.meets.into_iter().map(|m| ((i, j), m)));
        }
        let gh = tree.handle(ground).ok_or("no such ground")?;
        let gdoors = ground_doors(tree, ground)?;
        let on = open.on_terrain(&pieces);
        let mut surface = Surface::new(ground, pieces);
        if let Some(t) = open.terrain() {
            surface = surface.on_terrain(t.clone(), on);
        }
        surfaces.insert(ground, surface);
        let mut buildings = Vec::new();
        let mut stack = vec![gh];
        while let Some(h) = stack.pop() {
            let kids = tree.children(h).ok_or("a node that is gone")?;
            if kids.iter().any(|&c| {
                tree.node(c)
                    .is_some_and(|n| plain(n.kind().as_str()) == FLOOR)
            }) {
                let id = tree.node(h).ok_or("a node that is gone")?.id();
                let on = |sq: (i32, i32), p: [i64; 2]| map.on_square(ground, sq, p);
                let open = Open {
                    ground,
                    place: xform_to(tree, h, gh)?,
                    meets: &meets,
                    on: &on,
                    doors: &gdoors,
                    terrain: open.terrain(),
                };
                if let Ok(b) = Building::read_sized(tree, id, Some(open), size.radius_mm()) {
                    for (&floor, (_, patch)) in &b.floors {
                        surfaces.insert(floor, Surface::new(floor, patch.pieces.clone()));
                    }
                    buildings.push(b);
                }
            }
            stack.extend(kids.iter().rev().copied());
        }
        // The open ground's own links: gates in walls and fences.
        let known: BTreeMap<Id, BTreeSet<Id>> = buildings
            .iter()
            .map(|b| (b.thing, b.links.iter().map(|l| l.id).collect()))
            .collect();
        let all = known.values().flatten().copied().collect();
        let on = |sq: (i32, i32), p: [i64; 2]| map.on_square(ground, sq, p);
        let open = Open {
            ground,
            place: crate::ground::scene::Xform::IDENTITY,
            meets: &meets,
            on: &on,
            doors: &gdoors,
            terrain: open.terrain(),
        };
        buildings.push(Building::of_ground(tree, open, &all)?);
        let mut joined = BTreeSet::new();
        for (i, l) in floor_joins(&buildings.iter().collect::<Vec<_>>()) {
            joined.insert(buildings[i].thing);
            let far = l.ends.iter().flatten().map(|e| e.floor);
            joined.extend(far.filter_map(|f| {
                let owner = buildings.iter().find(|b| b.floors.contains_key(&f))?;
                Some(owner.thing)
            }));
            buildings[i].join(l);
        }
        let reach = buildings
            .iter()
            .filter(|b| b.thing != ground)
            .filter_map(|b| Some((b.thing, reach(b)?)))
            .collect();
        let basis = Basis {
            layout: Arc::new(SurfaceLayout {
                count: surfaces[&ground].pieces().len() as u32,
                squares: square_pieces.clone(),
            }),
            flags: Arc::new(square_flags),
            floors: Arc::new(
                surfaces
                    .iter()
                    .filter(|(id, _)| **id != ground)
                    .map(|(&id, s)| (id, Arc::new(s.clone())))
                    .collect(),
            ),
            size,
            classes: BTreeMap::new(),
            open: Arc::new(OpenCut {
                squares,
                meets,
                doors: gdoors,
                terrain,
            }),
            index: Index::of(tree, ground)?,
            known: Arc::new(known),
            reach: Arc::new(reach),
            joined: Arc::new(joined),
        };
        Ok((map, surfaces, buildings, basis, square_pieces))
    }

    /// `body` found again on its node's ground as it is now (its piece and triangle), where it stands, its velocity
    /// kept; refused when it stands on none (`off-ground`).
    pub fn relocate(&self, body: &Body) -> Result<Body, Refusal> {
        let node = node_of(body);
        let mut b = self
            .surfaces_for(self.size_of(body.id))
            .ok_or_else(|| refusal("body-class-unprepared", "no prepared geometry"))?
            .get(&node)
            .ok_or_else(|| refusal("no-surface", show(node)))?
            .place_built(
                body.id,
                body.pose.frame,
                body.pose.position,
                body.pose.orientation,
                replica::kinds::sizes::Build {
                    size: self.size_of(body.id),
                    hover_mm: match body.pose.support {
                        Support::Surface { height, .. } => height / 1000,
                        Support::Slot | Support::Volume { .. } | Support::Track | Support::None => {
                            0
                        }
                    },
                    ..replica::kinds::sizes::Build::STANDARD
                },
            )?;
        b.linear = body.linear;
        Ok(b)
    }

    fn geometry(&self, size: Size) -> Result<GeometryRead<'_>, Refusal> {
        if size == Size::Standard {
            Ok((&self.map, &self.surfaces, &self.buildings, &self.link_at))
        } else {
            self.classes
                .get(&size)
                .map(|g| (&g.map, &g.surfaces, g.buildings.as_slice(), &g.link_at))
                .ok_or_else(|| refusal("body-class-unprepared", "no prepared geometry"))
        }
    }

    /// A copy of this town for a planner (K18b, #3175): built again from a frozen copy of the tree, with its own map
    /// and spot tables, and a door writer of its own (the planner never opens a door).
    pub fn copy(&self) -> Result<Town, String> {
        let d = &self.doors;
        let mut copy = Town::new(
            self.tree.frozen(),
            self.ground,
            Doors::new(d.header.clone(), d.rules.clone(), d.next),
        )?;
        copy.prepare_classes(self.classes.keys().copied())?;
        copy.body_classes.clone_from(&self.body_classes);
        Ok(copy)
    }

    /// A copy of this town by memory copy, as it stands (#3743): the edit checker's own town, seeded at boot from the
    /// town the boot already built instead of assembled again. Its ground, classes and versions are this town's;
    /// its tree is a frozen copy and its door writer its own. No walker, line, plan or spot table is copied.
    pub fn duplicate(&self) -> Town {
        let d = &self.doors;
        Town {
            tree: self.tree.frozen(),
            classes: self.classes.clone(),
            body_classes: self.body_classes.clone(),
            ground: self.ground,
            map: self.map.clone(),
            surfaces: self.surfaces.clone(),
            buildings: self.buildings.clone(),
            link_at: self.link_at.clone(),
            doors: Doors::new(d.header.clone(), d.rules.clone(), d.next),
            turns: Some(Turns::new()),
            spots: Spots::new(),
            meter: None,
            spent: Cell::new(Spent::default()),
            lines: Vec::new(),
            scratches: vec![ClassScratch::default()],
            crossings: BTreeMap::new(),
            versions: self.versions.clone(),
            basis: self.basis.clone(),
            square_pieces: self.square_pieces.clone(),
            planned: BTreeMap::new(),
            planned_squares: BTreeMap::new(),
            stale: BTreeMap::new(),
        }
    }

    /// A town on `tree` and its planner's copy (K18b, #3175), with the ground assembled once (#3672): the planner
    /// gets a clone of the assembled ground instead of a second assembly. Equal to [`Town::new`] then
    /// [`Town::copy`]: assembly reads only the tree, the ground and fresh versions, all the same for both.
    pub fn with_planner(tree: Tree, ground: Id, doors: Doors) -> Result<(Town, Town), String> {
        let frozen = tree.frozen();
        let planner_doors = Doors::new(doors.header.clone(), doors.rules.clone(), doors.next);
        let town = Town::new(tree, ground, doors)?;
        let (map, surfaces, buildings, basis, square_pieces) = (
            town.map.clone(),
            town.surfaces.clone(),
            town.buildings.clone(),
            town.basis.clone(),
            town.square_pieces.clone(),
        );
        let link_at = town.link_at.clone();
        let planner = Town {
            tree: frozen,
            classes: BTreeMap::new(),
            body_classes: BTreeMap::new(),
            ground,
            map,
            surfaces,
            buildings,
            link_at,
            doors: planner_doors,
            turns: Some(Turns::new()),
            spots: Spots::new(),
            meter: None,
            spent: Cell::new(Spent::default()),
            lines: Vec::new(),
            scratches: vec![ClassScratch::default()],
            crossings: BTreeMap::new(),
            versions: Versions::default(),
            basis,
            square_pieces,
            planned: BTreeMap::new(),
            planned_squares: BTreeMap::new(),
            stale: BTreeMap::new(),
        };
        Ok((town, planner))
    }

    /// The line from where `body` stands toward `to` on its node ([`View::search`], the planning call): the planner's
    /// (K18b, #3175), not the clock's.
    pub fn line(&mut self, body: &Body, to: Vec3) -> Result<Line, Refusal> {
        self.view_for(body.id)?.search(body, to)
    }

    /// The frame on the open ground of the building that holds the floor `node`.
    fn frame_of(&self, node: Id) -> Option<crate::ground::scene::Xform> {
        self.buildings
            .iter()
            .find(|b| b.floors.contains_key(&node))
            .map(|b| b.place)
    }

    /// The town as the host's questions read it in a tick: the map shared, a route search's scratch behind a cell
    /// (what it finds is cached), the rest shared.
    pub fn view(&mut self) -> View<'_> {
        self.view_for_size(Size::Standard)
            .expect("standard geometry is always prepared")
    }
    pub fn view_for(&mut self, body: Id) -> Result<View<'_>, Refusal> {
        self.view_for_size(self.size_of(body))
    }
    pub fn view_for_size(&mut self, size: Size) -> Result<View<'_>, Refusal> {
        let split = self.split(1);
        split.shared.view_for(
            size,
            &mut split.scratches[0],
            Lines::All(split.lines),
            split.spent,
        )
    }

    /// The town split for `workers` threads asking its questions side by side (N17b, #3255): the parts every thread
    /// reads, one route search scratch each, and the walkers' lines and the costs, which the caller hands out. What
    /// the scratches found since the last split joins the map's caches first.
    pub fn split(&mut self, workers: usize) -> Split<'_> {
        self.keep_scratches();
        let workers = workers.max(1);
        if self.scratches.len() < workers {
            self.scratches.resize_with(workers, ClassScratch::default);
        }
        Split {
            shared: Shared {
                tree: &self.tree,
                classes: &self.classes,
                map: &self.map,
                surfaces: &self.surfaces,
                buildings: &self.buildings,
                link_at: &self.link_at,
                turns: self.turns.as_ref(),
                meter: self.meter,
                ground: self.ground,
            },
            scratches: &mut self.scratches[..workers],
            lines: &mut self.lines,
            spent: &self.spent,
        }
    }
}

/// The town split for threads ([`Town::split`]).
pub struct Split<'a> {
    pub shared: Shared<'a>,
    pub scratches: &'a mut [ClassScratch],
    /// Each walker's line of corners, by walker: a thread's view needs those of the walkers it steps.
    pub lines: &'a mut Vec<(Id, Line)>,
    pub spent: &'a Cell<Spent>,
}

/// The parts of the town every thread reads in a tick, never writes.
#[derive(Clone, Copy)]
pub struct Shared<'a> {
    pub tree: &'a Tree,
    classes: &'a BTreeMap<Size, Geometry>,
    map: &'a Map,
    surfaces: &'a BTreeMap<Id, Surface>,
    buildings: &'a [Building],
    link_at: &'a BTreeMap<Id, (usize, usize)>,
    turns: Option<&'a Turns>,
    meter: Option<fn() -> u64>,
    ground: Id,
}

impl crate::mover::Floors for Shared<'_> {
    fn for_build(&self, build: replica::kinds::sizes::Build) -> Option<&BTreeMap<Id, Surface>> {
        if build.size == Size::Standard {
            Some(self.surfaces)
        } else {
            self.classes.get(&build.size).map(|g| &g.surfaces)
        }
    }
}
impl crate::mover::Floors for Town {
    fn for_build(&self, build: replica::kinds::sizes::Build) -> Option<&BTreeMap<Id, Surface>> {
        self.surfaces_for(build.size)
    }
}

impl<'a> Shared<'a> {
    /// The town as one thread's questions read it: its own scratch, the lines of the walkers it steps, and the costs
    /// it counts.
    pub fn view<'b>(
        &self,
        scratch: &'b mut ClassScratch,
        lines: Lines<'b>,
        spent: &'b Cell<Spent>,
    ) -> View<'b>
    where
        'a: 'b,
    {
        self.view_for(Size::Standard, scratch, lines, spent)
            .expect("standard geometry")
    }
    pub fn view_for<'b>(
        &self,
        size: Size,
        scratch: &'b mut ClassScratch,
        lines: Lines<'b>,
        spent: &'b Cell<Spent>,
    ) -> Result<View<'b>, Refusal>
    where
        'a: 'b,
    {
        let (map, surfaces, buildings, link_at, scratch) = if size == Size::Standard {
            (
                self.map,
                self.surfaces,
                self.buildings,
                self.link_at,
                &mut scratch.standard,
            )
        } else {
            let g = self
                .classes
                .get(&size)
                .ok_or_else(|| refusal("body-class-unprepared", "no prepared geometry"))?;
            (
                &g.map,
                &g.surfaces,
                g.buildings.as_slice(),
                &g.link_at,
                scratch.other.entry(size).or_default(),
            )
        };
        Ok(View {
            tree: self.tree,
            map,
            scratch: RefCell::new(scratch),
            surfaces,
            buildings,
            link_at,
            turns: self.turns,
            meter: self.meter,
            spent,
            lines: RefCell::new(lines),
            ground: self.ground,
        })
    }
}

/// Walkers' lines of corners as one view holds them, in walker order (N17b): all of them, or a thread's run of them
/// and the lines it found for walkers that had none (joined to the rest after the tick's skills).
pub enum Lines<'a> {
    All(&'a mut Vec<(Id, Line)>),
    Part(&'a mut [(Id, Line)], &'a mut Vec<(Id, Line)>),
}

impl Lines<'_> {
    fn get_mut(&mut self, id: Id) -> Option<&mut Line> {
        match self {
            Lines::All(v) => match v.binary_search_by_key(&id, |e| e.0) {
                Ok(i) => Some(&mut v[i].1),
                Err(_) => None,
            },
            Lines::Part(kept, new) => match kept.binary_search_by_key(&id, |e| e.0) {
                Ok(i) => Some(&mut kept[i].1),
                Err(_) => new.iter_mut().find(|e| e.0 == id).map(|e| &mut e.1),
            },
        }
    }

    fn insert(&mut self, id: Id, l: Line) {
        match self {
            Lines::All(v) => match v.binary_search_by_key(&id, |e| e.0) {
                Ok(i) => v[i].1 = l,
                Err(i) => v.insert(i, (id, l)),
            },
            Lines::Part(kept, new) => match kept.binary_search_by_key(&id, |e| e.0) {
                Ok(i) => kept[i].1 = l,
                Err(_) => match new.iter_mut().find(|e| e.0 == id) {
                    Some(e) => e.1 = l,
                    None => new.push((id, l)),
                },
            },
        }
    }

    /// Forgets `id`'s line (K18b): its next corner is asked for as a new line's. A thread's run cannot take an entry
    /// out of its kept part, so that line is left aimed at no point a walk asks for, which reads as none.
    fn forget(&mut self, id: Id) {
        match self {
            Lines::All(v) => {
                if let Ok(i) = v.binary_search_by_key(&id, |e| e.0) {
                    v.remove(i);
                }
            }
            Lines::Part(kept, new) => {
                if let Ok(i) = kept.binary_search_by_key(&id, |e| e.0) {
                    kept[i].1.to = Vec3::new(i64::MIN, i64::MIN, i64::MIN);
                }
                new.retain(|e| e.0 != id);
            }
        }
    }
}

/// The town as the walk skill's questions read it ([`Town::view`], [`Shared::view`]).
pub struct View<'a> {
    pub tree: &'a Tree,
    map: &'a Map,
    scratch: RefCell<&'a mut Scratch>,
    surfaces: &'a BTreeMap<Id, Surface>,
    buildings: &'a [Building],
    link_at: &'a BTreeMap<Id, (usize, usize)>,
    turns: Option<&'a Turns>,
    meter: Option<fn() -> u64>,
    spent: &'a Cell<Spent>,
    lines: RefCell<Lines<'a>>,
    ground: Id,
}

/// A corner is reached within this, µm.
pub const AT_CORNER: i64 = 100_000;
/// A line's corner is aimed at this far out from its turn, µm (#3473): twice [`AT_CORNER`], so the walker, turning
/// within [`AT_CORNER`] of it for the next corner, is on the outer side of the edge it went round.
pub const ROUND: i64 = 2 * AT_CORNER;
/// A walker pushed further than this off the stretch of its line it walks is searched for again, µm.
pub const OFF_LINE: i64 = 1_000_000;
/// A straight walk to the next corner is checked once in this many of a walker's corner calls (a second at 20 ticks
/// a second); each walker's first check is staggered by its id.
pub const CHECK: u32 = 20;

/// A walker's line of corners toward `to` on `node` (#3167): where the body stood when it was searched for, then
/// the corners, x and z µm. It ends at `to` (`whole`), or where the route leaves the piece the search began on.
#[derive(Clone, Debug)]
pub struct Line {
    node: Id,
    to: Vec3,
    points: Vec<[i64; 2]>,
    /// The corner aimed at: an index into `points`, from 1.
    next: usize,
    whole: bool,
    /// Corner calls until the next straight-walk check.
    check: u32,
}

/// The planner's side of a tick's corners (K18b, #3175): what it found for the last tick's asks, by walker (the leg's
/// end asked, and the line or the search's refusal), and the walkers that ask it for one in this tick (the body as it
/// stood, and the leg's end).
pub struct Plans<'a> {
    pub found: &'a Found,
    pub asked: &'a RefCell<Vec<(Body, Vec3)>>,
}

/// The planner's lines by walker: the leg's end asked, and the line or the search's refusal.
pub type Found = BTreeMap<Id, (Vec3, Result<Line, Refusal>)>;

impl Line {
    /// A line for `body` toward `to` through `points` (the first where it stands), aiming at the second. Its first
    /// check is a whole period away, plus a share of one by id, so checks spread over ticks.
    fn new(body: &Body, to: Vec3, points: Vec<[i64; 2]>, whole: bool) -> Line {
        Line {
            node: node_of(body),
            to,
            points,
            next: 1,
            whole,
            check: CHECK + (body.id.counter() % u64::from(CHECK)) as u32,
        }
    }

    /// Moves on past the corners `p` has reached or gone past. Why the line no longer serves, if it does not: `p` is
    /// more than [`OFF_LINE`] off the stretch it walks ([`Why::Off`]), or it has reached the end of a line that stops
    /// short of `to` ([`Why::End`]).
    fn follow(&mut self, p: [i64; 2]) -> Option<Why> {
        loop {
            let (a, c) = (self.points[self.next - 1], self.points[self.next]);
            let past = (p[0] - c[0]) as i128 * (c[0] - a[0]) as i128
                + (p[1] - c[1]) as i128 * (c[1] - a[1]) as i128
                > 0;
            if dist2_xz(p, c) > sq(AT_CORNER) && !past {
                return (dist2_xz(p, nearest_on(p, a, c)) > sq(OFF_LINE)).then_some(Why::Off);
            }
            if self.next + 1 == self.points.len() {
                // The last corner: `to` is aimed at until the walk arrives; a piece's end is searched on from.
                return (!self.whole).then_some(Why::End);
            }
            self.next += 1;
        }
    }
}

/// Why a walker's line is searched for again.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Why {
    New,
    Off,
    End,
    Blocked,
}

/// A unit length for directions (x and z), in millionths.
const UNIT: i128 = 1_000_000;

/// The way out from the turn at `c` on the line `a`-`c`-`n` (x and z, [`UNIT`] long): away from the inside of the
/// turn, where the edge it goes round lies. `None` where the line goes on straight or doubles back.
fn outward(a: [i64; 2], c: [i64; 2], n: [i64; 2]) -> Option<[i128; 2]> {
    let unit = |v: [i128; 2]| {
        let l = (v[0] * v[0] + v[1] * v[1]).isqrt();
        (l > 0).then(|| [v[0] * UNIT / l, v[1] * UNIT / l])
    };
    let i = unit([i128::from(c[0] - a[0]), i128::from(c[1] - a[1])])?;
    let o = unit([i128::from(n[0] - c[0]), i128::from(n[1] - c[1])])?;
    let v = [i[0] - o[0], i[1] - o[1]];
    // Under a thousandth of a radian of turn, or a full turn back: no side to move out to.
    let (l2, tiny) = (v[0] * v[0] + v[1] * v[1], (UNIT / 1_000).pow(2));
    if l2 < tiny || l2 > 4 * UNIT * UNIT - tiny {
        return None;
    }
    unit(v)
}

fn sq(v: i64) -> i128 {
    i128::from(v) * i128::from(v)
}

fn dist2_xz(a: [i64; 2], b: [i64; 2]) -> i128 {
    sq(a[0] - b[0]) + sq(a[1] - b[1])
}

/// The point of the segment `a`-`c` nearest `p` (x and z).
fn nearest_on(p: [i64; 2], a: [i64; 2], c: [i64; 2]) -> [i64; 2] {
    let e = [i128::from(c[0] - a[0]), i128::from(c[1] - a[1])];
    let l2 = e[0] * e[0] + e[1] * e[1];
    if l2 == 0 {
        return a;
    }
    let t = (i128::from(p[0] - a[0]) * e[0] + i128::from(p[1] - a[1]) * e[1]).clamp(0, l2);
    [a[0] + (e[0] * t / l2) as i64, a[1] + (e[1] * t / l2) as i64]
}

fn walk(v: [i64; 2]) -> ControllerInput {
    ControllerInput {
        velocity: Vec3::new(v[0], 0, v[1]),
        mode: Mode::Surface,
    }
}

fn dist2(a: Vec3, b: Vec3) -> i128 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)
}

/// Each building's reach on the open ground for [`in_passage`] (C8, #3396): the box (x min, z min, x max, z max, µm)
/// round every link end and placed line point it tests there, each widened by the most it is tested within; `None`
/// when no link has an end on the ground. A point outside the box is in none of its passages, so skipping the building
/// gives the same answer without placing its lines (a spot table on Eden tested 651 doors at each of its places).
pub fn ground_boxes(buildings: &[Building], ground: Id) -> Vec<Option<[i64; 4]>> {
    let grow = |bx: Option<[i64; 4]>, p: Vec3, m: i64| {
        let r = [p.x - m, p.z - m, p.x + m, p.z + m];
        Some(bx.map_or(r, |o| {
            [
                o[0].min(r[0]),
                o[1].min(r[1]),
                o[2].max(r[2]),
                o[3].max(r[3]),
            ]
        }))
    };
    let boxes = buildings.iter().map(|b| {
        let mut bx = None;
        for l in &b.links {
            let ends: Vec<_> = l
                .ends
                .iter()
                .flatten()
                .filter(|e| e.floor == ground)
                .collect();
            if ends.is_empty() {
                continue;
            }
            let m = CLEAR.max(l.width / 2 + CLEAR / 2);
            let line = l.line.iter().map(|s| b.place.point(*s).unwrap_or(*s));
            for p in ends.iter().flat_map(|e| [e.a, e.b]).chain(line) {
                bx = grow(bx, p, m);
            }
        }
        bx
    });
    boxes.collect()
}

/// Whether `p` (µm, the frame of `node`) lies in a doorway or on a stair: within [`CLEAR`] of the end on `node` of a
/// link, or within half the link's width and half [`CLEAR`] of its line. On the open ground a building outside its
/// box in `boxes` ([`ground_boxes`]) is skipped; with no boxes, every building is tested.
///
/// Two limits (#4072): on a building's own floor, a flight's line counts only where it lies from a step below `p`'s
/// height to a body's height above it ([`level_part`]), so a landing over a stair's foot is no stair (the open
/// ground's plan has no heights, so there the whole line counts). And a step's width lies along its edge, which its ends hold: its line
/// counts only within half [`CLEAR`], so a porch front 9 m wide is no doorway 4.85 m deep through the wall behind it.
pub fn in_passage(
    buildings: &[Building],
    boxes: &[Option<[i64; 4]>],
    ground: Id,
    node: Id,
    p: Vec3,
) -> bool {
    in_passage_but(buildings, boxes, ground, node, p, None)
}

/// [`in_passage`], with the doorway of thing `door`'s own link not counted (#3688): a body acting on a door may stand
/// in that door's own doorway, as no place out of it may be within an arm of the door's panel.
pub fn in_passage_but(
    buildings: &[Building],
    boxes: &[Option<[i64; 4]>],
    ground: Id,
    node: Id,
    p: Vec3,
    door: Option<Id>,
) -> bool {
    buildings.iter().enumerate().any(|(i, b)| {
        if node == ground
            && let Some(bx) = boxes.get(i)
            && bx.is_none_or(|r| p.x < r[0] || p.z < r[1] || p.x > r[2] || p.z > r[3])
        {
            return false;
        }
        b.links
            .iter()
            .filter(|l| door.is_none() || l.door != door)
            // A step between two surfaces of one floor (a humped deck's quads, a few centimetres apart) is ground a
            // body walks and stands on, no doorway or stair (#1960).
            .filter(|l| !(l.kind == Kind::Step && l.nodes[0] == l.nodes[1]))
            .any(|l| {
                let ends = l.ends.iter().flatten().filter(|e| e.floor == node);
                let mut on = false;
                for e in ends {
                    on = true;
                    if to_segment(p, e.a, e.b) < CLEAR {
                        return true;
                    }
                }
                // The line is in the building's frame: read on the open ground or on the building's own floors (not
                // on another thing's floor a step or a flight lands on).
                let flight = matches!(l.kind, Kind::Stairs | Kind::Ramp | Kind::Ladder);
                let reach = if l.kind == Kind::Step {
                    CLEAR / 2
                } else {
                    l.width / 2 + CLEAR / 2
                };
                on && (node == ground || b.floors.contains_key(&node))
                    && l.line.windows(2).any(|s| {
                        let (a, c) = if node == ground {
                            (
                                b.place.point(s[0]).unwrap_or(s[0]),
                                b.place.point(s[1]).unwrap_or(s[1]),
                            )
                        } else {
                            (s[0], s[1])
                        };
                        if flight && node != ground {
                            level_part(a, c, p.y).is_some_and(|(a, c)| to_segment(p, a, c) < reach)
                        } else {
                            to_segment(p, a, c) < reach
                        }
                    })
            })
    })
}

/// The part of a flight's line segment `a`–`c` (µm) a body standing at height `y` meets ([`in_passage_but`]): from a
/// step ([`crate::ground::STEP`]) below `y`, its foot, to the body's height ([`crate::ground::BODY_HIGH`]) above; `None`
/// when no part does. A flight lower than a step under `y` runs beneath that floor.
pub fn level_part(a: Vec3, c: Vec3, y: i64) -> Option<(Vec3, Vec3)> {
    let (under, over) = (crate::ground::STEP * 1000, crate::ground::BODY_HIGH * 1000);
    let (a, c) = if a.y <= c.y { (a, c) } else { (c, a) };
    let rise = i128::from(c.y - a.y);
    if rise == 0 {
        return (a.y >= y - under && a.y <= y + over).then_some((a, c));
    }
    // Along the segment from `a` (0) to `c` (`rise`), as heights above `a`.
    let lo = i128::from(y - under - a.y).max(0);
    let hi = i128::from(y + over - a.y).min(rise);
    if lo > hi {
        return None;
    }
    let at = |t: i128| {
        let f = |u: i64, v: i64| u + (i128::from(v - u) * t / rise) as i64;
        Vec3::new(f(a.x, c.x), f(a.y, c.y), f(a.z, c.z))
    };
    Some((at(lo), at(hi)))
}

/// The town as the spot tables read it (N9): N5's map for walkable ground and routes, N6's surfaces for a straight
/// walk, N4's links for doorways and stairs.
struct Grounds<'a> {
    tree: &'a Tree,
    map: MapRef<'a>,
    surfaces: &'a BTreeMap<Id, Surface>,
    buildings: &'a [Building],
    ground: Id,
    /// [`ground_boxes`], made at the first passage asked about.
    boxes: OnceCell<Vec<Option<[i64; 4]>>>,
    /// A door whose own doorway is not a passage here ([`in_passage_but`]).
    door: Option<Id>,
}

/// N5's map as the spot tables search it: the town's own (its searches keep their caches), or a view's shared map
/// searched with the view's own scratch (N17b, #3255; C15's [`View::stand_near`]).
enum MapRef<'a> {
    Own(&'a mut Map),
    Shared(&'a Map, &'a mut Scratch),
}

impl MapRef<'_> {
    fn get(&self) -> &Map {
        match self {
            MapRef::Own(m) => m,
            MapRef::Shared(m, _) => m,
        }
    }

    fn route(&mut self, tree: &Tree, from: Spot, to: Spot, has: Mask) -> Result<Route, Refusal> {
        match self {
            MapRef::Own(m) => m.route(tree, from, to, has),
            MapRef::Shared(m, sc) => m.route_in(sc, tree, from, to, has),
        }
    }
}

struct ClassGrounds<'a>(BTreeMap<Size, Grounds<'a>>);
impl ClassGround for ClassGrounds<'_> {
    fn stand(&self, size: Size, node: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        self.0.get(&size)?.stand(node, p)
    }
    fn passage(&self, size: Size, node: Id, p: Vec3) -> bool {
        self.0.get(&size).is_none_or(|g| g.passage(node, p))
    }
    fn walk(&mut self, size: Size, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64> {
        self.0.get_mut(&size)?.walk(an, a, bn, b)
    }
    fn may_reach(&self, size: Size, an: Id, a: Vec3, bn: Id, b: Vec3) -> bool {
        self.0.get(&size).is_none_or(|g| g.may_reach(an, a, bn, b))
    }
}

impl Ground for Grounds<'_> {
    fn stand(&self, node: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        let s = self.map.get().spot(node, p)?;
        let w = self.map.get().world(s.piece, s.at);
        let um = |v: [i64; 3]| Vec3::new(v[0] * 1000, v[1] * 1000, v[2] * 1000);
        Some((um(s.at), um(w)))
    }

    fn passage(&self, node: Id, p: Vec3) -> bool {
        let boxes = self
            .boxes
            .get_or_init(|| ground_boxes(self.buildings, self.ground));
        in_passage_but(self.buildings, boxes, self.ground, node, p, self.door)
    }

    fn walk(&mut self, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64> {
        // A straight walk on the surface (N6's walk, as the next corner is found), else N5's route.
        if an == bn
            && let Some(s) = self.surfaces.get(&an)
            && let Ok(mut body) = s.place(
                an,
                Frame {
                    node: an,
                    slot: None,
                },
                a,
                Quat::IDENTITY,
            )
            && s.step(&mut body, walk([b.x - a.x, b.z - a.z]), 1_000_000, 0)
                .is_ok()
            && [body.pose.position.x, body.pose.position.z] == [b.x, b.z]
        {
            return Some(flat(a, b));
        }
        let from = self.map.get().spot_near(an, a, AT_EDGE)?;
        let to = self.map.get().spot_near(bn, b, AT_EDGE)?;
        // Pieces no portal or link joins: no route, decided without a search (a failed search walks the whole part
        // it starts in, twice; #4072).
        if !self.map.get().may_reach(from.piece, to.piece) {
            return None;
        }
        let r = self.map.route(self.tree, from, to, HANDS).ok()?;
        Some(r.length as i64 * 1000)
    }

    fn may_reach(&self, an: Id, a: Vec3, bn: Id, b: Vec3) -> bool {
        let m = self.map.get();
        match (m.spot_near(an, a, AT_EDGE), m.spot_near(bn, b, AT_EDGE)) {
            (Some(from), Some(to)) => m.may_reach(from.piece, to.piece),
            _ => true,
        }
    }
}

impl World for Town {
    fn spots(&mut self, marks: &[Mark], at: Micros) -> Result<(), Refusal> {
        let asks = marks
            .iter()
            .filter_map(|m| {
                m.spot.map(|(target, order)| {
                    (
                        Ask {
                            who: m.who,
                            order,
                            node: m.node,
                            from: m.at,
                            target,
                        },
                        self.size_of(m.who),
                    )
                })
            })
            .collect::<Vec<_>>();
        if asks
            .iter()
            .any(|(_, size)| self.surfaces_for(*size).is_none())
        {
            return Err(refusal("body-class-unprepared", "standing spot geometry"));
        }
        let Town {
            spots,
            map,
            tree,
            buildings,
            ground,
            surfaces,
            classes,
            ..
        } = self;
        let mut gs = BTreeMap::new();
        gs.insert(
            Size::Standard,
            Grounds {
                tree,
                map: MapRef::Own(map),
                surfaces,
                buildings,
                ground: *ground,
                boxes: OnceCell::new(),
                door: None,
            },
        );
        for (&size, g) in classes {
            gs.insert(
                size,
                Grounds {
                    tree,
                    map: MapRef::Own(&mut g.map),
                    surfaces: &g.surfaces,
                    buildings: &g.buildings,
                    ground: *ground,
                    boxes: OnceCell::new(),
                    door: None,
                },
            );
        }
        spots.write_sized(&mut ClassGrounds(gs), &asks, at)
    }

    fn spot(&self, who: Id, target: &Target) -> Option<Result<Vec3, &'static str>> {
        self.spots.of(who, target)
    }

    fn turns(&mut self, marks: &[Mark], at: Micros) -> Result<(), Refusal> {
        let Town {
            turns,
            buildings,
            crossings,
            link_at,
            ..
        } = self;
        // A crossing ends when the controller no longer carries the body.
        let carried: BTreeSet<Id> = marks
            .iter()
            .filter(|m| m.crossing.is_some())
            .map(|m| m.who)
            .collect();
        crossings.retain(|who, _| carried.contains(who));
        let Some(turns) = turns.as_mut() else {
            return Ok(());
        };
        // The links waited for, crossed, or with a state already.
        let mut ids: BTreeSet<Id> = marks
            .iter()
            .flat_map(|m| [m.waiting.map(|w| w.0), m.crossing])
            .flatten()
            .collect();
        ids.extend(turns.owners.values().flat_map(|m| m.keys().copied()));
        let mut refused = None;
        for id in ids {
            let Some(l) = find_link(link_at, buildings, id) else {
                continue;
            };
            if !narrow(l) {
                continue;
            }
            let mut f = Facts::default();
            for m in marks {
                if let Some((w, gap)) = m.waiting
                    && w == id
                    && let Some(k) = (0..2)
                        .filter(|&k| l.ends[k].is_some_and(|e| e.floor == m.node))
                        .min_by_key(|&k| l.ends[k].map_or(i128::MAX, |e| dist2(m.at, e.middle())))
                {
                    f.waiting[k].push((gap, m.who));
                }
                if m.crossing == Some(id)
                    && let Some(c) = crossings.get(&m.who)
                {
                    f.inside
                        .push((c.from, dist2(c.start, m.at).isqrt() as i64, m.who));
                }
            }
            for (k, e) in l.ends.iter().enumerate() {
                f.room[k] = e.is_some_and(|e| {
                    !marks.iter().any(|m| {
                        m.node == e.floor
                            && m.crossing.is_none()
                            && !m.staying
                            && m.waiting.map(|w| w.0) != Some(id)
                            && dist2(m.at, e.middle()) < i128::from(ROOM) * i128::from(ROOM)
                    })
                });
            }
            // One link's refusal does not stop the others' writes; the first is returned once all are written.
            if let Err(r) = turns.write(l.owner, l, &f, at) {
                refused.get_or_insert(r);
            }
        }
        refused.map_or(Ok(()), Err)
    }

    fn plan(&mut self, body: &Body, node: Id, goal: Vec3) -> Result<Vec<Leg>, Refusal> {
        self.plan_with_metrics(body, node, goal)
            .map(|(legs, _)| legs)
    }
}

/// Metrics of the actual N5 route, kept beside its legs for a gateway act's deadline (C29). Neither straight
/// distance nor the legs alone include the route's obstacle corners and crossing frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RouteMetrics {
    pub length_mm: u64,
    pub links: usize,
}

impl Town {
    /// The existing route search, with its metrics retained. Called by the planner, never by the clock.
    pub fn plan_with_metrics(
        &mut self,
        body: &Body,
        node: Id,
        goal: Vec3,
    ) -> Result<(Vec<Leg>, RouteMetrics), Refusal> {
        let size = self.size_of(body.id);
        let (map, link_at, buildings) = if size == Size::Standard {
            (&mut self.map, &self.link_at, self.buildings.as_slice())
        } else {
            let g = self
                .classes
                .get_mut(&size)
                .ok_or_else(|| refusal("body-class-unprepared", "no prepared geometry"))?;
            (&mut g.map, &g.link_at, g.buildings.as_slice())
        };
        let (legs, ground, squares, metrics) = plan_on(
            &mut MapRef::Own(map),
            &self.tree,
            link_at,
            buildings,
            self.ground,
            body,
            node,
            goal,
        )?;
        self.planned.insert(body.id, ground);
        self.planned_squares.insert(body.id, squares);
        Ok((legs, metrics))
    }
}

/// The ground a route crosses, each node with its version then (G3).
type Crossed = Vec<(Id, u64)>;
/// The open ground's squares a route crosses, in order (N17b).
type Squares = Vec<(i32, i32)>;

/// The legs from where `body` stands to `goal` (µm, `node`'s frame) over `map`, the ground the route crosses with its
/// versions, and the open ground's squares it crosses (N17b): [`Town::plan`]'s, shared with [`View::plan`].
#[allow(clippy::too_many_arguments)]
fn plan_on(
    map: &mut MapRef,
    tree: &Tree,
    link_at: &BTreeMap<Id, (usize, usize)>,
    buildings: &[Building],
    open: Id,
    body: &Body,
    node: Id,
    goal: Vec3,
) -> Result<(Vec<Leg>, Crossed, Squares, RouteMetrics), Refusal> {
    let here = node_of(body);
    let from = map
        .get()
        .spot_near(here, body.pose.position, AT_EDGE)
        .ok_or_else(|| refusal("off-ground", show(here)))?;
    let to = map
        .get()
        .spot(node, goal)
        .ok_or_else(|| refusal("destination-gone", show(node)))?;
    let route = map.route(tree, from, to, HANDS)?;
    let mut ground: Vec<(Id, u64)> = Vec::new();
    let mut squares: Vec<(i32, i32)> = Vec::new();
    for p in route.patches() {
        if ground.last().map(|l| l.0) != Some(p.node) {
            ground.push((p.node, p.version));
        }
        if p.node == open
            && let Some(sq) = p.square
            && squares.last() != Some(&sq)
        {
            squares.push(sq);
        }
    }
    let (mut legs, mut on, mut at) = (Vec::new(), here, body.pose.position);
    for h in &route.hops {
        let Hop::Link { id, .. } = h else { continue };
        let l = find_link(link_at, buildings, *id)
            .ok_or_else(|| refusal("link-not-walked", show(*id)))?;
        let near = (0..2)
            .filter(|&k| l.ends[k].is_some_and(|e| e.floor == on))
            .min_by_key(|&k| l.ends[k].map_or(i128::MAX, |e| dist2(at, e.middle())))
            .ok_or_else(|| refusal("link-not-walked", show(*id)))?;
        let (a, b) = (l.ends[near], l.ends[1 - near]);
        let (Some(a), Some(b)) = (a, b) else {
            return Err(refusal("link-not-walked", show(*id)));
        };
        legs.push(Leg {
            to: a.middle(),
            link: Some(*id),
        });
        (on, at) = (b.floor, b.middle());
    }
    legs.push(Leg {
        to: goal,
        link: None,
    });
    let metrics = RouteMetrics {
        length_mm: route.length,
        links: route
            .hops
            .iter()
            .filter(|h| matches!(h, Hop::Link { .. }))
            .count(),
    };
    Ok((legs, ground, squares, metrics))
}

impl<'a> View<'a> {
    fn now(&self) -> u64 {
        self.meter.map_or(0, |m| m())
    }

    fn spend(&self, f: impl FnOnce(&mut Spent)) {
        let mut s = self.spent.get();
        f(&mut s);
        self.spent.set(s);
    }

    /// Whether a straight walk on the body's surface from where it stands reaches `to` (x and z, µm), or comes within
    /// `within` of it. Counted.
    fn clear(&self, body: &Body, to: [i64; 2], within: i64) -> Result<bool, Refusal> {
        let t0 = self.now();
        let r = self.straight(body, to, within);
        let t1 = self.now();
        self.spend(|s| {
            s.clears += 1;
            s.clear_ns += t1.saturating_sub(t0);
        });
        r
    }

    fn straight(&self, body: &Body, to: [i64; 2], within: i64) -> Result<bool, Refusal> {
        let node = node_of(body);
        let s = self
            .surfaces
            .get(&node)
            .ok_or_else(|| refusal("no-surface", show(node)))?;
        let p = body.pose.position;
        // In one second, at the velocity that is the whole way: the controller's dry run, moving nothing.
        let b = Controller::probe(s, body, walk([to[0] - p.x, to[1] - p.z]), 1_000_000, 0)?;
        Ok(dist2_xz([b.pose.position.x, b.pose.position.z], to) <= sq(within))
    }

    /// Where `body` aims next on its way to `to` (on the node it stands on), x and z µm: `to` when a straight walk
    /// reaches it, else the next corner of the line there.
    pub fn corner(&self, body: &Body, to: Vec3) -> Result<[i64; 2], Refusal> {
        self.corner_in(body, to, None)
    }

    /// [`View::corner`] with a planner (K18b, #3175): no route search on this thread. A line is taken from `plans`
    /// (the planner's answers to the last tick's asks) where the walker would search for one; when there is none,
    /// a straight walk to `to` is checked (the controller's dry run, no search) and, if it is refused, the line is
    /// asked of the planner and the body stands this tick (its own point is the answer).
    pub fn corner_planned(
        &self,
        body: &Body,
        to: Vec3,
        plans: &Plans<'_>,
    ) -> Result<[i64; 2], Refusal> {
        self.corner_in(body, to, Some(plans))
    }

    fn corner_in(
        &self,
        body: &Body,
        to: Vec3,
        plans: Option<&Plans<'_>>,
    ) -> Result<[i64; 2], Refusal> {
        let t0 = self.now();
        let r = self.next_corner(body, to, plans);
        let t1 = self.now();
        self.spend(|s| {
            s.corners += 1;
            s.corner_ns += t1.saturating_sub(t0);
        });
        r
    }

    /// The next corner from the walker's kept line: it moves on as each corner is reached, and is searched for again
    /// ([`View::search`]) only for a new `to` or node (a new leg, a new order, a moved target), when the walker is
    /// pushed off it, at the end of a line that stops short of `to`, or when a straight walk to the next corner,
    /// checked once in [`CHECK`] calls, is refused.
    fn next_corner(
        &self,
        body: &Body,
        to: Vec3,
        plans: Option<&Plans<'_>>,
    ) -> Result<[i64; 2], Refusal> {
        let node = node_of(body);
        let p = [body.pose.position.x, body.pose.position.z];
        let mut lines = self.lines.borrow_mut();
        let why = match lines.get_mut(body.id) {
            Some(l) if l.node == node && l.to == to => match l.follow(p) {
                Some(why) => why,
                None => {
                    let c = l.points[l.next];
                    l.check -= 1;
                    if l.check > 0 {
                        return Ok(c);
                    }
                    l.check = CHECK;
                    // A corner lies on the ground's edge: coming within reach of it is reaching it.
                    if self.clear(body, c, AT_CORNER)? {
                        return Ok(c);
                    }
                    Why::Blocked
                }
            },
            _ => Why::New,
        };
        self.spend(|s| match why {
            Why::New => s.lines_new += 1,
            Why::Off => s.lines_off += 1,
            Why::End => s.lines_end += 1,
            Why::Blocked => s.lines_blocked += 1,
        });
        let l = match plans {
            None => self.search(body, to)?,
            Some(plans) => match plans.found.get(&body.id).filter(|(t, _)| *t == to) {
                Some((_, Ok(l))) if l.node == node => l.clone(),
                // The planner's search was refused: the walk hears it by name, as from its own search.
                Some((_, Err(e))) => {
                    lines.forget(body.id);
                    return Err(e.clone());
                }
                _ => {
                    lines.forget(body.id);
                    if !self.clear(body, [to.x, to.z], 0)? {
                        plans.asked.borrow_mut().push((*body, to));
                        return Ok(p);
                    }
                    Line::new(body, to, vec![p, [to.x, to.z]], true)
                }
            },
        };
        let c = l.points[l.next];
        lines.insert(body.id, l);
        Ok(c)
    }

    /// The floors the links of thing `thing` land on, its own and other things' (a flight's top on the roof it leads
    /// to, `crate::links::floor_joins`), the open ground left out: each link that can be crossed, its ends' floors.
    pub fn floors_reached(&self, thing: Id) -> Vec<Id> {
        let mut out: Vec<Id> = Vec::new();
        let ends = self
            .buildings
            .iter()
            .filter(|b| b.thing == thing)
            .flat_map(|b| &b.links)
            .filter(|l| l.blocked.is_none())
            .flat_map(|l| l.ends.iter().flatten());
        for e in ends {
            if e.floor != self.ground && !out.contains(&e.floor) {
                out.push(e.floor);
            }
        }
        out
    }

    /// Where a body may stand within `reach` of `at` (µm, `node`'s frame) to act there, for `from` (C15, #3447):
    /// [`crate::spots::within`] over this town's ground.
    pub fn stand_near(&self, node: Id, at: Vec3, reach: i64, from: Option<&Body>) -> Option<Vec3> {
        self.stand_near_door(node, at, reach, from, None)
    }

    /// [`View::stand_near`] for a move at thing `door`: when it is a doorway's door, a place in that doorway counts
    /// (#3688), so a knock from a room whose floor stops short of the door reaches its panel.
    pub fn stand_near_door(
        &self,
        node: Id,
        at: Vec3,
        reach: i64,
        from: Option<&Body>,
        door: Option<Id>,
    ) -> Option<Vec3> {
        self.stand_near_shape(node, at, None, reach, from, door)
    }

    /// [`View::stand_near_door`] for a thing whose footprint is `ring` (#4072: its corners in `node`'s frame, `at`
    /// its middle, and whether the walk ends on it): within `reach` of its outline, or on it
    /// ([`crate::spots::within_footprint`]); with no ring, of `at`.
    pub fn stand_near_shape(
        &self,
        node: Id,
        at: Vec3,
        ring: Option<(&[Vec3], bool)>,
        reach: i64,
        from: Option<&Body>,
        door: Option<Id>,
    ) -> Option<Vec3> {
        let from = from.map(|b| (node_of(b), b.pose.position));
        let mut scratch = self.scratch.borrow_mut();
        let (tree, surfaces, buildings, ground) =
            (self.tree, self.surfaces, self.buildings, self.ground);
        let mut g = Grounds {
            tree,
            map: MapRef::Shared(self.map, &mut scratch),
            surfaces,
            buildings,
            ground,
            boxes: OnceCell::new(),
            door,
        };
        match ring {
            Some((ring, on)) => {
                crate::spots::within_footprint(&mut g, Target::new(node, at), ring, on, reach, from)
            }
            None => crate::spots::within(&mut g, Target::new(node, at), reach, from),
        }
    }

    /// A thing's footprint `corners` (its own frame, [`crate::spots::footprint`]) and its middle, the thing placed at
    /// `at` turned by `turn` in node `parent`'s frame (its place in the world's tree: a loose thing need not be in this
    /// view's), carried onto the floor a body stands on ([`View::on_floor`]): the floor, the corners and the middle in
    /// its frame. `None` when they do not all land on one floor.
    pub fn footprint_on_floor(
        &self,
        parent: Id,
        at: Vec3,
        turn: Quat,
        corners: &[Vec3; 4],
    ) -> Option<(Id, [Vec3; 4], Vec3)> {
        let placed = |c: Vec3| at.plus(turn.rotate(c).ok()?).ok();
        let (floor, middle, _) = self.on_floor(parent, at)?;
        let mut ring = [Vec3::ZERO; 4];
        for (r, c) in ring.iter_mut().zip(corners) {
            let (f, p, _) = self.on_floor(parent, placed(*c)?)?;
            if f != floor {
                return None;
            }
            *r = p;
        }
        Some((floor, ring, middle))
    }

    /// The legs a form's walk takes from where `body` stands to `goal` (µm, `node`'s frame), across the links on the
    /// way (C17, #3453): [`Town::plan`]'s route, the ground it crosses not recorded (a form's walk is not planned again
    /// by the ladder).
    pub fn plan(&self, body: &Body, node: Id, goal: Vec3) -> Result<Vec<Leg>, Refusal> {
        let mut scratch = self.scratch.borrow_mut();
        plan_on(
            &mut MapRef::Shared(self.map, &mut scratch),
            self.tree,
            self.link_at,
            self.buildings,
            self.ground,
            body,
            node,
            goal,
        )
        .map(|(legs, _, _, _)| legs)
    }

    /// Each node's surface a body stands on.
    pub fn surfaces(&self) -> &'a BTreeMap<Id, Surface> {
        self.surfaces
    }

    /// Point `at` of node `node`'s frame (µm) carried up the tree to the first node a body stands on (the open ground,
    /// or a building's floor), with the turn from `node`'s axes to that node's (C17, #3453). `None` when no node above
    /// holds a surface.
    pub fn on_floor(&self, node: Id, at: Vec3) -> Option<(Id, Vec3, Quat)> {
        let (mut on, mut at, mut turn) = (node, at, Quat::IDENTITY);
        for _ in 0..64 {
            if self.surfaces.contains_key(&on) {
                return Some((on, at, turn));
            }
            let n = self.tree.node(self.tree.handle(on)?)?;
            let (place, parent) = (n.place()?, n.parent()?);
            at = place
                .position
                .plus(place.orientation.rotate(at).ok()?)
                .ok()?;
            turn = place.orientation.then(turn).ok()?;
            on = parent;
        }
        None
    }

    /// The planning call (#3167): the line from where `body` stands toward `to` on its node, `[here, to]` when a
    /// straight walk reaches `to`, else the first line of N5's route there. Counted. It reads the body's place, the
    /// surfaces, the map and the tree and writes only the map's caches, so the world's tick (K18, #3160) may run it
    /// off the clock thread and hand the line back.
    pub fn search(&self, body: &Body, to: Vec3) -> Result<Line, Refusal> {
        let node = node_of(body);
        let p = [body.pose.position.x, body.pose.position.z];
        let line = |points: Vec<[i64; 2]>, whole: bool| Line::new(body, to, points, whole);
        if self.clear(body, [to.x, to.z], 0)? {
            return Ok(line(vec![p, [to.x, to.z]], true));
        }
        let map = self.map;
        let (Some(from), Some(goal)) = (
            map.spot_near(node, body.pose.position, AT_EDGE),
            // A link's near end lies on its piece's edge, within the grid's rounding.
            map.spot_near(node, to, AT_EDGE),
        ) else {
            return Err(refusal("off-ground", show(node)));
        };
        let t0 = self.now();
        let r = map.route_in(&mut self.scratch.borrow_mut(), self.tree, from, goal, HANDS);
        let t1 = self.now();
        self.spend(|s| {
            s.searches += 1;
            s.search_ns += t1.saturating_sub(t0);
        });
        let r = r?;
        let start = [from.at[0], from.at[2]];
        let end = [goal.at[0], goal.at[2]];
        // The line's points that are not where the body stands (the funnel may repeat a point), mm.
        let mut corners: Vec<[i64; 2]> = r.first_line.iter().skip(1).copied().collect();
        corners.dedup();
        corners.retain(|&c| c != start);
        if corners.is_empty() {
            // Standing where the line ends, on the edge of its piece: aim at the goal, and check again next call (as
            // each tick searched before #3167).
            let mut l = line(vec![p, [to.x, to.z]], false);
            l.check = 1;
            return Ok(l);
        }
        let mut whole = corners.last() == Some(&end);
        // On the open ground the first line ends on its square's edge: the line goes on to the next portal the route
        // crosses (its middle, the ground's frame), or the goal, so the walker is searched for again inside the next
        // square, not on the edge between the two.
        if !whole && node == self.ground {
            match r.waypoints.get(1) {
                Some(w) => corners.push([w[0], w[2]]),
                None => {
                    corners.push(end);
                    whole = true;
                }
            }
        }
        let mut points = vec![p];
        points.extend(corners.iter().map(|c| [c[0] * 1000, c[1] * 1000]));
        self.round(node, &mut points);
        Ok(line(points, whole))
    }

    /// Each corner between a line's first and last point, moved [`ROUND`] out from its turn (or [`AT_CORNER`], where
    /// that is off the surface), so a walker that reaches it and turns for the next is clear of the edge it went round
    /// (#3473). Otherwise a square corner (N11a's steep cells, cut whole) stops a walker: it comes within
    /// [`AT_CORNER`] of the corner, turns for the next, walks into the face beside it, and slides ever less along it.
    fn round(&self, node: Id, points: &mut [[i64; 2]]) {
        let Some(s) = self.surfaces.get(&node) else {
            return;
        };
        let line = points.to_vec();
        for k in 1..line.len().saturating_sub(1) {
            let Some(u) = outward(line[k - 1], line[k], line[k + 1]) else {
                continue;
            };
            let c = line[k];
            for r in [ROUND, AT_CORNER] {
                let o = [
                    c[0] + (u[0] * i128::from(r) / UNIT) as i64,
                    c[1] + (u[1] * i128::from(r) / UNIT) as i64,
                ];
                let frame = Frame { node, slot: None };
                if s.place(node, frame, Vec3::new(o[0], 0, o[1]), Quat::IDENTITY)
                    .is_ok()
                {
                    points[k] = o;
                    break;
                }
            }
        }
    }

    /// A link taken in turns as the walk reads it ([`Town::read_link`]).
    pub fn read_link(&self, link: Id) -> Option<Seen> {
        link_seen(self.turns, self.link_at, self.buildings, self.tree, link)
    }
}

impl Town {
    /// The legs of a walk shaped by `way` (E10, #2781): the routes from where `body` stands through each of the way's
    /// points (`crate::routes::way`) and on to `goal` when one is named, joined into one walk. A point is a leg with
    /// no link that is not the last, which the walk passes without stopping. Each point is one route search, counted
    /// in the points returned.
    pub fn plan_way(
        &mut self,
        body: &Body,
        way: &replica::walk::Way,
        goal: Option<Vec3>,
    ) -> Result<(Vec<Leg>, crate::routes::way::Points), Refusal> {
        let from = body.pose.position;
        let pts = crate::routes::way::points(
            &self.tree,
            self.geometry(self.size_of(body.id))?.0,
            self.ground,
            from,
            goal,
            way,
        )?;
        let mut stops = pts.on.clone();
        stops.extend(goal.map(|g| (self.ground, g)));
        if stops.is_empty() {
            return Err(refusal("way-empty", "a walk with no point and no goal"));
        }
        let (mut legs, mut at, mut ground) = (Vec::new(), *body, Vec::new());
        let mut squares = Vec::new();
        for (node, p) in stops {
            legs.extend(self.plan(&at, node, p)?);
            // The ground the whole walk crosses (G3): each route's, in order.
            ground.extend(self.planned.remove(&body.id).unwrap_or_default());
            squares.extend(self.planned_squares.remove(&body.id).unwrap_or_default());
            at = self
                .surfaces_for(self.size_of(body.id))
                .ok_or_else(|| refusal("body-class-unprepared", "no prepared surfaces"))?
                .get(&node)
                .ok_or_else(|| refusal("no-surface", show(node)))?
                .place(body.id, Frame { node, slot: None }, p, Quat::IDENTITY)?;
        }
        self.planned.insert(body.id, ground);
        self.planned_squares.insert(body.id, squares);
        Ok((legs, pts))
    }

    /// The track across `link` for `body` from where it stands, at `speed`, and the end it goes in by. A shut door
    /// in the link is asked open and the opening written at once (`cause`, the body as the acting Soul), and there is
    /// no track yet: the body stands this tick and asks again the next (T1).
    fn track_of(
        &mut self,
        body: &Body,
        link: Id,
        cause: Cause,
        speed: i64,
        at: Micros,
    ) -> Result<(u8, Option<Track>), Refusal> {
        let size = self.size_of(body.id);
        let (map, surfaces, buildings, link_at) = self.geometry(size)?;
        let l = find_link(link_at, buildings, link)
            .ok_or_else(|| refusal("link-missing", show(link)))?;
        if let Some(why) = l.blocked {
            return Err(refusal(why, show(link)));
        }
        let here = node_of(body);
        let p = body.pose.position;
        let near = (0..2)
            .filter(|&k| l.ends[k].is_some_and(|e| e.floor == here))
            .min_by_key(|&k| l.ends[k].map_or(i128::MAX, |e| dist2(p, e.middle())))
            .ok_or_else(|| refusal("link-not-here", show(link)))?;
        let far = l.ends[1 - near];
        let to = far.map_or(here, |e| e.floor);
        let mut line = l.line.clone();
        if near == 1 {
            line.reverse();
        }
        let door = l.door;
        // The line is in the building's frame; on the open ground it is followed placed there. Between frames it
        // ends where the body stands on the far side: the far end's middle, on its piece (it may lie on the
        // piece's edge, within the grid's rounding). Every landing is one the far surface's mover holds
        // ([`Town::landing`]), or the crossing is refused before the body moves.
        let mut arrive = None;
        if here == self.ground || to == self.ground {
            let place = buildings
                .iter()
                .find(|b| b.link(link).is_some())
                .map(|b| b.place)
                .ok_or_else(|| refusal("link-missing", show(link)))?;
            let out = |e: String| refusal("out-of-range", e);
            if let Some(e) = far {
                // Where the map stands it, else the end's middle; then on the mover's surface (#3168).
                let stand = map
                    .spot_near(to, e.middle(), AT_EDGE)
                    .map_or(e.middle(), |s| {
                        Vec3::new(s.at[0] * 1000, s.at[1] * 1000, s.at[2] * 1000)
                    });
                let mut stand = self
                    .landing(size, to, stand)
                    .ok_or_else(|| refusal("link-end-off-ground", show(link)))?;
                // The open ground's pieces are a plan at 0; a body there stands on its terrain (#3227).
                if to == self.ground {
                    let at = Frame {
                        node: to,
                        slot: None,
                    };
                    stand = surfaces
                        .get(&to)
                        .ok_or_else(|| refusal("no-surface", show(to)))?
                        .place(body.id, at, stand, body.pose.orientation)?
                        .pose
                        .position;
                }
                let last = if to == self.ground {
                    back(&place, stand).map_err(out)?
                } else {
                    stand
                };
                if let Some(p) = line.last_mut() {
                    *p = last;
                }
                arrive = Some(stand);
            }
            if here == self.ground {
                for p in &mut line {
                    *p = place.point(*p).map_err(out)?;
                }
            }
        } else if let Some(b) = buildings.iter().find(|b| b.link(link).is_some())
            && let (Some(ph), Some(pt)) = (self.frame_of(here), self.frame_of(to))
            && (!b.floors.contains_key(&here) || !b.floors.contains_key(&to))
        {
            // A step from one thing's floor onto another's (#3227): the line is followed in the frame of the floor
            // the body stands on, and ends where it stands on the far floor, as on the open ground above.
            let out = |e: String| refusal("out-of-range", e);
            let to_here = |p: Vec3, from: &crate::ground::scene::Xform| {
                from.point(p).and_then(|w| back(&ph, w))
            };
            if !b.floors.contains_key(&here) {
                for p in &mut line {
                    *p = to_here(*p, &b.place).map_err(out)?;
                }
            }
            if let Some(e) = far {
                let stand = map
                    .spot_near(to, e.middle(), AT_EDGE)
                    .map_or(e.middle(), |s| {
                        Vec3::new(s.at[0] * 1000, s.at[1] * 1000, s.at[2] * 1000)
                    });
                let stand = self
                    .landing(size, to, stand)
                    .ok_or_else(|| refusal("link-end-off-ground", show(link)))?;
                if let Some(p) = line.last_mut() {
                    *p = to_here(stand, &pt).map_err(out)?;
                }
                arrive = Some(stand);
            }
        } else if let Some(last) = line.last_mut() {
            *last = self
                .landing(size, to, *last)
                .ok_or_else(|| refusal("link-end-off-ground", show(link)))?;
        }
        // The same admitted support offset follows the original mover-owned crossing line.
        let height = match body.pose.support {
            Support::Surface { height, .. } => height,
            Support::Slot | Support::Volume { .. } | Support::Track | Support::None => 0,
        };
        for point in &mut line {
            point.y = point
                .y
                .checked_add(height)
                .ok_or_else(|| refusal("out-of-range", "support height"))?;
        }
        // The carry starts at the near end: a body asking from further off would be carried there in a straight
        // line, through whatever stands between (#3168).
        if line
            .first()
            .is_some_and(|s| flat2(*s, p) > i128::from(REACH) * i128::from(REACH))
        {
            return Err(refusal(
                "link-not-here",
                format!("{} from {} µm", show(link), flat2(line[0], p).isqrt()),
            ));
        }
        if let Some(door) = door {
            let shut = self
                .tree
                .node(
                    self.tree
                        .handle(door)
                        .ok_or_else(|| refusal("node-missing", show(door)))?,
                )
                .and_then(|n| n.fields().get(&F_OPEN).cloned())
                != Some(Value::Uint(1));
            if shut {
                self.doors.ask(door, link, cause, Actor::Soul(body.id));
                self.doors.flush(&mut self.tree, at)?;
                return Ok((near as u8, None));
            }
        }
        Ok((
            near as u8,
            Some(Track {
                link: Some(link),
                line,
                speed,
                to,
                arrive,
            }),
        ))
    }

    /// A link taken in turns as the walk skill reads it (T9b A3): [`F_TURNS`], and [`F_GRANTED`] the walker its
    /// owner lets in now. Any other link, or none, reads as free (`None`).
    pub fn read_link(&self, link: Id) -> Option<Seen> {
        link_seen(
            self.turns.as_ref(),
            &self.link_at,
            &self.buildings,
            &self.tree,
            link,
        )
    }

    /// Where a crossing stands a body on `node` for the point `at` (µm, its frame): `at` when the mover's surface
    /// holds it, else the surface's nearest legal point within [`LAND`] (N5's map and N6's mover cut the ground
    /// apart, so a link's end on a map piece's edge can lie just off the mover's), else none (#3168).
    fn landing(&self, size: Size, node: Id, at: Vec3) -> Option<Vec3> {
        let s = self.surfaces_for(size)?.get(&node)?;
        let frame = Frame { node, slot: None };
        if s.place(node, frame, at, Quat::IDENTITY).is_ok() {
            return Some(at);
        }
        let (_, q) = exits::nearest(s.pieces(), at)?;
        (flat2(q, at) <= i128::from(LAND.min(size.radius_mm() * 1000)).pow(2)).then_some(q)
    }
}

fn link_seen(
    turns: Option<&Turns>,
    link_at: &BTreeMap<Id, (usize, usize)>,
    buildings: &[Building],
    tree: &Tree,
    link: Id,
) -> Option<Seen> {
    let l = find_link(link_at, buildings, link)?;
    if !narrow(l) {
        return None;
    }
    let mut fields = BTreeMap::from([(F_TURNS, Value::Uint(1))]);
    if let Some(who) = turns?.state(l).and_then(|s| s.granted) {
        fields.insert(F_GRANTED, who.to_value());
    }
    Some(Seen {
        id: link,
        kind: tree.link(link)?.0.clone(),
        parent: None,
        position: Vec3::ZERO,
        fields,
    })
}

impl Links for Town {
    fn track(
        &mut self,
        body: &Body,
        link: Id,
        speed: i64,
        at: Micros,
    ) -> Result<Option<Track>, Refusal> {
        // The world opens a shut door for the walker: its own rule, the walker as the acting Soul.
        let (from, track) = self.track_of(body, link, Cause::World, speed, at)?;
        if track.is_some() {
            let start = body.pose.position;
            self.crossings.insert(body.id, Crossing { from, start });
        }
        Ok(track)
    }
}

#[cfg(test)]
mod prepared_transport_tests {
    use super::*;
    use crate::ground::Patch;
    use crate::ground::scene::Xform;
    use crate::links::{Kind, Link};
    use replica::ids::Scope;

    #[test]
    fn class_preparation_noops_and_standard_copy_do_not_run_a_clock_checker() {
        let make_town = || {
            let facts = testworld::generate(1, 0).unwrap();
            let imported = import_eden::load(&facts.text).unwrap();
            let root = imported.nodes["world"];
            let ground = imported.nodes["ground"];
            let header = import_eden::header(root, &imported.rules).unwrap();
            let next = imported.tree.to_state().next;
            Town::new(
                imported.tree,
                ground,
                Doors::new(header, imported.rules, next),
            )
            .unwrap()
        };
        let mut standard = make_town();
        std::thread::spawn(move || {
            crate::commit::mark_clock_thread();
            standard.prepare_classes([]).unwrap();
            standard.prepare_classes([Size::Standard]).unwrap();
            let copy = standard.copy().unwrap();
            assert_eq!(copy.ground, standard.ground);
            assert_eq!(
                copy.surfaces.keys().collect::<Vec<_>>(),
                standard.surfaces.keys().collect::<Vec<_>>()
            );
            assert!(copy.classes.is_empty());
        })
        .join()
        .unwrap();

        let mut prepared = make_town();
        prepared.prepare_classes([Size::Large]).unwrap();
        std::thread::spawn(move || {
            let identity = |town: &Town| {
                let geometry = &town.classes[&Size::Large];
                (
                    Arc::as_ptr(&geometry.basis.layout),
                    Arc::as_ptr(&geometry.basis.open),
                    geometry
                        .surfaces
                        .iter()
                        .map(|(&id, surface)| (id, surface as *const Surface))
                        .collect::<Vec<_>>(),
                )
            };
            let before = identity(&prepared);
            crate::commit::mark_clock_thread();
            prepared
                .prepare_classes([Size::Standard, Size::Large, Size::Large])
                .unwrap();
            assert_eq!(identity(&prepared), before);
            assert_eq!(prepared.classes.len(), 1);
            #[cfg(debug_assertions)]
            {
                let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    prepared.prepare_classes([Size::Giant])
                }))
                .expect_err("a genuinely missing class remains guarded on the clock");
                let message = panic
                    .downcast_ref::<&str>()
                    .copied()
                    .or_else(|| panic.downcast_ref::<String>().map(String::as_str));
                assert_eq!(
                    message,
                    Some("a rule check or route search ran on the clock thread")
                );
                assert!(prepared.surfaces_for(Size::Giant).is_none());
                assert_eq!(identity(&prepared), before);
            }
        })
        .join()
        .unwrap();
    }

    #[test]
    fn prepared_installations_keep_geometry_and_versions_independent() {
        let id = |n| Id::new(Scope([93; 16]), n).unwrap();
        let floor = id(1);
        let piece = Piece {
            outline: vec![vec![[0, 0, 0], [1000, 0, 0], [0, 0, 1000]]],
            vertices: vec![[0, 0, 0], [1000, 0, 0], [0, 0, 1000]],
            triangles: vec![[0, 1, 2]],
            ground: crate::gaits::Ground::Dry,
        };
        let building = Building {
            thing: id(2),
            links: vec![Link {
                id: id(3),
                kind: Kind::Step,
                nodes: [floor, id(4)],
                owner: id(2),
                width: 1_000_000,
                ends: [None, None],
                line: vec![Vec3::ZERO, Vec3::new(100_000, 0, 100_000)],
                door: None,
                blocked: None,
            }],
            floors: BTreeMap::from([(
                floor,
                (
                    0,
                    Patch {
                        radius: HUMAN_RADIUS,
                        pieces: vec![piece.clone()],
                        meets: Vec::new(),
                    },
                ),
            )]),
            place: Xform::IDENTITY,
            loose: Vec::new(),
        };
        let facts = testworld::generate(1, 0).unwrap();
        let imported = import_eden::load(&facts.text).unwrap();
        let root = imported.nodes["world"];
        let ground = imported.nodes["ground"];
        let header = import_eden::header(root, &imported.rules).unwrap();
        let next = imported.tree.to_state().next;
        let town = Town::new(
            imported.tree,
            ground,
            Doors::new(header, imported.rules, next),
        )
        .unwrap();
        let prepared = Rebuilt {
            after: town.basis(),
            before_layout: Arc::clone(&town.basis.layout),
            classes: BTreeMap::new(),
            touched: BTreeSet::from([floor]),
            versions: Versions::default(),
            fresh: Fresh::Buildings(vec![(
                building,
                BTreeMap::from([(floor, Surface::new(floor, vec![piece]))]),
            )]),
            why: None,
        };
        let (mut live, mut worker) = prepared.into_pair();
        live.versions.bump([&floor]);
        live.touched.clear();
        assert_eq!(worker.versions.of(floor), 0);
        assert!(worker.touched.contains(&floor));
        let Fresh::Buildings(live) = &mut live.fresh else {
            panic!("building install")
        };
        let Fresh::Buildings(worker) = &mut worker.fresh else {
            panic!("building install")
        };
        live[0].0.links[0].line.clear();
        live[0]
            .1
            .get_mut(&floor)
            .unwrap()
            .replace(&[0], Vec::new(), Vec::new());
        let frame = Frame {
            node: floor,
            slot: None,
        };
        let at = Vec3::new(100_000, 0, 100_000);
        assert!(
            live[0].1[&floor]
                .place(id(5), frame, at, Quat::IDENTITY)
                .is_err()
        );
        assert!(
            worker[0].1[&floor]
                .place(id(5), frame, at, Quat::IDENTITY)
                .is_ok()
        );
        assert_eq!(worker[0].0.links[0].line.len(), 2);
        worker[0].0.floors.clear();
        assert_eq!(
            live[0].0.floors[&floor].1.pieces[0].triangles,
            vec![[0, 1, 2]]
        );
    }
}

#[cfg(test)]
mod passage_tests {
    use super::*;
    use crate::ground::Patch;
    use crate::ground::scene::Xform;
    use crate::links::{End, Link};
    use replica::ids::Scope;

    fn id(n: u64) -> Id {
        Id::new(Scope([94; 16]), n).unwrap()
    }

    fn v(x: i64, y: i64, z: i64) -> Vec3 {
        Vec3::new(x, y, z)
    }

    fn link(
        n: u64,
        kind: Kind,
        nodes: [Id; 2],
        width: i64,
        ends: [End; 2],
        line: Vec<Vec3>,
    ) -> Link {
        Link {
            id: id(n),
            kind,
            nodes,
            owner: nodes[0],
            width,
            ends: [Some(ends[0]), Some(ends[1])],
            line,
            door: None,
            blocked: None,
        }
    }

    fn building(floors: &[(Id, i64)], links: Vec<Link>) -> Building {
        let patch = || Patch {
            radius: HUMAN_RADIUS,
            pieces: Vec::new(),
            meets: Vec::new(),
        };
        Building {
            thing: id(1),
            links,
            floors: floors.iter().map(|&(f, y)| (f, (y, patch()))).collect(),
            place: Xform::IDENTITY,
            loose: Vec::new(),
        }
    }

    fn end(floor: Id, x0: i64, x1: i64, y: i64, z: i64) -> End {
        End {
            floor,
            a: v(x0, y, z),
            b: v(x1, y, z),
        }
    }

    /// #4072 (the cottage e_989779ca's landing lamp): a flight 1 m wide rising 2.8 m along +z from a floor to a
    /// landing whose floor also reaches back over its foot. On the landing, 0.34 m in plan from the line where the
    /// flight is 0.1 to 0.6 m up, is no stair (it was: 0.34 m against 0.85 m); the flight's top on the landing, its
    /// foot on the floor below and the floor under it within a body's height still are.
    #[test]
    fn a_landing_over_a_stairs_foot_is_no_stair() {
        let (ground, f0, f1) = (id(2), id(3), id(4));
        let stair = link(
            5,
            Kind::Stairs,
            [f0, f1],
            1_000_000,
            [
                end(f0, -200_000, 200_000, 0, 0),
                end(f1, -200_000, 200_000, 2_800_000, 4_000_000),
            ],
            vec![v(0, 0, 0), v(0, 2_800_000, 4_000_000)],
        );
        let b = [building(&[(f0, 0), (f1, 2_800)], vec![stair])];
        let at = |node, p| in_passage(&b, &[], ground, node, p);
        assert!(
            !at(f1, v(340_000, 2_800_000, 500_000)),
            "the landing over the foot"
        );
        assert!(
            at(f1, v(340_000, 2_800_000, 3_900_000)),
            "the flight's top on the landing"
        );
        assert!(
            at(f1, v(0, 2_800_000, 4_500_000)),
            "within CLEAR of its top end"
        );
        assert!(
            at(f0, v(340_000, 0, 500_000)),
            "the flight's foot on the floor"
        );
        assert!(at(f0, v(0, 0, -600_000)), "within CLEAR of its foot end");
        // Under the flight: where it is 1.4 m up, a body standing there meets a body on it, so it is still a stair;
        // where it is 2.5 m up, over a standing body's height and more than half its width and half CLEAR in plan from
        // where it is 1.8 m up, it is not (whether a body may stand there is the floor's patch's to say, cut round the
        // flight's solids).
        assert!(
            at(f0, v(0, 0, 2_000_000)),
            "the floor under the flight's middle"
        );
        assert!(
            !at(f0, v(0, 0, 3_600_000)),
            "the floor under the flight's top"
        );
    }

    /// #4072 (the old-town arcade shops' bookshelves): a porch front 9 m wide steps down from the floor to the ground
    /// along z = 0, the shop's floor behind it at z < 0. A place 3 m inside the shop is no doorway (it was: within
    /// 4.85 m of the step's short line); the step's own band on the floor and on the ground still is, and a doorway's
    /// band keeps its width.
    #[test]
    fn a_wide_steps_doorway_is_its_own_edge() {
        let (ground, f0, f1) = (id(2), id(3), id(4));
        let step = link(
            5,
            Kind::Step,
            [f0, ground],
            9_000_000,
            [
                end(f0, -4_300_000, 4_300_000, 0, -300_000),
                end(ground, -4_300_000, 4_300_000, 0, 400_000),
            ],
            vec![v(0, 0, -300_000), v(0, 0, 400_000)],
        );
        let door = link(
            6,
            Kind::Doorway,
            [f0, f1],
            1_000_000,
            [
                end(f0, -200_000, 200_000, 0, -10_300_000),
                end(f1, -200_000, 200_000, 0, -9_700_000),
            ],
            vec![v(0, 0, -10_300_000), v(0, 0, -9_700_000)],
        );
        let b = [building(&[(f0, 0), (f1, 0)], vec![step, door])];
        let at = |node, p| in_passage(&b, &[], ground, node, p);
        assert!(
            !at(f0, v(-2_000_000, 0, -3_000_000)),
            "the shop behind the porch"
        );
        assert!(
            !at(f0, v(0, 0, -1_200_000)),
            "behind the step's line, past its band"
        );
        assert!(
            at(f0, v(-2_000_000, 0, -800_000)),
            "the step's band on the floor"
        );
        assert!(
            at(f0, v(4_400_000, 0, -300_000)),
            "the step's band at its end"
        );
        assert!(
            at(ground, v(3_000_000, 0, 900_000)),
            "the step's band on the ground"
        );
        // A doorway's band: 0.8 m across its line keeps half its width and half CLEAR (0.85 m); 0.9 m is past it.
        assert!(
            at(f0, v(800_000, 0, -10_000_000)),
            "beside the doorway's line"
        );
        assert!(
            !at(f0, v(900_000, 0, -10_000_000)),
            "past the doorway's band"
        );
    }
}
