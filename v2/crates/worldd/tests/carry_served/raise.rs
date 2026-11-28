//! #5067, raise and lower on a served world, by Souls' own intents through a real gateway: two Souls carry the loose
//! rack upright lying, set it down, stand at its raise stations and raise it about its foot until it stands, held;
//! then lower it again. The foot never moves on the plan, the part turns on a sampled track (a motion sample a tick,
//! none a jump), too few carriers and a carrier out of reach are refused by name, and the words come in order.

use super::*;
use sim::activity::carry::grips::{self, Holds};
use sim::activity::carry::raise::{SIDE, Spec};

/// The `souls:carry-track` phases said of `carry`, in order.
fn phases(dir: &Path, carry: Id) -> Vec<String> {
    effects(dir)
        .iter()
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| {
            ev.name.as_str() == "souls:carry-track" && ev.fields.get(&1) == Some(&carry.to_value())
        })
        .filter_map(|ev| match ev.fields.get(&3) {
            Some(Value::Text(t)) => Some(t.as_str().to_owned()),
            _ => None,
        })
        .collect()
}

/// Waits until `phase` has been said of `carry` `times` times, at most `secs` seconds; else fails, with what the
/// served world said on its own lines of a raise.
async fn said(dir: &Path, served: &Served, carry: Id, phase: &str, times: usize, secs: u64) {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        let all = phases(dir, carry);
        if all.iter().filter(|p| *p == phase).count() >= times {
            return;
        }
        if Instant::now() > end {
            while let Ok(l) = served.lines.try_recv() {
                if l.contains("worldd:") || l.contains("panick") || l.contains("rais") {
                    println!("served: {l}");
                }
            }
            panic!("no {phase} within {secs} s: {all:?}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The phases of the `souls:carry-grips` words said of `carry`, in order, each with how many it names holding.
fn grips_said(dir: &Path, carry: Id) -> Vec<(String, usize)> {
    effects(dir)
        .iter()
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == grips::GRIPS)
        .filter(|ev| ev.fields.get(&1) == Some(&carry.to_value()))
        .filter_map(|ev| Holds::read(&Value::Map(ev.fields.clone())))
        .map(|h| (h.phase, h.holds.len()))
        .collect()
}

/// Every motion sample of `node` in the log: its position and its turn.
fn samples(dir: &Path, node: Id) -> Vec<(Vec3, replica::pose::Quat)> {
    effects(dir)
        .into_iter()
        .filter_map(|e| match e.body {
            Body::Changes(cs) => cs.into_iter().find_map(|c| match c.change {
                Change::Motion(h) if h.node == node => Some((h.pose.position, h.pose.orientation)),
                _ => None,
            }),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn raise_two_souls_carry_a_lying_upright_raise_it_hold_it_and_lower_it() {
    raise_and_lower("craise", false).await;
}

/// A world stopped while the upright is part way up and started again never leaves it leaning: it finds the raise in
/// its log and lowers the part from where it is, on the same track (the foot where it was, no sample a jump), until
/// it lies; then it is put down and let go.
#[tokio::test(flavor = "multi_thread")]
async fn raise_a_restart_part_way_lays_the_upright_down_again_never_leaning() {
    raise_and_lower("crestart", true).await;
}

async fn raise_and_lower(tag: &str, restart: bool) {
    let d = scratch(tag);
    let facts = world(&d);
    let socket = d.join("s");
    // Two carry and raise it; a third walks near by all through the raise and its end (the camp's walkers: #5067,
    // its standing commit was refused `edit.body-stale` while bodies moved).
    let (dir, ids, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 3);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, frame) = (im.nodes["ground"], im.nodes["loose-upright"]);
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &ids).await;
    let mut souls = Vec::new();
    for (s, t) in ids.iter().zip(&tokens) {
        souls.push(Soul::connect(&url, *s, lineage, t).await);
    }
    for (j, s) in souls.iter_mut().enumerate() {
        s.act(
            "eden:walk",
            ground,
            point(Vec3::new((40 + 2 * j as i64) * M, 0, -18 * M)),
        )
        .await
        .expect("born");
    }
    let bodies: Vec<Id> = ids.iter().map(|s| body_of(&dir, *s)).collect();
    let entry = construction("rack_upright.json");
    let (l, spec) = (Load::of(&entry).unwrap(), Spec::of(&entry).expect("a raise"));
    let at = upright_at();
    // Carried lying: lifted from beside its edges (laid along the line its carriers stand on, Soul 1 east), walked
    // 6 m north and set down.
    let [back, front] = l.places();
    let places = [spot(at, front, false), spot(at, back, false)];
    for (k, p) in places.iter().enumerate() {
        souls[k].send("eden:walk", ground, point(*p)).await;
    }
    for s in souls[..2].iter_mut() {
        s.answer().await.expect("walks to its end");
    }
    together(&dir, &bodies[..2], &places, 60).await;
    let offered = souls[0]
        .act(
            "activity:offer",
            ground,
            BTreeMap::from([
                (1, carry_kind(&dir)),
                (2, Value::Text(Name::new(FRONT).unwrap())),
                (3, Value::Array(vec![bodies[1].to_value()])),
            ]),
        )
        .await
        .expect("the carry offered");
    let carry = carry_made(&dir, &offered);
    // Too few: a crew of one is refused by name.
    let alone = souls[0]
        .act("part:raise", carry, BTreeMap::from([(1, frame.to_value())]))
        .await;
    println!("raised by one: {alone:?}");
    assert_eq!(alone.map(|_| ()), Err("raise.crew-too-small".to_owned()));
    souls[1]
        .act("activity:accept", carry, BTreeMap::new())
        .await
        .expect("accepts");
    // Standing, it is not raised.
    let stood_up = souls[0]
        .act("part:raise", carry, BTreeMap::from([(1, frame.to_value())]))
        .await;
    assert_eq!(stood_up.map(|_| ()), Err("raise.not-lying".to_owned()));
    souls[0]
        .act("carry:lift", carry, BTreeMap::from([(1, frame.to_value())]))
        .await
        .expect("lifted, laid flat between them");
    let north: Vec<Vec3> = places
        .iter()
        .map(|p| Vec3::new(p.x, 0, p.z + 6 * M))
        .collect();
    for (k, p) in north.iter().enumerate() {
        souls[k].send("eden:walk", ground, point(*p)).await;
    }
    for s in souls[..2].iter_mut() {
        s.answer().await.expect("carries it north");
    }
    souls[1]
        .act("carry:set-down", carry, BTreeMap::new())
        .await
        .expect("set down");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let lying = moves_of(&dir, frame).last().cloned().expect("set down");
    assert_eq!(lying.frame.node, ground);
    let (foot, lie) = (lying.position, lying.orientation);
    let dir_of = |q: replica::pose::Quat, v: Vec3| q.rotate(v).unwrap();
    let (along, across) = (dir_of(lie, Vec3::new(0, M, 0)), dir_of(lie, Vec3::new(M, 0, 0)));
    assert!(along.y.abs() <= 20_000, "it lies: {along:?}");
    let on = |a: i64, b: i64| {
        let v = |x: i64, y: i64| (i128::from(x) * i128::from(a) + i128::from(y) * i128::from(b)) / i128::from(M);
        Vec3::new(
            foot.x + v(across.x, along.x) as i64,
            0,
            foot.z + v(across.z, along.z) as i64,
        )
    };
    let beside = spec.half_width + SIDE;
    // The lifter (Soul 1) beside its top end, the footer beside its base on the other side.
    let stations = [on(beside, spec.height), on(-beside, 0)];
    println!(
        "lying with its foot at ({}, {}) mm, its top toward ({}, {}); the lifter to ({}, {}), the footer to ({}, {})",
        foot.x / 1000,
        foot.z / 1000,
        along.x / 1000,
        along.z / 1000,
        stations[0].x / 1000,
        stations[0].z / 1000,
        stations[1].x / 1000,
        stations[1].z / 1000
    );
    for (k, p) in stations.iter().enumerate() {
        souls[k].send("eden:walk", ground, point(*p)).await;
    }
    for s in souls[..2].iter_mut() {
        s.answer().await.expect("walks to its raise station");
    }
    for (b, p) in bodies.iter().zip(&stations) {
        let off = close_to(&dir, *b, *p, 100_000, 30).await;
        assert!(off <= 250_000, "at its station: {off} µm off");
    }
    // A carrier out of reach of its hold is refused by name: the footer, at the base, asks to lift the top.
    let far = souls[1]
        .act("part:raise", carry, BTreeMap::from([(1, frame.to_value())]))
        .await;
    println!("raised by the footer, 2.4 m from the top: {far:?}");
    assert_eq!(far.map(|_| ()), Err("part.grip-out-of-reach".to_owned()));
    assert!(phases(&dir, carry).iter().all(|p| p != "souls:raise"));
    let before = samples(&dir, carry).len();
    souls[0]
        .act("part:raise", carry, BTreeMap::from([(1, frame.to_value())]))
        .await
        .expect("the raise begins");
    // The third Soul walks to and fro 3 m off the frame's other side while it is raised and stood, until it is held.
    if !restart {
        let (a, b) = (on(-3 * M, 0), on(-3 * M, 2 * M));
        let end = Instant::now() + Duration::from_secs(30);
        for k in 0.. {
            let to = if k % 2 == 0 { b } else { a };
            souls[2]
                .act("eden:walk", ground, point(to))
                .await
                .expect("the third walks near by");
            let held = grips_said(&dir, carry).iter().any(|g| g.0 == "souls:held");
            let turned = phases(&dir, carry).iter().any(|p| p == "souls:lowered");
            if held || turned || Instant::now() > end {
                println!("the third walked {} legs near by", k + 1);
                break;
            }
        }
    }
    // The track: a sample a tick, the foot where it was on the plan, the top never more than 60 mm from the last.
    let top = |q: replica::pose::Quat| dir_of(q, Vec3::new(0, spec.height, 0));
    let checked = |track: &[(Vec3, replica::pose::Quat)], what: &str| {
        assert!(track.len() >= 60, "{what}: a track, {} samples", track.len());
        for (p, _) in track {
            assert!(
                (p.x - foot.x).abs() <= 1 && (p.z - foot.z).abs() <= 1,
                "{what}: the foot stays put: {p:?}"
            );
        }
        let step = track
            .windows(2)
            .map(|w| {
                let (a, b) = (top(w[0].1), top(w[1].1));
                (i128::from(a.x - b.x).pow(2) + i128::from(a.y - b.y).pow(2) + i128::from(a.z - b.z).pow(2))
                    .isqrt()
            })
            .max()
            .unwrap_or(0);
        println!("{what}: {} samples, its top at most {} mm a tick", track.len(), step / 1000);
        assert!(step <= 60_000, "{what}: no jump: {step} µm in a tick");
    };
    if restart {
        // Part way up (40 samples, some two seconds): the world stops, and starts again.
        let end = Instant::now() + Duration::from_secs(20);
        while samples(&dir, carry).len() < before + 40 {
            assert!(Instant::now() < end, "the raise never got part way");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        drop(served);
        let part_way = samples(&dir, carry);
        let lean = top(part_way.last().unwrap().1);
        println!(
            "stopped part way: {} samples, its top {} mm up of {}",
            part_way.len() - before,
            lean.y / 1000,
            spec.height / 1000
        );
        assert!(lean.y > 100_000 && lean.y < spec.height - 100_000, "leaning: {lean:?}");
        let served = super::grips::serve_again(&dir, &socket);
        served.line("listening ", 180);
        said(&dir, &served, carry, "souls:lowered", 1, 40).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let all = samples(&dir, carry);
        checked(&all[before..], "raised part way, then lowered by the world started again");
        let laid = moves_of(&dir, frame).last().cloned().expect("laid down");
        let y = dir_of(laid.orientation, Vec3::new(0, M, 0));
        println!(
            "after the restart: lying at ({}, {}, {}) mm, its length {y:?}; phases {:?}; grips {:?}",
            laid.position.x / 1000,
            laid.position.y / 1000,
            laid.position.z / 1000,
            phases(&dir, carry),
            grips_said(&dir, carry)
        );
        assert_eq!(laid.frame.node, ground);
        assert!(y.y.abs() <= 20_000, "it lies, never left leaning: {y:?}");
        assert!(
            (laid.position.x - foot.x).abs() <= 1_000 && (laid.position.z - foot.z).abs() <= 1_000,
            "its foot where it was: {:?}",
            laid.position
        );
        assert_eq!(
            grips_said(&dir, carry).last().map(|g| g.0.clone()),
            Some("souls:released".to_owned())
        );
        drop(served);
        return;
    }
    said(&dir, &served, carry, "souls:raised", 1, 30).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let all = samples(&dir, carry);
    let up = &all[before..];
    checked(up, "raised");
    let stands = moves_of(&dir, frame).last().cloned().expect("stood up");
    let y = dir_of(stands.orientation, Vec3::new(0, M, 0));
    println!(
        "raised: standing at ({}, {}, {}) mm, its length {y:?}; phases {:?}; grips {:?}",
        stands.position.x / 1000,
        stands.position.y / 1000,
        stands.position.z / 1000,
        phases(&dir, carry),
        grips_said(&dir, carry)
    );
    assert_eq!(stands.frame.node, ground);
    assert!(y.y >= M - 200, "it stands: {y:?}");
    assert!(
        (stands.position.x - foot.x).abs() <= 1_000
            && (stands.position.z - foot.z).abs() <= 1_000
            && stands.position.y.abs() <= 2_000,
        "on its foot, where its foot lay: {:?}",
        stands.position
    );
    // Held, never free: its crew's holds are said held, both of them.
    let g = grips_said(&dir, carry);
    assert!(g.contains(&("souls:raise".to_owned(), 2)), "{g:?}");
    assert_eq!(g.last(), Some(&("souls:held".to_owned(), 2)), "{g:?}");
    // #5067 item 2: each holder's two hands on its own post's outward face, 1.05 m and 1.35 m above the frame's foot
    // (on the ground), from the frame's outer side (standing on its own, its back): where a standing body holds it
    // upright, out of the space between frames, not at the foot or overhead.
    let held = effects(&dir)
        .iter()
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == grips::GRIPS)
        .filter(|ev| ev.fields.get(&1) == Some(&carry.to_value()))
        .filter_map(|ev| Holds::read(&Value::Map(ev.fields.clone())))
        .next_back()
        .expect("the held word");
    let posts: Vec<i64> = held.holds.iter().map(|h| h.hands[0].x).collect();
    println!("held: {:?}", held.holds);
    let post = spec.half_width - spec.half_thick;
    assert!(posts[0] == -posts[1] && posts[0].abs() == post, "one on each post: {posts:?}");
    for h in &held.holds {
        assert_eq!([h.hands[0].y, h.hands[1].y], grips::HOLD_HANDS, "{h:?}");
        assert_eq!((h.hands[0].x, h.hands[0].z), (h.hands[1].x, -spec.half_thick), "its back: {h:?}");
    }
    // Each holder walks round to behind its post, 0.35 m off the frame's back.
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        let feet = stood(&dir);
        let offs: Vec<i128> = held
            .holds
            .iter()
            .map(|h| {
                let st = dir_of(stands.orientation, Vec3::new(h.hands[0].x, 0, -spec.half_thick - 350_000));
                let p = Vec3::new(stands.position.x + st.x, 0, stands.position.z + st.z);
                let f = feet[&h.body];
                (i128::from(f.x - p.x).pow(2) + i128::from(f.z - p.z).pow(2)).isqrt()
            })
            .collect();
        if offs.iter().all(|o| *o <= 100_000) {
            println!("the holders stand behind its posts, {offs:?} µm off");
            break;
        }
        assert!(Instant::now() < end, "behind its posts: {offs:?} µm off");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // Lowered again by the same crew: laid down about the same foot, and let go.
    let before = samples(&dir, carry).len();
    souls[0]
        .act("part:lower", carry, BTreeMap::new())
        .await
        .expect("the lowering begins");
    said(&dir, &served, carry, "souls:lowered", 1, 30).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let all = samples(&dir, carry);
    checked(&all[before..], "lowered");
    let laid = moves_of(&dir, frame).last().cloned().expect("laid down");
    let y = dir_of(laid.orientation, Vec3::new(0, M, 0));
    println!(
        "lowered: lying at ({}, {}, {}) mm, its length {y:?}; phases {:?}; grips {:?}",
        laid.position.x / 1000,
        laid.position.y / 1000,
        laid.position.z / 1000,
        phases(&dir, carry),
        grips_said(&dir, carry)
    );
    assert_eq!(laid.frame.node, ground);
    assert!(y.y.abs() <= 20_000, "it lies: {y:?}");
    assert!(
        (laid.position.x - foot.x).abs() <= 1_000 && (laid.position.z - foot.z).abs() <= 1_000,
        "its foot where it stood: {:?}",
        laid.position
    );
    assert!((laid.position.y - spec.half_thick).abs() <= 2_000, "on its face");
    let p = phases(&dir, carry);
    let of = |w: &str| p.iter().position(|x| x == w).unwrap_or(usize::MAX);
    assert!(
        of("souls:raise") < of("souls:raised") && of("souls:raised") < of("souls:lower") && of("souls:lower") < of("souls:lowered"),
        "the words in order: {p:?}"
    );
    assert_eq!(
        grips_said(&dir, carry).last().map(|g| g.0.clone()),
        Some("souls:released".to_owned())
    );
    // Its crew may leave now.
    for s in souls[..2].iter_mut() {
        s.act("activity:leave", carry, BTreeMap::new())
            .await
            .expect("a leave is accepted once it lies");
    }
    drop(served);
}
