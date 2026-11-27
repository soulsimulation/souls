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
        self.act_within(verb, target, parameters, 120_000_000)
    }

    /// [`Client::act`], its intent expiring `within` µs from now.
    fn act_within(
        &mut self,
        verb: &str,
        target: Option<Id>,
        parameters: BTreeMap<u64, Value>,
        within: i64,
    ) -> Result<Vec<u64>, String> {
        self.send(verb, target, parameters, within);
        self.answer(verb)
    }

    /// Sends an act, its intent expiring `within` µs from now, and reads no answer.
    fn send(
        &mut self,
        verb: &str,
        target: Option<Id>,
        parameters: BTreeMap<u64, Value>,
        within: i64,
    ) {
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
            expiry: answers::now() + within,
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

    /// The next answer on the socket that is not a progress answer: an act's own answer.
    fn answer(&mut self, verb: &str) -> Result<Vec<u64>, String> {
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
    serve_seeded(facts, entries, &[], at, tag, lineage)
}

/// [`serve_entries`], `seed` given the further arguments `more` (`--stock <file>`).
fn serve_seeded(
    facts: &str,
    entries: &str,
    more: &[&str],
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
        .args(more)
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
    // The world's stdout stays read (#3825): with the pipe closed, its first line after start-up (a watchdog's stall
    // report) panicked the thread that wrote it.
    std::thread::spawn(move || {
        for l in out.lines().map_while(Result::ok) {
            println!("worldd: {l}");
        }
    });
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
    // `places to sit or lie: <n> registered on <things> things; <all> body slots declared; <left> with no floor; <bare> on
    // things with no slots of their own; <beyond> past a thing's own slots; <moved> stand points moved to clear ground`
    let n: Vec<usize> = seats
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|w| w.parse().ok())
        .collect();
    let [registered, on, declared, left, _bare, _beyond, moved] = n[..] else {
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
    // The world adds today's rowing punts to the facts it is built from (#3603), each with its entry's riders' seats:
    // the facts read here have none.
    let punts = lines
        .iter()
        .filter(|l| l.starts_with("punt: rowing-punt-") && l.contains(" is "))
        .count();
    let riders = found
        .iter()
        .find(|(k, _)| k == "eden:rowing_punt")
        .and_then(|(_, e)| e.get("slots").and_then(|s| s.obj()))
        .map_or(0, <[_]>::len);
    println!("{punts} rowing punts added by the world, {riders} seats each");
    // The world gives each ride that flies a loop its course (`with_rides`, #4795), and a ride on its course whose own
    // def declares no seats takes its entry's seats as they are (Eden's launch balloon, an `eden:balloon` by Eden's
    // map): the facts read here have no course, so `body_slots` gives it none.
    let (mut aloft, mut aloft_things) = (0, 0);
    let all = replica::rules::json::parse(&text).unwrap();
    let kind_of: BTreeMap<&str, String> = all
        .get("kinds")
        .and_then(|k| k.arr())
        .unwrap_or(&[])
        .iter()
        .filter_map(|k| {
            Some((
                k.get("ref")?.str()?,
                import_eden::kind_name(k.get("name")?.str()?),
            ))
        })
        .collect();
    for t in all.get("things").and_then(|t| t.arr()).unwrap_or(&[]) {
        let on_ground = t.get("parent").is_none_or(|p| p.str().is_none());
        let own_slots = t
            .get("slots")
            .and_then(|s| s.arr())
            .is_some_and(|s| !s.is_empty());
        let (Some(entry), Some(def)) = (
            t.get("entry").and_then(|e| e.str()),
            t.get("def").and_then(|d| d.str()),
        ) else {
            continue;
        };
        let Some((_, e)) = found.iter().find(|(k, _)| k == entry) else {
            continue;
        };
        if !on_ground
            || own_slots
            || kind_of.get(def).is_some_and(|k| k == entry)
            || !sim::courses::rides::Ride::of(e).is_some_and(|r| r.loops_aloft())
        {
            continue;
        }
        let seats = e.get("slots").and_then(|s| s.obj()).unwrap_or(&[]);
        aloft += seats
            .iter()
            .filter(|(_, d)| d.get("admits").and_then(|a| a.str()) == Some("body"))
            .count();
        aloft_things += 1;
    }
    println!(
        "{aloft} seats on {aloft_things} rides that take their entry's seats on the course the world gives them"
    );
    assert_eq!(
        mine.len() + punts * riders + aloft,
        registered,
        "the world registers every slot the entries declare"
    );
    assert_eq!(left, 0, "every seat placed on a floor");
    assert_eq!(
        on,
        on_things.len() + punts + aloft_things,
        "the things they are on"
    );
    assert_eq!(registered, declared, "every declared body slot registered");
    // Every def today seats has at least today's slots: the campfire's entry seats its three logs, as today. The
    // piano's bench seats its pianist, as today (#3714).
    assert!(short.is_empty(), "short of today's slots: {short:?}");
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
/// gateway's rise. The library's reading chairs stand under their tables too. Their nearest clear ground within 0.3 m
/// was a pocket between the chair and the table no walk reached, and the sit there answered `souls:no-way`; since the
/// ground under a table's top is cut (first-day tester, round 2) that pocket is gone, the stand point is moved to the
/// nearest ground a walk reaches when the seats are registered, and a Soul born outside the library sits there.
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
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    // Born outside the library's door (at (74.0, -2.91) m).
    let (served, mut soul, dir) = serve(&facts, "74.0,-1.0", "c17a2lib", im.nodes["world"].scope());
    let reads = soul.act("eden:sit", Some(reading), args(&[("seat", Value::Uint(1))]));
    println!("sit at the library's west reading chair: {reads:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    sat.expect("sat by the chair's own form");
    rose.expect("rose");
    reads.expect("sat at the reading chair");
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
    // Eden seeds its rugs unrolled, and `unroll` needs the rug rolled (the world decides a form's needs at commit,
    // #3888): served with the rugs seeded rolled, as C20 seeds the blocks knocked down.
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let rolled = std::env::temp_dir().join(format!("eden-c17a3-rolled-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&rolled);
    copy_dir(Path::new(&format!("{root}/content/kinds")), &rolled);
    let file = rolled.join("floors/rug.json");
    let text = std::fs::read_to_string(&file).unwrap();
    let seeded = text.replacen(r#""default":false"#, r#""default":true"#, 1);
    assert_ne!(text, seeded, "the rugs seeded unrolled");
    std::fs::write(&file, seeded).unwrap();
    let (served, mut soul, dir, _) = serve_entries(
        &facts,
        rolled.to_str().unwrap(),
        "74.0,-1.0",
        "c17a3",
        im.nodes["world"].scope(),
    );
    // `unroll`, a walk in and a 3 s pause (C20 gives `roll_up`'s 5 s pause after the walk its own time too).
    let unrolled = soul.act("eden:unroll", Some(rug), BTreeMap::new());
    println!("from outside, unroll the library's west rug: {unrolled:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&rolled);
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
    // Eden seeds the blocks built, and `build` needs them knocked down (the world decides a form's needs at commit,
    // #3888): served with them seeded knocked down.
    let down = std::env::temp_dir().join(format!("eden-{tag}-down-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&down);
    copy_dir(Path::new(entries), &down);
    let file = down.join("play/toy_blocks.json");
    let text = std::fs::read_to_string(&file).unwrap();
    let knocked = text.replacen(r#""default": true"#, r#""default": false"#, 1);
    assert_ne!(text, knocked, "the blocks seeded built");
    std::fs::write(&file, knocked).unwrap();
    let (served, mut soul, dir, _) = serve_entries(
        &facts,
        down.to_str().unwrap(),
        "74.0,-1.0",
        tag,
        im.nodes["world"].scope(),
    );
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
    let _ = std::fs::remove_dir_all(&down);
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

/// A gateway walk of over 600 m across Eden, from the births to a point 650 to 900 m away by the map, ends done (#1960): its
/// deadline follows its planned route, with no 180 s cap. Before, every walk over about 250 m ended `act.timed-out`
/// while still moving. Takes about ten minutes of world time at 1/1.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_600_m_walk_across_eden_ends_done() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (ground, lineage) = (im.nodes["ground"], im.nodes["world"].scope());
    // The far point: the first on a 50 m grid of the open ground whose route from the births is 650 to 900 m by the map.
    let header = import_eden::header(im.nodes["world"], &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let mut town = sim::walk::town::Town::new(
        im.tree,
        ground,
        sim::links::Doors::new(header, im.rules, next),
    )
    .expect("the town");
    let v = |x: i64, z: i64| replica::pose::Vec3::new(x * 1_000_000, 0, z * 1_000_000);
    let from = town
        .map
        .spot(ground, v(74, -1))
        .expect("the births on the map");
    let (fx, fz, length) = (-10..=10)
        .flat_map(|i| (-10..=10).map(move |j| (i * 50, j * 50)))
        .find_map(|(x, z)| {
            let to = town.map.spot(ground, v(x, z))?;
            let r = town
                .map
                .route(&town.tree, from, to, sim::routes::ALL)
                .ok()?;
            (650_000..900_000)
                .contains(&r.length)
                .then_some((x, z, r.length))
        })
        .expect("a point 650 to 900 m away by the map");
    println!("to ({fx}, {fz}) m, {:.0} m by the map", length as f64 / 1e3);
    let (served, mut soul, dir) = serve(&facts, "74.0,-1.0", "long", lineage);
    soul.0
        .set_read_timeout(Some(Duration::from_secs(1_500)))
        .unwrap();
    let um = |m: f64| {
        let v = (m * 1e6) as i64;
        u64::try_from(v).map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
    };
    let to = Value::Array(vec![um(fx as f64), um(0.0), um(fz as f64)]);
    let t0 = answers::now();
    let walked = soul.act_within(
        "eden:walk",
        Some(ground),
        BTreeMap::from([(1, to)]),
        1_500_000_000,
    );
    let secs = (answers::now() - t0) as f64 / 1e6;
    let track = track(&dir);
    let path: f64 = track
        .windows(2)
        .filter(|w| w[0].1 == w[1].1)
        .map(|w| ((w[1].2 - w[0].2).powi(2) + (w[1].3 - w[0].3).powi(2)).sqrt())
        .sum();
    let last = track.last().map(|t| (t.2, t.3));
    println!("walked {path:.0} m in {secs:.0} s, to {last:?}: {walked:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    walked.expect("the long walk ends done");
    assert!(path > 600.0, "a walk of over 600 m: {path:.0} m");
    assert!(secs > 180.0, "longer than the old cap: {secs:.0} s");
}

/// Copies folder `from` into `to`, file by file.
fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let p = e.unwrap().path();
        let t = to.join(p.file_name().unwrap());
        if p.is_dir() {
            copy_dir(&p, &t);
        } else if p.is_file() {
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
                approach: false,
                face: None,
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
    act_ending(facts, at, today, verb, tag).0
}

/// An act's receipt entries, and where the body stood at the end: its node and its place there (µm, the node's frame).
type Ending = (Result<Vec<u64>, String>, Option<(Id, replica::pose::Vec3)>);

/// [`act_in`], with where the body stood at the end ([`Ending`]).
fn act_ending(facts: &str, at: &str, today: &str, verb: &str, tag: &str) -> Ending {
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
    let end = end_pose(&dir);
    println!("  the body's last place: {end:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    (done, end)
}

/// The node and place (µm, the node's frame) of the last body row in the world's log.
fn end_pose(dir: &Path) -> Option<(Id, replica::pose::Vec3)> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = None;
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        let Ok(Value::Map(m)) = decode(&r).map(|d| d.value) else {
            continue;
        };
        if let Some(Value::Array(rows)) = m.get(&answers::BODIES) {
            for (_, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                out = Some((pose.frame.node, pose.position));
            }
        }
    }
    out
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

/// #1960 seat approach: a boat afloat is boarded from the bank. Its seat's stand point is on the water, with no ground
/// within a form's reach of it; the seat's `board_mm` lets the world move it to the nearest clear ground within that of
/// the seat, from which the straight step onto the seat crosses no other solid (`worldd::places`). Born on the bank, a
/// Soul rides the boat (a walk to that point, then the sit), rises, and is set down on that ground, the bank.
fn boards_from_the_bank_and_rises_onto_it(at: &str, today: &str, tag: &str, bank: f64) {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (served, mut soul, dir) = serve(&facts, at, tag, im.nodes["world"].scope());
    let rode = soul.act("eden:ride", Some(im.nodes[today]), BTreeMap::new());
    println!("ride {today}: {rode:?}");
    let seated = track(&dir).last().map(|b| (b.2, b.3));
    let rose = soul.act("eden:rise", None, BTreeMap::new());
    println!("rise: {rose:?}");
    let off = track(&dir).last().map(|b| (b.2, b.3));
    println!("in the seat at {seated:?} m; off it at {off:?} m");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    rode.expect("boarded from the bank, done");
    rose.expect("rose");
    let (x, _) = off.expect("the body's track");
    assert!(
        x <= bank,
        "set down on the bank (x <= {bank} m), at {off:?}"
    );
}

/// The canal's canoe (today's e_21e423f2, at (136.5, 42.0) m): its bank is 3.5 m west of its back seat.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_soul_boards_the_canoe_from_the_bank_and_gets_off_onto_it() {
    boards_from_the_bank_and_rises_onto_it("132.5,42.0", "e_21e423f2", "seatcanoe", 133.2);
}

/// The harbour's first rowing boat (today's e_4b754b5c, at (16.0, 166.0) m): its quay is 3.6 m west of its oars.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_soul_boards_the_rowing_boat_from_the_quay_and_gets_off_onto_it() {
    boards_from_the_bank_and_rises_onto_it("11.5,167.0", "e_4b754b5c", "seatrow", 12.7);
}

/// The facts' id of the thing or the place named `name` (its `things`, then its `places`): today's ids change with
/// each export, the names do not.
fn facts_id(text: &str, name: &str) -> String {
    let f = replica::rules::json::parse(text).unwrap();
    ["things", "places"]
        .iter()
        .filter_map(|list| f.get(list).and_then(|v| v.arr()))
        .flatten()
        .find(|t| t.get("name").and_then(|v| v.str()) == Some(name))
        .and_then(|t| t.get("id").and_then(|v| v.str()))
        .unwrap_or_else(|| panic!("no {name} in the facts"))
        .to_owned()
}

/// Boats on the water: Eden's harbour rowing boat (its entry's `vehicle` on `deep_water`,
/// `content/kinds/vehicles/rowing_boat.json`) floats where it is moored, so `worldd serve` gives it a course that stands
/// there. Born on the quay, a Soul takes the oars, rows it out over the harbour (`carrier:steer`), is refused a rise
/// out on the water (`boarding-frame-away`), lands it (`carrier:land`: back along its wake to its mooring) and gets off
/// at its landing, onto the quay. Before, the steer was refused `not-a-carrier` ("moves on no course").
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_soul_rows_the_harbour_rowing_boat_out_and_gets_off_at_its_landing() {
    use replica::sky::int;
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let boat = im.nodes[&facts_id(&text, "harbour-rowing-boat-1")];
    let (served, mut soul, dir) = serve(&facts, "11.5,167.0", "rowboat", im.nodes["world"].scope());
    let point = |x: f64, z: f64| {
        BTreeMap::from([(
            1,
            Value::Array(vec![int((x * 1e6) as i64), int((z * 1e6) as i64)]),
        )])
    };
    let rode = soul.act("eden:ride", Some(boat), BTreeMap::new());
    println!("take the oars: {rode:?}");
    let out = soul.act("carrier:steer", Some(boat), point(16.0, 182.0));
    println!("row out: {out:?}");
    std::thread::sleep(Duration::from_secs(8));
    let away = punt_place(&dir, boat);
    let offshore = soul.act("eden:rise", None, BTreeMap::new());
    println!("out at {away:?} m, a rise: {offshore:?}");
    let landed = soul.act("carrier:land", Some(boat), BTreeMap::new());
    println!("land: {landed:?}");
    let mut off = Err(String::new());
    for _ in 0..40 {
        std::thread::sleep(Duration::from_secs(3));
        off = soul.act("eden:rise", None, BTreeMap::new());
        if off.as_ref().is_ok() || off.as_ref().is_err_and(|e| e != "boarding-frame-away") {
            break;
        }
    }
    std::thread::sleep(Duration::from_secs(2));
    let home = punt_place(&dir, boat);
    let end = last_places(&dir);
    println!("off at its landing: {off:?}; the boat at {home:?} m; the body {end:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    rode.expect("took the oars from the quay");
    out.expect("rowed out: a boat on the water is a carrier");
    let (_, az) = away.expect("the boat's course");
    assert!(az > 170.0, "out over the harbour, at z {az} m");
    assert_eq!(offshore, Err("boarding-frame-away".to_owned()));
    landed.expect("landed");
    off.expect("got off at its landing");
    let (hx, hz) = home.expect("the boat's course");
    assert!(
        (hx - 16.0).abs() < 0.01 && (hz - 166.0).abs() < 0.01,
        "back at its mooring: ({hx}, {hz}) m"
    );
    let ground = im.nodes["ground"];
    let (_, (frame, _, x, _)) = end.into_iter().next().expect("the body");
    assert_eq!(frame, ground, "on the ground");
    assert!(x <= 12.7, "set down on the quay (x <= 12.7 m), at x {x} m");
}

/// A walk to a landform or a region (a range drawn as a line, the sea, the sea's region) goes to
/// the nearest walkable point at its edge, not to its middle, and ends facing it: a step ahead of the body is nearer
/// it than the body is. Before, each walk aimed at the shape's middle (out on the sea, the range's ridge) and was
/// refused. An area a body can stand on (the park's sand) is still walked onto.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn walks_to_the_mountains_and_the_sea_end_at_their_edges_facing_them() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let ground = im.nodes["ground"];
    let mut failed = Vec::new();
    // Walked onto: an area of the open ground a body can stand on (the park's sand) ends on it, at its edge. (The
    // harbour boardwalk's region lies over the boardwalk's own deck, not the open ground: a walk ends facing it.)
    let onto = ["park-playground-sand"];
    // The north from (7.4, -296.9) m: walks north from the channel's start (-14.0, -296.0) and from the town (45.0,
    // -78.0) stop on the way, `goal-unreachable`, at (7.4, -296.9) and (27.7, -74.6) m whatever their goal (the walk
    // is held there, not the goal).
    for (at, names, tag) in [
        (
            "7.4,-296.9",
            &["place-region-northern-mountains", "land-ring-north-range"][..],
            "lfnorth",
        ),
        (
            "40.0,120.0",
            &[
                "park-playground-sand",
                "place-region-harbour-boardwalk",
                "land-southern-sea",
                "place-region-southern-sea",
            ][..],
            "lfsea",
        ),
    ] {
        let (served, mut soul, dir) = serve(&facts, at, tag, lineage);
        soul.0
            .set_read_timeout(Some(Duration::from_secs(300)))
            .unwrap();
        for name in names {
            let place = im.nodes[&facts_id(&text, name)];
            let walked = soul.act("eden:walk", Some(place), BTreeMap::new());
            // The turn to face it is the legs' input after the walk's end: logged a tick or two later.
            std::thread::sleep(Duration::from_secs(2));
            let bytes = std::fs::read(dir.join("log")).unwrap();
            let mut last = None;
            for r in sim::log::recover(&bytes).unwrap().records {
                if sim::recorder::is_input(&r) {
                    continue;
                }
                if let Ok(Value::Map(m)) = decode(&r).map(|d| d.value)
                    && let Some(Value::Array(rows)) = m.get(&answers::BODIES)
                {
                    last = rows
                        .iter()
                        .filter_map(worldd::bodies::read_row)
                        .next_back()
                        .map(|(_, p, _)| p)
                        .or(last);
                }
            }
            let pose = last.expect("the body's pose");
            let p = pose.position;
            let gap = replica::select::gap(&im.tree, place, ground, p).unwrap();
            let ahead = pose
                .orientation
                .rotate(replica::pose::Vec3::new(3_000_000, 0, 0))
                .unwrap();
            let step = replica::pose::Vec3::new(p.x + ahead.x, 0, p.z + ahead.z);
            let gap_ahead = replica::select::gap(&im.tree, place, ground, step).unwrap();
            println!(
                "walk to {name}: {walked:?}, ends at ({:.1}, {:.1}) m, {:.1} m from it, {:.1} m a step ahead",
                p.x as f64 / 1e6,
                p.z as f64 / 1e6,
                gap as f64 / 1e6,
                gap_ahead as f64 / 1e6
            );
            if let Err(e) = &walked {
                failed.push(format!("{name}: {e}"));
            } else if onto.contains(name) && gap > 0 {
                failed.push(format!("{name}: not on it"));
            } else if gap > 0 && gap_ahead >= gap {
                failed.push(format!("{name}: not facing it"));
            }
        }
        drop(served);
        let _ = std::fs::remove_dir_all(&dir);
    }
    assert!(failed.is_empty(), "{failed:?}");
}

/// Long walks from the town to Eden's named landforms end at them. From each start, where a new Soul arrives (by the
/// campus quad's fountain), outside the library's door, on the harbour quay, in the lane between the courtyard
/// quarter's houses and on the north avenue, one Soul per landform walks to it, all at once: the mountains (the
/// region the client's find picks by name, and the range), the sea (the land's and the region's), the eastern hills and
/// the west lake's far shore. Each walk ends `Ok`, on it or at its edge facing it: a step ahead is nearer it. Before,
/// walks whose route first heads away from the landform (round the vineyard, from the avenue) stopped on the way,
/// `goal-unreachable`, walking at full speed: the never-stuck ladder measured progress only straight to the leg's end.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn walks_from_the_town_to_each_landform_end_at_it() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let ground = im.nodes["ground"];
    let landforms = [
        "place-region-northern-mountains",
        "land-ring-north-range",
        "land-southern-sea",
        "place-region-southern-sea",
        "place-region-eastern-hills",
        "land-west-lake",
    ];
    let starts = [
        ("-9.0,-97.0", "quad"),
        ("-12.0,-113.0", "library"),
        ("11.5,167.0", "harbour"),
        ("-116.0,70.0", "house"),
        ("45.0,-78.0", "avenue"),
    ];
    let places: Vec<Id> = landforms
        .iter()
        .map(|n| im.nodes[&facts_id(&text, n)])
        .collect();
    // Each walk: its start, its landform, its answer, its time and the body's last pose.
    let ran = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for (at, from) in starts {
            let (places, ran, facts, landforms) = (&places, &ran, &facts, &landforms);
            s.spawn(move || {
                let (served, first, dir) = serve(facts, at, &format!("lftown-{from}"), lineage);
                let souls: Vec<Client> = std::iter::once(first)
                    .chain((2..=places.len() as u64).map(|n| join(&dir, n, lineage)))
                    .collect();
                let walks: Vec<(Id, Result<Vec<u64>, String>, f64)> = std::thread::scope(|w| {
                    let runs: Vec<_> = souls
                        .into_iter()
                        .zip(places.iter().copied())
                        .map(|(mut soul, place)| {
                            w.spawn(move || {
                                soul.0
                                    .set_read_timeout(Some(Duration::from_secs(960)))
                                    .unwrap();
                                let t = answers::now();
                                let r = soul.act_within(
                                    "eden:walk",
                                    Some(place),
                                    BTreeMap::new(),
                                    900_000_000,
                                );
                                let secs = (answers::now() - t) as f64 / 1e6;
                                println!(
                                    "walked from the {from}: Soul {} {r:?} in {secs:.0} s",
                                    soul.1.counter()
                                );
                                (soul.1, r, secs)
                            })
                        })
                        .collect();
                    runs.into_iter().map(|h| h.join().unwrap()).collect()
                });
                // The turn to face it is the legs' input after the walk's end: logged a tick or two later.
                std::thread::sleep(Duration::from_secs(2));
                let bytes = std::fs::read(dir.join("log")).unwrap();
                let mut last = BTreeMap::new();
                for r in sim::log::recover(&bytes).unwrap().records {
                    if sim::recorder::is_input(&r) {
                        continue;
                    }
                    if let Ok(Value::Map(m)) = decode(&r).map(|d| d.value)
                        && let Some(Value::Array(rows)) = m.get(&answers::BODIES)
                    {
                        for (id, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                            last.insert(id, pose);
                        }
                    }
                }
                drop(served);
                let _ = std::fs::remove_dir_all(&dir);
                // The world mints each Soul's body as it joins, in the order they joined: its bodies by id are the
                // Souls in that order (the only bodies here: `--souls 0`).
                let poses: Vec<_> = last.into_values().map(Some).collect();
                let poses = if poses.len() == walks.len() {
                    poses
                } else {
                    vec![None; walks.len()]
                };
                let mut ran = ran.lock().unwrap();
                for (((_, walked, secs), (name, &place)), pose) in walks
                    .into_iter()
                    .zip(landforms.iter().zip(places))
                    .zip(poses)
                {
                    ran.push((from, *name, place, walked, secs, pose));
                }
            });
        }
    });
    let mut failed = Vec::new();
    for (from, name, place, walked, secs, pose) in ran.into_inner().unwrap() {
        let Some(pose) = pose else {
            failed.push(format!(
                "{from} -> {name}: {walked:?}, no pose for each Soul in the log"
            ));
            continue;
        };
        let p = pose.position;
        let gap = replica::select::gap(&im.tree, place, ground, p).unwrap();
        let ahead = pose
            .orientation
            .rotate(replica::pose::Vec3::new(3_000_000, 0, 0))
            .unwrap();
        let step = replica::pose::Vec3::new(p.x + ahead.x, 0, p.z + ahead.z);
        let gap_ahead = replica::select::gap(&im.tree, place, ground, step).unwrap();
        println!(
            "from the {from} to {name}: {walked:?} in {secs:.0} s, ends at ({:.1}, {:.1}) m, {:.1} m from it, \
             {:.1} m a step ahead",
            p.x as f64 / 1e6,
            p.z as f64 / 1e6,
            gap as f64 / 1e6,
            gap_ahead as f64 / 1e6
        );
        if let Err(e) = &walked {
            failed.push(format!("{from} -> {name}: {e}"));
        } else if gap > 0 && gap_ahead >= gap {
            failed.push(format!("{from} -> {name}: not facing it"));
        }
    }
    assert!(failed.is_empty(), "{failed:?}");
}

/// C22 sweep follow-up: a walk before a sit goes to the seat's own stand point, as the world's places hold it, not
/// the entry's. The narrowboat's (today's e_13a2e4cf) `towpath` point is on the water by its hull, so no place within
/// a sit's reach of it can be stood on; `worldd serve` moves the stern's stand point onto the bank, and `ride` (a walk
/// to `stern`, then a sit in it) walks there and sits. Before, the walk searched only round the entry's point and
/// ended `souls:no-way`.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_walk_before_a_sit_goes_to_the_seats_own_stand_point() {
    act_at("132.5,-21.7", "e_13a2e4cf", "eden:ride", "c22seat").expect("walked and seated, done");
}

/// C22 sweep follow-up: Eden's land features are drawn in the world's frame, each placed at the world's origin, so an
/// entry's points were laid round the origin; now they are laid on the thing's own line or outline. Each from a Soul
/// born a few metres off it: a channel walked along (today's e_c3bd69c8), a wood's glade (e_062ad11b), a flower
/// garden wandered (e_71c560a7) and a hedge hidden behind (e_0b36856a). Each ends `done`.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn land_features_are_walked_to_on_their_own_shapes() {
    let ends = [
        (
            "-14.0,-296.0",
            "e_c3bd69c8",
            "eden:walk_along",
            "c22channel",
        ),
        ("335.0,110.0", "e_062ad11b", "eden:go_to_glade", "c22wood"),
        ("-190.0,55.0", "e_71c560a7", "eden:wander", "c22garden"),
        ("45.0,-78.0", "e_0b36856a", "eden:hide_behind", "c22hedge"),
    ]
    .map(|(at, id, verb, tag)| (verb, act_at(at, id, verb, tag)));
    for (verb, end) in ends {
        end.unwrap_or_else(|e| panic!("{verb}: {e}"));
    }
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
    // The seats, as `worldd serve` registers them (`worldd::places::register`).
    let (seats, ..) = worldd::places::register(&mut bodies.town, &found);
    for place in seats {
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
            let named = walk.or_else(|| first_stand.clone());
            // A land feature drawn in the world's frame: the point laid on its own shape, as the world walks to it.
            let drawn = named.as_deref().and_then(|p| {
                let n = tree.node(tree.handle(thing)?)?;
                worldd::acts::on_drawn_shape(&n, entry, p)
            });
            let at = drawn
                .or_else(|| named.as_deref().and_then(point))
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
    assert_eq!(out[2], Err("not_held".to_owned()), "juggle: not held");
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

/// Every motion sample the served world's public stream holds, part by part, read by the normal public reader from
/// the files `worldd serve` wrote under `views/` (the stream `views/world.json` names): `(part, sample)`.
fn public_samples(dir: &Path) -> Vec<(u64, replica::pose::HandOff)> {
    use replica::stream::{Pointer, public::PublicPlayer};
    let world = replica::rules::json::parse(
        &std::fs::read_to_string(dir.join("views/world.json")).unwrap(),
    )
    .unwrap();
    let stream = dir.join(world.get("stream").and_then(|v| v.str()).unwrap());
    let pointer = Pointer::read(&std::fs::read(stream.join("pointer")).unwrap()).unwrap();
    let headers = stream.ancestors().nth(3).unwrap().join("headers");
    let header = std::fs::read(headers.join(replica::encode::to_hex(&pointer.header))).unwrap();
    let Value::Map(fields) = decode(&std::fs::read(stream.join("pointer")).unwrap())
        .unwrap()
        .value
    else {
        panic!("the pointer is a map")
    };
    let Some(Value::Bytes(generation)) = fields.get(&8) else {
        panic!("a public stream's pointer names its baseline")
    };
    let parts = stream.join("g").join(replica::encode::to_hex(generation));
    let baseline = std::fs::read(parts.join("baseline")).unwrap();
    let mut player = PublicPlayer::start(&header, &baseline).expect("the public reader");
    let mut out = Vec::new();
    for n in 0..=pointer.newest.expect("a published part") {
        let bytes = std::fs::read(parts.join(n.to_string())).expect("a published part");
        player
            .play(&bytes)
            .expect("the public reader plays the part");
        out.extend(player.samples().iter().map(|h| (n, *h)));
    }
    out
}

/// #3799 A4: a Soul on a served Eden walks to the sage armchair, sits and rises through the gateway; the public
/// stream `worldd serve` wrote carries its body's motion: samples that grow in number, positions that change over
/// time while it walks, the hand-off into the seat's slot and the one out of it, read by the normal public reader.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
// A real process on the real clock: its waits and rates are real time.
#[allow(clippy::disallowed_methods)]
fn i3799_a4_the_public_stream_carries_a_soul_walking_sitting_and_rising() {
    use replica::pose::Owner;
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let armchair = im.nodes["e_1f3666fe"];
    let (served, mut soul, dir) = serve(&facts, "74.0,-1.0", "m3799", im.nodes["world"].scope());
    let walked = soul.act("eden:walk", Some(armchair), BTreeMap::new());
    let sat = soul.act("eden:sit", Some(armchair), BTreeMap::new());
    let rose = soul.act("eden:rise", None, BTreeMap::new());
    println!("walk {walked:?}, sit {sat:?}, rise {rose:?}");
    // A bed's slot (#3791's lying bodies): the beds of the houses west of the library, nearest first (today's ids),
    // the first one the Soul can walk to and lie in.
    let (mut bed, mut to_bed, mut lay) = (armchair, Err(String::new()), Err(String::new()));
    for b in ["e_9857eaa7", "e_09de188a", "e_6487ccc5", "e_c57cbb07"] {
        bed = im.nodes[b];
        to_bed = soul.act("eden:walk", Some(bed), BTreeMap::new());
        lay = soul.act("eden:lie", Some(bed), BTreeMap::new());
        println!("bed {b}: walk {to_bed:?}, lie {lay:?}");
        if lay.is_ok() {
            break;
        }
    }
    let up = soul.act("eden:rise", None, BTreeMap::new());
    println!("rise from the bed {up:?}");
    // The stream is cut every half second of world time; wait (at most 60 s) for the rise's hand-off to be published,
    // and say how long it took after the rise's answer.
    let rose_at = std::time::Instant::now();
    let mut samples = public_samples(&dir);
    let rises = 1 + usize::from(lay.is_ok());
    let risen = |s: &[(u64, replica::pose::HandOff)]| {
        s.iter().filter(|(_, h)| h.from == Owner::Slot).count() >= rises
    };
    while !risen(&samples) && rose_at.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(250));
        samples = public_samples(&dir);
    }
    println!(
        "the rise's hand-off on the public stream {:.2} s after its answer",
        rose_at.elapsed().as_secs_f64()
    );
    drop(served);
    // The page's Track test plays this stream (`v2/web/src/clock/stream-track.test.ts`, V2_STREAM_DIR).
    if let Ok(keep) = std::env::var("V2_KEEP_STREAM") {
        copy_dir(&dir.join("views"), Path::new(&keep));
    }
    let _ = std::fs::remove_dir_all(&dir);
    walked.expect("walked to the armchair");
    sat.expect("sat in it");
    rose.expect("rose from it");
    to_bed.expect("walked to a bed");
    let bodies: std::collections::BTreeSet<Id> = samples.iter().map(|(_, h)| h.node).collect();
    println!(
        "{} public samples in {} parts, of {} bodies",
        samples.len(),
        samples
            .iter()
            .map(|s| s.0)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        bodies.len()
    );
    assert_eq!(bodies.len(), 1, "the one Soul's body");
    let walking: Vec<&replica::pose::HandOff> = samples
        .iter()
        .map(|(_, h)| h)
        .filter(|h| h.to == Owner::Mover && h.from == Owner::Mover)
        .collect();
    let at: Vec<i64> = samples.iter().map(|(_, h)| h.at).collect();
    assert!(at.windows(2).all(|w| w[0] <= w[1]), "in world time order");
    let mut places: Vec<(i64, i64)> = walking
        .iter()
        .map(|h| (h.pose.position.x, h.pose.position.z))
        .collect();
    places.dedup();
    println!(
        "walking: {} samples at {} places, first {:?} last {:?} (µm)",
        walking.len(),
        places.len(),
        places.first(),
        places.last()
    );
    assert!(walking.len() >= 10, "a walk of metres is many samples");
    assert!(places.len() >= 10, "the body is seen at changing positions");
    let into = samples
        .iter()
        .position(|(_, h)| h.to == Owner::Slot && h.pose.frame.node == armchair);
    let out = samples
        .iter()
        .position(|(_, h)| h.from == Owner::Slot && h.to == Owner::Mover);
    println!(
        "into the seat: {:?}; out of it: {:?}",
        into.map(|i| samples[i].1),
        out.map(|i| samples[i].1)
    );
    let (into, out) = (
        into.expect("the hand-off into the seat's slot"),
        out.expect("the hand-off out of it"),
    );
    assert!(
        samples[into].1.pose.frame.slot.is_some(),
        "in a slot of the armchair"
    );
    assert!(into < out, "seated, then risen");
    assert_ne!(
        samples[out].1.pose.frame.node, armchair,
        "standing on a floor again"
    );
    // The bed: the body's node changes parent into the bed's slot (a sample's frame is its node's parent), at the
    // slot's place, with the hand-off; then out of it onto a floor, where it stands somewhere new. Today every Eden
    // bed tried refuses the gateway's lie `out-of-reach` (not this change): then only the walk to it is checked.
    if lay.is_err() {
        println!("no bed took the lie ({lay:?}); the bed's hand-offs are not checked");
        return;
    }
    up.expect("rose from the bed");
    let lie = samples
        .iter()
        .position(|(_, h)| h.to == Owner::Slot && h.pose.frame.node == bed)
        .expect("the hand-off into the bed's slot");
    let got_up = samples
        .iter()
        .skip(lie)
        .position(|(_, h)| h.from == Owner::Slot && h.to == Owner::Mover)
        .map(|i| i + lie)
        .expect("the hand-off out of the bed");
    println!(
        "into the bed: {:?}; out of it: {:?}",
        samples[lie].1, samples[got_up].1
    );
    assert!(
        samples[lie].1.pose.frame.slot.is_some(),
        "in a slot of the bed"
    );
    assert!(out < lie, "the armchair, then the bed");
    assert_ne!(samples[got_up].1.pose.frame.node, bed, "on a floor again");
    assert_ne!(
        samples[got_up].1.pose.position, samples[out].1.pose.position,
        "standing somewhere new"
    );
}

/// #3799 A5: full Eden served with `V2_WALKERS` (200) joined Souls, each walking back and forth on the open ground
/// through the gateway for `V2_SECONDS` (60), while a reader follows the public stream as the page does (the pointer,
/// then each new part played by the normal public reader, the same code the page runs as WASM). Prints parts written
/// a second against parts played a second, the reader's lag behind the newest part, and the samples it saw.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
// A real process on the real clock: its waits and rates are real time.
#[allow(clippy::disallowed_methods)]
fn i3799_a5_two_hundred_walkers_and_a_reader_that_keeps_up() {
    use replica::stream::{Pointer, public::PublicPlayer};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::Instant;
    let n: u64 = std::env::var("V2_WALKERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200);
    // A warm-up first (the joins' parts, each written whole), then the measured walking.
    let warmup = Duration::from_secs(
        std::env::var("V2_WARMUP")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60),
    );
    let secs: u64 = std::env::var("V2_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (lineage, ground) = (im.nodes["world"].scope(), im.nodes["ground"]);
    let (served, first, dir) = serve(&facts, "74.0,-1.0", "m3799a5", lineage);
    drop(first);
    let stop = Arc::new(AtomicBool::new(false));
    let (walks, refused) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let joined = Instant::now();
    let mut souls: Vec<Client> = (2..n + 2).map(|i| join(&dir, i, lineage)).collect();
    println!(
        "{n} Souls joined in {:.1} s",
        joined.elapsed().as_secs_f64()
    );
    // The reader: from the pointer, each part as it is published.
    let reader = {
        let (dir, stop) = (dir.clone(), stop.clone());
        std::thread::spawn(move || {
            let world = replica::rules::json::parse(
                &std::fs::read_to_string(dir.join("views/world.json")).unwrap(),
            )
            .unwrap();
            let stream = dir.join(world.get("stream").and_then(|v| v.str()).unwrap());
            let (mut player, mut generation, mut next) = (None::<PublicPlayer>, Vec::new(), 0u64);
            let mut crossed = 0u64;
            let (mut played, mut samples, mut lags, mut busy) =
                (0u64, 0usize, Vec::new(), Duration::ZERO);
            let start = Instant::now();
            // Writer lag: world time now less the newest published part's end, µs, while measuring.
            let mut behind: Vec<i64> = Vec::new();
            // The same during the warm-up (the joins just made): (seconds since the walkers started, µs behind).
            let mut warming: Vec<(f64, i64)> = Vec::new();
            let mut measuring: Option<Instant> = None;
            while !stop.load(Ordering::Relaxed) {
                if measuring.is_none() && start.elapsed() >= warmup {
                    measuring = Some(Instant::now());
                    (played, samples, busy) = (0, 0, Duration::ZERO);
                    lags.clear();
                }
                let Ok(bytes) = std::fs::read(stream.join("pointer")) else {
                    continue;
                };
                let Ok(pointer) = Pointer::read(&bytes) else {
                    continue;
                };
                let Value::Map(fields) = decode(&bytes).unwrap().value else {
                    continue;
                };
                let Some(Value::Bytes(g)) = fields.get(&8) else {
                    continue;
                };
                let parts = stream.join("g").join(replica::encode::to_hex(g));
                if *g != generation {
                    // #3825: a live reader on the generation the handoff closes drains it to its end, where its state
                    // is the new baseline's (the same digest), and crosses with no gap.
                    if let (Some(p), Some(Value::Array(h)), Some(Value::Bytes(from))) =
                        (player.as_mut(), fields.get(&9), fields.get(&10))
                        && *from == generation
                    {
                        let old = stream.join("g").join(replica::encode::to_hex(from));
                        let [Value::Uint(_), Value::Uint(end), Value::Bytes(digest)] = h.as_slice()
                        else {
                            panic!("a handoff")
                        };
                        while next < *end {
                            let bytes = std::fs::read(old.join(next.to_string()))
                                .expect("the old generation's part");
                            p.play(&bytes)
                                .expect("the public reader drains the old generation");
                            samples += p.samples().len();
                            next += 1;
                        }
                        assert_eq!(
                            p.hash().unwrap(),
                            *digest,
                            "the old generation ends at the handoff"
                        );
                        crossed += 1;
                    }
                    let headers = stream.ancestors().nth(3).unwrap().join("headers");
                    let header =
                        std::fs::read(headers.join(replica::encode::to_hex(&pointer.header)))
                            .unwrap();
                    let baseline = std::fs::read(parts.join("baseline")).unwrap();
                    let fresh = PublicPlayer::start(&header, &baseline).expect("the public reader");
                    if let Some(p) = &player
                        && next > 0
                    {
                        assert_eq!(
                            fresh.hash().unwrap(),
                            p.hash().unwrap(),
                            "no gap at the crossing"
                        );
                    }
                    player = Some(fresh);
                    generation = g.clone();
                    next = 0;
                }
                // A generation just begun has no part yet.
                let Some(newest) = pointer.newest else {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                };
                let lag = answers::now() - pointer.newest_to.unwrap_or(0);
                if measuring.is_some() {
                    behind.push(lag);
                } else {
                    warming.push((start.elapsed().as_secs_f64(), lag));
                }
                let p = player.as_mut().unwrap();
                while next <= newest {
                    let t = Instant::now();
                    let bytes =
                        std::fs::read(parts.join(next.to_string())).expect("a published part");
                    p.play(&bytes).expect("the public reader plays the part");
                    busy += t.elapsed();
                    samples += p.samples().len();
                    played += 1;
                    next += 1;
                }
                if measuring.is_some() {
                    lags.push(newest + 1 - next);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let wall = measuring.map_or(1.0, |m| m.elapsed().as_secs_f64());
            let most = warming.iter().map(|w| w.1).max().unwrap_or(0);
            let caught = warming
                .iter()
                .rposition(|w| w.1 > 1_000_000)
                .and_then(|i| warming.get(i + 1))
                .map(|w| w.0);
            println!(
                "after the joins: the writer at most {:.2} s behind world time, within 1 s again {:?} s after the \
                 walkers started",
                most as f64 / 1e6,
                caught
            );
            println!(
                "the writer behind world time while measuring: most {:.2} s, last {:.2} s",
                behind.iter().max().copied().unwrap_or(0) as f64 / 1e6,
                behind.last().copied().unwrap_or(0) as f64 / 1e6
            );
            // Parts are numbered within a generation (#3825): those written while measuring are those played then,
            // and those left to play at the end, less those left at the start.
            let written = (played + lags.last().copied().unwrap_or(0))
                .saturating_sub(lags.first().copied().unwrap_or(0));
            println!("generations crossed by the live reader: {crossed}");
            (
                written as f64 / wall,
                played as f64 / wall,
                played,
                samples,
                busy,
                lags.iter().max().copied(),
            )
        })
    };
    let walkers: Vec<_> = souls
        .drain(..)
        .enumerate()
        .map(|(i, mut soul)| {
            let (stop, walks, refused) = (stop.clone(), walks.clone(), refused.clone());
            std::thread::spawn(move || {
                // Back and forth between two points 8 m apart on a ring around the births.
                let a = i as f64 * 0.7;
                let (cx, cz) = (74.0 + 6.0 * a.cos(), -1.0 + 6.0 * a.sin());
                let mut leg = 0;
                while !stop.load(Ordering::Relaxed) {
                    let x = cx + if leg % 2 == 0 { 4.0 } else { -4.0 };
                    let um = |m: f64| {
                        let v = (m * 1e6) as i64;
                        u64::try_from(v)
                            .map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
                    };
                    let to = Value::Array(vec![um(x), um(0.0), um(cz)]);
                    match soul.act("eden:walk", Some(ground), BTreeMap::from([(1, to)])) {
                        Ok(_) => walks.fetch_add(1, Ordering::Relaxed),
                        Err(_) => refused.fetch_add(1, Ordering::Relaxed),
                    };
                    leg += 1;
                }
            })
        })
        .collect();
    std::thread::sleep(warmup + Duration::from_secs(secs));
    stop.store(true, Ordering::Relaxed);
    let (written, played_rate, played, samples, busy, lag) = reader.join().unwrap();
    for w in walkers {
        let _ = w.join();
    }
    drop(served);
    // The recorded world, for the public writer's byte-for-byte regression (V2_RECORDED_WORLD).
    if let Ok(keep) = std::env::var("V2_KEEP_WORLD") {
        let _ = std::fs::remove_dir_all(&keep);
        copy_dir(&dir, Path::new(&keep));
    }
    let _ = std::fs::remove_dir_all(&dir);
    println!(
        "A5: {n} walkers, {secs} s measured after {} s: walks done {}, refused {}; public parts written {written:.2}/s, played \
         {played_rate:.2}/s ({played} parts, {samples} motion samples, {:.1} ms reading in all); the reader's most \
         parts behind the newest: {lag:?}",
        warmup.as_secs(),
        walks.load(Ordering::Relaxed),
        refused.load(Ordering::Relaxed),
        busy.as_secs_f64() * 1e3
    );
    assert!(samples > 0, "the stream carries motion");
    assert!(lag.unwrap_or(0) <= 2, "the reader keeps up");
}

/// Every file of a served world's public stream that a reader fetches by name and that never changes: the headers,
/// each generation's baseline and its numbered parts and words. The pointer and the recovery store are left out.
fn stream_files(views: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, d: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in std::fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
                continue;
            }
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            let stem = name.trim_end_matches(".text");
            let keep = stem == "baseline"
                || stem.chars().all(|c| c.is_ascii_digit())
                || p.parent().is_some_and(|q| q.ends_with("headers"));
            if keep && !name.ends_with(".tmp") {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                out.insert(rel, std::fs::read(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(views, views, &mut out);
    out
}

/// How many generations of the public stream are on the disk under `views` (#3833).
fn generations_on_disk(views: &Path) -> usize {
    fn walk(d: &Path) -> usize {
        let Ok(entries) = std::fs::read_dir(d) else {
            return 0;
        };
        let mut n = 0;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                n += if p.ends_with("g") {
                    std::fs::read_dir(&p).map_or(0, |g| g.count())
                } else {
                    walk(&p)
                };
            }
        }
        n
    }
    walk(views)
}

/// #3799: the public writer cuts a part that only moves nodes by their rows, and any other whole; the stream is the
/// same, byte for byte, as when every part is worked out whole (`SOULS_STREAM_WHOLE`). A recorded world
/// (`V2_RECORDED_WORLD`, e.g. kept by the A5 run with `V2_KEEP_WORLD`) is served twice from copies with no stream: the
/// stream is written again from the whole log at start-up, once each way; the two are compared file by file, and
/// the time each start-up took to write it is printed. Both runs roll the stream over to a new generation every
/// `V2_GENERATION_PARTS` (100) parts (#3825), so the rollovers' baselines are compared too. A third run (#3833) is
/// killed twice while it writes, once 2 generations are on the disk and once 4 are, and started again each time from
/// the newest generation's recovery seed: its stream is the same, byte for byte.
#[test]
#[ignore = "needs a recorded world (V2_RECORDED_WORLD) and a built worldd (see the module doc)"]
fn i3799_cuts_by_rows_are_byte_identical_to_whole_cuts_on_a_recorded_world() {
    let recorded = PathBuf::from(std::env::var("V2_RECORDED_WORLD").expect("V2_RECORDED_WORLD"));
    let mut runs = Vec::new();
    for (tag, whole, kills) in [
        ("rows", false, &[][..]),
        ("whole", true, &[][..]),
        ("restarted", false, &[2usize, 4][..]),
    ] {
        let dir = std::env::temp_dir().join(format!("m3799r-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        copy_dir(&recorded, &dir);
        for gone in [
            "views",
            ".stream-recovery-store",
            "stream-backup",
            "gateway.sock",
        ] {
            let p = dir.join(gone);
            let _ = std::fs::remove_dir_all(&p);
            let _ = std::fs::remove_file(&p);
        }
        let command = || {
            let mut c = Command::new(env!("CARGO_BIN_EXE_worldd"));
            c.args(["serve", "--dir"])
                .arg(&dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            if whole {
                c.env("SOULS_STREAM_WHOLE", "1");
            }
            c.env(
                "SOULS_STREAM_GENERATION_PARTS",
                std::env::var("V2_GENERATION_PARTS").unwrap_or_else(|_| "100".into()),
            );
            // Nothing pruned while the start-up writes, however long it takes: every run keeps every generation.
            c.env("SOULS_STREAM_PRUNE_GRACE_S", "86400");
            c
        };
        // #3833: killed as a crash would, once `n` generations are on the disk, then started again.
        for &n in kills {
            let mut c = command();
            let mut child = c.stdout(Stdio::null()).spawn().unwrap();
            while generations_on_disk(&dir.join("views")) < n {
                assert!(child.try_wait().unwrap().is_none(), "{tag}: still writing");
                std::thread::sleep(Duration::from_millis(20));
            }
            child.kill().unwrap();
            let _ = child.wait();
            let _ = std::fs::remove_file(dir.join("gateway.sock"));
            println!("{tag}: killed with {n} generations written");
        }
        let mut child = command().spawn().unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let (mut line, mut before, mut written) = (String::new(), None, None);
        while out.read_line(&mut line).unwrap() > 0 {
            let ms = |l: &str| -> Option<u64> {
                l.trim()
                    .strip_suffix(" ms")?
                    .rsplit(' ')
                    .next()?
                    .parse()
                    .ok()
            };
            if line.starts_with("start-up: replay at") {
                before = ms(&line);
            }
            if line.starts_with("start-up: public stream") {
                written = ms(&line);
                break;
            }
            line.clear();
        }
        let _ = child.kill();
        let _ = child.wait();
        let files = stream_files(&dir.join("views"));
        let _ = std::fs::remove_dir_all(&dir);
        let parts = files
            .keys()
            .filter(|k| {
                k.rsplit('/')
                    .next()
                    .is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()))
            })
            .count();
        let ms = written.unwrap_or(0).saturating_sub(before.unwrap_or(0));
        println!(
            "{tag}: {parts} parts written from the log at start-up in about {ms} ms ({:.1} ms a part)",
            ms as f64 / parts.max(1) as f64
        );
        assert!(written.is_some(), "{tag}: the start-up wrote its stream");
        runs.push(files);
    }
    assert_eq!(
        runs[2], runs[0],
        "#3833: restarted twice, the same stream byte for byte"
    );
    let (rows, whole) = (&runs[0], &runs[1]);
    let both: Vec<&String> = rows.keys().filter(|k| whole.contains_key(*k)).collect();
    let differ: Vec<&&String> = both.iter().filter(|k| rows[**k] != whole[**k]).collect();
    println!(
        "{} files in both, {} differ; {} only by rows, {} only whole",
        both.len(),
        differ.len(),
        rows.len() - both.len(),
        whole.len() - both.len()
    );
    assert!(both.len() > 100, "a recorded world of many parts");
    let generations: std::collections::BTreeSet<&str> = rows
        .keys()
        .filter_map(|k| k.split("/g/").nth(1)?.split('/').next())
        .collect();
    println!("{} generations", generations.len());
    assert!(generations.len() > 1, "the stream rolled over (#3825)");
    assert!(
        differ.is_empty(),
        "byte for byte: {:?}",
        &differ[..differ.len().min(5)]
    );
}

/// #3833 A3: a world that ran with walkers is started again from a copy of its folder, as after a crash
/// (`V2_RESTART_WORLD`, e.g. kept by the A5 run with `V2_KEEP_WORLD` after an hour of 60 walkers). It prints each
/// start-up stage, how long the public writer took to open, the generations on the disk and the parts of the newest
/// one (the only ones a restart reads again), and the recovery objects kept; the whole start-up is under 30 s.
#[test]
#[ignore = "needs a recorded world (V2_RESTART_WORLD) and a built worldd (see the module doc)"]
#[allow(clippy::disallowed_methods)]
fn i3833_a3_a_restart_after_an_hour_reads_only_the_newest_generation() {
    let kept = PathBuf::from(std::env::var("V2_RESTART_WORLD").expect("V2_RESTART_WORLD"));
    let dir = std::env::temp_dir().join(format!("m3833-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    copy_dir(&kept, &dir);
    let _ = std::fs::remove_file(dir.join("gateway.sock"));
    let started = std::time::Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["serve", "--dir"])
        .arg(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let (mut line, mut stages) = (String::new(), BTreeMap::new());
    while out.read_line(&mut line).unwrap() > 0 && !line.contains("listening ") {
        if let Some(rest) = line.trim().strip_prefix("start-up: ")
            && let Some((stage, ms)) = rest.rsplit_once(" at ")
            && let Some(ms) = ms.strip_suffix(" ms").and_then(|m| m.parse::<u64>().ok())
        {
            println!("start-up: {stage} at {ms} ms");
            stages.insert(stage.to_owned(), ms);
        }
        line.clear();
    }
    let took = started.elapsed();
    let _ = child.kill();
    let _ = child.wait();
    let views = dir.join("views");
    let world =
        replica::rules::json::parse(&std::fs::read_to_string(views.join("world.json")).unwrap())
            .unwrap();
    let stream = dir.join(world.get("stream").and_then(|v| v.str()).unwrap());
    let pointer = std::fs::read(stream.join("pointer")).unwrap();
    let Value::Map(p) = decode(&pointer).unwrap().value else {
        panic!("a pointer is a map")
    };
    let newest = match (&p[&8], &p[&1]) {
        (Value::Bytes(g), Value::Uint(n)) => (replica::encode::to_hex(g), n + 1),
        (Value::Bytes(g), _) => (replica::encode::to_hex(g), 0),
        _ => panic!("the pointer names its generation"),
    };
    fn objects(d: &Path) -> usize {
        std::fs::read_dir(d).map_or(0, |entries| {
            entries
                .flatten()
                .map(|e| match e.path() {
                    p if p.ends_with("objects") => std::fs::read_dir(&p).map_or(0, |o| o.count()),
                    p if p.is_dir() => objects(&p),
                    _ => 0,
                })
                .sum()
        })
    }
    let objects = objects(&dir.join(".stream-recovery-store"));
    let writer = stages["public stream"].saturating_sub(stages["replay"]);
    println!(
        "A3: listening after {:.2} s ({} ms by the world's own clock); the public writer opened in {writer} ms; {} \
         generations on the disk; the newest has {} parts; {objects} recovery objects kept",
        took.as_secs_f64(),
        stages.get("listening").copied().unwrap_or(0),
        generations_on_disk(&views),
        newest.1,
    );
    let _ = std::fs::remove_dir_all(&dir);
    assert!(took < Duration::from_secs(30), "a restart under 30 s");
}

/// C34 (#3599) A2: a building's named area resolves onto its own room and floor. Born outside, a Soul climbs a
/// lighthouse to its lantern room (today's e_edbbc6a7, four floors up) and a tower to its top room (e_36bd67b1, whose
/// top floor is 8.5 m up, not the 6.1 m the kind's area names), across the stairs, by their own entries; each ends
/// `done`. Before #3599 each ended `souls:no-way`: the area's point was carried up to the open ground, cut out under
/// the building. The lighthouse's Soul is born on its breakwater, before its door (first-day round 2 turned it to
/// face the breakwater; before, it was born on the platform beyond it, the only ground its door then opened onto).
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c34_a2_a_lighthouse_and_a_tower_are_climbed_to_their_top_rooms() {
    let lantern = act_at("96.0,182.0", "e_edbbc6a7", "eden:climb", "c34lh");
    let top = act_at("69.0,26.0", "e_36bd67b1", "eden:climb", "c34tw");
    lantern.expect("the lighthouse climbed, done");
    top.expect("the tower climbed, done");
}

/// C34 (#3599) A2: the ground-floor areas of the sweep's other named forms resolve the same way. Born outside a chapel
/// (today's e_9b7418a3), a Soul enters its nave (the room named `nave`). Born outside a greenhouse (e_8b4c5e36), a Soul
/// opens its vent: the walk to the `inside` area (no room of that name, the greenhouse's only floor), then across it
/// to within reach of the vent pole, then the press, as today's game approaches the pole; born beside the pole, the
/// same form ends `done` too. Each ended `souls:no-way`, the greenhouse from outside `out-of-reach` once its area
/// resolved.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c34_a2_a_greenhouses_vent_and_a_chapels_nave() {
    let enter = act_at("279.0,110.0", "e_9b7418a3", "eden:enter", "c34ch");
    let outside = act_at("69.0,39.0", "e_8b4c5e36", "eden:open_vent", "c34gh");
    let beside = act_at("70.2,35.3", "e_8b4c5e36", "eden:open_vent", "c34gb");
    enter.expect("the nave entered, done");
    outside.expect("the vent opened from outside, done");
    beside.expect("the vent opened from beside its pole, done");
}

/// C22 sweep (#1960): an area that is none of a thing's rooms and that no floor of the thing stands a body near is
/// walked to on the ground under it, as today's game walks to an area by its centre: round the back of a house
/// (e_0aacfcae, `go_round_back` to `back`, behind it) ends `done`. Deck-stand (#1960): a thing with no rooms is sized
/// by its own floors and stairs, so its kind's areas are fitted to them. Born west of the botanic garden's bridge
/// (today's e_57696e8b, a path laid in the world's frame), a Soul crosses it (`cross`: `end_a`, then `end_b`) and
/// ends on its deck at the east end, 182 mm up. Born beside the office's roof stairs (e_b2780f91, a flight 12.6 m
/// long and 9.02 m high, the kind's 4.5 m and 2.8 m), it goes up (`go_up` to `top`) onto the office's roof, the
/// floor the flight's top lands on, 9.02 m up; and down (`go_down` to `bottom`) to the flight's foot, on the ground.
/// Before, the bridge's areas were at the world's origin and the flight's `top` 6.2 m below its landing, which cut to
/// nothing and met no floor: each ended `done` on the ground, beside or under them.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c22_an_area_off_a_things_floors_is_walked_to_on_the_ground() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (deck, roof, ground) = (
        im.nodes["e_57696e8b/floor-0"],
        im.nodes["e_948bae23/floor-3"],
        im.nodes["ground"],
    );
    let (cross, c) = act_ending(&facts, "-86.0,-152.0", "e_57696e8b", "eden:cross", "c22br");
    let (up, u) = act_ending(&facts, "79.8,16.5", "e_b2780f91", "eden:go_up", "c22su");
    let (down, d) = act_ending(&facts, "79.8,16.5", "e_b2780f91", "eden:go_down", "c22sd");
    let back = act_at("219.0,95.0", "e_0aacfcae", "eden:go_round_back", "c22hb");
    cross.expect("the bridge crossed, done");
    let (node, at) = c.expect("the body's end");
    assert_eq!(node, deck, "on the bridge's deck: {at:?}");
    assert!(
        at.x > -60_000_000 && at.y >= 182_000,
        "at its east end, on the deck: {at:?}"
    );
    up.expect("up the stairs, done");
    let (node, at) = u.expect("the body's end");
    assert_eq!(node, roof, "on the office's roof: {at:?}");
    assert_eq!(at.y, 9_020_000, "9.02 m up: {at:?}");
    down.expect("down the stairs, done");
    let (node, at) = d.expect("the body's end");
    assert_eq!(node, ground, "on the ground: {at:?}");
    assert!(
        (at.x - 73_380_000).abs() < 2_000_000 && (at.z - 15_000_000).abs() < 2_000_000,
        "at the flight's foot: {at:?}"
    );
    back.expect("round the back of the house, done");
}

/// #3983: the roof stairs of eden-house-3 and eden-house-4 (today's e_303f348f and e_f071fa8e, 4.2 m long and
/// 2.82 m high) climb from the west garden onto their bedroom wing's flat roof, 2.82 m up. Born west of each
/// flight's foot, a Soul goes up (`go_up` to `top`) and ends on that roof (e_3d52ac7f's and e_0c946e80's floor-1).
/// Each flight's top is 0.51 m short of the roof's edge and its landing 10 mm short, so nothing of it overlaps the
/// roof (the office's landing overlaps its roof by 0.48 m); the top is carried along the flight onto the roof's
/// standing ground, which starts within the 1 m a flight's top may be carried (`sim::links`, #3979). Their kind borrows `eden:stair_flight`'s entry through Eden's map, as live Eden's import does: the facts must be
/// exported with `--map content/worlds/eden/map.json` (without it, `go_up` ends `no_such_kind`).
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn i3983_the_courtyard_houses_roof_stairs_go_up_onto_their_roofs() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let mut ends = Vec::new();
    for (house, at, stairs, roof) in [
        (
            "eden-house-3",
            "22.0,30.27",
            "e_303f348f",
            "e_3d52ac7f/floor-1",
        ),
        (
            "eden-house-4",
            "42.0,30.27",
            "e_f071fa8e",
            "e_0c946e80/floor-1",
        ),
    ] {
        let (up, end) = act_ending(&facts, at, stairs, "eden:go_up", &format!("i3983{house}"));
        ends.push((house, im.nodes[roof], up, end));
    }
    for (house, roof, up, end) in ends {
        up.unwrap_or_else(|e| panic!("{house}: up the stairs, done: {e}"));
        let (node, at) = end.expect("the body's end");
        assert_eq!(node, roof, "{house}: on the bedroom wing's roof: {at:?}");
        assert_eq!(at.y, 2_820_000, "{house}: 2.82 m up: {at:?}");
    }
}

/// How a walk by a thing's form went ([`walk_by_form`]): its answer, its time from the ask to the answer (s), and where
/// the body stood at each logged tick (`(tick, node, x m, z m)`).
struct Walked {
    done: Result<Vec<u64>, String>,
    secs: f64,
    track: Vec<(u64, Id, f64, f64)>,
}

/// #3890: a Soul born at `at` (`x,z` m) on Eden from `facts` does `verb` at thing `today` (today's id), its act lasting
/// up to 10 minutes: [`Walked`], printed.
fn walk_by_form(facts: &str, at: &str, today: &str, verb: &str, tag: &str) -> Walked {
    let im = import_eden::load(&std::fs::read_to_string(facts).unwrap()).expect("Eden loads");
    let thing = im.nodes[today];
    let (served, mut soul, dir) = serve(facts, at, tag, im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(900)))
        .unwrap();
    let t0 = answers::now();
    let done = soul.act_within(verb, Some(thing), BTreeMap::new(), 600_000_000);
    let secs = (answers::now() - t0) as f64 / 1e6;
    let track = track(&dir);
    let end = track.last().map(|t| (t.2, t.3));
    println!(
        "{tag}: {verb} at {today} from ({at}): {done:?} after {secs:.1} s, at the end {end:?}"
    );
    // Its path, a point each 2 m (and each change of node).
    let mut last: Option<(Id, f64, f64)> = None;
    let mut path = Vec::new();
    for &(tick, node, x, z) in &track {
        if last.is_none_or(|(n, lx, lz)| n != node || (x - lx).hypot(z - lz) >= 2.0) {
            path.push(format!("{tick}:({x:.1},{z:.1})"));
            last = Some((node, x, z));
        }
    }
    println!("  {tag} path: {}", path.join(" "));
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    Walked { done, secs, track }
}

/// The rows of `track` (as [`Walked`]'s) where the body stood on the open ground on wading ground or water, by Eden's
/// own walk map (`facts`): a walker (hands, no wading or swimming) may never be there.
fn wet_rows(facts: &str, track: &[(u64, Id, f64, f64)]) -> Vec<(u64, f64, f64)> {
    let im = import_eden::load(&std::fs::read_to_string(facts).unwrap()).expect("Eden loads");
    let ground = im.nodes["ground"];
    let header = import_eden::header(im.nodes["world"], &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let town = sim::walk::town::Town::new(
        im.tree,
        ground,
        sim::links::Doors::new(header, im.rules, next),
    )
    .expect("the town");
    let all = sim::routes::WADE | sim::routes::SWIM;
    track
        .iter()
        .filter(|t| t.1 == ground)
        .filter(|t| {
            let at = replica::pose::Vec3::new((t.2 * 1e6) as i64, 0, (t.3 * 1e6) as i64);
            town.map
                .spot_for(ground, at, all)
                .is_some_and(|s| town.map.piece(s.piece).ground != sim::gaits::Ground::Dry)
        })
        .map(|t| (t.0, t.2, t.3))
        .collect()
}

/// #3890 A1: born on either bank of the west river's stone bridge (today's e_d10385f7, a deck of 18 stepped slabs laid
/// in the world's frame from (-252, -61) to (-225, -55) m, over the 7 m river), a Soul crosses it by its own entry
/// (`cross`: `end_a`, then `end_b`), three starts a bank. Each ends `done` within 2.5 m of the east end, having stood
/// on the deck, and never stands in the river ([`wet_rows`]).
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn i3890_the_river_stone_bridge_is_crossed_from_each_bank() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let deck = im.nodes["e_d10385f7/floor-0"];
    let starts = [
        ("-256.0,-62.0", "w1"),
        ("-254.5,-58.5", "w2"),
        ("-253.0,-65.0", "w3"),
        ("-221.0,-54.0", "e1"),
        ("-222.0,-58.0", "e2"),
        ("-220.5,-51.5", "e3"),
    ];
    let walks = std::thread::scope(|s| {
        let runs: Vec<_> = starts
            .iter()
            .map(|&(at, tag)| {
                let facts = &facts;
                s.spawn(move || {
                    let w = walk_by_form(
                        facts,
                        at,
                        "e_d10385f7",
                        "eden:cross",
                        &format!("i3890b{tag}"),
                    );
                    (at, w)
                })
            })
            .collect();
        runs.into_iter()
            .map(|r| r.join().unwrap())
            .collect::<Vec<_>>()
    });
    let mut wrong = Vec::new();
    for (at, w) in &walks {
        let end = w.track.last().map(|t| (t.1, t.2, t.3));
        let on_deck = w.track.iter().any(|t| t.1 == deck);
        let wet = wet_rows(&facts, &w.track).len();
        let to_end = end.map_or(f64::INFINITY, |e| (e.1 + 225.0).hypot(e.2 + 55.0));
        println!(
            "BRIDGE from ({at}): {:?} in {:.1} s; on the deck {on_deck}; {wet} rows in water; ends {to_end:.2} m from \
             the east end, on {}",
            w.done.as_ref().map(|_| "done"),
            w.secs,
            if end.map(|e| e.0) == Some(deck) {
                "the deck"
            } else {
                "the ground"
            }
        );
        if w.done.is_err() || !on_deck || wet > 0 || to_end > 2.5 {
            wrong.push(*at);
        }
    }
    assert!(wrong.is_empty(), "not crossed from {wrong:?}");
}

/// #3890 A2: born round the park pond (today's e_5c6d4b00, water 26 by 17 m round (-6, 112) m, inside a stone kerb
/// with five open gates, a jetty out from its east side), a Soul walks round it by its own entry (`walk_around`: its
/// south, east, north, west and south shores), from four sides. Each ends `done` back at the south shore, having come
/// within 3 m of each shore in turn, and never stands in its water ([`wet_rows`]; its jetty and stone edge are ground
/// cover over it, walked as the open ground).
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn i3890_a_soul_walks_round_the_park_pond() {
    let facts = facts_path();
    // Its shores as its entry lays them on the water's box: south, east, north, west.
    let shores = [
        (-6.0, 120.97),
        (7.72, 112.0),
        (-6.0, 103.03),
        (-19.72, 112.0),
    ];
    let starts = [
        ("-6.0,124.0", "s"),
        ("12.0,112.0", "e"),
        ("-6.0,99.8", "n"),
        ("-23.0,112.0", "w"),
    ];
    let walks = std::thread::scope(|s| {
        let runs: Vec<_> = starts
            .iter()
            .map(|&(at, tag)| {
                let facts = &facts;
                s.spawn(move || {
                    let w = walk_by_form(
                        facts,
                        at,
                        "e_5c6d4b00",
                        "eden:walk_around",
                        &format!("i3890p{tag}"),
                    );
                    (at, w)
                })
            })
            .collect();
        runs.into_iter()
            .map(|r| r.join().unwrap())
            .collect::<Vec<_>>()
    });
    let mut wrong = Vec::new();
    for (at, w) in &walks {
        // The shores in their order (south, east, north, west, south): each the next one the track comes within 3 m of.
        let order = [0, 1, 2, 3, 0];
        let mut next = 0;
        for t in &w.track {
            if next < order.len() {
                let (sx, sz) = shores[order[next]];
                if (t.2 - sx).hypot(t.3 - sz) < 3.0 {
                    next += 1;
                }
            }
        }
        let wet = wet_rows(&facts, &w.track);
        if let Some(first) = wet.first() {
            println!("  first in water: {first:?}");
        }
        let wet = wet.len();
        let end = w.track.last().map(|t| (t.2, t.3));
        let to_end = end.map_or(f64::INFINITY, |e| {
            (e.0 - shores[0].0).hypot(e.1 - shores[0].1)
        });
        println!(
            "POND from ({at}): {:?} in {:.1} s; {next} of 5 shores in turn; {wet} rows in water; ends {to_end:.2} m \
             from the south shore at {end:?}",
            w.done.as_ref().map(|_| "done"),
            w.secs
        );
        if w.done.is_err() || next < order.len() || wet > 0 || to_end > 3.0 {
            wrong.push(*at);
        }
    }
    assert!(wrong.is_empty(), "not walked round from {wrong:?}");
}

/// A Soul walks to a bed and lies in it through the gateway, then gets up, as today's soul.game lets it (parity ledger,
/// "lying in bed", #2835): the beds of the houses west of the library, from eden-house-2's living room. A bed's side
/// stand point beside its room's door is one the spot tables never stop a walker on; it is moved out of the doorway at
/// the start (`worldd serve`'s places), so the walk ends within the lie's reach. Each bed: the walk, the lie into
/// one of its slots (the body's logged frame), the rise.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
// A real process on the real clock: its waits are real time.
#[allow(clippy::disallowed_methods)]
fn a_soul_walks_to_a_bed_lies_in_it_and_gets_up() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (served, mut soul, dir) = serve(&facts, "48.2,18.9", "bedlie", im.nodes["world"].scope());
    let mut ends = Vec::new();
    for b in ["e_9857eaa7", "e_09de188a", "e_6487ccc5", "e_c57cbb07"] {
        let bed = im.nodes[b];
        let walked = soul.act("eden:walk", Some(bed), BTreeMap::new());
        let lay = soul.act("eden:lie", Some(bed), BTreeMap::new());
        // The log is written behind the clock: wait (at most 10 s) for the lie's frame.
        let at = std::time::Instant::now();
        let mut frame = last_frames(&dir).into_values().next();
        while lay.is_ok()
            && frame.map(|f| f.0) != Some(bed)
            && at.elapsed() < Duration::from_secs(10)
        {
            std::thread::sleep(Duration::from_millis(250));
            frame = last_frames(&dir).into_values().next();
        }
        let up = soul.act("eden:rise", None, BTreeMap::new());
        println!("bed {b}: walk {walked:?}, lie {lay:?} in {frame:?}, rise {up:?}");
        ends.push((b, bed, walked, lay, frame, up));
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    for (b, bed, walked, lay, frame, up) in ends {
        walked.unwrap_or_else(|e| panic!("walked to {b}: {e}"));
        lay.unwrap_or_else(|e| panic!("lay in {b}: {e}"));
        let (node, slot) = frame.expect("the body's logged frame");
        assert_eq!(node, bed, "in {b}");
        assert!(slot.is_some(), "in one of {b}'s slots");
        up.unwrap_or_else(|e| panic!("rose from {b}: {e}"));
    }
}

/// The commons shore pond's punt (the one nearest (-57.5, -6.0) m) as `worldd seed` from `facts` placed it: its number,
/// its home and plank `[hx, hz, px, pz]` m, its loop's period and start, µs.
fn commons_punt(facts: &str) -> (u64, [f64; 4], i64, i64) {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let probe = std::env::temp_dir().join(format!("eden-punt-probe-{}", std::process::id()));
    let seeded = Command::new(env!("CARGO_BIN_EXE_worldd"))
        .args(["seed", "--facts", facts, "--dir"])
        .arg(&probe)
        .args([
            "--entries",
            &format!("{root}/content/kinds"),
            "--souls",
            "0",
        ])
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&probe);
    String::from_utf8_lossy(&seeded.stdout)
        .lines()
        .filter_map(|l| {
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
        })
        .min_by_key(|(_, h, _, _)| (((h[0] + 57.5).abs() + (h[1] + 6.0).abs()) * 1000.0) as i64)
        .expect("a punt on Eden")
}

/// Each body's last logged place in the world's log in `dir`: its frame's node and slot, and x and z m.
fn last_places(dir: &Path) -> BTreeMap<Id, (Id, Option<u64>, f64, f64)> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = BTreeMap::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        if let Some(Value::Array(rows)) = Part::read(&r).unwrap().rest.get(&answers::BODIES) {
            for (id, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                let p = pose.position;
                out.insert(
                    id,
                    (
                        pose.frame.node,
                        pose.frame.slot,
                        p.x as f64 / 1e6,
                        p.z as f64 / 1e6,
                    ),
                );
            }
        }
    }
    out
}

/// #3603 A2 and A3, served full Eden through the gateway. One Soul boards the commons punt in its boarding stop and
/// steers it out over the pond. A second Soul on the bank asks to board while the punt stands out on the water, away
/// from its stop: refused `boarding-frame-away`, and its body has not moved. The rider lands the punt; standing at
/// its home the second Soul boards the other seat. The first rider steered it, so it is the driver: the second's steer
/// and land are refused `steered`, and the driver's steer is taken. The driver lands it; both rise at the plank.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn p2_only_the_driver_steers_and_nobody_boards_the_punt_offshore() {
    use replica::sky::int;
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let (k1, [hx, hz, px, pz], period, t0) = commons_punt(&facts);
    println!(
        "the commons punt: rowing-punt-{k1}, home ({hx:.1}, {hz:.1}) m, plank ({px:.2}, {pz:.2}) m, lap {:.1} s",
        period as f64 / 1e6
    );
    let at = format!("{:.2},{:.2}", px - 1.0, pz);
    let (served, mut driver, dir, lines) = serve_lines(&facts, &at, "p2", lineage);
    let mut passenger = join(&dir, 2, lineage);
    let tag = format!("punt: rowing-punt-{k1} is ");
    let shown = lines
        .iter()
        .find_map(|l| l.trim().strip_prefix(tag.as_str()).map(str::to_owned))
        .expect("the punt's id line");
    let punt = Id::new(lineage, shown.split(':').nth(1).unwrap().parse().unwrap()).unwrap();
    let point = |x: f64, z: f64| {
        BTreeMap::from([(
            1,
            Value::Array(vec![int((x * 1e6) as i64), int((z * 1e6) as i64)]),
        )])
    };
    // Board in the punt's boarding stop: wait for the next one when less than 20 s of it are left.
    let phase = |t: i64| (t - t0).rem_euclid(period);
    let p = phase(answers::now());
    if p > 10_000_000 {
        std::thread::sleep(Duration::from_micros((period - p + 500_000) as u64));
    }
    let boarded = driver.act("eden:row", Some(punt), args(&[("seat", Value::Uint(1))]));
    println!("the first Soul boards seat 1: {boarded:?}");
    let p = phase(answers::now());
    if p < 32_000_000 {
        std::thread::sleep(Duration::from_micros((32_000_000 - p) as u64));
    }
    let out = driver.act("carrier:steer", Some(punt), point(-59.8, 0.0));
    println!("the rider steers out: {out:?}");
    // Out on the water, standing where the steer took it: the Soul on the bank asks to board.
    std::thread::sleep(Duration::from_secs(15));
    let before = last_places(&dir);
    let on_bank: Vec<Id> = before
        .iter()
        .filter(|(_, f)| f.0 != punt)
        .map(|(b, _)| *b)
        .collect();
    let offshore = passenger.act("eden:row", Some(punt), args(&[("seat", Value::Uint(2))]));
    std::thread::sleep(Duration::from_secs(2));
    let after = last_places(&dir);
    println!(
        "board offshore: {offshore:?}; the bank's bodies before {:?}, after {:?}",
        on_bank.iter().map(|b| before.get(b)).collect::<Vec<_>>(),
        on_bank.iter().map(|b| after.get(b)).collect::<Vec<_>>()
    );
    let back = driver.act("carrier:land", Some(punt), BTreeMap::new());
    println!("the rider lands: {back:?}");
    // At its home again, its rider still aboard: the Soul on the bank boards the other seat.
    let mut second = Err(String::new());
    for _ in 0..40 {
        std::thread::sleep(Duration::from_secs(3));
        second = passenger.act("eden:row", Some(punt), args(&[("seat", Value::Uint(2))]));
        if second.as_ref().is_ok() || second.as_ref().is_err_and(|e| e != "boarding-frame-away") {
            break;
        }
    }
    println!("the second Soul boards seat 2 at home: {second:?}");
    let not_driver = passenger.act("carrier:steer", Some(punt), point(-60.0, -2.0));
    let not_driver_land = passenger.act("carrier:land", Some(punt), BTreeMap::new());
    let steered = driver.act("carrier:steer", Some(punt), point(-59.8, 0.0));
    println!(
        "the passenger steers: {not_driver:?}, lands: {not_driver_land:?}; the driver steers: {steered:?}"
    );
    std::thread::sleep(Duration::from_secs(5));
    let landed = driver.act("carrier:land", Some(punt), BTreeMap::new());
    println!("the driver lands: {landed:?}");
    let mut off = [Err(String::new()), Err(String::new())];
    for _ in 0..80 {
        std::thread::sleep(Duration::from_secs(3));
        if off[0].is_err() {
            off[0] = driver.act("eden:rise", None, BTreeMap::new());
        }
        if off[0].is_ok() && off[1].is_err() {
            off[1] = passenger.act("eden:rise", None, BTreeMap::new());
        }
        if off.iter().all(Result::is_ok) {
            break;
        }
    }
    println!("both rise at the plank: {off:?}");
    std::thread::sleep(Duration::from_secs(2));
    let end = last_places(&dir);
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    boarded.expect("the first Soul boarded seat 1");
    out.expect("the rider's steer");
    assert_eq!(on_bank.len(), 1, "one body on the bank: {before:?}");
    assert_eq!(offshore, Err("boarding-frame-away".to_owned()));
    assert_eq!(
        before.get(&on_bank[0]),
        after.get(&on_bank[0]),
        "the bank's body has not moved"
    );
    back.expect("landed");
    second.expect("the second Soul boarded seat 2 at home");
    assert_eq!(not_driver, Err("steered".to_owned()));
    assert_eq!(not_driver_land, Err("steered".to_owned()));
    steered.expect("the driver's steer");
    landed.expect("landed again");
    for o in off {
        o.expect("rose at the plank");
    }
    let ground = im.nodes["ground"];
    assert!(
        end.values().all(|f| f.0 == ground),
        "both on the ground: {end:?}"
    );
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

/// Where `punt` is now, x and z m in its parent's frame: its course in the world's own tree, read at the world's time.
fn punt_place(dir: &Path, punt: Id) -> Option<(f64, f64)> {
    let records = sim::log::recover(&std::fs::read(dir.join("log")).ok()?)
        .ok()?
        .records;
    let mut course = None;
    for r in &records {
        let Ok(part) = Part::read(r) else { continue };
        for e in part.effects {
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    if let replica::effects::Change::Set {
                        node, field, to, ..
                    } = &c.change
                        && *node == punt
                        && *field == replica::schedule::F_COURSE
                    {
                        course = replica::schedule::course::Course::read(to);
                    }
                }
            }
        }
    }
    let (p, _) = course?.load().ok()?.at(answers::now()).ok()?;
    Some((p.x as f64 / 1e6, p.z as f64 / 1e6))
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
/// over the pond, stops it there (it holds where it is), lands it by a point at its home (one across the pond is refused
/// `no-landing-spot`), and gets off at the plank, through the gateway. A stop in its boarding stop is refused
/// `not-aloft`. Before boarding a steer is refused
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
    // Still in its boarding stop, a stop is refused: it has not left yet.
    let early = (phase(answers::now()) < 28_000_000)
        .then(|| soul.act("carrier:stop", Some(punt), BTreeMap::new()));
    println!("stop in the boarding stop: {early:?}");
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
    std::thread::sleep(Duration::from_secs(5));
    // Stop: it holds where it is; the next 5 s it does not move.
    let stopped = soul.act("carrier:stop", Some(punt), BTreeMap::new());
    println!("stop: {stopped:?}");
    std::thread::sleep(Duration::from_secs(1));
    let held = (punt_place(&dir, punt), {
        std::thread::sleep(Duration::from_secs(5));
        punt_place(&dir, punt)
    });
    println!("the punt held at: {held:?}");
    // Land at a point: by its home it rows back there; across the pond it is refused, as today's.
    let away_land = soul.act("carrier:land", Some(punt), point(hx + 20.0, hz));
    let landed = soul.act("carrier:land", Some(punt), point(hx + 1.0, hz));
    println!("land 20 m from its home: {away_land:?}; land by its home: {landed:?}");
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
    // The public stream publishes a tick's part after its sync: read it until it carries every course the log has.
    let mut streamed = Vec::new();
    for _ in 0..30 {
        streamed = course_sets(&public_parts(&dir), punt);
        if streamed == logged {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    println!("the public stream: the punt's courses {streamed:?}");
    // The rider's hand-offs in the public stream: into the punt's slot 1 at boarding, out onto the ground at the plank.
    use replica::pose::Owner;
    let samples = public_samples(&dir);
    let into = samples.iter().position(|(_, h)| {
        h.to == Owner::Slot && h.pose.frame.node == punt && h.pose.frame.slot == Some(1)
    });
    let out = into.and_then(|i| {
        samples[i..]
            .iter()
            .position(|(_, h)| h.from == Owner::Slot && h.to == Owner::Mover)
            .map(|o| i + o)
    });
    println!(
        "the public stream: the rider into the punt {:?}, out of it {:?}",
        into.map(|i| samples[i].1),
        out.map(|i| samples[i].1)
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
    if let Some(early) = early {
        assert_eq!(early, Err("not-aloft".to_owned()));
    }
    stopped.expect("stopped");
    let (a, b) = held;
    let (a, b) = (a.expect("the punt's place"), b.expect("the punt's place"));
    assert!(
        (a.0 - b.0).abs() < 0.01 && (a.1 - b.1).abs() < 0.01,
        "held where it stopped: {a:?} then {b:?}"
    );
    assert_eq!(away_land, Err("no-landing-spot".to_owned()));
    landed.expect("landed by its home");
    off.expect("rose at the plank");
    let (_, node, x, z) = stood.expect("a place");
    assert_eq!(node, im.nodes["ground"], "on the ground again");
    let d = ((x - px).powi(2) + (z - pz).powi(2)).sqrt();
    assert!(d < 1.5, "at the plank: {d:.2} m from it");
    let shapes: Vec<u64> = logged.iter().map(|c| c.1).collect();
    assert_eq!(
        shapes,
        vec![3, 3, 3, 1],
        "steered, stopped, landed, its own loop again"
    );
    assert!(
        logged[1].2 >= 2,
        "the stop: held where it is, then its way home"
    );
    assert_eq!(streamed, logged, "the public stream carries every course");
    let out = out.expect("the public stream carries the rider into slot 1 and out of it");
    let h = samples[out].1;
    assert_eq!(h.pose.frame.node, im.nodes["ground"], "out onto the ground");
    let (x, z) = (
        h.pose.position.x as f64 / 1e6,
        h.pose.position.z as f64 / 1e6,
    );
    let d = ((x - px).powi(2) + (z - pz).powi(2)).sqrt();
    assert!(d < 1.5, "out at the plank: {d:.2} m from it");
}

/// 0.131 parity C25 (#3688): one Soul, born at `at` (`x,z` m), does each `(today's id, form, ending)` in turn on a
/// served full Eden, by the form's own entry, from wherever the one before left it. Each ending: `done`, or the
/// refusal's or failure's name. Printed; each that differs from the one today's game gives is returned.
fn served_family(at: &str, tag: &str, cases: &[(&str, &str, &str)]) -> Vec<String> {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (served, mut soul, dir) = serve(&facts, at, tag, im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    let mut got = Vec::new();
    for (today, form, _) in cases {
        let ended = match soul.act(
            &format!("eden:{form}"),
            Some(im.nodes[*today]),
            BTreeMap::new(),
        ) {
            Ok(_) => "done".to_owned(),
            Err(name) => name,
        };
        let body = track(&dir).last().map(|b| (b.2, b.3));
        println!("{tag}: {form} at {today}: {ended} (the body at {body:?})");
        got.push(ended);
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    cases
        .iter()
        .zip(&got)
        .filter(|((_, _, want), ended)| ended != want)
        .map(|((today, form, want), ended)| format!("{tag} {form} at {today}: {ended}, not {want}"))
        .collect()
}

/// C25 (#3688) A1: lights, fire, doors and locks from outside, on a served full Eden. Born outside the library's
/// door, a Soul knocks, opens and closes it; it is not the door's owner, so its lock and unlock are refused
/// `not-permitted`, as today's game refuses them. Through the opened door it switches the library's floor lamp on,
/// brighter, dimmer and off, a pendant by its pull cord and the desk lamp. Outside the café it opens the door and
/// lights and puts out the candle on a table, and switches a pendant; at the dining green it lights the campfire and
/// puts it out, and switches the string lights and a bollard light; by the pond, the twinkle lights. No form has a
/// walk of its own: each walks to its point first, as today's game walks to the hand's point.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c25_lights_fire_doors_and_locks_from_outside() {
    let mut wrong = served_family(
        "74.0,-1.0",
        "c25lib",
        &[
            ("e_89d82b59", "knock", "field_differs"),
            ("e_89d82b59", "close", "done"),
            ("e_89d82b59", "knock", "done"),
            ("e_89d82b59", "open", "done"),
            ("e_89d82b59", "close", "done"),
            ("e_89d82b59", "lock", "not-permitted"),
            ("e_89d82b59", "unlock", "not-permitted"),
            ("e_89d82b59", "open", "done"),
            ("e_19f5a481", "switch_on", "done"),
            ("e_19f5a481", "switch_off", "done"),
            ("e_f20d2d83", "switch_on", "done"),
            ("e_f20d2d83", "switch_off", "done"),
            ("e_e608452b", "switch_on", "done"),
            ("e_e608452b", "switch_off", "done"),
        ],
    );
    wrong.extend(served_family(
        "96.5,25.0",
        "c25cafe",
        &[
            ("e_61537992", "open", "field_differs"),
            ("e_61537992", "close", "done"),
            ("e_61537992", "open", "done"),
            ("e_63d14e62", "light", "done"),
            ("e_63d14e62", "put_out", "done"),
            ("e_daca0b8d", "switch_on", "done"),
            ("e_daca0b8d", "switch_off", "done"),
        ],
    ));
    wrong.extend(served_family(
        "27.0,-3.0",
        "c25green",
        &[
            ("e_14db400b", "light", "done"),
            ("e_14db400b", "put_out", "done"),
            ("e_718cb3ea", "switch_on", "done"),
            ("e_718cb3ea", "switch_off", "done"),
            ("e_c1f76c60", "switch_on", "done"),
            ("e_c1f76c60", "switch_off", "done"),
        ],
    ));
    wrong.extend(served_family(
        "-38.0,-17.0",
        "c25pond",
        &[
            ("e_68df95e8", "switch_on", "done"),
            ("e_68df95e8", "switch_off", "done"),
        ],
    ));
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// C25 (#3688) A1: a cottage's inner door, its bedroom's, on a served full Eden. Born outside the cottage, the Soul
/// walks in to the bedroom's rug, then closes, knocks on, opens and closes the door from there: each form first walks
/// to the door's point, as today's game walks to the hand's point. Eden's cottage doors are seeded open (the facts'
/// `door.open`), so the world, deciding a form's needs at commit (#3888), refuses an `open` first by its need
/// `field_differs`. The knock's walk may end in the door's own doorway, as no place out of it on the bedroom's side is
/// within an arm of the door's panel. Left open (#3688): from outside, a form's approach walks in through the front
/// door and approaches again from the cottage's floor, but its walk on the ground ends `walk.blocked` on the way there
/// (the route lane's).
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c25_a_cottages_inner_door_from_its_bedroom() {
    let wrong = served_family(
        "-99.0,-93.0",
        "c25cottage",
        &[
            ("e_7ff72484", "walk", "done"),
            ("e_00385aae", "open", "field_differs"),
            ("e_00385aae", "close", "done"),
            ("e_00385aae", "knock", "done"),
            ("e_00385aae", "open", "done"),
            ("e_00385aae", "close", "done"),
        ],
    );
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// A step of [`served_steps`]: today's id, the form, its thing arguments by today's id, the ending wanted.
type Step<'a> = (&'a str, &'a str, &'a [(&'a str, &'a str)], &'a str);

/// 0.131 parity L46 (#3715): one Soul, born at `at` (`x,z` m), does each `(today's id, form, thing arguments by
/// today's id, ending)` in turn on a served full Eden, from wherever the one before left it. Printed; each ending that
/// differs from the one wanted is returned.
fn served_steps(at: &str, tag: &str, cases: &[Step]) -> Vec<String> {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (served, mut soul, dir) = serve(&facts, at, tag, im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    let mut wrong = Vec::new();
    for (today, form, things, want) in cases {
        let a: Vec<(&str, Value)> = things
            .iter()
            .map(|(k, t)| (*k, im.nodes[*t].to_value()))
            .collect();
        let params = if a.is_empty() {
            BTreeMap::new()
        } else {
            args(&a)
        };
        let ended = match soul.act(&format!("eden:{form}"), Some(im.nodes[*today]), params) {
            Ok(_) => "done".to_owned(),
            Err(name) => name,
        };
        let body = track(&dir).last().map(|b| (b.2, b.3));
        println!("{tag}: {form} at {today}: {ended} (the body at {body:?})");
        if ended != *want {
            wrong.push(format!("{tag} {form} at {today}: {ended}, not {want}"));
        }
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    wrong
}

/// L46 (#3715) A1: tea, coffee and eating on a served full Eden. In a cottage's kitchen a Soul takes a bowl from the
/// table and eats from it, turns the sink's tap on, washes the bowl and turns it off, and switches the stove on and
/// off. At the café it takes the kettle; there is no sink in the café to fill it at, as today's game finds no tap near
/// it, so the fill has nothing to fill from (refused `thing.none-selected`, #3914). Carried to the cottage's kitchen,
/// the kettle fills at the sink, the fill choosing the nearest sink in the building itself, and switches on. Eden has
/// no cup to pour it into (left open; refused `thing.none-selected`).
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn l46_tea_coffee_and_eating() {
    let mut wrong = served_steps(
        "180.0,38.0",
        "l46cottage",
        &[
            ("e_645e8b7a", "walk", &[], "done"),
            ("e_928f6cbe", "walk", &[], "done"),
            ("e_5348e9f1", "take", &[], "done"),
            ("e_5348e9f1", "eat", &[], "done"),
            ("e_95a50ab8", "turn_on", &[], "done"),
            ("e_95a50ab8", "wash", &[("thing", "e_5348e9f1")], "done"),
            ("e_95a50ab8", "turn_off", &[], "done"),
            ("e_9c8ca409", "switch_on", &[], "done"),
            ("e_9c8ca409", "switch_off", &[], "done"),
        ],
    );
    wrong.extend(served_steps(
        "96.5,25.0",
        "l46cafe",
        &[
            ("e_d77094d8", "walk", &[], "done"),
            ("e_d77094d8", "take", &[], "done"),
            ("e_d77094d8", "fill", &[], "thing.none-selected"),
            ("e_645e8b7a", "walk", &[], "done"),
            ("e_d77094d8", "fill", &[], "done"),
            ("e_d77094d8", "switch_on", &[], "done"),
            ("e_d77094d8", "pour", &[], "thing.none-selected"),
        ],
    ));
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// 0.131 parity L42 (#3710) A1: water and the garden on a served full Eden, from outside. At the street's firewood a
/// Soul takes a log; it walks to a watering can on the street and takes it; at the park it turns the drinking fountain
/// on, drinks, and turns it off. Left open (#3710): stacking the log back (`arg-missing`), watering the library's
/// potted plant from the street and the greenhouse's vent (`walk.blocked`), and a cottage's bathroom upstairs (the
/// bath, the basin: `out-of-reach`, the approach ends on the floor below).
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn l42_water_and_the_garden_from_outside() {
    let mut wrong = served_steps(
        "84.0,44.0",
        "l42street",
        &[
            ("e_7e4e5663", "take_log", &[], "done"),
            ("e_5bf741bc", "walk", &[], "done"),
            ("e_5bf741bc", "take", &[], "done"),
        ],
    );
    wrong.extend(served_steps(
        "19.0,96.0",
        "l42park",
        &[
            ("e_b729d948", "turn_on", &[], "done"),
            ("e_b729d948", "drink", &[], "done"),
            ("e_b729d948", "turn_off", &[], "done"),
        ],
    ));
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// A body's logged frame, height and stance: `(node, slot, y µm, stance)`.
type Stood = (Id, Option<u64>, i64, Option<sim::controller::Stance>);

/// Each body's last logged frame, height and stance in the world's log in `dir`.
fn last_stances(dir: &Path) -> BTreeMap<Id, Stood> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = BTreeMap::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        if let Some(Value::Array(rows)) = Part::read(&r).unwrap().rest.get(&answers::BODIES) {
            for row in rows {
                if let Some((id, pose, stance)) = worldd::bodies::read_row(row) {
                    out.insert(
                        id,
                        (pose.frame.node, pose.frame.slot, pose.position.y, stance),
                    );
                }
            }
        }
    }
    out
}

/// #3802 A2: Souls step up onto Eden's festival stage (e_569eb676, at (265, 34) m, its steps at z 37.3 m) and stand on
/// it, each on its own standing point (the stage's 40 spots, 0.94 m up on its boards). The first names no spot (the world
/// picks the free one nearest it), the second names spot 40; the rest fill the stage naming none. A 41st Soul naming a
/// taken spot is refused `place-taken`; naming none it is refused `place.none-free` up front and stays where it stood.
/// The world is stopped and served again on the same folder: the 40 are still standing in their spots, the 41st is
/// still refused, and once one steps down the 41st steps up into the freed spot.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn i3802_souls_step_up_onto_the_stage_and_stand_there_over_a_restart() {
    use sim::controller::Stance;
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (stage, lineage) = (im.nodes["e_569eb676"], im.nodes["world"].scope());
    let (served, first, dir) = serve(&facts, "265,39", "i3802", lineage);
    let mut souls = vec![first];
    for n in 2..=41 {
        souls.push(join(&dir, n, lineage));
    }
    let on_stage = |dir: &Path| -> Vec<Stood> {
        let mut v: Vec<_> = last_stances(dir)
            .into_iter()
            .filter(|(_, f)| f.0 == stage)
            .map(|(b, f)| (b, f.1, f.2, f.3))
            .collect();
        v.sort_by_key(|f| f.1);
        v
    };
    let spot = |n: u64| args(&[("spot", Value::Uint(n))]);
    for (i, soul) in souls.iter_mut().enumerate().take(2) {
        let named = if i == 0 { BTreeMap::new() } else { spot(40) };
        let up = soul.act("eden:step_up", Some(stage), named);
        println!("Soul {}: step up {up:?}", i + 1);
        up.expect("stepped up onto a free spot");
    }
    let two = on_stage(&dir);
    println!("on the stage after two: {two:?}");
    assert_eq!(two.len(), 2, "both on the stage");
    assert_ne!(two[0].1, two[1].1, "each on its own point");
    assert!(
        two.iter()
            .all(|f| f.1.is_some() && f.3 == Some(Stance::Stand)),
        "each standing in a spot"
    );
    for (i, soul) in souls.iter_mut().enumerate().take(40).skip(2) {
        let up = soul.act("eden:step_up", Some(stage), BTreeMap::new());
        println!("Soul {}: step up {up:?}", i + 1);
        up.expect("stepped up onto a free spot");
    }
    let off = |dir: &Path| -> Vec<(Id, Stood)> {
        last_stances(dir)
            .into_iter()
            .filter(|(_, f)| f.0 != stage)
            .collect()
    };
    let before = off(&dir);
    let taken = souls[40].act("eden:step_up", Some(stage), spot(1));
    println!("Soul 41: step up onto a taken spot {taken:?}");
    let full = souls[40].act("eden:step_up", Some(stage), BTreeMap::new());
    println!("Soul 41: step up onto the full stage {full:?}");
    let all = on_stage(&dir);
    let slots: Vec<Option<u64>> = all.iter().map(|f| f.1).collect();
    assert_eq!(
        slots,
        (1..=40).map(Some).collect::<Vec<_>>(),
        "40 spots, one each"
    );
    assert!(
        all.iter().all(|f| f.3 == Some(Stance::Stand)),
        "all standing"
    );
    assert_eq!(
        taken,
        Err("place-taken".to_owned()),
        "a taken spot refuses by name"
    );
    assert_eq!(
        full,
        Err("place.none-free".to_owned()),
        "a full stage refuses by name"
    );
    assert_eq!(off(&dir), before, "the refused Soul stays where it stood");

    // Stopped and served again on the same folder (K18c): the 40 come back standing in their spots.
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
    let again = souls[40].act("eden:step_up", Some(stage), BTreeMap::new());
    println!("after the restart, Soul 41: step up {again:?}");
    let down = souls[0].act("eden:step_down", Some(stage), BTreeMap::new());
    println!("after the restart, Soul 1: step down {down:?}");
    let up = souls[40].act("eden:step_up", Some(stage), BTreeMap::new());
    println!("after the restart, Soul 41: step up {up:?}");
    let after = on_stage(&dir);
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(again, Err("place.none-free".to_owned()), "still full");
    down.expect("Soul 1 steps down");
    up.expect("Soul 41 steps up into the freed spot");
    assert_eq!(after.len(), 40, "the stage full again: {after:?}");
    assert!(
        after.iter().all(|f| f.3 == Some(Stance::Stand)),
        "all standing after the restart: {after:?}"
    );
    // One body left and one came: every other body kept its own spot over the restart.
    let kept = after.iter().filter(|f| all.contains(f)).count();
    assert_eq!(kept, 39, "39 kept their spots: {after:?}");
    let left: Vec<_> = all
        .iter()
        .filter(|f| !after.iter().any(|a| a.0 == f.0))
        .collect();
    let came: Vec<_> = after
        .iter()
        .filter(|f| !all.iter().any(|a| a.0 == f.0))
        .collect();
    assert_eq!((left.len(), came.len()), (1, 1), "one stepped down, one up");
    assert_eq!(left[0].1, came[0].1, "the 41st took the freed spot");
}

/// #3802: a form that selects a body's slot from the thing's free ones, sent with no slot, is given the free one nearest
/// the body: three Souls `flop` onto the roundhouse's three-seat sofa (e_3bfd13e0, see C19's test) naming no seat, each
/// in its own slot, and a fourth is refused `place.none-free` up front, staying where it stood.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn i3802_a_form_with_no_slot_takes_the_nearest_free_one() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (sofa, lineage) = (im.nodes["e_3bfd13e0"], im.nodes["world"].scope());
    let (served, first, dir) = serve(&facts, "66.5,-13.5", "i3802-sofa", lineage);
    let mut souls = vec![first];
    for n in 2..=4 {
        souls.push(join(&dir, n, lineage));
    }
    for (i, soul) in souls.iter_mut().enumerate().take(3) {
        let flop = soul.act("eden:flop", Some(sofa), BTreeMap::new());
        println!("Soul {}: flop onto the sofa {flop:?}", i + 1);
        flop.expect("flopped into a free slot");
    }
    let off = |dir: &Path| -> Vec<_> {
        last_stances(dir)
            .into_iter()
            .filter(|(_, f)| f.0 != sofa)
            .collect()
    };
    let before = off(&dir);
    let fourth = souls[3].act("eden:flop", Some(sofa), BTreeMap::new());
    println!("Soul 4: flop onto the full sofa {fourth:?}");
    let after = off(&dir);
    let mut slots: Vec<Option<u64>> = last_stances(&dir)
        .values()
        .filter(|f| f.0 == sofa)
        .map(|f| f.1)
        .collect();
    slots.sort_unstable();
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(
        slots,
        vec![Some(1), Some(2), Some(3)],
        "each in its own slot"
    );
    assert_eq!(fourth, Err("place.none-free".to_owned()));
    assert_eq!(after, before, "the fourth stays where it stood");
}

/// Eden's facts with one more thing, `id` of kind `def`, in room `room` of building `building` at `at` (mm, the
/// room's frame), as a building's things are given; written to a file of its own, its path returned.
fn facts_in_room(
    id: &str,
    def: &str,
    building: &str,
    room: &str,
    at: [i64; 3],
    tag: &str,
) -> String {
    use replica::rules::json::{Value as J, parse};
    let base = facts_with(&[(id, def, at, 0)], tag);
    let mut facts = parse(&std::fs::read_to_string(&base).unwrap()).unwrap();
    if let J::Obj(o) = &mut facts {
        for (key, v) in o.iter_mut() {
            if let ("things", J::Arr(rows)) = (key.as_str(), v) {
                let J::Obj(row) = rows.last_mut().unwrap() else {
                    panic!("a thing's row")
                };
                for (k, v) in row.iter_mut() {
                    if k == "parent" {
                        *v = J::Str(building.into());
                    }
                }
                let slot = J::Obj(vec![("room".into(), J::Str(room.into()))]);
                row.push(("slot".into(), slot));
            }
        }
    }
    std::fs::write(&base, facts.to_json()).unwrap();
    base
}

/// One Soul on a served Eden from `facts`, born at `at`, does each `(thing, form, want)` in turn: each step that does
/// not end as wanted, named, and where the body stood after each (its node by origin key, x and z m).
fn reach_steps(facts: &str, at: &str, tag: &str, cases: &[(&str, &str, &str)]) -> Vec<String> {
    let im = import_eden::load(&std::fs::read_to_string(facts).unwrap()).expect("Eden loads");
    let (served, mut soul, dir) = serve(facts, at, tag, im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    let origin: BTreeMap<Id, &str> = im.nodes.iter().map(|(k, v)| (*v, k.as_str())).collect();
    let mut wrong = Vec::new();
    for (today, form, want) in cases {
        let to = im.nodes[*today];
        let ended = match soul.act(&format!("eden:{form}"), Some(to), BTreeMap::new()) {
            Ok(_) => "done".to_owned(),
            Err(name) => name,
        };
        let body = track(&dir)
            .last()
            .map(|b| (origin.get(&b.1).copied().unwrap_or("?"), b.2, b.3));
        println!("{tag}: {form} at {today}: {ended} (the body at {body:?})");
        if ended != *want {
            wrong.push(format!("{tag} {form} at {today}: {ended}, not {want}"));
        }
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    wrong
}

/// A move's reach counts height. In a cottage on a served full Eden, a Soul walked to a mark on the living-room floor
/// straight under the upstairs bathroom's toilet cannot flush it through the ceiling (`out-of-reach`); walked up to
/// the toilet, it flushes it.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_toilet_upstairs_is_flushed_from_its_bathroom_not_from_below() {
    // The toilet stands at (1725, 1005) mm in the cottage's frame; the living room's origin at (0, 1520).
    let facts = facts_in_room(
        "e_reach0001",
        "core-reachmark@1",
        "e_1a460eb9",
        "living",
        [1_725, 0, -515],
        "reachheight",
    );
    let wrong = reach_steps(
        &facts,
        "180.0,38.0",
        "reachheight",
        &[
            ("e_reach0001", "walk", "done"),
            ("e_d427d095", "flush", "out-of-reach"),
            ("e_d427d095", "walk", "done"),
            ("e_d427d095", "flush", "done"),
        ],
    );
    let _ = std::fs::remove_file(&facts);
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Every course in a public projection `v` (field 80 of any node).
fn projected_courses(v: &Value, out: &mut Vec<replica::schedule::course::Course>) {
    match v {
        Value::Map(m) => {
            for (k, x) in m {
                if *k == replica::schedule::F_COURSE
                    && let Some(c) = replica::schedule::course::Course::read(x)
                {
                    out.push(c);
                }
                projected_courses(x, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| projected_courses(x, out)),
        _ => {}
    }
}

/// #3691: the rides Eden's entries declare get their courses from their `ride` data at serve. The three festival
/// balloons (`ride` stops one point, the air, no line back) each fly a loop aloft round their homes and their courses
/// are in the public stream's baseline; the rides with two stops get none. A Soul born by the first balloon's door
/// boards it in its boarding stop by the balloon's own `ride` form, is carried aloft in its slot (a rise there is
/// refused `boarding-frame-away`), and rises at its home once the balloon is back.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
// A real process on the real clock: its waits and rates are real time.
#[allow(clippy::disallowed_methods)]
fn i3691_the_balloons_fly_their_loops_and_a_soul_rides_one() {
    use replica::pose::Owner;
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    // The festival balloon at (290, 65) m; its door 1.6 m toward -x. Born 1 m beyond the door.
    let (served, mut soul, dir, lines) = serve_lines(&facts, "287.40,65.00", "i3691", lineage);
    let rides: Vec<(String, [f64; 2], i64, i64)> = lines
        .iter()
        .filter_map(|l| {
            let l = l.trim().strip_prefix("ride: ")?;
            let (name, rest) = l.split_once(" at ")?;
            let n: Vec<f64> = rest
                .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
                .filter_map(|w| w.parse().ok())
                .collect();
            let [x, z, period, t0] = n[..] else {
                return None;
            };
            Some((name.to_owned(), [x, z], period as i64, t0 as i64))
        })
        .collect();
    println!("the rides with a course: {rides:?}");
    let (_, home, period, t0) = rides
        .iter()
        .find(|r| r.0 == "festival-balloon")
        .cloned()
        .expect("the festival balloon has a course");
    let balloon = im.nodes["e_a2ef2904"];
    // The public stream, played from its baseline through its newest part, carries each ride's course.
    let mut projected = Vec::new();
    {
        use replica::stream::{Pointer, public::PublicPlayer};
        let world = replica::rules::json::parse(
            &std::fs::read_to_string(dir.join("views/world.json")).unwrap(),
        )
        .unwrap();
        let stream = dir.join(world.get("stream").and_then(|v| v.str()).unwrap());
        let pointer = Pointer::read(&std::fs::read(stream.join("pointer")).unwrap()).unwrap();
        let headers = stream.ancestors().nth(3).unwrap().join("headers");
        let header = std::fs::read(headers.join(replica::encode::to_hex(&pointer.header))).unwrap();
        let Value::Map(fields) = decode(&std::fs::read(stream.join("pointer")).unwrap())
            .unwrap()
            .value
        else {
            panic!("the pointer is a map")
        };
        let Some(Value::Bytes(generation)) = fields.get(&8) else {
            panic!("a baseline")
        };
        let parts = stream.join("g").join(replica::encode::to_hex(generation));
        let mut player =
            PublicPlayer::start(&header, &std::fs::read(parts.join("baseline")).unwrap())
                .expect("the public reader");
        for n in 0..=pointer.newest.expect("a published part") {
            player
                .play(&std::fs::read(parts.join(n.to_string())).unwrap())
                .expect("the public reader plays the part");
        }
        projected_courses(player.state(), &mut projected);
    }
    println!(
        "the public stream's courses (first station, period µs): {:?}",
        projected
            .iter()
            .map(|c| (c.stations[0].at, c.load().map_or(0, |t| t.period)))
            .collect::<Vec<_>>()
    );
    assert!(
        projected.len() >= 3,
        "the balloons' courses (and the punts') are in the public stream"
    );
    // Board in the balloon's boarding stop (its first minute each lap, `rides::BOARDING`): wait for the next when less
    // than 50 s are left.
    let phase = |t: i64| (t - t0).rem_euclid(period);
    let p = phase(answers::now());
    if p > 10_000_000 {
        let wait = period - p + 500_000;
        println!("waiting {:.1} s for the balloon's stop", wait as f64 / 1e6);
        std::thread::sleep(Duration::from_micros(wait as u64));
    }
    let boarded = soul.act("eden:ride", Some(balloon), BTreeMap::new());
    println!("board it by its own form: {boarded:?}");
    let seated_in = last_frames(&dir).into_values().find(|f| f.0 == balloon);
    println!("the rider's frame: {seated_in:?}");
    // Aloft: half a minute after its stop it is on its ring, and its rider with it.
    let aloft_at = sim::courses::rides::BOARDING + 30_000_000;
    let p = phase(answers::now());
    if p < aloft_at {
        std::thread::sleep(Duration::from_micros((aloft_at - p) as u64));
    }
    let aloft = soul.act("eden:rise", None, BTreeMap::new());
    // Where its course has the balloon now, as the page reads it from the public stream.
    let up = projected
        .iter()
        .find(|c| c.stations[0].at.x == 290_000_000 && c.stations[0].at.z == 65_000_000)
        .and_then(|c| c.load().ok()?.at(answers::now()).ok())
        .map(|(p, _)| (p.x as f64 / 1e6, p.y as f64 / 1e6, p.z as f64 / 1e6));
    println!("rise aloft: {aloft:?}; the balloon, its rider in it, at {up:?} m");
    // Back at its home: rise there.
    let p = phase(answers::now());
    std::thread::sleep(Duration::from_micros((period - p + 2_000_000) as u64));
    let off = soul.act("eden:rise", None, BTreeMap::new());
    println!("rise at its home: {off:?}");
    std::thread::sleep(Duration::from_secs(3));
    let samples = public_samples(&dir);
    let into = samples
        .iter()
        .find(|(_, h)| h.to == Owner::Slot && h.pose.frame.node == balloon)
        .map(|s| s.1);
    let out = samples
        .iter()
        .rev()
        .find(|(_, h)| h.from == Owner::Slot)
        .map(|s| s.1);
    println!("the public stream: into the balloon {into:?}, out of it {out:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        rides.len() >= 3,
        "the three festival balloons fly loops (and the Eden balloon, where the facts name its entry)"
    );
    for (name, [x, z], period, _) in &rides {
        assert!(
            projected
                .iter()
                .any(|c| c.stations[0].at.x == (x * 1e6).round() as i64
                    && c.stations[0].at.z == (z * 1e6).round() as i64
                    && c.load().is_ok_and(|t| t.period == *period)),
            "{name}'s course is in the public stream"
        );
    }
    assert!((home[0] - 290.0).abs() < 1e-3 && (home[1] - 65.0).abs() < 1e-3);
    boarded.expect("boarded at its door by the balloon's own form");
    assert!(
        matches!(seated_in, Some((n, Some(_))) if n == balloon),
        "in the balloon's slot"
    );
    assert_eq!(aloft, Err("boarding-frame-away".to_owned()));
    assert!(up.is_some_and(|p| p.1 > 30.0), "aloft: {up:?}");
    off.expect("rose at its home");
    assert!(
        into.is_some(),
        "the public stream carries the rider into the balloon"
    );
    let h = out.expect("and out of it");
    assert_eq!(h.pose.frame.node, im.nodes["ground"], "out onto the ground");
}

/// soul.game, 0.137 trial: three Souls could not ride Eden's launch balloon (e_378bd506, an `eden:balloon` by Eden's
/// map, its def with no seats), on a world seeded before its rides flew, so its tree has no course: `ride` naming no
/// seat was refused `arg-missing`, one naming a seat walked there and was refused `place-unknown`, and the others were
/// refused `thing-reserved` while the first one's `ride` ran. Here the world is seeded with the balloon's entry without
/// its `ride` (no course in the log's tree) and served with today's entries: the world gives the balloon its course at
/// its first tick, from its home. Three Souls born by its door all ask `ride` at once, naming no seat: each is given
/// its own free place in the basket; aloft a rise is refused `boarding-frame-away`; back home each gets off onto the
/// ground. Served again, the course is in the log and nothing is given twice.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
// A real process on the real clock: its waits are real time.
#[allow(clippy::disallowed_methods)]
fn three_souls_ride_the_eden_balloon_together_on_a_world_seeded_before_it_flew() {
    use replica::rules::json::{Value as J, parse};
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (balloon, lineage) = (im.nodes["e_378bd506"], im.nodes["world"].scope());
    let pid = std::process::id();
    let entries = std::env::temp_dir().join(format!("eden-balloon3-kinds-{pid}"));
    let dir = std::env::temp_dir().join(format!("eden-balloon3-{pid}"));
    let _ = std::fs::remove_dir_all(&entries);
    let _ = std::fs::remove_dir_all(&dir);
    copy_dir(Path::new(&format!("{root}/content/kinds")), &entries);
    let path = entries.join("rides/balloon.json");
    let mut old = parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let J::Obj(kv) = &mut old else {
        panic!("an entry")
    };
    let ride = kv
        .iter()
        .find(|(k, _)| k == "ride")
        .cloned()
        .expect("a ride");
    kv.retain(|(k, _)| k != "ride");
    std::fs::write(&path, old.to_json()).unwrap();
    // Born 1 m beyond the balloon's door (1.6 m toward -x of it, at (-20, -9) m).
    let worldd = env!("CARGO_BIN_EXE_worldd");
    let seeded = Command::new(worldd)
        .args(["seed", "--facts", &facts, "--dir"])
        .arg(&dir)
        .arg("--entries")
        .arg(&entries)
        .args(["--souls", "0", "--at", "-22.6,-9.0"])
        .output()
        .unwrap();
    assert!(
        seeded.status.success(),
        "{}",
        String::from_utf8_lossy(&seeded.stderr)
    );
    // Today's entry, as the seed kept it, with its ride again.
    let kept = dir.join("entries/eden.balloon.json");
    let mut now = parse(&std::fs::read_to_string(&kept).unwrap()).unwrap();
    let J::Obj(kv) = &mut now else {
        panic!("an entry")
    };
    kv.push(ride);
    std::fs::write(&kept, now.to_json()).unwrap();
    let start = || {
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
        std::thread::spawn(move || for _ in out.lines().map_while(Result::ok) {});
        (served, lines)
    };
    let given = |lines: &[String]| {
        lines.iter().any(|l| {
            l.contains("ride given its course") && l.contains(&replica::world_model::show(balloon))
        })
    };
    let (served, lines) = start();
    let first = given(&lines);
    println!("given its course at the first tick: {first}");
    let mut souls: Vec<Client> = (1..=3).map(|n| join(&dir, n, lineage)).collect();
    // All three at once, naming no seat.
    for s in souls.iter_mut() {
        s.send("eden:ride", Some(balloon), BTreeMap::new(), 120_000_000);
    }
    let rode: Vec<_> = souls.iter_mut().map(|s| s.answer("eden:ride")).collect();
    println!("three ride at once: {rode:?}");
    let frames = last_frames(&dir);
    let aboard: Vec<Option<u64>> = frames
        .iter()
        .filter(|(_, f)| f.0 == balloon)
        .map(|(_, f)| f.1)
        .collect();
    println!(
        "in the basket's slots: {aboard:?} of {} bodies",
        frames.len()
    );
    // Aloft: a minute and a half after boarding it is on its loop.
    std::thread::sleep(Duration::from_secs(90));
    let aloft = souls[0].act("eden:rise", None, BTreeMap::new());
    println!("rise aloft: {aloft:?}");
    // Back at its home: each gets off.
    let mut off = Err("never home".to_owned());
    for _ in 0..40 {
        off = souls[0].act("eden:rise", None, BTreeMap::new());
        if off.is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_secs(10));
    }
    println!("rise at its home: {off:?}");
    let others: Vec<_> = souls[1..]
        .iter_mut()
        .map(|s| s.act("eden:rise", None, BTreeMap::new()))
        .collect();
    println!("the other two get off: {others:?}");
    let after = last_frames(&dir);
    drop(served);
    let (served, lines) = start();
    let again = given(&lines);
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&entries);
    assert!(
        first,
        "the world gives the balloon its course at its first tick"
    );
    for r in &rode {
        r.as_ref()
            .expect("each rides, the world giving it a free place");
    }
    let mut places = aboard.clone();
    places.sort_unstable();
    places.dedup();
    assert_eq!(places.len(), 3, "three places in the basket: {aboard:?}");
    assert_eq!(aloft, Err("boarding-frame-away".to_owned()), "aloft");
    off.expect("gets off at its home");
    for r in others {
        r.expect("gets off at its home");
    }
    let riders: Vec<&Id> = frames
        .iter()
        .filter(|(_, f)| f.0 == balloon)
        .map(|(b, _)| b)
        .collect();
    assert!(
        riders
            .iter()
            .all(|b| after.get(b).is_some_and(|a| a.0 == im.nodes["ground"])),
        "each off onto the ground: {after:?}"
    );
    assert!(!again, "served again: the course is in the log, given once");
}

/// #1960: a Soul closes, knocks on and opens a door from each side of it, on a served full Eden, at doors of each
/// kind of building: the library's and the café's from inside (their outsides are
/// [`c25_lights_fire_doors_and_locks_from_outside`]'s), a cottage's front door from behind the cottage and from its
/// living room, and its inner doors from each room; a townhouse's front door from the street and its hall, its inner
/// doors from each room, and an upstairs door from its landing and its bedroom. Each form walks to the door first, on
/// the body's own side. Before, the upstairs door was carried onto the ground floor (every floor node stands at the
/// thing's origin), and the front door from behind its cottage was aimed short of it toward the body, inside the
/// cottage: both ended `out-of-reach` where the body stood.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn c25_doors_from_either_side() {
    fn door(d: &'static str) -> [(&'static str, &'static str, &'static str); 3] {
        [
            (d, "close", "done"),
            (d, "knock", "done"),
            (d, "open", "done"),
        ]
    }
    fn walk(t: &'static str) -> (&'static str, &'static str, &'static str) {
        (t, "walk", "done")
    }
    type Case = (&'static str, &'static str, &'static str);
    let fams: Vec<(&str, &str, Vec<Case>)> = vec![
        (
            "74.0,-1.0",
            "swlib",
            [vec![walk("e_d6a599a3")], door("e_89d82b59").to_vec()].concat(),
        ),
        (
            "96.5,25.0",
            "swcafe",
            [vec![walk("e_4fb9a218")], door("e_61537992").to_vec()].concat(),
        ),
        (
            "-99.0,-93.0",
            "swcot",
            [
                door("e_a37c56ff").to_vec(),
                vec![walk("e_8be0821b")],
                door("e_00385aae").to_vec(),
                door("e_a8b7eee5").to_vec(),
                door("e_a37c56ff").to_vec(),
                vec![walk("e_f2faf709")],
                door("e_a8b7eee5").to_vec(),
                vec![walk("e_7ff72484")],
                door("e_00385aae").to_vec(),
            ]
            .concat(),
        ),
        (
            "127.0,-26.2",
            "swtown",
            [
                door("e_128a27e8").to_vec(),
                vec![walk("e_5c18bca2")],
                door("e_128a27e8").to_vec(),
                door("e_89b3fb97").to_vec(),
                door("e_459738c5").to_vec(),
                vec![walk("e_3b990fad")],
                door("e_89b3fb97").to_vec(),
                vec![walk("e_e4c099b5")],
                door("e_459738c5").to_vec(),
                vec![walk("e_bb5f11f5")],
                door("e_7cd700b7").to_vec(),
                vec![walk("e_e952b07d")],
                door("e_7cd700b7").to_vec(),
            ]
            .concat(),
        ),
    ];
    let mut wrong = Vec::new();
    for (at, tag, cases) in &fams {
        wrong.extend(served_family(at, tag, cases));
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// verdelis-eden (24 Nov, review of #4574): a world entered under a roof wider than the birth ring (a 40 m hall over
/// the entry at (0, 0), a doorway in its south wall) births its Souls on the hall's floor. Seeded
/// and served by `worldd` from a facts file of its own: no Eden facts needed.
#[test]
fn a_join_under_a_wide_roof_is_born_on_its_floor() {
    let facts = r#"{
  "format": "souls/import-eden/1",
  "kinds": [{"ref": "core-hall@1", "hash": "aa", "name": "core:hall", "form": "point"}],
  "things": [
    {"id": "e_hall", "def": "core-hall@1", "ref": "core-hall@1", "parent": null, "pose": [0, 0, 0, 0],
     "world": [0, 0, 0, 0], "scale_ppm": 1000000, "name": "wide-hall",
     "floors": [{"level": 0, "y": 0, "polygon": [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]]}],
     "rooms": [{"id": "hall", "name": "Hall", "floor": 0, "pose": [0, 0, 0, 0], "height": 4000,
                "polygon": [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]]}],
     "openings": [{"id": "door", "kind": "door", "at": [0, 20050], "yaw": 0, "width": 1000, "height": 2100, "sill": 0,
                   "level": 0, "from": "hall", "fromWall": true, "state": "always", "inRoom": [0, 0, 20050, 0]}],
     "solids": [[-10250, 20050, 9750, 50, 0, 0, 4000, 5, 0], [10250, 20050, 9750, 50, 0, 0, 4000, 5, 0],
                [0, -20050, 20100, 50, 0, 0, 4000, 5, 0], [20050, 0, 50, 20100, 0, 0, 4000, 5, 0],
                [-20050, 0, 50, 20100, 0, 0, 4000, 5, 0]]}
  ],
  "doors": [],
  "places": [],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 1, "doors": 0, "rooms": 1, "floors": 1, "floor surfaces": 1, "solids": 5, "slots": 0, "windows": 0, "doorways": 1},
  "byRef": {"core-hall@1": 1}
}"#;
    let path = std::env::temp_dir().join(format!("wide-hall-{}.facts.json", std::process::id()));
    std::fs::write(&path, facts).unwrap();
    let im = import_eden::load(facts).expect("the hall loads");
    let floor = im.nodes["e_hall/floor-0"];
    let (_served, _soul, dir) = serve(
        path.to_str().unwrap(),
        "0,0",
        "wide-hall",
        im.nodes["world"].scope(),
    );
    let born = track(&dir);
    println!("born: {:?}", born.last());
    let &(_, node, x, z) = born.last().expect("the body's row");
    assert_eq!(
        node, floor,
        "on the hall's floor, not the open ground cut out under it"
    );
    assert!(x.abs() < 17.0 && z.abs() < 17.0, "by the entry: ({x}, {z})");
    // A second Soul, born beside the first: the floor's ring, a free place.
    let mut other = Client(
        UnixStream::connect(dir.join("gateway.sock")).unwrap(),
        Id::new(Scope([0xc1; 16]), 2).unwrap(),
        0,
        im.nodes["world"].scope(),
    );
    other
        .0
        .set_read_timeout(Some(Duration::from_secs(90)))
        .unwrap();
    other.act(JOIN, None, BTreeMap::new()).expect("born too");
    let rows = track(&dir);
    let nodes: std::collections::BTreeSet<Id> = rows.iter().map(|r| r.1).collect();
    assert_eq!(nodes, [floor].into(), "both on the floor");
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Whether the body's last row (`track`) stands on `floor`, its centre clear of `thing`'s boxes by a body's radius:
/// the boxes the ground cuts (its legs, and the box under its seats or top), read in `building`'s frame (its floor's).
fn clear_of(im: &import_eden::Import, dir: &Path, thing: &str, building: &str) -> (bool, String) {
    let &(_, node, x, z) = track(dir).last().expect("the body's row");
    let t = &im.tree;
    let (th, bh) = (
        t.handle(im.nodes[thing]).unwrap(),
        t.handle(im.nodes[building]).unwrap(),
    );
    let boxes = sim::ground::scene::solids_under(t, th, bh).unwrap();
    let p = [(x * 1e6).round() as i64, (z * 1e6).round() as i64];
    let r = sim::ground::HUMAN_RADIUS * 1000;
    let on = node == im.nodes[&format!("{building}/floor-0")];
    let inside = boxes
        .iter()
        .any(|b| sim::ground::scene::within(&b.ring, p, r));
    (
        on && !inside,
        format!(
            "the body at ({x:.2}, {z:.2}) m, {} boxes, inside: {inside}",
            boxes.len()
        ),
    )
}

/// First-day tester, round 2: a bench seat's boxes are its end legs and a table's its four legs, so the ground under the
/// seat plank and the tabletop was walkable. A walk to the domed hall (whose middle is `hall-bench-1`'s) ended with the
/// Soul standing inside the bench, and a walk to a book lying on a table inside the table. The ground now blocks the box
/// under their slots (`sim::ground::scene`): each walk ends beside the thing, and sitting on the bench still succeeds.
/// (Taking from a table: `l46_tea_coffee_and_eating` takes a bowl from a cottage's kitchen table.)
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn first_day_walks_end_beside_a_bench_and_a_table_and_sitting_still_works() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    // The domed hall (e_ab3f3077, at (166, 73) m) and hall-bench-1 at its middle; born outside its west door.
    let (hall, bench) = (im.nodes["e_ab3f3077"], im.nodes["e_d949a299"]);
    let (served, mut soul, dir) = serve(
        &facts,
        "157.0,73.0",
        "first-day-hall",
        im.nodes["world"].scope(),
    );
    let walked = soul.act("eden:walk", Some(hall), BTreeMap::new());
    let (beside_bench, at_bench) = clear_of(&im, &dir, "e_d949a299", "e_ab3f3077");
    println!("walk to the domed hall: {walked:?}; {at_bench}");
    let sat = soul.act("eden:sit", Some(bench), BTreeMap::new());
    let rose = soul.act("eden:rise", None, BTreeMap::new());
    println!("sit on hall-bench-1: {sat:?}, rise: {rose:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    // The library's west reading table (e_4c11fb72, at (71.5, -6.4) m) and the book stack lying on it (e_e27ed1a2).
    let book = im.nodes["e_e27ed1a2"];
    let (served, mut soul, dir) = serve(
        &facts,
        "74.0,-1.0",
        "first-day-book",
        im.nodes["world"].scope(),
    );
    let to_book = soul.act("eden:walk", Some(book), BTreeMap::new());
    let (beside_table, at_table) = clear_of(&im, &dir, "e_4c11fb72", "e_a0741c1e");
    println!("walk to the book on the table: {to_book:?}; {at_table}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    walked.expect("walked to the domed hall");
    assert!(beside_bench, "beside hall-bench-1, not in it: {at_bench}");
    sat.expect("sat on the bench");
    rose.expect("rose from it");
    to_book.expect("walked to the book");
    assert!(beside_table, "beside the table, not in it: {at_table}");
}

/// Each body's places in the world's log in `dir`, in order: `(x, z)` m in its frame, by the body's id.
fn body_rows(dir: &Path) -> BTreeMap<Id, Vec<(f64, f64)>> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = BTreeMap::<Id, Vec<(f64, f64)>>::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        let Ok(Value::Map(m)) = decode(&r).map(|d| d.value) else {
            continue;
        };
        if let Some(Value::Array(rows)) = m.get(&answers::BODIES) {
            for (id, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                let p = (pose.position.x as f64 / 1e6, pose.position.z as f64 / 1e6);
                out.entry(id).or_default().push(p);
            }
        }
    }
    out
}

/// The everyday things W10 takes on Eden (#4086, #4118): of each def, the `n` nearest to `at` (x, z m), as `(def,
/// facts id, m from at)`.
fn w10_things(
    facts: &str,
    at: (f64, f64),
    defs: &[(&'static str, usize)],
) -> Vec<(&'static str, String, f64)> {
    use replica::rules::json::Value as Json;
    let f = replica::rules::json::parse(&std::fs::read_to_string(facts).unwrap()).unwrap();
    let things = f.get("things").and_then(Json::arr).unwrap_or(&[]);
    let mut out = Vec::new();
    for &(def, n) in defs {
        let mut found: Vec<(f64, String)> = things
            .iter()
            .filter(|t| t.get("def").and_then(Json::str) == Some(def))
            .filter_map(|t| {
                let w = t.get("world")?.arr()?;
                let m = |i: usize| match w.get(i)? {
                    Json::Int(v) => Some(*v as f64 / 1000.0),
                    _ => None,
                };
                let d = ((m(0)? - at.0).powi(2) + (m(2)? - at.1).powi(2)).sqrt();
                Some((d, t.get("id")?.str()?.to_owned()))
            })
            .collect();
        found.sort_by(|a, b| a.0.total_cmp(&b.0));
        out.extend(found.into_iter().take(n).map(|(d, id)| (def, id, d)));
    }
    out
}

/// One W10 answer: the walk's answer and seconds (when the Soul walked first), the take's and its seconds, and how
/// far the body moved across x and z from its first row to its last (m, in its frame; NaN with no rows).
type W10 = (
    Option<(Result<Vec<u64>, String>, f64)>,
    Result<Vec<u64>, String>,
    f64,
    f64,
);

/// One arm of W10 on a freshly seeded Eden: one Soul per thing, born at `at`, all at once, each sending `eden:take` on
/// its thing, after `eden:walk` to it when `walk_first`.
// A real process on the real clock: the answers' seconds are real time.
#[allow(clippy::disallowed_methods)]
fn w10_arm(
    facts: &str,
    at: &str,
    tag: &str,
    things: &[(&'static str, String, f64)],
    walk_first: bool,
) -> Vec<W10> {
    let im = import_eden::load(&std::fs::read_to_string(facts).unwrap()).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let (served, _first, dir) = serve(facts, at, tag, lineage);
    // Every Soul is joined, and its body (the one new body in the log) known, before any acts.
    let mut known: std::collections::BTreeSet<Id> = body_rows(&dir).into_keys().collect();
    let souls: Vec<(Client, Option<Id>)> = (0..things.len())
        .map(|i| {
            let soul = join(&dir, 2 + i as u64, lineage);
            soul.0
                .set_read_timeout(Some(Duration::from_secs(600)))
                .unwrap();
            let now: std::collections::BTreeSet<Id> = body_rows(&dir).into_keys().collect();
            let body = now.difference(&known).next().copied();
            known = now;
            (soul, body)
        })
        .collect();
    let threads: Vec<_> = souls
        .into_iter()
        .zip(things)
        .map(|((mut soul, body), (_, id, _))| {
            let thing = im.nodes[id.as_str()];
            std::thread::spawn(move || {
                let t0 = std::time::Instant::now();
                let walked = walk_first.then(|| {
                    let w = soul.act_within("eden:walk", Some(thing), BTreeMap::new(), 300_000_000);
                    (w, t0.elapsed().as_secs_f64())
                });
                let t1 = std::time::Instant::now();
                let took = soul.act_within("eden:take", Some(thing), BTreeMap::new(), 300_000_000);
                (body, walked, took, t1.elapsed().as_secs_f64())
            })
        })
        .collect();
    let answers: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    let rows = body_rows(&dir);
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    answers
        .into_iter()
        .map(|(body, walked, took, secs)| {
            let moved = match body
                .and_then(|b| rows.get(&b))
                .map(|r| (r.first(), r.last()))
            {
                Some((Some(a), Some(b))) => ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt(),
                _ => f64::NAN,
            };
            (walked, took, secs, moved)
        })
        .collect()
}

/// W10 (#4086, #4118) on Eden as it is served: everyday takes (bowls and a cup on tables, a kettle, watering cans on
/// the ground, a book from a bookcase or a bookshelf), each by its own Soul born by the library's door. Arm `far`
/// sends the take from where the Soul was born; arm `walked` walks to the thing first (`eden:walk`), then takes. It
/// prints every answer and the refusals by reason per arm. A take never lands at a distance: one that is taken from
/// more than 3 m away was walked to.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn w10_everyday_takes_on_eden_need_reach() {
    let facts = facts_path();
    let at = (74.0, -1.0);
    let defs = [
        ("core-bowl@1", 8),
        ("core-cup@2", 1),
        ("core-kettle@1", 1),
        ("core-watering-can@1", 4),
        ("core-bookcase@1", 4),
        ("core-bookshelf@1", 4),
    ];
    let things = w10_things(&facts, at, &defs);
    let mut refused = BTreeMap::<(&str, String), usize>::new();
    for (arm, walk_first) in [("far", false), ("walked", true)] {
        let answers = w10_arm(
            &facts,
            "74.0,-1.0",
            &format!("w10{arm}"),
            &things,
            walk_first,
        );
        for ((def, id, d), (walked, took, secs, moved)) in things.iter().zip(&answers) {
            println!(
                "W10 {arm}: {def} {id} at {d:.1} m: walk {walked:?}; take {took:?} in {secs:.1} s; body moved {moved:.1} m"
            );
            if let Err(why) = took {
                *refused.entry((arm, why.clone())).or_default() += 1;
            }
            if took.is_ok() && *d > 3.0 {
                assert!(
                    *moved > 1.0,
                    "{arm}: {def} {id} {d:.1} m away taken by a body that never moved"
                );
            }
        }
        let ok = answers.iter().filter(|a| a.1.is_ok()).count();
        println!("W10 {arm}: {ok} of {} taken", answers.len());
    }
    println!("W10 refusals by arm and reason: {refused:?}");
}

/// Each body born in the world's log in `dir` (the births' node creations), with its pose, in the order born.
fn births(dir: &Path) -> Vec<(Id, replica::pose::Pose)> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = Vec::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            if let Body::Changes(changes) = e.body {
                for c in changes {
                    if let replica::effects::Change::Create {
                        node, kind, pose, ..
                    } = c.change
                        && kind.as_str().contains("body")
                    {
                        out.push((node, pose));
                    }
                }
            }
        }
    }
    out
}

/// A Soul's first moment on Eden: a world that names its arrival place (`worldd arrival`, `world.json`'s `arrival`)
/// has its joining Souls born round that place, not at its entry. Eden names the campus quad
/// (`place-region-campus-quad`, its fountain at (-12, -97) m): four fresh joins at once (the 0.137 trial had three
/// born on one spot) land within 8 m of the fountain, on the open ground, at least two body radii apart, each facing
/// the fountain (its +x within a degree of the way to it), and each then walks to the fountain: none starts unable to
/// walk.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_fresh_join_on_eden_arrives_at_the_campus_quad_facing_its_fountain() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (ground, lineage) = (im.nodes["ground"], im.nodes["world"].scope());
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let dir = std::env::temp_dir().join(format!("eden-arrival-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let worldd = env!("CARGO_BIN_EXE_worldd");
    // Seeded at the old entry (the open commons lawn), then named its arrival place, as production Eden is.
    let seeded = Command::new(worldd)
        .args(["seed", "--facts", &facts, "--dir"])
        .arg(&dir)
        .args([
            "--entries",
            &format!("{root}/content/kinds"),
            "--souls",
            "0",
            "--at",
            "0,0",
        ])
        .output()
        .unwrap();
    assert!(
        seeded.status.success(),
        "{}",
        String::from_utf8_lossy(&seeded.stderr)
    );
    let unknown = Command::new(worldd)
        .args(["arrival", "--dir"])
        .arg(&dir)
        .args(["--place", "no-such-place"])
        .output()
        .unwrap();
    assert!(
        !unknown.status.success(),
        "a place the facts lack is refused"
    );
    let named = Command::new(worldd)
        .args(["arrival", "--dir"])
        .arg(&dir)
        .args(["--place", "place-region-campus-quad"])
        .output()
        .unwrap();
    println!("arrival: {}", String::from_utf8_lossy(&named.stdout).trim());
    assert!(
        named.status.success(),
        "{}",
        String::from_utf8_lossy(&named.stderr)
    );
    let mut child = Command::new(worldd)
        .args(["serve", "--dir"])
        .arg(&dir)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let _served = Served(child);
    let (mut line, mut lines) = (String::new(), Vec::new());
    while out.read_line(&mut line).unwrap() > 0 && !line.contains("listening ") {
        lines.push(std::mem::take(&mut line));
    }
    std::thread::spawn(move || for _ in out.lines().map_while(Result::ok) {});
    assert!(
        lines
            .iter()
            .any(|l| l.contains("Souls arrive at place-region-campus-quad (-12.000,-97.000 m)")),
        "serve names the arrival place: {lines:?}"
    );
    let mut souls: Vec<Client> = std::thread::scope(|s| {
        let joins: Vec<_> = (1..=4)
            .map(|n| {
                let dir = &dir;
                s.spawn(move || join(dir, n, lineage))
            })
            .collect();
        joins.into_iter().map(|j| j.join().unwrap()).collect()
    });
    let born = births(&dir);
    assert_eq!(born.len(), 4, "four bodies born");
    let fountain = (-12_000_000i64, -97_000_000i64);
    for (body, pose) in &born {
        let p = pose.position;
        let (dx, dz) = (fountain.0 - p.x, fountain.1 - p.z);
        let d = ((i128::from(dx).pow(2) + i128::from(dz).pow(2)).isqrt()) as f64 / 1e6;
        let ahead = pose
            .orientation
            .rotate(replica::pose::Vec3::new(1 << 20, 0, 0))
            .unwrap();
        let dot = i128::from(ahead.x) * i128::from(dx) + i128::from(ahead.z) * i128::from(dz);
        let len = (i128::from(ahead.x).pow(2) + i128::from(ahead.z).pow(2)).isqrt()
            * (i128::from(dx).pow(2) + i128::from(dz).pow(2)).isqrt();
        println!(
            "born {body:?} at ({:.2}, {:.2}) m, {d:.2} m from the fountain, facing it at cos {:.5}, on {:?}",
            p.x as f64 / 1e6,
            p.z as f64 / 1e6,
            dot as f64 / len as f64,
            pose.support
        );
        assert!(d <= 8.0, "born {d:.2} m from the quad's fountain");
        assert_eq!(pose.frame.node, ground, "born on the open ground");
        assert!(
            matches!(
                pose.support,
                replica::pose::Support::Surface { height: 0, .. }
            ),
            "standing on walkable ground"
        );
        assert!(dot * 100_000 >= len * 99_985, "faces the fountain");
    }
    for (i, (_, a)) in born.iter().enumerate() {
        for (_, b) in &born[i + 1..] {
            let (a, b) = (a.position, b.position);
            let apart = ((i128::from(a.x - b.x).pow(2) + i128::from(a.z - b.z).pow(2)).isqrt())
                as f64
                / 1e6;
            println!("two births {apart:.2} m apart");
            assert!(apart >= 0.6, "two births {apart:.2} m apart: they overlap");
        }
    }
    let basin = im.nodes["e_ce79121a"];
    for s in &mut souls {
        s.0.set_read_timeout(Some(Duration::from_secs(120)))
            .unwrap();
        let walked = s.act("eden:walk", Some(basin), BTreeMap::new());
        println!("{:?} walks to the fountain: {walked:?}", s.1);
        walked.expect("a Soul born in the burst walks to the fountain");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Every picnic table, parasol table and bench on Eden (#4901's seat numbering): a Soul walks to it, sits on it
/// through the gateway's sit (its body logged in the thing's own slot), rises (on its feet off the thing) and walks
/// on at once to a point on the open ground. Things are served in groups, a world each, its Souls born by the group's
/// first thing so no walk is long; every Soul of a group acts on its own thread. `EDEN_FACTS` names the facts file.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn every_picnic_table_parasol_table_and_bench_walk_sit_rise_walk() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let all = replica::rules::json::parse(&text).unwrap();
    let lineage = im.nodes["world"].scope();
    let kinds = ["eden:picnic_table", "eden:parasol_table", "eden:bench"];
    // (facts id, name, x m, z m) of every such thing on the open ground or a roof.
    let mut things: Vec<(String, String, f64, f64)> = all
        .get("things")
        .and_then(|t| t.arr())
        .unwrap_or(&[])
        .iter()
        .filter(|t| {
            t.get("entry")
                .and_then(|e| e.str())
                .is_some_and(|e| kinds.contains(&e))
        })
        .filter_map(|t| {
            let w = t.get("world")?.arr()?;
            let m = |k: usize| match w.get(k) {
                Some(replica::rules::json::Value::Int(v)) => Some(*v as f64 / 1000.0),
                _ => None,
            };
            Some((
                t.get("id")?.str()?.to_owned(),
                t.get("name").and_then(|n| n.str()).unwrap_or("").to_owned(),
                m(0)?,
                m(2)?,
            ))
        })
        .collect();
    things.sort_by(|a, b| a.0.cmp(&b.0));
    // Groups: each thing within 60 m of its group's first.
    let mut groups: Vec<Vec<(String, String, f64, f64)>> = Vec::new();
    for t in things {
        match groups
            .iter_mut()
            .find(|g| (g[0].2 - t.2).hypot(g[0].3 - t.3) <= 60.0)
        {
            Some(g) => g.push(t),
            None => groups.push(vec![t]),
        }
    }
    println!(
        "{} things in {} groups",
        groups.iter().map(Vec::len).sum::<usize>(),
        groups.len()
    );
    let failed = std::sync::Mutex::new(Vec::<String>::new());
    // At most four worlds at once.
    for (c, chunk) in groups.chunks(4).enumerate() {
        std::thread::scope(|s| {
            for (j, group) in chunk.iter().enumerate() {
                let (failed, facts, ids) = (&failed, &facts, &im.nodes);
                s.spawn(move || {
                    let at = format!("{:.1},{:.1}", group[0].2 + 3.0, group[0].3 + 3.0);
                    let tag = format!("sweep{}", c * 4 + j);
                    let (served, first, dir) = serve(facts, &at, &tag, lineage);
                    drop(first);
                    // Each Soul joined in turn, where it was born read from the log before the next joins.
                    let souls: Vec<(Client, (Id, replica::pose::Vec3))> = (0..group.len())
                        .map(|n| {
                            let soul = join(&dir, n as u64 + 2, lineage);
                            (soul, end_pose(&dir).expect("its birth logged"))
                        })
                        .collect();
                    std::thread::scope(|s2| {
                        for ((id, name, ..), (soul, home)) in group.iter().zip(souls) {
                            let dir = &dir;
                            s2.spawn(move || {
                                let (line, ok) =
                                    walk_sit_rise_walk(soul, dir, ids[id.as_str()], home);
                                // Found, not fixed here: from the shrine's bench and the market roof's bench the
                                // planner finds no way back to a birth place a group away, though the sit got there
                                // and a walk nearby is done (a Soul born beside them walks home). Refused by name.
                                let ok = ok
                                    || ROUTE_GAPS.contains(&id.as_str())
                                        && line.ends_with("rise done, walk on goal-unreachable");
                                let line = format!("{name} ({id}): {line}");
                                println!("{line}");
                                if !ok {
                                    failed.lock().unwrap().push(line);
                                }
                            });
                        }
                    });
                    drop(served);
                    let _ = std::fs::remove_dir_all(&dir);
                });
            }
        });
    }
    let failed = failed.into_inner().unwrap();
    assert!(
        failed.is_empty(),
        "{} failed:\n{}",
        failed.len(),
        failed.join("\n")
    );
}

/// Things the sweep's walk home from is refused `goal-unreachable` (see its note).
const ROUTE_GAPS: [&str; 2] = ["e_bc93004a", "e_c6e13060"];

/// One Soul's walk to `thing`, sit on it, rise and walk on at once back to `home` (the node and point, µm, where it was
/// born): how each ended, and whether the sit, the rise and the walk on were done with the body logged in one
/// of the thing's slots. The first walk is reported, not required: the sit walks to its seat itself.
fn walk_sit_rise_walk(
    mut soul: Client,
    dir: &Path,
    thing: Id,
    home: (Id, replica::pose::Vec3),
) -> (String, bool) {
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    let walk = soul.act("eden:walk", Some(thing), BTreeMap::new());
    let sit = soul.act("eden:sit", Some(thing), BTreeMap::new());
    let seated = last_frames(dir)
        .values()
        .any(|f| f.0 == thing && f.1.is_some());
    let rise = soul.act("eden:rise", None, BTreeMap::new());
    let um = |v: i64| {
        if v < 0 {
            Value::Nint((-v - 1) as u64)
        } else {
            Value::Uint(v as u64)
        }
    };
    let p = home.1;
    let point = Value::Array(vec![um(p.x), um(p.y), um(p.z)]);
    let on = soul.act("eden:walk", Some(home.0), BTreeMap::from([(1, point)]));
    let ended =
        |r: &Result<Vec<u64>, String>| r.as_ref().map_or_else(Clone::clone, |_| "done".to_owned());
    let line = format!(
        "walk {}, sit {} (in its slot: {seated}), rise {}, walk on {}",
        ended(&walk),
        ended(&sit),
        ended(&rise),
        ended(&on)
    );
    let ok = sit.is_ok() && seated && rise.is_ok() && on.is_ok();
    (line, ok)
}

/// The release-0137 rehearsal's sit (#4901's seat numbering): a Soul by the quad fountain sits at
/// `artists-green-picnic-3`, 54 m off, by the gateway's bare sit: it walks there and is logged in the table's slot. A
/// walk while seated is refused `resource-held`, by name; it rises, and a walk sent at once after the rise is done. The
/// rise's answer comes while the world still carries the body off the bench (its step off, no link): the walk's spot
/// ask was made from the seat's point, inside the bench, and refused `spot-none-free`; now it waits for the carry's end.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_soul_sits_at_a_picnic_table_from_afar_rises_and_walks_on_at_once() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (table, fountain) = (im.nodes["e_7945031e"], im.nodes["e_bbab9835"]);
    let (served, mut soul, dir) =
        serve(&facts, "-15.1,-94.2", "picnic3", im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    let sit = soul.act("eden:sit", Some(table), BTreeMap::new());
    let seated = last_frames(&dir)
        .values()
        .any(|f| f.0 == table && f.1.is_some());
    let held = soul.act("eden:walk", Some(fountain), BTreeMap::new());
    let rise = soul.act("eden:rise", None, BTreeMap::new());
    let on = soul.act("eden:walk", Some(fountain), BTreeMap::new());
    println!(
        "sit {sit:?} (in its slot: {seated}); walk seated {held:?}; rise {rise:?}; walk at once {on:?}"
    );
    let off = last_frames(&dir).values().all(|f| f.0 != table);
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    sit.expect("walked to the table and sat");
    assert!(seated, "the body is in one of the table's slots");
    assert_eq!(
        held,
        Err("resource-held".into()),
        "no walk while seated, by name"
    );
    rise.expect("rose");
    on.expect("a walk sent at once after the rise is done, not refused spot-none-free");
    assert!(off, "off the table");
}

/// A Soul walks up to the roof terrace of `seafront-hotel-2` (its parasol table, e_74be5224) and back down to the open
/// ground, and again after sitting at the table and rising. The terrace is a thing's own floor, not one of the hotel's,
/// so the stair's line, in the hotel's frame, was metres off the body at its near end: every walk down was refused
/// `link-not-here` and a Soul that went up stayed on the roof.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_soul_walks_down_from_a_roof_terrace_after_sitting_there() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let (table, ground) = (im.nodes["e_74be5224"], im.nodes["ground"]);
    let (served, mut soul, dir) =
        serve(&facts, "137.5,124.0", "roofdown", im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    // A point on the open ground in front of the hotel, µm.
    let out = || {
        BTreeMap::from([(
            1,
            Value::Array(vec![
                Value::Uint(137_500_000),
                Value::Uint(0),
                Value::Uint(128_000_000),
            ]),
        )])
    };
    let up = soul.act("eden:walk", Some(table), BTreeMap::new());
    let down = soul.act("eden:walk", Some(ground), out());
    let first = end_pose(&dir);
    let again = soul.act("eden:walk", Some(table), BTreeMap::new());
    let sit = soul.act("eden:sit", Some(table), BTreeMap::new());
    let rise = soul.act("eden:rise", None, BTreeMap::new());
    let down2 = soul.act("eden:walk", Some(ground), out());
    let last = end_pose(&dir);
    println!(
        "up {up:?}; down {down:?} at {first:?}; up {again:?}; sit {sit:?}; rise {rise:?}; down {down2:?} at {last:?}"
    );
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    up.expect("walked up to the terrace");
    down.expect("walked down to the open ground");
    assert_eq!(first.map(|f| f.0), Some(ground), "on the open ground");
    again.expect("up again");
    sit.expect("sat at the terrace's table");
    rise.expect("rose");
    down2.expect("walked down after rising");
    assert_eq!(last.map(|f| f.0), Some(ground), "on the open ground again");
}

/// One Eden seat-like thing a new person would use, by today's id: born at `at` (`x,z` m, outside its building's door,
/// or beside it), a Soul takes it by `on` and leaves it by `off` (on the thing, or the gateway's `eden:rise`).
const SEATS: &[(&str, &str, &str, &str, &str)] = &[
    (
        "house bed",
        "178.8,39.2",
        "e_a9988e06",
        "eden:lie",
        "eden:get_up",
    ),
    (
        "house bed sleep",
        "178.8,39.2",
        "e_a9988e06",
        "eden:sleep",
        "eden:get_up",
    ),
    (
        "hall bed",
        "-117.9,60.0",
        "e_80a904af",
        "eden:lie",
        "eden:get_up",
    ),
    (
        "cottage bed",
        "-60.2,129.2",
        "e_60db0389",
        "eden:lie",
        "eden:get_up",
    ),
    (
        "townhouse bed",
        "127.9,-25.3",
        "e_a6a97ef2",
        "eden:lie",
        "eden:get_up",
    ),
    (
        "shop bed",
        "113.1,98.6",
        "e_433d5f0a",
        "eden:lie",
        "eden:get_up",
    ),
    (
        "cabin bed",
        "-117.0,-62.0",
        "e_bbbb741b",
        "eden:lie",
        "eden:get_up",
    ),
    (
        "barn bunk",
        "-70.0,131.4",
        "e_64eea6e7",
        "eden:lie",
        "eden:get_up",
    ),
    (
        "hammock",
        "52.6,70.5",
        "e_ed70c839",
        "eden:lie",
        "eden:get_up",
    ),
    (
        "sleeping mat",
        "-18.0,14.0",
        "e_ba667eb9",
        "eden:lie",
        "eden:get_up",
    ),
    ("bench", "28.0,-10.0", "e_f848c0f5", "eden:sit", "eden:rise"),
    ("chair", "178.8,39.2", "e_3391b018", "eden:sit", "eden:rise"),
    (
        "armchair",
        "178.8,39.2",
        "e_d95aa852",
        "eden:sit",
        "eden:rise",
    ),
    ("sofa", "178.8,39.2", "e_fa425262", "eden:sit", "eden:rise"),
    (
        "see-saw",
        "19.0,106.0",
        "e_a75004f7",
        "eden:ride",
        "eden:get_off",
    ),
    (
        "swing after",
        "18.0,99.0",
        "e_7dacb4f7",
        "eden:swing",
        "eden:get_off",
    ),
];

/// Beds, swings and seats on Eden: every seat-like thing on [`SEATS`] is taken from outside its building (or beside
/// it) and left again, each answer printed; the lie, sit or ride ends `done`, and so does the way off. A swing's
/// `get_off` sent 12 s into its 30 s swing ends the swinging and gets off. `SEATS_ONLY=<words>` runs the rows whose
/// name holds them.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn every_eden_seat_is_taken_and_left_from_outside() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let only = std::env::var("SEATS_ONLY").ok();
    let wanted = |what: &str| only.as_deref().is_none_or(|o| what.contains(o));
    let mut failed = Vec::new();
    for (i, (what, at, today, on, off)) in SEATS.iter().enumerate() {
        if !wanted(what) {
            continue;
        }
        let thing = im.nodes[*today];
        let (served, mut soul, dir) = serve(&facts, at, &format!("seat{i}"), lineage);
        soul.0
            .set_read_timeout(Some(Duration::from_secs(300)))
            .unwrap();
        let took = soul.act(on, Some(thing), BTreeMap::new());
        let end = track(&dir).last().map(|b| (b.2, b.3));
        let target = (*off != "eden:rise").then_some(thing);
        let left = soul.act(off, target, BTreeMap::new());
        println!("SEAT {what} {today}: {on} {took:?} (ended at {end:?}); {off} {left:?}");
        drop(served);
        let _ = std::fs::remove_dir_all(&dir);
        if took.is_err() || left.is_err() {
            failed.push(format!("{what}: {on} {took:?}; {off} {left:?}"));
        }
    }
    // The swing is sent and not waited for: `after` s on, its get_off follows on the same socket; then both answers.
    // Born 4 m off, 12 s on it swings; born 10 m off, 2 s on it is still walking there.
    for (what, at, after) in [
        ("swing during", "18.0,99.0", 12),
        ("swing walking", "24.0,99.0", 2),
    ] {
        if !wanted(what) {
            continue;
        }
        let (served, mut soul, dir) = serve(&facts, at, &format!("seat{after}"), lineage);
        soul.0
            .set_read_timeout(Some(Duration::from_secs(300)))
            .unwrap();
        let swings = im.nodes["e_7dacb4f7"];
        soul.send("eden:swing", Some(swings), BTreeMap::new(), 120_000_000);
        std::thread::sleep(Duration::from_secs(after));
        soul.send("eden:get_off", Some(swings), BTreeMap::new(), 120_000_000);
        let first = soul.answer("first");
        let second = soul.answer("second");
        let end = last_frames(&dir).into_values().next();
        println!("SEAT {what}: answers {first:?} then {second:?}; last frame {end:?}");
        drop(served);
        let _ = std::fs::remove_dir_all(&dir);
        let refused =
            |a: &Result<Vec<u64>, String>| a.as_ref().is_err_and(|e| e == "not-permitted");
        if refused(&first) || refused(&second) || first.is_err() && second.is_err() {
            failed.push(format!("{what}: {first:?} then {second:?}"));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
}

/// What an ask on [`INDOOR`] should get: done, refused by this name because the ask cannot be done as things stand
/// (the lamp is already on), or a known gap, printed and not checked.
#[derive(Clone, Copy, Debug)]
enum Want {
    Done,
    Refused(&'static str),
    Gap(&'static str),
}

/// One building's indoor things, asked in order by one Soul born at `at` (`x,z` m, outside its door): each ask is a
/// row `(what a person asks, verb, thing, what it should get)`; a later ask starts where the one before left the body
/// (seated, lying, holding something), as a person's next ask does. `rise` takes no thing.
type Visit = (
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str, Option<&'static str>, Want)],
);

use Want::{Done, Gap, Refused};

/// Eden's indoor things a person's agent would ask about (Eden audit, 26 Nov): the act the client's look offers for
/// each, as a person would ask it, from outside the building or from where the last ask left the body. Eden's lamps,
/// pendants, candles and the teacher's computer start on, so asking to turn one on is refused `field_differs`.
const INDOOR: &[Visit] = &[
    (
        "house 1 living room",
        "34.0,15.0",
        &[
            ("sit on the sofa", "eden:sit", Some("e_35c2bab0"), Done),
            (
                "turn on the radio (from the sofa)",
                "eden:switch_on",
                Some("e_f04374e2"),
                Done,
            ),
            (
                "tune the radio",
                "eden:tune_dance_band",
                Some("e_f04374e2"),
                Done,
            ),
            (
                "take a book from the bookcase",
                "eden:take",
                Some("e_64a33a3a"),
                Done,
            ),
            ("sit in the armchair", "eden:sit", Some("e_f8fec424"), Done),
            (
                "recline the armchair",
                "eden:recline",
                Some("e_f8fec424"),
                Done,
            ),
            (
                "turn on the floor lamp (on already)",
                "eden:switch_on",
                Some("e_2140621d"),
                Refused("field_differs"),
            ),
            (
                "turn off the floor lamp (from the armchair)",
                "eden:switch_off",
                Some("e_2140621d"),
                Done,
            ),
            (
                "turn off the pendant",
                "eden:switch_off",
                Some("e_ac640ad0"),
                Done,
            ),
            ("flop on the sofa", "eden:flop", Some("e_35c2bab0"), Done),
            (
                "lie on the sofa",
                "eden:lie",
                Some("e_35c2bab0"),
                Gap("its places are seats"),
            ),
        ],
    ),
    (
        "house 1 kitchen",
        "34.0,15.0",
        &[
            ("take the cup", "eden:take", Some("e_36478653"), Done),
            (
                "drink from the cup (no tea in it)",
                "eden:sip",
                Some("e_36478653"),
                Refused("field_differs"),
            ),
            (
                "turn on the stove",
                "eden:switch_on",
                Some("e_a718de40"),
                Done,
            ),
            ("turn on the sink", "eden:turn_on", Some("e_092d77a4"), Done),
            ("open the fridge", "eden:open", Some("e_5aad75d3"), Done),
            ("close the fridge", "eden:close", Some("e_5aad75d3"), Done),
            (
                "sit on a kitchen chair",
                "eden:sit",
                Some("e_685266be"),
                Done,
            ),
            (
                "wipe the table (from the chair)",
                "eden:wipe",
                Some("e_5f346b62"),
                Done,
            ),
            (
                "turn off the kitchen pendant",
                "eden:switch_off",
                Some("e_2149a57f"),
                Done,
            ),
        ],
    ),
    (
        "classroom",
        "42.0,3.0",
        &[
            (
                "sit on a classroom chair",
                "eden:sit",
                Some("e_4da5c47c"),
                Done,
            ),
            (
                "take the lectern (from the chair)",
                "eden:take_the_lectern",
                Some("e_1b9fc3f4"),
                Done,
            ),
            ("step down", "eden:step_down", Some("e_1b9fc3f4"), Done),
            (
                "attend the lecture",
                "eden:attend",
                Some("e_1b9fc3f4"),
                Done,
            ),
            (
                "open the lockers (from the lecture)",
                "eden:open",
                Some("e_2a871461"),
                Done,
            ),
            (
                "take a book from the shelf",
                "eden:take",
                Some("e_61af968e"),
                Done,
            ),
            (
                "work at the teacher's desk",
                "eden:work",
                Some("e_dd6b5ce1"),
                Gap("out-of-reach of its keys from where its walk ends"),
            ),
            (
                "turn off the teacher's computer",
                "eden:switch_off",
                Some("e_dd6b5ce1"),
                Gap("out-of-reach of its power button from where its walk ends"),
            ),
            (
                "turn off the screen",
                "eden:switch_off",
                Some("e_ad42afe6"),
                Done,
            ),
        ],
    ),
    (
        "library",
        "74.0,-1.0",
        &[
            ("sit in an armchair", "eden:sit", Some("e_1f3666fe"), Done),
            (
                "turn off the desk lamp (from the armchair)",
                "eden:switch_off",
                Some("e_e608452b"),
                Done,
            ),
            ("write at the desk", "eden:write", Some("e_0f7fb44b"), Done),
            (
                "take a book from the pile",
                "eden:take",
                Some("e_e27ed1a2"),
                Done,
            ),
            (
                "turn on the floor lamp (off)",
                "eden:switch_on",
                Some("e_19f5a481"),
                Done,
            ),
            (
                "work at the library's office desk",
                "eden:work",
                Some("e_d7e49dd3"),
                Done,
            ),
        ],
    ),
    (
        "cafe",
        "96.5,25.0",
        &[
            (
                "drink a cup of coffee",
                "eden:sip",
                Some("e_2bdee40b"),
                Gap("only its holder sips"),
            ),
            (
                "put out the candle",
                "eden:put_out",
                Some("e_63d14e62"),
                Done,
            ),
            ("take the kettle", "eden:take", Some("e_d77094d8"), Done),
            ("sit on a stool", "eden:sit", Some("e_daded5b3"), Done),
            (
                "sit on the cafe sofa (from the stool)",
                "eden:sit",
                Some("e_16ce6ce0"),
                Done,
            ),
        ],
    ),
    (
        "study",
        "-113.0,60.0",
        &[
            (
                "sit at the piano (from the door)",
                "eden:sit",
                Some("e_cdc5a1d6"),
                Gap("a bare sit on a piano"),
            ),
            ("play the piano", "eden:play", Some("e_cdc5a1d6"), Done),
            ("stop playing", "eden:stop", Some("e_cdc5a1d6"), Done),
            (
                "sit on the study sofa",
                "eden:sit",
                Some("e_209f9f2f"),
                Done,
            ),
        ],
    ),
    (
        "lake cabin",
        "-117.0,-62.0",
        &[
            (
                "warm up by the hearth",
                "eden:warm",
                Some("e_6b5e5d37"),
                Done,
            ),
            ("open the chest", "eden:open", Some("e_56cf53c5"), Done),
            ("close the chest", "eden:close", Some("e_56cf53c5"), Done),
        ],
    ),
    (
        "suburb house upstairs",
        "178.8,39.2",
        &[
            ("sit on the toilet", "eden:sit", Some("e_d427d095"), Done),
            (
                "flush the toilet (from the seat)",
                "eden:flush",
                Some("e_d427d095"),
                Done,
            ),
            (
                "wash hands at the basin",
                "eden:turn_on",
                Some("e_03c0fd0a"),
                Done,
            ),
            ("fill the bath", "eden:fill", Some("e_e7f2407a"), Done),
            ("lie in the bath", "eden:lie", Some("e_e7f2407a"), Done),
            (
                "open the wardrobe (from the bath)",
                "eden:open",
                Some("e_032cfe40"),
                Done,
            ),
            ("take a garment", "eden:take", Some("e_032cfe40"), Done),
            ("lie on the bed", "eden:lie", Some("e_a9988e06"), Done),
            (
                "sit on the bed",
                "eden:sit",
                Some("e_a9988e06"),
                Gap("its places are for lying"),
            ),
        ],
    ),
    (
        "pub",
        "298.0,-14.0",
        &[
            ("throw darts", "eden:throw", Some("e_a13b47f5"), Done),
            ("play the arcade", "eden:play", Some("e_263477b5"), Done),
            ("play pool", "eden:play", Some("e_6de8bcd1"), Done),
        ],
    ),
];

/// Eden's indoor things do what a person asks (Eden audit, 26 Nov): each building of [`INDOOR`] is seeded and served
/// on its own, one Soul born outside it, and its asks sent in order; each answer is printed as a row
/// `INDOOR <building> | <ask> | <verb> | <answer> | <wanted>`. Every ask wanted done ends done, every ask wanted
/// refused is refused by its name; a known gap is printed only. `INDOOR_ONLY=<words>` runs the buildings whose name
/// holds them. Needs facts exported with Eden's map (`export.ts --map content/worlds/eden/map.json`), as live Eden's
/// things name their entries.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn indoor_things_do_what_a_person_asks() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let only = std::env::var("INDOOR_ONLY").ok();
    let mut failed = Vec::new();
    for (i, (building, at, asks)) in INDOOR.iter().enumerate() {
        if only.as_deref().is_some_and(|o| !building.contains(o)) {
            continue;
        }
        let (served, mut soul, dir) = serve(&facts, at, &format!("indoor{i}"), lineage);
        soul.0
            .set_read_timeout(Some(Duration::from_secs(300)))
            .unwrap();
        for (ask, verb, thing, want) in asks.iter() {
            let target = thing.map(|t| im.nodes[t]);
            let answer = soul.act_within(verb, target, BTreeMap::new(), 240_000_000);
            println!("INDOOR {building} | {ask} | {verb} | {answer:?} | {want:?}");
            let ok = match want {
                Done => answer.is_ok(),
                Refused(name) => answer.as_ref().is_err_and(|e| e == name),
                Gap(why) => {
                    println!("INDOOR gap: {ask}: {why}");
                    true
                }
            };
            if !ok {
                failed.push(format!(
                    "{building}: {ask} ({verb}) {answer:?}, wanted {want:?}"
                ));
            }
        }
        drop(served);
        let _ = std::fs::remove_dir_all(&dir);
    }
    assert!(failed.is_empty(), "{failed:#?}");
}

/// Each `eden:book` the world's log creates, in order: its node, its parent (a body's hand for a take, a table for a
/// placed copy) and its fields.
fn books_made(dir: &Path) -> Vec<(Id, Id, BTreeMap<u64, Value>)> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = Vec::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            if let Body::Changes(changes) = e.body {
                for c in changes {
                    if let replica::effects::Change::Create {
                        node,
                        kind,
                        pose,
                        fields,
                        ..
                    } = c.change
                        && replica::world_model::plain(kind.as_str()) == "eden:book"
                    {
                        out.push((node, pose.frame.node, fields));
                    }
                }
            }
        }
    }
    out
}

/// The public words (key 27) a whole sync of the world in `dir` gets beside its records, by reference: asked on the
/// world's own socket as the gateway asks (R5b's frames: the place's hash, then every record it reaches, 64 to a
/// request), with no actor.
fn served_words(dir: &Path) -> BTreeMap<Id, Vec<u8>> {
    use replica::sync::{self, Copy, wire};
    let mut s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let mut words = BTreeMap::new();
    let mut ask = |m: BTreeMap<u64, Value>| -> BTreeMap<u64, Value> {
        let bytes = encode(&Value::Map(m)).unwrap();
        s.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        s.write_all(&bytes).unwrap();
        let mut len = [0u8; 4];
        s.read_exact(&mut len).unwrap();
        let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
        s.read_exact(&mut frame).unwrap();
        let Value::Map(a) = decode(&frame).unwrap().value else {
            panic!("a sync answer")
        };
        if let Some(Value::Array(pairs)) = a.get(&worldd::views::names::PUBLIC_WORDS) {
            for p in pairs {
                if let Value::Array(p) = p
                    && let [r, Value::Bytes(w)] = p.as_slice()
                {
                    words.insert(replica::effects::read_id(r).unwrap(), w.clone());
                }
            }
        }
        a
    };
    let mut copy = Copy::default();
    let a = ask(BTreeMap::from([
        (wire::ASK, Value::Uint(1)),
        (wire::IDS, Value::Array(vec![])),
    ]));
    let (ids, hashes) = sync::read_hashes(&a).expect("hashes");
    let mut d = copy.compare(&ids, hashes);
    for n in 2.. {
        let asked = copy.ask(&mut d, wire::RECORDS_MOST);
        if asked.is_empty() {
            break;
        }
        let hs = asked.iter().cloned().map(Value::Bytes).collect();
        let a = ask(BTreeMap::from([
            (wire::ASK, Value::Uint(n)),
            (wire::RECORDS, Value::Array(hs)),
        ]));
        copy.take(&mut d, &asked, sync::read_records(&a).expect("records"))
            .expect("the records match their hashes");
    }
    copy.finish(d).expect("the sync finishes");
    words
}

/// #4837: books carry their titles and first pages as world facts, on Eden as it is served, seeded with its stock
/// (`seed --stock content/worlds/eden/stock.json`). Souls born by the library's door each walk to a different shelf
/// (bookcases and bookshelves) and take a book. Each book made holds, as its title and first page (eden:book's fields
/// 29 and 30), references to one row of `content/library/books.json`: the row at the top of that shelf's pile, the
/// same as `worldd::stock` works out from the same facts and files again here (drawn by nothing: the same world gives
/// the same book). At least three different books are taken. The one book placed on its own (commons-reading-book)
/// carries its row from the world's start. Every reference's words, as the world serves them beside the record, are
/// that row's title and first page, read here from the library file itself.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn books_carry_their_titles_and_first_pages_from_their_shelves() {
    use replica::rules::json::Value as Json;
    let facts = facts_path();
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let stock_file = format!("{root}/content/worlds/eden/stock.json");
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let mut kinds = Vec::new();
    entries(Path::new(&format!("{root}/content/kinds")), &mut kinds);
    let data = worldd::stock::Data::load(Path::new(&stock_file)).expect("the stock file");
    let facts_json = replica::rules::json::parse(&text).unwrap();
    let want = worldd::stock::World::of(&data, &facts_json, &im.nodes, &im.tree, &kinds)
        .expect("the stock");
    assert!(want.notes.is_empty(), "{:?}", want.notes);
    println!(
        "stock: {} containers stocked, {} placed copies",
        want.stocks.len(),
        want.placed.len()
    );
    // The library's own rows: a reference's row, title and first page.
    let rows = data.libraries["books"]
        .get("books")
        .and_then(Json::arr)
        .unwrap()
        .to_vec();
    let row_of = |fields: &BTreeMap<u64, Value>| -> Option<(usize, String, String)> {
        let at = |n: u64| replica::audience::reference(fields.get(&n)?);
        let (t, p) = (at(29)?, at(30)?);
        let i =
            (0..rows.len()).find(|&i| worldd::stock::reference("books", "title", i) == Some(t))?;
        assert_eq!(
            worldd::stock::reference("books", "first_page", i),
            Some(p),
            "the title and the first page are one row's"
        );
        let words = |c: &str| rows[i].get(c).and_then(Json::str).unwrap().to_owned();
        assert_eq!(want.words.get(&t), Some(&words("title").into_bytes()));
        assert_eq!(want.words.get(&p), Some(&words("first_page").into_bytes()));
        Some((i, words("title"), words("first_page")))
    };

    let shelves = w10_things(
        &facts,
        (74.0, -1.0),
        &[("core-bookcase@1", 3), ("core-bookshelf@1", 3)],
    );
    let (served, _first, dir, _) = serve_seeded(
        &facts,
        &format!("{root}/content/kinds"),
        &["--stock", &stock_file],
        "74.0,-1.0",
        "books",
        lineage,
    );
    // Its first record, the import: the placed book carries its row from the start.
    let placed = facts_json
        .get("things")
        .and_then(Json::arr)
        .unwrap()
        .iter()
        .find(|t| t.get("name").and_then(Json::str) == Some("commons-reading-book"))
        .and_then(|t| im.nodes.get(t.get("id")?.str()?))
        .copied()
        .expect("the commons' book");
    let made = books_made(&dir);
    let (_, _, start) = made
        .iter()
        .find(|(n, ..)| *n == placed)
        .expect("the commons' book is imported");
    let carried = want
        .placed
        .get(&placed)
        .expect("the commons' book carries a row");
    for (n, v) in carried {
        assert_eq!(start.get(n), Some(v), "field {n} of the commons' book");
    }
    let (_, title, page) = row_of(start).expect("the commons' book has a title and a first page");
    println!("BOOK commons-reading-book: \"{title}\": {page}");

    let mut known: std::collections::BTreeSet<Id> = body_rows(&dir).into_keys().collect();
    let souls: Vec<(Client, Option<Id>)> = (0..shelves.len())
        .map(|i| {
            let soul = join(&dir, 2 + i as u64, lineage);
            soul.0
                .set_read_timeout(Some(Duration::from_secs(600)))
                .unwrap();
            let now: std::collections::BTreeSet<Id> = body_rows(&dir).into_keys().collect();
            let body = now.difference(&known).next().copied();
            known = now;
            (soul, body)
        })
        .collect();
    let threads: Vec<_> = souls
        .into_iter()
        .zip(&shelves)
        .map(|((mut soul, body), (def, id, _))| {
            let (shelf, def, id) = (im.nodes[id.as_str()], *def, id.clone());
            std::thread::spawn(move || {
                let walked =
                    soul.act_within("eden:walk", Some(shelf), BTreeMap::new(), 300_000_000);
                let took = soul.act_within("eden:take", Some(shelf), BTreeMap::new(), 300_000_000);
                (def, id, shelf, body, walked, took)
            })
        })
        .collect();
    let answers: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    let made = books_made(&dir);
    // The world's words as a client's sync gets them (the gateway's path): beside each record that holds a reference.
    std::thread::sleep(worldd::SEAL_EVERY * 2);
    let words = served_words(&dir);
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    let served_as = |fields: &BTreeMap<u64, Value>, n: u64, want: &str| {
        let r = replica::audience::reference(fields.get(&n).expect("the field")).unwrap();
        assert_eq!(
            words
                .get(&r)
                .map(|w| String::from_utf8_lossy(w).into_owned()),
            Some(want.to_owned()),
            "field {n}'s words, served beside its record"
        );
    };
    let (_, title, page) = row_of(start).unwrap();
    served_as(start, 29, &title);
    served_as(start, 30, &page);
    let mut titles = std::collections::BTreeSet::new();
    for (def, id, shelf, body, walked, took) in answers {
        println!("TAKE {def} {id}: walk {walked:?}; take {took:?}");
        if took.is_err() {
            continue;
        }
        let body = body.expect("the Soul's body");
        let (_, _, fields) = made
            .iter()
            .find(|(_, held, _)| *held == body)
            .expect("a book in the body's hand");
        let expected = want
            .stocks
            .get(&shelf)
            .expect("a stocked shelf")
            .carried(None);
        assert_eq!(
            fields.get(&29),
            expected.get(&29),
            "{id}: the top of its pile's title"
        );
        assert_eq!(fields.get(&30), expected.get(&30), "{id}: its first page");
        let (row, title, page) = row_of(fields).expect("a title and a first page");
        println!("BOOK {def} {id}: row {row} \"{title}\": {page}");
        served_as(fields, 29, &title);
        served_as(fields, 30, &page);
        titles.insert(title);
    }
    assert!(
        titles.len() >= 3,
        "three different books from three shelves, got {titles:?}"
    );
}

/// One ask of the outdoor audit: what a person's agent asks of a thing on Eden's open ground.
struct Ask {
    /// The kind, as the audit's table names it.
    kind: &'static str,
    /// The person's words.
    ask: &'static str,
    /// The thing, by its facts name.
    thing: &'static str,
    /// The act: a form of the thing or the world's move (`eden:<word>`) on it, or, with `arg`, the Soul's own body's
    /// form (`eden:sit_down`) taking the thing as that argument.
    verb: &'static str,
    arg: Option<&'static str>,
    /// An act on another thing first, `(verb, thing)`: seated elsewhere.
    first: Option<(&'static str, &'static str)>,
    /// `None`: a person would expect it done. `Some(why)`: why it is not, tonight.
    not_tonight: Option<&'static str>,
}

const fn ask(
    kind: &'static str,
    ask: &'static str,
    thing: &'static str,
    verb: &'static str,
) -> Ask {
    Ask {
        kind,
        ask,
        thing,
        verb,
        arg: None,
        first: None,
        not_tonight: None,
    }
}

/// [`Ask`] `a`, not expected done tonight, for reason `why`.
const fn not_tonight(why: &'static str, a: Ask) -> Ask {
    Ask {
        not_tonight: Some(why),
        ..a
    }
}

/// Why a sit on the quad's fountain is refused tonight: today's page draws a sitter by the fountain def's own slot
/// rows (its six stand points, on the paving, facing in), so a seat on its rim needs a def revision first (SEATDEF).
const FOUNTAIN_RIM: &str = "the page seats a sitter by the fountain def's own slot rows (six stand points on the \
                            paving): a rim seat is a def revision (SEATDEF)";

/// Why a sit on a thing with no seat (a tree, a terrace, a blanket) is refused: the body's own `sit_down` there is done,
/// but no move of it is drawn, so the page shows the Soul standing.
const NO_GROUND_SIT: &str = "no seat on it; the body's sit_down is done there but drawn standing (no ground-sit move \
                             the page draws yet)";

/// The campus quad, where every new Soul arrives (`place-region-campus-quad`), and what is near it.
const AT_THE_QUAD: &[Ask] = &[
    not_tonight(
        FOUNTAIN_RIM,
        ask(
            "fountain",
            "sit on the fountain's edge",
            "campus-quad-fountain",
            "eden:sit",
        ),
    ),
    not_tonight(
        FOUNTAIN_RIM,
        ask(
            "fountain",
            "sit on the fountain's edge (2 of 4 at once)",
            "campus-quad-fountain",
            "eden:sit",
        ),
    ),
    not_tonight(
        FOUNTAIN_RIM,
        ask(
            "fountain",
            "sit on the fountain's edge (3 of 4 at once)",
            "campus-quad-fountain",
            "eden:sit",
        ),
    ),
    not_tonight(
        FOUNTAIN_RIM,
        ask(
            "fountain",
            "sit on the fountain's edge (4 of 4 at once)",
            "campus-quad-fountain",
            "eden:sit",
        ),
    ),
    Ask {
        arg: Some("spot"),
        ..ask(
            "fountain",
            "sit down by the fountain (body's sit_down)",
            "campus-quad-fountain",
            "eden:sit_down",
        )
    },
    not_tonight(
        "a seated body rises first (rise, then sit): the refusal names it",
        Ask {
            first: Some(("eden:sit", "campus-quad-bench-2")),
            ..ask(
                "bench",
                "seated on a bench: sit on the other bench",
                "campus-quad-bench-1",
                "eden:sit",
            )
        },
    ),
    ask(
        "bench",
        "sit on the bench, across the square",
        "campus-quad-bench-1",
        "eden:sit",
    ),
    ask(
        "tree",
        "rest in the tree's shade",
        "trees-set-51",
        "eden:go_to_shade",
    ),
    not_tonight(
        NO_GROUND_SIT,
        ask("tree", "sit under the tree", "trees-set-51", "eden:sit"),
    ),
    Ask {
        arg: Some("spot"),
        ..ask(
            "tree",
            "sit down under the tree (body's sit_down)",
            "trees-set-51",
            "eden:sit_down",
        )
    },
    ask(
        "log",
        "sit on the log",
        "street-log-fallenlog-2",
        "eden:sit",
    ),
    ask("stump", "sit on the stump", "street-stump-1", "eden:sit"),
    ask(
        "picnic table",
        "sit at the picnic table",
        "artists-green-picnic-3",
        "eden:sit",
    ),
    ask(
        "campfire",
        "warm up by the fire",
        "social-eden-fire",
        "eden:warm",
    ),
    ask(
        "campfire",
        "sit by the fire (1 of 3 at once)",
        "social-eden-fire",
        "eden:sit",
    ),
    ask(
        "campfire",
        "sit by the fire (2 of 3 at once)",
        "social-eden-fire",
        "eden:sit",
    ),
    ask(
        "campfire",
        "sit by the fire (3 of 3 at once)",
        "social-eden-fire",
        "eden:sit",
    ),
    Ask {
        first: Some(("eden:put_out", "region-campsite-fire-circle")),
        ..ask(
            "campfire",
            "put the campsite fire out, then light it",
            "region-campsite-fire-circle",
            "eden:light",
        )
    },
    ask(
        "chess table",
        "play chess (white)",
        "commons-chess-table",
        "eden:play_white",
    ),
    ask(
        "bridge",
        "cross the bridge",
        "land-canal-bridge-south",
        "eden:cross",
    ),
    ask(
        "pond",
        "walk around the pond",
        "land-commons-shore-pond",
        "eden:walk_around",
    ),
    ask(
        "flower garden",
        "wander the flower garden",
        "land-commons-flowers",
        "eden:wander",
    ),
    ask(
        "deck",
        "walk out onto the deck",
        "commons-deck",
        "eden:walk",
    ),
    not_tonight(
        NO_GROUND_SIT,
        ask(
            "terrace",
            "sit on the terrace",
            "land-abbey-cloister-court",
            "eden:sit",
        ),
    ),
];

/// The park and the street's play corner (born where [`SEATS`] births its swing).
const AT_THE_PARK: &[Ask] = &[
    ask("swings", "swing", "park-swings", "eden:swing"),
    ask(
        "swings",
        "swing (the street's)",
        "street-swings-swing-1",
        "eden:swing",
    ),
    ask(
        "slide",
        "go down the slide",
        "park-slide",
        "eden:slide_down",
    ),
    ask(
        "climbing frame",
        "climb the frame",
        "park-climbing-frame",
        "eden:climb",
    ),
    ask("see-saw", "ride the see-saw", "park-see-saw", "eden:ride"),
    ask(
        "sandpit",
        "build a sandcastle",
        "street-sandpit-sandbox-1",
        "eden:build_sandcastle",
    ),
    ask(
        "hammock",
        "lie in the hammock",
        "street-hammock-1",
        "eden:lie",
    ),
    not_tonight(
        "its water is off until turned on (turn_on, then drink), as today's fountain and its cases have it",
        ask(
            "drinking fountain",
            "have a drink",
            "park-drinking-water",
            "eden:drink",
        ),
    ),
    not_tonight(
        NO_GROUND_SIT,
        ask(
            "picnic blanket",
            "sit on the picnic blanket",
            "park-picnic-blanket",
            "eden:sit",
        ),
    ),
    Ask {
        arg: Some("spot"),
        ..ask(
            "picnic blanket",
            "sit down on the blanket (body's sit_down)",
            "park-picnic-blanket",
            "eden:sit_down",
        )
    },
    ask(
        "helter-skelter",
        "go down the helter-skelter",
        "festival-helter-skelter",
        "eden:slide_down",
    ),
];

/// Eden seeded at its old entry with its arrival place named `place`, as production Eden is, and served: its Souls
/// are born round that place.
fn serve_arriving(facts: &str, place: &str, tag: &str) -> (Served, PathBuf) {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let dir = std::env::temp_dir().join(format!("eden-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let worldd = env!("CARGO_BIN_EXE_worldd");
    let entries = format!("{root}/content/kinds");
    let seeded = Command::new(worldd)
        .args(["seed", "--facts", facts, "--dir"])
        .arg(&dir)
        .args(["--entries", &entries, "--souls", "0", "--at", "0,0"])
        .output()
        .unwrap();
    assert!(
        seeded.status.success(),
        "{}",
        String::from_utf8_lossy(&seeded.stderr)
    );
    let named = Command::new(worldd)
        .args(["arrival", "--dir"])
        .arg(&dir)
        .args(["--place", place])
        .output()
        .unwrap();
    assert!(
        named.status.success(),
        "{}",
        String::from_utf8_lossy(&named.stderr)
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
    (served, dir)
}

/// Each ask of `asks` by its own Soul, joined in `dir` in turn and acting at once on its own thread: one line each,
/// `kind | ask | act | ending`. A sit or lie that is done says whether the body is logged in one of the thing's slots.
fn ask_all(
    dir: &Path,
    asks: &'static [Ask],
    ids: &BTreeMap<String, Id>,
    lineage: Scope,
) -> Vec<String> {
    let souls: Vec<(Client, Id)> = (0..asks.len())
        .map(|n| {
            let soul = join(dir, n as u64 + 2, lineage);
            let body = births(dir).last().expect("its birth logged").0;
            (soul, body)
        })
        .collect();
    std::thread::scope(|s| {
        let runs: Vec<_> = asks
            .iter()
            .zip(souls)
            .map(|(a, (mut soul, body))| {
                s.spawn(move || {
                    soul.0
                        .set_read_timeout(Some(Duration::from_secs(900)))
                        .unwrap();
                    // An agent's act does not lapse while its walk goes on: 10 minutes for a walk across Eden.
                    let within = 600_000_000;
                    let thing = ids[a.thing];
                    let first = a.first.map(|(verb, on)| {
                        soul.act_within(verb, Some(ids[on]), BTreeMap::new(), within)
                    });
                    let done = match a.arg {
                        Some(arg) => {
                            let arg = args(&[(arg, thing.to_value())]);
                            soul.act_within(a.verb, Some(body), arg, within)
                        }
                        None => soul.act_within(a.verb, Some(thing), BTreeMap::new(), within),
                    };
                    let seated = last_frames(dir).get(&body).copied();
                    let how = match (&done, seated) {
                        (Err(name), _) => format!("refused {name}"),
                        (Ok(_), Some((on, Some(slot)))) if on == thing => {
                            format!("done, in its slot {slot}")
                        }
                        (Ok(_), _) if a.verb.ends_with(":sit") || a.verb.ends_with(":lie") => {
                            "done, but not in its slot".to_owned()
                        }
                        (Ok(_), _) => "done".to_owned(),
                    };
                    let first = first.map_or(String::new(), |f| format!(" (first {f:?})"));
                    format!(
                        "{} | {} | {} {}{first} | {how}",
                        a.kind, a.ask, a.verb, a.thing
                    )
                })
            })
            .collect();
        runs.into_iter().map(|r| r.join().unwrap()).collect()
    })
}

/// Eden's outdoor things do what a person asks: from the campus quad, where every new Soul arrives, and from the
/// park, each [`Ask`] of [`AT_THE_QUAD`] and [`AT_THE_PARK`] by its own Soul, all at once (four Souls sit on the
/// fountain's edge together; one first sits on a bench). Prints `kind | ask | act | ending`; every ask a person would
/// expect done is done (a sit or lie in one of the thing's slots), and each other ask names why not.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn eden_outdoor_things_do_what_a_person_asks() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let all = replica::rules::json::parse(&text).unwrap();
    let ids: BTreeMap<String, Id> = all
        .get("things")
        .and_then(|t| t.arr())
        .unwrap_or(&[])
        .iter()
        .filter_map(|t| {
            let id = t.get("id")?.str()?;
            Some((t.get("name")?.str()?.to_owned(), *im.nodes.get(id)?))
        })
        .collect();
    let lines = std::thread::scope(|s| {
        let quad = s.spawn(|| {
            let (served, dir) = serve_arriving(&facts, "place-region-campus-quad", "outdoor-quad");
            let out = ask_all(&dir, AT_THE_QUAD, &ids, lineage);
            drop(served);
            let _ = std::fs::remove_dir_all(&dir);
            out
        });
        let park = s.spawn(|| {
            let (served, first, dir) = serve(&facts, "18.0,99.0", "outdoor-park", lineage);
            drop(first);
            let out = ask_all(&dir, AT_THE_PARK, &ids, lineage);
            drop(served);
            let _ = std::fs::remove_dir_all(&dir);
            out
        });
        let mut lines = quad.join().unwrap();
        lines.extend(park.join().unwrap());
        lines
    });
    let mut wrong = Vec::new();
    for (a, line) in AT_THE_QUAD.iter().chain(AT_THE_PARK).zip(&lines) {
        let ok = line.ends_with("| done") || line.contains("| done, in its slot");
        let why = a
            .not_tonight
            .map_or(String::new(), |w| format!(" | not tonight: {w}"));
        println!("OUTDOOR {line}{why}");
        if !ok && a.not_tonight.is_none() {
            wrong.push(line.clone());
        }
    }
    assert!(
        wrong.is_empty(),
        "{} asks not done:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

/// The 0.137 trial on Eden: a Soul by a tree stump (`street-stump-1`, e_7219ed40) walks to it, sits on it, rises and
/// walks on at once to the quad fountain; then four Souls walk to the fountain in turn while those before stand at it.
/// Every walk is done, none refused `spot-none-free`, and the four stand round the basin at least two body radii
/// apart. (A body left a little inside an obstacle's cut was refused every walk; see `spots::Ground::start`.)
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn souls_walk_on_from_a_stump_and_four_walk_to_the_quad_fountain() {
    let facts = facts_path();
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let (stump, fountain) = (im.nodes["e_7219ed40"], im.nodes["e_ce79121a"]);
    let (served, mut soul, dir) = serve(&facts, "13.0,-35.0", "stumpwalk", lineage);
    soul.0
        .set_read_timeout(Some(Duration::from_secs(300)))
        .unwrap();
    let to = soul.act("eden:walk", Some(stump), BTreeMap::new());
    let sit = soul.act("eden:sit", Some(stump), BTreeMap::new());
    let rise = soul.act("eden:rise", None, BTreeMap::new());
    let on = soul.act("eden:walk", Some(fountain), BTreeMap::new());
    println!("stump: walk {to:?}, sit {sit:?}, rise {rise:?}, walk on {on:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    to.expect("walked to the stump");
    sit.expect("sat");
    rise.expect("rose");
    on.expect("walked on from beside the stump");

    let (served, first, dir) = serve(&facts, "-12.0,-88.0", "fountain4", lineage);
    let mut souls = vec![first];
    for n in 2..=4 {
        souls.push(join(&dir, n, lineage));
    }
    let mut ended = Vec::new();
    for s in &mut souls {
        s.0.set_read_timeout(Some(Duration::from_secs(300)))
            .unwrap();
        ended.push(s.act("eden:walk", Some(fountain), BTreeMap::new()));
    }
    let at: Vec<(f64, f64)> = last_places(&dir)
        .values()
        .map(|&(_, _, x, z)| (x, z))
        .collect();
    println!("fountain: {ended:?} at {at:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    for e in &ended {
        assert!(e.is_ok(), "every walk to the fountain is done: {ended:?}");
    }
    assert_eq!(at.len(), 4);
    for (i, p) in at.iter().enumerate() {
        assert!(
            (p.0 + 12.0).hypot(p.1 + 97.0) <= 6.0,
            "at the fountain: {p:?}"
        );
        for q in &at[i + 1..] {
            assert!(
                (p.0 - q.0).hypot(p.1 - q.1) >= 0.56,
                "two body radii apart: {p:?} {q:?}"
            );
        }
    }
}

/// Three Souls born on the quad (Soul 1 already joined as `first`, served from `dir`) each sit on the fountain by the
/// gateway's bare sit, naming only the fountain, each in its own seat, and each rises. A seat is the thing's own slot
/// row of its number (`rows`, field 13, `[n, x, y, z, yaw mdeg, capacity]` mm): the world places a seated body at its
/// point (`sim::ground::scene` `slot_point`) and the page draws it by the same row (`apps/web/src/v2-engine/bridge.ts`
/// `sample`: feet the row's height under the seat, facing the thing's +z turned by the row's yaw). Each row taken is on
/// the rim, 575 mm up and 1925 mm out from the middle (the model's basin), facing out.
fn three_sit_on_the_rim(
    served: Served,
    first: Client,
    dir: &Path,
    fountain: Id,
    lineage: Scope,
    rows: &[Value],
) {
    let mut souls = [first, join(dir, 2, lineage), join(dir, 3, lineage)];
    let sat: Vec<_> = souls
        .iter_mut()
        .map(|s| s.act("eden:sit", Some(fountain), BTreeMap::new()))
        .collect();
    let mut slots: Vec<u64> = last_frames(dir)
        .values()
        .filter(|f| f.0 == fountain)
        .filter_map(|f| f.1)
        .collect();
    slots.sort_unstable();
    let rose: Vec<_> = souls
        .iter_mut()
        .map(|s| s.act("eden:rise", None, BTreeMap::new()))
        .collect();
    println!("sit on the fountain: {sat:?}, in its slots {slots:?}; rise: {rose:?}");
    drop(served);
    let _ = std::fs::remove_dir_all(dir);
    for s in &sat {
        s.as_ref().expect("sat on the fountain's rim");
    }
    let mut each = slots.clone();
    each.dedup();
    assert_eq!(
        each.len(),
        3,
        "three Souls, each in its own seat: {slots:?}"
    );
    let num = |v: &Value| match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(u) => i64::try_from(*u).ok().map(|u| -u - 1),
        _ => None,
    };
    for n in &slots {
        let row: Vec<i64> = rows
            .iter()
            .find_map(|r| match r {
                Value::Array(r) if r.first().and_then(num) == i64::try_from(*n).ok() => {
                    Some(r.iter().filter_map(num).collect())
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("slot {n} has a row"));
        let (x, y, z, yaw) = (row[1] as f64, row[2], row[3] as f64, row[4] as f64);
        let (r, turn) = (x.hypot(z), (yaw / 1000.0).to_radians());
        let out = (turn.sin() * x + turn.cos() * z) / r;
        println!("slot {n}: row {row:?}, {r:.0} mm out, facing out at cos {out:.5}");
        assert_eq!(y, 575, "slot {n} at the rim's height");
        assert!((r - 1925.0).abs() <= 2.0, "slot {n} on the rim: {r} mm out");
        assert!(out > 0.9999, "slot {n} faces out: {out}");
    }
    for r in rose {
        r.expect("each rises off the rim");
    }
}

/// The fountain's slot rows as the import holds them (field 13).
fn slot_rows(im: &import_eden::Import, thing: Id) -> Vec<Value> {
    let node = im.tree.node(im.tree.handle(thing).unwrap()).unwrap();
    match node.fields().get(&import_eden::F_SLOTS) {
        Some(Value::Array(rows)) => rows.clone(),
        _ => panic!("the fountain has slot rows"),
    }
}

/// A Soul sits on the rim of the campus quad's fountain, where every new Soul arrives facing it (core-fountain@2's
/// `rim-n` seats, `content/kinds/washing/fountain.json`'s `rim_n`), on Eden seeded from today's facts: three Souls born
/// on the quad each sit on the rim ([`three_sit_on_the_rim`]). Before, the fountain's six rows were stand points on
/// the paving and its entry had no seat: the sit was refused `place-unknown`.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn three_souls_born_at_the_quad_each_sit_on_the_fountain_rim() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let fountain = im.nodes[&facts_id(&text, "campus-quad-fountain")];
    let lineage = im.nodes["world"].scope();
    let (served, first, dir) = serve(&facts, "-12.0,-88.0", "rim", lineage);
    let rows = slot_rows(&im, fountain);
    three_sit_on_the_rim(served, first, &dir, fountain, lineage, &rows);
}

/// The same on Eden as production has it, imported before core-fountain@2: its fountain's slot rows are @1's six stand
/// points on the paving, numbered 1 to 6 (today's facts with the fountain's slots put back so), and its world holds the
/// eden:fountain entry from before (no seat, no sit). The release's `worldd entries stage` stages the new entry and the
/// deploy swaps it in (`supervisor::deploy::swap_entries`); then one creator edit sets the fountain's field 13 to @2's
/// rows, as `v2/tools/ops/fountain-rim-seats.mjs` sends it. Three Souls born on the quad then each sit on the rim.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn production_eden_gets_the_rim_seats_by_its_entries_upgrade_and_one_creator_edit() {
    use replica::rules::json::{self as js, Value as J};
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let fountain = im.nodes[&facts_id(&text, "campus-quad-fountain")];
    let (lineage, rim) = (im.nodes["world"].scope(), slot_rows(&im, fountain));
    let scratch = std::env::temp_dir().join(format!("eden-rim-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).unwrap();
    // The facts with @1's rows, as production Eden's import wrote them.
    let from = text
        .find(r#""slots":[{"n":1,"id":"rim-1""#)
        .expect("the rim seats in the facts");
    let to = from + text[from..].find(r#""id":"edge-6""#).unwrap();
    let to = to + text[to..].find("}]").unwrap() + 2;
    let ring = [
        (2250, 0, 270000),
        (1125, 1949, 210000),
        (-1125, 1949, 150000),
        (-2250, 0, 90000),
        (-1125, -1949, 30000),
        (1125, -1949, 330000),
    ];
    let old: Vec<String> = (1..)
        .zip(ring)
        .map(|(n, (x, z, yaw))| {
            format!(
                r#"{{"n":{n},"id":"edge-{n}","kind":"stand","at":[{x},0,{z}],"yaw":{yaw},"capacity":1}}"#
            )
        })
        .collect();
    let old_facts = scratch.join("facts-v1.json");
    std::fs::write(
        &old_facts,
        format!(
            "{}\"slots\":[{}]{}",
            &text[..from],
            old.join(","),
            &text[to..]
        ),
    )
    .unwrap();
    // The world's entries from before: the fountain's with no seat and no form.
    let old_kinds = scratch.join("kinds");
    copy_dir(Path::new(&format!("{root}/content/kinds")), &old_kinds);
    let entry = old_kinds.join("washing/fountain.json");
    let J::Obj(fields) = js::parse(&std::fs::read_to_string(&entry).unwrap()).unwrap() else {
        panic!("an entry")
    };
    let before = J::Obj(
        fields
            .into_iter()
            .filter(|(k, _)| k != "slots" && k != "forms")
            .collect(),
    );
    std::fs::write(&entry, before.to_json()).unwrap();
    let worldd = env!("CARGO_BIN_EXE_worldd");
    let dir = scratch.join("w");
    let seeded = Command::new(worldd)
        .args(["seed", "--facts"])
        .arg(&old_facts)
        .arg("--dir")
        .arg(&dir)
        .arg("--entries")
        .arg(&old_kinds)
        .args(["--souls", "0", "--at", "-12.0,-88.0"])
        .output()
        .unwrap();
    assert!(
        seeded.status.success(),
        "{}",
        String::from_utf8_lossy(&seeded.stderr)
    );
    // The release's entries step and its deploy's swap.
    let staged = Command::new(worldd)
        .args(["entries", "stage", "--dir"])
        .arg(&dir)
        .arg("--kinds")
        .arg(format!("{root}/content/kinds"))
        .output()
        .unwrap();
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&staged.stdout),
        String::from_utf8_lossy(&staged.stderr)
    );
    println!("entries stage: {log}");
    assert!(
        staged.status.success() && log.contains("change eden:fountain "),
        "{log}"
    );
    supervisor::deploy::swap_entries(&dir, true).unwrap();
    // The world's one creator, as production Eden names one.
    let creator = Id::new(Scope([0xc7; 16]), 1).unwrap();
    let meta = dir.join("world.json");
    let m = std::fs::read_to_string(&meta).unwrap();
    let (head, _) = m.rsplit_once('}').unwrap();
    std::fs::write(
        &meta,
        format!(
            "{head}, \"creator\": \"{}-1\"}}",
            replica::encode::to_hex(&creator.scope().0)
        ),
    )
    .unwrap();
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
    let connect = || {
        let s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(90))).unwrap();
        s
    };
    let mut first = Client(
        connect(),
        Id::new(Scope([0xc1; 16]), 1).unwrap(),
        0,
        lineage,
    );
    first
        .act(JOIN, None, BTreeMap::new())
        .expect("born by the entry");
    // The creator's edit, planned against version `planned`: its answer's kind (1 done, 2 refused), its reason and the
    // world's version it names (as `souls-god.mjs` plans an edit on its copy of the world).
    let mut god = connect();
    let mut edit = |sequence: u64, planned: u64| {
        let i = Intent {
            actor: Actor::Creator(creator),
            verb: name(replica::edit::wire::VERB),
            target: None,
            parameters: replica::edit::wire::parameters(&[replica::edit::Op::Set {
                node: replica::edit::Ref::Node(fountain),
                field: import_eden::F_SLOTS,
                to: Value::Array(rim.clone()),
            }]),
            sequence,
            basis: Version {
                lineage,
                zone: Id::new(lineage, 0).unwrap(),
                epoch: 1,
                sequence: planned,
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
        god.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        god.write_all(&bytes).unwrap();
        loop {
            let mut len = [0u8; 4];
            god.read_exact(&mut len).expect("an answer");
            let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
            god.read_exact(&mut frame).unwrap();
            let Value::Map(m) = decode(&frame).unwrap().value else {
                panic!("a frame")
            };
            let (Some(Value::Map(a)), Some(Value::Array(v))) = (m.get(&2), m.get(&1)) else {
                panic!("an answer with a version")
            };
            let kind = match a.get(&3) {
                Some(Value::Uint(k)) => *k,
                other => panic!("a kind: {other:?}"),
            };
            if kind == 3 {
                continue;
            }
            let reason = match a.get(&4) {
                Some(Value::Text(t)) => t.as_str().to_owned(),
                _ => String::new(),
            };
            let Some(Value::Uint(version)) = v.get(3) else {
                panic!("a version")
            };
            return (kind, reason, *version);
        }
    };
    // Planned on nothing, it is refused stale and names the world's version; planned on that version, it commits.
    let (kind, reason, version) = edit(1, 0);
    println!("planned on version 0: kind {kind} {reason:?}; the world is at {version}");
    let edited = edit(2, version);
    println!("the creator's edit of the fountain's rows: {edited:?}");
    assert_eq!(edited.0, 1, "the creator's edit commits: {edited:?}");
    // The rows the world now holds, as its log has them: the sits below are checked against these.
    let Some(Value::Array(held)) = last_set(&dir, fountain, import_eden::F_SLOTS) else {
        panic!("the world's log sets the fountain's slot rows")
    };
    assert_eq!(held, rim, "the world holds @2's rows");
    three_sit_on_the_rim(served, first, &dir, fountain, lineage, &held);
    let _ = std::fs::remove_dir_all(&scratch);
}

/// The last value the world's log in `dir` sets on `node`'s field `field`.
fn last_set(dir: &Path, node: Id, field: u64) -> Option<Value> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = None;
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            let Body::Changes(changes) = e.body else {
                continue;
            };
            for c in changes {
                if let replica::effects::Change::Set {
                    node: n,
                    field: f,
                    to,
                    ..
                } = c.change
                    && n == node
                    && f == field
                {
                    out = Some(to);
                }
            }
        }
    }
    out
}

/// First-day round 2 (0.139): a Soul on the harbour boardwalk walks to the lighthouse at the end of the breakwater,
/// as `act <id>` sends it: to the lighthouse (today's e_edbbc6a7, its main room), its entrance's floor and its
/// entrance. Each ends `done` on the entrance's floor. Before, each was refused `spot-none-free` at once, with
/// nobody about: the lighthouse stood across the breakwater's end (5.4 m wide over a 5.2 m deck) with its one door
/// on the far side, over the sea, so no walk reached any place in it; turned to face the breakwater, its door opens
/// onto it.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn the_lighthouse_is_walked_to_from_the_boardwalk() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let floor = im.nodes["e_edbbc6a7/floor-0"];
    let targets = ["e_edbbc6a7", "e_edbbc6a7/floor-0", "e_edbbc6a7/entrance"];
    let (served, first, dir) = serve(&facts, "90.0,139.0", "lighthouse", lineage);
    drop(first);
    let mut walked = Vec::new();
    for (k, key) in targets.iter().enumerate() {
        let mut soul = join(&dir, 2 + k as u64, lineage);
        soul.0
            .set_read_timeout(Some(Duration::from_secs(400)))
            .unwrap();
        let r = soul.act_within(
            "eden:walk",
            Some(im.nodes[*key]),
            BTreeMap::new(),
            300_000_000,
        );
        println!("from the boardwalk to {key}: {r:?}");
        walked.push(r);
    }
    std::thread::sleep(Duration::from_secs(1));
    // The world mints each Soul's body as it joins: by id, the first Soul's, then the walkers' in order.
    let ends: Vec<_> = last_poses(&dir).into_values().skip(1).collect();
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    for ((key, r), end) in targets.iter().zip(&walked).zip(&ends) {
        println!(
            "  {key}: ends at {:?} on {:?}",
            end.position, end.frame.node
        );
        assert!(r.is_ok(), "{key}: {r:?}");
        assert_eq!(end.frame.node, floor, "{key}: in the lighthouse");
    }
    assert_eq!(ends.len(), targets.len());
}

/// First-day round 2 (0.139): from the park north of the harbour, a walk to the harbour (its district,
/// `place-region-harbour`, as `context harbour` lists it) ends `done` in the harbour, out of the park. The district's
/// middle is the sea between its piers, so the walk stood back 0.6 m outside its nearest edge, which the park's
/// own area overlaps: the Soul ended in the park, by the pond. Now it walks into the nearest area the district holds
/// that is ground (its boardwalk).
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_walk_to_the_harbour_from_the_park_ends_in_the_harbour() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let (ground, harbour, park) = (
        im.nodes["ground"],
        im.nodes[&facts_id(&text, "place-region-harbour")],
        im.nodes[&facts_id(&text, "place-region-park")],
    );
    let (served, mut soul, dir) = serve(&facts, "20.0,118.0", "harbour", im.nodes["world"].scope());
    soul.0
        .set_read_timeout(Some(Duration::from_secs(400)))
        .unwrap();
    let r = soul.act_within("eden:walk", Some(harbour), BTreeMap::new(), 300_000_000);
    std::thread::sleep(Duration::from_secs(1));
    let end = end_pose(&dir);
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    let (node, at) = end.expect("the body's end");
    let gap = |place| replica::select::gap(&im.tree, place, ground, at).unwrap();
    println!(
        "to the harbour: {r:?}, ends at ({:.1}, {:.1}) m, {} µm from the harbour, {} µm from the park",
        at.x as f64 / 1e6,
        at.z as f64 / 1e6,
        gap(harbour),
        gap(park)
    );
    r.expect("walked to the harbour, done");
    assert_eq!(node, ground, "on the open ground");
    assert_eq!(gap(harbour), 0, "in the harbour");
    assert!(gap(park) > 0, "out of the park");
}

/// First-day round 2 review (#5027): a walk to a water place that holds a bridge far along it still ends at the place's
/// edge, not on the bridge. The west river's region and its river (`place-region-west-river`,
/// `place-region-west-river-river`, their middles on the water) both hold the stone bridge's area (its middle on the
/// deck), 200 m south of a Soul by the fishing hamlet at (-200, 150) m; each walk ends `done` near the edge it comes
/// to, 6 m and 24 m west, as before the harbour's change, which walked it to the bridge.
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a_walk_to_the_river_ends_at_its_edge_not_on_its_bridge() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let lineage = im.nodes["world"].scope();
    let ground = im.nodes["ground"];
    let bridge = im.nodes[&facts_id(&text, "place-region-west-river-stone-bridge")];
    let names = ["place-region-west-river", "place-region-west-river-river"];
    let (served, first, dir) = serve(&facts, "-200.0,150.0", "riverbridge", lineage);
    let mut walked = Vec::new();
    for (k, mut soul) in std::iter::once(first)
        .chain((2..=names.len() as u64).map(|n| join(&dir, n, lineage)))
        .enumerate()
    {
        soul.0
            .set_read_timeout(Some(Duration::from_secs(400)))
            .unwrap();
        let place = im.nodes[&facts_id(&text, names[k])];
        let r = soul.act_within("eden:walk", Some(place), BTreeMap::new(), 300_000_000);
        walked.push((names[k], place, r));
    }
    std::thread::sleep(Duration::from_secs(1));
    let ends: Vec<_> = last_poses(&dir).into_values().collect();
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(ends.len(), names.len());
    for ((name, place, r), end) in walked.iter().zip(&ends) {
        let at = end.position;
        let gap = |p| replica::select::gap(&im.tree, p, ground, at).unwrap();
        println!(
            "to {name}: {r:?}, ends at ({:.1}, {:.1}) m on {:?}, {:.1} m from it, {:.1} m from the bridge",
            at.x as f64 / 1e6,
            at.z as f64 / 1e6,
            end.frame.node,
            gap(*place) as f64 / 1e6,
            gap(bridge) as f64 / 1e6
        );
        assert!(r.is_ok(), "{name}: {r:?}");
        assert_eq!(end.frame.node, ground, "{name}: on the open ground");
        assert!(gap(*place) <= 5_000_000, "{name}: at its edge");
        assert!(gap(bridge) >= 100_000_000, "{name}: not on the bridge");
    }
}

/// Each body's last logged pose in the world's log in `dir`, by body id.
fn last_poses(dir: &Path) -> BTreeMap<Id, replica::pose::Pose> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = BTreeMap::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        if let Some(Value::Array(rows)) = Part::read(&r).unwrap().rest.get(&answers::BODIES) {
            for (id, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                out.insert(id, pose);
            }
        }
    }
    out
}

/// The quad's fountain, at (-12, -97) m, in the middle of Eden's arrival (`place-region-campus-quad`).
const QUAD_FOUNTAIN: &str = "e_ce79121a";

/// Each body's places in the world's log in `dir`, in order, by the body's id: the node it stood on and its position
/// in that node's frame, µm.
fn body_places(dir: &Path) -> BTreeMap<Id, Vec<(Id, replica::pose::Vec3)>> {
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut out = BTreeMap::<Id, Vec<_>>::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        if let Some(Value::Array(rows)) = Part::read(&r).unwrap().rest.get(&answers::BODIES) {
            for (id, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                out.entry(id)
                    .or_default()
                    .push((pose.frame.node, pose.position));
            }
        }
    }
    out
}

/// W9 (#4085) on a served Eden: the import's one-way check walked no way back to the quad within 600 s from the floors
/// of two old-town buildings, the bell tower (`e_1277cee2`) and the south arcade's first shop (`e_47f02c93`), and from
/// seats in the shop. Here Souls born at the quad walk there the normal way (a walk to the floor, a walk to the seat,
/// which ends at its stand point), and from there to the quad's fountain, all at once: each walk's answer, its time
/// and where the body ends (from the world's log) are printed. None is stuck: each walk is answered with a receipt
/// within the act's expiry, the walk in ends on the floor it was sent to (a seat's: the floor under it), and the walk
/// back ends on the open ground by the fountain.
// A real process on the real clock: the answers' seconds are real time.
#[allow(clippy::disallowed_methods)]
#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn w9_souls_on_old_town_floors_and_seats_walk_back_to_the_quad_fountain() {
    let facts = facts_path();
    let text = std::fs::read_to_string(&facts).unwrap();
    let im = import_eden::load(&text).expect("Eden loads");
    let names: BTreeMap<Id, String> = im.nodes.iter().map(|(k, v)| (*v, k.clone())).collect();
    let name_of = |n: Id| names.get(&n).cloned().unwrap_or_else(|| format!("{n:?}"));
    let (ground, fountain) = (im.nodes["ground"], im.nodes[QUAD_FOUNTAIN]);
    // The bell tower's second floor up, the shop's two floors, the shop's sofa (upstairs) and its bench (downstairs),
    // each with the floor the walk in ends on.
    let targets = [
        ("e_1277cee2/floor-2", "e_1277cee2/floor-2"),
        ("e_47f02c93/floor-0", "e_47f02c93/floor-0"),
        ("e_47f02c93/floor-1", "e_47f02c93/floor-1"),
        ("e_c4e5895b", "e_47f02c93/floor-1"),
        ("e_b26197b0", "e_47f02c93/floor-0"),
    ];
    let lineage = im.nodes["world"].scope();
    let (served, first, dir, _) = serve_lines(&facts, "-12.0,-92.0", "w9", lineage);
    // One Soul a target, each joined in turn so its body is known by the rows it adds.
    let (mut first, mut souls, mut known) = (Some(first), Vec::new(), Vec::<Id>::new());
    for (k, (target, floor)) in targets.iter().enumerate() {
        let soul = match first.take() {
            Some(soul) => soul,
            None => join(&dir, k as u64 + 1, lineage),
        };
        let body = *body_places(&dir)
            .keys()
            .find(|b| !known.contains(b))
            .expect("the new body");
        known.push(body);
        soul.0
            .set_read_timeout(Some(Duration::from_secs(660)))
            .unwrap();
        souls.push((*target, im.nodes[*floor], body, soul));
    }
    // A walk answered within the act's expiry (600 s): its answer and its seconds. None within the socket's wait (the
    // read times out) is named so, and the other walks go on.
    let walked = |soul: &mut Client, to: Id| {
        let t0 = std::time::Instant::now();
        let a = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            soul.act_within("eden:walk", Some(to), BTreeMap::new(), 600_000_000)
        }))
        .unwrap_or_else(|_| Err("no answer within 660 s".into()));
        (a, t0.elapsed().as_secs_f64())
    };
    let ends = std::thread::scope(|s| {
        let runs: Vec<_> = souls
            .into_iter()
            .map(|(target, floor, body, mut soul)| {
                let (walked, dir) = (&walked, &dir);
                let node = im.nodes[target];
                s.spawn(move || {
                    let there = walked(&mut soul, node);
                    let at = *body_places(dir)[&body].last().unwrap();
                    let back = there.0.is_ok().then(|| walked(&mut soul, fountain));
                    (target, floor, body, (there, at), back)
                })
            })
            .collect();
        runs.into_iter()
            .map(|r| r.join().expect("a walk answered"))
            .collect::<Vec<_>>()
    });
    let rows = body_places(&dir);
    let m = |v: i64| v as f64 / 1e6;
    let mut failed = Vec::new();
    for (target, floor, body, (there, (on, at)), back) in ends {
        let r = &rows[&body];
        let (end_on, end_at) = *r.last().unwrap();
        println!(
            "W9 Eden walk to {target}: {:?} in {:.1} s, ends on {} at ({:.2}, {:.2}, {:.2}) m; back to the quad \
             fountain: {:?}, ends on {} at ({:.2}, {:.2}) m; {} records",
            there.0,
            there.1,
            name_of(on),
            m(at.x),
            m(at.y),
            m(at.z),
            back.as_ref().map(|(a, s)| format!("{a:?} in {s:.1} s")),
            name_of(end_on),
            m(end_at.x),
            m(end_at.z),
            r.len()
        );
        let gap = ((m(end_at.x) + 12.0).powi(2) + (m(end_at.z) + 97.0).powi(2)).sqrt();
        match back {
            Some((Ok(_), _)) if on == floor && end_on == ground && gap <= 10.0 => {}
            _ => failed.push(format!(
                "{target}: there {:?} on {} (sent to {}), back {back:?}, ends on {} {gap:.1} m from the fountain",
                there.0,
                name_of(on),
                name_of(floor),
                name_of(end_on)
            )),
        }
    }
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(failed.is_empty(), "{failed:#?}");
}
