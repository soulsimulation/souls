//! Chiba on the Mars campus (`mars-fidelity-chiba@1`, 0.133): its upper storey is a deck of floor pieces 150 mm
//! apart, joined by short flights within the storey. Every piece of the upper storey (but a slip between solids) is
//! joined to the foot of the main flight, and a Soul there climbs to the upper storey and walks across it to its far
//! end. It prints, and does not hold, how much of Chiba the town reaches: none, as its ground storey stands 374 mm up
//! with no doorway or flight from the ground, more than a step. Needs the Mars
//! campus's exported facts (from the repository root):
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

/// Chiba's floors by level.
fn chiba(im: &Import) -> BTreeMap<i64, Id> {
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
    floors
}

/// A piece smaller than this, mm², is a slip between solids, no room to stand in (a quarter square metre).
const SLIP_MM2: i64 = 250_000;

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

#[test]
#[ignore = "needs the Mars campus's exported facts file"]
fn a_soul_climbs_chiba_and_walks_its_upper_storey_end_to_end() {
    let im = mars();
    let ground = im.nodes["ground"];
    let floors = chiba(&im);
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
    let town_part = *size.iter().max_by_key(|(_, n)| **n).unwrap().0;
    // The ground storey's point nearest the foot of the main flight (Chiba's frame, mm).
    let (foot_piece, foot) = (0..pieces as u32)
        .filter(|&q| map.patch_of(q).node == f0)
        .flat_map(|q| map.standing(q).into_iter().map(move |p| (q, p)))
        .min_by_key(|(_, p)| (p[0] - 9_900).abs() + (p[2] - 225).abs())
        .expect("Chiba's ground storey");
    let home = parts[foot_piece as usize];
    let (mut cut, mut off_town) = (0, 0);
    for (level, f) in &floors {
        let mine: Vec<u32> = (0..pieces as u32)
            .filter(|&q| map.patch_of(q).node == *f)
            .collect();
        let joined = mine.iter().filter(|&&q| parts[q as usize] == home).count();
        let town = mine
            .iter()
            .filter(|&&q| parts[q as usize] == town_part)
            .count();
        println!(
            "Chiba floor {level}: {} pieces, {joined} joined to the foot of the main flight, {town} reached from the town",
            mine.len()
        );
        for &q in mine.iter().filter(|&&q| parts[q as usize] != home) {
            let pts = map.standing(q);
            let lo = pts
                .iter()
                .fold([i64::MAX; 2], |m, p| [m[0].min(p[0]), m[1].min(p[2])]);
            let hi = pts
                .iter()
                .fold([i64::MIN; 2], |m, p| [m[0].max(p[0]), m[1].max(p[2])]);
            let area = area_mm2(map.piece(q));
            println!(
                "  not joined: a piece of {} cm² from {lo:?} to {hi:?} (x, z mm, Chiba)",
                area / 100
            );
            // The upper storey: every piece a body has room on (a slip between solids aside) is joined.
            if f == &top && area >= SLIP_MM2 {
                cut += 1;
            }
        }
        off_town += mine.len() - town;
    }
    println!("Chiba pieces the town does not reach: {off_town}");
    assert_eq!(
        cut, 0,
        "every piece of Chiba's upper storey is joined to the foot of its main flight"
    );

    // The walk: from the foot of the main flight to the far end of the upper storey (Chiba's frame, µm).
    let start = Vec3::new(foot[0] * 1000, foot[1] * 1000, foot[2] * 1000);
    // The upper storey's standing point farthest from the top of the main flight, (1130, 150).
    let far = (0..pieces as u32)
        .filter(|&q| map.patch_of(q).node == top && parts[q as usize] == home)
        .flat_map(|q| map.standing(q))
        .max_by_key(|p| (p[0] - 1_130).pow(2) + (p[2] - 150).pow(2))
        .expect("the upper storey");
    let goal = Vec3::new(far[0] * 1000, far[1] * 1000, far[2] * 1000);
    let (mut t, _) = common::town_of(im, b"souls/chiba-test/1");
    let me = stand(&t, id(1), f0, start);
    let mut c = Runner::new(TICK);
    let legs = walk(&mut c, &mut t, me, SPEED, top, goal)
        .unwrap_or_else(|e| panic!("no way up Chiba: {}: {}", e.name, e.detail));
    let crossed: Vec<String> = legs
        .iter()
        .filter_map(|l| l.link)
        .map(|k| format!("{:?}", kind_of(&t, k)))
        .collect();
    println!("from {start:?} (µm, Chiba) across {}", crossed.join(", "));
    for _ in 0..6_000 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(&mut t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
    }
    let at = arrived(&c, id(1));
    let body = *c.controller.body(id(1)).unwrap();
    println!(
        "arrived at {:?} ms, on the upper storey: {}, {} mm from the goal",
        at.map(|a| a / 1000),
        node_of(&body) == top,
        dist(body.pose.position, goal) / 1000,
    );
    assert!(at.is_some(), "the Soul arrives");
    assert_eq!(node_of(&body), top, "on Chiba's upper storey");
}
