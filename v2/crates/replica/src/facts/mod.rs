//! The fact sheet (Engine v2 V10, #2720): how "the same scene" is judged, by facts and not by pixels. One reader turns
//! a stretch of any view (V1's live parts, V3's history bundles) into a sheet; [`compare`] says whether two sheets are
//! equal under the rule below, and if not, the first second they differ.
//!
//! 1. **A fact sheet says, for each second of world time**, who is where (to 10 cm), in what posture, holding or using
//!    what, which things are in which visible state, and which acts start and end (to 100 ms). Read from the record:
//!    a node's kind, parent and slot (holding is a change of parent, T2), its position at the second, its support
//!    (standing on a surface and at what height, in a slot, in a volume, on a track: its posture as T4 records it),
//!    its fields (a thing's visible state), the links between nodes (using), and each named event (an act) with its
//!    world time, node and fields.
//! 2. **Second `s` is the state at world time `s` × 10^6 µs**, every entry at or before it applied, and the acts whose
//!    time falls in the second before it, `((s − 1) s, s s]`. A moving node's position is its last motion sample
//!    carried along its velocity to the second (T4 rule 8's straight track), so a view that kept a sample exactly on
//!    the second and one that thinned it (T7's `sampled`) both say where the node is then; an act carries its own
//!    time, never only the second it fell in.
//! 3. **Public audience only.** Nodes, links and acts whose audience is everyone. Speech is an act whose fields hold a
//!    reference (`{21: id}`, T8), never words; a whisper (an audience of one) is not on a public sheet.
//! 4. **The bytes.** A sheet is a run of records, each T0's deterministic CBOR behind its length (four bytes, big
//!    endian): first `{1: format, 2: first second, 3: end second}` (the end not included), then one record per second
//!    in order, `{1: second, 2: [[id, node], ...], 3: [id, ...], 4: [[id, link], ...], 5: [id, ...], 6: [[µs, node,
//!    name, fields], ...]}`: the nodes new or changed since the second before, the nodes gone, the same for links, and
//!    the acts. Empty lists are left out; the first second lists everything. A node is `{1: kind, 2: parent, 3: slot,
//!    4: [x, y, z] µm, 5: support, 6: fields}`, a link `{1: type, 2: [end, end], 3: owner}`.
//! 5. **The rule** ([`compare`]): positions equal within [`NEAR_UM`] (a distance, never a rounded grid: 9.95 and
//!    10.05 cm are 1 mm apart), act times within [`ACT_US`], everything else exactly.
//!
//! The same code runs natively and in WASM (`wasm.rs`: `FactSheet`, with `factsAt(t)` over the state it has applied).
//! Not here: facts from pixels, private audiences, removal (W7).

#[cfg(all(target_arch = "wasm32", not(feature = "checker")))]
mod wasm;

use std::collections::{BTreeMap, BTreeSet};

use crate::effects::{Effect, Header, LinkState, NodeState, Part, Refusal, State, read_id};
use crate::encode::{Name, Value, decode, encode, to_hex};
use crate::history::Bundle;
use crate::ids::Id;
use crate::stream::StreamPart;
use crate::time::Micros;
use crate::world_model::{Audience, End};

type R<T> = Result<T, Refusal>;

/// The sheet format this build writes and reads.
pub const FORMAT: u64 = 1;
/// One world second, µs.
pub const SECOND: Micros = 1_000_000;
/// How far apart two positions may be and still be equal, µm (10 cm).
pub const NEAR_UM: i64 = 100_000;
/// How far apart two acts' times may be and still be equal, µs (100 ms).
pub const ACT_US: Micros = 100_000;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: Option<&Value>, what: &str) -> R<i64> {
    match v {
        Some(Value::Uint(u)) => i64::try_from(*u).or_else(|_| refuse("facts-bad", what.to_owned())),
        Some(Value::Nint(n)) => i64::try_from(*n)
            .map(|n| -1 - n)
            .or_else(|_| refuse("facts-bad", what.to_owned())),
        _ => refuse("facts-bad", format!("{what} is not an integer")),
    }
}

fn vec3(v: Option<&Value>, what: &str) -> R<[i64; 3]> {
    match v {
        Some(Value::Array(a)) if a.len() == 3 => Ok([
            read_int(a.first(), what)?,
            read_int(a.get(1), what)?,
            read_int(a.get(2), what)?,
        ]),
        _ => refuse("facts-bad", format!("{what} is not [x, y, z]")),
    }
}

fn enc(v: &Value) -> R<Vec<u8>> {
    encode(v).or_else(|e| refuse("encoding", e.to_string()))
}

fn pairs(m: &BTreeMap<Id, Value>, only: impl Fn(&Id) -> bool) -> Value {
    Value::Array(
        m.iter()
            .filter(|(i, _)| only(i))
            .map(|(i, v)| Value::Array(vec![i.to_value(), v.clone()]))
            .collect(),
    )
}

/// An id as text, for a difference a person reads: its scope in hex and its counter.
pub fn show(id: Id) -> String {
    format!("{}-{}", to_hex(&id.scope().0), id.counter())
}

/// `n / d` rounded half away from zero, in i128 (`d` > 0).
fn div_round(n: i128, d: i128) -> i128 {
    if n >= 0 {
        (n + d / 2) / d
    } else {
        -((-n + d / 2) / d)
    }
}

/// A node's position at `t` (rule 2): its place's position, carried along its motion's velocity from the sample's time.
fn position(n: &NodeState, t: Micros) -> R<Option<[i64; 3]>> {
    let Some(Value::Map(place)) = &n.place else {
        return Ok(None);
    };
    let mut p = vec3(place.get(&2), "a position")?;
    if let Some(Value::Map(m)) = &n.motion {
        let at = read_int(m.get(&1), "a motion's time")?;
        let v = vec3(m.get(&2), "a velocity")?;
        let dt = i128::from(t.saturating_sub(at).max(0));
        for (p, v) in p.iter_mut().zip(v) {
            let step = div_round(i128::from(v) * dt, i128::from(SECOND));
            *p = i64::try_from(i128::from(*p) + step)
                .or_else(|_| refuse("facts-bad", "a position out of range"))?;
        }
    }
    Ok(Some(p))
}

fn node_facts(n: &NodeState, t: Micros) -> R<Value> {
    let mut m = BTreeMap::from([(1, Value::Text(n.kind.clone()))]);
    m.extend(n.parent.map(|p| (2, p.to_value())));
    m.extend(n.slot.map(|s| (3, Value::Uint(s))));
    if let Some(p) = position(n, t)? {
        m.insert(4, Value::Array(p.iter().map(|x| int(*x)).collect()));
    }
    if let Some(Value::Map(place)) = &n.place
        && let Some(s) = place.get(&4)
    {
        m.insert(5, s.clone());
    }
    if !n.fields.is_empty() {
        m.insert(6, Value::Map(n.fields.clone()));
    }
    Ok(Value::Map(m))
}

fn link_facts(l: &LinkState) -> Value {
    Value::Map(BTreeMap::from([
        (1, Value::Text(l.ty.clone())),
        (
            2,
            Value::Array(vec![l.ends[0].to_value(), l.ends[1].to_value()]),
        ),
        (3, Value::Uint(u64::from(l.owner == End::Second))),
    ]))
}

/// The public facts of a state at world time `t` (rule 1): its nodes and its links, by id.
pub fn facts_of(state: &State, t: Micros) -> R<(BTreeMap<Id, Value>, BTreeMap<Id, Value>)> {
    let mut nodes = BTreeMap::new();
    for (id, n) in &state.nodes {
        if n.audience == Audience::Everyone {
            nodes.insert(*id, node_facts(n, t)?);
        }
    }
    let links = state
        .links
        .iter()
        .filter(|(_, l)| l.audience == Audience::Everyone)
        .map(|(id, l)| (*id, link_facts(l)))
        .collect();
    Ok((nodes, links))
}

/// One second's whole record (rule 4, every node and link listed) from a state: what `factsAt(t)` gives a page.
pub fn facts_at(state: &State, t: Micros) -> R<Vec<u8>> {
    let (nodes, links) = facts_of(state, t)?;
    let mut m = BTreeMap::from([(1, int(t.div_euclid(SECOND)))]);
    if !nodes.is_empty() {
        m.insert(2, pairs(&nodes, |_| true));
    }
    if !links.is_empty() {
        m.insert(4, pairs(&links, |_| true));
    }
    enc(&Value::Map(m))
}

fn read_audience(v: Option<&Value>) -> R<Audience> {
    let Some(Value::Map(m)) = v else {
        return refuse("facts-bad", "an audience is a map");
    };
    match m.get(&1) {
        Some(Value::Uint(1)) => Ok(Audience::Everyone),
        Some(Value::Uint(2)) => Ok(Audience::Of(read_id(m.get(&2).unwrap_or(&Value::Uint(0)))?)),
        _ => refuse("facts-bad", "an audience is 1 everyone or 2 an id"),
    }
}

fn rows(v: Option<&Value>, what: &str) -> R<Vec<(Id, BTreeMap<u64, Value>)>> {
    let Some(Value::Array(a)) = v else {
        return refuse("facts-bad", format!("{what} are not a list"));
    };
    a.iter()
        .map(|r| match r {
            Value::Array(p) if p.len() == 2 => match &p[1] {
                Value::Map(m) => Ok((read_id(&p[0])?, m.clone())),
                _ => refuse("facts-bad", format!("{what}: a row is [id, map]")),
            },
            _ => refuse("facts-bad", format!("{what}: a row is [id, map]")),
        })
        .collect()
}

fn name_of(v: Option<&Value>, what: &str) -> R<Name> {
    match v {
        Some(Value::Text(n)) => Ok(n.clone()),
        _ => refuse("facts-bad", format!("{what} is not a name")),
    }
}

/// A state from a bundle's public snapshot (V3 rule 1, T6's state layout): the zone as it stood at the bundle's start.
pub fn state_from_snapshot(snapshot: &Value) -> R<State> {
    let Value::Map(s) = snapshot else {
        return refuse("facts-bad", "a snapshot is a map");
    };
    let mut nodes = BTreeMap::new();
    for (id, m) in rows(s.get(&1), "a snapshot's nodes")? {
        let parent = m.get(&2).map(read_id).transpose()?;
        let slot = match m.get(&3) {
            Some(Value::Uint(u)) => Some(*u),
            _ => None,
        };
        let fields = match m.get(&5) {
            Some(Value::Map(f)) => f.clone(),
            _ => BTreeMap::new(),
        };
        let n = NodeState {
            kind: name_of(m.get(&1), "a kind")?,
            parent,
            slot,
            audience: read_audience(m.get(&4))?,
            fields,
            place: m.get(&6).cloned(),
            motion: m.get(&7).cloned(),
        };
        nodes.insert(id, n);
    }
    let Some((root, r)) = nodes.iter().find(|(_, n)| n.parent.is_none()) else {
        return refuse("facts-bad", "a snapshot has no root");
    };
    let mut state = State::start(*root, r.kind.clone());
    state.nodes = nodes;
    for (id, m) in rows(s.get(&2), "a snapshot's links")? {
        let ends = match m.get(&2) {
            Some(Value::Array(e)) if e.len() == 2 => [read_id(&e[0])?, read_id(&e[1])?],
            _ => return refuse("facts-bad", "a link's ends are [end, end]"),
        };
        let l = LinkState {
            ty: name_of(m.get(&1), "a link's type")?,
            ends,
            owner: if m.get(&3) == Some(&Value::Uint(1)) {
                End::Second
            } else {
                End::First
            },
            audience: read_audience(m.get(&4))?,
        };
        state.links.insert(id, l);
    }
    Ok(state)
}

/// A zone's state at its start, from its header: the root alone, of the header's place kind (as `Replica::start`).
fn start_of(header: &Header) -> R<State> {
    let Some(kind) = header
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .cloned()
    else {
        return refuse("facts-bad", "the header lists no place kind for the root");
    };
    Ok(State::start(header.zone, kind))
}

/// A fact sheet as it is read (rules 2 and 4): fed a view's files in order, it writes a record each time the view
/// passes a second.
pub struct Sheet {
    header: Header,
    state: Option<State>,
    end: i64,
    next: i64,
    nodes: BTreeMap<Id, Value>,
    links: BTreeMap<Id, Value>,
    acts: Vec<Value>,
    out: Vec<u8>,
}

fn frame(out: &mut Vec<u8>, v: &Value) -> R<()> {
    let b = enc(v)?;
    let len = u32::try_from(b.len()).or_else(|_| refuse("facts-bad", "a record over 4 GiB"))?;
    out.extend(len.to_be_bytes());
    out.extend(b);
    Ok(())
}

impl Sheet {
    /// A sheet of the seconds `t0..t1` (world seconds, `t1` not included) of a view of the zone `header` names.
    pub fn new(header: &[u8], t0: i64, t1: i64) -> R<Sheet> {
        if t1 < t0 {
            return refuse("facts-range", format!("{t0}..{t1}"));
        }
        let mut out = Vec::new();
        frame(
            &mut out,
            &Value::Map(BTreeMap::from([
                (1, Value::Uint(FORMAT)),
                (2, int(t0)),
                (3, int(t1)),
            ])),
        )?;
        Ok(Sheet {
            header: Header::read(header)?,
            state: None,
            end: t1,
            next: t0,
            nodes: BTreeMap::new(),
            links: BTreeMap::new(),
            acts: Vec::new(),
            out,
        })
    }

    /// The state applied so far, if any.
    pub fn state(&self) -> Option<&State> {
        self.state.as_ref()
    }

    /// Feeds one stream part's file bytes (V1); the first part starts the zone from its header.
    pub fn part(&mut self, bytes: &[u8]) -> R<()> {
        let sp = StreamPart::read(bytes)?;
        let part = Part::read(&sp.part)?;
        if self.state.is_none() {
            self.state = Some(start_of(&self.header)?);
        }
        self.effects(&part)
    }

    /// Feeds one history bundle's bytes (V3); the first bundle starts the zone from its snapshot.
    pub fn bundle(&mut self, bytes: &[u8]) -> R<()> {
        let b = Bundle::read(bytes)?;
        if self.state.is_none() {
            self.state = Some(state_from_snapshot(&b.snapshot)?);
        }
        let records = match &b.view {
            Value::Map(m) => m.get(&8).cloned().unwrap_or(Value::Array(Vec::new())),
            _ => return refuse("facts-bad", "a bundle's view is a map"),
        };
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(b.header.clone())),
            (2, records),
        ]));
        self.effects(&Part::read(&enc(&v)?)?)
    }

    fn effects(&mut self, part: &Part) -> R<()> {
        if part.header != self.header.hash().to_bytes() {
            return refuse("header-mismatch", "the view names another header");
        }
        part.effects.iter().try_for_each(|e| self.feed(e))
    }

    /// Applies one entry of the view. The view may have skipped entries (another audience's, or thinned motion): its
    /// sequences may jump, never go back.
    pub fn feed(&mut self, e: &Effect) -> R<()> {
        let at = e.envelope.at;
        while self.next < self.end && at > self.next * SECOND {
            self.write()?;
        }
        let Some(state) = self.state.as_mut() else {
            return refuse("facts-order", "an entry before the view's start");
        };
        if e.envelope.sequence < state.next {
            return refuse(
                "facts-order",
                format!("entry {} after {}", e.envelope.sequence, state.next),
            );
        }
        state.next = e.envelope.sequence;
        state.apply_entry(&self.header, e)?;
        let second = at.div_euclid(SECOND) + i64::from(at.rem_euclid(SECOND) != 0);
        if e.envelope.audience == Audience::Everyone && second >= self.next && second < self.end {
            for ev in e.events.iter().flatten() {
                self.acts.push(Value::Array(vec![
                    int(at),
                    e.envelope.node.to_value(),
                    Value::Text(ev.name.clone()),
                    Value::Map(ev.fields.clone()),
                ]));
            }
        }
        Ok(())
    }

    /// Writes the record of the next second (rule 4).
    fn write(&mut self) -> R<()> {
        let s = self.next;
        let (nodes, links) = match &self.state {
            Some(state) => facts_of(state, s * SECOND)?,
            None => (BTreeMap::new(), BTreeMap::new()),
        };
        let mut m = BTreeMap::from([(1, int(s))]);
        let changed = |new: &BTreeMap<Id, Value>, old: &BTreeMap<Id, Value>| {
            pairs(new, |i| old.get(i) != new.get(i))
        };
        let gone = |new: &BTreeMap<Id, Value>, old: &BTreeMap<Id, Value>| {
            Value::Array(
                old.keys()
                    .filter(|i| !new.contains_key(i))
                    .map(|i| i.to_value())
                    .collect(),
            )
        };
        let acts = Value::Array(std::mem::take(&mut self.acts));
        for (k, v) in [
            (2, changed(&nodes, &self.nodes)),
            (3, gone(&nodes, &self.nodes)),
            (4, changed(&links, &self.links)),
            (5, gone(&links, &self.links)),
            (6, acts),
        ] {
            if v != Value::Array(Vec::new()) {
                m.insert(k, v);
            }
        }
        frame(&mut self.out, &Value::Map(m))?;
        self.nodes = nodes;
        self.links = links;
        self.next += 1;
        Ok(())
    }

    /// Writes the seconds left and gives the sheet's bytes.
    pub fn finish(mut self) -> R<Vec<u8>> {
        while self.next < self.end {
            self.write()?;
        }
        Ok(self.out)
    }
}

/// What a view is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// V1's numbered stream parts, in number order.
    Parts,
    /// V3's history bundles, in order of start.
    Bundles,
}

/// The fact sheet of the seconds `t0..t1` of a view (rules 1 to 4): `files` are its parts or bundles, in order.
pub fn fact_sheet<'a>(
    header: &[u8],
    source: Source,
    files: impl IntoIterator<Item = &'a [u8]>,
    t0: i64,
    t1: i64,
) -> R<Vec<u8>> {
    let mut s = Sheet::new(header, t0, t1)?;
    for f in files {
        match source {
            Source::Parts => s.part(f)?,
            Source::Bundles => s.bundle(f)?,
        }
    }
    s.finish()
}

// --- Reading and comparing sheets ---------------------------------------------------------------------------------

/// A sheet's records as values, in order, read one at a time: the first is its `{1: format, 2: first, 3: end}`.
pub struct Records<'a>(&'a [u8]);

impl Iterator for Records<'_> {
    type Item = R<BTreeMap<u64, Value>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.0.is_empty() {
            return None;
        }
        let Some((len, tail)) = self.0.split_first_chunk::<4>() else {
            self.0 = &[];
            return Some(refuse("facts-bad", "a record's length is four bytes"));
        };
        let n = usize::try_from(u32::from_be_bytes(*len)).unwrap_or(usize::MAX);
        if tail.len() < n {
            self.0 = &[];
            return Some(refuse("facts-bad", "a record shorter than its length"));
        }
        let (item, more) = tail.split_at(n);
        self.0 = more;
        Some(match decode(item).map(|d| d.value) {
            Ok(Value::Map(m)) => Ok(m),
            Ok(_) => refuse("facts-bad", "a record is a map"),
            Err(e) => refuse("encoding", e.to_string()),
        })
    }
}

/// Reads a sheet's records (rule 4).
pub fn records(sheet: &[u8]) -> Records<'_> {
    Records(sheet)
}

/// The first place two sheets differ under the rule (rule 5): the second, and what differs there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Difference {
    pub second: i64,
    pub what: String,
}

#[derive(Default)]
struct Seen {
    nodes: BTreeMap<Id, Value>,
    links: BTreeMap<Id, Value>,
}

impl Seen {
    fn apply(&mut self, r: &BTreeMap<u64, Value>) -> R<()> {
        for (k, map) in [(2, &mut self.nodes), (4, &mut self.links)] {
            if let Some(Value::Array(a)) = r.get(&k) {
                for row in a {
                    match row {
                        Value::Array(p) if p.len() == 2 => {
                            map.insert(read_id(&p[0])?, p[1].clone());
                        }
                        _ => return refuse("facts-bad", "a row is [id, value]"),
                    }
                }
            }
        }
        for (k, map) in [(3, &mut self.nodes), (5, &mut self.links)] {
            if let Some(Value::Array(a)) = r.get(&k) {
                for id in a {
                    map.remove(&read_id(id)?);
                }
            }
        }
        Ok(())
    }
}

fn apart(a: &Value, b: &Value) -> R<u128> {
    let (a, b) = (vec3(Some(a), "a position")?, vec3(Some(b), "a position")?);
    let sq: u128 = (0..3)
        .map(|i| (i128::from(a[i]) - i128::from(b[i])).unsigned_abs().pow(2))
        .sum();
    Ok(sq.isqrt())
}

fn show_value(v: &Value) -> String {
    format!("{v:?}")
}

fn node_differs(a: &Value, b: &Value) -> R<Option<String>> {
    let (Value::Map(a), Value::Map(b)) = (a, b) else {
        return refuse("facts-bad", "a node is a map");
    };
    let keys: BTreeSet<u64> = a.keys().chain(b.keys()).copied().collect();
    for k in keys {
        let (x, y) = (a.get(&k), b.get(&k));
        let what = match k {
            1 => "kind",
            2 => "parent",
            3 => "slot",
            4 => "position",
            5 => "support",
            6 => "fields",
            _ => "field",
        };
        match (k, x, y) {
            (4, Some(x), Some(y)) => {
                let d = apart(x, y)?;
                if d > NEAR_UM.unsigned_abs().into() {
                    return Ok(Some(format!(
                        "position {} mm apart: {} and {}",
                        d / 1000,
                        show_value(x),
                        show_value(y)
                    )));
                }
            }
            _ if x != y => {
                return Ok(Some(format!(
                    "{what}: {} and {}",
                    x.map_or("none".to_owned(), show_value),
                    y.map_or("none".to_owned(), show_value)
                )));
            }
            _ => {}
        }
    }
    Ok(None)
}

fn acts_differ(a: Option<&Value>, b: Option<&Value>) -> R<Option<String>> {
    let empty = Vec::new();
    let list = |v: Option<&Value>| match v {
        Some(Value::Array(l)) => Ok(l.clone()),
        None => Ok(empty.clone()),
        _ => refuse("facts-bad", "acts are a list"),
    };
    let (a, b) = (list(a)?, list(b)?);
    if a.len() != b.len() {
        return Ok(Some(format!("{} acts and {}", a.len(), b.len())));
    }
    for (x, y) in a.iter().zip(&b) {
        let (Value::Array(x), Value::Array(y)) = (x, y) else {
            return refuse("facts-bad", "an act is a list");
        };
        let (tx, ty) = (
            read_int(x.first(), "an act's time")?,
            read_int(y.first(), "an act's time")?,
        );
        if x.get(1..) != y.get(1..) {
            return Ok(Some(format!(
                "act {} and {}",
                show_value(&Value::Array(x.clone())),
                show_value(&Value::Array(y.clone()))
            )));
        }
        if (tx - ty).abs() > ACT_US {
            return Ok(Some(format!("an act at {tx} µs and at {ty} µs")));
        }
    }
    Ok(None)
}

/// Compares two sheets under the rule (rule 5): none when they are equal, else the first second they differ at.
pub fn compare(a: &[u8], b: &[u8]) -> R<Option<Difference>> {
    let (mut ra, mut rb) = (records(a), records(b));
    let (Some(ha), Some(hb)) = (ra.next().transpose()?, rb.next().transpose()?) else {
        return refuse("facts-bad", "a sheet starts with its range");
    };
    let first = read_int(ha.get(&2), "a sheet's first second")?;
    if ha != hb {
        return Ok(Some(Difference {
            second: first,
            what: "the sheets cover other seconds, or are of other formats".into(),
        }));
    }
    let (mut sa, mut sb) = (Seen::default(), Seen::default());
    let mut second = first;
    loop {
        let (x, y) = match (ra.next().transpose()?, rb.next().transpose()?) {
            (None, None) => return Ok(None),
            (Some(x), Some(y)) => (x, y),
            (x, _) => {
                let short = if x.is_some() { "second" } else { "first" };
                return Ok(Some(Difference {
                    second,
                    what: format!("the {short} sheet ends here"),
                }));
            }
        };
        second = read_int(x.get(&1), "a record's second")?;
        let diff = |what: String| Ok(Some(Difference { second, what }));
        if x.get(&1) != y.get(&1) {
            return diff("the records are of other seconds".into());
        }
        sa.apply(&x)?;
        sb.apply(&y)?;
        let ids: BTreeSet<Id> = sa.nodes.keys().chain(sb.nodes.keys()).copied().collect();
        for id in ids {
            match (sa.nodes.get(&id), sb.nodes.get(&id)) {
                (Some(p), Some(q)) => {
                    if let Some(w) = node_differs(p, q)? {
                        return diff(format!("node {}: {w}", show(id)));
                    }
                }
                (p, _) => {
                    let side = if p.is_some() { "first" } else { "second" };
                    return diff(format!("node {} is on the {side} sheet only", show(id)));
                }
            }
        }
        if sa.links != sb.links {
            let id = sa
                .links
                .iter()
                .chain(&sb.links)
                .find(|(i, _)| sa.links.get(i) != sb.links.get(i))
                .map_or("?".to_owned(), |(i, _)| show(*i));
            return diff(format!("link {id}"));
        }
        if let Some(w) = acts_differ(x.get(&6), y.get(&6))? {
            return diff(w);
        }
        second += 1;
    }
}
