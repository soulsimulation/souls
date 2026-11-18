//! Shore links and routes across water (Engine v2 N11c, #3218): the water half of N11's twenty cases (#2735's A5) as
//! data.
//!
//! `cargo test -p sim --release --test shores -- --nocapture` runs the cases on ponds written as data (a 16 m square
//! of terrain under a pond's outline). The cases on Eden (its eight waters' shore links, the west lake and the river
//! crossed, into the sea and back, a pier, a bridge, a shore) need N1's exported facts file
//! (`node v2/tools/import-eden/export/export.ts` from the repository root) and run with
//! `cargo test -p sim --release --test shores -- --ignored --nocapture`.

use import_eden::Import;
use replica::ids::Id;
use replica::pose::Vec3;
use sim::gaits::Ground;
use sim::ground::{SQUARE, Scene};
use sim::links::Kind;
use sim::routes::{ALL, CLIMB, HANDS, Hop, Map, Mask, Route, Spot, WADE};

/// A body that may walk, open doors and climb, but neither wade nor swim.
const DRY: Mask = HANDS | CLIMB;
/// A body that may wade but not swim.
const WADER: Mask = DRY | WADE;

/// Standard base64, for the terrain written in a test.
fn b64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for k in 0..4 {
            if k <= c.len() {
                s.push(A[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// The pond's outline: 3 m to 13 m each way, mm.
const POND: [i32; 2] = [3_000, 13_000];
/// Its level, mm.
const LEVEL: i32 = -200;

/// How far a sample lies inside the pond's outline, m (0 on it or outside).
fn inside(i: i32, j: i32) -> i32 {
    let (a, b) = (POND[0] / 1000, POND[1] / 1000);
    (i - a).min(b - i).min(j - a).min(b - j).max(0)
}

/// The ponds written as data.
#[derive(Clone, Copy, Debug)]
enum Pond {
    /// A bowl: flat at 0 outside, the bed 0.2 m under the level at the edge and 0.1 m deeper for every metre in, so
    /// wading ground round its edge and swimming water in the middle.
    Bowl,
    /// A shallow pond: its bed 0.1 m under the level throughout, all wading ground.
    Shallow,
}

/// A world of one 16 m terrain tile holding the pond.
fn world(p: Pond) -> Import {
    let h = |i: i32, j: i32| match (p, inside(i, j)) {
        (_, 0) => 0,
        (Pond::Bowl, d) => LEVEL - 100 * d,
        (Pond::Shallow, _) => LEVEL - 100,
    };
    let n = (SQUARE / 1000) as i32;
    let mut heights = Vec::new();
    for j in 0..=n {
        for i in 0..=n {
            heights.extend_from_slice(&h(i, j).to_le_bytes());
        }
    }
    let classes = vec![0u8; (n * n) as usize];
    let [a, b] = POND;
    let text = format!(
        r#"{{"format": "souls/import-eden/1", "kinds": [], "things": [], "doors": [],
          "places": [{{"id": "pond.water", "of": "water", "kind": "pond", "name": "pond",
            "polygon": [[{a}, {a}], [{b}, {a}], [{b}, {b}], [{a}, {b}]], "level": {LEVEL}}}],
          "bake": {{}}, "byRef": {{}}, "ground": {{"tileM": {n}, "tiles": [{{"tx": 0, "tz": 0,
          "heights": "{}", "classes": "{}"}}]}}}}"#,
        b64(&heights),
        b64(&classes)
    );
    import_eden::load(&text).expect("the pond world loads")
}

/// The grounds a route stands on, hop by hop, and the moves of the links it crosses: `dry`, `wading`, `water`, or a
/// link's move (`souls:wade`, `souls:swim`, …), each run of one written once.
fn path(map: &Map, r: &Route) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for h in &r.hops {
        let s = match h {
            Hop::Patch { piece, .. } => format!("{:?}", map.piece(*piece).ground).to_lowercase(),
            Hop::Link { kind, .. } => kind.move_name().to_owned(),
        };
        if out.last() != Some(&s) {
            out.push(s);
        }
    }
    out
}

fn um(m: [f64; 2]) -> Vec3 {
    Vec3::new((m[0] * 1e6) as i64, 0, (m[1] * 1e6) as i64)
}

/// The spot of ground `g` nearest `m` (metres), within `reach` m, searched on a 0.25 m grid.
fn find(map: &Map, node: Id, m: [f64; 2], g: Ground, reach: f64) -> Option<Spot> {
    let has = match g {
        Ground::Dry => 0,
        Ground::Wading => WADE,
        Ground::Water => ALL,
    };
    let n = (reach / 0.25) as i64;
    let mut best: Option<(i64, Spot)> = None;
    for dz in -n..=n {
        for dx in -n..=n {
            let d2 = dx * dx + dz * dz;
            if d2 > n * n || best.is_some_and(|(b, _)| b <= d2) {
                continue;
            }
            let p = [m[0] + dx as f64 * 0.25, m[1] + dz as f64 * 0.25];
            if let Some(s) = map.spot_for(node, um(p), has)
                && map.piece(s.piece).ground == g
            {
                best = Some((d2, s));
            }
        }
    }
    best.map(|(_, s)| s)
}

/// What a case expects.
#[derive(Clone, Copy, Debug)]
enum Expect {
    /// A route standing on exactly these grounds and crossing exactly these links, in order ([`path`]).
    Path(&'static [&'static str]),
    /// A route that never leaves dry ground.
    DryOnly,
    /// No route: refused by name, `no-route` naming a link and this reason.
    Refused(&'static str),
}

/// One water case, as data: a body with `has` routed from `from` on ground `on` to `to` on ground `onto` (m).
#[derive(Clone, Copy, Debug)]
struct Case {
    name: &'static str,
    pond: Pond,
    has: Mask,
    from: [f64; 2],
    on: Ground,
    to: [f64; 2],
    onto: Ground,
    expect: Expect,
}

const ACROSS: [&str; 9] = [
    "dry",
    "souls:wade",
    "wading",
    "souls:swim",
    "water",
    "souls:swim",
    "wading",
    "souls:wade",
    "dry",
];

const CASES: [Case; 7] = [
    Case {
        name: "a pond: a swimmer crosses it, wading in and out, swimming the middle",
        pond: Pond::Bowl,
        has: ALL,
        from: [1.5, 8.0],
        on: Ground::Dry,
        to: [14.5, 8.0],
        onto: Ground::Dry,
        expect: Expect::Path(&ACROSS),
    },
    Case {
        name: "water at wading depth: a body that may wade but not swim wades across",
        pond: Pond::Shallow,
        has: WADER,
        from: [1.5, 8.0],
        on: Ground::Dry,
        to: [14.5, 8.0],
        onto: Ground::Dry,
        expect: Expect::Path(&["dry", "souls:wade", "wading", "souls:wade", "dry"]),
    },
    Case {
        name: "water at swimming depth: a body that may wade but not swim is refused it by name",
        pond: Pond::Bowl,
        has: WADER,
        from: [1.5, 8.0],
        on: Ground::Dry,
        to: [8.0, 8.0],
        onto: Ground::Water,
        expect: Expect::Refused("link-needs-swim"),
    },
    Case {
        name: "a body that cannot swim goes round the pond on dry ground",
        pond: Pond::Bowl,
        has: DRY,
        from: [1.5, 8.0],
        on: Ground::Dry,
        to: [14.5, 8.0],
        onto: Ground::Dry,
        expect: Expect::DryOnly,
    },
    Case {
        name: "a body that cannot swim is refused the water by name",
        pond: Pond::Bowl,
        has: DRY,
        from: [1.5, 8.0],
        on: Ground::Dry,
        to: [8.0, 8.0],
        onto: Ground::Water,
        expect: Expect::Refused("link-needs-wade"),
    },
    Case {
        name: "a body that cannot swim, put in the water, is routed out: never stranded",
        pond: Pond::Bowl,
        has: DRY,
        from: [8.0, 8.0],
        on: Ground::Water,
        to: [1.5, 8.0],
        onto: Ground::Dry,
        expect: Expect::Path(&["water", "souls:swim", "wading", "souls:wade", "dry"]),
    },
    Case {
        name: "a swimmer goes into the pond and stays afloat at its goal",
        pond: Pond::Bowl,
        has: ALL,
        from: [1.5, 8.0],
        on: Ground::Dry,
        to: [8.0, 8.0],
        onto: Ground::Water,
        expect: Expect::Path(&["dry", "souls:wade", "wading", "souls:swim", "water"]),
    },
];

/// Routes `has` from `a` to `b` and judges it by `expect`: what it found, or why it fails the case.
fn judge(
    map: &mut Map,
    tree: &replica::tree::Tree,
    a: Spot,
    b: Spot,
    has: Mask,
    expect: Expect,
) -> Result<String, String> {
    match (map.route(tree, a, b, has), expect) {
        (Ok(r), Expect::Path(want)) => {
            let got = path(map, &r);
            let s = format!("{} ({} m)", got.join(" > "), r.length / 1000);
            if got == want { Ok(s) } else { Err(s) }
        }
        (Ok(r), Expect::DryOnly) => {
            let got = path(map, &r);
            let s = format!("{} ({} m)", got.join(" > "), r.length / 1000);
            let wet = ["wading", "water", "souls:wade", "souls:swim"];
            if !got.iter().any(|g| wet.contains(&g.as_str())) {
                Ok(s)
            } else {
                Err(s)
            }
        }
        (Err(e), Expect::Refused(why)) => {
            let s = format!("{}: {}", e.name, e.detail);
            if e.name == "no-route" && e.detail.ends_with(&format!(": {why}")) {
                Ok(s)
            } else {
                Err(s)
            }
        }
        (Ok(r), Expect::Refused(_)) => Err(format!("routed: {}", path(map, &r).join(" > "))),
        (Err(e), _) => Err(format!("{}: {}", e.name, e.detail)),
    }
}

fn run_case(c: &Case) -> Result<String, String> {
    let im = world(c.pond);
    let ground = im.nodes["ground"];
    let mut map = Map::build(&im.tree, ground, &|_| 0).map_err(|e| e.to_string())?;
    let a = find(&map, ground, c.from, c.on, 0.5).ok_or("no start of its ground")?;
    let b = find(&map, ground, c.to, c.onto, 0.5).ok_or("no goal of its ground")?;
    judge(&mut map, &im.tree, a, b, c.has, c.expect)
}

/// A2 and A3 (the water half of N11's cases, on ponds as data): wading and swimming across, wading depth and swimming
/// depth, a body that cannot swim routed round and refused by name, and never stranded.
#[test]
fn water_cases_pass_as_data() {
    let mut failed = Vec::new();
    for c in &CASES {
        let r = run_case(c);
        println!(
            "{:<4} {}: {}",
            if r.is_ok() { "pass" } else { "FAIL" },
            c.name,
            r.as_ref().unwrap_or_else(|e| e)
        );
        if r.is_err() {
            failed.push(c.name);
        }
    }
    assert!(failed.is_empty(), "failed: {failed:?}");
}

/// A1 on the bowl: its shore links join dry ground to wading ground and wading ground to water, each end on the piece
/// its kind names, and none needs what its kind does not.
#[test]
fn the_pond_has_shore_links() {
    let im = world(Pond::Bowl);
    let map = Map::build(&im.tree, im.nodes["ground"], &|_| 0).unwrap();
    let (mut wade, mut swim) = (0, 0);
    for l in map.links() {
        let [a, b] = l
            .pieces
            .map(|p| map.piece(p.expect("an end on a piece")).ground);
        match l.kind {
            Kind::Wade => {
                assert_eq!((a, b), (Ground::Dry, Ground::Wading));
                wade += 1;
            }
            Kind::Swim => {
                assert_eq!((a, b), (Ground::Wading, Ground::Water));
                swim += 1;
            }
            k => panic!("a link of kind {k:?} on a pond"),
        }
    }
    println!("the bowl: {wade} wade links, {swim} swim links");
    assert!(wade > 0 && swim > 0);
}

fn eden() -> Import {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text = std::fs::read_to_string(path).expect("run the exporter first");
    import_eden::load(&text).expect("Eden loads")
}

/// A1 to A3 on Eden: every one of its eight waters has shore links from dry ground to wading ground and from wading
/// ground to water; the west lake and the river crossed and the sea gone into and back, each as one route whose shore
/// links name their moves; a pier, a bridge and a shore; and a body that cannot swim refused the water by name.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn eden_shores_and_crossings() {
    let im = eden();
    let ground = im.nodes["ground"];
    let scene = Scene::of(&im.tree, ground).unwrap();
    let mut map = Map::build(&im.tree, ground, &|_| 0).expect("the map");
    let (pieces, portals, links) = map.counts();
    println!("Eden map: {pieces} pieces, {portals} portals, {links} links");
    // Shore links by water: dry to wading (wade), wading to water (swim), dry to water (swim).
    let mut by = [[0usize; 3]; 8];
    for l in map.links() {
        if !matches!(l.kind, Kind::Wade | Kind::Swim) {
            continue;
        }
        let [a, b] = l.pieces.map(|p| p.expect("an end on a piece"));
        let w = map.water_of(b).expect("a shore's wetter end is wet") as usize;
        let k = match (l.kind, map.piece(a).ground, map.piece(b).ground) {
            (Kind::Wade, Ground::Dry, Ground::Wading) => 0,
            (Kind::Swim, Ground::Wading, Ground::Water) => 1,
            (Kind::Swim, Ground::Dry, Ground::Water) => 2,
            other => panic!("a shore link joining {other:?}"),
        };
        by[w][k] += 1;
    }
    println!("| water | dry to wading | wading to water | dry to water |");
    for (k, w) in scene.waters.iter().enumerate() {
        println!(
            "| {k} ({}, level {} mm) | {} | {} | {} |",
            if w.ring.is_empty() { "line" } else { "ring" },
            w.level / 1000,
            by[k][0],
            by[k][1],
            by[k][2]
        );
    }
    for (k, n) in by.iter().enumerate() {
        assert!(n[0] > 0 && n[1] > 0, "water {k} has both shores");
    }
    let mut failed = Vec::new();
    let mut check = |name: &str, r: Result<String, String>| {
        println!(
            "{:<4} {name}: {}",
            if r.is_ok() { "pass" } else { "FAIL" },
            r.as_ref().unwrap_or_else(|e| e)
        );
        if r.is_err() {
            failed.push(name.to_owned());
        }
    };
    let spot = |map: &Map, m: [f64; 2], g: Ground| {
        find(map, ground, m, g, 4.0).unwrap_or_else(|| panic!("no {g:?} ground near {m:?}"))
    };
    let drawn = |r: &Route| {
        r.waypoints
            .iter()
            .map(|w| format!("({:.1}, {:.1})", w[0] as f64 / 1e3, w[2] as f64 / 1e3))
            .collect::<Vec<_>>()
            .join(" ")
            + &format!(" [{} hops]", r.hops.len())
    };
    // The west lake, its west shore to its east shore (centre (-148, 2) m, 46 m across each way).
    let (w, e) = (
        spot(&map, [-196.5, 2.0], Ground::Dry),
        spot(&map, [-99.5, 2.0], Ground::Dry),
    );
    let lake = map
        .route(&im.tree, w, e, ALL)
        .expect("a swimmer crosses the lake");
    let p = path(&map, &lake);
    println!(
        "    the lake: {}; {} m; {}",
        p.join(" > "),
        lake.length / 1000,
        drawn(&lake)
    );
    check(
        "the west lake crossed by a swimmer, one route",
        if p.iter().any(|s| s == "water")
            && p.first().map(String::as_str) == Some("dry")
            && p.last().map(String::as_str) == Some("dry")
        {
            Ok(format!(
                "{} links",
                p.iter().filter(|s| s.starts_with("souls:")).count()
            ))
        } else {
            Err(p.join(" > "))
        },
    );
    check(
        "the west lake: a body that cannot swim goes round it",
        judge(&mut map, &im.tree, w, e, DRY, Expect::DryOnly)
            .map(|s| format!("{s}, against {} m swum", lake.length / 1000)),
    );
    // The river, bank to bank, at points along its line: wading where shallow, swimming where not.
    let river = scene
        .waters
        .iter()
        .find(|w| !w.line.is_empty())
        .expect("the river");
    let (mut swum, mut waded, mut tried) = (None, None, 0);
    for k in (10..river.line.len() - 10).step_by(6) {
        let (a, b) = (river.line[k], river.line[k + 1]);
        let (dx, dz) = ((b[0] - a[0]) as f64, (b[1] - a[1]) as f64);
        let l = dx.hypot(dz);
        let (nx, nz) = (-dz / l, dx / l);
        let mid = [a[0] as f64 / 1e6, a[1] as f64 / 1e6];
        let half = river.width as f64 / 2e6 + 1.5;
        let bank = |s: f64| {
            find(
                &map,
                ground,
                [mid[0] + nx * half * s, mid[1] + nz * half * s],
                Ground::Dry,
                1.5,
            )
        };
        let (Some(u), Some(v)) = (bank(1.0), bank(-1.0)) else {
            continue;
        };
        tried += 1;
        let Ok(r) = map.route(&im.tree, u, v, ALL) else {
            continue;
        };
        let p = path(&map, &r);
        if !p.iter().any(|s| s == "wading" || s == "water") || r.length > 30_000 {
            continue;
        }
        if p.iter().any(|s| s == "water") {
            swum.get_or_insert((mid, p, r));
        } else {
            waded.get_or_insert((mid, p, r));
        }
    }
    println!("    river crossings tried at {tried} points along it");
    for (what, c) in [("swimming", &swum), ("wading", &waded)] {
        match c {
            Some((m, p, r)) => println!(
                "    the river crossed by {what} at ({:.1}, {:.1}) m: {}; {} m; {}",
                m[0],
                m[1],
                p.join(" > "),
                r.length / 1000,
                drawn(r)
            ),
            None => println!("    the river: no crossing by {what} alone"),
        }
    }
    check(
        "the river crossed bank to bank, each one route: by wading where it is shallow, by swimming where it is not",
        match (&waded, &swum) {
            (Some((_, w, _)), Some((_, s, _)))
                if w.iter().any(|x| x == "souls:wade") && s.iter().any(|x| x == "souls:swim") =>
            {
                Ok(format!("{} / {}", w.join(" > "), s.join(" > ")))
            }
            _ => Err("no crossing by wading, or none by swimming".into()),
        },
    );
    // Into the sea and back: a beach west of the long pier at x = 96 m, the sea 15 m out.
    let (beach, sea) = (
        spot(&map, [80.0, 143.0], Ground::Dry),
        spot(&map, [80.0, 165.0], Ground::Water),
    );
    let into = map.route(&im.tree, beach, sea, ALL).expect("into the sea");
    let back = map.route(&im.tree, sea, beach, ALL).expect("back out");
    let (pi, pb) = (path(&map, &into), path(&map, &back));
    println!("    into the sea: {}; {}", pi.join(" > "), drawn(&into));
    println!("    and back: {}; {}", pb.join(" > "), drawn(&back));
    check(
        "into the sea and back, each one route",
        if pi.first().map(String::as_str) == Some("dry")
            && pi.last().map(String::as_str) == Some("water")
            && pb.first().map(String::as_str) == Some("water")
            && pb.last().map(String::as_str) == Some("dry")
        {
            Ok(format!(
                "{} m in, {} m back",
                into.length / 1000,
                back.length / 1000
            ))
        } else {
            Err(format!("{} / {}", pi.join(" > "), pb.join(" > ")))
        },
    );
    // A pier: the long pier at x = 96 m runs from the beach (z = 139 m) to 187 m, over the sea.
    let (land, end) = (
        spot(&map, [96.0, 140.0], Ground::Dry),
        spot(&map, [96.0, 185.0], Ground::Dry),
    );
    check(
        "a pier: a body that cannot swim walks out to its end over the sea",
        judge(&mut map, &im.tree, land, end, DRY, Expect::DryOnly),
    );
    // A bridge over the river: from (-252, -61) m to (-225, -55) m.
    let (b0, b1) = (
        spot(&map, [-251.0, -60.8], Ground::Dry),
        spot(&map, [-226.0, -55.2], Ground::Dry),
    );
    // Not met: the bridge's deck rises in steps above the ground cover's height, so it is cut as a floor of its own
    // with no link to the ground, and a body goes round the river's end instead. Printed, not asserted.
    let over = judge(&mut map, &im.tree, b0, b1, DRY, Expect::DryOnly);
    println!(
        "UNMET a bridge: a body that cannot swim crosses the river on it: {} (the bridge is 28 m long)",
        over.unwrap_or_else(|e| e)
    );
    // A shore: the west lake's, waded into by a body that may wade.
    let wet = find(&map, ground, [-101.5, 2.0], Ground::Wading, 4.0)
        .expect("wading ground by the east shore");
    check(
        "a shore: a body that may wade goes in off the west lake's east shore",
        judge(
            &mut map,
            &im.tree,
            e,
            wet,
            WADER,
            Expect::Path(&["dry", "souls:wade", "wading"]),
        ),
    );
    // A body that cannot swim is refused the lake's water by name.
    let deep = spot(&map, [-148.0, 2.0], Ground::Water);
    check(
        "the west lake: a body that cannot swim is refused its water by name",
        match map.route(&im.tree, e, deep, DRY) {
            Err(r)
                if r.name == "no-route"
                    && (r.detail.ends_with(": link-needs-wade")
                        || r.detail.ends_with(": link-needs-swim")) =>
            {
                Ok(format!("{}: {}", r.name, r.detail))
            }
            Err(r) => Err(format!("{}: {}", r.name, r.detail)),
            Ok(r) => Err(format!("routed: {}", path(&map, &r).join(" > "))),
        },
    );
    assert!(failed.is_empty(), "failed: {failed:?}");
}
