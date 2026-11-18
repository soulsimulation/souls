//! The `frozen` bench (Engine v2 K8, #2671): K2's bench world (10,000 things, 1,000 bodies: 11,101 nodes) held in a
//! replica. First the cost of a whole copy (Step 0). Then each tick applies one part that moves every body (one motion
//! sample each) and hands it to the publisher (`sim::frozen`). Arms: no readers, and eight reader threads querying the
//! newest copy without pause. Reported per arm and repeat: the clock's tick (apply and publish) and its publish, mean
//! and 99th percentile; the publishing thread's time per tick and its whole copies; the readers' checks a second.
//! Run from `v2/`: `cargo run -p bench --release --bin frozen`. Declared on #2671.
//!
//! This is not N15's walker scene (A1's), which does not exist yet: swap `World::build` and the tick's part for it.

use replica::apply::Replica;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::read::Read;
use replica::world_model::{Audience, End, parse_kinds};
use sim::frozen::Publisher;
use std::collections::BTreeMap;
use std::hint::black_box;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::thread;
use std::time::{Duration, Instant};

const KINDS: &str = r#"
{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["body", "thing"]}
{1: "souls:body", 2: "family", 6: {1: ["thing"], 2: ["thing"]}}
{1: "souls:cup", 2: "thing"}
"#;

const TICKS: usize = 2_000;
const WARM: usize = 100;
const REPEATS: usize = 2;
const READERS: [usize; 2] = [0, 8];

struct World {
    replica: Replica,
    header: Header,
    kinds: BTreeMap<&'static str, Name>,
    mint: Minter,
    next: u64,
    souls: u64,
    /// Each body, its room and the cup in its hand.
    bodies: Vec<(Id, Id, Id)>,
}

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

impl World {
    fn new() -> World {
        let parsed = parse_kinds(KINDS).expect("kinds");
        let mut kinds = BTreeMap::new();
        for full in parsed.keys() {
            let plain = ["souls:place", "souls:room", "souls:body", "souls:cup"]
                .into_iter()
                .find(|p| full.starts_with(&format!("{p}@")))
                .expect("a fixture kind");
            kinds.insert(plain, name(full));
        }
        let mut mint = Minter::new(Scope([0x2a; 16]));
        let root = mint.mint().expect("an id");
        let v = Value::Map(BTreeMap::from([
            (
                1,
                Value::Bytes(Hash::of(Purpose::Fixture, b"bench").to_bytes()),
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
        let bytes = encode(&v).expect("bytes");
        World {
            replica: Replica::start(&bytes).expect("a replica"),
            header: Header::read(&bytes).expect("a header"),
            kinds,
            mint,
            next: 0,
            souls: 0,
            bodies: Vec::new(),
        }
    }

    fn id(&mut self) -> Id {
        self.mint.mint().expect("an id")
    }

    fn entry(&mut self, node: Id, changes: Vec<Change>) -> Effect {
        self.next += 1;
        Effect {
            envelope: Envelope {
                sequence: self.next - 1,
                at: 0,
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

    fn part(&self, entries: &[Effect]) -> Part {
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(entries.iter().map(Effect::to_value).collect()),
            ),
        ]));
        Part::read(&encode(&v).expect("bytes")).expect("a part")
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

    fn link(&mut self, ty: &str, ends: [Id; 2], owner: End) -> Change {
        Change::Link {
            link: self.id(),
            ty: name(ty),
            ends,
            owner,
            audience: Audience::Everyone,
        }
    }

    /// A room under the root with 10 bodies (each linked to its Soul, a cup in its right hand) and 90 cups on its
    /// floor, each owned by one of the room's Souls. One part, as K2's bench builds it.
    fn room(&mut self) {
        let root = self.replica.tree().root();
        let root = self.replica.tree().node(root).expect("the root").id();
        let room = self.id();
        let c = self.create(room, "souls:room", root, None, 0);
        let mut entries = vec![self.entry(root, vec![c])];
        let mut inside = Vec::new();
        let mut here = Vec::new();
        for i in 0..10 {
            let b = self.id();
            inside.push(self.create(b, "souls:body", room, None, i * 1000));
            here.push(b);
        }
        let mut cups = Vec::new();
        for i in 0..90 {
            let t = self.id();
            inside.push(self.create(t, "souls:cup", room, None, i * 1000));
            cups.push(t);
        }
        entries.push(self.entry(room, inside));
        let mut souls = Vec::new();
        for b in here {
            let soul = Id::new(Scope([0x50; 16]), self.souls).expect("a Soul");
            self.souls += 1;
            souls.push(soul);
            let cup = self.id();
            let held = self.create(cup, "souls:cup", b, Some(2), 0);
            let body_of = self.link("souls:body-of", [b, soul], End::First);
            let e = self.entry(b, vec![held, body_of]);
            entries.push(e);
            self.bodies.push((b, room, cup));
        }
        for (i, t) in cups.into_iter().enumerate() {
            let owns = self.link("souls:owns", [souls[i % souls.len()], t], End::Second);
            let e = self.entry(t, vec![owns]);
            entries.push(e);
        }
        let part = self.part(&entries);
        self.replica.apply(&part).expect("applies");
    }

    fn build() -> World {
        let mut w = World::new();
        for _ in 0..100 {
            w.room();
        }
        w
    }

    /// One tick's part: every body moves (a motion sample in its room).
    fn tick(&mut self, tick: u64) -> Part {
        let bodies = self.bodies.clone();
        let entries: Vec<Effect> = bodies
            .iter()
            .enumerate()
            .map(|(i, (b, room, _))| {
                let x = (i as i64 % 10) * 1000 + (tick % 1000) as i64;
                let sample = Change::Motion(HandOff {
                    node: *b,
                    at: tick as i64 * 50_000,
                    from: Owner::Mover,
                    to: Owner::Mover,
                    pose: pose(*room, None, x),
                    linear: Vec3::new(1_000_000, 0, 0),
                    angular: Vec3::ZERO,
                });
                self.entry(*b, vec![sample])
            })
            .collect();
        self.part(&entries)
    }
}

/// A checker's reads: a body's record and stamp, its room's children, its links and its cup's path.
fn check(f: &impl Read, (body, room, cup): (Id, Id, Id)) {
    black_box(f.node(body));
    black_box(f.stamp(body));
    black_box(f.children(room, Some("souls:body")));
    black_box(f.links(body));
    black_box(f.path(cup));
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Mean and 99th percentile, in ms.
fn stats(mut v: Vec<Duration>) -> (f64, f64) {
    v.sort();
    let mean = v.iter().map(|d| ms(*d)).sum::<f64>() / v.len() as f64;
    (mean, ms(v[(v.len() * 99 / 100).min(v.len() - 1)]))
}

fn main() {
    let cores = thread::available_parallelism().map_or(0, |n| n.get());
    let t0 = Instant::now();
    let mut w = World::build();
    let (nodes, links) = w.replica.tree().counts();
    println!(
        "world: {nodes} nodes, {links} links, built in {:.0} ms; {cores} cores",
        ms(t0.elapsed())
    );
    let bodies = Arc::new(w.bodies.clone());

    // Step 0: the whole copy alone, at rest (freed in the loop, as a clock that copied would free it).
    let copies: Vec<Duration> = (0..200)
        .map(|_| {
            let t = Instant::now();
            black_box(w.replica.frozen());
            t.elapsed()
        })
        .collect();
    let (mean, p99) = stats(copies);
    println!("whole copy at rest: mean {mean:.3} ms, p99 {p99:.3} ms");
    println!();
    println!(
        "| readers | repeat | tick mean | tick p99 | publish mean | publish p99 | publishing thread a tick | whole copies | checks a second |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");

    let mut tick = 1u64;
    for repeat in 1..=REPEATS {
        for readers in READERS {
            let publisher = Arc::new(Publisher::new(&w.replica));
            let stop = Arc::new(AtomicBool::new(false));
            let checks = Arc::new(AtomicU64::new(0));
            let threads: Vec<_> = (0..readers)
                .map(|r| {
                    let (p, stop, checks, bodies) = (
                        Arc::clone(&publisher),
                        Arc::clone(&stop),
                        Arc::clone(&checks),
                        Arc::clone(&bodies),
                    );
                    thread::spawn(move || {
                        let mut i = r * 7919;
                        while !stop.load(Relaxed) {
                            let f = p.latest();
                            for _ in 0..16 {
                                i = (i * 1_103_515_245 + 12_345) % bodies.len();
                                check(&*f, bodies[i]);
                            }
                            checks.fetch_add(16, Relaxed);
                        }
                    })
                })
                .collect();
            let mut ticks = Vec::with_capacity(TICKS);
            let mut publishes = Vec::with_capacity(TICKS);
            let mut measured_from = Instant::now();
            let mut at_warm = publisher.counts();
            for k in 0..WARM + TICKS {
                if k == WARM {
                    measured_from = Instant::now();
                    checks.store(0, Relaxed);
                    at_warm = publisher.counts();
                }
                let part = w.tick(tick);
                tick += 1;
                let t = Instant::now();
                w.replica.apply(&part).expect("a tick applies");
                let p = Instant::now();
                publisher.publish(vec![Arc::new(part)]);
                let end = Instant::now();
                if k >= WARM {
                    ticks.push(end - t);
                    publishes.push(end - p);
                }
            }
            let secs = measured_from.elapsed().as_secs_f64();
            let last = publisher.wait_for(w.replica.version(), Duration::from_secs(30));
            assert_eq!(last.version(), w.replica.version(), "every tick published");
            let c = publisher.counts();
            assert_eq!(c.refused, 0);
            let busy = (c.busy_ns - at_warm.busy_ns) as f64 / 1e6 / TICKS as f64;
            let whole = c.whole - at_warm.whole;
            stop.store(true, Relaxed);
            threads
                .into_iter()
                .for_each(|t| t.join().expect("a reader"));
            let (tm, tp) = stats(ticks);
            let (pm, pp) = stats(publishes);
            let rate = checks.load(Relaxed) as f64 / secs;
            println!(
                "| {readers} | {repeat} | {tm:.3} ms | {tp:.3} ms | {pm:.4} ms | {pp:.4} ms | {busy:.3} ms | {whole} | {rate:.0} |"
            );
        }
    }
}
