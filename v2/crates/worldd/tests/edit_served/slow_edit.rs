//! #5216: a few-op creator's edit in Eden that took 7 to 10 s to check, with every edit behind it waiting on the
//! checker's one thread. The edit is the one sent to live Eden on 27 Nov
//! (`worlds/patches/eden-2026-live-last-unreachable-20261127`): the vineyard villa tower turned a quarter turn, the
//! house-2 counter moved across its kitchen, the commons deck's floor removed (ground cover) and its podium placed
//! again on the open ground.
use super::*;

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
    for (k, &body) in w.souls.iter().enumerate().take(20) {
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
    said(
        &format!("the edit ({which})"),
        &got,
        took,
        &edit_check(&w, n),
    );
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
}
