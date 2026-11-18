//! The `fallbacks` bench (Engine v2 I5, #2690): ranked fallbacks for a crowd after the same seats. Declared on #2690.
//!
//! **The crowd** (A1, A2, A4). The test world's hall (its constants), the three rows nearest the door: 60 chairs, each
//! the fixture chair's seat. 120 scripted Souls come in at the door (x spread over 6 m) at seeded times over 30 s.
//! Each decides on the hall as it was when it came in and its send reaches the world a thinking delay later (1 s or
//! 8 s), so it decides on a copy that old. It names the nearest chair free on its copy; with fallbacks the list
//! ends with the selector "any free chair in this hall, nearest to the body, ties by id" (`replica::selector`). A Soul
//! whose copy shows no free chair sends the selector alone, in both arms. World time is simulated in 50 ms ticks: a
//! send that arrives in tick k is resolved by a checker on the copy published at the end of tick k and bound at tick
//! k + 1 (a re-check one tick later), in B3's stable order, body id, never arrival (each tick's arrival order is
//! logged). A bound chair is taken by B3's `Slots::commit` and the sit move runs to its end. The walk to the chair is
//! not part of this measure: every body is in reach of every chair.
//!
//! Reported per arm and repeat (the seed differs by repeat): each Soul's first-send end by cause, chairs taken, chairs
//! held twice, sits done.
//!
//! **The clock** (A5). The whole hall, 300 chairs; 600 bodies at seeded points in it each send the selector alone. Four
//! checker threads resolve on the copy of the holds the clock thread publishes each 50 ms tick; the clock thread
//! (marked, `sim::commit::off_clock`) only binds and takes the chair. Arms, two repeats each: even, 100 sends a second
//! for 6 s; burst, 600 sends at once. A selector whose few were all taken since its check is resolved again at
//! commit from the free chairs' index (`sim::commit::bind::FreeIndex`, I5b #3178), not sent back. Reported: each
//! send's end by cause, the clock's time per bound act (bind, the index when used, and take), mean and 99th
//! percentile, against I3's bar of 0.05 ms, the most index cells one act visited, and rule checks on the clock
//! thread (must be 0).
//!
//! Run from `v2/`: `cargo run -p bench --release --bin fallbacks`.
// A bench times a run by the wall clock (the wall-clock rule, K7, is the engine's).
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use body_script::{TICK, humanoid};
use replica::effects::fixture_bytes;
use replica::encode::{Name, decode};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move, Seat};
use replica::pose::{Frame, Quat, Support, Vec3};
use replica::selector::{Rule, Selector};
use sim::commit::bind::{Bound, FreeIndex, Slot, bind};
use sim::commit::{checks_on_clock, mark_clock_thread};
use sim::controller::{Controller, Stance};
use sim::ground::Piece;
use sim::mover::Surface;
use sim::moves::{Moves, Reach, load};
use sim::slots::{Request, SeatAt, Slots};
use sim::timers::DueList;
use testworld::{
    BACK_ROW_Z, CENTRE_AISLE, HALL_DEPTH, HALL_ROWS, HALL_WIDTH, ROW_PITCH, SEAT_PITCH,
    SEATS_PER_ROW,
};
use worldd::checkers::seats::{SeatRow, SeatsSeen, Wanted, resolve};

const SOULS: usize = 120;
const ARRIVALS_US: i64 = 30_000_000;
/// The door, mm: in front of the front row, x spread over 6 m.
const DOOR_Z: i64 = 9_000;
const DOOR_HALF_WIDTH: i64 = 3_000;

fn floor_id() -> Id {
    replica::pose::fixture(1)
}

fn floor() -> Surface {
    let mm = |v: i64| i32::try_from(v).expect("a hall in i32 mm");
    let (x, z) = (mm(HALL_WIDTH / 2), mm(HALL_DEPTH / 2));
    let corners = vec![[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]];
    Surface::new(
        floor_id(),
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
        }],
    )
}

/// Every body is in reach of every chair: the walk there is not measured here.
struct InReach;

impl Reach for InReach {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, _: Id, _: &Name) -> Option<i64> {
        Some(0)
    }
}

/// splitmix64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: i64) -> i64 {
        (self.next() % n as u64) as i64
    }
}

struct Hall {
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    slots: Slots,
    floors: BTreeMap<Id, Surface>,
    chairs: Vec<Id>,
    rows: Arc<Vec<SeatRow>>,
    at: BTreeMap<Id, Vec3>,
    /// The free chairs, as the clock thread resolves a burst from them at commit (I5b, #3178).
    index: FreeIndex,
}

fn chair_kind() -> Name {
    Name::new("eden:chair").expect("a name")
}

/// The hall's chairs in rows `rows`, and a body at each of `points`.
fn hall(seat: &Seat, rows: std::ops::Range<i64>, points: &[Vec3]) -> Hall {
    let floors = BTreeMap::from([(floor_id(), floor())]);
    let mut mint = Minter::new(Scope([0xb5; 16]));
    let mut slots = Slots::new();
    let mut chairs = Vec::new();
    let mut table = Vec::new();
    let mut index = FreeIndex::new();
    for r in rows {
        for k in 0..SEATS_PER_ROW {
            let x = CENTRE_AISLE / 2 + SEAT_PITCH / 2 + k % (SEATS_PER_ROW / 2) * SEAT_PITCH;
            let x = if k < SEATS_PER_ROW / 2 { -x } else { x };
            let thing = mint.mint().expect("an id");
            let point = Vec3::new(x * 1000, seat.height, (BACK_ROW_Z + r * ROW_PITCH) * 1000);
            slots
                .add(SeatAt {
                    thing,
                    seat: seat.clone(),
                    point,
                    facing: Quat::IDENTITY,
                    floor: floor_id(),
                })
                .expect("a seat");
            chairs.push(thing);
            index.add(thing, floor_id(), chair_kind(), point);
            table.push(SeatRow {
                thing,
                room: floor_id(),
                kind: chair_kind(),
                point,
            });
        }
    }
    let mut c = Controller::new();
    let frame = Frame {
        node: floor_id(),
        slot: None,
    };
    let mut at = BTreeMap::new();
    for p in points {
        let id = mint.mint().expect("an id");
        let placed = floors[&floor_id()]
            .place(id, frame, *p, Quat::IDENTITY)
            .expect("placed");
        c.add(humanoid(), placed).expect("added");
        at.insert(id, *p);
    }
    Hall {
        c,
        due: DueList::new(),
        mint,
        moves: Moves::new(),
        slots,
        floors,
        chairs,
        rows: Arc::new(table),
        at,
        index,
    }
}

impl Hall {
    fn held(&self) -> BTreeSet<Id> {
        self.chairs
            .iter()
            .copied()
            .filter(|t| self.slots.holder(*t).is_some())
            .collect()
    }

    /// Binds one act's list and, if a chair is bound, takes it by B3's commit. The end's name and the chair.
    fn bind_and_take(
        &mut self,
        body: Id,
        list: &[Slot],
        version: u64,
        rechecked: bool,
        sit: &Move,
        now: i64,
    ) -> Bound {
        let slots = &self.slots;
        let b = bind(list, |t| slots.holder(t).is_none(), version, rechecked);
        if let Bound::Slot { thing, .. } = b {
            let req = Request {
                body,
                thing,
                mv: sit,
                stance: Stance::Sit,
            };
            let w = &mut *self;
            let done = w.slots.commit(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &mut w.moves,
                &InReach,
                &[req],
                now,
            );
            if let Some((_, Err(r))) = done.first() {
                return Bound::Ended(r.name);
            }
            self.index.take(thing);
        }
        b
    }

    /// A selector whose few were all taken since its check, resolved again at commit from the free chairs' index and
    /// bound (I5b, #3178): the end and the cells the index visited.
    fn at_commit(&mut self, body: Id, any: &Selector, sit: &Move, now: i64) -> (Bound, usize) {
        let (slot, visited) = self.index.resolve(any, self.at[&body]);
        (
            self.bind_and_take(body, &[slot], 0, true, sit, now),
            visited,
        )
    }

    fn step(&mut self, now: i64) {
        let _ = self.c.step(&self.floors, TICK, now);
        while let Some(t) = self.due.fire(now + TICK) {
            let w = &mut *self;
            let _ = w.slots.fire(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &mut w.moves,
                &InReach,
                &w.floors,
                &t,
            );
        }
    }
}

fn hall_seat() -> (Seat, Move) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/replica/fixtures");
    let sit = load(&dir.join("moves"))
        .expect("the fixture moves")
        .into_iter()
        .find(|m| m.name.as_str() == "souls:sit")
        .expect("the sit move");
    let text = std::fs::read_to_string(dir.join("seats/chair.diag")).expect("the chair");
    let seat = Seat::from_value(
        &decode(&fixture_bytes(&text).expect("bytes"))
            .expect("decodes")
            .value,
    )
    .expect("a seat");
    (seat, sit)
}

fn any_chair(rule: Rule) -> Selector {
    Selector::FreeSlot {
        kind: chair_kind(),
        node: floor_id(),
        rule,
    }
}

fn name(b: &Bound) -> String {
    match b {
        Bound::Slot { .. } => "seated".into(),
        Bound::Ended(n) => (*n).into(),
        Bound::Recheck { .. } => "recheck".into(),
    }
}

struct Crowd {
    causes: BTreeMap<String, usize>,
    by_selector: usize,
    taken: usize,
    twice: usize,
    sits_done: usize,
    rechecks: usize,
    contested_ticks: usize,
    arrival_not_bind_order: usize,
}

/// One arm of the crowd: thinking delay `delay` µs, with or without the selector as the last candidate.
fn crowd(seat: &Seat, sit: &Move, delay: i64, fallbacks: bool, seed: u64) -> Crowd {
    let mut rng = Rng(seed);
    let points: Vec<Vec3> = (0..SOULS)
        .map(|_| {
            let x = rng.below(2 * DOOR_HALF_WIDTH) - DOOR_HALF_WIDTH;
            Vec3::new(x * 1000, 0, DOOR_Z * 1000)
        })
        .collect();
    let mut h = hall(seat, HALL_ROWS - 3..HALL_ROWS, &points);
    let bodies: Vec<Id> = h.at.keys().copied().collect();
    let mut came: Vec<(i64, Id)> = bodies
        .iter()
        .map(|&b| (rng.below(ARRIVALS_US), b))
        .collect();
    came.sort();
    let any = Wanted::Select(any_chair(Rule::Nearest));
    // The copy at the end of each tick: tick k's is `copies[k + 1]` (`copies[0]`, the hall before any tick).
    let mut copies: Vec<Arc<BTreeSet<Id>>> = vec![Arc::new(BTreeSet::new())];
    // Sends in world time: (arrives, body, list as written).
    let mut sends: Vec<(i64, Id, Vec<Wanted>)> = Vec::new();
    let mut next = 0;
    let mut ready: Vec<Waiting> = Vec::new();
    let mut out = Crowd {
        causes: BTreeMap::new(),
        by_selector: 0,
        taken: 0,
        twice: 0,
        sits_done: 0,
        rechecks: 0,
        contested_ticks: 0,
        arrival_not_bind_order: 0,
    };
    let mut ended = 0;
    let mut arrivals = 0;
    let mut k: i64 = 0;
    while ended < SOULS || !h.moves.is_empty() {
        let now = k * TICK;
        // Souls coming in now decide on the copy of now; their send arrives `delay` later.
        while next < came.len() && came[next].0 < now + TICK {
            let (t, b) = came[next];
            let seen = &copies[usize::try_from(t / TICK).expect("a tick")];
            let me = h.at[&b];
            let free = h.rows.iter().filter(|r| !seen.contains(&r.thing));
            let nearest =
                replica::selector::best(Rule::Nearest, me, free.map(|r| (r.thing, r.point)), 1);
            let list = match (nearest.first(), fallbacks) {
                (Some(&t), true) => vec![Wanted::Named(t), any.clone()],
                (Some(&t), false) => vec![Wanted::Named(t)],
                (None, _) => vec![any.clone()],
            };
            sends.push((t + delay, b, list));
            next += 1;
        }
        // Commit what was resolved for this tick, in B3's stable order; log arrival order against it.
        let mut due: Vec<_> = ready.extract_if(.., |r| r.0 == k).collect();
        if due.len() > 1 {
            out.contested_ticks += 1;
            let arrived: Vec<usize> = due.iter().map(|r| r.1).collect();
            due.sort_by_key(|r| r.2);
            if due.iter().map(|r| r.1).collect::<Vec<_>>() != arrived {
                out.arrival_not_bind_order += 1;
            }
        }
        let version = u64::try_from(k).expect("a tick");
        for (_, idx, body, wanted, list, _, rechecked) in due {
            match h.bind_and_take(body, &list, version, rechecked, sit, now) {
                Bound::Recheck { .. } => {
                    out.rechecks += 1;
                    ready.push((k + 1, idx, body, wanted, Vec::new(), version, true));
                }
                b => {
                    if let Bound::Slot { rank, .. } = b
                        && matches!(wanted.get(rank), Some(Wanted::Select(_)))
                    {
                        out.by_selector += 1;
                    }
                    *out.causes.entry(name(&b)).or_default() += 1;
                    ended += 1;
                }
            }
        }
        h.step(now);
        copies.push(Arc::new(h.held()));
        // Sends that arrived in this tick, and re-checks, are resolved on the copy at its end and bound at the next.
        let copy = SeatsSeen {
            version: version + 1,
            seats: Arc::clone(&h.rows),
            held: Arc::clone(&copies[copies.len() - 1]),
        };
        for r in ready.iter_mut().filter(|r| r.4.is_empty()) {
            r.4 = resolve(&copy, h.at[&r.2], &r.3);
        }
        for (_, b, wanted) in sends.extract_if(.., |s| s.0 < now + TICK) {
            let list = resolve(&copy, h.at[&b], &wanted);
            ready.push((k + 1, arrivals, b, wanted, list, version, false));
            arrivals += 1;
        }
        k += 1;
    }
    out.taken = h.slots.len();
    let mut holders = BTreeSet::new();
    for &ch in &h.chairs {
        if let Some(b) = h.slots.holder(ch)
            && !holders.insert(b)
        {
            out.twice += 1;
        }
    }
    out.sits_done =
        h.at.keys()
            .filter(|b| {
                h.c.body(**b)
                    .is_some_and(|s| s.pose.support == Support::Slot)
            })
            .count();
    out
}

/// An act resolved and waiting for its commit tick: (tick, arrival index, body, list as written, list resolved,
/// version, re-checked).
type Waiting = (i64, usize, Id, Vec<Wanted>, Vec<Slot>, u64, bool);

type Job = (usize, Id, bool, u64);

/// What the clock arm measured.
struct Clocked {
    mean: f64,
    p99: f64,
    causes: BTreeMap<String, usize>,
    at_commit: usize,
    most_cells: usize,
    on_clock: u64,
}

/// The clock arm: 600 sends of the selector alone in the 300-chair hall; `even` sends 100 a second, else all at once.
/// A selector whose few were all taken since its check is resolved again at commit from the index (I5b, #3178).
fn clock(seat: &Seat, sit: &Move, even: bool, seed: u64) -> Clocked {
    const N: usize = 600;
    const CHECKERS: usize = 4;
    let mut rng = Rng(seed);
    let points: Vec<Vec3> = (0..N)
        .map(|_| {
            let x = rng.below(HALL_WIDTH - 2_000) - (HALL_WIDTH - 2_000) / 2;
            let z = rng.below(HALL_DEPTH - 2_000) - (HALL_DEPTH - 2_000) / 2;
            Vec3::new(x * 1000, 0, z * 1000)
        })
        .collect();
    let mut h = hall(seat, 0..HALL_ROWS, &points);
    let bodies: Vec<Id> = h.at.keys().copied().collect();
    let at = Arc::new(h.at.clone());
    let want = Arc::new(vec![Wanted::Select(any_chair(Rule::Nearest))]);
    let copy = Arc::new(RwLock::new(SeatsSeen {
        version: 0,
        seats: Arc::clone(&h.rows),
        held: Arc::new(BTreeSet::new()),
    }));
    let (jobs, rx): (Sender<Job>, Receiver<Job>) = channel();
    let rx = Arc::new(Mutex::new(rx));
    let (done_tx, done) = channel::<(Job, Vec<Slot>)>();
    for _ in 0..CHECKERS {
        let (rx, done_tx, copy, at, want) = (
            Arc::clone(&rx),
            done_tx.clone(),
            Arc::clone(&copy),
            Arc::clone(&at),
            Arc::clone(&want),
        );
        thread::spawn(move || {
            loop {
                let Ok(job) = rx.lock().expect("the queue").recv() else {
                    break;
                };
                let seen = loop {
                    let c = copy.read().expect("the copy").clone();
                    if c.version >= job.3 {
                        break c;
                    }
                    thread::sleep(Duration::from_millis(1));
                };
                let list = resolve(&seen, at[&job.1], &want);
                if done_tx.send((job, list)).is_err() {
                    break;
                }
            }
        });
    }
    let feeder = {
        let jobs = jobs.clone();
        let bodies = bodies.clone();
        thread::spawn(move || {
            for (i, b) in bodies.into_iter().enumerate() {
                if even {
                    thread::sleep(Duration::from_millis(10));
                }
                jobs.send((i, b, false, 0)).expect("a checker");
            }
        })
    };
    mark_clock_thread();
    let tick = Duration::from_micros(u64::try_from(TICK).expect("a tick"));
    let mut deadline = Instant::now() + tick;
    let any = any_chair(Rule::Nearest);
    let (mut spent, mut ended, mut at_commit, mut most_cells) = (Vec::new(), 0, 0, 0);
    let mut causes: BTreeMap<String, usize> = BTreeMap::new();
    let mut k: u64 = 0;
    while ended < N {
        let n = Instant::now();
        if n < deadline {
            thread::sleep(deadline - n);
        }
        let now = i64::try_from(k).expect("a tick") * TICK;
        for (job, list) in done.try_iter() {
            let t = Instant::now();
            let mut b = h.bind_and_take(job.1, &list, k, job.2, sit, now);
            if let Bound::Recheck { .. } = b {
                let (again, cells) = h.at_commit(job.1, &any, sit, now);
                b = again;
                at_commit += 1;
                most_cells = most_cells.max(cells);
            }
            spent.push(t.elapsed());
            *causes.entry(name(&b)).or_default() += 1;
            ended += 1;
        }
        h.step(now);
        k += 1;
        *copy.write().expect("the copy") = SeatsSeen {
            version: k,
            seats: Arc::clone(&h.rows),
            held: Arc::new(h.held()),
        };
        deadline += tick;
    }
    feeder.join().expect("the feeder");
    drop(jobs);
    spent.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    let mean = spent.iter().map(|d| ms(*d)).sum::<f64>() / spent.len() as f64;
    let p99 = ms(spent[(spent.len() * 99 / 100).min(spent.len() - 1)]);
    Clocked {
        mean,
        p99,
        causes,
        at_commit,
        most_cells,
        on_clock: checks_on_clock(),
    }
}

fn main() {
    let (seat, sit) = hall_seat();
    println!(
        "crowd: {SOULS} Souls, 60 chairs (rows {}..{} of the test hall), arrivals over {} s, tick {} ms",
        HALL_ROWS - 3,
        HALL_ROWS,
        ARRIVALS_US / 1_000_000,
        TICK / 1000
    );
    println!(
        "| delay | fallbacks | repeat | seated (by selector) | seat.none-free | seat-taken | stale | named end | \
         chairs taken | held twice | sits done | re-checks | ticks with 2+ binds (arrival != bind order) |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for delay in [1_000_000, 8_000_000] {
        for fallbacks in [true, false] {
            for repeat in 1..=2u64 {
                let c = crowd(&seat, &sit, delay, fallbacks, 0x1_5eed + repeat);
                let get = |n: &str| c.causes.get(n).copied().unwrap_or(0);
                let named = get("seated") + get("seat.none-free");
                let others: usize = c
                    .causes
                    .iter()
                    .filter(|(n, _)| {
                        !["seated", "seat.none-free", "seat-taken", "stale"].contains(&n.as_str())
                    })
                    .map(|(_, v)| v)
                    .sum();
                assert_eq!(others, 0, "an unexpected end: {:?}", c.causes);
                println!(
                    "| {} s | {} | {repeat} | {} ({}) | {} | {} | {} | {:.1} % | {} | {} | {} | {} | {} ({}) |",
                    delay / 1_000_000,
                    if fallbacks { "with" } else { "without" },
                    get("seated"),
                    c.by_selector,
                    get("seat.none-free"),
                    get("seat-taken"),
                    get("stale"),
                    100.0 * named as f64 / SOULS as f64,
                    c.taken,
                    c.twice,
                    c.sits_done,
                    c.rechecks,
                    c.contested_ticks,
                    c.arrival_not_bind_order,
                );
            }
        }
    }
    println!(
        "clock: 300 chairs, 600 sends of the selector alone, 4 checker threads; bar 0.05 ms at p99"
    );
    println!(
        "| arm | repeat | mean ms | p99 ms | seated | seat.none-free | stale | other | resolved at commit | \
         most cells visited | rule checks on the clock |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|");
    for (arm, even) in [("even 100/s", true), ("burst 600", false)] {
        for repeat in 1..=2u64 {
            let c = clock(&seat, &sit, even, 0xc10c + repeat);
            let get = |n: &str| c.causes.get(n).copied().unwrap_or(0);
            let other = c.causes.values().sum::<usize>()
                - get("seated")
                - get("seat.none-free")
                - get("stale");
            println!(
                "| {arm} | {repeat} | {:.4} | {:.4} | {} | {} | {} | {other} | {} | {} | {} | {}",
                c.mean,
                c.p99,
                get("seated"),
                get("seat.none-free"),
                get("stale"),
                c.at_commit,
                c.most_cells,
                c.on_clock,
                if c.p99 <= 0.05 { "met" } else { "UNMET" }
            );
        }
    }
}
