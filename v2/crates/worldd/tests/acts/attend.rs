//! 0.135 E14b: a slot of another thing through the gateway. A served hall world: the hall's lecture
//! (`content/kinds/hall/lecture.json`) and Eden's gathering lecture (`content/kinds/gathering/lecture.json`) stand
//! between two benches (`content/kinds/seating/bench.json`) set the same distance from them, each bench's two seats
//! registered as the world's places. A Soul attends the hall's lecture on a bench seat it names as `[bench id, slot
//! number]` and gets a receipt; one whose leave comes mid-sit is answered `left` and ends free, standing, its seat
//! free. The gathering lecture's `attend` selects its seat from the free slots `in` its `parent`: a Soul nearer one
//! bench is given that bench's nearest free seat; one standing as near both is refused `arg-ambiguous`, by name.
use super::*;

const HALL_LECTURE: &str = "eden:hall_lecture";
const LECTURE: &str = "eden:lecture";
const BENCH: &str = "eden:bench";
/// The gathering lecture's `running` field (its entry's state).
const RUNNING: u64 = 28;

fn hall_lecture() -> Id {
    id(40)
}
fn lecture() -> Id {
    id(41)
}
/// The bench west of the lectures and the one east, mirrored about them.
fn west_bench() -> Id {
    id(42)
}
fn east_bench() -> Id {
    id(43)
}
/// Both lectures 5 m north of the first walker, each bench 1.5 m west or east of them and 2 m nearer the walkers.
fn lectures_at() -> Vec3 {
    Vec3::new(at1().x, 0, at1().z + 5_000_000)
}
fn bench_at(east: bool) -> Vec3 {
    let dx = if east { 1_500_000 } else { -1_500_000 };
    Vec3::new(at1().x + dx, 0, at1().z + 3_000_000)
}

fn pinned(kind: &str) -> String {
    let n = match kind {
        HALL_LECTURE => 0x40,
        LECTURE => 0x41,
        _ => 0x42,
    };
    full(kind, n)
}

fn entry(kind: &str) -> Json {
    parse(match kind {
        HALL_LECTURE => include_str!("../../../../../content/kinds/hall/lecture.json"),
        LECTURE => include_str!("../../../../../content/kinds/gathering/lecture.json"),
        _ => include_str!("../../../../../content/kinds/seating/bench.json"),
    })
    .unwrap()
}

/// The furniture: (node, kind, where, fields).
fn furniture() -> Vec<(Id, &'static str, Vec3, BTreeMap<u64, Value>)> {
    vec![
        (hall_lecture(), HALL_LECTURE, lectures_at(), BTreeMap::new()),
        (
            lecture(),
            LECTURE,
            lectures_at(),
            BTreeMap::from([(RUNNING, Value::Uint(1))]),
        ),
        (west_bench(), BENCH, bench_at(false), BTreeMap::new()),
        (east_bench(), BENCH, bench_at(true), BTreeMap::new()),
    ]
}

/// The header with the furniture's kinds pinned too.
fn hall_header(old: &Replica) -> Header {
    let mut hv = match decode(old.header().stored()).unwrap().value {
        Value::Map(m) => m,
        _ => unreachable!(),
    };
    let Some(Value::Array(kinds)) = hv.get_mut(&6) else {
        unreachable!()
    };
    for kind in [HALL_LECTURE, LECTURE, BENCH] {
        kinds.push(Value::Text(name(&pinned(kind))));
    }
    Header::read(&encode(&Value::Map(hv)).unwrap()).unwrap()
}

/// The furniture's creates, numbered from `next`, as one part under `header`.
fn furniture_part(header: &Header, next: u64, zone: Id) -> Part {
    let effects = furniture()
        .into_iter()
        .enumerate()
        .map(|(k, (node, kind, position, fields))| {
            Effect {
                envelope: Envelope {
                    sequence: next + k as u64,
                    at: 0,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node: zone,
                },
                body: Body::Changes(vec![ChangeRec {
                    change: Change::Create {
                        node,
                        kind: name(&pinned(kind)),
                        pose: Pose {
                            frame: Frame {
                                node: zone,
                                slot: None,
                            },
                            position,
                            orientation: Quat::IDENTITY,
                            support: Support::Surface {
                                surface: zone,
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
        })
        .collect();
    Part::read(
        &encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(header.hash().to_bytes())),
            (2, Value::Array(effects)),
        ])))
        .unwrap(),
    )
    .unwrap()
}

/// The two walkers on the town with the furniture in it, and each bench's seats as places: `left` (slot 1) and
/// `right` (slot 2) 465 mm up and 400 mm either side of its middle, each stood at 554 mm in front of it.
fn hall_bodies() -> Result<Bodies, replica::effects::Refusal> {
    let (mut base, ground) = town();
    let header = hall_header(&world());
    let part = furniture_part(&header, base.tree.next(), ground);
    base.tree.apply(&header, &part)?;
    base.doors.header = header;
    base.doors.next = base.tree.next();
    let town = Town::new(base.tree, ground, base.doors).expect("the town with the hall's furniture");
    let planner = town.copy().expect("an independent planner town");
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let p1 = town.surfaces[&ground].place(w1(), frame, at1(), Quat::IDENTITY)?;
    let p2 = town.surfaces[&ground].place(w2(), frame, at2(), Quat::IDENTITY)?;
    let mut b = Bodies::with_planner(town, planner, 50_000)?;
    b.add_body(humanoid(), p1)?;
    b.add_body(humanoid(), p2)?;
    for bench in [west_bench(), east_bench()] {
        let at = bench_at(bench == east_bench());
        for (slot, dx) in [(1, -400_000), (2, 400_000)] {
            let place = replica::moves::Place::from_value(
                &decode(&replica::effects::fixture_bytes(&format!(
                    "{{1: {slot}, 2: 465, 3: [0, 554]}}"
                ))?)
                .unwrap()
                .value,
            )?;
            b.add_place(sim::slots::PlaceAt {
                thing: bench,
                place,
                point: Vec3::new(at.x + dx, 465_000, at.z + 20_000),
                facing: Quat::IDENTITY,
                floor: ground,
            })?;
        }
    }
    Ok(b)
}

/// The hall world started, served on a socket unless `lockstep` (then driven by [`answers::Event`]s).
fn hall(tag: &str, lockstep: bool) -> (answers::World, Mem, Replica, std::path::PathBuf) {
    let old = world();
    let header = hall_header(&old);
    let mut initial = Replica::restored(header.clone(), old.tree().frozen(), old.version());
    initial
        .apply(&furniture_part(&header, initial.version(), ground()))
        .unwrap();
    let mut rules = tree_rules();
    for kind in [HALL_LECTURE, LECTURE, BENCH] {
        let slots = if kind == BENCH {
            BTreeMap::from([
                (1, BTreeSet::from(["body".to_owned()])),
                (2, BTreeSet::from(["body".to_owned()])),
            ])
        } else {
            BTreeMap::from([(1, BTreeSet::from(["body".to_owned()]))])
        };
        rules.kinds.insert(
            pinned(kind),
            Kind {
                owner: "thing".into(),
                children: BTreeSet::new(),
                slots,
                hands: None,
                fields: Default::default(),
            },
        );
    }
    let store = Mem::default();
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.lockstep = lockstep;
    cfg.bodies = Some(Box::new(|_| hall_bodies()));
    cfg.engine = Some((rules, Vec::new()));
    let mut kinds = entries();
    let Json::Obj(loaded) = &mut kinds else {
        unreachable!()
    };
    for kind in [HALL_LECTURE, LECTURE, BENCH] {
        loaded.push((kind.into(), entry(kind)));
    }
    let world = answers::start(
        initial.frozen(),
        Rules {
            kinds,
            moves: Json::Obj(Vec::new()),
        },
        store.clone(),
        cfg,
    )
    .expect("the hall world starts");
    let path = std::env::temp_dir().join(format!("e14b-{tag}-{}.sock", std::process::id()));
    (world, store, initial, path)
}

fn replay(initial: &Replica, store: &Mem) -> Replica {
    let mut r = initial.frozen();
    for rec in recover(&store.0.lock().unwrap().bytes).unwrap().records {
        if !sim::recorder::is_input(&rec) {
            let p = Part::read(&rec).unwrap();
            if !p.effects.is_empty() {
                r.apply(&p).expect("the log replays");
            }
        }
    }
    r
}

/// A seat of another thing on the wire: `[id, slot number]`.
fn seat(on: Id, slot: u64) -> BTreeMap<u64, Value> {
    let pair = Value::Array(vec![
        Value::Bytes(b"seat".to_vec()),
        Value::Array(vec![on.to_value(), Value::Uint(slot)]),
    ]);
    BTreeMap::from([(1, Value::Array(vec![pair]))])
}

/// The listeners linked to a lecture.
fn listeners(r: &Replica, of: Id) -> usize {
    r.tree()
        .links_at(of)
        .iter()
        .filter(|e| r.tree().ty(e).as_str().ends_with("listener"))
        .count()
}

#[test]
fn e14b_a_soul_attends_the_halls_lecture_on_a_bench_seat_through_the_gateway() {
    let (world, store, initial, path) = hall("served", false);
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, stream));
        }
    });
    let client = |soul| {
        let s = UnixStream::connect(&path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        Client(s, soul, 0, Vec::new())
    };
    let (mut a, mut b) = (client(w1()), client(w2()));

    // Standing as near one bench as the other, and the lecture as far from both: the world cannot choose.
    let ambiguous = a.act("eden:attend", Some(lecture()), BTreeMap::new());
    println!("E14b gathering attend, seat left out, on the axis: {ambiguous:?}");
    assert_eq!(ambiguous, Err("arg-ambiguous".to_owned()));

    // Nearer the west bench: its nearest free seat, `left`.
    let picked = b.act("eden:attend", Some(lecture()), BTreeMap::new());
    println!("E14b gathering attend, seat left out, west of the axis: {picked:?}");
    assert!(picked.is_ok(), "attended: {picked:?}");
    let r = replay(&initial, &store);
    println!("E14b w2 in {:?}", parent(&r, w2()));
    assert_eq!(parent(&r, w2()), (Some(west_bench()), Some(1)));
    assert_eq!(listeners(&r, lecture()), 1);

    // The hall's lecture, its seat named: the east bench's `left`, slot 1. A seat another holds is refused by name.
    let taken = a.act("eden:attend", Some(hall_lecture()), seat(west_bench(), 1));
    println!("E14b hall attend on a held seat: {taken:?}");
    assert_eq!(taken, Err("place-taken".to_owned()));
    let attended = a.act("eden:attend", Some(hall_lecture()), seat(east_bench(), 1));
    println!("E14b hall attend on the east bench's left: {attended:?}");
    assert!(attended.is_ok(), "a receipt: {attended:?}");
    let r = replay(&initial, &store);
    assert_eq!(parent(&r, w1()), (Some(east_bench()), Some(1)));
    assert_eq!(listeners(&r, hall_lecture()), 1);

    // Its leave gives the seat back.
    let left = a.act("eden:leave", Some(hall_lecture()), BTreeMap::new());
    println!("E14b hall leave: {left:?}");
    assert!(left.is_ok(), "left: {left:?}");
    let r = replay(&initial, &store);
    assert_eq!(parent(&r, w1()).0, Some(ground()), "standing again");
    assert_eq!(listeners(&r, hall_lecture()), 0);
    world.stop();
    let _ = std::fs::remove_file(&path);
}

/// Soul `soul`'s `souls:cancel` (#3705) of its own act `replaces`: how its agent stops what it is doing.
fn cancel_bytes(soul: Id, sequence: u64, replaces: u64) -> Vec<u8> {
    let i = Intent {
        actor: Actor::Soul(soul),
        verb: name("souls:cancel"),
        target: None,
        parameters: BTreeMap::new(),
        sequence,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: answers::now() + 60_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: Some(replaces),
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// A lockstep run of the hall world: w1's attend on the east bench's `left` arrives at tick 1 and, when `leave_at`
/// says, its cancel of the attend arrives then (the Soul leaves). Returns the attend's and the walk's final answers, the
/// first tick w1 was in the seat, who is seated at the end, and the replayed world.
type Lock = (
    Result<Vec<u64>, String>,
    Option<Result<Vec<u64>, String>>,
    Option<i64>,
    Vec<(Id, Id)>,
    Replica,
);

fn attend_in_lockstep(leave_at: Option<i64>, then_leave: Option<i64>) -> Lock {
    let (world, store, initial, _) = hall("lockstep", true);
    let (attend, walk) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
    world
        .events
        .send(answers::Event::ArrivalAt {
            tick: 1,
            bytes: intent_bytes(
                w1(),
                1,
                "eden:attend",
                Some(hall_lecture()),
                seat(east_bench(), 1),
            ),
            reply: attend.0,
        })
        .unwrap();
    if let Some(t) = leave_at {
        world
            .events
            .send(answers::Event::ArrivalAt {
                tick: t,
                bytes: cancel_bytes(w1(), 2, 1),
                reply: walk.0,
            })
            .unwrap();
    }
    let left = std::sync::mpsc::channel();
    if let Some(t) = then_leave {
        world
            .events
            .send(answers::Event::ArrivalAt {
                tick: t,
                bytes: intent_bytes(w1(), 3, "eden:leave", Some(hall_lecture()), BTreeMap::new()),
                reply: left.0,
            })
            .unwrap();
    }
    let mut first_seated = None;
    let mut seated = Vec::new();
    for tick in 1..=600 {
        let (done, ran) = std::sync::mpsc::channel();
        world
            .events
            .send(answers::Event::RunTo { tick, done })
            .unwrap();
        let ran = ran.recv().unwrap();
        if first_seated.is_none() && ran.seated.iter().any(|(b, _)| *b == w1()) {
            first_seated = Some(tick);
        }
        seated = ran.seated;
    }
    let final_of = |rx: &std::sync::mpsc::Receiver<Vec<u8>>| {
        rx.try_iter()
            .filter(|f| answers::progress_of(f).is_none())
            .map(|f| answer_in(&f).1)
            .next()
    };
    if then_leave.is_some() {
        let l = final_of(&left.1);
        println!("E14b the lecture's leave after: {l:?}");
        assert!(matches!(l, Some(Ok(_))), "the leave's receipt: {l:?}");
    }
    let out = (
        final_of(&attend.1).expect("the attend's answer"),
        final_of(&walk.1),
        first_seated,
        seated,
        replay(&initial, &store),
    );
    world.stop();
    out
}

#[test]
fn e14b_a_soul_that_leaves_mid_sit_is_free() {
    let (done, _, seated_at, seated, r) = attend_in_lockstep(None, None);
    println!("E14b lockstep attend: {done:?}, in the seat from tick {seated_at:?}, seated {seated:?}");
    assert!(done.is_ok(), "a receipt: {done:?}");
    let seated_at = seated_at.expect("the body was handed into the seat");
    assert_eq!(seated, vec![(w1(), east_bench())]);
    assert_eq!(listeners(&r, hall_lecture()), 1);
    // The Soul's cancel arrives in the sit before its contact: the attend ends, the body is taken out onto the
    // seat's stand point, nothing of it landed.
    let (attend, cancel, _, seated, r) = attend_in_lockstep(Some(seated_at - 2), None);
    println!(
        "E14b leave before the contact: attend {attend:?}, cancel {cancel:?}, seated {seated:?}, listeners {}, w1 in {:?} at {:?}",
        listeners(&r, hall_lecture()),
        parent(&r, w1()),
        super::at(&r, w1())
    );
    assert_eq!(attend, Err("act.stopped".to_owned()), "the attend is stopped");
    assert!(matches!(cancel, Some(Ok(_))), "the cancel's receipt: {cancel:?}");
    assert!(seated.is_empty(), "no one holds a seat");
    assert_eq!(parent(&r, w1()), (Some(ground()), None), "standing, free");
    assert_eq!(listeners(&r, hall_lecture()), 0, "not in the audience");
    // Just after the contact: what landed there stays (the seat and the audience, as a hand move's effect does,
    // 0.134 I4), and the lecture's own leave frees the seat.
    let (attend, cancel, _, seated, r) = attend_in_lockstep(Some(seated_at + 1), Some(seated_at + 100));
    println!(
        "E14b leave after the contact: attend {attend:?}, cancel {cancel:?}, seated {seated:?}, listeners {}, w1 in {:?}",
        listeners(&r, hall_lecture()),
        parent(&r, w1()),
    );
    assert!(matches!(cancel, Some(Ok(_))), "the cancel's receipt: {cancel:?}");
    assert!(seated.is_empty(), "no one holds a seat");
    assert_eq!(parent(&r, w1()), (Some(ground()), None), "standing, free");
    assert_eq!(listeners(&r, hall_lecture()), 0, "not in the audience");
}
