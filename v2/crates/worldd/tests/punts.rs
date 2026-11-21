//! #3603: today's rowing punts on Eden. Every standing water of Eden's facts, its depth under its level at a few points
//! and the mooring the punt/1 search finds on it, printed. Needs the generated Eden 2026 facts file (`EDEN_FACTS`):
//! `cargo test -p worldd --test punts -- --ignored --nocapture` from `v2/`.

use sim::courses::punts::moorings_of;
use sim::ground::{Scene, Terrain};

#[test]
#[ignore = "needs the generated Eden 2026 facts file"]
fn eden_waters_and_their_punts() {
    let facts = std::env::var("EDEN_FACTS").expect("EDEN_FACTS");
    let im = import_eden::load(&std::fs::read_to_string(facts).unwrap()).expect("Eden loads");
    let ground = im.nodes["ground"];
    let tree = &im.tree;
    let terrain = Terrain::of(tree, ground).unwrap();
    let gh = tree.handle(ground).unwrap();
    for &c in tree.children(gh).unwrap() {
        let n = tree.node(c).unwrap();
        if !matches!(n.fields().get(&sim::ground::scene::F_PLACE_OF), Some(replica::encode::Value::Text(t)) if t.as_str() == "eden:water")
        {
            continue;
        }
        let s = Scene::of_child(tree, gh, c, terrain.as_ref()).unwrap();
        for w in &s.waters {
            let (mut x, mut z) = (0i128, 0i128);
            for p in &w.ring {
                x += i128::from(p[0]);
                z += i128::from(p[1]);
            }
            let k = w.ring.len().max(1) as i128;
            let c = [(x / k) as i64, (z / k) as i64];
            let bed = terrain.as_ref().and_then(|t| t.height_at(c[0], c[1]));
            println!(
                "water {}: {} points, level {} mm, bed at its centroid ({:.1}, {:.1}) m: {:?} mm",
                replica::world_model::show(w.place),
                w.ring.len(),
                w.level / 1000,
                c[0] as f64 / 1e6,
                c[1] as f64 / 1e6,
                bed.map(|b| b / 1000)
            );
        }
    }
    let found = moorings_of(tree, ground).unwrap();
    for m in &found {
        println!(
            "punt on {}: home ({:.1}, {:.1}) m, plank ({:.1}, {:.1}) m",
            replica::world_model::show(m.water),
            m.home.x as f64 / 1e6,
            m.home.z as f64 / 1e6,
            m.door.x as f64 / 1e6,
            m.door.z as f64 / 1e6
        );
    }
    assert!(!found.is_empty(), "Eden has a punt, as today");
}
