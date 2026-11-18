//! Audience and removing words (contract T8; Engine v2 T8, #2662): who may see a record, text kept apart by
//! reference, and removal in a history that is never rewritten. The rules are numbered in `v2/docs/audience.md`.
//!
//! This is the reference definition, run on the fixtures through T6's harness ([`State`]). The text store here is a
//! stand-in for K16's; signing in (W1), removal end to end (W7) and who may act (F6) are not here.

use std::collections::{BTreeMap, BTreeSet};

use crate::effects::{Refusal, State};
use crate::encode::{Name, Value, encode};
use crate::ids::Id;
use crate::views::{Output, Redactions};
use crate::world_model::Audience;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

// --- References ---------------------------------------------------------------------------------------------------

/// The field that makes a record a text reference (rule 6): `{21: id}` and nothing else. No other record uses 21 alone.
pub const REFERENCE: u64 = 21;
/// The field a view adds to a reference whose words were removed: `{21: id, 22: 1}`.
pub const REMOVED: u64 = 22;
/// The field delivery adds beside a reference, for an audience entitled to the words: `{21: id, 23: words}`.
pub const WORDS: u64 = 23;

/// The reference a value is, if it is one: `{21: id}`, as the log holds it, or with a view's 22 or delivery's 23.
pub fn reference(v: &Value) -> Option<Id> {
    match v {
        Value::Map(m) if m.keys().all(|k| [REFERENCE, REMOVED, WORDS].contains(k)) => {
            crate::effects::read_id(m.get(&REFERENCE)?).ok()
        }
        _ => None,
    }
}

/// Rewrites every reference in `v`, depth first, with `f`. The walk is a loop, never recursion.
fn rewrite(v: Value, f: &dyn Fn(Id) -> Value) -> Value {
    // Each frame is a value being rebuilt: its remaining children and the ones done.
    enum Frame {
        Array(std::vec::IntoIter<Value>, Vec<Value>),
        Map(
            std::collections::btree_map::IntoIter<u64, Value>,
            Option<u64>,
            BTreeMap<u64, Value>,
        ),
    }
    fn open(v: Value, f: &dyn Fn(Id) -> Value, stack: &mut Vec<Frame>) -> Option<Value> {
        if let Some(r) = reference(&v) {
            return Some(f(r));
        }
        match v {
            Value::Array(a) => {
                stack.push(Frame::Array(a.into_iter(), Vec::new()));
                None
            }
            Value::Map(m) => {
                stack.push(Frame::Map(m.into_iter(), None, BTreeMap::new()));
                None
            }
            other => Some(other),
        }
    }
    let mut stack = Vec::new();
    let mut done = open(v, f, &mut stack);
    loop {
        if let Some(d) = done.take() {
            match stack.last_mut() {
                None => return d,
                Some(Frame::Array(_, out)) => out.push(d),
                Some(Frame::Map(_, key, out)) => {
                    if let Some(k) = key.take() {
                        out.insert(k, d);
                    }
                }
            }
        }
        let next = match stack.last_mut() {
            Some(Frame::Array(it, _)) => it.next(),
            Some(Frame::Map(it, key, _)) => it.next().map(|(k, v)| {
                *key = Some(k);
                v
            }),
            None => unreachable!("returned above"),
        };
        match next {
            Some(child) => done = open(child, f, &mut stack),
            None => {
                done = Some(match stack.pop() {
                    Some(Frame::Array(_, out)) => Value::Array(out),
                    Some(Frame::Map(_, _, out)) => Value::Map(out),
                    None => unreachable!("a frame was open"),
                });
            }
        }
    }
}

/// Every reference in `v`.
pub fn references(v: &Value) -> BTreeSet<Id> {
    let found = std::cell::RefCell::new(BTreeSet::new());
    rewrite(v.clone(), &|r| {
        found.borrow_mut().insert(r);
        Value::Uint(0)
    });
    found.into_inner()
}

/// `v` with each reference on the redaction list marked removed, `{21: id, 22: 1}` (rule 9). A view's records pass
/// through this (T7's `Redactions::scrub`).
pub fn scrub(v: Value, redactions: &Redactions) -> Value {
    rewrite(v, &|r| {
        let mut m = BTreeMap::from([(REFERENCE, r.to_value())]);
        if redactions.contains(r) {
            m.insert(REMOVED, Value::Uint(1));
        }
        Value::Map(m)
    })
}

// --- The text store (a stand-in for K16) and removal --------------------------------------------------------------

/// Words kept apart from the log, by reference (rule 6), each with the audience of the entry that first carried its
/// reference (rule 7). K16 builds the real store; this one is the fixtures'.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextStore(BTreeMap<Id, (Audience, Vec<u8>)>);

impl TextStore {
    /// Keeps `words` under `reference`, a minted id (never a hash of the words), for `audience`.
    pub fn keep(&mut self, reference: Id, audience: Audience, words: &str) {
        self.0
            .insert(reference, (audience, words.as_bytes().to_vec()));
    }

    pub fn words(&self, reference: Id) -> Option<(Audience, &[u8])> {
        self.0.get(&reference).map(|(a, w)| (*a, w.as_slice()))
    }
}

/// Removes words (rule 9): they are deleted from the store and their reference goes on the redaction list. The log is
/// not an input, so it cannot change.
pub fn remove(reference: Id, store: &mut TextStore, redactions: &Redactions) -> Redactions {
    store.0.remove(&reference);
    Redactions::new(redactions.iter().chain([reference]))
}

/// A view as delivered (rule 8): its records, with the words beside each reference that the store holds for the
/// view's own audience, or one of its line (rule 7, as the log stands in `state`), and that the redaction list does not
/// name, `{21: id, 23: words}`. A reference whose words belong to another audience, or are not at hand, is sent bare;
/// one on the list is marked removed. The list must be the one the view was built with (`redactions-differ`), so a
/// removal is never undone by an older list.
pub fn deliver(
    view: &Output,
    store: &TextStore,
    redactions: &Redactions,
    state: &State,
) -> R<Vec<u8>> {
    if view.redactions != redactions.hash() {
        return refuse("redactions-differ", "the view was built with another list");
    }
    let v = rewrite(view.to_value(), &|r| {
        let mut m = BTreeMap::from([(REFERENCE, r.to_value())]);
        if redactions.contains(r) {
            m.insert(REMOVED, Value::Uint(1));
        } else if let Some((a, w)) = store.words(r)
            && same_line(a, view.key.audience, state)
        {
            m.insert(WORDS, Value::Bytes(w.to_vec()));
        }
        Value::Map(m)
    });
    encode(&v).or_else(|e| refuse("encoding", e.to_string()))
}

// --- Audiences, rules and members ---------------------------------------------------------------------------------

/// The kind of an audience node (rule 2).
pub const AUDIENCE_KIND: &str = "souls:audience";
/// The kind of a facet: a child holding the fields of a kind whose audience differs from its node's (rule 3).
pub const FACET_KIND: &str = "souls:facet";

/// SA-F8's four rules (#2947), the one closed list a kind's field or link type names its audience by.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rule {
    Everyone,
    Owner,
    Linked(Name),
    Creator,
}

fn plain(kind: &Name) -> &str {
    kind.as_str().split('@').next().unwrap_or("")
}

/// An audience node's thing, rule number and link type: `{1: 1 owner or 2 linked, 2: link type}` (rule 2).
fn group(state: &State, audience: Id) -> Option<(Id, u64, String)> {
    let n = state.nodes.get(&audience)?;
    if plain(&n.kind) != AUDIENCE_KIND {
        return None;
    }
    let (rule, ty) = match n.fields.get(&1) {
        Some(Value::Uint(1)) => (1, "souls:owns".to_owned()),
        Some(Value::Uint(2)) => match n.fields.get(&2) {
            Some(Value::Text(t)) => (2, t.as_str().to_owned()),
            _ => return None,
        },
        _ => return None,
    };
    Some((n.parent?, rule, ty))
}

/// Whether two audiences are one line (rule 7): the same audience, or audience nodes of one thing and one rule, each
/// superseding the last as members join and leave.
pub fn same_line(a: Audience, b: Audience, state: &State) -> bool {
    match (a, b) {
        _ if a == b => true,
        (Audience::Of(x), Audience::Of(y)) => {
            group(state, x).is_some_and(|g| group(state, y).is_some_and(|h| g == h))
        }
        _ => false,
    }
}

/// The principals a rule names at a thing as the log stands (rule 2): the far ends of that type's links at the thing,
/// each body counted as its Soul (by `souls:body-of`), and any other node end left out.
fn wanted(state: &State, anchor: Id, ty: &str) -> BTreeSet<Id> {
    let soul = |e: Id| -> Option<Id> {
        if !state.nodes.contains_key(&e) {
            return Some(e);
        }
        state
            .links
            .values()
            .find(|l| plain(&l.ty) == "souls:body-of" && l.ends.contains(&e))
            .and_then(|l| l.ends.into_iter().find(|x| *x != e))
    };
    state
        .links
        .values()
        .filter(|l| plain(&l.ty) == ty && l.ends.contains(&anchor))
        .flat_map(|l| l.ends)
        .filter(|e| *e != anchor)
        .filter_map(soul)
        .collect()
}

/// The one resolver (rule 2): the audience a rule names for a thing, as the log stands. `everyone` is everyone; the
/// creator is the world's creator's own principal id; `owner` and `linked` are the thing's audience node for that
/// rule whose members are exactly the principals the rule names now. When there is none (no node yet, or the members
/// changed), it is `audience-not-declared`, naming them: the commit then writes a new audience node with those members.
pub fn resolve(rule: &Rule, anchor: Id, state: &State, creator: Id) -> R<Audience> {
    let (n, ty) = match rule {
        Rule::Everyone => return Ok(Audience::Everyone),
        Rule::Creator => return Ok(Audience::Of(creator)),
        Rule::Owner => (1, "souls:owns".to_owned()),
        Rule::Linked(t) => (2, t.as_str().to_owned()),
    };
    let want = wanted(state, anchor, &ty);
    state
        .nodes
        .keys()
        .rev()
        .find(|id| {
            group(state, **id).is_some_and(|(a, r, t)| a == anchor && r == n && t == ty)
                && members(Audience::Of(**id), state).as_ref() == Some(&want)
        })
        .map(|id| Audience::Of(*id))
        .map_or_else(
            || {
                let names: Vec<String> =
                    want.iter().map(|i| crate::world_model::show(*i)).collect();
                refuse(
                    "audience-not-declared",
                    format!(
                        "{rule:?} at {}: {names:?}",
                        crate::world_model::show(anchor)
                    ),
                )
            },
            Ok,
        )
}

/// The principals in an audience (rule 1): `None` for everyone. An audience node's members are its own
/// `souls:member` links, written with it and never changed; any other audience id is one principal's own (a Soul's, a
/// creator's), with that one member.
pub fn members(audience: Audience, state: &State) -> Option<BTreeSet<Id>> {
    let Audience::Of(id) = audience else {
        return None;
    };
    if group(state, id).is_none() {
        return Some(BTreeSet::from([id]));
    }
    Some(
        state
            .links
            .values()
            .filter(|l| plain(&l.ty) == "souls:member" && l.ends[0] == id)
            .map(|l| l.ends[1])
            .collect(),
    )
}

/// Whether `principal` sees a record of `audience` (rule 1), as the log stood when it was written.
pub fn sees(principal: Id, audience: Audience, written: &State) -> bool {
    members(audience, written).is_none_or(|m| m.contains(&principal))
}

/// The audiences whose views a principal is sent (rule 1; T7 rule 5): everyone, its own, and each audience node it is
/// a member of.
pub fn audiences_of(principal: Id, state: &State) -> Vec<Audience> {
    let mut out = vec![Audience::Everyone, Audience::Of(principal)];
    out.extend(
        state
            .links
            .values()
            .filter(|l| plain(&l.ty) == "souls:member" && l.ends[1] == principal)
            .map(|l| Audience::Of(l.ends[0])),
    );
    out
}

// --- Forks --------------------------------------------------------------------------------------------------------

/// A fork made through one principal's audience (rule 10): the checkpoint as that principal sees it. It keeps the
/// nodes and links it may see, with their ids; no body (T3), nor anything under one; nothing under a node it does not
/// keep; removed words marked removed. It shares the text store and the redaction list. Nothing in flight, no timer
/// of a node it drops.
pub fn fork(state: &State, through: Id, redactions: &Redactions) -> State {
    let bodies: BTreeSet<Id> = state
        .links
        .values()
        .filter(|l| plain(&l.ty) == "souls:body-of")
        .flat_map(|l| l.ends)
        .filter(|e| state.nodes.contains_key(e))
        .collect();
    let mut kept: BTreeSet<Id> = BTreeSet::new();
    // Parents come before children in a walk down from the root, by depth.
    let mut order: Vec<(u64, Id)> = state
        .nodes
        .keys()
        .map(|id| {
            let mut d = 0_u64;
            let mut at = state.nodes.get(id).and_then(|n| n.parent);
            while let Some(p) = at {
                d += 1;
                at = state.nodes.get(&p).and_then(|n| n.parent);
            }
            (d, *id)
        })
        .collect();
    order.sort();
    for (_, id) in order {
        let n = &state.nodes[&id];
        let parent_kept = n.parent.is_none_or(|p| kept.contains(&p));
        if parent_kept && !bodies.contains(&id) && sees(through, n.audience, state) {
            kept.insert(id);
        }
    }
    let mut out = State::start(state.root, state.nodes[&state.root].kind.clone());
    out.nodes = kept
        .iter()
        .map(|id| {
            let mut n = state.nodes[id].clone();
            n.fields = match scrub(Value::Map(n.fields.clone()), redactions) {
                Value::Map(m) => m,
                _ => unreachable!("a map stays a map"),
            };
            (*id, n)
        })
        .collect();
    out.links = state
        .links
        .iter()
        .filter(|(_, l)| {
            sees(through, l.audience, state)
                && l.ends.iter().all(|e| {
                    kept.contains(e) || !state.nodes.contains_key(e) && !bodies.contains(e)
                })
        })
        .map(|(i, l)| (*i, l.clone()))
        .collect();
    out.timers = state
        .timers
        .iter()
        .filter(|(_, t)| kept.contains(&t.node))
        .map(|(i, t)| (*i, t.clone()))
        .collect();
    out.time = state.time.clone();
    out
}
