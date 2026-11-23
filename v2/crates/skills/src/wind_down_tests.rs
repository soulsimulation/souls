//! B16 (#2751): one body through Owned, Wander, Zombie and Asleep in a world with short times, woken by its agent;
//! the records name the world and rebuild the rule; a sleeping body is on no due list. `cargo test -p skills wind_down`.

use std::cell::RefCell;
use std::collections::BTreeMap;

use super::*;
use replica::ids::Scope;

const SHORT: Knobs = Knobs {
    wander: 10 * S,
    zombie: 6 * S,
    leg_min: S,
    leg_max: 2 * S,
    bound: 40 * S,
    leg_min_um: 5 * M,
    leg_max_um: 15 * M,
    spot_gap_um: 3 * M,
    spot_search_um: 80 * M,
};

/// A town: buildings fill the square 40 m across round the centre; the rest is open dry ground. Walks go at 1.4 m/s.
#[derive(Default)]
struct Town {
    at: RefCell<BTreeMap<Id, [i64; 2]>>,
    /// Each walk's end and arrival time.
    walks: RefCell<BTreeMap<Id, ([i64; 2], Micros)>>,
    held: Vec<Id>,
    now: RefCell<Micros>,
}

impl Ground for Town {
    fn at(&self, body: Id) -> Option<[i64; 2]> {
        self.at.borrow().get(&body).copied()
    }
    fn held(&self, body: Id) -> bool {
        self.held.contains(&body)
    }
    fn walking(&self, body: Id) -> bool {
        self.walks.borrow().contains_key(&body)
    }
    fn aboard(&self, _: Id) -> bool {
        false
    }
    fn clear(&self, _: [i64; 2], _: bool) -> bool {
        true
    }
    fn outdoors(&self, p: [i64; 2]) -> bool {
        p[0].abs() > 20 * M || p[1].abs() > 20 * M
    }
    fn centre(&self) -> [i64; 2] {
        [0, 0]
    }
}

impl Town {
    fn tick(&self, now: Micros) {
        *self.now.borrow_mut() = now;
        let done: Vec<(Id, [i64; 2])> = self
            .walks
            .borrow()
            .iter()
            .filter(|(_, (_, t))| *t <= now)
            .map(|(b, (p, _))| (*b, *p))
            .collect();
        for (b, p) in done {
            self.walks.borrow_mut().remove(&b);
            self.at.borrow_mut().insert(b, p);
        }
    }
    fn apply(&self, o: &Order) {
        let now = *self.now.borrow();
        for d in &o.what {
            match d {
                Do::Walk(p) => {
                    let from = self.at(o.body).unwrap();
                    let um = i64::try_from(d2(from, *p).isqrt()).unwrap();
                    self.walks
                        .borrow_mut()
                        .insert(o.body, (*p, now + um * S / 1_400_000));
                }
                Do::Stop => {
                    self.walks.borrow_mut().remove(&o.body);
                }
                Do::Stand | Do::Lie => {}
            }
        }
    }
}

fn soul(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

/// Runs the rule tick by tick (50 ms) from `from` to `to`, applying its orders: the words seen, in order, and the
/// records written.
fn run(w: &mut WindDown, t: &Town, from: Micros, to: Micros) -> (Vec<&'static str>, Vec<Effect>) {
    let (mut words, mut records) = (Vec::new(), Vec::new());
    let mut now = from;
    while now <= to {
        t.tick(now);
        for o in w.step(now, t) {
            t.apply(&o);
            records.push(record(
                &o,
                w.state(o.body).unwrap(),
                now,
                records.len() as u64,
            ));
        }
        for b in t.at.borrow().keys() {
            let word = w.word(*b).unwrap().as_str();
            if words.last() != Some(&word) {
                words.push(word);
            }
        }
        now += S / 20;
    }
    (words, records)
}

#[test]
fn a1_a3_a4_silent_soul_wanders_walks_out_lies_down_and_sleeps() {
    let (b, t) = (soul(1), Town::default());
    t.at.borrow_mut().insert(b, [5 * M, 2 * M]);
    let mut w = WindDown::new(SHORT);
    w.add(b, 0);
    let (words, records) = run(&mut w, &t, 0, 60 * S);
    assert_eq!(words, ["awake", "idle", "zombie", "asleep"]);
    // Wander began at the stated silence.
    assert_eq!(w.state(b).unwrap().wander, Some(SHORT.wander));
    // It lies at its spot, outside the built area and farther out than it began.
    let s = *w.state(b).unwrap();
    let at = t.at(b).unwrap();
    assert_eq!(s.spot, Some(at));
    assert!(t.outdoors(at), "{at:?}");
    assert!(d2(at, [0, 0]) > d2([5 * M, 2 * M], [0, 0]));
    // A3: every record's cause and actor are the world; the phases in order.
    assert!(
        records
            .iter()
            .all(|e| e.envelope.actor == Actor::World && e.envelope.cause == Cause::World)
    );
    let phases: Vec<Phase> = records.iter().map(read_phase).collect();
    assert_eq!(phases.first(), Some(&Phase::Wander));
    assert!(phases.contains(&Phase::Leg) && phases.contains(&Phase::Zombie));
    assert_eq!(phases.last(), Some(&Phase::Asleep));
    // A4: asleep, the body is on no due list; stepping a long while issues nothing.
    assert_eq!(w.next(), None);
    assert!(run(&mut w, &t, 60 * S, 120 * S).1.is_empty());
}

fn read_phase(e: &Effect) -> Phase {
    match e.events.as_ref().unwrap()[0].fields.get(&1) {
        Some(Value::Uint(n)) => Phase::from_code(*n).unwrap(),
        _ => panic!("no phase"),
    }
}

#[test]
fn a2_next_agent_act_wakes_it_on_that_tick() {
    let (b, t) = (soul(2), Town::default());
    t.at.borrow_mut().insert(b, [-8 * M, 0]);
    let mut w = WindDown::new(SHORT);
    w.add(b, 0);
    run(&mut w, &t, 0, 60 * S);
    assert_eq!(w.word(b), Some(Word::Asleep));
    let woken = w.acted(b, 61 * S).expect("it was held");
    assert!(woken.slept);
    assert_eq!(w.word(b), Some(Word::Awake));
    assert_eq!(w.next(), Some(61 * S + SHORT.wander));
    // An act of a Soul the rule does not hold wakes nothing.
    assert_eq!(w.acted(b, 62 * S), None);
}

#[test]
fn a_body_something_else_holds_is_never_moved() {
    let b = soul(3);
    let t = Town {
        held: vec![b],
        ..Town::default()
    };
    t.at.borrow_mut().insert(b, [0, 30 * M]);
    let mut w = WindDown::new(SHORT);
    w.add(b, 0);
    let (words, records) = run(&mut w, &t, 0, 60 * S);
    assert_eq!(words, ["awake"]);
    assert!(records.is_empty());
}

#[test]
fn records_rebuild_the_rule_after_a_restart() {
    let (b, t) = (soul(4), Town::default());
    t.at.borrow_mut().insert(b, [3 * M, -4 * M]);
    let mut w = WindDown::new(SHORT);
    w.add(b, 0);
    let (_, records) = run(&mut w, &t, 0, 60 * S);
    let mut again = WindDown::new(SHORT);
    again.resume(&records, |_| None, [b], 70 * S);
    assert_eq!(again.state(b), w.state(b));
    assert_eq!(again.next(), None);
    // A Soul's entry after it fell asleep (a reflex's, #3764) does not wake it: only the woken record does.
    let soul_act = Effect {
        envelope: Envelope {
            actor: Actor::Soul(b),
            at: 65 * S,
            ..records[0].envelope
        },
        ..records[0].clone()
    };
    let mut later = WindDown::new(SHORT);
    later.resume(records.iter().chain([&soul_act]), Some, [b], 70 * S);
    assert_eq!(later.word(b), Some(Word::Asleep));
    let woken = record(
        &Order {
            body: b,
            phase: Phase::Woken,
            what: Vec::new(),
        },
        &State::owned(66 * S),
        66 * S,
        0,
    );
    let mut woke = WindDown::new(SHORT);
    woke.resume(records.iter().chain([&soul_act, &woken]), Some, [b], 70 * S);
    assert_eq!(woke.word(b), Some(Word::Awake));
    assert_eq!(woke.next(), Some(66 * S + SHORT.wander));
}

/// S6 (0.133): a restart from a checkpoint mid-countdown, with no record of the rule since: the carried states rebuild
/// it, and every body's due time is the one it had. Without them a body that never acted was taken as new at the
/// restart and its countdown began again.
#[test]
fn a_restart_from_a_checkpoint_mid_countdown_keeps_every_due_time() {
    let (owned, wandering, asleep) = (soul(21), soul(22), soul(23));
    let t = Town::default();
    let mut w = WindDown::new(SHORT);
    t.at.borrow_mut().insert(asleep, [30 * M, 0]);
    w.add(asleep, 0);
    run(&mut w, &t, 0, 50 * S);
    t.at.borrow_mut().insert(wandering, [40 * M, 0]);
    w.add(wandering, 50 * S);
    run(&mut w, &t, 50 * S, 61 * S);
    t.at.borrow_mut().insert(owned, [50 * M, 0]);
    w.add(owned, 61 * S);
    run(&mut w, &t, 61 * S, 62 * S);
    assert_eq!(
        [owned, wandering, asleep].map(|b| w.word(b)),
        [Some(Word::Awake), Some(Word::Idle), Some(Word::Asleep)]
    );
    // The checkpoint, mid-countdown: one Owned (due at 71 s), one wandering, one asleep (on no list).
    let carried = w.carried();
    let before: Vec<_> = [owned, wandering, asleep]
        .iter()
        .map(|b| (w.state(*b).copied(), w.word(*b)))
        .collect();
    let due = w.next();
    assert!(due.is_some());
    // Restarted at 63 s from the checkpoint alone.
    let mut again = WindDown::new(SHORT);
    again.resume(&carried, |_| None, [owned, wandering, asleep], 63 * S);
    let after: Vec<_> = [owned, wandering, asleep]
        .iter()
        .map(|b| (again.state(*b).copied(), again.word(*b)))
        .collect();
    assert_eq!(after, before);
    assert_eq!(again.next(), due);
    // Without the carry the owned body's hour began again at the restart.
    let mut lost = WindDown::new(SHORT);
    lost.resume(&[], |_| None, [owned], 63 * S);
    assert_eq!(lost.next(), Some(63 * S + SHORT.wander));
}

#[test]
fn choices_are_the_same_every_run_and_spots_keep_apart() {
    let go = || {
        let t = Town::default();
        let mut w = WindDown::new(SHORT);
        for n in 10..14 {
            t.at.borrow_mut().insert(soul(n), [25 * M, 0]);
            w.add(soul(n), 0);
        }
        run(&mut w, &t, 0, 60 * S);
        (10..14)
            .map(|n| w.state(soul(n)).unwrap().spot.unwrap())
            .collect::<Vec<_>>()
    };
    let spots = go();
    assert_eq!(spots, go());
    for (i, a) in spots.iter().enumerate() {
        for c in &spots[i + 1..] {
            assert!(
                d2(*a, *c) >= i128::from(3 * M) * i128::from(3 * M),
                "{a:?} {c:?}"
            );
        }
    }
}
