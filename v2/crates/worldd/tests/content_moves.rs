//! Engine v2 C23 (#3494) A1: worldd's move library is read from `content/moves` (`worldd::moves`), and every move a
//! form in `content/kinds` names is in it, but for the moves no `content/moves` file declares yet (a content gap,
//! handed to C18 #3454).

use std::collections::BTreeSet;
use std::path::Path;

use replica::bodies::{Class, Want};
use replica::moves::Effector;
use replica::rules::json::{Value as J, parse};

fn root() -> String {
    format!("{}/../../..", env!("CARGO_MANIFEST_DIR"))
}

/// Every `.json` file under `dir`.
fn files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            files(&p, out);
        } else if p.extension().is_some_and(|x| x == "json") {
            out.push(p);
        }
    }
}

/// Moves forms name that no `content/moves` file declares yet: content to write (C18 #3454), not the reader's.
const NOT_IN_CONTENT: [&str; 2] = ["crank", "pick"];

#[test]
fn a1_the_library_is_every_move_in_content_and_the_bodys_own() {
    let mut on_disk: Vec<String> = std::fs::read_dir(format!("{}/content/moves", root()))
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            Some(p.file_stem()?.to_str()?.to_owned())
        })
        .collect();
    on_disk.sort();
    let listed: Vec<String> = worldd::moves::CONTENT
        .iter()
        .map(|(n, _)| (*n).to_owned())
        .collect();
    assert_eq!(
        listed, on_disk,
        "worldd::moves::CONTENT lists every file of content/moves"
    );
    let library = worldd::acts::library().expect("every move reads");
    let names: BTreeSet<&str> = library.iter().map(|m| m.name.as_str()).collect();
    for n in &on_disk {
        assert!(names.contains(format!("souls:{n}").as_str()), "{n}");
    }
    for own in ["souls:sit", "souls:lie", "souls:rise"] {
        assert!(names.contains(own), "{own}");
    }
    assert_eq!(names.len(), on_disk.len() + 3, "one move per name");
}

#[test]
fn a1_every_move_a_form_in_content_names_is_known() {
    let library = worldd::acts::library().expect("every move reads");
    let known: BTreeSet<&str> = library.iter().map(|m| m.name.as_str()).collect();
    let mut paths = Vec::new();
    files(Path::new(&format!("{}/content/kinds", root())), &mut paths);
    let (mut named, mut unknown) = (BTreeSet::new(), BTreeSet::new());
    for p in paths {
        let Ok(e) = parse(&std::fs::read_to_string(&p).unwrap()) else {
            continue;
        };
        for (_, f) in e.get("forms").and_then(J::obj).unwrap_or(&[]) {
            for s in f.get("steps").and_then(J::arr).unwrap_or(&[]) {
                if let Some(mv) = s.get("move").and_then(J::str) {
                    named.insert(mv.to_owned());
                    if !known.contains(format!("souls:{mv}").as_str()) {
                        unknown.insert(mv.to_owned());
                    }
                }
            }
        }
    }
    println!("{} moves named by forms in content/kinds", named.len());
    assert!(named.len() > 20);
    let gap: BTreeSet<String> = NOT_IN_CONTENT.iter().map(|s| (*s).to_owned()).collect();
    assert_eq!(
        unknown, gap,
        "every move a form names is known, but the content gap"
    );
}

#[test]
fn a1_a_move_reads_as_b2s_fixture_gives_it() {
    let lib = worldd::acts::library().unwrap();
    let get = |n: &str| lib.iter().find(|m| m.name.as_str() == n).unwrap().clone();
    // content/moves/press.json, as B2's fixture press (replica/fixtures/moves/press.diag) but its contact point,
    // which a form's step names.
    let press = get("souls:press");
    assert_eq!(press.claims, vec![Want::One(Class::Manipulator)]);
    assert_eq!(
        (press.blocks.clone(), press.cancelled_by.clone()),
        (vec![Class::Manipulator], vec![Class::Manipulator])
    );
    assert_eq!(press.effector, Effector::Held);
    assert_eq!(press.reach, 600_000);
    let phases: Vec<(&str, i64)> = press
        .phases
        .iter()
        .map(|p| (p.name.as_str(), p.length))
        .collect();
    assert_eq!(
        phases,
        [("souls:start-up", 250_000), ("souls:recovery", 300_000)]
    );
    // A slide's middle phase; a stretch claims every leg and a hand; a look the gaze; a cheer the voice.
    let slide = get("souls:slide");
    let slide: Vec<&str> = slide.phases.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(slide, ["souls:start-up", "souls:slide", "souls:recovery"]);
    assert_eq!(
        get("souls:stretch").claims,
        vec![Want::All(Class::Locomotion), Want::One(Class::Manipulator)]
    );
    assert_eq!(get("souls:look").claims, vec![Want::One(Class::Gaze)]);
    assert!(get("souls:cheer").claims.contains(&Want::One(Class::Voice)));
    assert_eq!(get("souls:craft").reach, 500_000);
}

#[test]
fn a1_a_move_content_gets_wrong_is_refused_by_name() {
    let bad = |edit: &str| {
        let t = std::fs::read_to_string(format!("{}/content/moves/press.json", root())).unwrap();
        worldd::moves::from_content(&t.replace(r#""reach_mm": 600"#, edit))
            .err()
            .map(|r| r.name)
    };
    assert_eq!(bad(r#""reach_mm": 600"#), None);
    assert_eq!(bad(r#""reach_mm": 900"#), Some("move-reach-out-of-range"));
    assert_eq!(bad(r#""reach_mm": "far""#), Some("not-a-move"));
    let one_phase = r#"{"format": "souls-move/1", "move": "x", "claims": ["manipulator"], "blocks": [],
        "cancels_on": [], "effector": "hand", "reach_mm": 600, "phases": {"start_up_us": 1}}"#;
    assert_eq!(
        worldd::moves::from_content(one_phase).err().map(|r| r.name),
        Some("move-phases-too-few")
    );
}

/// 0.131 parity (#3736): today's nod and shake-head are 1.5 s head gestures, seated or standing, alone or toward
/// someone. Each is a gaze move of 1.5 s, and the humanoid has both forms, the one toward taking `toward`, as wave's.
#[test]
fn parity_nod_and_shake_head_are_head_gestures_of_today_s_length() {
    let lib = worldd::acts::library().unwrap();
    let humanoid = parse(
        &std::fs::read_to_string(format!("{}/content/kinds/body/humanoid.json", root())).unwrap(),
    )
    .unwrap();
    let forms = humanoid.get("forms").unwrap();
    for mv in ["nod", "shake_head"] {
        let m = lib
            .iter()
            .find(|m| m.name.as_str() == format!("souls:{mv}"))
            .unwrap_or_else(|| panic!("{mv} in the library"));
        assert_eq!(m.claims, vec![Want::One(Class::Gaze)], "{mv}: the head");
        assert_eq!(m.cancelled_by, vec![Class::Gaze], "{mv}");
        let total: i64 = m.phases.iter().map(|p| p.length).sum();
        assert_eq!(total, 1_500_000, "{mv}: today's 1.5 s");
        for (form, toward) in [(mv.to_owned(), false), (format!("{mv}_at"), true)] {
            let f = forms.get(&form).unwrap_or_else(|| panic!("form {form}"));
            let steps = f.get("steps").and_then(J::arr).unwrap();
            assert_eq!(steps.len(), 1, "{form}: one move");
            assert_eq!(steps[0].get("move").and_then(J::str), Some(mv), "{form}");
            assert_eq!(steps[0].get("toward").is_some(), toward, "{form}");
            assert_eq!(f.get("takes").is_some(), toward, "{form}: takes toward");
            assert!(
                f.get("needs").and_then(J::arr).is_some_and(<[J]>::is_empty),
                "{form}: seated or standing, as today"
            );
        }
    }
}

/// 0.134 B2 (for lane T's touch activities): handshake, hug, high-five and (0.135 E1) fist bump are contact moves
/// within an arm's reach (at most `REACH_MOST`), each reaching a named point of the other body that the move fixes.
#[test]
fn the_touch_moves_reach_a_named_point_of_the_other_body_within_an_arm() {
    let lib = worldd::acts::library().unwrap();
    for (mv, point) in [
        ("handshake", "souls:hand-right"),
        ("hug", "souls:chest"),
        ("high_five", "souls:hand-right"),
        ("fist_bump", "souls:hand-right"),
    ] {
        let m = lib
            .iter()
            .find(|m| m.name.as_str() == format!("souls:{mv}"))
            .unwrap_or_else(|| panic!("{mv} in the library"));
        assert_eq!(m.contact.as_str(), point, "{mv}: its contact point");
        assert!(
            m.reach > 0 && m.reach <= replica::moves::REACH_MOST,
            "{mv}: reach {} within an arm",
            m.reach
        );
        assert!(
            m.claims.contains(&Want::One(Class::Manipulator)),
            "{mv}: a hand"
        );
    }
    // A move that names no contact point still takes the step's `at`.
    let touch = lib
        .iter()
        .find(|m| m.name.as_str() == "souls:touch")
        .unwrap();
    assert_eq!(touch.contact.as_str(), "souls:surface");
}

/// 0.134 (lane T's T2): `hold_hand` reaches the other body's left hand within an arm, and its last phase holds until
/// the move is released.
#[test]
fn hold_hand_reaches_the_other_hand_and_holds_until_released() {
    let lib = worldd::acts::library().unwrap();
    let m = lib
        .iter()
        .find(|m| m.name.as_str() == "souls:hold_hand")
        .expect("hold_hand in the library");
    assert_eq!(m.contact.as_str(), "souls:hand-left");
    assert!(m.reach <= replica::moves::REACH_MOST);
    let last = m.phases.last().expect("phases");
    assert!(last.held, "the last phase holds");
    assert!(m.phases.iter().rev().skip(1).all(|p| !p.held));
}
