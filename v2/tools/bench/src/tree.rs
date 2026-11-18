//! The `tree` bench (Engine v2 K2, #2646): a world of 10,000 things and 1,000 bodies built in `replica`'s tree
//! through `commit`, then the memory it holds (A2) and the cost of listing children and links (A3), in that world
//! and in one ten times larger. Run from `v2/`: `cargo run -p bench --release --bin tree`. Declared on #2646.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, parse_kinds};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::hint::black_box;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

/// Counts the bytes the program holds, and the most it has held.
struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call is passed straight to the system allocator; the counters only add and subtract sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            let now = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
            PEAK.fetch_max(now, Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }

    unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, layout, size) };
        if !q.is_null() {
            LIVE.fetch_sub(layout.size(), Relaxed);
            let now = LIVE.fetch_add(size, Relaxed) + size;
            PEAK.fetch_max(now, Relaxed);
        }
        q
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const KINDS: &str = r#"
{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["body", "thing"]}
{1: "souls:body", 2: "family", 6: {1: ["thing"], 2: ["thing"]}}
{1: "souls:cup", 2: "thing"}
"#;

struct World {
    tree: Tree,
    header: Header,
    rules: Rules,
    kinds: BTreeMap<&'static str, Name>,
    mint: Minter,
    next: u64,
    rooms: Vec<Id>,
    bodies: Vec<Id>,
    souls: Vec<Id>,
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
        let rules = Rules {
            kinds: parse_kinds(KINDS).expect("kinds"),
            ..Rules::default()
        };
        let mut kinds = BTreeMap::new();
        for full in rules.kinds.keys() {
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
        let header = Header::read(&encode(&v).expect("bytes")).expect("a header");
        let tree = Tree::start(root, kinds["souls:place"].clone());
        World {
            tree,
            header,
            rules,
            kinds,
            mint,
            next: 0,
            rooms: Vec::new(),
            bodies: Vec::new(),
            souls: Vec::new(),
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

    fn commit(&mut self, entries: Vec<Effect>) {
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(entries.iter().map(Effect::to_value).collect()),
            ),
        ]));
        let part = Part::read(&encode(&v).expect("bytes")).expect("a part");
        self.tree
            .commit(&self.header, &part, &self.rules)
            .expect("commits");
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

    /// A room under the root holding `bodies` bodies (each linked to its own Soul, a cup in its right hand and a
    /// motion sample) and `things` cups on its floor, each owned by a Soul. One part.
    fn room(&mut self, bodies: usize, things: usize) -> Id {
        let root = self.tree.node(self.tree.root()).expect("the root").id();
        let room = self.id();
        let mut entries = vec![];
        let c = self.create(room, "souls:room", root, None, 0);
        entries.push(self.entry(root, vec![c]));
        let mut inside = Vec::new();
        let mut bodies_here = Vec::new();
        for i in 0..bodies {
            let b = self.id();
            inside.push(self.create(b, "souls:body", room, None, i as i64 * 1000));
            bodies_here.push(b);
        }
        let mut cups = Vec::new();
        for i in 0..things {
            let t = self.id();
            inside.push(self.create(t, "souls:cup", room, None, i as i64 * 1000));
            cups.push(t);
        }
        entries.push(self.entry(room, inside));
        for b in bodies_here {
            let soul = Id::new(Scope([0x50; 16]), self.souls.len() as u64).expect("a Soul");
            self.rules.souls.insert(soul);
            self.souls.push(soul);
            let cup = self.id();
            let held = self.create(cup, "souls:cup", b, Some(2), 0);
            let body_of = self.link("souls:body-of", [b, soul], End::First);
            let sample = Change::Motion(HandOff {
                node: b,
                at: 0,
                from: Owner::Mover,
                to: Owner::Mover,
                pose: pose(room, None, 5),
                linear: Vec3::new(1_000_000, 0, 0),
                angular: Vec3::ZERO,
            });
            let e = self.entry(b, vec![held, body_of, sample]);
            entries.push(e);
            self.bodies.push(b);
        }
        // Each cup is owned by the Soul of a body in its room, in turn: every Soul has one body and nine cups.
        let owners = self.souls.len() - bodies.min(self.souls.len());
        for (i, t) in cups.into_iter().enumerate() {
            let soul = match bodies {
                0 => self.souls[i % self.souls.len()],
                n => self.souls[owners + i % n],
            };
            let owns = self.link("souls:owns", [soul, t], End::Second);
            let e = self.entry(t, vec![owns]);
            entries.push(e);
        }
        self.commit(entries);
        self.rooms.push(room);
        room
    }
}

/// A world of `scale` × (1,000 bodies, 9,000 cups on floors and 1,000 in hands) in 100 × `scale` rooms.
fn build(scale: usize) -> World {
    let mut w = World::new();
    for _ in 0..100 * scale {
        w.room(10, 90);
    }
    w
}

fn mb(bytes: usize) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

/// Mean nanoseconds of `f` over `n` calls.
fn ns(n: u32, mut f: impl FnMut(u32)) -> f64 {
    let start = Instant::now();
    for i in 0..n {
        f(i);
    }
    start.elapsed().as_nanos() as f64 / f64::from(n)
}

fn main() {
    // A2: what the world holds.
    let before = LIVE.load(Relaxed);
    PEAK.store(before, Relaxed);
    let t0 = Instant::now();
    let w = build(1);
    let built = t0.elapsed();
    let (nodes, links) = w.tree.counts();
    let held = LIVE.load(Relaxed) - before;
    let peak = PEAK.load(Relaxed) - before;
    let moving = w.tree.moving().iter().flatten().count();
    println!("## A2: memory");
    println!();
    println!(
        "| world | nodes | links | moving | held after build | peak while building | built in |"
    );
    println!("|---|---|---|---|---|---|---|");
    println!(
        "| 10,000 things, 1,000 bodies | {nodes} | {links} | {moving} | {} | {} | {:.0} ms |",
        mb(held),
        mb(peak),
        built.as_secs_f64() * 1000.0
    );

    // A3: children, listed from nodes holding 1, 10, 100 and 1,000.
    let mut w = w;
    println!();
    println!("## A3: listing children (1x world)");
    println!();
    println!("| children | ns per listing | ns per child | node reads, link reads |");
    println!("|---|---|---|---|");
    for k in [1usize, 10, 100, 1000] {
        let room = w.room(0, k);
        let h = w.tree.handle(room).expect("the room");
        w.tree.reset_reads();
        let _ = w.tree.children(h);
        let reads = w.tree.reads();
        let n = 2_000_000 / k as u32;
        let per = ns(n, |_| {
            for c in w.tree.children(black_box(h)).expect("live") {
                black_box(c);
            }
        });
        println!("| {k} | {per:.1} | {:.2} | {reads:?} |", per / k as f64);
    }

    // A3: links from either end, in the world and in one ten times larger.
    println!();
    println!("## A3: finding links from either end");
    println!();
    println!("| world | nodes | end | ns per listing | links listed | node reads, link reads |");
    println!("|---|---|---|---|---|---|");
    drop(w);
    for scale in [1usize, 10] {
        let w = build(scale);
        let (nodes, _) = w.tree.counts();
        for (end, ids) in [("body (node end)", &w.bodies), ("Soul (far end)", &w.souls)] {
            let sample: Vec<Id> = ids
                .iter()
                .step_by(ids.len() / 1000)
                .copied()
                .take(1000)
                .collect();
            w.tree.reset_reads();
            let listed = w.tree.links_at(sample[0]).len();
            let reads = w.tree.reads();
            let per = ns(2_000_000, |i| {
                let e = w
                    .tree
                    .links_at(black_box(sample[i as usize % sample.len()]));
                black_box(e.first().map(|x| x.other));
            });
            println!("| {scale}x | {nodes} | {end}, by id | {per:.1} | {listed} | {reads:?} |");
        }
        let handles: Vec<_> = w
            .bodies
            .iter()
            .step_by(w.bodies.len() / 1000)
            .map(|b| w.tree.handle(*b).expect("live"))
            .collect();
        let per = ns(2_000_000, |i| {
            let e = w
                .tree
                .links_of(black_box(handles[i as usize % handles.len()]))
                .expect("live");
            black_box(e.first().map(|x| x.other));
        });
        println!("| {scale}x | {nodes} | body (node end), by handle | {per:.1} | 1 | (1, 0) |");
    }
}
