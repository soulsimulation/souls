//! Engine v2 N15 (#2660): the win 1 gate. A thousand walkers in Eden, the clock at 20 ticks a second in real time.
//! Moved onto the walk skill through the host (T9c #3127) by #3167.
//!
//! `cargo run -p bench --release --bin walkers -- <facts.json> <labels.json> <arm> <seed> [walkers] [seconds]
//! [out-dir] [--fast]` (from `v2/`; defaults 1,000 walkers, 600 s, no files written). `arm` is `uniform` or `event`.
//!
//! - **The world** is N1's import of Eden 2026 (`v2/tools/import-eden`), walked by N7's walk skill
//!   (`skills::route`) through the host's [`Runner`], with N8's turns and N10's ladder over N3 to N6
//!   ([`sim::walk::town::Town`]), exactly as the sim tests build it.
//! - **The places** are the catalog places N18's labels (`v2/tools/compare-reach`) say today's engine reaches, that
//!   the new ground holds within 1.5 m on the open ground or on a building's lowest floor, that lie within the trace's
//!   ±320 m, and that N5 routes to from the arrival point. Every other place is left out and counted by reason.
//! - **The walkers** stand on legal ground at seeded places from the first tick, each with an order to walk to a
//!   seeded place, then another. Times and places follow `tools/bench/capacity/profiles/shapes.json` (read, never
//!   edited): `uniform` waits `10 s x U(0.5, 1.5)` after each arrival and draws places evenly; `event` draws 60 % of
//!   places within 30 m of the meetup place (the bandstand), waits in runs (1 to 4 walks, `U(2, 4)` s apart, then a
//!   log-normal pause, median 30 s, sigma 1.25, at least 2 s), and every `U(45, 120)` s sends 30 % of the walkers to
//!   the meetup place within 2 s, replacing their orders. A walker whose order ended by name (the ladder's
//!   `goal-unreachable`, or its walk's own) is given its next order as if it had arrived.
//! - **The clock** is K7's [`Ticker`] on a real clock: absolute deadlines, catch-up after an overrun. `--fast` runs
//!   the ticks back to back (for a quick look; never for the gate).
//! - **Tick time** is the whole clock-thread tick: new orders, then the ladder's tick (the runner's tick inside it),
//!   door openings written to memory. By phase: `orders` (new orders, their routing included), `corner` (the next
//!   corner, timed by the town's [`Town::meter`]: `clear` its straight-walk checks and `search` its route searches)
//!   and `step` (the rest of the ladder's and the runner's tick: skills, controller, turns, reroutes). Not in it: the
//!   per-tick record, progress and the trace.
//! - **Progress** (N15's 30 s, approximate on the host): under a live order, a walker progresses when it arrives,
//!   when it is carried across a link, or when it stands 1 m nearer its order's goal than its best on the node it
//!   stands on.
//! - **Faults.** A tick whose runner refused something (a body's step or crossing) is counted with the first
//!   refusal's name; the tick and every other walker went on.
//!
//! - **Joins** (K10, #2673; `--joins <count>,<seconds>`, the `joins` bench): `count` Souls ask a birth, evenly over
//!   `seconds` from 10 s in, by one entry at the meetup place. [`sim::life::Life`] takes at most [`BIRTHS`] a tick on
//!   the clock thread, inside the `orders` phase; the rest carry to the next tick. Each born body walks as a walker
//!   from its birth tick. Posted: every join born or not, the longest wait, and the clock time per birth.
//!
//! Out: a summary line per measure on stdout; with `out-dir`, `ticks.csv` (one row per tick, µs by phase) and
//! `run.trace` (V14's throwaway `birdseye/0` trace, for `v2/tools/birdseye/view.html`). Generated, never committed.

// A bench: it times its own ticks (K7's wall-clock rule binds the engine, not its benches).
#![allow(clippy::disallowed_methods)]
// Walkers are indexed by number throughout: a plan, a trace column and a body id each.
#![allow(clippy::needless_range_loop)]

use import_eden::json::{self, Json};
use import_eden::{F_LEVEL, F_OUTLINE, Import, PLACE, ROOM};
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Header, Refusal, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::host::{F_HELD, Progress};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Quat, Vec3};
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use replica::world_model::plain;
use sim::clock::{Clock, Heartbeat, Ticker};
use sim::ground::scene::{Xform, xform_to};
use sim::host::Runner;
use sim::life::{Birth, Life, Ring};
use sim::links::Doors;
use sim::mover::Body;
use sim::unstick::{Ladder, Unstick};
use sim::walk::town::{Spent, Town};
use sim::walk::{World, node_of};
use skills::route::Route;
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::OnceLock;
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
/// Births a tick, at most (K10's budget: a birth's clock time times this stays far under a tick).
const BIRTHS: usize = 32;
/// Joins start this far into the run, µs.
const JOINS_FROM: Micros = 10_000_000;

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

const NAMES: [&str; 3] = ["orders", "corner", "step"];

/// The bench's monotonic clock in ns, for the town's [`Town::meter`].
fn mono_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

fn humanoid() -> Family {
    let r = |n: &str| Resource {
        name: Name::new(n).expect("a name"),
        class: Class::Locomotion,
        slot: None,
    };
    Family {
        name: Name::new("souls:humanoid").expect("a name"),
        resources: vec![r("souls:leg-left"), r("souls:leg-right")],
    }
}

/// Starts `body`'s walk (new to the runner, or already in it) to `goal` on `node` for `order`: its legs planned by
/// the town, its walk the skill, the ladder keeping it.
fn order(
    runner: &mut Runner,
    ladder: &mut Ladder,
    town: &mut Town,
    body: Body,
    order: Id,
    node: Id,
    goal: Vec3,
) -> Result<(), Refusal> {
    let legs = town.plan(&body, node, goal)?;
    let skill = Box::new(Route::new(
        legs.iter()
            .map(|l| skills::route::Leg {
                to: l.to,
                link: l.link,
            })
            .collect(),
        SPEED,
        TICK,
    ));
    if runner.controller.body(body.id).is_some() {
        runner.start(body.id, skill)?;
    } else {
        runner.add(humanoid(), body, skill)?;
    }
    ladder.add(body.id, order, SPEED, node, goal, legs);
    Ok(())
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
    /// Its order's goal (node and point), the node it stood on at its last progress, and whether it was carried.
    goal: (Option<Id>, Vec3),
    node: Option<Id>,
    carried: bool,
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
    let jx = args.iter().position(|a| a == "--joins");
    let (joins, join_s): (usize, i64) = jx.map_or((0, 1), |i| {
        let v = args.get(i + 1).expect("--joins <count>,<seconds>");
        let (c, t) = v.split_once(',').expect("--joins <count>,<seconds>");
        (c.parse().expect("a count"), t.parse().expect("seconds"))
    });
    let args: Vec<&String> = args
        .iter()
        .enumerate()
        .filter(|&(i, a)| a != "--fast" && jx.is_none_or(|j| i != j && i != j + 1))
        .map(|(_, a)| a)
        .collect();
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
    let mut w = town;
    w.meter = Some(mono_ns);
    let ground = w.ground;
    let gh = w.tree.handle(ground).expect("the ground");
    let load_ms = t0.elapsed().as_millis();

    // Each surface's frame on the open ground, and its floor.
    let frames: BTreeMap<Id, Xform> = w
        .surfaces
        .keys()
        .map(|&s| {
            let x = if s == ground {
                Xform::IDENTITY
            } else {
                xform_to(&w.tree, w.tree.handle(s).expect("a floor"), gh).expect("on the ground")
            };
            (s, x)
        })
        .collect();
    let lowest: Vec<Id> = w
        .buildings
        .iter()
        .flat_map(|b| {
            b.floors
                .iter()
                .filter(|(_, (l, _))| *l == 0)
                .map(|(f, _)| *f)
        })
        .filter(|f| w.surfaces.contains_key(f))
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
    let start = w
        .nearest(ground, arrival)
        .expect("ground at the arrival point");
    let probe = w.surfaces[&ground]
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
                let q = w.nearest(s, local)?;
                (dist(xz(q), xz(local)) <= TOL).then_some((s, q))
            });
            let (node, at) = held.ok_or("the new ground does not hold it")?;
            w.plan(&probe, node, at)
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
    let mut runner = Runner::new(TICK);
    let mut ladder = Ladder::new();
    // Walkers placed now, then the joins as they are born: `ids[k]` is walker `k`'s body.
    let total = n + joins;
    let mut ids: Vec<Id> = (0..n).map(|k| walker_id(k as u64)).collect();
    let mut plans: Vec<Plan> = vec![Plan::default(); total];
    let mut orders = 0u64;
    let draw = |seed: &mut Seed| -> usize {
        if arm == "event" && seed.below(10) < 6 {
            near_meet[seed.below(near_meet.len())]
        } else {
            seed.below(places.len())
        }
    };
    let mut refused_orders = 0u64;
    let mut goals: Vec<(Option<Id>, Vec3)> = vec![(None, Vec3::ZERO); total];
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
                let Some(q) = w.nearest(p.node, j) else {
                    continue;
                };
                if let Ok(b) = w.surfaces[&p.node].place(
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
                goals[k] = (Some(g.node), g.at);
                match order(
                    &mut runner,
                    &mut ladder,
                    &mut w,
                    body,
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
            goal: goals[k],
            ..Plan::default()
        };
    }
    w.spent.set(Spent::default());
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
        let mut stack = vec![w.tree.root()];
        while let Some(h) = stack.pop() {
            let nd = w.tree.node(h).expect("live");
            let kind = plain(nd.kind().as_str()).to_owned();
            if kind == ROOM {
                let floor = nd.parent().map_or(0, |f| level_of(&w, f));
                if let Ok(x) = xform_to(&w.tree, h, gh) {
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
            stack.extend(w.tree.children(h).expect("live").iter().copied());
        }
        let mut floors: Vec<i64> = node_list.iter().map(|&s| level_of(&w, s)).collect();
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
                    if s == ground { "open ground".to_owned() } else { format!("floor {}", level_of(&w, s)) },
                    level_of(&w, s)
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
        writeln!(
            c,
            "tick,total_us,{},clears,clear_us,searches,search_us,walking,overruns",
            NAMES.join("_us,") + "_us"
        )
        .unwrap();
        (f, c)
    });

    // Births (K10): one entry, a ring of spots round the meetup place.
    let entry = Id::new(Scope([0xe1; 16]), 1).expect("an id");
    let ring = Ring {
        entries: BTreeMap::from([(entry, (places[meet].node, places[meet].at))]),
        radius: 2_000_000,
        gap: 1_000_000,
        rings: 4,
    };
    let mut life = Life::new(Scope([0x1b; 16]), BIRTHS);
    let family = humanoid();
    let (mut asked, mut join_refused, mut longest_wait) = (0usize, 0u64, 0 as Micros);
    let mut birth_ns: Vec<i64> = Vec::new();
    let mut birth_tick_us: Vec<i64> = Vec::new();
    // The clock kept through the wave (#2615's bar): ticks run over ticks owed by real time, from the first join
    // asked to 20 s of world time after the last born.
    let (mut wave0, mut wave1): (Option<(Instant, usize)>, Option<(Instant, usize)>) = (None, None);
    let mut last_born: Micros = 0;

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
    let mut phase_us: Vec<[i64; 3]> = Vec::with_capacity(ticks as usize);
    // Per tick: straight-walk checks, their time (µs), route searches, their time (µs).
    let mut corner_parts: Vec<[i64; 4]> = Vec::with_capacity(ticks as usize);
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
    let mut fault_shown = 0;
    let mut fault_kinds: BTreeMap<String, u64> = BTreeMap::new();
    let mut ended_names: BTreeMap<String, u64> = BTreeMap::new();
    let mut faulty_ticks = 0u64;
    while ticker.next_tick() < ticks {
        let mut body = |tick: i64, start: Micros| {
            // The clock catches up after an overrun: never past the run's last tick.
            if tick >= ticks {
                return;
            }
            let at = start + TICK;
            let s0 = w.spent.get();
            let a0 = Instant::now();
            // Joins asked by this tick's end, then this tick's births (K10).
            if joins > 0 && wave0.is_none() && at >= JOINS_FROM {
                wave0 = Some((a0, tick_us.len()));
            }
            if wave1.is_none() && joins > 0 && ids.len() == total && at >= last_born + 20_000_000 {
                wave1 = Some((a0, tick_us.len()));
            }
            while asked < joins
                && JOINS_FROM + join_s * 1_000_000 * asked as i64 / joins as i64 <= at
            {
                let when = JOINS_FROM + join_s * 1_000_000 * asked as i64 / joins as i64;
                let soul = Id::new(Scope([0x50; 16]), asked as u64 + 1).expect("an id");
                if life
                    .ask(Birth {
                        soul,
                        entry,
                        asked: when,
                    })
                    .is_err()
                {
                    join_refused += 1;
                }
                asked += 1;
            }
            if life.waiting() > 0 {
                let b0 = Instant::now();
                let born = life.tick(at, &mut runner, &w.surfaces, &ring, &family);
                let b_ns = b0.elapsed().as_nanos() as i64;
                if !born.is_empty() {
                    birth_ns.push(b_ns / born.len() as i64);
                    birth_tick_us.push(b_ns / 1000);
                }
                for b in born {
                    longest_wait = longest_wait.max(b.waited);
                    let k = ids.len();
                    ids.push(b.body);
                    last_born = at;
                    plans[k].due = Some(at);
                }
            }
            // Orders due this tick: the next walk of each walker that waited, and the crowd moments.
            if at >= next_moment {
                moments += 1;
                next_moment = at + seed.within(45_000_000, 120_000_000);
                for k in 0..ids.len() {
                    if seed.below(10) < 3 {
                        plans[k].due = Some(at + seed.within(0, 2_000_000));
                        plans[k].meet = true;
                        reacted += 1;
                    }
                }
            }
            for k in 0..ids.len() {
                let Some(due) = plans[k].due else { continue };
                if due > at {
                    continue;
                }
                let who = ids[k];
                let Some(b) = runner.controller.body(who).copied() else {
                    continue;
                };
                if runner.controller.carried(who)
                    || runner
                        .fields
                        .get(&who)
                        .is_some_and(|f| f.contains_key(&F_HELD))
                {
                    continue;
                }
                // A crowd moment replaces a live order.
                runner.end_order(who);
                let mut placed = false;
                for _ in 0..5 {
                    let gi = if plans[k].meet {
                        near_meet[seed.below(near_meet.len())]
                    } else {
                        draw(&mut seed)
                    };
                    let g = &places[gi];
                    orders += 1;
                    if order(
                        &mut runner,
                        &mut ladder,
                        &mut w,
                        b,
                        order_id(orders),
                        g.node,
                        g.at,
                    )
                    .is_ok()
                    {
                        placed = true;
                        plans[k].goal = (Some(g.node), g.at);
                        break;
                    }
                    refused_orders += 1;
                }
                if !placed {
                    // No route from where it stands: it stays where it is, and tries again in 10 s.
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
                    goal: plans[k].goal,
                    node: None,
                    carried: false,
                    best: i64::MAX,
                    progress: at,
                    live: true,
                    meet: false,
                };
            }
            let orders_ns = a0.elapsed().as_nanos() as i64;
            let s1 = w.spent.get();
            let r = ladder.step(&mut runner, &mut w);
            let total = a0.elapsed().as_nanos() as i64;
            let s2 = w.spent.get();
            let ph = [
                orders_ns - (s1.corner_ns - s0.corner_ns) as i64,
                (s2.corner_ns - s0.corner_ns) as i64,
                (total - orders_ns - (s2.corner_ns - s1.corner_ns) as i64).max(0),
            ];
            tick_us.push(total / 1000);
            phase_us.push(ph.map(|v| v / 1000));
            corner_parts.push([
                (s2.clears - s0.clears) as i64,
                ((s2.clear_ns - s0.clear_ns) / 1000) as i64,
                (s2.searches - s0.searches) as i64,
                ((s2.search_ns - s0.search_ns) / 1000) as i64,
            ]);

            // Not timed: faults, rungs, ends, progress, the record and the trace.
            if let Err(e) = r {
                faulty_ticks += 1;
                *fault_kinds.entry(e.name.to_owned()).or_default() += 1;
                if fault_shown < 5 {
                    fault_shown += 1;
                    println!(
                        "walkers: fault at {} ms: {}: {}",
                        at / 1000,
                        e.name,
                        e.detail
                    );
                }
            }
            for r in &ladder.log[log_seen..] {
                *rungs.entry(r.rung.name()).or_default() += 1;
            }
            log_seen = ladder.log.len();
            let mut walking = 0;
            for k in 0..ids.len() {
                let who = ids[k];
                let p = &mut plans[k];
                if !p.live {
                    continue;
                }
                if !runner.running(who) {
                    p.live = false;
                    match runner.ended.get(&who) {
                        Some((_, Progress::Done)) => {
                            finished += 1;
                            route_us.push(at - p.since);
                        }
                        Some((_, Progress::Failed(name))) => {
                            ended += 1;
                            *ended_names.entry(name.as_str().to_owned()).or_default() += 1;
                        }
                        _ => ended += 1,
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
                let Some(b) = runner.controller.body(who) else {
                    continue;
                };
                let carried = runner.controller.carried(who);
                let node = node_of(b);
                let gap = if p.goal.0 == Some(node) {
                    dist(xz(b.pose.position), xz(p.goal.1))
                } else {
                    i64::MAX
                };
                let crossed = p.carried && !carried;
                p.carried = carried;
                if carried
                    || crossed
                    || p.node != Some(node)
                    || gap.saturating_add(NEARER) <= p.best
                {
                    p.node = Some(node);
                    p.best = gap;
                    p.progress = at;
                }
                if at - p.progress > worst.0 {
                    worst = (at - p.progress, k);
                }
            }
            if let Some((f, c)) = trace.as_mut() {
                for b in runner.controller.bodies() {
                    let Some(&k) = index.get(&b.id) else { continue };
                    let node = node_of(b);
                    let q = frames
                        .get(&node)
                        .and_then(|fr| fr.point(b.pose.position).ok())
                        .unwrap_or(b.pose.position);
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
                let cp = corner_parts.last().unwrap();
                writeln!(
                    c,
                    "{},{},{},{},{walking},0",
                    tick_us.len() - 1,
                    tick_us.last().unwrap(),
                    ph.iter().map(i64::to_string).collect::<Vec<_>>().join(","),
                    cp.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
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

    // The summary.
    let mut t = tick_us.clone();
    let (med, p99, max) = (pct(&mut t, 50), pct(&mut t, 99), *t.last().unwrap_or(&0));
    let by_phase: Vec<String> = (0..3)
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
        "walkers: longest without progress under a live order {} ms (walker {}); rungs {:?}; ended by name {:?}",
        worst.0 / 1000,
        worst.1,
        rungs,
        ended_names
    );
    println!(
        "walkers: ticks with a refusal {faulty_ticks} (the first of each, by name): {fault_kinds:?}"
    );
    // The next corner's parts: straight-walk checks and route searches, a tick and in all.
    let sp = w.spent.get();
    let part = |i: usize| {
        let mut v: Vec<i64> = corner_parts.iter().map(|p| p[i]).collect();
        (pct(&mut v, 50), pct(&mut v, 99))
    };
    let (cm, c99) = part(0);
    let (ctm, ct99) = part(1);
    let (sm, s99) = part(2);
    let (stm, st99) = part(3);
    let minutes = (tick_us.len() as u64 * TICK as u64).max(1) as f64 / 60e6;
    println!(
        "walkers: corner: {} calls; straight-walk checks {} ({} ns each), a tick median {cm} / p99 {c99}, {ctm} / {ct99} us; route searches {} ({} ns each), a tick median {sm} / p99 {s99}, {stm} / {st99} us; searches a walker a minute {:.2}; lines searched for {} (new leg, order or target {}; pushed off the line {}; at a piece's end {}; straight walk refused {}), a walker a minute {:.2}",
        sp.corners,
        sp.clears,
        sp.clear_ns / sp.clears.max(1),
        sp.searches,
        sp.search_ns / sp.searches.max(1),
        sp.searches as f64 / n as f64 / minutes,
        sp.lines_new + sp.lines_off + sp.lines_end + sp.lines_blocked,
        sp.lines_new,
        sp.lines_off,
        sp.lines_end,
        sp.lines_blocked,
        (sp.lines_new + sp.lines_off + sp.lines_end + sp.lines_blocked) as f64 / n as f64 / minutes
    );
    if arm == "event" {
        println!("walkers: crowd moments {moments}, reactions {reacted}");
    }
    if joins > 0 {
        let born = ids.len() - n;
        let (bm, bmax) = (
            pct(&mut birth_ns, 50),
            birth_ns.last().copied().unwrap_or(0),
        );
        let (tm, tmax) = (
            pct(&mut birth_tick_us, 50),
            birth_tick_us.last().copied().unwrap_or(0),
        );
        let kept = match (wave0, wave1) {
            (Some((i0, t0)), Some((i1, t1))) => {
                let owed = (i1 - i0).as_micros() as f64 / TICK as f64;
                format!(
                    "{:.3} ({} ticks run, {owed:.0} owed)",
                    (t1 - t0) as f64 / owed,
                    t1 - t0
                )
            }
            _ => "not measured (the run ended inside the wave)".to_owned(),
        };
        println!("walkers: clock kept through the wave {kept}");
        println!(
            "walkers: joins {joins} over {join_s} s: asked {asked}, born {born}, refused {join_refused}, still waiting {}; longest wait {} ms; clock time a birth median {bm} ns, max {bmax} ns; births a tick at most {BIRTHS}, their time a tick median {tm} us, max {tmax} us",
            life.waiting(),
            longest_wait / 1000,
        );
    }
    let bar = |ok: bool| if ok { "pass" } else { "miss" };
    println!(
        "walkers: bars: median <= 5 ms {}; p99 <= 15 ms {}; corner median < 1 ms {}; no walker without progress for 30 s {}",
        bar(med <= 5_000),
        bar(p99 <= 15_000),
        bar({
            let mut v: Vec<i64> = phase_us.iter().map(|p| p[1]).collect();
            pct(&mut v, 50) < 1_000
        }),
        bar(worst.0 < 30_000_000)
    );
}
