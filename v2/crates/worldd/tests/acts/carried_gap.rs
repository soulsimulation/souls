//! E16 (#2787): a load carried across the only way out is never walked through, on a served world. Two Souls carry the
//! plank and stand still with it; a third, ringed in by Souls staying by their own orders, has the plank across its
//! ring's one gap. The shoulder turn squeezes past still bodies only, never a load: the walker leaves its ring between
//! two of the bodies standing, or its walk ends `goal-unreachable` naming its next step; either way it never comes
//! nearer the plank than a body's radius past the plank's edge, and the plank stays carried where it was.
use super::*;

/// The third walker, ringed in.
fn w3() -> Id {
    id(70)
}

/// Where the plank lies once carried: between the carriers, along x at their z (`a4_…` sets it down there).
fn plank_mid() -> Vec3 {
    Vec3::new((at1().x + at2().x) / 2, 0, at1().z)
}

/// The ring's centre: 0.9 m south of the carried plank.
fn centre() -> Vec3 {
    Vec3::new(plank_mid().x, 0, plank_mid().z - 900_000)
}

/// The ring: 0.9 m round the centre at every eighth of a turn but north, where the plank lies across the gap.
fn gap_ring() -> Vec<Vec3> {
    [
        (636_396, 636_396),
        (900_000, 0),
        (636_396, -636_396),
        (0, -900_000),
        (-636_396, -636_396),
        (-900_000, 0),
        (-636_396, 636_396),
    ]
    .into_iter()
    .map(|(dx, dz)| Vec3::new(centre().x + dx, 0, centre().z + dz))
    .collect()
}

/// The fixture's bodies, the third walker at the ring's centre and the ring's bodies staying.
fn ringed_by_a_load() -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let place = |who: Id, at: Vec3| town.surfaces[&ground].place(who, frame, at, Quat::IDENTITY);
    let (p1, p2, p3) = (
        place(w1(), at1())?,
        place(w2(), at2())?,
        place(w3(), centre())?,
    );
    let mut ring = Vec::new();
    for (k, at) in gap_ring().into_iter().enumerate() {
        let who = id(40 + k as u64);
        ring.push((who, place(who, at)?));
    }
    let mut b = Bodies::new(town, 50_000)?;
    for p in [p1, p2, p3] {
        b.add_body(humanoid(), p)?;
    }
    for (who, placed) in ring {
        b.add_body(humanoid(), placed)?;
        b.runner.staying.insert(who);
    }
    Ok(b)
}

/// Soul `soul`'s act `verb` at tick `tick`, run to tick `to` in lockstep: its final answer and refusal detail.
fn act_at(
    run: &Run,
    soul: Id,
    seq: u64,
    (tick, to): (i64, i64),
    verb: &str,
    target: Id,
    params: BTreeMap<u64, Value>,
) -> (Result<Vec<u64>, String>, Option<String>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let bytes = intent_bytes(soul, seq, verb, Some(target), params);
    run.world
        .events
        .send(answers::Event::ArrivalAt {
            tick,
            bytes,
            reply: tx,
        })
        .unwrap();
    let (done, ran) = std::sync::mpsc::channel();
    run.world
        .events
        .send(answers::Event::RunTo { tick: to, done })
        .unwrap();
    ran.recv().unwrap();
    let ends: Vec<_> = rx
        .try_iter()
        .filter(|f| answers::progress_of(f).is_none())
        .collect();
    assert_eq!(ends.len(), 1, "{verb}: one final answer by tick {to}");
    let detail = match decode(&ends[0]).ok().map(|d| d.value) {
        Some(Value::Map(m)) => match m.get(&2) {
            Some(Value::Map(a)) => match a.get(&8) {
                Some(Value::Bytes(b)) => String::from_utf8(b.clone()).ok(),
                _ => None,
            },
            _ => None,
        },
        _ => None,
    };
    (answer_in(&ends[0]).1, detail)
}

/// How near `who` came to the segment from `a` to `b` on the plan, over its motion samples in the log (µm).
fn closest_to(run: &Run, who: Id, a: Vec3, b: Vec3) -> i128 {
    let (ax, az) = (i128::from(b.x - a.x), i128::from(b.z - a.z));
    let l2 = ax * ax + az * az;
    let log = run.store.0.lock().unwrap().bytes.clone();
    let mut closest = i128::MAX;
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            let Body::Changes(cs) = &e.body else { continue };
            for c in cs {
                let Change::Motion(h) = &c.change else {
                    continue;
                };
                if h.node != who {
                    continue;
                }
                let p = h.pose.position;
                let (bx, bz) = (i128::from(p.x - a.x), i128::from(p.z - a.z));
                let t = ((ax * bx + az * bz) * 1_000_000 / l2).clamp(0, 1_000_000);
                let (cx, cz) = (bx - ax * t / 1_000_000, bz - az * t / 1_000_000);
                closest = closest.min((cx * cx + cz * cz).isqrt());
            }
        }
    }
    closest
}

#[test]
fn e16_a_load_carried_across_the_only_way_is_never_walked_through() {
    let mut changes = built();
    changes.push(create(w3(), WALKER, ground(), centre()));
    let run = lockstep_on(world_of(zone_place(), changes), ringed_by_a_load);
    let none = BTreeMap::new;
    let role = |r: &str| p(&[(1, Value::Text(name(r)))]);
    let (proposed, _) = act_at(
        &run,
        w1(),
        1,
        (1, 20),
        "activity:propose",
        ground(),
        p(&[(1, Value::Text(name(&fullname(CARRY))))]),
    );
    let carry = run.created(&proposed.expect("proposed"), CARRY);
    let steps: [(Id, u64, &str, BTreeMap<u64, Value>); 4] = [
        (w1(), 2, "activity:join", role("test:front")),
        (w2(), 1, "activity:join", role("test:back")),
        (w1(), 3, "activity:start", none()),
        (w1(), 4, "carry:lift", p(&[(1, plank().to_value())])),
    ];
    let mut tick = 20;
    for (who, seq, verb, params) in steps {
        let (r, d) = act_at(&run, who, seq, (tick + 1, tick + 200), verb, carry, params);
        println!("E16 carried gap: {verb}: {r:?} {d:?}");
        r.expect(verb);
        tick += 200;
    }
    let r = run.replay();
    assert_eq!(parent(&r, plank()), (Some(carry), Some(1)), "carried");
    let (c1, c2) = (at(&r, w1()), at(&r, w2()));
    let goal = Vec3::new(centre().x, 0, centre().z + 5_000_000);
    let (walked, detail) = act_at(
        &run,
        w3(),
        1,
        (tick + 1, tick + 700),
        "test:walk",
        ground(),
        point(goal),
    );
    let r = run.replay();
    println!(
        "E16 carried gap: walk {walked:?} {detail:?}; the walker at {:?}",
        at(&r, w3())
    );
    // The plank's centre line, 2 m long, between where the carriers stand.
    let mid = Vec3::new((c1.x + c2.x) / 2, 0, (c1.z + c2.z) / 2);
    let (dx, dz) = (i128::from(c1.x - c2.x), i128::from(c1.z - c2.z));
    let len = (dx * dx + dz * dz).isqrt().max(1);
    let half = |d: i128| i64::try_from(d * 1_000_000 / len).unwrap();
    let (ends_a, ends_b) = (
        Vec3::new(mid.x - half(dx), 0, mid.z - half(dz)),
        Vec3::new(mid.x + half(dx), 0, mid.z + half(dz)),
    );
    let closest = closest_to(&run, w3(), ends_a, ends_b);
    println!("E16 carried gap: closest to the plank's centre line {closest} µm");
    // The plank is 300 mm wide: a walker past it keeps its own radius off its edge.
    let keep = 150_000 + i128::from(skills::route::ROOM) - 20_000;
    assert!(
        closest >= keep,
        "never through the carried plank: {closest} µm from its centre line (at least {keep})"
    );
    match &walked {
        Ok(_) => {
            let p = at(&r, w3());
            assert!(p.z > ends_a.z, "arrived north of the plank, round it");
        }
        Err(code) => {
            assert_eq!(code, "goal-unreachable", "{detail:?}");
            assert!(
                detail.as_deref().is_some_and(|d| d.contains("next:")),
                "naming its next step: {detail:?}"
            );
        }
    }
    assert_eq!(parent(&r, plank()), (Some(carry), Some(1)), "still carried");
    assert_eq!(
        (at(&r, w1()), at(&r, w2())),
        (c1, c2),
        "the carriers never moved"
    );
    run.world.stop();
}
