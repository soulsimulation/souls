//! Views (contract T7; Engine v2 T7, #2661): the log is the archive, and every view of it is a function of three
//! inputs only: the log, the redaction list and the view's own version. The rules are numbered in
//! `v2/docs/views.md`.
//!
//! This is the views' reference definition, run on the fixtures through T6's harness ([`State`]). The tier that
//! computes views for real (R3) reads K2's tree and must give the same bytes on these fixtures. No runtime, no
//! subscription transport (R4), no files (V1).

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

use crate::effects::{
    Body, Change, Effect, Flight, Header, LinkState, NodeState, Part, Refusal, State, TransferRec,
    read_id, read_pose,
};
use crate::encode::{Value, encode};
use crate::ids::{Hash, Id, Purpose};
use crate::pose::{Owner, Pose, Vec3};
use crate::time::Micros;
use crate::world_model::Audience;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn bytes_of(v: &Value) -> R<Vec<u8>> {
    encode(v).or_else(|e| refuse("encoding", e.to_string()))
}

fn len(b: &[u8]) -> u64 {
    u64::try_from(b.len()).unwrap_or(u64::MAX)
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn map(pairs: Vec<(u64, Value)>) -> Value {
    Value::Map(pairs.into_iter().collect())
}

// --- Levels -------------------------------------------------------------------------------------------------------

/// A level of detail (rule 3). Its number never changes; a level added later takes the next unused number and its
/// place in [`ORDER`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    /// 1: every entry the audience may see, as stored.
    Full,
    /// 2: as full, with a moving node's samples thinned to one per [`SAMPLE_US`] of world time; a sample that starts,
    ///    stops or hands off motion is always kept.
    Sampled,
    /// 3: the outline, which a world-wide index (E1) also uses: what was created (its id, kind and parent), removed,
    ///    left or arrived. No fields, no motion, no events.
    Outline,
    /// 4: counts, at most one record of at most [`COUNTS_RECORD_MOST`] bytes per world second. The lowest level.
    Counts,
}

/// The levels, most detail first. A server lowers a subscription by walking down this list.
pub const ORDER: [Level; 4] = [Level::Full, Level::Sampled, Level::Outline, Level::Counts];

/// The views' revision: raised whenever what any level keeps, or how it writes a record, changes. 2: a carried
/// record names where its subtree lands (the flight's pose, #3248).
pub const REVISION: u64 = 2;

/// How far apart, in world time, the samples `Sampled` keeps of one moving node are.
pub const SAMPLE_US: Micros = 1_000_000;

/// The most bytes one counts record takes: a map of three entries, each a one-byte key and an integer of at most nine
/// bytes.
pub const COUNTS_RECORD_MOST: u64 = 1 + 3 * (1 + 9);

/// The least budget, in bytes per world second, a subscription may ask for: what the lowest level can need.
pub const MIN_BUDGET: u64 = COUNTS_RECORD_MOST;

impl Level {
    pub fn number(self) -> u64 {
        match self {
            Level::Full => 1,
            Level::Sampled => 2,
            Level::Outline => 3,
            Level::Counts => 4,
        }
    }

    pub fn from_number(n: u64) -> R<Level> {
        match ORDER.iter().find(|l| l.number() == n) {
            Some(l) => Ok(*l),
            None => refuse("level-unknown", format!("level {n}")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Level::Full => "souls:full",
            Level::Sampled => "souls:sampled",
            Level::Outline => "souls:outline",
            Level::Counts => "souls:counts",
        }
    }

    /// The next level down, or none below counts.
    pub fn lower(self) -> Option<Level> {
        let i = ORDER.iter().position(|l| *l == self)?;
        ORDER.get(i + 1).copied()
    }

    /// The view's version (rule 2): `souls/view/1` over `{1: level, 2: name, 3: revision, 4: sample spacing}`. A
    /// change to what a level keeps or how it writes a record raises its revision, and so its version.
    pub fn version(self) -> Hash {
        let mut m = vec![
            (1, Value::Uint(self.number())),
            (2, name(self.name())),
            (3, Value::Uint(REVISION)),
        ];
        if self == Level::Sampled {
            m.push((4, int(SAMPLE_US)));
        }
        let bytes = encode(&map(m)).unwrap_or_else(|_| unreachable!("a version is shallow"));
        Hash::of(Purpose::View, &bytes)
    }
}

fn name(text: &str) -> Value {
    Value::Text(
        crate::encode::Name::new(text).unwrap_or_else(|| unreachable!("a level's name is a name")),
    )
}

// --- Inputs: the redaction list and the log's position ------------------------------------------------------------

/// The redaction list (rule 2): the references whose words have been removed. A reference is T8's (`{21: id}`,
/// `v2/docs/audience.md`). The list only grows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Redactions(BTreeSet<Id>);

impl Redactions {
    pub fn new(refs: impl IntoIterator<Item = Id>) -> Redactions {
        Redactions(refs.into_iter().collect())
    }

    pub fn contains(&self, r: Id) -> bool {
        self.0.contains(&r)
    }

    /// `souls/redactions/1` over the references, in id order, as an array.
    pub fn hash(&self) -> Hash {
        let v = Value::Array(self.0.iter().map(|i| i.to_value()).collect());
        let bytes = encode(&v).unwrap_or_else(|_| unreachable!("a list of ids is shallow"));
        Hash::of(Purpose::Redactions, &bytes)
    }

    /// The references, in id order.
    pub fn iter(&self) -> impl Iterator<Item = Id> + '_ {
        self.0.iter().copied()
    }

    /// The record a view writes, with every reference on the list marked removed (T8, `v2/docs/audience.md`).
    pub fn scrub(&self, record: Value) -> Value {
        crate::audience::scrub(record, self)
    }
}

/// Where in the log a view stands (rule 2): the bundle's header, by hash (which names the lineage, the zone and the
/// writer's epoch), and the last sequence fed to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub header: Hash,
    pub sequence: Option<u64>,
}

// --- Keys, scopes and subscriptions -------------------------------------------------------------------------------

/// What a view is computed for, once (rule 4): a node (its subtree), a level and an audience. The audience is
/// everyone or one audience id; a viewer in an audience is sent the public view and that audience's view, merged by
/// sequence (rule 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub node: Id,
    pub level: Level,
    pub audience: Audience,
}

/// What a subscription covers (rule 6): some nodes, the whole world, or one named Soul (its body).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Nodes(Vec<Id>),
    World,
    Soul(Id),
}

impl Scope {
    /// The nodes whose views this scope is made of, in the state given: the world is its root, a Soul is the body
    /// linked to it by `souls:body-of` (plain or pinned), a node that is gone is left out, and so is a node under
    /// another node of the scope, whose view already holds it.
    pub fn nodes(&self, state: &State) -> Vec<Id> {
        let ids: Vec<Id> = match self {
            Scope::Nodes(ids) => ids
                .iter()
                .copied()
                .filter(|i| state.nodes.contains_key(i))
                .collect(),
            Scope::World => vec![state.root],
            Scope::Soul(soul) => state
                .links
                .values()
                .filter(|l| {
                    l.ty.as_str().split('@').next() == Some("souls:body-of") && l.ends[1] == *soul
                })
                .map(|l| l.ends[0])
                .collect(),
        };
        let mut out: Vec<Id> = Vec::new();
        for i in &ids {
            let held = ids.iter().any(|o| o != i && under(state, *i, *o));
            if !held && !out.contains(i) {
                out.push(*i);
            }
        }
        out
    }
}

/// A subscription (rule 6): a scope, the level asked for and a budget in bytes per world second. A client may hold
/// several.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub scope: Scope,
    pub level: Level,
    pub budget: u64,
}

/// What the server gives a subscription (rule 7): a level, and, when it is lower than the one asked for, the level
/// asked for. The client is told both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant {
    pub level: Level,
    pub asked: Level,
}

impl Grant {
    /// `{1: level}`, or `{1: level, 2: level asked, 3: "souls:over-budget"}` when it was lowered.
    pub fn to_value(self) -> Value {
        let mut m = vec![(1, Value::Uint(self.level.number()))];
        if self.level != self.asked {
            m.push((2, Value::Uint(self.asked.number())));
            m.push((3, name("souls:over-budget")));
        }
        map(m)
    }
}

/// The least budget a subscription may ask for (rule 7): [`MIN_BUDGET`] for each view it is sent, one per node of
/// its scope and audience (everyone, and each audience the viewer is in).
pub fn least(views: u64) -> u64 {
    MIN_BUDGET.saturating_mul(views)
}

/// Grants a subscription its level (rule 7): the highest level, from the one asked for down, whose busiest world
/// second (`peak`, over all the views the subscription is sent) fits the budget. `views` is how many views that is.
/// Counts fits every budget of at least [`least`]; a smaller budget is refused when asked for
/// (`budget-below-minimum`), never accepted and then dropped. `counts-over-bound` would mean a counts view broke its
/// bound: a fault in the view, never a dropped subscription.
pub fn grant(sub: &Subscription, views: u64, peak: impl Fn(Level) -> u64) -> R<Grant> {
    if sub.budget < least(views) {
        return refuse(
            "budget-below-minimum",
            format!(
                "{} bytes a second for {views} views; the least is {}",
                sub.budget,
                least(views)
            ),
        );
    }
    let mut level = sub.level;
    while peak(level) > sub.budget {
        match level.lower() {
            Some(l) => level = l,
            None => {
                return refuse(
                    "counts-over-bound",
                    format!("counts took {} bytes in a second", peak(level)),
                );
            }
        }
    }
    Ok(Grant {
        level,
        asked: sub.level,
    })
}

/// The busiest world second, in bytes of records, of views sent together (rule 7).
pub fn peak(outputs: &[Output]) -> R<u64> {
    let mut per: BTreeMap<i64, u64> = BTreeMap::new();
    for (at, r) in outputs.iter().flat_map(|o| &o.records) {
        *per.entry(at.div_euclid(1_000_000)).or_default() += len(&bytes_of(r)?);
    }
    Ok(per.values().copied().max().unwrap_or(0))
}

// --- A view -------------------------------------------------------------------------------------------------------

/// A view's output (rule 2): what it was built from, and its records, each with the world time of the entry that
/// made it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    pub key: Key,
    pub position: Position,
    pub redactions: Hash,
    pub version: Hash,
    pub records: Vec<(Micros, Value)>,
}

impl Output {
    /// `{1: node, 2: level, 3: audience, 4: header hash, 5: last sequence, 6: redaction list hash, 7: version,
    /// 8: [record, ...]}`; 5 is left out before the first entry.
    pub fn to_value(&self) -> Value {
        let mut m = vec![
            (1, self.key.node.to_value()),
            (2, Value::Uint(self.key.level.number())),
            (3, audience(self.key.audience)),
            (4, self.position.header.to_value()),
            (6, self.redactions.to_value()),
            (7, self.version.to_value()),
            (
                8,
                Value::Array(self.records.iter().map(|(_, r)| r.clone()).collect()),
            ),
        ];
        if let Some(s) = self.position.sequence {
            m.push((5, Value::Uint(s)));
        }
        map(m)
    }

    pub fn bytes(&self) -> R<Vec<u8>> {
        bytes_of(&self.to_value())
    }

    /// The most bytes of records this view gave in any one world second (rule 7).
    pub fn peak(&self) -> R<u64> {
        peak(std::slice::from_ref(self))
    }
}

fn audience(a: Audience) -> Value {
    match a {
        Audience::Everyone => map(vec![(1, Value::Uint(1))]),
        Audience::Of(id) => map(vec![(1, Value::Uint(2)), (2, id.to_value())]),
    }
}

/// One view as it is built (rules 2 to 5): fed every entry of the log in order with the state just before and just
/// after it, it keeps what its key may see.
#[derive(Clone, Debug)]
pub struct View {
    key: Key,
    out: Output,
    kept: BTreeMap<Id, Micros>,
    second: Option<Second>,
    left: BTreeSet<Id>,
}

/// The world second a counts view is in: its number, the entries seen in it, the nodes alive after the last of them
/// and that entry's world time.
#[derive(Clone, Copy, Debug)]
struct Second {
    second: i64,
    entries: u64,
    live: u64,
    at: Micros,
}

impl Second {
    /// `{1: world second, 2: nodes alive in the view, 3: entries seen in that second}`.
    fn record(self) -> (Micros, Value) {
        let m = vec![
            (1, int(self.second)),
            (2, Value::Uint(self.live)),
            (3, Value::Uint(self.entries)),
        ];
        (self.at, map(m))
    }
}

/// What a view reads of the state just before or just after an entry (rule 4): a node's parent, one transfer in
/// flight and, for counts, the nodes alive. T6's [`State`] and K2's [`Tree`](crate::tree::Tree) both answer it, so a
/// tier that keeps a tree builds no whole state per entry (#3667).
pub trait Read {
    /// The node's parent: none when the node is not here, `Some(None)` for a node with no parent.
    fn parent_of(&self, node: Id) -> Option<Option<Id>>;
    /// A transfer in flight from here, in T6's state layout.
    fn flight(&self, transfer: Id) -> Option<Cow<'_, Flight>>;
    /// How many nodes here are of `audience` and are `top` or under it.
    fn live(&self, audience: Audience, top: Id) -> u64;
}

impl Read for State {
    fn parent_of(&self, node: Id) -> Option<Option<Id>> {
        self.nodes.get(&node).map(|n| n.parent)
    }

    fn flight(&self, transfer: Id) -> Option<Cow<'_, Flight>> {
        self.in_flight.get(&transfer).map(Cow::Borrowed)
    }

    fn live(&self, audience: Audience, top: Id) -> u64 {
        let n = self
            .nodes
            .iter()
            .filter(|(id, n)| n.audience == audience && under(self, **id, top))
            .count();
        u64::try_from(n).unwrap_or(u64::MAX)
    }
}

impl Read for crate::tree::Tree {
    fn parent_of(&self, node: Id) -> Option<Option<Id>> {
        self.handle(node)
            .and_then(|h| self.node(h))
            .map(|n| n.parent())
    }

    fn flight(&self, transfer: Id) -> Option<Cow<'_, Flight>> {
        crate::tree::Tree::flight(self, transfer).map(Cow::Owned)
    }

    fn live(&self, audience: Audience, top: Id) -> u64 {
        let mut count = 0u64;
        let mut stack: Vec<_> = self.handle(top).into_iter().collect();
        while let Some(h) = stack.pop() {
            if self.node(h).is_some_and(|n| n.audience() == audience) {
                count += 1;
            }
            stack.extend(self.children(h).unwrap_or(&[]).iter().copied());
        }
        count
    }
}

/// Whether `node` is `top` or under it, in `state`. The walk is a loop of at most T2's depth.
fn under(state: &(impl Read + ?Sized), node: Id, top: Id) -> bool {
    let mut at = Some(node);
    for _ in 0..=crate::world_model::DEPTH_LIMIT {
        match at {
            Some(n) if n == top => return true,
            Some(n) => at = state.parent_of(n).flatten(),
            None => return false,
        }
    }
    false
}

fn zero(v: Vec3) -> bool {
    v.x == 0 && v.y == 0 && v.z == 0
}

impl View {
    pub fn new(key: Key, header: &Header, redactions: &Redactions) -> View {
        View {
            key,
            out: Output {
                key,
                position: Position {
                    header: header.hash(),
                    sequence: None,
                },
                redactions: redactions.hash(),
                version: key.level.version(),
                records: Vec::new(),
            },
            kept: BTreeMap::new(),
            second: None,
            left: BTreeSet::new(),
        }
    }

    /// Feeds one entry (rule 4). It is seen when its audience is the view's, and its node was the view's node or under
    /// it just before the entry, or a node it creates or brings in is under it just after. Every entry moves the
    /// view's position, seen or not.
    pub fn step(
        &mut self,
        before: &(impl Read + ?Sized),
        entry: &Effect,
        after: &(impl Read + ?Sized),
        redactions: &Redactions,
    ) -> R<()> {
        let env = entry.envelope;
        self.out.position.sequence = Some(env.sequence);
        let brought = brought(entry, before);
        let seen = under(before, env.node, self.key.node)
            || brought.iter().any(|n| under(after, *n, self.key.node));
        let seq = Value::Uint(env.sequence);
        if !seen {
            return Ok(());
        }
        if env.audience != self.key.audience {
            // An arrival of another audience may carry this audience's nodes (a private note in a public box).
            if let (
                Level::Full | Level::Sampled,
                Body::Transfer(TransferRec::Arrive { transfer, .. }),
            ) = (self.key.level, &entry.body)
                && let Some(r) = before
                    .flight(*transfer)
                    .and_then(|f| carried(&seq, &f, self.key.audience))
            {
                self.out.records.push((env.at, redactions.scrub(r)));
            }
            return Ok(());
        }
        match self.key.level {
            Level::Full | Level::Sampled => {
                if self.key.level == Level::Full || self.keep_sample(entry) {
                    match &entry.body {
                        Body::Transfer(TransferRec::Leave { transfer, .. }) => {
                            self.left.insert(*transfer);
                        }
                        Body::Transfer(
                            TransferRec::Settle { transfer } | TransferRec::Return { transfer, .. },
                        ) => {
                            self.left.remove(transfer);
                        }
                        Body::Transfer(TransferRec::Arrive { transfer, .. })
                            if !self.left.remove(transfer) =>
                        {
                            if let Some(r) = before
                                .flight(*transfer)
                                .and_then(|f| carried(&seq, &f, self.key.audience))
                            {
                                self.out.records.push((env.at, redactions.scrub(r)));
                            }
                        }
                        _ => {}
                    }
                    self.out
                        .records
                        .push((env.at, redactions.scrub(entry.to_value())));
                }
            }
            Level::Outline => {
                let mine = |r: &Vec<(u64, Value)>| {
                    let gone = matches!(r.first(), Some((2, Value::Uint(2 | 3))));
                    let node = r.iter().find(|(k, _)| *k == 3).map(|(_, v)| v);
                    let Some(id) = node.and_then(|v| read_id(v).ok()) else {
                        return false;
                    };
                    let top = self.key.node;
                    if gone {
                        before.parent_of(id).is_some() && under(before, id, top)
                    } else {
                        after.parent_of(id).is_some() && under(after, id, top)
                    }
                };
                for r in outline(entry, before, after).into_iter().filter(mine) {
                    let mut m = vec![(1, seq.clone())];
                    m.extend(r);
                    self.out.records.push((env.at, redactions.scrub(map(m))));
                }
            }
            Level::Counts => {
                let sec = env.at.div_euclid(1_000_000);
                let live = after.live(self.key.audience, self.key.node);
                let entries = match self.second {
                    Some(s) if s.second == sec => s.entries + 1,
                    _ => {
                        self.out.records.extend(self.second.map(Second::record));
                        1
                    }
                };
                self.second = Some(Second {
                    second: sec,
                    entries,
                    live,
                    at: env.at,
                });
            }
        }
        Ok(())
    }

    /// Whether `Sampled` keeps this entry: always, unless every change in it is a sample of motion that neither starts,
    /// stops nor hands off, of a node whose last kept sample is less than [`SAMPLE_US`] earlier.
    fn keep_sample(&mut self, entry: &Effect) -> bool {
        let Body::Changes(changes) = &entry.body else {
            return true;
        };
        let at = entry.envelope.at;
        let mut thin = !changes.is_empty();
        for c in changes {
            match &c.change {
                Change::Motion(h) => {
                    let steady = h.from == h.to
                        && h.from == Owner::Mover
                        && !zero(h.linear)
                        && self.kept.contains_key(&h.node);
                    let recent = self.kept.get(&h.node).is_some_and(|k| at - k < SAMPLE_US);
                    thin &= steady && recent;
                }
                _ => thin = false,
            }
        }
        if thin {
            return false;
        }
        for c in changes {
            if let Change::Motion(h) = &c.change {
                if zero(h.linear) || h.to != Owner::Mover {
                    self.kept.remove(&h.node);
                } else {
                    self.kept.insert(h.node, at);
                }
            }
        }
        true
    }

    /// Takes the records written since the last take, oldest first; a counts view's open second stays (R3's tier sends
    /// each record once, #2697).
    pub fn take(&mut self) -> Vec<(Micros, Value)> {
        std::mem::take(&mut self.out.records)
    }

    /// The view so far (rule 2). A counts view's current second is its last record until a later second closes it.
    pub fn output(&self) -> Output {
        let mut out = self.out.clone();
        out.records.extend(self.second.map(Second::record));
        out
    }
}

/// The record a `full` or `sampled` view writes before an arrival whose leave it did not hold (rule 4): `{0: {1:
/// sequence, 2: [[id, node], ...], 3: [[id, link], ...], 4: pose}}` (field 0, which no entry has), the subtree as it
/// was in flight, in T6's state layout, and where it lands: the flight's pose, whose frame is the new parent and slot
/// (from revision 2). It holds only the nodes of the view's audience, and the links of that audience whose ends in the
/// flight are seen by it (T2 rule 9); none, when the flight holds nothing of that audience.
fn carried(seq: &Value, f: &crate::effects::Flight, aud: Audience) -> Option<Value> {
    let sees = |a: Audience| a == Audience::Everyone || a == aud;
    let pairs = |m: Vec<(Id, Value)>| {
        Value::Array(
            m.into_iter()
                .map(|(i, v)| Value::Array(vec![i.to_value(), v]))
                .collect(),
        )
    };
    let nodes: Vec<(Id, Value)> = f
        .nodes
        .iter()
        .filter(|(_, n)| n.audience == aud)
        .map(|(i, n)| {
            let mut m = vec![
                (1, Value::Text(n.kind.clone())),
                (4, audience(n.audience)),
                (5, Value::Map(n.fields.clone())),
            ];
            m.extend(n.parent.map(|p| (2, p.to_value())));
            m.extend(n.slot.map(|x| (3, Value::Uint(x))));
            m.extend(n.place.clone().map(|x| (6, x)));
            m.extend(n.motion.clone().map(|x| (7, x)));
            (*i, map(m))
        })
        .collect();
    if nodes.is_empty() {
        return None;
    }
    let links = f
        .links
        .iter()
        .filter(|(_, l)| {
            l.audience == aud
                && l.ends
                    .iter()
                    .all(|e| f.nodes.get(e).is_none_or(|n| sees(n.audience)))
        })
        .map(|(i, l)| {
            let m = vec![
                (1, Value::Text(l.ty.clone())),
                (
                    2,
                    Value::Array(vec![l.ends[0].to_value(), l.ends[1].to_value()]),
                ),
                (
                    3,
                    Value::Uint(u64::from(l.owner == crate::world_model::End::Second)),
                ),
                (4, audience(l.audience)),
            ];
            (*i, map(m))
        })
        .collect();
    let inner = map(vec![
        (1, seq.clone()),
        (2, pairs(nodes)),
        (3, pairs(links)),
        (4, f.pose.to_value()),
    ]);
    Some(map(vec![(0, inner)]))
}

/// A carried record read back (rule 4): the arrival's sequence, the subtree's nodes and links in T6's state layout,
/// and where it lands. A revision 1 record names no destination: its `pose` is none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Carried {
    pub sequence: u64,
    pub nodes: BTreeMap<Id, NodeState>,
    pub links: BTreeMap<Id, LinkState>,
    pub pose: Option<Pose>,
}

impl Carried {
    /// A view's record as a carried record, or none when it is an entry (it has no field 0).
    pub fn read(record: &Value) -> R<Option<Carried>> {
        let Value::Map(m) = record else {
            return refuse("not-a-record", "a view's record is a map");
        };
        let Some(c) = m.get(&0) else {
            return Ok(None);
        };
        let Value::Map(c) = c else {
            return refuse("not-a-record", "a carried record is a map");
        };
        let pairs = |k: u64| -> R<Vec<(Id, &Value)>> {
            let Some(Value::Array(a)) = c.get(&k) else {
                return refuse("not-a-record", format!("a carried record lacks field {k}"));
            };
            a.iter()
                .map(|p| match p {
                    Value::Array(p) if p.len() == 2 => Ok((read_id(&p[0])?, &p[1])),
                    _ => refuse("not-a-record", "a carried pair is [id, value]"),
                })
                .collect()
        };
        let Some(Value::Uint(sequence)) = c.get(&1) else {
            return refuse("not-a-record", "a carried record lacks its sequence");
        };
        Ok(Some(Carried {
            sequence: *sequence,
            nodes: pairs(2)?
                .into_iter()
                .map(|(i, v)| Ok((i, NodeState::read(v)?)))
                .collect::<R<_>>()?,
            links: pairs(3)?
                .into_iter()
                .map(|(i, v)| Ok((i, LinkState::read(v)?)))
                .collect::<R<_>>()?,
            pose: c.get(&4).map(read_pose).transpose()?,
        }))
    }

    /// The flight it describes, landing in `header`'s zone: its root is the one node whose parent is not in it. A
    /// revision 1 record, which names no destination, is refused as `carried-no-destination`.
    pub fn flight(&self, header: &Header) -> R<Flight> {
        let Some(pose) = self.pose else {
            return refuse(
                "carried-no-destination",
                format!("the carried record of entry {} (revision 1)", self.sequence),
            );
        };
        let roots: Vec<Id> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.parent.is_none_or(|p| !self.nodes.contains_key(&p)))
            .map(|(i, _)| *i)
            .collect();
        let [root] = roots.as_slice() else {
            return refuse(
                "carried-root",
                format!(
                    "the carried record of entry {} has {} roots",
                    self.sequence,
                    roots.len()
                ),
            );
        };
        Ok(Flight {
            root: *root,
            lineage: header.lineage,
            zone: header.zone,
            pose,
            nodes: self.nodes.clone(),
            links: self.links.clone(),
        })
    }
}

/// The nodes an entry creates or brings in (rule 4): its creates, the root of a subtree that arrives from this zone,
/// and the creates an arrive from another zone carries.
fn brought(entry: &Effect, before: &(impl Read + ?Sized)) -> Vec<Id> {
    let creates = |cs: &[crate::effects::ChangeRec]| -> Vec<Id> {
        cs.iter()
            .filter_map(|c| match &c.change {
                Change::Create { node, .. } => Some(*node),
                _ => None,
            })
            .collect()
    };
    match &entry.body {
        Body::Changes(cs) => creates(cs),
        Body::Transfer(TransferRec::Arrive { transfer, carried }) => {
            let mut out = creates(carried);
            out.extend(before.flight(*transfer).map(|f| f.root));
            out
        }
        _ => Vec::new(),
    }
}

fn created(
    node: Id,
    kind: &crate::encode::Name,
    after: &(impl Read + ?Sized),
) -> Vec<(u64, Value)> {
    let mut r = vec![
        (2, Value::Uint(1)),
        (3, node.to_value()),
        (4, Value::Text(kind.clone())),
    ];
    r.extend(after.parent_of(node).flatten().map(|p| (5, p.to_value())));
    r
}

/// An entry's outline records (rule 3): `{2: 1 created, 3: node, 4: kind, 5: parent}`, `{2: 2 removed, 3: node}`,
/// `{2: 3 left, 3: node}`, `{2: 4 arrived, 3: node, 5: parent}` and `{2: 5 back, 3: node}` (a return). An arrive
/// from another zone also writes each node it carries as created. A change of slot under one parent is not in it.
fn outline(
    entry: &Effect,
    before: &(impl Read + ?Sized),
    after: &(impl Read + ?Sized),
) -> Vec<Vec<(u64, Value)>> {
    let creates = |cs: &[crate::effects::ChangeRec]| -> Vec<Vec<(u64, Value)>> {
        cs.iter()
            .filter_map(|c| match &c.change {
                Change::Create { node, kind, .. } => Some(created(*node, kind, after)),
                Change::Remove { node } => Some(vec![(2, Value::Uint(2)), (3, node.to_value())]),
                _ => None,
            })
            .collect()
    };
    let root = |t: &Id| before.flight(*t).map(|f| f.root);
    match &entry.body {
        Body::Changes(cs) => creates(cs),
        Body::Transfer(TransferRec::Leave { node, .. }) => {
            vec![vec![(2, Value::Uint(3)), (3, node.to_value())]]
        }
        Body::Transfer(TransferRec::Arrive { transfer, carried }) => {
            let mut out = creates(carried);
            if let Some(n) = root(transfer) {
                let mut r = vec![(2, Value::Uint(4)), (3, n.to_value())];
                r.extend(after.parent_of(n).flatten().map(|p| (5, p.to_value())));
                out.push(r);
            }
            out
        }
        Body::Transfer(TransferRec::Return { transfer, .. }) => root(transfer)
            .map(|n| vec![(2, Value::Uint(5)), (3, n.to_value())])
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

// --- Building views -----------------------------------------------------------------------------------------------

/// One entry as a part of its own, as the live tier receives it: the same entry, in its own bytes, read again.
pub fn entry_part(header: &Header, entry: &Effect) -> R<Part> {
    let v = map(vec![
        (1, header.hash().to_value()),
        (2, Value::Array(vec![entry.to_value()])),
    ]);
    Part::read(&bytes_of(&v)?)
}

/// Builds every key's view in one pass over the log (rule 4): one walk of the entries, each fed to every view.
pub fn build(
    start: &State,
    header: &Header,
    parts: &[Part],
    keys: &[Key],
    redactions: &Redactions,
) -> R<Vec<Output>> {
    let mut views: Vec<View> = keys
        .iter()
        .map(|k| View::new(*k, header, redactions))
        .collect();
    let mut state = start.clone();
    for part in parts {
        for entry in &part.effects {
            let mut after = state.clone();
            after.apply(header, &entry_part(header, entry)?)?;
            for v in &mut views {
                v.step(&state, entry, &after, redactions)?;
            }
            state = after;
        }
    }
    Ok(views.iter().map(View::output).collect())
}
