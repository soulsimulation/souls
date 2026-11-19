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
