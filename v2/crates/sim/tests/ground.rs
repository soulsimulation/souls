//! The walkable ground (Engine v2 N3, #2651) on N2's test world and on Eden 2026 (N1).
//!
//! `cargo test -p sim --release --test ground -- --nocapture` runs the test world (A1). The Eden checks (A2, A3) need
//! N1's exported facts file (`node v2/tools/import-eden/export/export.ts` from the repository root) and run with
//! `cargo test -p sim --release --test ground -- --ignored --nocapture`.

use import_eden::Import;
use replica::encode::Value;
use replica::ids::Id;
use replica::world_model::plain;
use sim::ground::{BODY_HIGH, HUMAN_RADIUS, OpenGround, SQUARE, Scene, Turn, cut_floor};

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

/// The doorway link the door thing `door` stands in, as the scene of its floor holds it.
fn doorway_of(im: &Import, scene: &Scene, door: &str) -> Id {
    let n = im
        .tree
        .node(im.tree.handle(im.nodes[door]).unwrap())
        .unwrap();
    let v = n
        .fields()
        .get(&import_eden::F_DOORWAY)
        .expect("in a doorway");
    scene
        .doorways
        .iter()
        .find(|d| &d.link.to_value() == v)
        .expect("its doorway is at this floor")
        .link
}

/// The scene with doorway `link` made `width` µm wide: the wall pieces either side of it (boxes lying in the door's
/// wall, within 150 mm of its plane) are run in to meet it, so they stay boxes.
fn narrowed(scene: &Scene, link: Id, width: i64) -> Scene {
    let mut s = scene.clone();
    let k = s.doorways.iter().position(|d| d.link == link).unwrap();
    let d = s.doorways[k].clone();
    let half = d.width / 2;
    let shift = half - width / 2;
    let coords = |p: [i64; 2]| {
        let (dx, dz) = (p[0] - d.at[0], p[1] - d.at[1]);
        (
            (dx * d.along[0] + dz * d.along[1]) / 1_000_000,
            (dx * d.across[0] + dz * d.across[1]) / 1_000_000,
        )
    };
    for b in &mut s.solids {
        if b.ring.iter().any(|p| coords(*p).1.abs() > 150_000) {
            continue;
        }
        for p in &mut b.ring {
            let (along, _) = coords(*p);
            if (along.abs() - half).abs() <= 50 {
                let sign = along.signum();
                p[0] -= sign * shift * d.along[0] / 1_000_000;
                p[1] -= sign * shift * d.along[1] / 1_000_000;
            }
        }
    }
    s.doorways[k].width = width;
    s
}

const YAWS: i64 = 36;
const OFFSETS: i64 = 5; // per axis: 25 offsets inside one 1 mm grid cell

struct Row {
    yaw: i64,
    pass: bool,
    left: i64,
}

/// For each of 36 yaws and 25 offsets: does the doorway pass (met on both sides by one passage), and the width left.
fn door_table(scene: &Scene, link: Id) -> Vec<Row> {
    let mut out = Vec::new();
    for y in 0..YAWS {
        for o in 0..OFFSETS * OFFSETS {
            let t = Turn {
                yaw_mdeg: y * 360_000 / YAWS,
                dx_um: (o % OFFSETS) * 1000 / OFFSETS,
                dz_um: (o / OFFSETS) * 1000 / OFFSETS,
            };
            let p = cut_floor(scene, HUMAN_RADIUS, t).unwrap();
            let m: Vec<_> = p.meets.iter().filter(|m| m.link == link).collect();
            let side = |s: i8| m.iter().any(|m| m.side == s && m.through);
            out.push(Row {
                yaw: t.yaw_mdeg,
                pass: side(-1) && side(1),
                left: m.iter().map(|m| m.width_left).max().unwrap_or(0),
            });
        }
    }
    out
}

/// A1: the test world's 0.9 m door in the turned building passes at each of 36 yaws and 25 offsets; the table, and
/// the narrowest door that always passes.
#[test]
fn a1_a_09_m_door_passes_at_every_yaw_and_offset() {
    let im = testworld();
    let scene = Scene::of(&im.tree, im.nodes["building/floor-1"]).unwrap();
    let link = doorway_of(&im, &scene, "door-building-narrow");
    let d = scene.doorways.iter().find(|d| d.link == link).unwrap();
    assert_eq!(d.width, 900_000);
    let p = cut_floor(&scene, HUMAN_RADIUS, Turn::NONE).unwrap();
    let heights: Vec<i64> = scene.surfaces.iter().map(|f| f.y / 1000).collect();
    check_patch("building/floor-1", &scene, &p, &heights);
    let table = door_table(&scene, link);
    println!(
        "A1 table, the 0.9 m door, radius {HUMAN_RADIUS} mm: yaw mdeg | poses passed of 25 | width left mm"
    );
    for y in 0..YAWS as usize {
        let rows = &table[y * 25..(y + 1) * 25];
        let n = rows.iter().filter(|r| r.pass).count();
        let lo = rows.iter().map(|r| r.left).min().unwrap();
        let hi = rows.iter().map(|r| r.left).max().unwrap();
        println!("  {:>7} | {n:>2} | {lo}..{hi}", rows[0].yaw);
    }
    let passes = table.iter().filter(|r| r.pass).count();
    println!(
        "A1: the 0.9 m door passes {passes} of {} poses",
        table.len()
    );
    assert_eq!(passes, table.len());

    // The narrowest door that always passes: each width at all 900 poses.
    println!("A1 widths: width mm | poses passed of 900 | width left mm min..max");
    let mut narrowest = None;
    for w in [680, 685, 690, 700, 800] {
        let t = door_table(&narrowed(&scene, link, w * 1000), link);
        let n = t.iter().filter(|r| r.pass).count();
        let lo = t.iter().map(|r| r.left).min().unwrap();
        let hi = t.iter().map(|r| r.left).max().unwrap();
        println!("  {w} | {n} | {lo}..{hi}");
        if n == t.len() && narrowest.is_none() {
            narrowest = Some(w);
        }
    }
    println!("A1: the narrowest door that always passes: {narrowest:?} mm");
    assert!(narrowest.is_some());
}

#[test]
#[ignore = "needs the exported Eden facts file"]
fn step0_one_eden_building() {
    let im = eden();
    let floor = im.nodes["e_a4029ff4/floor-0"];
    let scene = Scene::of(&im.tree, floor).unwrap();
    let p = cut_floor(&scene, HUMAN_RADIUS, Turn::NONE).unwrap();
    println!(
        "step 0: {} surfaces, {} solids, {} doorways -> {} pieces, {} triangles, {} meets",
        scene.surfaces.len(),
        scene.solids.len(),
        scene.doorways.len(),
        p.pieces.len(),
        p.pieces.iter().map(|x| x.triangles.len()).sum::<usize>(),
        p.meets.len()
    );
    for m in &p.meets {
        println!("  meet {m:?}");
    }
    assert!(!p.pieces.is_empty());
}

fn inside_triangle(v: &[[i32; 3]], t: &[u32; 3], p: [i64; 2]) -> bool {
    let c = |a: [i32; 3], b: [i32; 3]| {
        (i64::from(b[0] - a[0])) * (p[1] - i64::from(a[2]))
            - (i64::from(b[2] - a[2])) * (p[0] - i64::from(a[0]))
    };
    let (a, b, d) = (v[t[0] as usize], v[t[1] as usize], v[t[2] as usize]);
    let (x, y, z) = (c(a, b), c(b, d), c(d, a));
    (x > 0 && y > 0 && z > 0) || (x < 0 && y < 0 && z < 0)
}

/// A4 and A5 on one patch: no doorway's middle in the body's way is floor; every vertex carries one of the scene's heights.
fn check_patch(name: &str, scene: &Scene, p: &sim::ground::Patch, heights: &[i64]) {
    // A doorway in the body's way: its floor within a body's height of the patch's.
    for d in scene
        .doorways
        .iter()
        .filter(|d| heights.iter().any(|h| (d.y / 1000 - h).abs() < BODY_HIGH))
    {
        let at = [d.at[0] / 1000, d.at[1] / 1000];
        for pc in &p.pieces {
            for t in &pc.triangles {
                assert!(
                    !inside_triangle(&pc.vertices, t, at),
                    "{name}: a doorway is floor: {:?} at {at:?}, y {}",
                    d.link,
                    d.y
                );
            }
        }
    }
    for pc in &p.pieces {
        for v in pc.vertices.iter().chain(pc.outline.iter().flatten()) {
            assert!(
                heights.contains(&i64::from(v[1])),
                "{name}: a vertex at {v:?} has no surface's height"
            );
        }
    }
}

fn label(im: &Import, key: &str) -> String {
    let thing = key.split('/').next().unwrap_or(key);
    let n = im
        .tree
        .node(im.tree.handle(im.nodes[thing]).unwrap())
        .unwrap();
    let words = match n.fields().get(&import_eden::F_NAME) {
        Some(Value::Bytes(h)) => {
            let h: [u8; 32] = h.as_slice().try_into().unwrap();
            im.texts.get(&h).cloned().unwrap_or_default()
        }
        _ => String::new(),
    };
    let def = match n.fields().get(&import_eden::F_DEF) {
        Some(Value::Bytes(d)) => String::from_utf8_lossy(d).into_owned(),
        _ => String::new(),
    };
    format!("{key} ({def} \"{words}\")")
}

/// A2, A3 (and A4, A5 on every patch): every floor node of Eden and every square of its open ground, two repeats.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a2_a3_every_eden_node_cuts_in_under_5_ms() {
    let im = eden();
    let floors: Vec<(&String, Id)> = im
        .nodes
        .iter()
        .filter(|(_, id)| {
            let n = im.tree.node(im.tree.handle(**id).unwrap()).unwrap();
            plain(n.kind().as_str()) == "eden:floor"
        })
        .map(|(k, id)| (k, *id))
        .collect();
    let mut listed: Vec<String> = Vec::new();
    let mut empty: Vec<String> = Vec::new();
    let (mut pieces, mut triangles, mut meets, mut doorways) = (0, 0, 0, 0);
    let mut unmet: Vec<String> = Vec::new();
    let mut worst = [(0u128, String::new()), (0u128, String::new())];
    let mut total = [0u128; 2];
    let mut over = [0usize; 2];
    for repeat in 0..2 {
        for (key, id) in &floors {
            let t = std::time::Instant::now();
            let cut = Scene::of(&im.tree, *id)
                .and_then(|s| cut_floor(&s, HUMAN_RADIUS, Turn::NONE).map(|p| (s, p)));
            let us = t.elapsed().as_micros();
            total[repeat] += us;
            if us >= 5_000 {
                over[repeat] += 1;
            }
            if us > worst[repeat].0 {
                worst[repeat] = (us, label(&im, key));
            }
            if repeat == 1 {
                continue;
            }
            match cut {
                Err(e) => listed.push(format!("{}: {e}", label(&im, key))),
                Ok((s, p)) => {
                    let heights: Vec<i64> = s
                        .surfaces
                        .iter()
                        .map(|f| (f.y + 500).div_euclid(1000))
                        .collect();
                    check_patch(key, &s, &p, &heights);
                    if p.pieces.is_empty() {
                        empty.push(label(&im, key));
                    }
                    pieces += p.pieces.len();
                    triangles += p.pieces.iter().map(|x| x.triangles.len()).sum::<usize>();
                    meets += p.meets.len();
                    doorways += s.doorways.len();
                    for d in &s.doorways {
                        if !p.meets.iter().any(|m| m.link == d.link && m.width_left > 0) {
                            unmet.push(format!(
                                "{} doorway {} ({} mm wide)",
                                label(&im, key),
                                replica::world_model::show(d.link),
                                d.width / 1000
                            ));
                        }
                    }
                }
            }
        }
    }
    println!("A2/A3 Eden floors: {} floor nodes", floors.len());
    for r in 0..2 {
        println!(
            "  repeat {}: slowest {} us, {}; {} at or over 5 ms; all floors {} ms",
            r + 1,
            worst[r].0,
            worst[r].1,
            over[r],
            total[r] / 1000
        );
    }
    println!(
        "  cut: {} nodes; {pieces} pieces, {triangles} triangles, {meets} meets; {doorways} doorways at floors, {} met by no piece with width left",
        floors.len() - listed.len(),
        unmet.len()
    );
    for u in &unmet {
        println!("    {u}");
    }
    println!("  listed, not cut ({}):", listed.len());
    for l in &listed {
        println!("    {l}");
    }
    println!(
        "  cut to nothing, no standing room for {HUMAN_RADIUS} mm ({}):",
        empty.len()
    );
    for l in &empty {
        println!("    {l}");
    }

    // The open ground, square by square.
    let ground = im.nodes["ground"];
    let t = std::time::Instant::now();
    let scene = Scene::of(&im.tree, ground).unwrap();
    let read = t.elapsed().as_micros();
    let t = std::time::Instant::now();
    let open = OpenGround::prepare(&scene, HUMAN_RADIUS).unwrap();
    let grow = t.elapsed().as_micros();
    let squares = open.squares();
    println!(
        "A2/A3 Eden open ground: {} solids, {} footprints, {} doorways, {} waters; read {} ms, grown {} ms; {} squares of {} m",
        scene.solids.len(),
        scene.footprints.len(),
        scene.doorways.len(),
        scene.waters.len(),
        read / 1000,
        grow / 1000,
        squares.len(),
        SQUARE / 1000
    );
    let (mut gp, mut gt, mut gm) = (0, 0, 0);
    for repeat in 0..2 {
        let mut worst = (0u128, (0, 0));
        let (mut all, mut over) = (0u128, 0);
        for &(i, j) in &squares {
            let t = std::time::Instant::now();
            let p = open.cut_square(i, j);
            let us = t.elapsed().as_micros();
            all += us;
            if us >= 5_000 {
                over += 1;
            }
            if us > worst.0 {
                worst = (us, (i, j));
            }
            if repeat == 0 {
                check_patch("ground", &scene, &p, &[0]);
                gp += p.pieces.len();
                gt += p.pieces.iter().map(|x| x.triangles.len()).sum::<usize>();
                gm += p.meets.len();
            }
        }
        println!(
            "  repeat {}: slowest square {} us, the square from ({}, {}) m; {over} at or over 5 ms; all squares {} ms",
            repeat + 1,
            worst.0,
            i64::from(worst.1.0) * SQUARE / 1000,
            i64::from(worst.1.1) * SQUARE / 1000,
            all / 1000
        );
    }
    println!("  cut: {gp} pieces, {gt} triangles, {gm} meets");
}

/// The field numbers and kind names the ground reads are N1's.
#[test]
fn fields_are_the_importers() {
    use sim::ground::scene as g;
    assert_eq!(g::F_OPEN_DOOR_LINK, import_eden::F_DOORWAY);
    assert_eq!(g::F_OUTLINE, import_eden::F_OUTLINE);
    assert_eq!(g::F_SOLIDS, import_eden::F_SOLIDS);
    assert_eq!(g::F_SURFACES, import_eden::F_SURFACES);
    assert_eq!(g::F_LINE, import_eden::F_LINE);
    assert_eq!(g::F_LINE_WIDTH, import_eden::F_LINE_WIDTH);
    assert_eq!(g::F_WATER_LEVEL, import_eden::F_WATER_LEVEL);
    assert_eq!(g::F_PLACE_OF, import_eden::F_PLACE_OF);
    assert_eq!(g::F_DOORWAYS, import_eden::F_DOORWAYS);
    assert_eq!(g::GROUND, import_eden::GROUND);
    assert_eq!(g::FLOOR, import_eden::FLOOR);
    assert_eq!(g::ROOM, import_eden::ROOM);
    assert_eq!(g::WINDOW, import_eden::WINDOW);
    assert_eq!(g::PLACE, import_eden::PLACE);
    assert_eq!(g::DOORWAY, import_eden::DOORWAY);
}
