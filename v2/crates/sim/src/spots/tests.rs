//! C15 (#3447): [`within`], the place a body acts from at a point it cannot stand on, on a plain ground with one
//! square block on it.

use super::*;

/// Open ground, but no standing within `half` (µm) of the origin across x and z; every walk is straight.
struct Block {
    half: i64,
}

impl Ground for Block {
    fn stand(&self, _: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        (p.x.abs() > self.half || p.z.abs() > self.half).then_some((p, p))
    }
    fn passage(&self, _: Id, _: Vec3) -> bool {
        false
    }
    fn walk(&mut self, _: Id, a: Vec3, _: Id, b: Vec3) -> Option<i64> {
        Some(flat(a, b))
    }
}

const REACH: i64 = 1_300_000;

fn node() -> Id {
    Id::new(replica::ids::Scope([0xc1; 16]), 1).expect("an id")
}

fn target(x: i64) -> Target {
    Target::new(node(), Vec3::new(x, 0, 0))
}

#[test]
fn a_point_a_body_can_stand_on_is_its_own_place() {
    let mut g = Block { half: 1_000_000 };
    let t = target(2_000_000);
    assert_eq!(within(&mut g, t, REACH, None), Some(t.point()));
}

#[test]
fn a_point_with_no_room_is_acted_at_from_the_nearest_place_within_reach_on_the_askers_side() {
    let mut g = Block { half: 1_000_000 };
    let t = target(0);
    for side in [1, -1] {
        let from = Some((node(), Vec3::new(side * 5_000_000, 0, 0)));
        let p = within(&mut g, t, REACH, from).expect("a place within reach");
        assert!(g.stand(node(), p).is_some(), "a body stands there: {p:?}");
        assert!(flat(p, t.point()) <= REACH, "within reach: {p:?}");
        assert!(p.x * side > 1_000_000, "on the asker's side: {p:?}");
        assert_eq!(
            within(&mut g, t, REACH, from),
            Some(p),
            "the same every time"
        );
    }
    // With no asker, by the gap alone: the first ring clear of the block.
    let p = within(&mut g, t, REACH, None).expect("a place within reach");
    assert!(
        (1_099_000..=1_100_000).contains(&flat(p, t.point())),
        "{p:?}"
    );
}

#[test]
fn a_point_with_no_place_within_reach_has_none() {
    let mut g = Block { half: 1_400_000 };
    let from = Some((node(), Vec3::new(5_000_000, 0, 0)));
    assert_eq!(within(&mut g, target(0), REACH, from), None);
    assert_eq!(within(&mut g, target(0), REACH, None), None);
}

#[test]
fn mixed_classes_share_physical_holders_across_different_candidate_keys() {
    struct Open;
    impl ClassGround for Open {
        fn stand(&self, _: Size, _: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
            Some((p, p))
        }
        fn passage(&self, _: Size, _: Id, _: Vec3) -> bool {
            false
        }
        fn walk(&mut self, _: Size, _: Id, a: Vec3, _: Id, b: Vec3) -> Option<i64> {
            Some(flat(a, b))
        }
    }
    let id = |n| Id::new(replica::ids::Scope([0x65; 16]), n).unwrap();
    let ask = |n| Ask {
        who: id(n),
        order: id(n + 100),
        node: node(),
        from: Vec3::new(-5_000_000, 0, 0),
        target: target(0),
    };
    let asks = vec![
        (ask(1), Size::Giant),
        (ask(2), Size::Giant),
        (ask(3), Size::Small),
        (ask(4), Size::Standard),
    ];
    let mut spots = Spots::new();
    spots.write_sized(&mut Open, &asks, 0).unwrap();
    for (i, (a, sa)) in asks.iter().enumerate() {
        let pa = spots.of(a.who, &a.target).unwrap().unwrap();
        for (b, sb) in &asks[i + 1..] {
            let pb = spots.of(b.who, &b.target).unwrap().unwrap();
            let clearance = (sa.radius_mm() + sb.radius_mm() + 140) * 1000;
            assert!(
                flat(pa, pb) >= clearance,
                "mixed footprints cannot share a physical spot"
            );
        }
    }
    let before: Vec<_> = asks
        .iter()
        .map(|(a, _)| spots.of(a.who, &a.target))
        .collect();
    spots.invalidate_geometry();
    spots.write_sized(&mut Open, &asks, 1).unwrap();
    assert_eq!(
        asks.iter()
            .map(|(a, _)| spots.of(a.who, &a.target))
            .collect::<Vec<_>>(),
        before,
        "cache rebuild preserves the one physical reservation set"
    );
}

/// Open ground beyond 1 m of the origin, and a pocket within 0.2 m of it that no walk from outside reaches: the ground
/// under a school desk, walled in by its legs and the chairs round it (#4072).
struct Pocket;

impl Pocket {
    fn inner(p: Vec3) -> bool {
        flat(p, Vec3::ZERO) < 200_000
    }
}

impl Ground for Pocket {
    fn stand(&self, _: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        (Pocket::inner(p) || flat(p, Vec3::ZERO) > 1_000_000).then_some((p, p))
    }
    fn passage(&self, _: Id, _: Vec3) -> bool {
        false
    }
    fn walk(&mut self, _: Id, a: Vec3, _: Id, b: Vec3) -> Option<i64> {
        (Pocket::inner(a) == Pocket::inner(b)).then(|| flat(a, b))
    }
}

#[test]
fn a_point_in_a_pocket_no_walk_reaches_is_acted_at_from_a_place_within_reach_the_walk_reaches() {
    let mut g = Pocket;
    let t = target(0);
    let from = Vec3::new(5_000_000, 0, 0);
    let p = within(&mut g, t, REACH, Some((node(), from))).expect("a place within reach");
    assert!(!Pocket::inner(p) && g.stand(node(), p).is_some(), "{p:?}");
    assert!(flat(p, t.point()) <= REACH, "within reach: {p:?}");
    assert!(g.walk(node(), from, node(), p).is_some(), "reached: {p:?}");
    // From inside the pocket, and with no asker, the point is its own place, as before.
    let inside = Some((node(), Vec3::new(100_000, 0, 0)));
    assert_eq!(within(&mut g, t, REACH, inside), Some(t.point()));
    assert_eq!(within(&mut g, t, REACH, None), Some(t.point()));
}

#[test]
fn a_walker_sent_to_a_point_in_a_pocket_is_granted_the_nearest_place_beside_it() {
    let id = |n| Id::new(replica::ids::Scope([0x66; 16]), n).unwrap();
    let ask = |n, x| Ask {
        who: id(n),
        order: id(n + 100),
        node: node(),
        from: Vec3::new(x, 0, 0),
        target: target(0),
    };
    let (a, b) = (ask(1, 5_000_000), ask(2, -5_000_000));
    let mut spots = Spots::new();
    spots.write(&mut Pocket, &[a, b], 0).unwrap();
    for w in [a, b] {
        let p = spots
            .of(w.who, &w.target)
            .expect("an answer")
            .expect("a place, not spot-none-free");
        assert!(!Pocket::inner(p), "outside the pocket: {p:?}");
        assert!(Pocket.walk(node(), w.from, node(), p).is_some());
        assert_eq!(
            p.x.signum(),
            w.from.x.signum(),
            "on the walker's side: {p:?}"
        );
        assert!(flat(p, Vec3::ZERO) <= 2 * PITCH, "beside the point: {p:?}");
    }
}

/// A 4 m bench (#4072 follow-up) against a wall: no standing behind it (z below -0.6 m), on it or within 0.2 m of it
/// (|x| up to 2.2 m, |z| up to 0.6 m), nor in front of its middle, where a row of stools stands (|x| below 1.5 m, z
/// up to 2 m). Every walk is straight.
struct Bench;

impl Ground for Bench {
    fn stand(&self, _: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        let behind = p.z < -600_000;
        let on = p.x.abs() <= 2_200_000 && p.z.abs() <= 600_000;
        let stools = p.x.abs() < 1_500_000 && p.z <= 2_000_000;
        (!behind && !on && !stools).then_some((p, p))
    }
    fn passage(&self, _: Id, _: Vec3) -> bool {
        false
    }
    fn walk(&mut self, _: Id, a: Vec3, _: Id, b: Vec3) -> Option<i64> {
        Some(flat(a, b))
    }
}

/// The footprint of a box `x` by `z` µm round the origin.
fn box_ring(x: i64, z: i64) -> [Vec3; 4] {
    let c = |u: i64, v: i64| Vec3::new(u, 0, v);
    [c(-x, -z), c(x, -z), c(x, z), c(-x, z)]
}

#[test]
fn a_long_thing_whose_middle_is_out_of_reach_is_acted_at_from_beside_its_outline() {
    let mut g = Bench;
    let ring = box_ring(2_000_000, 400_000);
    let t = target(0);
    for side in [1, -1] {
        let from = Some((node(), Vec3::new(side * 8_000_000, 0, 3_000_000)));
        // By its middle, nothing is within reach: the stools stand before it and the wall behind it.
        assert_eq!(within(&mut g, t, REACH, from), None);
        let p = within_footprint(&mut g, t, &ring, REACH, from).expect("a place by its outline");
        assert!(g.stand(node(), p).is_some(), "a body stands there: {p:?}");
        assert!(
            to_outline(p, &ring) <= 300_000,
            "close by the outline: {p:?}"
        );
        assert!(p.x * side >= 1_500_000, "at the asker's end: {p:?}");
        assert_eq!(
            within_footprint(&mut g, t, &ring, REACH, from),
            Some(p),
            "the same every time"
        );
    }
}

#[test]
fn a_thing_is_acted_at_from_the_place_by_its_outline_on_the_askers_side() {
    let mut g = Block { half: 1_000_000 };
    let ring = box_ring(1_000_000, 1_000_000);
    for side in [1, -1] {
        let from = Some((node(), Vec3::new(side * 5_000_000, 0, 0)));
        let p = within_footprint(&mut g, target(0), &ring, REACH, from).expect("a place");
        assert!(p.x * side > 1_000_000, "on the asker's side: {p:?}");
        assert_eq!(
            to_outline(p, &ring),
            REACH_PITCH,
            "a pitch out from it: {p:?}"
        );
    }
    // With no asker, by the gap alone: a place a pitch out from the outline.
    let p = within_footprint(&mut g, target(0), &ring, REACH, None).expect("a place");
    assert_eq!(to_outline(p, &ring), REACH_PITCH, "{p:?}");
}

#[test]
fn a_thing_with_no_place_within_reach_of_its_outline_has_none() {
    let mut g = Block { half: 1_400_000 };
    let ring = box_ring(50_000, 50_000);
    let from = Some((node(), Vec3::new(5_000_000, 0, 0)));
    assert_eq!(
        within_footprint(&mut g, target(0), &ring, REACH, from),
        None
    );
    assert_eq!(
        within_footprint(&mut g, target(0), &ring, REACH, None),
        None
    );
}

#[test]
fn a_footprint_is_the_box_of_its_entrys_bounds_round_its_origin() {
    let entry = replica::rules::json::parse(r#"{"geometry": {"bounds_mm": [1770, 1500, 795]}}"#)
        .expect("json");
    let (corners, height) = footprint(&entry).expect("a footprint");
    assert_eq!(corners, box_ring(885_000, 397_500));
    assert_eq!(height, 1_500_000);
    let none = replica::rules::json::parse(r#"{"geometry": {}}"#).expect("json");
    assert_eq!(footprint(&none), None);
    // Inside the outline is no gap; outside, the gap to its nearest edge or corner.
    let ring = box_ring(1_000_000, 500_000);
    assert_eq!(to_outline(Vec3::new(300_000, 0, -200_000), &ring), 0);
    assert_eq!(to_outline(Vec3::new(1_300_000, 0, 0), &ring), 300_000);
    assert_eq!(to_outline(Vec3::new(1_300_000, 0, 900_000), &ring), 500_000);
}
