//! Engine v2 K13a (#2676): the world's side of the host interface (`sim::host`). T9's toy walk is stepped by the
//! world host and its controller input is handed on, staged; and an emit by one skill is not visible to another
//! skill, nor to itself, in the same tick (A5).

use std::cell::RefCell;
use std::rc::Rc;

use replica::bodies::SkillShape;
use replica::effects::Change;
use replica::encode::{Name, Value};
use replica::host::{Answer, Ask, Host, Progress, Skill};
use replica::ids::{Id, Minter, Scope};
use replica::pose::Vec3;
use replica::tree::Tree;
use replica::world_model::{parse_kinds, parse_world};
use sim::host::{Geometry, Run, step};
use skills::walk::{SPEED, Walk};

const KINDS: &str = include_str!("../../replica/fixtures/world-model/kinds.diag");
/// A room under the place, two bodies in it.
const WORLD: &str = "{1: [], 2: {}, 3: [
  {1: 1, 2: \"souls:place\"},
  {1: 2, 2: \"souls:room\", 3: 1},
  {1: 3, 2: \"souls:body\", 3: 2},
  {1: 4, 2: \"souls:body\", 3: 2}
], 4: []}";

/// The tree and its two bodies, in id order.
fn world() -> (Tree, [Id; 2]) {
    let kinds = parse_kinds(KINDS).expect("kinds");
    let draft = parse_world(&kinds, WORLD).expect("a world");
    let mut bodies: Vec<Id> = draft
        .nodes
        .iter()
        .filter(|n| n.kind.starts_with("souls:body"))
        .map(|n| n.id)
        .collect();
    bodies.sort();
    let (tree, _) = Tree::load(&draft).expect("loads");
    (tree, [bodies[0], bodies[1]])
}

/// Open ground: the way toward a point is the point.
struct Open;

impl Geometry for Open {
    fn ask(&self, _body: Id, q: &Ask) -> Option<Answer> {
        match q {
            Ask::Toward { to, .. } => Some(Answer::Point(*to)),
            Ask::Distance { .. } | Ask::Near { .. } => None,
        }
    }
}

fn minter() -> Minter {
    Minter::new(Scope([0x4b; 16]))
}

fn name(t: &str) -> Name {
    Name::new(t).expect("a name")
}

#[test]
fn the_toy_walk_is_stepped_by_the_world_host_and_its_input_handed_on() {
    let (tree, [a, _]) = world();
    let to = Vec3::new(3_000_000, 0, 4_000_000);
    let mut runs = vec![Run {
        body: a,
        driver: 1,
        skill: Box::new(Walk { to }),
    }];
    let staged = step(&tree, &Open, 50_000, 7, &mut minter(), &mut runs);
    println!(
        "controls {:?}, ended {:?}, calls {}",
        staged.controls, staged.ended, staged.calls
    );
    assert_eq!(runs.len(), 1, "the walk is still going");
    assert!(staged.ended.is_empty());
    let [(body, _, input)] = staged.controls.as_slice() else {
        panic!("one input: {:?}", staged.controls)
    };
    assert_eq!(*body, a);
    // 3-4-5: toward the point at the walk's speed.
    assert_eq!(input.velocity, Vec3::new(SPEED * 3 / 5, 0, SPEED * 4 / 5));
    // body, read, ask, control.
    assert_eq!(staged.calls, 4);
}

/// What the test skills saw.
type Log = Rc<RefCell<Vec<String>>>;

/// Sets field 7 of its own body, tries to set the other body's, then reads its own.
struct Writer {
    other: Id,
    log: Log,
}

/// Reads the other body's field 7.
struct Reader {
    other: Id,
    log: Log,
}

fn shape() -> SkillShape {
    SkillShape {
        name: name("test:probe"),
        claims: Vec::new(),
        blocks: Vec::new(),
        cancelled_by: Vec::new(),
    }
}

fn set(node: Id) -> Vec<Change> {
    vec![Change::Set {
        node,
        field: 7,
        to: Value::Uint(1),
        by: None,
    }]
}

impl Skill for Writer {
    fn shape(&self) -> SkillShape {
        shape()
    }
    fn step(&mut self, host: &mut dyn Host) -> Progress {
        let me = host.body();
        let mut log = self.log.borrow_mut();
        log.push(format!("writer emits own: {:?}", host.emit(set(me), None)));
        let other = host.emit(set(self.other), None).map_err(|r| r.name);
        log.push(format!("writer emits other's: {other:?}"));
        let seen = host.read(me).and_then(|s| s.fields.get(&7).cloned());
        log.push(format!("writer reads own field 7: {seen:?}"));
        Progress::Done
    }
}

impl Skill for Reader {
    fn shape(&self) -> SkillShape {
        shape()
    }
    fn step(&mut self, host: &mut dyn Host) -> Progress {
        let seen = host
            .read(self.other)
            .and_then(|s| s.fields.get(&7).cloned());
        self.log
            .borrow_mut()
            .push(format!("reader reads writer's field 7: {seen:?}"));
        Progress::Done
    }
}

#[test]
fn a5_an_emit_is_not_visible_to_another_skill_in_the_same_tick() {
    let (tree, [a, b]) = world();
    let log: Log = Rc::default();
    // The reader is listed first; the world steps by body id, so the writer (the lower id) steps before it.
    let mut runs = vec![
        Run {
            body: b,
            driver: 1,
            skill: Box::new(Reader {
                other: a,
                log: log.clone(),
            }),
        },
        Run {
            body: a,
            driver: 2,
            skill: Box::new(Writer {
                other: b,
                log: log.clone(),
            }),
        },
    ];
    let staged = step(&tree, &Open, 50_000, 7, &mut minter(), &mut runs);
    let log = log.borrow();
    for l in log.iter() {
        println!("{l}");
    }
    assert_eq!(
        *log,
        [
            "writer emits own: Ok(())",
            "writer emits other's: Err(\"write-outside-own\")",
            "writer reads own field 7: None",
            "reader reads writer's field 7: None",
        ]
    );
    // The emit is held for after the phase: one entry, on the writer's own body.
    assert_eq!(staged.emits.len(), 1);
    assert_eq!(staged.emits[0].body, a);
    assert_eq!(staged.emits[0].changes, set(a));
    assert_eq!(
        staged.ended,
        [(a, Progress::Done), (b, Progress::Done)],
        "both ended, in body order"
    );
    assert!(runs.is_empty());
}
