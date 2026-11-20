//! Engine v2 B15a (#2750): a Soul chooses its body by its own intent, `life:wear`, through the world's end of the
//! gateway's socket, on N2's test world with C3's births. The world's catalogue admits three presets; the first birth's
//! spot stands in a corridor 0.8 m wide.
//!
//! - A1 (the agent's half, at the engine): a wear of an admitted preset is one entry, a set of the preset's content
//!   hash on the Soul's body node, answered with a receipt; the log holds the hash and never the name it was asked by.
//! - A2 (the engine's half): replaying the log, the body has no hash before the wear's part and the preset's after it.
//! - A3: a wear the corridor cannot hold (the large class) is refused `size-would-not-fit`, and one not in the
//!   catalogue `body-unknown`; the old body stays.
//! - A4: a Soul `world.json` names a body for is born wearing it.

use std::collections::BTreeMap;
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
use replica::rules::json::Value as Json;
use replica::world_model::Audience;
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::walk::town::Town;
use skills::wear::{BODY, Catalogue, VERB};
use worldd::answers::{self, Config, Join, Wearing};
use worldd::bodies::Bodies;
use worldd::checkers::Rules;
use worldd::words::WORDS;

const LINEAGE: Scope = Scope([0xb1; 16]);
const PLACE: &str = "souls:place";
/// The open ground's kind (N1's), as the fit check reads it.
const GROUND: &str = "eden:ground";
const WALL: &str = "test:wall";
const BODY_KIND: &str = "souls:body";

const SMALL: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const LARGE: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const TALL: &str = "3333333333333333333333333333333333333333333333333333333333333333";

fn catalogue() -> Catalogue {
    Catalogue::read(&format!(
        r#"{{"format": "souls/bodies/1", "bodies": [
          {{"preset": "tiny-sprite", "hash": "{SMALL}", "size": "small", "height": 900}},
          {{"preset": "big-floater", "hash": "{LARGE}", "size": "large", "height": 1450, "hover": 1450}},
          {{"preset": "tall-walker", "hash": "{TALL}", "size": "standard", "height": 1900}}]}}"#
    ))
    .unwrap()
}

fn hash(hex: &str) -> [u8; 32] {
    skills::wear::hash_of(hex).unwrap()
}

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn full(plain: &str, n: u8) -> String {
    format!("{plain}@1220{}{n:02x}", "00".repeat(31))
}

fn fullname(plain: &str) -> String {
    let n = [PLACE, GROUND, WALL, BODY_KIND]
        .iter()
        .position(|k| *k == plain)
        .unwrap();
    full(plain, n as u8 + 1)
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
        ],
    }
}

/// N2's test world as a town and its ground.
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/b15-town/1").to_bytes()),
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

/// The Souls: Ada is born in the default body, Bo in the tall walker (`world.json`'s row).
fn ada() -> Id {
    Id::new(Scope([0x5b; 16]), 1).unwrap()
}
fn bo() -> Id {
    Id::new(Scope([0x5b; 16]), 2).unwrap()
}

/// The entry; the first birth stands 1 m east of it (K10's ring).
fn entry() -> Vec3 {
    Vec3::new(-40_000_000, 0, 30_000_000)
}
fn first_spot() -> Vec3 {
    Vec3::new(-39_000_000, 0, 30_000_000)
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/b15-wear/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                [PLACE, GROUND, WALL, BODY_KIND]
                    .iter()
                    .map(|k| Value::Text(name(&fullname(k))))
                    .collect(),
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).unwrap()).unwrap()
}

/// The world as built: the zone, the open ground in it, and on the ground two walls along x, their inner faces 0.4 m
/// either side of the first birth's spot.
fn world() -> Replica {
    let (z, g) = (Id::new(LINEAGE, 0).unwrap(), ground());
    let h = header(z);
    let mut r = Replica::start(h.stored()).expect("a replica");
    let s = first_spot();
    let (cx, cz) = (s.x / 1000, s.z / 1000);
    let wall = |dz: i64| {
        Value::Array(
            [cx, cz + dz, 3_000, 250, 0, 0, 2_500]
                .iter()
                .map(|v| match u64::try_from(*v) {
                    Ok(u) => Value::Uint(u),
                    Err(_) => Value::Nint(v.unsigned_abs() - 1),
                })
                .collect(),
        )
    };
    let create = |sequence, node, kind: &str, parent, fields| {
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
                    kind: name(&fullname(kind)),
                    pose: Pose {
                        frame: Frame {
                            node: parent,
                            slot: None,
                        },
                        position: Vec3::ZERO,
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
    };
    let walls = BTreeMap::from([(12, Value::Array(vec![wall(650), wall(-650)]))]);
    let effects = vec![
        create(0, g, GROUND, z, BTreeMap::new()),
        create(1, Id::new(Scope([0x7e; 16]), 1).unwrap(), WALL, g, walls),
    ];
    let part = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (2, Value::Array(effects)),
    ])))
    .unwrap();
    r.apply(&Part::read(&part).unwrap())
        .expect("the world as built");
    r
}

/// A scripted client on the world's socket, one per Soul.
struct Client(UnixStream, Id, u64);

impl Client {
    /// Sends `verb` with `words` in parameter 1 (a wear's body) and returns a receipt's entries or the refusal.
    fn act(&mut self, verb: &str, words: Option<&str>) -> Result<Vec<u64>, String> {
        self.2 += 1;
        let parameters = words
            .map(|w| {
                (
                    1,
                    Value::Map(BTreeMap::from([(
                        WORDS,
                        Value::Bytes(w.as_bytes().to_vec()),
                    )])),
                )
            })
            .into_iter()
            .collect();
        let i = Intent {
            actor: Actor::Soul(self.1),
            verb: name(verb),
            target: None,
            parameters,
            sequence: self.2,
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
        match (a.get(&3), a.get(&5)) {
            (Some(Value::Uint(1)), Some(Value::Array(e))) => Ok(e
                .iter()
                .map(|v| match v {
                    Value::Uint(n) => *n,
                    _ => panic!("an entry"),
                })
                .collect()),
            (Some(Value::Uint(2)), _) => match a.get(&4) {
                Some(Value::Text(t)) => Err(t.as_str().to_owned()),
                other => panic!("a refusal: {other:?}"),
            },
            other => panic!("an answer: {other:?} {:?}", a.get(&4)),
        }
    }
}

struct Run {
    world: answers::World,
    store: Mem,
    path: std::path::PathBuf,
}

fn serve(tag: &str) -> (Run, Client, Client) {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    // The same canonical world feeds fit, controller and planner geometry, prepared before the clock starts.
    let initial = world();
    let mut town = Town::new(
        initial.tree().frozen(),
        ground(),
        Doors::new(
            initial.header().clone(),
            Default::default(),
            initial.version(),
        ),
    )
    .unwrap();
    town.prepare_classes(catalogue().classes()).unwrap();
    let planner = town.copy().unwrap();
    cfg.built_bodies = Some(Box::new(move |placed, builds| {
        let mut b = Bodies::with_planner(town, planner, 50_000)?;
        for (&id, (pose, _)) in placed {
            let build = builds[&id];
            let on = b.town.surfaces_for(build.size).unwrap();
            let moved = on[&pose.frame.node].place_built(
                id,
                pose.frame,
                pose.position,
                pose.orientation,
                build,
            )?;
            b.add_body_at_built(humanoid(), moved, placed, build)?;
        }
        Ok(b)
    }));
    cfg.join = Some(Join {
        entry: (ground(), entry()),
        family: humanoid(),
        kind: name(&fullname(BODY_KIND)),
        per_tick: 8,
    });
    cfg.wear = Some(Wearing {
        catalogue: catalogue(),
        born: BTreeMap::from([(bo(), hash(TALL))]),
    });
    let rules = Rules {
        kinds: Json::Obj(Vec::new()),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(initial, rules, store.clone(), cfg).expect("the world starts");
    let root = std::path::PathBuf::from("../../../.local");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join(format!("p3651-{tag}-{}.sock", std::process::id()));
    assert!(std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str()).len() < 104);
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(2).flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, stream));
        }
    });
    let client = |soul| {
        let s = UnixStream::connect(&path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        Client(s, soul, 0)
    };
    let (a, b) = (client(ada()), client(bo()));
    (Run { world, store, path }, a, b)
}

impl Run {
    fn log(&self) -> Vec<Part> {
        let log = self.store.0.lock().unwrap().bytes.clone();
        recover(&log)
            .unwrap()
            .records
            .into_iter()
            .filter(|r| !sim::recorder::is_input(r))
            .map(|r| Part::read(&r).unwrap())
            .collect()
    }

    /// The body each part leaves `soul` wearing, part by part, from the world as built (A2's replay).
    fn worn_by_part(&self, soul: Id) -> Vec<Option<Value>> {
        let mut r = world();
        let mut out = Vec::new();
        for p in self.log() {
            if !p.effects.is_empty() {
                r.apply(&p).expect("the log replays");
            }
            out.push(worn(&r, soul));
        }
        out
    }

    fn worn(&self, soul: Id) -> Option<Value> {
        self.worn_by_part(soul).pop().flatten()
    }

    fn stop(self) {
        self.world.stop();
        let _ = std::fs::remove_file(&self.path);
    }
}

/// What `soul`'s body wears in `r` (its [`BODY`] field), found by its `souls:body-of` link.
fn worn(r: &Replica, soul: Id) -> Option<Value> {
    let t = r.tree();
    let body = t
        .links_at(soul)
        .iter()
        .filter(|e| t.ty(e).as_str() == "souls:body-of")
        .find_map(|e| Some(t.link(e.link)?.1[0]))?;
    t.node(t.handle(body)?)?.fields().get(&BODY).cloned()
}

#[test]
fn paired_writer_refusal_keeps_tree_and_live_controller_class() {
    let initial = world();
    let town = Town::new(
        initial.tree().frozen(),
        ground(),
        Doors::new(
            initial.header().clone(),
            Default::default(),
            initial.version(),
        ),
    )
    .unwrap();
    let moved = town.surfaces[&ground()]
        .place(
            ada(),
            Frame {
                node: ground(),
                slot: None,
            },
            first_spot(),
            Quat::IDENTITY,
        )
        .unwrap();
    let mut controller = sim::controller::Controller::new();
    controller.add(humanoid(), moved).unwrap();
    let basis = controller.build_basis(ada()).unwrap();
    let mut candidate = initial.frozen();
    let effect = Effect {
        envelope: Envelope {
            sequence: initial.version(),
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: ground(),
        },
        body: Body::Changes(vec![ChangeRec {
            change: Change::Set {
                node: ground(),
                field: 501,
                to: Value::Uint(1),
                by: None,
            },
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    };
    let part = sim::commit::write(&mut candidate, &[effect]).unwrap();
    let mut tree = initial.tree().frozen();
    let before = tree.to_state();
    let build = replica::kinds::sizes::Build {
        size: replica::kinds::sizes::Size::Small,
        ..skills::wear::DEFAULT
    };
    let failure = controller
        .commit_build(&basis, moved, build, || {
            tree.commit_then(initial.header(), &part, &Default::default(), || {
                Err::<(), _>(replica::effects::Refusal {
                    name: "paired-writer-refused",
                    detail: String::new(),
                })
            })
        })
        .unwrap_err();
    assert_eq!(failure.name, "paired-writer-refused");
    assert_eq!(tree.to_state(), before);
    assert_eq!(controller.build_basis(ada()).unwrap(), basis);
}

#[test]
fn a1_a2_a3_a_wear_is_one_set_of_its_hash_refused_when_it_does_not_fit() {
    let checks_before = sim::commit::checks_on_clock();
    let (run, mut a, _) = serve("a1");
    // Born in the default body, with no hash.
    assert_eq!(
        a.act("life:join", Some("Ada")).map(|e| e.len()),
        Ok(1),
        "the birth"
    );
    assert_eq!(run.worn(ada()), None, "born in the default body");
    // A3: the large class does not fit the corridor; a body not admitted is unknown. The old body stays.
    let large = a.act(VERB, Some("big-floater"));
    println!("A3 big-floater in the corridor: {large:?}");
    assert_eq!(large, Err("size-would-not-fit".to_owned()));
    assert_eq!(a.act(VERB, Some("nobody")), Err("body-unknown".to_owned()));
    assert_eq!(a.act(VERB, None), Err("body-unknown".to_owned()));
    assert_eq!(run.worn(ada()), None, "the old body is kept");
    // A1: an admitted body that fits is one entry, its hash on the body node.
    let small = a.act(VERB, Some("tiny-sprite"));
    println!("A1 tiny-sprite: {small:?}");
    assert_eq!(small.expect("a receipt").len(), 1, "one entry");
    assert_eq!(run.worn(ada()), Some(Value::Bytes(hash(SMALL).to_vec())));
    // By hash too.
    assert_eq!(a.act(VERB, Some(TALL)).map(|e| e.len()), Ok(1));
    assert_eq!(run.worn(ada()), Some(Value::Bytes(hash(TALL).to_vec())));
    // A2: replayed, no hash before the first wear's part, the small body's after it, the tall one's last.
    let by_part = run.worn_by_part(ada());
    let first = by_part
        .iter()
        .position(Option::is_some)
        .expect("a wear in the log");
    assert!(by_part[..first].iter().all(Option::is_none));
    assert_eq!(by_part[first], Some(Value::Bytes(hash(SMALL).to_vec())));
    println!(
        "A2 the log's {} parts: no body before part {first}, the small body from it",
        by_part.len()
    );
    // The log holds the hash, never the names it was asked by.
    let bytes = run.store.0.lock().unwrap().bytes.clone();
    for asked in ["tiny-sprite", "big-floater", "nobody"] {
        assert!(
            !bytes.windows(asked.len()).any(|w| w == asked.as_bytes()),
            "{asked} is not in the log"
        );
    }
    run.stop();
    assert_eq!(
        sim::commit::checks_on_clock(),
        checks_before,
        "wear preparation stays off the clock"
    );
}

#[test]
fn a4_a_soul_world_json_names_a_body_for_is_born_wearing_it() {
    let (run, _, mut b) = serve("a4");
    assert_eq!(
        b.act("life:join", Some("Bo")).map(|e| e.len()),
        Ok(1),
        "the birth"
    );
    let worn = run.worn(bo());
    println!("A4 Bo born wearing {worn:?}");
    assert_eq!(worn, Some(Value::Bytes(hash(TALL).to_vec())));
    run.stop();
}
