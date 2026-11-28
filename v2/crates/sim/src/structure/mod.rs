//! Joined parts hold each other up (Engine v2 B18, #3339): every change to a bay leaves each of its parts standing,
//! held or joined, and a change that would leave one hanging is refused by name before anything moves.
//!
//! - **The rule, carried over from today's** (`mars/viewer/engine/construction/rules.ts` `groupStability`,
//!   `isSupported`; `invariants.ts` `uprightsSupported`). A part held by at least its kind's hold crew is supported.
//!   A standing part (a kind other parts join to, an upright) is supported too when it and another standing part of
//!   the bay are joined by bearing parts on both columns at the heights its kind needs: one for a frame up to 9.5 ft,
//!   two above. A bearing part (a kind that declares a joining link to a standing kind, a beam) is supported when its
//!   joints reach as many supported standing parts as its declared link allows (two ends). A resting part (a kind that
//!   declares a joining link to a kind that itself bears or rests: a shade cloth on its rails, a joist on two beams, a
//!   sheet on its joists, a tread on its flight) is supported when its joints reach as many supported parts of the
//!   kinds it names as its link allows, so it needs all it rests on in place, and none of those leaves from under it.
//! - **To any depth** (racks T3). A kind's tier is one more than the deepest kind its joining links name; a standing
//!   kind's is 0, so a beam is 1, a joist 2, a sheet on joists 3, and content may go on. Nothing in the rule counts
//!   tiers: a part is held up when it is held by its crew or enough of the parts it is joined down to are held up,
//!   found by starting from the standing parts and adding parts until none is added. Kinds that name each other in a
//!   ring have nothing to start from, so their parts are held up only by a crew. A joint counts only between a part
//!   and one of a kind its own kind names ([`Structure::rests_on`]): a sheet joined to a beam rests on nothing.
//! - **What stays rack-shaped.** Only how a standing part is braced: by bearing parts (tier 1) joined to it and one
//!   other standing part, on a left and a right column read from the sign of the slot's x, at one height or two by
//!   9.5 ft. Deeper parts never brace. A four-post stage or a scaffold would say its bracing in content; the two-storey
//!   rack unit needs none of that, so it is not built here.
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
//! - **Nothing leaves with someone on it** (racks T6, T9): a part taken out of its bay, or removed from it, while
//!   anything is on it is refused `part.stood-on`, naming what is on it and the part. On it: a child of the part that
//!   is not a crew holding it (a body in a standing place the part gives, a thing in its slot), and whoever or
//!   whatever is on a floor the part holds (a body standing on a seated sheet; a floor's rooms, windows and places
//!   are the floor's own). What leaves in the same change does not count. With `support.none` under it, nobody is
//!   left standing on nothing: the part under a body's feet stays, and so does every part that one rests on.
//!
//! - **A part moved by a transfer** (B19, `crate::activity::seating`): a leave and arrive inside the zone is read as
//!   the change of parent it makes, so a part handed into a bay's slot, out of it to a carry, and a crew's node moved
//!   to a part (a hold) or off it are checked like any other change.
//!
//! Not here: load numbers, spans and overhangs (a sheet rests on the joists its joints name, however far apart), a
//! part's own pose (a part in a bay's slot stands). A kind with more than one joining link is counted against the
//! largest `most` among them, over all the kinds they name.

#[cfg(test)]
mod deck_tests;
#[cfg(test)]
mod shade_tests;
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
/// A crew's field (0.135 A2): the holders its hold still counts for after its last holder left the world and setting
/// its part down would have left another hanging. The hold is kept until another crew holds the part; 0 or absent is
/// none.
pub const F_KEPT: u64 = 5;

type R<T> = Result<T, Refusal>;

/// What a kind is to the rule: its number among the joining kinds (their plain names in order), its hold crew, and
/// how it is held up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Role {
    kind: u16,
    crew: u64,
    how: How,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum How {
    /// Others join to it; it stands held or braced. `levels`: the heights it needs on each column.
    Standing { levels: usize },
    /// It joins down to parts of the kinds its links name and is held up by them: `ends` supported ones needed.
    /// `tier`: how deep it sits above a standing part (a beam 1: it hangs by its ends; a cloth on rails or a joist on
    /// beams 2, a sheet on joists 3: they rest). [`NO_TIER`] for a kind in a ring of kinds that name each other.
    Borne { ends: usize, tier: u16 },
}

/// The tier of a kind no chain of links leads down from to a standing kind.
const NO_TIER: u16 = u16::MAX;

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
    /// (a kind, a kind its joining links name): parts of the first are held up by parts of the second.
    on: BTreeSet<(u16, u16)>,
    /// Each joining kind's connectors: (its connector's kind, the kind it mates), by plain kind name.
    connectors: BTreeMap<String, BTreeSet<(String, String)>>,
    /// The kinds a standing part admits among its children, by plain name: its crews (B19's holders, 0.135 A2).
    crews: BTreeSet<String>,
    checks: AtomicU64,
}

/// One bay as the rule sees it: its parts and their slots, the joints between them, and the activities on its parts.
#[derive(Clone, Debug, Default)]
struct Bay {
    gone: bool,
    parts: BTreeMap<Id, (Role, Option<u64>)>,
    /// link → (a part, the part it is joined down to): a beam and a frame, a cloth and a rail, a sheet and a joist
    joints: BTreeMap<Id, (Id, Id)>,
    /// activity → (the part it holds, started, membership links)
    acts: BTreeMap<Id, (Id, bool, BTreeSet<Id>)>,
    /// activity → the holders its kept hold stands for ([`F_KEPT`]).
    kept: BTreeMap<Id, u64>,
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
                    o.retain(|(k, _)| k != "forms" && k != "roles");
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
                .filter(|(_, r)| matches!(r.how, How::Standing { .. }) == standing)
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
        for k in defs.iter().filter(|k| k.joins()) {
            let set = k
                .points
                .values()
                .filter_map(|p| p.connector.as_ref())
                .map(|c| (c.kind.as_str().to_owned(), c.mates.as_str().to_owned()))
                .collect();
            s.connectors.insert(plain(k.name.as_str()).to_owned(), set);
        }
        // Every joining kind has a number: its plain name's place in their order.
        let names: BTreeSet<&str> = defs
            .iter()
            .filter(|k| k.joins())
            .map(|k| plain(k.name.as_str()))
            .collect();
        let number = |name: &str| names.iter().position(|n| *n == name).map(|i| i as u16);
        // A kind that declares a link to a kind that joins is held up by parts of that kind. `below`: each such kind's
        // number, the kinds its links name, the most any of them allows and its hold crew.
        let mut below: BTreeMap<u16, (BTreeSet<u16>, usize, u64)> = BTreeMap::new();
        for k in defs.iter().filter(|k| k.joins()) {
            let Some(me) = number(plain(k.name.as_str())) else {
                continue;
            };
            for l in k.links.values() {
                let Some(other) = number(l.from.as_str()) else {
                    continue;
                };
                // A link's type in the tree is a name: the declaring kind's namespace and the link's own name.
                let ns = plain(k.name.as_str()).split(':').next().unwrap_or("");
                s.joints.insert(format!("{ns}:{}", l.name.as_str()));
                s.on.insert((me, other));
                let e = below
                    .entry(me)
                    .or_insert_with(|| (BTreeSet::new(), 0, crew(k.name.as_str()).unwrap_or(1)));
                e.0.insert(other);
                e.1 = e.1.max(l.most.unwrap_or(2) as usize);
            }
        }
        // A kind a link names that declares no joining link itself stands: tier 0. Each other kind's tier is one more
        // than the deepest it names, found in rounds; a ring of kinds never gets one.
        let mut tiers: BTreeMap<u16, u16> = BTreeMap::new();
        for k in defs.iter().filter(|k| k.joins()) {
            let name = plain(k.name.as_str());
            let Some(me) = number(name).filter(|me| !below.contains_key(me)) else {
                continue;
            };
            if !s.on.iter().any(|(_, o)| *o == me) {
                continue;
            }
            tiers.insert(me, 0);
            let h = heights.get(name).copied().unwrap_or(0);
            s.roles.insert(
                name.to_owned(),
                Role {
                    kind: me,
                    crew: crew(k.name.as_str()).unwrap_or(1),
                    how: How::Standing {
                        levels: if h > ONE_LEVEL_MOST_MM { 2 } else { 1 },
                    },
                },
            );
        }
        loop {
            let found: Vec<(u16, u16)> = below
                .iter()
                .filter(|(me, _)| !tiers.contains_key(*me))
                .filter_map(|(me, (under, ..))| {
                    let mut top = 0;
                    for o in under {
                        top = top.max(*tiers.get(o)?);
                    }
                    Some((*me, (top + 1).min(NO_TIER - 1)))
                })
                .collect();
            if found.is_empty() {
                break;
            }
            tiers.extend(found);
        }
        for (me, (_, ends, hold)) in &below {
            let Some(name) = names.iter().nth(*me as usize) else {
                continue;
            };
            s.roles.insert(
                (*name).to_owned(),
                Role {
                    kind: *me,
                    crew: *hold,
                    how: How::Borne {
                        ends: *ends,
                        tier: tiers.get(me).copied().unwrap_or(NO_TIER),
                    },
                },
            );
        }
        // A standing part's crew: a kind its entry names among its children (a frame admits the crew that holds it).
        for k in &defs {
            if s.stands(k.name.as_str()) {
                s.crews.extend(
                    k.admits
                        .children
                        .iter()
                        .filter(|c| c.contains(':'))
                        .cloned(),
                );
            }
        }
        // A bay: a kind whose slots admit a standing kind and a bearing one (a stand that holds frames is not a bay; a
        // resting kind alone does not make one).
        let of = |bearing: bool| -> BTreeSet<&str> {
            s.roles
                .iter()
                .filter(|(_, r)| match r.how {
                    How::Standing { .. } => !bearing,
                    How::Borne { tier, .. } => bearing && tier == 1,
                })
                .map(|(n, _)| plain(n))
                .collect()
        };
        let (standing, bearing) = (of(false), of(true));
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
        self.stood_on(tree, &changes)?;
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

    /// `part.stood-on` when `changes` take a part out of its bay, or remove it from it, with something on it (see the
    /// module's notes).
    fn stood_on(&self, tree: &Tree, changes: &[Change]) -> R<()> {
        let leaving: BTreeSet<Id> = changes
            .iter()
            .filter_map(|c| match c {
                Change::Reparent { node, .. } | Change::Remove { node } => Some(*node),
                _ => None,
            })
            .collect();
        let node = |id: Id| tree.handle(id).and_then(|h| tree.node(h));
        for c in changes {
            let (part, from) = match c {
                Change::Reparent { node, from, pose } if from.node != pose.frame.node => {
                    (*node, from.node)
                }
                Change::Remove { node: gone } => match node(*gone).and_then(|n| n.parent()) {
                    Some(p) => (*gone, p),
                    None => continue,
                },
                _ => continue,
            };
            let in_bay = node(from).is_some_and(|n| self.is_bay(n.kind().as_str()));
            let is_part = node(part).is_some_and(|n| self.is_part(n.kind().as_str()));
            if !in_bay || !is_part {
                continue;
            }
            if let Some(on) = Self::on_it(tree, part, &leaving) {
                return Err(Refusal {
                    name: "part.stood-on",
                    detail: format!(
                        "{} is on {}; it stays where it is until nothing is on it",
                        show(on),
                        show(part)
                    ),
                });
            }
        }
        Ok(())
    }

    /// The first thing on part `part` that is not in `leaving`: a child that is no crew holding it, or a child of a
    /// floor it holds that is not the floor's own room, window or place.
    fn on_it(tree: &Tree, part: Id, leaving: &BTreeSet<Id>) -> Option<Id> {
        use crate::ground::scene::{DOORWAY, FLOOR, PLACE, ROOM, WINDOW};
        let kids = |id: Id| -> Vec<(Id, String)> {
            tree.handle(id)
                .and_then(|h| tree.children(h))
                .unwrap_or(&[])
                .iter()
                .filter_map(|c| tree.node(*c))
                .map(|n| (n.id(), plain(n.kind().as_str()).to_owned()))
                .filter(|(id, _)| !leaving.contains(id))
                .collect()
        };
        for (child, kind) in kids(part) {
            if kind == FLOOR {
                let own = [ROOM, WINDOW, PLACE, DOORWAY];
                if let Some((on, _)) = kids(child)
                    .into_iter()
                    .find(|(_, k)| !own.contains(&k.as_str()))
                {
                    return Some(on);
                }
            } else if Self::act(tree, child).is_none() {
                return Some(child);
            }
        }
        None
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
                    b.kept
                        .insert(n.id(), uint(n.fields().get(&F_KEPT)).unwrap_or(0));
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

    /// Whether `kind` (a plain or full name) stands: others join to it, and it is held until it is braced.
    pub fn stands(&self, kind: &str) -> bool {
        self.roles
            .get(plain(kind))
            .is_some_and(|r| matches!(r.how, How::Standing { .. }))
    }

    /// Whether `kind` (a plain or full name) is a part the rule reads: one that stands, bears or rests.
    pub fn is_part(&self, kind: &str) -> bool {
        self.roles.contains_key(plain(kind))
    }

    /// Whether `kind` (a plain or full name) rests on parts that are themselves borne (tier 2 or deeper: a cloth on
    /// rails, a joist on beams, a sheet on joists): what a part of it joins in a bay are not the bay's standing parts.
    /// Which parts they are: [`Structure::rests_on`].
    pub fn rests(&self, kind: &str) -> bool {
        self.tier(kind).is_some_and(|t| t >= 2)
    }

    /// Whether `kind` (a plain or full name) bears: it joins standing parts (tier 1) and others may rest on it.
    pub fn bears(&self, kind: &str) -> bool {
        self.tier(kind) == Some(1)
    }

    /// How deep `kind` (a plain or full name) sits above a standing part: 0 a standing kind, 1 one that joins
    /// standing kinds, and one more for each kind between. None for a kind the rule does not read, or one in a ring
    /// of kinds that name each other.
    pub fn tier(&self, kind: &str) -> Option<u16> {
        match self.roles.get(plain(kind))?.how {
            How::Standing { .. } => Some(0),
            How::Borne { tier: NO_TIER, .. } => None,
            How::Borne { tier, .. } => Some(tier),
        }
    }

    /// Whether a part of `kind` is held up by parts of `under` (plain or full names): `kind` declares a joining link
    /// that names `under`. A beam rests on a frame, a joist on a beam, a sheet on a joist; a sheet on a beam does
    /// not, so a joint between those two holds nothing up.
    pub fn rests_on(&self, kind: &str, under: &str) -> bool {
        match (self.roles.get(plain(kind)), self.roles.get(plain(under))) {
            (Some(a), Some(b)) => self.on.contains(&(a.kind, b.kind)),
            _ => false,
        }
    }

    /// Whether `kind` (a plain or full name) is a crew: a kind a standing part admits as its holders.
    pub fn is_crew(&self, kind: &str) -> bool {
        self.crews.contains(plain(kind))
    }

    /// Whether `kind` (a plain or full name) is a bay: its slots take standing and bearing parts.
    pub fn is_bay(&self, kind: &str) -> bool {
        self.bays.contains_key(plain(kind))
    }

    /// The joints' link type, when the kinds declare one (a running world's seating makes its joints of it).
    pub fn joint_type(&self) -> Option<&str> {
        self.joints.iter().next().map(String::as_str)
    }

    /// `connectors-do-not-mate` unless a connector of kind `a` mates one of kind `b` both ways (plain or full names):
    /// a part joins only where its kind and the other's have mating connectors.
    pub fn mates(&self, a: &str, b: &str) -> R<()> {
        let of = |k: &str| self.connectors.get(plain(k));
        let fits = match (of(a), of(b)) {
            (Some(ca), Some(cb)) => ca
                .iter()
                .any(|(ka, ma)| cb.iter().any(|(kb, mb)| ma == kb && mb == ka)),
            _ => false,
        };
        if fits {
            return Ok(());
        }
        Err(Refusal {
            name: "connectors-do-not-mate",
            detail: format!("{} has no connector that mates with {}", plain(a), plain(b)),
        })
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
            if let Some(j) = b.joint(&self.on, p, e.other) {
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
                    let kept = tree
                        .handle(*node)
                        .and_then(|h| tree.node(h))
                        .and_then(|n| uint(n.fields().get(&F_KEPT)));
                    b.kept.insert(*node, kept.unwrap_or(0));
                }
            }
            Change::Set {
                node, field, to, ..
            } if *field == F_KEPT => {
                if b.acts.contains_key(node) {
                    b.kept.insert(*node, uint(Some(to)).unwrap_or(0));
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
                    if let Some(j) = b.joint(&self.on, ends[0], ends[1]) {
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
    /// `(a part, the part it is joined down to)` when `x` and `y` are parts of the bay and the kind of one names the
    /// kind of the other (`on`: [`Structure::rests_on`]): a beam and a frame, a cloth and a rail, a sheet and a joist.
    fn joint(&self, on: &BTreeSet<(u16, u16)>, x: Id, y: Id) -> Option<(Id, Id)> {
        let kind = |id| self.parts.get(&id).map(|p| p.0.kind);
        let (a, b) = (kind(x)?, kind(y)?);
        if on.contains(&(a, b)) {
            Some((x, y))
        } else if on.contains(&(b, a)) {
            Some((y, x))
        } else {
            None
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
            .iter()
            .filter(|(_, a)| a.0 == part && a.1)
            .map(|(id, a)| a.2.len() + self.kept.get(id).copied().unwrap_or(0) as usize)
            .sum()
    }

    /// The parts a part is joined down to: a bearing part's standing parts, a resting part's parts under it.
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
            .filter(|(_, p)| matches!(p.0.how, How::Standing { .. }))
            .map(|(id, _)| *id)
            .collect();
        let mut up = BTreeSet::new();
        let mut failed: Vec<(u8, Refusal)> = Vec::new();
        for u in &standing {
            let Some((
                Role {
                    crew,
                    how: How::Standing { levels },
                    ..
                },
                _,
            )) = self.parts.get(u).copied()
            else {
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
        // Every other part, the shallowest first: held by its crew, or joined down to enough parts that are held up.
        // Parts are added until none is: one pass for kinds in tiers, and a ring of kinds starts from nothing.
        let mut borne: Vec<(u16, Id, u64, usize)> = self
            .parts
            .iter()
            .filter_map(|(id, (role, _))| match role.how {
                How::Borne { ends, tier } => Some((tier, *id, role.crew, ends)),
                How::Standing { .. } => None,
            })
            .collect();
        borne.sort();
        let mut held_up = up;
        loop {
            let before = held_up.len();
            for (_, p, crew, ends) in &borne {
                if held_up.contains(p) {
                    continue;
                }
                let on = self
                    .ends(*p)
                    .iter()
                    .filter(|s| held_up.contains(*s))
                    .count();
                if self.holders(*p) as u64 >= *crew || on >= *ends {
                    held_up.insert(*p);
                }
            }
            if held_up.len() == before {
                break;
            }
        }
        for (tier, p, _, ends) in borne {
            if held_up.contains(&p) {
                continue;
            }
            let joined = self.ends(p);
            let list: Vec<String> = joined.iter().map(|s| show(*s)).collect();
            let detail = if tier == 1 {
                let by = if joined.is_empty() {
                    "nothing".to_owned()
                } else {
                    format!(
                        "its joint{} to {}",
                        if joined.len() > 1 { "s" } else { "" },
                        list.join(" and ")
                    )
                };
                format!(
                    "{} would hang by {by}; it needs {ends} joined to parts that stand",
                    show(p)
                )
            } else {
                // A resting part (a cloth, a joist, a sheet) rests on as many parts as its link allows, each held up.
                let on = joined.iter().filter(|b| held_up.contains(*b)).count();
                let by = if list.is_empty() {
                    "nothing".to_owned()
                } else {
                    list.join(" and ")
                };
                format!(
                    "{} would rest on {by}, {on} held up; it needs {ends} joined to parts that are held up",
                    show(p)
                )
            };
            let refusal = Refusal {
                name: "support.none",
                detail,
            };
            failed.push((if named.contains(&p) { 0 } else { 2 }, refusal));
        }
        // The part the change named comes first, a borne part (the shallowest first) before a standing one; then the
        // rest, in id order.
        failed.sort_by_key(|(rank, _)| *rank);
        failed.into_iter().next().map_or(Ok(()), |(_, r)| Err(r))
    }
}
