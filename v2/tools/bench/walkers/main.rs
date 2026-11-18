//! Engine v2 N15 (#2660): the win 1 gate. A thousand walkers in Eden, the clock at 20 ticks a second in real time.
//!
//! `cargo run -p bench --release --bin walkers -- <facts.json> <labels.json> <arm> <seed> [walkers] [seconds]
//! [out-dir] [--fast]` (from `v2/`; defaults 1,000 walkers, 600 s, no files written). `arm` is `uniform` or `event`.
//!
//! - **The world** is N1's import of Eden 2026 (`v2/tools/import-eden`) as a [`Town`]. Each walker is a body in a
//!   [`Runner`] (T9c #3127) running N7's walk skill (`skills::route`), its legs planned by the town, with N8's turns
//!   and N10's ladder ([`Ladder`]) over it, as the sim tests build them.
//! - **The places** are the catalog places N18's labels (`v2/tools/compare-reach`) say today's engine reaches, that
//!   the new ground holds within 1.5 m on the open ground or on a building's lowest floor, that lie within the trace's
//!   ±320 m, and that N5 routes to from the arrival point. Every other place is left out and counted by reason.
//! - **The walkers** stand on legal ground at seeded places from the first tick (never in a pocket of ground no walk
//!   reaches from the arrival point, #3187), each with an order to walk to a seeded place, then another. Times and places follow `tools/bench/capacity/profiles/shapes.json` (read, never
//!   edited): `uniform` waits `10 s x U(0.5, 1.5)` after each arrival and draws places evenly; `event` draws 60 % of
//!   places within 30 m of the meetup place (the bandstand), waits in runs (1 to 4 walks, `U(2, 4)` s apart, then a
//!   log-normal pause, median 30 s, sigma 1.25, at least 2 s), and every `U(45, 120)` s sends 30 % of the walkers to
//!   the meetup place within 2 s, replacing their orders. A walker whose order ended by name (the ladder's
//!   `goal-unreachable`) is given its next order as if it had arrived.
//! - **The clock** is K7's [`Ticker`] on a real clock: absolute deadlines, catch-up after an overrun. `--fast` runs
//!   the ticks back to back: world time and every walker's path are the same, so it serves the progress bar and a
//!   quick look, never the timing bars.
//! - **Tick time** is the whole clock-thread tick: new orders (their routing included), then the ladder's tick (the
//!   runner's tick inside it). By phase (#3167): `orders` (new orders, their routing included), `corner` (the next
//!   corner, timed by the town's [`Town::meter`]) and `step` (the rest of the ladder's and the runner's tick). Not in
//!   it: the per-tick record, progress, the trace and the bench's own bookkeeping.
//! - **Progress** (the bar's 30 s): under a live order, a walker progresses when it arrives, when its leg advances (a
//!   link crossed), or when it stands 1 m nearer its leg's end than at its last progress. A new route from the ladder
//!   is not progress: the distance is measured again, from the new leg's end.
//! - **Faults.** An engine refusal of one walker (`Runner::refused`: a step, a crossing's track or its landing) is a
//!   fault of that walker alone: counted by name and link, and its order ends by name (`engine-fault`), so the clock
//!   and the others go on.
//! - **The log** (#3168): each walker that passes 30 s without progress is printed once per order with its state
//!   (crossing, walking out, waiting for a link, or walking), and the faults and refused routes are listed by link and
//!   by piece.
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
use replica::world_model::{plain, show};
use sim::clock::{Clock, Heartbeat, Ticker};
use sim::ground::scene::{Xform, xform_to};
use sim::host::{Runner, named, waiting};
use sim::links::Doors;
use sim::mover::Body;
use sim::routes::HANDS;
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
/// The bar: no walker under a live order without progress this long, µs.
const BAR: Micros = 30_000_000;

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

/// A body with two legs, as the sim tests give their walkers.
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

/// Gives `body` (new to the runner, or in it with no run) the order `order` to walk to `goal` on `node`: its legs
/// planned by the town, N7's walk run on it, the ladder over it.
fn give(
    r: &mut Runner,
    l: &mut Ladder,
    t: &mut Town,
    body: Body,
    order: Id,
    node: Id,
    goal: Vec3,
) -> Result<(), Refusal> {
    let legs = t.plan(&body, node, goal)?;
    let walk = Box::new(Route::new(
        legs.iter()
            .map(|g| skills::route::Leg {
                to: g.to,
                link: g.link,
            })
            .collect(),
        SPEED,
        TICK,
    ));
    if r.controller.body(body.id).is_some() {
        r.start(body.id, walk)?;
    } else {
        r.add(humanoid(), body, walk)?;
    }
    l.add(body.id, order, SPEED, node, goal, legs);
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

fn town_of(im: Import) -> Town {
    let Import {
        tree, rules, nodes, ..
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
    Town::new(tree, ground, Doors::new(header, rules, next)).expect("the town")
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

/// Where a body stands, for the lists: its node and N5's piece there, or the point when no piece holds it.
fn piece_of(t: &Town, b: &Body) -> String {
    let node = node_of(b);
    let p = b.pose.position;
    let on = if node == t.ground {
        "open ground".to_owned()
    } else {
        format!("floor {} {}", level_of(t, node), show(node))
    };
    match t.map.spot(node, p) {
        Some(s) => format!("{on} piece {}", s.piece),
        None => format!(
            "{on} off every piece at ({} mm, {} mm)",
            p.x / 1000,
            p.z / 1000
        ),
    }
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
    /// The leg it walks as the ladder keeps it: index and end.
    leg: usize,
    to: Vec3,
    best: i64,
    progress: Micros,
    live: bool,
    /// Logged past the bar in this order.
    logged: bool,
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

/// The most counted keys of `m`, at most `k`, as `count x key`.
fn top(m: &BTreeMap<String, u64>, k: usize) -> Vec<String> {
    let mut v: Vec<(&String, &u64)> = m.iter().collect();
    v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    v.into_iter()
        .take(k)
        .map(|(s, c)| format!("{c} x {s}"))
        .collect()
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
    let mut town = town_of(import_eden::load(&text).expect("Eden loads"));
    town.meter = Some(mono_ns);
    drop(text);
    let ground = town.ground;
    let gh = town.tree.handle(ground).expect("the ground");
    let load_ms = t0.elapsed().as_millis();

    // Each surface's frame on the open ground, and its floor.
    let frames: BTreeMap<Id, Xform> = town
        .surfaces
        .keys()
        .map(|&s| {
            let x = if s == ground {
                Xform::IDENTITY
            } else {
                xform_to(&town.tree, town.tree.handle(s).expect("a floor"), gh)
                    .expect("on the ground")
            };
            (s, x)
        })
        .collect();
    let lowest: Vec<Id> = town
        .buildings
        .iter()
        .flat_map(|b| {
            b.floors
                .iter()
                .filter(|(_, (l, _))| *l == 0)
                .map(|(f, _)| *f)
        })
        .filter(|f| town.surfaces.contains_key(f))
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
    let start = town
        .nearest(ground, arrival)
        .expect("ground at the arrival point");
    let probe = town.surfaces[&ground]
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
                let q = town.nearest(s, local)?;
                (dist(xz(q), xz(local)) <= TOL).then_some((s, q))
            });
            let (node, at) = held.ok_or("the new ground does not hold it")?;
            town.plan(&probe, node, at)
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
    // Refused routes by where they started and why (N5's list).
    let mut refused_at: BTreeMap<String, u64> = BTreeMap::new();
    // A start the routes cannot leave (the jitter can land on a piece of its own) is drawn again: counted.
    let mut restarts = 0u64;
    // Pockets (#3187): ground no walk reaches from the arrival point, a part of N5's map of its own. Eden has them:
    // the tennis courts, fenced on all four sides with no gate (today's engine finds them `nav.disconnected` too), and
    // slivers of a floor pinched between furniture and walls. A start the jitter puts in one is drawn again.
    let parts = town.map.parts(HANDS);
    let main_part = town
        .map
        .spot(ground, start)
        .map(|s| parts[s.piece as usize])
        .expect("the arrival point on the map");
    let mut pockets = 0u64;
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
                let Some(q) = town.nearest(p.node, j) else {
                    continue;
                };
                if town
                    .map
                    .spot(p.node, q)
                    .is_none_or(|s| parts[s.piece as usize] != main_part)
                {
                    pockets += 1;
                    continue;
                }
                if let Ok(b) = town.surfaces[&p.node].place(
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
                match give(
                    &mut runner,
                    &mut ladder,
                    &mut town,
                    body,
                    order_id(orders),
                    g.node,
                    g.at,
                ) {
                    Ok(()) => break 'start,
                    Err(e) => {
                        *refused_at
                            .entry(format!("{} (a start): {}", piece_of(&town, &body), e.name))
                            .or_default() += 1;
                        if tries >= 5 {
                            restarts += 1;
                            continue 'start;
                        }
                        tries += 1;
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
    town.spent.set(Spent::default());
    println!(
        "walkers: {n} placed; {pockets} starts in a pocket and {restarts} with no route out drawn again"
    );
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
        let mut stack = vec![town.tree.root()];
        while let Some(h) = stack.pop() {
            let nd = town.tree.node(h).expect("live");
            let kind = plain(nd.kind().as_str()).to_owned();
            if kind == ROOM {
                let floor = nd.parent().map_or(0, |f| level_of(&town, f));
                if let Ok(x) = xform_to(&town.tree, h, gh) {
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
            stack.extend(town.tree.children(h).expect("live").iter().copied());
        }
        let mut floors: Vec<i64> = node_list.iter().map(|&s| level_of(&town, s)).collect();
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
                    if s == ground { "open ground".to_owned() } else { format!("floor {}", level_of(&town, s)) },
                    level_of(&town, s)
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
        writeln!(c, "tick,total_us,{},walking", NAMES.join("_us,") + "_us").unwrap();
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
    let mut phase_us: Vec<[i64; 3]> = Vec::with_capacity(ticks as usize);
    let mut route_us: Vec<i64> = Vec::new();
    let (mut finished, mut ended) = (0u64, 0u64);
    let mut ended_names: BTreeMap<String, u64> = BTreeMap::new();
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
    // Past the bar: each order logged once, by state; the first lines printed.
    let mut over: BTreeMap<String, u64> = BTreeMap::new();
    let mut over_shown = 0;
    let mut faults = 0u64;
    let mut fault_shown = 0;
    let mut fault_kinds: BTreeMap<String, u64> = BTreeMap::new();
    let mut fault_at: BTreeMap<String, u64> = BTreeMap::new();
    let mut faulted: std::collections::BTreeSet<Id> = std::collections::BTreeSet::new();
    while ticker.next_tick() < ticks {
        let mut body = |_: i64, start: Micros| {
            let at = start + TICK;
            let s0 = town.spent.get();
            let a0 = Instant::now();
            // Orders due this tick: the next walk of each walker that waited, and the crowd moments.
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
                // Carried across a link or walked out by the world: the new order waits for it to stand.
                if runner.controller.carried(who)
                    || runner
                        .fields
                        .get(&who)
                        .is_some_and(|f| f.contains_key(&F_HELD))
                {
                    continue;
                }
                runner.end_order(who);
                let b = *runner.controller.body(who).expect("a walker");
                let mut placed = false;
                for _ in 0..5 {
                    let gi = if plans[k].meet {
                        near_meet[seed.below(near_meet.len())]
                    } else {
                        draw(&mut seed)
                    };
                    let g = &places[gi];
                    orders += 1;
                    match give(
                        &mut runner,
                        &mut ladder,
                        &mut town,
                        b,
                        order_id(orders),
                        g.node,
                        g.at,
                    ) {
                        Ok(()) => {
                            placed = true;
                            break;
                        }
                        Err(e) => {
                            refused_orders += 1;
                            *refused_at
                                .entry(format!("{}: {}", piece_of(&town, &b), e.name))
                                .or_default() += 1;
                        }
                    }
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
                    best: i64::MAX,
                    progress: at,
                    live: true,
                    ..Plan::default()
                };
            }
            let orders_ns = a0.elapsed().as_nanos() as i64;
            let carried: std::collections::BTreeSet<Id> = runner
                .controller
                .bodies()
                .filter(|b| runner.controller.carried(b.id))
                .map(|b| b.id)
                .collect();
            // The first refusal is in `runner.refused` with the rest: each is one walker's fault, taken below.
            let s1 = town.spent.get();
            let b0 = Instant::now();
            let _ = ladder.step(&mut runner, &mut town);
            let step_ns = b0.elapsed().as_nanos() as i64;
            let s2 = town.spent.get();
            tick_us.push((orders_ns + step_ns) / 1000);
            phase_us.push(
                [
                    orders_ns - (s1.corner_ns - s0.corner_ns) as i64,
                    (s2.corner_ns - s0.corner_ns) as i64,
                    (step_ns - (s2.corner_ns - s1.corner_ns) as i64).max(0),
                ]
                .map(|v| v / 1000),
            );

            // Not timed: faults, rungs, arrivals, progress, the record and the trace.
            let refused = std::mem::take(&mut runner.refused);
            for (who, e) in &refused {
                faults += 1;
                let call = if carried.contains(who) {
                    "carry"
                } else {
                    "step"
                };
                *fault_kinds
                    .entry(format!("{call}: {}", e.name))
                    .or_default() += 1;
                let link = ladder
                    .leg(*who)
                    .and_then(|(_, l)| l.link)
                    .map_or("no link".to_owned(), show);
                let b = runner.controller.body(*who).copied();
                *fault_at
                    .entry(format!(
                        "{call}: {} at {link} from {}",
                        e.name,
                        b.map_or("?".to_owned(), |b| piece_of(&town, &b))
                    ))
                    .or_default() += 1;
                faulted.insert(*who);
                if fault_shown < 5 {
                    fault_shown += 1;
                    println!(
                        "walkers: fault at {} ms: walker {}: {call}: {}: {}",
                        at / 1000,
                        index[who],
                        e.name,
                        e.detail
                    );
                }
                runner.end(*who, named("engine-fault"));
            }
            for r in &ladder.log[log_seen..] {
                *rungs.entry(r.rung.name()).or_default() += 1;
            }
            log_seen = ladder.log.len();
            let mut walking = 0;
            for k in 0..n {
                let p = &mut plans[k];
                if !p.live {
                    continue;
                }
                let who = walker_id(k as u64);
                let held = runner
                    .fields
                    .get(&who)
                    .is_some_and(|f| f.contains_key(&F_HELD));
                if !runner.running(who) {
                    p.live = false;
                    match runner.ended.get(&who) {
                        Some((_, Progress::Done)) => {
                            finished += 1;
                            route_us.push(at - p.since);
                        }
                        other => {
                            ended += 1;
                            let name = match other {
                                Some((_, Progress::Failed(nm))) => nm.as_str().to_owned(),
                                _ => "?".to_owned(),
                            };
                            *ended_names.entry(name).or_default() += 1;
                        }
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
                let b = *runner.controller.body(who).expect("a walker");
                let Some((li, leg)) = ladder.leg(who) else {
                    continue;
                };
                let gap = dist(xz(b.pose.position), xz(leg.to));
                if p.best == i64::MAX {
                    (p.leg, p.to, p.best) = (li, leg.to, gap);
                } else if (li, leg.to) != (p.leg, p.to) {
                    if li > p.leg {
                        p.progress = at;
                    }
                    (p.leg, p.to, p.best) = (li, leg.to, gap);
                } else if gap + NEARER <= p.best {
                    p.best = gap;
                    p.progress = at;
                }
                let still = at - p.progress;
                if still > worst.0 {
                    worst = (still, k);
                }
                if still >= BAR && !p.logged {
                    p.logged = true;
                    let state = if let Some(l) = runner.controller.carrying(who) {
                        format!("crossing {}", show(l))
                    } else if runner.controller.carried(who) || held {
                        "walking out".to_owned()
                    } else if let Some((l, g)) = waiting(runner.fields.get(&who)) {
                        format!("waiting for {} at {} mm", show(l), g / 1000)
                    } else {
                        "walking".to_owned()
                    };
                    *over
                        .entry(state.split(' ').next().unwrap_or("").to_owned())
                        .or_default() += 1;
                    if over_shown < 25 {
                        over_shown += 1;
                        let v = b.linear;
                        println!(
                            "walkers: past 30 s at {} ms: walker {k}: {state}; on {}; leg {li} ({}) end {} mm away; speed {} mm/s",
                            at / 1000,
                            piece_of(&town, &b),
                            leg.link.map_or("arrive".to_owned(), show),
                            gap / 1000,
                            dist([v.x, v.z], [0, 0]) / 1000
                        );
                    }
                }
            }
            if let Some((f, c)) = trace.as_mut() {
                for x in runner.controller.bodies() {
                    let k = index[&x.id];
                    let node = node_of(x);
                    let q = frames
                        .get(&node)
                        .and_then(|fr| fr.point(x.pose.position).ok())
                        .unwrap_or(x.pose.position);
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
                    "{},{},{},{},{},{walking}",
                    tick_us.len() - 1,
                    tick_us.last().unwrap(),
                    ph[0],
                    ph[1],
                    ph[2],
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
        "walkers: orders {orders} ({refused_orders} refused routes), trips finished {finished}, ended by name {ended} {ended_names:?}; route time median {} ms, p90 {} ms, max {} ms",
        rm / 1000,
        r90 / 1000,
        rmax / 1000
    );
    println!(
        "walkers: longest without progress under a live order {} ms (walker {}); orders past 30 s by state {over:?}; rungs {rungs:?}",
        worst.0 / 1000,
        worst.1,
    );
    println!(
        "walkers: walker faults {faults} on {} walkers (each order ended by name): {fault_kinds:?}",
        faulted.len(),
    );
    for l in top(&fault_at, 12) {
        println!("walkers: fault at: {l}");
    }
    for l in top(&refused_at, 12) {
        println!("walkers: refused route from: {l}");
    }
    if arm == "event" {
        println!("walkers: crowd moments {moments}, reactions {reacted}");
    }
    let bar = |ok: bool| if ok { "pass" } else { "miss" };
    println!(
        "walkers: bars: median <= 5 ms {}; p99 <= 15 ms {}; no walker without progress for 30 s {}; walker faults 0 {}",
        bar(med <= 5_000),
        bar(p99 <= 15_000),
        bar(worst.0 < BAR),
        bar(faults == 0)
    );
}
