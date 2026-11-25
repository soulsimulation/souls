//! The ground under a seat or a table (first-day tester, round 2): a thing's boxes are its parts at least 0.3 m tall,
//! so Eden's bench seat (`core-bench-seat@1`) has only its two end legs and its table (`core-table@1`) only its four;
//! the seat plank and the tabletop blocked nothing, and a walk to the domed hall ended standing inside the bench in
//! its middle. A thing with a slot above a step and within the body's height also blocks the box its legs span, up to
//! that slot (`sim::ground::scene`'s `under_slots`); a campfire's ring of logs (4.5 m across) and a kiosk a vendor
//! stands in stay walkable.

use sim::ground::scene::{Solid, solids_under};
use sim::ground::{HUMAN_RADIUS, Patch, Scene, Turn, cut_floor};

/// A hall 12 m square, its floor at 0, holding Eden's bench seat at (-3, -3) m turned 90 degrees, its table at
/// (3, -3) m, its campfire at (-2, 3) m and its kiosk at (3.5, 3.5) m, each with today's solids and slots (the facts'
/// rows, `v2/tools/import-eden/export/export.ts`).
const HALL: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [{"ref": "core-hall@1", "hash": "aa", "name": "core:hall", "form": "point"},
            {"ref": "core-bench-seat@1", "hash": "ab", "name": "core:bench_seat", "form": "point"},
            {"ref": "core-table@1", "hash": "ac", "name": "core:table", "form": "point"},
            {"ref": "core-campfire@1", "hash": "ad", "name": "core:campfire", "form": "point"},
            {"ref": "core-kiosk@1", "hash": "ae", "name": "core:kiosk", "form": "point"}],
  "things": [
    {"id": "e_hall", "def": "core-hall@1", "ref": "core-hall@1", "parent": null, "pose": [0, 0, 0, 0],
     "world": [0, 0, 0, 0], "scale_ppm": 1000000, "name": "test-hall",
     "floors": [{"level": 0, "y": 0, "polygon": [[-6000, -6000], [6000, -6000], [6000, 6000], [-6000, 6000]]}],
     "rooms": [{"id": "hall", "name": "Hall", "floor": 0, "pose": [0, 0, 0, 0], "height": 2400,
                "polygon": [[-6000, -6000], [6000, -6000], [6000, 6000], [-6000, 6000]]}]},
    {"id": "e_bench", "def": "core-bench-seat@1", "ref": "core-bench-seat@1", "parent": "e_hall",
     "pose": [-3000, 0, -3000, 90000], "world": [-3000, 0, -3000, 90000], "scale_ppm": 1000000,
     "slot": {"room": "hall"}, "name": "hall-bench-1",
     "solids": [[-600, 0, 15, 135, 0, 15, 405, 0, 0], [600, 0, 15, 135, 0, 15, 405, 0, 0]],
     "slots": [{"n": 1, "id": "seat-1", "kind": "seat", "at": [-350, 465, 0], "yaw": 0, "capacity": 1},
               {"n": 2, "id": "seat-2", "kind": "seat", "at": [350, 465, 0], "yaw": 0, "capacity": 1}]},
    {"id": "e_table", "def": "core-table@1", "ref": "core-table@1", "parent": "e_hall",
     "pose": [3000, 0, -3000, 0], "world": [3000, 0, -3000, 0], "scale_ppm": 1000000,
     "slot": {"room": "hall"}, "name": "table",
     "solids": [[-520, -320, 30, 30, 0, 0, 700, 0, 0], [520, -320, 30, 30, 0, 0, 700, 0, 0],
                [-520, 320, 30, 30, 0, 0, 700, 0, 0], [520, 320, 30, 30, 0, 0, 700, 0, 0]],
     "slots": [{"n": 1, "id": "top", "kind": "surface", "at": [0, 750, 0], "yaw": 0, "capacity": 12}]},
    {"id": "e_fire", "def": "core-campfire@1", "ref": "core-campfire@1", "parent": "e_hall",
     "pose": [-2000, 0, 3000, 0], "world": [-2000, 0, 3000, 0], "scale_ppm": 1000000,
     "slot": {"room": "hall"}, "name": "campfire",
     "solids": [[0, 300, 60, 219, 180023, 23, 272, 0, 0], [0, -100, 60, 219, 180023, 158, 407, 0, 0],
                [1683, 1081, 700, 200, 57296, 0, 200, 0, 0], [1683, 1081, 700, 200, 57296, 200, 400, 0, 0],
                [83, -1998, 700, 200, 177617, 0, 200, 0, 0], [83, -1998, 700, 200, 177617, 200, 400, 0, 0],
                [-1767, 937, 700, 200, 297938, 0, 200, 0, 0], [-1767, 937, 700, 200, 297938, 200, 400, 0, 0]],
     "slots": [{"n": 1, "id": "log-1", "kind": "seat", "at": [1683, 400, 1081], "yaw": 237296, "capacity": 1},
               {"n": 2, "id": "log-2", "kind": "seat", "at": [83, 400, -1998], "yaw": 357617, "capacity": 1},
               {"n": 3, "id": "log-3", "kind": "seat", "at": [-1767, 400, 937], "yaw": 117938, "capacity": 1}]},
    {"id": "e_kiosk", "def": "core-kiosk@1", "ref": "core-kiosk@1", "parent": "e_hall",
     "pose": [3500, 0, 3500, 0], "world": [3500, 0, 3500, 0], "scale_ppm": 1000000,
     "slot": {"room": "hall"}, "name": "kiosk",
     "solids": [[0, -740, 870, 30, 0, 130, 2270, 0, 0], [-840, 0, 30, 770, 0, 130, 2270, 0, 0],
                [840, 0, 30, 770, 0, 130, 2270, 0, 0], [0, 740, 870, 30, 0, 130, 970, 0, 0]],
     "slots": [{"n": 1, "id": "counter", "kind": "surface", "at": [0, 1060, 900], "yaw": 0, "capacity": 6},
               {"n": 2, "id": "vendor", "kind": "stand", "at": [0, 100, -250], "yaw": 0, "capacity": 1},
               {"n": 3, "id": "customer", "kind": "stand", "at": [0, 0, 1450], "yaw": 180000, "capacity": 1}]}
  ],
  "doors": [],
  "places": [],
  "bake": {"things": 5},
  "byRef": {"core-hall@1": 1}
}"#;

fn inside_triangle(v: &[[i32; 3]], t: &[u32; 3], p: [i64; 2]) -> bool {
    let c = |a: [i32; 3], b: [i32; 3]| {
        (i64::from(b[0] - a[0])) * (p[1] - i64::from(a[2]))
            - (i64::from(b[2] - a[2])) * (p[0] - i64::from(a[0]))
    };
    let (a, b, d) = (v[t[0] as usize], v[t[1] as usize], v[t[2] as usize]);
    let (x, y, z) = (c(a, b), c(b, d), c(d, a));
    (x >= 0 && y >= 0 && z >= 0) || (x <= 0 && y <= 0 && z <= 0)
}

/// Whether a body's centre may stand at `(x, z)` mm on the patch.
fn walkable(p: &Patch, x: i64, z: i64) -> bool {
    p.pieces.iter().any(|q| {
        q.triangles
            .iter()
            .any(|t| inside_triangle(&q.vertices, t, [x, z]))
    })
}

fn hall() -> (import_eden::Import, Scene, Patch) {
    let im = import_eden::load(HALL).expect("the hall loads");
    let scene = Scene::of(&im.tree, im.nodes["e_hall/floor-0"]).unwrap();
    let patch = cut_floor(&scene, HUMAN_RADIUS, Turn::NONE).unwrap();
    (im, scene, patch)
}

/// The boxes of thing `id` in the floor's frame: its own, and the one under its slots when it has one.
fn boxes(im: &import_eden::Import, id: &str) -> Vec<Solid> {
    let t = &im.tree;
    let (h, f) = (
        t.handle(im.nodes[id]).unwrap(),
        t.handle(im.nodes["e_hall"]).unwrap(),
    );
    solids_under(t, h, f).unwrap()
}

#[test]
fn a_bench_and_a_table_block_the_ground_under_their_seats_and_top() {
    let (im, _, p) = hall();
    // The bench, turned 90 degrees: its legs 1.2 m apart along z, its plank 0.27 m deep along x, its front to +x. Its
    // middle was walkable between the legs; now it is not, nor is the ground under either seat (0.35 m either side).
    for (x, z) in [(-3000, -3000), (-3000, -3350), (-3000, -2650)] {
        assert!(!walkable(&p, x, z), "under the bench at ({x}, {z}) mm");
    }
    // The table's middle and each side of its top, between the legs (its top 1.1 m by 0.7 m).
    for (x, z) in [(3000, -3000), (2600, -3000), (3400, -3000), (3000, -2700)] {
        assert!(!walkable(&p, x, z), "under the table at ({x}, {z}) mm");
    }
    // Beside each, a body stands: 0.6 m in front of the bench's seats (its stand points are 0.455 m out), and up to
    // the table's long side, 0.4 m off its top's edge.
    assert!(walkable(&p, -3000 + 600, -3350), "in front of the bench");
    assert!(
        walkable(&p, 3000, -3000 - 750),
        "beside the table's long side"
    );
    // One box under each, from the legs' foot to the slot: the bench's to its seats (465 mm), the table's to its top
    // (750 mm); the campfire (4.5 m across) and the kiosk (a vendor stands in it) have none.
    let bench = boxes(&im, "e_bench");
    assert_eq!(bench.len(), 3, "two legs and the box under its seats");
    assert_eq!((bench[2].y0, bench[2].y1), (15_000, 465_000));
    let table = boxes(&im, "e_table");
    assert_eq!(table.len(), 5, "four legs and the box under its top");
    assert_eq!((table[4].y0, table[4].y1), (0, 750_000));
    assert_eq!(
        boxes(&im, "e_fire").len(),
        8,
        "the campfire's own boxes only"
    );
    assert_eq!(boxes(&im, "e_kiosk").len(), 4, "the kiosk's own boxes only");
}

#[test]
fn a_campfires_ring_and_a_kiosk_stay_walkable_inside() {
    let (_, _, p) = hall();
    // Between the campfire's fire and its logs, 1 m out from the fire, a body still stands.
    assert!(
        walkable(&p, -2000 + 1000, 3000),
        "inside the campfire's ring"
    );
    // The kiosk's vendor stands in it, behind its counter.
    assert!(walkable(&p, 3500, 3500 - 250), "the kiosk's vendor point");
}

/// Mars camp's kitchen (`worlds/templates/mars-camp.json`): its long dining table and the bench seat 950 mm from it
/// (today's rows). With a box under each, the strip between them must not become ground of its own, sealed off by
/// their legs' cuts: a seat's stand point moved there would leave a Soul that rises there with no way out.
const DINING: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [{"ref": "core-hall@1", "hash": "aa", "name": "core:hall", "form": "point"},
            {"ref": "core-bench-seat@1", "hash": "ab", "name": "core:bench_seat", "form": "point"},
            {"ref": "core-long-table@1", "hash": "ac", "name": "core:long_table", "form": "point"}],
  "things": [
    {"id": "e_hall", "def": "core-hall@1", "ref": "core-hall@1", "parent": null, "pose": [0, 0, 0, 0],
     "world": [0, 0, 0, 0], "scale_ppm": 1000000, "name": "kitchen",
     "floors": [{"level": 0, "y": 0, "polygon": [[-3000, -3000], [6000, -3000], [6000, 6000], [-3000, 6000]]}],
     "rooms": [{"id": "kitchen", "name": "Kitchen", "floor": 0, "pose": [0, 0, 0, 0], "height": 2400,
                "polygon": [[-3000, -3000], [6000, -3000], [6000, 6000], [-3000, 6000]]}]},
    {"id": "e_table", "def": "core-long-table@1", "ref": "core-long-table@1", "parent": "e_hall",
     "pose": [1500, 0, 1500, 0], "world": [1500, 0, 1500, 0], "scale_ppm": 1000000,
     "slot": {"room": "kitchen"}, "name": "dining-table",
     "solids": [[-1200, 0, 25, 335, 0, 25, 695, 0, 0], [1200, 0, 25, 335, 0, 25, 695, 0, 0]],
     "slots": [{"n": 1, "id": "top", "kind": "surface", "at": [0, 760, 0], "yaw": 0, "capacity": 12}]},
    {"id": "e_bench", "def": "core-bench-seat@1", "ref": "core-bench-seat@1", "parent": "e_hall",
     "pose": [1500, 0, 2450, 179909], "world": [1500, 0, 2450, 179909], "scale_ppm": 1000000,
     "slot": {"room": "kitchen"}, "name": "dining-bench",
     "solids": [[-600, 0, 15, 135, 0, 15, 405, 0, 0], [600, 0, 15, 135, 0, 15, 405, 0, 0]],
     "slots": [{"n": 1, "id": "seat-1", "kind": "seat", "at": [-350, 465, 0], "yaw": 0, "capacity": 1},
               {"n": 2, "id": "seat-2", "kind": "seat", "at": [350, 465, 0], "yaw": 0, "capacity": 1}]}
  ],
  "doors": [],
  "places": [],
  "bake": {"things": 3},
  "byRef": {"core-hall@1": 1}
}"#;

/// The pieces of floor `floor` cut for today's body, with and without the boxes under slots.
fn pieces(im: &import_eden::Import, floor: replica::ids::Id) -> (usize, usize) {
    let cut = || {
        let s = Scene::of(&im.tree, floor).unwrap();
        cut_floor(&s, HUMAN_RADIUS, Turn::NONE)
            .unwrap()
            .pieces
            .len()
    };
    (cut(), sim::ground::scene::without_under_boxes(cut))
}

#[test]
fn a_dining_bench_by_its_table_seals_off_no_ground() {
    let im = import_eden::load(DINING).expect("the kitchen loads");
    let (with, without) = pieces(&im, im.nodes["e_hall/floor-0"]);
    println!("the kitchen: {with} pieces with the boxes under slots, {without} without");
    assert!(
        with <= without,
        "a piece sealed off between the bench and the table"
    );
}

/// Across a whole exported world (`UNDER_FACTS`, default Eden's and Mars camp's under `.local/import-eden/`), no floor
/// falls into more pieces with the boxes under slots than without, and no square of the open ground does: no ground
/// newly sealed off. `cargo test -p sim --release --test under_seats -- --ignored --nocapture`.
#[test]
#[ignore = "needs exported facts files (v2/tools/import-eden/export/export.ts)"]
fn no_ground_is_newly_sealed_off_on_eden_or_mars_camp() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.local/import-eden");
    let files = std::env::var("UNDER_FACTS")
        .unwrap_or_else(|_| format!("{root}/eden-2026.facts.json,{root}/mars-camp.facts.json"));
    let mut sealed = Vec::new();
    for file in files.split(',') {
        let im = import_eden::load(&std::fs::read_to_string(file).expect("a facts file")).unwrap();
        let mut floors = 0;
        for (key, &node) in &im.nodes {
            if !key.contains("/floor-") || Scene::of(&im.tree, node).is_err() {
                continue;
            }
            floors += 1;
            let (with, without) = pieces(&im, node);
            if with > without {
                sealed.push(format!("{file}: {key}: {without} -> {with} pieces"));
            }
        }
        let ground = im.nodes["ground"];
        let open = |off: bool| {
            let cut = || {
                sim::ground::OpenGround::of(&im.tree, ground, HUMAN_RADIUS)
                    .unwrap()
                    .cut_all(1)
                    .into_iter()
                    .map(|(sq, p)| (sq, p.pieces.iter().map(bounds).collect::<Vec<_>>()))
                    .collect::<std::collections::BTreeMap<_, _>>()
            };
            if off {
                sim::ground::scene::without_under_boxes(cut)
            } else {
                cut()
            }
        };
        let (with, without) = (open(false), open(true));
        // A piece that reaches its square's edge goes on in the next square: only the pieces wholly inside a square
        // can be sealed off there.
        let inner = |sq: &(i32, i32), pieces: &[[i32; 4]]| -> Vec<[i32; 4]> {
            let s = sim::ground::SQUARE as i32;
            let (x0, z0) = (sq.0 * s, sq.1 * s);
            pieces
                .iter()
                .filter(|b| b[0] > x0 && b[1] > z0 && b[2] < x0 + s && b[3] < z0 + s)
                .copied()
                .collect()
        };
        for (sq, pieces) in &with {
            let now = inner(sq, pieces);
            let before = without.get(sq).map_or(0, |p| inner(sq, p).len());
            if now.len() > before {
                sealed.push(format!(
                    "{file}: open ground square {sq:?}: {before} -> {} pieces inside it, mm bounds {now:?}",
                    now.len()
                ));
            }
        }
        println!(
            "{file}: {floors} floors and {} squares compared",
            with.len()
        );
    }
    println!("{sealed:#?}");
    assert!(
        sealed.is_empty(),
        "{} places newly sealed off",
        sealed.len()
    );
}

/// A piece's box on the ground plane, mm: `[x0, z0, x1, z1]`.
fn bounds(p: &sim::ground::Piece) -> [i32; 4] {
    p.vertices
        .iter()
        .fold([i32::MAX, i32::MAX, i32::MIN, i32::MIN], |b, v| {
            [
                b[0].min(v[0]),
                b[1].min(v[2]),
                b[2].max(v[0]),
                b[3].max(v[2]),
            ]
        })
}
