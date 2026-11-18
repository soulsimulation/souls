//! Engine v2 N15 (#2660): the win 1 gate. A thousand walkers in Eden, the clock at 20 ticks a second in real time.
//!
//! `cargo run -p bench --release --bin walkers -- <facts.json> <labels.json> <arm> <seed> [walkers] [seconds]
//! [out-dir] [--fast]` (from `v2/`; defaults 1,000 walkers, 600 s, no files written). `arm` is `uniform` or `event`.
//!
//! - **The world** is N1's import of Eden 2026 (`v2/tools/import-eden`), walked by N7's skill with N8's turns and
//!   N10's ladder over N3 to N6 ([`sim::walk::town::Town`]), exactly as the sim tests build it.
//! - **The places** are the catalog places N18's labels (`v2/tools/compare-reach`) say today's engine reaches, that
//!   the new ground holds within 1.5 m on the open ground or on a building's lowest floor, that lie within the trace's
//!   ±320 m, and that N5 routes to from the arrival point. Every other place is left out and counted by reason.
//! - **The walkers** stand on legal ground at seeded places from the first tick, each with an order to walk to a
//!   seeded place, then another. Times and places follow `tools/bench/capacity/profiles/shapes.json` (read, never
//!   edited): `uniform` waits `10 s x U(0.5, 1.5)` after each arrival and draws places evenly; `event` draws 60 % of
//!   places within 30 m of the meetup place (the bandstand), waits in runs (1 to 4 walks, `U(2, 4)` s apart, then a
//!   log-normal pause, median 30 s, sigma 1.25, at least 2 s), and every `U(45, 120)` s sends 30 % of the walkers to
//!   the meetup place within 2 s, replacing their orders. A walker whose order ended by name (the ladder's
//!   `goal-unreachable`) is given its next order as if it had arrived.
//! - **The clock** is K7's [`Ticker`] on a real clock: absolute deadlines, catch-up after an overrun. `--fast` runs
//!   the ticks back to back (for a quick look; never for the gate).
//! - **Tick time** is the whole clock-thread tick: new orders, then the ladder's tick (the crowd's tick inside it),
//!   door openings written to memory. By phase: `orders` (new orders, less their routing), `plan` (routing, here and
//!   in the ladder's reroutes), `corner`, `mover`, `cross`, `turns` (the [`World`] calls, each timed) and `skill` (the
//!   rest of the crowd's and the ladder's tick). Not in it: the per-tick record, progress and the trace.
//! - **By node** (N17's Step 0, #2813): the world calls' time (`plan`, `corner`, `mover`, `cross`) is also summed
//!   per node the walker stands on, and the summary names the busiest node's share of all tick time and how many
//!   walkers stand on each node at the end. Ticking nodes side by side cannot make a tick shorter than its busiest
//!   node's part.
//! - **Progress** (the bar's 30 s): under a live order, a walker progresses when it arrives, when its leg advances (a
//!   link crossed, a turn gained), or when it stands 1 m nearer its leg's end than at its last progress.
//!
//! Out: a summary line per measure on stdout; with `out-dir`, `ticks.csv` (one row per tick, µs by phase) and
//! `run.trace` (V14's throwaway `birdseye/0` trace, for `v2/tools/birdseye/view.html`). Generated, never committed.

// A bench: it times its own ticks (K7's wall-clock rule binds the engine, not its benches).
#![allow(clippy::disallowed_methods)]
// Walkers are indexed by number throughout: a plan, a trace column and a body id each.
#![allow(clippy::needless_range_loop)]

use import_eden::json::{self, Json};
use import_eden::{F_LEVEL, F_OUTLINE, Import, PLACE, ROOM};
use replica::effects::{Header, Refusal, schema_hash};
use replica::encode::{Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use replica::world_model::plain;
use sim::clock::{Clock, Heartbeat, Ticker};
use sim::ground::scene::{Xform, xform_to};
use sim::links::Doors;
use sim::mover::Body;
use sim::unstick::{Ladder, Unstick};
use sim::walk::town::Town;
use sim::walk::{Crowd, Leg, Mark, Pass, Walker, World, node_of};
use std::collections::BTreeMap;
use std::io::Write;
use std::time::Instant;

/// µs a tick: 20 a second.
const TICK: Micros = 50_000;
/// µm a second: today's walking pace.
const SPEED: i64 = 1_400_000;
/// A place is held by the new ground within this, µm (N18's tolerance).
const TOL: i64 = 1_500_000;
/// The trace's reach, µm: `i16` centimetres.
const REACH: i64 = 320_000_000;
/// Progress: this much nearer the leg's end, µm.
const NEARER: i64 = 1_000_000;

/// SplitMix64.
struct Seed(u64);
impl Seed {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    /// Uniform in [lo, hi), µs or µm.
    fn within(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo).max(1) as u64) as i64
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// A standard normal (Box-Muller).
    fn normal(&mut self) -> f64 {
        let (u, v) = (self.unit().max(1e-12), self.unit());
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}

/// Real time: the wall clock read once, carried on by a monotonic clock (as `worldd`'s).
struct Real {
    wall0: Micros,
    mono0: Instant,
    fast: bool,
    skew: Micros,
}
impl Clock for Real {
    fn now(&mut self) -> Micros {
        self.wall0 + self.mono0.elapsed().as_micros() as Micros + self.skew
    }
    fn sleep_until(&mut self, t: Micros) {
        let wait = t - self.now();
        if wait > 0 {
            if self.fast {
                self.skew += wait;
            } else {
                std::thread::sleep(std::time::Duration::from_micros(wait as u64));
            }
        }
    }
}

/// The phases timed through the world's calls.
const PLAN: usize = 0;
const CORNER: usize = 1;
const MOVER: usize = 2;
const CROSS: usize = 3;
const TURNS: usize = 4;
const NAMES: [&str; 7] = [
    "orders", "plan", "corner", "mover", "cross", "turns", "skill",
];

/// The town, with each world call timed. A refusal of a walker's step, corner or crossing is a fault of that walker
/// alone: it is kept (call, walker, reason), the walker stands that tick, and the bench holds it after the tick, so
/// one walker's fault never stops the clock or the others (AGENTS.md, engine invariants).
struct Timed {
    t: Town,
    ns: [u64; 5],
    /// The world calls' time per node the walker stood on, ns (`turns` is the world's, not a node's).
    by_node: BTreeMap<Id, u64>,
    faults: Vec<(&'static str, Id, String)>,
}
impl Timed {
    fn time<T>(&mut self, k: usize, f: impl FnOnce(&mut Town) -> T) -> T {
        let t0 = Instant::now();
        let r = f(&mut self.t);
        self.ns[k] += t0.elapsed().as_nanos() as u64;
        r
    }
    fn time_on<T>(&mut self, k: usize, node: Id, f: impl FnOnce(&mut Town) -> T) -> T {
        let ns = self.ns[k];
        let r = self.time(k, f);
        *self.by_node.entry(node).or_default() += self.ns[k] - ns;
        r
    }
}
impl World for Timed {
    fn plan(&mut self, body: &Body, node: Id, goal: Vec3) -> Result<Vec<Leg>, Refusal> {
        self.time_on(PLAN, node_of(body), |t| t.plan(body, node, goal))
    }
    fn corner(&mut self, body: &Body, to: Vec3) -> Result<[i64; 2], Refusal> {
        match self.time_on(CORNER, node_of(body), |t| t.corner(body, to)) {
            Err(e) => {
                self.faults
                    .push(("corner", body.id, format!("{}: {}", e.name, e.detail)));
                Ok([body.pose.position.x, body.pose.position.z])
            }
            ok => ok,
        }
    }
    fn step(
        &mut self,
        body: &mut Body,
        v: [i64; 2],
        dt: Micros,
        at: Micros,
    ) -> Result<(), Refusal> {
        let before = *body;
        if let Err(e) = self.time_on(MOVER, node_of(body), |t| t.step(body, v, dt, at)) {
            self.faults
                .push(("mover", body.id, format!("{}: {}", e.name, e.detail)));
            *body = before;
        }
        Ok(())
    }
    fn cross(
        &mut self,
        body: &mut Body,
        link: Id,
        order: Id,
        speed: i64,
        dt: Micros,
        at: Micros,
    ) -> Result<bool, Refusal> {
        let before = *body;
        match self.time_on(CROSS, node_of(body), |t| {
            t.cross(body, link, order, speed, dt, at)
        }) {
            Err(e) => {
                self.faults
                    .push(("cross", body.id, format!("{}: {}", e.name, e.detail)));
                *body = before;
                Ok(false)
            }
            ok => ok,
        }
    }
    fn turns(&mut self, marks: &[Mark], at: Micros) -> Result<(), Refusal> {
        self.time(TURNS, |t| t.turns(marks, at))
    }
    fn pass(&self, link: Id, who: Id) -> Pass {
        self.t.pass(link, who)
    }
}
impl Unstick for Timed {
    fn moved(&self, link: Id) -> Option<Micros> {
        self.t.moved(link)
    }
    fn far_end(&self, link: Id, node: Id, at: Vec3) -> Option<(Id, Vec3)> {
        self.t.far_end(link, node, at)
    }
    fn nearest(&self, node: Id, at: Vec3) -> Option<Vec3> {
        self.t.nearest(node, at)
    }
    fn place(&self, body: &Body, at: Vec3) -> Result<Body, Refusal> {
        self.t.place(body, at)
    }
}

/// A place walkers go to: its id, node and point (µm, the node's frame), and its point on the open ground's frame.
#[derive(Clone)]
struct Place {
    id: String,
    node: Id,
    at: Vec3,
    world: [i64; 2],
}

fn dist(a: [i64; 2], b: [i64; 2]) -> i64 {
    let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
    (d(a[0], b[0]) + d(a[1], b[1])).isqrt() as i64
}
fn xz(v: Vec3) -> [i64; 2] {
    [v.x, v.z]
}

/// `p` (the open ground's frame) in the frame `x` maps from.
fn inverse(x: &Xform, p: Vec3) -> Vec3 {
    let [w, a, b, c] = x.rot.parts();
    let back = Quat::new(w, -a, -b, -c).expect("a unit quaternion");
    back.rotate(p.minus(x.pos).expect("in range"))
        .expect("in range")
}

fn town_of(im: Import) -> (Town, BTreeMap<String, Id>, BTreeMap<[u8; 32], String>) {
    let Import {
        tree,
        rules,
        nodes,
        texts,
        ..
    } = im;
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/walkers-bench/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).expect("bytes")).expect("a header");
    let next = tree.to_state().next;
    let ground = nodes["ground"];
    let t = Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town");
    (t, nodes, texts)
}

fn mm_pairs(v: Option<&Value>) -> Vec<[i64; 2]> {
    let num = |v: &Value| match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    };
    match v {
        Some(Value::Array(ps)) => ps
            .iter()
            .filter_map(|p| match p {
                Value::Array(xz) if xz.len() >= 2 => Some([num(&xz[0])?, num(&xz[1])?]),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn level_of(t: &Town, node: Id) -> i64 {
    t.tree
        .handle(node)
        .and_then(|h| t.tree.node(h))
        .and_then(|n| match n.fields().get(&F_LEVEL) {
            Some(Value::Uint(l)) => Some(*l as i64),
            _ => None,
        })
        .unwrap_or(0)
}

/// What each walker is doing beside the skill: its next order's due time, its run, and its progress.
#[derive(Clone, Copy, Default)]
struct Plan {
    /// When its next order is due, µs (`None` while it walks).
    due: Option<Micros>,
    /// Walks left in its run (event).
    run: u8,
    /// When it was ordered, µs.
    since: Micros,
    leg: usize,
    best: i64,
    progress: Micros,
    live: bool,
    /// Its next order goes to the meetup place (a crowd moment).
    meet: bool,
}

fn pct(v: &mut [i64], q: usize) -> i64 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    v[((v.len() - 1) * q).div_ceil(100)]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let fast = args.iter().any(|a| a == "--fast");
    let args: Vec<&String> = args.iter().filter(|a| *a != "--fast").collect();
    let usage = "usage: walkers <facts.json> <labels.json> <uniform|event> <seed> [walkers] [seconds] [out-dir] [--fast]";
    let (facts, labels, arm) = (
        args.get(1).expect(usage),
        args.get(2).expect(usage),
        args.get(3).expect(usage).as_str(),
    );
    assert!(arm == "uniform" || arm == "event", "{usage}");
    let seed_n: u64 = args.get(4).expect(usage).parse().expect("seed");
    let n: usize = args.get(5).map_or(1000, |s| s.parse().expect("walkers"));
    let seconds: i64 = args.get(6).map_or(600, |s| s.parse().expect("seconds"));
    let out = args.get(7).map(std::path::PathBuf::from);
    let ticks = seconds * 1_000_000 / TICK;

    // The world.
    let t0 = Instant::now();
    let text = std::fs::read_to_string(facts).expect("the facts file");
    let facts_hash = Hash::of(Purpose::Fixture, text.as_bytes());
    let (town, _nodes, _) = town_of(import_eden::load(&text).expect("Eden loads"));
    drop(text);
    let mut w = Timed {
        t: town,
        ns: [0; 5],
        by_node: BTreeMap::new(),
        faults: Vec::new(),
    };
    let ground = w.t.ground;
    let gh = w.t.tree.handle(ground).expect("the ground");
    let load_ms = t0.elapsed().as_millis();

    // Each surface's frame on the open ground, and its floor.
    let frames: BTreeMap<Id, Xform> =
        w.t.surfaces
            .keys()
            .map(|&s| {
                let x = if s == ground {
                    Xform::IDENTITY
                } else {
                    xform_to(&w.t.tree, w.t.tree.handle(s).expect("a floor"), gh)
                        .expect("on the ground")
                };
                (s, x)
            })
            .collect();
    let lowest: Vec<Id> =
        w.t.buildings
            .iter()
            .flat_map(|b| {
                b.floors
                    .iter()
                    .filter(|(_, (l, _))| *l == 0)
                    .map(|(f, _)| *f)
            })
            .filter(|f| w.t.surfaces.contains_key(f))
            .collect();

    // The places.
    let lj = json::parse(&std::fs::read_to_string(labels).expect("the labels file"))
        .expect("labels json");
    let arrival = {
        let a = lj.get("arrival").expect("arrival").arr();
        Vec3::new(a[0].int().unwrap() * 1000, 0, a[1].int().unwrap() * 1000)
    };
    let walker_id = |k: u64| Id::new(Scope([7; 16]), k + 1).expect("an id");
    let order_id = |k: u64| Id::new(Scope([8; 16]), k + 1).expect("an id");
    let start =
        w.t.nearest(ground, arrival)
            .expect("ground at the arrival point");
    let probe = w.t.surfaces[&ground]
        .place(
            walker_id(1_000_000),
            Frame {
                node: ground,
                slot: None,
            },
            start,
            Quat::IDENTITY,
        )
        .expect("a body at the arrival point");
    let mut left: BTreeMap<&str, usize> = BTreeMap::new();
    let mut places: Vec<Place> = Vec::new();
    let r0 = Instant::now();
    for p in lj.get("places").expect("places").arr() {
        let reason = (|| {
            if p.get("ok").and_then(Json::bool) != Some(true) {
                return Err("today does not reach it");
            }
            if p.get("level").and_then(Json::int) != Some(0) {
                return Err("an upper level");
            }
            let pp = p.get("p").expect("p").arr();
            let g = Vec3::new(pp[0].int().unwrap() * 1000, 0, pp[1].int().unwrap() * 1000);
            if g.x.abs() > REACH || g.z.abs() > REACH {
                return Err("beyond the trace's reach");
            }
            let indoor = matches!(p.get("kind").and_then(Json::str), Some("room" | "building"));
            let mut tries: Vec<Id> = lowest.clone();
            if indoor {
                tries.push(ground);
            } else {
                tries.insert(0, ground);
            }
            let held = tries.iter().find_map(|&s| {
                let local = inverse(&frames[&s], g);
                let q = w.t.nearest(s, local)?;
                (dist(xz(q), xz(local)) <= TOL).then_some((s, q))
            });
            let (node, at) = held.ok_or("the new ground does not hold it")?;
            w.t.plan(&probe, node, at)
                .map_err(|_| "no route from the arrival point")?;
            Ok(Place {
                id: p.get("id").and_then(Json::str).unwrap_or("?").to_owned(),
                node,
                at,
                world: xz(g),
            })
        })();
        match reason {
            Ok(pl) => places.push(pl),
            Err(r) => *left.entry(r).or_default() += 1,
        }
    }
    let route_ms = r0.elapsed().as_millis();
    assert!(!places.is_empty(), "no place to walk to");
    let meet = places
        .iter()
        .position(|p| p.id == "g-eden-bandstand")
        .unwrap_or(0);
    let near_meet: Vec<usize> = (0..places.len())
        .filter(|&k| dist(places[k].world, places[meet].world) <= 30_000_000)
        .collect();
    println!(
        "walkers: arm {arm}, seed {seed_n}, {n} walkers, {seconds} s, {}; facts {}; load {load_ms} ms; places {} kept (routed in {route_ms} ms), left out {:?}; meetup {} with {} places within 30 m",
        if fast {
            "fast (not real time)"
        } else {
            "real time, 20 ticks a second"
        },
        facts_hash,
        places.len(),
        left,
        places[meet].id,
        near_meet.len()
    );

    // The walkers: on legal ground at seeded places, each with an order.
    let mut seed = Seed(seed_n ^ if arm == "event" { 0xE7E7 } else { 0x0F0F });
    let mut crowd = Crowd::new(TICK);
    let mut ladder = Ladder::new();
    let mut plans: Vec<Plan> = vec![Plan::default(); n];
    let mut orders = 0u64;
    let draw = |seed: &mut Seed| -> usize {
        if arm == "event" && seed.below(10) < 6 {
            near_meet[seed.below(near_meet.len())]
        } else {
            seed.below(places.len())
        }
    };
    let mut refused_orders = 0u64;
    // A start the routes cannot leave (the jitter can land on a piece of its own) is drawn again: counted.
    let mut restarts = 0u64;
    for k in 0..n {
        let who = walker_id(k as u64);
        'start: loop {
            let body = loop {
                let p = &places[seed.below(places.len())];
                let j = Vec3::new(
                    p.at.x + seed.within(-1_500_000, 1_500_000),
                    p.at.y,
                    p.at.z + seed.within(-1_500_000, 1_500_000),
                );
                let Some(q) = w.t.nearest(p.node, j) else {
                    continue;
                };
                if let Ok(b) = w.t.surfaces[&p.node].place(
                    who,
                    Frame {
                        node: p.node,
                        slot: None,
                    },
                    q,
                    Quat::IDENTITY,
                ) {
                    break b;
                }
            };
            let mut tries = 0;
            loop {
                let g = &places[draw(&mut seed)];
                orders += 1;
                match ladder.add(
                    &mut crowd,
                    &mut w,
                    body,
                    SPEED,
                    order_id(orders),
                    g.node,
                    g.at,
                ) {
                    Ok(()) => break 'start,
                    Err(_) if tries < 5 => tries += 1,
                    Err(_) => {
                        restarts += 1;
                        continue 'start;
                    }
                }
                refused_orders += 1;
            }
        }
        plans[k] = Plan {
            run: if arm == "event" {
                seed.within(1, 5) as u8
            } else {
                0
            },
            live: true,
            best: i64::MAX,
            ..Plan::default()
        };
    }
    w.ns = [0; 5];
    w.by_node.clear();
    println!("walkers: {n} placed; {restarts} starts drawn again (no route out of them)");
    let index: BTreeMap<Id, usize> = (0..n).map(|k| (walker_id(k as u64), k)).collect();

    // The trace's header: the surfaces with their floors, the outlines of every room and named place.
    let node_list: Vec<Id> = frames.keys().copied().collect();
    let node_ix: BTreeMap<Id, u8> = node_list
        .iter()
        .enumerate()
        .map(|(i, &s)| (s, u8::try_from(i).unwrap_or(u8::MAX)))
        .collect();
    let mut trace = out.as_ref().map(|d| {
        std::fs::create_dir_all(d).expect("the out dir");
        let mut outlines: Vec<(i64, &str, Vec<[i64; 2]>)> = Vec::new();
        let mut stack = vec![w.t.tree.root()];
        while let Some(h) = stack.pop() {
            let nd = w.t.tree.node(h).expect("live");
            let kind = plain(nd.kind().as_str()).to_owned();
            if kind == ROOM {
                let floor = nd.parent().map_or(0, |f| level_of(&w.t, f));
                if let Ok(x) = xform_to(&w.t.tree, h, gh) {
                    let ring: Vec<[i64; 2]> = mm_pairs(nd.fields().get(&F_OUTLINE))
                        .iter()
                        .filter_map(|p| x.point(Vec3::new(p[0] * 1000, 0, p[1] * 1000)).ok())
                        .map(|q| [q.x / 1000, q.z / 1000])
                        .collect();
                    outlines.push((floor, "room", ring));
                }
            } else if kind == PLACE {
                let ring = mm_pairs(nd.fields().get(&F_OUTLINE));
                if ring.len() >= 3 && ring.iter().all(|p| p[0].abs() * 1000 <= REACH && p[1].abs() * 1000 <= REACH) {
                    outlines.push((0, "place", ring));
                }
            }
            stack.extend(w.t.tree.children(h).expect("live").iter().copied());
        }
        let mut floors: Vec<i64> = node_list.iter().map(|&s| level_of(&w.t, s)).collect();
        floors.sort_unstable();
        floors.dedup();
        let pts = |v: &[[i64; 2]]| {
            v.iter()
                .map(|p| format!("[{},{}]", p[0] / 10, p[1] / 10))
                .collect::<Vec<_>>()
                .join(",")
        };
        let head = format!(
            "{{\"format\":\"birdseye/0\",\"note\":\"a throwaway trace: not T6's encoding, not a contract, never served (N15, #2660)\",\"tick_us\":{TICK},\"ticks\":{ticks},\"bodies\":{n},\"unit\":\"cm\",\"step_cm\":{},\"floors\":[{}],\"nodes\":[{}],\"outlines\":[{}]}}",
            SPEED * TICK / 1_000_000 / 10_000,
            floors.iter().map(i64::to_string).collect::<Vec<_>>().join(","),
            node_list
                .iter()
                .map(|&s| format!(
                    "{{\"name\":\"{}\",\"floor\":{}}}",
                    if s == ground { "open ground".to_owned() } else { format!("floor {}", level_of(&w.t, s)) },
                    level_of(&w.t, s)
                ))
                .collect::<Vec<_>>()
                .join(","),
            outlines
                .iter()
                .map(|(f, k, v)| format!("{{\"floor\":{f},\"kind\":\"{k}\",\"pts\":[{}]}}", pts(v)))
                .collect::<Vec<_>>()
                .join(","),
        );
        let mut f = std::io::BufWriter::new(std::fs::File::create(d.join("run.trace")).expect("the trace"));
        f.write_all(&(head.len() as u32).to_le_bytes()).unwrap();
        f.write_all(head.as_bytes()).unwrap();
        f.write_all(&vec![0u8; (4 - (4 + head.len()) % 4) % 4]).unwrap();
        let mut c = std::io::BufWriter::new(std::fs::File::create(d.join("ticks.csv")).expect("the csv"));
        writeln!(c, "tick,total_us,{},walking,overruns", NAMES.join("_us,") + "_us").unwrap();
        (f, c)
    });

    // The clock.
    let mut real = Real {
        wall0: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_micros() as Micros),
        mono0: Instant::now(),
        fast,
        skew: 0,
    };
    let r0 = real.now();
    let m = Mapping::new(0, r0, 1, 1).expect("a mapping");
    let line = Timeline::start(
        m,
        TickRate::new(0, 0, 20).expect("20 a second"),
        Tempo::per_minute(0, 0, 120).expect("a tempo"),
    )
    .expect("a time line");
    let mut ticker = Ticker::new(line, m, None, r0).expect("the clock");
    let beat = Heartbeat::new(r0);

    // The run.
    let mut tick_us: Vec<i64> = Vec::with_capacity(ticks as usize);
    let mut phase_us: Vec<[i64; 7]> = Vec::with_capacity(ticks as usize);
    let mut route_us: Vec<i64> = Vec::new();
    let (mut finished, mut ended) = (0u64, 0u64);
    let mut worst: (Micros, usize) = (0, 0);
    let mut next_moment = if arm == "event" {
        seed.within(45_000_000, 120_000_000)
    } else {
        i64::MAX
    };
    let mut moments = 0u64;
    let mut reacted = 0u64;
    let mut row = vec![0u8; 5 * n];
    let mut log_seen = 0usize;
    let mut rungs: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut fault: Option<String> = None;
    let (mut faults_seen, mut fault_shown) = (0usize, 0);
    let mut fault_kinds: BTreeMap<String, u64> = BTreeMap::new();
    let mut faulted: std::collections::BTreeSet<Id> = std::collections::BTreeSet::new();
    while ticker.next_tick() < ticks && fault.is_none() {
        let mut body = |tk: i64, start: Micros| {
            // A tick past the run's end is not run: a clock that fell behind would otherwise catch up for ever.
            if fault.is_some() || tk >= ticks {
                return;
            }
            let at = start + TICK;
            let ns0 = w.ns;
            let a0 = Instant::now();
            // Orders due this tick: the next walk of each walker that waited, and the crowd moments.
            let o0 = Instant::now();
            if at >= next_moment {
                moments += 1;
                next_moment = at + seed.within(45_000_000, 120_000_000);
                for k in 0..n {
                    if seed.below(10) < 3 {
                        plans[k].due = Some(at + seed.within(0, 2_000_000));
                        plans[k].meet = true;
                        reacted += 1;
                    }
                }
            }
            for k in 0..n {
                let Some(due) = plans[k].due else { continue };
                if due > at {
                    continue;
                }
                let who = walker_id(k as u64);
                let Some(ix) = crowd.walkers.iter().position(|x| x.body.id == who) else {
                    continue;
                };
                let x = &crowd.walkers[ix];
                if x.crossing || x.held == Some("walk-out") {
                    continue;
                }
                let b = crowd.walkers.remove(ix).body;
                let mut placed = false;
                for _ in 0..5 {
                    let gi = if plans[k].meet {
                        near_meet[seed.below(near_meet.len())]
                    } else {
                        draw(&mut seed)
                    };
                    let g = &places[gi];
                    orders += 1;
                    if ladder
                        .add(&mut crowd, &mut w, b, SPEED, order_id(orders), g.node, g.at)
                        .is_ok()
                    {
                        placed = true;
                        break;
                    }
                    refused_orders += 1;
                }
                if !placed {
                    // No route from where it stands: it stays, arrived where it is, and tries again in 10 s.
                    let ix = crowd.walkers.partition_point(|o| o.body.id < b.id);
                    crowd.walkers.insert(
                        ix,
                        Walker {
                            body: b,
                            speed: SPEED,
                            order: order_id(orders),
                            legs: vec![Leg {
                                to: b.pose.position,
                                link: None,
                            }],
                            leg: 0,
                            crossing: false,
                            arrived: Some(at),
                            waiting: None,
                            staying: false,
                            shoulder: false,
                            held: None,
                            to: None,
                            spot: None,
                        },
                    );
                    plans[k].due = Some(at + 10_000_000);
                    plans[k].live = false;
                    continue;
                }
                plans[k] = Plan {
                    due: None,
                    run: if plans[k].run <= 1 {
                        if arm == "event" {
                            seed.within(1, 5) as u8
                        } else {
                            0
                        }
                    } else {
                        plans[k].run - 1
                    },
                    since: at,
                    leg: 0,
                    best: i64::MAX,
                    progress: at,
                    live: true,
                    meet: false,
                };
            }
            let orders_ns = o0.elapsed().as_nanos() as i64;
            let plan_in_orders = (w.ns[PLAN] - ns0[PLAN]) as i64;
            if let Err(e) = ladder.step(&mut crowd, &mut w) {
                fault = Some(format!("tick at {at}: refused: {}: {}", e.name, e.detail));
                return;
            }
            let total = a0.elapsed().as_nanos() as i64;
            let d: Vec<i64> = (0..5).map(|i| (w.ns[i] - ns0[i]) as i64).collect();
            // The world calls made inside the ladder's tick (routing in the orders is counted once, as `plan`).
            let in_step = d.iter().sum::<i64>() - plan_in_orders;
            let skill = total - orders_ns - in_step;
            let ph = [
                orders_ns - plan_in_orders,
                d[PLAN],
                d[CORNER],
                d[MOVER],
                d[CROSS],
                d[TURNS],
                skill.max(0),
            ];
            tick_us.push(total / 1000);
            phase_us.push(ph.map(|v| v / 1000));

            // Not timed: faults, rungs, arrivals, progress, the record and the trace.
            for (call, who, why) in &w.faults[faults_seen..] {
                *fault_kinds
                    .entry(format!("{call}: {}", why.split(':').next().unwrap_or("")))
                    .or_default() += 1;
                faulted.insert(*who);
                if fault_shown < 5 {
                    fault_shown += 1;
                    println!(
                        "walkers: fault at {} ms: walker {}: {call}: {why}",
                        at / 1000,
                        index[who]
                    );
                }
                if let Some(x) = crowd.walkers.iter_mut().find(|x| x.body.id == *who) {
                    x.held = Some("engine-fault");
                    x.crossing = false;
                    x.waiting = None;
                }
            }
            faults_seen = w.faults.len();
            for r in &ladder.log[log_seen..] {
                *rungs.entry(r.rung.name()).or_default() += 1;
            }
            log_seen = ladder.log.len();
            let mut walking = 0;
            for x in &crowd.walkers {
                let k = index[&x.body.id];
                let p = &mut plans[k];
                if !p.live {
                    continue;
                }
                if x.arrived.is_some() || x.held.is_some_and(|h| h != "walk-out") {
                    p.live = false;
                    if x.arrived.is_some() {
                        finished += 1;
                        route_us.push(at - p.since);
                    } else {
                        ended += 1;
                    }
                    let gap = if arm == "event" {
                        if p.run > 1 {
                            seed.within(2_000_000, 4_000_000)
                        } else {
                            let s = (30.0 * (1.25 * seed.normal()).exp()).max(2.0);
                            (s * 1e6) as i64
                        }
                    } else {
                        seed.within(5_000_000, 15_000_000)
                    };
                    p.due = Some(at + gap);
                    continue;
                }
                walking += 1;
                let gap = dist(xz(x.body.pose.position), xz(x.legs[x.leg].to));
                if x.leg != p.leg || gap + NEARER <= p.best {
                    p.leg = x.leg;
                    p.best = gap;
                    p.progress = at;
                } else if p.best == i64::MAX {
                    p.best = gap;
                }
                if at - p.progress > worst.0 {
                    worst = (at - p.progress, k);
                }
            }
            if let Some((f, c)) = trace.as_mut() {
                for x in &crowd.walkers {
                    let k = index[&x.body.id];
                    let node = node_of(&x.body);
                    let q = frames
                        .get(&node)
                        .and_then(|fr| fr.point(x.body.pose.position).ok())
                        .unwrap_or(x.body.pose.position);
                    let (px, pz) = (
                        (q.x / 10_000).clamp(-32_767, 32_767) as i16,
                        (q.z / 10_000).clamp(-32_767, 32_767) as i16,
                    );
                    row[2 * k..2 * k + 2].copy_from_slice(&px.to_le_bytes());
                    row[2 * n + 2 * k..2 * n + 2 * k + 2].copy_from_slice(&pz.to_le_bytes());
                    row[4 * n + k] = node_ix.get(&node).copied().unwrap_or(0);
                }
                f.write_all(&row).unwrap();
                let ph = phase_us.last().unwrap();
                writeln!(
                    c,
                    "{},{},{},{walking},0",
                    tick_us.len() - 1,
                    tick_us.last().unwrap(),
                    ph.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
                )
                .unwrap();
            }
        };
        ticker
            .run_due(&mut real, &beat, &mut body)
            .expect("the clock");
        if ticker.next_tick() < ticks {
            ticker.wait(&mut real).expect("the clock");
        }
    }
    if let Some((mut f, mut c)) = trace {
        f.flush().unwrap();
        c.flush().unwrap();
    }
    if let Some(f) = fault {
        println!("walkers: FAULT {f}");
        std::process::exit(2);
    }

    // The summary.
    let mut t = tick_us.clone();
    let (med, p99, max) = (pct(&mut t, 50), pct(&mut t, 99), *t.last().unwrap_or(&0));
    let by_phase: Vec<String> = (0..7)
        .map(|i| {
            let mut v: Vec<i64> = phase_us.iter().map(|p| p[i]).collect();
            let sum: i64 = v.iter().sum();
            format!(
                "{} median {} us, p99 {} us, max {} us, share {}%",
                NAMES[i],
                pct(&mut v, 50),
                pct(&mut v, 99),
                v.last().copied().unwrap_or(0),
                sum * 100 / tick_us.iter().sum::<i64>().max(1)
            )
        })
        .collect();
    let (rm, r90, rmax) = {
        let mut r = route_us.clone();
        (
            pct(&mut r, 50),
            pct(&mut r, 90),
            r.last().copied().unwrap_or(0),
        )
    };
    let s = ticker.stats;
    println!(
        "walkers: ticks {}, tick median {} us, p99 {} us, max {} us",
        tick_us.len(),
        med,
        p99,
        max
    );
    for l in &by_phase {
        println!("walkers: phase {l}");
    }
    println!(
        "walkers: clock: ticks {}, overruns {}, longest {} us, most lag {} us",
        s.ticks, s.overruns, s.max_tick_us, s.max_lag_us
    );
    println!(
        "walkers: orders {orders} ({refused_orders} refused routes), trips finished {finished}, ended by name {ended}; route time median {} ms, p90 {} ms, max {} ms",
        rm / 1000,
        r90 / 1000,
        rmax / 1000
    );
    println!(
        "walkers: longest without progress under a live order {} ms (walker {}); rungs {:?}; overlap share {}.{:02}% ({} of {} walker-ticks)",
        worst.0 / 1000,
        worst.1,
        rungs,
        crowd.close * 100 / crowd.walked.max(1),
        crowd.close * 10_000 / crowd.walked.max(1) % 100,
        crowd.close,
        crowd.walked
    );
    println!(
        "walkers: walker faults {} on {} walkers (each held, its next order as after an end): {:?}",
        w.faults.len(),
        faulted.len(),
        fault_kinds
    );
    {
        let all = tick_us.iter().sum::<i64>().max(1) as u64 * 1000;
        let calls = w.by_node.values().sum::<u64>().max(1);
        let (busy, ns) = w
            .by_node
            .iter()
            .max_by_key(|(id, ns)| (**ns, std::cmp::Reverse(**id)))
            .map_or((ground, 0), |(id, ns)| (*id, *ns));
        let mut on: BTreeMap<Id, usize> = BTreeMap::new();
        for x in &crowd.walkers {
            *on.entry(node_of(&x.body)).or_default() += 1;
        }
        let mut counts: Vec<usize> = on.values().copied().collect();
        counts.sort_unstable_by(|a, b| b.cmp(a));
        println!(
            "walkers: by node: {} nodes; the busiest, {}, {} % of the world calls and {} % of tick time; walkers by node at the end, most first: {:?}{}",
            w.by_node.len(),
            if busy == ground {
                "the open ground".to_owned()
            } else {
                format!("{busy:?}")
            },
            ns * 100 / calls,
            ns * 100 / all,
            &counts[..counts.len().min(8)],
            if counts.len() > 8 { " ..." } else { "" }
        );
    }
    if arm == "event" {
        println!("walkers: crowd moments {moments}, reactions {reacted}");
    }
    let bar = |ok: bool| if ok { "pass" } else { "miss" };
    println!(
        "walkers: bars: median <= 5 ms {}; p99 <= 15 ms {}; no walker without progress for 30 s {}",
        bar(med <= 5_000),
        bar(p99 <= 15_000),
        bar(worst.0 < 30_000_000)
    );
}
