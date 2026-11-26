//! #5067: a lift and a set-down are short tracks of the carry's node, not a jump. In a served world by Souls' intents
//! through a real gateway: crews of two, four and six lift a rack beam, a timber (shade) rail and the 6.1 m frame and
//! set each down, and the log holds each track (one sample a tick, the world's `souls:carry-track` words at its start
//! and its end); a lift a carrier leaves mid-way ends by name and goes back down to where the load lay; and a lift cut
//! off by a restart is set down from where the node was, on the floor.
use super::*;

use replica::pose::Quat;

/// The world's tick, µs.
const TICK: i64 = 50_000;

/// One `souls:carry-track` word: when it was said, its phase, its track's times and why.
#[derive(Clone, Debug)]
struct Word {
    at: i64,
    phase: String,
    t0: i64,
    t1: i64,
    why: Option<String>,
}

/// The `souls:carry-track` words said of carry `activity`, in order.
fn words(dir: &Path, activity: Id) -> Vec<Word> {
    let text = |v: Option<&Value>| match v {
        Some(Value::Text(t)) => Some(t.as_str().to_owned()),
        _ => None,
    };
    let time = |v: Option<&Value>| match v {
        Some(Value::Uint(n)) => i64::try_from(*n).unwrap_or(-1),
        _ => -1,
    };
    effects(dir)
        .iter()
        .flat_map(|e| e.events.iter().flatten().map(move |ev| (e.envelope.at, ev)))
        .filter(|(_, ev)| {
            ev.name.as_str() == "souls:carry-track"
                && ev.fields.get(&1) == Some(&activity.to_value())
        })
        .map(|(at, ev)| Word {
            at,
            phase: text(ev.fields.get(&3)).unwrap_or_default(),
            t0: time(ev.fields.get(&4)),
            t1: time(ev.fields.get(&5)),
            why: text(ev.fields.get(&6)),
        })
        .collect()
}

/// The word of `phase` said of `activity` after `after` (µs), within `secs` seconds.
fn wait_word(dir: &Path, activity: Id, phase: &str, after: i64, secs: u64) -> Word {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(w) = words(dir, activity)
            .into_iter()
            .find(|w| w.phase == phase && w.at >= after)
        {
            return w;
        }
        assert!(Instant::now() < end, "no {phase} said of the carry");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Every motion sample of `node` in the log: when, and its pose.
fn samples(dir: &Path, node: Id) -> Vec<(i64, Pose)> {
    effects(dir)
        .iter()
        .filter_map(|e| match &e.body {
            Body::Changes(cs) => Some(cs),
            _ => None,
        })
        .flatten()
        .filter_map(|c| match &c.change {
            Change::Motion(h) if h.node == node => Some((h.at, h.pose)),
            _ => None,
        })
        .collect()
}

/// Where a rider of a node's slot is on the node's frame: the node at `node`, the rider at `rider` in the slot.
fn composed(node: &Pose, rider: &Pose) -> (Vec3, Quat) {
    let p = node.orientation.rotate(rider.position).unwrap();
    (
        Vec3::new(
            node.position.x + p.x,
            node.position.y + p.y,
            node.position.z + p.z,
        ),
        node.orientation.then(rider.orientation).unwrap(),
    )
}

/// How far apart two poses are: µm between their positions, and the most any part of their turns differs (2^30 is
/// one), the turns compared up to their sign.
fn apart_by(a: (Vec3, Quat), b: (Vec3, Quat)) -> (i64, i64) {
    let d = (i128::from(a.0.x - b.0.x).pow(2)
        + i128::from(a.0.y - b.0.y).pow(2)
        + i128::from(a.0.z - b.0.z).pow(2))
    .isqrt() as i64;
    let (p, q) = (a.1.parts(), b.1.parts());
    let same = (0..4).map(|i| (p[i] - q[i]).abs()).max().unwrap();
    let flip = (0..4).map(|i| (p[i] + q[i]).abs()).max().unwrap();
    (d, same.min(flip))
}

/// The lowest corner of a load of `entry`'s bounds (x and z about its origin, y from it up) at `pose`, µm.
fn lowest(entry: &json::Value, pose: (Vec3, Quat)) -> i64 {
    let b: Vec<i64> = entry
        .get("geometry")
        .and_then(|g| g.get("bounds_mm"))
        .and_then(json::Value::arr)
        .unwrap()
        .iter()
        .map(|v| match v {
            json::Value::Int(n) => *n as i64 * 1000,
            _ => panic!("a side"),
        })
        .collect();
    (0..8)
        .map(|k| {
            let s = |bit: i64, half: i64| if k & bit == 0 { half } else { -half };
            let y = if k & 2 == 0 { 0 } else { b[1] };
            let c = pose
                .1
                .rotate(Vec3::new(s(1, b[0] / 2), y, s(4, b[2] / 2)))
                .unwrap();
            pose.0.y + c.y
        })
        .min()
        .unwrap()
}

/// Where `load` lies on the floor now: its last change of parent's pose, else where the facts placed it.
fn lies(dir: &Path, facts: &str, load: Id) -> (Vec3, Quat) {
    if let Some(p) = moves_of(dir, load).last() {
        return (p.position, p.orientation);
    }
    let im = import_eden::load(facts).unwrap();
    let place = im
        .tree
        .node(im.tree.handle(load).unwrap())
        .unwrap()
        .place()
        .unwrap();
    (place.position, place.orientation)
}

/// The load's change of parent into carry `activity`'s slot: where it rides it.
fn held_in(dir: &Path, load: Id, activity: Id) -> Pose {
    *moves_of(dir, load)
        .iter()
        .rev()
        .find(|p| p.frame.node == activity)
        .expect("lifted into the carry's slot")
}

/// The samples of `node` after `t0` to `t1`, checked as one track begun at `t0`: one a tick, the last at `t1`, never a
/// step more than twice the even pace (no jump). Returns them.
fn one_track(name: &str, dir: &Path, node: Id, (t0, t1): (i64, i64)) -> Vec<(i64, Pose)> {
    let ss: Vec<(i64, Pose)> = samples(dir, node)
        .into_iter()
        .filter(|(at, _)| *at > t0 && *at <= t1)
        .collect();
    let ticks = (t1 - t0) / TICK;
    assert!(
        (12..=24).contains(&ticks) && (t1 - t0) % TICK == 0,
        "{name}: 0.6 s to 1.2 s in whole ticks: {} µs",
        t1 - t0
    );
    assert!(
        ss.windows(2).all(|w| w[1].0 - w[0].0 == TICK) && ss.len() as i64 == ticks,
        "{name}: a sample a tick"
    );
    assert_eq!(ss.last().map(|s| s.0), Some(t1), "{name}: its last at its end");
    let step = |a: &Pose, b: &Pose| {
        (i128::from(a.position.x - b.position.x).pow(2)
            + i128::from(a.position.y - b.position.y).pow(2)
            + i128::from(a.position.z - b.position.z).pow(2))
        .isqrt() as i64
    };
    let total: i64 = ss.windows(2).map(|w| step(&w[0].1, &w[1].1)).sum();
    let most = ss.windows(2).map(|w| step(&w[0].1, &w[1].1)).max().unwrap_or(0);
    println!(
        "{name}: {} samples over {} ms, {} mm in all, at most {} mm a tick",
        ss.len(),
        (t1 - t0) / 1000,
        total / 1000,
        most / 1000
    );
    assert!(
        most <= 2 * total / ticks + 5_000,
        "{name}: a step of {most} µm in a track of {total} µm"
    );
    ss
}

/// A lift of `load` by carry `activity` from where it lay at `lay`, read from the log and checked: the world said
/// `souls:lift` and `souls:lifted` with the track's times; the track's first sample holds the load exactly where it
/// lay; no sample takes a corner of it into the floor (y 0); its last is at carrying height between the carriers
/// (whose feet are on the floor). The track's times.
fn lifted(
    name: &str,
    dir: &Path,
    (activity, load): (Id, Id),
    entry: &json::Value,
    lay: (Vec3, Quat),
) -> (i64, i64) {
    let ws = words(dir, activity);
    let lift = ws.iter().find(|w| w.phase == "souls:lift").expect("souls:lift");
    let up = ws
        .iter()
        .find(|w| w.phase == "souls:lifted")
        .expect("souls:lifted");
    assert_eq!(lift.at, lift.t0, "{name}: said as the lift began");
    assert_eq!(
        (up.t0, up.t1, up.at),
        (lift.t0, lift.t1, lift.t1),
        "{name}: said as the lift ended, when it said it would"
    );
    let held = held_in(dir, load, activity);
    let start = samples(dir, activity)
        .into_iter()
        .find(|(at, _)| *at == lift.t0)
        .expect("the node's first sample at the lift")
        .1;
    let ss = one_track(&format!("{name}'s lift"), dir, activity, (lift.t0, lift.t1));
    let (d, q) = apart_by(composed(&start, &held), lay);
    println!("{name}: lifted from {d} µm (turn {q}) of where it lay");
    assert!(
        d <= 1_000 && q <= 1 << 16,
        "{name}: the lift starts where the load lay"
    );
    above_the_floor(name, entry, &ss, &held);
    let end = ss.last().unwrap().1.position.y;
    assert!(
        (end - sim::activity::carry::HEIGHT).abs() <= 60_000,
        "{name}: carried at carrying height: {end}"
    );
    (lift.t0, lift.t1)
}

/// A set-down of `load` of `entry` by carry `activity`, said after `after`, read from the log and checked: the world
/// said `souls:set-down` (why `why`, none for the crew's own) and `souls:released` with the track's times; the node went
/// down, a sample a tick, `straight` down keeping its turn (a set-down from carrying height; one from mid-lift goes
/// back along the lift's track); the load left the slot exactly where the track's last sample held it, and lies on the
/// floor, its lowest corner at y 0. Where it rests.
fn set_down(
    name: &str,
    dir: &Path,
    activity: Id,
    load: Id,
    entry: &json::Value,
    after: i64,
    why: Option<&str>,
    straight: bool,
) -> (Vec3, Quat) {
    let ws = words(dir, activity);
    let down = ws
        .iter()
        .find(|w| w.phase == "souls:set-down" && w.at >= after)
        .expect("souls:set-down");
    let rest = ws
        .iter()
        .find(|w| w.phase == "souls:released" && w.at >= after)
        .expect("souls:released");
    assert_eq!(down.why.as_deref(), why, "{name}: why");
    assert_eq!(
        (rest.t0, rest.t1, rest.at),
        (down.t0, down.t1, down.t1),
        "{name}: released as the set-down ended, when it said it would"
    );
    let ss = one_track(&format!("{name}'s set-down"), dir, activity, (down.t0, down.t1));
    let before = samples(dir, activity)
        .into_iter()
        .rfind(|(at, _)| *at <= down.t0)
        .expect("a sample before")
        .1;
    for (_, p) in ss.iter().filter(|_| straight) {
        assert_eq!(
            (p.position.x, p.position.z),
            (before.position.x, before.position.z),
            "{name}: straight down"
        );
        assert_eq!(p.orientation, before.orientation, "{name}: its turn kept");
    }
    assert!(
        !straight
            || ss
                .windows(2)
                .all(|w| w[1].1.position.y <= w[0].1.position.y),
        "{name}: only down"
    );
    let held = held_in(dir, load, activity);
    above_the_floor(name, entry, &ss, &held);
    let last = moves_of(dir, load).last().copied().expect("set down");
    let at = (last.position, last.orientation);
    let (d, q) = apart_by(composed(&ss.last().unwrap().1, &held), at);
    let low = lowest(entry, at);
    println!("{name}: released {d} µm (turn {q}) from where the track held it, its lowest corner at y {low} µm");
    assert!(
        d <= 1_000 && q <= 1 << 16,
        "{name}: no jump at the release"
    );
    assert!(low.abs() <= 2_000, "{name}: on the floor, not in it: {low}");
    at
}

/// No sample of a track takes a corner of the load riding at `held` into the floor (y 0).
fn above_the_floor(name: &str, entry: &json::Value, ss: &[(i64, Pose)], held: &Pose) {
    let low = ss
        .iter()
        .map(|(_, p)| lowest(entry, composed(p, held)))
        .min()
        .unwrap();
    println!("{name}: the load's lowest corner on its track at y {low} µm");
    assert!(low >= -2_000, "{name}: a corner through the floor: {low}");
}

/// The crew `crew` (its first the front, then the back, then its sides) walks to `places`, the front offers the carry
/// to the rest and each accepts. The carry.
async fn crewed(crew: &mut [Soul], dir: &Path, ground: Id, places: &[Vec3]) -> Id {
    for (s, p) in crew.iter_mut().zip(places) {
        s.send("eden:walk", ground, point(*p)).await;
    }
    for s in crew.iter_mut() {
        s.answer().await.expect("walks to its place");
    }
    let bodies: Vec<Id> = crew.iter().map(|s| body_of(dir, s.id)).collect();
    together(dir, &bodies, places, 60).await;
    let others: Vec<Value> = bodies[1..].iter().map(|b| b.to_value()).collect();
    let offered = crew[0]
        .act(
            "activity:offer",
            ground,
            BTreeMap::from([
                (1, carry_kind(dir)),
                (2, Value::Text(Name::new(FRONT).unwrap())),
                (3, Value::Array(others)),
            ]),
        )
        .await
        .expect("the carry offered");
    let carry = carry_made(dir, &offered);
    for s in crew[1..].iter_mut() {
        s.act("activity:accept", carry, BTreeMap::new())
            .await
            .expect("accepts");
    }
    carry
}

/// Where a crew of `n` stands at a load lying along z with its middle at `at`: the front at its north end, the back
/// at its south end, its sides at its grips between (across is −x, as the carry's frame has it heading north).
fn north_places(at: Vec3, load: &Load, n: usize) -> Vec<Vec3> {
    let [back, front] = load.places();
    let mut p = vec![spot(at, front, true), spot(at, back, true)];
    p.extend(
        load.side_places()
            .into_iter()
            .take(n - 2)
            .map(|[along, across]| Vec3::new(at.x - across, 0, at.z + along)),
    );
    p
}

/// The timber rail lying loose along z, east of the yard and north of the beams' line.
fn rail_at() -> Vec3 {
    Vec3::new(56 * M, 0, -17 * M)
}

/// [`tall_world`] with the 6.1 m frame's six grips, and a timber rail (the shade's, `content/kinds/carpentry/`) lying
/// loose at [`rail_at`].
fn hoist_world(d: &Path) -> String {
    let facts = tall_world(d);
    six_grips(d);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    std::fs::copy(
        root.join("carpentry/timber_rail.json"),
        d.join("entries").join("timber_rail.json"),
    )
    .unwrap();
    let mut f = json::parse(&facts).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    let num = |v: i64| json::Value::Int(i128::from(v));
    let r = "testworld-timber-rail@1";
    let at = rail_at();
    for (k, v) in top.iter_mut() {
        match (k.as_str(), v) {
            ("kinds", json::Value::Arr(a)) => a.push(json::Value::Obj(vec![
                ("ref".into(), json::Value::s(r)),
                (
                    "hash".into(),
                    json::Value::s(&replica::encode::to_hex(&replica::ids::sha256(
                        format!("souls/testworld/{r}").as_bytes(),
                    ))),
                ),
                ("name".into(), json::Value::s("mars:timber_rail")),
                ("form".into(), json::Value::s("point")),
            ])),
            ("things", json::Value::Arr(a)) => a.push(json::Value::Obj(vec![
                ("id".into(), json::Value::s("loose-rail")),
                ("def".into(), json::Value::s(r)),
                ("ref".into(), json::Value::s(r)),
                ("parent".into(), json::Value::Null),
                (
                    "pose".into(),
                    json::Value::Arr([at.x / 1000, 0, at.z / 1000, 0].map(num).to_vec()),
                ),
                ("scale_ppm".into(), num(1_000_000)),
                ("name".into(), json::Value::s("a loose timber rail")),
            ])),
            _ => {}
        }
    }
    f.to_json()
}

/// The crew lifts `load` where it lies, waits for the lift's end, sets it down there and waits for its rest; then
/// every one leaves.
async fn lift_and_set_down(crew: &mut [Soul], dir: &Path, carry: Id, load: Id) {
    crew[0]
        .act("carry:lift", carry, BTreeMap::from([(1, load.to_value())]))
        .await
        .expect("lifted");
    wait_word(dir, carry, "souls:lifted", 0, 20);
    crew[1]
        .act("carry:set-down", carry, BTreeMap::new())
        .await
        .expect("set down");
    wait_word(dir, carry, "souls:released", 0, 20);
    for s in crew.iter_mut() {
        s.act("activity:leave", carry, BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }
}

/// Crews of two, four and six each lift a load where it lies and set it down there: the rack beam by two, the timber
/// rail by four (its four grips) and the 6.1 m frame, standing, by six (its six grips; laid flat as it is lifted, so its
/// turn changes along the track). Each lift and each set-down is a track in the log, said at its start and its end.
#[tokio::test(flavor = "multi_thread")]
async fn hoist_crews_of_two_four_and_six_lift_and_set_down_on_tracks() {
    let d = scratch("choist");
    let facts = hoist_world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 6);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam, rail, tall) = (
        im.nodes["ground"],
        im.nodes["yard-beam-4"],
        im.nodes["loose-rail"],
        im.nodes["tall-upright"],
    );
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut crew = Vec::new();
    for (s, t) in souls.iter().zip(&tokens) {
        crew.push(Soul::connect(&url, *s, lineage, t).await);
    }
    let tall_entry = json::parse(
        &std::fs::read_to_string(d.join("entries").join("rack_upright_6m.json")).unwrap(),
    )
    .unwrap();
    let rail_entry = json::parse(
        &std::fs::read_to_string(d.join("entries").join("timber_rail.json")).unwrap(),
    )
    .unwrap();
    let beam_entry = construction("rack_beam.json");
    let loads = [
        ("two, the rack beam", 2, beam, beam_entry, beam_at(), true),
        ("four, the timber rail", 4, rail, rail_entry, rail_at(), true),
        ("six, the 6.1 m frame", 6, tall, tall_entry, upright_at(), false),
    ];
    for (name, n, load, entry, at, north) in loads {
        let l = Load::of(&entry).unwrap();
        let places = match north {
            true => north_places(at, &l, n),
            false => crew_places(at, &l, n),
        };
        let lay = lies(&dir, &facts, load);
        let carry = crewed(&mut crew[..n], &dir, ground, &places).await;
        lift_and_set_down(&mut crew[..n], &dir, carry, load).await;
        let (t0, t1) = lifted(name, &dir, (carry, load), &entry, lay);
        let rest = set_down(name, &dir, carry, load, &entry, t1, None, true);
        let m = rest.1.rotate(l.middle).unwrap();
        println!(
            "{name}: lifted {t0}..{t1} µs; rests with its middle at ({}, {}) mm",
            (rest.0.x + m.x) / 1000,
            (rest.0.z + m.z) / 1000
        );
    }
    drop(served);
    assert!(broke(&dir).is_empty(), "nothing broke off: {:?}", broke(&dir));
    println!(
        "#5067: crews of two, four and six lifted and set down the rack beam, the timber rail and the 6.1 m frame, \
         each lift and set-down a track of the carry's node, a sample a tick, said at its start and its end"
    );
}

/// `worldd serve` again on the world's folder `dir` (a restart), on `socket`.
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

/// Two lift the rack beam and the back lets go mid-lift: the lift's track ends by name (`souls:lift-cancelled`,
/// `souls:partner-left`) and the beam goes back down its track to exactly where it lay. Then the two lift it again and
/// the world is stopped mid-lift: started again, it sets the beam down from where the node was
/// (`souls:world-restarted`), straight down, onto the floor.
#[tokio::test(flavor = "multi_thread")]
async fn hoist_a_lift_let_go_mid_way_and_one_cut_off_by_a_restart_end_at_rest() {
    let d = scratch("choistx");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam) = (im.nodes["ground"], im.nodes["yard-beam-4"]);
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut a = Soul::connect(&url, souls[0], lineage, &tokens[0]).await;
    let mut b = Soul::connect(&url, souls[1], lineage, &tokens[1]).await;
    let entry = construction("rack_beam.json");

    // The back lets go as soon as the lift is answered, well inside its 0.6 s or more.
    let lay = lies(&dir, &facts, beam);
    let carry = gather(&mut a, &mut b, &dir, ground, beam, &entry, beam_at(), true).await;
    a.act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("lifted");
    b.act("activity:leave", carry, BTreeMap::new())
        .await
        .expect("the back lets go mid-lift");
    let rel = wait_word(&dir, carry, "souls:released", 0, 20);
    let ws = words(&dir, carry);
    println!("let go: {ws:?}");
    let lift = ws.iter().find(|w| w.phase == "souls:lift").unwrap();
    let cut = ws
        .iter()
        .find(|w| w.phase == "souls:lift-cancelled")
        .expect("the lift ended by name");
    assert_eq!(cut.why.as_deref(), Some("souls:partner-left"));
    assert!(cut.t1 < lift.t1, "ended before its end: {cut:?} {lift:?}");
    assert!(
        !ws.iter().any(|w| w.phase == "souls:lifted"),
        "never lifted all the way"
    );
    let back = set_down(
        "let go",
        &dir,
        carry,
        beam,
        &entry,
        cut.at,
        Some("souls:partner-left"),
        false,
    );
    // The set-down from mid-lift goes back along the lift's track: not straight down from where the carriers were.
    let (dd, dq) = apart_by(back, lay);
    println!("let go: the beam rests {dd} µm (turn {dq}) from where it lay; released at {} µs", rel.at);
    assert!(dd <= 1_000 && dq <= 1 << 16, "back where it lay");
    assert_eq!(broke(&dir), vec!["souls:partner-left".to_owned()]);
    a.act("activity:leave", carry, BTreeMap::new())
        .await
        .expect("the front leaves");

    // A restart mid-lift.
    let lay = lies(&dir, &facts, beam);
    let carry = gather(&mut a, &mut b, &dir, ground, beam, &entry, beam_at(), true).await;
    a.act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("lifted");
    drop(served);
    let ws = words(&dir, carry);
    assert!(
        ws.iter().any(|w| w.phase == "souls:lift")
            && !ws.iter().any(|w| w.phase == "souls:lifted"),
        "stopped mid-lift: {ws:?}"
    );
    let last = *samples(&dir, carry).last().expect("a sample of the lift");
    let held = held_in(&dir, beam, carry);
    let (dd, _) = apart_by(composed(&samples(&dir, carry)[0].1, &held), lay);
    assert!(dd <= 1_000, "the lift started where the beam lay");
    println!(
        "restart: stopped with the node at y {} µm, {} samples into the lift",
        last.1.position.y,
        samples(&dir, carry).len()
    );
    let socket = d.join("t");
    let again = serve_again(&dir, &socket);
    again.line("listening ", 180);
    wait_word(&dir, carry, "souls:released", last.0 + 1, 30);
    let rest = set_down(
        "restart",
        &dir,
        carry,
        beam,
        &entry,
        last.0 + 1,
        Some("souls:world-restarted"),
        true,
    );
    let first = samples(&dir, carry)
        .into_iter()
        .find(|(at, _)| *at > last.0)
        .expect("a sample after the restart")
        .1;
    assert_eq!(
        (first.position.x, first.position.z),
        (last.1.position.x, last.1.position.z),
        "set down from where the node was"
    );
    drop(again);
    println!(
        "#5067: a lift let go mid-way ended by name and went back to where the beam lay; a lift cut off by a restart \
         was set down from where the node was, straight down to the floor, at y {} µm",
        lowest(&entry, rest)
    );
}
