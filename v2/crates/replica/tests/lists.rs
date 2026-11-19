//! Lists and documents as state (Engine v2 F11, #2774): a kind's bounded `list` field, set whole by one generic set, and
//! a `text` field that holds a reference to its words (T8), capped in bytes by the kind. The kind is a souls-entry/1
//! entry written here, turned into K3's numbered form by `entry_to_kind` and loaded through `Kinds::load`.

use std::collections::BTreeMap;

use replica::audience::{TextStore, reference};
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Rest};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Minter, Scope};
use replica::kinds::entry::entry_to_kind;
use replica::kinds::{Field, KindDef, Kinds, Type};
use replica::views::Redactions;
use replica::world_model::Audience;

/// A board with up to 20 notes (each its number, colour and whether it is pinned) and a page of up to 4,000 bytes.
const BOARD: &str = r#"{
  "format": "souls-entry/1",
  "kind": "f11:board",
  "owner": "thing",
  "state": {
    "notes": { "n": 1, "type": "list", "most": 20, "key": "id", "default": [],
      "of": { "id": { "type": "int", "unit": "count" }, "colour": { "type": "enum", "values": ["yellow", "blue"] },
              "pinned": { "type": "bool" } },
      "audience": { "rule": "everyone" } },
    "page": { "n": 2, "type": "text", "most": 4000, "default": null, "audience": { "rule": "everyone" } }
  }
}"#;

fn board() -> KindDef {
    let text = entry_to_kind(BOARD).expect("converts");
    let mut kinds = Kinds::default();
    let names = kinds.load(&[("board.json", text.as_str())]);
    assert!(kinds.refused().is_empty(), "{:?}", kinds.refused());
    kinds.get(names[0].as_str()).expect("loaded").clone()
}

fn field(k: &KindDef, n: u64) -> &Field {
    k.state.get(&n).expect("a field")
}

/// One entry of the log: a generic set of `field` of `node` to `to`, by `actor`.
fn set(seq: u64, node: Id, field: u64, to: Value, actor: Actor) -> Effect {
    Effect {
        envelope: Envelope {
            sequence: seq,
            at: i64::try_from(seq).expect("small") * 1_000_000,
            cause: Cause::World,
            actor,
            audience: Audience::Everyone,
            node,
        },
        body: Body::Changes(vec![ChangeRec {
            change: Change::Set {
                node,
                field,
                to,
                by: None,
            },
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    }
}

fn bytes(e: &Effect) -> Vec<u8> {
    encode(&e.to_value()).expect("encodes")
}

fn note(i: u64) -> Value {
    let colour = if i.is_multiple_of(2) {
        "yellow"
    } else {
        "blue"
    };
    Value::Map(BTreeMap::from([
        (1, Value::Uint(i)),
        (2, Value::Text(Name::new(colour).expect("a name"))),
        (3, Value::Uint(i % 3 / 2)),
    ]))
}

#[test]
fn the_fields_load_with_their_bounds() {
    let k = board();
    let notes = field(&k, 1);
    let Type::List { most, of } = &notes.ty else {
        panic!("a list: {:?}", notes.ty)
    };
    assert_eq!(*most, 20);
    let names: Vec<_> = of.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["id", "colour", "pinned"]);
    assert_eq!(notes.default, Value::Array(Vec::new()));
    assert_eq!(field(&k, 2).ty, Type::Text { most: Some(4000) });
    assert_eq!(field(&k, 2).default, Value::Map(BTreeMap::new()));
    // A list of lists, or a record that holds text, is refused when the kind loads, by its section and field.
    for bad in [
        BOARD.replace(
            r#""pinned": { "type": "bool" }"#,
            r#""pinned": { "type": "list" }"#,
        ),
        BOARD.replace(
            r#""pinned": { "type": "bool" }"#,
            r#""pinned": { "type": "text" }"#,
        ),
        BOARD.replace(r#""most": 20"#, r#""most": 101"#),
    ] {
        let mut kinds = Kinds::default();
        kinds.load(&[("bad.json", entry_to_kind(&bad).expect("converts").as_str())]);
        let [e] = kinds.refused() else {
            panic!("refused once: {:?}", kinds.refused())
        };
        println!(
            "refused: {} {:?}/{:?}: {}",
            e.name, e.section, e.field, e.reason
        );
        assert_eq!(
            (e.name, e.section, e.field),
            ("kind-state", Some(3), Some(1))
        );
    }
}

#[test]
fn a3_a_board_takes_20_notes_and_refuses_the_21st_by_name() {
    let k = board();
    let notes = field(&k, 1);
    let mut mint = Minter::new(Scope([0xf1; 16]));
    let node = mint.mint().expect("an id");
    let soul = mint.mint().expect("an id");
    let mut list = notes.default.clone();
    let mut sizes = Vec::new();
    for i in 1..=20 {
        list = notes.add(&list, note(i)).expect("added");
        notes.check(&list).expect("a value of the field");
        // Each add is one generic set of the whole list: the entry's bytes are what the log and every view are sent.
        let e = set(i, node, 1, list.clone(), Actor::Soul(soul));
        sizes.push(bytes(&e).len());
    }
    let r = notes.add(&list, note(21)).expect_err("the 21st is refused");
    println!("{}: {}", r.name, r.detail);
    assert_eq!(r.name, "list-full");
    // A set of 21 records, written any other way, is refused by the same name when checked.
    let Value::Array(mut items) = list.clone() else {
        panic!("a list")
    };
    items.push(note(21));
    assert_eq!(
        notes.check(&Value::Array(items)).map_err(|r| r.name),
        Err("list-full")
    );
    let malformed = Value::Map(BTreeMap::from([(1, Value::Uint(1))]));
    assert_eq!(
        notes.add(&notes.default, malformed).map_err(|r| r.name),
        Err("list-record-malformed")
    );
    println!("bytes per add (the whole list's entry), adds 1 to 20: {sizes:?}");
    let step: Vec<usize> = sizes.windows(2).map(|w| w[1] - w[0]).collect();
    println!(
        "each note adds {}..{} bytes; the 20th add's entry is {} bytes",
        step.iter().min().expect("steps"),
        step.iter().max().expect("steps"),
        sizes[19]
    );
    assert!(sizes[19] < 512, "a full board's entry stays small");
}

#[test]
fn a4_a_pages_text_is_in_no_log_byte() {
    let k = board();
    let page = field(&k, 2);
    let mut mint = Minter::new(Scope([0xf1; 16]));
    let node = mint.mint().expect("an id");
    let soul = mint.mint().expect("an id");
    let mut store = TextStore::default();
    let words = [
        "Market on Saturday: bring the long tables to the square before nine.",
        "hello",
        "hello",
    ];
    let mut log = Vec::new();
    for (i, w) in (1u64..).zip(words) {
        // Every page's words get their own minted reference, so the same words twice are two references (T8 rule 7).
        let r = mint.mint().expect("an id");
        let to = page
            .keep(&mut store, r, Audience::Everyone, w)
            .expect("kept");
        page.check(&to).expect("a reference");
        assert_eq!(reference(&to), Some(r));
        log.push(set(i, node, 2, to, Actor::Soul(soul)));
    }
    let bytes: Vec<u8> = log.iter().flat_map(bytes).collect();
    let mut found = 0;
    for w in words {
        let w = w.as_bytes();
        found += bytes.windows(w.len()).filter(|x| *x == w).count();
        // Every word of three letters or more, alone, too.
        for word in std::str::from_utf8(w)
            .expect("text")
            .split(|c: char| !c.is_alphanumeric())
            .filter(|x| x.len() >= 3)
        {
            found += bytes
                .windows(word.len())
                .filter(|x| *x == word.as_bytes())
                .count();
        }
    }
    println!(
        "{} log bytes over {} pages; the pages' words found in them {found} times; the store holds {} texts",
        bytes.len(),
        log.len(),
        words.len()
    );
    assert_eq!(found, 0);
    // The words are in the store, each under its own reference; erasing one "hello" leaves the other.
    let refs: Vec<Id> = log
        .iter()
        .map(|e| match &e.body {
            Body::Changes(c) => match &c[0].change {
                Change::Set { to, .. } => reference(to).expect("a reference"),
                _ => panic!("a set"),
            },
            _ => panic!("changes"),
        })
        .collect();
    let redactions = replica::audience::remove(refs[1], &mut store, &Redactions::new([]));
    assert!(redactions.contains(refs[1]));
    assert_eq!(store.words(refs[1]), None);
    assert_eq!(store.words(refs[2]).map(|(_, w)| w), Some(&b"hello"[..]));
    // The words inline are refused, and a page over the kind's 4,000 bytes is refused and not kept.
    let inline = Value::Text(Name::new("hello").expect("a name"));
    assert_eq!(page.check(&inline).map_err(|r| r.name), Err("text-inline"));
    let long = "a".repeat(4001);
    let r = mint.mint().expect("an id");
    let refused = page.keep(&mut store, r, Audience::Everyone, &long);
    assert_eq!(refused.map_err(|r| r.name), Err("text-too-long"));
    assert_eq!(store.words(r), None);
}
