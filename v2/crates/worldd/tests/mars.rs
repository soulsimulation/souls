//! W8 (#4084): a Soul that walks into Mimos walks out again, on the served Mars template. Mimos stands 240 mm into
//! the ground with its level-0 floor at the ground's height, a raised main room 530 mm above it, and one doorway to
//! the open ground. From each of its three rooms (both floors) a Soul walks out to the dojo and to the camp tracks,
//! and back in; the body's place comes from the world's log at each end.
//!
//! Needs the Mars template's facts file and a built `worldd`, from the repository root:
//! `node v2/tools/import-eden/export/export.ts --template worlds/templates/mars-two.json --map
//! content/worlds/mars/map.json --out .local/import-eden/mars-two.facts.json`, then from `v2/`
//! `cargo test --release -p worldd --test mars -- --ignored --nocapture` (`MARS_FACTS` names another file).

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use replica::pose::Vec3;
use worldd::answers::{self, JOIN};

/// Mimos, today's id on the Mars template.
const MIMOS: &str = "e_182880ef";
/// The dojo, 70 m east of Mimos.
const DOJO: &str = "e_3d8d921c";
/// The camp tracks, a named outdoor place.
const TRACKS: &str = "e_8ca89a2c.area";

/// The world's end of the gateway's socket, as one Soul.
struct Client(UnixStream, Id, u64, Scope);

impl Client {
    /// A walk to `target`: its receipt's entries, or the name it was refused by.
    fn walk(&mut self, target: Id) -> Result<Vec<u64>, String> {
        self.act("eden:walk", Some(target))
    }

    fn act(&mut self, verb: &str, target: Option<Id>) -> Result<Vec<u64>, String> {
        self.2 += 1;
        let i = Intent {
            actor: Actor::Soul(self.1),
            verb: Name::new(verb).unwrap(),
            target: target.map(Target::Node),
            parameters: BTreeMap::new(),
            sequence: self.2,
            basis: Version {
                lineage: self.3,
                zone: Id::new(self.3, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: answers::now() + 300_000_000,
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
        // A progress answer (kind 3 with the µs left) comes before the act's own answer: read past.
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
            if !matches!(
                (a.get(&3), a.get(&answers::LEFT)),
                (Some(Value::Uint(3)), Some(Value::Uint(_)))
            ) {
                break a;
            }
        };
        match (a.get(&3), a.get(&5), a.get(&4)) {
            (Some(Value::Uint(1)), Some(Value::Array(e)), _) => Ok(e
                .iter()
                .map(|v| if let Value::Uint(n) = v { *n } else { 0 })
                .collect()),
            (Some(Value::Uint(2)), _, Some(Value::Text(t))) => Err(t.as_str().to_owned()),
            other => panic!("an answer: {other:?}"),
        }
    }
}

struct Served(Child);

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Where the body stood at each tick record that moved it, from the world's log: the node it stood on and its
/// position in that node's frame, µm.
fn track(dir: &Path) -> Vec<(Id, Vec3)> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = Vec::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        let Ok(Value::Map(m)) = decode(&r).map(|d| d.value) else {
            continue;
        };
        if let Some(Value::Array(rows)) = m.get(&answers::BODIES) {
            for (_, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                out.push((pose.frame.node, pose.position));
            }
        }
    }
    out
}

fn metres(p: Vec3) -> String {
    let m = |v: i64| v as f64 / 1e6;
    format!("({:.2}, {:.2}, {:.2}) m", m(p.x), m(p.y), m(p.z))
}

#[test]
#[ignore = "needs the Mars template's facts file and a built worldd (see the module doc)"]
fn a_soul_walks_out_of_mimos_from_each_of_its_floors() {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let facts = std::env::var("MARS_FACTS")
        .unwrap_or_else(|_| format!("{root}/.local/import-eden/mars-two.facts.json"));
    let im = import_eden::load(&std::fs::read_to_string(&facts).expect("the Mars facts file"))
        .expect("Mars loads");
    let node = |key: String| *im.nodes.get(&key).unwrap_or_else(|| panic!("no {key}"));
    let (ground, dojo, tracks) = (
        node("ground".into()),
        node(DOJO.into()),
        node(TRACKS.into()),
    );
    let floor = |level: u8| node(format!("{MIMOS}/floor-{level}"));
    // Each room of Mimos and the floor it is on: the raised main room, the lounge and the tea room.
    let rooms = [
        ("main", floor(1)),
        ("main-south", floor(0)),
        ("floor", floor(0)),
    ];

    let dir = std::env::temp_dir().join(format!("mars-w8-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let worldd = env!("CARGO_BIN_EXE_worldd");
    let seeded = Command::new(worldd)
        .args(["seed", "--facts", &facts, "--dir"])
        .arg(&dir)
        .args(["--entries", &format!("{root}/content/kinds")])
        .args(["--souls", "0", "--at", "-6.0,-30.0"])
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
    // The world's stdout stays read: with the pipe closed, its next line would panic the thread that wrote it.
    std::thread::spawn(move || for _ in out.lines().map_while(Result::ok) {});
    let s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(300))).unwrap();
    let mut soul = Client(
        s,
        Id::new(Scope([0xc1; 16]), 1).unwrap(),
        0,
        im.nodes["world"].scope(),
    );
    soul.act(JOIN, None).expect("born by the entry");

    let mut failed = Vec::new();
    for (room, on) in rooms {
        for (name, to) in [("the dojo", dojo), ("the camp tracks", tracks)] {
            let walked_in = soul.walk(node(format!("{MIMOS}/{room}")));
            let before = track(&dir);
            let (at, from) = *before.last().expect("the body's place");
            println!(
                "in to Mimos {room}: {walked_in:?}; on its floor: {}; at {}",
                at == on,
                metres(from)
            );
            if walked_in.is_err() || at != on {
                failed.push(format!(
                    "in to {room}: {walked_in:?}, on its floor: {}",
                    at == on
                ));
                continue;
            }
            let walked_out = soul.walk(to);
            let after = track(&dir);
            let (end, there) = *after.last().unwrap();
            // The walk out, from the world's records: the longest move between two records on one node, and each
            // change of node (a link crossed).
            let path = &after[before.len() - 1..];
            let mut longest = 0i64;
            let mut crossed = 0;
            for w in path.windows(2) {
                if w[0].0 == w[1].0 {
                    let (dx, dz) = (w[1].1.x - w[0].1.x, w[1].1.z - w[0].1.z);
                    longest = longest.max((dx * dx + dz * dz).isqrt());
                } else {
                    crossed += 1;
                }
            }
            println!(
                "  out from Mimos {room} to {name}: {walked_out:?}; from {} to {} on the open ground: {}; {} records, \
                 {crossed} changes of node, longest move between two records {} mm",
                metres(from),
                metres(there),
                end == ground,
                path.len(),
                longest / 1000
            );
            if walked_out.is_err() || end != ground || longest > 500_000 {
                failed.push(format!(
                    "out from {room} to {name}: {walked_out:?}, on the ground: {}, longest move {} mm",
                    end == ground,
                    longest / 1000
                ));
            }
        }
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(failed.is_empty(), "{failed:#?}");
}

/// The garden bed and the watering can by it, about 105 m east of the birth point, today's ids (#4086's rehearsal).
const GARDEN_BED: &str = "e_33c75f86";
const WATERING_CAN: &str = "e_d602cb0a";

/// Each body's places in the world's log in `dir`, in order, by the body's id: the node it stood on and its position
/// in that node's frame, µm.
fn body_rows(dir: &Path) -> BTreeMap<Id, Vec<(Id, Vec3)>> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = BTreeMap::<Id, Vec<(Id, Vec3)>>::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        let Ok(Value::Map(m)) = decode(&r).map(|d| d.value) else {
            continue;
        };
        if let Some(Value::Array(rows)) = m.get(&answers::BODIES) {
            for (id, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                out.entry(id)
                    .or_default()
                    .push((pose.frame.node, pose.position));
            }
        }
    }
    out
}

/// W10 (#4086, #4118), the rehearsal's two answers on the served Mars template, each by its own Soul born about 105 m
/// west of the garden bed: a walk to the garden bed, and a take of the watering can beside it. Each answer's time and
/// the body's place at each end are read from the world's log. A receipt never comes without the walk: the body ends
/// within a few metres of the thing, having crossed the 100 m between.
// A real process on the real clock: the answers' seconds are real time.
#[allow(clippy::disallowed_methods)]
#[test]
#[ignore = "needs the Mars template's facts file and a built worldd (see the module doc)"]
fn w10_a_walk_and_a_take_100_m_away_cross_the_ground_between() {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let facts = std::env::var("MARS_FACTS")
        .unwrap_or_else(|_| format!("{root}/.local/import-eden/mars-two.facts.json"));
    let im = import_eden::load(&std::fs::read_to_string(&facts).expect("the Mars facts file"))
        .expect("Mars loads");
    let (ground, bed, can) = (
        im.nodes["ground"],
        im.nodes[GARDEN_BED],
        im.nodes[WATERING_CAN],
    );
    let dir = std::env::temp_dir().join(format!("mars-w10-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let worldd = env!("CARGO_BIN_EXE_worldd");
    let seeded = Command::new(worldd)
        .args(["seed", "--facts", &facts, "--dir"])
        .arg(&dir)
        .args(["--entries", &format!("{root}/content/kinds")])
        .args(["--souls", "0", "--at", "-6.0,-30.0"])
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
    let where_of = |b: Id| {
        let rows = body_rows(&dir);
        let r = rows.get(&b).expect("the body's rows");
        (*r.first().unwrap(), *r.last().unwrap())
    };
    // A thing's place in the zone's frame, µm, from the facts (`world`, mm).
    let f = replica::rules::json::parse(&std::fs::read_to_string(&facts).unwrap()).unwrap();
    let thing_at = |id: &str| {
        let t = f
            .get("things")
            .and_then(|t| t.arr())
            .unwrap()
            .iter()
            .find(|t| t.get("id").and_then(|i| i.str()) == Some(id))
            .expect("the thing");
        let w = t.get("world").and_then(|w| w.arr()).unwrap();
        let mm = |k: usize| match &w[k] {
            replica::rules::json::Value::Int(v) => i64::try_from(*v).unwrap() * 1000,
            _ => 0,
        };
        Vec3::new(mm(0), 0, mm(2))
    };
    let gap = |p: Vec3, q: Vec3| {
        (i128::from(p.x - q.x).pow(2) + i128::from(p.z - q.z).pow(2)).isqrt() as f64 / 1e6
    };
    let mut failed = Vec::new();
    for (n, verb, thing, at, what) in [
        (
            1,
            "eden:walk",
            bed,
            thing_at(GARDEN_BED),
            "walk to the garden bed",
        ),
        (
            2,
            "eden:take",
            can,
            thing_at(WATERING_CAN),
            "take the watering can",
        ),
    ] {
        let s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(300))).unwrap();
        let mut soul = Client(
            s,
            Id::new(Scope([0xc1; 16]), n).unwrap(),
            0,
            im.nodes["world"].scope(),
        );
        let known: Vec<Id> = body_rows(&dir).into_keys().collect();
        soul.act(JOIN, None).expect("born by the entry");
        let body = *body_rows(&dir)
            .keys()
            .find(|b| !known.contains(b))
            .expect("the new body");
        let t0 = std::time::Instant::now();
        let answer = soul.act(verb, Some(thing));
        let secs = t0.elapsed().as_secs_f64();
        let ((on0, from), (on1, to)) = where_of(body);
        println!(
            "W10 Mars {what}: {answer:?} in {secs:.1} s; body from {} to {} (on the ground: {}), {:.1} m from the thing at the start and {:.1} m at the end",
            metres(from),
            metres(to),
            on0 == ground && on1 == ground,
            gap(from, at),
            gap(to, at)
        );
        if answer.is_err() || gap(from, at) < 90.0 || gap(to, at) > 3.0 || secs < 30.0 {
            failed.push(format!(
                "{what}: {answer:?} in {secs:.1} s, {:.1} m from it at the end",
                gap(to, at)
            ));
        }
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(failed.is_empty(), "{failed:#?}");
}

/// The kitchen, its raised floor (530 mm up, the working kitchen and the dining hall) reached by an outside stair, and
/// the dining hall's four bus seats, today's ids on the Mars template (W12, #4088).
const KITCHEN: &str = "e_2333a04e";
const BUS_SEATS: [&str; 4] = ["e_59043a4e", "e_3d52ac7f", "e_3e97414e", "e_f18eedd0"];

/// W12 (#4088): on the served Mars template a walk to a seat in the dining hall had no answer within 120 s in the
/// rehearsal of 22 Nov. Here a Soul born at the rehearsal's birth point walks to each bus seat of the dining hall; each
/// walk's answer, its time and the body's place at each end (from the world's log) are printed. Each answers within
/// 120 s, and a walk receipted ends on the raised floor.
// A real process on the real clock: the answers' seconds are real time.
#[allow(clippy::disallowed_methods)]
#[test]
#[ignore = "needs the Mars template's facts file and a built worldd (see the module doc)"]
fn w12_a_walk_to_each_dining_hall_seat_ends_with_an_answer() {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let facts = std::env::var("MARS_FACTS")
        .unwrap_or_else(|_| format!("{root}/.local/import-eden/mars-two.facts.json"));
    let im = import_eden::load(&std::fs::read_to_string(&facts).expect("the Mars facts file"))
        .expect("Mars loads");
    let raised = im.nodes[&format!("{KITCHEN}/floor-1")];
    let dir = std::env::temp_dir().join(format!("mars-w12-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let worldd = env!("CARGO_BIN_EXE_worldd");
    let seeded = Command::new(worldd)
        .args(["seed", "--facts", &facts, "--dir"])
        .arg(&dir)
        .args(["--entries", &format!("{root}/content/kinds")])
        .args(["--souls", "0", "--at", "-6.0,-30.0"])
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
    let mut failed = Vec::new();
    for (n, seat) in BUS_SEATS.iter().enumerate() {
        let s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
        // The rehearsal's wait: no answer within it fails here (the read times out).
        s.set_read_timeout(Some(Duration::from_secs(120))).unwrap();
        let mut soul = Client(
            s,
            Id::new(Scope([0xc1; 16]), n as u64 + 1).unwrap(),
            0,
            im.nodes["world"].scope(),
        );
        let known: Vec<Id> = body_rows(&dir).into_keys().collect();
        soul.act(JOIN, None).expect("born by the entry");
        let body = *body_rows(&dir)
            .keys()
            .find(|b| !known.contains(b))
            .expect("the new body");
        let t0 = std::time::Instant::now();
        // No answer within the wait (the read times out): named, and the next seat walked.
        let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            soul.walk(im.nodes[*seat])
        }))
        .unwrap_or_else(|_| Err("no answer within 120 s".into()));
        let secs = t0.elapsed().as_secs_f64();
        let rows = body_rows(&dir);
        let r = &rows[&body];
        let ((on0, from), (on1, to)) = (r[0], *r.last().unwrap());
        println!(
            "W12 Mars walk to the dining hall's {seat}: {answer:?} in {secs:.1} s; body from {} (on the ground: {}) \
             to {} (on the raised floor: {}), {} records",
            metres(from),
            on0 == im.nodes["ground"],
            metres(to),
            on1 == raised,
            r.len()
        );
        if secs >= 120.0 || (answer.is_ok() && on1 != raised) {
            failed.push(format!(
                "{seat}: {answer:?} in {secs:.1} s, on the raised floor: {}",
                on1 == raised
            ));
        }
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(failed.is_empty(), "{failed:#?}");
}
