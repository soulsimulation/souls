//! B3's checks (#2682) on one chair: one body per seat whatever the order, the seat released when a sit is cancelled
//! before contact and when its holder rises, a body never stuck when a sit is cancelled after contact or a rise
//! before it, a seat above reach refused by name, and the nearest clear spot. The
//! 300-seat hall is the `seats` bench (`v2/tools/bench/src/seats.rs`).

use std::collections::BTreeMap;
use std::path::Path;

use replica::bodies::{Class, Family};
use replica::effects::fixture_bytes;
use replica::encode::{Name, Value, decode};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move, Place};
use replica::pose::{Frame, Quat, Support, Vec3, fixture};
use replica::world_model::show;

use super::{PlaceAt, Request, Slots, clear_spot, seated_shape};
use crate::controller::{Controller, Part, Stance};
use crate::ground::Piece;
use crate::mover::Surface;
use crate::moves::{Moves, Reach, load};
use crate::timers::DueList;

const FAMILIES: &str = include_str!("../../../replica/fixtures/bodies/families.diag");
const CHAIR: &str = include_str!("../../../replica/fixtures/seats/chair.diag");

fn value(text: &str) -> Value {
    decode(&fixture_bytes(text).expect("bytes"))
        .expect("decodes")
        .value
}

fn mv(name: &str) -> Move {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/fixtures/moves");
    load(&dir)
        .expect("the fixture moves")
        .into_iter()
        .find(|m| m.name.as_str() == name)
        .expect("in the fixtures")
}

fn family() -> Family {
    let Value::Array(fs) = value(FAMILIES) else {
        panic!("a list")
    };
    fs.iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .find(|f| f.resources.iter().any(|r| r.class == Class::Manipulator))
        .expect("a family with legs and hands")
}

/// Each body's point (its feet, or its seat's point while it is in one) and each named point of the chair, µm.
struct Geo(BTreeMap<Id, Vec3>, BTreeMap<&'static str, Vec3>);

impl Reach for Geo {
    fn distance(
        &self,
        body: Id,
        _: &Effector,
        _: Option<&Name>,
        _: Id,
        point: &Name,
    ) -> Option<i64> {
        let (a, b) = (self.0.get(&body)?, self.1.get(point.as_str())?);
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        i64::try_from((d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt()).ok()
    }
}

struct World {
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    slots: Slots,
    floors: BTreeMap<Id, Surface>,
    chair: Id,
    bodies: Vec<Id>,
}

const FLOOR: i64 = 5_000_000;

fn world(place: Place) -> World {
    let floor = fixture(1);
    let corners = vec![
        [-5_000, 0, -5_000],
        [5_000, 0, -5_000],
        [5_000, 0, 5_000],
        [-5_000, 0, 5_000],
    ];
    let surface = Surface::new(
        floor,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
        }],
    );
    let mut mint = Minter::new(Scope([0xb3; 16]));
    let chair = mint.mint().expect("id");
    let mut c = Controller::new();
    let mut bodies = Vec::new();
    // Two bodies by the chair's stand point (300 mm in front of it), 100 mm either side.
    for x in [-100_000, 100_000] {
        let id = mint.mint().expect("id");
        let frame = Frame {
            node: floor,
            slot: None,
        };
        let placed = surface
            .place(id, frame, Vec3::new(x, 0, 300_000), Quat::IDENTITY)
            .expect("placed");
        c.add(family(), placed).expect("added");
        bodies.push(id);
    }
    let mut slots = Slots::new();
    slots
        .add(PlaceAt {
            thing: chair,
            point: Vec3::new(0, place.height, 0),
            place,
            facing: Quat::IDENTITY,
            floor,
        })
        .expect("a place");
    World {
        c,
        due: DueList::new(),
        mint,
        moves: Moves::new(),
        slots,
        floors: BTreeMap::from([(floor, surface)]),
        chair,
        bodies,
    }
}

impl World {
    fn geo(&self) -> Geo {
        let at = self.slots.place(self.chair).expect("the chair");
        let stand = at.stand().expect("a stand point");
        let points = BTreeMap::from([("souls:slot", at.point), ("souls:stand", stand)]);
        let bodies = self
            .bodies
            .iter()
            .map(|&b| {
                let p = self.c.body(b).expect("a body").pose;
                (
                    b,
                    if p.support == Support::Slot {
                        at.point
                    } else {
                        p.position
                    },
                )
            })
            .collect();
        Geo(bodies, points)
    }

    /// Fires every timer due before `until`, each against the world as it stands.
    fn run(&mut self, until: i64) {
        while let Some(t) = self.due.fire(until) {
            let geo = self.geo();
            let w = &mut *self;
            w.slots
                .fire(
                    &mut w.c,
                    &mut w.due,
                    &mut w.mint,
                    &mut w.moves,
                    &geo,
                    &w.floors,
                    &t,
                )
                .expect("a move's timer");
        }
    }

    fn sit(
        &mut self,
        order: &[usize],
        m: &Move,
    ) -> Vec<(Id, Result<u64, replica::effects::Refusal>)> {
        let geo = self.geo();
        let reqs: Vec<Request> = order
            .iter()
            .map(|&i| Request {
                body: self.bodies[i],
                thing: self.chair,
                slot: None,
                mv: m,
                stance: Stance::Sit,
            })
            .collect();
        let w = &mut *self;
        w.slots.commit(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &geo,
            &reqs,
            0,
        )
    }
}

fn chair() -> Place {
    Place::from_value(&value(CHAIR)).expect("the chair's place")
}

#[test]
fn a_seat_takes_one_body_whatever_the_order() {
    let sit = mv("souls:sit");
    for order in [[0, 1], [1, 0]] {
        let mut w = world(chair());
        let first = *w.bodies.iter().min().expect("bodies");
        let out = w.sit(&order, &sit);
        assert_eq!(out[0].0, first, "the stable key, not arrival");
        assert!(out[0].1.is_ok());
        let r = out[1].1.as_ref().expect_err("the second is refused");
        assert_eq!(r.name, "place-taken");
        assert!(r.detail.contains(&show(first)), "names the holder: {r}");
        w.run(i64::MAX);
        let p = w.c.body(first).expect("a body").pose;
        assert_eq!(p.support, Support::Slot);
        assert_eq!(
            p.frame,
            Frame {
                node: w.chair,
                slot: Some(1)
            }
        );
        assert_eq!(w.c.input(first).expect("a body").stance, Stance::Sit);
        let running = w.c.claims(first).expect("a body").running().clone();
        assert!(running.values().all(|i| i.shape == seated_shape()));
        assert!(w.due.is_empty() && w.moves.is_empty(), "no timer, no move");
        assert_eq!(w.slots.holder(w.chair), Some(first));
        assert!(w.c.step(&w.floors, 50_000, 2_000_000).refused.is_empty());
    }
}

#[test]
fn a_sit_cancelled_before_contact_frees_the_seat() {
    let sit = mv("souls:sit");
    let mut w = world(chair());
    let b = w.bodies[0];
    w.sit(&[0], &sit)[0].1.as_ref().expect("started");
    w.c.claim(b, &seated_shape())
        .expect("a later claim on the legs");
    w.run(i64::MAX);
    assert_eq!(w.slots.holder(w.chair), None, "released by the engine");
    assert_eq!(
        w.c.body(b).expect("a body").pose.support.clone(),
        Support::Surface {
            surface: fixture(1),
            height: 0
        }
    );
    assert!(w.sit(&[1], &sit)[0].1.is_ok(), "the place is free again");
}

#[test]
fn a_seat_above_standing_reach_is_refused_by_name() {
    let sit = mv("souls:sit");
    let mut w = world(Place {
        height: sit.reach + 1,
        ..chair()
    });
    let r = w.sit(&[0], &sit).remove(0).1.expect_err("refused");
    assert_eq!(r.name, "place-out-of-reach");
    assert!(w.moves.is_empty() && w.slots.is_empty());
}

#[test]
fn rising_hands_the_body_back_at_the_stand_point() {
    let (sit, rise) = (mv("souls:sit"), mv("souls:rise"));
    let mut w = world(chair());
    let b = *w.bodies.iter().min().expect("bodies");
    w.sit(&[0, 1], &sit);
    w.run(i64::MAX);
    let geo = w.geo();
    let n = w
        .slots
        .rise(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &geo,
            b,
            &rise,
            2_000_000,
        )
        .expect("rising");
    assert_eq!(
        w.c.input(b).expect("a body").stance,
        Stance::Sit,
        "seated until contact"
    );
    let contact = w.moves.record(n).expect("in progress").contact_at();
    w.run(contact + 1);
    let p = w.c.body(b).expect("a body").pose;
    let stand = w
        .slots
        .place(w.chair)
        .expect("the chair")
        .stand()
        .expect("a point");
    assert_eq!(
        (p.position.x, p.position.z),
        (stand.x, stand.z),
        "on its feet at the stand point"
    );
    assert!(matches!(p.support, Support::Surface { .. }));
    assert_eq!(w.c.input(b).expect("a body").stance, Stance::Stand);
    assert_eq!(
        w.slots.holder(w.chair),
        None,
        "released when the holder left"
    );
    w.run(i64::MAX);
    assert!(w.c.claims(b).expect("a body").running().is_empty());
}

/// A later claim on the legs that nothing cancels: a walk.
fn walk_shape() -> replica::bodies::SkillShape {
    replica::bodies::SkillShape {
        name: Name::new("test:walk").expect("a name"),
        claims: vec![replica::bodies::Want::All(Class::Locomotion)],
        blocks: vec![],
        cancelled_by: vec![],
    }
}

/// Never stuck: the walk that took `b`'s legs (`driver`) walks it away from the seat, and the seat is free.
fn walks_away(w: &mut World, b: Id, driver: u64) {
    assert!(
        w.due.is_empty() && w.moves.is_empty(),
        "nothing left running"
    );
    let p = w.c.body(b).expect("a body").pose;
    assert!(matches!(p.support, Support::Surface { .. }), "on the floor");
    assert_eq!(
        (w.slots.held_by(b), w.slots.holder(w.chair)),
        (None, None),
        "the place is free"
    );
    let v = Vec3::new(0, 0, 1_000_000);
    w.c.set(b, driver, Part::Velocity(v, replica::pose::Mode::Surface))
        .expect("steered by the walk");
    assert!(w.c.step(&w.floors, 50_000, 9_000_000).refused.is_empty());
    let q = w.c.body(b).expect("a body").pose.position;
    assert_eq!(q.z - p.position.z, 50_000, "walked one tick at 1 m/s");
}

#[test]
fn a_sit_cancelled_after_contact_never_leaves_the_body_stuck() {
    let sit = mv("souls:sit");
    let mut w = world(chair());
    let b = w.bodies[0];
    let n = w.sit(&[0], &sit)[0].1.clone().expect("started");
    let contact = w.moves.record(n).expect("in progress").contact_at();
    w.run(contact + 1);
    assert_eq!(
        w.c.body(b).expect("a body").pose.support,
        Support::Slot,
        "in the slot"
    );
    let d = w.c.claim(b, &walk_shape()).expect("a walk takes the legs");
    w.run(i64::MAX);
    walks_away(&mut w, b, d);
}

#[test]
fn a_rise_cancelled_before_contact_never_leaves_the_body_stuck() {
    let (sit, rise) = (mv("souls:sit"), mv("souls:rise"));
    let mut w = world(chair());
    let b = w.bodies[0];
    w.sit(&[0], &sit)[0].1.clone().expect("started");
    w.run(i64::MAX);
    let geo = w.geo();
    w.slots
        .rise(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &geo,
            b,
            &rise,
            2_000_000,
        )
        .expect("rising");
    let d = w.c.claim(b, &walk_shape()).expect("a walk takes the legs");
    w.run(i64::MAX);
    walks_away(&mut w, b, d);
}

#[test]
fn the_nearest_clear_spot_is_clear_and_nearest() {
    let w = world(chair());
    let floor = &w.floors[&fixture(1)];
    assert_eq!(
        clear_spot(floor, [0, 300_000], &[], 560_000, 50_000, 3_000_000),
        Some([0, 300_000])
    );
    let taken = [[0, 300_000]];
    let p = clear_spot(floor, [0, 300_000], &taken, 560_000, 50_000, 3_000_000).expect("a spot");
    let d2 = |a: [i64; 2], b: [i64; 2]| (a[0] - b[0]).pow(2) + (a[1] - b[1]).pow(2);
    assert!(d2(p, taken[0]) >= 560_000i64.pow(2));
    assert!(
        d2(p, taken[0]) < 610_000i64.pow(2),
        "the nearest on the grid"
    );
    assert!(
        clear_spot(floor, [FLOOR + 1_000_000, 0], &[], 1, 50_000, 500_000).is_none(),
        "off the floor"
    );
}

/// Reach that every point is within: the test of which slot is taken, not of reach.
struct Near;

impl Reach for Near {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, _: Id, _: &Name) -> Option<i64> {
        Some(0)
    }
}

/// C19 (#3457) A2: a thing with three seats (the chair's slot 1 in the middle, slots 2 and 3 600 mm either side) and
/// four bodies asking for it in one tick, naming only the thing. Whatever the order they come in, each of the first
/// three in the stable order takes the free slot whose stand point is nearest it, and the fourth is refused
/// `place-taken`, naming the three holders. Each sits in its own slot.
#[test]
fn c19_three_bodies_share_a_thing_each_in_its_own_slot() {
    let sit = mv("souls:sit");
    for reversed in [false, true] {
        let mut w = world(chair());
        for (slot, x) in [(2, -600_000), (3, 600_000)] {
            let mut place = chair();
            place.slot = slot;
            w.slots
                .add(PlaceAt {
                    thing: w.chair,
                    point: Vec3::new(x, place.height, 0),
                    place,
                    facing: Quat::IDENTITY,
                    floor: fixture(1),
                })
                .expect("a place");
        }
        // Bodies at x -100 and 100 mm (the world's), then 600 and -600 mm, 300 mm in front: minted in that order.
        for x in [600_000, -600_000] {
            let id = w.mint.mint().expect("id");
            let frame = Frame {
                node: fixture(1),
                slot: None,
            };
            let placed = w.floors[&fixture(1)]
                .place(id, frame, Vec3::new(x, 0, 300_000), Quat::IDENTITY)
                .expect("placed");
            w.c.add(family(), placed).expect("added");
            w.bodies.push(id);
        }
        let mut reqs: Vec<Request> = w
            .bodies
            .iter()
            .map(|&body| Request {
                body,
                thing: w.chair,
                slot: None,
                mv: &sit,
                stance: Stance::Sit,
            })
            .collect();
        if reversed {
            reqs.reverse();
        }
        let out = w.slots.commit(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &Near,
            &reqs,
            0,
        );
        let b = w.bodies.clone();
        assert_eq!(
            out.iter().map(|o| o.0).collect::<Vec<_>>(),
            b,
            "the stable order"
        );
        let r = out[3].1.as_ref().expect_err("the fourth is refused");
        assert_eq!(r.name, "place-taken");
        for &h in &b[..3] {
            assert!(r.detail.contains(&show(h)), "names every holder: {r}");
        }
        while let Some(t) = w.due.fire(i64::MAX) {
            w.slots
                .fire(
                    &mut w.c,
                    &mut w.due,
                    &mut w.mint,
                    &mut w.moves,
                    &Near,
                    &w.floors,
                    &t,
                )
                .expect("a move's timer");
        }
        // -100 mm takes the middle; 100 mm the nearest free, slot 3 (500 mm off); 600 mm the last, slot 2.
        for (&body, slot) in b.iter().zip([1, 3, 2]) {
            let p = w.c.body(body).expect("a body").pose;
            assert_eq!(p.support, Support::Slot);
            assert_eq!(
                p.frame,
                Frame {
                    node: w.chair,
                    slot: Some(slot)
                },
                "reversed {reversed}"
            );
            assert_eq!(w.slots.holder_in(w.chair, slot), Some(body));
        }
        assert_eq!(w.slots.holders(w.chair), vec![b[0], b[2], b[1]]);
        assert_eq!(w.slots.held_by(b[3]), None);
    }
}
