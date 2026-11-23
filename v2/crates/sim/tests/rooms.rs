//! Things indoors a body can reach on Eden (#4072 follow-up). Every thing that stands on a building's floor is walked
//! to from the open ground at one of its building's doorways, as a form's walk (`spots::within`, the place within
//! reach a planned walk goes to) and as a plain walk (`Spots::write`, the place the engine grants). Before #4072's
//! follow-up a thing whose origin lies in a pocket of standable ground no walk reaches (under a school desk, between
//! its legs and the chairs round it) was its own place: a form's walk to it ended `souls:no-way` and a plain walk
//! `spot-none-free`. Prints the counts by building and by kind; every school desk must now be reached both ways.
//!
//! Needs the exported Eden facts file: `cargo test -p sim --release --test rooms -- --ignored --nocapture`.

// Times its own calls: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

mod common;

use replica::encode::Value;
use replica::ids::{Id, Scope};
use replica::pose::Vec3;
use replica::world_model::show;
use sim::routes::Map;
use sim::spots::{Ask, Spots, Target, within};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

fn text() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first")
}

fn field(tree: &replica::tree::Tree, id: Id, f: u64) -> String {
    match tree
        .handle(id)
        .and_then(|h| tree.node(h))
        .and_then(|n| n.fields().get(&f).cloned())
    {
        Some(Value::Bytes(b)) => String::from_utf8_lossy(&b).into_owned(),
        _ => show(id),
    }
}

fn parent(tree: &replica::tree::Tree, id: Id) -> Option<Id> {
    tree.handle(id).and_then(|h| tree.node(h))?.parent()
}

/// What one building's things came to: things, pocket targets (a form's walk ended `souls:no-way` before), and after
/// the fix, those a form's walk and a plain walk still do not reach.
#[derive(Default)]
struct Count {
    things: usize,
    pocket: usize,
    form: usize,
    walk: usize,
}

#[test]
#[ignore = "needs the exported Eden facts file"]
fn eden_things_indoors_are_reached_from_their_doorways() {
    let text = text();
    let im = import_eden::load(&text).expect("Eden loads");
    let ground = im.nodes["ground"];
    let tree = &im.tree;
    let map = Map::build(tree, ground, &|_| 0).expect("the map");
    // Each building's doorway onto the open ground: a point of the ground's piece at its outer end.
    let mut door: BTreeMap<Id, Vec3> = BTreeMap::new();
    for l in map.links() {
        let [Some(a), Some(b)] = l.pieces else {
            continue;
        };
        let (na, nb) = (map.patch_of(a).node, map.patch_of(b).node);
        let (inner, out) = match (na == ground, nb == ground) {
            (false, true) => (na, b),
            (true, false) => (nb, a),
            _ => continue,
        };
        let Some(building) = parent(tree, inner) else {
            continue;
        };
        let w = map.world(out, map.standing(out)[0]);
        door.entry(building)
            .or_insert(Vec3::new(w[0] * 1000, w[1] * 1000, w[2] * 1000));
    }
    let (mut town, _) = common::town_of(
        import_eden::load(&text).expect("Eden loads"),
        b"souls/rooms-test/1",
    );
    let reach = replica::moves::REACH_MOST + 600_000;
    let walker = Id::new(Scope([0xc1; 16]), 1).unwrap();
    let order = Id::new(Scope([0xc1; 16]), 2).unwrap();
    let mut by: BTreeMap<String, Count> = BTreeMap::new();
    let mut kinds: BTreeMap<String, Count> = BTreeMap::new();
    let mut desks = Vec::new();
    let mut no_door = 0;
    // Pocket targets a form's walk and a plain walk now reach.
    let mut fixed = (0, 0);
    // Each standable target the walker's walk does not reach: how long `within` and a spot grant took (#4072).
    let mut calls: Vec<(Duration, Duration)> = Vec::new();
    // The map's parts are found on the first walk: not timed with the first target.
    town.with_ground(|_, g| g.walk(ground, Vec3::ZERO, ground, Vec3::new(1_000_000, 0, 0)));
    let ids: Vec<Id> = im.nodes.values().copied().collect();
    for id in ids {
        let Some((floor, at, _)) = town.view().on_floor(id, Vec3::ZERO) else {
            continue;
        };
        if floor == ground || floor == id {
            continue;
        }
        let Some(b) = parent(tree, floor) else {
            continue;
        };
        // A building with no doorway onto the ground (a tower whose floors no way reaches) from another's.
        let from = match door.get(&b) {
            Some(&p) => p,
            None => {
                no_door += 1;
                *door.values().next().expect("a doorway")
            }
        };
        let target = Target::new(floor, at);
        let (pocket, form, walk) = town.with_ground(|_, g| {
            let pocket =
                g.stand(floor, at).is_some() && g.walk(ground, from, floor, at).is_none();
            let t0 = Instant::now();
            let form = within(g, target, reach, Some((ground, from)));
            let t1 = Instant::now();
            let form = form.is_some_and(|p| g.walk(ground, from, floor, p).is_some());
            let mut spots = Spots::new();
            let ask = Ask {
                who: walker,
                order,
                node: ground,
                from,
                target,
                carried: false,
            };
            let t2 = Instant::now();
            let wrote = spots.write(g, &[ask], 0).is_ok();
            let t3 = Instant::now();
            if pocket {
                calls.push((t1 - t0, t3 - t2));
            }
            let walk = wrote
                && matches!(spots.of(walker, &target), Some(Ok(p)) if g.walk(ground, from, floor, p).is_some());
            (pocket, form, walk)
        });
        // A thing with no def (a door, a window, a room) by what its origin names.
        let kind = match field(tree, id, import_eden::F_DEF) {
            d if d.starts_with("cd:") => {
                let o = field(tree, id, import_eden::F_ORIGIN);
                let tail = o.rsplit('/').next().unwrap_or("").to_owned();
                format!(
                    "({})",
                    tail.trim_end_matches(|c: char| c.is_ascii_digit() || c == '-')
                )
            }
            d => d,
        };
        fixed.0 += usize::from(pocket && form);
        fixed.1 += usize::from(pocket && walk);
        let building = format!(
            "{} {}",
            field(tree, b, import_eden::F_ORIGIN),
            field(tree, b, import_eden::F_DEF)
        );
        for c in [
            by.entry(building).or_default(),
            kinds.entry(kind.clone()).or_default(),
        ] {
            c.things += 1;
            c.pocket += usize::from(pocket);
            c.form += usize::from(!form);
            c.walk += usize::from(!walk);
        }
        if kind.starts_with("core-school-desk") {
            desks.push((field(tree, id, import_eden::F_ORIGIN), pocket, form, walk));
        }
    }
    let sum = |m: &BTreeMap<String, Count>| {
        m.values().fold(Count::default(), |a, c| Count {
            things: a.things + c.things,
            pocket: a.pocket + c.pocket,
            form: a.form + c.form,
            walk: a.walk + c.walk,
        })
    };
    let all = sum(&by);
    let left = by.values().filter(|c| c.form + c.walk > 0).count();
    println!(
        "things on building floors: {} in {} buildings ({no_door} more in buildings with no doorway onto the ground); \
         pocket targets (a form's walk ended souls:no-way before): {}, of them now reached by a form's walk {} and \
         by a plain walk {}; after: a form's walk does not reach {}, a plain \
         walk does not reach {}, in {left} buildings",
        all.things,
        by.len(),
        all.pocket,
        fixed.0,
        fixed.1,
        all.form,
        all.walk
    );
    println!("by building (pocket / form unreached / walk unreached of things):");
    for (b, c) in &by {
        if c.pocket + c.form + c.walk > 0 {
            println!(
                "  {b}: {} / {} / {} of {}",
                c.pocket, c.form, c.walk, c.things
            );
        }
    }
    println!("by kind:");
    for (k, c) in &kinds {
        if c.pocket + c.form + c.walk > 0 {
            println!(
                "  {k}: {} / {} / {} of {}",
                c.pocket, c.form, c.walk, c.things
            );
        }
    }
    // A target the walk does not reach answers at once: no route search per place round it (#4072's review: about
    // 1 s per call before, on the planner thread every walker waits on).
    let ms = |d: Duration| d.as_secs_f64() * 1e3;
    let mut forms: Vec<f64> = calls.iter().map(|c| ms(c.0)).collect();
    let mut grants: Vec<f64> = calls.iter().map(|c| ms(c.1)).collect();
    forms.sort_by(f64::total_cmp);
    grants.sort_by(f64::total_cmp);
    let mid = |v: &[f64]| v.get(v.len() / 2).copied().unwrap_or(0.0);
    let top = |v: &[f64]| v.last().copied().unwrap_or(0.0);
    println!(
        "unreached standable targets: {}; within: median {:.2} ms, max {:.2} ms; a spot grant: median {:.2} ms, max \
         {:.2} ms",
        calls.len(),
        mid(&forms),
        top(&forms),
        mid(&grants),
        top(&grants)
    );
    assert!(
        top(&forms) < 50.0 && top(&grants) < 50.0,
        "an unreached target answers without a search per place"
    );
    println!("school desks (pocket, form reached, walk reached):");
    for d in &desks {
        println!("  {d:?}");
    }
    assert_eq!(desks.len(), 41, "Eden's school desks");
    assert!(
        desks.iter().all(|d| d.2 && d.3),
        "every school desk is reached by a form's walk and a plain walk"
    );
}
