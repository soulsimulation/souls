//! #3603 A2: a seat on a thing that moves on a course (a rowing punt) is boarded only while the thing stands at its
//! home with a crossing's time of its stop left. Asked before a form walks a body to it ([`Slots::boardable`]), so a
//! body is never walked toward a punt that has left its stop or stands out on the water.

use replica::ids::{Id, Scope};
use replica::pose::Vec3;
use sim::courses::punts::{BOARDING, moorings, once};
use sim::ground::Water;
use sim::links::boarding::CROSSING;
use sim::slots::Slots;

#[test]
fn a_punt_is_boardable_only_at_its_stop() {
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
    let punt = Id::new(Scope([0x36; 16]), 2).unwrap();
    let chair = Id::new(Scope([0x36; 16]), 3).unwrap();
    let mut slots = Slots::new();
    slots.moving(punt, &own, home).unwrap();
    let away = |r: Result<(), replica::effects::Refusal>| r.map_err(|e| e.name);

    // Its own loop: boardable in its stop while a crossing's time is left, not after, not out on the loop.
    assert_eq!(away(slots.boardable(punt, 0)), Ok(()));
    assert_eq!(away(slots.boardable(punt, BOARDING - CROSSING)), Ok(()));
    assert_eq!(
        away(slots.boardable(punt, BOARDING - CROSSING + 1)),
        Err("boarding-frame-away")
    );
    assert_eq!(
        away(slots.boardable(punt, BOARDING + 20 * m)),
        Err("boarding-frame-away")
    );
    // Steered out over the water and standing there for good: never boardable.
    let out = Vec3::new(home.x + 10 * m, home.y, home.z);
    let steered = once(home, &[out], 100 * m).unwrap();
    slots.moving(punt, &steered, home).unwrap();
    assert_eq!(
        away(slots.boardable(punt, 200 * m)),
        Err("boarding-frame-away"),
        "standing offshore"
    );
    // Rowed back to its home and standing there: boardable again.
    let back = once(out, &[home], 200 * m).unwrap();
    slots.moving(punt, &back, home).unwrap();
    assert_eq!(
        away(slots.boardable(punt, 210 * m)),
        Err("boarding-frame-away"),
        "on its way"
    );
    assert_eq!(away(slots.boardable(punt, 300 * m)), Ok(()), "home");
    // A thing on no course is not asked.
    assert_eq!(away(slots.boardable(chair, 0)), Ok(()));
}
