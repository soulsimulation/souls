//! The tree's half of a checkpoint (Engine v2 K5, #2669; contracts T3 and T11): each node's hash, the records a
//! checkpoint writes, and a tree read back from them. The files, the trigger and the restart are `sim::checkpoint`.
//!
//! - **A node's record** is `{1: id, 2: kind, 3: parent, 4: slot, 5: audience, 6: fields, 7: pose, 8: hand-off,
//!   9: links, 10: children}`: 3 and 4 when it has them, 7 while still and 8 while moving (none for the zone's root),
//!   9 the links it owns that share its audience, `[[id, link], ...]` in id order, and 10 the hashes of its children
//!   that share its audience, in id order. Its hash is T3's: `souls/state-public/1` for a public node,
//!   `souls/state-private/1` for a private one, over the record's bytes, so it covers its children's hashes.
//! - **Public and private are hashed apart** (T3 rule 11): no hash covers a node, a link or a timer of another
//!   audience. A node whose parent has another audience (and the zone's root) is a **top**, listed by its audience.
//! - **An audience's record** is `{1: audience, 2: [top hash, ...], 3: links, 4: timers, 5: flights}`, the tops in
//!   id order, 3 the links its audience holds that their owner's record does not (an owner of another audience), 4
//!   the timers of its nodes and 5 the subtrees in flight whose root is its; the public one adds `{6: next,
//!   7: arrived, 8: time}`. Its hash, with its audience's label, is that audience's **state hash**. The root record
//!   (`sim::checkpoint`) names each.
//! - **Sealing hashes only what changed:** a change marks its node and the node's ancestors (`touch` in the tree), and
//!   a seal walks down from the tops into marked nodes only. The tops, loose links, timers and flights are listed
//!   again at each seal: a scan without hashing, small beside hashing every node.
//! - **Timers are the smallest seam** while K9 builds the due list: written whole, per audience, at each seal.
//! - **The state hash each tick** (K20, #3395; [`Tree::state_hashes`]) is the same audiences' hashes, worked out the
//!   same way under a mark of its own: a change clears both marks, the state hash sets only its own and keeps no
//!   record, so it never takes a record from the next checkpoint; a seal sets both. A tree no part has touched since
//!   the last gives the same hashes without a scan. [`Tree::state_hashes_whole`] hashes every node, for checks.

use super::{Away, Life, LinkRec, Moved, NONE, NodeRec, Place, R, Tree, Where, refuse, show};
use crate::effects::{TimerState, read_id};
use crate::encode::{Name, Value, decode, encode, to_hex};
use crate::ids::{Hash, Id, Purpose, Scope};
use crate::pose::{Frame, HandOff, Pose};
use crate::time::TimeEffect;
use crate::world_model::{Audience, End};
use std::collections::{BTreeMap, BTreeSet};

/// What a seal gives: the records of nodes hashed again, and each audience's record, with their hashes.
pub struct Sealed {
    /// `(hash, record)` of each node whose hash was worked out again, new or not.
    pub nodes: Vec<(Hash, Vec<u8>)>,
    /// `(audience, state hash, record)`, the public audience first.
    pub audiences: Vec<(Audience, Hash, Vec<u8>)>,
}

impl Sealed {
    /// Each audience's state hash.
    pub fn hashes(&self) -> BTreeMap<Audience, Hash> {
        self.audiences.iter().map(|(a, h, _)| (*a, *h)).collect()
    }
}

/// A scan of the tree without hashing ([`Tree::scan`]): every audience, each one's tops by slot in id order, and its
/// loose links, timers and flights.
struct Scan {
    all: BTreeSet<Audience>,
    tops: BTreeMap<Audience, Vec<u32>>,
    loose: BTreeMap<Audience, BTreeMap<Id, Value>>,
    timers: BTreeMap<Audience, Vec<Value>>,
    flights: BTreeMap<Audience, Vec<Value>>,
}

fn purpose(a: Audience) -> Purpose {
    match a {
        Audience::Everyone => Purpose::StatePublic,
        Audience::Of(_) => Purpose::StatePrivate,
    }
}

fn bytes_of(v: &Value) -> R<Vec<u8>> {
    encode(v).or_else(|e| refuse("encoding", e.to_string()))
}

fn audience_value(a: Audience) -> Value {
    match a {
        Audience::Everyone => Value::Map(BTreeMap::from([(1, Value::Uint(1))])),
        Audience::Of(id) => Value::Map(BTreeMap::from([(1, Value::Uint(2)), (2, id.to_value())])),
    }
}

fn link_value(names: &[Name], l: &LinkRec) -> Value {
    Value::Map(BTreeMap::from([
        (1, Value::Text(names[l.ty as usize].clone())),
        (
            2,
            Value::Array(vec![l.ends[0].to_value(), l.ends[1].to_value()]),
        ),
        (3, Value::Uint(u64::from(l.owner == End::Second))),
        (4, audience_value(l.audience)),
    ]))
}

fn pair(id: Id, v: Value) -> Value {
    Value::Array(vec![id.to_value(), v])
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

impl Tree {
    /// A node's record without its children (field 10), its parent given (a flight's root names the node it left).
    fn record(&self, rec: &NodeRec, parent: Option<Id>) -> Value {
        let mut m = BTreeMap::from([
            (1, rec.id.to_value()),
            (2, Value::Text(self.names[rec.kind as usize].clone())),
            (5, audience_value(rec.audience)),
            (6, Value::Map(rec.fields.clone())),
        ]);
        m.extend(parent.map(|p| (3, p.to_value())));
        m.extend(rec.slot.map(|s| (4, Value::Uint(s))));
        let frame = |node| Frame {
            node,
            slot: rec.slot,
        };
        match (rec.at, parent) {
            (Where::Still(p), Some(parent)) => {
                m.insert(7, p.pose(frame(parent)).to_value());
            }
            (Where::Moving(ix), Some(parent)) => {
                if let Some(mv) = self.moving[ix as usize] {
                    let h = HandOff {
                        node: rec.id,
                        at: mv.moved.at,
                        from: mv.moved.owner,
                        to: mv.moved.owner,
                        pose: mv.place.pose(frame(parent)),
                        linear: mv.moved.linear,
                        angular: mv.moved.angular,
                    };
                    m.insert(8, h.to_value());
                }
            }
            _ => {}
        }
        let owned: Vec<Value> = rec
            .links
            .iter()
            .filter_map(|e| {
                let l = self.links.get(&e.link)?;
                (l.owning() == rec.id && l.audience == rec.audience)
                    .then(|| pair(e.link, link_value(&self.names, l)))
            })
            .collect();
        m.insert(9, Value::Array(owned));
        Value::Map(m)
    }

    fn parent_id(&self, rec: &NodeRec) -> Option<Id> {
        (rec.parent != NONE).then(|| self.nodes[rec.parent as usize].id)
    }

    /// A node's record and its hash, given its children's hashes (those that share its audience, in id order).
    fn node_record(&self, slot: u32, children: Vec<Value>) -> R<(Hash, Vec<u8>)> {
        let rec = &self.nodes[slot as usize];
        let Value::Map(mut m) = self.record(rec, self.parent_id(rec)) else {
            unreachable!("a record is a map")
        };
        m.insert(10, Value::Array(children));
        let bytes = bytes_of(&Value::Map(m))?;
        Ok((Hash::of(purpose(rec.audience), &bytes), bytes))
    }

    /// The children of a node that share its audience, in id order: those its hash covers.
    fn covered(&self, slot: u32) -> Vec<u32> {
        let a = self.nodes[slot as usize].audience;
        self.nodes[slot as usize]
            .children
            .iter()
            .map(|h| h.slot)
            .filter(|c| self.nodes[*c as usize].audience == a)
            .collect()
    }

    /// The node's hash, worked out again (with its marked children first) if it is marked.
    fn seal_node(&mut self, slot: u32, out: &mut Vec<(Hash, Vec<u8>)>) -> R<Hash> {
        if let Some(h) = self.nodes[slot as usize].hash {
            return Ok(h);
        }
        let mut hashes = Vec::new();
        for c in self.covered(slot) {
            hashes.push(self.seal_node(c, out)?.to_value());
        }
        let (h, bytes) = self.node_record(slot, hashes)?;
        let rec = &mut self.nodes[slot as usize];
        (rec.hash, rec.state) = (Some(h), Some(h));
        out.push((h, bytes));
        Ok(h)
    }

    /// The node's hash for the state hash: as `seal_node`, by its own mark, keeping no record.
    fn state_node(&mut self, slot: u32) -> R<Hash> {
        if let Some(h) = self.nodes[slot as usize].state {
            return Ok(h);
        }
        let mut hashes = Vec::new();
        for c in self.covered(slot) {
            hashes.push(self.state_node(c)?.to_value());
        }
        let (h, _) = self.node_record(slot, hashes)?;
        self.nodes[slot as usize].state = Some(h);
        self.rehashed += 1;
        Ok(h)
    }

    /// Nodes [`Tree::state_hashes`] has hashed again since the tree was built: a measure of its work.
    pub fn rehashed(&self) -> u64 {
        self.rehashed
    }

    /// The node's hash worked out whole, reading and writing no mark.
    fn whole_node(&self, slot: u32) -> R<Hash> {
        let mut hashes = Vec::new();
        for c in self.covered(slot) {
            hashes.push(self.whole_node(c)?.to_value());
        }
        Ok(self.node_record(slot, hashes)?.0)
    }

    /// Each audience's tops (by slot, in id order), loose links, timers and flights: a scan without hashing.
    fn scan(&self) -> Scan {
        let mut ids: BTreeMap<Audience, BTreeMap<Id, u32>> = BTreeMap::new();
        ids.entry(Audience::Everyone).or_default();
        for (slot, rec) in self.nodes.iter().enumerate() {
            if rec.life != Life::Live {
                continue;
            }
            if rec.parent == NONE || self.nodes[rec.parent as usize].audience != rec.audience {
                ids.entry(rec.audience)
                    .or_default()
                    .insert(rec.id, slot as u32);
            }
        }
        let tops: BTreeMap<Audience, Vec<u32>> = ids
            .into_iter()
            .map(|(a, by)| (a, by.into_values().collect()))
            .collect();
        let mut loose: BTreeMap<Audience, BTreeMap<Id, Value>> = BTreeMap::new();
        for (id, l) in &self.links {
            let owner = self
                .by_id
                .get(&l.owning())
                .map(|s| &self.nodes[*s as usize]);
            if owner.is_none_or(|o| o.life != Life::Live || o.audience != l.audience) {
                loose
                    .entry(l.audience)
                    .or_default()
                    .insert(*id, link_value(&self.names, l));
            }
        }
        let mut timers: BTreeMap<Audience, Vec<Value>> = BTreeMap::new();
        for (id, t) in &self.timers {
            let a = self
                .by_id
                .get(&t.node)
                .map_or(Audience::Everyone, |s| self.nodes[*s as usize].audience);
            let v = Value::Map(BTreeMap::from([
                (1, t.node.to_value()),
                (2, int(t.due)),
                (3, Value::Text(t.name.clone())),
            ]));
            timers.entry(a).or_default().push(pair(*id, v));
        }
        let mut flights: BTreeMap<Audience, Vec<Value>> = BTreeMap::new();
        for (id, f) in &self.in_flight {
            let a = self.nodes[f.root as usize].audience;
            flights
                .entry(a)
                .or_default()
                .push(pair(*id, self.flight_value(f)));
        }
        let all = tops
            .keys()
            .chain(loose.keys())
            .chain(timers.keys())
            .chain(flights.keys())
            .copied()
            .collect();
        Scan {
            all,
            tops,
            loose,
            timers,
            flights,
        }
    }

    /// Each audience's record and state hash, the public one first, from a scan and each audience's tops' hashes.
    fn audiences(
        &self,
        mut scan: Scan,
        mut tops: BTreeMap<Audience, Vec<Value>>,
    ) -> R<Vec<(Audience, Hash, Vec<u8>)>> {
        let mut audiences = Vec::new();
        for a in std::mem::take(&mut scan.all) {
            let mut m = BTreeMap::from([
                (1, audience_value(a)),
                (2, Value::Array(tops.remove(&a).unwrap_or_default())),
                (
                    3,
                    Value::Array(
                        scan.loose
                            .remove(&a)
                            .unwrap_or_default()
                            .into_iter()
                            .map(|(id, v)| pair(id, v))
                            .collect(),
                    ),
                ),
                (4, Value::Array(scan.timers.remove(&a).unwrap_or_default())),
                (5, Value::Array(scan.flights.remove(&a).unwrap_or_default())),
            ]);
            if a == Audience::Everyone {
                m.insert(6, Value::Uint(self.next));
                m.insert(
                    7,
                    Value::Array(self.arrived.iter().map(|i| i.to_value()).collect()),
                );
                m.insert(
                    8,
                    Value::Array(self.time.iter().map(|t| t.to_value()).collect()),
                );
            }
            let bytes = bytes_of(&Value::Map(m))?;
            audiences.push((a, Hash::of(purpose(a), &bytes), bytes));
        }
        Ok(audiences)
    }

    /// Hashes every marked node and lists each audience's record: on the clock thread, between ticks.
    pub fn seal(&mut self) -> R<Sealed> {
        let scan = self.scan();
        let mut nodes = Vec::new();
        let mut tops = BTreeMap::new();
        for (a, slots) in &scan.tops {
            let mut hashes = Vec::with_capacity(slots.len());
            for slot in slots {
                hashes.push(self.seal_node(*slot, &mut nodes)?.to_value());
            }
            tops.insert(*a, hashes);
        }
        let audiences = self.audiences(scan, tops)?;
        let hashes = audiences.iter().map(|(a, h, _)| (*a, *h)).collect();
        self.kept = Some((self.changes, hashes));
        Ok(Sealed { nodes, audiences })
    }

    /// Each audience's state hash, the public one first: the hashes [`Tree::seal`] gives, worked out again only for
    /// the nodes changed since the last time and their ancestors (K20, #3395), plus a scan of the tops, loose links,
    /// timers and flights. A tree no part has touched since gives the same hashes unhashed. It writes no record and
    /// leaves the next seal's work as it was.
    pub fn state_hashes(&mut self) -> R<Vec<(Audience, Hash)>> {
        if let Some((at, h)) = &self.kept
            && *at == self.changes
        {
            return Ok(h.clone());
        }
        let scan = self.scan();
        let mut tops = BTreeMap::new();
        for (a, slots) in &scan.tops {
            let mut hashes = Vec::with_capacity(slots.len());
            for slot in slots {
                hashes.push(self.state_node(*slot)?.to_value());
            }
            tops.insert(*a, hashes);
        }
        let hashes: Vec<(Audience, Hash)> = self
            .audiences(scan, tops)?
            .into_iter()
            .map(|(a, h, _)| (a, h))
            .collect();
        self.kept = Some((self.changes, hashes.clone()));
        Ok(hashes)
    }

    /// [`Tree::state_hashes`] worked out whole: every node hashed, no mark read or written. For tests and checks.
    pub fn state_hashes_whole(&self) -> R<Vec<(Audience, Hash)>> {
        let scan = self.scan();
        let mut tops = BTreeMap::new();
        for (a, slots) in &scan.tops {
            let mut hashes = Vec::with_capacity(slots.len());
            for slot in slots {
                hashes.push(self.whole_node(*slot)?.to_value());
            }
            tops.insert(*a, hashes);
        }
        Ok(self
            .audiences(scan, tops)?
            .into_iter()
            .map(|(a, h, _)| (a, h))
            .collect())
    }

    /// Every node's record and each audience's record, worked out whole, reading and writing no mark (#3833): what
    /// [`Tree::unseal`] reads a tree back from, without the records an earlier seal already gave.
    pub fn seal_whole(&self) -> R<Sealed> {
        let scan = self.scan();
        let mut nodes = Vec::new();
        let mut tops = BTreeMap::new();
        for (a, slots) in &scan.tops {
            let mut hashes = Vec::with_capacity(slots.len());
            for slot in slots {
                hashes.push(self.whole_record(*slot, &mut nodes)?.to_value());
            }
            tops.insert(*a, hashes);
        }
        let audiences = self.audiences(scan, tops)?;
        Ok(Sealed { nodes, audiences })
    }

    fn whole_record(&self, slot: u32, out: &mut Vec<(Hash, Vec<u8>)>) -> R<Hash> {
        let mut hashes = Vec::new();
        for c in self.covered(slot) {
            hashes.push(self.whole_record(c, out)?.to_value());
        }
        let (h, bytes) = self.node_record(slot, hashes)?;
        out.push((h, bytes));
        Ok(h)
    }

    /// No change waits for a seal: the root holds its sealed hash, so every node does (a change marks its ancestors).
    pub fn sealed(&self) -> bool {
        self.nodes[self.root as usize].hash.is_some()
    }

    /// `{1: root, 2: lineage, 3: zone, 4: pose, 5: [node record, ...], 6: [[id, link], ...]}`, nodes and links in
    /// id order, the root's record naming the node it left as its parent.
    fn flight_value(&self, f: &Away) -> Value {
        let mut nodes: Vec<(Id, Value)> = f
            .nodes
            .iter()
            .map(|s| {
                let r = &self.nodes[*s as usize];
                let parent = if *s == f.root {
                    Some(f.from)
                } else {
                    self.parent_id(r)
                };
                (r.id, self.record(r, parent))
            })
            .collect();
        nodes.sort_by_key(|(id, _)| *id);
        let mut links: Vec<&(Id, LinkRec)> = f.links.iter().collect();
        links.sort_by_key(|(id, _)| *id);
        Value::Map(BTreeMap::from([
            (1, self.nodes[f.root as usize].id.to_value()),
            (2, Value::Bytes(f.lineage.0.to_vec())),
            (3, f.zone.to_value()),
            (4, f.pose.to_value()),
            (5, Value::Array(nodes.into_iter().map(|(_, v)| v).collect())),
            (
                6,
                Value::Array(
                    links
                        .into_iter()
                        .map(|(id, l)| pair(*id, link_value(&self.names, l)))
                        .collect(),
                ),
            ),
        ]))
    }

    /// Reads a tree back from a checkpoint: each audience's record by its state hash, then every node from the tops
    /// down. `fetch` gives the stored bytes named by a hash (34 bytes); each is checked against the hash that named
    /// it with its audience's label (`checkpoint-hash`), so one flipped byte anywhere is refused by name.
    pub fn unseal(
        audiences: &[(Audience, Vec<u8>)],
        fetch: &mut dyn FnMut(&[u8]) -> R<Vec<u8>>,
    ) -> R<Tree> {
        let mut read = |a: Audience, h: &[u8]| -> R<(Value, Hash)> {
            let bytes = fetch(h)?;
            let hash = Hash::of(purpose(a), &bytes);
            if hash.to_bytes() != h {
                return refuse(
                    "checkpoint-hash",
                    format!("{} does not hash to its name", to_hex(h)),
                );
            }
            decode(&bytes)
                .map(|d| (d.value, hash))
                .or_else(|e| refuse("checkpoint-record", e.to_string()))
        };
        let mut nodes: Vec<NodeIn> = Vec::new();
        let mut links: BTreeMap<Id, LinkIn> = BTreeMap::new();
        let mut timers = BTreeMap::new();
        let mut flights = Vec::new();
        let mut zone = None;
        for (a, h) in audiences {
            let mut m = map(read(*a, h)?.0)?;
            if read_audience(&take(&mut m, 1)?)? != *a {
                return refuse("checkpoint-record", "an audience's record names another");
            }
            let mut stack: Vec<Vec<u8>> = array(take(&mut m, 2)?)?
                .into_iter()
                .map(hash_bytes)
                .collect::<R<_>>()?;
            while let Some(h) = stack.pop() {
                let (v, hash) = read(*a, &h)?;
                let mut n = node_in(v, &mut links)?;
                if n.audience != *a {
                    return refuse(
                        "checkpoint-record",
                        format!("{} is not of its audience", show(n.id)),
                    );
                }
                stack.extend(std::mem::take(&mut n.children));
                n.hash = Some(hash);
                nodes.push(n);
            }
            for p in array(take(&mut m, 3)?)? {
                let (id, l) = link_in(p)?;
                links.insert(id, l);
            }
            for p in array(take(&mut m, 4)?)? {
                let (id, v) = id_pair(p)?;
                let mut t = map(v)?;
                let due = read_i64(&take(&mut t, 2)?)?;
                timers.insert(
                    id,
                    TimerState {
                        node: read_id(&take(&mut t, 1)?)?,
                        due,
                        name: text(take(&mut t, 3)?)?,
                    },
                );
            }
            for p in array(take(&mut m, 5)?)? {
                flights.push(id_pair(p)?);
            }
            if *a == Audience::Everyone {
                let next = uint(&take(&mut m, 6)?)?;
                let arrived = array(take(&mut m, 7)?)?
                    .iter()
                    .map(read_id)
                    .collect::<R<BTreeSet<_>>>()?;
                let time = array(take(&mut m, 8)?)?
                    .iter()
                    .map(|v| {
                        TimeEffect::from_value(v)
                            .or_else(|e| refuse("checkpoint-record", e.to_string()))
                    })
                    .collect::<R<Vec<_>>>()?;
                zone = Some((next, arrived, time));
            }
        }
        let Some((next, arrived, time)) = zone else {
            return refuse("checkpoint-record", "no public record");
        };
        let mut roots = nodes.iter().filter(|n| n.parent.is_none());
        let (Some(root), None) = (roots.next(), roots.next()) else {
            return refuse("checkpoint-record", "a zone has one root");
        };
        let mut t = Tree::start(root.id, root.kind.clone());
        let mut hashes = Vec::new();
        t.place_all(nodes, Life::Live, &mut hashes)?;
        for (id, f) in flights {
            let mut f = map(f)?;
            let root = read_id(&take(&mut f, 1)?)?;
            let lineage: [u8; 16] = bytes(take(&mut f, 2)?)?
                .try_into()
                .or_else(|_| refuse("checkpoint-record", "a lineage is 16 bytes"))?;
            let zone = read_id(&take(&mut f, 3)?)?;
            let pose = pose(&take(&mut f, 4)?)?;
            let mut carried = BTreeMap::new();
            let mut ns = Vec::new();
            for v in array(take(&mut f, 5)?)? {
                ns.push(node_in(v, &mut carried)?);
            }
            let from = ns
                .iter()
                .find(|n| n.id == root)
                .and_then(|n| n.parent)
                .map_or_else(
                    || refuse("checkpoint-record", "a flight without its root"),
                    Ok,
                )?;
            let placed = t.place_all(ns, Life::Flying, &mut Vec::new())?;
            for p in array(take(&mut f, 6)?)? {
                let (lid, l) = link_in(p)?;
                carried.insert(lid, l);
            }
            let links = carried
                .into_iter()
                .map(|(lid, l)| (lid, t.link_rec(l)))
                .collect();
            let root_slot = t.by_id[&root];
            t.in_flight.insert(
                id,
                Away {
                    root: root_slot,
                    from,
                    lineage: Scope(lineage),
                    zone,
                    pose,
                    nodes: placed,
                    links,
                },
            );
        }
        for (id, l) in links {
            let rec = t.link_rec(l);
            t.link_put(id, rec);
        }
        t.timers = timers;
        t.next = next;
        t.arrived = arrived;
        t.time = time;
        t.undo.clear();
        for (slot, h) in hashes {
            t.nodes[slot as usize].hash = Some(h);
            t.nodes[slot as usize].state = Some(h);
        }
        Ok(t)
    }

    fn link_rec(&mut self, l: LinkIn) -> LinkRec {
        LinkRec {
            ty: self.intern(&l.ty),
            ends: l.ends,
            owner: l.owner,
            audience: l.audience,
        }
    }

    /// Puts nodes read from records into the tree, parents first (the zone's root, already there, is filled in), as
    /// `life`: live nodes attached to their parents; a flight's root left detached, naming the node it left. Returns
    /// the slots placed, parents first.
    fn place_all(
        &mut self,
        nodes: Vec<NodeIn>,
        life: Life,
        hashes: &mut Vec<(u32, Hash)>,
    ) -> R<Vec<u32>> {
        let mut below: BTreeMap<Option<Id>, Vec<NodeIn>> = BTreeMap::new();
        let ids: BTreeSet<Id> = nodes.iter().map(|n| n.id).collect();
        for n in nodes {
            // A flight's root names the node it left, which is not in the flight.
            let key = n.parent.filter(|p| ids.contains(p));
            below.entry(key).or_default().push(n);
        }
        let mut order: Vec<NodeIn> = below.remove(&None).unwrap_or_default();
        let mut placed = Vec::new();
        let mut i = 0;
        while i < order.len() {
            let n = std::mem::replace(&mut order[i], NodeIn::empty());
            let id = n.id;
            let slot = self.place_one(n, life, hashes)?;
            placed.push(slot);
            order.extend(below.remove(&Some(id)).unwrap_or_default());
            i += 1;
        }
        if let Some(stray) = below.values().flatten().next() {
            return refuse(
                "checkpoint-record",
                format!("{} is under no node read", show(stray.id)),
            );
        }
        Ok(placed)
    }

    fn place_one(&mut self, n: NodeIn, life: Life, hashes: &mut Vec<(u32, Hash)>) -> R<u32> {
        let kind = self.intern(&n.kind);
        let root_id = self.nodes[self.root as usize].id;
        let slot = if n.id == root_id && life == Life::Live {
            let r = &mut self.nodes[self.root as usize];
            (r.kind, r.fields) = (kind, n.fields);
            self.root
        } else {
            let parent = n
                .parent
                .and_then(|p| self.by_id.get(&p).copied())
                .map_or_else(
                    || {
                        refuse(
                            "checkpoint-record",
                            format!("{}'s parent is missing", show(n.id)),
                        )
                    },
                    Ok,
                )?;
            let depth = self.nodes[parent as usize].depth.saturating_add(1);
            let links = self.elsewhere.remove(&n.id).unwrap_or_default();
            let slot = self.alloc(NodeRec {
                generation: 0,
                life,
                id: n.id,
                kind,
                parent,
                slot: n.slot,
                audience: n.audience,
                depth,
                children: Vec::new(),
                links,
                fields: n.fields,
                at: Where::Still(n.place.unwrap_or(Place {
                    position: crate::pose::Vec3::ZERO,
                    orientation: crate::pose::Quat::IDENTITY,
                    support: crate::pose::Support::None,
                })),
                hash: None,
                state: None,
            });
            // A flight's root stays out of the children of the node it left.
            let flight_root =
                life == Life::Flying && self.nodes[parent as usize].life == Life::Live;
            if !flight_root {
                self.attach(slot);
            }
            if let (Some(place), Some(moved)) = (n.place, n.moved) {
                self.set_at(slot, place, Some(moved));
            }
            slot
        };
        if let Some(h) = n.hash {
            hashes.push((slot, h));
        }
        Ok(slot)
    }
}

/// A node as a record gives it.
struct NodeIn {
    id: Id,
    kind: Name,
    parent: Option<Id>,
    slot: Option<u64>,
    audience: Audience,
    fields: BTreeMap<u64, Value>,
    place: Option<Place>,
    moved: Option<Moved>,
    children: Vec<Vec<u8>>,
    hash: Option<Hash>,
}

impl NodeIn {
    fn empty() -> NodeIn {
        NodeIn {
            id: Id::new(Scope([0; 16]), 0).expect("an id"),
            kind: Name::new("x").expect("a name"),
            parent: None,
            slot: None,
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
            place: None,
            moved: None,
            children: Vec::new(),
            hash: None,
        }
    }
}

struct LinkIn {
    ty: Name,
    ends: [Id; 2],
    owner: End,
    audience: Audience,
}

fn bad<T>(what: &str) -> R<T> {
    refuse("checkpoint-record", what.to_string())
}

fn map(v: Value) -> R<BTreeMap<u64, Value>> {
    match v {
        Value::Map(m) => Ok(m),
        _ => bad("not a map"),
    }
}

fn array(v: Value) -> R<Vec<Value>> {
    match v {
        Value::Array(a) => Ok(a),
        _ => bad("not an array"),
    }
}

fn bytes(v: Value) -> R<Vec<u8>> {
    match v {
        Value::Bytes(b) => Ok(b),
        _ => bad("not bytes"),
    }
}

fn text(v: Value) -> R<Name> {
    match v {
        Value::Text(t) => Ok(t),
        _ => bad("not text"),
    }
}

fn uint(v: &Value) -> R<u64> {
    match v {
        Value::Uint(u) => Ok(*u),
        _ => bad("not an unsigned integer"),
    }
}

fn read_i64(v: &Value) -> R<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).or_else(|_| bad("an integer out of range")),
        Value::Nint(n) => i64::try_from(*n)
            .map(|n| -1 - n)
            .or_else(|_| bad("an integer out of range")),
        _ => bad("not an integer"),
    }
}

fn take(m: &mut BTreeMap<u64, Value>, k: u64) -> R<Value> {
    m.remove(&k)
        .map_or_else(|| bad(&format!("field {k} is missing")), Ok)
}

fn hash_bytes(v: Value) -> R<Vec<u8>> {
    let b = bytes(v)?;
    if b.len() == 34 && b[0] == crate::ids::SHA2_256 && b[1] == 32 {
        Ok(b)
    } else {
        bad("not a SHA-256 multihash")
    }
}

fn id_pair(v: Value) -> R<(Id, Value)> {
    let mut a = array(v)?;
    if a.len() != 2 {
        return bad("not [id, value]");
    }
    let v = a.pop().expect("two");
    Ok((read_id(&a[0])?, v))
}

fn read_audience(v: &Value) -> R<Audience> {
    let Value::Map(m) = v else {
        return bad("an audience is not a map");
    };
    match (m.get(&1), m.get(&2)) {
        (Some(Value::Uint(1)), None) => Ok(Audience::Everyone),
        (Some(Value::Uint(2)), Some(id)) => Ok(Audience::Of(read_id(id)?)),
        _ => bad("an audience is 1 everyone or 2 an id"),
    }
}

fn pose(v: &Value) -> R<Pose> {
    Pose::from_value(v).or_else(|e| refuse("checkpoint-record", e.name()))
}

fn link_in(v: Value) -> R<(Id, LinkIn)> {
    let (id, v) = id_pair(v)?;
    let mut m = map(v)?;
    let ends = array(take(&mut m, 2)?)?;
    let [a, b] = ends.as_slice() else {
        return bad("a link has two ends");
    };
    Ok((
        id,
        LinkIn {
            ty: text(take(&mut m, 1)?)?,
            ends: [read_id(a)?, read_id(b)?],
            owner: if uint(&take(&mut m, 3)?)? == 1 {
                End::Second
            } else {
                End::First
            },
            audience: read_audience(&take(&mut m, 4)?)?,
        },
    ))
}

/// A node's record; the links it owns go into `links`.
fn node_in(v: Value, links: &mut BTreeMap<Id, LinkIn>) -> R<NodeIn> {
    let mut m = map(v)?;
    let mut n = NodeIn {
        id: read_id(&take(&mut m, 1)?)?,
        kind: text(take(&mut m, 2)?)?,
        parent: m.remove(&3).map(|p| read_id(&p)).transpose()?,
        slot: m.remove(&4).map(|s| uint(&s)).transpose()?,
        audience: read_audience(&take(&mut m, 5)?)?,
        fields: map(take(&mut m, 6)?)?,
        place: None,
        moved: None,
        children: Vec::new(),
        hash: None,
    };
    if let Some(p) = m.remove(&7) {
        n.place = Some(Place::of(&pose(&p)?));
    }
    if let Some(h) = m.remove(&8) {
        let h = HandOff::from_value(&h).or_else(|e| refuse("checkpoint-record", e.name()))?;
        n.place = Some(Place::of(&h.pose));
        n.moved = Some(Moved {
            at: h.at,
            linear: h.linear,
            angular: h.angular,
            owner: h.to,
        });
    }
    for p in array(take(&mut m, 9)?)? {
        let (id, l) = link_in(p)?;
        links.insert(id, l);
    }
    if let Some(c) = m.remove(&10) {
        n.children = array(c)?.into_iter().map(hash_bytes).collect::<R<_>>()?;
    }
    Ok(n)
}
