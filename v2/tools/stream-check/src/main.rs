//! `stream-check` (Engine v2 V1, #2710): a live world written as the viewer's stream, for `run.mjs` to play in a
//! headless browser, and the scan of what it wrote.
//!
//! - `world <work dir> <seconds> <even|uneven>`: one room of 200 bodies ticking at 20 a second in real time, written
//!   to K4's log in `<work dir>/log`, followed by worldd's view tier and its stream writer, which writes the public
//!   view under `<work dir>/www`. Even load: 40 motion samples a tick. Uneven: 200 a tick for two seconds in every
//!   ten, 10 a tick otherwise. Every two seconds a body says something: the log holds a reference (`{21: id}`), and
//!   the words go to `<work dir>/words.txt`, never to the log. A private note (one audience's, #3239) is created in
//!   the room, and each time a body speaks the note is written to as well, in an entry the public view skips; its id
//!   and its references go to `<work dir>/private.txt`. Prints `stream <dir>`, then `done <parts> <entries> <bytes per
//!   part, comma separated>`.
//! - `scan <work dir>`: A5. Every part under `www` is unpacked and read; prints its text items (names only, T6 rule
//!   10), the references found, the gaps the parts declare, how many of the words in `words.txt` and of the private
//!   ids in `private.txt` appear in any part's bytes, packed or not (both must be 0).

// Runs a world on the wall clock: the wall-clock rule (K7) binds the engine, not this tool.
#![allow(clippy::disallowed_methods)]

use replica::audience::references;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, State,
    schema_hash, texts,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::stream::{self, StreamPart};
use replica::tree::{Rules, Tree};
use replica::views::{Key, Level, Redactions};
use replica::world_model::{Audience, parse_kinds};
use sim::log::{FileStore, Log};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use worldd::view_out::{Writer, follow};
use worldd::views::Tier;

const KINDS: &str = r#"
{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["body"]}
{1: "souls:body", 2: "family"}
"#;
const BODIES: usize = 200;
const TICK_US: i64 = 50_000;
const SAY_EVERY: usize = 40;
/// Made-up lines a body says; the log never holds them.
const LINES: [&str; 4] = [
    "meet me at the well at noon",
    "the bread is still warm",
    "who left the gate open",
    "see you at the dance tonight",
];

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn pose(frame: Id, x: i64) -> Pose {
    Pose {
        frame: Frame {
            node: frame,
            slot: None,
        },
        position: Vec3::new(x, 0, 0),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: frame,
            height: 0,
        },
    }
}

/// The world as its clock thread holds it.
struct World {
    tree: Tree,
    header: Header,
    rules: Rules,
    kinds: BTreeMap<&'static str, Name>,
    mint: Minter,
    next: u64,
    root: Id,
    room: Id,
    bodies: Vec<Id>,
    /// The private note, its audience, and every private id written (the note's and its references).
    note: Id,
    secret: Audience,
    private: Vec<Id>,
}

impl World {
    fn new() -> World {
        let secret = Id::new(Scope([0x3a; 16]), 1).expect("an id");
        let rules = Rules {
            kinds: parse_kinds(KINDS).expect("kinds"),
            audiences: BTreeMap::from([(secret, Default::default())]),
            ..Rules::default()
        };
        let mut kinds = BTreeMap::new();
        for full in rules.kinds.keys() {
            let plain = ["souls:place", "souls:room", "souls:body"]
                .into_iter()
                .find(|p| full.starts_with(&format!("{p}@")))
                .expect("a kind");
            kinds.insert(plain, name(full));
        }
        let mut mint = Minter::new(Scope([0x27; 16]));
        let root = mint.mint().expect("an id");
        let v = Value::Map(BTreeMap::from([
            (
                1,
                Value::Bytes(Hash::of(Purpose::Fixture, b"stream-check").to_bytes()),
            ),
            (2, Value::Bytes(schema_hash().to_bytes())),
            (3, Value::Bytes(root.scope().0.to_vec())),
            (4, root.to_value()),
            (5, Value::Uint(1)),
            (
                6,
                Value::Array(kinds.values().cloned().map(Value::Text).collect()),
            ),
            (7, Value::Array(Vec::new())),
        ]));
        let header = Header::read(&encode(&v).expect("bytes")).expect("a header");
        let tree = Tree::start(root, kinds["souls:place"].clone());
        World {
            tree,
            header,
            rules,
            kinds,
            mint,
            next: 0,
            root,
            room: root,
            bodies: Vec::new(),
            note: root,
            secret: Audience::Of(secret),
            private: Vec::new(),
        }
    }

    fn start(&self) -> State {
        State::start(self.root, self.kinds["souls:place"].clone())
    }

    fn entry(&mut self, node: Id, at: i64, changes: Vec<Change>) -> Effect {
        self.entry_for(node, at, changes, Audience::Everyone)
    }

    fn entry_for(&mut self, node: Id, at: i64, changes: Vec<Change>, audience: Audience) -> Effect {
        self.next += 1;
        Effect {
            envelope: Envelope {
                sequence: self.next - 1,
                at,
                cause: Cause::World,
                actor: Actor::World,
                audience,
                node,
            },
            body: Body::Changes(
                changes
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            ),
            events: None,
            rest: Rest::new(),
        }
    }

    fn commit(&mut self, entries: Vec<Effect>) -> Vec<u8> {
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(entries.iter().map(Effect::to_value).collect()),
            ),
        ]));
        let bytes = encode(&v).expect("bytes");
        let part = Part::read(&bytes).expect("a part");
        self.tree
            .commit(&self.header, &part, &self.rules)
            .expect("commits");
        bytes
    }

    fn create(&self, node: Id, kind: &str, parent: Id, x: i64) -> Change {
        Change::Create {
            node,
            kind: self.kinds[kind].clone(),
            pose: pose(parent, x),
            audience: Audience::Everyone,
            fields: BTreeMap::from([(1, Value::Uint(x as u64))]),
        }
    }

    /// The room and its bodies, at world time 0.
    fn room(&mut self) -> Vec<u8> {
        self.room = self.mint.mint().expect("an id");
        let c = self.create(self.room, "souls:room", self.root, 0);
        let mut entries = vec![self.entry(self.root, 0, vec![c])];
        let mut inside = Vec::new();
        for i in 0..BODIES {
            let b = self.mint.mint().expect("an id");
            inside.push(self.create(b, "souls:body", self.room, i as i64 * 1000));
            self.bodies.push(b);
        }
        let room = self.room;
        entries.push(self.entry(room, 0, inside));
        // The private note: the public view skips its entries (#3239).
        self.note = self.mint.mint().expect("an id");
        self.private.push(self.note);
        let mut note = self.create(self.note, "souls:body", room, BODIES as i64 * 1000);
        if let Change::Create { audience, .. } = &mut note {
            *audience = self.secret;
        }
        let secret = self.secret;
        entries.push(self.entry_for(room, 0, vec![note], secret));
        self.commit(entries)
    }

    /// Tick `n`: `moving` bodies in turn send a motion sample, and every [`SAY_EVERY`] ticks one says a line (a
    /// reference in the log; the words to `said`).
    fn tick(&mut self, n: usize, moving: usize, said: &mut Vec<String>) -> Vec<u8> {
        let at = n as i64 * TICK_US;
        let mut entries: Vec<Effect> = (0..moving)
            .map(|i| {
                let b = self.bodies[(n * moving + i) % BODIES];
                let sample = Change::Motion(HandOff {
                    node: b,
                    at,
                    from: Owner::Mover,
                    to: Owner::Mover,
                    pose: pose(self.room, (n % 1000) as i64 * 10),
                    linear: Vec3::new(200_000, 0, 0),
                    angular: Vec3::ZERO,
                });
                self.entry(b, at, vec![sample])
            })
            .collect();
        if n.is_multiple_of(SAY_EVERY) {
            let b = self.bodies[n % BODIES];
            let r = self.mint.mint().expect("an id");
            said.push(format!(
                "{} {}",
                n / SAY_EVERY,
                LINES[n / SAY_EVERY % LINES.len()]
            ));
            let c = Change::Set {
                node: b,
                field: 2,
                to: Value::Map(BTreeMap::from([(21, r.to_value())])),
                by: None,
            };
            entries.push(self.entry(b, at, vec![c]));
            // And the private note is written to, after it: the public view's position moves past an entry it skips.
            let r = self.mint.mint().expect("an id");
            self.private.push(r);
            let c = Change::Set {
                node: self.note,
                field: 2,
                to: Value::Map(BTreeMap::from([(21, r.to_value())])),
                by: None,
            };
            let (note, secret) = (self.note, self.secret);
            entries.push(self.entry_for(note, at, vec![c], secret));
        }
        self.commit(entries)
    }
}

fn moving(arm: &str, n: usize) -> usize {
    let second = n * TICK_US as usize / 1_000_000;
    match arm {
        "even" => 40,
        "uneven" if second % 10 < 2 => 200,
        "uneven" => 10,
        _ => panic!("the arm is even or uneven"),
    }
}

fn world(work: &Path, seconds: u64, arm: &str) {
    let www = work.join("www");
    std::fs::create_dir_all(&www).expect("the folder");
    let path = work.join("log");
    let _ = std::fs::remove_file(&path);
    let (mut log, _) = Log::open(FileStore::open(&path).expect("a file"), 1).expect("a log");
    let mut w = World::new();
    let tier = Tier::start(
        w.header.clone(),
        w.start(),
        Redactions::default(),
        log.durable_mark(),
    )
    .expect("a tier");
    let key = Key {
        node: w.root,
        level: Level::Full,
        audience: Audience::Everyone,
    };
    let sub = tier.subscribe(vec![key], 1 << 16);
    // World time 0 falls at this wall time; the clock below keeps them in step.
    let start = Instant::now();
    let wall_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after 1970")
        .as_millis() as u64;
    let writer = Writer::create(&www, &w.header, &key, (0, wall_ms)).expect("a writer");
    println!("stream {}", stream::dir(&w.header, &key));
    let stop = Arc::new(AtomicBool::new(false));
    let following = follow(writer, sub, stop.clone());
    let mut said = Vec::new();
    let ticks = (seconds * 1_000_000 / TICK_US as u64) as usize;
    for n in 0..ticks {
        let deadline = start + Duration::from_micros(n as u64 * TICK_US as u64);
        if let Some(d) = deadline.checked_duration_since(Instant::now()) {
            std::thread::sleep(d);
        }
        let mut bytes = if n == 0 { vec![w.room()] } else { Vec::new() };
        bytes.push(w.tick(n, moving(arm, n), &mut said));
        for b in bytes {
            let rec = log.append(b.clone()).expect("appended");
            tier.offer(rec, b);
        }
    }
    log.wait_durable(log.durable().max(1)).expect("synced");
    let stats = tier.close();
    assert_eq!(stats.fault, None, "the tier stopped");
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let writer = following
        .join()
        .expect("the writer")
        .expect("the writer wrote");
    std::fs::write(work.join("words.txt"), said.join("\n")).expect("the words");
    let private: Vec<String> = w
        .private
        .iter()
        .map(|i| replica::encode::to_hex(&encode(&i.to_value()).expect("bytes")))
        .collect();
    std::fs::write(work.join("private.txt"), private.join("\n")).expect("the private ids");
    let wr = writer.written();
    let sizes: Vec<String> = wr.bytes.iter().map(u64::to_string).collect();
    println!("done {} {} {}", wr.parts, wr.entries, sizes.join(","));
}

fn find(a: &[u8], b: &[u8]) -> bool {
    !b.is_empty() && a.windows(b.len()).any(|w| w == b)
}

fn scan(work: &Path) {
    let words: Vec<String> = std::fs::read_to_string(work.join("words.txt"))
        .expect("the words")
        .lines()
        .map(|l| l.split_once(' ').map_or(l, |(_, w)| w).to_owned())
        .collect();
    let private: Vec<Vec<u8>> = std::fs::read_to_string(work.join("private.txt"))
        .expect("the private ids")
        .lines()
        .map(|l| {
            (0..l.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&l[i..i + 2], 16).expect("hex"))
                .collect()
        })
        .collect();
    let (mut parts, mut text_items, mut refs, mut found) = (0, 0, 0, 0);
    let (mut gaps, mut leaked) = (0, 0);
    let mut stack = vec![work.join("www")];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).expect("a folder") {
            let p = e.expect("an entry").path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let is_part = p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()));
            if !is_part {
                continue;
            }
            let file = std::fs::read(&p).expect("a part");
            let sp = StreamPart::read(&file).expect("a whole part");
            let part = Part::read(&sp.part).expect("T6 bytes");
            let v = decode(&sp.part).expect("decodes").value;
            parts += 1;
            text_items += texts(&v).len();
            refs += references(&v).len();
            found += words
                .iter()
                .filter(|w| find(&sp.part, w.as_bytes()) || find(&file, w.as_bytes()))
                .count();
            gaps += sp.gaps.len();
            leaked += private
                .iter()
                .filter(|i| find(&sp.part, i) || find(&file, i))
                .count();
            drop(part);
        }
    }
    println!(
        "scan: {parts} parts, {text_items} text items (all names: T6 rule 10), {refs} references, {gaps} declared gaps, {found} of {} lines said found in any part, {leaked} of {} private ids found in any part",
        words.len(),
        private.len()
    );
    assert!(found == 0, "words were found in a part");
    assert!(leaked == 0, "a private id was found in a part");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("world") if args.len() == 5 => world(
            Path::new(&args[2]),
            args[3].parse().expect("seconds"),
            &args[4],
        ),
        Some("scan") if args.len() == 3 => scan(Path::new(&args[2])),
        _ => {
            eprintln!(
                "usage: stream-check world <work dir> <seconds> <even|uneven> | scan <work dir>"
            );
            std::process::exit(2);
        }
    }
}
