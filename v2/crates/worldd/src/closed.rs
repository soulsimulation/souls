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
//! Not here: the view stream's entries and their named events (R4's hub), and the public stream on disk (V1).

use std::collections::BTreeMap;

use replica::effects::{Actor, Body, Change, Part, TransferRec, read_id};
use replica::encode::{Value, decode};
use replica::ids::Id;
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

/// A body's Soul by its `souls:body-of` link; any other id is its own.
fn soul_of(tree: &Tree, id: Id) -> Id {
    tree.links_at(id)
        .iter()
        .find(|e| plain(tree.ty(e).as_str()) == BODY_OF)
        .map_or(id, |e| e.other)
}

/// The sync thread's side: the closed kinds and who put each thing in.
#[derive(Default)]
pub(crate) struct Withhold {
    closed: Closed,
    /// A thing directly in a closed container, and the Soul whose entry put it there.
    put_by: BTreeMap<Id, Id>,
}

impl Withhold {
    pub(crate) fn new(closed: Closed) -> Withhold {
        Withhold {
            closed,
            put_by: BTreeMap::new(),
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

    /// Whether the record's node (its field 1) is withheld from `asker`.
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
        id.is_some_and(|id| self.withheld(tree, asker, id))
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
