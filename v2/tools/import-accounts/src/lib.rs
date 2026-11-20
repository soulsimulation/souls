//! Engine v2 X11 (#2820): accounts, Souls and creators brought over from a stage's backup, apart from the worlds'
//! content (X6) and the owners' memory (R18). See README.md.
//!
//! - **Reads only the backup.** A set as today's nightly backup writes it (`tools/world-launcher/deploy/backup.mjs`):
//!   `accounts.sqlite` (the stage's registry), `forks-accounts.sqlite` (the original worlds' own registry),
//!   `worlds.json` (each world's creator) and `worlds/<slug>.db`. Every file opens read-only and immutable. From a
//!   world it reads the `souls` rows by named columns (never a token column), the latest snapshot for each Soul's
//!   body, and the world's meta for its creator when `worlds.json` has no row.
//! - **Accounts** go into W1's store (`directoryd::accounts::store`) in today's mapping shape, with the same ids. The
//!   two registries merge by (issuer, subject): a person both know keeps the stage's id, and the old worlds' id for
//!   them is kept as an alias of it. Each account gets W1's principal id, the only id a world sees.
//! - **Each Soul** gets a global id minted as the directory mints (16 random bytes, counter 0), one record in W8's
//!   directory at its world (`Directory::set_place`), and one birth in K10's `Birth` shape (soul, entry, asked) at
//!   its world's arrival point, the first thing in the new history. Its name, description and look (its body's
//!   family, today's preset and the SHA-256 of today's body) are kept with its account. A retired Soul is not brought.
//! - **Each world** keeps its creator, as the account and its principal id.
//! - **Ownership (V13c):** each Soul brought is recorded as its account's (`account_grants_v1`, its `soul-…` grant and
//!   its own body for the page to follow), and each creator account as owning its `creator-…` grant, so the owner's
//!   web session exchanges for a view of them.
//! - **Private:** the table of old to new Soul ids, the aliases and the Souls' details stay in the account store for
//!   R18. The births and the directory hold no account id; the row prints counts only.
//! - **A second run changes nothing:** ids already minted are read back, every write is "insert if absent", and the
//!   state hash (over the store's rows, the directory's objects and the births) is equal.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use directoryd::accounts::view::{follow_of, grant_text};
use directoryd::accounts::{principal_text, random, store::Store as Accounts};
use directoryd::directory::Directory;
use directoryd::directory::store::{Object, R as DirR, Store, When, refuse};
use replica::directory::Place;
use replica::encode::{Name, to_hex};
use replica::ids::{Id, Scope};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::Value as Json;

type R<T> = Result<T, String>;

/// The one body family v2 has a kind for (`content/kinds/body/humanoid.json`); until B15 (#2750) every Soul is
/// brought in it, and a body today's preset puts in another family is counted as having no kind.
pub const DEFAULT_FAMILY: &str = "eden:humanoid";

fn sha256(bytes: &[u8]) -> Vec<u8> {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .to_vec()
}

/// The world's lineage and zone, as the content import names them (`v2/tools/import-eden`: the world's scope is the
/// first 16 bytes of SHA-256 of `souls/import-eden/<world>`, its root the zone's id, counter 0).
pub fn world_zone(world: &str) -> ([u8; 16], Id) {
    let mut scope = [0u8; 16];
    scope.copy_from_slice(&sha256(format!("souls/import-eden/{world}").as_bytes())[..16]);
    (scope, Id::new(Scope(scope), 0).expect("counter 0 is an id"))
}

// --- Reading the backup ---------------------------------------------------------------------------------------------

/// Opens a backup file read-only and immutable: no lock, no journal, no write.
fn open_backup(path: &Path) -> R<Connection> {
    if !path.is_file() {
        return Err(format!("{}: not a file", path.display()));
    }
    let abs = fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Connection::open_with_flags(
        format!("file:{}?immutable=1", abs.display()),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Clone, Debug)]
struct Account {
    id: String,
    issuer: String,
    subject: String,
    created_at: i64,
}

fn registry(path: &Path) -> R<Vec<Account>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = open_backup(path)?;
    let mut q = db
        .prepare("SELECT account_id, issuer, subject, created_at FROM provider_accounts_v1 ORDER BY account_id")
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let rows = q
        .query_map([], |r| {
            Ok(Account {
                id: r.get(0)?,
                issuer: r.get(1)?,
                subject: r.get(2)?,
                created_at: r.get(3)?,
            })
        })
        .and_then(|r| r.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(rows)
}

/// A live Soul as the backup holds it.
#[derive(Clone, Debug)]
struct OldSoul {
    id: String,
    owner: String,
    name: String,
    description: String,
    /// Today's body (`null` for the default humanoid), as the latest snapshot holds it.
    body: Json,
}

/// A world as the backup holds it.
struct OldWorld {
    world: String,
    creator: Option<String>,
    live: Vec<OldSoul>,
    retired: usize,
}

/// The entity bodies in a snapshot: every `entities` map in it, by entity id.
fn bodies(snapshot: &Json, out: &mut BTreeMap<String, Json>) {
    match snapshot {
        Json::Object(m) => {
            if let Some(Json::Object(es)) = m.get("entities") {
                for (id, e) in es {
                    if let Some(b) = e.get("body") {
                        out.insert(id.clone(), b.clone());
                    }
                }
            }
            for v in m.values() {
                bodies(v, out);
            }
        }
        Json::Array(a) => a.iter().for_each(|v| bodies(v, out)),
        _ => {}
    }
}

fn read_world(path: &Path, creators: &BTreeMap<String, String>) -> R<OldWorld> {
    let db = open_backup(path)?;
    let e = |e: rusqlite::Error| format!("{}: {e}", path.display());
    let worlds: Vec<String> = db
        .prepare("SELECT id FROM worlds ORDER BY id")
        .and_then(|mut q| q.query_map([], |r| r.get(0))?.collect())
        .map_err(e)?;
    let [world] = worlds.as_slice() else {
        return Err(format!(
            "{}: holds {} worlds, not one",
            path.display(),
            worlds.len()
        ));
    };
    // The creator: the launcher's row for the file's slug, else the world's own meta.
    let slug = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let mut creator = creators.get(slug).cloned();
    if creator.is_none() {
        let meta: Option<String> = db
            .query_row(
                "SELECT body FROM world_meta_v1 WHERE world_id = ?1",
                [world],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);
        creator = meta
            .and_then(|m| serde_json::from_str::<Json>(&m).ok())
            .and_then(|m| m.get("owner").and_then(Json::as_str).map(str::to_owned));
    }
    let snapshot: Option<String> = db
        .query_row(
            "SELECT snapshot FROM snapshots WHERE world_id = ?1 ORDER BY tick DESC LIMIT 1",
            [world],
            |r| r.get(0),
        )
        .optional()
        .map_err(e)?;
    let mut body = BTreeMap::new();
    if let Some(s) = snapshot {
        bodies(
            &serde_json::from_str(&s).map_err(|x| format!("{}: snapshot: {x}", path.display()))?,
            &mut body,
        );
    }
    // Named columns only: no token, no token hash is ever read.
    let mut q = db
        .prepare(
            "SELECT id, owner, entity_id, name, description, retired_at FROM souls WHERE world_id = ?1
             ORDER BY created_at, id",
        )
        .map_err(e)?;
    let rows: Vec<(String, String, String, String, String, Option<i64>)> = q
        .query_map([world], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .and_then(|r| r.collect())
        .map_err(e)?;
    let (mut live, mut retired) = (Vec::new(), 0);
    for (id, owner, entity, name, description, gone) in rows {
        if gone.is_some() {
            retired += 1;
            continue;
        }
        live.push(OldSoul {
            id,
            owner,
            name,
            description,
            body: body.get(&entity).cloned().unwrap_or(Json::Null),
        });
    }
    Ok(OldWorld {
        world: world.clone(),
        creator,
        live,
        retired,
    })
}

/// A Soul's look: the v2 family it is brought in, today's preset, and the SHA-256 of today's body (its JSON, keys in
/// order). `true` when today's body has no v2 kind and the default family stands in for it.
fn look(body: &Json) -> (String, String, String, bool) {
    let family = body
        .get("family")
        .and_then(Json::as_str)
        .unwrap_or("humanoid");
    let preset = body
        .get("model")
        .and_then(Json::as_str)
        .unwrap_or(family)
        .to_owned();
    let hash = to_hex(&sha256(body.to_string().as_bytes()));
    (
        DEFAULT_FAMILY.to_owned(),
        preset,
        hash,
        family != "humanoid",
    )
}

/// Public released definitions are mapping data, never account or mint authority.
struct LegacyBodies {
    hash: String,
    defaults: Vec<Json>,
    definitions: Vec<(Json, String)>,
}

fn normalized_body(body: &Json, world: &str) -> R<Json> {
    let mut body = body.clone();
    let Some(fields) = body.as_object_mut() else {
        return Ok(body);
    };
    fn url(value: &mut Json, world: &str) -> R<()> {
        let text = value.as_str().ok_or("body.legacy-unavailable")?;
        let prefix = format!("/w/{world}");
        let text = text
            .strip_prefix(&prefix)
            .filter(|tail| tail.starts_with('/'))
            .unwrap_or(text);
        if text.contains(['?', '#', '%'])
            || !(text.starts_with("/v1/edge/body/assets/body_")
                || text.starts_with("/world-assets/littlemartians/characters/"))
        {
            return Err("body.legacy-unavailable".into());
        }
        *value = Json::String(text.to_owned());
        Ok(())
    }
    if let Some(value) = fields.get_mut("modelUrl") {
        url(value, world)?;
    }
    if let Some(value) = fields
        .get_mut("avatar")
        .and_then(Json::as_object_mut)
        .and_then(|v| v.get_mut("modelUrl"))
    {
        url(value, world)?;
    }
    Ok(body)
}

impl LegacyBodies {
    fn read(path: &Path) -> R<Self> {
        let metadata = fs::symlink_metadata(path).map_err(|_| "body.catalogue-unavailable")?;
        if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
            return Err("body.catalogue-invalid".into());
        }
        let bytes = fs::read(path).map_err(|_| "body.catalogue-unavailable")?;
        let text = std::str::from_utf8(&bytes).map_err(|_| "body.catalogue-invalid")?;
        let catalogue = skills::wear::Catalogue::read(text)?;
        let data: Json = serde_json::from_str(text).map_err(|_| "body.catalogue-invalid")?;
        let defaults = data
            .get("legacyDefaults")
            .and_then(Json::as_array)
            .ok_or("body.legacy-defaults")?
            .clone();
        let fixed = [
            Json::Null,
            serde_json::json!({"family":"humanoid"}),
            serde_json::json!({"family":"humanoid","type":"humanoid"}),
        ];
        if defaults.len() != 4
            || defaults[..3] != fixed
            || defaults[3].as_object().is_none_or(|d| d.len() != 3)
            || defaults[3].get("family").and_then(Json::as_str) != Some("humanoid")
            || defaults[3].get("params") != Some(&serde_json::json!({}))
            || defaults[3]
                .get("model")
                .and_then(Json::as_str)
                .is_none_or(|s| {
                    s.len() != 26
                        || !s.starts_with("humanoid2-")
                        || !s[10..].bytes().all(|c| c.is_ascii_hexdigit())
                })
        {
            return Err("body.legacy-defaults".into());
        }
        let mut definitions: Vec<(Json, String)> = Vec::new();
        let rows = data
            .get("bodies")
            .and_then(Json::as_array)
            .ok_or("body.catalogue-invalid")?;
        if rows.len() > 128 {
            return Err("body.catalogue-invalid".into());
        }
        for entry in rows {
            let hash = entry
                .get("hash")
                .and_then(Json::as_str)
                .ok_or("body.catalogue-invalid")?;
            if catalogue.find(hash).is_none() {
                return Err("body.catalogue-invalid".into());
            }
            let legacy = entry
                .get("legacy")
                .and_then(Json::as_array)
                .ok_or("body.legacy-unavailable")?;
            if legacy.is_empty() || legacy.len() > 8 {
                return Err("body.catalogue-invalid".into());
            }
            for definition in legacy {
                if defaults.contains(definition) {
                    return Err("body.legacy-contradictory".into());
                }
                if let Some((_, held)) = definitions.iter().find(|(d, _)| d == definition) {
                    if held != hash {
                        return Err("body.legacy-contradictory".into());
                    }
                } else {
                    definitions.push((definition.clone(), hash.to_owned()));
                }
            }
        }
        Ok(Self {
            hash: to_hex(&sha256(&bytes)),
            defaults,
            definitions,
        })
    }

    fn choice(&self, body: &Json, world: &str) -> R<Option<String>> {
        let body = normalized_body(body, world)?;
        if self.defaults.contains(&body) {
            return Ok(None);
        }
        self.definitions
            .iter()
            .find(|(definition, _)| definition == &body)
            .map(|(_, hash)| Some(hash.clone()))
            .ok_or_else(|| "body.legacy-unavailable".to_owned())
    }
}

// --- The directory's objects as files -------------------------------------------------------------------------------

/// W8's object store as files under a folder, with the store's two conditions: for the cut-over's own runs, before the
/// directory's bucket is handed the result. Its ETag is the SHA-256 of the bytes, as [`directoryd`]'s `Memory`.
pub struct Files(pub PathBuf);

impl Files {
    fn path(&self, key: &str) -> PathBuf {
        self.0.join(key)
    }
}

impl Store for Files {
    fn get(&self, key: &str) -> DirR<Option<Object>> {
        match fs::read(self.path(key)) {
            Ok(bytes) => Ok(Some(Object {
                etag: to_hex(&sha256(&bytes)),
                bytes,
            })),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => refuse("store-error", format!("{key}: {e}")),
        }
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> DirR<String> {
        let now = self.get(key)?.map(|o| o.etag);
        match (when, now.as_deref()) {
            (When::Absent, None) => {}
            (When::Is(e), Some(n)) if e == n => {}
            _ => {
                return refuse(
                    "precondition-failed",
                    format!("{key}: asked {when:?}, the store holds {now:?}"),
                );
            }
        }
        let p = self.path(key);
        let tmp = p.with_extension("tmp");
        let io = |e: std::io::Error| {
            Err(replica::effects::Refusal {
                name: "store-error",
                detail: format!("{key}: {e}"),
            })
        };
        if let Some(d) = p.parent()
            && let Err(e) = fs::create_dir_all(d)
        {
            return io(e);
        }
        if let Err(e) = fs::write(&tmp, bytes).and_then(|_| fs::rename(&tmp, &p)) {
            return io(e);
        }
        Ok(to_hex(&sha256(bytes)))
    }
}

// --- The import -----------------------------------------------------------------------------------------------------

/// One world's row: counts only, never a name or an id of a person or a Soul.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorldRow {
    pub world: String,
    /// Live Souls in the backup, and retired ones (not brought).
    pub live: usize,
    pub retired: usize,
    /// Souls brought: in the store, in the directory at this world, and with a birth.
    pub brought: usize,
    /// Live Souls whose owner is no account in either registry (not brought).
    pub unowned: usize,
    /// Souls whose body today has no v2 kind, brought in the default family; by today's preset.
    pub no_kind: BTreeMap<String, usize>,
    /// The creator is an account, kept with its principal.
    pub creator: bool,
    /// Read back from the store, every live Soul (name, description, look, owner) and the creator equal the backup's.
    pub equal: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// Accounts in the stage's registry and the old worlds' registry.
    pub stage: usize,
    pub forks: usize,
    /// Old worlds' ids for a person the stage also knows: kept as aliases of the stage's id.
    pub aliases: usize,
    /// (issuer, subject) pairs whose id in the store is not the backup's: never expected.
    pub conflicts: usize,
    /// Every backup account id resolves to the account of the same (issuer, subject).
    pub accounts_equal: bool,
    pub worlds: Vec<WorldRow>,
    /// Over the store's rows, the directory's objects and the births: equal on a second run.
    pub hash: String,
}

impl Report {
    pub fn clean(&self) -> bool {
        self.conflicts == 0
            && self.accounts_equal
            && self
                .worlds
                .iter()
                .all(|w| w.equal && w.unowned == 0 && w.creator)
    }
}

/// The private tables beside W1's: aliases, the old-to-new Soul ids (for R18), the Souls' details, and the worlds'
/// creators. Never posted.
const PRIVATE: &str = "
CREATE TABLE IF NOT EXISTS account_aliases_v1(old_id TEXT PRIMARY KEY, account_id TEXT NOT NULL
  REFERENCES provider_accounts_v1(account_id));
CREATE TABLE IF NOT EXISTS imported_souls_v1(world TEXT NOT NULL, old_soul TEXT NOT NULL, soul TEXT NOT NULL UNIQUE,
  PRIMARY KEY(world, old_soul));
CREATE TABLE IF NOT EXISTS souls_v1(soul TEXT PRIMARY KEY, account_id TEXT NOT NULL
  REFERENCES provider_accounts_v1(account_id), name TEXT NOT NULL, description TEXT NOT NULL, family TEXT NOT NULL,
  preset TEXT NOT NULL, look TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS world_creators_v1(world TEXT PRIMARY KEY, lineage TEXT NOT NULL, account_id TEXT NOT NULL
  REFERENCES provider_accounts_v1(account_id));";

fn sq<T>(r: rusqlite::Result<T>) -> R<T> {
    r.map_err(|e| format!("account store: {e}"))
}

/// Brings the backup set at `set` (and any further world files, `extra`) into `out`: `out/accounts.sqlite` (W1's store
/// and the private tables), `out/directory/` (W8's objects) and `out/births/<world>.json` (K10's births).
pub fn import(set: &Path, extra: &[PathBuf], out: &Path) -> R<Report> {
    import_with_bodies(set, extra, out, None)
}

/// Mapped release mode: validate every owned live look before creating any output.
pub fn import_with_bodies(
    set: &Path,
    extra: &[PathBuf],
    out: &Path,
    bodies: Option<&Path>,
) -> R<Report> {
    let stage = registry(&set.join("accounts.sqlite"))?;
    let forks = registry(&set.join("forks-accounts.sqlite"))?;
    let creators: BTreeMap<String, String> = match fs::read_to_string(set.join("worlds.json")) {
        Ok(t) => serde_json::from_str::<Json>(&t)
            .map_err(|e| format!("worlds.json: {e}"))?
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|w| {
                        Some((
                            w.get("slug")?.as_str()?.to_owned(),
                            w.get("owner")?.as_str()?.to_owned(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    };
    let mut files: Vec<PathBuf> = match fs::read_dir(set.join("worlds")) {
        Ok(d) => d
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "db"))
            .collect(),
        Err(_) => Vec::new(),
    };
    files.sort();
    files.extend(extra.iter().cloned());
    let worlds = files
        .iter()
        .map(|f| read_world(f, &creators))
        .collect::<R<Vec<_>>>()?;

    let mapped = bodies.map(LegacyBodies::read).transpose()?;
    if let Some(catalogue) = &mapped {
        for world in &worlds {
            for soul in &world.live {
                if stage
                    .iter()
                    .chain(&forks)
                    .any(|account| account.id == soul.owner)
                {
                    catalogue.choice(&soul.body, &world.world)?;
                }
            }
        }
    }

    fs::create_dir_all(out.join("births")).map_err(|e| format!("{}: {e}", out.display()))?;
    let store_path = out.join("accounts.sqlite");
    // W1's own open makes its tables, so the file is in its shape; then this program alone writes to it.
    drop(Accounts::open(&store_path).map_err(|e| e.to_string())?);
    let mut db = sq(Connection::open(&store_path))?;
    sq(db.execute_batch(PRIVATE))?;

    let mut report = Report {
        stage: stage.len(),
        forks: forks.len(),
        ..Report::default()
    };
    let tx = sq(db.transaction())?;
    // Accounts: the stage's first, then the old worlds', merged by (issuer, subject).
    for (old, a) in stage
        .iter()
        .map(|a| (false, a))
        .chain(forks.iter().map(|a| (true, a)))
    {
        let held: Option<String> = sq(tx
            .query_row(
                "SELECT account_id FROM provider_accounts_v1 WHERE issuer = ?1 AND subject = ?2",
                params![a.issuer, a.subject],
                |r| r.get(0),
            )
            .optional())?;
        match held {
            None => {
                sq(tx.execute(
                    "INSERT INTO provider_accounts_v1(account_id, issuer, subject, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![a.id, a.issuer, a.subject, a.created_at],
                ))?;
            }
            Some(h) if h == a.id => {}
            Some(h) if old => {
                sq(tx.execute(
                    "INSERT OR IGNORE INTO account_aliases_v1(old_id, account_id) VALUES (?1, ?2)",
                    params![a.id, h],
                ))?;
                report.aliases += 1;
            }
            Some(_) => report.conflicts += 1,
        }
    }
    let accounts: Vec<String> = sq(tx
        .prepare("SELECT account_id FROM provider_accounts_v1 ORDER BY account_id")
        .and_then(|mut q| q.query_map([], |r| r.get(0))?.collect()))?;
    for a in &accounts {
        let p = Id::new(Scope(random()), 0).expect("counter 0 is an id");
        sq(tx.execute(
            "INSERT OR IGNORE INTO account_principals_v1(account_id, principal_id, created_at) VALUES (?1, ?2, 0)",
            params![a, principal_text(p)],
        ))?;
    }
    // A1: every backup id resolves, directly or by its alias, to the account of its own (issuer, subject).
    let resolve = |tx: &rusqlite::Transaction, id: &str| -> R<Option<String>> {
        sq(tx
            .query_row(
                "SELECT account_id FROM provider_accounts_v1 WHERE account_id = ?1
                 UNION SELECT account_id FROM account_aliases_v1 WHERE old_id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional())
    };
    report.accounts_equal = true;
    for a in stage.iter().chain(&forks) {
        let same: Option<String> = match resolve(&tx, &a.id)? {
            Some(id) => sq(tx
                .query_row(
                    "SELECT account_id FROM provider_accounts_v1 WHERE account_id = ?1 AND issuer = ?2 AND subject = ?3",
                    params![id, a.issuer, a.subject],
                    |r| r.get(0),
                )
                .optional())?,
            None => None,
        };
        report.accounts_equal &= same.is_some();
    }

    // Souls and creators, world by world.
    let mut dir = Directory::new(
        Files(out.join("directory")),
        Name::new("import-accounts").expect("a name"),
    );
    for w in &worlds {
        let (lineage, zone) = world_zone(&w.world);
        let mut row = WorldRow {
            world: w.world.clone(),
            live: w.live.len(),
            retired: w.retired,
            ..WorldRow::default()
        };
        if let Some(c) = &w.creator
            && let Some(acct) = resolve(&tx, c)?
        {
            sq(tx.execute(
                "INSERT OR IGNORE INTO world_creators_v1(world, lineage, account_id) VALUES (?1, ?2, ?3)",
                params![w.world, to_hex(&lineage), acct],
            ))?;
            // V13c: the account owns what it creates, as the creator grant of its principal (no body to follow).
            let principal: Option<String> = sq(tx
                .query_row(
                    "SELECT principal_id FROM account_principals_v1 WHERE account_id = ?1",
                    [&acct],
                    |r| r.get(0),
                )
                .optional())?;
            if let Some(p) = principal
                .as_deref()
                .and_then(directoryd::accounts::principal_from_text)
            {
                sq(tx.execute(
                    "INSERT OR IGNORE INTO account_grants_v1(account_id, grant_text, follow) VALUES (?1, ?2, NULL)",
                    params![acct, grant_text("creator", p)],
                ))?;
            }
            row.creator = true;
        }
        let mut births = Vec::new();
        for s in &w.live {
            let Some(acct) = resolve(&tx, &s.owner)? else {
                row.unowned += 1;
                continue;
            };
            let held: Option<String> = sq(tx
                .query_row(
                    "SELECT soul FROM imported_souls_v1 WHERE world = ?1 AND old_soul = ?2",
                    params![w.world, s.id],
                    |r| r.get(0),
                )
                .optional())?;
            let soul = match held
                .as_deref()
                .and_then(directoryd::accounts::principal_from_text)
            {
                Some(id) => id,
                None => {
                    let id = Id::new(Scope(random()), 0).expect("counter 0 is an id");
                    sq(tx.execute(
                        "INSERT INTO imported_souls_v1(world, old_soul, soul) VALUES (?1, ?2, ?3)",
                        params![w.world, s.id, principal_text(id)],
                    ))?;
                    id
                }
            };
            let (family, preset, hash, no_kind) = look(&s.body);
            if no_kind && mapped.is_none() {
                *row.no_kind.entry(preset.clone()).or_default() += 1;
            }
            sq(tx.execute(
                "INSERT OR IGNORE INTO souls_v1(soul, account_id, name, description, family, preset, look)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![principal_text(soul), acct, s.name, s.description, family, preset, hash],
            ))?;
            // V13c: the account owns the Soul, and its page follows the Soul's own body (the session exchange).
            let grant = grant_text("soul", soul);
            sq(tx.execute(
                "INSERT OR IGNORE INTO account_grants_v1(account_id, grant_text, follow) VALUES (?1, ?2, ?3)",
                params![acct, grant, follow_of(&grant)],
            ))?;
            // W8: one record, at this world; a second run finds it there.
            let here = Place::World { lineage, zone };
            let now = dir.soul(soul).map_err(|e| e.to_string())?.map(|r| r.place);
            if now.as_ref() != Some(&here) {
                dir.set_place(soul, now.as_ref(), here)
                    .map_err(|e| e.to_string())?;
            }
            // K10's Birth: the Soul, the entry it comes in by (the world's arrival point: its root until N9 declares
            // one), asked at the start of the new history.
            let mut birth = serde_json::json!({ "soul": principal_text(soul), "entry": principal_text(zone), "asked": 0 });
            if let Some(catalogue) = &mapped
                && let Some(hash) = catalogue.choice(&s.body, &w.world)?
            {
                birth["body"] = Json::String(hash);
            }
            births.push(birth);
            row.brought += 1;
        }
        let mut file = serde_json::json!({
            "format": "souls-births/1",
            "world": w.world,
            "lineage": to_hex(&lineage),
            "zone": principal_text(zone),
            "births": births,
        });
        if let Some(catalogue) = &mapped {
            file["catalogueHash"] = Json::String(catalogue.hash.clone());
        }
        fs::write(
            out.join("births").join(format!("{}.json", w.world)),
            serde_json::to_string_pretty(&file).expect("json") + "\n",
        )
        .map_err(|e| format!("births: {e}"))?;
        report.worlds.push(row);
    }
    sq(tx.commit())?;

    // A2: read back, per world: every live Soul with an owner (name, description, look, owner) and the creator.
    for (w, row) in worlds.iter().zip(report.worlds.iter_mut()) {
        let mut equal = row.brought + row.unowned == row.live;
        for s in &w.live {
            let Some(acct) = resolve_db(&db, &s.owner)? else {
                continue;
            };
            let (_, _, hash, _) = look(&s.body);
            let got: Option<(String, String, String, String)> = sq(db
                .query_row(
                    "SELECT s.account_id, s.name, s.description, s.look FROM imported_souls_v1 i
                     JOIN souls_v1 s ON s.soul = i.soul WHERE i.world = ?1 AND i.old_soul = ?2",
                    params![w.world, s.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional())?;
            equal &= got == Some((acct, s.name.clone(), s.description.clone(), hash));
        }
        let creator: Option<String> = sq(db
            .query_row(
                "SELECT account_id FROM world_creators_v1 WHERE world = ?1",
                [&w.world],
                |r| r.get(0),
            )
            .optional())?;
        let want = match &w.creator {
            Some(c) => resolve_db(&db, c)?,
            None => None,
        };
        row.equal = equal && creator == want;
    }
    report.hash = state_hash(&db, out)?;
    Ok(report)
}

fn resolve_db(db: &Connection, id: &str) -> R<Option<String>> {
    sq(db
        .query_row(
            "SELECT account_id FROM provider_accounts_v1 WHERE account_id = ?1
             UNION SELECT account_id FROM account_aliases_v1 WHERE old_id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional())
}

/// SHA-256 over every row of every table in the store (tables and rows in order), then every file under
/// `directory/` and `births/` (paths in order, with their bytes).
pub fn state_hash(db: &Connection, out: &Path) -> R<String> {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let tables: Vec<String> = sq(db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .and_then(|mut q| q.query_map([], |r| r.get(0))?.collect()))?;
    for t in tables {
        ctx.update(format!("table {t}\n").as_bytes());
        let mut q = sq(db.prepare(&format!("SELECT * FROM \"{t}\" ORDER BY 1, 2")))?;
        let n = q.column_count();
        let mut rows: Vec<String> = sq(q
            .query_map([], |r| {
                (0..n)
                    .map(|i| r.get_ref(i).map(|v| format!("{v:?}")))
                    .collect::<Result<Vec<_>, _>>()
                    .map(|v| v.join("\t"))
            })
            .and_then(|r| r.collect()))?;
        rows.sort();
        for r in rows {
            ctx.update(r.as_bytes());
            ctx.update(b"\n");
        }
    }
    let mut paths = Vec::new();
    for d in ["directory", "births"] {
        walk(&out.join(d), &mut paths);
    }
    paths.sort();
    for p in paths {
        let rel = p.strip_prefix(out).unwrap_or(&p);
        ctx.update(format!("file {}\n", rel.display()).as_bytes());
        ctx.update(&fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?);
    }
    Ok(to_hex(ctx.finish().as_ref()))
}

fn walk(d: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = fs::read_dir(d) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else {
                out.push(p);
            }
        }
    }
}
