//! The list of worlds, and making one from it (Engine v2 W3, #2799).
//!
//! 1. **One object, one read.** Every world made through the directory has a row in one object, `world-list`:
//!    `{"worlds": [{name, label, template, lineage, zone, creator, made}]}`, written after G9's create on condition of
//!    the version read. Each list request reads this one authoritative object, including operator archive changes;
//!    it asks no world anything, so it wakes none. Awake or asleep comes from the
//!    world records this machine's directory has cached, never from the store or a world.
//! 2. **Create** takes a name, a template and the creator's label, and runs G9's create
//!    ([`crate::worlds::create`]) with the starter: the fork, in its own process (`worldd fork`).
//! 3. **A request key.** Each create carries the page's key for that one click. Creates are made one at a time, and
//!    the answer is kept by key, so the same key twice makes one world and answers the second with the first's world.
//! 4. **Per-account limits** ([`Limits`], today's): five worlds an account; an account in its first day two, and one
//!    an hour. A refusal names the limit and when to retry. They stop abuse and count toward no bar. They count only
//!    worlds made through New world: an imported world (its row's template [`IMPORTED`], [`register`]) counts toward
//!    no account's limits. A site owner ([`SITE_OWNERS_ENV`]) has none.
//! 5. **The label is free text, not identity.** A label already on another account's world is refused.
//! 6. **A world's settings** (W9, #2827), today's two owner switches, by its creator alone: `unlisted` takes the row
//!    off the list (the row's flag alone: it wakes no world), and `closed` closes it to visitors (today's one travel
//!    switch; it refuses nothing until travel exists, X9). Each is a field of the row, written on condition of the
//!    version read, and the list shows it from this machine's copy at once. An unlisted world stays on its own
//!    creator's list, signed in ([`Worlds::list_for`], #3698), and on nobody else's.
//! 7. **The list's picture** (G10, #2800), set by the creator with the settings, from a shot: it passes G6's check
//!    and hold point with [`PICTURE_BYTES`] and [`PICTURE_SIDE`], is kept stripped of metadata, and is one field of
//!    the world's row, `picture`, a `data:` URL; a row without one lists `picture: null`.
//! 8. **The welcome** (#3702), set by the creator ([`Worlds::set_welcome`]): words a visitor is shown on arrival, one
//!    field of the row, `welcome`, so the list carries it and a Soul's pairing answer names it.
//! 9. **The Souls in it now** (26 Nov), `souls` on each row: what the world's `health.json` on this machine says
//!    (worldd's count of the Souls embodied there, written every 2 s), under [`SOULS_ROOT_ENV`]'s folder of world
//!    folders. The files are read at most every [`SOULS_EVERY`] seconds, outside the directory's lock, so the list
//!    still asks no world anything. A world with no such file here (on another machine, never started, or the
//!    variable unset), or one written more than [`SOULS_FRESH`] seconds ago (not running here now), lists
//!    `souls: null`. The home page's card shows it.

pub mod archive;
pub mod handoff;
pub mod http;
mod placement;
pub mod register;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use replica::effects::{Refusal, read_id};
use replica::encode::{Name, Value, decode, from_hex, to_hex};
use replica::ids::{Id, sha256};
use serde_json::{Value as Json, json};

use crate::accounts::{principal_text, random};
use crate::directory::store::{R, Store, When, refuse};
use crate::directory::{Claim, Directory};
use crate::worlds::create::{Create, NameRecord, Source, create};

/// The list's one object.
pub const KEY: &str = "world-list";
/// The template an imported world's row names ([`register`]): made by no create, so it counts toward no limit.
pub const IMPORTED: &str = "imported";
/// The site's owners, canonical account ids, comma separated (the variable the ops page and the launcher read): no
/// limit of rule 4 applies to them.
pub const SITE_OWNERS_ENV: &str = "SIM_SITE_OWNERS";
/// The folder the list is kept in when no bucket is set ([`from_env`]), and its default.
pub const WORLD_STORE_ENV: &str = "DIRECTORYD_WORLD_STORE";
pub const WORLD_STORE_DEFAULT: &str = "directory";
/// The most bytes a world's list picture may have, after its metadata is stripped (rule 7).
pub const PICTURE_BYTES: u64 = 131_072;
/// The longest side of a world's list picture, px (rule 7).
pub const PICTURE_SIDE: u64 = 1280;
/// The most characters a world's welcome may have (#3702).
pub const WELCOME_MOST: usize = 500;
/// The folder that holds this machine's world folders (`<lineage hex>-<zone scope hex>-<counter>`), whose
/// `health.json` gives each listed world's Souls (rule 9); unset, the list gives none.
pub const SOULS_ROOT_ENV: &str = "DIRECTORYD_WORLDS_ROOT";
/// How old, in seconds, the Souls the list gives may be (rule 9).
pub const SOULS_EVERY: u64 = 30;
/// A world's `health.json` written longer ago than this, in seconds, gives no Souls (rule 9).
pub const SOULS_FRESH: u64 = 120;

/// A file as the list's picture (rule 7): G6's check with the picture's limits, then the hold point; the stripped
/// bytes as a `data:` URL, or the refusal's name.
pub fn list_picture(file: &[u8]) -> Result<String, String> {
    let limits = assets::check::Limits {
        bytes: PICTURE_BYTES,
        image_bytes: PICTURE_BYTES,
        side: PICTURE_SIDE,
        textures: 1,
        pixels: PICTURE_SIDE * PICTURE_SIDE,
        ..assets::check::Limits::default()
    };
    let checked = assets::check::check(file, &limits).map_err(|r| r.code.to_string())?;
    if checked.format == assets::check::Format::Glb {
        return Err("picture-format".into());
    }
    let checked = std::sync::Arc::new(checked);
    match assets::hold::judge(
        std::sync::Arc::new(assets::hold::NoClassifier),
        checked.clone(),
        assets::hold::CLASSIFY_WITHIN,
    ) {
        assets::hold::Verdict::Allow => {}
        assets::hold::Verdict::Hold(_) => return Err("picture-held".into()),
        assets::hold::Verdict::Reject(_) => return Err("picture-rejected".into()),
    }
    let mut b = crate::accounts::b64url(&checked.bytes)
        .replace('-', "+")
        .replace('_', "/");
    b.push_str(&"=".repeat((4 - b.len() % 4) % 4));
    Ok(format!("data:image/{};base64,{b}", checked.format.name()))
}

/// Per-account limits (rule 4), as settings.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Worlds an account may have.
    pub most: usize,
    /// How long an account is new, seconds.
    pub new_for: u64,
    /// Worlds a new account may make.
    pub new_most: usize,
    /// Seconds a new account waits between two worlds.
    pub new_gap: u64,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            most: 5,
            new_for: 24 * 3600,
            new_most: 2,
            new_gap: 3600,
        }
    }
}

/// A limit's refusal: its name, the limit in words, and seconds until a retry can pass (`None`: not by waiting).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Over {
    pub name: &'static str,
    pub limit: String,
    pub retry_after: Option<u64>,
}

impl Limits {
    /// Whether an account made at `account_made` may make a world at `now`, given the times it made its others.
    pub fn check(&self, account_made: u64, made: &[u64], now: u64) -> Result<(), Over> {
        if made.len() >= self.most {
            return Err(Over {
                name: "world-limit",
                limit: format!("{} worlds an account", self.most),
                retry_after: None,
            });
        }
        let new_until = account_made + self.new_for;
        if now < new_until {
            if made.len() >= self.new_most {
                return Err(Over {
                    name: "world-limit-new-account",
                    limit: format!("{} worlds in an account's first day", self.new_most),
                    retry_after: Some(new_until - now),
                });
            }
            if let Some(last) = made.iter().max()
                && now < last + self.new_gap
            {
                return Err(Over {
                    name: "world-limit-hourly",
                    limit: "one world an hour in an account's first day".into(),
                    retry_after: Some((last + self.new_gap - now).min(new_until - now)),
                });
            }
        }
        Ok(())
    }
}

/// A create, as the page sends it.
#[derive(Clone, Debug)]
pub struct Ask {
    /// The page's key for one click.
    pub key: String,
    pub name: String,
    pub template: String,
    pub label: String,
}

/// What the starter is asked to start: G9's fork of `template` as the world `name`, under `lineage`, through its
/// creator.
pub struct Start<'a> {
    pub name: &'a str,
    pub template: &'a Path,
    pub lineage: [u8; 16],
    pub creator: Id,
    pub claim: Option<&'a Claim>,
    /// Stable, creator-bound durable request identity.
    pub request: &'a str,
}

pub type Starter = Box<dyn Fn(&Start) -> R<()> + Send + Sync>;

/// A published template: its folder and its manifest's lineage and zone (`{1: name, 2: lineage, 3: zone, 4: hash}`).
#[derive(Clone, Debug)]
pub struct Template {
    pub dir: PathBuf,
    pub lineage: [u8; 16],
    pub zone: Id,
}

impl Template {
    pub fn read(dir: &Path) -> R<Template> {
        let path = dir.join("template");
        let bytes = std::fs::read(&path)
            .or_else(|e| refuse("template-io", format!("{}: {e}", path.display())))?;
        let v = decode(&bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let Value::Map(m) = v else {
            return refuse("template-not-a-manifest", path.display().to_string());
        };
        let (Some(Value::Bytes(l)), Some(zone)) = (m.get(&2), m.get(&3)) else {
            return refuse("template-not-a-manifest", path.display().to_string());
        };
        let Ok(lineage) = <[u8; 16]>::try_from(l.as_slice()) else {
            return refuse("template-not-a-manifest", path.display().to_string());
        };
        Ok(Template {
            dir: dir.to_owned(),
            lineage,
            zone: read_id(zone)?,
        })
    }
}

struct Inner<S: Store> {
    dir: Directory<S>,
}

/// The list and create, over one directory.
pub struct Worlds<S: Store> {
    inner: Mutex<Inner<S>>,
    handoffs: Mutex<()>,
    /// The cached copy of [`KEY`]: its version and rows (rule 1).
    cache: Mutex<Option<(String, Vec<Json>)>>,
    pub templates: BTreeMap<String, Template>,
    pub limits: Limits,
    /// Rule 4: accounts no limit applies to ([`SITE_OWNERS_ENV`]).
    pub site_owners: std::collections::BTreeSet<String>,
    starter: Starter,
    /// Rule 9: the folder of this machine's world folders, and the counts read from it: when (seconds) and by folder.
    pub souls_root: Option<PathBuf>,
    souls_read: Mutex<(u64, BTreeMap<String, Option<u64>>)>,
}

/// A world's folder name from its row: `<lineage hex>-<zone scope hex>-<zone counter>` (`worldd serve`'s).
fn folder_of(row: &Json) -> Option<String> {
    let lineage = row.get("lineage")?.as_str()?;
    let (scope, counter) = row.get("zone")?.as_str()?.split_once(':')?;
    Some(format!("{lineage}-{scope}-{counter}"))
}

/// The Souls a world's `health.json` says are embodied in it (rule 9), if it says and was written within
/// [`SOULS_FRESH`] seconds of `now`: an older file is a world not running here (asleep, stopped or moved away), whose
/// count may no longer hold.
fn souls_in(root: &Path, folder: &str, now: u64) -> Option<u64> {
    let text = std::fs::read(root.join(folder).join("health.json")).ok()?;
    let health = serde_json::from_slice::<Json>(&text).ok()?;
    let at = health.get("at_unix_ms")?.as_u64()? / 1000;
    if at.saturating_add(SOULS_FRESH) < now {
        return None;
    }
    health.get("souls")?.as_u64()
}

fn row_creator(row: &Json) -> Option<&str> {
    row.get("creator").and_then(Json::as_str)
}

impl<S: Store> Worlds<S> {
    pub fn new(
        dir: Directory<S>,
        templates: BTreeMap<String, Template>,
        starter: Starter,
    ) -> Worlds<S> {
        Worlds {
            inner: Mutex::new(Inner { dir }),
            handoffs: Mutex::new(()),
            cache: Mutex::new(None),
            templates,
            limits: Limits::default(),
            site_owners: Default::default(),
            starter,
            souls_root: None,
            souls_read: Mutex::new((0, BTreeMap::new())),
        }
    }

    /// Rule 9: each folder's Souls, read again once [`SOULS_EVERY`] seconds have passed since the last read, or the
    /// clock went back past it (a folder not read before is read now).
    fn souls_of(&self, folders: &[String], now: u64) -> BTreeMap<String, Option<u64>> {
        let Some(root) = &self.souls_root else {
            return BTreeMap::new();
        };
        let mut read = self.souls_read.lock().unwrap_or_else(|e| e.into_inner());
        if now < read.0 || now - read.0 >= SOULS_EVERY {
            *read = (now, BTreeMap::new());
        }
        for f in folders {
            if !read.1.contains_key(f) {
                read.1.insert(f.clone(), souls_in(root, f, now));
            }
        }
        folders
            .iter()
            .map(|f| (f.clone(), read.1.get(f).copied().flatten()))
            .collect()
    }

    /// Every world's lineage (hex) and creator (a principal's text), unlisted ones too: whom a world's prayers go to
    /// (G11, #3335).
    pub fn creators(&self) -> R<Vec<(String, String)>> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (_, rows) = read_rows(&inner.dir.store)?;
        let mut out = Vec::new();
        for row in rows {
            let owner = handoff::ownership(&inner.dir.store, &row)?;
            // Keep the lineage present while fenced: the standalone prayer fallback must not claim it.
            out.push((
                to_hex(&owner.lineage),
                owner.creator.map(principal_text).unwrap_or_default(),
            ));
        }
        Ok(out)
    }

    /// The list (rule 1): every world's row, with whether it is awake by this machine's cached directory, and the
    /// templates a world may be made from.
    pub fn list(&self) -> R<Json> {
        self.list_for(None)
    }

    /// The list as `viewer` sees it (#3698): the public list, and with a signed-in viewer also the unlisted worlds
    /// that viewer created, each still marked `unlisted`. Nobody else's unlisted world is in it.
    pub fn list_for(&self, viewer: Option<Id>) -> R<Json> {
        // Locks are taken in one order, the directory then the cached copy.
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (_, rows) = read_rows(&inner.dir.store)?;
        let mut kept = Vec::with_capacity(rows.len());
        for r in rows {
            if archive::active(&r).is_err() {
                continue;
            }
            let shown = r.get("unlisted") != Some(&Json::Bool(true))
                || viewer.is_some_and(|v| {
                    handoff::ownership(&inner.dir.store, &r).is_ok_and(|o| o.creator == Some(v))
                });
            if shown {
                kept.push(r);
            }
        }
        let mut rows = kept;
        for row in &mut rows {
            handoff::public_row(row);
            let awake = (|| {
                let lineage: [u8; 16] = from_hex(row.get("lineage")?.as_str()?)
                    .ok()?
                    .try_into()
                    .ok()?;
                let zone = crate::accounts::principal_from_text(row.get("zone")?.as_str()?)?;
                let rec = inner.dir.cached_world(&lineage, zone)?;
                Some(rec.current().is_some() && rec.wake.is_none())
            })();
            row["awake"] = json!(awake.unwrap_or(false));
            if row.get("picture").is_none() {
                row["picture"] = Json::Null;
            }
        }
        drop(inner);
        // Rule 9: the Souls in each world now, read outside the directory's lock.
        let folders: Vec<String> = rows.iter().filter_map(folder_of).collect();
        let souls = self.souls_of(&folders, crate::accounts::serve::now());
        for row in &mut rows {
            let n = folder_of(row).and_then(|f| souls.get(&f).copied().flatten());
            row["souls"] = json!(n);
        }
        Ok(json!({"worlds": rows, "templates": self.templates.keys().collect::<Vec<_>>()}))
    }

    /// Makes a world for `creator` (an account made at `account_made`), at `now` (seconds): rules 2 to 5.
    pub fn create(
        &self,
        ask: &Ask,
        creator: Id,
        account_made: u64,
        now: u64,
    ) -> Result<Json, Refusal> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.make(&mut inner, ask, creator, account_made, now, true)
    }

    /// [`Worlds::create`] for the signed-in `account`: a site owner ([`Worlds::site_owners`]) has no limits.
    pub fn create_for(
        &self,
        ask: &Ask,
        creator: Id,
        account: &str,
        account_made: u64,
        now: u64,
    ) -> Result<Json, Refusal> {
        let limited = !self.site_owners.contains(account);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.make(&mut inner, ask, creator, account_made, now, limited)
    }

    fn make(
        &self,
        inner: &mut Inner<S>,
        ask: &Ask,
        creator: Id,
        account_made: u64,
        now: u64,
        limited: bool,
    ) -> Result<Json, Refusal> {
        if ask.key.is_empty() || ask.key.len() > 64 {
            return refuse(
                "key-missing",
                "a create carries the page's key for the click, 1 to 64 bytes",
            );
        }
        let label = ask.label.trim();
        if label.is_empty() || label.chars().count() > 40 {
            return refuse(
                "label-not-allowed",
                "a creator's label is 1 to 40 characters",
            );
        }
        let Some(template) = self.templates.get(&ask.template) else {
            return refuse("template-missing", ask.template.clone());
        };
        let who = principal_text(creator);
        let request = to_hex(&sha256(format!("{who}:{}", ask.key).as_bytes()));
        let intent_key = format!("world-create/{request}");
        let fingerprint =
            json!({"name": ask.name, "template": ask.template, "label": label, "creator": who});
        let mut intent = match inner.dir.store.get(&intent_key)? {
            Some(o) => {
                let value: Json = serde_json::from_slice(&o.bytes)
                    .or_else(|_| refuse("create-intent-invalid", "the stored create request"))?;
                if value.get("ask") != Some(&fingerprint) {
                    return refuse(
                        "create-key-reused",
                        "this click already names a different world request",
                    );
                }
                value
            }
            None => {
                crate::worlds::create::check_name(&ask.name)?;
                let (_, rows) = read_rows(&inner.dir.store)?;
                let made: Vec<u64> = rows
                    .iter()
                    .filter(|r| row_creator(r) == Some(&who))
                    .filter(|r| r.get("template").and_then(Json::as_str) != Some(IMPORTED))
                    .filter_map(|r| r.get("made").and_then(Json::as_u64))
                    .collect();
                if limited && let Err(o) = self.limits.check(account_made, &made, now) {
                    return Err(Refusal {
                        name: o.name,
                        detail: json!({"limit": o.limit, "retry_after": o.retry_after}).to_string(),
                    });
                }
                if rows.iter().any(|r| {
                    r.get("label").and_then(Json::as_str) == Some(label)
                        && row_creator(r) != Some(&who)
                }) {
                    return refuse("label-taken", label.to_owned());
                }
                if inner.dir.store.get(&NameRecord::key(&ask.name))?.is_some() {
                    return refuse("name-taken", ask.name.clone());
                }
                let lineage: [u8; 16] = random();
                let value = json!({"request": request, "ask": fingerprint, "row": {
                    "name": ask.name, "label": label, "template": ask.template,
                    "lineage": to_hex(&lineage), "zone": principal_text(template.zone),
                    "creator": who, "made": now, "ready": false,
                }});
                inner.dir.store.put(
                    &intent_key,
                    &serde_json::to_vec(&value).unwrap(),
                    When::Absent,
                )?;
                value
            }
        };
        let (_, current_rows) = read_rows(&inner.dir.store)?;
        if let Some(current) = current_rows
            .iter()
            .find(|r| r.get("name").and_then(Json::as_str) == Some(ask.name.as_str()))
        {
            archive::active(current)?;
        }
        let mut row = intent["row"].clone();
        if row.get("ready") == Some(&Json::Bool(true)) {
            return Ok(json!({"world": row, "epoch": 1}));
        }
        let lineage: [u8; 16] = from_hex(row["lineage"].as_str().unwrap_or_default())
            .ok()
            .and_then(|s| s.try_into().ok())
            .ok_or_else(|| Refusal {
                name: "create-intent-invalid",
                detail: "lineage".into(),
            })?;
        if row["zone"] != principal_text(template.zone) || row["creator"] != who {
            return refuse(
                "create-intent-invalid",
                "the template or creator no longer matches",
            );
        }
        let build = placement::build_pin()?;
        let claim = match inner.dir.store.get(&NameRecord::key(&ask.name))? {
            None => Some(
                create(
                    &mut inner.dir,
                    Create {
                        name: &ask.name,
                        creator,
                        source: Source::Template {
                            lineage: template.lineage,
                        },
                        lineage,
                        zone: template.zone,
                        build: &build,
                    },
                    |_| Ok(()),
                )?
                .0,
            ),
            Some(o) => {
                let named = NameRecord::read(&o.bytes)?;
                if named.creator != creator
                    || named.lineage != lineage
                    || named.zone != template.zone
                    || named.source != template.lineage
                {
                    return refuse("name-taken", ask.name.clone());
                }
                // A crash after name reservation may precede the build/claim; the supervisor owns later epochs.
                inner.dir.set_build(&lineage, template.zone, &build)?;
                if inner
                    .dir
                    .world(&lineage, template.zone)?
                    .current()
                    .is_none()
                {
                    Some(inner.dir.claim(&lineage, template.zone)?)
                } else {
                    None
                }
            }
        };
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let (rows, ()) = write_rows(&inner.dir.store, etag, rows, |rows| {
            if let Some(current) = rows.iter().find(|r| r.get("name") == row.get("name")) {
                archive::active(current)?;
            }
            if !rows.iter().any(|r| r.get("name") == row.get("name")) {
                rows.push(row.clone());
            }
            Ok(())
        })?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(rows);
        (self.starter)(&Start {
            name: &ask.name,
            template: &template.dir,
            lineage,
            creator,
            claim: claim.as_ref(),
            request: &request,
        })?;
        row["ready"] = json!(true);
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let (rows, ()) = write_rows(&inner.dir.store, etag, rows, |rows| {
            let found = rows
                .iter_mut()
                .find(|r| r.get("name") == row.get("name"))
                .ok_or_else(|| Refusal {
                    name: "create-intent-invalid",
                    detail: "the world row is absent".into(),
                })?;
            archive::active(found)?;
            // Keep concurrent settings/authority metadata rather than replacing the current row from an old intent.
            found["ready"] = json!(true);
            Ok(())
        })?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(rows);
        intent["row"] = row.clone();
        let prior = inner.dir.store.get(&intent_key)?.ok_or_else(|| Refusal {
            name: "create-intent-invalid",
            detail: "the create request is absent".into(),
        })?;
        inner.dir.store.put(
            &intent_key,
            &serde_json::to_vec(&intent).unwrap(),
            When::Is(&prior.etag),
        )?;
        Ok(json!({"world": row, "epoch": 1}))
    }

    /// A world's settings (rules 6 and 7): `creator` sets `unlisted`, `closed` and the list's `picture` (a checked
    /// `data:` URL, [`list_picture`]) on the row of `world` (each may be `None`, left as it is; all `None` reads the
    /// row). Answers the row. Writes the list's one object alone.
    pub fn settings(
        &self,
        world: &str,
        creator: Id,
        unlisted: Option<bool>,
        closed: Option<bool>,
        picture: Option<&str>,
    ) -> Result<Json, Refusal> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let set = |rows: &mut Vec<Json>| -> R<Json> {
            let Some(row) = rows
                .iter_mut()
                .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
            else {
                return refuse("world-missing", world.to_owned());
            };
            if handoff::ownership(&inner.dir.store, row)?.creator != Some(creator) {
                return refuse("not-the-creator", world.to_owned());
            }
            for (k, v) in [("unlisted", unlisted), ("closed", closed)] {
                if let Some(v) = v {
                    row[k] = json!(v);
                }
            }
            if let Some(p) = picture {
                row["picture"] = json!(p);
            }
            let mut public = row.clone();
            handoff::public_row(&mut public);
            Ok(public)
        };
        if unlisted.is_none() && closed.is_none() && picture.is_none() {
            return set(&mut rows.clone());
        }
        let (rows, row) = write_rows(&inner.dir.store, etag, rows, set)?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(rows);
        Ok(row)
    }

    /// A world's welcome (rule 8, #3702): `creator` sets the words visitors are shown on arrival; empty words clear
    /// it. At most [`WELCOME_MOST`] characters, no control characters but line breaks (`welcome-too-long`,
    /// `welcome-not-text`). Answers the row.
    pub fn set_welcome(&self, world: &str, creator: Id, words: &str) -> Result<Json, Refusal> {
        let words = words.trim();
        if words.chars().count() > WELCOME_MOST {
            return refuse(
                "welcome-too-long",
                format!("at most {WELCOME_MOST} characters"),
            );
        }
        if words.chars().any(|c| c.is_control() && c != '\n') {
            return refuse("welcome-not-text", "no control characters but line breaks");
        }
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let set = |rows: &mut Vec<Json>| -> R<Json> {
            let Some(row) = rows
                .iter_mut()
                .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
            else {
                return refuse("world-missing", world.to_owned());
            };
            if handoff::ownership(&inner.dir.store, row)?.creator != Some(creator) {
                return refuse("not-the-creator", world.to_owned());
            }
            if let Some(o) = row.as_object_mut() {
                if words.is_empty() {
                    o.remove("welcome");
                } else {
                    o.insert("welcome".into(), json!(words));
                }
            }
            let mut public = row.clone();
            handoff::public_row(&mut public);
            Ok(public)
        };
        let (rows, row) = write_rows(&inner.dir.store, etag, rows, set)?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(rows);
        Ok(row)
    }

    /// The welcome of the world named `world`, if it has one (#3702).
    pub fn welcome_of(&self, world: &str) -> R<Option<String>> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (_, rows) = read_rows(&inner.dir.store)?;
        Ok(rows
            .iter()
            .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
            .and_then(|r| r.get("welcome")?.as_str().map(str::to_owned)))
    }

    /// Whether `who` is the creator of the world named `world` (`world-missing` when there is none).
    pub fn is_creator(&self, world: &str, who: Id) -> R<bool> {
        Ok(self.ownership(world)?.creator == Some(who))
    }
}

/// The one creator of the world `lineage`/`zone`, as its directory record names it (G1e, #3532): its row in the list
/// gives its name, and the validated mutable authority its current creator. `None` when pending or no row
/// for it, or the name record is missing, malformed or not this world's: authority that does not validate names no
/// creator (refused closed), while a failed store read is an error.
pub fn creator_of<S: Store>(store: &S, lineage: &[u8; 16], zone: Id) -> R<Option<Id>> {
    let (_, rows) = read_rows(store)?;
    let (l, z) = (to_hex(lineage), principal_text(zone));
    let Some(row) = rows.iter().find(|r| {
        r.get("lineage").and_then(Json::as_str) == Some(&l)
            && r.get("zone").and_then(Json::as_str) == Some(&z)
    }) else {
        return Ok(None);
    };
    match handoff::ownership(store, row) {
        Ok(o) => Ok(o.creator),
        Err(e) if e.name.starts_with("handoff-authority") => Ok(None),
        Err(e) => Err(e),
    }
}

fn read_rows<S: Store>(store: &S) -> R<(String, Vec<Json>)> {
    match store.get(KEY)? {
        None => Ok((String::new(), Vec::new())),
        Some(o) => {
            let v: Json = serde_json::from_slice(&o.bytes)
                .or_else(|e| refuse("list-not-a-list", e.to_string()))?;
            match v.get("worlds").and_then(Json::as_array) {
                Some(rows) => Ok((o.etag, rows.clone())),
                None => refuse("list-not-a-list", KEY),
            }
        }
    }
}

/// Changes the rows with `change` and writes them on condition of the version read; a write refused because another
/// machine wrote reads again and changes the new rows.
fn write_rows<S: Store, T>(
    store: &S,
    mut etag: String,
    mut rows: Vec<Json>,
    change: impl Fn(&mut Vec<Json>) -> R<T>,
) -> R<((String, Vec<Json>), T)> {
    for _ in 0..16 {
        let mut next = rows.clone();
        let out = change(&mut next)?;
        let bytes = json!({ "worlds": next }).to_string().into_bytes();
        let when = if etag.is_empty() {
            When::Absent
        } else {
            When::Is(&etag)
        };
        match store.put(KEY, &bytes, when) {
            Ok(e) => return Ok(((e, next), out)),
            Err(e) if e.name == "precondition-failed" => (etag, rows) = read_rows(store)?,
            Err(e) => return Err(e),
        }
    }
    refuse("contended", KEY)
}

/// The starter that runs the fork in its own process: `<worldd> fork --from <template>/ckpt --to <worlds>/<name>
/// --through <creator> --scope <lineage>`.
pub fn worldd_starter(worldd: PathBuf, worlds: PathBuf) -> Starter {
    Box::new(move |s: &Start| {
        let out = std::process::Command::new(&worldd)
            .arg("fork")
            .arg("--from")
            .arg(s.template.join("ckpt"))
            .arg("--to")
            .arg(worlds.join(s.name))
            .arg("--through")
            .arg(principal_text(s.creator))
            .arg("--scope")
            .arg(to_hex(&s.lineage))
            .output()
            .or_else(|e| refuse("start-failed", format!("worldd: {e}")))?;
        if !out.status.success() {
            return refuse(
                "start-failed",
                String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            );
        }
        Ok(())
    })
}

/// The site owners [`SITE_OWNERS_ENV`] names: its comma-separated account ids, trimmed, empty ones dropped.
pub fn site_owners(text: &str) -> std::collections::BTreeSet<String> {
    text.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The list and create the environment names, or `None` when `DIRECTORYD_TEMPLATES` is not set:
/// `DIRECTORYD_TEMPLATES` (a folder of published templates, one folder each), `DIRECTORYD_WORLDS` (where new worlds'
/// folders go), `DIRECTORYD_WORLDD` (the world program). The directory's store is the one W8's environment names, or
/// an in-memory one for a local run.
pub fn from_env(machine: &str) -> Option<R<Worlds<&'static (dyn Store + Send + Sync)>>> {
    let templates = PathBuf::from(std::env::var_os("DIRECTORYD_TEMPLATES")?);
    let run = || -> R<Worlds<&'static (dyn Store + Send + Sync)>> {
        let store: Box<dyn Store + Send + Sync> = match crate::directory::s3::S3::from_env() {
            Some(s) => Box::new(s?),
            None => Box::new(crate::directory::folder::Folder::new(PathBuf::from(
                std::env::var_os(WORLD_STORE_ENV).unwrap_or_else(|| WORLD_STORE_DEFAULT.into()),
            ))),
        };
        let store: &'static (dyn Store + Send + Sync) = Box::leak(store);
        let mut found = BTreeMap::new();
        let entries =
            std::fs::read_dir(&templates).or_else(|e| refuse("template-io", e.to_string()))?;
        for e in entries.flatten() {
            // A folder named as imported rows are is no template: its worlds would count toward no limit (rule 4).
            if e.path().join("template").is_file() && e.file_name() != IMPORTED {
                found.insert(
                    e.file_name().to_string_lossy().into_owned(),
                    Template::read(&e.path())?,
                );
            }
        }
        let var = |k: &str, d: &str| PathBuf::from(std::env::var_os(k).unwrap_or_else(|| d.into()));
        let machine = Name::new(machine).ok_or_else(|| Refusal {
            name: "machine-name",
            detail: machine.to_owned(),
        })?;
        let mut worlds = Worlds::new(
            Directory::new(store, machine),
            found,
            placement::starter(var("DIRECTORYD_PLACEMENT", "placement")),
        );
        worlds.souls_root = std::env::var_os(SOULS_ROOT_ENV).map(PathBuf::from);
        worlds.site_owners = site_owners(&std::env::var(SITE_OWNERS_ENV).unwrap_or_default());
        Ok(worlds)
    };
    Some(run())
}

#[cfg(test)]
mod tests;
