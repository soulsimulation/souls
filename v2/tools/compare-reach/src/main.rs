//! Engine v2 N18 (#2658): what the new ground and today's engine say can be reached in Eden, place by place.
//!
//! `cargo run -p compare-reach --release -- <facts.json> <labels.json>` (from `v2/`). The facts are N1's export
//! (`v2/tools/import-eden`); the labels are today's `navCheckV1` verdicts per catalog place, written by a one-off
//! command run from the repository root (see the README). Both are generated, kept under the ignored `.local/`.
//!
//! The new verdict: the map (N5's patches and links, N3's ground) is flooded from the arrival point's piece for today's
//! walking body (hands, no climb), then the reverse. Every link is crossed both ways (N4), so the two floods are one
//! part of the map, [`Map::parts`]. A shut door counts as passable by hand, as today's `door` flag does. A place is
//! reached when its point lies within 1.5 m of a piece of that part on its floor.
//!
//! Today's level is a number by height. It is mapped to a floor by position: level 0 is the open ground or a building's
//! lowest floor (its index 0); an upper level is any upper floor whose height lies within [`Y_TOL`] of the height
//! today's surface has under the point (written in the labels).
//!
//! Every difference is printed with one of four classes (today's raster, an import gap, a new-engine fault, today's
//! fault) and its cause, from the facts that decide it: today's terrain under the point (in the labels), the floor and
//! building the nearest piece belongs to, that building's doorways to the ground, whether its part of the map holds
//! any open ground, and the waters' outlines. A few were checked by hand and are listed in [`KNOWN`] with what was
//! found. A difference no rule explains is printed `UNCLASSED`, never dropped.
//!
//! Integers only: millimetres in the ground's frame. Nothing here is hashed; the decision (within 1.5 m) is exact.

// The repeat rule's map ban (K12, v2/clippy.toml) is `sim`'s; this tool's map is a lookup.
#![allow(clippy::disallowed_types)]

use import_eden::json::{self, Json};
use import_eden::{F_DEF, F_LEVEL, F_ORIGIN, Import};
use replica::encode::Value;
use replica::ids::Id;
use sim::ground::{STEP, Scene};
use sim::routes::{HANDS, Map};
use std::collections::{BTreeMap, HashMap};

/// A place is reached within this of reached ground, mm (today's `tol: 1.5`).
const TOL: i64 = 1500;
/// An upper floor matches today's level when its height is within this of today's surface, mm.
const Y_TOL: i64 = 600;
/// The bucket of the piece index, mm.
const CELL: i64 = 16_000;

/// A piece in the ground's frame: its triangles (x, z mm), bounds, height, and what floor it is.
struct Flat {
    tris: Vec<[[i64; 2]; 3]>,
    lo: [i64; 2],
    hi: [i64; 2],
    y: i64,
    /// `None` on the open ground; else the floor's index.
    floor: Option<i64>,
}

fn sq(v: i64) -> i64 {
    v * v
}
fn cross(a: [i64; 2], b: [i64; 2], p: [i64; 2]) -> i64 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}
/// Squared distance from `p` to the segment `a`–`b`, mm², rounded down.
fn seg2(p: [i64; 2], a: [i64; 2], b: [i64; 2]) -> i64 {
    let (ex, ez) = (b[0] - a[0], b[1] - a[1]);
    let l2 = (ex * ex + ez * ez).max(1);
    let t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez).clamp(0, l2);
    let at = [a[0] + ex * t / l2, a[1] + ez * t / l2];
    sq(at[0] - p[0]) + sq(at[1] - p[1])
}
/// Squared distance from `p` to a triangle (0 inside or on an edge), either winding.
fn tri2(p: [i64; 2], t: &[[i64; 2]; 3]) -> i64 {
    let s = [
        cross(t[0], t[1], p),
        cross(t[1], t[2], p),
        cross(t[2], t[0], p),
    ];
    if s.iter().all(|&v| v >= 0) || s.iter().all(|&v| v <= 0) {
        return 0;
    }
    seg2(p, t[0], t[1])
        .min(seg2(p, t[1], t[2]))
        .min(seg2(p, t[2], t[0]))
}

fn text(im: &Import, v: Option<&Value>) -> String {
    match v {
        Some(Value::Bytes(h)) => <[u8; 32]>::try_from(h.as_slice())
            .ok()
            .and_then(|h| im.texts.get(&h))
            .cloned()
            .unwrap_or_else(|| String::from_utf8_lossy(h).into_owned()),
        Some(Value::Text(n)) => n.as_str().to_owned(),
        _ => String::new(),
    }
}
fn uint(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Uint(u)) => i64::try_from(*u).ok(),
        Some(Value::Nint(n)) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

/// One label: today's verdict for a place.
struct Label {
    id: String,
    kind: String,
    level: i64,
    p: [i64; 2],
    y: Option<i64>,
    ok: bool,
    code: String,
    door: bool,
    /// Today's terrain at the point: its height (mm) and medium (walk, wade, swim, steep, outside).
    ground: i64,
    medium: String,
}

fn labels(j: &Json) -> Vec<Label> {
    j.get("places")
        .map(Json::arr)
        .unwrap_or(&[])
        .iter()
        .filter(|r| r.get("ok").is_some())
        .map(|r| {
            let s = |k| r.get(k).and_then(Json::str).unwrap_or("").to_owned();
            let p = r.get("p").map(Json::arr).unwrap_or(&[]);
            Label {
                id: s("id"),
                kind: s("kind"),
                level: r.get("level").and_then(Json::int).unwrap_or(0),
                p: [
                    p.first().and_then(Json::int).unwrap_or(0),
                    p.get(1).and_then(Json::int).unwrap_or(0),
                ],
                y: r.get("y").and_then(Json::int),
                ok: r.get("ok").and_then(Json::bool).unwrap_or(false),
                code: s("code"),
                door: r.get("door").and_then(Json::bool).unwrap_or(false),
                ground: r.get("ground").and_then(Json::int).unwrap_or(0),
                medium: s("medium"),
            }
        })
        .collect()
}

/// What the new ground says at one place: the nearest piece on its floor within the tolerance, in the main part or
/// not (squared distance, piece).
#[derive(Default)]
struct Near {
    main: Option<(i64, u32)>,
    any: Option<(i64, u32)>,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, facts, labels_path] = &args[..] else {
        eprintln!("usage: compare-reach <facts.json> <labels.json>");
        std::process::exit(2);
    };
    let im = import_eden::load(&std::fs::read_to_string(facts).expect("the facts file"))
        .expect("Eden loads");
    let lj = json::parse(&std::fs::read_to_string(labels_path).expect("the labels file"))
        .expect("labels JSON");
    let ls = labels(&lj);
    let ground = im.nodes["ground"];
    let map = Map::build(&im.tree, ground, &|_| 0).expect("the map");
    let (n, ..) = map.counts();

    // Every piece in the ground's frame, and an index of them by 16 m cell.
    let floor_of = |node: Id| -> Option<i64> {
        if node == ground {
            return None;
        }
        let h = im.tree.handle(node)?;
        uint(im.tree.node(h)?.fields().get(&F_LEVEL))
    };
    let mut flats = Vec::with_capacity(n);
    let mut index: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
    for q in 0..n as u32 {
        let pc = map.piece(q);
        let w: Vec<[i64; 3]> = pc
            .vertices
            .iter()
            .map(|v| map.world(q, [i64::from(v[0]), i64::from(v[1]), i64::from(v[2])]))
            .collect();
        let tris: Vec<[[i64; 2]; 3]> = pc
            .triangles
            .iter()
            .map(|t| t.map(|k| [w[k as usize][0], w[k as usize][2]]))
            .collect();
        let (mut lo, mut hi) = ([i64::MAX; 2], [i64::MIN; 2]);
        for v in &w {
            lo = [lo[0].min(v[0]), lo[1].min(v[2])];
            hi = [hi[0].max(v[0]), hi[1].max(v[2])];
        }
        let node = map.patch_of(q).node;
        let floor = floor_of(node);
        if node != ground && floor.is_none() {
            panic!("a floor with no index");
        }
        for cx in (lo[0] - TOL).div_euclid(CELL)..=(hi[0] + TOL).div_euclid(CELL) {
            for cz in (lo[1] - TOL).div_euclid(CELL)..=(hi[1] + TOL).div_euclid(CELL) {
                index.entry((cx, cz)).or_default().push(q);
            }
        }
        flats.push(Flat {
            tris,
            lo,
            hi,
            y: w.first().map_or(0, |v| v[1]),
            floor,
        });
    }

    // The arrival point's piece, and its part: the flood both ways for a body with hands.
    let arr = lj.get("arrival").map(Json::arr).unwrap_or(&[]);
    let arrival = [
        arr.first().and_then(Json::int).unwrap_or(0),
        arr.get(1).and_then(Json::int).unwrap_or(0),
    ];
    let parts = map.parts(HANDS);
    // Per part (by its smallest piece): whether any of its pieces is open ground.
    let mut part_ground = vec![false; n];
    for q in 0..n {
        part_ground[parts[q] as usize] |= flats[q].floor.is_none();
    }
    let start = (0..n as u32)
        .filter(|&q| flats[q as usize].floor.is_none())
        .filter_map(|q| {
            let d = flats[q as usize]
                .tris
                .iter()
                .map(|t| tri2(arrival, t))
                .min()?;
            Some((d, q))
        })
        .min()
        .expect("ground at the arrival point");
    assert!(start.0 <= sq(TOL), "the arrival point is on no ground");
    let main = parts[start.1 as usize];
    let mut size: BTreeMap<u32, usize> = BTreeMap::new();
    for &p in &parts {
        *size.entry(p).or_default() += 1;
    }
    println!(
        "map: {n} pieces, {} parts; the arrival point ({}, {}) mm lies {} mm from piece {}, whose part holds {} pieces",
        size.len(),
        arrival[0],
        arrival[1],
        start.0.isqrt(),
        start.1,
        size[&main]
    );

    let on_floor = |l: &Label, f: &Flat| match (l.level, f.floor) {
        (0, None) | (0, Some(0)) => true,
        (0, _) | (_, None) | (_, Some(0)) => false,
        (_, Some(_)) => l.y.is_some_and(|y| (f.y - y).abs() <= Y_TOL),
    };
    let near = |l: &Label| -> Near {
        let mut out = Near::default();
        let cell = (l.p[0].div_euclid(CELL), l.p[1].div_euclid(CELL));
        for &q in index.get(&cell).map_or(&[][..], Vec::as_slice) {
            let f = &flats[q as usize];
            if l.p[0] < f.lo[0] - TOL
                || l.p[0] > f.hi[0] + TOL
                || l.p[1] < f.lo[1] - TOL
                || l.p[1] > f.hi[1] + TOL
                || !on_floor(l, f)
            {
                continue;
            }
            let Some(d) = f.tris.iter().map(|t| tri2(l.p, t)).min() else {
                continue;
            };
            if d > sq(TOL) {
                continue;
            }
            if out.any.is_none_or(|a| (d, q) < a) {
                out.any = Some((d, q));
            }
            if parts[q as usize] == main && out.main.is_none_or(|a| (d, q) < a) {
                out.main = Some((d, q));
            }
        }
        out
    };

    // Each thing's links as the map reads them: (kind, blocked, whether one end is the open ground).
    let thing_of = |mut n: Id| -> Option<Id> {
        loop {
            let node = im.tree.node(im.tree.handle(n)?)?;
            if node.fields().contains_key(&F_DEF) {
                return Some(n);
            }
            n = node.parent()?;
        }
    };
    let mut doors: BTreeMap<Id, Vec<String>> = BTreeMap::new();
    for li in map.links() {
        let Some((_, ends, ..)) = im.tree.link(li.id) else {
            continue;
        };
        let to_ground = ends.contains(&ground);
        for e in ends {
            if let Some(t) = thing_of(e) {
                doors.entry(t).or_default().push(format!(
                    "{:?}{}{} portals {:?}",
                    li.kind,
                    if to_ground { " to the ground" } else { "" },
                    li.blocked.map(|b| format!(" {b}")).unwrap_or_default(),
                    li.ends
                ));
            }
        }
    }
    let describe = |q: u32| -> String {
        let node = map.patch_of(q).node;
        let f = &flats[q as usize];
        if node == ground {
            return format!("open ground, part of {}", size[&parts[q as usize]]);
        }
        let h = im.tree.handle(node).expect("live");
        let thing = im
            .tree
            .node(h)
            .expect("live")
            .parent()
            .expect("a floor's thing");
        let t = im
            .tree
            .node(im.tree.handle(thing).expect("live"))
            .expect("live");
        let mut ls: BTreeMap<&str, usize> = BTreeMap::new();
        for d in doors.get(&thing).map_or(&[][..], Vec::as_slice) {
            *ls.entry(d.as_str()).or_default() += 1;
        }
        format!(
            "floor {} of {} {} at y {} mm, part of {}; links {ls:?}",
            f.floor.unwrap_or(-1),
            text(&im, t.fields().get(&F_DEF)),
            text(&im, t.fields().get(&F_ORIGIN)),
            f.y,
            size[&parts[q as usize]]
        )
    };

    // The ways out of each building: its doorways to the open ground, and how many of them meet no ground there.
    let mut out_doors: BTreeMap<Id, (usize, usize)> = BTreeMap::new();
    for li in map.links() {
        let Some((_, ends, ..)) = im.tree.link(li.id) else {
            continue;
        };
        if !ends.contains(&ground) {
            continue;
        }
        for t in ends
            .iter()
            .filter(|&&e| e != ground)
            .filter_map(|&e| thing_of(e))
        {
            let o = out_doors.entry(t).or_default();
            o.0 += 1;
            o.1 += usize::from(li.blocked == Some("link-end-off-ground"));
        }
    }
    let floor_thing = |q: u32| -> Option<(Id, String)> {
        let node = map.patch_of(q).node;
        if node == ground {
            return None;
        }
        let thing = im.tree.node(im.tree.handle(node)?)?.parent()?;
        let t = im.tree.node(im.tree.handle(thing)?)?;
        Some((thing, text(&im, t.fields().get(&F_DEF))))
    };
    let is_bridge = |q: u32| floor_thing(q).is_some_and(|(_, d)| d.starts_with("core-bridge@"));

    // The waters as the import keeps them (the open ground has them cut out).
    let scene = Scene::of(&im.tree, ground).expect("the open ground's scene");
    // The scene's outlines are micrometres.
    let in_water = |p: [i64; 2]| -> bool {
        let p = [p[0] * 1000, p[1] * 1000];
        scene.waters.iter().any(|w| {
            (w.ring.len() >= 3 && in_ring(p, &w.ring))
                || w.line
                    .windows(2)
                    .any(|s| seg2(p, s[0], s[1]) <= sq(w.width / 2))
        })
    };

    let (mut agree, mut both_ok, mut both_no) = (0usize, 0usize, 0usize);
    let mut diffs: Vec<(&Label, Near)> = Vec::new();
    for l in &ls {
        let nr = near(l);
        let new_ok = nr.main.is_some();
        if new_ok == l.ok {
            agree += 1;
            if new_ok {
                both_ok += 1;
            } else {
                both_no += 1;
            }
        } else {
            diffs.push((l, nr));
        }
    }

    // Each difference, classed, with the facts that class it.
    let classify = |l: &Label, nr: &Near| -> (Class, String) {
        if let Some((_, class, why)) = KNOWN.iter().find(|k| k.0 == l.id) {
            return (*class, (*why).to_owned());
        }
        let high = l.ground.abs() > STEP || l.medium == "steep";
        let piece = nr.main.or(nr.any).map(|a| a.1);
        if l.ok {
            // Today reaches it and the new ground does not.
            let Some(q) = piece else {
                return (
                    Class::Unclassed,
                    "no ground on its floor within 1.5 m".to_owned(),
                );
            };
            if is_bridge(q) {
                return (
                    Class::ImportGap,
                    format!(
                        "on a bridge: its floor is {} mm above the flat open ground, and no link joins its ends to the ground (the import brings no ramp for them; the terrain under them is N11's, #2735)",
                        flats[q as usize].y
                    ),
                );
            }
            if let Some((t, def)) = floor_thing(q) {
                let (outs, off) = out_doors.get(&t).copied().unwrap_or_default();
                if high && outs > 0 && off == outs {
                    return (
                        Class::ImportGap,
                        format!(
                            "terrain: {def} stands where today's ground is {} mm; its floor is {} mm up, and its {outs} doorway(s) to the ground meet the flat open ground nowhere (link-end-off-ground; terrain heights are N11's, #2735)",
                            l.ground, flats[q as usize].y
                        ),
                    );
                }
            }
            if let Some((t, def)) = floor_thing(q) {
                let (outs, off) = out_doors.get(&t).copied().unwrap_or_default();
                if outs > off && !part_ground[parts[q as usize] as usize] && high {
                    // N3's steps join a porch within STEP of the flat ground; this one stands on today's terrain.
                    return (
                        Class::ImportGap,
                        format!(
                            "terrain: {def} stands where today's ground is {} mm, so its porch steps down to today's ground but lies more than a step from the flat open ground; its {} crossable doorway(s) to the ground open onto that porch (terrain heights are N11's, #2735)",
                            l.ground,
                            outs - off
                        ),
                    );
                }
                if outs > off && !part_ground[parts[q as usize] as usize] {
                    return (
                        Class::NewEngineFault,
                        format!(
                            "a porch: {def}'s {} crossable doorway(s) to the ground open onto a surface of its own floor ({} mm up; a porch or an arcade), so their ground end lies on the building, and the surface's open edge has no link to the open ground: no piece of its part ({} pieces) is open ground. The new map joins a floor to the ground only by a link, and N3 makes ground cover only of a floor holding no room; today's raster steps the {} mm down",
                            outs - off,
                            flats[q as usize].y,
                            size[&parts[q as usize]],
                            flats[q as usize].y
                        ),
                    );
                }
            }
            if in_water(l.p) && l.medium == "walk" {
                return (
                    Class::ImportGap,
                    format!(
                        "an islet: today's ground here is dry ({} mm) inside a water's outline, which the new ground cuts whole; the terrain that raises it is N11's (#2735)",
                        l.ground
                    ),
                );
            }
            if high {
                return (
                    Class::ImportGap,
                    format!(
                        "terrain: today's ground here is {} mm ({}); the new open ground is flat, so the buildings around this part, standing on that terrain, meet it nowhere (N11, #2735)",
                        l.ground, l.medium
                    ),
                );
            }
            (Class::Unclassed, String::new())
        } else {
            // The new ground reaches it and today does not.
            if l.medium == "swim" || l.medium == "wade" {
                let w = if in_water(l.p) {
                    "inside a water's outline, yet the new ground has ground within 1.5 m of it (the outline's bank, or ground cover N3 lays back over the water) where today's terrain is under water"
                } else {
                    "outside every water outline the template gives, so the new ground has no water there"
                };
                return (
                    Class::ImportGap,
                    format!(
                        "water by terrain: today's ground here is {} mm, under water ({}); the point lies {w}; water from terrain heights is N11's (#2735)",
                        l.ground, l.medium
                    ),
                );
            }
            if high {
                return (
                    Class::ImportGap,
                    format!(
                        "terrain: today's ground here is {} mm ({}) and today says {}; the new open ground is flat, with no slope or steep cell (N11, #2735)",
                        l.ground, l.medium, l.code
                    ),
                );
            }
            (Class::Unclassed, String::new())
        }
    };

    println!(
        "places {}; today reached {}; new reached {}; agree {agree} ({}.{:02} %): both reached {both_ok}, neither {both_no}; differ {}",
        ls.len(),
        ls.iter().filter(|l| l.ok).count(),
        both_ok + diffs.iter().filter(|d| !d.0.ok).count(),
        agree * 100 / ls.len(),
        agree * 10_000 / ls.len() % 100,
        diffs.len()
    );
    let rows: Vec<(Class, String, &Label, &Near)> = diffs
        .iter()
        .map(|(l, nr)| {
            let (c, why) = classify(l, nr);
            (c, why, *l, nr)
        })
        .collect();
    let mut by: BTreeMap<(Class, bool), usize> = BTreeMap::new();
    for r in &rows {
        *by.entry((r.0, r.2.ok)).or_default() += 1;
    }
    println!("\n| class | today reached, new not | new reached, today not |\n|---|---:|---:|");
    for c in [
        Class::TodaysRaster,
        Class::ImportGap,
        Class::NewEngineFault,
        Class::TodaysFault,
        Class::Unclassed,
    ] {
        let (a, b) = (
            by.get(&(c, true)).copied().unwrap_or(0),
            by.get(&(c, false)).copied().unwrap_or(0),
        );
        println!("| {c} | {a} | {b} |");
    }
    println!(
        "\n| class | id | kind | level | p mm | today | today's ground | new: nearest ground on its floor | cause |\n|---|---|---|---:|---|---|---|---|---|"
    );
    for (c, why, l, nr) in &rows {
        let today = if l.ok {
            format!("ok{}", if l.door { " (door)" } else { "" })
        } else {
            l.code.clone()
        };
        let newv = match (nr.main, nr.any) {
            (Some((d, q)), _) => format!("reached, {} mm: {}", d.isqrt(), describe(q)),
            (None, Some((d, q))) => format!("not joined; {} mm: {}", d.isqrt(), describe(q)),
            (None, None) => "no ground on its floor within 1.5 m".to_owned(),
        };
        println!(
            "| {c} | {} | {} | {} | ({}, {}) | {today} | {} mm {} | {newv} | {why} |",
            l.id, l.kind, l.level, l.p[0], l.p[1], l.ground, l.medium
        );
    }
}

/// The four classes of a difference, and one for a difference not yet explained (printed, never hidden).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Class {
    TodaysRaster,
    ImportGap,
    NewEngineFault,
    TodaysFault,
    Unclassed,
}

impl std::fmt::Display for Class {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Class::TodaysRaster => "today's raster",
            Class::ImportGap => "an import gap",
            Class::NewEngineFault => "a new-engine fault",
            Class::TodaysFault => "today's fault",
            Class::Unclassed => "UNCLASSED",
        })
    }
}

/// Differences checked by hand: the place, its class, and what was found.
const KNOWN: &[(&str, Class, &str)] = &[(
    "g-place-social-eden-dining",
    Class::ImportGap,
    "the point is the middle of the long table (e_b7d47cf0), whose bake gives as solids only its two legs (25 to 695 mm up) and no top, so the new ground stands a body under the top between the legs; today says the point has standing room within 1.5 m but in a pocket closed by the table and its six chairs. The table's top is not among the solids the import carries",
)];

/// Whether `p` lies inside the ring (crossings, integers only).
fn in_ring(p: [i64; 2], ring: &[[i64; 2]]) -> bool {
    let mut c = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) {
            // p.x < a.x + (b.x - a.x) (p.z - a.z) / (b.z - a.z), multiplied out by (b.z - a.z) with its sign.
            let lhs = i128::from(p[0] - a[0]) * i128::from(b[1] - a[1]);
            let rhs = i128::from(b[0] - a[0]) * i128::from(p[1] - a[1]);
            if (b[1] > a[1] && lhs < rhs) || (b[1] < a[1] && lhs > rhs) {
                c = !c;
            }
        }
        j = i;
    }
    c
}
