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

/// 0.133 Q1: a walk to the middle of a pond wider than the rings (no standing within 10 m) has places on the first
/// ring past it that has any, its bank; one with none out to [`OVERFLOW`] still has none.
#[test]
fn a_target_wider_than_the_rings_has_places_on_its_nearest_bank() {
    let pond = Block { half: 10_000_000 };
    let tb = Table::new(&pond, target(0));
    assert!(!tb.places.is_empty(), "places on the bank");
    let nearest = tb
        .places
        .iter()
        .map(|p| flat(p.at, Vec3::ZERO))
        .min()
        .expect("a place");
    assert!(
        (10_000_000..=10_000_000 + 2 * PITCH).contains(&nearest),
        "{nearest}"
    );
    assert!(tb.places.iter().all(|p| pond.stand(node(), p.at).is_some()));
    assert!(
        tb.places.iter().all(|p| i64::from(p.ring) > RINGS),
        "only past the rings"
    );
    let sea = Block {
        half: OVERFLOW + PITCH,
    };
    assert!(
        Table::new(&sea, target(0)).places.is_empty(),
        "none out to the overflow's reach"
    );
    // a target with places on its rings keeps exactly those
    let lawn = Block { half: 1_000_000 };
    assert!(
        Table::new(&lawn, target(0))
            .places
            .iter()
            .all(|p| i64::from(p.ring) <= RINGS)
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

/// [`Block`] whose start, as the town's (`Map::spot_near` within the walk's 20 mm), is the block's nearest edge for a
/// point no more than 20 mm inside it; and a walk only from where a body stands.
struct Edged(Block);

impl Ground for Edged {
    fn stand(&self, n: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        self.0.stand(n, p)
    }
    fn passage(&self, _: Id, _: Vec3) -> bool {
        false
    }
    fn walk(&mut self, n: Id, a: Vec3, m: Id, b: Vec3) -> Option<i64> {
        self.stand(n, a)?;
        self.0.walk(n, a, m, b)
    }
    fn start(&self, n: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        self.stand(n, p).or_else(|| {
            let h = self.0.half;
            (p.x.abs() <= h && p.z.abs() <= h && h - p.x.abs() <= 20_000).then(|| {
                let q = Vec3::new(p.x.signum() * (h + 1), p.y, p.z);
                (q, q)
            })
        })
    }
}

/// The 0.137 trial: a body pressed on a stump's edge, its centre a hair inside the stump's cut, was refused every walk
/// `spot-none-free` (where it stood is no standing point), though its walk leaves from the edge beside it. Its ask
/// now leaves from there and is granted; a body further in is refused as before.
#[test]
fn an_asker_a_hair_off_the_ground_leaves_from_the_edge_beside_it() {
    let mut g = Edged(Block { half: 1_000_000 });
    let id = |n| Id::new(replica::ids::Scope([0x69; 16]), n).unwrap();
    let t = target(5_000_000);
    let ask = |from| Ask {
        who: id(1),
        order: id(2),
        node: node(),
        from,
        target: t,
        carried: false,
    };
    let pressed = Vec3::new(999_500, 0, 0);
    assert!(g.stand(node(), pressed).is_none(), "not a standing point");
    let mut spots = Spots::new();
    spots.write(&mut g, &[ask(pressed)], 0).unwrap();
    assert_eq!(spots.of(id(1), &t), Some(Ok(t.point())), "granted");
    let inside = Vec3::new(500_000, 0, 0);
    let mut spots = Spots::new();
    spots.write(&mut g, &[ask(inside)], 0).unwrap();
    assert_eq!(spots.of(id(1), &t), Some(Err("spot-none-free")));
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
        let p =
            within_footprint(&mut g, t, &ring, false, REACH, from).expect("a place by its outline");
        assert!(g.stand(node(), p).is_some(), "a body stands there: {p:?}");
        assert!(
            to_outline(p, &ring) <= 400_000,
            "close by the outline: {p:?}"
        );
        assert!(p.x * side >= 1_500_000, "at the asker's end: {p:?}");
        assert_eq!(
            within_footprint(&mut g, t, &ring, false, REACH, from),
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
        let p = within_footprint(&mut g, target(0), &ring, false, REACH, from).expect("a place");
        assert!(p.x * side > 1_000_000, "on the asker's side: {p:?}");
        assert_eq!(
            to_outline(p, &ring),
            REACH_PITCH,
            "a pitch out from it: {p:?}"
        );
    }
    // With no asker, by the gap alone: a place a pitch out from the outline.
    let p = within_footprint(&mut g, target(0), &ring, false, REACH, None).expect("a place");
    assert_eq!(to_outline(p, &ring), REACH_PITCH, "{p:?}");
}

#[test]
fn a_thing_with_no_place_within_reach_of_its_outline_has_none() {
    let mut g = Block { half: 1_400_000 };
    let ring = box_ring(50_000, 50_000);
    let from = Some((node(), Vec3::new(5_000_000, 0, 0)));
    assert_eq!(
        within_footprint(&mut g, target(0), &ring, false, REACH, from),
        None
    );
    assert_eq!(
        within_footprint(&mut g, target(0), &ring, false, REACH, None),
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

#[test]
fn a_walk_to_be_at_a_walkable_thing_ends_on_it_near_the_asker_and_others_beside_it() {
    // Open ground everywhere: a rug 3 m by 2 m round the origin, the asker 5 m east.
    let mut g = Block { half: -1 };
    let ring = box_ring(1_500_000, 1_000_000);
    let from = Some((node(), Vec3::new(5_000_000, 0, 0)));
    let on = within_footprint(&mut g, target(0), &ring, true, REACH, from).expect("on it");
    assert_eq!(to_outline(on, &ring), 0, "inside its outline: {on:?}");
    let depth = ring
        .iter()
        .zip(ring.iter().cycle().skip(1))
        .map(|(a, b)| to_segment(on, *a, *b))
        .min()
        .unwrap();
    assert!(depth >= ON_DEPTH, "a body's width in from its edge: {on:?}");
    assert!(on.x > 0, "on the asker's side: {on:?}");
    // Not walkable: by its near edge, not on it.
    let by = within_footprint(&mut g, target(0), &ring, false, REACH, from).expect("by it");
    assert_eq!(by.x, 1_500_000, "on its east edge: {by:?}");
}

/// Open ground that counts the places it is asked about.
struct Counting(std::cell::Cell<u64>);

impl Ground for Counting {
    fn stand(&self, _: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        self.0.set(self.0.get() + 1);
        Some((p, p))
    }
    fn passage(&self, _: Id, _: Vec3) -> bool {
        false
    }
    fn walk(&mut self, _: Id, a: Vec3, _: Id, b: Vec3) -> Option<i64> {
        Some(flat(a, b))
    }
}

#[test]
fn the_places_tried_round_an_outline_do_not_grow_with_its_size() {
    let bands = REACH / REACH_PITCH + 1;
    for half in [400_000, 18_000_000, 100_000_000] {
        for on in [false, true] {
            let mut g = Counting(std::cell::Cell::new(0));
            let ring = box_ring(half, half / 2);
            let from = Some((node(), Vec3::new(half + 5_000_000, 0, 0)));
            let p = within_footprint(&mut g, target(0), &ring, on, REACH, from).expect("a place");
            // The asker's own place, then at most a band's places (and one per edge for the ends) on each band.
            let most = 1 + 2 * bands * (BAND_PLACES + 4);
            assert!(
                g.0.get() <= most as u64,
                "{half} µm: {} places tried",
                g.0.get()
            );
            assert!(p.x > 0, "on the asker's side: {p:?}");
        }
    }
}

#[test]
fn a_thing_is_walkable_when_a_place_a_floor_to_stand_on_a_step_high_or_stood_on_inside() {
    let j = |t: &str| replica::rules::json::parse(t).expect("json");
    assert!(walkable(&j(r#"{"owner": "place"}"#)), "a deck");
    // A mat: no taller than a step.
    assert!(
        walkable(&j(
            r#"{"owner": "thing", "geometry": {"bounds_mm": [3000, 20, 2000]}}"#
        )),
        "a mat"
    );
    // A dance floor's area allows standing.
    assert!(
        walkable(&j(
            r#"{"owner": "thing", "geometry": {"bounds_mm": [4000, 400, 4000]},
                "areas": {"top": {"allows": {"stand": "on"}}}}"#
        )),
        "an area to stand on"
    );
    // A stage: its spots stand inside its outline.
    assert!(
        walkable(&j(
            r#"{"owner": "thing", "geometry": {"bounds_mm": [8040, 4940, 5640]},
                "slots": {"spot_1": {"admits": "body", "at_mm": [-3150, 940, 1800]}}}"#
        )),
        "a stage"
    );
    // A bed: its mattress allows lying and sitting only, and it is taller than a step.
    assert!(
        !walkable(&j(
            r#"{"owner": "thing", "geometry": {"bounds_mm": [1000, 600, 2100]},
                "areas": {"mattress": {"allows": {"lie": "on", "sit": "edge"}}}}"#
        )),
        "a bed"
    );
    // A pool table: its players' standing slots lie outside its outline.
    assert!(
        !walkable(&j(
            r#"{"owner": "thing", "geometry": {"bounds_mm": [2700, 800, 1500]},
                "slots": {"player_1": {"admits": "body", "at_mm": [0, 0, 1200]}}}"#
        )),
        "a pool table"
    );
    assert!(
        !walkable(&j(
            r#"{"owner": "thing", "geometry": {"bounds_mm": [600, 900, 600]},
                "slots": {"rest": {"admits": "body", "posture": "sit", "at_mm": [0, 450, 0]}}}"#
        )),
        "a chair"
    );
    assert!(
        !walkable(&j(
            r#"{"owner": "thing", "geometry": {"bounds_mm": [1770, 1500, 795]}}"#
        )),
        "a workbench"
    );
    assert!(
        !walkable(&j(
            r#"{"owner": "thing", "geometry": {"bounds_mm": [200, 80, 200]}}"#
        )),
        "a bowl"
    );
}

/// 0.133 A2-5: a thing's deck (node 1) with room for one body at its middle, on open ground (node 2) where none
/// stands within 1 m of the middle (under the deck), or, `bare`, within 16 m of it, nor within 0.3 m of `hole`.
/// Walks are straight, except: with `river`, none crosses x = 10 m; with `wall`, one that crosses x = 3 m goes 40 m
/// round.
#[derive(Default)]
struct Deck {
    bare: bool,
    river: bool,
    wall: bool,
    hole: Option<Vec3>,
}

fn deck() -> Id {
    Id::new(replica::ids::Scope([0xa5; 16]), 1).expect("an id")
}

fn open_ground() -> Id {
    Id::new(replica::ids::Scope([0xa5; 16]), 2).expect("an id")
}

impl Ground for Deck {
    fn stand(&self, n: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        let r = flat(p, Vec3::ZERO);
        let ok = if n == deck() {
            r < 400_000
        } else {
            r > if self.bare { 16_000_000 } else { 1_000_000 }
                && self.hole.is_none_or(|h| flat(h, p) > 300_000)
        };
        ok.then_some((p, p))
    }
    fn passage(&self, _: Id, _: Vec3) -> bool {
        false
    }
    fn walk(&mut self, _: Id, a: Vec3, _: Id, b: Vec3) -> Option<i64> {
        let across = |x: i64| (a.x > x) != (b.x > x);
        if self.river && across(10_000_000) {
            return None;
        }
        Some(
            flat(a, b)
                + if self.wall && across(3_000_000) {
                    40_000_000
                } else {
                    0
                },
        )
    }
    fn overflow_at(&self, n: Id, p: Vec3) -> Vec<(Id, Vec3)> {
        if n == deck() {
            vec![(open_ground(), p)]
        } else {
            Vec::new()
        }
    }
}

/// The tables' passes over `asks` from `at` until each is answered: a burst of overflow asks is answered at most
/// `OVERFLOW_EACH` a pass.
fn passes(spots: &mut Spots, g: &mut Deck, asks: &[Ask], at: Micros) {
    for k in 0..20 {
        spots.write(g, asks, at + k).unwrap();
        if asks
            .iter()
            .all(|a| spots.granted(a.who, &a.target).is_some())
        {
            return;
        }
    }
    panic!("not every ask answered in 20 passes");
}

fn granted_all(spots: &Spots, asks: &[Ask]) -> Vec<Option<Granted>> {
    asks.iter()
        .map(|a| spots.granted(a.who, &a.target).and_then(Result::ok))
        .collect()
}

fn deck_asks(n: u64) -> Vec<Ask> {
    let id = |k| Id::new(replica::ids::Scope([0xa6; 16]), k).unwrap();
    (0..n)
        .map(|k| Ask {
            who: id(1 + k),
            order: id(100 + k),
            node: open_ground(),
            from: Vec3::new(20_000_000, 0, k as i64 * 1_000_000),
            target: Target::new(deck(), Vec3::ZERO),
            carried: false,
        })
        .collect()
}

/// A2-5: the deck's one place held, the others sent to it are granted overflow points on the open ground round it,
/// nearest first, each its own and a body's room apart; released like any place when their orders end.
#[test]
fn a2_5_a_full_place_overflows_onto_the_ground_round_it() {
    let mut g = Deck::default();
    let asks = deck_asks(8);
    let mut spots = Spots::new();
    // One pass answers the deck's own place and at most OVERFLOW_EACH overflow points; the rest wait, unrefused.
    spots.write(&mut g, &asks, 0).unwrap();
    let first = asks
        .iter()
        .filter(|a| spots.granted(a.who, &a.target).is_some())
        .count();
    assert_eq!(first, 1 + OVERFLOW_EACH, "a burst spread over passes");
    assert!(
        asks.iter()
            .all(|a| !matches!(spots.granted(a.who, &a.target), Some(Err(_))))
    );
    passes(&mut spots, &mut g, &asks, 1);
    let got: Vec<Granted> = asks
        .iter()
        .map(|a| {
            spots
                .granted(a.who, &a.target)
                .expect("answered")
                .expect("granted")
        })
        .collect();
    println!("A2-5 overflow: {got:?}");
    assert_eq!(
        (got[0].node, got[0].at, got[0].overflow),
        (deck(), Vec3::ZERO, false),
        "the first on the deck"
    );
    for (i, g) in got.iter().enumerate().skip(1) {
        assert!(
            g.overflow && g.node == open_ground(),
            "an overflow point: {g:?}"
        );
        let r = flat(g.at, Vec3::ZERO);
        assert!(
            r > 1_000_000 && r <= 3 * PITCH + 1,
            "nearest first, round the deck: {r} µm"
        );
        for h in &got[..i] {
            assert!(
                flat(g.at, h.at) >= 690_000,
                "a body's room apart: {g:?} {h:?}"
            );
        }
    }
    // Their orders end: every place is released.
    spots.write(&mut g, &[], 1).unwrap();
    let released = spots
        .record
        .iter()
        .filter(|e| {
            matches!(
                e,
                Entry::Release {
                    why: "order-ended",
                    ..
                }
            )
        })
        .count();
    assert_eq!(released, 8, "all released");
    assert!(spots.held.is_empty());
}

/// A2-5: with no standing point on the ground within `OVERFLOW` of the place, the overflow is refused, `spot-none-free`.
#[test]
fn a2_5_no_ground_round_a_full_place_is_refused() {
    let mut g = Deck {
        bare: true,
        ..Deck::default()
    };
    let asks = deck_asks(2);
    let mut spots = Spots::new();
    passes(&mut spots, &mut g, &asks, 0);
    assert!(matches!(
        spots.granted(asks[0].who, &asks[0].target),
        Some(Ok(_))
    ));
    assert_eq!(
        spots.granted(asks[1].who, &asks[1].target),
        Some(Err("spot-none-free"))
    );
}

/// A2-5 (review of #4399): a target the asker cannot reach at all is no crowd: refused `spot-none-free`, never granted
/// an overflow point on its own side of the river.
#[test]
fn a2_5_an_unreachable_place_does_not_overflow() {
    let mut g = Deck {
        river: true,
        ..Deck::default()
    };
    let asks = deck_asks(1);
    let mut spots = Spots::new();
    passes(&mut spots, &mut g, &asks, 0);
    assert_eq!(
        spots.granted(asks[0].who, &asks[0].target),
        Some(Err("spot-none-free"))
    );
}

/// A2-5 (review of #4399): an overflow point is joined on foot to the place. With a wall at x = 3 m between the deck
/// and the askers (who come round it), no point beyond the wall is granted, though the walk to one is shortest.
#[test]
fn a2_5_no_overflow_point_behind_a_wall() {
    let mut g = Deck {
        wall: true,
        ..Deck::default()
    };
    let asks = deck_asks(30);
    let mut spots = Spots::new();
    passes(&mut spots, &mut g, &asks, 0);
    let got = granted_all(&spots, &asks);
    let over: Vec<Granted> = got
        .iter()
        .flatten()
        .filter(|g| g.overflow)
        .copied()
        .collect();
    println!(
        "A2-5 behind a wall: {} overflow points, x at most {:?}",
        over.len(),
        over.iter().map(|g| g.at.x).max()
    );
    assert_eq!(got.iter().flatten().count(), 30, "all granted");
    assert!(
        over.len() == 29 && over.iter().all(|g| g.at.x < 3_000_000),
        "none behind the wall"
    );
}

/// A2-5 (review of #4399): released on retarget (`spot-left`) like any place; across a change of the ground the
/// holders keep their points, and one whose point the change took away is released, named to the runner, and granted
/// another, never one a body holds.
#[test]
fn a2_5_overflow_points_are_released_on_retarget_and_kept_across_a_ground_change() {
    let mut g = Deck::default();
    let mut asks = deck_asks(8);
    let mut spots = Spots::new();
    passes(&mut spots, &mut g, &asks, 0);
    let before = granted_all(&spots, &asks);
    assert!(before[3].is_some_and(|b| b.overflow));
    // The ground changes under the fourth: its point is a hole now.
    g.hole = Some(before[3].unwrap().at);
    spots.invalidate_geometry();
    passes(&mut spots, &mut g, &asks, 100);
    assert_eq!(
        spots.revoked(),
        vec![asks[3].who],
        "the fourth is named to the runner"
    );
    let after = granted_all(&spots, &asks);
    for k in (0..8).filter(|k| *k != 3) {
        assert_eq!(after[k], before[k], "kept its point: {k}");
    }
    let new = after[3].expect("granted again");
    assert!(new.overflow && new.at != before[3].unwrap().at);
    assert!(
        after.iter().flatten().filter(|g| g.at == new.at).count() == 1,
        "a point no other body holds"
    );
    // A newcomer gets a point of its own too.
    let mut more = deck_asks(9);
    passes(&mut spots, &mut g, &more, 200);
    let all = granted_all(&spots, &more);
    let n = all[8].expect("the newcomer is granted");
    assert!(
        all[..8]
            .iter()
            .flatten()
            .all(|g| flat(g.at, n.at) >= 690_000)
    );
    // The second retargets: its overflow point is released, `spot-left`.
    more[1].target = Target::new(open_ground(), Vec3::new(-30_000_000, 0, 0));
    asks = more;
    spots.write(&mut g, &asks, 3).unwrap();
    assert!(spots.record.iter().any(|e| matches!(
        e,
        Entry::Release { who, why: "spot-left", .. } if *who == asks[1].who
    )));
}

/// A cottage's kitchen west of a doorway (#5003's Eden audit): its table, chairs and counter leave no standing west of
/// x = -1 m. The doorway's passage runs from x = -1 m to 1 m: its mouth on the kitchen's side (x up to -0.3 m), the
/// doorway itself east of that. East of x = 1 m is the living room; with `room`, also a strip of kitchen floor at
/// z from 1.2 m to 1.6 m, clear of the doorway. Every walk is straight.
struct Kitchen {
    room: bool,
}

impl Ground for Kitchen {
    fn stand(&self, _: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        let strip = self.room && (1_200_000..=1_600_000).contains(&p.z);
        (p.x > -1_000_000 || strip).then_some((p, p))
    }
    fn passage(&self, _: Id, p: Vec3) -> bool {
        p.x > -1_000_000 && p.x < 1_000_000
    }
    fn mouth(&self, n: Id, p: Vec3) -> bool {
        self.passage(n, p) && p.x <= -300_000
    }
    fn walk(&mut self, _: Id, a: Vec3, _: Id, b: Vec3) -> Option<i64> {
        Some(flat(a, b))
    }
}

#[test]
fn a_thing_whose_room_has_floor_only_by_its_doorway_is_acted_at_from_the_doorways_mouth() {
    let mut g = Kitchen { room: false };
    // A bowl on the table, 1.2 m west of the doorway's mouth.
    let t = target(-1_500_000);
    let ring = box_ring(150_000, 150_000);
    let from = Some((node(), Vec3::new(5_000_000, 0, 0)));
    for p in [
        within_footprint(&mut g, t, &ring, false, REACH, from).expect("a place by the outline"),
        within(&mut g, t, REACH, from).expect("a place by the middle"),
    ] {
        assert!(g.mouth(node(), p), "at the doorway's mouth: {p:?}");
        assert!(p.x <= -300_000, "never in the doorway itself: {p:?}");
        assert!(to_outline(p, &ring) <= REACH, "within reach: {p:?}");
    }
    // A mouth is a walker's only: with no asker, by the gap alone, none.
    assert_eq!(within_footprint(&mut g, t, &ring, false, REACH, None), None);
    assert_eq!(within(&mut g, t, REACH, None), None);
    // Floor clear of the doorway within reach is taken first, though the mouth is nearer the asker.
    let mut g = Kitchen { room: true };
    let p = within_footprint(&mut g, t, &ring, false, REACH, from).expect("a place");
    assert!(!g.passage(node(), p), "clear of the doorway: {p:?}");
    // The spot tables never give a mouth: a plain walk there is granted a place clear of every passage.
    let mut g = Kitchen { room: false };
    let mut spots = Spots::new();
    let ask = Ask {
        who: node(),
        order: node(),
        node: node(),
        from: Vec3::new(5_000_000, 0, 0),
        target: t,
        carried: false,
    };
    spots.write(&mut g, &[ask], 0).unwrap();
    let granted = spots.of(node(), &t).expect("answered").expect("granted");
    assert!(!g.passage(node(), granted), "{granted:?}");
}
