use super::*;

use replica::pose::{Frame, Quat};
use sim::links::Doors;
use sim::walk::town::Town;

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
        goals: BTreeSet::new(),
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
        goals: BTreeSet::new(),
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

/// C22 sweep: a land feature drawn in the world's frame (placed at its parent's origin) has its entry's points laid on
/// its own line or outline: a bridge's ends at its path's ends, a pond's shore round its own water, not round the
/// world's origin.
#[test]
fn an_entrys_points_are_laid_on_a_world_drawn_line_or_outline() {
    let m = 1_000_000;
    let bounds = Vec3::new(10 * m, 3 * m, 4 * m);
    // A line 20 m along x from (100, 50) m: the entry's ends at ±5 m reach its ends; 1 m across is 1 m to its left.
    let line = [[100 * m, 50 * m], [120 * m, 50 * m]];
    assert_eq!(
        on_line(Vec3::new(-5 * m, 0, 0), bounds, &line),
        Some(Vec3::new(100 * m, 0, 50 * m))
    );
    assert_eq!(
        on_line(Vec3::new(5 * m, 1_400_000, m), bounds, &line),
        Some(Vec3::new(120 * m, 1_400_000, 51 * m))
    );
    // Turned a quarter: along z.
    let up = [[0, 0], [0, 20 * m]];
    assert_eq!(
        on_line(Vec3::new(5 * m, 0, m), bounds, &up),
        Some(Vec3::new(-m, 0, 20 * m))
    );
    assert_eq!(on_line(Vec3::ZERO, bounds, &[[m, m], [m, m]]), None);
    // An outline 20 m by 8 m round (-6, 112) m: a pond's shore point 19 m out of its 36 m bounds lands just past its
    // own bank, 10.56 m from its middle.
    let pond = Vec3::new(36 * m, 6 * m, 36 * m);
    let outline = [
        [-16 * m, 108 * m],
        [4 * m, 108 * m],
        [4 * m, 116 * m],
        [-16 * m, 116 * m],
    ];
    assert_eq!(
        on_outline(Vec3::new(19 * m, 0, 0), pond, &outline),
        Some(Vec3::new(-6 * m + 10_555_555, 0, 112 * m))
    );
    assert_eq!(
        on_outline(Vec3::new(0, 0, -19 * m), pond, &outline),
        Some(Vec3::new(-6 * m, 0, 112 * m - 4_222_222))
    );
}

/// The same through the world's walk: the test world's square (an area drawn in the world's frame) has a walk to its
/// entry's point laid on its outline; another step, or a thing not drawn in the world's frame, is planned as before.
#[test]
fn a_walk_to_a_world_drawn_things_point_is_laid_on_its_outline() {
    let generated = testworld::generate(1, 0).unwrap();
    let imported = import_eden::load(&generated.text).unwrap();
    let ground = imported.nodes["ground"];
    let square = imported.nodes["square"];
    let tree = &imported.tree;
    let n = tree.node(tree.handle(square).unwrap()).unwrap();
    let kind = plain(n.kind()).to_owned();
    let Some(replica::encode::Value::Array(rows)) = n.fields().get(&import_eden::F_OUTLINE) else {
        panic!("the square's outline");
    };
    let xs: Vec<i64> = rows
        .iter()
        .filter_map(|r| match r {
            replica::encode::Value::Array(c) => int_of(&c[0]),
            _ => None,
        })
        .collect();
    let (x0, x1) = (*xs.iter().min().unwrap(), *xs.iter().max().unwrap());
    let kinds = replica::rules::json::parse(&format!(
        r#"{{ "{kind}": {{ "geometry": {{ "bounds_mm": [10000, 100, 10000] }},
          "areas": {{ "east": {{ "at_mm": [5000, 0, 0] }} }} }} }}"#
    ))
    .unwrap();
    let id = Id::new(Scope([0xca; 16]), 1).unwrap();
    let toward = BTreeMap::new();
    let planning = RefCell::new(Planning::default());
    let sight = |thing: Id, point: &str| Sight {
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
        walks: BTreeMap::from([(id, (0, thing, Name::new(point).unwrap()))]),
        sit_walks: BTreeMap::new(),
        goals: BTreeSet::new(),
        planning: &planning,
        map: Arc::new(Versions::default()),
    };
    let on = sight(square, "east")
        .on_shape(id, 0, ground)
        .expect("laid on the outline");
    assert_eq!(
        on.x,
        x1 * 1000,
        "the east area at the outline's east edge ({x0}..{x1} mm)"
    );
    assert_eq!(
        sight(square, "east").on_shape(id, 1, ground),
        None,
        "another step"
    );
    assert_eq!(
        sight(square, "west").on_shape(id, 0, ground),
        None,
        "no such point"
    );
    assert_eq!(
        sight(imported.nodes["ring"], "east").on_shape(id, 0, ground),
        None,
        "placed off the origin"
    );
}
