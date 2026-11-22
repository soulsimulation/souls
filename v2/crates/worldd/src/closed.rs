//! What a closed container holds stays with its audience (hide-and-seek parity, #3915; SA-F8 section 9, E22's rule
//! for a sync). A kind whose entry declares `closed` (`{"audience": rule, "fields": [...]}`) keeps its children
//! out of every other Soul's copy: the sync thread answers a record under one with empty bytes, as for a node not
//! granted, so the asker's copy never holds its id, kind, name or place.
//!
//! - **Who sees in.** The rule's audience, resolved at the container now: `owner` the Souls at the far end of its
//!   `souls:owns` links, `{linked, link: L}` those of its `<namespace>:L` links (a body end counted as its Soul by
//!   `souls:body-of`), `creator` the world's creator. Also the Soul that put the thing in (the hider), and the world's
//!   creator always. A thing deeper inside (a ring in a bag in the stump) goes with the child of the container that
//!   holds it.
//! - **Who put it in** is read from the log as the sync copy applies it: a Soul's entry that moves a node so that it
//!   lands in a closed container. Only this process's run is known: after a restart the hider sees it again once it
//!   takes it out, and until then it is withheld from the hider too (closed, never open, on a doubt).
//! - **The rule never reads a kind's words or a clock,** only the entries' `closed` sections, the tree and the log.
//!
//! The public stream on disk (V1, #3948) asks as nobody: what is in a closed container is out of its state
//! ([`Closed::hidden`], [`Closed::hides`]) and its entries ([`Inside`]) until it is taken out (`view_out`).

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use replica::effects::{Actor, Body, Change, Part, TransferRec, read_id};
use replica::encode::{Value, decode, encode};
use replica::ids::{Hash, Id, Purpose};
use replica::rules::json::Value as Json;
use replica::tree::Tree;
use replica::world_model::plain;

/// The `souls:body-of` link that names a body's Soul.
const BODY_OF: &str = "souls:body-of";
/// The one owner relation (T8 rule 2).
const OWNS: &str = "souls:owns";

/// Who sees into a closed container besides the hider and the creator.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Rule {
    /// Nobody else (the world's creator).
    Creator,
    /// The Souls at the far end of `souls:owns` at the container.
    Owner,
    /// The Souls at the far end of this link type at the container.
    Linked(String),
}

/// The closed kinds of a world's entries, by plain kind (`namespace:name`).
#[derive(Clone, Debug, Default)]
pub struct Closed {
    kinds: BTreeMap<String, Rule>,
}

impl Closed {
    /// The closed sections of `entries` (`(kind, entry)`); an entry with none, or an audience rule outside the
    /// closed list, adds nothing.
    pub fn of(entries: &[(String, Json)]) -> Closed {
        let mut kinds = BTreeMap::new();
        for (kind, entry) in entries {
            let Some(a) = entry.get("closed").and_then(|c| c.get("audience")) else {
                continue;
            };
            let rule = match a.get("rule").and_then(Json::str) {
                Some("creator") => Rule::Creator,
                Some("owner") => Rule::Owner,
                Some("linked") => match a.get("link").and_then(Json::str) {
                    Some(l) => {
                        let ns = kind.split(':').next().unwrap_or(kind);
                        Rule::Linked(format!("{ns}:{l}"))
                    }
                    None => continue,
                },
                // `everyone` keeps nothing apart.
                _ => continue,
            };
            kinds.insert(kind.clone(), rule);
        }
        Closed { kinds }
    }

    pub fn is_empty(&self) -> bool {
        self.kinds.is_empty()
    }

    fn rule(&self, tree: &Tree, id: Id) -> Option<&Rule> {
        let n = tree.node(tree.handle(id)?)?;
        self.kinds.get(plain(n.kind().as_str()))
    }

    /// The closed container `id` is in, and the child of it that holds `id` (`id` itself when directly in it).
    fn container_of(&self, tree: &Tree, id: Id) -> Option<(Id, Id)> {
        let mut child = id;
        let mut at = tree.node(tree.handle(id)?)?.parent();
        while let Some(p) = at {
            if self.rule(tree, p).is_some() {
                return Some((p, child));
            }
            child = p;
            at = tree.node(tree.handle(p)?)?.parent();
        }
        None
    }

    /// Whether `id` is in a closed container: what [`Withhold::withheld`] answers an asker who is nobody, the public.
    pub fn hides(&self, tree: &Tree, id: Id) -> bool {
        !self.kinds.is_empty() && self.container_of(tree, id).is_some()
    }

    /// Every node of `tree` in a closed container, at any depth: those [`Closed::hides`].
    pub fn hidden(&self, tree: &Tree) -> BTreeSet<Id> {
        let mut out = BTreeSet::new();
        if self.kinds.is_empty() {
            return out;
        }
        let mut todo = vec![(tree.root(), false)];
        while let Some((h, under)) = todo.pop() {
            let Some(n) = tree.node(h) else { continue };
            if under {
                out.insert(n.id());
            }
            let container = self.kinds.contains_key(plain(n.kind().as_str()));
            for &c in tree.children(h).unwrap_or_default() {
                todo.push((c, under || container));
            }
        }
        out
    }

    /// Whether `soul` is in the container's rule's audience now.
    fn in_audience(tree: &Tree, container: Id, rule: &Rule, soul: Id) -> bool {
        let ty = match rule {
            Rule::Creator => return false,
            Rule::Owner => OWNS,
            Rule::Linked(l) => l.as_str(),
        };
        tree.links_at(container)
            .iter()
            .filter(|e| plain(tree.ty(e).as_str()) == ty)
            .any(|e| soul_of(tree, e.other) == soul)
    }
}

/// A body's Soul by its `souls:body-of` link; any other id (a Soul, which is no node of the tree) is its own.
fn soul_of(tree: &Tree, id: Id) -> Id {
    if tree.handle(id).is_none() {
        return id;
    }
    tree.links_at(id)
        .iter()
        .find(|e| plain(tree.ty(e).as_str()) == BODY_OF)
        .map_or(id, |e| e.other)
}

/// The most records of askers' past redactions kept, oldest let go first: for a descent that spans versions. A Soul's
/// current redaction keeps its own records, which nothing lets go while it is current.
pub(crate) const MADE_MOST: usize = 4096;

/// One asker's view of the sealed tree with the closed contents it may not see left out: each container that holds
/// some has a record without their hashes, and so has each ancestor up to its top, each with its own hash, so the
/// asker's copy checks every record against the hash that named it and never holds a withheld child's hash.
#[derive(Default)]
pub(crate) struct Redaction {
    /// Each rewritten node's hash for this asker.
    hashes: BTreeMap<Id, Hash>,
    /// The real hashes of the rewritten records: never served to this asker.
    replaced: BTreeSet<Vec<u8>>,
    /// The rewritten records by their hash.
    records: BTreeMap<Vec<u8>, Vec<u8>>,
}

/// The sync thread's side: the closed kinds, who put each thing in, and the records rewritten for askers.
#[derive(Default)]
pub(crate) struct Withhold {
    closed: Closed,
    /// A thing directly in a closed container, and the Soul whose entry put it there.
    put_by: BTreeMap<Id, Id>,
    /// The closed containers of the tree at a version.
    containers: Option<(u64, Vec<Id>)>,
    /// Each Soul's redaction at a version.
    redactions: BTreeMap<Id, (u64, Redaction)>,
    /// Rewritten records by their hash, as made for any asker (a record with less in it shows no one more), and the
    /// order they were made in.
    made: BTreeMap<Vec<u8>, Vec<u8>>,
    made_order: VecDeque<Vec<u8>>,
}

impl Withhold {
    pub(crate) fn new(closed: Closed) -> Withhold {
        Withhold {
            closed,
            ..Withhold::default()
        }
    }

    /// After `part` applied to `tree`: each node a Soul's entry moved into a closed container is that Soul's.
    pub(crate) fn applied(&mut self, tree: &Tree, part: &Part) {
        if self.closed.is_empty() {
            return;
        }
        for e in &part.effects {
            let Actor::Soul(soul) = e.envelope.actor else {
                continue;
            };
            let moved: Vec<Id> = match &e.body {
                Body::Transfer(TransferRec::Leave { node, .. }) => vec![*node],
                Body::Changes(cs) => cs
                    .iter()
                    .filter_map(|c| match &c.change {
                        Change::Reparent { node, .. } | Change::Create { node, .. } => Some(*node),
                        _ => None,
                    })
                    .collect(),
                _ => continue,
            };
            for node in moved {
                if let Some((_, child)) = self.closed.container_of(tree, node) {
                    self.put_by.insert(child, soul);
                }
            }
        }
        // A thing no longer in a closed container is forgotten.
        let closed = &self.closed;
        self.put_by
            .retain(|n, _| closed.container_of(tree, *n).is_some_and(|(_, c)| c == *n));
    }

    /// Whether `asker` (the gateway's actor key) may not see node `id`.
    pub(crate) fn withheld(&self, tree: &Tree, asker: Option<Actor>, id: Id) -> bool {
        let Some((container, child)) = self.closed.container_of(tree, id) else {
            return false;
        };
        let soul = match asker {
            Some(Actor::Creator(_) | Actor::World) => return false,
            Some(Actor::Soul(s)) => s,
            None => return true,
        };
        if self.put_by.get(&child) == Some(&soul) {
            return false;
        }
        let Some(rule) = self.closed.rule(tree, container) else {
            return true;
        };
        !Closed::in_audience(tree, container, rule, soul)
    }

    /// Whether the record's node (its field 1) is withheld from `asker`: closed, never open, on a doubt, so a record
    /// that does not read, or one of a node no longer in the tree (a past place), is withheld too.
    pub(crate) fn withholds_record(
        &self,
        tree: &Tree,
        asker: Option<Actor>,
        record: &[u8],
    ) -> bool {
        if self.closed.is_empty() {
            return false;
        }
        let id = match decode(record).map(|d| d.value) {
            Ok(Value::Map(m)) => m.get(&1).and_then(|v| read_id(v).ok()),
            _ => None,
        };
        match id {
            None => true,
            Some(id) if tree.handle(id).is_none() => true,
            Some(id) => self.withheld(tree, asker, id),
        }
    }

    /// The closed containers of `tree` at `version`, found once a version.
    fn containers(&mut self, tree: &Tree, version: u64) -> Vec<Id> {
        if let Some((v, c)) = &self.containers
            && *v == version
        {
            return c.clone();
        }
        let mut out = Vec::new();
        let mut todo = vec![tree.root()];
        while let Some(h) = todo.pop() {
            todo.extend(tree.children(h).unwrap_or_default());
            if let Some(n) = tree.node(h)
                && self.closed.kinds.contains_key(plain(n.kind().as_str()))
            {
                out.push(n.id());
            }
        }
        self.containers = Some((version, out.clone()));
        out
    }

    /// Makes `asker`'s redaction of `tree` at `version` once a version, reading records from `records`.
    pub(crate) fn prepare(
        &mut self,
        tree: &Tree,
        version: u64,
        asker: Option<Actor>,
        records: &mut dyn FnMut(&[u8]) -> Option<Vec<u8>>,
    ) {
        if self.closed.is_empty() {
            return;
        }
        let Some(Actor::Soul(soul)) = asker else {
            return;
        };
        if self
            .redactions
            .get(&soul)
            .is_none_or(|(v, _)| *v != version)
        {
            let r = self.redact(tree, version, asker, records);
            if let Some((_, old)) = self.redactions.insert(soul, (version, r)) {
                self.keep_past(old.records);
            }
        }
    }

    /// `asker`'s redaction as last made ([`Withhold::prepare`]).
    pub(crate) fn redaction(&self, asker: Option<Actor>) -> Option<&Redaction> {
        let Some(Actor::Soul(soul)) = asker else {
            return None;
        };
        self.redactions.get(&soul).map(|(_, r)| r)
    }

    fn redact(
        &mut self,
        tree: &Tree,
        version: u64,
        asker: Option<Actor>,
        records: &mut dyn FnMut(&[u8]) -> Option<Vec<u8>>,
    ) -> Redaction {
        let mut out = Redaction::default();
        // The hashes to leave out, and the nodes whose records change: each container holding some, and its
        // ancestors that share its audience (whose hashes cover it), by depth.
        let mut gone: BTreeSet<Vec<u8>> = BTreeSet::new();
        let mut changed: BTreeMap<Id, u32> = BTreeMap::new();
        for c in self.containers(tree, version) {
            let Some(ch) = tree.handle(c) else { continue };
            let Some(cn) = tree.node(ch) else { continue };
            let mut any = false;
            for &k in tree.children(ch).unwrap_or_default() {
                let Some(kn) = tree.node(k) else { continue };
                if kn.audience() == cn.audience() && self.withheld(tree, asker, kn.id()) {
                    if let Some(h) = kn.sealed() {
                        gone.insert(h.to_bytes());
                    }
                    any = true;
                }
            }
            if !any {
                continue;
            }
            let mut at = Some(cn);
            while let Some(n) = at {
                changed.insert(n.id(), n.depth());
                at = n
                    .parent()
                    .and_then(|p| tree.node(tree.handle(p)?))
                    .filter(|p| p.audience() == n.audience());
            }
        }
        let mut order: Vec<(u32, Id)> = changed.into_iter().map(|(id, d)| (d, id)).collect();
        order.sort_by(|a, b| b.cmp(a));
        let mut new_of: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
        for (_, id) in order {
            let Some(old) = tree
                .handle(id)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.sealed())
            else {
                continue;
            };
            let old = old.to_bytes();
            let Some(Ok(Value::Map(mut m))) = records(&old).map(|b| decode(&b).map(|d| d.value))
            else {
                continue;
            };
            if let Some(Value::Array(kids)) = m.get(&10) {
                let kids = kids
                    .iter()
                    .filter_map(|k| match k {
                        Value::Bytes(b) if gone.contains(b) => None,
                        Value::Bytes(b) => Some(Value::Bytes(new_of.get(b).unwrap_or(b).clone())),
                        other => Some(other.clone()),
                    })
                    .collect();
                m.insert(10, Value::Array(kids));
            }
            let public =
                matches!(m.get(&5), Some(Value::Map(a)) if a.get(&1) == Some(&Value::Uint(1)));
            let Ok(bytes) = encode(&Value::Map(m)) else {
                continue;
            };
            let purpose = if public {
                Purpose::StatePublic
            } else {
                Purpose::StatePrivate
            };
            let h = Hash::of(purpose, &bytes);
            let hb = h.to_bytes();
            out.records.insert(hb.clone(), bytes);
            new_of.insert(old.clone(), hb);
            out.replaced.insert(old);
            out.hashes.insert(id, h);
        }
        out
    }

    /// Keeps a past redaction's records, at most [`MADE_MOST`], oldest let go first.
    fn keep_past(&mut self, records: BTreeMap<Vec<u8>, Vec<u8>>) {
        for (h, b) in records {
            if self.made.insert(h.clone(), b).is_none() {
                self.made_order.push_back(h);
            }
        }
        while self.made_order.len() > MADE_MOST {
            if let Some(k) = self.made_order.pop_front() {
                self.made.remove(&k);
            }
        }
    }

    /// A record made for `asker`, by its hash: from its current redaction, which is never let go while current, else
    /// from the past ones kept.
    pub(crate) fn made(&self, asker: Option<Actor>, hash: &[u8]) -> Option<&Vec<u8>> {
        self.redaction(asker)
            .and_then(|r| r.records.get(hash))
            .or_else(|| self.made.get(hash))
    }

    /// Fills the store of past records with `n` records no asker needs (tests).
    #[cfg(test)]
    pub(crate) fn fill_past(&mut self, n: usize) {
        let filler = (0..n)
            .map(|i| (format!("filler {i}").into_bytes(), vec![0u8]))
            .collect();
        self.keep_past(filler);
    }
}

impl Redaction {
    /// The node's hash for this asker, where its record was rewritten.
    pub(crate) fn hash(&self, id: Id) -> Option<Hash> {
        self.hashes.get(&id).copied()
    }

    /// Whether `hash` is the real hash of a record rewritten for this asker.
    pub(crate) fn replaced(&self, hash: &[u8]) -> bool {
        self.replaced.contains(hash)
    }
}

/// The actor a gateway's key names (`gatewayd::token::actor_key`): `{1: 1, 2: soul}`, `{1: 2, 2: creator}` or
/// `{1: 3}`.
pub(crate) fn actor_of_key(key: &Value) -> Option<Actor> {
    let Value::Bytes(b) = key else { return None };
    let Value::Map(m) = decode(b).ok()?.value else {
        return None;
    };
    match m.get(&1)? {
        Value::Uint(1) => Some(Actor::Soul(read_id(m.get(&2)?).ok()?)),
        Value::Uint(2) => Some(Actor::Creator(read_id(m.get(&2)?).ok()?)),
        Value::Uint(3) => Some(Actor::World),
        _ => None,
    }
}

/// What the view tier's hub needs to keep a hiding place's contents to their audience in its streams (#3915): which
/// nodes are closed containers and which things are in one, from the world as built and then the log.
#[derive(Default)]
pub struct Inside {
    kinds: BTreeSet<String>,
    containers: BTreeSet<Id>,
    inside: BTreeSet<Id>,
    /// Transfers into a closed container: their arrivals are kept to the same readers.
    transfers: BTreeSet<Id>,
}

impl Inside {
    pub fn new(closed: &Closed) -> Inside {
        Inside {
            kinds: closed.kinds.keys().cloned().collect(),
            ..Inside::default()
        }
    }

    fn holds(&self, node: Id) -> bool {
        self.containers.contains(&node) || self.inside.contains(&node)
    }

    /// The closed containers of a world as built, and everything under them.
    pub fn seed(&mut self, tree: &Tree) {
        if self.kinds.is_empty() {
            return;
        }
        let mut todo = vec![(tree.root(), false)];
        while let Some((h, under)) = todo.pop() {
            let Some(n) = tree.node(h) else { continue };
            if under {
                self.inside.insert(n.id());
            }
            let container = self.kinds.contains(plain(n.kind().as_str()));
            if container {
                self.containers.insert(n.id());
            }
            for &c in tree.children(h).unwrap_or_default() {
                todo.push((c, under || container));
            }
        }
    }

    /// Follows one entry of the log: whether it puts a thing into a closed container or touches one in it, so that
    /// only its actor is sent it.
    pub fn apply(&mut self, e: &replica::effects::Effect) -> bool {
        if self.kinds.is_empty() {
            return false;
        }
        let mut hit = false;
        match &e.body {
            Body::Changes(cs) => {
                for c in cs {
                    match &c.change {
                        Change::Create {
                            node, kind, pose, ..
                        } => {
                            if self.kinds.contains(plain(kind.as_str())) {
                                self.containers.insert(*node);
                            }
                            if self.holds(pose.frame.node) {
                                self.inside.insert(*node);
                                hit = true;
                            }
                        }
                        Change::Remove { node } => {
                            hit |= self.inside.remove(node);
                            self.containers.remove(node);
                        }
                        // Set into a closed container is put in it, as a transfer into one is (#3948); set
                        // anywhere else, taken out.
                        Change::Reparent { node, pose, .. } => {
                            if self.holds(pose.frame.node) {
                                self.inside.insert(*node);
                                hit = true;
                            } else {
                                self.inside.remove(node);
                            }
                        }
                        Change::Set { node, .. } => {
                            hit |= self.inside.contains(node);
                        }
                        Change::Motion(m) => hit |= self.inside.contains(&m.node),
                        _ => {}
                    }
                }
            }
            Body::Transfer(TransferRec::Leave {
                transfer,
                node,
                pose,
                ..
            }) => {
                if self.holds(pose.frame.node) {
                    self.inside.insert(*node);
                    self.transfers.insert(*transfer);
                    hit = true;
                } else {
                    // Taken out: from here on it is seen as usual.
                    self.inside.remove(node);
                }
            }
            Body::Transfer(
                TransferRec::Arrive { transfer, .. }
                | TransferRec::Settle { transfer }
                | TransferRec::Return { transfer, .. },
            ) => hit = self.transfers.remove(transfer),
            _ => {}
        }
        hit
    }
}
