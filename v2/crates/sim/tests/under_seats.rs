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
    // the table's long side, 0.25 m off its top's edge (the box is taken in, `UNDER_INSET`).
    assert!(walkable(&p, -3000 + 600, -3350), "in front of the bench");
    assert!(walkable(&p, 3000, -3000 - 600), "at the table's edge");
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
