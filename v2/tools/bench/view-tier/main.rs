//! The `view-tier` bench (Engine v2 R3, #2697): a world of 1,000 bodies and 10,000 things in 10 rooms, ticking at 20
//! a second with 100 bodies sending a motion sample each tick, written to K4's log in a file, and worldd's view tier
//! following it. Arms: no subscribers, and 1,000 (each Soul: its room in full, publicly and for its own audience, and
//! the world's outline), drained by 8 reader threads. Measures, declared on #2697 before the first run:
//!
//! - A1: the clock thread's mean tick time (building, committing to K2's tree, appending, handing over) with 1,000
//!   subscribers is within 10 % of the paired run with none.
//! - A2: frames encoded per tick equal the keys in use.
//! - A4: frames ready within 20 ms of their tick's sync at the 99th percentile (with 1,000 subscribers).
//!
//! Run from `v2/`: `cargo run -p bench --release --bin view-tier -- [ticks] [repeats] [dir]` (400, 2,
//! `target/view-tier`). The arms run interleaved: none, 1,000, none, 1,000.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, State, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::tree::{Rules, Tree};
use replica::views::{Key, Level, Redactions};
use replica::world_model::{Audience, End, parse_kinds};
use sim::log::{FileStore, Log};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::time::{Duration, Instant};
use worldd::views::{Subscriber, Tier};

const KINDS: &str = r#"
{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["body", "thing"]}
{1: "souls:body", 2: "family", 6: {1: ["thing"], 2: ["thing"]}}
{1: "souls:cup", 2: "thing"}
"#;
const ROOMS: usize = 10;
const BODIES: usize = 100;
const CUPS: usize = 900;
const MOVING: usize = 100;
const TICK_US: i64 = 50_000;
const SUBSCRIBERS: usize = 1_000;
const READERS: usize = 8;
const BOUND: usize = 256;
const WARM: usize = 40;

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn pose(frame: Id, slot: Option<u64>, x: i64) -> Pose {
    Pose {
        frame: Frame { node: frame, slot },
        position: Vec3::new(x, 0, 0),
        orientation: Quat::IDENTITY,
        support: match slot {
            Some(_) => Support::Slot,
            None => Support::Surface {
                surface: frame,
                height: 0,
            },
        },
    }
}

/// The world as the clock thread holds it: K2's tree, and what it writes next.
struct World {
    tree: Tree,
    header: Header,
    rules: Rules,
    kinds: BTreeMap<&'static str, Name>,
    mint: Minter,
    next: u64,
    root: Id,
    rooms: Vec<Id>,
    bodies: Vec<(Id, Id)>,
    souls: Vec<Id>,
}

impl World {
    fn new() -> World {
        let rules = Rules {
            kinds: parse_kinds(KINDS).expect("kinds"),
            ..Rules::default()
        };
        let mut kinds = BTreeMap::new();
        for full in rules.kinds.keys() {
            let plain = ["souls:place", "souls:room", "souls:body", "souls:cup"]
                .into_iter()
                .find(|p| full.starts_with(&format!("{p}@")))
                .expect("a kind");
            kinds.insert(plain, name(full));
        }
        let mut mint = Minter::new(Scope([0x2a; 16]));
        let root = mint.mint().expect("an id");
        let v = Value::Map(BTreeMap::from([
            (
                1,
                Value::Bytes(Hash::of(Purpose::Fixture, b"view-tier").to_bytes()),
            ),
            (2, Value::Bytes(schema_hash().to_bytes())),
            (3, Value::Bytes(root.scope().0.to_vec())),
            (4, root.to_value()),
            (5, Value::Uint(0)),
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
            rooms: Vec::new(),
            bodies: Vec::new(),
            souls: Vec::new(),
        }
    }

    fn start(&self) -> State {
        State::start(self.root, self.kinds["souls:place"].clone())
    }

    fn id(&mut self) -> Id {
        self.mint.mint().expect("an id")
    }

    fn entry(&mut self, node: Id, at: i64, changes: Vec<Change>) -> Effect {
        self.next += 1;
        Effect {
            envelope: Envelope {
                sequence: self.next - 1,
                at,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
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

    /// Commits `entries` to the tree as one part; its bytes, for the log.
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

    fn create(&self, node: Id, kind: &str, parent: Id, slot: Option<u64>, x: i64) -> Change {
        Change::Create {
            node,
            kind: self.kinds[kind].clone(),
            pose: pose(parent, slot, x),
            audience: Audience::Everyone,
            fields: BTreeMap::from([(1, Value::Uint(x as u64))]),
        }
    }

    /// A room under the root with its bodies (each a Soul's, a cup in hand) and cups on the floor. One part.
    fn room(&mut self) -> Vec<u8> {
        let room = self.id();
        let c = self.create(room, "souls:room", self.root, None, 0);
        let mut entries = vec![self.entry(self.root, 0, vec![c])];
        let mut inside = Vec::new();
        let mut here = Vec::new();
        for i in 0..BODIES {
            let b = self.id();
            inside.push(self.create(b, "souls:body", room, None, i as i64 * 1000));
            here.push(b);
        }
        for i in 0..CUPS {
            let t = self.id();
            inside.push(self.create(t, "souls:cup", room, None, i as i64 * 1000));
        }
        entries.push(self.entry(room, 0, inside));
        for b in here {
            let soul = Id::new(Scope([0x50; 16]), self.souls.len() as u64).expect("a Soul");
            self.rules.souls.insert(soul);
            self.souls.push(soul);
            let cup = self.id();
            let held = self.create(cup, "souls:cup", b, Some(2), 0);
            let body_of = Change::Link {
                link: self.id(),
                ty: name("souls:body-of"),
                ends: [b, soul],
                owner: End::First,
                audience: Audience::Everyone,
            };
            entries.push(self.entry(b, 0, vec![held, body_of]));
            self.bodies.push((b, room));
        }
        self.rooms.push(room);
        self.commit(entries)
    }

    /// One tick's work: `MOVING` bodies, in turn, each send a motion sample. The part's bytes.
    fn tick(&mut self, n: usize) -> Vec<u8> {
        let at = n as i64 * TICK_US;
        let entries = (0..MOVING)
            .map(|i| {
                let (b, room) = self.bodies[(n * MOVING + i) % self.bodies.len()];
                let sample = Change::Motion(HandOff {
                    node: b,
                    at,
                    from: Owner::Mover,
                    to: Owner::Mover,
                    pose: pose(room, None, (n % 1000) as i64 * 10),
                    linear: Vec3::new(200_000, 0, 0),
                    angular: Vec3::ZERO,
                });
                self.entry(b, at, vec![sample])
            })
            .collect();
        self.commit(entries)
    }
}

struct Run {
    tick_us: Vec<f64>,
    frames: u64,
    ticks: u64,
    keys: usize,
    p99_us: Option<u64>,
    p50_us: Option<u64>,
    unknown: u64,
    snapshots: u64,
    received: u64,
}

fn run(subscribers: usize, ticks: usize, dir: &Path, arm: &str) -> Run {
    let path = dir.join(format!("{arm}.log"));
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
    for _ in 0..ROOMS {
        let bytes = w.room();
        let n = log.append(bytes.clone()).expect("appended");
        tier.offer(n, bytes);
    }
    // Each Soul: its room in full, for everyone and for itself, and the world's outline.
    let mut keys = Vec::new();
    let subs: Vec<Subscriber> = (0..subscribers)
        .map(|i| {
            let (_, room) = w.bodies[i % w.bodies.len()];
            let soul = w.souls[i % w.souls.len()];
            let ks = vec![
                Key {
                    node: room,
                    level: Level::Full,
                    audience: Audience::Everyone,
                },
                Key {
                    node: room,
                    level: Level::Full,
                    audience: Audience::Of(soul),
                },
                Key {
                    node: w.root,
                    level: Level::Outline,
                    audience: Audience::Everyone,
                },
            ];
            for k in &ks {
                if !keys.contains(k) {
                    keys.push(*k);
                }
            }
            tier.subscribe(ks, BOUND)
        })
        .collect();
    let subs = Arc::new(subs);
    let stop = Arc::new(AtomicBool::new(false));
    let readers: Vec<_> = (0..READERS)
        .map(|r| {
            let (subs, stop) = (subs.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut got = 0u64;
                while !stop.load(Relaxed) {
                    for s in subs.iter().skip(r).step_by(READERS) {
                        while s.try_recv().is_some() {
                            got += 1;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                got
            })
        })
        .collect();
    // The clock thread: absolute deadlines, 20 a second; a tick's time is its work, not its sleep.
    let start = Instant::now();
    let mut tick_us = Vec::new();
    let (mut frames0, mut ticks0) = (0, 0);
    for n in 0..WARM + ticks {
        let deadline = start + Duration::from_micros((n as u64 + 1) * TICK_US as u64);
        let t = Instant::now();
        let bytes = w.tick(n);
        let rec = log.append(bytes.clone()).expect("appended");
        tier.offer(rec, bytes);
        let took = t.elapsed();
        if n == WARM {
            let s = tier.stats();
            (frames0, ticks0) = (s.frames, s.ticks);
        }
        if n >= WARM {
            tick_us.push(took.as_secs_f64() * 1e6);
        }
        if let Some(d) = deadline.checked_duration_since(Instant::now()) {
            std::thread::sleep(d);
        }
    }
    log.wait_durable(log.durable().max(1)).expect("synced");
    let stats = tier.close();
    stop.store(true, Relaxed);
    let received: u64 = readers
        .into_iter()
        .map(|r| r.join().expect("a reader"))
        .sum();
    drop(log);
    assert_eq!(stats.fault, None);
    Run {
        tick_us,
        frames: stats.frames - frames0,
        ticks: stats.ticks - ticks0,
        keys: keys.len(),
        p99_us: stats.ready.quantile_us(990),
        p50_us: stats.ready.quantile_us(500),
        unknown: stats.ready.unknown,
        snapshots: stats.snapshots,
        received,
    }
}

fn mean(v: &[f64]) -> f64 {
    v.iter().sum::<f64>() / v.len().max(1) as f64
}

fn pct(v: &[f64], q: f64) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    s[((s.len() as f64 * q).ceil() as usize).clamp(1, s.len()) - 1]
}

fn ms(us: Option<u64>) -> String {
    us.map_or("-".into(), |u| format!("{:.1}", u as f64 / 1000.0))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let ticks: usize = args.get(1).map_or(400, |a| a.parse().expect("ticks"));
    let repeats: usize = args.get(2).map_or(2, |a| a.parse().expect("repeats"));
    let dir = Path::new(args.get(3).map_or("target/view-tier", String::as_str)).to_path_buf();
    std::fs::create_dir_all(&dir).expect("the folder");
    println!(
        "{ROOMS} rooms, {} bodies, {} things; {MOVING} motion samples a tick at 20 a second; {ticks} ticks timed after {WARM}",
        ROOMS * BODIES,
        ROOMS * (BODIES * 2 + CUPS)
    );
    println!();
    println!(
        "| repeat | subscribers | keys | tick mean µs | tick p99 µs | A1 ratio | frames / tick | ready p50 ms | ready p99 ms | sync unknown | snapshots | deliveries read |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|");
    let mut pass = true;
    let mut verdicts = Vec::new();
    for r in 1..=repeats {
        let none = run(0, ticks, &dir, "none");
        let many = run(SUBSCRIBERS, ticks, &dir, "many");
        let ratio = mean(&many.tick_us) / mean(&none.tick_us);
        for (x, subs, ratio) in [
            (&none, 0, String::from("")),
            (&many, SUBSCRIBERS, format!("{ratio:.3}")),
        ] {
            println!(
                "| {r} | {subs} | {} | {:.0} | {:.0} | {ratio} | {:.2} | {} | {} | {} | {} | {} |",
                x.keys,
                mean(&x.tick_us),
                pct(&x.tick_us, 0.99),
                x.frames as f64 / x.ticks.max(1) as f64,
                ms(x.p50_us),
                ms(x.p99_us),
                x.unknown,
                x.snapshots,
                x.received
            );
        }
        let a1 = ratio <= 1.10;
        let a2 = many.frames == many.ticks * many.keys as u64;
        let a4 = many.p99_us.is_some_and(|u| u <= 20_000);
        verdicts.push(format!(
            "repeat {r}: A1 {} ({ratio:.3}), A2 {}, A4 {}",
            ok(a1),
            ok(a2),
            ok(a4)
        ));
        pass &= a1 && a2 && a4;
    }
    println!();
    for v in verdicts {
        println!("{v}");
    }
    println!(
        "{}",
        if pass {
            "all measures met"
        } else {
            "a measure was not met"
        }
    );
}

fn ok(b: bool) -> &'static str {
    if b { "met" } else { "NOT met" }
}
