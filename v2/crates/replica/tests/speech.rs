//! The utterance record (Engine v2 B11, #2742): after a sentence is removed (T8) its event is still in the views and
//! its words are in none; reach and audience are two fields, and ordinary talk is public.

use std::collections::BTreeSet;

use replica::audience::{TextStore, deliver, references, remove};
use replica::effects::{Header, Part, State, fixture_bytes};
use replica::encode::decode;
use replica::ids::{Id, Scope};
use replica::speech::{SAID, Said, length_of};
use replica::views::{Key, Level, Redactions, build, entry_part};
use replica::world_model::{Audience, show};

const HEADER: &str = include_str!("../fixtures/audience/header.diag");
const LOG: &str = include_str!("../fixtures/audience/log.diag");
const ALOUD: &str = "hello everyone";

fn id(scope: u8, counter: u64) -> Id {
    Id::new(Scope([scope; 16]), counter).expect("an id")
}

fn holds(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[test]
fn a4_a5_a_removed_sentence_leaves_its_event_in_the_views_and_its_words_in_none() {
    let header = Header::read(&fixture_bytes(HEADER).expect("bytes")).expect("a header");
    let start = State::start(header.zone, header.kinds[0].clone());
    let mut part = Part::read(&fixture_bytes(LOG).expect("bytes")).expect("a part");
    // T8's fixture says something aloud at seq 7; it becomes an utterance as B11 writes it, heard by two Souls.
    let said = Said {
        words: id(0xcc, 2),
        reach_mm: 5_000,
        audience: Audience::Everyone,
        hearers: BTreeSet::from([id(0xdd, 100), id(0xdd, 101)]),
        length: length_of(ALOUD),
    };
    let entry = part
        .effects
        .iter_mut()
        .find(|e| e.envelope.sequence == 7)
        .expect("seq 7");
    assert_eq!(
        entry.envelope.audience, said.audience,
        "ordinary talk is public"
    );
    entry.events = Some(vec![said.event()]);
    let mut end = start.clone();
    for e in &part.effects {
        end.apply(&header, &entry_part(&header, e).expect("a part"))
            .expect("applies");
    }
    let keys: Vec<Key> = [Level::Full, Level::Sampled]
        .into_iter()
        .map(|level| Key {
            node: id(0xee, 2),
            level,
            audience: Audience::Everyone,
        })
        .collect();
    let mut words = TextStore::default();
    words.keep(said.words, Audience::Everyone, ALOUD);
    let parts = std::slice::from_ref(&part);

    let before = Redactions::default();
    let views = build(&start, &header, parts, &keys, &before).expect("views");
    for v in &views {
        assert!(holds(
            &deliver(v, &words, &before, &end).expect("delivered"),
            ALOUD
        ));
    }

    let after = remove(said.words, &mut words, &before);
    let views = build(&start, &header, parts, &keys, &after).expect("views");
    let mut kept = 0;
    for v in &views {
        let bytes = deliver(v, &words, &after, &end).expect("delivered");
        assert!(!holds(&bytes, ALOUD), "{:?}", v.key);
        assert!(holds(&bytes, SAID), "the event stays: {:?}", v.key);
        assert!(references(&v.to_value()).contains(&said.words));
        kept += 1;
    }
    println!(
        "A4: after removing {}, {kept} of {} views still hold the souls:said event and its reference; \
         0 deliver its words",
        show(said.words),
        views.len()
    );

    // A5: the event's fields carry the reach and the hearers; who may read it is the entry's audience.
    let back = Said::read(
        &decode(&replica::encode::encode(&said.event().to_value()).expect("encodes"))
            .expect("decodes")
            .value,
        Audience::Everyone,
    )
    .expect("an utterance");
    assert_eq!(back, said);
    println!(
        "A5: souls:said fields {:?}; audience {:?} from the entry",
        said.event().fields.keys().collect::<Vec<_>>(),
        back.audience
    );
}
