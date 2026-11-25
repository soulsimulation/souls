//! First-day round 3: a Soul rode Eden's balloon, its agent sent `carrier:land` in mid-flight, and the Soul was held
//! aboard for 25 minutes and more, every rise refused `boarding-frame-away` with no word of when it would be back. These
//! check, on the balloon's own course (`content/kinds/rides/balloon.json`, `sim::courses::rides::course`), that no ask
//! of a rider leaves it so:
//!
//! 1. A land while it flies its own course is refused by name (`on-its-course`), saying when it is back at its stop.
//! 2. A stop, a steer or a land at any moment of the flight gives a course that ends at its stop, flown at the
//!    balloon's own speed, and a rise refused on the way says when it is back there ("in N s"); there the rider
//!    rises. A second land never makes the way home longer.
//! 3. A restart mid-way reads the same course from the balloon's field and gives the same answers.

use replica::effects::Refusal;
use replica::ids::{Id, Scope};
use replica::pose::Vec3;
use replica::rules::json::parse;
use replica::schedule::course::Course;
use replica::time::Micros;
use sim::courses::punts::{ROWING, Steer, moorings};
use sim::courses::rides::{BOARDING, Ride, course};
use sim::ground::Water;
use sim::slots::Slots;
use worldd::carrier::{Ask, HOLD, plan};

const S: Micros = 1_000_000;

fn ids() -> (Id, Id) {
    (
        Id::new(Scope([0x4d; 16]), 7).unwrap(),
        Id::new(Scope([0x4d; 16]), 8).unwrap(),
    )
}

/// Eden's festival balloon's loop from world time 0: its course and its home.
fn balloon() -> (Course, Vec3) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../content/kinds/rides/balloon.json");
    let entry = parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    let ride = Ride::of(&entry).expect("a ride");
    let home = Vec3::new(290_000_000, 0, 65_000_000);
    (
        course(&ride, home, |_, _| Some(0), 0).expect("a loop"),
        home,
    )
}

fn here(c: &Course, t: Micros) -> Vec3 {
    c.load().unwrap().at(t).unwrap().0
}

/// The first whole second from `from` at which `c` stands stopped at `home` (on the ground there, not held above it),
/// within two hours.
fn home_at(c: &Course, home: Vec3, from: Micros) -> Option<Micros> {
    let t = c.load().unwrap();
    (0..7200)
        .map(|k| from + k * S)
        .find(|&at| matches!(t.stopped(at), Ok(Some(_))) && t.at(at).is_ok_and(|(p, _)| p == home))
}

/// The "in N s" a refusal names, N.
fn back_in(r: &Refusal) -> Option<i64> {
    let (_, tail) = r.detail.rsplit_once(" in ")?;
    tail.strip_suffix(" s")?.parse().ok()
}

/// A rider aboard `thing` on `c` asks to rise at `t`: refused `boarding-frame-away` saying when it is back, and that is
/// when it next stands at its stop (to the second); the rider rises then. The time it is back.
fn rises_when_it_says(slots: &Slots, thing: Id, c: &Course, home: Vec3, t: Micros) -> Micros {
    let back = home_at(c, home, t).expect("it comes back to its stop");
    if back <= t {
        slots.leavable(thing, t).expect("at its stop");
        return t;
    }
    let r = slots.leavable(thing, t).expect_err("away from its stop");
    assert_eq!(r.name, "boarding-frame-away");
    let n = back_in(&r).unwrap_or_else(|| panic!("says when it is back: {}", r.detail));
    assert!(
        (t + n * S - back).abs() <= S,
        "back in {n} s from {t}, at its stop at {back}: {}",
        r.detail
    );
    slots
        .leavable(thing, back)
        .expect("the rider rises at its stop");
    back
}

#[test]
fn a_land_while_the_balloon_flies_its_own_course_is_refused_saying_when_it_is_back() {
    let (own, _) = balloon();
    let (thing, body) = ids();
    let lap = own.load().unwrap().period;
    for t in [BOARDING + 30 * S, lap / 2, lap - 20 * S] {
        let r = plan(Ask::Land, thing, &own, None, body, here(&own, t), None, t)
            .expect_err("nothing to land from: its own course takes it home");
        assert_eq!(r.name, "on-its-course", "{}", r.detail);
        let n = back_in(&r).unwrap_or_else(|| panic!("says when: {}", r.detail));
        assert_eq!(n, (lap - t + S - 1) / S, "{}", r.detail);
    }
}

#[test]
fn a_stop_steer_or_land_at_any_moment_of_the_flight_brings_the_balloon_to_its_stop() {
    let (own, home) = balloon();
    let (thing, body) = ids();
    let lap = own.load().unwrap().period;
    let speed = own.speed;
    let mut t = BOARDING + 5 * S;
    while t < lap - 5 * S {
        let mut slots = Slots::new();
        // Stopped: held a while, then home at its own speed.
        let (stop, steer) =
            plan(Ask::Stop, thing, &own, None, body, here(&own, t), None, t).expect("a stop");
        let last = stop.stations.last().unwrap().at;
        assert_eq!((last.x, last.z), (home.x, home.z), "ends at its stop");
        assert!(stop.speed >= speed, "{} um/s, its own {speed}", stop.speed);
        slots.moving(thing, &stop, home).unwrap();
        let stopped_home = rises_when_it_says(&slots, thing, &stop, home, t + S);
        assert!(
            stopped_home <= t + HOLD + lap,
            "home {} s after the stop",
            (stopped_home - t) / S
        );
        // Landed while held: straight on home, no hold.
        let t2 = t + 10 * S;
        let (land, steer2) = plan(
            Ask::Land,
            thing,
            &stop,
            Some(steer.clone()),
            body,
            here(&stop, t2),
            None,
            t2,
        )
        .expect("a land after a stop");
        slots.moving(thing, &land, home).unwrap();
        let landed_home = rises_when_it_says(&slots, thing, &land, home, t2 + S);
        assert!(
            landed_home + HOLD - 12 * S <= stopped_home,
            "a land skips the hold"
        );
        // Landed again on the way (or once home): never later.
        let t3 = t2 + 20 * S;
        let (again, _) = plan(
            Ask::Land,
            thing,
            &land,
            Some(steer2.clone()),
            body,
            here(&land, t3),
            None,
            t3,
        )
        .expect("a land on the way home");
        slots.moving(thing, &again, home).unwrap();
        let again_home = rises_when_it_says(&slots, thing, &again, home, t3 + S);
        assert!(
            again_home <= landed_home.max(t3 + S) + 2 * S,
            "a second land never makes the way longer: {} s against {} s",
            (again_home - t3) / S,
            (landed_home - t3) / S
        );
        // A restart on the way reads the same course from the balloon's field: the same answers.
        let mut restarted = Slots::new();
        let read = Course::read(&again.to_value()).expect("the field reads back");
        restarted.moving(thing, &read, home).unwrap();
        assert_eq!(
            rises_when_it_says(&restarted, thing, &read, home, t3 + S),
            again_home
        );
        // Steered 20 m off its ring (as over a pond): held there, then home.
        let to = here(&own, t);
        let to = Vec3::new(to.x + 20_000_000, to.y, to.z);
        let (steered, _) = plan(
            Ask::Steer,
            thing,
            &own,
            None,
            body,
            here(&own, t),
            Some(to),
            t,
        )
        .expect("a steer");
        let mut s = Slots::new();
        s.moving(thing, &steered, home).unwrap();
        let steered_home = rises_when_it_says(&s, thing, &steered, home, t + S);
        assert!(steered_home <= t + HOLD + lap + 60 * S);
        t += 23 * S;
    }
}

#[test]
fn a_held_punt_still_rows_home_at_rowing_pace() {
    let m = 1_000_000;
    let pond = Water {
        place: Id::new(Scope([0x36; 16]), 1).unwrap(),
        ring: vec![[0, 0], [40 * m, 0], [40 * m, 12 * m], [0, 12 * m]],
        line: Vec::new(),
        width: 0,
        level: m,
    };
    let own = moorings(&[pond], None, |_| true).remove(0).course;
    let home = own.stations[0].at;
    let (thing, body) = ids();
    let t = own.load().unwrap().legs[1].start + 40 * S;
    let (stop, s) = plan(Ask::Stop, thing, &own, None, body, here(&own, t), None, t).unwrap();
    assert_eq!(stop.speed, ROWING);
    assert_eq!(Steer::read(&s.to_value()), Some(s));
    let mut slots = Slots::new();
    slots.moving(thing, &stop, home).unwrap();
    rises_when_it_says(&slots, thing, &stop, home, t + S);
}
