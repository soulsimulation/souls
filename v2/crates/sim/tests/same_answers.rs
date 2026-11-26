//! The planner's answers are the same after S7 (0.133): the passage index ([`sim::walk::town::Passages`]) and the
//! triangles' boxes the route map skips by give the same spots, distances off a piece, passages, standing places, walks
//! and routes as testing every building's links and every triangle. A fixed set of questions on the test world, every
//! answer written out and hashed; the hash is the one the code before S7 gave (main at e582779a7).
//!
//! `cargo test -p sim --release --test same_answers -- --nocapture` (`SAME_ANSWERS_PRINT=1` prints the hash only).

use replica::encode::to_hex;
use replica::ids::sha256;
use replica::pose::Vec3;
use sim::links::Doors;
use sim::routes::ALL;
use sim::spots::{Target, within};
use sim::walk::town::Town;
use std::fmt::Write;

/// The hash of every answer before S7. Re-pinned by #5034: a route carries the portals it crossed (`Route::crossed`), and
/// the spot tables' walk is measured as a body could walk it (`Map::walked`). Of 1,237 answers, 47 route lines differ
/// only by the new field (none once it is left out) and 12 walks measure 0.5 m to 6.5 m shorter (157.7 m to 151.2 m,
/// the most); no spot, passage or place to stand changed. With that one walk measure taken out the 47 route lines are
/// the whole remaining difference (8156e31a...).
const BEFORE: &str = "fd54ebed7707ebccc38171abe053aca9199f669e6990f3270ae5f601405f88c3";

#[test]
fn s7_the_planner_answers_the_same_questions_the_same_way() {
    let w = testworld::generate(1, 3).expect("the test world");
    let im = import_eden::load(&w.text).expect("the test world loads");
    let (root, ground) = (im.nodes["world"], im.nodes["ground"]);
    let header = import_eden::header(root, &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let mut town = Town::new(im.tree, ground, Doors::new(header, im.rules, next)).unwrap();
    let mut out = String::new();
    let (pieces, ..) = town.map.counts();
    // Points: each piece's standing points (every 7th) and points off them by 0.4 m and 2.5 m, in the piece's frame.
    let mut points = Vec::new();
    for q in 0..pieces as u32 {
        let node = town.map.patch_of(q).node;
        for (k, p) in town
            .map
            .standing(q)
            .into_iter()
            .enumerate()
            .filter(|(k, _)| k % 7 == 0)
        {
            for (dx, dz) in [(0, 0), (400, 0), (0, -400), (2500, 1300), (-2600, -900)] {
                points.push((
                    q,
                    node,
                    Vec3::new((p[0] + dx) * 1000, p[1] * 1000, (p[2] + dz) * 1000),
                    k,
                ));
            }
        }
    }
    assert!(points.len() > 500, "{} points", points.len());
    // The route map's own reads.
    let mut spots = Vec::new();
    for &(q, node, at, _) in &points {
        let s = town.map.spot_for(node, at, ALL);
        let near = town.map.spot_near(node, at, 300);
        let off = town.map.off_piece(q, [at.x / 1000, at.z / 1000]);
        writeln!(out, "spot {node:?} {at:?} {s:?} {near:?} {off}").unwrap();
        if let Some(s) = s {
            spots.push(s);
        }
    }
    // Routes between spots, a fixed sample of pairs.
    for (i, a) in spots.iter().enumerate().step_by(11) {
        let b = spots[(i * 7 + 13) % spots.len()];
        let r = town.map.route(&town.tree.frozen(), *a, b, ALL);
        writeln!(
            out,
            "route {a:?} {b:?} {:?}",
            r.map(|r| format!("{r:?}")).map_err(|e| e.name)
        )
        .unwrap();
    }
    // The ground as the spot tables read it: passages, standing, walks between points, and the place to stand near a point.
    town.with_ground(|_, g| {
        for (i, &(_, node, at, _)) in points.iter().enumerate() {
            writeln!(
                out,
                "passage {node:?} {at:?} {} {:?}",
                g.passage(node, at),
                g.stand(node, at)
            )
            .unwrap();
            if i % 9 == 0 {
                let (_, bn, b, _) = points[(i * 5 + 3) % points.len()];
                writeln!(out, "walk {:?}", g.walk(node, at, bn, b)).unwrap();
                writeln!(
                    out,
                    "within {:?}",
                    within(g, Target::new(node, at), 1_500_000, None)
                )
                .unwrap();
            }
        }
    });
    let hash = to_hex(&sha256(out.as_bytes()));
    if std::env::var_os("SAME_ANSWERS_PRINT").is_some() {
        println!("{hash}");
        return;
    }
    println!("{} answers, hash {hash}", out.lines().count());
    assert_eq!(hash, BEFORE, "the answers changed");
}
