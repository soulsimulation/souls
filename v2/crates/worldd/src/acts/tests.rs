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
            door: None,
            ring: None,
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
    let mut walk = Walk::new(id, Id::new(Scope([0xc9; 16]), 2).unwrap());
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
        &sel("nearest", Json::Str("last".into()), None),
        this,
        nobody,
        None,
    );
    let furthest = select_thing(
        tree,
        &Json::Null,
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
        select_thing(tree, &Json::Null, &off, this, nobody, None),
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
    let outside = {
        let id = Id::new(Scope([0xca; 16]), 3).unwrap();
        let frame = Frame {
            node: ground,
            slot: None,
        };
        let b = town.surfaces[&ground]
            .place(id, frame, under, Quat::IDENTITY)
            .unwrap();
        (id, b)
    };
    let split = town.split(1);
    let toward = BTreeMap::new();
    let planning = RefCell::new(Planning::default());
    let sight = Sight {
        bodies: Arc::new(BTreeMap::from([below, on, outside])),
        carrying: Arc::new(BTreeSet::new()),
        tree: split.shared.tree,
        split: Some(RefCell::new(split)),
        builds: Arc::new(
            [below.0, on.0, outside.0]
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
