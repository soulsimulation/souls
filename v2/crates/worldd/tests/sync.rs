//! An agent's sync never runs on the clock thread (Engine v2 C16, #3450). A world of 30,000 items (C11's Eden-sized
//! scope) answers a whole sync, then a change and a second sync, while it ticks at its own rate:
//!
//! - in the library (`answers::start`, the path `worldd gateway-link` and `worldd serve` share), no tick ends more
//!   than 50 ms after it was due while a sync runs, in a release build (A2), read off K7's heartbeat; a debug build is
//!   held to K7's default watchdog (500 ms with no tick), past which the process is ended;
//! - through `worldd gateway-link`'s socket with the default watchdog, the process is still running after it.
//!
//! `C16_REPORT=1` prints the numbers, for the PR.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::time::Duration;

use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use replica::sync::{self, Copy, Synced, wire};
use sim::log::Mem;
use worldd::answers::{self, Config, World};
use worldd::checkers::toggles;

const LINEAGE: Scope = Scope([0x16; 16]);
const ITEMS: usize = 30_000;
/// K7's default watchdog, ms (`worldd`'s `watchdog::LIMIT_MS`).
const WATCHDOG_MS: i64 = 500;
/// The tick's length, µs (`Config::new`'s).
const TICK_US: i64 = 50_000;

/// A whole sync by frames alone (R5b): the place's hash, then every record it reaches, 64 to a request.
fn sync_by(
    ask: &mut dyn FnMut(BTreeMap<u64, Value>) -> BTreeMap<u64, Value>,
    copy: &mut Copy,
) -> Synced {
    let a = ask(BTreeMap::from([
        (wire::ASK, Value::Uint(1)),
        (wire::IDS, Value::Array(vec![])),
    ]));
    let (ids, hashes) = sync::read_hashes(&a).expect("hashes");
    let mut d = copy.compare(&ids, hashes);
    loop {
        let asked = copy.ask(&mut d, wire::RECORDS_MOST);
        if asked.is_empty() {
            return copy.finish(d).expect("the sync finishes");
        }
        let hs = asked.iter().cloned().map(Value::Bytes).collect();
        let a = ask(BTreeMap::from([
            (wire::ASK, Value::Uint(2)),
            (wire::RECORDS, Value::Array(hs)),
        ]));
        copy.take(&mut d, &asked, sync::read_records(&a).expect("records"))
            .expect("the records match their hashes");
    }
}

fn map(frame: &[u8]) -> BTreeMap<u64, Value> {
    match decode(frame).expect("a frame").value {
        Value::Map(m) => m,
        _ => panic!("a map"),
    }
}

/// Body `body` switches `thing`: a change to the world, so the next sync's hashes are sealed again.
fn toggle(body: Id, thing: Id) -> Vec<u8> {
    let n = |s: &str| Name::new(s).unwrap();
    let i = Intent {
        actor: Actor::Soul(body),
        verb: n("r2:switch_on"),
        target: Some(Target::Node(thing)),
        parameters: BTreeMap::new(),
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
    };
    encode(&i.to_value()).unwrap()
}

/// Reads K7's heartbeat every millisecond while `f` runs: `f`'s result, the longest time with no tick ending (what
/// K7's watchdog reads), µs, and how many ticks ended.
fn sampled<T>(w: &World, f: impl FnOnce() -> T) -> (T, i64, i64) {
    let beat = Arc::clone(&w.beat);
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = Arc::clone(&stop);
    let sampler = std::thread::spawn(move || {
        let (mut gap, mut ticks) = (0, 0);
        let mut last = beat.read();
        while !stopped.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(1));
            let (tick, at) = beat.read();
            if tick != last.0 {
                gap = gap.max(at - last.1);
                ticks += tick - last.0;
                last = (tick, at);
            }
        }
        (gap, ticks)
    });
    let out = f();
    stop.store(true, Ordering::Relaxed);
    let (gap, ticks) = sampler.join().unwrap();
    (out, gap, ticks)
}

#[test]
fn c16_a2_a_30000_record_sync_never_delays_a_tick() {
    let built = toggles::World::build(1, 50, ITEMS);
    let (body, thing) = built.pairs[0];
    let w = answers::start(
        built.replica,
        toggles::rules(),
        Mem::default(),
        Config::new(LINEAGE, 1),
    )
    .expect("the world starts");
    // Past the start's catch-up: the ticks measured are the sync's.
    std::thread::sleep(Duration::from_millis(300));
    let door = w.door();
    let mut ask = |m: BTreeMap<u64, Value>| {
        let (reply, rx) = channel();
        assert!(door.arrive(encode(&Value::Map(m)).unwrap(), reply));
        map(&rx.recv_timeout(Duration::from_secs(60)).expect("an answer"))
    };
    let mut copy = Copy::default();
    let (first, gap1, ticks1) = sampled(&w, || sync_by(&mut ask, &mut copy));
    assert!(first.held > ITEMS, "held {} records", first.held);
    // A change, so the second sync's hashes are sealed again, on the sync thread. The tick that commits it is not
    // measured: its time is the change's, not the sync's (K18's state hash, the PR's known limits).
    let (reply, rx) = channel();
    assert!(w.door().arrive(toggle(body, thing), reply));
    rx.recv_timeout(Duration::from_secs(60)).expect("a receipt");
    std::thread::sleep(Duration::from_millis(200));
    let (again, gap2, ticks2) = sampled(&w, || sync_by(&mut ask, &mut copy));
    assert_eq!(again.changed, 1, "the change is seen");
    w.stop();
    // A tick held more than 50 ms past when it was due leaves a gap over one tick and 50 ms. A debug build is held to
    // K7's default watchdog.
    let bar = if cfg!(debug_assertions) {
        WATCHDOG_MS * 1000
    } else {
        TICK_US + 50_000
    };
    let (gap, ticks) = (gap1.max(gap2), ticks1 + ticks2);
    if std::env::var_os("C16_REPORT").is_some() {
        println!(
            "C16 A2 library: release {}, {ITEMS} items, records held {}, fetched {} then {} (sealed again off the \
             clock), {ticks} ticks during the syncs, longest time with no tick ending {gap} us (first sync {gap1}, \
             second {gap2}), bar {bar} us",
            !cfg!(debug_assertions),
            first.held,
            first.fetched,
            again.fetched,
        );
    }
    assert!(
        ticks1 > 0 && ticks2 > 0,
        "the world ticked during the syncs"
    );
    assert!(gap <= bar, "no tick ended for {gap} us (bar {bar} us)");
    assert_eq!(sim::commit::checks_on_clock(), 0, "no answer on the clock");
}

/// A1: the clock thread answers no sync. Held on purpose (O4's stuck-thread event), it ends no tick while a whole
/// sync, a change's included, is answered; on the clock thread the answers would wait for it.
#[test]
fn c16_a1_a_sync_is_answered_while_the_clock_thread_is_held() {
    let built = toggles::World::build(1, 4, 0);
    let (body, thing) = built.pairs[0];
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(10);
    let w = answers::start(built.replica, toggles::rules(), Mem::default(), cfg)
        .expect("the world starts");
    let door = w.door();
    let mut ask = |m: BTreeMap<u64, Value>| {
        let (reply, rx) = channel();
        assert!(door.arrive(encode(&Value::Map(m)).unwrap(), reply));
        map(&rx.recv_timeout(Duration::from_secs(60)).expect("an answer"))
    };
    let mut copy = Copy::default();
    sync_by(&mut ask, &mut copy);
    let (reply, rx) = channel();
    assert!(w.door().arrive(toggle(body, thing), reply));
    rx.recv_timeout(Duration::from_secs(60)).expect("a receipt");
    w.events
        .send(answers::Event::Stall(Duration::from_secs(3)))
        .unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let held = w.beat.read().0;
    let s = sync_by(&mut ask, &mut copy);
    assert_eq!((s.changed, s.fetched), (1, 3), "the change, synced");
    assert_eq!(w.beat.read().0, held, "the clock was held throughout");
    w.stop();
}

/// I1's framing: a 4-byte big-endian length, then the bytes.
fn frame(s: &mut UnixStream, m: BTreeMap<u64, Value>) -> BTreeMap<u64, Value> {
    let bytes = encode(&Value::Map(m)).unwrap();
    s.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();
    s.write_all(&bytes).unwrap();
    let mut len = [0u8; 4];
    s.read_exact(&mut len).unwrap();
    let mut out = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut out).unwrap();
    map(&out)
}

struct Killed(Child);

impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn c16_a2_gateway_link_answers_a_30000_record_sync_under_the_default_watchdog() {
    let dir = std::env::temp_dir().join(format!("worldd-c16-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("w.sock");
    let child = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["gateway-link", "--socket"])
        .arg(&socket)
        .args(["--lineage", &to_hex(&LINEAGE.0), "--epoch", "1"])
        .args([
            "--rooms",
            "1",
            "--bodies",
            "50",
            "--items",
            &ITEMS.to_string(),
        ])
        .arg("--no-measures")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("worldd runs");
    let mut child = Killed(child);
    let mut s = (0..3000)
        .find_map(|_| {
            std::thread::sleep(Duration::from_millis(20));
            UnixStream::connect(&socket).ok()
        })
        .expect("the world's socket");
    s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let mut copy = Copy::default();
    let synced = sync_by(&mut |m| frame(&mut s, m), &mut copy);
    assert!(synced.held > ITEMS, "held {} records", synced.held);
    // Two of K7's limits more: a tick the sync held would have ended the process by now.
    std::thread::sleep(Duration::from_millis(2 * WATCHDOG_MS as u64));
    let status = child.0.try_wait().unwrap();
    assert!(status.is_none(), "worldd ended: {status:?}");
    if std::env::var_os("C16_REPORT").is_some() {
        println!(
            "C16 A2 gateway-link: release {}, records held {}, rounds {}, default watchdog, still running",
            !cfg!(debug_assertions),
            synced.held,
            synced.rounds
        );
    }
    drop(child);
    let _ = std::fs::remove_dir_all(&dir);
}
