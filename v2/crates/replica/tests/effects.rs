//! Effects (Engine v2 T6, #2645; `v2/docs/effects.md`). The WASM build gives the same goldens in the
//! `effects-goldens` step of `v2/tools/ci.sh`.

use replica::effects::{
    Body, Change, FIXTURE_HEADER, FIXTURES, Header, Part, State, TransferRec, effects_goldens,
    fixture_bytes, run_fixtures, step0, texts,
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
        let names: Vec<&str> = p
            .effects
            .iter()
            .flat_map(|e| match &e.body {
                Body::Changes(c) => c
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
                    .collect(),
                Body::Transfer(t) => vec![match t {
                    TransferRec::Leave { .. } => "leave",
                    TransferRec::Arrive { carried, .. } if carried.is_empty() => "arrive",
                    TransferRec::Arrive { .. } => "arrive-carrying",
                    TransferRec::Settle { .. } => "settle",
                    TransferRec::Return { .. } => "return",
                }],
                Body::Time(_) => vec!["time"],
                Body::Timers(_) => vec!["timers"],
            })
            .collect();
        let seven = [
            "1-create",
            "2-remove",
            "3-reparent",
            "4-set",
            "5-link",
            "6-unlink",
            "7-motion",
        ];
        if seven.contains(&o.name) {
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
            p.effects.iter().any(|e| e.events.is_some()),
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
        e.changes()[0].rest.keys().collect::<Vec<_>>(),
        ev.rest.keys().collect::<Vec<_>>(),
        ev.name.as_str()
    );
    assert!(!e.rest.is_empty() && !e.changes()[0].rest.is_empty() && !ev.rest.is_empty());
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
    let words = r#"{1: h'12201b6152bdcb78adacbc5eb70d3aff3ee1fff947060db15527395c3c0706158db5', 2: [], 3: "hello"}"#;
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

/// The base's state, and a probe part of one entry (sequence 2) applied to it: what it is refused as, if anything.
fn probe(entry: &str) -> Result<(), String> {
    let (header, _) = run_fixtures().expect("the fixtures apply");
    let mut state = State::start(header.zone, header.kinds[0].clone());
    state.apply(&header, &part("0-base")).expect("the base");
    let text = format!(
        "{{1: h'12201b6152bdcb78adacbc5eb70d3aff3ee1fff947060db15527395c3c0706158db5', 2: [{entry}]}}"
    );
    let p = Part::read(&fixture_bytes(&text).map_err(|r| r.name.to_owned())?)
        .map_err(|r| r.name.to_owned())?;
    state.apply(&header, &p).map_err(|r| r.name.to_owned())
}

const E: &str = "h'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'";

#[test]
fn review_each_entry_writes_its_own_node_and_every_refusal_is_named() {
    let env = |node: u64, audience: &str| {
        format!("1: 2, 2: 1, 3: {{1: 3}}, 4: {{1: 3}}, 5: {audience}, 6: [{E}, {node}]")
    };
    let public = "{1: 1}";
    let pose = |frame: &str| {
        format!("{{1: {frame}, 2: [0, 0, 0], 3: [1073741824, 0, 0, 0], 4: {{1: 2}}}}")
    };
    let key = "\"souls:key@1220781d89e0ae5ff74f79e61f020201f2128268af10ffa77355868f6c8497442ae1\"";
    let cases = [
        (
            "the crate's entry sets the cup's field",
            format!(
                "{{{}, 7: [{{1: 4, 2: [{E}, 4], 3: 1, 4: 5}}]}}",
                env(7, public)
            ),
            "not-own-node",
        ),
        (
            "an entry of a node that does not exist",
            format!(
                "{{{}, 7: [{{1: 4, 2: [{E}, 4], 3: 1, 4: 5}}]}}",
                env(999, public)
            ),
            "node-missing",
        ),
        (
            "the cup reparented from the hand onto the crate",
            format!(
                "{{{}, 7: [{{1: 3, 2: [{E}, 4], 3: [[{E}, 2], 2], 4: {}}}]}}",
                env(4, public),
                pose(&format!("[[{E}, 7], 1]"))
            ),
            "crosses-nodes",
        ),
        (
            "a public entry creates a private node",
            format!(
                "{{{}, 7: [{{1: 1, 2: [{E}, 30], 3: {key}, 4: {}, 5: {{1: 2, 2: [{E}, 20]}}, 6: {{}}}}]}}",
                env(1, public),
                pose(&format!("[[{E}, 1], 1]"))
            ),
            "audience-mismatch",
        ),
        (
            "a set to 2^64 - 1",
            format!(
                "{{{}, 7: [{{1: 4, 2: [{E}, 7], 3: 1, 4: 18446744073709551615}}]}}",
                env(7, public)
            ),
            "int-out-of-range",
        ),
        (
            "an event's empty fields",
            format!(
                "{{{}, 7: [{{1: 4, 2: [{E}, 7], 3: 1, 4: 5}}], 8: [{{1: \"souls:x\", 2: {{}}}}]}}",
                env(7, public)
            ),
            "not-canonical",
        ),
        (
            "a motion sample handing off to an island",
            format!(
                "{{{}, 7: [{{1: 7, 2: {{1: [{E}, 2], 2: 1, 3: {{1: 2}}, 4: {{1: 4}}, 5: {}, 6: [0, 0, 0], 7: [0, 0, 0]}}}}]}}",
                env(2, public),
                pose(&format!("[[{E}, 1]]"))
            ),
            "island-reserved",
        ),
        (
            "the root removed",
            format!("{{{}, 7: [{{1: 2, 2: [{E}, 0]}}]}}", env(0, public)),
            "remove-root",
        ),
        (
            "a return whose reason is not a name",
            format!(
                "{{{}, 9: {{1: 4, 2: [{E}, 13], 3: \"noroom\"}}}}",
                env(1, public)
            ),
            "text-not-a-name",
        ),
    ];
    for (what, entry, want) in cases {
        let got = probe(&entry).expect_err(what);
        println!("Review: {what}: refused as {got}");
        assert_eq!(got, want, "{what}");
    }
    // A header naming a schema this build does not apply is refused by name.
    let other = FIXTURE_HEADER.replace(
        "12203b42be7ff1ce584936f5e3ae7b989d444eb16c66bdcaa214ee3b42776bca6b83",
        "12200000000000000000000000000000000000000000000000000000000000000000",
    );
    let got = Header::read(&fixture_bytes(&other).expect("bytes")).expect_err("refused");
    println!(
        "Review: a header naming an unknown schema: refused as {}",
        got.name
    );
    assert_eq!(got.name, "schema-unknown");
}

/// What `Part::read` gives for `effects` under `header`, from their value encoded: the reader `Part::of_effects`
/// must agree with.
fn read_of(
    header: &[u8],
    effects: &[replica::effects::Effect],
) -> Result<Part, replica::effects::Refusal> {
    let v = Value::Map(std::collections::BTreeMap::from([
        (1, Value::Bytes(header.to_vec())),
        (
            2,
            Value::Array(effects.iter().map(|e| e.to_value()).collect()),
        ),
    ]));
    Part::read(&encode(&v).unwrap())
}

/// #4117 review (0.132 scaling, #1960): `Part::of_effects` gives what `Part::read` gives for the same effects, in
/// every build (CI runs this in release too). Every fixture part comes out the same, bytes included: motion,
/// reparents and transfers built without a decode, the others read back. A motion sample or a leave whose pose or
/// owner the reader refuses is refused by the reader's name, so the world's writer takes its per-sample fallback and
/// never logs a record its restart cannot read.
#[test]
fn a_built_part_is_the_read_part_and_a_bad_pose_is_refused_by_the_readers_name() {
    use replica::pose::{Owner, Support};
    let mut motions = 0;
    let mut leaves = 0;
    for (name, _) in FIXTURES {
        let p = part(name);
        let built = Part::of_effects(p.header.clone(), p.effects.clone()).expect("built");
        assert_eq!(built, p, "{name}: the same part");
        assert_eq!(built.stored(), p.stored(), "{name}: the same bytes");
        let refused_alike = |effects: Vec<replica::effects::Effect>, what: &str| {
            let want = read_of(&p.header, &effects).expect_err("the reader refuses it");
            let got = Part::of_effects(p.header.clone(), effects).expect_err(what);
            assert_eq!(got.name, want.name, "{name}: {what}");
        };
        for (k, e) in p.effects.iter().enumerate() {
            if let Body::Changes(c) = &e.body {
                for (j, ch) in c.iter().enumerate() {
                    let Change::Motion(h) = ch.change else {
                        continue;
                    };
                    motions += 1;
                    let mut slot_on_surface = h;
                    slot_on_surface.pose.frame.slot = Some(1);
                    slot_on_surface.pose.support = Support::None;
                    let mut slot_off_frame = h;
                    slot_off_frame.pose.frame.slot = None;
                    slot_off_frame.pose.support = Support::Slot;
                    let mut below = h;
                    below.pose.frame.slot = None;
                    below.pose.support = Support::Surface {
                        surface: h.node,
                        height: -1,
                    };
                    let mut island = h;
                    island.to = Owner::Island;
                    for (what, bad) in [
                        ("a slot's pose not in the slot", slot_on_surface),
                        ("the slot's support off a slot", slot_off_frame),
                        ("a height below its surface", below),
                        ("an island owner", island),
                    ] {
                        let mut effects = p.effects.clone();
                        if let Body::Changes(cs) = &mut effects[k].body {
                            cs[j].change = Change::Motion(bad);
                        }
                        refused_alike(effects, what);
                    }
                }
            }
            if let Body::Transfer(TransferRec::Leave { .. }) = &e.body {
                leaves += 1;
                let mut effects = p.effects.clone();
                if let Body::Transfer(TransferRec::Leave { pose, .. }) = &mut effects[k].body {
                    pose.frame.slot = None;
                    pose.support = Support::Slot;
                }
                refused_alike(effects, "a leave's pose");
            }
        }
    }
    println!(
        "of_effects: every fixture part the same; {motions} motion samples refused four ways and {leaves} leaves by the \
         reader's names"
    );
    assert!(
        motions > 0 && leaves > 0,
        "the fixtures hold motion and leaves"
    );
}
