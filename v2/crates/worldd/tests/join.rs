//! Engine v2 C3 (#3367): Souls join and leave a running world, through the world's end of the gateway's socket (I1's
//! framing), on N2's test world. No body stands in the world until its Soul acts.
//!
//! - A1: a Soul's first intent births its body by K10: a `souls:body` node on the ground by the entry, linked
//!   `souls:body-of` to its Soul. A join's words name it: the node is created with its name and description as
//!   references (fields 30 and 31), the words themselves in no log record. The joined Soul then takes a vessel and
//!   puts it in a rack (C2's acts, now on a born body). A Soul whose first intent is a take is born unnamed, and the
//!   take is then carried out.
//! - A2: a leave retires the body by K10's path, mid-sit: the sit ends `retired`, its seat is free (another Soul sits
//!   there), its link to its Soul and its activity's link are gone with its node, no timer of it fires after, and
//!   the thing in its hand is set down on the ground.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

use import_eden::Import;
use replica::activity::ActivityKind;
use replica::apply::Replica;
use replica::audience::REFERENCE;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, fixture_bytes,
    schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Intent, Target};
use replica::moves::Place;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::{Value as Json, parse};
use replica::tree::Rules as TreeRules;
use replica::world_model::{Audience, Kind};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use worldd::answers::{self, Config, JOIN, Join, LEAVE};
use worldd::bodies::Bodies;
use worldd::checkers::Rules;
use worldd::words::{DESCRIPTION, NAME, WORDS};

const LINEAGE: Scope = Scope([0xc3; 16]);
const CHAIR: &str = include_str!("../../replica/fixtures/seats/chair.diag");

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn full(plain: &str, n: u8) -> String {
    format!("{plain}@1220{}{n:02x}", "00".repeat(31))
}

const PLACE: &str = "souls:place";
const VESSEL: &str = "test:vessel";
const RACK: &str = "test:rack";
const PAIR: &str = "test:pair";
/// K10's body kind, as a birth writes it.
const BODY: &str = "souls:body";

fn kinds() -> Vec<(&'static str, String)> {
    [PLACE, VESSEL, RACK, PAIR, BODY]
        .iter()
        .enumerate()
        .map(|(i, k)| (*k, full(k, i as u8 + 1)))
        .collect()
}

fn fullname(plain: &str) -> String {
    kinds().into_iter().find(|(p, _)| *p == plain).unwrap().1
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

/// N2's test world as a town and its ground.
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c3-town/1").to_bytes()),
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

fn id(n: u64) -> Id {
    Id::new(Scope([0x7d; 16]), n).unwrap()
}

/// The Souls: actors only, with no node until they join.
fn ada() -> Id {
    Id::new(Scope([0x5a; 16]), 1).unwrap()
}
fn bo() -> Id {
    Id::new(Scope([0x5a; 16]), 2).unwrap()
}
fn vessel() -> Id {
    id(3)
}
fn rack() -> Id {
    id(4)
}
fn chair() -> Id {
    id(5)
}

/// The world's entry on the open ground, west of the square, µm: the first birth stands 1 m east of it (K10's ring).
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
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c3-join/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                kinds()
                    .into_iter()
                    .map(|(_, f)| Value::Text(name(&f)))
                    .collect(),
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).unwrap()).unwrap()
}

/// The world's rules (T2): the ground takes bodies, things and activities; a body holds a thing in each hand.
fn tree_rules() -> TreeRules {
    let k = |owner: &str, children: &[&str], slots: &[u64], hands| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: slots
            .iter()
            .map(|s| (*s, BTreeSet::from(["thing".to_owned()])))
            .collect(),
        hands,
    };
    TreeRules {
        kinds: BTreeMap::from([
            (
                fullname(PLACE),
                k("place", &["body", "thing", PAIR], &[], None),
            ),
            (fullname(BODY), k("family", &[], &[1, 2], None)),
            (fullname(VESSEL), k("thing", &[], &[], Some(1))),
            (fullname(RACK), k("thing", &[], &[1], None)),
            (fullname(PAIR), k("activity", &[], &[], None)),
        ]),
        souls: BTreeSet::new(),
        audiences: BTreeMap::new(),
    }
}

fn pair_kind() -> ActivityKind {
    let role = |r: &str| {
        Value::Map(BTreeMap::from([
            (1, Value::Text(name(r))),
            (2, Value::Text(name(&format!("{r}-place")))),
            (
                3,
                Value::Array(vec![Value::Map(BTreeMap::from([
                    (1, Value::Uint(2)),
                    (2, Value::Uint(4)),
                ]))]),
            ),
        ]))
    };
    ActivityKind::from_value(&Value::Map(BTreeMap::from([
        (1, Value::Text(name(&fullname(PAIR)))),
        (2, Value::Uint(1)),
        (
            3,
            Value::Array(vec![role("test:first"), role("test:second")]),
        ),
        (4, Value::Uint(60_000_000)),
        (5, Value::Uint(400_000)),
    ])))
    .expect("an activity kind")
}

/// The forms' entries (`souls-entry/1`): the vessel's take and the rack's put.
fn entries() -> Json {
    let vessel = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:vessel", "owner": "thing",
      "points": { "grip": { "role": "grip", "at_mm": [0, 100, 0] },
        "far": { "role": "stand", "at_mm": [3000, 0, 0] } },
      "forms": { "take": { "who": "anyone", "steps": [{ "step": "take", "move": "press", "at": "grip" }] },
        "fetch": { "who": "anyone", "steps": [{ "step": "walk_to", "point": "far" }, { "step": "take" }],
          "effects": [{ "change": "reparent", "what": "this", "into": "actor_hand" }] } } }"#,
    )
    .unwrap();
    let rack = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:rack", "owner": "thing",
      "points": { "edge": { "role": "rest", "at_mm": [0, 400, 0] },
        "off": { "role": "stand", "at_mm": [0, 0, 5000000] } },
      "slots": { "rest": { "admits": "thing" } },
      "forms": { "put": { "who": "anyone",
        "steps": [{ "step": "put", "move": "press", "at": "edge", "what": { "arg": "item" }, "slot": "rest" }] },
        "stray": { "who": "anyone", "steps": [{ "step": "walk_to", "point": "off" }] } } }"#,
    )
    .unwrap();
    Json::Obj(vec![(VESSEL.into(), vessel), (RACK.into(), rack)])
}

fn create(sequence: u64, node: Id, kind: &str, parent: Id, at: Vec3) -> Value {
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
                    position: at,
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: parent,
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
}

/// The world as built: a vessel 300 mm east of the first birth's spot, a rack 400 mm south of it. No body.
fn world() -> Replica {
    let g = ground();
    let h = header(g);
    let mut r = Replica::start(h.stored()).expect("a replica");
    let s = first_spot();
    let effects = vec![
        create(0, vessel(), VESSEL, g, Vec3::new(s.x + 300_000, 0, s.z)),
        create(1, rack(), RACK, g, Vec3::new(s.x, 0, s.z + 400_000)),
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

/// The world's bodies: none; one seat, its stand point at the first birth's spot.
fn bodies() -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let mut b = Bodies::new(town, 50_000)?;
    let chair_def = decode(&fixture_bytes(CHAIR)?).unwrap();
    let s = first_spot();
    b.add_place(PlaceAt {
        thing: chair(),
        place: Place::from_value(&chair_def.value)?,
        point: Vec3::new(s.x, 450_000, s.z - 300_000),
        facing: Quat::IDENTITY,
        floor: ground,
    })?;
    Ok(b)
}

/// A scripted client on the world's socket, one per Soul.
struct Client(UnixStream, Id, u64);

impl Client {
    fn send(&mut self, verb: &str, target: Option<Id>, parameters: BTreeMap<u64, Value>) {
        self.2 += 1;
        let i = Intent {
            actor: Actor::Soul(self.1),
            verb: name(verb),
            target: target.map(Target::Node),
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
            reflex: false,
        };
        let bytes = encode(&i.to_value()).unwrap();
        self.0
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        self.0.write_all(&bytes).unwrap();
    }

    /// The next answer: (its sequence, a receipt's entries or a refusal's reason).
    fn answer(&mut self) -> (u64, Result<Vec<u64>, String>) {
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
        let seq = match a.get(&2) {
            Some(Value::Uint(s)) => *s,
            _ => 0,
        };
        let r = match (a.get(&3), a.get(&5)) {
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
            other => panic!("an answer: {other:?}"),
        };
        (seq, r)
    }

    fn act(
        &mut self,
        verb: &str,
        target: Option<Id>,
        p: BTreeMap<u64, Value>,
    ) -> Result<Vec<u64>, String> {
        self.send(verb, target, p);
        self.answer().1
    }
}

struct Run {
    world: answers::World,
    store: Mem,
    path: std::path::PathBuf,
}

fn serve(tag: &str) -> (Run, Client, Client) {
    serve_on(tag, Mem::with(Vec::new()), None)
}

/// The world served over `store` (a restart when it holds a log), its words kept in `text` when given.
fn serve_on(
    tag: &str,
    store: Mem,
    text: Option<std::sync::Arc<sim::text::Store>>,
) -> (Run, Client, Client) {
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.text = text;
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    cfg.engine = Some((tree_rules(), vec![pair_kind()]));
    cfg.join = Some(Join {
        entry: (ground(), entry()),
        family: humanoid(),
        kind: name(&fullname(BODY)),
        per_tick: 8,
    });
    let rules = Rules {
        kinds: entries(),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(world(), rules, store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("c3-{tag}-{}.sock", std::process::id()));
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

    fn bytes(&self) -> Vec<u8> {
        self.store.0.lock().unwrap().bytes.clone()
    }

    /// The world's replica as of now: the world as built with every logged part applied.
    fn replay(&self) -> Replica {
        let mut r = world();
        for p in self.log() {
            if !p.effects.is_empty() {
                r.apply(&p).expect("the log replays");
            }
        }
        r
    }

    /// The body born for `soul`: its node, by its `souls:body-of` link.
    fn body_of(&self, soul: Id) -> Option<Id> {
        let r = self.replay();
        let t = r.tree();
        t.links_at(soul)
            .iter()
            .filter(|e| t.ty(e).as_str() == "souls:body-of")
            .find_map(|e| Some(t.link(e.link)?.1[0]))
    }

    fn stop(self) {
        self.world.stop();
        let _ = std::fs::remove_file(&self.path);
    }
}

fn parent(r: &Replica, node: Id) -> (Option<Id>, Option<u64>) {
    let t = r.tree();
    let n = t.node(t.handle(node).expect("the node")).expect("the node");
    (n.parent(), n.slot())
}

fn words(w: &str) -> Value {
    Value::Map(BTreeMap::from([(
        WORDS,
        Value::Bytes(w.as_bytes().to_vec()),
    )]))
}

fn p(pairs: &[(u64, Value)]) -> BTreeMap<u64, Value> {
    pairs.iter().cloned().collect()
}

#[test]
fn a1_a_first_intent_births_the_body_named_by_its_join_and_it_takes_and_puts() {
    let (run, mut a, mut b) = serve("a1");
    assert!(run.body_of(ada()).is_none(), "no body before the join");
    let joined = a.act(
        JOIN,
        None,
        p(&[
            (1, words("Ada Quill")),
            (2, words("keeps the west rack tidy")),
        ]),
    );
    println!("A1 join: {joined:?}");
    let joined = joined.expect("the join is answered with its birth");
    assert_eq!(joined.len(), 1, "one entry: the birth");
    let body = run.body_of(ada()).expect("a body linked to its Soul");
    assert_ne!(body, ada(), "the body is a node of its own");
    let r = run.replay();
    let t = r.tree();
    let n = t.node(t.handle(body).unwrap()).unwrap();
    println!(
        "A1 body {body:?}: kind {}, parent {:?}, at {:?}, fields {:?}",
        n.kind().as_str(),
        n.parent(),
        n.place().map(|p| p.position),
        n.fields()
    );
    assert_eq!(n.kind().as_str(), fullname(BODY), "the world's body kind");
    assert_eq!(n.parent(), Some(ground()), "on the open ground");
    for f in [NAME, DESCRIPTION] {
        assert!(
            matches!(n.fields().get(&f), Some(Value::Map(m)) if m.contains_key(&REFERENCE)),
            "field {f} is a reference"
        );
    }
    let log = run.bytes();
    for w in ["Ada Quill", "keeps the west rack tidy"] {
        assert!(
            !log.windows(w.len()).any(|x| x == w.as_bytes()),
            "{w:?} is not in the log"
        );
    }
    // A second join is a describe: the body is renamed, never born twice.
    let again = a.act(JOIN, None, p(&[(1, words("Ada"))]));
    println!("A1 join again: {again:?}");
    again.expect("renamed");
    assert_eq!(run.body_of(ada()), Some(body), "still the one body");

    // C2's acts on the born body: a take into its hand, a put into the rack's slot.
    let take = a.act("test:take", Some(vessel()), BTreeMap::new());
    println!("A1 take: {take:?}");
    take.expect("the take lands");
    let held = parent(&run.replay(), vessel());
    assert_eq!(held.0, Some(body), "held by the born body");
    assert!(matches!(held.1, Some(1 | 2)), "in a hand's slot");
    let item = Value::Array(vec![Value::Array(vec![
        Value::Bytes(b"item".to_vec()),
        vessel().to_value(),
    ])]);
    let put = a.act("test:put", Some(rack()), p(&[(1, item)]));
    println!("A1 put: {put:?}");
    put.expect("the put lands");
    assert_eq!(parent(&run.replay(), vessel()), (Some(rack()), Some(1)));

    // A first intent that is not a join: born unnamed, then the intent is taken.
    let g = ground();
    let proposed = b.act(
        "activity:propose",
        Some(g),
        p(&[(1, Value::Text(name(&fullname(PAIR))))]),
    );
    println!("A1 Bo's first intent, a propose: {proposed:?}");
    proposed.expect("born, then proposed");
    let bo_body = run.body_of(bo()).expect("Bo was born");
    let r = run.replay();
    let t = r.tree();
    let n = t.node(t.handle(bo_body).unwrap()).unwrap();
    assert!(n.fields().get(&NAME).is_none(), "unnamed");
    run.stop();
}

#[test]
fn a2_a_leave_frees_the_seat_the_links_and_the_timers() {
    let (run, mut a, mut b) = serve("a2");
    a.act(JOIN, None, p(&[(1, words("Ada"))]))
        .expect("Ada joins");
    let body = run.body_of(ada()).expect("born");
    // A link of the body's own beyond its Soul's: Ada proposes a pair and joins it.
    let g = ground();
    let proposed = a
        .act(
            "activity:propose",
            Some(g),
            p(&[(1, Value::Text(name(&fullname(PAIR))))]),
        )
        .expect("proposed");
    let activity = run
        .log()
        .iter()
        .flat_map(|p| p.effects.clone())
        .filter(|e| proposed.contains(&e.envelope.sequence))
        .find_map(|e| match e.body {
            Body::Changes(cs) => cs.into_iter().find_map(|c| match c.change {
                Change::Create { node, .. } => Some(node),
                _ => None,
            }),
            _ => None,
        })
        .expect("the activity");
    a.act(
        "activity:join",
        Some(activity),
        p(&[(1, Value::Text(name("test:first")))]),
    )
    .expect("Ada joins it");
    // And a thing in its hand.
    a.act("test:take", Some(vessel()), BTreeMap::new())
        .expect("Ada takes the vessel");
    assert_eq!(parent(&run.replay(), vessel()).0, Some(body));
    let r = run.replay();
    let links_before = r.tree().links_at(body).len();
    println!("A2 the body's links before: {links_before}");
    assert!(links_before >= 2, "its Soul's and its activity's");

    // Ada sits, and leaves while the sit is under way: its phase timers are pending.
    a.send("test:sit", Some(chair()), BTreeMap::new());
    let sit_seq = a.2;
    std::thread::sleep(Duration::from_millis(150));
    a.send(LEAVE, None, BTreeMap::new());
    let leave_seq = a.2;
    let (s1, r1) = a.answer();
    let (s2, r2) = a.answer();
    let mut answers = BTreeMap::from([(s1, r1), (s2, r2)]);
    let (sit, left) = (
        answers.remove(&sit_seq).unwrap(),
        answers.remove(&leave_seq).unwrap(),
    );
    println!("A2 sit {sit:?}, leave {left:?}");
    assert_eq!(sit, Err("retired".to_owned()), "the sit ends retired");
    let left = left.expect("the leave is answered with its entry");
    let r = run.replay();
    assert!(r.tree().handle(body).is_none(), "the node is gone");
    assert!(r.tree().links_at(ada()).is_empty(), "no link to the Soul");
    assert!(r.tree().links_at(body).is_empty(), "no link of the body");
    assert!(run.body_of(ada()).is_none());
    assert_eq!(
        parent(&r, vessel()),
        (Some(ground()), None),
        "what it held is set down, not taken out of the world"
    );

    // No timer of the body fires after the leave: no later entry names it.
    std::thread::sleep(Duration::from_millis(1_500));
    let last = *left.iter().max().unwrap();
    let named = run
        .log()
        .iter()
        .flat_map(|p| p.effects.clone())
        .filter(|e| e.envelope.sequence > last)
        .filter(|e| format!("{e:?}").contains(&format!("{body:?}")))
        .count();
    assert_eq!(named, 0, "nothing of the body after its leave");

    // Its seat is free: Bo, born next, walks to it and sits.
    b.act(JOIN, None, p(&[(1, words("Bo"))])).expect("Bo joins");
    let walked = b.act("test:walk", Some(chair()), BTreeMap::new());
    let sat = b.act("test:sit", Some(chair()), BTreeMap::new());
    println!("A2 Bo walk {walked:?}, sit {sat:?}");
    sat.expect("the seat was freed");

    // A leave with no body is refused by name.
    assert_eq!(
        a.act(LEAVE, None, BTreeMap::new()),
        Err("soul-not-embodied".to_owned())
    );
    run.stop();
}

// Engine v2 W11b (#3511): the directory's word reaches the world. An owner's retire ends the Soul's body by K10's
// path; a name or description saved on the page becomes the body's own describe; a world down at the retire gets it
// at its next start. The directory's file is handed in as `worldd serve` hands it (`worldd::directory::watch`).

/// A Soul's grant, as the directory's file names it.
fn grant(soul: Id) -> String {
    format!(
        "soul-{}-{}",
        replica::encode::to_hex(&soul.scope().0),
        soul.counter()
    )
}

/// Hands the world the directory's file `text`; the answers to what it causes come back on the receiver.
fn tell(run: &Run, text: &str) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let d = worldd::directory::Directory::read(text);
    run.world
        .events
        .send(answers::Event::Directory(Box::new((d, tx))))
        .unwrap();
    rx
}

fn told(rx: &std::sync::mpsc::Receiver<Vec<u8>>) -> String {
    let frame = rx
        .recv_timeout(Duration::from_secs(20))
        .expect("the world answers the directory's intent");
    worldd::directory::show(&frame)
}

/// The effects whose sequence a receipt lists.
fn entries_of(run: &Run, receipt: &str) -> Vec<Effect> {
    let listed: Vec<u64> = receipt
        .trim_start_matches("receipt [")
        .trim_end_matches(']')
        .split(", ")
        .filter_map(|n| n.parse().ok())
        .collect();
    run.log()
        .iter()
        .flat_map(|p| p.effects.clone())
        .filter(|e| listed.contains(&e.envelope.sequence))
        .collect()
}

#[test]
fn w11b_a1_an_owners_retire_ends_the_body_by_k10_and_it_never_comes_back() {
    let (run, mut a, _) = serve("w11b-a1");
    a.act(JOIN, None, p(&[(1, words("Ada"))]))
        .expect("Ada joins");
    let body = run.body_of(ada()).expect("born");
    let rx = tell(
        &run,
        &format!("# the directory's file\nretired {}\n", grant(ada())),
    );
    let receipt = told(&rx);
    println!("W11b A1 the retire: {receipt}");
    assert!(receipt.starts_with("receipt"), "{receipt}");
    let effects = entries_of(&run, &receipt);
    println!("W11b A1 its entries: {effects:?}");
    assert_eq!(effects.len(), 1, "one effect: the body's retire");
    assert_eq!(
        effects[0].envelope.actor,
        Actor::Soul(ada()),
        "the Soul's own"
    );
    let r = run.replay();
    assert!(r.tree().handle(body).is_none(), "the node is gone");
    assert!(run.body_of(ada()).is_none(), "no link to its Soul");
    // The Soul's agent is never given a body again.
    assert_eq!(
        a.act(JOIN, None, p(&[(1, words("Ada"))])),
        Err("soul-retired".to_owned())
    );
    assert!(run.body_of(ada()).is_none());
    // The same file again changes nothing.
    let again = tell(&run, &format!("retired {}\n", grant(ada())));
    assert!(again.recv_timeout(Duration::from_millis(500)).is_err());
    run.stop();
}

#[test]
fn w11b_a2_saved_words_reach_the_body_as_its_own_describe() {
    let text = std::sync::Arc::new(
        sim::text::Store::open_mem(
            Mem::default(),
            Mem::default(),
            replica::ids::Minter::new(worldd::words::scope(LINEAGE)),
        )
        .expect("a text store"),
    );
    let (run, mut a, _) = serve_on("w11b-a2", Mem::with(Vec::new()), Some(text.clone()));
    a.act(JOIN, None, p(&[(1, words("Ada"))]))
        .expect("Ada joins");
    let body = run.body_of(ada()).expect("born");
    let hex = |w: &str| replica::encode::to_hex(w.as_bytes());
    let file = format!(
        "words {} {} {}\n",
        grant(ada()),
        hex("Ada Quill"),
        hex("keeps the west rack tidy")
    );
    let receipt = told(&tell(&run, &file));
    println!("W11b A2 the describe: {receipt}");
    assert!(receipt.starts_with("receipt"), "{receipt}");
    let effects = entries_of(&run, &receipt);
    assert_eq!(effects.len(), 1);
    assert_eq!(
        effects[0].envelope.actor,
        Actor::Soul(ada()),
        "the Soul's own"
    );
    assert_eq!(effects[0].envelope.node, body, "written on its body");
    assert_eq!(effects[0].envelope.audience, Audience::Everyone, "public");
    // A viewer reads the new words: the references on the body, the words in the store for everyone.
    let r = run.replay();
    let t = r.tree();
    let n = t.node(t.handle(body).unwrap()).unwrap();
    let read = |field| {
        let Some(Value::Map(m)) = n.fields().get(&field) else {
            panic!("field {field} is a reference")
        };
        let id = replica::effects::read_id(&m[&REFERENCE]).unwrap();
        String::from_utf8(text.read(id, &[]).expect("public words")).unwrap()
    };
    println!(
        "W11b A2 the body reads {:?}, {:?}",
        read(NAME),
        read(DESCRIPTION)
    );
    assert_eq!(read(NAME), "Ada Quill");
    assert_eq!(read(DESCRIPTION), "keeps the west rack tidy");
    let log = run.bytes();
    assert!(
        !log.windows(9).any(|x| x == b"Ada Quill"),
        "no words in the log"
    );
    // Words the body already has are not written again.
    let again = tell(&run, &file);
    assert!(again.recv_timeout(Duration::from_millis(500)).is_err());
    // A Soul with no body here is left alone: no birth.
    let none = tell(&run, &format!("words {} {} -\n", grant(bo()), hex("Bo")));
    assert!(none.recv_timeout(Duration::from_millis(500)).is_err());
    assert!(
        run.body_of(bo()).is_none(),
        "the directory never births a body"
    );
    run.stop();
}

/// #4134 review: Ada and Bo are born in turn while the text store's writer is held, and the directory holds the very
/// names they joined with. Ada's name reaches the disk and Bo's sync never returns: Ada is taken and her words agree,
/// Bo waits for his own, and neither is given words it holds (W11b: only when its body's differ).
#[test]
fn a4134_souls_born_while_their_words_wait_are_not_given_words_they_hold() {
    let disk = Mem::default();
    let text = std::sync::Arc::new(
        sim::text::Store::open_mem(
            disk.clone(),
            Mem::default(),
            replica::ids::Minter::new(worldd::words::scope(LINEAGE)),
        )
        .expect("a text store"),
    );
    let (run, mut a, mut b) = serve_on("a4134", Mem::with(Vec::new()), Some(text.clone()));
    let hex = |w: &str| replica::encode::to_hex(w.as_bytes());
    let file = format!(
        "words {} {} -\nwords {} {} -\n",
        grant(ada()),
        hex("Ada"),
        grant(bo()),
        hex("Bo")
    );
    let directory = tell(&run, &file);
    assert!(
        directory.recv_timeout(Duration::from_millis(300)).is_err(),
        "no body yet, nothing to tell"
    );
    let until = |what: &str, done: &dyn Fn((u64, u64)) -> bool| {
        for _ in 0..1000 {
            if done(text.marks()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("{what}: {:?}", text.marks());
    };
    {
        let mut d = disk.0.lock().unwrap();
        d.stall_sync = Some(d.syncs + 2);
    }
    // The writer waits for the disk while the test holds it: Ada's name is queued, then Bo's a few ticks later.
    let held = disk.0.lock().unwrap();
    a.send(JOIN, None, p(&[(1, words("Ada"))]));
    until("Ada's name queued", &|(q, _)| q == 1);
    std::thread::sleep(Duration::from_millis(200));
    b.send(JOIN, None, p(&[(1, words("Bo"))]));
    until("Bo's name queued", &|(q, _)| q == 2);
    std::thread::sleep(Duration::from_millis(200));
    // Ada's name reaches the disk; Bo's is written and its sync never returns.
    drop(held);
    until("Ada's name on the disk", &|(_, d)| d == 1);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        text.marks(),
        (2, 1),
        "the directory queued no words: neither Soul was given the name it holds"
    );
    disk.0.lock().unwrap().power_cut(0);
    run.stop();
}

#[test]
fn w11b_a3_a_world_down_at_the_retire_gets_it_at_its_next_start() {
    let store = Mem::with(Vec::new());
    let (run, mut a, _) = serve_on("w11b-a3-1", store.clone(), None);
    a.act(JOIN, None, p(&[(1, words("Ada"))]))
        .expect("Ada joins");
    let body = run.body_of(ada()).expect("born");
    run.stop();
    // The owner retires Ada while the world is down; at its start the world reads the directory's file first.
    let (run, mut a, _) = serve_on("w11b-a3-2", store.clone(), None);
    assert_eq!(run.body_of(ada()), Some(body), "the log still has the body");
    let rx = tell(&run, &format!("retired {}\n", grant(ada())));
    let receipt = told(&rx);
    println!("W11b A3 the retire at the next start: {receipt}");
    assert!(receipt.starts_with("receipt"), "{receipt}");
    assert!(
        run.replay().tree().handle(body).is_none(),
        "the node is gone"
    );
    a.2 = 100;
    assert_eq!(
        a.act(JOIN, None, p(&[(1, words("Ada"))])),
        Err("soul-retired".to_owned())
    );
    run.stop();
    // And it stays gone across a further restart.
    let (run, _, _) = serve_on("w11b-a3-3", store, None);
    assert!(run.body_of(ada()).is_none(), "never stood again");
    assert!(run.replay().tree().handle(body).is_none());
    run.stop();
}

/// A3 (C12, #3427): a form's `walk_to` walks a born body from where it stands to the step's point on the open ground,
/// then its bare take (as Eden's entries write one) lands; a point no body can stand on is refused by name.
#[test]
fn a3_a_walk_to_reaches_its_point_or_is_refused_by_name() {
    let (run, mut a, mut b) = serve("a3");
    a.act(JOIN, None, BTreeMap::new()).expect("Ada joins");
    let body = run.body_of(ada()).expect("born");
    // The point is 3 m east of the vessel, which stands 300 mm from the birth: a walk of about 3.3 m first.
    let fetched = a.act("test:fetch", Some(vessel()), BTreeMap::new());
    println!("A3 fetch: {fetched:?}");
    fetched.expect("walked to the point, then took the vessel");
    assert_eq!(parent(&run.replay(), vessel()).0, Some(body), "in its hand");
    // 5 km past the rack, off the ground: there is no way there.
    b.act(JOIN, None, BTreeMap::new()).expect("Bo joins");
    let strayed = b.act("test:stray", Some(rack()), BTreeMap::new());
    println!("A3 stray: {strayed:?}");
    assert_eq!(strayed, Err("souls:no-way".to_owned()));
    run.stop();
}

/// 0.132 scaling (#1960): the bodies' motion and stances, written by the tick, are a pure function of the history.
/// Thirty Souls join a lockstep world, walk to points on the open ground (some twice, one cut short by a new walk),
/// and two sit, for a minute of ticks. The log's effect hash (every record the world wrote: motion samples, transfers,
/// receipts and each tick's state hash) is pinned to the value the tick wrote before the motion write skipped its
/// decode round trip; a speed-up of the bodies phase must leave it bit for bit.
#[test]
fn motion_history_is_bit_identical_to_its_pinned_hash() {
    const SOULS: u64 = 30;
    const TICKS: i64 = 1_200;
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.lockstep = true;
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    cfg.engine = Some((tree_rules(), vec![pair_kind()]));
    cfg.join = Some(Join {
        entry: (ground(), entry()),
        family: humanoid(),
        kind: name(&fullname(BODY)),
        per_tick: 8,
    });
    let rules = Rules {
        kinds: entries(),
        moves: Json::Obj(Vec::new()),
    };
    let store = Mem::with(Vec::new());
    let w = answers::start(world(), rules, store.clone(), cfg).expect("the world starts");
    let soul = |i: u64| Id::new(Scope([0x5b; 16]), 100 + i).unwrap();
    let mut sequences = BTreeMap::new();
    let mut replies = Vec::new();
    let mut send = |tick: i64, who: Id, verb: &str, target: Option<Id>, point: Option<Vec3>| {
        let sequence = sequences.entry(who).or_insert(0u64);
        *sequence += 1;
        let mut parameters = BTreeMap::new();
        if let Some(p) = point {
            let i = |n: i64| {
                u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
            };
            parameters.insert(1, Value::Array(vec![i(p.x), i(p.y), i(p.z)]));
        }
        let intent = Intent {
            actor: Actor::Soul(who),
            verb: name(verb),
            target: target.map(Target::Node),
            parameters,
            sequence: *sequence,
            basis: Version {
                lineage: LINEAGE,
                zone: Id::new(LINEAGE, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            // Lockstep world time starts at 0: an expiry far ahead.
            expiry: 1_000_000_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let (reply, rx) = std::sync::mpsc::channel();
        w.events
            .send(answers::Event::ArrivalAt {
                tick,
                bytes: encode(&intent.to_value()).unwrap(),
                reply,
            })
            .unwrap();
        replies.push(rx);
    };
    // A point on the open ground east of the entry, from a fixed sequence: within 8 m east and 6 m either side.
    let point = |k: u64| {
        let s = first_spot();
        let (a, b) = ((k * 7_919) % 8_000, (k * 104_729) % 12_000);
        Vec3::new(s.x + a as i64 * 1_000, 0, s.z + (b as i64 - 6_000) * 1_000)
    };
    let g = ground();
    for i in 0..SOULS {
        let who = soul(i);
        send(1 + i as i64 / 8, who, JOIN, None, None);
        send(10 + 7 * i as i64, who, "eden:walk", Some(g), Some(point(i)));
        if i % 3 == 0 {
            send(
                400 + 11 * i as i64,
                who,
                "eden:walk",
                Some(g),
                Some(point(i + 100)),
            );
        }
    }
    // A walk replaced by another a tick later; two sits on the one chair (the second waits or is refused by name).
    send(700, soul(1), "eden:walk", Some(g), Some(point(200)));
    send(701, soul(1), "eden:walk", Some(g), Some(point(201)));
    send(800, soul(2), "eden:sit", Some(chair()), None);
    send(810, soul(4), "eden:sit", Some(chair()), None);
    let ran = {
        let (done, rx) = std::sync::mpsc::channel();
        w.events
            .send(answers::Event::RunTo { tick: TICKS, done })
            .unwrap();
        rx.recv().unwrap()
    };
    for rx in &replies {
        rx.recv_timeout(Duration::from_secs(20)).expect("an answer");
    }
    w.stop();
    assert_eq!(ran.tick, TICKS);
    let log = store.0.lock().unwrap().bytes.clone();
    let records = recover(&log).unwrap().records;
    let motions: usize = records
        .iter()
        .filter(|r| !sim::recorder::is_input(r))
        .map(|r| Part::read(r).unwrap())
        .flat_map(|p| p.effects)
        .filter_map(|e| match e.body {
            Body::Changes(c) => Some(c),
            _ => None,
        })
        .flatten()
        .filter(|c| matches!(c.change, Change::Motion(_)))
        .count();
    let hash: String = sim::recorder::effect_hash(&records)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    println!(
        "motion history: {} records, {motions} motion samples, effect hash {hash}",
        records.len()
    );
    assert!(motions > 500, "the run wrote motion: {motions}");
    assert_eq!(hash, PINNED_MOTION_HISTORY, "the history is bit-identical");
}

/// [`motion_history_is_bit_identical_to_its_pinned_hash`]'s effect hash, as `origin/main` (c919d8126) writes it.
const PINNED_MOTION_HISTORY: &str =
    "b18f5b817f8e19faaf0174ffbc43f546e27dc4732af99949575138ad374be048";

/// R21: private membership is checked against the joined actor's authoritative body, not its principal id.
#[test]
fn r21_joined_principal_private_turn_uses_body_and_rejects_nonmember() {
    let (run, mut member, mut outsider) = serve("r21-private");
    member
        .act(JOIN, None, BTreeMap::new())
        .expect("member joins world");
    outsider
        .act(JOIN, None, BTreeMap::new())
        .expect("outsider joins world");
    assert_ne!(
        run.body_of(ada()).unwrap(),
        ada(),
        "body and principal differ"
    );
    let entries = member
        .act(
            "activity:propose",
            Some(ground()),
            p(&[(1, Value::Text(name(&fullname(PAIR))))]),
        )
        .expect("proposed");
    let activity = run
        .log()
        .iter()
        .flat_map(|p| p.effects.clone())
        .filter(|e| entries.contains(&e.envelope.sequence))
        .find_map(|e| match e.body {
            Body::Changes(cs) => cs.into_iter().find_map(|c| match c.change {
                Change::Create { node, .. } => Some(node),
                _ => None,
            }),
            _ => None,
        })
        .expect("activity");
    member
        .act(
            "activity:join",
            Some(activity),
            p(&[(1, Value::Text(name("test:first")))]),
        )
        .expect("member joins activity");
    let private = "member-only fixture";
    member
        .act("test:say", Some(activity), p(&[(1, words(private))]))
        .expect("joined principal's body is a member");
    let denied = "outsider fixture";
    assert_eq!(
        outsider.act("test:say", Some(activity), p(&[(1, words(denied))])),
        Err("not-a-member".to_owned()),
        "a joined nonmember is still refused"
    );
    let log = run.bytes();
    for text in [private, denied] {
        assert!(
            !log.windows(text.len()).any(|w| w == text.as_bytes()),
            "no private words in the log"
        );
    }
    run.stop();
}

#[path = "join/base_forms.rs"]
mod base_forms;
