//! Read-only exact-time node timeline over a named public bundle. Native replay owns semantics;
//! initial nodes are emitted once, then only touched ids are inspected for output.
use super::{Bundle, seek};
use crate::effects::{
    Body, Change, Effect, Header, NodeState, Refusal, State, TransferRec, read_id,
};
use crate::encode::Value;
use crate::ids::Id;
use crate::world_model::Audience;
use std::collections::{BTreeMap, BTreeSet};
type R<T> = Result<T, Refusal>;
fn bad<T>(detail: &str) -> R<T> {
    Err(Refusal {
        name: "history-timeline",
        detail: detail.into(),
    })
}
#[derive(Debug, Default)]
/// Output-adapter counters, excluding inherited replay/validation/hash work.
pub struct Stats {
    pub records: usize,
    pub inspected_nodes: usize,
    pub emitted_nodes: usize,
}
#[derive(Debug)]
pub struct Transition {
    pub at: i64,
    pub nodes: BTreeMap<Id, NodeState>,
    pub removed: Vec<Id>,
}
#[derive(Debug)]
/// One validated batch. Memory retains the parsed bundle, replay state and all requested
/// changed-node output. This is not a bounded-memory cursor; callers choose the bundle/window.
pub struct Timeline {
    pub from: i64,
    pub to: i64,
    pub start: i64,
    pub length: i64,
    pub initial: BTreeMap<Id, NodeState>,
    pub transitions: Vec<Transition>,
    pub stats: Stats,
}
struct Index {
    children: BTreeMap<Id, BTreeSet<Id>>,
}
impl Index {
    fn new(state: &State) -> Self {
        let mut index = Self {
            children: BTreeMap::new(),
        };
        for (id, n) in &state.nodes {
            if let Some(p) = n.parent {
                index.children.entry(p).or_default().insert(*id);
            }
        }
        index
    }
    fn subtree(&self, id: Id, out: &mut BTreeSet<Id>) {
        let mut pending = vec![id];
        while let Some(id) = pending.pop() {
            if out.insert(id) {
                pending.extend(self.children.get(&id).into_iter().flatten().copied());
            }
        }
    }
    fn update(&mut self, id: Id, before: Option<&NodeState>, after: Option<&NodeState>) {
        if let Some(p) = before.and_then(|n| n.parent)
            && let Some(c) = self.children.get_mut(&p)
        {
            c.remove(&id);
            if c.is_empty() {
                self.children.remove(&p);
            }
        }
        if let Some(p) = after.and_then(|n| n.parent) {
            self.children.entry(p).or_default().insert(id);
        }
    }
    fn touched(
        &self,
        state: &State,
        e: &Effect,
        carried: Option<&BTreeMap<u64, Value>>,
    ) -> R<BTreeSet<Id>> {
        let mut ids = BTreeSet::new();
        let mut change = |c: &Change| match c {
            Change::Create { node, .. }
            | Change::Reparent { node, .. }
            | Change::Set { node, .. } => {
                ids.insert(*node);
            }
            Change::Motion(m) => {
                ids.insert(m.node);
            }
            Change::Remove { node } => self.subtree(*node, &mut ids),
            Change::Link { .. } | Change::Unlink { .. } => {}
        };
        match &e.body {
            Body::Changes(cs) => {
                for c in cs {
                    change(&c.change)
                }
            }
            Body::Transfer(t) => match t {
                TransferRec::Leave { node, .. } => self.subtree(*node, &mut ids),
                TransferRec::Arrive { transfer, carried } => {
                    for c in carried {
                        change(&c.change);
                    }
                    if let Some(f) = state.in_flight.get(transfer) {
                        ids.extend(f.nodes.keys());
                    }
                }
                TransferRec::Return { transfer, .. } => {
                    if let Some(f) = state.in_flight.get(transfer) {
                        ids.extend(f.nodes.keys());
                    }
                }
                TransferRec::Settle { .. } => {}
            },
            Body::Timers(_) | Body::Time(_) => {}
        }
        if let Some(c) = carried
            && let Some(Value::Array(rows)) = c.get(&2)
        {
            for row in rows {
                if let Value::Array(row) = row
                    && let Some(id) = row.first()
                {
                    ids.insert(read_id(id)?);
                }
            }
        }
        Ok(ids)
    }
}
impl Timeline {
    /// Inclusive native microsecond window. All input is validated before output is returned.
    /// Equal-time replacements retain source order; no live state or fabricated effect is used.
    pub fn read(header: &[u8], bytes: &[u8], hash: &[u8; 32], from: i64, to: i64) -> R<Self> {
        let header = Header::read(header)?;
        let bundle = Bundle::read_named(bytes, hash)?;
        if bundle.header != header.hash().to_bytes() {
            return bad("header mismatch");
        }
        if from < bundle.start || to < from {
            return bad("invalid window");
        }
        let mut out = Self {
            from,
            to,
            start: bundle.start,
            length: bundle.length,
            initial: BTreeMap::new(),
            transitions: vec![],
            stats: Stats::default(),
        };
        if let Some(observation) = &bundle.observation {
            seek::walk_observation(&bundle, &header, observation, |time, projection, delta| {
                if let Some(delta) = delta {
                    out.stats.records += 1;
                    let Value::Map(delta) = delta else {
                        return bad("delta map");
                    };
                    let mut nodes = BTreeMap::new();
                    let mut removed = vec![];
                    if let Some(Value::Array(rows)) = delta.get(&2) {
                        for row in rows {
                            let Value::Array(row) = row else {
                                return bad("node row");
                            };
                            let id = read_id(&row[0])?;
                            out.stats.inspected_nodes += 1;
                            if row.len() == 1 {
                                removed.push(id);
                            } else {
                                nodes.insert(id, NodeState::read(&row[1])?);
                            }
                        }
                    }
                    out.accept(time, nodes, removed);
                } else {
                    let Value::Map(projection) = projection else {
                        return bad("projection map");
                    };
                    let Some(Value::Array(rows)) = projection.get(&2) else {
                        return bad("initial nodes");
                    };
                    for row in rows {
                        let Value::Array(row) = row else {
                            return bad("initial row");
                        };
                        out.initial
                            .insert(read_id(&row[0])?, NodeState::read(&row[1])?);
                    }
                }
                Ok(())
            })?;
        } else {
            let state = seek::snapshot_state(&bundle.snapshot)?;
            if state.root != header.zone {
                return bad("snapshot root");
            }
            out.initial = state.nodes.clone();
            let mut index = Index::new(&state);
            let mut before = BTreeMap::new();
            let mut last = bundle.start;
            seek::walk_legacy(&bundle, &header, i64::MAX, |state, e, carried, after| {
                if !after {
                    if e.envelope.at < last
                        || e.envelope.at
                            >= bundle
                                .start
                                .checked_add(bundle.length)
                                .ok_or_else(|| Refusal {
                                    name: "history-timeline",
                                    detail: "window overflow".into(),
                                })?
                    {
                        return bad("record time order/window");
                    }
                    last = e.envelope.at;
                    if e.envelope.audience != Audience::Everyone {
                        return bad("nonpublic effect");
                    }
                    let ids = index.touched(state, e, carried)?;
                    before = ids
                        .into_iter()
                        .map(|id| (id, state.nodes.get(&id).cloned()))
                        .collect();
                } else {
                    out.stats.records += 1;
                    let mut nodes = BTreeMap::new();
                    let mut removed = vec![];
                    for (id, old) in &before {
                        let new = state.nodes.get(id);
                        out.stats.inspected_nodes += 1;
                        index.update(*id, old.as_ref(), new);
                        if old.as_ref() != new {
                            if let Some(n) = new {
                                if n.audience != Audience::Everyone {
                                    return bad("nonpublic node");
                                }
                                nodes.insert(*id, n.clone());
                            } else {
                                removed.push(*id);
                            }
                        }
                    }
                    out.accept(e.envelope.at, nodes, removed);
                }
                Ok(())
            })?;
        }
        out.stats.emitted_nodes = out.initial.len()
            + out
                .transitions
                .iter()
                .map(|t| t.nodes.len() + t.removed.len())
                .sum::<usize>();
        Ok(out)
    }
    fn accept(&mut self, at: i64, nodes: BTreeMap<Id, NodeState>, removed: Vec<Id>) {
        if at <= self.from {
            for id in removed {
                self.initial.remove(&id);
            }
            self.initial.extend(nodes);
        } else if at <= self.to && (!nodes.is_empty() || !removed.is_empty()) {
            self.transitions.push(Transition { at, nodes, removed });
        }
    }
    /// Same node record shape as historyAt, ready for the existing client node adapter.
    pub fn node(id: Id, n: &NodeState) -> Value {
        let mut m = BTreeMap::from([
            (1, id.to_value()),
            (2, Value::Text(n.kind.clone())),
            (6, Value::Map(n.fields.clone())),
        ]);
        m.extend(n.parent.map(|p| (3, p.to_value())));
        m.extend(n.slot.map(|s| (4, Value::Uint(s))));
        m.extend(n.place.clone().map(|p| (7, p)));
        m.extend(n.motion.clone().map(|m| (8, m)));
        Value::Map(m)
    }
    pub fn to_value(&self) -> Value {
        use crate::hash::int;
        let nodes = |ns: &BTreeMap<Id, NodeState>| {
            Value::Array(ns.iter().map(|(id, n)| Self::node(*id, n)).collect())
        };
        Value::Map(BTreeMap::from([
            (1, int(self.from)),
            (2, nodes(&self.initial)),
            (
                3,
                Value::Array(
                    self.transitions
                        .iter()
                        .map(|t| {
                            Value::Map(BTreeMap::from([
                                (1, int(t.at)),
                                (2, nodes(&t.nodes)),
                                (
                                    3,
                                    Value::Array(
                                        t.removed.iter().map(|id| id.to_value()).collect(),
                                    ),
                                ),
                            ]))
                        })
                        .collect(),
                ),
            ),
            (4, int(self.start)),
            (5, int(self.length)),
            (6, int(self.to)),
            (
                7,
                Value::Array(vec![
                    Value::Uint(self.stats.records as u64),
                    Value::Uint(self.stats.inspected_nodes as u64),
                    Value::Uint(self.stats.emitted_nodes as u64),
                ]),
            ),
        ]))
    }
}
