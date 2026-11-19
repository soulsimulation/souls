//! The world-wide index and the Soul list (Engine v2 E1, #2708): every place and thing of a world in the agent's copy,
//! and where each Soul is. Both are public; queries run here, in the library, and the model never sees the index
//! whole.
//!
//! 1. **A row is what finds a node, never its state.** A place: id, name, kind, parent, outline (to 0.1 m, in its
//!    parent's frame) and aliases. A thing: id, name, kind, parent, named place and position (to 0.1 m, in its
//!    parent's frame). Only public nodes enter ([`Audience::Everyone`]): a hidden thing is in no index.
//! 2. **The named place** is the nearest ancestor that is a place, or, among the places that are its siblings (the
//!    named areas of open ground, which hold nobody), the smallest whose outline holds its position ([`Index::place_of`]).
//! 3. **A file named by hash, then changes.** [`Index::to_bytes`] is the whole index, named by [`file_name`] (R5's
//!    `1220` and the SHA-256); [`Index::update`] gives the changes a set of touched nodes made: create, remove,
//!    rename, a new parent or a new named place. Never a thing's fields. [`Index::apply`] applies them to a copy.
//! 4. **Ids in one scope are written as their counter.** The file names its scope once.
//! 5. **The Soul list** ([`Souls`]): each Soul (by its public `souls:body-of` link) to its body's node and named place.
//!    A Soul is numbered when first listed, so a move is `[n, node, place]`.
//!
//! Which kinds are places, which are things and which fields hold a name, an outline and aliases is the world's to
//! say ([`Config`]): the library names no kind.

use crate::effects::{NodeState, Refusal, State, read_id};
use crate::encode::{Value, decode, encode, to_hex};
use crate::ids::{Id, Scope, sha256};
use crate::world_model::{Audience, DEPTH_LIMIT, plain};
use std::collections::{BTreeMap, BTreeSet};

type R<T> = Result<T, Refusal>;

fn refuse<T>(detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name: "index-record",
        detail: detail.into(),
    })
}

/// What a kind is to the index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Place,
    Thing,
    Skip,
}

/// Which fields hold what, and which kinds are which (the world's, not the library's).
pub struct Config {
    /// A name: words by reference (32 bytes, looked up in `words`) or the words themselves as bytes.
    pub name: u64,
    /// A place's outline, `[[x, z], ...]` in `outline_um` units.
    pub outline: u64,
    pub outline_um: i64,
    pub aliases: Option<u64>,
    pub role: Box<dyn Fn(&str) -> Role + Send>,
    /// The words of public references (K16's store stands in here).
    pub words: BTreeMap<[u8; 32], String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaceRow {
    pub name: String,
    pub kind: String,
    pub parent: Option<Id>,
    /// `[x, z]` in decimetres.
    pub outline: Vec<[i64; 2]>,
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThingRow {
    pub name: String,
    pub kind: String,
    pub parent: Option<Id>,
    pub place: Option<Id>,
    /// `[x, z]` in decimetres.
    pub at: [i64; 2],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    Place(PlaceRow),
    Thing(ThingRow),
}

impl Row {
    fn name(&self) -> &str {
        match self {
            Row::Place(p) => &p.name,
            Row::Thing(t) => &t.name,
        }
    }
    fn parent(&self) -> Option<Id> {
        match self {
            Row::Place(p) => p.parent,
            Row::Thing(t) => t.parent,
        }
    }
}

/// A change to the index (rule 3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Create(Id, Row),
    Remove(Id),
    Rename(Id, String),
    Parent(Id, Option<Id>),
    Place(Id, Option<Id>),
}

/// A named area: its place, area (twice, in dm²), bounds and outline.
#[derive(Clone, Debug)]
struct Area {
    place: Id,
    twice: i128,
    lo: [i64; 2],
    hi: [i64; 2],
    outline: Vec<[i64; 2]>,
}

/// The index: rows by id, the named areas under each parent, and the words' search map, built when first asked.
#[derive(Clone, Debug)]
pub struct Index {
    scope: Scope,
    rows: BTreeMap<Id, Row>,
    areas: BTreeMap<Id, Vec<Area>>,
    search: Option<Search>,
}

#[derive(Clone, Debug, Default)]
struct Search {
    /// Each word to the rows it names, places first.
    words: BTreeMap<String, Vec<Id>>,
}

/// `1220` and the SHA-256 of the bytes, in hex: what a file is named by (R5).
pub fn file_name(bytes: &[u8]) -> String {
    format!("1220{}", to_hex(&sha256(bytes)))
}

/// The lower-case words of a text: runs of letters and digits.
pub fn words_of(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// A kind's words: its plain name without the namespace.
fn kind_words(kind: &str) -> Vec<String> {
    let p = plain(kind);
    words_of(p.split_once(':').map_or(p, |(_, n)| n))
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn sint(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

/// A node's position in its parent's frame, `[x, z]` in decimetres, from its stored pose (`{2: [x, y, z] µm}`).
fn position(n: &NodeState) -> Option<[i64; 2]> {
    let Some(Value::Map(m)) = &n.place else {
        return None;
    };
    let Some(Value::Array(p)) = m.get(&2) else {
        return None;
    };
    Some([
        int(p.first()?)?.div_euclid(100_000),
        int(p.get(2)?)?.div_euclid(100_000),
    ])
}

/// Whether `p` is inside `poly` (crossings, in integers).
fn inside(p: [i64; 2], poly: &[[i64; 2]]) -> bool {
    let (x, z) = (i128::from(p[0]), i128::from(p[1]));
    let mut c = false;
    let mut j = poly.len().wrapping_sub(1);
    for (i, a) in poly.iter().enumerate() {
        let b = poly[j];
        let (xi, zi, xj, zj) = (
            i128::from(a[0]),
            i128::from(a[1]),
            i128::from(b[0]),
            i128::from(b[1]),
        );
        if (zi > z) != (zj > z) {
            let lhs = (x - xi) * (zj - zi);
            let rhs = (xj - xi) * (z - zi);
            if (zj > zi && lhs < rhs) || (zj < zi && lhs > rhs) {
                c = !c;
            }
        }
        j = i;
    }
    c
}

impl Index {
    pub fn new(scope: Scope) -> Index {
        Index {
            scope,
            rows: BTreeMap::new(),
            areas: BTreeMap::new(),
            search: None,
        }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn row(&self, id: Id) -> Option<&Row> {
        self.rows.get(&id)
    }

    /// Every node of `state` that is public and a place or a thing.
    pub fn build(state: &State, cfg: &Config) -> Index {
        let mut ix = Index::new(state.root.scope());
        let ids: BTreeSet<Id> = state.nodes.keys().copied().collect();
        ix.update(state, cfg, &ids, false);
        ix
    }

    fn name_of(cfg: &Config, n: &NodeState) -> String {
        match n.fields.get(&cfg.name) {
            Some(Value::Bytes(b)) if b.len() == 32 => {
                let mut k = [0u8; 32];
                k.copy_from_slice(b);
                cfg.words.get(&k).cloned().unwrap_or_default()
            }
            Some(Value::Bytes(b)) => String::from_utf8_lossy(b).into_owned(),
            Some(Value::Text(t)) => t.as_str().to_owned(),
            _ => String::new(),
        }
    }

    fn place_row(cfg: &Config, n: &NodeState) -> PlaceRow {
        // An outline is in the place's own frame; the row's is in its parent's (the place's position added; a turned
        // place's turn is not applied).
        let unit = cfg.outline_um.max(1);
        let o = position(n).unwrap_or([0, 0]);
        let outline = match n.fields.get(&cfg.outline) {
            Some(Value::Array(pts)) => pts
                .iter()
                .filter_map(|p| match p {
                    Value::Array(xz) if xz.len() == 2 => Some([
                        (int(&xz[0])? * unit).div_euclid(100_000) + o[0],
                        (int(&xz[1])? * unit).div_euclid(100_000) + o[1],
                    ]),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let aliases = match cfg.aliases.and_then(|f| n.fields.get(&f)) {
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|v| match v {
                    Value::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        PlaceRow {
            name: Index::name_of(cfg, n),
            kind: plain(n.kind.as_str()).to_owned(),
            parent: n.parent,
            outline,
            aliases,
        }
    }

    fn rebuild_areas(&mut self) {
        self.areas.clear();
        for (id, r) in &self.rows {
            let Row::Place(p) = r else { continue };
            let (Some(parent), true) = (p.parent, p.outline.len() >= 3) else {
                continue;
            };
            let mut twice: i128 = 0;
            let mut lo = p.outline[0];
            let mut hi = p.outline[0];
            for (i, a) in p.outline.iter().enumerate() {
                let b = p.outline[(i + 1) % p.outline.len()];
                twice += i128::from(a[0]) * i128::from(b[1]) - i128::from(b[0]) * i128::from(a[1]);
                for k in 0..2 {
                    lo[k] = lo[k].min(a[k]);
                    hi[k] = hi[k].max(a[k]);
                }
            }
            self.areas.entry(parent).or_default().push(Area {
                place: *id,
                twice: twice.abs(),
                lo,
                hi,
                outline: p.outline.clone(),
            });
        }
        for v in self.areas.values_mut() {
            v.sort_by_key(|a| (a.twice, a.place));
        }
    }

    /// Rule 2: the named place of a node of `state`.
    pub fn place_of(&self, state: &State, id: Id) -> Option<Id> {
        let mut at = id;
        for _ in 0..=DEPTH_LIMIT {
            let n = state.nodes.get(&at)?;
            let parent = n.parent?;
            if matches!(self.rows.get(&parent), Some(Row::Place(_))) {
                return Some(parent);
            }
            if let (Some(areas), Some(p)) = (self.areas.get(&parent), position(n)) {
                let hit = areas.iter().find(|a| {
                    a.place != at
                        && (a.lo[0]..=a.hi[0]).contains(&p[0])
                        && (a.lo[1]..=a.hi[1]).contains(&p[1])
                        && inside(p, &a.outline)
                });
                if let Some(a) = hit {
                    return Some(a.place);
                }
            }
            at = parent;
        }
        None
    }

    /// Rule 3: re-reads the touched nodes from `state` and gives what changed. Places first, so a thing's named place
    /// is read against them; a node no longer in `state` is removed, with every row under it (`sweep`).
    pub fn update(
        &mut self,
        state: &State,
        cfg: &Config,
        touched: &BTreeSet<Id>,
        sweep: bool,
    ) -> Vec<Change> {
        let mut out = Vec::new();
        let role = |n: &NodeState| {
            if n.audience == Audience::Everyone {
                (cfg.role)(n.kind.as_str())
            } else {
                Role::Skip
            }
        };
        let mut gone: Vec<Id> = touched
            .iter()
            .filter(|id| self.rows.contains_key(id) && !state.nodes.contains_key(id))
            .copied()
            .collect();
        if sweep || !gone.is_empty() {
            gone = self
                .rows
                .keys()
                .filter(|id| !state.nodes.contains_key(id))
                .copied()
                .collect();
        }
        let mut places_changed = false;
        for id in gone {
            if let Some(Row::Place(_)) = self.rows.remove(&id) {
                places_changed = true;
            }
            out.push(Change::Remove(id));
        }
        for id in touched {
            let Some(n) = state.nodes.get(id) else {
                continue;
            };
            if role(n) != Role::Place {
                continue;
            }
            let row = Row::Place(Index::place_row(cfg, n));
            if self.rows.get(id) != Some(&row) {
                places_changed = true;
                self.diff(*id, row, &mut out);
            }
        }
        if places_changed {
            self.rebuild_areas();
        }
        for id in touched {
            let Some(n) = state.nodes.get(id) else {
                continue;
            };
            if role(n) != Role::Thing {
                continue;
            }
            let row = Row::Thing(ThingRow {
                name: Index::name_of(cfg, n),
                kind: plain(n.kind.as_str()).to_owned(),
                parent: n.parent,
                place: self.place_of(state, *id),
                at: position(n).unwrap_or([0, 0]),
            });
            self.diff(*id, row, &mut out);
        }
        if !out.is_empty() {
            self.search = None;
        }
        out
    }

    /// Records `row` and the change it makes; a thing's position alone is no change (rule 3).
    fn diff(&mut self, id: Id, row: Row, out: &mut Vec<Change>) {
        match self.rows.get(&id) {
            None => out.push(Change::Create(id, row.clone())),
            Some(old) => {
                if std::mem::discriminant(old) != std::mem::discriminant(&row) {
                    out.push(Change::Remove(id));
                    out.push(Change::Create(id, row.clone()));
                } else if let (Row::Place(a), Row::Place(b)) = (old, &row)
                    && (a.kind != b.kind || a.outline != b.outline || a.aliases != b.aliases)
                {
                    out.push(Change::Create(id, row.clone()));
                } else {
                    if old.name() != row.name() {
                        out.push(Change::Rename(id, row.name().to_owned()));
                    }
                    if old.parent() != row.parent() {
                        out.push(Change::Parent(id, row.parent()));
                    }
                    if let (Row::Thing(a), Row::Thing(b)) = (old, &row)
                        && a.place != b.place
                    {
                        out.push(Change::Place(id, b.place));
                    }
                }
            }
        }
        self.rows.insert(id, row);
    }

    /// Applies changes (a copy's side of rule 3).
    pub fn apply(&mut self, changes: &[Change]) {
        let mut places = false;
        for c in changes {
            match c {
                Change::Create(id, row) => {
                    places |= matches!(row, Row::Place(_));
                    self.rows.insert(*id, row.clone());
                }
                Change::Remove(id) => {
                    places |= matches!(self.rows.remove(id), Some(Row::Place(_)));
                }
                Change::Rename(id, name) => match self.rows.get_mut(id) {
                    Some(Row::Place(p)) => p.name.clone_from(name),
                    Some(Row::Thing(t)) => t.name.clone_from(name),
                    None => {}
                },
                Change::Parent(id, parent) => match self.rows.get_mut(id) {
                    Some(Row::Place(p)) => {
                        places = true;
                        p.parent = *parent;
                    }
                    Some(Row::Thing(t)) => t.parent = *parent,
                    None => {}
                },
                Change::Place(id, place) => {
                    if let Some(Row::Thing(t)) = self.rows.get_mut(id) {
                        t.place = *place;
                    }
                }
            }
        }
        if places {
            self.rebuild_areas();
        }
        if !changes.is_empty() {
            self.search = None;
        }
    }

    // --- Queries ------------------------------------------------------------------------------------------------

    fn search(&mut self) -> &Search {
        if self.search.is_none() {
            let mut s = Search::default();
            let mut add = |w: String, id: Id| {
                let v = s.words.entry(w).or_default();
                if v.last() != Some(&id) {
                    v.push(id);
                }
            };
            for pass in [true, false] {
                for (id, r) in &self.rows {
                    if matches!(r, Row::Place(_)) != pass {
                        continue;
                    }
                    let mut ws = words_of(r.name());
                    match r {
                        Row::Place(p) => {
                            ws.extend(kind_words(&p.kind));
                            for a in &p.aliases {
                                ws.extend(words_of(a));
                            }
                        }
                        Row::Thing(t) => ws.extend(kind_words(&t.kind)),
                    }
                    for w in ws {
                        add(w, *id);
                    }
                }
            }
            for v in s.words.values_mut() {
                // places first, each once
                let mut seen = BTreeSet::new();
                v.retain(|id| seen.insert(*id));
            }
            self.search = Some(s);
        }
        self.search
            .as_ref()
            .unwrap_or_else(|| unreachable!("built above"))
    }

    /// The rows the words name: each word of the query is a word of the row's name, aliases or kind, or the start of
    /// one. Places before things; at most `limit`. No ranking (R7's).
    pub fn find(&mut self, query: &str, limit: usize) -> Vec<Id> {
        let qs = words_of(query);
        if qs.is_empty() {
            return Vec::new();
        }
        let s = self.search();
        let mut sets: Vec<BTreeSet<Id>> = Vec::new();
        for q in &qs {
            let mut set = BTreeSet::new();
            for (_, ids) in s
                .words
                .range(q.clone()..)
                .take_while(|(w, _)| w.starts_with(q.as_str()))
            {
                set.extend(ids.iter().copied());
            }
            sets.push(set);
        }
        sets.sort_by_key(BTreeSet::len);
        let mut hits: BTreeSet<Id> = sets[0].clone();
        for s in &sets[1..] {
            hits.retain(|id| s.contains(id));
        }
        let (mut places, mut things): (Vec<Id>, Vec<Id>) = hits
            .into_iter()
            .partition(|id| matches!(self.rows.get(id), Some(Row::Place(_))));
        places.append(&mut things);
        places.truncate(limit);
        places
    }

    // --- Bytes --------------------------------------------------------------------------------------------------

    fn r(&self, id: Id) -> Value {
        if id.scope() == self.scope {
            Value::Uint(id.counter())
        } else {
            id.to_value()
        }
    }

    fn read_ref(&self, v: &Value) -> R<Id> {
        match v {
            Value::Uint(c) => match Id::new(self.scope, *c) {
                Some(id) => Ok(id),
                None => refuse("a counter out of range"),
            },
            v => read_id(v),
        }
    }

    fn opt(&self, id: Option<Id>) -> Value {
        id.map_or(Value::Array(Vec::new()), |id| self.r(id))
    }

    fn read_opt(&self, v: &Value) -> R<Option<Id>> {
        match v {
            Value::Array(a) if a.is_empty() => Ok(None),
            v => self.read_ref(v).map(Some),
        }
    }

    /// A row: `[id, name, kind, parent, outline (flat x, z, ...), aliases]` or `[id, name, kind, parent, place, x,
    /// z]`, the kind as its number in `kinds` or as bytes.
    fn row_value(&self, id: Id, r: &Row, kinds: Option<&BTreeMap<String, u64>>) -> Value {
        let text = |s: &str| Value::Bytes(s.as_bytes().to_vec());
        let kind = |k: &str| match kinds.and_then(|m| m.get(k)) {
            Some(n) => Value::Uint(*n),
            None => text(k),
        };
        match r {
            Row::Place(p) => Value::Array(vec![
                self.r(id),
                text(&p.name),
                kind(&p.kind),
                self.opt(p.parent),
                Value::Array(
                    p.outline
                        .iter()
                        .flat_map(|q| [sint(q[0]), sint(q[1])])
                        .collect(),
                ),
                Value::Array(p.aliases.iter().map(|a| text(a)).collect()),
            ]),
            Row::Thing(t) => Value::Array(vec![
                self.r(id),
                text(&t.name),
                kind(&t.kind),
                self.opt(t.parent),
                self.opt(t.place),
                sint(t.at[0]),
                sint(t.at[1]),
            ]),
        }
    }

    fn read_row(&self, v: &Value, kinds: &[String]) -> R<(Id, Row)> {
        let Value::Array(a) = v else {
            return refuse("a row is not a list");
        };
        let text = |v: &Value| match v {
            Value::Bytes(b) => String::from_utf8(b.clone()).or_else(|_| refuse("words not UTF-8")),
            _ => refuse("words not bytes"),
        };
        let kind = |v: &Value| match v {
            Value::Uint(n) => kinds
                .get(usize::try_from(*n).unwrap_or(usize::MAX))
                .cloned()
                .map_or_else(|| refuse("a kind number out of range"), Ok),
            v => text(v),
        };
        let num = |v: &Value| int(v).map_or_else(|| refuse("not a whole number"), Ok);
        match a.len() {
            6 => {
                let Value::Array(o) = &a[4] else {
                    return refuse("an outline is not a list");
                };
                let Value::Array(al) = &a[5] else {
                    return refuse("aliases are not a list");
                };
                let mut outline = Vec::new();
                for c in o.chunks(2) {
                    if c.len() == 2 {
                        outline.push([num(&c[0])?, num(&c[1])?]);
                    }
                }
                Ok((
                    self.read_ref(&a[0])?,
                    Row::Place(PlaceRow {
                        name: text(&a[1])?,
                        kind: kind(&a[2])?,
                        parent: self.read_opt(&a[3])?,
                        outline,
                        aliases: al.iter().map(text).collect::<R<_>>()?,
                    }),
                ))
            }
            7 => Ok((
                self.read_ref(&a[0])?,
                Row::Thing(ThingRow {
                    name: text(&a[1])?,
                    kind: kind(&a[2])?,
                    parent: self.read_opt(&a[3])?,
                    place: self.read_opt(&a[4])?,
                    at: [num(&a[5])?, num(&a[6])?],
                }),
            )),
            _ => refuse("a row of another length"),
        }
    }

    /// The whole index: `{1: scope, 2: [kind, ...], 3: [row, ...]}`, places then things, each in id order.
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let mut kinds: BTreeMap<String, u64> = BTreeMap::new();
        for r in self.rows.values() {
            let k = match r {
                Row::Place(p) => &p.kind,
                Row::Thing(t) => &t.kind,
            };
            let n = kinds.len() as u64;
            kinds.entry(k.clone()).or_insert(n);
        }
        let mut list: Vec<(&String, &u64)> = kinds.iter().collect();
        list.sort_by_key(|(_, n)| **n);
        let mut rows = Vec::new();
        for pass in [true, false] {
            for (id, r) in &self.rows {
                if matches!(r, Row::Place(_)) == pass {
                    rows.push(self.row_value(*id, r, Some(&kinds)));
                }
            }
        }
        encode(&Value::Map(
            [
                (1, Value::Bytes(self.scope.0.to_vec())),
                (
                    2,
                    Value::Array(
                        list.iter()
                            .map(|(k, _)| Value::Bytes(k.as_bytes().to_vec()))
                            .collect(),
                    ),
                ),
                (3, Value::Array(rows)),
            ]
            .into(),
        ))
        .or_else(|e| refuse(format!("{e:?}")))
    }

    /// The index a file holds.
    pub fn read(bytes: &[u8]) -> R<Index> {
        let Ok(d) = decode(bytes) else {
            return refuse("not a record");
        };
        let Value::Map(m) = d.value else {
            return refuse("not a map");
        };
        let scope = match m.get(&1) {
            Some(Value::Bytes(b)) if b.len() == 16 => {
                let mut s = [0u8; 16];
                s.copy_from_slice(b);
                Scope(s)
            }
            _ => return refuse("no scope"),
        };
        let mut ix = Index::new(scope);
        let kinds: Vec<String> = match m.get(&2) {
            Some(Value::Array(a)) => a
                .iter()
                .map(|v| match v {
                    Value::Bytes(b) => String::from_utf8(b.clone()).or_else(|_| refuse("a kind")),
                    _ => refuse("a kind is not bytes"),
                })
                .collect::<R<_>>()?,
            _ => return refuse("no kinds"),
        };
        let Some(Value::Array(rows)) = m.get(&3) else {
            return refuse("no rows");
        };
        for v in rows {
            let (id, row) = ix.read_row(v, &kinds)?;
            ix.rows.insert(id, row);
        }
        ix.rebuild_areas();
        Ok(ix)
    }

    /// Changes as a list: `[1, row]` create, `[2, id]` remove, `[3, id, name]` rename, `[4, id, parent]`,
    /// `[5, id, place]`.
    pub fn changes_value(&self, changes: &[Change]) -> Value {
        Value::Array(
            changes
                .iter()
                .map(|c| {
                    Value::Array(match c {
                        Change::Create(id, row) => {
                            vec![Value::Uint(1), self.row_value(*id, row, None)]
                        }
                        Change::Remove(id) => vec![Value::Uint(2), self.r(*id)],
                        Change::Rename(id, n) => vec![
                            Value::Uint(3),
                            self.r(*id),
                            Value::Bytes(n.as_bytes().to_vec()),
                        ],
                        Change::Parent(id, p) => vec![Value::Uint(4), self.r(*id), self.opt(*p)],
                        Change::Place(id, p) => vec![Value::Uint(5), self.r(*id), self.opt(*p)],
                    })
                })
                .collect(),
        )
    }

    pub fn read_changes(&self, v: &Value) -> R<Vec<Change>> {
        let Value::Array(list) = v else {
            return refuse("changes are not a list");
        };
        list.iter()
            .map(|c| {
                let Value::Array(a) = c else {
                    return refuse("a change is not a list");
                };
                let id = |k: usize| {
                    a.get(k)
                        .map_or_else(|| refuse("short"), |v| self.read_ref(v))
                };
                let opt = |k: usize| {
                    a.get(k)
                        .map_or_else(|| refuse("short"), |v| self.read_opt(v))
                };
                match a.first() {
                    Some(Value::Uint(1)) => {
                        let (i, row) = self.read_row(a.get(1).unwrap_or(&Value::Uint(0)), &[])?;
                        Ok(Change::Create(i, row))
                    }
                    Some(Value::Uint(2)) => Ok(Change::Remove(id(1)?)),
                    Some(Value::Uint(3)) => match a.get(2) {
                        Some(Value::Bytes(b)) => Ok(Change::Rename(
                            id(1)?,
                            String::from_utf8(b.clone()).or_else(|_| refuse("words"))?,
                        )),
                        _ => refuse("a rename's words"),
                    },
                    Some(Value::Uint(4)) => Ok(Change::Parent(id(1)?, opt(2)?)),
                    Some(Value::Uint(5)) => Ok(Change::Place(id(1)?, opt(2)?)),
                    _ => refuse("a change of no kind"),
                }
            })
            .collect()
    }
}

// --- The Soul list (rule 5) ---------------------------------------------------------------------------------------

/// Where a Soul is: its body's node and named place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spot {
    pub node: Id,
    pub place: Option<Id>,
}

/// Each Soul to its number, body and spot.
#[derive(Clone, Debug, Default)]
pub struct Souls {
    by_soul: BTreeMap<Id, (u64, Id, Spot)>,
    by_body: BTreeMap<Id, Id>,
    numbers: BTreeMap<u64, Id>,
    next: u64,
}

/// What changed in the Soul list: new Souls `(n, soul)`, moves `(n, spot)`, Souls gone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SoulChanges {
    pub new: Vec<(u64, Id)>,
    pub moved: Vec<(u64, Spot)>,
    pub gone: Vec<u64>,
}

impl SoulChanges {
    pub fn is_empty(&self) -> bool {
        self.new.is_empty() && self.moved.is_empty() && self.gone.is_empty()
    }

    /// Folds `later` in: a Soul's last spot wins.
    pub fn merge(&mut self, later: SoulChanges) {
        self.new.extend(later.new);
        for (n, s) in later.moved {
            match self.moved.iter_mut().find(|(m, _)| *m == n) {
                Some(e) => e.1 = s,
                None => self.moved.push((n, s)),
            }
        }
        for n in later.gone {
            self.moved.retain(|(m, _)| *m != n);
            self.gone.push(n);
        }
    }

    /// `{1: [[n, soul], ...], 2: [[n, node, place?], ...], 3: [n, ...]}`, ids as the index writes them.
    pub fn to_value(&self, ix: &Index) -> Value {
        let mut m = BTreeMap::new();
        if !self.new.is_empty() {
            m.insert(
                1,
                Value::Array(
                    self.new
                        .iter()
                        .map(|(n, s)| Value::Array(vec![Value::Uint(*n), s.to_value()]))
                        .collect(),
                ),
            );
        }
        if !self.moved.is_empty() {
            m.insert(
                2,
                Value::Array(
                    self.moved
                        .iter()
                        .map(|(n, s)| {
                            let mut v = vec![Value::Uint(*n), ix.r(s.node)];
                            v.extend(s.place.map(|p| ix.r(p)));
                            Value::Array(v)
                        })
                        .collect(),
                ),
            );
        }
        if !self.gone.is_empty() {
            m.insert(
                3,
                Value::Array(self.gone.iter().map(|n| Value::Uint(*n)).collect()),
            );
        }
        Value::Map(m)
    }

    pub fn read(v: &Value, ix: &Index) -> R<SoulChanges> {
        let Value::Map(m) = v else {
            return refuse("soul changes are not a map");
        };
        let list = |k: u64| match m.get(&k) {
            Some(Value::Array(a)) => a.as_slice(),
            _ => &[],
        };
        let n = |v: &Value| match v {
            Value::Uint(n) => Ok(*n),
            _ => refuse("a Soul's number"),
        };
        let mut out = SoulChanges::default();
        for e in list(1) {
            let Value::Array(a) = e else {
                return refuse("a new Soul");
            };
            if a.len() != 2 {
                return refuse("a new Soul");
            }
            out.new.push((n(&a[0])?, read_id(&a[1])?));
        }
        for e in list(2) {
            let Value::Array(a) = e else {
                return refuse("a move");
            };
            if a.len() < 2 {
                return refuse("a move");
            }
            let place = match a.get(2) {
                Some(p) => Some(ix.read_ref(p)?),
                None => None,
            };
            out.moved.push((
                n(&a[0])?,
                Spot {
                    node: ix.read_ref(&a[1])?,
                    place,
                },
            ));
        }
        for e in list(3) {
            out.gone.push(n(e)?);
        }
        Ok(out)
    }
}

impl Souls {
    /// Where `soul` is, if listed.
    pub fn spot(&self, soul: Id) -> Option<Spot> {
        self.by_soul.get(&soul).map(|(_, _, s)| *s)
    }

    pub fn len(&self) -> usize {
        self.by_soul.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_soul.is_empty()
    }

    /// The Soul a body belongs to, if listed.
    pub fn soul_of(&self, body: Id) -> Option<Id> {
        self.by_body.get(&body).copied()
    }

    /// Re-reads the public `souls:body-of` links of `state`: Souls new and gone, and every listed body's spot.
    pub fn relink(&mut self, state: &State, ix: &Index) -> SoulChanges {
        let mut now: BTreeMap<Id, Id> = BTreeMap::new();
        for l in state.links.values() {
            if l.audience != Audience::Everyone || plain(l.ty.as_str()) != "souls:body-of" {
                continue;
            }
            let [a, b] = l.ends;
            let (body, soul) = if state.nodes.contains_key(&a) {
                (a, b)
            } else {
                (b, a)
            };
            if state
                .nodes
                .get(&body)
                .is_some_and(|n| n.audience == Audience::Everyone)
            {
                now.insert(soul, body);
            }
        }
        let mut out = SoulChanges::default();
        let gone: Vec<Id> = self
            .by_soul
            .keys()
            .filter(|s| !now.contains_key(s))
            .copied()
            .collect();
        for s in gone {
            if let Some((n, body, _)) = self.by_soul.remove(&s) {
                self.by_body.remove(&body);
                self.numbers.remove(&n);
                out.gone.push(n);
            }
        }
        for (soul, body) in &now {
            if self.by_soul.get(soul).is_some_and(|(_, b, _)| b == body) {
                continue;
            }
            let Some(node) = state.nodes.get(body).and_then(|n| n.parent) else {
                continue;
            };
            let spot = Spot {
                node,
                place: ix.place_of(state, *body),
            };
            let n = match self.by_soul.get(soul) {
                Some((n, old, _)) => {
                    self.by_body.remove(old);
                    *n
                }
                None => {
                    let n = self.next;
                    self.next += 1;
                    out.new.push((n, *soul));
                    n
                }
            };
            self.by_soul.insert(*soul, (n, *body, spot));
            self.by_body.insert(*body, *soul);
            self.numbers.insert(n, *soul);
            out.moved.push((n, spot));
        }
        out
    }

    /// Re-reads the spots of these bodies (moved or touched this tick); gives those that changed.
    pub fn moved(&mut self, state: &State, ix: &Index, bodies: &BTreeSet<Id>) -> SoulChanges {
        let mut out = SoulChanges::default();
        for body in bodies {
            let Some(soul) = self.by_body.get(body).copied() else {
                continue;
            };
            let Some(node) = state.nodes.get(body).and_then(|n| n.parent) else {
                continue;
            };
            let spot = Spot {
                node,
                place: ix.place_of(state, *body),
            };
            if let Some(e) = self.by_soul.get_mut(&soul)
                && e.2 != spot
            {
                e.2 = spot;
                out.moved.push((e.0, spot));
            }
        }
        out
    }

    /// The whole list as changes from empty (a subscriber's start).
    pub fn snapshot(&self) -> SoulChanges {
        let mut out = SoulChanges::default();
        for (soul, (n, _, spot)) in &self.by_soul {
            out.new.push((*n, *soul));
            out.moved.push((*n, *spot));
        }
        out
    }

    /// Applies changes (a copy's side).
    pub fn apply(&mut self, c: &SoulChanges) {
        for (n, soul) in &c.new {
            self.numbers.insert(*n, *soul);
            self.next = self.next.max(n + 1);
        }
        for (n, spot) in &c.moved {
            if let Some(soul) = self.numbers.get(n).copied() {
                let body = self.by_soul.get(&soul).map_or(soul, |e| e.1);
                self.by_soul.insert(soul, (*n, body, *spot));
            }
        }
        for n in &c.gone {
            if let Some(soul) = self.numbers.remove(n) {
                self.by_soul.remove(&soul);
            }
        }
    }
}
