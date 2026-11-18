//! The replica's hashes (Engine v2 R1, #2684): the state hash two builds compare at every step, a node's hash, and
//! the chain that folds a run of state hashes into one digest.
//!
//! - **The state hash** is T6's: `souls/fixture/1` over the tree in the fixtures' state form ([`Tree::to_state`]),
//!   so a replica's hash after the golden fixtures equals `fixtures/effects/goldens.txt`. Everything it encodes is
//!   ordered (nodes, links and flights by id), never a hash map's order.
//! - **A node's hash** is over the node's own state and the index at it: `{1: id, 2: kind, 3: parent, 4: slot,
//!   5: audience, 6: fields, 7: place, 8: motion, 9: [[link, type, other, audience], ...]}`, where 3, 4, 7 and 8 are
//!   left out when absent, labelled `souls/state-public/1` for a public node and `souls/state-private/1` for one with
//!   an audience (T3 rule 11). It is not K5's hash of a subtree.
//! - **A step's hash** (a step is a part) is SHA-256, unlabelled, over `[version, [[id, node hash], ...]]` for the
//!   nodes the step changed, in id order, a node no longer here having `[]` for its hash. It is a check between two
//!   builds and is never stored. The state hash costs time in proportion to the world, a step's hash to what the
//!   step changed.
//! - **The chain** starts at 32 zero bytes and takes `sha256(chain || hash)` for each hash pushed, so two runs with
//!   the same chain had the same hash at every step.

use crate::effects::Refusal;
use crate::encode::{Value, encode};
use crate::ids::{Hash, Id, Purpose, sha256};
use crate::tree::Tree;
use crate::world_model::Audience;
use std::collections::BTreeMap;

/// The state hash: `souls/fixture/1` over the tree's state form.
pub fn state_hash(tree: &Tree) -> Result<Hash, Refusal> {
    tree.to_state().hash()
}

pub(crate) fn audience(a: Audience) -> Value {
    match a {
        Audience::Everyone => Value::Map(BTreeMap::from([(1, Value::Uint(1))])),
        Audience::Of(id) => Value::Map(BTreeMap::from([(1, Value::Uint(2)), (2, id.to_value())])),
    }
}

pub(crate) fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

/// A node's state as its hash covers it (the module's notes), or none for a node not here.
pub(crate) fn node_value(tree: &Tree, id: Id) -> Option<Value> {
    let h = tree.handle(id)?;
    let n = tree.node(h)?;
    let mut m = BTreeMap::from([
        (1, id.to_value()),
        (2, Value::Text(n.kind().clone())),
        (5, audience(n.audience())),
        (6, Value::Map(n.fields().clone())),
    ]);
    if let Some(p) = n.parent() {
        m.insert(3, p.to_value());
    }
    if let Some(s) = n.slot() {
        m.insert(4, Value::Uint(s));
    }
    if let Some(p) = n.place() {
        let v3 = |v: crate::pose::Vec3| Value::Array(vec![int(v.x), int(v.y), int(v.z)]);
        let support = crate::pose::Pose {
            frame: crate::pose::Frame {
                node: id,
                slot: n.slot(),
            },
            position: p.position,
            orientation: p.orientation,
            support: p.support,
        }
        .to_value();
        let Value::Map(mut pose) = support else {
            unreachable!("a pose is a map")
        };
        pose.remove(&1);
        m.insert(7, Value::Map(pose));
        if let Some(mv) = n.moved() {
            m.insert(
                8,
                Value::Map(BTreeMap::from([
                    (1, int(mv.at)),
                    (2, v3(mv.linear)),
                    (3, v3(mv.angular)),
                    (4, mv.owner.to_value()),
                ])),
            );
        }
    }
    let links = tree
        .links_of(h)
        .unwrap_or(&[])
        .iter()
        .map(|e| {
            Value::Array(vec![
                e.link.to_value(),
                Value::Text(tree.ty(e).clone()),
                e.other.to_value(),
                audience(e.audience),
            ])
        })
        .collect();
    m.insert(9, Value::Array(links));
    Some(Value::Map(m))
}

/// A node's hash (the module's notes), or none for a node not here.
pub fn node_hash(tree: &Tree, id: Id) -> Option<Hash> {
    let v = node_value(tree, id)?;
    let purpose = match tree.node(tree.handle(id)?)?.audience() {
        Audience::Everyone => Purpose::StatePublic,
        Audience::Of(_) => Purpose::StatePrivate,
    };
    let bytes = encode(&v).ok()?;
    Some(Hash::of(purpose, &bytes))
}

/// A step's hash (the module's notes): the version after it, and the nodes it changed with their hashes.
pub fn step_hash(tree: &Tree, version: u64, touched: &[Id]) -> [u8; 32] {
    let mut bytes = Vec::new();
    for id in touched {
        let h = node_hash(tree, *id).map_or(Value::Array(Vec::new()), |h| h.to_value());
        bytes.push(Value::Array(vec![id.to_value(), h]));
    }
    let v = Value::Array(vec![Value::Uint(version), Value::Array(bytes)]);
    sha256(&encode(&v).unwrap_or_else(|_| unreachable!("a shallow record")))
}

/// A run of hashes folded into one digest (the module's notes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chain([u8; 32]);

impl Default for Chain {
    fn default() -> Self {
        Chain::new()
    }
}

impl Chain {
    pub fn new() -> Chain {
        Chain([0; 32])
    }

    pub fn push(&mut self, hash: &[u8]) {
        let mut buf = Vec::with_capacity(32 + hash.len());
        buf.extend_from_slice(&self.0);
        buf.extend_from_slice(hash);
        self.0 = sha256(&buf);
    }

    pub fn digest(&self) -> [u8; 32] {
        self.0
    }
}
