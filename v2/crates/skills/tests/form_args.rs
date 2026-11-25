//! F14's checks (#3384): a step aimed at an argument (a name the kind declares, or a thing whose place the runner reads
//! when the step starts), a `set` that writes a name, an argument's id or a text reference, and a point a form names
//! that its kind does not declare refused at import. The entries are written here; the last check runs over every
//! entry in `content/kinds`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::Path;

use replica::audience::REFERENCE;
use replica::effects::{Change, Event, Refusal};
use replica::encode::{Name, Value as Cbor};
use replica::host::{Answer, Ask, Host, Seen};
use replica::ids::Id;
use replica::pose::{ControllerInput, Vec3, fixture};
use replica::rules::json::{Value, parse};
use replica::time::Micros;

use skills::form_runner::{
    Arg, Args, Effect, Limits, Next, Runner, Step, Woke, bind_effects_args, bind_with, check,
};

const ENTRY: &str = r#"{
  "format": "souls-entry/1", "kind": "test:frame", "owner": "thing",
  "state": {
    "mode": {"n": 1, "type": "enum", "values": ["low", "high"], "default": "low", "audience": {"rule": "everyone"}},
    "note": {"n": 2, "type": "text", "default": null, "audience": {"rule": "everyone"}},
    "left": {"n": 3, "type": "enum", "values": ["low", "high"], "default": "low", "audience": {"rule": "everyone"}},
    "right": {"n": 4, "type": "enum", "values": ["low", "high"], "default": "low", "audience": {"rule": "everyone"}},
    "count": {"n": 5, "type": "int", "default": 0, "audience": {"rule": "everyone"}}
  },
  "points": {
    "front": {"role": "stand", "at_mm": [0, 0, 600]},
    "left": {"role": "contact", "at_mm": [-300, 500, 0]},
    "right": {"role": "contact", "at_mm": [300, 500, 0]}
  },
  "slots": {"place_1": {"admits": "body", "at_mm": [0, 450, 0], "stand": "front"}, "rack": {"admits": "thing", "at_mm": [0, 900, -100]}},
  "areas": {"under": {"at_mm": [0, 0, -2000], "radius_mm": 800}},
  "forms": {
    "go": {"who": "anyone", "starts": "act", "takes": {"spot": {"type": "part"}},
      "steps": [{"step": "walk_to", "point": {"arg": "spot"}}], "effects": []},
    "visit": {"who": "anyone", "starts": "act", "takes": {"other": {"type": "thing"}},
      "steps": [{"step": "walk_to", "point": {"arg": "other"}}, {"step": "move", "move": "press", "at": {"arg": "other"}}], "effects": []},
    "tap": {"who": "anyone", "starts": "act", "takes": {"side": {"type": "field", "of": ["left", "right"]}, "to": {"type": "value", "of": ["low", "high"]}},
      "steps": [{"step": "move", "move": "press", "at": {"arg": "side"}}],
      "effects": [{"change": "set", "field": {"arg": "side"}, "to": {"arg": "to"}, "event": "tapped"}]},
    "stretch": {"who": "anyone", "starts": "act", "steps": [{"step": "move", "move": "stretch"}], "effects": []},
    "grab": {"who": "anyone", "starts": "act", "steps": [{"step": "take"}], "effects": []},
    "raise": {"who": "anyone", "starts": "act", "steps": [{"step": "walk_to", "point": "under"}],
      "effects": [{"change": "set", "field": "mode", "to": "high", "event": "raised"}]},
    "sit": {"who": "anyone", "starts": "act", "steps": [{"step": "walk_to", "point": "place_1"}], "effects": []},
    "write": {"who": "anyone", "starts": "act", "takes": {"words": {"type": "text"}},
      "steps": [{"step": "walk_to", "point": "front"}],
      "effects": [{"change": "set", "field": "note", "to": {"arg": "words"}, "event": "written"}]},
    "wipe": {"who": "anyone", "starts": "act", "steps": [{"step": "walk_to", "point": "front"}],
      "effects": [{"change": "set", "field": "note", "to": null, "event": "wiped"}]},
    "mark": {"who": "anyone", "starts": "act", "takes": {"by": {"type": "thing"}},
      "steps": [{"step": "walk_to", "point": "front"}],
      "effects": [{"change": "set", "field": "count", "to": {"arg": "by"}, "event": "marked"}]}
  }
}"#;

fn entry() -> Value {
    parse(ENTRY).expect("JSON")
}

fn node() -> Id {
    fixture(2)
}
fn other() -> Id {
    fixture(3)
}

fn args(pairs: &[(&str, Arg)]) -> Args {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect()
}

fn mm(x: i64, y: i64, z: i64) -> Vec3 {
    Vec3::new(x * 1000, y * 1000, z * 1000)
}

/// A host where the node and one other thing stand; the other thing's place can change.
struct Fake {
    places: BTreeMap<Id, Vec3>,
    next: u64,
    /// What the runner read, and where it stood then.
    reads: RefCell<Vec<(Id, Option<Vec3>)>>,
    /// Whether the body is within a hand's reach of the node, as the world would say (`None`: it does not say).
    reach: Option<bool>,
}

impl Host for Fake {
    fn now(&self) -> Micros {
        0
    }
    fn body(&self) -> Id {
        fixture(1)
    }
    fn read(&self, n: Id) -> Option<Seen> {
        self.reads
            .borrow_mut()
            .push((n, self.places.get(&n).copied()));
        Some(Seen {
            id: n,
            kind: Name::new("test:node").expect("a name"),
            parent: None,
            position: *self.places.get(&n)?,
            fields: BTreeMap::new(),
        })
    }
    fn ask(&self, _: &Ask) -> Option<Answer> {
        None
    }
    fn within_reach(&self, _: Id) -> Option<bool> {
        self.reach
    }
    fn set_timer(&mut self, _: Micros, _: Name) -> Id {
        self.next += 1;
        fixture(100 + self.next)
    }
    fn clear_timer(&mut self, _: Id) {}
    fn draw(&mut self) -> u64 {
        0
    }
    fn control(&mut self, _: ControllerInput) {}
    fn cross(&mut self, _: Id, _: i64) {}
    fn emit(&mut self, _: Vec<Change>, _: Option<Event>) -> Result<(), Refusal> {
        Ok(())
    }
}

fn refused<T: std::fmt::Debug>(r: Result<T, Refusal>) -> (&'static str, String) {
    let r = r.expect_err("refused");
    (r.name, r.detail)
}

#[test]
fn a1_a_step_aims_at_a_name_argument_as_the_point_it_names() {
    let e = entry();
    let steps = bind_with(&e, "go", &args(&[("spot", Arg::Name("left".into()))])).expect("binds");
    println!("go with spot=left: {steps:?}");
    assert!(
        matches!(&steps[..], [Step::WalkTo { point, at, on: None, .. }]
        if point.as_str() == "left" && *at == mm(-300, 500, 0))
    );
    // A slot is walked to at its stand point; a placed area at its place.
    let slot =
        bind_with(&e, "go", &args(&[("spot", Arg::Name("place_1".into()))])).expect("a slot");
    let area = bind_with(&e, "go", &args(&[("spot", Arg::Name("under".into()))])).expect("an area");
    println!("slot {slot:?}, area {area:?}");
    assert!(matches!(&slot[..], [Step::WalkTo { at, .. }] if *at == mm(0, 0, 600)));
    assert!(matches!(&area[..], [Step::WalkTo { at, .. }] if *at == mm(0, 0, -2000)));
    // A field argument used as a place: the point of the chosen field's name.
    let tap = bind_with(
        &e,
        "tap",
        &args(&[
            ("side", Arg::Name("right".into())),
            ("to", Arg::Name("high".into())),
        ]),
    )
    .expect("binds");
    // The move at the chosen point, after the walk to it the binding adds (#3688).
    assert!(matches!(&tap[..], [
        Step::WalkTo { point, approach: true, .. },
        Step::Move { at: Some(at), on: None, .. },
    ] if point.as_str() == "right" && at.as_str() == "right"));
    // Refused by name: a choice the kind does not declare, an argument not given, a thing where a name is wanted.
    let (name, detail) = refused(bind_with(
        &e,
        "go",
        &args(&[("spot", Arg::Name("roof".into()))]),
    ));
    assert_eq!((name, detail.as_str()), ("point-unknown", "roof"));
    assert_eq!(refused(bind_with(&e, "go", &Args::new())).0, "arg-missing");
    assert_eq!(
        refused(bind_with(&e, "go", &args(&[("spot", Arg::Int(3))]))).0,
        "step-malformed"
    );
}

#[test]
fn a1_a_thing_argument_is_resolved_at_the_step_start() {
    let e = entry();
    let steps = bind_with(&e, "visit", &args(&[("other", Arg::Node(other()))])).expect("binds");
    assert!(matches!(
        &steps[..],
        [Step::WalkTo { on: Some(a), .. }, Step::Move { at: None, on: Some(b), .. }] if *a == other() && *b == other()
    ));
    // Bound while the thing stood at one place; it moves before the run starts: the walk goes where it is then.
    let mut h = Fake {
        places: BTreeMap::from([(node(), mm(1, 0, 1)), (other(), mm(5, 0, 5))]),
        next: 0,
        reads: RefCell::default(),
        reach: None,
    };
    let mut r = Runner::new(steps, node(), Limits::default());
    h.places.insert(other(), mm(-7, 0, 2));
    let Next::Walk(_) = r.wake(&mut h, Woke::Start) else {
        panic!("a walk first")
    };
    let reads = h.reads.borrow().clone();
    println!("read at the walk's start: {reads:?}");
    assert_eq!(
        reads,
        vec![(other(), Some(mm(-7, 0, 2)))],
        "the thing, where it stands now"
    );
    // The move is aimed at the thing itself, with the move's own contact.
    let next = r.wake(&mut h, Woke::Walked(replica::host::Progress::Done));
    match next {
        Next::Move { node: n, at, .. } => assert_eq!((n, at), (other(), None)),
        _ => panic!("a move at the thing"),
    }
    // A thing argument that is gone when the step starts ends the run by name.
    let mut gone = Runner::new(
        bind_with(&e, "visit", &args(&[("other", Arg::Node(fixture(9)))])).expect("binds"),
        node(),
        Limits::default(),
    );
    assert!(matches!(gone.wake(&mut h, Woke::Start), Next::End(n) if n.as_str() == "node-gone"));
}

#[test]
fn a1_a_move_with_no_point_and_a_take_with_no_move() {
    let e = entry();
    let stretch = bind_with(&e, "stretch", &Args::new()).expect("binds");
    assert!(matches!(
        &stretch[..],
        [Step::Move {
            at: None,
            on: None,
            ..
        }]
    ));
    let grab = bind_with(&e, "grab", &Args::new()).expect("binds");
    assert_eq!(&grab[1..], &[Step::Hand], "after its approach (#4086)");
    // A hand step with no move: its contact, the effect's instant, is its start, and the run ends done. The body is
    // within reach, so the approach is not walked.
    let mut h = Fake {
        places: BTreeMap::from([(node(), Vec3::ZERO)]),
        next: 0,
        reads: RefCell::default(),
        reach: Some(true),
    };
    let mut r = Runner::new(grab, node(), Limits::default());
    let next = r.wake(&mut h, Woke::Start);
    assert!(matches!(next, Next::End(n) if n.as_str() == "done"));
    assert!(r.take_effect(), "the effect's instant came");
    assert!(!r.take_effect(), "once");
}

/// #4086, #4118: no take at a distance. A bare `take` (a hand step with no move, as 60 entries in `content/kinds`
/// write it) binds to an approach to its thing, then the hand step. A body within reach takes at once, with no walk;
/// one beyond reach walks first, and its hand's contact needs the thing within reach when the walk ends: a walk that
/// stops short, or an approach that finds no way, ends `out-of-reach` with nothing taken.
#[test]
fn w10_a_bare_take_walks_to_its_thing_first_and_takes_only_within_reach() {
    use replica::host::Progress;
    let grab = bind_with(&entry(), "grab", &Args::new()).expect("binds");
    println!("grab: {grab:?}");
    assert!(
        matches!(
            &grab[..],
            [Step::WalkTo { approach: true, at, on: None, .. }, Step::Hand] if *at == Vec3::ZERO
        ),
        "an approach to the thing's own place, then the hand step"
    );
    let host = |reach| Fake {
        places: BTreeMap::from([(node(), mm(5000, 0, 0))]),
        next: 0,
        reads: RefCell::default(),
        reach,
    };
    // Beyond reach: the body walks to the thing first, and takes it there.
    let (mut h, mut r) = (
        host(Some(false)),
        Runner::new(grab.clone(), node(), Limits::default()),
    );
    assert!(
        matches!(r.wake(&mut h, Woke::Start), Next::Walk(_)),
        "walks to the thing"
    );
    assert!(!r.take_effect(), "nothing taken before the walk ends");
    h.reach = Some(true);
    assert!(
        matches!(r.wake(&mut h, Woke::Walked(Progress::Done)), Next::End(n) if n.as_str() == "done")
    );
    assert!(r.take_effect(), "taken once there");
    // The walk ended and the thing is still beyond reach (it stopped short, or the thing was moved): nothing taken.
    let (mut h, mut r) = (
        host(Some(false)),
        Runner::new(grab.clone(), node(), Limits::default()),
    );
    assert!(matches!(r.wake(&mut h, Woke::Start), Next::Walk(_)));
    let end = r.wake(&mut h, Woke::Walked(Progress::Done));
    assert!(
        matches!(&end, Next::End(n) if n.as_str() == "out-of-reach"),
        "refused at contact"
    );
    assert!(!r.take_effect(), "nothing taken from afar");
    // The approach finds no way (the move is tried from where the body stands): still nothing taken from afar.
    struct NoWay(Fake);
    impl Host for NoWay {
        fn now(&self) -> Micros {
            self.0.now()
        }
        fn body(&self) -> Id {
            self.0.body()
        }
        // On a ground (another node), so the world is asked for the way.
        fn read(&self, n: Id) -> Option<Seen> {
            let mut seen = self.0.read(n)?;
            seen.parent = Some(other());
            Some(seen)
        }
        fn ask(&self, q: &Ask) -> Option<Answer> {
            self.0.ask(q)
        }
        fn within_reach(&self, n: Id) -> Option<bool> {
            self.0.within_reach(n)
        }
        fn plan_walk(&self, _: usize, _: Id, _: Vec3, _: i64) -> replica::host::WalkPlan {
            replica::host::WalkPlan::Legs(Vec::new())
        }
        fn set_timer(&mut self, after: Micros, n: Name) -> Id {
            self.0.set_timer(after, n)
        }
        fn clear_timer(&mut self, id: Id) {
            self.0.clear_timer(id);
        }
        fn draw(&mut self) -> u64 {
            self.0.draw()
        }
        fn control(&mut self, input: ControllerInput) {
            self.0.control(input);
        }
        fn cross(&mut self, id: Id, speed: i64) {
            self.0.cross(id, speed);
        }
        fn emit(&mut self, c: Vec<Change>, e: Option<Event>) -> Result<(), Refusal> {
            self.0.emit(c, e)
        }
    }
    let (mut h, mut r) = (
        NoWay(host(Some(false))),
        Runner::new(grab, node(), Limits::default()),
    );
    let end = r.wake(&mut h, Woke::Start);
    assert!(
        matches!(&end, Next::End(n) if n.as_str() == "out-of-reach"),
        "no way, and out of reach"
    );
    assert!(!r.take_effect(), "nothing taken from afar");
}

#[test]
fn a2_a_set_writes_a_name_an_id_or_a_text_reference() {
    let e = entry();
    let set = |form: &str, a: &Args| bind_effects_args(&e, form, a);
    // An enum's value by name, written as a name in the kind's namespace (C24: the log's only text is a name).
    let raise = set("raise", &Args::new()).expect("binds");
    println!("raise: {raise:?}");
    assert_eq!(
        raise,
        vec![Effect::Set {
            field: 1,
            to: Cbor::Text(Name::new("test:high").expect("a name"))
        }]
    );
    // A field argument chooses the field; a value argument the value.
    let tap = set(
        "tap",
        &args(&[
            ("side", Arg::Name("right".into())),
            ("to", Arg::Name("high".into())),
        ]),
    )
    .expect("binds");
    assert_eq!(
        tap,
        vec![Effect::Set {
            field: 4,
            to: Cbor::Text(Name::new("test:high").expect("a name"))
        }]
    );
    // Words by their reference (K16): `{21: id}`, never the words.
    let words = fixture(40);
    let write = set("write", &args(&[("words", Arg::Text(words))])).expect("binds");
    assert_eq!(
        write,
        vec![Effect::Set {
            field: 2,
            to: Cbor::Map(BTreeMap::from([(REFERENCE, words.to_value())]))
        }]
    );
    // No words: no reference.
    let wipe = set("wipe", &Args::new()).expect("binds");
    assert_eq!(
        wipe,
        vec![Effect::Set {
            field: 2,
            to: Cbor::Map(BTreeMap::new())
        }]
    );
    // An argument's id.
    let mark = set("mark", &args(&[("by", Arg::Node(other()))])).expect("binds");
    assert_eq!(
        mark,
        vec![Effect::Set {
            field: 5,
            to: other().to_value()
        }]
    );
    // Refused by name: a value the field does not list, an argument not given, a name for a text field.
    let r = set(
        "tap",
        &args(&[
            ("side", Arg::Name("left".into())),
            ("to", Arg::Name("middle".into())),
        ]),
    );
    assert_eq!(refused(r), ("not-allowed", "left: middle".into()));
    assert_eq!(refused(set("write", &Args::new())).0, "arg-missing");
    let r = set("write", &args(&[("words", Arg::Name("low".into()))]));
    assert_eq!(refused(r).0, "not-allowed");
}

#[test]
fn a3_a_point_the_kind_does_not_declare_is_refused_at_import() {
    assert_eq!(check(&entry()), Ok(()));
    let named = ENTRY.replace(r#""point": "under""#, r#""point": "attic""#);
    let r = check(&parse(&named).expect("JSON")).expect_err("refused");
    assert_eq!(
        (r.name, r.detail.as_str()),
        ("point-unknown", "raise: attic")
    );
    // A field argument used as a place: every choice it lists must be declared.
    let chosen = ENTRY.replace(r#""of": ["left", "right"]"#, r#""of": ["left", "top"]"#);
    let r = check(&parse(&chosen).expect("JSON")).expect_err("refused");
    assert_eq!((r.name, r.detail.as_str()), ("point-unknown", "tap: top"));
}

#[test]
fn a3_every_content_entry_passes_the_import_check() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let mut seen = 0;
    let mut refused = Vec::new();
    for family in std::fs::read_dir(&root).expect("content/kinds") {
        let family = family.expect("a family").path();
        let Ok(files) = std::fs::read_dir(&family) else {
            continue;
        };
        for f in files {
            let f = f.expect("a file").path();
            if f.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(e) = parse(&std::fs::read_to_string(&f).expect("read")) else {
                continue;
            };
            if e.get("forms").is_none() {
                continue;
            }
            seen += 1;
            if let Err(r) = check(&e) {
                refused.push(format!("{}: {} {}", f.display(), r.name, r.detail));
            }
        }
    }
    println!("{seen} entries with forms checked; refused: {refused:#?}");
    assert!(seen > 300, "the content is there: {seen}");
    assert!(refused.is_empty(), "{refused:#?}");
}

#[test]
fn deferred_walk_keeps_its_deadline_and_reads_a_moved_target_again() {
    use replica::host::WalkPlan;
    struct Pending {
        fake: Fake,
        ready: bool,
        asked: RefCell<Vec<Vec3>>,
    }
    impl Host for Pending {
        fn now(&self) -> Micros {
            self.fake.now()
        }
        fn body(&self) -> Id {
            self.fake.body()
        }
        fn read(&self, n: Id) -> Option<Seen> {
            let mut seen = self.fake.read(n)?;
            seen.parent = Some(fixture(0));
            Some(seen)
        }
        fn ask(&self, q: &Ask) -> Option<Answer> {
            self.fake.ask(q)
        }
        fn plan_walk(&self, _: usize, _: Id, at: Vec3, _: i64) -> WalkPlan {
            self.asked.borrow_mut().push(at);
            if self.ready {
                WalkPlan::Legs(vec![(at, None)])
            } else {
                WalkPlan::Pending
            }
        }
        fn set_timer(&mut self, after: Micros, n: Name) -> Id {
            self.fake.set_timer(after, n)
        }
        fn clear_timer(&mut self, id: Id) {
            self.fake.clear_timer(id);
        }
        fn draw(&mut self) -> u64 {
            self.fake.draw()
        }
        fn control(&mut self, input: ControllerInput) {
            self.fake.control(input);
        }
        fn cross(&mut self, id: Id, speed: i64) {
            self.fake.cross(id, speed);
        }
        fn emit(&mut self, c: Vec<Change>, e: Option<Event>) -> Result<(), Refusal> {
            self.fake.emit(c, e)
        }
    }
    let steps = bind_with(&entry(), "visit", &args(&[("other", Arg::Node(other()))])).unwrap();
    let mut host = Pending {
        fake: Fake {
            places: BTreeMap::from([(other(), mm(5, 0, 5))]),
            next: 0,
            reads: RefCell::default(),
            reach: None,
        },
        ready: false,
        asked: RefCell::default(),
    };
    let mut runner = Runner::new(steps, node(), Limits::default());
    assert!(matches!(
        runner.wake(&mut host, Woke::Start),
        Next::Planning
    ));
    assert_eq!(host.fake.next, 1, "one original walk deadline");
    host.fake.places.insert(other(), mm(8, 0, 9));
    assert!(matches!(
        runner.wake(&mut host, Woke::Planning),
        Next::Planning
    ));
    assert_ne!(
        host.asked.borrow()[0],
        host.asked.borrow()[1],
        "the target is read again"
    );
    host.ready = true;
    assert!(matches!(
        runner.wake(&mut host, Woke::Planning),
        Next::Walk(_)
    ));
    assert_eq!(host.fake.next, 1, "planning never extends the deadline");
    assert!(
        matches!(runner.wake(&mut host, Woke::Timer(fixture(101))), Next::End(n) if n.as_str() == "deadline-passed")
    );
}

/// S13d: a walk the planner refuses by name (the ground changed under it, its answer failed) ends the form with that
/// name, not `souls:no-way`.
#[test]
fn a_walk_the_planner_refuses_ends_the_form_with_the_planners_name() {
    use replica::host::WalkPlan;
    struct Refusing(Fake);
    impl Host for Refusing {
        fn now(&self) -> Micros {
            self.0.now()
        }
        fn body(&self) -> Id {
            self.0.body()
        }
        fn read(&self, n: Id) -> Option<Seen> {
            let mut seen = self.0.read(n)?;
            seen.parent = Some(fixture(0));
            Some(seen)
        }
        fn ask(&self, q: &Ask) -> Option<Answer> {
            self.0.ask(q)
        }
        fn plan_walk(&self, _: usize, _: Id, _: Vec3, _: i64) -> WalkPlan {
            WalkPlan::Refused(Name::new("walk.ground-changed").unwrap())
        }
        fn set_timer(&mut self, after: Micros, n: Name) -> Id {
            self.0.set_timer(after, n)
        }
        fn clear_timer(&mut self, id: Id) {
            self.0.clear_timer(id);
        }
        fn draw(&mut self) -> u64 {
            self.0.draw()
        }
        fn control(&mut self, input: ControllerInput) {
            self.0.control(input);
        }
        fn cross(&mut self, id: Id, speed: i64) {
            self.0.cross(id, speed);
        }
        fn emit(&mut self, c: Vec<Change>, e: Option<Event>) -> Result<(), Refusal> {
            self.0.emit(c, e)
        }
    }
    let steps = bind_with(&entry(), "visit", &args(&[("other", Arg::Node(other()))])).unwrap();
    let mut host = Refusing(Fake {
        places: BTreeMap::from([(other(), mm(5, 0, 5))]),
        next: 0,
        reads: RefCell::default(),
        reach: None,
    });
    let mut runner = Runner::new(steps, node(), Limits::default());
    assert!(matches!(
        runner.wake(&mut host, Woke::Start),
        Next::End(n) if n.as_str() == "walk.ground-changed"
    ));
}
