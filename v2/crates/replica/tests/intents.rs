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
