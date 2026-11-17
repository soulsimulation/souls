//! N1 (#2649): the importer's checks. The first runs everywhere on a small facts file written here. The second loads
//! Eden 2026's facts, which the exporter generates and nobody commits: run it with
//! `node v2/tools/import-eden/export/export.ts` from the repository root, then
//! `cargo test -p import-eden --release -- --ignored --nocapture` from `v2/`.

use import_eden::json::{self, Json};
use import_eden::{
    F_DOORWAY, F_DOORWAYS, F_HEIGHT, F_LINE, F_LINE_WIDTH, F_NAME, F_OUTLINE, F_PLACE_KIND,
    F_PLACE_OF, F_SILL, F_STAIRS, F_WIDTH, FLOOR, Import, PLACE, ROOM, WINDOW, count, load,
    world_of,
};
use replica::encode::Value;
use replica::world_model::plain;

fn kind_of(im: &Import, key: &str) -> String {
    let h = im.tree.handle(im.nodes[key]).expect("a node");
    plain(im.tree.node(h).expect("live").kind().as_str()).to_owned()
}

fn parent_key(im: &Import, key: &str) -> String {
    let h = im.tree.handle(im.nodes[key]).expect("a node");
    let p = im.tree.node(h).expect("live").parent().expect("a parent");
    im.nodes
        .iter()
        .find(|(_, v)| **v == p)
        .map(|(k, _)| k.clone())
        .expect("a keyed parent")
}

/// A house turned 90 degrees at (10, 0, 20) m: two rooms below and one above, a door between the two below and one
/// out, a window, a stair, a door thing in the inner doorway, a chair in the kitchen; a lake with its shore.
const SMALL: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [
    {"ref": "core-house@1", "hash": "aa", "name": "core:house", "form": "point"},
    {"ref": "core-door@2", "hash": "bb", "name": "core:door", "form": "point"},
    {"ref": "core-chair@1", "hash": "cc", "name": "core:chair", "form": "point"},
    {"ref": "core-lake@1", "hash": "dd", "name": "core:lake", "form": "area"}
  ],
  "things": [
    {"id": "e_house", "def": "core-house@1", "ref": "core-house@1", "parent": null, "pose": [10000, 0, 20000, 90000],
     "world": [10000, 0, 20000, 90000], "scale_ppm": 1000000, "name": "test-house",
     "solids": [[0, 3000, 4000, 100, 0, 0, 2600, 1, 0]],
     "floors": [{"level": 0, "y": 100, "polygon": [[-4000, -3000], [4000, -3000], [4000, 3000], [-4000, 3000]]},
                {"level": 1, "y": 2900, "polygon": [[-4000, -3000], [4000, -3000], [4000, 3000], [-4000, 3000]]}],
     "rooms": [
       {"id": "kitchen", "name": "Kitchen", "floor": 0, "pose": [-2000, 100, 0, 0], "height": 2600, "polygon": [[-2000, -3000], [2000, -3000], [2000, 3000], [-2000, 3000]]},
       {"id": "hall", "name": "Hall", "floor": 0, "pose": [2000, 100, 0, 0], "height": 2600, "polygon": [[-2000, -3000], [2000, -3000], [2000, 3000], [-2000, 3000]]},
       {"id": "loft", "name": "Loft", "floor": 1, "pose": [0, 2900, 0, 0], "height": 2400, "polygon": [[-4000, -3000], [4000, -3000], [4000, 3000], [-4000, 3000]]}],
     "openings": [
       {"id": "inner", "kind": "door", "at": [0, 0], "yaw": 90000, "width": 900, "height": 2100, "level": 0, "from": "kitchen", "to": "hall"},
       {"id": "front", "kind": "door", "at": [2000, 3000], "yaw": 0, "width": 1200, "height": 2100, "level": 0, "from": "hall", "to": "outside"},
       {"id": "window-1", "kind": "window", "at": [-2000, -3000], "yaw": 180000, "width": 1000, "height": 1250, "sill": 900, "level": 0, "from": "kitchen", "fromWall": true, "inRoom": [0, 0, -3000, 180000]}],
     "stairs": [{"id": "stairs", "kind": "stairs", "from": 0, "to": 1, "path": [[3000, -2000], [3000, 2000]], "width": 900, "y0": 100, "y1": 2900}],
     "slots": [{"n": 4, "id": "porch", "kind": "floor", "at": [0, 0, 4000], "yaw": 0}]},
    {"id": "e_door", "def": "core-door@2", "ref": "core-door@2", "parent": "e_house", "pose": [0, 100, 0, 90000],
     "world": [10000, 100, 20000, 180000], "scale_ppm": 1000000, "door": {"open": false}},
    {"id": "e_chair", "def": "core-chair@1", "ref": "core-chair@1", "parent": "e_house", "slot": {"room": "kitchen"},
     "pose": [1000, 0, 500, 0], "world": [10500, 100, 21000, 90000], "scale_ppm": 1000000},
    {"id": "e_lake", "def": "core-lake@1", "ref": "core-lake@1", "parent": null, "pose": [0, 0, 0, 0], "world": [0, 0, 0, 0],
     "scale_ppm": 1000000, "name": "west-lake", "worldShape": true, "water": {"level": -500, "area": [[50000, 0], [60000, 0], [60000, 10000]]}}
  ],
  "doors": [{"door": "e_door", "thing": "e_house", "opening": "inner"}],
  "places": [
    {"id": "e_lake.water", "of": "water", "kind": "lake", "entity": "e_lake", "name": "west-lake", "polygon": [[50000, 0], [60000, 0], [60000, 10000]], "level": -500},
    {"id": "e_lake.shore", "of": "shore", "kind": "shore", "entity": "e_lake", "name": "west-lake shore", "polygon": [[49000, -1000], [61000, -1000], [61000, 11000]]}
  ],
  "bake": {"things": 4, "doors": 1, "rooms": 3, "floors": 2, "floor surfaces": 2, "solids": 1, "slots": 1, "windows": 1, "doorways": 2, "stairs:stairs": 1},
  "byRef": {"core-house@1": 1, "core-door@2": 1, "core-chair@1": 1, "core-lake@1": 1}
}"#;

#[test]
fn a_small_world_loads_through_commit_with_its_rooms_doorways_windows_stairs_and_places() {
    let im = load(SMALL).expect("the small world loads through commit");
    let (rows, by_ref, _) = count(&im);
    for r in &rows {
        assert_eq!(r.tree, r.bake, "{}", r.what);
    }
    assert_eq!(by_ref, im.by_ref);
    assert!(im.notes.is_empty(), "{:?}", im.notes);

    // Rooms under their floor, floors under the house, the chair in its room, the window under the room it opens from.
    assert_eq!(kind_of(&im, "e_house/kitchen"), ROOM);
    assert_eq!(parent_key(&im, "e_house/kitchen"), "e_house/floor-0");
    assert_eq!(parent_key(&im, "e_house/loft"), "e_house/floor-1");
    assert_eq!(kind_of(&im, "e_house/floor-1"), FLOOR);
    assert_eq!(parent_key(&im, "e_chair"), "e_house/kitchen");
    assert_eq!(kind_of(&im, "e_house/window-1"), WINDOW);
    assert_eq!(parent_key(&im, "e_house/window-1"), "e_house/kitchen");
    let t = &im.tree;
    let window = t
        .node(t.handle(im.nodes["e_house/window-1"]).unwrap())
        .unwrap();
    assert_eq!(window.fields().get(&F_WIDTH), Some(&Value::Uint(1000)));
    assert_eq!(window.fields().get(&F_SILL), Some(&Value::Uint(900)));
    assert!(
        t.links_of(t.handle(im.nodes["e_house/window-1"]).unwrap())
            .unwrap()
            .is_empty(),
        "a window joins nothing"
    );

    // The inner doorway joins the two rooms; the door holds its id; the front door leads to the open ground.
    let kitchen = t.handle(im.nodes["e_house/kitchen"]).unwrap();
    let links = t.links_of(kitchen).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].other, im.nodes["e_house/hall"]);
    let door = t.node(t.handle(im.nodes["e_door"]).unwrap()).unwrap();
    assert_eq!(
        door.fields().get(&F_DOORWAY),
        Some(&links[0].link.to_value())
    );
    let hall = t.handle(im.nodes["e_house/hall"]).unwrap();
    assert!(
        t.links_of(hall)
            .unwrap()
            .iter()
            .any(|e| e.other == im.nodes["ground"])
    );
    assert!(t.node(kitchen).unwrap().fields().contains_key(&F_DOORWAYS));
    // The stair joins floor 0 to floor 1 and its path is a field of floor 0.
    let f0 = t.handle(im.nodes["e_house/floor-0"]).unwrap();
    assert_eq!(
        t.links_of(f0).unwrap()[0].other,
        im.nodes["e_house/floor-1"]
    );
    assert!(t.node(f0).unwrap().fields().contains_key(&F_STAIRS));

    // The lake and its shore are places under the open ground with an outline, and hold nobody.
    for key in ["e_lake.water", "e_lake.shore"] {
        assert_eq!(kind_of(&im, key), PLACE);
        assert_eq!(parent_key(&im, key), "ground");
        let h = t.handle(im.nodes[key]).unwrap();
        assert!(t.node(h).unwrap().fields().contains_key(&F_OUTLINE));
        assert!(t.node(h).unwrap().fields().contains_key(&F_PLACE_OF));
        assert!(t.children(h).unwrap().is_empty());
    }

    // Yaw on the turned house: the chair, 1 m along the room's x and 0.5 m along its z, from the kitchen (2 m along
    // the house's -x), with the house turned +90 degrees: world x = 10 + z, world z = 20 - x (worldPose's turn).
    let chair = world_of(&im, im.nodes["e_chair"]).unwrap();
    assert_eq!(
        (chair.x, chair.y, chair.z),
        (10_500_000, 100_000, 21_000_000)
    );
}

#[test]
#[ignore = "needs the generated Eden 2026 facts file (see the module doc)"]
fn eden_2026_loads_with_the_bakes_counts_and_its_poses_compose_to_the_world() {
    let path = std::env::var("IMPORT_EDEN_FACTS").unwrap_or_else(|_| {
        format!(
            "{}/../../../.local/import-eden/eden-2026.facts.json",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}; run the exporter first"));
    let im = load(&text).expect("Eden 2026 loads through commit");
    let (rows, by_ref, extra) = count(&im);
    for r in &rows {
        println!("{}: tree {}, bake {}", r.what, r.tree, r.bake);
        assert_eq!(r.tree, r.bake, "{}", r.what);
    }
    assert_eq!(by_ref, im.by_ref, "things per def ref");
    assert!(im.notes.is_empty(), "{:?}", im.notes);
    assert_eq!(extra.get("places eden:water"), Some(&8), "the eight waters");
    assert_eq!(
        extra.get("places eden:shore"),
        Some(&8),
        "a shore for each water"
    );
    assert_eq!(extra.get("doors in a doorway"), Some(&651));

    // Every window is under a room, with its width, height and sill, and joins nothing. Every named place is under
    // the open ground with a name, a kind and an outline (a polygon, or a line and a width), and holds nobody.
    let t = &im.tree;
    let (mut windows, mut places) = (0, 0);
    for (key, id) in &im.nodes {
        let Some(h) = t.handle(*id) else { continue };
        let n = t.node(h).unwrap();
        let f = n.fields();
        match plain(n.kind().as_str()) {
            WINDOW => {
                windows += 1;
                assert_eq!(kind_of(&im, &parent_key(&im, key)), ROOM, "{key}");
                assert!(
                    [F_WIDTH, F_HEIGHT, F_SILL]
                        .iter()
                        .all(|k| f.contains_key(k)),
                    "{key}"
                );
                assert!(t.links_of(h).unwrap().is_empty(), "{key} joins nothing");
            }
            PLACE => {
                places += 1;
                assert_eq!(parent_key(&im, key), "ground", "{key}");
                assert!(
                    [F_NAME, F_PLACE_KIND, F_PLACE_OF]
                        .iter()
                        .all(|k| f.contains_key(k)),
                    "{key}"
                );
                assert!(
                    f.contains_key(&F_OUTLINE)
                        || (f.contains_key(&F_LINE) && f.contains_key(&F_LINE_WIDTH)),
                    "{key}"
                );
                assert!(t.children(h).unwrap().is_empty(), "{key} holds nobody");
            }
            _ => {}
        }
    }
    println!("{windows} windows under their rooms; {places} named places under the open ground");
    assert_eq!(windows, 2574);

    // Every thing's pose, composed up the tree, lands where today's worldPose puts it.
    let f = json::parse(&text).unwrap();
    let (mut worst, mut turned) = (0i64, 0usize);
    for t in f.get("things").unwrap().arr() {
        let id = t.get("id").and_then(Json::str).unwrap();
        let w: Vec<i64> = t
            .get("world")
            .unwrap()
            .arr()
            .iter()
            .map(|n| n.int().unwrap())
            .collect();
        if t.get("rooms").is_some() && w[3] % 90_000 != 0 {
            turned += 1;
        }
        if t.get("worldShape").is_some() {
            continue; // a path or area at the root: its geometry is in the world frame already
        }
        let p = world_of(&im, im.nodes[id]).unwrap();
        let err = [(p.x, w[0]), (p.y, w[1]), (p.z, w[2])]
            .iter()
            .map(|(um, mm)| (um - mm * 1000).abs())
            .max()
            .unwrap();
        worst = worst.max(err);
    }
    println!(
        "{turned} buildings turned off the axes; worst distance from today's world pose: {worst} µm"
    );
    assert!(turned > 0);
    assert!(
        worst <= 5_000,
        "a pose is {worst} µm from today's world pose"
    );
}
