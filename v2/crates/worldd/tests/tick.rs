//! Engine v2 K18 (#3160): the world's tick, one loop that wires the parts. A test world (N2's ground) with three
//! walkers, a chair and a lamp beside each walker runs ten minutes of world time in lockstep; a walk, a sit and a
//! switch_on sent as intents land; the recorder's inputs fed back to a fresh world write the same log (A2). The log as
//! the disk held it mid-run, restarted, has the state hash of its last tick, the bodies included, and a repeat of an
//! acknowledged intent gets its kept answer (A3). A skill that panics is ended by K11's wrapper; the clock and the
//! other bodies go on (A4). The real clock paces the same loop (A1).

use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use import_eden::Import;
use replica::bodies::{Class, Family, Resource, SkillShape};
use replica::effects::{Actor, Header, Part, fixture_bytes, read_id, schema_hash};
use replica::encode::{Name, Value, decode, encode};
use replica::host::{Host, Progress, Skill};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Intent, Target};
use replica::moves::Place;
use replica::pose::{Frame, Quat, Vec3};
use sim::links::Doors;
use sim::log::{Mem, recover};
use sim::recorder;
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use worldd::answers::{self, Config, Event, Ran, STATE, World};
use worldd::bodies::{Bodies, Placed};
use worldd::checkers::toggles;

const LINEAGE: Scope = Scope([0x18; 16]);
const CHAIR: &str = include_str!("../../replica/fixtures/seats/chair.diag");
/// Ten minutes of 50 ms ticks.
const TEN_MINUTES: i64 = 12_000;

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn humanoid() -> Family {
    let r = |n: &str| Resource {
        name: name(n),
        class: Class::Locomotion,
        slot: None,
    };
    let hand = |n: &str, slot: u64| Resource {
        name: name(n),
        class: Class::Manipulator,
        slot: Some(slot),
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![
            r("souls:leg-left"),
            r("souls:leg-right"),
            hand("souls:hand-left", 1),
            hand("souls:hand-right", 2),
        ],
    }
}

fn town() -> (Town, Id) {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/k18-test/1").to_bytes()),
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

fn chair() -> Id {
    Id::new(Scope([7; 16]), 9_002).unwrap()
}

/// The lamps world: one room, three bodies, each with its lamp.
fn lamp_world() -> toggles::World {
    toggles::World::build(1, 3, 0)
}

fn pairs() -> Vec<(Id, Id)> {
    lamp_world().pairs
}

/// A skill that panics on its first step (A4's seeded fault).
struct Panics;

impl Skill for Panics {
    fn shape(&self) -> SkillShape {
        SkillShape {
            name: name("k18:panics"),
            claims: Vec::new(),
            blocks: Vec::new(),
            cancelled_by: Vec::new(),
        }
    }

    fn step(&mut self, _: &mut dyn Host) -> Progress {
        panic!("a seeded fault in a unit");
    }
}

/// The walkers stand west of the square, the chair 4 m east of the first; with `panic`, a fourth body runs a skill
/// that panics.
fn bodies(placed: &Placed, panic: bool) -> Result<Bodies, replica::effects::Refusal> {
    let (town, ground) = town();
    let frame = Frame {
        node: ground,
        slot: None,
    };
    // The switcher stands beside its lamp (the toggles world's second, 200 mm along x): its switch_on is the form
    // runner's (C2, #3366), whose press reaches from where the controller has the body.
    let starts = [
        Vec3::new(-40_000_000, 0, 30_000_000),
        Vec3::new(200_000, 0, 300_000),
        Vec3::new(-40_000_000, 0, 34_000_000),
    ];
    let mut placements = Vec::new();
    for ((body, _), at) in pairs().into_iter().zip(starts) {
        placements.push(town.surfaces[&ground].place(body, frame, at, Quat::IDENTITY)?);
    }
    let fourth = Id::new(Scope([7; 16]), 9_100).unwrap();
    let panicker = town.surfaces[&ground].place(
        fourth,
        frame,
        Vec3::new(-42_000_000, 0, 22_000_000),
        Quat::IDENTITY,
    )?;
    let mut b = Bodies::new(town, 50_000)?;
    for p in placements {
        b.add_body_at(humanoid(), p, placed)?;
    }
    if panic {
        b.runner.add(humanoid(), panicker, Box::new(Panics))?;
    }
    let place = Place::from_value(&decode(&fixture_bytes(CHAIR)?).unwrap().value)?;
    b.add_place(PlaceAt {
        thing: chair(),
        place,
        point: Vec3::new(-36_000_000, 450_000, 30_000_000),
        facing: Quat::IDENTITY,
        floor: ground,
    })?;
    Ok(b)
}

fn start(store: Mem, panic: bool) -> World {
    start_with(store, panic, None)
}

fn start_with(store: Mem, panic: bool, checkpoints: Option<std::path::PathBuf>) -> World {
    let w = lamp_world();
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.lockstep = true;
    cfg.checkpoints = checkpoints.map(|d| (d, 4_096));
    cfg.views = true;
    cfg.bodies = Some(Box::new(move |p: &Placed| bodies(p, panic)));
    answers::start(w.replica, toggles::rules(), store, cfg).expect("the world starts")
}

fn intent(body: Id, sequence: u64, verb: &str, target: Option<Id>, point: Option<Vec3>) -> Vec<u8> {
    let mut parameters = BTreeMap::new();
    if let Some(p) = point {
        let i = |n: i64| {
            u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
        };
        parameters.insert(1, Value::Array(vec![i(p.x), i(p.y), i(p.z)]));
    }
    let i = Intent {
        actor: Actor::Soul(body),
        verb: name(verb),
        target: target.map(Target::Node),
        parameters,
        sequence,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        // World time starts at 0 in lockstep: an expiry far ahead.
        expiry: 1_000_000_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    };
    encode(&i.to_value()).unwrap()
}

fn at(w: &World, tick: i64, bytes: Vec<u8>) -> Receiver<Vec<u8>> {
    let (reply, rx) = channel();
    w.events
        .send(Event::ArrivalAt { tick, bytes, reply })
        .unwrap();
    rx
}

fn run_to(w: &World, tick: i64) -> Ran {
    let (done, rx) = channel();
    w.events.send(Event::RunTo { tick, done }).unwrap();
    rx.recv().unwrap()
}

/// An answer: `Ok(entries)` for a receipt, `Err(reason)` for a refusal.
fn answer(rx: &Receiver<Vec<u8>>) -> Result<Vec<u64>, String> {
    let frame = rx.recv_timeout(Duration::from_secs(20)).expect("an answer");
    let Value::Map(m) = decode(&frame).unwrap().value else {
        panic!("a frame")
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        panic!("an answer")
    };
    match (a.get(&3), a.get(&4), a.get(&5)) {
        (Some(Value::Uint(1)), Some(_), Some(Value::Array(e))) => Ok(e
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

fn bytes(store: &Mem) -> Vec<u8> {
    store.0.lock().unwrap().bytes.clone()
}

/// The recorder's inputs as a script: each intent (its bytes as received, from the answers the log holds) at the
/// tick that took it.
fn script(log: &[u8]) -> Vec<(i64, Vec<u8>)> {
    let records = recover(log).unwrap().records;
    let mut sent: BTreeMap<Id, Vec<u8>> = BTreeMap::new();
    for r in records.iter().filter(|r| !recorder::is_input(r)) {
        let part = Part::read(r).unwrap();
        let Some(Value::Array(rows)) = part.rest.get(&answers::ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(m) = row else { continue };
            if let (Some(id), Some(i)) = (m.get(&3), m.get(&5)) {
                sent.insert(read_id(id).unwrap(), encode(i).unwrap());
            }
        }
    }
    let mut out = Vec::new();
    for (tick, inputs) in recorder::inputs(&records).unwrap() {
        for i in inputs {
            if let recorder::Input::Intent { id, .. } = i {
                out.push((tick as i64, sent[&id].clone()));
            }
        }
    }
    out
}

/// The state hash the log's last part holds.
fn last_state(log: &[u8]) -> Vec<u8> {
    recover(log)
        .unwrap()
        .records
        .iter()
        .filter(|r| !recorder::is_input(r))
        .filter_map(|r| match Part::read(r).unwrap().rest.get(&STATE) {
            Some(Value::Bytes(b)) => Some(b.clone()),
            _ => None,
        })
        .next_back()
        .expect("a part with a state")
}

/// A2 and A3 on one run: ten minutes, a walk, a switch_on and a sit; the log fed back; a kill mid-run.
#[test]
fn a2_a3_ten_minutes_replayed_and_a_kill_restarted() {
    let p = pairs();
    let (walker, switcher, stroller) = (p[0].0, p[1].0, p[2].0);
    let lamp = p[1].1;
    let store = Mem::with(Vec::new());
    let dir = std::env::temp_dir().join(format!("k18-ckpt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let w = start_with(store.clone(), false, Some(dir.clone()));
    let walk = at(&w, 2, intent(walker, 1, "eden:walk", Some(chair()), None));
    let switch = at(&w, 3, intent(switcher, 1, "r2:switch_on", Some(lamp), None));
    let ground_walk = {
        let (_, ground) = town();
        at(
            &w,
            4,
            intent(
                stroller,
                1,
                "eden:walk",
                Some(ground),
                Some(Vec3::new(-44_000_000, 0, 34_000_000)),
            ),
        )
    };
    let first = run_to(&w, 40);
    println!("tick 40: {first:?}");
    // The kill: the log as the disk held it, mid-walk.
    std::thread::sleep(Duration::from_millis(200));
    let killed = {
        let d = store.0.lock().unwrap();
        d.bytes[..d.durable].to_vec()
    };
    let sit = at(&w, 400, intent(walker, 2, "eden:sit", Some(chair()), None));
    let end = run_to(&w, TEN_MINUTES);
    let walked = answer(&walk).expect("the walk lands");
    let switched = answer(&switch).expect("the switch_on lands");
    let strolled = answer(&ground_walk).expect("the second walk lands");
    let sat = answer(&sit).expect("the sit lands");
    println!(
        "walk {walked:?}, switch_on {switched:?}, walk {strolled:?}, sit {sat:?}; end {end:?}"
    );
    assert_eq!(end.tick, TEN_MINUTES, "ten minutes of ticks ran");
    assert_eq!(end.faults, 0, "the auditor found nothing");
    let stats = w.tier.as_ref().map(|t| t.stats());
    w.stop();
    let log = bytes(&store);
    let tier = stats.expect("the view tier ran");
    println!("view tier: {} ticks, fault {:?}", tier.ticks, tier.fault);
    assert!(
        tier.ticks > 0 && tier.fault.is_none(),
        "the view tier read the synced ticks"
    );
    let ckpts = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("ckpt-"))
        .count();
    println!("K5: {ckpts} checkpoints kept, {} log bytes", log.len());
    assert!(ckpts > 0, "a checkpoint was taken by amount of log");
    let _ = std::fs::remove_dir_all(&dir);

    // A2: the recorder's inputs fed back to a fresh world, at the same ticks, write the same effects.
    let inputs = script(&log);
    assert_eq!(inputs.len(), 4, "four intents recorded");
    let again = Mem::with(Vec::new());
    let r = start(again.clone(), false);
    let answers: Vec<_> = inputs.iter().map(|(t, b)| at(&r, *t, b.clone())).collect();
    let replayed = run_to(&r, TEN_MINUTES);
    for a in &answers {
        answer(a).expect("the same answers");
    }
    r.stop();
    let (h1, h2) = (
        recorder::effect_hash(&recover(&log).unwrap().records),
        recorder::effect_hash(&recover(&bytes(&again)).unwrap().records),
    );
    println!("A2: effect hash {} and replayed {}", hex(&h1), hex(&h2));
    assert_eq!(h1, h2, "the replay writes the same effects");
    assert_eq!(replayed.state, end.state, "and ends in the same state");

    // A3: the killed log restarts with its last tick's state, bodies included; an acknowledged act is kept.
    let before = last_state(&killed);
    let disk = Mem::with(killed);
    let k = start(disk, false);
    let restarted = run_to(&k, 0);
    println!(
        "A3: last logged state {} restarted {} at tick {}",
        hex(&before),
        hex(&restarted.state),
        restarted.tick
    );
    assert_eq!(restarted.state.to_vec(), before, "the state hash matches");
    let again = at(
        &k,
        restarted.tick + 1,
        intent(switcher, 1, "r2:switch_on", Some(lamp), None),
    );
    let more = run_to(&k, restarted.tick + 5);
    assert_eq!(
        answer(&again),
        Ok(switched.clone()),
        "an acknowledged act survives the kill: a repeat gets its answer"
    );
    // The open walk at the kill was never answered; sent again, it is taken and lands.
    let rewalk = at(
        &k,
        more.tick + 1,
        intent(walker, 1, "eden:walk", Some(chair()), None),
    );
    run_to(&k, more.tick + 400);
    answer(&rewalk).expect("the walk open at the kill lands when sent again");
    k.stop();
}

/// K18c (#3176) A1 and A2: a world with checkpoints walks a body to the chair and sits it, then writes more; stopped
/// and started again on the same log and checkpoints, it starts from the newest checkpoint and reads only the log after
/// it, with the last logged state; the seated body is in its seat again, held: another's sit is refused `seat-taken`
/// and its own rise lands.
#[test]
fn k18c_a1_a2_restart_from_the_newest_checkpoint_seated_stays_seated() {
    let p = pairs();
    let (walker, switcher, stroller) = (p[0].0, p[1].0, p[2].0);
    let lamp = p[1].1;
    let store = Mem::with(Vec::new());
    let dir = std::env::temp_dir().join(format!("k18c-ckpt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let w = start_with(store.clone(), false, Some(dir.clone()));
    let walk = at(&w, 2, intent(walker, 1, "eden:walk", Some(chair()), None));
    let sit = at(&w, 400, intent(walker, 2, "eden:sit", Some(chair()), None));
    let switch = at(
        &w,
        700,
        intent(switcher, 1, "r2:switch_on", Some(lamp), None),
    );
    let end = run_to(&w, 800);
    let walked = answer(&walk).expect("the walk lands");
    answer(&sit).expect("the sit lands");
    answer(&switch).expect("the switch_on lands");
    assert_eq!(
        end.seated,
        vec![(walker, chair())],
        "seated before the stop"
    );
    w.stop();
    // More log after the newest checkpoint, wherever the log's sync let it fall: the same log run on with no
    // checkpoints taken (a full replay, the seat restored), a switch_off logged.
    let m = start(store.clone(), false);
    let r = run_to(&m, 0);
    assert_eq!(
        r.seated,
        vec![(walker, chair())],
        "seated after a full replay too"
    );
    let off = at(
        &m,
        r.tick + 1,
        intent(switcher, 2, "r2:switch_off", Some(lamp), None),
    );
    // The press takes 550 ms (C2: a form is carried out by the runner, its move included).
    run_to(&m, r.tick + 20);
    answer(&off).expect("the switch_off lands");
    m.stop();
    let log = bytes(&store);
    let total = recover(&log).unwrap().records.len() as u64;

    // A1: from the newest checkpoint, and the log after it only.
    let k = start_with(Mem::with(log.clone()), false, Some(dir.clone()));
    let restarted = run_to(&k, 0);
    println!(
        "A1: {total} log records; restart {:?}; last logged state {} restarted {} at tick {}",
        k.restart,
        hex(&last_state(&log)),
        hex(&restarted.state),
        restarted.tick
    );
    let from = k.restart.checkpoint.expect("started from a checkpoint");
    assert!(from > 0 && from <= total, "a checkpoint inside the log");
    assert_eq!(
        k.restart.read,
        total - from,
        "only the records after it are read"
    );
    assert!(
        k.restart.read > 0 && k.restart.read < total,
        "the log after it, not the whole log"
    );
    assert_eq!(
        restarted.state.to_vec(),
        last_state(&log),
        "the state hash matches, the bodies' poses included"
    );

    let again = at(
        &k,
        restarted.tick + 1,
        intent(walker, 1, "eden:walk", Some(chair()), None),
    );
    run_to(&k, restarted.tick + 1);
    assert_eq!(
        answer(&again),
        Ok(walked),
        "an answer from before the checkpoint is kept: a repeat gets it"
    );

    // A2: seated in the same seat, the seat held in the slots table.
    println!("A2: seated after the restart {:?}", restarted.seated);
    assert_eq!(
        restarted.seated,
        vec![(walker, chair())],
        "seated in the same seat"
    );
    let taken = at(
        &k,
        restarted.tick + 2,
        intent(stroller, 1, "eden:sit", Some(chair()), None),
    );
    let rise = at(
        &k,
        restarted.tick + 3,
        intent(walker, 3, "eden:rise", None, None),
    );
    let after = run_to(&k, restarted.tick + 200);
    let refused = answer(&taken);
    println!(
        "A2: another's sit {refused:?}; the rise {:?}",
        answer(&rise)
    );
    assert!(
        matches!(&refused, Err(r) if r == "place-taken"),
        "the seat is held: {refused:?}"
    );
    assert!(after.seated.is_empty(), "risen: {:?}", after.seated);
    k.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A4: a skill that panics is ended by K11's wrapper; the clock and the other bodies go on.
#[test]
fn a4_a_panic_in_a_unit_is_contained() {
    let p = pairs();
    let store = Mem::with(Vec::new());
    let w = start(store, true);
    let walk = at(&w, 2, intent(p[0].0, 1, "eden:walk", Some(chair()), None));
    let ran = run_to(&w, 400);
    println!("A4: {ran:?}");
    assert_eq!(ran.panicked, 1, "the panicking unit ended by name");
    assert_eq!(ran.tick, 400, "the clock went on");
    answer(&walk).expect("another body's walk lands");
    w.stop();
}

/// A1: the same loop paced by the machine's clock runs at its rate.
#[test]
fn a1_the_real_clock_paces_the_loop() {
    let w = lamp_world();
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.bodies = Some(Box::new(|p: &Placed| bodies(p, false)));
    let world = answers::start(w.replica, toggles::rules(), Mem::with(Vec::new()), cfg).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let (t0, _) = world.beat.read();
    std::thread::sleep(Duration::from_secs(2));
    let (t1, _) = world.beat.read();
    world.stop();
    println!("A1: {} ticks in 2 s", t1 - t0);
    assert!(
        (36..=44).contains(&(t1 - t0)),
        "about 40 ticks in 2 s, got {}",
        t1 - t0
    );
}

fn hex(b: &[u8]) -> String {
    b.iter().take(8).map(|x| format!("{x:02x}")).collect()
}
