//! N19's checks (#3341): a seated part is solid to walkers. On B19's yard and site, the seating keeps a town (N5)
//! whose ground each guarded write rebuilds (G3's `Town::rebuild` and `Town::install`, asked for by
//! `Seating::rebuild`): two frames and two beams are seated and taken out again, and while the bay stands 100 walks
//! cross the site through N7's walk skill. `cargo test -p sim n19 -- --nocapture` prints each number.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use replica::effects::{Change, Part, Refusal};
use replica::encode::Value;
use replica::ids::{Id, Minter, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{Audience, Kind};

use super::{
    AREA, BEAM_HANDS, FRAME_HANDS, REACH, SITE, W, WALKER, add, beam_at, effect, family, int, n,
    named, part, pose, v, world,
};
use crate::ground::scene::{F_OUTLINE, Scene, Solid, within};
use crate::ground::{BODY_HIGH, BODY_LOW, HUMAN_RADIUS};
use crate::host::Runner;
use crate::links::Doors;
use crate::walk::World;
use crate::walk::town::Town;

/// The town kept with the seating, and each rebuild's touched ground and time (µs).
struct Kept {
    town: Town,
    rebuilds: Vec<(BTreeSet<Id>, u128)>,
}

/// The seating of `w` keeping a town: each write rebuilds the ground it touches and installs it before the next tick.
#[allow(clippy::disallowed_methods)] // Times the rebuilds (A1): the wall-clock rule (K7) binds the engine, not tests.
fn keep_town(w: &mut W) -> Rc<RefCell<Kept>> {
    let ground = w.ground;
    let doors = Doors::new(w.header.clone(), w.seating.rules.clone(), w.tree.next());
    let town = Town::new(w.tree.frozen(), ground, doors).expect("the town");
    let kept = Rc::new(RefCell::new(Kept {
        town,
        rebuilds: Vec::new(),
    }));
    let k = Rc::clone(&kept);
    let header = w.header.clone();
    w.seating.rebuild = Some(Box::new(move |before: Tree, p: &Part| {
        let mut k = k.borrow_mut();
        let t0 = std::time::Instant::now();
        let (versions, basis) = (k.town.versions.clone(), k.town.basis());
        let r = Town::rebuild(before.frozen(), &header, ground, &versions, &basis, p).map_err(
            |detail| Refusal {
                name: "rebuild",
                detail,
            },
        )?;
        let touched = r.touched.clone();
        k.town.tree = before;
        k.town.doors.next = k.town.tree.next();
        k.town.install(r, p)?;
        let us = t0.elapsed().as_micros();
        k.rebuilds.push((touched, us));
        Ok(())
    }));
    kept
}

/// Whether a body may stand at `p` (µm on the ground's plan) on the town's ground as installed.
fn walkable(k: &Kept, p: Vec3) -> bool {
    let f = Frame {
        node: k.town.ground,
        slot: None,
    };
    let who = Id::new(Scope([0x91; 16]), 1).expect("an id");
    k.town.surfaces[&k.town.ground]
        .place(who, f, v(p.x, 0, p.z), Quat::IDENTITY)
        .is_ok()
}

/// The site as a named place on the open ground, 20 m square about the bay: N1's area, whose outline widens the open
/// ground's extent (`Scene::areas`), so walkers have ground on either side of the bay.
fn site_area(w: &mut W) {
    w.seating.rules.kinds.insert(
        AREA.into(),
        Kind {
            owner: "thing".into(),
            children: BTreeSet::new(),
            slots: BTreeMap::new(),
            hands: None,
        },
    );
    let (cx, cz, h) = (SITE.x / 1000, SITE.z / 1000, 10_000);
    let ring = [(-h, -h), (h, -h), (h, h), (-h, h)]
        .iter()
        .map(|(x, z)| Value::Array(vec![int(cx + x), int(cz + z)]))
        .collect();
    let node = w.mint.mint().expect("an id");
    let cs = vec![Change::Create {
        node,
        kind: n(AREA),
        pose: pose(w.ground, None, Vec3::ZERO),
        audience: Audience::Everyone,
        fields: BTreeMap::from([(F_OUTLINE, Value::Array(ring))]),
    }];
    let p = part(&w.header, &[effect(w.tree.next(), w.ground, cs)]);
    w.tree
        .commit(&w.header, &p, &w.seating.rules)
        .expect("the site's area");
}

/// The distance between two points on the plan, µm.
fn apart(a: [i64; 2], b: [i64; 2]) -> i64 {
    (i128::from(a[0] - b[0]).pow(2) + i128::from(a[1] - b[1]).pow(2)).isqrt() as i64
}

/// The walkers' tick and pace, and the site's crossing: 100 walks in ten rounds of ten lanes 600 mm apart, from 7 m
/// on one side of the bay to 7 m on the other, each round the other way and its lanes shifted 50 mm.
const WALK_TICK: Micros = 50_000;
const WALK_SPEED: i64 = 1_400_000;
const CROSS: i64 = 7_000_000;
const LANE: i64 = 600_000;

/// What A1 checks after a seat or a removal: the rebuild at index `at` touched the open ground under the bay, and the
/// part's middle `centre` is no ground (seated) or ground again (taken out). The rebuild's time is printed; its bar
/// (under a second) is real time, asserted only in the speed-bar step (ci.sh, V2_SPEED_BARS=1, release).
fn rebuilt(kept: &Rc<RefCell<Kept>>, what: &str, at: usize, centre: Vec3, seated: bool) -> u128 {
    let k = kept.borrow();
    let (touched, us) = &k.rebuilds[at];
    assert!(
        touched.contains(&k.town.ground),
        "{what}: the ground under the bay is touched"
    );
    if std::env::var_os("V2_SPEED_BARS").is_some() {
        assert!(*us < 1_000_000, "{what}: rebuilt in {us} µs");
    }
    assert_eq!(walkable(&k, centre), !seated, "{what}: the part's middle");
    println!(
        "A1: {what}: ground rebuilt and installed in {us} µs ({} node touched); the part's middle at ({}, {}) mm {}",
        touched.len(),
        centre.x / 1000,
        centre.z / 1000,
        if seated {
            "is no ground"
        } else {
            "is ground again"
        }
    );
    *us
}

/// A2: 100 walks across the site through N7's walk skill on the town's ground; each tick, every body's centre is
/// checked against every seated part's boxes (their true size, the body's radius). Returns (overlaps, samples,
/// arrived, lanes the bay stands across, nearest any centre came to a box, µm). A lane the bay stands across is one
/// whose straight line passes within the body's radius of a part: its walker arrives only by going round.
fn walks(kept: &Rc<RefCell<Kept>>) -> (u64, u64, u64, u64, i64) {
    let mut k = kept.borrow_mut();
    let ground = k.town.ground;
    let scene = Scene::of(&k.town.tree, ground).expect("the open ground");
    let parts: Vec<Solid> = scene
        .solids
        .into_iter()
        .filter(|s| s.y1 > BODY_LOW * 1000 && s.y0 < BODY_HIGH * 1000)
        .filter(|s| s.ring.iter().all(|p| (p[0] - SITE.x).abs() < 3_000_000))
        .collect();
    assert_eq!(parts.len(), 4, "two frames and two beams seated");
    let zs = parts.iter().flat_map(|s| s.ring.iter().map(|p| p[1]));
    let (zlo, zhi) = zs.fold((i64::MAX, i64::MIN), |(a, b), z| (a.min(z), b.max(z)));
    let r_um = HUMAN_RADIUS * 1000;
    let mut ids = Minter::new(Scope([0x92; 16]));
    let (mut overlaps, mut samples, mut arrived, mut round_the_bay) = (0u64, 0u64, 0u64, 0u64);
    let mut nearest = i64::MAX;
    for round in 0..10i64 {
        let mut r = Runner::new(WALK_TICK);
        let dir = if round % 2 == 0 { 1 } else { -1 };
        let mut goals = BTreeMap::new();
        for lane in 0..10i64 {
            let z = SITE.z + (lane - 5) * LANE + LANE / 2 + round * 50_000;
            let (from, to) = (v(SITE.x - dir * CROSS, 0, z), v(SITE.x + dir * CROSS, 0, z));
            let who = ids.mint().expect("an id");
            let f = Frame {
                node: ground,
                slot: None,
            };
            let body = k.town.surfaces[&ground]
                .place(who, f, from, Quat::IDENTITY)
                .expect("standing room");
            let legs = k.town.plan(&body, ground, to).expect("a plan");
            if zlo - r_um < z && z < zhi + r_um {
                round_the_bay += 1;
            }
            let legs = legs
                .iter()
                .map(|l| skills::route::Leg {
                    to: l.to,
                    link: l.link,
                })
                .collect();
            let skill = skills::route::Route::new(legs, WALK_SPEED, WALK_TICK);
            r.add(family(), body, Box::new(skill)).expect("walking");
            goals.insert(who, to);
        }
        let mut tick = 0;
        while !r.runs.is_empty() {
            tick += 1;
            assert!(tick < 1_200, "round {round} ends within 60 s");
            k.town.doors.next = k.town.tree.next();
            r.tick(&mut k.town)
                .unwrap_or_else(|e| panic!("tick {tick}: {}: {}", e.name, e.detail));
            for b in r.controller.bodies() {
                let p = [b.pose.position.x, b.pose.position.z];
                samples += 1;
                for s in &parts {
                    if within(&s.ring, p, HUMAN_RADIUS * 1000) {
                        overlaps += 1;
                    }
                    let mut d = 0;
                    while d < 3_000_000 && !within(&s.ring, p, d) {
                        d += 10_000;
                    }
                    nearest = nearest.min(d);
                }
            }
        }
        for (who, to) in &goals {
            let p = r.controller.body(*who).expect("a walker").pose.position;
            if apart([p.x, p.z], [to.x, to.z]) < 300_000 {
                arrived += 1;
            }
        }
    }
    (overlaps, samples, arrived, round_the_bay, nearest)
}

#[test]
fn n19_a1_a2_the_ground_follows_each_seat_and_removal_and_no_walker_overlaps_a_seated_part() {
    let mut w = world();
    site_area(&mut w);
    let kept = keep_town(&mut w);
    let ground = w.ground;
    let (fa, fb) = (w.frames[0], w.frames[1]);
    let (b1, b2) = (w.beams[0], w.beams[1]);
    let frame_across = v(FRAME_HANDS, 0, 0);
    let beam_across = v(0, 0, BEAM_HANDS);
    let last = |k: &Rc<RefCell<Kept>>| k.borrow().rebuilds.len() - 1;
    // A1: each seat (its put) rebuilds the ground under the bay; the part's middle is no ground.
    let mut times = Vec::new();
    for (f, slot, ks) in [(fa, "upright_a", [0, 1]), (fb, "upright_b", [2, 3])] {
        let act = w.crew(ground, &ks);
        let from = w.place_of(f);
        let target = w.in_bay(slot, vec![], true);
        w.move_part(act, ks, f, from, frame_across, Quat::IDENTITY, &target)
            .expect("seated");
        let what = format!("frame seated in {slot}");
        times.push(rebuilt(&kept, &what, last(&kept), target.at, true));
    }
    let holds: Vec<Id> = [fa, fb]
        .iter()
        .map(|f| {
            let h = w.tree.handle(*f).expect("live");
            w.tree.children(h).expect("live")[0]
        })
        .map(|h| w.tree.node(h).expect("a node").id())
        .collect();
    for (beam, slot) in [(b1, "beam_low_l"), (b2, "beam_low_r")] {
        let act = w.crew(ground, &[4, 5]);
        let from = w.place_of(beam);
        let target = w.in_bay(slot, vec![fa, fb], false);
        w.move_part(
            act,
            [4, 5],
            beam,
            from,
            beam_across,
            W::beam_inside(),
            &target,
        )
        .expect("seated");
        let what = format!("beam seated in {slot}");
        times.push(rebuilt(&kept, &what, last(&kept), target.at, true));
        w.leave(act, 4).expect("go");
        w.leave(act, 5).expect("go");
    }
    w.leave(holds[0], 1).expect("frame A stands");
    w.leave(holds[0], 0).expect("frame A stands");
    w.leave(holds[1], 2).expect("frame B stands");
    w.leave(holds[1], 3).expect("frame B stands");

    // A2: while the bay stands.
    let (overlaps, samples, arrived, round_the_bay, nearest) = walks(&kept);
    println!(
        "A2: 100 walks across the site while the bay stands: {arrived} arrived, {round_the_bay} on lanes the bay stands across; {samples} body samples, {overlaps} overlapping a seated part (body radius {HUMAN_RADIUS} mm); nearest a centre came to a part: {} mm",
        nearest / 1000
    );
    assert_eq!(overlaps, 0, "no body overlaps a seated part");
    assert_eq!(arrived, 100, "every walk arrives");
    assert!(round_the_bay > 0, "the bay stands across some lanes");

    // A1, the removals (each its take): the beams out to the yard, then each frame held again and taken to the stand.
    let ha = w.crew(fa, &[0, 1]);
    let hb = w.crew(fb, &[2, 3]);
    for (k, (beam, slot)) in [(b2, "beam_low_r"), (b1, "beam_low_l")]
        .into_iter()
        .enumerate()
    {
        let act = w.crew(ground, &[4, 5]);
        let from = w.place_of(beam);
        let taken = kept.borrow().rebuilds.len();
        let home = w.onto_ground(beam_at(1 - k));
        w.move_part(
            act,
            [4, 5],
            beam,
            from,
            beam_across,
            W::beam_inside(),
            &home,
        )
        .expect("taken out");
        let what = format!("beam taken out of {slot}");
        times.push(rebuilt(&kept, &what, taken, from, false));
        w.leave(act, 4).expect("go");
        w.leave(act, 5).expect("go");
    }
    for (f, act, slot, ks) in [(fa, ha, "frame_1", [0, 1]), (fb, hb, "frame_2", [2, 3])] {
        let from = w.place_of(f);
        let taken = kept.borrow().rebuilds.len();
        let target = w.onto_stand(slot);
        w.move_part(act, ks, f, from, frame_across, Quat::IDENTITY, &target)
            .expect("taken out");
        let what = format!("frame taken out of the bay to the stand's {slot}");
        times.push(rebuilt(&kept, &what, taken, from, false));
        w.leave(act, ks[0]).expect("go");
        w.leave(act, ks[1]).expect("go");
    }
    println!(
        "A1: {} parts seated or taken out, slowest rebuild and install {} µs (bar 1,000,000); {} rebuilds in all",
        times.len(),
        times.iter().max().copied().unwrap_or(0),
        kept.borrow().rebuilds.len()
    );
    assert_eq!(times.len(), 8);
}

#[test]
fn n19_a3_seating_a_part_where_a_body_stands_is_refused_before_the_lift() {
    for (off, refused) in [(0, true), (1_000_000, false)] {
        let mut w = world();
        let ground = w.ground;
        let (_, slot) = w.bay_slots["upright_a"];
        let at = add(SITE, v(slot.x, 0, slot.z + off));
        let who = w.mint.mint().expect("an id");
        let cs = vec![Change::Create {
            node: who,
            kind: n(WALKER),
            pose: pose(ground, None, at),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        }];
        let p = part(&w.header, &[effect(w.tree.next(), ground, cs)]);
        w.tree
            .commit(&w.header, &p, &w.seating.rules)
            .expect("a body on the site");
        let act = w.crew(ground, &[0, 1]);
        let target = w.in_bay("upright_a", vec![], true);
        let before = (w.tree.to_state(), w.seating.parts.len());
        let mut m = w.mint.clone();
        let frame = w.frames[0];
        let r = named(
            w.seating
                .check(&w.tree, &w.acts, &mut m, act, frame, &target, REACH),
        );
        assert_eq!(
            (w.tree.to_state(), w.seating.parts.len()),
            before,
            "nothing moved"
        );
        if refused {
            let e = r.expect_err("refused");
            println!(
                "A3: frame A into upright_a with a body standing in the slot at ({}, {}) mm: {}: {}",
                at.x / 1000,
                at.z / 1000,
                e.0,
                e.1
            );
            assert_eq!(e.0, "site.occupied");
        } else {
            r.expect("a body 1 m off the frame refuses nothing");
            println!(
                "A3: the same body 1 m off the frame, at ({}, {}) mm: nothing refuses",
                at.x / 1000,
                at.z / 1000
            );
        }
    }
}
