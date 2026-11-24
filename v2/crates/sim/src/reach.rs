//! A move's reach to a thing, the measure the served world answers its Reach question with (`worldd`'s `Sight`):
//! the pure part, which reads only a thing's entry, a body's build and points already carried into one frame, so the
//! run gate's world (`tools/entry/v2`) measures reach with the same code (0.135 E19). Moved here unchanged from
//! `worldd`'s acts; `worldd` reads the tree and the town to carry the points, the run gate its open ground.

use replica::effects::Refusal;
use replica::ids::Id;
use replica::kinds::sizes::Build;
use replica::pose::Vec3;
use replica::rules::json::Value as Json;
use skills::form_runner::{Arg, Args};

/// `[x, z]` µm across x and z from `a` to `b`.
pub fn flat(a: [i64; 2], b: [i64; 2]) -> i64 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    i64::try_from((d(a[0], b[0]) + d(a[1], b[1])).isqrt()).unwrap_or(i64::MAX)
}

/// How far point `q` is from the closed quadrilateral `ring` (convex, its corners in order), across x and z: 0 inside.
pub fn to_ring(q: [i64; 2], ring: &[[i64; 2]; 4]) -> i64 {
    let edge = |a: [i64; 2], b: [i64; 2]| {
        let (d, w) = (
            [i128::from(b[0] - a[0]), i128::from(b[1] - a[1])],
            [i128::from(q[0] - a[0]), i128::from(q[1] - a[1])],
        );
        (d[0] * w[1] - d[1] * w[0], d, w)
    };
    let sides: Vec<i128> = (0..4).map(|i| edge(ring[i], ring[(i + 1) % 4]).0).collect();
    if sides.iter().all(|&c| c >= 0) || sides.iter().all(|&c| c <= 0) {
        return 0;
    }
    (0..4)
        .map(|i| {
            let (a, (_, d, w)) = (ring[i], edge(ring[i], ring[(i + 1) % 4]));
            let len = (d[0] * d[0] + d[1] * d[1]).max(1);
            let t = (d[0] * w[0] + d[1] * w[1]).clamp(0, len);
            let near = |k: usize| a[k] + i64::try_from(d[k] * t / len).unwrap_or(0);
            flat(q, [near(0), near(1)])
        })
        .min()
        .unwrap_or(i64::MAX)
}

/// Whole millimetres `[x, y, z]` in µm.
pub fn um(v: Option<&Json>) -> Option<Vec3> {
    let n = |v: &Json| match v {
        Json::Int(n) => i64::try_from(*n).ok()?.checked_mul(1000),
        _ => None,
    };
    match v?.arr()? {
        [x, y, z] => Some(Vec3::new(n(x)?, n(y)?, n(z)?)),
        _ => None,
    }
}

/// How far below its feet a body reaches, µm: today's contact check (`contact-actuator.ts`, a hand reaches a thing
/// within 1.2 m of the feet's height).
pub const BELOW_FEET: i64 = 1_200_000;

/// How far a span of heights `[lo, hi]` (µm) lies outside what a body with feet at `feet` and standing reach `reach`
/// gets a hand to: from [`BELOW_FEET`] under its feet to its standing reach above them (`crate::slots::standing_reach`,
/// today's overhead reach); 0 within.
pub fn off_height(feet: i64, reach: i64, lo: i64, hi: i64) -> i64 {
    (feet - BELOW_FEET - hi).max(lo - feet - reach).max(0)
}

/// `[x, z]` gap `h` and height gap `v` (µm) as one distance.
pub fn with_height(h: i64, v: i64) -> i64 {
    let (h, v) = (i128::from(h), i128::from(v));
    i64::try_from((h * h + v * v).isqrt()).unwrap_or(i64::MAX)
}

/// How far a body of build `build` with feet at `from` is from the thing whose entry is `entry`, µm: across x and z
/// from the body's edge (a standard body's radius from its feet, [`crate::ground::HUMAN_RADIUS`]: a hand reaches from
/// the shoulder, not the feet) to the nearer of the thing's point `point` its entry names and its nearest surface,
/// the box its entry's `geometry.bounds_mm` gives (centred on its place); and in height, how far the point or the box
/// lies outside the body's reach above and below its feet ([`off_height`]). `on` carries a point of the thing's frame
/// into the body's; `None` when the entry gives neither or `on` carries none.
pub fn to_thing(
    entry: &Json,
    build: Build,
    from: Vec3,
    point: &str,
    on: impl Fn(Vec3) -> Option<Vec3>,
) -> Option<i64> {
    let reach = crate::slots::standing_reach(build);
    let radius = build.size.radius_mm() * 1000;
    let q = [from.x, from.z];
    let gap = |h: i64, lo: i64, hi: i64| {
        with_height(
            h.saturating_sub(radius).max(0),
            off_height(from.y, reach, lo, hi),
        )
    };
    let named = um(entry
        .get("points")
        .and_then(|ps| ps.get(point))
        .and_then(|p| p.get("at_mm")))
    .and_then(&on)
    .map(|p| gap(flat(q, [p.x, p.z]), p.y, p.y));
    let surface = crate::spots::footprint(entry).and_then(|(corners, height)| {
        let [a, b, c, d] = corners;
        let corners = [on(a)?, on(b)?, on(c)?, on(d)?];
        let ring = corners.map(|p| [p.x, p.z]);
        let lo = corners.iter().map(|p| p.y).min()?;
        let hi = corners.iter().map(|p| p.y).max()? + height.max(0);
        Some(gap(to_ring(q, &ring), lo, hi))
    });
    match (named, surface) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// How far a body of build `build` in slot `slot` of the thing whose entry is `entry` (numbered from 1 in its entry's
/// order, as the places register them) is from the thing's point `point`, µm: from the body's edge at the seat to the
/// point across x and z, and in height how far the point lies outside the body's reach above and below its feet, at
/// the seat's stand point's height (the floor it took the seat from), both in the thing's own frame, so where the
/// thing is placed and how it is turned change nothing. A point the entry does not declare is the thing itself, which
/// the body is in: 0.
pub fn in_slot(entry: &Json, build: Build, slot: u64, point: &str) -> Option<i64> {
    let points = entry.get("points");
    let (_, slot_def) = entry
        .get("slots")?
        .obj()?
        .get(usize::try_from(slot).ok()?.checked_sub(1)?)?;
    let at = um(slot_def.get("at_mm"))?;
    let feet = slot_def
        .get("stand")
        .and_then(Json::str)
        .and_then(|s| um(points?.get(s)?.get("at_mm")))
        .map_or(at.y, |p| p.y);
    let Some(to) = um(points
        .and_then(|ps| ps.get(point))
        .and_then(|p| p.get("at_mm")))
    else {
        return Some(0);
    };
    let radius = build.size.radius_mm() * 1000;
    let h = flat([at.x, at.z], [to.x, to.z])
        .saturating_sub(radius)
        .max(0);
    let reach = crate::slots::standing_reach(build);
    Some(with_height(h, off_height(feet, reach, to.y, to.y)))
}

/// The point a move with no `at` and no `toward` reaches (C23, #3494): the body itself, always in reach (a wave, a
/// stretch, a bow where it stands).
pub const AT_SELF: &str = "souls:self";

/// The point a move whose `at` or `toward` is a thing argument reaches (C23): that thing's nearest surface, else its
/// place, measured as a move at the form's own thing is ([`to_thing`]).
pub const AT_ARG: &str = "souls:argument";

/// The member `key` of object `v`, to change.
pub fn obj_mut<'a>(v: &'a mut Json, key: &str) -> Option<&'a mut Json> {
    match v {
        Json::Obj(o) => o.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// A move step's target resolved from the form's arguments (C23, #3494), in a copy of `entry` the binder then reads:
/// a move with no `at` and no `toward` is at [`AT_SELF`]; one whose `at`, or with no `at` whose `toward`, is a thing
/// argument is at [`AT_ARG`], that thing (returned). A point of this thing named by `at` stays as it is. An argument
/// not given as a thing is refused `arg-missing`. The two points are added to the copy's points, at its origin, so the
/// binder knows them; the world's reach measures them (`worldd`'s `Sight`, the run gate's world).
pub fn targets(entry: &Json, form: &str, args: &Args) -> Result<(Json, Option<Id>), Refusal> {
    let mut e = entry.clone();
    let mut thing = None;
    let steps = obj_mut(&mut e, "forms")
        .and_then(|fs| obj_mut(fs, form))
        .and_then(|f| obj_mut(f, "steps"));
    let Some(Json::Arr(steps)) = steps else {
        return Ok((e, None));
    };
    for s in steps.iter_mut() {
        let kind = s.get("step").and_then(Json::str);
        if !matches!(kind, Some("move" | "take" | "put")) || s.get("move").is_none() {
            continue;
        }
        let arg = |k: &str| s.get(k).and_then(|v| v.get("arg")).and_then(Json::str);
        let at = match (s.get("at"), arg("at"), arg("toward")) {
            (Some(Json::Str(_)), ..) => continue,
            (None, None, None) => AT_SELF,
            (_, Some(a), _) | (None, None, Some(a)) => {
                match args.get(a) {
                    Some(Arg::Name(_)) => continue,
                    Some(Arg::Node(id)) => {
                        if thing.is_some_and(|old| old != *id) {
                            return Err(refusal("arg-ambiguous", a));
                        }
                        thing = Some(*id);
                    }
                    Some(_) => return Err(refusal("step-malformed", a)),
                    None => return Err(refusal("arg-missing", a)),
                }
                AT_ARG
            }
            _ => continue,
        };
        if let Json::Obj(o) = s {
            o.retain(|(k, _)| k != "at");
            o.push(("at".into(), Json::s(at)));
        }
    }
    let origin = || Json::object([("at_mm", Json::Arr(vec![Json::Int(0); 3]))]);
    if let Json::Obj(o) = &mut e
        && !o.iter().any(|(k, _)| k == "points")
    {
        o.push(("points".into(), Json::Obj(Vec::new())));
    }
    if let Some(Json::Obj(ps)) = obj_mut(&mut e, "points") {
        ps.push((AT_SELF.into(), origin()));
        ps.push((AT_ARG.into(), origin()));
    }
    Ok((e, thing))
}
