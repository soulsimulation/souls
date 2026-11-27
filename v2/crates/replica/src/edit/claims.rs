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
//! an edit naming a claim that is not live is refused `edit.claim-unknown`. Where a thing is: the points of its
//! outline (field 11) and line (16) when it has a shape, a road or a lawn standing at its parent's origin (#3962),
//! else its origin, in the root's frame; a removal tests the whole subtree, a move each node before and after; a place
//! tests its spot in its parent (a slot's offset aside); a set of an outline or line tests the old and the new shape;
//! a removal also tests the owning end of the doorway its field 7 names, whose rows the unlink rewrites.

use super::{Edit, Op, Ref, Refused, refuse};
use crate::apply::Replica;
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::pose::{Quat, Vec3};
use crate::tree::Tree;
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
/// A door leaf's field naming its doorway link, and that link's type (`sim::ground::scene`).
const DOOR_LINK: u64 = 7;
const DOORWAY: &str = "eden:doorway";

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

/// The value a field of this module reads as unset (an empty list; 0 for an owner or access mark; no rows for a tint; no
/// place for the world's arrival, #5006; no strike, as both page readers read a list that is not three numbers; a
/// creator's weather that ended at world time 0, which `sim::daylight` reads as none), so an undo can take back a batch
/// that added the field: T6 has no unset, and a set to this value reads the same as none.
pub fn neutral(field: u64) -> Option<Value> {
    match field {
        F_DISTRICTS
        | F_CLAIMS
        | F_ZONES
        | crate::tint::F_TINT
        | crate::arrival::F_ARRIVAL
        | crate::sky::F_STRIKE => Some(Value::Array(Vec::new())),
        crate::who_may::F_OWNER | crate::who_may::F_ACCESS | crate::sky::F_WEATHER_UNTIL => {
            Some(Value::Uint(0))
        }
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

/// A node's slot, place and turn as a move would set them (see [`crate::select::to_root_point_moved`]).
type Moved = (Id, Option<u64>, Vec3, Quat);

/// Where a thing is in its own frame, µm: the points of its outline and line when it has a shape (a road, a lawn,
/// which stand at their parent's origin, #3962), read as `select` reads a shape; else its origin. `None` for a shape
/// that does not read.
fn locals(fields: &BTreeMap<u64, Value>) -> Vec<Option<Vec3>> {
    match crate::select::shape_points(fields) {
        Some(p) if p.is_empty() => vec![Some(Vec3::ZERO)],
        Some(p) => p.into_iter().map(Some).collect(),
        None => vec![None],
    }
}

/// Whether a set of `field` reshapes a thing.
fn reshapes(field: u64) -> bool {
    field == crate::select::F_OUTLINE || field == crate::select::F_LINE
}

/// A node's own fields on the copy (none for a node it does not hold).
fn fields_of(tree: &Tree, id: Id) -> BTreeMap<u64, Value> {
    tree.handle(id)
        .and_then(|h| tree.node(h))
        .map(|n| n.fields().clone())
        .unwrap_or_default()
}

/// Where a node on the copy is ([`locals`]) in the root's frame, as `moved` would put it.
fn node_points(
    tree: &Tree,
    id: Id,
    fields: &BTreeMap<u64, Value>,
    moved: Option<Moved>,
) -> Vec<Option<Vec3>> {
    locals(fields)
        .into_iter()
        .map(|q| match moved {
            None => crate::select::to_root_point(tree, id, q?),
            Some(m) => crate::select::to_root_point_moved(tree, id, q?, m),
        })
        .collect()
}

/// Where a thing with `fields` set at `position`, turned `orientation`, would be: `to_root` takes a point in its
/// parent's frame into the root's.
fn set_points(
    fields: &BTreeMap<u64, Value>,
    position: Vec3,
    orientation: Quat,
    to_root: impl Fn(Vec3) -> Option<Vec3>,
) -> Vec<Option<Vec3>> {
    locals(fields)
        .into_iter()
        .map(|q| to_root(position.plus(orientation.rotate(q?).ok()?).ok()?))
        .collect()
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
    let at = |id: Id| node_points(tree, id, &fields_of(tree, id), None);
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
                Change::Create { pose, fields, .. } => {
                    points.extend(set_points(fields, pose.position, pose.orientation, |p| {
                        crate::select::to_root_point(tree, pose.frame.node, p)
                    }))
                }
                Change::Reparent { node, pose, .. } => {
                    let same = tree
                        .handle(*node)
                        .and_then(|h| tree.node(h))
                        .and_then(|n| n.parent())
                        == Some(pose.frame.node);
                    for d in below(*node) {
                        let f = fields_of(tree, d);
                        points.extend(node_points(tree, d, &f, None));
                        if same {
                            points.extend(node_points(
                                tree,
                                d,
                                &f,
                                Some((*node, pose.frame.slot, pose.position, pose.orientation)),
                            ));
                        } else if d == *node {
                            points.extend(set_points(&f, pose.position, pose.orientation, |p| {
                                crate::select::to_root_point(tree, pose.frame.node, p)
                            }));
                        }
                    }
                }
                Change::Set {
                    node, field, to, ..
                } if Some(*node) != root => {
                    let mut f = fields_of(tree, *node);
                    points.extend(node_points(tree, *node, &f, None));
                    if reshapes(*field) {
                        f.insert(*field, to.clone());
                        points.extend(node_points(tree, *node, &f, None));
                    }
                }
                Change::Remove { node } => points.extend(below(*node).into_iter().flat_map(at)),
                // A link is judged at both its ends, since the walkers' map changes at each (#3728, #3934 review); an
                // unlink is written with its owning end's rows, a set judged above.
                Change::Link { ends, .. } => points.extend(ends.iter().flat_map(|e| at(*e))),
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

/// A node placed earlier in the batch: its parent, its spot there, its fields, and how far moves of a node on the copy
/// above it have carried it (`None` once that cannot be read).
struct Placed {
    parent: Ref,
    position: Vec3,
    orientation: Quat,
    fields: BTreeMap<u64, Value>,
    shift: Option<Vec3>,
}

/// A point in `parent`'s frame (µm) in the root's; a node placed in this batch is taken at its origin, unturned.
fn point_in(tree: &Tree, placed: &BTreeMap<u64, Placed>, parent: Ref, p: Vec3) -> Option<Vec3> {
    match parent {
        Ref::Node(id) => crate::select::to_root_point(tree, id, p),
        Ref::New(_) => origin(tree, placed, parent)?.plus(p).ok(),
    }
}

/// Where a node's origin is in the root's frame.
fn origin(tree: &Tree, placed: &BTreeMap<u64, Placed>, r: Ref) -> Option<Vec3> {
    match r {
        Ref::Node(id) => crate::select::to_root_point(tree, id, Vec3::ZERO),
        Ref::New(n) => {
            let x = placed.get(&n)?;
            point_in(tree, placed, x.parent, x.position)?
                .plus(x.shift?)
                .ok()
        }
    }
}

/// Where a node is ([`locals`]) in the root's frame.
fn points_of(tree: &Tree, placed: &BTreeMap<u64, Placed>, r: Ref) -> Vec<Option<Vec3>> {
    match r {
        Ref::Node(id) => node_points(tree, id, &fields_of(tree, id), None),
        Ref::New(n) => match placed.get(&n) {
            None => vec![None],
            Some(x) => set_points(&x.fields, x.position, x.orientation, |p| {
                point_in(tree, placed, x.parent, p)?.plus(x.shift?).ok()
            }),
        },
    }
}

/// The claim check (see the module's notes). Runs after the structure checks, so every node it names is there.
pub(crate) fn judge(edit: &Edit, copy: &Replica) -> Result<(), Refused> {
    let tree = copy.tree();
    let root = tree.node(tree.root()).map(|n| n.id());
    // The root's own fields first: a plan or claim list that would not read is refused whatever else.
    for (i, op) in edit.ops.iter().enumerate() {
        // A rows operation (#3728) writes the whole field too: what it would make there is checked the same way.
        let (id, field) = match op {
            Op::Set {
                node: Ref::Node(id),
                field,
                ..
            }
            | Op::Rows {
                node: Ref::Node(id),
                field,
                ..
            } if Some(*id) == root && [F_CLAIMS, F_DISTRICTS, F_ZONES].contains(field) => {
                (*id, *field)
            }
            _ => continue,
        };
        let merged;
        let to = match op {
            Op::Set { to, .. } => to,
            Op::Rows { rows, .. } => {
                let now = tree
                    .handle(id)
                    .and_then(|h| tree.node(h))
                    .and_then(|n| n.fields().get(&field).cloned());
                // Not a field of rows: the structure check has refused it already.
                let Some(m) = super::merged_rows(now.as_ref(), rows) else {
                    continue;
                };
                merged = m;
                &merged
            }
            _ => continue,
        };
        let (bad, why) = match field {
            F_CLAIMS => ("edit.claim-malformed", read_claims(to).err()),
            F_DISTRICTS => ("edit.district-malformed", read_districts(to).err()),
            F_ZONES => ("edit.zone-malformed", read_zones(to).err()),
            _ => continue,
        };
        if let Some(why) = why {
            return refuse(Some(i), bad, why);
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
    // Nodes placed in this batch, by their batch name.
    let mut placed: BTreeMap<u64, Placed> = BTreeMap::new();
    // Each node's doorway link (its field 7) as the batch leaves it: removing the node unlinks that doorway and
    // rewrites its owning end's rows (`sim::edit`), so a removal touches the owner too (#3934 review).
    let mut aimed: BTreeMap<Ref, Value> = BTreeMap::new();
    let doorway_owner = |aimed: &BTreeMap<Ref, Value>, r: Ref| {
        let link = aimed.get(&r).cloned().or_else(|| match r {
            Ref::Node(id) => tree
                .handle(id)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.fields().get(&DOOR_LINK).cloned()),
            Ref::New(_) => None,
        })?;
        let (ty, [owner, _], ..) = tree.link(crate::effects::read_id(&link).ok()?)?;
        (ty.as_str() == DOORWAY).then_some(owner)
    };
    for (i, op) in edit.ops.iter().enumerate() {
        let mut t = Touch::default();
        let add = |t: &mut Touch, ps: Vec<Option<Vec3>>| {
            for p in ps {
                match p {
                    Some(p) => t.points.push(p),
                    None => t.lost = true,
                }
            }
        };
        if let Op::Set { node, field, to } = op
            && *field == DOOR_LINK
        {
            aimed.insert(*node, to.clone());
        }
        match op {
            Op::Place {
                name,
                parent,
                at,
                fields,
                ..
            } => {
                placed.insert(
                    *name,
                    Placed {
                        parent: *parent,
                        position: at.position,
                        orientation: at.orientation,
                        fields: fields.clone(),
                        shift: Some(Vec3::ZERO),
                    },
                );
                if let Some(v) = fields.get(&DOOR_LINK) {
                    aimed.insert(Ref::New(*name), v.clone());
                }
                add(&mut t, points_of(tree, &placed, Ref::New(*name)));
            }
            Op::Move { node, at: spot } => {
                // Everything below the moved node moves with it: each one's points before and after (#3879 review).
                let mut below = Vec::new();
                let mut stack = vec![*node];
                while let Some(r) = stack.pop() {
                    below.push(r);
                    if let Ref::Node(d) = r
                        && let Some(cs) = tree.handle(d).and_then(|h| tree.children(h))
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
                            .filter(|(_, x)| x.parent == r)
                            .map(|(n, _)| Ref::New(*n)),
                    );
                }
                for r in &below {
                    add(&mut t, points_of(tree, &placed, *r));
                }
                match node {
                    Ref::Node(id) => {
                        let m = (*id, spot.slot, spot.position, spot.orientation);
                        for r in &below {
                            match r {
                                Ref::Node(d) => add(
                                    &mut t,
                                    node_points(tree, *d, &fields_of(tree, *d), Some(m)),
                                ),
                                // A node placed in this batch on one that moves is carried as its spot is.
                                Ref::New(n) => {
                                    if let Some(x) = placed.get_mut(n)
                                        && let Ref::Node(p) = x.parent
                                    {
                                        let now = crate::select::to_root_point_moved(
                                            tree, p, x.position, m,
                                        );
                                        let was = crate::select::to_root_point(tree, p, x.position);
                                        x.shift = x
                                            .shift
                                            .zip(now.zip(was).and_then(|(a, b)| a.minus(b).ok()))
                                            .and_then(|(s, d)| s.plus(d).ok());
                                    }
                                }
                            }
                        }
                    }
                    Ref::New(n) => {
                        if let Some(x) = placed.get_mut(n) {
                            x.position = spot.position;
                            x.orientation = spot.orientation;
                        }
                    }
                }
                for r in below.iter().filter(|r| matches!(r, Ref::New(_))) {
                    add(&mut t, points_of(tree, &placed, *r));
                }
            }
            Op::Set { node, field, to } => {
                if *node == root.map_or(Ref::New(u64::MAX), Ref::Node) {
                    t.root = true;
                } else {
                    // A set touches the thing where it is, and a new outline or line where that puts it (#3962).
                    add(&mut t, points_of(tree, &placed, *node));
                    if reshapes(*field) {
                        match node {
                            Ref::Node(id) => {
                                let mut f = fields_of(tree, *id);
                                f.insert(*field, to.clone());
                                add(&mut t, node_points(tree, *id, &f, None));
                            }
                            Ref::New(n) => {
                                if let Some(x) = placed.get_mut(n) {
                                    x.fields.insert(*field, to.clone());
                                }
                                add(&mut t, points_of(tree, &placed, *node));
                            }
                        }
                    }
                }
            }
            // A rows edit (#3956) touches the thing where it is, as a set does.
            Op::Rows { node, .. } => {
                if *node == root.map_or(Ref::New(u64::MAX), Ref::Node) {
                    t.root = true;
                } else {
                    add(&mut t, points_of(tree, &placed, *node));
                }
            }
            Op::Remove { node } => {
                // The doorway's owning end is judged where it is: its outline's points when it has one (#3962).
                if let Some(owner) = doorway_owner(&aimed, *node) {
                    add(&mut t, points_of(tree, &placed, Ref::Node(owner)));
                }
                let mut stack = vec![*node];
                while let Some(r) = stack.pop() {
                    add(&mut t, points_of(tree, &placed, r));
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
                            .filter(|(_, x)| x.parent == r)
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
                    vec![point_in(
                        tree,
                        &placed,
                        *from,
                        Vec3::new(spot[0] * 1000, 0, spot[1] * 1000),
                    )],
                );
                for r in [*door, *wall, *from, *to] {
                    add(&mut t, vec![origin(tree, &placed, r)]);
                }
            }
            Op::Link { ends, door, .. } => {
                // A link writes its row to the owning end and names itself on its door (#3728), and changes the
                // walkers' map at both ends, as a doorway does (#3934 review): judged as an edit of all of them.
                for end in ends {
                    add(&mut t, vec![origin(tree, &placed, *end)]);
                }
                if let Some(d) = door {
                    add(&mut t, vec![origin(tree, &placed, *d)]);
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
