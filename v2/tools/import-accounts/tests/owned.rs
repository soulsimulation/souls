//! V13c (#3418) A1: the accounts import records every imported Soul, with its own body for the page to follow, and
//! every world's creator under its owner, in W1's store, where the session exchange reads what an account owns.

use directoryd::accounts::store::Store;
use directoryd::accounts::view::{follow_of, is_grant};
use rusqlite::{Connection, params};
use std::path::{Path, PathBuf};

const ADA: &str = "acct_00000000-0000-4000-8000-00000000000a";
const BEA: &str = "acct_00000000-0000-4000-8000-00000000000b";

fn scratch() -> PathBuf {
    let d = Path::new(env!("CARGO_TARGET_TMPDIR")).join("import-accounts-v13c");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("set/worlds")).unwrap();
    d
}

/// A backup set in today's shape, the columns the import reads and no more: Ada creates `garden` and owns two Souls
/// there, one retired; Bea owns one.
fn backup(set: &Path) {
    for (file, rows) in [
        ("accounts.sqlite", vec![(ADA, "Ada"), (BEA, "Bea")]),
        ("forks-accounts.sqlite", vec![]),
    ] {
        let db = Connection::open(set.join(file)).unwrap();
        db.execute_batch(
            "CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY, issuer TEXT, subject TEXT, created_at INTEGER)",
        )
        .unwrap();
        for (id, subject) in rows {
            db.execute(
                "INSERT INTO provider_accounts_v1 VALUES (?1, 'test:local', ?2, 0)",
                params![id, subject],
            )
            .unwrap();
        }
    }
    std::fs::write(
        set.join("worlds.json"),
        format!(r#"[{{"slug":"garden","owner":"{ADA}"}}]"#),
    )
    .unwrap();
    let db = Connection::open(set.join("worlds/garden.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE worlds(id TEXT PRIMARY KEY);
         CREATE TABLE snapshots(world_id TEXT, tick INTEGER, snapshot TEXT);
         CREATE TABLE souls(id TEXT, world_id TEXT, owner TEXT, entity_id TEXT, name TEXT, description TEXT,
           retired_at INTEGER, created_at INTEGER);
         INSERT INTO worlds VALUES ('garden');",
    )
    .unwrap();
    for (id, owner, gone) in [("s1", ADA, None), ("s2", ADA, Some(5)), ("s3", BEA, None)] {
        db.execute(
            "INSERT INTO souls VALUES (?1, 'garden', ?2, ?1, ?1, '', ?3, 0)",
            params![id, owner, gone],
        )
        .unwrap();
    }
}

#[test]
fn v13c_a1_the_import_records_every_soul_and_world_under_its_owner() {
    let dir = scratch();
    backup(&dir.join("set"));
    let out = dir.join("out");
    let first = import_accounts::import(&dir.join("set"), &[], &out).unwrap();
    // A second run changes nothing: the grants are written once.
    let second = import_accounts::import(&dir.join("set"), &[], &out).unwrap();
    assert_eq!(first.hash, second.hash);

    let store = Store::open(&out.join("accounts.sqlite")).unwrap();
    let ada = store.grants(ADA).unwrap();
    let bea = store.grants(BEA).unwrap();
    println!("v13c a1: Ada owns {ada:?}; Bea owns {bea:?}");
    // Ada: her live Soul (the retired one is not brought), with its own body followed, and the world she creates.
    let souls =
        |g: &[(String, Option<String>)]| g.iter().filter(|(t, _)| t.starts_with("soul-")).count();
    assert_eq!((souls(&ada), souls(&bea)), (1, 1));
    for (grant, follow) in ada.iter().chain(&bea) {
        assert!(is_grant(grant), "{grant}");
        assert_eq!(follow, &follow_of(grant));
    }
    assert_eq!(
        ada.iter()
            .filter(|(t, f)| t.starts_with("creator-") && f.is_none())
            .count(),
        1
    );
    assert!(bea.iter().all(|(t, _)| !t.starts_with("creator-")));
    // Each Soul's grant is the one minted for it (the store is closed first: it holds its file alone).
    drop(store);
    let db = Connection::open(out.join("accounts.sqlite")).unwrap();
    let minted: Vec<(String, String)> = db
        .prepare("SELECT account_id, soul FROM souls_v1 ORDER BY account_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for (acct, soul) in minted {
        let (scope, counter) = soul.split_once(':').unwrap();
        let want = format!("soul-{scope}-{counter}");
        let owned = if acct == ADA { &ada } else { &bea };
        assert!(owned.iter().any(|(g, _)| *g == want), "{acct} owns {want}");
    }
}
