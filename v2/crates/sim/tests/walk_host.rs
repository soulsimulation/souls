//! Engine v2 T9b (#3120): N7's walk through the host. The walk skill (`skills::route`) touches the world only through
//! `Host`; the world answers through K13a's host (`sim::host`), and the controller is the body's one mover: it steps
//! the walk's inputs and carries the body across each link. On N2's test world, the walker of N7's A3 walks from the
//! south room of the ground floor to the north-east room upstairs, through three shut doors (one narrow, taken in
//! turns) and the stair; and two walkers head-on on the open ground pass apart, kept apart by `Ask::Near`.

use std::cell::RefCell;
use std::collections::BTreeMap;

use import_eden::Import;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Actor, Cause, Change, Header, Refusal, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::host::Skill as _;
use replica::host::{Answer, Ask, F_CROSSING, F_WAITING, Seen};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{parse_kinds, parse_world, show};
use sim::controller::Controller;
use sim::host::{Geometry, Run, carry, hand_on, step};
use sim::links::{DOOR_OPENED, Doors};
use sim::mover::Body;
use sim::walk::town::Town;
use sim::walk::{Mark, World, node_of};
use skills::route::{Leg, Route};

const SPEED: i64 = 1_400_000;
const TICK: Micros = 50_000;

fn id(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

fn name(t: &str) -> Name {
    Name::new(t).unwrap()
}

fn town() -> (Town, BTreeMap<String, Id>) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/walk-host-test/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).unwrap()).unwrap();
    let next = tree.to_state().next;
    let ground = nodes["ground"];
    let t = Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town");
    (t, nodes)
}

fn humanoid() -> Family {
    let r = |n: &str, class| Resource {
        name: name(n),
        class,
        slot: None,
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![
            r("souls:leg-left", Class::Locomotion),
            r("souls:leg-right", Class::Locomotion),
        ],
    }
}

/// An empty tree for the host's own reads: the walk reads bodies and links, which the world answers (A3).
fn empty() -> Tree {
    let kinds = parse_kinds(include_str!(
        "../../replica/fixtures/world-model/kinds.diag"
    ))
    .unwrap();
    let draft = parse_world(
        &kinds,
        "{1: [], 2: {}, 3: [{1: 1, 2: \"souls:place\"}], 4: []}",
    )
    .unwrap();
    Tree::load(&draft).unwrap().0
}

/// The world as the host asks it: the town's answers, every body as the controller holds it at the tick's start, the
/// fields a body's own entries set (its waiting mark), and a link's turn state.
struct Here<'a> {
    town: &'a RefCell<Town>,
    bodies: &'a Controller,
    fields: &'a BTreeMap<Id, BTreeMap<u64, Value>>,
}

impl Geometry for Here<'_> {
    fn ask(&self, body: Id, q: &Ask) -> Option<Answer> {
        self.town.borrow_mut().answer(self.bodies, body, q)
    }
    fn read(&self, node: Id) -> Option<Seen> {
        let Some(b) = self.bodies.body(node) else {
            return self.town.borrow().read_link(node);
        };
        let mut fields = self.fields.get(&node).cloned().unwrap_or_default();
        if let Some(l) = self.bodies.carrying(node) {
            fields.insert(F_CROSSING, l.to_value());
        }
        Some(Seen {
            id: node,
            kind: name("souls:body"),
            parent: Some(node_of(b)),
            position: b.pose.position,
            fields,
        })
    }
}

/// A world of walkers run a tick at a time through the host.
struct Walk {
    town: RefCell<Town>,
    controller: Controller,
    fields: BTreeMap<Id, BTreeMap<u64, Value>>,
    runs: Vec<Run>,
    now: Micros,
    tree: Tree,
    minter: Minter,
    /// When each walker's run ended, and how.
    ended: BTreeMap<Id, (Micros, String)>,
    /// The fewest µm between two walkers on one node, over the run.
    nearest: i64,
    /// Every waiting mark a walker set on its own body: who, and the value.
    marked: Vec<(Id, Value)>,
}

impl Walk {
    fn new(town: Town) -> Walk {
        Walk {
            town: RefCell::new(town),
            controller: Controller::new(),
            fields: BTreeMap::new(),
            runs: Vec::new(),
            now: 0,
            tree: empty(),
            minter: Minter::new(Scope([0x9b; 16])),
            ended: BTreeMap::new(),
            nearest: i64::MAX,
            marked: Vec::new(),
        }
    }

    /// A walker standing at `at` on `node`, walking to `goal` on `to`: its legs planned by the world for the intent.
    fn add(&mut self, who: Id, node: Id, at: Vec3, to: Id, goal: Vec3) -> Vec<Leg> {
        let mut t = self.town.borrow_mut();
        let body: Body = t.surfaces[&node]
            .place(who, Frame { node, slot: None }, at, Quat::IDENTITY)
            .unwrap();
        let legs: Vec<Leg> = World::plan(&mut *t, &body, to, goal)
            .unwrap()
            .into_iter()
            .map(|l| Leg {
                to: l.to,
                link: l.link,
            })
            .collect();
        self.controller.add(humanoid(), body).unwrap();
        let skill = Route::new(legs.clone(), SPEED, TICK);
        let driver = self.controller.claim(who, &skill.shape()).unwrap();
        self.runs.push(Run {
            body: who,
            driver,
            skill: Box::new(skill),
        });
        legs
    }

    fn tick(&mut self) {
        let at = self.now + TICK;
        // The owners of the links taken in turns read the walkers' marks as of the last tick (N8, A3).
        let marks: Vec<Mark> = self
            .controller
            .bodies()
            .map(|b| Mark {
                who: b.id,
                node: node_of(b),
                at: b.pose.position,
                waiting: self
                    .fields
                    .get(&b.id)
                    .and_then(|f| match f.get(&F_WAITING) {
                        Some(Value::Array(a)) if a.len() == 2 => Some((
                            replica::effects::read_id(&a[0]).unwrap(),
                            match a[1] {
                                Value::Uint(u) => u as i64,
                                _ => 0,
                            },
                        )),
                        _ => None,
                    }),
                crossing: self.controller.carrying(b.id),
                staying: false,
            })
            .collect();
        self.town.get_mut().turns(&marks, at).unwrap();
        let staged = {
            let here = Here {
                town: &self.town,
                bodies: &self.controller,
                fields: &self.fields,
            };
            step(
                &self.tree,
                &here,
                self.now,
                1,
                &mut self.minter,
                &mut self.runs,
            )
        };
        let refused = hand_on(&staged, &mut self.controller);
        assert!(refused.is_empty(), "inputs refused: {refused:?}");
        let refused = carry(&staged, &mut self.controller, self.town.get_mut(), at);
        assert!(refused.is_empty(), "crossings refused: {refused:?}");
        // The tick's end: each walker's own entries (its mark) apply.
        for e in &staged.emits {
            for c in &e.changes {
                if let Change::Set {
                    node, field, to, ..
                } = c
                {
                    if *field == F_WAITING {
                        self.marked.push((*node, to.clone()));
                    }
                    self.fields
                        .entry(*node)
                        .or_default()
                        .insert(*field, to.clone());
                }
            }
        }
        for (who, p) in &staged.ended {
            self.ended.insert(*who, (self.now, format!("{p:?}")));
        }
        let stepped = self.controller.step(&self.town.borrow().surfaces, TICK, at);
        assert!(
            stepped.refused.is_empty(),
            "steps refused: {:?}",
            stepped.refused
        );
        self.now = at;
        let bodies: Vec<&Body> = self.controller.bodies().collect();
        for (i, a) in bodies.iter().enumerate() {
            for b in &bodies[i + 1..] {
                if node_of(a) == node_of(b) {
                    let (p, q) = (a.pose.position, b.pose.position);
                    let d = (i128::from(p.x - q.x).pow(2) + i128::from(p.z - q.z).pow(2)).isqrt()
                        as i64;
                    self.nearest = self.nearest.min(d);
                }
            }
        }
    }

    fn run(&mut self, ticks: u64) {
        for _ in 0..ticks {
            if self.runs.is_empty() {
                break;
            }
            self.tick();
        }
    }
}

/// A2: N7's A3 walk through the host. The walker arrives upstairs; each shut door on its way is opened by the world,
/// once, the walker as the acting Soul; the controller carried it across every link.
#[test]
fn a2_the_walk_skill_through_the_host_crosses_three_shut_doors_and_the_stair() {
    let (t, nodes) = town();
    let (f0, f1) = (nodes["building/floor-0"], nodes["building/floor-1"]);
    let goal = {
        let h = t.tree.handle(nodes["building/r1d"]).unwrap();
        t.tree.node(h).unwrap().place().unwrap().position
    };
    let mut w = Walk::new(t);
    let me = id(1);
    let legs = w.add(me, f0, Vec3::new(0, 0, -3_000_000), f1, goal);
    println!("legs:");
    for l in &legs {
        println!(
            "  to ({}, {}, {}) mm{}",
            l.to.x / 1000,
            l.to.y / 1000,
            l.to.z / 1000,
            l.link
                .map(|k| format!(", then cross {}", show(k)))
                .unwrap_or_default()
        );
    }
    w.run(4_000);
    let (at, how) = w.ended.get(&me).cloned().expect("the walk ends");
    let b = *w.controller.body(me).unwrap();
    let p = b.pose.position;
    println!(
        "ended {how} at {} ms ({} ticks), at ({}, {}, {}) mm on {}",
        at / 1000,
        at / TICK,
        p.x / 1000,
        p.y / 1000,
        p.z / 1000,
        show(node_of(&b))
    );
    assert_eq!(how, "Done");
    assert_eq!(node_of(&b), f1, "upstairs");
    let t = w.town.borrow();
    let mut opened = Vec::new();
    for e in &t.doors.stream {
        let ev = &e.events.as_ref().unwrap()[0];
        let link = replica::effects::read_id(&ev.fields[&1]).unwrap();
        println!(
            "  #{} at {} us: {} on door {} of link {}, cause {:?}, actor {:?}",
            e.envelope.sequence,
            e.envelope.at,
            ev.name.as_str(),
            show(e.envelope.node),
            show(link),
            e.envelope.cause,
            e.envelope.actor
        );
        assert_eq!(ev.name.as_str(), DOOR_OPENED);
        assert_eq!(e.envelope.cause, Cause::World, "the world opens it");
        assert_eq!(e.envelope.actor, Actor::Soul(me), "for the walker");
        opened.push(link);
    }
    let doors: Vec<Id> = legs
        .iter()
        .filter_map(|l| l.link)
        .filter(|k| {
            t.buildings
                .iter()
                .any(|b| b.link(*k).is_some_and(|l| l.door.is_some()))
        })
        .collect();
    assert_eq!(
        opened, doors,
        "one opening per shut door, in the order crossed"
    );
    assert_eq!(opened.len(), 3);
    // A3: the narrow door is taken in turns through fields. The walker marked itself waiting on its own body, and the
    // link's owner let it in by the link's field, read through the host.
    let narrow: Vec<Id> = legs
        .iter()
        .filter_map(|l| l.link)
        .filter(|k| t.read_link(*k).is_some())
        .collect();
    println!(
        "narrow links {:?}; marks set {}, first {:?}",
        narrow.iter().map(|k| show(*k)).collect::<Vec<_>>(),
        w.marked.len(),
        w.marked.first()
    );
    assert_eq!(
        narrow.len(),
        2,
        "the stair and the narrow door are taken in turns"
    );
    assert!(
        w.marked
            .iter()
            .any(|(who, v)| *who == me && matches!(v, Value::Array(a) if a.len() == 2))
    );
    assert!(
        w.marked
            .last()
            .is_some_and(|(_, v)| *v == Value::Array(Vec::new())),
        "the mark is cleared when it crosses"
    );
    for k in &narrow {
        let l = t.buildings.iter().find_map(|b| b.link(*k)).unwrap();
        let timeline = &t.turns.as_ref().unwrap().state(l).unwrap().timeline;
        println!("{}'s timeline: {timeline:?}", show(*k));
        assert!(
            timeline
                .iter()
                .any(|e| matches!(e, sim::links::turns::Turn::Grant { who, .. } if *who == me)),
            "its owner let the walker in"
        );
    }
}

/// A1 (keeping apart): two walkers head-on along one line on the open ground pass apart; each sees the other only
/// through `Ask::Near`.
#[test]
fn a1_two_walkers_head_on_pass_apart_through_ask_near() {
    let (t, nodes) = town();
    let ground = nodes["ground"];
    let mut w = Walk::new(t);
    let (a, b) = (id(1), id(2));
    let (west, east) = (
        Vec3::new(-40_000_000, 0, 30_000_000),
        Vec3::new(-30_000_000, 0, 30_000_000),
    );
    w.add(a, ground, west, ground, east);
    w.add(b, ground, east, ground, west);
    w.run(400);
    println!("ended: {:?}; nearest {} mm", w.ended, w.nearest / 1000);
    assert_eq!(w.ended.len(), 2, "both arrive");
    assert!(w.ended.values().all(|(_, h)| h == "Done"));
    assert!(
        w.nearest >= 420_000,
        "they pass apart: nearest {} µm",
        w.nearest
    );
}

/// A skill cannot move its own body into another frame by an entry: `reparent-outside-controller`, beside
/// `motion-outside-controller` (B1's known limit), and nothing is staged.
#[test]
fn a_reparent_of_its_own_body_is_refused() {
    use replica::host::{Host, Progress, Skill};
    use replica::pose::{Pose, Support};
    use std::rc::Rc;
    type Said = Rc<RefCell<Option<Result<(), &'static str>>>>;
    struct Hop(Said);
    impl Skill for Hop {
        fn shape(&self) -> replica::bodies::SkillShape {
            replica::bodies::SkillShape {
                name: name("test:hop"),
                claims: Vec::new(),
                blocks: Vec::new(),
                cancelled_by: Vec::new(),
            }
        }
        fn step(&mut self, host: &mut dyn Host) -> Progress {
            let me = host.body();
            let frame = |n| Frame {
                node: id(n),
                slot: None,
            };
            let pose = Pose {
                frame: frame(3),
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::None,
            };
            let r = host.emit(
                vec![Change::Reparent {
                    node: me,
                    from: frame(2),
                    pose,
                }],
                None,
            );
            *self.0.borrow_mut() = Some(r.map_err(|e: Refusal| e.name));
            Progress::Done
        }
    }
    let said: Said = Rc::default();
    let mut runs = vec![Run {
        body: id(9),
        driver: 1,
        skill: Box::new(Hop(said.clone())),
    }];
    struct Nowhere;
    impl Geometry for Nowhere {
        fn ask(&self, _: Id, _: &Ask) -> Option<Answer> {
            None
        }
    }
    let staged = step(
        &empty(),
        &Nowhere,
        0,
        1,
        &mut Minter::new(Scope([1; 16])),
        &mut runs,
    );
    println!("reparent own body: {:?}", said.borrow());
    assert_eq!(*said.borrow(), Some(Err("reparent-outside-controller")));
    assert!(staged.emits.is_empty());
}
