//! Every planner question gets exactly one answer (S13d): a form walk the planner cannot plan for the body's class is
//! refused by name, a walk whose place has no answer and a batch on a map the planner stays behind are asked again a
//! bounded number of times, then refused by name, and one body's panic refuses only its own questions.
//!
//! `cargo test -p sim --lib planner::answers_tests -- --nocapture`.

use super::*;
use crate::links::Doors;
use crate::mover::Body;
use crate::spots::Target;
use crate::walk::{Mark, node_of};
use replica::ids::Scope;
use replica::kinds::sizes::Size;
use replica::pose::{Frame, Quat};

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

/// (1) A form's walk for a body whose class the planner has no geometry for is refused by that name in the batch
/// that asks, never left unanswered (before: `view_for` refused -> `continue`, asked again every tick).
#[test]
fn a_form_walk_for_an_unprepared_class_is_refused_by_name() {
    let t = town();
    let a = stand(&t, id(10), Vec3::new(0, 0, 0));
    let to = stand(
        &t,
        id(11),
        Vec3::new(a.pose.position.x + 3_000_000, 0, a.pose.position.z),
    )
    .pose
    .position;
    let map = Arc::new(t.versions.clone());
    let mut planner = Planner::new(t);
    let mut w = wants(&[a], to, true, &map);
    w.classes.insert(a.id, Size::Large);
    let p = planner.answer(&w);
    // Its line and both form questions answered in this batch (its place waits on the spot tables: (2) bounds it).
    assert!(p.lines.contains_key(&a.id));
    assert!(p.forms.contains_key(&key(a.id, FormKind::Line)));
    assert_eq!(walk_refusal(&p, a.id), Some("body-class-unprepared"));
    println!("S13d (1): an unprepared class's form walk: refused body-class-unprepared");
}

/// (2) A walk whose place the spot tables never answer (its mark asks for none) is left unanswered at most
/// `UNANSWERED - 1` times, then refused `planner.no-spot`; an answered one is forgotten.
#[test]
fn a_walk_whose_place_is_never_answered_is_refused_after_a_bounded_number_of_asks() {
    let t = town();
    let a = stand(&t, id(10), Vec3::new(0, 0, 0));
    let to = stand(
        &t,
        id(11),
        Vec3::new(a.pose.position.x + 3_000_000, 0, a.pose.position.z),
    )
    .pose
    .position;
    let map = Arc::new(t.versions.clone());
    let mut planner = Planner::new(t);
    let w = wants(&[a], to, false, &map);
    for n in 1..UNANSWERED {
        let p = planner.answer(&w);
        assert!(!p.places.contains_key(&a.id), "ask {n} waits for its place");
        assert!(p.lines.contains_key(&a.id) && p.forms.len() == 2);
    }
    let p = planner.answer(&w);
    assert_eq!(p.places[&a.id], (id(ORDER), Err(NO_SPOT)));
    assert!(planner.waits.is_empty(), "the refused walk is forgotten");
    // The same walk asked for its place is answered at once.
    let p = planner.answer(&wants(&[a], to, true, &map));
    assert!(
        p.places[&a.id].1.is_ok(),
        "{:?}",
        p.places[&a.id].1.as_ref().err()
    );
    println!("S13d (2): a walk with no spot answer: refused {NO_SPOT} at ask {UNANSWERED}");
}

/// (3) A batch on a map the planner does not hold waits for its install at most `UNANSWERED - 1` batches in a row,
/// then every question in it is refused `planner.map-stale`, stamped with the batch's map; a batch on the planner's
/// map is answered as ever and starts the count again.
#[test]
fn batches_on_a_map_the_planner_stays_behind_are_refused_after_a_bounded_number() {
    let t = town();
    let a = stand(&t, id(10), Vec3::new(0, 0, 0));
    let to = stand(
        &t,
        id(11),
        Vec3::new(a.pose.position.x + 3_000_000, 0, a.pose.position.z),
    )
    .pose
    .position;
    let current = Arc::new(t.versions.clone());
    let mut other = t.versions.clone();
    other.bump([&t.ground]);
    let other = Arc::new(other);
    assert_ne!(*other, *current);
    let mut planner = Planner::new(t);
    let w = wants(&[a], to, true, &other);
    for _ in 1..UNANSWERED {
        let p = planner.answer(&w);
        assert!(p.places.is_empty() && p.lines.is_empty() && p.forms.is_empty());
    }
    let p = planner.answer(&w);
    all_answered(&w, &p, a.id);
    assert_eq!(p.places[&a.id].1.as_ref().err(), Some(&MAP_STALE));
    assert_eq!(p.lines[&a.id].1.as_ref().unwrap_err().name, MAP_STALE);
    assert_eq!(walk_refusal(&p, a.id), Some(MAP_STALE));
    // On the planner's own map: answered, and the count starts again.
    let ok = wants(&[a], to, true, &current);
    let p = planner.answer(&ok);
    all_answered(&ok, &p, a.id);
    assert_eq!(walk_refusal(&p, a.id), None);
    assert!(
        planner.answer(&w).forms.is_empty(),
        "a new run of stale batches waits again"
    );
    println!("S13d (3): a stale map: refused {MAP_STALE} at batch {UNANSWERED}");
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
