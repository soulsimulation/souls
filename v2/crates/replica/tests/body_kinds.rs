//! Bodies someone authored, as kind data (Engine v2 B13, #2744). The two fixtures are what `v2/tools/import-body`
//! wrote for Pip and the ghost from today's authoring kit: they load as family kinds with a hash, a size class that is
//! the class their measured footprint takes, their resources, actions and two models by hash. A physical action not
//! declared is refused by name; a section 13 that is not a body, or on a thing, is refused.

use replica::bodies::Class;
use replica::encode::Value;
use replica::kinds::body::Decl;
use replica::kinds::sizes::{Build, Size};
use replica::kinds::{KindDef, Kinds};

const PIP: &str = include_str!("../fixtures/bodies/pip_the_rolling_robot.diag");
const GHOST: &str = include_str!("../fixtures/bodies/wisp_the_ghost.diag");

fn radius(k: &KindDef) -> i64 {
    let f = k.state.values().find(|f| f.name.as_str() == "radius");
    match &f.expect("a radius field").default {
        Value::Uint(v) => i64::try_from(*v).unwrap(),
        v => panic!("{v:?}"),
    }
}

#[test]
fn a1_authored_bodies_load_with_hash_size_and_resources() {
    let mut kinds = Kinds::default();
    let loaded = kinds.load(&[("pip.diag", PIP), ("ghost.diag", GHOST)]);
    assert_eq!(loaded.len(), 2, "{:?}", kinds.refused());
    for name in loaded.iter().map(|n| n.as_str()) {
        let k = kinds.get(name).unwrap();
        let build = Build::of(k).expect("B12's build");
        let r = radius(k);
        assert_eq!(
            Size::for_radius(r).unwrap(),
            build.size,
            "{name}: a {r} mm footprint"
        );
        let body = Decl::of(k).expect("a body section");
        assert!(body.full.as_str().starts_with("sha256:"));
        assert!(body.simple.as_str().starts_with("sha256:"));
        assert!(
            body.family
                .resources
                .iter()
                .any(|x| x.class == Class::Locomotion)
        );
        assert!(body.check("go").is_ok());
        assert_eq!(body.check("sit").unwrap_err().name, "action-undeclared");
        println!(
            "{name}: size {} (radius {r} mm), height {} mm, hover {} mm, {} resources, {} actions, full {}, simple {}",
            build.size.name(),
            build.height_mm,
            build.hover_mm,
            body.family.resources.len(),
            body.actions.len(),
            body.full.as_str(),
            body.simple.as_str()
        );
    }
    let pip = Decl::of(kinds.get(loaded[0].as_str()).unwrap()).unwrap();
    let hands = pip
        .family
        .resources
        .iter()
        .filter(|x| x.class == Class::Manipulator);
    assert_eq!(
        hands.map(|x| x.slot).collect::<Vec<_>>(),
        [Some(1), Some(2)]
    );
    let ghost = Decl::of(kinds.get(loaded[1].as_str()).unwrap()).unwrap();
    assert!(ghost.check("pick-up").is_err(), "the ghost has no hands");
}

#[test]
fn a_bad_body_section_is_refused_by_name() {
    let thing = r#"{1: "test:rock", 2: "thing", 13: {1: [{1: "a", 2: 1}], 2: ["go"], 3: "sha256:a", 4: "sha256:b"}}"#;
    let class = r#"{1: "test:odd", 2: "family", 13: {1: [{1: "a", 2: 9}], 2: ["go"], 3: "sha256:a", 4: "sha256:b"}}"#;
    let model = r#"{1: "test:bare", 2: "family", 13: {1: [{1: "a", 2: 1}], 2: ["go"], 3: "a", 4: "sha256:b"}}"#;
    let mut kinds = Kinds::default();
    let loaded = kinds.load(&[
        ("thing.diag", thing),
        ("class.diag", class),
        ("model.diag", model),
    ]);
    assert!(loaded.is_empty());
    for e in kinds.refused() {
        println!("{e}");
        assert_eq!((e.name, e.section), ("kind-body", Some(13)));
    }
    assert_eq!(kinds.refused().len(), 3);
}
