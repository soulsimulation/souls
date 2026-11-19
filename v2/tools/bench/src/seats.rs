//! The `seats` bench (Engine v2 B3, #2682), on the test world's hall: 300 chairs in 15 rows of 20 (its constants), each
//! the fixture chair's seat (`replica/fixtures/seats/chair.diag`), on a flat 30 m by 40 m floor. Declared on #2682.
//!
//! - **A1.** Arm `empty`, the hall with no bodies, against arm `seated`, 300 bodies seated by the sit move with every
//!   move ended. Each times 200,000 ticks of 50 ms (the controller's step and the due list), two repeats. The bar,
//!   set before the run: the difference of the means is at most the larger of the two arms' spreads.
//! - **A2.** 600 bodies, two by each chair, ask for a seat in one tick, in three arrival orders: ids ascending, ids
//!   descending, a seeded shuffle. Seated, refused, refusals naming the holder, and seats with two.
//! - **A3.** The 300 seated rise in one tick, are set on their stand points, and each walks at 1.2 m/s to the nearest
//!   spot 560 mm (two bodies' radii) from every spot chosen before it, in id order. The longest step of a tick, the
//!   closest two at the end, and the seats still held.
//!
//! Run from `v2/`: `cargo run -p bench --release --bin seats`.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::hint::black_box;
use std::path::Path;
use std::time::Instant;

use body_script::{TICK, humanoid, script_shape};
use replica::effects::{Refusal, fixture_bytes};
use replica::encode::{Name, decode};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move, Place};
use replica::pose::{Frame, Quat, Support, Vec3};
use replica::world_model::show;
use sim::controller::{Controller, Part, Stance};
use sim::ground::{HUMAN_RADIUS, Piece};
use sim::mover::Surface;
use sim::moves::{Moves, Reach, load};
use sim::slots::{PlaceAt, Request, Slots, clear_spot};
use sim::timers::DueList;
use testworld::{
    BACK_ROW_Z, CENTRE_AISLE, HALL_DEPTH, HALL_ROWS, HALL_WIDTH, ROW_PITCH, SEAT_PITCH,
    SEATS_PER_ROW,
};

const TIMED: i64 = 200_000;
/// µm a second.
const WALK: i64 = 1_200_000;

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

/// Each body's point (its feet, or its seat's point while it is in one) and each chair's seat and stand point, µm.
struct Geo(BTreeMap<Id, Vec3>, BTreeMap<Id, [Vec3; 2]>);

impl Reach for Geo {
    fn distance(
        &self,
        body: Id,
        _: &Effector,
        _: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64> {
        let a = self.0.get(&body)?;
        let [place, stand] = self.1.get(&target)?;
        let b = match point.as_str() {
            "souls:slot" => place,
            "souls:stand" => stand,
            _ => return None,
        };
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        i64::try_from((d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt()).ok()
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
    bodies: Vec<Id>,
    tick: i64,
}

/// The hall's 300 chairs, and `per` bodies by each chair's stand point (100 mm apart in x when there are two).
fn hall(place: &Place, per: usize) -> Hall {
    let floors = BTreeMap::from([(floor_id(), floor())]);
    let mut mint = Minter::new(Scope([0xb3; 16]));
    let mut slots = Slots::new();
    let mut chairs = Vec::new();
    for r in 0..HALL_ROWS {
        for k in 0..SEATS_PER_ROW {
            let x = CENTRE_AISLE / 2 + SEAT_PITCH / 2 + k % (SEATS_PER_ROW / 2) * SEAT_PITCH;
            let x = if k < SEATS_PER_ROW / 2 { -x } else { x };
            let thing = mint.mint().expect("an id");
            let point = Vec3::new(x * 1000, place.height, (BACK_ROW_Z + r * ROW_PITCH) * 1000);
            slots
                .add(PlaceAt {
                    thing,
                    place: place.clone(),
                    point,
                    facing: Quat::IDENTITY,
                    floor: floor_id(),
                })
                .expect("a place");
            chairs.push(thing);
        }
    }
    let mut c = Controller::new();
    let mut bodies = Vec::new();
    let frame = Frame {
        node: floor_id(),
        slot: None,
    };
    for &chair in &chairs {
        let stand = slots
            .place(chair)
            .expect("a chair")
            .stand()
            .expect("a stand point");
        for i in 0..per {
            let dx = if per == 1 { 0 } else { [-50_000, 50_000][i] };
            let id = mint.mint().expect("an id");
            let at = Vec3::new(stand.x + dx, 0, stand.z);
            let placed = floors[&floor_id()]
                .place(id, frame, at, Quat::IDENTITY)
                .expect("placed");
            c.add(humanoid(), placed).expect("added");
            bodies.push(id);
        }
    }
    Hall {
        c,
        due: DueList::new(),
        mint,
        moves: Moves::new(),
        slots,
        floors,
        chairs,
        bodies,
        tick: 0,
    }
}

impl Hall {
    fn geo(&self) -> Geo {
        let mut points = BTreeMap::new();
        for &ch in &self.chairs {
            let at = self.slots.place(ch).expect("a chair");
            points.insert(ch, [at.point, at.stand().expect("a stand point")]);
        }
        let bodies = self
            .bodies
            .iter()
            .map(|&b| {
                let p = self.c.body(b).expect("a body").pose;
                let at = if p.support == Support::Slot {
                    points[&p.frame.node][0]
                } else {
                    p.position
                };
                (b, at)
            })
            .collect();
        Geo(bodies, points)
    }

    /// One tick: the controller steps every body, then every timer due before the next tick fires.
    fn step(&mut self, geo: &Geo) -> usize {
        let at = self.tick * TICK;
        black_box(self.c.step(&self.floors, TICK, at));
        let mut fired = 0;
        while let Some(t) = self.due.fire(at + TICK) {
            let w = &mut *self;
            black_box(w.slots.fire(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &mut w.moves,
                geo,
                &w.floors,
                &t,
            ));
            fired += 1;
        }
        self.tick += 1;
        fired
    }

    /// Ticks, with the world's geometry taken afresh each tick, until no move is in progress.
    fn settle(&mut self) {
        while !self.moves.is_empty() {
            let geo = self.geo();
            self.step(&geo);
        }
        let geo = self.geo();
        self.step(&geo);
    }

    fn sit(&mut self, order: &[Id], sit: &Move) -> Vec<(Id, Result<u64, Refusal>)> {
        let geo = self.geo();
        let chair_of: BTreeMap<Id, Id> = self
            .bodies
            .iter()
            .enumerate()
            .map(|(i, &b)| (b, self.chairs[i * self.chairs.len() / self.bodies.len()]))
            .collect();
        let reqs: Vec<Request> = order
            .iter()
            .map(|&b| Request {
                body: b,
                thing: chair_of[&b],
                slot: None,
                mv: sit,
                stance: Stance::Sit,
            })
            .collect();
        let now = self.tick * TICK;
        let w = &mut *self;
        w.slots.commit(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &geo,
            &reqs,
            now,
        )
    }
}

/// Mean ns a tick over [`TIMED`] ticks.
/// The same number of ticks is run first, untimed, so neither arm is timed cold.
fn timed(h: &mut Hall) -> f64 {
    let geo = h.geo();
    for _ in 0..TIMED {
        h.step(&geo);
    }
    let t = Instant::now();
    for _ in 0..TIMED {
        assert_eq!(h.step(&geo), 0, "nothing fires in a timed tick");
    }
    t.elapsed().as_secs_f64() * 1e9 / TIMED as f64
}

fn seated_hall(place: &Place, sit: &Move) -> Hall {
    let mut h = hall(place, 1);
    let order = h.bodies.clone();
    assert!(h.sit(&order, sit).iter().all(|(_, r)| r.is_ok()));
    h.settle();
    assert_eq!(h.slots.len(), 300);
    assert!(h.due.is_empty() && h.moves.is_empty(), "no timer, no move");
    h
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/replica/fixtures");
    let all = load(&dir.join("moves")).expect("the fixture moves");
    let pick = |n: &str| {
        all.iter()
            .find(|m| m.name.as_str() == n)
            .expect("a fixture move")
            .clone()
    };
    let (sit, rise) = (pick("souls:sit"), pick("souls:rise"));
    let text = std::fs::read_to_string(dir.join("seats/chair.diag")).expect("the chair");
    let place = Place::from_value(
        &decode(&fixture_bytes(&text).expect("bytes"))
            .expect("decodes")
            .value,
    )
    .expect("a place");
    println!(
        "hall: {} chairs, seat {} mm, stand point {:?} mm; sit {} rev {}, rise {} rev {}; tick {TICK} µs",
        HALL_ROWS * SEATS_PER_ROW,
        place.height / 1000,
        place.stand.map(|v| v / 1000),
        sit.name.as_str(),
        sit.revision,
        rise.name.as_str(),
        rise.revision
    );

    // A1.
    let mut rows = Vec::new();
    for repeat in 1..=2 {
        let empty = timed(&mut hall(&place, 0));
        let seated = timed(&mut seated_hall(&place, &sit));
        println!(
            "A1 repeat {repeat}: empty hall {empty:.3} ns a tick, 300 seated {seated:.3} ns a tick"
        );
        rows.push((empty, seated));
    }
    let (se, ss) = ((rows[0].0 - rows[1].0).abs(), (rows[0].1 - rows[1].1).abs());
    let (me, ms) = ((rows[0].0 + rows[1].0) / 2.0, (rows[0].1 + rows[1].1) / 2.0);
    let bar = se.max(ss);
    println!(
        "A1: mean empty {me:.3} ns, mean seated {ms:.3} ns, difference {:.3} ns; spread empty {se:.3} ns, seated \
         {ss:.3} ns; bar (the larger spread) {bar:.3} ns: {}",
        ms - me,
        if (ms - me).abs() <= bar {
            "met"
        } else {
            "UNMET"
        }
    );

    // A2.
    let mut winners: Option<BTreeMap<Id, Id>> = None;
    println!(
        "A2: | order | requests | seated | refused | refusals naming the holder | seats with two |"
    );
    for order_name in ["ids ascending", "ids descending", "seeded shuffle"] {
        let mut h = hall(&place, 2);
        let mut order = h.bodies.clone();
        match order_name {
            "ids descending" => order.reverse(),
            "seeded shuffle" => {
                let mut s: u64 = 0x2682;
                for i in (1..order.len()).rev() {
                    s ^= s << 13;
                    s ^= s >> 7;
                    s ^= s << 17;
                    order.swap(i, (s % (i as u64 + 1)) as usize);
                }
            }
            _ => {}
        }
        let out = h.sit(&order, &sit);
        let ok = out.iter().filter(|(_, r)| r.is_ok()).count();
        let naming = out
            .iter()
            .filter_map(|(_, r)| r.as_ref().err())
            .filter(|r| {
                r.name == "place-taken"
                    && h.chairs.iter().any(|&ch| {
                        h.slots.holder(ch).is_some_and(|w| {
                            r.detail == format!("{}: held by {}", show(ch), show(w))
                        })
                    })
            })
            .count();
        h.settle();
        let mut in_seat: BTreeMap<Id, Vec<Id>> = BTreeMap::new();
        for &b in &h.bodies {
            let p = h.c.body(b).expect("a body").pose;
            if p.support == Support::Slot {
                in_seat.entry(p.frame.node).or_default().push(b);
            }
        }
        let two = in_seat.values().filter(|v| v.len() > 1).count();
        let seated: usize = in_seat.values().map(Vec::len).sum();
        println!(
            "A2: | {order_name} | {} | {seated} | {} | {naming} | {two} |",
            out.len(),
            out.len() - ok
        );
        assert_eq!(
            (ok, seated, out.len() - ok, naming, two),
            (300, 300, 300, 300, 0)
        );
        let w: BTreeMap<Id, Id> = in_seat.into_iter().map(|(ch, v)| (ch, v[0])).collect();
        assert!(
            winners.as_ref().is_none_or(|x| *x == w),
            "the same holders in every order"
        );
        winners = Some(w);
    }
    println!("A2: the same 300 holders in all three orders");

    // A3.
    let mut h = seated_hall(&place, &sit);
    let geo = h.geo();
    let now = h.tick * TICK;
    for &b in &h.bodies.clone() {
        let w = &mut h;
        w.slots
            .rise(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &mut w.moves,
                &geo,
                b,
                &rise,
                now,
            )
            .expect("rising");
    }
    h.settle();
    assert!(h.slots.is_empty(), "every seat released");
    let mut off = 0;
    let mut spots = Vec::new();
    for (i, &b) in h.bodies.iter().enumerate() {
        let p = h.c.body(b).expect("a body").pose;
        let stand = h
            .slots
            .place(h.chairs[i])
            .expect("a chair")
            .stand()
            .expect("a stand point");
        off += usize::from(
            (p.position.x, p.position.z) != (stand.x, stand.z) || p.support == Support::Slot,
        );
        let spot = clear_spot(
            &h.floors[&floor_id()],
            [stand.x, stand.z],
            &spots,
            2 * HUMAN_RADIUS * 1000,
            50_000,
            8_000_000,
        )
        .expect("a clear spot");
        spots.push(spot);
    }
    let moved_off = spots
        .iter()
        .zip(&h.bodies)
        .filter(|(s, b)| {
            let p = h.c.body(**b).expect("a body").pose.position;
            **s != [p.x, p.z]
        })
        .count();
    let drivers: Vec<u64> = h
        .bodies
        .iter()
        .map(|&b| h.c.claim(b, &script_shape()).expect("the legs"))
        .collect();
    let (mut longest, mut ticks) = (0i64, 0);
    loop {
        let mut walking = 0;
        let before: Vec<Vec3> = h
            .bodies
            .iter()
            .map(|&b| h.c.body(b).expect("a body").pose.position)
            .collect();
        for (i, &b) in h.bodies.iter().enumerate() {
            let (dx, dz) = (spots[i][0] - before[i].x, spots[i][1] - before[i].z);
            let len = i64::try_from(
                (i128::from(dx) * i128::from(dx) + i128::from(dz) * i128::from(dz)).isqrt(),
            )
            .expect("a length");
            let v = if len == 0 {
                Vec3::ZERO
            } else if len * 1_000_000 <= WALK * TICK {
                walking += 1;
                Vec3::new(dx * 1_000_000 / TICK, 0, dz * 1_000_000 / TICK)
            } else {
                walking += 1;
                Vec3::new(dx * WALK / len, 0, dz * WALK / len)
            };
            h.c.set(
                b,
                drivers[i],
                Part::Velocity(v, replica::pose::Mode::Surface),
            )
            .expect("velocity");
        }
        if walking == 0 {
            break;
        }
        let geo = h.geo();
        h.step(&geo);
        ticks += 1;
        for (i, &b) in h.bodies.iter().enumerate() {
            let p = h.c.body(b).expect("a body").pose.position;
            let d = (i128::from(p.x - before[i].x).pow(2) + i128::from(p.z - before[i].z).pow(2))
                .isqrt();
            longest = longest.max(i64::try_from(d).expect("a step"));
        }
        assert!(ticks < 2_000, "every body arrives");
    }
    let end: Vec<[i64; 2]> = h
        .bodies
        .iter()
        .map(|&b| {
            let p = h.c.body(b).expect("a body").pose.position;
            [p.x, p.z]
        })
        .collect();
    assert_eq!(end, spots, "each at its spot");
    let mut closest = i128::MAX;
    for i in 0..end.len() {
        for j in i + 1..end.len() {
            closest = closest.min(
                i128::from(end[i][0] - end[j][0]).pow(2) + i128::from(end[i][1] - end[j][1]).pow(2),
            );
        }
    }
    let step_most = WALK * TICK / 1_000_000;
    println!(
        "A3: 300 rose; {} not set on their stand point at contact; seats still held {}; {moved_off} walked off a taken \
         stand point to a clear spot, in {ticks} ticks; longest step in one tick {} mm (walking pace {} mm a tick); \
         closest two at the end {} mm (clear: {} mm)",
        off,
        h.slots.len(),
        longest / 1000,
        step_most / 1000,
        closest.isqrt() / 1000,
        2 * HUMAN_RADIUS
    );
    assert_eq!(off, 0);
    assert!(longest <= step_most + 1, "nobody appears anywhere");
    assert!(closest >= i128::from(2 * HUMAN_RADIUS * 1000).pow(2));
}
