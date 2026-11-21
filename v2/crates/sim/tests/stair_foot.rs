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
