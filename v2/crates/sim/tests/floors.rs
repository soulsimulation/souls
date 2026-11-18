//! Eden's floors cut off from the walkable town (Engine v2, #3227): each floor with no piece in the largest part of N5's
//! map, grouped by why. Needs N1's exported facts file (`node v2/tools/import-eden/export/export.ts` from the
//! repository root): `cargo test -p sim --release --test floors -- --ignored --nocapture`.

use import_eden::Import;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::world_model::{plain, show};
use sim::ground::STEP;
use sim::ground::Scene;
use sim::ground::scene::{FLOOR, Terrain, xform_to};
use sim::links::Kind;
use sim::routes::{ALL, Hop, LinkInfo, Map, Spot};
use std::collections::{BTreeMap, BTreeSet};

fn eden() -> Import {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    import_eden::load(&text).expect("Eden loads")
}

/// A thing's def name (no version), or empty.
fn def_of(im: &Import, thing: Id) -> String {
    match im
        .tree
        .node(im.tree.handle(thing).unwrap())
        .unwrap()
        .fields()
        .get(&import_eden::F_DEF)
    {
        Some(replica::encode::Value::Bytes(d)) => String::from_utf8_lossy(d)
            .split('@')
            .next()
            .unwrap_or("")
            .to_owned(),
        _ => String::new(),
    }
}

fn parent(im: &Import, id: Id) -> Option<Id> {
    im.tree.node(im.tree.handle(id)?)?.parent()
}

fn kind(im: &Import, id: Id) -> String {
    im.tree
        .handle(id)
        .and_then(|h| im.tree.node(h))
        .map(|n| plain(n.kind().as_str()).to_owned())
        .unwrap_or_default()
}

/// The floor a link's node is on: the node itself if a floor, a room's floor, else `None` (the open ground).
fn floor_of(im: &Import, n: Id) -> Option<Id> {
    match kind(im, n).as_str() {
        FLOOR => Some(n),
        "eden:room" => parent(im, n),
        _ => None,
    }
}

/// A floor's lowest surface, mm in the ground's frame.
fn floor_y(im: &Import, f: Id) -> i64 {
    let gh = im.tree.handle(im.nodes["ground"]).unwrap();
    let th = im.tree.handle(parent(im, f).unwrap()).unwrap();
    let place = xform_to(&im.tree, th, gh).unwrap();
    let low = Scene::of(&im.tree, f)
        .map(|s| s.surfaces.iter().map(|s| s.y).min().unwrap_or(0))
        .unwrap_or(0);
    (place.pos.y + low) / 1000
}

/// How far each doorway of floor `f` to the open ground stands above the terrain under it, mm (N1b's heights).
fn above_terrain(im: &Import, terrain: &Terrain, f: Id) -> Vec<i64> {
    let gh = im.tree.handle(im.nodes["ground"]).unwrap();
    let th = im.tree.handle(parent(im, f).unwrap()).unwrap();
    let place = xform_to(&im.tree, th, gh).unwrap();
    let Ok(sc) = Scene::of(&im.tree, f) else {
        return Vec::new();
    };
    sc.doorways
        .iter()
        .filter(|d| !d.step)
        .filter(|d| {
            im.tree
                .link(d.link)
                .is_some_and(|(_, ns, ..)| ns.iter().any(|&n| floor_of(im, n).is_none()))
        })
        .filter_map(|d| {
            let w = place.point(Vec3::new(d.at[0], d.y, d.at[1])).ok()?;
            Some((w.y - terrain.height_at(w.x, w.z)?) / 1000)
        })
        .collect()
}

/// #3227's A1: every floor of Eden with no piece in the largest part of N5's map (a body with every ability), each
/// with why, grouped by cause. A floor reached only from another cut-off floor takes that floor's cause ("above").
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a1_cut_off_floors_by_cause() {
    let im = eden();
    let ground = im.nodes["ground"];
    let map = Map::build(&im.tree, ground, &|_| 0).expect("the map");
    let (pieces, portals, nlinks) = map.counts();
    println!("Eden map: {pieces} pieces, {portals} portals, {nlinks} links");
    let parts = map.parts(ALL);
    let mut size: BTreeMap<u32, usize> = BTreeMap::new();
    for &p in &parts {
        *size.entry(p).or_default() += 1;
    }
    let main = *size
        .iter()
        .max_by_key(|(k, n)| (**n, std::cmp::Reverse(**k)))
        .unwrap()
        .0;
    let mut floors: BTreeMap<Id, bool> = BTreeMap::new();
    for q in 0..pieces as u32 {
        let n = map.patch_of(q).node;
        if n != ground {
            *floors.entry(n).or_default() |= parts[q as usize] == main;
        }
    }
    let cut: BTreeSet<Id> = floors
        .iter()
        .filter(|(_, r)| !**r)
        .map(|(f, _)| *f)
        .collect();
    let terrain = Terrain::of(&im.tree, ground)
        .unwrap()
        .expect("Eden's terrain");
    let mut on_terrain: Vec<i64> = Vec::new();
    // Every link of the map with the floor (or the open ground, `None`) at each end.
    let mut touching: BTreeMap<Id, Vec<(LinkInfo, Option<Id>)>> = BTreeMap::new();
    for l in map.links() {
        let Some((_, nodes, ..)) = im.tree.link(l.id) else {
            continue;
        };
        let [a, b] = nodes.map(|n| floor_of(&im, n));
        for (here, there) in [(a, b), (b, a)] {
            if let Some(h) = here {
                touching.entry(h).or_default().push((l, there));
            }
        }
    }
    // Each cut-off floor's own cause, or the floor it is reached from.
    let mut own: BTreeMap<Id, String> = BTreeMap::new();
    let mut from: BTreeMap<Id, Id> = BTreeMap::new();
    for &f in &cut {
        let ls = touching.get(&f).cloned().unwrap_or_default();
        let y = floor_y(&im, f);
        let outer: Vec<_> = ls.iter().filter(|(_, t)| t.is_none()).collect();
        let rooms = im
            .tree
            .children(im.tree.handle(f).unwrap())
            .unwrap()
            .iter()
            .any(|&c| kind(&im, im.tree.node(c).unwrap().id()) == "eden:room");
        let storeys = im
            .tree
            .children(im.tree.handle(parent(&im, f).unwrap()).unwrap())
            .unwrap()
            .iter()
            .filter(|&&c| kind(&im, im.tree.node(c).unwrap().id()) == FLOOR)
            .count();
        let cause = if ls.is_empty() && !rooms && storeys > 1 {
            "a roof: no room on it and no stair to it".to_owned()
        } else if ls.is_empty() {
            format!("no doorway or stair, and its floor is {y} mm up, above a step ({STEP} mm)")
        } else if !outer.is_empty() && y.abs() > STEP {
            // On the terrain, off the open ground's plan at 0: how far its doorways stand off the terrain beside them.
            let off = above_terrain(&im, &terrain, f);
            on_terrain.extend(&off);
            match off.iter().map(|h| h.abs()).max() {
                Some(h) if h > STEP => format!(
                    "stands on the terrain, a doorway {h} mm off the terrain beside it, more than a step"
                ),
                _ => "stands on the terrain, its doorways within a step of it".to_owned(),
            }
        } else if let Some((l, _)) = outer.iter().find(|(l, _)| l.blocked.is_some()) {
            format!("a doorway to the open ground: {}", l.blocked.unwrap())
        } else if !outer.is_empty() {
            "its doorways reach open ground that is itself cut off".to_owned()
        } else if let Some((l, _)) = ls
            .iter()
            .find(|(l, t)| l.blocked.is_some() && t.is_some_and(|t| !cut.contains(&t)))
        {
            format!(
                "its {:?} from a reached floor: {}",
                l.kind,
                l.blocked.unwrap()
            )
        } else if let Some((_, Some(t))) = ls.iter().find(|(_, t)| t.is_some_and(|t| t != f)) {
            from.insert(f, *t);
            continue;
        } else {
            "only links to itself".to_owned()
        };
        own.insert(f, cause);
    }
    let root = |mut f: Id| {
        let mut seen = BTreeSet::new();
        while let Some(&t) = from.get(&f) {
            if !seen.insert(f) {
                break;
            }
            f = t;
        }
        f
    };
    let mut table: BTreeMap<String, Vec<(String, Id)>> = BTreeMap::new();
    for &f in &cut {
        let r = root(f);
        let cause = match own.get(&r) {
            Some(c) if r == f => c.clone(),
            Some(c) => format!("above a cut-off floor: {c}"),
            None => "a cycle of cut-off floors".to_owned(),
        };
        let thing = parent(&im, f).unwrap();
        table
            .entry(cause)
            .or_default()
            .push((def_of(&im, thing), f));
    }
    println!(
        "floors with no piece in the largest part: {} of {}",
        cut.len(),
        floors.len()
    );
    on_terrain.sort();
    println!(
        "doorways of floors on the terrain, above the terrain under them: {} doorways, {} to {} mm, {} within a step ({STEP} mm)",
        on_terrain.len(),
        on_terrain.first().unwrap_or(&0),
        on_terrain.last().unwrap_or(&0),
        on_terrain.iter().filter(|h| h.abs() <= STEP).count()
    );
    println!("| cause | floors | by def |");
    println!("|---|---|---|");
    for (cause, fs) in &table {
        let mut by: BTreeMap<&str, usize> = BTreeMap::new();
        for (d, _) in fs {
            *by.entry(d.as_str()).or_default() += 1;
        }
        println!(
            "| {cause} | {} | {} |",
            fs.len(),
            by.iter()
                .map(|(d, n)| format!("{d} {n}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    // #3227's A2: no floor is left cut off by a cause the cut or the import can fix.
    for cause in table.keys() {
        assert!(
            !cause.contains("within a step")
                && !cause.contains("cycle")
                && !cause.contains("only links to itself"),
            "a floor cut off by a cause that is not a feature of Eden: {cause}"
        );
    }
    for (cause, fs) in &table {
        println!(
            "{cause}: {}",
            fs.iter()
                .map(|(_, f)| show(*f))
                .collect::<Vec<_>>()
                .join(" ")
        );
    }
}

/// SplitMix64: the seeded pairs.
struct Seed(u64);

impl Seed {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// The floors of things standing off the open ground's plan at 0 by more than a step (on the terrain), and the rings
/// (the ground's frame, mm) of every floor that was no footprint on the plan before #3227 (1.8 m or more off 0) and
/// may be one now.
fn on_terrain_rings(im: &Import) -> (BTreeSet<Id>, Vec<Vec<[i64; 2]>>) {
    let ground = im.nodes["ground"];
    let gh = im.tree.handle(ground).unwrap();
    let (mut floors, mut rings) = (BTreeSet::new(), Vec::new());
    for &c in im.tree.children(gh).unwrap() {
        let th = c;
        let place = xform_to(&im.tree, th, gh).unwrap();
        for &f in im.tree.children(th).unwrap() {
            let fid = im.tree.node(f).unwrap().id();
            if kind(im, fid) != FLOOR {
                continue;
            }
            if place.pos.y.abs() > STEP * 1000 {
                floors.insert(fid);
            }
            // A floor (not ground cover) no footprint on the plan before: its surfaces 1.8 m or more off 0.
            if let Ok(s) = Scene::of(&im.tree, fid)
                && s.surfaces
                    .iter()
                    .all(|sf| (place.pos.y + sf.y).abs() >= 1_800_000)
            {
                for sf in &s.surfaces {
                    rings.push(
                        sf.ring
                            .iter()
                            .map(|p| {
                                let w = place.point(Vec3::new(p[0], 0, p[1])).unwrap();
                                [w.x / 1000, w.z / 1000]
                            })
                            .collect(),
                    );
                }
            }
        }
    }
    (floors, rings)
}

/// Whether  lies inside the ring , or within 400 mm of it (the cut grows a footprint by the body's clearance).
fn inside(r: &[[i64; 2]], p: [i64; 2]) -> bool {
    let near = (0..r.len()).any(|k| {
        let (a, b) = (r[k], r[(k + 1) % r.len()]);
        let (ex, ez) = (b[0] - a[0], b[1] - a[1]);
        let l2 = (ex * ex + ez * ez).max(1);
        let t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez).clamp(0, l2);
        let (dx, dz) = (a[0] + ex * t / l2 - p[0], a[1] + ez * t / l2 - p[1]);
        dx * dx + dz * dz <= 400 * 400
    });
    let mut c = near;
    for k in 0..r.len() {
        let (a, b) = (r[k], r[(k + 1) % r.len()]);
        let lhs = i128::from(p[0] - a[0]) * i128::from(b[1] - a[1]);
        let rhs = i128::from(b[0] - a[0]) * i128::from(p[1] - a[1]);
        if (a[1] > p[1]) != (b[1] > p[1]) && ((lhs < rhs) == (b[1] > a[1])) {
            c = !c;
        }
    }
    c
}

/// #3227's A3: N5's 10,000 Eden routes (A1's seed, drawn from the largest part) before and after. The first run
/// writes each pair (node and point, so that a renumbered map finds them again) and its route's length and waypoints
/// to `.local/routes/a3-3227.tsv`; a later run routes the pairs again and counts the routes that changed, by why:
/// now over a floor of a building on the terrain (newly joined), or before through such a building's footprint on
/// the open ground (walked through at the plan's 0, now taken away), or over the step onto another thing's floor.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a3_eden_routes_before_and_after() {
    const ROUTES: usize = 10_000;
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/routes/a3-3227.tsv"
    );
    let im = eden();
    let ground = im.nodes["ground"];
    let mut map = Map::build(&im.tree, ground, &|_| 0).expect("the map");
    let wps = |r: &sim::routes::Route| {
        r.waypoints
            .iter()
            .map(|w| format!("{},{}", w[0], w[2]))
            .collect::<Vec<_>>()
            .join(";")
    };
    let Ok(before) = std::fs::read_to_string(path) else {
        let (pieces, ..) = map.counts();
        let parts = map.parts(ALL);
        let mut size: BTreeMap<u32, usize> = BTreeMap::new();
        for &p in &parts {
            *size.entry(p).or_default() += 1;
        }
        let main = *size
            .iter()
            .max_by_key(|(k, n)| (**n, std::cmp::Reverse(**k)))
            .unwrap()
            .0;
        let among: Vec<u32> = (0..pieces as u32)
            .filter(|&q| parts[q as usize] == main)
            .collect();
        let mut seed = Seed(2653);
        let mut pick = || loop {
            let q = among[seed.below(among.len())];
            let st = map.standing(q);
            if !st.is_empty() {
                return Spot {
                    piece: q,
                    at: st[seed.below(st.len())],
                };
            }
        };
        let pairs: Vec<(Spot, Spot)> = (0..ROUTES).map(|_| (pick(), pick())).collect();
        let mut out = String::new();
        for (a, b) in pairs {
            let r = map.route(&im.tree, a, b, ALL).expect("a route");
            let n = |s: Spot| map.patch_of(s.piece).node;
            out.push_str(&format!(
                "{}\t{:?}\t{}\t{:?}\t{}\t{}\n",
                show(n(a)),
                a.at,
                show(n(b)),
                b.at,
                r.length,
                wps(&r)
            ));
        }
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, out).unwrap();
        println!("A3: {ROUTES} routes written to .local/routes/a3-3227.tsv");
        return;
    };
    let ids: BTreeMap<String, Id> = {
        let (pieces, ..) = map.counts();
        (0..pieces as u32)
            .map(|q| map.patch_of(q).node)
            .map(|n| (show(n), n))
            .collect()
    };
    let at = |s: &str| -> Vec3 {
        let v: Vec<i64> = s
            .trim_matches(['[', ']'])
            .split(", ")
            .map(|x| x.parse().unwrap())
            .collect();
        Vec3::new(v[0] * 1000, v[1] * 1000, v[2] * 1000)
    };
    let (hill, rings) = on_terrain_rings(&im);
    let through_hill = |w: &str| {
        let pts: Vec<[i64; 2]> = w
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|p| {
                let v: Vec<i64> = p.split(',').map(|x| x.parse().unwrap()).collect();
                [v[0], v[1]]
            })
            .collect();
        pts.windows(2).any(|s| {
            let (a, b) = (s[0], s[1]);
            let n = ((b[0] - a[0]).abs().max((b[1] - a[1]).abs()) / 250).max(1);
            (0..=n).any(|k| {
                let p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
                rings.iter().any(|r| inside(r, p))
            })
        })
    };
    let (mut same, mut changed, mut lost, mut lost_inside, mut near) = (0, 0, 0, 0, 0);
    let (mut onto_hill, mut was_through, mut onto_floor, mut other) = (0, 0, 0, 0);
    for row in before.lines() {
        let f: Vec<&str> = row.splitn(6, '\t').collect();
        let (Some(a), Some(b)) = (map.spot(ids[f[0]], at(f[1])), map.spot(ids[f[2]], at(f[3])))
        else {
            lost += 1;
            let w = |n: &str, v: Vec3| (n == show(ground)).then_some([v.x / 1000, v.z / 1000]);
            let gone = [w(f[0], at(f[1])), w(f[2], at(f[3]))]
                .into_iter()
                .flatten()
                .any(|p| rings.iter().any(|r| inside(r, p)));
            lost_inside += usize::from(gone);
            if lost - lost_inside <= 3 && !gone {
                println!("  not found now: {row:.100}");
            }
            continue;
        };
        let r = match map.route(&im.tree, a, b, ALL) {
            Ok(r) => r,
            Err(e) => {
                println!("  refused now: {row:.120}: {}", e.detail);
                lost += 1;
                continue;
            }
        };
        if r.length.to_string() == f[4] && wps(&r) == f[5] {
            same += 1;
            continue;
        }
        changed += 1;
        let joined = r
            .hops
            .iter()
            .any(|h| matches!(h, Hop::Patch { at, .. } if hill.contains(&at.node)));
        // A step between two floors, neither the open ground: onto another thing's floor.
        let step = r.hops.windows(3).any(|w| match w {
            [
                Hop::Patch { at: a, .. },
                Hop::Link {
                    kind: Kind::Step, ..
                },
                Hop::Patch { at: b, .. },
            ] => a.node != b.node && a.node != ground && b.node != ground,
            _ => false,
        });
        if joined {
            onto_hill += 1;
        } else if through_hill(f[5]) {
            was_through += 1;
        } else if step {
            onto_floor += 1;
        } else if (r.length as i64 - f[4].parse::<i64>().unwrap()).abs() * 100 < r.length as i64 {
            near += 1;
        } else {
            other += 1;
            if other <= 5 {
                println!(
                    "  changed otherwise: {row}\n    now {} mm: {}",
                    r.length,
                    wps(&r)
                );
            }
        }
    }
    println!(
        "A3: {same} routes unchanged, {changed} changed: {onto_hill} now over a floor of a building on the terrain, \
         {was_through} were through such a building's footprint on the plan, {onto_floor} over a step onto another thing's floor, \
         {near} by under 1 % (the open ground cut again), {other} otherwise; {lost} not found or refused, {lost_inside} \
         of them a spot on the open ground now inside a building on the terrain"
    );
}
