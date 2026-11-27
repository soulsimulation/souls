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

/// A bare lie in a bed, a bunk, a hammock or a sleeping mat (`eden:lie` naming the thing) is the entry's own `lie`
/// form, walked to before it is lain in, as its `sleep` is: before, it was the bare lie move from where the body stood,
/// refused `out-of-reach` everywhere but beside the bed. A bare sit on any of them (none declares a sit form) is not.
#[test]
fn a_bare_lie_in_a_bed_walks_to_it_by_its_own_form() {
    use replica::encode::Value;
    let generated = testworld::generate(1, 0).unwrap();
    let imported = import_eden::load(&generated.text).unwrap();
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let node = Id::new(Scope([0x74; 16]), 1).unwrap();
    for kind in ["bed", "bunk", "hammock", "sleeping_mat"] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../content/kinds/rest")
            .join(format!("{kind}.json"));
        let entry = replica::rules::json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
        let kind_name = entry.get("kind").and_then(Json::str).unwrap();
        let tree = Tree::start(node, Name::new(kind_name).unwrap());
        let acts = Acts::new(
            Json::object([(kind_name, entry.clone())]),
            Vec::new(),
            header.clone(),
            node.scope(),
        );
        let intent = |verb: &str, parameters| WireIntent {
            actor: Actor::Soul(node),
            verb: Name::new(verb).unwrap(),
            target: Some(Target::Node(node)),
            parameters,
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
            fixture_seat(&entry, "lie").is_some(),
            "{kind}: its lie's shape"
        );
        assert!(
            acts.fixture_sit(&tree, &intent("eden:lie", BTreeMap::new())),
            "{kind}: a bare lie walks by its form"
        );
        assert!(!acts.fixture_sit(&tree, &intent("souls:lie", BTreeMap::new())));
        assert!(!acts.fixture_sit(&tree, &intent("eden:sit", BTreeMap::new())));
        assert!(!acts.fixture_sit(
            &tree,
            &intent("eden:lie", BTreeMap::from([(1, Value::Array(Vec::new()))]))
        ));
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
            door: None,
            ring: None,
            aim: None,
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
        bodies: Arc::new(BTreeMap::from([(id, body)])),
        carrying: Arc::new(BTreeSet::new()),
        tree: split.shared.tree,
        split: Some(RefCell::new(split)),
        builds: Arc::new(BTreeMap::from([(id, Build::STANDARD)])),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::from([(id, (intent, 0, 0))]),
        walks: BTreeMap::new(),
        approaches: Default::default(),
        sit_walks: BTreeMap::new(),
        goals: BTreeSet::new(),
        walk_moves: BTreeMap::new(),
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
    // S13d: a walk the planner refuses reaches the form by the planner's own name, not as a walk with no legs.
    assert_eq!(sight.plan_walk(id, 0, ground, goal, 0), WalkPlan::Pending);
    let generation = planning.borrow().current[&walk_key].0.generation;
    planning.borrow_mut().receive(BTreeMap::from([(
        walk_key,
        FormAnswer {
            generation,
            map: Arc::clone(&map),
            result: FormResult::Walk(Err(Refusal {
                name: sim::planner::GROUND_CHANGED,
                detail: String::new(),
            })),
        },
    )]));
    assert_eq!(
        sight.plan_walk(id, 0, ground, goal, 0),
        WalkPlan::Refused(Name::new(sim::planner::GROUND_CHANGED).unwrap())
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
        door: None,
        ring: None,
        aim: None,
    };
    planning.ask(key, body, question(Vec3::ZERO), &map);
    let old = FormAnswer {
        generation: 1,
        map: Arc::clone(&map),
        result: FormResult::Walk(Ok(Vec::new())),
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
        result: FormResult::Walk(Ok(Vec::new())),
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

/// S8: a form's walk question ("where to stand near this thing", C7's 95 % of the planner at 750 agents) is queued
/// by its form every tick until answered, and sent to the planner once while that request is out: counted over ten
/// ticks with the batches not taken, once more after its batch was taken without the answer; a new generation (the
/// body nudged while it waits) waits for the one out, then goes.
#[test]
fn s8_a_form_walk_question_is_sent_once_while_it_is_out() {
    let generated = testworld::generate(1, 0).unwrap();
    let imported = import_eden::load(&generated.text).unwrap();
    let ground = imported.nodes["ground"];
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let town = Town::new(imported.tree, ground, Doors::new(header, imported.rules, 0)).unwrap();
    let id = Id::new(Scope([0xc9; 16]), 1).unwrap();
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
        intent: Id::new(Scope([0xc9; 16]), 2).unwrap(),
        stage: 1,
        step: 2,
        kind: FormKind::Walk,
    };
    let map = Arc::new(town.versions.clone());
    let walk = |x| FormQuery::Walk {
        node: ground,
        at: Vec3::new(x, 0, 0),
        reach: 0,
        door: None,
        ring: None,
        aim: None,
    };
    let mut planning = Planning::default();
    let mut out = BTreeMap::new();
    // One tick: the form asks (its question queued until answered), the queue goes in batch `next`.
    let mut tick = |planning: &mut Planning, x: i64, taken: u64, next: u64| {
        planning.ask(key, body, walk(x), &map);
        crate::bodies::fresh_forms(
            &mut out,
            std::mem::take(&mut planning.queued),
            &BTreeMap::new(),
            taken,
            next,
        )
        .len()
    };
    let sent: usize = (0..10).map(|k| tick(&mut planning, 0, 0, k)).sum();
    assert_eq!(sent, 1, "sent once in ten ticks while out, not once a tick");
    assert_eq!(
        tick(&mut planning, 0, 1, 10),
        1,
        "its batch taken without the answer: sent again"
    );
    assert_eq!(tick(&mut planning, 0, 1, 11), 0);
    // Nudged while batch 10 is out: a new generation every tick, none sent until batch 10 is taken; then the
    // current one goes, once.
    let sent: usize = (12..17).map(|k| tick(&mut planning, k as i64, 1, k)).sum();
    assert_eq!(sent, 0, "a new generation waits for the question out");
    assert_eq!(
        tick(&mut planning, 17, 11, 17),
        1,
        "then the current generation goes"
    );
    assert_eq!(tick(&mut planning, 18, 11, 18), 0);
}

/// S8 review: in a tick the answers are taken first, then the questions the forms queued last tick are sent, and only
/// then do the forms read the answers. A question whose answer has just come back is not sent again: one search
/// per question when the planner keeps up, not two.
#[test]
fn s8_an_answered_form_walk_question_is_not_sent_again_before_its_form_reads_it() {
    let generated = testworld::generate(1, 0).unwrap();
    let imported = import_eden::load(&generated.text).unwrap();
    let ground = imported.nodes["ground"];
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let town = Town::new(imported.tree, ground, Doors::new(header, imported.rules, 0)).unwrap();
    let id = Id::new(Scope([0xc9; 16]), 1).unwrap();
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
        intent: Id::new(Scope([0xc9; 16]), 2).unwrap(),
        stage: 1,
        step: 2,
        kind: FormKind::Walk,
    };
    let map = Arc::new(town.versions.clone());
    let walk = FormQuery::Walk {
        node: ground,
        at: Vec3::ZERO,
        reach: 0,
        door: None,
        ring: None,
        aim: None,
    };
    let mut planning = Planning::default();
    let (mut out, mut answers, mut sent) = (BTreeMap::new(), BTreeMap::new(), 0);
    // Tick 0: the form asks; its question goes in batch 0.
    planning.ask(key, body, walk.clone(), &map);
    let first = crate::bodies::fresh_forms(
        &mut out,
        std::mem::take(&mut planning.queued),
        &answers,
        0,
        0,
    );
    sent += first.len();
    // Tick 1: batch 0 is taken with the answer (`Bodies::take`), then last tick's queue is sent, then the form reads.
    answers.insert(
        key,
        FormAnswer {
            generation: first[0].generation,
            map: Arc::clone(&map),
            result: FormResult::Walk(Ok(Vec::new())),
        },
    );
    planning.ask(key, body, walk.clone(), &map);
    sent += crate::bodies::fresh_forms(
        &mut out,
        std::mem::take(&mut planning.queued),
        &answers,
        1,
        1,
    )
    .len();
    planning.receive(std::mem::take(&mut answers));
    assert!(
        planning.ask(key, body, walk, &map).is_some(),
        "the form has its answer"
    );
    sent += crate::bodies::fresh_forms(
        &mut out,
        std::mem::take(&mut planning.queued),
        &answers,
        2,
        2,
    )
    .len();
    assert_eq!(sent, 1, "one search for the question");
}

/// S11: a form walker waiting for its line is pushed along by the crowd round it. Its question stands while it is on
/// the same floor: asked once, not once a tick, and the line that comes back is its own, read from where it now is.
/// Before, each new pose was a new question, and the answer never matched the question current when it came.
#[test]
fn s11_a_jostled_walkers_line_question_stands_and_its_answer_is_read() {
    let generated = testworld::generate(1, 0).unwrap();
    let imported = import_eden::load(&generated.text).unwrap();
    let ground = imported.nodes["ground"];
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let town = Town::new(imported.tree, ground, Doors::new(header, imported.rules, 0)).unwrap();
    let id = Id::new(Scope([0xc9; 16]), 1).unwrap();
    let at = |x: i64| {
        town.surfaces[&ground]
            .place(
                id,
                Frame {
                    node: ground,
                    slot: None,
                },
                Vec3::new(x, 0, 40_000_000),
                Quat::IDENTITY,
            )
            .unwrap()
    };
    let key = FormKey {
        body: id,
        intent: Id::new(Scope([0xc9; 16]), 2).unwrap(),
        stage: 1,
        step: 2,
        kind: FormKind::Line,
    };
    let map = Arc::new(town.versions.clone());
    let to = Vec3::new(5_000_000, 0, 40_000_000);
    let mut planning = Planning::default();
    // Pushed 90 mm a tick for ten ticks while it waits: one question, one generation.
    let mut asked = Vec::new();
    for k in 0..10 {
        planning.ask(key, at(k * 90_000), FormQuery::Line { to }, &map);
        asked.extend(
            std::mem::take(&mut planning.queued)
                .into_values()
                .map(|q| q.generation),
        );
    }
    asked.dedup();
    assert_eq!(asked.len(), 1, "one question while jostled: {asked:?}");
    // Its answer comes back and is read, the walker 900 mm from where it was asked.
    planning.receive(BTreeMap::from([(
        key,
        FormAnswer {
            generation: asked[0],
            map: Arc::clone(&map),
            result: FormResult::Line(Err(Refusal {
                name: "test.answer",
                detail: String::new(),
            })),
        },
    )]));
    assert!(
        planning.line(key, at(900_000), to, &map).is_some(),
        "the answer is the walker's own"
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
        bodies: Arc::new(BTreeMap::new()),
        carrying: Arc::new(BTreeSet::new()),
        tree,
        split: None,
        builds: Arc::new(BTreeMap::new()),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::new(),
        walks: BTreeMap::from([(id, (2, building, Name::new(point).unwrap()))]),
        approaches: Default::default(),
        sit_walks: BTreeMap::new(),
        goals: BTreeSet::new(),
        walk_moves: BTreeMap::new(),
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
        .area_floor(id, 2, ground, at, skills::form_runner::REACH)
        .expect("a room of a building, on its room's floor");
    assert_eq!(floor, floor1, "the upstairs room's floor");
    assert_eq!(on.y, room_y, "at the room's height, not the point's");
    assert!(
        (on.x - local.x).abs() <= 2 && on.z.abs() <= 2,
        "the point in the building's frame: {on:?}"
    );
    // C22 sweep (#1960): an area that is no room, and that no floor stands a body near (none here: no walk map), is
    // planned as any other point, on the ground under it, as today's game walks to an area.
    assert_eq!(
        sight("attic").area_floor(id, 2, ground, at, skills::form_runner::REACH),
        None,
        "no room, no floor standing a body near it: as any other point"
    );
    assert_eq!(
        sight("door").area_floor(id, 2, ground, at, skills::form_runner::REACH),
        None,
        "not an area: as before"
    );
    assert_eq!(
        sight("r1a").area_floor(id, 3, ground, at, skills::form_runner::REACH),
        None,
        "another step: as before"
    );
}

/// #1960: a point of a thing with floors is carried onto the floor nearest its height. Every floor node stands at the
/// thing's origin, so the height is read from its rooms and surfaces: a point at the upstairs room's height is on the
/// upper floor (an upper landing's door), one at the ground's on the ground floor.
#[test]
fn a_point_upstairs_is_on_the_upper_floor() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let building = imported.nodes["building"];
    let (floor0, floor1) = (
        imported.nodes["building/floor-0"],
        imported.nodes["building/floor-1"],
    );
    let tree = &imported.tree;
    let room_y = tree
        .node(tree.handle(imported.nodes["building/r1a"]).unwrap())
        .unwrap()
        .place()
        .unwrap()
        .position
        .y;
    assert!(room_y > 1_000_000, "the upstairs room is up: {room_y}");
    let kinds = Json::Obj(Vec::new());
    let toward = BTreeMap::new();
    let planning = RefCell::new(Planning::default());
    let sight = Sight {
        bodies: Arc::new(BTreeMap::new()),
        carrying: Arc::new(BTreeSet::new()),
        tree,
        split: None,
        builds: Arc::new(BTreeMap::new()),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::new(),
        walks: BTreeMap::new(),
        approaches: Default::default(),
        goals: BTreeSet::new(),
        walk_moves: BTreeMap::new(),
        sit_walks: BTreeMap::new(),
        planning: &planning,
        map: Arc::new(Versions::default()),
    };
    let up = Vec3::new(1_000_000, room_y + 1_000_000, 0);
    let (floor, on) = sight.floor_of(building, up).expect("a thing with floors");
    assert_eq!(floor, floor1, "a handle 1 m above the upstairs floor");
    assert_eq!((on.x, on.z), (up.x, up.z), "{on:?}");
    let down = Vec3::new(1_000_000, 1_000_000, 0);
    assert_eq!(sight.floor_of(building, down).map(|f| f.0), Some(floor0));
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
        replica::host::Progress::Going
    }
}

/// #1960 cause 1: the gateway walk's stall watch measures against its line's leg's end, never the walk's granted
/// place, which on a route with crossings lies past the leg's end. Here the granted place lies 20 m west and the
/// line goes east round N2's hall to its leg's end: walking it at 1.4 m/s, the walk is never found stalled. Measured
/// against the granted place (or its corner alone), its least way left stops shrinking at the hall's first corner
/// and the backstop ends it there 30 s on.
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
            .place(id, frame, at, Quat::IDENTITY)
            .unwrap()
    };
    let start = place(&town, Vec3::new(-20_000_000, 0, 50_000_000));
    let mut b = Bodies::new(town, 50_000).unwrap();
    let legs = |n: &str| replica::bodies::Resource {
        name: Name::new(n).unwrap(),
        class: replica::bodies::Class::Locomotion,
        slot: None,
    };
    let family = replica::bodies::Family {
        name: Name::new("souls:humanoid").unwrap(),
        resources: vec![legs("souls:leg-left"), legs("souls:leg-right")],
    };
    b.add_body(family.clone(), start).unwrap();
    b.runner.start(id, Box::new(Holds)).unwrap();
    b.runner
        .granted
        .insert(id, Vec3::new(-40_000_000, 0, 50_000_000));
    let leg_end = Vec3::new(20_000_000, 0, 50_000_000);
    let mut walk = Walk::new(
        id,
        Id::new(Scope([0xc9; 16]), 2).unwrap(),
        crate::bodies::WALK,
    );
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
        let d =
            i64::try_from((i128::from(c[0] - p.x).pow(2) + i128::from(c[1] - p.z).pow(2)).isqrt())
                .unwrap();
        let go = d.min(70_000);
        let next = Vec3::new(
            p.x + (c[0] - p.x) * go / d.max(1),
            0,
            p.z + (c[1] - p.z) * go / d.max(1),
        );
        // Stood there by hand: the test is the watch's, not the mover's.
        let moved = place(&b.town, next);
        b.runner.controller.remove(id);
        b.runner.controller.add(family.clone(), moved).unwrap();
    }
    panic!("it never reached its leg's end");
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
        bodies: Arc::new(BTreeMap::new()),
        carrying: Arc::new(BTreeSet::new()),
        tree,
        split: None,
        builds: Arc::new(BTreeMap::new()),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::new(),
        walks: BTreeMap::from([(id, (0, thing, Name::new(point).unwrap()))]),
        sit_walks: BTreeMap::new(),
        approaches: Default::default(),
        goals: BTreeSet::new(),
        walk_moves: BTreeMap::new(),
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

#[test]
/// #3914: a thing argument left out is bound by its selector: the nearest (or furthest) of the set, never the act's
/// node itself; a kind no thing has finds nothing; a selector off the closed list is not read.
fn a_thing_selector_binds_the_nearest_of_its_set() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let tree = &imported.tree;
    let ground = imported.nodes["ground"];
    let kids: Vec<Id> = tree
        .children(tree.handle(ground).unwrap())
        .unwrap()
        .iter()
        .filter_map(|&h| tree.node(h))
        .filter(|n| n.place().is_some())
        .map(|n| n.id())
        .collect();
    assert!(kids.len() >= 3, "things on the ground");
    let this = kids[0];
    let nobody = Id::new(Scope([0xc9; 16]), 1).unwrap();
    let sel = |order: &str, rank: Json, kind: Option<&str>| {
        let mut o = vec![
            ("of".into(), Json::Str("things".into())),
            ("in".into(), Json::Str("parent".into())),
            ("anchor".into(), Json::Str("this".into())),
            ("order".into(), Json::Str(order.into())),
            ("rank".into(), rank),
        ];
        if let Some(k) = kind {
            o.push(("kind".into(), Json::Str(k.into())));
        }
        Json::Obj(o)
    };
    let at = |id: Id| world_at(tree, id).unwrap();
    let d2 = |id: Id| {
        let (a, p) = (at(this), at(id));
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        (d(a.x, p.x) + d(a.y, p.y) + d(a.z, p.z), id)
    };
    let mut by: Vec<(i128, Id)> = tree
        .children(tree.handle(ground).unwrap())
        .unwrap()
        .iter()
        .filter_map(|&h| tree.node(h))
        .map(|n| n.id())
        .filter(|&id| id != this && world_at(tree, id).is_some())
        .map(d2)
        .collect();
    by.sort();
    let nearest = select_thing(
        tree,
        &Json::Null,
        &OnceLock::new(),
        &sel("nearest", Json::Int(1), None),
        this,
        nobody,
        None,
    );
    assert_eq!(nearest, Ok(Some(by[0].1)), "the nearest other thing");
    assert_ne!(nearest, Ok(Some(this)), "never the act's own node");
    let last = select_thing(
        tree,
        &Json::Null,
        &OnceLock::new(),
        &sel("nearest", Json::Str("last".into()), None),
        this,
        nobody,
        None,
    );
    let furthest = select_thing(
        tree,
        &Json::Null,
        &OnceLock::new(),
        &sel("furthest", Json::Int(1), None),
        this,
        nobody,
        None,
    );
    assert_eq!(last, furthest, "the last nearest is the first furthest");
    assert_eq!(
        select_thing(
            tree,
            &Json::Null,
            &OnceLock::new(),
            &sel("nearest", Json::Int(1), Some("test:no_such_kind")),
            this,
            nobody,
            None
        ),
        Ok(None),
        "nothing of the kind: nothing selected"
    );
    let off = Json::Obj(vec![("of".into(), Json::Str("free_slots".into()))]);
    assert_eq!(
        select_thing(
            tree,
            &Json::Null,
            &OnceLock::new(),
            &off,
            this,
            nobody,
            None
        ),
        Err(()),
        "not a thing selector"
    );
}

/// A move's reach counts height: a thing's point straight above a body, on the floor over the one it stands on, is out
/// of reach however near across x and z (a flush through the ceiling), and so is one a storey below a body on the floor
/// above; each from its own floor is in reach. On the open ground, a point 4 m straight overhead is out of reach and
/// one 1 m up is in it.
#[test]
fn a_thing_directly_above_or_below_is_out_of_reach() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let ground = imported.nodes["ground"];
    let (floor0, floor1) = (
        imported.nodes["building/floor-0"],
        imported.nodes["building/floor-1"],
    );
    let building = imported.nodes["building"];
    let (r0, r1) = (
        imported.nodes["building/r0a"],
        imported.nodes["building/r1a"],
    );
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let mut town =
        Town::new(imported.tree, ground, Doors::new(header, imported.rules, 0)).expect("the town");
    let node = |id: Id| town.tree.node(town.tree.handle(id).unwrap()).unwrap();
    let kind = plain(node(r1).kind()).to_owned();
    assert_eq!(kind, plain(node(r0).kind()), "both rooms one kind");
    let point = |x: i128, y: i128, z: i128| {
        Json::Obj(vec![(
            "at_mm".into(),
            Json::Arr(vec![Json::Int(x), Json::Int(y), Json::Int(z)]),
        )])
    };
    // Each room's point: 3 m along z from its origin (clear of the stairwell), on its own floor. The building's two
    // points: 1.5 m out beyond its east wall, one 4 m up (above a hand on the ground), one 1 m up.
    let out = i128::from(testworld::BUILDING_LENGTH / 2 + 1_500);
    let kinds = Json::Obj(vec![
        (
            kind,
            Json::Obj(vec![(
                "points".into(),
                Json::Obj(vec![("p".into(), point(0, 0, 3_000))]),
            )]),
        ),
        (
            plain(node(building).kind()).to_owned(),
            Json::Obj(vec![(
                "points".into(),
                Json::Obj(vec![
                    ("high".into(), point(out, 4_000, 0)),
                    ("low".into(), point(out, 1_000, 0)),
                ]),
            )]),
        ),
    ]);
    let at = |room: Id| node(room).place().unwrap().position;
    let (p0, p1) = (at(r0), at(r1));
    assert_eq!([p0.x, p0.z], [p1.x, p1.z], "the rooms stack");
    assert!(p1.y - p0.y >= 2_500_000, "a storey apart: {p0:?} {p1:?}");
    let soul = |n: u64, floor: Id, y: i64| {
        let id = Id::new(Scope([0xca; 16]), n).unwrap();
        let frame = Frame {
            node: floor,
            slot: None,
        };
        let b = town.surfaces[&floor]
            .place(
                id,
                frame,
                Vec3::new(p0.x, y, p0.z + 3_000_000),
                Quat::IDENTITY,
            )
            .unwrap();
        (id, b)
    };
    let (below, on) = (soul(1, floor0, p0.y), soul(2, floor1, p1.y));
    // On the open ground beside the building, under its two points.
    let place = node(building).place().unwrap();
    let under = place
        .position
        .plus(
            place
                .orientation
                .rotate(Vec3::new(i64::try_from(out).unwrap() * 1000, 0, 0))
                .unwrap(),
        )
        .unwrap();
    let on_ground = |n: u64, at: Vec3| {
        let id = Id::new(Scope([0xca; 16]), n).unwrap();
        let frame = Frame {
            node: ground,
            slot: None,
        };
        let b = town.surfaces[&ground]
            .place(id, frame, at, Quat::IDENTITY)
            .unwrap();
        (id, b)
    };
    let outside = on_ground(3, under);
    // #5063: another Soul on the open ground, 3 m farther out from the building.
    let further = place
        .position
        .plus(
            place
                .orientation
                .rotate(Vec3::new(
                    i64::try_from(out).unwrap() * 1000 + 3_000_000,
                    0,
                    0,
                ))
                .unwrap(),
        )
        .unwrap();
    let beside = on_ground(4, further);
    let split = town.split(1);
    let toward = BTreeMap::new();
    let planning = RefCell::new(Planning::default());
    let sight = Sight {
        bodies: Arc::new(BTreeMap::from([below, on, outside, beside])),
        carrying: Arc::new(BTreeSet::new()),
        tree: split.shared.tree,
        split: Some(RefCell::new(split)),
        builds: Arc::new(
            [below.0, on.0, outside.0, beside.0]
                .into_iter()
                .map(|b| (b, Build::STANDARD))
                .collect(),
        ),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::new(),
        walks: BTreeMap::new(),
        sit_walks: BTreeMap::new(),
        approaches: Default::default(),
        goals: BTreeSet::new(),
        walk_moves: BTreeMap::new(),
        planning: &planning,
        map: Arc::new(Versions::default()),
    };
    let at_point = |body: Id, thing: Id, p: &str| {
        sight
            .distance(body, &Effector::Held, None, thing, &Name::new(p).unwrap())
            .expect("measured")
    };
    let d = |body: Id, thing: Id| at_point(body, thing, "p");
    let reach = 600_000;
    assert!(
        d(below.0, r1) > reach,
        "above, through the ceiling: {}",
        d(below.0, r1)
    );
    assert!(
        d(on.0, r0) > reach,
        "below, through the floor: {}",
        d(on.0, r0)
    );
    assert_eq!(d(on.0, r1), 0, "on its own floor");
    assert_eq!(d(below.0, r0), 0, "on its own floor");
    let (high, low) = (
        at_point(outside.0, building, "high"),
        at_point(outside.0, building, "low"),
    );
    assert!(high > reach, "4 m straight overhead: {high}");
    assert_eq!(low, 0, "1 m up, straight overhead");
    // #5063: what a look or a point beyond its reach may be made at from afar, from the body's own floor only: a room
    // of its storey, not one a storey up or a Soul there; from the open ground beside the building, the building but
    // not a room inside it, behind its walls.
    assert!(sight.seen(below.0, r0), "a room of its own storey");
    assert!(!sight.seen(below.0, r1), "a room a storey up");
    assert!(!sight.seen(below.0, on.0), "a Soul a storey up");
    assert!(sight.seen(on.0, r1), "upstairs, its own storey's room");
    assert!(
        sight.seen(outside.0, building),
        "the building, from the ground beside it"
    );
    assert!(
        !sight.seen(outside.0, r0),
        "a room behind the building's walls"
    );
    assert!(sight.seen(outside.0, beside.0), "a Soul on the open ground");
    assert!(
        !sight.seen(outside.0, below.0),
        "a Soul inside, from outside"
    );
    assert!(
        !sight.seen(below.0, outside.0),
        "a Soul outside, from inside"
    );
}

/// #4330, #4339: a move at a thing argument names that thing for viewers, unless it is in a closed container: the
/// record is seen by everyone, so a hidden thing's id stays out of it (the record keeps the form's own node).
#[test]
fn an_aimed_move_names_a_visible_thing_and_never_a_hidden_one() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let (building, room) = (imported.nodes["building"], imported.nodes["building/r1a"]);
    let tree = &imported.tree;
    let b = tree.node(tree.handle(building).unwrap()).unwrap();
    let closed = Json::Obj(vec![(
        "closed".into(),
        Json::Obj(vec![(
            "audience".into(),
            Json::Obj(vec![("rule".into(), Json::Str("owner".into()))]),
        )]),
    )]);
    let open = Json::Obj(Vec::new());
    let (me, you) = (
        Id::new(Scope([0xca; 16]), 1).unwrap(),
        Id::new(Scope([0xca; 16]), 2).unwrap(),
    );
    let toward = BTreeMap::from([(me, room), (you, building)]);
    let planning = RefCell::new(Planning::default());
    let aimed = |entry: &Json, body: Id, point: &str| {
        let kinds = Json::Obj(vec![(plain(b.kind()).to_owned(), entry.clone())]);
        Sight {
            bodies: Arc::new(BTreeMap::new()),
            carrying: Arc::new(BTreeSet::new()),
            tree,
            split: None,
            builds: Arc::new(BTreeMap::new()),
            kind: Name::new("souls:body").unwrap(),
            kinds: &kinds,
            toward: &toward,
            asked: RefCell::new(BTreeMap::new()),
            context: BTreeMap::new(),
            walks: BTreeMap::new(),
            approaches: Default::default(),
            sit_walks: BTreeMap::new(),
            goals: BTreeSet::new(),
            walk_moves: BTreeMap::new(),
            planning: &planning,
            map: Arc::new(Versions::default()),
        }
        .aimed(body, &Name::new(point).unwrap())
    };
    assert_eq!(
        aimed(&open, me, AT_ARG),
        Some(room),
        "a visible thing is named"
    );
    assert_eq!(
        aimed(&closed, you, AT_ARG),
        Some(building),
        "the closed container itself is seen"
    );
    assert_eq!(
        aimed(&closed, me, AT_ARG),
        None,
        "a thing in a closed container is not named"
    );
    assert_eq!(
        aimed(&open, me, AT_SELF),
        None,
        "a move at the body itself names nothing else"
    );
}

fn content_entry(path: &str) -> Json {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../content/kinds")
        .join(format!("{path}.json"));
    replica::rules::json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// 0.135 E13: a body in a slot of a thing reaches from its seat to the thing's named point, wherever the thing is
/// placed and however it is turned. Content's motorboat and narrowboat, placed far from the origin: the helm reaches
/// the key and the other seats do not, the stern reaches the hatch and the berth and the galley do not, and the
/// answers are the same at two places. Before, a seated body was measured from its seat's frame at zero, which gave
/// the thing's distance from the origin for every seat and every point.
#[test]
fn e13_a_seated_body_reaches_from_its_seat_wherever_the_thing_is() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let tree = &imported.tree;
    let node = |id: Id| tree.node(tree.handle(id).unwrap()).unwrap();
    // Three things away from the origin, each read as a vehicle: the building (60 m west, turned 33°) and the ring
    // (75 m east) as motorboats, a room upstairs in the building as a narrowboat.
    let (west, east, room) = (
        imported.nodes["building"],
        imported.nodes["ring"],
        imported.nodes["building/r1a"],
    );
    for id in [west, east, room] {
        let at = world_at(tree, id).expect("placed");
        assert!(
            at.x.abs().max(at.z.abs()) > 50_000_000,
            "far from the origin: {at:?}"
        );
    }
    let (motorboat, narrowboat) = (
        content_entry("vehicles/motorboat"),
        content_entry("vehicles/narrowboat"),
    );
    let kinds = Json::Obj(vec![
        (plain(node(west).kind()).to_owned(), motorboat.clone()),
        (plain(node(east).kind()).to_owned(), motorboat.clone()),
        (plain(node(room).kind()).to_owned(), narrowboat.clone()),
    ]);
    let slot_of = |entry: &Json, slot: &str| {
        let slots = entry.get("slots").unwrap().obj().unwrap();
        1 + slots.iter().position(|(k, _)| k == slot).unwrap() as u64
    };
    let mut bodies = BTreeMap::new();
    let mut riders = Vec::new();
    let mut ride = |thing: Id, entry: &Json, slot: &'static str, point: &'static str| {
        let id = Id::new(Scope([0xcb; 16]), riders.len() as u64 + 1).unwrap();
        let pose = replica::pose::Pose {
            frame: Frame {
                node: thing,
                slot: Some(slot_of(entry, slot)),
            },
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: replica::pose::Support::Slot,
        };
        let body = Moved {
            id,
            pose,
            linear: Vec3::ZERO,
            piece: 0,
            tri: 0,
        };
        bodies.insert(id, body);
        riders.push((id, thing, slot, point));
    };
    for thing in [west, east] {
        for slot in ["helm", "front", "back_left", "back_right"] {
            ride(thing, &motorboat, slot, "key");
        }
    }
    for slot in ["stern", "berth", "galley"] {
        ride(room, &narrowboat, slot, "hatch");
    }
    let toward = BTreeMap::new();
    let planning = RefCell::new(Planning::default());
    let sight = Sight {
        bodies: Arc::new(bodies.clone()),
        carrying: Arc::new(BTreeSet::new()),
        tree,
        split: None,
        builds: Arc::new(bodies.keys().map(|b| (*b, Build::STANDARD)).collect()),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::new(),
        walks: BTreeMap::new(),
        sit_walks: BTreeMap::new(),
        approaches: Default::default(),
        goals: BTreeSet::new(),
        walk_moves: BTreeMap::new(),
        planning: &planning,
        map: Arc::new(Versions::default()),
    };
    // The press move's reach (content/moves/press.json), the move a motorboat's key and a narrowboat's hatch take.
    let reach = 600_000;
    let mut by_seat = BTreeMap::new();
    for &(body, thing, slot, point) in &riders {
        let d = sight
            .distance(
                body,
                &Effector::Held,
                None,
                thing,
                &Name::new(point).unwrap(),
            )
            .expect("measured");
        println!("E13: seated in {slot}, {d} µm from {point}");
        assert_eq!(
            d <= reach,
            matches!(slot, "helm" | "stern"),
            "{slot} to {point}: {d} µm"
        );
        // The same seat of the same kind gives the same answer wherever the thing is.
        if let Some(was) = by_seat.insert(slot, d) {
            assert_eq!(was, d, "{slot}: the same from another place");
        }
    }
    // 0.135 E20: a steer is at the thing's control point (the motorboat's wheel, the narrowboat's tiller), so the seat
    // decides: the helm and the seat beside it reach the wheel, the back seats do not; only the stern reaches the
    // tiller, not the berth or the galley 7 m off. The steer move's reach (content/moves/steer.json).
    for &(body, thing, slot, point) in &riders {
        let control = if point == "key" { "wheel" } else { "tiller" };
        let d = sight
            .distance(
                body,
                &Effector::Held,
                None,
                thing,
                &Name::new(control).unwrap(),
            )
            .expect("measured");
        println!("E20: seated in {slot}, {d} µm from the {control}");
        assert_eq!(
            d <= reach,
            matches!(slot, "helm" | "front" | "stern"),
            "{slot} to the {control}: {d} µm"
        );
    }
}

/// 0.135 E21: reach to and from a seated, lying or riding Soul is measured from where its body is, its seat's place
/// in the world, not its slot frame's zero. The building (60 m west, turned 33°) read as a long bench: a Soul on its
/// end seat, 1.5 m beyond the east wall and 9.5 m from the bench's origin, is in reach of a Soul standing 0.4 m from
/// that seat, both ways, and out of reach of one standing 2 m from it; a walk to it is planned to its seat. The ring
/// (75 m east) read as content's motorboat: its riders are a seat apart, the helm 0.7 m from the front seat and 1.3 m
/// from the back left, both beyond a press's 0.6 m. Before, every seated body was at its frame's zero: the riders 0
/// apart, the bench's Soul at the building's origin.
#[test]
fn e21_reach_to_a_seated_body_is_from_its_seat() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let ground = imported.nodes["ground"];
    let (bench, boat) = (imported.nodes["building"], imported.nodes["ring"]);
    let header = import_eden::header(imported.nodes["world"], &imported.rules).unwrap();
    let mut town =
        Town::new(imported.tree, ground, Doors::new(header, imported.rules, 0)).expect("the town");
    let node = |id: Id| town.tree.node(town.tree.handle(id).unwrap()).unwrap();
    let end_x = testworld::BUILDING_LENGTH / 2 + 1_500;
    let bench_entry = replica::rules::json::parse(&format!(
        r#"{{"slots":{{"middle":{{"admits":"body","at_mm":[0,450,0]}},"end":{{"admits":"body","at_mm":[{end_x},450,0]}}}}}}"#
    ))
    .unwrap();
    let motorboat = content_entry("vehicles/motorboat");
    let kinds = Json::Obj(vec![
        (plain(node(bench).kind()).to_owned(), bench_entry),
        (plain(node(boat).kind()).to_owned(), motorboat.clone()),
    ]);
    let slot_of = |entry: &Json, slot: &str| {
        let slots = entry.get("slots").unwrap().obj().unwrap();
        1 + slots.iter().position(|(k, _)| k == slot).unwrap() as u64
    };
    let id = |n: u64| Id::new(Scope([0xcd; 16]), n).unwrap();
    let seated = |n: u64, thing: Id, slot: u64| Moved {
        id: id(n),
        pose: replica::pose::Pose {
            frame: Frame {
                node: thing,
                slot: Some(slot),
            },
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: replica::pose::Support::Slot,
        },
        linear: Vec3::ZERO,
        piece: 0,
        tri: 0,
    };
    // On the open ground beside the bench's end seat: a point of the bench's frame carried out.
    let place = node(bench).place().unwrap();
    let out = |x: i64, z: i64| {
        place
            .position
            .plus(
                place
                    .orientation
                    .rotate(Vec3::new(x * 1000, 0, z * 1000))
                    .unwrap(),
            )
            .unwrap()
    };
    let standing = |n: u64, at: Vec3| {
        let frame = Frame {
            node: ground,
            slot: None,
        };
        town.surfaces[&ground]
            .place(id(n), frame, at, Quat::IDENTITY)
            .unwrap()
    };
    let (near, far) = (standing(2, out(end_x, 400)), standing(3, out(end_x, 2_000)));
    let bodies = BTreeMap::from([
        (id(1), seated(1, bench, 2)),
        (id(2), near),
        (id(3), far),
        (id(4), seated(4, boat, slot_of(&motorboat, "helm"))),
        (id(5), seated(5, boat, slot_of(&motorboat, "front"))),
        (id(6), seated(6, boat, slot_of(&motorboat, "back_left"))),
    ]);
    let split = town.split(1);
    let toward = BTreeMap::new();
    let planning = RefCell::new(Planning::default());
    let sight = Sight {
        bodies: Arc::new(bodies.clone()),
        carrying: Arc::new(BTreeSet::new()),
        tree: split.shared.tree,
        split: Some(RefCell::new(split)),
        builds: Arc::new(bodies.keys().map(|b| (*b, Build::STANDARD)).collect()),
        kind: Name::new("souls:body").unwrap(),
        kinds: &kinds,
        toward: &toward,
        asked: RefCell::new(BTreeMap::new()),
        context: BTreeMap::new(),
        walks: BTreeMap::new(),
        sit_walks: BTreeMap::new(),
        approaches: Default::default(),
        goals: BTreeSet::new(),
        walk_moves: BTreeMap::new(),
        planning: &planning,
        map: Arc::new(Versions::default()),
    };
    let d = |from: u64, to: u64| {
        sight
            .distance(
                id(from),
                &Effector::Held,
                None,
                id(to),
                &Name::new("p").unwrap(),
            )
            .expect("measured")
    };
    let reach = 600_000;
    let about = |got: i64, want: i64| (got - want).abs() <= 10_000;
    let (to_near, from_near, to_far) = (d(2, 1), d(1, 2), d(3, 1));
    println!(
        "E21: the bench's end {to_near} µm from the near Soul, {from_near} back, {to_far} from the far one"
    );
    assert!(
        to_near <= reach && about(to_near, 400_000),
        "near to the seated Soul: {to_near}"
    );
    assert!(
        about(from_near, 400_000),
        "the seated Soul to the near one: {from_near}"
    );
    assert!(
        to_far > reach && about(to_far, 2_000_000),
        "far to the seated Soul: {to_far}"
    );
    let (front, back) = (d(4, 5), d(4, 6));
    println!("E21: the helm {front} µm from the front place, {back} from the back left");
    assert!(
        front > reach && about(front, 700_000),
        "helm to front: {front}"
    );
    assert!(
        back > reach && about(back, 1_300_961),
        "helm to back left: {back}"
    );
    // A walk to the bench's Soul is planned to its seat, in the bench's frame.
    let seen = sight.read(id(1)).expect("read");
    assert_eq!(seen.parent, Some(bench));
    assert_eq!(seen.position, Vec3::new(end_x * 1000, 450_000, 0));
}

/// A harvest's basket keeps its count (`picked`, field 28) for F4's sets: its entry's roles are left out with its
/// forms, as the structure's reader leaves them, so the kind loads. Kept, the loader refused the whole entry, and
/// `eden:pick` and `eden:pick_too` were refused `field-unknown` after their press.
#[test]
fn a_harvests_basket_loads_its_count_with_its_roles_left_out() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../content/kinds/together/harvest_together.json");
    let entry = replica::rules::json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(entry.get("roles").is_some(), "the entry has roles");
    let kinds = loaded(&Json::object([("eden:harvest_together", entry)]));
    let names = kinds.admits().into_keys().collect::<Vec<_>>();
    assert_eq!(
        names.len(),
        1,
        "the basket's kind loaded: {:?}",
        kinds.refused()
    );
    let def = kinds.get(&names[0]).expect("its kind");
    let picked = def.state.get(&28).expect("field 28");
    println!("loaded {} with field 28 {}", names[0], picked.name.as_str());
    assert!(picked.name.as_str().ends_with("picked"));
}

/// [`ranked_things`] as #5202 left it: a `here` set read from every node of the tree, each node's place walked to the
/// root on every call. Kept only to show the cells rank the same list.
fn ranked_by_scan(
    tree: &Tree,
    kinds: &Json,
    select: &Json,
    node: Id,
    body: Id,
    body_at: Option<Vec3>,
) -> Result<(Ranked, Option<usize>), ()> {
    let parent = |id: Id| tree.node(tree.handle(id)?)?.parent();
    let here = select.get("in").and_then(Json::str) == Some("here");
    let sets: Vec<Id> = match select.get("in").and_then(Json::str) {
        Some("this") => vec![node],
        // Every node of the tree, narrowed below by reach, building and closed containers.
        Some("here") => Vec::new(),
        Some("parent") => parent(node).into_iter().collect(),
        _ => return Err(()),
    };
    let anchor = match select.get("anchor").and_then(Json::str) {
        Some("me") => world_at(tree, body).or(body_at),
        Some("this") => world_at(tree, node),
        _ => return Err(()),
    };
    let furthest = match select.get("order").and_then(Json::str) {
        Some("nearest") => false,
        Some("furthest") => true,
        _ => return Err(()),
    };
    let rank = match select.get("rank") {
        Some(Json::Int(n)) if *n >= 1 => Some(usize::try_from(*n).map_err(|_| ())?),
        Some(Json::Str(l)) if l == "last" => None,
        _ => return Err(()),
    };
    let kind = select.get("kind").and_then(Json::str);
    let is_body = |id: Id| {
        tree.links_at(id)
            .iter()
            .any(|e| plain(tree.ty(e)) == "souls:body-of")
    };
    let d2 = |a: Vec3, p: Vec3| {
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        d(a.x, p.x) + d(a.y, p.y) + d(a.z, p.z)
    };
    let reach = i128::from(HERE_REACH_MM * 1_000) * i128::from(HERE_REACH_MM * 1_000);
    let handles: Vec<replica::tree::Handle> = if here {
        let mut all = Vec::new();
        let mut stack = vec![tree.root()];
        while let Some(h) = stack.pop() {
            stack.extend(tree.children(h).unwrap_or(&[]));
            all.push(h);
        }
        all
    } else {
        sets.iter()
            .filter_map(|s| tree.children(tree.handle(*s)?))
            .flatten()
            .copied()
            .collect()
    };
    // Here: the same building or ground as the act's node, when both say; never inside a closed container.
    let frame = replica::select::standing(tree, node).ok().map(|f| f.0);
    let same_place = |id: Id| match (frame, replica::select::standing(tree, id)) {
        (Some(f), Ok((g, _))) => f == g,
        _ => true,
    };
    let closed_above = |id: Id| {
        let mut up = parent(id);
        for _ in 0..64 {
            let Some(p) = up else { return false };
            let Some(pn) = tree.node(tree.handle(p).unwrap_or_else(|| tree.root())) else {
                return false;
            };
            if p != node
                && kinds
                    .get(plain(pn.kind()))
                    .and_then(|e| e.get("closed"))
                    .is_some()
            {
                return true;
            }
            up = pn.parent();
        }
        true
    };
    let xz = |a: Vec3, p: Vec3| {
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        d(a.x, p.x) + d(a.z, p.z)
    };
    let of_kind = |n: &replica::tree::NodeRef<'_>| {
        kind.is_none_or(|k| plain(n.kind()) == k || entry_of(n).split('@').next() == Some(k))
    };
    // Every test is pure, so their order changes only the work. `here` reads every node of the tree: its reach is
    // asked before the frame and container walks, which then run only for the few things near the anchor (an even
    // load at 1,000 Souls held the clock for seconds walking every node's frame, many form starts a tick).
    let mut ranked: Vec<(Option<i128>, Id)> = handles
        .into_iter()
        .filter_map(|h| tree.node(h))
        .filter(|n| n.id() != node && n.id() != body)
        .filter(|n| n.audience() == replica::world_model::Audience::Everyone)
        .filter(|n| of_kind(n))
        .filter_map(|n| {
            let p = world_at(tree, n.id());
            if here && anchor.zip(p).is_none_or(|(a, p)| xz(a, p) > reach) {
                return None;
            }
            Some((n, p))
        })
        .filter(|(n, _)| !is_body(n.id()))
        .filter(|(n, _)| !here || (same_place(n.id()) && !closed_above(n.id())))
        .map(|(n, p)| (anchor.zip(p).map(|(a, p)| d2(a, p)), n.id()))
        .collect();
    ranked.sort_by(|(da, a), (db, b)| {
        let by = match (da, db) {
            (Some(x), Some(y)) if furthest => y.cmp(x),
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        by.then(a.cmp(b))
    });
    Ok((ranked, rank))
}

/// A `here` selector: `anchor` (`me` or `this`), `order`, `rank`, and `kind` when given.
fn here_select(anchor: &str, order: &str, rank: Json, kind: Option<&str>) -> Json {
    let mut o = vec![
        ("of".into(), Json::Str("things".into())),
        ("in".into(), Json::Str("here".into())),
        ("anchor".into(), Json::Str(anchor.into())),
        ("order".into(), Json::Str(order.into())),
        ("rank".into(), rank),
    ];
    if let Some(k) = kind {
        o.push(("kind".into(), Json::Str(k.into())));
    }
    Json::Obj(o)
}

/// For each act node of `nodes`: every `here` selector (anchored on a body 1 m east of the node, on a body with no
/// place, or on the node; nearest and furthest; rank 1 of any kind, and the last of the kind of the nearest other
/// thing) ranks the same list from the cells, held across all the calls as a batch of starts holds them, and read
/// afresh, as from every node of the tree. The number of lists compared and of those not empty.
fn here_same_as_scan(tree: &Tree, kinds: &Json, nodes: &[Id]) -> (usize, usize) {
    let held = OnceLock::new();
    let nobody = Id::new(Scope([0xc9; 16]), 1).unwrap();
    let (mut compared, mut found) = (0, 0);
    for &node in nodes {
        let at = world_at(tree, node);
        let body_at = at.map(|p| Vec3::new(p.x + 1_000_000, p.y, p.z));
        let any = here_select("this", "nearest", Json::Int(1), None);
        let nearest_kind = ranked_by_scan(tree, kinds, &any, node, nobody, body_at)
            .ok()
            .and_then(|(r, _)| r.first().map(|(_, id)| *id))
            .and_then(|id| tree.node(tree.handle(id)?))
            .map(|n| plain(n.kind()).to_owned());
        for (anchor, body_at) in [("me", body_at), ("me", None), ("this", body_at)] {
            for order in ["nearest", "furthest"] {
                for (rank, kind) in [
                    (Json::Int(1), None),
                    (Json::Str("last".into()), nearest_kind.as_deref()),
                ] {
                    let select = here_select(anchor, order, rank, kind);
                    let scan = ranked_by_scan(tree, kinds, &select, node, nobody, body_at);
                    let cells = ranked_things(tree, kinds, &held, &select, node, nobody, body_at);
                    assert_eq!(cells, scan, "{select:?} from {node:?}");
                    let fresh = ranked_things(
                        tree,
                        kinds,
                        &OnceLock::new(),
                        &select,
                        node,
                        nobody,
                        body_at,
                    );
                    assert_eq!(fresh, scan, "{select:?} from {node:?}, read afresh");
                    compared += 1;
                    found += usize::from(scan.is_ok_and(|(r, _)| !r.is_empty()));
                }
            }
        }
    }
    (compared, found)
}

/// Every node of `tree` with a place, in the tree's order.
fn placed(tree: &Tree) -> Vec<Id> {
    let mut out = Vec::new();
    let mut stack = vec![tree.root()];
    while let Some(h) = stack.pop() {
        stack.extend(tree.children(h).unwrap_or(&[]));
        if let Some(n) = tree.node(h)
            && world_at(tree, n.id()).is_some()
        {
            out.push(n.id());
        }
    }
    out
}

/// #5202's follow-up: a `here` selector reads the nodes from the cells around its anchor ([`Here`]), and ranks the
/// same list as from every node of the tree: the synthetic world, from every placed node.
#[test]
fn a_here_selector_ranks_the_same_from_the_cells_as_from_every_node() {
    let generated = testworld::generate(1, 0).expect("the synthetic world");
    let imported = import_eden::load(&generated.text).expect("the imported world");
    let nodes = placed(&imported.tree);
    let (compared, found) = here_same_as_scan(&imported.tree, &Json::Null, &nodes);
    println!(
        "{compared} lists compared, {found} not empty, from {} nodes",
        nodes.len()
    );
    assert!(
        found * 2 >= compared,
        "most lists find something: {found} of {compared}"
    );
}

/// The entries under `content/kinds`, by kind, as the world reads them, and as texts for the import.
fn content_kinds() -> (Json, Vec<(String, String)>) {
    fn walk(dir: &std::path::Path, out: &mut Vec<(String, Json)>) {
        let mut paths: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| Some(e.ok()?.path()))
            .collect();
        paths.sort();
        for p in paths {
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "json") {
                let text = std::fs::read_to_string(&p).unwrap();
                let Ok(v) = replica::rules::json::parse(&text) else {
                    continue;
                };
                if v.get("format").and_then(Json::str) == Some("souls-entry/1")
                    && let Some(kind) = v.get("kind").and_then(Json::str)
                {
                    out.push((kind.to_owned(), v.clone()));
                }
            }
        }
    }
    let mut all = Vec::new();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    walk(&dir, &mut all);
    let texts = all.iter().map(|(k, e)| (k.clone(), e.to_json())).collect();
    (Json::Obj(all), texts)
}

/// [`a_here_selector_ranks_the_same_from_the_cells_as_from_every_node`] on the whole of Eden 2026 (about 11,000
/// nodes) with the world's own entries, from every 40th placed node. Needs the facts file: `$EDEN_FACTS`, else
/// `.local/import-eden/eden-2026.facts.json` (`v2/tools/import-eden/export`).
#[test]
#[ignore = "needs the Eden 2026 facts file"]
fn a_here_selector_ranks_the_same_from_the_cells_on_all_of_eden() {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let path = std::env::var("EDEN_FACTS")
        .unwrap_or_else(|_| format!("{root}/.local/import-eden/eden-2026.facts.json"));
    let facts = std::fs::read_to_string(path).expect("the Eden 2026 facts file");
    let (kinds, texts) = content_kinds();
    let imported = import_eden::load_with(&facts, &texts).expect("Eden imports");
    let all = placed(&imported.tree);
    let nodes: Vec<Id> = all.iter().step_by(40).copied().collect();
    let (compared, found) = here_same_as_scan(&imported.tree, &kinds, &nodes);
    println!(
        "{compared} lists compared, {found} not empty, from {} of {} placed nodes",
        nodes.len(),
        all.len()
    );
    assert!(all.len() > 5_000, "all of Eden: {}", all.len());
    assert!(
        found * 2 >= compared,
        "most lists find something: {found} of {compared}"
    );
}
