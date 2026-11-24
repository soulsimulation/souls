//! 0.135 E14b: a slot of another thing through the gateway. A served hall world: the hall's lecture
//! (`content/kinds/hall/lecture.json`) and Eden's gathering lecture (`content/kinds/gathering/lecture.json`) stand
//! between two benches (`content/kinds/seating/bench.json`) set the same distance from them, each bench's two seats
//! registered as the world's places. A Soul attends the hall's lecture on a bench seat it names as `[bench id, slot
//! number]` and gets a receipt. Its cancel before the sit's contact is answered `act.stopped` and it ends free,
//! standing, its seat free; after the contact it is answered `act.stopped-still-seated`, seated and listening until
//! it leaves; a listener who rises instead leaves the audience too. The gathering lecture's `attend` selects its seat
//! from the free slots `in` its `parent`, never a private one: a Soul nearer one bench is given that bench's nearest
//! free seat; one standing as near both is refused `arg-ambiguous`, by name. A private bench, another Soul's body and
//! an undeclared slot are refused by name.
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
/// A bench private to the second walker's Soul, 6 m south of the first walker: further from the lectures than
/// either other bench, so never the one they pick.
fn private_bench() -> Id {
    id(44)
}
fn private_at() -> Vec3 {
    south(6_000_000)
}
/// A bench private to a third Soul, 1 m behind the lectures: nearer them than any other, so the gathering lecture's
/// pick passes over it only because it is private.
fn near_private_bench() -> Id {
    id(45)
}
fn near_private_at() -> Vec3 {
    Vec3::new(lectures_at().x, 0, lectures_at().z + 1_000_000)
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
        (
            private_bench(),
            BENCH,
            private_at(),
            BTreeMap::from([
                (replica::who_may::F_OWNER, w2().to_value()),
                (replica::who_may::F_ACCESS, Value::Uint(2)),
            ]),
        ),
        (
            near_private_bench(),
            BENCH,
            near_private_at(),
            BTreeMap::from([
                (replica::who_may::F_OWNER, id(99).to_value()),
                (replica::who_may::F_ACCESS, Value::Uint(2)),
            ]),
        ),
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
    let town =
        Town::new(base.tree, ground, base.doors).expect("the town with the hall's furniture");
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
    for (bench, at) in [
        (west_bench(), bench_at(false)),
        (east_bench(), bench_at(true)),
        (private_bench(), private_at()),
        (near_private_bench(), near_private_at()),
    ] {
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
    hall_on(tag, lockstep, Mem::default())
}

/// [`hall`] on the log `store` holds: a world started again after a stop reads it back.
fn hall_on(
    tag: &str,
    lockstep: bool,
    store: Mem,
) -> (answers::World, Mem, Replica, std::path::PathBuf) {
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

    // The bench nearest the lecture is private to someone else, so never chosen: of the other two, standing as near
    // one as the other, and the lecture as far from both, the world cannot choose.
    let ambiguous = a.act("eden:attend", Some(lecture()), BTreeMap::new());
    println!("E14b gathering attend, seat left out, on the axis: {ambiguous:?}");
    assert_eq!(ambiguous, Err("arg-ambiguous".to_owned()));

    // Nearer the west bench: its nearest free seat, `left` (not the nearer private bench's).
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
    // E14's review: another thing's slot is refused through the gateway when that thing is private to another Soul,
    // is another Soul's body, or has no such slot; nothing is taken.
    for (on, slot, why) in [
        (private_bench(), 1, "object.private"),
        (w2(), 1, "slot-of-a-body"),
        (west_bench(), 3, "slot-unknown"),
    ] {
        let got = a.act("eden:attend", Some(hall_lecture()), seat(on, slot));
        println!(
            "E14b hall attend on slot {slot} of {}: {got:?}",
            replica::world_model::show(on)
        );
        assert_eq!(got, Err(why.to_owned()));
    }
    let r = replay(&initial, &store);
    assert_eq!(parent(&r, w1()), (Some(ground()), None), "nothing taken");
    assert_eq!(
        parent(&r, w2()),
        (Some(west_bench()), Some(1)),
        "w2 where it sat"
    );
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

/// A lockstep run of the hall world: w1's attend on the east bench's `left` arrives at tick 1, then each of `then`
/// (its tick and its intent's bytes). Returns the attend's final answer, each other intent's, the first tick w1 was
/// in the seat, who is seated at the end, and the replayed world.
type Lock = (
    Result<Vec<u64>, String>,
    Vec<Option<Result<Vec<u64>, String>>>,
    Option<i64>,
    Vec<(Id, Id)>,
    Replica,
);

fn attend_in_lockstep(then: &[(i64, Vec<u8>)]) -> Lock {
    let (world, store, initial, _) = hall("lockstep", true);
    let attend = std::sync::mpsc::channel();
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
    let mut replies = Vec::new();
    for (tick, bytes) in then {
        let (tx, rx) = std::sync::mpsc::channel();
        world
            .events
            .send(answers::Event::ArrivalAt {
                tick: *tick,
                bytes: bytes.clone(),
                reply: tx,
            })
            .unwrap();
        replies.push(rx);
    }
    let mut first_seated = None;
    let mut seated = Vec::new();
    let last = then.iter().map(|(t, _)| *t).max().unwrap_or(0) + 400;
    for tick in 1..=last.max(600) {
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
    let out = (
        final_of(&attend.1).expect("the attend's answer"),
        replies.iter().map(final_of).collect(),
        first_seated,
        seated,
        replay(&initial, &store),
    );
    world.stop();
    out
}

#[test]
fn e14b_a_soul_that_leaves_mid_sit_is_free() {
    let (done, _, seated_at, seated, r) = attend_in_lockstep(&[]);
    println!(
        "E14b lockstep attend: {done:?}, in the seat from tick {seated_at:?}, seated {seated:?}"
    );
    assert!(done.is_ok(), "a receipt: {done:?}");
    let seated_at = seated_at.expect("the body was handed into the seat");
    assert_eq!(seated, vec![(w1(), east_bench())]);
    assert_eq!(listeners(&r, hall_lecture()), 1);
    let rise = || intent_bytes(w1(), 3, "eden:rise", None, BTreeMap::new());
    let leave = || intent_bytes(w1(), 3, "eden:leave", Some(hall_lecture()), BTreeMap::new());
    let walk = |n| {
        intent_bytes(
            w1(),
            n,
            "eden:walk",
            Some(ground()),
            point(south(2_000_000)),
        )
    };
    let free = |r: &Replica, seated: &[(Id, Id)], what: &str| {
        assert!(seated.is_empty(), "{what}: no one holds a seat");
        assert_eq!(
            parent(r, w1()),
            (Some(ground()), None),
            "{what}: standing, free"
        );
        assert_eq!(
            listeners(r, hall_lecture()),
            0,
            "{what}: not in the audience"
        );
    };
    let show = |what: &str,
                attend: &Result<Vec<u64>, String>,
                then: &[Option<Result<Vec<u64>, String>>],
                r: &Replica| {
        println!(
            "E14b {what}: attend {attend:?}, then {then:?}, listeners {}, w1 in {:?} at {:?}",
            listeners(r, hall_lecture()),
            parent(r, w1()),
            super::at(r, w1())
        );
    };

    // The Soul's cancel in the sit before its contact: the attend ends, the body is taken out onto the seat's stand
    // point, nothing of it landed.
    let (attend, then, _, seated, r) =
        attend_in_lockstep(&[(seated_at - 2, cancel_bytes(w1(), 2, 1))]);
    show("cancel before the contact", &attend, &then, &r);
    assert_eq!(attend, Err("act.stopped".to_owned()));
    assert!(matches!(then[0], Some(Ok(_))), "the cancel's receipt");
    free(&r, &seated, "cancel before the contact");

    // Just after the contact the seat and the audience have landed: the answer says the Soul is still seated (it is,
    // and listening), and the lecture's `leave` then frees it.
    let (attend, then, _, seated, r) =
        attend_in_lockstep(&[(seated_at + 1, cancel_bytes(w1(), 2, 1))]);
    show("cancel after the contact", &attend, &then, &r);
    assert_eq!(attend, Err(worldd::acts::STILL_SEATED.to_owned()));
    assert_eq!(seated, vec![(w1(), east_bench())], "still seated");
    assert_eq!(listeners(&r, hall_lecture()), 1, "still listening");
    let (_, then, _, seated, r) = attend_in_lockstep(&[
        (seated_at + 1, cancel_bytes(w1(), 2, 1)),
        (seated_at + 100, leave()),
    ]);
    assert!(
        matches!(then[1], Some(Ok(_))),
        "the leave's receipt: {then:?}"
    );
    free(&r, &seated, "cancel after the contact, then leave");

    // A listener who rises, or rises and walks off, instead of leaving the lecture is no longer in its audience, and
    // the lecture's leave then has nothing to undo.
    let (attend, then, _, seated, r) = attend_in_lockstep(&[(seated_at + 100, rise())]);
    show("rise", &attend, &then, &r);
    assert!(
        attend.is_ok() && matches!(then[0], Some(Ok(_))),
        "attended, then risen"
    );
    free(&r, &seated, "rise");
    let (_, then, _, seated, r) =
        attend_in_lockstep(&[(seated_at + 100, rise()), (seated_at + 200, walk(4))]);
    show("rise and walk off", &attend, &then, &r);
    assert!(matches!(then[1], Some(Ok(_))), "walked off: {then:?}");
    assert!(seated.is_empty());
    assert_eq!(
        listeners(&r, hall_lecture()),
        0,
        "walked off: not in the audience"
    );
}

/// A final answer, the tick a run stands at, and the bodies seated.
type Ran = (Option<Result<Vec<u64>, String>>, i64, Vec<(Id, Id)>);

/// Lockstep `world` run to `tick`, with `bytes` arriving at `at` first when given: its final answer, and the bodies
/// seated at the end.
fn run_to(world: &answers::World, tick: i64, arrive: Option<(i64, Vec<u8>)>) -> Ran {
    let (tx, rx) = std::sync::mpsc::channel();
    if let Some((at, bytes)) = arrive {
        world
            .events
            .send(answers::Event::ArrivalAt {
                tick: at,
                bytes,
                reply: tx,
            })
            .unwrap();
    }
    let (done, ran) = std::sync::mpsc::channel();
    world
        .events
        .send(answers::Event::RunTo { tick, done })
        .unwrap();
    let ran = ran.recv().unwrap();
    let answer = rx
        .try_iter()
        .filter(|f| answers::progress_of(f).is_none())
        .map(|f| answer_in(&f).1)
        .next();
    (answer, ran.tick, ran.seated)
}

/// A listener seated on the hall's bench when the world restarts, then rising, leaves the lecture's audience: the
/// world reads the seat's links back from the restarted world, so the lecture's `lapse` (which needs no listener)
/// can still happen.
#[test]
fn e14b_a_listener_who_rises_after_a_restart_leaves_the_audience() {
    let (world, store, initial, _) = hall("restart", true);
    let attend = intent_bytes(
        w1(),
        1,
        "eden:attend",
        Some(hall_lecture()),
        seat(east_bench(), 1),
    );
    let (done, last, seated) = run_to(&world, 300, Some((1, attend)));
    println!("E14b before the restart: attend {done:?}, tick {last}, seated {seated:?}");
    assert!(matches!(done, Some(Ok(_))), "attended: {done:?}");
    assert_eq!(seated, vec![(w1(), east_bench())]);
    world.stop();

    let (world, store, _, _) = hall_on("restart", true, store);
    let (_, now, seated) = run_to(&world, 0, None);
    println!("E14b after the restart: tick {now}, seated {seated:?}");
    assert_eq!(
        seated,
        vec![(w1(), east_bench())],
        "seated again after the restart"
    );
    assert_eq!(listeners(&replay(&initial, &store), hall_lecture()), 1);
    let rise = intent_bytes(w1(), 2, "eden:rise", None, BTreeMap::new());
    let (risen, _, seated) = run_to(&world, now + 300, Some((now + 5, rise)));
    let r = replay(&initial, &store);
    println!(
        "E14b rise after the restart: {risen:?}, seated {seated:?}, listeners {}",
        listeners(&r, hall_lecture())
    );
    assert!(matches!(risen, Some(Ok(_))), "risen: {risen:?}");
    assert!(seated.is_empty());
    assert_eq!(parent(&r, w1()).0, Some(ground()), "standing");
    assert_eq!(
        listeners(&r, hall_lecture()),
        0,
        "no listener: the lecture's lapse needs none"
    );
    world.stop();
}
