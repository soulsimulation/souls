//! The never-stuck ladder (Engine v2 N10, #2657) on N2's test world: the eight jam scenes.
//!
//! `cargo test -p sim --release --locked --test unstick -- --include-ignored --nocapture` runs Step 0 (the eight
//! scenes on N7 and N8 as they are, no ladder) and A1 (the same scenes with the ladder), printing how and when each
//! walker's order ends.

use import_eden::Import;
use replica::effects::{Header, schema_hash};
use replica::encode::{Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use sim::ground::exits;
use sim::ground::{
    HUMAN_RADIUS, Patch, Scene as GroundScene, Solid, Turn as GroundTurn, cut_floor,
};
use sim::links::Doors;
use sim::mover::{Body, Surface};
use sim::unstick::{Ladder, Rung};
use sim::walk::Crowd;
use sim::walk::town::Town;
use std::collections::BTreeMap;

const SPEED: i64 = 1_400_000; // µm a second
const TICK: i64 = 50_000; // µs
/// How long a scene runs before it is called stuck, µs.
const LIMIT: i64 = 60_000_000;

fn id(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
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
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/unstick-test/1").to_bytes()),
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

fn stand(t: &Town, who: Id, node: Id, at: Vec3) -> Body {
    t.surfaces[&node]
        .place(who, Frame { node, slot: None }, at, Quat::IDENTITY)
        .unwrap_or_else(|e| panic!("{}: {}", e.name, e.detail))
}

fn dist(a: Vec3, b: Vec3) -> i64 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    (d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt() as i64
}

fn v(x: i64, z: i64) -> Vec3 {
    Vec3::new(x, 0, z)
}

/// One scene: the town, its crowd, the walkers' ids, and the orders refused before a step (by name).
struct Scene {
    name: &'static str,
    t: Town,
    c: Crowd,
    l: Ladder,
    walkers: Vec<Id>,
    refused: Vec<(Id, &'static str)>,
}

impl Scene {
    fn new(name: &'static str) -> (Scene, BTreeMap<String, Id>) {
        let (t, nodes) = town();
        (
            Scene {
                name,
                t,
                c: Crowd::new(TICK),
                l: Ladder::new(),
                walkers: Vec::new(),
                refused: Vec::new(),
            },
            nodes,
        )
    }

    /// A walker `n` on `node` at `from`, going to `goal` on `to`.
    fn walker(&mut self, n: u64, node: Id, from: Vec3, to: Id, goal: Vec3) {
        let b = stand(&self.t, id(n), node, from);
        match self
            .l
            .add(&mut self.c, &mut self.t, b, SPEED, id(10_000 + n), to, goal)
        {
            Ok(()) => self.walkers.push(id(n)),
            Err(e) => self.refused.push((id(n), e.name)),
        }
    }

    /// A still body `n` with no order to stay: one whose walk to where it stands has ended.
    fn still(&mut self, n: u64, node: Id, at: Vec3) {
        let b = stand(&self.t, id(n), node, at);
        let p = b.pose.position;
        self.l
            .add(&mut self.c, &mut self.t, b, SPEED, id(10_000 + n), node, p)
            .expect("a still body");
    }
}

/// The eight jam scenes of #2657's design, each sized so that a walk with no jam ends well inside 20 s.
fn scenes() -> Vec<Scene> {
    let mut out = Vec::new();
    // 1. Head-on in the 0.9 m corridor upstairs (building frame: x -1.9 to 4.1 m, z -0.45 to 0.45 m).
    {
        let (mut s, n) = Scene::new("head-on in the 0.9 m corridor");
        let f1 = n["building/floor-1"];
        s.walker(1, f1, v(-1_000_000, 0), f1, v(3_400_000, 0));
        s.walker(2, f1, v(3_400_000, 0), f1, v(-1_000_000, 0));
        out.push(s);
    }
    // 2. A four-way crossing on the square: five from each side through its middle.
    {
        let (mut s, n) = Scene::new("a four-way crossing");
        let g = n["ground"];
        for k in 0..5i64 {
            let a = -1_600_000 + k * 800_000;
            let o = 6_000_000;
            s.walker(100 + k as u64, g, v(-o, a), g, v(o, a));
            s.walker(110 + k as u64, g, v(o, a), g, v(-o, a));
            s.walker(120 + k as u64, g, v(a, -o), g, v(a, o));
            s.walker(130 + k as u64, g, v(a, o), g, v(a, -o));
        }
        out.push(s);
    }
    // 3. A still body in a doorway: at the 0.9 m door's corridor end, with a walker from the landing to the corridor.
    {
        let (mut s, n) = Scene::new("a still body in a doorway");
        let f1 = n["building/floor-1"];
        let door = narrow_door(&s.t);
        let end =
            s.t.buildings
                .iter()
                .find_map(|b| b.link(door))
                .unwrap()
                .ends;
        let corridor = end
            .iter()
            .flatten()
            .max_by_key(|e| e.middle().x)
            .unwrap()
            .middle();
        s.still(200, f1, corridor);
        s.walker(201, f1, v(-3_000_000, 2_500_000), f1, v(1_500_000, 0));
        out.push(s);
    }
    // 4. Two groups swapping rooms through one door: four each way through the 1.2 m door from the stair hall to the
    //    south room (x = -2 m, z = -3 m).
    {
        let (mut s, n) = Scene::new("two groups swap rooms through one door");
        let f0 = n["building/floor-0"];
        for k in 0..4i64 {
            let z = -4_200_000 + (k % 2) * 1_200_000;
            let dx = 1_000_000 + (k / 2) * 900_000;
            s.walker(
                300 + k as u64,
                f0,
                v(-2_000_000 - dx, z - 600_000 * (k / 2)),
                f0,
                v(-2_000_000 + dx, z),
            );
            s.walker(
                310 + k as u64,
                f0,
                v(-2_000_000 + dx, z),
                f0,
                v(-2_000_000 - dx, z - 600_000 * (k / 2)),
            );
        }
        out.push(s);
    }
    // 5. A body ringed by still bodies: eight at 0.6 m round it on the square, its goal 5 m east.
    {
        let (mut s, n) = Scene::new("a body ringed by still bodies");
        let g = n["ground"];
        let (cx, cz) = (10_000_000, 10_000_000);
        let ring = [
            (600, 0),
            (424, 424),
            (0, 600),
            (-424, 424),
            (-600, 0),
            (-424, -424),
            (0, -600),
            (424, -424),
        ];
        for (k, (dx, dz)) in ring.iter().enumerate() {
            s.still(400 + k as u64, g, v(cx + dx * 1000, cz + dz * 1000));
        }
        s.walker(410, g, v(cx, cz), g, v(cx + 5_000_000, cz));
        out.push(s);
    }
    // 6. Thirty to one point: from a ring 5 m out on the square, all to its middle.
    {
        let (mut s, n) = Scene::new("thirty to one point");
        let g = n["ground"];
        let (cx, cz) = (-10_000_000, 10_000_000);
        // Thirty points on a circle of 5 m, by integer cosines and sines of 12 degree steps (thousandths).
        const C: [(i64, i64); 30] = [
            (1000, 0),
            (978, 208),
            (914, 407),
            (809, 588),
            (669, 743),
            (500, 866),
            (309, 951),
            (105, 995),
            (-105, 995),
            (-309, 951),
            (-500, 866),
            (-669, 743),
            (-809, 588),
            (-914, 407),
            (-978, 208),
            (-1000, 0),
            (-978, -208),
            (-914, -407),
            (-809, -588),
            (-669, -743),
            (-500, -866),
            (-309, -951),
            (-105, -995),
            (105, -995),
            (309, -951),
            (500, -866),
            (669, -743),
            (809, -588),
            (914, -407),
            (978, -208),
        ];
        for (k, (c, sn)) in C.iter().enumerate() {
            s.walker(
                500 + k as u64,
                g,
                v(cx + c * 5_000, cz + sn * 5_000),
                g,
                v(cx, cz),
            );
        }
        out.push(s);
    }
    // 7. An unreachable goal: from the square to the middle of the ring's solid core.
    {
        let (mut s, n) = Scene::new("an unreachable goal");
        let g = n["ground"];
        s.walker(600, g, v(20_000_000, 0), g, v(75_000_000, 0));
        out.push(s);
    }
    // 8. The stair opening onto the narrow door: two from the stair hall to the corridor, two from the corridor down.
    {
        let (mut s, n) = Scene::new("a stair opening onto a narrow door");
        let (f0, f1) = (n["building/floor-0"], n["building/floor-1"]);
        s.walker(700, f0, v(-6_000_000, 2_000_000), f1, v(1_000_000, 0));
        s.walker(701, f0, v(-5_000_000, 2_000_000), f1, v(2_000_000, 0));
        s.walker(710, f1, v(1_500_000, 0), f0, v(-5_500_000, -2_000_000));
        s.walker(711, f1, v(2_500_000, 0), f0, v(-4_500_000, -2_000_000));
        out.push(s);
    }
    out
}

/// The 0.9 m door from the landing to the corridor.
fn narrow_door(t: &Town) -> Id {
    t.buildings
        .iter()
        .flat_map(|b| b.links.iter())
        .find(|l| {
            l.width == 900_000
                && l.door.is_some()
                && l.ends
                    .iter()
                    .flatten()
                    .all(|e| e.floor == l.ends[0].unwrap().floor)
        })
        .expect("the narrow door upstairs")
        .id
}

/// How each walker's order ended: arrived (µs), refused at its start (by name), or still walking at the limit.
#[derive(Debug)]
enum End {
    Arrived(i64),
    Named(i64, &'static str),
    Stuck,
}

/// Runs a scene to its end or [`LIMIT`], with the ladder or without (N7 and N8 as they are).
fn run(s: &mut Scene, ladder: bool) -> (Vec<(Id, End)>, i64) {
    while s.c.now < LIMIT && !s.l.done(&s.c) {
        let r = if ladder {
            s.l.step(&mut s.c, &mut s.t)
        } else {
            s.c.step(&mut s.t)
        };
        r.unwrap_or_else(|e| panic!("{}: refused: {}: {}", s.name, e.name, e.detail));
    }
    let mut ends: Vec<(Id, End)> = s
        .refused
        .iter()
        .map(|&(w, n)| (w, End::Named(0, n)))
        .collect();
    for w in &s.walkers {
        let x = s.c.walkers.iter().find(|x| x.body.id == *w).unwrap();
        let named = s.l.log.iter().find_map(|r| match r.rung {
            Rung::Ended { name, .. } if r.who == *w => Some(End::Named(r.at, name)),
            _ => None,
        });
        ends.push((
            *w,
            x.arrived.map(End::Arrived).or(named).unwrap_or(End::Stuck),
        ));
    }
    let last = ends
        .iter()
        .map(|(_, e)| match e {
            End::Arrived(t) | End::Named(t, _) => *t,
            End::Stuck => i64::MAX,
        })
        .max()
        .unwrap_or(0);
    (ends, last)
}

fn report(name: &str, ends: &[(Id, End)], last: i64) -> String {
    let arrived = ends
        .iter()
        .filter(|e| matches!(e.1, End::Arrived(_)))
        .count();
    let named: Vec<&str> = ends
        .iter()
        .filter_map(|e| match e.1 {
            End::Named(_, n) => Some(n),
            _ => None,
        })
        .collect();
    let stuck = ends.iter().filter(|e| matches!(e.1, End::Stuck)).count();
    let when = if last == i64::MAX {
        format!("not ended at {} s", LIMIT / 1_000_000)
    } else {
        format!("ended at {}.{:02} s", last / 1_000_000, last / 10_000 % 100)
    };
    format!(
        "{name}: {when}; {arrived} arrived, {} ended by name {named:?}, {stuck} still walking",
        named.len()
    )
}

/// Step 0: the eight scenes on N7 and N8 as they are.
#[test]
#[ignore = "the Step 0 baseline: run with --include-ignored"]
fn step0_the_eight_scenes_without_the_ladder() {
    for mut s in scenes() {
        let (ends, last) = run(&mut s, false);
        println!("{}", report(s.name, &ends, last));
    }
}

/// A1: the eight scenes with the ladder: each ends within 20 s, every walker arrived or ended by name.
#[test]
fn a1_the_eight_scenes_end_within_20_s() {
    for mut s in scenes() {
        let (ends, last) = run(&mut s, true);
        println!("{}", report(s.name, &ends, last));
        for r in &s.l.log {
            println!(
                "    {:>6} ms {} {}{}",
                r.at / 1000,
                r.who.counter(),
                r.rung.name(),
                match &r.rung {
                    Rung::MakeWay { to } => format!(" to {}", to.counter()),
                    Rung::Ended { name, detail } => format!(" {name}: {detail}"),
                    _ => String::new(),
                }
            );
        }
        assert!(last <= 20_000_000, "{}: ended at {last} us", s.name);
    }
}

/// A box from `(x0, z0)` to `(x1, z1)` (µm, the floor's frame), 2 m tall from the floor.
fn solid(x0: i64, z0: i64, x1: i64, z1: i64) -> Solid {
    Solid {
        ring: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
        y0: 0,
        y1: 2_000_000,
    }
}

/// The floor's patch with `boxes` added: a rebuild, not yet applied.
fn rebuilt(t: &Town, floor: Id, boxes: &[Solid]) -> Patch {
    let mut s = GroundScene::of(&t.tree, floor).expect("the floor's scene");
    s.solids.extend(boxes.iter().cloned());
    cut_floor(&s, HUMAN_RADIUS, GroundTurn::NONE).expect("the new patch")
}

fn body_of(s: &Scene, who: Id) -> &sim::walk::Walker {
    s.c.walkers.iter().find(|w| w.body.id == who).unwrap()
}

/// A2 and A3 (off-ground): a box dropped on a body standing in the south room. The check names the body before the
/// patch is applied; once it is, the body walks to the nearest legal point at walking speed, recorded, with no jump.
#[test]
fn a2_a3_a_body_on_illegal_ground_is_named_and_walks_out() {
    let (mut s, n) = Scene::new("a box dropped on a body");
    let f0 = n["building/floor-0"];
    s.still(800, f0, v(0, -3_000_000));
    s.walker(
        801,
        f0,
        v(-5_000_000, 3_000_000),
        f0,
        v(-5_000_000, -3_000_000),
    );
    s.l.step(&mut s.c, &mut s.t).expect("a tick");
    let bodies: Vec<(Id, Vec3)> =
        s.c.walkers
            .iter()
            .map(|w| (w.body.id, w.body.pose.position))
            .collect();
    let patch = rebuilt(
        &s.t,
        f0,
        &[solid(-600_000, -3_600_000, 600_000, -2_400_000)],
    );
    let found = exits::check(&patch, false, &[], &bodies);
    println!("the check, before the change: {found:?}");
    assert_eq!(found.len(), 1, "one body listed");
    assert_eq!((found[0].body, found[0].why), (id(800), "off-ground"));
    // Not applied yet: the body still stands on the old ground.
    let b = body_of(&s, id(800)).body;
    let on_old = s.t.surfaces[&f0].place(id(800), b.pose.frame, b.pose.position, Quat::IDENTITY);
    assert!(on_old.is_ok());
    // The rebuild applied, then the last rung.
    s.t.surfaces
        .insert(f0, Surface::new(f0, patch.pieces.clone()));
    let before = b.pose.position;
    s.l.walk_out(&mut s.c, &s.t, id(800)).expect("a walk-out");
    let (mut was, mut ticks, mut largest) = (before, 0, 0);
    while !s.l.done(&s.c) && ticks < 400 {
        s.l.step(&mut s.c, &mut s.t).expect("a tick");
        let p = body_of(&s, id(800)).body.pose.position;
        let step = dist(was, p);
        largest = largest.max(step);
        assert!(
            step <= SPEED * TICK / 1_000_000 + 1,
            "no jump: {step} um in a tick"
        );
        was = p;
        ticks += 1;
    }
    let w = body_of(&s, id(800));
    assert_eq!(w.held, None, "walked out");
    let on_new = s.t.surfaces[&f0].place(
        id(800),
        w.body.pose.frame,
        w.body.pose.position,
        Quat::IDENTITY,
    );
    assert!(on_new.is_ok(), "on legal ground");
    let outs: Vec<_> = s.l.log.iter().filter(|r| r.who == id(800)).collect();
    for r in &outs {
        println!(
            "    {} ms body {} {:?}",
            r.at / 1000,
            r.who.counter(),
            r.rung
        );
    }
    assert!(matches!(outs[0].rung, Rung::WalkOut { from, .. } if from == before));
    assert!(matches!(outs[1].rung, Rung::WalkedOut { at } if at == w.body.pose.position));
    println!(
        "walked {} um out in {} ms; largest move in a tick {} um (its speed allows {} um)",
        dist(before, w.body.pose.position),
        (outs[1].at - outs[0].at) / 1000,
        largest,
        SPEED * TICK / 1_000_000
    );
}

/// A3 (no way out): boxes across both ways into the north room downstairs. The check names the body standing there,
/// and not the one in the stair hall.
#[test]
fn a3_a_body_in_a_piece_with_no_way_out_is_named() {
    let (mut s, n) = Scene::new("the north room shut in");
    let f0 = n["building/floor-0"];
    s.still(900, f0, v(500_000, 3_000_000));
    s.still(901, f0, v(-5_000_000, 3_000_000));
    let bodies: Vec<(Id, Vec3)> =
        s.c.walkers
            .iter()
            .map(|w| (w.body.id, w.body.pose.position))
            .collect();
    let before = exits::check(&rebuilt(&s.t, f0, &[]), false, &[], &bodies);
    assert!(before.is_empty(), "nothing listed before: {before:?}");
    let patch = rebuilt(
        &s.t,
        f0,
        &[
            solid(-1_900_000, 2_000_000, -1_000_000, 4_000_000),
            solid(2_000_000, 2_000_000, 2_900_000, 4_000_000),
        ],
    );
    let found = exits::check(&patch, false, &[], &bodies);
    println!("the check, before the change: {found:?}");
    assert_eq!(found.len(), 1, "one body listed");
    assert_eq!((found[0].body, found[0].why), (id(900), "no-way-out"));
}

/// A4: a still body with no order to stay is sent `make-way` and never moved; a body staying by its own order in the
/// same place is sent nothing and is passed.
#[test]
fn a4_make_way_goes_only_to_a_still_body_with_no_order_to_stay() {
    for staying in [false, true] {
        let mut s = scenes().remove(2);
        if staying {
            let w = s.c.walkers.iter_mut().find(|w| w.body.id == id(200));
            w.unwrap().staying = true;
        }
        let at = body_of(&s, id(200)).body.pose.position;
        let (ends, last) = run(&mut s, true);
        let name = if staying {
            "staying"
        } else {
            "no order to stay"
        };
        println!("{}", report(name, &ends, last));
        let asked: Vec<Id> =
            s.l.log
                .iter()
                .filter_map(|r| match r.rung {
                    Rung::MakeWay { to } => Some(to),
                    _ => None,
                })
                .collect();
        assert_eq!(body_of(&s, id(200)).body.pose.position, at, "never moved");
        if staying {
            assert!(asked.is_empty(), "sent nothing: {asked:?}");
            assert!(
                matches!(ends[0].1, End::Arrived(_)),
                "passed: {:?}",
                ends[0].1
            );
        } else {
            assert_eq!(asked, vec![id(200)], "make-way to the still body");
        }
    }
    // Thirty to one point: every make-way goes to a still body (one that has arrived), none to a walker.
    let mut s = scenes().remove(5);
    run(&mut s, true);
    let mut sent = 0;
    for r in &s.l.log {
        if let Rung::MakeWay { to } = r.rung {
            let w = body_of(&s, to);
            assert!(w.arrived.is_some_and(|a| a <= r.at) && !w.staying);
            sent += 1;
        }
    }
    println!("thirty to one point: {sent} make-way, each to a body that had arrived");
}
