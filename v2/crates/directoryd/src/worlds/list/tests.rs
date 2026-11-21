//! W3's list and create on an in-memory store, with a starter that counts its forks.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use replica::encode::Name;
use replica::ids::{Id, Scope};

use super::*;
use crate::directory::store::{Memory, Object};

/// A store that counts its reads.
struct Counted<'a> {
    inner: &'a Memory,
    gets: &'a AtomicUsize,
}

impl Store for Counted<'_> {
    fn get(&self, key: &str) -> R<Option<Object>> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        self.inner.get(key)
    }
    fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
        self.inner.put(key, bytes, when)
    }
}

fn person(n: u8) -> Id {
    Id::new(Scope([n; 16]), 0).expect("an id")
}

fn worlds<'a>(
    store: &'a Memory,
    gets: &'a AtomicUsize,
    forks: Arc<AtomicUsize>,
) -> Worlds<Counted<'a>> {
    let mut templates = BTreeMap::new();
    templates.insert(
        "eden-2026".to_owned(),
        Template {
            dir: "eden-2026".into(),
            lineage: [0xe0; 16],
            zone: Id::new(Scope([0xe0; 16]), 1).expect("an id"),
        },
    );
    Worlds::new(
        Directory::new(
            Counted { inner: store, gets },
            Name::new("m1").expect("a name"),
        ),
        templates,
        Box::new(move |_| {
            forks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    )
}

fn ask(key: &str, name: &str, label: &str) -> Ask {
    Ask {
        key: key.into(),
        name: name.into(),
        template: "eden-2026".into(),
        label: label.into(),
    }
}

const DAY: u64 = 24 * 3600;

#[test]
fn a2_the_list_is_one_read_of_the_cached_copy() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let w = worlds(&store, &gets, forks);
    w.create(&ask("k1", "first", "Ann"), person(1), 0, 10 * DAY)
        .expect("made");
    // A second machine, cold: its first list reads the one object, and every list after reads nothing.
    let (gets2, forks2) = (AtomicUsize::new(0), Arc::new(AtomicUsize::new(0)));
    let cold = worlds(&store, &gets2, forks2);
    let first = cold.list().expect("a list");
    assert_eq!(
        gets2.load(Ordering::SeqCst),
        1,
        "one read of the store, cold"
    );
    for _ in 0..10 {
        assert_eq!(cold.list().expect("a list"), first);
    }
    assert_eq!(gets2.load(Ordering::SeqCst), 1, "no read when cached");
    let rows = first["worlds"].as_array().expect("rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], "first");
    assert_eq!(rows[0]["label"], "Ann");
    assert_eq!(rows[0]["template"], "eden-2026");
    assert_eq!(
        rows[0]["awake"], false,
        "this machine has not seen its record: no world was asked"
    );
    // On the machine that made it, its claimed record is cached: awake, with no read.
    let before = gets.load(Ordering::SeqCst);
    assert_eq!(w.list().expect("a list")["worlds"][0]["awake"], true);
    assert_eq!(gets.load(Ordering::SeqCst), before);
}

#[test]
fn a4_two_clicks_make_one_world() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let w = Arc::new(worlds(&store, &gets, forks.clone()));
    let answers: Vec<_> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..2)
            .map(|_| s.spawn(|| w.create(&ask("click-1", "twice", "Ann"), person(1), 0, 10 * DAY)))
            .collect();
        hs.into_iter().map(|h| h.join().expect("joined")).collect()
    });
    assert_eq!(forks.load(Ordering::SeqCst), 1, "one fork");
    assert_eq!(
        answers[0], answers[1],
        "the second click gets the first's world"
    );
    assert!(answers[0].is_ok());
    assert_eq!(
        w.list().expect("a list")["worlds"]
            .as_array()
            .expect("rows")
            .len(),
        1
    );
    // A second key for the same name is G9's refusal, and makes nothing.
    let e = w
        .create(&ask("click-2", "twice", "Ann"), person(1), 0, 10 * DAY)
        .expect_err("taken");
    assert_eq!(e.name, "name-taken");
    assert_eq!(forks.load(Ordering::SeqCst), 1);
}

#[test]
fn a5_a_limit_names_itself_and_when_to_retry() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let w = worlds(&store, &gets, forks);
    let made = 1_000_000u64;
    // A new account: one an hour, two in its first day.
    w.create(&ask("a", "new-1", "Bo"), person(2), made, made + 60)
        .expect("first");
    let e = w
        .create(&ask("b", "new-2", "Bo"), person(2), made, made + 120)
        .expect_err("an hour");
    assert_eq!(e.name, "world-limit-hourly");
    let d: Json = serde_json::from_str(&e.detail).expect("json");
    assert_eq!(d["limit"], "one world an hour in an account's first day");
    assert_eq!(d["retry_after"], 3600 - 60);
    w.create(&ask("c", "new-2", "Bo"), person(2), made, made + 3700)
        .expect("after the hour");
    let e = w
        .create(&ask("d", "new-3", "Bo"), person(2), made, made + 8000)
        .expect_err("the first day");
    assert_eq!(e.name, "world-limit-new-account");
    let d: Json = serde_json::from_str(&e.detail).expect("json");
    assert_eq!(d["limit"], "2 worlds in an account's first day");
    assert_eq!(d["retry_after"], DAY - 8000);
    // An older account: five, then refused with no time to wait.
    for i in 3..=5 {
        w.create(
            &ask(&format!("o{i}"), &format!("new-{i}"), "Bo"),
            person(2),
            made,
            made + DAY + i,
        )
        .expect("an older account");
    }
    let e = w
        .create(&ask("o6", "new-6", "Bo"), person(2), made, made + 2 * DAY)
        .expect_err("five");
    assert_eq!(e.name, "world-limit");
    let d: Json = serde_json::from_str(&e.detail).expect("json");
    assert_eq!(d["limit"], "5 worlds an account");
    assert_eq!(d["retry_after"], Json::Null);
    // Another person may not take Bo's label.
    let e = w
        .create(&ask("x", "other", "Bo"), person(3), 0, 10 * DAY)
        .expect_err("label");
    assert_eq!(e.name, "label-taken");
}

#[test]
fn w9_settings_by_the_creator_alone_and_off_the_list_wakes_no_world() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let w = worlds(&store, &gets, forks.clone());
    w.create(&ask("k1", "mine", "Ann"), person(1), 0, 10 * DAY)
        .expect("made");
    let keys = store.keys();
    // Only its creator.
    let e = w
        .settings("mine", person(2), Some(true), None, None)
        .expect_err("not hers");
    assert_eq!(e.name, "not-the-creator");
    assert_eq!(
        w.settings("nowhere", person(1), Some(true), None, None)
            .expect_err("missing")
            .name,
        "world-missing"
    );
    // Closed to visitors: the row says so on the list.
    let row = w
        .settings("mine", person(1), None, Some(true), None)
        .expect("closed");
    assert_eq!(row["closed"], true);
    assert_eq!(w.list().expect("a list")["worlds"][0]["closed"], true);
    // Off the list (A4): gone from it here and on a cold machine; nothing but the list's object is written, and no
    // world is started.
    w.settings("mine", person(1), Some(true), None, None)
        .expect("off the list");
    assert_eq!(w.list().expect("a list")["worlds"], json!([]));
    let (gets2, forks2) = (AtomicUsize::new(0), Arc::new(AtomicUsize::new(0)));
    assert_eq!(
        worlds(&store, &gets2, forks2).list().expect("a list")["worlds"],
        json!([])
    );
    assert_eq!(store.keys(), keys, "only the list's object changed");
    assert_eq!(forks.load(Ordering::SeqCst), 1, "the create's fork alone");
    // Read back by its creator, and back on the list.
    assert_eq!(
        w.settings("mine", person(1), None, None, None)
            .expect("read")["unlisted"],
        true
    );
    w.settings("mine", person(1), Some(false), None, None)
        .expect("listed");
    assert_eq!(w.list().expect("a list")["worlds"][0]["name"], "mine");
}

#[test]
fn g10_a4_the_creators_list_picture_passes_g6_and_shows_on_a_cold_machine() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let w = worlds(&store, &gets, forks);
    w.create(&ask("k1", "mine", "Ann"), person(1), 0, 10 * DAY)
        .expect("made");
    assert_eq!(
        w.list().expect("a list")["worlds"][0]["picture"],
        Json::Null
    );
    // G6's check: over the side is refused by its code, and a glTF is not a picture.
    let wide = crate::pairing::tests::png(PICTURE_SIDE as u32 + 1, None);
    assert!(list_picture(&wide).is_err());
    assert!(list_picture(b"glTF").is_err());
    let url = list_picture(&crate::pairing::tests::png(
        16,
        Some("Comment\0secret place"),
    ))
    .expect("a picture");
    assert!(url.starts_with("data:image/png;base64,"));
    // Only the creator sets it; then a cold machine's list shows it, from the list's one object.
    let e = w
        .settings("mine", person(2), None, None, Some(&url))
        .expect_err("not hers");
    assert_eq!(e.name, "not-the-creator");
    w.settings("mine", person(1), None, None, Some(&url))
        .expect("set");
    let (gets2, forks2) = (AtomicUsize::new(0), Arc::new(AtomicUsize::new(0)));
    let cold = worlds(&store, &gets2, forks2).list().expect("a list");
    assert_eq!(cold["worlds"][0]["picture"], json!(url));
    // A switch set later keeps it.
    w.settings("mine", person(1), None, Some(true), None)
        .expect("closed");
    assert_eq!(
        w.list().expect("a list")["worlds"][0]["picture"],
        json!(url)
    );
}

#[test]
fn w3b_pending_retry_survives_directory_restart_and_keeps_owned_identity() {
    let (store, gets, calls) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let mut first = worlds(&store, &gets, calls.clone());
    let started = calls.clone();
    first.starter = Box::new(move |_| {
        started.fetch_add(1, Ordering::SeqCst);
        refuse("world-starting", "pending")
    });
    let click = ask("durable-click", "durable", "Owner");
    assert_eq!(
        first
            .create(&click, person(1), 0, 10 * DAY)
            .unwrap_err()
            .name,
        "world-starting"
    );
    let pending = first.list().unwrap()["worlds"][0].clone();
    assert_eq!(pending["ready"], false);
    drop(first);
    let resumed = worlds(&store, &gets, calls.clone());
    let answer = resumed.create(&click, person(1), 0, 10 * DAY + 1).unwrap();
    assert_eq!(answer["world"]["lineage"], pending["lineage"]);
    assert_eq!(answer["world"]["creator"], pending["creator"]);
    assert_eq!(answer["world"]["ready"], true);
    assert_eq!(
        resumed.create(&click, person(1), 0, 10 * DAY + 2).unwrap(),
        answer
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "one pending handoff and one recovery, no repeated ready fork"
    );
    let mut changed = click.clone();
    changed.name = "other".into();
    assert_eq!(
        resumed
            .create(&changed, person(1), 0, 10 * DAY + 3)
            .unwrap_err()
            .name,
        "create-key-reused"
    );
    assert_eq!(
        resumed
            .create(&click, person(2), 0, 10 * DAY + 3)
            .unwrap_err()
            .name,
        "label-taken"
    );
    let expected: [u8; 16] = from_hex(pending["lineage"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(
        store
            .get(&NameRecord::key("durable"))
            .unwrap()
            .map(|o| NameRecord::read(&o.bytes).unwrap().lineage),
        Some(expected)
    );
}
