//! O20 (#2812) A4: a store no line of `v2/tools/ops/stores.json` covers fails this test. The machine's data folder is
//! made by the stores' own programs' open calls (the account store, pairing and its tokens file, a world's log and
//! its text store with an upload), so a store a task adds there without a line is named here.

use std::path::{Path, PathBuf};

use backup::{Copy, checked_in, list, unlisted};
use directoryd::accounts::start::TEST_ISSUER;
use replica::encode::to_hex;
use replica::ids::{Id, Minter, Scope, sha256};
use replica::world_model::Audience;

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "souls-o20-{name}-{}",
        to_hex(&sha256(format!("{:?}", std::thread::current().id()).as_bytes())[..6])
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

/// A machine's data folder with every store this machine's programs make, each opened by its owner.
fn machine(root: &Path) {
    let dir = root.join("directory");
    std::fs::create_dir_all(&dir).expect("directory");
    let accounts =
        directoryd::accounts::store::Store::open(&dir.join("accounts.sqlite")).expect("accounts");
    let a = accounts
        .sign_in(TEST_ISSUER, "person", 1)
        .expect("signed in");
    let pairing = directoryd::pairing::Pairing::open(
        &dir.join("pairing.sqlite"),
        Some(dir.join("gateway-tokens")),
        "http://127.0.0.1:1",
    )
    .expect("pairing");
    let secret = to_hex(&[7u8; 32]);
    let asked = pairing
        .ask(
            &directoryd::pairing::Ask {
                secret_hash: sha256(secret.as_bytes()),
                device: "laptop".into(),
                label: "agent".into(),
                soul: None,
                scope: "soul".into(),
                force: false,
            },
            1,
        )
        .expect("asked");
    pairing
        .approve(&a.account, &asked.code, 1)
        .expect("approved");
    assert!(matches!(
        pairing.poll(&secret, 1 + directoryd::pairing::INTERVAL),
        directoryd::pairing::Poll::Token { .. }
    ));
    let world = root.join("worlds").join("w1");
    std::fs::create_dir_all(&world).expect("world");
    let _log = sim::log::FileStore::open(&world.join("log")).expect("the log");
    let text = sim::text::Store::open_dir(&world.join("log.text"), Minter::new(Scope([1; 16])))
        .expect("text");
    let author = Id::new(Scope([2; 16]), 0).expect("an id");
    let r = text
        .write(b"hello", Audience::Everyone, author)
        .expect("words");
    text.upload(b"a picture", Audience::Everyone, author)
        .expect("an upload");
    text.remove(r, author, 1, sim::text::Grade::Erased)
        .expect("erased");
    text.close();
    drop((accounts, pairing));
}

#[test]
fn a4_every_store_on_a_machine_is_listed() {
    let root = scratch("listed");
    machine(&root);
    let list = checked_in().expect("the list reads");
    assert!(list.iter().any(|e| e.copy == Copy::TextStore));
    assert_eq!(
        unlisted(&root, &list),
        Vec::<String>::new(),
        "every store has a line in stores.json"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a4_an_unlisted_store_fails() {
    let root = scratch("unlisted");
    machine(&root);
    // A store a later task adds (W6's bookmarks, say) without its line.
    std::fs::write(root.join("directory").join("bookmarks.sqlite"), b"x").expect("planted");
    std::fs::write(root.join("worlds").join("w1").join("notes"), b"x").expect("planted");
    let list = checked_in().expect("the list reads");
    assert_eq!(
        unlisted(&root, &list),
        vec![
            "directory/bookmarks.sqlite".to_owned(),
            "worlds/w1/notes".to_owned()
        ]
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_line_without_its_copy_or_over_the_bar_is_refused() {
    let line = |copy: &str, ship: u64| {
        format!(
            r#"{{"stores":[{{"name":"x","owner":"o","path":"p","kind":"file","copy":"{copy}","ship_s":{ship}}}]}}"#
        )
    };
    assert!(list(&line("file", 270)).is_ok());
    assert_eq!(list(&line("rsync", 270)).unwrap_err().name, "stores-list");
    assert_eq!(list(&line("file", 301)).unwrap_err().name, "stores-list");
}

#[test]
fn a_sealed_copy_opens_only_under_its_key_and_name() {
    let k = backup::Key::from_passphrase(b"a passphrase long enough").expect("key");
    let sealed = k.seal("store/a", b"words").expect("sealed");
    assert_eq!(k.open("store/a", &sealed).expect("opens"), b"words");
    assert_eq!(
        k.open("store/b", &sealed).unwrap_err().name,
        "backup-sealed"
    );
    let other = backup::Key::from_passphrase(b"another passphrase, long").expect("key");
    assert_eq!(
        other.open("store/a", &sealed).unwrap_err().name,
        "backup-sealed"
    );
}
