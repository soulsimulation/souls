//! Engine v2 C2 (#3366): Soul Actions acts in a running world, through the world's end of the gateway's socket (I1's
//! framing), on N2's test world with two bodies that are nodes of the tree. Each intent gets one answer.
//!
//! - A2: a form's take puts a thing in the body's hand (B4's transfer, F4's take step) and a put sets it into a
//!   rack's slot; each is one receipt, and the log replayed holds the thing in the hand, then in the slot.
//! - A3: a joint activity's propose, join (both), start and leave (both), each one receipt; an offer (E8) accepted and
//!   another declined, each one receipt.
//! - A4: two Souls carry a plank together: a carry activity both join and start, the lift, both walk 3 m, the
//!   carry sampled each tick between them, and the set-down; the plank ends on the ground where they stopped.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

use import_eden::Import;
use replica::activity::ActivityKind;
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Intent, Target};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::{Value as Json, parse};
use replica::tree::Rules as TreeRules;
use replica::world_model::{Audience, Kind};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::walk::town::Town;
use worldd::answers::{self, Config};
use worldd::bodies::Bodies;
use worldd::checkers::Rules;

const LINEAGE: Scope = Scope([0xc2; 16]);

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn full(plain: &str, n: u8) -> String {
    format!("{plain}@1220{}{n:02x}", "00".repeat(31))
}

const PLACE: &str = "souls:place";
const WALKER: &str = "test:walker";
const VESSEL: &str = "test:vessel";
const RACK: &str = "test:rack";
const PLANK: &str = "test:plank";
const PAIR: &str = "test:pair";
const CARRY: &str = "test:carry";
const COURT: &str = "test:court";
const CAN: &str = "test:can";

/// The kinds in pinned order: (plain name, full name).
fn kinds() -> Vec<(&'static str, String)> {
    [PLACE, WALKER, VESSEL, RACK, PLANK, PAIR, CARRY, COURT, CAN]
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

/// N2's test world as a town and its ground: the replica's zone is rooted at that ground, so a body the town stands
/// on the ground stands under the tree's root.
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c2-town/1").to_bytes()),
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
    Id::new(Scope([0x7c; 16]), n).unwrap()
}

fn w1() -> Id {
    id(1)
}
fn w2() -> Id {
    id(2)
}
fn vessel() -> Id {
    id(3)
}
fn rack() -> Id {
    id(4)
}
fn plank() -> Id {
    id(5)
}
fn court() -> Id {
    id(6)
}
/// #4086: three watering cans south of the first walker, 100 m, 2.2 m and 1.5 m away (a can's reach from a body is
/// its half size, 0.38 m, and 1.5 m).
fn far_can() -> Id {
    id(7)
}
fn beyond_can() -> Id {
    id(8)
}
fn near_can() -> Id {
    id(9)
}
fn south(by: i64) -> Vec3 {
    Vec3::new(at1().x, 0, at1().z - by)
}

/// Where the bodies stand on the test world's open ground, west of the square, µm.
fn at1() -> Vec3 {
    Vec3::new(-40_000_000, 0, 30_000_000)
}
fn at2() -> Vec3 {
    Vec3::new(-42_700_000, 0, 30_000_000)
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/c2-acts/1").to_bytes()),
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

/// The world's rules (T2): the ground takes bodies, things and activities; a walker holds a thing in each hand; the
/// vessel is held in one hand, the plank in two; the rack and the carry each have a slot for a thing.
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
                k("place", &["body", "thing", PAIR, CARRY], &[], None),
            ),
            (fullname(WALKER), k("family", &[], &[1, 2], None)),
            (fullname(VESSEL), k("thing", &[], &[], Some(1))),
            (fullname(RACK), k("thing", &[], &[1], None)),
            (fullname(PLANK), k("thing", &[], &[], Some(2))),
            (fullname(PAIR), k("activity", &[], &[], None)),
            (fullname(CARRY), k("activity", &[], &[1], None)),
            (fullname(COURT), k("thing", &[], &[], None)),
            (fullname(CAN), k("thing", &[], &[], Some(1))),
        ]),
        souls: [w1(), w2()].into(),
        audiences: BTreeMap::new(),
    }
}

/// An activity kind of two roles that claim only the voice, so its members walk and use their hands while in it.
fn activity(kind: &str, roles: [&str; 2]) -> ActivityKind {
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
        (1, Value::Text(name(&fullname(kind)))),
        (2, Value::Uint(1)),
        (3, Value::Array(roles.iter().map(|r| role(r)).collect())),
        (4, Value::Uint(60_000_000)),
        (5, Value::Uint(400_000)),
    ])))
    .expect("an activity kind")
}

/// The forms' entries (`souls-entry/1`): the vessel's take and the rack's put.
fn entries() -> Json {
    let vessel = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:vessel", "owner": "thing",
      "points": { "grip": { "role": "grip", "at_mm": [0, 100, 0] } },
      "forms": { "take": { "who": "anyone", "steps": [{ "step": "take", "move": "press", "at": "grip" }] },
        "discard": { "who": "anyone", "steps": [{ "step": "use_held" }],
          "effects": [{ "change": "remove", "what": "this", "event": "discarded" }] },
        "rest_by": { "who": "anyone",
          "steps": [{ "step": "settle", "posture": "sit" }, { "step": "wait", "us": 500000 }, { "step": "rise" }] } } }"#,
    )
    .unwrap();
    // A create names its kind pinned (C25's `stock`).
    let rack = parse(
        &r#"{ "format": "souls-entry/1", "kind": "test:rack", "owner": "thing",
      "points": { "edge": { "role": "rest", "at_mm": [0, 400, 0] } },
      "slots": { "rest": { "admits": "thing" } },
      "forms": { "put": { "who": "anyone",
        "steps": [{ "step": "put", "move": "press", "at": "edge", "what": { "arg": "item" }, "slot": "rest" }] },
        "stock": { "who": "anyone", "steps": [],
          "effects": [{ "change": "create", "kind": "PLANK", "into": "rest", "event": "stocked" }] },
        "overstock": { "who": "anyone", "steps": [],
          "effects": [{ "change": "create", "kind": "GHOST", "into": "rest", "event": "haunted" }] } } }"#
            .replace("PLANK", &fullname(PLANK))
            .replace("GHOST", &full("test:ghost", 0xff)),
    )
    .unwrap();
    // A game of two ends, as a frisbee is played (#3888): each player takes an end; whoever holds the disc throws
    // it to the other end, which needs a player there (a `linked` need only the world can read).
    let court = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:court", "owner": "thing",
      "state": { "disc": { "n": 28, "type": "enum", "values": ["end_a", "end_b"], "default": "end_a",
        "audience": { "rule": "everyone" } } },
      "links": { "end_a": { "n": 1, "from": "body", "most": 1, "audience": { "rule": "everyone" } },
        "end_b": { "n": 2, "from": "body", "most": 1, "audience": { "rule": "everyone" } } },
      "forms": {
        "play_at_end_a": { "who": "anyone", "starts": "act", "needs": [{ "need": "unlinked", "link": "end_a" }],
          "steps": [], "effects": [{ "change": "link", "link": "end_a", "from": "actor", "event": "joined" }] },
        "play_at_end_b": { "who": "anyone", "starts": "act", "needs": [{ "need": "unlinked", "link": "end_b" }],
          "steps": [], "effects": [{ "change": "link", "link": "end_b", "from": "actor", "event": "joined" }] },
        "throw_from_end_a_to_end_b": { "who": { "link": "end_a" }, "starts": "act",
          "needs": [{ "need": "state", "field": "disc", "is": "end_a" }, { "need": "linked", "link": "end_b" }],
          "steps": [], "effects": [{ "change": "set", "field": "disc", "to": "end_b", "event": "threw" }] } } }"#,
    )
    .unwrap();
    // The watering can's own take (`content/kinds/garden/watering_can.json`): no move and no walk before its hand
    // step, and a free hand its one need (#4086).
    let can = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:can", "owner": "thing",
      "points": { "grip": { "role": "grip", "at_mm": [0, 305, 0] } },
      "geometry": { "bounds_mm": [760, 360, 240] },
      "forms": { "take": { "who": "anyone", "starts": "act", "needs": [{ "need": "hand", "free": true }],
        "steps": [{ "step": "take" }],
        "effects": [{ "change": "reparent", "what": "this", "into": "actor_hand", "event": "taken" }] } },
      "motion": { "how": "one_hand" }, "loose": { "ever": true } }"#,
    )
    .unwrap();
    Json::Obj(vec![
        (VESSEL.into(), vessel),
        (RACK.into(), rack),
        (COURT.into(), court),
        (CAN.into(), can),
    ])
}

fn create(node: Id, kind: &str, parent: Id, at: Vec3) -> (Id, Change) {
    (
        parent,
        Change::Create {
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
    )
}

/// The world as built: the two walkers, the vessel 300 mm from the first, the rack 400 mm from it, the plank between
/// the two.
fn world() -> Replica {
    let g = ground();
    let h = header(g);
    let mut r = Replica::start(h.stored()).expect("a replica");
    let off = |p: Vec3, dx: i64| Vec3::new(p.x + dx, 0, p.z);
    let changes = vec![
        create(w1(), WALKER, g, at1()),
        create(w2(), WALKER, g, at2()),
        create(vessel(), VESSEL, g, off(at1(), 300_000)),
        create(rack(), RACK, g, Vec3::new(at1().x, 0, at1().z + 400_000)),
        create(plank(), PLANK, g, off(at2(), 1_350_000)),
        create(
            court(),
            COURT,
            g,
            Vec3::new(at1().x, 0, at1().z - 2_000_000),
        ),
        create(far_can(), CAN, g, south(100_000_000)),
        create(beyond_can(), CAN, g, south(2_200_000)),
        create(near_can(), CAN, g, south(1_500_000)),
    ];
    let effects: Vec<Value> = changes
        .into_iter()
        .enumerate()
        .map(|(k, (node, change))| {
            Effect {
                envelope: Envelope {
                    sequence: k as u64,
                    at: 0,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node,
                },
                body: Body::Changes(vec![ChangeRec {
                    change,
                    rest: Rest::new(),
                }]),
                events: None,
                rest: Rest::new(),
            }
            .to_value()
        })
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

fn bodies() -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let p1 = town.surfaces[&ground].place(w1(), frame, at1(), Quat::IDENTITY)?;
    let p2 = town.surfaces[&ground].place(w2(), frame, at2(), Quat::IDENTITY)?;
    let mut b = Bodies::new(town, 50_000)?;
    b.add_body(humanoid(), p1)?;
    b.add_body(humanoid(), p2)?;
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

    /// The next answer: a receipt's entries, or a refusal's reason.
    fn answer(&mut self) -> Result<Vec<u64>, String> {
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
            other => panic!("an answer: {other:?}"),
        }
    }

    /// One act and its one answer.
    fn act(
        &mut self,
        verb: &str,
        target: Option<Id>,
        p: BTreeMap<u64, Value>,
    ) -> Result<Vec<u64>, String> {
        self.send(verb, target, p);
        self.answer()
    }
}

/// A world serving on a socket, and a client for each Soul.
struct Run {
    world: answers::World,
    store: Mem,
    path: std::path::PathBuf,
}

fn serve(tag: &str) -> (Run, Client, Client) {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    cfg.engine = Some((
        tree_rules(),
        vec![
            activity(PAIR, ["test:first", "test:second"]),
            activity(CARRY, ["test:front", "test:back"]),
        ],
    ));
    let rules = Rules {
        kinds: entries(),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(world(), rules, store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("c2-{tag}-{}.sock", std::process::id()));
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
    let (a, b) = (client(w1()), client(w2()));
    (Run { world, store, path }, a, b)
}

impl Run {
    /// The world's replica as of now: the world as built with every logged part applied.
    fn replay(&self) -> Replica {
        let mut r = world();
        let log = self.store.0.lock().unwrap().bytes.clone();
        for rec in recover(&log).unwrap().records {
            if sim::recorder::is_input(&rec) {
                continue;
            }
            let p = Part::read(&rec).unwrap();
            if !p.effects.is_empty() {
                r.apply(&p).expect("the log replays");
            }
        }
        r
    }

    /// The node an entry created, by its sequence.
    fn created(&self, entries: &[u64], kind: &str) -> Id {
        let log = self.store.0.lock().unwrap().bytes.clone();
        for rec in recover(&log).unwrap().records {
            if sim::recorder::is_input(&rec) {
                continue;
            }
            for e in Part::read(&rec).unwrap().effects {
                if !entries.contains(&e.envelope.sequence) {
                    continue;
                }
                if let Body::Changes(cs) = &e.body {
                    for c in cs {
                        if let Change::Create { node, kind: k, .. } = &c.change
                            && k.as_str() == fullname(kind)
                        {
                            return *node;
                        }
                    }
                }
            }
        }
        panic!("no {kind} created in {entries:?}")
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

fn p(pairs: &[(u64, Value)]) -> BTreeMap<u64, Value> {
    pairs.iter().cloned().collect()
}

#[test]
fn a2_take_and_put_through_the_gateway_each_one_receipt() {
    let (run, mut a, _) = serve("a2");
    let take = a.act("test:take", Some(vessel()), BTreeMap::new());
    println!("A2 take: {take:?}");
    let take = take.expect("the take lands");
    let held = parent(&run.replay(), vessel());
    println!("A2 held: {held:?}");
    assert_eq!(held.0, Some(w1()), "held: a child of the body");
    assert!(matches!(held.1, Some(1 | 2)), "in a hand's slot");
    let item = Value::Array(vec![Value::Array(vec![
        Value::Bytes(b"item".to_vec()),
        vessel().to_value(),
    ])]);
    let put = a.act("test:put", Some(rack()), p(&[(1, item)]));
    println!("A2 put: {put:?}");
    let put = put.expect("the put lands");
    let set = parent(&run.replay(), vessel());
    println!("A2 set: {set:?}");
    assert_eq!(set, (Some(rack()), Some(1)), "in the rack's slot");
    assert!(
        !take.is_empty() && !put.is_empty(),
        "each receipt names its entries"
    );
    // Holding nothing now, a second put is refused by name.
    let item = Value::Array(vec![Value::Array(vec![
        Value::Bytes(b"item".to_vec()),
        vessel().to_value(),
    ])]);
    let again = a.act("test:put", Some(rack()), p(&[(1, item)]));
    println!("A2 put again: {again:?}");
    assert!(again.is_err(), "nothing held: refused");
    run.stop();
}

#[test]
fn a3_an_activity_and_an_offer_through_the_gateway_each_one_receipt() {
    let (run, mut a, mut b) = serve("a3");
    let g = ground();
    let kind = |k: &str| (1, Value::Text(name(&fullname(k))));
    let proposed = a
        .act("activity:propose", Some(g), p(&[kind(PAIR)]))
        .expect("proposed");
    let act = run.created(&proposed, PAIR);
    let role = |r: &str| (1, Value::Text(name(r)));
    let j1 = a.act("activity:join", Some(act), p(&[role("test:first")]));
    let j2 = b.act("activity:join", Some(act), p(&[role("test:second")]));
    let started = a.act("activity:start", Some(act), BTreeMap::new());
    let l1 = a.act("activity:leave", Some(act), BTreeMap::new());
    let l2 = b.act("activity:leave", Some(act), BTreeMap::new());
    println!("A3: propose {proposed:?} join {j1:?} {j2:?} start {started:?} leave {l1:?} {l2:?}");
    for (what, r) in [
        ("join", &j1),
        ("join", &j2),
        ("start", &started),
        ("leave", &l1),
        ("leave", &l2),
    ] {
        assert!(
            r.as_ref().is_ok_and(|e| !e.is_empty()),
            "{what}: one receipt"
        );
    }
    let r = run.replay();
    assert!(
        r.tree().handle(act).is_none(),
        "the activity ended with its last member"
    );

    // E8: an offer accepted, another declined.
    let offer = |c: &mut Client| {
        c.act(
            "activity:offer",
            Some(g),
            p(&[
                kind(PAIR),
                (2, Value::Text(name("test:first"))),
                (3, Value::Array(vec![w2().to_value()])),
            ]),
        )
    };
    let o1 = offer(&mut a).expect("offered");
    let first = run.created(&o1, PAIR);
    let accepted = b.act("activity:accept", Some(first), BTreeMap::new());
    let left = a.act("activity:leave", Some(first), BTreeMap::new());
    let left2 = b.act("activity:leave", Some(first), BTreeMap::new());
    let o2 = offer(&mut a).expect("offered again");
    let second = run.created(&o2, PAIR);
    let declined = b.act("activity:decline", Some(second), BTreeMap::new());
    println!(
        "A3 offers: offer {o1:?} accept {accepted:?} leave {left:?} {left2:?}; offer {o2:?} decline {declined:?}"
    );
    accepted.expect("the accept lands");
    declined.expect("the decline lands");
    let r = run.replay();
    assert!(
        r.tree().handle(second).is_none(),
        "declined by everyone asked: the offer ended"
    );
    run.stop();
}

#[test]
fn a4_two_souls_carry_a_plank_together_through_the_gateway() {
    let (run, mut a, mut b) = serve("a4");
    let g = ground();
    let proposed = a
        .act(
            "activity:propose",
            Some(g),
            p(&[(1, Value::Text(name(&fullname(CARRY))))]),
        )
        .expect("proposed");
    let carry = run.created(&proposed, CARRY);
    let role = |r: &str| p(&[(1, Value::Text(name(r)))]);
    a.act("activity:join", Some(carry), role("test:front"))
        .expect("the front joins");
    b.act("activity:join", Some(carry), role("test:back"))
        .expect("the back joins");
    a.act("activity:start", Some(carry), BTreeMap::new())
        .expect("started");
    let lift = a.act("carry:lift", Some(carry), p(&[(1, plank().to_value())]));
    println!("A4 lift: {lift:?}");
    lift.expect("lifted");
    assert_eq!(
        parent(&run.replay(), plank()),
        (Some(carry), Some(1)),
        "the plank rides the carry"
    );
    // Both walk 3 m along x, side by side.
    let to = |p: Vec3| {
        let v = |n: i64| {
            u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
        };
        BTreeMap::from([(1, Value::Array(vec![v(p.x + 3_000_000), v(0), v(p.z)]))])
    };
    a.send("eden:walk", Some(g), to(at1()));
    b.send("eden:walk", Some(g), to(at2()));
    let (wa, wb) = (a.answer(), b.answer());
    println!("A4 walks: {wa:?} {wb:?}");
    wa.expect("the front walked");
    wb.expect("the back walked");
    let down = b.act("carry:set-down", Some(carry), BTreeMap::new());
    println!("A4 set down: {down:?}");
    down.expect("set down");
    let r = run.replay();
    let t = r.tree();
    let n = t.node(t.handle(plank()).unwrap()).unwrap();
    let at = n.place().unwrap().position;
    println!("A4 plank on {:?} at {at:?}", n.parent());
    assert_eq!(n.parent(), Some(g), "set down on the ground");
    // The carry's frame was sampled between its carriers each tick they walked (B9's track, in the log).
    let log = run.store.0.lock().unwrap().bytes.clone();
    let samples = recover(&log)
        .unwrap()
        .records
        .iter()
        .filter(|rec| !sim::recorder::is_input(rec))
        .flat_map(|rec| Part::read(rec).unwrap().effects)
        .filter(|e| {
            matches!(&e.body, Body::Changes(cs)
                if cs.iter().any(|c| matches!(c.change, Change::Motion(ref h) if h.node == carry)))
        })
        .count();
    println!("A4 carry samples: {samples}");
    assert!(samples > 20, "sampled through the walk: {samples}");
    let mid = (at1().x + at2().x) / 2 + 3_000_000;
    assert!(
        (at.x - mid).abs() < 300_000,
        "between the carriers where they stopped: x {} near {mid}",
        at.x
    );
    for c in [&mut a, &mut b] {
        c.act("activity:leave", Some(carry), BTreeMap::new())
            .expect("left");
    }
    run.stop();
}

/// C25 (#3496) A1, A3: through the gateway, a form with no steps (the rack's `stock`, which makes a plank in its slot)
/// applies its effect at once: one act, one receipt, the plank in the rack's slot in the log replayed. The vessel's `rest_by` settles the
/// body on the ground, pauses and rises: done. Its `discard` (`use_held`, then a removal) is refused `not-held` while
/// the body does not hold it, and after a take removes it: done.
#[test]
fn c25_no_steps_settle_rise_and_use_held_through_the_gateway() {
    let (run, mut a, _) = serve("c25");
    let stocked = a.act("test:stock", Some(rack()), BTreeMap::new());
    println!("C25 stock: {stocked:?}");
    assert!(!stocked.expect("the stock lands").is_empty(), "one receipt");
    let r = run.replay();
    let t = r.tree();
    let made = t.children(t.handle(rack()).unwrap()).map_or(0, <[_]>::len);
    assert_eq!(made, 1, "a plank in the rack's slot");
    let rested = a.act("test:rest_by", Some(vessel()), BTreeMap::new());
    println!("C25 rest_by: {rested:?}");
    assert!(rested.is_ok(), "settled, paused and rose");
    let early = a.act("test:discard", Some(vessel()), BTreeMap::new());
    println!("C25 discard before a take: {early:?}");
    assert_eq!(early, Err("not-held".to_owned()));
    a.act("test:take", Some(vessel()), BTreeMap::new())
        .expect("the take lands");
    let discarded = a.act("test:discard", Some(vessel()), BTreeMap::new());
    println!("C25 discard: {discarded:?}");
    assert!(!discarded.expect("the discard lands").is_empty());
    assert!(
        run.replay().tree().handle(vessel()).is_none(),
        "the vessel is gone"
    );
    run.stop();
}

/// C24 (#3495) A1: a form's `timer` effect is written as the node's timer (one entry), goes on the forms' due list,
/// and when it fires its clear is written and its form starts on the node with the world as actor and runs to its
/// end; the tree holds no timer after.
#[test]
fn c24_a_forms_timer_fires_and_starts_its_form_with_the_world_as_actor() {
    use worldd::acts::{Acts, Args, intent, library};
    let vessel_entry = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:vessel", "owner": "thing",
      "forms": {
        "ring": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
          "effects": [{ "change": "timer", "form": "quiet", "after_us": 200000, "event": "will_quiet" }] },
        "quiet": { "who": "world", "steps": [{ "step": "wait", "us": 50000 }] } } }"#,
    )
    .unwrap();
    let mut r = world();
    let mut b = bodies().expect("the bodies");
    let mut acts = Acts::new(
        Json::Obj(vec![(VESSEL.into(), vessel_entry)]),
        library().expect("the moves"),
        header(ground()),
        Scope([0xc4; 16]),
    );
    let (mut now, mut tick) = (1_000_000_i64, 0u64);
    b.begin(now);
    let ask = intent(id(9000), now + 60_000_000, Actor::Soul(w1()), b"ring");
    let started = acts.start(
        r.tree(),
        Some(&mut b),
        w1(),
        &[(vessel(), "ring".to_owned())],
        &Args::default(),
        ask,
        tick,
        now,
    );
    assert!(
        matches!(started, Ok(sim::forms::Asked::Started(_))),
        "{started:?}"
    );
    let (mut ended, mut timers) = (Vec::new(), Vec::new());
    while ended.len() < 2 && now < 5_000_000 {
        now += 50_000;
        tick += 1;
        let _ = b.step(now);
        acts.tick(r.tree(), Some(&mut b), tick, now);
        let mut out = acts.out();
        for (k, e) in out.iter_mut().enumerate() {
            e.envelope.sequence = r.version() + k as u64;
        }
        if !out.is_empty() {
            let part = sim::commit::write(&mut r, &out).expect("the forms' entries commit");
            for e in &part.effects {
                acts.forms.logged(e);
                if let Body::Timers(t) = &e.body {
                    timers.push((e.envelope.at, t.clone()));
                }
            }
        }
        if r.tree().timers().len() == 1 {
            println!("{now} µs: pending {:?}", r.tree().timers().values().next());
        }
        ended.extend(acts.ended());
    }
    let fired: Vec<_> = acts.fired.drain(..).collect();
    println!("timer entries: {timers:?}\nfired: {fired:?}\nended: {ended:?}");
    assert_eq!(timers.len(), 2, "set, then cleared as it fired");
    assert!(matches!(
        &fired[..],
        [(_, Ok(sim::forms::Asked::Started(_)))]
    ));
    assert_eq!(ended.len(), 2, "the act's run, then the timer's");
    assert!(ended.iter().all(|(_, how, _)| how == "done"), "{ended:?}");
    assert_eq!(
        ended[1].0, fired[0].0,
        "the timer's run is keyed by the timer"
    );
    assert!(r.tree().timers().is_empty());
}

#[path = "acts/effect_refused.rs"]
mod effect_refused;
#[path = "acts/named_args.rs"]
mod named_args;

/// #3888 A1, A2: the world decides a form's needs at commit, links included, by R2's one evaluator, whatever the
/// client said. A throw to an end nobody plays is refused `not_linked` naming need 1, and nothing changes; with a
/// Soul at that end it is done and the disc is there. An end already taken is refused `already_linked` (need 0),
/// as chess's `play_white` is when white is taken.
#[test]
fn i3888_a_forms_needs_are_the_worlds_at_commit() {
    let (run, mut a, mut b) = serve("i3888");
    let disc = |run: &Run| {
        let r = run.replay();
        let t = r.tree();
        t.node(t.handle(court()).unwrap())
            .unwrap()
            .fields()
            .get(&28)
            .cloned()
    };
    let none = BTreeMap::new;
    a.act("test:play_at_end_a", Some(court()), none())
        .expect("a takes end a");
    let alone = a.act("test:throw_from_end_a_to_end_b", Some(court()), none());
    println!("#3888 throw with nobody at end b: {alone:?}");
    assert_eq!(
        alone,
        Err("not_linked".to_owned()),
        "refused by the need's name"
    );
    assert_eq!(
        disc(&run),
        None,
        "nothing changed: the disc is still at end a"
    );
    let taken = b.act("test:play_at_end_a", Some(court()), none());
    println!("#3888 end a again: {taken:?}");
    assert_eq!(taken, Err("already_linked".to_owned()));
    b.act("test:play_at_end_b", Some(court()), none())
        .expect("b takes end b");
    let thrown = a.act("test:throw_from_end_a_to_end_b", Some(court()), none());
    println!("#3888 throw with b at end b: {thrown:?}");
    assert!(!thrown.expect("the throw lands").is_empty());
    assert_eq!(disc(&run), Some(Value::Text(name("test:end_b"))));
    // The disc is at end b now: a's throw from end a is refused by the state need (need 0).
    let again = a.act("test:throw_from_end_a_to_end_b", Some(court()), none());
    assert_eq!(again, Err("field_differs".to_owned()));
    run.stop();
}

/// Where node `n` is in its frame, as the world's records have it.
fn at(r: &Replica, n: Id) -> Vec3 {
    let t = r.tree();
    t.node(t.handle(n).expect("the node"))
        .expect("the node")
        .place()
        .expect("a place")
        .position
}

/// #4086: no take at a distance. A watering can's `take` has no walk and no move before its hand step (the can's own
/// form, as Eden and Mars serve it). Before this change a body 100 m away was handed the can at once, never moving
/// (A1). Now the world measures the reach at commit: the can 100 m away and one just beyond a form's reach (2.2 m)
/// are refused `out_of_reach`, naming the walk that would work, with nothing changed; one within it (1.5 m) is taken.
/// The body's place and the cans' parents are read from the world's records.
#[test]
fn w10_a_take_with_no_walk_needs_the_thing_in_reach() {
    let (run, mut a, _) = serve("w10");
    let none = BTreeMap::new;
    let before = at(&run.replay(), w1());
    let far = a.act("test:take", Some(far_can()), none());
    let r = run.replay();
    println!(
        "W10 take 100 m: {far:?}; body {before:?} then {:?}; can at {:?}, parent {:?}",
        at(&r, w1()),
        at(&r, far_can()),
        parent(&r, far_can())
    );
    assert_eq!(far, Err("out_of_reach".to_owned()), "refused by name");
    assert_eq!(at(&r, w1()), before, "the body has not moved");
    assert_eq!(parent(&r, far_can()), (Some(ground()), None), "the can lies where it lay");
    let beyond = a.act("test:take", Some(beyond_can()), none());
    println!("W10 take 2.2 m: {beyond:?}");
    assert_eq!(beyond, Err("out_of_reach".to_owned()));
    assert_eq!(parent(&run.replay(), beyond_can()), (Some(ground()), None));
    let near = a.act("test:take", Some(near_can()), none());
    let r = run.replay();
    println!("W10 take 1.5 m: {near:?}; parent {:?}", parent(&r, near_can()));
    assert!(!near.expect("within reach: taken").is_empty());
    assert_eq!(parent(&r, near_can()).0, Some(w1()), "in the body's hand");
    assert_eq!(at(&r, w1()), before, "taken where the body stands");
    run.stop();
}
