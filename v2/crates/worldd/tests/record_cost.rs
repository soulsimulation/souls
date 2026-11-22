//! The tick's record phase with many walking Souls on a served Eden (#1960, follow-up of #4018): `worldd seed` from
//! Eden's facts with its entries, `worldd serve`, and `SOULS` Souls (default 20) joined on the world's socket, each
//! walking from point to point on the open ground for `SECS` seconds (default 60) of the real clock. Prints the tick's
//! and the record phase's mean, p99 and max from `health.json` over the window (the mean exactly, from two readings;
//! p99 and max since the world started, idle start-up ticks included).
//!
//! Needs the generated Eden 2026 facts file (`EDEN_FACTS`, as `tests/eden.rs`) and a release build. From `v2/`:
//! `SOULS=50 cargo test -p worldd --release --test record_cost -- --ignored --nocapture`.

// Measures the real clock's tick: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use replica::pose::Vec3;
use worldd::answers::{self, JOIN};

struct Served(Child);

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// One Soul on the world's socket: its stream, id, last sequence and lineage.
struct Client(UnixStream, Id, u64, Scope);

impl Client {
    fn act(&mut self, verb: &str, target: Option<Id>, parameters: BTreeMap<u64, Value>) -> bool {
        self.2 += 1;
        let i = Intent {
            actor: Actor::Soul(self.1),
            verb: Name::new(verb).unwrap(),
            target: target.map(Target::Node),
            parameters,
            sequence: self.2,
            basis: Version {
                lineage: self.3,
                zone: Id::new(self.3, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: answers::now() + 120_000_000,
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
        loop {
            let mut len = [0u8; 4];
            if self.0.read_exact(&mut len).is_err() {
                return false;
            }
            let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
            self.0.read_exact(&mut frame).unwrap();
            let Value::Map(mut m) = decode(&frame).unwrap().value else {
                panic!("a frame")
            };
            let Some(Value::Map(a)) = m.remove(&2) else {
                panic!("an answer")
            };
            match (a.get(&3), a.get(&answers::LEFT)) {
                (Some(Value::Uint(3)), Some(Value::Uint(_))) => {}
                (Some(Value::Uint(1)), _) => return true,
                _ => return false,
            }
        }
    }
}

/// `"<key>":<n>` after `from` in `text`.
fn number(text: &str, from: &str, key: &str) -> u64 {
    let at = text.find(from).expect("the section");
    let rest = &text[at..];
    let k = rest.find(&format!("\"{key}\":")).expect("the key") + key.len() + 3;
    rest[k..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap()
}

/// `(count, mean µs, p99 µs, max µs)` of the histogram that starts at `from` in a health file.
fn hist(text: &str, from: &str) -> (u64, u64, u64, u64) {
    (
        number(text, from, "count"),
        number(text, from, "mean_us"),
        number(text, from, "p99_us"),
        number(text, from, "max_us"),
    )
}

fn health(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("health.json")).unwrap_or_default()
}

#[test]
#[ignore = "needs the generated Eden 2026 facts file and a release worldd (see the module doc)"]
fn record_phase_with_many_walking_souls() {
    let souls: u64 = std::env::var("SOULS").map_or(20, |s| s.parse().unwrap());
    let secs: u64 = std::env::var("SECS").map_or(60, |s| s.parse().unwrap());
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let facts = std::env::var("EDEN_FACTS")
        .unwrap_or_else(|_| format!("{root}/.local/import-eden/eden-2026.facts.json"));
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (ground, lineage) = (im.nodes["ground"], im.nodes["world"].scope());
    // Points on a 6 m grid of the open ground 10 to 60 m from the births with a route to them.
    let header = import_eden::header(im.nodes["world"], &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let mut town = sim::walk::town::Town::new(
        im.tree,
        ground,
        sim::links::Doors::new(header, im.rules, next),
    )
    .expect("the town");
    let mm = |m: i64| m * 1_000_000;
    let from = town
        .map
        .spot(ground, Vec3::new(mm(74), 0, mm(-1)))
        .expect("the births");
    let points: Vec<(i64, i64)> = (-10i64..=10)
        .flat_map(|i| (-10i64..=10).map(move |j| (74 + i * 6, -1 + j * 6)))
        .filter(|(x, z)| {
            let d = (((x - 74).pow(2) + (z + 1).pow(2)) as f64).sqrt();
            (10.0..60.0).contains(&d)
                && town
                    .map
                    .spot(ground, Vec3::new(mm(*x), 0, mm(*z)))
                    .and_then(|to| town.map.route(&town.tree, from, to, sim::routes::ALL).ok())
                    .is_some()
        })
        .collect();
    println!("{} walk points", points.len());
    assert!(points.len() > 20);

    let dir = std::env::temp_dir().join(format!("record-cost-{souls}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let worldd = env!("CARGO_BIN_EXE_worldd");
    let seeded = Command::new(worldd)
        .args(["seed", "--facts", &facts, "--dir"])
        .arg(&dir)
        .args([
            "--entries",
            &format!("{root}/content/kinds"),
            "--souls",
            "0",
        ])
        .args(["--at", "74.0,-1.0"])
        .output()
        .unwrap();
    assert!(
        seeded.status.success(),
        "{}",
        String::from_utf8_lossy(&seeded.stderr)
    );
    let mut child = Command::new(worldd)
        .args(["serve", "--dir"])
        .arg(&dir)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let served = Served(child);
    let mut line = String::new();
    while out.read_line(&mut line).unwrap() > 0 && !line.contains("listening ") {
        line.clear();
    }
    std::thread::spawn(move || for _ in out.lines().map_while(Result::ok) {});

    let stop = Arc::new(AtomicBool::new(false));
    let (walks, joined) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let mut threads = Vec::new();
    for n in 1..=souls {
        let s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(150))).unwrap();
        let mut soul = Client(s, Id::new(Scope([0xc1; 16]), n).unwrap(), 0, lineage);
        assert!(soul.act(JOIN, None, BTreeMap::new()), "Soul {n} born");
        joined.fetch_add(1, Ordering::Relaxed);
        let (stop, walks, points) = (Arc::clone(&stop), Arc::clone(&walks), points.clone());
        threads.push(std::thread::spawn(move || {
            let mut k = (n as usize * 7) % points.len();
            while !stop.load(Ordering::Relaxed) {
                let (x, z) = points[k];
                let um = |m: i64| Value::Uint(u64::try_from(m.abs() * 1_000_000).unwrap());
                let v = |m: i64| {
                    if m < 0 {
                        Value::Nint(u64::try_from(-m * 1_000_000).unwrap() - 1)
                    } else {
                        um(m)
                    }
                };
                let to = Value::Array(vec![v(x), Value::Uint(0), v(z)]);
                soul.act("eden:walk", Some(ground), BTreeMap::from([(1, to)]));
                walks.fetch_add(1, Ordering::Relaxed);
                k = (k + 5) % points.len();
            }
        }));
    }
    // Every Soul walking: a few seconds settle, then the window.
    std::thread::sleep(Duration::from_secs(5));
    let a = health(&dir);
    let t0 = Instant::now();
    std::thread::sleep(Duration::from_secs(secs));
    let b = health(&dir);
    let took = t0.elapsed();
    stop.store(true, Ordering::Relaxed);
    let (tick_a, tick_b) = (hist(&a, "\"ticks\":"), hist(&b, "\"ticks\":"));
    let (rec_a, rec_b) = (hist(&a, "\"record\":{"), hist(&b, "\"record\":{"));
    let window_mean = |x: (u64, u64, u64, u64), y: (u64, u64, u64, u64)| {
        (y.0 * y.1 - x.0 * x.1) / (y.0 - x.0).max(1)
    };
    println!(
        "RESULT souls={souls} window_s={:.0} ticks={} walks={} | tick mean {} us (all-run p99 {} max {}) | record mean {} us (all-run p99 {} max {})",
        took.as_secs_f64(),
        tick_b.0 - tick_a.0,
        walks.load(Ordering::Relaxed),
        window_mean(tick_a, tick_b),
        tick_b.2,
        tick_b.3,
        window_mean(rec_a, rec_b),
        rec_b.2,
        rec_b.3,
    );
    println!("health: {b}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
}
