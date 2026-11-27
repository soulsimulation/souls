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
    fn delete(&self, key: &str) -> R<()> {
        self.inner.delete(key)
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
fn a2_the_list_is_one_fresh_authoritative_read() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let w = worlds(&store, &gets, forks);
    w.create(&ask("k1", "first", "Ann"), person(1), 0, 10 * DAY)
        .expect("made");
    // Each list reads the same one object, so a root operator's archive/restore cannot leave a stale list.
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
    assert_eq!(
        gets2.load(Ordering::SeqCst),
        11,
        "one authoritative read per list"
    );
    let rows = first["worlds"].as_array().expect("rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], "first");
    assert_eq!(rows[0]["label"], "Ann");
    assert_eq!(rows[0]["template"], "eden-2026");
    assert_eq!(
        rows[0]["awake"], false,
        "this machine has not seen its record: no world was asked"
    );
    // Its cached claim supplies awake without waking the world; the list itself is still one fresh read.
    let before = gets.load(Ordering::SeqCst);
    assert_eq!(w.list().expect("a list")["worlds"][0]["awake"], true);
    assert_eq!(gets.load(Ordering::SeqCst), before + 1);
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

/// Registers `n` imported worlds (`imp-<i>`) founded by `creator`, made at `made`, as the operator's
/// `register-world` does.
fn import(store: &Memory, creator: Id, n: u8, made: u64) {
    for i in 1..=n {
        let name = format!("imp-{i}");
        register::register(
            store,
            &register::Imported {
                name: &name,
                label: "Bo",
                lineage: [0x40 + i; 16],
                zone: Id::new(Scope([0x40 + i; 16]), 1).expect("an id"),
                creator,
                now: made,
            },
        )
        .expect("registered");
    }
}

#[test]
fn a5_imported_worlds_count_toward_no_limit() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let made = 1_000_000u64;
    // Six imported worlds, the last a minute ago, founded by a first-day account: more than every limit.
    import(&store, person(2), 6, made + 60);
    let w = worlds(&store, &gets, forks);
    assert_eq!(
        w.list().expect("a list")["worlds"].as_array().map(Vec::len),
        Some(6)
    );
    w.create(&ask("a", "new-1", "Bo"), person(2), made, made + 120)
        .expect("imported worlds count toward no limit");
    // Worlds made through New world still count: the hour, then the first day, then five.
    let e = w
        .create(&ask("b", "new-2", "Bo"), person(2), made, made + 180)
        .expect_err("an hour");
    assert_eq!(e.name, "world-limit-hourly");
    w.create(&ask("c", "new-2", "Bo"), person(2), made, made + 3800)
        .expect("after the hour");
    let e = w
        .create(&ask("d", "new-3", "Bo"), person(2), made, made + 8000)
        .expect_err("the first day");
    assert_eq!(e.name, "world-limit-new-account");
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
        .expect_err("five made");
    assert_eq!(e.name, "world-limit");
}

#[test]
fn a5_a_site_owner_has_no_limits_and_a_newcomer_keeps_them() {
    assert_eq!(
        site_owners(" acct_site, ,acct_other ,"),
        ["acct_other".to_owned(), "acct_site".to_owned()].into()
    );
    assert!(site_owners("").is_empty());
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let made = 1_000_000u64;
    import(&store, person(2), 6, made);
    let mut w = worlds(&store, &gets, forks);
    w.site_owners = site_owners("acct_site");
    // A site owner in their account's first minutes: seven worlds, a minute apart, past all three limits.
    for i in 1..=7u64 {
        w.create_for(
            &ask(&format!("s{i}"), &format!("site-{i}"), "Bo"),
            person(2),
            "acct_site",
            made,
            made + 60 * i,
        )
        .expect("a site owner has no limits");
    }
    // A newcomer, with site owners configured: all three limits, exactly as before.
    let nb = |k: &str, name: &str, at: u64| {
        w.create_for(&ask(k, name, "Cy"), person(3), "acct_new", made, made + at)
    };
    nb("a", "cy-1", 60).expect("first");
    assert_eq!(
        nb("b", "cy-2", 120).expect_err("an hour").name,
        "world-limit-hourly"
    );
    nb("c", "cy-2", 3700).expect("after the hour");
    assert_eq!(
        nb("d", "cy-3", 8000).expect_err("the first day").name,
        "world-limit-new-account"
    );
    for i in 3..=5 {
        nb(&format!("o{i}"), &format!("cy-{i}"), DAY + i).expect("an older account");
    }
    assert_eq!(
        nb("o6", "cy-6", 2 * DAY).expect_err("five").name,
        "world-limit"
    );
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
    // Still on its creator's own list, marked unlisted, and on nobody else's (#3698).
    let own = w.list_for(Some(person(1))).expect("her list");
    assert_eq!(own["worlds"][0]["name"], "mine");
    assert_eq!(own["worlds"][0]["unlisted"], true);
    assert_eq!(
        w.list_for(Some(person(2))).expect("his list")["worlds"],
        json!([])
    );
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

/// A placement that places only while `place` is set, counting the starts it is asked for (probes apart); a probe
/// answers `probe` (`None`: placed).
fn placing<'a>(
    store: &'a Memory,
    gets: &'a AtomicUsize,
    starts: Arc<AtomicUsize>,
    place: Arc<std::sync::atomic::AtomicBool>,
    probe: Option<&'static str>,
) -> Worlds<Counted<'a>> {
    let mut w = worlds(store, gets, Arc::new(AtomicUsize::new(0)));
    w.starter = Box::new(move |s: &Start| {
        if s.probe {
            return match probe {
                None => Ok(()),
                Some(name) => refuse(name, "probe"),
            };
        }
        starts.fetch_add(1, Ordering::SeqCst);
        if place.load(Ordering::SeqCst) {
            Ok(())
        } else {
            refuse("world-starting", "pending")
        }
    });
    w
}

#[test]
fn rule10_an_unplaced_create_ends_named_and_frees_its_name() {
    let (store, gets, starts) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let place = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let w = placing(
        &store,
        &gets,
        starts.clone(),
        place.clone(),
        Some("world-starting"),
    );
    let t = 10 * DAY;
    let click = ask("lab-click", "my-mars-lab", "Mars Lab");
    assert_eq!(
        w.create(&click, person(1), 0, t).unwrap_err().name,
        "world-starting"
    );
    // Within the limit, the same click asks the placement again (reprocessed), and keeps the name.
    assert_eq!(
        w.create(&click, person(1), 0, t + PLACE_WITHIN - 1)
            .unwrap_err()
            .name,
        "world-starting"
    );
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    assert!(
        store
            .get(&NameRecord::key("my-mars-lab"))
            .unwrap()
            .is_some()
    );
    // Past it: a named refusal, the row off the list, the name record gone, and no placement asked for.
    let ended = w
        .create(&click, person(1), 0, t + PLACE_WITHIN)
        .unwrap_err();
    assert_eq!(ended.name, "create-failed");
    assert!(ended.detail.contains("my-mars-lab"), "{}", ended.detail);
    assert_eq!(w.list().unwrap()["worlds"], json!([]));
    assert!(
        store
            .get(&NameRecord::key("my-mars-lab"))
            .unwrap()
            .is_none()
    );
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    // The same click stays ended; the owner's new click takes the name and is placed.
    assert_eq!(
        w.create(&click, person(1), 0, t + PLACE_WITHIN + 1)
            .unwrap_err()
            .name,
        "create-failed"
    );
    place.store(true, Ordering::SeqCst);
    let again = w
        .create(
            &ask("lab-click-2", "my-mars-lab", "Mars Lab"),
            person(1),
            0,
            t + PLACE_WITHIN + 2,
        )
        .expect("the name is free");
    assert_eq!(again["world"]["ready"], true);
    // The first click, retried later, still cannot touch the new world.
    assert_eq!(
        w.create(&click, person(1), 0, t + PLACE_WITHIN + 3)
            .unwrap_err()
            .name,
        "create-failed"
    );
    assert_eq!(
        w.list().unwrap()["worlds"][0]["lineage"],
        again["world"]["lineage"]
    );
    assert!(
        store
            .get(&NameRecord::key("my-mars-lab"))
            .unwrap()
            .is_some()
    );
}

#[test]
fn rule10_a_stale_create_with_no_click_left_ends_at_the_start_or_at_anyones_create() {
    let (store, gets, starts) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let place = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let t = 10 * DAY;
    {
        let w = placing(
            &store,
            &gets,
            starts.clone(),
            place.clone(),
            Some("world-starting"),
        );
        w.create(
            &ask("lost-click", "my-mars-lab", "Mars Lab"),
            person(1),
            0,
            t,
        )
        .unwrap_err();
        w.create(
            &ask("lost-click-2", "other-lab", "Other"),
            person(1),
            0,
            t + 1,
        )
        .unwrap_err();
    }
    // A directory started within the limit keeps them; one started past it ends both.
    let w = placing(
        &store,
        &gets,
        starts.clone(),
        place.clone(),
        Some("world-starting"),
    );
    assert_eq!(w.end_stale_creates(t + PLACE_WITHIN - 1).unwrap(), 0);
    assert_eq!(w.end_stale_creates(t + PLACE_WITHIN + 1).unwrap(), 2);
    assert_eq!(w.list().unwrap()["worlds"], json!([]));
    assert!(
        store
            .get(&NameRecord::key("my-mars-lab"))
            .unwrap()
            .is_none()
    );
    assert!(store.get(&NameRecord::key("other-lab")).unwrap().is_none());
    // Someone else's create also ends a stale one, here before its own name check.
    place.store(false, Ordering::SeqCst);
    w.create(
        &ask("c3", "third", "Third"),
        person(1),
        0,
        t + 2 * PLACE_WITHIN,
    )
    .unwrap_err();
    place.store(true, Ordering::SeqCst);
    let taken = w
        .create(
            &ask("c4", "third", "Taken"),
            person(2),
            0,
            t + 3 * PLACE_WITHIN,
        )
        .expect("the stale reservation of another account ended first");
    assert_eq!(taken["world"]["creator"], principal_text(person(2)));
}

#[test]
fn rule10_a_placed_or_unknown_placement_keeps_the_create() {
    let (store, gets, starts) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let place = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let t = 10 * DAY;
    placing(&store, &gets, starts.clone(), place.clone(), None)
        .create(&ask("k", "placed", "Placed"), person(1), 0, t)
        .unwrap_err();
    // Not known (status unreadable, or a placement still running): kept as it is.
    let unknown = placing(
        &store,
        &gets,
        starts.clone(),
        place.clone(),
        Some("start-failed"),
    );
    assert_eq!(unknown.end_stale_creates(t + PLACE_WITHIN).unwrap(), 0);
    assert_eq!(unknown.list().unwrap()["worlds"][0]["ready"], false);
    // Placed after all (the page never asked again): its row is ready and its name stays.
    let placed = placing(&store, &gets, starts.clone(), place.clone(), None);
    assert_eq!(placed.end_stale_creates(t + PLACE_WITHIN).unwrap(), 0);
    assert_eq!(placed.list().unwrap()["worlds"][0]["ready"], true);
    assert!(store.get(&NameRecord::key("placed")).unwrap().is_some());
}

#[test]
fn rule10_a_ready_list_row_keeps_its_name_whatever_its_intent_says() {
    // The list row was marked ready, but the intent's last write was lost: the intent still says unready.
    let (store, gets, starts) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let place = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let t = 10 * DAY;
    let click = ask("k", "live", "Live");
    placing(&store, &gets, starts.clone(), place.clone(), None)
        .create(&click, person(1), 0, t)
        .expect("placed");
    let key = store
        .keys()
        .into_iter()
        .find(|k| k.starts_with("world-create/"))
        .unwrap();
    let prior = store.get(&key).unwrap().unwrap();
    let mut intent: Json = serde_json::from_slice(&prior.bytes).unwrap();
    intent["row"]["ready"] = json!(false);
    store
        .put(
            &key,
            &serde_json::to_vec(&intent).unwrap(),
            When::Is(&prior.etag),
        )
        .unwrap();
    // The probe says not placed (its status lost or unreadable as `world-starting`): the name of the ready world stays.
    let w = placing(
        &store,
        &gets,
        starts.clone(),
        place.clone(),
        Some("world-starting"),
    );
    assert_eq!(w.end_stale_creates(t + 2 * PLACE_WITHIN).unwrap(), 0);
    let again = w
        .create(&click, person(1), 0, t + 2 * PLACE_WITHIN)
        .expect("the same world");
    assert_eq!(again["world"]["ready"], true);
    assert!(store.get(&NameRecord::key("live")).unwrap().is_some());
    assert_eq!(w.list().unwrap()["worlds"][0]["ready"], true);
}

#[test]
fn rule10_a_placement_that_starts_while_a_create_ends_keeps_it() {
    // The first probe finds no status; by the second (after the row went) the placement has written one.
    let (store, gets) = (Memory::default(), AtomicUsize::new(0));
    let t = 10 * DAY;
    let mut w = worlds(&store, &gets, Arc::new(AtomicUsize::new(0)));
    let probes = Arc::new(AtomicUsize::new(0));
    let seen = probes.clone();
    w.starter = Box::new(move |s: &Start| {
        if !s.probe {
            return refuse("world-starting", "pending");
        }
        match seen.fetch_add(1, Ordering::SeqCst) {
            0 => refuse("world-starting", "no status yet"),
            _ => refuse("start-failed", "a placement may be running"),
        }
    });
    w.create(&ask("k", "racing", "Racing"), person(1), 0, t)
        .unwrap_err();
    assert_eq!(w.end_stale_creates(t + PLACE_WITHIN).unwrap(), 0);
    assert_eq!(probes.load(Ordering::SeqCst), 2);
    let rows = w.list().unwrap()["worlds"].clone();
    assert_eq!(rows.as_array().unwrap().len(), 1, "the row is back");
    assert_eq!(rows[0]["name"], "racing");
    assert!(store.get(&NameRecord::key("racing")).unwrap().is_some());
}

#[test]
fn rule10_a_name_record_left_without_its_row_is_ended_whole_by_its_click() {
    // A stop between the row's removal and the name record's: the click lists the row again, then it ends whole.
    let (store, gets, starts) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let place = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let t = 10 * DAY;
    let click = ask("k", "half", "Half");
    let w = placing(
        &store,
        &gets,
        starts.clone(),
        place.clone(),
        Some("world-starting"),
    );
    w.create(&click, person(1), 0, t).unwrap_err();
    let list = store.get(KEY).unwrap().unwrap();
    store
        .put(KEY, br#"{"worlds":[]}"#, When::Is(&list.etag))
        .unwrap();
    assert_eq!(
        w.create(&click, person(1), 0, t + PLACE_WITHIN)
            .unwrap_err()
            .name,
        "world-starting",
        "the name record is still there: the row is listed again"
    );
    assert_eq!(w.list().unwrap()["worlds"][0]["name"], "half");
    assert_eq!(w.end_stale_creates(t + PLACE_WITHIN).unwrap(), 1);
    assert!(store.get(&NameRecord::key("half")).unwrap().is_none());
    assert_eq!(
        w.create(&click, person(1), 0, t + PLACE_WITHIN + 1)
            .unwrap_err()
            .name,
        "create-failed"
    );
}

#[test]
fn w16_handoff_hash_only_named_expiry_pending_restart_and_round_trip() {
    let store = Memory::default();
    let gets = AtomicUsize::new(0);
    let w = worlds(&store, &gets, Arc::new(AtomicUsize::new(0)));
    w.create(&ask("w16", "garden", "First"), person(1), 0, 10 * DAY)
        .unwrap();
    let original = store
        .get(&NameRecord::key("garden"))
        .unwrap()
        .unwrap()
        .bytes;
    let id = w.ownership("garden").unwrap();
    assert_eq!(
        w.offer_handoff("garden", person(3), None, 10 * DAY)
            .unwrap_err()
            .name,
        "not-the-creator"
    );
    let expired = w
        .offer_handoff("garden", person(1), None, 10 * DAY)
        .unwrap();
    assert_eq!(
        w.begin_handoff(
            "garden",
            expired["code"].as_str().unwrap(),
            "acct_next",
            person(2),
            17 * DAY
        )
        .unwrap_err()
        .name,
        "handoff-expired"
    );
    w.cancel_handoff("garden", person(1)).unwrap();
    assert_eq!(
        w.begin_handoff(
            "garden",
            expired["code"].as_str().unwrap(),
            "acct_next",
            person(2),
            10 * DAY
        )
        .unwrap_err()
        .name,
        "handoff-unknown"
    );
    let offer = w
        .offer_handoff("garden", person(1), Some("acct_next"), 10 * DAY)
        .unwrap();
    let code = offer["code"].as_str().unwrap();
    let stored = store.get(KEY).unwrap().unwrap().bytes;
    assert!(!String::from_utf8(stored).unwrap().contains(code));
    let public = w.list().unwrap().to_string();
    for secret in [code, "acct_next", "_handoff", "_creator_generation"] {
        assert!(!public.contains(secret));
    }
    assert_eq!(
        w.begin_handoff("garden", code, "acct_other", person(3), 10 * DAY)
            .unwrap_err()
            .name,
        "handoff-not-for-you"
    );
    let pending = w
        .begin_handoff("garden", code, "acct_next", person(2), 10 * DAY)
        .unwrap();
    assert_eq!(creator_of(&store, &id.lineage, id.zone).unwrap(), None);
    assert_eq!(
        w.creators().unwrap(),
        vec![(to_hex(&id.lineage), String::new())]
    );
    assert_eq!(
        w.settings("garden", person(1), None, None, None)
            .unwrap_err()
            .name,
        "not-the-creator"
    );
    let cold_gets = AtomicUsize::new(0);
    let cold = worlds(&store, &cold_gets, Arc::new(AtomicUsize::new(0)));
    assert_eq!(
        cold.begin_handoff("garden", code, "acct_next", person(2), 30 * DAY)
            .unwrap(),
        pending
    );
    assert_eq!(
        cold.begin_handoff("garden", code, "acct_other", person(3), 30 * DAY)
            .unwrap_err()
            .name,
        "handoff-pending"
    );
    cold.finish_handoff(&pending).unwrap();
    assert_eq!(
        creator_of(&store, &id.lineage, id.zone).unwrap(),
        Some(person(2))
    );
    assert_eq!(cold.ownership("garden").unwrap().generation, 1);
    assert!(
        cold.settings("garden", person(2), Some(true), None, None)
            .is_ok()
    );
    assert_eq!(
        cold.begin_handoff("garden", code, "acct_next", person(2), 30 * DAY)
            .unwrap_err()
            .name,
        "handoff-used"
    );
    let back = cold
        .offer_handoff("garden", person(2), None, 30 * DAY)
        .unwrap();
    assert_eq!(
        cold.begin_handoff(
            "garden",
            back["code"].as_str().unwrap(),
            "acct_next",
            person(2),
            30 * DAY
        )
        .unwrap_err()
        .name,
        "handoff-already-owner"
    );
    let back = cold
        .begin_handoff(
            "garden",
            back["code"].as_str().unwrap(),
            "acct_first",
            person(1),
            30 * DAY,
        )
        .unwrap();
    cold.finish_handoff(&back).unwrap();
    assert_eq!(cold.ownership("garden").unwrap().generation, 2);
    assert_eq!(
        store
            .get(&NameRecord::key("garden"))
            .unwrap()
            .unwrap()
            .bytes,
        original
    );
    let mut rows: Json = serde_json::from_slice(&store.get(KEY).unwrap().unwrap().bytes).unwrap();
    rows["worlds"][0]["lineage"] = json!("ff".repeat(16));
    let etag = store.get(KEY).unwrap().unwrap().etag;
    store
        .put(KEY, &serde_json::to_vec(&rows).unwrap(), When::Is(&etag))
        .unwrap();
    assert_eq!(
        cold.ownership("garden").unwrap_err().name,
        "handoff-authority-mismatch"
    );
}

#[test]
fn w17_current_creator_confirmation_archive_restore_and_reservations_survive_reload() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let w = worlds(&store, &gets, forks.clone());
    let request = ask("archive", "garden", "Garden");
    let row = w.create(&request, person(1), 0, 10 * DAY).unwrap()["world"].clone();
    let immutable = store
        .get(&NameRecord::key("garden"))
        .unwrap()
        .unwrap()
        .bytes;
    let offer = w.offer_handoff("garden", person(1), None, 10).unwrap();
    assert_eq!(
        archive::begin(&store, "garden", Some(person(1)), "garden", false)
            .unwrap_err()
            .name,
        "archive-handoff-pending"
    );
    let pending = w
        .begin_handoff(
            "garden",
            offer["code"].as_str().unwrap(),
            "recipient",
            person(2),
            11,
        )
        .unwrap();
    w.finish_handoff(&pending).unwrap();
    assert_eq!(
        archive::begin(&store, "garden", Some(person(1)), "garden", false)
            .unwrap_err()
            .name,
        "not-the-creator"
    );
    assert_eq!(
        archive::begin(&store, "garden", Some(person(2)), "Garden", false)
            .unwrap_err()
            .name,
        "archive-confirmation"
    );
    let phase = archive::begin(&store, "garden", Some(person(2)), "garden", false).unwrap();
    assert_eq!(phase.creator, person(2));
    assert_eq!(phase.creator_generation, 1);
    assert_eq!(
        archive::begin(&store, "garden", Some(person(2)), "garden", false).unwrap(),
        phase
    );
    assert!(w.list().unwrap()["worlds"].as_array().unwrap().is_empty());
    assert_eq!(
        w.offer_handoff("garden", person(2), None, 12)
            .unwrap_err()
            .name,
        "world-archived"
    );
    assert_eq!(
        w.create(&request, person(1), 0, 11 * DAY).unwrap_err().name,
        "world-archived"
    );
    assert_eq!(forks.load(Ordering::SeqCst), 1);
    let cold = worlds(&store, &gets, forks);
    let archived = archive::finish(&store, &phase).unwrap();
    assert_eq!(archived.state, "archived");
    assert!(
        cold.list().unwrap()["worlds"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let restore = archive::begin(&store, "garden", None, "", true).unwrap();
    assert_eq!(
        archive::begin(&store, "garden", None, "", true).unwrap(),
        restore
    );
    assert_eq!(
        archive::finish(&store, &phase).unwrap_err().name,
        "archive-stale"
    );
    assert_eq!(archive::finish(&store, &restore).unwrap().state, "active");
    assert_eq!(
        archive::retry_restore(&store, "garden", &phase.request)
            .unwrap_err()
            .name,
        "archive-stale"
    );
    let contained = archive::retry_restore(&store, "garden", &restore.request).unwrap();
    assert_eq!(contained.request, restore.request);
    assert_eq!(contained.generation, restore.generation);
    assert!(
        cold.list().unwrap()["worlds"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(archive::finish(&store, &contained).unwrap().state, "active");
    let returned = cold.list().unwrap()["worlds"][0].clone();
    assert_eq!(returned["lineage"], row["lineage"]);
    assert_eq!(returned["zone"], row["zone"]);
    assert_eq!(returned["creator"], principal_text(person(2)));
    assert!(returned.get(archive::FIELD).is_none());
    assert_eq!(
        store
            .get(&NameRecord::key("garden"))
            .unwrap()
            .unwrap()
            .bytes,
        immutable
    );
    assert_eq!(cold.ownership("garden").unwrap().creator, Some(person(2)));
    let back = cold.offer_handoff("garden", person(2), None, 20).unwrap();
    let pending = cold
        .begin_handoff(
            "garden",
            back["code"].as_str().unwrap(),
            "return-owner",
            person(1),
            21,
        )
        .unwrap();
    cold.finish_handoff(&pending).unwrap();
    let next = archive::begin(&store, "garden", Some(person(1)), "garden", false).unwrap();
    assert_eq!(next.generation, phase.generation);
    assert_eq!(next.creator_generation, 2);
    assert_eq!(next.creator, person(1));
    assert_ne!(next.request, phase.request);
}

#[test]
fn w17_archive_revalidates_creator_inside_the_conditional_write() {
    use std::sync::atomic::AtomicBool;
    struct Raced<'a> {
        memory: &'a Memory,
        armed: AtomicBool,
    }
    impl Store for Raced<'_> {
        fn get(&self, key: &str) -> R<Option<Object>> {
            self.memory.get(key)
        }
        fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
            if key == KEY && self.armed.swap(false, Ordering::SeqCst) {
                let current = self.memory.get(KEY)?.unwrap();
                let mut value: Json = serde_json::from_slice(&current.bytes).unwrap();
                value["worlds"][0]["creator"] = json!(principal_text(person(2)));
                value["worlds"][0]["_creator_generation"] = json!(1);
                self.memory.put(
                    KEY,
                    &serde_json::to_vec(&value).unwrap(),
                    When::Is(&current.etag),
                )?;
            }
            self.memory.put(key, bytes, when)
        }
    }
    let (memory, gets) = (Memory::default(), AtomicUsize::new(0));
    let w = worlds(&memory, &gets, Arc::new(AtomicUsize::new(0)));
    w.create(&ask("race", "garden", "Garden"), person(1), 0, 10 * DAY)
        .unwrap();
    let raced = Raced {
        memory: &memory,
        armed: AtomicBool::new(true),
    };
    assert_eq!(
        archive::begin(&raced, "garden", Some(person(1)), "garden", false)
            .unwrap_err()
            .name,
        "not-the-creator"
    );
    let row = read_rows(&memory).unwrap().1.remove(0);
    assert!(row.get(archive::FIELD).is_none());
    assert_eq!(row["creator"], principal_text(person(2)));
}

/// #3702: the creator alone sets the welcome; it is on the row (and so the list), checked, and cleared by empty words.
#[test]
fn n_g8_the_creator_sets_the_welcome_visitors_are_shown() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let w = worlds(&store, &gets, forks);
    w.create(&ask("k1", "mine", "Ann"), person(1), 0, 10 * DAY)
        .expect("made");
    assert_eq!(
        w.set_welcome("mine", person(2), "hi")
            .expect_err("not hers")
            .name,
        "not-the-creator"
    );
    assert_eq!(w.welcome_of("mine").expect("read"), None);
    let row = w
        .set_welcome(
            "mine",
            person(1),
            "  Welcome to the garden.\nTea at four.  ",
        )
        .expect("set");
    assert_eq!(row["welcome"], "Welcome to the garden.\nTea at four.");
    assert_eq!(
        w.list().expect("a list")["worlds"][0]["welcome"],
        "Welcome to the garden.\nTea at four."
    );
    assert_eq!(
        w.welcome_of("mine").expect("read").as_deref(),
        Some("Welcome to the garden.\nTea at four.")
    );
    let long = "a".repeat(WELCOME_MOST + 1);
    assert_eq!(
        w.set_welcome("mine", person(1), &long)
            .expect_err("long")
            .name,
        "welcome-too-long"
    );
    assert_eq!(
        w.set_welcome("mine", person(1), "bell\u{7}")
            .expect_err("control")
            .name,
        "welcome-not-text"
    );
    assert!(w.is_creator("mine", person(1)).expect("read"));
    assert!(!w.is_creator("mine", person(2)).expect("read"));
    w.set_welcome("mine", person(1), "").expect("cleared");
    assert_eq!(w.welcome_of("mine").expect("read"), None);
}

/// Rule 9 (26 Nov): each row's `souls` is what its world's `health.json` on this machine says, read again once
/// [`SOULS_EVERY`] seconds have passed; a world with no file here, or no folder set, lists `souls: null`.
#[test]
fn the_souls_in_each_world_come_from_its_health_file() {
    let (store, gets, forks) = (
        Memory::default(),
        AtomicUsize::new(0),
        Arc::new(AtomicUsize::new(0)),
    );
    let mut w = worlds(&store, &gets, forks);
    w.create(&ask("k1", "busy", "Ann"), person(1), 0, 10 * DAY)
        .expect("made");
    w.create(&ask("k2", "never-started", "Bo"), person(2), 0, 10 * DAY)
        .expect("made");
    let row = |w: &Worlds<Counted<'_>>, name: &str| {
        w.list().expect("a list")["worlds"]
            .as_array()
            .expect("rows")
            .iter()
            .find(|r| r["name"] == name)
            .cloned()
            .expect("listed")
    };
    assert_eq!(row(&w, "busy")["souls"], Json::Null, "no folder set: none");
    let root = std::env::temp_dir().join(format!("directoryd-souls-{}", std::process::id()));
    let busy = row(&w, "busy");
    let folder = folder_of(&busy).expect("a folder name");
    // worldd's instance name, as the folder is named: `<32 hex>-<32 hex>-<counter>`, the row's lineage and zone
    let parts: Vec<&str> = folder.split('-').collect();
    let hex = |p: &str| p.len() == 32 && p.bytes().all(|b| b.is_ascii_hexdigit());
    assert!(
        parts.len() == 3
            && hex(parts[0])
            && hex(parts[1])
            && !parts[2].is_empty()
            && parts[2].bytes().all(|b| b.is_ascii_digit()),
        "{folder}"
    );
    assert_eq!(parts[0], busy["lineage"].as_str().expect("a lineage"));
    assert_eq!(
        format!("{}:{}", parts[1], parts[2]),
        busy["zone"].as_str().expect("a zone")
    );
    std::fs::create_dir_all(root.join(&folder)).expect("a world folder");
    let health_at = |n: u64, at_s: u64| {
        std::fs::write(
            root.join(&folder).join("health.json"),
            format!(
                "{{\"at_unix_ms\":{},\"written\":3,\"souls\":{n}}}\n",
                at_s * 1000
            ),
        )
        .expect("written")
    };
    let health = |n: u64| health_at(n, crate::accounts::serve::now());
    health(4);
    w.souls_root = Some(root.clone());
    assert_eq!(row(&w, "busy")["souls"], 4);
    assert_eq!(
        row(&w, "never-started")["souls"],
        Json::Null,
        "no file: none"
    );
    // Read again only once SOULS_EVERY has passed.
    health(5);
    let t = crate::accounts::serve::now() + 1;
    let at = |now| w.souls_of(std::slice::from_ref(&folder), now)[&folder];
    assert_eq!(
        at(t),
        Some(4),
        "within {SOULS_EVERY} s: the count read before"
    );
    assert_eq!(at(t + SOULS_EVERY), Some(5));
    // A clock gone back reads again rather than hold the old count.
    health(6);
    assert_eq!(at(t - 2), Some(6));
    // A file not written for more than SOULS_FRESH seconds is a world not running here: none.
    health_at(7, t - SOULS_FRESH - 5);
    assert_eq!(at(t + 2 * SOULS_EVERY), None, "a stale file gives no count");
    let _ = std::fs::remove_dir_all(root);
}

/// One HTTP request to a served directory: its status and JSON answer.
fn call(addr: &str, method: &str, path: &str, bearer: Option<&str>, body: &Json) -> (u16, Json) {
    use std::io::{Read, Write};
    let body = if method == "GET" {
        String::new()
    } else {
        body.to_string()
    };
    let auth = bearer.map_or(String::new(), |b| format!("authorization: Bearer {b}\r\n"));
    let mut s = std::net::TcpStream::connect(addr).expect("connects");
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nhost: {addr}\r\n{auth}content-length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    (
        out[9..12].parse().unwrap(),
        serde_json::from_str(out.split("\r\n\r\n").nth(1).unwrap()).unwrap_or_default(),
    )
}

/// 26 Nov (my-mars-lab-2): a world made by New world (the directory's create, as the launcher asks it) is unlisted
/// and listed again by its creator over HTTP (`POST /v1/worlds/settings`, the request the launcher's owner route
/// passes on), and by nobody else. Unlisted, the list asked with no sign-in leaves it out (what the launcher's list
/// follows), and its creator's own list keeps it, marked.
#[test]
fn a_created_world_is_unlisted_and_listed_by_its_creator_over_http() {
    use crate::accounts::serve::{App, run};
    let store: &'static (dyn Store + Send + Sync) = Box::leak(Box::new(Memory::default()));
    let mut templates = BTreeMap::new();
    templates.insert(
        "mars-camp".to_owned(),
        Template {
            dir: "mars-camp".into(),
            lineage: [0xe0; 16],
            zone: Id::new(Scope([0xe0; 16]), 1).expect("an id"),
        },
    );
    let app = Arc::new(App {
        store: crate::accounts::store::Store::open(std::path::Path::new(":memory:")).unwrap(),
        verifier: None,
        test_sign_in: true,
        view_key: None,
        origin: None,
        mailbox_key: None,
        pairing: None,
        log: Mutex::new(Box::new(std::io::sink())),
        worlds: Some(Worlds::new(
            Directory::new(store, Name::new("m1").expect("a name")),
            templates,
            Box::new(|_| Ok(())),
        )),
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || run(listener, app));

    let ask = json!({"key": "click-1", "name": "my-mars-lab-2", "template": "mars-camp", "label": "My Mars Lab"});
    let (status, made) = call(&addr, "POST", "/v1/worlds", Some("test:Ada"), &ask);
    assert_eq!(status, 200, "{made}");
    let public = || {
        let (status, list) = call(&addr, "GET", "/v1/worlds", None, &Json::Null);
        assert_eq!(status, 200, "{list}");
        list["worlds"]
            .as_array()
            .expect("rows")
            .iter()
            .filter_map(|r| r["name"].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    };
    let set = |who: Option<&str>, world: &str, unlisted: bool| {
        call(
            &addr,
            "POST",
            "/v1/worlds/settings",
            who,
            &json!({"world": world, "unlisted": unlisted}),
        )
    };
    assert_eq!(public(), ["my-mars-lab-2"]);
    // Nobody signed in, someone else, or a world that is not there: refused, and it stays listed.
    assert_eq!(
        set(None, "my-mars-lab-2", true),
        (401, json!({"refused": "token-missing"}))
    );
    assert_eq!(
        set(Some("test:Bea"), "my-mars-lab-2", true),
        (403, json!({"refused": "not-the-creator"}))
    );
    assert_eq!(
        set(Some("test:Ada"), "nowhere", true),
        (404, json!({"refused": "world-missing"}))
    );
    assert_eq!(public(), ["my-mars-lab-2"]);
    // Its creator: off the public list, still on her own, marked.
    let (status, row) = set(Some("test:Ada"), "my-mars-lab-2", true);
    assert_eq!(status, 200, "{row}");
    assert_eq!(row["world"]["name"], "my-mars-lab-2");
    assert_eq!(row["world"]["unlisted"], true);
    assert!(public().is_empty(), "off the public list");
    let (_, own) = call(&addr, "GET", "/v1/worlds", Some("test:Ada"), &Json::Null);
    assert_eq!(own["worlds"][0]["name"], "my-mars-lab-2");
    assert_eq!(own["worlds"][0]["unlisted"], true);
    // And back on it.
    assert_eq!(set(Some("test:Ada"), "my-mars-lab-2", false).0, 200);
    assert_eq!(public(), ["my-mars-lab-2"]);
}
