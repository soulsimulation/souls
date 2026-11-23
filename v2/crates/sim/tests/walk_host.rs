//! Engine v2 T9b (#3120): N7's walk through the host. The walk skill (`skills::route`) touches the world only through
//! `Host`; the world answers through K13a's host (`sim::host`, run by its `Runner`, T9c #3127), and the controller is
//! the body's one mover: it steps the walk's inputs and carries the body across each link. On N2's test world, the
//! walker of N7's A3 walks from the south room of the ground floor to the north-east room upstairs, through three shut
//! doors (one narrow, taken in turns) and the stair; and two walkers head-on on the open ground pass apart, kept apart
//! by `Ask::Near`.

mod common;

use std::cell::RefCell;
use std::collections::BTreeMap;

use replica::effects::{Actor, Cause, Change, Refusal};
use replica::encode::{Name, Value};
use replica::host::{Answer, Ask, F_WAITING};
use replica::ids::{Id, Minter, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{parse_kinds, parse_world, show};
use sim::host::{Geometry, Run, Runner, step};
use sim::links::DOOR_OPENED;
use sim::mover::Body;
use sim::walk::node_of;
use sim::walk::town::Town;
use skills::route::Leg;

const SPEED: i64 = 1_400_000;
const TICK: Micros = 50_000;

fn id(n: u64) -> Id {
    common::id(n)
}

fn name(t: &str) -> Name {
    Name::new(t).unwrap()
}

fn town() -> (Town, BTreeMap<String, Id>) {
    common::town(b"souls/walk-host-test/1")
}

/// An empty tree, for a skill stepped with no world.
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

/// A world of walkers run a tick at a time through the host.
struct Walk {
    town: Town,
    runner: Runner,
    /// The fewest µm between two walkers on one node, over the run.
    nearest: i64,
    /// Every waiting mark a walker set on its own body: who, and the value.
    marked: Vec<(Id, Value)>,
}

impl Walk {
    fn new(town: Town) -> Walk {
        Walk {
            town,
            runner: Runner::new(TICK),
            nearest: i64::MAX,
            marked: Vec::new(),
        }
    }

    /// A walker standing at `at` on `node`, walking to `goal` on `to`: its legs planned by the world for the intent.
    fn add(&mut self, who: Id, node: Id, at: Vec3, to: Id, goal: Vec3) -> Vec<Leg> {
        let body: Body = self.town.surfaces[&node]
            .place(who, Frame { node, slot: None }, at, Quat::IDENTITY)
            .unwrap();
        common::walk(&mut self.runner, &mut self.town, body, SPEED, to, goal)
            .unwrap()
            .into_iter()
            .map(|l| Leg {
                to: l.to,
                link: l.link,
            })
            .collect()
    }

    fn tick(&mut self) {
        let was: BTreeMap<Id, Option<Value>> = self
            .runner
            .fields
            .iter()
            .map(|(k, f)| (*k, f.get(&F_WAITING).cloned()))
            .collect();
        self.runner
            .tick(&mut self.town)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
        // Each waiting mark a walker's own entry set.
        for (who, f) in &self.runner.fields {
            if let Some(now) = f.get(&F_WAITING)
                && was.get(who).and_then(|v| v.as_ref()) != Some(now)
            {
                self.marked.push((*who, now.clone()));
            }
        }
        let bodies: Vec<&Body> = self.runner.controller.bodies().collect();
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
            if self.runner.runs.is_empty() {
                break;
            }
            self.tick();
        }
    }

    /// When each walker's run ended, and how.
    fn ended(&self) -> BTreeMap<Id, (Micros, String)> {
        self.runner
            .ended
            .iter()
            .map(|(k, (at, p))| (*k, (*at, format!("{p:?}"))))
            .collect()
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
    let (at, how) = w.ended().get(&me).cloned().expect("the walk ends");
    let b = *w.runner.controller.body(me).unwrap();
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
    let t = &w.town;
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
    let ended = w.ended();
    println!("ended: {ended:?}; nearest {} mm", w.nearest / 1000);
    assert_eq!(ended.len(), 2, "both arrive");
    assert!(ended.values().all(|(_, h)| h == "Done"));
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

/// #3168: a new walk never takes the route the world gave a walk before it (`F_ROUTE` goes when a run starts), and a
/// crossing asked far from the link's near end is refused, the body unmoved, instead of carried there in a straight
/// line.
#[test]
fn a_new_walk_drops_the_old_route_and_a_crossing_is_not_asked_from_afar() {
    use sim::host::Links;
    use sim::walk::World;
    let (t, nodes) = town();
    let (ground, f0) = (nodes["ground"], nodes["building/floor-0"]);
    let mut w = Walk::new(t);
    let me = id(1);
    let (west, east) = (
        Vec3::new(-40_000_000, 0, 30_000_000),
        Vec3::new(-30_000_000, 0, 30_000_000),
    );
    w.add(me, ground, west, ground, west);
    w.run(10);
    // The world gave that walk a route into the building: through a doorway from the open ground.
    let body = *w.runner.controller.body(me).unwrap();
    let inside = w.town.plan(&body, f0, Vec3::new(0, 0, -3_000_000)).unwrap();
    let link = inside
        .iter()
        .find_map(|l| l.link)
        .expect("a doorway on the way in");
    w.runner.route(me, &inside);
    // A new walk east on the open ground: the old route goes, and it walks its own legs.
    common::walk(&mut w.runner, &mut w.town, body, SPEED, ground, east).unwrap();
    assert!(
        !w.runner.fields[&me].contains_key(&replica::host::F_ROUTE),
        "the old route is gone"
    );
    w.run(400);
    let b = *w.runner.controller.body(me).unwrap();
    assert_eq!(w.ended()[&me].1, "Done");
    assert!(
        common::dist(b.pose.position, east) < 500_000,
        "it walked east"
    );
    // A crossing of the doorway asked from 10 m east of the walk's start: refused, and nothing carries the body.
    let r = w.town.track(&b, link, SPEED, w.runner.now + TICK);
    assert_eq!(r.map(|_| ()).unwrap_err().name, "link-not-here");
}

/// #4215 (keeping apart, the hard rule): a walker whose line runs through a body standing still never steps into
/// its space (0.3 m between them, two personal radii); it goes around and arrives. The push alone lets it creep
/// through at a tenth of its speed.
#[test]
fn a_walker_never_steps_into_a_standing_body() {
    let (t, nodes) = town();
    let ground = nodes["ground"];
    let mut w = Walk::new(t);
    let (a, b) = (id(1), id(2));
    let (west, mid, east) = (
        Vec3::new(-40_000_000, 0, 30_000_000),
        Vec3::new(-35_000_000, 0, 30_000_000),
        Vec3::new(-30_000_000, 0, 30_000_000),
    );
    let standing: Body = w.town.surfaces[&ground]
        .place(
            b,
            Frame {
                node: ground,
                slot: None,
            },
            mid,
            Quat::IDENTITY,
        )
        .unwrap();
    w.runner.add_body(common::humanoid(), standing).unwrap();
    w.add(a, ground, west, ground, east);
    w.run(600);
    let ended = w.ended();
    println!("ended: {ended:?}; nearest {} mm", w.nearest / 1000);
    assert!(
        w.nearest >= 300_000,
        "it never steps into the standing body's space: nearest {} µm",
        w.nearest
    );
    assert_eq!(
        ended.get(&a).map(|(_, h)| h.as_str()),
        Some("Done"),
        "it goes around and arrives"
    );
}
