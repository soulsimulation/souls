//! Versioned observations of a canonically validated public view. This is a reader, never an engine apply path.
//! Opaque parent ids are references, not nodes. Hashes bind continuity; the canonical producer authorizes data.
use super::{Played, StreamPart, int, read_map, refuse};
use crate::effects::{
    Body, Change, Header, LinkState, NodeState, Part, Refusal, State, TransferRec, read_id,
};
use crate::encode::{Value, encode};
use crate::ids::{Hash, Id, Purpose, sha256};
use crate::pose::{HandOff, Pose};
use crate::time::{Tempo, TickRate, TimeEffect, Timeline};
use crate::world_model::{Audience, DEPTH_LIMIT, End};
use std::collections::{BTreeMap, BTreeSet};
type R<T> = Result<T, Refusal>;
pub const FORMAT: u64 = 1;
fn bad<T>(s: &str) -> R<T> {
    refuse("public-stream-record", s)
}
fn map(v: &Value) -> R<&BTreeMap<u64, Value>> {
    if let Value::Map(m) = v {
        Ok(m)
    } else {
        bad("expected a map")
    }
}
fn arr(v: &Value) -> R<&[Value]> {
    if let Value::Array(a) = v {
        Ok(a)
    } else {
        bad("expected an array")
    }
}
fn field(m: &BTreeMap<u64, Value>, k: u64) -> R<&Value> {
    m.get(&k).ok_or_else(|| Refusal {
        name: "public-stream-record",
        detail: format!("missing field {k}"),
    })
}
fn uint(v: &Value) -> R<u64> {
    if let Value::Uint(n) = v {
        Ok(*n)
    } else {
        bad("expected an unsigned integer")
    }
}
fn bytes(v: &Value) -> R<&[u8]> {
    if let Value::Bytes(b) = v {
        Ok(b)
    } else {
        bad("expected bytes")
    }
}
fn encoded(v: &Value) -> R<Vec<u8>> {
    encode(v).map_err(|e| Refusal {
        name: "encoding",
        detail: e.to_string(),
    })
}
pub fn digest(v: &Value) -> R<Vec<u8>> {
    Ok(sha256(&encoded(v)?).to_vec())
}
fn pairs(v: &Value) -> R<BTreeMap<Id, Value>> {
    let mut out = BTreeMap::new();
    for p in arr(v)? {
        let p = arr(p)?;
        if p.len() != 2 {
            return bad("expected an id/value pair");
        };
        let id = read_id(&p[0])?;
        if out.insert(id, p[1].clone()).is_some() {
            return bad("duplicate id");
        }
    }
    Ok(out)
}
fn paired(m: BTreeMap<Id, Value>) -> Value {
    Value::Array(
        m.into_iter()
            .map(|(i, v)| Value::Array(vec![i.to_value(), v]))
            .collect(),
    )
}
/// Only IDs already authorized in this observation's public transfer state; no private flight ledger.
pub fn flying_ids(state: &Value) -> R<BTreeSet<Id>> {
    let m = map(state)?;
    let mut ids: BTreeSet<Id> = pairs(field(m, 8)?)?.into_keys().collect();
    for flight in pairs(field(m, 4)?)?.into_values() {
        ids.extend(pairs(field(map(&flight)?, 5)?)?.into_keys());
    }
    Ok(ids)
}
fn public(a: Audience) -> bool {
    a == Audience::Everyone
}

/// Only audience-authorized state. Field5 (global arrived) is deliberately absent. Field8 holds public nodes
/// within a nonpublic flight, without that private flight's identity, root properties or destination; field9
/// preserves those public nodes' authorized owned links separately from the live query index.
pub fn project(header: &Header, state: &State) -> R<Value> {
    let Value::Map(raw) = state.to_value() else {
        unreachable!("state is a map")
    };
    let ns: BTreeMap<Id, Value> = pairs(&raw[&2])?
        .into_iter()
        .filter(|(id, _)| state.nodes.get(id).is_some_and(|n| public(n.audience)))
        .collect();
    let mut seen: BTreeSet<Id> = ns.keys().copied().collect();
    let audiences: BTreeMap<Id, Audience> = state
        .nodes
        .iter()
        .map(|(i, n)| (*i, n.audience))
        .chain(
            state
                .in_flight
                .values()
                .flat_map(|f| f.nodes.iter().map(|(i, n)| (*i, n.audience))),
        )
        .collect();
    for f in state.in_flight.values() {
        seen.extend(
            f.nodes
                .iter()
                .filter(|(_, n)| public(n.audience))
                .map(|(i, _)| *i),
        );
    }
    let links = pairs(&raw[&3])?
        .into_iter()
        .filter(|(id, _)| {
            state.links.get(id).is_some_and(|l| {
                public(l.audience)
                    && l.ends
                        .iter()
                        .all(|i| audiences.get(i).is_none_or(|a| public(*a)))
            })
        })
        .collect();
    let mut out = BTreeMap::from([
        (1, Value::Uint(state.next)),
        (2, paired(ns)),
        (3, paired(links)),
    ]);
    let mut flights = BTreeMap::new();
    let mut opaque = BTreeMap::new();
    let mut opaque_links = BTreeMap::new();
    if let Some(v) = raw.get(&4) {
        for (id, v) in pairs(v)? {
            let f = &state.in_flight[&id];
            let mut v = map(&v)?.clone();
            let nodes = pairs(&v[&5])?
                .into_iter()
                .filter(|(i, _)| f.nodes.get(i).is_some_and(|n| public(n.audience)))
                .collect::<BTreeMap<_, _>>();
            let links = pairs(&v[&6])?
                .into_iter()
                .filter(|(i, _)| {
                    f.links.get(i).is_some_and(|l| {
                        public(l.audience)
                            && nodes.contains_key(&l.ends[usize::from(l.owner == End::Second)])
                            && l.ends
                                .iter()
                                .all(|i| audiences.get(i).is_none_or(|a| public(*a)))
                    })
                })
                .collect();
            if f.nodes.get(&f.root).is_some_and(|n| public(n.audience)) {
                v.insert(5, paired(nodes));
                v.insert(6, paired(links));
                flights.insert(id, Value::Map(v));
            } else {
                opaque.extend(nodes);
                opaque_links.extend(links);
            }
        }
    }
    out.insert(4, paired(flights));
    out.insert(8, paired(opaque));
    out.insert(9, paired(opaque_links));
    let timers = if let Some(v) = raw.get(&6) {
        pairs(v)?
            .into_iter()
            .filter(|(i, _)| state.timers.get(i).is_some_and(|t| seen.contains(&t.node)))
            .collect()
    } else {
        BTreeMap::new()
    };
    out.insert(6, paired(timers));
    out.insert(7, raw.get(&7).cloned().unwrap_or(Value::Array(Vec::new())));
    let value = Value::Map(out);
    validate(header, &value)?;
    Ok(value)
}

fn validate_node(header: &Header, id: Id, n: &NodeState) -> R<()> {
    if !public(n.audience) || !header.kinds.contains(&n.kind) {
        return bad("node audience or pinned kind");
    }
    if id == header.zone {
        if n.parent.is_some() || n.place.is_some() || n.motion.is_some() || n.slot.is_some() {
            return bad("root frame");
        };
        return Ok(());
    }
    let parent = n.parent.ok_or_else(|| Refusal {
        name: "public-stream-record",
        detail: "nonroot has no parent reference".into(),
    })?;
    let mut p = map(n.place.as_ref().ok_or_else(|| Refusal {
        name: "public-stream-record",
        detail: "missing local pose".into(),
    })?)?
    .clone();
    let mut frame = vec![parent.to_value()];
    frame.extend(n.slot.map(Value::Uint));
    p.insert(1, Value::Array(frame));
    let pose = Pose::from_value(&Value::Map(p)).map_err(|e| Refusal {
        name: "public-stream-record",
        detail: e.name().into(),
    })?;
    if let Some(v) = &n.motion {
        let m = map(v)?;
        if m.len() != 4 || !(1..=4).all(|k| m.contains_key(&k)) {
            return bad("motion fields");
        }
        HandOff::from_value(&Value::Map(BTreeMap::from([
            (1, id.to_value()),
            (2, m[&1].clone()),
            (3, m[&4].clone()),
            (4, m[&4].clone()),
            (5, pose.to_value()),
            (6, m[&2].clone()),
            (7, m[&3].clone()),
        ])))
        .map_err(|e| Refusal {
            name: "public-stream-record",
            detail: e.name().into(),
        })?;
    }
    Ok(())
}
fn validate(header: &Header, value: &Value) -> R<()> {
    let m = map(value)?;
    if m.keys().any(|k| ![1, 2, 3, 4, 6, 7, 8, 9].contains(k)) || m.len() != 8 {
        return bad("public projection fields");
    }
    uint(field(m, 1)?)?;
    let nodes = pairs(field(m, 2)?)?;
    if !nodes.contains_key(&header.zone) {
        return bad("public root missing");
    }
    let mut all = BTreeMap::new();
    for (id, v) in &nodes {
        let n = NodeState::read(v)?;
        validate_node(header, *id, &n)?;
        all.insert(*id, n);
    }
    let opaque = pairs(field(m, 8)?)?;
    for (id, v) in &opaque {
        let n = NodeState::read(v)?;
        validate_node(header, *id, &n)?;
        if all.insert(*id, n).is_some() {
            return bad("duplicate live/flying node");
        }
    }
    for (_, v) in pairs(field(m, 4)?)? {
        let f = map(&v)?;
        if f.len() != 6 {
            return bad("flight fields");
        };
        let root = read_id(field(f, 1)?)?;
        let lineage = bytes(field(f, 2)?)?;
        if lineage.len() != 16 {
            return bad("flight lineage");
        };
        read_id(field(f, 3)?)?;
        Pose::from_value(field(f, 4)?).map_err(|e| Refusal {
            name: "public-stream-record",
            detail: e.name().into(),
        })?;
        let ns = pairs(field(f, 5)?)?;
        if !ns.contains_key(&root) {
            return bad("public flight root missing");
        };
        for (id, v) in &ns {
            let n = NodeState::read(v)?;
            validate_node(header, *id, &n)?;
            if all.insert(*id, n).is_some() {
                return bad("duplicate flight node");
            }
        }
        for (_, v) in pairs(field(f, 6)?)? {
            let l = LinkState::read(&v)?;
            if !public(l.audience) || !ns.contains_key(&l.ends[usize::from(l.owner == End::Second)])
            {
                return bad("private flight link or missing public owner");
            }
        }
    }
    for n in all.values() {
        let mut parent = n.parent;
        let mut visited = BTreeSet::new();
        for _ in 0..=DEPTH_LIMIT {
            let Some(id) = parent else { break };
            if !visited.insert(id) {
                return bad("public frame cycle");
            };
            parent = all.get(&id).and_then(|n| n.parent);
            if parent.is_none() {
                break;
            }
        }
        if parent.is_some() {
            return bad("public frame depth");
        }
    }
    for (_, v) in pairs(field(m, 3)?)? {
        let l = LinkState::read(&v)?;
        if !public(l.audience) || !nodes.contains_key(&l.ends[usize::from(l.owner == End::Second)])
        {
            return bad("private link or missing live owner");
        }
    }
    for (_, v) in pairs(field(m, 9)?)? {
        let l = LinkState::read(&v)?;
        if !public(l.audience) || !opaque.contains_key(&l.ends[usize::from(l.owner == End::Second)])
        {
            return bad("private flying link or missing public owner");
        }
    }
    for (_, v) in pairs(field(m, 6)?)? {
        let t = map(&v)?;
        if t.len() != 3 || !all.contains_key(&read_id(field(t, 1)?)?) {
            return bad("timer owner");
        };
        super::read_int(t.get(&2), "timer due")?;
        if !matches!(t.get(&3), Some(Value::Text(_))) {
            return bad("timer name");
        }
    }
    let times = arr(field(m, 7)?)?
        .iter()
        .map(TimeEffect::from_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| Refusal {
            name: "public-stream-record",
            detail: e.to_string(),
        })?;
    let error = |e: crate::time::TimeRefusal| Refusal {
        name: "public-stream-record",
        detail: e.name().into(),
    };
    if let Some(first) = times.iter().find_map(|t| {
        if let TimeEffect::Mapping(m) = t {
            Some(*m)
        } else {
            None
        }
    }) {
        let mut line = Timeline::start(
            first,
            TickRate::new(0, 0, 20).map_err(error)?,
            Tempo::per_minute(0, 0, 120).map_err(error)?,
        )
        .map_err(error)?;
        for t in times
            .iter()
            .filter_map(|t| {
                if let TimeEffect::Mapping(m) = t {
                    Some(*m)
                } else {
                    None
                }
            })
            .skip(1)
        {
            line.apply(TimeEffect::Mapping(t), t.world_us)
                .map_err(error)?;
        }
    }
    Ok(())
}

pub fn baseline(header: &Header, state: &State, record: u64) -> R<Vec<u8>> {
    baseline_from_projection(header, project(header, state)?, record)
}
pub fn baseline_from_projection(header: &Header, state: Value, record: u64) -> R<Vec<u8>> {
    validate(header, &state)?;
    encoded(&Value::Map(BTreeMap::from([
        (1, Value::Uint(FORMAT)),
        (2, Value::Bytes(header.hash().to_bytes())),
        (3, state),
        (4, Value::Uint(record)),
    ])))
}
/// Integrity-bound observation, computed only after the producer canonically applied a whole source part.
/// The delta replaces only changed top-level projection fields; no historical effects are manufactured.
/// Audience-validated public observation delta, shared by stream and history readers.
pub fn observation_delta(header: &Header, before: &Value, after: &Value) -> R<Value> {
    validate(header, before)?;
    validate(header, after)?;
    let old = map(before)?;
    let new = map(after)?;
    let mut delta = BTreeMap::new();
    for (k, v) in new.iter().filter(|(k, v)| old.get(k) != Some(v)) {
        if [2, 3, 4, 6, 8, 9].contains(k) {
            let a = pairs(&old[k])?;
            let b = pairs(v)?;
            let ids: BTreeSet<Id> = a.keys().chain(b.keys()).copied().collect();
            let rows = ids
                .into_iter()
                .filter(|i| a.get(i) != b.get(i))
                .map(|i| {
                    let mut row = vec![i.to_value()];
                    row.extend(b.get(&i).cloned());
                    Value::Array(row)
                })
                .collect();
            delta.insert(*k, Value::Array(rows));
        } else {
            delta.insert(*k, v.clone());
        }
    }
    Ok(Value::Map(delta))
}

/// Check an existing authorized projection without exposing the private canonical state.
pub fn validate_projection(header: &Header, value: &Value) -> R<()> {
    validate(header, value)
}

/// Apply exactly the existing public per-id delta rules, atomically, for an integrity-bound observation.
pub fn apply_observation(header: &Header, before: &Value, delta: &Value) -> R<Value> {
    validate(header, before)?;
    let mut next = map(before)?.clone();
    for (k, v) in map(delta)? {
        if [2, 3, 4, 6, 8, 9].contains(k) {
            let mut entries = pairs(field(&next, *k)?)?;
            let mut ids = BTreeSet::new();
            for row in arr(v)? {
                let row = arr(row)?;
                if !(1..=2).contains(&row.len()) {
                    return bad("delta row shape");
                }
                let id = read_id(&row[0])?;
                if !ids.insert(id) {
                    return bad("duplicate delta id");
                }
                if row.len() == 1 {
                    if entries.remove(&id).is_none() {
                        return bad("delta removes absent id");
                    }
                } else {
                    entries.insert(id, row[1].clone());
                }
            }
            next.insert(*k, paired(entries));
        } else {
            next.insert(*k, v.clone());
        }
    }
    let next = Value::Map(next);
    validate(header, &next)?;
    Ok(next)
}

pub fn context(
    baseline: &[u8],
    before: &Value,
    after: &Value,
    record: u64,
    duplicates: &[(u64, Id)],
    changed: &[(Id, u64)],
) -> R<Vec<u8>> {
    let old = map(before)?;
    let new = map(after)?;
    let mut delta = BTreeMap::new();
    for (k, v) in new.iter().filter(|(k, v)| old.get(k) != Some(v)) {
        if [2, 3, 4, 6, 8, 9].contains(k) {
            let a = pairs(&old[k])?;
            let b = pairs(v)?;
            let ids: BTreeSet<Id> = a.keys().chain(b.keys()).copied().collect();
            let rows = ids
                .into_iter()
                .filter(|i| a.get(i) != b.get(i))
                .map(|i| {
                    let mut row = vec![i.to_value()];
                    row.extend(b.get(&i).cloned());
                    Value::Array(row)
                })
                .collect();
            delta.insert(*k, Value::Array(rows));
        } else {
            delta.insert(*k, v.clone());
        }
    }
    encoded(&Value::Map(BTreeMap::from([
        (1, Value::Uint(FORMAT)),
        (2, Value::Bytes(sha256(baseline).to_vec())),
        (3, Value::Bytes(digest(before)?)),
        (4, Value::Bytes(digest(after)?)),
        (5, Value::Map(delta)),
        (6, Value::Uint(record)),
        (
            7,
            Value::Array(
                duplicates
                    .iter()
                    .map(|(s, i)| Value::Array(vec![Value::Uint(*s), i.to_value()]))
                    .collect(),
            ),
        ),
        (
            8,
            Value::Array(
                changed
                    .iter()
                    .map(|(i, v)| Value::Array(vec![i.to_value(), Value::Uint(*v)]))
                    .collect(),
            ),
        ),
    ])))
}

pub struct PublicPlayer {
    header: Header,
    baseline: Vec<u8>,
    state: Value,
    next: u64,
    changed: BTreeMap<Id, u64>,
    samples: Vec<HandOff>,
    events: Vec<Value>,
    record: u64,
}
impl PublicPlayer {
    pub fn start(header: &[u8], baseline: &[u8]) -> R<Self> {
        let header = Header::read(header)?;
        let m = read_map(baseline, "public baseline")?;
        if m.len() != 4
            || uint(field(&m, 1)?)? != FORMAT
            || bytes(field(&m, 2)?)? != header.hash().to_bytes()
        {
            return bad("baseline identity");
        }
        let state = field(&m, 3)?.clone();
        validate(&header, &state)?;
        let version = uint(field(map(&state)?, 1)?)?;
        let changed = pairs(field(map(&state)?, 2)?)?
            .keys()
            .map(|i| (*i, version))
            .collect();
        Ok(Self {
            header,
            baseline: sha256(baseline).to_vec(),
            state,
            next: 0,
            changed,
            samples: Vec::new(),
            events: Vec::new(),
            record: uint(field(&m, 4)?)?,
        })
    }
    pub fn state(&self) -> &Value {
        &self.state
    }
    pub fn version(&self) -> u64 {
        uint(&map(&self.state).expect("validated state")[&1]).expect("validated version")
    }
    pub fn next(&self) -> u64 {
        self.next
    }
    pub fn record(&self) -> u64 {
        self.record
    }
    pub fn samples(&self) -> &[HandOff] {
        &self.samples
    }
    pub fn events(&self) -> &[Value] {
        &self.events
    }
    pub fn hash(&self) -> R<Vec<u8>> {
        digest(&self.state)
    }
    pub fn play(&mut self, bytes_: &[u8]) -> R<Played> {
        let sp = StreamPart::read(bytes_)?;
        if sp.number != self.next {
            return refuse("stream-gap", "public part number");
        }
        let wire = read_map(bytes_, "public part")?;
        let c = read_map(bytes(field(&wire, 10)?)?, "public context")?;
        if c.len() != 8
            || uint(field(&c, 1)?)? != FORMAT
            || bytes(field(&c, 2)?)? != self.baseline
            || bytes(field(&c, 3)?)? != digest(&self.state)?
        {
            return bad("context identity or prior digest");
        }
        let record = uint(field(&c, 6)?)?;
        if record <= self.record {
            return bad("physical cursor does not advance");
        }
        let mut next = map(&self.state)?.clone();
        for (k, v) in map(field(&c, 5)?)? {
            if [2, 3, 4, 6, 8, 9].contains(k) {
                let mut entries = pairs(field(&next, *k)?)?;
                let mut ids = BTreeSet::new();
                for row in arr(v)? {
                    let row = arr(row)?;
                    if !(1..=2).contains(&row.len()) {
                        return bad("delta row shape");
                    };
                    let id = read_id(&row[0])?;
                    if !ids.insert(id) {
                        return bad("duplicate delta id");
                    };
                    if row.len() == 1 {
                        if entries.remove(&id).is_none() {
                            return bad("delta removes absent id");
                        }
                    } else {
                        entries.insert(id, row[1].clone());
                    }
                }
                next.insert(*k, paired(entries));
            } else {
                next.insert(*k, v.clone());
            }
        }
        let next = Value::Map(next);
        validate(&self.header, &next)?;
        if bytes(field(&c, 4)?)? != digest(&next)?
            || sp.hash.as_deref() != Some(bytes(field(&c, 4)?)?)
        {
            return bad("context result digest");
        }
        let part = Part::read(&sp.part)?;
        let version = uint(field(map(&next)?, 1)?)?;
        if sp.from > sp.to
            || sp.first
                != part
                    .effects
                    .first()
                    .map_or(version, |e| e.envelope.sequence)
        {
            return bad("public part range/first");
        }
        if part.header != self.header.hash().to_bytes() || part.effects.len() as u64 != sp.entries {
            return bad("public part identity/count");
        }
        let mut cursor = self.version();
        let mut gaps = sp.gaps.iter();
        let mut gap = gaps.next();
        for e in &part.effects {
            if !public(e.envelope.audience) {
                return bad("private effect");
            };
            if e.envelope.sequence != cursor {
                let Some((first, count)) = gap else {
                    return bad("undeclared gap");
                };
                if *first != cursor || cursor.checked_add(*count) != Some(e.envelope.sequence) {
                    return bad("gap mismatch");
                };
                cursor = e.envelope.sequence;
                gap = gaps.next();
            }
            cursor = cursor.checked_add(1).ok_or_else(|| Refusal {
                name: "public-stream-record",
                detail: "sequence overflow".into(),
            })?;
        }
        if cursor != version {
            let Some((first, count)) = gap else {
                return bad("missing terminal gap");
            };
            if *first != cursor || cursor.checked_add(*count) != Some(version) {
                return bad("terminal gap mismatch");
            };
            gap = gaps.next();
        }
        if gap.is_some() || version < self.version() {
            return bad("unmet gaps");
        }
        let mut duplicates = BTreeSet::new();
        for row in arr(field(&c, 7)?)? {
            let row = arr(row)?;
            if row.len() != 2 {
                return bad("duplicate context shape");
            };
            let seq = uint(&row[0])?;
            let id = read_id(&row[1])?;
            if !duplicates.insert(seq)||!part.effects.iter().any(|e|e.envelope.sequence==seq&&matches!(&e.body,Body::Transfer(TransferRec::Arrive{transfer,..}) if *transfer==id)){return bad("duplicate context has no public arrival")}
        }
        let old_nodes = pairs(field(map(&self.state)?, 2)?)?;
        let new_nodes = pairs(field(map(&next)?, 2)?)?;
        let flying = flying_ids(&self.state)?;
        let mut changes = BTreeMap::new();
        for row in arr(field(&c, 8)?)? {
            let row = arr(row)?;
            if row.len() != 2 {
                return bad("change version shape");
            };
            let id = read_id(&row[0])?;
            let v = uint(&row[1])?;
            let reenters =
                !old_nodes.contains_key(&id) && new_nodes.contains_key(&id) && flying.contains(&id);
            // Return/Settle need not touch each carried child. A checkpoint-restored flying child has
            // canonical fallback zero; a previously observed child retains its exact known version.
            let retained = reenters && v == self.changed.get(&id).copied().unwrap_or(0);
            if (!old_nodes.contains_key(&id) && !new_nodes.contains_key(&id))
                || (v <= self.version() && !retained)
                || v > version
                || changes.insert(id, v).is_some()
            {
                return bad("unauthorized change version");
            }
        }
        for id in old_nodes.keys().chain(new_nodes.keys()) {
            if old_nodes.get(id) != new_nodes.get(id) && !changes.contains_key(id) {
                return bad("missing changed node version");
            }
        }
        self.changed.extend(changes);
        self.samples = part
            .effects
            .iter()
            .flat_map(|e| match &e.body {
                Body::Changes(cs) => cs
                    .iter()
                    .filter_map(|c| {
                        if let Change::Motion(h) = &c.change {
                            Some(*h)
                        } else {
                            None
                        }
                    })
                    .collect(),
                _ => Vec::new(),
            })
            .collect();
        self.events = part
            .effects
            .iter()
            .flat_map(|e| {
                e.events.iter().flatten().map(|ev| {
                    Value::Map(BTreeMap::from([
                        (1, Value::Text(ev.name.clone())),
                        (2, Value::Map(ev.fields.clone())),
                        (3, e.envelope.node.to_value()),
                        (4, int(e.envelope.at)),
                        (5, Value::Uint(e.envelope.sequence)),
                    ]))
                })
            })
            .collect();
        self.state = next;
        self.record = record;
        self.next += 1;
        Ok(Played {
            number: sp.number,
            from: sp.from,
            to: sp.to,
            entries: sp.entries,
            version,
            hash: Some(true),
        })
    }
    fn node_value(&self, id: Id) -> R<Value> {
        let nodes = pairs(field(map(&self.state)?, 2)?)?;
        let Some(v) = nodes.get(&id) else {
            return refuse("node-missing", "not a public live node");
        };
        let n = NodeState::read(v)?;
        let mut m = BTreeMap::from([
            (1, id.to_value()),
            (2, Value::Text(n.kind)),
            (5, crate::hash::audience(n.audience)),
            (6, Value::Map(n.fields)),
            (10, Value::Uint(self.changed.get(&id).copied().unwrap_or(0))),
        ]);
        m.extend(n.parent.map(|p| (3, p.to_value())));
        m.extend(n.slot.map(|s| (4, Value::Uint(s))));
        m.extend(n.place.map(|p| (7, p)));
        m.extend(n.motion.map(|p| (8, p)));
        let links = pairs(field(map(&self.state)?, 3)?)?;
        let rows = links
            .into_iter()
            .filter_map(|(lid, l)| {
                let l = LinkState::read(&l).ok()?;
                let other = if l.ends[0] == id {
                    l.ends[1]
                } else if l.ends[1] == id {
                    l.ends[0]
                } else {
                    return None;
                };
                Some(Value::Array(vec![
                    lid.to_value(),
                    Value::Text(l.ty),
                    other.to_value(),
                    crate::hash::audience(l.audience),
                ]))
            })
            .collect();
        m.insert(9, Value::Array(rows));
        Ok(Value::Map(m))
    }
    pub fn snapshot(&self) -> R<Vec<u8>> {
        encoded(&Value::Array(
            pairs(field(map(&self.state)?, 2)?)?
                .keys()
                .map(|i| self.node_value(*i))
                .collect::<R<Vec<_>>>()?,
        ))
    }
    pub fn query(&self, query: &[u8]) -> R<Vec<u8>> {
        let q = read_map(query, "public query")?;
        let which = uint(field(&q, 1)?)?;
        let arg = field(&q, 2)?;
        let nodes = pairs(field(map(&self.state)?, 2)?)?;
        let out = match which {
            1 => self.node_value(read_id(arg)?)?,
            2 => {
                let id = read_id(arg)?;
                if !nodes.contains_key(&id) {
                    return refuse("node-missing", "public parent absent");
                };
                let kind = match q.get(&3) {
                    Some(Value::Text(s)) => Some(s.as_str()),
                    None => None,
                    _ => return bad("query kind"),
                };
                let mut out = Vec::new();
                for (i, n) in &nodes {
                    let n = NodeState::read(n)?;
                    if n.parent == Some(id)
                        && kind.is_none_or(|k| {
                            n.kind.as_str() == k
                                || n.kind.as_str().split_once('@').is_some_and(|(p, _)| p == k)
                        })
                    {
                        out.push(i.to_value())
                    }
                }
                Value::Array(out)
            }
            3 => {
                let id = read_id(arg)?;
                let mut out = Vec::new();
                for (i, v) in pairs(field(map(&self.state)?, 3)?)? {
                    let l = LinkState::read(&v)?;
                    if l.ends.contains(&id) {
                        out.push(Value::Array(vec![
                            i.to_value(),
                            Value::Text(l.ty),
                            Value::Array(l.ends.iter().map(|i| i.to_value()).collect()),
                            Value::Uint(u64::from(l.owner == End::Second)),
                            crate::hash::audience(l.audience),
                        ]))
                    }
                }
                Value::Array(out)
            }
            4 => {
                let mut id = read_id(arg)?;
                if !nodes.contains_key(&id) {
                    return refuse("node-missing", "not a public live node");
                };
                let mut out = Vec::new();
                loop {
                    let Some(v) = nodes.get(&id) else {
                        return refuse("frame-unavailable", "public path crosses an opaque frame");
                    };
                    out.push(id.to_value());
                    let n = NodeState::read(v)?;
                    if let Some(p) = n.parent {
                        id = p
                    } else {
                        break;
                    }
                }
                Value::Array(out)
            }
            5 => {
                let since = uint(arg)?;
                let mut out = self
                    .changed
                    .iter()
                    .filter(|(_, v)| **v > since)
                    .map(|(i, v)| (*v, *i))
                    .collect::<Vec<_>>();
                out.sort();
                Value::Array(
                    out.into_iter()
                        .map(|(v, i)| Value::Array(vec![i.to_value(), Value::Uint(v)]))
                        .collect(),
                )
            }
            6 => {
                let id = read_id(arg)?;
                let Value::Map(mut n) = self.node_value(id)? else {
                    unreachable!()
                };
                n.remove(&10);
                Value::Bytes(Hash::of(Purpose::StatePublic, &encoded(&Value::Map(n))?).to_bytes())
            }
            _ => return bad("query is 1 through 6"),
        };
        encoded(&out)
    }
}
