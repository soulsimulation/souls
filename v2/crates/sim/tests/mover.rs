//! The surface mover (Engine v2 N6, #2654).
//!
//! `cargo test -p sim --release --test mover -- --nocapture` runs the test ring (A1, a million steps in a release
//! build, 50,000 in a debug one), the deck (A2) and the crossing (A3). Eden's worst room (A1) needs N1's exported
//! facts file (`node v2/tools/import-eden/export/export.ts` from the repository root) and runs with
//! `cargo test -p sim --release --test mover -- --ignored --nocapture`. Each A1 run posts its cost per step (A4).

// Times its own runs: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

use import_eden::Import;
use replica::effects::TransferRec;
use replica::ids::{Minter, Scope};
use replica::pose::{
    ControllerInput, FIXTURES, Frame, Mode, Scene, Support, Vec3, fixture, fixture_value,
    scene_from_fixture,
};
use sim::ground::scene::ROOM;
use sim::ground::{HUMAN_RADIUS, OpenGround, Piece, Scene as Ground, Turn, cut_floor};
use sim::mover::{Body, Surface, cross};

const TICK: i64 = 50_000;

/// SplitMix64: the seeded steps.
struct Seed(u64);

impl Seed {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> i64 {
        (self.next() % n) as i64
    }
}

fn walk(v: [i64; 2]) -> ControllerInput {
    ControllerInput {
        velocity: Vec3::new(v[0], 0, v[1]),
        mode: Mode::Surface,
    }
}

/// A velocity of `speed` µm/s toward a direction drawn from the seed (an integer direction scaled by its length).
fn heading(seed: &mut Seed, speed: i64) -> [i64; 2] {
    loop {
        let d = [seed.below(2001) - 1000, seed.below(2001) - 1000];
        let l = (d[0] * d[0] + d[1] * d[1]).isqrt();
        if l > 0 {
            return [d[0] * speed / l, d[1] * speed / l];
        }
    }
}

/// What a run of steps came to: steps, the moves cut short by an edge, the crossings into another piece of the same
/// node, and the time taken by the steps alone.
#[derive(Default)]
struct Run {
    steps: u64,
    short: u64,
    still: u64,
    crossed: u64,
    ns: u128,
}

/// One seeded step: `want` is the velocity asked; checks that the body ends inside a triangle of its patch, at its
/// surface's height.
fn one(s: &Surface, b: &mut Body, want: [i64; 2], at: i64, run: &mut Run, y: i64) {
    let before = (b.pose.position, b.piece);
    let t = std::time::Instant::now();
    s.step(b, walk(want), TICK, at).expect("a step");
    run.ns += t.elapsed().as_nanos();
    run.steps += 1;
    let p = b.pose.position;
    assert!(
        s.inside(b.piece, b.tri, [p.x, p.z]),
        "step {}: ({}, {}) is not in triangle {} of piece {}",
        run.steps,
        p.x,
        p.z,
        b.tri,
        b.piece
    );
    assert_eq!(p.y, y, "step {}: off the surface's height", run.steps);
    let moved = (p.x - before.0.x).pow(2) + (p.z - before.0.z).pow(2);
    let asked = (want[0] * TICK / 1_000_000).pow(2) + (want[1] * TICK / 1_000_000).pow(2);
    if moved + 4 < asked {
        run.short += 1;
        if moved == 0 {
            run.still += 1;
        }
    }
    if b.piece != before.1 {
        run.crossed += 1;
    }
}

fn report(what: &str, r: &Run) {
    println!(
        "  {what}: {} steps, {} cut short by an edge ({} of them not moved at all), {} into another piece; {} ns a step ({} ms in all)",
        r.steps,
        r.short,
        r.still,
        r.crossed,
        r.ns / u128::from(r.steps.max(1)),
        r.ns / 1_000_000
    );
}

fn testworld() -> Import {
    let w = testworld::generate(1, 0).expect("the test world");
    import_eden::load(&w.text).expect("the test world loads")
}

/// Every square of an open ground, as one surface.
fn open_ground(im: &Import) -> Surface {
    let ground = im.nodes["ground"];
    let open = OpenGround::prepare(&Ground::of(&im.tree, ground).unwrap(), HUMAN_RADIUS).unwrap();
    let mut pieces = Vec::new();
    for (i, j) in open.squares() {
        pieces.extend(open.cut_square(i, j).pieces);
    }
    Surface::new(ground, pieces)
}

/// A1 on the test ring: a body walks round the ring's solid middle (22 m across) on the open ground, seeded: a speed
/// up to 3 m/s round a circle 15 m out (which cuts the middle's corners), a seeded swerve, and now and then a seeded
/// heading for up to 40 ticks.
#[test]
fn a1_a_million_steps_round_the_ring() {
    let n: u64 = if cfg!(debug_assertions) {
        50_000
    } else {
        1_000_000
    };
    let im = testworld();
    let s = open_ground(&im);
    let (cx, r0) = (testworld::RING_X * 1000, 15_000_000i64);
    println!(
        "A1 the ring: the open ground of the test world, {} pieces",
        s.pieces().len()
    );
    for repeat in 0..2 {
        let mut seed = Seed(2654);
        let frame = Frame {
            node: s.node,
            slot: None,
        };
        let mut b = s
            .place(
                fixture(3),
                frame,
                Vec3::new(cx, 0, -13_000_000),
                replica::pose::Quat::IDENTITY,
            )
            .expect("on the walkway");
        let mut run = Run::default();
        let mut own: Option<([i64; 2], i64)> = None;
        let (mut far, mut quarters, mut last) = ((i64::MAX, 0i64), 0u64, (true, false));
        for k in 0..n {
            let p = b.pose.position;
            let want = match own {
                Some((v, left)) if left > 0 => {
                    own = Some((v, left - 1));
                    v
                }
                _ if seed.below(200) == 0 => {
                    let sp = 200_000 + seed.below(2_800_000);
                    let v = heading(&mut seed, sp);
                    own = Some((v, seed.below(40)));
                    v
                }
                _ => {
                    // Round the circle, pulled back to it, with a swerve.
                    let (dx, dz) = (p.x - cx, p.z);
                    let r = (dx * dx + dz * dz).isqrt().max(1);
                    let speed = 500_000 + seed.below(2_500_000);
                    let pull = (r0 - r) / 4;
                    let sw = seed.below(600_000);
                    let swerve = heading(&mut seed, sw);
                    [
                        -dz * speed / r + dx * pull / r + swerve[0],
                        dx * speed / r + dz * pull / r + swerve[1],
                    ]
                }
            };
            one(&s, &mut b, want, (k as i64 + 1) * TICK, &mut run, 0);
            let q = b.pose.position;
            let r = ((q.x - cx).pow(2) + q.z.pow(2)).isqrt();
            far = (far.0.min(r), far.1.max(r));
            let side = (q.x >= cx, q.z >= 0);
            if side != last {
                quarters += 1;
                last = side;
            }
        }
        report(&format!("repeat {}", repeat + 1), &run);
        println!(
            "    from the ring's centre: {} to {} mm; {} quarter-turns crossed (either way)",
            far.0 / 1000,
            far.1 / 1000,
            quarters
        );
    }
}

fn eden() -> Import {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    import_eden::load(&text).expect("Eden loads")
}

/// A1 on Eden's worst room: the floor whose patch has the most pieces. A million seeded steps shared among its
/// pieces by their triangles, each walk from a piece's first triangle, a seeded heading at up to 3 m/s for 1 to 40 ticks at a time.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a1_a_million_steps_in_edens_worst_room() {
    let im = eden();
    let mut worst: Option<(usize, &String, Vec<Piece>, i64)> = None;
    for (key, id) in &im.nodes {
        let Ok(scene) = Ground::of(&im.tree, *id) else {
            continue;
        };
        // A room's floor: a floor that holds a room (a bridge's or a pier's floor holds none).
        let h = im.tree.handle(*id).unwrap();
        let room = im.tree.children(h).unwrap().iter().any(|&c| {
            im.tree
                .node(c)
                .is_some_and(|n| replica::world_model::plain(n.kind().as_str()) == ROOM)
        });
        if scene.open || !room {
            continue;
        }
        let Ok(p) = cut_floor(&scene, HUMAN_RADIUS, Turn::NONE) else {
            continue;
        };
        if worst.as_ref().is_none_or(|w| p.pieces.len() > w.0) {
            let y = scene.surfaces.first().map_or(0, |f| f.y);
            worst = Some((p.pieces.len(), key, p.pieces, y));
        }
    }
    let (count, key, pieces, _) = worst.expect("a floor");
    let triangles: usize = pieces.iter().map(|p| p.triangles.len()).sum();
    let s = Surface::new(im.nodes[key], pieces);
    println!("A1 Eden's worst room: {key}, {count} pieces, {triangles} triangles");
    let n: u64 = 1_000_000;
    for repeat in 0..2 {
        let mut seed = Seed(2654);
        let mut run = Run::default();
        for (q, pc) in s.pieces().iter().enumerate() {
            let t = pc.triangles[0];
            let v = |k: u32| pc.vertices[k as usize];
            let (a, b2, c) = (v(t[0]), v(t[1]), v(t[2]));
            let mid = |i: usize| (i64::from(a[i]) + i64::from(b2[i]) + i64::from(c[i])) * 1000 / 3;
            let frame = Frame {
                node: s.node,
                slot: None,
            };
            let mut b = s
                .place(
                    fixture(3),
                    frame,
                    Vec3::new(mid(0), 0, mid(2)),
                    replica::pose::Quat::IDENTITY,
                )
                .expect("on its piece");
            assert_eq!(b.piece, q as u32);
            let y = b.pose.position.y;
            let (mut v, mut left) = ([0, 0], 0);
            // Steps by the piece's triangles, the rest to the first: the slivers the cut leaves get few.
            let by = |q: usize| n * s.pieces()[q].triangles.len() as u64 / triangles as u64;
            let rest = n - (0..count).map(by).sum::<u64>();
            let share = by(q) + if q == 0 { rest } else { 0 };
            for k in 0..share {
                if left == 0 {
                    let sp = seed.below(3_000_000);
                    v = heading(&mut seed, sp);
                    left = 1 + seed.below(40);
                }
                left -= 1;
                one(&s, &mut b, v, (k as i64 + 1) * TICK, &mut run, y);
            }
        }
        report(&format!("repeat {}", repeat + 1), &run);
    }
}

/// The boat fixture's scene, with the body (3) walking at `walk` µm/s in the deck's frame.
fn boat(walk: Vec3) -> Scene {
    let (_, text) = FIXTURES[0];
    let (scene, _) = scene_from_fixture(&fixture_value(text).unwrap()).unwrap();
    let ids = [2u64, 3, 5, 4];
    let list = ids
        .iter()
        .map(|&c| {
            let mut m = scene.get(fixture(c)).unwrap().clone();
            if c == 3 {
                m.linear = walk;
            }
            m
        })
        .collect();
    Scene::new(scene.root, list).unwrap()
}

/// A rectangle in a node's frame, mm, at height `y` mm: two triangles.
fn rect(x0: i32, z0: i32, x1: i32, z1: i32, y: i32) -> Piece {
    Piece {
        outline: vec![vec![[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]]],
        vertices: vec![[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]],
        triangles: vec![[0, 2, 1], [0, 3, 2]],
        ground: sim::gaits::Ground::Dry,
    }
}

/// A2: the boat travels 10 m on its track; the body standing on its deck keeps its stored pose, and each tick's step
/// writes no motion sample.
#[test]
fn a2_a_body_on_a_moving_deck_is_carried() {
    let scene = boat(Vec3::ZERO);
    let deck = Surface::new(fixture(2), vec![rect(-3000, -2000, 3000, 2000, 1200)]);
    let stored = scene.get(fixture(3)).unwrap().pose;
    let mut b = deck
        .place(
            fixture(3),
            stored.frame,
            stored.position,
            stored.orientation,
        )
        .unwrap();
    assert_eq!(b.pose, stored, "placed where the fixture stands it");
    let start = scene.motion(fixture(3), 0).unwrap().0.position;
    let mut t = 0;
    let mut written = 0;
    loop {
        let w = scene.motion(fixture(3), t).unwrap().0.position;
        let gone = (i128::from(w.x - start.x).pow(2)
            + i128::from(w.y - start.y).pow(2)
            + i128::from(w.z - start.z).pow(2))
        .isqrt();
        if gone >= 10_000_000 {
            println!(
                "A2: the deck carried the body {} mm in {} ticks ({} s); stored pose unchanged; {written} motion samples written",
                gone / 1000,
                t / TICK,
                t / 1_000_000
            );
            break;
        }
        t += TICK;
        if deck.step(&mut b, walk([0, 0]), TICK, t).unwrap().is_some() {
            written += 1;
        }
        assert_eq!(b.pose, stored);
        assert_eq!(b.linear, Vec3::ZERO);
    }
    assert_eq!(written, 0);
}

/// A3: a body walking on the moving deck crosses onto the dock (another node, at rest, turned 90 degrees): one leave
/// and one arrive under one transfer id, and its speed in the root frame the same before and after.
#[test]
fn a3_a_crossing_is_one_leave_and_arrive_at_the_same_speed() {
    let deck = Surface::new(fixture(2), vec![rect(-3000, -2000, 3000, 2000, 1200)]);
    let dock = Surface::new(
        fixture(4),
        vec![rect(-50_000, -50_000, 50_000, 50_000, 200)],
    );
    let mut scene = boat(Vec3::ZERO);
    let stored = scene.get(fixture(3)).unwrap().pose;
    let mut b = deck
        .place(
            fixture(3),
            stored.frame,
            stored.position,
            stored.orientation,
        )
        .unwrap();
    // Walk across the deck at 1.4 m/s for ten ticks, then cross.
    let mut t = 0;
    for _ in 0..10 {
        t += TICK;
        deck.step(&mut b, walk([1_400_000, -300_000]), TICK, t)
            .unwrap();
    }
    scene = boat(b.linear);
    let list: Vec<_> = [2u64, 3, 5, 4]
        .iter()
        .map(|&c| {
            if c == 3 {
                let mut m = scene.get(fixture(3)).unwrap().clone();
                (m.pose, m.linear) = (b.pose, b.linear);
                m
            } else {
                scene.get(fixture(c)).unwrap().clone()
            }
        })
        .collect();
    let mut scene = Scene::new(scene.root, list).unwrap();
    let before = scene.motion(fixture(3), t).unwrap().0;
    let mut minter = Minter::new(Scope([0x26; 16]));
    let id = minter.mint().unwrap();
    let root = scene.root;
    let frame = Frame {
        node: fixture(4),
        slot: None,
    };
    let (after_body, recs) =
        cross(&mut scene, &b, &dock, frame, t, id, Scope([0x26; 16]), root).expect("onto the dock");
    let after = scene.motion(fixture(3), t).unwrap().0;
    let ids: Vec<_> = recs.iter().map(TransferRec::transfer).collect();
    assert_eq!(ids, vec![id, id]);
    assert!(matches!(recs[0], TransferRec::Leave { node, .. } if node == fixture(3)));
    assert!(matches!(recs[1], TransferRec::Arrive { .. }));
    assert_eq!(after_body.pose.frame, frame);
    assert!(
        matches!(after_body.pose.support, Support::Surface { surface, height: 0 } if surface == fixture(4))
    );
    let speed = |v: Vec3| {
        (i128::from(v.x).pow(2) + i128::from(v.y).pow(2) + i128::from(v.z).pow(2)).isqrt()
    };
    let (s0, s1) = (speed(before.linear), speed(after.linear));
    println!(
        "A3: deck to dock at {} ms: transfer {} on the leave and the arrive; speed in the root frame {} um/s before, {} um/s after (walking {} um/s on the deck, {} um/s on the dock)",
        t / 1000,
        replica::world_model::show(id),
        s0,
        s1,
        speed(b.linear),
        speed(after_body.linear)
    );
    // One unit per frame crossed, per axis (T4 rule 10): the old chain (2), the new (1), and the step between.
    assert!((s0 - s1).abs() <= 4, "speed {s0} before, {s1} after");
    for (a, c) in [
        (before.linear.x, after.linear.x),
        (before.linear.y, after.linear.y),
        (before.linear.z, after.linear.z),
    ] {
        assert!((a - c).abs() <= 4);
    }
}

/// A body walking exactly along a 16 m square's line into the point where four squares meet, at (0, 32) m on the
/// test world's open ground: along x = 0 and along z = 32 m, both ways, and on the four diagonals. Each walk starts
/// 2 m short of the corner at 1.4 m/s for 4 s; it must end at least 3 m past it (found by N13, PR #3194: it stopped
/// at the corner for good).
#[test]
fn a_walk_along_a_square_line_passes_the_corner_of_four_squares() {
    let im = testworld();
    let s = open_ground(&im);
    let frame = Frame {
        node: s.node,
        slot: None,
    };
    let corner = [0i64, 32_000_000];
    let (speed, d) = (1_400_000i64, 2_000_000i64);
    let dirs: [[i64; 2]; 8] = [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
    ];
    let mut stuck = Vec::new();
    for dir in dirs {
        let diag = dir[0] != 0 && dir[1] != 0;
        // A diagonal walks at speed/√2 on each axis, from d/√2 short on each: exact multiples, so its line is exact.
        let (v, back) = if diag {
            (speed * 1000 / 1414, d * 1000 / 1414)
        } else {
            (speed, d)
        };
        let start = Vec3::new(corner[0] - dir[0] * back, 0, corner[1] - dir[1] * back);
        let mut b = s
            .place(fixture(3), frame, start, replica::pose::Quat::IDENTITY)
            .expect("on the open ground");
        let want = [dir[0] * v, dir[1] * v];
        let mut run = Run::default();
        for k in 0..80 {
            one(&s, &mut b, want, (k + 1) * TICK, &mut run, 0);
        }
        let p = b.pose.position;
        let past = (p.x - corner[0]) * dir[0] + (p.z - corner[1]) * dir[1];
        let off = (p.x - corner[0]) * dir[1] - (p.z - corner[1]) * dir[0];
        println!(
            "  toward ({}, {}): ends at ({}, {}) mm, {} mm past the corner, {} of 80 steps not moved",
            dir[0],
            dir[1],
            p.x / 1000,
            p.z / 1000,
            past / 1000,
            run.still
        );
        let need = if diag {
            3_000_000 * 1414 / 1000
        } else {
            3_000_000
        };
        if past < need || off != 0 {
            stuck.push((dir, p.x, p.z, run.still));
        }
    }
    assert!(stuck.is_empty(), "stalled at or off the corner: {stuck:?}");
}
