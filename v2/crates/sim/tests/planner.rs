//! The world's planner off the clock (Engine v2 K18b, #3175) on N2's test world: walkers sent through the host with
//! the planner on a thread of its own, the runner on a thread marked as the clock (a route search there panics in a
//! debug build).
//!
//! `cargo test -p sim --release --test planner -- --nocapture`; the timing run is
//! `cargo test -p sim --release --test planner -- --ignored --nocapture`.

mod common;

use common::{arrived, id, send, stand};
use replica::pose::Vec3;
use sim::host::{Batches, Planned, Runner};
use sim::planner::{Planner, Thread};
use sim::spots::Target;
use sim::walk::town::Town;

const SPEED: i64 = 1_400_000; // µm a second: today's walking pace
const TICK: i64 = 50_000; // µs: 20 ticks a second

fn town() -> Town {
    common::town(b"souls/planner-test/1").0
}

/// Walker `k` of `n`: it starts west of the square and is sent to its own point on the ring's walkway, east of the
/// ring's solid middle for most (their straight way crosses it).
fn walker(t: &Town, k: u64, n: u64) -> (sim::mover::Body, Vec3) {
    let ground = t.ground;
    let (col, row) = ((k % 20) as i64, (k / 20) as i64);
    let at = Vec3::new(
        -26_000_000 + col * 1_200_000,
        0,
        -26_000_000 + row * 1_200_000,
    );
    let a = std::f64::consts::TAU * k as f64 / n as f64;
    let to = Vec3::new(
        75_000_000 + (13_000_000.0 * a.cos()) as i64,
        0,
        (13_000_000.0 * a.sin()) as i64,
    );
    (stand(t, id(k + 1), ground, at), to)
}

fn runner(t: &Town, n: u64) -> Runner {
    let mut r = Runner::new(TICK);
    for k in 0..n {
        let (b, to) = walker(t, k, n);
        send(&mut r, b, SPEED, Target::new(t.ground, to), id(10_000 + k)).unwrap();
    }
    r
}

/// What a run with the planner left: world time at its end (µs), the walkers that arrived, the route searches the
/// planner ran, and the clock's own time per tick (µs; without the wait for the planner).
struct Run {
    now: i64,
    arrived: usize,
    searched: u64,
    times: Vec<u64>,
}

/// `n` walkers ticked with a planner thread, `ticks` times or until every walk ended, on a thread marked as the
/// clock (skills stay on the thread that steps them).
fn planned(n: u64, ticks: usize) -> Run {
    std::thread::spawn(move || {
        sim::commit::mark_clock_thread();
        let mut t = town();
        let mut r = runner(&t, n);
        let mut p = Thread::spawn(Planner::new(t.copy().unwrap())).unwrap();
        let mut answers = Planned::default();
        let mut times = Vec::new();
        for _ in 0..ticks {
            if r.runs.is_empty() {
                break;
            }
            #[allow(clippy::disallowed_methods)] // a test timing its own ticks
            let t0 = std::time::Instant::now();
            let (wants, _) = r.tick_planned(&mut t, &answers);
            p.send(wants);
            #[allow(clippy::disallowed_methods)]
            times.push(t0.elapsed().as_micros() as u64);
            answers = p.take(None);
        }
        Run {
            now: r.now,
            arrived: (0..n).filter(|&k| arrived(&r, id(k + 1)).is_some()).count(),
            searched: p.searched,
            times,
        }
    })
    .join()
    .expect("the clock thread ran no route search")
}

fn pct(v: &mut [u64], q: usize) -> u64 {
    v.sort_unstable();
    v.get((v.len() * q / 100).min(v.len().saturating_sub(1)))
        .copied()
        .unwrap_or(0)
}

/// A1, A2: twenty walkers, most round the ring's middle, arrive with every search on the planner's thread.
#[test]
fn a1_a2_walkers_round_the_ring_arrive_with_no_search_on_the_clock() {
    let run = planned(20, 4_000);
    println!(
        "K18b: {} of 20 arrived by {} s, {} searches on the planner",
        run.arrived,
        run.now / 1_000_000,
        run.searched
    );
    assert_eq!(run.arrived, 20, "every walk arrives");
    assert!(run.searched > 20, "the planner searched");
}

/// The clock's tick with and without the planner: `n` walkers, 30 s of world time, back to back.
#[test]
#[ignore = "a timing run: release build, quiet machine"]
fn timing_the_clock_tick_with_and_without_the_planner() {
    let n = 500;
    let ticks = 600;
    let mut t = town();
    let mut r = runner(&t, n);
    let mut on = Vec::new();
    for _ in 0..ticks {
        #[allow(clippy::disallowed_methods)] // a test timing its own ticks
        let t0 = std::time::Instant::now();
        let _ = r.tick(&mut t);
        #[allow(clippy::disallowed_methods)]
        on.push(t0.elapsed().as_micros() as u64);
    }
    let Run {
        searched,
        times: mut off,
        ..
    } = planned(n, ticks);
    println!(
        "K18b timing, {n} walkers, {ticks} ticks: searches on the clock: tick median {} us, p99 {} us; with the \
         planner: tick median {} us, p99 {} us ({searched} searches on the planner)",
        pct(&mut on, 50),
        pct(&mut on, 99),
        pct(&mut off, 50),
        pct(&mut off, 99),
    );
}

#[test]
fn reach_answers_keep_exact_slot_and_order_identity_off_clock() {
    use sim::host::{ReachQuestion, Wants};
    let mut planner = Thread::spawn(Planner::new(town())).unwrap();
    sim::commit::mark_clock_thread();
    let (body, thing, old, current) = (id(50_001), id(50_002), id(50_003), id(50_004));
    let q = |slot, order, x| ReachQuestion {
        body,
        thing,
        slot,
        order,
        at: Vec3::ZERO,
        points: [Vec3::new(x, 0, 0); 2],
    };
    planner.send(Wants {
        reach: vec![
            q(1, old, 0),
            q(1, current, 3_000_000),
            q(2, current, 5_000_000),
        ],
        ..Wants::default()
    });
    let got = planner.take(None);
    assert_eq!(
        got.reach.len(),
        3,
        "neither a different slot nor a replacement order overwrites another answer"
    );
    assert_eq!(got.reach[&(body, thing, 1, old)], [0, 0]);
    assert_eq!(got.reach[&(body, thing, 1, current)], [3_000_000; 2]);
    assert_eq!(got.reach[&(body, thing, 2, current)], [5_000_000; 2]);
}

/// C29: the route result carries its own length/link count to the exact active order. A late answer from a
/// replaced walk must not provide the replacement's deadline; ending the current order clears its metrics.
#[test]
fn route_metrics_belong_only_to_the_current_order_and_clear_on_end() {
    let mut t = town();
    let mut r = runner(&t, 1);
    let who = id(1);
    let order = id(10_000);
    let mut planner = Planner::new(t.copy().unwrap());
    let (wants, _) = r.tick_planned(&mut t, &Planned::default());
    let old = planner.answer(&wants);
    let (_, Ok((_, _, expected))) = old.places.get(&who).expect("the planned place") else {
        panic!("a route was planned")
    };
    assert!(expected.length_mm > 0);
    assert!(r.route_metrics(who, order).is_none());
    r.tick_planned(&mut t, &old).1.unwrap();
    assert_eq!(r.route_metrics(who, order), Some(*expected));
    assert!(r.route_metrics(who, id(99_999)).is_none());

    let next = id(20_000);
    r.send(
        who,
        Box::new(skills::route::Route::sent(SPEED, TICK)),
        Target::new(t.ground, Vec3::new(88_000_000, 0, 0)),
        next,
    )
    .unwrap();
    assert!(r.route_metrics(who, order).is_none());
    let (wants, _) = r.tick_planned(&mut t, &old);
    assert!(
        r.route_metrics(who, next).is_none(),
        "the old order's late plan is ignored"
    );
    let fresh = planner.answer(&wants);
    r.tick_planned(&mut t, &fresh).1.unwrap();
    assert!(r.route_metrics(who, next).is_some());
    r.end_order(who);
    assert!(r.route_metrics(who, next).is_none());
}

/// K18d: one FIFO worker installs committed connectivity before later questions. Map controls are not batches;
/// historical answers remain historical, and a merged current batch cannot relabel any old answer cache.
#[test]
fn k18d_committed_connectivity_and_mixed_batches_keep_exact_map_identity() {
    use replica::effects::{
        Actor, Body as EffectBody, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest,
    };
    use replica::encode::{Value, encode};
    use replica::world_model::Audience;
    use sim::host::{ReachQuestion, Wants};
    use sim::planner::{FormKey, FormKind, FormQuery, FormQuestion};
    use sim::walk::Mark;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    let (mut town, nodes) = common::town(b"souls/k18d-map-test/1");
    let ground = town.ground;
    let (floor, at, _) = town
        .view()
        .on_floor(nodes["building/corridor"], Vec3::ZERO)
        .expect("the corridor has a supporting floor");
    let target = Target::new(floor, at);
    let body = stand(
        &town,
        id(60_001),
        ground,
        Vec3::new(-40_000_000, 0, 30_000_000),
    );
    let order = id(60_002);
    let old_map = Arc::new(town.versions.clone());
    let key = FormKey {
        body: body.id,
        intent: order,
        stage: 0,
        step: 0,
        kind: FormKind::Walk,
    };
    let old = Wants {
        marks: Some(vec![Mark {
            who: body.id,
            node: ground,
            at: body.pose.position,
            waiting: None,
            crossing: None,
            staying: false,
            spot: Some((target, order)),
        }]),
        places: vec![(body, target, order)],
        lines: vec![(body, Vec3::new(-35_000_000, 0, 30_000_000))],
        reach: vec![ReachQuestion {
            body: body.id,
            at: body.pose.position,
            thing: id(60_003),
            slot: 1,
            order,
            points: [body.pose.position; 2],
        }],
        form_map: Some(Arc::clone(&old_map)),
        forms: vec![FormQuestion {
            key,
            generation: 1,
            body,
            query: FormQuery::Walk {
                node: target.node,
                at: target.point(),
                reach: 0,
                door: None,
                ring: None,
            },
        }],
        ..Default::default()
    };
    let mut worker = Thread::spawn(Planner::new(town.copy().unwrap())).unwrap();
    worker.send(old.clone());
    let before = worker.take_n(1);
    assert!(
        before.places[&body.id].1.is_ok(),
        "the original stair connection is reachable"
    );
    assert_eq!(
        (before.lines.len(), before.reach.len(), before.forms.len()),
        (1, 1, 1)
    );

    let effects: Vec<Effect> = [nodes["building/floor-0"], nodes["building/floor-1"]]
        .into_iter()
        .enumerate()
        .map(|(k, node)| Effect {
            envelope: Envelope {
                sequence: town.doors.next + k as u64,
                at: 0,
                cause: Cause::Intent(id(60_004)),
                actor: Actor::Creator(id(60_005)),
                audience: Audience::Everyone,
                node,
            },
            body: EffectBody::Changes(vec![ChangeRec {
                change: Change::Set {
                    node,
                    field: import_eden::F_STAIRS,
                    to: Value::Array(Vec::new()),
                    by: None,
                },
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        })
        .collect();
    let part = Arc::new(
        Part::read(
            &encode(&Value::Map(BTreeMap::from([
                (1, Value::Bytes(town.doors.header.hash().to_bytes())),
                (
                    2,
                    Value::Array(effects.iter().map(Effect::to_value).collect()),
                ),
            ])))
            .unwrap(),
        )
        .unwrap(),
    );
    let rebuild = || {
        Town::rebuild(
            town.tree.frozen(),
            &town.doors.header,
            ground,
            &town.versions,
            &town.basis(),
            &part,
        )
        .unwrap()
    };
    let live = rebuild();
    let remote = rebuild();
    let refused_map = rebuild();
    let invalid_map = rebuild();
    let current = Arc::new(live.versions.clone());
    assert_ne!(*current, *old_map);
    worker.send(old.clone());
    // A door can open after preparation. The staged tree transaction must preserve that independent state.
    let door = nodes["door-building-narrow"];
    let link = replica::effects::read_id(
        &town
            .tree
            .node(town.tree.handle(door).unwrap())
            .unwrap()
            .fields()[&sim::ground::scene::F_OPEN_DOOR_LINK],
    )
    .unwrap();
    town.doors
        .ask(door, link, Cause::Intent(order), Actor::Soul(body.id));
    town.doors.flush(&mut town.tree, 0).unwrap();
    let before_tree = town.tree.to_state();
    let before_versions = town.versions.clone();
    let mut invalid = (*part).clone();
    let EffectBody::Changes(changes) = &mut invalid.effects[0].body else {
        unreachable!()
    };
    changes[0].change = Change::Set {
        node: id(999_999),
        field: 99,
        to: Value::Uint(1),
        by: None,
    };
    let invalid = Part::read(&encode(&invalid.to_value()).unwrap()).unwrap();
    let called = std::cell::Cell::new(false);
    sim::commit::mark_clock_thread();
    assert!(
        town.install_then(invalid_map, &invalid, || {
            called.set(true);
            Ok(())
        })
        .is_err()
    );
    assert!(
        !called.get(),
        "an invalid town part refuses before the live write"
    );
    assert_eq!(town.tree.to_state(), before_tree);
    assert_eq!(town.versions, before_versions);
    let refused = town
        .install_then(refused_map, &part, || {
            Err::<(), _>(replica::effects::Refusal {
                name: "edit.stale",
                detail: "injected live refusal".into(),
            })
        })
        .unwrap_err();
    assert_eq!(refused.name, "edit.stale");
    assert_eq!(
        town.tree.to_state(),
        before_tree,
        "a refused live write rolls back the town tree"
    );
    assert_eq!(town.versions, before_versions);
    assert_eq!(
        worker.pending(),
        1,
        "neither refusal installs the worker map"
    );
    town.install(live, &part).unwrap();
    assert_eq!(
        town.tree
            .node(town.tree.handle(door).unwrap())
            .unwrap()
            .fields()[&sim::links::F_OPEN],
        Value::Uint(1),
        "a door opened after preparation remains open"
    );
    worker.install(Arc::clone(&old_map), remote, Arc::clone(&part));
    assert_eq!(
        worker.pending(),
        1,
        "a map control creates no recorded Planned batch"
    );
    let mut historical = worker.take_n(1);
    assert!(historical.places[&body.id].1.is_ok());
    historical.keep_map(&current);
    assert!(
        historical.places.is_empty()
            && historical.lines.is_empty()
            && historical.reach.is_empty()
            && historical.forms.is_empty()
    );

    // The body found again on the ground as installed, as a tick's reground finds it (`Host::reground`): the stair
    // removal cuts the open ground's squares again (S13), so the pieces it stood on are numbered anew.
    let here = town.relocate(&body).unwrap();
    let mut fresh = old.clone();
    fresh.places[0].0 = here;
    fresh.lines[0].0 = here;
    fresh.forms[0].body = here;
    fresh.form_map = Some(Arc::clone(&current));
    fresh.forms[0].generation = 2;
    worker.send(fresh.clone());
    let now = worker.take_n(1);
    assert_eq!(now.places[&body.id].1.as_ref().unwrap_err(), &"no-route");
    assert!(Arc::ptr_eq(now.map.as_ref().unwrap(), &current));
    assert_eq!(now.forms[&key].generation, 2);
    assert!(
        matches!(&now.forms[&key].result, sim::planner::FormResult::Walk(Ok(legs)) if legs.is_empty())
    );
    assert_eq!(worker.pending(), 0);

    // A historical batch already queued before a map change may be taken together with a current batch.
    let mut combined = before;
    let mut current_route_only = now;
    current_route_only.lines.clear();
    current_route_only.reach.clear();
    current_route_only.forms.clear();
    combined.merge(current_route_only);
    assert!(Arc::ptr_eq(combined.map.as_ref().unwrap(), &current));
    assert!(
        combined.lines.is_empty() && combined.reach.is_empty() && combined.forms.is_empty(),
        "old caches were discarded before adopting the new map stamp"
    );
    assert_eq!(
        combined.places[&body.id].1.as_ref().unwrap_err(),
        &"no-route"
    );
    let mut legacy = Planned::default();
    legacy
        .reach
        .insert((body.id, id(60_003), 1, order), [999; 2]);
    combined.merge(legacy);
    assert!(
        combined.reach.is_empty(),
        "an unstamped answer cannot inherit the current map identity"
    );
    println!(
        "K18d: committed stair removal => no-route; all four stale caches discarded; map controls add zero batches"
    );
}

/// A planner's batches as a tick reads them (S8): `taken` taken so far, this tick's going in batch `next`.
fn stamped(mut p: Planned, taken: u64, next: u64) -> Planned {
    p.batches = Some(Batches { taken, next });
    p
}

/// S8: a walk whose place request is still out is not asked again each tick; once the batch it went in has been
/// taken without its answer (a dropped or panicked batch), it is asked again. Without the batches' count, every
/// tick asks, as before.
#[test]
fn s8_a_walk_is_asked_for_its_place_once_while_the_request_is_out() {
    let mut t = town();
    let mut r = runner(&t, 1);
    let asked = |r: &mut Runner, t: &mut Town, p: &Planned| r.tick_planned(t, p).0.places.len();
    assert_eq!(
        asked(&mut r, &mut t, &stamped(Planned::default(), 0, 0)),
        1,
        "asked once"
    );
    for next in 1..5 {
        assert_eq!(
            asked(&mut r, &mut t, &stamped(Planned::default(), 0, next)),
            0,
            "still out: not asked again"
        );
    }
    // Batch 0 taken with no answer for it: asked again, in batch 5, and not again while that one is out.
    assert_eq!(
        asked(&mut r, &mut t, &stamped(Planned::default(), 1, 5)),
        1,
        "asked again"
    );
    assert_eq!(asked(&mut r, &mut t, &stamped(Planned::default(), 5, 6)), 0);
    // Answered: granted, nothing more to ask.
    let mut planner = Planner::new(t.copy().unwrap());
    let (wants, _) = r.tick_planned(&mut t, &stamped(Planned::default(), 6, 7));
    assert_eq!(wants.places.len(), 1);
    let answer = planner.answer(&wants);
    assert_eq!(asked(&mut r, &mut t, &stamped(answer, 8, 8)), 0);
    assert!(r.granted.contains_key(&id(1)), "the place was granted");
    // Without the count: every tick asks.
    let mut r = runner(&t, 1);
    for _ in 0..3 {
        assert_eq!(asked(&mut r, &mut t, &Planned::default()), 1);
    }
}

/// S8: a walker's new line is asked once while the request is out, again once its batch was taken without it, and
/// the walker arrives on the line when it comes.
#[test]
fn s8_a_walkers_line_is_asked_once_while_the_request_is_out() {
    let mut t = town();
    let mut r = runner(&t, 1);
    let mut planner = Planner::new(t.copy().unwrap());
    let (wants, _) = r.tick_planned(&mut t, &stamped(Planned::default(), 0, 0));
    let mut answer = stamped(planner.answer(&wants), 1, 1);
    // Ticks until the walker asks a line, with every batch answered.
    let mut first = None;
    for tick in 1..400u64 {
        let (wants, _) = r.tick_planned(&mut t, &answer);
        if !wants.lines.is_empty() {
            first = Some(tick);
            break;
        }
        answer = stamped(planner.answer(&wants), tick + 1, tick + 1);
    }
    let first = first.expect("the walker asked for a line (its straight way crosses the ring)");
    // Its batch (`first`) not taken: no new request, however many ticks.
    let (taken, mut next) = (first, first + 1);
    for _ in 0..5 {
        let (wants, _) = r.tick_planned(&mut t, &stamped(Planned::default(), taken, next));
        assert!(wants.lines.is_empty(), "still out: not asked again");
        next += 1;
    }
    // Taken without its answer: asked again; then answered, and the walk goes on to arrive.
    let (wants, _) = r.tick_planned(&mut t, &stamped(Planned::default(), first + 1, next));
    assert_eq!(wants.lines.len(), 1, "asked again");
    let mut answer = stamped(planner.answer(&wants), next + 1, next + 1);
    for k in next + 1..next + 4_000 {
        if r.runs.is_empty() {
            break;
        }
        let (wants, _) = r.tick_planned(&mut t, &answer);
        answer = stamped(planner.answer(&wants), k + 1, k + 1);
    }
    assert!(arrived(&r, id(1)).is_some(), "the walker arrived");
}
