//! W9 (#4085): the floors and seats' stand points a Soul could walk to from the world's arrival ground and not walk
//! back from (Mimos on the Mars campus, W8 #4084: a walk in was receipted, every walk out refused `souls:no-way`).
//!
//! Each is walked, not looked up: a body stands at the arrival point on the open ground, and the walker the served
//! world runs (sent to a standing spot by the target as N9 sends it, N7's walk through the host, the controller
//! carrying it across each link) walks it to the target; once there, it walks back to the arrival point. Each tick is
//! stepped as `worldd` steps its bodies: the place, legs and lines from the planner a tick after they are asked for
//! (K18b, here in lockstep), and the never-stuck ladder climbed after the tick (0.133 N1: routed again at 3 s without
//! progress, ..., ended `goal-unreachable` at 15 s). A target the walk in reaches but the walk back does not
//! (refused, ended short, or with no answer after [`WAIT`] of the world's time) is one-way, named with why. A floor is
//! walked to at a point of each of its pieces (the middle of the piece's largest triangle), a seat to its stand point
//! (its entry's, cleared of its own thing's solids as `worldd seed` clears it), carried onto the floor under it.

use import_eden::Import;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Header, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::host::Progress;
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::rules::json::Value as Json;
use replica::time::Micros;
use sim::host::{Batches, Planned, Runner};
use sim::links::Doors;
use sim::mover::Body;
use sim::planner::Planner;
use sim::spots::Target;
use sim::unstick::Ladder;
use sim::walk::town::Town;
use skills::route::Route;
use std::collections::BTreeMap;

/// The walker's tick and pace (today's walking body).
const TICK: Micros = 50_000;
const SPEED: i64 = 1_400_000;
/// A walk with no answer after this much of the world's time never ends: ten minutes, eight times the longest walk
/// across the Mars campus or Eden at walking pace.
pub const WAIT: Micros = 600_000_000;
/// A walk back that ends done ends within this of the arrival point, mm: the standing spot granted by it.
const NEAR: i128 = 10_000;
/// A floor's piece smaller than this, µm², holds no standing body worth a walk (a sliver between two solids).
const SMALLEST: i128 = 250_000_000_000;

/// Where the check starts, and the entries it reads seats' stand points from.
pub struct Opts {
    /// The arrival point on the open ground, mm (`worldd seed --at`).
    pub arrival: [i64; 2],
    /// Every Soul Actions entry, `(kind, entry)`, as `worldd seed --entries` reads them; empty: no seats are walked.
    pub entries: Vec<(String, Json)>,
    /// Only the targets whose name holds one of these (`floor e_1277cee2/floor-2`, `seat e_c4e5895b`); empty: all.
    pub only: Vec<String>,
}

/// One target the walk in reaches and no walk leaves: its name and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OneWay {
    pub name: String,
    pub why: String,
}

/// The check's answer for one world.
#[derive(Clone, Debug, Default)]
pub struct Ways {
    /// Targets walked to: floors' pieces and seats' stand points.
    pub targets: usize,
    /// The point on the open ground every walk started from and came back to, mm.
    pub arrival: [i64; 2],
    /// Of those, the ones a walk from the arrival point did not reach (refused or ended short), with why: not
    /// counted among the one-way.
    pub unreached: Vec<OneWay>,
    pub one_way: Vec<OneWay>,
    /// The ticks walked, every walk's together (each [`TICK`] of the world's time).
    pub ticks: u64,
}

/// Every Soul Actions entry under `dir`, as `worldd seed --entries` reads them (`souls-entry/1`, by its kind).
pub fn entries(dir: &std::path::Path, out: &mut Vec<(String, Json)>) -> std::io::Result<()> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| Some(e.ok()?.path()))
        .collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            entries(&p, out)?;
        } else if p.extension().is_some_and(|x| x == "json") {
            let Ok(v) = replica::rules::json::parse(&std::fs::read_to_string(&p)?) else {
                continue;
            };
            if v.get("format").and_then(Json::str) != Some("souls-entry/1") {
                continue;
            }
            if let Some(kind) = v.get("kind").and_then(Json::str) {
                out.push((kind.to_owned(), v.clone()));
            }
        }
    }
    Ok(())
}

/// The loaded world as a town, its door writer under a header of its own root.
fn town_of(im: Import) -> Result<Town, String> {
    let Import {
        tree, rules, nodes, ..
    } = im;
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/import-world/ways/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).map_err(|e| format!("{e:?}"))?)
        .map_err(|e| format!("{}: {}", e.name, e.detail))?;
    let next = tree.to_state().next;
    Town::new(tree, nodes["ground"], Doors::new(header, rules, next))
}

fn humanoid() -> Family {
    let r = |n: &str| Resource {
        name: Name::new(n).expect("a name"),
        class: Class::Locomotion,
        slot: None,
    };
    Family {
        name: Name::new("souls:humanoid").expect("a name"),
        resources: vec![r("souls:leg-left"), r("souls:leg-right")],
    }
}

/// A point of each piece of `node`'s surface worth standing on: the middle of its largest triangle, µm.
fn piece_points(t: &Town, node: Id) -> Vec<Vec3> {
    let Some(s) = t.surfaces.get(&node) else {
        return Vec::new();
    };
    s.pieces()
        .iter()
        .filter_map(|pc| {
            let v = |k: u32| pc.vertices[k as usize].map(|c| i128::from(c) * 1000);
            let area = |t: &[u32; 3]| {
                let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
                ((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])).abs() / 2
            };
            let total: i128 = pc.triangles.iter().map(area).sum();
            let big = pc.triangles.iter().max_by_key(|t| area(t))?;
            let (a, b, c) = (v(big[0]), v(big[1]), v(big[2]));
            let mid = |k: usize| i64::try_from((a[k] + b[k] + c[k]) / 3).ok();
            (total >= SMALLEST).then_some(Vec3::new(mid(0)?, mid(1)?, mid(2)?))
        })
        .collect()
}

/// One walker's bodies as `worldd` steps them (`worldd::bodies`): its runner, the never-stuck ladder over it, and
/// the planner's answers to the last tick's wants, with the batches sent and taken (in lockstep: one each tick).
struct Walker {
    r: Runner,
    ladder: Ladder,
    planned: Planned,
    batches: u64,
}

impl Walker {
    fn new() -> Walker {
        Walker {
            r: Runner::new(TICK),
            ladder: Ladder::served(),
            planned: Planned::default(),
            batches: 0,
        }
    }

    /// One tick, as `worldd::bodies` steps one: the ladder keeps each walk the planner placed (`worldd::unstick`),
    /// the runner ticks with the planner's answers, the ladder's rungs are climbed, and the planner answers this
    /// tick's wants for the next.
    fn tick(&mut self, t: &mut Town, p: &mut Planner) -> Result<(), String> {
        let mut planned = std::mem::take(&mut self.planned);
        planned.batches = Some(Batches {
            taken: self.batches,
            next: self.batches,
        });
        for (who, (order, placed)) in &planned.places {
            let Ok((place, legs, _)) = placed else {
                continue;
            };
            if self.ladder.order(*who) == Some(*order) {
                // Placed again for the same order: the ladder's reroute asked for it.
                self.ladder.routed(&self.r, *who, legs.clone());
            } else if self.r.asks.contains_key(who) {
                self.ladder
                    .add(*who, *order, SPEED, place.node, place.at, legs.clone());
            }
        }
        let (wants, ticked) = self.r.tick_planned(t, &planned);
        ticked.map_err(|e| format!("the tick refused {}", e.name))?;
        self.ladder.after(&mut self.r, t);
        self.ladder.forget_ended(&self.r);
        self.planned = p.answer(&wants);
        self.batches += 1;
        Ok(())
    }
}

/// How one walk ended: done, or why not.
/// As the served world sends a walk (N9): the body asks a standing spot by the target and walks there once granted.
fn walk(
    w: &mut Walker,
    t: &mut Town,
    p: &mut Planner,
    body: Body,
    target: Target,
    order: Id,
    ticks: &mut u64,
) -> Result<(), String> {
    let r = &mut w.r;
    if r.controller.body(body.id).is_none() {
        r.add_body(humanoid(), body)
            .map_err(|e| format!("refused {}", e.name))?;
    }
    r.send(body.id, Box::new(Route::sent(SPEED, TICK)), target, order)
        .map_err(|e| format!("refused {}", e.name))?;
    for _ in 0..WAIT / TICK {
        *ticks += 1;
        w.tick(t, p)?;
        match w.r.ended.get(&body.id) {
            Some((_, Progress::Done)) => return Ok(()),
            Some((_, Progress::Failed(n))) => return Err(format!("ended {}", n.as_str())),
            _ => {}
        }
    }
    Err(format!("no answer after {} s", WAIT / 1_000_000))
}

/// The one-way targets of the world in the facts `text`.
pub fn ways(text: &str, opts: &Opts) -> Result<Ways, String> {
    let im = import_eden::load(text)?;
    let names: BTreeMap<Id, String> = im.nodes.iter().map(|(k, v)| (*v, k.clone())).collect();
    let name = |n: Id| names.get(&n).cloned().unwrap_or_else(|| format!("{n:?}"));
    let mut entries = opts.entries.clone();
    import_eden::clear_stand_points(&im, &mut entries);
    let (slots, _) = import_eden::body_slots(&im.tree, &entries);
    let mut t = town_of(im)?;
    let ground = t.ground;
    // The planner over its own copy of the town, as the served world's (K18b).
    let mut planner = Planner::new(t.copy()?);

    // Each target: its name, its node and the point on it (µm, the node's frame).
    let mut targets: Vec<(String, Id, Vec3)> = Vec::new();
    let floors: Vec<Id> = t
        .buildings
        .iter()
        .flat_map(|b| b.floors.keys().copied())
        .collect();
    for f in floors {
        let points = piece_points(&t, f);
        let n = points.len();
        for (k, p) in points.into_iter().enumerate() {
            let piece = if n > 1 {
                format!(" piece {}", k + 1)
            } else {
                String::new()
            };
            targets.push((format!("floor {}{piece}", name(f)), f, p));
        }
    }
    // A seat whose stand point is over no floor is no place to walk to: named, not walked.
    let mut floorless = Vec::new();
    for s in &slots {
        let label = format!("seat {} slot {} stand point", name(s.thing), s.slot);
        match t.view().on_floor(s.thing, s.stand) {
            Some((node, at, _)) => targets.push((label, node, at)),
            None => floorless.push(OneWay {
                name: label,
                why: "no floor under its stand point".into(),
            }),
        }
    }
    if !opts.only.is_empty() {
        targets.retain(|(l, _, _)| opts.only.iter().any(|o| l.contains(o.as_str())));
        floorless.retain(|u| opts.only.iter().any(|o| u.name.contains(o.as_str())));
    }

    // The arrival point, or the nearest point of the open ground by it a body stands on (on a 0.5 m grid, within
    // 20 m), as a birth there takes the ring round it.
    let ground_at = |x: i64, z: i64| {
        t.surfaces[&ground]
            .place(
                Id::new(Scope([0xee; 16]), 1).expect("an id"),
                Frame {
                    node: ground,
                    slot: None,
                },
                Vec3::new(x, 0, z),
                Quat::IDENTITY,
            )
            .is_ok()
    };
    let [ax, az] = opts.arrival.map(|v| v * 1000);
    let mut near: Vec<(i64, i64, i64)> = (-40..=40_i64)
        .flat_map(|i| (-40..=40_i64).map(move |j| (i * i + j * j, i * 500_000, j * 500_000)))
        .collect();
    near.sort_unstable();
    let arrival = near
        .into_iter()
        .find(|&(_, dx, dz)| ground_at(ax + dx, az + dz))
        .map(|(_, dx, dz)| Vec3::new(ax + dx, 0, az + dz))
        .ok_or("the arrival point: no open ground within 20 m")?;
    let mut out = Ways {
        targets: targets.len() + floorless.len(),
        arrival: [arrival.x / 1000, arrival.z / 1000],
        unreached: floorless,
        ..Ways::default()
    };
    // The piece of `node`'s surface that holds `p`, as the mover places a body there; `None` off it.
    let piece_at = |t: &Town, node: Id, p: Vec3| {
        let s = t.surfaces.get(&node)?;
        let who = Id::new(Scope([0xee; 16]), 1)?;
        let b = s.place(who, Frame { node, slot: None }, p, Quat::IDENTITY);
        b.ok().map(|b| b.piece)
    };
    for (k, (label, node, at)) in targets.into_iter().enumerate() {
        let who = Id::new(Scope([0xee; 16]), k as u64 + 1).ok_or("a walker's id")?;
        let start = t.surfaces[&ground]
            .place(
                who,
                Frame {
                    node: ground,
                    slot: None,
                },
                arrival,
                Quat::IDENTITY,
            )
            .map_err(|e| format!("the arrival point: {}: {}", e.name, e.detail))?;
        let mut w = Walker::new();
        let order = |n: u64| Id::new(Scope([0xed; 16]), 2 * k as u64 + n).ok_or("an order's id");
        let (p, ticks) = (&mut planner, &mut out.ticks);
        if let Err(why) = walk(
            &mut w,
            &mut t,
            p,
            start,
            Target::new(node, at),
            order(1)?,
            ticks,
        ) {
            out.unreached.push(OneWay {
                name: label,
                why: format!("the walk in: {why}"),
            });
            continue;
        }
        let there = *w.r.controller.body(who).ok_or("the walker's body")?;
        // A walk in that ends done ends on the target's piece: a standing spot granted on another piece (across a
        // wall, in another room) did not reach it.
        let on = there.pose.frame.node;
        let piece = piece_at(&t, node, at);
        if on != node || piece.is_some_and(|q| piece_at(&t, node, there.pose.position) != Some(q)) {
            out.unreached.push(OneWay {
                name: label,
                why: format!(
                    "the walk in ended done on {}, not on the target's piece",
                    name(on)
                ),
            });
            continue;
        }
        let to = Target::new(ground, arrival);
        let (p, ticks) = (&mut planner, &mut out.ticks);
        let back = walk(&mut w, &mut t, p, there, to, order(2)?, ticks).and_then(|()| {
            // A walk that ends done ends by the arrival point, on the open ground.
            let b = w.r.controller.body(who).ok_or("the walker's body")?;
            let (dx, dz) = (b.pose.position.x - arrival.x, b.pose.position.z - arrival.z);
            let off = (i128::from(dx).pow(2) + i128::from(dz).pow(2)).isqrt() / 1000;
            match (b.pose.frame.node == ground, off <= NEAR) {
                (true, true) => Ok(()),
                (on, _) => Err(format!(
                    "ended done {off} mm from it{}",
                    if on { "" } else { ", off the open ground" }
                )),
            }
        });
        if let Err(why) = back {
            out.one_way.push(OneWay {
                name: label,
                why: format!("the walk back to the arrival point: {why}"),
            });
        }
    }
    Ok(out)
}
