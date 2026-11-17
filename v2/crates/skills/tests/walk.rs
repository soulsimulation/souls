//! A1 of Engine v2 T9 (#2663; `v2/docs/bodies.md`): one toy walk skill runs unchanged on a four-legged, handless family
//! and on a humanoid, against a fake host.

use std::collections::BTreeMap;

use replica::bodies::{Body, Family};
use replica::effects::{Change, Refusal, fixture_bytes};
use replica::encode::{Name, Value, decode};
use replica::host::{Ask, Control, Host, Progress, Seen, Skill};
use replica::ids::{Id, Scope};
use replica::pose::Vec3;
use replica::time::Micros;
use skills::walk::Walk;

const FAMILIES: &str = include_str!("../../replica/fixtures/bodies/families.diag");

fn families() -> Vec<Family> {
    let v = decode(&fixture_bytes(FAMILIES).expect("bytes"))
        .expect("decodes")
        .value;
    let Value::Array(fs) = v else {
        panic!("a list")
    };
    fs.iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .collect()
}

/// A fake host: one body on open ground, moved by its controller at 20 ticks a second; no other node.
struct Fake {
    body: Id,
    at: Vec3,
    now: Micros,
    inputs: Vec<Control>,
}

impl Host for Fake {
    fn now(&self) -> Micros {
        self.now
    }
    fn body(&self) -> Id {
        self.body
    }
    fn read(&self, node: Id) -> Option<Seen> {
        (node == self.body).then(|| Seen {
            id: node,
            kind: Name::new("souls:body").expect("a name"),
            parent: None,
            position: self.at,
            fields: BTreeMap::new(),
        })
    }
    fn ask(&self, q: &Ask) -> Option<Vec3> {
        match q {
            Ask::Toward { to, .. } => Some(*to),
            Ask::Distance { .. } => None,
        }
    }
    fn set_timer(&mut self, _after: Micros, _name: Name) -> Id {
        self.body
    }
    fn draw(&mut self) -> u64 {
        4
    }
    fn control(&mut self, input: Control) {
        let dt = 50_000;
        self.at.x += input.velocity.x * dt / 1_000_000;
        self.at.y += input.velocity.y * dt / 1_000_000;
        self.at.z += input.velocity.z * dt / 1_000_000;
        self.inputs.push(input);
    }
    fn emit(&mut self, _change: Change) -> Result<(), Refusal> {
        Ok(())
    }
}

#[test]
fn a1_one_toy_walk_runs_unchanged_on_a_quadruped_and_a_humanoid() {
    let to = Vec3 {
        x: 3_000_000,
        y: 0,
        z: 4_000_000,
    };
    for family in families() {
        let mut body = Body::new(family.clone());
        let mut walk = Walk { to };
        let started = body.start(1, &walk.shape()).expect("the walk starts");
        let mut host = Fake {
            body: Id::new(Scope([0xee; 16]), 2).expect("an id"),
            at: Vec3 { x: 0, y: 0, z: 0 },
            now: 0,
            inputs: Vec::new(),
        };
        let mut steps = 0;
        let end = loop {
            steps += 1;
            match walk.step(&mut host) {
                Progress::Going if steps < 1_000 => host.now += 50_000,
                other => break other,
            }
        };
        let released = body.end(1);
        let names: Vec<&str> = started.holds.iter().map(Name::as_str).collect();
        println!(
            "{}: the walk held {names:?}, ended {end:?} after {steps} steps at ({}, {}) um, released {}",
            family.name.as_str(),
            host.at.x,
            host.at.z,
            released.len()
        );
        assert_eq!(end, Progress::Done);
        assert!((host.at.x - to.x).abs() <= 60_000 && (host.at.z - to.z).abs() <= 60_000);
        assert_eq!(released, started.holds);
        assert!(body.running.is_empty());
    }
}
