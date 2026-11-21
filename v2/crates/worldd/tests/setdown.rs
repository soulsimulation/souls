//! Engine v2 E4's caller (#3604): an agent puts its held thing down through E4's legal placement, through the world's
//! end of the gateway's socket (I1's framing), on N2's test world with born bodies (C3), as `join.rs` serves it.
//!
//! - A1: a Soul takes a forever-policy vessel (B4), walks 2 m holding it, and sets it down (`hands:set-down`, `here`):
//!   one receipt, the same vessel on the open ground near the body (not under it), its hand free, one parent at
//!   every position of the log, no loose timer; a restart from the log keeps it where it was put.
//! - A2: a set-down by a Soul that does not hold the thing, a second set-down of a thing already down, a repeated
//!   intent, an `on` with no surface and an intent expired before its commit are each refused by name and leave the
//!   thing where it was; a two-handed crate fills both hands while held and frees both when set down.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

use import_eden::Import;
use replica::activity::ActivityKind;
use replica::apply::Replica;
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
use worldd::answers::{self, Config, JOIN, Join};
use worldd::bodies::Bodies;
use worldd::checkers::Rules;

const LINEAGE: Scope = Scope([0xd4; 16]);
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
/// A two-handed thing (B4 section 18: `hands` 2).
const CRATE: &str = "test:crate";
/// K10's body kind, as a birth writes it.
const BODY: &str = "souls:body";

fn kinds() -> Vec<(&'static str, String)> {
    [PLACE, VESSEL, RACK, PAIR, BODY, CRATE]
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

/// The bodies' town: the world as built (its things, its header and rules), as a world builds it from its replica,
/// so a part the world writes installs on it (G3).
fn world_town() -> (Town, Id) {
    let r = world();
    let ground = ground();
    let doors = Doors::new(r.header().clone(), tree_rules(), r.tree().to_state().next);
    let town = Town::new(r.tree().frozen(), ground, doors).expect("the town");
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
fn crate_() -> Id {
    id(6)
}

/// The world's entry on the open ground, west of the square, µm: the first birth stands 1 m east of it (K10's ring).
fn entry() -> Vec3 {
    Vec3::new(-40_000_000, 0, 30_000_000)
}
fn first_spot() -> Vec3 {
    Vec3::new(-39_000_000, 0, 30_000_000)
}

/// The world's rules (T2): the ground takes bodies, things and activities; a body holds a thing in each hand.
fn tree_rules() -> TreeRules {
    let mut rules = import_eden::load(&testworld::generate(1, 0).unwrap().text)
        .unwrap()
        .rules;
    let ground_kind = {
        let (town, g) = town();
        let t = &town.tree;
        t.node(t.handle(g).unwrap())
            .unwrap()
            .kind()
            .as_str()
            .to_owned()
    };
    if let Some(k) = rules.kinds.get_mut(&ground_kind) {
        k.children
            .extend(["body", "thing", PAIR].map(str::to_owned));
    }
    rules.kinds.extend(ours());
    rules
}

fn ours() -> BTreeMap<String, Kind> {
    let k = |owner: &str, children: &[&str], slots: &[u64], hands| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: slots
            .iter()
            .map(|s| (*s, BTreeSet::from(["thing".to_owned()])))
            .collect(),
        hands,
    };
    {
        BTreeMap::from([
            (
                fullname(PLACE),
                k("place", &["body", "thing", PAIR], &[], None),
            ),
            (fullname(BODY), k("family", &[], &[1, 2], None)),
            (fullname(VESSEL), k("thing", &[], &[], Some(1))),
            (fullname(RACK), k("thing", &[], &[1], None)),
            (fullname(PAIR), k("activity", &[], &[], None)),
            (fullname(CRATE), k("thing", &[], &[], Some(2))),
        ])
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
        r#"{ "format": "souls-entry/1", "kind": "test:vessel", "owner": "thing", "loose": { "ever": true },
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
    let crate_ = parse(
        r#"{ "format": "souls-entry/1", "kind": "test:crate", "owner": "thing",
      "points": { "grip": { "role": "grip", "at_mm": [0, 100, 0] } },
      "forms": { "take": { "who": "anyone", "steps": [{ "step": "take", "move": "press", "at": "grip" }] } } }"#,
    )
    .unwrap();
    Json::Obj(vec![
        (VESSEL.into(), vessel),
        (RACK.into(), rack),
        (CRATE.into(), crate_),
    ])
}

fn create(sequence: u64, node: Id, kind: &str, parent: Id, at: Vec3) -> Value {
    create_with(sequence, node, kind, parent, at, BTreeMap::new())
}

/// The crate's one box (N1's solids, mm): 600 mm square, 800 mm high, so walkers go round it where it is set down.
fn crate_box() -> BTreeMap<u64, Value> {
    let row = [0u64, 0, 300, 300, 0, 0, 800].map(Value::Uint).to_vec();
    BTreeMap::from([(
        sim::ground::scene::F_SOLIDS,
        Value::Array(vec![Value::Array(row)]),
    )])
}

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
                fields,
            },
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    }
    .to_value()
}

/// The world as built: a vessel 300 mm east of the first birth's spot, a rack 400 mm south of it, a boxed crate 700 mm
/// west. No body.
fn world() -> Replica {
    // N2's test world as imported (its open ground and buildings), so the edit checker's town has ground to plan on;
    // its header pins the imported kinds and this test's.
    let im = import_eden::load(&testworld::generate(1, 0).expect("the test world").text)
        .expect("the test world loads");
    let h = import_eden::header(im.nodes["world"], &tree_rules()).expect("a header");
    let mut r = Replica::start(h.stored()).expect("a replica");
    let g = ground();
    let s = first_spot();
    let mut effects: Vec<Value> = im.effects.iter().map(Effect::to_value).collect();
    let next = effects.len() as u64;
    effects.extend([
        create(next, vessel(), VESSEL, g, Vec3::new(s.x + 300_000, 0, s.z)),
        create(next + 1, rack(), RACK, g, Vec3::new(s.x, 0, s.z + 400_000)),
        create_with(
            next + 2,
            crate_(),
            CRATE,
            g,
            // Clear of the first two spots of the birth ring with its box (a body's 280 mm radius), and within a
            // press's reach of the first.
            Vec3::new(s.x - 700_000, 0, s.z),
            crate_box(),
        ),
    ]);
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
    let (town, ground) = world_town();
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
        self.send_until(verb, target, parameters, answers::now() + 60_000_000);
    }

    fn send_until(
        &mut self,
        verb: &str,
        target: Option<Id>,
        parameters: BTreeMap<u64, Value>,
        expiry: i64,
    ) {
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
            expiry,
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
    let path = std::env::temp_dir().join(format!("e4c-{tag}-{}.sock", std::process::id()));
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

fn p(pairs: &[(u64, Value)]) -> BTreeMap<u64, Value> {
    pairs.iter().cloned().collect()
}

const SET_DOWN: &str = "hands:set-down";

fn word(w: &str) -> BTreeMap<u64, Value> {
    p(&[(1, Value::Text(name(&format!("place:{w}"))))])
}

/// Where `node` stands on the open ground (µm), its parent and slot.
fn at(r: &Replica, node: Id) -> (Option<Id>, Option<u64>, Vec3) {
    let t = r.tree();
    let n = t.node(t.handle(node).expect("the node")).expect("the node");
    (n.parent(), n.slot(), n.place().expect("placed").position)
}

/// Each position of the log at which `node` has a parent: after each part, the number of parents it has (a transfer
/// in flight between a leave and its arrive counts none, and the two are in one part).
fn parents_through(run: &Run, node: Id) -> Vec<usize> {
    let mut r = world();
    let mut out = Vec::new();
    for part in run.log() {
        if part.effects.is_empty() {
            continue;
        }
        r.apply(&part).expect("the log replays");
        let t = r.tree();
        out.push(
            t.handle(node)
                .and_then(|h| t.node(h))
                .and_then(|n| n.parent())
                .map_or(0, |_| 1),
        );
    }
    out
}

/// The free hands of `body` on `r`, by B4's accounting (a two-handed thing counts both).
fn free(r: &Replica, body: Id) -> usize {
    sim::slots::hands::free_hands(
        r.tree(),
        &tree_rules(),
        body,
        &sim::slots::hands::hands(&humanoid()),
    )
    .len()
}

fn walk_to(c: &mut Client, x: i64, z: i64) {
    let v =
        |n: i64| u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint);
    let walked = c.act(
        "eden:walk",
        Some(ground()),
        p(&[(1, Value::Array(vec![v(x), v(0), v(z)]))]),
    );
    println!("walk to {x},{z}: {walked:?}");
    walked.expect("walked");
}

#[test]
fn a1_take_walk_and_set_down_one_receipt_one_parent_kept_across_a_restart() {
    let (run, mut a, _b) = serve("a1");
    a.act(JOIN, None, BTreeMap::new()).expect("Ada joins");
    let body = run.body_of(ada()).expect("born");
    a.act("test:take", Some(vessel()), BTreeMap::new())
        .expect("the take lands");
    let held = at(&run.replay(), vessel());
    assert_eq!(held.0, Some(body), "held by the body");
    assert!(matches!(held.1, Some(1 | 2)), "in a hand's slot");
    assert_eq!(free(&run.replay(), body), 1, "one hand holds it");
    // Walk 2 m east holding it.
    let s = first_spot();
    walk_to(&mut a, s.x + 2_000_000, s.z);
    assert_eq!(
        at(&run.replay(), vessel()).0,
        Some(body),
        "still in the hand"
    );
    let down = a.act(SET_DOWN, Some(vessel()), word("here"));
    println!("A1 set down: {down:?}");
    let entries = down.expect("set down: one receipt");
    let r = run.replay();
    let (parent, slot, pos) = at(&r, vessel());
    println!("A1 vessel on {parent:?} slot {slot:?} at {pos:?}; receipt entries {entries:?}");
    assert_eq!(parent, Some(ground()), "on the open ground");
    assert_eq!(slot, None, "in no slot");
    assert_eq!(free(&r, body), 2, "the hand is free");
    let d = ((pos.x - (s.x + 2_000_000)).pow(2) + (pos.z - s.z).pow(2)).isqrt();
    println!("A1 distance from where the body stands: {d} um");
    assert!(d < 1_500_000, "near the body where it walked to: {d} um");
    assert!(d > 200_000, "not under the body: {d} um");
    assert_eq!(entries.len(), 2, "one transfer: its leave and its arrive");
    let n = r.tree().node(r.tree().handle(vessel()).unwrap()).unwrap();
    assert!(
        matches!(n.place().unwrap().support, Support::Surface { surface, .. } if surface == ground()),
        "supported by the ground"
    );
    let parents = parents_through(&run, vessel());
    assert!(
        parents.iter().all(|&n| n == 1),
        "one parent throughout: {parents:?}"
    );
    let timers = r
        .tree()
        .timers()
        .values()
        .filter(|t| t.node == vessel())
        .count();
    assert_eq!(timers, 0, "a forever thing gets no loose timer");
    // A restart from the log: the vessel is where it was put.
    let bytes = run.bytes();
    run.stop();
    let (again, mut a2, _b2) = serve_on("a1-restart", Mem::with(bytes), None);
    let r2 = again.replay();
    assert_eq!(
        at(&r2, vessel()),
        (parent, slot, pos),
        "kept across the restart"
    );
    // The restarted world still answers the Soul: a second set-down of what is already down is refused.
    // (A fresh sequence: the restarted world keeps the Soul's answered ones.)
    a2.2 = 100;
    let twice = a2.act(SET_DOWN, Some(vessel()), word("here"));
    println!("A1 after restart, again: {twice:?}");
    assert_eq!(twice, Err("not-held".to_owned()));
    again.stop();
}

#[test]
fn a2_refusals_leave_the_thing_held_and_two_hands_are_counted() {
    let (run, mut a, mut b) = serve("a2");
    a.act(JOIN, None, BTreeMap::new()).expect("Ada joins");
    b.act(JOIN, None, BTreeMap::new()).expect("Bo joins");
    let body = run.body_of(ada()).expect("born");
    a.act("test:take", Some(vessel()), BTreeMap::new())
        .expect("the take lands");
    let held = at(&run.replay(), vessel());
    // Wrong holder: Bo does not hold it.
    let wrong = b.act(SET_DOWN, Some(vessel()), word("here"));
    println!("A2 wrong holder: {wrong:?}");
    assert_eq!(wrong, Err("not-held".to_owned()));
    assert_eq!(at(&run.replay(), vessel()), held, "still in Ada's hand");
    // On a thing with no top to rest on.
    let on = a.act(SET_DOWN, Some(vessel()), {
        let mut m = word("on");
        m.insert(2, rack().to_value());
        m
    });
    println!("A2 on the rack: {on:?}");
    assert!(
        on.as_ref().is_err_and(|r| r.starts_with("setdown.")),
        "refused by E4's name: {on:?}"
    );
    assert_eq!(at(&run.replay(), vessel()), held, "still in the hand");
    // An unknown word.
    let bad = a.act(SET_DOWN, Some(vessel()), word("under"));
    assert_eq!(bad, Err("setdown.unknown-word".to_owned()));
    // Expired before it could be committed: nothing is transferred.
    a.send_until(SET_DOWN, Some(vessel()), word("here"), answers::now() - 1);
    let late = a.answer().1;
    println!("A2 expired: {late:?}");
    assert_eq!(late, Err("intent.expired".to_owned()));
    assert_eq!(at(&run.replay(), vessel()), held, "still in the hand");
    // Set down, then the same intent again (its kept answer, nothing written twice), and a fresh one for a thing no
    // longer held.
    a.act(SET_DOWN, Some(vessel()), word("here"))
        .expect("set down");
    let down = at(&run.replay(), vessel());
    a.2 -= 1;
    let stale = a.act(SET_DOWN, Some(vessel()), word("here"));
    println!("A2 the same sequence again: {stale:?}");
    assert!(stale.is_ok(), "a repeat gets its kept answer: {stale:?}");
    let again = a.act(SET_DOWN, Some(vessel()), word("here"));
    println!("A2 a fresh one: {again:?}");
    assert_eq!(again, Err("not-held".to_owned()));
    assert_eq!(at(&run.replay(), vessel()), down, "moved once");
    // A two-handed crate: both hands while held, both free once set down.
    assert_eq!(free(&run.replay(), body), 2);
    a.act("test:take", Some(crate_()), BTreeMap::new())
        .expect("the crate is taken");
    assert_eq!(
        free(&run.replay(), body),
        0,
        "a two-handed thing fills both"
    );
    let put = a.act(SET_DOWN, Some(crate_()), word("here"));
    println!("A2 crate set down: {put:?}");
    put.expect("set down");
    let r = run.replay();
    assert_eq!(at(&r, crate_()).0, Some(ground()));
    assert_eq!(free(&r, body), 2, "both hands free");
    run.stop();
}

/// Each position `body` was logged at, in order (the tick parts' moved bodies, K18), on the open ground, µm.
fn track(run: &Run, body: Id) -> Vec<Vec3> {
    run.log()
        .iter()
        .filter_map(|p| match p.rest.get(&answers::BODIES) {
            Some(Value::Array(rows)) => Some(rows.clone()),
            _ => None,
        })
        .flatten()
        .filter_map(|r| worldd::bodies::read_row(&r))
        .filter(|(b, _, _)| *b == body)
        .map(|(_, pose, _)| pose.position)
        .collect()
}

/// The walker-map follow-up of #3604: a thing walkers go round, set down across a route, reaches the walkers' town
/// and the planner's copy in the same commit (the edits' prepared maps, `Bodies::commit_map`), so the next walk
/// across it goes round it, never through it. Before, only the edit checker's town took it and Bo walked straight
/// through the crate.
#[test]
fn a_crate_set_down_across_a_route_is_walked_round() {
    let (run, mut a, mut b) = serve("walk-round");
    a.act(JOIN, None, BTreeMap::new()).expect("Ada joins");
    b.act(JOIN, None, BTreeMap::new()).expect("Bo joins");
    let bo_body = run.body_of(bo()).expect("Bo is born");
    a.act("test:take", Some(crate_()), BTreeMap::new())
        .expect("the crate is taken");
    // Ada carries it 4 m east and sets it down there; then steps 3 m north, out of the way.
    let s = first_spot();
    walk_to(&mut a, s.x + 4_000_000, s.z);
    a.act(SET_DOWN, Some(crate_()), word("here"))
        .expect("set down: one receipt");
    let (parent, _, c) = at(&run.replay(), crate_());
    assert_eq!(parent, Some(ground()), "the crate is on the open ground");
    walk_to(&mut a, s.x + 4_000_000, s.z + 3_000_000);
    // Bo goes to 3 m west of the crate, then walks to 3 m east of it: the straight line runs through its middle.
    walk_to(&mut b, c.x - 3_000_000, c.z);
    let from = track(&run, bo_body).len();
    walk_to(&mut b, c.x + 3_000_000, c.z);
    let path = &track(&run, bo_body)[from..];
    let nearest = path
        .iter()
        .map(|p| ((p.x - c.x).pow(2) + (p.z - c.z).pow(2)).isqrt())
        .min()
        .expect("Bo moved");
    let end = path.last().expect("Bo moved");
    println!(
        "walk round: crate at {c:?}; Bo walked {} samples, nearest {nearest} um to its middle, ended at {end:?}",
        path.len()
    );
    assert!(
        nearest > 300_000,
        "Bo's walk went round the crate's box, not through it: nearest {nearest} um"
    );
    assert!(
        (end.x - (c.x + 3_000_000)).abs() < 500_000,
        "Bo got across: {end:?}"
    );
    run.stop();
}
