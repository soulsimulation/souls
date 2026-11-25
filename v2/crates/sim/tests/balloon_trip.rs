//! A balloon's loop aloft (#3691) as a ride: a Soul refused while it is away is told when it is back, and its trip ends
//! when it is home again, so what its `start` form set (`under_way`) goes back and the next riders board it.

use replica::encode::Value;
use replica::ids::{Id, Scope};
use replica::pose::Vec3;
use replica::rules::json::parse;
use sim::courses::rides::{BOARDING, Ride, course, trip_ends};
use sim::links::boarding::CROSSING;
use sim::slots::Slots;

fn balloon() -> replica::rules::json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../content/kinds/rides/balloon.json");
    parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn a_balloon_says_when_it_is_back_and_its_trip_ends_at_home() {
    let entry = balloon();
    let ride = Ride::of(&entry).expect("a ride");
    let home = Vec3::new(290_000_000, 0, 65_000_000);
    let c = course(&ride, home, |_, _| Some(0), 0).expect("a loop aloft");
    let lap = c.load().unwrap().period;
    let thing = Id::new(Scope([0x91; 16]), 7).unwrap();
    let mut slots = Slots::new();
    slots.moving(thing, &c, home).unwrap();
    // A minute at home to board, a crossing's time before it leaves.
    assert_eq!(BOARDING, 60_000_000);
    assert!(slots.boardable(thing, BOARDING - CROSSING).is_ok());
    // Away: refused, saying when it is next home and in how many seconds.
    let at = BOARDING + 30_000_000;
    let r = slots.boardable(thing, at).unwrap_err();
    assert_eq!(r.name, "boarding-frame-away");
    let back = lap;
    let wait_s = (back - at + 999_999) / 1_000_000;
    assert!(
        r.detail
            .ends_with(&format!("back at its stop at {back} us, in {wait_s} s")),
        "{}",
        r.detail
    );
    assert!(slots.boardable(thing, back).is_ok(), "home again then");

    // What its `ride` form set goes back to its default when it is home again: `under_way` (field 28) to false.
    let ends = trip_ends(&entry);
    assert_eq!(ends, vec![(28, Value::Uint(0))]);
    slots.trip_ends(thing, ends.clone());
    assert!(slots.trip_ended(0).is_empty(), "a start ends no trip");
    assert!(slots.trip_ended(BOARDING / 2).is_empty(), "boarding");
    assert!(slots.trip_ended(BOARDING + 1).is_empty(), "lifted off");
    assert!(slots.trip_ended(lap / 2).is_empty(), "aloft");
    assert_eq!(slots.trip_ended(lap + 1), vec![(thing, ends)], "home");
    assert!(slots.trip_ended(lap + 2).is_empty(), "once a trip");
}
