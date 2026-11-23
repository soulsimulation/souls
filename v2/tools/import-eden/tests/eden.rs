//! N1 (#2649): the importer's checks. The first runs everywhere on a small facts file written here. The second loads
//! Eden 2026's facts, which the exporter generates and nobody commits: run it with
//! `node v2/tools/import-eden/export/export.ts` from the repository root, then
//! `cargo test -p import-eden --release -- --ignored --nocapture` from `v2/`.

use import_eden::json::{self, Json};
use import_eden::{
    F_DOORWAY, F_DOORWAYS, F_HEIGHT, F_LINE, F_LINE_WIDTH, F_NAME, F_OUTLINE, F_PARAMS, F_PLACE_KIND,
    F_PLACE_OF, F_SILL, F_STAIRS, F_TILE_SIZE, F_TILES, F_WIDTH, FLOOR, Import, PLACE, ROOM,
    WINDOW, base64, count, load, world_of,
};
use replica::effects::{Header, Part};
use replica::encode::{Name, Value};
use replica::sky::{self, Mist, Presentation};
use replica::tree::Tree;
use replica::world_model::plain;
use sim::audit::Auditor;

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
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
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

    // The terrain is the open ground's: its tile side in mm and the tile's bytes as exported (N1b, #3197).
    let g = t.node(t.handle(im.nodes["ground"]).unwrap()).unwrap();
    assert_eq!(g.fields().get(&F_TILE_SIZE), Some(&Value::Uint(2000)));
    let want = Value::Array(vec![Value::Array(vec![
        Value::Uint(0),
        Value::Uint(0),
        Value::Bytes(
            [0i32, 1000, 2000, 0, 1000, 2000, -500, 500, 1500]
                .iter()
                .flat_map(|h| h.to_le_bytes())
                .collect(),
        ),
        Value::Bytes(vec![0, 1, 2, 3]),
    ])]);
    assert_eq!(g.fields().get(&F_TILES), Some(&want));
}

/// V19c (#3521) A1, A3: Eden's sky settings (its presentation date, palette and morning mist) land on the world node,
/// and a copy built from the import's log alone reads the same; facts without `sky` write none.
#[test]
fn the_sky_settings_land_on_the_world_node_and_a_replay_reads_the_same() {
    let head = "\"format\": \"souls/import-eden/1\",";
    let sky = "\"sky\": {\"calendar\": \"06-05\", \"palette\": \"eden-summer\", \"mist\": [390, 150, 100]},";
    let im = load(&SMALL.replacen(head, &format!("{head} {sky}"), 1))
        .expect("the small world with its sky loads");
    let want = Presentation {
        date: Some([6, 5]),
        palette: Name::new("souls:eden-summer"),
        mist: Some(Mist {
            peak: 390 * 60_000_000,
            half: 150 * 60_000_000,
            strength: 100,
        }),
    };
    let world = im.tree.node(im.tree.root()).unwrap();
    assert_eq!(Presentation::read(world.fields()), want);
    let (header, part) = &im.log;
    let mut copy = Tree::start(world.id(), world.kind().clone());
    copy.apply(&Header::read(header).unwrap(), &Part::read(part).unwrap())
        .expect("the log applies");
    let replayed = copy.node(copy.root()).unwrap();
    assert_eq!(Presentation::read(replayed.fields()), want);
    assert_eq!(replayed.fields(), world.fields());

    let none = load(SMALL).unwrap();
    let f = none.tree.node(none.tree.root()).unwrap().fields().clone();
    assert!(
        ![sky::F_SKY_DATE, sky::F_PALETTE, sky::F_MIST]
            .iter()
            .any(|k| f.contains_key(k))
    );
    let bad = "\"sky\": {\"calendar\": \"02-30\"},";
    assert!(
        load(&SMALL.replacen(head, &format!("{head} {bad}"), 1)).is_err(),
        "a date no year has is refused"
    );
}

/// N1b (#3197) A1: every terrain tile's heights and classes, read back from the tree, are the exported bytes.
fn tiles_round_trip(im: &Import, facts: &Json) -> usize {
    let t = &im.tree;
    let g = t.node(t.handle(im.nodes["ground"]).unwrap()).unwrap();
    let Some(Value::Array(rows)) = g.fields().get(&F_TILES) else {
        panic!("the open ground holds no tiles")
    };
    let tiles = facts.get("ground").unwrap().get("tiles").unwrap().arr();
    assert_eq!(rows.len(), tiles.len());
    for (r, e) in rows.iter().zip(tiles) {
        let Value::Array(r) = r else {
            panic!("a tile row")
        };
        let field = |k: &str| base64(e.get(k).and_then(Json::str).unwrap()).unwrap();
        let int = |k: &str| e.get(k).and_then(Json::int).unwrap();
        let at = |v: &Value| match v {
            Value::Uint(u) => *u as i64,
            Value::Nint(n) => -1 - *n as i64,
            _ => panic!("a tile's place"),
        };
        assert_eq!((at(&r[0]), at(&r[1])), (int("tx"), int("tz")));
        assert_eq!(r[2], Value::Bytes(field("heights")), "heights");
        assert_eq!(r[3], Value::Bytes(field("classes")), "classes");
    }
    rows.len()
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
    // V19c (#3521): Eden's sky is drawn on 5 June, in its summer palette, with today's morning mist.
    let shown = Presentation::read(im.tree.node(im.tree.root()).unwrap().fields());
    assert_eq!(shown.date, Some([6, 5]));
    assert_eq!(shown.palette, Name::new("souls:eden-summer"));
    assert_eq!(shown.mist.map(|m| m.strength), Some(100));
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

    let tiles = tiles_round_trip(&im, &f);
    println!("{tiles} terrain tiles read back byte for byte");
    assert_eq!(tiles, 256);

    // C27 (#3509): a stall in the market pavilion stands in its room, the podium on the commons deck's floor, and a
    // roof terrace's table on its hotel's roof floor; a stall on the open ground stays there.
    assert_eq!(parent_key(&im, "e_baf7b2e1"), "e_26f30b38/pavilion");
    assert_eq!(kind_of(&im, &parent_key(&im, "e_01496dba")), FLOOR);
    assert_eq!(parent_key(&im, "e_090ced77"), "e_ad082d88/floor-3");
    assert_eq!(parent_key(&im, "e_0ed9ffad"), "ground");

    // C9 (#3397): one full pass of K11's auditor over the seeded tree finds no slot holding two things.
    let mut a = Auditor::new();
    let mut faults = Vec::new();
    loop {
        let s = a.slice(&im.tree, 4096);
        faults.extend(s.faults);
        if s.pass_ended {
            break;
        }
    }
    let over = faults.iter().filter(|f| f.name == "slot-over-full").count();
    println!(
        "auditor, one pass: {} faults, {over} slot-over-full; left out of a full slot: {}",
        faults.len(),
        im.left_out.len()
    );
    for l in &im.left_out {
        println!("  {l}");
    }
    assert_eq!(over, 0, "{faults:?}");
    assert_eq!(im.left_out.len(), 29, "every thing left out is reported");
}

/// C9 (#3397): two things today puts in the house's one porch slot. The first keeps the slot; the second is reported
/// and stays a plain child of the house at its own place, so no slot holds two.
#[test]
fn a_second_thing_in_a_held_slot_is_left_out_of_it_and_reported() {
    let text = SMALL
        .replace(
            r#"{"ref": "core-chair@1", "hash": "cc", "name": "core:chair", "form": "point"},"#,
            r#"{"ref": "core-chair@1", "hash": "cc", "name": "core:chair", "form": "point"},
    {"ref": "core-crate@1", "hash": "ee", "name": "core:crate", "form": "point"},"#,
        )
        .replace(
            r#"    {"id": "e_lake","#,
            r#"    {"id": "e_crate1", "def": "core-crate@1", "ref": "core-crate@1", "parent": "e_house", "slot": {"n": 4, "id": "porch"},
     "pose": [0, 0, 4000, 0], "world": [14000, 0, 20000, 90000], "scale_ppm": 1000000},
    {"id": "e_crate2", "def": "core-crate@1", "ref": "core-crate@1", "parent": "e_house", "slot": {"n": 4, "id": "porch"},
     "pose": [500, 0, 4000, 0], "world": [14000, 0, 19500, 90000], "scale_ppm": 1000000},
    {"id": "e_lake","#,
        );
    let im = load(&text).expect("loads");
    let slot = |key: &str| {
        let h = im.tree.handle(im.nodes[key]).unwrap();
        im.tree.node(h).unwrap().slot()
    };
    assert_eq!(slot("e_crate1"), Some(4));
    assert_eq!(slot("e_crate2"), None);
    assert_eq!(parent_key(&im, "e_crate2"), "e_house");
    assert_eq!(im.left_out.len(), 1, "{:?}", im.left_out);
    assert!(
        im.left_out[0]
            .starts_with("e_crate2 (core-crate@1): slot 4 of e_house already holds e_crate1"),
        "{:?}",
        im.left_out
    );
    // Both poses are from the house's origin, 500 mm apart: out of the slot, the second keeps its own place.
    let (p1, p2) = (
        world_of(&im, im.nodes["e_crate1"]).unwrap(),
        world_of(&im, im.nodes["e_crate2"]).unwrap(),
    );
    let (dx, dy, dz) = (p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    assert_eq!(dy, 0);
    assert!(
        ((dx * dx + dz * dz) as f64).sqrt().round() as i64 == 500_000,
        "{p1:?} {p2:?}"
    );
    let mut a = Auditor::new();
    let s = a.slice(&im.tree, 1 << 20);
    assert!(s.pass_ended && s.faults.is_empty(), "{:?}", s.faults);
}

#[test]
fn a_stair_from_a_floor_to_itself_is_noted_not_linked() {
    // A step between two surfaces of one level (the Mars campus's Chiba deck) once refused the whole import (link-self).
    let text = SMALL.replace(
        r#"{"id": "stairs", "kind": "stairs", "from": 0, "to": 1, "path": [[3000, -2000], [3000, 2000]], "width": 900, "y0": 100, "y1": 2900}"#,
        r#"{"id": "stairs", "kind": "stairs", "from": 0, "to": 1, "path": [[3000, -2000], [3000, 2000]], "width": 900, "y0": 100, "y1": 2900},
     {"id": "step", "kind": "stairs", "from": 1, "to": 1, "path": [[0, 0], [0, 500]], "width": 900, "y0": 2900, "y1": 2916}"#,
    );
    assert_ne!(text, SMALL);
    let im = load(&text).expect("loads");
    assert_eq!(
        im.notes,
        vec!["e_house: a stair on floor 1 to itself, not linked".to_owned()]
    );
    let (rows, ..) = count(&im);
    let stairs = rows.iter().find(|r| r.what == "stairs (links)").unwrap();
    assert_eq!(stairs.tree, 1);
}

/// A thing that names another kind's entry (field 27, from its world's map: a Mars sofa borrows `eden:sofa`) is found
/// by that entry, and its seats are at its own slots (its def's geometry) with the entry's stand offsets; an entry seat
/// it has no slot for is not offered. A thing naming no entry keeps its kind's name and the entry's own geometry.
/// W3 (0.135): a thing's def params (the exporter's JSON text) are its field 19, byte for byte; one with none has none.
#[test]
fn a_things_params_are_its_field_19() {
    let params = r#"{\"w\":12,\"material\":\"brick\",\"roofPitch\":22.5}"#;
    let text = SMALL.replace(
        r#""name": "test-house","#,
        &format!(r#""name": "test-house", "params": "{params}","#),
    );
    assert_ne!(text, SMALL);
    let im = load(&text).expect("loads");
    let field = |im: &Import, key: &str| {
        let n = im.tree.node(im.tree.handle(im.nodes[key]).unwrap()).unwrap();
        n.fields().get(&F_PARAMS).cloned()
    };
    assert_eq!(
        field(&im, "e_house"),
        Some(Value::Bytes(br#"{"w":12,"material":"brick","roofPitch":22.5}"#.to_vec()))
    );
    assert_eq!(field(&im, "e_chair"), None);
}

#[test]
fn a_thing_borrowing_an_entry_sits_at_its_own_slots() {
    let text = SMALL.replace(
        r#""slot": {"room": "kitchen"},
     "pose": [1000, 0, 500, 0], "world": [10500, 100, 21000, 90000], "scale_ppm": 1000000},"#,
        r#""slot": {"room": "kitchen"},
     "pose": [1000, 0, 500, 0], "world": [10500, 100, 21000, 90000], "scale_ppm": 1000000, "entry": "eden:sofa",
     "slots": [{"n": 1, "id": "seat-1", "kind": "seat", "at": [-655, 300, 100], "yaw": 0},
               {"n": 2, "id": "seat-2", "kind": "seat", "at": [0, 300, 100], "yaw": 0}]},"#,
    );
    assert_ne!(text, SMALL);
    let im = load(&text).expect("loads");
    let n = im
        .tree
        .node(im.tree.handle(im.nodes["e_chair"]).unwrap())
        .unwrap();
    assert_eq!(
        import_eden::entry_name(n.kind().as_str(), n.fields()),
        "eden:sofa"
    );
    let sofa = replica::rules::json::parse(
        r#"{"kind": "eden:sofa", "slots": {
            "seat_1": {"admits": "body", "posture": "sit", "at_mm": [-600, 520, 100], "stand": "f1"},
            "seat_2": {"admits": "body", "posture": "sit", "at_mm": [0, 520, 100], "stand": "f2"},
            "seat_3": {"admits": "body", "posture": "sit", "at_mm": [600, 520, 100], "stand": "f3"}},
          "points": {"f1": {"role": "stand", "at_mm": [-600, 0, 740]}, "f2": {"role": "stand", "at_mm": [0, 0, 740]},
                     "f3": {"role": "stand", "at_mm": [600, 0, 740]}}}"#,
    )
    .unwrap();
    let (seats, all) = import_eden::body_slots(&im.tree, &[("eden:sofa".into(), sofa.clone())]);
    assert_eq!(all, 3);
    let got: Vec<_> = seats.iter().map(|s| (s.slot, s.at, s.stand)).collect();
    let v = |x: i64, y: i64, z: i64| replica::pose::Vec3::new(x * 1000, y * 1000, z * 1000);
    assert_eq!(
        got,
        vec![
            (1, v(-655, 300, 100), v(-655, 0, 740)),
            (2, v(0, 300, 100), v(0, 0, 740)),
        ]
    );
    // One thing alone (a god edit's moved seat) is read the same way, from its own fields.
    let one = import_eden::body_slots_of(
        n.id(),
        n.kind().as_str(),
        n.fields(),
        &[("eden:sofa".into(), sofa.clone())],
    );
    assert_eq!(one, seats);
    // The same thing without field 27 is a `core:chair`, found by its own name: the sofa entry is not its.
    let im = load(SMALL).expect("loads");
    let n = im
        .tree
        .node(im.tree.handle(im.nodes["e_chair"]).unwrap())
        .unwrap();
    assert_eq!(
        import_eden::entry_name(n.kind().as_str(), n.fields()),
        "eden:chair"
    );
    assert!(
        import_eden::body_slots(&im.tree, &[("eden:sofa".into(), sofa)])
            .0
            .is_empty()
    );
}
