//! A doorway whose floor stops short of its wall (W8, #4084: the Mars campus's Mimos, whose modelled floor ends before
//! its wall's inner face). The doorway's end on the floor's side lies on the floor's own edge, so a walker on the
//! floor can aim at it; a floor that reaches its wall keeps its end on the grown wall's face.

mod common;

use std::collections::BTreeMap;

use common::{id, stand, town_of};
use replica::ids::{Id, Scope};
use replica::kinds::sizes::Build;
use replica::pose::Vec3;
use sim::ground::{HUMAN_RADIUS, Scene, Turn, cut_floor};
use sim::host::Runner;
use sim::life::{Birth, Life, Ring, Then};
use sim::links::Kind;

/// A hall 6 m wide whose south wall, at z = 3 m to 3.1 m, has a 1 m doorway to the open ground in its middle. Its
/// floor ends at z = `edge` mm: 3000 is the wall's inner face.
fn hall(edge: i64) -> String {
    r#"{
  "format": "souls/import-eden/1",
  "kinds": [{"ref": "core-hall@1", "hash": "aa", "name": "core:hall", "form": "point"}],
  "things": [
    {"id": "e_hall", "def": "core-hall@1", "ref": "core-hall@1", "parent": null, "pose": [0, 0, 0, 0],
     "world": [0, 0, 0, 0], "scale_ppm": 1000000, "name": "test-hall",
     "floors": [{"level": 0, "y": 0, "polygon": [[-3000, -3000], [3000, -3000], [3000, EDGE], [-3000, EDGE]]}],
     "rooms": [{"id": "hall", "name": "Hall", "floor": 0, "pose": [0, 0, 0, 0], "height": 2400,
                "polygon": [[-3000, -3000], [3000, -3000], [3000, 3000], [-3000, 3000]]}],
     "openings": [{"id": "door", "kind": "door", "at": [0, 3050], "yaw": 0, "width": 1000, "height": 2100, "sill": 0,
                   "level": 0, "from": "hall", "fromWall": true, "state": "always", "inRoom": [0, 0, 3050, 0]}],
     "solids": [[-1750, 3050, 1250, 50, 0, 0, 2400, 5, 0], [1750, 3050, 1250, 50, 0, 0, 2400, 5, 0]]}
  ],
  "doors": [],
  "places": [],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 1, "doors": 0, "rooms": 1, "floors": 1, "floor surfaces": 1, "solids": 2, "slots": 0, "windows": 0, "doorways": 1},
  "byRef": {"core-hall@1": 1}
}"#
    .replace("EDGE", &edge.to_string())
}

/// The hall's floor cut for today's body: where its pieces end toward the doorway (the greatest z of any piece, mm),
/// and the z of each end of the doorway's segments on it.
fn cut(edge: i64) -> (i64, Vec<i64>) {
    let im = import_eden::load(&hall(edge)).expect("loads");
    let scene = Scene::of(&im.tree, im.nodes["e_hall/floor-0"]).unwrap();
    let p = cut_floor(&scene, HUMAN_RADIUS, Turn::NONE).unwrap();
    let reach = p
        .pieces
        .iter()
        .flat_map(|q| q.vertices.iter().map(|v| i64::from(v[2])))
        .max()
        .expect("a floor");
    let ends = p
        .meets
        .iter()
        .filter(|m| !m.step)
        .flat_map(|m| [i64::from(m.a[2]), i64::from(m.b[2])])
        .collect();
    (reach, ends)
}

#[test]
fn a_doorways_end_lies_on_a_floor_that_stops_short_of_its_wall() {
    let (flush_reach, flush) = cut(3000);
    let (short_reach, short) = cut(2900);
    println!(
        "flush: floor to {flush_reach} mm, ends {flush:?}; short: floor to {short_reach} mm, ends {short:?}"
    );
    // The grown wall's face at the doorway: the doorway's middle (3050), less its half depth (100), less what the
    // wall is grown by (as the floor's edge is: 3000 less where the flush floor ends).
    let face = 3050 - 100 - (3000 - flush_reach);
    // The flush floor reaches past the face: its doorway's end is on the face, as before.
    assert!(flush_reach >= face);
    assert!(!flush.is_empty() && flush.iter().all(|&z| z == face));
    // The short floor ends 50 mm before the face (as Mimos's does): its doorway's end is on the floor's edge.
    assert_eq!(short_reach, face - 50);
    assert!(!short.is_empty() && short.iter().all(|&z| z == short_reach));
}

#[test]
fn a_walker_on_the_short_floor_aims_at_its_doorway_and_is_routed_out() {
    let (mut t, nodes) = town_of(
        import_eden::load(&hall(2900)).expect("loads"),
        b"short-floor",
    );
    let (hall, floor) = (nodes["e_hall"], nodes["e_hall/floor-0"]);
    let door = t
        .buildings
        .iter()
        .find(|b| b.thing == hall)
        .and_then(|b| b.links.iter().find(|l| l.kind == Kind::Doorway))
        .cloned()
        .expect("the doorway");
    assert_eq!(door.blocked, None, "{door:?}");
    let end = door
        .ends
        .iter()
        .flatten()
        .find(|e| e.floor == floor)
        .expect("its end on the floor")
        .middle();
    let body = stand(&t, id(1), floor, Vec3::new(0, 0, 0));
    // The walk to the doorway's near end has a corner to aim at (before: `off-ground`, and the walk ended
    // `souls:no-way`).
    let corner = t.view().corner(&body, end);
    assert!(
        corner.is_ok(),
        "{:?}",
        corner.err().map(|e| (e.name, e.detail))
    );
}

/// Review of #4574: 200 births by an entry at the middle of the test world's three-storey building, as worldd asks
/// them (the open ground's ring first, then the floor that holds the entry), are all born, on the open ground round it,
/// and none above the ground.
#[test]
fn births_at_a_storeyed_building_stay_on_the_ground_round_it() {
    let (t, nodes) = common::town(b"entry-storeys");
    let mid = t
        .buildings
        .iter()
        .find(|b| b.thing == nodes["building"])
        .expect("the building")
        .place
        .pos;
    let entry = id(900);
    let ring = |node, at| Ring {
        entries: BTreeMap::from([(entry, (node, at))]),
        radius: 1_000_000,
        gap: 1_000_000,
        rings: 8,
    };
    let on_ground = ring(t.ground, Vec3::new(mid.x, 0, mid.z));
    let floor = t
        .entry_floor(Vec3::new(mid.x, 0, mid.z))
        .map(|(n, p)| ring(n, p));
    let standing = Then(&on_ground, floor.as_ref());
    let mut runner = Runner::new(50_000);
    let mut life = Life::new(Scope([9; 16]), 8);
    for n in 1..=200 {
        life.ask(Birth {
            soul: id(n),
            entry,
            asked: 0,
        })
        .expect("asked");
    }
    let upper: Vec<Id> = t
        .buildings
        .iter()
        .flat_map(|b| b.floors.iter())
        .filter(|(_, (level, _))| *level > 0)
        .map(|(n, _)| *n)
        .collect();
    let (mut born, mut nodes_born) = (0, BTreeMap::<Id, usize>::new());
    for k in 1..=60 {
        for b in life.tick_built(
            k * 50_000,
            &mut runner,
            &t,
            &standing,
            &common::humanoid(),
            &|_| Build::STANDARD,
        ) {
            born += 1;
            let node = runner
                .controller
                .body(b.body)
                .expect("body")
                .pose
                .frame
                .node;
            *nodes_born.entry(node).or_default() += 1;
        }
        if life.waiting() == 0 {
            break;
        }
    }
    println!("born {born}: {nodes_born:?}");
    assert_eq!(born, 200, "every birth taken");
    assert_eq!(nodes_born.get(&t.ground), Some(&200), "on the open ground");
    assert!(
        upper.iter().all(|n| !nodes_born.contains_key(n)),
        "none upstairs"
    );
}

/// verdelis-eden (24 Nov): the floor an entry under a roof falls back to is the ground-level floor that holds it, in
/// that floor's frame, with a way out; a point outside, or on a sealed floor (raised off the ground with no doorway),
/// has none.
#[test]
fn an_entry_under_a_roof_falls_back_to_its_open_floor_never_a_sealed_one() {
    let (t, nodes) = town_of(import_eden::load(&hall(3000)).expect("loads"), b"entry-at");
    let floor = nodes["e_hall/floor-0"];
    let (node, at) = t
        .entry_floor(Vec3::new(500_000, 0, -500_000))
        .expect("the hall's floor");
    assert_eq!(node, floor, "in the hall");
    assert_eq!(
        (at.x, at.z),
        (500_000, -500_000),
        "the hall stands at the origin"
    );
    assert_eq!(t.entry_floor(Vec3::new(0, 0, 6_000_000)), None, "outside");
    let sealed = hall(3000)
        .replace(r#""y": 0,"#, r#""y": 3000,"#)
        .replace(r#""openings": [{"#, r#""unused": [{"#);
    let (t, nodes) = town_of(import_eden::load(&sealed).expect("loads"), b"entry-sealed");
    assert!(t.surfaces.contains_key(&nodes["e_hall/floor-0"]), "cut");
    assert_eq!(
        t.entry_floor(Vec3::new(500_000, 0, -500_000)),
        None,
        "no way out"
    );
}
