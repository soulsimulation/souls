//! Bodies as resources and skills as claims (Engine v2 T9, #2663; `v2/docs/bodies.md`): two skills run at once on one
//! body, a third claiming a held resource is refused by name, a joint activity claims all or none, and the hatch's
//! shape reads from its fixture. The toy walk on two families, the compile wall and the scan are in
//! `v2/crates/skills/tests`.

use replica::bodies::{Body, Class, Family, SkillShape, Want, start_joint};
use replica::effects::fixture_bytes;
use replica::encode::{Name, Value, decode};
use replica::host::{Answers, Hatch, Read};

const FAMILIES: &str = include_str!("../fixtures/bodies/families.diag");
const HATCH: &str = include_str!("../fixtures/bodies/hatch.diag");

fn value(text: &str) -> Value {
    decode(&fixture_bytes(text).expect("bytes"))
        .expect("decodes")
        .value
}

fn families() -> (Family, Family) {
    let Value::Array(fs) = value(FAMILIES) else {
        panic!("a list")
    };
    let f: Vec<Family> = fs
        .iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .collect();
    (f[0].clone(), f[1].clone())
}

fn name(t: &str) -> Name {
    Name::new(t).expect("a name")
}

fn shape(n: &str, claims: Vec<Want>, blocks: Vec<Class>, cancelled_by: Vec<Class>) -> SkillShape {
    SkillShape {
        name: name(n),
        claims,
        blocks,
        cancelled_by,
    }
}

fn show(h: &[Name]) -> Vec<String> {
    h.iter().map(|n| n.as_str().to_owned()).collect()
}

fn walk() -> SkillShape {
    shape(
        "souls:walk",
        vec![Want::All(Class::Locomotion)],
        vec![],
        vec![],
    )
}

fn talk() -> SkillShape {
    shape("souls:talk", vec![Want::One(Class::Voice)], vec![], vec![])
}

fn carry() -> SkillShape {
    shape(
        "souls:carry",
        vec![Want::One(Class::Manipulator)],
        vec![],
        vec![],
    )
}

#[test]
fn a2_two_skills_run_at_once_and_a_third_on_a_held_resource_is_refused_by_name() {
    let (quadruped, humanoid) = families();
    let mut body = Body::new(humanoid);
    let w = body.start(1, &walk()).expect("walk");
    let t = body.start(2, &talk()).expect("talk");
    let c = body.start(3, &carry()).expect("carry");
    println!(
        "humanoid: walk holds {:?}, talk {:?}, carry {:?}, all at once",
        show(&w.holds),
        show(&t.holds),
        show(&c.holds)
    );
    let refused = body.start(4, &walk()).map_err(|r| (r.name, r.detail));
    println!("a second walk: {refused:?}");
    assert_eq!(refused.as_ref().map_err(|r| r.0), Err("resource-held"));
    assert_eq!(body.running.len(), 3, "a refusal changes nothing");
    // A second carry takes the other hand; a third finds both held.
    assert!(body.start(5, &carry()).is_ok());
    assert_eq!(
        body.start(6, &carry()).map_err(|r| r.name),
        Err("resource-held")
    );
    // Ending always releases.
    assert_eq!(
        show(&body.end(1)),
        vec!["souls:leg-left", "souls:leg-right"]
    );
    assert!(body.start(4, &walk()).is_ok());

    // A handless family cannot carry, by name; a sit that blocks walking refuses it; a walk cancelled by a new walk.
    let mut dog = Body::new(quadruped);
    let missing = dog.start(1, &carry()).map_err(|r| r.name);
    println!("quadruped carries: {missing:?}");
    assert_eq!(missing, Err("resource-missing"));
    let sit = shape(
        "souls:sit",
        vec![Want::One(Class::Gaze)],
        vec![Class::Locomotion],
        vec![],
    );
    dog.start(2, &sit).expect("sit");
    assert_eq!(
        dog.start(3, &walk()).map_err(|r| r.name),
        Err("resource-blocked")
    );
    dog.end(2);
    let steer = shape(
        "souls:steer",
        vec![Want::All(Class::Locomotion)],
        vec![],
        vec![Class::Locomotion],
    );
    dog.start(3, &steer).expect("steer");
    let again = dog.start(4, &walk()).expect("a new walk cancels the steer");
    assert_eq!(again.cancelled, vec![3]);
    assert!(!dog.running.contains_key(&3));
}

#[test]
fn a_joint_activity_claims_on_several_bodies_all_or_none() {
    let (quadruped, humanoid) = families();
    let (mut a, mut b) = (Body::new(humanoid.clone()), Body::new(humanoid));
    let lift = shape(
        "souls:lift",
        vec![Want::All(Class::Manipulator)],
        vec![],
        vec![],
    );
    let started = start_joint(&mut [(&mut a, 1, &lift), (&mut b, 1, &lift)]).expect("both lift");
    assert_eq!(started.len(), 2);
    let (mut c, mut d) = (Body::new(families().1), Body::new(quadruped));
    let refused =
        start_joint(&mut [(&mut c, 1, &lift), (&mut d, 1, &lift)]).map_err(|r| (r.name, r.detail));
    println!("a humanoid and a quadruped lift together: {refused:?}");
    assert_eq!(refused.map_err(|r| r.0), Err("resource-missing"));
    assert!(c.running.is_empty(), "none: the humanoid took nothing");
}

#[test]
fn the_hatch_shape_reads_from_its_fixture_and_refuses_by_name() {
    let h = Hatch::from_value(&value(HATCH)).expect("a hatch");
    println!(
        "hatch: module {} bytes, reads {:?}, at most {} steps, answers {:?}, why {}",
        h.module.len(),
        h.reads,
        h.steps_most,
        h.answers,
        h.why.as_str()
    );
    assert_eq!(
        h.reads,
        vec![Read::Field(1), Read::Argument(name("souls:move"))]
    );
    assert_eq!(h.answers, Answers::Verdict);
    let Value::Map(m) = value(HATCH) else {
        panic!("a map")
    };
    for (field, bad, want) in [
        (2, Value::Array(vec![]), "hatch-reads-nothing"),
        (3, Value::Uint(2_000_000), "hatch-steps-over-limit"),
        (1, Value::Bytes(vec![1, 2, 3]), "hatch-module-not-hash"),
    ] {
        let mut m = m.clone();
        m.insert(field, bad);
        assert_eq!(
            Hatch::from_value(&Value::Map(m)).map_err(|r| r.name),
            Err(want)
        );
    }
    // Two resources of one name in a family are refused.
    let dup = value("{1: \"souls:odd\", 2: [{1: \"souls:leg\", 2: 1}, {1: \"souls:leg\", 2: 1}]}");
    assert_eq!(
        Family::from_value(&dup).map_err(|r| r.name),
        Err("resource-duplicate")
    );
}
