//! Versioned observations of a canonically validated public view. This is a reader, never an engine apply path.
//! Opaque parent ids are references, not nodes. Hashes bind continuity; the canonical producer authorizes data.
use super::{Played, StreamPart, int, read_map, refuse};
use crate::effects::{
    Body, Change, Header, LinkState, NodeState, Part, Refusal, State, TransferRec, read_id,
};
use crate::encode::{Value, encode};
use crate::ids::{Hash, Id, Purpose, Sha256, sha256};
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
    context_with(
        baseline,
        &digest(before)?,
        &digest(after)?,
        Value::Map(delta),
        record,
        duplicates,
        changed,
    )
}

/// [`context`] from the digests of the states before and after and the delta between them, already worked out (#3799):
/// the same bytes.
pub fn context_with(
    baseline: &[u8],
    before: &[u8],
    after: &[u8],
    delta: Value,
    record: u64,
    duplicates: &[(u64, Id)],
    changed: &[(Id, u64)],
) -> R<Vec<u8>> {
    encoded(&Value::Map(BTreeMap::from([
        (1, Value::Uint(FORMAT)),
        (2, Value::Bytes(sha256(baseline).to_vec())),
        (3, Value::Bytes(before.to_vec())),
        (4, Value::Bytes(after.to_vec())),
        (5, delta),
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

/// The index of `id`'s row in `rows`, a projection key's `[[id, value], ...]` in id order (#3799).
fn row_index(rows: &[Value], id: Id) -> R<Option<usize>> {
    let (mut lo, mut hi) = (0, rows.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        let row = arr(&rows[mid])?;
        let Some(r) = row.first() else {
            return bad("expected an id/value pair");
        };
        match read_id(r)?.cmp(&id) {
            std::cmp::Ordering::Less => lo = mid + 1,
            std::cmp::Ordering::Greater => hi = mid,
            std::cmp::Ordering::Equal => return Ok(Some(mid)),
        }
    }
    Ok(None)
}

/// What a delta played in place swaps into the state (#3799): the version, node rows by index, and the timers whole.
/// Swapped in, it holds what it replaced, so swapping it in again puts the state back.
struct Plan {
    v1: Value,
    rows: Vec<(usize, Value)>,
    timers: Option<Value>,
}

impl Plan {
    fn swap(&mut self, state: &mut Value) {
        let Value::Map(m) = state else {
            unreachable!("validated state")
        };
        if let Some(v) = m.get_mut(&1) {
            std::mem::swap(v, &mut self.v1);
        }
        if let Some(Value::Array(nodes)) = m.get_mut(&2) {
            for (i, row) in &mut self.rows {
                std::mem::swap(&mut nodes[*i], row);
            }
        }
        if let (Some(t), Some(v)) = (self.timers.as_mut(), m.get_mut(&6)) {
            std::mem::swap(v, t);
        }
    }
}

/// Whether `delta` can be played in place on `state` (#3799): it holds the version (key 1), and at most rows of key 2,
/// each replacing a live node's row with one in the same frame (parent and slot), each node valid alone, and rows of
/// key 6, timers set, changed or cleared, each owned by a node of the state. No node comes or goes and no frame
/// changes, so the whole-state checks (frames, depth, links, flights) read nothing that changes but these rows. Its
/// plan; none when the delta is any other.
fn in_place(header: &Header, state: &Value, delta: &BTreeMap<u64, Value>) -> R<Option<Plan>> {
    if delta.keys().any(|k| ![1, 2, 6].contains(k)) {
        return Ok(None);
    }
    let Some(v1) = delta.get(&1) else {
        return Ok(None);
    };
    uint(v1)?;
    let m = map(state)?;
    let rows = arr(field(m, 2)?)?;
    let mut out = Vec::new();
    let mut ids = BTreeSet::new();
    for row in delta.get(&2).map(arr).transpose()?.unwrap_or(&[]) {
        let r = arr(row)?;
        if r.len() != 2 {
            return Ok(None);
        }
        let id = read_id(&r[0])?;
        if !ids.insert(id) {
            return Ok(None);
        }
        let Some(i) = row_index(rows, id)? else {
            return Ok(None);
        };
        let (old, new) = (
            NodeState::read(&arr(&rows[i])?[1])?,
            NodeState::read(&r[1])?,
        );
        if old.parent != new.parent || old.slot != new.slot || id == header.zone {
            return Ok(None);
        }
        validate_node(header, id, &new)?;
        out.push((i, Value::Array(vec![id.to_value(), r[1].clone()])));
    }
    let timers = match delta.get(&6) {
        None => None,
        Some(d) => {
            let mut t = pairs(field(m, 6)?)?;
            let mut ids = BTreeSet::new();
            let opaque = arr(field(m, 8)?)?;
            for row in arr(d)? {
                let r = arr(row)?;
                if !(1..=2).contains(&r.len()) {
                    return Ok(None);
                }
                let id = read_id(&r[0])?;
                if !ids.insert(id) {
                    return Ok(None);
                }
                if r.len() == 1 {
                    if t.remove(&id).is_none() {
                        return Ok(None);
                    }
                    continue;
                }
                // The timer checks of `validate`, on this row alone: its owner is a node of the state.
                let tm = map(&r[1])?;
                let owner = read_id(field(tm, 1)?)?;
                if tm.len() != 3
                    || (row_index(rows, owner)?.is_none()
                        && row_index(opaque, owner)?.is_none()
                        && !pairs(field(m, 4)?)?.values().any(|f| {
                            map(f)
                                .and_then(|f| pairs(field(f, 5)?))
                                .is_ok_and(|n| n.contains_key(&owner))
                        }))
                {
                    return bad("timer owner");
                }
                super::read_int(tm.get(&2), "timer due")?;
                if !matches!(tm.get(&3), Some(Value::Text(_))) {
                    return bad("timer name");
                }
                t.insert(id, r[1].clone());
            }
            Some(paired(t))
        }
    };
    Ok(Some(Plan {
        v1: v1.clone(),
        rows: out,
        timers,
    }))
}

/// [`digest`] of `state` with `plan` in place of what it replaces (#3799), each node row (key 2) from its encoding in
/// `enc`: the same bytes hashed in pieces, so a part that moves a few nodes encodes only their rows.
fn streamed_digest(state: &Value, enc: &[Vec<u8>], plan: Option<&Plan>) -> R<Vec<u8>> {
    use crate::encode::head;
    let m = map(state)?;
    let over: BTreeMap<usize, &Value> = plan
        .map(|p| p.rows.iter().map(|(i, v)| (*i, v)).collect())
        .unwrap_or_default();
    let mut h = Sha256::new();
    h.update(&head(5, m.len() as u64));
    for (k, v) in m {
        h.update(&head(0, *k));
        match (*k, plan) {
            (1, Some(p)) => h.update(&encoded(&p.v1)?),
            (2, _) => {
                let rows = arr(v)?;
                if rows.len() != enc.len() {
                    return bad("row encodings");
                }
                h.update(&head(4, rows.len() as u64));
                for (i, e) in enc.iter().enumerate() {
                    match over.get(&i) {
                        Some(v) => h.update(&encoded(v)?),
                        None => h.update(e),
                    }
                }
            }
            (
                6,
                Some(Plan {
                    timers: Some(t), ..
                }),
            ) => h.update(&encoded(t)?),
            _ => h.update(&encoded(v)?),
        }
    }
    Ok(h.finish().to_vec())
}

pub struct PublicPlayer {
    header: Header,
    baseline: Vec<u8>,
    state: Value,
    /// `digest(&state)`, kept with it (#3799): a part's prior digest is checked against it, not worked out again.
    digest: Vec<u8>,
    /// Each node row's encoding (key 2), once worked out, kept as rows change in place (#3799).
    enc: Option<Vec<Vec<u8>>>,
    /// Each live node's link rows as a node query lists them, by node, once worked out (#3799): links change only in
    /// a part played whole, which drops it.
    incident: std::cell::RefCell<Option<BTreeMap<Id, Vec<Value>>>>,
    next: u64,
    changed: BTreeMap<Id, u64>,
    samples: Vec<HandOff>,
    events: Vec<Value>,
    record: u64,
    /// `digest` is the newest part's claim, not yet worked out from `state` (parts played deferred, #3822).
    unverified: bool,
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
            digest: digest(&state)?,
            enc: None,
            incident: std::cell::RefCell::new(None),
            state,
            next: 0,
            changed,
            samples: Vec::new(),
            events: Vec::new(),
            record: uint(field(&m, 4)?)?,
            unverified: false,
        })
    }
    pub fn state(&self) -> &Value {
        &self.state
    }
    /// The digest of [`PublicPlayer::state`].
    pub fn digest(&self) -> &[u8] {
        &self.digest
    }
    /// The delta from the state to one at version `next` whose node rows `rows` (by id) replace the live ones, the
    /// rows equal to the live ones left out (#3799): as [`context`] works it out from the two whole states. None when it
    /// cannot be played in place (a new or gone node, a new frame, no new version); the caller then works it out whole.
    pub fn row_delta(
        &self,
        next: u64,
        mut rows: Vec<(Id, Value)>,
        timers: Vec<(Id, Option<Value>)>,
    ) -> R<Option<Value>> {
        if next == self.version() {
            return Ok(None);
        }
        rows.sort_by_key(|(id, _)| *id);
        let live = arr(field(map(&self.state)?, 2)?)?;
        let mut changed = Vec::new();
        for (id, v) in rows {
            let Some(i) = row_index(live, id)? else {
                return Ok(None);
            };
            if arr(&live[i])?[1] != v {
                changed.push(Value::Array(vec![id.to_value(), v]));
            }
        }
        let mut delta = BTreeMap::from([(1, Value::Uint(next))]);
        if !changed.is_empty() {
            delta.insert(2, Value::Array(changed));
        }
        // Timers set, changed or cleared: a row each that differs, in id order, as `context` finds them.
        let live = pairs(field(map(&self.state)?, 6)?)?;
        let mut t: Vec<Value> = timers
            .into_iter()
            .filter(|(id, v)| live.get(id) != v.as_ref())
            .map(|(id, v)| {
                let mut row = vec![id.to_value()];
                row.extend(v);
                (id, Value::Array(row))
            })
            .collect::<BTreeMap<Id, Value>>()
            .into_values()
            .collect();
        if !t.is_empty() {
            delta.insert(6, Value::Array(std::mem::take(&mut t)));
        }
        if in_place(&self.header, &self.state, &delta)?.is_none() {
            return Ok(None);
        }
        Ok(Some(Value::Map(delta)))
    }
    /// The digest of the state `delta` (from [`PublicPlayer::row_delta`]) would make, the state left as it is.
    pub fn digest_with(&mut self, delta: &Value) -> R<Vec<u8>> {
        let Some(plan) = in_place(&self.header, &self.state, map(delta)?)? else {
            return bad("not an in-place delta");
        };
        self.encodings()?;
        streamed_digest(
            &self.state,
            self.enc.as_deref().unwrap_or_default(),
            Some(&plan),
        )
    }
    /// The node rows' encodings, worked out once for a state played whole.
    fn encodings(&mut self) -> R<&[Vec<u8>]> {
        if self.enc.is_none() {
            let rows = arr(field(map(&self.state)?, 2)?)?;
            self.enc = Some(rows.iter().map(encoded).collect::<R<_>>()?);
        }
        Ok(self.enc.as_deref().unwrap_or_default())
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
        self.play_digest(bytes_, true)
    }
    /// [`PublicPlayer::play`] without working out the next state's digest (#3822): every check but that one, the
    /// part's claimed result digest kept as the state's, so the next part's prior digest still has to match it. A
    /// joiner far behind plays the parts it will not show this way, then [`PublicPlayer::verify`] (or the next part
    /// played checked) works out the digest of the state they made and refuses it unless it is the newest claimed one.
    pub fn play_deferred(&mut self, bytes_: &[u8]) -> R<Played> {
        self.play_digest(bytes_, false)
    }
    /// Works out the state's digest when parts were played deferred since it was last worked out, and refuses the
    /// state (`stream-digest`) unless it is the digest the newest part claimed.
    pub fn verify(&mut self) -> R<()> {
        if !self.unverified {
            return Ok(());
        }
        let actual = match self.enc.as_deref() {
            Some(enc) => streamed_digest(&self.state, enc, None)?,
            None => digest(&self.state)?,
        };
        if actual != self.digest {
            return refuse(
                "stream-digest",
                "the parts played deferred do not make the claimed state",
            );
        }
        self.unverified = false;
        Ok(())
    }
    fn play_digest(&mut self, bytes_: &[u8], check: bool) -> R<Played> {
        let sp = StreamPart::read(bytes_)?;
        if sp.number != self.next {
            return refuse("stream-gap", "public part number");
        }
        let wire = read_map(bytes_, "public part")?;
        let c = read_map(bytes(field(&wire, 10)?)?, "public context")?;
        if c.len() != 8
            || uint(field(&c, 1)?)? != FORMAT
            || bytes(field(&c, 2)?)? != self.baseline
            || bytes(field(&c, 3)?)? != self.digest
        {
            return bad("context identity or prior digest");
        }
        let record = uint(field(&c, 6)?)?;
        if record <= self.record {
            return bad("physical cursor does not advance");
        }
        let old_version = self.version();
        let flying = flying_ids(&self.state)?;
        // In place (#3799): a delta that only moves existing nodes in their own frames (the version, and rows of
        // key 2 replacing live nodes with the same parent and slot) changes nothing the whole-state checks read but
        // those rows, so only they are checked, and they are swapped into the state, swapped back on any refusal.
        let plan = in_place(&self.header, &self.state, map(field(&c, 5)?)?)?;
        let whole = match &plan {
            Some(_) => None,
            None => Some(self.whole_next(&c)?),
        };
        let mut plan = plan;
        let in_place_digest = match &plan {
            _ if !check => Some(bytes(field(&c, 4)?)?.to_vec()),
            Some(p) => {
                self.encodings()?;
                let enc = self.enc.as_deref().unwrap_or_default();
                Some(streamed_digest(&self.state, enc, Some(p))?)
            }
            None => None,
        };
        if let Some(p) = plan.as_mut() {
            p.swap(&mut self.state);
        }
        let r = self.check_next(
            &sp,
            &c,
            whole.as_ref(),
            plan.as_ref(),
            in_place_digest,
            old_version,
            &flying,
            check,
        );
        match (r, whole) {
            (Ok((digest, changes, part, version)), whole) => {
                match (whole, &plan) {
                    (Some(w), _) => {
                        self.state = w;
                        self.enc = None;
                        self.incident.replace(None);
                    }
                    (None, Some(p)) => {
                        // The swapped rows' new encodings.
                        let rows = arr(field(map(&self.state)?, 2)?)?;
                        let new: Vec<(usize, Vec<u8>)> = p
                            .rows
                            .iter()
                            .map(|(i, _)| Ok((*i, encoded(&rows[*i])?)))
                            .collect::<R<_>>()?;
                        if let Some(enc) = self.enc.as_mut() {
                            for (i, e) in new {
                                enc[i] = e;
                            }
                        }
                    }
                    (None, None) => {}
                }
                self.digest = digest;
                self.unverified = !check;
                self.finish(sp, part, changes, record, version)
            }
            (Err(e), _) => {
                if let Some(p) = plan.as_mut() {
                    p.swap(&mut self.state);
                }
                Err(e)
            }
        }
    }

    /// The next state as a whole: the delta applied to a copy, checked whole.
    fn whole_next(&self, c: &BTreeMap<u64, Value>) -> R<Value> {
        let mut next = map(&self.state)?.clone();
        for (k, v) in map(field(c, 5)?)? {
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
        Ok(next)
    }

    /// The checks of a part against its next state (`whole`, or the state with `undo`'s rows swapped in): its digest,
    /// its entries and gaps, its duplicates and its change versions. Its digest, versions, part and version.
    #[allow(clippy::type_complexity, clippy::too_many_arguments)]
    fn check_next(
        &self,
        sp: &StreamPart,
        c: &BTreeMap<u64, Value>,
        whole: Option<&Value>,
        old: Option<&Plan>,
        in_place_digest: Option<Vec<u8>>,
        old_version: u64,
        flying: &BTreeSet<Id>,
        effects: bool,
    ) -> R<(Vec<u8>, BTreeMap<Id, u64>, Option<Part>, u64)> {
        let next = whole.unwrap_or(&self.state);
        let next_digest = match in_place_digest {
            Some(d) => d,
            None => digest(next)?,
        };
        if bytes(field(c, 4)?)? != next_digest || sp.hash.as_deref() != Some(bytes(field(c, 4)?)?) {
            return bad("context result digest");
        }
        let version = uint(field(map(next)?, 1)?)?;
        // #3822: a part played deferred is not shown, so its entries are not read: the checks on them are skipped.
        let part = match effects {
            true => Some(self.check_effects(sp, c, old_version, version)?),
            false if sp.from > sp.to || version < old_version => return bad("public part range"),
            false => None,
        };
        // Whole: the old state and the next, by id. In place: the same ids before and after, and the swapped rows.
        let (old_nodes, new_nodes) = match whole {
            Some(next) => (
                pairs(field(map(&self.state)?, 2)?)?,
                pairs(field(map(next)?, 2)?)?,
            ),
            None => (BTreeMap::new(), BTreeMap::new()),
        };
        let rows = arr(field(map(next)?, 2)?)?;
        let has = |id: &Id, nodes: &BTreeMap<Id, Value>| match whole {
            Some(_) => Ok(nodes.contains_key(id)),
            None => row_index(rows, *id).map(|i| i.is_some()),
        };
        let mut changes = BTreeMap::new();
        for row in arr(field(c, 8)?)? {
            let row = arr(row)?;
            if row.len() != 2 {
                return bad("change version shape");
            };
            let id = read_id(&row[0])?;
            let v = uint(&row[1])?;
            let (was, is) = (has(&id, &old_nodes)?, has(&id, &new_nodes)?);
            let reenters = !was && is && flying.contains(&id);
            // Return/Settle need not touch each carried child. A checkpoint-restored flying child has
            // canonical fallback zero; a previously observed child retains its exact known version.
            let retained = reenters && v == self.changed.get(&id).copied().unwrap_or(0);
            if (!was && !is)
                || (v <= old_version && !retained)
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
        for (i, old) in old.iter().flat_map(|p| &p.rows) {
            let Value::Array(row) = &rows[*i] else {
                return bad("expected an id/value pair");
            };
            if &rows[*i] != old && !changes.contains_key(&read_id(&row[0])?) {
                return bad("missing changed node version");
            }
        }
        Ok((next_digest, changes, part, version))
    }

    /// The checks of a part's entries against the versions it moves between: its range, identity, entries and gaps,
    /// and its duplicates. The part.
    fn check_effects(
        &self,
        sp: &StreamPart,
        c: &BTreeMap<u64, Value>,
        old_version: u64,
        version: u64,
    ) -> R<Part> {
        let part = Part::read(&sp.part)?;
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
        let mut cursor = old_version;
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
        if gap.is_some() || version < old_version {
            return bad("unmet gaps");
        }
        let mut duplicates = BTreeSet::new();
        for row in arr(field(c, 7)?)? {
            let row = arr(row)?;
            if row.len() != 2 {
                return bad("duplicate context shape");
            };
            let seq = uint(&row[0])?;
            let id = read_id(&row[1])?;
            if !duplicates.insert(seq)||!part.effects.iter().any(|e|e.envelope.sequence==seq&&matches!(&e.body,Body::Transfer(TransferRec::Arrive{transfer,..}) if *transfer==id)){return bad("duplicate context has no public arrival")}
        }
        Ok(part)
    }

    /// A checked part played: its versions, samples and events kept, the cursor moved on.
    fn finish(
        &mut self,
        sp: StreamPart,
        part: Option<Part>,
        changes: BTreeMap<Id, u64>,
        record: u64,
        version: u64,
    ) -> R<Played> {
        self.changed.extend(changes);
        let effects = part.map(|p| p.effects).unwrap_or_default();
        self.samples = effects
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
        self.events = effects
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
    /// A live node's row value, found by its id in the state's node rows (#3799): no copy of the others.
    fn node_row(&self, id: Id) -> R<Option<&Value>> {
        let rows = arr(field(map(&self.state)?, 2)?)?;
        match row_index(rows, id)? {
            Some(i) => {
                let row = arr(&rows[i])?;
                if row.len() != 2 {
                    return bad("expected an id/value pair");
                }
                Ok(Some(&row[1]))
            }
            None => Ok(None),
        }
    }
    fn node_value(&self, id: Id) -> R<Value> {
        let Some(v) = self.node_row(id)? else {
            return refuse("node-missing", "not a public live node");
        };
        let n = NodeState::read(v)?;
        if self.incident.borrow().is_none() {
            let mut by: BTreeMap<Id, Vec<Value>> = BTreeMap::new();
            for row in arr(field(map(&self.state)?, 3)?)? {
                let row = arr(row)?;
                if row.len() != 2 {
                    return bad("expected an id/value pair");
                }
                let Ok(l) = LinkState::read(&row[1]) else {
                    continue;
                };
                let lid = read_id(&row[0])?;
                // As a node's query lists them: once for each end it is, its other end beside it (a link to
                // itself once).
                for (end, other) in [(l.ends[0], l.ends[1]), (l.ends[1], l.ends[0])] {
                    if end == other
                        && end == l.ends[1]
                        && by.get(&end).is_some_and(|r| {
                            r.last().is_some_and(
                                |x| matches!(x, Value::Array(a) if a[0] == lid.to_value()),
                            )
                        })
                    {
                        continue;
                    }
                    by.entry(end).or_default().push(Value::Array(vec![
                        lid.to_value(),
                        Value::Text(l.ty.clone()),
                        other.to_value(),
                        crate::hash::audience(l.audience),
                    ]));
                }
            }
            self.incident.replace(Some(by));
        }
        let rows = self
            .incident
            .borrow()
            .as_ref()
            .and_then(|by| by.get(&id).cloned())
            .unwrap_or_default();
        self.node_value_with_rows(id, n, rows)
    }
    fn node_value_with_rows(&self, id: Id, n: NodeState, rows: Vec<Value>) -> R<Value> {
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
        m.insert(9, Value::Array(rows));
        Ok(Value::Map(m))
    }
    pub fn snapshot(&self) -> R<Vec<u8>> {
        let nodes = pairs(field(map(&self.state)?, 2)?)?;
        let links = pairs(field(map(&self.state)?, 3)?)?;
        let mut incident: BTreeMap<Id, Vec<Value>> = BTreeMap::new();
        for (lid, value) in links {
            let Ok(link) = LinkState::read(&value) else {
                continue;
            };
            for (index, id) in link.ends.iter().enumerate() {
                if index == 1 && link.ends[0] == link.ends[1] {
                    continue;
                }
                incident.entry(*id).or_default().push(Value::Array(vec![
                    lid.to_value(),
                    Value::Text(link.ty.clone()),
                    link.ends[1 - index].to_value(),
                    crate::hash::audience(link.audience),
                ]));
            }
        }
        encoded(&Value::Array(
            nodes
                .iter()
                .map(|(id, value)| {
                    self.node_value_with_rows(
                        *id,
                        NodeState::read(value)?,
                        incident.remove(id).unwrap_or_default(),
                    )
                })
                .collect::<R<Vec<_>>>()?,
        ))
    }
    pub fn query(&self, query: &[u8]) -> R<Vec<u8>> {
        let q = read_map(query, "public query")?;
        let which = uint(field(&q, 1)?)?;
        let arg = field(&q, 2)?;
        let out = match which {
            1 => self.node_value(read_id(arg)?)?,
            2 => {
                let id = read_id(arg)?;
                if self.node_row(id)?.is_none() {
                    return refuse("node-missing", "public parent absent");
                };
                let kind = match q.get(&3) {
                    Some(Value::Text(s)) => Some(s.as_str()),
                    None => None,
                    _ => return bad("query kind"),
                };
                let mut out = Vec::new();
                for row in arr(field(map(&self.state)?, 2)?)? {
                    let row = arr(row)?;
                    if row.len() != 2 {
                        return bad("expected an id/value pair");
                    }
                    let (i, n) = (read_id(&row[0])?, NodeState::read(&row[1])?);
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
                for row in arr(field(map(&self.state)?, 3)?)? {
                    let row = arr(row)?;
                    if row.len() != 2 {
                        return bad("expected an id/value pair");
                    }
                    let (i, l) = (read_id(&row[0])?, LinkState::read(&row[1])?);
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
                if self.node_row(id)?.is_none() {
                    return refuse("node-missing", "not a public live node");
                };
                let mut out = Vec::new();
                loop {
                    let Some(v) = self.node_row(id)? else {
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

#[cfg(test)]
mod w16_snapshot_tests {
    use super::*;
    use crate::effects::{FIXTURE_HEADER, fixture_bytes};
    use crate::ids::Scope;
    use crate::pose::{Frame, Quat, Support, Vec3};

    #[test]
    fn w16_snapshot_matches_exact_node_queries_with_opaque_frames_and_ordered_self_links() {
        let header = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
        let mut state = State::start(header.zone, header.kinds[0].clone());
        state.next = 17;
        let id = |n| Id::new(Scope([94; 16]), n).unwrap();
        for (n, parent, audience) in [
            (0, header.zone, Audience::Of(id(0))),
            (1, id(0), Audience::Everyone),
            (2, header.zone, Audience::Everyone),
        ] {
            state.nodes.insert(
                id(n),
                NodeState {
                    kind: header.kinds[0].clone(),
                    parent: Some(parent),
                    slot: None,
                    audience,
                    fields: BTreeMap::from([(30, Value::Uint(n))]),
                    place: Some({
                        let Value::Map(mut local) = (Pose {
                            frame: Frame {
                                node: parent,
                                slot: None,
                            },
                            position: Vec3::new(0, 0, 0),
                            orientation: Quat::IDENTITY,
                            support: Support::Surface {
                                surface: parent,
                                height: 0,
                            },
                        })
                        .to_value() else {
                            unreachable!()
                        };
                        local.remove(&1);
                        Value::Map(local)
                    }),
                    motion: None,
                },
            );
        }
        for (n, ends, audience) in [
            (6, [id(1), id(2)], Audience::Everyone),
            (4, [id(1), id(1)], Audience::Everyone),
            (5, [id(0), id(0)], Audience::Of(id(0))),
        ] {
            state.links.insert(
                id(n),
                LinkState {
                    ty: header.kinds[0].clone(),
                    ends,
                    owner: End::First,
                    audience,
                },
            );
        }
        let player =
            PublicPlayer::start(header.stored(), &baseline(&header, &state, 0).unwrap()).unwrap();
        let values = pairs(field(map(player.state()).unwrap(), 2).unwrap()).unwrap();
        assert!(!values.contains_key(&id(0)), "private node stays excluded");
        let expected = Value::Array(
            values
                .keys()
                .map(|node| {
                    let query = encoded(&Value::Map(BTreeMap::from([
                        (1, Value::Uint(1)),
                        (2, node.to_value()),
                    ])))
                    .unwrap();
                    crate::encode::decode(&player.query(&query).unwrap())
                        .unwrap()
                        .value
                })
                .collect(),
        );
        assert_eq!(player.snapshot().unwrap(), encoded(&expected).unwrap());
        let Value::Array(rows) = expected else {
            panic!("snapshot")
        };
        let child = rows
            .iter()
            .find(|row| map(row).unwrap()[&1] == id(1).to_value())
            .unwrap();
        assert_eq!(
            map(child).unwrap()[&3],
            id(0).to_value(),
            "opaque parent remains exact"
        );
        let Value::Array(links) = &map(child).unwrap()[&9] else {
            panic!("links")
        };
        assert_eq!(links.len(), 2, "self link appears once");
        assert_eq!(arr(&links[0]).unwrap()[0], id(4).to_value());
        assert_eq!(arr(&links[1]).unwrap()[0], id(6).to_value());
        assert_eq!(
            player
                .query(
                    &encoded(&Value::Map(BTreeMap::from([
                        (1, Value::Uint(1)),
                        (2, id(0).to_value())
                    ])))
                    .unwrap()
                )
                .unwrap_err()
                .name,
            "node-missing"
        );
        let mut corrupt = player;
        let Value::Map(raw) = &mut corrupt.state else {
            unreachable!()
        };
        let Value::Array(nodes) = raw.get_mut(&2).unwrap() else {
            unreachable!()
        };
        nodes.push(nodes[0].clone());
        assert!(
            corrupt.snapshot().is_err(),
            "duplicate source nodes stay refused"
        );
    }
}
