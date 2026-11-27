//! #5216: a few-op creator's edit in Eden that took 7 to 10 s to check, with every edit behind it waiting on the
//! checker's one thread. The edit is the one sent to live Eden on 27 Nov
//! (`worlds/patches/eden-2026-live-last-unreachable-20261127`): the vineyard villa tower turned a quarter turn, the
//! house-2 counter moved across its kitchen, the commons deck's floor removed (ground cover) and its podium placed
//! again on the open ground.
//!
//! - **The cause**: the deck was left with no floor, and no rebuild read such a thing alone, so the whole of Eden's
//!   ground was built again inside the plan's guard. It is cut alone now (`sim::walk::town`), and the test here holds
//!   the work, not the time: the squares cut again and the buildings read again, from the checker's gauge
//!   (`edit_check` in `health.json`).
//! - **The line**: the checker's thread takes at most 8 edits at once; one sent past that is refused
//!   `edit.checker-busy` at once, never left to time out.
use super::*;

/// The facts `text` with a deck as Eden's commons deck is exported: a thing of one floor with no room, 3 m by 2 m from
/// (x, z) m, 0.24 m up (above a step, so a floor of its own and no ground cover).
fn with_deck(text: &str, (x, z): (i64, i64)) -> String {
    let (x0, z0, x1, z1) = (x * 1000, z * 1000, x * 1000 + 3000, z * 1000 + 2000);
    let area = format!("[[{x0}, {z0}], [{x1}, {z0}], [{x1}, {z1}], [{x0}, {z1}]]");
    let mut facts = json::parse(text).unwrap();
    let json::Value::Obj(top) = &mut facts else {
        panic!("facts")
    };
    for (k, v) in top.iter_mut() {
        match (k.as_str(), v) {
            ("kinds", json::Value::Arr(a)) => a.push(
                json::parse(&format!(
                    r#"{{"ref": "core-deck@1", "hash": "{}", "name": "core:deck", "form": "area", "layer": "surface",
                        "door": false, "mesh": false, "slots": 0}}"#,
                    replica::encode::to_hex(&replica::ids::sha256(b"souls/testworld/core-deck@1"))
                ))
                .unwrap(),
            ),
            ("things", json::Value::Arr(a)) => a.push(
                json::parse(&format!(
                    r#"{{"id": "fixture-deck", "def": "core-deck@1", "ref": "core-deck@1", "parent": null,
                        "pose": [0, 0, 0, 0], "world": [0, 0, 0, 0], "scale_ppm": 1000000, "name": "a deck",
                        "worldShape": true, "shape": {{"area": {area}}},
                        "floors": [{{"level": 0, "y": 240, "polygon": {area}, "tag": "deck", "abs": true}}]}}"#
                ))
                .unwrap(),
            ),
            _ => {}
        }
    }
    facts.to_json()
}

/// A whole number of the gauge at `path`.
fn gauge(e: &json::Value, path: &[&str]) -> i128 {
    match path.iter().try_fold(e, |v, k| v.get(k)) {
        Some(json::Value::Int(n)) => *n,
        other => panic!("{path:?} of {}: {other:?}", e.to_json()),
    }
}

/// The edit's ground was cut alone: not the whole, and at most `squares` of the open ground's squares.
fn cut_alone(e: &json::Value, squares: i128) {
    assert_eq!(
        e.get("last_ground").and_then(|g| g.get("whole")),
        Some(&json::Value::Bool(false)),
        "the edit's ground is cut alone, not built whole: {}",
        e.to_json()
    );
    let cut = gauge(e, &["last_ground", "squares"]);
    assert!(
        (1..=squares).contains(&cut),
        "at most {squares} squares cut again: {}",
        e.to_json()
    );
    assert_eq!(gauge(e, &["whole", "count"]), 0, "{}", e.to_json());
}

/// #5216 A4, the slow case held by its work: on N2's test world with a deck like Eden's, the creator removes the
/// deck's one floor and places a thing where it stood, in one edit, as the 27 Nov edit did. The checker cuts again
/// the deck's own squares and reads one building (the deck, a building no longer); the whole ground is never built.
#[tokio::test(flavor = "multi_thread")]
async fn i5216_a_decks_floor_removed_is_checked_on_its_own_squares_not_the_whole_ground() {
    let base = testworld::generate(1, 0).unwrap().text;
    let (x0, z0) = clear_row(&base);
    let text = with_deck(&base, (x0 + 4, z0 + 3));
    let im = import_eden::load(&text).unwrap();
    let d = scratch("i5216-deck");
    let w = seed(&d, &text, 1, (x0, z0));
    let (c, creator) = creator(0xc0);
    static_creator(&w, c);
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    // A wall far along the row first: its receipt has the world's version, which the edit is planned against.
    let far = wall(&w, (x0 + 40) * M, (z0 + 2) * M);
    let (got, _) = send(&mut ws, edit_intent(&w, creator, 1, 0, far)).await;
    assert_eq!(got.kind, 1, "a wall commits: {got:?}");
    let ops = vec![
        wall(&w, (x0 + 5) * M, (z0 + 4) * M),
        Op::Remove {
            node: Ref::Node(im.nodes["fixture-deck/floor-0"]),
        },
    ];
    let (got, _) = send(
        &mut ws,
        edit_batch_intent(&w, creator, 2, got.version, ops),
    )
    .await;
    assert_eq!(got.kind, 1, "the edit commits: {got:?}");
    let e = edit_check(&w, 2);
    println!("#5216 the deck's floor removed: edit_check {}", e.to_json());
    // The deck is 3 m by 2 m: with a body's clearance it lies on one square of 16 m, or up to four at a corner.
    cut_alone(&e, 4);
    assert_eq!(
        gauge(&e, &["last_ground", "buildings"]),
        1,
        "{}",
        e.to_json()
    );
    // The town the checker keeps took it: the next edit beside it is cut alone too.
    let beside = wall(&w, (x0 + 9) * M, (z0 + 4) * M);
    let (got, _) = send(&mut ws, edit_intent(&w, creator, 3, got.version, beside)).await;
    assert_eq!(got.kind, 1, "a wall beside it commits: {got:?}");
    cut_alone(&edit_check(&w, 3), 4);
}

/// #5216 A3: the checker's thread takes at most 8 edits at once. 40 edits sent in one write: the first 8 are checked
/// (the first commits; the others, planned against the version before it, are refused `edit.stale` as any edit
/// planned on an older world is), and one sent while 8 wait is refused `edit.checker-busy` at once (never
/// `act.timed-out` after 10 s); the gauge counts them, and once the line is empty the next edit commits.
#[tokio::test(flavor = "multi_thread")]
async fn i5216_edits_past_the_checkers_line_are_refused_by_name_and_the_next_commits() {
    let text = testworld::generate(1, 0).unwrap().text;
    let (x0, z0) = clear_row(&text);
    let d = scratch("i5216-line");
    let w = seed(&d, &text, 1, (x0, z0));
    let (c, creator) = creator(0xc0);
    static_creator(&w, c);
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 60);
    let mut link = connect_socket(&socket);
    link.set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    let mut burst = Vec::new();
    for k in 0..40i64 {
        let (x, z) = ((x0 + 2 + 2 * (k % 20)) * M, (z0 + 2 + 4 * (k / 20)) * M);
        let bytes = edit_intent(&w, creator, 1 + k as u64, 0, wall(&w, x, z));
        burst.extend(u32::try_from(bytes.len()).unwrap().to_be_bytes());
        burst.extend(bytes);
    }
    let sent = Instant::now();
    link.write_all(&burst).unwrap();
    let mut ends: BTreeMap<String, usize> = BTreeMap::new();
    for _ in 0..40 {
        let got = socket_end(&mut link);
        let name = if got.kind == 1 {
            "receipt".to_owned()
        } else {
            got.reason
        };
        *ends.entry(name).or_default() += 1;
    }
    println!(
        "#5216 40 edits in one write: {ends:?} in {:?}",
        sent.elapsed()
    );
    let busy = ends.get("edit.checker-busy").copied().unwrap_or(0);
    assert!(
        busy >= 1,
        "edits past the line are refused by name: {ends:?}"
    );
    assert!(ends.get("receipt").copied().unwrap_or(0) >= 1, "{ends:?}");
    assert!(
        !ends.contains_key("act.timed-out"),
        "none timed out: {ends:?}"
    );
    // Every edit not refused at the line was checked: the gauge has both, and the line's limit.
    let e = edit_check(&w, 40 - busy as i128);
    println!("#5216 the gauge: {}", e.to_json());
    assert_eq!(
        gauge(&e, &["refused_busy"]),
        busy as i128,
        "{}",
        e.to_json()
    );
    assert_eq!(gauge(&e, &["most"]), 8, "{}", e.to_json());
    assert_eq!(gauge(&e, &["waiting"]), 0, "{}", e.to_json());
    // The line is empty again: the next edit is taken and commits.
    let bytes = edit_intent(&w, creator, 41, 0, wall(&w, (x0 + 44) * M, (z0 + 2) * M));
    link.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .unwrap();
    link.write_all(&bytes).unwrap();
    let got = socket_end(&mut link);
    assert_eq!(got.kind, 1, "the next edit commits: {got:?}");
}


/// The checker's gauge (`edit_check` in the world's `health.json`) once it has checked `n` edits: the last edit's
/// stages, µs, by name, and its other numbers.
fn edit_check(w: &Seeded, n: i128) -> json::Value {
    let end = Instant::now() + Duration::from_secs(30);
    loop {
        let h = std::fs::read_to_string(w.dir.join("health.json"))
            .ok()
            .and_then(|t| json::parse(&t).ok());
        if let Some(e) = h.as_ref().and_then(|h| h.get("edit_check"))
            && matches!(e.get("checked"), Some(json::Value::Int(c)) if *c >= n)
        {
            return e.clone();
        }
        assert!(Instant::now() < end, "health.json's edit_check reaches {n}");
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// The 27 Nov edit's operations on Eden as the facts file gives it, by the facts' ids: `which` picks them (`tower`,
/// `counter`, `deck`: the floor's removal and the podium placed again), all of them when empty.
fn slow_ops(im: &import_eden::Import, ground: Id, which: &str) -> Vec<Op> {
    let t = &im.tree;
    let node = |key: &str| t.node(t.handle(im.nodes[key]).unwrap()).unwrap();
    let spot = |key: &str| {
        let n = node(key);
        let p = n.place().expect("placed");
        Spot {
            slot: n.slot(),
            position: p.position,
            orientation: p.orientation,
            support: p.support,
        }
    };
    let on = |name: &str| which.is_empty() || which.split(',').any(|w| w == name);
    let mut ops = Vec::new();
    if on("tower") {
        let mut at = spot("e_181709e7");
        at.orientation = Quat::from_yaw_mdeg(90_000).unwrap();
        ops.push(Op::Move {
            node: Ref::Node(im.nodes["e_181709e7"]),
            at,
        });
    }
    if on("counter") {
        let mut at = spot("e_d2e89ac5");
        at.position.z = -at.position.z;
        at.orientation = Quat::from_yaw_mdeg(180_000).unwrap();
        ops.push(Op::Move {
            node: Ref::Node(im.nodes["e_d2e89ac5"]),
            at,
        });
    }
    if on("deck") {
        let podium = node("e_01496dba");
        ops.push(Op::Place {
            name: 1,
            kind: podium.kind().clone(),
            parent: Ref::Node(ground),
            at: Spot {
                slot: None,
                position: Vec3::new(9 * M, 200_000, -2 * M),
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: ground,
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields: podium.fields().clone(),
        });
        ops.push(Op::Remove {
            node: Ref::Node(im.nodes["e_07683d40/floor-0"]),
        });
    }
    ops
}

/// A measurement (#5216 A1): the edit's time by stage on Eden as the facts file gives it (`EDEN_FACTS`; run with
/// `--release`), beside 20 walkers, with a small edit before and after it for comparison. `SLOW_EDIT_OPS` picks the
/// operations (`tower`, `counter`, `deck`, comma separated; all when unset).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "a measurement: needs the exported Eden facts file (EDEN_FACTS)"]
async fn i5216_the_27_nov_edit_on_eden_by_stage() {
    let text = std::fs::read_to_string(std::env::var("EDEN_FACTS").expect("EDEN_FACTS")).unwrap();
    let which = std::env::var("SLOW_EDIT_OPS").unwrap_or_default();
    let (x0, z0) = clear_row(&text);
    let im = import_eden::load(&text).unwrap();
    let d = scratch("i5216-eden");
    let w = seed(&d, &text, 21, (x0, z0));
    let (c, creator) = creator(0xc0);
    static_creator(&w, c);
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 300);
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let mut souls = connect_socket(&socket);
    let walkers: usize = std::env::var("SLOW_EDIT_WALKERS")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(20);
    for (k, &body) in w.souls.iter().enumerate().take(walkers) {
        walk(&mut souls, &w, body, 1, (x0 + 2 * k as i64) * M, (z0 + 8) * M);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let said = |what: &str, got: &Got, took: Duration, e: &json::Value| {
        println!(
            "#5216 {what}: kind {} {} {} in {} ms; edit_check {}",
            got.kind,
            got.reason,
            got.detail,
            took.as_millis(),
            e.to_json()
        );
    };
    let mut version = 0;
    let mut n = 0;
    for k in 0..3 {
        let (x, z) = ((x0 + 44 + 2 * k) * M, z0 * M);
        let (got, took) = send(
            &mut ws,
            edit_intent(&w, creator, 1 + k as u64, version, wall(&w, x, z)),
        )
        .await;
        n += 1;
        said("a wall before", &got, took, &edit_check(&w, n));
        version = got.version;
    }
    let ops = slow_ops(&im, w.ground, &which);
    let (got, took) = send(&mut ws, edit_batch_intent(&w, creator, 10, version, ops)).await;
    n += 1;
    let e = edit_check(&w, n);
    said(&format!("the edit ({which})"), &got, took, &e);
    // Held by its work, whatever the machine: Eden's open ground is thousands of squares.
    if got.kind == 1 {
        cut_alone(&e, 64);
    }
    version = got.version;
    for k in 0..3 {
        let (x, z) = ((x0 + 44 + 2 * k) * M, (z0 + 2) * M);
        let (got, took) = send(
            &mut ws,
            edit_intent(&w, creator, 11 + k as u64, version, wall(&w, x, z)),
        )
        .await;
        n += 1;
        said("a wall after", &got, took, &edit_check(&w, n));
        version = got.version;
    }
    println!(
        "#5216 health: {}",
        std::fs::read_to_string(w.dir.join("health.json")).unwrap()
    );
}
