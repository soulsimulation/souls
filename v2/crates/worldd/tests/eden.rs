//! Engine v2 C12 (#3427): a Soul on a seeded Eden parks a bicycle in a real bike rack and takes it out again, through
//! Eden's own entries (`content/kinds/vehicles/bike_rack.json`), end to end: `worldd seed` from Eden's facts with
//! `--entries content/kinds`, `worldd serve`, and a client on the world's socket (I1's framing), as the gateway
//! speaks to it. The rack's `park` walks to the chosen stand's `front` point and puts the bicycle, wheeled beside the
//! body, into that stand; its `take_out` walks to `front` and takes the bicycle into a hand.
//!
//! C13 (#3440): racks turned 90 and 180 degrees are walked to on their turned fronts (A1), and every point a form
//! walks to on Eden is measured for whether a body can stand there, as written and as `worldd seed` imports the
//! entries, each remaining one named with what keeps a body off it (A2, A3).
//!
//! Needs the generated Eden 2026 facts file (`v2/tools/import-eden/README.md`) and a built `worldd`:
//! `cargo test -p worldd --test eden -- --ignored --nocapture` from `v2/` (`EDEN_FACTS` names another file).

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use replica::effects::{Actor, Body, Part, TransferRec};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use worldd::answers::{self, JOIN};

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

/// The world's end of the gateway's socket, as one Soul.
struct Client(UnixStream, Id, u64, Scope);

impl Client {
    fn act(
        &mut self,
        verb: &str,
        target: Option<Id>,
        parameters: BTreeMap<u64, Value>,
    ) -> Result<Vec<u64>, String> {
        self.2 += 1;
        let i = Intent {
            actor: Actor::Soul(self.1),
            verb: name(verb),
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
        // A progress answer (C20, kind 3 with the µs left) comes before the act's own answer: printed, and read past.
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
            match (a.get(&3), a.get(&answers::LEFT)) {
                (Some(Value::Uint(3)), Some(Value::Uint(left))) => {
                    println!("{verb}: in progress, {:.1} s left", *left as f64 / 1e6);
                }
                _ => break a,
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

/// `[[name, value], ...]`: a form's arguments, a thing by id, a slot by number.
fn args(pairs: &[(&str, Value)]) -> BTreeMap<u64, Value> {
    let a = pairs
        .iter()
        .map(|(k, v)| Value::Array(vec![Value::Bytes(k.as_bytes().to_vec()), v.clone()]))
        .collect();
    BTreeMap::from([(1, Value::Array(a))])
}

/// The Eden 2026 facts file, its path.
fn facts_path() -> String {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    std::env::var("EDEN_FACTS")
        .unwrap_or_else(|_| format!("{root}/.local/import-eden/eden-2026.facts.json"))
}

/// `worldd seed` from `facts` (a path) with Eden's entries and births from `at` (`x,z` m), then `worldd serve`, and a
/// Soul joined on the world's socket: the server, the Soul and the world's folder.
fn serve(facts: &str, at: &str, tag: &str, lineage: Scope) -> (Served, Client, PathBuf) {
    let (served, soul, dir, _) = serve_lines(facts, at, tag, lineage);
    (served, soul, dir)
}

/// [`serve`], with the lines `worldd serve` printed before it listened.
fn serve_lines(
    facts: &str,
    at: &str,
    tag: &str,
    lineage: Scope,
) -> (Served, Client, PathBuf, Vec<String>) {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    serve_entries(facts, &format!("{root}/content/kinds"), at, tag, lineage)
}

/// [`serve_lines`], with the entries in folder `entries`.
fn serve_entries(
    facts: &str,
    entries: &str,
    at: &str,
    tag: &str,
    lineage: Scope,
) -> (Served, Client, PathBuf, Vec<String>) {
    let dir = std::env::temp_dir().join(format!("eden-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let worldd = env!("CARGO_BIN_EXE_worldd");
    let seeded = Command::new(worldd)
        .args(["seed", "--facts", facts, "--dir"])
        .arg(&dir)
        .args(["--entries", entries, "--souls", "0", "--at", at])
        .output()
        .unwrap();
    println!("seed: {}", String::from_utf8_lossy(&seeded.stdout).trim());
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
    let (mut line, mut lines) = (String::new(), Vec::new());
    while out.read_line(&mut line).unwrap() > 0 && !line.contains("listening ") {
        lines.push(std::mem::take(&mut line));
    }
    print!("serve: {line}");
    let s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(90))).unwrap();
    let mut soul = Client(s, Id::new(Scope([0xc1; 16]), 1).unwrap(), 0, lineage);
    let joined = soul.act(JOIN, None, BTreeMap::new());
    println!("join: {joined:?}");
    joined.expect("born by the entry");
    (served, soul, dir, lines)
}

/// Where the bodies stood at each tick record that moved one, from the world's log: `(tick, node, x m, z m)`.
fn track(dir: &Path) -> Vec<(u64, Id, f64, f64)> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = Vec::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        let Ok(Value::Map(m)) = decode(&r).map(|d| d.value) else {
            continue;
        };
        let tick = match m.get(&answers::TICK) {
            Some(Value::Uint(t)) => *t,
            _ => 0,
        };
        if let Some(Value::Array(rows)) = m.get(&answers::BODIES) {
            for (_, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                let (x, z) = (pose.position.x as f64 / 1e6, pose.position.z as f64 / 1e6);
                out.push((tick, pose.frame.node, x, z));
            }
        }
    }
    out
}

/// Each frame `bike` was moved to, in order (B4's transfers' leaves), from the world's log.
fn moves_of(dir: &Path, bike: Id) -> Vec<(Id, Option<u64>)> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = Vec::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            if let Body::Transfer(TransferRec::Leave { node, pose, .. }) = e.body
                && node == bike
            {
                out.push((pose.frame.node, pose.frame.slot));
            }
        }
    }
    out
}

/// Parks `bike` in stand 1 of `rack`, takes it out, and parks it again, held, in stand 2, through the rack's own
/// entry: the bicycle's moves, from the log.
fn park_and_unpark(soul: &mut Client, dir: &Path, rack: Id, bike: Id) {
    let park = soul.act(
        "eden:park",
        Some(rack),
        args(&[("bike", bike.to_value()), ("stand", Value::Uint(1))]),
    );
    println!("park the bicycle in stand 1: {park:?}");
    park.expect("parked through the rack's own entry");
    let unpark = soul.act(
        "eden:take_out",
        Some(rack),
        args(&[("bike", bike.to_value())]),
    );
    println!("take it out: {unpark:?}");
    unpark.expect("taken out through the rack's own entry");
    let park2 = soul.act(
        "eden:park",
        Some(rack),
        args(&[("bike", bike.to_value()), ("stand", Value::Uint(2))]),
    );
    println!("park it again, held, in stand 2: {park2:?}");
    park2.expect("parked again");
    let moves = moves_of(dir, bike);
    println!("the bicycle's frames: {moves:?}");
    assert_eq!(moves.len(), 3, "three moves");
    assert_eq!(moves[0], (rack, Some(1)), "parked in stand 1");
    assert!(
        moves[1].0 != rack && matches!(moves[1].1, Some(1 | 2)),
        "taken out into a hand of the body"
    );
    assert_eq!(moves[2], (rack, Some(2)), "parked in stand 2");
}

#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a2_a_soul_parks_and_takes_out_a_bicycle_through_edens_own_rack() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).expect("the Eden facts file"))
        .expect("Eden loads");
    // The rack by the west gate (e_9e923006, at (53.8, 1.6) m) and the bicycle standing 400 mm west of it.
    let (rack, bike) = (im.nodes["e_9e923006"], im.nodes["e_a23bb167"]);
    // Births stand 1 m east of the entry: 1.2 m south-west of the rack's front.
    let (served, mut soul, dir) = serve(&facts, "52.6,3.5", "c12", rack.scope());
    park_and_unpark(&mut soul, &dir, rack, bike);
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
}

/// `text` (a facts file) with each thing `(id, def, from, to)` moved from pose `from` to `to` (`[x, y, z, yaw]`, mm
/// and millidegrees).
fn moved(text: &str, things: &[(&str, &str, &str, &str)]) -> String {
    let mut out = text.to_owned();
    for (id, def, from, to) in things {
        let at = |p: &str| {
            format!(
                r#""id":"{id}","def":"{def}","ref":"{def}","parent":null,"pose":{p},"world":{p}"#
            )
        };
        assert!(out.contains(&at(from)), "{id} at {from}");
        out = out.replacen(&at(from), &at(to), 1);
    }
    out
}

/// C13 (#3440) A1: the form runner turns a thing's points by its orientation. A copy of Eden sets two racks just north
/// of the clinic's north wall (z -11.09 m), where a rack's front walked to unturned (1.2 m south of its middle) lies
/// within a body's radius of the wall, off the ground a body can stand on (`souls:no-way`), and its turned front is
/// clear: Eden's rack turned 89.954 degrees (e_78e974aa) at (66.5, -12.4) m, its front 1.2 m east, and the rack by the
/// street (e_260e18fa) turned 180 degrees at (63.0, -12.05) m, its front 1.2 m north; each with a bicycle beside it.
/// A Soul parks a bicycle in each, takes it out and parks it again.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a1_racks_turned_90_and_180_degrees_park_and_unpark_a_bicycle() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).expect("the Eden facts file");
    let im = import_eden::load(&text).expect("Eden loads");
    let turned = moved(
        &text,
        &[
            (
                "e_78e974aa",
                "core-bike-rack@1",
                "[99600,0,13000,89954]",
                "[66500,0,-12400,89954]",
            ),
            (
                "e_0a888a23",
                "core-bicycle@1",
                "[99600,0,12600,92819]",
                "[66500,0,-12800,92819]",
            ),
            (
                "e_260e18fa",
                "core-bike-rack@1",
                "[67600,0,1700,0]",
                "[63000,0,-12050,180000]",
            ),
            (
                "e_b52153e6",
                "core-bicycle@1",
                "[67200,0,1700,2292]",
                "[62600,0,-12050,2292]",
            ),
        ],
    );
    let path = std::env::temp_dir().join(format!("eden-c13-{}.json", std::process::id()));
    std::fs::write(&path, &turned).unwrap();
    // Births stand 1 m east of the entry: between the two racks, north of their fronts.
    let (served, mut soul, dir) = serve(
        path.to_str().unwrap(),
        "63.0,-14.0",
        "c13",
        im.nodes["world"].scope(),
    );
    for (rack, bike, turn) in [
        ("e_78e974aa", "e_0a888a23", 90),
        ("e_260e18fa", "e_b52153e6", 180),
    ] {
        println!("the rack turned {turn} degrees");
        park_and_unpark(&mut soul, &dir, im.nodes[rack], im.nodes[bike]);
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_file(&path);
}

/// C15 (#3447) A1: a form whose point a body cannot stand on acts from the nearest place within reach of it, and one
/// with no such place answers `souls:no-way`, on a seeded Eden. The toy blocks by the hall (`by` lies within a
/// body's clearance of the hall's wall) are knocked down from a place 0.1 m off `by`; the market stall whose
/// `customer` point a barrel stands on (no place a body can stand within 4 m of it) refuses `take_apple` by name.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c15_a_point_with_no_room_is_acted_at_from_the_nearest_place_within_reach() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    // The toy blocks (cd:9948) and the market stall (cd:9311).
    let (blocks, stall) = (im.nodes["e_1b5f1fe9"], im.nodes["e_3d03a31f"]);
    let (served, mut soul, dir) = serve(&facts, "44.0,27.5", "c15", im.nodes["world"].scope());
    let knocked = soul.act("eden:knock_down", Some(blocks), BTreeMap::new());
    println!("knock the toy blocks down: {knocked:?}");
    let apple = soul.act("eden:take_apple", Some(stall), BTreeMap::new());
    println!("take an apple at the market stall: {apple:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    knocked.expect("acted from the nearest place within reach");
    assert_eq!(apple, Err("souls:no-way".to_owned()));
}

/// Today's Eden's seats: each thing's slots of kind `seat` or `bed` in the facts file (the bake today's engine sits
/// on), counted by thing def: (slots, things).
fn todays_seats(text: &str) -> BTreeMap<String, (usize, usize)> {
    let facts = replica::rules::json::parse(text).expect("the facts parse");
    let mut out: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for t in facts.get("things").and_then(|t| t.arr()).unwrap_or(&[]) {
        let n = t
            .get("slots")
            .and_then(|s| s.arr())
            .unwrap_or(&[])
            .iter()
            .filter(|s| matches!(s.get("kind").and_then(|k| k.str()), Some("seat" | "bed")))
            .count();
        if n > 0 {
            let def = t.get("def").and_then(|d| d.str()).unwrap_or("?");
            let e = out.entry(def.to_owned()).or_default();
            (e.0, e.1) = (e.0 + n, e.1 + 1);
        }
    }
    out
}

/// C17 (#3453) A1 and C19 (#3457) A1: a seeded Eden registers every body slot its entries declare (a sofa's three, a
/// bed's two), counted slot by slot against today's Eden's seat and bed slots by thing def; and the gateway's walk, sit
/// and rise work on one: a Soul born outside the library walks in to the sage armchair's stand point, sits and rises.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c17_a1_a_seeded_eden_registers_its_seats_and_the_gateway_sits_on_one() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let today = todays_seats(&text);
    let (slots, things) = today.values().fold((0, 0), |(s, t), (a, b)| (s + a, t + b));
    println!("today's Eden: {slots} seats (seat and bed slots) on {things} things");
    // The sage armchair in the library's reading room (cd:…, today's e_1f3666fe).
    let armchair = im.nodes["e_1f3666fe"];
    let (served, mut soul, dir, lines) =
        serve_lines(&facts, "74.0,-1.0", "c17a1", im.nodes["world"].scope());
    let seats = lines
        .iter()
        .find(|l| l.starts_with("places to sit or lie: "))
        .expect("the places line")
        .trim()
        .to_owned();
    println!("{seats}");
    let walked = soul.act("eden:walk", Some(armchair), BTreeMap::new());
    println!("walk to the armchair: {walked:?}");
    let sat = soul.act("eden:sit", Some(armchair), BTreeMap::new());
    println!("sit in it: {sat:?}");
    let rose = soul.act("eden:rise", None, BTreeMap::new());
    println!("rise: {rose:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    // `places to sit or lie: <n> registered on <things> things; <all> body slots declared; <left> with no floor; <moved> stand
    // points moved to clear ground`
    let n: Vec<usize> = seats
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|w| w.parse().ok())
        .collect();
    let [registered, on, declared, left, moved] = n[..] else {
        panic!("{seats}")
    };
    println!(
        "registered {registered} of today's {slots} seats ({declared} declared by the entries); things \
         {on} of today's {things}; {moved} stand points moved to clear ground"
    );
    // By today's thing def: today's seats and seated things, against the things the entries give a seat.
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let mut found = Vec::new();
    entries(Path::new(&format!("{root}/content/kinds")), &mut found);
    let (mine, _) = import_eden::body_slots(&im.tree, &found);
    let def_of: BTreeMap<Id, String> = replica::rules::json::parse(&text)
        .unwrap()
        .get("things")
        .and_then(|t| t.arr())
        .unwrap_or(&[])
        .iter()
        .filter_map(|t| {
            let id = im.nodes.get(t.get("id")?.str()?)?;
            Some((*id, t.get("def")?.str()?.to_owned()))
        })
        .collect();
    // Registered slots by def, slot by slot (C19), against today's.
    let mut by_def: BTreeMap<String, usize> = BTreeMap::new();
    for s in &mine {
        *by_def
            .entry(def_of.get(&s.thing).cloned().unwrap_or_default())
            .or_default() += 1;
    }
    let (mut covered, mut short) = (0, Vec::new());
    for (def, (s, t)) in &today {
        let r = by_def.get(def).copied().unwrap_or(0);
        covered += r.min(*s);
        if r != *s {
            println!("  {def}: today {s} slots on {t} things; registered {r}");
        }
        if r < *s {
            short.push(def.clone());
        }
    }
    for (def, r) in &by_def {
        if !today.contains_key(def) {
            println!("  {def}: no seat today; registered {r}");
        }
    }
    println!(
        "C19 A1: {covered} of today's {slots} seat and bed slots registered; {} more that today has no seat for; \
         short of today: {short:?}",
        registered - covered
    );
    let mut on_things: Vec<Id> = mine.iter().map(|s| s.thing).collect();
    on_things.dedup();
    assert_eq!(
        mine.len(),
        registered,
        "the world registers every slot the entries declare"
    );
    assert_eq!(left, 0, "every seat placed on a floor");
    assert_eq!(on, on_things.len(), "the things they are on");
    assert_eq!(registered, declared, "every declared body slot registered");
    // Every def today seats has at least today's slots, but those whose entries declare no body slot with a stand
    // point (C17: the campfire's and the piano's).
    let none: Vec<&str> = short
        .iter()
        .filter(|d| by_def.get(*d).copied().unwrap_or(0) > 0)
        .map(String::as_str)
        .collect();
    assert!(none.is_empty(), "short of today's slots: {none:?}");
    assert_eq!(
        short,
        vec!["core-campfire@1".to_owned(), "core-piano@1".to_owned()],
        "only the entries with no body slot"
    );
    walked.expect("walked in to the armchair's stand point");
    sat.expect("sat in the armchair");
    rose.expect("rose from it");
}

/// Soul `n` joined on the world's socket in `dir`: born by the entry.
fn join(dir: &Path, n: u64, lineage: Scope) -> Client {
    let mut soul = reconnect(dir, n, 0, lineage);
    soul.act(JOIN, None, BTreeMap::new())
        .expect("born by the entry");
    soul
}

/// Soul `n` on the world's socket in `dir` again, its last sequence `seq`.
fn reconnect(dir: &Path, n: u64, seq: u64, lineage: Scope) -> Client {
    let s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(90))).unwrap();
    Client(s, Id::new(Scope([0xc1; 16]), n).unwrap(), seq, lineage)
}

/// Each body's last logged frame (its node and slot) in the world's log in `dir` (K18's body rows).
fn last_frames(dir: &Path) -> BTreeMap<Id, (Id, Option<u64>)> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = BTreeMap::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        if let Some(Value::Array(rows)) = Part::read(&r).unwrap().rest.get(&answers::BODIES) {
            for row in rows {
                if let Some((id, pose, _)) = worldd::bodies::read_row(row) {
                    out.insert(id, (pose.frame.node, pose.frame.slot));
                }
            }
        }
    }
    out
}

/// C19 (#3457) A2 and A3: three Souls share a sofa on a seeded Eden, each in its own slot, and keep their slots over a
/// restart. The roundhouse south of the library (e_9e423940, at (67.5, -18.5) m, its front door open at z -15.6 m) has
/// a three-seat sofa (e_3bfd13e0). Four Souls are born outside the front door. Three in turn walk to the sofa and sit
/// on it through the gateway, naming only the sofa: the world picks each the free slot nearest it. The fourth's sit is
/// refused `place-taken`. The world is stopped and served again on the same folder: the three are seated in the same
/// slots, the fourth is still refused, and each of the three rises.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c19_three_souls_share_a_sofa_each_in_its_own_slot_over_a_restart() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (sofa, lineage) = (im.nodes["e_3bfd13e0"], im.nodes["world"].scope());
    let (served, first, dir) = serve(&facts, "66.5,-13.5", "c19", lineage);
    let mut souls = vec![first];
    for n in 2..=4 {
        souls.push(join(&dir, n, lineage));
    }
    for (i, soul) in souls.iter_mut().enumerate().take(3) {
        let walked = soul.act("eden:walk", Some(sofa), BTreeMap::new());
        let sat = soul.act("eden:sit", Some(sofa), BTreeMap::new());
        println!(
            "Soul {}: walk to the sofa {walked:?}, sit on it {sat:?}",
            i + 1
        );
        walked.expect("walked to a free slot's stand point");
        sat.expect("sat in a free slot");
    }
    let fourth = souls[3].act("eden:sit", Some(sofa), BTreeMap::new());
    println!("Soul 4: sit on the full sofa {fourth:?}");
    assert_eq!(fourth, Err("place-taken".to_owned()));
    let frames = last_frames(&dir);
    let mut slots: Vec<Option<u64>> = frames
        .values()
        .filter(|(node, _)| *node == sofa)
        .map(|f| f.1)
        .collect();
    slots.sort_unstable();
    println!("the sofa's sitters' logged slots: {slots:?}");
    assert_eq!(
        slots,
        vec![Some(1), Some(2), Some(3)],
        "each in its own slot"
    );

    // A3: stopped and served again on the same folder (K18c).
    drop(served);
    let mut child = Command::new(env!("CARGO_BIN_EXE_worldd"))
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
    print!("restarted: {line}");
    let mut souls: Vec<Client> = souls
        .iter()
        .enumerate()
        .map(|(i, s)| reconnect(&dir, i as u64 + 1, s.2, lineage))
        .collect();
    let again = souls[3].act("eden:sit", Some(sofa), BTreeMap::new());
    println!("after the restart, Soul 4: sit on the sofa {again:?}");
    let mut rose = Vec::new();
    for soul in souls.iter_mut().take(3) {
        rose.push(soul.act("eden:rise", None, BTreeMap::new()));
    }
    println!("after the restart, the three rise: {rose:?}");
    let after = last_frames(&dir);
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(again, Err("place-taken".to_owned()), "still full");
    for r in rose {
        r.expect("each rises from its own slot");
    }
    assert!(
        frames
            .iter()
            .filter(|(_, f)| f.0 == sofa)
            .all(|(b, _)| after.get(b).is_some_and(|f| f.0 != sofa)),
        "each set down off the sofa: {after:?}"
    );
}

/// C17 (#3453) A2: a Soul born outside the lake cabin sits at the cabin's chair that stands under its table (its
/// `front`, where a body stands to take the seat, lies under the table top) through the chair's own `sit` form: it
/// walks in through the cabin's door to the nearest clear ground within reach of the seat's stand point (C15) and
/// takes the seat by the form's `sit` step (B2's sit move into B3's seat, the gateway's own). It rises by the
/// gateway's rise. The library's reading chairs stand under their tables too, but their nearest clear ground within
/// 0.3 m is a pocket between the chair and the table no walk reaches (0.6 m off is the nearest a walk reaches): the sit
/// there answers `souls:no-way`, by name.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c17_a2_a_soul_sits_at_a_chair_under_its_table_by_its_own_form() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    // The lake cabin's first chair (today's e_0fc49dc9, at (-120.03, -57.34) m turned 65 degrees; its front lies
    // under the cabin's table at (-119.26, -57.04) m), and the library's west reading chair (e_5a2ad7fc).
    let (chair, reading) = (im.nodes["e_0fc49dc9"], im.nodes["e_5a2ad7fc"]);
    // Births stand 1 m east of the entry: 1.2 m outside the cabin's front door at (-121.0, -55.8) m.
    let (served, mut soul, dir) = serve(&facts, "-122.5,-54.6", "c17a2", im.nodes["world"].scope());
    let sat = soul.act("eden:sit", Some(chair), args(&[("seat", Value::Uint(1))]));
    println!("from outside, sit at the cabin's chair under its table, by its own form: {sat:?}");
    let rose = soul.act("eden:rise", None, BTreeMap::new());
    println!("rise: {rose:?}");
    let pocket = soul.act("eden:sit", Some(reading), args(&[("seat", Value::Uint(1))]));
    println!("sit at the library's west reading chair: {pocket:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    sat.expect("sat by the chair's own form");
    rose.expect("rose");
    assert_eq!(pocket, Err("souls:no-way".to_owned()));
}

/// C17 (#3453) A3: a Soul born outside the library walks in through its door (a form's walk across the doorway's
/// link) and unrolls the west rug through the rug's own entry (`unroll`: a walk to its end, a 3 s pause).
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c17_a3_a_soul_walks_into_the_library_and_uses_a_thing_there_by_its_own_entry() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    // The library's west rug (today's e_7cefb7c4, at (71.5, -6.3) m); the library's door at (74.0, -2.91) m.
    let rug = im.nodes["e_7cefb7c4"];
    let (served, mut soul, dir) = serve(&facts, "74.0,-1.0", "c17a3", im.nodes["world"].scope());
    // `unroll`, a walk in and a 3 s pause (C20 gives `roll_up`'s 5 s pause after the walk its own time too).
    let unrolled = soul.act("eden:unroll", Some(rug), BTreeMap::new());
    println!("from outside, unroll the library's west rug: {unrolled:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    unrolled.expect("walked indoors and used the rug through its own entry");
}

/// The entries a receipt names, from the world's log: each one's world time, its events' names, and an
/// `act-deadline` entry's deadline (field 5).
fn receipt_entries(dir: &Path, entries: &[u64]) -> Vec<(i64, Vec<String>, Option<u64>)> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = Vec::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            if !entries.contains(&e.envelope.sequence) {
                continue;
            }
            let events = e.events.unwrap_or_default();
            let due = events.iter().find_map(|v| match v.fields.get(&5) {
                Some(Value::Uint(d)) if v.name.as_str() == answers::ACT_DEADLINE => Some(*d),
                _ => None,
            });
            let names = events.iter().map(|v| v.name.as_str().to_owned()).collect();
            out.push((e.envelope.at, names, due));
        }
    }
    out
}

/// C20 (#3469) A3: a Soul born outside the library walks across the town, 39 m as the crow flies, to the toy blocks
/// (today's e_1b5f1fe9, at (47.3, 26.9) m) and builds with them by their own entry, `build` (its walk to `by`, a press
/// on the top, then a pause of `pause` µs, from the entries in `entries`): the act ends `done`, after it was answered in progress at its
/// start, and its receipt names its deadline (its start plus its steps' span), which covers the walk and the pause.
/// The walk's time, the whole act's and the deadline's, each from the act's start.
fn walk_across_and_build(entries: &str, pause: i64, tag: &str) -> (i64, i64, i64) {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let blocks = im.nodes["e_1b5f1fe9"];
    let (served, mut soul, dir, _) =
        serve_entries(&facts, entries, "74.0,-1.0", tag, im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    let built = soul.act("eden:build", Some(blocks), BTreeMap::new());
    println!("from outside the library, build with the toy blocks: {built:?}");
    let walked = track(&dir);
    if let (Some(a), Some(b)) = (walked.first(), walked.last()) {
        println!("the body from {:?} to {:?}", (a.2, a.3), (b.2, b.3));
    }
    let entries = receipt_entries(&dir, built.as_deref().unwrap_or(&[]));
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    built.expect("walked across and built, done");
    for (at, names, due) in &entries {
        println!("  {at} µs: {names:?} {due:?}");
    }
    let named = |n: &str| entries.iter().find(|e| e.1.iter().any(|x| x == n));
    let (start, _, due) = named(answers::ACT_DEADLINE).expect("the deadline in the receipt");
    let due = i64::try_from(due.expect("its deadline")).unwrap();
    let (end, _, _) = named(answers::FORM_ENDED).expect("the ending's entry");
    let (all, left) = (end - start, due - start);
    let walk = all - pause;
    println!(
        "walked {:.1} s, then the {:.0} s pause: done after {:.1} s; its deadline {:.1} s after its start",
        walk as f64 / 1e6,
        pause as f64 / 1e6,
        all as f64 / 1e6,
        left as f64 / 1e6
    );
    assert!(*end < due, "within its deadline");
    (walk, all, left)
}

/// C20 (#3469) A3, the walk: across the town (over 20 s), then the toy blocks' own 20 s form, by Eden's entries as
/// they are. Past an act's 10 s at its arrival, it ends `done`.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c20_a3_a_soul_walks_across_the_town_and_uses_a_thing_by_its_form() {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let (walk, all, _) =
        walk_across_and_build(&format!("{root}/content/kinds"), 20_000_000, "c20w");
    assert!(walk > 20_000_000, "a walk over 20 s");
    assert!(all > 40_000_000);
}

/// Copies folder `from` into `to`, file by file.
fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let p = e.unwrap().path();
        let t = to.join(p.file_name().unwrap());
        if p.is_dir() {
            copy_dir(&p, &t);
        } else {
            std::fs::copy(&p, &t).unwrap();
        }
    }
}

/// C20 (#3469) A3, a 60 s form: the same walk, then the toy blocks' form with its pause made 60 s, a long read's length
/// (Eden's own 60 s forms, the arcade cabinet's `play` and the desk's `write`, end `out-of-reach` and `move-unknown`
/// before their pause on v2 today). It ends `done`.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c20_a3_a_60_s_form_ends_done() {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let entries = std::env::temp_dir().join(format!("eden-c20-kinds-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&entries);
    copy_dir(Path::new(&format!("{root}/content/kinds")), &entries);
    let blocks = entries.join("play/toy_blocks.json");
    let text = std::fs::read_to_string(&blocks).unwrap();
    let long = text.replace(r#""us": 20000000"#, r#""us": 60000000"#);
    assert_ne!(text, long, "the blocks' 20 s pause");
    std::fs::write(&blocks, long).unwrap();
    let (walk, all, left) = walk_across_and_build(entries.to_str().unwrap(), 60_000_000, "c20l");
    let _ = std::fs::remove_dir_all(&entries);
    assert!(walk > 20_000_000, "a walk over 20 s");
    assert!(all > 80_000_000 && left > all);
}

/// Every `souls-entry/1` file under `dir`, `(kind, entry)`, as `worldd seed` reads them.
fn entries(dir: &Path, out: &mut Vec<(String, replica::rules::json::Value)>) {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            entries(&p, out);
        } else if p.extension().is_some_and(|x| x == "json") {
            let Ok(v) = replica::rules::json::parse(&std::fs::read_to_string(&p).unwrap()) else {
                continue;
            };
            if v.get("format").and_then(|f| f.str()) == Some("souls-entry/1")
                && let Some(k) = v.get("kind").and_then(|k| k.str())
            {
                out.push((k.to_owned(), v.clone()));
            }
        }
    }
}

/// A point a form walks to: its name, its role (`stand`, `grip`, ...; `slot` for a slot with no stand point) and
/// where it is in the kind's axes, µm. Or why it is none of the thing's own points: `point-unknown <name>` (named,
/// not declared) or `thing-argument` (a walk to another thing, not built).
type WalkPoint = Result<(String, String, replica::pose::Vec3), String>;

/// Each point a `walk_to` of any form of `entry` names, read as the binder reads it (`skills::form_runner::bind_in`):
/// a named point, or a slot argument as each slot's `stand` point (the slot itself when it names none). Read from the
/// steps alone, so a form with a step not built yet (a sit) still counts its walk.
fn walk_points(entry: &replica::rules::json::Value) -> Vec<WalkPoint> {
    use replica::rules::json::Value as J;
    let mm = |def: Option<&J>, p: &str, role: Option<&str>| -> WalkPoint {
        let def = def.ok_or_else(|| format!("point-unknown {p}"))?;
        let at = def.get("at_mm").and_then(J::arr).unwrap_or(&[]);
        let um: Vec<i64> = at
            .iter()
            .filter_map(|v| match v {
                J::Int(n) => i64::try_from(*n).ok().map(|n| n * 1000),
                _ => None,
            })
            .collect();
        let role = role
            .or_else(|| def.get("role").and_then(J::str))
            .unwrap_or("none");
        match um[..] {
            [x, y, z] => Ok((
                p.to_owned(),
                role.to_owned(),
                replica::pose::Vec3::new(x, y, z),
            )),
            _ => Err(format!("point-unknown {p}")),
        }
    };
    let point = |p: &str| mm(entry.get("points").and_then(|ps| ps.get(p)), p, None);
    let slots = entry.get("slots").and_then(J::obj).unwrap_or(&[]);
    let mut out = Vec::new();
    for (_, f) in entry.get("forms").and_then(J::obj).unwrap_or(&[]) {
        for s in f.get("steps").and_then(J::arr).unwrap_or(&[]) {
            if s.get("step").and_then(J::str) != Some("walk_to") {
                continue;
            }
            let named = s.get("point").and_then(J::str);
            let arg = s.get("point").and_then(|p| p.get("arg")).and_then(J::str);
            match (named, arg) {
                (Some(p), _) => out.push(point(p)),
                (None, Some(a)) => {
                    let ty = f
                        .get("takes")
                        .and_then(|t| t.get(a))
                        .and_then(|t| t.get("type"))
                        .and_then(J::str);
                    if ty != Some("slot") {
                        out.push(Err("thing-argument".into()));
                        continue;
                    }
                    for (name, def) in slots {
                        out.push(match def.get("stand").and_then(J::str) {
                            Some(p) => point(p),
                            None => mm(Some(def), name, Some("slot")),
                        });
                    }
                }
                _ => out.push(Err("point-malformed".into())),
            }
        }
    }
    out
}

/// What [`measure`] counts: the points a form walks to, those a body can stand on, those it cannot (by `kind:point
/// (role, why)`, with each thing's id) and those that are none of the thing's own points (by `kind why`).
#[derive(Default)]
struct Measured {
    points: usize,
    standing: usize,
    cannot: BTreeMap<String, Vec<String>>,
    not_points: BTreeMap<String, usize>,
    /// C15 (#3447): of those it cannot stand on, the ones a body acts at from a place within reach, and the ones it
    /// does not (by `kind:point (role, why)`, with each thing's id).
    nearby: usize,
    still: BTreeMap<String, Vec<String>>,
}

impl Measured {
    fn cannot(&self, stand: bool) -> usize {
        self.cannot
            .iter()
            .filter(|(k, _)| k.contains("(stand,") == stand)
            .map(|(_, ids)| ids.len())
            .sum()
    }

    fn show(&self, when: &str) {
        println!(
            "{when}: points a form walks to {}; a body can stand on {}; cannot {} (stand points {}, other points {}); \
             not the thing's own point {}",
            self.points,
            self.standing,
            self.cannot(true) + self.cannot(false),
            self.cannot(true),
            self.cannot(false),
            self.not_points.values().sum::<usize>()
        );
        let still: usize = self.still.values().map(Vec::len).sum();
        println!(
            "  of those it cannot stand on: acted at from a place within reach {}; not {} (stand points {})",
            self.nearby,
            still,
            self.still
                .iter()
                .filter(|(k, _)| k.contains("(stand,"))
                .map(|(_, ids)| ids.len())
                .sum::<usize>()
        );
    }
}

/// How far today's engine looks for clear ground to act from, µm (`forms-adapter.ts`: `standableNearV1`, 16 rings of
/// 0.25 m).
const TODAY: i64 = 4_000_000;

/// For every point a form walks to on each of Eden's things with an entry in `found`, turned by the thing's
/// orientation as the world turns it ([`skills::form_runner::turn`]; not, when not `turned`), whether a body can
/// stand there: the point is carried up the tree to the first node a body stands on (the open ground, or a
/// building's floor) and placed on that node's ground as the walk cuts it ([`sim::walk::town::Town::relocate`]: a
/// body's radius and margin clear of every solid, `off-surface` when not).
fn measure(
    town: &mut sim::walk::town::Town,
    tree: &replica::tree::Tree,
    things: &std::collections::BTreeSet<Id>,
    found: &BTreeMap<String, replica::rules::json::Value>,
    turned: bool,
) -> Measured {
    use replica::pose::{Frame, Pose, Quat, Support, Vec3};
    use replica::world_model::{plain, show};
    let stand = |town: &sim::walk::town::Town, node: Id, at: Vec3| {
        let body = sim::mover::Body {
            id: Id::new(Scope([0xc1; 16]), 1).unwrap(),
            pose: Pose {
                frame: Frame { node, slot: None },
                position: at,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: node,
                    height: 0,
                },
            },
            linear: Vec3::ZERO,
            piece: 0,
            tri: 0,
        };
        town.relocate(&body).map(|_| ()).map_err(|r| r.name)
    };
    let mut m = Measured::default();
    for &id in things {
        let Some(n) = tree.handle(id).and_then(|h| tree.node(h)) else {
            continue;
        };
        let kind = plain(n.kind().as_str()).to_owned();
        let (Some(entry), Some(place), Some(parent)) = (found.get(&kind), n.place(), n.parent())
        else {
            continue;
        };
        let mut seen = std::collections::BTreeSet::new();
        for p in walk_points(entry) {
            let (point, role, at) = match p {
                Ok(p) => p,
                Err(why) => {
                    *m.not_points.entry(format!("{kind} {why}")).or_default() += 1;
                    continue;
                }
            };
            if !seen.insert((point.clone(), at)) {
                continue;
            }
            m.points += 1;
            // Turned as the world turns a run's points, then up the tree to the ground a body stands on.
            let mut steps = vec![skills::form_runner::Step::WalkTo {
                point: Name::new(&point).unwrap(),
                at,
                on: None,
            }];
            if turned {
                skills::form_runner::turn(&mut steps, place.orientation).unwrap();
            }
            let skills::form_runner::Step::WalkTo { at, .. } = steps[0] else {
                unreachable!()
            };
            let (mut at, mut on) = (place.position.plus(at).unwrap(), parent);
            let near = at;
            let why = loop {
                match stand(town, on, at) {
                    Err("no-surface") => {
                        let up = tree.node(tree.handle(on).unwrap()).unwrap();
                        let (Some(pl), Some(parent)) = (up.place(), up.parent()) else {
                            break Err("no-ground-above");
                        };
                        at = pl
                            .position
                            .plus(pl.orientation.rotate(at).unwrap())
                            .unwrap();
                        on = parent;
                    }
                    r => break r,
                }
            };
            let Err(why) = why else {
                m.standing += 1;
                continue;
            };
            let named = format!("{} by {}", show(id), blocked_by(tree, id, near));
            m.cannot
                .entry(format!("{kind}:{point} ({role}, {why})"))
                .or_default()
                .push(named.clone());
            // C15: the place within reach the walk goes to instead, and whether the walk's cut stands a body there.
            let reach = skills::form_runner::REACH;
            match town.view().stand_near(on, at, reach, None) {
                Some(p) if stand(town, on, p).is_ok() => m.nearby += 1,
                Some(_) => m
                    .still
                    .entry(format!(
                        "{kind}:{point} ({role}, place within reach off the cut)"
                    ))
                    .or_default()
                    .push(named),
                // Named by how far the nearest place is, out to today's approach (rings of 0.25 m out to 4 m).
                None => {
                    let far = match town.view().stand_near(on, at, TODAY, None) {
                        Some(p) if stand(town, on, p).is_ok() => {
                            let d = sim::spots::flat(p, at) / 100_000;
                            format!("the nearest {}.{} m away", d / 10, d % 10)
                        }
                        _ => "none within 4 m".to_owned(),
                    };
                    m.still
                        .entry(format!(
                            "{kind}:{point} ({role}, no place within {} mm; {far})",
                            reach / 1000
                        ))
                        .or_default()
                        .push(named)
                }
            }
        }
    }
    m
}

/// C13 (#3440) A2 and A3: every point a form walks to on Eden's things with an entry, as the entries are written and
/// as `worldd seed` imports them (each stand point moved clear of its own kind's solids,
/// [`import_eden::clear_stand_points`]), measured ([`measure`]). Prints the counts, the import report and, after it,
/// each kind's point a body still cannot stand on, with its things.
#[test]
#[ignore = "needs the generated Eden 2026 facts file (see the module doc)"]
fn a2_every_point_a_form_walks_to_on_eden_can_be_stood_on() {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(facts_path()).expect("the Eden facts file");
    let im = import_eden::load(&text).expect("Eden loads");
    let mut found = Vec::new();
    entries(Path::new(&format!("{root}/content/kinds")), &mut found);
    let written: BTreeMap<_, _> = found
        .iter()
        .map(|(k, v)| (replica::world_model::plain(k).to_owned(), v.clone()))
        .collect();
    let report = import_eden::clear_stand_points(&im, &mut found);
    let imported: BTreeMap<_, _> = found
        .into_iter()
        .map(|(k, v)| (replica::world_model::plain(&k).to_owned(), v))
        .collect();
    let things: std::collections::BTreeSet<Id> = im.nodes.values().copied().collect();
    // The tree the points are read from: a second load, as the town takes the first.
    let tree = import_eden::load(&text).expect("Eden loads").tree;
    let header = import_eden::header(im.nodes["world"], &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let mut town = sim::walk::town::Town::new(
        im.tree,
        im.nodes["ground"],
        sim::links::Doors::new(header, im.rules, next),
    )
    .expect("the town");

    let unturned = measure(&mut town, &tree, &things, &written, false);
    let before = measure(&mut town, &tree, &things, &written, true);
    let after = measure(&mut town, &tree, &things, &imported, true);
    unturned.show("as written, the points not turned (C12)");
    before.show("as written, turned");
    println!("the import report ({} lines):", report.len());
    for line in &report {
        println!("  {line}");
    }
    after.show("as imported");
    for (k, ids) in &after.cannot {
        // Grouped by what keeps a body off: the blocker's kind, each thing named.
        let mut by: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for i in ids {
            let (thing, why) = i.split_once(" by ").unwrap();
            let what = why.rsplit_once(" cd:").map_or(why, |(w, _)| w);
            by.entry(what.to_owned())
                .or_default()
                .push(thing.to_owned());
        }
        println!("  cannot: {k}: {}", ids.len());
        for (what, things) in by {
            println!("    {what}: {} {}", things.len(), things.join(" "));
        }
    }
    for (k, ids) in &after.still {
        println!("  not within reach: {k}: {}", ids.len());
        let mut by: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for i in ids {
            let (thing, why) = i.split_once(" by ").unwrap();
            let what = why.rsplit_once(" cd:").map_or(why, |(w, _)| w);
            by.entry(what.to_owned())
                .or_default()
                .push(thing.to_owned());
        }
        for (what, things) in by {
            println!("    {what}: {} {}", things.len(), things.join(" "));
        }
    }
    for (k, n) in &after.not_points {
        println!("  not its own point: {k}: {n}");
    }
    assert_eq!(after.points, before.points);
    assert!(after.cannot(true) < before.cannot(true));
}

/// Whether node `n`'s own solids (field 12, its frame), carried into its parent's frame by its place (or not, when
/// `own_frame`), keep a body from standing at `at` (µm, that frame): a box that meets a body's height span, grown by
/// `import_eden::STAND_CLEAR` (the walk's cut, with its rounding).
fn solids_block(n: &replica::tree::NodeRef<'_>, at: replica::pose::Vec3, own_frame: bool) -> bool {
    use replica::pose::{Quat, Vec3};
    let Some(Value::Array(rows)) = n.fields().get(&import_eden::F_SOLIDS) else {
        return false;
    };
    let place = n.place();
    let num = |v: &Value| match v {
        Value::Uint(u) => *u as i64,
        Value::Nint(u) => -(*u as i64) - 1,
        _ => 0,
    };
    let grow = (import_eden::STAND_CLEAR * 1000) as f64;
    rows.iter().any(|r| {
        let Value::Array(r) = r else { return false };
        let s: Vec<i64> = r.iter().map(num).collect();
        let [cx, cz, hx, hz, yaw, y0, y1, ..] = s[..] else {
            return false;
        };
        if y1 <= 220 || y0 >= 1_800 {
            return false;
        }
        let turn = Quat::from_yaw_mdeg(yaw).unwrap();
        let ring: Vec<[f64; 2]> = [(-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz)]
            .iter()
            .map(|&(u, v)| {
                let mut p = turn
                    .rotate(Vec3::new(u * 1000, 0, v * 1000))
                    .unwrap()
                    .plus(Vec3::new(cx * 1000, 0, cz * 1000))
                    .unwrap();
                if let (Some(pl), false) = (place, own_frame) {
                    p = pl.position.plus(pl.orientation.rotate(p).unwrap()).unwrap();
                }
                [p.x as f64, p.z as f64]
            })
            .collect();
        let q = [at.x as f64, at.z as f64];
        // Inside the box, or within the growth of one of its edges.
        let cross = |a: [f64; 2], b: [f64; 2]| {
            (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])
        };
        let sides: Vec<f64> = (0..4).map(|i| cross(ring[i], ring[(i + 1) % 4])).collect();
        let inside = sides.iter().all(|&c| c >= 0.0) || sides.iter().all(|&c| c <= 0.0);
        inside
            || (0..4).any(|i| {
                let (a, b) = (ring[i], ring[(i + 1) % 4]);
                let (dx, dz) = (b[0] - a[0], b[1] - a[1]);
                let t = (((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / (dx * dx + dz * dz).max(1.0))
                    .clamp(0.0, 1.0);
                let (ex, ez) = (a[0] + t * dx - q[0], a[1] + t * dz - q[1]);
                (ex * ex + ez * ez).sqrt() < grow
            })
    })
}

/// Why a body cannot stand at `at` (µm, in the frame of thing `id`'s parent): the first solid found within a body's
/// clearance, the thing's own, then each other thing on its level and on each level above (a room's things, its
/// building, the open ground's things), or none (off the walked ground: water, a steep slope, a ledge).
fn blocked_by(tree: &replica::tree::Tree, id: Id, mut at: replica::pose::Vec3) -> String {
    use replica::world_model::{plain, show};
    let me = tree.node(tree.handle(id).unwrap()).unwrap();
    if solids_block(&me, at, false) {
        return "its own solids".into();
    }
    let mut level = me.parent().unwrap();
    for _ in 0..4 {
        let h = tree.handle(level).unwrap();
        for &c in tree.children(h).unwrap_or(&[]) {
            let c = tree.node(c).unwrap();
            if c.id() != id && solids_block(&c, at, false) {
                return format!("{} {}", plain(c.kind().as_str()), show(c.id()));
            }
        }
        let l = tree.node(h).unwrap();
        if solids_block(&l, at, true) {
            return format!("its {} {}", plain(l.kind().as_str()), show(level));
        }
        let (Some(pl), Some(up)) = (l.place(), l.parent()) else {
            break;
        };
        at = pl
            .position
            .plus(pl.orientation.rotate(at).unwrap())
            .unwrap();
        level = up;
    }
    "no solid: off the walked ground".into()
}

/// C22 (#3485): a Soul born at `at` (`x,z` m) does `verb` (an Eden form by its own entry) at thing `today` (today's id):
/// the receipt's entries (world time, events), printed, and the act's answer.
fn act_at(at: &str, today: &str, verb: &str, tag: &str) -> Result<Vec<u64>, String> {
    act_in(&facts_path(), at, today, verb, tag)
}

/// [`act_at`] on the facts file `facts`.
fn act_in(facts: &str, at: &str, today: &str, verb: &str, tag: &str) -> Result<Vec<u64>, String> {
    let im = import_eden::load(&std::fs::read_to_string(facts).unwrap()).expect("Eden loads");
    let thing = im.nodes[today];
    let (served, mut soul, dir) = serve(facts, at, tag, im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    let done = soul.act(verb, Some(thing), BTreeMap::new());
    println!("{verb} at {today}: {done:?}");
    if let Some(b) = track(&dir).last() {
        println!("  the body at the end: ({:.3}, {:.3}) m", b.2, b.3);
    }
    let entries = receipt_entries(&dir, done.as_deref().unwrap_or(&[]));
    for (at, names, _) in &entries {
        println!("  {at} µs: {names:?}");
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    done
}

/// C22 (#3485) A1: born outside the hall's front door, a Soul walks to the arcade cabinet in its bar (today's
/// e_263477b5) and plays it by its own entry (`play`: a walk to `player`, a press at `joystick`, 60 s): a press is
/// measured to the joystick or the cabinet's nearest surface, not its origin, and the act ends `done`.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c22_a1_the_arcade_cabinets_play_ends_done() {
    act_at("297.5,-14.0", "e_263477b5", "eden:play", "c22a1").expect("played, done");
}

/// C22 (#3485) A2: born outside the library's door, a Soul walks to the reading room's desk (today's e_0f7fb44b) and
/// writes at it by its own entry (`write`: a walk to `front`, a slide at `top`, 60 s, the page count up by one).
/// C18 (#3454): a chair stands in front of every desk on Eden (here e_975f923a), so the desk's `front` is at its front
/// left corner, beside the chair (`content/kinds/furniture/desk.json`), and the write ends `done` on Eden as it is.
/// Before C18, `front` was where the chair stands: the walk stopped behind the chair, 1.3 m from the desk's edge, and
/// the slide ended `out-of-reach`.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c22_a2_the_desks_write_ends_done() {
    act_at("74.0,-1.0", "e_0f7fb44b", "eden:write", "c22a2").expect("written, done");
}

/// How one form of a sweep ended ([`sweep`]): `done`, `refused <name>` at its start, `failed <name>` by its run's
/// ending, or `never-ended` past its deadline.
fn ending(r: Result<String, String>) -> String {
    match r {
        Ok(how) if how == "done" => how,
        Ok(how) => format!("failed {how}"),
        Err(name) => format!("refused {name}"),
    }
}

/// C22 (#3485) A3: every form an act starts (`starts: act`) of every entry in `content/kinds` that has a thing on
/// Eden, run once on the first such thing (by today's id), by a body set down at the form's stand point (its first
/// walk's point, else the thing's first `stand` point, else the thing's own place; the nearest clear place within a
/// form's reach when a body cannot stand there), through worldd's own form runner ([`worldd::acts::Acts`]) and
/// bodies, as `worldd seed` and `worldd serve` build them (stand points cleared, seats registered), in world time
/// stepped 50 ms a tick. A slot argument is given slot 1; a thing argument is not given. What a run writes is not
/// applied, so each form runs on Eden as seeded. Each form's body is taken out after it. Returns each ending with
/// its forms (`kind form thing`), and the entries with no thing on Eden.
fn sweep() -> (BTreeMap<String, Vec<String>>, Vec<String>) {
    use replica::pose::{Frame, Quat, Vec3};
    use replica::rules::json::Value as J;
    use replica::world_model::{plain, show};
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(facts_path()).expect("the Eden facts file");
    let im = import_eden::load(&text).expect("Eden loads");
    let mut found = Vec::new();
    entries(Path::new(&format!("{root}/content/kinds")), &mut found);
    import_eden::clear_stand_points(&im, &mut found);
    let tree = import_eden::load(&text).expect("Eden loads").tree;
    let (world, ground) = (im.nodes["world"], im.nodes["ground"]);
    let header = import_eden::header(world, &im.rules).unwrap();
    let mut things: BTreeMap<String, Id> = BTreeMap::new();
    for &id in im.nodes.values() {
        if let Some(n) = tree.handle(id).and_then(|h| tree.node(h)) {
            things
                .entry(plain(n.kind().as_str()).to_owned())
                .or_insert(id);
        }
    }
    let next = im.tree.to_state().next;
    let town = sim::walk::town::Town::new(
        im.tree,
        ground,
        sim::links::Doors::new(header.clone(), im.rules, next),
    )
    .expect("the town");
    let mut bodies = worldd::bodies::Bodies::new(town, 50_000).unwrap();
    // The seats, as `worldd serve` registers them: a stand point a body cannot stand on moved within reach.
    let (seats, _) = import_eden::body_slots(&bodies.town.tree, &found);
    for s in &seats {
        let view = bodies.town.view();
        let Some((floor, point, facing)) = view.on_floor(s.thing, s.at) else {
            continue;
        };
        let mut place = sim::slots::PlaceAt {
            thing: s.thing,
            place: replica::moves::Place {
                slot: s.slot,
                height: s.at.y.max(0),
                stand: [s.stand.x - s.at.x, s.stand.z - s.at.z],
            },
            point,
            facing,
            floor,
        };
        let stand = place.stand().map(|p| Vec3::new(p.x, point.y - s.at.y, p.z));
        let [w, x, y, z] = facing.parts();
        let back = Quat::new(w, -x, -y, -z);
        if let (Ok(stand), Ok(back)) = (stand, back)
            && view.stand_near(floor, stand, 1, None).is_none()
            && let Some(clear) = view.stand_near(floor, stand, skills::form_runner::REACH, None)
            && let Ok(d) = back.rotate(Vec3::new(clear.x - point.x, 0, clear.z - point.z))
        {
            place.place.stand = [d.x, d.z];
        }
        let _ = bodies.add_place(place);
    }
    let family = {
        use replica::bodies::{Class, Family, Resource};
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
                r("souls:eyes", Class::Gaze, None),
                r("souls:voice", Class::Voice, None),
            ],
        }
    };
    let mut acts = worldd::acts::Acts::new(
        replica::rules::json::Value::Obj(found.clone()),
        worldd::acts::library().expect("the moves"),
        header,
        Scope([0xc2; 16]),
    );
    let (mut now, mut tick, mut n) = (1_000_000_000_i64, 0u64, 0u64);
    bodies.begin(now);
    let (mut out, mut absent): (BTreeMap<String, Vec<String>>, Vec<String>) = Default::default();
    for (kind, entry) in &found {
        let Some(&thing) = things.get(plain(kind)) else {
            absent.push(kind.clone());
            continue;
        };
        let point = |p: &str| -> Option<Vec3> {
            let at = entry.get("points")?.get(p)?.get("at_mm")?.arr()?;
            let mm: Vec<i64> = at
                .iter()
                .filter_map(|v| match v {
                    J::Int(n) => i64::try_from(*n).ok(),
                    _ => None,
                })
                .collect();
            match mm[..] {
                [x, y, z] => Some(Vec3::new(x * 1000, y * 1000, z * 1000)),
                _ => None,
            }
        };
        let first_stand = entry.get("points").and_then(J::obj).and_then(|ps| {
            ps.iter()
                .find(|(_, d)| d.get("role").and_then(J::str) == Some("stand"))
                .map(|(p, _)| p.clone())
        });
        for (form, f) in entry.get("forms").and_then(J::obj).unwrap_or(&[]) {
            if f.get("starts").and_then(J::str) != Some("act") {
                continue;
            }
            let label = format!("{} {form} {}", plain(kind), show(thing));
            let walk = f
                .get("steps")
                .and_then(J::arr)
                .unwrap_or(&[])
                .iter()
                .find(|s| s.get("step").and_then(J::str) == Some("walk_to"))
                .and_then(|s| s.get("point").and_then(J::str).map(str::to_owned))
                // A slot named as the walk's point (C25): its stand point.
                .map(|p| {
                    let stand = entry.get("slots").and_then(|ss| ss.get(&p));
                    match stand.and_then(|d| d.get("stand")).and_then(J::str) {
                        Some(s) => s.to_owned(),
                        None => p,
                    }
                });
            let at = walk
                .or_else(|| first_stand.clone())
                .and_then(|p| point(&p))
                .unwrap_or(Vec3::ZERO);
            let view = bodies.town.view();
            let Some((floor, at, _)) = view.on_floor(thing, at) else {
                out.entry("no floor under the thing".into())
                    .or_default()
                    .push(label);
                continue;
            };
            // Within a form's reach, else out to today's 4 m (C13's `TODAY`): a body set down where it can stand.
            let at = view
                .stand_near(floor, at, skills::form_runner::REACH, None)
                .or_else(|| view.stand_near(floor, at, TODAY, None))
                .unwrap_or(at);
            n += 1;
            let body = Id::new(Scope([0xc1; 16]), 1000 + n).unwrap();
            let frame = Frame {
                node: floor,
                slot: None,
            };
            let placed = bodies.town.surfaces[&floor].place(body, frame, at, Quat::IDENTITY);
            let Ok(placed) = placed else {
                out.entry("no place to stand".into())
                    .or_default()
                    .push(label);
                continue;
            };
            bodies.add_body(family.clone(), placed).unwrap();
            let mut args = worldd::acts::Args::default();
            for (a, t) in f.get("takes").and_then(J::obj).unwrap_or(&[]) {
                if t.get("type").and_then(J::str) == Some("slot") {
                    args.slots.insert(a.clone(), 1);
                }
            }
            let id = Id::new(Scope([0xc3; 16]), n).unwrap();
            let intent =
                worldd::acts::intent(id, now + 3_600_000_000, Actor::Soul(body), label.as_bytes());
            let started = acts.start(
                &tree,
                Some(&mut bodies),
                body,
                &[(thing, form.clone())],
                &args,
                intent,
                tick,
                now,
            );
            let how = match started {
                Err(r) => Err(r.name.to_owned()),
                Ok(sim::forms::Asked::Applied(_)) => Ok("done".to_owned()),
                Ok(sim::forms::Asked::Started(run) | sim::forms::Asked::Running(run)) => {
                    let due = acts.forms.due(run).unwrap_or(now) + 1_000_000;
                    let mut how = None;
                    while how.is_none() && now <= due {
                        now += 50_000;
                        tick += 1;
                        let _ = bodies.step(now);
                        acts.tick(&tree, Some(&mut bodies), tick, now);
                        let _ = acts.out();
                        how = acts
                            .ended()
                            .into_iter()
                            .find(|(i, _, _)| *i == id)
                            .map(|e| e.1);
                    }
                    Ok(how.unwrap_or_else(|| "never-ended".to_owned()))
                }
            };
            // The body out, and its seat freed, before the next form.
            let _ = bodies.slots.release_body(body);
            bodies.runner.controller.remove(body);
            out.entry(ending(how)).or_default().push(label);
        }
    }
    (out, absent)
}

/// C22 (#3485) A3: the sweep ([`sweep`]): the count of each ending, then each form that did not end `done`, by
/// ending.
#[test]
#[ignore = "needs the generated Eden 2026 facts file (see the module doc)"]
fn c22_a3_every_form_of_every_eden_entry_runs_once_from_its_stand_point() {
    let (out, absent) = sweep();
    let all: usize = out.values().map(Vec::len).sum();
    let kinds: std::collections::BTreeSet<&str> = out
        .values()
        .flatten()
        .filter_map(|l| l.split(' ').next())
        .collect();
    println!(
        "C22 sweep: {all} forms of {} entries with a thing on Eden; {} entries with none",
        kinds.len(),
        absent.len()
    );
    for (how, forms) in &out {
        println!("  {how}: {}", forms.len());
    }
    for (how, forms) in out.iter().filter(|(h, _)| *h != "done") {
        println!("{how} ({}):", forms.len());
        for f in forms {
            println!("    {f}");
        }
    }
    assert!(out.contains_key("done"));
}

/// C23 (#3494): form `form` of the entry in file `file` (under `entries`) given `edit`, or added by it.
fn edit_form(
    entries: &Path,
    file: &str,
    form: &str,
    edit: impl FnOnce(&mut Vec<(String, replica::rules::json::Value)>),
) {
    use replica::rules::json::{Value as J, parse};
    let path = entries.join(file);
    let mut e = parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let J::Obj(o) = &mut e else {
        panic!("{file}: an entry")
    };
    let Some((_, J::Obj(forms))) = o.iter_mut().find(|(k, _)| k == "forms") else {
        panic!("{file}: forms")
    };
    match forms.iter_mut().find(|(k, _)| k == form) {
        Some((_, J::Obj(f))) => edit(f),
        _ => {
            let mut f = Vec::new();
            edit(&mut f);
            forms.push((form.to_owned(), J::Obj(f)));
        }
    }
    std::fs::write(&path, e.to_json()).unwrap();
}

/// C23 (#3494) A2: a move with no `at`, and a move `toward` or `at` a thing argument, each end `done` on a seeded Eden
/// by a Soul born beside Eden's gym yoga mat (today's e_ea2c84ac), the receipt printed:
///
/// - the yoga mat's own `yoga` (a walk to `middle`, then a `stretch`, no `at`), with its `link` effect left out of the
///   served entries (effects are C24's);
/// - the park swings' (e_7dacb4f7, 19 m away) `push`, a press `toward` its `who` argument, here the yoga mat, with its
///   walk to the argument left out (a walk to a thing argument is C25's): the press reaches the mat, not the swings;
/// - the same swings given the humanoid's own `touch` (a touch `at` its `target` argument), at the yoga mat, its walk
///   to the argument left out too.
///
/// Without the argument the push is refused `arg-missing`; toward the swings themselves it ends `out-of-reach`.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c23_a2_moves_with_no_at_and_toward_or_at_an_argument_end_done() {
    use replica::rules::json::{Value as J, parse};
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let entries = std::env::temp_dir().join(format!("eden-c23-kinds-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&entries);
    copy_dir(Path::new(&format!("{root}/content/kinds")), &entries);
    edit_form(&entries, "floors/yoga_mat.json", "yoga", |f| {
        f.retain(|(k, _)| k != "effects")
    });
    let no_walk = |f: &mut Vec<(String, J)>| {
        let Some((_, J::Arr(steps))) = f.iter_mut().find(|(k, _)| k == "steps") else {
            panic!("steps")
        };
        steps.retain(|s| s.get("step").and_then(J::str) != Some("walk_to"));
    };
    edit_form(&entries, "play/swings.json", "push", no_walk);
    let body =
        parse(&std::fs::read_to_string(entries.join("body/humanoid.json")).unwrap()).unwrap();
    let Some(J::Obj(touch)) = body.get("forms").and_then(|f| f.get("touch")).cloned() else {
        panic!("the humanoid's touch")
    };
    edit_form(&entries, "play/swings.json", "touch", |f| {
        *f = touch;
        no_walk(f);
    });
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (mat, swings) = (im.nodes["e_ea2c84ac"], im.nodes["e_7dacb4f7"]);
    let (served, mut soul, dir, _) = serve_entries(
        &facts,
        entries.to_str().unwrap(),
        "1.0,88.0",
        "c23a2",
        im.nodes["world"].scope(),
    );
    soul.0
        .set_read_timeout(Some(Duration::from_secs(120)))
        .unwrap();
    let mut each = |verb: &str, at: Id, a: BTreeMap<u64, Value>| {
        let done = soul.act(verb, Some(at), a);
        println!("{verb}: {done:?}");
        for (at, names, _) in receipt_entries(&dir, done.as_deref().unwrap_or(&[])) {
            println!("  {at} µs: {names:?}");
        }
        done
    };
    let yoga = each("eden:yoga", mat, BTreeMap::new());
    let missing = each("eden:push", swings, BTreeMap::new());
    let push = each("eden:push", swings, args(&[("who", mat.to_value())]));
    let far = each("eden:push", swings, args(&[("who", swings.to_value())]));
    let touch = each("eden:touch", swings, args(&[("target", mat.to_value())]));
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&entries);
    yoga.expect("a stretch, no at: done");
    assert_eq!(missing, Err("arg-missing".to_owned()));
    push.expect("a press toward the argument: done");
    assert_eq!(
        far,
        Err("out-of-reach".to_owned()),
        "toward the swings, 19 m off"
    );
    touch.expect("a touch at the argument: done");
}

/// C25 (#3496): the Eden facts file with `things` added (`(today's id, def, [x, y, z] mm, yaw mdeg)`, each on the open
/// ground) and their kinds; its path. Eden has no exercise chair, meditation mat or juggling balls, whose forms
/// rise, settle and use a held thing.
fn facts_with(things: &[(&str, &str, [i64; 3], i64)], tag: &str) -> String {
    use replica::rules::json::{Value as J, parse};
    let mut facts = parse(&std::fs::read_to_string(facts_path()).unwrap()).unwrap();
    let int = |n: i64| J::Int(n.into());
    if let J::Obj(o) = &mut facts {
        for (key, v) in o.iter_mut() {
            match (key.as_str(), v) {
                ("kinds", J::Arr(kinds)) => {
                    for (_, def, ..) in things {
                        let plain = def.split('@').next().unwrap();
                        let row = format!(
                            r#"{{"ref":"{def}","hash":"{}","name":"core:{}","form":"point","layer":"solid","door":false,"mesh":false,"slots":1}}"#,
                            "c25".repeat(21) + "c",
                            plain.trim_start_matches("core-")
                        );
                        kinds.push(parse(&row).unwrap());
                    }
                }
                ("things", J::Arr(rows)) => {
                    for (id, def, at, yaw) in things {
                        let pose = J::Arr(vec![int(at[0]), int(at[1]), int(at[2]), int(*yaw)]);
                        rows.push(J::Obj(vec![
                            ("id".into(), J::Str((*id).into())),
                            ("def".into(), J::Str((*def).into())),
                            ("ref".into(), J::Str((*def).into())),
                            ("parent".into(), J::Null),
                            ("pose".into(), pose.clone()),
                            ("world".into(), pose),
                            ("scale_ppm".into(), int(1_000_000)),
                            ("name".into(), J::Str(format!("c25-{id}"))),
                        ]));
                    }
                }
                _ => {}
            }
        }
    }
    let path = std::env::temp_dir().join(format!("eden-{tag}-{}.facts.json", std::process::id()));
    std::fs::write(&path, facts.to_json()).unwrap();
    path.to_str().unwrap().to_owned()
}

/// C25 (#3496) A2, A3: born outside the crossroads pub's front door, on Eden with an exercise chair, a meditation mat
/// and juggling balls set down beside it, a Soul does each by its own entry, in turn: the chair's `rises_3` (a walk to
/// its `seat`, a slot named as the walk's point, so to the seat's `front` stand point; then sit, rise three times),
/// the mat's `meditate` (a walk to `centre`, settle sitting on the ground, 30 s, rise) and the balls' `juggle`
/// (`use_held`, then 20 s): the first two end `done`, each receipt printed; the juggle ends `not-held`, as no Eden
/// form puts the balls in a hand.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c25_a2_a3_a_slot_walked_to_rise_settle_and_use_held_on_eden() {
    let facts = facts_with(
        &[
            (
                "e_c2500001",
                "core-exercise_chair@1",
                [300_000, 347, -14_000],
                0,
            ),
            (
                "e_c2500002",
                "core-meditation_mat@1",
                [300_000, 347, -10_500],
                0,
            ),
            (
                "e_c2500003",
                "core-juggling_balls@1",
                [300_000, 347, -17_000],
                0,
            ),
        ],
        "c25",
    );
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (served, mut soul, dir) = serve(&facts, "297.5,-14.0", "c25", im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    let mut out = Vec::new();
    for (today, verb) in [
        ("e_c2500001", "eden:rises_3"),
        ("e_c2500002", "eden:meditate"),
        ("e_c2500003", "eden:juggle"),
    ] {
        let done = soul.act(verb, Some(im.nodes[today]), BTreeMap::new());
        println!("{verb} at {today}: {done:?}");
        if let Some(b) = track(&dir).last() {
            println!("  the body after: ({:.3}, {:.3}) m", b.2, b.3);
        }
        for (at, names, _) in receipt_entries(&dir, done.as_deref().unwrap_or(&[])) {
            println!("  {at} µs: {names:?}");
        }
        out.push(done);
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_file(&facts);
    assert!(out[0].is_ok(), "rises_3 done: {:?}", out[0]);
    assert!(out[1].is_ok(), "meditate done: {:?}", out[1]);
    assert_eq!(out[2], Err("not-held".to_owned()), "juggle: not held");
}

/// C28 (#3541) A2: from C21's original house court, the same-ground form walk keeps its door crossings and reaches
/// the street sandpit. Its own entry's walk and pause end done, through the world's gateway framing.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c28_a2_from_the_house_court_build_a_sandcastle_done() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let sandpit = im.nodes["e_1f394e0b"];
    let (served, mut soul, dir) = serve(&facts, "52.4,27.4", "c28a2", im.nodes["world"].scope());
    let built = soul.act("eden:build_sandcastle", Some(sandpit), BTreeMap::new());
    println!("from house 4's court (52.4, 27.4), build_sandcastle: {built:?}");
    let entries = receipt_entries(&dir, built.as_deref().unwrap_or(&[]));
    for (at, names, _) in &entries {
        println!("  {at} µs: {names:?}");
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    built.expect("walked from the court and built, done");
    assert!(
        entries
            .iter()
            .any(|(_, names, _)| names.iter().any(|n| n == answers::FORM_ENDED))
    );
}

/// C21 (#3484) A1, A3: C20's stall. A Soul born 40 m north of the street sandpit (today's e_1f394e0b, at (52.4, 67.4)
/// m, turned 17.2 degrees) builds a sandcastle by the sandpit's own entry (`build_sandcastle`: a walk to its `edge`,
/// then a 20 s pause). The act either ends `done` or `walk.blocked`, within 5 s of the walk's last progress.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c21_the_sandpit_walk_arrives_or_ends_blocked() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let sandpit = im.nodes["e_1f394e0b"];
    let (served, mut soul, dir) = serve(&facts, "52.4,27.4", "c21", im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(900)))
        .unwrap();
    let built = soul.act("eden:build_sandcastle", Some(sandpit), BTreeMap::new());
    println!("from 40 m north, build a sandcastle: {built:?}");
    let walked = track(&dir);
    let mut last: Option<(u64, f64, f64)> = None;
    for (tick, _, x, z) in &walked {
        if last.is_none_or(|(_, lx, lz)| (x - lx).hypot(z - lz) > 0.5) {
            println!("  tick {tick}: ({x:.2}, {z:.2})");
            last = Some((*tick, *x, *z));
        }
    }
    let (end, x, z) = walked.last().map(|b| (b.0, b.2, b.3)).unwrap();
    println!("  last tick {end}: ({x:.2}, {z:.2})");
    // Where it stopped, in the ground's frame: what keeps a body from standing there.
    let at = replica::pose::Vec3::new((x * 1e6) as i64, 0, (z * 1e6) as i64);
    println!("  there: {}", blocked_by(&im.tree, sandpit, at));
    // The tick it last came 0.25 m nearer the sandpit's edge, and the time from then to its end.
    let edge = (51.97, 68.79);
    let gap = |x: f64, z: f64| (x - edge.0).hypot(z - edge.1);
    let mut best = (f64::MAX, 0);
    for (tick, _, x, z) in &walked {
        if gap(*x, *z) < best.0 - 0.25 {
            best = (gap(*x, *z), *tick);
        }
    }
    let ticks = end - best.1;
    println!(
        "  last progress at tick {} ({:.2} m from the edge): {ticks} ticks before its end",
        best.1, best.0
    );
    // The act's ending entry, as the log holds it: how it ended, and what blocked it.
    let bytes = std::fs::read(dir.join("log")).unwrap();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            for v in e.events.unwrap_or_default() {
                if v.name.as_str() == answers::FORM_ENDED
                    && let Some(Value::Bytes(how)) = v.fields.get(&2)
                {
                    println!("  {}: {}", v.name.as_str(), String::from_utf8_lossy(how));
                }
            }
        }
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    match built {
        Ok(_) => {}
        Err(how) => assert!(how == "walk.blocked", "ended {how}"),
    }
    assert!(ticks <= 100, "ended within 5 s of its last progress");
}

/// C34 (#3599) A2: a building's named area resolves onto its own room and floor. Born outside, a Soul climbs a
/// lighthouse to its lantern room (today's e_edbbc6a7, four floors up) and a tower to its top room (e_36bd67b1, whose
/// top floor is 8.5 m up, not the 6.1 m the kind's area names), across the stairs, by their own entries; each ends
/// `done`. Before #3599 each ended `souls:no-way`: the area's point was carried up to the open ground, cut out under
/// the building.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c34_a2_a_lighthouse_and_a_tower_are_climbed_to_their_top_rooms() {
    let lantern = act_at("96.0,194.0", "e_edbbc6a7", "eden:climb", "c34lh");
    let top = act_at("69.0,26.0", "e_36bd67b1", "eden:climb", "c34tw");
    lantern.expect("the lighthouse climbed, done");
    top.expect("the tower climbed, done");
}

/// C34 (#3599) A2: the ground-floor areas of the sweep's other named forms resolve the same way. Born outside a chapel
/// (today's e_9b7418a3), a Soul enters its nave (the room named `nave`); born beside a greenhouse's vent pole inside it
/// (e_8b4c5e36: `open_vent` needs the pole within reach before it starts, so a Soul born outside is refused
/// `out-of-reach` before any walk), a Soul opens the vent from the `inside` area (no room of that name, the
/// greenhouse's only floor). Each ends `done`, where each ended `souls:no-way`.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c34_a2_a_greenhouses_vent_and_a_chapels_nave() {
    let open = act_at("70.2,35.3", "e_8b4c5e36", "eden:open_vent", "c34gh");
    let enter = act_at("279.0,110.0", "e_9b7418a3", "eden:enter", "c34ch");
    open.expect("the vent opened, done");
    enter.expect("the nave entered, done");
}

/// Every set of a course field on `punt` in the parts `records` hold: (world time µs, the course's shape and stations).
fn course_sets(records: &[Vec<u8>], punt: Id) -> Vec<(i64, u64, usize)> {
    use replica::effects::Change;
    let mut out = Vec::new();
    for r in records {
        let Ok(part) = Part::read(r) else { continue };
        for e in part.effects {
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    if let Change::Set {
                        node, field, to, ..
                    } = &c.change
                        && *node == punt
                        && *field == replica::schedule::F_COURSE
                    {
                        let c = replica::schedule::course::Course::read(to).expect("a course");
                        let shape = match c.shape {
                            sim::courses::Shape::Loop => 1,
                            sim::courses::Shape::ThereAndBack => 2,
                            sim::courses::Shape::Once => 3,
                        };
                        out.push((e.envelope.at, shape, c.stations.len()));
                    }
                }
            }
        }
    }
    out
}

/// The public stream's parts under `dir/views`, unpacked: each one's T6 part.
fn public_parts(dir: &Path) -> Vec<Vec<u8>> {
    use replica::stream::{Pointer, StreamPart};
    let world = replica::rules::json::parse(
        &std::fs::read_to_string(dir.join("views/world.json")).unwrap(),
    )
    .unwrap();
    let stream = dir.join(world.get("stream").and_then(|v| v.str()).unwrap());
    let pointer_bytes = std::fs::read(stream.join("pointer")).expect("the stream's pointer");
    let pointer = Pointer::read(&pointer_bytes).unwrap();
    let Value::Map(fields) = decode(&pointer_bytes).unwrap().value else {
        panic!("a pointer")
    };
    let parts = match fields.get(&8) {
        Some(Value::Bytes(g)) => stream.join("g").join(replica::encode::to_hex(g)),
        _ => stream,
    };
    (0..=pointer.newest.expect("a published part"))
        .map(|n| {
            StreamPart::read(&std::fs::read(parts.join(n.to_string())).unwrap())
                .unwrap()
                .part
        })
        .collect()
}

/// #3603: a Soul boards the commons pond's rowing punt at its plank in its boarding stop, rides its loop, steers it
/// over the pond, lands it, and gets off at the plank, through the gateway. Before boarding a steer is refused
/// `not-aboard`; on the water a rise is refused `boarding-frame-away` and the body stays seated; a steer with no point,
/// or 2 km away, is refused by name. The log and the public stream carry the punt's courses (its loop, the steer, the
/// way back, its loop again) and the rider in its seat.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn p1_a_soul_boards_rides_steers_and_lands_the_commons_punt() {
    use replica::sky::int;
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    // The commons shore pond's punt, the punt nearest (-57.5, -6.0) m, as the server's search placed it: its home, its
    // plank, its loop's period and start, from the lines `worldd serve` printed.
    let seen = |l: &str| -> Option<(u64, [f64; 4], i64, i64)> {
        let l = l
            .trim()
            .trim_start_matches("seed: ")
            .strip_prefix("punt: rowing-punt-")?;
        let (k, rest) = l.split_once(" on ")?;
        let nums: Vec<f64> = rest
            .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
            .filter_map(|w| w.parse().ok())
            .collect();
        let [.., hx, hz, px, pz, period, t0] = nums[..] else {
            return None;
        };
        Some((k.parse().ok()?, [hx, hz, px, pz], period as i64, t0 as i64))
    };
    // Born by the commons punt's plank: found from the seed's own lines.
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let seeded = std::process::Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["seed", "--facts", &facts, "--dir"])
        .arg(std::env::temp_dir().join(format!("eden-p1-probe-{}", std::process::id())))
        .args([
            "--entries",
            &format!("{root}/content/kinds"),
            "--souls",
            "0",
        ])
        .output()
        .unwrap();
    let probe = String::from_utf8_lossy(&seeded.stdout).to_string();
    let _ = std::fs::remove_dir_all(
        std::env::temp_dir().join(format!("eden-p1-probe-{}", std::process::id())),
    );
    let (k1, [hx, hz, px, pz], period, t0) = probe
        .lines()
        .filter_map(seen)
        .min_by_key(|(_, h, _, _)| (((h[0] + 57.5).abs() + (h[1] + 6.0).abs()) * 1000.0) as i64)
        .expect("a punt on Eden");
    let k = (k1 - 1) as usize;
    println!(
        "the commons punt: rowing-punt-{k1}, home ({hx:.1}, {hz:.1}) m, plank ({px:.2}, {pz:.2}) m, lap {:.1} s",
        period as f64 / 1e6
    );
    // Born 1 m east of the plank's dry end.
    let at = format!("{:.2},{:.2}", px - 1.0, pz);
    let (served, mut soul, dir, lines) = serve_lines(&facts, &at, "p1", lineage);
    let tag = format!("punt: rowing-punt-{} is ", k + 1);
    let shown = lines
        .iter()
        .find_map(|l| l.trim().strip_prefix(tag.as_str()).map(str::to_owned))
        .expect("the punt's id line");
    let counter: u64 = shown.split(':').nth(1).unwrap().parse().unwrap();
    let punt = Id::new(lineage, counter).unwrap();
    let point = |x: f64, z: f64| {
        BTreeMap::from([(
            1,
            Value::Array(vec![int((x * 1e6) as i64), int((z * 1e6) as i64)]),
        )])
    };
    let ashore = soul.act("carrier:steer", Some(punt), point(-59.8, 0.0));
    println!("steer from the bank: {ashore:?}");
    // Board in the punt's boarding stop (its first 30 s each lap): wait for the next when less than 20 s are left.
    let phase = |t: i64| (t - t0).rem_euclid(period);
    let p = phase(answers::now());
    if p > 10_000_000 {
        let wait = period - p + 500_000;
        println!(
            "waiting {:.1} s for the punt's boarding stop",
            wait as f64 / 1e6
        );
        std::thread::sleep(Duration::from_micros(wait as u64));
    }
    let boarded = soul.act("eden:row", Some(punt), args(&[("seat", Value::Uint(1))]));
    println!("board it by its own form: {boarded:?}");
    let seated_in = last_frames(&dir).into_values().find(|f| f.0 == punt);
    println!("the rider's frame: {seated_in:?}");
    // Ride the loop until the punt has left its stop.
    let p = phase(answers::now());
    if p < 32_000_000 {
        std::thread::sleep(Duration::from_micros((32_000_000 - p) as u64));
    }
    let away = soul.act("eden:rise", None, BTreeMap::new());
    println!("rise on the water: {away:?}");
    let no_point = soul.act("carrier:steer", Some(punt), BTreeMap::new());
    let far = soul.act("carrier:steer", Some(punt), point(1500.0, 1500.0));
    println!("steer with no point: {no_point:?}; 2 km away: {far:?}");
    let steered = soul.act("carrier:steer", Some(punt), point(-59.8, 0.0));
    println!("steer toward the pond's middle: {steered:?}");
    std::thread::sleep(Duration::from_secs(15));
    let landed = soul.act("carrier:land", Some(punt), BTreeMap::new());
    println!("land: {landed:?}");
    // Rowed back along its wake and round the rest of its lap to its home: get off once it stands there.
    let mut off = Err(String::new());
    for _ in 0..80 {
        std::thread::sleep(Duration::from_secs(3));
        off = soul.act("eden:rise", None, BTreeMap::new());
        if off.is_ok() {
            break;
        }
    }
    println!("rise at the plank: {off:?}");
    std::thread::sleep(Duration::from_secs(2));
    let stood = track(&dir).last().copied();
    println!("the body's last logged place: {stood:?}");
    let log = sim::log::recover(&std::fs::read(dir.join("log")).unwrap())
        .unwrap()
        .records;
    let logged = course_sets(&log, punt);
    println!("the punt's courses in the log (at, shape, stations): {logged:?}");
    let public = public_parts(&dir);
    let streamed = course_sets(&public, punt);
    let rider_rows = public
        .iter()
        .filter_map(|r| Part::read(r).ok())
        .filter_map(|p| p.rest.get(&answers::BODIES).cloned())
        .filter(|rows| match rows {
            Value::Array(rows) => rows
                .iter()
                .filter_map(worldd::bodies::read_row)
                .any(|(_, pose, _)| pose.frame.node == punt),
            _ => false,
        })
        .count();
    println!(
        "the public stream: {} parts, the punt's courses {streamed:?}, {rider_rows} parts with the rider in its seat",
        public.len()
    );
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(ashore, Err("not-aboard".to_owned()));
    boarded.expect("boarded at the plank by the punt's own form");
    assert!(
        matches!(seated_in, Some((n, Some(_))) if n == punt),
        "seated in the punt"
    );
    assert_eq!(away, Err("boarding-frame-away".to_owned()));
    assert_eq!(no_point, Err("steer-needs-a-point".to_owned()));
    assert_eq!(far, Err("out-of-bounds".to_owned()));
    steered.expect("steered");
    landed.expect("landed");
    off.expect("rose at the plank");
    let (_, node, x, z) = stood.expect("a place");
    assert_eq!(node, im.nodes["ground"], "on the ground again");
    let d = ((x - px).powi(2) + (z - pz).powi(2)).sqrt();
    assert!(d < 1.5, "at the plank: {d:.2} m from it");
    let shapes: Vec<u64> = logged.iter().map(|c| c.1).collect();
    assert_eq!(shapes, vec![3, 3, 1], "steered, landed, its own loop again");
    assert_eq!(streamed, logged, "the public stream carries every course");
    assert!(
        rider_rows > 0,
        "the public stream carries the rider in its seat"
    );
}
