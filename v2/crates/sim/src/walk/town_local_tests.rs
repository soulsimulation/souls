//! S13 (0.133): a creator's building edit, which touches the open ground and a new floor, cuts again only the open
//! ground's squares it touches and reads only its own building, and the town it leaves equals a town built whole from
//! the same tree: every square's pieces, every floor's surface, every building, `link_at`, the basis's `known`,
//! `reach` and `joined`, and routes between standing spots.
//!
//! `cargo test -p sim --release --lib walk::town::local_tests -- --ignored --nocapture` times the rebuild of a building
//! edit, a small path edit, a single wall, and the building moved and removed, on Eden (the exported facts file, as
//! `tests/g3b.rs` reads it).

// Times its own runs: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

use super::*;
use crate::routes::{HANDS, Hop, Route};
use import_eden::{
    F_HEIGHT, F_LEVEL, F_LINE_WIDTH, F_OUTLINE, F_SOLIDS, F_STAIRS, F_SURFACES, FLOOR, ROOM,
};
use replica::effects::{Actor, Body as Changes, Cause, Change, ChangeRec, Effect, Envelope, Rest};
use replica::encode::{Name, Value, encode};
use replica::ids::Scope;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::world_model::{Audience, plain};
use std::time::Instant;

const M: i64 = 1_000_000;

fn int(v: i64) -> Value {
    if v >= 0 {
        Value::Uint(v as u64)
    } else {
        Value::Nint((-1 - v) as u64)
    }
}

fn row(values: &[i64]) -> Value {
    Value::Array(values.iter().copied().map(int).collect())
}

fn polygon(x0: i64, x1: i64, z0: i64, z1: i64) -> Value {
    Value::Array(vec![
        row(&[x0, z0]),
        row(&[x1, z0]),
        row(&[x1, z1]),
        row(&[x0, z1]),
    ])
}

fn town_of(text: &str) -> Town {
    let im = import_eden::load(text).expect("the world loads");
    let root = im.nodes["world"];
    let ground = im.nodes["ground"];
    let header = import_eden::header(root, &im.rules).unwrap();
    let next = im.tree.to_state().next;
    Town::new(im.tree, ground, Doors::new(header, im.rules, next)).expect("the town")
}

/// The town built whole from `t`'s tree as it stands.
fn whole_of(t: &Town) -> Town {
    let d = &t.doors;
    Town::new(
        t.tree.frozen(),
        t.ground,
        Doors::new(d.header.clone(), d.rules.clone(), d.next),
    )
    .expect("the whole town")
}

/// `changes` as one effect on the open ground by a creator, numbered from the zone's next sequence.
fn part(t: &Town, changes: Vec<Change>) -> Part {
    part_on(t, t.ground, changes)
}

/// [`part`], the effect on `node`.
fn part_on(t: &Town, node: Id, changes: Vec<Change>) -> Part {
    let e = Effect {
        envelope: Envelope {
            sequence: t.doors.next,
            at: 0,
            cause: Cause::Intent(Id::new(Scope([7; 16]), 9_000).unwrap()),
            actor: Actor::Creator(Id::new(Scope([7; 16]), 9_001).unwrap()),
            audience: Audience::Everyone,
            node,
        },
        body: Changes::Changes(
            changes
                .into_iter()
                .map(|change| ChangeRec {
                    change,
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: None,
        rest: Rest::new(),
    };
    let bytes = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(t.doors.header.hash().to_bytes())),
        (2, Value::Array(vec![e.to_value()])),
    ])))
    .unwrap();
    Part::read(&bytes).unwrap()
}

/// A new node's id in the world's scope.
fn new_id(t: &Town, n: u64) -> Id {
    Id::new(t.ground.scope(), 0x7000_0000 + n).unwrap()
}

fn on_ground(t: &Town, at: Vec3) -> Pose {
    Pose {
        frame: Frame {
            node: t.ground,
            slot: None,
        },
        position: at,
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: t.ground,
            height: 0,
        },
    }
}

fn under(parent: Id) -> Pose {
    Pose {
        frame: Frame {
            node: parent,
            slot: None,
        },
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        support: Support::None,
    }
}

/// The kinds of a building with rooms: a child of the open ground with boxes, its floor and a room on it.
fn building_kinds(t: &Town) -> (Name, Name, Name) {
    let tree = &t.tree;
    let gh = tree.handle(t.ground).unwrap();
    let kids = |h| {
        tree.children(h)
            .unwrap_or(&[])
            .iter()
            .filter_map(|&c| tree.node(c))
    };
    for b in kids(gh) {
        if !b.fields().contains_key(&F_SOLIDS) {
            continue;
        }
        for f in kids(tree.handle(b.id()).unwrap()) {
            if plain(f.kind().as_str()) != FLOOR {
                continue;
            }
            if let Some(r) =
                kids(tree.handle(f.id()).unwrap()).find(|r| plain(r.kind().as_str()) == ROOM)
            {
                return (b.kind().clone(), f.kind().clone(), r.kind().clone());
            }
        }
    }
    panic!("no building with rooms on the open ground")
}

/// Where a 26 m by 9 m row of the open ground is clear (as the K18d test finds one): its least x and z, m.
fn clear_row(t: &Town) -> (i64, i64) {
    let surface = &t.surfaces[&t.ground];
    let frame = Frame {
        node: t.ground,
        slot: None,
    };
    let who = Id::new(Scope([0x77; 16]), 1).unwrap();
    let ok = |x: i64, z: i64| {
        surface
            .place(who, frame, Vec3::new(x * M, 0, z * M), Quat::IDENTITY)
            .is_ok()
    };
    for r in 0..40 {
        for (dx, dz) in [
            (1, 0),
            (-1, 0),
            (0, 1),
            (0, -1),
            (1, 1),
            (-1, -1),
            (1, -1),
            (-1, 1),
        ] {
            let (x0, z0) = (dx * r * 10, dz * r * 10);
            if (0..=25).all(|k| (0..=8).all(|j| ok(x0 + 2 * k, z0 + j))) {
                return (x0, z0);
            }
        }
    }
    panic!("no clear row on the open ground");
}

/// The creator's building batch of K18d (`worldd/tests/edit_served/k18d.rs`): a building with three walls and a
/// partition, its floor and two rooms, at (x + 8, z + 4) m.
fn building(t: &Town, (x, z): (i64, i64)) -> Part {
    let (bk, fk, rk) = building_kinds(t);
    let (b, f, r1, r2) = (new_id(t, 1), new_id(t, 2), new_id(t, 3), new_id(t, 4));
    let solids = vec![
        row(&[0, 0, 100, 2000, 0, 0, 2500, 1, 0]),
        row(&[4000, 0, 100, 2000, 0, 0, 2500, 1, 0]),
        row(&[2000, -2000, 2000, 100, 0, 0, 2500, 1, 0]),
        row(&[2000, 2000, 2000, 100, 0, 0, 2500, 1, 0]),
    ];
    let room = |node, kind: &Name, dx| Change::Create {
        node,
        kind: kind.clone(),
        pose: Pose {
            position: Vec3::new(dx * M, 0, 0),
            ..under(f)
        },
        audience: Audience::Everyone,
        fields: BTreeMap::from([
            (F_LEVEL, int(0)),
            (F_HEIGHT, int(2500)),
            (F_OUTLINE, polygon(-1900, 1900, -1900, 1900)),
        ]),
    };
    part(
        t,
        vec![
            Change::Create {
                node: b,
                kind: bk,
                pose: on_ground(t, Vec3::new((x + 8) * M, 0, (z + 4) * M)),
                audience: Audience::Everyone,
                fields: BTreeMap::from([(F_SOLIDS, Value::Array(solids))]),
            },
            Change::Create {
                node: f,
                kind: fk,
                pose: under(b),
                audience: Audience::Everyone,
                fields: BTreeMap::from([
                    (F_LEVEL, int(0)),
                    (
                        F_SURFACES,
                        Value::Array(vec![Value::Array(vec![
                            int(0),
                            polygon(-4000, 4000, -2000, 2000),
                        ])]),
                    ),
                ]),
            },
            room(r1, &rk, -2),
            room(r2, &rk, 2),
        ],
    )
}

/// A single wall, 3 m by 0.2 m and 2.5 m tall, on the open ground at (x + 2, z + 4) m, half a metre before the open
/// side of [`building`]'s building: a new box of the kind of the first thing standing there with a box of its own.
fn wall(t: &Town, (x, z): (i64, i64)) -> Part {
    let tree = &t.tree;
    let gh = tree.handle(t.ground).unwrap();
    let kind = tree
        .children(gh)
        .unwrap()
        .iter()
        .filter_map(|&c| tree.node(c))
        .find(|n| {
            n.fields().contains_key(&F_SOLIDS)
                && tree
                    .children(tree.handle(n.id()).unwrap())
                    .is_some_and(|k| k.is_empty())
        })
        .expect("a thing with a box on the open ground")
        .kind()
        .clone();
    part(
        t,
        vec![Change::Create {
            node: new_id(t, 10),
            kind,
            pose: on_ground(t, Vec3::new((x + 2) * M, 0, (z + 4) * M)),
            audience: Audience::Everyone,
            fields: BTreeMap::from([(
                F_SOLIDS,
                Value::Array(vec![row(&[0, 0, 1500, 100, 0, 0, 2500, 1, 0])]),
            )]),
        }],
    )
}

/// [`building`]'s building moved 2 m along the row.
fn moved(t: &Town, (x, z): (i64, i64)) -> Part {
    let b = new_id(t, 1);
    part_on(
        t,
        b,
        vec![Change::Reparent {
            node: b,
            from: Frame {
                node: t.ground,
                slot: None,
            },
            pose: on_ground(t, Vec3::new((x + 10) * M, 0, (z + 4) * M)),
        }],
    )
}

/// [`building`]'s building removed.
fn removed(t: &Town) -> Part {
    let b = new_id(t, 1);
    part_on(t, b, vec![Change::Remove { node: b }])
}

/// A small path edit: the narrowest path on the open ground made 0.2 m wider, if the world has one.
fn path(t: &Town) -> Option<Part> {
    let tree = &t.tree;
    let gh = tree.handle(t.ground).unwrap();
    let (node, width) = tree
        .children(gh)
        .unwrap()
        .iter()
        .filter_map(|&c| tree.node(c))
        .filter_map(|n| match n.fields().get(&F_LINE_WIDTH) {
            Some(Value::Uint(w)) => Some((n.id(), *w as i64)),
            _ => None,
        })
        .min_by_key(|(_, w)| *w)?;
    Some(part_on(
        t,
        node,
        vec![Change::Set {
            node,
            field: F_LINE_WIDTH,
            to: int(width + 200),
            by: None,
        }],
    ))
}

/// An edit of the Eden timing test, made on the town as it stands, at the clear row.
type Edit = fn(&Town, (i64, i64)) -> Option<Part>;

/// The buildings on the open ground with a doorway onto it (a front door: the ground's own doorway, placed by the
/// building), with that many doorways, in id order.
fn with_front_doors(t: &Town) -> Vec<(Id, usize)> {
    let tree = &t.tree;
    let gh = tree.handle(t.ground).unwrap();
    let mut out = Vec::new();
    for &c in tree.children(gh).unwrap() {
        let thing = tree.node(c).unwrap().id();
        let mut doors = 0;
        let mut stack = vec![c];
        while let Some(h) = stack.pop() {
            stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
            doors += tree
                .links_of(h)
                .unwrap_or(&[])
                .iter()
                .filter(|e| tree.ty(e).as_str() == crate::ground::scene::DOORWAY)
                .filter(|e| e.other == t.ground)
                .count();
        }
        if doors > 0 {
            out.push((thing, doors));
        }
    }
    out
}

/// Building `b` moved `dx` m along x from where it stands.
fn nudged(t: &Town, b: Id, dx: i64) -> Part {
    let n = t.tree.node(t.tree.handle(b).unwrap()).unwrap();
    let place = n.place().unwrap();
    let mut at = place.position;
    at.x += dx * M / 2;
    part_on(
        t,
        b,
        vec![Change::Reparent {
            node: b,
            from: Frame {
                node: t.ground,
                slot: n.slot(),
            },
            pose: Pose {
                frame: Frame {
                    node: t.ground,
                    slot: n.slot(),
                },
                position: at,
                orientation: place.orientation,
                support: place.support,
            },
        }],
    )
}

/// Building `b` placed again as it stands now, after it is removed: every node of it created (parents first) and
/// every link with an end in it made again, in one effect on the open ground.
fn placed_again(t: &Town, b: Id) -> Vec<Change> {
    let tree = &t.tree;
    let mut changes = Vec::new();
    let mut links = BTreeSet::new();
    let mut stack = vec![tree.handle(b).unwrap()];
    while let Some(h) = stack.pop() {
        let n = tree.node(h).unwrap();
        let place = n.place().unwrap();
        changes.push(Change::Create {
            node: n.id(),
            kind: n.kind().clone(),
            pose: Pose {
                frame: Frame {
                    node: n.parent().unwrap(),
                    slot: n.slot(),
                },
                position: place.position,
                orientation: place.orientation,
                support: place.support,
            },
            audience: n.audience(),
            fields: n.fields().clone(),
        });
        links.extend(tree.links_of(h).unwrap_or(&[]).iter().map(|e| e.link));
        let mut kids = tree.children(h).unwrap_or(&[]).to_vec();
        kids.reverse();
        stack.extend(kids);
    }
    for link in links {
        let (ty, ends, owner, audience) = tree.link(link).unwrap();
        changes.push(Change::Link {
            link,
            ty: ty.clone(),
            ends,
            owner,
            audience,
        });
    }
    changes
}

/// `p` rebuilt on `t`'s ground off the clock, timed (the tree copy is the caller's, as K8's spares are).
fn rebuilt(t: &Town, p: &Part) -> (Rebuilt, f64) {
    let (mut base, header, versions, basis) = (
        t.tree.frozen(),
        t.doors.header.clone(),
        t.versions.clone(),
        t.basis(),
    );
    let t0 = Instant::now();
    let r =
        Town::rebuild_on(&mut base, &header, t.ground, &versions, &basis, p).expect("the rebuild");
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    drop(base);
    (r, ms)
}

fn route_key(m: &Map, r: &Route) -> String {
    let hops: Vec<String> = r
        .hops
        .iter()
        .map(|h| match h {
            // A patch by its node and square: a town built whole numbers no versions (the local one bumps them).
            Hop::Patch { at, piece } => {
                format!(
                    "{:?} {:?} {:?}",
                    at.node,
                    at.square,
                    m.piece(*piece).outline
                )
            }
            Hop::Link { id, kind } => format!("{id:?} {kind:?}"),
        })
        .collect();
    format!("{hops:?} {:?} {:?} {}", r.first_line, r.waypoints, r.length)
}

fn building_key(b: &Building) -> String {
    let floors: Vec<String> = b
        .floors
        .iter()
        .map(|(f, (level, patch))| format!("{f:?} {level} {:?}", patch.pieces))
        .collect();
    format!(
        "{:?} {:?} {floors:?} {:?} {:?}",
        b.thing, b.links, b.place, b.loose
    )
}

/// Each difference between the town `t` as installed and `w`, built whole from the same tree; `routes` routes between
/// standing spots of the whole map are compared too.
fn differences(t: &mut Town, w: &mut Town, routes: usize) -> Vec<String> {
    let mut out = Vec::new();
    let (a, b) = (&t.basis, &w.basis);
    let sq: BTreeSet<_> = a.open.squares.keys().chain(b.open.squares.keys()).collect();
    for s in sq {
        if format!("{:?}", a.square(*s)) != format!("{:?}", b.square(*s)) {
            out.push(format!("square {s:?}"));
        }
    }
    if format!("{:?}", a.open.meets) != format!("{:?}", b.open.meets) {
        out.push("the open ground's meets".into());
    }
    if a.known != b.known {
        out.push("known".into());
    }
    if a.reach != b.reach {
        out.push("reach".into());
    }
    if a.joined != b.joined {
        out.push("joined".into());
    }
    let floors = |x: &Town| -> BTreeMap<Id, String> {
        x.surfaces
            .iter()
            .filter(|(n, _)| **n != x.ground)
            .map(|(n, s)| (*n, format!("{:?}", s.pieces())))
            .collect()
    };
    if floors(t) != floors(w) {
        out.push("a floor's surface".into());
    }
    let buildings = |x: &Town| -> BTreeMap<Id, String> {
        x.buildings
            .iter()
            .map(|b| (b.thing, building_key(b)))
            .collect()
    };
    let (bt, bw) = (buildings(t), buildings(w));
    for thing in bt.keys().chain(bw.keys()).collect::<BTreeSet<_>>() {
        if bt.get(thing) != bw.get(thing) {
            out.push(format!("building {thing:?}"));
        }
    }
    let links: BTreeSet<Id> = t.link_at.keys().chain(w.link_at.keys()).copied().collect();
    for l in links {
        let of = |x: &Town| find_link(&x.link_at, &x.buildings, l).map(|k| format!("{k:?}"));
        if of(t) != of(w) {
            out.push(format!("link_at {l:?}"));
        }
    }
    let mut spots = Vec::new();
    for q in 0..w.map.counts().0 as u32 {
        let node = w.map.patch_of(q).node;
        for s in w.map.standing(q) {
            spots.push((node, Vec3::new(s[0] * 1000, s[1] * 1000, s[2] * 1000)));
        }
    }
    let go = |m: &mut Map, tree: &Tree, a: (Id, Vec3), b: (Id, Vec3)| {
        let (Some(from), Some(to)) = (m.spot(a.0, a.1), m.spot(b.0, b.1)) else {
            return "no spot".to_owned();
        };
        match m.route(tree, from, to, HANDS) {
            Ok(r) => route_key(m, &r),
            Err(e) => format!("{}: {}", e.name, e.detail),
        }
    };
    let mut seed = 0x5_13u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) as usize
    };
    let mut differ = 0;
    for _ in 0..routes {
        let (a, b) = (spots[next() % spots.len()], spots[next() % spots.len()]);
        if go(&mut t.map, &t.tree, a, b) != go(&mut w.map, &w.tree, a, b) {
            differ += 1;
        }
    }
    if differ > 0 {
        out.push(format!("{differ} of {routes} routes"));
    }
    out
}

/// Rebuilds and installs `p` on `t`; whether it was built whole, why, and how long the rebuild took.
fn apply(t: &mut Town, p: &Part) -> (bool, Option<&'static str>, f64) {
    let (r, ms) = rebuilt(t, p);
    let (whole, why) = (r.whole(), r.why);
    t.install(r, p)
        .unwrap_or_else(|e| panic!("install refused: {}: {}", e.name, e.detail));
    (whole, why, ms)
}

#[test]
fn a_building_edit_rebuilds_only_its_squares_and_building_and_equals_the_whole() {
    let w = testworld::generate(1, 0).expect("the test world");
    let mut t = town_of(&w.text);
    let at = clear_row(&t);
    let p = building(&t, at);
    let (whole, why, _) = apply(&mut t, &p);
    assert!(
        !whole,
        "the building edit is rebuilt locally, not whole ({why:?})"
    );
    let mut w = whole_of(&t);
    let d = differences(&mut t, &mut w, 300);
    assert!(d.is_empty(), "the local rebuild equals the whole: {d:?}");
    // The new building is known to the next edit: a wall beside it is cut alone and still equals the whole.
    let p = wall(&t, at);
    let (whole, why, _) = apply(&mut t, &p);
    assert!(!whole, "the wall is rebuilt locally ({why:?})");
    let mut w = whole_of(&t);
    let d = differences(&mut t, &mut w, 300);
    assert!(
        d.is_empty(),
        "after a wall beside it, the town equals the whole: {d:?}"
    );
    // The building moved 2 m along the row: its old squares and its new are cut again, and it is read again there.
    // Two walks planned beforehand: one across the square the building stands on, one on a square far from it, and
    // one on the building's floor. The ground changed under the first and the third: they are planned again
    // (`Town::stale`, which the ladder plans again); the second is left as it is.
    let b = new_id(&t, 1);
    let sq = |m: i64| (m * M).div_euclid(crate::ground::SQUARE * 1000) as i32;
    let under_it = (sq(at.0 + 8), sq(at.1 + 4));
    let gv = t.versions.of(t.ground);
    let fv = t.versions.of(new_id(&t, 2));
    let walker = |n| Id::new(Scope([0x55; 16]), n).unwrap();
    t.planned.insert(walker(1), vec![(t.ground, gv)]);
    t.planned_squares
        .insert(walker(1), vec![(under_it.0 - 3, under_it.1), under_it]);
    t.planned.insert(walker(2), vec![(t.ground, gv)]);
    t.planned_squares
        .insert(walker(2), vec![(under_it.0 + 40, under_it.1 + 40)]);
    t.planned.insert(walker(3), vec![(new_id(&t, 2), fv)]);
    let p = moved(&t, at);
    let (whole, why, _) = apply(&mut t, &p);
    assert!(!whole, "the moved building is rebuilt locally ({why:?})");
    let mut w = whole_of(&t);
    let d = differences(&mut t, &mut w, 300);
    assert!(
        d.is_empty(),
        "after the building moved, the town equals the whole: {d:?}"
    );
    assert_eq!(
        t.stale.get(&walker(1)),
        Some(&1),
        "the walk across its square is planned again"
    );
    assert_eq!(
        t.stale.get(&walker(2)),
        None,
        "the walk far from it is left"
    );
    assert_eq!(
        t.stale.get(&walker(3)),
        Some(&0),
        "the walk on its floor is planned again"
    );
    // The building removed: its squares are cut again, and it leaves the map, the basis and the list.
    let p = removed(&t);
    let (whole, why, _) = apply(&mut t, &p);
    assert!(!whole, "the removed building is rebuilt locally ({why:?})");
    assert!(
        t.buildings.iter().all(|x| x.thing != b),
        "the removed building is not listed"
    );
    let mut w = whole_of(&t);
    let d = differences(&mut t, &mut w, 300);
    assert!(
        d.is_empty(),
        "after the building was removed, the town equals the whole: {d:?}"
    );
    // K18d's edit: each floor's stairs taken away in turn (those on the ground floor met the open ground), and after
    // each the town still equals the whole.
    let stairs: Vec<Id> = t
        .buildings
        .iter()
        .flat_map(|b| b.floors.keys().copied())
        .filter(|&f| {
            let n = t.tree.node(t.tree.handle(f).unwrap()).unwrap();
            matches!(n.fields().get(&F_STAIRS), Some(Value::Array(a)) if !a.is_empty())
        })
        .collect();
    assert!(!stairs.is_empty(), "the test world has stairs");
    let mut local = 0;
    for f in stairs {
        let change = Change::Set {
            node: f,
            field: F_STAIRS,
            to: Value::Array(Vec::new()),
            by: None,
        };
        let p = part_on(&t, f, vec![change]);
        let (whole, _, _) = apply(&mut t, &p);
        local += usize::from(!whole);
        let mut w = whole_of(&t);
        let d = differences(&mut t, &mut w, 100);
        assert!(
            d.is_empty(),
            "after {f:?}'s stairs were taken away, the town equals the whole: {d:?}"
        );
    }
    println!("stairs taken away: {local} rebuilt locally");
}

#[test]
fn a_building_with_front_doors_moved_removed_and_placed_equals_the_whole() {
    let w = testworld::generate(1, 0).expect("the test world");
    let mut t = town_of(&w.text);
    let doors = with_front_doors(&t);
    assert!(
        !doors.is_empty(),
        "the test world has buildings with front doors"
    );
    // Each moved half a metre: its doorways onto the ground move with it.
    let mut local = 0;
    for &(b, _) in &doors {
        let p = nudged(&t, b, 1);
        let (whole, _, _) = apply(&mut t, &p);
        local += usize::from(!whole);
        let mut w = whole_of(&t);
        let d = differences(&mut t, &mut w, 300);
        assert!(
            d.is_empty(),
            "after {b:?} moved, the town equals the whole: {d:?}"
        );
    }
    println!(
        "{} buildings with front doors moved: {local} rebuilt locally",
        doors.len()
    );
    assert!(
        local > 0,
        "a building with front doors moved is rebuilt locally"
    );
    // The one with the most removed, then placed again as it was.
    let (b, _) = *doors.iter().max_by_key(|(_, n)| *n).unwrap();
    let again = placed_again(&t, b);
    let p = part_on(&t, b, vec![Change::Remove { node: b }]);
    let (whole, why, _) = apply(&mut t, &p);
    println!("removed: whole {whole}, why {why:?}");
    let mut w = whole_of(&t);
    let d = differences(&mut t, &mut w, 300);
    assert!(
        d.is_empty(),
        "after {b:?} was removed, the town equals the whole: {d:?}"
    );
    let p = part(&t, again);
    let (whole, why, _) = apply(&mut t, &p);
    println!("placed with its front doors: whole {whole}, why {why:?}");
    let mut w = whole_of(&t);
    let d = differences(&mut t, &mut w, 300);
    assert!(
        d.is_empty(),
        "after {b:?} was placed again, the town equals the whole: {d:?}"
    );
}

#[test]
#[ignore = "needs the exported Eden facts file"]
fn eden_building_path_and_wall_rebuild_times() {
    let path_of = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text = std::fs::read_to_string(std::env::var("EDEN_FACTS").unwrap_or(path_of.into()))
        .expect("run v2/tools/import-eden/export/export.ts first");
    // The standard class alone, then with the released catalogue's large and giant classes prepared (as `worldd
    // serve` prepares them for Eden): each prepared class is still built whole on every edit.
    for classes in [vec![], vec![Size::Large, Size::Giant]] {
        let t0 = Instant::now();
        let mut t = town_of(&text);
        t.prepare_classes(classes.iter().copied()).unwrap();
        println!(
            "Eden, classes {classes:?}: built whole in {:.0} ms",
            t0.elapsed().as_secs_f64() * 1000.0
        );
        let at = clear_row(&t);
        let edits: [(&str, Edit); 5] = [
            ("a building edit", |t, at| Some(building(t, at))),
            ("a small path edit", |t, _| path(t)),
            ("a single wall", |t, at| Some(wall(t, at))),
            ("the building moved", |t, at| Some(moved(t, at))),
            ("the building removed", |t, _| Some(removed(t))),
        ];
        for (what, make) in edits {
            let Some(p) = make(&t, at) else {
                println!("  {what}: none in this world");
                continue;
            };
            let mut times = Vec::new();
            let mut kind = (false, None);
            for _ in 0..3 {
                let (r, ms) = rebuilt(&t, &p);
                kind = (r.whole(), r.why);
                times.push(ms);
            }
            times.sort_by(f64::total_cmp);
            println!(
                "  {what}: rebuild {:.1} ms (median of 3; all {times:.1?}), whole {}, why {:?}",
                times[1], kind.0, kind.1
            );
            apply(&mut t, &p);
        }
        if classes.is_empty() {
            let mut w = whole_of(&t);
            let d = differences(&mut t, &mut w, 500);
            assert!(d.is_empty(), "the local rebuilds equal the whole: {d:?}");
            println!("  the town after the five equals Eden built whole (500 routes)");
        }
    }
}
