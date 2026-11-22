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
