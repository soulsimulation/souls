//! I3 (#2686): each `aN_` test is one acceptance box (A1 and A2 are the `commit-cost` bench).

use super::lamps::{World, rules, toggle};
use super::{Act, Candidate, check, start};
use replica::effects::{Actor, Cause};
use replica::encode::Value as Cbor;
use replica::ids::Id;
use replica::read::Read;
use sim::commit::{Outcome, commit, mark_clock_thread};
use sim::frozen::Publisher;
use std::sync::Arc;

fn lit(w: &World, lamp: Id) -> u64 {
    match w.replica.node(lamp) {
        Some(Cbor::Map(m)) => match m.get(&6) {
            Some(Cbor::Map(f)) => match f.get(&1) {
                Some(Cbor::Uint(n)) => *n,
                other => panic!("lit is {other:?}"),
            },
            other => panic!("fields are {other:?}"),
        },
        other => panic!("the lamp is {other:?}"),
    }
}

fn switch_on(id: u64, body: Id, lamps: &[Id]) -> Act {
    Act {
        id,
        cause: Cause::World,
        actor: Actor::World,
        body,
        candidates: lamps
            .iter()
            .map(|l| Candidate {
                this: *l,
                form: "switch_on".into(),
            })
            .collect(),
        recheck: None,
    }
}

/// Checks run on checker threads against the frozen copy; the clock thread (this test's, marked) only commits. A
/// check on it would panic in this debug build, failing the test.
#[test]
fn a3_checks_run_off_the_clock_thread() {
    mark_clock_thread();
    let mut w = World::build(2, 5, 3);
    let publisher = Arc::new(Publisher::new(&w.replica));
    let (acts, checked) = start(2, Arc::clone(&publisher), Arc::new(rules()));
    let pairs = w.pairs.clone();
    for (i, (b, l)) in pairs.iter().enumerate() {
        acts.send(toggle(i as u64, *b, *l))
            .expect("a checker takes it");
    }
    for _ in 0..pairs.len() {
        let (_, checks) = checked.recv().expect("checked");
        match commit(&mut w.replica, &checks, 0) {
            Outcome::Applied { rank, part } => {
                assert_eq!(rank, 0, "switch_on holds on an unlit lamp");
                publisher.publish(vec![part]);
            }
            other => panic!("not applied: {other:?}"),
        }
    }
    assert!(pairs.iter().all(|(_, l)| lit(&w, *l) == 1));
    // A second round on the newer copy: switch_off is the candidate that holds now.
    let copy = publisher.wait_for(w.replica.version(), std::time::Duration::from_secs(5));
    assert_eq!(copy.version(), w.replica.version());
    for (i, (b, l)) in pairs.iter().enumerate() {
        acts.send(toggle(100 + i as u64, *b, *l))
            .expect("a checker takes it");
    }
    for _ in 0..pairs.len() {
        let (_, checks) = checked.recv().expect("checked");
        assert!(matches!(
            commit(&mut w.replica, &checks, 0),
            Outcome::Applied { rank: 1, .. }
        ));
    }
    assert!(pairs.iter().all(|(_, l)| lit(&w, *l) == 0));
}

#[test]
#[should_panic(expected = "ran on the clock thread")]
fn a3_a_check_on_the_clock_thread_fails() {
    let w = World::build(1, 1, 0);
    mark_clock_thread();
    let (b, l) = w.pairs[0];
    check(&w.replica, &rules(), &toggle(0, b, l));
}

/// The first candidate's lamp changes after its check: it is not applied and the next candidate is.
#[test]
fn a4_a_changed_read_takes_the_next_candidate() {
    let mut w = World::build(1, 2, 0);
    let ((b, a), (_, next)) = (w.pairs[0], w.pairs[1]);
    let copy = w.replica.frozen();
    let checks = check(&copy, &rules(), &switch_on(1, b, &[a, next]));
    assert!(
        checks
            .candidates
            .iter()
            .all(|c| c.verdict == sim::commit::Verdict::Yes)
    );
    w.dim(a, 500);
    match commit(&mut w.replica, &checks, 0) {
        Outcome::Applied { rank, .. } => assert_eq!(rank, 1),
        other => panic!("{other:?}"),
    }
    assert_eq!((lit(&w, a), lit(&w, next)), (0, 1));
}

/// The only candidate's lamp changes after its check: one re-check on a newer copy; changed again, refused.
#[test]
fn a4_a_changed_read_rechecks_once_then_refuses() {
    let mut w = World::build(1, 1, 0);
    let (b, a) = w.pairs[0];
    let mut act = switch_on(1, b, &[a]);
    let checks = check(&w.replica.frozen(), &rules(), &act);
    w.dim(a, 500);
    let version = match commit(&mut w.replica, &checks, 0) {
        Outcome::Recheck { version } => version,
        other => panic!("{other:?}"),
    };
    act.recheck = Some(version);
    let copy = w.replica.frozen();
    assert!(copy.version() >= version);
    let rechecked = check(&copy, &rules(), &act);
    assert!(rechecked.rechecked);
    // Unchanged since the re-check, it would apply; changed again, it is refused.
    w.dim(a, 600);
    match commit(&mut w.replica, &rechecked, 0) {
        Outcome::Refused { reason } => assert_eq!(reason, "stale"),
        other => panic!("{other:?}"),
    }
    assert_eq!(lit(&w, a), 0);
    let fresh = check(&w.replica.frozen(), &rules(), &act);
    assert!(matches!(
        commit(&mut w.replica, &fresh, 0),
        Outcome::Applied { rank: 0, .. }
    ));
    assert_eq!(lit(&w, a), 1);
}

/// The read set holds each node the check read, with the stamp it had on the copy.
#[test]
fn the_read_set_is_the_thing_and_the_body() {
    let mut w = World::build(1, 2, 0);
    w.dim(w.pairs[0].1, 1);
    let (b, a) = w.pairs[0];
    let checks = check(&w.replica, &rules(), &toggle(0, b, a));
    for c in &checks.candidates {
        assert_eq!(
            c.reads,
            vec![(a, w.replica.stamp(a)), (b, w.replica.stamp(b))]
        );
    }
}
