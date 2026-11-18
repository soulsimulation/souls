//! Engine v2 I4b (#3156): a committed move reaches the body. On N2's test world, a scripted client writes walk, sit
//! and rise intents to the world's end of the gateway's socket (I1's framing), and reads each answer back. The body
//! walks to a chair's stand point, sits in its slot and stands again, driven only by the walk skill behind the host
//! and B3's seats, through the one controller. Each receipt names the log's entries its intent caused; a walk while
//! seated is refused by name, and a walk replaced by another ends `claim-taken`.

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
use replica::intents::{Intent, Target};
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
    let place = Place::from_value(&decode(&fixture_bytes(CHAIR)?).unwrap().value)?;
    b.add_place(PlaceAt {
        thing: thing(),
        place,
        point: seat_at(),
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
        let i = Intent {
            actor: Actor::Soul(body_id()),
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
            expiry: answers::now() + 60_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
        };
        let bytes = encode(&i.to_value()).unwrap();
        self.0
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        self.0.write_all(&bytes).unwrap();
    }

    /// The next answer: a receipt's intent id and entries, or a refusal's reason.
    fn answer(&mut self) -> Result<(Id, Vec<u64>), String> {
        let mut len = [0u8; 4];
        self.0.read_exact(&mut len).expect("an answer");
        let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
        self.0.read_exact(&mut frame).unwrap();
        let Value::Map(m) = decode(&frame).unwrap().value else {
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
    for r in recover(log).unwrap().records {
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
    cfg.bodies = Some(Box::new(bodies));
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
    let events = world.events.clone();
    let (ready, accepted) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ready.send(()).unwrap();
        answers::serve(events, stream);
    });
    let stream = UnixStream::connect(&path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
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
            (l[1].1.as_str(), l[1].2.as_deref()),
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
    cfg.bodies = Some(Box::new(bodies));
    let world =
        answers::start(world_copy, toggles::rules(), store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("e2-spot-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let events = world.events.clone();
    let (ready, accepted) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        ready.send(()).unwrap();
        answers::serve(events, stream);
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
