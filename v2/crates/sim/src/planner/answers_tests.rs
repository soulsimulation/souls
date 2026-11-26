//! Every planner question gets exactly one answer (S13d). A walk the planner cannot plan for the body's class is
//! refused by name. A walk the spot tables hold back on purpose (mid-stair, a crowd's overflow) waits and is answered,
//! never refused. A planner left behind by a failed install refuses by name. One body's panic refuses only its own
//! questions.
//!
//! `cargo test -p sim --lib planner::answers_tests -- --nocapture`.

use super::*;
use crate::links::Doors;
use crate::mover::Body;
use crate::spots::Target;
use crate::walk::{Mark, node_of};
use replica::encode::{Value, encode};
use replica::ids::Scope;
use replica::kinds::sizes::Size;
use replica::pose::{Frame, Quat};
use std::collections::BTreeMap;

fn id(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

/// N2's test world as a town.
fn town() -> Town {
    let w = testworld::generate(1, 0).expect("the test world");
    let im = import_eden::load(&w.text).expect("the world loads");
    let root = im.nodes["world"];
    let ground = im.nodes["ground"];
    let header = import_eden::header(root, &im.rules).unwrap();
    let next = im.tree.to_state().next;
    Town::new(im.tree, ground, Doors::new(header, im.rules, next)).expect("the town")
}

/// Body `who` standing on the open ground at the first place on a half-metre grid from `near` it can stand.
fn stand(t: &Town, who: Id, near: Vec3) -> Body {
    let node = t.ground;
    (0..400)
        .map(|k| {
            Vec3::new(
                near.x + (k % 20) * 500_000,
                near.y,
                near.z + (k / 20) * 500_000,
            )
        })
        .find_map(|at| {
            t.surfaces[&node]
                .place(who, Frame { node, slot: None }, at, Quat::IDENTITY)
                .ok()
        })
        .expect("a place to stand on the open ground")
}

const ORDER: u64 = 81_000;

fn key(body: Id, kind: FormKind) -> FormKey {
    FormKey {
        body,
        intent: id(ORDER),
        stage: 0,
        step: 0,
        kind,
    }
}

/// Each body's place near `to` (its mark asking for it when `ask`), its line toward `to`, and a form's walk and line.
fn wants(bodies: &[Body], to: Vec3, ask: bool, map: &Arc<crate::ground::Versions>) -> Wants {
    let target = |b: &Body| Target::new(node_of(b), to);
    Wants {
        marks: Some(
            bodies
                .iter()
                .map(|b| Mark {
                    who: b.id,
                    node: node_of(b),
                    at: b.pose.position,
                    waiting: None,
                    crossing: None,
                    carried: false,
                    staying: false,
                    spot: ask.then(|| (target(b), id(ORDER))),
                })
                .collect(),
        ),
        places: bodies.iter().map(|b| (*b, target(b), id(ORDER))).collect(),
        lines: bodies.iter().map(|b| (*b, to)).collect(),
        form_map: Some(Arc::clone(map)),
        forms: bodies
            .iter()
            .flat_map(|b| {
                [
                    FormQuestion {
                        key: key(b.id, FormKind::Walk),
                        generation: 1,
                        body: *b,
                        query: FormQuery::Walk {
                            node: node_of(b),
                            at: to,
                            reach: 0,
                            door: None,
                            ring: None,
                            aim: None,
                        },
                    },
                    FormQuestion {
                        key: key(b.id, FormKind::Line),
                        generation: 1,
                        body: *b,
                        query: FormQuery::Line { to },
                    },
                ]
            })
            .collect(),
        ..Wants::default()
    }
}

/// Every question `w` asks for `who` has an answer in `p`, stamped with the batch's map.
fn all_answered(w: &Wants, p: &Planned, who: Id) {
    assert!(Arc::ptr_eq(
        p.map.as_ref().unwrap(),
        w.form_map.as_ref().unwrap()
    ));
    assert_eq!(p.places.get(&who).map(|(o, _)| *o), Some(id(ORDER)));
    assert!(p.lines.contains_key(&who));
    for kind in [FormKind::Walk, FormKind::Line] {
        assert!(p.forms.contains_key(&key(who, kind)), "{kind:?} answered");
    }
}

fn walk_refusal(p: &Planned, who: Id) -> Option<&'static str> {
    match &p.forms[&key(who, FormKind::Walk)].result {
        FormResult::Walk(Err(r)) => Some(r.name),
        FormResult::Walk(Ok(_)) => None,
        FormResult::Line(_) => unreachable!(),
    }
}

/// A point 3 m along x from `a` that a body can stand on.
fn goal(t: &Town, a: &Body) -> Vec3 {
    stand(
        t,
        id(11),
        Vec3::new(a.pose.position.x + 3_000_000, 0, a.pose.position.z),
    )
    .pose
    .position
}

/// (1) A body whose class the planner has no geometry for: its form walk and its place are refused by that name in
/// the batch that asks, never left unanswered (before: `view_for` refused -> `continue`, and `spot` `None` for ever).
#[test]
fn a_walk_for_an_unprepared_class_is_refused_by_name() {
    let t = town();
    let a = stand(&t, id(10), Vec3::new(0, 0, 0));
    let to = goal(&t, &a);
    let map = Arc::new(t.versions.clone());
    let mut planner = Planner::new(t);
    let mut w = wants(&[a], to, true, &map);
    w.classes.insert(a.id, Size::Large);
    let p = planner.answer(&w);
    all_answered(&w, &p, a.id);
    assert_eq!(p.places[&a.id].1.as_ref().err(), Some(&UNPREPARED));
    assert_eq!(walk_refusal(&p, a.id), Some(UNPREPARED));
    println!("S13d (1): an unprepared class's walk and form walk: refused {UNPREPARED}");
}

/// (2a) A walk sent while its Soul is part way up a stair (#4171: the tables hold its ask back until it lands) waits
/// as long as the crossing lasts, here 40 batches, and is granted once it lands: never refused.
#[test]
fn a_walk_sent_mid_stair_waits_and_is_granted_on_landing() {
    let t = town();
    let a = stand(&t, id(10), Vec3::new(0, 0, 0));
    let to = goal(&t, &a);
    let map = Arc::new(t.versions.clone());
    let mut planner = Planner::new(t);
    let mut w = wants(&[a], to, true, &map);
    w.marks.as_mut().unwrap()[0].crossing = Some(id(99));
    for n in 0..40 {
        let p = planner.answer(&w);
        assert!(!p.places.contains_key(&a.id), "batch {n}: waits mid-stair");
        assert!(p.lines.contains_key(&a.id) && p.forms.len() == 2);
    }
    w.marks.as_mut().unwrap()[0].crossing = None;
    let p = planner.answer(&w);
    assert!(
        p.places[&a.id].1.is_ok(),
        "{:?}",
        p.places[&a.id].1.as_ref().err()
    );
    println!("S13d (2a): a walk sent mid-stair: waited 40 batches, granted on landing");
}

/// (2a') A walk sent while the world still carries its Soul off a seat (a rise's step off, no link): its mark asks
/// from the seat's point, which may be inside the bench, so it waits for the carry's end, as mid-stair, and is granted
/// once the body stands. Before, only a link's crossing waited and the walk was refused `spot-none-free`.
#[test]
fn a_walk_sent_while_stepping_off_a_seat_waits_and_is_granted_once_it_stands() {
    let t = town();
    let a = stand(&t, id(10), Vec3::new(0, 0, 0));
    let to = goal(&t, &a);
    let map = Arc::new(t.versions.clone());
    let mut planner = Planner::new(t);
    let mut w = wants(&[a], to, true, &map);
    w.marks.as_mut().unwrap()[0].carried = true;
    for n in 0..5 {
        let p = planner.answer(&w);
        assert!(
            !p.places.contains_key(&a.id),
            "batch {n}: waits while carried"
        );
    }
    w.marks.as_mut().unwrap()[0].carried = false;
    let p = planner.answer(&w);
    assert!(
        p.places[&a.id].1.is_ok(),
        "{:?}",
        p.places[&a.id].1.as_ref().err()
    );
}

/// (2b) A crowd at one target, more Souls than its own places (about 300 on its rings): those places fill, and at
/// least 100 Souls need overflow points at once, which the tables spread over passes (A2-5, `OVERFLOW_EACH` a pass).
/// Every Soul is answered, none refused.
#[test]
fn a_hundred_souls_needing_overflow_spots_at_once_are_all_answered() {
    const CROWD: u64 = 500;
    let t = town();
    let near = stand(&t, id(10), Vec3::new(0, 0, 0)).pose.position;
    let bodies: Vec<Body> = (0..CROWD)
        .map(|k| {
            let at = Vec3::new(
                near.x + i64::try_from(k % 25).unwrap() * 1_000_000,
                near.y,
                near.z + i64::try_from(k / 25).unwrap() * 1_000_000,
            );
            stand(&t, id(1_000 + k), at)
        })
        .collect();
    let to = Vec3::new(near.x + 12_000_000, near.y, near.z - 12_000_000);
    let to = stand(&t, id(11), to).pose.position;
    let map = Arc::new(t.versions.clone());
    let mut planner = Planner::new(t);
    let mut w = wants(&bodies, to, true, &map);
    w.lines.clear();
    w.forms.clear();
    let (mut granted, mut overflow, mut passes) = (BTreeMap::new(), 0, 0);
    while !w.places.is_empty() && passes < 400 {
        passes += 1;
        let p = planner.answer(&w);
        for (who, (_, placed)) in &p.places {
            let Ok((g, _, _)) = placed else {
                panic!("{who:?} refused {:?}", placed.as_ref().err());
            };
            overflow += usize::from(g.overflow);
            granted.insert(*who, passes);
        }
        // The clock asks again only the walks still waiting; every mark keeps its ask (a grant is held).
        w.places.retain(|(b, _, _)| !granted.contains_key(&b.id));
    }
    assert_eq!(granted.len(), bodies.len(), "every Soul answered");
    assert!(overflow >= 100, "{overflow} Souls needed overflow points");
    assert!(
        passes >= 100 / crate::spots::OVERFLOW_EACH,
        "spread over {passes} passes"
    );
    println!(
        "S13d (2b): {CROWD} Souls at one target, {overflow} on overflow points: all granted, none refused, in {passes} \
         passes"
    );
}

/// (3) While the planner is current, a batch on another map (one from before a change) is left for the clock to
/// drop. Once an install of a committed map fails, the planner is behind for good: every question on a map it does
/// not hold is refused `planner.map-stale` at once, stamped with the batch's map; a batch on its own map is still
/// answered.
#[test]
fn once_an_install_fails_questions_on_the_clocks_map_are_refused_map_stale() {
    let t = town();
    let a = stand(&t, id(10), Vec3::new(0, 0, 0));
    let to = goal(&t, &a);
    let current = Arc::new(t.versions.clone());
    let mut other = t.versions.clone();
    other.bump([&t.ground]);
    let other = Arc::new(other);
    let part = Part::read(
        &encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(t.doors.header.hash().to_bytes())),
            (2, Value::Array(Vec::new())),
        ])))
        .unwrap(),
    )
    .unwrap();
    let rebuilt = Town::rebuild(
        t.tree.frozen(),
        &t.doors.header,
        t.ground,
        &t.versions,
        &t.basis(),
        &part,
    )
    .unwrap();
    let mut planner = Planner::new(t);
    let w = wants(&[a], to, true, &other);
    for _ in 0..40 {
        let p = planner.answer(&w);
        assert!(p.places.is_empty() && p.lines.is_empty() && p.forms.is_empty());
    }
    // A committed map made from one the planner does not hold: not installed, and the planner is behind.
    assert_eq!(planner.install(&other, rebuilt, &part), Err(MAP_STALE));
    let p = planner.answer(&w);
    all_answered(&w, &p, a.id);
    assert_eq!(p.places[&a.id].1.as_ref().err(), Some(&MAP_STALE));
    assert_eq!(p.lines[&a.id].1.as_ref().unwrap_err().name, MAP_STALE);
    assert_eq!(walk_refusal(&p, a.id), Some(MAP_STALE));
    let ok = wants(&[a], to, true, &current);
    let p = planner.answer(&ok);
    all_answered(&ok, &p, a.id);
    assert_eq!(walk_refusal(&p, a.id), None);
    println!("S13d (3): after a failed install: refused {MAP_STALE} at once");
}

/// (4) One body's panic refuses only its own questions `planner.failed`; the other body's in the same batch are the
/// answers a planner with no panic gives.
#[test]
fn one_bodys_panic_refuses_only_its_own_questions() {
    let t = town();
    let a = stand(&t, id(10), Vec3::new(0, 0, 0));
    let b = stand(
        &t,
        id(12),
        Vec3::new(a.pose.position.x, 0, a.pose.position.z + 2_000_000),
    );
    let to = stand(
        &t,
        id(11),
        Vec3::new(a.pose.position.x + 3_000_000, 0, a.pose.position.z),
    )
    .pose
    .position;
    let map = Arc::new(t.versions.clone());
    let mut clean = Planner::new(t.copy().unwrap());
    let mut planner = Planner::new(t);
    planner.fault = Some(a.id);
    let w = wants(&[a, b], to, true, &map);
    let (p, panicked) = answer_batch(&w, |w| planner.answer(w));
    assert!(!panicked, "the batch itself did not panic");
    assert_eq!(
        planner.panics, 4,
        "a's place, line, form walk and form line"
    );
    all_answered(&w, &p, a.id);
    all_answered(&w, &p, b.id);
    assert_eq!(p.places[&a.id].1.as_ref().err(), Some(&FAILED));
    assert_eq!(p.lines[&a.id].1.as_ref().unwrap_err().name, FAILED);
    assert_eq!(walk_refusal(&p, a.id), Some(FAILED));
    assert!(
        matches!(&p.forms[&key(a.id, FormKind::Line)].result, FormResult::Line(Err(r)) if r.name == FAILED)
    );
    let q = clean.answer(&w);
    let show = |p: &Planned| {
        format!(
            "{:?} {:?} {:?} {:?}",
            p.places[&b.id],
            p.lines[&b.id],
            p.forms[&key(b.id, FormKind::Walk)].result,
            p.forms[&key(b.id, FormKind::Line)].result
        )
    };
    assert!(p.places[&b.id].1.is_ok(), "b walks");
    assert_eq!(
        show(&p),
        show(&q),
        "b's answers are a planner's with no panic"
    );
    println!("S13d (4): one body's panic: its 4 questions refused {FAILED}, the other's answered");
}
