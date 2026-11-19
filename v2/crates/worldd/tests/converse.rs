//! Engine v2 E26 (#3329): a conversation is an activity Souls join, and the other may decline. Three scripted Souls
//! on the world's end of the gateway's socket (I1's framing), on N2's test world, whose bodies are nodes of the tree.
//! The conversation's kind is `replica/fixtures/activities/conversation.diag`.
//!
//! - A1: the opener offers it (E8), the other accepts, each takes three turns into it (E26a: a `say` whose target is
//!   the activity) and each leaves; every step's entries are in the log as that Soul's.
//! - A2: a decline is an entry addressed to the opener alone, naming it; a turn into the declined one is refused and
//!   nothing is said.
//! - A3: a private conversation's words are kept for its members only: no public reader and no non-member may read
//!   them, and none is in the log. A public conversation's turns are ordinary talk: public, at talk's reach.
//! - A4: a member reads every turn back from the text store in under 2 s; a non-member is refused.
//! - A5: a leave is accepted; after a restart the conversation and its members are still there, a member speaks in
//!   it, and both leave.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use import_eden::Import;
use replica::activity::{ActivityKind, MEMBER, OFFER_DECLINED};
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, fixture_bytes,
    read_id, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Intent, Target};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::Value as Json;
use replica::speech::{SAID, Said};
use replica::tree::Rules as TreeRules;
use replica::world_model::{Audience, Kind};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::text::Store;
use sim::walk::town::Town;
use worldd::answers::{self, Config};
use worldd::bodies::Bodies;
use worldd::checkers::Rules;
use worldd::words::SAY_REACH_MM;

const LINEAGE: Scope = Scope([0xe2; 16]);
const PLACE: &str = "souls:place";
const WALKER: &str = "test:walker";
const OPENER: &str = "souls:opener";
const MEMBER_ROLE: &str = "souls:member";

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

/// The conversation's kind, as the fixture writes it.
fn conversation() -> ActivityKind {
    let text = include_str!("../../replica/fixtures/activities/conversation.diag");
    let bytes = fixture_bytes(text).expect("the fixture encodes");
    ActivityKind::from_value(&decode(&bytes).unwrap().value).expect("a conversation kind")
}

fn pinned(plain: &str, n: u8) -> String {
    format!("{plain}@1220{}{n:02x}", "00".repeat(31))
}

/// The kinds in pinned order: (plain name, full name).
fn kinds() -> Vec<(&'static str, String)> {
    vec![
        (PLACE, pinned(PLACE, 1)),
        (WALKER, pinned(WALKER, 2)),
        ("souls:conversation", conversation().name.as_str().to_owned()),
    ]
}

fn full(plain: &str) -> String {
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

/// N2's test world as a town and its ground (the replica's zone is rooted at that ground).
fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/e26-town/1").to_bytes()),
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

/// The three Souls' bodies (each Soul's id is its body's here).
fn soul(n: u64) -> Id {
    Id::new(Scope([0x7e; 16]), n).unwrap()
}

/// Where the bodies stand on the test world's open ground, west of the square, µm: two a metre apart, the third 2 m on.
fn at(n: u64) -> Vec3 {
    Vec3::new(-40_000_000 - (n as i64 - 1) * 1_000_000, 0, 30_000_000)
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/e26-converse/1").to_bytes()),
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

/// The world's rules (T2): the ground takes bodies and conversations.
fn tree_rules() -> TreeRules {
    let k = |owner: &str, children: &[&str]| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: BTreeMap::new(),
        hands: None,
    };
    TreeRules {
        kinds: BTreeMap::from([
            (full(PLACE), k("place", &["body", "souls:conversation"])),
            (full(WALKER), k("family", &[])),
            (full("souls:conversation"), k("activity", &[])),
        ]),
        souls: [soul(1), soul(2), soul(3)].into(),
        audiences: BTreeMap::new(),
    }
}

/// The world as built: three walkers on the ground.
fn world() -> Replica {
    let g = ground();
    let h = header(g);
    let mut r = Replica::start(h.stored()).expect("a replica");
    let effects: Vec<Value> = (1..=3)
        .map(|n| {
            Effect {
                envelope: Envelope {
                    sequence: n - 1,
                    at: 0,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node: g,
                },
                body: Body::Changes(vec![ChangeRec {
                    change: Change::Create {
                        node: soul(n),
                        kind: name(&full(WALKER)),
                        pose: Pose {
                            frame: Frame {
                                node: g,
                                slot: None,
                            },
                            position: at(n),
                            orientation: Quat::IDENTITY,
                            support: Support::Surface {
                                surface: g,
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
    let mut b = Bodies::new(town.clone(), 50_000)?;
    for n in 1..=3 {
        let p = town.surfaces[&ground].place(soul(n), frame, at(n), Quat::IDENTITY)?;
        b.add_body(humanoid(), p)?;
    }
    Ok(b)
}

/// A scripted Soul on the world's socket: its stream, its id and its last sequence.
struct Client(UnixStream, Id, u64);

impl Client {
    /// One intent and its one answer: a receipt's entries, or a refusal's reason.
    fn act(&mut self, verb: &str, target: Option<Id>, p: &[(u64, Value)]) -> Result<Vec<u64>, String> {
        self.2 += 1;
        let i = Intent {
            actor: Actor::Soul(self.1),
            verb: name(verb),
            target: target.map(Target::Node),
            parameters: p.iter().cloned().collect(),
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
            other => panic!("an answer: {other:?}"),
        }
    }

    /// A turn: a `say` into the conversation (private, E26a), or out loud (public).
    fn say(&mut self, into: Option<Id>, words: &str) -> Result<Vec<u64>, String> {
        let w = Value::Map(BTreeMap::from([(23, Value::Bytes(words.as_bytes().to_vec()))]));
        self.act("test:say", into, &[(1, w)])
    }
}

/// A world serving on a socket, its log and its text store.
struct Run {
    world: answers::World,
    store: Mem,
    text: Arc<Store>,
    path: std::path::PathBuf,
}

fn serve_on(tag: &str, store: Mem, text: Arc<Store>) -> Run {
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    cfg.engine = Some((tree_rules(), vec![conversation()]));
    cfg.text = Some(Arc::clone(&text));
    let rules = Rules {
        kinds: Json::Obj(Vec::new()),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(world(), rules, store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("e26-{tag}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, stream));
        }
    });
    Run {
        world,
        store,
        text,
        path,
    }
}

fn serve(tag: &str) -> Run {
    serve_on(
        tag,
        Mem::with(Vec::new()),
        Arc::new(worldd::words::in_memory(LINEAGE).unwrap()),
    )
}

impl Run {
    /// A client for Soul `n`, its sequences carrying on from `last`.
    fn client(&self, n: u64, last: u64) -> Client {
        let s = UnixStream::connect(&self.path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        Client(s, soul(n), last)
    }

    /// Every logged entry, in order.
    fn entries(&self) -> Vec<Effect> {
        let log = self.store.0.lock().unwrap().bytes.clone();
        recover(&log)
            .unwrap()
            .records
            .into_iter()
            .filter(|r| !sim::recorder::is_input(r))
            .flat_map(|r| Part::read(&r).unwrap().effects)
            .collect()
    }

    /// The node the entries numbered `seq` created of the conversation's kind.
    fn created(&self, seq: &[u64]) -> Id {
        for e in self.entries() {
            if !seq.contains(&e.envelope.sequence) {
                continue;
            }
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    if let Change::Create { node, kind, .. } = &c.change
                        && kind.as_str() == full("souls:conversation")
                    {
                        return *node;
                    }
                }
            }
        }
        panic!("no conversation created in {seq:?}")
    }

    /// Every utterance in the log, with its speaker's body.
    fn said(&self) -> Vec<(Id, Said)> {
        let mut out = Vec::new();
        for e in self.entries() {
            for ev in e.events.iter().flatten().filter(|ev| ev.name.as_str() == SAID) {
                out.push((
                    e.envelope.node,
                    Said::read(&ev.to_value(), e.envelope.audience).unwrap(),
                ));
            }
        }
        out
    }

    /// The world's tree replayed from the log: the conversation's node and its members' bodies, if it is there.
    fn members(&self, conv: Id) -> Option<BTreeSet<Id>> {
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
        let t = r.tree();
        t.handle(conv)?;
        Some(
            t.links_at(conv)
                .iter()
                .filter(|e| t.ty(e).as_str() == MEMBER)
                .filter_map(|e| t.link(e.link))
                .map(|(_, ends, _, _)| ends[0])
                .collect(),
        )
    }

    fn stop(self) -> (Mem, Arc<Store>) {
        self.world.stop();
        let _ = std::fs::remove_file(&self.path);
        (self.store, self.text)
    }
}

/// The opener's offer to Soul 2, under the ground.
fn offer(c: &mut Client) -> Result<Vec<u64>, String> {
    c.act(
        "activity:offer",
        Some(ground()),
        &[
            (1, Value::Text(conversation().name)),
            (2, Value::Text(name(OPENER))),
            (3, Value::Array(vec![soul(2).to_value()])),
        ],
    )
}

/// Each entry `seq` names is in the log, written as `soul`'s.
fn as_souls(run: &Run, seq: &[u64], soul: Id) -> bool {
    let es: Vec<Effect> = run
        .entries()
        .into_iter()
        .filter(|e| seq.contains(&e.envelope.sequence))
        .collect();
    !es.is_empty() && es.len() == seq.len() && es.iter().all(|e| e.envelope.actor == Actor::Soul(soul))
}

#[test]
fn a1_a3_a4_two_souls_open_talk_privately_and_leave() {
    let run = serve("a1");
    let (mut a, mut b, mut c) = (run.client(1, 0), run.client(2, 0), run.client(3, 0));
    let mut steps: Vec<(&str, Id, Vec<u64>)> = Vec::new();
    let o = offer(&mut a).expect("A1: offered");
    let conv = run.created(&o);
    steps.push(("offer", soul(1), o));
    let acc = b.act("activity:accept", Some(conv), &[]).expect("A1: accepted");
    steps.push(("accept", soul(2), acc));
    assert_eq!(run.members(conv), Some([soul(1), soul(2)].into()), "A1: both are members");
    let turns = [
        "shall we talk about the garden",
        "yes, the beans are up",
        "the north bed needs water",
        "I can carry the can",
        "then tomorrow at nine",
        "nine it is",
    ];
    for (k, t) in turns.iter().enumerate() {
        let (who, s) = if k % 2 == 0 { (&mut a, soul(1)) } else { (&mut b, soul(2)) };
        let r = who.say(Some(conv), t).expect("A1: a member's turn");
        steps.push(("turn", s, r));
    }
    // A3: a non-member beside them speaking into it is refused, and nothing is said.
    let refused = c.say(Some(conv), "may I listen in");
    assert_eq!(refused, Err("not-a-member".to_owned()), "A3: refused by name");
    let l1 = a.act("activity:leave", Some(conv), &[]).expect("A1: the opener leaves");
    steps.push(("leave", soul(1), l1));
    let l2 = b.act("activity:leave", Some(conv), &[]).expect("A1: the member leaves");
    steps.push(("leave", soul(2), l2));
    for (what, s, seq) in &steps {
        assert!(as_souls(&run, seq, *s), "A1: {what} {seq:?} is in the log as {s:?}'s");
    }
    println!(
        "A1: {} steps (offer, accept, six turns, two leaves), each in the log as its Soul's: {:?}",
        steps.len(),
        steps.iter().map(|(w, _, s)| (*w, s.clone())).collect::<Vec<_>>()
    );
    assert_eq!(run.members(conv), None, "A1: ended with its last member");

    // A3: the six turns are the conversation's audience, heard by its two members; the refused one is not there.
    let said = run.said();
    assert_eq!(said.len(), 6, "A3: six turns, nothing for the refused one");
    for (_, s) in &said {
        assert_eq!(s.audience, Audience::Of(conv), "A3: the members' audience");
        assert_eq!(s.hearers, [soul(1), soul(2)].into(), "A3: heard by the members");
    }
    // A4: a member reads every turn back; a public reader and a non-member are refused.
    let started = Instant::now();
    let read: Vec<String> = said
        .iter()
        .map(|(_, s)| String::from_utf8(run.text.read(s.words, &[soul(1), conv]).unwrap()).unwrap())
        .collect();
    let took = started.elapsed();
    assert_eq!(read, turns, "A4: the turns, in order");
    assert!(took < Duration::from_secs(2), "A4: under 2 s, took {took:?}");
    for (_, s) in &said {
        assert_eq!(run.text.read(s.words, &[]).unwrap_err().name, "not-entitled", "A3: no public reader");
        assert_eq!(run.text.read(s.words, &[soul(3)]).unwrap_err().name, "not-entitled", "A4: no non-member");
    }
    // A3: no word of a turn is in the log.
    let log = run.store.0.lock().unwrap().bytes.clone();
    for t in turns.iter().chain(["may I listen in"].iter()) {
        assert!(!log.windows(t.len()).any(|w| w == t.as_bytes()), "A3: {t:?} is not in the log");
    }
    println!("A4: a member read the six turns back in {took:?}; the public and a non-member were refused `not-entitled`");
    run.stop();
}

#[test]
fn a3_a_public_conversation_is_talk_at_its_reach() {
    let run = serve("a3");
    let (mut a, mut b) = (run.client(1, 0), run.client(2, 0));
    let conv = run.created(&offer(&mut a).expect("offered"));
    b.act("activity:accept", Some(conv), &[]).expect("accepted");
    a.say(None, "good morning, everyone").expect("a public turn");
    b.say(None, "morning").expect("a public turn");
    let said = run.said();
    assert_eq!(said.len(), 2);
    for (_, s) in &said {
        assert_eq!(s.audience, Audience::Everyone, "A3: public");
        assert_eq!(s.reach_mm, SAY_REACH_MM, "A3: at talk's reach");
        assert_eq!(
            run.text.read(s.words, &[soul(3)]).unwrap().is_empty(),
            false,
            "A3: anyone may read a public turn"
        );
    }
    println!("A3: a public conversation's two turns are public, reach {SAY_REACH_MM} mm, read by a non-member");
    run.stop();
}

#[test]
fn a2_a_decline_is_named_to_the_opener_and_nothing_is_said() {
    let run = serve("a2");
    let (mut a, mut b) = (run.client(1, 0), run.client(2, 0));
    let conv = run.created(&offer(&mut a).expect("offered"));
    let d = b.act("activity:decline", Some(conv), &[]).expect("A2: the decline lands");
    // The decline's entry: `souls:offer-declined`, naming the offer and the opener, addressed to the opener alone.
    let declined: Vec<(Id, BTreeSet<Id>)> = run
        .entries()
        .into_iter()
        .filter(|e| d.contains(&e.envelope.sequence))
        .flat_map(|e| e.events.into_iter().flatten())
        .filter(|ev| ev.name.as_str() == OFFER_DECLINED)
        .map(|ev| {
            let to = replica::activity::addressed(ev.name.as_str(), &ev.fields).unwrap();
            (read_id(&ev.fields[&1]).unwrap(), to)
        })
        .collect();
    assert_eq!(declined, vec![(conv, [soul(1)].into())], "A2: named to the opener alone");
    assert_eq!(run.members(conv), None, "A2: the declined conversation ended");
    let into = a.say(Some(conv), "are you there");
    assert!(into.is_err(), "A2: nothing is said into a declined conversation: {into:?}");
    assert!(run.said().is_empty(), "A2: no utterance in the log");
    println!("A2: the decline {d:?} is addressed to the opener; a turn into it was refused {into:?}");
    run.stop();
}

#[test]
fn a5_a_leave_is_accepted_and_a_restart_keeps_the_conversation() {
    let run = serve("a5");
    let (mut a, mut b) = (run.client(1, 0), run.client(2, 0));
    let conv = run.created(&offer(&mut a).expect("offered"));
    b.act("activity:accept", Some(conv), &[]).expect("accepted");
    a.say(Some(conv), "before the restart").expect("a turn");
    let (store, text) = run.stop();
    let run = serve_on("a5b", store, text);
    assert_eq!(
        run.members(conv),
        Some([soul(1), soul(2)].into()),
        "A5: after a restart the conversation and its members are there"
    );
    let (mut a, mut b) = (run.client(1, a.2), run.client(2, b.2));
    b.say(Some(conv), "after the restart").expect("A5: a member speaks after the restart");
    let l1 = a.act("activity:leave", Some(conv), &[]);
    let l2 = b.act("activity:leave", Some(conv), &[]);
    println!("A5: after a restart, leaves {l1:?} {l2:?}");
    l1.expect("A5: the opener's leave is accepted");
    l2.expect("A5: the member's leave is accepted");
    assert_eq!(run.members(conv), None, "A5: ended with its last member");
    run.stop();
}
