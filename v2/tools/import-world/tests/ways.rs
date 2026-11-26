//! W9 (#4085): the import walks each floor from the arrival point and back, and names what it cannot. A hall with a
//! doorway to the open ground is walked to and from; a hall with none is named, not reached.

use import_world::ways::{Opts, ways};

/// A hall 6 m wide at `x` mm, its floor at the ground's height; with a 1 m doorway in its south wall when `door`.
fn hall(id: &str, x: i64, door: bool) -> String {
    let opening = if door {
        r#"[{"id": "door", "kind": "door", "at": [0, 3050], "yaw": 0, "width": 1000, "height": 2100, "sill": 0,
             "level": 0, "from": "hall", "fromWall": true, "state": "always", "inRoom": [0, 0, 3050, 0]}]"#
    } else {
        "[]"
    };
    let wall = if door {
        "[-1750, 3050, 1250, 50, 0, 0, 2400, 5, 0], [1750, 3050, 1250, 50, 0, 0, 2400, 5, 0]"
    } else {
        "[0, 3050, 3000, 50, 0, 0, 2400, 5, 0]"
    };
    format!(
        r#"{{"id": "{id}", "def": "core-hall@1", "ref": "core-hall@1", "parent": null, "pose": [{x}, 0, 0, 0],
     "world": [{x}, 0, 0, 0], "scale_ppm": 1000000, "name": "{id}",
     "floors": [{{"level": 0, "y": 0, "polygon": [[-3000, -3000], [3000, -3000], [3000, 3000], [-3000, 3000]]}}],
     "rooms": [{{"id": "hall", "name": "Hall", "floor": 0, "pose": [0, 0, 0, 0], "height": 2400,
                "polygon": [[-3000, -3000], [3000, -3000], [3000, 3000], [-3000, 3000]]}}],
     "openings": {opening},
     "solids": [{wall}, [0, -3050, 3000, 50, 0, 0, 2400, 5, 0], [-3050, 0, 50, 3000, 0, 0, 2400, 5, 0],
                [3050, 0, 50, 3000, 0, 0, 2400, 5, 0]]}}"#
    )
}

fn world() -> String {
    format!(
        r#"{{
  "format": "souls/import-eden/1",
  "kinds": [{{"ref": "core-hall@1", "hash": "aa", "name": "core:hall", "form": "point"}}],
  "things": [{}, {}],
  "doors": [],
  "places": [],
  "ground": {{"tileM": 2, "tiles": [{{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}}]}},
  "bake": {{"things": 2, "doors": 0, "rooms": 2, "floors": 2, "floor surfaces": 2, "solids": 9, "slots": 0, "windows": 0, "doorways": 1}},
  "byRef": {{"core-hall@1": 2}}
}}"#,
        hall("e_open", 0, true),
        hall("e_sealed", 20_000, false)
    )
}

#[test]
fn the_open_hall_is_walked_there_and_back_and_the_sealed_one_is_named() {
    let w = ways(
        &world(),
        &Opts {
            arrival: [0, 8000],
            entries: Vec::new(),
        },
    )
    .expect("walked");
    println!(
        "{} targets, {} s of walking; one-way {:?}; not reached {:?}",
        w.targets,
        w.ticks / 20,
        w.one_way,
        w.unreached
    );
    assert_eq!(w.targets, 2, "one point on each hall's floor");
    assert!(w.one_way.is_empty(), "{:?}", w.one_way);
    let names: Vec<&str> = w.unreached.iter().map(|u| u.name.as_str()).collect();
    assert_eq!(names, ["floor e_sealed/floor-0"], "{:?}", w.unreached);
    // The open hall was walked into and out of: some seconds of walking, there and back.
    assert!(w.ticks > 100, "{} ticks", w.ticks);
}
