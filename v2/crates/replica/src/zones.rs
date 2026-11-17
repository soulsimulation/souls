//! Space is zones (contract T1; Engine v2 T1, #2642). The rules are numbered in `v2/docs/zones.md`.
//!
//! A zone is a subtree with one writer and one log. Inside a tick, a [`System`] reads the others through [`Prev`] (the
//! previous tick, and nothing else) and writes only its own node through [`Own`]: the wrong access has no method.
//! Writes are data ([`Write`]), as they are when they come from a creator's module or a log, so the runner also
//! refuses one outside the system's node by name, and runs every tick in two orders to catch a same-tick read that
//! went around the types. A change that crosses zones is a [`Transfer`]: a leave in one log and an arrive in the
//! other, sharing the transfer's id; until the leaving zone settles it, it is in flight. Types, the check and
//! fixtures only: no runtime and no parallel ticking (N17 builds those).

use crate::encode::{self, Value, encode};
use crate::ids::{Exhausted, Hash, Held, Id, Minter, Purpose, Scope, arrive};
use crate::world_model::{Link, Node, show};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// A node's numbered fields, as systems read and write them.
pub type Fields = BTreeMap<u64, Value>;

/// One tick's state: every node's fields, by id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frame {
    pub tick: u64,
    pub nodes: BTreeMap<Id, Fields>,
}

impl Frame {
    /// The frame as one profile value, flat: `[tick, [[id, fields], ...]]` in id order.
    pub fn to_value(&self) -> Value {
        let nodes = self
            .nodes
            .iter()
            .map(|(id, f)| Value::Array(vec![id.to_value(), Value::Map(f.clone())]))
            .collect();
        Value::Array(vec![Value::Uint(self.tick), Value::Array(nodes)])
    }

    /// The `souls/fixture/1` hash of the frame's bytes, or the encoding's refusal (a field nested too deep).
    pub fn hash(&self) -> Result<Hash, encode::Refusal> {
        Ok(Hash::of(Purpose::Fixture, &encode(&self.to_value())?))
    }
}

/// The previous tick, read-only: the only read a system has (rule 2). There is no method for this tick's state.
#[derive(Clone, Copy, Debug)]
pub struct Prev<'a>(&'a Frame);

impl<'a> Prev<'a> {
    pub fn tick(self) -> u64 {
        self.0.tick
    }

    /// Any node's fields as of the previous tick.
    pub fn fields(self, node: Id) -> Option<&'a Fields> {
        self.0.nodes.get(&node)
    }
}

/// A system's own node: the only place it can write (rule 2). It names no other node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Own(Id);

impl Own {
    pub fn node(self) -> Id {
        self.0
    }

    pub fn set(self, field: u64, value: Value) -> Write {
        Write {
            node: self.0,
            field,
            value: Some(value),
        }
    }

    pub fn clear(self, field: u64) -> Write {
        Write {
            node: self.0,
            field,
            value: None,
        }
    }
}

/// One field of one node set (or cleared, `None`) for the next tick. Data, so it can come from a creator's module
/// or a log; the runner checks its node (rule 3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Write {
    pub node: Id,
    pub field: u64,
    pub value: Option<Value>,
}

/// One step of a tick, bound to one node.
pub trait System {
    /// The system's name, for refusals.
    fn name(&self) -> &str;
    /// Reads the previous tick and returns writes to its own node.
    fn step(&self, prev: Prev<'_>, own: Own) -> Vec<Write>;
}

/// A tick's systems, keyed by the node each writes: one writer per node, by the map's shape.
pub type Systems = BTreeMap<Id, Box<dyn System>>;

/// Why a tick, a leave or an arrive was refused. Each has a name ([`Fault::name`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fault {
    /// `write-outside-own`: a system wrote a node other than its own.
    WriteOutsideOwn { system: String, own: Id, wrote: Id },
    /// `read-same-tick`: a system wrote differently when the tick ran in another order, so it read something this
    /// tick wrote (or something outside the world, such as a clock).
    ReadSameTick { system: String, own: Id },
    /// `leave-not-here`: the node to leave is not in this zone, or is its root.
    LeaveNotHere(Id),
    /// `leave-holds-unowned`: a body would carry a thing its Soul does not own; it must be put down first.
    HoldsUnowned { body: Id, thing: Id },
    /// `arrive-parent-missing`: the place a transfer was sent to is not in this zone.
    ArriveParentMissing { transfer: Id, parent: Id },
    /// `log-without-start`: a log whose first record, and only its first, is not its start.
    LogWithoutStart,
    /// `log-out-of-step`: replaying a leave minted another transfer id than the record holds.
    LogOutOfStep(Id),
    /// `id-counter-exhausted` (T3).
    Exhausted(Exhausted),
}

impl Fault {
    pub fn name(&self) -> &'static str {
        match self {
            Fault::WriteOutsideOwn { .. } => "write-outside-own",
            Fault::ReadSameTick { .. } => "read-same-tick",
            Fault::LeaveNotHere(_) => "leave-not-here",
            Fault::HoldsUnowned { .. } => "leave-holds-unowned",
            Fault::ArriveParentMissing { .. } => "arrive-parent-missing",
            Fault::LogWithoutStart => "log-without-start",
            Fault::LogOutOfStep(_) => "log-out-of-step",
            Fault::Exhausted(_) => "id-counter-exhausted",
        }
    }
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Fault::Exhausted(e) = self {
            return write!(f, "{e}");
        }
        write!(f, "{}: ", self.name())?;
        match self {
            Fault::WriteOutsideOwn { system, own, wrote } => write!(
                f,
                "system {system} at {} wrote {}",
                show(*own),
                show(*wrote)
            ),
            Fault::ReadSameTick { system, own } => write!(
                f,
                "system {system} at {} wrote differently in another order",
                show(*own)
            ),
            Fault::LeaveNotHere(id) => {
                write!(f, "{} is not a node below this zone's root", show(*id))
            }
            Fault::HoldsUnowned { body, thing } => write!(
                f,
                "body {} holds {}, which its Soul does not own",
                show(*body),
                show(*thing)
            ),
            Fault::ArriveParentMissing { transfer, parent } => write!(
                f,
                "transfer {} is sent to {}, which is not here",
                show(*transfer),
                show(*parent)
            ),
            Fault::LogOutOfStep(t) => {
                write!(f, "the leave of transfer {} replays out of step", show(*t))
            }
            Fault::LogWithoutStart => write!(f, "a log starts with one start record"),
            Fault::Exhausted(_) => Ok(()),
        }
    }
}

impl std::error::Error for Fault {}

impl From<Exhausted> for Fault {
    fn from(e: Exhausted) -> Fault {
        Fault::Exhausted(e)
    }
}

/// Runs every system once against `prev`, in `order` (an id with no system is skipped), and returns the next frame.
pub fn run_in_order(prev: &Frame, systems: &Systems, order: &[Id]) -> Result<Frame, Fault> {
    run(prev, systems, order).map(|(next, _)| next)
}

fn run(
    prev: &Frame,
    systems: &Systems,
    order: &[Id],
) -> Result<(Frame, BTreeMap<Id, Vec<Write>>), Fault> {
    let mut next = prev.clone();
    next.tick = prev.tick.saturating_add(1);
    let mut wrote = BTreeMap::new();
    for node in order {
        let Some(system) = systems.get(node) else {
            continue;
        };
        let writes = system.step(Prev(prev), Own(*node));
        for w in &writes {
            if w.node != *node {
                return Err(Fault::WriteOutsideOwn {
                    system: system.name().to_owned(),
                    own: *node,
                    wrote: w.node,
                });
            }
            let fields = next.nodes.entry(*node).or_default();
            match &w.value {
                Some(v) => fields.insert(w.field, v.clone()),
                None => fields.remove(&w.field),
            };
        }
        wrote.insert(*node, writes);
    }
    Ok((next, wrote))
}

/// One tick (rules 2 and 3): every system reads `prev` and writes its own node. The tick is run in id order and in
/// reverse; a system whose writes differ between the two is refused as `read-same-tick`, and any write outside a
/// system's node as `write-outside-own`. Returns the next frame.
pub fn tick(prev: &Frame, systems: &Systems) -> Result<Frame, Fault> {
    let forward: Vec<Id> = systems.keys().copied().collect();
    let reverse: Vec<Id> = forward.iter().rev().copied().collect();
    let (next, first) = run(prev, systems, &forward)?;
    let (again, second) = run(prev, systems, &reverse)?;
    for (node, writes) in &first {
        if second.get(node) != Some(writes) {
            return Err(Fault::ReadSameTick {
                system: systems.get(node).map_or("", |s| s.name()).to_owned(),
                own: *node,
            });
        }
    }
    debug_assert_eq!(next, again, "equal writes to own nodes give equal frames");
    Ok(next)
}

// ---- Transfers: a paired leave and arrive ------------------------------------------------------------------------

/// The link type joining a body to its Soul, and the one by which a Soul owns a thing (as in the T2 fixtures).
pub const BODY_OF: &str = "body-of";
pub const OWNS: &str = "owns";

/// Where a transfer is sent: a zone, and the node (and slot) its root arrives under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Place {
    pub zone: Id,
    pub parent: Id,
    pub slot: Option<u64>,
}

/// A subtree on its way between zones (rule 5): the leave and the arrive both carry it, under one id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    /// Minted by the leaving zone's writer, from its own scope.
    pub id: Id,
    /// The lineage of the world it leaves. An arrival from another lineage goes through T3's rule 6.
    pub lineage: Scope,
    pub to: Place,
    /// The subtree, its root first and every parent before its children.
    pub nodes: Vec<Node>,
    /// The links whose every end is in the subtree or a Soul.
    pub links: Vec<Link>,
    /// The links between the subtree and a node that stays; the leave ends them.
    pub ended: Vec<Link>,
    /// Each carried id that arrived somewhere under a new id, and the id it came with.
    pub origins: BTreeMap<Id, Id>,
}

/// A zone's log, one record per change. Replaying it rebuilds the zone exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Record {
    /// The zone's first record: its writer's minter and held ids, and its nodes and links.
    Start {
        id: Id,
        lineage: Scope,
        minter: Minter,
        held: Held,
        nodes: Vec<Node>,
        links: Vec<Link>,
    },
    /// A subtree left; it is in flight until settled.
    Leave(Transfer),
    /// A subtree arrived. A second arrive of one transfer id changes nothing.
    Arrive(Transfer),
    /// The destination's arrive is durable; the transfer is no longer in flight.
    Settle(Id),
}

/// One zone: a subtree with one writer and one log (rule 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Zone {
    id: Id,
    lineage: Scope,
    minter: Minter,
    held: Held,
    nodes: BTreeMap<Id, Node>,
    links: BTreeMap<Id, Link>,
    in_flight: BTreeMap<Id, Transfer>,
    arrived: BTreeSet<Id>,
    origins: BTreeMap<Id, Id>,
    log: Vec<Record>,
}

impl Zone {
    /// A zone from its first record's contents. Its id is its root node's.
    pub fn start(
        id: Id,
        lineage: Scope,
        minter: Minter,
        held: Held,
        nodes: Vec<Node>,
        links: Vec<Link>,
    ) -> Result<Zone, Fault> {
        Zone::replay(&[Record::Start {
            id,
            lineage,
            minter,
            held,
            nodes,
            links,
        }])
    }

    /// The zone its log describes: what a writer has after a stop and a restart. The log starts with its
    /// [`Record::Start`].
    pub fn replay(log: &[Record]) -> Result<Zone, Fault> {
        let Some((
            first @ Record::Start {
                id,
                lineage,
                minter,
                held,
                ..
            },
            rest,
        )) = log.split_first()
        else {
            return Err(Fault::LogWithoutStart);
        };
        let mut zone = Zone {
            id: *id,
            lineage: *lineage,
            minter: minter.clone(),
            held: held.clone(),
            nodes: BTreeMap::new(),
            links: BTreeMap::new(),
            in_flight: BTreeMap::new(),
            arrived: BTreeSet::new(),
            origins: BTreeMap::new(),
            log: Vec::new(),
        };
        zone.write(first.clone())?;
        for r in rest {
            zone.write(r.clone())?;
        }
        Ok(zone)
    }

    pub fn id(&self) -> Id {
        self.id
    }

    pub fn log(&self) -> &[Record] {
        &self.log
    }

    pub fn node(&self, id: Id) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn links(&self) -> impl Iterator<Item = &Link> {
        self.links.values()
    }

    /// The id a node arrived with, if it arrived under a new one.
    pub fn origin(&self, id: Id) -> Option<Id> {
        self.origins.get(&id).copied()
    }

    /// Transfers that left and are not yet settled. After a restart, each is sent again (rule 6).
    pub fn in_flight(&self) -> impl Iterator<Item = &Transfer> {
        self.in_flight.values()
    }

    /// Appends `record` to the log and applies it. Every change goes through here, so replay is the same code.
    fn write(&mut self, record: Record) -> Result<(), Fault> {
        self.apply(&record)?;
        self.log.push(record);
        Ok(())
    }

    fn apply(&mut self, record: &Record) -> Result<(), Fault> {
        match record {
            Record::Start { nodes, links, .. } => {
                if !self.log.is_empty() {
                    return Err(Fault::LogWithoutStart);
                }
                self.nodes = nodes.iter().map(|n| (n.id, n.clone())).collect();
                self.links = links.iter().map(|l| (l.id, l.clone())).collect();
            }
            Record::Leave(t) => {
                if self.minter.mint()? != t.id {
                    return Err(Fault::LogOutOfStep(t.id));
                }
                self.held.minted(t.id);
                for n in &t.nodes {
                    self.nodes.remove(&n.id);
                }
                for l in t.links.iter().chain(&t.ended) {
                    self.links.remove(&l.id);
                }
                self.in_flight.insert(t.id, t.clone());
            }
            Record::Arrive(t) => {
                if !self.arrived.insert(t.id) {
                    return Ok(());
                }
                self.land(t)?;
            }
            Record::Settle(id) => {
                self.in_flight.remove(id);
            }
        }
        Ok(())
    }

    /// The node ids of the subtree under `root`, root first and every parent before its children (a loop, not
    /// recursion: depth is data).
    fn subtree(&self, root: Id) -> Vec<Id> {
        let mut children: BTreeMap<Id, Vec<Id>> = BTreeMap::new();
        for n in self.nodes.values() {
            if let Some(p) = n.parent {
                children.entry(p).or_default().push(n.id);
            }
        }
        let mut out = vec![root];
        let mut at = 0;
        while let Some(id) = out.get(at).copied() {
            out.extend(children.get(&id).into_iter().flatten().copied());
            at += 1;
        }
        out
    }

    /// The Soul a body belongs to, from its `body-of` link.
    fn soul_of(&self, body: Id) -> Option<Id> {
        self.links.values().find_map(|l| match l.ends {
            [b, s] if l.ty == BODY_OF && b == body => Some(s),
            [s, b] if l.ty == BODY_OF && b == body => Some(s),
            _ => None,
        })
    }

    /// The subtree under `root` leaves for `to` (rule 5). The leave is written to this zone's log and the transfer
    /// is in flight until [`Zone::settle`]. A body leaves only with things its Soul owns (rule 7).
    pub fn leave(&mut self, root: Id, to: Place) -> Result<Transfer, Fault> {
        if root == self.id || !self.nodes.contains_key(&root) {
            return Err(Fault::LeaveNotHere(root));
        }
        let ids = self.subtree(root);
        let inside: BTreeSet<Id> = ids.iter().copied().collect();
        if let Some(soul) = self.soul_of(root) {
            let owned = |thing: Id| {
                self.links
                    .values()
                    .any(|l| l.ty == OWNS && l.ends.contains(&soul) && l.ends.contains(&thing))
            };
            if let Some(thing) = ids[1..].iter().copied().find(|t| !owned(*t)) {
                return Err(Fault::HoldsUnowned { body: root, thing });
            }
        }
        let (mut links, mut ended) = (Vec::new(), Vec::new());
        for l in self.links.values() {
            let here = |e: &Id| inside.contains(e);
            if !l.ends.iter().any(here) {
                continue;
            }
            // An end that is neither in the subtree nor a node of this zone is a Soul: Souls are global.
            if l.ends
                .iter()
                .all(|e| here(e) || !self.nodes.contains_key(e))
            {
                links.push(l.clone());
            } else {
                ended.push(l.clone());
            }
        }
        let transfer = Transfer {
            id: self.minter.clone().mint()?,
            lineage: self.lineage,
            to,
            nodes: ids.iter().map(|id| self.nodes[id].clone()).collect(),
            links,
            ended,
            origins: ids
                .iter()
                .filter_map(|id| self.origins.get(id).map(|o| (*id, *o)))
                .collect(),
        };
        self.write(Record::Leave(transfer.clone()))?;
        Ok(transfer)
    }

    /// The destination's arrive of `transfer` is durable: it is no longer in flight here.
    pub fn settle(&mut self, transfer: Id) -> Result<(), Fault> {
        match self.in_flight.contains_key(&transfer) {
            true => self.write(Record::Settle(transfer)),
            false => Ok(()),
        }
    }

    /// Applies the transfers arriving in one tick, one after another, in transfer id order whatever order they
    /// were delivered in (rule 6). A transfer already applied is skipped and not logged again. Returns how many
    /// arrived.
    pub fn arrive_all(&mut self, transfers: &[Transfer]) -> Result<u64, Fault> {
        let mut by_id: BTreeMap<Id, &Transfer> = BTreeMap::new();
        for t in transfers {
            by_id.insert(t.id, t);
        }
        let mut count = 0;
        for t in by_id.into_values() {
            if self.arrived.contains(&t.id) {
                continue;
            }
            if !self.nodes.contains_key(&t.to.parent) {
                return Err(Fault::ArriveParentMissing {
                    transfer: t.id,
                    parent: t.to.parent,
                });
            }
            self.write(Record::Arrive(t.clone()))?;
            count += 1;
        }
        Ok(count)
    }

    /// Puts an arriving subtree in place. Within one lineage every id is kept (the world already holds it); from
    /// another, each id goes through T3's `arrive` against this writer's held ids, one at a time, so an id that
    /// arrived earlier in the same tick is known to the next (rule 6).
    fn land(&mut self, t: &Transfer) -> Result<(), Fault> {
        let mut rename: BTreeMap<Id, Id> = BTreeMap::new();
        let mut origins = t.origins.clone();
        if t.lineage != self.lineage {
            let ids = t
                .nodes
                .iter()
                .map(|n| n.id)
                .chain(t.links.iter().map(|l| l.id));
            for id in ids {
                let got = arrive(id, &mut self.held, &mut self.minter)?;
                if let Some(origin) = got.origin {
                    origins.remove(&id);
                    origins.insert(got.id, origin);
                }
                rename.insert(id, got.id);
            }
        }
        let new = |id: Id| rename.get(&id).copied().unwrap_or(id);
        for (i, n) in t.nodes.iter().enumerate() {
            let mut n = n.clone();
            n.id = new(n.id);
            if i == 0 {
                n.parent = Some(t.to.parent);
                n.slot = t.to.slot;
            } else {
                n.parent = n.parent.map(new);
            }
            self.nodes.insert(n.id, n);
        }
        for l in &t.links {
            let mut l = l.clone();
            l.id = new(l.id);
            l.ends = l.ends.map(new);
            self.links.insert(l.id, l);
        }
        self.origins.extend(origins);
        Ok(())
    }
}

/// A minter for `scope` that has already given out every counter in `ids` of that scope: the state of a writer
/// whose earlier mints are those ids. Mints one by one, so it is for fixtures only.
pub fn minter_past(
    scope: Scope,
    ids: impl IntoIterator<Item = Id>,
) -> Result<(Minter, Held), Fault> {
    let mut held = Held::default();
    let mut minter = Minter::new(scope);
    let mut next = 0;
    for id in ids.into_iter().filter(|i| i.scope() == scope) {
        held.minted(id);
        next = next.max(id.counter() + 1);
    }
    for _ in 0..next {
        minter.mint()?;
    }
    Ok((minter, held))
}

/// The two zones of the transfer fixture (`fixtures/zones/`), as written.
pub const FIXTURE_ZONE_A: &str = include_str!("../fixtures/zones/zone-a.diag");
pub const FIXTURE_ZONE_B: &str = include_str!("../fixtures/zones/zone-b.diag");

/// The scope zone B's writer mints from: a second zone writer gets a fresh scope (`v2/docs/ids.md` rule 1).
pub const FIXTURE_SCOPE_ZONE_B: Scope = Scope([0xb2; 16]);
