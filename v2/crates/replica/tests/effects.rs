//! Effects (Engine v2 T6, #2645; `v2/docs/effects.md`). The WASM build gives the same goldens in the
//! `effects-goldens` step of `v2/tools/ci.sh`.

use replica::effects::{
    Change, FIXTURE_HEADER, FIXTURES, Part, State, effects_goldens, fixture_bytes, run_fixtures,
    step0, texts,
};
use replica::encode::{Value, decode, encode};

const GOLDENS: &str = include_str!("../fixtures/effects/goldens.txt");

fn part(name: &str) -> Part {
    let (_, text) = FIXTURES
        .iter()
        .find(|(n, _)| *n == name)
        .expect("a fixture");
    Part::read(&fixture_bytes(text).expect("bytes")).expect("a part")
}

#[test]
fn step0_t4s_hand_off_round_trips_through_t0s_profile() {
    let (hex, same) = step0().expect("step 0");
    println!(
        "Step 0: T4's hand-off record, {} bytes, decodes and encodes to the same bytes: {same}",
        hex.len() / 2
    );
    assert!(same);
}

#[test]
fn a1_each_generic_change_has_golden_bytes_and_one_state_hash() {
    assert_eq!(
        effects_goldens(),
        GOLDENS,
        "natively, the goldens differ from fixtures/effects/goldens.txt"
    );
    let (header, outcomes) = run_fixtures().expect("the fixtures apply");
    println!(
        "A1: header {} ({} bytes)",
        header.hash(),
        header.stored().len()
    );
    let mut kinds = Vec::new();
    for o in &outcomes {
        assert!(o.same_bytes, "{} does not re-encode to its bytes", o.name);
        let p = part(o.name);
        let names: Vec<&str> = p.effects[0]
            .changes
            .iter()
            .map(|c| match c.change {
                Change::Create { .. } => "create",
                Change::Remove { .. } => "remove",
                Change::Reparent { .. } => "reparent",
                Change::Set { .. } => "set",
                Change::Link { .. } => "link",
                Change::Unlink { .. } => "unlink",
                Change::Motion(_) => "motion",
            })
            .collect();
        if o.name != "0-base" && o.name != "8-future" {
            kinds.push(names[0]);
        }
        println!(
            "A1: {:<10} {:>4} bytes, {:?}, state {}",
            o.name,
            o.bytes.len(),
            names,
            o.state
        );
    }
    assert_eq!(
        kinds,
        [
            "create", "remove", "reparent", "set", "link", "unlink", "motion"
        ]
    );
}

#[test]
fn a2_stripping_named_events_leaves_the_state_hash() {
    let (_, outcomes) = run_fixtures().expect("the fixtures apply");
    for o in &outcomes {
        let p = part(o.name);
        let stripped = p.strip_events().expect("stripped");
        assert!(
            p.effects.iter().all(|e| e.events.is_some()),
            "{} has no event to strip",
            o.name
        );
        assert_ne!(stripped.stored(), p.stored());
        assert_eq!(
            o.state, o.stripped,
            "{}: stripping its events changed the state",
            o.name
        );
        println!(
            "A2: {:<10} {:>4} bytes with events, {:>4} without; state {} both ways",
            o.name,
            p.stored().len(),
            stripped.stored().len(),
            o.state
        );
    }
}

#[test]
fn a3_a_fixture_from_the_future_is_applied_kept_whole_and_hashes_the_same() {
    let (_, outcomes) = run_fixtures().expect("the fixtures apply");
    let get = |n: &str| outcomes.iter().find(|o| o.name == n).expect("an outcome");
    let (future, set) = (get("8-future"), get("4-set"));
    let p = part("8-future");
    let e = &p.effects[0];
    let ev = &e.events.as_ref().expect("an event")[0];
    println!(
        "A3: unknown fields kept: effect {:?}, first change {:?}, event {:?}; event name {}",
        e.rest.keys().collect::<Vec<_>>(),
        e.changes[0].rest.keys().collect::<Vec<_>>(),
        ev.rest.keys().collect::<Vec<_>>(),
        ev.name.as_str()
    );
    assert!(!e.rest.is_empty() && !e.changes[0].rest.is_empty() && !ev.rest.is_empty());
    assert!(
        future.same_bytes,
        "the future part does not re-encode to its own bytes"
    );
    assert_eq!(encode(&p.to_value()).expect("encodes"), p.stored());
    assert_ne!(future.bytes, set.bytes);
    assert_eq!(future.state, set.state);
    println!(
        "A3: 8-future ({} bytes) re-encodes to its bytes and leaves state {}, as 4-set ({} bytes) does",
        future.bytes.len(),
        future.state,
        set.bytes.len()
    );
    // A change of a kind this build does not know would change state it cannot apply: refused, never skipped.
    let mut v = decode(&future.bytes).expect("decodes").value;
    if let Value::Map(m) = &mut v
        && let Some(Value::Array(es)) = m.get_mut(&2)
        && let Some(Value::Map(e)) = es.get_mut(0)
        && let Some(Value::Array(cs)) = e.get_mut(&7)
        && let Some(Value::Map(c)) = cs.get_mut(0)
    {
        c.insert(1, Value::Uint(8));
    }
    let refused = Part::read(&encode(&v).expect("encodes")).expect_err("refused");
    println!("A3: a change of kind 8 is refused: {refused}");
    assert_eq!(refused.name, "change-unknown");
}

#[test]
fn a4_no_fixture_holds_free_text_or_a_float_and_each_part_names_its_header() {
    let (header, _) = run_fixtures().expect("the fixtures apply");
    let mut all = vec![("header", fixture_bytes(FIXTURE_HEADER).expect("bytes"))];
    all.extend(
        FIXTURES
            .iter()
            .map(|(n, t)| (*n, fixture_bytes(t).expect("bytes"))),
    );
    let mut count = 0;
    for (name, bytes) in &all {
        // T0's decoder refuses every float, tag and simple value by name (encoding.md rule 2).
        let v = decode(bytes).expect("no float, tag or simple value").value;
        for t in texts(&v) {
            let (plain, _) = t.split_once('@').unwrap_or((&t, ""));
            assert!(
                plain.contains(':') && !t.contains(' '),
                "{name}: free text {t}"
            );
            count += 1;
        }
        if *name != "header" {
            assert_eq!(
                part(name).header,
                header.hash().to_bytes(),
                "{name} names another header"
            );
        }
    }
    println!(
        "A4: {} files decode under T0's profile (no float); {count} text items, every one a name",
        all.len()
    );
    println!("A4: every part names header {}", header.hash());
    // A word is refused; so is a part naming another header.
    let words = r#"{1: h'1220a695c8697d7f1068126cc5e5f70ba56308671ab34c5aa6f089dd6c00680ca1a0', 2: [], 3: "hello"}"#;
    let refused = Part::read(&fixture_bytes(words).expect("bytes")).expect_err("refused");
    println!("A4: {refused}");
    assert_eq!(refused.name, "text-not-a-name");
    let mut other = part("1-create");
    other.header[2] ^= 1;
    let bytes = encode(&other.to_value()).expect("encodes");
    let mut state = State::start(header.zone, header.kinds[0].clone());
    let refused = state
        .apply(&header, &Part::read(&bytes).expect("a part"))
        .expect_err("refused");
    println!("A4: {refused}");
    assert_eq!(refused.name, "header-mismatch");
}
