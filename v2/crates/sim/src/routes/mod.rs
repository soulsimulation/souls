//! Routes with ability masks (Engine v2 N5, #2653): how a body gets from here to there, as a chain of patches
//! (N3's walkable ground, `crate::ground`) and links (N4's doors, stairs and ladders, `crate::links`).
//!
//! - **The map.** Every piece of every patch a world holds for today's walking body: each floor of each building, in
//!   the building's frame, and each 16 m square of the open ground, in the ground's frame. A piece's portals are where
//!   a body leaves it: a link's end on it, or the stretch of a square's edge it shares with a piece of the next
//!   square (one portal for the whole stretch). A link joins the portals at its two ends, as N4 reads them
//!   ([`Building::read_on`], with the open ground): each end is a portal of the piece it lies on, and an end on the
//!   open ground one of each square it crosses. A doorway to the open ground is such a link, one end on the
//!   building's floor and the other on the ground's squares.
//! - **Coarse.** A search (A*, the heuristic the straight distance in the ground's frame) over portals: within a
//!   piece, from each portal to each other; across a link, from one end to the other, never straight back across
//!   the link just crossed. The distance between two portals of one piece is its line inside the piece (below),
//!   computed on first use and cached with the piece.
//! - **Fine.** Inside one piece, a search over its triangles and string pulling (the funnel), done as a walker
//!   enters it. A route carries the first piece's line; the rest is cut as the body goes. String pulling treats the
//!   body as a point, which is right here: the patch is the ground already shrunk by the body's radius.
//! - **Ability masks.** A link needs bits ([`HANDS`], [`CLIMB`], [`WADE`], [`SWIM`]) and a body has bits; a body
//!   uses a link only when it has every bit the link needs. A ladder needs hands and climb. A shut door needs hands
//!   besides, read from the door's field when the route is asked for (N4: open or shut is the door's, never the
//!   link's).
//! - **Water** (N11c, #3218). The open ground's water patches (N11b's wading ground and water, `OpenGround::cut_water`)
//!   are pieces of the map too, mapped after everything dry so a dry body's pieces, portals and links keep their
//!   numbers. Where two pieces of different grounds share a stretch of edge, a shore link joins them, its two ends that
//!   stretch: dry ground to wading ground a [`Kind::Wade`] (needs [`WADE`]), wading ground or dry ground to water a
//!   [`Kind::Swim`] (needs [`SWIM`]); wet pieces of one ground share plain portals. Crossing a shore costs the height
//!   between its ends. A body never comes to a shore whose move it lacks, so its search is the one it had before the
//!   water was mapped, and a route into water it may not use is refused by name (`link-needs-wade`,
//!   `link-needs-swim`); but any body may cross a shore out of the water, so none is stranded in it. [`Map::spot`]
//!   finds dry ground only; [`Map::spot_for`] the ground a body may stand on ([`may_stand`]). A start and goal on one
//!   piece are the line inside it, unless a body that may wade or swim has a shorter way out across a shore and back.
//! - **Versions.** A route carries the node, square and version of each patch it crosses, so a later reader can tell
//!   a route cut on a patch since rebuilt (G3, #2760). The tree keeps no per-node version yet, so the map is given
//!   one per node, as N3's cache is.
//! - **Replacing a building** (#3276). After an edit inside a building, [`Map::replace`] takes off the pieces of its
//!   floors and the portals of its links (on the open ground's pieces too) and puts on the building as read again;
//!   nothing else is cut or read. Piece and portal numbers are never reused, so a map replaced in place numbers its
//!   pieces differently from one built whole, and its routes are otherwise the same.
//! - **No route.** A named refusal, `no-route`, naming the link that failed and why: the first link this body
//!   cannot use on the route a body with every ability would take, or, when there is none either, of the links the
//!   search came to and could not use, the one whose far end is nearest the goal.
//!
//! - **Sizes** (B12, #2743). A map is built for one size class (`replica::kinds::sizes::Size`), its ground cut for
//!   that class's radius, and every route it gives carries the class. A link narrower than the class's body with its
//!   clearance (twice the radius plus [`MARGIN`]) is `link-too-narrow` whatever else stops it, and a body refused
//!   there is told the link, its door and both widths. A floater routes as a walker of its class.
//!
//! Not here: re-routing on edits (G3), other walkers as cost, who may pass (F6), a gait's speed as cost (a route is
//! the shortest, not the quickest), walking a shore link (the walk skill crosses tree links and steps only). Ground
//! cover (Eden's footpaths, lawns, shores and piers) needs nothing here: N3 cuts it as open ground.

// The repeat rule (K12, v2/clippy.toml): the distance and patch maps are lookups on the search's hot path, never
// iterated, so their order reaches no route.
#![allow(clippy::disallowed_types)]

pub mod way;

use crate::gaits::Ground;
use crate::ground::scene::Xform;
use crate::ground::scene::{FLOOR, xform_to};
use crate::ground::sizes::too_narrow;
use crate::ground::{MARGIN, OpenGround, Piece, SQUARE};
use crate::links::{Building, End, F_OPEN, Kind, Link, Open, floor_joins, ground_doors, shore_id};
use replica::effects::Refusal;
use replica::encode::Value;
use replica::ids::Id;
use replica::kinds::sizes::Size;
use replica::pose::Vec3;
use replica::tree::Tree;
use replica::world_model::{plain, show};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap};

/// What a body has, and what a link needs: one bit each.
pub type Mask = u8;
pub const HANDS: Mask = 1;
pub const CLIMB: Mask = 2;
pub const WADE: Mask = 4;
pub const SWIM: Mask = 8;
/// Every ability.
pub const ALL: Mask = HANDS | CLIMB | WADE | SWIM;

/// Each bit's refusal when a body lacks it, in the order they are checked.
const LACKS: [(Mask, &str); 4] = [
    (HANDS, "link-needs-hands"),
    (CLIMB, "link-needs-climb"),
    (WADE, "link-needs-wade"),
    (SWIM, "link-needs-swim"),
];

/// What a link's move needs of a body (a shut door needs hands besides).
pub fn needs(kind: Kind) -> Mask {
    match kind {
        Kind::Ladder => HANDS | CLIMB,
        Kind::Doorway | Kind::Stairs | Kind::Ramp | Kind::Step | Kind::Boarding => 0,
        Kind::Wade => WADE,
        Kind::Swim => SWIM,
    }
}

/// Whether a body with abilities `has` may stand on `ground`: dry ground always, wading ground with wading, water with
/// swimming.
pub fn may_stand(ground: Ground, has: Mask) -> bool {
    match ground {
        Ground::Dry => true,
        Ground::Wading => has & WADE != 0,
        Ground::Water => has & SWIM != 0,
    }
}

/// How far two edges may lie apart and still be one shore, mm (the grid's rounding).
const SHORE_OFF: i64 = 2;
/// The shortest stretch of edge two pieces share that is a portal or a shore, mm.
const SHORE_MIN: i64 = 10;

/// A patch by its node and, on the open ground, its square.
type PatchKey = (Id, Option<(i32, i32)>);
/// A stretch of a square's edge a piece lies along: from, to (mm), the square, the piece.
type Stretch = (i64, i64, (i32, i32), u32);
/// A link a search came to and could not use: the link, why, and how near its far end is to the goal (mm).
type Failed = (u32, &'static str, i64);

/// How far a doorway's end may lie off a piece and still be its portal, mm: the grid's rounding, and a modelled floor
/// that stops short of its wall's inner face (the Mars campus's Mimos: its end lies 50 mm off the floor).
const MEET_OFF: i64 = 60;

const NONE: u32 = u32::MAX;
/// In a search's `via`: reached across a link (its index below this bit), not across a piece.
const LINK: u32 = 1 << 31;

/// A patch as a route carries it: its node, the open ground's square when it is one, and the version it was cut at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PatchAt {
    pub node: Id,
    pub square: Option<(i32, i32)>,
    pub version: u64,
}

#[derive(Clone)]
struct PieceRec {
    at: PatchAt,
    frame: u32,
    piece: Piece,
    /// The water a wet piece of the open ground is of (its index in the scene's waters).
    water: Option<u32>,
    portals: Vec<u32>,
    /// Per triangle (counter-clockwise), the triangle across each edge `k` (vertex `k` to `k + 1`), or `NONE`.
    adj: Option<Vec<[u32; 3]>>,
    /// Per triangle, its box (x min, z min, x max, z max, mm, the piece's frame): [`Map::locate`] and [`Map::gap`] skip
    /// a triangle whose box `p` is not in or near (S7, [`bounds_of`]).
    bounds: Vec<[i64; 4]>,
    /// Portal to portal, the line's length inside this piece, mm: filled on first use.
    dist: HashMap<(u32, u32), u32>,
}

/// Where a body leaves a piece: a segment (mm, x and z in the piece's frame) on one piece, or on two (a square's
/// edge, both in the ground's frame), or a link's end.
#[derive(Clone)]
struct Portal {
    pieces: [u32; 2],
    a: [i64; 2],
    b: [i64; 2],
    /// Its middle in the ground's frame, mm.
    world: [i64; 3],
    link: u32,
    side: u8,
}

impl Portal {
    fn mid(&self) -> [i64; 2] {
        [(self.a[0] + self.b[0]) / 2, (self.a[1] + self.b[1]) / 2]
    }
}

#[derive(Clone)]
struct LinkRec {
    id: Id,
    kind: Kind,
    door: Option<Id>,
    blocked: Option<&'static str>,
    /// The doorway's or the flight's width, µm (0 when not known).
    width: i64,
    /// The portals at each end.
    ends: [Vec<u32>; 2],
    /// Crossing it, mm.
    cost: u32,
    /// Replaced with its building ([`Map::replace`]): no portals, never read.
    gone: bool,
}

/// What of the map a building put there: its floors, its links, and its ends that lie on no piece.
#[derive(Clone, Default)]
struct Owned {
    floors: Vec<Id>,
    links: Vec<u32>,
    elsewhere: usize,
}

/// A link of the map as a reader sees it.
#[derive(Clone, Copy, Debug)]
pub struct LinkInfo {
    pub id: Id,
    pub kind: Kind,
    /// A door stands in it.
    pub door: bool,
    /// Why it cannot be crossed, if it cannot.
    pub blocked: Option<&'static str>,
    /// How many portals each end has.
    pub ends: [usize; 2],
    /// The piece each end's first portal lies on.
    pub pieces: [Option<u32>; 2],
}

/// Where a body stands: a piece of the map and a point on it (mm, the piece's frame).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spot {
    pub piece: u32,
    pub at: [i64; 3],
}

/// One step of a route: across a piece of a patch, or across a link by its move.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hop {
    Patch { at: PatchAt, piece: u32 },
    Link { id: Id, kind: Kind },
}

/// A route: the chain of patches and links, the first piece's line, and what the search cost.
#[derive(Clone, Debug)]
pub struct Route {
    /// The size class it was cut for.
    pub size: Size,
    pub hops: Vec<Hop>,
    /// The first piece's line, from the start to where the body leaves it (or the goal), mm in its frame.
    pub first_line: Vec<[i64; 2]>,
    /// The portals crossed, each one's middle in the ground's frame, mm, from start to goal.
    pub waypoints: Vec<[i64; 3]>,
    /// Its length by the coarse search, mm.
    pub length: u64,
    /// Portals taken from the search's queue.
    pub searched: u32,
}

impl Route {
    /// Each patch the route crosses, with its version, in order.
    pub fn patches(&self) -> Vec<PatchAt> {
        self.hops
            .iter()
            .filter_map(|h| match h {
                Hop::Patch { at, .. } => Some(*at),
                Hop::Link { .. } => None,
            })
            .collect()
    }
}

/// The map of a world's walkable ground and links for one size class.
#[derive(Clone)]
pub struct Map {
    /// The size class its ground is cut for.
    pub size: Size,
    frames: Vec<Xform>,
    pieces: Vec<PieceRec>,
    portals: Vec<Portal>,
    links: Vec<LinkRec>,
    by_patch: HashMap<PatchKey, Vec<u32>>,
    /// Each building read, by its thing: what it put on the map.
    owned: HashMap<Id, Owned>,
    /// Buildings whose links could not be read, with why.
    pub unread: Vec<(Id, String)>,
    /// Doorway ends (or, on the open ground, an end's part in one square) that lie on no piece (left out).
    pub meets_elsewhere: usize,
    /// The map's own scratch, for its `&mut self` searches ([`Map::route`]).
    scratch: Scratch,
    /// Each piece's part for a body with hands ([`Map::parts`]), found on first need and dropped when the map changes
    /// ([`Map::replace`], [`Map::replace_squares`]): [`Map::may_reach`] (#4072).
    hands_parts: std::sync::OnceLock<Vec<u32>>,
}

/// What a search writes as it goes (N17b, #3255): its working state, and the lines it measured that the map had not
/// cached yet. One per thread, so searches on several threads share one map read-only ([`Map::route_in`]); what a
/// scratch found joins the map's caches by [`Map::keep`]. A cached value is the same however it was found (a piece's
/// triangles' neighbours; the line between two portals, measured from the lower-numbered one), so which thread found
/// it first changes no route.
#[derive(Clone, Default)]
pub struct Scratch {
    /// Per portal: (search stamp, cost so far, previous portal, how it was reached).
    seen: Vec<(u32, u32, u32, u32)>,
    /// Per portal: the stamp of the search that last took it from the queue.
    closed: Vec<u32>,
    stamp: u32,
    /// Pieces whose triangles' neighbours this scratch found, not yet kept by the map.
    adj: HashMap<u32, Vec<[u32; 3]>>,
    /// Lines between portals of a piece this scratch measured, not yet kept: (piece, lower portal, higher portal).
    dist: HashMap<(u32, u32, u32), u32>,
}

impl Scratch {
    /// Sized for a map of `portals` portals (and the goal).
    fn fit(&mut self, portals: usize) {
        if self.seen.len() != portals + 1 {
            self.seen = vec![(0, 0, NONE, NONE); portals + 1];
            self.closed = vec![0; portals + 1];
            self.stamp = 0;
        }
    }
}

fn sq(v: i64) -> i64 {
    v * v
}

fn len2(a: [i64; 2], b: [i64; 2]) -> i64 {
    (sq(b[0] - a[0]) + sq(b[1] - a[1])).isqrt()
}

fn len3(a: [i64; 3], b: [i64; 3]) -> i64 {
    (sq(b[0] - a[0]) + sq(b[1] - a[1]) + sq(b[2] - a[2])).isqrt()
}

fn mm(um: i64) -> i64 {
    (um + 500 * um.signum()) / 1000
}

fn cross(o: [i64; 2], a: [i64; 2], b: [i64; 2]) -> i64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// The part of the segment `a`–`b` inside the box `[x0, z0, x1, z1]` (mm), if any: Liang–Barsky, its bounds kept
/// as exact fractions.
pub(crate) fn clip(a: [i64; 2], b: [i64; 2], w: [i64; 4]) -> Option<([i64; 2], [i64; 2])> {
    let d = [b[0] - a[0], b[1] - a[1]];
    let (mut lo, mut hi) = ((0i128, 1i128), (1i128, 1i128));
    for (p, q) in [
        (-d[0], a[0] - w[0]),
        (d[0], w[2] - a[0]),
        (-d[1], a[1] - w[1]),
        (d[1], w[3] - a[1]),
    ] {
        // Along the segment, p·t ≤ q.
        let (p, q) = (i128::from(p), i128::from(q));
        if p == 0 {
            if q < 0 {
                return None;
            }
        } else if p < 0 {
            if (-q) * lo.1 > lo.0 * (-p) {
                lo = (-q, -p);
            }
        } else if q * hi.1 < hi.0 * p {
            hi = (q, p);
        }
    }
    if lo.0 * hi.1 > hi.0 * lo.1 {
        return None;
    }
    let at = |t: (i128, i128)| {
        [
            a[0] + (i128::from(d[0]) * t.0 / t.1) as i64,
            a[1] + (i128::from(d[1]) * t.0 / t.1) as i64,
        ]
    };
    Some((at(lo), at(hi)))
}

/// A piece's outline edges, x and z, mm.
fn edges(pc: &Piece) -> Vec<([i64; 2], [i64; 2])> {
    pc.outline
        .iter()
        .flat_map(|r| {
            (0..r.len()).map(move |k| {
                let (a, b) = (r[k], r[(k + 1) % r.len()]);
                (
                    [i64::from(a[0]), i64::from(a[2])],
                    [i64::from(b[0]), i64::from(b[2])],
                )
            })
        })
        .collect()
}

fn wetness(g: Ground) -> u8 {
    match g {
        Ground::Dry => 0,
        Ground::Wading => 1,
        Ground::Water => 2,
    }
}

/// A shore link's number (`crate::links::shore_id`) from its move and the stretch of edge it crosses (G3b, #3449):
/// the same wherever the map is built from, whole or a square at a time. 52 bits of a hash; a stretch is shared by
/// two pieces only, so no two shores of one ground have the same.
fn shore_n(kind: Kind, s0: [i64; 2], s1: [i64; 2]) -> u64 {
    let mut input = b"souls:shore-at\0".to_vec();
    input.push(u8::from(kind == Kind::Swim));
    for v in [s0[0], s0[1], s1[0], s1[1]] {
        input.extend_from_slice(&v.to_be_bytes());
    }
    let h = replica::ids::sha256(&input);
    u64::from_be_bytes([0, 0, h[0], h[1], h[2], h[3], h[4], h[5]]) & ((1 << 52) - 1)
}

/// Why link `l` with the portals `ends` cannot be crossed by a body of `radius` mm, if it cannot: walked through
/// narrower than the body with its clearance, whatever else stops it (a ladder is climbed facing it, so its width is
/// not the body's), then the link's own reason, then an end on no ground.
fn blocked_by(l: &Link, ends: &[Vec<u32>; 2], radius: i64) -> Option<&'static str> {
    let narrow = l.kind != Kind::Ladder && too_narrow(l.width, radius);
    narrow
        .then_some("link-too-narrow")
        .or(l.blocked)
        .or(if ends.iter().any(Vec::is_empty) {
            Some("link-end-off-ground")
        } else {
            None
        })
}

/// Each stretch of piece `id`'s outline along an edge of its square `sq` (mm), by line: (true for x = c, c).
fn stretches(pc: &Piece, sq: (i32, i32), id: u32, lines: &mut BTreeMap<(bool, i64), Vec<Stretch>>) {
    let (x0, z0) = (i64::from(sq.0) * SQUARE, i64::from(sq.1) * SQUARE);
    let (x1, z1) = (x0 + SQUARE, z0 + SQUARE);
    for ring in &pc.outline {
        for e in 0..ring.len() {
            let (a, b) = (ring[e], ring[(e + 1) % ring.len()]);
            let (ax, az, bx, bz) = (
                i64::from(a[0]),
                i64::from(a[2]),
                i64::from(b[0]),
                i64::from(b[2]),
            );
            if ax == bx && az != bz && (ax == x0 || ax == x1) {
                lines
                    .entry((true, ax))
                    .or_default()
                    .push((az.min(bz), az.max(bz), sq, id));
            } else if az == bz && ax != bx && (az == z0 || az == z1) {
                lines
                    .entry((false, az))
                    .or_default()
                    .push((ax.min(bx), ax.max(bx), sq, id));
            }
        }
    }
}

/// What [`Map::build_cut`] gives: the map, the buildings it read (the open ground's gates last), before their floors
/// were joined, and those joins.
pub type Cut = (Map, Vec<Building>, Vec<(usize, Link)>);

impl Map {
    /// The map of everything on the open ground `ground`: its squares, and every building on it with its floors and
    /// links. `version` gives each node's version (a floor's, or the open ground's for all its squares). For today's
    /// walking body, the standard size class.
    pub fn build(tree: &Tree, ground: Id, version: &dyn Fn(Id) -> u64) -> Result<Map, String> {
        Map::build_for(tree, ground, Size::Standard, version)
    }

    /// As [`Map::build`], for a body of the size class `size`.
    pub fn build_for(
        tree: &Tree,
        ground: Id,
        size: Size,
        version: &dyn Fn(Id) -> u64,
    ) -> Result<Map, String> {
        let open = OpenGround::of(tree, ground, size.radius_mm())?;
        let cuts = open.cut_all(1);
        Ok(Map::build_cut(tree, ground, size, version, &open, &cuts, 1)?.0)
    }

    /// As [`Map::build_for`], on the open ground `open_ground` already cut into `cuts` (in its squares' order), and
    /// with the buildings it read, before their floors were joined, the open ground's gates last, and the joins found
    /// between their floors ([`floor_joins`]) (S5: the town assembles from the same cut, reads and joins).
    pub fn build_cut(
        tree: &Tree,
        ground: Id,
        size: Size,
        version: &dyn Fn(Id) -> u64,
        open_ground: &OpenGround,
        cuts: &[((i32, i32), crate::ground::Patch)],
        threads: usize,
    ) -> Result<Cut, String> {
        let radius = size.radius_mm();
        let gh = tree.handle(ground).ok_or("no such ground")?;
        let mut m = Map {
            size,
            frames: vec![Xform::IDENTITY],
            pieces: Vec::new(),
            portals: Vec::new(),
            links: Vec::new(),
            by_patch: HashMap::new(),
            owned: HashMap::new(),
            unread: Vec::new(),
            meets_elsewhere: 0,
            scratch: Scratch::default(),
            hands_parts: std::sync::OnceLock::new(),
        };
        let mut ground_meets = Vec::new();
        // The open ground, square by square, and each piece's stretches along its square's edges.
        let open = open_ground;
        let gv = version(ground);
        // Edge stretches by line: (true for x = c, c) → (lo, hi, square, piece).
        let mut lines: BTreeMap<(bool, i64), Vec<Stretch>> = BTreeMap::new();
        for ((i, j), p) in cuts {
            let (i, j) = (*i, *j);
            let p = p.clone();
            let at = PatchAt {
                node: ground,
                square: Some((i, j)),
                version: gv,
            };
            let first = m.pieces.len() as u32;
            for (k, pc) in p.pieces.iter().enumerate() {
                stretches(pc, (i, j), first + k as u32, &mut lines);
            }
            ground_meets.extend(p.meets.into_iter().map(|mt| ((i, j), mt)));
            m.add_patch(at, 0, p.pieces);
        }
        // Shared stretches of neighbouring squares' pieces.
        for ((vertical, c), list) in &lines {
            for (u, s) in list.iter().enumerate() {
                for t in &list[u + 1..] {
                    if s.2 == t.2 {
                        continue;
                    }
                    let (lo, hi) = (s.0.max(t.0), s.1.min(t.1));
                    if hi <= lo {
                        continue;
                    }
                    let pt = |v: i64| if *vertical { [*c, v] } else { [v, *c] };
                    m.add_portal([s.3, t.3], pt(lo), pt(hi), NONE, 0);
                }
            }
        }
        // Each building: its floors, in its frame, and its stairs and ladders.
        let mut things = Vec::new();
        let mut stack = vec![gh];
        while let Some(h) = stack.pop() {
            let kids = tree.children(h).ok_or("a node that is gone")?;
            if kids.iter().any(|&c| {
                tree.node(c)
                    .is_some_and(|n| plain(n.kind().as_str()) == FLOOR)
            }) {
                things.push(h);
            }
            stack.extend(kids.iter().rev().copied());
        }
        let gdoors = ground_doors(tree, ground)?;
        let mut known = BTreeSet::new();
        let mut buildings = Vec::new();
        // Each building read on its own, on at most `threads` threads (S5; one but at a world's start): a read sees only the tree and
        // the open ground's squares, which no floor changes, so reading them all first and putting their floors on in
        // order gives what reading and putting on one by one gave.
        let mut placed = Vec::with_capacity(things.len());
        for h in things {
            let id = tree.node(h).ok_or("a node that is gone")?.id();
            placed.push((id, xform_to(tree, h, gh)?));
        }
        let reads = {
            let m = &m;
            let read = |&(id, place): &(Id, Xform)| {
                let on = |sq: (i32, i32), p: [i64; 2]| m.on_square(ground, sq, p);
                let open = Open {
                    ground,
                    place,
                    meets: &ground_meets,
                    on: &on,
                    doors: &gdoors,
                    terrain: open.terrain(),
                };
                Building::read_sized(tree, id, Some(open), radius)
            };
            let threads = crate::ground::fan_out(threads, placed.len());
            let chunk = placed.len().div_ceil(threads).max(1);
            std::thread::scope(|s| {
                let parts: Vec<_> = placed
                    .chunks(chunk)
                    .map(|c| s.spawn(move || c.iter().map(read).collect::<Vec<_>>()))
                    .collect();
                parts
                    .into_iter()
                    .flat_map(|h| h.join().unwrap_or_else(|e| std::panic::resume_unwind(e)))
                    .collect::<Vec<_>>()
            })
        };
        for ((id, place), b) in placed.into_iter().zip(reads) {
            let b = match b {
                Ok(b) => b,
                Err(e) => {
                    m.unread.push((id, e));
                    continue;
                }
            };
            known.extend(b.links.iter().map(|l| l.id));
            let base = m.add_floors(&b, place, version);
            buildings.push((b, base));
        }
        // The open ground's own links (gates in walls and fences), then every link's ends as portals.
        let on = |sq: (i32, i32), p: [i64; 2]| m.on_square(ground, sq, p);
        let open = Open {
            ground,
            place: Xform::IDENTITY,
            meets: &ground_meets,
            on: &on,
            doors: &gdoors,
            terrain: open.terrain(),
        };
        let gates = Building::of_ground(tree, open, &known)?;
        buildings.push((gates, HashMap::new()));
        // What was read, before the joins: the town's own list (S5), which it joins itself.
        let read: Vec<Building> = buildings.iter().map(|(b, _)| b.clone()).collect();
        // Steps from one thing's floor onto another's (#3227), and every floor's first piece and piece count.
        let joins = floor_joins(&buildings.iter().map(|(b, _)| b).collect::<Vec<_>>());
        for (i, l) in joins.iter().cloned() {
            buildings[i].0.join(l);
        }
        let all: HashMap<Id, (u32, u32)> = buildings
            .iter()
            .flat_map(|(_, base)| base.clone())
            .collect();
        for (b, _) in &buildings {
            m.add_links(b, &all);
        }
        m.add_water(open_ground, ground, gv, threads);
        // The open ground's gates are kept as a building of the ground's own, replaced when a square cut again
        // changes their meets (G3b, #3449).
        m.scratch.fit(m.portals.len());
        Ok((m, read, joins))
    }

    /// Replaces building `b`'s floors and links with those it was read with again after an edit (G3, #3276): the
    /// pieces of its old floors and the portals of its old links leave the map (the open ground's pieces keep only
    /// their other portals), and its floors and links as read now are put on, `version` giving each floor's version.
    /// Nothing else is read or cut again. A building first read here is put on the same way.
    pub fn replace(&mut self, b: &Building, version: &dyn Fn(Id) -> u64) {
        self.hands_parts = std::sync::OnceLock::new();
        if let Some(old) = self.owned.remove(&b.thing) {
            for f in &old.floors {
                for q in self.by_patch.remove(&(*f, None)).unwrap_or_default() {
                    let rec = &mut self.pieces[q as usize];
                    let portals = std::mem::take(&mut rec.portals);
                    rec.piece = Piece {
                        outline: Vec::new(),
                        vertices: Vec::new(),
                        triangles: Vec::new(),
                        ground: Ground::Dry,
                    };
                    rec.adj = None;
                    rec.bounds = Vec::new();
                    rec.dist = HashMap::new();
                    for p in portals {
                        self.drop_portal(p);
                    }
                }
            }
            for l in old.links {
                let rec = &mut self.links[l as usize];
                rec.gone = true;
                rec.blocked = Some("link-gone");
                let ends = std::mem::take(&mut rec.ends);
                for p in ends.into_iter().flatten() {
                    self.drop_portal(p);
                }
            }
            self.meets_elsewhere -= old.elsewhere;
        }
        self.unread.retain(|(id, _)| *id != b.thing);
        let base = self.add_floors(b, b.place, version);
        self.add_links(b, &base);
        self.scratch.fit(self.portals.len());
    }

    /// The dry pieces of the open ground's square `sq`.
    fn dry_of(&self, ground: Id, sq: (i32, i32)) -> Vec<u32> {
        self.by_patch
            .get(&(ground, Some(sq)))
            .map(|v| {
                v.iter()
                    .copied()
                    .filter(|&q| self.pieces[q as usize].water.is_none())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether [`Map::replace_squares`] can replace the squares `squares`: refused when a link with an end on a dry
    /// piece of one is not given by `link_of` (a shore is the map's own). Else each such link's end (its index and
    /// side), with the link.
    pub fn check_squares(
        &self,
        ground: Id,
        squares: &[(i32, i32)],
        link_of: &dyn Fn(Id) -> Option<Link>,
    ) -> Result<BTreeMap<(u32, u8), Link>, String> {
        let mut again: BTreeMap<(u32, u8), Link> = BTreeMap::new();
        for &sq in squares {
            for q in self.dry_of(ground, sq) {
                for &p in &self.pieces[q as usize].portals {
                    let por = &self.portals[p as usize];
                    if por.link == NONE {
                        continue;
                    }
                    let rec = &self.links[por.link as usize];
                    let shore = matches!(rec.kind, Kind::Wade | Kind::Swim);
                    if shore || rec.gone || again.contains_key(&(por.link, por.side)) {
                        continue;
                    }
                    let l = link_of(rec.id).ok_or("a link with an end on a square cut again")?;
                    again.insert((por.link, por.side), l);
                }
            }
        }
        Ok(again)
    }

    /// Replaces the dry pieces of the open ground's squares `squares` with those they were cut again with after a
    /// change (G3b, #3449): the old pieces and their portals leave the map, the new ones are put on and joined to
    /// their neighbours' pieces along the squares' edges, every link with an end on an old piece has that end's
    /// portals found again on the new ones (`link_of` gives the link as its building was read), and the old pieces'
    /// shores are replaced by the new pieces' (numbered by where they are, as a whole build numbers them). A square's
    /// water pieces are kept: they are cut from the waters and the ground cover only. Every square of the ground
    /// takes `version`. Refused, changing nothing, when a link with an end on an old piece is not given.
    pub fn replace_squares(
        &mut self,
        ground: Id,
        version: u64,
        squares: Vec<((i32, i32), Vec<Piece>)>,
        link_of: &dyn Fn(Id) -> Option<Link>,
    ) -> Result<(), String> {
        self.hands_parts = std::sync::OnceLock::new();
        let set: BTreeSet<(i32, i32)> = squares.iter().map(|(sq, _)| *sq).collect();
        let keys: Vec<(i32, i32)> = set.iter().copied().collect();
        let again = self.check_squares(ground, &keys, link_of)?;
        let dry_of = |m: &Map, sq: (i32, i32)| m.dry_of(ground, sq);
        let mut lines: BTreeMap<(bool, i64), Vec<Stretch>> = BTreeMap::new();
        let mut fresh = Vec::new();
        for (sq, pieces) in squares {
            let old = dry_of(self, sq);
            for &q in &old {
                let rec = &mut self.pieces[q as usize];
                let portals = std::mem::take(&mut rec.portals);
                rec.piece = Piece {
                    outline: Vec::new(),
                    vertices: Vec::new(),
                    triangles: Vec::new(),
                    ground: Ground::Dry,
                };
                rec.bounds = Vec::new();
                rec.adj = None;
                rec.dist = HashMap::new();
                for p in portals {
                    let li = self.portals[p as usize].link;
                    if li != NONE && matches!(self.links[li as usize].kind, Kind::Wade | Kind::Swim)
                    {
                        let rec = &mut self.links[li as usize];
                        rec.gone = true;
                        rec.blocked = Some("link-gone");
                        for e in std::mem::take(&mut rec.ends).into_iter().flatten() {
                            self.drop_portal(e);
                        }
                    }
                    self.drop_portal(p);
                }
            }
            if let Some(v) = self.by_patch.get_mut(&(ground, Some(sq))) {
                v.retain(|q| !old.contains(q));
            }
            let first = self.pieces.len() as u32;
            for (k, pc) in pieces.iter().enumerate() {
                stretches(pc, sq, first + k as u32, &mut lines);
                fresh.push((sq, first + k as u32));
            }
            let at = PatchAt {
                node: ground,
                square: Some(sq),
                version,
            };
            self.add_patch(at, 0, pieces);
        }
        // The pieces of the squares beside them, kept.
        for &(i, j) in &set {
            for n in [(i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)] {
                if set.contains(&n) {
                    continue;
                }
                for q in dry_of(self, n) {
                    stretches(&self.pieces[q as usize].piece, n, q, &mut lines);
                }
            }
        }
        for ((vertical, c), list) in &lines {
            for (u, s) in list.iter().enumerate() {
                for t in &list[u + 1..] {
                    if s.2 == t.2 || !(set.contains(&s.2) || set.contains(&t.2)) {
                        continue;
                    }
                    let (lo, hi) = (s.0.max(t.0), s.1.min(t.1));
                    if hi <= lo {
                        continue;
                    }
                    let pt = |v: i64| if *vertical { [*c, v] } else { [v, *c] };
                    self.add_portal([s.3, t.3], pt(lo), pt(hi), NONE, 0);
                }
            }
        }
        // Each new piece's shores: across the edges it shares with the water pieces of its square and the four beside.
        for (sq, r) in fresh {
            let theirs = edges(&self.pieces[r as usize].piece);
            for (di, dj) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)] {
                let wet: Vec<u32> = self
                    .by_patch
                    .get(&(ground, Some((sq.0 + di, sq.1 + dj))))
                    .into_iter()
                    .flatten()
                    .copied()
                    .filter(|&q| self.pieces[q as usize].water.is_some())
                    .collect();
                for q in wet {
                    let mine = edges(&self.pieces[q as usize].piece);
                    let gq = self.pieces[q as usize].piece.ground;
                    for &(a, b) in &mine {
                        for &(c, d) in &theirs {
                            let Some((s0, s1)) = shared(a, b, c, d) else {
                                continue;
                            };
                            let kind = if wetness(gq) == 1 {
                                Kind::Wade
                            } else {
                                Kind::Swim
                            };
                            let li = self.links.len() as u32;
                            let p0 = self.add_portal([r, NONE], s0, s1, li, 0);
                            let p1 = self.add_portal([q, NONE], s0, s1, li, 1);
                            let dy = self.portals[p0 as usize].world[1]
                                - self.portals[p1 as usize].world[1];
                            self.links.push(LinkRec {
                                id: shore_id(ground, shore_n(kind, s0, s1)),
                                kind,
                                door: None,
                                blocked: None,
                                ends: [vec![p0], vec![p1]],
                                cost: dy.unsigned_abs() as u32,
                                width: 0,
                                gone: false,
                            });
                        }
                    }
                }
            }
        }
        let radius = self.size.radius_mm();
        let none = HashMap::new();
        for ((li, side), l) in again {
            let k = usize::from(side);
            let Some(e) = l.ends[k].as_ref() else {
                continue;
            };
            for p in std::mem::take(&mut self.links[li as usize].ends[k]) {
                self.drop_portal(p);
            }
            let ends = self.end_portals(li, &l, e, side, &none);
            let rec = &mut self.links[li as usize];
            rec.ends[k] = ends;
            rec.blocked = blocked_by(&l, &rec.ends, radius);
        }
        for rec in &mut self.pieces {
            if rec.at.node == ground && rec.at.square.is_some() {
                rec.at.version = version;
            }
        }
        self.scratch.fit(self.portals.len());
        Ok(())
    }

    /// Takes portal `p` off the pieces it lies on; its index is never used again.
    fn drop_portal(&mut self, p: u32) {
        let pieces = std::mem::replace(&mut self.portals[p as usize].pieces, [NONE, NONE]);
        self.portals[p as usize].link = NONE;
        for q in pieces {
            if q != NONE {
                self.pieces[q as usize].portals.retain(|&r| r != p);
            }
        }
    }

    /// Puts building `b`'s floors on the map in its frame `place`: each floor's first piece and piece count.
    fn add_floors(
        &mut self,
        b: &Building,
        place: Xform,
        version: &dyn Fn(Id) -> u64,
    ) -> HashMap<Id, (u32, u32)> {
        self.frames.push(place);
        let frame = (self.frames.len() - 1) as u32;
        let mut base: HashMap<Id, (u32, u32)> = HashMap::new();
        for (&floor, (_, patch)) in &b.floors {
            base.insert(floor, (self.pieces.len() as u32, patch.pieces.len() as u32));
            let at = PatchAt {
                node: floor,
                square: None,
                version: version(floor),
            };
            self.add_patch(at, frame, patch.pieces.clone());
        }
        let owned = self.owned.entry(b.thing).or_default();
        owned.floors = b.floors.keys().copied().collect();
        base
    }

    /// Puts building `b`'s links on the map, their ends as portals (`base`: each floor's first piece and piece count,
    /// of every building a link of `b` may reach).
    fn add_links(&mut self, b: &Building, base: &HashMap<Id, (u32, u32)>) {
        let (first, elsewhere) = (self.links.len() as u32, self.meets_elsewhere);
        let radius = self.size.radius_mm();
        for l in &b.links {
            let li = self.links.len() as u32;
            let mut ends = [Vec::new(), Vec::new()];
            // A blocked link's ends are portals too, so a search that comes to it can name it.
            for (k, e) in l.ends.iter().enumerate() {
                if let Some(e) = e {
                    ends[k] = self.end_portals(li, l, e, k as u8, base);
                }
            }
            let run: i64 = l
                .line
                .windows(2)
                .map(|w| len3([w[0].x, w[0].y, w[0].z], [w[1].x, w[1].y, w[1].z]))
                .sum::<i64>()
                / 1000;
            let blocked = blocked_by(l, &ends, radius);
            self.links.push(LinkRec {
                id: l.id,
                kind: l.kind,
                door: l.door,
                blocked,
                width: l.width,
                ends,
                cost: run as u32,
                gone: false,
            });
        }
        let owned = self.owned.entry(b.thing).or_default();
        owned.links = (first..self.links.len() as u32).collect();
        owned.elsewhere = self.meets_elsewhere - elsewhere;
    }

    fn add_patch(&mut self, at: PatchAt, frame: u32, pieces: Vec<Piece>) {
        let list = self.by_patch.entry((at.node, at.square)).or_default();
        for pc in pieces {
            list.push(self.pieces.len() as u32);
            self.pieces.push(PieceRec {
                at,
                frame,
                bounds: bounds_of(&pc),
                piece: pc,
                water: None,
                portals: Vec::new(),
                adj: None,
                dist: HashMap::new(),
            });
        }
    }

    /// The open ground's water patches (N11c, #3218), mapped after every dry piece, portal and link so that a dry
    /// body's keep their numbers: wet pieces of one ground that touch (across a square's edge, or where two waters
    /// meet) share a portal, and pieces of two grounds a shore link whose two ends are the stretch of edge they share.
    /// Dry ground and wading ground are joined by a [`Kind::Wade`]; wading ground, or dry ground, and swimming water
    /// by a [`Kind::Swim`]. End 0 is on the drier piece.
    fn add_water(&mut self, open: &OpenGround, ground: Id, version: u64, threads: usize) {
        let first_wet = self.pieces.len() as u32;
        // Cut on at most `threads` threads, put on in the squares' order (S5).
        for ((i, j), wet) in open.cut_all_water(threads) {
            let at = PatchAt {
                node: ground,
                square: Some((i, j)),
                version,
            };
            for (w, pc) in wet {
                let q = self.pieces.len() as u32;
                self.by_patch
                    .entry((ground, Some((i, j))))
                    .or_default()
                    .push(q);
                self.pieces.push(PieceRec {
                    at,
                    frame: 0,
                    bounds: bounds_of(&pc),
                    piece: pc,
                    water: Some(w),
                    portals: Vec::new(),
                    adj: None,
                    dist: HashMap::new(),
                });
            }
        }
        for q in first_wet..self.pieces.len() as u32 {
            let Some((i, j)) = self.pieces[q as usize].at.square else {
                continue;
            };
            let mine = edges(&self.pieces[q as usize].piece);
            let near: Vec<u32> = [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)]
                .iter()
                .filter_map(|(di, dj)| self.by_patch.get(&(ground, Some((i + di, j + dj)))))
                .flatten()
                .copied()
                // Each wet pair once; a dry piece from its wet side.
                .filter(|&r| r < first_wet || r > q)
                .collect();
            for r in near {
                let theirs = edges(&self.pieces[r as usize].piece);
                let (gq, gr) = (
                    self.pieces[q as usize].piece.ground,
                    self.pieces[r as usize].piece.ground,
                );
                for &(a, b) in &mine {
                    for &(c, d) in &theirs {
                        let Some((s0, s1)) = shared(a, b, c, d) else {
                            continue;
                        };
                        if gq == gr {
                            self.add_portal([q, r], s0, s1, NONE, 0);
                            continue;
                        }
                        let (lo, hi) = if wetness(gq) < wetness(gr) {
                            (q, r)
                        } else {
                            (r, q)
                        };
                        let kind = if wetness(gq).max(wetness(gr)) == 1 {
                            Kind::Wade
                        } else {
                            Kind::Swim
                        };
                        let li = self.links.len() as u32;
                        let p0 = self.add_portal([lo, NONE], s0, s1, li, 0);
                        let p1 = self.add_portal([hi, NONE], s0, s1, li, 1);
                        let dy =
                            self.portals[p0 as usize].world[1] - self.portals[p1 as usize].world[1];
                        self.links.push(LinkRec {
                            id: shore_id(ground, shore_n(kind, s0, s1)),
                            kind,
                            door: None,
                            blocked: None,
                            ends: [vec![p0], vec![p1]],
                            cost: dy.unsigned_abs() as u32,
                            // A shore is as wide as its stretch of edge: never too narrow (B12).
                            width: 0,
                            gone: false,
                        });
                    }
                }
            }
        }
    }

    /// The water a piece of the open ground is of, if it is wet (its index in the scene's waters).
    pub fn water_of(&self, piece: u32) -> Option<u32> {
        self.pieces[piece as usize].water
    }

    /// Whether a body with `has` may not take portal `r` onward: the drier end of a shore whose move it lacks. A body
    /// may always come out of the water, so it is never stranded in it; a body that may not go in never comes to the
    /// shore, so a dry body's search is as it was before the water was mapped.
    fn shore_shut(&self, r: u32, has: Mask) -> bool {
        let p = &self.portals[r as usize];
        p.link != NONE
            && p.side == 0
            && matches!(self.links[p.link as usize].kind, Kind::Wade | Kind::Swim)
            && needs(self.links[p.link as usize].kind) & !has != 0
    }

    /// Whether crossing link `l` from its end `side` comes out of the water: a shore crossed from its wetter end.
    fn ashore(&self, l: u32, side: u8) -> bool {
        side == 1 && matches!(self.links[l as usize].kind, Kind::Wade | Kind::Swim)
    }

    /// The portals of link `l`'s end `e` (its side `k`): on the floor's piece it lies on (a stair's or a ladder's end,
    /// carried onto the patch, inside one; a doorway's on its edge), or, on the open ground, on the piece of each
    /// square its part inside that square lies on.
    fn end_portals(
        &mut self,
        li: u32,
        l: &Link,
        e: &End,
        k: u8,
        base: &HashMap<Id, (u32, u32)>,
    ) -> Vec<u32> {
        let (a, b2, mid) = ([mm(e.a.x), mm(e.a.z)], [mm(e.b.x), mm(e.b.z)], e.middle());
        let y = mm(mid.y);
        let at_y = |m: &Map, q: u32| {
            m.pieces[q as usize]
                .piece
                .vertices
                .first()
                .is_some_and(|v| i64::from(v[1]) == y)
        };
        // The piece among `qs` the segment's middle lies on, within the grid's rounding.
        // The open ground is one level, its plan at 0, and an end on it stands on its terrain (#3227): any height.
        let on = |m: &Map, qs: &mut dyn Iterator<Item = u32>, mid: [i64; 2]| {
            qs.filter(|&q| m.pieces[q as usize].at.square.is_some() || at_y(m, q))
                .map(|q| (m.off_piece(q, mid), q))
                .min()
                .filter(|&(d, _)| d <= MEET_OFF)
                .map(|(_, q)| q)
        };
        let mut out = Vec::new();
        if let Some(&(first, n)) = base.get(&e.floor) {
            let q = if matches!(l.kind, Kind::Doorway | Kind::Step) {
                on(self, &mut (first..first + n), [mm(mid.x), mm(mid.z)])
            } else {
                (first..first + n).find(|&q| self.locate(q, [mm(mid.x), mm(mid.z)], y).is_some())
            };
            match q {
                Some(q) => out.push(self.add_portal([q, NONE], a, b2, li, k)),
                None if matches!(l.kind, Kind::Doorway | Kind::Step) => self.meets_elsewhere += 1,
                None => {}
            }
            return out;
        }
        // On the open ground: the end's part inside each square it crosses.
        let sq_of = |v: i64| v.div_euclid(SQUARE) as i32;
        for i in sq_of(a[0].min(b2[0]))..=sq_of(a[0].max(b2[0])) {
            for j in sq_of(a[1].min(b2[1]))..=sq_of(a[1].max(b2[1])) {
                let (x, z) = (i64::from(i) * SQUARE, i64::from(j) * SQUARE);
                let Some((pa, pb)) = clip(a, b2, [x, z, x + SQUARE, z + SQUARE]) else {
                    continue;
                };
                let Some(qs) = self.by_patch.get(&(e.floor, Some((i, j)))).cloned() else {
                    continue;
                };
                let m2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
                match on(self, &mut qs.into_iter(), m2) {
                    Some(q) => out.push(self.add_portal([q, NONE], pa, pb, li, k)),
                    None => self.meets_elsewhere += 1,
                }
            }
        }
        out
    }

    fn add_portal(
        &mut self,
        pieces: [u32; 2],
        a: [i64; 2],
        b: [i64; 2],
        link: u32,
        side: u8,
    ) -> u32 {
        let pc = &self.pieces[pieces[0] as usize];
        let y = pc.piece.vertices.first().map_or(0, |v| i64::from(v[1]));
        let mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        let w = self.frames[pc.frame as usize]
            .point(Vec3::new(mid[0] * 1000, y * 1000, mid[1] * 1000))
            .unwrap_or(Vec3::ZERO);
        let id = self.portals.len() as u32;
        self.portals.push(Portal {
            pieces,
            a,
            b,
            world: [mm(w.x), mm(w.y), mm(w.z)],
            link,
            side,
        });
        for q in pieces {
            if q != NONE {
                self.pieces[q as usize].portals.push(id);
            }
        }
        id
    }

    /// Whether the point `p` (mm, the ground's frame) lies on a piece of the open ground's square `sq`, within the
    /// grid's rounding: where a doorway's segment there is a portal.
    pub fn on_square(&self, ground: Id, sq: (i32, i32), p: [i64; 2]) -> bool {
        self.by_patch.get(&(ground, Some(sq))).is_some_and(|qs| {
            qs.iter()
                .any(|&q| self.dry(q) && self.off_piece(q, p) <= MEET_OFF)
        })
    }

    /// How many pieces, portals and links the map holds.
    pub fn counts(&self) -> (usize, usize, usize) {
        (self.pieces.len(), self.portals.len(), self.links.len())
    }

    /// The patch a piece belongs to.
    pub fn patch_of(&self, piece: u32) -> PatchAt {
        self.pieces[piece as usize].at
    }

    /// Each piece's part of the map for a body with `has`: pieces joined by a shared portal or by a link the body may
    /// use (a door counted as needing hands, as it may be shut), each part named by its smallest piece.
    pub fn parts(&self, has: Mask) -> Vec<u32> {
        let mut up: Vec<u32> = (0..self.pieces.len() as u32).collect();
        fn top(up: &mut [u32], mut k: u32) -> u32 {
            while up[k as usize] != k {
                up[k as usize] = up[up[k as usize] as usize];
                k = up[k as usize];
            }
            k
        }
        let mut join = |a: u32, b: u32| {
            let (a, b) = (top(&mut up, a), top(&mut up, b));
            up[a.max(b) as usize] = a.min(b);
        };
        for p in &self.portals {
            if p.pieces[1] != NONE {
                join(p.pieces[0], p.pieces[1]);
            }
        }
        for l in &self.links {
            let door = if l.door.is_some() { HANDS } else { 0 };
            if l.blocked.is_none() && (needs(l.kind) | door) & !has == 0 {
                for &a in &l.ends[0] {
                    for &b in &l.ends[1] {
                        join(
                            self.portals[a as usize].pieces[0],
                            self.portals[b as usize].pieces[0],
                        );
                    }
                }
            }
        }
        (0..self.pieces.len() as u32)
            .map(|k| top(&mut up, k))
            .collect()
    }

    /// Whether a body with hands may walk from piece `a` to piece `b`: false only when no portal or link it may use
    /// joins them, so no route search can find a way (#4072). One lookup once the map's parts are found (once after
    /// each change); a failed route search instead searches the whole part the walk starts in, twice.
    pub fn may_reach(&self, a: u32, b: u32) -> bool {
        let parts = self.hands_parts.get_or_init(|| self.parts(HANDS));
        parts.get(a as usize) == parts.get(b as usize)
    }

    /// Each link: its id, kind, whether a door stands in it, why it cannot be crossed if it cannot, and how many
    /// portals each end has.
    pub fn links(&self) -> Vec<LinkInfo> {
        self.links
            .iter()
            .filter(|l| !l.gone)
            .map(|l| LinkInfo {
                id: l.id,
                kind: l.kind,
                door: l.door.is_some(),
                blocked: l.blocked,
                ends: [l.ends[0].len(), l.ends[1].len()],
                pieces: [0, 1].map(|k| {
                    l.ends[k]
                        .first()
                        .map(|&p| self.portals[p as usize].pieces[0])
                }),
            })
            .collect()
    }

    /// The pieces the ends of each link lie on, both ends together, in [`Map::links`]' order (gone links left out).
    pub fn link_pieces(&self) -> Vec<Vec<u32>> {
        let pieces = |l: &LinkRec| {
            l.ends
                .iter()
                .flatten()
                .map(|&p| self.portals[p as usize].pieces[0])
                .collect()
        };
        self.links.iter().filter(|l| !l.gone).map(pieces).collect()
    }

    /// Whether the map holds a floor's patch for `node`.
    pub fn is_floor(&self, node: Id) -> bool {
        self.by_patch.contains_key(&(node, None))
    }

    /// A piece of the map.
    pub fn piece(&self, q: u32) -> &Piece {
        &self.pieces[q as usize].piece
    }

    /// A point of a piece (mm, its frame) in the ground's frame.
    pub fn world(&self, piece: u32, p: [i64; 3]) -> [i64; 3] {
        let w = self.frames[self.pieces[piece as usize].frame as usize]
            .point(Vec3::new(p[0] * 1000, p[1] * 1000, p[2] * 1000))
            .unwrap_or(Vec3::ZERO);
        [mm(w.x), mm(w.y), mm(w.z)]
    }

    /// The piece's triangles' middles (mm, its frame, with height): places a body may stand.
    pub fn standing(&self, piece: u32) -> Vec<[i64; 3]> {
        let pc = &self.pieces[piece as usize].piece;
        pc.triangles
            .iter()
            .map(|t| {
                let v = |k: usize| pc.vertices[t[k] as usize];
                let s = |c: usize| (0..3).map(|k| i64::from(v(k)[c])).sum::<i64>() / 3;
                [s(0), s(1), s(2)]
            })
            .collect()
    }

    fn dry(&self, q: u32) -> bool {
        self.pieces[q as usize].piece.ground == Ground::Dry
    }

    /// The spot at `at` (µm, the node's frame) on the patch of `node` (a floor, or the open ground's dry ground).
    pub fn spot(&self, node: Id, at: Vec3) -> Option<Spot> {
        self.spot_for(node, at, 0)
    }

    /// As [`Map::spot`], on ground a body with `has` may stand on: wading ground with wading, water with swimming.
    pub fn spot_for(&self, node: Id, at: Vec3, has: Mask) -> Option<Spot> {
        let p = [mm(at.x), mm(at.z)];
        let square = (
            p[0].div_euclid(SQUARE) as i32,
            p[1].div_euclid(SQUARE) as i32,
        );
        let list = self
            .by_patch
            .get(&(node, None))
            .or_else(|| self.by_patch.get(&(node, Some(square))))?;
        list.iter()
            .filter(|&&q| may_stand(self.pieces[q as usize].piece.ground, has))
            .filter_map(|&q| {
                let y = self.pieces[q as usize]
                    .piece
                    .vertices
                    .first()
                    .map(|v| i64::from(v[1]))?;
                self.locate(q, p, y)?;
                Some(((y - mm(at.y)).abs(), q, y))
            })
            .min()
            .map(|(_, q, y)| Spot {
                piece: q,
                at: [p[0], y, p[1]],
            })
    }

    /// As [`Map::spot`], or, for a point within `tol` mm of a piece of the patch at its height (a link's end on the
    /// piece's edge), the piece's nearest point.
    pub fn spot_near(&self, node: Id, at: Vec3, tol: i64) -> Option<Spot> {
        if let Some(s) = self.spot(node, at) {
            return Some(s);
        }
        let p = [mm(at.x), mm(at.z)];
        let square = (
            p[0].div_euclid(SQUARE) as i32,
            p[1].div_euclid(SQUARE) as i32,
        );
        let (list, open) = match self.by_patch.get(&(node, None)) {
            Some(l) => (l, false),
            None => (self.by_patch.get(&(node, Some(square)))?, true),
        };
        let y = mm(at.y);
        // The open ground is one level, its plan at 0; a body on it stands at the terrain's height (N11a, #2735).
        list.iter()
            .filter(|&&q| self.dry(q))
            .filter(|&&q| {
                open || self.pieces[q as usize]
                    .piece
                    .vertices
                    .first()
                    .is_some_and(|v| i64::from(v[1]) == y)
            })
            .map(|&q| {
                let (t, d2, mut near) = self.gap(q, p);
                // Rounded onto the grid, the nearest point of a slanted edge may lie just off the piece: it is taken
                // a millimetre at a time towards its triangle's middle until it stands on it.
                for _ in 0..3 {
                    if d2 == i64::MAX || self.locate(q, near, y).is_some() {
                        break;
                    }
                    let [a, b, c] = self.tri(q, t);
                    let m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
                    near = [
                        near[0] + (m[0] - near[0]).signum(),
                        near[1] + (m[1] - near[1]).signum(),
                    ];
                }
                (d2, q, near)
            })
            .min()
            .filter(|&(d2, ..)| d2 <= sq(tol))
            .map(|(_, q, near)| Spot {
                piece: q,
                at: [near[0], y, near[1]],
            })
    }

    fn vert(&self, q: u32, k: u32) -> [i64; 2] {
        vert(&self.pieces[q as usize].piece, k)
    }

    /// The triangle of piece `q` holding `p` (edges included), counter-clockwise.
    fn locate(&self, q: u32, p: [i64; 2], y: i64) -> Option<u32> {
        let rec = &self.pieces[q as usize];
        let pc = &rec.piece;
        if pc.vertices.first().is_none_or(|v| i64::from(v[1]) != y) {
            return None;
        }
        (0..pc.triangles.len() as u32).find(|&t| {
            // A triangle holds only points in its box (its edges included): the others are not tried (S7).
            if let Some(bx) = rec.bounds.get(t as usize)
                && (p[0] < bx[0] || p[1] < bx[1] || p[0] > bx[2] || p[1] > bx[3])
            {
                return false;
            }
            let [a, b, c] = self.tri(q, t);
            cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0
        })
    }

    /// How far the point `p` (mm, the piece's frame) lies off piece `q`, mm (0 on it).
    pub fn off_piece(&self, q: u32, p: [i64; 2]) -> i64 {
        self.gap(q, p).1.isqrt()
    }

    /// The triangle of piece `q` nearest `p`, the squared distance to it (0 inside), and its point nearest `p` (`p`
    /// itself inside).
    fn gap(&self, q: u32, p: [i64; 2]) -> (u32, i64, [i64; 2]) {
        let rec = &self.pieces[q as usize];
        gap_in(&rec.piece, &rec.bounds, p)
    }

    /// Triangle `t` of piece `q`, its corners counter-clockwise.
    fn tri(&self, q: u32, t: u32) -> [[i64; 2]; 3] {
        tri(&self.pieces[q as usize].piece, t)
    }

    fn tri_idx(&self, q: u32, t: u32) -> [u32; 3] {
        tri_idx(&self.pieces[q as usize].piece, t)
    }

    /// Piece `q`'s triangles' neighbours, built on first use: from the map's cache, else `s`'s.
    fn adjacency<'m>(&'m self, s: &'m mut Scratch, q: u32) -> &'m [[u32; 3]] {
        if let Some(a) = &self.pieces[q as usize].adj {
            return a;
        }
        s.adj.entry(q).or_insert_with(|| {
            let n = self.pieces[q as usize].piece.triangles.len() as u32;
            let mut edges: HashMap<(u32, u32), (u32, usize)> =
                HashMap::with_capacity(n as usize * 3);
            let mut adj = vec![[NONE; 3]; n as usize];
            for t in 0..n {
                let v = self.tri_idx(q, t);
                for k in 0..3 {
                    let (a, b) = (v[k], v[(k + 1) % 3]);
                    if let Some((u, e)) = edges.remove(&(b, a)) {
                        adj[t as usize][k] = u;
                        adj[u as usize][e] = t;
                    } else {
                        edges.insert((a, b), (t, k));
                    }
                }
            }
            adj
        })
    }

    /// The line inside piece `q` from `s` to `t` (mm, its frame): a search over its triangles, then string pulling.
    /// An end off the piece (a doorway's meet may lie a few millimetres off it) is first moved to its nearest point.
    pub fn line(&mut self, q: u32, s: [i64; 2], t: [i64; 2]) -> Vec<[i64; 2]> {
        let mut scratch = std::mem::take(&mut self.scratch);
        let line = self.line_in(&mut scratch, q, s, t);
        self.keep(&mut scratch);
        self.scratch = scratch;
        line
    }

    /// [`Map::line`] on a shared map, with `scratch`'s caches.
    fn line_in(&self, scratch: &mut Scratch, q: u32, s: [i64; 2], t: [i64; 2]) -> Vec<[i64; 2]> {
        let ((ts, _, s), (tt, _, t)) = (self.gap(q, s), self.gap(q, t));
        if ts == tt {
            return vec![s, t];
        }
        let adj = self.adjacency(scratch, q);
        let n = self.pieces[q as usize].piece.triangles.len();
        let mid = |m: &Map, k: u32| {
            let [a, b, c] = m.tri(q, k);
            [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]
        };
        let mut g = vec![i64::MAX; n];
        let mut prev = vec![NONE; n];
        let mut heap = BinaryHeap::new();
        g[ts as usize] = 0;
        heap.push(Reverse((len2(mid(self, ts), t), ts)));
        while let Some(Reverse((_, u))) = heap.pop() {
            if u == tt {
                break;
            }
            let mu = mid(self, u);
            for &w in &adj[u as usize] {
                if w == NONE {
                    continue;
                }
                let mw = mid(self, w);
                let c = g[u as usize] + len2(mu, mw);
                if c < g[w as usize] {
                    g[w as usize] = c;
                    prev[w as usize] = u;
                    heap.push(Reverse((c + len2(mw, t), w)));
                }
            }
        }
        if prev[tt as usize] == NONE {
            return vec![s, t];
        }
        let mut chain = vec![tt];
        while *chain.last().expect("one") != ts {
            chain.push(prev[*chain.last().expect("one") as usize]);
        }
        chain.reverse();
        // The channel: each shared edge, its left and right as seen going through it.
        let mut portals = vec![(s, s)];
        for w in chain.windows(2) {
            let v = self.tri_idx(q, w[0]);
            let k = (0..3)
                .find(|&k| adj[w[0] as usize][k] == w[1])
                .expect("neighbours");
            let (r, l) = (self.vert(q, v[k]), self.vert(q, v[(k + 1) % 3]));
            portals.push((l, r));
        }
        portals.push((t, t));
        funnel(&portals)
    }

    /// The cached length of the line inside piece `q` between portals `p` and `r`, mm: measured from the
    /// lower-numbered portal, so the same whichever way it is first asked (a line may differ a little by its
    /// direction).
    fn between(&self, s: &mut Scratch, q: u32, p: u32, r: u32) -> u32 {
        let key = (p.min(r), p.max(r));
        if let Some(&d) = self.pieces[q as usize].dist.get(&key) {
            return d;
        }
        if let Some(&d) = s.dist.get(&(q, key.0, key.1)) {
            return d;
        }
        let (a, b) = (
            self.portals[key.0 as usize].mid(),
            self.portals[key.1 as usize].mid(),
        );
        let line = self.line_in(s, q, a, b);
        let d = line.windows(2).map(|w| len2(w[0], w[1])).sum::<i64>() as u32;
        s.dist.insert((q, key.0, key.1), d);
        d
    }

    /// The length of the line inside piece `q` from `a` to `b` (mm), uncached.
    fn run(&self, s: &mut Scratch, q: u32, a: [i64; 2], b: [i64; 2]) -> u32 {
        let line = self.line_in(s, q, a, b);
        line.windows(2).map(|w| len2(w[0], w[1])).sum::<i64>() as u32
    }

    /// What `scratch` found joins the map's caches; its working state stays with it.
    pub fn keep(&mut self, scratch: &mut Scratch) {
        for (q, adj) in scratch.adj.drain() {
            let p = &mut self.pieces[q as usize];
            if p.adj.is_none() {
                p.adj = Some(adj);
            }
        }
        for ((q, p, r), d) in scratch.dist.drain() {
            self.pieces[q as usize].dist.insert((p, r), d);
        }
    }

    /// For a link too narrow for this map's class: its door, if one stands in it, and both widths.
    fn widths(&self, l: u32, why: &str) -> String {
        let link = &self.links[l as usize];
        if why != "link-too-narrow" || link.width == 0 {
            return String::new();
        }
        let r = self.size.radius_mm();
        let door = link
            .door
            .map_or(String::new(), |d| format!(" (door {})", show(d)));
        format!(
            ": the {}{door} is {} mm wide; a {} body is {} mm wide, {} mm with its clearance",
            format!("{:?}", link.kind).to_lowercase(),
            link.width / 1000,
            self.size.name(),
            2 * r,
            2 * (r + MARGIN)
        )
    }

    /// Why a body with `has` cannot cross link `l` now, if it cannot.
    fn refuse(&self, tree: &Tree, l: u32, has: Mask) -> Option<&'static str> {
        let link = &self.links[l as usize];
        if let Some(b) = link.blocked {
            return Some(b);
        }
        let need = needs(link.kind);
        if let Some((_, why)) = LACKS
            .iter()
            .find(|(bit, _)| need & bit != 0 && has & bit == 0)
        {
            return Some(*why);
        }
        if let Some(d) = link.door
            && has & HANDS == 0
        {
            let shut = tree
                .handle(d)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.fields().get(&F_OPEN).cloned())
                != Some(Value::Uint(1));
            if shut {
                return Some("door-needs-hands");
            }
        }
        None
    }

    /// A* over portals from `from` to `to` for a body with `has`: whether the goal was reached (the way back is left in
    /// `seen`), how many portals were taken from the queue, and the links it came to and could not use, each with
    /// why and how near its far end is to the goal.
    fn search(
        &self,
        sc: &mut Scratch,
        tree: &Tree,
        from: Spot,
        to: Spot,
        has: Mask,
    ) -> (bool, u32, Vec<Failed>) {
        sc.stamp = sc.stamp.wrapping_add(1);
        let stamp = sc.stamp;
        let goal = self.portals.len() as u32;
        let goal_w = self.world(to.piece, to.at);
        let goal_xz = [to.at[0], to.at[2]];
        let start_xz = [from.at[0], from.at[2]];
        // From a piece back to it (a shore left and come back to): the start's and the goal's legs are lines inside
        // it, not straight, or the way round a pond would look as short as the way across.
        let same = from.piece == to.piece;
        let mut heap: BinaryHeap<Reverse<(u32, u32, u32)>> = BinaryHeap::new();
        let relax = |seen: &mut Vec<(u32, u32, u32, u32)>,
                     closed: &[u32],
                     heap: &mut BinaryHeap<Reverse<(u32, u32, u32)>>,
                     node: u32,
                     g: u32,
                     h: u32,
                     prev: u32,
                     via: u32| {
            let s = &mut seen[node as usize];
            if s.0 != stamp || (g < s.1 && closed[node as usize] != stamp) {
                *s = (stamp, g, prev, via);
                heap.push(Reverse((g.saturating_add(h), h, node)));
            }
        };
        let h_of = |m: &Map, p: u32| (len3(m.portals[p as usize].world, goal_w)) as u32;
        for k in 0..self.pieces[from.piece as usize].portals.len() {
            let p = self.pieces[from.piece as usize].portals[k];
            if self.shore_shut(p, has) {
                continue;
            }
            let mid = self.portals[p as usize].mid();
            let g = if same {
                self.run(sc, from.piece, start_xz, mid)
            } else {
                len2(start_xz, mid) as u32
            };
            let h = h_of(self, p);
            relax(
                &mut sc.seen,
                &sc.closed,
                &mut heap,
                p,
                g,
                h,
                NONE,
                from.piece,
            );
        }
        let mut searched = 0u32;
        let mut failed: Vec<Failed> = Vec::new();
        let mut found = false;
        while let Some(Reverse((f, _, u))) = heap.pop() {
            let (_, g, ..) = sc.seen[u as usize];
            if u == goal {
                found = true;
                break;
            }
            if f > g.saturating_add(h_of(self, u)) || sc.closed[u as usize] == stamp {
                continue;
            }
            searched += 1;
            sc.closed[u as usize] = stamp;
            let pieces = self.portals[u as usize].pieces;
            for q in pieces {
                if q == NONE {
                    continue;
                }
                // From the start's own piece back to it, only after leaving it: its line inside the piece is the
                // direct route, which [`Map::route`] weighs against this search.
                if q == to.piece && !(same && sc.seen[u as usize].3 == q) {
                    let mid = self.portals[u as usize].mid();
                    let d = if same {
                        self.run(sc, q, mid, goal_xz)
                    } else {
                        len2(mid, goal_xz) as u32
                    };
                    relax(&mut sc.seen, &sc.closed, &mut heap, goal, g + d, 0, u, q);
                }
                for k in 0..self.pieces[q as usize].portals.len() {
                    let r = self.pieces[q as usize].portals[k];
                    if r == u || self.shore_shut(r, has) {
                        continue;
                    }
                    let d = self.between(sc, q, u, r);
                    let h = h_of(self, r);
                    relax(
                        &mut sc.seen,
                        &sc.closed,
                        &mut heap,
                        r,
                        g.saturating_add(d),
                        h,
                        u,
                        q,
                    );
                }
            }
            let (l, side) = (self.portals[u as usize].link, self.portals[u as usize].side);
            // Never straight back across the link just crossed: that lands on another portal of the end the body
            // went in by, a doorway used as a bridge between two squares' pieces of the open ground, which no walk
            // follows (#3187). Ground there is reached across the pieces.
            if l != NONE && sc.seen[u as usize].3 != LINK | l {
                if let Some(why) = self.refuse(tree, l, has).filter(|_| !self.ashore(l, side)) {
                    let far = self.links[l as usize].ends[1 - side as usize]
                        .iter()
                        .map(|&r| len3(self.portals[r as usize].world, goal_w))
                        .min()
                        .unwrap_or_else(|| len3(self.portals[u as usize].world, goal_w));
                    failed.push((l, why, far));
                    continue;
                }
                let cost = self.links[l as usize].cost;
                for k in 0..self.links[l as usize].ends[1 - side as usize].len() {
                    let r = self.links[l as usize].ends[1 - side as usize][k];
                    let h = h_of(self, r);
                    relax(
                        &mut sc.seen,
                        &sc.closed,
                        &mut heap,
                        r,
                        g.saturating_add(cost),
                        h,
                        u,
                        LINK | l,
                    );
                }
            }
        }
        (found, searched, failed)
    }

    /// The portals from the start to the goal of the last search, each with how it was reached.
    fn chain(&self, sc: &Scratch) -> Vec<(u32, u32)> {
        let mut chain = Vec::new();
        let mut at = self.portals.len() as u32;
        while at != NONE {
            let (_, _, prev, via) = sc.seen[at as usize];
            chain.push((at, via));
            at = prev;
        }
        chain.reverse();
        chain
    }

    /// The route for a body with abilities `has` from `from` to `to`, door states read from `tree`. A search never
    /// runs on the clock thread ([`crate::commit::off_clock`], K18b #3175): the world's planner runs it.
    pub fn route(
        &mut self,
        tree: &Tree,
        from: Spot,
        to: Spot,
        has: Mask,
    ) -> Result<Route, Refusal> {
        let mut scratch = std::mem::take(&mut self.scratch);
        let r = self.route_in(&mut scratch, tree, from, to, has);
        self.keep(&mut scratch);
        self.scratch = scratch;
        r
    }

    /// [`Map::route`] on a map shared by several threads, each with its own `sc` (N17b, #3255): the same route.
    pub fn route_in(
        &self,
        sc: &mut Scratch,
        tree: &Tree,
        from: Spot,
        to: Spot,
        has: Mask,
    ) -> Result<Route, Refusal> {
        crate::commit::off_clock();
        sc.fit(self.portals.len());
        let goal_xz = [to.at[0], to.at[2]];
        let start_xz = [from.at[0], from.at[2]];
        let direct = (from.piece == to.piece).then(|| {
            let first_line = self.line_in(sc, from.piece, start_xz, goal_xz);
            Route {
                size: self.size,
                hops: vec![Hop::Patch {
                    at: self.pieces[from.piece as usize].at,
                    piece: from.piece,
                }],
                length: first_line.windows(2).map(|w| len2(w[0], w[1])).sum::<i64>() as u64,
                first_line,
                waypoints: Vec::new(),
                searched: 0,
            }
        });
        // On one piece, the line inside it, unless a shore this body may cross leaves it: across a pond may be shorter
        // than round it.
        let shore = has & (WADE | SWIM) != 0
            && self.pieces[from.piece as usize].portals.iter().any(|&p| {
                let l = self.portals[p as usize].link;
                l != NONE && matches!(self.links[l as usize].kind, Kind::Wade | Kind::Swim)
            });
        let direct = match direct {
            Some(d) if !shore => return Ok(d),
            d => d,
        };
        let (found, searched, failed) = self.search(sc, tree, from, to, has);
        if let Some(d) = direct
            && (!found || u64::from(sc.seen[self.portals.len()].1) >= d.length)
        {
            return Ok(d);
        }
        if !found {
            // The link that failed: the first this body cannot use on the route a body with every ability takes;
            // when there is none, of the links it came to, the one whose far end is nearest the goal.
            let (relaxed, ..) = self.search(sc, tree, from, to, ALL);
            let first = if relaxed {
                self.chain(sc).iter().find_map(|&(_, via)| {
                    (via != NONE && via & LINK != 0)
                        .then_some(via & !LINK)
                        .and_then(|l| self.refuse(tree, l, has).map(|w| (l, w)))
                })
            } else {
                None
            };
            let pick =
                first.or_else(|| failed.iter().min_by_key(|f| (f.2, f.0)).map(|f| (f.0, f.1)));
            let detail = match pick {
                Some((l, why)) => format!(
                    "link {}: {why}{}",
                    show(self.links[l as usize].id),
                    self.widths(l, why)
                ),
                None => "no link leads on from here".to_owned(),
            };
            return Err(Refusal {
                name: "no-route",
                detail,
            });
        }
        let goal = self.portals.len() as u32;
        let chain = self.chain(sc);
        let mut hops = vec![Hop::Patch {
            at: self.pieces[from.piece as usize].at,
            piece: from.piece,
        }];
        // The first portal was reached across the start's piece, already the first hop.
        for &(_, via) in &chain[1..] {
            hops.push(if via & LINK != 0 {
                let l = &self.links[(via & !LINK) as usize];
                Hop::Link {
                    id: l.id,
                    kind: l.kind,
                }
            } else {
                Hop::Patch {
                    at: self.pieces[via as usize].at,
                    piece: via,
                }
            });
        }
        hops.dedup();
        let waypoints = chain
            .iter()
            .filter(|(p, _)| *p != goal)
            .map(|(p, _)| self.portals[*p as usize].world)
            .collect();
        let length = u64::from(sc.seen[goal as usize].1);
        let target = chain
            .first()
            .filter(|(p, _)| *p != goal)
            .map_or(goal_xz, |(p, _)| self.portals[*p as usize].mid());
        let first_line = self.line_in(sc, from.piece, start_xz, target);
        Ok(Route {
            size: self.size,
            hops,
            first_line,
            waypoints,
            length,
            searched,
        })
    }
}

/// The stretch of edge `a`–`b` that edge `c`–`d` lies along, within [`SHORE_OFF`], if it is at least [`SHORE_MIN`]
/// long (mm).
fn shared(a: [i64; 2], b: [i64; 2], c: [i64; 2], d: [i64; 2]) -> Option<([i64; 2], [i64; 2])> {
    let u = [b[0] - a[0], b[1] - a[1]];
    let l2 = u[0] * u[0] + u[1] * u[1];
    let l = l2.isqrt();
    if l == 0 || cross(a, b, c).abs() > SHORE_OFF * l || cross(a, b, d).abs() > SHORE_OFF * l {
        return None;
    }
    let t = |p: [i64; 2]| (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
    let (tc, td) = (t(c), t(d));
    let (lo, hi) = (tc.min(td).max(0), tc.max(td).min(l2));
    if (hi - lo) < SHORE_MIN * l {
        return None;
    }
    let at = |t: i64| {
        [
            a[0] + (i128::from(u[0]) * i128::from(t) / i128::from(l2)) as i64,
            a[1] + (i128::from(u[1]) * i128::from(t) / i128::from(l2)) as i64,
        ]
    };
    Some((at(lo), at(hi)))
}

fn vert(pc: &Piece, k: u32) -> [i64; 2] {
    let v = pc.vertices[k as usize];
    [i64::from(v[0]), i64::from(v[2])]
}

/// Triangle `t` of `pc`, its corners' indices counter-clockwise.
fn tri_idx(pc: &Piece, t: u32) -> [u32; 3] {
    let [i, j, k] = pc.triangles[t as usize];
    if cross(vert(pc, i), vert(pc, j), vert(pc, k)) < 0 {
        [i, k, j]
    } else {
        [i, j, k]
    }
}

fn tri(pc: &Piece, t: u32) -> [[i64; 2]; 3] {
    let [i, j, k] = tri_idx(pc, t);
    [vert(pc, i), vert(pc, j), vert(pc, k)]
}

/// The triangle of `pc` nearest `p`, the squared distance to it (0 inside), and its point nearest `p` (`p` itself
/// inside).
fn gap(pc: &Piece, p: [i64; 2]) -> (u32, i64, [i64; 2]) {
    let seg = |a: [i64; 2], b: [i64; 2]| {
        let (ex, ez) = (b[0] - a[0], b[1] - a[1]);
        let l2 = (ex * ex + ez * ez).max(1);
        let t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez).clamp(0, l2);
        let at = [a[0] + ex * t / l2, a[1] + ez * t / l2];
        (sq(at[0] - p[0]) + sq(at[1] - p[1]), at)
    };
    (0..pc.triangles.len() as u32)
        .map(|t| {
            let [a, b, c] = tri(pc, t);
            if cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0 {
                (0, t, p)
            } else {
                let (d, at) = seg(a, b).min(seg(b, c)).min(seg(c, a));
                (d, t, at)
            }
        })
        .min()
        .map_or((0, i64::MAX, p), |(d, t, at)| (t, d, at))
}

/// Each triangle's box of `pc` (x min, z min, x max, z max, mm): what [`Map::locate`] and [`gap_in`] skip by.
fn bounds_of(pc: &Piece) -> Vec<[i64; 4]> {
    (0..pc.triangles.len() as u32)
        .map(|t| {
            let [a, b, c] = tri(pc, t);
            [
                a[0].min(b[0]).min(c[0]),
                a[1].min(b[1]).min(c[1]),
                a[0].max(b[0]).max(c[0]),
                a[1].max(b[1]).max(c[1]),
            ]
        })
        .collect()
}

/// [`gap`], skipping each triangle whose box `bounds` lies farther from `p` than the nearest triangle found so far
/// (S7): the same answer. Its nearest point is rounded down to whole mm, less than a mm on each axis, so a triangle is
/// skipped only when its box is more than 2 mm on each axis beyond that: no triangle that could be the nearest, or tie
/// with it, is skipped. With no boxes (or not one a triangle), every triangle is tried.
fn gap_in(pc: &Piece, bounds: &[[i64; 4]], p: [i64; 2]) -> (u32, i64, [i64; 2]) {
    if bounds.len() != pc.triangles.len() {
        return gap(pc, p);
    }
    let seg = |a: [i64; 2], b: [i64; 2]| {
        let (ex, ez) = (b[0] - a[0], b[1] - a[1]);
        let l2 = (ex * ex + ez * ez).max(1);
        let t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez).clamp(0, l2);
        let at = [a[0] + ex * t / l2, a[1] + ez * t / l2];
        (sq(at[0] - p[0]) + sq(at[1] - p[1]), at)
    };
    let mut best: Option<(i64, u32, [i64; 2])> = None;
    for (t, bx) in (0..pc.triangles.len() as u32).zip(bounds) {
        if let Some((d, _, _)) = best {
            let dx = (bx[0] - p[0])
                .max(p[0] - bx[2])
                .max(0)
                .saturating_sub(2)
                .max(0);
            let dz = (bx[1] - p[1])
                .max(p[1] - bx[3])
                .max(0)
                .saturating_sub(2)
                .max(0);
            if sq(dx) + sq(dz) > d {
                continue;
            }
        }
        let [a, b, c] = tri(pc, t);
        let one = if cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0 {
            (0, t, p)
        } else {
            let (d, at) = seg(a, b).min(seg(b, c)).min(seg(c, a));
            (d, t, at)
        };
        best = Some(best.map_or(one, |b| b.min(one)));
    }
    best.map_or((0, i64::MAX, p), |(d, t, at)| (t, d, at))
}

/// Whether `p` (mm, the ground's frame) lies on one of `pieces` (a square's), within the grid's rounding: as
/// [`Map::on_square`], for a reader without the map (a building read again off the clock thread, G3).
pub fn on_pieces(pieces: &[Piece], p: [i64; 2]) -> bool {
    pieces.iter().any(|pc| gap(pc, p).1.isqrt() <= MEET_OFF)
}

/// String pulling through a channel of (left, right) portals, the first and last each a point.
fn funnel(portals: &[([i64; 2], [i64; 2])]) -> Vec<[i64; 2]> {
    let (mut apex, mut left, mut right) = (portals[0].0, portals[0].0, portals[0].1);
    let (mut li, mut ri) = (0usize, 0usize);
    let mut out = vec![apex];
    let mut i = 1;
    while i < portals.len() {
        let (l, r) = portals[i];
        // The right side closes in when the new right is left of (or on) the right ray.
        if cross(apex, right, r) >= 0 {
            if apex == right || cross(apex, left, r) < 0 {
                right = r;
                ri = i;
            } else {
                // It crossed the left: the left is a corner.
                apex = left;
                out.push(apex);
                (right, ri) = (apex, li);
                i = li + 1;
                continue;
            }
        }
        if cross(apex, left, l) <= 0 {
            if apex == left || cross(apex, right, l) > 0 {
                left = l;
                li = i;
            } else {
                apex = right;
                out.push(apex);
                (left, li) = (apex, ri);
                i = ri + 1;
                continue;
            }
        }
        i += 1;
    }
    let end = portals[portals.len() - 1].0;
    if out.last() != Some(&end) {
        out.push(end);
    }
    out
}
