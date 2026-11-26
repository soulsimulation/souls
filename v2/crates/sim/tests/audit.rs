//! The auditor (Engine v2 K11, #2674) on a world of Eden's size: N2's test world with 10,000 things. A clean pass
//! finds nothing; each of six faults, seeded into the tree's answers in the middle of a sweep, is reported by name
//! and node within 2 s of world time (A1); the sweep runs in slices inside the clock's ticks, repairs nothing, and
//! every tick runs (A2). `cargo test -p sim --release --test audit -- --nocapture` prints the numbers.
//!
//! The tree keeps a parent and its children, and a link and both its ends, consistent by construction, and offers
//! no way to break them from outside `replica`, so the faults are seeded at the auditor's read seam (`Source`): the
//! real tree, read through a source that answers one question wrongly.

#![allow(clippy::disallowed_methods)]

use replica::ids::{Id, Scope};
use replica::pose::Support;
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use replica::tree::{Handle, Tree};
use replica::world_model::show;
use sim::audit::{Auditor, Fault, Seen, Source};
use sim::clock::{Clock, Heartbeat, Ticker};
use std::time::Instant;

/// 20 ticks a second.
const TICK: Micros = 50_000;
/// Nodes or timers checked a tick.
const BUDGET: usize = 600;
/// The bar: a seeded fault is named within this much world time.
const WITHIN: Micros = 2_000_000;
const R0: Micros = 1_763_400_000_000_000;

fn eden() -> Tree {
    let w = testworld::generate(1, 10_000).expect("the test world");
    import_eden::load(&w.text)
        .expect("the test world loads")
        .tree
}

fn gone(n: u64) -> Id {
    Id::new(Scope([0xEE; 16]), n).unwrap()
}

/// Real time as it passes, with a sleep that jumps: the ticks cost what they really cost, and nobody waits.
struct Measured {
    t0: Instant,
    jumped: Micros,
}

impl Clock for Measured {
    fn now(&mut self) -> Micros {
        R0 + self.t0.elapsed().as_micros() as Micros + self.jumped
    }
    fn sleep_until(&mut self, t: Micros) {
        let now = self.now();
        self.jumped += (t - now).max(0);
    }
}

fn ticker() -> (Ticker, Measured) {
    let m = Mapping::new(0, R0, 1, 1).unwrap();
    let line = Timeline::start(
        m,
        TickRate::new(0, 0, 20).unwrap(),
        Tempo::per_minute(0, 0, 120).unwrap(),
    )
    .unwrap();
    let t = Ticker::new(line, m, None, R0).unwrap();
    (
        t,
        Measured {
            t0: Instant::now(),
            jumped: 0,
        },
    )
}

/// One fault, seeded into what the tree answers.
#[derive(Clone, Copy, Debug)]
enum Seed {
    None,
    /// The child names another parent than the one that lists it.
    Parent {
        child: Id,
        says: Id,
    },
    /// The link is missing from the index at `end`.
    OneEnd {
        end: Id,
        link: Id,
    },
    /// Two siblings both in slot 9.
    OverFull {
        a: Id,
        b: Id,
    },
    /// Three children in that one slot (#4575: over a seat of two places).
    Three {
        a: Id,
        b: Id,
        c: Id,
    },
    /// Held by its frame's slot, in no slot.
    Hold {
        node: Id,
    },
    /// A pending timer on a node that is not in the zone.
    Timer {
        node: Id,
    },
    /// Standing on a surface that is not in the zone.
    Support {
        node: Id,
    },
}

struct Seeded<'a> {
    tree: &'a Tree,
    seed: Seed,
}

impl Source for Seeded<'_> {
    fn root(&self) -> Handle {
        self.tree.root()
    }
    fn handle(&self, id: Id) -> Option<Handle> {
        self.tree.handle(id)
    }
    fn node(&self, h: Handle) -> Option<Seen> {
        let mut n = Source::node(self.tree, h)?;
        match self.seed {
            Seed::Parent { child, says } if n.id == child => n.parent = Some(says),
            Seed::OverFull { a, b } if n.id == a || n.id == b => n.slot = Some(9),
            Seed::Three { a, b, c } if n.id == a || n.id == b || n.id == c => n.slot = Some(9),
            Seed::Hold { node } if n.id == node => {
                n.support = Some(Support::Slot);
                n.slot = None;
            }
            Seed::Support { node } if n.id == node => {
                n.support = Some(Support::Surface {
                    surface: gone(1),
                    height: 0,
                });
            }
            _ => {}
        }
        Some(n)
    }
    fn children(&self, h: Handle) -> Vec<Handle> {
        Source::children(self.tree, h)
    }
    fn links_at(&self, end: Id) -> Vec<(Id, Id)> {
        let mut v = Source::links_at(self.tree, end);
        if let Seed::OneEnd { end: e, link } = self.seed
            && e == end
        {
            v.retain(|(l, _)| *l != link);
        }
        v
    }
    fn link(&self, id: Id) -> Option<[Id; 2]> {
        Source::link(self.tree, id)
    }
    fn timers(&self, after: Option<Id>, max: usize) -> Vec<(Id, Id)> {
        let mut v = Source::timers(self.tree, after, max);
        if let Seed::Timer { node } = self.seed
            && after.is_none()
            && v.len() < max
        {
            v.push((gone(2), node));
        }
        v
    }
}

/// A node, its children and its links (each link's id and other end).
type Census = (Id, Vec<Id>, Vec<(Id, Id)>);

/// Every node, in walk order, with its children and links.
fn census(t: &Tree) -> Vec<Census> {
    let mut out = Vec::new();
    let mut stack = vec![t.root()];
    while let Some(h) = stack.pop() {
        let n = t.node(h).unwrap();
        let kids: Vec<Handle> = t.children(h).unwrap().to_vec();
        let ids = kids.iter().map(|k| t.node(*k).unwrap().id()).collect();
        let links = Source::links_at(t, n.id());
        out.push((n.id(), ids, links));
        stack.extend(kids.iter().rev());
    }
    out
}

/// SplitMix64.
struct Rng(u64);
impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) % n as u64) as usize
    }
}

/// The six faults, each on a node chosen by the seed, with the fault the auditor should report.
fn seeds(t: &Tree, rng: &mut Rng) -> Vec<(Seed, &'static str, Id)> {
    let all = census(t);
    let pick = |rng: &mut Rng, f: &dyn Fn(&Census) -> bool| {
        let c: Vec<_> = all.iter().filter(|x| f(x)).collect();
        c[rng.below(c.len())].clone()
    };
    let (parent, kids, _) = pick(rng, &|x| x.1.len() >= 2);
    let child = kids[rng.below(kids.len())];
    let says = all[rng.below(all.len())].0;
    let says = if says == parent { all[0].0 } else { says };
    // A link between two nodes here: the far end is swept, and finds its link missing at this end.
    let inner = |x: &Census| -> Vec<(Id, Id)> {
        x.2.iter()
            .filter(|(_, o)| *o != x.0 && t.handle(*o).is_some())
            .copied()
            .collect()
    };
    let (end, _, _) = pick(rng, &|x| !inner(x).is_empty());
    let links = inner(all.iter().find(|x| x.0 == end).unwrap());
    let (link, other) = links[rng.below(links.len())];
    let (p2, kids2, _) = pick(rng, &|x| x.1.len() >= 2);
    let (a, b) = (kids2[0], kids2[1]);
    let held = pick(rng, &|x| x.0 != all[0].0).0;
    let stands = pick(rng, &|x| x.0 != all[0].0).0;
    let timed = gone(3);
    vec![
        (Seed::Parent { child, says }, "parent-disagrees", child),
        // Reported from the other end, whose index still has the link.
        (Seed::OneEnd { end, link }, "link-one-end", other),
        (Seed::OverFull { a, b }, "slot-over-full", p2),
        (Seed::Hold { node: held }, "hold-without-holder", held),
        (Seed::Timer { node: timed }, "timer-orphan", timed),
        (Seed::Support { node: stands }, "support-missing", stands),
    ]
}

/// A clean pass over Eden finds nothing, and the sweep's slices cost little of a tick.
#[test]
fn a_clean_pass_over_eden_finds_nothing() {
    let tree = eden();
    let (nodes, links) = tree.counts();
    let mut a = Auditor::new();
    let (mut slices, mut worst, mut found) = (0, 0u128, Vec::new());
    let t0 = Instant::now();
    loop {
        let s0 = Instant::now();
        let s = a.slice(&tree, BUDGET);
        worst = worst.max(s0.elapsed().as_micros());
        slices += 1;
        found.extend(s.faults);
        if s.pass_ended {
            break;
        }
    }
    println!(
        "clean: {nodes} nodes, {links} links: one pass in {slices} slices of {BUDGET} ({} ms of world time), {} us in all, the longest slice {worst} us; faults {found:?}",
        slices * TICK / 1000,
        t0.elapsed().as_micros()
    );
    assert!(found.is_empty(), "a clean tree has no faults: {found:?}");
    assert!(nodes >= 10_000);
    assert!(slices as Micros * TICK < WITHIN, "a full pass under 2 s");
}

/// A1, A2: each of six faults, seeded in the middle of a sweep under the clock, is reported by name and node within
/// 2 s of world time. The auditor writes nothing (the tree's state is the same after), and every tick runs.
#[test]
fn a1_a2_six_seeded_faults_each_named_within_two_seconds() {
    let tree = eden();
    let before = tree.to_state();
    let mut rng = Rng(2674);
    for (seed, name, node) in seeds(&tree, &mut rng) {
        let (mut ticker, mut clock) = ticker();
        let beat = Heartbeat::new(R0);
        let mut a = Auditor::new();
        // The fault appears at a seeded tick, partway through a pass.
        let at = 5 + rng.below(30) as i64;
        let (mut seen_at, mut worst, mut ticks): (Option<i64>, u128, i64) = (None, 0, 0);
        let mut faults: Vec<Fault> = Vec::new();
        while ticks < at + 100 && seen_at.is_none() {
            ticker
                .run_due(&mut clock, &beat, &mut |n, _| {
                    let src = Seeded {
                        tree: &tree,
                        seed: if n >= at { seed } else { Seed::None },
                    };
                    let s0 = Instant::now();
                    let s = a.slice(&src, BUDGET);
                    worst = worst.max(s0.elapsed().as_micros());
                    if n >= at
                        && seen_at.is_none()
                        && s.faults.iter().any(|f| f.name == name && f.node == node)
                    {
                        seen_at = Some(n);
                    }
                    faults.extend(s.faults);
                    ticks = n + 1;
                })
                .unwrap();
            ticker.wait(&mut clock).unwrap();
        }
        let seen =
            seen_at.unwrap_or_else(|| panic!("{name} on {} not reported: {faults:?}", show(node)));
        let late = (seen - at + 1) * TICK;
        let first = faults.iter().find(|f| f.name == name).unwrap();
        println!(
            "{name}: seeded at tick {at}, named at tick {seen} ({} ms of world time), on {}: {}; the longest slice {worst} us; ticks run {} of {}, overruns {}",
            late / 1000,
            show(first.node),
            first.detail,
            ticker.stats.ticks,
            ticks,
            ticker.stats.overruns
        );
        assert!(late <= WITHIN, "{name} named within 2 s: {late} us");
        assert_eq!(ticker.stats.ticks as i64, ticks, "every tick ran");
        assert_eq!(beat.read().0, ticks - 1, "the heartbeat kept pace");
        assert!(
            faults.iter().all(|f| f.name == name),
            "only the seeded fault is reported: {faults:?}"
        );
    }
    assert_eq!(tree.to_state(), before, "the auditor repairs nothing");
}

/// #4575 (E16's false alarm): two children in one slot of their parent are `slot-over-full` when the slot holds one,
/// and no fault when the slot holds two (a seat's `most`, as a served world tells the auditor); three in a slot of
/// two are over full again.
#[test]
fn a_slot_of_two_places_holding_two_bodies_is_not_over_full() {
    let tree = eden();
    let all = census(&tree);
    let (parent, kids, _) = all
        .iter()
        .find(|x| x.1.len() >= 3)
        .expect("a node of three")
        .clone();
    let run = |seed: Seed, most: usize| {
        let src = Seeded { tree: &tree, seed };
        let mut a = Auditor::new();
        let mut faults = Vec::new();
        loop {
            let s = a.slice_most(&src, BUDGET, &|n, s| {
                if n == parent && s == 9 { most } else { 1 }
            });
            faults.extend(s.faults);
            if s.pass_ended {
                break faults;
            }
        }
    };
    let two = Seed::OverFull {
        a: kids[0],
        b: kids[1],
    };
    let one = run(two, 1);
    println!("two in a slot of one: {one:?}");
    assert!(
        one.iter()
            .any(|f| f.name == "slot-over-full" && f.node == parent)
    );
    let ok = run(two, 2);
    println!("two in a slot of two: {ok:?}");
    assert!(ok.is_empty(), "{ok:?}");
    let three = Seed::Three {
        a: kids[0],
        b: kids[1],
        c: kids[2],
    };
    let over = run(three, 2);
    println!("three in a slot of two: {over:?}");
    assert!(
        over.iter()
            .any(|f| f.name == "slot-over-full" && f.node == parent)
    );
}

/// Every node held in a slot and in none: each node the sweep checks is named once, by `hold-without-holder`, so the
/// faults list exactly the nodes checked.
struct EveryNode<'a>(&'a Tree);

impl Source for EveryNode<'_> {
    fn root(&self) -> Handle {
        self.0.root()
    }
    fn handle(&self, id: Id) -> Option<Handle> {
        self.0.handle(id)
    }
    fn node(&self, h: Handle) -> Option<Seen> {
        let mut n = Source::node(self.0, h)?;
        n.support = Some(Support::Slot);
        n.slot = None;
        Some(n)
    }
    fn children(&self, h: Handle) -> Vec<Handle> {
        Source::children(self.0, h)
    }
    fn links_at(&self, end: Id) -> Vec<(Id, Id)> {
        Source::links_at(self.0, end)
    }
    fn link(&self, id: Id) -> Option<[Id; 2]> {
        Source::link(self.0, id)
    }
    fn timers(&self, after: Option<Id>, max: usize) -> Vec<(Id, Id)> {
        Source::timers(self.0, after, max)
    }
}

/// K21 (#3430): a slice bounded by time still audits every node within a stated number of slices. Out of time at
/// every step (the worst clock), each slice checks one node and a pass of N nodes and T timers ends within N + T + 1
/// slices; out of time after every 7th node, within ⌈(N + T) / 7⌉ + 1; never out of time, as [`Auditor::slice`].
/// Each arm names every node exactly once.
#[test]
fn k21_a_slice_out_of_time_still_audits_every_node_within_the_stated_slices() {
    let tree = eden();
    let all: Vec<Id> = census(&tree).into_iter().map(|c| c.0).collect();
    let (n, t) = (all.len(), tree.timers().len());
    let arms: [(&str, usize, usize); 3] = [
        ("always out of time", 1, n + t + 1),
        ("out of time every 7th node", 7, (n + t).div_ceil(7) + 1),
        ("never out of time", BUDGET, (n + t).div_ceil(BUDGET) + 1),
    ];
    for (arm, every, bound) in arms {
        let mut a = Auditor::new();
        let mut named: Vec<Id> = Vec::new();
        let mut slices = 0;
        loop {
            let mut steps = 0;
            let s = a.slice_within(&EveryNode(&tree), BUDGET, &|_, _| 1, &mut || {
                steps += 1;
                steps >= every
            });
            slices += 1;
            assert!(
                s.checked >= 1 || s.pass_ended,
                "{arm}: a slice checks at least one"
            );
            assert!(
                s.checked <= every,
                "{arm}: the slice stopped when out of time"
            );
            named.extend(s.faults.iter().map(|f| {
                assert_eq!(f.name, "hold-without-holder");
                f.node
            }));
            if s.pass_ended {
                break;
            }
            assert!(
                slices <= bound,
                "{arm}: the pass ended within {bound} slices"
            );
        }
        println!("{arm}: {n} nodes, {t} timers, one pass in {slices} slices (bound {bound})");
        assert!(slices <= bound, "{arm}: {slices} slices, bound {bound}");
        let mut sorted = named.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), named.len(), "{arm}: no node named twice");
        let mut want = all.clone();
        want.sort();
        assert_eq!(sorted, want, "{arm}: every node audited");
    }
}
