//! Joined parts hold each other up (Engine v2 B18, #3339): every change to a bay leaves each of its parts standing,
//! held or joined, and a change that would leave one hanging is refused by name before anything moves.
//!
//! - **The rule, carried over from today's** (`mars/viewer/engine/construction/rules.ts` `groupStability`,
//!   `isSupported`; `invariants.ts` `uprightsSupported`). A part held by at least its kind's hold crew is supported.
//!   A standing part (a kind other parts join to, an upright) is supported too when it and another standing part of
//!   the bay are joined by bearing parts on both columns at the heights its kind needs: one for a frame up to 9.5 ft,
//!   two above. A bearing part (a kind that declares a joining link to a standing kind, a beam) is supported when its
//!   joints reach as many supported standing parts as its declared link allows (two ends).
//! - **What the kinds say** (K3, B17): which kinds stand and which bear is read from the link types they declare
//!   (section 4) and their connectors (`joint` points); a hold crew from their `hold_crew` field; a frame's height
//!   from its geometry (section 7); a bearing part's column and height from the bay slot it sits in (its place in the
//!   bay's frame: x below zero is the left column, above it the right). No kind is named here.
//! - **A holder** is a body linked to a standing part through a joint activity (B5): a started activity whose node
//!   is a child of the part, and its membership links. A holder leaving is a change like any other.
//! - **What it reads, and when.** At commit, on the one write path ([`crate::commit::write_guarded`], so acts and a
//!   creator's edits) and on an activity's write ([`crate::activity`]), before the part applies: the bays the part's
//!   changes touch (a bay is found from a changed node by its parent, at most three steps up), each bay's children
//!   and their `joint` links and holders as the tree has them, with the part's changes laid over that small copy.
//!   A part that touches no bay costs the walk up and runs no check ([`Structure::checks`] counts the checks).
//! - **Refusals:** `support.holders` (a part held by some, fewer than its crew, and not joined to stand) and
//!   `support.none` (the part, and what it would hang by). The verdict is computed each time, never stored.
//!
//! - **A part moved by a transfer** (B19, `crate::activity::seating`): a leave and arrive inside the zone is read as
//!   the change of parent it makes, so a part handed into a bay's slot, out of it to a carry, and a crew's node moved
//!   to a part (a hold) or off it are checked like any other change.
//!
//! Not here: load numbers, decks and stairs, a part's own pose (a part in a bay's slot stands).

#[cfg(test)]
mod tests;

use replica::activity::{F_STATE, MEMBER};
use replica::effects::{Body, Change, Effect, Refusal, TransferRec};
use replica::encode::Value;
use replica::ids::{Id, KindSource};
use replica::kinds::Kinds;
use replica::pose::Frame;
use replica::tree::Tree;
use replica::world_model::{plain, show};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// A frame taller than this, mm, needs bearing parts at two heights on each column; one at or below needs one
/// (`requiredLevels`: 9.5 ft).
pub const ONE_LEVEL_MOST_MM: i64 = 2_896;
/// How far up from a changed node a bay is looked for: an activity, its standing part, the bay.
const UP_MOST: usize = 3;
/// An activity's state when started (`replica::activity::State`).
const STARTED: u64 = 2;

type R<T> = Result<T, Refusal>;

/// What a kind is to the rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    /// Others join to it; it stands held or braced. `levels`: the heights it needs on each column.
    Standing { crew: u64, levels: usize },
    /// It joins to standing parts and hangs by them: `ends` supported ones needed.
    Bearing { crew: u64, ends: usize },
}

/// A slot of a bay: its column (-1 left, 1 right, 0 neither) and height, mm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Spot {
    column: i8,
    height: i64,
}

/// The rule's reading of a world's kinds, by their names without their hashes (a running world's kinds are pinned by
/// its facts, its rule read from its entries: the same kinds, other hashes; B20 #3356). Empty (the default) for a world
/// without joining kinds: then no change is checked.
#[derive(Debug, Default)]
pub struct Structure {
    roles: BTreeMap<String, Role>,
    bays: BTreeMap<String, BTreeMap<u64, Spot>>,
    joints: BTreeSet<String>,
    checks: AtomicU64,
}

/// One bay as the rule sees it: its parts and their slots, the joints between them, and the activities on its parts.
#[derive(Clone, Debug, Default)]
struct Bay {
    gone: bool,
    parts: BTreeMap<Id, (Role, Option<u64>)>,
    /// link → (bearing part, standing part)
    joints: BTreeMap<Id, (Id, Id)>,
    /// activity → (the part it holds, started, membership links)
    acts: BTreeMap<Id, (Id, bool, BTreeSet<Id>)>,
}

fn uint(v: Option<&Value>) -> Option<u64> {
    match v {
        Some(Value::Uint(n)) => Some(*n),
        _ => None,
    }
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(n) => i64::try_from(*n).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

/// A kind's height, mm: section 7's bounds, `{1: [x, y, z]}`.
fn height_of(text: &str) -> Option<(String, i64)> {
    let src = KindSource::parse(text).ok()?;
    let Some(Value::Map(g)) = src.sections().get(&7) else {
        return None;
    };
    let Some(Value::Array(b)) = g.get(&1) else {
        return None;
    };
    Some((src.name().to_owned(), int(b.get(1)?)?))
}

impl Structure {
    /// Reads a world's entries (`souls-entry/1`, by name, as a running world's rules carry them: B20, #3356): each
    /// turned into its kind (K3's `entry_to_kind`, its forms and timed fields left out, as `worldd` loads them for its
    /// forms) and read as [`Structure::new`] reads kinds. Entries with no joining kind give the empty rule.
    pub fn from_entries(entries: &replica::rules::json::Value) -> Structure {
        use replica::rules::json::Value as J;
        let texts: Vec<(String, String)> = entries
            .obj()
            .unwrap_or(&[])
            .iter()
            .filter_map(|(name, entry)| {
                let mut e = entry.clone();
                if let J::Obj(o) = &mut e {
                    o.retain(|(k, _)| k != "forms");
                    if let Some((_, J::Obj(state))) = o.iter_mut().find(|(k, _)| k == "state") {
                        state.retain(|(_, f)| f.get("type").and_then(J::str) != Some("timed"));
                    }
                }
                let text = replica::kinds::entry::entry_to_kind(&e.to_json()).ok()?;
                Some((name.clone(), text))
            })
            .collect();
        let sources: Vec<(&str, &str)> = texts
            .iter()
            .map(|(n, t)| (n.as_str(), t.as_str()))
            .collect();
        let mut kinds = Kinds::default();
        kinds.load(&sources);
        Structure::new(&kinds, &sources)
    }

    /// The kinds the rule read, by name: its bays, its standing parts and its bearing parts (a running world prints
    /// them as it starts, B20 #3356).
    pub fn kinds(&self) -> (Vec<&str>, Vec<&str>, Vec<&str>) {
        let of = |standing: bool| {
            self.roles
                .iter()
                .filter(|(_, r)| matches!(r, Role::Standing { .. }) == standing)
                .map(|(n, _)| n.as_str())
                .collect()
        };
        (
            self.bays.keys().map(String::as_str).collect(),
            of(true),
            of(false),
        )
    }

    /// Reads `kinds`, with `sources` (the texts they were loaded from) for their heights.
    pub fn new(kinds: &Kinds, sources: &[(&str, &str)]) -> Structure {
        let heights: BTreeMap<String, i64> =
            sources.iter().filter_map(|(_, t)| height_of(t)).collect();
        let defs: Vec<_> = kinds
            .admits()
            .into_keys()
            .filter_map(|n| kinds.get(&n))
            .collect();
        let crew = |name: &str| {
            kinds.get(name).and_then(|k| {
                k.state
                    .values()
                    .find(|f| f.name.as_str() == "hold_crew")
                    .and_then(|f| uint(Some(&f.default)))
            })
        };
        let mut s = Structure::default();
        // Bearing kinds declare a link to a kind that joins; that kind stands.
        for k in &defs {
            if !k.joins() {
                continue;
            }
            for l in k.links.values() {
                let standing: Vec<_> = defs
                    .iter()
                    .filter(|o| o.joins() && plain(o.name.as_str()) == l.from.as_str())
                    .collect();
                if standing.is_empty() {
                    continue;
                }
                // A link's type in the tree is a name: the declaring kind's namespace and the link's own name.
                let ns = plain(k.name.as_str()).split(':').next().unwrap_or("");
                s.joints.insert(format!("{ns}:{}", l.name.as_str()));
                let ends = l.most.unwrap_or(2) as usize;
                s.roles.insert(
                    plain(k.name.as_str()).to_owned(),
                    Role::Bearing {
                        crew: crew(k.name.as_str()).unwrap_or(1),
                        ends,
                    },
                );
                for o in standing {
                    let h = heights.get(plain(o.name.as_str())).copied().unwrap_or(0);
                    s.roles.insert(
                        plain(o.name.as_str()).to_owned(),
                        Role::Standing {
                            crew: crew(o.name.as_str()).unwrap_or(1),
                            levels: if h > ONE_LEVEL_MOST_MM { 2 } else { 1 },
                        },
                    );
                }
            }
        }
        // A bay: a kind whose slots admit a standing kind and a bearing one (a stand that holds frames is not a bay).
        let of = |standing: bool| -> BTreeSet<&str> {
            s.roles
                .iter()
                .filter(|(_, r)| matches!(r, Role::Standing { .. }) == standing)
                .map(|(n, _)| plain(n))
                .collect()
        };
        let (standing, bearing) = (of(true), of(false));
        let admits = |k: &&replica::kinds::KindDef, set: &BTreeSet<&str>| {
            k.slots
                .values()
                .any(|sl| sl.admits.iter().any(|a| set.contains(a.as_str())))
        };
        for k in &defs {
            if !admits(k, &standing) || !admits(k, &bearing) {
                continue;
            }
            let spots = k
                .slots
                .iter()
                .map(|(n, sl)| {
                    let [x, y, _] = sl.at_mm.unwrap_or([0, 0, 0]);
                    let column = x.signum() as i8;
                    (*n, Spot { column, height: y })
                })
                .collect();
            s.bays.insert(plain(k.name.as_str()).to_owned(), spots);
        }
        s
    }

    /// Bay checks run since the structure was made.
    pub fn checks(&self) -> u64 {
        self.checks.load(Relaxed)
    }

    fn kind_of(&self, tree: &Tree, id: Id, made: &BTreeMap<Id, (Id, String)>) -> Option<String> {
        if let Some((_, k)) = made.get(&id) {
            return Some(plain(k).to_owned());
        }
        tree.handle(id)
            .and_then(|h| tree.node(h))
            .map(|n| plain(n.kind().as_str()).to_owned())
    }

    fn parent_of(tree: &Tree, id: Id, made: &BTreeMap<Id, (Id, String)>) -> Option<Id> {
        if let Some((p, _)) = made.get(&id) {
            return Some(*p);
        }
        tree.handle(id)
            .and_then(|h| tree.node(h))
            .and_then(|n| n.parent())
    }

    /// The bay `id` is in or is, looking at most [`UP_MOST`] steps up.
    fn bay_of(&self, tree: &Tree, id: Id, made: &BTreeMap<Id, (Id, String)>) -> Option<Id> {
        let mut at = id;
        for _ in 0..=UP_MOST {
            if self.bays.contains_key(&self.kind_of(tree, at, made)?) {
                return Some(at);
            }
            at = Self::parent_of(tree, at, made)?;
        }
        None
    }

    /// Checks the changes of `effects`, as if applied to `tree`, against the rule: the first part of a touched bay
    /// left unsupported is refused (see the module's notes). A part touching no bay is not checked.
    pub fn check(&self, tree: &Tree, effects: &[Effect]) -> R<()> {
        if self.bays.is_empty() {
            return Ok(());
        }
        // Where each node created or moved by the part ends up, and its kind. A transfer's leave inside the zone (B19:
        // a part handed to a slot or to a carry) is read as the change of parent it makes, from where the node is
        // when it leaves.
        let mut made: BTreeMap<Id, (Id, String)> = BTreeMap::new();
        let mut changes: Vec<Change> = Vec::new();
        for e in effects {
            match &e.body {
                Body::Changes(cs) => {
                    for c in cs {
                        if let Change::Create {
                            node, kind, pose, ..
                        } = &c.change
                        {
                            made.insert(*node, (pose.frame.node, kind.as_str().to_owned()));
                        }
                        changes.push(c.change.clone());
                    }
                }
                Body::Transfer(TransferRec::Leave { node, pose, .. }) => {
                    let (Some(from), Some(kind)) = (
                        Self::parent_of(tree, *node, &made),
                        self.kind_of(tree, *node, &made),
                    ) else {
                        continue;
                    };
                    let slot = tree
                        .handle(*node)
                        .and_then(|h| tree.node(h))
                        .and_then(|n| n.slot());
                    made.insert(*node, (pose.frame.node, kind));
                    changes.push(Change::Reparent {
                        node: *node,
                        from: Frame { node: from, slot },
                        pose: *pose,
                    });
                }
                _ => {}
            }
        }
        let mut bays = BTreeSet::new();
        let mut touched = BTreeSet::new();
        for c in &changes {
            let named: Vec<Id> = match c {
                Change::Create { node, .. }
                | Change::Remove { node }
                | Change::Set { node, .. } => {
                    vec![*node]
                }
                Change::Reparent { node, from, pose } => vec![*node, from.node, pose.frame.node],
                Change::Link { ends, .. } => ends.to_vec(),
                Change::Unlink { link } => {
                    tree.link(*link).map_or(vec![], |(_, e, _, _)| e.to_vec())
                }
                _ => vec![],
            };
            for id in named {
                touched.insert(id);
                touched.extend(Self::parent_of(tree, id, &made));
                bays.extend(self.bay_of(tree, id, &made));
            }
        }
        for bay in bays {
            self.checks.fetch_add(1, Relaxed);
            let mut b = self.read(tree, bay);
            for c in &changes {
                self.lay(tree, &mut b, bay, c);
            }
            let spots = self
                .kind_of(tree, bay, &made)
                .and_then(|k| self.bays.get(&k));
            if let (false, Some(spots)) = (b.gone, spots) {
                b.verdict(spots, &touched)?;
            }
        }
        Ok(())
    }

    /// A bay as the tree holds it now (empty when it is not there yet).
    fn read(&self, tree: &Tree, bay: Id) -> Bay {
        let mut b = Bay::default();
        let Some(h) = tree.handle(bay) else {
            return b;
        };
        for c in tree.children(h).unwrap_or(&[]).to_vec() {
            let Some(n) = tree.node(c) else { continue };
            if let Some(role) = self.roles.get(plain(n.kind().as_str())) {
                b.parts.insert(n.id(), (*role, n.slot()));
            }
        }
        let parts: Vec<Id> = b.parts.keys().copied().collect();
        for p in parts {
            self.read_links(tree, &mut b, p);
            let Some(h) = tree.handle(p) else { continue };
            for a in tree.children(h).unwrap_or(&[]).to_vec() {
                let Some(n) = tree.node(a) else { continue };
                if let Some((started, members)) = Self::act(tree, n.id()) {
                    b.acts.insert(n.id(), (p, started, members));
                }
            }
        }
        b
    }

    /// Whether `node` is an activity as the tree holds it: started, and its membership links.
    fn act(tree: &Tree, node: Id) -> Option<(bool, BTreeSet<Id>)> {
        let n = tree.handle(node).and_then(|h| tree.node(h))?;
        let state = uint(n.fields().get(&F_STATE))?;
        let members = tree
            .links_of(tree.handle(node)?)
            .unwrap_or(&[])
            .iter()
            .filter(|e| tree.ty(e).as_str() == MEMBER)
            .map(|e| e.link)
            .collect();
        Some((state == STARTED, members))
    }

    /// Whether links of type `ty` (a full link type name) are joints: the rule reads them.
    pub fn joint(&self, ty: &str) -> bool {
        self.joints.contains(ty)
    }

    /// The joints at part `p` whose other end is a part of the bay.
    fn read_links(&self, tree: &Tree, b: &mut Bay, p: Id) {
        let Some(h) = tree.handle(p) else { return };
        for e in tree.links_of(h).unwrap_or(&[]) {
            if !self.joints.contains(tree.ty(e).as_str()) {
                continue;
            }
            if let Some(j) = b.joint(p, e.other) {
                b.joints.insert(e.link, j);
            }
        }
    }

    /// Lays one change over the bay.
    fn lay(&self, tree: &Tree, b: &mut Bay, bay: Id, c: &Change) {
        match c {
            Change::Create {
                node,
                kind,
                pose,
                fields,
                ..
            } => {
                if *node == bay {
                    b.gone = false;
                } else if pose.frame.node == bay {
                    if let Some(role) = self.roles.get(plain(kind.as_str())) {
                        b.parts.insert(*node, (*role, pose.frame.slot));
                    }
                } else if b.parts.contains_key(&pose.frame.node)
                    && let Some(state) = uint(fields.get(&F_STATE))
                {
                    b.acts
                        .insert(*node, (pose.frame.node, state == STARTED, BTreeSet::new()));
                }
            }
            Change::Remove { node } => {
                if *node == bay {
                    b.gone = true;
                }
                b.drop_part(*node);
                b.acts.remove(node);
            }
            Change::Reparent { node, from, pose } => {
                if from.node == bay && pose.frame.node != bay {
                    b.drop_part(*node);
                } else if pose.frame.node == bay {
                    let kind = tree
                        .handle(*node)
                        .and_then(|h| tree.node(h))
                        .map(|n| plain(n.kind().as_str()).to_owned());
                    if let Some(role) = kind.and_then(|k| self.roles.get(&k).copied()) {
                        let fresh = !b.parts.contains_key(node);
                        b.parts.insert(*node, (role, pose.frame.slot));
                        if fresh {
                            self.read_links(tree, b, *node);
                        }
                    }
                } else if b.acts.get(node).is_some_and(|a| a.0 == from.node) {
                    // An activity that held a part leaves it (B19: a hold becomes a carry again).
                    b.acts.remove(node);
                } else if b.parts.contains_key(&pose.frame.node)
                    && let Some(a) = Self::act(tree, *node)
                {
                    // An activity comes to a part (B19: a carry becomes a hold), with its members.
                    b.acts.insert(*node, (pose.frame.node, a.0, a.1));
                }
            }
            Change::Set {
                node, field, to, ..
            } if *field == F_STATE => {
                if let Some(a) = b.acts.get_mut(node) {
                    a.1 = uint(Some(to)) == Some(STARTED);
                }
            }
            Change::Link { link, ty, ends, .. } => {
                if self.joints.contains(ty.as_str()) {
                    if let Some(j) = b.joint(ends[0], ends[1]) {
                        b.joints.insert(*link, j);
                    }
                } else if ty.as_str() == MEMBER {
                    for end in ends {
                        if let Some(a) = b.acts.get_mut(end) {
                            a.2.insert(*link);
                        }
                    }
                }
            }
            Change::Unlink { link } => {
                b.joints.remove(link);
                for a in b.acts.values_mut() {
                    a.2.remove(link);
                }
            }
            _ => {}
        }
    }
}

impl Bay {
    /// `(bearing, standing)` when one of `x`, `y` is a bearing part of the bay and the other a standing one.
    fn joint(&self, x: Id, y: Id) -> Option<(Id, Id)> {
        let role = |id| self.parts.get(&id).map(|p| p.0);
        match (role(x)?, role(y)?) {
            (Role::Bearing { .. }, Role::Standing { .. }) => Some((x, y)),
            (Role::Standing { .. }, Role::Bearing { .. }) => Some((y, x)),
            _ => None,
        }
    }

    fn drop_part(&mut self, id: Id) {
        if self.parts.remove(&id).is_some() {
            self.joints.retain(|_, (b, s)| *b != id && *s != id);
            self.acts.retain(|_, a| a.0 != id);
        }
    }

    fn holders(&self, part: Id) -> usize {
        self.acts
            .values()
            .filter(|a| a.0 == part && a.1)
            .map(|a| a.2.len())
            .sum()
    }

    /// The standing parts each bearing part is joined to.
    fn ends(&self, bearing: Id) -> BTreeSet<Id> {
        self.joints
            .values()
            .filter(|(b, _)| *b == bearing)
            .map(|(_, s)| *s)
            .collect()
    }

    /// For standing part `u` and another `v`: the heights on the left and right columns of bearing parts joined to
    /// both.
    fn braces(&self, u: Id, v: Id, spots: &BTreeMap<u64, Spot>) -> [BTreeSet<i64>; 2] {
        let mut cols = [BTreeSet::new(), BTreeSet::new()];
        for (bearing, (_, slot)) in &self.parts {
            let ends = self.ends(*bearing);
            if !(ends.contains(&u) && ends.contains(&v)) {
                continue;
            }
            match slot.and_then(|s| spots.get(&s)) {
                Some(Spot {
                    column: -1, height, ..
                }) => {
                    cols[0].insert(*height);
                }
                Some(Spot {
                    column: 1, height, ..
                }) => {
                    cols[1].insert(*height);
                }
                _ => {}
            }
        }
        cols
    }

    /// A part left unsupported, refused (see the module's notes): of those, one the change named first (`named`, with
    /// its parent, so an activity stands for the part it holds).
    fn verdict(&self, spots: &BTreeMap<u64, Spot>, named: &BTreeSet<Id>) -> R<()> {
        let standing: Vec<Id> = self
            .parts
            .iter()
            .filter(|(_, p)| matches!(p.0, Role::Standing { .. }))
            .map(|(id, _)| *id)
            .collect();
        let mut up = BTreeSet::new();
        let mut failed: Vec<(u8, Refusal)> = Vec::new();
        for u in &standing {
            let Some((Role::Standing { crew, levels }, _)) = self.parts.get(u).copied() else {
                continue;
            };
            let held = self.holders(*u);
            if held as u64 >= crew {
                up.insert(*u);
                continue;
            }
            let mut best = [0, 0];
            for v in standing.iter().filter(|v| *v != u) {
                let cols = self.braces(*u, *v, spots);
                let n = [cols[0].len(), cols[1].len()];
                if n[0] + n[1] > best[0] + best[1] {
                    best = n;
                }
            }
            if best[0] >= levels && best[1] >= levels {
                up.insert(*u);
                continue;
            }
            let braced = format!(
                "braced by beams on the left column at {} and the right at {} of the {levels} height{} it needs",
                best[0],
                best[1],
                if levels > 1 { "s" } else { "" }
            );
            let r = if held > 0 {
                Refusal {
                    name: "support.holders",
                    detail: format!(
                        "{} would stand held by {held} of the {crew} it needs, {braced}",
                        show(*u)
                    ),
                }
            } else {
                Refusal {
                    name: "support.none",
                    detail: format!("{} would stand held by nobody, {braced}", show(*u)),
                }
            };
            failed.push((if named.contains(u) { 1 } else { 3 }, r));
        }
        for (b, (role, _)) in &self.parts {
            let Role::Bearing { crew, ends } = *role else {
                continue;
            };
            if self.holders(*b) as u64 >= crew {
                continue;
            }
            let joined = self.ends(*b);
            if joined.iter().filter(|s| up.contains(*s)).count() >= ends {
                continue;
            }
            let by = if joined.is_empty() {
                "nothing".to_owned()
            } else {
                let list: Vec<String> = joined.iter().map(|s| show(*s)).collect();
                format!(
                    "its joint{} to {}",
                    if joined.len() > 1 { "s" } else { "" },
                    list.join(" and ")
                )
            };
            let r = Refusal {
                name: "support.none",
                detail: format!(
                    "{} would hang by {by}; it needs {ends} joined to parts that stand",
                    show(*b)
                ),
            };
            failed.push((if named.contains(b) { 0 } else { 2 }, r));
        }
        // The part the change named comes first, a bearing part before a standing one; then the rest, in id order.
        failed.sort_by_key(|(rank, _)| *rank);
        failed.into_iter().next().map_or(Ok(()), |(_, r)| Err(r))
    }
}
