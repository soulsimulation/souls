//! Audience and removing words (Engine v2 T8, #2662; `v2/docs/audience.md`): a removed sentence is absent from every
//! view while the log's bytes and hashes stay, a fork through one creator holds nothing of another's, no fixture holds
//! an account id or words, and a principal who joins later does not see what was written before.

use std::collections::BTreeSet;

use replica::audience::{
    Rule, TextStore, audiences_of, deliver, fork, members, references, remove, resolve, same_line,
    sees,
};
use replica::effects::{FIXTURE_HEADER, FIXTURES, Header, Part, State, fixture_bytes, texts};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope};
use replica::views::{Key, Level, ORDER, Redactions, build, entry_part};
use replica::world_model::{Audience, show};

const HEADER: &str = include_str!("../fixtures/audience/header.diag");
const LOG: &str = include_str!("../fixtures/audience/log.diag");

/// What the board says, what is said aloud and what is whispered: the stand-in for K16's store. Never in a fixture.
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
    let start = State::start(header.zone, header.kinds[0].clone());
    let part = Part::read(&fixture_bytes(LOG).expect("bytes")).expect("a part");
    let mut states = vec![start.clone()];
    for e in &part.effects {
        let mut s = states.last().expect("a state").clone();
        s.apply(&header, &entry_part(&header, e).expect("a part"))
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

/// Each reference's words, kept for the audience of the entry that first carried it.
fn store() -> TextStore {
    let mut s = TextStore::default();
    s.keep(id(0xcc, 1), Audience::Everyone, BOARD);
    s.keep(id(0xcc, 2), Audience::Everyone, ALOUD);
    s.keep(id(0xcc, 3), Audience::Of(id(0xdd, 101)), WHISPER);
    s
}

fn holds(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

fn audiences() -> Vec<Audience> {
    vec![
        Audience::Everyone,
        Audience::Of(id(0x77, 1)),
        Audience::Of(id(0x88, 1)),
        Audience::Of(id(0xee, 8)),
        Audience::Of(id(0xee, 13)),
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
    let keys = keys();
    let parts = std::slice::from_ref(&l.part);
    let views = build(&l.start, &l.header, parts, &keys, &before).expect("views");
    let end = l.states.last().expect("a state");
    let delivered =
        |v, list: &Redactions, w: &TextStore| deliver(v, w, list, end).expect("delivered");
    let shown = views
        .iter()
        .filter(|v| holds(&delivered(v, &before, &words), BOARD))
        .count();
    println!(
        "before removal: {shown} of {} views deliver the board's words",
        views.len()
    );
    assert!(shown > 0);
    assert!(
        views
            .iter()
            .all(|v| !holds(&v.bytes().expect("bytes"), BOARD))
    );
    // The whisper's words go only to its own audience, though a public record (seq 13, which the commit refuses as
    // `reference-audience`) names its reference.
    let mut heard = 0;
    for v in &views {
        if holds(&delivered(v, &before, &words), WHISPER) {
            assert_eq!(v.key.audience, Audience::Of(id(0xdd, 101)), "{:?}", v.key);
            heard += 1;
        }
    }
    println!("the whisper's words reach {heard} views, every one dd:101's");
    assert!(heard > 0);

    // The log is not an input to removal, so it cannot change; its bytes and hashes are compared anyway.
    let hashes = |l: &Log| {
        (
            Hash::of(Purpose::Fixture, l.part.stored()),
            l.header.hash(),
            l.states.last().expect("a state").hash().expect("a hash"),
        )
    };
    let was = hashes(&l);
    let after = remove(id(0xcc, 1), &mut words, &before);
    let l2 = log();
    let now = hashes(&l2);
    println!(
        "the log before and after removal: part {} / {}, header {} / {}, state {} / {}",
        was.0, now.0, was.1, now.1, was.2, now.2
    );
    assert_eq!(was, now);
    let views = build(&l2.start, &l2.header, parts, &keys, &after).expect("views");
    let mut marked = 0;
    for v in &views {
        assert!(!holds(&delivered(v, &after, &words), BOARD), "{:?}", v.key);
        if references(&v.to_value()).contains(&id(0xcc, 1)) {
            marked += 1;
        }
    }
    println!(
        "after removal: 0 of {} views deliver it; {marked} name its reference, marked removed",
        views.len()
    );
    assert!(marked > 0);
    assert!(
        views
            .iter()
            .any(|v| holds(&delivered(v, &after, &words), ALOUD))
    );
    // A list older than the view's never undoes a removal.
    assert_eq!(
        deliver(&views[0], &words, &before, end).map_err(|r| r.name),
        Err("redactions-differ")
    );
}

#[test]
fn a2_a_fork_through_creator_x_holds_nothing_of_creator_y_nor_the_removed_sentence() {
    let l = log();
    let mut words = store();
    let removed = remove(id(0xcc, 1), &mut words, &Redactions::default());
    let checkpoint = l.states.last().expect("a state");
    let x = fork(checkpoint, id(0x77, 1), &removed);
    let y = fork(checkpoint, id(0x88, 1), &removed);
    let ids = |s: &State| s.nodes.keys().map(|i| show(*i)).collect::<Vec<_>>();
    println!("fork through X: nodes {:?}", ids(&x));
    println!("fork through Y: nodes {:?}", ids(&y));
    assert!(x.nodes.contains_key(&id(0xee, 6)) && !x.nodes.contains_key(&id(0xee, 7)));
    assert!(y.nodes.contains_key(&id(0xee, 7)) && !y.nodes.contains_key(&id(0xee, 6)));
    // No body (a Soul is in one world) and no hand of a game the creator does not play.
    for f in [&x, &y] {
        assert!(!f.nodes.contains_key(&id(0xee, 2)));
        assert!(!f.nodes.contains_key(&id(0xee, 16)));
        assert!(f.links.values().all(|l| l.ty.as_str() != "souls:body-of"));
    }
    assert!(!holds(&encode(&x.to_value()).expect("bytes"), BOARD));
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
    // The fixtures' scopes: the world's, Souls', two creators' principals, and references. An account's is none.
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
        let mut stack = vec![&v];
        while let Some(v) = stack.pop() {
            match v {
                Value::Bytes(x) if x.len() == 16 => {
                    assert!(
                        x.iter().all(|c| *c == x[0]) && known.contains(&x[0]),
                        "{x:?}"
                    );
                    ids += 1;
                }
                Value::Bytes(x) => assert_eq!(x.len(), 34, "a byte string not an id or a hash"),
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
    let (a, b) = (id(0xdd, 100), id(0xdd, 101));
    let end = l.states.last().expect("a state");
    let (old, new) = (Audience::Of(id(0xee, 8)), Audience::Of(id(0xee, 13)));
    let names = |m: Option<BTreeSet<Id>>| {
        m.unwrap_or_default()
            .into_iter()
            .map(show)
            .collect::<Vec<_>>()
    };
    println!(
        "the first hand's audience ee:8: {:?}; after dd:101 joins, the new hand's ee:13: {:?}",
        names(members(old, end)),
        names(members(new, end))
    );
    // Members are written once, with the audience: joining never adds 101 to ee:8.
    assert!(sees(a, old, end) && !sees(b, old, end));
    assert!(sees(a, new, end) && sees(b, new, end));
    // What 101 is sent: the views of its audiences, none of which holds the first deal (seq 5).
    let keys: Vec<Key> = audiences_of(b, end)
        .into_iter()
        .map(|audience| Key {
            node: id(0xee, 4),
            level: Level::Full,
            audience,
        })
        .collect();
    let parts = std::slice::from_ref(&l.part);
    let views = build(&l.start, &l.header, parts, &keys, &Redactions::default()).expect("views");
    let seqs: Vec<u64> = views
        .iter()
        .flat_map(|v| v.records.iter())
        .filter_map(|(_, r)| match r {
            Value::Map(m) => match m.get(&1) {
                Some(Value::Uint(n)) => Some(*n),
                _ => None,
            },
            _ => None,
        })
        .collect();
    println!("dd:101 is sent the table's entries {seqs:?}");
    assert!(
        !seqs.contains(&5),
        "101 joined at seq 9 and must not see the first deal"
    );
    assert!(seqs.contains(&11) && seqs.contains(&12));
    // The two players' audiences are one line: a reference written for ee:8 is delivered to ee:13's members too.
    assert!(same_line(old, new, end) && !same_line(old, Audience::Everyone, end));
    // The whisper's audience is one: 101 reads it back, 100 does not.
    let whisper = Audience::Of(b);
    assert!(sees(b, whisper, &l.states[8]) && !sees(a, whisper, &l.states[8]));
    // The one resolver: the players are ee:8 before 101 joins and ee:13 after; the owner has no audience yet.
    let table = id(0xee, 4);
    let creator = id(0x77, 1);
    let player = Rule::Linked(Name::new("souls:player").expect("a name"));
    assert_eq!(resolve(&player, table, &l.states[9], creator), Ok(old));
    assert_eq!(resolve(&player, table, end, creator), Ok(new));
    assert_eq!(
        resolve(&Rule::Creator, table, end, creator),
        Ok(Audience::Of(creator))
    );
    assert_eq!(
        resolve(&Rule::Everyone, table, end, creator),
        Ok(Audience::Everyone)
    );
    assert_eq!(
        resolve(&Rule::Owner, table, end, creator).map_err(|r| r.name),
        Err("audience-not-declared")
    );
}
