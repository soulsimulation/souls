//! F1's checks on a fake host (#2766): every entry in `kinds/` binds its forms and runs them through to a named end;
//! a passed deadline ends a run by name; an old timer changes nothing; a malformed or unknown step is refused by name.
//! No kind is named here: each check runs over the folder's files.

use std::collections::BTreeMap;
use std::path::Path;

use replica::effects::{Change, Event, Refusal};
use replica::encode::Name;
use replica::host::{Answer, Ask, Host, Progress, Seen};
use replica::ids::Id;
use replica::pose::{ControllerInput, Vec3, fixture};
use replica::rules::json::{Value, parse};
use replica::time::Micros;

use skills::form_runner::{Limits, Next, Runner, Step, Woke, bind};

/// Every entry in `kinds/`, with its forms' names.
fn entries() -> Vec<(Value, Vec<String>)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/form_runner/kinds");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("the kinds folder")
        .map(|e| e.expect("an entry").path())
        .collect();
    files.sort();
    files
        .iter()
        .map(|f| {
            let v = parse(&std::fs::read_to_string(f).expect("read")).expect("JSON");
            let forms = v
                .get("forms")
                .and_then(Value::obj)
                .expect("forms")
                .iter()
                .map(|(k, _)| k.clone())
                .collect();
            (v, forms)
        })
        .collect()
}

fn body() -> Id {
    fixture(1)
}
const NODE: u64 = 2;

fn node() -> Id {
    fixture(NODE)
}

/// A host that records the runner's timers; the node stands at `at`.
#[derive(Default)]
struct Fake {
    now: Micros,
    at: Vec3,
    next: u8,
    timers: BTreeMap<Id, (Micros, Name)>,
    /// The node is in the body's hand (C25): the body is its parent.
    held: bool,
}

impl Host for Fake {
    fn now(&self) -> Micros {
        self.now
    }
    fn body(&self) -> Id {
        body()
    }
    fn read(&self, n: Id) -> Option<Seen> {
        (n == node()).then(|| Seen {
            id: node(),
            kind: Name::new("test:node").expect("a name"),
            parent: self.held.then(body),
            position: self.at,
            fields: BTreeMap::new(),
        })
    }
    fn ask(&self, _: &Ask) -> Option<Answer> {
        None
    }
    fn set_timer(&mut self, after: Micros, name: Name) -> Id {
        self.next += 1;
        let id = fixture(100 + u64::from(self.next));
        self.timers.insert(id, (self.now + after, name));
        id
    }
    fn clear_timer(&mut self, timer: Id) {
        self.timers.remove(&timer);
    }
    fn draw(&mut self) -> u64 {
        0
    }
    fn control(&mut self, _: ControllerInput) {}
    fn cross(&mut self, _: Id, _: i64) {}
    fn emit(&mut self, _: Vec<Change>, _: Option<Event>) -> Result<(), Refusal> {
        Ok(())
    }
}

impl Fake {
    /// The one timer the runner holds.
    fn only(&self) -> (Id, Micros, String) {
        let [(id, (due, name))] = self.timers.iter().collect::<Vec<_>>()[..] else {
            panic!("one timer: {:?}", self.timers)
        };
        (*id, *due, name.as_str().to_owned())
    }
}

fn ended(n: &Next) -> Option<&str> {
    match n {
        Next::End(how) => Some(how.as_str()),
        _ => None,
    }
}

#[test]
fn a1_every_form_in_the_folder_binds_and_runs_to_done() {
    let all = entries();
    assert!(all.len() >= 2, "two kinds at least");
    for (entry, forms) in &all {
        let kind = entry.get("kind").and_then(Value::str).expect("a kind");
        for form in forms {
            let steps = bind(entry, form).expect("binds");
            println!("{kind} {form}: {steps:?}");
            let mut h = Fake {
                at: Vec3::new(4_000_000, 0, -3_000_000),
                ..Fake::default()
            };
            let mut r = Runner::new(steps.clone(), node(), Limits::default());
            let mut next = r.wake(&mut h, Woke::Start);
            let mut trail = Vec::new();
            for step in &steps {
                match (step, &next) {
                    (Step::WalkTo { at, .. }, Next::Walk(_)) => {
                        let (_, due, n) = h.only();
                        assert_eq!((due, n.as_str()), (60_000_000, "souls:form-deadline"));
                        assert_ne!(*at, Vec3::ZERO, "the stand point from data");
                        trail.push("walk");
                        next = r.wake(&mut h, Woke::Walked(Progress::Done));
                    }
                    (
                        Step::Move { name, .. },
                        Next::Move {
                            name: asked,
                            node: at,
                            ..
                        },
                    ) => {
                        assert_eq!((name, *at), (asked, node()));
                        trail.push("move");
                        next = r.wake(&mut h, Woke::Moved(Name::new("done").expect("n")));
                    }
                    (Step::Wait(us), Next::Sleep) => {
                        let (id, due, n) = h.only();
                        assert_eq!((due, n.as_str()), (*us, "souls:form-wait"));
                        // An old timer of another run wakes nothing.
                        assert!(matches!(
                            r.wake(&mut h, Woke::Timer(fixture(99))),
                            Next::Sleep
                        ));
                        trail.push("wait");
                        h.now = due;
                        h.timers.remove(&id);
                        next = r.wake(&mut h, Woke::Timer(id));
                    }
                    _ => panic!("{step:?} asked for the wrong thing"),
                }
            }
            println!("  {trail:?} -> {:?}", ended(&next));
            assert_eq!(ended(&next), Some("done"));
            assert!(h.timers.is_empty(), "no timer left behind");
            assert!(
                matches!(r.wake(&mut h, Woke::Start), Next::Sleep),
                "ended stays ended"
            );
        }
    }
}

#[test]
fn a3_a_passed_deadline_ends_the_run_by_name_and_so_does_a_failed_move() {
    for (entry, forms) in &entries() {
        for form in forms {
            let steps = bind(entry, form).expect("binds");
            let mut h = Fake::default();
            let mut r = Runner::new(steps.clone(), node(), Limits::default());
            assert!(matches!(r.wake(&mut h, Woke::Start), Next::Walk(_)));
            let (deadline, _, _) = h.only();
            // A move's end while walking is not the walk's: nothing.
            let late = r.wake(&mut h, Woke::Moved(Name::new("done").expect("n")));
            assert!(matches!(late, Next::Sleep));
            let next = r.wake(&mut h, Woke::Timer(deadline));
            assert_eq!(ended(&next), Some("deadline-passed"));
            // The run's own timer firing again after the end changes nothing.
            assert!(matches!(r.wake(&mut h, Woke::Timer(deadline)), Next::Sleep));

            let mut h = Fake::default();
            let mut r = Runner::new(steps, node(), Limits::default());
            r.wake(&mut h, Woke::Start);
            r.wake(&mut h, Woke::Walked(Progress::Done));
            let next = r.wake(&mut h, Woke::Moved(Name::new("out-of-reach").expect("n")));
            assert_eq!(ended(&next), Some("out-of-reach"));
            assert!(h.timers.is_empty(), "the deadline cleared at the end");
        }
    }
}

#[test]
fn a_malformed_or_unknown_step_is_refused_by_name_and_so_is_an_unknown_point() {
    let (entry, forms) = entries().remove(0);
    let form = &forms[0];
    let with = |steps: &str| {
        let text = entry
            .to_json()
            .replacen("\"steps\":[", &format!("\"steps\":[{steps},"), 1);
        parse(&text).expect("JSON")
    };
    for (steps, want) in [
        ("{\"step\":\"settle\"}", "step-malformed"),
        ("{\"step\":\"sit\",\"slot\":\"x\"}", "slot-unknown"),
        ("{\"step\":\"fly\"}", "step-unknown"),
        (
            "{\"step\":\"walk_to\",\"point\":\"nowhere\"}",
            "point-unknown",
        ),
        ("{\"step\":\"wait\",\"us\":0}", "step-malformed"),
    ] {
        let r = bind(&with(steps), form).expect_err("refused");
        println!("{steps}: {} ({})", r.name, r.detail);
        assert_eq!(r.name, want);
    }
    assert_eq!(
        bind(&entry, "no-such-form").expect_err("refused").name,
        "form-unknown"
    );
}

/// C17 (#3453): a `sit` step binds to its slot (by name or by argument), lying where the slot's posture is `lie` or
/// the step is a `lie`; the form's `reparent` of the actor into that slot is the sit's own hand-off, not an effect;
/// and the runner asks the world to take the seat, waking at its contact (the effect's instant) and ending done.
#[test]
fn c17_a_sit_step_binds_its_slot_and_posture_and_runs_through_the_seat() {
    let entry = parse(
        r#"{"format":"souls-entry/1","kind":"t:x","points":{"p":{"role":"stand","at_mm":[0,0,500]}},
        "slots":{"a":{"admits":"body","posture":"sit","at_mm":[0,450,0],"stand":"p"},
                 "b":{"admits":"body","posture":"lie","at_mm":[0,500,0],"stand":"p"}},
        "forms":{
          "s":{"takes":{"seat":{"type":"slot"}},
               "steps":[{"step":"walk_to","point":{"arg":"seat"}},{"step":"sit","slot":{"arg":"seat"}}],
               "effects":[{"change":"reparent","what":"actor","into":{"arg":"seat"}}]},
          "n":{"steps":[{"step":"sit","slot":"a"}]},
          "l":{"steps":[{"step":"lie","slot":"a"}]}}}"#,
    )
    .expect("JSON");
    let slots = |n: u64| BTreeMap::from([("seat".to_owned(), n)]);
    let bound =
        skills::form_runner::bind_in(&entry, "s", &BTreeMap::new(), &slots(2)).expect("binds");
    assert_eq!(bound[1], Step::Sit { slot: 2, lie: true });
    assert_eq!(
        skills::form_runner::bind_in(&entry, "s", &BTreeMap::new(), &slots(1)).unwrap()[1],
        Step::Sit {
            slot: 1,
            lie: false
        }
    );
    assert_eq!(
        bind(&entry, "n").unwrap(),
        vec![Step::Sit {
            slot: 1,
            lie: false
        }]
    );
    assert_eq!(
        bind(&entry, "l").unwrap(),
        vec![Step::Sit { slot: 1, lie: true }]
    );
    let effects = skills::form_runner::bind_effects_in(&entry, "s", &BTreeMap::new(), &slots(1))
        .expect("binds");
    assert!(effects.is_empty(), "the reparent is the sit's: {effects:?}");
    // The run: the seat asked for, the effect at contact, done when the sit ends done.
    let mut h = Fake::default();
    let mut r = Runner::new(bind(&entry, "n").unwrap(), node(), Limits::default());
    assert!(matches!(
        r.wake(&mut h, Woke::Start),
        Next::Sit {
            slot: 1,
            lie: false,
            ..
        }
    ));
    r.wake(&mut h, Woke::Contact);
    assert!(r.take_effect(), "the effect's instant is the sit's contact");
    let end = r.wake(&mut h, Woke::Moved(Name::new("done").unwrap()));
    assert_eq!(ended(&end), Some("done"));
}

/// C25 (#3496): every step shape binds. A form with no steps binds to none and its run lands its effects at once,
/// ending done. A slot named as a walk's point is walked to at its stand point (or the slot itself, with none). `rise`,
/// `settle` (sit or lie) and `use_held` bind; a walk to a thing argument walks to that node, and one not given is
/// refused `arg-missing`. The form's `reparent` of the actor to `here` is a rise's own hand-off, not an effect.
#[test]
fn c25_every_step_shape_binds() {
    let entry = parse(
        r#"{"format":"souls-entry/1","kind":"t:x","points":{"p":{"role":"stand","at_mm":[0,0,500]}},
        "slots":{"a":{"admits":"body","posture":"sit","at_mm":[0,450,0],"stand":"p"},
                 "top":{"admits":"body","at_mm":[0,900,0]}},
        "state":{"n":{"n":1,"type":"int","default":0,"min":0,"max":9}},
        "forms":{
          "none":{"steps":[],"effects":[{"change":"set","field":"n","to":1}]},
          "seat":{"steps":[{"step":"walk_to","point":"a"},{"step":"sit","slot":"a"},{"step":"rise"}],
                  "effects":[{"change":"reparent","what":"actor","into":"here"},{"change":"set","field":"n","to":2}]},
          "up":{"steps":[{"step":"walk_to","point":"top"}]},
          "rest":{"steps":[{"step":"settle","posture":"sit"},{"step":"settle","posture":"lie"},{"step":"rise"}]},
          "use":{"steps":[{"step":"use_held"}]},
          "go":{"takes":{"room":{"type":"thing"}},"steps":[{"step":"walk_to","point":{"arg":"room"}}]}}}"#,
    )
    .expect("JSON");
    assert_eq!(bind(&entry, "none").expect("binds"), vec![]);
    let seat = bind(&entry, "seat").expect("binds");
    assert_eq!(
        seat[0],
        Step::WalkTo {
            point: Name::new("a").unwrap(),
            at: Vec3::new(0, 0, 500_000),
            on: None
        }
    );
    assert_eq!(seat[2], Step::Rise);
    let effects = skills::form_runner::bind_effects(&entry, "seat").expect("binds");
    assert_eq!(
        effects.len(),
        1,
        "the rise carries the reparent: {effects:?}"
    );
    assert_eq!(
        bind(&entry, "up").expect("binds"),
        vec![Step::WalkTo {
            point: Name::new("top").unwrap(),
            at: Vec3::new(0, 900_000, 0),
            on: None
        }]
    );
    assert_eq!(
        bind(&entry, "rest").expect("binds"),
        vec![
            Step::Settle { lie: false },
            Step::Settle { lie: true },
            Step::Rise
        ]
    );
    assert_eq!(bind(&entry, "use").expect("binds"), vec![Step::UseHeld]);
    assert_eq!(bind(&entry, "go").expect_err("refused").name, "arg-missing");
    let room = fixture(9);
    let things = BTreeMap::from([("room".to_owned(), room)]);
    assert_eq!(
        skills::form_runner::bind_in(&entry, "go", &things, &BTreeMap::new()).expect("binds"),
        vec![Step::WalkTo {
            point: Name::new("room").unwrap(),
            at: Vec3::ZERO,
            on: Some(room)
        }]
    );
}

/// C25 (#3496) A1, A3: the runner over each new shape. No steps: done at once, the effect taken (one act, one
/// receipt). `rise` and `settle` ask the world and go on when it answers done. `use_held` is the hand step: the
/// effect's instant when the node is in the body's hand, else the run ends `not-held`.
#[test]
fn c25_the_runner_runs_every_step_shape() {
    let mut h = Fake::default();
    let mut r = Runner::new(Vec::new(), node(), Limits::default());
    assert_eq!(ended(&r.wake(&mut h, Woke::Start)), Some("done"));
    assert!(r.take_effect(), "the effect lands at once");
    assert!(h.timers.is_empty());

    let done = || Woke::Moved(Name::new("done").unwrap());
    let steps = vec![Step::Settle { lie: true }, Step::Rise];
    let mut r = Runner::new(steps, node(), Limits::default());
    assert!(matches!(
        r.wake(&mut h, Woke::Start),
        Next::Settle { lie: true }
    ));
    assert!(matches!(r.wake(&mut h, done()), Next::Rise));
    assert_eq!(ended(&r.wake(&mut h, done())), Some("done"));
    assert!(r.take_effect(), "no hand step: the effect at the end");
    assert!(h.timers.is_empty(), "the step's deadline cleared");

    let mut r = Runner::new(vec![Step::Rise], node(), Limits::default());
    r.wake(&mut h, Woke::Start);
    let refused = r.wake(&mut h, Woke::Moved(Name::new("not-seated").unwrap()));
    assert_eq!(
        ended(&refused),
        Some("not-seated"),
        "a rise ends by its name"
    );

    let use_held = || vec![Step::UseHeld, Step::Wait(1_000_000)];
    let mut r = Runner::new(use_held(), node(), Limits::default());
    assert_eq!(ended(&r.wake(&mut h, Woke::Start)), Some("not-held"));
    assert!(!r.take_effect(), "no effect");
    h.held = true;
    let mut r = Runner::new(use_held(), node(), Limits::default());
    assert!(matches!(r.wake(&mut h, Woke::Start), Next::Sleep));
    assert!(r.take_effect(), "the effect's instant is the use");
    let (id, ..) = h.only();
    assert_eq!(ended(&r.wake(&mut h, Woke::Timer(id))), Some("done"));
}

/// C24 (#3495): every effect kind content uses binds: a link with its kind's most and an unlink of every end, a timer
/// by its form, a set with a rate on a timed field (with and without its value), a reparent no step carries of a
/// thing into the hand or a slot (by name or a slot argument) as a take or a put, and of the actor `here`; and each is
/// refused by name where it cannot be.
#[test]
fn c24_link_timer_timed_set_and_reparent_bind_or_are_refused_by_name() {
    use skills::form_runner::{Arg, Args, Effect, Of, bind_effects, bind_effects_args};
    let entry = parse(
        r#"{"format":"souls-entry/1","kind":"t:x",
        "state":{"level":{"n":1,"type":"timed","unit":"g","default":{"value":40,"per_s":-5,"set_us":0},"min":0,"max":100},
          "count":{"n":2,"type":"int","default":0,"min":0,"max":9}},
        "links":{"user":{"n":1,"from":"soul","most":2,"audience":{"rule":"everyone"}},
          "owner":{"n":2,"from":"soul","most":1,"audience":{"rule":"everyone"}}},
        "slots":{"rest":{"admits":"thing"},"seat":{"admits":"body"}},
        "forms":{
          "a":{"steps":[{"step":"wait","us":1}],"effects":[
            {"change":"link","link":"user","from":"actor"},{"change":"unlink","link":"owner","from":"all"},
            {"change":"timer","form":"b","after_us":5},
            {"change":"set","field":"level","to":100,"rate":-5},{"change":"set","field":"level","rate":2},
            {"change":"reparent","what":"this","into":"actor_hand"},{"change":"reparent","what":"this","into":"rest"},
            {"change":"reparent","what":"this","into":{"arg":"place"}},
            {"change":"reparent","what":"actor","into":"here"}]},
          "b":{"steps":[{"step":"wait","us":1}]},
          "no_link":{"steps":[{"step":"wait","us":1}],"effects":[{"change":"link","link":"friend","from":"actor"}]},
          "no_form":{"steps":[{"step":"wait","us":1}],"effects":[{"change":"timer","form":"zz","after_us":5}]},
          "over":{"steps":[{"step":"wait","us":1}],"effects":[{"change":"set","field":"level","to":101,"rate":0}]},
          "too_many":{"steps":[{"step":"wait","us":1}],"effects":[{"change":"set","field":"count","to":10}]},
          "down":{"steps":[{"step":"wait","us":1}],"effects":[{"change":"reparent","what":"this","into":"here"}]},
          "board":{"steps":[{"step":"wait","us":1}],"effects":[{"change":"reparent","what":"actor","into":"seat"}]}}}"#,
    )
    .expect("JSON");
    let name = |t: &str| Name::new(t).unwrap();
    let three = replica::timed::Timed {
        value: 40,
        per_s: -5,
        set_us: 0,
    };
    let bounds = replica::timed::Bounds {
        min: Some(0),
        max: Some(100),
    };
    let args: Args = BTreeMap::from([("place".to_owned(), Arg::Name("rest".into()))]);
    let put = Effect::Put {
        what: Of::This,
        slot: 1,
    };
    assert_eq!(
        bind_effects_args(&entry, "a", &args).expect("binds"),
        vec![
            Effect::Link {
                ty: name("t:user"),
                soul: true,
                most: Some(2)
            },
            Effect::Unlink {
                ty: name("souls:owns"),
                soul: true,
                all: true
            },
            Effect::Timer {
                form: name("t:b"),
                after: 5
            },
            Effect::Timed {
                field: 1,
                to: Some(100),
                per_s: -5,
                default: three,
                bounds
            },
            Effect::Timed {
                field: 1,
                to: None,
                per_s: 2,
                default: three,
                bounds
            },
            Effect::Take { what: Of::This },
            put.clone(),
            put,
            Effect::Here,
        ]
    );
    let refused = |form: &str| bind_effects(&entry, form).unwrap_err().name;
    assert_eq!(refused("a"), "arg-missing");
    assert_eq!(refused("no_link"), "link-unknown");
    assert_eq!(refused("no_form"), "form-unknown");
    assert_eq!(refused("over"), "out-of-range");
    assert_eq!(refused("too_many"), "out-of-range");
    assert_eq!(refused("down"), "no-slot-here");
    assert_eq!(refused("board"), "body-moves-by-step");
}
