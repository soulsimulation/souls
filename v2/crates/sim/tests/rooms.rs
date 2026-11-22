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
//! Needs the exported Eden facts file: `cargo test -p sim --release --test rooms -- --ignored --nocapture`.

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
        let Some(&from) = door.get(&b) else {
            no_door += 1;
            continue;
        };
        let target = Target::new(floor, at);
        let entry = tree
            .handle(id)
            .and_then(|h| tree.node(h))
            .and_then(|n| kinds_by.get(import_eden::entry_name(n.kind().as_str(), n.fields())));
        let on = entry.is_some_and(walkable);
        let shape = entry
            .and_then(footprint)
            .and_then(|(corners, _)| town.view().footprint_on_floor(id, &corners))
            .filter(|(f, ..)| *f == floor);
        let (pocket, form, foot, walk, diag) = town.with_ground(|_, g| {
            let pocket =
                g.stand(floor, at).is_some() && g.walk(ground, from, floor, at).is_none();
            let form = within(g, target, reach, Some((ground, from)))
                .is_some_and(|p| g.walk(ground, from, floor, p).is_some());
            // As worldd plans a form's walk to a thing argument: by its footprint when its entry gives one.
            let foot = match &shape {
                Some((_, ring, middle)) => {
                    within_footprint(g, Target::new(floor, *middle), ring, on, reach, Some((ground, from)))
                        .is_some_and(|p| g.walk(ground, from, floor, p).is_some())
                }
                None => form,
            };
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
            };
            let walk = spots.write(g, &[ask], 0).is_ok()
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
