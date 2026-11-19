//! Edits and set-downs never stall the clock (Engine v2 G3b, #3449): on Eden, a change on the open ground cuts again
//! only the squares it touches, and a building's change only that building.
//!
//! `cargo test -p sim --release --test g3b -- --ignored --nocapture`, with the exported Eden facts file. 50 things on
//! the open ground are moved 1.5 m (as a set-down puts a thing down), 50 have their box set to a 1 m crate (as a
//! creator's edit does), and 20 edits are made inside buildings, each rebuilt off the clock and installed, one after
//! another. The rebuild and install times are printed with their p50, p99 and most; the first ten open-ground cuts are
//! compared square by square with a whole cut of the same tree, and at the end 500 routes on the map as installed are
//! compared with a map built whole from the committed tree.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

mod common;

use import_eden::F_SOLIDS;
use replica::effects::{
    Actor, Body as EffectBody, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest,
};
use replica::encode::{Value, encode};
use replica::ids::Id;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::world_model::Audience;
use sim::edit::safety::{Who, guard};
use sim::ground::scene::Scene;
use sim::ground::{HUMAN_RADIUS, OpenGround};
use sim::routes::{HANDS, Hop, Map, Route};
use sim::walk::town::Town;
use std::collections::BTreeMap;
use std::time::Instant;

const F_SCENE: u64 = F_SOLIDS;

fn eden() -> Town {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    common::town_of(
        import_eden::load(&text).expect("Eden loads"),
        b"souls/g3b-test/1",
    )
    .0
}

fn part(t: &Town, node: Id, change: Change) -> Part {
    let e = Effect {
        envelope: Envelope {
            sequence: t.doors.next,
            at: 0,
            cause: Cause::Intent(common::id(9_000)),
            actor: Actor::Creator(common::id(9_001)),
            audience: Audience::Everyone,
            node,
        },
        body: EffectBody::Changes(vec![ChangeRec {
            change,
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    };
    let bytes = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(t.doors.header.hash().to_bytes())),
        (2, Value::Array(vec![e.to_value()])),
    ])))
    .unwrap();
    Part::read(&bytes).unwrap()
}

/// A 1 m crate's box, 1.2 m tall, set as `node`'s only box.
fn crate_box(t: &Town, node: Id) -> Part {
    let row = [0u64, 0, 500, 500, 0, 0, 1_200];
    part(
        t,
        node,
        Change::Set {
            node,
            field: F_SCENE,
            to: Value::Array(vec![Value::Array(
                row.iter().map(|&v| Value::Uint(v)).collect(),
            )]),
            by: None,
        },
    )
}

/// `node` moved 1.5 m along x on its parent, as a thing set down beside where it stood.
fn moved(t: &Town, node: Id) -> Part {
    let n = t.tree.node(t.tree.handle(node).unwrap()).unwrap();
    let place = n.place().unwrap();
    let from = Frame {
        node: n.parent().unwrap(),
        slot: n.slot(),
    };
    let pose = Pose {
        frame: from,
        position: Vec3::new(
            place.position.x + 1_500_000,
            place.position.y,
            place.position.z,
        ),
        orientation: place.orientation,
        support: place.support,
    };
    part(t, node, Change::Reparent { node, from, pose })
}

fn pct(v: &mut [u128], p: usize) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_unstable();
    let i = ((v.len() * p).div_ceil(100)).clamp(1, v.len()) - 1;
    v[i] as f64 / 1000.0
}

fn route_key(m: &Map, r: &Route) -> String {
    let hops: Vec<String> = r
        .hops
        .iter()
        .map(|h| match h {
            Hop::Patch { at, piece } => format!("{at:?} {:?}", m.piece(*piece).outline),
            Hop::Link { id, kind } => format!("{id:?} {kind:?}"),
        })
        .collect();
    format!("{hops:?} {:?} {:?} {}", r.first_line, r.waypoints, r.length)
}

#[derive(Default)]
struct Times {
    rebuild: Vec<u128>,
    install: Vec<u128>,
    squares: Vec<usize>,
    touched: Vec<usize>,
    whole: usize,
}

impl Times {
    fn line(&mut self, what: &str) -> String {
        let n = self.rebuild.len();
        let (mut r, mut i) = (self.rebuild.clone(), self.install.clone());
        format!(
            "{what}: {n} changes, {} built whole, squares cut {:?}; rebuild off the clock p50 {:.2} ms, p99 {:.2} ms, most {:.2} ms; install on the clock p50 {:.2} ms, p99 {:.2} ms, most {:.2} ms",
            self.whole,
            {
                let mut c = BTreeMap::new();
                for s in &self.squares {
                    *c.entry(*s).or_insert(0) += 1;
                }
                c
            },
            pct(&mut r, 50),
            pct(&mut r, 99),
            pct(&mut r, 100),
            pct(&mut i, 50),
            pct(&mut i, 99),
            pct(&mut i, 100)
        )
    }
}

/// Rebuilds and installs `p`, its times kept in `times`; the squares cut again.
fn apply(t: &mut Town, p: &Part, times: &mut Times) -> Vec<(i32, i32)> {
    times.touched.push(0);
    // The copy is the caller's (K8 publishes them off the clock): made and dropped outside the time.
    let (mut base, header, versions, basis) = (
        t.tree.frozen(),
        t.doors.header.clone(),
        t.versions.clone(),
        t.basis(),
    );
    let t0 = Instant::now();
    let r =
        Town::rebuild_on(&mut base, &header, t.ground, &versions, &basis, p).expect("the rebuild");
    times.rebuild.push(t0.elapsed().as_micros());
    drop(base);
    times.squares.push(r.squares());
    if std::env::var_os("G3B_DEBUG").is_some() {
        println!(
            "  change: touched {} (ground {}), whole {} ({:?}), squares {}, {:.2} ms",
            r.touched.len(),
            r.touched.contains(&t.ground),
            r.whole(),
            r.why,
            r.squares(),
            *times.rebuild.last().unwrap() as f64 / 1000.0
        );
    }
    times.whole += usize::from(r.whole());
    let cut = r.cut_squares();
    *times.touched.last_mut().unwrap() = r.touched.len();
    let t1 = Instant::now();
    t.install(r, p)
        .unwrap_or_else(|e| panic!("install refused: {}: {}", e.name, e.detail));
    times.install.push(t1.elapsed().as_micros());
    cut
}

#[test]
#[ignore = "needs the exported Eden facts file"]
fn eden_changes_cut_only_their_squares() {
    let t0 = Instant::now();
    let mut t = eden();
    println!("Eden town built whole in {} ms", t0.elapsed().as_millis());
    let ground = t.ground;
    let gh = t.tree.handle(ground).unwrap();
    // Things standing on the open ground with a box of their own, by a seeded draw.
    let mut things: Vec<Id> = t
        .tree
        .children(gh)
        .unwrap()
        .iter()
        .filter_map(|&c| t.tree.node(c))
        .filter(|n| {
            n.fields().contains_key(&F_SOLIDS)
                && t.tree
                    .children(t.tree.handle(n.id()).unwrap())
                    .is_some_and(|k| k.is_empty())
        })
        .map(|n| n.id())
        .collect();
    let mut seed = 0x3449_u64;
    let mut next = move || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) as usize
    };
    for k in (1..things.len()).rev() {
        things.swap(k, next() % (k + 1));
    }
    println!(
        "{} things with boxes stand on the open ground",
        things.len()
    );
    let mut open = Times::default();
    for (k, &node) in things.iter().take(100).enumerate() {
        let p = if k % 2 == 0 {
            moved(&t, node)
        } else {
            crate_box(&t, node)
        };
        let cut = apply(&mut t, &p, &mut open);
        if cut.is_empty() {
            // Nothing cut again: the thing gives the open ground's scene nothing (a door in its doorway is the link's).
            let tree = &t.tree;
            let s = Scene::of_child(tree, gh, tree.handle(node).unwrap(), None).unwrap();
            assert!(
                s.solids.is_empty() && s.footprints.is_empty() && s.doorways.is_empty(),
                "A2: {} changed the open ground's scene and cut no square",
                tree.node(tree.handle(node).unwrap())
                    .unwrap()
                    .kind()
                    .as_str()
            );
        }
        if k < 10 && !cut.is_empty() {
            // Each square as a whole cut of the committed tree gives it.
            let o = OpenGround::of(&t.tree, ground, HUMAN_RADIUS).unwrap();
            let b = t.basis();
            for sq in cut {
                let whole = format!("{:?}", o.cut_square(sq.0, sq.1).pieces);
                assert_eq!(
                    format!("{:?}", b.square(sq).unwrap_or(&[])),
                    whole,
                    "A2: square {sq:?} as a whole cut gives it"
                );
            }
        }
    }
    println!("{}", open.line("A2 the open ground"));

    // Inside buildings: the thing with a box on a floor of 20 buildings, set to a crate.
    let mut inside = Times::default();
    let mut done = 0;
    let buildings: Vec<(Id, Vec<Id>)> = t
        .buildings
        .iter()
        .filter(|b| b.thing != ground)
        .map(|b| (b.thing, b.floors.keys().copied().collect()))
        .collect();
    for (_, floors) in buildings {
        let tree = &t.tree;
        // The first thing with a box anywhere below a floor (in a room, on a floor).
        let thing = floors.iter().find_map(|&f| {
            let mut stack: Vec<_> = tree.handle(f).into_iter().collect();
            while let Some(h) = stack.pop() {
                let kids = tree.children(h).unwrap_or(&[]);
                stack.extend(kids.iter().rev().copied());
                if let Some(n) = kids
                    .iter()
                    .filter_map(|&c| tree.node(c))
                    .find(|n| n.fields().contains_key(&F_SOLIDS))
                {
                    return Some(n.id());
                }
            }
            None
        });
        let Some(thing) = thing else { continue };
        let p = crate_box(&t, thing);
        apply(&mut t, &p, &mut inside);
        assert!(
            *inside.touched.last().unwrap() > 0,
            "A2: an edit in a building touches its floors"
        );
        done += 1;
        if done == 20 {
            break;
        }
    }
    println!("{}", inside.line("A2 a building"));

    // A3: G2's check on Eden, two of its steps apart: the guard off the clock (the route maps of both sides), and
    // the verdict on the commit tick for 20 bodies standing on the open ground (lookups).
    let mut bodies = Vec::new();
    for q in 0..t.map.counts().0 as u32 {
        if bodies.len() == 20 {
            break;
        }
        let at = t.map.patch_of(q);
        if at.node != ground || t.map.water_of(q).is_some() {
            continue;
        }
        if let Some(s) = t.map.standing(q).first() {
            let n = bodies.len() as u64;
            bodies.push(Who {
                soul: common::id(100 + n),
                body: common::id(200 + n),
                pose: Pose {
                    frame: Frame {
                        node: ground,
                        slot: None,
                    },
                    position: Vec3::new(s[0] * 1000, s[1] * 1000, s[2] * 1000),
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: ground,
                        height: 0,
                    },
                },
                has: HANDS,
                crossing: None,
            });
        }
    }
    let (mut guards, mut judges) = (Vec::new(), Vec::new());
    for &node in things.iter().skip(100).take(2) {
        let p = crate_box(&t, node);
        let t0 = Instant::now();
        let g = guard(&t.tree, &t.doors.header, Some(ground), &p).expect("the guard");
        guards.push(t0.elapsed().as_micros());
        for _ in 0..50 {
            let t1 = Instant::now();
            let v = g.judge(&bodies);
            judges.push(t1.elapsed().as_micros());
            assert!(v.len() <= bodies.len());
        }
    }
    println!(
        "A3 G2's check on Eden: the guard off the clock {:?} ms; the verdict on the tick for {} bodies p50 {:.3} ms, p99 {:.3} ms, most {:.3} ms",
        guards.iter().map(|u| u / 1000).collect::<Vec<_>>(),
        bodies.len(),
        pct(&mut judges.clone(), 50),
        pct(&mut judges.clone(), 99),
        pct(&mut judges, 100)
    );

    // Routes on the map as installed equal a map built whole from the committed tree.
    let mut whole = Map::build(&t.tree, ground, &|n| t.versions.of(n)).expect("the whole map");
    let mut spots = Vec::new();
    for q in 0..whole.counts().0 as u32 {
        let node = whole.patch_of(q).node;
        for s in whole.standing(q) {
            spots.push((node, Vec3::new(s[0] * 1000, s[1] * 1000, s[2] * 1000)));
        }
    }
    let go = |m: &mut Map, tree: &replica::tree::Tree, a: (Id, Vec3), b: (Id, Vec3)| {
        let (Some(from), Some(to)) = (m.spot(a.0, a.1), m.spot(b.0, b.1)) else {
            return "no spot".to_owned();
        };
        match m.route(tree, from, to, HANDS) {
            Ok(r) => route_key(m, &r),
            Err(e) => format!("{}: {}", e.name, e.detail),
        }
    };
    let (mut same, mut differ) = (0, Vec::new());
    for _ in 0..500 {
        let (a, b) = (spots[next() % spots.len()], spots[next() % spots.len()]);
        let inc = go(&mut t.map, &t.tree, a, b);
        let full = go(&mut whole, &t.tree, a, b);
        if inc == full {
            same += 1;
        } else {
            differ.push((a, b, inc.len(), full.len()));
        }
    }
    println!("A2 routes: {same} of 500 equal a whole build's; differ: {differ:?}");
    assert!(differ.is_empty(), "A2: routes equal a whole build's");
    if !cfg!(debug_assertions) {
        let mut one: Vec<u128> = open
            .rebuild
            .iter()
            .zip(&open.squares)
            .filter(|(_, s)| **s <= 1)
            .map(|(us, _)| *us)
            .collect();
        let n = one.len();
        let p99 = pct(&mut one, 99);
        let mut b = inside.rebuild.clone();
        println!(
            "A2 bars: {n} changes on the open ground cutting at most one square, p99 {p99:.2} ms (bar 5 ms); a building p99 {:.2} ms (bar 20 ms)",
            pct(&mut b, 99)
        );
    }
}

/// A4 on Eden: the clock ticks every 50 ms with 20 walkers on the open ground while 50 creator's edits (a thing's
/// box set to a crate) and 50 set-downs (a thing moved 1.5 m) are rebuilt one after another on a thread of their own
/// and each installed on the next tick. No tick, its install and the walkers' re-plans included, takes 50 ms or more.
/// The tree copy each rebuild starts from is K8's in the world (made off the clock); here it is made between ticks and
/// its time is kept apart. Writes `.local/g3b-health.json`.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn eden_no_tick_stalls_while_the_ground_changes() {
    use replica::effects::Header;
    use replica::tree::Tree;
    use sim::ground::Versions;
    use sim::host::Runner;
    use sim::unstick::Ladder;
    use sim::walk::town::Basis;
    use std::sync::mpsc::channel;
    const TICK: i64 = 50_000;
    const SPEED: i64 = 1_400_000;
    let mut t = eden();
    let ground = t.ground;
    let gh = t.tree.handle(ground).unwrap();
    let mut seed = 0x0034_49a4_u64;
    let mut next = move || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) as usize
    };
    // 20 walkers between seeded standing places of the open ground.
    let mut spots = Vec::new();
    for q in 0..t.map.counts().0 as u32 {
        if t.map.patch_of(q).node == ground && t.map.water_of(q).is_none() {
            spots.extend(
                t.map
                    .standing(q)
                    .into_iter()
                    .map(|s| Vec3::new(s[0] * 1000, 0, s[2] * 1000)),
            );
        }
    }
    let mut c = Runner::new(TICK);
    let mut ladder = Ladder::new();
    let mut walkers = 0u64;
    while walkers < 20 {
        let (a, b) = (spots[next() % spots.len()], spots[next() % spots.len()]);
        let who = common::id(10_000 + walkers);
        let Ok(body) = t.surfaces[&ground].place(
            who,
            Frame {
                node: ground,
                slot: None,
            },
            a,
            Quat::IDENTITY,
        ) else {
            continue;
        };
        let Ok(legs) = common::walk(&mut c, &mut t, body, SPEED, ground, b) else {
            continue;
        };
        ladder.add(who, common::id(20_000 + walkers), SPEED, ground, b, legs);
        walkers += 1;
    }
    let mut things: Vec<Id> = t
        .tree
        .children(gh)
        .unwrap()
        .iter()
        .filter_map(|&c| t.tree.node(c))
        .filter(|n| {
            n.fields().contains_key(&F_SOLIDS)
                && t.tree
                    .children(t.tree.handle(n.id()).unwrap())
                    .is_some_and(|k| k.is_empty())
        })
        .map(|n| n.id())
        .collect();
    for k in (1..things.len()).rev() {
        things.swap(k, next() % (k + 1));
    }
    things.truncate(100);

    // The rebuilding thread.
    type Job = (Tree, Header, Versions, Basis, Part);
    let (to_job, jobs) = channel::<Job>();
    let (to_clock, done) = channel();
    let worker = std::thread::spawn(move || {
        for (mut base, header, versions, basis, part) in jobs {
            let t0 = Instant::now();
            let r = Town::rebuild_on(&mut base, &header, ground, &versions, &basis, &part);
            let us = t0.elapsed().as_micros();
            to_clock.send((r, part, us)).unwrap();
            drop(base);
        }
    });
    let (mut ticks, mut installs, mut rebuilds, mut copies) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut sent, mut whole, mut busy) = (0usize, 0usize, false);
    let start = Instant::now();
    let mut n = 0u32;
    // G3B_QUIET: the same walkers and ticks with no change made, for a baseline.
    let quiet = std::env::var_os("G3B_QUIET").is_some();
    while (installs.len() < things.len() && n < 20 * 600) && !(quiet && n >= 160) {
        let t0 = Instant::now();
        let (mut inst, mut stale) = (0u128, 0usize);
        if let Ok((r, part, us)) = done.try_recv() {
            let r: Result<sim::walk::town::Rebuilt, String> = r;
            let r = r.expect("the rebuild");
            whole += usize::from(r.whole());
            if let Some(w) = r.why {
                println!("  built whole: {w}");
            }
            rebuilds.push(us);
            let t1 = Instant::now();
            t.install(r, &part)
                .unwrap_or_else(|e| panic!("install refused: {}: {}", e.name, e.detail));
            installs.push(t1.elapsed().as_micros());
            (inst, stale) = (*installs.last().unwrap(), t.stale.len());
            busy = false;
        }
        let searched = t.spent.get().searches;
        ladder
            .step(&mut c, &mut t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
        ticks.push(t0.elapsed().as_micros());
        if *ticks.last().unwrap() >= 20_000 {
            println!(
                "  tick {n}: {:.2} ms; install {:.2} ms, walks it made stale {stale}; lines searched {}",
                *ticks.last().unwrap() as f64 / 1000.0,
                inst as f64 / 1000.0,
                t.spent.get().searches - searched
            );
        }
        n += 1;
        // Between ticks: the next change, from a copy of the tree as it stands (K8's, in the world).
        if !busy && sent < things.len() && !quiet {
            let node = things[sent];
            let part = if sent % 2 == 0 {
                moved(&t, node)
            } else {
                crate_box(&t, node)
            };
            let c0 = Instant::now();
            let base = t.tree.frozen();
            copies.push(c0.elapsed().as_micros());
            to_job
                .send((
                    base,
                    t.doors.header.clone(),
                    t.versions.clone(),
                    t.basis(),
                    part,
                ))
                .unwrap();
            sent += 1;
            busy = true;
        }
        let due = start + std::time::Duration::from_micros(TICK as u64 * u64::from(n));
        if let Some(wait) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
    }
    drop(to_job);
    worker.join().unwrap();
    let over = ticks.iter().filter(|&&us| us >= 50_000).count();
    let ms = |v: &mut Vec<u128>| {
        format!(
            "{{\"p50\": {:.2}, \"p99\": {:.2}, \"max\": {:.2}}}",
            pct(v, 50),
            pct(v, 99),
            pct(v, 100)
        )
    };
    let health = format!(
        "{{\"world\": \"Eden (N1's exported facts)\", \"walkers\": {walkers}, \"edits\": 50, \"set_downs\": 50, \"installed\": {}, \"built_whole\": {whole}, \"ticks\": {}, \"tick_period_ms\": 50, \"tick_ms\": {}, \"ticks_over_50_ms\": {over}, \"install_ms\": {}, \"rebuild_off_clock_ms\": {}, \"tree_copy_between_ticks_ms\": {}}}",
        installs.len(),
        ticks.len(),
        ms(&mut ticks),
        ms(&mut installs),
        ms(&mut rebuilds),
        ms(&mut copies)
    );
    println!("A4 health: {health}");
    let out = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/g3b-health.json"
    );
    std::fs::write(out, &health).unwrap();
    if quiet {
        return;
    }
    assert_eq!(installs.len(), things.len(), "A4: every change installed");
    if !cfg!(debug_assertions) {
        assert_eq!(over, 0, "A4: no tick takes 50 ms or more");
    }
}
