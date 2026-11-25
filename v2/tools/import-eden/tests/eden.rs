//! N1 (#2649): the importer's checks. The first runs everywhere on a small facts file written here. The second loads
//! Eden 2026's facts, which the exporter generates and nobody commits: run it with
//! `node v2/tools/import-eden/export/export.ts` from the repository root, then
//! `cargo test -p import-eden --release -- --ignored --nocapture` from `v2/`.

use import_eden::json::{self, Json};
use import_eden::{
    F_DEF_BODIES, F_DOORWAY, F_DOORWAYS, F_GROUND_PALETTE, F_HEIGHT, F_LINE, F_LINE_WIDTH, F_NAME,
    F_OUTLINE, F_PARAMS, F_PLACE_KIND, F_PLACE_OF, F_SILL, F_STAIRS, F_TILE_SIZE, F_TILES, F_WIDTH,
    FLOOR, Import, PLACE, ROOM, WINDOW, base64, count, load, world_of,
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
fn a_stair_from_a_floor_to_itself_is_walked_as_that_floor() {
    // A flight between two pieces of one storey (the Mars campus's Chiba deck) can be no link (link-self): it becomes
    // the floor's surfaces, split halfway where its ends are apart (16 mm), and counts as the flight it is. One rising
    // more than a step is noted, not linked.
    let stair = r#"{"id": "stairs", "kind": "stairs", "from": 0, "to": 1, "path": [[3000, -2000], [3000, 2000]], "width": 900, "y0": 100, "y1": 2900}"#;
    let text = SMALL.replace(
        stair,
        &format!(
            r#"{stair},
     {{"id": "step", "kind": "stairs", "from": 1, "to": 1, "path": [[0, 0], [0, 500]], "width": 680, "y0": 2900, "y1": 2916}},
     {{"id": "level", "kind": "stairs", "from": 1, "to": 1, "path": [[0, 0], [1000, 0]], "width": 680, "y0": 2900, "y1": 2900}},
     {{"id": "high", "kind": "stairs", "from": 1, "to": 1, "path": [[0, 0], [0, 500]], "width": 680, "y0": 2900, "y1": 3200}}"#
        ),
    );
    assert_ne!(text, SMALL);
    let im = load(&text).expect("loads");
    assert_eq!(
        im.notes,
        vec![
            "e_house: a stair on floor 1 to itself rising more than a step, not linked".to_owned()
        ]
    );
    assert_eq!(im.floor_flights, (2, 3));
    let surfaces = match im
        .tree
        .node(im.tree.handle(im.nodes["e_house/floor-1"]).unwrap())
        .unwrap()
        .fields()
        .get(&import_eden::F_SURFACES)
    {
        Some(Value::Array(a)) => a.clone(),
        other => panic!("{other:?}"),
    };
    // The floor's own surface, then the step's two halves (2900 to the middle, 2916 from it) and the level flight,
    // each 680 + 2 × 360 mm wide.
    let row = |k: usize| format!("{:?}", surfaces[k]);
    assert_eq!(surfaces.len(), 4);
    assert!(
        row(1).contains("Uint(2900)") && row(1).contains("Uint(250)"),
        "{}",
        row(1)
    );
    assert!(
        row(2).contains("Uint(2916)") && row(2).contains("Uint(250)"),
        "{}",
        row(2)
    );
    assert!(
        row(3).contains("Uint(700)") && row(3).contains("Nint(699)"),
        "{}",
        row(3)
    );
    let (rows, ..) = count(&im);
    let get = |w: &str| rows.iter().find(|r| r.what == w).unwrap().tree;
    assert_eq!(get("stairs (links)"), 3);
    assert_eq!(get("floor surfaces"), 2);
}

#[test]
fn a_window_in_no_rooms_wall_is_the_nearest_rooms() {
    // The Mars kitchen's serving hatch: an outer wall's window naming no room is the window of the room nearest it.
    let text = SMALL.replace(
        r#"{"id": "window-1", "kind": "window", "at": [-2000, -3000], "yaw": 180000, "width": 1000, "height": 1250, "sill": 900, "level": 0, "from": "kitchen", "fromWall": true, "inRoom": [0, 0, -3000, 180000]}"#,
        r#"{"id": "window-1", "kind": "window", "at": [3000, 4000], "yaw": 90000, "width": 3070, "height": 1260, "sill": 1370, "level": 0}"#,
    );
    assert_ne!(text, SMALL);
    let im = load(&text).expect("loads");
    assert!(im.notes.is_empty(), "{:?}", im.notes);
    assert_eq!(parent_key(&im, "e_house/window-1"), "e_house/hall");
    let h = im.tree.handle(im.nodes["e_house/window-1"]).unwrap();
    let p = im.tree.node(h).unwrap().place().unwrap().position;
    // The hall's origin is (2000, 100, 0) in the house: the hatch is 1000 mm east and 4000 mm south of it.
    assert_eq!((p.x, p.y, p.z), (1_000_000, 0, 4_000_000));
    let (rows, ..) = count(&im);
    assert_eq!(
        rows.iter()
            .find(|r| r.what == "windows (nodes)")
            .unwrap()
            .tree,
        1
    );
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
        let n = im
            .tree
            .node(im.tree.handle(im.nodes[key]).unwrap())
            .unwrap();
        n.fields().get(&F_PARAMS).cloned()
    };
    assert_eq!(
        field(&im, "e_house"),
        Some(Value::Bytes(
            br#"{"w":12,"material":"brick","roofPitch":22.5}"#.to_vec()
        ))
    );
    assert_eq!(field(&im, "e_chair"), None);
}

/// The world's own defs (the exporter's `ground.defs`: ref and stored def as JSON text) are the open ground's field
/// F_DEF_BODIES, `[[ref, def] …]` byte for byte, and on no thing: removing a thing of such a def never takes it away.
#[test]
fn the_worlds_own_defs_are_kept_once_on_the_open_ground() {
    let body = r#"{\"schema\":\"def/1\",\"name\":\"test-house\",\"version\":1}"#;
    let text = SMALL.replace(
        r#""ground": {"tileM": 2,"#,
        &format!(
            r#""ground": {{"defs": [{{"ref": "test-house@1", "body": "{body}"}}], "tileM": 2,"#
        ),
    );
    assert_ne!(text, SMALL);
    let im = load(&text).expect("loads");
    let t = &im.tree;
    let g = t.node(t.handle(im.nodes["ground"]).unwrap()).unwrap();
    assert_eq!(
        g.fields().get(&F_DEF_BODIES),
        Some(&Value::Array(vec![Value::Array(vec![
            Value::Bytes(b"test-house@1".to_vec()),
            Value::Bytes(br#"{"schema":"def/1","name":"test-house","version":1}"#.to_vec()),
        ])]))
    );
    for (key, id) in &im.nodes {
        if key != "ground" {
            let n = t.node(t.handle(*id).unwrap()).unwrap();
            assert!(!n.fields().contains_key(&F_DEF_BODIES), "{key}");
        }
    }
    let plain = load(SMALL).expect("loads");
    let g = plain
        .tree
        .node(plain.tree.handle(plain.nodes["ground"]).unwrap())
        .unwrap();
    assert!(
        !g.fields().contains_key(&F_DEF_BODIES),
        "no own defs, no field"
    );
}

/// The facts' ground palette (today's `state.ground.palette`) is the open ground's F_GROUND_PALETTE, `souls:<palette>`,
/// so a page drawing from the stream colours a desert world's ground as desert; a ground that names none has no field.
#[test]
fn the_ground_palette_is_kept_on_the_open_ground() {
    let text = SMALL.replace(
        r#""ground": {"tileM": 2,"#,
        r#""ground": {"palette": "desert", "tileM": 2,"#,
    );
    assert_ne!(text, SMALL);
    let im = load(&text).expect("loads");
    let g = im
        .tree
        .node(im.tree.handle(im.nodes["ground"]).unwrap())
        .unwrap();
    assert_eq!(
        g.fields().get(&F_GROUND_PALETTE),
        Some(&Value::Text(Name::new("souls:desert").unwrap()))
    );
    let plain = load(SMALL).expect("loads");
    let g = plain
        .tree
        .node(plain.tree.handle(plain.nodes["ground"]).unwrap())
        .unwrap();
    assert!(
        !g.fields().contains_key(&F_GROUND_PALETTE),
        "no palette, no field"
    );
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
    // A thing that names the entry but declares no slots of its own (Eden's launch balloon, a `core/balloon` by another
    // name) has no shape of its own to fit: it takes the entry's seats as the entry places them.
    let bare = SMALL.replace(
        r#""pose": [1000, 0, 500, 0], "world": [10500, 100, 21000, 90000], "scale_ppm": 1000000},"#,
        r#""pose": [1000, 0, 500, 0], "world": [10500, 100, 21000, 90000], "scale_ppm": 1000000, "entry": "eden:sofa"},"#,
    );
    assert_ne!(bare, SMALL);
    let im = load(&bare).expect("loads");
    let (seats, all) = import_eden::body_slots(&im.tree, &[("eden:sofa".into(), sofa.clone())]);
    assert_eq!(all, 3);
    let got: Vec<_> = seats.iter().map(|s| (s.slot, s.at, s.stand)).collect();
    assert_eq!(
        got,
        vec![
            (1, v(-600, 520, 100), v(-600, 0, 740)),
            (2, v(0, 520, 100), v(0, 0, 740)),
            (3, v(600, 520, 100), v(600, 0, 740)),
        ]
    );
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

/// 0.135 E16: a slot whose `most` is above one has that many places: its point and the others, a standard body's
/// clearance diameter (560 mm) apart, nearest first, each body's clearance circle inside the thing's footprint. A
/// tent's `sleep` (`most: 2`, at z -300 mm in a 1981 x 2500 mm tent) gets one more place 560 mm to its side; a slot
/// whose thing is too small for another body, or declares no bounds, holds one.
#[test]
fn e16_a_slot_of_several_bodies_has_a_place_for_each_inside_its_thing() {
    use import_eden::more_places;
    use replica::pose::Vec3;
    let tent = Vec3::new(0, 100_000, -300_000);
    assert_eq!(
        more_places(tent, 2, Some([1_981_000, 2_500_000])),
        vec![Vec3::new(-560_000, 0, 0)]
    );
    assert!(more_places(tent, 2, Some([800_000, 800_000])).is_empty());
    assert!(more_places(tent, 2, None).is_empty());
    // A petanque circle (`most: 6`) on a 3 m wide piste: five more, all inside it, each 560 mm or more from the rest.
    let circle = Vec3::new(0, 0, -5_400_000);
    let more = more_places(circle, 6, Some([3_000_000, 12_000_000]));
    assert_eq!(more.len(), 5);
    // From an entry: a body-sized thing's footprint is its slot's space; a thing taller than a body (a big wheel's
    // gondola) has none of its own unless the slot declares one (`fits_mm`), so it holds one body.
    let entry = |bounds: &str, fits: &str| {
        let e = replica::rules::json::parse(&format!(
            r#"{{"kind":"t:x","points":{{"by":{{"role":"stand","at_mm":[0,0,900]}}}},
            "slots":{{"s":{{"admits":"body","posture":"sit","most":2,"at_mm":[0,1500,0],"stand":"by"{fits}}}}},
            "geometry":{{"bounds_mm":{bounds}}}}}"#
        ))
        .unwrap();
        let id = replica::ids::Id::new(replica::ids::Scope([1; 16]), 1).unwrap();
        import_eden::body_slots_of(id, "t:x", &Default::default(), &[("t:x".into(), e)])
            .remove(0)
            .more
    };
    assert_eq!(
        entry("[1981, 1330, 2500]", "").len(),
        1,
        "a tent-sized thing"
    );
    assert!(
        entry("[30000, 30000, 8000]", "").is_empty(),
        "a big wheel's gondola"
    );
    assert_eq!(
        entry("[30000, 30000, 8000]", r#","fits_mm":[1800,1200,900]"#),
        vec![Vec3::new(-560_000, 0, 0)],
        "a gondola that declares its own space"
    );
    let all: Vec<Vec3> = std::iter::once(Vec3::ZERO).chain(more).collect();
    for (i, p) in all.iter().enumerate() {
        assert!(
            (circle.x + p.x).abs() + 280_000 <= 1_500_000,
            "{p:?} inside"
        );
        for q in &all[i + 1..] {
            let d2 = i128::from(p.x - q.x).pow(2) + i128::from(p.z - q.z).pow(2);
            assert!(d2 >= 559_000i128.pow(2), "{p:?} and {q:?} apart");
        }
    }
}

/// A dome at (0, -2.258, 0) m whose one floor holds its garden room (as verdelis-eden's does), with two decor things
/// inside: a bubble (no entry, so no point but its own) and a cable car whose entry puts a station 60 m past the dome.
const DOME: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [
    {"ref": "eden-dome@1", "hash": "aa", "name": "eden:eden_dome", "form": "point", "layer": "solid"},
    {"ref": "eden-bubble@1", "hash": "bb", "name": "eden:eden_bubble", "form": "point", "layer": "decor"},
    {"ref": "eden-cable-car@1", "hash": "cc", "name": "eden:eden_cable_car", "form": "point", "layer": "decor"}
  ],
  "things": [
    {"id": "e_dome", "def": "eden-dome@1", "ref": "eden-dome@1", "parent": null, "pose": [0, -2258, 0, 0],
     "world": [0, -2258, 0, 0], "scale_ppm": 1000000, "name": "dome",
     "floors": [{"level": 0, "y": 0, "polygon": [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]]}],
     "rooms": [{"id": "garden", "name": "Garden", "floor": 0, "pose": [1000, 0, 0, 0], "height": 20000,
                "polygon": [[-19000, -19000], [19000, -19000], [19000, 19000], [-19000, 19000]]}]},
    {"id": "e_bubble", "def": "eden-bubble@1", "ref": "eden-bubble@1", "parent": null, "pose": [5000, -2258, 3000, 0],
     "world": [5000, -2258, 3000, 0], "scale_ppm": 1000000, "noEntry": "no row in the map"},
    {"id": "e_car", "def": "eden-cable-car@1", "ref": "eden-cable-car@1", "parent": null, "pose": [-5000, -2258, 0, 0],
     "world": [-5000, -2258, 0, 0], "scale_ppm": 1000000}
  ],
  "doors": [],
  "places": [],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 3, "rooms": 1, "floors": 1, "floor surfaces": 1},
  "byRef": {"eden-dome@1": 1, "eden-bubble@1": 1, "eden-cable-car@1": 1}
}"#;

#[test]
fn scenery_inside_a_building_is_on_its_floor_unless_its_entry_reaches_past_it() {
    let car = r#"{"format": "souls-entry/1", "kind": "eden:cable_car",
      "points": {"valley_station": {"role": "stand", "at_mm": [0, 0, 60000]}}}"#;
    let im = import_eden::load_with(DOME, &[("cable_car.json".into(), car.into())])
        .expect("the dome loads with its entries");
    // The bubble stands in the garden room, at its pose there: the open ground is cut out under the floor.
    assert_eq!(parent_key(&im, "e_bubble"), "e_dome/garden");
    let h = im.tree.handle(im.nodes["e_bubble"]).unwrap();
    let p = im.tree.node(h).unwrap().place().unwrap().position;
    assert_eq!((p.x, p.y, p.z), (4_000_000, 0, 3_000_000));
    // The cable car's station is 60 m past the dome, so the car stays on the open ground.
    assert_eq!(parent_key(&im, "e_car"), "ground");
    // An entry whose points all stand on the floor takes the car in too.
    let near = car.replace("60000", "6000");
    let both = import_eden::load_with(DOME, &[("cable_car.json".into(), near)]).unwrap();
    assert_eq!(parent_key(&both, "e_car"), "e_dome/garden");
    // With no entries the points are not known: scenery stays where the facts put it, as before.
    let bare = load(DOME).unwrap();
    assert_eq!(parent_key(&bare, "e_bubble"), "ground");
    assert_eq!(parent_key(&bare, "e_car"), "ground");
}

/// Old Eden's residents were exported as `core/humanoid@1` things (live Eden's facts, entries 4997–5018): a Soul is
/// not a thing. The small world with two Souls' bodies in its facts loads to the same tree as the small world alone,
/// the bake's counts less the bodies, and each body is listed by its origin id and name.
#[test]
fn a_souls_body_in_the_facts_is_no_thing() {
    let body = |id: &str, name: &str, def: &str| {
        format!(
            r#"{{"id": "{id}", "def": "{def}", "ref": "core-humanoid@1", "parent": null, "pose": [5000, 0, 5000, 0],
     "world": [5000, 0, 5000, 0], "scale_ppm": 1000000, "name": "{name}", "noEntry": "no row in the map",
     "slots": [{{"n": 1, "id": "carry", "kind": "carry", "at": [0, 1000, 350], "yaw": 0, "capacity": 2}}]}}"#
        )
    };
    let bodies = format!(
        ",\n    {},\n    {}\n  ],\n  \"doors\": [",
        body("h_277f3d50b1", "oriel", "core/humanoid@1"),
        body("h_03fb85042a", "cleo", "core-humanoid@1")
    );
    let with = SMALL
        .replacen("\n  ],\n  \"doors\": [", &bodies, 1)
        .replacen(
            r#"{"ref": "core-lake@1", "hash": "dd", "name": "core:lake", "form": "area"}"#,
            r#"{"ref": "core-lake@1", "hash": "dd", "name": "core:lake", "form": "area"},
    {"ref": "core-humanoid@1", "hash": "ee", "name": "core:humanoid", "form": "point", "layer": "solid", "slots": 1}"#,
            1,
        )
        .replacen(r#""bake": {"things": 4,"#, r#""bake": {"things": 6,"#, 1)
        .replacen(r#""slots": 1, "windows""#, r#""slots": 3, "windows""#, 1)
        .replacen(r#""core-lake@1": 1}"#, r#""core-lake@1": 1, "core-humanoid@1": 2}"#, 1);
    assert!(
        with.contains("h_03fb85042a")
            && with.contains(r#""things": 6"#)
            && with.contains(r#""slots": 3"#)
    );
    let im = load(&with).expect("the small world with two bodies loads");
    let (rows, by_ref, _) = count(&im);
    for r in &rows {
        assert_eq!(r.tree, r.bake, "{}", r.what);
    }
    assert_eq!(by_ref, im.by_ref);
    assert!(
        !im.by_ref.contains_key("core-humanoid@1"),
        "{:?}",
        im.by_ref
    );
    assert_eq!(
        im.residents,
        vec![
            ("h_277f3d50b1".to_owned(), "oriel".to_owned()),
            ("h_03fb85042a".to_owned(), "cleo".to_owned())
        ]
    );
    // The same tree as the world without them: the same nodes and the same root, so the same world's name.
    let alone = load(SMALL).unwrap();
    assert_eq!(im.nodes, alone.nodes);
    assert_eq!(im.tree.root(), alone.tree.root());
    assert!(alone.residents.is_empty());

    // A thing a body held would lose its parent: refused by name, never placed somewhere new.
    let held = with.replacen(
        r#""parent": "e_house", "pose": [0, 100"#,
        r#""parent": "h_03fb85042a", "pose": [0, 100"#,
        1,
    );
    assert_ne!(held, with);
    let e = load(&held).err().expect("a thing on a body is refused");
    assert!(e.contains("e_door") && e.contains("Soul's body"), "{e}");
}
