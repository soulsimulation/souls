//! #3602 diagnostic (WIP, evidence for the stop): how Eden's office roof terrace is reached today in v2. Needs the
//! exported facts file; `cargo test -p import-eden --release --test office_roof -- --ignored --nocapture`.
//! e_b2780f91 is `eden-office-1-roof-stairs` (core-stair-flight@1), e_948bae23 is `eden-office-1` (core-hall@4).
#![allow(clippy::disallowed_types)]
use import_eden::Import;
use replica::pose::Vec3;
use replica::world_model::show;
use sim::routes::{CLIMB, HANDS, Map, Spot};

fn eden() -> Import {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    import_eden::load(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
#[ignore = "needs the exported Eden facts file"]
fn diag() {
    let im = eden();
    let ground = im.nodes["ground"];
    let mut map = Map::build(&im.tree, ground, &|_| 0).unwrap();
    let (n, ..) = map.counts();
    for key in [
        "e_b2780f91/floor-0",
        "e_b2780f91/floor-1",
        "e_948bae23/floor-2",
        "e_948bae23/floor-3",
        "e_948bae23/meeting",
    ] {
        let Some(&id) = im.nodes.get(key) else {
            println!("{key}: no node");
            continue;
        };
        let qs: Vec<u32> = (0..n as u32)
            .filter(|&q| map.patch_of(q).node == id)
            .collect();
        println!("{key} = {}: {} pieces", show(id), qs.len());
    }
    let parts = map.parts(HANDS | CLIMB);
    let roof = im.nodes["e_948bae23/floor-3"];
    let qs: Vec<u32> = (0..n as u32)
        .filter(|&q| map.patch_of(q).node == roof)
        .collect();
    if let Some(&q) = qs.first() {
        let to = Spot {
            piece: q,
            at: map.standing(q)[0],
        };
        let b = sim::links::Building::read(&im.tree, im.nodes["e_b2780f91"]).unwrap();
        for l in &b.links {
            println!(
                "flight link {} {:?} blocked {:?}",
                show(l.id),
                l.kind,
                l.blocked
            );
        }
        let ob = sim::links::Building::read(&im.tree, im.nodes["e_948bae23"]).unwrap();
        for l in &ob.links {
            println!(
                "office link {} {:?} nodes {} -> {} blocked {:?}",
                show(l.id),
                l.kind,
                show(l.nodes[0]),
                show(l.nodes[1]),
                l.blocked
            );
        }
        let from = (0..n as u32)
            .find(|&q| {
                map.patch_of(q).node == ground
                    && map
                        .patch_of(q)
                        .square
                        .is_some_and(|(i, j)| i == 1 && j == 0)
            })
            .map(|q| Spot {
                piece: q,
                at: map.standing(q)[0],
            })
            .or_else(|| {
                (0..n as u32)
                    .find(|&q| map.patch_of(q).node == ground)
                    .map(|q| Spot {
                        piece: q,
                        at: map.standing(q)[0],
                    })
            })
            .unwrap();
        println!(
            "part ground {} roof {}",
            parts[from.piece as usize], parts[q as usize]
        );
        match map.route(&im.tree, from, to, HANDS | CLIMB) {
            Ok(r) => println!("route {} mm", r.length),
            Err(e) => println!("refused {}: {}", e.name, e.detail),
        }
    }
}
