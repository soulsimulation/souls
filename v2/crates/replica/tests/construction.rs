//! Parts that join (Engine v2 B17, #3338): a rack frame, a beam, a bay and a yard stand as kinds. Each `aN_` test is
//! one acceptance box. The kinds are read from `content/kinds/construction/` at run time, never compiled in, turned
//! into K3's numbered form by `entry_to_kind` and loaded through `Kinds::load`. Each test prints what it saw.

use replica::kinds::entry::entry_to_kind;
use replica::kinds::{KindDef, Kinds, LinkEnd, Role};
use std::path::PathBuf;

fn folder() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/construction")
}

/// An entry without its `roles`: they make the crew's activity kind (`worldd::serve::activity_kinds`), not the kind's
/// meaning, so K3's reader is given the rest (0.135 A2).
fn without_roles(json: &str) -> String {
    let mut e = replica::rules::json::parse(json).expect("an entry");
    if let replica::rules::json::Value::Obj(o) = &mut e {
        o.retain(|(k, _)| k != "roles");
    }
    e.to_json()
}

/// The rack's four kinds and the carry its crews are (0.135 C4), and the 6.1 m upright four carry (C6), by name: other
/// construction kinds in the folder (the camp's loads and loading spot) are not the rack's.
const RACK: [&str; 6] = [
    "carry.json",
    "frame_stand.json",
    "rack_bay.json",
    "rack_beam.json",
    "rack_upright.json",
    "rack_upright_6m.json",
];

/// The rack's construction entries, loaded with their `roles` set aside; panics on any refusal.
fn loaded() -> Kinds {
    let mut files: Vec<(String, String)> = RACK
        .iter()
        .map(|n| folder().join(n))
        .map(|p| {
            let text = entry_to_kind(&without_roles(&std::fs::read_to_string(&p).unwrap()))
                .unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            (p.file_name().unwrap().to_string_lossy().into_owned(), text)
        })
        .collect();
    files.sort();
    let mut kinds = Kinds::default();
    let sources: Vec<(&str, &str)> = files
        .iter()
        .map(|(n, t)| (n.as_str(), t.as_str()))
        .collect();
    let names = kinds.load(&sources);
    assert!(kinds.refused().is_empty(), "refused: {:?}", kinds.refused());
    assert_eq!(names.len(), RACK.len());
    kinds
}

fn kind<'a>(kinds: &'a Kinds, plain: &str) -> &'a KindDef {
    let full = kinds
        .admits()
        .into_keys()
        .find(|n| n.starts_with(&format!("{plain}@")))
        .unwrap_or_else(|| panic!("{plain} loaded"));
    kinds.get(&full).unwrap()
}

fn connectors(k: &KindDef) -> Vec<(String, String, [i64; 3])> {
    k.points
        .values()
        .filter(|p| p.role == Some(Role::Joint))
        .map(|p| {
            let c = p.connector.as_ref().unwrap();
            (
                p.name.as_str().to_owned(),
                c.kind.as_str().to_owned(),
                p.at_mm,
            )
        })
        .collect()
}

fn end<'a>(k: &'a KindDef, connector: Option<&'a str>) -> LinkEnd<'a> {
    LinkEnd {
        kind: k.name.as_str(),
        connector,
    }
}

#[test]
fn a1_the_four_kinds_load_with_their_connectors_and_slots() {
    let kinds = loaded();

    // The upright: today's 8 ft frame, columns 1144 mm apart, a beam seat on each column of each face at each of
    // today's 14 hole heights (12 in, then every 6 in below 93 in), hold crew 1.
    let up = kind(&kinds, "mars:rack_upright");
    let seats = connectors(up);
    println!(
        "{}: {} connectors, e.g. {:?}",
        up.name.as_str(),
        seats.len(),
        &seats[..4]
    );
    assert_eq!(seats.len(), 14 * 4);
    assert!(seats.iter().all(|(_, k, _)| k == "beam_seat"));
    let heights: std::collections::BTreeSet<i64> = seats.iter().map(|s| s.2[1]).collect();
    assert_eq!(heights.first(), Some(&305));
    assert_eq!(heights.last(), Some(&2286));
    assert_eq!(heights.len(), 14);
    assert!(seats.iter().all(|s| s.2[0].abs() == 572));
    let crew = up
        .state
        .values()
        .find(|f| f.name.as_str() == "hold_crew")
        .unwrap();
    assert_eq!(crew.default, replica::encode::Value::Uint(1));

    // The beam: 9 ft, a beam end at each end, mating with a beam seat; it declares the joint link to an upright.
    let beam = kind(&kinds, "mars:rack_beam");
    let ends = connectors(beam);
    println!("{}: {ends:?}, links {:?}", beam.name.as_str(), beam.links);
    assert_eq!(
        ends,
        vec![
            ("end_l".into(), "beam_end".into(), [0, 51, -1372]),
            ("end_r".into(), "beam_end".into(), [0, 51, 1372]),
        ]
    );
    assert!(
        beam.point("end_l")
            .unwrap()
            .connector
            .as_ref()
            .unwrap()
            .mates
            .as_str()
            == "beam_seat"
    );
    let joint = beam.links.values().next().unwrap();
    assert_eq!(
        (joint.name.as_str(), joint.from.as_str(), joint.most),
        ("joint", "mars:rack_upright", Some(2))
    );

    // The bay: rack-bay@1's slots without its deck and stairs, each admitting one kind, with its place.
    let bay = kind(&kinds, "mars:rack_bay");
    let slots: Vec<(String, Vec<String>, [i64; 3])> = bay
        .slots
        .values()
        .map(|s| {
            let name = s.name.as_ref().unwrap().as_str().to_owned();
            (name, s.admits.iter().cloned().collect(), s.at_mm.unwrap())
        })
        .collect();
    for s in &slots {
        println!("{}: slot {s:?}", bay.name.as_str());
    }
    let names: Vec<&str> = slots.iter().map(|s| s.0.as_str()).collect();
    assert_eq!(
        names,
        [
            "upright_a",
            "upright_b",
            "beam_high_l",
            "beam_high_r",
            "beam_low_l",
            "beam_low_r"
        ]
    );
    assert!(slots[..2].iter().all(|s| s.1 == ["mars:rack_upright"]));
    assert!(slots[2..].iter().all(|s| s.1 == ["mars:rack_beam"]));
    assert_eq!(slots[0].2, [0, 0, -1448]);
    assert_eq!(slots[2].2, [-572, 863, 0]);
    assert_eq!(slots[4].2, [-572, 254, 0]);

    // The yard stand: two slots that hold frames standing.
    let stand = kind(&kinds, "mars:frame_stand");
    println!("{}: slots {:?}", stand.name.as_str(), stand.slots);
    assert_eq!(stand.slots.len(), 2);
    assert!(
        stand
            .slots
            .values()
            .all(|s| s.admits.iter().eq(["mars:rack_upright"].iter()))
    );
}

#[test]
fn a2_a_joint_is_accepted_beam_end_to_upright_seat_and_refused_by_name_otherwise() {
    let kinds = loaded();
    let (up, beam) = (
        kind(&kinds, "mars:rack_upright"),
        kind(&kinds, "mars:rack_beam"),
    );
    let (bay, stand) = (
        kind(&kinds, "mars:rack_bay"),
        kind(&kinds, "mars:frame_stand"),
    );
    let check = |a, b| kinds.check_link("joint", a, b).map_err(|e| e.name);

    // Accepted, from either end.
    assert_eq!(
        check(end(beam, Some("end_l")), end(up, Some("seat_front_l_0"))),
        Ok(())
    );
    assert_eq!(
        check(end(up, Some("seat_back_r_13")), end(beam, Some("end_r"))),
        Ok(())
    );

    // Every other pair, refused by name.
    let refused = [
        (
            "beam to beam",
            check(end(beam, Some("end_l")), end(beam, Some("end_r"))),
            "link-type-undeclared",
        ),
        (
            "upright to upright",
            check(
                end(up, Some("seat_front_l_0")),
                end(up, Some("seat_front_r_0")),
            ),
            "link-type-undeclared",
        ),
        (
            "beam to bay",
            check(end(beam, Some("end_l")), end(bay, None)),
            "link-type-undeclared",
        ),
        (
            "beam to stand",
            check(end(beam, Some("end_l")), end(stand, None)),
            "link-type-undeclared",
        ),
        (
            "upright to bay",
            check(end(up, Some("seat_front_l_0")), end(bay, None)),
            "link-type-undeclared",
        ),
        (
            "beam end to a grip",
            check(end(beam, Some("end_l")), end(up, Some("grip_low"))),
            "connector-unknown",
        ),
        (
            "a grip to a seat",
            check(end(beam, Some("grip_mid")), end(up, Some("seat_front_l_0"))),
            "connector-unknown",
        ),
        (
            "no connector named",
            check(end(beam, None), end(up, Some("seat_front_l_0"))),
            "connector-missing",
        ),
    ];
    for (what, got, name) in &refused {
        println!("{what}: {got:?}");
        assert_eq!(*got, Err(*name), "{what}");
    }
    let other = kinds.check_link(
        "holds",
        end(beam, Some("end_l")),
        end(up, Some("seat_front_l_0")),
    );
    println!(
        "another link type: {:?}",
        other.as_ref().map_err(|e| e.name)
    );
    assert_eq!(other.map_err(|e| e.name), Err("link-type-undeclared"));
}

#[test]
fn b19_a_frame_bounds_its_crews_and_the_bound_is_in_its_hash() {
    let kinds = loaded();
    let upright = kind(&kinds, "mars:rack_upright");
    println!(
        "rack_upright children: {:?}, most {:?}",
        upright.admits.children, upright.most
    );
    assert!(upright.admits.children.contains("mars:carry_activity"));
    assert_eq!(upright.most.get("mars:carry_activity"), Some(&2));

    // The bound is part of the meaning: another bound names another kind; none at all is refused by name.
    let json = std::fs::read_to_string(folder().join("rack_upright.json")).unwrap();
    let two = entry_to_kind(&without_roles(&json)).unwrap();
    let three = entry_to_kind(&without_roles(&json.replace("\"most\": 2", "\"most\": 3"))).unwrap();
    assert_ne!(two, three, "the bound is written into the kind's meaning");
    let load = |text: &str| {
        let mut k = Kinds::default();
        k.load(&[("rack_upright.json", text)]);
        k.admits().into_keys().next()
    };
    assert_ne!(load(&two), load(&three), "so the kind's hash moves with it");
    let none =
        entry_to_kind(&without_roles(&json.replace(",\n   \"most\": 2", ""))).expect_err("refused");
    println!("a child with no most: {none}");
    assert!(none.starts_with("entry-value"), "{none}");
}
