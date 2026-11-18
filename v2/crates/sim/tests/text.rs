//! The text store (Engine v2 K16, #2677; `v2/crates/sim/src/text/mod.rs`): words written, read back by an entitled
//! reader and refused to anyone else; removed, and then absent from every view of T8's fixture log while the log's
//! bytes and hashes stay; and after power cuts, no returned reference without its words and the redaction list whole.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use replica::audience::{TextStore, deliver, references};
use replica::effects::{Header, Part, State, fixture_bytes};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::views::{Key, ORDER, Output, build, entry_part};
use replica::world_model::Audience;
use sim::log::{FileStore, Log, Mem};
use sim::text::{Grade, Store};

const HEADER: &str = include_str!("../../replica/fixtures/audience/header.diag");
const LOG: &str = include_str!("../../replica/fixtures/audience/log.diag");

/// The fixture log's three references hold these (T8's test keeps them in a stand-in; here they are in the store).
const BOARD: &str = "meet me at the well at noon";
const ALOUD: &str = "hello everyone";
const WHISPER: &str = "the key is under the mat";

fn id(scope: u8, counter: u64) -> Id {
    Id::new(Scope([scope; 16]), counter).expect("an id")
}

fn dir(name: &str) -> PathBuf {
    let d = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("k16-{name}"));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a folder");
    d
}

fn holds(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

fn name<T>(r: Result<T, replica::effects::Refusal>) -> Result<T, &'static str> {
    r.map_err(|e| e.name)
}

/// A1: a whisper is read back by its listener and refused by name to anyone else; public words are read by anyone.
#[test]
fn a1_written_words_are_read_back_by_their_audience_and_refused_to_others() {
    let store = Store::open_dir(&dir("a1"), Minter::new(Scope([0x5a; 16]))).expect("opens");
    let (speaker, listener, stranger) = (id(0xdd, 100), id(0xdd, 101), id(0xdd, 102));
    let aloud = store
        .write(ALOUD.as_bytes(), Audience::Everyone, speaker)
        .expect("written");
    let whisper = store
        .write(WHISPER.as_bytes(), Audience::Of(listener), speaker)
        .expect("written");
    assert_ne!(aloud, whisper);
    assert_eq!(name(store.read(aloud, &[stranger])), Ok(ALOUD.as_bytes().to_vec()));
    assert_eq!(
        name(store.read(whisper, &[listener])),
        Ok(WHISPER.as_bytes().to_vec())
    );
    assert_eq!(name(store.read(whisper, &[stranger])), Err("not-entitled"));
    assert_eq!(name(store.read(whisper, &[])), Err("not-entitled"));
    assert_eq!(name(store.read(id(0x5a, 99), &[listener])), Err("text-unknown"));
    // An upload is a file of its own, read the same way.
    let pic = store
        .upload(&[1, 2, 3, 250], Audience::Of(listener), speaker)
        .expect("uploaded");
    assert_eq!(name(store.read(pic, &[listener])), Ok(vec![1, 2, 3, 250]));
    assert_eq!(name(store.read(pic, &[stranger])), Err("not-entitled"));
    // Reopened, it reads the same and mints after what it holds.
    store.close();
    let store = Store::open_dir(&dir_keep("a1"), Minter::new(Scope([0x5a; 16]))).expect("reopens");
    assert_eq!(
        name(store.read(whisper, &[listener])),
        Ok(WHISPER.as_bytes().to_vec())
    );
    let next = store
        .write(b"again", Audience::Everyone, speaker)
        .expect("written");
    assert!(next.counter() > pic.counter());
}

fn dir_keep(name: &str) -> PathBuf {
    Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("k16-{name}"))
}

// --- T8's fixture log --------------------------------------------------------------------------------------------

struct Fixture {
    header: Header,
    start: State,
    part: Part,
    end: State,
}

fn fixture() -> Fixture {
    let header = Header::read(&fixture_bytes(HEADER).expect("bytes")).expect("a header");
    let start = State::start(header.zone, header.kinds[0].clone());
    let part = Part::read(&fixture_bytes(LOG).expect("bytes")).expect("a part");
    let mut end = start.clone();
    for e in &part.effects {
        end.apply(&header, &entry_part(&header, e).expect("a part"))
            .expect("applies");
    }
    Fixture {
        header,
        start,
        part,
        end,
    }
}

/// Every view of the fixture: five nodes, each level, each audience in it (T8's test's keys).
fn keys() -> Vec<Key> {
    let audiences = [
        Audience::Everyone,
        Audience::Of(id(0x77, 1)),
        Audience::Of(id(0x88, 1)),
        Audience::Of(id(0xee, 8)),
        Audience::Of(id(0xee, 13)),
        Audience::Of(id(0xdd, 101)),
    ];
    let mut keys = Vec::new();
    for node in [id(0xee, 0), id(0xee, 1), id(0xee, 2), id(0xee, 4), id(0xee, 5)] {
        for level in ORDER {
            for audience in audiences {
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

/// The views built with the store's redaction list, each delivered with the words the store's one read gives the
/// view's audience. No view opens the files.
fn delivered(f: &Fixture, store: &Store) -> Vec<(Output, Vec<u8>)> {
    let list = store.redactions();
    let views = build(
        &f.start,
        &f.header,
        std::slice::from_ref(&f.part),
        &keys(),
        &list,
    )
    .expect("views");
    views
        .into_iter()
        .map(|v| {
            let reader: Vec<Id> = match v.key.audience {
                Audience::Everyone => vec![],
                Audience::Of(a) => vec![a],
            };
            let mut words = TextStore::default();
            for r in references(&v.to_value()) {
                if let Ok(w) = store.read(r, &reader) {
                    words.keep(r, v.key.audience, std::str::from_utf8(&w).expect("utf-8"));
                }
            }
            let out = deliver(&v, &words, &list, &f.end).expect("delivered");
            (v, out)
        })
        .collect()
}

/// A2 and A3: the board's sentence, once erased, is "removed" in the store and absent from every view of T8's
/// fixture log built with the store's redaction list, and gone from the store's file; the log (the fixture's part, and
/// the same part written to a K4 log file) has the same bytes and hashes before and after.
#[test]
fn a2_a3_a_removed_sentence_is_absent_from_every_view_and_the_log_is_unchanged() {
    let f = fixture();
    let d = dir("a2");
    // The fixture's references are cc:1 to cc:3; the store mints them from that scope.
    let store = Store::open_dir(&d.join("text"), Minter::at(Scope([0xcc; 16]), 1)).expect("opens");
    let author = id(0x77, 1);
    let board = store
        .write(BOARD.as_bytes(), Audience::Everyone, author)
        .expect("written");
    let aloud = store
        .write(ALOUD.as_bytes(), Audience::Everyone, author)
        .expect("written");
    let whisper = store
        .write(WHISPER.as_bytes(), Audience::Of(id(0xdd, 101)), author)
        .expect("written");
    assert_eq!((board, aloud, whisper), (id(0xcc, 1), id(0xcc, 2), id(0xcc, 3)));

    // The log: the fixture's part, and the same bytes as the one record of a K4 log on disk.
    let path = d.join("log");
    let (mut log, _) = Log::open(FileStore::open(&path).expect("a file"), 1).expect("a log");
    let n = log.append(f.part.stored().to_vec()).expect("appended");
    log.wait_durable(n + 1).expect("durable");
    log.close();
    let hashes = |f: &Fixture| {
        let file = std::fs::read(&path).expect("the log file");
        (
            Hash::of(Purpose::Fixture, f.part.stored()),
            f.header.hash(),
            f.end.hash().expect("a hash"),
            Hash::of(Purpose::Fixture, &file),
            file.len(),
        )
    };
    let was = hashes(&f);

    let before = delivered(&f, &store);
    let shown = before.iter().filter(|(_, b)| holds(b, BOARD)).count();
    println!("before removal: {shown} of {} views deliver the board's words", before.len());
    assert!(shown > 0);
    assert!(before.iter().all(|(v, _)| !holds(&v.bytes().expect("bytes"), BOARD)));
    for (v, b) in &before {
        if holds(b, WHISPER) {
            assert_eq!(v.key.audience, Audience::Of(id(0xdd, 101)), "{:?}", v.key);
        }
    }
    assert!(before.iter().any(|(_, b)| holds(b, WHISPER)));

    store
        .remove(board, id(0xcc, 900), 1_700_000_000_000_000, Grade::Erased)
        .expect("removed");
    assert_eq!(name(store.read(board, &[])), Err("removed"));
    assert_eq!(name(store.read(aloud, &[])), Ok(ALOUD.as_bytes().to_vec()));
    let file = std::fs::read(d.join("text").join("text")).expect("the store's file");
    assert!(!holds(&file, BOARD), "the erased words are still in the store's file");
    assert!(holds(&file, ALOUD));

    let f2 = fixture();
    let now = hashes(&f2);
    println!(
        "the log before and after removal: part {} / {}, header {} / {}, state {} / {}, log file {} / {} ({} / {} bytes)",
        was.0, now.0, was.1, now.1, was.2, now.2, was.3, now.3, was.4, now.4
    );
    assert_eq!(was, now);

    let after = delivered(&f2, &store);
    let mut marked = 0;
    for (v, b) in &after {
        assert!(!holds(b, BOARD), "{:?}", v.key);
        if references(&v.to_value()).contains(&board) {
            marked += 1;
        }
    }
    println!(
        "after removal: 0 of {} views deliver it; {marked} name its reference, marked removed",
        after.len()
    );
    assert!(marked > 0);
    assert!(after.iter().any(|(_, b)| holds(b, ALOUD)));

    // Hidden words come back when restored; erased ones never do.
    store
        .remove(aloud, id(0xcc, 900), 1_700_000_000_000_001, Grade::Hidden)
        .expect("hidden");
    assert!(delivered(&f2, &store).iter().all(|(_, b)| !holds(b, ALOUD)));
    store.restore(aloud, id(0xcc, 900), 1_700_000_000_000_002).expect("restored");
    assert!(delivered(&f2, &store).iter().any(|(_, b)| holds(b, ALOUD)));
    assert_eq!(
        name(store.restore(board, id(0xcc, 900), 1_700_000_000_000_003)),
        Err("erased")
    );
    assert_eq!(store.removals().len(), 3);
}

// --- Power cuts ------------------------------------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

/// A5: 40 power cuts with four writers and removals under way. Odd seeds cut a write part way, even ones cut the
/// power while a sync is under way; the bytes after the last sync survive only as a random prefix. Reopened, every
/// reference that was returned reads back its words (or "removed", if it was), the redaction list holds every removal
/// that returned, in order, and no erased words are in the file.
#[test]
fn a5_after_power_cuts_every_returned_reference_has_its_words_and_the_list_is_whole() {
    let scope = Scope([0x5c; 16]);
    let listener = id(0xdd, 101);
    let (mut torn, mut erasures, mut checked) = (0, 0, 0);
    for seed in 1..=40u64 {
        let mut r = Rng(seed);
        let (text, list) = (Mem::default(), Mem::default());
        let store =
            Arc::new(Store::open_mem(text.clone(), list.clone(), Minter::new(scope)).expect("opens"));
        let stall = 2 + r.below(30);
        if seed % 2 == 1 {
            text.0.lock().unwrap().write_budget = Some(500 + r.below(20_000) as usize);
        } else {
            text.0.lock().unwrap().stall_sync = Some(stall);
        }
        let returned = Arc::new(Mutex::new(Vec::new()));
        let writers: Vec<_> = (0..4u64)
            .map(|t| {
                let (store, returned) = (store.clone(), returned.clone());
                std::thread::spawn(move || {
                    for i in 0..200u64 {
                        let words = format!("seed {seed} writer {t} line {i}.");
                        let audience = if i % 3 == 0 {
                            Audience::Of(listener)
                        } else {
                            Audience::Everyone
                        };
                        match store.write(words.as_bytes(), audience, id(0xdd, t)) {
                            Ok(r) => returned.lock().unwrap().push((r, words)),
                            Err(_) => return,
                        }
                    }
                })
            })
            .collect();
        // Removals while the writers run, each of a reference already returned.
        let mut removed = Vec::new();
        for k in 0..6u64 {
            let pick = {
                let got = returned.lock().unwrap();
                (!got.is_empty()).then(|| got[r.below(got.len() as u64) as usize].clone())
            };
            if let Some((reference, words)) = pick
                && !removed.iter().any(|(x, _, _)| *x == reference)
            {
                let grade = if k % 2 == 0 { Grade::Erased } else { Grade::Hidden };
                if store.remove(reference, id(0xaa, 1), k, grade).is_ok() {
                    removed.push((reference, words, grade));
                }
            }
            std::thread::yield_now();
        }
        let list_before = store.removals();
        if seed % 2 == 0 {
            while text.0.lock().unwrap().syncs < stall
                && writers.iter().any(|w| !w.is_finished())
            {
                std::thread::yield_now();
            }
        }
        let survived = {
            let mut disk = text.0.lock().unwrap();
            let unsynced = (disk.bytes.len() - disk.durable) as u64;
            let keep = r.below(unsynced + 1) as usize;
            if keep < unsynced as usize {
                torn += 1;
            }
            disk.power_cut(keep)
        };
        let list_survived = list.0.lock().unwrap().power_cut(usize::MAX);
        for w in writers {
            w.join().expect("a writer");
        }
        let returned = std::mem::take(&mut *returned.lock().unwrap());
        drop(store);

        let (text2, list2) = (Mem::with(survived), Mem::with(list_survived));
        let again = Store::open_mem(text2.clone(), list2, Minter::new(scope)).expect("reopens");
        assert_eq!(again.removals(), list_before, "seed {seed}: the redaction list");
        for (reference, words) in &returned {
            let got = name(again.read(*reference, &[listener]));
            match removed.iter().find(|(x, _, _)| x == reference) {
                Some(_) => assert_eq!(got, Err("removed"), "seed {seed}"),
                None => assert_eq!(got, Ok(words.as_bytes().to_vec()), "seed {seed}: {words}"),
            }
        }
        let bytes = text2.0.lock().unwrap().bytes.clone();
        for (_, words, grade) in &removed {
            if *grade == Grade::Erased {
                assert!(!holds(&bytes, words), "seed {seed}: erased words survive");
                erasures += 1;
            }
        }
        checked += returned.len();
    }
    println!("40 power cuts: {checked} returned references read back; {torn} cuts left a torn tail; {erasures} erasures checked");
    assert!(torn > 0 && checked > 0);
    assert!(erasures > 0);
}

/// A5, rule 6: an erasure cut between its two overwrites (zeros written, the checksum not yet) leaves a record that
/// does not check. Reopened, it is accepted because the list names it erased, the overwrite is finished, and the
/// records after it are read as before.
#[test]
fn a5_an_erasure_cut_short_is_finished_on_opening() {
    let scope = Scope([0x5d; 16]);
    let (text, list) = (Mem::default(), Mem::default());
    let store = Store::open_mem(text.clone(), list.clone(), Minter::new(scope)).expect("opens");
    let gone = store.write(BOARD.as_bytes(), Audience::Everyone, id(0xdd, 1)).expect("written");
    let kept = store.write(ALOUD.as_bytes(), Audience::Everyone, id(0xdd, 1)).expect("written");
    // The state after the list's entry and the zeros, before the checksum: built by hand from the bytes before.
    let mut half = text.0.lock().unwrap().bytes.clone();
    store.remove(gone, id(0xaa, 1), 7, Grade::Erased).expect("erased");
    let at = half
        .windows(BOARD.len())
        .position(|w| w == BOARD.as_bytes())
        .expect("the words");
    half[at..at + BOARD.len()].fill(0);
    let listed = list.0.lock().unwrap().bytes.clone();
    drop(store);

    let again = Store::open_mem(Mem::with(half), Mem::with(listed), Minter::new(scope)).expect("reopens");
    assert_eq!(name(again.read(gone, &[])), Err("removed"));
    assert_eq!(name(again.read(kept, &[])), Ok(ALOUD.as_bytes().to_vec()));
    // A record changed with no erasure listed and bytes after it is corruption, refused by name and not trimmed.
    let one = Mem::default();
    let s = Store::open_mem(one.clone(), Mem::default(), Minter::new(scope)).expect("opens");
    s.write(BOARD.as_bytes(), Audience::Everyone, id(0xdd, 1)).expect("written");
    s.write(ALOUD.as_bytes(), Audience::Everyone, id(0xdd, 1)).expect("written");
    drop(s);
    let mut bad = one.0.lock().unwrap().bytes.clone();
    let at = bad.windows(BOARD.len()).position(|w| w == BOARD.as_bytes()).expect("the words");
    bad[at] ^= 1;
    assert_eq!(
        name(Store::open_mem(Mem::with(bad), Mem::default(), Minter::new(scope)).map(|_| ())),
        Err("text-corrupt")
    );
}
