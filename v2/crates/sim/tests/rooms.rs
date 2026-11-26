//! Things indoors a body can reach on Eden (#4072 follow-up). Every thing that stands on a building's floor is walked
//! to from the open ground at one of its building's doorways, as a form's walk (`spots::within`, the place within
//! reach a planned walk goes to) and as a plain walk (`Spots::write`, the place the engine grants). Before #4072's
//! follow-up a thing whose origin lies in a pocket of standable ground no walk reaches (under a school desk, between
//! its legs and the chairs round it) was its own place: a form's walk to it ended `souls:no-way` and a plain walk
//! `spot-none-free`. Prints the counts by building and by kind; every school desk must now be reached both ways.
//!
//! A form's walk to a thing (a base form's `go_to`, `wait_by`, `touch`, `lean_on`) ends within reach of the thing's
//! footprint (#4072 follow-up: its entry's bounds, `spots::footprint`, carried onto its floor), not of its middle
//! (`spots::within_footprint`, as worldd plans it). Counted both ways: by the middle ("form at middle", the rule before)
//! and by the footprint ("form at footprint"; a walkable thing, `spots::walkable`, on it, as a `go_to` ends). Every
//! workbench is reached by the footprint, and no thing reached by its middle is lost by it ("lost").
//!
//! #4083: Eden's tower floor lamps stood over the stairwell (or behind the spiral stair), and its roof-terrace planters
//! and pots on roofs with no way up. The lamps now stand on each floor's central landing and the terrace things on the
//! ground by their building's door; every one is reached both ways (but the vineyard villa tower's four, a tower no walk
//! enters). Every thing a form's walk still does not reach at its footprint is listed by name.
//!
//! Needs the exported Eden facts file: `cargo test -p sim --release --test rooms -- --ignored --nocapture`.

// Times its own calls: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

mod common;

use replica::encode::Value;
use replica::ids::{Id, Scope};
use replica::pose::Vec3;
use replica::rules::json::{self, Value as Json};
use replica::world_model::show;
use sim::routes::Map;
use sim::spots::{
    Ask, Spots, Target, flat, footprint, to_outline, walkable, within, within_footprint,
};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

fn text() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first")
}

/// The world's entries by kind, as `worldd serve` loads `content/kinds`.
fn entries(dir: &std::path::Path, out: &mut BTreeMap<String, Json>) {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .expect("content/kinds")
        .filter_map(|e| Some(e.ok()?.path()))
        .collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            entries(&p, out);
        } else if p.extension().is_some_and(|x| x == "json")
            && let Ok(v) = json::parse(&std::fs::read_to_string(&p).expect("an entry"))
            && v.get("format").and_then(Json::str) == Some("souls-entry/1")
            && let Some(kind) = v.get("kind").and_then(Json::str)
        {
            out.insert(kind.to_owned(), v.clone());
        }
    }
}

/// Eden's towers (#4083): each floor lamp in one stands on its central floor, which a body reaches up the spiral stair.
const TOWERS: [&str; 10] = [
    "eden-tower-house",
    "region-old-town-bell-tower",
    "region-vineyard-villa-tower",
    "region-botanic-garden-pagoda",
    "region-campus-clock-tower",
    "castle-keep",
    "castle-tower-1",
    "castle-tower-2",
    "castle-tower-3",
    "castle-tower-4",
];

/// The roof-terrace things no walk reached (#4083): moved to the ground beside their building's door.
fn terrace_thing(name: &str) -> bool {
    name.ends_with("-roof-planter")
        || name.ends_with("-roof-pot")
        || name.contains("-roof-planter-")
}

/// Each thing's name by its origin id (`e_…`), from the facts.
fn names(text: &str) -> BTreeMap<String, String> {
    let facts = json::parse(text).expect("the facts");
    let mut out = BTreeMap::new();
    for t in facts.get("things").and_then(Json::arr).unwrap_or_default() {
        if let (Some(id), Some(name)) = (
            t.get("id").and_then(Json::str),
            t.get("name").and_then(Json::str),
        ) {
            out.insert(id.to_owned(), name.to_owned());
        }
    }
    out
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

/// What one building's things came to: things, pocket targets (a form's walk ended `souls:no-way` before), and those
/// a form's walk does not reach within reach of their middle, nor within reach of their footprint, and a plain walk
/// does not reach.
#[derive(Default)]
struct Count {
    things: usize,
    pocket: usize,
    form: usize,
    foot: usize,
    lost: usize,
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
    let mut kinds_by = BTreeMap::new();
    entries(
        std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../content/kinds"
        )),
        &mut kinds_by,
    );
    // Things a form's walk to the footprint still does not reach, by kind: how far from the footprint (µm) the nearest
    // place a body may stand lies, reached or not, within 3 m (none: farther). And what a refused plain walk was told.
    let mut far: BTreeMap<String, Vec<Option<i64>>> = BTreeMap::new();
    let mut refusals = Vec::new();
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
    // Each footprint walk's search time, and whether it reached the thing.
    let mut foot_calls: Vec<(Duration, bool)> = Vec::new();
    // Things a walk to be at ends on (`spots::walkable`), and things walked to, by kind.
    let mut onto: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    // The map's parts are found on the first walk: not timed with the first target.
    town.with_ground(|_, g| g.walk(ground, Vec3::ZERO, ground, Vec3::new(1_000_000, 0, 0)));
    let named = names(&text);
    let name_of = |id: Id| {
        let o = field(tree, id, import_eden::F_ORIGIN);
        named.get(&o).cloned().unwrap_or(o)
    };
    // #4083: each tower lamp and each terrace thing moved to the ground, and whether a form's walk (by the footprint)
    // and a plain walk reach it.
    let mut fixed_4083: Vec<(String, bool, bool)> = Vec::new();
    // Every thing a form's walk does not reach at its footprint, by name: kind, name, building.
    let mut unreached_named: Vec<String> = Vec::new();
    let ids: Vec<Id> = im.nodes.values().copied().collect();
    for id in ids {
        let Some((floor, at, _)) = town.view().on_floor(id, Vec3::ZERO) else {
            continue;
        };
        let moved = floor == ground && terrace_thing(&name_of(id));
        if (floor == ground && !moved) || floor == id {
            continue;
        }
        let Some(b) = parent(tree, floor) else {
            continue;
        };
        // A building with no doorway onto the ground (a tower whose floors no way reaches) from another's; a thing on
        // the open ground from the nearest doorway.
        let from = match door.get(&b) {
            Some(&p) => p,
            None if moved => *door
                .values()
                .min_by_key(|p| (p.x - at.x).abs() + (p.z - at.z).abs())
                .expect("a doorway"),
            None => {
                no_door += 1;
                *door.values().next().expect("a doorway")
            }
        };
        let target = Target::new(floor, at);
        let entry = tree
            .handle(id)
            .and_then(|h| tree.node(h))
            .and_then(|n| kinds_by.get(import_eden::entry_name(n.kind().as_str(), n.fields())));
        let on = entry.is_some_and(walkable);
        let shape = entry
            .and_then(footprint)
            .and_then(|(corners, _)| {
                let n = tree.node(tree.handle(id)?)?;
                let place = n.place()?;
                town.view().footprint_on_floor(
                    n.parent()?,
                    place.position,
                    place.orientation,
                    &corners,
                )
            })
            .filter(|(f, ..)| *f == floor);
        let (pocket, form, foot, walk, diag) = town.with_ground(|_, g| {
            let pocket =
                g.stand(floor, at).is_some() && g.walk(ground, from, floor, at).is_none();
            let t0 = Instant::now();
            let form = within(g, target, reach, Some((ground, from)));
            let t1 = Instant::now();
            let form = form.is_some_and(|p| g.walk(ground, from, floor, p).is_some());
            // As worldd plans a form's walk to a thing argument: by its footprint when its entry gives one.
            let t4 = Instant::now();
            let foot = match &shape {
                Some((_, ring, middle)) => {
                    within_footprint(g, Target::new(floor, *middle), ring, on, reach, Some((ground, from)))
                        .is_some_and(|p| g.walk(ground, from, floor, p).is_some())
                }
                None => form,
            };
            if shape.is_some() {
                foot_calls.push((t4.elapsed(), foot));
            }
            let near = (!foot).then(|| match &shape {
                Some((_, ring, middle)) => {
                    within_footprint(g, Target::new(floor, *middle), ring, false, 3_000_000, None)
                        .map(|p| to_outline(p, ring))
                }
                None => within(g, target, 3_000_000, None).map(|p| flat(p, at)),
            });
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
            let refused = match spots.of(walker, &target) {
                Some(Err(name)) => name,
                Some(Ok(_)) => "granted",
                None => "none",
            };
            (pocket, form, foot, walk, (near, refused))
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
        let building_name = name_of(b);
        if moved || (kind.starts_with("core-floor-lamp") && TOWERS.contains(&building_name.as_str())) {
            fixed_4083.push((format!("{} in {building_name}", name_of(id)), foot, walk));
        }
        if moved {
            continue;
        }
        if !foot {
            unreached_named.push(format!("{kind} {} in {building_name}", name_of(id)));
        }
        if let Some(d) = diag.0 {
            far.entry(kind.clone()).or_default().push(d);
        }
        if !walk {
            refusals.push(format!(
                "{kind} {} on {}: {}",
                field(tree, id, import_eden::F_ORIGIN),
                field(tree, floor, import_eden::F_ORIGIN),
                diag.1,
            ));
        }
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
            c.foot += usize::from(!foot);
            c.lost += usize::from(form && !foot);
            c.walk += usize::from(!walk);
        }
        let o = onto.entry(kind.clone()).or_default();
        o.0 += usize::from(on && shape.is_some());
        o.1 += 1;
        if kind.starts_with("core-school-desk") {
            desks.push((field(tree, id, import_eden::F_ORIGIN), pocket, form, walk));
        }
    }
    let sum = |m: &BTreeMap<String, Count>| {
        m.values().fold(Count::default(), |a, c| Count {
            things: a.things + c.things,
            pocket: a.pocket + c.pocket,
            form: a.form + c.form,
            foot: a.foot + c.foot,
            lost: a.lost + c.lost,
            walk: a.walk + c.walk,
        })
    };
    let all = sum(&by);
    let left = by.values().filter(|c| c.foot + c.walk > 0).count();
    println!(
        "things on building floors: {} in {} buildings ({no_door} more in buildings with no doorway onto the ground); \
         pocket targets (a form's walk ended souls:no-way before): {}, of them now reached by a form's walk {} and \
         by a plain walk {}; a form's walk does not reach within reach of the middle {}, of the footprint {}; a plain \
         walk does not reach {}, in {left} buildings; reached by the middle but not by the footprint (lost): {}",
        all.things,
        by.len(),
        all.pocket,
        fixed.0,
        fixed.1,
        all.form,
        all.foot,
        all.walk,
        all.lost
    );
    println!(
        "by building (pocket / form at middle unreached / form at footprint unreached / walk unreached of things):"
    );
    for (b, c) in &by {
        if c.pocket + c.form + c.foot + c.walk > 0 {
            println!(
                "  {b}: {} / {} / {} / {} of {}",
                c.pocket, c.form, c.foot, c.walk, c.things
            );
        }
    }
    println!("by kind:");
    for (k, c) in &kinds {
        if c.pocket + c.form + c.foot + c.walk > 0 {
            println!(
                "  {k}: {} / {} / {} / {} of {}",
                c.pocket, c.form, c.foot, c.walk, c.things
            );
        }
    }
    println!(
        "not reached at the footprint: the nearest place a body may stand, reached or not, mm from it (- none within \
         3 m), by kind:"
    );
    for (k, ds) in &far {
        let ds: Vec<String> = ds
            .iter()
            .map(|d| d.map_or("-".to_owned(), |d| (d / 1000).to_string()))
            .collect();
        println!("  {k}: {}", ds.join(" "));
    }
    println!("plain walk not reached:");
    for p in &refusals {
        println!("  {p}");
    }
    let unreached = |k: &str| {
        kinds
            .iter()
            .filter(|(n, _)| n.starts_with(k))
            .map(|(_, c)| c.foot)
            .sum::<usize>()
    };
    for k in ["core-workbench", "core-floor-lamp", "core-bookshelf"] {
        println!("{k}: {} not reached at the footprint", unreached(k));
    }
    println!("not reached at the footprint, by name:");
    for u in &unreached_named {
        println!("  {u}");
    }
    // #4083: Eden's 38 tower lamps stand on their central floor and its 35 roof-terrace things on the ground by their
    // building's door, and a form's walk and a plain walk reach each.
    // The vineyard villa's tower has no doorway onto the ground a walk reaches (none of its rooms is reached): its four
    // lamps move too but are not counted until it has one.
    let (shut, open): (Vec<_>, Vec<_>) = fixed_4083
        .iter()
        .partition(|t| t.0.ends_with(" in region-vineyard-villa-tower"));
    let lost_4083: Vec<_> = open.iter().filter(|t| !(t.1 && t.2)).collect();
    println!(
        "#4083: tower lamps and terrace things {} (and {} in the vineyard villa's tower, which no walk enters), not \
         reached {lost_4083:?}",
        open.len(),
        shut.len()
    );
    assert_eq!(open.len(), 34 + 35, "Eden's tower lamps and terrace things");
    assert!(lost_4083.is_empty(), "every tower lamp and terrace thing is reached");

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
    let mut reached: Vec<f64> = foot_calls.iter().filter(|c| c.1).map(|c| ms(c.0)).collect();
    let mut missed: Vec<f64> = foot_calls
        .iter()
        .filter(|c| !c.1)
        .map(|c| ms(c.0))
        .collect();
    reached.sort_by(f64::total_cmp);
    missed.sort_by(f64::total_cmp);
    println!(
        "footprint walks: {} reached, median {:.2} ms, max {:.2} ms; {} not reached, median {:.2} ms, max {:.2} ms",
        reached.len(),
        mid(&reached),
        top(&reached),
        missed.len(),
        mid(&missed),
        top(&missed)
    );
    println!("walked onto (walkable) of things, by kind:");
    for (k, (n, of)) in &onto {
        if *n > 0 || k.contains("bed") || k.contains("pool-table") {
            println!("  {k}: {n} of {of}");
        }
    }
    let onto_of = |k: &str| {
        onto.iter()
            .filter(|(n, _)| n.starts_with(k))
            .map(|(_, c)| c.0)
            .sum::<usize>()
    };
    assert_eq!(
        onto_of("core-bed"),
        0,
        "a bed is walked to its edge, not onto"
    );
    assert_eq!(
        onto_of("core-pool-table"),
        0,
        "a pool table is walked to its edge, not onto"
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
    assert_eq!(
        all.lost, 0,
        "no thing reached by its middle is lost by its footprint"
    );
    assert_eq!(
        unreached("core-workbench"),
        0,
        "every workbench is reached at its footprint"
    );
}
