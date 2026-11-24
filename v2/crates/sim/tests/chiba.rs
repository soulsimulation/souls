//! Chiba on the Mars campus (`mars-fidelity-chiba@1`, 0.133). Its ground storey stands 374 mm up, more than a step,
//! and today's page stepped onto it from the terrain anywhere along its edge; the importer gives it an entrance tread
//! of two risers along each open edge. Its four ground areas lie between partitions over a 300 mm seam the mesh floors
//! left, which the importer closes, so the partitions' doorways join them. Its upper storey is a deck of floor pieces
//! 150 mm apart, joined by short flights within the storey. Every piece of Chiba a body has room on is reached from
//! the town, and a Soul on the open ground outside walks in, to both ground areas that were cut off, then up to the
//! upper storey and across it to its far end. Needs the Mars campus's exported facts (from the repository root):
//! `node v2/tools/import-eden/export/export.ts --template worlds/templates/mars-two.json --map content/worlds/mars/map.json --out .local/import-eden/mars-two.facts.json`,
//! then `cargo test -p sim --release --test chiba -- --ignored --nocapture`.

mod common;

use common::{arrived, dist, id, stand, walk};
use import_eden::{F_DEF, F_LEVEL, FLOOR, Import};
use replica::encode::Value;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::world_model::plain;
use sim::host::Runner;
use sim::mover::Body;
use sim::routes::{ALL, Map};
use sim::walk::node_of;
use sim::walk::town::Town;
use std::collections::BTreeMap;

const SPEED: i64 = 1_400_000; // µm a second
const TICK: i64 = 50_000; // µs

fn mars() -> Import {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/mars-two.facts.json"
    );
    let text = std::fs::read_to_string(path).expect("export the Mars campus's facts first");
    import_eden::load(&text).expect("the Mars campus loads")
}

/// Chiba, and its floors by level.
fn chiba(im: &Import) -> (Id, BTreeMap<i64, Id>) {
    let t = &im.tree;
    let thing = im
        .nodes
        .values()
        .copied()
        .find(|&n| {
            t.handle(n).and_then(|h| t.node(h)).is_some_and(|n| {
                matches!(n.fields().get(&F_DEF), Some(Value::Bytes(d)) if d.starts_with(b"mars-fidelity-chiba@"))
            })
        })
        .expect("Chiba");
    let mut floors = BTreeMap::new();
    for &c in t.children(t.handle(thing).unwrap()).unwrap() {
        let n = t.node(c).unwrap();
        if plain(n.kind().as_str()) == FLOOR
            && let Some(Value::Uint(l)) = n.fields().get(&F_LEVEL)
        {
            floors.insert(*l as i64, n.id());
        }
    }
    (thing, floors)
}

/// A piece smaller than this, mm², is a slip between solids, no room to stand in (a quarter square metre).
const SLIP_MM2: i64 = 250_000;
/// On the ground storey, a piece smaller than this, mm², is a nook its furniture makes (1 m²): the two sofas and the
/// bleachers' side leave one of 0.5 m² in the south hall, as they did before the storey had an entrance.
const NOOK_MM2: i64 = 1_000_000;

/// A piece's area on the ground plane, mm².
fn area_mm2(p: &sim::ground::Piece) -> i64 {
    p.triangles
        .iter()
        .map(|t| {
            let v = |k: usize| p.vertices[t[k] as usize];
            let (a, b, c) = (v(0), v(1), v(2));
            let cross = i64::from(b[0] - a[0]) * i64::from(c[2] - a[2])
                - i64::from(c[0] - a[0]) * i64::from(b[2] - a[2]);
            cross.abs() / 2
        })
        .sum()
}

fn kind_of(t: &Town, link: Id) -> sim::links::Kind {
    t.buildings
        .iter()
        .find_map(|b| b.link(link).map(|l| l.kind))
        .expect("a link")
}

/// The standing point of `node` (in its frame, mm) nearest `[x, z]`, among the pieces `keep` keeps.
fn nearest(map: &Map, node: Id, keep: &dyn Fn(u32) -> bool, x: i64, z: i64) -> [i64; 3] {
    let (pieces, ..) = map.counts();
    (0..pieces as u32)
        .filter(|&q| map.patch_of(q).node == node && keep(q))
        .flat_map(|q| map.standing(q))
        .min_by_key(|p| (p[0] - x).pow(2) + (p[2] - z).pow(2))
        .expect("a standing point")
}

fn um(p: [i64; 3]) -> Vec3 {
    Vec3::new(p[0] * 1000, p[1] * 1000, p[2] * 1000)
}

/// Body `who` walks to `goal` on `node`, on the engine's runner, until it stops: the links it crossed and when it
/// arrived (ms, from the walk's start), if it did.
fn go(c: &mut Runner, t: &mut Town, who: Body, node: Id, goal: Vec3) -> (String, Option<i64>) {
    let from = c.ended.get(&who.id).map_or(0, |e| e.0);
    let legs = walk(c, t, who, SPEED, node, goal)
        .unwrap_or_else(|e| panic!("no way there: {}: {}", e.name, e.detail));
    let crossed: Vec<String> = legs
        .iter()
        .filter_map(|l| l.link)
        .map(|k| format!("{:?}", kind_of(t, k)))
        .collect();
    for _ in 0..12_000 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
    }
    (
        crossed.join(", "),
        arrived(c, who.id).map(|a| (a - from) / 1000),
    )
}

#[test]
#[ignore = "needs the Mars campus's exported facts file"]
fn a_soul_walks_into_chiba_from_the_town_and_across_every_storey() {
    let im = mars();
    println!(
        "seams closed {}, entrance treads {}",
        im.mesh_fills.0, im.mesh_fills.1
    );
    let ground = im.nodes["ground"];
    let (thing, floors) = chiba(&im);
    let place = {
        let t = &im.tree;
        t.node(t.handle(thing).unwrap()).unwrap().place().unwrap()
    };
    let (f0, top) = (floors[&0], floors[floors.keys().max().unwrap()]);
    let map = Map::build(&im.tree, ground, &|_| 0).expect("the map");
    let parts = map.parts(ALL);
    let (pieces, ..) = map.counts();
    // The open ground's largest part is the town.
    let mut size: BTreeMap<u32, usize> = BTreeMap::new();
    for q in 0..pieces as u32 {
        if map.patch_of(q).node == ground {
            *size.entry(parts[q as usize]).or_default() += 1;
        }
    }
    let town = *size.iter().max_by_key(|(_, n)| **n).unwrap().0;
    let mut cut = 0;
    for (level, f) in &floors {
        let mine: Vec<u32> = (0..pieces as u32)
            .filter(|&q| map.patch_of(q).node == *f)
            .collect();
        let reached = mine.iter().filter(|&&q| parts[q as usize] == town).count();
        println!(
            "Chiba floor {level}: {} pieces, {reached} reached from the town",
            mine.len()
        );
        for &q in mine.iter().filter(|&&q| parts[q as usize] != town) {
            let pts = map.standing(q);
            let lo = pts
                .iter()
                .fold([i64::MAX; 2], |m, p| [m[0].min(p[0]), m[1].min(p[2])]);
            let hi = pts
                .iter()
                .fold([i64::MIN; 2], |m, p| [m[0].max(p[0]), m[1].max(p[2])]);
            let area = area_mm2(map.piece(q));
            println!(
                "  not reached: a piece of {} cm² from {lo:?} to {hi:?} (x, z mm, Chiba)",
                area / 100
            );
            if area >= if f == &floors[&0] { NOOK_MM2 } else { SLIP_MM2 } {
                cut += 1;
            }
        }
    }
    assert_eq!(
        cut, 0,
        "every piece of Chiba a body has room on (a slip between solids aside) is reached from the town"
    );
    // The campus's other mesh floors the entrance treads reach (printed, not held): how much of each the town reaches.
    for d in [&b"core-mars-tool-camp@"[..], b"mars-fidelity-freeside@"] {
        let t = &im.tree;
        let mut of = BTreeMap::<Id, (usize, usize)>::new();
        for q in 0..pieces as u32 {
            let node = map.patch_of(q).node;
            let Some(thing) = t
                .handle(node)
                .and_then(|h| t.node(h))
                .and_then(|n| n.parent())
            else {
                continue;
            };
            let is = t.handle(thing).and_then(|h| t.node(h)).is_some_and(
                |n| matches!(n.fields().get(&F_DEF), Some(Value::Bytes(b)) if b.starts_with(d)),
            );
            if is && area_mm2(map.piece(q)) >= SLIP_MM2 {
                let e = of.entry(thing).or_default();
                e.0 += 1;
                e.1 += usize::from(parts[q as usize] == town);
            }
        }
        for (n, (all, reached)) in of.values().enumerate() {
            println!(
                "{} #{n}: {reached} of its {all} pieces with room reached from the town",
                String::from_utf8_lossy(d).trim_end_matches('@')
            );
        }
    }

    // From the open ground 4 m west of the ground storey's west edge (Chiba's frame: x = -1500).
    let w = place
        .orientation
        .rotate(Vec3::new(-5_500_000, 0, 0))
        .unwrap()
        .plus(place.position)
        .unwrap();
    let in_town = |q: u32| parts[q as usize] == town;
    let start = nearest(&map, ground, &in_town, w.x / 1000, w.z / 1000);
    // The two ground areas that were cut off (0.133 #4655): under the bleachers, and the west of the south hall.
    let under = nearest(&map, f0, &in_town, 1_500, 225);
    let south_west = nearest(&map, f0, &in_town, 2_500, -3_500);
    // The upper storey's standing point farthest from the top of the main flight, (1130, 150).
    let far = (0..pieces as u32)
        .filter(|&q| map.patch_of(q).node == top && in_town(q))
        .flat_map(|q| map.standing(q))
        .max_by_key(|p| (p[0] - 1_130).pow(2) + (p[2] - 150).pow(2))
        .expect("the upper storey");
    let (mut t, _) = common::town_of(im, b"souls/chiba-test/2");
    let me = stand(&t, id(1), ground, um(start));
    let mut c = Runner::new(TICK);
    println!(
        "from the open ground at {start:?} (mm, world), {} mm from Chiba's origin",
        dist(um(start), Vec3::new(place.position.x, 0, place.position.z)) / 1000
    );
    let mut on = me;
    for (what, node, goal) in [
        ("under the bleachers", f0, under),
        ("the west of the south hall", f0, south_west),
        ("the upper storey's far end", top, far),
    ] {
        let goal = um(goal);
        let (crossed, at) = go(&mut c, &mut t, on, node, goal);
        on = *c.controller.body(id(1)).unwrap();
        println!(
            "to {what} across [{crossed}]: arrived after {at:?} ms, {} mm from the goal",
            dist(on.pose.position, goal) / 1000,
        );
        assert!(at.is_some(), "the Soul arrives at {what}");
        assert_eq!(node_of(&on), node, "on Chiba's floor for {what}");
    }
}
