//! A raised building reached by an outside stair from the open ground (the Mars campus's kitchen and dining hall, 530 mm
//! up): its lower floor has no surface, so the stair's foot is on the open ground beside the building.

use replica::world_model::plain;
use sim::links::{Doors, Kind};
use sim::walk::town::Town;

/// A deck 530 mm up at (10, 0, 20) m, turned 90 degrees, 4 m square, with a stair from the ground up its east side.
const DECK: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [{"ref": "core-deck@1", "hash": "aa", "name": "core:deck", "form": "point"}],
  "things": [
    {"id": "e_deck", "def": "core-deck@1", "ref": "core-deck@1", "parent": null, "pose": [10000, 0, 20000, 90000],
     "world": [10000, 0, 20000, 90000], "scale_ppm": 1000000, "name": "test-deck",
     "floors": [{"level": 1, "y": 530, "polygon": [[-2000, -2000], [2000, -2000], [2000, 2000], [-2000, 2000]]}],
     "stairs": [{"id": "steps", "kind": "stairs", "from": 0, "to": 1, "path": [[4000, 0], [2000, 0]], "width": 1200, "y0": 0, "y1": 530}]}
  ],
  "doors": [],
  "places": [],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 1, "doors": 0, "rooms": 0, "floors": 2, "floor surfaces": 1, "solids": 0, "slots": 0, "windows": 0, "doorways": 0, "stairs:stairs": 1},
  "byRef": {"core-deck@1": 1}
}"#;

#[test]
fn an_outside_stair_starts_on_the_open_ground_when_its_lower_floor_has_no_surface() {
    let im = import_eden::load(DECK).expect("loads");
    let (root, ground, deck) = (im.nodes["world"], im.nodes["ground"], im.nodes["e_deck"]);
    let header = import_eden::header(root, &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let town = Town::new(im.tree, ground, Doors::new(header, im.rules, next)).unwrap();
    let b = town
        .buildings
        .iter()
        .find(|b| b.thing == deck)
        .expect("the deck");
    let stair = b
        .links
        .iter()
        .find(|l| l.kind == Kind::Stairs)
        .expect("its stair");
    assert_eq!(stair.blocked, None, "{stair:?}");
    let [Some(foot), Some(top)] = stair.ends else {
        panic!("both ends: {stair:?}")
    };
    assert_eq!(foot.floor, ground);
    let top_floor = town
        .tree
        .node(town.tree.handle(top.floor).unwrap())
        .unwrap();
    assert_eq!(plain(top_floor.kind().as_str()), import_eden::FLOOR);
    // The foot is in the ground's frame: 4 m east of the deck's middle along its own x, turned 90 degrees, on the ground.
    let m = foot.middle();
    assert!(
        (m.x - 10_000_000).abs() < 50_000 && (m.z - 16_000_000).abs() < 50_000,
        "{m:?}"
    );
    assert_eq!(top.middle().y, 530_000);
}

/// A roof 3 m up at (20, 0, 0) m, 6 m square, with no stair of its own, and beside it a flight from the ground whose
/// landing (1.1 m by 0.5 m, too small to stand on) lies over the roof's south edge at the roof's height, as Eden's
/// office roof stairs do. A yard around them is open ground.
const ROOF: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [{"ref": "core-roof@1", "hash": "aa", "name": "core:roof", "form": "point"},
            {"ref": "core-flight@1", "hash": "bb", "name": "core:flight", "form": "point"}],
  "things": [
    {"id": "e_roof", "def": "core-roof@1", "ref": "core-roof@1", "parent": null, "pose": [20000, 0, 0, 0],
     "world": [20000, 0, 0, 0], "scale_ppm": 1000000, "name": "test-roof",
     "floors": [{"level": 1, "y": 3000, "polygon": [[-3000, -3000], [3000, -3000], [3000, 3000], [-3000, 3000]]}]},
    {"id": "e_flight", "def": "core-flight@1", "ref": "core-flight@1", "parent": null, "pose": [20000, 0, 6000, 0],
     "world": [20000, 0, 6000, 0], "scale_ppm": 1000000, "name": "test-flight",
     "floors": [{"level": 1, "y": 3000, "polygon": [[-550, -3500], [550, -3500], [550, -3000], [-550, -3000]]}],
     "stairs": [{"id": "flight", "kind": "stairs", "from": 0, "to": 1, "path": [[0, 3000], [0, -3000]], "width": 1100, "y0": 0, "y1": 3000}]}
  ],
  "doors": [],
  "places": [{"id": "p_yard", "name": "yard", "kind": "zone", "of": "area",
              "polygon": [[8000, -8000], [32000, -8000], [32000, 16000], [8000, 16000]]}],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 2, "doors": 0, "rooms": 0, "floors": 3, "floor surfaces": 2, "solids": 0, "slots": 0, "windows": 0, "doorways": 0, "stairs:stairs": 1},
  "byRef": {"core-roof@1": 1, "core-flight@1": 1}
}"#;

#[test]
fn a_flight_whose_landing_is_too_small_to_stand_on_lands_on_the_roof_it_meets() {
    let im = import_eden::load(ROOF).expect("loads");
    let (root, ground, flight) = (im.nodes["world"], im.nodes["ground"], im.nodes["e_flight"]);
    let roof = im.nodes["e_roof/floor-1"];
    let map = sim::routes::Map::build(&im.tree, ground, &|_| 0).expect("the map");
    let header = import_eden::header(root, &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let town = Town::new(im.tree, ground, Doors::new(header, im.rules, next)).unwrap();
    let b = town
        .buildings
        .iter()
        .find(|b| b.thing == flight)
        .expect("the flight");
    let stair = b
        .links
        .iter()
        .find(|l| l.kind == Kind::Stairs)
        .expect("its stair");
    assert_eq!(stair.blocked, None, "{stair:?}");
    let [Some(foot), Some(top)] = stair.ends else {
        panic!("both ends: {stair:?}")
    };
    assert_eq!(foot.floor, ground);
    assert_eq!(top.floor, roof, "the top lands on the roof's floor");
    // In the roof's frame: at its height, carried in from the roof's edge onto its patch (the clearance, 340 mm).
    let m = top.middle();
    assert_eq!(m.y, 3_000_000);
    assert!(
        m.x.abs() < 50_000 && (2_500_000..3_000_000).contains(&m.z),
        "{m:?}"
    );
    // The roof is walked to from the open ground, by the flight.
    let parts = map.parts(sim::routes::ALL);
    let (pieces, _, _) = map.counts();
    let part_of = |n| {
        (0..pieces as u32)
            .filter(|&q| map.patch_of(q).node == n)
            .map(|q| parts[q as usize])
            .collect::<std::collections::BTreeSet<_>>()
    };
    let roof_parts = part_of(roof);
    assert!(
        !roof_parts.is_empty() && !roof_parts.is_disjoint(&part_of(ground)),
        "the roof is in a part of the ground: {roof_parts:?}"
    );
}
