//! #4086, #4118: no take at a distance. A bare `take` (a hand step naming no move, as 60 entries in `content/kinds`
//! write it) binds to an approach to its thing, then the hand step. A body within reach takes at once, with no walk;
//! one beyond reach walks first, and its hand's contact needs the thing within reach when the walk ends: a walk that
//! stops short, or an approach that finds no way, ends `out-of-reach` with nothing taken.

use std::collections::BTreeMap;

use replica::effects::{Change, Event, Refusal};
use replica::encode::Name;
use replica::host::{Answer, Ask, Host, Progress, Seen, WalkPlan};
use replica::ids::Id;
use replica::pose::{ControllerInput, Vec3, fixture};
use replica::rules::json::parse;
use replica::time::Micros;

use super::{Args, Limits, Next, Runner, Step, Woke, bind_with};

const ENTRY: &str = r#"{"format": "souls-entry/1", "kind": "test:jug", "owner": "thing",
  "forms": {"take": {"who": "anyone", "starts": "act", "steps": [{"step": "take"}],
    "effects": [{"change": "reparent", "what": "this", "into": "actor_hand", "event": "taken"}]}}}"#;

/// A world where the thing stands 5 m off on a ground (another node), and says whether the body is within reach.
struct World {
    reach: Option<bool>,
    /// The world finds no way to the thing.
    no_way: bool,
    next: u64,
}

impl Host for World {
    fn now(&self) -> Micros {
        0
    }
    fn body(&self) -> Id {
        fixture(1)
    }
    fn read(&self, n: Id) -> Option<Seen> {
        Some(Seen {
            id: n,
            kind: Name::new("test:jug").expect("a name"),
            parent: Some(fixture(3)),
            position: Vec3::new(5_000_000, 0, 0),
            fields: BTreeMap::new(),
        })
    }
    fn ask(&self, _: &Ask) -> Option<Answer> {
        None
    }
    fn within_reach(&self, _: Id) -> Option<bool> {
        self.reach
    }
    fn plan_walk(&self, _: usize, _: Id, at: Vec3, _: i64) -> WalkPlan {
        WalkPlan::Legs(if self.no_way {
            Vec::new()
        } else {
            vec![(at, None)]
        })
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

fn ended(next: &Next, how: &str) -> bool {
    matches!(next, Next::End(n) if n.as_str() == how)
}

#[test]
fn w10_a_bare_take_walks_to_its_thing_first_and_takes_only_within_reach() {
    let take = bind_with(&parse(ENTRY).expect("JSON"), "take", &Args::new()).expect("binds");
    assert!(
        matches!(
            &take[..],
            [Step::WalkTo { approach: true, at, on: None, .. }, Step::Hand] if *at == Vec3::ZERO
        ),
        "an approach to the thing's own place, then the hand step: {take:?}"
    );
    let world = |reach, no_way| World {
        reach: Some(reach),
        no_way,
        next: 0,
    };
    let run = || Runner::new(take.clone(), fixture(2), Limits::default());
    // Within reach: taken at once, with no walk.
    let (mut h, mut r) = (world(true, false), run());
    assert!(ended(&r.wake(&mut h, Woke::Start), "done"), "no walk");
    assert!(r.take_effect(), "taken");
    // Beyond reach: the body walks to the thing first, and takes it there.
    let (mut h, mut r) = (world(false, false), run());
    assert!(
        matches!(r.wake(&mut h, Woke::Start), Next::Walk(_)),
        "walks to the thing"
    );
    assert!(!r.take_effect(), "nothing taken before the walk ends");
    h.reach = Some(true);
    assert!(ended(&r.wake(&mut h, Woke::Walked(Progress::Done)), "done"));
    assert!(r.take_effect(), "taken once there");
    // The walk ended and the thing is still beyond reach (it stopped short, or the thing was moved): nothing taken.
    let (mut h, mut r) = (world(false, false), run());
    assert!(matches!(r.wake(&mut h, Woke::Start), Next::Walk(_)));
    assert!(ended(
        &r.wake(&mut h, Woke::Walked(Progress::Done)),
        "out-of-reach"
    ));
    assert!(!r.take_effect(), "nothing taken from afar");
    // The approach finds no way (the hand is tried from where the body stands): still nothing taken from afar.
    let (mut h, mut r) = (world(false, true), run());
    assert!(ended(&r.wake(&mut h, Woke::Start), "out-of-reach"));
    assert!(!r.take_effect(), "nothing taken from afar");
}
