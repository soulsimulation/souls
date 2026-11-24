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
//!    of the hearers the entry records, and to no other; nothing is worked out again. It goes as `{1: 9, 2: entry, 3:
//!    words}`, the words read from K16 for that subscriber's audiences, and left out when it may not read them (C6,
//!    #3390). An entry that records no hearers (a `say` on a world whose tick does not work them out yet, C5 #3369) is
//!    heard by the bodies within its reach in the tier's own index, the one interest sets read.
//!
//! 6. **Audience** (T7 rule 5, T8): a subscriber is sent the public entries and those of the audience ids it is in
//!    ([`Hub::subscribe_as`]; the gateway resolves them for its grant), never another audience's. An activity's
//!    audience (a turn into it, E26a #3504) is read by the subscribers one of whose ids is a member's body at that
//!    point of the log: the hub keeps the `souls:member` links (B5) from the log's parts and the world as built, so a
//!    subscriber reads it while it is a member and stops when it leaves, and a replay reads the same.
//!
//! Every item is a map whose field 1 names it ([`Kind`]). The hub reads only the log's parts; the view tier's thread
//! runs it, never the clock thread (`served.rs`, fed by the world's committed parts once they are on the disk).
//!
//! Not here: the socket and its request format (gatewayd), the world-wide index and finding a Soul (E1), speech and
//! who hears (B11's `sim::speech`, E13), words beside references (K16).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

use replica::activity::MEMBER;
use replica::effects::{Body, Change, Effect, Part, Refusal, read_id};
use replica::encode::{Value, encode};
use replica::ids::Id;
use replica::pose::Vec3;
use replica::speech::{HEARD_WORDS, SAID, Said};
use replica::tree::Tree;
use replica::views::{Grant, Level, ORDER, SAMPLE_US, Scope as ViewScope, Subscription, grant};
use replica::world_model::{Audience, End};
use sim::text::Store;

use super::interest::{Interest, Places, Table};

type R<T> = Result<T, Refusal>;

/// Who may read an item, as the hub read it: `None` everyone; else the ids one of which a subscriber must be in, its
/// audience id and, when that is an activity, the bodies that were its members at that point of the log.
type Readers = Option<Arc<BTreeSet<Id>>>;
/// A tick's entries of each body, each encoded once, whether `sampled` keeps it in any second, and who may read it.
type ByBody = BTreeMap<Id, Vec<(Arc<[u8]>, bool, Readers)>>;
/// An utterance of a tick: its entry encoded once, its hearers, who may read it and its words' reference (none for
/// an offer, addressed like speech: C2).
type Utterance = (Arc<[u8]>, BTreeSet<Id>, Readers, Option<Id>);

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

impl Request {
    /// Reads a request as a client sends it: `{1: [scope, ...], 2: level number, 3: budget}`, a scope `{1: node}`
    /// held for good or `{2: body}` followed.
    pub fn from_value(v: &Value) -> R<Request> {
        let bad = |d: &str| fault("subscribe-unread", d.to_owned());
        let Value::Map(m) = v else {
            return Err(bad("not a map"));
        };
        let Some(Value::Array(scopes)) = m.get(&1) else {
            return Err(bad("field 1 is not an array of scopes"));
        };
        let scopes = scopes
            .iter()
            .map(|s| match s {
                Value::Map(s) if s.len() == 1 => match s.iter().next() {
                    Some((1, id)) => Ok(Scope::Node(read_id(id)?)),
                    Some((2, id)) => Ok(Scope::Follow(read_id(id)?)),
                    _ => Err(bad("a scope is {1: node} or {2: body}")),
                },
                _ => Err(bad("a scope is {1: node} or {2: body}")),
            })
            .collect::<R<Vec<Scope>>>()?;
        let (Some(Value::Uint(level)), Some(Value::Uint(budget))) = (m.get(&2), m.get(&3)) else {
            return Err(bad("fields 2 and 3 are a level number and a budget"));
        };
        Ok(Request {
            scopes,
            level: Level::from_number(*level)?,
            budget: *budget,
        })
    }
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
    /// The audience ids it is in, besides everyone.
    audiences: BTreeSet<Id>,
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
    fn sees(&self, r: &Readers) -> bool {
        match r {
            None => true,
            Some(ids) => ids.iter().any(|id| self.audiences.contains(id)),
        }
    }

    fn address(&mut self, bytes: &[u8]) -> R<()> {
        self.stats.addressed_in += 1;
        self.push_urgent(
            Kind::Addressed,
            map(vec![(1, Value::Uint(9)), (2, Value::Bytes(bytes.to_vec()))]),
        )
    }

    /// An utterance this subscriber heard, with its words when it may read them: `{1: 9, 2: entry, 3: words}`.
    fn address_said(&mut self, bytes: &[u8], words: Option<Vec<u8>>) -> R<()> {
        self.stats.addressed_in += 1;
        let mut v = vec![(1, Value::Uint(9)), (2, Value::Bytes(bytes.to_vec()))];
        v.extend(words.map(|w| (HEARD_WORDS, Value::Bytes(w))));
        self.push_urgent(Kind::Addressed, map(v))
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
    /// Closed containers and what is in them (#3915): such an entry is sent to its actor alone.
    inside: crate::closed::Inside,
    places: Places,
    subs: Vec<Option<Sub>>,
    second: Option<i64>,
    nodes: BTreeMap<Id, NodeSecond>,
    /// Every node's counts by cell at the last world second, and the grid's size.
    tables: BTreeMap<Id, (i64, Table)>,
    /// K16's text store, where an utterance's words are read for each subscriber that hears it (C6).
    words: Option<Arc<Store>>,
    /// The `souls:member` links held now: link → (body, activity) (B5, E26a).
    member_links: BTreeMap<Id, (Id, Id)>,
    /// Authoritative C3 links, indexed both ways; multiple owners fail closed.
    owner_links: BTreeMap<Id, (Id, Id)>,
    body_owners: BTreeMap<Id, BTreeMap<Id, Id>>,
}

impl Hub {
    pub fn new() -> Hub {
        Hub::default()
    }

    /// A hub that sends an utterance's words with it, read from `words` for each subscriber's audiences (C6, #3390).
    pub fn with_words(words: Arc<Store>) -> Hub {
        Hub {
            words: Some(words),
            ..Hub::default()
        }
    }

    /// The world's closed kinds (#3915): an entry that puts a thing into one, or touches one in it, is sent to its
    /// actor alone. Called before [`Hub::seed`].
    pub fn closed(&mut self, closed: &crate::closed::Closed) {
        self.inside = crate::closed::Inside::new(closed);
    }

    /// Enters the bodies of the world as built, which no record creates (C6), and its activities' members (E26a).
    pub fn seed(&mut self, tree: &Tree) {
        self.inside.seed(tree);
        self.places.seed(tree);
        let mut todo = vec![tree.root()];
        while let Some(h) = todo.pop() {
            todo.extend(tree.children(h).unwrap_or_default());
            for e in tree.links_of(h).unwrap_or_default() {
                if let Some((ty, ends, owner, _)) = tree.link(e.link) {
                    if ty.as_str() == MEMBER {
                        self.member_links.insert(e.link, (ends[0], ends[1]));
                    } else if ty.as_str() == "souls:body-of" {
                        self.ownership(e.link, ends, owner);
                    }
                }
            }
        }
    }

    fn unown(&mut self, link: Id) {
        if let Some((body, _)) = self.owner_links.remove(&link)
            && let Some(owners) = self.body_owners.get_mut(&body)
        {
            owners.remove(&link);
            if owners.is_empty() {
                self.body_owners.remove(&body);
            }
        }
    }

    fn ownership(&mut self, link: Id, ends: [Id; 2], owner: End) {
        self.unown(link);
        if owner != End::First || ends[0] == ends[1] || !self.places.is_body(ends[0]) {
            return;
        }
        self.owner_links.insert(link, (ends[0], ends[1]));
        self.body_owners
            .entry(ends[0])
            .or_default()
            .insert(link, ends[1]);
    }

    /// Keeps the membership links an entry makes and ends (E26a).
    fn members_apply(&mut self, e: &Effect) {
        let Body::Changes(cs) = &e.body else { return };
        for c in cs {
            match &c.change {
                Change::Link { link, ty, ends, .. } if ty.as_str() == MEMBER => {
                    self.member_links.insert(*link, (ends[0], ends[1]));
                }
                Change::Link {
                    link,
                    ty,
                    ends,
                    owner,
                    ..
                } if ty.as_str() == "souls:body-of" => {
                    self.ownership(*link, *ends, *owner);
                }
                Change::Unlink { link } => {
                    self.member_links.remove(link);
                    self.unown(*link);
                }
                Change::Remove { node } => {
                    self.member_links.retain(|_, (b, a)| b != node && a != node);
                    let gone: Vec<_> = self
                        .owner_links
                        .iter()
                        .filter(|(_, (b, principal))| b == node || principal == node)
                        .map(|(link, _)| *link)
                        .collect();
                    for link in gone {
                        self.unown(link);
                    }
                }
                _ => {}
            }
        }
    }

    /// Who may read what audience `a` holds now ([`Readers`]).
    fn readers(&self, a: Audience) -> Readers {
        let Audience::Of(id) = a else { return None };
        let mut ids: BTreeSet<Id> = self
            .member_links
            .values()
            .filter(|(_, act)| *act == id)
            .map(|(body, _)| *body)
            .collect();
        ids.insert(id);
        let principals: Vec<_> = ids
            .iter()
            .filter_map(|body| {
                let owners = self.body_owners.get(body)?;
                (owners.len() == 1).then(|| *owners.values().next().unwrap())
            })
            .collect();
        ids.extend(principals);
        Some(Arc::new(ids))
    }

    /// The bodies within `reach_mm` of `speaker` on the node it stands on, itself included: who hears an utterance
    /// that records no hearers (C6; until the world records them in its tick, C5 #3369).
    fn within_reach(&self, speaker: Id, reach_mm: u64) -> BTreeSet<Id> {
        let Some((node, p)) = self.places.of(speaker) else {
            return BTreeSet::new();
        };
        let reach = i64::try_from(reach_mm.saturating_mul(1_000)).unwrap_or(i64::MAX);
        self.places
            .index()
            .bodies_within(node, p, reach)
            .into_iter()
            .filter(|&(_, d)| d <= reach)
            .map(|(id, _)| id)
            .collect()
    }

    pub fn places(&self) -> &Places {
        &self.places
    }

    /// Subscribes to the public entries alone; the subscription's number. A budget below the least for its scopes is
    /// refused (`budget-below-minimum`); an accepted one is never dropped.
    pub fn subscribe(&mut self, r: Request) -> R<usize> {
        self.subscribe_as(r, BTreeSet::new())
    }

    /// Subscribes as one who is in `audiences` (besides everyone): it is sent their entries and the public ones.
    pub fn subscribe_as(&mut self, r: Request, audiences: BTreeSet<Id>) -> R<usize> {
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
            audiences,
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
        // Initial grants and scopes use the same urgent budget without waiting for another world commit.
        s.send(Vec::new());
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
        // The utterances: each entry's bytes, its hearers, its audience and its words' reference.
        let mut said: Vec<Utterance> = Vec::new();
        for e in &part.effects {
            self.places.apply(e);
            self.members_apply(e);
            let mut readers = self.readers(e.envelope.audience);
            if self.inside.apply(e) {
                // A thing hidden in a closed container (#3915): its entry goes to its actor alone.
                let actor: BTreeSet<Id> = match e.envelope.actor {
                    replica::effects::Actor::Soul(id) | replica::effects::Actor::Creator(id) => {
                        BTreeSet::from([id])
                    }
                    replica::effects::Actor::World => BTreeSet::new(),
                };
                let kept = match &readers {
                    None => actor,
                    Some(r) => actor.intersection(r).copied().collect(),
                };
                readers = Some(Arc::new(kept));
            }
            if let Some((body, keep)) = self.body_of(e) {
                let bytes = bytes_of(map(vec![(1, Value::Uint(1)), (2, e.to_value())]))?;
                by_body
                    .entry(body)
                    .or_default()
                    .push((bytes, keep, readers.clone()));
            }
            for ev in e.events.iter().flatten() {
                if ev.name.as_str() == SAID {
                    let s = Said::read(&ev.to_value(), e.envelope.audience)?;
                    let hearers = if s.hearers.is_empty() {
                        self.within_reach(e.envelope.node, s.reach_mm)
                    } else {
                        s.hearers
                    };
                    if !hearers.is_empty() {
                        let b = bytes_of(e.to_value())?;
                        said.push((b, hearers, readers.clone(), Some(s.words)));
                    }
                } else if let Some(to) = replica::activity::addressed(ev.name.as_str(), &ev.fields)
                    && !to.is_empty()
                {
                    // An offer to each body asked, its decline or lapse to the asker (E8, C2): addressed like speech.
                    said.push((bytes_of(e.to_value())?, to, readers.clone(), None));
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
        for (bytes, hearers, readers, words) in &said {
            for s in self.subs.iter_mut().flatten() {
                let hears = s.sees(readers)
                    && s.scopes
                        .iter()
                        .any(|sc| matches!(sc, Scope::Follow(b) if hearers.contains(b)));
                if hears {
                    // Its words as this subscriber may read them (T8 rule 6): none when it may not, or none are kept. A
                    // member reads an activity's words as its audience (E26a).
                    let reader: Vec<Id> = s
                        .audiences
                        .iter()
                        .chain(readers.iter().flat_map(|r| r.iter()))
                        .copied()
                        .collect();
                    let text = self
                        .words
                        .as_ref()
                        .and_then(|t| t.read((*words)?, &reader).ok());
                    s.address_said(bytes, text)?;
                }
            }
        }
        for i in 0..self.subs.len() {
            self.serve(i, second, new_second, &by_body)?;
        }
        Ok(())
    }

    /// The body an entry is of, if any, and whether `sampled` keeps it in any second (all but a plain motion sample).
    /// An entry that changes no body but names one in an event's field 1 is that body's, kept: a move's start and end
    /// (`souls:move-started`, `souls:move-ended`, written on the zone with no changes), which a Soul near it reads as
    /// that body arriving (0.134 I3).
    fn body_of(&self, e: &Effect) -> Option<(Id, bool)> {
        let Body::Changes(cs) = &e.body else {
            return self
                .places
                .is_body(e.envelope.node)
                .then_some((e.envelope.node, true));
        };
        if cs.is_empty() {
            return e
                .events
                .iter()
                .flatten()
                .filter_map(|ev| read_id(ev.fields.get(&1)?).ok())
                .find(|b| self.places.is_body(*b))
                .map(|b| (b, true));
        }
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
            for (bytes, keep, readers) in by_body.get(id).into_iter().flatten() {
                if !s.sees(readers) {
                    continue;
                }
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

#[cfg(test)]
mod ownership_tests {
    use super::*;
    use replica::effects::{Actor, Cause, ChangeRec, Envelope, Header, Rest, schema_hash};
    use replica::encode::Name;
    use replica::ids::{Hash, Purpose, Scope as IdScope};
    use replica::pose::{Frame, Pose, Quat, Support};

    fn id(n: u64) -> Id {
        Id::new(IdScope([0x65; 16]), n).unwrap()
    }
    fn name(s: &str) -> Name {
        Name::new(s).unwrap()
    }
    fn effect(changes: Vec<Change>) -> Effect {
        Effect {
            envelope: Envelope {
                sequence: 0,
                at: 0,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node: id(1),
            },
            body: Body::Changes(
                changes
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            ),
            events: None,
            rest: Rest::new(),
        }
    }
    fn owned(link: Id, soul: Id, owner: End) -> Change {
        Change::Link {
            link,
            ty: name("souls:body-of"),
            ends: [id(2), soul],
            owner,
            audience: Audience::Everyone,
        }
    }

    #[test]
    fn ownership_replays_and_never_comes_from_follow_targets() {
        let body_kind = name(&format!("souls:body@1220{}", "00".repeat(32)));
        let ground_kind = name(&format!("test:ground@1220{}", "00".repeat(32)));
        let mut kinds = vec![body_kind.clone(), ground_kind.clone()];
        kinds.sort();
        let header = Header::read(
            &encode(&Value::Map(BTreeMap::from([
                (
                    1,
                    Value::Bytes(Hash::of(Purpose::Fixture, b"c30/ownership").to_bytes()),
                ),
                (2, Value::Bytes(schema_hash().to_bytes())),
                (3, Value::Bytes(id(1).scope().0.to_vec())),
                (4, id(1).to_value()),
                (5, Value::Uint(0)),
                (
                    6,
                    Value::Array(kinds.into_iter().map(Value::Text).collect()),
                ),
                (7, Value::Array(vec![])),
            ])))
            .unwrap(),
        )
        .unwrap();
        let mut tree = Tree::start(id(1), ground_kind);
        let mut live = Hub::new();
        live.seed(&tree);
        let birth = effect(vec![
            Change::Create {
                node: id(2),
                kind: body_kind,
                pose: Pose {
                    frame: Frame {
                        node: id(1),
                        slot: None,
                    },
                    position: Vec3::ZERO,
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: id(1),
                        height: 0,
                    },
                },
                audience: Audience::Everyone,
                fields: BTreeMap::new(),
            },
            owned(id(3), id(4), End::First),
        ]);
        let part = replica::views::entry_part(&header, &birth).unwrap();
        tree.apply(&header, &part).unwrap();
        live.tick(&part).unwrap();
        let mut replay = Hub::new();
        replay.seed(&tree);
        assert_eq!(
            live.readers(Audience::Of(id(2))),
            replay.readers(Audience::Of(id(2)))
        );
        let reader = |h: &mut Hub, principal| {
            let sub = h
                .subscribe_as(
                    Request {
                        scopes: vec![Scope::Follow(id(2))],
                        level: Level::Full,
                        budget: 10_000_000,
                    },
                    BTreeSet::from([principal]),
                )
                .unwrap();
            h.subs[sub]
                .as_ref()
                .unwrap()
                .sees(&h.readers(Audience::Of(id(2))))
        };
        assert!(
            reader(&mut live, id(4)),
            "the body's owner reads its private audience"
        );
        assert!(
            !reader(&mut live, id(5)),
            "following another body confers no private authority"
        );
        assert!(
            reader(&mut live, id(2)),
            "legacy direct body audiences remain valid"
        );
        live.members_apply(&effect(vec![owned(id(6), id(5), End::First)]));
        assert!(
            !reader(&mut live, id(4)) && !reader(&mut live, id(5)),
            "ambiguous ownership fails closed"
        );
        live.members_apply(&effect(vec![Change::Unlink { link: id(3) }]));
        assert!(
            !reader(&mut live, id(4)) && reader(&mut live, id(5)),
            "replacement revokes the prior principal"
        );
        live.members_apply(&effect(vec![owned(id(6), id(4), End::Second)]));
        assert!(
            !reader(&mut live, id(4)) && !reader(&mut live, id(5)),
            "invalid ownership revokes aliases"
        );
        live.members_apply(&effect(vec![owned(id(7), id(4), End::First)]));
        live.members_apply(&effect(vec![Change::Remove { node: id(2) }]));
        assert!(!reader(&mut live, id(4)), "removal revokes the alias");
    }
}
