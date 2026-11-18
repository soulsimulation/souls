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
//! - **Versions.** A route carries the node, square and version of each patch it crosses, so a later reader can tell
//!   a route cut on a patch since rebuilt (G3, #2760). The tree keeps no per-node version yet, so the map is given
//!   one per node, as N3's cache is.
//! - **No route.** A named refusal, `no-route`, naming the link that failed and why: the first link this body
//!   cannot use on the route a body with every ability would take, or, when there is none either, of the links the
//!   search came to and could not use, the one whose far end is nearest the goal.
//!
//! - **Sizes** (B12, #2743). A map is built for one size class (`replica::kinds::sizes::Size`), its ground cut for
//!   that class's radius, and every route it gives carries the class. A link narrower than the class's body with its
//!   clearance (twice the radius plus [`MARGIN`]) is `link-too-narrow` whatever else stops it, and a body refused
//!   there is told the link, its door and both widths. A floater routes as a walker of its class.
//!
//! Not here: re-routing on edits (G3), other walkers as cost, who may pass (F6), routes across water (N11). Ground cover (Eden's footpaths, lawns, shores and piers) needs nothing here: N3 cuts it as open ground.

// The repeat rule (K12, v2/clippy.toml): the distance and patch maps are lookups on the search's hot path, never
// iterated, so their order reaches no route.
#![allow(clippy::disallowed_types)]

pub mod way;

use crate::ground::scene::Xform;
use crate::ground::scene::{FLOOR, xform_to};
use crate::ground::sizes::too_narrow;
use crate::ground::{MARGIN, OpenGround, Piece, SQUARE};
use crate::links::{Building, End, F_OPEN, Kind, Link, Open, ground_doors};
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
        Kind::Doorway | Kind::Stairs | Kind::Ramp | Kind::Step => 0,
    }
}

/// A patch by its node and, on the open ground, its square.
type PatchKey = (Id, Option<(i32, i32)>);
/// A stretch of a square's edge a piece lies along: from, to (mm), the square, the piece.
type Stretch = (i64, i64, (i32, i32), u32);
/// A link a search came to and could not use: the link, why, and how near its far end is to the goal (mm).
type Failed = (u32, &'static str, i64);

/// How far a doorway's end may lie off a piece and still be its portal, mm (the grid's rounding).
const MEET_OFF: i64 = 20;

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

struct PieceRec {
    at: PatchAt,
    frame: u32,
    piece: Piece,
    portals: Vec<u32>,
    /// Per triangle (counter-clockwise), the triangle across each edge `k` (vertex `k` to `k + 1`), or `NONE`.
    adj: Option<Vec<[u32; 3]>>,
    /// Portal to portal, the line's length inside this piece, mm: filled on first use.
    dist: HashMap<(u32, u32), u32>,
}

/// Where a body leaves a piece: a segment (mm, x and z in the piece's frame) on one piece, or on two (a square's
/// edge, both in the ground's frame), or a link's end.
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
pub struct Map {
    /// The size class its ground is cut for.
    pub size: Size,
    frames: Vec<Xform>,
    pieces: Vec<PieceRec>,
    portals: Vec<Portal>,
    links: Vec<LinkRec>,
    by_patch: HashMap<PatchKey, Vec<u32>>,
    /// Buildings whose links could not be read, with why.
    pub unread: Vec<(Id, String)>,
    /// Doorway ends (or, on the open ground, an end's part in one square) that lie on no piece (left out).
    pub meets_elsewhere: usize,
    /// Per portal: (search stamp, cost so far, previous portal, how it was reached).
    seen: Vec<(u32, u32, u32, u32)>,
    /// Per portal: the stamp of the search that last took it from the queue.
    closed: Vec<u32>,
    stamp: u32,
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
        let radius = size.radius_mm();
        let gh = tree.handle(ground).ok_or("no such ground")?;
        let mut m = Map {
            size,
            frames: vec![Xform::IDENTITY],
            pieces: Vec::new(),
            portals: Vec::new(),
            links: Vec::new(),
            by_patch: HashMap::new(),
            unread: Vec::new(),
            meets_elsewhere: 0,
            seen: Vec::new(),
            closed: Vec::new(),
            stamp: 0,
        };
        let mut ground_meets = Vec::new();
        // The open ground, square by square, and each piece's stretches along its square's edges.
        let open = OpenGround::of(tree, ground, radius)?;
        let gv = version(ground);
        // Edge stretches by line: (true for x = c, c) → (lo, hi, square, piece).
        let mut lines: BTreeMap<(bool, i64), Vec<Stretch>> = BTreeMap::new();
        for (i, j) in open.squares() {
            let p = open.cut_square(i, j);
            let at = PatchAt {
                node: ground,
                square: Some((i, j)),
                version: gv,
            };
            let first = m.pieces.len() as u32;
            let (x0, z0) = (i64::from(i) * SQUARE, i64::from(j) * SQUARE);
            let (x1, z1) = (x0 + SQUARE, z0 + SQUARE);
            for (k, pc) in p.pieces.iter().enumerate() {
                let id = first + k as u32;
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
                            lines.entry((true, ax)).or_default().push((
                                az.min(bz),
                                az.max(bz),
                                (i, j),
                                id,
                            ));
                        } else if az == bz && ax != bx && (az == z0 || az == z1) {
                            lines.entry((false, az)).or_default().push((
                                ax.min(bx),
                                ax.max(bx),
                                (i, j),
                                id,
                            ));
                        }
                    }
                }
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
        for h in things {
            let id = tree.node(h).ok_or("a node that is gone")?.id();
            let place = xform_to(tree, h, gh)?;
            let on = |sq: (i32, i32), p: [i64; 2]| m.on_square(ground, sq, p);
            let open = Open {
                ground,
                place,
                meets: &ground_meets,
                on: &on,
                doors: &gdoors,
            };
            let b = match Building::read_sized(tree, id, Some(open), radius) {
                Ok(b) => b,
                Err(e) => {
                    m.unread.push((id, e));
                    continue;
                }
            };
            m.frames.push(place);
            let frame = (m.frames.len() - 1) as u32;
            known.extend(b.links.iter().map(|l| l.id));
            let mut base: HashMap<Id, u32> = HashMap::new();
            for (&floor, (_, patch)) in &b.floors {
                base.insert(floor, m.pieces.len() as u32);
                let at = PatchAt {
                    node: floor,
                    square: None,
                    version: version(floor),
                };
                m.add_patch(at, frame, patch.pieces.clone());
            }
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
        };
        let gates = Building::of_ground(tree, open, &known)?;
        buildings.push((gates, HashMap::new()));
        for (b, base) in &buildings {
            for l in &b.links {
                let mut ends = [Vec::new(), Vec::new()];
                // A blocked link's ends are portals too, so a search that comes to it can name it.
                for (k, e) in l.ends.iter().enumerate() {
                    if let Some(e) = e {
                        ends[k] = m.end_portals(l, e, k as u8, base, b);
                    }
                }
                let run: i64 = l
                    .line
                    .windows(2)
                    .map(|w| len3([w[0].x, w[0].y, w[0].z], [w[1].x, w[1].y, w[1].z]))
                    .sum::<i64>()
                    / 1000;
                // Walked through narrower than the body with its clearance: that is why, whatever else stops it. A
                // ladder is climbed facing it, so its width is not the body's.
                let narrow = l.kind != Kind::Ladder && too_narrow(l.width, radius);
                let blocked = narrow.then_some("link-too-narrow").or(l.blocked).or(
                    if ends.iter().any(Vec::is_empty) {
                        Some("link-end-off-ground")
                    } else {
                        None
                    },
                );
                m.links.push(LinkRec {
                    id: l.id,
                    kind: l.kind,
                    door: l.door,
                    blocked,
                    width: l.width,
                    ends,
                    cost: run as u32,
                });
            }
        }
        m.seen = vec![(0, 0, NONE, NONE); m.portals.len() + 1];
        m.closed = vec![0; m.portals.len() + 1];
        Ok(m)
    }

    fn add_patch(&mut self, at: PatchAt, frame: u32, pieces: Vec<Piece>) {
        let list = self.by_patch.entry((at.node, at.square)).or_default();
        for pc in pieces {
            list.push(self.pieces.len() as u32);
            self.pieces.push(PieceRec {
                at,
                frame,
                piece: pc,
                portals: Vec::new(),
                adj: None,
                dist: HashMap::new(),
            });
        }
    }

    /// The portals of link `l`'s end `e` (its side `k`): on the floor's piece it lies on (a stair's or a ladder's end,
    /// carried onto the patch, inside one; a doorway's on its edge), or, on the open ground, on the piece of each
    /// square its part inside that square lies on.
    fn end_portals(
        &mut self,
        l: &Link,
        e: &End,
        k: u8,
        base: &HashMap<Id, u32>,
        b: &Building,
    ) -> Vec<u32> {
        let li = self.links.len() as u32;
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
        let on = |m: &Map, qs: &mut dyn Iterator<Item = u32>, mid: [i64; 2]| {
            qs.filter(|&q| at_y(m, q))
                .map(|q| (m.off_piece(q, mid), q))
                .min()
                .filter(|&(d, _)| d <= MEET_OFF)
                .map(|(_, q)| q)
        };
        let mut out = Vec::new();
        if let Some(&first) = base.get(&e.floor) {
            let n = b.floors[&e.floor].1.pieces.len() as u32;
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
        self.by_patch
            .get(&(ground, Some(sq)))
            .is_some_and(|qs| qs.iter().any(|&q| self.off_piece(q, p) <= MEET_OFF))
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

    /// Each link: its id, kind, whether a door stands in it, why it cannot be crossed if it cannot, and how many
    /// portals each end has.
    pub fn links(&self) -> Vec<LinkInfo> {
        self.links
            .iter()
            .map(|l| LinkInfo {
                id: l.id,
                kind: l.kind,
                door: l.door.is_some(),
                blocked: l.blocked,
                ends: [l.ends[0].len(), l.ends[1].len()],
            })
            .collect()
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

    /// The spot at `at` (µm, the node's frame) on the patch of `node` (a floor, or the open ground).
    pub fn spot(&self, node: Id, at: Vec3) -> Option<Spot> {
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
        let v = self.pieces[q as usize].piece.vertices[k as usize];
        [i64::from(v[0]), i64::from(v[2])]
    }

    /// The triangle of piece `q` holding `p` (edges included), counter-clockwise.
    fn locate(&self, q: u32, p: [i64; 2], y: i64) -> Option<u32> {
        let pc = &self.pieces[q as usize].piece;
        if pc.vertices.first().is_none_or(|v| i64::from(v[1]) != y) {
            return None;
        }
        (0..pc.triangles.len() as u32).find(|&t| {
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
        let pc = &self.pieces[q as usize].piece;
        let seg = |a: [i64; 2], b: [i64; 2]| {
            let (ex, ez) = (b[0] - a[0], b[1] - a[1]);
            let l2 = (ex * ex + ez * ez).max(1);
            let t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez).clamp(0, l2);
            let at = [a[0] + ex * t / l2, a[1] + ez * t / l2];
            (sq(at[0] - p[0]) + sq(at[1] - p[1]), at)
        };
        (0..pc.triangles.len() as u32)
            .map(|t| {
                let [a, b, c] = self.tri(q, t);
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

    /// Triangle `t` of piece `q`, its corners counter-clockwise.
    fn tri(&self, q: u32, t: u32) -> [[i64; 2]; 3] {
        let [i, j, k] = self.tri_idx(q, t);
        [self.vert(q, i), self.vert(q, j), self.vert(q, k)]
    }

    fn tri_idx(&self, q: u32, t: u32) -> [u32; 3] {
        let [i, j, k] = self.pieces[q as usize].piece.triangles[t as usize];
        if cross(self.vert(q, i), self.vert(q, j), self.vert(q, k)) < 0 {
            [i, k, j]
        } else {
            [i, j, k]
        }
    }

    fn adjacency(&mut self, q: u32) {
        if self.pieces[q as usize].adj.is_some() {
            return;
        }
        let n = self.pieces[q as usize].piece.triangles.len() as u32;
        let mut edges: HashMap<(u32, u32), (u32, usize)> = HashMap::with_capacity(n as usize * 3);
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
        self.pieces[q as usize].adj = Some(adj);
    }

    /// The line inside piece `q` from `s` to `t` (mm, its frame): a search over its triangles, then string pulling.
    /// An end off the piece (a doorway's meet may lie a few millimetres off it) is first moved to its nearest point.
    pub fn line(&mut self, q: u32, s: [i64; 2], t: [i64; 2]) -> Vec<[i64; 2]> {
        let ((ts, _, s), (tt, _, t)) = (self.gap(q, s), self.gap(q, t));
        if ts == tt {
            return vec![s, t];
        }
        self.adjacency(q);
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
        let adj = self.pieces[q as usize].adj.take().expect("built");
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
            self.pieces[q as usize].adj = Some(adj);
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
        self.pieces[q as usize].adj = Some(adj);
        funnel(&portals)
    }

    /// The cached length of the line inside piece `q` between portals `p` and `r`, mm.
    fn between(&mut self, q: u32, p: u32, r: u32) -> u32 {
        let key = (p.min(r), p.max(r));
        if let Some(&d) = self.pieces[q as usize].dist.get(&key) {
            return d;
        }
        let (a, b) = (
            self.portals[p as usize].mid(),
            self.portals[r as usize].mid(),
        );
        let line = self.line(q, a, b);
        let d = line.windows(2).map(|w| len2(w[0], w[1])).sum::<i64>() as u32;
        self.pieces[q as usize].dist.insert(key, d);
        d
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
    fn search(&mut self, tree: &Tree, from: Spot, to: Spot, has: Mask) -> (bool, u32, Vec<Failed>) {
        self.stamp = self.stamp.wrapping_add(1);
        let stamp = self.stamp;
        let goal = self.portals.len() as u32;
        let goal_w = self.world(to.piece, to.at);
        let goal_xz = [to.at[0], to.at[2]];
        let start_xz = [from.at[0], from.at[2]];
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
            let g = len2(start_xz, self.portals[p as usize].mid()) as u32;
            let h = h_of(self, p);
            relax(
                &mut self.seen,
                &self.closed,
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
            let (_, g, ..) = self.seen[u as usize];
            if u == goal {
                found = true;
                break;
            }
            if f > g.saturating_add(h_of(self, u)) || self.closed[u as usize] == stamp {
                continue;
            }
            searched += 1;
            self.closed[u as usize] = stamp;
            let pieces = self.portals[u as usize].pieces;
            for q in pieces {
                if q == NONE {
                    continue;
                }
                if q == to.piece {
                    let d = len2(self.portals[u as usize].mid(), goal_xz) as u32;
                    relax(
                        &mut self.seen,
                        &self.closed,
                        &mut heap,
                        goal,
                        g + d,
                        0,
                        u,
                        q,
                    );
                }
                for k in 0..self.pieces[q as usize].portals.len() {
                    let r = self.pieces[q as usize].portals[k];
                    if r == u {
                        continue;
                    }
                    let d = self.between(q, u, r);
                    let h = h_of(self, r);
                    relax(
                        &mut self.seen,
                        &self.closed,
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
            if l != NONE && self.seen[u as usize].3 != LINK | l {
                if let Some(why) = self.refuse(tree, l, has) {
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
                        &mut self.seen,
                        &self.closed,
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
    fn chain(&self) -> Vec<(u32, u32)> {
        let mut chain = Vec::new();
        let mut at = self.portals.len() as u32;
        while at != NONE {
            let (_, _, prev, via) = self.seen[at as usize];
            chain.push((at, via));
            at = prev;
        }
        chain.reverse();
        chain
    }

    /// The route for a body with abilities `has` from `from` to `to`, door states read from `tree`.
    pub fn route(
        &mut self,
        tree: &Tree,
        from: Spot,
        to: Spot,
        has: Mask,
    ) -> Result<Route, Refusal> {
        let goal_xz = [to.at[0], to.at[2]];
        let start_xz = [from.at[0], from.at[2]];
        if from.piece == to.piece {
            let first_line = self.line(from.piece, start_xz, goal_xz);
            return Ok(Route {
                size: self.size,
                hops: vec![Hop::Patch {
                    at: self.pieces[from.piece as usize].at,
                    piece: from.piece,
                }],
                length: first_line.windows(2).map(|w| len2(w[0], w[1])).sum::<i64>() as u64,
                first_line,
                waypoints: Vec::new(),
                searched: 0,
            });
        }
        let (found, searched, failed) = self.search(tree, from, to, has);
        if !found {
            // The link that failed: the first this body cannot use on the route a body with every ability takes;
            // when there is none, of the links it came to, the one whose far end is nearest the goal.
            let (relaxed, ..) = self.search(tree, from, to, ALL);
            let first = if relaxed {
                self.chain().iter().find_map(|&(_, via)| {
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
        let chain = self.chain();
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
        let length = u64::from(self.seen[goal as usize].1);
        let target = chain
            .first()
            .filter(|(p, _)| *p != goal)
            .map_or(goal_xz, |(p, _)| self.portals[*p as usize].mid());
        let first_line = self.line(from.piece, start_xz, target);
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
