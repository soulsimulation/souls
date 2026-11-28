//! Racks T2: a part the template places lying (`lying` in the facts: build-bay.ts's uprights on the rack pile) is
//! turned as a part set down off a carry lies, its length flat, so `raise` reads it as lying; one without stands.
use import_eden::load;
use replica::pose::Vec3;

const FACTS: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [
    {"ref": "t-upright@1", "hash": "bb", "name": "mars:rack_upright_12ft", "form": "point"}
  ],
  "things": [
    {"id": "e_lying", "def": "t-upright@1", "ref": "t-upright@1", "parent": null, "pose": [0, 38, 0, 180000],
     "world": [0, 38, 0, 180000], "scale_ppm": 1000000, "lying": true},
    {"id": "e_standing", "def": "t-upright@1", "ref": "t-upright@1", "parent": null, "pose": [3000, 0, 0, 0],
     "world": [3000, 0, 0, 0], "scale_ppm": 1000000}
  ],
  "doors": [],
  "places": [],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 2},
  "byRef": {"t-upright@1": 2}
}"#;

#[test]
fn a_part_placed_lying_lies_its_length_flat_along_its_yaw_and_one_without_stands() {
    let im = load(FACTS).expect("loads");
    let root = im.tree.root();
    let length = |key: &str| {
        let h = im.tree.handle(im.nodes[key]).expect("the part");
        let x = sim::ground::scene::xform_to(&im.tree, h, root).expect("its pose");
        (
            x.pos,
            x.rot.rotate(Vec3::new(0, 1_000_000, 0)).expect("turned"),
        )
    };
    let (at, up) = length("e_lying");
    println!("lying: at {at:?}, its length {up:?}");
    // raise.rs `Raise::up`: lying when its length rises no more than 5 cm in a metre.
    assert!(up.y.abs() <= 50_000, "its length flat: {up:?}");
    assert!(up.x < -990_000, "its top toward its yaw's x, west: {up:?}");
    assert_eq!(at.y, 38_000, "its foot half its 76 mm thickness up");
    let (_, up) = length("e_standing");
    assert!(up.y > 990_000, "the other stands: {up:?}");
}
