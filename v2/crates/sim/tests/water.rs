//! Wading and swimming on the open ground's water patches (Engine v2 N11b, #3198).
//!
//! `cargo test -p sim --release --test water -- --nocapture` runs a pond written as data (a 16 m square of terrain,
//! a bowl under a pond's outline): its wading ground and its water, the wade and swim speeds (A1's water row, two
//! repeats), who may stand in it, and a walker left in it walked out by the ladder. Eden's eight waters need N1's
//! exported facts file (`node v2/tools/import-eden/export/export.ts` from the repository root) and run with
//! `cargo test -p sim --release --test water -- --ignored --nocapture`.

use import_eden::Import;
use replica::effects::{Header, schema_hash};
use replica::encode::{Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{ControllerInput, Frame, Mode, Quat, Vec3, fixture};
use sim::gaits::{Gait, Ground, SWIM, WADE, WADE_DEPTH};
use sim::ground::{HUMAN_RADIUS, OpenGround, Piece, SQUARE, Scene};
use sim::links::Doors;
use sim::mover::{Body, Surface};
use sim::routes::{HANDS, SWIM as CAN_SWIM, WADE as CAN_WADE};
use sim::unstick::{Ladder, Rung, in_water};
use sim::walk::Crowd;
use sim::walk::town::Town;
use std::collections::BTreeMap;

const TICK: i64 = 50_000;

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

/// The pond's outline: 3 m to 13 m each way, mm.
const POND: [i32; 2] = [3_000, 13_000];
/// Its level, mm.
const LEVEL: i32 = -200;

/// A world of one 16 m terrain tile holding a pond, its 17 × 17 heights (mm) from `h(i, j)`, i along x and j along z.
fn world(h: impl Fn(i32, i32) -> i32) -> Import {
    let n = (SQUARE / 1000) as i32;
    let mut heights = Vec::new();
    for j in 0..=n {
        for i in 0..=n {
            heights.extend_from_slice(&h(i, j).to_le_bytes());
        }
    }
    let classes = vec![0u8; (n * n) as usize];
    let [a, b] = POND;
    let text = format!(
        r#"{{"format": "souls/import-eden/1", "kinds": [], "things": [], "doors": [],
          "places": [{{"id": "pond.water", "of": "water", "kind": "pond", "name": "pond",
            "polygon": [[{a}, {a}], [{b}, {a}], [{b}, {b}], [{a}, {b}]], "level": {LEVEL}}}],
          "bake": {{}}, "byRef": {{}}, "ground": {{"tileM": {n}, "tiles": [{{"tx": 0, "tz": 0,
          "heights": "{}", "classes": "{}"}}]}}}}"#,
        b64(&heights),
        b64(&classes)
    );
    import_eden::load(&text).expect("the pond world loads")
}

/// How far a sample lies inside the pond's outline, m (0 on it or outside).
fn inside(i: i32, j: i32) -> i32 {
    let (a, b) = (POND[0] / 1000, POND[1] / 1000);
    (i - a).min(b - i).min(j - a).min(b - j).max(0)
}

/// A bowl: flat at 0 outside, the bed 0.2 m under the level at the edge and 0.1 m deeper for every metre in.
fn bowl() -> Import {
    world(|i, j| match inside(i, j) {
        0 => 0,
        d => LEVEL - 100 * d,
    })
}

/// The pond walled by ground too steep to stand on: a metre up just outside its edge, then back down.
fn walled() -> Import {
    world(|i, j| {
        let (a, b) = (POND[0] / 1000 - 1, POND[1] / 1000 + 1);
        let ring = (i == a || i == b) && (a..=b).contains(&j)
            || (j == a || j == b) && (a..=b).contains(&i);
        match (ring, inside(i, j)) {
            (true, _) => 1_000,
            (_, 0) => 0,
            (_, d) => LEVEL - 100 * d,
        }
    })
}

/// The square's dry pieces and its wet ones, with the open ground.
fn cut(im: &Import) -> (OpenGround, Vec<Piece>, Vec<Piece>) {
    let open = OpenGround::of(&im.tree, im.nodes["ground"], HUMAN_RADIUS).expect("the open ground");
    let dry = open.cut_square(0, 0).pieces;
    let wet = open.cut_water(0, 0).into_iter().map(|(_, p)| p).collect();
    (open, dry, wet)
}

/// A surface of `pieces` on the open ground's terrain.
fn surface(im: &Import, open: &OpenGround, pieces: Vec<Piece>) -> Surface {
    let on = open.on_terrain(&pieces);
    let t = open.terrain().expect("the terrain").clone();
    Surface::new(im.nodes["ground"], pieces).on_terrain(t, on)
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

/// Moves `b` at `gait` toward `dir` for `ticks` ticks: the distance along the surface (µm) and whether every step went
/// the whole way on the plan (no edge slid along).
fn go(s: &Surface, b: &mut Body, gait: Gait, dir: [i64; 2], ticks: i64) -> (f64, bool) {
    let l = ((dir[0] * dir[0] + dir[1] * dir[1]) as f64).sqrt();
    let v = Vec3::new(
        (dir[0] as f64 * gait.speed as f64 / l) as i64,
        0,
        (dir[1] as f64 * gait.speed as f64 / l) as i64,
    );
    let (mut along, mut free) = (0f64, true);
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
        let plan = (d(p.x, q.x).powi(2) + d(p.z, q.z).powi(2)).sqrt();
        along += (plan.powi(2) + d(p.y, q.y).powi(2)).sqrt();
        // A slid step covers less of the plan than the speed's share of it.
        let full = (v.x as f64).hypot(v.z as f64) * TICK as f64 / 1e6;
        free &= plan >= full * 0.9;
    }
    (along, free)
}

fn speed(along: f64, ticks: i64) -> f64 {
    along * 1e6 / (ticks * TICK) as f64
}

/// A2 on the pond: wading ground round its edge, on the bed, and water at its level where the bed lies more than
/// 0.3 m down; the water's edge is the outline, and neither is dry ground.
#[test]
fn a2_the_pond_has_wading_ground_and_water() {
    let im = bowl();
    let (open, dry, wet) = cut(&im);
    let (wading, water): (Vec<&Piece>, Vec<&Piece>) =
        wet.iter().partition(|p| p.ground == Ground::Wading);
    println!(
        "dry {} pieces, wading {} pieces, water {} pieces",
        dry.len(),
        wading.len(),
        water.len()
    );
    assert!(dry.iter().all(|p| p.ground == Ground::Dry));
    assert!(!wading.is_empty() && !water.is_empty());
    assert!(water.iter().all(|p| p.ground == Ground::Water));
    assert!(
        water
            .iter()
            .flat_map(|p| &p.vertices)
            .all(|v| v[1] == LEVEL)
    );
    // The water's outline is the pond's own: every wet corner lies within it.
    let [a, b] = POND;
    assert!(
        wet.iter()
            .flat_map(|p| &p.vertices)
            .all(|v| (a..=b).contains(&v[0]) && (a..=b).contains(&v[2]))
    );
    let s = surface(&im, &open, wet.clone());
    let t = open.terrain().unwrap();
    // On wading ground a body stands on the bed, no deeper than wading; on water, at the level.
    let w = place(&s, [4_500_000, 8_500_000]).expect("on wading ground");
    assert_eq!(s.pieces()[w.piece as usize].ground, Ground::Wading);
    assert_eq!(
        w.pose.position.y,
        t.height_at(4_500_000, 8_500_000).unwrap()
    );
    assert!(i64::from(LEVEL) * 1000 - w.pose.position.y <= WADE_DEPTH);
    let f = place(&s, [8_000_000, 8_000_000]).expect("on the water");
    assert_eq!(s.pieces()[f.piece as usize].ground, Ground::Water);
    assert_eq!(f.pose.position.y, i64::from(LEVEL) * 1000);
    // Dry ground does not hold the water.
    let d = Surface::new(im.nodes["ground"], dry);
    assert!(place(&d, [8_000_000, 8_000_000]).is_none());
    assert!(place(&d, [1_000_000, 8_000_000]).is_some());
}

/// A1's water row on the pond: wading and swimming measure 0.9 and 0.8 m/s along the surface within 2 %, wading up
/// and down the bed and across it, swimming each way; two repeats, which agree to the micrometre.
#[test]
fn a1_wade_and_swim_speeds() {
    let im = bowl();
    let (open, _, wet) = cut(&im);
    let s = surface(&im, &open, wet);
    let runs: [(Gait, Ground, [i64; 2], [i64; 2]); 6] = [
        (WADE, Ground::Wading, [3_300_000, 8_500_000], [1, 0]),
        (WADE, Ground::Wading, [5_700_000, 8_500_000], [-1, 0]),
        (WADE, Ground::Wading, [4_500_000, 7_000_000], [0, 1]),
        (SWIM, Ground::Water, [6_500_000, 8_000_000], [1, 0]),
        (SWIM, Ground::Water, [8_000_000, 9_500_000], [0, -1]),
        (SWIM, Ground::Water, [7_000_000, 7_000_000], [1, 1]),
    ];
    let mut ends = [Vec::new(), Vec::new()];
    for (r, end) in ends.iter_mut().enumerate() {
        for (g, ground, at, dir) in runs {
            assert!(g.allowed(ground));
            let mut b = place(&s, at).expect("in the pond");
            assert_eq!(s.pieces()[b.piece as usize].ground, ground);
            let (along, free) = go(&s, &mut b, g, dir, 20);
            let v = speed(along, 20);
            println!(
                "repeat {}: {:<4} from ({:.1}, {:.1}) m toward {dir:?}: {:.4} m/s ({:+.3} %)",
                r + 1,
                g.name,
                at[0] as f64 / 1e6,
                at[1] as f64 / 1e6,
                v / 1e6,
                (v / g.speed as f64 - 1.0) * 100.0
            );
            assert!(free, "{} slid along an edge", g.name);
            assert!((v / g.speed as f64 - 1.0).abs() <= 0.02, "{}", g.name);
            assert_eq!(s.pieces()[b.piece as usize].ground, ground);
            end.push(b.pose.position);
        }
    }
    assert_eq!(ends[0], ends[1], "the two repeats agree");
}

/// Water is legal ground for a body that may use it, and listed for one that may not (`in-water`); a swimmer in a
/// pond walled by steep ground has no way to a shore (`no-shore`).
#[test]
fn who_may_stand_in_the_water() {
    let id = |n| Id::new(Scope([7; 16]), n).unwrap();
    let v = |x: i64, z: i64| Vec3::new(x, 0, z);
    let (_, dry, wet) = cut(&bowl());
    let pieces: Vec<Piece> = dry.into_iter().chain(wet).collect();
    let bodies = [
        (id(1), HANDS, v(1_000_000, 8_000_000)),
        (id(2), HANDS, v(8_000_000, 8_000_000)),
        (id(3), CAN_WADE, v(8_000_000, 8_000_000)),
        (id(4), CAN_WADE, v(4_500_000, 8_500_000)),
        (id(5), HANDS, v(4_500_000, 8_500_000)),
        (id(6), CAN_SWIM, v(8_000_000, 8_000_000)),
        (id(7), CAN_WADE | CAN_SWIM, v(4_500_000, 8_500_000)),
    ];
    let found: Vec<(u64, &str)> = in_water(&pieces, &bodies)
        .iter()
        .map(|f| (f.body.counter(), f.why))
        .collect();
    println!("the bowl: {found:?}");
    assert_eq!(found, [(2, "in-water"), (3, "in-water"), (5, "in-water")]);

    let (_, dry, wet) = cut(&walled());
    let pieces: Vec<Piece> = dry.into_iter().chain(wet).collect();
    let found: Vec<(u64, &str)> = in_water(&pieces, &bodies[5..6])
        .iter()
        .map(|f| (f.body.counter(), f.why))
        .collect();
    println!("the walled pond: {found:?}");
    assert_eq!(found, [(6, "no-shore")]);
}

/// A walker (no wading, no swimming) found in the water is listed and walked out by the ladder's last rung to the
/// nearest dry ground, at its speed: no tick moves it further than its speed allows.
#[test]
fn a_walker_left_in_the_water_walks_out() {
    const SPEED: i64 = 1_400_000;
    let im = bowl();
    let id = |n| Id::new(Scope([7; 16]), n).unwrap();
    let Import {
        tree, rules, nodes, ..
    } = im;
    let root = nodes["world"];
    let h = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/water-test/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&h).unwrap()).unwrap();
    let next = tree.to_state().next;
    let ground = nodes["ground"];
    let open = OpenGround::of(&tree, ground, HUMAN_RADIUS).unwrap();
    let mut t = Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town");
    let (mut c, mut l) = (Crowd::new(TICK), Ladder::new());
    let b = t.surfaces[&ground]
        .place(
            id(900),
            Frame {
                node: ground,
                slot: None,
            },
            Vec3::new(1_500_000, 0, 8_000_000),
            Quat::IDENTITY,
        )
        .expect("on dry ground");
    let p = b.pose.position;
    l.add(&mut c, &mut t, b, SPEED, id(10_900), ground, p)
        .expect("a still body");
    l.step(&mut c, &mut t).expect("a tick");
    // The pond grows under it (an edit): it now stands in the water, where it may not.
    let into = Vec3::new(6_000_000, p.y, 8_000_000);
    c.walkers[0].body.pose.position = into;
    let pieces: Vec<Piece> = open
        .cut_square(0, 0)
        .pieces
        .into_iter()
        .chain(open.cut_water(0, 0).into_iter().map(|(_, p)| p))
        .collect();
    let found = in_water(&pieces, &[(id(900), HANDS, into)]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].why, "in-water");
    l.walk_out(&mut c, &t, id(900)).expect("a walk-out");
    let (mut was, mut ticks, mut largest) = (into, 0, 0);
    while !l.done(&c) && ticks < 400 {
        l.step(&mut c, &mut t).expect("a tick");
        let q = c.walkers[0].body.pose.position;
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        let step = (d(was.x, q.x) + d(was.z, q.z)).isqrt() as i64;
        largest = largest.max(step);
        assert!(
            step <= SPEED * TICK / 1_000_000 + 1,
            "no jump: {step} µm in a tick"
        );
        was = q;
        ticks += 1;
    }
    let w = &c.walkers[0];
    assert_eq!(w.held, None, "walked out");
    let out: Vec<&Rung> = l
        .log
        .iter()
        .filter(|r| r.who == id(900))
        .map(|r| &r.rung)
        .collect();
    println!("{out:?}; largest move in a tick {largest} µm, {ticks} ticks");
    assert!(matches!(out[0], Rung::WalkOut { from, .. } if *from == into));
    assert!(matches!(out[1], Rung::WalkedOut { .. }));
    let at = w.body.pose.position;
    assert!(
        t.surfaces[&ground]
            .place(id(900), w.body.pose.frame, at, Quat::IDENTITY)
            .is_ok()
    );
    assert!(
        in_water(&pieces, &[(id(900), HANDS, at)]).is_empty(),
        "on dry ground"
    );
}

/// The shoelace area of a piece's outline (outer ring less its holes), m².
fn area(p: &Piece) -> f64 {
    p.outline
        .iter()
        .map(|r| {
            (0..r.len())
                .map(|k| {
                    let (a, b) = (r[k], r[(k + 1) % r.len()]);
                    i64::from(a[0]) * i64::from(b[2]) - i64::from(b[0]) * i64::from(a[2])
                })
                .sum::<i64>() as f64
                / 2e6
        })
        .sum()
}

/// A2 and A1's water row on Eden's eight waters: each water's wading ground and water (pieces, triangles, area), or
/// the reason it has none; and in each, where it has room, a body wading on its wading ground and swimming on its
/// water at the gait's speed along the surface within 2 %, two repeats.
#[test]
#[ignore = "needs the exported Eden facts file"]
// Times the cut on Eden: the wall-clock rule (K7) binds the engine, not this test.
#[allow(clippy::disallowed_methods)]
fn eden_waters() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text = std::fs::read_to_string(path).expect("run the exporter first");
    let im = import_eden::load(&text).expect("Eden loads");
    let ground = im.nodes["ground"];
    let scene = Scene::of(&im.tree, ground).unwrap();
    assert_eq!(scene.waters.len(), 8, "Eden's eight waters");
    let t0 = std::time::Instant::now();
    let open = OpenGround::of(&im.tree, ground, HUMAN_RADIUS).unwrap();
    let mut by: Vec<Vec<Piece>> = vec![Vec::new(); 8];
    for (i, j) in open.squares() {
        for (k, p) in open.cut_water(i, j) {
            by[k as usize].push(p);
        }
    }
    println!(
        "Eden: water patches of {} squares cut in {} ms",
        open.squares().len(),
        t0.elapsed().as_millis()
    );
    let all: Vec<Piece> = by.iter().flatten().cloned().collect();
    let s = surface(&im, &open, all);
    let mut q0 = 0;
    let mut speeds = [Vec::new(), Vec::new()];
    for (k, w) in scene.waters.iter().enumerate() {
        let shape = if w.ring.is_empty() {
            format!(
                "a line of {} points, {} m wide",
                w.line.len(),
                w.width / 1_000_000
            )
        } else {
            format!("a ring of {} points", w.ring.len())
        };
        let mut row = format!("water {k} ({shape}, level {} mm):", w.level / 1000);
        let mut kinds = 0;
        for g in [Ground::Wading, Ground::Water] {
            let ps: Vec<&Piece> = by[k].iter().filter(|p| p.ground == g).collect();
            let tris: usize = ps.iter().map(|p| p.triangles.len()).sum();
            let a: f64 = ps.iter().map(|p| area(p)).sum();
            row += &format!(" {g:?} {} pieces, {tris} triangles, {a:.0} m²;", ps.len());
            kinds += usize::from(!ps.is_empty());
        }
        println!("{row}");
        assert!(kinds > 0, "water {k} has no wading ground and no water");
        // A1 on this water: the first triangle, largest first, from whose middle the gait goes 0.5 s straight.
        for (gait, g) in [(WADE, Ground::Wading), (SWIM, Ground::Water)] {
            let mut tris: Vec<(i64, u32, [i64; 2])> = Vec::new();
            for (n, p) in by[k].iter().enumerate().filter(|(_, p)| p.ground == g) {
                for t in &p.triangles {
                    let c = t.map(|v| p.vertices[v as usize]);
                    let a2 = (i64::from(c[1][0] - c[0][0]) * i64::from(c[2][2] - c[0][2])
                        - i64::from(c[2][0] - c[0][0]) * i64::from(c[1][2] - c[0][2]))
                    .abs();
                    let m =
                        [0, 2].map(|i| c.iter().map(|v| i64::from(v[i])).sum::<i64>() * 1000 / 3);
                    tris.push((a2, q0 + n as u32, m));
                }
            }
            tris.sort_by_key(|t| std::cmp::Reverse(t.0));
            let mut done = false;
            'spot: for &(_, _, m) in tris.iter().take(50) {
                for dir in [
                    [1, 0],
                    [0, 1],
                    [-1, 0],
                    [0, -1],
                    [1, 1],
                    [-1, 1],
                    [1, -1],
                    [-1, -1],
                ] {
                    let mut got = Vec::new();
                    for _ in 0..2 {
                        let Some(mut b) = place(&s, m) else {
                            continue 'spot;
                        };
                        if s.pieces()[b.piece as usize].ground != g {
                            continue 'spot;
                        }
                        let (along, free) = go(&s, &mut b, gait, dir, 10);
                        if !free || s.pieces()[b.piece as usize].ground != g {
                            continue;
                        }
                        got.push((speed(along, 10), b.pose.position));
                    }
                    if got.len() < 2 {
                        continue;
                    }
                    assert_eq!(got[0], got[1], "the two repeats agree");
                    let v = got[0].0;
                    println!(
                        "    {} from ({:.1}, {:.1}) m toward {dir:?}: {:.4} m/s ({:+.3} %), twice",
                        gait.name,
                        m[0] as f64 / 1e6,
                        m[1] as f64 / 1e6,
                        v / 1e6,
                        (v / gait.speed as f64 - 1.0) * 100.0
                    );
                    assert!((v / gait.speed as f64 - 1.0).abs() <= 0.02);
                    speeds[usize::from(g == Ground::Water)].push(v);
                    done = true;
                    break 'spot;
                }
            }
            if !done && !tris.is_empty() {
                println!("    {}: no spot with 0.5 s of room", gait.name);
            }
        }
        q0 += by[k].len() as u32;
    }
    assert!(
        !speeds[0].is_empty() && !speeds[1].is_empty(),
        "wading and swimming measured on Eden"
    );
}
