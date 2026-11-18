//! B2's checks (#2681): every move in the fixtures runs from data, phase by phase on timers; a move beyond reach is
//! refused by name with the distance; a later claim cancels a move. No move is named here: each check runs over every
//! fixture file.

use std::path::Path;

use replica::bodies::{Class, Family, SkillShape, Want};
use replica::effects::fixture_bytes;
use replica::encode::{Name, Value, decode};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::{Frame, Quat, Vec3, fixture};

use super::{Fired, Moves, Reach, load};
use crate::controller::Controller;
use crate::ground::Piece;
use crate::mover::Surface;
use crate::timers::DueList;

const FAMILIES: &str = include_str!("../../../replica/fixtures/bodies/families.diag");

fn moves() -> Vec<Move> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/fixtures/moves");
    load(&dir).expect("the fixture moves")
}

/// The fixtures' two-handed, two-legged family.
fn family() -> Family {
    let v = decode(&fixture_bytes(FAMILIES).expect("bytes"))
        .expect("decodes")
        .value;
    let Value::Array(fs) = v else {
        panic!("a list")
    };
    fs.iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .find(|f| f.resources.iter().any(|r| r.class == Class::Manipulator))
        .expect("a family with hands")
}

/// A geometry whose every distance is the same.
struct Fixed(i64);

impl Reach for Fixed {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, _: Id, _: &Name) -> Option<i64> {
        Some(self.0)
    }
}

struct World {
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    body: Id,
    target: Id,
}

fn world() -> World {
    let ground_id = fixture(1);
    let corners = vec![
        [-5_000, 0, -5_000],
        [5_000, 0, -5_000],
        [5_000, 0, 5_000],
        [-5_000, 0, 5_000],
    ];
    let ground = Surface::new(
        ground_id,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: crate::gaits::Ground::Dry,
        }],
    );
    let mut mint = Minter::new(Scope([0xb2; 16]));
    let body = mint.mint().expect("id");
    let target = mint.mint().expect("id");
    let frame = Frame {
        node: ground_id,
        slot: None,
    };
    let placed = ground
        .place(body, frame, Vec3::ZERO, Quat::IDENTITY)
        .expect("placed");
    let mut c = Controller::new();
    c.add(family(), placed).expect("added");
    World {
        c,
        due: DueList::new(),
        mint,
        moves: Moves::new(),
        body,
        target,
    }
}

#[test]
fn every_move_runs_from_data_phase_by_phase() {
    let all = moves();
    assert_eq!(all.len(), 5, "five moves in the fixtures");
    for mv in &all {
        let mut w = world();
        let geo = Fixed(mv.reach);
        let n = w
            .moves
            .start(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &geo,
                w.body,
                mv,
                w.target,
                0,
            )
            .expect("started");
        let record = w.moves.record(n).expect("in progress").clone();
        assert!(!record.limbs.is_empty());
        let input = w.c.input(w.body).expect("a body");
        for limb in &record.limbs {
            assert_eq!(
                input.moves.get(limb),
                Some(&mv.name),
                "set on what it holds"
            );
        }
        // One timer at a time: the end of the phase in progress.
        let mut seen = Vec::new();
        while let Some(t) = w.due.fire(Micros::MAX) {
            assert_eq!(w.due.len(), 0);
            match w.moves.fire(&mut w.c, &mut w.due, &mut w.mint, &geo, &t) {
                Some(Fired::Phase { phase, .. }) => seen.push((t.due, phase)),
                Some(Fired::Done(r)) => {
                    assert_eq!(r.ended.as_ref().map(|e| e.how.as_str()), Some("done"));
                    assert_eq!(r.ended.as_ref().map(|e| e.at), r.ends.last().copied());
                    seen.push((t.due, mv.phases.len()));
                }
                other => panic!("{}: {other:?}", mv.name.as_str()),
            }
        }
        let want: Vec<_> = record.ends.iter().copied().zip(1..).collect();
        assert_eq!(
            seen,
            want,
            "{}: each phase ends on its own timer",
            mv.name.as_str()
        );
        assert!(w.moves.is_empty());
        assert!(
            w.c.claims(w.body).expect("a body").running().is_empty(),
            "released"
        );
        assert!(
            w.c.input(w.body).expect("a body").moves.is_empty(),
            "back to neutral"
        );
    }
}

type Micros = replica::time::Micros;

#[test]
fn a_move_beyond_reach_is_refused_with_the_distance() {
    for mv in moves() {
        let mut w = world();
        let far = mv.reach + 1;
        let r = w
            .moves
            .start(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &Fixed(far),
                w.body,
                &mv,
                w.target,
                0,
            )
            .expect_err("refused");
        assert_eq!(r.name, "out-of-reach");
        assert!(r.detail.contains(&format!("{far} µm")), "{r}");
        assert!(r.detail.starts_with(mv.name.as_str()), "{r}");
        println!("{r}");
        assert!(
            w.c.claims(w.body).expect("a body").running().is_empty(),
            "no claim made"
        );
        assert!(w.due.is_empty() && w.moves.is_empty());
    }
}

#[test]
fn a_later_claim_cancels_a_move_at_its_next_boundary() {
    for mv in moves() {
        let mut w = world();
        let geo = Fixed(0);
        w.moves
            .start(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &geo,
                w.body,
                &mv,
                w.target,
                0,
            )
            .expect("started");
        let class = match mv.claims[0] {
            Want::All(c) | Want::One(c) => c,
            Want::Named(_) => continue,
        };
        assert!(mv.cancelled_by.contains(&class));
        let other = SkillShape {
            name: Name::new("test:other").expect("a name"),
            claims: vec![Want::All(class)],
            blocks: vec![],
            cancelled_by: vec![],
        };
        w.c.claim(w.body, &other).expect("the later claim wins");
        let t = w.due.fire(Micros::MAX).expect("a timer");
        let Some(Fired::Cancelled(r)) = w.moves.fire(&mut w.c, &mut w.due, &mut w.mint, &geo, &t)
        else {
            panic!("cancelled")
        };
        let ended = r.ended.expect("ended");
        assert_eq!((ended.at, ended.how.as_str()), (t.due, "claim-taken"));
        assert!(w.due.is_empty() && w.moves.is_empty());
    }
}
