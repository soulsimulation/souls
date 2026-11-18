//! The spatial index (Engine v2 N16, #2679; contract T2, `v2/docs/world-model.md` rule 10): who and what is near,
//! in a crowded node, without a scan.
//!
//! - **A grid per node over its frame, two layers.** Bodies are entered at their position (x and z, µm); things by
//!   their outline's box, in every square it touches. The layers are apart, so "who is near me" never pays for the
//!   furniture: a hall holds 300 seats before anyone walks in.
//! - **Kept, not rebuilt.** An entry is put when a body is added or moves and a thing is created, set down or moved
//!   into the node, and removed when it leaves: the caller follows the effects that change the world (the
//!   controller follows its bodies, `crate::controller`). Nothing scans per tick. A thing held in a hand, worn, or
//!   in flight is not entered; it is found through its body, or once it rests.
//! - **Cells.** A cell is a square of a node's bodies grid, named by node id and grid coordinates ([`Cell`]). A
//!   body's cell is worked out from where it stands ([`Index::cell_of`]), never stored, and is never its parent
//!   (T2): crossing one is no transfer.
//! - **Split and merge.** A square holding more than [`SPLIT`] entries halves its layer's grid size (down to
//!   [`MIN`]); a layer with no square holding more than [`CROWDED`] doubles it back (up to [`START`]). Only the
//!   node's grid sizes change; nothing is written for any body or thing, and every answer is the same whatever
//!   the size, so no body notices. [`Index::fixed`] keeps the size at [`START`].
//! - **Answers in id order**, each entry once (a long thing touching many squares is returned once), so two runs
//!   give the same lists. Squares are kept eight by eight to a tile, a tile's entries in one list in square order,
//!   so a row of squares is read from one place; tiles are looked up by a fixed mixing hash of their coordinates and
//!   never iterated for an answer. A thing spanning more than 256 squares (a long road) is held apart and read by
//!   every query of its layer, so it never fills thousands of squares.
//! - **Integers.** Distances compared squared in `i128`; a distance returned is rounded down by `isqrt`.
//!
//! Read side by side: the runner's threads read it at once, and the mover's bodies are entered in id order after
//! them (N17b, `crate::host`). Not here: subscriptions (R4), perception rules, choosing among candidates (E2), whether a
//! set-down is allowed (E4, G2). An outline is its box: an exact polygon test is the caller's, on what this returns.

use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};

use crate::mover::Body;
use replica::encode::Name;
use replica::ids::Id;
use replica::pose::Support;

/// A node's grid size to start with, µm.
pub const START: i64 = 2_000_000;
/// The finest grid size a split goes to, µm.
pub const MIN: i64 = 250_000;
/// A square holding more entries than this splits its layer.
pub const SPLIT: usize = 32;
/// A layer with no square holding more than this merges (an eighth of [`SPLIT`], so a merge never splits at once).
pub const CROWDED: usize = SPLIT / 8;

/// A box in a node's frame, x and z µm, its edges included: a thing's outline as the index holds it, or an outline
/// asked about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub min: [i64; 2],
    pub max: [i64; 2],
}

impl Rect {
    /// The box of a circle of radius `r` around `p`.
    pub fn around(p: [i64; 2], r: i64) -> Rect {
        Rect {
            min: [p[0] - r, p[1] - r],
            max: [p[0] + r, p[1] + r],
        }
    }

    /// Whether the two boxes share a point.
    pub fn overlaps(&self, o: &Rect) -> bool {
        self.min[0] <= o.max[0]
            && o.min[0] <= self.max[0]
            && self.min[1] <= o.max[1]
            && o.min[1] <= self.max[1]
    }

    /// Whether `p` lies in the box.
    pub fn holds(&self, p: [i64; 2]) -> bool {
        self.overlaps(&Rect { min: p, max: p })
    }

    /// The squared distance from `p` to the nearest point of the box, µm².
    pub fn dist2(&self, p: [i64; 2]) -> i128 {
        let d = |v: i64, lo: i64, hi: i64| i128::from((lo - v).max(v - hi).max(0));
        let (x, z) = (
            d(p[0], self.min[0], self.max[0]),
            d(p[1], self.min[1], self.max[1]),
        );
        x * x + z * z
    }
}

/// Which layers an outline query reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layers {
    Bodies,
    Things,
    Both,
}

/// A square of a node's bodies grid at the node's grid size now: the node and grid coordinates (x, z).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Cell {
    pub node: Id,
    pub i: i64,
    pub j: i64,
}

/// The squared distance from `p` to the point `q`, µm².
fn dist2(p: [i64; 2], q: [i64; 2]) -> i128 {
    let (x, z) = (i128::from(p[0] - q[0]), i128::from(p[1] - q[1]));
    x * x + z * z
}

/// A fixed multiply-and-rotate hash of a square's coordinates: the same on every machine and run.
#[derive(Default)]
struct Mix(u64);

const K: u64 = 0x517c_c1b7_2722_0a95;

impl Hasher for Mix {
    fn finish(&self) -> u64 {
        self.0 ^ (self.0 >> 29)
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0.rotate_left(5) ^ u64::from(*b)).wrapping_mul(K);
        }
    }
    fn write_i64(&mut self, n: i64) {
        self.0 = (self.0.rotate_left(5) ^ n as u64).wrapping_mul(K);
    }
}

/// An entry of a layer: its id and the box it covers (a body's is its point).
trait Entry: Copy {
    fn id(&self) -> Id;
    fn area(&self) -> Rect;
}

impl Entry for (Id, [i64; 2]) {
    fn id(&self) -> Id {
        self.0
    }
    fn area(&self) -> Rect {
        Rect {
            min: self.1,
            max: self.1,
        }
    }
}

/// A thing as its squares hold it.
#[derive(Clone, Copy, Debug)]
struct Thing {
    id: Id,
    area: Rect,
    kind: u32,
}

impl Entry for Thing {
    fn id(&self) -> Id {
        self.id
    }
    fn area(&self) -> Rect {
        self.area
    }
}

/// An entry whose box spans more squares than this is held apart, in the layer's list of big entries.
const BIG: i64 = 256;

/// Squares a tile has a side: a layer's squares are kept [`TILE`] by [`TILE`] to a tile, their entries in one list
/// in square order, so the squares of a row a query reads lie side by side in memory.
const TILE: i64 = 8;
const PER: usize = (TILE * TILE) as usize;

/// The squares of one tile: each square's entries end at `ends[k]` (square `k` is row `k / TILE`, column
/// `k % TILE`; it starts where square `k - 1` ends).
struct Tile<E> {
    ends: [u32; PER],
    entries: Vec<E>,
}

impl<E> Tile<E> {
    fn start(&self, k: usize) -> usize {
        if k == 0 { 0 } else { self.ends[k - 1] as usize }
    }
    fn range(&self, k: usize) -> std::ops::Range<usize> {
        self.start(k)..self.ends[k] as usize
    }
}

/// A square's tile and its place in the tile.
fn tile_of(i: i64, j: i64) -> ((i64, i64), usize) {
    (
        (i.div_euclid(TILE), j.div_euclid(TILE)),
        (i.rem_euclid(TILE) * TILE + j.rem_euclid(TILE)) as usize,
    )
}

type Tiles<E> = HashMap<(i64, i64), Tile<E>, BuildHasherDefault<Mix>>;

/// One layer of a node's grid.
struct Grid<E> {
    /// The grid size, µm: a field on the node.
    size: i64,
    tiles: Tiles<E>,
    /// Entries whose box spans more than `BIG` squares: read by every query, not entered square by square.
    big: Vec<E>,
    /// Squares holding more than [`CROWDED`] entries: while there are none, the layer can merge.
    crowded: usize,
}

impl<E: Entry> Grid<E> {
    fn new() -> Grid<E> {
        Grid {
            size: START,
            tiles: Tiles::default(),
            big: Vec::new(),
            crowded: 0,
        }
    }

    /// The square coordinates spanned by a box.
    fn span(&self, r: &Rect) -> ([i64; 2], [i64; 2]) {
        let s = self.size;
        (
            [r.min[0].div_euclid(s), r.min[1].div_euclid(s)],
            [r.max[0].div_euclid(s), r.max[1].div_euclid(s)],
        )
    }

    /// The entries of square `(i, j)`.
    fn square(&self, i: i64, j: i64) -> &[E] {
        let (t, k) = tile_of(i, j);
        self.tiles.get(&t).map_or(&[], |t| &t.entries[t.range(k)])
    }

    /// The entry `id` in square `(i, j)`.
    fn find_mut(&mut self, i: i64, j: i64, id: Id) -> Option<&mut E> {
        let (t, k) = tile_of(i, j);
        let t = self.tiles.get_mut(&t)?;
        let r = t.range(k);
        t.entries[r].iter_mut().find(|e| e.id() == id)
    }

    /// Enters `e` in every square its box touches; whether one now holds more than [`SPLIT`].
    fn insert(&mut self, e: E) -> bool {
        let (lo, hi) = self.span(&e.area());
        if (hi[0] - lo[0] + 1).saturating_mul(hi[1] - lo[1] + 1) > BIG {
            self.big.push(e);
            return false;
        }
        let mut full = false;
        for i in lo[0]..=hi[0] {
            for j in lo[1]..=hi[1] {
                let (t, k) = tile_of(i, j);
                let t = self.tiles.entry(t).or_insert_with(|| Tile {
                    ends: [0; PER],
                    entries: Vec::new(),
                });
                t.entries.insert(t.ends[k] as usize, e);
                for end in &mut t.ends[k..] {
                    *end += 1;
                }
                let n = t.range(k).len();
                if n == CROWDED + 1 {
                    self.crowded += 1;
                }
                full |= n > SPLIT;
            }
        }
        full
    }

    /// Takes `e` out of every square its box touches.
    fn remove(&mut self, e: &E) {
        let (lo, hi) = self.span(&e.area());
        if (hi[0] - lo[0] + 1).saturating_mul(hi[1] - lo[1] + 1) > BIG {
            self.big.retain(|x| x.id() != e.id());
            return;
        }
        for i in lo[0]..=hi[0] {
            for j in lo[1]..=hi[1] {
                let (key, k) = tile_of(i, j);
                let Some(t) = self.tiles.get_mut(&key) else {
                    continue;
                };
                let r = t.range(k);
                let Some(p) = t.entries[r.clone()].iter().position(|x| x.id() == e.id()) else {
                    continue;
                };
                t.entries.remove(r.start + p);
                for end in &mut t.ends[k..] {
                    *end -= 1;
                }
                if r.len() - 1 == CROWDED {
                    self.crowded -= 1;
                }
                if t.entries.is_empty() {
                    self.tiles.remove(&key);
                }
            }
        }
    }

    /// Enters every entry again at grid size `size`; whether a square holds more than [`SPLIT`].
    fn rebuild(&mut self, size: i64) -> bool {
        let all: BTreeMap<Id, E> = self
            .tiles
            .drain()
            .flat_map(|(_, t)| t.entries)
            .chain(std::mem::take(&mut self.big))
            .map(|e| (e.id(), e))
            .collect();
        self.size = size;
        self.crowded = 0;
        let mut full = false;
        for e in all.into_values() {
            full |= self.insert(e);
        }
        full
    }

    /// Halves the grid size while a square holds more than [`SPLIT`], down to [`MIN`]; the splits made.
    fn split(&mut self) -> u64 {
        let mut n = 0;
        while self.size / 2 >= MIN {
            n += 1;
            if !self.rebuild(self.size / 2) {
                break;
            }
        }
        n
    }

    /// Doubles the grid size while no square is crowded, up to [`START`]; the merges made. A merged square holds
    /// at most four times [`CROWDED`], so a merge never splits again at once.
    fn merge(&mut self) -> u64 {
        let mut n = 0;
        while self.crowded == 0 && self.size < START {
            self.rebuild(self.size * 2);
            n += 1;
        }
        n
    }

    /// Calls `f` on the entries of every square in the box of squares `lo` to `hi`, a row of a tile at a time.
    fn each(&self, lo: [i64; 2], hi: [i64; 2], mut f: impl FnMut(&[E])) {
        for i in lo[0]..=hi[0] {
            let mut j = lo[1];
            while j <= hi[1] {
                let last = hi[1].min((j.div_euclid(TILE) + 1) * TILE - 1);
                let (t, a) = tile_of(i, j);
                if let Some(t) = self.tiles.get(&t) {
                    let b = a + (last - j) as usize;
                    f(&t.entries[t.start(a)..t.ends[b] as usize]);
                }
                j = last + 1;
            }
        }
        if !self.big.is_empty() {
            f(&self.big);
        }
    }
}

/// One node's grid: its two layers.
struct Node {
    bodies: Grid<(Id, [i64; 2])>,
    things: Grid<Thing>,
}

/// The spatial index over every node: see the module.
pub struct Index {
    split: bool,
    nodes: BTreeMap<Id, Node>,
    /// Where each body is entered: node and position.
    bodies: BTreeMap<Id, (Id, [i64; 2])>,
    /// Where each thing is entered: node, box and kind.
    things: BTreeMap<Id, (Id, Rect, u32)>,
    kinds: BTreeMap<Name, u32>,
    /// Splits and merges made, every layer of every node (for the proof that no body notices).
    pub splits: u64,
    pub merges: u64,
}

impl Default for Index {
    fn default() -> Index {
        Index::new()
    }
}

/// The node a body stands on, and where on it (x, z µm).
pub fn place_of(b: &Body) -> (Id, [i64; 2]) {
    let node = match b.pose.support {
        Support::Surface { surface, .. } => surface,
        _ => b.pose.frame.node,
    };
    (node, [b.pose.position.x, b.pose.position.z])
}

/// After a layer changed: split it if a square overflowed, else merge it while nothing is crowded.
fn settle<E: Entry>(g: &mut Grid<E>, on: bool, full: bool, splits: &mut u64, merges: &mut u64) {
    if !on {
        return;
    }
    if full {
        *splits += g.split();
    } else {
        *merges += g.merge();
    }
}

fn node_mut(nodes: &mut BTreeMap<Id, Node>, node: Id) -> &mut Node {
    nodes.entry(node).or_insert_with(|| Node {
        bodies: Grid::new(),
        things: Grid::new(),
    })
}

impl Index {
    /// An index whose crowded nodes split their cells.
    pub fn new() -> Index {
        Index {
            split: true,
            nodes: BTreeMap::new(),
            bodies: BTreeMap::new(),
            things: BTreeMap::new(),
            kinds: BTreeMap::new(),
            splits: 0,
            merges: 0,
        }
    }

    /// An index that keeps every node at [`START`]: splitting off.
    pub fn fixed() -> Index {
        Index {
            split: false,
            ..Index::new()
        }
    }

    /// The node's grid sizes, bodies and things, µm.
    pub fn sizes(&self, node: Id) -> (i64, i64) {
        self.nodes
            .get(&node)
            .map_or((START, START), |n| (n.bodies.size, n.things.size))
    }

    /// Enters body `id` on `node` at `at`, or moves it there.
    pub fn put_body(&mut self, id: Id, node: Id, at: [i64; 2]) {
        let from = self.bodies.insert(id, (node, at));
        self.grid_put(id, from, node, at);
    }

    /// The grids' part of [`Index::put_body`]: the body was entered at `from`, if anywhere.
    fn grid_put(&mut self, id: Id, from: Option<(Id, [i64; 2])>, node: Id, at: [i64; 2]) {
        if let Some((from_node, from)) = from {
            let g = &mut node_mut(&mut self.nodes, from_node).bodies;
            let (a, b) = (g.span(&(id, from).area()).0, g.span(&(id, at).area()).0);
            if from_node == node && a == b {
                // The same square: only the position changes.
                if let Some(e) = g.find_mut(a[0], a[1], id) {
                    e.1 = at;
                }
                return;
            }
            g.remove(&(id, from));
            if from_node != node {
                settle(g, self.split, false, &mut self.splits, &mut self.merges);
            }
        }
        let g = &mut node_mut(&mut self.nodes, node).bodies;
        let full = g.insert((id, at));
        settle(g, self.split, full, &mut self.splits, &mut self.merges);
    }

    /// Enters a body where the mover left it.
    pub fn put_moved(&mut self, b: &Body) {
        let (node, at) = place_of(b);
        self.put_body(b.id, node, at);
    }

    /// [`Index::put_moved`] for each of `bodies`, in id order, in that order (N17b): where each was entered is found
    /// in one walk along the entered bodies, not looked up each.
    pub fn put_moved_sorted<'b>(&mut self, bodies: impl IntoIterator<Item = &'b Body>) {
        let mut entered = std::mem::take(&mut self.bodies);
        let mut walk = entered.iter_mut().peekable();
        let mut missing = Vec::new();
        for b in bodies {
            let (node, at) = place_of(b);
            while walk.next_if(|(id, _)| **id < b.id).is_some() {}
            match walk.peek_mut() {
                Some((id, e)) if **id == b.id => {
                    let from = std::mem::replace(*e, (node, at));
                    self.grid_put(b.id, Some(from), node, at);
                }
                _ => {
                    // Not entered yet: entered now, in its turn (the grids see the same order).
                    missing.push((b.id, node, at));
                    self.grid_put(b.id, None, node, at);
                }
            }
        }
        drop(walk);
        entered.extend(missing.into_iter().map(|(id, node, at)| (id, (node, at))));
        self.bodies = entered;
    }

    /// Takes body `id` out; whether it was in.
    pub fn remove_body(&mut self, id: Id) -> bool {
        let Some((node, at)) = self.bodies.remove(&id) else {
            return false;
        };
        let g = &mut node_mut(&mut self.nodes, node).bodies;
        g.remove(&(id, at));
        settle(g, self.split, false, &mut self.splits, &mut self.merges);
        true
    }

    /// Where body `id` is entered: node and position.
    pub fn body(&self, id: Id) -> Option<(Id, [i64; 2])> {
        self.bodies.get(&id).copied()
    }

    /// Enters thing `id` of `kind` on `node` by its outline's box, or moves it there.
    pub fn put_thing(&mut self, id: Id, node: Id, kind: &Name, area: Rect) {
        self.remove_thing(id);
        let n = self.kinds.len() as u32;
        let kind = *self.kinds.entry(kind.clone()).or_insert(n);
        self.things.insert(id, (node, area, kind));
        let g = &mut node_mut(&mut self.nodes, node).things;
        let full = g.insert(Thing { id, area, kind });
        settle(g, self.split, full, &mut self.splits, &mut self.merges);
    }

    /// Takes thing `id` out (removed, picked up or moved out of its node); whether it was in.
    pub fn remove_thing(&mut self, id: Id) -> bool {
        let Some((node, area, kind)) = self.things.remove(&id) else {
            return false;
        };
        let g = &mut node_mut(&mut self.nodes, node).things;
        g.remove(&Thing { id, area, kind });
        settle(g, self.split, false, &mut self.splits, &mut self.merges);
        true
    }

    /// The bodies on `node` within `r` of `p` (closer than `r`), with their distance, µm, in id order. A body at
    /// `p` itself is among them.
    pub fn bodies_within(&self, node: Id, p: [i64; 2], r: i64) -> Vec<(Id, i64)> {
        let Some(n) = self.nodes.get(&node) else {
            return Vec::new();
        };
        let r2 = i128::from(r) * i128::from(r);
        let (lo, hi) = n.bodies.span(&Rect::around(p, r));
        let mut out: Vec<(Id, i64)> = Vec::new();
        n.bodies.each(lo, hi, |sq| {
            for &(id, q) in sq {
                let d = dist2(p, q);
                if d < r2 {
                    out.push((id, d.isqrt() as i64));
                }
            }
        });
        out.sort_unstable_by_key(|e| e.0);
        out
    }

    /// The things on `node` whose outline's box comes within `r` of `p` (closer than `r`), of `kind` if given, in
    /// id order.
    pub fn things_within(&self, node: Id, p: [i64; 2], r: i64, kind: Option<&Name>) -> Vec<Id> {
        let Some(n) = self.nodes.get(&node) else {
            return Vec::new();
        };
        let kind = match kind {
            Some(k) => match self.kinds.get(k) {
                Some(&k) => Some(k),
                None => return Vec::new(),
            },
            None => None,
        };
        let r2 = i128::from(r) * i128::from(r);
        let (lo, hi) = n.things.span(&Rect::around(p, r));
        let mut out: Vec<Id> = Vec::new();
        n.things.each(lo, hi, |sq| {
            out.extend(
                sq.iter()
                    .filter(|t| kind.is_none_or(|k| t.kind == k) && t.area.dist2(p) < r2)
                    .map(|t| t.id),
            );
        });
        out.sort_unstable();
        out.dedup();
        out
    }

    /// What on `node` overlaps the box `area`: bodies standing in it, things whose box shares a point with it, or
    /// both, in id order.
    pub fn overlapping(&self, node: Id, area: Rect, layers: Layers) -> Vec<Id> {
        let Some(n) = self.nodes.get(&node) else {
            return Vec::new();
        };
        let mut out: Vec<Id> = Vec::new();
        if layers != Layers::Things {
            let (lo, hi) = n.bodies.span(&area);
            n.bodies.each(lo, hi, |sq| {
                out.extend(sq.iter().filter(|e| area.holds(e.1)).map(|e| e.0));
            });
        }
        if layers != Layers::Bodies {
            let (lo, hi) = n.things.span(&area);
            n.things.each(lo, hi, |sq| {
                out.extend(sq.iter().filter(|t| area.overlaps(&t.area)).map(|t| t.id));
            });
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// The cell of `node` that holds `p`, at the node's grid size now.
    pub fn cell_of(&self, node: Id, p: [i64; 2]) -> Cell {
        let s = self.sizes(node).0;
        Cell {
            node,
            i: p[0].div_euclid(s),
            j: p[1].div_euclid(s),
        }
    }

    /// The bodies in `cell`, in id order.
    pub fn bodies_in(&self, cell: Cell) -> Vec<Id> {
        let mut out: Vec<Id> = self.nodes.get(&cell.node).map_or_else(Vec::new, |n| {
            n.bodies
                .square(cell.i, cell.j)
                .iter()
                .map(|e| e.0)
                .collect()
        });
        out.sort_unstable();
        out
    }

    /// The cells of `node` whose square comes within `r` of `p` (closer than `r`), empty or not, in grid order.
    pub fn cells_within(&self, node: Id, p: [i64; 2], r: i64) -> Vec<Cell> {
        let s = self.sizes(node).0;
        let r2 = i128::from(r) * i128::from(r);
        let lo = [(p[0] - r).div_euclid(s), (p[1] - r).div_euclid(s)];
        let hi = [(p[0] + r).div_euclid(s), (p[1] + r).div_euclid(s)];
        let mut out = Vec::new();
        for i in lo[0]..=hi[0] {
            for j in lo[1]..=hi[1] {
                let sq = Rect {
                    min: [i * s, j * s],
                    max: [i * s + s - 1, j * s + s - 1],
                };
                if sq.dist2(p) < r2 {
                    out.push(Cell { node, i, j });
                }
            }
        }
        out
    }
}
