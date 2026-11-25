//! `cargo run -p import-eden --release -- <facts.json> [--catalog <catalog.json>]`, from `v2/`: loads the facts file
//! the exporter wrote into a tree (K2) through commit, and prints the count table, load time and memory, the ids the
//! issue asks for, and, given today's catalog, the difference list by id.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this tool.
#![allow(clippy::disallowed_methods)]

use import_eden::json::{self, Json};
use import_eden::{
    F_DEF, F_NAME, F_ORIGIN, F_PLACE_KIND, F_PLACE_OF, Import, PLACE, WINDOW, count, load,
};
use replica::encode::Value;
use replica::world_model::plain;
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call is passed straight to the system allocator; the counters only add and subtract sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            let now = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
            PEAK.fetch_max(now, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn mb(n: usize) -> String {
    format!("{:.1} MB", n as f64 / 1e6)
}

fn text<'a>(im: &'a Import, v: Option<&'a Value>) -> String {
    match v {
        Some(Value::Text(n)) => n.as_str().to_owned(),
        Some(Value::Bytes(h)) => <[u8; 32]>::try_from(h.as_slice())
            .ok()
            .and_then(|h| im.texts.get(&h))
            .cloned()
            .unwrap_or_else(|| String::from_utf8_lossy(h).into_owned()),
        _ => String::new(),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .expect("usage: import-eden <facts.json> [--catalog <catalog.json>]");
    let catalog = args
        .iter()
        .position(|a| a == "--catalog")
        .and_then(|i| args.get(i + 1));
    let src = std::fs::read_to_string(path).expect("the facts file");
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let t0 = Instant::now();
    let im = load(&src).unwrap_or_else(|e| panic!("import refused: {e}"));
    let load_ms = t0.elapsed().as_secs_f64() * 1e3;
    let peak = PEAK.load(Relaxed) - base;
    drop(src);
    let held = LIVE.load(Relaxed);
    let (nodes, links) = im.tree.counts();
    println!(
        "loaded {nodes} nodes and {links} links in {load_ms:.0} ms (parse and commit, T2's checks on every change)"
    );
    println!(
        "held after load (the tree, its rules and the text table; the file's text dropped): {}; peak while loading, the file's text included: {}",
        mb(held),
        mb(peak)
    );

    let (rows, by_ref, extra) = count(&im);
    println!("\n| what | tree | replayed model's bake | equal |\n|---|---:|---:|---|");
    for r in &rows {
        println!(
            "| {} | {} | {} | {} |",
            r.what,
            r.tree,
            r.bake,
            if r.tree == r.bake { "yes" } else { "**no**" }
        );
    }
    let refs_equal = by_ref == im.by_ref;
    println!(
        "\nthings per def ref: {} refs in the tree, {} in the bake, every count equal: {refs_equal}",
        by_ref.len(),
        im.by_ref.len()
    );
    if !refs_equal {
        for (k, v) in &im.by_ref {
            let t = by_ref.get(k).copied().unwrap_or(0);
            if t != *v {
                println!("  {k}: tree {t}, bake {v}");
            }
        }
    }
    println!(
        "kinds: {} (T3 names; {} of today's def refs)",
        im.rules.kinds.len(),
        im.kinds.len()
    );
    println!("also: {extra:?}");
    println!(
        "notes ({}): {:?}",
        im.notes.len(),
        im.notes.iter().take(10).collect::<Vec<_>>()
    );
    println!(
        "left out of a full slot ({}), each a plain child at its own place:",
        im.left_out.len()
    );
    for l in &im.left_out {
        println!("  {l}");
    }
    println!(
        "Souls' bodies left out, not things ({}): {:?}",
        im.residents.len(),
        im.residents.iter().map(|(id, _)| id).collect::<Vec<_>>()
    );

    // The ids the issue asks for, and one window.
    let t = &im.tree;
    let mut queue = VecDeque::from([t.root()]);
    let mut window = None;
    let mut named: Vec<(String, String, String, String)> = Vec::new();
    while let Some(h) = queue.pop_front() {
        let n = t.node(h).expect("live");
        let k = plain(n.kind().as_str());
        if k == PLACE {
            named.push((
                text(&im, n.fields().get(&F_ORIGIN)),
                text(&im, n.fields().get(&F_PLACE_OF)),
                text(&im, n.fields().get(&F_PLACE_KIND)),
                text(&im, n.fields().get(&F_NAME)),
            ));
        }
        if k == WINDOW && window.is_none() {
            let p = n.parent().and_then(|p| t.handle(p)).and_then(|p| t.node(p));
            window = Some(format!(
                "{} ({}), under room {} ({})",
                replica::world_model::show(n.id()),
                text(&im, n.fields().get(&F_ORIGIN)),
                p.as_ref()
                    .map_or(String::new(), |p| replica::world_model::show(p.id())),
                p.as_ref()
                    .map_or(String::new(), |p| text(&im, p.fields().get(&F_NAME)))
            ));
        }
        queue.extend(t.children(h).expect("live").iter().copied());
    }
    for (origin, of, kind, name) in &named {
        let lower = name.to_lowercase();
        if of == "eden:water"
            || (of == "eden:shore" && lower.contains("west"))
            || lower.contains("canal")
        {
            println!(
                "place {} {origin} [{of} {kind}] {name}",
                replica::world_model::show(im.nodes[origin])
            );
        }
    }
    println!("window {}", window.unwrap_or_default());

    if let Some(c) = catalog {
        compare(
            &im,
            &std::fs::read_to_string(c).expect("the catalog"),
            &named,
        );
    }
}

/// Why a thing is in the tree and not in today's catalog, by its kind.
fn thing_reason(form: &str, def: &str) -> &'static str {
    let short = def
        .split('@')
        .next()
        .unwrap_or(def)
        .trim_start_matches("core-");
    if form != "point" {
        "a path or area thing: today's catalog lists no path or area as a thing (a named one is compared as a place)"
    } else if matches!(short, "cow" | "duck" | "koi" | "sheep" | "swan") {
        "an animal: today's catalog lists no thing of this kind"
    } else if matches!(
        short,
        "motorboat" | "narrowboat" | "balloon" | "eden-launch-balloon"
    ) {
        "a vehicle: today's catalog lists no thing of this kind"
    } else {
        "unexplained"
    }
}

/// Why a place is in one list and not the other, or matched another way.
fn place_reason(side: char, kind: &str, id: &str, matched_thing: bool) -> &'static str {
    match (side, kind) {
        ('C', "room") if matched_thing => {
            "matched: a room node (eden:room) of the building thing of that name"
        }
        ('C', "building") if matched_thing => {
            "matched: the building is the thing node of that name, with its floors and rooms below it"
        }
        ('C', "boat" | "stall" | "tent" | "kiosk" | "mill") if matched_thing => {
            "matched: a thing node of that name; today's server makes a place of a thing whose def has a place component, which is not in N1's list"
        }
        ('C', "channel") => {
            "a landform that is no hill or mountain (a path's grade): not in N1's list; it is a thing node"
        }
        ('C', "landmark") => {
            "not a landmark here: it stands inside a footpath's outline, and N1 names every footpath while today's server names none of these"
        }
        ('C', "outdoor") if id == "world" => {
            "the whole world as a place: the tree's open ground node (eden:ground)"
        }
        ('C', "walkable") => "a place today's server adds that no thing in the template places",
        ('T', "eden:landform eden:mountain") => {
            "a mountain range laid along a path: today's catalog has no place for it (it lists the one single peak)"
        }
        ('T', "eden:line eden:bridge" | "eden:line eden:footpath") => {
            "N1 names every footpath and bridge; today's catalog names only the two alpine paths"
        }
        ('T', "eden:shore eden:shore") => {
            "the river's shore: today's catalog makes a shore only for a water with an area shape, and the river is a path with a width"
        }
        _ => "unexplained",
    }
}

type Named = (String, String, String, String);

fn compare(im: &Import, catalog: &str, named: &[Named]) {
    let c = json::parse_skipping_fractions(catalog).expect("catalog JSON");
    let t = &im.tree;
    // Every thing node (origin -> def ref), thing names (name -> origin), and room origins (`e_…/room`).
    let mut tree_things: BTreeMap<String, String> = BTreeMap::new();
    let mut thing_named: BTreeMap<String, String> = BTreeMap::new();
    let mut rooms: BTreeSet<String> = BTreeSet::new();
    let mut queue = VecDeque::from([t.root()]);
    while let Some(h) = queue.pop_front() {
        let n = t.node(h).expect("live");
        let origin = text(im, n.fields().get(&F_ORIGIN));
        if n.fields().contains_key(&F_DEF) {
            if n.fields().contains_key(&F_NAME) {
                thing_named.insert(text(im, n.fields().get(&F_NAME)), origin.clone());
            }
            tree_things.insert(origin, text(im, n.fields().get(&F_DEF)));
        } else if plain(n.kind().as_str()) == import_eden::ROOM {
            rooms.insert(origin);
        }
        queue.extend(t.children(h).expect("live").iter().copied());
    }

    // Things, by id and by kind.
    let cat_things: BTreeMap<String, String> = c
        .get("things")
        .map(Json::arr)
        .unwrap_or(&[])
        .iter()
        .map(|x| {
            let f = |k| x.get(k).and_then(Json::str).unwrap_or("").to_owned();
            (f("id"), f("kind"))
        })
        .collect();
    let both = tree_things
        .keys()
        .filter(|k| cat_things.contains_key(*k))
        .count();
    let kind_differs = tree_things
        .iter()
        .filter(|(id, d)| {
            cat_things
                .get(*id)
                .is_some_and(|ck| ck != d.split('@').next().unwrap_or(d))
        })
        .count();
    let cat_only = cat_things
        .keys()
        .filter(|k| !tree_things.contains_key(*k))
        .count();
    println!("\n## Things against today's catalog\n");
    println!(
        "tree {}, catalog {}, in both by id {both}, of which with another kind {kind_differs}; only in the catalog {cat_only}.",
        tree_things.len(),
        cat_things.len()
    );
    let mut groups: BTreeMap<(&str, &str), Vec<&str>> = BTreeMap::new();
    for (id, d) in &tree_things {
        if !cat_things.contains_key(id) {
            let form = im.forms.get(d).map_or("?", String::as_str);
            groups
                .entry((thing_reason(form, d), d.as_str()))
                .or_default()
                .push(id);
        }
    }
    println!("\n| reason | kind | n | ids |\n|---|---|---:|---|");
    for ((reason, kind), ids) in &groups {
        println!("| {reason} | {kind} | {} | {} |", ids.len(), ids.join(" "));
    }

    // Places, by id: today's place id is `g-` and the name the template gives; a shore's adds `.shore-bank`.
    let cps = c.get("places").map(Json::arr).unwrap_or(&[]);
    let key_cat = |id: &str| {
        let id = id.strip_prefix("g-").unwrap_or(id);
        match id.strip_suffix(".shore-bank") {
            Some(w) => (w.to_owned(), true),
            None => (id.to_owned(), false),
        }
    };
    let mut cat: BTreeMap<(String, bool), (&str, &str)> = BTreeMap::new();
    for p in cps {
        let id = p.get("id").and_then(Json::str).unwrap_or("");
        cat.insert(
            key_cat(id),
            (id, p.get("kind").and_then(Json::str).unwrap_or("")),
        );
    }
    let mut tree: BTreeMap<(String, bool), &Named> = BTreeMap::new();
    for p in named {
        let shore = p.1 == "eden:shore";
        let name = if shore {
            p.3.trim_end_matches(" shore").to_owned()
        } else {
            p.3.clone()
        };
        tree.insert((name, shore), p);
    }
    let mut cat_kinds: BTreeMap<&str, i64> = BTreeMap::new();
    for (_, kind) in cat.values() {
        *cat_kinds.entry(kind).or_default() += 1;
    }
    let mut tree_kinds: BTreeMap<&str, i64> = BTreeMap::new();
    for p in tree.values() {
        *tree_kinds
            .entry(p.2.trim_start_matches("eden:"))
            .or_default() += 1;
    }
    println!("\n## Places against today's catalog\n");
    println!("by kind, catalog: {cat_kinds:?}\nby kind, tree: {tree_kinds:?}");
    let in_both = tree.keys().filter(|k| cat.contains_key(*k)).count();
    println!(
        "tree {}, catalog {}, in both by id {in_both}",
        tree.len(),
        cat.len()
    );
    let mut rows: BTreeMap<(char, String, &str), Vec<String>> = BTreeMap::new();
    for (k, (id, kind)) in &cat {
        if tree.contains_key(k) {
            continue;
        }
        // A room id is `<building name>.<room>`; the room node's origin is `<thing id>/<room>`.
        let matched = match *kind {
            "room" => k.0.split_once('.').is_some_and(|(b, r)| {
                thing_named
                    .get(b)
                    .is_some_and(|o| rooms.contains(&format!("{o}/{r}")))
            }),
            _ => thing_named.contains_key(&k.0),
        };
        let reason = place_reason('C', kind, id, matched);
        rows.entry(('C', (*kind).to_owned(), reason))
            .or_default()
            .push((*id).to_owned());
    }
    for (k, p) in &tree {
        if !cat.contains_key(k) {
            let what = format!("{} {}", p.1, p.2);
            let reason = place_reason('T', &what, &p.0, false);
            rows.entry(('T', what, reason))
                .or_default()
                .push(p.0.clone());
        }
    }
    println!("\n| side | kind | reason | n | ids |\n|---|---|---|---:|---|");
    for ((side, kind, reason), ids) in &rows {
        let side = if *side == 'C' {
            "catalog only"
        } else {
            "tree only"
        };
        println!(
            "| {side} | {kind} | {reason} | {} | {} |",
            ids.len(),
            ids.join(" ")
        );
    }
    let mut differ: BTreeMap<(String, &str), Vec<&str>> = BTreeMap::new();
    for (k, p) in &tree {
        if let Some((id, kind)) = cat.get(k) {
            let tk = p.2.trim_start_matches("eden:");
            if tk != *kind {
                let reason = match (tk, *kind) {
                    ("lake" | "pond" | "river", "water") => {
                        "the tree keeps the water's own kind; today's catalog says water"
                    }
                    ("zone", k) if k.ends_with(" zone") => {
                        "today's catalog adds the zone's use; the tree keeps the def's place kind, zone"
                    }
                    ("landmark", "mill") => {
                        "a windmill on its own: a landmark by N1's rule; today's server makes a place of its place component"
                    }
                    _ => "unexplained",
                };
                differ
                    .entry((format!("tree {tk}, catalog {kind}"), reason))
                    .or_default()
                    .push(id);
            }
        }
    }
    println!("\nin both, another kind:\n\n| kinds | reason | n | ids |\n|---|---|---:|---|");
    for ((kinds, reason), ids) in &differ {
        println!("| {kinds} | {reason} | {} | {} |", ids.len(), ids.join(" "));
    }
}
