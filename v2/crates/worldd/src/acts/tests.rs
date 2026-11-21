use super::*;

use replica::pose::{Frame, Quat};
use sim::links::Doors;
use sim::walk::town::Town;

fn seating_entry(kind: &str) -> Json {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../content/kinds/seating")
        .join(format!("{kind}.json"));
    replica::rules::json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn fixture_sit_dispatch_uses_only_the_declared_approach_without_explicit_args() {
    use replica::encode::Value;
    let generated = testworld::generate(1, 0).unwrap();
    let imported = import_eden::load(&generated.text).unwrap();
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let node = Id::new(Scope([0x73; 16]), 1).unwrap();
    for kind in ["bench", "stump", "armchair"] {
        let entry = seating_entry(kind);
        let kind_name = entry.get("kind").and_then(Json::str).unwrap();
        let tree = Tree::start(node, Name::new(kind_name).unwrap());
        let acts = Acts::new(
            Json::object([(kind_name, entry.clone())]),
            Vec::new(),
            header.clone(),
            node.scope(),
        );
        let intent = WireIntent {
            actor: Actor::Soul(node),
            verb: Name::new("eden:sit").unwrap(),
            target: Some(Target::Node(node)),
            parameters: BTreeMap::new(),
            sequence: 1,
            basis: Value::Array(Vec::new()),
            expiry: 10_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        assert!(
            acts.fixture_sit(&tree, &intent),
            "{kind} keeps its approach"
        );
        let changed = |verb: &str, target, parameters| WireIntent {
            verb: Name::new(verb).unwrap(),
            target,
            parameters,
            ..intent.clone()
        };
        assert!(!acts.fixture_sit(
            &tree,
            &changed("souls:sit", intent.target.clone(), BTreeMap::new())
        ));
        assert!(!acts.fixture_sit(
            &tree,
            &changed("eden:walk", intent.target.clone(), BTreeMap::new())
        ));
        assert!(!acts.fixture_sit(
            &tree,
            &changed(
                "eden:sit",
                Some(Target::Selector(2, BTreeMap::new())),
                BTreeMap::new()
            )
        ));
        assert!(!acts.fixture_sit(
            &tree,
            &changed(
                "eden:sit",
                intent.target.clone(),
                BTreeMap::from([(1, Value::Array(Vec::new()))])
            )
        ));
        assert!(!acts.fixture_sit(
            &Tree::start(node, Name::new("souls:body").unwrap()),
            &intent
        ));
        // Unsupported selectors and body/ground settle retain their own binding/refusal path.
        let text = entry.to_json();
        for changed in [
            text.replace("nearest", "farthest"),
            text.replace("walk_to", "settle"),
        ] {
            let changed = replica::rules::json::parse(&changed).unwrap();
            assert_eq!(fixture_seat(&changed, "sit"), None);
        }
        assert_eq!(fixture_seat(&entry, "lie"), None);
    }
}

#[test]
fn same_ground_form_walk_keeps_the_planned_doorway_links() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let ground = imported.nodes["ground"];
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let mut town =
        Town::new(imported.tree, ground, Doors::new(header, imported.rules, 0)).expect("the town");
    let id = Id::new(Scope([0xc8; 16]), 1).unwrap();
    // Both ends are on open ground; the shorter route crosses the building between them through two doors.
    let body = town.surfaces[&ground]
        .place(
            id,
            Frame {
                node: ground,
                slot: None,
            },
            Vec3::new(0, 0, 40_000_000),
            Quat::IDENTITY,
        )
        .unwrap();
    let goal = Vec3::new(0, 0, 84_000_000);
    let copy = town.copy().expect("the planner's town");
    let map = Arc::new(town.versions.clone());
    let intent = Id::new(Scope([0xc8; 16]), 2).unwrap();
    let walk_key = FormKey {
        body: id,
        intent,
        stage: 0,
        step: 0,
        kind: FormKind::Walk,
    };
    let line_key = FormKey {
        kind: FormKind::Line,
        ..walk_key
    };
    let mut planner = sim::planner::Planner::new(copy);
    let walk = FormQuestion {
        key: walk_key,
        generation: 1,
        body,
        query: FormQuery::Walk {
            node: ground,
            at: goal,
            reach: 0,
        },
    };
    let line = FormQuestion {
        key: line_key,
        generation: 2,
        body,
        query: FormQuery::Line { to: goal },
    };
    // Prepare answers off the clock, then prove that requesting and consuming them never searches on it.
    let answered = planner.answer(&sim::host::Wants {
        form_map: Some(Arc::clone(&map)),
        forms: vec![walk.clone(), line],
        ..Default::default()
    });
    let planned = town
        .view()
        .plan(&body, ground, goal)
        .expect("a way through");
    let split = town.split(1);
    assert_eq!(planned.iter().filter(|l| l.link.is_some()).count(), 2);
    let kinds = Json::Obj(Vec::new());
    let toward = BTreeMap::new();
    let planning = RefCell::new(Planning::default());
    let sight = Sight {
        bodies: BTreeMap::from([(id, body)]),
        carrying: BTreeSet::new(),
        tree: split.shared.tree,
        split: Some(RefCell::new(split)),
        builds: BTreeMap::from([(id, Build::STANDARD)]),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::from([(id, (intent, 0, 0))]),
        walks: BTreeMap::new(),
        sit_walks: BTreeMap::new(),
        planning: &planning,
        map: Arc::clone(&map),
    };
    sim::commit::mark_clock_thread();
    assert_eq!(sight.plan_walk(id, 0, ground, goal, 0), WalkPlan::Pending);
    assert_eq!(planning.borrow().queued[&walk_key], walk);
    assert_eq!(
        sight.ask(id, &Ask::Toward { to: goal, from: id }),
        Some(Answer::Point(body.pose.position))
    );
    assert!(
        planning.borrow().queued.contains_key(&line_key),
        "the obstructed corner is asked off-clock"
    );
    // #3573: a far fixture sit on full Eden ended `walk.blocked` while its route was still being planned.
    assert!(
        !sight.asked.borrow().contains_key(&id),
        "a tick waiting for the planner is no tick of stalled walking"
    );
    let duplicated_line = answered.forms[&line_key].clone();
    planning.borrow_mut().receive(answered.forms);
    assert_eq!(
        sight.plan_walk(id, 0, ground, goal, 0),
        WalkPlan::Legs(planned.iter().map(|l| (l.to, l.link)).collect())
    );
    let Some(Answer::Point(corner)) = sight.ask(id, &Ask::Toward { to: goal, from: id }) else {
        panic!("the planned corner");
    };
    assert_ne!(corner, body.pose.position);
    assert!(
        sight.asked.borrow().contains_key(&id),
        "a planned corner is watched for stalls"
    );
    assert!(
        !planning.borrow().current.contains_key(&line_key),
        "a partial line result is consumed once"
    );
    planning
        .borrow_mut()
        .receive(BTreeMap::from([(line_key, duplicated_line)]));
    assert!(
        !planning.borrow().answers.contains_key(&line_key),
        "duplicate old line result cannot be reinstalled"
    );
    planning.borrow_mut().keep(&BTreeMap::new());
    assert!(
        planning.borrow().current.is_empty(),
        "cancellation drops outstanding questions"
    );
    assert!(planning.borrow().answers.is_empty());
}

#[test]
fn form_answers_reject_old_generation_map_and_cancelled_order() {
    let generated = testworld::generate(1, 0).unwrap();
    let imported = import_eden::load(&generated.text).unwrap();
    let ground = imported.nodes["ground"];
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let town = Town::new(imported.tree, ground, Doors::new(header, imported.rules, 0)).unwrap();
    let id = Id::new(Scope([0xc9; 16]), 1).unwrap();
    let intent = Id::new(Scope([0xc9; 16]), 2).unwrap();
    let body = town.surfaces[&ground]
        .place(
            id,
            Frame {
                node: ground,
                slot: None,
            },
            Vec3::new(0, 0, 40_000_000),
            Quat::IDENTITY,
        )
        .unwrap();
    let key = FormKey {
        body: id,
        intent,
        stage: 1,
        step: 2,
        kind: FormKind::Walk,
    };
    let map = Arc::new(town.versions.clone());
    let mut planning = Planning::default();
    let question = |at| FormQuery::Walk {
        node: ground,
        at,
        reach: 0,
    };
    planning.ask(key, body, question(Vec3::ZERO), &map);
    let old = FormAnswer {
        generation: 1,
        map: Arc::clone(&map),
        result: FormResult::Walk(Vec::new()),
    };
    planning.ask(key, body, question(Vec3::new(1, 0, 0)), &map);
    planning.receive(BTreeMap::from([(key, old.clone())]));
    assert!(
        planning.answer(&key, &map).is_none(),
        "old target generation refused"
    );
    let mut versions = (*map).clone();
    versions.bump([&ground]);
    let changed = Arc::new(versions);
    planning.ask(key, body, question(Vec3::new(1, 0, 0)), &changed);
    let current = FormAnswer {
        generation: 3,
        map: Arc::clone(&changed),
        result: FormResult::Walk(Vec::new()),
    };
    planning.receive(BTreeMap::from([(key, current.clone())]));
    assert!(planning.answer(&key, &map).is_none(), "old map refused");
    assert!(planning.answer(&key, &changed).is_some());
    planning.keep(&BTreeMap::from([(id, (intent, 1, 3))]));
    planning.receive(BTreeMap::from([(key, current)]));
    assert!(
        planning.current.is_empty(),
        "a newer step discards its predecessor"
    );
    assert!(
        planning.answers.is_empty(),
        "late cancelled result is ignored"
    );
    let mut merged = sim::host::Planned::default();
    let later = FormAnswer {
        generation: 9,
        ..old.clone()
    };
    merged.forms.insert(key, later);
    merged.merge(sim::host::Planned {
        forms: BTreeMap::from([(key, old)]),
        ..Default::default()
    });
    assert_eq!(
        merged.forms[&key].generation, 9,
        "an older batch cannot replace a newer result"
    );
}

/// C34 (#3599) A1: a walk to a building's named area is planned on the building's own room and floor: the area
/// named as an upstairs room (`r1a`) resolves onto that room's floor at the room's height, whatever height the point
/// gives; an area that names no room of a building with more than one floor has no way there; a point its entry does
/// not list as an area, or a walk at another step, is planned as before.
#[test]
fn c34_a_named_area_resolves_onto_its_rooms_floor_not_by_nearness() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let (ground, building) = (imported.nodes["ground"], imported.nodes["building"]);
    let floor1 = imported.nodes["building/floor-1"];
    let tree = &imported.tree;
    let b = tree.node(tree.handle(building).unwrap()).unwrap();
    let place = b.place().unwrap();
    let room_y = tree
        .node(tree.handle(imported.nodes["building/r1a"]).unwrap())
        .unwrap()
        .place()
        .unwrap()
        .position
        .y;
    let kind = plain(b.kind()).to_owned();
    let area = |y: i128| {
        Json::Obj(vec![(
            "at_mm".into(),
            Json::Arr(vec![Json::Int(0), Json::Int(y), Json::Int(0)]),
        )])
    };
    let kinds = Json::Obj(vec![(
        kind,
        Json::Obj(vec![(
            "areas".into(),
            Json::Obj(vec![
                ("r1a".into(), area(100)),
                ("attic".into(), area(9_000)),
            ]),
        )]),
    )]);
    let id = Id::new(Scope([0xc9; 16]), 1).unwrap();
    let toward = BTreeMap::new();
    let planning = RefCell::new(Planning::default());
    let sight = |point: &str| Sight {
        bodies: BTreeMap::new(),
        carrying: BTreeSet::new(),
        tree,
        split: None,
        builds: BTreeMap::new(),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::new(),
        walks: BTreeMap::from([(id, (2, building, Name::new(point).unwrap()))]),
        sit_walks: BTreeMap::new(),
        planning: &planning,
        map: Arc::new(Versions::default()),
    };
    // A point 1 m along the building's own x, 0.1 m up, in the ground's frame.
    let local = Vec3::new(1_000_000, 100_000, 0);
    let at = place
        .position
        .plus(place.orientation.rotate(local).unwrap())
        .unwrap();
    let (floor, on) = sight("r1a")
        .area_floor(id, 2, ground, at)
        .expect("an area of a building")
        .expect("its room's floor");
    assert_eq!(floor, floor1, "the upstairs room's floor");
    assert_eq!(on.y, room_y, "at the room's height, not the point's");
    assert!(
        (on.x - local.x).abs() <= 2 && on.z.abs() <= 2,
        "the point in the building's frame: {on:?}"
    );
    assert_eq!(
        sight("attic").area_floor(id, 2, ground, at),
        Some(None),
        "no room or only floor: no way"
    );
    assert_eq!(
        sight("door").area_floor(id, 2, ground, at),
        None,
        "not an area: as before"
    );
    assert_eq!(
        sight("r1a").area_floor(id, 3, ground, at),
        None,
        "another step: as before"
    );
}

/// A skill that holds its body and does nothing: what a gateway walk's runner reads as running.
struct Holds;

impl replica::host::Skill for Holds {
    fn shape(&self) -> replica::bodies::SkillShape {
        replica::bodies::SkillShape {
            name: Name::new("test:holds").unwrap(),
            claims: Vec::new(),
            blocks: Vec::new(),
            cancelled_by: Vec::new(),
        }
    }

    fn step(&mut self, _: &mut dyn replica::host::Host) -> replica::host::Progress {
        replica::host::Progress::Running
    }
}

/// #1960 cause 1: the gateway walk's stall watch measures against its line's leg's end, never the walk's granted
/// place, which on a route with crossings lies past the leg's end. Here the granted place lies 20 m west and the
/// line goes east round N2's hall to its leg's end: walking it at 1.4 m/s, the walk is never found stalled. Measured
/// against the granted place (or its corner alone), its least way left stops shrinking at the hall's first corner
/// and the backstop ends it there 12 s on.
#[test]
fn a_gateway_walk_is_watched_against_its_legs_end_not_its_granted_place() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let ground = imported.nodes["ground"];
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let town =
        Town::new(imported.tree, ground, Doors::new(header, imported.rules, 0)).expect("the town");
    let id = Id::new(Scope([0xc9; 16]), 1).unwrap();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let place = |town: &Town, at: Vec3| {
        town.surfaces[&ground]
            .place(id, frame.clone(), at, Quat::IDENTITY)
            .unwrap()
    };
    let start = place(&town, Vec3::new(-20_000_000, 0, 50_000_000));
    let mut b = Bodies::new(town, 50_000).unwrap();
    let legs = |n: &str| replica::bodies::Resource {
        name: Name::new(n).unwrap(),
        class: replica::bodies::Class::Locomotion,
        slot: None,
    };
    b.add_body(
        replica::bodies::Family {
            name: Name::new("souls:humanoid").unwrap(),
            resources: vec![legs("souls:leg-left"), legs("souls:leg-right")],
        },
        start,
    )
    .unwrap();
    b.runner.start(id, Box::new(Holds)).unwrap();
    b.runner
        .granted
        .insert(id, Vec3::new(-40_000_000, 0, 50_000_000));
    let leg_end = Vec3::new(20_000_000, 0, 50_000_000);
    let mut walk = Walk::new(id, Id::new(Scope([0xc9; 16]), 2).unwrap(), 0);
    let mut corners = BTreeSet::new();
    for t in 0..2_000i64 {
        let me = *b.runner.controller.body(id).unwrap();
        let p = me.pose.position;
        if (p.x - leg_end.x).abs() + (p.z - leg_end.z).abs() < 100_000 {
            assert!(corners.len() >= 2, "it went round the hall: {corners:?}");
            println!("walked to the leg's end in {} ticks round {corners:?}", t);
            return;
        }
        let c = b.town.view().corner(&me, leg_end).unwrap();
        corners.insert(c);
        let (_, stalled) = walk.step(&mut b, t * 50_000);
        assert!(!stalled, "found stalled at tick {t}, at {p:?}");
        // On 70 mm toward its corner.
        let d = i64::try_from(
            (i128::from(c[0] - p.x).pow(2) + i128::from(c[1] - p.z).pow(2)).isqrt(),
        )
        .unwrap();
        let go = d.min(70_000);
        let next = Vec3::new(
            p.x + (c[0] - p.x) * go / d.max(1),
            0,
            p.z + (c[1] - p.z) * go / d.max(1),
        );
        let moved = place(&b.town, next);
        b.runner.controller.regrounded(id, Some(moved)).unwrap();
    }
    panic!("it never reached its leg's end");
}
