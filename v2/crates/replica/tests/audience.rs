//! Audience and removing words (Engine v2 T8, #2662; `v2/docs/audience.md`): a removed sentence is absent from every
//! view while the log's bytes and hashes stay, a fork through one creator holds nothing of another's, no fixture holds
//! an account id or words, and a principal who joins later does not see what was written before.

use std::collections::BTreeSet;

use replica::audience::{
    Rule, TextStore, deliver, fork, members, references, remove, resolve, sees,
};
use replica::effects::{FIXTURE_HEADER, FIXTURES, Header, Part, State, fixture_bytes, texts};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope};
use replica::views::{Key, ORDER, Redactions, build};
use replica::world_model::Audience;

const HEADER: &str = include_str!("../fixtures/audience/header.diag");
const LOG: &str = include_str!("../fixtures/audience/log.diag");

/// What the board says, aloud and in a whisper: the stand-in for K16's store. Never in a fixture.
const BOARD: &str = "meet me at the well at noon";
const ALOUD: &str = "hello everyone";
const WHISPER: &str = "the key is under the mat";

fn id(scope: u8, counter: u64) -> Id {
    Id::new(IdScope([scope; 16]), counter).expect("an id")
}

struct Log {
    header: Header,
    start: State,
    part: Part,
    /// The state just before each entry, and after the last.
    states: Vec<State>,
}

fn log() -> Log {
    let header = Header::read(&fixture_bytes(HEADER).expect("bytes")).expect("a header");
    let root = header.kinds[0].clone();
    let start = State::start(header.zone, root);
    let part = Part::read(&fixture_bytes(LOG).expect("bytes")).expect("a part");
    let mut states = vec![start.clone()];
    for e in &part.effects {
        let mut s = states.last().expect("a state").clone();
        s.apply(
            &header,
            &replica::views::entry_part(&header, e).expect("a part"),
        )
        .expect("applies");
        states.push(s);
    }
    Log {
        header,
        start,
        part,
        states,
    }
}

fn store() -> TextStore {
    let mut s = TextStore::default();
    s.keep(id(0xcc, 1), BOARD);
    s.keep(id(0xcc, 2), ALOUD);
    s.keep(id(0xcc, 3), WHISPER);
    s
}

fn holds(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

/// Every audience in the log, and everyone.
fn audiences() -> Vec<Audience> {
    vec![
        Audience::Everyone,
        Audience::Of(id(0x77, 1)),
        Audience::Of(id(0x88, 1)),
        Audience::Of(id(0xee, 8)),
        Audience::Of(id(0xdd, 101)),
    ]
}

fn keys() -> Vec<Key> {
    let mut keys = Vec::new();
    for node in [
        id(0xee, 0),
        id(0xee, 1),
        id(0xee, 2),
        id(0xee, 4),
        id(0xee, 5),
    ] {
        for level in ORDER {
            for audience in audiences() {
                keys.push(Key {
                    node,
                    level,
                    audience,
                });
            }
        }
    }
    keys
}

#[test]
fn step0_no_fixture_of_t6_holds_free_text() {
    let mut n = 0;
    for (_, text) in FIXTURES.iter().chain([("header", FIXTURE_HEADER)].iter()) {
        let v = decode(&fixture_bytes(text).expect("bytes"))
            .expect("decodes")
            .value;
        for t in texts(&v) {
            assert!(
                Name::new(&t).is_some() && !t.contains(' '),
                "free text in T6: {t}"
            );
            n += 1;
        }
    }
    println!(
        "Step 0: T6's {} fixtures hold {n} text items, every one a name",
        FIXTURES.len() + 1
    );
}

#[test]
fn a1_a_removed_sentence_is_absent_from_every_view_and_the_log_is_unchanged() {
    let l = log();
    let mut words = store();
    let before = Redactions::default();
    let log_hash = |l: &Log| {
        (
            Hash::of(Purpose::Fixture, l.part.stored()),
            l.header.hash(),
            l.states.last().expect("a state").hash().expect("a hash"),
        )
    };
    let was = log_hash(&l);
    let keys = keys();
    let views = build(
        &l.start,
        &l.header,
        std::slice::from_ref(&l.part),
        &keys,
        &before,
    )
    .expect("views");
    let shown = views
        .iter()
        .filter(|v| holds(&deliver(v, &words, &before).expect("delivered"), BOARD))
        .count();
    println!(
        "before removal: {shown} of {} views deliver the board's words",
        views.len()
    );
    assert!(shown > 0);
    assert!(
        views
            .iter()
            .all(|v| !holds(&v.bytes().expect("bytes"), BOARD)),
        "a view holds words"
    );

    let after = remove(id(0xcc, 1), &mut words, &before);
    let l2 = log();
    let now = log_hash(&l2);
    println!(
        "the log before and after: part {} / {}, header {} / {}, state {} / {}",
        was.0, now.0, was.1, now.1, was.2, now.2
    );
    assert_eq!(was, now);
    assert_eq!(l.part.stored(), l2.part.stored());
    let views = build(
        &l2.start,
        &l2.header,
        std::slice::from_ref(&l2.part),
        &keys,
        &after,
    )
    .expect("views");
    let mut marked = 0;
    for v in &views {
        let d = deliver(v, &words, &after).expect("delivered");
        assert!(
            !holds(&d, BOARD),
            "{:?} still delivers the removed words",
            v.key
        );
        let out = v.to_value();
        if references(&out).contains(&id(0xcc, 1)) {
            marked += 1;
        }
    }
    println!(
        "after removal: 0 of {} views deliver it; {marked} name its reference, marked removed; the other words stay",
        views.len()
    );
    assert!(
        views
            .iter()
            .any(|v| holds(&deliver(v, &words, &after).unwrap(), ALOUD))
    );
    assert!(words.words(id(0xcc, 1)).is_none());
}

#[test]
fn a2_a_fork_through_creator_x_holds_nothing_of_creator_y_nor_the_removed_sentence() {
    let l = log();
    let mut words = store();
    let removed = remove(id(0xcc, 1), &mut words, &Redactions::default());
    let checkpoint = l.states.last().expect("a state");
    let x = fork(checkpoint, id(0x77, 1), &removed);
    let y = fork(checkpoint, id(0x88, 1), &removed);
    let ids = |s: &State| {
        s.nodes
            .keys()
            .map(|i| replica::world_model::show(*i))
            .collect::<Vec<_>>()
    };
    println!("fork through X: nodes {:?}", ids(&x));
    println!("fork through Y: nodes {:?}", ids(&y));
    assert!(x.nodes.contains_key(&id(0xee, 6)) && !x.nodes.contains_key(&id(0xee, 7)));
    assert!(y.nodes.contains_key(&id(0xee, 7)) && !y.nodes.contains_key(&id(0xee, 6)));
    // No body (a Soul is in one world) and no hand of a game X does not play.
    for f in [&x, &y] {
        assert!(!f.nodes.contains_key(&id(0xee, 2)));
        assert!(!f.nodes.contains_key(&id(0xee, 10)));
        assert!(f.links.values().all(|l| l.ty.as_str() != "souls:body-of"));
    }
    let bytes = encode(&x.to_value()).expect("bytes");
    assert!(!holds(&bytes, BOARD));
    let board = &x.nodes[&id(0xee, 5)].fields[&2];
    println!("the board in X's fork: {board:?}");
    let Value::Map(m) = board else {
        panic!("a reference")
    };
    assert_eq!(m.get(&22), Some(&Value::Uint(1)), "marked removed");
}

#[test]
fn a3_no_fixture_holds_an_account_id_or_free_text_inline() {
    let bytes = [
        fixture_bytes(HEADER).expect("bytes"),
        fixture_bytes(LOG).expect("bytes"),
    ];
    let known: BTreeSet<u8> = [0xee, 0xdd, 0x77, 0x88, 0xcc].into();
    let (mut items, mut ids) = (0, 0);
    for b in &bytes {
        let v = decode(b).expect("decodes").value;
        for t in texts(&v) {
            assert!(
                Name::new(&t).is_some() && !t.contains(' '),
                "free text: {t}"
            );
            items += 1;
        }
        // Every byte string is an id's scope (16 bytes) of a known kind of principal or thing, or a hash (34).
        let mut stack = vec![&v];
        while let Some(v) = stack.pop() {
            match v {
                Value::Bytes(x) if x.len() == 16 => {
                    assert!(
                        x.iter().all(|c| *c == x[0]) && known.contains(&x[0]),
                        "an unknown scope {x:?}"
                    );
                    ids += 1;
                }
                Value::Bytes(x) => {
                    assert_eq!(x.len(), 34, "a byte string that is not an id or a hash")
                }
                Value::Array(a) => stack.extend(a),
                Value::Map(m) => stack.extend(m.values()),
                _ => {}
            }
        }
        for w in [BOARD, ALOUD, WHISPER] {
            assert!(!holds(b, w), "words in a fixture");
        }
    }
    println!(
        "{items} text items, every one a name; {ids} ids, each a world's, a Soul's, a creator's or a reference's; no words"
    );
}

#[test]
fn a4_a_principal_added_later_does_not_see_what_was_written_before() {
    let l = log();
    let hand = Audience::Of(id(0xee, 8));
    let (dealt_first, dealt_later) = (5_usize, 10_usize);
    let before_first = &l.states[dealt_first];
    let before_later = &l.states[dealt_later];
    let (a, b) = (id(0xdd, 100), id(0xdd, 101));
    let show = |m: Option<BTreeSet<Id>>| {
        m.unwrap_or_default()
            .into_iter()
            .map(replica::world_model::show)
            .collect::<Vec<_>>()
    };
    println!(
        "the hand's audience when seq 5 was written: {:?}; when seq 10 was: {:?}",
        show(members(hand, before_first)),
        show(members(hand, before_later))
    );
    assert!(sees(a, hand, before_first) && sees(a, hand, before_later));
    assert!(
        !sees(b, hand, before_first),
        "101 joined at seq 9 and must not see seq 5"
    );
    assert!(sees(b, hand, before_later));
    // Read now, membership would wrongly show 101 the first deal.
    assert!(sees(b, hand, l.states.last().expect("a state")));
    // The whisper's audience is one: 101 hears it, 100 does not read it back.
    let whisper = Audience::Of(b);
    assert!(sees(b, whisper, &l.states[8]) && !sees(a, whisper, &l.states[8]));
    // The one resolver.
    let at = l.states.last().expect("a state");
    let table = id(0xee, 4);
    let player = Rule::Linked(Name::new("souls:player").expect("a name"));
    assert_eq!(resolve(&player, table, at, id(0x77, 1)), Ok(hand));
    assert_eq!(
        resolve(&Rule::Creator, table, at, id(0x77, 1)),
        Ok(Audience::Of(id(0x77, 1)))
    );
    assert_eq!(
        resolve(&Rule::Everyone, table, at, id(0x77, 1)),
        Ok(Audience::Everyone)
    );
    assert_eq!(
        resolve(&Rule::Owner, table, at, id(0x77, 1)).map_err(|r| r.name),
        Err("audience-not-declared")
    );
}
