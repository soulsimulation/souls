//! Intents and the protocol (Engine v2 T10, #2664; `v2/docs/intents.md`). The WASM build gives the same goldens in the
//! `intents-goldens` step of `v2/tools/ci.sh`.

use replica::effects::fixture_bytes;
use replica::encode::{Value, decode, encode, to_hex};
use replica::intents::{
    Checker, FIXTURES, Hello, INTENT_MOST, Intent, Kind, PROTOCOL, answer_hello, build_hash,
    intents_goldens,
};

const GOLDENS: &str = include_str!("../fixtures/intents/goldens.txt");

fn intent(name: &str) -> (Vec<u8>, Intent) {
    let (_, text) = FIXTURES
        .iter()
        .find(|(n, _)| *n == name)
        .expect("a fixture");
    let bytes = fixture_bytes(text).expect("bytes");
    let i = Intent::read(&bytes).expect("an intent");
    (bytes, i)
}

#[test]
fn a1_golden_envelopes_for_every_kind_of_intent() {
    let want = [
        ("act", Kind::Act),
        ("move", Kind::Move),
        ("fallbacks", Kind::Act),
        ("hold", Kind::Order),
        ("follow", Kind::Order),
        ("queue", Kind::Order),
        ("cancel", Kind::Cancel),
        ("replace", Kind::Act),
        ("edit", Kind::Edit),
        ("reflex", Kind::Act),
    ];
    for (name, kind) in want {
        let (bytes, i) = intent(name);
        let again = encode(&i.to_value()).expect("bytes");
        println!(
            "{name:<9} {kind:?}: {} bytes, fallbacks {}, replaces {:?}, re-encodes to its bytes: {}",
            bytes.len(),
            i.fallbacks.len(),
            i.replaces,
            again == bytes
        );
        assert_eq!(i.kind(), Ok(kind));
        assert_eq!(again, bytes);
    }
    let got = intents_goldens();
    if std::env::var_os("INTENTS_WRITE_GOLDENS").is_some() {
        std::fs::write("fixtures/intents/goldens.txt", &got).expect("written");
    }
    assert_eq!(
        got, GOLDENS,
        "the natively built goldens differ from fixtures/intents/goldens.txt"
    );
    println!(
        "native: equal to fixtures/intents/goldens.txt ({} lines)",
        got.lines().count()
    );
}

#[test]
fn a2_an_old_client_reads_a_version_refusal_naming_both_versions() {
    let build = build_hash(b"a world's pinned build");
    let old = Hello {
        protocol: PROTOCOL,
        build: build.clone(),
        refused: None,
        other: None,
    }
    .to_bytes()
    .expect("bytes");
    let reply = answer_hello(&old, PROTOCOL + 1, &build).expect("an answer");
    // The client's own reader: the first frame never changes, so the same code reads any later world's.
    let read = Hello::read(&reply).expect("decodes");
    println!(
        "a client on {PROTOCOL} meets a world on {}: {} -> refused {:?}",
        PROTOCOL + 1,
        to_hex(&reply),
        read.refused
    );
    assert_eq!(read.refused, Some((PROTOCOL, PROTOCOL + 1)));
    assert_eq!(read.build, build);
    let same =
        Hello::read(&answer_hello(&old, PROTOCOL, &build).expect("an answer")).expect("decodes");
    assert_eq!(same.refused, None);
    // A refusal of another kind, from a later world, is read by its name.
    let later = Hello {
        protocol: PROTOCOL + 1,
        build: build.clone(),
        refused: None,
        other: Some(replica::encode::Name::new("souls:world-asleep").expect("a name")),
    }
    .to_bytes()
    .expect("bytes");
    let read = Hello::read(&later).expect("decodes");
    assert_eq!(
        read.other.as_ref().map(|n| n.as_str()),
        Some("souls:world-asleep")
    );
}

#[test]
fn a3_a_checker_loads_only_when_its_bytes_match_the_build_asked_for() {
    // The smallest WASM module: the header and nothing else, so no imports.
    let module = b"\0asm\x01\0\0\0".to_vec();
    let want = build_hash(&module);
    let ok = Checker::load(&module, &want).map(|c| to_hex(&c.build));
    println!("asked {}: {ok:?}", to_hex(&want));
    assert!(ok.is_ok());
    let other = build_hash(b"another build");
    let r = Checker::load(&module, &other).map_err(|r| r.name);
    println!("asked another build: {r:?}");
    assert_eq!(r, Err("checker-not-the-build"));
    // A module that imports anything (section 2, one import of `env.f`, a function of type 0) is refused.
    let mut importing = module.clone();
    importing.extend([2, 7, 1, 3, b'e', b'n', b'v', 1, b'f']);
    importing.extend([0, 0]);
    importing[9] = 9;
    let r = Checker::load(&importing, &build_hash(&importing)).map_err(|r| r.name);
    println!("a module with an import: {r:?}");
    assert_eq!(r, Err("checker-has-imports"));
    let r = Checker::load(b"not wasm", &build_hash(b"not wasm")).map_err(|r| r.name);
    assert_eq!(r, Err("checker-not-wasm"));
}

#[test]
fn a4_an_order_outside_the_list_and_an_oversized_intent_are_refused_by_name() {
    let (bytes, _) = intent("hold");
    let Value::Map(mut m) = decode(&bytes).expect("decodes").value else {
        panic!("a map")
    };
    m.insert(
        2,
        Value::Text(replica::encode::Name::new("souls:wait").expect("a name")),
    );
    let wait = encode(&Value::Map(m.clone())).expect("bytes");
    let r = Intent::read(&wait).map_err(|r| (r.name, r.detail));
    println!("souls:wait: {r:?}");
    assert_eq!(r.map_err(|r| r.0), Err("order-unknown"));
    // A start time or a condition has no field.
    let mut later = m.clone();
    later.insert(
        2,
        Value::Text(replica::encode::Name::new("souls:hold").expect("a name")),
    );
    later.insert(12, Value::Uint(1_000_000));
    let r = Intent::read(&encode(&Value::Map(later)).expect("bytes")).map_err(|r| r.name);
    assert_eq!(r, Err("intent-not-a-record"));
    // Over the limit, refused before parsing: these bytes are not even CBOR.
    let big = vec![0xff_u8; usize::try_from(INTENT_MOST).expect("small") + 1];
    let r = Intent::read(&big).map_err(|r| (r.name, r.detail));
    println!("{} bytes of 0xff: {r:?}", big.len());
    assert_eq!(r.map_err(|r| r.0), Err("intent-too-large"));
    // Each refusal of the kinds' shapes, by name.
    let with = |name: &str, k: u64, v: Value| {
        let (bytes, _) = intent(name);
        let Value::Map(mut m) = decode(&bytes).expect("decodes").value else {
            panic!("a map")
        };
        m.insert(k, v);
        Intent::read(&encode(&Value::Map(m)).expect("bytes")).map_err(|r| r.name)
    };
    let verb = |t: &str| Value::Text(replica::encode::Name::new(t).expect("a name"));
    let fb = |t: &str| Value::Array(vec![Value::Map([(2, verb(t))].into())]);
    for (what, got, want) in [
        (
            "an order as a fallback",
            with("act", 9, fb("souls:wait")),
            "fallback-not-an-act",
        ),
        (
            "a hold as a fallback",
            with("act", 9, fb("souls:hold")),
            "fallback-not-an-act",
        ),
        (
            "fallbacks on an order",
            with("hold", 9, fb("eden:sit")),
            "fallbacks-not-on-an-act",
        ),
        (
            "a cancel with a target",
            with(
                "cancel",
                3,
                Value::Array(vec![Value::Bytes(vec![0xee; 16]), Value::Uint(8)]),
            ),
            "cancel-not-bare",
        ),
        (
            "a Soul naming a body",
            with(
                "act",
                11,
                Value::Array(vec![Value::Bytes(vec![0xee; 16]), Value::Uint(40)]),
            ),
            "body-not-a-creators",
        ),
        (
            "a basis that is not a version",
            with(
                "act",
                6,
                Value::Array(vec![
                    Value::Uint(1),
                    Value::Uint(2),
                    Value::Uint(3),
                    Value::Uint(4),
                ]),
            ),
            "intent-not-a-record",
        ),
    ] {
        println!("{what}: {got:?}");
        assert_eq!(got, Err(want), "{what}");
    }
    let (bytes, _) = intent("follow");
    let Value::Map(mut m) = decode(&bytes).expect("decodes").value else {
        panic!("a map")
    };
    m.remove(&11);
    let r = Intent::read(&encode(&Value::Map(m)).expect("bytes")).map_err(|r| r.name);
    assert_eq!(r, Err("creator-without-body"));
    let (bytes, _) = intent("queue");
    let Value::Map(mut m) = decode(&bytes).expect("decodes").value else {
        panic!("a map")
    };
    m.remove(&3);
    let r = Intent::read(&encode(&Value::Map(m)).expect("bytes")).map_err(|r| r.name);
    assert_eq!(r, Err("order-without-target"));
    // Five fallbacks are more than the bound.
    let (bytes, _) = intent("fallbacks");
    let Value::Map(mut f) = decode(&bytes).expect("decodes").value else {
        panic!("a map")
    };
    let Some(Value::Array(a)) = f.get(&9).cloned() else {
        panic!("fallbacks")
    };
    f.insert(9, Value::Array(a.iter().cycle().take(5).cloned().collect()));
    let r = Intent::read(&encode(&Value::Map(f)).expect("bytes")).map_err(|r| r.name);
    assert_eq!(r, Err("fallbacks-too-many"));
}

/// G1b (#3362), rule 15: the edit golden reads to its batch of four operations, its basis as the planned version, and
/// writes back to the same parameters; answers to every other kind keep their bytes (fields 6 and 7 left out).
#[test]
fn g1b_an_edit_reads_to_its_batch_and_other_answers_keep_their_bytes() {
    use replica::edit::Op;
    use replica::edit::wire::{edit_of, parameters};
    use replica::effects::Actor;
    use replica::ids::{Id, Scope};
    use replica::intents::Answer;
    let (_, i) = intent("edit");
    let id = Id::new(Scope([9; 16]), 1).expect("an id");
    let e = edit_of(&i, id).expect("an edit");
    let kinds: Vec<&str> = e
        .ops
        .iter()
        .map(|o| match o {
            Op::Place { .. } => "place",
            Op::Move { .. } => "move",
            Op::Set { .. } => "set",
            Op::Remove { .. } => "remove",
            Op::Doorway { .. } => "doorway",
            Op::Link { .. } => "link",
            Op::Rows { .. } => "rows",
        })
        .collect();
    println!(
        "edit: actor {:?}, planned {}, ops {kinds:?}",
        e.actor, e.planned
    );
    assert_eq!(kinds, ["place", "move", "set", "remove"]);
    assert_eq!((e.planned, e.intent), (42, id));
    assert!(matches!(e.actor, Actor::Creator(_)));
    assert!(
        matches!(&e.ops[0], Op::Place { kind, .. } if kind.as_str().starts_with("souls:crate@1220"))
    );
    assert_eq!(parameters(&e.ops), i.parameters);
    // A Soul's edit reads too: the world, not the decoder, refuses it (`edit.not-the-creator`).
    let mut soul = i.clone();
    soul.actor = Actor::Soul(Id::new(Scope([0xdd; 16]), 100).expect("an id"));
    let bytes = encode(&soul.to_value()).expect("bytes");
    assert_eq!(Intent::read(&bytes).map(|s| s.kind()), Ok(Ok(Kind::Edit)));
    // A receipt without names and a refusal without an operation are the answers they were.
    let keys = |a: &Answer| match a.to_value() {
        Value::Map(m) => m.keys().copied().collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    let receipt = Answer::Receipt {
        actor: e.actor,
        sequence: 1,
        intent: id,
        entries: vec![3],
        names: Default::default(),
    };
    let refused = Answer::Refused {
        actor: e.actor,
        sequence: 1,
        reason: replica::encode::Name::new("act.refused").expect("a name"),
        now: i.basis.clone(),
        changed: Vec::new(),
        op: None,
        detail: None,
    };
    assert_eq!(keys(&receipt), [1, 2, 3, 4, 5]);
    assert_eq!(keys(&refused), [1, 2, 3, 4, 5]);
}

#[test]
fn g1f_doorway_wire_roundtrip_keeps_owned_geometry_under_strict_i2() {
    use replica::edit::wire::{parameters, read};
    use replica::edit::{Op, Ref};
    use replica::ids::{Id, Scope};
    let node = |n| Ref::Node(Id::new(Scope([0xdd; 16]), n).unwrap());
    let row = |n| Value::Array(vec![Value::Uint(n); 9]);
    let ops = vec![Op::Doorway {
        name: 7,
        door: node(1),
        from: node(2),
        to: node(3),
        at: [-500, 0],
        yaw: 90000,
        width: 1200,
        height: 2100,
        wall: node(4),
        closed: vec![row(1)],
        open: vec![row(2), row(3)],
    }];
    let (_, mut i) = intent("edit");
    i.parameters = parameters(&ops);
    let bytes = encode(&i.to_value()).unwrap();
    let decoded = replica::intent_decode::decode(&bytes).unwrap();
    assert_eq!(read(&decoded.parameters).unwrap(), ops);
    let Value::Array(batch) = i.parameters.get_mut(&1).unwrap() else {
        panic!("batch")
    };
    let Value::Map(op) = &mut batch[0] else {
        panic!("operation")
    };
    op.insert(11, Value::Uint(0));
    assert!(replica::intent_decode::decode(&encode(&i.to_value()).unwrap()).is_err());
}

#[test]
fn link_wire_roundtrip_keeps_its_row_owner_and_door_under_strict_i2() {
    use replica::edit::wire::{parameters, read};
    use replica::edit::{Op, Ref};
    use replica::ids::{Id, Scope};
    use replica::world_model::End;
    let node = |n| Ref::Node(Id::new(Scope([0xdd; 16]), n).unwrap());
    // A stair's row: its kind, then numbers, then its line's points (3 deep inside the operation).
    let row = vec![
        Value::Text(replica::encode::Name::new("eden:stairs").unwrap()),
        Value::Uint(1),
        Value::Array(vec![Value::Array(vec![Value::Uint(5), Value::Nint(4)])]),
    ];
    for (owner, door) in [(End::First, Some(Ref::New(3))), (End::Second, None)] {
        let ops = vec![Op::Link {
            name: 7,
            ty: replica::encode::Name::new("eden:stairs").unwrap(),
            ends: [node(1), node(2)],
            owner,
            field: 21,
            row: row.clone(),
            door,
        }];
        let (_, mut i) = intent("edit");
        i.parameters = parameters(&ops);
        let decoded = replica::intent_decode::decode(&encode(&i.to_value()).unwrap()).unwrap();
        assert_eq!(read(&decoded.parameters).unwrap(), ops);
    }
}

/// #3728: a rows operation (a land edit's changed tiles) keeps its node, field and rows on the wire, and merges each
/// row over the one with its first two values, adding the rest after.
#[test]
fn rows_wire_roundtrip_and_merge_by_first_two_values() {
    use replica::edit::wire::{parameters, read};
    use replica::edit::{Op, Ref, merged_rows};
    use replica::ids::{Id, Scope};
    let tile = |x: u64, z: u64, h: u8| {
        Value::Array(vec![
            Value::Uint(x),
            Value::Uint(z),
            Value::Bytes(vec![h; 4]),
            Value::Bytes(vec![0]),
        ])
    };
    let ops = vec![Op::Rows {
        node: Ref::Node(Id::new(Scope([0xdd; 16]), 1).unwrap()),
        field: 25,
        rows: vec![tile(1, 0, 9), tile(2, 0, 9)],
    }];
    let (_, mut i) = intent("edit");
    i.parameters = parameters(&ops);
    let decoded = replica::intent_decode::decode(&encode(&i.to_value()).unwrap()).unwrap();
    assert_eq!(read(&decoded.parameters).unwrap(), ops);
    let now = Value::Array(vec![tile(0, 0, 1), tile(1, 0, 1)]);
    assert_eq!(
        merged_rows(Some(&now), &[tile(1, 0, 9), tile(2, 0, 9)]),
        Some(Value::Array(vec![
            tile(0, 0, 1),
            tile(1, 0, 9),
            tile(2, 0, 9)
        ]))
    );
    assert_eq!(
        merged_rows(Some(&Value::Uint(3)), &[tile(1, 0, 9)]),
        None,
        "not a field of rows"
    );
    assert_eq!(
        merged_rows(Some(&now), &[Value::Array(vec![Value::Uint(1)])]),
        None,
        "a row of one value"
    );
    assert_eq!(merged_rows(None, &[tile(1, 0, 9)]), None, "no field");
}

/// The checker artifact itself (rule 13): when CI has built it (`CHECKER_WASM`, the `checker-artifact` step of
/// `v2/tools/ci.sh`), it loads by its own hash. Without the variable this test says so and checks nothing.
#[test]
fn the_built_checker_artifact_loads_by_its_hash() {
    let Some(path) = std::env::var_os("CHECKER_WASM") else {
        println!("CHECKER_WASM is not set: the checker-artifact step of v2/tools/ci.sh runs this");
        return;
    };
    let bytes = std::fs::read(&path).expect("the checker artifact");
    let want = build_hash(&bytes);
    let r = Checker::load(&bytes, &want).map(|c| to_hex(&c.build));
    println!("{} bytes: {r:?}", bytes.len());
    assert!(r.is_ok(), "{r:?}");
}

/// #3764: a reflex is marked (field 12 is 1) and an agent's act is not; a reflex is not its agent acting, and a
/// marker other than 1 is refused.
#[test]
fn reflex_a1_a_reflex_is_marked_and_an_agents_act_is_not() {
    let (act_bytes, act) = intent("act");
    let (reflex_bytes, reflex) = intent("reflex");
    assert!(!act.reflex && act.agent_act(), "an agent's act: unmarked");
    assert!(reflex.reflex && !reflex.agent_act(), "a reflex: marked");
    // The same act but for the marker, which is the envelope's last field: `12: 1`, two bytes, and one more field.
    assert_eq!(reflex_bytes[0], act_bytes[0] + 1);
    assert_eq!(&reflex_bytes[1..reflex_bytes.len() - 2], &act_bytes[1..]);
    assert_eq!(&reflex_bytes[reflex_bytes.len() - 2..], &[0x0c, 0x01]);
    let mut unmarked = reflex.clone();
    unmarked.reflex = false;
    assert_eq!(unmarked, act);
    // Only `1` marks a reflex: `12: 0` and `12: 2` are not records.
    for bad in [0x00, 0x02] {
        let mut b = reflex_bytes.clone();
        *b.last_mut().expect("a byte") = bad;
        let r = Intent::read(&b).expect_err("refused");
        assert_eq!(r.name, "intent-not-a-record", "12: {bad}");
    }
    println!(
        "reflex: {} (an agent's act: {})",
        to_hex(&reflex_bytes),
        to_hex(&act_bytes)
    );
}

/// #3695: over the frame limit, only a creator's edit is read (a landform's ground tiles), up to `BULK_MOST`; the same
/// bytes from a Soul, or a creator's edit over `BULK_MOST`, are `intent-too-large`.
#[test]
fn a_creators_bulk_edit_is_read_over_the_frame_limit_and_nothing_else_is() {
    use replica::edit::wire::{VERB, parameters};
    use replica::edit::{Op, Ref};
    use replica::effects::Actor;
    use replica::encode::Name;
    use replica::ids::{Id, Scope, Version};
    use replica::intents::BULK_MOST;
    let ground = Id::new(Scope([0x0a; 16]), 3).expect("an id");
    let edit = |actor: Actor, bytes: usize| {
        let ops = [Op::Set {
            node: Ref::Node(ground),
            field: 25,
            to: Value::Array(vec![Value::Bytes(vec![7; bytes])]),
        }];
        let i = Intent {
            actor,
            verb: Name::new(VERB).expect("a name"),
            target: None,
            parameters: parameters(&ops),
            sequence: 1,
            basis: Version {
                lineage: Scope([0x0a; 16]),
                zone: Id::new(Scope([0x0a; 16]), 0).expect("an id"),
                epoch: 1,
                sequence: 1,
            }
            .to_value(),
            expiry: i64::MAX,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        encode(&i.to_value()).expect("bytes")
    };
    let creator = Actor::Creator(Id::new(Scope([0xc0; 16]), 1).expect("an id"));
    let soul = Actor::Soul(Id::new(Scope([0x50; 16]), 1).expect("an id"));
    let tiles = edit(creator, 64 << 10);
    assert!(tiles.len() as u64 > INTENT_MOST);
    let read = Intent::read(&tiles).expect("a creator's bulk edit is read");
    assert_eq!(read.actor, creator);
    let r = Intent::read(&edit(soul, 64 << 10)).map_err(|r| r.name);
    assert_eq!(r.err(), Some("intent-too-large"), "a Soul's is not");
    let over = edit(creator, usize::try_from(BULK_MOST).expect("small"));
    assert_eq!(
        Intent::read(&over).map_err(|r| r.name).err(),
        Some("intent-too-large")
    );
    // The gateway's creator route reads it the same way; its socket keeps the frame limit.
    assert!(replica::intent_decode::decode_bulk(&tiles).is_ok());
    assert_eq!(
        replica::intent_decode::decode(&tiles)
            .map_err(|r| r.name)
            .err(),
        Some("intent.too-large")
    );
}

#[test]
fn a_refusals_detail_is_printable_one_line_and_at_most_240_bytes_cut_at_a_character() {
    use replica::intents::{Answer, DETAIL_MOST, answer_detail};
    assert_eq!(answer_detail(""), None);
    assert_eq!(answer_detail(" \n\t "), None, "nothing printable left");
    assert_eq!(
        answer_detail("too far:\nwalk\tup\u{7}first").as_deref(),
        Some("too far: walk up first"),
        "control characters are spaces"
    );
    // 239 ASCII bytes and a two-byte µ: the µ would end at byte 241, so it is left out whole.
    let cut = answer_detail(&format!("{}µm", "a".repeat(DETAIL_MOST - 1))).unwrap();
    assert_eq!(cut.len(), DETAIL_MOST - 1);
    assert!(cut.chars().all(|c| c == 'a'));
    // 238 bytes and a µ fit exactly.
    let fits = answer_detail(&format!("{}µ", "a".repeat(DETAIL_MOST - 2))).unwrap();
    assert_eq!(fits.len(), DETAIL_MOST);
    // A refusal with one carries it as field 8, bytes; without one, no field 8.
    let fields = |detail| match (Answer::Refused {
        actor: replica::effects::Actor::World,
        sequence: 1,
        reason: replica::encode::Name::new("together.too-far").unwrap(),
        now: Value::Uint(0),
        changed: Vec::new(),
        op: None,
        detail,
    })
    .to_value()
    {
        Value::Map(m) => m,
        _ => panic!("a map"),
    };
    assert_eq!(
        fields(answer_detail("2 m apart")).get(&8),
        Some(&Value::Bytes(b"2 m apart".to_vec()))
    );
    assert!(!fields(None).contains_key(&8));
}
