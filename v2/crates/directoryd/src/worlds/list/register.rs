//! An imported world in the list (the 0.131 switch, #1960 B3): a world brought over from today's system (Eden, from
//! `import-world`, `worldd seed` and `place-world.sh`) is made by no create, so nothing else writes its name record and
//! its row. The operator's `register-world` writes both, in the store the directory reads, and the world-authority
//! map's entry and aliases beside them.
//!
//! 1. **The name record first**, create-only, as G9's create writes it: `{1: name, 2: lineage, 3: zone, 4: creator,
//!    5: source}`, its source sixteen zero bytes (made from no template or world). A reserved name (`eden`) is taken:
//!    reserved names are kept for the worlds an operator brings over.
//! 2. **Then the row**, on condition of the version read: `{name, label, template: "imported", lineage, zone, creator,
//!    made, ready: true}`. Its creator is the founder the name record names; later handoffs change the row alone.
//! 3. **Idempotent.** A second run with the same world changes nothing (a row since handed off or relabelled is kept as
//!    it is). A name already another world's is refused `name-taken`, the same world under another name
//!    `world-registered`, another founder for the same world `creator-differs`, a label on another creator's world
//!    `label-taken`, and nothing is written. A run stopped between the two writes is finished by the next.
//! 4. **The authority map** ([`authorize`]): `worlds.<name> = {instance, creator}` and `aliases.<alias> = <name>`,
//!    each added only when absent and refused `authority-conflict` when present and different; the file is replaced
//!    whole, keeping its mode and owner.

use super::*;

/// What an imported world is registered as.
pub struct Imported<'a> {
    pub name: &'a str,
    pub label: &'a str,
    pub lineage: [u8; 16],
    pub zone: Id,
    pub creator: Id,
    /// Seconds, the row's `made`.
    pub now: u64,
}

/// What a run did to each of the two objects: `written` or `kept`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Done {
    pub record: &'static str,
    pub row: &'static str,
}

/// A placed world's instance name, `<lineage hex>-<zone scope hex>-<zone counter>`, as its lineage and zone.
pub fn instance(text: &str) -> Option<([u8; 16], Id)> {
    let mut parts = text.split('-');
    let (l, z, n) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || l.len() != 32 || z.len() != 32 {
        return None;
    }
    let lineage: [u8; 16] = from_hex(l).ok()?.try_into().ok()?;
    Some((
        lineage,
        crate::accounts::principal_from_text(&format!("{z}:{n}"))?,
    ))
}

/// A principal as `<32 hex>:<n>` (the directory's) or `<32 hex>-<n>` (a world's `world.json`).
pub fn principal(text: &str) -> Option<Id> {
    crate::accounts::principal_from_text(text)
        .or_else(|| crate::accounts::principal_from_text(&text.replacen('-', ":", 1)))
}

fn check(rows: &[Json], w: &Imported) -> R<bool> {
    let (lineage, zone, creator) = (
        to_hex(&w.lineage),
        principal_text(w.zone),
        principal_text(w.creator),
    );
    let same = |r: &Json| {
        r.get("lineage").and_then(Json::as_str) == Some(&lineage)
            && r.get("zone").and_then(Json::as_str) == Some(&zone)
    };
    let name = |r: &Json| r.get("name").and_then(Json::as_str) == Some(w.name);
    if let Some(row) = rows.iter().find(|r| name(r)) {
        if !same(row) {
            return refuse("name-taken", format!("{} is another world's", w.name));
        }
        archive::active(row)?;
        return Ok(true);
    }
    if let Some(other) = rows.iter().find(|r| same(r)) {
        return refuse(
            "world-registered",
            format!(
                "this world is listed as {}",
                other.get("name").and_then(Json::as_str).unwrap_or("?")
            ),
        );
    }
    if rows.iter().any(|r| {
        r.get("label").and_then(Json::as_str) == Some(w.label) && row_creator(r) != Some(&creator)
    }) {
        return refuse("label-taken", w.label.to_owned());
    }
    Ok(false)
}

/// Registers the imported world `w` in `store` (rules 1 to 3).
pub fn register<S: Store>(store: &S, w: &Imported) -> R<Done> {
    match crate::worlds::create::check_name(w.name) {
        Err(e) if e.name != "name-reserved" => return Err(e),
        _ => {}
    }
    if w.label.trim() != w.label || w.label.is_empty() || w.label.chars().count() > 40 {
        return refuse(
            "label-not-allowed",
            "a label is 1 to 40 characters, no outer spaces",
        );
    }
    // Every refusal before the first write: a refused run changes nothing.
    let (_, rows) = read_rows(store)?;
    check(&rows, w)?;
    let rec = NameRecord {
        name: w.name.to_owned(),
        lineage: w.lineage,
        zone: w.zone,
        creator: w.creator,
        source: [0; 16],
    };
    let key = NameRecord::key(w.name);
    let compare = |found: &NameRecord| -> R<()> {
        if found.lineage != rec.lineage || found.zone != rec.zone || found.source != rec.source {
            refuse("name-taken", format!("{} is another world's", w.name))
        } else if found.creator != rec.creator {
            refuse(
                "creator-differs",
                format!(
                    "{} was registered with the creator {}",
                    w.name,
                    principal_text(found.creator)
                ),
            )
        } else {
            Ok(())
        }
    };
    let record = match store.get(&key)? {
        Some(o) => {
            compare(&NameRecord::read(&o.bytes)?)?;
            "kept"
        }
        None => match store.put(&key, &rec.to_bytes()?, When::Absent) {
            Ok(_) => "written",
            Err(e) if e.name == "precondition-failed" => {
                let o = store.get(&key)?.ok_or(e)?;
                compare(&NameRecord::read(&o.bytes)?)?;
                "kept"
            }
            Err(e) => return Err(e),
        },
    };
    let row = json!({
        "name": w.name, "label": w.label, "template": "imported", "lineage": to_hex(&w.lineage),
        "zone": principal_text(w.zone), "creator": principal_text(w.creator), "made": w.now, "ready": true,
    });
    let (etag, rows) = read_rows(store)?;
    let (_, row) = write_rows(store, etag, rows, |rows| {
        if check(rows, w)? {
            return Ok("kept");
        }
        rows.push(row.clone());
        Ok("written")
    })?;
    // What pairing's authority check will read: the row and the record agree, and name this founder.
    let (_, rows) = read_rows(store)?;
    let listed = rows
        .iter()
        .find(|r| r.get("name").and_then(Json::as_str) == Some(w.name))
        .ok_or_else(|| Refusal {
            name: "world-missing",
            detail: w.name.to_owned(),
        })?;
    let owner = handoff::ownership(store, listed)?;
    if owner.founder != w.creator {
        return refuse("creator-differs", w.name.to_owned());
    }
    Ok(Done { record, row })
}

/// Adds `name` (the placed `instance`, its founder `creator`) and its `aliases` to the world-authority map at `path`
/// (rule 4). Answers whether the file changed.
pub fn authorize(
    path: &Path,
    name: &str,
    instance: &str,
    creator: Id,
    aliases: &[String],
) -> R<bool> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let io = |e: std::io::Error| Refusal {
        name: "authority-io",
        detail: e.to_string(),
    };
    let meta = std::fs::symlink_metadata(path).map_err(io)?;
    if !meta.file_type().is_file() || meta.len() > 1 << 20 {
        return refuse(
            "authority-invalid",
            "the map is a regular file of at most 1 MiB",
        );
    }
    let mut map: Json = serde_json::from_slice(&std::fs::read(path).map_err(io)?)
        .or_else(|e| refuse("authority-invalid", e.to_string()))?;
    if map["format"] != "souls/world-authority/1" || !map["worlds"].is_object() {
        return refuse("authority-invalid", "not souls/world-authority/1");
    }
    if map.get("aliases").is_some_and(|a| !a.is_object()) {
        return refuse("authority-invalid", "aliases is not a map");
    }
    let creator = principal_text(creator);
    let mut changed = false;
    let worlds = map["worlds"].as_object_mut().expect("checked");
    match worlds.get(name) {
        Some(row) if row["instance"] == instance && row["creator"] == creator.as_str() => {}
        Some(_) => return refuse("authority-conflict", format!("worlds.{name} differs")),
        None => {
            if let Some((other, _)) = worlds.iter().find(|(_, r)| r["instance"] == instance) {
                return refuse(
                    "authority-conflict",
                    format!("the instance is mapped as {other}"),
                );
            }
            worlds.insert(
                name.to_owned(),
                json!({"instance": instance, "creator": creator}),
            );
            changed = true;
        }
    }
    let taken: Vec<String> = worlds.keys().cloned().collect();
    let map_aliases = map
        .as_object_mut()
        .expect("an object")
        .entry("aliases")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("checked");
    for alias in aliases {
        if !crate::pairing::souls::is_world(alias) || alias == name || taken.contains(alias) {
            return refuse("authority-conflict", format!("{alias} cannot be an alias"));
        }
        match map_aliases.get(alias) {
            Some(t) if t == name => {}
            Some(_) => return refuse("authority-conflict", format!("aliases.{alias} differs")),
            None => {
                map_aliases.insert(alias.clone(), json!(name));
                changed = true;
            }
        }
    }
    if !changed {
        return Ok(false);
    }
    let tmp = path.with_extension("json.new");
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        std::io::Write::write_all(&mut f, format!("{map}\n").as_bytes())?;
        f.set_permissions(std::fs::Permissions::from_mode(meta.mode() & 0o7777))?;
        if (meta.uid(), meta.gid()) != (f.metadata()?.uid(), f.metadata()?.gid()) {
            std::os::unix::fs::fchown(&f, Some(meta.uid()), Some(meta.gid()))?;
        }
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e)
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::directory::store::Memory;
    use replica::ids::Scope;

    fn id(n: u8, c: u64) -> Id {
        Id::new(Scope([n; 16]), c).expect("an id")
    }

    fn eden(creator: Id) -> Imported<'static> {
        Imported {
            name: "eden",
            label: "Eden",
            lineage: [0xa1; 16],
            zone: id(0xa1, 1),
            creator,
            now: 100,
        }
    }

    fn worlds(store: &Memory) -> Worlds<&Memory> {
        Worlds::new(
            Directory::new(store, Name::new("m1").expect("a name")),
            BTreeMap::new(),
            Box::new(|_| Ok(())),
        )
    }

    #[test]
    fn an_imported_world_is_listed_with_its_founder() {
        let store = Memory::default();
        let done = register(&store, &eden(id(3, 0))).expect("registered");
        assert_eq!(
            done,
            Done {
                record: "written",
                row: "written"
            }
        );
        let w = worlds(&store);
        let list = w.list().expect("a list");
        assert_eq!(list["worlds"][0]["name"], "eden");
        assert_eq!(list["worlds"][0]["template"], "imported");
        let owner = w.ownership("eden").expect("ownership");
        assert_eq!((owner.founder, owner.creator), (id(3, 0), Some(id(3, 0))));
        assert!(w.is_creator("eden", id(3, 0)).expect("read"));
        assert_eq!(
            creator_of(&store, &[0xa1; 16], id(0xa1, 1)).expect("read"),
            Some(id(3, 0))
        );
    }

    #[test]
    fn a_second_run_changes_nothing() {
        let store = Memory::default();
        register(&store, &eden(id(3, 0))).expect("registered");
        let before = (
            store.get(KEY).unwrap(),
            store.get("world-name/eden").unwrap(),
        );
        let mut again = eden(id(3, 0));
        again.now = 999;
        assert_eq!(
            register(&store, &again).expect("again"),
            Done {
                record: "kept",
                row: "kept"
            }
        );
        assert_eq!(
            (
                store.get(KEY).unwrap(),
                store.get("world-name/eden").unwrap()
            ),
            before
        );
    }

    #[test]
    fn a_run_stopped_after_the_record_is_finished_by_the_next() {
        let store = Memory::default();
        let w = eden(id(3, 0));
        let rec = NameRecord {
            name: "eden".into(),
            lineage: w.lineage,
            zone: w.zone,
            creator: w.creator,
            source: [0; 16],
        };
        store
            .put("world-name/eden", &rec.to_bytes().unwrap(), When::Absent)
            .unwrap();
        assert_eq!(
            register(&store, &w).expect("finished"),
            Done {
                record: "kept",
                row: "written"
            }
        );
    }

    #[test]
    fn a_slug_owned_by_another_world_is_refused_and_nothing_is_written() {
        let store = Memory::default();
        register(&store, &eden(id(3, 0))).expect("registered");
        let before = store.get(KEY).unwrap();
        let mut other = eden(id(3, 0));
        other.lineage = [0xb2; 16];
        assert_eq!(register(&store, &other).unwrap_err().name, "name-taken");
        let mut founder = eden(id(4, 0));
        founder.label = "Eden again";
        assert_eq!(
            register(&store, &founder).unwrap_err().name,
            "creator-differs"
        );
        let mut renamed = eden(id(3, 0));
        renamed.name = "eden-2026";
        assert_eq!(
            register(&store, &renamed).unwrap_err().name,
            "world-registered"
        );
        assert_eq!(store.get(KEY).unwrap(), before);
        assert!(store.get("world-name/eden-2026").unwrap().is_none());
    }

    #[test]
    fn a_name_record_of_another_world_is_refused_before_any_row() {
        let store = Memory::default();
        let rec = NameRecord {
            name: "eden".into(),
            lineage: [0xb2; 16],
            zone: id(0xb2, 1),
            creator: id(3, 0),
            source: [0xe0; 16],
        };
        store
            .put("world-name/eden", &rec.to_bytes().unwrap(), When::Absent)
            .unwrap();
        assert_eq!(
            register(&store, &eden(id(3, 0))).unwrap_err().name,
            "name-taken"
        );
        assert!(store.get(KEY).unwrap().is_none());
    }

    #[test]
    fn another_creators_label_and_a_bad_name_are_refused() {
        let store = Memory::default();
        register(&store, &eden(id(3, 0))).expect("registered");
        let mut garden = eden(id(4, 0));
        (garden.name, garden.lineage, garden.zone) = ("garden", [0xc3; 16], id(0xc3, 1));
        assert_eq!(register(&store, &garden).unwrap_err().name, "label-taken");
        garden.name = "Garden";
        assert_eq!(
            register(&store, &garden).unwrap_err().name,
            "name-not-allowed"
        );
    }

    #[test]
    fn the_bucket_the_settings_name_holds_it() {
        // Production's form: DIRECTORY_STORE_URL and its keys from the unit's settings file, as the directory reads them.
        let stand_in = crate::directory::stand_in::StandIn::start(100).expect("a stand-in");
        let settings = BTreeMap::from([
            ("DIRECTORY_STORE_URL", stand_in.url("souls")),
            (
                "AWS_ACCESS_KEY_ID",
                crate::directory::stand_in::KEY_ID.to_owned(),
            ),
            ("AWS_SECRET_ACCESS_KEY", "stand-in-secret".to_owned()),
        ]);
        let bucket = crate::directory::s3::S3::from_vars(|k| settings.get(k).cloned())
            .expect("a bucket")
            .expect("its settings");
        register(&bucket, &eden(id(3, 0))).expect("registered");
        assert_eq!(
            stand_in.paths(),
            vec!["souls/world-list", "souls/world-name/eden"]
        );
        let w = Worlds::new(
            Directory::new(&bucket, Name::new("m1").expect("a name")),
            BTreeMap::new(),
            Box::new(|_| Ok(())),
        );
        assert_eq!(w.ownership("eden").expect("ownership").founder, id(3, 0));
    }

    #[test]
    fn names_and_principals_read_both_forms() {
        let (l, z) =
            instance(&format!("{}-{}-7", "a1".repeat(16), "b2".repeat(16))).expect("an instance");
        assert_eq!((l, z), ([0xa1; 16], id(0xb2, 7)));
        assert!(instance("a1-b2-7").is_none());
        assert_eq!(principal(&format!("{}-0", "03".repeat(16))), Some(id(3, 0)));
        assert_eq!(principal(&format!("{}:0", "03".repeat(16))), Some(id(3, 0)));
    }

    #[test]
    fn the_authority_map_gets_the_world_and_its_aliases_once() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("register-world-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("authority.json");
        std::fs::write(
            &path,
            r#"{"format":"souls/world-authority/1","worldsRoot":"/w","worlds":{"garden":{"instance":"x","creator":"y"}}}"#,
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let inst = format!("{}-{}-1", "a1".repeat(16), "a1".repeat(16));
        let aliases = vec!["eden-2026".to_owned()];
        assert!(authorize(&path, "eden", &inst, id(3, 0), &aliases).expect("written"));
        let map: Json = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(map["worlds"]["eden"]["instance"], inst.as_str());
        assert_eq!(map["worlds"]["eden"]["creator"], principal_text(id(3, 0)));
        assert_eq!(map["worlds"]["garden"]["instance"], "x");
        assert_eq!(map["aliases"]["eden-2026"], "eden");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(!authorize(&path, "eden", &inst, id(3, 0), &aliases).expect("kept"));
        assert_eq!(
            authorize(&path, "eden", &inst, id(4, 0), &aliases)
                .unwrap_err()
                .name,
            "authority-conflict"
        );
        assert_eq!(
            authorize(&path, "eden", &inst, id(3, 0), &["garden".to_owned()])
                .unwrap_err()
                .name,
            "authority-conflict"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
