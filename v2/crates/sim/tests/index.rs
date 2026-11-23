//! The spatial index (Engine v2 N16, #2679): who and what is near, in a crowded node, without a scan.
//!
//! `cargo test -p sim --release --test index` checks the answers against a plain scan (A2), a crowd walked with
//! splitting on and off (A4) and the order of answers (A5). The timings (A1, A2, A3) run with
//! `cargo test -p sim --release --test index -- --ignored --nocapture`: two repeats, each arm interleaved.
//!
//! The bodies and things are the test's own seeded scatter: 1,000 bodies over the test hall's floor (30 m by 40 m,
//! N2), 10,000 over ten times its area at the same density; the things likewise, and 10,000 things in the hall
//! itself for A3. One node holds them (the index has no geometry of its own).

// Times its own runs: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

mod common;

use replica::encode::Name;
use replica::ids::{Id, Scope};
use replica::pose::Vec3;
use sim::controller::Controller;
use sim::host::Runner;
use sim::index::{Index, Layers, Rect};
use std::hint::black_box;
use std::time::Instant;

const HALL: [i64; 2] = [30_000_000, 40_000_000];

fn id(n: u64) -> Id {
    Id::new(Scope([9; 16]), n).unwrap()
}

/// SplitMix64: the test's seeded draws.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    /// A whole number in `lo..hi`.
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo) as u64) as i64
    }
}

/// `n` points over a floor of `area` (µm, x and z), seeded.
fn scatter(seed: u64, n: usize, area: [i64; 2]) -> Vec<[i64; 2]> {
    let mut r = Rng(seed);
    (0..n)
        .map(|_| [r.range(0, area[0]), r.range(0, area[1])])
        .collect()
}

/// The floor holding `n` at the hall's density: the hall for 1,000, ten times its area for 10,000.
fn floor_for(n: usize) -> [i64; 2] {
    let k = ((n as f64 / 1000.0).sqrt() * 1000.0) as i64;
    [HALL[0] * k / 1000, HALL[1] * k / 1000]
}

fn kinds() -> [Name; 3] {
    [
        Name::new("souls:seat").unwrap(),
        Name::new("souls:table").unwrap(),
        Name::new("souls:rail").unwrap(),
    ]
}
/// `n` things over `area`, seeded: boxes 0.2 to 1.2 m a side, one in twenty a rail 4 to 10 m long, one in five
/// hundred a road 60 m by 4 m (held apart once the grid is fine); a kind each.
/// 10 m long, one in five hundred a road 60 m by 4 m (held apart once the grid is fine); a kind each.
fn things(seed: u64, n: usize, area: [i64; 2]) -> Vec<(Id, Name, Rect)> {
    let mut r = Rng(seed);
    let k = kinds();
    (0..n)
        .map(|i| {
            let at = [r.range(0, area[0]), r.range(0, area[1])];
            let pick = r.next();
            let (w, d) = if pick.is_multiple_of(500) {
                (60_000_000, 4_000_000)
            } else if pick.is_multiple_of(20) {
                (r.range(4_000_000, 10_000_000), 200_000)
            } else {
                (r.range(200_000, 1_200_000), r.range(200_000, 1_200_000))
            };
            let kind = k[(r.next() % 3) as usize].clone();
            (
                id(100_000 + i as u64),
                kind,
                Rect {
                    min: at,
                    max: [at[0] + w, at[1] + d],
                },
            )
        })
        .collect()
}

fn d2(p: [i64; 2], q: [i64; 2]) -> i128 {
    let (x, z) = (i128::from(p[0] - q[0]), i128::from(p[1] - q[1]));
    x * x + z * z
}

/// A2: "things within a radius" and "what overlaps this outline" give the same sets as a plain scan, on 1,000
/// seeded queries, among 1,000 and 10,000 things (the 10,000 crowded into the hall too, so its grid splits), with
/// bodies in the node, and again after a third of the things are taken out.
#[test]
fn a2_thing_queries_match_a_scan() {
    let node = id(1);
    let k = kinds();
    for (n, area) in [
        (1_000, floor_for(1_000)),
        (10_000, floor_for(10_000)),
        (10_000, HALL),
    ] {
        let mut ix = Index::new();
        let mut all = things(7, n, area);
        for (t, kind, a) in &all {
            ix.put_thing(*t, node, kind, *a);
        }
        let bodies = scatter(8, 1_000, area);
        for (i, p) in bodies.iter().enumerate() {
            ix.put_body(id(i as u64 + 1_000), node, *p);
        }
        for round in 0..2 {
            let mut r = Rng(11 + round);
            let mut answered = 0;
            for q in 0..1_000 {
                let p = [r.range(0, area[0]), r.range(0, area[1])];
                let rad = r.range(100_000, 5_000_000);
                let kind = (q % 2 == 0).then(|| &k[(r.next() % 3) as usize]);
                let got = ix.things_within(node, p, rad, kind);
                let mut want: Vec<Id> = all
                    .iter()
                    .filter(|(_, kd, a)| {
                        kind.is_none_or(|k| k == kd)
                            && a.dist2(p) < i128::from(rad) * i128::from(rad)
                    })
                    .map(|t| t.0)
                    .collect();
                want.sort();
                assert_eq!(
                    got, want,
                    "things within {rad} of {p:?} ({n}, round {round})"
                );
                answered += got.len();

                let o = Rect {
                    min: p,
                    max: [p[0] + r.range(0, 4_000_000), p[1] + r.range(0, 4_000_000)],
                };
                let layers = [Layers::Bodies, Layers::Things, Layers::Both][q % 3];
                let mut want: Vec<Id> = Vec::new();
                if layers != Layers::Things {
                    want.extend(
                        bodies
                            .iter()
                            .enumerate()
                            .filter(|(_, b)| o.holds(**b))
                            .map(|(i, _)| id(i as u64 + 1_000)),
                    );
                }
                if layers != Layers::Bodies {
                    want.extend(all.iter().filter(|t| o.overlaps(&t.2)).map(|t| t.0));
                }
                want.sort();
                assert_eq!(ix.overlapping(node, o, layers), want, "overlapping {o:?}");
            }
            println!(
                "A2: {n} things over {} by {} m, round {round}: 1,000 radius and 1,000 outline queries equal to a scan \
                 ({answered} things answered); grid sizes {:?} mm, splits {}, merges {}",
                area[0] / 1_000_000,
                area[1] / 1_000_000,
                {
                    let s = ix.sizes(node);
                    (s.0 / 1000, s.1 / 1000)
                },
                ix.splits,
                ix.merges
            );
            // Take a third out (picked up, removed, moved away) for the second round.
            let gone: Vec<Id> = all.iter().step_by(3).map(|t| t.0).collect();
            for t in &gone {
                assert!(ix.remove_thing(*t));
            }
            all.retain(|t| !gone.contains(&t.0));
        }
    }
}

/// Every walker's position and velocity, tick by tick: its effect stream, walked by the walk skill through the host's
/// runner on the test world's open ground, its neighbours read from the controller's index (split or fixed).
fn walk_crowd(split: bool) -> Vec<Vec<(Vec3, Vec3)>> {
    let (mut t, _) = common::town(b"souls/index-test/1");
    let ground = t.ground;
    let mut c = Runner::new(50_000);
    if !split {
        c.controller = Controller::with_index(Index::fixed());
    }
    let mut r = Rng(5);
    // 64 walkers packed 0.2 m apart in one 2 m square (over the split mark), each bound for a seeded spot 20 m off,
    // and 64 more coming the other way through them.
    for k in 0..128u64 {
        let (i, j) = ((k % 64) / 8, k % 8);
        let x = if k < 64 { -10_000_000 } else { 10_000_000 };
        let at = Vec3::new(
            x + 100_000 + i as i64 * 200_000,
            0,
            100_000 + j as i64 * 200_000,
        );
        let goal = Vec3::new(
            -x + r.range(-3_000_000, 3_000_000),
            0,
            r.range(-6_000_000, 6_000_000),
        );
        let body = common::stand(&t, id(10 + k), ground, at);
        common::walk(&mut c, &mut t, body, 1_400_000, ground, goal)
            .unwrap_or_else(|e| panic!("no plan: {}: {}", e.name, e.detail));
    }
    let mut out = vec![Vec::new(); 128];
    for _ in 0..1_200 {
        if c.runs.is_empty() {
            break;
        }
        c.tick(&mut t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
        for (k, b) in c.controller.bodies().enumerate() {
            out[k].push((b.pose.position, b.linear));
        }
    }
    assert!(c.runs.is_empty(), "the crowd arrives");
    let ix = c.controller.near();
    if split {
        assert!(ix.splits > 0, "the crowded square split");
    } else {
        assert_eq!((ix.splits, ix.merges), (0, 0));
    }
    out
}

/// A4: each body's stream is identical with cell splitting on and off: the walk skill's crowd on the host's runner (its
/// neighbours read from the controller's index), and an index kept across 400 steps of a seeded crowd that gathers into one square and spreads
/// out again, so its node splits and merges, asked the same questions as an index that never splits.
#[test]
#[ignore = "A2-2: walled in by standing bodies"]
fn a4_streams_identical_with_splitting_on_and_off() {
    let (on, off) = (walk_crowd(true), walk_crowd(false));
    assert_eq!(
        on, off,
        "the crowd walks the same with splitting on and off"
    );
    println!(
        "A4: 128 walkers through one another, from two 2 m squares of 64: {} ticks, every walker's position and \
         velocity equal with splitting on and off",
        on[0].len()
    );

    let node = id(3);
    let (mut a, mut b) = (Index::new(), Index::fixed());
    let mut r = Rng(9);
    let mut at: Vec<[i64; 2]> = scatter(4, 500, [40_000_000, 40_000_000]);
    let mut asked = 0usize;
    for step in 0..400 {
        // Steps 0 to 199 gather on (20 m, 20 m); 200 on, scatter out again.
        for (i, p) in at.iter_mut().enumerate() {
            let goal = if step < 200 {
                [20_000_000, 20_000_000]
            } else {
                [
                    (i as i64 * 7_919_000) % 40_000_000,
                    (i as i64 * 104_729) % 40_000_000,
                ]
            };
            for k in 0..2 {
                let d = goal[k] - p[k];
                p[k] += d.signum() * d.abs().min(300_000) + r.range(-20_000, 20_000);
            }
            a.put_body(id(i as u64), node, *p);
            b.put_body(id(i as u64), node, *p);
        }
        for q in 0..20 {
            let p = at[(step * 20 + q) % at.len()];
            let rad = r.range(200_000, 4_000_000);
            let got = a.bodies_within(node, p, rad);
            assert_eq!(got, b.bodies_within(node, p, rad), "step {step}");
            let want: Vec<Id> = (0..at.len())
                .filter(|&i| d2(p, at[i]) < i128::from(rad) * i128::from(rad))
                .map(|i| id(i as u64))
                .collect();
            assert_eq!(got.iter().map(|e| e.0).collect::<Vec<_>>(), want);
            let cell = a.cell_of(node, p);
            assert!(
                a.bodies_in(cell)
                    .contains(&id((step * 20 + q) as u64 % 500))
            );
            asked += 1;
        }
    }
    println!(
        "A4: 500 bodies kept across 400 steps, gathered and spread: {asked} questions equal with splitting on and \
         off and to a scan; splits {}, merges {}",
        a.splits, a.merges
    );
    assert!(a.splits > 0 && a.merges > 0, "the node split and merged");
    assert_eq!((b.splits, b.merges), (0, 0));
}

/// A5: answers come back in a fixed order: two indexes filled in opposite orders, one splitting, give the same
/// lists, in id order, every thing once.
#[test]
fn a5_answers_in_a_fixed_order() {
    let node = id(4);
    let pts = scatter(3, 2_000, HALL);
    let ts = things(6, 2_000, HALL);
    let (mut a, mut b) = (Index::new(), Index::fixed());
    for (i, p) in pts.iter().enumerate() {
        a.put_body(id(i as u64), node, *p);
    }
    for (i, p) in pts.iter().enumerate().rev() {
        b.put_body(id(i as u64), node, *p);
    }
    for (t, k, r) in &ts {
        a.put_thing(*t, node, k, *r);
    }
    for (t, k, r) in ts.iter().rev() {
        b.put_thing(*t, node, k, *r);
    }
    let mut r = Rng(2);
    for _ in 0..500 {
        let p = [r.range(0, HALL[0]), r.range(0, HALL[1])];
        let rad = r.range(100_000, 6_000_000);
        let x = a.bodies_within(node, p, rad);
        assert_eq!(x, b.bodies_within(node, p, rad));
        assert!(x.windows(2).all(|w| w[0].0 < w[1].0));
        let t = a.things_within(node, p, rad, None);
        assert_eq!(t, b.things_within(node, p, rad, None));
        assert!(t.windows(2).all(|w| w[0] < w[1]), "in id order, each once");
        let o = Rect::around(p, rad);
        assert_eq!(
            a.overlapping(node, o, Layers::Both),
            b.overlapping(node, o, Layers::Both)
        );
    }
    let c = a.cells_within(node, [15_000_000, 20_000_000], 3_000_000);
    assert_eq!(c, a.cells_within(node, [15_000_000, 20_000_000], 3_000_000));
    assert!(c.windows(2).all(|w| w[0] < w[1]));
}

/// Nanoseconds a query, over `qs`.
fn time<T>(qs: &[[i64; 2]], mut f: impl FnMut([i64; 2]) -> T) -> (f64, usize)
where
    T: AsRef<[(Id, i64)]>,
{
    let t = Instant::now();
    let mut n = 0;
    for &p in qs {
        n += black_box(f(p)).as_ref().len();
    }
    (
        t.elapsed().as_nanos() as f64 / qs.len() as f64,
        n / qs.len(),
    )
}

fn time_ids(qs: &[[i64; 2]], mut f: impl FnMut([i64; 2]) -> Vec<Id>) -> (f64, usize) {
    let t = Instant::now();
    let mut n = 0;
    for &p in qs {
        n += black_box(f(p)).len();
    }
    (
        t.elapsed().as_nanos() as f64 / qs.len() as f64,
        n / qs.len(),
    )
}

/// A1, A2 and A3, timed: two repeats, the arms interleaved in each. Prints a table; the bars are checked by the
/// reader against it (the machine's load is stated with the run).
#[test]
#[ignore]
fn timing_a1_a2_a3() {
    let node = id(5);
    const Q: usize = 200_000;
    // "Who is near me": radius for about eight neighbours at the hall's density (1,000 over 1,200 m²).
    const EIGHT: i64 = 1_750_000;
    const THIRTY_TWO: i64 = 3_500_000;
    let bodies = |n: usize, area: [i64; 2], uneven: bool| {
        let mut ix = Index::new();
        let mut pts = scatter(21, n, area);
        if uneven {
            // Half of them in one corner, a tenth of the floor.
            for p in pts.iter_mut().step_by(2) {
                p[0] = p[0] * 316 / 1000;
                p[1] = p[1] * 316 / 1000;
            }
        }
        for (i, p) in pts.iter().enumerate() {
            ix.put_body(id(i as u64), node, *p);
        }
        (ix, pts)
    };
    let queries = |pts: &[[i64; 2]]| {
        let mut r = Rng(31);
        (0..Q)
            .map(|_| pts[(r.next() % pts.len() as u64) as usize])
            .collect::<Vec<_>>()
    };
    let (b1, p1) = bodies(1_000, floor_for(1_000), false);
    let (b10, p10) = bodies(10_000, floor_for(10_000), false);
    let (u1, pu1) = bodies(1_000, floor_for(1_000), true);
    let (u10, pu10) = bodies(10_000, floor_for(10_000), true);
    let (q1, q10, qu1, qu10) = (queries(&p1), queries(&p10), queries(&pu1), queries(&pu10));
    // A3: the same 1,000 bodies with 10,000 things in the hall.
    let (mut bt, _) = bodies(1_000, floor_for(1_000), false);
    for (t, k, r) in things(7, 10_000, HALL) {
        bt.put_thing(t, node, &k, r);
    }
    // A2: things at the hall's density, 1,000 and 10,000.
    let mut t1 = Index::new();
    for (t, k, r) in things(7, 1_000, floor_for(1_000)) {
        t1.put_thing(t, node, &k, r);
    }
    let mut t10 = Index::new();
    for (t, k, r) in things(7, 10_000, floor_for(10_000)) {
        t10.put_thing(t, node, &k, r);
    }
    let seat = Name::new("souls:seat").unwrap();
    let scan = |pts: &[[i64; 2]], p: [i64; 2], r: i64| {
        let r2 = i128::from(r) * i128::from(r);
        pts.iter()
            .enumerate()
            .filter(|(_, q)| d2(p, **q) < r2)
            .map(|(i, _)| (id(i as u64), 0))
            .collect::<Vec<_>>()
    };
    println!(
        "grid sizes mm: 1k bodies {:?}, 10k bodies {:?}, uneven 1k {:?}, uneven 10k {:?}, bodies+10k things {:?}, \
         1k things {:?}, 10k things {:?}",
        b1.sizes(node),
        b10.sizes(node),
        u1.sizes(node),
        u10.sizes(node),
        bt.sizes(node),
        t1.sizes(node),
        t10.sizes(node)
    );
    for rep in 1..=2 {
        println!("-- repeat {rep}");
        let row =
            |name: &str, (ns, n): (f64, usize)| println!("{name:<52} {ns:>8.1} ns  answer {n}");
        row(
            "step 0: plain scan, 1,000 bodies, r 1.75 m",
            time(&q1[..Q / 20], |p| scan(&p1, p, EIGHT)),
        );
        row(
            "step 0: plain scan, 10,000 bodies, r 1.75 m",
            time(&q10[..Q / 200], |p| scan(&p10, p, EIGHT)),
        );
        row(
            "A1 bodies within 1.75 m, 1,000 bodies",
            time(&q1, |p| b1.bodies_within(node, p, EIGHT)),
        );
        row(
            "A1 bodies within 1.75 m, 10,000 bodies",
            time(&q10, |p| b10.bodies_within(node, p, EIGHT)),
        );
        let sub: Vec<[i64; 2]> = q10
            .iter()
            .copied()
            .filter(|p| p[0] < HALL[0] && p[1] < HALL[1])
            .collect();
        row(
            "A1 10,000 bodies, asked only in a hall-sized corner",
            time(&sub, |p| b10.bodies_within(node, p, EIGHT)),
        );
        row(
            "answer size: within 3.5 m, 1,000 bodies",
            time(&q1, |p| b1.bodies_within(node, p, THIRTY_TWO)),
        );
        row(
            "answer size: within 3.5 m, 10,000 bodies",
            time(&q10, |p| b10.bodies_within(node, p, THIRTY_TWO)),
        );
        row(
            "uneven: within 1.75 m, 1,000 bodies",
            time(&qu1, |p| u1.bodies_within(node, p, EIGHT)),
        );
        row(
            "uneven: within 1.75 m, 10,000 bodies",
            time(&qu10, |p| u10.bodies_within(node, p, EIGHT)),
        );
        row(
            "A3 within 1.75 m, 1,000 bodies, no things",
            time(&q1, |p| b1.bodies_within(node, p, EIGHT)),
        );
        row(
            "A3 within 1.75 m, 1,000 bodies, 10,000 things",
            time(&q1, |p| bt.bodies_within(node, p, EIGHT)),
        );
        let tq = |pts: &[[i64; 2]]| {
            pts.iter()
                .map(|p| [p[0] + 300_000, p[1] - 200_000])
                .collect::<Vec<_>>()
        };
        let (tq1, tq10) = (tq(&q1), tq(&q10));
        row(
            "A2 things within 1.75 m, 1,000 things",
            time_ids(&tq1, |p| t1.things_within(node, p, EIGHT, None)),
        );
        row(
            "A2 things within 1.75 m, 10,000 things",
            time_ids(&tq10, |p| t10.things_within(node, p, EIGHT, None)),
        );
        row(
            "A2 seats within 1.75 m, 1,000 things",
            time_ids(&tq1, |p| t1.things_within(node, p, EIGHT, Some(&seat))),
        );
        row(
            "A2 seats within 1.75 m, 10,000 things",
            time_ids(&tq10, |p| t10.things_within(node, p, EIGHT, Some(&seat))),
        );
        let o = |p: [i64; 2]| Rect {
            min: p,
            max: [p[0] + 2_000_000, p[1] + 1_000_000],
        };
        row(
            "A2 overlapping a 2 by 1 m outline, 1,000 things",
            time_ids(&tq1, |p| t1.overlapping(node, o(p), Layers::Things)),
        );
        row(
            "A2 overlapping a 2 by 1 m outline, 10,000 things",
            time_ids(&tq10, |p| t10.overlapping(node, o(p), Layers::Things)),
        );
    }
}
