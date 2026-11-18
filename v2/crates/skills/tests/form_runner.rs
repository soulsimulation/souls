//! F1's checks on a fake host (#2766): every entry in `kinds/` binds its forms and runs them through to a named end;
//! a passed deadline ends a run by name; an old timer changes nothing; a step kind not built is refused by name. No
//! kind is named here: each check runs over the folder's files.

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
            parent: None,
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
fn a_step_kind_not_built_is_refused_by_name_and_so_is_an_unknown_point() {
    let (entry, forms) = entries().remove(0);
    let form = &forms[0];
    let with = |steps: &str| {
        let text = entry
            .to_json()
            .replacen("\"steps\":[", &format!("\"steps\":[{steps},"), 1);
        parse(&text).expect("JSON")
    };
    for (steps, want) in [
        ("{\"step\":\"sit\",\"slot\":\"x\"}", "step-not-built"),
        ("{\"step\":\"use_held\"}", "step-not-built"),
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
