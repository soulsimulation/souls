//! Gaits and slopes (Engine v2 N11a, #2735).
//!
//! `cargo test -p sim --release --test gaits -- --nocapture` runs the slope cases, each a 16 m square of terrain
//! written as data, and prints the speed table (A1, two repeats). The speed table on Eden's own hills needs N1's
//! exported facts file (`node v2/tools/import-eden/export/export.ts` from the repository root) and runs with
//! `cargo test -p sim --release --test gaits -- --ignored --nocapture`. The water cases are `tests/water.rs` (N11b, #3198).

use import_eden::Import;
use replica::pose::{ControllerInput, Frame, Mode, Quat, Vec3, fixture};
use sim::gaits::{Gait, JOG, RUN, WALK};
use sim::ground::{HUMAN_RADIUS, OpenGround, SQUARE, STEEP};
use sim::mover::{Body, Surface};

const TICK: i64 = 50_000;
/// The gaits on dry ground (wading and swimming are `tests/water.rs`, N11b).
const DRY: [Gait; 3] = [WALK, JOG, RUN];

/// 0.135 G1: the gaits a walk intent may name (`replica::move_check::GAITS`) are these, each a gait on dry ground.
#[test]
fn g1_a_walk_names_the_gaits_on_dry_ground() {
    let named: Vec<Gait> = replica::move_check::GAITS
        .into_iter()
        .map(|n| Gait::named(n).expect("a gait"))
        .collect();
    assert_eq!(named, DRY);
    assert!(DRY.iter().all(|g| g.allowed(sim::gaits::Ground::Dry)));
}

/// Standard base64, for the terrain written in a test.
fn b64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for k in 0..4 {
            if k <= c.len() {
                s.push(A[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// A world of one 16 m terrain tile at (0, 0), its 17 × 17 heights (mm) from `h(i, j)`, i along x and j along z.
fn world(h: impl Fn(i32, i32) -> i32) -> Import {
    world_with(h, "", "")
}

/// [`world`], with N1's facts rows `kinds` and `things` on it.
fn world_with(h: impl Fn(i32, i32) -> i32, kinds: &str, things: &str) -> Import {
    let n = (SQUARE / 1000) as i32;
    let mut heights = Vec::new();
    for j in 0..=n {
        for i in 0..=n {
            heights.extend_from_slice(&h(i, j).to_le_bytes());
        }
    }
    let classes = vec![0u8; (n * n) as usize];
    let text = format!(
        r#"{{"format": "souls/import-eden/1", "kinds": [{kinds}], "things": [{things}], "doors": [], "places": [],
          "bake": {{}}, "byRef": {{}}, "ground": {{"tileM": {n}, "tiles": [{{"tx": 0, "tz": 0,
          "heights": "{}", "classes": "{}"}}]}}}}"#,
        b64(&heights),
        b64(&classes)
    );
    import_eden::load(&text).expect("the slope world loads")
}

/// The one square's surface, on its terrain.
fn surface(im: &Import) -> Surface {
    let ground = im.nodes["ground"];
    let open = OpenGround::of(&im.tree, ground, HUMAN_RADIUS).expect("the open ground");
    let t = open.terrain().expect("the terrain").clone();
    let pieces = open.cut_square(0, 0).pieces;
    let on = open.on_terrain(&pieces);
    Surface::new(ground, pieces).on_terrain(t, on)
}

fn place(s: &Surface, at: [i64; 2]) -> Option<Body> {
    let frame = Frame {
        node: s.node,
        slot: None,
    };
    s.place(
        fixture(3),
        frame,
        Vec3::new(at[0], 0, at[1]),
        Quat::IDENTITY,
    )
    .ok()
}

/// What a walk came to: the distance along the surface (µm), the time (µs), where it ended.
struct Walked {
    along: f64,
    time: i64,
    end: Vec3,
}

/// Walks `b` at `gait` toward `dir` (a whole-number direction) for `ticks` ticks.
fn walk(s: &Surface, b: &mut Body, gait: Gait, dir: [i64; 2], ticks: i64) -> Walked {
    let d = [dir[0] * 1_000_000, dir[1] * 1_000_000];
    let l = (d[0] * d[0] + d[1] * d[1]).isqrt();
    let v = Vec3::new(d[0] * gait.speed / l, 0, d[1] * gait.speed / l);
    let mut along = 0f64;
    for k in 0..ticks {
        let p = b.pose.position;
        s.step(
            b,
            ControllerInput {
                velocity: v,
                mode: Mode::Surface,
            },
            TICK,
            (k + 1) * TICK,
        )
        .expect("a step");
        let q = b.pose.position;
        let d = |a: i64, c: i64| (c - a) as f64;
        along += (d(p.x, q.x).powi(2) + d(p.y, q.y).powi(2) + d(p.z, q.z).powi(2)).sqrt();
    }
    Walked {
        along,
        time: ticks * TICK,
        end: b.pose.position,
    }
}

/// What a case expects.
#[derive(Clone, Copy, Debug)]
enum Expect {
    /// The gait's speed along the surface, within 2 %.
    Speed,
    /// No piece where the body would stand: the cell is too steep.
    NoGround,
    /// The body stops at the foot of the steep ground: x no further than this (µm), at the height it started.
    StopsBefore(i64),
}

/// One slope case, as data: a square of terrain, rising `rise_x` and `rise_z` mm a metre (from `from` m along x
/// onwards, flat before it), a body at `at` (µm) walking toward `dir` at `gait`.
#[derive(Clone, Copy, Debug)]
struct Case {
    name: &'static str,
    rise_x: i32,
    rise_z: i32,
    from: i32,
    gait: Gait,
    at: [i64; 2],
    dir: [i64; 2],
    expect: Expect,
}

const MID: [i64; 2] = [4_000_000, 8_000_000];

const CASES: [Case; 12] = [
    Case {
        name: "flat, walk",
        rise_x: 0,
        rise_z: 0,
        from: 0,
        gait: WALK,
        at: MID,
        dir: [1, 0],
        expect: Expect::Speed,
    },
    Case {
        name: "flat, run",
        rise_x: 0,
        rise_z: 0,
        from: 0,
        gait: RUN,
        at: MID,
        dir: [1, 0],
        expect: Expect::Speed,
    },
    Case {
        name: "up a gentle slope (0.2), walk",
        rise_x: 200,
        rise_z: 0,
        from: 0,
        gait: WALK,
        at: MID,
        dir: [1, 0],
        expect: Expect::Speed,
    },
    Case {
        name: "down a slope (0.4), jog",
        rise_x: -400,
        rise_z: 0,
        from: 0,
        gait: JOG,
        at: MID,
        dir: [1, 0],
        expect: Expect::Speed,
    },
    Case {
        name: "across a slope (0.4), jog",
        rise_x: 400,
        rise_z: 0,
        from: 0,
        gait: JOG,
        at: [8_000_000, 4_000_000],
        dir: [0, 1],
        expect: Expect::Speed,
    },
    Case {
        name: "diagonally up a slope (0.3 by 0.3), run",
        rise_x: 300,
        rise_z: 300,
        from: 0,
        gait: RUN,
        at: [3_000_000, 3_000_000],
        dir: [1, 1],
        expect: Expect::Speed,
    },
    Case {
        name: "up just under the limit (0.577), walk",
        rise_x: 577,
        rise_z: 0,
        from: 0,
        gait: WALK,
        at: MID,
        dir: [1, 0],
        expect: Expect::Speed,
    },
    Case {
        name: "up just under the limit (0.577), run",
        rise_x: 577,
        rise_z: 0,
        from: 0,
        gait: RUN,
        at: MID,
        dir: [1, 0],
        expect: Expect::Speed,
    },
    Case {
        name: "just over the limit (0.578): no ground",
        rise_x: 578,
        rise_z: 0,
        from: 0,
        gait: WALK,
        at: MID,
        dir: [1, 0],
        expect: Expect::NoGround,
    },
    Case {
        name: "well over the limit (1.0): no ground",
        rise_x: 1_000,
        rise_z: 0,
        from: 0,
        gait: WALK,
        at: MID,
        dir: [1, 0],
        expect: Expect::NoGround,
    },
    Case {
        name: "flat, then over the limit from 8 m: stops at its foot, walk",
        rise_x: 700,
        rise_z: 0,
        from: 8,
        gait: WALK,
        at: MID,
        dir: [1, 0],
        expect: Expect::StopsBefore(8_000_000),
    },
    Case {
        name: "flat, then over the limit from 8 m, met at a slant: slides along its foot, run",
        rise_x: 700,
        rise_z: 0,
        from: 8,
        gait: RUN,
        at: [4_000_000, 2_000_000],
        dir: [2, 1],
        expect: Expect::StopsBefore(8_000_000),
    },
];

fn run_case(c: &Case) -> Result<String, String> {
    let im = world(|i, j| (i - c.from).max(0) * c.rise_x + j * c.rise_z);
    let s = surface(&im);
    let b = place(&s, c.at);
    match (c.expect, b) {
        (Expect::NoGround, None) => Ok("no piece holds it".into()),
        (Expect::NoGround, Some(_)) => Err("a body stands on steep ground".into()),
        (_, None) => Err("no ground to stand on".into()),
        (Expect::Speed, Some(mut b)) => {
            let w = walk(&s, &mut b, c.gait, c.dir, 20);
            let v = w.along * 1e6 / w.time as f64;
            let err = (v / c.gait.speed as f64 - 1.0).abs();
            let r = format!(
                "{:.4} m/s along the surface ({:+.2} %)",
                v / 1e6,
                (v / c.gait.speed as f64 - 1.0) * 100.0
            );
            if err <= 0.02 { Ok(r) } else { Err(r) }
        }
        (Expect::StopsBefore(x), Some(mut b)) => {
            let y0 = b.pose.position.y;
            let w = walk(&s, &mut b, c.gait, c.dir, 60);
            let r = format!(
                "ends at ({:.3}, {:.3}, {:.3}) m",
                w.end.x as f64 / 1e6,
                w.end.y as f64 / 1e6,
                w.end.z as f64 / 1e6
            );
            if w.end.x <= x && w.end.y == y0 {
                Ok(r)
            } else {
                Err(r)
            }
        }
    }
}

/// A5 (the slope half): every slope case passes, and A1's table for walk, jog and run on the flat, up a slope, down
/// one and across one, two repeats.
#[test]
fn slope_cases_pass_as_data() {
    assert_eq!(STEEP, 577_400);
    let mut failed = Vec::new();
    for c in &CASES {
        let r = run_case(c);
        println!(
            "{:<4} {}: {}",
            if r.is_ok() { "pass" } else { "FAIL" },
            c.name,
            r.as_ref().unwrap_or_else(|e| e)
        );
        if r.is_err() {
            failed.push(c.name);
        }
    }
    assert!(failed.is_empty(), "failed: {failed:?}");
}

/// A1: walk, jog and run measure 1.4, 2.5 and 4.0 m/s along the surface within 2 %, on the flat and on slopes of
/// 0.2, 0.4 and 0.57, up, down and across; two repeats, which must agree to the micrometre.
#[test]
fn a1_speed_table() {
    let slopes = [0, 200, 400, 570];
    let mut table = Vec::new();
    for repeat in 1..=2 {
        let mut row = Vec::new();
        for g in DRY {
            for rise in slopes {
                for (how, dir, at) in [
                    ("up", [1, 0], MID),
                    ("down", [-1, 0], [12_000_000, 8_000_000]),
                    ("across", [0, 1], [8_000_000, 4_000_000]),
                ] {
                    let s = surface(&world(|i, _| i * rise));
                    let mut b = place(&s, at).expect("on the slope");
                    let w = walk(&s, &mut b, g, dir, 20);
                    let v = w.along * 1e6 / w.time as f64;
                    println!(
                        "repeat {repeat}: {:<4} slope {:.2} {:<6} {:.4} m/s ({:+.3} %)",
                        g.name,
                        f64::from(rise) / 1000.0,
                        how,
                        v / 1e6,
                        (v / g.speed as f64 - 1.0) * 100.0
                    );
                    assert!(
                        (v / g.speed as f64 - 1.0).abs() <= 0.02,
                        "{} {how} {rise}",
                        g.name
                    );
                    row.push(w.end);
                }
            }
        }
        table.push(row);
    }
    assert_eq!(table[0], table[1], "the two repeats agree");
    assert_eq!(Gait::named("jog"), Some(JOG));
}

/// A1 on Eden's own hills: in each of Eden's squares on terrain, the first spot whose slope is between 0.1 and the
/// limit and which has 3 m of ground uphill; each gait walks up from there for 0.5 s. Also the time to cut every
/// square on the terrain, and the steep cells taken away.
#[test]
#[ignore = "needs the exported Eden facts file"]
// Times the cut on Eden: the wall-clock rule (K7) binds the engine, not this test.
#[allow(clippy::disallowed_methods)]
fn a1_eden_hills() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text = std::fs::read_to_string(path).expect("run the exporter first");
    let im = import_eden::load(&text).expect("Eden loads");
    let ground = im.nodes["ground"];
    let terrain = sim::ground::Terrain::of(&im.tree, ground)
        .unwrap()
        .expect("Eden's terrain");
    let t0 = std::time::Instant::now();
    let open = OpenGround::of(&im.tree, ground, HUMAN_RADIUS).unwrap();
    let mut pieces = Vec::new();
    let squares = open.squares();
    for &(i, j) in &squares {
        pieces.extend(open.cut_square(i, j).pieces);
    }
    let cut = t0.elapsed();
    let tris: usize = pieces.iter().map(|p| p.triangles.len()).sum();
    let flat = OpenGround::prepare(
        &sim::ground::Scene::of(&im.tree, ground).unwrap(),
        HUMAN_RADIUS,
    )
    .unwrap();
    let t1 = std::time::Instant::now();
    let flat_tris: usize = squares
        .iter()
        .map(|&(i, j)| {
            flat.cut_square(i, j)
                .pieces
                .iter()
                .map(|p| p.triangles.len())
                .sum::<usize>()
        })
        .sum();
    println!(
        "Eden: {} squares cut on the terrain in {} ms, {tris} triangles (flat: {} ms, {flat_tris} triangles)",
        squares.len(),
        cut.as_millis(),
        t1.elapsed().as_millis()
    );
    let on = open.on_terrain(&pieces);
    let wet = on.iter().flatten().filter(|o| !**o).count();
    println!("Eden: {wet} triangles off the terrain (a corner or the middle over water)");
    let s = Surface::new(ground, pieces).on_terrain(terrain.clone(), on);
    let mut spots = 0;
    'sq: for &(i, j) in &squares {
        for k in 0..16 {
            for l in 0..16 {
                let (x, z) = (
                    (i64::from(i) * 16 + k) * 1_000_000 + 500_000,
                    (i64::from(j) * 16 + l) * 1_000_000 + 500_000,
                );
                let slope = terrain.slope_at(x, z).unwrap_or(0);
                if !(100_000..STEEP).contains(&slope) {
                    continue;
                }
                // Uphill, by the heights a metre either way.
                let h = |dx: i64, dz: i64| terrain.height_at(x + dx, z + dz).unwrap_or(0);
                // In mm, so the direction's length in [`walk`] stays within 64 bits.
                let dir = [
                    (h(500_000, 0) - h(-500_000, 0)) / 1000,
                    (h(0, 500_000) - h(0, -500_000)) / 1000,
                ];
                if dir == [0, 0] {
                    continue;
                }
                let mut ok = true;
                let mut rows = Vec::new();
                for g in DRY {
                    let Some(mut b) = place(&s, [x, z]) else {
                        continue 'sq;
                    };
                    let w = walk(&s, &mut b, g, dir, 10);
                    let v = w.along * 1e6 / w.time as f64;
                    let climbed = w.end.y - terrain.height_at(x, z).unwrap_or(0);
                    ok &= (v / g.speed as f64 - 1.0).abs() <= 0.02 && climbed > 0;
                    rows.push(format!(
                        "{} {:.4} m/s ({:+.3} %), up {:.3} m",
                        g.name,
                        v / 1e6,
                        (v / g.speed as f64 - 1.0) * 100.0,
                        climbed as f64 / 1e6
                    ));
                }
                if ok {
                    println!(
                        "at ({:.1}, {:.1}) m, slope {:.3}: {}",
                        x as f64 / 1e6,
                        z as f64 / 1e6,
                        slope as f64 / 1e6,
                        rows.join("; ")
                    );
                    spots += 1;
                    if spots == 5 {
                        break 'sq;
                    }
                    continue 'sq;
                }
            }
        }
    }
    assert_eq!(
        spots, 5,
        "five spots on Eden's hills where every gait keeps its speed"
    );
}

/// #3241's A1: a fence on a hill blocks at its foot as on flat ground. A 6 m fence across x = 10 m, 1.2 m high,
/// stands on the ground, flat or rising 0.3 m a metre along x (3 m up at the fence); a walker walking toward it from
/// x = 6 m stops at it, the body's radius from its face, on both.
#[test]
fn a_fence_on_a_hill_stops_a_walker_at_its_foot() {
    for rise in [0, 300] {
        let y = 10 * rise;
        let fence = format!(
            r#"{{"id": "e_fence", "def": "core-fence@1", "ref": "core-fence@1", "parent": null,
              "pose": [10000, {y}, 8000, 0], "world": [10000, {y}, 8000, 0], "scale_ppm": 1000000,
              "solids": [[0, 0, 50, 3000, 0, 0, 1200, 1, 0]]}}"#
        );
        let im = world_with(
            |i, _| i * rise,
            r#"{"ref": "core-fence@1", "hash": "ff", "name": "core:fence", "form": "point"}"#,
            &fence,
        );
        let s = surface(&im);
        let mut b = place(&s, [6_000_000, 8_000_000]).expect("a body below the fence");
        let w = walk(&s, &mut b, WALK, [1, 0], 100);
        let face = 10_000_000 - 50_000 - HUMAN_RADIUS * 1000;
        println!(
            "rise {rise} mm/m: ends at x {:.3} m (the fence's face less the body's radius: {:.3} m)",
            w.end.x as f64 / 1e6,
            face as f64 / 1e6
        );
        assert!(
            w.end.x <= face && w.end.x > face - 100_000,
            "rise {rise} mm/m: stops at the fence, not through it or short of it: x {} µm",
            w.end.x
        );
    }
}
