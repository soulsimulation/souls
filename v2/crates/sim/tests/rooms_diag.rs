//! Scratch diagnosis (not for merge): why a form's walk does not reach things on Eden's building floors.

#![allow(clippy::disallowed_methods)]

mod common;

use replica::encode::Value;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::rules::json::{self, Value as Json};
use replica::world_model::show;
use sim::routes::Map;
use sim::spots::{Target, footprint, to_outline, walkable, within_footprint};
use sim::walk::town::in_passage_but;
use std::collections::BTreeMap;

fn text() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    std::fs::read_to_string(path).expect("facts")
}

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

fn mm(v: Vec3) -> String {
    format!("({},{},{})", v.x / 1000, v.y / 1000, v.z / 1000)
}

#[test]
#[ignore = "needs the exported Eden facts file"]
fn diagnose() {
    let text = text();
    let im = import_eden::load(&text).expect("Eden loads");
    let ground = im.nodes["ground"];
    let tree = &im.tree;
    let map = Map::build(tree, ground, &|_| 0).expect("the map");
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
        std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../content/kinds")),
        &mut kinds_by,
    );
    town.with_ground(|_, g| g.walk(ground, Vec3::ZERO, ground, Vec3::new(1_000_000, 0, 0)));
    let named = names(&text);
    let name_of = |id: Id| {
        let o = field(tree, id, import_eden::F_ORIGIN);
        named.get(&o).cloned().unwrap_or(o)
    };
    let buildings = town.buildings.clone();
    // Culprits over every unreached thing: (kind, end|line, width mm, same-floor ends?) -> places.
    let mut culprits: BTreeMap<String, usize> = BTreeMap::new();
    let mut classes: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut shown = 0;
    let mut on: BTreeMap<Id, Vec<(usize, usize, sim::links::Building)>> = BTreeMap::new();
    let want = [
        "kitchen-counter in cliff-house-15",
        "storeroom-shelf-2 in int-bakery",
        "commons-podium in commons-deck",
        "street-sack-3 in eden-market-1",
        "kitchen-chair-2 in canal-west-home-2",
        "kitchen-stool in artists-studio-5",
        "kitchen-table in region-farm-hamlet-farmhouse",
    ];
    let ids: Vec<Id> = im.nodes.values().copied().collect();
    let mut n_unreached = 0;
    for id in ids {
        let Some((floor, _, _)) = town.view().on_floor(id, Vec3::ZERO) else {
            continue;
        };
        if floor == ground || floor == id {
            continue;
        }
        let Some(b) = parent(tree, floor) else {
            continue;
        };
        let Some(&from) = door.get(&b) else {
            continue;
        };
        let def = field(tree, id, import_eden::F_DEF);
        if def.starts_with("cd:") {
            continue;
        }
        let entry = tree
            .handle(id)
            .and_then(|h| tree.node(h))
            .and_then(|n| kinds_by.get(import_eden::entry_name(n.kind().as_str(), n.fields())));
        let onto = entry.is_some_and(walkable);
        let shape = entry
            .and_then(footprint)
            .and_then(|(corners, _)| {
                let n = tree.node(tree.handle(id)?)?;
                let place = n.place()?;
                town.view()
                    .footprint_on_floor(n.parent()?, place.position, place.orientation, &corners)
            })
            .filter(|(f, ..)| *f == floor);
        let Some((_, ring, middle)) = shape else {
            continue;
        };
        let foot = town.with_ground(|_, g| {
            within_footprint(g, Target::new(floor, middle), &ring, onto, reach, Some((ground, from)))
                .is_some_and(|p| g.walk(ground, from, floor, p).is_some())
        });
        if foot {
            continue;
        }
        n_unreached += 1;
        let label = format!("{} in {}", name_of(id), name_of(b));
        // Scan the band round the outline on a 100 mm grid.
        let (mut lo, mut hi) = (ring[0], ring[0]);
        for c in &ring {
            lo = Vec3::new(lo.x.min(c.x), 0, lo.z.min(c.z));
            hi = Vec3::new(hi.x.max(c.x), 0, hi.z.max(c.z));
        }
        let step = 100_000;
        let mut cls: BTreeMap<&'static str, usize> = BTreeMap::new();
        let mut why: BTreeMap<String, usize> = BTreeMap::new();
        let mut x = lo.x - reach;
        while x <= hi.x + reach {
            x += step;
            let x = x - step;
            let mut z = lo.z - reach;
            while z <= hi.z + reach {
                let p = Vec3::new(x, middle.y, z);
                z += step;
                if to_outline(p, &ring) > reach {
                    continue;
                }
                let c = town.with_ground(|_, g| {
                    let Some((s, _)) = g.stand(floor, p) else {
                        return ("off", None);
                    };
                    if g.passage(floor, s) {
                        return ("passage", Some(s));
                    }
                    if !g.may_reach(ground, from, floor, s) {
                        return ("cut-off", None);
                    }
                    if g.walk(ground, from, floor, s).is_none() {
                        return ("no-walk", None);
                    }
                    ("reached", None)
                });
                *cls.entry(c.0).or_default() += 1;
                if let Some(s) = c.1 {
                    let here = on.entry(floor).or_insert_with(|| {
                        let mut v = Vec::new();
                        for (bi, bb) in buildings.iter().enumerate() {
                            for (li, l) in bb.links.iter().enumerate() {
                                if l.ends.iter().flatten().any(|e| e.floor == floor) {
                                    let mut one = bb.clone();
                                    one.links = vec![l.clone()];
                                    v.push((bi, li, one));
                                }
                            }
                        }
                        v
                    });
                    for (bi, li, one) in here.iter() {
                        let (bi, li) = (*bi, *li);
                        let l = &one.links[0];
                        {
                            if in_passage_but(std::slice::from_ref(one), &[], ground, floor, s, None) {
                                let by_end = l
                                    .ends
                                    .iter()
                                    .flatten()
                                    .filter(|e| e.floor == floor)
                                    .any(|e| sim::spots::to_segment(s, e.a, e.b) < sim::spots::CLEAR);
                                let key = format!(
                                    "{:?} {} w{} nodes-same={} b{} l{}",
                                    l.kind,
                                    if by_end { "end" } else { "line" },
                                    l.width / 1000,
                                    l.nodes[0] == l.nodes[1],
                                    bi,
                                    li
                                );
                                *why.entry(key).or_default() += 1;
                            }
                        }
                    }
                }
            }
        }
        for (k, v) in &cls {
            *classes.entry(k).or_default() += v;
        }
        for (k, v) in &why {
            let short: String = k.split(" b").next().unwrap_or("").to_owned();
            *culprits.entry(short).or_default() += v;
        }
        if shown < 12 || want.contains(&label.as_str()) {
            shown += 1;
            println!("== {label} ({def}) floor {} middle {} on={onto}", field(tree, floor, import_eden::F_ORIGIN), mm(middle));
            println!("   ring {:?}", ring.iter().map(|c| mm(*c)).collect::<Vec<_>>());
            println!("   classes {cls:?}");
            for (k, v) in &why {
                println!("   passage by {k}: {v}");
                // The link itself.
                let parts: Vec<&str> = k.split(' ').collect();
                let bi: usize = parts[parts.len() - 2][1..].parse().unwrap();
                let li: usize = parts[parts.len() - 1][1..].parse().unwrap();
                let l = &buildings[bi].links[li];
                let ends: Vec<String> = l
                    .ends
                    .iter()
                    .map(|e| match e {
                        Some(e) => format!(
                            "{}:{}-{}",
                            if e.floor == floor { "here" } else { "other" },
                            mm(e.a),
                            mm(e.b)
                        ),
                        None => "-".into(),
                    })
                    .collect();
                println!(
                    "     link {} kind {:?} width {} door {:?} ends {ends:?} line {:?} nodes [{}, {}]",
                    show(l.id),
                    l.kind,
                    l.width / 1000,
                    l.door.map(show),
                    l.line.iter().map(|c| mm(*c)).collect::<Vec<_>>(),
                    field(tree, l.nodes[0], import_eden::F_ORIGIN),
                    field(tree, l.nodes[1], import_eden::F_ORIGIN),
                );
            }
        }
    }
    println!("unreached things with a footprint: {n_unreached}");
    println!("places round them by class: {classes:?}");
    println!("passage places by culprit link (kind, end|line, width, same node):");
    for (k, v) in &culprits {
        println!("  {k}: {v}");
    }
}
