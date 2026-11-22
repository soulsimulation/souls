//! District plans and build claims (0.131 parity, #3701): a creator's agents share one world without stepping on
//! each other's work, as today's `build district` and `build claim` do.
//!
//! Both are world data, two fields of the zone's root, set by the creator's own edits, so they are in the world's
//! history and an undo or a rewind takes them back with everything else. All numbers are whole millimetres on the
//! root's ground (x, z) and millidegrees.
//!
//! - **District plans** ([`F_DISTRICTS`]): `[[id, title, plots, roads, chapters], ...]`; a plot is
//!   `[id, x, z, width, depth, yaw]` with an optional use name, a road `[id, width, [x, z, x, z, ...]]`, a chapter a
//!   list of plot ids. Ids, titles and uses are names as every text in an effect is (`namespace:name`, lowercase:
//!   `d:market`, `title:market-quarter`, `p:a`, `use:bakery`, `road:main`); the creator's command adds the prefixes. At most [`DISTRICTS_MOST`] plans, [`PLOTS_MOST`] plots and
//!   [`ROADS_MOST`] roads a plan, [`ROAD_POINTS_MOST`] points a road (today's limits). A malformed plan is refused
//!   `edit.district-malformed`.
//! - **Zones** ([`F_ZONES`], #3700): today's land-use areas, `[[zone:<name>, use:<use>, [x, z, ...]], ...]`, else
//!   `edit.zone-malformed`.
//! - **Claims** ([`F_CLAIMS`]): `[[id, part, x0, z0, x1, z1], ...]` (`c:house`, `part:roof`), at most [`CLAIMS_MOST`], none overlapping,
//!   else `edit.claim-malformed`. Releasing a claim is setting the field without it.
//!
//! The claim check, in [`super::check`] before the safety rule: an edit sent under a claim (its parameter 6) touches
//! only things inside that claim's area, before and after each operation, and never the root's fields
//! (`edit.outside-claim`); an edit sent under no claim does not touch anything inside a live claim (`edit.claimed`);
//! an edit naming a claim that is not live is refused `edit.claim-unknown`. Where a thing is: its origin in the root's
//! frame; a removal tests the whole subtree; a place tests its spot in its parent (a slot's offset aside).

use super::{Edit, Op, Ref, Refused, refuse};
use crate::apply::Replica;
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::pose::Vec3;
use std::collections::{BTreeMap, BTreeSet};

/// The root's field holding the district plans.
pub const F_DISTRICTS: u64 = 140;
/// The root's field holding the live claims.
pub const F_CLAIMS: u64 = 141;
pub const CLAIMS_MOST: usize = 8;
pub const DISTRICTS_MOST: usize = 32;
pub const PLOTS_MOST: usize = 48;
pub const ROADS_MOST: usize = 32;
pub const ROAD_POINTS_MOST: usize = 32;
/// The farthest a coordinate may be from the root's origin, mm (1000 km).
const FAR: i64 = 1_000_000_000;

/// A live claim: its id, the part of the work it is for, its area `[x0, z0, x1, z1]` in mm, x0 < x1, z0 < z1, and the
/// helper that builds under it (#3727): a creator-scope actor of its own, which may edit only under this claim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub id: Name,
    pub part: Name,
    pub area: [i64; 4],
    pub helper: Option<Id>,
}

impl Claim {
    /// Whether a point (µm, the root's frame) is inside, its far edges outside.
    fn holds(&self, p: Vec3) -> bool {
        let [x0, z0, x1, z1] = self.area.map(|v| v * 1000);
        (x0..x1).contains(&p.x) && (z0..z1).contains(&p.z)
    }

    fn show(&self) -> String {
        let [x0, z0, x1, z1] = self.area;
        format!(
            "claim {} ({}) over x {x0}..{x1}, z {z0}..{z1} mm",
            self.id.as_str(),
            self.part.as_str()
        )
    }
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn near(v: &Value) -> Result<i64, String> {
    int(v)
        .filter(|n| n.abs() <= FAR)
        .ok_or_else(|| format!("{v:?} is not a whole number of mm within {FAR}"))
}

fn name(v: &Value, what: &str) -> Result<Name, String> {
    match v {
        Value::Text(n) if !n.as_str().is_empty() && n.as_str().len() <= 64 => Ok(n.clone()),
        _ => Err(format!("{what} is a name")),
    }
}

fn list<'a>(v: &'a Value, what: &str, most: usize) -> Result<&'a [Value], String> {
    match v {
        Value::Array(a) if a.len() <= most => Ok(a),
        Value::Array(a) => Err(format!("{} {what}, over {most}", a.len())),
        _ => Err(format!("{what} are a list")),
    }
}

/// Every text in `v` is a name an effect may carry (`namespace:name`), else what is not.
fn names_only(v: &Value) -> Result<(), String> {
    crate::effects::not_a_name(v).map_or(Ok(()), |t| {
        Err(format!(
            "{t:?} is not a name like c:house (lowercase namespace:name)"
        ))
    })
}

/// A claim's helper as its row holds it: the name `helper:h<32 hex scope>-<counter>` (a name's part starts with a
/// letter), the creator-scope actor the gateway minted for it (#3727). An id's own form is read too.
fn helper_of(v: &Value) -> Result<Id, String> {
    let bad = || "a claim's helper is helper:h<32 hex>-<counter>".to_owned();
    match v {
        Value::Text(t) => {
            let (scope, n) = t
                .as_str()
                .strip_prefix("helper:h")
                .and_then(|r| r.split_once('-'))
                .ok_or_else(bad)?;
            let scope: [u8; 16] = crate::encode::from_hex(scope)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(bad)?;
            Id::new(crate::ids::Scope(scope), n.parse().map_err(|_| bad())?).ok_or_else(bad)
        }
        _ => crate::effects::read_id(v).map_err(|_| bad()),
    }
}

/// The claims a field value holds, checked: names, areas, the limit, no id twice, no overlap.
pub fn read_claims(v: &Value) -> Result<Vec<Claim>, String> {
    names_only(v)?;
    let mut out: Vec<Claim> = Vec::new();
    for row in list(v, "claims", CLAIMS_MOST)? {
        let Value::Array(r) = row else {
            return Err("a claim is [id, part, x0, z0, x1, z1]".into());
        };
        let ([id, part, x0, z0, x1, z1], helper) = (r.get(..6).unwrap_or(&[]), r.get(6)) else {
            return Err("a claim is [id, part, x0, z0, x1, z1, helper?]".into());
        };
        if r.len() > 7 {
            return Err("a claim is [id, part, x0, z0, x1, z1, helper?]".into());
        }
        let c = Claim {
            id: name(id, "a claim's id")?,
            part: name(part, "a claim's part")?,
            area: [near(x0)?, near(z0)?, near(x1)?, near(z1)?],
            helper: helper.map(helper_of).transpose()?,
        };
        let [x0, z0, x1, z1] = c.area;
        if x0 >= x1 || z0 >= z1 {
            return Err(format!("{}: x0 < x1 and z0 < z1", c.show()));
        }
        if let Some(o) = out.iter().find(|o| o.id == c.id) {
            return Err(format!("claim id {} is used twice", o.id.as_str()));
        }
        if let Some(o) = out
            .iter()
            .find(|o| c.helper.is_some() && o.helper == c.helper)
        {
            return Err(format!("{} has the helper of {}", c.show(), o.show()));
        }
        if let Some(o) = out.iter().find(|o| {
            let [a0, b0, a1, b1] = o.area;
            x0 < a1 && a0 < x1 && z0 < b1 && b0 < z1
        }) {
            return Err(format!("{} overlaps {}", c.show(), o.show()));
        }
        out.push(c);
    }
    Ok(out)
}

/// Checks a field value as district plans (see the module's notes).
pub fn read_districts(v: &Value) -> Result<(), String> {
    names_only(v)?;
    let mut ids = BTreeSet::new();
    for d in list(v, "district plans", DISTRICTS_MOST)? {
        let Value::Array(d) = d else {
            return Err("a plan is [id, title, plots, roads, chapters]".into());
        };
        let [id, title, plots, roads, chapters] = d.as_slice() else {
            return Err("a plan is [id, title, plots, roads, chapters]".into());
        };
        let id = name(id, "a plan's id")?;
        name(title, "a plan's title")?;
        if !ids.insert(id.clone()) {
            return Err(format!("plan {} is recorded twice", id.as_str()));
        }
        let mut plot_ids = BTreeSet::new();
        let plots = list(plots, "plots", PLOTS_MOST)?;
        if plots.is_empty() {
            return Err(format!("plan {} has no plots", id.as_str()));
        }
        for p in plots {
            let Value::Array(p) = p else {
                return Err("a plot is [id, x, z, width, depth, yaw, use?]".into());
            };
            let (head, rest) = p.split_at(p.len().min(6));
            let [pid, x, z, w, dep, yaw] = head else {
                return Err("a plot is [id, x, z, width, depth, yaw, use?]".into());
            };
            let pid = name(pid, "a plot's id")?;
            for v in [x, z, yaw] {
                near(v)?;
            }
            if [w, dep]
                .iter()
                .any(|v| near(v).is_ok_and(|n| n <= 0) || near(v).is_err())
            {
                return Err(format!(
                    "plot {}: width and depth are positive mm",
                    pid.as_str()
                ));
            }
            match rest {
                [] => {}
                [u] => {
                    name(u, "a plot's use")?;
                }
                _ => return Err("a plot is [id, x, z, width, depth, yaw, use?]".into()),
            }
            if !plot_ids.insert(pid.clone()) {
                return Err(format!(
                    "plot {} is in plan {} twice",
                    pid.as_str(),
                    id.as_str()
                ));
            }
        }
        for r in list(roads, "roads", ROADS_MOST)? {
            let Value::Array(r) = r else {
                return Err("a road is [id, width, [x, z, ...]]".into());
            };
            let [rid, w, path] = r.as_slice() else {
                return Err("a road is [id, width, [x, z, ...]]".into());
            };
            name(rid, "a road's id")?;
            if near(w).map_or(true, |n| n <= 0) {
                return Err("a road's width is positive mm".into());
            }
            let pts = list(path, "road coordinates", ROAD_POINTS_MOST * 2)?;
            if pts.len() < 4 || pts.len() % 2 != 0 {
                return Err("a road's path is at least two x, z points".into());
            }
            for v in pts {
                near(v)?;
            }
        }
        let mut chaptered = BTreeSet::new();
        for c in list(chapters, "chapters", PLOTS_MOST)? {
            for p in list(c, "a chapter's plots", 8)? {
                let p = name(p, "a chapter's plot")?;
                if !plot_ids.contains(&p) || !chaptered.insert(p.clone()) {
                    return Err(format!(
                        "chapter plot {} is unknown or in two chapters",
                        p.as_str()
                    ));
                }
            }
        }
    }
    Ok(())
}

/// The root's field holding the land-use zones (#3700): `[[name, use, [x, z, x, z, ...]], ...]`, a name `zone:<x>`,
/// a use one of [`USES`] as `use:<use>`, an outline of 3 to [`ZONE_POINTS_MOST`] points in mm, at most [`ZONES_MOST`].
pub const F_ZONES: u64 = 142;
pub const ZONES_MOST: usize = 64;
pub const ZONE_POINTS_MOST: usize = 64;
/// Today's land uses.
pub const USES: [&str; 7] = [
    "residential",
    "commercial",
    "park",
    "farm",
    "civic",
    "industrial",
    "wild",
];

/// Checks a field value as zones.
pub fn read_zones(v: &Value) -> Result<(), String> {
    names_only(v)?;
    let mut seen = BTreeSet::new();
    for z in list(v, "zones", ZONES_MOST)? {
        let Value::Array(z) = z else {
            return Err("a zone is [name, use, [x, z, ...]]".into());
        };
        let [n, u, outline] = z.as_slice() else {
            return Err("a zone is [name, use, [x, z, ...]]".into());
        };
        let n = name(n, "a zone's name")?;
        if !n.as_str().starts_with("zone:") || !seen.insert(n.clone()) {
            return Err(format!(
                "{} is not zone:<name>, or is named twice",
                n.as_str()
            ));
        }
        let u = name(u, "a zone's use")?;
        if !u
            .as_str()
            .strip_prefix("use:")
            .is_some_and(|x| USES.contains(&x))
        {
            return Err(format!(
                "{} is not one of use:{}",
                u.as_str(),
                USES.join("|use:")
            ));
        }
        let pts = list(outline, "outline coordinates", ZONE_POINTS_MOST * 2)?;
        if pts.len() < 6 || pts.len() % 2 != 0 {
            return Err(format!(
                "zone {}: an outline is at least three x, z points",
                n.as_str()
            ));
        }
        for p in pts {
            near(p)?;
        }
    }
    Ok(())
}

/// The value a field of this module reads as unset (an empty list; 0 for an owner or access mark), so an undo can
/// take back a batch that added the field: T6 has no unset, and a set to this value reads the same as none.
pub fn neutral(field: u64) -> Option<Value> {
    match field {
        F_DISTRICTS | F_CLAIMS | F_ZONES => Some(Value::Array(Vec::new())),
        crate::who_may::F_OWNER | crate::who_may::F_ACCESS => Some(Value::Uint(0)),
        _ => None,
    }
}

/// Whether `actor` may edit at all: the world's creator, or a live claim's helper sending under that very claim
/// (#3727). The claim check ([`judge`]) then keeps the helper inside it.
pub fn admits(edit: &Edit, copy: &Replica, creator: Id) -> bool {
    match edit.actor {
        crate::effects::Actor::Creator(a) if a == creator => true,
        crate::effects::Actor::Creator(a) => edit
            .claim
            .as_ref()
            .is_some_and(|c| live(copy).iter().any(|x| &x.id == c && x.helper == Some(a))),
        _ => false,
    }
}

/// The claim check for an undo or a redo (#3727): the lead's, under no claim, so no change it would write may touch
/// a live claim's area, before or after. Run on the checker's copy and again on the live copy at the tick.
pub fn judge_effects(copy: &Replica, effects: &[crate::effects::Effect]) -> Result<(), Refused> {
    use crate::effects::{Body, Change};
    let claims = live(copy);
    if claims.is_empty() {
        return Ok(());
    }
    let tree = copy.tree();
    let root = tree.node(tree.root()).map(|n| n.id());
    let at = |id: Id| crate::select::to_root_point(tree, id, Vec3::ZERO);
    let below = |id: Id| {
        let mut out = Vec::new();
        let mut stack = vec![id];
        while let Some(x) = stack.pop() {
            out.push(x);
            if let Some(cs) = tree.handle(x).and_then(|h| tree.children(h)) {
                stack.extend(cs.iter().filter_map(|c| tree.node(*c)).map(|n| n.id()));
            }
        }
        out
    };
    let mut points: Vec<Option<Vec3>> = Vec::new();
    for e in effects {
        let Body::Changes(cs) = &e.body else { continue };
        for c in cs {
            match &c.change {
                Change::Create { pose, .. } => points.push(crate::select::to_root_point(
                    tree,
                    pose.frame.node,
                    pose.position,
                )),
                Change::Reparent { node, pose, .. } => {
                    let same = tree
                        .handle(*node)
                        .and_then(|h| tree.node(h))
                        .and_then(|n| n.parent())
                        == Some(pose.frame.node);
                    for d in below(*node) {
                        points.push(at(d));
                        points.push(if same {
                            crate::select::to_root_point_moved(
                                tree,
                                d,
                                Vec3::ZERO,
                                (*node, pose.frame.slot, pose.position, pose.orientation),
                            )
                        } else if d == *node {
                            crate::select::to_root_point(tree, pose.frame.node, pose.position)
                        } else {
                            None
                        });
                    }
                }
                Change::Set { node, .. } if Some(*node) != root => points.push(at(*node)),
                Change::Remove { node } => points.extend(below(*node).into_iter().map(at)),
                // A link (or its end) is judged at its owning end, which holds its row (#3728); the row's and the
                // door's own sets are judged above.
                Change::Link { ends, owner, .. } => points.push(at(
                    ends[usize::from(*owner == crate::world_model::End::Second)]
                )),
                Change::Unlink { link } => {
                    if let Some((_, ends, owner, _)) = tree.link(*link) {
                        points.push(at(
                            ends[usize::from(owner == crate::world_model::End::Second)]
                        ));
                    }
                }
                _ => {}
            }
        }
    }
    // A point that cannot be read (a node created by the same undo) is judged by where its creation puts it.
    for p in points.into_iter().flatten() {
        if let Some(c) = claims.iter().find(|c| c.holds(p)) {
            return refuse(
                None,
                "edit.claimed",
                format!(
                    "x {} z {} mm is inside {}: release it first",
                    p.x / 1000,
                    p.z / 1000,
                    c.show()
                ),
            );
        }
    }
    Ok(())
}

/// The live claims on a copy: those its root holds.
pub fn live(copy: &Replica) -> Vec<Claim> {
    let tree = copy.tree();
    tree.node(tree.root())
        .and_then(|n| n.fields().get(&F_CLAIMS).cloned())
        .and_then(|v| read_claims(&v).ok())
        .unwrap_or_default()
}

/// What an operation touches: points in the root's frame (µm), and whether it writes the root itself.
#[derive(Default)]
struct Touch {
    points: Vec<Vec3>,
    root: bool,
    lost: bool,
}

/// The claim check (see the module's notes). Runs after the structure checks, so every node it names is there.
pub(crate) fn judge(edit: &Edit, copy: &Replica) -> Result<(), Refused> {
    let tree = copy.tree();
    let root = tree.node(tree.root()).map(|n| n.id());
    // The root's own fields first: a plan or claim list that would not read is refused whatever else.
    for (i, op) in edit.ops.iter().enumerate() {
        if let Op::Set {
            node: Ref::Node(id),
            field,
            to,
        } = op
            && Some(*id) == root
        {
            let (bad, why) = match *field {
                F_CLAIMS => ("edit.claim-malformed", read_claims(to).err()),
                F_DISTRICTS => ("edit.district-malformed", read_districts(to).err()),
                F_ZONES => ("edit.zone-malformed", read_zones(to).err()),
                _ => continue,
            };
            if let Some(why) = why {
                return refuse(Some(i), bad, why);
            }
        }
    }
    let claims = live(copy);
    let mine = match &edit.claim {
        None => None,
        Some(c) => match claims.iter().find(|x| &x.id == c) {
            Some(x) => Some(x),
            None => {
                return refuse(
                    None,
                    "edit.claim-unknown",
                    format!("no live claim {}: build claims lists them", c.as_str()),
                );
            }
        },
    };
    if claims.is_empty() {
        return Ok(());
    }
    let at = |id: Id, p: Vec3| crate::select::to_root_point(tree, id, p);
    // Placed nodes by their batch name: where each is, and its parent.
    let mut placed: BTreeMap<u64, (Option<Vec3>, Ref)> = BTreeMap::new();
    let point_in = |placed: &BTreeMap<u64, (Option<Vec3>, Ref)>, parent: Ref, p: Vec3| match parent
    {
        Ref::Node(id) => at(id, p),
        Ref::New(n) => placed
            .get(&n)
            .and_then(|(o, _)| *o)
            .and_then(|o| o.plus(p).ok()),
    };
    let origin = |placed: &BTreeMap<u64, (Option<Vec3>, Ref)>, r: Ref| match r {
        Ref::Node(id) => at(id, Vec3::ZERO),
        Ref::New(n) => placed.get(&n).and_then(|(o, _)| *o),
    };
    let parent_of = |placed: &BTreeMap<u64, (Option<Vec3>, Ref)>, r: Ref| match r {
        Ref::Node(id) => tree
            .handle(id)
            .and_then(|h| tree.node(h))
            .and_then(|n| n.parent())
            .map(Ref::Node),
        Ref::New(n) => placed.get(&n).map(|(_, p)| *p),
    };
    for (i, op) in edit.ops.iter().enumerate() {
        let mut t = Touch::default();
        let add = |t: &mut Touch, p: Option<Vec3>| match p {
            Some(p) => t.points.push(p),
            None => t.lost = true,
        };
        match op {
            Op::Place {
                name, parent, at, ..
            } => {
                let p = point_in(&placed, *parent, at.position);
                placed.insert(*name, (p, *parent));
                add(&mut t, p);
            }
            Op::Move { node, at: spot } => {
                // Everything below the moved node moves with it: each node's point before and after (#3879 review).
                let before = origin(&placed, *node);
                let after = match node {
                    Ref::Node(id) => crate::select::to_root_point_moved(
                        tree,
                        *id,
                        Vec3::ZERO,
                        (*id, spot.slot, spot.position, spot.orientation),
                    ),
                    Ref::New(_) => {
                        parent_of(&placed, *node).and_then(|q| point_in(&placed, q, spot.position))
                    }
                };
                let shift = before.zip(after).and_then(|(b, a)| a.minus(b).ok());
                let mut stack = vec![*node];
                while let Some(r) = stack.pop() {
                    match r {
                        Ref::Node(d) => {
                            add(&mut t, at(d, Vec3::ZERO));
                            add(
                                &mut t,
                                match node {
                                    Ref::Node(id) => crate::select::to_root_point_moved(
                                        tree,
                                        d,
                                        Vec3::ZERO,
                                        (*id, spot.slot, spot.position, spot.orientation),
                                    ),
                                    Ref::New(_) => None,
                                },
                            );
                            if let Some(cs) = tree.handle(d).and_then(|h| tree.children(h)) {
                                stack.extend(
                                    cs.iter()
                                        .filter_map(|c| tree.node(*c))
                                        .map(|n| Ref::Node(n.id())),
                                );
                            }
                        }
                        Ref::New(n) => {
                            // A node placed in this batch: its point shifts with the move.
                            let was = placed.get(&n).and_then(|(o, _)| *o);
                            let now = if r == *node {
                                after
                            } else {
                                was.zip(shift).and_then(|(w, s)| w.plus(s).ok())
                            };
                            add(&mut t, was);
                            add(&mut t, now);
                            if let Some(e) = placed.get_mut(&n) {
                                e.0 = now;
                            }
                        }
                    }
                    stack.extend(
                        placed
                            .iter()
                            .filter(|(_, (_, p))| *p == r)
                            .map(|(n, _)| Ref::New(*n)),
                    );
                }
            }
            Op::Set { node, .. } => {
                if *node == root.map_or(Ref::New(u64::MAX), Ref::Node) {
                    t.root = true;
                } else {
                    add(&mut t, origin(&placed, *node));
                }
            }
            Op::Remove { node } => {
                let mut stack = vec![*node];
                while let Some(r) = stack.pop() {
                    add(&mut t, origin(&placed, r));
                    if let Ref::Node(id) = r
                        && let Some(cs) = tree.handle(id).and_then(|h| tree.children(h))
                    {
                        stack.extend(
                            cs.iter()
                                .filter_map(|c| tree.node(*c))
                                .map(|n| Ref::Node(n.id())),
                        );
                    }
                    stack.extend(
                        placed
                            .iter()
                            .filter(|(_, (_, p))| *p == r)
                            .map(|(n, _)| Ref::New(*n)),
                    );
                }
            }
            Op::Doorway {
                door,
                from,
                to,
                at: spot,
                wall,
                ..
            } => {
                // The leaf's spot (in its owning end's axes), the leaf, the wall and both ends (#3879 review).
                add(
                    &mut t,
                    point_in(&placed, *from, Vec3::new(spot[0] * 1000, 0, spot[1] * 1000)),
                );
                for r in [*door, *wall, *from, *to] {
                    add(&mut t, origin(&placed, r));
                }
            }
            Op::Link {
                ends, owner, door, ..
            } => {
                // A link writes its row to the owning end and names itself on its door (#3728): judged as an edit
                // of those nodes.
                add(
                    &mut t,
                    origin(
                        &placed,
                        ends[usize::from(*owner == crate::world_model::End::Second)],
                    ),
                );
                if let Some(d) = door {
                    add(&mut t, origin(&placed, *d));
                }
            }
        }
        match mine {
            Some(c) => {
                if t.root {
                    return refuse(
                        Some(i),
                        "edit.outside-claim",
                        format!("the world's own fields are the lead's, not {}'s", c.show()),
                    );
                }
                if t.lost {
                    return refuse(
                        Some(i),
                        "edit.outside-claim",
                        format!(
                            "where this is cannot be read, so it is not inside {}",
                            c.show()
                        ),
                    );
                }
                if let Some(p) = t.points.iter().find(|p| !c.holds(**p)) {
                    return refuse(
                        Some(i),
                        "edit.outside-claim",
                        format!(
                            "x {} z {} mm is outside {}",
                            p.x / 1000,
                            p.z / 1000,
                            c.show()
                        ),
                    );
                }
            }
            None => {
                if let Some((p, c)) = t
                    .points
                    .iter()
                    .find_map(|p| claims.iter().find(|c| c.holds(*p)).map(|c| (p, c)))
                {
                    return refuse(
                        Some(i),
                        "edit.claimed",
                        format!(
                            "x {} z {} mm is inside {}: edit under that claim, or release it",
                            p.x / 1000,
                            p.z / 1000,
                            c.show()
                        ),
                    );
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::wire::{claim, parameters_under, read};
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn a_claim_rides_the_edit_as_parameter_two() {
        let ops = vec![Op::Remove {
            node: Ref::Node(Id::new(crate::ids::Scope([1; 16]), 2).expect("an id")),
        }];
        let c = Name::new("c:house").expect("a name");
        let p = parameters_under(&ops, Some(&c));
        assert_eq!(read(&p).expect("a batch"), ops);
        assert_eq!(claim(&p).expect("a claim"), Some(c));
        let plain = parameters_under(&ops, None);
        assert_eq!(claim(&plain).expect("none"), None);
        let mut bad = plain.clone();
        bad.insert(6, Value::Uint(7));
        assert!(read(&bad).is_err());
        bad.insert(3, Value::Uint(7));
        assert!(read(&bad).is_err());
        // A claim never stands for a batch, and an old parameter 2 is not a claim.
        let alone = BTreeMap::from([(6, Value::Text(Name::new("c:house").expect("a name")))]);
        assert!(read(&alone).is_err());
        let mut two = plain.clone();
        two.insert(2, Value::Text(Name::new("c:house").expect("a name")));
        assert!(read(&two).is_err());
    }
}
