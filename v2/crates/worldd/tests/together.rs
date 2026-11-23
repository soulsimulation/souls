//! 0.134 T1 (#3891), touch by offer and accept on a served world: three scripted Souls on the world's end of the
//! gateway's socket, on N2's test world, Souls 1 and 2 standing 0.6 m apart. The handshake is an activity kind whose
//! two roles each name content's `handshake` move (B2's, `content/moves/handshake.json`).
//!
//! - An accepted handshake writes both members' moves for viewers (`souls:form-move`), each aimed at the other, with
//!   their contact times within 50 ms of each other; when the moves are done both leave.
//! - A declined offer, and one left to lapse, move nobody. An accept from 2.6 m away is refused `together.too-far`
//!   (nothing walks a member to its place yet) and leaves the offer open.
//!
//! - 0.134 T2: holding hands (content's `hold_hand`, its last phase held) lasts while both stay. One leaving releases
//!   both holds, each written again ended `released`; a walk sent by either leaves the activity the same way.
//!
//! A third Soul's aim at a member (`target-outside-activity`) has no verb of its own at the gateway; it is
//! `sim`'s `activity::tests::together`. `cargo test -p worldd --test together -- --nocapture`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;

use import_eden::Import;
use replica::activity::{ActivityKind, Role};
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource, Want};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, read_id,
    schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Intent, Target};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::Value as Json;
use replica::time::Micros;
use replica::tree::Rules as TreeRules;
use replica::world_model::{Audience, Kind};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::walk::town::Town;
use worldd::answers::{self, Config};
use worldd::bodies::Bodies;
use worldd::checkers::Rules;

const LINEAGE: Scope = Scope([0x71; 16]);
const PLACE: &str = "souls:place";
const WALKER: &str = "test:walker";
/// A handshake offered for a minute, and one that lapses in half a second.
const HANDSHAKE: &str = "test:handshake";
const BRIEF: &str = "test:brief_handshake";
/// Holding hands (0.134 T2): each role names content's `hold_hand`, whose last phase holds until released.
const HOLD: &str = "test:hold_hands";
/// Dancing together (0.134 T3).
const DANCE: &str = "test:dance";
const GIVER: &str = "test:giver";
const TAKER: &str = "test:taker";

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn pinned(plain: &str, n: u8) -> String {
    format!("{plain}@1220{}{n:02x}", "00".repeat(31))
}

/// The kinds in pinned order: (plain name, full name).
fn kinds() -> Vec<(&'static str, String)> {
    vec![
        (PLACE, pinned(PLACE, 1)),
        (WALKER, pinned(WALKER, 2)),
        (HANDSHAKE, pinned(HANDSHAKE, 3)),
        (BRIEF, pinned(BRIEF, 4)),
        (HOLD, pinned(HOLD, 5)),
        (DANCE, pinned(DANCE, 6)),
    ]
}

fn full(plain: &str) -> String {
    kinds().into_iter().find(|(p, _)| *p == plain).unwrap().1
}

/// A handshake's kind, as `serve::activity_kinds` reads an entry whose roles name the move: each role claims a hand
/// and names `souls:handshake`; its proposal lasts `lasts`.
fn handshake(plain: &str, lasts: Micros) -> ActivityKind {
    touch(plain, lasts, "souls:handshake")
}

/// A touch's kind whose two roles each claim a hand and name move `mv`.
fn touch(plain: &str, lasts: Micros, mv: &str) -> ActivityKind {
    let role = |r: &str| Role {
        name: name(r),
        place: name("souls:here"),
        claims: vec![Want::One(Class::Manipulator)],
        mv: Some(name(mv)),
    };
    ActivityKind {
        name: name(&full(plain)),
        revision: 1,
        roles: vec![role(GIVER), role(TAKER)],
        proposal_lasts: lasts,
        leave_within: 400_000,
        most: 2,
        beat: false,
    }
}

/// Dancing together (0.134 T3): content's `dance` on the world's beat, up to eight members.
fn dance() -> ActivityKind {
    ActivityKind {
        most: 8,
        beat: true,
        ..touch(DANCE, 60_000_000, "souls:dance")
    }
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
            r("souls:eyes", Class::Gaze, None),
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
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/t1-town/1").to_bytes()),
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
    Id::new(Scope([0x7f; 16]), n).unwrap()
}

/// Where the bodies stand on the test world's open ground, west of the square, µm: Souls 1 and 2 0.6 m apart, as a
/// handshake's roles place them, and Soul 3 2 m on; Soul 4 a dancer 1.5 m north of them.
fn at(n: u64) -> Vec3 {
    let x = match n {
        1 => -40_000_000,
        2 => -40_600_000,
        4 => -41_600_000,
        _ => -42_600_000,
    };
    Vec3::new(x, 0, if n == 4 { 28_500_000 } else { 30_000_000 })
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/t1-together/1").to_bytes()),
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

/// The world's rules (T2): the ground takes bodies and handshakes.
fn tree_rules() -> TreeRules {
    let k = |owner: &str, children: &[&str]| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: BTreeMap::new(),
        hands: None,
    };
    TreeRules {
        kinds: BTreeMap::from([
            (
                full(PLACE),
                k("place", &["body", HANDSHAKE, BRIEF, HOLD, DANCE]),
            ),
            (full(WALKER), k("family", &[])),
            (full(HANDSHAKE), k("activity", &[])),
            (full(BRIEF), k("activity", &[])),
            (full(HOLD), k("activity", &[])),
            (full(DANCE), k("activity", &[])),
        ]),
        souls: [soul(1), soul(2), soul(3), soul(4)].into(),
        audiences: BTreeMap::new(),
    }
}

/// The world as built: three walkers on the ground.
fn world() -> Replica {
    let g = ground();
    let h = header(g);
    let mut r = Replica::start(h.stored()).expect("a replica");
    let effects: Vec<Value> = (1..=4)
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
    let placed = (1..=4)
        .map(|n| town.surfaces[&ground].place(soul(n), frame, at(n), Quat::IDENTITY))
        .collect::<Result<Vec<_>, _>>()?;
    let mut b = Bodies::new(town, 50_000)?;
    for p in placed {
        b.add_body(humanoid(), p)?;
    }
    Ok(b)
}

/// A scripted Soul on the world's socket: its stream, its id and its last sequence.
struct Client(UnixStream, Id, u64);

impl Client {
    /// One intent and its one answer: a receipt's entries, or a refusal's reason.
    fn act(
        &mut self,
        verb: &str,
        target: Option<Id>,
        p: &[(u64, Value)],
    ) -> Result<Vec<u64>, String> {
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
            reflex: false,
        };
        let bytes = encode(&i.to_value()).unwrap();
        self.0
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        self.0.write_all(&bytes).unwrap();
        // A walk is answered `started` first (3), then by its receipt.
        let a = loop {
            let mut len = [0u8; 4];
            self.0.read_exact(&mut len).expect("an answer");
            let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
            self.0.read_exact(&mut frame).unwrap();
            let Value::Map(mut m) = decode(&frame).unwrap().value else {
                panic!("a frame")
            };
            let Some(Value::Map(a)) = m.remove(&2) else {
                panic!("an answer")
            };
            if a.get(&3) != Some(&Value::Uint(3)) {
                break a;
            }
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

    /// An offer of `kind` to Soul `to`, in the giver's role, under the ground.
    fn offer(&mut self, kind: &str, to: u64) -> Result<Vec<u64>, String> {
        self.act(
            "activity:offer",
            Some(ground()),
            &[
                (1, Value::Text(name(&full(kind)))),
                (2, Value::Text(name(GIVER))),
                (3, Value::Array(vec![soul(to).to_value()])),
            ],
        )
    }
}

/// A world serving on a socket, and its log.
struct Run {
    world: answers::World,
    store: Mem,
    path: std::path::PathBuf,
}

fn serve(tag: &str) -> Run {
    let store = Mem::with(Vec::new());
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| bodies()));
    cfg.engine = Some((
        tree_rules(),
        vec![
            handshake(HANDSHAKE, 60_000_000),
            handshake(BRIEF, 500_000),
            touch(HOLD, 60_000_000, "souls:hold_hand"),
            dance(),
        ],
    ));
    let rules = Rules {
        kinds: Json::Obj(Vec::new()),
        moves: Json::Obj(Vec::new()),
    };
    let world = answers::start(world(), rules, store.clone(), cfg).expect("the world starts");
    let path = std::env::temp_dir().join(format!("t1-{tag}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, stream));
        }
    });
    Run { world, store, path }
}

impl Run {
    fn client(&self, n: u64) -> Client {
        let s = UnixStream::connect(&self.path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        Client(s, soul(n), 0)
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

    /// The activity node the entries numbered `seq` created.
    fn created(&self, seq: &[u64]) -> Id {
        for e in self.entries() {
            if !seq.contains(&e.envelope.sequence) {
                continue;
            }
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    if let Change::Create { node, kind, .. } = &c.change
                        && [HANDSHAKE, BRIEF, HOLD, DANCE]
                            .iter()
                            .any(|k| kind.as_str() == full(k))
                    {
                        return *node;
                    }
                }
            }
        }
        panic!("no handshake created in {seq:?}")
    }

    /// Each move written for viewers (`souls:form-move`): its body, the move, its target and its contact time.
    fn touches(&self) -> Vec<(Id, String, Id, Micros)> {
        let text = |v: Option<&Value>| match v {
            Some(Value::Bytes(b)) => String::from_utf8(b.clone()).unwrap(),
            other => panic!("a name as bytes: {other:?}"),
        };
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| ev.name.as_str() == "souls:form-move")
            .map(|ev| {
                let Value::Map(r) = &ev.fields[&3] else {
                    panic!("a move record")
                };
                let Some(Value::Array(ends)) = r.get(&8) else {
                    panic!("its phase ends")
                };
                let Value::Uint(contact) = ends[0] else {
                    panic!("a contact time")
                };
                (
                    read_id(&ev.fields[&2]).unwrap(),
                    text(r.get(&2)),
                    read_id(&r[&5]).unwrap(),
                    contact as Micros,
                )
            })
            .collect()
    }

    /// Each move written for viewers that has ended, by body: how it ended (`released`).
    fn ended(&self) -> Vec<(Id, String)> {
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| ev.name.as_str() == "souls:form-move")
            .filter_map(|ev| {
                let Value::Map(r) = &ev.fields[&3] else {
                    panic!("a move record")
                };
                let Some(Value::Map(e)) = r.get(&9) else {
                    return None;
                };
                let Some(Value::Bytes(how)) = e.get(&2) else {
                    panic!("how it ended")
                };
                Some((
                    read_id(&ev.fields[&2]).unwrap(),
                    String::from_utf8(how.clone()).unwrap(),
                ))
            })
            .collect()
    }

    /// Each dance move written for viewers in `activity`, in order: its body and the start in its record.
    fn starts(&self, activity: Id) -> Vec<(Id, Micros)> {
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| {
                ev.name.as_str() == "souls:form-move"
                    && read_id(&ev.fields[&1]).ok() == Some(activity)
            })
            .map(|ev| {
                let Value::Map(r) = &ev.fields[&3] else {
                    panic!("a move record")
                };
                let Some(Value::Uint(start)) = r.get(&7) else {
                    panic!("a start after the world began")
                };
                (read_id(&ev.fields[&2]).unwrap(), *start as Micros)
            })
            .collect()
    }

    /// The world time of the effect numbered `seq`.
    fn at_seq(&self, seq: u64) -> Micros {
        self.entries()
            .into_iter()
            .find(|e| e.envelope.sequence == seq)
            .map(|e| e.envelope.at)
            .expect("that entry")
    }

    /// How many `souls:activity-left` events the log holds.
    fn lefts(&self) -> usize {
        self.entries()
            .into_iter()
            .flat_map(|e| e.events.into_iter().flatten())
            .filter(|ev| ev.name.as_str() == "souls:activity-left")
            .count()
    }

    fn stop(self) {
        self.world.stop();
        let _ = std::fs::remove_file(&self.path);
    }
}

#[test]
fn t1_an_accepted_handshake_writes_both_moves_touching_together() {
    let run = serve("accept");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let offer = run.created(&a.offer(HANDSHAKE, 2).expect("offered"));
    assert!(run.touches().is_empty(), "an offer alone moves nobody");
    let accepted = b
        .act("activity:accept", Some(offer), &[])
        .expect("accepted");
    let touches = run.touches();
    println!("t1: accept {accepted:?}; {} moves written", touches.len());
    let aimed: BTreeSet<(Id, Id)> = touches.iter().map(|t| (t.0, t.2)).collect();
    assert_eq!(
        aimed,
        BTreeSet::from([(soul(1), soul(2)), (soul(2), soul(1))]),
        "each member's move is aimed at the other"
    );
    assert!(touches.iter().all(|t| t.1 == "souls:handshake"));
    let (c1, c2) = (touches[0].3, touches[1].3);
    assert!(
        (c1 - c2).abs() <= 50_000,
        "contacts within 50 ms: {c1} and {c2} µs"
    );
    // The moves take 2.3 s; then both leave.
    std::thread::sleep(Duration::from_millis(2_600));
    a.act("activity:leave", Some(offer), &[])
        .expect("Soul 1 leaves");
    b.act("activity:leave", Some(offer), &[])
        .expect("Soul 2 leaves");
    println!("t1: contacts at {c1} and {c2} µs; both left");
    run.stop();
}

#[test]
fn t1_a_declined_or_lapsed_handshake_moves_nobody() {
    let run = serve("decline");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let declined = run.created(&a.offer(HANDSHAKE, 2).expect("offered"));
    b.act("activity:decline", Some(declined), &[])
        .expect("declined");
    let lapsing = run.created(&a.offer(BRIEF, 2).expect("offered"));
    std::thread::sleep(Duration::from_millis(1_000));
    let late = b.act("activity:accept", Some(lapsing), &[]);
    assert!(late.is_err(), "a lapsed offer is not accepted: {late:?}");
    // Soul 3 stands 2.6 m off: nothing walks it to its place, so its accept is refused by name and the offer stays.
    let mut c = run.client(3);
    let far = run.created(&a.offer(HANDSHAKE, 3).expect("offered"));
    let refused = c.act("activity:accept", Some(far), &[]);
    assert!(
        refused
            .as_ref()
            .is_err_and(|r| r.contains("together.too-far")),
        "too far to touch: {refused:?}"
    );
    c.act("activity:decline", Some(far), &[])
        .expect("the offer stayed open");
    assert!(run.touches().is_empty(), "nobody moved");
    println!(
        "t1: declined; lapsed (a late accept refused {late:?}); too far ({refused:?}): no move written"
    );
    run.stop();
}

/// 0.134 T2: two Souls hold hands, standing, for as long as both stay. One leaving frees both hands; so does a walk
/// sent by either, which leaves the activity as `activity:leave` does.
#[test]
fn t2_holding_hands_lasts_until_either_leaves_or_walks() {
    let run = serve("hold");
    let (mut a, mut b) = (run.client(1), run.client(2));
    let both = BTreeSet::from([(soul(1), soul(2)), (soul(2), soul(1))]);
    let released = |run: &Run| -> BTreeSet<Id> {
        run.ended()
            .into_iter()
            .filter(|(_, how)| how == "released")
            .map(|(b, _)| b)
            .collect()
    };

    // Held, then Soul 2 leaves: both hands come free at once.
    let held = run.created(&a.offer(HOLD, 2).expect("offered"));
    b.act("activity:accept", Some(held), &[]).expect("accepted");
    let aimed: BTreeSet<(Id, Id)> = run.touches().iter().map(|t| (t.0, t.2)).collect();
    assert_eq!(aimed, both, "each member holds the other's hand");
    assert!(run.touches().iter().all(|t| t.1 == "souls:hold_hand"));
    // Well past the reach (0.6 s): still held, nothing ended.
    std::thread::sleep(Duration::from_millis(1_500));
    assert!(run.ended().is_empty(), "held while both stay");
    b.act("activity:leave", Some(held), &[])
        .expect("Soul 2 leaves");
    assert_eq!(
        released(&run),
        BTreeSet::from([soul(1), soul(2)]),
        "a leave frees both hands"
    );
    a.act("activity:leave", Some(held), &[])
        .expect("Soul 1 leaves too");
    let after_leave = run.ended().len();

    // Held again, then Soul 1 walks 2 m off: its walk leaves the activity, and both hands come free.
    let again = run.created(&a.offer(HOLD, 2).expect("offered again"));
    b.act("activity:accept", Some(again), &[])
        .expect("accepted again");
    std::thread::sleep(Duration::from_millis(1_000));
    let lefts = run.lefts();
    let to = Value::Array(vec![
        Value::Nint(39_999_999),
        Value::Uint(0),
        Value::Uint(32_000_000),
    ]);
    a.act("eden:walk", Some(ground()), &[(1, to)])
        .expect("Soul 1 walks off");
    let walked: Vec<(Id, String)> = run.ended().split_off(after_leave);
    assert_eq!(
        walked.iter().map(|(b, _)| *b).collect::<BTreeSet<_>>(),
        BTreeSet::from([soul(1), soul(2)]),
        "a walk frees both hands: {walked:?}"
    );
    assert!(walked.iter().all(|(_, how)| how == "released"));
    assert_eq!(
        run.lefts(),
        lefts + 1,
        "the walk left the activity as a leave does"
    );
    b.act("activity:leave", Some(again), &[])
        .expect("Soul 2 leaves");
    println!(
        "t2: held 1.5 s; a leave freed both hands; held again, a walk freed both ({} released)",
        walked.len()
    );
    run.stop();
}

/// 0.134 T3: four scripted Souls dance together. Soul 1 offers the dance to Souls 2, 3 and 4 at once, and their
/// accepts arrive up to 500 ms apart. In each of 20 runs, every member's first dance move starts on the same beat of
/// the world's clock (120 a minute from 0: a whole multiple of 500 ms), at most 2 s after the first accept. In the
/// first run the dance goes on: each member's next move starts on the next whole beat after the first ends. Every
/// leave is accepted.
#[test]
fn t3_four_souls_dance_on_one_beat_in_20_runs() {
    let run = serve("dance");
    let mut c: Vec<Client> = (1..=4).map(|n| run.client(n)).collect();
    let beat = replica::time::Tempo::per_minute(0, 0, 120).unwrap();
    let line = replica::time::Timeline::start(
        replica::time::Mapping::new(0, 0, 1, 1).unwrap(),
        replica::time::TickRate::new(0, 0, 20).unwrap(),
        beat,
    )
    .unwrap();
    let on_beat = |t: Micros| line.beat_of(t).and_then(|k| line.beat_time(k)) == Ok(t);
    let mut spreads = Vec::new();
    for r in 0..20u64 {
        let asked = Value::Array((2..=4).map(|n| soul(n).to_value()).collect());
        let offered = c[0]
            .act(
                "activity:offer",
                Some(ground()),
                &[
                    (1, Value::Text(name(&full(DANCE)))),
                    (2, Value::Text(name(GIVER))),
                    (3, asked),
                ],
            )
            .expect("offered to three");
        let dance = run.created(&offered);
        // Three accepts, each 0 to 249 ms after the one before: at most 500 ms from first to last.
        let gaps = [0, (r * 37) % 250, (r * 91 + 40) % 250];
        let mut first = None;
        for (k, gap) in gaps.iter().enumerate() {
            std::thread::sleep(Duration::from_millis(*gap));
            let e = c[k + 1]
                .act("activity:accept", Some(dance), &[])
                .unwrap_or_else(|x| panic!("run {r}: Soul {} accepts: {x}", k + 2));
            first.get_or_insert(run.at_seq(e[0]));
        }
        let first = first.unwrap();
        let starts = run.starts(dance);
        let members: BTreeSet<Id> = starts.iter().map(|s| s.0).collect();
        assert_eq!(
            members,
            (1..=4).map(soul).collect(),
            "run {r}: all four dance"
        );
        let s0 = starts[0].1;
        assert!(
            starts.iter().all(|s| s.1 == s0),
            "run {r}: one beat for all: {starts:?}"
        );
        assert!(on_beat(s0), "run {r}: {s0} µs is a whole beat");
        assert!(
            s0 > first && s0 - first <= 2_000_000,
            "run {r}: the beat is {} µs after the first accept",
            s0 - first
        );
        spreads.push(gaps.iter().sum::<u64>());
        if r == 0 {
            // Beat after beat: the dance (0.8 s) ends, and each member's next begins on the next whole beat.
            let wait = s0 - answers::now() + 1_300_000;
            std::thread::sleep(Duration::from_micros(u64::try_from(wait).unwrap_or(0)));
            let again: Vec<(Id, Micros)> = run.starts(dance).split_off(4);
            assert_eq!(
                again.iter().map(|s| s.0).collect::<BTreeSet<_>>(),
                members,
                "each member dances again: {again:?}"
            );
            assert!(
                again.iter().all(|s| s.1 == s0 + 1_000_000),
                "the next whole beat after the first dance: {again:?}"
            );
        }
        for (k, cl) in c.iter_mut().enumerate() {
            cl.act("activity:leave", Some(dance), &[])
                .unwrap_or_else(|x| panic!("run {r}: Soul {} leaves: {x}", k + 1));
        }
        // Let the leaves end the moves in progress (at most the kind's 400 ms).
        std::thread::sleep(Duration::from_millis(600));
    }
    println!(
        "t3: 20 runs, four Souls on one beat each; accepts spread over {spreads:?} ms; leaves accepted"
    );
    run.stop();
}
