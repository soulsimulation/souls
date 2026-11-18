//! The tree in memory (Engine v2 K2, #2646): the one container that holds a zone's nodes and links, and the one
//! `apply` that changes them. The world (`sim`) and the client (R1) both use it, so they apply the same effects to the
//! same structure. T2 says what a node and a link are (`v2/docs/world-model.md`), T6 what a change is
//! (`v2/docs/effects.md`); this is how they are held so that no question is answered by scanning.
//!
//! - **Nodes** sit in one growable array. A [`Handle`] is a slot and the slot's generation, bumped each time the slot
//!   is freed, so a handle to a reused slot fails. A map from T3 id to slot serves lookup only and is never walked.
//! - **Children** are listed in id order, so the order never depends on what was tried and refused.
//! - **Links** are kept by id. The index at each end (T2 rule 8) carries the link's id, type, other end and audience,
//!   so the links at an end are listed from the index alone. The far end's entry is derived from the link, never
//!   written by a change, and [`Tree::to_state`] writes links once, not indexes. An end that is not a node here (a
//!   Soul, a node of another zone) keeps its index in a map of its own.
//! - **Moving state** (position, orientation, support and the motion a sample gave) of the nodes in motion sits in
//!   one dense array, apart from the cold state of things at rest. The frame is the tree's parent and slot, never a
//!   second copy (T4 rule 1).
//! - **All change goes through [`Tree::apply`]** (a viewer: no kinds) or [`Tree::commit`] (the writer: the same apply
//!   plus T2's checks, per change). A part applies whole or not at all: each step records how to undo itself, and a
//!   refusal undoes the steps before it. A freed slot is reused only once its part has committed.
//! - **Each node keeps its hash** (K5, #2669; `seal`): every step that changes what a node's hash covers marks the
//!   node and its ancestors, so a checkpoint hashes and writes only what changed.

mod check;
mod seal;

pub use check::Rules;
pub use seal::Sealed;

use crate::effects::{
    Body, Change, Effect, Flight, Header, LinkState, NodeState, Part, Refusal, State, TimerRec,
    TimerState, TransferRec,
};
use crate::encode::{Name, Value};
use crate::ids::{Hash, Id, Scope};
use crate::pose::{Frame, Owner, Pose, Quat, Support, Vec3};
use crate::time::{Micros, TimeEffect};
use crate::world_model::{Audience, DEPTH_LIMIT, End};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn show(id: Id) -> String {
    crate::world_model::show(id)
}

/// A node held by slot and generation. It fails once its node is removed, even after the slot holds another node.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Handle {
    slot: u32,
    generation: u32,
}

/// Where a node is in its frame: a position, an orientation and what supports it. The frame is the parent and slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Place {
    pub position: Vec3,
    pub orientation: Quat,
    pub support: Support,
}

impl Place {
    fn of(pose: &Pose) -> Place {
        Place {
            position: pose.position,
            orientation: pose.orientation,
            support: pose.support,
        }
    }

    fn pose(&self, frame: Frame) -> Pose {
        Pose {
            frame,
            position: self.position,
            orientation: self.orientation,
            support: self.support,
        }
    }
}

/// The motion the last sample gave a node: when, its velocities in its frame's axes, and who owns its motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Moved {
    pub at: Micros,
    pub linear: Vec3,
    pub angular: Vec3,
    pub owner: Owner,
}

/// One entry of the dense array: a node in motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Moving {
    pub node: Handle,
    pub place: Place,
    pub moved: Moved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Where {
    /// The zone's root: it has no frame.
    Root,
    Still(Place),
    /// At this index of the dense array.
    Moving(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Life {
    Free,
    Live,
    /// In a leave's flight: kept, not reachable by id as a node.
    Flying,
    /// Removed or settled in the part being applied: freed when it commits.
    Dead,
}

/// One entry of the index at an end (T2 rule 8): the link's id, type, other end and audience.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub link: Id,
    pub other: Id,
    pub audience: Audience,
    ty: u32,
}

const NONE: u32 = u32::MAX;

#[derive(Clone, Debug)]
struct NodeRec {
    generation: u32,
    life: Life,
    id: Id,
    kind: u32,
    parent: u32,
    slot: Option<u64>,
    audience: Audience,
    depth: u8,
    children: Vec<Handle>,
    links: Vec<Entry>,
    fields: BTreeMap<u64, Value>,
    at: Where,
    /// Its hash as last sealed (K5); `None` once changed. A node without one has no ancestor with one.
    hash: Option<Hash>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LinkRec {
    ty: u32,
    ends: [Id; 2],
    owner: End,
    audience: Audience,
}

impl LinkRec {
    fn owning(&self) -> Id {
        self.ends[usize::from(self.owner == End::Second)]
    }
}

#[derive(Clone, Debug)]
struct Away {
    root: u32,
    /// The node it left, which writes its settle or return.
    from: Id,
    lineage: Scope,
    zone: Id,
    pose: Pose,
    nodes: Vec<u32>,
    links: Vec<(Id, LinkRec)>,
}

type Undo = Box<dyn FnOnce(&mut Tree)>;

/// The nodes an entry may write (T6 rule 6): its own node, and the nodes it creates under it.
struct Own {
    node: Id,
    audience: Audience,
    created: BTreeSet<Id>,
}

impl Own {
    fn check(&self, id: Id) -> R<()> {
        if id == self.node || self.created.contains(&id) {
            Ok(())
        } else {
            refuse(
                "not-own-node",
                format!("{} written by {}'s entry", show(id), show(self.node)),
            )
        }
    }

    fn audience(&self, a: Audience, what: Id) -> R<()> {
        if a == self.audience {
            Ok(())
        } else {
            refuse(
                "audience-mismatch",
                format!("{} is outside the entry's audience", show(what)),
            )
        }
    }
}

/// A node as the tree holds it, read through a handle.
pub struct NodeRef<'a> {
    tree: &'a Tree,
    rec: &'a NodeRec,
}

impl NodeRef<'_> {
    pub fn id(&self) -> Id {
        self.rec.id
    }

    /// T3's full `namespace:name@hash`.
    pub fn kind(&self) -> &Name {
        &self.tree.names[self.rec.kind as usize]
    }

    pub fn parent(&self) -> Option<Id> {
        (self.rec.parent != NONE).then(|| self.tree.nodes[self.rec.parent as usize].id)
    }

    pub fn slot(&self) -> Option<u64> {
        self.rec.slot
    }

    pub fn audience(&self) -> Audience {
        self.rec.audience
    }

    /// Ancestors, from 0 at the zone's root.
    pub fn depth(&self) -> u32 {
        u32::from(self.rec.depth)
    }

    pub fn fields(&self) -> &BTreeMap<u64, Value> {
        &self.rec.fields
    }

    /// Where it is in its frame; none for the zone's root.
    pub fn place(&self) -> Option<Place> {
        self.tree.place_of(self.rec)
    }

    /// The motion its last sample gave it, while it moves.
    pub fn moved(&self) -> Option<Moved> {
        match self.rec.at {
            Where::Moving(ix) => self.tree.moving[ix as usize].map(|m| m.moved),
            _ => None,
        }
    }
}

/// One zone's tree: its nodes, links and their indexes, the dense array of moving nodes, and the zone's log state
/// (next sequence, transfers in flight, arrived transfer ids, timers, time effects). Not `Clone`: there is one.
pub struct Tree {
    root: u32,
    nodes: Vec<NodeRec>,
    free: Vec<u32>,
    /// Live and flying nodes by id. Lookup only: never walked, so its order reaches nothing.
    by_id: HashMap<Id, u32>,
    /// Links by id. Lookup only.
    links: HashMap<Id, LinkRec>,
    /// The index at ends that are not nodes here: Souls, and nodes of other zones. Lookup only.
    elsewhere: HashMap<Id, Vec<Entry>>,
    moving: Vec<Option<Moving>>,
    moving_free: Vec<u32>,
    names: Vec<Name>,
    name_ix: HashMap<Name, u32>,
    next: u64,
    in_flight: BTreeMap<Id, Away>,
    arrived: BTreeSet<Id>,
    timers: BTreeMap<Id, TimerState>,
    time: Vec<TimeEffect>,
    undo: Vec<Undo>,
    dead: Vec<u32>,
    node_reads: Cell<u64>,
    link_reads: Cell<u64>,
}

fn bump(c: &Cell<u64>) {
    c.set(c.get() + 1);
}

impl Tree {
    /// A zone's tree at its start: its root alone, public, with no fields (as `effects::State::start`).
    pub fn start(root: Id, kind: Name) -> Tree {
        let mut t = Tree {
            root: 0,
            nodes: Vec::new(),
            free: Vec::new(),
            by_id: HashMap::new(),
            links: HashMap::new(),
            elsewhere: HashMap::new(),
            moving: Vec::new(),
            moving_free: Vec::new(),
            names: Vec::new(),
            name_ix: HashMap::new(),
            next: 0,
            in_flight: BTreeMap::new(),
            arrived: BTreeSet::new(),
            timers: BTreeMap::new(),
            time: Vec::new(),
            undo: Vec::new(),
            dead: Vec::new(),
            node_reads: Cell::new(0),
            link_reads: Cell::new(0),
        };
        let kind = t.intern(&kind);
        t.nodes.push(NodeRec {
            generation: 0,
            life: Life::Live,
            id: root,
            kind,
            parent: NONE,
            slot: None,
            audience: Audience::Everyone,
            depth: 0,
            children: Vec::new(),
            links: Vec::new(),
            fields: BTreeMap::new(),
            at: Where::Root,
            hash: None,
        });
        t.by_id.insert(root, 0);
        t
    }

    // --- Reading -------------------------------------------------------------------------------------------------

    /// The handle of a node here, by id.
    pub fn handle(&self, id: Id) -> Option<Handle> {
        let slot = *self.by_id.get(&id)?;
        let rec = &self.nodes[slot as usize];
        (rec.life == Life::Live).then_some(Handle {
            slot,
            generation: rec.generation,
        })
    }

    pub fn root(&self) -> Handle {
        Handle {
            slot: self.root,
            generation: self.nodes[self.root as usize].generation,
        }
    }

    fn rec(&self, h: Handle) -> Option<&NodeRec> {
        let rec = self.nodes.get(h.slot as usize)?;
        (rec.generation == h.generation && rec.life == Life::Live).then_some(rec)
    }

    /// The node, counted as one node read; `None` for a handle whose node is gone.
    pub fn node(&self, h: Handle) -> Option<NodeRef<'_>> {
        bump(&self.node_reads);
        self.rec(h).map(|rec| NodeRef { tree: self, rec })
    }

    /// The node's children in id order. Costs one node read, and time in proportion to the number listed.
    pub fn children(&self, h: Handle) -> Option<&[Handle]> {
        bump(&self.node_reads);
        self.rec(h).map(|r| r.children.as_slice())
    }

    /// The links at a node, in link id order, from the index alone: one node read, no link read.
    pub fn links_of(&self, h: Handle) -> Option<&[Entry]> {
        bump(&self.node_reads);
        self.rec(h).map(|r| r.links.as_slice())
    }

    /// The links at any end, a node here or not (a Soul): one node read for a node, none otherwise; no link read.
    pub fn links_at(&self, end: Id) -> &[Entry] {
        if let Some(h) = self.handle(end) {
            return self.links_of(h).unwrap_or(&[]);
        }
        self.elsewhere.get(&end).map_or(&[], Vec::as_slice)
    }

    /// An index entry's link type.
    pub fn ty(&self, e: &Entry) -> &Name {
        &self.names[e.ty as usize]
    }

    /// A link's type, ends, owning end and audience, counted as one link read.
    pub fn link(&self, id: Id) -> Option<(&Name, [Id; 2], End, Audience)> {
        bump(&self.link_reads);
        self.links
            .get(&id)
            .map(|l| (&self.names[l.ty as usize], l.ends, l.owner, l.audience))
    }

    /// Node reads and link reads since the tree was built or the counters were last reset.
    pub fn reads(&self) -> (u64, u64) {
        (self.node_reads.get(), self.link_reads.get())
    }

    pub fn reset_reads(&self) {
        self.node_reads.set(0);
        self.link_reads.set(0);
    }

    /// The sequence the zone's next effect takes: how many effects the tree holds.
    pub fn next(&self) -> u64 {
        self.next
    }

    /// Nodes here (not in flight), and links.
    pub fn counts(&self) -> (usize, usize) {
        (self.by_id.len() - self.flying_count(), self.links.len())
    }

    fn flying_count(&self) -> usize {
        self.in_flight.values().map(|f| f.nodes.len()).sum()
    }

    /// The dense array of moving nodes. A free entry is `None`.
    pub fn moving(&self) -> &[Option<Moving>] {
        &self.moving
    }

    fn place_of(&self, rec: &NodeRec) -> Option<Place> {
        match rec.at {
            Where::Root => None,
            Where::Still(p) => Some(p),
            Where::Moving(ix) => self.moving[ix as usize].map(|m| m.place),
        }
    }

    fn live(&self, id: Id) -> R<u32> {
        match self.by_id.get(&id) {
            Some(s) if self.nodes[*s as usize].life == Life::Live => Ok(*s),
            _ => refuse("node-missing", show(id)),
        }
    }

    fn intern(&mut self, n: &Name) -> u32 {
        if let Some(i) = self.name_ix.get(n) {
            return *i;
        }
        let i =
            u32::try_from(self.names.len()).unwrap_or_else(|_| unreachable!("names fit 32 bits"));
        self.names.push(n.clone());
        self.name_ix.insert(n.clone(), i);
        i
    }

    // --- Steps, each recording its undo ---------------------------------------------------------------------------

    fn log(&mut self, f: impl FnOnce(&mut Tree) + 'static) {
        self.undo.push(Box::new(f));
    }

    /// Marks a node changed, and its ancestors: up to the first already marked, whose ancestors are marked too. A
    /// refused part leaves its marks; the next seal hashes those nodes again and finds what they were.
    fn touch(&mut self, slot: u32) {
        let mut s = slot;
        while s != NONE && self.nodes[s as usize].hash.take().is_some() {
            s = self.nodes[s as usize].parent;
        }
    }

    /// Marks the node that owns a link, if it is a node here (its hash covers the links it owns).
    fn touch_owner(&mut self, l: &LinkRec) {
        if let Some(s) = self.by_id.get(&l.owning()).copied() {
            self.touch(s);
        }
    }

    fn handle_of(&self, slot: u32) -> Handle {
        Handle {
            slot,
            generation: self.nodes[slot as usize].generation,
        }
    }

    /// Puts `c` into its parent's children, in id order.
    fn attach(&mut self, c: u32) {
        let p = self.nodes[c as usize].parent as usize;
        let id = self.nodes[c as usize].id;
        let at = self.nodes[p]
            .children
            .partition_point(|h| self.nodes[h.slot as usize].id < id);
        let h = self.handle_of(c);
        self.nodes[p].children.insert(at, h);
        self.touch(p as u32);
        self.log(move |t| t.unattach(c));
    }

    fn unattach(&mut self, c: u32) {
        let p = self.nodes[c as usize].parent as usize;
        self.nodes[p].children.retain(|h| h.slot != c);
        self.touch(p as u32);
    }

    fn detach(&mut self, c: u32) {
        self.unattach(c);
        self.log(move |t| {
            t.attach(c);
            t.undo.pop();
        });
    }

    fn entries_mut(&mut self, end: Id) -> &mut Vec<Entry> {
        match self.by_id.get(&end) {
            Some(s) => &mut self.nodes[*s as usize].links,
            None => self.elsewhere.entry(end).or_default(),
        }
    }

    fn entry_put(&mut self, end: Id, e: Entry) {
        let link = e.link;
        let list = self.entries_mut(end);
        let at = list.partition_point(|x| x.link < link);
        list.insert(at, e);
        self.log(move |t| {
            t.entry_drop(end, link);
        });
    }

    fn entry_drop(&mut self, end: Id, link: Id) -> Option<Entry> {
        let list = self.entries_mut(end);
        let at = list.binary_search_by(|x| x.link.cmp(&link)).ok()?;
        let e = list.remove(at);
        if list.is_empty() && !self.by_id.contains_key(&end) {
            self.elsewhere.remove(&end);
        }
        Some(e)
    }

    fn entry_take(&mut self, end: Id, link: Id) {
        if let Some(e) = self.entry_drop(end, link) {
            self.log(move |t| {
                t.entry_put(end, e);
                t.undo.pop();
            });
        }
    }

    /// A link into the table and the index at both ends.
    fn link_put(&mut self, id: Id, l: LinkRec) {
        for (end, other) in [(l.ends[0], l.ends[1]), (l.ends[1], l.ends[0])] {
            if end == other && self.entries_mut(end).iter().any(|e| e.link == id) {
                continue; // a self-link is listed once at its one end
            }
            self.entry_put(
                end,
                Entry {
                    link: id,
                    other,
                    audience: l.audience,
                    ty: l.ty,
                },
            );
        }
        self.touch_owner(&l);
        self.links.insert(id, l);
        self.log(move |t| {
            t.links.remove(&id);
        });
    }

    /// A link out of the table and the index at both ends.
    fn link_take(&mut self, id: Id) -> Option<LinkRec> {
        let l = self.links.remove(&id)?;
        self.touch_owner(&l);
        self.entry_take(l.ends[0], id);
        self.entry_take(l.ends[1], id);
        let back = l.clone();
        self.log(move |t| {
            t.links.insert(id, back);
        });
        Some(l)
    }

    fn set_life(&mut self, slot: u32, life: Life) {
        let old = std::mem::replace(&mut self.nodes[slot as usize].life, life);
        self.log(move |t| t.nodes[slot as usize].life = old);
    }

    fn set_depth(&mut self, slot: u32, depth: u8) {
        let old = std::mem::replace(&mut self.nodes[slot as usize].depth, depth);
        self.log(move |t| t.nodes[slot as usize].depth = old);
    }

    fn set_parent(&mut self, slot: u32, parent: u32, s: Option<u64>) {
        self.touch(slot);
        let rec = &mut self.nodes[slot as usize];
        let old = (rec.parent, rec.slot);
        (rec.parent, rec.slot) = (parent, s);
        self.log(move |t| {
            let rec = &mut t.nodes[slot as usize];
            (rec.parent, rec.slot) = old;
        });
    }

    fn set_field(&mut self, slot: u32, field: u64, to: Value) {
        self.touch(slot);
        let old = self.nodes[slot as usize].fields.insert(field, to);
        self.log(move |t| {
            let f = &mut t.nodes[slot as usize].fields;
            match old {
                Some(v) => f.insert(field, v),
                None => f.remove(&field),
            };
        });
    }

    /// Where a node is: still at `place`, or moving with `moved` (in the dense array).
    fn set_at(&mut self, slot: u32, place: Place, moved: Option<Moved>) {
        self.touch(slot);
        let old = self.nodes[slot as usize].at;
        let old_moving = match old {
            Where::Moving(ix) => self.moving[ix as usize],
            _ => None,
        };
        let at = match (old, moved) {
            (Where::Moving(ix), Some(moved)) => {
                self.moving[ix as usize] = Some(Moving {
                    node: self.handle_of(slot),
                    place,
                    moved,
                });
                Where::Moving(ix)
            }
            (_, Some(moved)) => {
                let m = Some(Moving {
                    node: self.handle_of(slot),
                    place,
                    moved,
                });
                let ix = match self.moving_free.pop() {
                    Some(ix) => {
                        self.moving[ix as usize] = m;
                        ix
                    }
                    None => {
                        self.moving.push(m);
                        u32::try_from(self.moving.len() - 1)
                            .unwrap_or_else(|_| unreachable!("fits 32 bits"))
                    }
                };
                self.log(move |t| {
                    t.moving[ix as usize] = None;
                    t.moving_free.push(ix);
                });
                Where::Moving(ix)
            }
            (Where::Moving(ix), None) => {
                self.moving[ix as usize] = None;
                self.moving_free.push(ix);
                self.log(move |t| {
                    t.moving_free.pop();
                });
                Where::Still(place)
            }
            (_, None) => Where::Still(place),
        };
        self.nodes[slot as usize].at = at;
        self.log(move |t| {
            t.nodes[slot as usize].at = old;
            if let Where::Moving(ix) = old {
                t.moving[ix as usize] = old_moving;
            }
        });
    }

    fn alloc(&mut self, rec: NodeRec) -> u32 {
        let id = rec.id;
        let slot = match self.free.pop() {
            Some(s) => {
                let generation = self.nodes[s as usize].generation;
                self.nodes[s as usize] = NodeRec { generation, ..rec };
                s
            }
            None => {
                self.nodes.push(rec);
                u32::try_from(self.nodes.len() - 1).unwrap_or_else(|_| unreachable!("fits 32 bits"))
            }
        };
        self.by_id.insert(id, slot);
        self.log(move |t| {
            t.by_id.remove(&id);
            t.release(slot);
        });
        slot
    }

    /// Frees a slot: its generation moves on, so every handle to it fails from now.
    fn release(&mut self, slot: u32) {
        let rec = &mut self.nodes[slot as usize];
        rec.generation = rec.generation.wrapping_add(1);
        rec.life = Life::Free;
        rec.children = Vec::new();
        rec.links = Vec::new();
        rec.fields = BTreeMap::new();
        if let Where::Moving(ix) = std::mem::replace(&mut rec.at, Where::Root) {
            self.moving[ix as usize] = None;
            self.moving_free.push(ix);
        }
        self.free.push(slot);
    }

    /// Removes a node from lookup; its slot is freed when the part commits. Its index entries that links still
    /// need (a link owned by a node that stays, into a subtree that left) move to the index of ends not here.
    fn kill(&mut self, slot: u32) {
        let id = self.nodes[slot as usize].id;
        let entries = std::mem::take(&mut self.nodes[slot as usize].links);
        self.set_life(slot, Life::Dead);
        self.by_id.remove(&id);
        self.dead.push(slot);
        let moved = !entries.is_empty();
        if moved {
            self.elsewhere.insert(id, entries);
        }
        self.log(move |t| {
            if moved {
                t.nodes[slot as usize].links = t.elsewhere.remove(&id).unwrap_or_default();
            }
            t.by_id.insert(id, slot);
            t.dead.pop();
        });
    }

    /// `slot` and every node below it, walked with a loop through the children lists: time in proportion to the
    /// subtree, never to the world.
    fn subtree(&self, slot: u32) -> Vec<u32> {
        let mut out = vec![slot];
        let mut i = 0;
        while i < out.len() {
            out.extend(self.nodes[out[i] as usize].children.iter().map(|h| h.slot));
            i += 1;
        }
        out
    }

    /// The most levels below the first node of a subtree listed parents first (0 for a leaf).
    fn height(&self, nodes: &[u32]) -> u32 {
        let mut below: HashMap<u32, u32> = HashMap::with_capacity(nodes.len());
        let mut most = 0;
        for (i, s) in nodes.iter().enumerate() {
            let p = self.nodes[*s as usize].parent;
            let d = if i == 0 {
                0
            } else {
                below.get(&p).map_or(0, |d| d + 1)
            };
            below.insert(*s, d);
            most = most.max(d);
        }
        most
    }

    /// Sets the depth of a subtree listed parents first, from its root's parent.
    fn redepth(&mut self, nodes: &[u32]) {
        for s in nodes {
            let p = self.nodes[*s as usize].parent;
            let d = self.nodes[p as usize].depth + 1;
            self.set_depth(*s, d);
        }
    }

    // --- Applying -------------------------------------------------------------------------------------------------

    /// Applies a part as a viewer does: no kinds, no T2 checks (T6 rule 5). All of it or none.
    pub fn apply(&mut self, header: &Header, part: &Part) -> R<()> {
        self.transact(header, part, None)
    }

    /// Applies a part as the zone's writer commits it: the same apply, plus T2's checks on each change and the
    /// balance of amounts moved over the part ([`Rules`]). All of it or none.
    pub fn commit(&mut self, header: &Header, part: &Part, rules: &Rules) -> R<()> {
        self.transact(header, part, Some(rules))
    }

    fn transact(&mut self, header: &Header, part: &Part, rules: Option<&Rules>) -> R<()> {
        if part.header != header.hash().to_bytes() {
            return refuse("header-mismatch", "the part names another header");
        }
        self.run(header, &part.effects, rules)
    }

    /// Applies entries whole or not at all (also used to load T2's fixtures, whose link types are not names).
    pub(crate) fn run(
        &mut self,
        header: &Header,
        effects: &[Effect],
        rules: Option<&Rules>,
    ) -> R<()> {
        debug_assert!(self.undo.is_empty() && self.dead.is_empty());
        let mut result = Ok(());
        for e in effects {
            result = self.entry(header, e, rules);
            if result.is_err() {
                break;
            }
        }
        if result.is_ok()
            && let Some(rules) = rules
        {
            result = rules.balanced(effects);
        }
        if result.is_err() {
            while let Some(u) = self.undo.pop() {
                u(self);
            }
            self.dead.clear();
            return result;
        }
        self.undo.clear();
        for slot in std::mem::take(&mut self.dead) {
            self.release(slot);
        }
        Ok(())
    }

    fn entry(&mut self, header: &Header, e: &Effect, rules: Option<&Rules>) -> R<()> {
        let env = e.envelope;
        if env.sequence != self.next {
            return refuse(
                "sequence-gap",
                format!("effect {} after {}", env.sequence, self.next),
            );
        }
        self.live(env.node)?;
        let mut own = Own {
            node: env.node,
            audience: env.audience,
            created: BTreeSet::new(),
        };
        match &e.body {
            Body::Changes(changes) => {
                for c in changes {
                    self.change(header, &mut own, &c.change, rules)?;
                }
            }
            Body::Transfer(t) => self.transfer(header, &mut own, t, rules)?,
            Body::Time(t) => {
                if env.node != self.nodes[self.root as usize].id
                    || env.audience != Audience::Everyone
                {
                    return refuse(
                        "not-own-node",
                        "time effects are the zone root's, for everyone",
                    );
                }
                for x in t {
                    self.time.push(*x);
                    self.log(|t| {
                        t.time.pop();
                    });
                }
            }
            Body::Timers(list) => {
                let slot = self.live(env.node)?;
                own.audience(self.nodes[slot as usize].audience, env.node)?;
                for r in list {
                    self.timer(env.node, r)?;
                }
            }
        }
        self.next += 1;
        self.log(|t| t.next -= 1);
        Ok(())
    }

    fn timer(&mut self, node: Id, r: &TimerRec) -> R<()> {
        match r {
            TimerRec::Set { timer, due, name } => {
                if self.timers.contains_key(timer) {
                    return refuse("id-duplicate", show(*timer));
                }
                let state = TimerState {
                    node,
                    due: *due,
                    name: name.clone(),
                };
                self.timers.insert(*timer, state);
                let timer = *timer;
                self.log(move |t| {
                    t.timers.remove(&timer);
                });
            }
            TimerRec::Clear { timer } => match self.timers.get(timer) {
                Some(s) if s.node == node => {
                    let timer = *timer;
                    let old = self.timers.remove(&timer);
                    self.log(move |t| {
                        t.timers.extend(old.map(|o| (timer, o)));
                    });
                }
                Some(_) => return refuse("not-own-node", show(*timer)),
                None => return refuse("timer-missing", show(*timer)),
            },
        }
        Ok(())
    }

    fn fresh(&self, id: Id) -> R<()> {
        if self.by_id.contains_key(&id) || self.links.contains_key(&id) {
            refuse("id-duplicate", show(id))
        } else {
            Ok(())
        }
    }

    fn change(
        &mut self,
        header: &Header,
        own: &mut Own,
        c: &Change,
        rules: Option<&Rules>,
    ) -> R<()> {
        match c {
            Change::Create {
                node,
                kind,
                pose,
                audience,
                fields,
            } => {
                own.check(pose.frame.node)?;
                own.audience(*audience, *node)?;
                self.fresh(*node)?;
                if !header.kinds.contains(kind) {
                    return refuse("kind-not-in-header", kind.as_str());
                }
                let parent = self
                    .live(pose.frame.node)
                    .or_else(|_| refuse("parent-missing", show(pose.frame.node)))?;
                let depth = u32::from(self.nodes[parent as usize].depth) + 1;
                if depth > DEPTH_LIMIT {
                    return refuse("depth-over-limit", show(*node));
                }
                if let Some(r) = rules {
                    r.create(self, *node, kind, parent, pose.frame.slot, *audience)?;
                }
                let kind = self.intern(kind);
                let links = self.elsewhere.remove(node).unwrap_or_default();
                let slot = self.alloc(NodeRec {
                    generation: 0,
                    life: Life::Live,
                    id: *node,
                    kind,
                    parent,
                    slot: pose.frame.slot,
                    audience: *audience,
                    depth: u8::try_from(depth).unwrap_or(u8::MAX),
                    children: Vec::new(),
                    links,
                    fields: fields.clone(),
                    at: Where::Still(Place::of(pose)),
                    hash: None,
                });
                if !self.nodes[slot as usize].links.is_empty() {
                    let id = *node;
                    self.log(move |t| {
                        let back = std::mem::take(&mut t.nodes[slot as usize].links);
                        t.elsewhere.insert(id, back);
                    });
                }
                self.attach(slot);
                own.created.insert(*node);
            }
            Change::Remove { node } => {
                own.check(*node)?;
                let slot = self.live(*node)?;
                own.audience(self.nodes[slot as usize].audience, *node)?;
                if slot == self.root {
                    return refuse("remove-root", show(*node));
                }
                let gone = self.subtree(slot);
                self.detach(slot);
                for s in &gone {
                    let ends: Vec<Id> = self.nodes[*s as usize]
                        .links
                        .iter()
                        .map(|e| e.link)
                        .collect();
                    for l in ends {
                        self.link_take(l);
                    }
                }
                for s in gone {
                    self.kill(s);
                }
            }
            Change::Reparent { node, from, pose } => {
                own.check(*node)?;
                let slot = self.live(*node)?;
                let n = &self.nodes[slot as usize];
                own.audience(n.audience, *node)?;
                let parent_id = (n.parent != NONE).then(|| self.nodes[n.parent as usize].id);
                if parent_id != Some(from.node) || n.slot != from.slot {
                    return refuse(
                        "frame-mismatch",
                        format!("{} is not where the reparent says", show(*node)),
                    );
                }
                if pose.frame.node != from.node {
                    return refuse(
                        "crosses-nodes",
                        format!("{}: a new parent is a leave and an arrive", show(*node)),
                    );
                }
                let parent = n.parent;
                if let Some(r) = rules {
                    r.place(self, slot, parent, pose.frame.slot)?;
                }
                self.set_parent(slot, parent, pose.frame.slot);
                self.set_at(slot, Place::of(pose), None);
            }
            Change::Set {
                node, field, to, ..
            } => {
                own.check(*node)?;
                let slot = self.live(*node)?;
                own.audience(self.nodes[slot as usize].audience, *node)?;
                self.set_field(slot, *field, to.clone());
            }
            Change::Link {
                link,
                ty,
                ends,
                owner,
                audience,
            } => {
                let owning = ends[usize::from(*owner == End::Second)];
                own.check(owning)?;
                own.audience(*audience, *link)?;
                self.fresh(*link)?;
                if self.live(owning).is_err() {
                    return refuse("link-owner-not-node", show(owning));
                }
                if let Some(r) = rules {
                    r.link(self, *link, *ends, *audience)?;
                }
                let ty = self.intern(ty);
                self.link_put(
                    *link,
                    LinkRec {
                        ty,
                        ends: *ends,
                        owner: *owner,
                        audience: *audience,
                    },
                );
            }
            Change::Unlink { link } => {
                let Some(l) = self.links.get(link) else {
                    return refuse("link-missing", show(*link));
                };
                own.check(l.owning())?;
                own.audience(l.audience, *link)?;
                self.link_take(*link);
            }
            Change::Motion(m) => {
                own.check(m.node)?;
                let slot = self.live(m.node)?;
                let n = &self.nodes[slot as usize];
                own.audience(n.audience, m.node)?;
                let parent_id = (n.parent != NONE).then(|| self.nodes[n.parent as usize].id);
                if parent_id != Some(m.pose.frame.node) || n.slot != m.pose.frame.slot {
                    return refuse(
                        "frame-mismatch",
                        format!(
                            "{}: a motion sample's frame is its parent; a new frame is a transfer",
                            show(m.node)
                        ),
                    );
                }
                let moved = Moved {
                    at: m.at,
                    linear: m.linear,
                    angular: m.angular,
                    owner: m.to,
                };
                self.set_at(slot, Place::of(&m.pose), Some(moved));
            }
        }
        Ok(())
    }

    fn transfer(
        &mut self,
        header: &Header,
        own: &mut Own,
        t: &TransferRec,
        rules: Option<&Rules>,
    ) -> R<()> {
        let id = t.transfer();
        match t {
            TransferRec::Leave {
                node,
                lineage,
                zone,
                pose,
                ..
            } => {
                own.check(*node)?;
                let slot = self.live(*node)?;
                own.audience(self.nodes[slot as usize].audience, *node)?;
                if slot == self.root {
                    return refuse("remove-root", show(*node));
                }
                if self.in_flight.contains_key(&id) || self.arrived.contains(&id) {
                    return refuse("id-duplicate", show(id));
                }
                // A leave is not a remove (T2 rule 8, T1 rule 5): the links the subtree owns go with it, and a link
                // a staying node owns stays, indexed at both ends.
                let nodes = self.subtree(slot);
                let mut carried = Vec::new();
                for s in &nodes {
                    let ids: Vec<Id> = self.nodes[*s as usize]
                        .links
                        .iter()
                        .map(|e| e.link)
                        .collect();
                    for l in ids {
                        let owned_here = self
                            .links
                            .get(&l)
                            .is_some_and(|r| self.by_id.get(&r.owning()) == Some(s));
                        if owned_here && let Some(rec) = self.link_take(l) {
                            carried.push((l, rec));
                        }
                    }
                }
                self.detach(slot);
                for s in &nodes {
                    self.set_life(*s, Life::Flying);
                }
                let from = self.nodes[self.nodes[slot as usize].parent as usize].id;
                self.in_flight.insert(
                    id,
                    Away {
                        root: slot,
                        from,
                        lineage: *lineage,
                        zone: *zone,
                        pose: *pose,
                        nodes,
                        links: carried,
                    },
                );
                self.log(move |t| {
                    t.in_flight.remove(&id);
                });
            }
            TransferRec::Arrive { carried, .. } => {
                if self.arrived.contains(&id) {
                    return Ok(()); // T1 rule 6: a second arrive changes nothing.
                }
                match self.in_flight.get(&id) {
                    Some(f) if carried.is_empty() => {
                        if (f.lineage, f.zone) != (header.lineage, header.zone) {
                            return refuse("arrive-not-here", show(id));
                        }
                        let (root, frame) = (f.root, f.pose.frame);
                        own.check(frame.node)?;
                        own.audience(
                            self.nodes[root as usize].audience,
                            self.nodes[root as usize].id,
                        )?;
                        let parent = self
                            .live(frame.node)
                            .or_else(|_| refuse("arrive-parent-missing", show(frame.node)))?;
                        let f = self
                            .in_flight
                            .remove(&id)
                            .unwrap_or_else(|| unreachable!("read above"));
                        let back = f.clone();
                        self.log(move |t| {
                            t.in_flight.insert(id, back);
                        });
                        self.land(&f, parent, frame.slot, Some(Place::of(&f.pose)), rules)?;
                    }
                    Some(_) => {
                        return refuse(
                            "not-a-record",
                            "an arrive in its leave's zone carries nothing",
                        );
                    }
                    None if carried.is_empty() => return refuse("transfer-missing", show(id)),
                    None => {
                        for c in carried {
                            self.change(header, own, &c.change, rules)?;
                        }
                    }
                }
                self.arrived.insert(id);
                self.log(move |t| {
                    t.arrived.remove(&id);
                });
            }
            TransferRec::Settle { .. } | TransferRec::Return { .. } => {
                let Some(f) = self.in_flight.get(&id) else {
                    return refuse("transfer-missing", show(id));
                };
                // Written by the node the subtree left: its old parent.
                own.check(f.from)?;
                let from = self.live(f.from)?;
                let f = self
                    .in_flight
                    .remove(&id)
                    .unwrap_or_else(|| unreachable!("read above"));
                let back = f.clone();
                self.log(move |t| {
                    t.in_flight.insert(id, back);
                });
                if let TransferRec::Return { .. } = t {
                    let slot = self.nodes[f.root as usize].slot;
                    self.land(&f, from, slot, None, None)?;
                } else {
                    for s in f.nodes {
                        self.kill(s);
                    }
                }
            }
        }
        Ok(())
    }

    /// Puts a subtree in flight under `parent`: depth checked first (the parent's depth, plus one, plus the
    /// subtree's height, at most 32), then its root attached, its nodes live and their depths set, and the links it
    /// carried back in the table and the index.
    fn land(
        &mut self,
        f: &Away,
        parent: u32,
        slot: Option<u64>,
        place: Option<Place>,
        rules: Option<&Rules>,
    ) -> R<()> {
        let deepest = u32::from(self.nodes[parent as usize].depth) + 1 + self.height(&f.nodes);
        if deepest > DEPTH_LIMIT {
            return refuse("depth-over-limit", show(self.nodes[f.root as usize].id));
        }
        if let Some(r) = rules {
            r.place(self, f.root, parent, slot)?;
        }
        self.set_parent(f.root, parent, slot);
        if let Some(p) = place {
            self.set_at(f.root, p, None);
        }
        for s in &f.nodes {
            self.set_life(*s, Life::Live);
        }
        self.attach(f.root);
        self.redepth(&f.nodes);
        for (l, rec) in &f.links {
            self.link_put(*l, rec.clone());
        }
        Ok(())
    }

    // --- The fixtures' form --------------------------------------------------------------------------------------

    fn node_state(&self, rec: &NodeRec) -> NodeState {
        NodeState {
            kind: self.names[rec.kind as usize].clone(),
            parent: (rec.parent != NONE).then(|| self.nodes[rec.parent as usize].id),
            slot: rec.slot,
            audience: rec.audience,
            fields: rec.fields.clone(),
            place: self.place_of(rec).map(|p| {
                let frame = Frame {
                    node: rec.id,
                    slot: rec.slot,
                };
                match p.pose(frame).to_value() {
                    Value::Map(mut m) => {
                        m.remove(&1);
                        Value::Map(m)
                    }
                    _ => unreachable!("a pose is a map"),
                }
            }),
            motion: match rec.at {
                Where::Moving(ix) => self.moving[ix as usize].map(|m| {
                    Value::Map(BTreeMap::from([
                        (1, int(m.moved.at)),
                        (2, vec3(m.moved.linear)),
                        (3, vec3(m.moved.angular)),
                        (4, m.moved.owner.to_value()),
                    ]))
                }),
                _ => None,
            },
        }
    }

    fn link_state(&self, l: &LinkRec) -> LinkState {
        LinkState {
            ty: self.names[l.ty as usize].clone(),
            ends: l.ends,
            owner: l.owner,
            audience: l.audience,
        }
    }

    /// The tree in T6's fixture form, so that its `souls/fixture/1` hash can be compared with the harness's
    /// (`effects.md` rule 11). Links are written once; the indexes are derived and appear nowhere.
    pub fn to_state(&self) -> State {
        let nodes = self
            .nodes
            .iter()
            .filter(|r| r.life == Life::Live)
            .map(|r| (r.id, self.node_state(r)))
            .collect();
        let links = self
            .links
            .iter()
            .map(|(id, l)| (*id, self.link_state(l)))
            .collect();
        let in_flight = self
            .in_flight
            .iter()
            .map(|(id, f)| {
                let flight = Flight {
                    root: self.nodes[f.root as usize].id,
                    lineage: f.lineage,
                    zone: f.zone,
                    pose: f.pose,
                    nodes: f
                        .nodes
                        .iter()
                        .map(|s| {
                            let r = &self.nodes[*s as usize];
                            let mut n = self.node_state(r);
                            if *s == f.root {
                                n.parent = Some(f.from);
                            }
                            (r.id, n)
                        })
                        .collect(),
                    links: f
                        .links
                        .iter()
                        .map(|(id, l)| (*id, self.link_state(l)))
                        .collect(),
                };
                (*id, flight)
            })
            .collect();
        State {
            root: self.nodes[self.root as usize].id,
            next: self.next,
            nodes,
            links,
            in_flight,
            arrived: self.arrived.clone(),
            timers: self.timers.clone(),
            time: self.time.clone(),
        }
    }
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn vec3(v: Vec3) -> Value {
    Value::Array(vec![int(v.x), int(v.y), int(v.z)])
}
