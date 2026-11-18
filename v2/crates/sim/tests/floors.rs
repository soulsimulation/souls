//! Eden's floors cut off from the walkable town (Engine v2, #3227): each floor with no piece in the largest part of N5's
//! map, grouped by why. Needs N1's exported facts file (`node v2/tools/import-eden/export/export.ts` from the
//! repository root): `cargo test -p sim --release --test floors -- --ignored --nocapture`.

use import_eden::Import;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::world_model::{plain, show};
use sim::ground::Scene;
use sim::ground::scene::{FLOOR, Terrain, xform_to};
use sim::ground::STEP;
use sim::routes::{ALL, LinkInfo, Map};
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
    let terrain = Terrain::of(&im.tree, ground).unwrap().expect("Eden's terrain");
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
            on_terrain.extend(above_terrain(&im, &terrain, f));
            format!(
                "stands on the terrain {} the open ground's flat 0 (its doorway {} m off it)",
                if y > 0 { "above" } else { "below" },
                match y.abs() {
                    ..1000 => "0.2 to 1",
                    1000..3000 => "1 to 3",
                    _ => "3 or more",
                }
            )
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

