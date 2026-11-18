//! Routes with ability masks (Engine v2 N5, #2653).
//!
//! `cargo test -p sim --release --test routes -- --nocapture` runs the test world (A2, A3, A4). The Eden timing (A1)
//! needs N1's exported facts file (`node v2/tools/import-eden/export/export.ts` from the repository root) and runs
//! with `cargo test -p sim --release --test routes -- --ignored --nocapture`.

use import_eden::Import;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::world_model::show;
use sim::links::{Building, Kind};
use sim::routes::{ALL, CLIMB, HANDS, Hop, Map, Route, Spot};
use std::collections::BTreeMap;

fn testworld() -> Import {
    let w = testworld::generate(1, 0).expect("the test world");
    import_eden::load(&w.text).expect("the test world loads")
}

/// A version per node, made up and distinct, so a route's versions can be told from a default.
fn version_of(id: Id) -> u64 {
    1000 + id.counter() % 997
}

/// A standing spot on node `node`'s patch: the middle of its first piece's first triangle.
fn spot_on(map: &Map, node: Id) -> Spot {
    let (n, ..) = map.counts();
    (0..n as u32)
        .find(|&q| map.patch_of(q).node == node && !map.standing(q).is_empty())
        .map(|q| Spot {
            piece: q,
            at: map.standing(q)[0],
        })
        .expect("a piece on that node")
}

fn show_route(r: &Route) -> String {
    r.hops
        .iter()
        .map(|h| match h {
            Hop::Patch { at, piece } => match at.square {
                Some((i, j)) => format!("ground[{i},{j}]#{piece}@v{}", at.version),
                None => format!("{}#{piece}@v{}", show(at.node), at.version),
            },
            Hop::Link { id, kind } => format!("={kind:?} {}=", show(*id)),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Every 100 mm of the first piece's line stands on that piece (within 2 mm of it, for the grid's rounding); the
/// farthest off, mm.
fn check_first_line(map: &Map, from: Spot, r: &Route) -> i64 {
    let mut worst = 0;
    for w in r.first_line.windows(2) {
        let (a, b) = (w[0], w[1]);
        let l = ((b[0] - a[0]).pow(2) + (b[1] - a[1]).pow(2)).isqrt().max(1);
        for k in 0..=l / 100 + 1 {
            let s = (k * 100).min(l);
            let p = [a[0] + (b[0] - a[0]) * s / l, a[1] + (b[1] - a[1]) * s / l];
            let off = map.off_piece(from.piece, p);
            assert!(
                off <= 2,
                "the first line leaves its piece at {p:?} by {off} mm"
            );
            worst = worst.max(off);
        }
    }
    worst
}

/// A2, A3, A4 on the test world: from the square to the roof by the front door, the stair and the ladder.
#[test]
fn a2_a3_a4_masks_refusals_and_versions_on_the_test_world() {
    let im = testworld();
    let mut map = Map::build(&im.tree, im.nodes["ground"], &version_of).expect("the map");
    let (pieces, portals, links) = map.counts();
    println!(
        "test world map: {pieces} pieces, {portals} portals, {links} links; {} meets left off a piece they do not lie on",
        map.meets_elsewhere
    );
    assert!(map.unread.is_empty(), "{:?}", map.unread);
    let square = map
        .spot(im.nodes["ground"], Vec3::new(0, 0, 0))
        .expect("the square's middle stands on the open ground");
    let roof = spot_on(&map, im.nodes["building/floor-2"]);

    // A body with every ability: the square to the roof.
    let r = map
        .route(&im.tree, square, roof, ALL)
        .expect("a route to the roof");
    println!(
        "every ability, square to roof: {} ({} mm, {} portals searched)",
        show_route(&r),
        r.length,
        r.searched
    );
    let kinds: Vec<Kind> = r
        .hops
        .iter()
        .filter_map(|h| match h {
            Hop::Link { kind, .. } => Some(*kind),
            Hop::Patch { .. } => None,
        })
        .collect();
    assert!(
        kinds.contains(&Kind::Doorway)
            && kinds.contains(&Kind::Stairs)
            && kinds.contains(&Kind::Ladder)
    );
    check_first_line(&map, square, &r);

    // A4: each patch crossed, with its version.
    let crossed = r.patches();
    println!("A4 patches crossed with their versions:");
    for p in &crossed {
        println!("  {} {:?} version {}", show(p.node), p.square, p.version);
        assert_eq!(p.version, version_of(p.node));
    }
    assert!(
        crossed
            .iter()
            .any(|p| p.node == im.nodes["building/floor-2"])
    );

    // A2 and A3: a body that cannot climb is refused at the ladder; a body without hands at the first shut door.
    let no_climb = map.route(&im.tree, square, roof, HANDS).unwrap_err();
    println!("hands, no climb, square to roof: {no_climb}");
    let b = Building::read(&im.tree, im.nodes["building"]).unwrap();
    let ladder = b.links.iter().find(|l| l.kind == Kind::Ladder).unwrap();
    assert_eq!(no_climb.name, "no-route");
    assert_eq!(
        no_climb.detail,
        format!("link {}: link-needs-climb", show(ladder.id))
    );
    let no_hands = map.route(&im.tree, square, roof, CLIMB).unwrap_err();
    println!("climb, no hands, square to roof: {no_hands}");
    assert!(
        no_hands.detail.ends_with(": door-needs-hands"),
        "{no_hands}"
    );
    let door = b
        .links
        .iter()
        .find(|l| no_hands.detail == format!("link {}: door-needs-hands", show(l.id)))
        .expect("the refusal names a doorway of the building");
    assert_eq!(door.kind, Kind::Doorway);
    assert!(door.door.is_some());

    // From the foot of the ladder, past every door: a body without hands is refused at the ladder itself.
    let foot = ladder.ends[0].unwrap();
    let at_foot = map
        .spot(foot.floor, foot.middle())
        .expect("the ladder's foot");
    let no_hands = map.route(&im.tree, at_foot, roof, CLIMB).unwrap_err();
    println!("climb, no hands, ladder's foot to roof: {no_hands}");
    assert_eq!(
        no_hands.detail,
        format!("link {}: link-needs-hands", show(ladder.id))
    );
    let up = map.route(&im.tree, at_foot, roof, ALL).unwrap();
    println!("every ability, ladder's foot to roof: {}", show_route(&up));

    // The same body that cannot climb still goes anywhere the ladder is not needed: the square to the stair's top.
    let stair = b.links.iter().find(|l| l.kind == Kind::Stairs).unwrap();
    let top = stair.ends[1].unwrap();
    let at_top = map.spot(top.floor, top.middle()).expect("the stair's top");
    let r = map.route(&im.tree, square, at_top, HANDS).unwrap();
    println!(
        "hands, no climb, square to the stair's top: {}",
        show_route(&r)
    );
}

fn eden() -> Import {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    import_eden::load(&text).expect("Eden loads")
}

/// SplitMix64: the seeded pairs.
struct Seed(u64);

impl Seed {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const ROUTES: usize = 10_000;

/// A place: a piece of the given ones, chosen by the seed, and the middle of one of its triangles, by the seed.
fn place(map: &Map, among: &[u32], seed: &mut Seed) -> Spot {
    loop {
        let q = among[seed.below(among.len())];
        let st = map.standing(q);
        if !st.is_empty() {
            return Spot {
                piece: q,
                at: st[seed.below(st.len())],
            };
        }
    }
}

fn pct(v: &mut [u128], p: usize) -> u128 {
    v.sort_unstable();
    v[(v.len() * p / 100).min(v.len() - 1)]
}

/// Draws routes (world frame) over the open ground's pieces as an SVG, a unit a decimetre.
/// The open ground's pieces grey (orange when outside the largest part), floors' pieces blue (red outside it).
fn draw(
    map: &Map,
    ground: Id,
    parts: &[u32],
    main: u32,
    routes: &[(Spot, Spot, Route)],
    path: &str,
) {
    let (n, ..) = map.counts();
    let (mut lo, mut hi) = ([i64::MAX; 2], [i64::MIN; 2]);
    let mut shapes = String::new();
    for q in 0..n as u32 {
        let fill = match (map.patch_of(q).node == ground, parts[q as usize] == main) {
            (true, true) => "#e6e6e6",
            (true, false) => "#f4c27a",
            (false, true) => "#9fb7d9",
            (false, false) => "#e58f8f",
        };
        let mut d = String::new();
        for ring in &map.piece(q).outline {
            for (k, v) in ring.iter().enumerate() {
                let w = map.world(q, [i64::from(v[0]), i64::from(v[1]), i64::from(v[2])]);
                lo = [lo[0].min(w[0]), lo[1].min(w[2])];
                hi = [hi[0].max(w[0]), hi[1].max(w[2])];
                let c = if k == 0 { 'M' } else { 'L' };
                d.push_str(&format!("{c}{},{}", w[0] / 100, w[2] / 100));
            }
            d.push('Z');
        }
        shapes.push_str(&format!("<path fill=\"{fill}\" d=\"{d}\"/>"));
    }
    let colours = [
        "#d62728", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e", "#8c564b", "#e377c2", "#17becf",
        "#bcbd22", "#111111",
    ];
    let mut lines = String::new();
    for (k, (a, b, r)) in routes.iter().enumerate() {
        let c = colours[k % colours.len()];
        let mut pts = vec![map.world(a.piece, a.at)];
        pts.extend(r.waypoints.iter().copied());
        pts.push(map.world(b.piece, b.at));
        let s: Vec<String> = pts
            .iter()
            .map(|p| format!("{},{}", p[0] / 100, p[2] / 100))
            .collect();
        lines.push_str(&format!(
            "<polyline fill=\"none\" stroke=\"{c}\" stroke-width=\"40\" points=\"{}\"/><circle cx=\"{}\" cy=\"{}\" r=\"90\" fill=\"{c}\"/>",
            s.join(" "),
            pts[0][0] / 100,
            pts[0][2] / 100,
        ));
    }
    let (x, z, w, h) = (
        lo[0] / 100,
        lo[1] / 100,
        (hi[0] - lo[0]) / 100,
        (hi[1] - lo[1]) / 100,
    );
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{x} {z} {w} {h}\" width=\"1600\"><rect x=\"{x}\" y=\"{z}\" width=\"{w}\" height=\"{h}\" fill=\"#fff\"/><g fill-rule=\"evenodd\" stroke=\"#999\" stroke-width=\"1\">{shapes}</g>{lines}</svg>"
    );
    std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
    std::fs::write(path, svg).unwrap();
}

/// A1: 10,000 routes between seeded pairs of places across Eden, timed as the coarse search plus the first piece's
/// line; cold (a map just built, its portal distances filled as the run goes) and warm (the same pairs again), two
/// repeats, each on a map of its own.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a1_ten_thousand_routes_across_eden() {
    let im = eden();
    let ground = im.nodes["ground"];
    let t = std::time::Instant::now();
    let mut pick = Map::build(&im.tree, ground, &|_| 0).expect("the map");
    let built = t.elapsed().as_millis();
    let (pieces, portals, links) = pick.counts();
    println!(
        "A1 Eden map: {pieces} pieces, {portals} portals, {links} links; built in {built} ms; {} buildings not read; {} meets left off a piece they do not lie on",
        pick.unread.len(),
        pick.meets_elsewhere
    );
    for (id, e) in &pick.unread {
        println!("  not read: {}: {e}", show(*id));
    }
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    for l in pick.links() {
        let k = format!(
            "{:?}{} {}",
            l.kind,
            if l.door { " with a door" } else { "" },
            l.blocked.unwrap_or("crossable")
        );
        *kinds.entry(k).or_default() += 1;
    }
    println!("  links: {kinds:?}");
    // The places: pieces of the largest part of the map a body with every ability can walk.
    let parts = pick.parts(ALL);
    let mut size: BTreeMap<u32, usize> = BTreeMap::new();
    for &p in &parts {
        *size.entry(p).or_default() += 1;
    }
    let (&main, &biggest) = size
        .iter()
        .max_by_key(|(k, n)| (**n, std::cmp::Reverse(**k)))
        .unwrap();
    let ground_main = (0..pieces as u32)
        .filter(|&q| parts[q as usize] == main && pick.patch_of(q).node == ground)
        .count();
    let among: Vec<u32> = (0..pieces as u32)
        .filter(|&q| parts[q as usize] == main)
        .collect();
    let others: Vec<u32> = (0..pieces as u32)
        .filter(|&q| parts[q as usize] != main)
        .collect();
    println!(
        "  parts: {}; the largest holds {biggest} of {pieces} pieces ({ground_main} of them on the open ground)",
        size.len()
    );
    let floors: std::collections::BTreeSet<Id> = (0..pieces as u32)
        .map(|q| pick.patch_of(q).node)
        .filter(|&n| n != ground)
        .collect();
    let reached: std::collections::BTreeSet<Id> = among
        .iter()
        .map(|&q| pick.patch_of(q).node)
        .filter(|&n| n != ground)
        .collect();
    println!(
        "  floors with a piece in the largest part: {} of {}",
        reached.len(),
        floors.len()
    );
    // The floors outside it, by their thing's def: most are the ground's own cover (footpaths, lawns, shores), each
    // a floor of a thing of its own with no link to the open ground, which N3 cuts out of the open ground.
    let mut outside: BTreeMap<String, usize> = BTreeMap::new();
    for f in floors.difference(&reached) {
        let thing = im
            .tree
            .node(im.tree.handle(*f).unwrap())
            .unwrap()
            .parent()
            .unwrap();
        let def = match im
            .tree
            .node(im.tree.handle(thing).unwrap())
            .unwrap()
            .fields()
            .get(&import_eden::F_DEF)
        {
            Some(replica::encode::Value::Bytes(d)) => String::from_utf8_lossy(d).into_owned(),
            _ => String::new(),
        };
        *outside
            .entry(def.split('@').next().unwrap_or("").to_owned())
            .or_default() += 1;
    }
    let mut outside: Vec<(usize, String)> = outside.into_iter().map(|(k, n)| (n, k)).collect();
    outside.sort_by(|a, b| b.cmp(a));
    println!(
        "  floors outside it, by def (first 12): {:?}",
        &outside[..12.min(outside.len())]
    );
    // The next largest parts: pieces, of them on the open ground, floors, and where the part's first piece is.
    let mut by_size: Vec<(usize, u32)> = size.iter().map(|(&k, &n)| (n, k)).collect();
    by_size.sort_by_key(|&(n, k)| (std::cmp::Reverse(n), k));
    for &(n, k) in by_size.iter().skip(1).take(6) {
        let qs: Vec<u32> = (0..pieces as u32)
            .filter(|&q| parts[q as usize] == k)
            .collect();
        let on_ground = qs
            .iter()
            .filter(|&&q| pick.patch_of(q).node == ground)
            .count();
        let fl: std::collections::BTreeSet<Id> = qs
            .iter()
            .map(|&q| pick.patch_of(q).node)
            .filter(|&n| n != ground)
            .collect();
        let at = pick.world(k, pick.standing(k).first().copied().unwrap_or([0; 3]));
        println!(
            "    a part of {n} pieces ({on_ground} on the open ground, {} floors) at ({}, {}) m",
            fl.len(),
            at[0] / 1000,
            at[2] / 1000
        );
    }
    println!(
        "    parts of one piece: {}",
        by_size.iter().filter(|(n, _)| *n == 1).count()
    );
    let mut seed = Seed(2653);
    let pairs: Vec<(Spot, Spot)> = (0..ROUTES)
        .map(|_| {
            (
                place(&pick, &among, &mut seed),
                place(&pick, &among, &mut seed),
            )
        })
        .collect();
    // Refusals, timed apart: 20 pairs from the largest part to a piece outside it.
    let mut refused: BTreeMap<String, usize> = BTreeMap::new();
    let mut refused_us = Vec::new();
    for _ in 0..20 {
        let (a, b) = (
            place(&pick, &among, &mut seed),
            place(&pick, &others, &mut seed),
        );
        let t = std::time::Instant::now();
        let e = pick.route(&im.tree, a, b, ALL).expect_err("no route");
        refused_us.push(t.elapsed().as_micros());
        let why = e.detail.split(": ").last().unwrap_or("").to_owned();
        *refused.entry(why).or_default() += 1;
    }
    println!(
        "  20 refusals (largest part to elsewhere) {refused:?}: median {} us, max {} us",
        pct(&mut refused_us, 50),
        refused_us[refused_us.len() - 1]
    );
    let mut ten = Vec::new();
    for repeat in 0..2 {
        let t = std::time::Instant::now();
        let mut map = Map::build(&im.tree, ground, &|_| 0).expect("the map");
        println!(
            "  repeat {}: map built in {} ms",
            repeat + 1,
            t.elapsed().as_millis()
        );
        for pass in ["cold", "warm"] {
            let mut ns = Vec::with_capacity(ROUTES);
            let mut searched = Vec::with_capacity(ROUTES);
            let mut hops = Vec::with_capacity(ROUTES);
            for &(a, b) in &pairs {
                let t = std::time::Instant::now();
                let r = map.route(&im.tree, a, b, ALL).expect("a route");
                ns.push(t.elapsed().as_nanos());
                searched.push(u128::from(r.searched));
                hops.push(r.hops.len() as u128);
                let linked = r.hops.iter().any(|h| matches!(h, Hop::Link { .. }));
                let room = |l: bool| {
                    ten.iter()
                        .filter(|(_, _, t): &&(Spot, Spot, Route)| {
                            t.hops.iter().any(|h| matches!(h, Hop::Link { .. })) == l
                        })
                        .count()
                        < 5
                };
                if repeat == 0 && pass == "warm" && r.hops.len() > 6 && room(linked) {
                    ten.push((a, b, r));
                }
            }
            let total: u128 = ns.iter().sum();
            println!(
                "  repeat {} {pass}: median {} us, p99 {} us, max {} us, all {} ms; portals searched median {}, p99 {}; hops median {}, p99 {}",
                repeat + 1,
                pct(&mut ns, 50) / 1000,
                pct(&mut ns, 99) / 1000,
                ns[ns.len() - 1] / 1000,
                total / 1_000_000,
                pct(&mut searched, 50),
                pct(&mut searched, 99),
                pct(&mut hops, 50),
                pct(&mut hops, 99)
            );
        }
    }
    // Untimed: every route's first line stands on its first piece; how many routes cross a link, and which kinds.
    let (mut worst, mut linked) = (0, 0);
    let mut crossed: BTreeMap<String, usize> = BTreeMap::new();
    for &(a, b) in &pairs {
        let r = pick.route(&im.tree, a, b, ALL).expect("a route");
        worst = worst.max(check_first_line(&pick, a, &r));
        let mut any = false;
        for h in &r.hops {
            if let Hop::Link { kind, .. } = h {
                *crossed.entry(format!("{kind:?}")).or_default() += 1;
                any = true;
            }
        }
        linked += usize::from(any);
    }
    println!(
        "  every first line on its piece (farthest off {worst} mm); {linked} routes cross a link, {crossed:?}"
    );
    println!("  ten routes drawn (world frame, m):");
    for (a, b, r) in &ten {
        let w = |p: [i64; 3]| format!("({}, {}, {})", p[0] / 1000, p[1] / 1000, p[2] / 1000);
        println!(
            "    {} -> {}: {} hops, {} m, {} portals searched: {}",
            w(pick.world(a.piece, a.at)),
            w(pick.world(b.piece, b.at)),
            r.hops.len(),
            r.length / 1000,
            r.searched,
            show_route(r)
        );
    }
    draw(
        &pick,
        ground,
        &parts,
        main,
        &ten,
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../.local/routes/ten-routes.svg"
        ),
    );
}
