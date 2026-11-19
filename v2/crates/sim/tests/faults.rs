//! #3275: one walker's refusal in the middle of a tick is its own fault. On N2's test world, a crowd walks through
//! the host with the ladder; one walker is made to fault mid-tick, and the same crowd runs beside it with no fault.
//! The tick the fault comes, every other walker's body, run and record is what it is in the run without the fault,
//! the tick returns `Ok`, and the faulting walker's order ends by the refusal's name, with the ladder's record.
//!
//! The kinds of mid-tick refusal the walk can raise, one scene each: its input (the controller refuses its driver),
//! its crossing's track (the link removed under it), the carry's landing (the far side's surface gone), and its step
//! on its surface (the surface gone). A1 is the crossing in a crowd of 1,000.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{id, stand, walk};
use replica::host::Progress;
use replica::ids::Id;
use replica::pose::Vec3;
use sim::host::Runner;
use sim::mover::Body;
use sim::unstick::{Ladder, Rung};
use sim::walk::town::Town;
use sim::walk::{World, node_of};

const SPEED: i64 = 1_400_000;
const TICK: i64 = 50_000;
/// The faulting walker.
const F: u64 = 1;

/// A crowd: the town, its runner and ladder.
struct Crowd {
    t: Town,
    c: Runner,
    l: Ladder,
    /// The ground floor the faulting walker walks in to.
    f0: Id,
}

/// What a tick leaves of every body: where it stands, whether it runs, how its run ended, and the ladder's records.
#[derive(Debug, PartialEq, Eq)]
struct Seen {
    bodies: BTreeMap<Id, Body>,
    running: BTreeSet<Id>,
    ended: BTreeMap<Id, String>,
    log: Vec<(Id, &'static str)>,
}

impl Crowd {
    fn new() -> (Crowd, BTreeMap<String, Id>) {
        let (t, nodes) = common::town(b"souls/faults-test/1");
        let c = Crowd {
            t,
            c: Runner::new(TICK),
            l: Ladder::new(),
            f0: nodes["building/floor-0"],
        };
        (c, nodes)
    }

    /// Walker `n` on `node` at `from`, walking to `goal` on `to`; false when the town plans no walk for it.
    fn walker(&mut self, n: u64, node: Id, from: Vec3, to: Id, goal: Vec3) -> bool {
        let Ok(b) = self.t.surfaces[&node].place(
            id(n),
            replica::pose::Frame { node, slot: None },
            from,
            replica::pose::Quat::IDENTITY,
        ) else {
            return false;
        };
        match walk(&mut self.c, &mut self.t, b, SPEED, to, goal) {
            Ok(legs) => {
                self.l.add(id(n), id(100_000 + n), SPEED, to, goal, legs);
                true
            }
            Err(_) => false,
        }
    }

    /// `others` walkers on the open ground, 1.5 m apart, at least 10 m from `away`, each walking 4 m east.
    fn others(&mut self, ground: Id, away: Vec3, others: usize) {
        let mut n = F + 1;
        'grid: for i in 0..80i64 {
            for k in 0..80i64 {
                let p = Vec3::new(-60_000_000 + k * 1_500_000, 0, -60_000_000 + i * 1_500_000);
                if common::dist(p, away) < 10_000_000 {
                    continue;
                }
                let goal = Vec3::new(p.x + 4_000_000, 0, p.z);
                if self.walker(n, ground, p, ground, goal) {
                    n += 1;
                    if n > F + others as u64 {
                        break 'grid;
                    }
                }
            }
        }
        assert_eq!(n, F + 1 + others as u64, "{others} others placed");
    }

    fn step(&mut self) {
        self.l
            .step(&mut self.c, &mut self.t)
            .unwrap_or_else(|e| panic!("the tick refused: {}: {}", e.name, e.detail));
    }

    fn seen(&self) -> Seen {
        Seen {
            bodies: self.c.controller.bodies().map(|b| (b.id, *b)).collect(),
            running: self.c.running_bodies(),
            ended: self
                .c
                .ended
                .iter()
                .map(|(k, (at, p))| (*k, format!("{at} {p:?}")))
                .collect(),
            log: self.l.log.iter().map(|r| (r.who, r.rung.name())).collect(),
        }
    }
}

/// The open ground's doorway into the building on the way from the west of the square to the ground floor: the link,
/// and where the walk's leg to it ends (its near end).
fn doorway(t: &mut Town, ground: Id, f0: Id) -> (Id, Vec3) {
    let west = Vec3::new(-40_000_000, 0, 30_000_000);
    let b = stand(t, id(999_999), ground, west);
    let legs = t.plan(&b, f0, Vec3::new(0, 0, -3_000_000)).unwrap();
    let leg = legs.iter().find(|l| l.link.is_some()).expect("a doorway");
    (leg.link.unwrap(), leg.to)
}

/// The faulting walker: on the open ground 1.5 m short of the doorway's near end, walking in to the ground floor.
fn walk_in(c: &mut Crowd, ground: Id, f0: Id) -> (Id, Vec3) {
    let (link, near) = doorway(&mut c.t, ground, f0);
    let starts = [(-1, 0), (0, -1), (0, 1), (1, 0), (-1, -1), (-1, 1)];
    let placed = starts.iter().any(|&(dx, dz)| {
        let from = Vec3::new(near.x + dx * 1_500_000, 0, near.z + dz * 1_500_000);
        c.walker(F, ground, from, f0, Vec3::new(0, 0, -3_000_000))
            && c.l.leg(id(F)).and_then(|(_, l)| l.link) == Some(link)
    });
    assert!(placed, "the faulting walker stands by the doorway");
    (link, near)
}

/// Runs `build`'s crowd until `when` holds after a tick (tick `k`), and the same crowd again to tick `k - 1`, then
/// `fault` and tick `k`. Returns both crowds after tick `k`: without the fault, and with it.
fn twins(
    build: &dyn Fn() -> Crowd,
    when: &dyn Fn(&Crowd) -> bool,
    fault: &dyn Fn(&mut Crowd),
) -> (Crowd, Crowd, u64) {
    let mut a = build();
    let mut k = 0;
    loop {
        a.step();
        k += 1;
        if when(&a) {
            break;
        }
        assert!(k < 400, "the moment comes within 20 s");
    }
    let mut b = build();
    for _ in 1..k {
        b.step();
    }
    fault(&mut b);
    b.step();
    (a, b, k)
}

/// The tick of the fault: every other body as in the run without it, the faulting walker refused by `name`, its run
/// ended by that name and the ladder's record of it.
fn contained(a: &Crowd, b: &Crowd, name: &str) {
    let f = id(F);
    let (mut sa, mut sb) = (a.seen(), b.seen());
    assert_eq!(
        b.c.refused
            .iter()
            .map(|(w, r)| (*w, r.name))
            .collect::<Vec<_>>(),
        vec![(f, name)],
        "the one refusal, of the faulting walker: {:?}",
        b.c.refused
    );
    assert!(a.c.refused.is_empty(), "no refusal without the fault");
    assert!(!b.c.running(f), "the faulting walker's run ended");
    match &b.c.ended[&f] {
        (_, Progress::Failed(n)) => assert_eq!(n.as_str(), name, "ended by the refusal's name"),
        other => panic!("ended {other:?}"),
    }
    let rec = b.l.log.last().expect("a record");
    assert_eq!(rec.who, f);
    assert_eq!(rec.order, id(100_000 + F), "its order");
    match &rec.rung {
        Rung::Ended { name: n, detail } => {
            assert_eq!(*n, name);
            println!("{name}: order ended by name, {detail}");
        }
        r => panic!("the record {r:?}"),
    }
    // Everyone else: as without the fault.
    for s in [&mut sa, &mut sb] {
        s.bodies.remove(&f);
        s.running.remove(&f);
        s.ended.remove(&f);
        s.log.retain(|(w, _)| *w != f);
    }
    assert_eq!(sa.bodies.len(), sb.bodies.len());
    assert!(
        sa == sb,
        "every other walker's tick is as without the fault"
    );
}

/// A crowd of `others` walkers on the open ground and the faulting walker by the doorway.
fn at_the_doorway(others: usize) -> impl Fn() -> Crowd {
    move || {
        let (mut c, n) = Crowd::new();
        let (ground, f0) = (n["ground"], n["building/floor-0"]);
        let (_, near) = walk_in(&mut c, ground, f0);
        c.others(ground, near, others);
        c
    }
}

/// The link the faulting walker would cross next taken out of the town (as a rebuild that drops it would).
fn remove_link(c: &mut Crowd) {
    let link = c.l.leg(id(F)).and_then(|(_, l)| l.link).unwrap();
    let b =
        c.t.buildings
            .iter_mut()
            .find(|b| b.link(link).is_some())
            .unwrap();
    b.links.retain(|l| l.id != link);
}

/// A1: in a crowd of 1,000, the link the faulting walker crosses is removed the tick it would be carried onto it.
#[test]
fn a1_a_link_removed_under_one_walker_in_a_crowd_of_1000() {
    let build = at_the_doorway(999);
    let carried = |c: &Crowd| c.c.controller.carrying(id(F)).is_some();
    let (a, b, k) = twins(&build, &carried, &remove_link);
    println!(
        "tick {k}: {} bodies, {} running without the fault, {} with it",
        b.c.controller.bodies().count(),
        a.c.running_bodies().len(),
        b.c.running_bodies().len()
    );
    assert_eq!(b.c.controller.bodies().count(), 1000);
    contained(&a, &b, "link-missing");
    // The others go on after it: the next tick refuses no one.
    let mut b = b;
    b.step();
    assert!(b.c.refused.is_empty(), "{:?}", b.c.refused);
}

/// A2: each kind of mid-tick refusal the walk can raise, in a crowd of 40, contained the same way.
#[test]
fn a2_each_kind_of_mid_tick_refusal_is_contained_by_name() {
    let build = at_the_doorway(39);
    let f = id(F);
    // Its input: the controller no longer gives its run's driver the legs.
    let fifth = |c: &Crowd| c.c.now >= 5 * TICK;
    let (a, b, _) = twins(&build, &fifth, &|c: &mut Crowd| {
        let d = c.c.runs.iter().find(|r| r.body == f).unwrap().driver;
        c.c.controller.release(f, d).unwrap();
    });
    contained(&a, &b, "resource-not-held");
    // Its crossing's track: the link removed under it.
    let carried = |c: &Crowd| c.c.controller.carrying(f).is_some();
    let (a, b, _) = twins(&build, &carried, &remove_link);
    contained(&a, &b, "link-missing");
    // The carry's landing: the far side's surface gone while it is carried.
    let landed = |c: &Crowd| {
        c.c.controller.carrying(f).is_none()
            && c.c.controller.body(f).is_some_and(|b| node_of(b) == c.f0)
    };
    let (a, b, _) = twins(&build, &landed, &|c: &mut Crowd| {
        assert!(c.c.controller.carrying(f).is_some(), "carried");
        let f0 = c.f0;
        c.t.surfaces.remove(&f0);
    });
    contained(&a, &b, "no-surface");
    // Its step on its surface: the floor it walks on gone.
    let inside = |c: &Crowd| {
        c.c.controller.carrying(f).is_none()
            && c.c
                .controller
                .body(f)
                .is_some_and(|b| node_of(b) == c.f0 && b.linear != Vec3::ZERO)
    };
    let (a, b, _) = twins(&build, &inside, &|c: &mut Crowd| {
        let f0 = c.f0;
        c.t.surfaces.remove(&f0);
    });
    contained(&a, &b, "no-surface");
}
