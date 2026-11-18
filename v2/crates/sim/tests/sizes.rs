//! Body sizes and floaters (Engine v2 B12, #2743).
//!
//! `cargo test -p sim --release --test sizes -- --nocapture` runs the test world (A2, A3). The Eden checks (A1, A4)
//! need N1's exported facts file (`node v2/tools/import-eden/export/export.ts` from the repository root) and run with
//! `cargo test -p sim --release --test sizes -- --ignored --nocapture`.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

use import_eden::Import;
use replica::ids::Id;
use replica::kinds::Kinds;
use replica::kinds::sizes::{Build, Size};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::world_model::{plain, show};
use sim::ground::sizes::change_size;
use sim::ground::{OpenGround, Patch, Scene, Turn, cut_floor};
use sim::links::{Building, Kind};
use sim::routes::{ALL, Hop, Map, Spot};
use std::collections::BTreeMap;

fn eden() -> Import {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    import_eden::load(&text).expect("Eden loads")
}

fn testworld() -> Import {
    let w = testworld::generate(1, 0).expect("the test world");
    import_eden::load(&w.text).expect("the test world loads")
}

/// A family kind of the given size class, height and hover height (mm), loaded as kind data and read.
fn family(name: &str, size: &str, height: u64, hover: u64) -> Build {
    let text = format!(
        r#"{{1: "test:{name}", 2: "family", 3: {{
            1: {{1: "size", 2: "enum", 3: "{size}", 4: "public", 5: ["small", "standard", "large"]}},
            2: {{1: "height", 2: "int", 3: {height}, 4: "public"}},
            3: {{1: "hover", 2: "int", 3: {hover}, 4: "public"}}}}}}"#
    );
    let mut kinds = Kinds::default();
    let loaded = kinds.load(&[("family.diag", &text)]);
    assert_eq!(loaded.len(), 1, "{:?}", kinds.refused());
    Build::of(kinds.get(loaded[0].as_str()).unwrap()).expect("a family's build")
}

/// A standing point (mm, the piece's frame) of a piece of `node` on `map`, the one whose world point is nearest
/// `near` (x, z in mm).
fn piece_near(map: &Map, node: Id, near: [i64; 2]) -> Spot {
    let (n, ..) = map.counts();
    (0..n as u32)
        .filter(|&q| map.patch_of(q).node == node)
        .flat_map(|q| map.standing(q).into_iter().map(move |p| (q, p)))
        .min_by_key(|&(q, p)| {
            let w = map.world(q, p);
            (w[0] - near[0]).pow(2) + (w[2] - near[1]).pow(2)
        })
        .map(|(piece, at)| Spot { piece, at })
        .expect("a piece of that node")
}

fn um(p: [i64; 3]) -> Vec3 {
    Vec3::new(p[0] * 1000, p[1] * 1000, p[2] * 1000)
}

/// A patch's bytes as held: its pieces' points and triangles, outlines and meets.
fn bytes(p: &Patch) -> usize {
    let pieces: usize = p
        .pieces
        .iter()
        .map(|pc| {
            12 * pc.vertices.len()
                + 12 * pc.triangles.len()
                + pc.outline.iter().map(|r| 12 * r.len() + 24).sum::<usize>()
                + 3 * 24
        })
        .sum();
    pieces + p.meets.len() * std::mem::size_of::<sim::ground::Meet>() + 64
}

/// A2: a large body whose only way from the stair's landing to the rooms beyond the corridor upstairs is the 0.9 m
/// door into the corridor is refused there, by name, with the door and both widths. A standard body goes that way.
#[test]
fn a2_a_body_wider_than_the_only_door_is_refused_naming_it_and_both_widths() {
    let im = testworld();
    let (ground, floor) = (im.nodes["ground"], im.nodes["building/floor-1"]);
    let b = Building::read(&im.tree, im.nodes["building"]).unwrap();
    let stair = b.links.iter().find(|l| l.kind == Kind::Stairs).unwrap();
    let top = stair.ends[1].unwrap().middle();
    let narrow = b
        .links
        .iter()
        .find(|l| l.kind == Kind::Doorway && l.width == 900_000)
        .expect("the 0.9 m door into the corridor");
    // The room beyond the corridor, at its east end.
    let far = [-55_331, 53];
    for (build, ok) in [
        (family("walker", "standard", 1_750, 0), true),
        (family("large", "large", 2_400, 0), false),
    ] {
        let mut map = Map::build_for(&im.tree, ground, build.size, &|_| 0).unwrap();
        assert_eq!(map.size, build.size);
        let land = map.spot_near(floor, top, 600).expect("the landing");
        let goal = piece_near(&map, floor, far);
        let r = map.route(&im.tree, land, goal, ALL);
        match r {
            Ok(r) => {
                println!(
                    "A2 {}: landing to the far room, {} hops, {} mm",
                    build.size.name(),
                    r.hops.len(),
                    r.length
                );
                assert!(ok);
                assert_eq!(r.size, build.size);
                assert!(r.hops.contains(&Hop::Link {
                    id: narrow.id,
                    kind: Kind::Doorway
                }));
            }
            Err(no) => {
                println!(
                    "A2 {}: landing to the far room: {}: {}",
                    build.size.name(),
                    no.name,
                    no.detail
                );
                assert!(!ok);
                assert_eq!(no.name, "no-route");
                assert_eq!(
                    no.detail,
                    format!(
                        "link {}: link-too-narrow: the doorway (door {}) is 900 mm wide; a large body is 1000 mm wide, 1120 mm with its clearance",
                        show(narrow.id),
                        show(narrow.door.unwrap())
                    )
                );
            }
        }
    }
}

/// A3: a change to the large class is refused, the old body kept, where the body would not fit (in the 0.9 m
/// corridor) and where it would have no way out (on the roof, whose ladder lands on no ground for it, and in the room
/// beyond the corridor, whose one door opens onto the corridor). The same
/// body may become small in both places, and large on the open square.
#[test]
fn a3_a_change_to_a_larger_size_that_does_not_fit_or_has_no_exit_is_refused() {
    let im = testworld();
    let (ground, floor1, roof) = (
        im.nodes["ground"],
        im.nodes["building/floor-1"],
        im.nodes["building/floor-2"],
    );
    let map = Map::build(&im.tree, ground, &|_| 0).unwrap();
    let who = replica::pose::fixture(1);
    // A radius takes the class at or above it; one over the largest is refused.
    assert_eq!(Size::for_radius(250).unwrap(), Size::Standard);
    assert_eq!(Size::for_radius(500).unwrap(), Size::Large);
    assert_eq!(Size::for_radius(501).unwrap_err().name, "body-too-large");
    let corridor = piece_near(&map, floor1, [-59_841, -146]).at;
    let on_roof = piece_near(&map, roof, [-60_000, 0]).at;
    let beyond = piece_near(&map, floor1, [-55_331, 53]).at;
    for (place, node, at, name) in [
        ("the corridor", floor1, corridor, "size-would-not-fit"),
        ("the roof", roof, on_roof, "size-no-way-out"),
        (
            "the room beyond the corridor",
            floor1,
            beyond,
            "size-no-way-out",
        ),
    ] {
        let mut body = family("walker", "standard", 1_750, 0);
        let before = body;
        let no =
            change_size(&im.tree, ground, node, who, um(at), &mut body, Size::Large).unwrap_err();
        println!("A3 standard to large, {place}: {}: {}", no.name, no.detail);
        assert_eq!(no.name, name);
        assert_eq!(body, before, "the old body is kept");
        let mut small = before;
        change_size(&im.tree, ground, node, who, um(at), &mut small, Size::Small)
            .expect("smaller fits");
        assert_eq!(small.size, Size::Small);
    }
    let mut body = family("walker", "standard", 1_750, 0);
    change_size(
        &im.tree,
        ground,
        ground,
        who,
        Vec3::ZERO,
        &mut body,
        Size::Large,
    )
    .expect("the open square");
    println!("A3 standard to large, the open square: made");
    assert_eq!(body.size, Size::Large);
}

/// A1: a small, a standard, a large and a hovering body each cross Eden by route, west to east between the same two
/// points: each on a map cut for its class, the route carrying the class, and the floater's pose held above the
/// surface below it at its hover height at every point it passes.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a1_four_bodies_cross_eden_by_route() {
    let im = eden();
    let ground = im.nodes["ground"];
    // The two ends: the westmost and eastmost standing points of the open ground in the largest part of the large
    // class's map (the most constrained), so every class has ground there.
    let large = Map::build_for(&im.tree, ground, Size::Large, &|_| 0).unwrap();
    let parts = large.parts(ALL);
    let (n, ..) = large.counts();
    let mut size: BTreeMap<u32, usize> = BTreeMap::new();
    for &p in &parts {
        *size.entry(p).or_default() += 1;
    }
    let main = *size
        .iter()
        .max_by_key(|(k, c)| (**c, std::cmp::Reverse(**k)))
        .unwrap()
        .0;
    let pts: Vec<[i64; 3]> = (0..n as u32)
        .filter(|&q| parts[q as usize] == main && large.patch_of(q).node == ground)
        .flat_map(|q| large.standing(q).into_iter().map(move |p| (q, p)))
        .map(|(q, p)| large.world(q, p))
        .collect();
    let west = *pts.iter().min_by_key(|p| p[0]).unwrap();
    let east = *pts.iter().max_by_key(|p| p[0]).unwrap();
    println!(
        "A1 from ({}, {}) m to ({}, {}) m, {} m apart west to east",
        west[0] / 1000,
        west[2] / 1000,
        east[0] / 1000,
        east[2] / 1000,
        (east[0] - west[0]) / 1000
    );
    println!(
        "A1 | body | class | radius mm | hover mm | map built ms | route us | length m | hops | links crossed | portals searched"
    );
    for (name, build) in [
        ("small", family("small", "small", 1_000, 0)),
        ("standard", family("walker", "standard", 1_750, 0)),
        ("large", family("large", "large", 2_400, 0)),
        ("hovering", family("floater", "standard", 1_200, 400)),
    ] {
        let t = std::time::Instant::now();
        let mut map = Map::build_for(&im.tree, ground, build.size, &|_| 0).unwrap();
        let built = t.elapsed().as_millis();
        let from = map.spot_near(ground, um(west), 50).expect("the west end");
        let to = map.spot_near(ground, um(east), 50).expect("the east end");
        let t = std::time::Instant::now();
        let r = map
            .route(&im.tree, from, to, ALL)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let took = t.elapsed().as_micros();
        assert_eq!(r.size, build.size);
        assert!(r.length as i64 >= east[0] - west[0]);
        let crossed = r
            .hops
            .iter()
            .filter(|h| matches!(h, Hop::Link { .. }))
            .count();
        println!(
            "A1 | {name} | {} | {} | {} | {built} | {took} | {} | {} | {crossed} | {}",
            build.size.name(),
            build.size.radius_mm(),
            build.hover_mm,
            r.length / 1000,
            r.hops.len(),
            r.searched
        );
        // Its pose at each point it passes: supported by the open ground below, held at its hover height.
        for w in r.waypoints.iter().chain([&east]) {
            let pose = Pose {
                frame: Frame {
                    node: ground,
                    slot: None,
                },
                position: Vec3::new(w[0] * 1000, (w[1] + build.hover_mm) * 1000, w[2] * 1000),
                orientation: Quat::IDENTITY,
                support: build.support(ground),
            };
            pose.check().expect("a legal pose");
            assert_eq!(
                pose.support,
                Support::Surface {
                    surface: ground,
                    height: build.hover_mm * 1000
                }
            );
        }
    }
}

/// A4: every floor node of Eden and every square of its open ground cut for each size class, two repeats: time and
/// memory against the budget stated first. Each node at or over 5 ms is listed.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a4_eden_cut_per_size_class() {
    let im = eden();
    let floors: Vec<_> = im
        .nodes
        .values()
        .copied()
        .filter(|id| {
            let n = im.tree.node(im.tree.handle(*id).unwrap()).unwrap();
            plain(n.kind().as_str()) == "eden:floor"
        })
        .collect();
    let ground = im.nodes["ground"];
    let scene = Scene::of(&im.tree, ground).unwrap();
    println!(
        "A4 | class | radius mm | repeat | all floors ms | all squares ms | total ms | slowest node us | at or over 5 ms | MB"
    );
    for size in Size::ALL {
        let radius = size.radius_mm();
        for repeat in 1..=2 {
            let (mut floor_us, mut sq_us, mut slowest, mut over, mut mem) =
                (0u128, 0u128, 0u128, 0, 0usize);
            for id in &floors {
                let t = std::time::Instant::now();
                let cut = Scene::of(&im.tree, *id).and_then(|s| cut_floor(&s, radius, Turn::NONE));
                let us = t.elapsed().as_micros();
                floor_us += us;
                slowest = slowest.max(us);
                if us >= 5_000 {
                    over += 1;
                    println!("    floor {} {us} us", show(*id));
                }
                if let Ok(p) = cut {
                    mem += bytes(&p);
                }
            }
            let t = std::time::Instant::now();
            let open = OpenGround::prepare(&scene, radius).unwrap();
            sq_us += t.elapsed().as_micros();
            for (i, j) in open.squares() {
                let t = std::time::Instant::now();
                let p = open.cut_square(i, j);
                let us = t.elapsed().as_micros();
                sq_us += us;
                slowest = slowest.max(us);
                if us >= 5_000 {
                    over += 1;
                    println!("    square ({i}, {j}) {us} us");
                }
                mem += bytes(&p);
            }
            println!(
                "A4 | {} | {radius} | {repeat} | {} | {} | {} | {slowest} | {over} | {:.1}",
                size.name(),
                floor_us / 1000,
                sq_us / 1000,
                (floor_us + sq_us) / 1000,
                mem as f64 / 1e6
            );
        }
    }
}
