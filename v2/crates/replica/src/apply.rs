//! The replica (Engine v2 R1, #2684): a copy of one zone that applies the log's effects and answers questions about
//! itself, the same in the server's build and in WASM. It holds K2's tree (`tree`) and adds what a copy needs: the
//! version it stands at, the version each node last changed at, and batches of parts passed in as bytes.
//!
//! - **Apply** is the tree's viewer apply ([`Tree::apply`]): the seven generic changes, and T1's, T5's and T6's other
//!   records, with no kinds and no T2 checks (effects.md rule 5). Named events are carried in the part and never
//!   interpreted. A part applies whole or not at all.
//! - **A version** is a place in the zone's log: the number of entries applied, so the next entry's sequence. A node
//!   keeps the version at which an entry last changed it; [`Replica::changed_since`] is a range over an ordered index,
//!   never a scan.
//! - **A batch** is parts, each a little-endian `u32` byte length and then the part's stored bytes. JavaScript passes
//!   one in as bytes and gets a small answer back ([`Applied`]); the state stays inside WASM memory.
//! - **A refusal's node states** (I6, #2691) apply through [`Replica::apply_states`], in version order with the
//!   stream: a state replaces a node only when the copy's is older, and the stream's older entries never undo it
//!   (the node is held at the state until the stream reaches its version). States are cut to the actor's audience
//!   on the server ([`Replica::node_state`]).

use crate::effects::read_id;
use crate::effects::{Body, Change, Effect, Header, Part, Refusal, TransferRec};
use crate::encode::{Name, Value, encode};
use crate::hash::{Chain, audience, node_value, state_hash, step_hash};
use crate::ids::{Hash, Id, Purpose};
use crate::tree::Tree;
use crate::world_model::Audience;
use std::collections::{BTreeMap, BTreeSet, HashMap};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// One zone's copy: K2's tree, the bundle's header, and the versions.
pub struct Replica {
    pub(crate) tree: Tree,
    header: Header,
    version: u64,
    /// The version each node last changed at, removed nodes included. Lookup only: never walked.
    pub(crate) changed_at: HashMap<Id, u64>,
    /// The same, ordered by version and then id, so that what changed since a version is a range.
    pub(crate) by_version: BTreeSet<(u64, Id)>,
    /// Nodes a refusal set ahead of the stream (I6): each node's stamp and fields, kept until the stream reaches it.
    held: HashMap<Id, (u64, BTreeMap<u64, Value>)>,
}

/// One node's state as a refusal carries it (I6, #2691): `[id, stamp, state]`, the state as the node's hash covers
/// it (`hash.rs`), its links cut to the actor's audience.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeState {
    pub id: Id,
    /// The version the node last changed at.
    pub stamp: u64,
    pub state: Value,
}

impl NodeState {
    pub fn to_value(&self) -> Value {
        Value::Array(vec![
            self.id.to_value(),
            Value::Uint(self.stamp),
            self.state.clone(),
        ])
    }

    pub fn read(v: &Value) -> R<NodeState> {
        let Value::Array(a) = v else {
            return refuse("not-a-record", "a node state is [id, stamp, state]");
        };
        match a.as_slice() {
            [id, Value::Uint(stamp), state @ Value::Map(_)] => Ok(NodeState {
                id: read_id(id)?,
                stamp: *stamp,
                state: state.clone(),
            }),
            _ => refuse("not-a-record", "a node state is [id, stamp, state]"),
        }
    }

    /// The hash of the state, as [`crate::hash::node_hash`] gives it for a copy holding exactly this node.
    pub fn hash(&self) -> Option<Hash> {
        let Value::Map(m) = &self.state else {
            return None;
        };
        let purpose = if m.get(&5) == Some(&audience(Audience::Everyone)) {
            Purpose::StatePublic
        } else {
            Purpose::StatePrivate
        };
        Some(Hash::of(purpose, &encode(&self.state).ok()?))
    }
}

/// What applying a refusal's states did: the nodes it repaired, and those it could not, left for a fetch (R5): a
/// node not in the copy, or one that differs other than in its fields.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Repaired {
    pub applied: Vec<Id>,
    pub fetch: Vec<Id>,
}

/// What applying a batch did: the parts applied, the version the copy stands at, the chain of hashes over its steps
/// and its end state when asked for, and the refusal that stopped it, if one did. The parts before a refusal stay
/// applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Applied {
    pub parts: u64,
    pub version: u64,
    pub chain: Option<[u8; 32]>,
    pub refused: Option<&'static str>,
}

impl Applied {
    /// `{1: parts, 2: version, 3: chain (when hashed), 4: refusal name (when refused)}`, in T0's profile.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut m = std::collections::BTreeMap::from([
            (1, Value::Uint(self.parts)),
            (2, Value::Uint(self.version)),
        ]);
        if let Some(c) = self.chain {
            m.insert(3, Value::Bytes(c.to_vec()));
        }
        if let Some(r) = self.refused {
            m.insert(
                4,
                Value::Text(
                    Name::new(r).unwrap_or_else(|| unreachable!("refusal names are names")),
                ),
            );
        }
        encode(&Value::Map(m)).unwrap_or_else(|_| unreachable!("a shallow record"))
    }
}

impl Replica {
    /// A copy of the zone a header names, at its start: the root alone, of the header's `souls:place` kind (as
    /// `effects::run_fixtures` starts it).
    pub fn start(header_bytes: &[u8]) -> R<Replica> {
        let header = Header::read(header_bytes)?;
        let Some(root_kind) = header
            .kinds
            .iter()
            .find(|k| k.as_str().starts_with("souls:place@"))
            .cloned()
        else {
            return refuse(
                "not-a-record",
                "the header lists no souls:place kind for the root",
            );
        };
        let tree = Tree::start(header.zone, root_kind);
        Ok(Replica {
            tree,
            header,
            version: 0,
            changed_at: HashMap::new(),
            by_version: BTreeSet::new(),
            held: HashMap::new(),
        })
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    pub fn tree(&self) -> &Tree {
        &self.tree
    }

    /// The version the copy stands at: the number of log entries applied.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// A whole copy for readers on other threads ([`Tree::frozen`]; K8, #2671).
    pub fn frozen(&self) -> Replica {
        Replica {
            tree: self.tree.frozen(),
            header: self.header.clone(),
            version: self.version,
            changed_at: self.changed_at.clone(),
            by_version: self.by_version.clone(),
            held: self.held.clone(),
        }
    }

    /// Applies one part's stored bytes, whole or not at all.
    pub fn apply_bytes(&mut self, bytes: &[u8]) -> R<()> {
        let part = Part::read(bytes)?;
        self.apply(&part)
    }

    /// Applies a part whole or not at all, then marks each node its entries changed with the version after that entry.
    pub fn apply(&mut self, part: &Part) -> R<()> {
        self.apply_touched(part).map(drop)
    }

    /// [`Replica::apply`], giving back the nodes the part changed, in id order.
    fn apply_touched(&mut self, part: &Part) -> R<Vec<Id>> {
        let touched: Vec<Vec<Id>> = part.effects.iter().map(|e| self.touched(e)).collect();
        self.tree.apply(&self.header, part)?;
        let mut all = Vec::new();
        for (e, ids) in part.effects.iter().zip(touched) {
            let v = e.envelope.sequence + 1;
            for id in &ids {
                if let Some(old) = self.changed_at.insert(*id, v) {
                    self.by_version.remove(&(old, *id));
                }
                self.by_version.insert((v, *id));
            }
            all.extend(ids);
            self.version = v;
        }
        all.sort();
        all.dedup();
        if !self.held.is_empty() {
            self.keep_held(&all);
        }
        Ok(all)
    }

    /// After a part: a held node the stream has reached is let go; one the part touched below its stamp gets the
    /// refusal's state back, so the stream's older entries never rewind it.
    fn keep_held(&mut self, touched: &[Id]) {
        let version = self.version;
        self.held.retain(|_, (stamp, _)| *stamp > version);
        for id in touched {
            if let Some((stamp, fields)) = self.held.get(id) {
                self.tree.put_fields(*id, fields.clone());
                self.mark(*id, *stamp);
            }
        }
    }

    fn mark(&mut self, id: Id, stamp: u64) {
        if let Some(old) = self.changed_at.insert(id, stamp) {
            self.by_version.remove(&(old, id));
        }
        self.by_version.insert((stamp, id));
    }

    /// A node's state for a refusal (I6): as its hash covers it, with only the links whose audience `sees` allows;
    /// none for a node not here or of an audience `sees` refuses.
    pub fn node_state(&self, id: Id, sees: &dyn Fn(Audience) -> bool) -> Option<NodeState> {
        let n = self.tree.node(self.tree.handle(id)?)?;
        if !sees(n.audience()) {
            return None;
        }
        let Value::Map(mut m) = node_value(&self.tree, id)? else {
            return None;
        };
        let links = self.tree.links_at(id);
        if let Some(Value::Array(all)) = m.get_mut(&9) {
            let kept = all
                .iter()
                .zip(links)
                .filter(|(_, e)| sees(e.audience))
                .map(|(v, _)| v.clone())
                .collect();
            *all = kept;
        }
        Some(NodeState {
            id,
            stamp: self.changed_at.get(&id).copied().unwrap_or(0),
            state: Value::Map(m),
        })
    }

    /// Applies a refusal's node states (I6) in version order with the stream: a state replaces the copy's node only
    /// when the copy's is older (a lower stamp), so a refusal never rewinds a node; until the stream reaches the
    /// state's version the node is held at it. Only fields are repaired: a node not here, or differing in anything
    /// but its fields, is left for a fetch (R5).
    pub fn apply_states(&mut self, states: &[NodeState]) -> Repaired {
        let mut out = Repaired::default();
        for s in states {
            if self.changed_at.get(&s.id).copied().unwrap_or(0) >= s.stamp {
                continue;
            }
            let (Some(Value::Map(mut mine)), Value::Map(theirs)) =
                (node_value(&self.tree, s.id), &s.state)
            else {
                out.fetch.push(s.id);
                continue;
            };
            let mut theirs = theirs.clone();
            let (Some(_), Some(Value::Map(fields))) = (mine.remove(&6), theirs.remove(&6)) else {
                out.fetch.push(s.id);
                continue;
            };
            if mine != theirs || !self.tree.put_fields(s.id, fields.clone()) {
                out.fetch.push(s.id);
                continue;
            }
            self.mark(s.id, s.stamp);
            if s.stamp > self.version {
                self.held.insert(s.id, (s.stamp, fields));
            }
            out.applied.push(s.id);
        }
        out
    }

    /// Applies a batch (see the module's notes). With `hash_steps`, the answer carries a chain (`hash.rs`) of each
    /// step's hash (a step is a part: the hashes of the nodes it changed) and then the state hash after the batch, so
    /// two builds that give the same chain had the same hashes at every step and the same state at the end.
    pub fn apply_batch(&mut self, batch: &[u8], hash_steps: bool) -> R<Applied> {
        let mut chain = hash_steps.then(Chain::new);
        let mut parts = 0;
        let mut rest = batch;
        let mut refused = None;
        while !rest.is_empty() {
            let Some((len, tail)) = rest.split_first_chunk::<4>() else {
                return refuse("not-a-record", "a batch's part length is four bytes");
            };
            let len = u32::from_le_bytes(*len) as usize;
            if tail.len() < len {
                return refuse("not-a-record", "a batch's part is shorter than its length");
            }
            let (bytes, tail) = tail.split_at(len);
            rest = tail;
            let touched = match Part::read(bytes).and_then(|p| self.apply_touched(&p)) {
                Ok(t) => t,
                Err(r) => {
                    refused = Some(r.name);
                    break;
                }
            };
            parts += 1;
            if let Some(c) = &mut chain {
                c.push(&step_hash(&self.tree, self.version, &touched));
            }
        }
        if let Some(c) = &mut chain {
            c.push(&state_hash(&self.tree)?.to_bytes());
        }
        Ok(Applied {
            parts,
            version: self.version,
            chain: chain.map(|c| c.digest()),
            refused,
        })
    }

    /// The nodes an entry changes, read before it applies: a node created, removed (with its subtree and the far
    /// ends of its links), moved, set or sampled; a parent whose children change; a link's two ends. For T1's
    /// records, the node that writes it and the subtree that leaves; T5's and timers', the node that writes them.
    fn touched(&self, e: &Effect) -> Vec<Id> {
        let mut out = vec![e.envelope.node];
        let mut new_links: HashMap<Id, [Id; 2]> = HashMap::new();
        match &e.body {
            Body::Changes(changes) => {
                for c in changes {
                    match &c.change {
                        Change::Create { node, pose, .. } => out.extend([*node, pose.frame.node]),
                        Change::Remove { node } => {
                            out.extend(self.subtree_and_ends(*node));
                            out.extend(self.node_parent(*node));
                        }
                        Change::Reparent { node, .. } | Change::Set { node, .. } => out.push(*node),
                        Change::Motion(m) => out.push(m.node),
                        Change::Link { link, ends, .. } => {
                            new_links.insert(*link, *ends);
                            out.extend(ends);
                        }
                        Change::Unlink { link } => {
                            if let Some(ends) = new_links.get(link) {
                                out.extend(ends);
                            } else if let Some((_, ends, _, _)) = self.tree.link(*link) {
                                out.extend(ends);
                            }
                        }
                    }
                }
            }
            Body::Transfer(TransferRec::Leave { node, pose, .. }) => {
                out.extend(self.subtree_and_ends(*node));
                out.extend(self.node_parent(*node));
                out.push(pose.frame.node);
            }
            Body::Transfer(TransferRec::Arrive { carried, .. }) => {
                for c in carried {
                    match &c.change {
                        Change::Create { node, pose, .. } => out.extend([*node, pose.frame.node]),
                        Change::Link { ends, .. } => out.extend(ends),
                        _ => {}
                    }
                }
            }
            Body::Transfer(_) | Body::Time(_) | Body::Timers(_) => {}
        }
        out.sort();
        out.dedup();
        out
    }

    fn node_parent(&self, id: Id) -> Option<Id> {
        self.tree
            .handle(id)
            .and_then(|h| self.tree.node(h))
            .and_then(|n| n.parent())
    }

    /// A node, every node below it, and the other end of each link at any of them.
    fn subtree_and_ends(&self, id: Id) -> Vec<Id> {
        let Some(h) = self.tree.handle(id) else {
            return vec![id];
        };
        let mut handles = vec![h];
        let mut out = Vec::new();
        let mut i = 0;
        while i < handles.len() {
            let h = handles[i];
            if let Some(n) = self.tree.node(h) {
                out.push(n.id());
            }
            out.extend(self.tree.links_of(h).unwrap_or(&[]).iter().map(|e| e.other));
            handles.extend_from_slice(self.tree.children(h).unwrap_or(&[]));
            i += 1;
        }
        out
    }
}
