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
    let view = town.view();
    let planned = view.plan(&body, ground, goal).expect("a way through");
    assert_eq!(planned.iter().filter(|l| l.link.is_some()).count(), 2);
    let kinds = Json::Obj(Vec::new());
    let toward = BTreeMap::new();
    let planning = RefCell::new(Planning::default());
    let sight = Sight {
        bodies: BTreeMap::from([(id, body)]),
        carrying: BTreeSet::new(),
        tree: view.tree,
        view: Some(view),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::from([(id, (intent, 0, 0))]),
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
