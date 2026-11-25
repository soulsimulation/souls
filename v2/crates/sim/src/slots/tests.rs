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

use super::{
    PlaceAt, Request, STANDARD_BUILD, STANDARD_REACH, Slots, clear_spot, seated_shape,
    standing_reach,
};
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
    /// Reach on the floor's plane, as the served world asks it (#3600): see [`World::geo`].
    flat: bool,
    /// Water on the floor (E11d), each `[x0, z0, x1, z1]` µm: what a climb out may pass over.
    water: Vec<[i64; 4]>,
}

const FLOOR: i64 = 5_000_000;

fn world(place: Place) -> World {
    let point = Vec3::new(0, place.height, 0);
    world_with(place, point, -5_000, 300_000)
}

/// A chair of `place` with its slot at `point` on a floor from z `front` mm to 5 m (the floor's walkable piece, as
/// clearance cut it), with two bodies at z `at` µm, 100 mm either side of the chair's line.
fn world_with(place: Place, point: Vec3, front: i32, at: i64) -> World {
    let floor = fixture(1);
    let corners = vec![
        [-5_000, 0, front],
        [5_000, 0, front],
        [5_000, 0, 5_000],
        [-5_000, 0, 5_000],
    ];
    let surface = Surface::new(
        floor,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: crate::gaits::Ground::Dry,
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
            .place(id, frame, Vec3::new(x, 0, at), Quat::IDENTITY)
            .expect("placed");
        c.add(family(), placed).expect("added");
        bodies.push(id);
    }
    let mut slots = Slots::new();
    slots
        .add(PlaceAt {
            thing: chair,
            point,
            place,
            facing: Quat::IDENTITY,
            floor,
            more: Vec::new(),
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
        flat: false,
        water: Vec::new(),
    }
}

impl World {
    /// Each body's and named point's distance; with `flat`, on the floor's plane: the served world's reach is
    /// horizontal, from the body to the seat's stand point (`worldd::bodies` asks it at height 0), so a seat's height
    /// is the standing reach's alone (#3600).
    fn geo(&self) -> Geo {
        let Geo(bodies, points) = self.geo3();
        if !self.flat {
            return Geo(bodies, points);
        }
        let flat = |p: Vec3| Vec3::new(p.x, 0, p.z);
        Geo(
            bodies.into_iter().map(|(b, p)| (b, flat(p))).collect(),
            points.into_iter().map(|(n, p)| (n, flat(p))).collect(),
        )
    }

    fn geo3(&self) -> Geo {
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
            &w.floors,
            &reqs,
            0,
        )
    }
}

fn chair() -> Place {
    Place::from_value(&value(CHAIR)).expect("the chair's place")
}

#[test]
fn edited_places_retire_only_when_unoccupied_and_preserve_hold_indexes() {
    let mut w = world(chair());
    let original = w.slots.place(w.chair).unwrap().clone();
    w.slots.replace(w.chair, Vec::new()).unwrap();
    assert!(w.slots.place(w.chair).is_none());
    w.slots.replace(w.chair, vec![original.clone()]).unwrap();
    w.sit(&[0], &mv("souls:sit"))[0].1.as_ref().unwrap();
    let body = w.bodies[0];
    assert_eq!(
        w.slots.replace(w.chair, Vec::new()).unwrap_err().name,
        "place-taken"
    );
    assert_eq!(
        w.slots.replace(w.chair, vec![original]).unwrap_err().name,
        "place-taken"
    );
    assert_eq!(w.slots.holder_in(w.chair, 1), Some(body));
    assert_eq!(w.slots.held_by(body), Some(w.chair));
    assert_eq!(w.slots.held_place(body).unwrap().place.slot, 1);
    assert_eq!(w.slots.places(), 1);
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
        height: STANDARD_REACH + 1,
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
    assert!(
        w.c.carried(b) && w.slots.climbs().is_empty(),
        "a normal rise is a step, no climb out (E11d)"
    );
    let p = stepped_off(&mut w, b, contact);
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

/// Steps the controller from `from` until the world's carry of `b` (a rise's step off its seat) has landed it, at most
/// two seconds: where it then stands.
fn stepped_off(w: &mut World, b: Id, from: i64) -> replica::pose::Pose {
    let mut t = from;
    while w.c.carried(b) && t < from + 2_000_000 {
        t += 50_000;
        assert!(w.c.step(&w.floors, 50_000, t).refused.is_empty());
    }
    assert!(!w.c.carried(b), "landed");
    w.c.body(b).expect("a body").pose
}

/// Standing up is a step off the seat, never a jump (PR #4790's finding: ~0.6 m off a mat in one tick): at contact
/// the body is on its feet where it sat, and the world carries it to the stand point over the rise's recovery, no
/// tick moving it farther than a brisk step.
#[test]
fn rising_steps_off_the_seat_over_its_recovery() {
    let (sit, rise) = (mv("souls:sit"), mv("souls:rise"));
    let mut w = world(chair());
    let b = *w.bodies.iter().min().expect("bodies");
    w.sit(&[0, 1], &sit);
    w.run(i64::MAX);
    let geo = w.geo();
    let n = w
        .slots
        .rise(&mut w.c, &mut w.due, &mut w.mint, &mut w.moves, &geo, b, &rise, 2_000_000)
        .expect("rising");
    let (contact, end) = {
        let r = w.moves.record(n).expect("in progress");
        (r.contact_at(), *r.ends.last().expect("phases"))
    };
    let at = w.slots.place(w.chair).expect("the chair").clone();
    let stand = at.stand().expect("a point");
    w.run(contact + 1);
    let p = w.c.body(b).expect("a body").pose;
    assert_eq!(
        (p.position.x, p.position.z),
        (at.point.x, at.point.z),
        "on its feet where it sat"
    );
    assert!(w.c.carried(b), "the world carries it off the seat");
    assert!(w.slots.climbs().is_empty(), "a step, not a climb out (E11d)");
    let (dt, mut t, mut last) = (50_000, contact, p.position);
    while t < end {
        t += dt;
        assert!(w.c.step(&w.floors, dt, t).refused.is_empty());
        let q = w.c.body(b).expect("a body").pose.position;
        let d = (i128::from(q.x - last.x).pow(2) + i128::from(q.z - last.z).pow(2)).isqrt();
        assert!(d <= 150_000, "{d} µm in one tick");
        last = q;
    }
    let p = w.c.body(b).expect("a body").pose;
    assert_eq!((p.position.x, p.position.z), (stand.x, stand.z), "at the stand point by the rise's end");
    assert!(!w.c.carried(b) && matches!(p.support, Support::Surface { .. }));
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
                    more: Vec::new(),
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
            &w.floors,
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

#[test]
fn seat_ownership_changes_wake_once_for_take_and_release() {
    let mut w = world(chair());
    assert!(w.slots.changes().is_empty());
    let sit = mv("souls:sit");
    w.sit(&[0], &sit)[0].1.as_ref().expect("taken");
    assert_eq!(w.slots.changes(), vec![w.chair]);
    assert!(w.slots.changes().is_empty(), "taking events drains them");
    w.c.claim(w.bodies[0], &seated_shape())
        .expect("cancel before contact");
    w.run(i64::MAX);
    assert_eq!(
        w.slots.changes(),
        vec![w.chair],
        "phase release wakes the line"
    );
    assert!(w.slots.changes().is_empty());
    w.sit(&[1], &sit)[0].1.as_ref().expect("taken again");
    assert_eq!(w.slots.changes(), vec![w.chair]);
    w.slots
        .release_body(w.bodies[1])
        .expect("retirement releases slot");
    assert_eq!(w.slots.changes(), vec![w.chair]);
}

/// Eden's chair `e_3403bec8` (B7c, #3593): its slot [0, 470, 20] mm and its stand point [0, 0, 509] mm, which lies 19 mm
/// inside the clearance of the chair's own collider: the walkable floor starts at z 528 mm. Bodies wait at z `at` µm.
fn clearance_chair(front: i32, at: i64) -> World {
    let place = Place {
        height: 470_000,
        stand: [0, 489_000],
        ..chair()
    };
    world_with(place, Vec3::new(0, 470_000, 20_000), front, at)
}

/// #1960 (B7c's stuck Soul): a body seated in a chair whose stand point lies in the chair's own clearance rises onto
/// the first supported point out along the chair's exit, stands on the floor, frees the seat, and walks the next tick.
#[test]
fn a_body_rises_from_a_chair_whose_stand_point_is_in_its_own_clearance() {
    let (sit, rise) = (mv("souls:sit"), mv("souls:rise"));
    let mut w = clearance_chair(528, 700_000);
    let b = w.bodies[0];
    let stand = w.slots.place(w.chair).unwrap().stand().unwrap();
    assert_eq!(
        (stand.x, stand.z),
        (0, 509_000),
        "the chair's own stand point"
    );
    let frame = Frame {
        node: fixture(1),
        slot: None,
    };
    assert!(
        w.floors[&fixture(1)]
            .place(b, frame, stand, Quat::IDENTITY)
            .is_err(),
        "the exact stand point is off the floor"
    );
    // Reach is not what this tests: every point is within it (the served world measures it to the stand point).
    let run = |w: &mut World, until: i64| {
        while let Some(t) = w.due.fire(until) {
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
    };
    let req = Request {
        body: b,
        thing: w.chair,
        slot: None,
        mv: &sit,
        stance: Stance::Sit,
    };
    let r = w
        .slots
        .commit(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &Near,
            &w.floors,
            &[req],
            0,
        )
        .remove(0)
        .1;
    r.expect("the sit is admitted");
    run(&mut w, i64::MAX);
    assert_eq!(w.c.body(b).unwrap().pose.support, Support::Slot);
    let n = w
        .slots
        .rise(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &Near,
            b,
            &rise,
            2_000_000,
        )
        .expect("rising");
    let contact = w.moves.record(n).expect("in progress").contact_at();
    run(&mut w, contact + 1);
    let p = stepped_off(&mut w, b, contact);
    assert!(
        matches!(p.support, Support::Surface { .. }),
        "on the floor: {p:?}"
    );
    assert_eq!(
        (p.position.x, p.position.z),
        (0, 529_000),
        "the first supported point out"
    );
    let off = (p.position.z - stand.z).abs() + (p.position.x - stand.x).abs();
    assert!(
        off <= super::rise_bound(replica::kinds::sizes::Build::STANDARD),
        "within the body's clearance radius of the stand point: {off} µm"
    );
    assert_eq!(w.c.input(b).unwrap().stance, Stance::Stand);
    assert_eq!(w.slots.holder(w.chair), None, "the slot is free");
    run(&mut w, i64::MAX);
    let d = w.c.claim(b, &walk_shape()).expect("a walk takes the legs");
    walks_away(&mut w, b, d);
}

/// #1960: a seat with no supported point within the body's clearance radius (280 mm, standard) of its stand point (the
/// floor starts 311 mm out from it) is refused up front by name, so no body sits where it cannot rise; nothing changes.
#[test]
fn a_sit_with_nowhere_to_rise_within_reach_is_refused_up_front() {
    let sit = mv("souls:sit");
    let mut w = clearance_chair(820, 900_000);
    let b = w.bodies[0];
    let before = w.c.body(b).unwrap().pose;
    let e = w.sit(&[0], &sit).remove(0).1.expect_err("refused");
    assert_eq!(e.name, "place-no-stand-point", "{e}");
    assert!(e.detail.contains("within 280000 µm"), "{e}");
    assert!(w.moves.is_empty() && w.slots.is_empty() && w.due.is_empty());
    assert_eq!(w.c.body(b).unwrap().pose, before);
}

/// #3600 A1: the standing reach is the admitted build's overhead reach (today's `seatReach`): 2.06 m for the standard
/// 1.75 m body, scaled by height, and unscaled for a hovering body.
#[test]
fn standing_reach_is_the_builds_overhead_reach() {
    assert_eq!(standing_reach(STANDARD_BUILD), 2_060_000);
    let of = |height_mm, hover_mm| {
        standing_reach(replica::kinds::sizes::Build {
            height_mm,
            hover_mm,
            ..STANDARD_BUILD
        })
    };
    assert_eq!(of(1_850, 0), 2_177_714);
    assert_eq!(of(1_000, 0), 1_177_142);
    assert_eq!(of(1_000, 300), STANDARD_REACH, "a hovering body, unscaled");
}

/// #3600 A1: a standard body takes ordinary seats above the sit move's 0.6 m contact reach and up to its standing
/// reach (C22's rows at 0.65 to 1.60 m: stool, guitar stool, hammock, wagon), and is seated in the slot.
#[test]
fn a_standard_body_takes_seats_up_to_its_standing_reach() {
    let sit = mv("souls:sit");
    for height in [650_000, 1_000_000, 1_600_000, STANDARD_REACH] {
        assert!(height > sit.reach || height == 650_000);
        let mut w = world(Place { height, ..chair() });
        let b = w.bodies[0];
        w.flat = true;
        let r = w.sit(&[0], &sit).remove(0).1;
        assert!(r.is_ok(), "a sit {height} µm up: {r:?}");
        w.run(i64::MAX);
        assert_eq!(w.c.body(b).expect("a body").pose.support, Support::Slot);
        assert_eq!(w.slots.holder(w.chair), Some(b));
    }
}

/// #3600 A2: a smaller body is refused a seat above its own standing reach by name, its body and the seat as they were;
/// at its reach it is seated. The cable car's cabins (19 m and 33.9 m above their stops) stay refused for every body.
#[test]
fn a_seat_above_the_bodys_own_standing_reach_is_refused_and_nothing_changes() {
    let sit = mv("souls:sit");
    let small = replica::kinds::sizes::Build {
        size: replica::kinds::sizes::Size::Small,
        height_mm: 1_000,
        hover_mm: 0,
    };
    let reach = standing_reach(small);
    for (height, admitted) in [(reach, true), (reach + 1, false), (1_600_000, false)] {
        let mut w = world(Place { height, ..chair() });
        let b = w.bodies[0];
        w.slots.admit(b, small);
        let before = w.c.body(b).expect("a body").pose;
        w.flat = true;
        let r = w.sit(&[0], &sit).remove(0).1;
        if admitted {
            assert!(r.is_ok(), "at its reach: {r:?}");
            continue;
        }
        let e = r.expect_err("refused");
        assert_eq!(e.name, "place-out-of-reach");
        assert!(
            e.detail.contains(&format!("standing reach {reach} µm")),
            "{e}"
        );
        assert!(w.moves.is_empty() && w.slots.is_empty() && w.due.is_empty());
        assert_eq!(w.c.body(b).expect("a body").pose, before);
        assert_eq!(w.slots.holder(w.chair), None);
    }
    for height in [19_000_000, 33_900_000] {
        let mut w = world(Place { height, ..chair() });
        w.flat = true;
        let e = w.sit(&[0], &sit).remove(0).1.expect_err("refused");
        assert_eq!(e.name, "place-out-of-reach", "a cabin {height} µm up");
        assert!(w.slots.is_empty());
    }
}

/// A floor of one piece from (x0, z0) to (x1, z1), mm: what is left of the chair's floor once it has changed under a
/// seated body (a boat moored the other way round, the floor cut back under a seat).
fn floor_only(x0: i32, z0: i32, x1: i32, z1: i32) -> Surface {
    let corners = vec![[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]];
    Surface::new(
        fixture(1),
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: crate::gaits::Ground::Dry,
        }],
    )
}

type Handed = Option<Result<replica::pose::HandOff, replica::effects::Refusal>>;

/// Fires every timer due before `until` with reach not in question ([`Near`]): the last hand-off the places made.
/// The world's floors with its water (E11d).
struct Wet<'a> {
    floors: &'a BTreeMap<Id, Surface>,
    water: &'a [[i64; 4]],
}

impl crate::mover::Floors for Wet<'_> {
    fn for_build(&self, b: replica::kinds::sizes::Build) -> Option<&BTreeMap<Id, Surface>> {
        self.floors.for_build(b)
    }

    fn wet(&self, _: Id, at: Vec3) -> bool {
        self.water
            .iter()
            .any(|r| at.x >= r[0] && at.z >= r[1] && at.x <= r[2] && at.z <= r[3])
    }
}

fn run_near(w: &mut World, until: i64) -> Handed {
    let mut handed = None;
    while let Some(t) = w.due.fire(until) {
        let (_, h) = w
            .slots
            .fire(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &mut w.moves,
                &Near,
                &Wet {
                    floors: &w.floors,
                    water: &w.water,
                },
                &t,
            )
            .expect("a move's timer");
        handed = h.or(handed);
    }
    handed
}

/// Starts `b` rising at `now` and runs it to the rise's contact: the contact and the hand-off made there.
fn rise_to_contact(w: &mut World, b: Id, now: i64) -> (i64, Handed) {
    let n = w
        .slots
        .rise(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &Near,
            b,
            &mv("souls:rise"),
            now,
        )
        .expect("rising");
    let contact = w.moves.record(n).expect("in progress").contact_at();
    (contact, run_near(w, contact + 1))
}

/// E11d: body 0 seated in the chair (slot at the origin, stand point 300 mm in front, +z), then the floor becomes
/// `floor`, and the body rises to the rise's contact.
fn seated_then_rise(floor: Surface, water: &[[i64; 4]]) -> (World, Id, i64, Handed) {
    let mut w = world(chair());
    w.water = water.to_vec();
    let b = w.bodies[0];
    w.sit(&[0], &mv("souls:sit"))[0].1.clone().expect("started");
    w.run(i64::MAX);
    assert_eq!(w.c.body(b).unwrap().pose.support, Support::Slot);
    w.floors.insert(fixture(1), floor);
    let (contact, handed) = rise_to_contact(&mut w, b, 2_000_000);
    (w, b, contact, handed)
}

/// Steps `w` 50 ms at a time from `from` until `b` is no longer carried (at most 10 s), firing timers as they fall
/// due: each tick's position.
fn step_until_landed(w: &mut World, b: Id, from: i64) -> Vec<Vec3> {
    let mut at = from;
    let mut path = vec![w.c.body(b).unwrap().pose.position];
    while w.c.carried(b) {
        at += 50_000;
        assert!(at < from + 10_000_000, "landed within 10 s");
        run_near(w, at);
        assert!(w.c.step(&w.floors, 50_000, at).refused.is_empty());
        path.push(w.c.body(b).unwrap().pose.position);
    }
    run_near(w, i64::MAX);
    path
}

/// Water over the whole test floor's plan, µm (E11d): the floor's own pieces are still floor.
const LAKE: [i64; 4] = [-5_000_000, -5_000_000, 5_000_000, 5_000_000];

/// E11d: a seat whose stand point faces the water, the bank on its other side (the floor from 1 m behind the seat):
/// the stand point and every point out along its exit are off the floor, so the body climbs out to the nearest floor
/// by a straight line that leaves only the seat's own hole, carried at walking speed (never further in a tick than
/// that), and stands on the bank, its seat free, and walks on. Named once (`climb-out`); the same both runs.
#[test]
fn e11d_a_seat_facing_the_water_climbs_out_onto_the_bank_behind_it() {
    let mut paths = Vec::new();
    for _ in 0..2 {
        let (mut w, b, contact, handed) =
            seated_then_rise(floor_only(-5_000, -5_000, 5_000, -1_000), &[LAKE]);
        let h = handed
            .expect("a hand-off at contact")
            .expect("the stand is not refused");
        assert_eq!(
            (h.pose.position.x, h.pose.position.z),
            (0, 0),
            "handed onto the floor's frame at the slot's own point, never at the bank"
        );
        assert!(w.c.carried(b), "carried by the world from the slot");
        assert_eq!(w.slots.holder(w.chair), None, "the slot is free");
        let climbs = w.slots.climbs();
        let [cl] = climbs.as_slice() else {
            panic!("one climb out: {climbs:?}")
        };
        assert_eq!(super::CLIMB_OUT, "climb-out");
        assert_eq!((cl.body, cl.thing, cl.at), (b, w.chair, contact));
        assert_eq!((cl.to.x, cl.to.z), (0, -1_000_000), "the nearest floor");
        let path = step_until_landed(&mut w, b, contact);
        assert!(path.len() > 10, "a climb over time, not a jump: {path:?}");
        let most = crate::gaits::WALK.speed * 50_000 / 1_000_000 + 1;
        for s in path.windows(2) {
            let (dx, dz) = (s[1].x - s[0].x, s[1].z - s[0].z);
            let d = (i128::from(dx) * i128::from(dx) + i128::from(dz) * i128::from(dz)).isqrt();
            assert!(
                d <= i128::from(most),
                "no tick further than walking speed: {d} µm"
            );
            assert_eq!(s[1].x, 0, "a straight line");
        }
        let p = w.c.body(b).unwrap().pose;
        assert!(
            matches!(p.support, Support::Surface { .. }),
            "on the bank: {p:?}"
        );
        assert_eq!((p.position.x, p.position.z), (0, -1_000_000));
        assert_eq!(w.c.input(b).unwrap().stance, Stance::Stand);
        assert!(w.slots.climbs().is_empty(), "named once");
        assert!(
            w.due.is_empty() && w.moves.is_empty(),
            "nothing left running"
        );
        // It walks on, up the bank.
        let d = w.c.claim(b, &walk_shape()).expect("a walk takes the legs");
        let v = Vec3::new(0, 0, -1_000_000);
        w.c.set(b, d, Part::Velocity(v, replica::pose::Mode::Surface))
            .expect("steered by the walk");
        assert!(w.c.step(&w.floors, 50_000, 20_000_000).refused.is_empty());
        let q = w.c.body(b).unwrap().pose.position;
        assert_eq!(q.z, -1_050_000, "walked one tick at 1 m/s");
        paths.push(path);
    }
    assert_eq!(paths[0], paths[1], "the same for the same inputs");
}

/// E11d: a seat whose floor is now far from it (as if its thing were moved by its creator to where no floor is
/// within 3 m): the rise ends `off-surface` at contact, by name, and the body is not stuck. It stays seated, its seat
/// held, a seated driver on its legs (it does seated things), it leaves the world as a seated body does
/// (`release_body`), and with floor near again it rises as normal.
#[test]
fn e11d_a_seat_with_no_floor_nearby_stays_seated_and_is_not_stuck() {
    let (mut w, b, _, handed) = seated_then_rise(floor_only(4_000, -5_000, 5_000, 5_000), &[LAKE]);
    let e = handed
        .expect("a hand-off at contact")
        .expect_err("no floor within the bound");
    assert_eq!(e.name, "off-surface", "{e}");
    assert!(e.detail.contains("within 3000000 µm"), "{e}");
    run_near(&mut w, i64::MAX);
    assert_eq!(
        w.c.body(b).unwrap().pose.support,
        Support::Slot,
        "seated still"
    );
    assert_eq!(w.slots.holder(w.chair), Some(b), "its slot held");
    assert!(
        !w.c.carried(b) && w.slots.climbs().is_empty(),
        "no climb, nothing moved"
    );
    let running = w.c.claims(b).unwrap().running().clone();
    assert!(
        running.values().all(|i| i.shape == seated_shape()),
        "held seated"
    );
    assert!(
        w.due.is_empty() && w.moves.is_empty(),
        "nothing left running"
    );
    // Floor near again: it rises at the stand point, as any rise.
    w.floors
        .insert(fixture(1), floor_only(-5_000, -5_000, 5_000, 5_000));
    let (contact, handed) = rise_to_contact(&mut w, b, 9_000_000);
    assert!(matches!(handed, Some(Ok(_))), "{handed:?}");
    let p = stepped_off(&mut w, b, contact);
    assert_eq!(
        (p.position.x, p.position.z),
        (0, 300_000),
        "at the stand point"
    );
    // And a body left seated so leaves the world as a seated body does.
    let (mut w, b, _, _) = seated_then_rise(floor_only(4_000, -5_000, 5_000, 5_000), &[LAKE]);
    run_near(&mut w, i64::MAX);
    assert_eq!(w.slots.release_body(b), Some((w.chair, None)));
    assert_eq!(w.slots.holder(w.chair), None);
}

/// E11d: a thing's other stand points come before the nearest floor. A thing with two seats 2 m apart, the floor only
/// round the second's stand point: the body in the first climbs out to that stand point, not to the floor's nearer
/// corner.
#[test]
fn e11d_the_things_other_stand_point_comes_first() {
    let mut w = world(chair());
    w.water = vec![LAKE];
    let b = w.bodies[0];
    let at = w.slots.place(w.chair).unwrap().clone();
    w.slots
        .add(PlaceAt {
            point: Vec3::new(2_000_000, at.point.y, 0),
            place: Place {
                slot: 2,
                ..at.place.clone()
            },
            ..at.clone()
        })
        .unwrap();
    let req = Request {
        body: b,
        thing: w.chair,
        slot: Some(1),
        mv: &mv("souls:sit"),
        stance: Stance::Sit,
    };
    let r = w.slots.commit(
        &mut w.c,
        &mut w.due,
        &mut w.mint,
        &mut w.moves,
        &Near,
        &w.floors,
        &[req],
        0,
    );
    r[0].1.as_ref().expect("started");
    run_near(&mut w, i64::MAX);
    assert_eq!(w.slots.held_place(b).unwrap().place.slot, 1);
    // The floor: x 1.5 m to 2.5 m, z 0 to 1 m. Its nearest point to the seat is (1.5 m, 0); the other seat's stand
    // point (2 m, 0.3 m) comes first.
    w.floors
        .insert(fixture(1), floor_only(1_500, 0, 2_500, 1_000));
    let (contact, handed) = rise_to_contact(&mut w, b, 2_000_000);
    assert!(matches!(handed, Some(Ok(_))), "{handed:?}");
    let climbs = w.slots.climbs();
    let [cl] = climbs.as_slice() else {
        panic!("{climbs:?}")
    };
    assert_eq!(
        (cl.to.x, cl.to.z),
        (2_000_000, 300_000),
        "the other slot's stand point"
    );
    step_until_landed(&mut w, b, contact + 1);
    let p = w.c.body(b).unwrap().pose.position;
    assert_eq!((p.x, p.z), (2_000_000, 300_000));
}

/// The chair's own box (E11d review): 2 m wide, 1 m deep, round its slot at the origin, µm.
fn hull() -> super::Footprint {
    vec![[
        [-1_000_000, -500_000],
        [1_000_000, -500_000],
        [1_000_000, 500_000],
        [-1_000_000, 500_000],
    ]]
}

/// E11d review: the bank is 1.5 m behind the seat, water between, and a thin wall (200 mm, across the whole water)
/// stands in it. No line from the seat to the bank passes only over water, so the body does not climb through the
/// wall: the rise ends `off-surface` and it stays seated. With water where the wall was, it climbs out.
#[test]
fn e11d_a_seat_behind_a_thin_wall_does_not_climb_through_it() {
    let bank = || floor_only(-5_000, -5_000, 5_000, -1_500);
    let walled = [
        [-5_000_000, -800_000, 5_000_000, 5_000_000],
        [-5_000_000, -5_000_000, 5_000_000, -1_000_000],
    ];
    let (w, b, _, handed) = seated_then_rise(bank(), &walled);
    let e = handed.expect("a hand-off").expect_err("refused");
    assert_eq!(e.name, "off-surface", "{e}");
    assert_eq!(
        w.c.body(b).unwrap().pose.support,
        Support::Slot,
        "seated still"
    );
    assert_eq!(w.slots.holder(w.chair), Some(b));
    let (mut w, b, _, handed) = seated_then_rise(bank(), &[LAKE]);
    assert!(matches!(handed, Some(Ok(_))), "{handed:?}");
    let [cl] = w.slots.climbs()[..] else {
        panic!("one climb")
    };
    assert_eq!((cl.to.x, cl.to.z), (0, -1_500_000));
    assert!(w.c.carried(b));
}

/// E11d review: the seat's thing (its own box, [`hull`]) is moored against another hull (z -1.3 m to -0.5 m, no
/// water), and the bank lies beyond it. The climb may pass over its own hull but not the other: refused, seated
/// still. With water where the other hull was, it climbs over its own hull and the water to the bank.
#[test]
fn e11d_a_seat_against_another_hull_does_not_climb_through_it() {
    let bank = || floor_only(-5_000, -5_000, 5_000, -1_500);
    let moored = [
        [-5_000_000, 500_000, 5_000_000, 5_000_000],
        [-5_000_000, -5_000_000, 5_000_000, -1_300_000],
    ];
    for (water, climbs) in [(&moored[..], false), (&[LAKE][..], true)] {
        let mut w = world(chair());
        w.water = water.to_vec();
        w.slots.footprint(w.chair, hull());
        let b = w.bodies[0];
        w.sit(&[0], &mv("souls:sit"))[0].1.clone().expect("started");
        w.run(i64::MAX);
        w.floors.insert(fixture(1), bank());
        let (_, handed) = rise_to_contact(&mut w, b, 2_000_000);
        if climbs {
            assert!(matches!(handed, Some(Ok(_))), "{handed:?}");
            assert_eq!(w.slots.climbs().len(), 1);
        } else {
            let e = handed.expect("a hand-off").expect_err("refused");
            assert_eq!(e.name, "off-surface", "{e}");
            assert_eq!(w.slots.holder(w.chair), Some(b), "seated still");
            assert!(w.slots.climbs().is_empty());
        }
    }
}

/// E11d review: a climb out never lands on a body. The seat faces the water (its stand point 300 mm behind it) and
/// the floor starts 300 mm in front, where body 1 stands (100 mm aside of the seat's line). The nearest floor points
/// are within [`crate::controller::LANDING_ROOM`] of it, so the body climbs out to the nearest one clear of it.
#[test]
fn e11d_a_climb_out_never_lands_on_another_body() {
    let mut w = world(Place {
        stand: [0, -300_000],
        ..chair()
    });
    w.water = vec![LAKE];
    let (b, other) = (w.bodies[0], w.bodies[1]);
    let req = Request {
        body: b,
        thing: w.chair,
        slot: None,
        mv: &mv("souls:sit"),
        stance: Stance::Sit,
    };
    let r = w.slots.commit(
        &mut w.c,
        &mut w.due,
        &mut w.mint,
        &mut w.moves,
        &Near,
        &w.floors,
        &[req],
        0,
    );
    r[0].1.as_ref().expect("started");
    run_near(&mut w, i64::MAX);
    w.floors
        .insert(fixture(1), floor_only(-5_000, 300, 5_000, 5_000));
    let o = w.c.body(other).unwrap().pose.position;
    assert_eq!((o.x, o.z), (100_000, 300_000), "body 1 on the floor's edge");
    let (contact, handed) = rise_to_contact(&mut w, b, 2_000_000);
    assert!(matches!(handed, Some(Ok(_))), "{handed:?}");
    let [cl] = w.slots.climbs()[..] else {
        panic!("one climb")
    };
    let apart =
        |p: Vec3| (i128::from(p.x - o.x).pow(2) + i128::from(p.z - o.z).pow(2)).isqrt() as i64;
    assert_ne!(
        (cl.to.x, cl.to.z),
        (0, 300_000),
        "not the nearest floor point: body 1 is there"
    );
    assert!(
        apart(cl.to) >= crate::controller::LANDING_ROOM,
        "clear of body 1: {} µm",
        apart(cl.to)
    );
    step_until_landed(&mut w, b, contact + 1);
    let p = w.c.body(b).unwrap().pose.position;
    assert!(
        apart(p) >= crate::controller::LANDING_ROOM,
        "landed clear of body 1"
    );
}

/// A floor of pieces, each `[x0, z0, x1, z1, y]` mm (E11d recheck).
fn floor_of(pieces: &[[i32; 5]]) -> Surface {
    Surface::new(
        fixture(1),
        pieces
            .iter()
            .map(|&[x0, z0, x1, z1, y]| {
                let corners = vec![[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];
                Piece {
                    outline: vec![corners.clone()],
                    vertices: corners,
                    triangles: vec![[0, 2, 1], [0, 3, 2]],
                    ground: crate::gaits::Ground::Dry,
                }
            })
            .collect(),
    )
}

/// E11d recheck: a restart that finds a body killed early in a climb out, still over its own hull (the chair's box,
/// [`hull`]), with a bank 1.5 m away beyond another hull moored alongside (z -1.3 m to -0.5 m, no water) and a bank
/// 2 m away across open water: it climbs on to the far bank, as the live climb would, never through the other hull.
/// With no water at all it is left where the log had it (`resume-held`), never carried through a cut.
#[test]
fn e11d_a_restart_mid_climb_climbs_on_by_the_climbs_rule_not_through_another_hull() {
    let mut w = world(chair());
    w.slots.footprint(w.chair, hull());
    let floor = floor_of(&[
        [-5_000, -5_000, 5_000, -1_500, 0],
        [-5_000, 2_000, 5_000, 5_000, 0],
    ]);
    let water = [
        [-5_000_000, 500_000, 5_000_000, 2_000_000],
        [-5_000_000, -1_500_000, 5_000_000, -1_300_000],
    ];
    let frame = Frame {
        node: fixture(1),
        slot: None,
    };
    let b = w.bodies[0];
    let at = Vec3::new(0, 0, -200_000);
    let wet = Wet {
        floors: &w.floors,
        water: &water,
    };
    let build = replica::kinds::sizes::Build::STANDARD;
    let r = w
        .slots
        .resume(&wet, &floor, b, frame, at, Quat::IDENTITY, build);
    let super::Resumed::Climbs(to) = r else {
        panic!("climbs on: {r:?}")
    };
    assert_eq!(
        (to.x, to.z),
        (0, 2_000_000),
        "the far bank, across the water"
    );
    assert_eq!(r.name(), "climb-out");
    assert!(to.z > at.z, "away from the other hull, never across it");
    let nearest = crate::ground::exits::nearest(floor.pieces(), at).unwrap().1;
    assert!(
        nearest.z < 0,
        "the nearest legal point is the near bank, behind the other hull"
    );
    let dry = Wet {
        floors: &w.floors,
        water: &[],
    };
    let r = w
        .slots
        .resume(&dry, &floor, b, frame, at, Quat::IDENTITY, build);
    assert_eq!(r, super::Resumed::Held, "no clean way: left where it is");
    assert_eq!(r.name(), "resume-held");
    let p = super::placed_off(&floor, b, frame, at, Quat::IDENTITY, build).unwrap();
    assert_eq!(p.pose.position, at, "placed where the log had it");
}

/// E11d recheck: a climb out lands within a step's height (220 mm) of the seat's own floor. The bank behind the seat
/// 1 m away is 300 mm up: refused, seated still. At 200 mm up it is climbed onto.
#[test]
fn e11d_a_climb_out_steps_up_no_more_than_a_step() {
    for (y, climbs) in [(300, false), (200, true)] {
        let (mut w, b, _, handed) =
            seated_then_rise(floor_of(&[[-5_000, -5_000, 5_000, -1_000, y]]), &[LAKE]);
        if climbs {
            assert!(matches!(handed, Some(Ok(_))), "{y} mm: {handed:?}");
            let [cl] = w.slots.climbs()[..] else {
                panic!("one climb")
            };
            assert_eq!(cl.to.y, i64::from(y) * 1000, "on the bank");
        } else {
            let e = handed.expect("a hand-off").expect_err("refused");
            assert_eq!(e.name, "off-surface", "{y} mm: {e}");
            assert_eq!(w.slots.holder(w.chair), Some(b), "seated still");
        }
    }
}

/// 0.135 E16: a slot that holds two bodies (a tent's `sleep`, `most: 2`) takes two, each at its own place in the slot,
/// the slot's point and the other place 560 mm off, and refuses a third `place-taken`, naming both holders. A rise
/// frees exactly that body's place: the other stays where it is, and the next body takes the freed place.
#[test]
fn e16_a_slot_of_two_holds_two_bodies_each_at_its_own_place() {
    let (sit, rise) = (mv("souls:sit"), mv("souls:rise"));
    let mut w = world(chair());
    let mut two = w.slots.place(w.chair).expect("the chair").clone();
    let other = Vec3::new(560_000, 0, 0);
    two.more = vec![other];
    assert_eq!(two.most(), 2);
    w.slots.replace(w.chair, vec![two]).expect("unoccupied");
    let id = w.mint.mint().expect("id");
    let frame = Frame {
        node: fixture(1),
        slot: None,
    };
    let placed = w.floors[&fixture(1)]
        .place(id, frame, Vec3::new(0, 0, 250_000), Quat::IDENTITY)
        .expect("placed");
    w.c.add(family(), placed).expect("added");
    w.bodies.push(id);
    let b = w.bodies.clone();
    let out = w.sit(&[0, 1, 2], &sit);
    assert!(out[0].1.is_ok() && out[1].1.is_ok(), "two fit: {out:?}");
    let r = out[2].1.as_ref().expect_err("the third is refused");
    assert_eq!(r.name, "place-taken");
    assert!(
        r.detail.contains(&show(b[0])) && r.detail.contains(&show(b[1])),
        "names both holders: {r}"
    );
    w.run(i64::MAX);
    let slot = Frame {
        node: w.chair,
        slot: Some(1),
    };
    let at = |w: &World, body| {
        let p = w.c.body(body).expect("a body").pose;
        assert_eq!((p.support, p.frame), (Support::Slot, slot));
        p.position
    };
    assert_eq!(at(&w, b[0]), Vec3::ZERO, "the first at the slot's point");
    assert_eq!(at(&w, b[1]), other, "the second at its own place");
    assert_eq!(w.slots.spot_of(b[1]), Some((w.chair, 1, 1)));
    assert_eq!(w.slots.holders_in(w.chair, 1), vec![b[0], b[1]]);
    let geo = w.geo();
    w.slots
        .rise(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &geo,
            b[0],
            &rise,
            2_000_000,
        )
        .expect("rising");
    w.run(i64::MAX);
    assert!(matches!(
        w.c.body(b[0]).expect("a body").pose.support,
        Support::Surface { .. }
    ));
    assert_eq!(
        w.slots.holders_in(w.chair, 1),
        vec![b[1]],
        "only b0's place"
    );
    assert_eq!(at(&w, b[1]), other, "b1 never moved");
    let out = w.sit(&[2], &sit);
    out[0].1.as_ref().expect("the freed place");
    w.run(i64::MAX);
    assert_eq!(
        at(&w, b[2]),
        Vec3::ZERO,
        "the freed place, the slot's point"
    );
    assert_eq!(w.slots.spot_of(b[2]), Some((w.chair, 1, 0)));
}

/// 0.135 E16, review of #4549: a restart seats each body again at the place the checkpoint had it, never another. A
/// at place 0 and B at place 1; A rises; the world restarts with B's logged position. B comes back at place 1, though
/// place 0 is free and lower; a body whose own place is taken takes the lowest free one.
#[test]
fn e16_a_restart_seats_a_body_at_its_own_place() {
    let (sit, rise) = (mv("souls:sit"), mv("souls:rise"));
    let other = Vec3::new(560_000, 0, 0);
    let two = |w: &mut World| {
        let mut p = w.slots.place(w.chair).expect("the chair").clone();
        p.more = vec![other];
        w.slots.replace(w.chair, vec![p]).expect("unoccupied");
    };
    let mut w = world(chair());
    two(&mut w);
    let (a, b) = (w.bodies[0], w.bodies[1]);
    let out = w.sit(&[0, 1], &sit);
    assert!(out.iter().all(|o| o.1.is_ok()), "{out:?}");
    w.run(i64::MAX);
    assert_eq!(w.slots.spot_of(b), Some((w.chair, 1, 1)));
    let geo = w.geo();
    w.slots
        .rise(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &geo,
            a,
            &rise,
            2_000_000,
        )
        .expect("rising");
    w.run(i64::MAX);
    let logged = w.c.body(b).expect("b").pose.position;
    assert_eq!(logged, other);
    // The restart: the same bodies standing again (the fixture's), the places registered anew, B restored.
    let mut w = world(chair());
    two(&mut w);
    w.slots
        .restore(
            &mut w.c,
            b,
            (w.chair, Some(1)),
            Some(logged),
            Stance::Sit,
            3_000_000,
        )
        .expect("restored");
    assert_eq!(w.slots.spot_of(b), Some((w.chair, 1, 1)), "its own place");
    assert_eq!(w.c.body(b).expect("b").pose.position, other, "not moved");
    assert_eq!(
        w.slots.holders_in(w.chair, 1),
        vec![b],
        "place 0 still free"
    );
    // A body whose kept place is taken falls back to the lowest free one.
    w.slots
        .restore(
            &mut w.c,
            a,
            (w.chair, Some(1)),
            Some(other),
            Stance::Sit,
            3_000_000,
        )
        .expect("restored");
    assert_eq!(w.slots.spot_of(a), Some((w.chair, 1, 0)));
}

/// N14: the chair as a cabin on a run along the floor, across and back between its own stop and one 3 m on (z), each
/// a stop of 10 s, at 1 m/s; the far stop's stand point is in front of the seat there as at its own.
fn cabin(w: &mut World) -> crate::courses::Table {
    use crate::courses::{Course, Shape, Station};
    let at = w.slots.place(w.chair).expect("the chair").clone();
    let far = Vec3::new(at.point.x, at.point.y, at.point.z + 3_000_000);
    let course = Course {
        stations: vec![
            Station {
                at: at.point,
                dwell: 10_000_000,
            },
            Station {
                at: far,
                dwell: 10_000_000,
            },
        ],
        shape: crate::courses::Shape::ThereAndBack,
        speed: 1_000_000,
        t0: 0,
        within: 30_000_000,
    };
    let _ = Shape::Loop;
    let there = PlaceAt {
        point: far,
        ..at.clone()
    };
    w.slots
        .run(
            w.chair,
            at.place.slot,
            &course,
            vec![(0, at), (1, there)],
            &std::collections::BTreeSet::from([0]),
        )
        .expect("a run");
    course.load().expect("loads")
}

fn rise_at(w: &mut World, b: Id, now: i64) -> Result<u64, replica::effects::Refusal> {
    let (rise, geo) = (mv("souls:rise"), w.geo());
    w.slots.rise(
        &mut w.c,
        &mut w.due,
        &mut w.mint,
        &mut w.moves,
        &geo,
        b,
        &rise,
        now,
    )
}

fn sit_at(w: &mut World, i: usize, now: i64) -> Result<u64, replica::effects::Refusal> {
    let (geo, m) = (w.geo(), mv("souls:sit"));
    let slot = w.slots.place(w.chair).expect("the chair").place.slot;
    let req = [Request {
        body: w.bodies[i],
        thing: w.chair,
        slot: Some(slot),
        mv: &m,
        stance: Stance::Sit,
    }];
    let w = &mut *w;
    w.slots
        .commit(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &geo,
            &w.floors,
            &req,
            now,
        )
        .remove(0)
        .1
}

#[test]
fn n14_a_seat_that_moves_with_its_cabin_is_boarded_and_left_only_at_a_stop() {
    let mut w = world(chair());
    let table = cabin(&mut w);
    let slot = w.slots.place(w.chair).expect("the chair").place.slot;
    assert!(w.slots.runs(w.chair, slot));
    let b = w.bodies[0];
    // Not boarded while the cabin is between stops, nor with less than a crossing of its stop left.
    let name = |r: Result<u64, replica::effects::Refusal>| r.map(|_| ()).map_err(|e| e.name);
    assert_eq!(
        name(sit_at(&mut w, 0, 11_000_000)),
        Err("boarding-frame-away")
    );
    assert_eq!(
        name(sit_at(&mut w, 0, 9_000_000)),
        Err("boarding-frame-away")
    );
    // Nor at the far stop, 3 m from where a form walks its rider (its own stand point): it is left there, not boarded.
    assert_eq!(
        name(sit_at(&mut w, 0, 14_000_000)),
        Err("boarding-frame-away")
    );
    assert!(w.slots.is_empty(), "nothing held");
    // Boarded at its own stop.
    sit_at(&mut w, 0, 0).expect("boarded at its stop");
    w.run(8_000_000);
    let p = w.c.body(b).expect("a body").pose;
    assert_eq!(p.support, Support::Slot);
    let seated = p.position;
    // On its way the rider stays in its seat, carried: a rise is refused and nothing moves it.
    assert_eq!(
        name(rise_at(&mut w, b, 11_500_000)),
        Err("boarding-frame-away")
    );
    let p = w.c.body(b).expect("a body").pose;
    assert_eq!(
        (p.support, p.position),
        (Support::Slot, seated),
        "carried on"
    );
    assert_eq!(w.slots.held_by(b), Some(w.chair));
    // The seat moves by its course alone: never more than its speed allows between two ticks, so no jump.
    let mut last = table.at(0).expect("at").0;
    for t in (0..40_000_000).step_by(50_000) {
        let now = table.at(t).expect("at").0;
        let d = (now.z - last.z).abs() + (now.x - last.x).abs() + (now.y - last.y).abs();
        assert!(d <= 50_001, "{d} um in one tick at {t}");
        last = now;
    }
    // At the far stop it rises at that stop's stand point, 3 m on from where it got on.
    let now = 14_000_000;
    assert!(matches!(table.stopped(now), Ok(Some(s)) if s.station == 1));
    let n = rise_at(&mut w, b, now).expect("rises at the far stop");
    let contact = w.moves.record(n).expect("in progress").contact_at();
    w.run(contact + 1);
    let p = stepped_off(&mut w, b, contact);
    let stand = w
        .slots
        .place(w.chair)
        .expect("the chair")
        .stand()
        .expect("a point");
    assert!(matches!(p.support, Support::Surface { .. }));
    assert_eq!((p.position.x, p.position.z), (stand.x, stand.z + 3_000_000));
    assert_eq!(w.slots.holder(w.chair), None);
}

#[test]
fn n14_a_rider_whose_legs_another_claim_takes_is_never_set_down_between_stops() {
    let mut w = world(chair());
    cabin(&mut w);
    let b = w.bodies[0];
    let n = sit_at(&mut w, 0, 0).expect("started");
    let contact = w.moves.record(n).expect("in progress").contact_at();
    w.run(contact + 1);
    // Its sit is cancelled after contact while the cabin is under way: it keeps its seat and is carried on.
    let d = w.c.claim(b, &walk_shape()).expect("a walk takes the legs");
    let held = {
        let w = &mut w;
        w.slots.cancel(
            &mut w.c,
            &mut w.due,
            &mut w.moves,
            &w.floors,
            b,
            n,
            12_000_000,
            Name::new("test:left").expect("a name"),
        )
    };
    assert_eq!(held, Some(true), "still holds its place");
    assert_eq!(w.c.body(b).expect("a body").pose.support, Support::Slot);
    assert_eq!(w.slots.held_by(b), Some(w.chair));
    // Its walk ends; at the next stop it rises there.
    w.c.release(b, d).expect("the walk ends");
    rise_at(&mut w, b, 14_000_000).expect("rises at the next stop");
}

#[test]
fn n14_a_trip_ends_at_the_next_stop_and_a_board_waits_for_the_cabin() {
    use replica::encode::Value;
    let mut w = world(chair());
    cabin(&mut w);
    w.slots.trip_ends(w.chair, vec![(28, Value::Uint(0))]);
    // Asked at its stop first, as a start finds it: no trip ends.
    assert!(w.slots.trip_ended(0).is_empty());
    assert!(w.slots.trip_ended(11_000_000).is_empty(), "between stops");
    // It comes to the far stop: the trip ends there, once.
    assert_eq!(
        w.slots.trip_ended(14_000_000),
        vec![(w.chair, vec![(28, Value::Uint(0))])]
    );
    assert!(w.slots.trip_ended(15_000_000).is_empty());
    // A form that sits is let walk to it only while the cabin waits at its own stop with a crossing's time left; else
    // the refusal says when it is back (a lap of 26 s: 10 s there, 3 s on, 10 s at the far stop, 3 s back).
    assert!(w.slots.boardable_seat(w.chair, 0).is_ok());
    for t in [9_000_000, 11_000_000, 14_000_000] {
        let r = w.slots.boardable_seat(w.chair, t).expect_err("away");
        assert_eq!(r.name, "boarding-frame-away");
        assert!(r.detail.contains("26000000"), "{r}");
    }
    assert!(w.slots.boardable_seat(w.chair, 26_000_000).is_ok());
}

/// N14 review: a big wheel's gondolas share one stand point, so the free-slot choice was always gondola 1, aloft 14
/// steps of 16. A request naming no slot takes a gondola that waits at the platform now, whichever it is.
#[test]
fn n14_a_big_wheel_is_boarded_at_whichever_gondola_waits_at_the_platform() {
    use replica::rules::json::{Value as Json, parse};
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/rides");
    let entry = parse(&std::fs::read_to_string(dir.join("big_wheel.json")).unwrap()).unwrap();
    let mut w = world(chair());
    let wheel = w.mint.mint().expect("id");
    let floor = fixture(1);
    let mm = |v: &Json| {
        let a = v.arr().unwrap();
        let n = |k: usize| match a[k] {
            Json::Int(n) => i64::try_from(n).unwrap() * 1000,
            _ => panic!("a whole mm"),
        };
        Vec3::new(n(0), n(1), n(2))
    };
    let mut registered = BTreeMap::new();
    for (n, (_, s)) in (1u64..).zip(entry.get("slots").unwrap().obj().unwrap()) {
        let at = mm(s.get("at_mm").unwrap());
        let stand_name = s.get("stand").unwrap().str().unwrap();
        let st = mm(entry
            .get("points")
            .unwrap()
            .get(stand_name)
            .unwrap()
            .get("at_mm")
            .unwrap());
        let p = PlaceAt {
            thing: wheel,
            place: Place {
                slot: n,
                height: at.y,
                stand: [st.x - at.x, st.z - at.z],
            },
            point: at,
            facing: Quat::IDENTITY,
            floor,
            more: Vec::new(),
        };
        w.slots.add(p.clone()).expect("a place");
        registered.insert(n, p);
    }
    let runs =
        crate::courses::rides::seat_runs(&entry, &registered, &|p| Some(p), &|_, _| Some(0), 0);
    assert_eq!(runs.len(), 16);
    for r in &runs {
        w.slots
            .run(wheel, r.slot, &r.course, r.stops.clone(), &r.own)
            .expect("a run");
    }
    // A step at which gondola 1 is up the wheel: its fifth stop.
    let table = runs[0].course.load().unwrap();
    let t = table
        .legs
        .iter()
        .filter(|l| l.stop.is_some())
        .nth(4)
        .unwrap()
        .start
        + 1;
    assert!(!w.slots.at_own_stop(wheel, 1, t), "gondola 1 is aloft");
    let waiting: Vec<u64> = (1..=16)
        .filter(|s| w.slots.at_own_stop(wheel, *s, t))
        .collect();
    assert_eq!(
        waiting.len(),
        2,
        "two gondolas wait at the platform: {waiting:?}"
    );
    assert!(w.slots.boardable_seat(wheel, t).is_ok());
    // A sit naming no gondola takes one of those two.
    let body = w.bodies[0];
    let sit = mv("souls:sit");
    let req = [Request {
        body,
        thing: wheel,
        slot: None,
        mv: &sit,
        stance: Stance::Sit,
    }];
    let w = &mut w;
    let out = w.slots.commit(
        &mut w.c,
        &mut w.due,
        &mut w.mint,
        &mut w.moves,
        &Near,
        &w.floors,
        &req,
        t,
    );
    assert!(out[0].1.is_ok(), "{:?}", out[0].1);
    let (_, slot, _) = w.slots.spot_of(body).expect("held");
    assert!(waiting.contains(&slot), "took gondola {slot}");
}
