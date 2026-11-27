//! #3178: a sit by kind through the gateway, and a burst of them. A served hall on N2's test world: twelve of Eden's
//! chairs (`content/kinds/seating/chair.json`) in three rows of four and one of Eden's stools beside them, each seat
//! registered as the world's place. Thirteen Souls stand north of the rows and each sends `eden:sit` aimed at I5's
//! free-slot selector (any free `eden:chair` in the hall, nearest), all at once. The world binds each at its form's
//! start, one at a time on the clock, to the chair with the free seat nearest it that no earlier run is on its way to;
//! each then runs the chair's own sit (a walk to its seat's front, then the sit), as a sit naming that chair does.
//! Twelve are seated, each in its own chair; the thirteenth is refused `place.none-free`, told the stool is the nearest
//! free place to sit there.
//!
//! Its own test binary: thirteen walkers at once would slow the `acts` binary's tests that keep to real time.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

use import_eden::Import;
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::Intent;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::{Value as Json, parse};
use replica::selector::{Rule, Selector};
use replica::tree::Rules as TreeRules;
use replica::world_model::{Audience, Kind, show};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::walk::town::Town;
use worldd::answers::{self, Config};
use worldd::bodies::Bodies;
use worldd::checkers::Rules;

const LINEAGE: Scope = Scope([0x31; 16]);
const PLACE: &str = "souls:place";
const WALKER: &str = "test:walker";
const OPEN_GROUND: &str = "eden:ground";

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

/// A kind's pinned name.
fn pinned(kind: &str) -> String {
    let n = [PLACE, WALKER, OPEN_GROUND, CHAIR, STOOL]
        .iter()
        .position(|k| *k == kind)
        .unwrap();
    format!("{kind}@1220{}{:02x}", "00".repeat(31), n + 1)
}

fn id(n: u64) -> Id {
    Id::new(Scope([0x7c; 16]), n).unwrap()
}
fn w1() -> Id {
    id(1)
}
fn w2() -> Id {
    id(2)
}
fn at1() -> Vec3 {
    Vec3::new(-40_000_000, 0, 30_000_000)
}
fn at2() -> Vec3 {
    Vec3::new(-42_700_000, 0, 30_000_000)
}
/// The zone's place: the replica's root, the open ground under it.
fn zone_place() -> Id {
    id(90)
}

fn humanoid() -> Family {
    let r = |n: &str, class, slot| Resource {
        name: name(n),
        class,
        slot,
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![
            r("souls:leg-left", Class::Locomotion, None),
            r("souls:leg-right", Class::Locomotion, None),
            r("souls:hand-left", Class::Manipulator, Some(1)),
            r("souls:hand-right", Class::Manipulator, Some(2)),
            r("souls:voice", Class::Voice, None),
        ],
    }
}

/// N2's test world as a town, and its ground.
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/i3178-town/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(nodes["world"].scope().0.to_vec())),
        (4, nodes["world"].to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).unwrap()).unwrap();
    let next = tree.to_state().next;
    let ground = nodes["ground"];
    let town = Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town");
    (town, ground)
}

fn ground() -> Id {
    town().1
}

/// The replica's header, rooted at the zone's place, every kind pinned.
fn header() -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/i3178/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone_place().scope().0.to_vec())),
        (4, zone_place().to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                [PLACE, WALKER, OPEN_GROUND, CHAIR, STOOL]
                    .iter()
                    .map(|k| Value::Text(name(&pinned(k))))
                    .collect(),
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).unwrap()).unwrap()
}

/// The world's rules (T2): the ground takes bodies and things; a walker holds a thing in each hand; a chair's and a
/// stool's one slot takes a body.
fn tree_rules() -> TreeRules {
    let k = |owner: &str, children: &[&str], slots: &[(u64, &str)]| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: slots
            .iter()
            .map(|(s, a)| (*s, BTreeSet::from([(*a).to_owned()])))
            .collect(),
        hands: None,
        fields: Default::default(),
    };
    TreeRules {
        kinds: BTreeMap::from([
            (pinned(PLACE), k("place", &["body", "thing"], &[])),
            (pinned(OPEN_GROUND), k("place", &["body", "thing"], &[])),
            (
                pinned(WALKER),
                k("family", &[], &[(1, "thing"), (2, "thing")]),
            ),
            (pinned(CHAIR), k("thing", &[], &[(1, "body")])),
            (pinned(STOOL), k("thing", &[], &[(1, "body")])),
        ]),
        souls: souls().into_iter().map(|s| s.0).collect(),
        audiences: BTreeMap::new(),
    }
}

/// One Soul's end of the world's socket: the stream, the Soul, its last sequence, the last answer frame.
struct Client(UnixStream, Id, u64, Vec<u8>);

impl Client {
    fn raw(&mut self, bytes: &[u8]) {
        self.0
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        self.0.write_all(bytes).unwrap();
    }

    /// The next answer, a progress answer (C20) read past: a receipt's entries, or a refusal's reason.
    fn answer(&mut self) -> Result<Vec<u64>, String> {
        let frame = loop {
            let mut len = [0u8; 4];
            self.0.read_exact(&mut len).expect("an answer");
            let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
            self.0.read_exact(&mut frame).unwrap();
            if answers::progress_of(&frame).is_none() {
                break frame;
            }
        };
        self.3 = frame.clone();
        let Value::Map(m) = decode(&frame).unwrap().value else {
            panic!("a frame")
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            panic!("an answer")
        };
        match (a.get(&3), a.get(&4), a.get(&5)) {
            (Some(Value::Uint(1)), _, Some(Value::Array(e))) => Ok(e
                .iter()
                .map(|v| match v {
                    Value::Uint(n) => *n,
                    _ => panic!("an entry"),
                })
                .collect()),
            (Some(Value::Uint(2)), Some(Value::Text(t)), _) => Err(t.as_str().to_owned()),
            other => panic!("an answer: {other:?}"),
        }
    }

    /// The last answer's refusal detail (its field 8), when it has one.
    fn detail(&self) -> Option<String> {
        let Value::Map(m) = decode(&self.3).ok()?.value else {
            return None;
        };
        match m.get(&2)? {
            Value::Map(a) => match a.get(&8)? {
                Value::Bytes(b) => String::from_utf8(b.clone()).ok(),
                _ => None,
            },
            _ => None,
        }
    }
}

fn parent(r: &Replica, node: Id) -> (Option<Id>, Option<u64>) {
    let t = r.tree();
    let n = t.node(t.handle(node).expect("the node")).expect("the node");
    (n.parent(), n.slot())
}

/// The replica as built: the zone's place and the open ground under it, with the two first walkers on it.
fn world() -> Replica {
    let h = header();
    let mut r = Replica::start(h.stored()).expect("a replica");
    let g = ground();
    let made = [
        (g, pinned(OPEN_GROUND), zone_place(), Vec3::ZERO),
        (w1(), pinned(WALKER), g, at1()),
        (w2(), pinned(WALKER), g, at2()),
    ];
    let effects: Vec<Value> = made
        .into_iter()
        .enumerate()
        .map(|(k, (node, kind, parent, at))| create(k as u64, node, &kind, parent, at))
        .collect();
    let part = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (2, Value::Array(effects)),
    ])))
    .unwrap();
    r.apply(&Part::read(&part).unwrap())
        .expect("the world as built");
    r
}

/// One world-caused create of `node` of `kind` under `parent` at `at`, as an effect's value.
fn create(sequence: u64, node: Id, kind: &str, parent: Id, at: Vec3) -> Value {
    create_with(sequence, node, kind, parent, at, BTreeMap::new())
}

/// [`create`] with the node's fields.
fn create_with(
    sequence: u64,
    node: Id,
    kind: &str,
    parent: Id,
    at: Vec3,
    fields: BTreeMap<u64, Value>,
) -> Value {
    Effect {
        envelope: Envelope {
            sequence,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: parent,
        },
        body: Body::Changes(vec![ChangeRec {
            change: Change::Create {
                node,
                kind: name(kind),
                pose: Pose {
                    frame: Frame {
                        node: parent,
                        slot: None,
                    },
                    position: at,
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: parent,
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

const CHAIR: &str = "eden:chair";
const STOOL: &str = "eden:stool";

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

/// The bandstand (#5152 follow-up): a place on the open ground, titled by a public name, at the ground's origin.
fn bandstand() -> Id {
    id(150)
}
const BANDSTAND: &str = "the bandstand";

/// The hall's creates under `ground`, numbered from `next`: the chairs and the stool, and the eleven more walkers.
/// With `titled`, the chairs and the stool stand in [`bandstand`], made first, a place on the open ground.
fn hall_part(header: &Header, next: u64, ground: Id, titled: bool) -> Part {
    let under = if titled { bandstand() } else { ground };
    let title = BTreeMap::from([(
        import_eden::F_NAME,
        Value::Bytes(replica::ids::sha256(BANDSTAND.as_bytes()).to_vec()),
    )]);
    let place =
        titled.then(|| create_with(next, bandstand(), &pinned(PLACE), ground, Vec3::ZERO, title));
    let first = next + u64::from(titled);
    let seats = chairs()
        .into_iter()
        .map(|(n, at)| (n, pinned(CHAIR), at))
        .chain(std::iter::once((stool().0, pinned(STOOL), stool().1)))
        .map(|(node, kind, at)| (node, kind, at, under));
    let walkers = souls()
        .into_iter()
        .skip(2)
        .map(|(n, at)| (n, pinned(WALKER), at, ground));
    let effects = place
        .into_iter()
        .chain(
            seats
                .chain(walkers)
                .enumerate()
                .map(|(k, (node, kind, at, parent))| {
                    create(first + k as u64, node, &kind, parent, at)
                }),
        )
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

fn hall_bodies(titled: bool) -> Result<Bodies, replica::effects::Refusal> {
    let (mut base, ground) = town();
    let header = header();
    let part = hall_part(&header, base.tree.next(), ground, titled);
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

fn hall(tag: &str, titled: bool) -> (answers::World, Mem, Replica, std::path::PathBuf) {
    let old = world();
    let header = header();
    let mut initial = Replica::restored(header.clone(), old.tree().frozen(), old.version());
    initial
        .apply(&hall_part(&header, initial.version(), ground(), titled))
        .unwrap();
    let rules = tree_rules();
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(move |_| hall_bodies(titled)));
    cfg.engine = Some((rules, Vec::new()));
    let kinds = Json::Obj(vec![
        (
            CHAIR.into(),
            parse(include_str!("../../../../content/kinds/seating/chair.json")).unwrap(),
        ),
        (
            STOOL.into(),
            parse(include_str!("../../../../content/kinds/seating/stool.json")).unwrap(),
        ),
    ]);
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
    titled: bool,
) -> (
    answers::World,
    Mem,
    Replica,
    std::path::PathBuf,
    Vec<Client>,
) {
    let (world, store, initial, path) = hall(tag, titled);
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
            Client(s, soul, 0, Vec::new())
        })
        .collect();
    (world, store, initial, path, clients)
}

/// One Soul alone takes the chair whose seat's front is nearest it (I5's `Nearest`): the back row's east chair, 2.5 m
/// south and 0.5 m west of the first walker. A sit by a kind the hall has no seat of is refused `place.none-of-kind`,
/// which waiting never clears, and told the nearest free seat there.
#[test]
fn i3178_a_sit_by_kind_takes_the_nearest_chair_and_a_kind_not_there_is_named() {
    let (world, store, initial, path, mut clients) = served("nearest", false);
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
    let (world, store, initial, path, mut clients) = served("burst", false);
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

/// Each act end's words (field 8) in the log, as the world wrote them.
fn ended_words(log: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    for rec in recover(log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            for v in e.events.unwrap_or_default() {
                if v.name.as_str() == answers::FORM_ENDED
                    && let Some(Value::Bytes(w)) = v.fields.get(&8)
                {
                    out.push(String::from_utf8_lossy(w).into_owned());
                }
            }
        }
    }
    out
}

/// #5152 follow-up: from the open ground, a sit by kind names the place on it that holds the seats, by its id (each
/// reader's copy names it by its title), and how far: the twelve seated, in their act's end; the thirteenth, refused `place.none-free`, in its refusal.
#[test]
fn i5152_from_the_open_ground_a_sit_by_kind_names_the_place_of_the_seats() {
    let (world, store, _, path, mut clients) = served("bandstand", true);
    for c in &mut clients {
        sit_by_kind(c);
    }
    let mut seated = 0;
    let mut refused = Vec::new();
    for c in &mut clients {
        match c.answer() {
            Ok(_) => seated += 1,
            Err(reason) => refused.push((reason, c.detail().unwrap_or_default())),
        }
    }
    let log = store.0.lock().unwrap().bytes.clone();
    world.stop();
    let _ = std::fs::remove_file(&path);
    let words = ended_words(&log);
    println!("#5152: {seated} seated, ends {words:?}, refused {refused:?}");
    assert_eq!(seated, 12, "every chair filled");
    let sat: Vec<&String> = words.iter().filter(|w| w.starts_with(CHAIR)).collect();
    assert_eq!(
        sat.len(),
        12,
        "each seated act's end names its place: {words:?}"
    );
    for w in sat {
        assert!(
            w.contains(&format!("in {}, ", show(bandstand()))) && w.ends_with(" m away"),
            "the place and how far: {w}"
        );
    }
    let [(reason, detail)] = &refused[..] else {
        panic!("one refused: {refused:?}")
    };
    assert_eq!(reason, "place.none-free");
    assert!(
        detail.contains(&format!(
            "(the nearest {CHAIR} is in {}, ",
            show(bandstand())
        )) && detail.contains(" m away)"),
        "the refusal names the place: {detail}"
    );
}

/// #5152 follow-up: a seat on another floor than the body's (a place's, from the open ground) is measured in the
/// body's frame, by the poses between: the bandstand stands 10 m east, its chair 2 m north in it.
#[test]
fn i5152_a_seat_on_another_floor_is_measured_from_the_open_ground() {
    let (mut base, ground) = town();
    let header = header();
    let east = Vec3::new(10_000_000, 0, 0);
    let chair = id(160);
    let next = base.tree.next();
    let part = Part::read(
        &encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(header.hash().to_bytes())),
            (
                2,
                Value::Array(vec![
                    create(
                        next,
                        bandstand(),
                        &pinned(PLACE),
                        ground,
                        at1().plus(east).unwrap(),
                    ),
                    create(
                        next + 1,
                        chair,
                        &pinned(CHAIR),
                        bandstand(),
                        Vec3::new(0, 0, -2_000_000),
                    ),
                ]),
            ),
        ])))
        .unwrap(),
    )
    .unwrap();
    base.tree.apply(&header, &part).unwrap();
    base.doors.header = header;
    base.doors.next = base.tree.next();
    let town = Town::new(base.tree, ground, base.doors).expect("the town");
    let planner = town.copy().expect("a planner town");
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let placed = town.surfaces[&ground]
        .place(w1(), frame, at1(), Quat::IDENTITY)
        .unwrap();
    let mut b = Bodies::with_planner(town, planner, 50_000).unwrap();
    b.add_body(humanoid(), placed).unwrap();
    // Its seat stood at 500 mm in front of the slot, in the bandstand's frame.
    b.add_place(seat(
        chair,
        Vec3::new(0, 0, -2_000_000),
        470_000,
        0,
        500_000,
        bandstand(),
    ))
    .unwrap();
    let (t, gap) = b
        .nearest_of_kind(ground, CHAIR, w1(), &|_| true)
        .expect("the chair");
    assert_eq!(t, chair);
    // 10 m east and 1.5 m north of the body: its stand point, moved into the ground's frame.
    let want = 10_000_000_i128.pow(2) + 1_500_000_i128.pow(2);
    assert_eq!(gap, want, "measured in the ground's frame");
}
