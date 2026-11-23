//! Engine v2 I4b (#3156): a committed move reaches the body. On N2's test world, a scripted client writes walk, sit
//! and rise intents to the world's end of the gateway's socket (I1's framing), and reads each answer back. The body
//! walks to a chair's stand point, sits in its slot and stands again, driven only by the walk skill behind the host
//! and B3's seats, through the one controller. Each receipt names the log's entries its intent caused; a walk while
//! seated is refused by name, and a walk replaced by another ends `claim-taken`. C4 (#3368): a lie on a bed goes the
//! same way, with B2's lie move, and gets the same receipts.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc::channel;
use std::time::Duration;

use import_eden::Import;
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Actor, Cause, Header, Part, fixture_bytes, read_id, schema_hash};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Fallback, Intent, Target};
use replica::move_check::move_check;
use replica::moves::Place;
use replica::pose::{Frame, Quat, Vec3};
use replica::select::{Spot, resolve};
use replica::tree::Tree;
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use worldd::answers::{self, Config, MOVE_ENDED, MOVE_STARTED};
use worldd::bodies::Bodies;
use worldd::checkers::toggles;

thread_local! {
    /// The acts that had their one progress answer (C20) on this test's thread.
    static PROGRESSED: std::cell::RefCell<std::collections::BTreeSet<(Vec<u8>, u64)>> =
        std::cell::RefCell::default();
}

/// Whether `frame` is an act's progress answer (C20, W11 #4087), which the answer helpers read past. An act has at
/// most one: a second fails the test.
fn progress_once(frame: &[u8]) -> bool {
    let Some(key) = answers::progress_of(frame) else {
        return false;
    };
    let first = PROGRESSED.with(|p| p.borrow_mut().insert(key));
    assert!(first, "a second progress answer for one act");
    true
}

const LINEAGE: Scope = Scope([0x4b; 16]);
const CHAIR: &str = include_str!("../../replica/fixtures/seats/chair.diag");

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn humanoid() -> Family {
    let r = |n: &str| Resource {
        name: name(n),
        class: Class::Locomotion,
        slot: None,
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![r("souls:leg-left"), r("souls:leg-right")],
    }
}

/// N2's test world as a town, its ground, and a body and a chair on the open ground west of the square.
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/i4b-test/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
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

fn body_id() -> Id {
    Id::new(Scope([7; 16]), 9_001).unwrap()
}

fn thing() -> Id {
    Id::new(Scope([7; 16]), 9_002).unwrap()
}

/// The body starts 4 m west of the chair; the chair faces +z, its stand point 300 mm in front of it.
fn start() -> Vec3 {
    Vec3::new(-40_000_000, 0, 30_000_000)
}

fn seat_at() -> Vec3 {
    Vec3::new(-36_000_000, 450_000, 30_000_000)
}

fn bodies() -> Result<Bodies, replica::effects::Refusal> {
    bodies_with(CHAIR, seat_at())
}

/// The body and one seat of `place` (its fixture text) at `point`.
fn bodies_with(place: &str, point: Vec3) -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let at = town.surfaces[&ground].place(
        body_id(),
        Frame {
            node: ground,
            slot: None,
        },
        start(),
        Quat::IDENTITY,
    )?;
    let mut b = Bodies::new(town, 50_000)?;
    b.add_body(humanoid(), at)?;
    let place = Place::from_value(&decode(&fixture_bytes(place)?).unwrap().value)?;
    b.add_place(PlaceAt {
        thing: thing(),
        place,
        point,
        facing: Quat::IDENTITY,
        floor: ground,
    })?;
    Ok(b)
}

fn bed() -> Id {
    Id::new(Scope([7; 16]), 9_003).unwrap()
}

/// A bed 4 m north of the chair: its slot 450 mm above the floor, its stand point 300 mm in front of it (in the lie
/// move's 600 mm reach).
const BED: &str = "{1: 1, 2: 450, 3: [0, 300]}";

fn bed_at() -> Vec3 {
    Vec3::new(-36_000_000, 450_000, 34_000_000)
}

fn bodies_and_bed() -> Result<Bodies, replica::effects::Refusal> {
    let mut b = bodies()?;
    let (_, ground) = town();
    let place = Place::from_value(&decode(&fixture_bytes(BED)?).unwrap().value)?;
    b.add_place(PlaceAt {
        thing: bed(),
        place,
        point: bed_at(),
        facing: Quat::IDENTITY,
        floor: ground,
    })?;
    Ok(b)
}

/// A scripted client on the world's socket.
struct Client(UnixStream);

impl Client {
    fn send(&mut self, sequence: u64, verb: &str, target: Option<Id>) {
        self.send_to(sequence, verb, target.map(Target::Node));
    }

    fn send_to(&mut self, sequence: u64, verb: &str, target: Option<Target>) {
        self.send_as(body_id(), sequence, verb, target, &[]);
    }

    /// An intent by Soul `actor`, with ranked fallbacks of `verb` on each of `fallbacks` (C14).
    fn send_as(
        &mut self,
        actor: Id,
        sequence: u64,
        verb: &str,
        target: Option<Target>,
        fallbacks: &[Id],
    ) {
        let bytes = intent_bytes(
            actor,
            sequence,
            verb,
            target,
            fallbacks,
            answers::now() + 60_000_000,
        );
        self.0
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        self.0.write_all(&bytes).unwrap();
    }

    /// The next answer: a receipt's intent id and entries, or a refusal's reason.
    fn answer(&mut self) -> Result<(Id, Vec<u64>), String> {
        // A progress answer (C20, sent as a run starts) is read past.
        let frame = loop {
            let mut len = [0u8; 4];
            self.0.read_exact(&mut len).expect("an answer");
            let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
            self.0.read_exact(&mut frame).unwrap();
            if !progress_once(&frame) {
                break frame;
            }
        };
        read_answer(&frame)
    }
}

/// An intent by Soul `actor`, with ranked fallbacks of `verb` on each of `fallbacks` (C14), as the socket carries it.
fn intent_bytes(
    actor: Id,
    sequence: u64,
    verb: &str,
    target: Option<Target>,
    fallbacks: &[Id],
    expiry: i64,
) -> Vec<u8> {
    let i = Intent {
        actor: Actor::Soul(actor),
        verb: name(verb),
        target,
        parameters: BTreeMap::new(),
        sequence,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry,
        resources: Vec::new(),
        fallbacks: fallbacks
            .iter()
            .map(|&t| Fallback {
                verb: name(verb),
                target: Some(Target::Node(t)),
                parameters: BTreeMap::new(),
                resources: Vec::new(),
            })
            .collect(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// An answer frame: a receipt's intent id and entries, or a refusal's reason.
fn read_answer(frame: &[u8]) -> Result<(Id, Vec<u64>), String> {
    let Value::Map(m) = decode(frame).unwrap().value else {
        panic!("a frame")
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        panic!("an answer")
    };
    match (a.get(&3), a.get(&4), a.get(&5)) {
        (Some(Value::Uint(1)), Some(id), Some(Value::Array(e))) => Ok((
            read_id(id).unwrap(),
            e.iter()
                .map(|v| match v {
                    Value::Uint(n) => *n,
                    _ => panic!("an entry"),
                })
                .collect(),
        )),
        (Some(Value::Uint(2)), Some(Value::Text(t)), _) => Err(t.as_str().to_owned()),
        other => panic!("an answer: {other:?}"),
    }
}

/// Each logged move event caused by an intent: (entry, event, how, the node of the body's frame, its position).
type Logged = Vec<(u64, String, Option<String>, Id, [i64; 3])>;

fn logged(log: &[u8]) -> BTreeMap<Id, Logged> {
    let int = |v: &Value| match v {
        Value::Uint(u) => *u as i64,
        Value::Nint(n) => -1 - *n as i64,
        _ => panic!("an int"),
    };
    let mut out: BTreeMap<Id, Logged> = BTreeMap::new();
    for r in recover(log)
        .unwrap()
        .records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
    {
        for e in Part::read(&r).unwrap().effects {
            let Cause::Intent(id) = e.envelope.cause else {
                continue;
            };
            for ev in e.events.iter().flatten() {
                let f = &ev.fields;
                let Some(Value::Array(p)) = f.get(&3) else {
                    panic!("a position")
                };
                out.entry(id).or_default().push((
                    e.envelope.sequence,
                    ev.name.as_str().to_owned(),
                    f.get(&2).map(|v| match v {
                        Value::Bytes(b) => String::from_utf8(b.clone()).unwrap(),
                        _ => panic!("a name"),
                    }),
                    read_id(&f[&4]).unwrap(),
                    [int(&p[0]), int(&p[1]), int(&p[2])],
                ));
            }
        }
    }
    out
}

fn near(p: [i64; 3], q: Vec3, within: i64) -> bool {
    (p[0] - q.x).abs() <= within && (p[2] - q.z).abs() <= within
}

/// A3, with A2's receipts and names: walk to the chair, sit, a walk refused while seated, rise, and a walk replaced.
#[test]
fn a3_a_scripted_client_walks_sits_and_rises_over_the_socket() {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    let world = answers::start(
        toggles::World::build(0, 0, 0).replica,
        toggles::rules(),
        store.clone(),
        cfg,
    )
    .expect("the world starts");
    let path = std::env::temp_dir().join(format!("i4b-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    let (ready, accepted) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ready.send(()).unwrap();
        answers::serve(door, stream);
    });
    let stream = UnixStream::connect(&path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    accepted.recv().unwrap();
    let mut c = Client(stream);
    let stand = Vec3::new(seat_at().x, 0, seat_at().z + 300_000);

    c.send(1, "eden:walk", Some(thing()));
    let walk = c.answer().expect("the walk is done");
    c.send(2, "eden:sit", Some(thing()));
    let sit = c.answer().expect("the sit is done");
    c.send(3, "eden:walk", Some(thing()));
    assert_eq!(
        c.answer(),
        Err("resource-held".into()),
        "no walk while seated"
    );
    c.send(4, "eden:rise", None);
    let rise = c.answer().expect("the rise is done");
    // A walk replaced by the next one ends `claim-taken`; the next walks back to the start.
    c.send(5, "eden:walk", Some(thing()));
    c.send(6, "eden:sit", Some(thing()));
    assert_eq!(c.answer(), Err("claim-taken".into()), "the walk gave way");
    c.answer().expect("the sit is done");
    world.stop();
    let _ = std::fs::remove_file(&path);

    let log = logged(&store.0.lock().unwrap().bytes);
    for (what, (id, entries)) in [("walk", &walk), ("sit", &sit), ("rise", &rise)] {
        let l = &log[id];
        println!("{what}: receipt entries {entries:?}");
        for e in l {
            println!(
                "  #{} {} {:?} on {} at {:?} µm",
                e.0,
                e.1,
                e.2,
                replica::world_model::show(e.3),
                e.4
            );
        }
        let seqs: Vec<u64> = l.iter().map(|e| e.0).collect();
        assert_eq!(
            &seqs, entries,
            "{what}: the receipt names the log's entries"
        );
        assert_eq!(l[0].1, MOVE_STARTED);
        assert_eq!(
            (l.last().unwrap().1.as_str(), l.last().unwrap().2.as_deref()),
            (MOVE_ENDED, Some("done"))
        );
    }
    let end = |id: &Id| log[id].last().cloned().unwrap();
    let ground = end(&walk.0).3;
    let w = end(&walk.0);
    assert!(
        near(w.4, stand, 60_000),
        "the walk arrived at the stand point: {:?}",
        w.4
    );
    let s = end(&sit.0);
    assert_eq!(s.3, thing(), "seated: in the chair's slot");
    let r = end(&rise.0);
    assert_eq!(r.3, ground, "standing on the ground again");
    assert!(near(r.4, stand, 1_000), "on the stand point: {:?}", r.4);
}

/// E2's follow-up (#2709): a walk aimed at a described spot (selector 2) goes through the world's answer path. A
/// checker resolves it on its frozen copy with the shared library, giving the client's answer; the clock binds it
/// once, at commit, and the body walks there. A spot with no answer is refused by the library's name.
#[test]
fn a_described_spot_is_resolved_by_a_checker_bound_at_commit_or_refused_by_name() {
    let w = testworld::generate(1, 0).expect("the test world");
    let im = import_eden::load(&w.text).expect("the test world loads");
    let n = |k: &str| im.nodes[k];
    // The world's copy is the test world's log, so the checker's frozen copy holds the nodes the spot names.
    // Replica::start roots a zone at a `souls:place` kind; the import roots it at its world kind, so the header
    // lists that kind once more under the place's name.
    let Value::Map(mut h) = decode(&im.log.0).unwrap().value else {
        panic!("a header")
    };
    let Some(Value::Array(kinds)) = h.get_mut(&6) else {
        panic!("its kinds")
    };
    let world = kinds
        .iter()
        .find_map(|k| match k {
            Value::Text(t) => t.as_str().strip_prefix("eden:world@").map(str::to_owned),
            _ => None,
        })
        .expect("the world's kind");
    kinds.push(Value::Text(name(&format!("souls:place@{world}"))));
    let header = encode(&Value::Map(h)).unwrap();
    let Value::Map(mut part) = decode(&im.log.1).unwrap().value else {
        panic!("a part")
    };
    part.insert(
        1,
        Value::Bytes(Header::read(&header).unwrap().hash().to_bytes()),
    );
    let mut world_copy = Replica::start(&header).expect("the header");
    world_copy
        .apply_bytes(&encode(&Value::Map(part)).unwrap())
        .expect("the log applies");
    // The client's copy, built the same way by the tree's own apply, as a client's is.
    let root = im.tree.node(im.tree.root()).unwrap();
    let mut client = Tree::start(root.id(), root.kind().clone());
    client
        .apply(
            &Header::read(&im.log.0).unwrap(),
            &Part::read(&im.log.1).unwrap(),
        )
        .unwrap();
    let free = |_: Id, _: u64| false;
    // "Halfway between the building and the hall": a point on the open ground, 10 m east of the body.
    let between = Spot::Between(n("building"), n("hall"));
    let want = resolve(&client, &between, None, &free).expect("the client resolves it");
    assert_eq!(
        worldd::checkers::places::spot(world_copy.tree(), &between, body_id(), &free),
        Ok(want.clone()),
        "the checker gives the client's answer"
    );
    // "In front of the square": the square is the same turned a quarter, so it has no front.
    let front = Spot::Front(n("square"));

    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    let world =
        answers::start(world_copy, toggles::rules(), store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("e2-spot-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    let (ready, accepted) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ready.send(()).unwrap();
        answers::serve(door, stream);
    });
    let stream = UnixStream::connect(&path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    accepted.recv().unwrap();
    let mut c = Client(stream);

    c.send_to(1, "eden:walk", Some(front.target()));
    assert_eq!(c.answer(), Err("spot.no-front".into()), "refused by name");
    c.send_to(2, "eden:walk", Some(between.target()));
    let walk = c.answer().expect("the walk to the spot is done");
    world.stop();
    let _ = std::fs::remove_file(&path);

    let log = logged(&store.0.lock().unwrap().bytes);
    let l = &log[&walk.0];
    let seqs: Vec<u64> = l.iter().map(|e| e.0).collect();
    assert_eq!(seqs, walk.1, "the receipt names the log's entries");
    let end = l.last().cloned().unwrap();
    println!(
        "spot {:?} -> frame {} local {:?}; the walk ended {:?} on {} at {:?} um",
        between.relation(),
        replica::world_model::show(want.frame),
        want.local,
        end.2,
        replica::world_model::show(end.3),
        end.4
    );
    assert_eq!(end.3, want.frame, "standing in the spot's frame");
    assert!(
        near(end.4, want.local, 60_000),
        "the body walked to the bound spot: {:?}",
        end.4
    );
}

/// C4 A2: a lie on a bed goes through the bodies as a sit does: walk to its stand point, lie in its slot (a receipt
/// naming the log's entries, the move started and ended `done`), a walk refused while lying, and a rise.
#[test]
fn c4_a2_a_lie_on_a_bed_gets_receipts_like_a_sit() {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies_and_bed()));
    let world = answers::start(
        toggles::World::build(0, 0, 0).replica,
        toggles::rules(),
        store.clone(),
        cfg,
    )
    .expect("the world starts");
    let path = std::env::temp_dir().join(format!("c4-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    let (ready, accepted) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ready.send(()).unwrap();
        answers::serve(door, stream);
    });
    let stream = UnixStream::connect(&path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    accepted.recv().unwrap();
    let mut c = Client(stream);

    c.send(1, "eden:walk", Some(bed()));
    let walk = c.answer().expect("the walk is done");
    c.send(2, "eden:lie", Some(bed()));
    let lie = c.answer().expect("the lie is done");
    c.send(3, "eden:walk", Some(thing()));
    assert_eq!(
        c.answer(),
        Err("resource-held".into()),
        "no walk while lying"
    );
    c.send(4, "eden:rise", None);
    let rise = c.answer().expect("the rise is done");
    c.send(5, "eden:lie", None);
    assert_eq!(
        c.answer(),
        Err("move.no-target".into()),
        "a lie names its bed"
    );
    world.stop();
    let _ = std::fs::remove_file(&path);

    let log = logged(&store.0.lock().unwrap().bytes);
    for (what, (id, entries)) in [("walk", &walk), ("lie", &lie), ("rise", &rise)] {
        let l = &log[id];
        let seqs: Vec<u64> = l.iter().map(|e| e.0).collect();
        assert_eq!(
            &seqs, entries,
            "{what}: the receipt names the log's entries"
        );
        assert_eq!(l[0].1, MOVE_STARTED);
        assert_eq!(
            (l.last().unwrap().1.as_str(), l.last().unwrap().2.as_deref()),
            (MOVE_ENDED, Some("done"))
        );
    }
    let l = log[&lie.0].last().cloned().unwrap();
    println!(
        "lie: receipt entries {:?}, ends on {} at {:?} µm",
        lie.1,
        replica::world_model::show(l.3),
        l.4
    );
    assert_eq!(l.3, bed(), "lying: in the bed's slot");
    let stand = Vec3::new(bed_at().x, 0, bed_at().z + 300_000);
    let r = log[&rise.0].last().cloned().unwrap();
    assert!(
        near(r.4, stand, 1_000),
        "standing on the bed's stand point: {:?}",
        r.4
    );
}

fn soul(counter: u64) -> Id {
    Id::new(Scope([7; 16]), counter).unwrap()
}

/// C14: N2's test world with its Soul (A, west of the square) and three chairs (`worldd::testbodies`), and three more
/// Souls: E beside the chair at the square's west edge, C west of the west chair, D in the square.
fn c14_bodies() -> Result<Bodies, replica::effects::Refusal> {
    let mut b = worldd::testbodies::bodies()?;
    let ground = b.pose(worldd::testbodies::body()).unwrap().0;
    for (who, x, z) in [
        (9_010, -26_000_000, 22_500_000),
        (9_011, -40_000_000, 34_000_000),
        (9_012, 5_000_000, 5_000_000),
    ] {
        let at = b.town.surfaces[&ground].place(
            soul(who),
            Frame {
                node: ground,
                slot: None,
            },
            Vec3::new(x, 0, z),
            Quat::IDENTITY,
        )?;
        b.add_body(humanoid(), at)?;
    }
    Ok(b)
}

/// The move a started entry says its intent took (C14): its rank and its target.
fn took(log: &[u8], intent: Id) -> (u64, Option<Id>) {
    for r in recover(log)
        .unwrap()
        .records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
    {
        for e in Part::read(&r).unwrap().effects {
            if e.envelope.cause != Cause::Intent(intent) {
                continue;
            }
            for ev in e.events.iter().flatten() {
                if ev.name.as_str() == MOVE_STARTED {
                    let Some(Value::Uint(rank)) = ev.fields.get(&5) else {
                        panic!("a rank")
                    };
                    return (*rank, ev.fields.get(&6).map(|t| read_id(t).unwrap()));
                }
            }
        }
    }
    panic!("no move started")
}

type Answered = Result<(Id, Vec<u64>), String>;

/// C14 A1-A3: a walk to the square gets a receipt, ending on a standing spot in it; a sit whose first seat is taken
/// takes its second, named in its started entry, and a list with none free is refused by name; and each local verdict
/// a client gets from `replica::move_check` (on its copy, and what its own receipts say of its posture) is the
/// world's answer.
#[test]
fn c14_a_walk_to_a_place_ranked_fallbacks_and_the_local_check() {
    let w = testworld::generate(1, 0).expect("the test world");
    let im = import_eden::load(&w.text).expect("the test world loads");
    let square = im.nodes["square"];
    // The client's copy, built by the tree's own apply, as a client's is: it holds the square, not the chairs.
    let root = im.tree.node(im.tree.root()).unwrap();
    let mut copy = Tree::start(root.id(), root.kind().clone());
    copy.apply(
        &Header::read(&im.log.0).unwrap(),
        &Part::read(&im.log.1).unwrap(),
    )
    .unwrap();
    let chairs: Vec<Id> = worldd::testbodies::chairs().iter().map(|c| c.1).collect();
    let (west, edge, middle_chair) = (chairs[0], chairs[1], chairs[2]);
    let (a, e, c, d) = (body_id(), soul(9_010), soul(9_011), soul(9_012));

    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| c14_bodies()));
    let world = answers::start(
        toggles::World::build(0, 0, 0).replica,
        toggles::rules(),
        store.clone(),
        cfg,
    )
    .expect("the world starts");
    let path = std::env::temp_dir().join(format!("c14-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    let (ready, accepted) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ready.send(()).unwrap();
        answers::serve(door, stream);
    });
    let stream = UnixStream::connect(&path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    accepted.recv().unwrap();
    let mut cl = Client(stream);
    let mut seq: BTreeMap<Id, u64> = BTreeMap::new();
    let mut go = |who: Id, verb: &str, t: Option<Id>, fb: &[Id]| {
        let s = seq.entry(who).or_default();
        *s += 1;
        cl.send_as(who, *s, verb, t.map(Target::Node), fb);
        cl.answer()
    };
    // A3: the client's verdict, from its copy (`has`) and its own receipts (`seated`), against the world's answer.
    let hex = |i: Id| format!("{}-{}", replica::encode::to_hex(&i.scope().0), i.counter());
    let local = |verb: &str, t: Option<Id>, seated: bool| {
        let this = t.map_or(String::new(), |t| format!(r#","this":"{}""#, hex(t)));
        let has = t.is_some_and(|t| copy.handle(t).is_some());
        move_check(&format!(
            r#"{{"verb":"{verb}"{this},"has":{has},"seated":{seated}}}"#
        ))
    };
    let mut agreed = Vec::new();
    let mut agree = |what: &str, verdict: String, world: &Answered| {
        let want = match world {
            Ok(_) => r#"{"verdict":"yes"}"#.to_owned(),
            Err(r) => format!(r#"{{"verdict":"no","reason":"{r}"}}"#),
        };
        assert_eq!(verdict, want, "{what}: the local verdict is the world's");
        agreed.push(format!("{what}: {verdict}"));
    };

    let r = go(a, "eden:walk", None, &[]);
    agree("walk, no target", local("eden:walk", None, false), &r);
    let r = go(a, "eden:rise", None, &[]);
    agree("rise, standing", local("eden:rise", None, false), &r);
    // A1: a walk to the square, a place with no seat and no point.
    let r = go(d, "eden:walk", Some(square), &[]);
    agree(
        "walk to the square",
        local("eden:walk", Some(square), false),
        &r,
    );
    let walk = r.expect("the walk to the square gets a receipt");
    // A2: A takes the west chair; E, beside the edge chair, sits with the west chair first and the edge chair second.
    go(a, "eden:walk", Some(west), &[]).expect("A walks to the west chair");
    go(a, "eden:sit", Some(west), &[]).expect("A sits in the west chair");
    go(e, "eden:walk", Some(edge), &[]).expect("E walks to the edge chair");
    let sat = go(e, "eden:sit", Some(west), &[edge]).expect("E takes its second seat");
    let none = go(c, "eden:sit", Some(west), &[edge]);
    assert_eq!(
        none,
        Err("place-taken".into()),
        "none free: refused by name"
    );
    // A3 again, A seated.
    let r = go(a, "eden:walk", Some(square), &[]);
    agree("walk, seated", local("eden:walk", Some(square), true), &r);
    let r = go(a, "eden:sit", Some(middle_chair), &[]);
    agree(
        "sit, seated",
        local("eden:sit", Some(middle_chair), true),
        &r,
    );
    let r = go(a, "eden:rise", None, &[]);
    agree("rise, seated", local("eden:rise", None, true), &r);
    world.stop();
    let _ = std::fs::remove_file(&path);

    let bytes = store.0.lock().unwrap().bytes.clone();
    let log = logged(&bytes);
    let end = log[&walk.0].last().cloned().unwrap();
    println!(
        "walk to the square: receipt {:?}, ended {:?} on {} at {:?} um",
        walk.1,
        end.2,
        replica::world_model::show(end.3),
        end.4
    );
    assert_eq!(end.2.as_deref(), Some("done"));
    assert!(
        end.4[0].abs() <= 30_000_000 && end.4[2].abs() <= 30_000_000,
        "standing in the square: {:?}",
        end.4
    );
    assert_eq!(took(&bytes, walk.0), (0, Some(square)));
    assert_eq!(
        took(&bytes, sat.0),
        (1, Some(edge)),
        "the sit names its second candidate"
    );
    assert_eq!(
        log[&sat.0].last().unwrap().3,
        edge,
        "E sits in the edge chair"
    );
    for l in agreed {
        println!("local = world: {l}");
    }
}

/// The world on a socket, its acts ending `deadline` µs after receipt, and a client on it.
fn served(deadline: i64, tag: &str) -> (answers::World, Client, Mem, std::path::PathBuf) {
    served_with(deadline, tag, bodies)
}

fn served_with(
    deadline: i64,
    tag: &str,
    make: fn() -> Result<Bodies, replica::effects::Refusal>,
) -> (answers::World, Client, Mem, std::path::PathBuf) {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.deadline = deadline;
    cfg.bodies = Some(Box::new(move |_: &worldd::bodies::Placed| make()));
    let world = answers::start(
        toggles::World::build(0, 0, 0).replica,
        toggles::rules(),
        store.clone(),
        cfg,
    )
    .expect("the world starts");
    let path = std::env::temp_dir().join(format!("{tag}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    let (ready, accepted) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ready.send(()).unwrap();
        answers::serve(door, stream);
    });
    let stream = UnixStream::connect(&path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    accepted.recv().unwrap();
    (world, Client(stream), store, path)
}

/// Each tick's record, in order: its move events (entry, intent, event, how) and the body rows it wrote (body,
/// position).
type Tick = (Vec<(u64, Id, String, Option<String>)>, Vec<(Id, Vec3)>);

fn ticks(log: &[u8]) -> Vec<Tick> {
    let mut out = Vec::new();
    for r in recover(log)
        .unwrap()
        .records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
    {
        let part = Part::read(&r).unwrap();
        let mut events = Vec::new();
        for e in &part.effects {
            let Cause::Intent(id) = e.envelope.cause else {
                continue;
            };
            for ev in e.events.iter().flatten() {
                let how = ev.fields.get(&2).map(|v| match v {
                    Value::Bytes(b) => String::from_utf8(b.clone()).unwrap(),
                    _ => panic!("a name"),
                });
                events.push((e.envelope.sequence, id, ev.name.as_str().to_owned(), how));
            }
        }
        let rows = match part.rest.get(&answers::BODIES) {
            Some(Value::Array(rows)) => rows
                .iter()
                .filter_map(worldd::bodies::read_row)
                .map(|(b, p, _)| (b, p.position))
                .collect(),
            _ => Vec::new(),
        };
        out.push((events, rows));
    }
    out
}

/// The tick whose record holds `event` of intent `id`, with that event's entry and how it ended.
fn tick_of(ticks: &[Tick], id: Id, event: &str) -> (usize, u64, Option<String>) {
    for (k, (events, _)) in ticks.iter().enumerate() {
        if let Some(e) = events.iter().find(|e| e.1 == id && e.2 == event) {
            return (k, e.0, e.3.clone());
        }
    }
    panic!("no {event} for {id:?}")
}

/// A walk whose explicit expiry passes mid-move stops in the tick its deadline passes: its end is written in that tick by the
/// deadline's name, `act.timed-out`, and the body is not moved after it. In lockstep, so its expiry is world time from
/// the tick it arrives at, whatever the machine's load: on the machine's clock it could pass before the intent arrived
/// (`intent.expired`).
#[test]
fn a_walk_whose_act_times_out_mid_move_stops_and_ends_by_name() {
    // The walk is about 4 m, near 3 s; the caller explicitly permits only 1 s (C29).
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.deadline = 10_000_000;
    cfg.lockstep = true;
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    let world = answers::start(
        toggles::World::build(0, 0, 0).replica,
        toggles::rules(),
        store.clone(),
        cfg,
    )
    .expect("the world starts");
    // World time starts at 0 in lockstep: the intent arrives at tick 0 and expires 1 s on.
    let (reply, rx) = channel();
    let bytes = intent_bytes(
        body_id(),
        1,
        "eden:walk",
        Some(Target::Node(thing())),
        &[],
        1_000_000,
    );
    world
        .events
        .send(answers::Event::ArrivalAt {
            tick: 0,
            bytes,
            reply,
        })
        .unwrap();
    // 5 s of world time: the walk would have arrived by then.
    let (done, ran) = channel();
    world
        .events
        .send(answers::Event::RunTo { tick: 100, done })
        .unwrap();
    ran.recv().unwrap();
    // Accepted as its route is planned (C20, W11 #4087), with what is left of its 1 s; then its end.
    let frame = rx.recv_timeout(Duration::from_secs(20)).expect("an answer");
    assert!(answers::is_progress(&frame), "accepted first");
    let frame = rx.recv_timeout(Duration::from_secs(20)).expect("an answer");
    assert_eq!(read_answer(&frame), Err("act.timed-out".into()));
    world.stop();

    let bytes = store.0.lock().unwrap().bytes.clone();
    let log = logged(&bytes);
    assert_eq!(log.len(), 1, "one intent");
    let (&id, l) = log.iter().next().unwrap();
    let events: Vec<(&str, Option<&str>)> =
        l.iter().map(|e| (e.1.as_str(), e.2.as_deref())).collect();
    assert_eq!(
        events,
        [
            (MOVE_STARTED, None),
            (answers::ACT_DEADLINE, None),
            (MOVE_ENDED, Some("act.timed-out"))
        ],
        "the move started and ended by the deadline's name"
    );
    let stopped = l.last().unwrap().4;
    let stand = Vec3::new(seat_at().x, 0, seat_at().z + 300_000);
    assert!(
        !near(stopped, start(), 300_000) && !near(stopped, stand, 300_000),
        "stopped mid-way: {stopped:?}"
    );
    let ticks = ticks(&bytes);
    let (k, _, _) = tick_of(&ticks, id, MOVE_ENDED);
    for (n, (_, rows)) in ticks.iter().enumerate().skip(k) {
        for &(_, p) in rows.iter().filter(|r| r.0 == body_id()) {
            assert!(
                n == k && [p.x, p.y, p.z] == stopped,
                "the body moved after its act ended: tick +{} at {p:?}, stopped at {stopped:?}",
                n - k
            );
        }
    }
    println!(
        "timed out: stopped at {stopped:?} um; {} later records, none moving the body",
        ticks.len() - k - 1
    );
}

/// W11 (#4087), A3: the same 4 m walk with its route planned in the next tick and with the planner's answers held back
/// for `late` ticks. Lockstep, so the planner's batches are taken by the body schedule (K18b's replay control). Returns
/// the act deadline's distance from the tick that wrote it (the planning tick), the planning tick's time and how the
/// walk ended.
fn walk_planned_late(late: i64) -> (i64, i64, String) {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.deadline = 10_000_000;
    cfg.lockstep = true;
    cfg.bodies = Some(Box::new(move |_: &worldd::bodies::Placed| {
        let mut b = bodies()?;
        // Body ticks 1..=late take none of the planner's batches: the route arrives after them.
        for t in 1..=late {
            b.schedule.insert(t * 50_000, 0);
        }
        Ok(b)
    }));
    let world = answers::start(
        toggles::World::build(0, 0, 0).replica,
        toggles::rules(),
        store.clone(),
        cfg,
    )
    .expect("the world starts");
    let (reply, rx) = channel();
    let bytes = intent_bytes(
        body_id(),
        1,
        "eden:walk",
        Some(Target::Node(thing())),
        &[],
        60_000_000,
    );
    world
        .events
        .send(answers::Event::ArrivalAt {
            tick: 0,
            bytes,
            reply,
        })
        .unwrap();
    let (done, ran) = channel();
    world
        .events
        .send(answers::Event::RunTo { tick: 400, done })
        .unwrap();
    ran.recv().unwrap();
    let frame = rx.recv_timeout(Duration::from_secs(20)).expect("an answer");
    assert!(
        answers::is_progress(&frame),
        "accepted as its route is planned"
    );
    let frame = rx.recv_timeout(Duration::from_secs(20)).expect("an answer");
    assert!(!answers::is_progress(&frame), "one progress answer");
    let answered = read_answer(&frame);
    world.stop();
    let bytes = store.0.lock().unwrap().bytes.clone();
    let mut deadline = None;
    for r in recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            for ev in e.events.unwrap_or_default() {
                if ev.name.as_str() == answers::ACT_DEADLINE {
                    let Some(Value::Uint(n)) = ev.fields.get(&5) else {
                        panic!("deadline")
                    };
                    deadline = Some((*n as i64 - e.envelope.at, e.envelope.at));
                }
            }
        }
    }
    let (span, planned) = deadline.expect("the walk's deadline entry");
    let how = match answered {
        Ok(_) => "done".to_owned(),
        Err(r) => r,
    };
    (span, planned, how)
}

/// W11 (#4087), A3: a walk's deadline is its route's time from the tick its route is planned, not from the move's
/// start. With its route 6 s late, the walk keeps the same span as one planned at once, and arrives; counted from its
/// start (the old rule), its 4 m route's 8 s would have had 2 s left when it could first walk, and it ended
/// `act.timed-out` on its way.
#[test]
fn a_walk_whose_route_comes_late_keeps_its_whole_route_time_and_arrives() {
    let (prompt, prompt_at, prompt_how) = walk_planned_late(0);
    let (late, late_at, late_how) = walk_planned_late(120);
    println!(
        "planned at {prompt_at} us: span {prompt} us, {prompt_how}; planned at {late_at} us: span {late} us, {late_how}"
    );
    assert!(late_at >= prompt_at + 6_000_000, "the route came 6 s later");
    assert_eq!(
        late, prompt,
        "the same route's time, counted from its planning tick"
    );
    assert_eq!(prompt_how, "done");
    assert_eq!(late_how, "done", "the late walk arrives, not timed out");
}

/// W11 (#4087): a Soul's answers reach it in version order. Its walk's route is planned a tick or two after the walk
/// starts, and in each of those ticks the same Soul's sit on bare ground is refused at the moves' start, after the
/// bodies stepped, so its refusal is framed after the walk's deadline entry raised the version. Every frame on the one
/// stream the Soul's answers share carries a version no older than the frame before it; the walk has one progress
/// answer and the sits none.
#[test]
fn a_souls_answers_keep_version_order_when_its_walk_is_accepted() {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.deadline = 10_000_000;
    cfg.lockstep = true;
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    let world = answers::start(
        toggles::World::build(0, 0, 0).replica,
        toggles::rules(),
        store,
        cfg,
    )
    .expect("the world starts");
    let ground = bodies().unwrap().town.ground;
    let (reply, rx) = channel();
    let walk = intent_bytes(
        body_id(),
        1,
        "eden:walk",
        Some(Target::Node(thing())),
        &[],
        60_000_000,
    );
    world
        .events
        .send(answers::Event::ArrivalAt {
            tick: 0,
            bytes: walk,
            reply: reply.clone(),
        })
        .unwrap();
    for (tick, sequence) in (1..=4).zip(2..) {
        // A ranked sit (C14) with no free place among its candidates is refused before it would replace the walk.
        let sit = intent_bytes(
            body_id(),
            sequence,
            "eden:sit",
            Some(Target::Node(ground)),
            &[ground],
            60_000_000,
        );
        world
            .events
            .send(answers::Event::ArrivalAt {
                tick,
                bytes: sit,
                reply: reply.clone(),
            })
            .unwrap();
    }
    drop(reply);
    let (done, ran) = channel();
    world
        .events
        .send(answers::Event::RunTo { tick: 200, done })
        .unwrap();
    ran.recv().unwrap();
    world.stop();
    let mut seen = Vec::new();
    while let Ok(frame) = rx.recv_timeout(Duration::from_secs(5)) {
        let Value::Map(m) = decode(&frame).unwrap().value else {
            panic!("a frame")
        };
        let Some(Value::Array(v)) = m.get(&1) else {
            panic!("a version")
        };
        let Some(Value::Uint(version)) = v.get(3) else {
            panic!("a version's sequence")
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            panic!("an answer")
        };
        let Some(Value::Uint(sequence)) = a.get(&2) else {
            panic!("a sequence")
        };
        let how = match answers::is_progress(&frame) {
            true => "accepted".to_owned(),
            false => match read_answer(&frame) {
                Ok(_) => "done".to_owned(),
                Err(r) => r,
            },
        };
        seen.push((*version, *sequence, how));
    }
    println!("one Soul's stream (version, sequence, answer): {seen:?}");
    for w in seen.windows(2) {
        assert!(
            w[1].0 >= w[0].0,
            "a version went back on the stream: {seen:?}"
        );
    }
    let of = |s: u64| -> Vec<&str> {
        seen.iter()
            .filter(|f| f.1 == s)
            .map(|f| f.2.as_str())
            .collect()
    };
    assert_eq!(
        of(1),
        ["accepted", "done"],
        "the walk: one progress answer, then done"
    );
    for s in 2..=5 {
        let sit = of(s);
        assert!(
            sit.len() == 1 && sit[0] != "accepted" && sit[0] != "done",
            "sit {s}: one refusal, no progress answer: {sit:?}"
        );
    }
}

/// A walk ended mid-move by a new move of the same body (`claim-taken`) stops in the tick the new move starts: its end
/// is written in that tick, before the new move's start.
#[test]
fn a_walk_cancelled_mid_move_by_a_new_move_ends_in_the_same_tick() {
    let (world, mut c, store, path) = served(10_000_000, "replaced");
    c.send(1, "eden:walk", Some(thing()));
    std::thread::sleep(Duration::from_millis(800));
    c.send(2, "eden:walk", Some(thing()));
    assert_eq!(c.answer(), Err("claim-taken".into()), "the walk gave way");
    let (second, _) = c.answer().expect("the second walk is done");
    world.stop();
    let _ = std::fs::remove_file(&path);

    let bytes = store.0.lock().unwrap().bytes.clone();
    let log = logged(&bytes);
    let first = *log.keys().find(|&&i| i != second).expect("the first walk");
    let ticks = ticks(&bytes);
    let (ended, entry, how) = tick_of(&ticks, first, MOVE_ENDED);
    let (started, next, _) = tick_of(&ticks, second, MOVE_STARTED);
    assert_eq!(how.as_deref(), Some("claim-taken"));
    assert_eq!(
        ended, started,
        "the first walk's end is in the tick the second starts"
    );
    assert!(entry < next, "and written before it");
}

/// C19 beside C14: a partially occupied thing remains eligible, both bare and first in a ranked list.
fn multi_slot_eligibility(ranked: bool) {
    use worldd::bodies::{Ask, Asked};
    type Admission = (Result<(), String>, Option<(usize, Option<Id>)>);

    fn sit(b: &mut Bodies, body: Id, target: Id, fallbacks: &[Id], sequence: u64) -> Admission {
        let intent = soul(20_000 + sequence);
        let ask = Asked {
            body,
            actor: Actor::Soul(body),
            ask: Ask::Sit { thing: target },
            fallbacks: fallbacks.iter().map(|&thing| Ask::Sit { thing }).collect(),
        };
        let mut started = b.start(vec![(intent, ask)]);
        if started.is_empty() {
            b.step(b.runner.now + b.runner.tick);
            started = b.start(Vec::new());
        }
        let result = started.remove(0).1.map_err(|r| r.name.to_owned());
        (result, b.took(intent))
    }

    let (town, ground) = town();
    let mut starts = Vec::new();
    let people: Vec<Id> = (0..5).map(|n| soul(10_000 + n)).collect();
    for (i, &person) in people.iter().enumerate() {
        let (x, z) = if i < 4 {
            (-37_000_000 + i as i64 * 1_000_000, 30_300_000)
        } else {
            (-34_000_000, 31_300_000)
        };
        let placed = town.surfaces[&ground]
            .place(
                person,
                Frame {
                    node: ground,
                    slot: None,
                },
                Vec3::new(x, 0, z),
                Quat::IDENTITY,
            )
            .unwrap();
        starts.push(placed);
    }
    let mut b = Bodies::new(town, 50_000).unwrap();
    for placed in starts {
        b.add_body(humanoid(), placed).unwrap();
    }
    for slot in 1..=3 {
        b.add_place(PlaceAt {
            thing: thing(),
            place: Place {
                slot,
                height: 450_000,
                stand: [0, 300_000],
            },
            point: Vec3::new(-38_000_000 + slot as i64 * 1_000_000, 450_000, 30_000_000),
            facing: Quat::IDENTITY,
            floor: ground,
        })
        .unwrap();
    }
    b.add_place(PlaceAt {
        thing: bed(),
        place: Place {
            slot: 1,
            height: 450_000,
            stand: [0, 300_000],
        },
        point: Vec3::new(-34_000_000, 450_000, 30_000_000),
        facing: Quat::IDENTITY,
        floor: ground,
    })
    .unwrap();
    b.begin(0);
    assert_eq!(
        sit(&mut b, people[4], ground, &[], 1).0,
        Err("place-unknown".into()),
        "a known non-seat keeps its refusal"
    );
    assert_eq!(
        sit(&mut b, people[4], soul(99_999), &[], 2).0,
        Err("place-unknown".into()),
        "an unknown seat keeps its refusal"
    );
    assert_eq!(sit(&mut b, people[0], thing(), &[], 3).0, Ok(()));
    let fallback = [bed()];
    let partial = sit(
        &mut b,
        people[1],
        thing(),
        if ranked { &fallback } else { &[] },
        4,
    );
    assert_eq!(
        partial.0,
        Ok(()),
        "one occupied slot leaves the other slots eligible"
    );
    assert_eq!(
        partial.1,
        Some((0, Some(thing()))),
        "the partially occupied primary is selected"
    );
    assert_eq!(
        sit(&mut b, people[2], thing(), &[], 5).0,
        Ok(()),
        "the third slot remains eligible"
    );
    let full = sit(&mut b, people[3], thing(), &fallback, 6);
    assert_eq!(full.0, Ok(()), "a full primary selects its free fallback");
    assert_eq!(full.1, Some((1, Some(bed()))));
    assert_eq!(
        sit(&mut b, people[4], thing(), &fallback, 7).0,
        Err("place-taken".into()),
        "a fully occupied list is refused"
    );
    assert!(
        b.step(1_100_000).iter().all(|(_, r)| r.is_ok()),
        "every admitted sit completes through the controller"
    );
    let placed = b.placed();
    for (i, person) in people.iter().take(3).enumerate() {
        assert_eq!(
            (placed[person].0.frame.node, placed[person].0.frame.slot),
            (thing(), Some(i as u64 + 1))
        );
    }
    assert_eq!(
        (
            placed[&people[3]].0.frame.node,
            placed[&people[3]].0.frame.slot
        ),
        (bed(), Some(1))
    );
}

#[test]
fn c19_a_partly_occupied_thing_accepts_a_bare_sit() {
    multi_slot_eligibility(false);
}

#[test]
fn c19_a_partly_occupied_primary_precedes_its_ranked_fallback() {
    multi_slot_eligibility(true);
}

/// C29: the unchanged 20 m B7b leader distance must outlive the default 10 s and arrive, with exactly one C20
/// progress frame and a route deadline entry named in its receipt. W11 (#4087): the progress frame, the act's
/// "accepted", comes within 2 s of the send (as its route is planned), not at the 10 s arrival deadline.
#[test]
// Times the first answer from the send by the wall clock, as the gateway sees it.
#[allow(clippy::disallowed_methods)]
fn a_twenty_metre_gateway_walk_gets_one_progress_answer_and_arrives() {
    let (world, mut c, store, path) = served(10_000_000, "longwalk");
    let ground = bodies().unwrap().town.ground;
    let destination = Vec3::new(start().x - 20_000_000, 0, start().z);
    let i = Intent {
        actor: Actor::Soul(body_id()),
        verb: name("eden:walk"),
        target: Some(Target::Node(ground)),
        parameters: BTreeMap::from([(
            1,
            Value::Array(
                [destination.x, destination.y, destination.z]
                    .into_iter()
                    .map(|n| {
                        if n < 0 {
                            Value::Nint(n.unsigned_abs() - 1)
                        } else {
                            Value::Uint(n as u64)
                        }
                    })
                    .collect(),
            ),
        )]),
        sequence: 1,
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
    let bytes = encode(&i.to_value()).unwrap();
    let sent = std::time::Instant::now();
    c.0.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .unwrap();
    c.0.write_all(&bytes).unwrap();
    let mut len = [0; 4];
    c.0.read_exact(&mut len).unwrap();
    let mut frame = vec![0; u32::from_be_bytes(len) as usize];
    c.0.read_exact(&mut frame).unwrap();
    let accepted = sent.elapsed();
    let Value::Map(m) = decode(&frame).unwrap().value else {
        panic!("frame")
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        panic!("answer")
    };
    assert_eq!(a.get(&3), Some(&Value::Uint(3)), "one in-progress answer");
    // 2 s is the bar; a loaded CI runner gets 5 s, and the measured time is printed either way.
    let most = Duration::from_secs(if std::env::var_os("CI").is_some() {
        5
    } else {
        2
    });
    println!("20 m: accepted after {accepted:?} (bar {most:?})");
    assert!(
        accepted < most,
        "accepted within {most:?} of its send, not at the arrival deadline: {accepted:?}"
    );
    assert!(matches!(a.get(&answers::LEFT), Some(Value::Uint(n)) if *n > 0));
    // Exactly one progress answer: the next frame is the act's own answer.
    let mut len = [0; 4];
    c.0.read_exact(&mut len).unwrap();
    let mut frame = vec![0; u32::from_be_bytes(len) as usize];
    c.0.read_exact(&mut frame).unwrap();
    assert!(!answers::is_progress(&frame), "a second progress answer");
    let (id, receipt) = read_answer(&frame).expect("the next answer is the final receipt");
    world.stop();
    let _ = std::fs::remove_file(&path);
    let bytes = store.0.lock().unwrap().bytes.clone();
    let mut due = None;
    for r in recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            if e.envelope.cause != Cause::Intent(id) {
                continue;
            }
            for ev in e.events.unwrap_or_default() {
                if ev.name.as_str() == answers::ACT_DEADLINE {
                    assert!(receipt.contains(&e.envelope.sequence));
                    let Some(Value::Uint(n)) = ev.fields.get(&5) else {
                        panic!("deadline")
                    };
                    due = Some((*n as i64) - e.envelope.at);
                }
            }
        }
    }
    assert!(due.is_some_and(|d| d > 14_000_000 && d <= 180_000_000));
    let log = logged(&bytes);
    let end = log[&id].last().unwrap();
    assert_eq!(end.2.as_deref(), Some("done"));
    assert!(near(end.4, destination, 100_000), "arrived: {:?}", end.4);
    println!("20 m: one progress answer, then done; receipt {receipt:?}; planned time {due:?}");
}

/// A synthetic mover edge across an otherwise planned route reproduces a walker making no progress. The test
/// keeps the map unchanged deliberately: it exercises the never-stuck ladder as a stale route or a blocked walker would.
fn stalled_bodies() -> Result<Bodies, replica::effects::Refusal> {
    let mut b = bodies()?;
    let ground = b.town.ground;
    let (x, z) = (
        i32::try_from(start().x / 1000).unwrap(),
        i32::try_from(start().z / 1000).unwrap(),
    );
    let corners = vec![
        [x - 100, 0, z - 100],
        [x + 100, 0, z - 100],
        [x + 100, 0, z + 100],
        [x - 100, 0, z + 100],
    ];
    let surface = sim::mover::Surface::new(
        ground,
        vec![sim::ground::Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 1, 2], [0, 2, 3]],
            ground: sim::gaits::Ground::Dry,
        }],
    );
    let placed = surface.place(
        body_id(),
        Frame {
            node: ground,
            slot: None,
        },
        start(),
        Quat::IDENTITY,
    )?;
    b.runner.controller.regrounded(body_id(), Some(placed))?;
    b.town.surfaces.insert(ground, surface);
    Ok(b)
}

/// A stalled gateway walk is the never-stuck ladder's (0.133 N1): routed again at 3 s, a shoulder turn at 9 s, and at
/// 15 s its order ends by name, `goal-unreachable` (before, C21's watch ended it `walk.blocked` at 3 s); its body is
/// released in its ending tick.
#[test]
fn a_stalled_gateway_walk_ends_goal_unreachable_and_releases_its_body() {
    let (world, mut c, store, path) = served_with(10_000_000, "blockedwalk", stalled_bodies);
    c.send(1, "eden:walk", Some(thing()));
    assert_eq!(c.answer(), Err("goal-unreachable".into()));
    std::thread::sleep(Duration::from_millis(150));
    world.stop();
    let _ = std::fs::remove_file(&path);
    let bytes = store.0.lock().unwrap().bytes.clone();
    let log = logged(&bytes);
    let (&id, l) = log.iter().next().unwrap();
    assert_eq!(l.last().unwrap().2.as_deref(), Some("goal-unreachable"));
    let ticks = ticks(&bytes);
    let (end, _, _) = tick_of(&ticks, id, MOVE_ENDED);
    assert!(
        ticks
            .iter()
            .skip(end + 1)
            .all(|(_, rows)| rows.iter().all(|r| r.0 != body_id())),
        "stopped in its ending tick"
    );
}

/// A free slot can change after the planner question: each current selection must use its own cached distance.
fn exact_slot_reach(first_is_near: bool, replace_pending: bool) {
    use worldd::bodies::{Ask, Asked};
    let (town, ground) = town();
    let people = [soul(40_001), soul(40_002)];
    let positions = [
        Vec3::new(-37_000_000, 0, 30_300_000),
        Vec3::new(-37_400_000, 0, 30_300_000),
    ];
    let placed: Vec<_> = people
        .iter()
        .zip(positions)
        .map(|(&body, at)| {
            town.surfaces[&ground]
                .place(
                    body,
                    Frame {
                        node: ground,
                        slot: None,
                    },
                    at,
                    Quat::IDENTITY,
                )
                .unwrap()
        })
        .collect();
    let mut b = Bodies::new(town, 50_000).unwrap();
    for at in placed {
        b.add_body(humanoid(), at).unwrap();
    }
    for slot in 1..=2 {
        let near = (slot == 1) == first_is_near;
        b.add_place(PlaceAt {
            thing: thing(),
            place: Place {
                slot,
                height: 450_000,
                stand: [0, 300_000],
            },
            point: Vec3::new(
                if near { -37_000_000 } else { -34_000_000 },
                450_000,
                30_000_000,
            ),
            facing: Quat::IDENTITY,
            floor: ground,
        })
        .unwrap();
    }
    b.begin(0);
    if replace_pending {
        assert!(
            b.start(vec![(
                soul(40_999),
                Asked {
                    body: people[0],
                    actor: Actor::Soul(people[0]),
                    ask: Ask::Sit { thing: thing() },
                    fallbacks: vec![]
                }
            )])
            .is_empty()
        );
    }
    let asks = people
        .iter()
        .take(if first_is_near { 2 } else { 1 })
        .enumerate()
        .map(|(i, &body)| {
            (
                soul(41_000 + i as u64),
                Asked {
                    body,
                    actor: Actor::Soul(body),
                    ask: Ask::Sit { thing: thing() },
                    fallbacks: vec![],
                },
            )
        })
        .collect();
    assert!(
        b.start(asks).is_empty(),
        "reach waits for the off-clock planner"
    );
    // Mark only after construction: routes/reach now must run on the planner thread, never this clock thread.
    sim::commit::mark_clock_thread();
    let replaced = b.step(50_000);
    if replace_pending {
        assert_eq!(
            replaced,
            vec![(soul(40_999), Err("claim-taken".into()))],
            "the old order ends before the replacement's admission; its in-flight reply is stale"
        );
    }
    let started = b.start(Vec::new());
    assert_eq!(started[0].0, soul(41_000));
    assert!(
        started[0].1.is_ok(),
        "the nearest exact slot is within reach: {:?}",
        started[0]
    );
    if first_is_near {
        assert_eq!(started[1].0, soul(41_001));
        assert_eq!(
            started[1].1.as_ref().unwrap_err().name,
            "out-of-reach",
            "the next request cannot reuse the occupied near slot's distance for the far free slot"
        );
    }
    assert!(b.step(1_100_000).iter().all(|(_, r)| r.is_ok()));
    assert_eq!(
        b.placed()[&people[0]].0.frame.slot,
        Some(if first_is_near { 1 } else { 2 })
    );
    assert!(b.slots.held_by(people[1]).is_none());
}

#[test]
fn c19_planner_selected_slot_uses_its_own_reach_when_first_slot_is_far() {
    exact_slot_reach(false, false);
}

#[test]
fn c19_planner_changed_free_slot_cannot_reuse_another_slots_distance() {
    exact_slot_reach(true, false);
}

#[test]
fn c19_planner_replaced_order_cannot_admit_from_its_old_reply() {
    exact_slot_reach(false, true);
}

/// A mapped world's bodies use world tick time; its socket and clock keep ordinary real pacing.
#[test]
fn a_mapped_world_steps_its_direct_ground_walk_in_world_time() {
    use replica::effects::{Body, Effect, Envelope, Rest};
    use replica::time::{Mapping, TimeEffect};
    use replica::world_model::Audience;
    let mut replica = toggles::World::build(0, 0, 0).replica;
    let mapping = Mapping::new(0, answers::now() - 1_000_000, 1, 1).unwrap();
    let effect = Effect {
        envelope: Envelope {
            sequence: replica.version(),
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: replica.header().zone,
        },
        body: Body::Time(vec![TimeEffect::Mapping(mapping)]),
        events: None,
        rest: Rest::new(),
    };
    let part = Part::read(
        &encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(replica.header().hash().to_bytes())),
            (2, Value::Array(vec![effect.to_value()])),
        ])))
        .unwrap(),
    )
    .unwrap();
    replica.apply(&part).unwrap();
    let (_, ground) = town();
    let target = Vec3::new(start().x + 1_000_000, start().y, start().z);
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.rate = Some((1, 1));
    cfg.bodies = Some(Box::new(|_| bodies()));
    let world = answers::start(replica, toggles::rules(), store.clone(), cfg).unwrap();
    let (client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let door = world.door();
    let gateway = std::thread::spawn(move || answers::serve(door, server));
    let int = |n: i64| {
        if n >= 0 {
            Value::Uint(n as u64)
        } else {
            Value::Nint(n.unsigned_abs() - 1)
        }
    };
    let intent = Intent {
        actor: Actor::Soul(body_id()),
        verb: name("eden:walk"),
        target: Some(Target::Node(ground)),
        parameters: BTreeMap::from([(
            1,
            Value::Array(
                [target.x, target.y, target.z]
                    .into_iter()
                    .map(int)
                    .collect(),
            ),
        )]),
        sequence: 1,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: i64::MAX,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let bytes = encode(&intent.to_value()).unwrap();
    let mut c = Client(client);
    let before_walk = world.beat.read();
    c.0.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .unwrap();
    c.0.write_all(&bytes).unwrap();
    let answered = c.answer();
    let beat = world.beat.read();
    drop(c);
    world.stop();
    gateway.join().unwrap();
    let (id, entries) = answered.expect("a mapped world's ordinary walk completes");
    let events = logged(&store.0.lock().unwrap().bytes);
    let walk = &events[&id];
    assert_eq!(entries, walk.iter().map(|e| e.0).collect::<Vec<_>>());
    assert_eq!(walk.first().unwrap().1, MOVE_STARTED);
    let end = walk.last().unwrap();
    assert_eq!(end.1, MOVE_ENDED);
    assert_eq!(end.2.as_deref(), Some("done"));
    assert_eq!(end.3, ground);
    assert!(
        near(end.4, target, 50_000),
        "the authoritative body reaches the supported point"
    );
    assert!(
        beat.0 > before_walk.0,
        "world ticks advance through the actual walk"
    );
    assert!(beat.1 > mapping.real_us, "heartbeat remains on real time");
}

/// #3600 A3: a stool whose seat is 1.0 m up (C22's ordinary stools and wagons, 0.65 to 1.60 m, were refused against the
/// sit move's 0.6 m contact reach) is taken through the gateway by the standard body, within its 2.06 m standing reach:
/// the walk to its stand point, the sit into its slot and the rise back onto the ground, each with its receipt.
#[test]
fn a_seat_one_metre_up_is_walked_to_sat_in_and_risen_from_through_the_gateway() {
    const STOOL: &str = "{1: 1, 2: 1000, 3: [0, 300]}";
    let seat = Vec3::new(seat_at().x, 1_000_000, seat_at().z);
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.bodies = Some(Box::new(move |_: &worldd::bodies::Placed| {
        bodies_with(STOOL, seat)
    }));
    let world = answers::start(
        toggles::World::build(0, 0, 0).replica,
        toggles::rules(),
        store.clone(),
        cfg,
    )
    .expect("the world starts");
    let path = std::env::temp_dir().join(format!("reach-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    let (ready, accepted) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ready.send(()).unwrap();
        answers::serve(door, stream);
    });
    let stream = UnixStream::connect(&path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    accepted.recv().unwrap();
    let mut c = Client(stream);
    let stand = Vec3::new(seat.x, 0, seat.z + 300_000);
    c.send(1, "eden:walk", Some(thing()));
    let walk = c.answer().expect("the walk is done");
    c.send(2, "eden:sit", Some(thing()));
    let sit = c.answer().expect("the sit on the stool is done");
    c.send(3, "eden:rise", None);
    let rise = c.answer().expect("the rise is done");
    world.stop();
    let _ = std::fs::remove_file(&path);

    let log = logged(&store.0.lock().unwrap().bytes);
    for (what, (id, entries)) in [("walk", &walk), ("sit", &sit), ("rise", &rise)] {
        let l = &log[id];
        println!("{what}: receipt entries {entries:?}");
        for e in l {
            println!(
                "  #{} {} {:?} on {} at {:?} µm",
                e.0,
                e.1,
                e.2,
                replica::world_model::show(e.3),
                e.4
            );
        }
        assert_eq!(&l.iter().map(|e| e.0).collect::<Vec<_>>(), entries);
        assert_eq!(
            (l.last().unwrap().1.as_str(), l.last().unwrap().2.as_deref()),
            (MOVE_ENDED, Some("done"))
        );
    }
    let end = |id: &Id| log[id].last().cloned().unwrap();
    let w = end(&walk.0);
    assert!(near(w.4, stand, 60_000), "at the stand point: {:?}", w.4);
    assert_eq!(end(&sit.0).3, thing(), "seated: in the stool's slot");
    let r = end(&rise.0);
    assert_eq!(r.3, w.3, "standing on the ground again");
    assert!(near(r.4, stand, 1_000), "on the stand point: {:?}", r.4);
}

/// #3700 review: a private thing is its owner's alone on the served path too. A bare lie at a bed private to another
/// Soul is refused `object.private` before the bodies take it; a walk up to it is not; a sit on a chair private to the
/// Soul itself is taken. The marks are the bed's and the chair's own fields 143 (owner) and 144 (access 2, private).
#[test]
fn a_bare_lie_at_a_private_bed_is_refused_and_the_owner_sits_on_its_own() {
    use replica::who_may::{F_ACCESS, F_OWNER};
    let mut w = toggles::World::build(0, 0, 0);
    let mark =
        |owner: Id| BTreeMap::from([(F_OWNER, owner.to_value()), (F_ACCESS, Value::Uint(2))]);
    w.item_with(bed(), mark(soul(9_099)));
    w.item_with(thing(), mark(body_id()));
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(50);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies_and_bed()));
    let world = answers::start(w.replica, toggles::rules(), store, cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("private-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    let (ready, accepted) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ready.send(()).unwrap();
        answers::serve(door, stream);
    });
    let stream = UnixStream::connect(&path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    accepted.recv().unwrap();
    let mut c = Client(stream);

    c.send(1, "eden:walk", Some(bed()));
    c.answer().expect("a walk up to a private bed uses nothing");
    c.send(2, "eden:lie", Some(bed()));
    assert_eq!(
        c.answer(),
        Err("object.private".into()),
        "another Soul's private bed"
    );
    c.send(3, "eden:walk", Some(thing()));
    c.answer().expect("the walk to its own chair");
    c.send(4, "eden:sit", Some(thing()));
    c.answer().expect("its own private chair");
    world.stop();
    let _ = std::fs::remove_file(&path);
}

/// #4086: a chair about 100 m from the body's start, across the square (open on its four sides), west of the ring.
fn far_seat() -> Vec3 {
    Vec3::new(55_000_000, 450_000, 0)
}

fn far_chair() -> Result<Bodies, replica::effects::Refusal> {
    bodies_with(CHAIR, far_seat())
}

/// #4086 A2: a walk to a thing about 100 m away (99.6 m to the chair) is a real move, answered only as it goes and when
/// it ends: one progress answer at 10 s, the receipt when the walk ends `done` (about 71 s at walking speed), and the
/// body's rows carry it from its start to the chair's stand point. The answers and when each came, how the walk's
/// entries ended, and where its rows put the body are read from the world's records.
#[test]
fn w10_a2_a_walk_to_a_thing_100_m_away_ends_there() {
    let (world, mut c, store, path) = served_with(10_000_000, "w10far", far_chair);
    c.0.set_read_timeout(Some(Duration::from_secs(240)))
        .unwrap();
    let t0 = answers::now();
    let bytes = intent_bytes(
        body_id(),
        1,
        "eden:walk",
        Some(Target::Node(thing())),
        &[],
        answers::now() + 240_000_000,
    );
    c.0.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .unwrap();
    c.0.write_all(&bytes).unwrap();
    let mut answered = Vec::new();
    let end = loop {
        let mut len = [0u8; 4];
        c.0.read_exact(&mut len).expect("an answer");
        let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
        c.0.read_exact(&mut frame).unwrap();
        let Value::Map(m) = decode(&frame).unwrap().value else {
            panic!("a frame")
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            panic!("an answer")
        };
        answered.push((a.get(&3).cloned(), answers::now() - t0));
        if a.get(&3) != Some(&Value::Uint(3)) {
            break read_answer(&frame);
        }
    };
    world.stop();
    let _ = std::fs::remove_file(&path);
    let log = store.0.lock().unwrap().bytes.clone();
    let ticks = ticks(&log);
    let rows: Vec<Vec3> = ticks
        .iter()
        .flat_map(|(_, r)| r.iter().filter(|(b, _)| *b == body_id()).map(|(_, p)| *p))
        .collect();
    let events: Vec<_> = ticks.iter().flat_map(|(e, _)| e.clone()).collect();
    println!(
        "W10 A2: {end:?}; answers {answered:?}; events {events:?}; first row {:?}, last row {:?}, rows {}",
        rows.first(),
        rows.last(),
        rows.len()
    );
    let (id, receipt) = end.expect("a receipt");
    assert_eq!(answered.len(), 2, "one progress answer, then the receipt");
    assert_eq!(answered[0].0, Some(Value::Uint(3)));
    // 99.6 m at 1.4 m/s is 71 s: nothing answers the walk done before it could have been walked.
    assert!(answered[1].1 > 60_000_000, "{answered:?}");
    let ended = events
        .iter()
        .find(|e| e.1 == id && e.2 == MOVE_ENDED)
        .expect("the walk's end");
    assert_eq!(ended.3.as_deref(), Some("done"));
    assert!(receipt.contains(&ended.0), "the receipt is this walk's");
    let (first, last) = (rows.first().unwrap(), rows.last().unwrap());
    assert!(near([first.x, first.y, first.z], start(), 1));
    let stand = Vec3::new(far_seat().x, 0, far_seat().z + 300_000);
    assert!(near([last.x, last.y, last.z], stand, 500_000), "{last:?}");
}
