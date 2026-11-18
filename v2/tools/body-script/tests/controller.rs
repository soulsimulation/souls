//! Engine v2 B1 (#2680): the controller, driven by the script driver with no skill code (A1, A3), one driver per
//! resource (A2), and a skill's inputs passing through it (the host seam, and a skill's own motion refused).
//!
//! `cargo test -p body-script -- --nocapture` prints what each check saw.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use body_script::{
    TICK, ground, ground_id, hex, humanoid, parse, place, quadruped, run, script_shape,
};
use replica::bodies::{Class, SkillShape, Want};
use replica::effects::Change;
use replica::encode::Name;
use replica::host::{Host, Progress, Skill};
use replica::ids::{Id, Minter, Scope};
use replica::pose::{
    ControllerInput, Frame, HandOff, Mode, Owner, Pose, Quat, Support, Vec3, fixture,
};
use replica::tree::Tree;
use replica::world_model::{parse_kinds, parse_world};
use sim::controller::{Controller, Part};
use sim::host::{Geometry, Run, Staged, hand_on, step};

const SQUARE: &str = include_str!("../square.script");

fn name(t: &str) -> Name {
    Name::new(t).expect("a name")
}

/// A1: the script walks a humanoid and a four-legged body round a 4 m square and stops them; two runs give one hash.
#[test]
fn a1_a_script_walks_two_families_round_a_square_and_two_runs_hash_equal() {
    let script = parse(SQUARE).expect("the script reads");
    let a = run(&script).expect("run 1");
    let b = run(&script).expect("run 2");
    println!("run 1 {}\nrun 2 {}", hex(&a.hash), hex(&b.hash));
    assert_eq!(a.hash, b.hash, "two runs, one log");
    assert!(a.refused.is_empty(), "nothing refused: {:?}", a.refused);
    let starts = [(0, 0), (10_000_000, 0)];
    for (r, (x, z)) in a.bodies.iter().zip(starts) {
        println!(
            "{} ({}) ends at ({}, {}) µm after walking {} µs",
            r.name, r.family, r.end.x, r.end.z, r.walking
        );
        // Round the square and back where it started; it stood still for the last 2 s (stopped, then neutral).
        assert_eq!(
            (r.end.x, r.end.z),
            (x, z),
            "{} is back at its start",
            r.name
        );
        assert_eq!(r.walking, 16_000_000, "{} walked 16 s", r.name);
    }
    let families: Vec<&str> = a.bodies.iter().map(|r| r.family.as_str()).collect();
    assert_eq!(families, ["souls:humanoid", "souls:quadruped"]);
}

/// A3: an input enters the log only when it changes: one record per corner and one for the stop, none along a side.
#[test]
fn a3_a_body_walking_one_straight_side_adds_no_input_record() {
    let a = run(&parse(SQUARE).expect("the script reads")).expect("a run");
    for r in &a.bodies {
        println!(
            "{}: records at {:?} µs, {} B",
            r.name, r.records, r.record_bytes
        );
        let side: Vec<_> = r
            .records
            .iter()
            .filter(|&&t| t > 0 && t < 4_000_000)
            .collect();
        assert!(
            side.is_empty(),
            "{}: a record within the first side: {side:?}",
            r.name
        );
        // The start, three corners, the stop. The release changes nothing: the stopped body is already neutral.
        assert_eq!(r.records, [0, 4_000_000, 8_000_000, 12_000_000, 16_000_000]);
    }
}

/// A2: a second driver asking for a claimed resource is refused by name, and the first driver's input stands. A
/// body no driver holds has the neutral input and does not move.
#[test]
fn a2_a_second_driver_is_refused_by_name_and_the_first_input_stands() {
    let g = ground();
    let surfaces = BTreeMap::from([(ground_id(), ground())]);
    let mut c = Controller::new();
    let (dog, still) = (fixture(10), fixture(11));
    place(&mut c, &g, dog, quadruped(), 0, 0).unwrap();
    place(&mut c, &g, still, humanoid(), 5000, 5000).unwrap();
    let first = c
        .claim(dog, &script_shape())
        .expect("the script claims the legs");
    let v = Vec3::new(1_000_000, 0, 0);
    c.set(dog, first, Part::Velocity(v, Mode::Surface)).unwrap();

    let walk = SkillShape {
        name: name("souls:walk"),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: vec![],
        cancelled_by: vec![Class::Locomotion],
    };
    let second = c.claim(dog, &walk).expect_err("the legs are held");
    println!("second claim: {}: {}", second.name, second.detail);
    assert_eq!(second.name, "resource-held");
    // A driver with no claim on the legs cannot steer them either.
    let stray = c
        .set(dog, first + 1, Part::Velocity(Vec3::ZERO, Mode::Surface))
        .expect_err("not held");
    println!("unclaimed driver steers: {}: {}", stray.name, stray.detail);
    assert_eq!(stray.name, "resource-not-held");
    // A family with no hands has no hand move.
    let hand = c
        .set(
            dog,
            first,
            Part::Move(name("souls:hand-left"), Some(name("souls:wave"))),
        )
        .expect_err("no hands");
    assert_eq!(hand.name, "resource-missing");

    assert_eq!(
        c.input(dog).unwrap().velocity,
        v,
        "the first driver's input stands"
    );
    let still_at = c.body(still).unwrap().pose.position;
    for k in 0..20 {
        let s = c.step(&surfaces, TICK, k * TICK);
        assert!(s.refused.is_empty(), "{:?}", s.refused);
    }
    assert_eq!(
        c.body(dog).unwrap().pose.position.x,
        1_000_000,
        "1 m in 1 s at the first driver's velocity"
    );
    assert_eq!(
        c.body(still).unwrap().pose.position,
        still_at,
        "the neutral input moves nothing"
    );
}

/// A skill that steps once and asks for a velocity.
struct Go;

impl Skill for Go {
    fn shape(&self) -> SkillShape {
        SkillShape {
            name: name("souls:go"),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: vec![],
            cancelled_by: vec![],
        }
    }
    fn step(&mut self, host: &mut dyn Host) -> Progress {
        host.control(ControllerInput {
            velocity: Vec3::new(0, 0, 500_000),
            mode: Mode::Surface,
        });
        Progress::Going
    }
}

/// The seam: a skill's staged input reaches the body only through the controller, under its run's driver.
#[test]
fn a_skills_input_passes_through_the_controller_under_its_driver() {
    let g = ground();
    let mut c = Controller::new();
    let body = fixture(10);
    place(&mut c, &g, body, humanoid(), 0, 0).unwrap();
    let script = c.claim(body, &script_shape()).unwrap();
    let input = ControllerInput {
        velocity: Vec3::new(0, 0, 500_000),
        mode: Mode::Surface,
    };
    // A skill whose run was given no claim on the legs (driver 0 is never given) is refused; the body is unchanged.
    let mut staged = Staged::default();
    staged.controls.push((body, 0, input));
    let refused = hand_on(&staged, &mut c);
    println!("skill without the legs: {refused:?}");
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].1.name, "resource-not-held");
    assert_eq!(c.input(body).unwrap().velocity, Vec3::ZERO);
    // Once the script lets go and the skill claims the legs, its input is the body's.
    c.release(body, script).unwrap();
    let skill = c.claim(body, &Go.shape()).unwrap();
    let mut staged = Staged::default();
    staged.controls.push((body, skill, input));
    assert!(hand_on(&staged, &mut c).is_empty());
    assert_eq!(c.input(body).unwrap().velocity, input.velocity);
}

const KINDS: &str = include_str!("../../../crates/replica/fixtures/world-model/kinds.diag");
const WORLD: &str = "{1: [], 2: {}, 3: [
  {1: 1, 2: \"souls:place\"},
  {1: 2, 2: \"souls:room\", 3: 1},
  {1: 3, 2: \"souls:body\", 3: 2}
], 4: []}";

struct Nowhere;

impl Geometry for Nowhere {
    fn ask(&self, _: Id, _: &replica::host::Ask) -> Option<replica::host::Answer> {
        None
    }
}

/// A skill that tries to move its own body by a motion change, beside the controller.
struct Shove {
    said: Rc<RefCell<Option<Result<(), &'static str>>>>,
}

impl Skill for Shove {
    fn shape(&self) -> SkillShape {
        Go.shape()
    }
    fn step(&mut self, host: &mut dyn Host) -> Progress {
        let me = host.body();
        let pose = Pose {
            frame: Frame {
                node: me,
                slot: None,
            },
            position: Vec3::new(9_000_000, 0, 0),
            orientation: Quat::IDENTITY,
            support: Support::None,
        };
        let h = HandOff {
            node: me,
            at: 0,
            from: Owner::Mover,
            to: Owner::Mover,
            pose,
            linear: Vec3::ZERO,
            angular: Vec3::ZERO,
        };
        *self.said.borrow_mut() =
            Some(host.emit(vec![Change::Motion(h)], None).map_err(|r| r.name));
        Progress::Done
    }
}

/// A skill's motion change on its own body is a second movement path: refused by name, nothing staged.
#[test]
fn a_skills_motion_change_on_its_own_body_is_refused() {
    let kinds = parse_kinds(KINDS).expect("kinds");
    let draft = parse_world(&kinds, WORLD).expect("a world");
    let body = draft
        .nodes
        .iter()
        .find(|n| n.kind.starts_with("souls:body"))
        .unwrap()
        .id;
    let (tree, _) = Tree::load(&draft).expect("loads");
    let said = Rc::default();
    let mut runs = vec![Run {
        body,
        driver: 1,
        skill: Box::new(Shove {
            said: Rc::clone(&said),
        }),
    }];
    let staged = step(
        &tree,
        &Nowhere,
        0,
        1,
        &mut Minter::new(Scope([0x42; 16])),
        &mut runs,
    );
    println!(
        "skill emits a motion change on its body: {:?}",
        said.borrow()
    );
    assert_eq!(*said.borrow(), Some(Err("motion-outside-controller")));
    assert!(
        staged.emits.is_empty(),
        "nothing staged: {:?}",
        staged.emits
    );
}

/// #3244 A2: the controller writes each input record straight out; its bytes are those of encoding
/// [`sim::controller::Input::record`], and a body is logged exactly when its input differs from the one last logged.
/// 400 ticks of seeded inputs on two bodies (negative and wide numbers, every stance, moves, every kind of gaze), each
/// body touched every tick and often set to what it already had.
#[test]
fn a_logged_input_is_the_bytes_of_its_record_and_only_when_it_changed() {
    use replica::encode::encode;
    use sim::controller::{Gaze, Input, Stance};

    let g = ground();
    let surfaces = BTreeMap::from([(ground_id(), ground())]);
    let mut c = Controller::new();
    let bodies = [fixture(20), fixture(21)];
    place(&mut c, &g, bodies[0], humanoid(), 0, 0).unwrap();
    place(&mut c, &g, bodies[1], humanoid(), 3000, -3000).unwrap();
    let all = SkillShape {
        name: name("souls:all"),
        claims: vec![
            Want::All(Class::Locomotion),
            Want::All(Class::Manipulator),
            Want::All(Class::Gaze),
        ],
        blocks: vec![],
        cancelled_by: vec![],
    };
    let drivers = bodies.map(|b| c.claim(b, &all).expect("claimed"));
    // splitmix64, seeded: the test's own numbers.
    let mut seed = 3244u64;
    let mut draw = |n: u64| {
        seed = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = seed;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        (z ^ (z >> 31)) % n
    };
    let far = Id::new(Scope([0x7f; 16]), (1 << 53) - 1).unwrap();
    let mut last: BTreeMap<Id, Input> = BTreeMap::new();
    let (mut logged, mut unchanged) = (0, 0);
    for tick in 0..400i64 {
        for (b, d) in bodies.iter().zip(drivers) {
            let part = match draw(6) {
                // Few values, so a body is often set to what it has.
                0 => Part::Velocity(
                    Vec3::new(
                        (draw(3) as i64 - 1) * 400,
                        0,
                        -(draw(2) as i64) * 1_000_000_000_000,
                    ),
                    Mode::Surface,
                ),
                1 => Part::Facing(Quat::from_yaw_mdeg(draw(4) as i64 * -90_000).unwrap()),
                2 => Part::Stance([Stance::Stand, Stance::Sit, Stance::Lie][draw(3) as usize]),
                3 | 4 => {
                    let hand = ["souls:hand-left", "souls:hand-right"][draw(2) as usize];
                    let mv = ["souls:pour", "souls:press", "x"].get(draw(4) as usize);
                    Part::Move(name(hand), mv.map(|m| name(m)))
                }
                _ => Part::Gaze(match draw(4) {
                    0 => Gaze::Ahead,
                    1 => Gaze::Node(far),
                    2 => Gaze::Node(bodies[1]),
                    _ => Gaze::Point(Vec3::new(
                        -(draw(2) as i64) * 123_456_789,
                        24,
                        i64::MIN / 2,
                    )),
                }),
            };
            c.set(*b, d, part).expect("held");
        }
        let at = tick * TICK;
        let before = c.log().len();
        c.step(&surfaces, TICK, at);
        let new = &c.log()[before..];
        for b in bodies {
            let input = c.input(b).unwrap();
            let changed = last.get(&b) != Some(input);
            let rec = new.iter().find(|l| l.body == b);
            assert_eq!(rec.is_some(), changed, "tick {tick}: logged iff changed");
            if let Some(l) = rec {
                assert_eq!(l.at, at);
                assert_eq!(
                    l.bytes,
                    encode(&input.record(at, b)).unwrap(),
                    "tick {tick}: the bytes of the record"
                );
                last.insert(b, input.clone());
                logged += 1;
            } else {
                unchanged += 1;
            }
        }
    }
    println!(
        "A2: {logged} records logged, each the bytes of its record; {unchanged} unchanged inputs not logged"
    );
    assert!(logged > 200 && unchanged > 100, "both cases covered");
}
