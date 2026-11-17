//! The world model (contract T2; Engine v2 T2, #2641). The rules are numbered in `v2/docs/world-model.md`.
//!
//! Containment is a tree: a [`Node`]'s parent means its lifetime and its frame of reference, nothing else. Every other
//! relation is a typed [`Link`] with an id, two ends, an owning end and an audience, indexed at both ends. A kind
//! says what children it admits ([`Kind`]); that is checked when a change is committed ([`check`]), never when it is
//! applied. Types, the validity check and fixtures only: no runtime and no speed work (K2 builds those).

use crate::encode::{Value, parse_diagnostic};
use crate::ids::{FIXTURE_SCOPE_A, Id, Scope};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// The most ancestors a node may have (rule 6). Deep enough for a cup on a tray on a table in a cabin of a boat in
/// a hangar of a station, with room to spare; refused by name beyond it.
pub const DEPTH_LIMIT: u32 = 32;

/// Audience 0 is everyone (rule 9).
pub const EVERYONE: u64 = 0;

/// The scope the fixtures' Souls are minted in: the directory's, never a world's (`v2/docs/ids.md`, rule 7).
pub const FIXTURE_SCOPE_SOULS: Scope = Scope([0xdd; 16]);

/// What a kind admits (rule 5): kinds as children, and kinds in each numbered slot. Section numbers follow the entry
/// format (SA-F1, #2842): 6 slots, 10 children.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Kind {
    pub children: BTreeSet<String>,
    pub slots: BTreeMap<u64, BTreeSet<String>>,
}

/// A node: id, kind, parent (with the parent's slot it sits in, if any), audience and numbered fields (rule 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub id: Id,
    pub kind: String,
    pub parent: Option<Id>,
    pub slot: Option<u64>,
    pub audience: u64,
    pub fields: BTreeMap<u64, Value>,
}

/// Which of a link's two ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    First,
    Second,
}

/// A typed link: id, type, two ends, the end that owns it and its audience (rule 7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    pub id: Id,
    pub ty: String,
    pub ends: [Id; 2],
    pub owner: End,
    pub audience: u64,
}

/// Who an audience is, resolved when written (contract T8): everyone, or a set of Souls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Members {
    Everyone,
    Only(BTreeSet<Id>),
}

impl Members {
    /// Whether everyone in `self` is also in `wider`.
    fn within(&self, wider: &Members) -> bool {
        match (self, wider) {
            (_, Members::Everyone) => true,
            (Members::Everyone, Members::Only(_)) => false,
            (Members::Only(a), Members::Only(b)) => a.is_subset(b),
        }
    }
}

/// A world as written, before the check: the kinds it is checked against, the Souls it knows, its audiences, its
/// nodes and its links.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    pub kinds: BTreeMap<String, Kind>,
    pub souls: BTreeSet<Id>,
    pub audiences: BTreeMap<u64, Members>,
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
}

/// Why a world is refused. Each has a name ([`Refusal::name`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `world-source`: text that is not a world or kinds as the fixtures write them.
    Source(String),
    /// `id-duplicate`: two records with one id; a node written twice would have two parents.
    IdDuplicate(Id),
    /// `audience-unknown`.
    AudienceUnknown(u64),
    /// `parent-missing`.
    ParentMissing { node: Id, parent: Id },
    /// `tree-cycle`: the nodes of the cycle, each the parent of the one before.
    Cycle(Vec<Id>),
    /// `depth-over-limit`: a node with more than [`DEPTH_LIMIT`] ancestors.
    TooDeep { node: Id, depth: u32 },
    /// `kind-unknown`.
    KindUnknown { node: Id, kind: String },
    /// `child-not-admitted`: the parent's kind (or the named slot of it) does not admit the child's kind.
    NotAdmitted {
        node: Id,
        kind: String,
        parent_kind: String,
        slot: Option<u64>,
    },
    /// `link-end-missing`: an end that is neither a node of this world nor a Soul it knows.
    EndMissing { link: Id, end: Id },
    /// `link-owner-not-node`: a link is owned by a node's end; a Soul is in no zone.
    OwnerNotNode(Id),
    /// `link-audience-wider`: the link is shown to someone who cannot see one of its ends.
    AudienceWider { link: Id, end: Id },
}

impl Refusal {
    pub fn name(&self) -> &'static str {
        match self {
            Refusal::Source(_) => "world-source",
            Refusal::IdDuplicate(_) => "id-duplicate",
            Refusal::AudienceUnknown(_) => "audience-unknown",
            Refusal::ParentMissing { .. } => "parent-missing",
            Refusal::Cycle(_) => "tree-cycle",
            Refusal::TooDeep { .. } => "depth-over-limit",
            Refusal::KindUnknown { .. } => "kind-unknown",
            Refusal::NotAdmitted { .. } => "child-not-admitted",
            Refusal::EndMissing { .. } => "link-end-missing",
            Refusal::OwnerNotNode(_) => "link-owner-not-node",
            Refusal::AudienceWider { .. } => "link-audience-wider",
        }
    }
}

/// An id as the fixtures write it: the scope's first byte and the counter, `aa:3`.
pub fn show(id: Id) -> String {
    format!("{:02x}:{}", id.scope().0[0], id.counter())
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: ", self.name())?;
        match self {
            Refusal::Source(why) => write!(f, "{why}"),
            Refusal::IdDuplicate(id) => write!(f, "{} is written twice", show(*id)),
            Refusal::AudienceUnknown(n) => write!(f, "audience {n} is not declared"),
            Refusal::ParentMissing { node, parent } => {
                write!(
                    f,
                    "{}'s parent {} is not a node",
                    show(*node),
                    show(*parent)
                )
            }
            Refusal::Cycle(ids) => {
                let path: Vec<String> = ids.iter().map(|i| show(*i)).collect();
                write!(f, "{} -> {}", path.join(" -> "), path[0])
            }
            Refusal::TooDeep { node, depth } => write!(
                f,
                "{} has {depth} ancestors, over {DEPTH_LIMIT}",
                show(*node)
            ),
            Refusal::KindUnknown { node, kind } => write!(f, "{}'s kind {kind}", show(*node)),
            Refusal::NotAdmitted {
                node,
                kind,
                parent_kind,
                slot,
            } => match slot {
                Some(s) => write!(
                    f,
                    "{parent_kind} slot {s} does not admit {kind} ({})",
                    show(*node)
                ),
                None => write!(f, "{parent_kind} does not admit {kind} ({})", show(*node)),
            },
            Refusal::EndMissing { link, end } => {
                write!(f, "link {}'s end {} is not here", show(*link), show(*end))
            }
            Refusal::OwnerNotNode(link) => write!(f, "link {} is owned by a Soul", show(*link)),
            Refusal::AudienceWider { link, end } => write!(
                f,
                "link {} is shown to some who cannot see {}",
                show(*link),
                show(*end)
            ),
        }
    }
}

impl std::error::Error for Refusal {}

/// One entry of the reference index: a link as seen from one of its ends. It carries the link's audience, so a
/// listing filters without reading the link or the other end (rule 8).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub link: Id,
    pub ty: String,
    pub other: Id,
    pub audience: u64,
}

/// Who is asking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Viewer {
    Anyone,
    Soul(Id),
}

/// A world that passed the check, with its reference index. Every read of a node goes through [`World::node`],
/// which counts it, so a test can show that a listing visits nothing unrelated.
#[derive(Debug)]
pub struct World {
    nodes: BTreeMap<Id, Node>,
    links: BTreeMap<Id, Link>,
    souls: BTreeSet<Id>,
    audiences: BTreeMap<u64, Members>,
    index: BTreeMap<Id, Vec<Entry>>,
    visits: Cell<u64>,
}

impl World {
    /// The node, counted as one visit.
    pub fn node(&self, id: Id) -> Option<&Node> {
        self.visits.set(self.visits.get() + 1);
        self.nodes.get(&id)
    }

    pub fn link(&self, id: Id) -> Option<&Link> {
        self.links.get(&id)
    }

    /// Node reads since the world was built or the counter last reset.
    pub fn visits(&self) -> u64 {
        self.visits.get()
    }

    pub fn reset_visits(&self) {
        self.visits.set(0);
    }

    /// The links ending at `end` (a node or a Soul) that `viewer` may see, from the index alone. A node end is visited
    /// once, to confirm it is here; nothing else is read.
    pub fn links_at(&self, end: Id, viewer: Viewer) -> Vec<&Entry> {
        if !self.souls.contains(&end) && self.node(end).is_none() {
            return Vec::new();
        }
        let sees = |audience: u64| match (&self.audiences[&audience], viewer) {
            (Members::Everyone, _) => true,
            (Members::Only(set), Viewer::Soul(soul)) => set.contains(&soul),
            (Members::Only(_), Viewer::Anyone) => false,
        };
        self.index
            .get(&end)
            .map(|entries| entries.iter().filter(|e| sees(e.audience)).collect())
            .unwrap_or_default()
    }

    pub fn node_count(&self) -> u64 {
        self.nodes.len() as u64
    }

    /// Every node and every link, in id order.
    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn links(&self) -> impl Iterator<Item = &Link> {
        self.links.values()
    }
}

/// The validity check (rules 2 to 9), run when a change is committed. It refuses the first fault it finds, in this
/// order: ids, audiences, parents, the tree's shape (cycles, then depth), kinds, then links. A viewer applying an
/// effect runs none of it.
pub fn check(draft: &Draft) -> Result<World, Refusal> {
    let mut seen = BTreeSet::new();
    let all_ids = draft.souls.iter().copied();
    let all_ids = all_ids.chain(draft.nodes.iter().map(|n| n.id));
    for id in all_ids.chain(draft.links.iter().map(|l| l.id)) {
        if !seen.insert(id) {
            return Err(Refusal::IdDuplicate(id));
        }
    }
    let mut audiences = draft.audiences.clone();
    audiences.insert(EVERYONE, Members::Everyone);
    let used = draft.nodes.iter().map(|n| n.audience);
    for a in used.chain(draft.links.iter().map(|l| l.audience)) {
        if !audiences.contains_key(&a) {
            return Err(Refusal::AudienceUnknown(a));
        }
    }
    let nodes: BTreeMap<Id, Node> = draft.nodes.iter().map(|n| (n.id, n.clone())).collect();
    for n in nodes.values() {
        if let Some(p) = n.parent
            && !nodes.contains_key(&p)
        {
            return Err(Refusal::ParentMissing {
                node: n.id,
                parent: p,
            });
        }
    }
    shape(&nodes)?;
    for n in nodes.values() {
        admitted(draft, &nodes, n)?;
    }
    let mut index: BTreeMap<Id, Vec<Entry>> = BTreeMap::new();
    let links: BTreeMap<Id, Link> = draft.links.iter().map(|l| (l.id, l.clone())).collect();
    for l in links.values() {
        for end in l.ends {
            let members = if draft.souls.contains(&end) {
                &Members::Everyone
            } else if let Some(n) = nodes.get(&end) {
                &audiences[&n.audience]
            } else {
                return Err(Refusal::EndMissing { link: l.id, end });
            };
            if !audiences[&l.audience].within(members) {
                return Err(Refusal::AudienceWider { link: l.id, end });
            }
        }
        let owner = match l.owner {
            End::First => l.ends[0],
            End::Second => l.ends[1],
        };
        if !nodes.contains_key(&owner) {
            return Err(Refusal::OwnerNotNode(l.id));
        }
        for (end, other) in [(l.ends[0], l.ends[1]), (l.ends[1], l.ends[0])] {
            index.entry(end).or_default().push(Entry {
                link: l.id,
                ty: l.ty.clone(),
                other,
                audience: l.audience,
            });
        }
    }
    Ok(World {
        nodes,
        links,
        souls: draft.souls.clone(),
        audiences,
        index,
        visits: Cell::new(0),
    })
}

/// No cycle and no node deeper than [`DEPTH_LIMIT`], walked with a loop (never recursion: depth is data, and a
/// WASM stack is small). Each node's depth is found once, so the walk is linear in the nodes.
fn shape(nodes: &BTreeMap<Id, Node>) -> Result<(), Refusal> {
    let mut depth: BTreeMap<Id, u32> = BTreeMap::new();
    for start in nodes.keys() {
        let mut path: Vec<Id> = Vec::new();
        let mut on_path = BTreeSet::new();
        let mut at = *start;
        // The depth of the first node above the path whose depth is known, or none when the path ends at a root.
        let mut above: Option<u32> = loop {
            if let Some(d) = depth.get(&at) {
                break Some(*d);
            }
            if !on_path.insert(at) {
                let from = path.iter().position(|i| *i == at).unwrap_or(0);
                return Err(Refusal::Cycle(path[from..].to_vec()));
            }
            path.push(at);
            match nodes[&at].parent {
                Some(p) => at = p,
                None => break None,
            }
        };
        for id in path.into_iter().rev() {
            let d = above.map_or(0, |a| a + 1);
            if d > DEPTH_LIMIT {
                return Err(Refusal::TooDeep { node: id, depth: d });
            }
            depth.insert(id, d);
            above = Some(d);
        }
    }
    Ok(())
}

fn admitted(draft: &Draft, nodes: &BTreeMap<Id, Node>, n: &Node) -> Result<(), Refusal> {
    let kind_of = |node: &Node| {
        draft
            .kinds
            .get(&node.kind)
            .ok_or_else(|| Refusal::KindUnknown {
                node: node.id,
                kind: node.kind.clone(),
            })
    };
    kind_of(n)?;
    let Some(p) = n.parent.map(|p| &nodes[&p]) else {
        return Ok(());
    };
    let pk = kind_of(p)?;
    let admits = match n.slot {
        Some(s) => pk.slots.get(&s).is_some_and(|k| k.contains(&n.kind)),
        None => pk.children.contains(&n.kind),
    };
    if admits {
        Ok(())
    } else {
        Err(Refusal::NotAdmitted {
            node: n.id,
            kind: n.kind.clone(),
            parent_kind: p.kind.clone(),
            slot: n.slot,
        })
    }
}

// ---- Reading the fixtures (`fixtures/world-model/`) -------------------------------------------------------------

fn source<T>(why: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal::Source(why.into()))
}

/// Diagnostic notation (`v2/docs/encoding.md`) with `#` comments to the end of the line.
fn read(text: &str) -> Result<Value, Refusal> {
    let bare: Vec<&str> = text
        .lines()
        .map(|line| line.split('#').next().unwrap_or(""))
        .collect();
    parse_diagnostic(&bare.join("\n")).map_err(Refusal::Source)
}

fn uint(v: Option<&Value>, what: &str) -> Result<u64, Refusal> {
    match v {
        Some(Value::Uint(n)) => Ok(*n),
        _ => source(format!("{what} is an unsigned integer")),
    }
}

fn text(v: Option<&Value>, what: &str) -> Result<String, Refusal> {
    match v {
        Some(Value::Text(t)) => Ok(t.as_str().to_owned()),
        _ => source(format!("{what} is a name")),
    }
}

fn array<'a>(v: Option<&'a Value>, what: &str) -> Result<&'a [Value], Refusal> {
    match v {
        Some(Value::Array(items)) => Ok(items),
        _ => source(format!("{what} is an array")),
    }
}

fn names(v: Option<&Value>, what: &str) -> Result<BTreeSet<String>, Refusal> {
    match v {
        None => Ok(BTreeSet::new()),
        Some(v) => array(Some(v), what)?
            .iter()
            .map(|n| text(Some(n), what))
            .collect(),
    }
}

/// Reads the kinds file: an array of `{1: name, 6: {slot: [kinds]}, 10: [kinds]}`.
pub fn parse_kinds(text_: &str) -> Result<BTreeMap<String, Kind>, Refusal> {
    let mut kinds = BTreeMap::new();
    for k in array(Some(&read(text_)?), "the kinds")? {
        let Value::Map(k) = k else {
            return source("a kind is a map");
        };
        let name = text(k.get(&1), "a kind's section 1")?;
        let mut slots = BTreeMap::new();
        if let Some(s) = k.get(&6) {
            let Value::Map(s) = s else {
                return source(format!("{name}: section 6 maps slots to kinds"));
            };
            for (n, admits) in s {
                slots.insert(*n, names(Some(admits), "a slot's kinds")?);
            }
        }
        let children = names(k.get(&10), "section 10")?;
        if kinds
            .insert(name.clone(), Kind { children, slots })
            .is_some()
        {
            return source(format!("{name} is written twice"));
        }
    }
    Ok(kinds)
}

/// Reads a world fixture (layout in `fixtures/world-model/door.diag`) against `kinds`. A counter listed as a Soul is in
/// [`FIXTURE_SCOPE_SOULS`]; every other counter is in the scope of the world's one zone writer, [`FIXTURE_SCOPE_A`] (each writer mints in
/// its own scope, `v2/docs/ids.md` rule 1).
pub fn parse_world(kinds: &BTreeMap<String, Kind>, text_: &str) -> Result<Draft, Refusal> {
    let Value::Map(w) = read(text_)? else {
        return source("a world is a map");
    };
    let mint = |scope: Scope, n: u64| {
        Id::new(scope, n).map_or_else(|| source("a counter is below 2^53"), Ok)
    };
    let mut soul_counters = BTreeSet::new();
    for s in array(w.get(&1), "section 1, the Souls")? {
        soul_counters.insert(uint(Some(s), "a Soul")?);
    }
    let id = |v: Option<&Value>, what: &str| -> Result<Id, Refusal> {
        let n = uint(v, what)?;
        let scope = if soul_counters.contains(&n) {
            FIXTURE_SCOPE_SOULS
        } else {
            FIXTURE_SCOPE_A
        };
        mint(scope, n)
    };
    let mut draft = Draft {
        kinds: kinds.clone(),
        ..Draft::default()
    };
    for n in &soul_counters {
        draft.souls.insert(mint(FIXTURE_SCOPE_SOULS, *n)?);
    }
    let Some(Value::Map(auds)) = w.get(&2) else {
        return source("section 2 maps audiences to Souls");
    };
    for (n, members) in auds {
        if *n == EVERYONE {
            return source("audience 0 is everyone and is not written");
        }
        let set = array(Some(members), "an audience")?
            .iter()
            .map(|m| id(Some(m), "a member"))
            .collect::<Result<_, _>>()?;
        draft.audiences.insert(*n, Members::Only(set));
    }
    for n in array(w.get(&3), "section 3, the nodes")? {
        let Value::Map(n) = n else {
            return source("a node is a map");
        };
        draft.nodes.push(Node {
            id: id(n.get(&1), "a node's id")?,
            kind: text(n.get(&2), "a node's kind")?,
            parent: n.get(&3).map(|p| id(Some(p), "a parent")).transpose()?,
            slot: n.get(&4).map(|s| uint(Some(s), "a slot")).transpose()?,
            audience: n
                .get(&5)
                .map_or(Ok(EVERYONE), |a| uint(Some(a), "an audience"))?,
            fields: match n.get(&6) {
                None => BTreeMap::new(),
                Some(Value::Map(f)) => f.clone(),
                Some(_) => return source("a node's fields are a map"),
            },
        });
    }
    for l in array(w.get(&4), "section 4, the links")? {
        let Value::Map(l) = l else {
            return source("a link is a map");
        };
        let ends = array(l.get(&3), "a link's ends")?;
        let [a, b] = ends else {
            return source("a link has two ends");
        };
        draft.links.push(Link {
            id: id(l.get(&1), "a link's id")?,
            ty: text(l.get(&2), "a link's type")?,
            ends: [id(Some(a), "an end")?, id(Some(b), "an end")?],
            owner: match uint(l.get(&4), "a link's owning end")? {
                0 => End::First,
                1 => End::Second,
                _ => return source("a link's owning end is 0 or 1"),
            },
            audience: uint(l.get(&5), "a link's audience")?,
        });
    }
    Ok(draft)
}

/// The fixtures, by file name, for tests and the page.
pub const FIXTURE_KINDS: &str = include_str!("../fixtures/world-model/kinds.diag");
pub const FIXTURES: [(&str, &str); 5] = [
    (
        "door.diag",
        include_str!("../fixtures/world-model/door.diag"),
    ),
    (
        "boat.diag",
        include_str!("../fixtures/world-model/boat.diag"),
    ),
    (
        "carried-load.diag",
        include_str!("../fixtures/world-model/carried-load.diag"),
    ),
    (
        "ownership.diag",
        include_str!("../fixtures/world-model/ownership.diag"),
    ),
    (
        "membership.diag",
        include_str!("../fixtures/world-model/membership.diag"),
    ),
];
