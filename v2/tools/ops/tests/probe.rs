//! O18c (#3524): a release's probe never drives anyone's Soul. A world with seeded Souls (I4's world, each Soul with a
//! toggle of its own) is served on a socket as `worldd serve` serves one; the canary watches it with the release's
//! probe and the world is restarted mid-window.
// A canary's window is wall-clock time (the wall-clock rule, K7, is the engine's).
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use replica::effects::{Actor, read_id};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use replica::sync::wire;
use sim::log::{FileStore, recover};
use supervisor::deploy::{ANSWERED, Canary, Probe, now_us, watch};
use worldd::answers::{self, Config, World};
use worldd::checkers::toggles;

const LINEAGE: Scope = Scope([0x18; 16]);
const SOULS: usize = 3;

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("o18c-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The world on its log in `d`, served on `d/gateway.sock` (a start, or a restart from the same log).
fn serve(d: &Path) -> (World, Vec<(Id, Id)>) {
    let built = toggles::World::build(1, SOULS, 0);
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(10);
    let store = FileStore::open(&d.join("log")).unwrap();
    let world = answers::start(built.replica, toggles::rules(), store, cfg).unwrap();
    let sock = d.join("gateway.sock");
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, s));
        }
    });
    (world, built.pairs)
}

/// The world's version and its root's hash, by one sync ask of the test's own.
fn root(d: &Path) -> (Value, Value) {
    let mut s = UnixStream::connect(d.join("gateway.sock")).unwrap();
    let ask = encode(&Value::Map(BTreeMap::from([
        (wire::ASK, Value::Uint(1)),
        (wire::IDS, Value::Array(Vec::new())),
    ])))
    .unwrap();
    s.write_all(&(ask.len() as u32).to_be_bytes()).unwrap();
    s.write_all(&ask).unwrap();
    let mut len = [0u8; 4];
    s.read_exact(&mut len).unwrap();
    let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut frame).unwrap();
    let Value::Map(m) = decode(&frame).unwrap().value else {
        panic!("a sync answer")
    };
    (m[&1].clone(), m[&wire::IDS].clone())
}

/// The Souls whose intents the world's log answered.
fn answered_souls(d: &Path) -> BTreeSet<Id> {
    let bytes = std::fs::read(d.join("log")).unwrap();
    let mut souls = BTreeSet::new();
    for r in recover(&bytes).unwrap().records {
        let Ok(Value::Map(part)) = decode(&r).map(|d| d.value) else {
            continue;
        };
        let Some(Value::Array(rows)) = part.get(&ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(row) = row else { continue };
            // The actor's encoded bytes: `{1: kind, 2: id}`.
            let Some(Value::Map(actor)) = (match row.get(&1) {
                Some(Value::Bytes(b)) => decode(b).ok().map(|d| d.value),
                _ => None,
            }) else {
                continue;
            };
            if let Some(id) = actor.get(&2).and_then(|v| read_id(v).ok()) {
                souls.insert(id);
            }
        }
    }
    souls
}

fn canary(window_ms: u64) -> Canary {
    Canary {
        window: Duration::from_millis(window_ms),
        start_within: Duration::from_secs(10),
        answer_within: Duration::from_secs(5),
        every: Duration::from_millis(50),
    }
}

/// A1, A2: the release's probe, through a restart mid-window, leaves the world as it was: no Soul's intent answered,
/// the same version and the same root hash, so no body was added and none moved.
#[test]
fn a1_a2_the_release_probe_drives_no_soul_and_leaves_no_body() {
    let d = dir("ask");
    let (world, _) = serve(&d);
    let before = root(&d);
    let sock = d.join("gateway.sock");
    let watching =
        std::thread::spawn(move || watch(&sock, &canary(2_000), &mut Probe::Ask(0), false));
    std::thread::sleep(Duration::from_millis(700));
    world.stop();
    let (world, _) = serve(&d);
    assert_eq!(
        watching.join().unwrap(),
        Ok(()),
        "the probe is answered across the restart"
    );
    let after = root(&d);
    world.stop();
    assert_eq!(
        answered_souls(&d),
        BTreeSet::new(),
        "no Soul's intent in the log"
    );
    assert_eq!(
        before, after,
        "the world's version and root hash are as they were"
    );
}

/// The control: an act probe of a Soul is in the same log, by that Soul, and moves the world on, so the checks above
/// would catch a probe that drove anyone.
#[test]
fn a1_control_an_act_probe_is_seen() {
    let d = dir("act");
    let (world, pairs) = serve(&d);
    let before = root(&d);
    let (soul, thing) = pairs[0];
    let n = |s: &str| Name::new(s).unwrap();
    let act = Intent {
        actor: Actor::Soul(soul),
        verb: n("r2:switch_on"),
        target: Some(Target::Node(thing)),
        parameters: BTreeMap::new(),
        sequence: 0,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: now_us() + 5_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    };
    let r = watch(
        &d.join("gateway.sock"),
        &canary(200),
        &mut Probe::Act(act),
        true,
    );
    let after = root(&d);
    world.stop();
    assert_eq!(r, Ok(()));
    assert_eq!(answered_souls(&d), BTreeSet::from([soul]));
    assert_ne!(before, after, "the act changed the world");
}
