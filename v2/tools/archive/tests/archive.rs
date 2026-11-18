//! V3's acceptance (#2712) on W8's in-memory store: restore from archive objects alone (A1), bundles made again equal
//! the stored ones (A2), no words in objects or bundles (A4), and entry one of V18's corpus decodes (A5). The run
//! against an S3-compatible stand-in over HTTP is `cargo run -p archive -- prove` (`v2/docs/archive.md`).

use archive::script::{self, SAID};
use archive::{
    Archiver, Segment, fetch, rebuild_bundles, restore, state_hash, stored_bundles, words,
    words_in_bundle, words_in_object,
};
use directoryd::directory::store::{Memory, Store};
use replica::effects::{Header, schema_hash};
use replica::encode::{decode, to_hex};
use replica::history::Bundle;
use std::cell::RefCell;
use std::rc::Rc;

const PREFIX: &str = "worlds/test/";

/// A small world over two world days: ticks a second apart for twelve minutes (three windows), then a few the next
/// day; small objects so there are several. Returns the store and the live state hash.
fn recorded() -> (Memory, String) {
    let store = Memory::default();
    let queue = Rc::new(RefCell::new(Vec::<Vec<u8>>::new()));
    let q = queue.clone();
    let mut w = script::world(
        3,
        10,
        Some(Box::new(move |b: &[u8]| q.borrow_mut().push(b.to_vec()))),
    );
    for t in (0..720u64).chain(86_400..86_430) {
        script::tick(&mut w, t * 20, 5, 7 * 20);
    }
    let root = w.tree.node(w.tree.root()).expect("root").id();
    let kind = w.tree.node(w.tree.root()).expect("root").kind().clone();
    let mut a = Archiver::open(&store, PREFIX, &w.header, root, kind).expect("opens");
    a.packer.set_target(20_000);
    for (n, p) in queue.borrow_mut().drain(..).enumerate() {
        a.push(n as u64, p).expect("archives");
    }
    a.flush().expect("flushes");
    (store, state_hash(&mut w.tree).expect("hash"))
}

#[test]
fn a1_a_world_rebuilt_from_archive_objects_alone_reaches_the_recorded_hash() {
    let (store, live) = recorded();
    let f = fetch(&store, PREFIX).expect("fetched");
    assert!(f.manifests.len() == 2, "two days, two manifests");
    assert!(f.segments.len() > 2, "several objects");
    let mut tree = restore(&f).expect("restored");
    assert_eq!(state_hash(&mut tree).expect("hash"), live);
}

#[test]
fn a2_bundles_made_again_from_the_archive_equal_the_stored_ones() {
    let (store, _) = recorded();
    let f = fetch(&store, PREFIX).expect("fetched");
    let stored = stored_bundles(&store, PREFIX, &f).expect("stored");
    let again = rebuild_bundles(&f).expect("made again");
    assert!(
        stored.len() >= 4,
        "three windows the first day, one the next"
    );
    let h = |b: &[Bundle]| b.iter().map(|b| to_hex(&b.hash())).collect::<Vec<_>>();
    assert_eq!(h(&stored), h(&again));
}

#[test]
fn a4_objects_and_bundles_hold_text_references_and_no_words() {
    let (store, _) = recorded();
    let keys = store.keys();
    let (mut objects, mut bundles, mut refs) = (0, 0, 0);
    for k in &keys {
        let bytes = store.get(k).expect("get").expect("there").bytes;
        if k.contains("archive/obj/") {
            assert_eq!(
                words_in_object(&bytes, &SAID).expect("scans"),
                Vec::<String>::new(),
                "{k}"
            );
            let body = Segment::body(&bytes).expect("body");
            refs += replica::audience::references(&decode(&body).expect("cbor").value).len();
            for r in Segment::read(&bytes).expect("object").records {
                refs += replica::audience::references(&decode(&r).expect("cbor").value).len();
            }
            objects += 1;
        } else if k.contains("bundles/") && !k.ends_with("/index") {
            assert_eq!(
                words_in_bundle(&bytes, &SAID).expect("scans"),
                Vec::<String>::new(),
                "{k}"
            );
            refs += replica::audience::references(&decode(&bytes).expect("cbor").value).len();
            bundles += 1;
        }
    }
    assert!(
        objects > 0 && bundles > 0 && refs > 0,
        "{objects} {bundles} {refs}"
    );
    // The scan finds words when they are there.
    let planted = format!("xx{}xx", SAID[0]);
    let v = replica::encode::Value::Map(
        [
            (21, script::reference(0)),
            (
                23,
                replica::encode::Value::Bytes(SAID[0].as_bytes().to_vec()),
            ),
        ]
        .into(),
    );
    assert_eq!(words(&v, planted.as_bytes(), &SAID).len(), 2);
}

/// Entry one of V18's corpus: `v2/tools/corpus/entries/1`.
const ENTRY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../corpus/entries/1");

fn hex(path: &str) -> Vec<u8> {
    let t = std::fs::read_to_string(format!("{ENTRY}/{path}")).expect("the corpus file");
    let t: String = t.split_whitespace().collect();
    (0..t.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&t[i..i + 2], 16).expect("hex"))
        .collect()
}

fn line<'a>(sheet: &'a str, key: &str) -> &'a str {
    sheet
        .lines()
        .find_map(|l| l.strip_prefix(&format!("{key}: ")))
        .unwrap_or_else(|| panic!("entry.txt lacks {key}"))
}

#[test]
fn a5_corpus_entry_one_decodes() {
    let sheet = std::fs::read_to_string(format!("{ENTRY}/entry.txt")).expect("entry.txt");
    let seg = Segment::read(&hex("segment.hex")).expect("the segment decodes");
    let header = Header::read(&seg.header).expect("its header");
    assert_eq!(line(&sheet, "build"), to_hex(&header.build));
    assert_eq!(line(&sheet, "schema"), to_hex(&header.schema));
    assert_eq!(line(&sheet, "schema"), to_hex(&schema_hash().to_bytes()));
    let kinds: Vec<&str> = header.kinds.iter().map(|k| k.as_str()).collect();
    assert_eq!(line(&sheet, "kinds"), kinds.join(" "));
    // Replayed from the root the sheet names, the segment reaches the state hash it names.
    let (root, kind) = (line(&sheet, "root"), line(&sheet, "root kind"));
    let root =
        replica::effects::read_id(&decode(&hex_str(root)).expect("an id").value).expect("an id");
    let mut tree =
        replica::tree::Tree::start(root, replica::encode::Name::new(kind).expect("a kind"));
    sim::checkpoint::replay(&mut tree, &header, &seg.records, 0).expect("replays");
    assert_eq!(
        line(&sheet, "state hash"),
        state_hash(&mut tree).expect("hash")
    );
    let bundle = Bundle::read(&hex("bundle.hex")).expect("the bundle decodes");
    assert_eq!(bundle.header, header.hash().to_bytes());
    assert!(bundle.records() > 0);
    assert_eq!(line(&sheet, "bundle sha256"), to_hex(&bundle.hash()));
}

fn hex_str(t: &str) -> Vec<u8> {
    (0..t.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&t[i..i + 2], 16).expect("hex"))
        .collect()
}
