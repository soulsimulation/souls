//! Versioned observations of a canonically validated public view. This is a reader, never an engine apply path.
//! Opaque parent ids are references, not nodes. Hashes bind continuity; the canonical producer authorizes data.
use super::{Played, StreamPart, int, read_map, refuse};
use crate::effects::{
    Body, Change, Header, LinkState, NodeState, Part, Refusal, State, TransferRec, read_id,
};
use crate::encode::{Name, Value, encode};
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

/// The kinds a world's creator defined that a public observation can check (#3697): each named by a public
/// `souls:kind` node at the zone's root among `nodes`.
fn defined_kinds<'a>(zone: Id, nodes: impl Iterator<Item = &'a NodeState>) -> BTreeSet<String> {
    use crate::kinds::defined::{is_definition, named};
    nodes
        .filter(|n| n.parent == Some(zone) && public(n.audience) && is_definition(n.kind.as_str()))
        .filter_map(|n| named(&n.fields).map(str::to_owned))
        .collect()
}

/// Whether a node's kind is pinned: by the header, as `souls:kind` itself, or by a `souls:kind` node in `defined`.
fn pinned(header: &Header, defined: &BTreeSet<String>, kind: &Name) -> bool {
    header.kinds.contains(kind)
        || crate::kinds::defined::is_definition(kind.as_str())
        || defined.contains(kind.as_str())
}

/// Each public live node of `state` a public observation cannot hold (#3697's defined kinds aside, a kind it cannot
/// check, a frame or pose it cannot read), with the refusal: what a producer leaves out rather than stop.
pub fn unplaceable(header: &Header, state: &State) -> Vec<(Id, Refusal)> {
    let live = || state.nodes.values().filter(|n| public(n.audience));
    let defined = defined_kinds(header.zone, live());
    state
        .nodes
        .iter()
        .filter(|(_, n)| public(n.audience))
        .filter_map(|(id, n)| {
            validate_node(header, &defined, *id, n)
                .err()
                .map(|e| (*id, e))
        })
        .collect()
}

fn validate_node(header: &Header, defined: &BTreeSet<String>, id: Id, n: &NodeState) -> R<()> {
    if !public(n.audience) || !pinned(header, defined, &n.kind) {
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
        all.insert(*id, NodeState::read(v)?);
    }
    let defined = defined_kinds(header.zone, all.values());
    for (id, n) in &all {
        validate_node(header, &defined, *id, n)?;
    }
    let opaque = pairs(field(m, 8)?)?;
    for (id, v) in &opaque {
        let n = NodeState::read(v)?;
        validate_node(header, &defined, *id, &n)?;
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
            validate_node(header, &defined, *id, &n)?;
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
    context_with(
        baseline,
        &digest(before)?,
        &digest(after)?,
        context_delta(before, after)?,
        record,
        duplicates,
        changed,
    )
}

/// The delta [`context`] carries from `before` to `after`: per-id rows for the keyed fields, whole values for the
/// rest. A writer that already holds both digests passes it to [`context_with`] and gets [`context`]'s bytes without
/// hashing either state again (#4192).
pub fn context_delta(before: &Value, after: &Value) -> R<Value> {
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
    Ok(row_position(rows, id)?.ok())
}

/// `Ok(index)` of `id`'s row in `rows`, or `Err(index)`: where a row for it would go (a node a cut makes).
fn row_position(rows: &[Value], id: Id) -> R<Result<usize, usize>> {
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
            std::cmp::Ordering::Equal => return Ok(Ok(mid)),
        }
    }
    Ok(Err(lo))
}

/// What a delta played in place swaps into the state (#3799): the version, node rows by index, the rows of the nodes
/// it makes, and the timers and links whole. Swapped in, it holds what it replaced, so swapping it in again puts the
/// state back.
struct Plan {
    v1: Value,
    rows: Vec<(usize, Value)>,
    /// The rows of the nodes the delta makes, each with the index of the old row it goes before, in id order.
    added: Vec<(usize, Value)>,
    /// Whether the rows made are in the state now (and the rows of the nodes gone out of it).
    added_in: bool,
    /// The nodes the delta takes out (a Soul's body retired, a thing removed), each with its old row's index and,
    /// while the plan is in the state, that row; in index order. Never with rows made.
    removed: Vec<(usize, Id, Value)>,
    timers: Option<Value>,
    links: Option<Value>,
    /// The nodes whose frame the delta changes or makes, each with its new parent (#4192).
    moved: Vec<(Id, Option<Id>)>,
}

impl Plan {
    /// Where old row `i` is once the rows made are in the state and the rows gone are out of it.
    fn index_after(&self, i: usize) -> usize {
        i + self.added.iter().filter(|(at, _)| *at <= i).count()
            - self.removed.iter().filter(|(at, ..)| *at < i).count()
    }
    /// Where the `k`th row made is once the rows made are in the state and the rows gone are out of it: before old
    /// row `at`, after the rows made before it, less the rows gone before `at`.
    fn made_at(&self, k: usize) -> usize {
        let at = self.added[k].0;
        at + k - self.removed.iter().filter(|(r, ..)| *r < at).count()
    }
    /// `enc`, the encodings of the node rows before the plan, made those of `state`, which holds the plan: the swapped
    /// rows' new encodings, the rows gone taken out, then the rows made (T-late) put in where they are, the first
    /// first. Each encoding is worked out before `enc` changes.
    fn encodings_after(&self, enc: &mut Vec<Vec<u8>>, state: &Value) -> R<()> {
        let rows = arr(field(map(state)?, 2)?)?;
        let new: Vec<(usize, Vec<u8>)> = self
            .rows
            .iter()
            .map(|(i, _)| Ok((*i, encoded(&rows[self.index_after(*i)])?)))
            .collect::<R<_>>()?;
        let made: Vec<(usize, Vec<u8>)> = (0..self.added.len())
            .map(|k| Ok((self.made_at(k), encoded(&self.added[k].1)?)))
            .collect::<R<_>>()?;
        for (i, e) in new {
            enc[i] = e;
        }
        for (at, ..) in self.removed.iter().rev() {
            enc.remove(*at);
        }
        for (at, e) in made {
            enc.insert(at, e);
        }
        Ok(())
    }
    fn swap(&mut self, state: &mut Value) {
        let Value::Map(m) = state else {
            unreachable!("validated state")
        };
        if let Some(v) = m.get_mut(&1) {
            std::mem::swap(v, &mut self.v1);
        }
        if let Some(Value::Array(nodes)) = m.get_mut(&2) {
            // The rows replaced at their old indices: the rows made are taken out first, and put in after, so that
            // each old index holds. Put in, the rows gone go first, the last first, then the rows made, the first
            // first, each where it ends ([`Plan::made_at`]); taken out, the other way round.
            if self.added_in {
                for k in (0..self.added.len()).rev() {
                    nodes.remove(self.made_at(k));
                }
                // The rows gone back at their old indices, the first first, so that each old index holds.
                for (at, _, row) in &mut self.removed {
                    nodes.insert(*at, std::mem::replace(row, Value::Array(Vec::new())));
                }
            }
            for (i, row) in &mut self.rows {
                std::mem::swap(&mut nodes[*i], row);
            }
            if !self.added_in {
                for (at, _, row) in self.removed.iter_mut().rev() {
                    *row = nodes.remove(*at);
                }
                for k in 0..self.added.len() {
                    nodes.insert(self.made_at(k), self.added[k].1.clone());
                }
            }
            self.added_in = !self.added_in;
        }
        if let (Some(t), Some(v)) = (self.timers.as_mut(), m.get_mut(&6)) {
            std::mem::swap(v, t);
        }
        if let (Some(l), Some(v)) = (self.links.as_mut(), m.get_mut(&3)) {
            std::mem::swap(v, l);
        }
    }
}

/// Every node `validate` walks the frames of (live, opaque and in public flights), each with its parent, and the
/// children of each (#4192): what a delta that moves nodes to new frames is checked against without the whole state.
/// With them, the kinds the state's definitions name ([`defined_kinds`], #4954): a delta played in place never makes,
/// changes or takes out a definition, so they hold while the frames are kept.
#[derive(Default)]
struct Frames {
    parent: BTreeMap<Id, Option<Id>>,
    children: BTreeMap<Id, BTreeSet<Id>>,
    defined: BTreeSet<String>,
}

impl Frames {
    fn of(state: &Value, zone: Id) -> R<Frames> {
        let m = map(state)?;
        let mut f = Frames::default();
        // The root's live children that are definitions, read whole: few, as `validate` reads them.
        let mut live = Vec::new();
        for row in arr(field(m, 2)?)? {
            let r = arr(row)?;
            if r.len() == 2 && map(&r[1])?.get(&2).map(read_id).transpose()? == Some(zone) {
                let n = NodeState::read(&r[1])?;
                if crate::kinds::defined::is_definition(n.kind.as_str()) {
                    live.push(n);
                }
            }
        }
        f.defined = defined_kinds(zone, live.iter());
        let mut add = |rows: &Value| -> R<()> {
            for row in arr(rows)? {
                let r = arr(row)?;
                if r.len() != 2 {
                    return bad("expected an id/value pair");
                }
                let parent = match map(&r[1])?.get(&2) {
                    Some(p) => Some(read_id(p)?),
                    None => None,
                };
                let id = read_id(&r[0])?;
                f.parent.insert(id, parent);
                if let Some(p) = parent {
                    f.children.entry(p).or_default().insert(id);
                }
            }
            Ok(())
        };
        add(field(m, 2)?)?;
        add(field(m, 8)?)?;
        for row in arr(field(m, 4)?)? {
            add(field(map(&arr(row)?[1])?, 5)?)?;
        }
        Ok(f)
    }
    fn reparent(&mut self, id: Id, to: Option<Id>) {
        if let Some(Some(old)) = self.parent.insert(id, to)
            && let Some(c) = self.children.get_mut(&old)
        {
            c.remove(&id);
        }
        if let Some(p) = to {
            self.children.entry(p).or_default().insert(id);
        }
    }
    /// A node gone out of the state (`in_place` takes one out only with every node under it).
    fn remove(&mut self, id: Id) {
        if let Some(Some(old)) = self.parent.remove(&id)
            && let Some(c) = self.children.get_mut(&old)
        {
            c.remove(&id);
        }
        self.children.remove(&id);
    }
    /// Whether `validate`'s frame walk passes for every node whose frame chain the moves change: the moved nodes and
    /// everything under them. Any other node's chain is as it was, already valid.
    fn allow(&self, moved: &BTreeMap<Id, Option<Id>>) -> bool {
        let up = |id: &Id| -> Option<Id> {
            match moved.get(id) {
                Some(p) => *p,
                None => self.parent.get(id).copied().flatten(),
            }
        };
        let mut todo: Vec<Id> = moved.keys().copied().collect();
        let mut seen = BTreeSet::new();
        while let Some(n) = todo.pop() {
            if !seen.insert(n) {
                continue;
            }
            // `validate`'s walk, on the moved frames.
            let mut parent = up(&n);
            let mut visited = BTreeSet::new();
            for _ in 0..=DEPTH_LIMIT {
                let Some(id) = parent else { break };
                if !visited.insert(id) {
                    return false;
                }
                // A node the delta makes is walked on too: it is in `moved`, not yet in `parent`.
                parent = if self.parent.contains_key(&id) || moved.contains_key(&id) {
                    up(&id)
                } else {
                    None
                };
                if parent.is_none() {
                    break;
                }
            }
            if parent.is_some() {
                return false;
            }
            todo.extend(
                self.children
                    .get(&n)
                    .into_iter()
                    .flatten()
                    .filter(|c| !moved.contains_key(c)),
            );
        }
        true
    }
}

/// Whether `delta` can be played in place on `state` (#3799, #4192): it holds the version (key 1), rows of key 2, each
/// replacing a live node's row, each node valid alone, and a frame changed only where the frame walk of `validate`
/// still passes for the node and everything under it; rows of key 3, links added, changed or removed, each added one
/// public and owned by a live node; and rows of key 6, timers set, changed or cleared, each owned by a node of the
/// state. A row of a node not in the state is a node made (T-late): checked as `validate` checks a node, its id in no
/// other row, its frame walked as a moved node's. A row of key 2 with no value is a live node gone (a Soul's body
/// retired, a thing removed, an activity ended): one that is not a definition or the root, that owns no link and no
/// timer left, and that no node but one gone with it, opaque or flying, has as its frame (a node taken out with what
/// is under it, the stream producer's cut of a remove). Nodes gone and nodes made can be in one delta (a crowd's
/// activities ending and starting in one cut). Every node row's kind is pinned by
/// the header or by a definition in the state (#4954: the group gestures a release adds are pinned so).
/// No flight changes, so the whole-state checks read nothing that changes but these rows. Its plan; none when the delta
/// is any other, or when it is unsure: the whole path then decides. (Before a node gone was played in place, every part
/// that took one out cloned and checked the whole state: about 100 ms a part on Eden's 10,000 nodes, so a viewer
/// joining late in a generation of such parts waited seconds for its first frame.)
fn in_place(
    header: &Header,
    state: &Value,
    delta: &BTreeMap<u64, Value>,
    frames: &std::cell::RefCell<Option<Frames>>,
) -> R<Option<Plan>> {
    if delta.keys().any(|k| ![1, 2, 3, 6].contains(k)) {
        return Ok(None);
    }
    let Some(v1) = delta.get(&1) else {
        return Ok(None);
    };
    uint(v1)?;
    let m = map(state)?;
    let rows = arr(field(m, 2)?)?;
    let mut out = Vec::new();
    let mut added: Vec<(usize, Id, Value)> = Vec::new();
    let mut ids = BTreeSet::new();
    let mut moved = BTreeMap::new();
    let mut removed: Vec<(usize, Id, Value)> = Vec::new();
    // The kinds the state's definitions name (#4954: a Soul Action the release added is one), from the frames' cache,
    // read only when a row's kind is one the header does not pin: a row of such a kind plays in place as any other.
    let mut defined: Option<BTreeSet<String>> = None;
    let mut kinds = |kind: &Name| -> R<BTreeSet<String>> {
        if pinned(header, &BTreeSet::new(), kind) {
            return Ok(BTreeSet::new());
        }
        if defined.is_none() {
            let mut f = frames.borrow_mut();
            if f.is_none() {
                *f = Some(Frames::of(state, header.zone)?);
            }
            defined = f.as_ref().map(|f| f.defined.clone());
        }
        Ok(defined.clone().unwrap_or_default())
    };
    for row in delta.get(&2).map(arr).transpose()?.unwrap_or(&[]) {
        let r = arr(row)?;
        if !(1..=2).contains(&r.len()) {
            return Ok(None);
        }
        let id = read_id(&r[0])?;
        if !ids.insert(id) {
            return Ok(None);
        }
        if r.len() == 1 {
            // A node gone: a live one, not the root, a definition or of a kind the header does not pin.
            let Ok(i) = row_position(rows, id)? else {
                return Ok(None);
            };
            let old = NodeState::read(&arr(&rows[i])?[1])?;
            if id == header.zone
                || !pinned(header, &kinds(&old.kind)?, &old.kind)
                || crate::kinds::defined::is_definition(old.kind.as_str())
            {
                return Ok(None);
            }
            // The swap and the encodings' update take the rows gone in index order: any other is left to the whole path.
            if removed.last().is_some_and(|(last, ..)| *last >= i) {
                return Ok(None);
            }
            removed.push((i, id, Value::Array(Vec::new())));
            continue;
        }
        let i = match row_position(rows, id)? {
            Ok(i) => i,
            // A node the cut makes (T-late): a live row of its own, its id in no other row of the state (opaque or in
            // a public flight), valid alone and pinned, and its frame walked like a moved node's. In id order, after
            // any made before it.
            Err(at) => {
                let new = NodeState::read(&r[1])?;
                let defined = kinds(&new.kind)?;
                if id == header.zone
                    || !pinned(header, &defined, &new.kind)
                    || crate::kinds::defined::is_definition(new.kind.as_str())
                    || added.last().is_some_and(|(_, last, _)| *last >= id)
                    || row_index(arr(field(m, 8)?)?, id)?.is_some()
                    || pairs(field(m, 4)?)?.values().any(|f| {
                        map(f)
                            .and_then(|f| pairs(field(f, 5)?))
                            .map_or(true, |n| n.contains_key(&id))
                    })
                {
                    return Ok(None);
                }
                validate_node(header, &defined, id, &new)?;
                moved.insert(id, new.parent);
                added.push((at, id, Value::Array(vec![id.to_value(), r[1].clone()])));
                continue;
            }
        };
        let (old, new) = (
            NodeState::read(&arr(&rows[i])?[1])?,
            NodeState::read(&r[1])?,
        );
        // A kind neither the header nor a definition in the state pins, or a definition, is checked against the whole
        // state (#3697).
        let defined = kinds(&new.kind)?;
        if id == header.zone
            || !pinned(header, &defined, &new.kind)
            || crate::kinds::defined::is_definition(old.kind.as_str())
            || crate::kinds::defined::is_definition(new.kind.as_str())
        {
            return Ok(None);
        }
        if old.parent != new.parent || old.slot != new.slot {
            moved.insert(id, new.parent);
        }
        validate_node(header, &defined, id, &new)?;
        out.push((i, Value::Array(vec![id.to_value(), r[1].clone()])));
    }
    let made: BTreeSet<Id> = added.iter().map(|(_, id, _)| *id).collect();
    let gone: BTreeSet<Id> = removed.iter().map(|(_, id, _)| *id).collect();
    let live = |id: Id| -> R<bool> {
        Ok(made.contains(&id) || (!gone.contains(&id) && row_index(rows, id)?.is_some()))
    };
    // No node is moved into a node gone, and none (live, opaque or flying) is left in one.
    if moved.values().any(|p| p.is_some_and(|p| gone.contains(&p))) {
        return Ok(None);
    }
    if !gone.is_empty() {
        let mut f = frames.borrow_mut();
        if f.is_none() {
            *f = Some(Frames::of(state, header.zone)?);
        }
        let f = f.as_ref().expect("built");
        // A node gone with what is under it: each of its children, live, opaque or flying, is gone too.
        if gone.iter().any(|id| {
            f.children
                .get(id)
                .is_some_and(|c| c.iter().any(|c| !gone.contains(c)))
        }) {
            return Ok(None);
        }
    }
    // A node made goes into a frame the state already holds (live or opaque) or one made with it: one made inside a
    // private node made with it brings that node's opaque row too, which the whole path works out.
    for (_, id, _) in &added {
        match moved.get(id).copied().flatten() {
            Some(p) if live(p)? || row_index(arr(field(m, 8)?)?, p)?.is_some() => {}
            _ => return Ok(None),
        }
    }
    if !moved.is_empty() {
        let mut f = frames.borrow_mut();
        if f.is_none() {
            *f = Some(Frames::of(state, header.zone)?);
        }
        if !f.as_ref().is_some_and(|f| f.allow(&moved)) {
            return Ok(None);
        }
    }
    let links = match delta.get(&3) {
        None => None,
        Some(d) => {
            let mut l = pairs(field(m, 3)?)?;
            let mut ids = BTreeSet::new();
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
                    if l.remove(&id).is_none() {
                        return Ok(None);
                    }
                    continue;
                }
                // The link checks of `validate`, on this row alone: public, and its owning end a live node.
                let Ok(link) = LinkState::read(&r[1]) else {
                    return Ok(None);
                };
                if !public(link.audience)
                    || !live(link.ends[usize::from(link.owner == End::Second)])?
                {
                    return Ok(None);
                }
                l.insert(id, r[1].clone());
            }
            Some(paired(l))
        }
    };
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
                    || (!live(owner)?
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
    if !gone.is_empty() {
        // The links and timers left: none owned by a node gone (`validate`'s owner checks).
        for row in arr(links.as_ref().map_or_else(|| field(m, 3), Ok)?)? {
            let r = arr(row)?;
            let Some(Ok(link)) = r.get(1).map(LinkState::read) else {
                return Ok(None);
            };
            if gone.contains(&link.ends[usize::from(link.owner == End::Second)]) {
                return Ok(None);
            }
        }
        for row in arr(timers.as_ref().map_or_else(|| field(m, 6), Ok)?)? {
            let r = arr(row)?;
            let Some(t) = r.get(1) else {
                return Ok(None);
            };
            if gone.contains(&read_id(field(map(t)?, 1)?)?) {
                return Ok(None);
            }
        }
    }
    Ok(Some(Plan {
        v1: v1.clone(),
        rows: out,
        added: added.into_iter().map(|(at, _, row)| (at, row)).collect(),
        added_in: false,
        removed,
        timers,
        links,
        moved: moved.into_iter().collect(),
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
                // The rows a delta makes go before the old row whose index they carry (T-late).
                let added: &[(usize, Value)] = plan.map_or(&[], |p| &p.added);
                // The rows of the nodes a delta takes out are left out.
                let gone: BTreeSet<usize> = plan.map_or_else(BTreeSet::new, |p| {
                    p.removed.iter().map(|(at, ..)| *at).collect()
                });
                h.update(&head(4, (rows.len() + added.len() - gone.len()) as u64));
                let mut made = added.iter().peekable();
                for (i, e) in enc.iter().enumerate() {
                    while let Some((_, row)) = made.next_if(|(at, _)| *at == i) {
                        h.update(&encoded(row)?);
                    }
                    if gone.contains(&i) {
                        continue;
                    }
                    match over.get(&i) {
                        Some(v) => h.update(&encoded(v)?),
                        None => h.update(e),
                    }
                }
                for (_, row) in made {
                    h.update(&encoded(row)?);
                }
            }
            (
                6,
                Some(Plan {
                    timers: Some(t), ..
                }),
            ) => h.update(&encoded(t)?),
            (3, Some(Plan { links: Some(l), .. })) => h.update(&encoded(l)?),
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
    /// Each node's frame, once worked out, kept as nodes move in place (#4192).
    frames: std::cell::RefCell<Option<Frames>>,
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
            frames: std::cell::RefCell::new(None),
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
    /// The delta from the state to one at version `next` whose node rows `rows`, timers `timers` and links `links` (by
    /// id; `None`, gone) replace the live ones, those equal to the live ones left out (#3799, #4192): as [`context`]
    /// works it out from the two whole states. A node row `None` is a node taken out: its row gone when the state holds
    /// it, else nothing (one never public). A row of a node not live here is a node made (T-late) only when its id
    /// is in `made`, the nodes the caller's cut made, any link or timer on them among `links` and `timers` (set in the
    /// same cut: an activity offered, its node and its member link); any other is a node that comes back (out of a
    /// closed container, #3948) with rows this delta does not hold. None when it cannot be played in place (such a
    /// row, a frame walk `validate` would refuse, no new version); the caller then works it out whole.
    pub fn row_delta(
        &self,
        next: u64,
        mut rows: Vec<(Id, Option<Value>)>,
        timers: Vec<(Id, Option<Value>)>,
        links: Vec<(Id, Option<Value>)>,
        made: &BTreeSet<Id>,
    ) -> R<Option<Value>> {
        if next == self.version() {
            return Ok(None);
        }
        rows.sort_by_key(|(id, _)| *id);
        let live = arr(field(map(&self.state)?, 2)?)?;
        let mut changed = Vec::new();
        for (id, v) in rows {
            match (row_index(live, id)?, v) {
                (Some(i), Some(v)) if arr(&live[i])?[1] != v => {
                    changed.push(Value::Array(vec![id.to_value(), v]));
                }
                (Some(_), Some(_)) | (None, None) => {}
                (Some(_), None) => changed.push(Value::Array(vec![id.to_value()])),
                (None, Some(v)) if made.contains(&id) => {
                    changed.push(Value::Array(vec![id.to_value(), v]));
                }
                (None, Some(_)) => return Ok(None),
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
        // Links added, changed or removed (#4192): the same, by id.
        if !links.is_empty() {
            let live = pairs(field(map(&self.state)?, 3)?)?;
            let l: Vec<Value> = links
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
            if !l.is_empty() {
                delta.insert(3, Value::Array(l));
            }
        }
        // A row the in-place checks refuse is left to the whole cut, which decides (#3697: a producer then leaves out
        // what it cannot place).
        if !matches!(
            in_place(&self.header, &self.state, &delta, &self.frames),
            Ok(Some(_))
        ) {
            return Ok(None);
        }
        Ok(Some(Value::Map(delta)))
    }
    /// The digest of the state `delta` (from [`PublicPlayer::row_delta`]) would make, the state left as it is.
    pub fn digest_with(&mut self, delta: &Value) -> R<Vec<u8>> {
        let Some(plan) = in_place(&self.header, &self.state, map(delta)?, &self.frames)? else {
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
    /// Continues on the stream's next generation (#3825) without fetching its baseline, which holds this very
    /// state: the handoff's `digest` must be this state's (worked out now if parts were played deferred). The new
    /// generation's parts are then bound to `generation`, its baseline's SHA-256, and numbered from 0; the first one's
    /// prior digest is this state's, so a wrong generation or state is still refused at the first part.
    pub fn cross(&mut self, generation: &[u8], digest: &[u8]) -> R<()> {
        self.verify()?;
        if generation.len() != 32 || self.digest != digest {
            return refuse("stream-handoff-state", "the handoff is not of this state");
        }
        self.baseline = generation.to_vec();
        self.next = 0;
        Ok(())
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
        // In place (#3799, #4192): a delta of the version and rows of live nodes, links and timers, no node coming or
        // going and no flight changing, is checked row by row (a moved node with the frames under it), and its rows
        // are swapped into the state, swapped back on any refusal.
        let plan = in_place(&self.header, &self.state, map(field(&c, 5)?)?, &self.frames)?;
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
                        self.frames.replace(None);
                    }
                    (None, Some(p)) => {
                        if let Some(enc) = self.enc.as_mut() {
                            p.encodings_after(enc, &self.state)?;
                        }
                        if p.links.is_some() || !p.removed.is_empty() {
                            self.incident.replace(None);
                        }
                        if let Some(f) = self.frames.borrow_mut().as_mut() {
                            for (id, to) in &p.moved {
                                f.reparent(*id, *to);
                            }
                            for (_, id, _) in &p.removed {
                                f.remove(*id);
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
        // In place, a node gone was in the old state and is not in the next.
        let gone: BTreeSet<Id> = match (whole, old) {
            (None, Some(p)) => p.removed.iter().map(|(_, id, _)| *id).collect(),
            _ => BTreeSet::new(),
        };
        let mut changes = BTreeMap::new();
        for row in arr(field(c, 8)?)? {
            let row = arr(row)?;
            if row.len() != 2 {
                return bad("change version shape");
            };
            let id = read_id(&row[0])?;
            let v = uint(&row[1])?;
            let (was, is) = (
                has(&id, &old_nodes)? || gone.contains(&id),
                has(&id, &new_nodes)?,
            );
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
        if let Some(p) = old {
            for (i, old) in &p.rows {
                let at = p.index_after(*i);
                let Value::Array(row) = &rows[at] else {
                    return bad("expected an id/value pair");
                };
                if &rows[at] != old && !changes.contains_key(&read_id(&row[0])?) {
                    return bad("missing changed node version");
                }
            }
            // A node made (T-late) is a changed node, and so is a node gone.
            for (_, row) in &p.added {
                if !changes.contains_key(&read_id(&arr(row)?[0])?) {
                    return bad("missing changed node version");
                }
            }
            if gone.iter().any(|id| !changes.contains_key(id)) {
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
            // Several nodes at once (the page's reader after a part, #4684): `[id, ...]` → the record of each that is a
            // live public node, as query 1 answers it, in the order asked; one not here is left out. Its cost follows
            // the ids asked, not the world (query 1's row search and link index), unlike a whole snapshot.
            7 => {
                let mut out = Vec::new();
                for id in arr(arg)? {
                    let id = read_id(id)?;
                    if self.node_row(id)?.is_some() {
                        out.push(self.node_value(id)?);
                    }
                }
                Value::Array(out)
            }
            _ => return bad("query is 1 through 7"),
        };
        encoded(&out)
    }
}

#[cfg(test)]
mod i4192_frame_tests {
    use super::*;
    use crate::ids::Scope;

    /// A move in place passes only where `validate`'s frame walk would: no cycle, and no node under the moved one
    /// deeper than the limit.
    #[test]
    fn a_move_in_place_is_refused_where_the_whole_check_would_refuse_it() {
        let id = |n| Id::new(Scope([7; 16]), n).unwrap();
        let mut f = Frames::default();
        // A chain from the root 0: 0 <- 1 <- 2 <- ... <- 20, and 100 beside it under 0.
        f.reparent(id(0), None);
        for n in 1..=20 {
            f.reparent(id(n), Some(id(n - 1)));
        }
        f.reparent(id(100), Some(id(0)));
        let moved = |n, to| BTreeMap::from([(id(n), Some(id(to)))]);
        assert!(
            f.allow(&moved(100, 20)),
            "under the chain's end, within the limit"
        );
        assert!(f.allow(&moved(5, 100)), "a subtree moved beside");
        assert!(!f.allow(&moved(5, 12)), "under its own subtree: a cycle");
        assert!(!f.allow(&moved(5, 5)), "under itself");
        // Twenty more under 100 and the chain moved under them: 1 + 20 + 20 frames is past the limit of 32.
        for n in 101..=120 {
            f.reparent(id(n), Some(id(n - 1)));
        }
        assert!(
            !f.allow(&moved(1, 120)),
            "too deep for the nodes under the moved one"
        );
        assert!(f.allow(&moved(15, 120)), "a short tail fits");
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
        // #4684: query 7 answers the asked nodes as query 1 does, in the order asked, leaving out one not here
        let asked: Vec<Id> = values.keys().rev().copied().collect();
        let many = player
            .query(
                &encoded(&Value::Map(BTreeMap::from([
                    (1, Value::Uint(7)),
                    (
                        2,
                        Value::Array(
                            asked
                                .iter()
                                .map(|i| i.to_value())
                                .chain([id(0).to_value()])
                                .collect(),
                        ),
                    ),
                ])))
                .unwrap(),
            )
            .unwrap();
        let Value::Array(all) = &expected else {
            unreachable!()
        };
        assert_eq!(
            many,
            encoded(&Value::Array(all.iter().rev().cloned().collect())).unwrap(),
            "the asked live nodes, as query 1 answers each; the private one left out"
        );
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

#[cfg(test)]
mod gone_in_place_tests {
    use super::*;
    use crate::effects::{FIXTURE_HEADER, TimerState, fixture_bytes};
    use crate::ids::Scope;
    use crate::pose::{Frame, Quat, Support, Vec3};

    fn id(n: u64) -> Id {
        Id::new(Scope([95; 16]), n).unwrap()
    }

    /// A public body `n` standing on `parent`.
    fn body(header: &Header, n: u64, parent: Id) -> NodeState {
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
        NodeState {
            kind: header.kinds[0].clone(),
            parent: Some(parent),
            slot: None,
            audience: Audience::Everyone,
            fields: BTreeMap::from([(30, Value::Uint(n))]),
            place: Some(Value::Map(local)),
            motion: None,
        }
    }

    /// The zone with public bodies 1 and 2 beside each other, 3 inside 2, and link 6 owned by 1 (to 2).
    fn world(header: &Header) -> State {
        let mut state = State::start(header.zone, header.kinds[0].clone());
        state.next = 40;
        for (n, parent) in [(1, header.zone), (2, header.zone), (3, id(2))] {
            state.nodes.insert(id(n), body(header, n, parent));
        }
        state.links.insert(
            id(6),
            LinkState {
                ty: header.kinds[0].clone(),
                ends: [id(1), id(2)],
                owner: End::First,
                audience: Audience::Everyone,
            },
        );
        state
    }

    fn delta_of(header: &Header, before: &State, after: &State) -> BTreeMap<u64, Value> {
        let d = observation_delta(
            header,
            &project(header, before).unwrap(),
            &project(header, after).unwrap(),
        )
        .unwrap();
        map(&d).unwrap().clone()
    }

    /// A part that takes a body and its link out plays in place: the same state and digest as the whole path, and
    /// swapped back it is the state before.
    #[test]
    fn a_node_gone_is_played_in_place_with_the_whole_paths_state_and_digest() {
        let header = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
        let before = world(&header);
        let mut after = before.clone();
        after.next += 1;
        after.nodes.remove(&id(1));
        after.links.remove(&id(6));
        let delta = delta_of(&header, &before, &after);
        let (old, new) = (
            project(&header, &before).unwrap(),
            project(&header, &after).unwrap(),
        );
        let frames = std::cell::RefCell::new(None);
        let mut plan = in_place(&header, &old, &delta, &frames)
            .unwrap()
            .expect("played in place");
        assert_eq!(plan.removed.len(), 1);
        let enc: Vec<Vec<u8>> = arr(field(map(&old).unwrap(), 2).unwrap())
            .unwrap()
            .iter()
            .map(|r| encoded(r).unwrap())
            .collect();
        assert_eq!(
            streamed_digest(&old, &enc, Some(&plan)).unwrap(),
            digest(&new).unwrap(),
            "the whole path's digest"
        );
        let mut s = old.clone();
        plan.swap(&mut s);
        assert_eq!(s, new, "the whole path's state");
        plan.swap(&mut s);
        assert_eq!(s, old, "swapped back, the state before");
    }

    /// #4954: a node made of a kind a definition in the state pins, not the header (a group gesture a release added),
    /// plays in place to the whole path's state; on a state with no such definition it is left to the whole path.
    #[test]
    fn a_node_of_a_kind_the_state_defines_is_played_in_place() {
        use crate::kinds::defined::{ENTRY, NAME, kind};
        let header = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
        let pin = Name::new(&format!("eden:wave@1220{}", "ab".repeat(32))).unwrap();
        let mut before = world(&header);
        let mut definition = before.nodes[&id(1)].clone();
        definition.kind = Name::new(&kind().0).unwrap();
        definition.fields = BTreeMap::from([
            (NAME, Value::Text(pin.clone())),
            (ENTRY, Value::Bytes(Vec::new())),
        ]);
        before.nodes.insert(id(8), definition);
        let mut after = before.clone();
        after.next += 1;
        let mut made = before.nodes[&id(1)].clone();
        made.kind = pin;
        after.nodes.insert(id(7), made);
        let delta = delta_of(&header, &before, &after);
        let (old, new) = (
            project(&header, &before).unwrap(),
            project(&header, &after).unwrap(),
        );
        let mut plan = in_place(&header, &old, &delta, &std::cell::RefCell::new(None))
            .unwrap()
            .expect("played in place");
        let mut s = old.clone();
        plan.swap(&mut s);
        assert_eq!(s, new, "the whole path's state");
        before.nodes.remove(&id(8));
        let bare = project(&header, &before).unwrap();
        assert!(
            in_place(&header, &bare, &delta, &std::cell::RefCell::new(None))
                .unwrap()
                .is_none(),
            "no definition: the whole path"
        );
    }

    /// Two nodes gone: in id order they play in place to the whole path's state; with their rows reversed they are
    /// left to the whole path, which makes the same state.
    #[test]
    fn nodes_gone_out_of_id_order_are_left_to_the_whole_path() {
        let header = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
        let mut before = world(&header);
        let four = before.nodes[&id(1)].clone();
        before.nodes.insert(id(4), four);
        let mut after = before.clone();
        after.next += 1;
        after.nodes.remove(&id(1));
        after.nodes.remove(&id(4));
        after.links.remove(&id(6));
        let delta = delta_of(&header, &before, &after);
        let (old, new) = (
            project(&header, &before).unwrap(),
            project(&header, &after).unwrap(),
        );
        let frames = || std::cell::RefCell::new(None);
        let mut plan = in_place(&header, &old, &delta, &frames())
            .unwrap()
            .expect("in id order, played in place");
        assert_eq!(plan.removed.len(), 2);
        let mut s = old.clone();
        plan.swap(&mut s);
        assert_eq!(
            s,
            apply_observation(&header, &old, &Value::Map(delta.clone())).unwrap()
        );
        assert_eq!(s, new);
        let mut reversed = delta.clone();
        let Some(Value::Array(rows)) = reversed.get_mut(&2) else {
            unreachable!()
        };
        rows.reverse();
        assert!(
            in_place(&header, &old, &reversed, &frames())
                .unwrap()
                .is_none(),
            "out of id order: the whole path"
        );
        assert_eq!(
            apply_observation(&header, &old, &Value::Map(reversed)).unwrap(),
            new,
            "the whole path's state"
        );
    }

    /// A node gone that something still needs is left to the whole path: one with a node inside it, one owning a link
    /// left and one owning a timer left.
    #[test]
    fn a_node_gone_that_is_still_needed_is_left_to_the_whole_path() {
        let header = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
        let before = world(&header);
        let old = project(&header, &before).unwrap();
        let frames = || std::cell::RefCell::new(None);
        let gone = |delta: &mut BTreeMap<u64, Value>, n: u64| {
            let Some(Value::Array(rows)) = delta.get_mut(&2) else {
                unreachable!()
            };
            rows.push(Value::Array(vec![id(n).to_value()]));
            rows.sort_by_key(|r| read_id(&arr(r).unwrap()[0]).unwrap());
        };
        let touched = |s: &State| {
            let mut after = s.clone();
            after.next += 1;
            after
                .nodes
                .get_mut(&id(3))
                .unwrap()
                .fields
                .insert(30, Value::Uint(99));
            delta_of(&header, s, &after)
        };
        let mut d = touched(&before);
        gone(&mut d, 2);
        assert!(
            in_place(&header, &old, &d, &frames()).unwrap().is_none(),
            "a node with a node inside it"
        );
        let mut d = touched(&before);
        gone(&mut d, 1);
        assert!(
            in_place(&header, &old, &d, &frames()).unwrap().is_none(),
            "a node owning a link left"
        );
        let mut with_timer = before.clone();
        with_timer.links.clear();
        with_timer.timers.insert(
            id(8),
            TimerState {
                node: id(1),
                due: 5,
                name: header.kinds[0].clone(),
            },
        );
        let mut d = touched(&with_timer);
        gone(&mut d, 1);
        assert!(
            in_place(
                &header,
                &project(&header, &with_timer).unwrap(),
                &d,
                &frames()
            )
            .unwrap()
            .is_none(),
            "a node owning a timer left"
        );
    }

    /// The stream producer's cut of removes beside nodes made (a crowd's gestures ending and starting in one cut): a
    /// node gone with the node inside it, the link to it and its timer, and nodes made before, between and after the
    /// rows gone, in one delta. It plays in place to the whole path's state, digest and row encodings, and swapped
    /// back it is the state before. A node made inside one gone is left to the whole path.
    #[test]
    fn nodes_gone_with_what_is_under_them_beside_nodes_made_play_in_place() {
        let header = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
        let mut before = world(&header);
        for (n, parent) in [(10, header.zone), (11, id(10)), (20, header.zone)] {
            before.nodes.insert(id(n), body(&header, n, parent));
        }
        before.links.insert(
            id(12),
            LinkState {
                ty: header.kinds[0].clone(),
                ends: [id(1), id(11)],
                owner: End::First,
                audience: Audience::Everyone,
            },
        );
        before.timers.insert(
            id(13),
            TimerState {
                node: id(11),
                due: 5,
                name: header.kinds[0].clone(),
            },
        );
        let mut after = before.clone();
        after.next += 1;
        for n in [10, 11] {
            after.nodes.remove(&id(n));
        }
        after.links.remove(&id(12));
        after.timers.remove(&id(13));
        for n in [4, 15, 30] {
            after.nodes.insert(id(n), body(&header, n, header.zone));
        }
        after.nodes.get_mut(&id(3)).unwrap().fields.insert(30, Value::Uint(99));
        let delta = delta_of(&header, &before, &after);
        let (old, new) = (
            project(&header, &before).unwrap(),
            project(&header, &after).unwrap(),
        );
        let encodings = |s: &Value| -> Vec<Vec<u8>> {
            arr(field(map(s).unwrap(), 2).unwrap())
                .unwrap()
                .iter()
                .map(|r| encoded(r).unwrap())
                .collect()
        };
        let frames = std::cell::RefCell::new(None);
        let mut plan = in_place(&header, &old, &delta, &frames)
            .unwrap()
            .expect("played in place");
        assert_eq!((plan.removed.len(), plan.added.len()), (2, 3));
        let mut enc = encodings(&old);
        assert_eq!(
            streamed_digest(&old, &enc, Some(&plan)).unwrap(),
            digest(&new).unwrap(),
            "the whole path's digest"
        );
        let mut s = old.clone();
        plan.swap(&mut s);
        assert_eq!(s, new, "the whole path's state");
        assert_eq!(
            s,
            apply_observation(&header, &old, &Value::Map(delta.clone())).unwrap()
        );
        plan.encodings_after(&mut enc, &s).unwrap();
        assert_eq!(enc, encodings(&new), "the rows' encodings after");
        plan.swap(&mut s);
        assert_eq!(s, old, "swapped back, the state before");
        // A node made inside a node gone.
        let mut inside = delta.clone();
        let Some(Value::Array(rows)) = inside.get_mut(&2) else {
            unreachable!()
        };
        let row = Value::Array(vec![
            id(14).to_value(),
            body(&header, 14, id(10)).to_value(),
        ]);
        rows.push(row);
        rows.sort_by_key(|r| read_id(&arr(r).unwrap()[0]).unwrap());
        assert!(
            in_place(&header, &old, &inside, &std::cell::RefCell::new(None))
                .unwrap()
                .is_none(),
            "a node made inside one gone"
        );
    }
}
