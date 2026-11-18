//! Body sizes and floaters (Engine v2 B12, #2743).
//!
//! `cargo test -p sim --release --test sizes -- --nocapture` runs the test world (A2, A3). The Eden checks (A1, A4)
//! need N1's exported facts file (`node v2/tools/import-eden/export/export.ts` from the repository root) and run with
//! `cargo test -p sim --release --test sizes -- --ignored --nocapture`.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

use import_eden::Import;
use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::effects::{Header, Refusal, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose};
use replica::kinds::Kinds;
use replica::kinds::sizes::{Build, Size};
use replica::pose::{Frame, Mode, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::world_model::{plain, show};
use sim::controller::{Controller, Driver, Part};
use sim::ground::sizes::change_size;
use sim::ground::{OpenGround, Patch, Scene, Turn, cut_floor};
use sim::links::{Building, Doors, Kind};
use sim::mover::Body;
use sim::routes::{ALL, Hop, Map, Spot};
use sim::walk::town::Town;
use sim::walk::{AT_GOAL, Crowd, Leg, Mark, Pass, World};
use std::collections::BTreeMap;

fn eden() -> Import {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    import_eden::load(&text).expect("Eden loads")
}

fn testworld() -> Import {
    let w = testworld::generate(1, 0).expect("the test world");
    import_eden::load(&w.text).expect("the test world loads")
}

/// A family kind of the given size class, height and hover height (mm), loaded as kind data and read.
fn family(name: &str, size: &str, height: u64, hover: u64) -> Build {
    let text = format!(
        r#"{{1: "test:{name}", 2: "family", 3: {{
            1: {{1: "size", 2: "enum", 3: "{size}", 4: "public", 5: ["small", "standard", "large"]}},
            2: {{1: "height", 2: "int", 3: {height}, 4: "public"}},
            3: {{1: "hover", 2: "int", 3: {hover}, 4: "public"}}}}}}"#
    );
    let mut kinds = Kinds::default();
    let loaded = kinds.load(&[("family.diag", &text)]);
    assert_eq!(loaded.len(), 1, "{:?}", kinds.refused());
    Build::of(kinds.get(loaded[0].as_str()).unwrap()).expect("a family's build")
}

/// A standing point (mm, the piece's frame) of a piece of `node` on `map`, the one whose world point is nearest
/// `near` (x, z in mm).
fn piece_near(map: &Map, node: Id, near: [i64; 2]) -> Spot {
    let (n, ..) = map.counts();
    (0..n as u32)
        .filter(|&q| map.patch_of(q).node == node)
        .flat_map(|q| map.standing(q).into_iter().map(move |p| (q, p)))
        .min_by_key(|&(q, p)| {
            let w = map.world(q, p);
            (w[0] - near[0]).pow(2) + (w[2] - near[1]).pow(2)
        })
        .map(|(piece, at)| Spot { piece, at })
        .expect("a piece of that node")
}

fn um(p: [i64; 3]) -> Vec3 {
    Vec3::new(p[0] * 1000, p[1] * 1000, p[2] * 1000)
}

/// A patch's bytes as held: its pieces' points and triangles, outlines and meets.
fn bytes(p: &Patch) -> usize {
    let pieces: usize = p
        .pieces
        .iter()
        .map(|pc| {
            12 * pc.vertices.len()
                + 12 * pc.triangles.len()
                + pc.outline.iter().map(|r| 12 * r.len() + 24).sum::<usize>()
                + 3 * 24
        })
        .sum();
    pieces + p.meets.len() * std::mem::size_of::<sim::ground::Meet>() + 64
}

/// A2: a large body whose only way from the stair's landing to the rooms beyond the corridor upstairs is the 0.9 m
/// door into the corridor is refused there, by name, with the door and both widths. A standard body goes that way.
#[test]
fn a2_a_body_wider_than_the_only_door_is_refused_naming_it_and_both_widths() {
    let im = testworld();
    let (ground, floor) = (im.nodes["ground"], im.nodes["building/floor-1"]);
    let b = Building::read(&im.tree, im.nodes["building"]).unwrap();
    let stair = b.links.iter().find(|l| l.kind == Kind::Stairs).unwrap();
    let top = stair.ends[1].unwrap().middle();
    let narrow = b
        .links
        .iter()
        .find(|l| l.kind == Kind::Doorway && l.width == 900_000)
        .expect("the 0.9 m door into the corridor");
    // The room beyond the corridor, at its east end.
    let far = [-55_331, 53];
    for (build, ok) in [
        (family("walker", "standard", 1_750, 0), true),
        (family("large", "large", 2_400, 0), false),
    ] {
        let mut map = Map::build_for(&im.tree, ground, build.size, &|_| 0).unwrap();
        assert_eq!(map.size, build.size);
        let land = map.spot_near(floor, top, 600).expect("the landing");
        let goal = piece_near(&map, floor, far);
        let r = map.route(&im.tree, land, goal, ALL);
        match r {
            Ok(r) => {
                println!(
                    "A2 {}: landing to the far room, {} hops, {} mm",
                    build.size.name(),
                    r.hops.len(),
                    r.length
                );
                assert!(ok);
                assert_eq!(r.size, build.size);
                assert!(r.hops.contains(&Hop::Link {
                    id: narrow.id,
                    kind: Kind::Doorway
                }));
            }
            Err(no) => {
                println!(
                    "A2 {}: landing to the far room: {}: {}",
                    build.size.name(),
                    no.name,
                    no.detail
                );
                assert!(!ok);
                assert_eq!(no.name, "no-route");
                assert_eq!(
                    no.detail,
                    format!(
                        "link {}: link-too-narrow: the doorway (door {}) is 900 mm wide; a large body is 1000 mm wide, 1120 mm with its clearance",
                        show(narrow.id),
                        show(narrow.door.unwrap())
                    )
                );
            }
        }
    }
}

/// A3: a change to the large class is refused, the old body kept, where the body would not fit (in the 0.9 m
/// corridor) and where it would have no way out (on the roof, whose ladder lands on no ground for it, and in the room
/// beyond the corridor, whose one door opens onto the corridor). The same
/// body may become small in both places, and large on the open square.
#[test]
fn a3_a_change_to_a_larger_size_that_does_not_fit_or_has_no_exit_is_refused() {
    let im = testworld();
    let (ground, floor1, roof) = (
        im.nodes["ground"],
        im.nodes["building/floor-1"],
        im.nodes["building/floor-2"],
    );
    let map = Map::build(&im.tree, ground, &|_| 0).unwrap();
    let who = replica::pose::fixture(1);
    // A radius takes the class at or above it; one over the largest is refused.
    assert_eq!(Size::for_radius(250).unwrap(), Size::Standard);
    assert_eq!(Size::for_radius(500).unwrap(), Size::Large);
    assert_eq!(Size::for_radius(501).unwrap_err().name, "body-too-large");
    let corridor = piece_near(&map, floor1, [-59_841, -146]).at;
    let on_roof = piece_near(&map, roof, [-60_000, 0]).at;
    let beyond = piece_near(&map, floor1, [-55_331, 53]).at;
    for (place, node, at, name) in [
        ("the corridor", floor1, corridor, "size-would-not-fit"),
        ("the roof", roof, on_roof, "size-no-way-out"),
        (
            "the room beyond the corridor",
            floor1,
            beyond,
            "size-no-way-out",
        ),
    ] {
        let mut body = family("walker", "standard", 1_750, 0);
        let before = body;
        let no =
            change_size(&im.tree, ground, node, who, um(at), &mut body, Size::Large).unwrap_err();
        println!("A3 standard to large, {place}: {}: {}", no.name, no.detail);
        assert_eq!(no.name, name);
        assert_eq!(body, before, "the old body is kept");
        let mut small = before;
        change_size(&im.tree, ground, node, who, um(at), &mut small, Size::Small)
            .expect("smaller fits");
        assert_eq!(small.size, Size::Small);
    }
    let mut body = family("walker", "standard", 1_750, 0);
    change_size(
        &im.tree,
        ground,
        ground,
        who,
        Vec3::ZERO,
        &mut body,
        Size::Large,
    )
    .expect("the open square");
    println!("A3 standard to large, the open square: made");
    assert_eq!(body.size, Size::Large);
}

/// The test world with a solid block 8 m by 2 m standing 0.9 m outside each of the hall's 2.4 m doors (front and
/// back): a standard body passes between wall and block, a large one does not.
fn testworld_blocked_hall() -> Import {
    let w = testworld::generate(1, 0).expect("the test world");
    // The hall's walls' outer faces are 20.2 m either side of its centre, 62 m north of the square's.
    let block = |id: &str, z: i64| {
        format!(
            r#"{{"id":"{id}","def":"testworld-ring@1","ref":"testworld-ring@1","parent":null,"pose":[0,0,{z},0],"scale_ppm":1000000,"name":"{id}","solids":[[0,0,4000,1000,0,0,3000,1,0]]}},"#
        )
    };
    let blocks = block("block-front", 62_000 - 20_200 - 900 - 1_000)
        + &block("block-back", 62_000 + 20_200 + 900 + 1_000);
    let at = w.text.find(r#""things":["#).expect("the things") + r#""things":["#.len();
    let text = format!("{}{blocks}{}", &w.text[..at], &w.text[at..]);
    import_eden::load(&text).expect("the blocked test world loads")
}

/// A2 (the follow-up): a change to large in the hall, whose doors all open onto the open ground, is refused as
/// `size-no-way-out` when the open ground outside each door is too tight for a large body, and made when it is not.
#[test]
fn a2_a_door_to_open_ground_too_tight_for_the_new_size_is_no_way_out() {
    let who = replica::pose::fixture(1);
    for (world, im, want) in [
        ("the test world", testworld(), None),
        (
            "blocks outside the hall's doors",
            testworld_blocked_hall(),
            Some("size-no-way-out"),
        ),
    ] {
        let (ground, hall) = (im.nodes["ground"], im.nodes["hall/floor-0"]);
        let map = Map::build(&im.tree, ground, &|_| 0).unwrap();
        let at = piece_near(&map, hall, [0, 0]).at;
        let mut body = family("walker", "standard", 1_750, 0);
        let before = body;
        let got = change_size(&im.tree, ground, hall, who, um(at), &mut body, Size::Large);
        match (&got, want) {
            (Ok(()), None) => {
                println!("A2 standard to large in the hall, {world}: made");
                assert_eq!(body.size, Size::Large);
            }
            (Err(no), Some(name)) => {
                println!(
                    "A2 standard to large in the hall, {world}: {}: {}",
                    no.name, no.detail
                );
                assert_eq!(no.name, name);
                assert_eq!(body, before, "the old body is kept");
            }
            _ => panic!("{world}: {got:?}, wanted {want:?}"),
        }
        let mut small = before;
        change_size(&im.tree, ground, hall, who, um(at), &mut small, Size::Small)
            .expect("smaller fits");
    }
}

/// A1: a small, a standard, a large and a hovering body each cross Eden by route, west to east between the same two
/// points: each on a map cut for its class, the route carrying the class, and the floater's pose held above the
/// surface below it at its hover height at every point it passes.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a1_four_bodies_cross_eden_by_route() {
    let im = eden();
    let ground = im.nodes["ground"];
    // The two ends: the westmost and eastmost standing points of the open ground in the largest part of the large
    // class's map (the most constrained), so every class has ground there.
    let large = Map::build_for(&im.tree, ground, Size::Large, &|_| 0).unwrap();
    let parts = large.parts(ALL);
    let (n, ..) = large.counts();
    let mut size: BTreeMap<u32, usize> = BTreeMap::new();
    for &p in &parts {
        *size.entry(p).or_default() += 1;
    }
    let main = *size
        .iter()
        .max_by_key(|(k, c)| (**c, std::cmp::Reverse(**k)))
        .unwrap()
        .0;
    let pts: Vec<[i64; 3]> = (0..n as u32)
        .filter(|&q| parts[q as usize] == main && large.patch_of(q).node == ground)
        .flat_map(|q| large.standing(q).into_iter().map(move |p| (q, p)))
        .map(|(q, p)| large.world(q, p))
        .collect();
    let west = *pts.iter().min_by_key(|p| p[0]).unwrap();
    let east = *pts.iter().max_by_key(|p| p[0]).unwrap();
    println!(
        "A1 from ({}, {}) m to ({}, {}) m, {} m apart west to east",
        west[0] / 1000,
        west[2] / 1000,
        east[0] / 1000,
        east[2] / 1000,
        (east[0] - west[0]) / 1000
    );
    println!(
        "A1 | body | class | radius mm | hover mm | map built ms | route us | length m | hops | links crossed | portals searched"
    );
    for (name, build) in [
        ("small", family("small", "small", 1_000, 0)),
        ("standard", family("walker", "standard", 1_750, 0)),
        ("large", family("large", "large", 2_400, 0)),
        ("hovering", family("floater", "standard", 1_200, 400)),
    ] {
        let t = std::time::Instant::now();
        let mut map = Map::build_for(&im.tree, ground, build.size, &|_| 0).unwrap();
        let built = t.elapsed().as_millis();
        let from = map.spot_near(ground, um(west), 50).expect("the west end");
        let to = map.spot_near(ground, um(east), 50).expect("the east end");
        let t = std::time::Instant::now();
        let r = map
            .route(&im.tree, from, to, ALL)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let took = t.elapsed().as_micros();
        assert_eq!(r.size, build.size);
        assert!(r.length as i64 >= east[0] - west[0]);
        let crossed = r
            .hops
            .iter()
            .filter(|h| matches!(h, Hop::Link { .. }))
            .count();
        println!(
            "A1 | {name} | {} | {} | {} | {built} | {took} | {} | {} | {crossed} | {}",
            build.size.name(),
            build.size.radius_mm(),
            build.hover_mm,
            r.length / 1000,
            r.hops.len(),
            r.searched
        );
        // Its pose at each point it passes: supported by the open ground below, held at its hover height.
        for w in r.waypoints.iter().chain([&east]) {
            let pose = Pose {
                frame: Frame {
                    node: ground,
                    slot: None,
                },
                position: Vec3::new(w[0] * 1000, (w[1] + build.hover_mm) * 1000, w[2] * 1000),
                orientation: Quat::IDENTITY,
                support: build.support(ground),
            };
            pose.check().expect("a legal pose");
            assert_eq!(
                pose.support,
                Support::Surface {
                    surface: ground,
                    height: build.hover_mm * 1000
                }
            );
        }
    }
}

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

/// The walk skill's world with every step made by the controller (B1): the skill's velocity is set through the
/// walk's driver, the controller steps the body on the surfaces of its class, and the skill reads the body back.
/// A link is not crossed here (the controller has no crossing yet), and the route crosses none.
struct Driven {
    town: Town,
    ctl: Controller,
    drivers: BTreeMap<Id, Driver>,
}

impl World for Driven {
    fn plan(&mut self, body: &Body, node: Id, goal: Vec3) -> Result<Vec<Leg>, Refusal> {
        self.town.plan(body, node, goal)
    }
    fn corner(&mut self, body: &Body, to: Vec3) -> Result<[i64; 2], Refusal> {
        self.town.corner(body, to)
    }
    fn step(
        &mut self,
        body: &mut Body,
        v: [i64; 2],
        dt: Micros,
        at: Micros,
    ) -> Result<(), Refusal> {
        let d = self.drivers[&body.id];
        let velocity = Part::Velocity(Vec3::new(v[0], 0, v[1]), Mode::Surface);
        self.ctl.set(body.id, d, velocity)?;
        let stepped = self.ctl.step(self.town.surfaces_of(body.id), dt, at);
        if let Some((_, r)) = stepped.refused.into_iter().next() {
            return Err(r);
        }
        *body = *self.ctl.body(body.id).expect("the controller holds it");
        Ok(())
    }
    fn cross(
        &mut self,
        _: &mut Body,
        link: Id,
        _: Id,
        _: i64,
        _: Micros,
        _: Micros,
    ) -> Result<bool, Refusal> {
        Err(Refusal {
            name: "link-not-driven",
            detail: show(link),
        })
    }
    fn turns(&mut self, marks: &[Mark], at: Micros) -> Result<(), Refusal> {
        self.town.turns(marks, at)
    }
    fn pass(&self, link: Id, who: Id) -> Pass {
        self.town.pass(link, who)
    }
}

/// A1 (the follow-up): a small, a standard, a large and a hovering body each walk Eden west to east between the
/// same two points as B12's A1, end to end, by N7's walk skill on ground and links cut for its own class, every step
/// made by the controller. One town keeps one cut per class; the floater is held at its hover height at every tick.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a1_four_bodies_walk_eden_through_the_controller() {
    let Import {
        tree, rules, nodes, ..
    } = eden();
    let ground = nodes["ground"];
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/size-walk-test/1").to_bytes()),
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
    // B12's A1 ends: the westmost and eastmost standing points of the open ground in the largest part of the large
    // class's map.
    let large = Map::build_for(&tree, ground, Size::Large, &|_| 0).unwrap();
    let parts = large.parts(ALL);
    let (n, ..) = large.counts();
    let mut count: BTreeMap<u32, usize> = BTreeMap::new();
    for &p in &parts {
        *count.entry(p).or_default() += 1;
    }
    let main = *count
        .iter()
        .max_by_key(|(k, c)| (**c, std::cmp::Reverse(**k)))
        .unwrap()
        .0;
    let pts: Vec<[i64; 3]> = (0..n as u32)
        .filter(|&q| parts[q as usize] == main && large.patch_of(q).node == ground)
        .flat_map(|q| large.standing(q).into_iter().map(move |p| (q, p)))
        .map(|(q, p)| large.world(q, p))
        .collect();
    let west = *pts.iter().min_by_key(|p| p[0]).unwrap();
    let east = *pts.iter().max_by_key(|p| p[0]).unwrap();
    drop(large);
    let mut town = Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town");
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let legs = Family {
        name: name("test:walker"),
        resources: ["test:leg-left", "test:leg-right"]
            .map(|r| Resource {
                name: name(r),
                class: Class::Locomotion,
                slot: None,
            })
            .to_vec(),
    };
    let walk = SkillShape {
        name: name("test:walk"),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: vec![],
        cancelled_by: vec![],
    };
    const SPEED: i64 = 1_400_000;
    const TICK: Micros = 100_000;
    println!(
        "A1 from ({}, {}) m to ({}, {}) m",
        west[0] / 1000,
        west[2] / 1000,
        east[0] / 1000,
        east[2] / 1000
    );
    println!(
        "A1 | body | class | hover mm | cut ms | ground pieces | ticks | walked s | logged inputs | path sum mm | ends mm from the goal"
    );
    for (k, (label, build)) in [
        ("small", family("small", "small", 1_000, 0)),
        ("standard", family("walker", "standard", 1_750, 0)),
        ("large", family("large", "large", 2_400, 0)),
        ("hovering", family("floater", "standard", 1_200, 400)),
    ]
    .into_iter()
    .enumerate()
    {
        let who = replica::pose::fixture(10 + k as u64);
        let t = std::time::Instant::now();
        town.size(who, build.size).expect("the class's cut");
        let cut = t.elapsed().as_millis();
        let at = Vec3::new(west[0] * 1000, west[1] * 1000, west[2] * 1000);
        let mut body = town.surfaces_of(who)[&ground]
            .place(who, frame, at, Quat::IDENTITY)
            .unwrap_or_else(|e| panic!("{label}: {}: {}", e.name, e.detail));
        sim::mover::lift(&mut body, build.hover_mm * 1000);
        assert_eq!(body.pose.support, build.support(ground));
        let mut ctl = Controller::new();
        ctl.add(legs.clone(), body).expect("the body");
        let d = ctl.claim(who, &walk).expect("the walk's driver");
        let mut world = Driven {
            town,
            ctl,
            drivers: BTreeMap::from([(who, d)]),
        };
        let goal = Vec3::new(east[0] * 1000, east[1] * 1000, east[2] * 1000);
        let mut crowd = Crowd::new(TICK);
        crowd
            .add(
                &mut world,
                body,
                SPEED,
                replica::pose::fixture(100 + k as u64),
                ground,
                goal,
            )
            .unwrap_or_else(|e| panic!("{label}: {}: {}", e.name, e.detail));
        let (mut ticks, mut path) = (0u64, 0i128);
        while !crowd.done() {
            crowd
                .step(&mut world)
                .unwrap_or_else(|e| panic!("{label} at tick {ticks}: {}: {}", e.name, e.detail));
            ticks += 1;
            assert!(ticks < 40_000, "{label}: not arrived");
            let b = world.ctl.body(who).unwrap();
            path += i128::from(b.pose.position.x) + i128::from(b.pose.position.z);
            assert_eq!(
                *b, crowd.walkers[0].body,
                "{label}: the skill's body is the controller's"
            );
            assert_eq!(
                b.pose.support,
                build.support(ground),
                "{label}: its support"
            );
            b.pose.check().expect("a legal pose");
            if build.hover_mm > 0 {
                let floor = world.town.surfaces[&ground]
                    .place(who, frame, b.pose.position, Quat::IDENTITY)
                    .unwrap();
                assert_eq!(
                    b.pose.position.y - floor.pose.position.y,
                    build.hover_mm * 1000,
                    "{label}: held at its hover height"
                );
            }
        }
        let end = world.ctl.body(who).unwrap().pose.position;
        let off = ((end.x - goal.x).pow(2) + (end.z - goal.z).pow(2)).isqrt();
        assert!(off <= AT_GOAL, "{label}: arrived");
        let logged = world.ctl.log().len();
        println!(
            "A1 | {label} | {} | {} | {cut} | {} | {ticks} | {} | {logged} | {} | {}",
            build.size.name(),
            build.hover_mm,
            world.town.surfaces_of(who)[&ground].pieces().len(),
            ticks * TICK as u64 / 1_000_000,
            path / 1_000,
            off / 1000
        );
        town = world.town;
    }
    assert_eq!(town.cut_sizes(), Size::ALL.to_vec(), "one cut per class");
}

/// A4: every floor node of Eden and every square of its open ground cut for each size class, two repeats: time and
/// memory against the budget stated first. Each node at or over 5 ms is listed.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a4_eden_cut_per_size_class() {
    let im = eden();
    let floors: Vec<_> = im
        .nodes
        .values()
        .copied()
        .filter(|id| {
            let n = im.tree.node(im.tree.handle(*id).unwrap()).unwrap();
            plain(n.kind().as_str()) == "eden:floor"
        })
        .collect();
    let ground = im.nodes["ground"];
    let scene = Scene::of(&im.tree, ground).unwrap();
    println!(
        "A4 | class | radius mm | repeat | all floors ms | all squares ms | total ms | slowest node us | at or over 5 ms | MB"
    );
    for size in Size::ALL {
        let radius = size.radius_mm();
        for repeat in 1..=2 {
            let (mut floor_us, mut sq_us, mut slowest, mut over, mut mem) =
                (0u128, 0u128, 0u128, 0, 0usize);
            for id in &floors {
                let t = std::time::Instant::now();
                let cut = Scene::of(&im.tree, *id).and_then(|s| cut_floor(&s, radius, Turn::NONE));
                let us = t.elapsed().as_micros();
                floor_us += us;
                slowest = slowest.max(us);
                if us >= 5_000 {
                    over += 1;
                    println!("    floor {} {us} us", show(*id));
                }
                if let Ok(p) = cut {
                    mem += bytes(&p);
                }
            }
            let t = std::time::Instant::now();
            let open = OpenGround::prepare(&scene, radius).unwrap();
            sq_us += t.elapsed().as_micros();
            for (i, j) in open.squares() {
                let t = std::time::Instant::now();
                let p = open.cut_square(i, j);
                let us = t.elapsed().as_micros();
                sq_us += us;
                slowest = slowest.max(us);
                if us >= 5_000 {
                    over += 1;
                    println!("    square ({i}, {j}) {us} us");
                }
                mem += bytes(&p);
            }
            println!(
                "A4 | {} | {radius} | {repeat} | {} | {} | {} | {slowest} | {over} | {:.1}",
                size.name(),
                floor_us / 1000,
                sq_us / 1000,
                (floor_us + sq_us) / 1000,
                mem as f64 / 1e6
            );
        }
    }
}
