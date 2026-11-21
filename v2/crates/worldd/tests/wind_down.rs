//! Engine v2 B16 (#2751): on N2's test world with short clocks, a Soul whose agent is silent wanders, becomes a
//! zombie, walks out by N7's walk to open ground outside the built area, lies down there and stays asleep, its body
//! on no due list; every move is the world's record. Its agent's next act wakes it on that tick and a walk it then asks
//! for runs. `cargo test --release -p worldd --test wind_down`.

use replica::effects::{Actor, Cause};
use replica::pose::{Support, Vec3};
use sim::controller::Stance;
use skills::wind_down::{self, Knobs, Word};
use worldd::bodies::{Ask, Asked, Bodies};
use worldd::testbodies;

const S: i64 = 1_000_000;
const TICK: i64 = 50_000;

const SHORT: Knobs = Knobs {
    wander: 10 * S,
    zombie: 20 * S,
    leg_min: 4 * S,
    leg_max: 6 * S,
    bound: 90 * S,
    ..wind_down::KNOBS
};

fn ground_xz(b: &Bodies) -> [i64; 2] {
    let (_, p) = b.pose(testbodies::body()).unwrap();
    [p.x, p.z]
}

/// Steps body time from `from` to `to`, a tick at a time: the record names written, in order.
fn run(b: &mut Bodies, from: i64, to: i64) -> Vec<String> {
    let mut names = Vec::new();
    let mut now = from;
    while now <= to {
        b.step(now);
        for e in std::mem::take(&mut b.wind_log) {
            assert_eq!((e.envelope.actor, e.envelope.cause), (Actor::World, Cause::World), "A3");
            assert!(wind_down::read(&e).is_some());
            names.extend(e.events.unwrap().into_iter().map(|v| v.name.as_str().to_owned()));
        }
        now += TICK;
    }
    names
}

#[test]
fn b16_a_silent_soul_walks_out_sleeps_and_wakes_on_its_agents_act() {
    let mut b = testbodies::bodies().unwrap();
    let soul = testbodies::body();
    b.wind.set_knobs(SHORT, 0);
    let from = ground_xz(&b);

    // A1, A3: idle (and its legs), zombie, asleep, each the world's record, in that order.
    let names = run(&mut b, 0, 120 * S);
    let mut words = names.clone();
    words.dedup();
    assert_eq!(words, ["souls:idle", "souls:zombie", "souls:asleep"], "{names:?}");
    assert!(names.iter().filter(|n| *n == "souls:idle").count() > 1, "legs: {names:?}");
    assert_eq!(b.wind.word(soul), Some(Word::Asleep));
    // It lies where it walked to: its spot, out of the square and farther out than it began.
    let at = ground_xz(&b);
    let s = *b.wind.state(soul).unwrap();
    let spot = s.spot.unwrap();
    let apart = |a: [i64; 2], c: [i64; 2]| ((a[0] - c[0]) as f64).hypot((a[1] - c[1]) as f64);
    assert!(apart(at, spot) < 1_000_000.0, "lies at its spot: {at:?} {spot:?}");
    assert!(apart(at, from) > 5_000_000.0, "walked out: {from:?} -> {at:?}");
    let placed = b.placed();
    let (pose, stance) = placed[&soul];
    assert!(matches!(pose.support, Support::Surface { .. }), "on the open ground");
    assert_eq!(stance, Some(Stance::Lie), "lying");

    // A4: asleep, it is on no due list, and a long while issues nothing.
    assert_eq!(b.wind.next(), None);
    assert!(run(&mut b, 120 * S + TICK, 400 * S).is_empty());
    assert_eq!(ground_xz(&b), at);

    // A2: its agent's act wakes it on that tick; a walk it asks for then runs.
    let now = 400 * S + TICK;
    b.agent_acted(soul, now);
    assert_eq!(b.wind.word(soul), Some(Word::Awake));
    let woke: Vec<String> = std::mem::take(&mut b.wind_log)
        .into_iter()
        .flat_map(|e| e.events.unwrap())
        .map(|v| v.name.as_str().to_owned())
        .collect();
    assert_eq!(woke, ["souls:awake"]);
    assert_eq!(b.placed()[&soul].1, None, "standing again");
    let walk = Asked {
        body: soul,
        actor: Actor::Soul(soul),
        ask: Ask::Walk {
            node: pose.frame.node,
            point: Some(Vec3::new(at[0] + 3_000_000, 0, at[1])),
        },
        fallbacks: Vec::new(),
    };
    let intent = replica::ids::Id::new(replica::ids::Scope([0x77; 16]), 1).unwrap();
    let started = b.start(vec![(intent, walk)]);
    assert!(started.iter().all(|(_, r)| r.is_ok()), "{started:?}");
    let mut done = None;
    let mut t = now;
    while done.is_none() && t < now + 30 * S {
        t += TICK;
        done = b.step(t).into_iter().find(|(id, _)| *id == intent).map(|(_, r)| r);
    }
    assert_eq!(done, Some(Ok(())), "the agent's walk ran");
    assert!(apart(ground_xz(&b), [at[0] + 3_000_000, at[1]]) < 500_000.0);
}
