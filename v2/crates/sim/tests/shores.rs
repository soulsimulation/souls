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
    // Its deck joins the ground by steps since #3224 (#3226).
    check(
        "a bridge: a body that cannot swim crosses the river on it (the bridge is 28 m long)",
        judge(&mut map, &im.tree, b0, b1, DRY, Expect::DryOnly),
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

// Walkers across shores (#3225): the walk skill through the runner and the controller, wading and swimming.

mod common;

use replica::host::Progress;
use sim::gaits::{SWIM as SWIM_GAIT, WADE as WADE_GAIT};
use sim::host::Runner;
use sim::walk::town::Town;

const TICK: i64 = 50_000;
const WALK: i64 = 1_400_000;

/// What one walk did, tick by tick: the ground the body stood on at each tick's end, how far it moved in the tick
/// (µm, along the surface) and on which ground it began and ended the tick; how the walk ended and where.
struct Walked {
    grounds: Vec<Ground>,
    steps: Vec<(Ground, Ground, i64)>,
    end: Option<Progress>,
    at: Vec3,
}

impl Walked {
    /// The grounds stood on, each run of one written once.
    fn path(&self) -> Vec<Ground> {
        let mut out: Vec<Ground> = Vec::new();
        for g in &self.grounds {
            if out.last() != Some(g) {
                out.push(*g);
            }
        }
        out
    }

    /// The median move a tick on ground `g` (begun and ended on it, moving), m/s.
    fn median(&self, g: Ground) -> Option<f64> {
        let mut v: Vec<i64> = (self.steps.iter())
            .filter(|s| s.0 == g && s.1 == g && s.2 > 0)
            .map(|s| s.2)
            .collect();
        v.sort_unstable();
        v.get(v.len() / 2)
            .map(|&d| d as f64 * 1e6 / TICK as f64 / 1e6)
    }
}

/// The fastest a body moves in a tick on `g`, µm: its gait's speed in water, else the walk's.
fn most(g: Ground) -> i64 {
    match g {
        Ground::Dry => WALK,
        Ground::Wading => WADE_GAIT.speed,
        Ground::Water => SWIM_GAIT.speed,
    }
}

/// Runs `who`'s walk on `r` over `t` until it ends (at most `ticks`), checking every tick: no move longer than the
/// fastest of the grounds it began and ended the tick on (within 2 %, the mover's walk again for a slope), and never
/// on ground the body may not stand on.
fn run(r: &mut Runner, t: &mut Town, who: Id, has: Mask, ticks: usize) -> Walked {
    let mut w = Walked {
        grounds: Vec::new(),
        steps: Vec::new(),
        end: None,
        at: Vec3::ZERO,
    };
    let at = |r: &Runner| r.controller.body(who).expect("the body").pose.position;
    for _ in 0..ticks {
        let (was, g0) = (at(r), r.controller.ground(who));
        r.tick(t).expect("a tick");
        let (now, g1) = (at(r), r.controller.ground(who));
        let d = common::dist(was, now);
        assert!(
            d <= most(g0).max(most(g1)) * TICK / 1_000_000 * 102 / 100 + 1,
            "no jump: {d} µm in a tick from {g0:?} to {g1:?}"
        );
        assert!(sim::routes::may_stand(g1, has), "{g1:?} with {has}");
        w.grounds.push(g1);
        w.steps.push((g0, g1, d));
        if let Some((_, p)) = r.ended.get(&who) {
            w.end = Some(p.clone());
            break;
        }
    }
    w.at = at(r);
    w
}

/// A town and a runner on `im`.
fn walkers(im: Import) -> (Town, Runner) {
    let (t, _) = common::town_of(im, b"souls/shores-walk/1");
    (t, Runner::new(TICK))
}

/// `who` stood at `from` (µm) on the open ground, with abilities `has`, walks to `to`: planned by the town (or given
/// `legs`), run to its end.
fn cross(
    im: Import,
    who: Id,
    has: Mask,
    from: Vec3,
    to: Vec3,
    legs: Option<&[sim::walk::Leg]>,
) -> (Walked, Vec<sim::walk::Leg>, Town) {
    let (mut t, mut r) = walkers(im);
    let ground = t.ground;
    t.allow(who, has);
    let body = common::stand(&t, who, ground, from);
    let legs = match legs {
        Some(l) => {
            r.add(common::humanoid(), body, common::route(l, WALK, TICK))
                .expect("a walker");
            l.to_vec()
        }
        None => common::walk(&mut r, &mut t, body, WALK, ground, to).expect("a route"),
    };
    let w = run(&mut r, &mut t, who, has, 20_000);
    (w, legs, t)
}

fn shores(t: &Town, legs: &[sim::walk::Leg]) -> Vec<&'static str> {
    legs.iter()
        .filter_map(|l| t.map.shore(l.link?).map(|s| s.0.move_name()))
        .collect()
}

/// A1 and A2 on the pond (a bowl: wading ground round its edge, water in the middle): a swimmer walks across it
/// through the runner, wading and swimming at the gaits' speeds, and leaves the water on the far shore; a body that
/// may not swim walks round on dry ground; given the swimmer's route, it is refused by name at the first shore and
/// stays on dry ground.
#[test]
fn walkers_cross_the_pond() {
    let (from, to) = (
        Vec3::new(1_500_000, 0, 8_000_000),
        Vec3::new(14_500_000, 0, 8_000_000),
    );
    let swimmer = common::id(1);
    let (w, legs, t) = cross(world(Pond::Bowl), swimmer, ALL, from, to, None);
    let names = shores(&t, &legs);
    println!(
        "swimmer: legs {}, shores {names:?}; grounds {:?}; {} ticks; median m/s dry {:?}, wading {:?}, water {:?}; ended {:?} at ({:.2}, {:.2}) m",
        legs.len(),
        w.path(),
        w.grounds.len(),
        w.median(Ground::Dry),
        w.median(Ground::Wading),
        w.median(Ground::Water),
        w.end,
        w.at.x as f64 / 1e6,
        w.at.z as f64 / 1e6
    );
    assert_eq!(
        names,
        ["souls:wade", "souls:swim", "souls:swim", "souls:wade"]
    );
    assert_eq!(
        w.path(),
        [
            Ground::Dry,
            Ground::Wading,
            Ground::Water,
            Ground::Wading,
            Ground::Dry
        ]
    );
    assert_eq!(w.end, Some(Progress::Done), "arrived");
    assert!(common::dist(w.at, Vec3::new(to.x, w.at.y, to.z)) <= 300_000);
    for (g, gait) in [(Ground::Wading, WADE_GAIT), (Ground::Water, SWIM_GAIT)] {
        let v = w.median(g).expect("moved on it") * 1e6;
        assert!(
            (v / gait.speed as f64 - 1.0).abs() <= 0.03,
            "{g:?}: {v} µm/s"
        );
    }

    // A body that may not swim (nor wade) walks round the pond on dry ground.
    let walker = common::id(2);
    let (d, dry_legs, t2) = cross(world(Pond::Bowl), walker, DRY, from, to, None);
    println!(
        "walker: legs {}, shores {:?}; grounds {:?}; {} ticks; ended {:?}",
        dry_legs.len(),
        shores(&t2, &dry_legs),
        d.path(),
        d.grounds.len(),
        d.end
    );
    assert!(shores(&t2, &dry_legs).is_empty());
    assert_eq!(d.path(), [Ground::Dry]);
    assert_eq!(d.end, Some(Progress::Done), "arrived round the pond");

    // Given the swimmer's route anyway, it is refused at the first shore by name, and stands on dry ground.
    let (o, _, t3) = cross(world(Pond::Bowl), walker, DRY, from, to, Some(&legs));
    println!(
        "walker offered the swimmer's route: grounds {:?}; {} ticks; ended {:?} at ({:.2}, {:.2}) m",
        o.path(),
        o.grounds.len(),
        o.end,
        o.at.x as f64 / 1e6,
        o.at.z as f64 / 1e6
    );
    assert_eq!(o.path(), [Ground::Dry]);
    match &o.end {
        Some(Progress::Failed(n)) => assert_eq!(n.as_str(), "link-needs-wade"),
        other => panic!("ended {other:?}"),
    }
    let ground = t3.ground;
    let frame = replica::pose::Frame {
        node: ground,
        slot: None,
    };
    assert!(
        t3.surfaces[&ground]
            .place(walker, frame, o.at, replica::pose::Quat::IDENTITY)
            .is_ok(),
        "on dry ground"
    );
    assert!(t3.map.spot(ground, o.at).is_some(), "on a dry piece");
}

/// A1 on Eden: a swimmer walks across the west lake shore to shore, and across the river bank to bank where it wades
/// and where it swims, through the runner, at the gaits' speeds; a body that may not swim walks round the lake dry.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn walkers_cross_eden_waters() {
    let im = eden();
    let ground = im.nodes["ground"];
    let scene = Scene::of(&im.tree, ground).unwrap();
    let map = Map::build(&im.tree, ground, &|_| 0).expect("the map");
    let at = |s: Spot| Vec3::new(s.at[0] * 1000, 0, s.at[2] * 1000);
    let spot = |m: [f64; 2]| find(&map, ground, m, Ground::Dry, 4.0).expect("dry ground");
    let mut runs = vec![(
        "the west lake".to_owned(),
        at(spot([-196.5, 2.0])),
        at(spot([-99.5, 2.0])),
        Ground::Water,
    )];
    // The river, bank to bank: the first place a swimmer's route wades only, and the first it swims.
    let river = scene
        .waters
        .iter()
        .find(|w| !w.line.is_empty())
        .expect("the river");
    let mut m2 = Map::build(&im.tree, ground, &|_| 0).expect("the map");
    let (mut waded, mut swum) = (None, None);
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
        let Ok(r) = m2.route(&im.tree, u, v, ALL) else {
            continue;
        };
        let p = path(&m2, &r);
        if r.length > 30_000 || !p.iter().any(|s| s == "wading" || s == "water") {
            continue;
        }
        let name = format!("the river at ({:.1}, {:.1}) m", mid[0], mid[1]);
        if p.iter().any(|s| s == "water") {
            swum.get_or_insert((name, at(u), at(v), Ground::Water));
        } else {
            waded.get_or_insert((name, at(u), at(v), Ground::Wading));
        }
    }
    runs.extend(waded);
    runs.extend(swum);
    assert_eq!(runs.len(), 3, "the lake, and the river waded and swum");
    for (k, (name, from, to, deepest)) in runs.into_iter().enumerate() {
        let (w, legs, t) = cross(eden(), common::id(10 + k as u64), ALL, from, to, None);
        let names = shores(&t, &legs);
        let secs = w.grounds.len() as f64 * TICK as f64 / 1e6;
        println!(
            "{name}: shores {names:?}; grounds {:?}; {secs:.1} s; median m/s dry {:?}, wading {:?}, water {:?}; ended {:?}",
            w.path(),
            w.median(Ground::Dry),
            w.median(Ground::Wading),
            w.median(Ground::Water),
            w.end
        );
        assert_eq!(w.end, Some(Progress::Done), "{name}: arrived");
        assert!(w.path().contains(&deepest), "{name}: in the water");
        assert_eq!(w.path().first(), Some(&Ground::Dry));
        assert_eq!(w.path().last(), Some(&Ground::Dry), "{name}: out on the far shore");
        for (g, gait) in [(Ground::Wading, WADE_GAIT), (Ground::Water, SWIM_GAIT)] {
            if let Some(v) = w.median(g) {
                assert!(
                    (v * 1e6 / gait.speed as f64 - 1.0).abs() <= 0.03,
                    "{name}: {g:?} at {v} m/s"
                );
            }
        }
        if k == 0 {
            let (d, dl, t2) = cross(eden(), common::id(20), DRY, from, to, None);
            println!(
                "{name}, a body that may not swim: shores {:?}; grounds {:?}; {:.1} s; ended {:?}",
                shores(&t2, &dl),
                d.path(),
                d.grounds.len() as f64 * TICK as f64 / 1e6,
                d.end
            );
            assert_eq!(d.path(), [Ground::Dry]);
            assert_eq!(d.end, Some(Progress::Done));
        }
    }
}
