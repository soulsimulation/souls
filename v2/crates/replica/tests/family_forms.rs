//! A body's forms come from its family (E21, #2791): a served Soul's body kind (`souls:body`) has no entry, and gets
//! the world's family entry (`content/kinds/body/humanoid.json`), so a wave or a bow on its own body runs. The client's
//! `kindsIn` applies the same rule; `v2/client/src/check/state.test.mjs` checks it on the same entries.

use replica::kinds::entry::family_forms;
use replica::rules::json::{Value, parse};

const HUMANOID: &str = include_str!("../../../../content/kinds/body/humanoid.json");
const LAMP: &str =
    r#"{"format": "souls-entry/1", "kind": "eden:lamp", "owner": "thing", "forms": {}}"#;

fn entries() -> Vec<(String, Value)> {
    vec![
        ("eden:humanoid".into(), parse(HUMANOID).unwrap()),
        ("eden:lamp".into(), parse(LAMP).unwrap()),
    ]
}

fn form(e: &Value, name: &str) -> bool {
    e.get("forms").and_then(|f| f.get(name)).is_some()
}

#[test]
fn a_body_with_no_entry_gets_the_worlds_family_forms() {
    let mut e = entries();
    assert!(family_forms(&mut e, "souls:body"));
    let (k, body) = e.last().unwrap();
    assert_eq!(k, "souls:body");
    assert_eq!(body.get("kind").and_then(Value::str), Some("souls:body"));
    for name in [
        "wave", "bow", "go_to", "look_at", "point", "touch", "lean_on", "wait_by",
    ] {
        assert!(form(body, name), "{name}");
    }
    let family = e[0].1.get("kind").and_then(Value::str);
    assert_eq!(family, Some("eden:humanoid"), "the family's entry is kept");
    // Deterministic: the same entries give the same entry.
    let mut again = entries();
    family_forms(&mut again, "souls:body");
    assert_eq!(again.last().unwrap().1.to_json(), body.to_json());
}

#[test]
fn a_body_with_an_entry_no_family_or_two_families_is_left_alone() {
    let mut e = entries();
    let own = parse(r#"{"kind": "souls:body"}"#).unwrap();
    e.push(("souls:body".into(), own));
    assert!(!family_forms(&mut e, "souls:body"));
    assert_eq!(e.len(), 3);
    let mut e = vec![("eden:lamp".to_owned(), parse(LAMP).unwrap())];
    assert!(!family_forms(&mut e, "souls:body"));
    let mut e = entries();
    let other = HUMANOID.replace("eden:humanoid", "eden:quadruped");
    e.push(("eden:quadruped".into(), parse(&other).unwrap()));
    assert!(!family_forms(&mut e, "souls:body"), "two families: none");
    assert_eq!(e.len(), 3);
}
