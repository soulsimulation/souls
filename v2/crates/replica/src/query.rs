//! The replica's queries (Engine v2 R1, #2684): a node, its children by kind, the links at an end, the path to the
//! root, what changed since a version, and a node's hash. Each is a method natively and one record through
//! [`Replica::query`], which both builds run, so a query's bytes in give the same bytes out in each.
//!
//! A query is `{1: which, 2: argument, 3: kind}` in T0's profile:
//!
//! | which | argument | answer |
//! |---|---|---|
//! | 1 a node | an id | its record (`hash.rs`'s node value, with `10: version`) |
//! | 2 children | an id, and in 3 a kind (full `namespace:name@hash`, or plain `namespace:name`), or none for all | `[id, ...]` in id order |
//! | 3 links at an end | an id: a node here, or not (a Soul) | `[[link, type, [end, end], owner, audience], ...]` in link id order; owner 0 is the first end |
//! | 4 path to the root | an id | `[id, parent, ..., root]` |
//! | 5 changed since | a version | `[[id, version], ...]` in version then id order: nodes changed after it, removed ones included |
//! | 6 a node's hash | an id | its hash's bytes |
//!
//! A node that is not here is refused as `node-missing`; a query of another shape as `not-a-record`.

use crate::apply::Replica;
use crate::effects::{Refusal, read_id};
use crate::encode::{Name, Value, decode, encode};
use crate::hash::{audience, node_hash, node_value};
use crate::ids::{Hash, Id, Scope};
use crate::world_model::End;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn missing<T>(id: Id) -> R<T> {
    refuse("node-missing", crate::world_model::show(id))
}

/// A link as the links query lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkAt {
    pub link: Id,
    pub ty: Name,
    pub ends: [Id; 2],
    pub owner: End,
    pub audience: crate::world_model::Audience,
}

impl Replica {
    /// The node's record (`hash.rs`'s node value with `10: version`), or none if it is not here.
    pub fn node(&self, id: Id) -> Option<Value> {
        let mut v = node_value(&self.tree, id)?;
        if let Value::Map(m) = &mut v {
            m.insert(
                10,
                Value::Uint(self.changed_at.get(&id).copied().unwrap_or(0)),
            );
        }
        Some(v)
    }

    /// The node's children in id order, only those of `kind` when given: a full kind name, or a plain one that
    /// matches every hash of it.
    pub fn children(&self, id: Id, kind: Option<&str>) -> Option<Vec<Id>> {
        let h = self.tree.handle(id)?;
        let of_kind = |c: Id| -> bool {
            let Some(k) = kind else { return true };
            let Some(n) = self.tree.handle(c).and_then(|h| self.tree.node(h)) else {
                return false;
            };
            let full = n.kind().as_str();
            full == k || full.split_once('@').is_some_and(|(plain, _)| plain == k)
        };
        let ids = self
            .tree
            .children(h)?
            .iter()
            .filter_map(|c| self.tree.node(*c).map(|n| n.id()))
            .filter(|c| of_kind(*c))
            .collect();
        Some(ids)
    }

    /// The links at an end, whichever end it is and whether or not it is a node here, in link id order.
    pub fn links(&self, end: Id) -> Vec<LinkAt> {
        self.tree
            .links_at(end)
            .iter()
            .filter_map(|e| {
                let (ty, ends, owner, audience) = self.tree.link(e.link)?;
                Some(LinkAt {
                    link: e.link,
                    ty: ty.clone(),
                    ends,
                    owner,
                    audience,
                })
            })
            .collect()
    }

    /// The node, its parent, and so on to the zone's root.
    pub fn path(&self, id: Id) -> Option<Vec<Id>> {
        let mut out = vec![id];
        let mut n = self.tree.node(self.tree.handle(id)?)?;
        while let Some(p) = n.parent() {
            out.push(p);
            n = self.tree.node(self.tree.handle(p)?)?;
        }
        Some(out)
    }

    /// The nodes an entry changed after `version`, with the version each last changed at, in version then id order.
    pub fn changed_since(&self, version: u64) -> Vec<(Id, u64)> {
        let first =
            Id::new(Scope([0; 16]), 0).unwrap_or_else(|| unreachable!("counter 0 is below 2^53"));
        self.by_version
            .range((version.saturating_add(1), first)..)
            .map(|(v, id)| (*id, *v))
            .collect()
    }

    pub fn node_hash(&self, id: Id) -> Option<Hash> {
        node_hash(&self.tree, id)
    }

    /// Answers one query's bytes with the answer's bytes (the module's table).
    pub fn query(&self, bytes: &[u8]) -> R<Vec<u8>> {
        let v = decode(bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let Value::Map(q) = v else {
            return refuse("not-a-record", "a query is a record");
        };
        let arg = q
            .get(&2)
            .map_or_else(|| refuse("not-a-record", "a query has an argument"), Ok)?;
        let id = || read_id(arg);
        let answer = match q.get(&1) {
            Some(Value::Uint(1)) => {
                let id = id()?;
                self.node(id).map_or_else(|| missing(id), Ok)?
            }
            Some(Value::Uint(2)) => {
                let id = id()?;
                let kind = match q.get(&3) {
                    Some(Value::Text(k)) => Some(k.as_str()),
                    None => None,
                    Some(_) => return refuse("not-a-record", "a kind is a name"),
                };
                let ids = self.children(id, kind).map_or_else(|| missing(id), Ok)?;
                Value::Array(ids.into_iter().map(Id::to_value).collect())
            }
            Some(Value::Uint(3)) => Value::Array(
                self.links(id()?)
                    .into_iter()
                    .map(|l| {
                        Value::Array(vec![
                            l.link.to_value(),
                            Value::Text(l.ty),
                            Value::Array(l.ends.iter().map(|e| e.to_value()).collect()),
                            Value::Uint(u64::from(l.owner == End::Second)),
                            audience(l.audience),
                        ])
                    })
                    .collect(),
            ),
            Some(Value::Uint(4)) => {
                let id = id()?;
                let path = self.path(id).map_or_else(|| missing(id), Ok)?;
                Value::Array(path.into_iter().map(Id::to_value).collect())
            }
            Some(Value::Uint(5)) => {
                let Value::Uint(since) = arg else {
                    return refuse("not-a-record", "a version is an unsigned integer");
                };
                Value::Array(
                    self.changed_since(*since)
                        .into_iter()
                        .map(|(id, v)| Value::Array(vec![id.to_value(), Value::Uint(v)]))
                        .collect(),
                )
            }
            Some(Value::Uint(6)) => {
                let id = id()?;
                Value::Bytes(
                    self.node_hash(id)
                        .map_or_else(|| missing(id), Ok)?
                        .to_bytes(),
                )
            }
            _ => return refuse("not-a-record", "a query is 1 to 6"),
        };
        encode(&answer).or_else(|e| refuse("encoding", e.to_string()))
    }
}
