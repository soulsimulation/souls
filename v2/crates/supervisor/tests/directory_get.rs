//! #1960 B7: `supervisor directory-get` reads the store the directory uses, the bucket `DIRECTORY_STORE_URL` names
//! (here the S3 stand-in) or else the folder `$WORLDS_ROOT/directory`, so W3b's placement tools read what the
//! directory wrote.
use std::process::Command;

use directoryd::directory::s3::S3;
use directoryd::directory::stand_in::{KEY_ID, StandIn};
use directoryd::directory::store::{Store, When};

fn get(root: &std::path::Path, key: &str, env: &[(&str, &str)]) -> (i32, Vec<u8>) {
    let out = Command::new(env!("CARGO_BIN_EXE_supervisor"))
        .args(["directory-get", key])
        .env_clear()
        .env("WORLDS_ROOT", root)
        .envs(env.iter().copied())
        .output()
        .unwrap();
    (out.status.code().unwrap_or(-1), out.stdout)
}

#[test]
fn b7_directory_get_reads_the_bucket_when_named_else_the_folder() {
    let root =
        std::env::temp_dir().join(format!("supervisor-directory-get-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("directory/world-name")).unwrap();
    std::fs::write(root.join("directory/world-list"), b"the folder's list").unwrap();

    let s = StandIn::start(100).unwrap();
    let url = format!("{}/directory", s.url("souls"));
    let var = |k: &str| match k {
        "AWS_ACCESS_KEY_ID" => KEY_ID.to_owned(),
        "AWS_SECRET_ACCESS_KEY" => "stand-in-secret".to_owned(),
        _ => String::new(),
    };
    let bucket = S3::from_url(&url, var).unwrap();
    bucket
        .put("world-list", b"the bucket's list", When::Absent)
        .unwrap();
    bucket
        .put("world-name/new-world", &[0xa5, 1, 2], When::Absent)
        .unwrap();
    let env = [
        ("DIRECTORY_STORE_URL", url.as_str()),
        ("AWS_ACCESS_KEY_ID", KEY_ID),
        ("AWS_SECRET_ACCESS_KEY", "stand-in-secret"),
    ];

    assert_eq!(
        get(&root, "world-list", &env),
        (0, b"the bucket's list".to_vec())
    );
    assert_eq!(
        get(&root, "world-name/new-world", &env),
        (0, vec![0xa5, 1, 2])
    );
    assert_eq!(
        get(&root, "world-create/absent", &env).0,
        3,
        "none there: exit 3"
    );
    // Without a bucket named, the folder the directory keeps on a machine without one.
    assert_eq!(
        get(&root, "world-list", &[]),
        (0, b"the folder's list".to_vec())
    );
    assert_eq!(get(&root, "world-name/new-world", &[]).0, 3);
    // A key is plain words: no way out of the folder or the prefix.
    for bad in [
        "../world-list",
        "world-name/../x",
        "/world-list",
        "World-List",
        "",
    ] {
        assert_eq!(get(&root, bad, &[]).0, 2, "{bad:?} refused");
    }
    // A bucket named but out of reach is a refusal, never the folder's answer.
    let gone = [
        ("DIRECTORY_STORE_URL", "s3:http://127.0.0.1:9/souls"),
        ("AWS_ACCESS_KEY_ID", KEY_ID),
    ];
    assert_eq!(get(&root, "world-list", &gone).0, 2);
    let _ = std::fs::remove_dir_all(&root);
}
