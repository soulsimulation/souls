//! Pose and motion against their fixtures (Engine v2 T4, #2644; rules in `v2/docs/pose.md`). Each test is Step 0 or
//! one acceptance box, and prints what it saw. The WASM build gives the same goldens in Node (the `pose-goldens`
//! step of `v2/tools/ci.sh`).

use replica::pose::{
    FIXTURES, Frame, Motion, Owner, STANDARD_GRAVITY, Support, Track, Vec3, fixture, fixture_value,
    hand_offs, pose_goldens, scene_from_fixture,
};

fn goldens_file() -> String {
    let path = format!("{}/fixtures/pose/goldens.txt", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The largest difference of one number between two motions: position and velocity in their units, orientation in
/// 2^-30.
fn apart(a: &Motion, b: &Motion) -> (i128, i128, i128) {
    let (qa, qb) = (a.orientation.parts(), b.orientation.parts());
    let q = (0..4)
        .map(|i| (i128::from(qa[i]) - i128::from(qb[i])).abs())
        .max()
        .unwrap_or(0);
    (a.position.apart(b.position), a.linear.apart(b.linear), q)
}

#[test]
fn step0_thrown_ball_after_ten_seconds_in_integers() {
    let ball = Track::Thrown {
        t0: 0,
        from: Vec3::new(0, 1_500_000, 0),
        velocity: Vec3::new(8_000_000, 6_000_000, 0),
        gravity: Vec3::new(0, -STANDARD_GRAVITY, 0),
        spin: Vec3::ZERO,
    };
    let (p, v) = ball.at(Vec3::ZERO, 10_000_000).unwrap();
    let gt2 = i128::from(STANDARD_GRAVITY) * 10_000_000i128 * 10_000_000i128;
    println!(
        "Step 0: g * t^2 = {gt2} um*us^2/s^2 at 10 s, {} 2^63 = {}: 128-bit intermediates",
        if gt2 > i128::from(i64::MAX) {
            ">"
        } else {
            "<="
        },
        i64::MAX
    );
    println!(
        "        by hand: x = 8e6 * 10 = 80,000,000 um; y = 1.5e6 + 6e6 * 10 - 9,806,650 * 100 / 2 = -428,832,500 um"
    );
    println!("        in code: position {p} um, velocity {v} um/s");
    assert!(gt2 > i128::from(i64::MAX));
    assert_eq!(p, Vec3::new(80_000_000, -428_832_500, 0));
    assert_eq!(v, Vec3::new(8_000_000, 6_000_000 - 98_066_500, 0));
    let ten_km: i64 = 10_000_000_000;
    println!(
        "        a world 10 km across is {ten_km} um, inside 64 bits ({}x headroom); no hand-back",
        i64::MAX / ten_km
    );
}

#[test]
fn a1_three_fixtures_load_and_check() {
    for (name, text) in FIXTURES {
        let (scene, checks) = scene_from_fixture(&fixture_value(text).unwrap())
            .unwrap_or_else(|r| panic!("{name}: {r}"));
        for (id, t, want) in checks {
            let (m, crossed) = scene.motion(id, t).unwrap();
            let off = m.position.apart(want);
            println!(
                "A1: {name}: node {} at {t} us: {} um, expected {want}, {off} apart, {crossed} frames crossed",
                id.counter(),
                m.position
            );
            assert!(
                off <= i128::from(crossed),
                "{name}: within one unit per frame"
            );
        }
    }
    // The hovering body is supported by the surface below it, with a height: its height above the floor is the
    // support's height.
    let (scene, _) = scene_from_fixture(&fixture_value(FIXTURES[1].1).unwrap()).unwrap();
    let body = scene.get(fixture(3)).unwrap();
    let Support::Surface { surface, height } = body.pose.support else {
        panic!("a hovering body's support is a surface")
    };
    let (floor, _) = scene.motion(surface, 0).unwrap();
    let (at, _) = scene.motion(fixture(3), 0).unwrap();
    assert_eq!(at.position.y - floor.position.y, height);
    println!(
        "A1: hover.diag: support surface node {}, height {height} um = body y {} - floor y {}",
        surface.counter(),
        at.position.y,
        floor.position.y
    );
    // A pose that breaks a rule is refused by name.
    for (bad, want) in [
        (
            "{1: [1], 2: [0, 0, 0], 3: [-1073741824, 0, 0, 0], 4: {1: 0}}",
            "orientation-sign",
        ),
        (
            "{1: [1], 2: [0, 0, 0], 3: [1000000000, 0, 0, 0], 4: {1: 0}}",
            "orientation-not-unit",
        ),
        (
            "{1: [1], 2: [0, 0, 0], 3: [1073741824, 0, 0, 0], 4: {1: 1, 2: 1, 3: -1}}",
            "height-below-surface",
        ),
        (
            "{1: [1, 2], 2: [0, 0, 0], 3: [1073741824, 0, 0, 0], 4: {1: 0}}",
            "support-not-slot",
        ),
    ] {
        let text = format!("{{1: 1, 2: [{{1: 2, 2: {bad}, 3: {{1: 3, 2: {{1: 1}}}}}}]}}");
        let got = scene_from_fixture(&fixture_value(&text).unwrap()).unwrap_err();
        assert_eq!(got.name(), want);
        println!("A1: refused {want}");
    }
}

#[test]
fn a2_hand_offs_keep_world_motion_within_one_unit_per_frame() {
    let (mut scene, _) = scene_from_fixture(&fixture_value(FIXTURES[0].1).unwrap()).unwrap();
    let (body, ball, dock) = (fixture(3), fixture(5), fixture(4));

    // Hand to flight: the ball leaves the hand at 1 s, thrown 6 m/s along the root's x and 4 m/s up.
    let t = 1_000_000;
    let push = Vec3::new(6_000_000, 4_000_000, 0);
    let (before, _) = scene.motion(ball, t).unwrap();
    let thrown = Owner::Track(Track::Thrown {
        t0: 0,
        from: Vec3::ZERO,
        velocity: Vec3::ZERO,
        gravity: Vec3::new(0, -9_806_650, 0),
        spin: Vec3::ZERO,
    });
    let (h, crossed) = scene
        .hand_off(
            ball,
            t,
            Frame {
                node: scene.root,
                slot: None,
            },
            Support::None,
            thrown,
            push,
        )
        .unwrap();
    let (after, _) = scene.motion(ball, t).unwrap();
    let kept = Motion {
        linear: before.linear.plus(push).unwrap(),
        ..before
    };
    let (p, v, q) = apart(&kept, &after);
    println!(
        "A2: hand to flight at {t} us: {crossed} frames crossed; position {p} um, velocity {v} um/s, orientation {q} \
         apart; the ball now leaves at {} with {} um/s",
        after.position, after.linear
    );
    assert!(matches!(h.to, Owner::Track(Track::Thrown { t0, .. }) if t0 == t));
    assert!(p.max(v).max(q) <= i128::from(crossed));

    // Deck to dock: the body steps off at 1.5 s, keeping the boat's velocity in the root frame.
    let t = 1_500_000;
    let (before, _) = scene.motion(body, t).unwrap();
    let (_, crossed) = scene
        .hand_off(
            body,
            t,
            Frame {
                node: dock,
                slot: None,
            },
            Support::Surface {
                surface: dock,
                height: 0,
            },
            Owner::Mover { driver: body },
            Vec3::ZERO,
        )
        .unwrap();
    let (after, _) = scene.motion(body, t).unwrap();
    let (p, v, q) = apart(&before, &after);
    println!(
        "A2: deck to dock at {t} us: {crossed} frames crossed; position {p} um, velocity {v} um/s, orientation {q} \
         apart; in the root frame {} um at {} um/s",
        after.position, after.linear
    );
    assert!(p.max(v).max(q) <= i128::from(crossed));
}

#[test]
fn a3_a_thousand_hand_offs_stay_within_the_bound() {
    let n = 1_000;
    let d = hand_offs(n).unwrap();
    // The bound the page states (rule 14): one unit per frame crossed per hand-off, added up.
    let bound = i128::from(n) * i128::from(d.crossed);
    println!(
        "A3: {n} hand-offs, deck to dock and back every 10 ms over 10 s: drift {} um in position, {} um/s in \
         velocity, {} in 2^-30 of orientation, against the bound {bound} ({n} x {} frames crossed); worst single \
         hand-off {} units for {} frames",
        d.position, d.velocity, d.orientation, d.crossed, d.worst_step.0, d.worst_step.1
    );
    assert!(d.worst_step.0 <= i128::from(d.worst_step.1));
    assert!(d.position.max(d.velocity).max(d.orientation) <= bound);
}

#[test]
fn a4_goldens_equal_in_two_runs_and_the_file() {
    let first = pose_goldens();
    assert_eq!(first, pose_goldens(), "two runs");
    print!("{first}");
    assert_eq!(
        first,
        goldens_file(),
        "native goldens equal fixtures/pose/goldens.txt"
    );
    println!("A4: native goldens equal the committed file");
}
