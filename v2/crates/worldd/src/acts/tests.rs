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
fn fixture_sit_default_uses_live_free_slots_and_preserves_explicit_binding() {
    use replica::bodies::{Class, Family};
    use replica::encode::{Value, decode};
    use replica::moves::Place;
    use sim::controller::Stance;
    use sim::ground::Piece;
    use sim::mover::Surface;
    use sim::slots::{PlaceAt, Slots};
    use skills::form_runner::{Arg, Step};
    let floor = Id::new(Scope([0x74; 16]), 1).unwrap();
    let fixture = Id::new(floor.scope(), 2).unwrap();
    let body = Id::new(floor.scope(), 3).unwrap();
    let first = Id::new(floor.scope(), 4).unwrap();
    let second = Id::new(floor.scope(), 5).unwrap();
    let corners = vec![
        [-5000, 0, -5000],
        [5000, 0, -5000],
        [5000, 0, 5000],
        [-5000, 0, 5000],
    ];
    let surface = Surface::new(
        floor,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: sim::gaits::Ground::Dry,
        }],
    );
    let bytes = replica::effects::fixture_bytes(include_str!(
        "../../../replica/fixtures/bodies/families.diag"
    ))
    .unwrap();
    let Value::Array(families) = decode(&bytes).unwrap().value else {
        panic!("families")
    };
    let family = families
        .iter()
        .map(|f| Family::from_value(f).unwrap())
        .find(|f| f.resources.iter().any(|r| r.class == Class::Manipulator))
        .unwrap();
    let mut controller = Controller::new();
    for id in [body, first, second] {
        let moved = surface
            .place(
                id,
                Frame {
                    node: floor,
                    slot: None,
                },
                Vec3::new(-400_000, 0, 574_000),
                Quat::IDENTITY,
            )
            .unwrap();
        controller.add(family.clone(), moved).unwrap();
    }
    let mut slots = Slots::new();
    for (slot, x) in [(1, -400_000), (2, 400_000)] {
        slots
            .add(PlaceAt {
                thing: fixture,
                place: Place {
                    slot,
                    height: 465_000,
                    stand: [0, 554_000],
                },
                point: Vec3::new(x, 465_000, 20_000),
                facing: Quat::IDENTITY,
                floor,
            })
            .unwrap();
    }
    let entry = seating_entry("bench");
    let bind = |args: &mut skills::form_runner::Args, slots: &Slots, controller: &Controller| {
        bind_fixture_seat(
            &entry,
            "sit",
            args,
            body,
            fixture,
            Some((slots, controller)),
        )
    };
    let mut args = BTreeMap::new();
    bind(&mut args, &slots, &controller).unwrap();
    assert_eq!(args["seat"], Arg::Name("left".into()));
    let steps = skills::form_runner::bind_with(&entry, "sit", &args).unwrap();
    assert!(matches!(&steps[0], Step::WalkTo { point, at, on: None }
        if point.as_str() == "left" && *at == Vec3::new(-400_000, 0, 574_000)));
    assert_eq!(
        steps[1],
        Step::Sit {
            slot: 1,
            lie: false
        }
    );
    assert_eq!(
        slots.holder_in(fixture, 1),
        None,
        "binding does not reserve a slot"
    );

    // A real restored hold changes the default; an explicit choice remains exact, including a taken slot.
    slots
        .restore(&mut controller, first, (fixture, Some(1)), Stance::Sit, 0)
        .unwrap();
    let mut args = BTreeMap::new();
    bind(&mut args, &slots, &controller).unwrap();
    assert_eq!(args["seat"], Arg::Name("right".into()));
    assert_eq!(
        skills::form_runner::bind_with(&entry, "sit", &args).unwrap()[1],
        Step::Sit {
            slot: 2,
            lie: false
        }
    );
    let mut explicit = skills::form_runner::args_in(
        &entry,
        &BTreeMap::new(),
        &BTreeMap::from([("seat".into(), 1)]),
    )
    .unwrap();
    bind(&mut explicit, &slots, &controller).unwrap();
    assert_eq!(explicit["seat"], Arg::Name("left".into()));
    let mut invalid = BTreeMap::from([("seat".into(), Arg::Int(1))]);
    bind(&mut invalid, &slots, &controller).unwrap();
    assert_eq!(
        invalid["seat"],
        Arg::Int(1),
        "an invalid explicit value is not defaulted"
    );
    assert_eq!(
        skills::form_runner::bind_with(&entry, "sit", &invalid)
            .unwrap_err()
            .name,
        "step-malformed"
    );
    assert_eq!(
        skills::form_runner::args_in(
            &entry,
            &BTreeMap::new(),
            &BTreeMap::from([("seat".into(), 0)])
        )
        .unwrap_err()
        .name,
        "slot-unknown"
    );
    assert_eq!(
        skills::form_runner::args_in(
            &entry,
            &BTreeMap::new(),
            &BTreeMap::from([("seat".into(), 3)])
        )
        .unwrap_err()
        .name,
        "slot-unknown"
    );
    slots
        .restore(&mut controller, second, (fixture, Some(2)), Stance::Sit, 0)
        .unwrap();
    let mut args = BTreeMap::new();
    assert_eq!(
        bind(&mut args, &slots, &controller).unwrap_err().name,
        "place-taken"
    );
    assert!(args.is_empty());
    assert_eq!(slots.holder_in(fixture, 1), Some(first));
    assert_eq!(slots.holder_in(fixture, 2), Some(second));
    assert_eq!(
        bind_fixture_seat(&entry, "sit", &mut args, body, fixture, None)
            .unwrap_err()
            .name,
        "place-unknown"
    );
    assert_eq!(
        bind_fixture_seat(
            &entry,
            "sit",
            &mut args,
            floor,
            fixture,
            Some((&slots, &controller))
        )
        .unwrap_err()
        .name,
        "body-unknown"
    );
    assert_eq!(
        bind_fixture_seat(
            &entry,
            "sit",
            &mut args,
            body,
            floor,
            Some((&slots, &controller))
        )
        .unwrap_err()
        .name,
        "place-unknown"
    );
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
