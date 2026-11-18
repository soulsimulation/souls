//! Kinds by hash, and loading a kind's state, points and forms (Engine v2 K3, #2667). Each `aN_` test is one
//! acceptance box; A2's search is the `no-kind-names` step of `v2/tools/ci.sh`. Kinds are read from files at run time,
//! never compiled in. Each test prints what it saw.

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, FIXTURE_HEADER, Header, Part, Rest,
    fixture_bytes,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Scope};
use replica::kinds::{Kinds, Role, Type, UNKNOWN_KIND};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::{Rules, Tree};
use replica::world_model::Audience;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/kinds")
}

/// Every kind file in `fixtures/kinds/`, read now, as (file name, text).
fn fixture_files() -> Vec<(String, String)> {
    let mut files: Vec<_> = std::fs::read_dir(dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "diag"))
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            (p.file_name().unwrap().to_string_lossy().into_owned(), text)
        })
        .collect();
    files.sort();
    files
}

fn load(kinds: &mut Kinds, files: &[(String, String)]) -> Vec<Name> {
    let sources: Vec<(&str, &str)> = files
        .iter()
        .map(|(n, t)| (n.as_str(), t.as_str()))
        .collect();
    kinds.load(&sources)
}

fn full(names: &[Name], plain: &str) -> Name {
    names
        .iter()
        .find(|n| n.as_str().starts_with(&format!("{plain}@")))
        .unwrap_or_else(|| panic!("{plain} loaded"))
        .clone()
}

fn ee(n: u64) -> Id {
    Id::new(Scope([0xee; 16]), n).unwrap()
}

/// T6's fixture header, naming `kinds` in place of its own.
fn header(kinds: &[Name]) -> Header {
    let mut v = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap())
        .unwrap()
        .to_value();
    let Value::Map(m) = &mut v else {
        unreachable!()
    };
    m.insert(
        6,
        Value::Array(kinds.iter().cloned().map(Value::Text).collect()),
    );
    Header::read(&encode(&v).unwrap()).unwrap()
}

fn pose(parent: Id, slot: Option<u64>) -> Pose {
    Pose {
        frame: Frame { node: parent, slot },
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        support: match slot {
            Some(_) => Support::Slot,
            None => Support::Surface {
                surface: parent,
                height: 0,
            },
        },
    }
}

/// One part of one effect of `changes`, through its bytes, at the tree's next sequence.
fn part(h: &Header, t: &Tree, node: Id, changes: Vec<Change>) -> Part {
    let effect = Effect {
        envelope: Envelope {
            sequence: t.to_state().next,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node,
        },
        body: Body::Changes(
            changes
                .into_iter()
                .map(|change| ChangeRec {
                    change,
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: None,
        rest: Rest::new(),
    };
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (2, Value::Array(vec![effect.to_value()])),
    ]));
    Part::read(&encode(&v).unwrap()).unwrap()
}

fn create(kinds: &Kinds, node: Id, kind: &Name, parent: Id, slot: Option<u64>) -> Change {
    Change::Create {
        node,
        kind: kind.clone(),
        pose: pose(parent, slot),
        audience: Audience::Everyone,
        fields: kinds.get(kind.as_str()).unwrap().defaults(),
    }
}

fn rules(kinds: &Kinds) -> Rules {
    Rules {
        kinds: kinds.admits(),
        ..Rules::default()
    }
}

/// The fixture kinds loaded, and a tree rooted in a room holding a lamp (2), a seat (3) and a cup (4).
fn room() -> (Kinds, Vec<Name>, Tree) {
    let mut kinds = Kinds::default();
    let names = load(&mut kinds, &fixture_files());
    assert!(kinds.refused().is_empty(), "{:?}", kinds.refused());
    let h = header(&names);
    let root = h.zone;
    let mut t = Tree::start(root, full(&names, "souls:room"));
    let things = ["souls:lamp", "souls:seat", "souls:cup"]
        .iter()
        .zip(2..)
        .map(|(k, n)| create(&kinds, ee(n), &full(&names, k), root, None))
        .collect();
    t.commit(&h, &part(&h, &t, root, things), &rules(&kinds))
        .unwrap();
    (kinds, names, t)
}

#[test]
fn a1_a_lamp_a_seat_and_a_cup_load_from_files_into_the_tree() {
    let (kinds, names, mut t) = room();
    let (lamp, seat, cup) = (
        kinds.get(full(&names, "souls:lamp").as_str()).unwrap(),
        kinds.get(full(&names, "souls:seat").as_str()).unwrap(),
        kinds.get(full(&names, "souls:cup").as_str()).unwrap(),
    );
    for k in [lamp, seat, cup] {
        let forms: Vec<&str> = k.forms.values().map(|f| f.name.as_str()).collect();
        assert!(!forms.is_empty());
        println!("A1: {} lists forms {forms:?}", k.name.as_str());
    }
    let lit = &lamp.state[&1];
    assert_eq!(
        (lit.name.as_str(), &lit.ty, &lit.default),
        ("lit", &Type::Bool, &Value::Uint(0))
    );
    assert!(seat.admits.slots[&1].contains("body"));
    let grip = cup.points.values().find(|p| p.role == Some(Role::Grip));
    assert_eq!(
        grip.map(|p| (p.name.as_str(), p.at_mm)),
        Some(("handle", [45, 50, 0]))
    );
    println!(
        "A1: the seat's slot 1 admits {:?}; the cup's grip point is {:?}",
        seat.admits.slots[&1], grip
    );

    // The three are nodes of the tree, with their kinds' defaults, and the lamp's field is set through a commit.
    let h = header(&names);
    let set = Change::Set {
        node: ee(2),
        field: 1,
        to: Value::Uint(1),
        by: None,
    };
    t.commit(&h, &part(&h, &t, ee(2), vec![set]), &rules(&kinds))
        .unwrap();
    for n in 2..5 {
        let node = t.node(t.handle(ee(n)).unwrap()).unwrap();
        println!(
            "A1: node ee:{n} in the tree: {} fields {:?}",
            kinds.label(node.kind().as_str()),
            node.fields()
        );
    }
    let lamp_node = t.node(t.handle(ee(2)).unwrap()).unwrap();
    assert_eq!(lamp_node.kind(), &lamp.name);
    assert_eq!(lamp_node.fields()[&1], Value::Uint(1));
    let cup_node = t.node(t.handle(ee(4)).unwrap()).unwrap();
    assert_eq!(cup_node.fields(), &cup.defaults());
}

#[test]
fn a3_a_fourth_kind_written_at_run_time_loads_without_a_rebuild() {
    let (mut kinds, mut names, mut t) = room();
    // Written now, so no build has seen it: a body that sits in the seat's slot.
    let at = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("kinds-a3");
    std::fs::create_dir_all(&at).unwrap();
    let file = at.join("sitter.diag");
    std::fs::write(
        &file,
        "# written by the test\n{1: \"souls:sitter\", 2: \"family\", \
         3: {1: {1: \"rest_us\", 2: \"duration\", 3: 0, 4: \"public\"}}}\n",
    )
    .unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    let loaded = kinds.load(&[("sitter.diag", &text)]);
    assert!(kinds.refused().is_empty(), "{:?}", kinds.refused());
    // The fixture kinds (cup, lamp, room, seat and G6's uploaded model) and the sitter.
    assert_eq!(kinds.len(), 6);
    names.extend(loaded.iter().cloned());
    let h = header(&names);
    let sitter = full(&names, "souls:sitter");
    let sit = create(&kinds, ee(5), &sitter, ee(3), Some(1));
    t.commit(&h, &part(&h, &t, ee(3), vec![sit]), &rules(&kinds))
        .unwrap();
    let node = t.node(t.handle(ee(5)).unwrap()).unwrap();
    assert_eq!((node.parent(), node.slot()), (Some(ee(3)), Some(1)));
    println!(
        "A3: {} loaded from a file written at run time; a node of it sits in the seat's slot {:?}",
        loaded[0].as_str(),
        node.slot()
    );
}

#[test]
fn a4_meaning_moves_the_hash_and_key_order_does_not() {
    let lamp = std::fs::read_to_string(dir().join("lamp.diag")).unwrap();
    // The same lamp, its sections and each entry's keys written in another order, without comments.
    let reordered = r#"{8: {1: {2: [["reach", 1], ["press", 1]], 1: "switch"}},
        5: {1: {3: "contact", 2: [0, 300, 40], 1: "switch"}},
        3: {1: {4: "public", 3: 0, 2: "bool", 1: "lit"}}, 2: "thing", 1: "souls:lamp"}"#;
    let brighter = lamp.replace(r#""bool", 3: 0"#, r#""bool", 3: 1"#);
    assert_ne!(brighter, lamp);
    let mut kinds = Kinds::default();
    let hash = |kinds: &mut Kinds, label, text| kinds.load(&[(label, text)])[0].clone();
    let a = hash(&mut kinds, "lamp.diag", lamp.as_str());
    let b = hash(&mut kinds, "reordered", reordered);
    let c = hash(&mut kinds, "brighter", brighter.as_str());
    println!(
        "A4: as written {}\nA4: reordered  {}\nA4: lit by default {}",
        a.as_str(),
        b.as_str(),
        c.as_str()
    );
    assert_eq!(a, b, "key order and comments do not reach the hash");
    assert_ne!(a, c, "a changed default changes the hash");
    assert_eq!(
        kinds.len(),
        2,
        "the two revisions of the lamp sit side by side"
    );
    assert!(kinds.get(a.as_str()).is_some() && kinds.get(c.as_str()).is_some());
}

#[test]
fn a5_a_thing_whose_kind_is_missing_or_bad_still_loads_as_unknown_kind() {
    // The lamp's full name, from a good copy of its file.
    let good = std::fs::read_to_string(dir().join("lamp.diag")).unwrap();
    let lamp = Kinds::default().load(&[("lamp.diag", &good)])[0].clone();
    // The world's kinds: the lamp's file now bad (a bool defaulting to text), one file not a kind, the rest good.
    let bad = good.replace(r#""bool", 3: 0"#, r#""bool", 3: "on""#);
    let mut files: Vec<(String, String)> = fixture_files()
        .into_iter()
        .filter(|(n, _)| n != "lamp.diag")
        .collect();
    files.push(("lamp.diag".into(), bad));
    files.push(("broken.diag".into(), "{1: \"souls:vase\", 2: 0.5}".into()));
    let mut kinds = Kinds::default();
    let names = load(&mut kinds, &files);
    for e in kinds.refused() {
        println!("A5: refused: {e}");
    }
    // Cup, room, seat and G6's uploaded model; the lamp's file is bad.
    assert_eq!(names.len(), 4, "the world starts with the good kinds");
    let e = kinds
        .refused()
        .iter()
        .find(|e| e.kind == "souls:lamp")
        .unwrap();
    assert_eq!(
        (e.name, e.section, e.field),
        ("kind-state", Some(3), Some(1))
    );
    assert!(e.reason.contains("bool"), "{e}");
    assert!(
        kinds
            .refused()
            .iter()
            .any(|e| e.kind == "broken.diag" && e.name == "kind-source")
    );

    // A lamp and a thing of a kind never supplied load as a viewer applies the log: no kinds needed.
    let missing = Name::new(&format!("souls:vase@1220{}", "ab".repeat(32))).unwrap();
    let mut all = names.clone();
    all.extend([lamp.clone(), missing.clone()]);
    let h = header(&all);
    let mut t = Tree::start(h.zone, full(&names, "souls:room"));
    let thing = |n, kind: &Name| Change::Create {
        node: ee(n),
        kind: kind.clone(),
        pose: pose(h.zone, None),
        audience: Audience::Everyone,
        fields: BTreeMap::from([(1, Value::Uint(1))]),
    };
    let p = part(&h, &t, h.zone, vec![thing(2, &lamp), thing(3, &missing)]);
    t.apply(&h, &p).unwrap();
    for n in [2, 3] {
        let node = t.node(t.handle(ee(n)).unwrap()).unwrap();
        assert_eq!(kinds.label(node.kind().as_str()), UNKNOWN_KIND);
        assert_eq!(
            node.fields()[&1],
            Value::Uint(1),
            "its generic state is kept"
        );
        println!(
            "A5: ee:{n} ({}) loads as {}, parent {:?}, fields {:?}",
            node.kind().as_str(),
            kinds.label(node.kind().as_str()),
            node.parent().map(replica::world_model::show),
            node.fields()
        );
    }
}
