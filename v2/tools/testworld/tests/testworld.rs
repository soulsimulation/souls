//! N2 (#2650): the test world's checks, one per acceptance criterion. Each loads the generated facts through N1's
//! loader (K2's tree, through commit) and reads what it checks back from the tree, not from the generator.

use import_eden::{
    F_DOORWAY, F_DOORWAYS, F_LINE, F_LINE_WIDTH, F_OPEN, F_OUTLINE, F_PLACE_KIND, F_SLOTS,
    F_SOLIDS, F_STAIRS, Import, count, load, world_of,
};
use replica::encode::Value;
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::world_model::plain;
use testworld::*;

fn node<'a>(im: &'a Import, key: &str) -> replica::tree::NodeRef<'a> {
    im.tree
        .node(im.tree.handle(im.nodes[key]).expect(key))
        .expect(key)
}
fn rows(v: Option<&Value>) -> Vec<Vec<i64>> {
    let n = |x: &Value| match x {
        Value::Uint(u) => *u as i64,
        Value::Nint(m) => -1 - *m as i64,
        _ => i64::MIN,
    };
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .map(|r| match r {
                Value::Array(c) => c.iter().map(n).collect(),
                x => vec![n(x)],
            })
            .collect(),
        Some(x) => vec![vec![n(x)]],
        None => Vec::new(),
    }
}
fn bbox(r: &[Vec<i64>]) -> (i64, i64, i64, i64) {
    let xs = r.iter().map(|p| p[0]);
    let zs = r.iter().map(|p| p[1]);
    (
        xs.clone().min().unwrap(),
        zs.clone().min().unwrap(),
        xs.max().unwrap(),
        zs.max().unwrap(),
    )
}
fn kind(im: &Import, id: Id) -> String {
    plain(
        im.tree
            .node(im.tree.handle(id).unwrap())
            .unwrap()
            .kind()
            .as_str(),
    )
    .to_owned()
}

#[test]
fn a1_every_part_and_size_is_in_the_tree_and_the_manifest_names_each_constant() {
    let w = generate(1, 0).unwrap();
    let im = load(&w.text).expect("loads through commit");
    for r in count(&im).0 {
        assert_eq!(r.tree, r.bake, "{}", r.what);
    }
    assert!(im.notes.is_empty(), "{:?}", im.notes);

    // The square: 60 m by 60 m, an area and a place, nothing round it.
    let sq = bbox(&rows(node(&im, "square.area").fields().get(&F_OUTLINE)));
    assert_eq!((sq.2 - sq.0, sq.3 - sq.1), (SQUARE_SIDE, SQUARE_SIDE));
    // The hall: one room 30 m by 40 m, 300 seats as slots, five aisles.
    let hall = bbox(&rows(
        node(&im, "hall/hall").fields().get(&import_eden::F_OUTLINE),
    ));
    assert_eq!((hall.2 - hall.0, hall.3 - hall.1), (HALL_WIDTH, HALL_DEPTH));
    assert_eq!(rows(node(&im, "hall").fields().get(&F_SLOTS)).len(), 300);
    assert_eq!(
        im.nodes
            .keys()
            .filter(|k| k.starts_with("hall.aisle-"))
            .count(),
        5
    );
    // The ring: a solid middle 22 m across and a walkway 4 m wide round it.
    let mid = &rows(node(&im, "ring").fields().get(&F_SOLIDS))[0];
    assert_eq!((2 * mid[2], 2 * mid[3]), (RING_MIDDLE, RING_MIDDLE));
    let walk = node(&im, "ring.walkway");
    assert_eq!(
        rows(walk.fields().get(&F_LINE_WIDTH)),
        vec![vec![RING_WALKWAY]]
    );
    let line = rows(walk.fields().get(&F_LINE));
    assert_eq!(line[0][0] - RING_X, -(RING_MIDDLE / 2 + RING_WALKWAY / 2));
    // The building: turned 33 degrees; floors 0 and 1 with four rooms each (and the corridor), the roof as floor 2.
    let b = node(&im, "building");
    assert_eq!(
        b.place().unwrap().orientation,
        Quat::from_yaw_mdeg(BUILDING_YAW_MDEG).unwrap()
    );
    for (f, n) in [(0, 4), (1, 5), (2, 0)] {
        let fl = im
            .tree
            .handle(im.nodes[&format!("building/floor-{f}")])
            .unwrap();
        assert_eq!(im.tree.children(fl).unwrap().len(), n, "floor {f}");
    }
    let corr = bbox(&rows(
        node(&im, "building/corridor").fields().get(&F_OUTLINE),
    ));
    assert_eq!(
        (corr.2 - corr.0, corr.3 - corr.1),
        (CORRIDOR_LENGTH, CORRIDOR_WIDTH)
    );
    // One straight stair 1.0 m wide whose top is 1.5 m from the 0.9 m door's face; a ladder from floor 1 to the roof.
    let stair = &rows(node(&im, "building/floor-0").fields().get(&F_STAIRS))[0];
    let narrow = rows(node(&im, "building/r1a").fields().get(&F_DOORWAYS));
    let narrow = narrow
        .iter()
        .find(|d| d[5] == DOOR_NARROW)
        .expect("the narrow doorway");
    let top_x = match node(&im, "building/floor-0").fields().get(&F_STAIRS) {
        Some(Value::Array(a)) => match &a[0] {
            Value::Array(c) => rows(Some(&c[6])),
            _ => unreachable!(),
        },
        _ => unreachable!(),
    };
    assert_eq!(stair[3], STAIR_WIDTH);
    assert_eq!(top_x[0][1], top_x[1][1], "straight");
    assert_eq!(narrow[2] - WALL / 2 - top_x[1][0], STAIR_TOP_TO_DOOR);
    let f1 = im.tree.handle(im.nodes["building/floor-1"]).unwrap();
    let ladder = im
        .tree
        .links_of(f1)
        .unwrap()
        .iter()
        .find(|e| e.other == im.nodes["building/floor-2"]);
    assert_eq!(
        im.tree
            .link(ladder.expect("a ladder").link)
            .unwrap()
            .0
            .as_str(),
        "eden:ladder"
    );

    // The manifest prints every named constant with its value.
    let m = manifest(1, 0, &w);
    for (name, v, ..) in NAMED {
        assert!(m.contains(&format!("{name} = {v} ")), "{name}");
    }
}

#[test]
fn a3_the_same_seed_gives_the_same_bytes() {
    let (a, b) = (generate(7, 10_000).unwrap(), generate(7, 10_000).unwrap());
    assert_eq!(
        replica::ids::sha256(a.text.as_bytes()),
        replica::ids::sha256(b.text.as_bytes())
    );
    assert_ne!(
        a.text,
        generate(8, 10_000).unwrap().text,
        "the seed matters"
    );
}

#[test]
fn a4_twelve_doors_shut_and_ten_thousand_things_clear_of_doorways_aisles_and_the_walkway() {
    let im = load(&generate(1, 10_000).unwrap().text).expect("loads through commit");
    let t = &im.tree;

    // Twelve doors, each shut in its doorway, of the widths the table gives.
    let mut doorways: Vec<(Id, Value, Vec<i64>)> = Vec::new(); // (owning room, link id, row)
    for id in im.nodes.values() {
        let n = t.node(t.handle(*id).unwrap()).unwrap();
        if let Some(Value::Array(a)) = n.fields().get(&F_DOORWAYS) {
            for r in a {
                let Value::Array(c) = r else {
                    panic!("a doorway row")
                };
                // [link, kind, x, z, yaw, width, height]: the link is an id, the kind a name; the rest numbers.
                let mut row = vec![0, 0];
                row.extend(rows(Some(&Value::Array(c[2..].to_vec()))).concat());
                doorways.push((*id, c[0].clone(), row));
            }
        }
    }
    let mut widths = Vec::new();
    for id in im.nodes.values() {
        let n = t.node(t.handle(*id).unwrap()).unwrap();
        if let Some(open) = n.fields().get(&F_OPEN) {
            assert_eq!(open, &Value::Uint(0), "placed shut");
            let link = n.fields().get(&F_DOORWAY).expect("in its doorway");
            let row = doorways
                .iter()
                .find(|(_, l, _)| l == link)
                .expect("its doorway's row");
            widths.push(row.2[5]);
        }
    }
    widths.sort();
    assert_eq!(
        widths,
        [
            900, 900, 1200, 1200, 1200, 1200, 1200, 1200, 1500, 1500, 2400, 2400
        ]
    );
    assert_eq!(widths.len() as i64, DOORS);

    // Each doorway in the world frame: centre, a unit along its wall and one across it (micrometres), its floor's y.
    let mut gaps = Vec::new();
    for (room, _, r) in &doorways {
        let floor = t.node(t.handle(*room).unwrap()).unwrap().parent().unwrap();
        let thing = t.node(t.handle(floor).unwrap()).unwrap().parent().unwrap();
        let q = t
            .node(t.handle(thing).unwrap())
            .unwrap()
            .place()
            .unwrap()
            .orientation;
        let at = world_of(&im, thing)
            .unwrap()
            .plus(q.rotate(Vec3::new(r[2] * 1000, 0, r[3] * 1000)).unwrap())
            .unwrap();
        let turn = q.then(Quat::from_yaw_mdeg(r[4]).unwrap()).unwrap();
        let along = turn.rotate(Vec3::new(1_000_000, 0, 0)).unwrap();
        let across = turn.rotate(Vec3::new(0, 0, 1_000_000)).unwrap();
        gaps.push((at, along, across, r[5], world_of(&im, *room).unwrap().y));
    }
    assert_eq!(gaps.len(), 13);
    let aisles: Vec<_> = im
        .nodes
        .iter()
        .filter(|(k, _)| k.starts_with("hall.aisle-"))
        .map(|(_, id)| {
            let n = t.node(t.handle(*id).unwrap()).unwrap();
            assert!(matches!(n.fields().get(&F_PLACE_KIND), Some(Value::Text(k)) if k.as_str() == "eden:aisle"));
            bbox(&rows(n.fields().get(&F_OUTLINE)))
        })
        .collect();
    let walk = node(&im, "ring.walkway");
    let line = rows(walk.fields().get(&F_LINE));
    let half_walk = (rows(walk.fields().get(&F_LINE_WIDTH))[0][0] / 2) as f64;

    let h = THING_HALF;
    let mut boxes = 0;
    for (key, id) in &im.nodes {
        if kind(&im, *id) != "testworld:box" {
            continue;
        }
        boxes += 1;
        let p = world_of(&im, *id).unwrap();
        for (at, along, across, width, y) in &gaps {
            let d = p.minus(*at).unwrap();
            let dot =
                |u: &Vec3| (d.x as i128 * u.x as i128 + d.z as i128 * u.z as i128) / 1_000_000;
            let in_gap = dot(along).abs() <= i128::from(width / 2 + h) * 1000
                && dot(across).abs() <= i128::from(500 + h) * 1000
                && (p.y - y).abs() < 1_000_000;
            assert!(!in_gap, "{key} stands in a doorway");
        }
        let (x, z) = (p.x / 1000, p.z / 1000);
        for a in &aisles {
            assert!(
                !(x >= a.0 - h && x <= a.2 + h && z >= a.1 - h && z <= a.3 + h),
                "{key} stands in an aisle"
            );
        }
        for s in line.windows(2) {
            let (ax, az, bx, bz) = (
                s[0][0] as f64,
                s[0][1] as f64,
                s[1][0] as f64,
                s[1][1] as f64,
            );
            let (dx, dz) = (bx - ax, bz - az);
            let u = (((x as f64 - ax) * dx + (z as f64 - az) * dz) / (dx * dx + dz * dz))
                .clamp(0.0, 1.0);
            let dist = ((x as f64 - ax - u * dx).powi(2) + (z as f64 - az - u * dz).powi(2)).sqrt();
            assert!(
                dist > half_walk + h as f64,
                "{key} stands on the ring's walkway"
            );
        }
    }
    assert_eq!(boxes, 10_000);
}

#[test]
fn b17_a3_the_yard_holds_two_frames_on_the_stand_and_four_beams_and_the_site_is_clear() {
    let w = generate(1, 0).unwrap();
    let im = load(&w.text).expect("loads through commit, T2's check");
    for r in count(&im).0 {
        assert_eq!(r.tree, r.bake, "{}", r.what);
    }
    assert!(im.notes.is_empty(), "{:?}", im.notes);

    // The stand in the yard; a frame in each of its two slots, standing (no turn), at the slot's height.
    let stand = im.nodes["yard-stand"];
    assert_eq!(kind(&im, stand), "mars:frame_stand");
    assert_eq!(
        rows(node(&im, "yard-stand").fields().get(&F_SLOTS)).len(),
        2
    );
    for (k, key) in ["yard-frame-1", "yard-frame-2"].iter().enumerate() {
        let f = node(&im, key);
        assert_eq!(kind(&im, im.nodes[*key]), "mars:rack_upright");
        assert_eq!((f.parent(), f.slot()), (Some(stand), Some(k as u64 + 1)));
        let p = world_of(&im, im.nodes[*key]).unwrap();
        println!("{key}: parent the stand, slot {}, at {p:?}", k + 1);
        assert_eq!(p.y, STAND_SLOT_Y * 1000);
    }
    // Four beams lying loose in the yard: children of the ground, in no slot.
    let yard = bbox(&rows(node(&im, "yard").fields().get(&F_OUTLINE)));
    let site = bbox(&rows(node(&im, "site").fields().get(&F_OUTLINE)));
    for k in 1..=4 {
        let key = format!("yard-beam-{k}");
        let b = node(&im, &key);
        assert_eq!(kind(&im, im.nodes[&key]), "mars:rack_beam");
        assert_eq!(b.slot(), None);
        let p = world_of(&im, im.nodes[&key]).unwrap();
        let (x, z) = (p.x / 1000, p.z / 1000);
        assert!(
            x > yard.0 && x < yard.2 && z > yard.1 && z < yard.3,
            "{key} in the yard"
        );
    }
    // The site, 25 m from the yard, holds nothing: no thing of the world stands inside it.
    let centre = |b: (i64, i64, i64, i64)| ((b.0 + b.2) / 2, (b.1 + b.3) / 2);
    let (yc, sc) = (centre(yard), centre(site));
    println!("yard centre {yc:?}, site centre {sc:?}, site {site:?}");
    assert_eq!((sc.0 - yc.0, sc.1 - yc.1), (25_000, 0));
    for (key, id) in &im.nodes {
        let Some(p) = world_of(&im, *id) else {
            continue;
        };
        let (x, z) = (p.x / 1000, p.z / 1000);
        let inside = x > site.0 && x < site.2 && z > site.1 && z < site.3;
        assert!(!inside || key == "site", "{key} stands in the build site");
    }
}
