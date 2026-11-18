//! The shape of a walk's way (Engine v2 E10, #2781): a walk intent's `via`, `along`, `round` and `between`
//! (`replica::walk::Way`) turned into the points a body passes on the open ground, in order. The world joins the
//! routes between them (N5) into one walk that passes each point without stopping (`walk::town::Town::plan_way`).
//!
//! - **Via.** Each place's point: a place node's middle (the middle of its outline's corners, or of its line's), or
//!   a point given, stood on: the open ground there, else a floor there (a bridge's deck, #3226), else the nearest
//!   walkable open ground.
//! - **Along** a path or shore: its line's points from the end nearer the body to the other. A line with a width
//!   (a river's shore) is moved sideways to the body's side, past half its width. A closed outline is followed from
//!   its corner nearest the body round to its corner nearest the walk's goal, the shorter way (all the way round
//!   without a goal).
//! - **Round** a place: its outline moved outward from its middle onto walkable ground, from the corner nearest the
//!   body, once per lap, ending where it began.
//! - **Between** two stops: there and back, once per lap.
//! - **Onto dry ground.** A point is moved outward by [`OUT`] in turn until the walkable ground lies within [`SNAP`]
//!   of it, and then to its nearest walkable point; an outline's points and a shore's start 2 m out, since a shore is
//!   where wading starts (N11). A point with none is dropped and counted. A line or outline is thinned to [`POINTS_MOST`] points a lap.
//! - **Charged.** Each point is one more route search (I8): [`Points::searches`].

use super::Map;
use crate::ground::scene::{F_LINE, F_LINE_WIDTH, F_OUTLINE};
use replica::effects::Refusal;
use replica::encode::Value;
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::tree::Tree;
use replica::walk::{Shape, Stop, Way};
use replica::world_model::show;

/// The steps a point is moved outward, µm, tried in turn until it is on walkable ground. An outline's or a shore's
/// points start at the second, so the walk keeps off the water's edge.
pub const OUT: [i64; 5] = [0, 2_000_000, 4_000_000, 8_000_000, 16_000_000];
/// How far from a moved point the walkable ground may lie, mm.
pub const SNAP: i64 = 6_000;
/// The most points one line, or one lap of an outline, becomes.
pub const POINTS_MOST: usize = 32;
/// A line wider than this, µm, is water's (a river and its shore), not a path: its points keep off its edge.
const WIDE: i64 = 4_000_000;
/// How far inside the walkable ground a point found on its edge is moved, µm.
const INSIDE: i64 = 100_000;

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// The points a walk passes, µm in the open ground's frame, in order; the last is where it ends unless the intent
/// names a goal beyond.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Points {
    pub points: Vec<Vec3>,
    /// Where each point is stood on: the node (the open ground, or a floor such as a bridge's deck) and the point in
    /// its frame, µm.
    pub on: Vec<(Id, Vec3)>,
    /// Points of a line or outline that had no walkable ground near and were left out.
    pub dropped: u32,
    /// The route searches the way costs (I8): one per point.
    pub searches: u32,
}

/// A place's line or outline, µm, whether it is closed, and its width, µm (0 for none).
struct Figure {
    points: Vec<[i64; 2]>,
    closed: bool,
    width: i64,
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn ring(v: &Value) -> Option<Vec<[i64; 2]>> {
    let Value::Array(a) = v else { return None };
    a.iter()
        .map(|p| match p {
            Value::Array(q) if q.len() >= 2 => Some([int(&q[0])? * 1000, int(&q[1])? * 1000]),
            _ => None,
        })
        .collect()
}

fn figure(tree: &Tree, place: Id) -> Result<Figure, Refusal> {
    let n = tree
        .handle(place)
        .and_then(|h| tree.node(h))
        .ok_or_else(|| refusal("way-place-gone", show(place)))?;
    let f = n.fields();
    let width = f.get(&F_LINE_WIDTH).and_then(int).unwrap_or(0) * 1000;
    if let Some(points) = f.get(&F_OUTLINE).and_then(ring).filter(|r| r.len() >= 3) {
        return Ok(Figure {
            points,
            closed: true,
            width,
        });
    }
    if let Some(points) = f.get(&F_LINE).and_then(ring).filter(|r| r.len() >= 2) {
        return Ok(Figure {
            points,
            closed: false,
            width,
        });
    }
    Err(refusal(
        "way-not-a-place",
        format!("{} has no outline or line", show(place)),
    ))
}

fn middle(points: &[[i64; 2]]) -> [i64; 2] {
    let n = points.len().max(1) as i64;
    [
        points.iter().map(|p| p[0]).sum::<i64>() / n,
        points.iter().map(|p| p[1]).sum::<i64>() / n,
    ]
}

fn d2(a: [i64; 2], b: [i64; 2]) -> i128 {
    let (x, z) = (i128::from(a[0] - b[0]), i128::from(a[1] - b[1]));
    x * x + z * z
}

/// `p` moved `by` µm along the direction `d` (any length).
fn moved(p: [i64; 2], d: [i64; 2], by: i64) -> [i64; 2] {
    let l = d2(d, [0, 0]).isqrt();
    if l == 0 || by == 0 {
        return p;
    }
    let s = |c: i64| i64::try_from(i128::from(c) * i128::from(by) / l).unwrap_or(0);
    [p[0] + s(d[0]), p[1] + s(d[1])]
}

/// Every `k`-th point so that at most `most` remain, the last kept.
fn thin(points: Vec<[i64; 2]>, most: usize) -> Vec<[i64; 2]> {
    if points.len() <= most {
        return points;
    }
    let k = points.len().div_ceil(most);
    let last = *points.last().expect("not empty");
    let mut out: Vec<[i64; 2]> = points.into_iter().step_by(k).collect();
    if out.last() != Some(&last) {
        out.pop();
        out.push(last);
    }
    out
}

/// The walkable point for `p` on the open ground `ground`, moving it by each of [`OUT`] from the `first` in turn along
/// `away` (µm, any length; none: only `p` itself is tried).
fn onto_ground(
    map: &Map,
    ground: Id,
    p: [i64; 2],
    away: [i64; 2],
    first: usize,
) -> Option<[i64; 2]> {
    for by in OUT.into_iter().skip(first) {
        if by != 0 && away == [0, 0] {
            break;
        }
        let q = moved(p, away, by);
        let at = Vec3::new(q[0], 0, q[1]);
        if map.spot(ground, at).is_some() {
            return Some(q);
        }
        let Some(s) = map.spot_near(ground, at, SNAP) else {
            continue;
        };
        let w = map.world(s.piece, s.at);
        let e = [w[0] * 1000, w[2] * 1000];
        // A point found on the ground's edge is moved a little inside, away from where it was asked.
        let inside = moved(e, [e[0] - q[0], e[1] - q[1]], INSIDE);
        if map
            .spot(ground, Vec3::new(inside[0], 0, inside[1]))
            .is_some()
        {
            return Some(inside);
        }
        return Some(e);
    }
    None
}

fn nearest(points: &[[i64; 2]], to: [i64; 2]) -> usize {
    (0..points.len())
        .min_by_key(|&k| d2(points[k], to))
        .unwrap_or(0)
}

impl Points {
    /// A point on the open ground `ground`, or one dropped.
    fn push(&mut self, ground: Id, p: Option<[i64; 2]>) {
        match p {
            Some(p) => {
                let v = Vec3::new(p[0], 0, p[1]);
                self.points.push(v);
                self.on.push((ground, v));
            }
            None => self.dropped += 1,
        }
    }
}

/// The floor holding `p` (µm, the open ground's frame) where the open ground does not: a bridge's deck (#3226) or a
/// building's floor. Its node and `p` in that node's frame, µm; the lowest when floors stack.
fn floor_at(map: &Map, ground: Id, p: [i64; 2]) -> Option<(Id, Vec3)> {
    let mut best: Option<(i64, Id, Vec3)> = None;
    for (q, rec) in map.pieces.iter().enumerate() {
        let Some(y) = rec.piece.vertices.first().map(|v| i64::from(v[1])) else {
            continue;
        };
        if rec.at.node == ground || best.is_some_and(|b| b.0 <= y) {
            continue;
        }
        let x = &map.frames[rec.frame as usize];
        let [w, a, b, c] = x.rot.parts();
        let Some(local) = Quat::new(w, -a, -b, -c).ok().and_then(|back| {
            back.rotate(Vec3::new(p[0], 0, p[1]).minus(x.pos).ok()?)
                .ok()
        }) else {
            continue;
        };
        if map
            .locate(q as u32, [super::mm(local.x), super::mm(local.z)], y)
            .is_some()
        {
            best = Some((y, rec.at.node, Vec3::new(local.x, y * 1000, local.z)));
        }
    }
    best.map(|(_, n, v)| (n, v))
}

/// Where a body stands for the stop `p` (µm, the open ground's frame): on the open ground there, else on a floor
/// there, else on the nearest walkable open ground. The point in the ground's frame, and its node and point there.
fn stand(map: &Map, ground: Id, p: [i64; 2]) -> Option<([i64; 2], (Id, Vec3))> {
    if map.spot(ground, Vec3::new(p[0], 0, p[1])).is_some() {
        return Some((p, (ground, Vec3::new(p[0], 0, p[1]))));
    }
    if let Some(f) = floor_at(map, ground, p) {
        return Some((p, f));
    }
    let q = onto_ground(map, ground, p, [0, 0], 0)?;
    Some((q, (ground, Vec3::new(q[0], 0, q[1]))))
}

/// The points of `way` for a body at `from` (µm, the open ground's frame), walking on to `goal` if the intent names
/// one, on the open ground `ground` of `map`. The goal itself is not among them.
pub fn points(
    tree: &Tree,
    map: &Map,
    ground: Id,
    from: Vec3,
    goal: Option<Vec3>,
    way: &Way,
) -> Result<Points, Refusal> {
    let here = [from.x, from.z];
    let mut out = Points::default();
    let stop = |s: &Stop| -> Result<[i64; 2], Refusal> {
        match s {
            Stop::Point(p) => Ok(*p),
            Stop::Node(id) => {
                let f = figure(tree, *id)?;
                let n = f.points.len();
                Ok(if f.closed {
                    middle(&f.points)
                } else {
                    // A line's middle: its middle corner, or the middle of its two middle corners.
                    middle(&[f.points[(n - 1) / 2], f.points[n / 2]])
                })
            }
        }
    };
    match &way.shape {
        Shape::Direct => {}
        Shape::Via(stops) => {
            for s in stops {
                let p = stop(s)?;
                let (q, at) = stand(map, ground, p)
                    .ok_or_else(|| refusal("way-off-ground", format!("({}, {}) µm", p[0], p[1])))?;
                out.points.push(Vec3::new(q[0], 0, q[1]));
                out.on.push(at);
            }
        }
        Shape::Along(id) => {
            let f = figure(tree, *id)?;
            let mut line = f.points.clone();
            if f.closed {
                let c = middle(&line);
                let n = line.len();
                let a = nearest(&line, here);
                let b = goal.map_or(a + n, |g| {
                    let b = nearest(&line, [g.x, g.z]);
                    // The shorter way round: forward when it is at most half the corners.
                    if (b + n - a) % n <= n / 2 {
                        a + (b + n - a) % n
                    } else {
                        a + n - (a + n - b) % n
                    }
                });
                let picked: Vec<[i64; 2]> = if b >= a {
                    (a..=b).map(|k| line[k % n]).collect()
                } else {
                    (b..=a).rev().map(|k| line[k % n]).collect()
                };
                for p in thin(picked, POINTS_MOST) {
                    out.push(
                        ground,
                        onto_ground(map, ground, p, [p[0] - c[0], p[1] - c[1]], 1),
                    );
                }
            } else {
                if d2(line[line.len() - 1], here) < d2(line[0], here) {
                    line.reverse();
                }
                // The side of the line the body stands on, for a line with a width (a river's shore).
                let side = {
                    let (a, b) = (line[0], line[1]);
                    let c = i128::from(b[0] - a[0]) * i128::from(here[1] - a[1])
                        - i128::from(b[1] - a[1]) * i128::from(here[0] - a[0]);
                    if c >= 0 { 1 } else { -1 }
                };
                let n = line.len();
                let kept = thin((0..n).map(|k| [k as i64, 0]).collect(), POINTS_MOST);
                for k in kept {
                    let k = k[0] as usize;
                    let (a, b) = (line[k.saturating_sub(1)], line[(k + 1).min(n - 1)]);
                    let normal = [-(b[1] - a[1]) * side, (b[0] - a[0]) * side];
                    let p = moved(line[k], normal, f.width / 2);
                    out.push(
                        ground,
                        onto_ground(map, ground, p, normal, usize::from(f.width > WIDE)),
                    );
                }
            }
        }
        Shape::Round { place, laps } => {
            let f = figure(tree, *place)?;
            if !f.closed {
                return Err(refusal(
                    "way-round-needs-an-outline",
                    format!("{} is a line", show(*place)),
                ));
            }
            let c = middle(&f.points);
            let ring: Vec<[i64; 2]> = thin(f.points, POINTS_MOST)
                .into_iter()
                .filter_map(|p| {
                    let q = onto_ground(map, ground, p, [p[0] - c[0], p[1] - c[1]], 1);
                    if q.is_none() {
                        out.dropped += 1;
                    }
                    q
                })
                .collect();
            if ring.is_empty() {
                return Err(refusal("way-off-ground", show(*place)));
            }
            let a = nearest(&ring, here);
            for _ in 0..*laps {
                for k in 0..ring.len() {
                    out.push(ground, Some(ring[(a + k) % ring.len()]));
                }
            }
            out.push(ground, Some(ring[a]));
        }
        Shape::Between { ends, laps } => {
            let mut e = Vec::new();
            for s in ends {
                let p = stop(s)?;
                let (q, at) = stand(map, ground, p)
                    .ok_or_else(|| refusal("way-off-ground", format!("({}, {}) µm", p[0], p[1])))?;
                e.push((Vec3::new(q[0], 0, q[1]), at));
            }
            let order = std::iter::once(0).chain((0..*laps).flat_map(|_| [1, 0]));
            for k in order {
                out.points.push(e[k].0);
                out.on.push(e[k].1);
            }
        }
    }
    out.searches = out.points.len() as u32 + u32::from(goal.is_some());
    Ok(out)
}
