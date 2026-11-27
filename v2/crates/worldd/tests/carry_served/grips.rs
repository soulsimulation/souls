//! #5067 items 1 and 3 on a served world, by Souls' own intents through a real gateway: who holds which grip is kept on
//! the carry's node and said to its audience (`souls:carry-grips`), by the carry's own rule; a side carrier who leaves
//! takes only its own hold away; a restart mid-carry finds the holds in the log and lets go of them; and a crew's part is
//! never moved on a seating's track out of a carrier's reach of its grip (`part.grip-out-of-reach`).
//!
//! N2's test world with, on its square, a timber rail (the shade's) and a timber bundle (the loading spot's) lying along
//! z, and the yard's rack beams.

use super::*;
use sim::activity::carry::grips::{self, Holds};

/// The timber rail's and the bundle's middles: on N2's square, lying along z.
fn rail_at() -> Vec3 {
    Vec3::new(0, 0, -10 * M)
}
fn bundle_at() -> Vec3 {
    Vec3::new(-12 * M, 0, -10 * M)
}

/// [`world`] with the shade's and the loading spot's kinds, a timber rail at [`rail_at`] and a timber bundle at
/// [`bundle_at`].
fn grips_world(d: &Path) -> String {
    let facts = world(d);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/carpentry");
    for f in std::fs::read_dir(&root).unwrap() {
        let p = f.unwrap().path();
        if p.extension().is_some_and(|x| x == "json") {
            std::fs::copy(&p, d.join("entries").join(p.file_name().unwrap())).unwrap();
        }
    }
    let mut f = json::parse(&facts).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    let num = |v: i64| json::Value::Int(i128::from(v));
    let refs = [
        (
            "testworld-timber-rail@1",
            "mars:timber_rail",
            "timber-rail",
            rail_at(),
        ),
        (
            "testworld-timber-bundle@1",
            "mars:timber_bundle",
            "timber-bundle",
            bundle_at(),
        ),
    ];
    for (k, v) in top.iter_mut() {
        match (k.as_str(), v) {
            ("kinds", json::Value::Arr(a)) => {
                for (r, name, _, _) in refs {
                    let hash = replica::encode::to_hex(&replica::ids::sha256(
                        format!("souls/testworld/{r}").as_bytes(),
                    ));
                    a.push(json::Value::Obj(vec![
                        ("ref".into(), json::Value::s(r)),
                        ("hash".into(), json::Value::s(&hash)),
                        ("name".into(), json::Value::s(name)),
                        ("form".into(), json::Value::s("point")),
                    ]));
                }
            }
            ("things", json::Value::Arr(a)) => {
                for (r, _, id, at) in refs {
                    a.push(json::Value::Obj(vec![
                        ("id".into(), json::Value::s(id)),
                        ("def".into(), json::Value::s(r)),
                        ("ref".into(), json::Value::s(r)),
                        ("parent".into(), json::Value::Null),
                        (
                            "pose".into(),
                            json::Value::Arr([at.x / 1000, 0, at.z / 1000, 0].map(num).to_vec()),
                        ),
                        ("scale_ppm".into(), num(1_000_000)),
                        ("name".into(), json::Value::s(id)),
                    ]));
                }
            }
            _ => {}
        }
    }
    f.to_json()
}

/// Every `souls:carry-grips` word the log holds for `activity`, in order.
fn words(dir: &Path, activity: Id) -> Vec<Holds> {
    effects(dir)
        .iter()
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == grips::GRIPS)
        .filter(|ev| {
            ev.fields
                .get(&1)
                .and_then(|v| replica::effects::read_id(v).ok())
                == Some(activity)
        })
        .filter_map(|ev| Holds::read(&Value::Map(ev.fields.clone())))
        .collect()
}

/// `activity`'s holds as its node's field last had them in the log (the state a page reads), or none.
fn field(dir: &Path, activity: Id) -> Option<Holds> {
    effects(dir)
        .iter()
        .filter_map(|e| match &e.body {
            Body::Changes(cs) => Some(cs),
            _ => None,
        })
        .flatten()
        .filter_map(|c| match &c.change {
            Change::Set {
                node, field, to, ..
            } if *node == activity && *field == grips::F_GRIPS => Some(to.clone()),
            _ => None,
        })
        .next_back()
        .and_then(|v| Holds::read(&v))
}

/// The grips `holds` name, by body.
fn by_body(h: &Holds) -> BTreeMap<String, String> {
    h.holds
        .iter()
        .map(|h| (replica::world_model::show(h.body), h.grip.clone()))
        .collect()
}

/// Where a crew of `n` stands at a load whose middle is `at`, lying along z, its front north: the front and the back
/// at its ends, its sides at their places ([`Load::side_places`]), in join order.
fn places_north(at: Vec3, load: &Load, n: usize) -> Vec<Vec3> {
    let [back, front] = load.places();
    let mut p = vec![spot(at, front, true), spot(at, back, true)];
    for side in load.side_places().iter().take(n - 2) {
        let o = worldd::engine::on_plan(*side, [0, M]);
        p.push(Vec3::new(at.x + o[0], 0, at.z + o[1]));
    }
    p
}

/// The crew of `crew` (indices into `souls`) walked to `places` and made a carry: the first offers in front, the rest
/// accept in turn (the back, then its sides in join order).
async fn crew_at(
    souls: &mut [Soul],
    dir: &Path,
    ground: Id,
    bodies: &[Id],
    crew: &[usize],
    places: &[Vec3],
) -> Id {
    for (k, p) in crew.iter().zip(places) {
        souls[*k].send("eden:walk", ground, point(*p)).await;
    }
    for k in crew {
        souls[*k].answer().await.expect("walks to its place");
    }
    let members: Vec<Id> = crew.iter().map(|k| bodies[*k]).collect();
    together(dir, &members, places, 60).await;
    let asked = members[1..].iter().map(|b| b.to_value()).collect();
    let offered = souls[crew[0]]
        .act(
            "activity:offer",
            ground,
            BTreeMap::from([
                (1, carry_kind(dir)),
                (2, Value::Text(Name::new(FRONT).unwrap())),
                (3, Value::Array(asked)),
            ]),
        )
        .await
        .expect("offered");
    let carry = carry_made(dir, &offered);
    for k in &crew[1..] {
        souls[*k]
            .act("activity:accept", carry, BTreeMap::new())
            .await
            .expect("accepts");
    }
    carry
}

/// Prints what the served world has said on its own lines so far about grips, refusals and entries not written.
fn said(served: &Served) {
    while let Ok(l) = served.lines.try_recv() {
        if l.contains("grip") || l.contains("not written") || l.contains("refus") {
            println!("served: {l}");
        }
    }
}

/// The last word for `carry` within 20 s that `ok` takes.
async fn word_that(dir: &Path, carry: Id, what: &str, ok: impl Fn(&Holds) -> bool) -> Holds {
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(h) = words(dir, carry).into_iter().rev().find(|h| ok(h)) {
            return h;
        }
        if Instant::now() > end {
            let names: Vec<String> = effects(dir)
                .iter()
                .flat_map(|e| e.events.iter().flatten())
                .map(|ev| ev.name.as_str().to_owned())
                .filter(|n| n.contains("carry"))
                .collect();
            panic!("no grips word: {what}; the log's carry words {names:?}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Crews of two, four and six lift a rack beam, a timber rail and a timber bundle, carry each 6 m with a turn and set
/// it down. Each carrier holds one grip by the carry's rule (the front the grip at the load's front end, the back the
/// one at its back, the sides the grips between in join order, from the back), each grip held once, both hands within
/// the load's length; the holds stay the same through the walk and its turn, and when a side carrier leaves only its
/// own hold goes. The set-down lets go of the same holds. Then two lift the beam again and the world restarts mid-carry:
/// after the restart the log still holds them, and they are let go with the set-down the restart makes.
#[tokio::test(flavor = "multi_thread")]
async fn grips_crews_of_two_four_and_six_keep_their_grips_through_a_leave_and_a_restart() {
    let d = scratch("cgrips");
    let facts = grips_world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (0, -18), &socket, 6);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let ground = im.nodes["ground"];
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &ids).await;
    let mut souls = Vec::new();
    for (s, t) in ids.iter().zip(&tokens) {
        souls.push(Soul::connect(&url, *s, lineage, t).await);
    }
    // A body is born at its Soul's first act: each walks to its own spot.
    for (j, s) in souls.iter_mut().enumerate() {
        s.act(
            "eden:walk",
            ground,
            point(Vec3::new((j as i64 - 3) * 2 * M, 0, -18 * M)),
        )
        .await
        .expect("born");
    }
    let bodies: Vec<Id> = ids.iter().map(|s| body_of(&dir, *s)).collect();
    let carpentry = |f: &str| {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/carpentry");
        json::parse(&std::fs::read_to_string(p.join(f)).unwrap()).unwrap()
    };
    let cases = [
        (
            "a rack beam",
            im.nodes["yard-beam-4"],
            beam_at(),
            Load::of(&construction("rack_beam.json")).unwrap(),
            vec![0, 1],
            None,
        ),
        (
            "a timber rail",
            im.nodes["timber-rail"],
            rail_at(),
            Load::of(&carpentry("timber_rail.json")).unwrap(),
            vec![0, 1, 2, 3],
            Some(3),
        ),
        (
            "a timber bundle",
            im.nodes["timber-bundle"],
            bundle_at(),
            Load::of(&construction("timber_bundle.json")).unwrap(),
            vec![0, 1, 2, 3, 4, 5],
            Some(4),
        ),
    ];
    for (what, load, at, l, crew, leaves) in cases {
        let n = crew.len();
        let places = places_north(at, &l, n);
        let carry = crew_at(&mut souls, &dir, ground, &bodies, &crew, &places).await;
        souls[0]
            .act("carry:lift", carry, BTreeMap::from([(1, load.to_value())]))
            .await
            .unwrap_or_else(|r| panic!("{n} lift {what}: {r}"));
        tokio::time::sleep(Duration::from_secs(1)).await;
        said(&served);
        let lifted = word_that(&dir, carry, what, |h| h.phase == grips::CARRY).await;
        println!("{n} lift {what}: {:?}", by_body(&lifted));
        assert_eq!(lifted.load, load, "{what}");
        assert_eq!(lifted.holds.len(), n, "{what}: a hold for each carrier");
        let mut held: Vec<&str> = lifted.holds.iter().map(|h| h.grip.as_str()).collect();
        held.sort_unstable();
        held.dedup();
        assert_eq!(held.len(), n, "{what}: each grip held once");
        // The front north holds the grip at the load's north (+z) end, the back the south one; the sides from the back.
        let z: Vec<i64> = lifted.holds.iter().map(|h| h.at.z).collect();
        assert_eq!(z[0], *z.iter().max().unwrap(), "{what}: the front's grip");
        assert_eq!(z[1], *z.iter().min().unwrap(), "{what}: the back's grip");
        assert!(
            z[2..].windows(2).all(|w| w[0] < w[1]),
            "{what}: the sides {z:?}"
        );
        for h in &lifted.holds {
            assert!(
                h.hands.iter().all(|p| p.z.abs() <= l.half_length),
                "{what}: {}'s hands within its length",
                h.grip
            );
        }
        // The front walks 6 m east and 2 m north: the crew turns with it.
        let to = Vec3::new(places[0].x + 6 * M, 0, places[0].z + 2 * M);
        souls[0].send("eden:walk", ground, point(to)).await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let mut kept = lifted.clone();
        if let Some(k) = leaves {
            souls[k]
                .act("activity:leave", carry, BTreeMap::new())
                .await
                .unwrap_or_else(|r| panic!("{what}: side {k} leaves: {r}"));
            let after = word_that(&dir, carry, what, |h| h.holds.len() == n - 1).await;
            kept.holds.retain(|h| h.body != bodies[k]);
            println!("{what}: side {k} let go: {:?}", by_body(&after));
            assert_eq!(
                after.holds, kept.holds,
                "{what}: every other carrier keeps its grip"
            );
            assert_eq!(after.phase, grips::CARRY, "{what}: carried on");
        }
        souls[0].answer().await.expect("the front walks on");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(
            field(&dir, carry).map(|h| h.holds),
            Some(kept.holds.clone())
        );
        souls[0]
            .act("carry:set-down", carry, BTreeMap::new())
            .await
            .unwrap_or_else(|r| panic!("{what}: set down: {r}"));
        let down = word_that(&dir, carry, what, |h| h.phase == grips::RELEASED).await;
        assert_eq!(down.holds, kept.holds, "{what}: the same holds let go");
        assert_eq!(
            field(&dir, carry),
            Some(down),
            "{what}: the node keeps them"
        );
        for k in &crew {
            if Some(*k) != leaves {
                let _ = souls[*k]
                    .act("activity:leave", carry, BTreeMap::new())
                    .await;
            }
        }
        // Out of the next crew's way, north of the square's loads.
        for (j, k) in crew.iter().enumerate() {
            souls[*k]
                .send(
                    "eden:walk",
                    ground,
                    point(Vec3::new((j as i64 - 3) * 2 * M, 0, 6 * M)),
                )
                .await;
        }
        for k in &crew {
            let _ = souls[*k].answer().await;
        }
    }

    // A restart mid-carry: two lift the yard's third beam and walk; the world stops and starts again.
    let beam = im.nodes["yard-beam-3"];
    let at = Vec3::new(beam_at().x - testworld::BEAM_PITCH * 1000, 0, beam_at().z);
    let l = Load::of(&construction("rack_beam.json")).unwrap();
    let places = places_north(at, &l, 2);
    let carry = crew_at(&mut souls, &dir, ground, &bodies, &[0, 1], &places).await;
    souls[0]
        .act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("two lift the third beam");
    let lifted = word_that(&dir, carry, "lifted again", |h| h.phase == grips::CARRY).await;
    souls[0]
        .send(
            "eden:walk",
            ground,
            point(Vec3::new(places[0].x + 8 * M, 0, places[0].z)),
        )
        .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    drop(served);
    assert_eq!(
        field(&dir, carry),
        Some(lifted.clone()),
        "the log holds the holds as the world stopped"
    );
    let socket2 = d.join("s2");
    let served = serve_again(&dir, &socket2);
    served.line("listening ", 180);
    let down = word_that(&dir, carry, "after the restart", |h| {
        h.phase == grips::RELEASED
    })
    .await;
    println!(
        "after the restart: {:?} let go at {} µs",
        by_body(&down),
        down.since
    );
    assert_eq!(
        down.holds, lifted.holds,
        "the same holds let go at the restart"
    );
    assert!(down.since > lifted.since);
    assert_eq!(
        broke(&dir).last().map(String::as_str),
        Some("souls:world-restarted")
    );
    assert_eq!(field(&dir, carry), Some(down));
    drop(served);
}

/// `worldd serve` again on the world in `dir`, on `socket`.
fn serve_again(dir: &Path, socket: &Path) -> Served {
    let mut child = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["serve", "--dir"])
        .arg(dir)
        .arg("--socket")
        .arg(socket)
        .args(["--machine", "test-machine"])
        .env_remove("WORLDD_STORE")
        .env_remove("DIRECTORY_STORE_URL")
        .env_remove("SOULS_BACKUP_URL")
        .env_remove("SOULS_BACKUP_KEY_FILE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("worldd serve starts again");
    let (tx, lines) = channel();
    let out = child.stdout.take().expect("stdout");
    let err = child.stderr.take().expect("stderr");
    for pipe in [Box::new(out) as Box<dyn Read + Send>, Box::new(err)] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for l in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = tx.send(l);
            }
        });
    }
    Served { child, lines }
}

/// #5067 item 3: a crew of two takes a rack beam and lays it on the open ground. 0.9 m to the side, the front's and the
/// back's grips would end out of their reach: refused `part.grip-out-of-reach` before anything moves. 0.3 m to the side
/// it is laid there, its holds said on the set-in track and let go. Taken again and put 0.5 m to the side, the back
/// walks off as the beam goes in: the set-in stops by name (the put refused `part.grip-out-of-reach`) and the beam goes
/// back to where the set-in started, where its carry breaks off (`souls:carriers-apart`) and it is set down: never
/// moved on toward the slot out of the back's reach, never set down anywhere unchecked.
#[tokio::test(flavor = "multi_thread")]
async fn grips_a_seating_track_never_takes_the_part_out_of_a_carriers_reach() {
    let d = scratch("creach");
    let facts = grips_world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam) = (im.nodes["ground"], im.nodes["yard-beam-4"]);
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
            point(Vec3::new((44 + 2 * j as i64) * M, 0, -18 * M)),
        )
        .await
        .expect("born");
    }
    let bodies: Vec<Id> = ids.iter().map(|s| body_of(&dir, *s)).collect();
    let l = Load::of(&construction("rack_beam.json")).unwrap();
    let here = |p: Vec3| {
        BTreeMap::from([
            (1, ground.to_value()),
            (3, Value::Array(vec![int(p.x), int(0), int(p.z)])),
        ])
    };
    let take = async |souls: &mut Vec<Soul>, served: &Served, at: Vec3| {
        let places = places_north(at, &l, 2);
        let carry = crew_at(souls, &dir, ground, &bodies, &[0, 1], &places).await;
        souls[0]
            .act("part:take", carry, BTreeMap::from([(1, beam.to_value())]))
            .await
            .expect("the crew takes the beam");
        tokio::time::sleep(Duration::from_secs(1)).await;
        said(served);
        word_that(&dir, carry, "taken", |h| h.phase == grips::CARRY).await;
        carry
    };
    let at = beam_at();
    let carry = take(&mut souls, &served, at).await;
    let got = souls[0]
        .act("part:put", carry, here(Vec3::new(at.x + 900_000, 0, at.z)))
        .await;
    println!("put 0.9 m to the side: {got:?}");
    assert_eq!(got, Err("part.grip-out-of-reach".to_owned()));
    let to = Vec3::new(at.x + 300_000, 0, at.z);
    souls[0]
        .act("part:put", carry, here(to))
        .await
        .expect("laid 0.3 m to the side");
    let w = words(&dir, carry);
    let phases: Vec<&str> = w.iter().map(|h| h.phase.as_str()).collect();
    assert_eq!(phases, [grips::CARRY, grips::SET_IN, grips::RELEASED]);
    assert!(
        w[1].until.is_some_and(|u| u > w[1].since),
        "the set-in says when it ends"
    );
    assert!(
        w.windows(2).all(|p| p[0].holds == p[1].holds),
        "the same holds throughout"
    );
    for s in souls.iter_mut() {
        let _ = s.act("activity:leave", carry, BTreeMap::new()).await;
    }

    // Taken again where it lies; as it goes in, the back walks 4 m south.
    let at = moves_of(&dir, beam).last().unwrap().position;
    let carry = take(&mut souls, &served, Vec3::new(at.x, 0, at.z)).await;
    souls[0]
        .send("part:put", carry, here(Vec3::new(at.x + 500_000, 0, at.z)))
        .await;
    let back = stood(&dir)[&bodies[1]];
    souls[1]
        .send(
            "eden:walk",
            ground,
            point(Vec3::new(back.x, 0, back.z - 4 * M)),
        )
        .await;
    let put = souls[0].answer().await;
    println!("put while the back walks off: {put:?}");
    assert_eq!(put, Err("part.grip-out-of-reach".to_owned()));
    let _ = souls[1].answer().await;
    let down = word_that(&dir, carry, "let go", |h| h.phase == grips::RELEASED).await;
    assert_eq!(down.holds.len(), 2);
    assert_eq!(
        broke(&dir).last().map(String::as_str),
        Some("souls:carriers-apart"),
        "set down where the set-in started, its carriers gone"
    );
    let laid = moves_of(&dir, beam).last().unwrap().position;
    println!(
        "set down at ({}, {}) mm, its foot {} mm up; taken at ({}, {}) mm",
        laid.x / 1000,
        laid.z / 1000,
        laid.y / 1000,
        at.x / 1000,
        at.z / 1000
    );
    assert!(laid.y >= 0, "on the ground, not in it");
    assert!(
        (laid.x - at.x).abs() < 350_000,
        "where the set-in started, between its carriers"
    );
    let phases: Vec<String> = words(&dir, carry).into_iter().map(|h| h.phase).collect();
    println!("phases: {phases:?}");
    // Back where the set-in started, its carry goes on for a moment if the back has not yet gone 1 m, then breaks off.
    assert_eq!(phases[..3], [grips::CARRY, grips::SET_IN, grips::RETURN]);
    assert_eq!(phases.last().map(String::as_str), Some(grips::RELEASED));
    drop(served);
}

/// #5067 (reachable carriers, acceptance 2 and 3b; the retained frame case): a crew of two takes the loose 2.4 m rack
/// frame standing, from beside its edges.
/// Its back walks 2.5 m off: the carry breaks off (`souls:carriers-apart`) and the frame is set down. Each carrier then
/// walks to its end where the client's approach aims it (`v2/client/src/carry/carry.mjs` `gripSpot`: along the frame's
/// long axis if it lies, else its own z, at its places), and the same crew lifts it again: admitted, not refused
/// `carry-grip-out-of-reach` (the approach stood 2.2 m off, 1420 mm from its grip, before).
#[tokio::test(flavor = "multi_thread")]
async fn grips_a_frame_set_down_by_carriers_apart_is_lifted_again_from_its_approach() {
    let d = scratch("crelift");
    let facts = grips_world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
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
    let l = Load::of(&construction("rack_upright.json")).unwrap();
    // The client's approach (`gripSpot`): along its long axis if it lies, else its own z, front at its + place.
    let approach = |p: &replica::pose::Pose| -> Vec<Vec3> {
        let m = p.orientation.rotate(l.middle).unwrap();
        let mid = Vec3::new(p.position.x + m.x, 0, p.position.z + m.z);
        let v = match l.lies_along(p.orientation).unwrap() {
            Some(v) => v,
            None => {
                let z = p.orientation.rotate(Vec3::new(0, 0, M)).unwrap();
                [z.x, z.z]
            }
        };
        let n = ((i128::from(v[0]).pow(2) + i128::from(v[1]).pow(2)).isqrt() as i64).max(1);
        let [back, front] = l.places();
        [front, back]
            .iter()
            .map(|d| Vec3::new(mid.x + v[0] * d / n, 0, mid.z + v[1] * d / n))
            .collect()
    };
    let at = upright_at();
    // Taken standing from beside its edges (its own x, REACH beyond its half width), where each reaches the edge it holds.
    let edge = l.half_width + sim::activity::carry::REACH;
    let places = vec![spot(at, edge, false), spot(at, -edge, false)];
    let carry = crew_at(&mut souls, &dir, ground, &bodies, &[0, 1], &places).await;
    souls[0]
        .act("part:take", carry, BTreeMap::from([(1, frame.to_value())]))
        .await
        .expect("the crew takes the frame standing");
    word_that(&dir, carry, "taken", |h| h.phase == grips::CARRY).await;
    let back = places[1];
    souls[1]
        .send(
            "eden:walk",
            ground,
            point(Vec3::new(back.x - 2_500_000, 0, back.z)),
        )
        .await;
    let _ = souls[1].answer().await;
    word_that(&dir, carry, "set down", |h| h.phase == grips::RELEASED).await;
    said(&served);
    assert_eq!(
        broke(&dir).last().map(String::as_str),
        Some("souls:carriers-apart"),
        "the carry broke off and the frame was set down"
    );
    let laid = moves_of(&dir, frame).last().cloned().expect("set down");
    let to = approach(&laid);
    println!(
        "set down at ({}, {}) mm; the front's approach ({}, {}) mm, the back's ({}, {}) mm",
        laid.position.x / 1000,
        laid.position.z / 1000,
        to[0].x / 1000,
        to[0].z / 1000,
        to[1].x / 1000,
        to[1].z / 1000
    );
    for (k, p) in to.iter().enumerate() {
        souls[k].send("eden:walk", ground, point(*p)).await;
    }
    for s in souls.iter_mut() {
        s.answer().await.expect("walks to its end");
    }
    together(&dir, &bodies, &to, 60).await;
    let lift = souls[0]
        .act("carry:lift", carry, BTreeMap::from([(1, frame.to_value())]))
        .await;
    said(&served);
    println!("lifted again by the same crew: {lift:?}");
    assert_eq!(lift.map(|_| ()), Ok(()), "admitted from its approach");
    drop(served);
}

/// #5067 (no exemption at the put): a crew of two takes a rack beam; its back steps 0.9 m back from its
/// place (under the carry's 1 m stretch, so the carry goes on, the beam between them), which takes both carriers 0.8 m
/// from their grips. A put from there is refused `part.grip-out-of-reach` before anything moves: no carrier out of reach
/// where the set-in would start is named as holding on a track (no `set-in` word). The back walks back to its place
/// (an ordinary walk, the authoritative way there) and the same put is laid, holding the same grips throughout.
#[tokio::test(flavor = "multi_thread")]
async fn grips_a_carrier_out_of_reach_where_the_set_in_starts_is_refused_by_name() {
    let d = scratch("cstart");
    let facts = grips_world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam) = (im.nodes["ground"], im.nodes["yard-beam-4"]);
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
            point(Vec3::new((44 + 2 * j as i64) * M, 0, -18 * M)),
        )
        .await
        .expect("born");
    }
    let bodies: Vec<Id> = ids.iter().map(|s| body_of(&dir, *s)).collect();
    let l = Load::of(&construction("rack_beam.json")).unwrap();
    let here = |p: Vec3| {
        BTreeMap::from([
            (1, ground.to_value()),
            (3, Value::Array(vec![int(p.x), int(0), int(p.z)])),
        ])
    };
    let at = beam_at();
    let places = places_north(at, &l, 2);
    let carry = crew_at(&mut souls, &dir, ground, &bodies, &[0, 1], &places).await;
    souls[0]
        .act("part:take", carry, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("the crew takes the beam");
    word_that(&dir, carry, "taken", |h| h.phase == grips::CARRY).await;
    let back = places[1];
    souls[1]
        .act(
            "eden:walk",
            ground,
            point(Vec3::new(
                back.x,
                0,
                back.z + (back.z - at.z).signum() * 900_000,
            )),
        )
        .await
        .expect("the back steps back");
    tokio::time::sleep(Duration::from_secs(1)).await;
    said(&served);
    let to = Vec3::new(at.x + 300_000, 0, at.z);
    let got = souls[0].act("part:put", carry, here(to)).await;
    println!("put with the back 0.9 m back: {got:?}");
    assert_eq!(got, Err("part.grip-out-of-reach".to_owned()));
    assert!(
        words(&dir, carry).iter().all(|h| h.phase == grips::CARRY),
        "nobody named as holding on a set-in track while out of reach"
    );
    souls[1]
        .act("eden:walk", ground, point(back))
        .await
        .expect("the back walks back to its grip");
    tokio::time::sleep(Duration::from_secs(1)).await;
    souls[0]
        .act("part:put", carry, here(to))
        .await
        .expect("laid once both reach their grips");
    let w = words(&dir, carry);
    let phases: Vec<&str> = w.iter().map(|h| h.phase.as_str()).collect();
    println!("phases: {phases:?}");
    assert_eq!(phases.last().copied(), Some(grips::RELEASED));
    assert!(phases.contains(&grips::SET_IN));
    assert!(
        w.windows(2).all(|p| p[0].holds == p[1].holds),
        "the same holds throughout"
    );
    drop(served);
}

/// #5067 (admission at the take, the initially unreachable frame): two Souls stand 2.2 m off the faces of the loose
/// 2.4 m rack frame (where the client's approach used to send them), 2.16 m from the edge each would hold, and ask to
/// take it: refused `part.grip-out-of-reach`, naming a carrier, before anything is written (the frame stands where it
/// stood, no holds are said). They walk to beside its edges (its own x, 0.35 m beyond each: an ordinary walk, the
/// authoritative way there) and the same crew takes it, each hold within reach.
#[tokio::test(flavor = "multi_thread")]
async fn grips_a_frame_taken_from_out_of_reach_is_refused_by_name_then_taken_from_beside_its_edges()
{
    let d = scratch("cfar");
    let facts = grips_world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
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
    let l = Load::of(&construction("rack_upright.json")).unwrap();
    let at = upright_at();
    let before = moves_of(&dir, frame).len();
    // 2.2 m off its faces, along its own z.
    let far = vec![spot(at, 2_200_000, true), spot(at, -2_200_000, true)];
    let carry = crew_at(&mut souls, &dir, ground, &bodies, &[0, 1], &far).await;
    let got = souls[0]
        .act("part:take", carry, BTreeMap::from([(1, frame.to_value())]))
        .await;
    said(&served);
    println!("taken from 2.2 m off its faces: {got:?}");
    assert_eq!(got.map(|_| ()), Err("part.grip-out-of-reach".to_owned()));
    assert!(words(&dir, carry).is_empty(), "no holds said");
    assert_eq!(
        moves_of(&dir, frame).len(),
        before,
        "the frame did not move"
    );
    // Beside its edges: its own x, 0.35 m beyond its half width.
    let edge = l.half_width + 350_000;
    let near = [spot(at, edge, false), spot(at, -edge, false)];
    for (k, p) in near.iter().enumerate() {
        souls[k].send("eden:walk", ground, point(*p)).await;
    }
    for s in souls.iter_mut() {
        s.answer().await.expect("walks beside its edge");
    }
    together(&dir, &bodies, &near, 60).await;
    souls[0]
        .act("part:take", carry, BTreeMap::from([(1, frame.to_value())]))
        .await
        .expect("taken from beside its edges");
    let h = word_that(&dir, carry, "taken", |h| h.phase == grips::CARRY).await;
    assert_eq!(h.holds.len(), 2, "each carrier holds its edge");
    // The take moved nothing in one step: the crew's node was first set where the frame stood (the frame in its slot
    // exactly there), then went into its carriers' hands, lifted 0.15 m, a sample a tick, none more than 0.1 m from
    // the last. Its holds are said when that track has ended (`souls:lifted`), so the track is whole by now.
    let track: Vec<Vec3> = effects(&dir)
        .into_iter()
        .filter_map(|e| match e.body {
            Body::Changes(cs) => cs.into_iter().find_map(|c| match c.change {
                Change::Motion(h) if h.node == carry => Some(h.pose.position),
                _ => None,
            }),
            _ => None,
        })
        .collect();
    let first = track.first().copied().expect("the crew's node was placed");
    println!(
        "the take's track: {} samples from ({}, {}, {}) mm to {:?}",
        track.len(),
        first.x / 1000,
        first.y / 1000,
        first.z / 1000,
        track.last()
    );
    assert!(
        (first.x - at.x).abs() <= 1_000
            && (first.z - at.z).abs() <= 1_000
            && first.y.abs() <= 1_000,
        "the node starts where the frame stood: {first:?}"
    );
    assert!(
        track.len() >= 12,
        "a track, not a step: {} samples",
        track.len()
    );
    assert!(
        track.windows(2).all(|p| {
            let d = |a: i64, b: i64| i128::from(a - b).pow(2);
            (d(p[0].x, p[1].x) + d(p[0].y, p[1].y) + d(p[0].z, p[1].z)).isqrt() <= 100_000
        }),
        "no sample more than 0.1 m from the last: {track:?}"
    );
    let last = track.last().copied().unwrap();
    assert!(
        (last.y - sim::activity::carry::STAND_LIFT).abs() <= 5_000,
        "in its carriers' hands, its foot 0.15 m up: {last:?}"
    );
    // Each carrier turned to face its hold (the back walked past the frame and stood with its back to it): its
    // body's own turn, as a turn toward the frame's middle would have it, within 2 s.
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let facing = facings(&dir);
        let toward = |k: usize| {
            let want = sim::controller::facing_toward(near[k], at).expect("a facing");
            let (a, b) = (
                want.rotate(Vec3::new(M, 0, 0)).unwrap(),
                facing[&bodies[k]].rotate(Vec3::new(M, 0, 0)).unwrap(),
            );
            (i128::from(a.x) * i128::from(b.x) + i128::from(a.z) * i128::from(b.z)) * 100
                / (i128::from(M) * i128::from(M))
        };
        let (f, b) = (toward(0), toward(1));
        if f >= 95 && b >= 95 {
            println!("each carrier faces the frame: {f} and {b} hundredths");
            break;
        }
        assert!(
            Instant::now() < end,
            "each carrier faces its hold: {f} and {b} hundredths of straight at it"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    drop(served);
}

/// When the log first holds a `souls:carry-track` word of `phase` for `carry`, and a `souls:carry-grips` word in the
/// carry phase: each its place among the log's events, in the order they were written.
fn said_at(dir: &Path, carry: Id, phase: &str) -> (Option<usize>, Option<usize>) {
    let mut at = (None, None);
    let all = effects(dir);
    for (k, ev) in all.iter().flat_map(|e| e.events.iter().flatten()).enumerate() {
        if ev.fields.get(&1) != Some(&carry.to_value()) {
            continue;
        }
        let third = match ev.fields.get(&3) {
            Some(Value::Text(t)) => t.as_str().to_owned(),
            _ => String::new(),
        };
        if ev.name.as_str() == "souls:carry-track" && third == phase && at.0.is_none() {
            at.0 = Some(k);
        }
        if ev.name.as_str() == grips::GRIPS && third == grips::CARRY && at.1.is_none() {
            at.1 = Some(k);
        }
    }
    at
}

/// How far the point `p` is from the segment `a`-`b` on the plan, µm.
fn off_segment(p: Vec3, a: Vec3, b: Vec3) -> i64 {
    let (ex, ez) = (i128::from(b.x - a.x), i128::from(b.z - a.z));
    let (px, pz) = (i128::from(p.x - a.x), i128::from(p.z - a.z));
    let len2 = (ex * ex + ez * ez).max(1);
    let t = (px * ex + pz * ez).clamp(0, len2);
    let (dx, dz) = (px - ex * t / len2, pz - ez * t / len2);
    (dx * dx + dz * dz).isqrt() as i64
}

/// #5067, the standing frame from take to put, by two Souls on a served world.
/// - **Strict reach at the take:** both stand a metre north of their places beside the frame's edges (as a walk that
///   stopped short leaves them). As the crew would hold the frame each is within reach, so the take was admitted and
///   the frame fetched a metre across the ground to them. Now it is refused `part.grip-out-of-reach`: each must reach
///   its hold where the frame is. Nothing is written.
/// - **Its own lift height:** taken from their places, the frame's foot is 0.15 m above their feet (not 1.05 m); its
///   hands are 0.85 m and 1.15 m up its posts, so 1.00 m and 1.30 m above the ground.
/// - **The hold is said when it is true:** `souls:carry-grips` in the carry phase comes after `souls:lifted`, never
///   with the take's commit.
/// - **Put down where the crew stands:** they carry it 3 m north, its foot still 0.15 m up; the back steps 0.3 m
///   toward the frame, so both stand where the frame would take the ground between them. A put at their middle is refused `site.occupied`; a put with no point is laid:
///   the world sets the frame down beside them, standing, turned as it was held, on ground clear of both.
#[tokio::test(flavor = "multi_thread")]
async fn grips_a_standing_frame_is_lifted_15_cm_held_once_lifted_and_put_down_where_its_crew_stands()
{
    let d = scratch("cstand");
    let facts = grips_world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
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
    let l = Load::of(&construction("rack_upright.json")).unwrap();
    let at = upright_at();
    let before = moves_of(&dir, frame).len();
    let edge = l.half_width + 350_000;
    let near = [spot(at, edge, false), spot(at, -edge, false)];
    // A metre north of their places: each 1.06 m from the edge it would hold, where the frame is.
    let short: Vec<Vec3> = near
        .iter()
        .map(|p| Vec3::new(p.x, 0, p.z + M))
        .collect();
    let carry = crew_at(&mut souls, &dir, ground, &bodies, &[0, 1], &short).await;
    let got = souls[0]
        .act("part:take", carry, BTreeMap::from([(1, frame.to_value())]))
        .await;
    said(&served);
    println!("taken from a metre short of their places: {got:?}");
    assert_eq!(got.map(|_| ()), Err("part.grip-out-of-reach".to_owned()));
    assert!(words(&dir, carry).is_empty(), "no holds said");
    assert_eq!(moves_of(&dir, frame).len(), before, "the frame did not move");
    // At their places beside its edges.
    for (k, p) in near.iter().enumerate() {
        souls[k].send("eden:walk", ground, point(*p)).await;
    }
    for s in souls.iter_mut() {
        s.answer().await.expect("walks beside its edge");
    }
    together(&dir, &bodies, &near, 60).await;
    souls[0]
        .act("part:take", carry, BTreeMap::from([(1, frame.to_value())]))
        .await
        .expect("taken from beside its edges");
    let h = word_that(&dir, carry, "taken", |h| h.phase == grips::CARRY).await;
    // Said when it is true: after the take's track ended.
    let (lifted, held) = said_at(&dir, carry, "souls:lifted");
    println!("souls:lifted is event {lifted:?}, the carry's holds event {held:?}");
    assert!(
        matches!((lifted, held), (Some(a), Some(b)) if a < b),
        "the holds are said after souls:lifted: {lifted:?}, {held:?}"
    );
    // Lifted 0.15 m: the crew's node (the frame's foot) above its carriers' feet.
    let node = |dir: &Path| {
        effects(dir)
            .into_iter()
            .filter_map(|e| match e.body {
                Body::Changes(cs) => cs.into_iter().find_map(|c| match c.change {
                    Change::Motion(h) if h.node == carry => Some(h.pose.position),
                    _ => None,
                }),
                _ => None,
            })
            .next_back()
            .expect("the crew's node has samples")
    };
    let up = node(&dir);
    assert!(
        (up.y - sim::activity::carry::STAND_LIFT).abs() <= 5_000,
        "its foot 0.15 m up: {up:?}"
    );
    // Its hands on its posts, 1.00 m and 1.30 m above the ground; each carrier within reach of them.
    let feet = stood(&dir);
    for hold in &h.holds {
        let ys: Vec<i64> = hold.hands.iter().map(|p| up.y + p.y).collect();
        assert!(
            (ys[0] - 1_000_000).abs() <= 5_000 && (ys[1] - 1_300_000).abs() <= 5_000,
            "{}: its hands {ys:?} µm above the ground",
            hold.grip
        );
        assert!(
            (hold.hands[0].x.abs() - l.half_width).abs() <= 40_000,
            "on its post's outer face: {:?}",
            hold.hands
        );
        let f = feet[&hold.body];
        let to = Vec3::new(up.x + hold.hands[0].x, 0, up.z + hold.hands[0].z);
        let off = off_segment(f, to, to);
        println!("{} stands {} mm from its hold", hold.grip, off / 1000);
        assert!(off <= sim::activity::carry::GRIP_REACH, "{off}");
    }
    // The front walks the crew 3 m north with the frame standing between them (to the walkers' ground a taken part
    // stays where it last rested until it is put down, so nobody steps toward it there).
    let north: Vec<Vec3> = near
        .iter()
        .map(|p| Vec3::new(p.x, 0, p.z + 3 * M))
        .collect();
    souls[0]
        .act("eden:walk", ground, point(north[0]))
        .await
        .expect("the front carries it north");
    together(&dir, &bodies, &north, 10).await;
    let carried = node(&dir);
    assert!(
        (carried.y - sim::activity::carry::STAND_LIFT).abs() <= 5_000,
        "carried with its foot 0.15 m up: {carried:?}"
    );
    // The back steps 0.3 m toward the frame: both now stand where the frame would take the ground between them.
    let step = Vec3::new(north[1].x + 300_000, 0, north[1].z);
    souls[1].send("eden:walk", ground, point(step)).await;
    let _ = souls[1].answer().await;
    let off = close_to(&dir, bodies[1], step, 80_000, 20).await;
    println!("the back stepped in to within {} mm of its new place", off / 1000);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mid = node(&dir);
    let at_middle = souls[0]
        .act(
            "part:put",
            carry,
            BTreeMap::from([
                (1, ground.to_value()),
                (3, point(Vec3::new(mid.x, 0, mid.z))[&1].clone()),
            ]),
        )
        .await;
    println!("put at the crew's middle: {at_middle:?}");
    assert_eq!(at_middle.map(|_| ()), Err("site.occupied".to_owned()));
    let moved = moves_of(&dir, frame).len();
    souls[0]
        .act("part:put", carry, BTreeMap::from([(1, ground.to_value())]))
        .await
        .expect("put down where the crew stands");
    let end = Instant::now() + Duration::from_secs(20);
    let laid = loop {
        let m = moves_of(&dir, frame);
        if m.len() > moved
            && let Some(p) = m.last().filter(|p| p.frame.node == ground)
        {
            break p.clone();
        }
        assert!(Instant::now() < end, "the frame was not put down");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    said(&served);
    let (p, o) = (laid.position, laid.orientation);
    let ax = o.rotate(Vec3::new(l.half_width, 0, 0)).unwrap();
    let (a, b) = (
        Vec3::new(p.x + ax.x, 0, p.z + ax.z),
        Vec3::new(p.x - ax.x, 0, p.z - ax.z),
    );
    let feet = stood(&dir);
    let clear: Vec<i64> = bodies.iter().map(|b2| off_segment(feet[b2], a, b)).collect();
    println!(
        "put down at ({}, {}, {}) mm, {} mm beside the crew's line; its carriers {:?} mm clear of it",
        p.x / 1000,
        p.y / 1000,
        p.z / 1000,
        (p.z - mid.z).abs() / 1000,
        clear.iter().map(|c| c / 1000).collect::<Vec<_>>()
    );
    assert!(p.y.abs() <= 2_000, "on the ground: {p:?}");
    assert_eq!(o.rotate(Vec3::new(0, M, 0)).unwrap().y, M, "standing");
    assert!(ax.z.abs() <= 20_000, "turned as it was held, its width along its carriers' line: {ax:?}");
    assert!(
        clear.iter().all(|c| *c >= 340_000),
        "each carrier stands clear of it: {clear:?} µm"
    );
    assert!(
        ((p.z - mid.z).abs() - 458_000).abs() <= 30_000 && (p.x - mid.x).abs() <= 30_000,
        "beside the crew, 0.46 m off their line: {p:?} from {mid:?}"
    );
    word_that(&dir, carry, "let go", |h| h.phase == grips::RELEASED).await;
    drop(served);
}

/// Each body's turn as the log's body rows last have it.
fn facings(dir: &Path) -> BTreeMap<Id, replica::pose::Quat> {
    let bytes = std::fs::read(dir.join("log")).unwrap_or_default();
    let mut at = BTreeMap::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        let Ok(p) = Part::read(&r) else { continue };
        if let Some(Value::Array(rows)) = p.rest.get(&answers::BODIES) {
            for (b, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                at.insert(b, pose.orientation);
            }
        }
    }
    at
}
