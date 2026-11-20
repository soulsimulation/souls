//! W17: a protected local fence wins during an outage without blocking another world's valid pin cache.
use directoryd::directory::store::{Memory, Store, When};
use replica::ids::{Id, Scope};
use supervisor::{From, World, archive_guard, pin, set_pin};

#[test]
fn w17_fence_permissions_identity_and_outage_preserve_other_world_launch() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.local");
    std::fs::create_dir_all(&root).unwrap();
    let dir = root.join(format!("w17-supervisor-{}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    let fences = dir.join("fences");
    std::fs::create_dir(&fences).unwrap();
    let store = Memory::default();
    let a = World {
        lineage: [3; 16],
        zone: Id::new(Scope([4; 16]), 0).unwrap(),
    };
    let b = World {
        lineage: [5; 16],
        zone: a.zone,
    };
    let build = replica::ids::Hash::of(replica::ids::Purpose::Fixture, b"archive-world").to_bytes();
    set_pin(&store, &a, &build).unwrap();
    set_pin(&store, &b, &build).unwrap();
    pin(&store, &dir, &a).unwrap();
    pin(&store, &dir, &b).unwrap();
    assert!(archive_guard(&store, &fences, &a).is_ok());
    let file = fences.join(a.name());
    let bytes = format!(
        "{{\"format\":\"souls/archive-fence/1\",\"instance\":\"{}\",\"request\":\"{}\"}}",
        a.name(),
        "a".repeat(64)
    );
    std::fs::write(&file, bytes).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fences, std::fs::Permissions::from_mode(0o750)).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o640
    );
    store.set_reachable(false);
    assert_eq!(
        archive_guard(&store, &fences, &a),
        Err("world-archived".into())
    );
    assert!(archive_guard(&store, &fences, &b).is_ok());
    assert_eq!(pin(&store, &dir, &b).unwrap().1, From::Cache);
    std::fs::write(&file, b"not a valid fence").unwrap();
    assert_eq!(
        archive_guard(&store, &fences, &a),
        Err("archive-fence-invalid".into())
    );
    store.set_reachable(true);
    std::fs::remove_file(&file).unwrap();
    store
        .put("world-list", b"not a list", When::Absent)
        .unwrap();
    assert_eq!(
        archive_guard(&store, &fences, &a),
        Err("list-not-a-list".into())
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
