//! #4072 (E1b): the body's base forms run on any thing. A joined Soul's body is `souls:body`, which has no entry; the
//! world's one family entry (`content/kinds/body/humanoid.json`) is given to it by replica's `family_forms`, as
//! `worldd serve` does at start. On a thing whose entry is a card and no forms (a `base` row of Eden's map):
//!
//! - A2: `go_to`, `look_at`, `point`, `touch`, `wait_by` and `lean_on` sent to the body with the thing as argument are
//!   accepted and end done; the walking ones end within reach of the thing, `lean_on` sets posture `lean`, and `touch`
//!   from a seated body is refused by its need.
//! - A3: a walk to a thing drawn at its frame's origin (a footpath's line) ends within reach of its line, not at the
//!   origin.
//! - #4072 follow-up: a walk to a thing whose entry gives bounds (a 6 m bench) ends by its outline, not at its middle;
//!   a `touch` after one is in reach; a `go_to` on a walkable thing (a mat, its entry an area) ends on it.
use super::*;

const HUMANOID: &str = include_str!("../../../../../content/kinds/body/humanoid.json");

/// A thing with a card and no forms, 3 m east and 2 m south of the first birth's spot.
fn base() -> Id {
    id(20)
}
fn base_at() -> Vec3 {
    let s = first_spot();
    Vec3::new(s.x + 3_000_000, 0, s.z + 2_000_000)
}
/// A footpath drawn in the ground's frame: at its origin, its line 4 m north of the first birth's spot, 10 m long.
fn path() -> Id {
    id(21)
}
fn path_z() -> i64 {
    first_spot().z - 4_000_000
}
fn path_x() -> [i64; 2] {
    let s = first_spot();
    [s.x - 5_000_000, s.x + 5_000_000]
}

/// A bench 6 m long along x and 0.9 m deep, its entry's bounds (`test:bench`, by its field 27), 6 m west and 3 m
/// south of the first birth's spot: no form's walk from there ends near its middle by its outline.
fn bench() -> Id {
    id(22)
}
fn bench_at() -> Vec3 {
    let s = first_spot();
    Vec3::new(s.x - 6_000_000, 0, s.z + 3_000_000)
}
fn bench_ring() -> [Vec3; 4] {
    let (m, x, z) = (bench_at(), 3_000_000, 450_000);
    [(-x, -z), (x, -z), (x, z), (-x, z)].map(|(u, v)| Vec3::new(m.x + u, 0, m.z + v))
}
/// A mat 3 m by 2 m (`test:mat`: an area, so walkable), 2 m east and 6 m south of the first birth's spot.
fn mat() -> Id {
    id(23)
}
fn mat_at() -> Vec3 {
    let s = first_spot();
    Vec3::new(s.x + 2_000_000, 0, s.z + 6_000_000)
}
fn mat_ring() -> [Vec3; 4] {
    let (m, x, z) = (mat_at(), 1_500_000, 1_000_000);
    [(-x, -z), (x, -z), (x, z), (-x, z)].map(|(u, v)| Vec3::new(m.x + u, 0, m.z + v))
}

/// The entries: the family's, a card for the things (the rack's kind), the bench's and the mat's, the body given the
/// family's by the rule.
fn base_entries() -> Json {
    let card = r#"{ "format": "souls-entry/1", "kind": "test:rack", "owner": "thing",
      "text": { "card": "A thing with a card and no forms of its own." }, "card": { "text": "card" } }"#;
    let bench = r#"{ "format": "souls-entry/1", "kind": "test:bench", "owner": "thing",
      "geometry": { "bounds_mm": [6000, 800, 900] },
      "text": { "card": "A long bench." }, "card": { "text": "card" } }"#;
    let mat = r#"{ "format": "souls-entry/1", "kind": "test:mat", "owner": "thing",
      "geometry": { "bounds_mm": [3000, 20, 2000] }, "areas": { "top": { "allows": { "sit": "on" } } },
      "text": { "card": "A mat to stand on." }, "card": { "text": "card" } }"#;
    let mut kinds = vec![
        ("eden:humanoid".to_owned(), parse(HUMANOID).unwrap()),
        (RACK.to_owned(), parse(card).unwrap()),
        ("test:bench".to_owned(), parse(bench).unwrap()),
        ("test:mat".to_owned(), parse(mat).unwrap()),
    ];
    assert!(replica::kinds::entry::family_forms(&mut kinds, BODY));
    Json::Obj(kinds)
}

fn create_with(sequence: u64, node: Id, at: Vec3, fields: BTreeMap<u64, Value>) -> Value {
    let g = ground();
    Effect {
        envelope: Envelope {
            sequence,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: g,
        },
        body: Body::Changes(vec![ChangeRec {
            change: Change::Create {
                node,
                kind: name(&fullname(RACK)),
                pose: Pose {
                    frame: Frame {
                        node: g,
                        slot: None,
                    },
                    position: at,
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: g,
                        height: 0,
                    },
                },
                audience: Audience::Everyone,
                fields,
            },
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    }
    .to_value()
}

/// A thing's entry by its field 27, as a world's map names one (`import_eden::entry_name`).
fn entry_field(entry: &str) -> BTreeMap<u64, Value> {
    BTreeMap::from([(import_eden::F_ENTRY, Value::Text(name(entry)))])
}

/// The world as built, with the base thing, the footpath, the bench and the mat.
fn base_world() -> Replica {
    let mut r = world();
    let mm = |v: i64| {
        let v = v / 1000;
        if v < 0 {
            Value::Nint((-1 - v) as u64)
        } else {
            Value::Uint(v as u64)
        }
    };
    let [x0, x1] = path_x();
    let line = Value::Array(
        [x0, x1]
            .iter()
            .map(|x| Value::Array(vec![mm(*x), mm(path_z())]))
            .collect(),
    );
    let effects = vec![
        create_with(2, base(), base_at(), BTreeMap::new()),
        create_with(
            3,
            path(),
            Vec3::ZERO,
            BTreeMap::from([(import_eden::F_LINE, line)]),
        ),
        create_with(4, bench(), bench_at(), entry_field("test:bench")),
        create_with(5, mat(), mat_at(), entry_field("test:mat")),
    ];
    let part = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(header(ground()).hash().to_bytes())),
        (2, Value::Array(effects)),
    ])))
    .unwrap();
    r.apply(&Part::read(&part).unwrap())
        .expect("the base thing and the footpath");
    r
}

/// The harness's humanoid with the eyes `worldd serve`'s has: a look claims the gaze.
fn eyed() -> Family {
    let mut f = humanoid();
    f.resources.push(Resource {
        name: name("souls:eyes"),
        class: Class::Gaze,
        slot: None,
    });
    f
}

fn serve_base(tag: &str) -> (Run, Client) {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    cfg.engine = Some((tree_rules(), vec![pair_kind()]));
    cfg.join = Some(Join {
        entry: (ground(), entry()),
        family: eyed(),
        kind: name(&fullname(BODY)),
        per_tick: 8,
    });
    let rules = Rules {
        kinds: base_entries(),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(base_world(), rules, store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("e1b-{tag}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, stream));
        }
    });
    let s = UnixStream::connect(&path).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    (Run { world, store, path }, Client(s, ada(), 0))
}

/// The world as of now: [`base_world`] with every logged part applied.
fn replay(run: &Run) -> Replica {
    let mut r = base_world();
    for p in run.log() {
        if !p.effects.is_empty() {
            r.apply(&p).expect("the log replays");
        }
    }
    r
}

/// The body born for `soul`, by its `souls:body-of` link.
fn body_of(run: &Run, soul: Id) -> Option<Id> {
    let r = replay(run);
    let t = r.tree();
    t.links_at(soul)
        .iter()
        .filter(|e| t.ty(e).as_str() == "souls:body-of")
        .find_map(|e| Some(t.link(e.link)?.1[0]))
}

/// The body's last logged place on the ground, µm.
fn last_at(run: &Run, body: Id) -> Vec3 {
    run.log()
        .iter()
        .rev()
        .find_map(|p| match p.rest.get(&answers::BODIES) {
            Some(Value::Array(rows)) => rows
                .iter()
                .rev()
                .filter_map(worldd::bodies::read_row)
                .find(|(b, _, _)| *b == body)
                .map(|(_, pose, _)| pose.position),
            _ => None,
        })
        .expect("the body's row")
}

fn flat(a: Vec3, b: Vec3) -> i64 {
    let (dx, dz) = (i128::from(a.x - b.x), i128::from(a.z - b.z));
    i64::try_from((dx * dx + dz * dz).isqrt()).unwrap()
}

/// One thing argument, as the client sends it.
fn thing(arg: &str, t: Id) -> BTreeMap<u64, Value> {
    BTreeMap::from([(
        1,
        Value::Array(vec![Value::Array(vec![
            Value::Bytes(arg.as_bytes().to_vec()),
            t.to_value(),
        ])]),
    )])
}

/// Within a walk's reach of the thing, and a little over for where the route ends.
const WITHIN: i64 = skills::form_runner::REACH + 100_000;

#[test]
fn e1b_a2_a3_base_forms_run_on_a_thing_with_a_card_and_no_forms() {
    let (run, mut a) = serve_base("a2");
    a.act(JOIN, None, BTreeMap::new()).expect("Ada joins");
    let body = body_of(&run, ada()).expect("born");
    let posture = |run: &Run| {
        let r = replay(run);
        let t = r.tree();
        t.node(t.handle(body).unwrap())
            .unwrap()
            .fields()
            .get(&28)
            .cloned()
    };
    // A3: the footpath first, from the birth 4 m south of its line: on its line, never at the ground's origin.
    let to_path = |a: &mut Client, run: &Run, why: &str| {
        let r = a.act("eden:go_to", Some(body), thing("place", path()));
        println!("E1b go_to footpath ({why}): {r:?}");
        r.expect("walked to the footpath");
        let at = last_at(run, body);
        let [x0, x1] = path_x();
        let on = Vec3::new(at.x.clamp(x0, x1), 0, path_z());
        println!("  at {at:?}, {} µm from its line", flat(at, on));
        assert!(flat(at, on) <= WITHIN, "within reach of the line: {at:?}");
        assert!(flat(at, Vec3::ZERO) > 30_000_000, "not at the origin");
    };
    to_path(&mut a, &run, "A3");
    for (form, arg, walks) in [
        ("go_to", "place", true),
        ("look_at", "target", false),
        ("point", "toward", false),
        ("touch", "target", true),
        ("wait_by", "place", true),
        ("lean_on", "support", true),
    ] {
        if walks {
            to_path(&mut a, &run, "away");
        }
        let from = last_at(&run, body);
        let r = a.act(&format!("eden:{form}"), Some(body), thing(arg, base()));
        let at = last_at(&run, body);
        println!(
            "E1b {form}: {r:?}, from {} µm to {} µm of the thing",
            flat(from, base_at()),
            flat(at, base_at())
        );
        assert!(!r.expect("accepted and done").is_empty(), "{form}");
        if walks {
            assert!(flat(at, base_at()) <= WITHIN, "{form} ends within reach");
        }
    }
    let leaning = posture(&run);
    println!("E1b posture after lean_on: {leaning:?}");
    assert!(
        matches!(&leaning, Some(Value::Text(n)) if n.as_str().ends_with(":lean")),
        "lean_on sets posture lean"
    );
    // Seated on the thing (the family's sit_down, the thing as its spot), a touch is refused by its need.
    let sat = a.act("eden:sit_down", Some(body), thing("spot", base()));
    println!("E1b sit_down: {sat:?}, posture {:?}", posture(&run));
    sat.expect("sat");
    let touched = a.act("eden:touch", Some(body), thing("target", base()));
    println!("E1b touch while seated: {touched:?}");
    assert_eq!(
        touched,
        Err("field_differs".to_owned()),
        "refused by its need"
    );
    run.stop();
}

#[test]
fn a_walk_to_a_bounded_thing_ends_by_its_outline_and_on_a_walkable_one() {
    use sim::spots::to_outline;
    let (run, mut a) = serve_base("fp");
    a.act(JOIN, None, BTreeMap::new()).expect("Ada joins");
    let body = body_of(&run, ada()).expect("born");
    // How near a walk comes to its end.
    let slack = skills::route::AT_GOAL + 100_000;
    let go = |a: &mut Client, form: &str, arg: &str, t: Id| {
        let r = a.act(&format!("eden:{form}"), Some(body), thing(arg, t));
        let at = last_at(&run, body);
        println!("footprint {form}: {r:?}, at {at:?}");
        assert!(!r.expect("accepted and done").is_empty(), "{form}");
        at
    };
    // go_to: by the bench's outline, at its near end, not its middle (where the walk went before).
    let at = go(&mut a, "go_to", "place", bench());
    let (gap, mid) = (to_outline(at, &bench_ring()), flat(at, bench_at()));
    println!("  go_to bench: {gap} µm from its outline, {mid} µm from its middle");
    assert!(gap <= slack, "by its outline: {at:?}");
    assert!(mid >= 2_000_000, "not at its middle: {at:?}");
    // touch, from away: the walk ends within the touch's own reach, so the touch is done.
    go(&mut a, "go_to", "place", base());
    let at = go(&mut a, "touch", "target", bench());
    let gap = to_outline(at, &bench_ring());
    println!("  touch bench: {gap} µm from its outline");
    assert!(gap <= 600_000 + slack, "within a touch of it: {at:?}");
    go(&mut a, "go_to", "place", base());
    go(&mut a, "lean_on", "support", bench());
    // go_to the mat: on it.
    let at = go(&mut a, "go_to", "place", mat());
    println!(
        "  go_to mat: {} µm from its outline",
        to_outline(at, &mat_ring())
    );
    assert_eq!(to_outline(at, &mat_ring()), 0, "on the mat: {at:?}");
    run.stop();
}
