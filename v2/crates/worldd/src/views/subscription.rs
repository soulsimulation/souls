//! Subscriptions (Engine v2 R4, #2698; `v2/docs/views.md` rules 6 and 7): a client holds a set of scopes, asks for
//! a level and declares a byte budget a world second. In a crowd it receives the bodies that matter to it in full and
//! the rest as counts by cell, and never more than its budget in any world second.
//!
//! 1. **A set of scopes, never one.** A scope is a node held for good ([`Scope::Node`]) or the room a body stands in
//!    ([`Scope::Follow`]). When the body changes room the new node is added (and its counts sent) before the old one
//!    is dropped, both named in the stream. E1's world-wide index and a scope of one named Soul join this set later.
//! 2. **The interest set is a fact of the world** (`interest.rs`): the same under any load and any budget. Only what
//!    is sent of it changes with the level: `full` every entry of a body in the set, on the tick it is read; `sampled`
//!    one entry a body a world second, and every one that is not a plain motion sample or hands motion off; `outline`
//!    who entered and left the set; `counts` nothing of it.
//! 3. **The rest of a scope's node** is sent once a world second: counts by cell at `full`, `sampled` and `outline`,
//!    the node's one count at `counts`. Each node's is encoded once for every subscriber. The counts by cell go as
//!    the cells that changed since the last world second ([`Kind::Changes`]); the whole table ([`Kind::Cells`]) only
//!    when the node is added, after a second whose counts were not sent (a resync), or when the grid's size changes
//!    (#3151). The grid is [`GRID`] times N16's cells.
//! 4. **The budget holds in every world second.** Each second the hub reckons what every level would have cost; at the
//!    second's end it grants the highest level, from the one asked for down, whose busiest second of the last
//!    [`WINDOW`] fits the budget (T7's [`grant`]), and names a change in the stream: `{1: level}`, or with `2: level
//!    asked, 3: "souls:over-budget"` when lowered. Within a second, detail that would pass the budget is not sent:
//!    the next second opens with a marked gap, `{1: 8, 2: second, 3: items not sent}`.
//! 5. **Addressed events have their own queue** ([`Hub::address`]: a receipt, an utterance to this Soul, from inside
//!    the set or from outside it, E13): sent first, never merged and never dropped. One that does not fit this second
//!    waits for the next. Grants, scope changes and gaps travel in the same queue. An utterance (`souls:said`, B11) is
//!    addressed by the hub itself from the log's part (#3231): its whole entry, to each subscription that follows one
//!    of the hearers the entry records, and to no other; nothing is worked out again.
//!
//! Every item is a map whose field 1 names it ([`Kind`]). The hub reads only the log's parts; the view tier's thread
//! runs it, never the clock thread.
//!
//! Not here: the socket and its request format (gatewayd), the world-wide index and finding a Soul (E1), speech and
//! who hears (B11's `sim::speech`, E13), words beside references (K16).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

use replica::effects::{Body, Change, Effect, Part, Refusal};
use replica::encode::{Value, encode};
use replica::ids::Id;
use replica::pose::Vec3;
use replica::speech::{SAID, Said};
use replica::views::{Grant, Level, ORDER, SAMPLE_US, Scope as ViewScope, Subscription, grant};

use super::interest::{Interest, Places, Table};

type R<T> = Result<T, Refusal>;

/// A tick's entries of each body, each encoded once, and whether `sampled` keeps it in any second.
type ByBody = BTreeMap<Id, Vec<(Arc<[u8]>, bool)>>;

/// The budget a client starts with, bytes a world second.
pub const START_BUDGET: u64 = 8_000;
/// How many world seconds a grant looks back over for the busiest.
pub const WINDOW: usize = 10;
/// How many times coarser than N16's cells the counts by cell are, by side: chosen by measured bytes (#3151, the
/// `subscription` bench's table of forms).
pub const GRID: i64 = 4;

fn fault(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

fn bytes_of(v: Value) -> R<Arc<[u8]>> {
    encode(&v)
        .map(Arc::from)
        .map_err(|e| fault("encoding", e.to_string()))
}

/// A signed integer as CBOR writes it.
fn int(n: i64) -> Value {
    if n >= 0 {
        Value::Uint(n as u64)
    } else {
        Value::Nint((-1 - n) as u64)
    }
}

fn map(pairs: Vec<(u64, Value)>) -> Value {
    Value::Map(pairs.into_iter().collect())
}

/// What a client holds a scope of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// A node, for as long as the subscription lasts.
    Node(Id),
    /// The room this body stands in, which moves with it; its interest set comes with it.
    Follow(Id),
}

/// What a client asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub scopes: Vec<Scope>,
    pub level: Level,
    pub budget: u64,
}

/// What an item of the stream is: its field 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// 1: a log entry of a body in the interest set, `{1: 1, 2: entry}`.
    Entry = 1,
    /// 2: who entered and left the set, `{1: 2, 2: [id, ...], 3: [id, ...]}`.
    Members = 2,
    /// 3: a node's bodies by cell, the whole table, `{1: 3, 2: node, 3: second, 4: [[i, j, bodies], ...], 5: cell
    /// size µm}`.
    Cells = 3,
    /// 4: a node's bodies, `{1: 4, 2: node, 3: second, 4: bodies}`.
    Count = 4,
    /// 5: the level granted, `{1: 5, 2: grant}` (T7's grant form).
    Grant = 5,
    /// 6: a node added to the scopes, `{1: 6, 2: node}`.
    Added = 6,
    /// 7: a node dropped from the scopes, `{1: 7, 2: node}`.
    Dropped = 7,
    /// 8: detail not sent in a second for the budget, `{1: 8, 2: second, 3: items}`.
    Gap = 8,
    /// 9: an event addressed to this subscriber, `{1: 9, 2: bytes}`.
    Addressed = 9,
    /// 10: the cells of a node whose count changed since the last world second, on the grid of the last whole table,
    /// `{1: 10, 2: node, 3: second, 4: [[i, j, bodies], ...]}` (0 bodies: the cell emptied).
    Changes = 10,
}

/// One item sent, and its bytes (shared with every subscriber sent the same).
#[derive(Clone, Debug)]
pub struct Out {
    pub kind: Kind,
    pub bytes: Arc<[u8]>,
}

/// What one subscription has been sent.
#[derive(Clone, Debug, Default)]
pub struct Stats {
    /// The most bytes sent in one world second.
    pub most: u64,
    /// World seconds closed.
    pub seconds: u64,
    /// Addressed events handed in, and sent.
    pub addressed_in: u64,
    pub addressed_out: u64,
    /// At `full`: entries of the set read, and of them sent on the tick they were read.
    pub due: u64,
    pub on_tick: u64,
    /// Detail items not sent for the budget, and the gaps that named them.
    pub dropped: u64,
    pub gaps: u64,
    /// Grants sent that lowered the level below the one asked for.
    pub lowered: u64,
}

fn rank(l: Level) -> usize {
    ORDER
        .iter()
        .position(|o| *o == l)
        .unwrap_or(ORDER.len() - 1)
}

struct Sub {
    scopes: Vec<Scope>,
    /// The nodes held now, in the order added.
    held: Vec<Id>,
    /// The node held for the followed body, if any.
    follow: Option<(Id, Id)>,
    asked: Level,
    budget: u64,
    grant: Grant,
    interest: Interest,
    /// The world second each body of the set was last sent at `sampled`.
    sampled: BTreeMap<Id, i64>,
    /// The held nodes whose whole table this subscriber has, kept up to date by every second's changes since.
    tables: BTreeSet<Id>,
    /// Counts by cell were not sent this second: every table is sent whole next second.
    resync: bool,
    urgent: VecDeque<Out>,
    out: Vec<Out>,
    spent: u64,
    /// What this second cost, or would have, at each level ([`ORDER`]), urgent items included.
    cost: [u64; 4],
    history: VecDeque<[u64; 4]>,
    dropped: u64,
    stats: Stats,
}

impl Sub {
    fn address(&mut self, bytes: &[u8]) -> R<()> {
        self.stats.addressed_in += 1;
        self.push_urgent(
            Kind::Addressed,
            map(vec![(1, Value::Uint(9)), (2, Value::Bytes(bytes.to_vec()))]),
        )
    }

    fn push_urgent(&mut self, kind: Kind, v: Value) -> R<()> {
        let bytes = bytes_of(v)?;
        self.urgent.push_back(Out { kind, bytes });
        Ok(())
    }

    fn add(&mut self, node: Id) -> R<()> {
        if !self.held.contains(&node) {
            self.held.push(node);
            self.push_urgent(
                Kind::Added,
                map(vec![(1, Value::Uint(6)), (2, node.to_value())]),
            )?;
        }
        Ok(())
    }

    fn drop_node(&mut self, node: Id) -> R<()> {
        let still = self.scopes.contains(&Scope::Node(node));
        if !still && let Some(i) = self.held.iter().position(|h| *h == node) {
            self.held.remove(i);
            self.tables.remove(&node);
            self.push_urgent(
                Kind::Dropped,
                map(vec![(1, Value::Uint(7)), (2, node.to_value())]),
            )?;
        }
        Ok(())
    }

    /// Sends what is queued and fits, urgent first; detail that does not fit is dropped and counted.
    fn send(&mut self, detail: Vec<Out>) {
        while let Some(o) = self.urgent.front() {
            let n = o.bytes.len() as u64;
            if self.spent + n > self.budget {
                break;
            }
            self.spent += n;
            self.cost.iter_mut().for_each(|c| *c += n);
            let o = self.urgent.pop_front().expect("a front");
            if o.kind == Kind::Addressed {
                self.stats.addressed_out += 1;
            }
            self.out.push(o);
        }
        let blocked = !self.urgent.is_empty();
        for o in detail {
            let n = o.bytes.len() as u64;
            if blocked || self.spent + n > self.budget {
                self.dropped += 1;
                self.resync |= matches!(o.kind, Kind::Cells | Kind::Changes);
                continue;
            }
            self.spent += n;
            if o.kind == Kind::Entry && self.grant.level == Level::Full {
                self.stats.on_tick += 1;
            }
            self.out.push(o);
        }
    }

    /// Ends a world second: keeps its costs, grants the level for the next, and names a gap and a new grant.
    fn close(&mut self, second: i64) -> R<()> {
        self.stats.most = self.stats.most.max(self.spent);
        self.stats.seconds += 1;
        self.history.push_back(self.cost);
        while self.history.len() > WINDOW {
            self.history.pop_front();
        }
        let peak = |l: Level| self.history.iter().map(|c| c[rank(l)]).max().unwrap_or(0);
        let ask = Subscription {
            scope: ViewScope::Nodes(self.held.clone()),
            level: self.asked,
            budget: self.budget,
        };
        let g = grant(&ask, self.held.len().max(1) as u64, peak)?;
        if self.dropped > 0 {
            self.stats.dropped += self.dropped;
            self.stats.gaps += 1;
            let v = map(vec![
                (1, Value::Uint(8)),
                (2, int(second)),
                (3, Value::Uint(self.dropped)),
            ]);
            self.push_urgent(Kind::Gap, v)?;
        }
        if g != self.grant {
            if g.level != g.asked && rank(g.level) > rank(self.grant.level) {
                self.stats.lowered += 1;
            }
            self.grant = g;
            self.push_urgent(
                Kind::Grant,
                map(vec![(1, Value::Uint(5)), (2, g.to_value())]),
            )?;
        }
        self.spent = 0;
        self.cost = [0; 4];
        self.dropped = 0;
        Ok(())
    }
}

/// A node's items for one world second, encoded once.
struct NodeSecond {
    cells: Arc<[u8]>,
    /// The changes since the last second, unless the node is new or its grid's size changed.
    changes: Option<Arc<[u8]>>,
    count: Arc<[u8]>,
}

/// The subscriptions of one zone, run by the view tier on the log's parts.
#[derive(Default)]
pub struct Hub {
    places: Places,
    subs: Vec<Option<Sub>>,
    second: Option<i64>,
    nodes: BTreeMap<Id, NodeSecond>,
    /// Every node's counts by cell at the last world second, and the grid's size.
    tables: BTreeMap<Id, (i64, Table)>,
}

impl Hub {
    pub fn new() -> Hub {
        Hub::default()
    }

    pub fn places(&self) -> &Places {
        &self.places
    }

    /// Subscribes; the subscription's number. A budget below the least for its scopes is refused
    /// (`budget-below-minimum`); an accepted one is never dropped.
    pub fn subscribe(&mut self, r: Request) -> R<usize> {
        if r.scopes.is_empty() {
            return Err(fault("no-scope", "a subscription holds at least one scope"));
        }
        let views = r.scopes.len() as u64;
        let ask = Subscription {
            scope: ViewScope::Nodes(Vec::new()),
            level: r.level,
            budget: r.budget,
        };
        let g = grant(&ask, views, |_| 0)?;
        let mut s = Sub {
            scopes: r.scopes.clone(),
            held: Vec::new(),
            follow: None,
            asked: r.level,
            budget: r.budget,
            grant: g,
            interest: Interest::default(),
            sampled: BTreeMap::new(),
            tables: BTreeSet::new(),
            resync: false,
            urgent: VecDeque::new(),
            out: Vec::new(),
            spent: 0,
            cost: [0; 4],
            history: VecDeque::new(),
            dropped: 0,
            stats: Stats::default(),
        };
        s.push_urgent(
            Kind::Grant,
            map(vec![(1, Value::Uint(5)), (2, g.to_value())]),
        )?;
        for sc in &r.scopes {
            match *sc {
                Scope::Node(n) => s.add(n)?,
                Scope::Follow(body) => {
                    if let Some((room, _)) = self.places.of(body) {
                        s.add(room)?;
                        s.follow = Some((body, room));
                    }
                }
            }
        }
        self.subs.push(Some(s));
        Ok(self.subs.len() - 1)
    }

    /// Ends a subscription.
    pub fn unsubscribe(&mut self, sub: usize) {
        if let Some(s) = self.subs.get_mut(sub) {
            *s = None;
        }
    }

    /// Queues an event addressed to subscriber `sub` (a receipt, an utterance): sent ahead of any detail, never merged
    /// or dropped.
    pub fn address(&mut self, sub: usize, bytes: &[u8]) -> R<()> {
        self.sub_mut(sub)?.address(bytes)
    }

    fn sub_mut(&mut self, sub: usize) -> R<&mut Sub> {
        self.subs
            .get_mut(sub)
            .and_then(Option::as_mut)
            .ok_or_else(|| fault("no-subscription", format!("subscription {sub}")))
    }

    fn sub(&self, sub: usize) -> Option<&Sub> {
        self.subs.get(sub).and_then(Option::as_ref)
    }

    /// The items sent to `sub` since the last drain, in order.
    pub fn drain(&mut self, sub: usize) -> Vec<Out> {
        self.subs
            .get_mut(sub)
            .and_then(Option::as_mut)
            .map(|s| std::mem::take(&mut s.out))
            .unwrap_or_default()
    }

    /// The interest set of `sub` now.
    pub fn interest(&self, sub: usize) -> Option<&BTreeSet<Id>> {
        self.sub(sub).map(|s| &s.interest.set)
    }

    /// The nodes `sub` holds now, in the order added.
    pub fn held(&self, sub: usize) -> Option<&[Id]> {
        self.sub(sub).map(|s| s.held.as_slice())
    }

    pub fn granted(&self, sub: usize) -> Option<Grant> {
        self.sub(sub).map(|s| s.grant)
    }

    pub fn stats(&self, sub: usize) -> Option<&Stats> {
        self.sub(sub).map(|s| &s.stats)
    }

    /// Reads one tick's part of the log.
    pub fn tick(&mut self, part: &Part) -> R<()> {
        let Some(at) = part.effects.last().map(|e| e.envelope.at) else {
            return Ok(());
        };
        let second = at.div_euclid(SAMPLE_US);
        // The entries of bodies, each encoded once: (bytes, whether `sampled` keeps it whatever the second).
        let mut by_body: ByBody = BTreeMap::new();
        // The utterances: each entry's bytes and the hearers it records.
        let mut said: Vec<(Arc<[u8]>, BTreeSet<Id>)> = Vec::new();
        for e in &part.effects {
            self.places.apply(e);
            if let Some((body, keep)) = self.body_of(e) {
                let bytes = bytes_of(map(vec![(1, Value::Uint(1)), (2, e.to_value())]))?;
                by_body.entry(body).or_default().push((bytes, keep));
            }
            for ev in e.events.iter().flatten() {
                if ev.name.as_str() == SAID {
                    let s = Said::read(&ev.to_value(), e.envelope.audience)?;
                    if !s.hearers.is_empty() {
                        said.push((bytes_of(e.to_value())?, s.hearers));
                    }
                } else if let Some(to) = replica::activity::addressed(ev.name.as_str(), &ev.fields)
                    && !to.is_empty()
                {
                    // An offer to each body asked, its decline or lapse to the asker (E8, C2): addressed like speech.
                    said.push((bytes_of(e.to_value())?, to));
                }
            }
        }
        let new_second = self.second != Some(second);
        if new_second {
            if let Some(prev) = self.second {
                for s in self.subs.iter_mut().flatten() {
                    s.close(prev)?;
                }
            }
            self.second = Some(second);
            self.nodes = self.node_seconds(second)?;
        }
        for (bytes, hearers) in &said {
            for s in self.subs.iter_mut().flatten() {
                let hears = s
                    .scopes
                    .iter()
                    .any(|sc| matches!(sc, Scope::Follow(b) if hearers.contains(b)));
                if hears {
                    s.address(bytes)?;
                }
            }
        }
        for i in 0..self.subs.len() {
            self.serve(i, second, new_second, &by_body)?;
        }
        Ok(())
    }

    /// The body an entry is of, if any, and whether `sampled` keeps it in any second (all but a plain motion sample).
    fn body_of(&self, e: &Effect) -> Option<(Id, bool)> {
        let Body::Changes(cs) = &e.body else {
            return self
                .places
                .is_body(e.envelope.node)
                .then_some((e.envelope.node, true));
        };
        for c in cs {
            let (node, keep) = match &c.change {
                Change::Motion(h) => (h.node, h.from != h.to || h.linear == Vec3::ZERO),
                Change::Create { node, .. }
                | Change::Remove { node }
                | Change::Reparent { node, .. }
                | Change::Set { node, .. } => (*node, true),
                _ => continue,
            };
            if self.places.is_body(node) {
                return Some((node, keep));
            }
        }
        None
    }

    /// Every node's items for a new world second, and its counts by cell kept for the next.
    fn node_seconds(&mut self, second: i64) -> R<BTreeMap<Id, NodeSecond>> {
        let mut now = self.places.cells(GRID);
        // A node whose last body left keeps an empty table, so its cells go as emptied and then as no changes.
        for (node, (size, _)) in &self.tables {
            now.entry(*node).or_insert_with(|| (*size, Table::new()));
        }
        let mut out = BTreeMap::new();
        for (node, t) in &now {
            out.insert(*node, node_second(*node, second, t, self.tables.get(node))?);
        }
        self.tables = now;
        Ok(out)
    }

    fn serve(&mut self, i: usize, second: i64, new_second: bool, by_body: &ByBody) -> R<()> {
        let places = &self.places;
        let nodes = &self.nodes;
        let Some(s) = self.subs[i].as_mut() else {
            return Ok(());
        };
        // 1. The followed room: a new one is added, its counts sent, before the old is dropped.
        let mut extra: Vec<Out> = Vec::new();
        for sc in s.scopes.clone() {
            let Scope::Follow(body) = sc else { continue };
            let now = places.of(body).map(|(n, _)| n);
            let was = s.follow.map(|(_, n)| n);
            if now != was {
                if let Some(n) = now {
                    s.add(n)?;
                    // Its counts as they are now, before the old room goes (a change of room is rare: one pass).
                    // Built from mid-second, so not a table the next second's changes apply to: that one is whole.
                    let t = places.cells(GRID).remove(&n).unwrap_or_default();
                    s.urgent.push_back(Out {
                        kind: Kind::Cells,
                        bytes: node_second(n, second, &t, None)?.cells,
                    });
                }
                if let Some(o) = was {
                    s.drop_node(o)?;
                }
                s.follow = now.map(|n| (body, n));
            }
            // 2. The interest set, the same whatever the level or the budget.
            let before = s.interest.set.clone();
            if s.interest.update(places, body) {
                let entered: Vec<Value> = s
                    .interest
                    .set
                    .difference(&before)
                    .map(|id| id.to_value())
                    .collect();
                let left: Vec<Value> = before
                    .difference(&s.interest.set)
                    .map(|id| id.to_value())
                    .collect();
                let v = map(vec![
                    (1, Value::Uint(2)),
                    (2, Value::Array(entered)),
                    (3, Value::Array(left)),
                ]);
                extra.push(Out {
                    kind: Kind::Members,
                    bytes: bytes_of(v)?,
                });
            }
        }
        // 3. What each level would send this tick, and its cost.
        let mut full: Vec<Out> = Vec::new();
        let mut sampled: Vec<Out> = Vec::new();
        for id in &s.interest.set {
            for (bytes, keep) in by_body.get(id).into_iter().flatten() {
                let o = Out {
                    kind: Kind::Entry,
                    bytes: bytes.clone(),
                };
                if *keep || s.sampled.get(id) != Some(&second) {
                    s.sampled.insert(*id, second);
                    sampled.push(o.clone());
                }
                full.push(o);
            }
        }
        s.sampled.retain(|id, _| s.interest.set.contains(id));
        let mut cells: Vec<Out> = Vec::new();
        let mut counts: Vec<Out> = Vec::new();
        if new_second {
            // A table is kept only while every second's changes reach the client.
            if s.resync || s.grant.level == Level::Counts {
                s.tables.clear();
                s.resync = false;
            }
            for n in &s.held {
                let built;
                let ns = match nodes.get(n) {
                    Some(ns) => ns,
                    None => {
                        built = node_second(*n, second, &(0, Table::new()), None)?;
                        &built
                    }
                };
                let changes = ns.changes.clone().filter(|_| s.tables.contains(n));
                cells.push(match changes {
                    Some(bytes) => Out {
                        kind: Kind::Changes,
                        bytes,
                    },
                    None => {
                        s.tables.insert(*n);
                        Out {
                            kind: Kind::Cells,
                            bytes: ns.cells.clone(),
                        }
                    }
                });
                counts.push(Out {
                    kind: Kind::Count,
                    bytes: ns.count.clone(),
                });
            }
        }
        let size = |v: &[Out]| v.iter().map(|o| o.bytes.len() as u64).sum::<u64>();
        let (members, cells_n) = (size(&extra), size(&cells));
        s.cost[0] += size(&full) + members + cells_n;
        s.cost[1] += size(&sampled) + members + cells_n;
        s.cost[2] += members + cells_n;
        s.cost[3] += size(&counts);
        if s.grant.level == Level::Full {
            s.stats.due += full.len() as u64;
        }
        // 4. Send: urgent first, then the granted level's detail, the summary of the rest first.
        let detail = match s.grant.level {
            Level::Full => [cells, extra, full].concat(),
            Level::Sampled => [cells, extra, sampled].concat(),
            Level::Outline => [cells, extra].concat(),
            Level::Counts => counts,
        };
        s.send(detail);
        Ok(())
    }
}

/// A node's items for world second `second`: its whole table (`now`, with its grid's size), the cells changed since
/// `prev` (unless there is none or its grid's size differs), and its one count.
fn node_second(
    node: Id,
    second: i64,
    now: &(i64, Table),
    prev: Option<&(i64, Table)>,
) -> R<NodeSecond> {
    let (size, t) = now;
    let total: u64 = t.values().map(|n| u64::from(*n)).sum();
    let row =
        |(i, j): (i64, i64), n: u32| Value::Array(vec![int(i), int(j), Value::Uint(n.into())]);
    let head = |k: u64| vec![(1, Value::Uint(k)), (2, node.to_value()), (3, int(second))];
    let mut cells = head(3);
    cells.push((
        4,
        Value::Array(t.iter().map(|(c, n)| row(*c, *n)).collect()),
    ));
    cells.push((5, int(*size)));
    let changes = match prev {
        Some((was_size, was)) if was_size == size => {
            let mut rows = Vec::new();
            for c in t.keys().chain(was.keys().filter(|c| !t.contains_key(c))) {
                let n = t.get(c).copied().unwrap_or(0);
                if was.get(c) != Some(&n) {
                    rows.push((*c, n));
                }
            }
            rows.sort_unstable();
            let mut v = head(10);
            v.push((
                4,
                Value::Array(rows.into_iter().map(|(c, n)| row(c, n)).collect()),
            ));
            Some(bytes_of(map(v))?)
        }
        _ => None,
    };
    let mut count = head(4);
    count.push((4, Value::Uint(total)));
    Ok(NodeSecond {
        cells: bytes_of(map(cells))?,
        changes,
        count: bytes_of(map(count))?,
    })
}

/// The bytes of a node's counts by cell in one world second, whole and as changes since `prev`: for measuring the
/// forms (the `subscription` bench).
pub fn cell_bytes(
    node: Id,
    second: i64,
    now: &(i64, Table),
    prev: Option<&(i64, Table)>,
) -> R<(usize, Option<usize>)> {
    let ns = node_second(node, second, now, prev)?;
    Ok((ns.cells.len(), ns.changes.map(|c| c.len())))
}
