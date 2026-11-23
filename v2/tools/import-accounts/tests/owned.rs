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

/// 0.131 a1: the operator's TEST Souls are no person's: counted apart, not brought, and the import stays clean; a live
/// Soul of any other unknown owner still makes it unclean.
#[test]
fn operator_test_souls_are_counted_not_brought() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("import-accounts-operator");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("set/worlds")).unwrap();
    backup(&dir.join("set"));
    let db = Connection::open(dir.join("set/worlds/garden.db")).unwrap();
    db.execute(
        "INSERT INTO souls VALUES ('t1', 'garden', ?1, 't1', 'Test1', '', NULL, 0)",
        [import_accounts::OPERATOR_ACCOUNT],
    )
    .unwrap();
    let r = import_accounts::import(&dir.join("set"), &[], &dir.join("out")).unwrap();
    let row = &r.worlds[0];
    assert_eq!(
        (row.live, row.brought, row.operator, row.unowned),
        (3, 2, 1, 0)
    );
    assert!(r.clean(), "{r:?}");
    db.execute(
        "INSERT INTO souls VALUES ('u1', 'garden', 'acct_nobody', 'u1', 'U', '', NULL, 0)",
        [],
    )
    .unwrap();
    let r = import_accounts::import(&dir.join("set"), &[], &dir.join("out2")).unwrap();
    assert_eq!(r.worlds[0].unowned, 1);
    assert!(!r.clean());
}

#[test]
fn b15_mapped_released_births() {
    use serde_json::{Value, json};
    let dir =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("b15-mapped-{}", std::process::id()));
    assert!(!dir.exists(), "every attempt retains a fresh fixture");
    std::fs::create_dir_all(dir.join("set/worlds")).unwrap();
    backup(&dir.join("set"));
    let prepared = std::env::var_os("B15_BODY_ASSETS").map(PathBuf::from);
    assert!(
        std::env::var_os("B15_REQUIRE_PREPARED").is_none() || prepared.is_some(),
        "the prepared caller requires real input"
    );
    let catalogue = if let Some(prepared) = &prepared {
        std::fs::read(prepared.join("bodies.json")).unwrap()
    } else {
        serde_json::to_vec(&json!({"format":"souls/bodies/1", "legacyDefaults":[null,{"family":"humanoid"},{"family":"humanoid","type":"humanoid"},{"family":"humanoid","model":"humanoid2-0000000000000000","params":{}}], "bodies":[
          {"preset":"duck","hash":"11".repeat(32),"size":"small","height":900,"hover":0,"legacy":[{"family":"floater","type":"creature","model":"duck","radius":0.33,"hoverHeight":0.54}]},
          {"preset":"test-scan","hash":"22".repeat(32),"size":"standard","height":1750,"hover":0,"legacy":[{"family":"floater","type":"ceramic","model":"test-scan","modelUrl":"/world-assets/littlemartians/characters/test-scan.glb","avatar":{"kind":"body","modelUrl":"/world-assets/littlemartians/characters/test-scan.glb","bodyType":"ceramic"},"radius":0.35,"hoverHeight":1.45}]}
        ]})).unwrap()
    };
    let catalogue_path = dir.join("bodies.json");
    std::fs::write(&catalogue_path, &catalogue).unwrap();
    let data: Value = serde_json::from_slice(&catalogue).unwrap();
    let entries = data["bodies"].as_array().unwrap();
    if prepared.is_some() {
        assert_eq!(entries.len(), 20);
    }
    let set_body = |body: Value| {
        let db = Connection::open(dir.join("set/worlds/garden.db")).unwrap();
        db.execute("DELETE FROM snapshots", []).unwrap();
        db.execute(
            "INSERT INTO snapshots VALUES ('garden',1,?1)",
            [json!({"entities":{"s1":{"body":body}}}).to_string()],
        )
        .unwrap();
    };
    let mut choices = entries
        .iter()
        .flat_map(|e| {
            e["legacy"]
                .as_array()
                .unwrap()
                .iter()
                .map(move |body| (body.clone(), e["hash"].as_str().map(str::to_owned)))
        })
        .collect::<Vec<_>>();
    choices.extend(
        data["legacyDefaults"]
            .as_array()
            .unwrap()
            .iter()
            .map(|body| (body.clone(), None)),
    );
    for (i, (body, expected)) in choices.iter().enumerate() {
        set_body(body.clone());
        let out = dir.join(format!("choice-{i}"));
        assert!(
            import_accounts::import_with_bodies(&dir.join("set"), &[], &out, Some(&catalogue_path))
                .unwrap()
                .clean()
        );
        let births: Value =
            serde_json::from_slice(&std::fs::read(out.join("births/garden.json")).unwrap())
                .unwrap();
        let db = Connection::open(out.join("accounts.sqlite")).unwrap();
        let soul: String = db
            .query_row(
                "SELECT soul FROM imported_souls_v1 WHERE old_soul='s1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let birth = births["births"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["soul"] == soul)
            .unwrap();
        assert_eq!(
            birth.get("body").and_then(Value::as_str),
            expected.as_deref()
        );
        let look: String = db
            .query_row("SELECT look FROM souls_v1 WHERE soul=?1", [soul], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            look,
            replica::encode::to_hex(
                ring::digest::digest(&ring::digest::SHA256, body.to_string().as_bytes()).as_ref()
            )
        );
    }
    let with_url = entries
        .iter()
        .find(|e| e["legacy"][0].get("modelUrl").is_some())
        .unwrap();
    let mut alias = with_url["legacy"][0].clone();
    let url = alias.get_mut("modelUrl").unwrap();
    *url = Value::String(format!("/w/garden{}", url.as_str().unwrap()));
    if let Some(url) = alias.get_mut("avatar").and_then(|v| v.get_mut("modelUrl")) {
        *url = Value::String(format!("/w/garden{}", url.as_str().unwrap()));
    }
    set_body(alias.clone());
    assert!(
        import_accounts::import_with_bodies(
            &dir.join("set"),
            &[],
            &dir.join("alias"),
            Some(&catalogue_path)
        )
        .unwrap()
        .clean()
    );
    alias["modelUrl"] = Value::String(
        alias["modelUrl"]
            .as_str()
            .unwrap()
            .replace("/w/garden/", "/w/foreign/"),
    );
    // A body the catalogue cannot carry comes in the default body, counted by reason, its old body kept privately; the
    // Soul is never dropped and the import stays clean. The shapes production's restored set held (0.131 a1: looks
    // made in today's humanoid editor), and the others the mapping cannot place.
    for (i, (body, reason)) in [
        (alias, "url-form"),
        (
            json!({"family":"floater","modelUrl":"https://elsewhere.example/a.glb"}),
            "url-form",
        ),
        (json!({"family":"humanoid","model":"unknown-custom"}), "unknown-definition"),
        (json!({}), "unknown-definition"),
        (
            json!({"family":"humanoid","model":"humanoid2-0000000000000000","params":{"height":2}}),
            "custom-humanoid",
        ),
        (
            json!({"family":"humanoid","model":"humanoid2-00000000000000ab","params":{"hair":"bob","skin":"#a07050","top":"tee"}}),
            "custom-humanoid",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        set_body(body.clone());
        let out = dir.join(format!("defaulted-{i}"));
        let report =
            import_accounts::import_with_bodies(&dir.join("set"), &[], &out, Some(&catalogue_path))
                .unwrap();
        assert!(report.clean(), "{reason}: {report:?}");
        let row = &report.worlds[0];
        assert_eq!((row.live, row.brought), (2, 2), "{reason}: every live Soul is brought");
        assert_eq!(
            row.defaulted,
            std::collections::BTreeMap::from([(reason.to_owned(), 1)])
        );
        let births: Value =
            serde_json::from_slice(&std::fs::read(out.join("births/garden.json")).unwrap())
                .unwrap();
        let db = Connection::open(out.join("accounts.sqlite")).unwrap();
        let soul: String = db
            .query_row("SELECT soul FROM imported_souls_v1 WHERE old_soul='s1'", [], |r| r.get(0))
            .unwrap();
        let birth = births["births"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["soul"] == soul)
            .unwrap();
        assert!(birth.get("body").is_none(), "{reason}: born in the default body");
        let kept: (String, String) = db
            .query_row("SELECT reason, body FROM legacy_looks_v1 WHERE soul=?1", [&soul], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(kept.0, reason);
        assert_eq!(serde_json::from_str::<Value>(&kept.1).unwrap(), body);
        drop(db);
        // A second run changes nothing.
        let again =
            import_accounts::import_with_bodies(&dir.join("set"), &[], &out, Some(&catalogue_path))
                .unwrap();
        assert_eq!(again.hash, report.hash);
    }
    set_body(entries[0]["legacy"][0].clone());
    let out =
        std::env::var_os("B15_IMPORT_OUTPUT").map_or_else(|| dir.join("stable"), PathBuf::from);
    assert!(!out.exists(), "the caller supplies a fresh private output");
    let a = import_accounts::import_with_bodies(&dir.join("set"), &[], &out, Some(&catalogue_path))
        .unwrap();
    let b = import_accounts::import_with_bodies(&dir.join("set"), &[], &out, Some(&catalogue_path))
        .unwrap();
    assert!(a.clean() && b.clean());
    assert_eq!(a.hash, b.hash);
    let mut contradictory = data.clone();
    contradictory["bodies"][1]["legacy"] = contradictory["bodies"][0]["legacy"].clone();
    std::fs::write(&catalogue_path, contradictory.to_string()).unwrap();
    let out = dir.join("contradictory");
    assert!(
        import_accounts::import_with_bodies(&dir.join("set"), &[], &out, Some(&catalogue_path))
            .unwrap_err()
            .contains("contradictory")
    );
    assert!(!out.exists());
    let mut metadata_alias = data.clone();
    let index = entries
        .iter()
        .position(|e| e["legacy"][0].get("modelUrl").is_some())
        .unwrap();
    let value = &mut metadata_alias["bodies"][index]["legacy"][0];
    value["modelUrl"] = Value::String(format!("/w/garden{}", value["modelUrl"].as_str().unwrap()));
    std::fs::write(&catalogue_path, metadata_alias.to_string()).unwrap();
    let refused = dir.join("metadata-alias");
    assert!(
        import_accounts::import_with_bodies(&dir.join("set"), &[], &refused, Some(&catalogue_path))
            .is_err()
    );
    assert!(
        !refused.exists(),
        "public metadata cannot supply world aliases"
    );
}

#[test]
fn b15_missing_catalogue_cli_refuses_before_output() {
    let out = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("b15-cli-refused-{}", std::process::id()));
    assert!(!out.exists());
    for tail in [vec!["--bodies"], vec!["--bodies", "--json"]] {
        let result = std::process::Command::new(env!("CARGO_BIN_EXE_import-accounts"))
            .args(["not-a-backup", "--out"])
            .arg(&out)
            .args(tail)
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(2));
        assert!(
            String::from_utf8(result.stderr)
                .unwrap()
                .starts_with("usage: import-accounts")
        );
        assert!(!out.exists());
    }
}
