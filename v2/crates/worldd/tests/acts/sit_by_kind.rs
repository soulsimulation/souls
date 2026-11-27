//! #3178: a sit by kind through the gateway, and a burst of them. A served hall: twelve of Eden's chairs
//! (`content/kinds/seating/chair.json`) in three rows of four and one of Eden's stools beside them, each seat registered
//! as the world's place. Thirteen Souls stand north of the rows and each sends `eden:sit` aimed at I5's free-slot
//! selector (any free `eden:chair` in the hall, nearest), all at once. The world binds each at its form's start, one at
//! a time on the clock, to the chair with the free seat nearest it that no earlier run is on its way to; each then runs
//! the chair's own sit (a walk to its seat's front, then the sit), as a sit naming that chair does. Twelve are seated,
//! each in its own chair; the thirteenth is refused `place.none-free`, told the stool is the nearest free seat there.
use super::*;
use replica::selector::{Rule, Selector};

const CHAIR: &str = "eden:chair";
const STOOL: &str = "eden:stool";

fn pinned(kind: &str) -> String {
    full(kind, if kind == CHAIR { 0x50 } else { 0x51 })
}

fn chairs() -> Vec<(Id, Vec3)> {
    let mut out = Vec::new();
    for (row, z) in [22_000_000, 24_500_000, 27_000_000].into_iter().enumerate() {
        for (col, x) in [-45_000_000, -43_500_000, -42_000_000, -40_500_000]
            .into_iter()
            .enumerate()
        {
            out.push((id(120 + 4 * row as u64 + col as u64), Vec3::new(x, 0, z)));
        }
    }
    out
}

fn stool() -> (Id, Vec3) {
    (id(140), Vec3::new(-37_000_000, 0, 24_500_000))
}

/// The thirteen Souls' bodies: the two walkers, and eleven more in a row 1.5 m north of them.
fn souls() -> Vec<(Id, Vec3)> {
    let mut out = vec![(w1(), at1()), (w2(), at2())];
    for i in 0..11 {
        out.push((
            id(100 + i),
            Vec3::new(-46_000_000 + 900_000 * i as i64, 0, 31_500_000),
        ));
    }
    out
}

fn header_with(old: &Replica) -> Header {
    let mut hv = match decode(old.header().stored()).unwrap().value {
        Value::Map(m) => m,
        _ => unreachable!(),
    };
    let Some(Value::Array(kinds)) = hv.get_mut(&6) else {
        unreachable!()
    };
    for kind in [CHAIR, STOOL] {
        kinds.push(Value::Text(name(&pinned(kind))));
    }
    Header::read(&encode(&Value::Map(hv)).unwrap()).unwrap()
}

/// The hall's creates under `ground`, numbered from `next`: the chairs and the stool, and the eleven more walkers.
fn hall_part(header: &Header, next: u64, ground: Id) -> Part {
    let things = chairs()
        .into_iter()
        .map(|(n, at)| (n, pinned(CHAIR), at))
        .chain(std::iter::once((stool().0, pinned(STOOL), stool().1)))
        .chain(
            souls()
                .into_iter()
                .skip(2)
                .map(|(n, at)| (n, fullname(WALKER), at)),
        );
    let effects = things
        .enumerate()
        .map(|(k, (node, kind, position))| {
            Effect {
                envelope: Envelope {
                    sequence: next + k as u64,
                    at: 0,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node: ground,
                },
                body: Body::Changes(vec![ChangeRec {
                    change: Change::Create {
                        node,
                        kind: name(&kind),
                        pose: Pose {
                            frame: Frame {
                                node: ground,
                                slot: None,
                            },
                            position,
                            orientation: Quat::IDENTITY,
                            support: Support::Surface {
                                surface: ground,
                                height: 0,
                            },
                        },
                        audience: Audience::Everyone,
                        fields: BTreeMap::new(),
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

/// A seat as a served world registers it from its entry: its slot `up` µm above the floor and `ahead` µm in front of
/// the thing's middle, stood at `stand` µm in front of the slot.
fn seat(thing: Id, at: Vec3, up: i64, ahead: i64, stand: i64, floor: Id) -> sim::slots::PlaceAt {
    let place = replica::moves::Place::from_value(
        &decode(
            &replica::effects::fixture_bytes(&format!(
                "{{1: 1, 2: {}, 3: [0, {}]}}",
                up / 1000,
                stand / 1000
            ))
            .unwrap(),
        )
        .unwrap()
        .value,
    )
    .unwrap();
    sim::slots::PlaceAt {
        thing,
        place,
        point: Vec3::new(at.x, up, at.z + ahead),
        facing: Quat::IDENTITY,
        floor,
        more: Vec::new(),
    }
}

fn hall_bodies() -> Result<Bodies, replica::effects::Refusal> {
    let (mut base, ground) = town();
    let header = header_with(&world());
    let part = hall_part(&header, base.tree.next(), ground);
    base.tree.apply(&header, &part)?;
    base.doors.header = header;
    base.doors.next = base.tree.next();
    let town = Town::new(base.tree, ground, base.doors).expect("the town with the hall");
    let planner = town.copy().expect("an independent planner town");
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let mut placed = Vec::new();
    for (soul, at) in souls() {
        placed.push(town.surfaces[&ground].place(soul, frame, at, Quat::IDENTITY)?);
    }
    let mut b = Bodies::with_planner(town, planner, 50_000)?;
    for p in placed {
        b.add_body(humanoid(), p)?;
    }
    // The chair's seat 470 mm up and 20 mm forward, its front 509 mm forward; the stool's 670 mm up, its front 480 mm.
    for (chair, at) in chairs() {
        b.add_place(seat(chair, at, 470_000, 20_000, 489_000, ground))?;
    }
    b.add_place(seat(stool().0, stool().1, 670_000, 0, 480_000, ground))?;
    Ok(b)
}

fn hall(tag: &str) -> (answers::World, Mem, Replica, std::path::PathBuf) {
    let old = world();
    let header = header_with(&old);
    let mut initial = Replica::restored(header.clone(), old.tree().frozen(), old.version());
    initial
        .apply(&hall_part(&header, initial.version(), ground()))
        .unwrap();
    let mut rules = tree_rules();
    for kind in [CHAIR, STOOL] {
        rules.kinds.insert(
            pinned(kind),
            Kind {
                owner: "thing".into(),
                children: BTreeSet::new(),
                slots: BTreeMap::from([(1, BTreeSet::from(["body".to_owned()]))]),
                hands: None,
                fields: Default::default(),
            },
        );
    }
    rules.souls.extend(souls().into_iter().map(|s| s.0));
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(|_| hall_bodies()));
    cfg.engine = Some((rules, Vec::new()));
    let mut kinds = entries();
    let Json::Obj(loaded) = &mut kinds else {
        unreachable!()
    };
    loaded.push((
        CHAIR.into(),
        parse(include_str!(
            "../../../../../content/kinds/seating/chair.json"
        ))
        .unwrap(),
    ));
    loaded.push((
        STOOL.into(),
        parse(include_str!(
            "../../../../../content/kinds/seating/stool.json"
        ))
        .unwrap(),
    ));
    let store = Mem::default();
    let world = answers::start(
        initial.frozen(),
        Rules {
            kinds,
            moves: Json::Obj(Vec::new()),
        },
        store.clone(),
        cfg,
    )
    .expect("the hall starts");
    let path = std::env::temp_dir().join(format!("i3178-{tag}-{}.sock", std::process::id()));
    (world, store, initial, path)
}

/// `eden:sit` aimed at any free chair in the hall, nearest the Soul: I5's selector as the target.
fn sit_by_kind(c: &mut Client) {
    sit_by(c, CHAIR);
}

/// `eden:sit` aimed at any free seat of `kind` in the hall, nearest the Soul.
fn sit_by(c: &mut Client, kind: &str) {
    c.2 += 1;
    let i = Intent {
        actor: Actor::Soul(c.1),
        verb: name("eden:sit"),
        target: Some(
            Selector::FreeSlot {
                kind: name(kind),
                node: ground(),
                rule: Rule::Nearest,
            }
            .target(),
        ),
        parameters: BTreeMap::new(),
        sequence: c.2,
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
        replaces: None,
        body: None,
        reflex: false,
    };
    c.raw(&encode(&i.to_value()).unwrap());
}

/// The hall served on a socket, and a client for each Soul.
fn served(
    tag: &str,
) -> (
    answers::World,
    Mem,
    Replica,
    std::path::PathBuf,
    Vec<Client>,
) {
    let (world, store, initial, path) = hall(tag);
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, stream));
        }
    });
    let clients = souls()
        .into_iter()
        .map(|(soul, _)| {
            let s = UnixStream::connect(&path).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
            Client(s, soul, 0, Vec::new(), Vec::new())
        })
        .collect();
    (world, store, initial, path, clients)
}

/// One Soul alone takes the chair whose seat's front is nearest it (I5's `Nearest`): the back row's east chair, 2.5 m
/// south and 0.5 m west of the first walker. A sit by a kind the hall has no seat of is refused `place.none-of-kind`,
/// which waiting never clears, and told the nearest free seat there.
#[test]
fn i3178_a_sit_by_kind_takes_the_nearest_chair_and_a_kind_not_there_is_named() {
    let (world, store, initial, path, mut clients) = served("nearest");
    sit_by_kind(&mut clients[0]);
    let sat = clients[0].answer();
    println!("#3178 nearest: {sat:?}");
    sat.expect("seated");
    sit_by(&mut clients[1], "eden:pew");
    let pew = clients[1].answer();
    let detail = clients[1].detail().unwrap_or_default();
    println!("#3178 no pew: {pew:?} {detail}");
    let log = store.0.lock().unwrap().bytes.clone();
    let mut r = initial.frozen();
    for rec in recover(&log).unwrap().records {
        if !sim::recorder::is_input(&rec) {
            let p = Part::read(&rec).unwrap();
            if !p.effects.is_empty() {
                r.apply(&p).expect("the log replays");
            }
        }
    }
    world.stop();
    let _ = std::fs::remove_file(&path);
    assert_eq!(
        parent(&r, w1()),
        (Some(id(131)), Some(1)),
        "the nearest chair"
    );
    assert_eq!(pew, Err("place.none-of-kind".to_owned()));
    assert!(
        detail.contains("the nearest free place to sit there is"),
        "a next step: {detail}"
    );
}

#[test]
fn i3178_thirteen_souls_sit_by_kind_at_once_in_a_hall_of_twelve_chairs() {
    let (world, store, initial, path, mut clients) = served("burst");
    // All thirteen at once, then every answer.
    for c in &mut clients {
        sit_by_kind(c);
    }
    let mut seated = Vec::new();
    let mut refused = Vec::new();
    for c in &mut clients {
        match c.answer() {
            Ok(entries) => seated.push((c.1, entries)),
            Err(reason) => refused.push((c.1, reason, c.detail())),
        }
    }
    println!("#3178: {} seated, refused {refused:?}", seated.len());
    let log = store.0.lock().unwrap().bytes.clone();
    let mut r = initial.frozen();
    for rec in recover(&log).unwrap().records {
        if !sim::recorder::is_input(&rec) {
            let p = Part::read(&rec).unwrap();
            if !p.effects.is_empty() {
                r.apply(&p).expect("the log replays");
            }
        }
    }
    let chairs: BTreeSet<Id> = chairs().into_iter().map(|c| c.0).collect();
    let mut taken = BTreeSet::new();
    for (soul, entries) in &seated {
        let at = parent(&r, *soul);
        println!(
            "#3178: {} seated in {at:?}, entries {entries:?}",
            replica::world_model::show(*soul)
        );
        assert!(
            at.0.is_some_and(|c| chairs.contains(&c)) && at.1 == Some(1),
            "seated in a chair's seat: {at:?}"
        );
        assert!(taken.insert(at.0), "each in its own chair");
    }
    assert_eq!(seated.len(), 12, "every chair filled");
    assert_eq!(taken.len(), 12);
    let [(soul, reason, detail)] = &refused[..] else {
        panic!("one refused: {refused:?}")
    };
    assert_eq!(reason, "place.none-free");
    let detail = detail.clone().unwrap_or_default();
    assert!(
        detail.contains(&replica::world_model::show(stool().0)),
        "the next step names the stool: {detail}"
    );
    assert_eq!(
        parent(&r, *soul),
        (Some(ground()), None),
        "the thirteenth stands"
    );
    world.stop();
    let _ = std::fs::remove_file(&path);
}
