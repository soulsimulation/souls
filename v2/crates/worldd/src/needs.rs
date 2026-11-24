//! A form's needs checked by the world at commit (#3888): the world is the authority, never the client's check. At
//! an act's commit ([`crate::acts::Acts::start`]), after who may, every need of the form is decided by R2's one
//! evaluator ([`replica::rules::decide_parts`], the function the client's check and a page run in WASM) over the
//! world's own live state: the tree's fields, links and slots, the bodies' seats and hands. An unmet need is refused
//! by its reason's name (`not_linked`, `slot_taken`, ...), its index and words in the detail, before any effect, walk
//! or reservation. A resend of an intent already accepted is not checked again: its run, or its receipt, stands.
//!
//! This module only states the world as R2's input (`{kinds, act, state, asker}`, the asker the world, who sees
//! everything); it decides nothing itself. What it states:
//!
//! - **Nodes**: the thing, every thing argument, the place a `state` need reads through a link, the things in the
//!   actor's hands, and for a `most_per` need the thing's parent and its children of the same kind. Each as `{kind,
//!   fields, links, slots}`: fields by the entry's names (an `enum` by its bare value, a `bool` as true or false, a
//!   `timed` as its three numbers), links by the entry's link names with their far ends (the actor's own Soul stated
//!   as the actor's body, so `end: actor` reads the actor), slots by name with their occupants: a body a seat holds
//!   (B3's table) and the tree's children in that slot.
//! - **The actor**: its body, with its family's hands, each its occupant or null; a two-handed thing fills a second.
//!
//! `within_reach` is not decided here: commit comes before the form's own walk, and reach is measured by the world's
//! move at its start, from the body's edge (C22, `out-of-reach` by name). The other needs are decided as the form
//! states them, by their own index.
//!
//! **A hand step with no way there** ([`hand_reach`], #4086): a form whose hand step (a `take` or a `put` that names
//! no move, [`Step::Hand`]) has no walk and no move before it is done where the body stands, and nothing after commit
//! measures a reach. So the world measures it at commit, for every such form: a thing beyond the body's reach (a
//! form's reach, `crate::acts::within_reach`) is refused `out_of_reach`, the walk to it named as what would work.
//!
//! Deterministic: ordered maps only, no clock but the world's `now`, no float.

use std::collections::BTreeMap;

use replica::effects::Refusal;
use replica::encode::Value as Cbor;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::rules::json::Value;
use replica::rules::{REASONS, decide_parts};
use replica::time::Micros;
use replica::tree::Tree;
use skills::form_runner::{Arg, Args, Step};

use crate::bodies::Bodies;

/// The type of a body's link to its Soul (contract T2).
const BODY_OF: &str = "souls:body-of";

/// The need the world leaves to the move (see the module doc).
const AT_THE_MOVE: &str = "within_reach";

/// A node's key in R2's input: its whole id, so two nodes never share one.
fn key(id: Id) -> String {
    let s = id.scope().0;
    let mut out = String::with_capacity(48);
    for b in s {
        out.push_str(&format!("{b:02x}"));
    }
    out.push(':');
    out.push_str(&id.counter().to_string());
    out
}

fn plain(kind: &str) -> &str {
    kind.split_once('@').map_or(kind, |(p, _)| p)
}

fn int(v: &Cbor) -> Option<i128> {
    match v {
        Cbor::Uint(n) => Some(i128::from(*n)),
        Cbor::Nint(n) => Some(-1 - i128::from(*n)),
        _ => None,
    }
}

/// A stored field as R2 reads it, by the entry's type for it; `None` for what R2 does not read (words).
fn field(def: &Value, v: &Cbor, now: Micros) -> Option<Value> {
    match (def.get("type").and_then(Value::str), v) {
        (Some("bool"), v) => int(v).map(|n| Value::Bool(n != 0)),
        (Some("enum"), Cbor::Text(n)) => {
            let s = n.as_str();
            Some(Value::s(s.split_once(':').map_or(s, |(_, b)| b)))
        }
        (Some("timed"), Cbor::Array(a)) => match a.as_slice() {
            [value, per_s, set_us] => Some(Value::object([
                ("value", Value::Int(int(value)?)),
                ("per_s", Value::Int(int(per_s)?)),
                ("set_us", Value::Int(int(set_us)?)),
            ])),
            _ => None,
        },
        (Some("timed"), v) => Some(Value::object([
            ("value", Value::Int(int(v)?)),
            ("per_s", Value::Int(0)),
            ("set_us", Value::Int(i128::from(now))),
        ])),
        (_, v) => int(v).map(Value::Int),
    }
}

/// The world's input to R2, built for one act.
struct State<'a> {
    tree: &'a Tree,
    bodies: Option<&'a Bodies>,
    kinds: &'a Value,
    /// The actor's body and its Soul.
    body: Id,
    soul: Option<Id>,
    now: Micros,
    nodes: BTreeMap<String, Value>,
}

impl State<'_> {
    fn entry(&self, kind: &str) -> Option<&Value> {
        self.kinds.get(plain(kind))
    }

    /// The far end of a link as R2 reads it: the actor's own Soul is the actor (its body).
    fn end(&self, other: Id) -> Value {
        if Some(other) == self.soul {
            Value::Str(key(self.body))
        } else {
            Value::Str(key(other))
        }
    }

    /// Node `id` as `{kind, fields, links, slots}`, added once; a node not in the tree is left out.
    fn add(&mut self, id: Id) {
        let k = key(id);
        if self.nodes.contains_key(&k) || id == self.body {
            return;
        }
        if let Some(out) = self.record(id) {
            self.nodes.insert(k, Value::Obj(out));
        }
    }

    /// Node `id` as `{kind, fields, links, slots}`; `None` for a node not in the tree.
    fn record(&self, id: Id) -> Option<Vec<(String, Value)>> {
        let n = self.tree.handle(id).and_then(|h| self.tree.node(h))?;
        // The entry the node goes by (#3980): one it borrows (field 27) names its fields, else its kind's.
        let kind = plain(import_eden::entry_name(n.kind().as_str(), n.fields())).to_owned();
        let mut out = vec![("kind".to_owned(), Value::s(&kind))];
        if let Some(entry) = self.entry(&kind) {
            let stored = n.fields();
            let mut fields = Vec::new();
            for (name, def) in entry.get("state").and_then(Value::obj).unwrap_or(&[]) {
                let num = match def.get("n") {
                    Some(Value::Int(n)) => u64::try_from(*n).ok(),
                    _ => None,
                };
                if let Some(v) = num
                    .and_then(|n| stored.get(&n))
                    .and_then(|v| field(def, v, self.now))
                {
                    fields.push((name.clone(), v));
                }
            }
            let mut links = Vec::new();
            for (name, _) in entry.get("links").and_then(Value::obj).unwrap_or(&[]) {
                let ty = replica::audience::link_type(&kind, name);
                let ends: Vec<Value> = self
                    .tree
                    .links_at(id)
                    .iter()
                    .filter(|e| self.tree.ty(e).as_str() == ty)
                    .map(|e| self.end(e.other))
                    .collect();
                links.push((name.clone(), Value::Arr(ends)));
            }
            let children: Vec<(Option<u64>, Id)> = self
                .tree
                .handle(id)
                .and_then(|h| self.tree.children(h))
                .unwrap_or(&[])
                .iter()
                .filter_map(|c| self.tree.node(*c))
                .map(|c| (c.slot(), c.id()))
                .collect();
            let mut slots = Vec::new();
            for (i, (name, _)) in entry
                .get("slots")
                .and_then(Value::obj)
                .unwrap_or(&[])
                .iter()
                .enumerate()
            {
                let slot = i as u64 + 1;
                let mut in_it: Vec<Value> = Vec::new();
                // Every body in it: a slot of several places holds several (E16).
                for b in self
                    .bodies
                    .map(|b| b.slots.holders_in(id, slot))
                    .unwrap_or_default()
                {
                    in_it.push(Value::Str(key(b)));
                }
                for (s, c) in &children {
                    let c = Value::Str(key(*c));
                    if *s == Some(slot) && !in_it.contains(&c) {
                        in_it.push(c);
                    }
                }
                slots.push((name.clone(), Value::Arr(in_it)));
            }
            out.push(("fields".into(), Value::Obj(fields)));
            out.push(("links".into(), Value::Obj(links)));
            out.push(("slots".into(), Value::Obj(slots)));
        }
        Some(out)
    }

    /// The actor's body: its family's hands, each its occupant (a child of the hand's slot) or null; a two-handed
    /// thing held fills a second hand. Returns what the hands hold.
    fn actor(&mut self) -> Vec<Id> {
        let hands: Vec<u64> = self
            .bodies
            .and_then(|b| b.runner.controller.claims(self.body))
            .map(|c| {
                sim::slots::hands::hands(c.family())
                    .iter()
                    .map(|h| h.slot)
                    .collect()
            })
            .unwrap_or_default();
        let mut held: Vec<Option<Id>> = hands
            .iter()
            .map(|s| sim::slots::hands::in_slot(self.tree, self.body, *s))
            .collect();
        let two = |s: &Self, t: Id| {
            let kind = s.tree.handle(t).and_then(|h| s.tree.node(h));
            kind.and_then(|n| s.entry(n.kind().as_str()).cloned())
                .and_then(|e| {
                    e.get("motion")
                        .and_then(|m| m.get("how"))
                        .and_then(Value::str)
                        .map(|h| h == "two_hands")
                })
                .unwrap_or(false)
        };
        let things: Vec<Id> = held.iter().flatten().copied().collect();
        for t in &things {
            if two(self, *t)
                && let Some(free) = held.iter_mut().find(|h| h.is_none())
            {
                *free = Some(*t);
            }
        }
        let hands = hands
            .iter()
            .zip(&held)
            .map(|(s, h)| (s.to_string(), h.map_or(Value::Null, |t| Value::Str(key(t)))))
            .collect();
        // A body that is a node of the tree is read as one (a form done on the body itself reads its kind).
        let mut out = self
            .record(self.body)
            .unwrap_or_else(|| vec![("kind".into(), Value::s("souls:body"))]);
        out.push(("hands".into(), Value::Obj(hands)));
        self.nodes.insert(key(self.body), Value::Obj(out));
        things
    }
}

/// The form with the needs the world leaves to the move taken out, and the index each kept need had.
fn decided_needs(entry: &Value, form: &str) -> Option<(Value, Vec<usize>)> {
    let f = entry.get("forms")?.get(form)?;
    let needs = f.get("needs").and_then(Value::arr)?;
    if !needs
        .iter()
        .any(|n| n.get("need").and_then(Value::str) == Some(AT_THE_MOVE))
    {
        return None;
    }
    let kept: Vec<usize> = (0..needs.len())
        .filter(|i| needs[*i].get("need").and_then(Value::str) != Some(AT_THE_MOVE))
        .collect();
    let mut e = entry.clone();
    if let Value::Obj(o) = &mut e
        && let Some((_, Value::Obj(fs))) = o.iter_mut().find(|(k, _)| k == "forms")
        && let Some((_, Value::Obj(fo))) = fs.iter_mut().find(|(k, _)| k == form)
        && let Some((_, Value::Arr(ns))) = fo.iter_mut().find(|(k, _)| k == "needs")
    {
        *ns = kept.iter().map(|i| needs[*i].clone()).collect();
    }
    Some((e, kept))
}

/// Whether `body` meets every need of form `form` of `entry` (the thing `node`'s kind, with the act's complete
/// arguments `args`) as the world stands: `Ok`, or the first unmet need refused by its reason's name, its index (as
/// the form numbers its needs) and its words in the detail. A need R2 cannot decide on the world's input is not
/// refused here (`unknown`). See the module doc.
#[allow(clippy::too_many_arguments)]
pub fn check(
    tree: &Tree,
    bodies: Option<&Bodies>,
    kinds: &Value,
    body: Id,
    node: Id,
    entry: &Value,
    form: &str,
    args: &Args,
    now: Micros,
) -> Result<(), Refusal> {
    let Some(f) = entry.get("forms").and_then(|fs| fs.get(form)) else {
        return Ok(());
    };
    if f.get("needs")
        .and_then(Value::arr)
        .is_none_or(<[Value]>::is_empty)
    {
        return Ok(());
    }
    let soul = tree
        .links_at(body)
        .iter()
        .find(|e| tree.ty(e).as_str() == BODY_OF)
        .map(|e| e.other);
    let mut s = State {
        tree,
        bodies,
        kinds,
        body,
        soul,
        now,
        nodes: BTreeMap::new(),
    };
    let held = s.actor();
    s.add(node);
    for t in held {
        s.add(t);
    }
    let mut act_args = Vec::new();
    for (name, a) in args {
        let v = match a {
            Arg::Name(n) => Value::s(n),
            Arg::Node(id) => {
                s.add(*id);
                Value::Str(key(*id))
            }
            // A slot of another thing is R2's `{node, slot}`, the slot by its name in that thing's entry (E14b).
            Arg::Slot(id, n) => {
                s.add(*id);
                let name = tree
                    .handle(*id)
                    .and_then(|h| tree.node(h))
                    .and_then(|t| {
                        s.entry(import_eden::entry_name(t.kind().as_str(), t.fields()))
                            .and_then(|e| e.get("slots"))
                            .and_then(Value::obj)
                            .and_then(|o| o.get(usize::try_from(*n).ok()?.checked_sub(1)?))
                            .map(|(name, _)| name.clone())
                    })
                    .unwrap_or_else(|| n.to_string());
                Value::Obj(vec![
                    ("node".into(), Value::Str(key(*id))),
                    ("slot".into(), Value::Str(name)),
                ])
            }
            Arg::Text(id) => Value::Str(key(*id)),
            Arg::Int(n) => Value::Int(i128::from(*n)),
        };
        act_args.push((name.clone(), v));
    }
    let needs = f.get("needs").and_then(Value::arr).unwrap_or(&[]);
    // A `state` need read through a link reads the place at the link's far end; `most_per` reads the siblings.
    for n in needs {
        let what = n.get("need").and_then(Value::str);
        if what == Some("state")
            && let Some(link) = n.get("link").and_then(Value::str)
            && let Some(k) = tree.handle(node).and_then(|h| tree.node(h))
        {
            let ty = replica::audience::link_type(plain(k.kind().as_str()), link);
            let far = tree
                .links_at(node)
                .iter()
                .find(|e| tree.ty(e).as_str() == ty)
                .map(|e| e.other);
            if let Some(far) = far {
                s.add(far);
            }
        }
        if what == Some("most_per")
            && let Some(parent) = tree
                .handle(node)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.parent())
        {
            let kind = tree
                .handle(node)
                .and_then(|h| tree.node(h))
                .map(|n| n.kind().clone());
            let children: Vec<Id> = tree
                .handle(parent)
                .and_then(|h| tree.children(h))
                .unwrap_or(&[])
                .iter()
                .filter_map(|c| tree.node(*c))
                .filter(|c| Some(c.kind()) == kind.as_ref())
                .map(|c| c.id())
                .take(replica::rules::MAX_SIBLINGS + 1)
                .collect();
            for c in &children {
                s.add(*c);
            }
            s.nodes.insert(
                format!("parent of {}", key(node)),
                Value::object([(
                    "children",
                    Value::Arr(children.iter().map(|c| Value::Str(key(*c))).collect()),
                )]),
            );
        }
    }
    let this_kind = tree
        .handle(node)
        .and_then(|h| tree.node(h))
        .map(|n| plain(import_eden::entry_name(n.kind().as_str(), n.fields())).to_owned())
        .unwrap_or_default();
    let narrowed = decided_needs(entry, form);
    let (form_entry, index): (&Value, Option<&[usize]>) = match &narrowed {
        Some((e, kept)) => (e, Some(kept)),
        None => (entry, None),
    };
    // The kinds R2 reads: the world's, with this kind's entry as this act binds it.
    let mut by_kind: Vec<(String, Value)> = Vec::new();
    by_kind.push((this_kind.clone(), form_entry.clone()));
    for n in s.nodes.values() {
        if let Some(k) = n.get("kind").and_then(Value::str)
            && k != this_kind
            && !by_kind.iter().any(|(x, _)| x == k)
            && let Some(e) = kinds.get(k)
        {
            by_kind.push((k.to_owned(), e.clone()));
        }
    }
    let act = Value::Obj(vec![
        ("this".into(), Value::Str(key(node))),
        ("form".into(), Value::s(form)),
        ("args".into(), Value::Obj(act_args)),
    ]);
    let state = Value::Obj(vec![
        ("actor".into(), Value::Str(key(body))),
        ("nodes".into(), Value::Obj(s.nodes.into_iter().collect())),
        ("now_us".into(), Value::Int(i128::from(now))),
        ("moves".into(), Value::Obj(Vec::new())),
    ]);
    let asker = Value::object([("sees", Value::s("all"))]);
    let verdict = decide_parts(
        Some(&Value::Obj(by_kind)),
        Some(&act),
        Some(&state),
        Some(&asker),
    );
    if verdict.get("verdict").and_then(Value::str) != Some("no") {
        return Ok(());
    }
    let reason = verdict.get("reason").and_then(Value::str).unwrap_or("");
    let what = verdict
        .get("detail")
        .and_then(|d| d.get("what"))
        .and_then(Value::str);
    // An argument the act does not give is the runner's own `arg-missing`, whichever need reads it.
    let name = if reason == "bad_input" && what == Some("argument_missing") {
        "arg-missing"
    } else {
        REASONS
            .iter()
            .find(|r| **r == reason)
            .copied()
            .unwrap_or("bad_input")
    };
    let i = match verdict.get("need") {
        Some(Value::Int(i)) => *i,
        _ => -1,
    };
    let i = usize::try_from(i)
        .ok()
        .map(|i| index.and_then(|k| k.get(i).copied()).unwrap_or(i));
    let mut detail = match i {
        Some(i) => {
            let what = needs
                .get(i)
                .and_then(|n| n.get("need"))
                .and_then(Value::str)
                .unwrap_or("");
            format!("need {i} ({what})")
        }
        None => "the form".to_owned(),
    };
    if let Some(says) = verdict.get("says").and_then(Value::str) {
        detail.push_str(&format!(": {says}"));
    }
    if let Some(d) = verdict.get("detail") {
        detail.push(' ');
        detail.push_str(&d.to_json());
    }
    Err(Refusal { name, detail })
}

/// Whether bound steps do their hand step where the body stands: a [`Step::Hand`] with no walk, move or seat before
/// it, which would bring the body to the thing or measure its reach.
fn by_hand_here(steps: &[Step]) -> bool {
    for s in steps {
        match s {
            Step::Hand => return true,
            Step::WalkTo { .. } | Step::Move { .. } | Step::Sit { .. } => return false,
            Step::Wait(_) | Step::Rise | Step::Settle { .. } | Step::UseHeld => {}
        }
    }
    false
}

/// Whether `body` may do form `form` of `entry` on `node` (with the act's complete arguments `args`) from where it
/// stands (see the module doc, #4086): `Ok` for a form that walks or moves before its hand step, or has none, and for
/// a thing within the body's reach; else `out_of_reach`, with the walk to the thing that would work. A body or a thing
/// whose place the world cannot read is not refused here (unknown is not no).
#[allow(clippy::too_many_arguments)]
pub fn hand_reach(
    tree: &Tree,
    entry: &Value,
    form: &str,
    args: &Args,
    body: Id,
    body_at: Option<Vec3>,
    node: Id,
) -> Result<(), Refusal> {
    let Ok(steps) = skills::form_runner::bind_with(entry, form, args) else {
        return Ok(());
    };
    if !by_hand_here(&steps)
        || crate::acts::world_at(tree, body).or(body_at).is_none()
        || crate::acts::world_at(tree, node).is_none()
        || crate::acts::within_reach(tree, entry, body, body_at, node)
    {
        return Ok(());
    }
    Err(Refusal {
        name: "out_of_reach",
        detail: format!(
            "the form's hand step is done where the body stands, and {} is beyond its reach: walk to it first {}",
            replica::world_model::show(node),
            Value::object([
                ("step", Value::s("walk_to")),
                ("thing", Value::Str(key(node)))
            ])
            .to_json()
        ),
    })
}
