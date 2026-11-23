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
        carried: false,
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
        carried: false,
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

/// Standable everywhere, but an island within 8 m of the origin no walk from outside reaches (a floor with no way up),
/// counting the walks that find no way: each would be a route search over the asker's whole part. With `knows`, it
/// tells a place cut off without a walk ([`Ground::may_reach`], as the town's map parts do).
struct Island {
    knows: bool,
    misses: usize,
}

fn on_island(p: Vec3) -> bool {
    flat(p, Vec3::ZERO) < 8_000_000
}

impl Ground for Island {
    fn stand(&self, _: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        Some((p, p))
    }
    fn passage(&self, _: Id, _: Vec3) -> bool {
        false
    }
    fn walk(&mut self, _: Id, a: Vec3, _: Id, b: Vec3) -> Option<i64> {
        let w = (on_island(a) == on_island(b)).then(|| flat(a, b));
        self.misses += usize::from(w.is_none());
        w
    }
    fn may_reach(&self, _: Id, a: Vec3, _: Id, b: Vec3) -> bool {
        !self.knows || on_island(a) == on_island(b)
    }
}

/// #4072's review: a standable target the asker's walk does not reach costs a bounded number of failed walks, not one
/// per place round it (about 570 within reach, 345 in a table): none past the first when the ground can tell, at most
/// [`MISSES_MOST`] per pass when it cannot. It answers as before: the point itself for a form's walk,
/// `spot-none-free` for a plain one.
#[test]
fn a_target_cut_off_from_the_asker_answers_after_a_bounded_number_of_walks() {
    let from = Vec3::new(20_000_000, 0, 0);
    let t = target(0);
    let id = |n| Id::new(replica::ids::Scope([0x67; 16]), n).unwrap();
    for (knows, most_within, most_grant) in
        [(false, MISSES_MOST + 1, 2 * MISSES_MOST + 1), (true, 1, 1)]
    {
        let mut g = Island { knows, misses: 0 };
        assert_eq!(
            within(&mut g, t, REACH, Some((node(), from))),
            Some(t.point())
        );
        assert!(
            g.misses <= most_within,
            "within ({knows}): {} walks found no way",
            g.misses
        );
        let mut g = Island { knows, misses: 0 };
        let ask = Ask {
            who: id(1),
            order: id(2),
            node: node(),
            from,
            target: t,
            carried: false,
        };
        let mut spots = Spots::new();
        spots.write(&mut g, &[ask], 0).unwrap();
        assert_eq!(spots.of(ask.who, &t), Some(Err("spot-none-free")));
        assert!(
            g.misses <= most_grant,
            "a grant ({knows}): {} walks found no way",
            g.misses
        );
    }
}

/// #4171: a walk sent while the world carries its body across a link (part way up a stair, on no floor's ground) is
/// not refused `spot-none-free` with every place free: its ask waits, unanswered, and is granted once the body has
/// landed. An asker off the ground and not carried is refused as before.
#[test]
fn an_ask_from_a_body_mid_crossing_waits_for_its_landing() {
    let mut g = Block { half: 1_000_000 };
    let id = |n| Id::new(replica::ids::Scope([0x68; 16]), n).unwrap();
    let t = target(5_000_000);
    let mid_stair = Vec3::new(0, 400_000, 0);
    let ask = |carried, from| Ask {
        who: id(1),
        order: id(2),
        node: node(),
        from,
        target: t,
        carried,
    };
    let mut spots = Spots::new();
    for tick in 0..3 {
        spots.write(&mut g, &[ask(true, mid_stair)], tick).unwrap();
        assert_eq!(spots.of(id(1), &t), None, "no answer while carried");
    }
    let landed = Vec3::new(2_000_000, 0, 0);
    spots.write(&mut g, &[ask(false, landed)], 3).unwrap();
    assert_eq!(
        spots.of(id(1), &t),
        Some(Ok(t.point())),
        "landed, it is granted the point"
    );
    let mut spots = Spots::new();
    spots.write(&mut g, &[ask(false, mid_stair)], 0).unwrap();
    assert_eq!(spots.of(id(1), &t), Some(Err("spot-none-free")));
}
