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

use crate::effects::{Body, Change, Effect, Flight, Header, Part, Refusal, TransferRec};
use crate::encode::{Name, Value, encode};
use crate::hash::{Chain, state_hash, step_hash};
use crate::ids::Id;
use crate::tree::Tree;
use std::collections::{BTreeSet, HashMap};

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
        }
    }

    /// Applies one part's stored bytes, whole or not at all.
    pub fn apply_bytes(&mut self, bytes: &[u8]) -> R<()> {
        let part = Part::read(bytes)?;
        self.apply(&part)
    }

    /// Applies a part whole or not at all, then marks each node its entries changed with the version after that entry.
    pub fn apply(&mut self, part: &Part) -> R<()> {
        self.apply_touched(part, &[], &[]).map(drop)
    }

    /// Applies a part of a view that declares the sequences it skipped ([`Tree::apply_gaps`]): a gap it did not
    /// declare is still `sequence-gap`. The version stands after the part's last entry.
    pub fn apply_gaps(&mut self, part: &Part, gaps: &[(u64, u64)]) -> R<()> {
        self.apply_touched(part, gaps, &[]).map(drop)
    }

    /// [`Replica::apply_gaps`], with the subtrees the view carried in, each landed by the arrive of its sequence
    /// ([`Tree::apply_view`]).
    pub fn apply_view(
        &mut self,
        part: &Part,
        gaps: &[(u64, u64)],
        carried: &[(u64, Flight)],
    ) -> R<()> {
        self.apply_touched(part, gaps, carried).map(drop)
    }

    /// [`Replica::apply`], giving back the nodes the part changed, in id order.
    fn apply_touched(
        &mut self,
        part: &Part,
        gaps: &[(u64, u64)],
        carried: &[(u64, Flight)],
    ) -> R<Vec<Id>> {
        let mut touched: Vec<Vec<Id>> = part.effects.iter().map(|e| self.touched(e)).collect();
        // A carried subtree: what it takes out where it was, and what it lands, with the ends of its links.
        for (seq, f) in carried {
            let at = part
                .effects
                .iter()
                .position(|e| e.envelope.sequence == *seq);
            if let Some(t) = at.and_then(|i| touched.get_mut(i)) {
                t.extend(self.subtree_and_ends(f.root));
                t.extend(self.node_parent(f.root));
                t.extend(f.nodes.keys());
                t.extend(f.links.values().flat_map(|l| l.ends));
                t.push(f.pose.frame.node);
                t.sort();
                t.dedup();
            }
        }
        if gaps.is_empty() && carried.is_empty() {
            self.tree.apply(&self.header, part)?;
        } else {
            self.tree.apply_view(&self.header, part, gaps, carried)?;
        }
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
        Ok(all)
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
            let touched = match Part::read(bytes).and_then(|p| self.apply_touched(&p, &[], &[])) {
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
