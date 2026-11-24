//! A walk planned, then the ground changed under it (S13c): the planner is sent the walker with the piece numbers of
//! the ground as it was (a change cut its squares, or its floor, again and numbered the pieces anew), and every
//! question in the batch is still answered: from where the walker stands, or refused by name. Before, the line search
//! indexed the dropped pieces and the batch panicked, so it was answered with nothing and asked again each tick.
//!
//! `cargo test -p sim --test planner_ground -- --nocapture`.

mod common;

use common::id;
use replica::effects::{
    Actor, Body as EffectBody, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest,
};
use replica::encode::{Value, encode};
use replica::ids::Id;
use replica::pose::{Frame, Pose, Quat, Vec3};
use replica::world_model::Audience;
use sim::ground::Versions;
use sim::host::Wants;
use sim::mover::Body;
use sim::planner::{FormKey, FormKind, FormQuery, FormQuestion, FormResult, Planner, Thread};
use sim::spots::Target;
use sim::walk::town::Town;
use sim::walk::{Mark, node_of};
use std::collections::BTreeMap;
use std::sync::Arc;

/// A creator's changes, as a town part.
fn part(t: &Town, changes: Vec<(Id, Change)>) -> Part {
    let effects: Vec<Value> = changes
        .into_iter()
        .enumerate()
        .map(|(k, (node, change))| {
            Effect {
                envelope: Envelope {
                    sequence: t.doors.next + k as u64,
                    at: 0,
                    cause: Cause::Intent(id(70_000)),
                    actor: Actor::Creator(id(70_001)),
                    audience: Audience::Everyone,
                    node,
                },
                body: EffectBody::Changes(vec![ChangeRec {
                    change,
                    rest: Rest::new(),
                }]),
                events: None,
                rest: Rest::new(),
            }
            .to_value()
        })
        .collect();
    Part::read(
        &encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(t.doors.header.hash().to_bytes())),
            (2, Value::Array(effects)),
        ])))
        .unwrap(),
    )
    .unwrap()
}

/// `node` moved `dx` µm along x on its parent (a set-down, or a creator moving a thing).
fn moved(t: &Town, node: Id, dx: i64) -> Part {
    let n = t.tree.node(t.tree.handle(node).unwrap()).unwrap();
    let place = n.place().unwrap();
    let from = Frame {
        node: n.parent().unwrap(),
        slot: n.slot(),
    };
    let pose = Pose {
        frame: from,
        position: Vec3::new(place.position.x + dx, place.position.y, place.position.z),
        orientation: place.orientation,
        support: place.support,
    };
    part(t, vec![(node, Change::Reparent { node, from, pose })])
}

/// Rebuilds `town` for `part` (off the clock, as K8 does).
fn rebuilt(town: &Town, part: &Part) -> sim::walk::town::Rebuilt {
    Town::rebuild(
        town.tree.frozen(),
        &town.doors.header,
        town.ground,
        &town.versions,
        &town.basis(),
        part,
    )
    .unwrap()
}

/// A walker standing on `node` within 10 m of `near` whose piece numbers `part` makes stale (the triangle they name no
/// longer holds where it stands, or is gone), though it still stands on the ground there; and a point 2 to 4 m from it
/// it can stand at, for its walk. Searched on a half-metre grid, in order.
fn stale_walker(town: &Town, node: Id, near: Vec3, part: &Part) -> Option<(Body, Vec3)> {
    let mut after = town.copy().unwrap();
    after.install(rebuilt(town, part), part).unwrap();
    let surface = &town.surfaces[&node];
    let stands = |at: Vec3| {
        surface
            .place(id(72_001), Frame { node, slot: None }, at, Quat::IDENTITY)
            .ok()
    };
    let grid =
        |r: i64| (-r..=r).flat_map(move |i| (-r..=r).map(move |k| (i * 500_000, k * 500_000)));
    grid(20).find_map(|(dx, dz)| {
        let b = stands(Vec3::new(near.x + dx, near.y, near.z + dz))?;
        let p = [b.pose.position.x, b.pose.position.z];
        let stale = !after.surfaces[&node].inside(b.piece, b.tri, p) && after.relocate(&b).is_ok();
        if !stale {
            return None;
        }
        let to = grid(8)
            .filter(|&(x, z)| (4_000_000i64..=16_000_000).contains(&((x * x + z * z) / 1_000_000)))
            .find_map(|(x, z)| stands(Vec3::new(p[0] + x, b.pose.position.y, p[1] + z)))?;
        Some((b, to.pose.position))
    })
}

const ORDER: u64 = 71_000;

fn keys(body: Id) -> [FormKey; 2] {
    [FormKind::Walk, FormKind::Line].map(|kind| FormKey {
        body,
        intent: id(ORDER),
        stage: 0,
        step: 0,
        kind,
    })
}

/// One tick's questions for `body`: its place near `target` and its walk there, its line toward `to`, and a form's
/// walk and line, all on `map`.
fn wants(body: Body, target: Target, to: Vec3, map: &Arc<Versions>) -> Wants {
    let order = id(ORDER);
    let [walk, line] = keys(body.id);
    Wants {
        marks: Some(vec![Mark {
            who: body.id,
            node: node_of(&body),
            at: body.pose.position,
            waiting: None,
            crossing: None,
            staying: false,
            spot: Some((target, order)),
        }]),
        places: vec![(body, target, order)],
        lines: vec![(body, to)],
        form_map: Some(Arc::clone(map)),
        forms: vec![
            FormQuestion {
                key: walk,
                generation: 1,
                body,
                query: FormQuery::Walk {
                    node: target.node,
                    at: target.point(),
                    reach: 0,
                    door: None,
                    ring: None,
                },
            },
            FormQuestion {
                key: line,
                generation: 1,
                body,
                query: FormQuery::Line { to },
            },
        ],
        ..Default::default()
    }
}

/// The batch's answers: every question has one (none left for a later tick), and none panicked.
fn answered(worker: &mut Thread, w: Wants) -> sim::host::Planned {
    let who = w.places[0].0.id;
    let panicked = worker.panicked;
    worker.send(w);
    let p = worker.take(None);
    assert_eq!(worker.panicked, panicked, "the batch did not panic");
    assert_eq!(p.places.get(&who).map(|(o, _)| *o), Some(id(ORDER)));
    assert!(p.lines.contains_key(&who), "the walker's line is answered");
    for k in keys(who) {
        assert!(
            p.forms.contains_key(&k),
            "the form's {:?} is answered",
            k.kind
        );
    }
    p
}

/// Plans a walk for `body`, changes the ground with `edit` (installed on the clock's town and on the planner's), sends
/// the planner the same walker as it stood before the change, then the walker found again on the ground as it is.
/// Returns the answers to the stale walker and to the walker found again.
fn edit_under_walk(
    mut town: Town,
    body: Body,
    target: Target,
    to: Vec3,
    edit: impl Fn(&Town) -> Part,
) -> (sim::host::Planned, sim::host::Planned, Body) {
    let mut worker = Thread::spawn(Planner::new(town.copy().unwrap())).unwrap();
    let before = Arc::new(town.versions.clone());
    let planned = answered(&mut worker, wants(body, target, to, &before));
    assert!(
        planned.places[&body.id].1.is_ok(),
        "the walk is planned before the change"
    );

    let part = Arc::new(edit(&town));
    let rebuild = || rebuilt(&town, &part);
    let (live, remote) = (rebuild(), rebuild());
    town.install(live, &part).unwrap();
    worker.install(Arc::clone(&before), remote, Arc::clone(&part));
    let after = Arc::new(town.versions.clone());
    assert_ne!(*after, *before, "the ground changed");
    let node = node_of(&body);
    let p = [body.pose.position.x, body.pose.position.z];
    assert!(
        !town.surfaces_for(town.size_of(body.id)).unwrap()[&node].inside(body.piece, body.tri, p),
        "the walker's piece numbers are stale: the change numbered its ground's pieces anew"
    );

    let stale = answered(&mut worker, wants(body, target, to, &after));
    let here = town.relocate(&body).unwrap();
    assert_ne!((here.piece, here.tri), (body.piece, body.tri));
    let again = answered(&mut worker, wants(here, target, to, &after));
    // A piece number no ground has (corrupt, or from a far older map) is the same case.
    let invalid = Body {
        piece: u32::MAX,
        ..body
    };
    let invalid = answered(&mut worker, wants(invalid, target, to, &after));
    same_as_found_again(&invalid, &again, body.id);
    (stale, again, here)
}

/// The walker's walk and line, answered from where it stands, are the answers it gets once found again.
fn same_as_found_again(stale: &sim::host::Planned, again: &sim::host::Planned, who: Id) {
    let place = |p: &sim::host::Planned| {
        p.places[&who]
            .1
            .as_ref()
            .map(|(g, legs, _)| {
                (
                    g.at,
                    legs.iter().map(|l| (l.to, l.link)).collect::<Vec<_>>(),
                )
            })
            .map_err(|e| *e)
    };
    assert!(place(again).is_ok(), "the walker found again can walk");
    assert_eq!(place(stale), place(again));
    let line = |p: &sim::host::Planned| {
        p.lines[&who]
            .1
            .as_ref()
            .map(|l| format!("{l:?}"))
            .map_err(|e| e.name)
    };
    assert!(line(again).is_ok(), "the walker found again has a line");
    assert_eq!(line(stale), line(again));
    let walk = |p: &sim::host::Planned| match &p.forms[&keys(who)[0]].result {
        FormResult::Walk(legs) => legs.iter().map(|l| (l.to, l.link)).collect::<Vec<_>>(),
        FormResult::Line(_) => unreachable!(),
    };
    assert!(!walk(again).is_empty(), "the form's walk has legs");
    assert_eq!(walk(stale), walk(again));
}

#[test]
fn an_open_ground_edit_under_a_planned_walk_is_answered_from_where_the_walker_stands() {
    let (town, _) = common::town(b"souls/s13c-open/1");
    let ground = town.ground;
    // The small things on the open ground (a box of their own, no children), each moved 1.5 m in turn until one cuts
    // the squares a walker beside it stands on.
    let gh = town.tree.handle(ground).unwrap();
    let (edit, body, to) = town
        .tree
        .children(gh)
        .unwrap()
        .iter()
        .filter_map(|&c| town.tree.node(c))
        .filter(|n| {
            n.fields().contains_key(&import_eden::F_SOLIDS)
                && town
                    .tree
                    .children(town.tree.handle(n.id()).unwrap())
                    .is_some_and(|k| k.is_empty())
        })
        .map(|n| (n.id(), n.place().unwrap().position))
        .find_map(|(thing, at)| {
            let edit = move |t: &Town| moved(t, thing, 1_500_000);
            let (body, to) = stale_walker(&town, ground, at, &edit(&town))?;
            Some((edit, body, to))
        })
        .expect("a thing on the open ground moved cuts the squares a walker beside it stands on");
    let target = Target::new(ground, to);
    let (stale, again, _) = edit_under_walk(town, body, target, to, edit);
    same_as_found_again(&stale, &again, body.id);
    println!(
        "S13c: an open ground edit under a planned walk: answered from where the walker stands"
    );
}

#[test]
fn a_building_edit_under_a_planned_walk_is_answered_from_where_the_walker_stands() {
    let (town, nodes) = common::town(b"souls/s13c-building/1");
    // The building's stairs taken away (K18d's edit): the open ground's squares where they met it are cut again (S13),
    // and a walker standing there, on its way to the building, has piece numbers that are gone.
    let floors = [nodes["building/floor-0"], nodes["building/floor-1"]];
    let edit = move |t: &Town| {
        part(
            t,
            floors
                .iter()
                .map(|&node| {
                    (
                        node,
                        Change::Set {
                            node,
                            field: import_eden::F_STAIRS,
                            to: Value::Array(Vec::new()),
                            by: None,
                        },
                    )
                })
                .collect(),
        )
    };
    let ground = town.ground;
    let (body, to) = stale_walker(
        &town,
        ground,
        Vec3::new(-40_000_000, 0, 30_000_000),
        &edit(&town),
    )
    .expect("a walker stands on the open ground the stairs' removal cuts again");
    let target = Target::new(ground, to);
    let (stale, again, _) = edit_under_walk(town, body, target, to, edit);
    same_as_found_again(&stale, &again, body.id);
    println!("S13c: a building edit under a planned walk: answered from where the walker stands");
}
