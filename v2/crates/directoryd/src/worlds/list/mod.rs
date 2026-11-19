//! The list of worlds, and making one from it (Engine v2 W3, #2799).
//!
//! 1. **One object, one read.** Every world made through the directory has a row in one object, `world-list`:
//!    `{"worlds": [{name, label, template, lineage, zone, creator, made}]}`, written after G9's create on condition of
//!    the version read (rows are only added). The list request is answered from this machine's cached copy of it,
//!    read from the store at most once; it asks no world anything, so it wakes none. Awake or asleep comes from the
//!    world records this machine's directory has cached, never from the store or a world. No picture yet (G10).
//! 2. **Create** takes a name, a template and the creator's label, and runs G9's create
//!    ([`crate::worlds::create`]) with the starter: the fork, in its own process (`worldd fork`).
//! 3. **A request key.** Each create carries the page's key for that one click. Creates are made one at a time, and
//!    the answer is kept by key, so the same key twice makes one world and answers the second with the first's world.
//! 4. **Per-account limits** ([`Limits`], today's): five worlds an account; an account in its first day two, and one
//!    an hour. A refusal names the limit and when to retry. They stop abuse and count toward no bar.
//! 5. **The label is free text, not identity.** A label already on another account's world is refused.
//! 6. **A world's settings** (W9, #2827), today's two owner switches, by its creator alone: `unlisted` takes the row
//!    off the list (the row's flag alone: it wakes no world), and `closed` closes it to visitors (today's one travel
//!    switch; it refuses nothing until travel exists, X9). Each is a field of the row, written on condition of the
//!    version read, and the list shows it from this machine's copy at once.

pub mod http;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use replica::effects::{Refusal, read_id};
use replica::encode::{Name, Value, decode, from_hex, to_hex};
use replica::ids::{Hash, Id, Purpose};
use serde_json::{Value as Json, json};

use crate::accounts::{principal_text, random};
use crate::directory::store::{R, Store, When, refuse};
use crate::directory::{Claim, Directory};
use crate::worlds::create::{Create, NameRecord, Source, create};

/// The list's one object.
pub const KEY: &str = "world-list";

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
    pub claim: &'a Claim,
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
    /// Answers by request key (rule 3).
    answered: BTreeMap<String, Result<Json, Refusal>>,
}

/// The list and create, over one directory.
pub struct Worlds<S: Store> {
    inner: Mutex<Inner<S>>,
    /// The cached copy of [`KEY`]: its version and rows (rule 1).
    cache: Mutex<Option<(String, Vec<Json>)>>,
    pub templates: BTreeMap<String, Template>,
    pub limits: Limits,
    starter: Starter,
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
            inner: Mutex::new(Inner {
                dir,
                answered: BTreeMap::new(),
            }),
            cache: Mutex::new(None),
            templates,
            limits: Limits::default(),
            starter,
        }
    }

    /// The rows, from the cached copy; read from the store only when there is none.
    fn rows(&self, inner: &Inner<S>) -> R<Vec<Json>> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, rows)) = &*cache {
            return Ok(rows.clone());
        }
        let (etag, rows) = read_rows(&inner.dir.store)?;
        *cache = Some((etag, rows.clone()));
        Ok(rows)
    }

    /// Every world's lineage (hex) and creator (a principal's text), unlisted ones too: whom a world's prayers go to
    /// (G11, #3335).
    pub fn creators(&self) -> R<Vec<(String, String)>> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let rows = self.rows(&inner)?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let lineage = r.get("lineage")?.as_str()?.to_string();
                Some((lineage, row_creator(r)?.to_string()))
            })
            .collect())
    }

    /// The list (rule 1): every world's row, with whether it is awake by this machine's cached directory, and the
    /// templates a world may be made from.
    pub fn list(&self) -> R<Json> {
        // Locks are taken in one order, the directory then the cached copy.
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut rows = self.rows(&inner)?;
        rows.retain(|r| r.get("unlisted") != Some(&Json::Bool(true)));
        for row in &mut rows {
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
            row["picture"] = Json::Null;
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
        if let Some(a) = inner.answered.get(&ask.key) {
            return a.clone();
        }
        let out = self.make(&mut inner, ask, creator, account_made, now);
        // A refusal by the store is not kept: the same click may be sent again and pass.
        if !matches!(&out, Err(e) if e.name == "store-unreachable") {
            inner.answered.insert(ask.key.clone(), out.clone());
        }
        out
    }

    fn make(
        &self,
        inner: &mut Inner<S>,
        ask: &Ask,
        creator: Id,
        account_made: u64,
        now: u64,
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
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let who = principal_text(creator);
        let made: Vec<u64> = rows
            .iter()
            .filter(|r| row_creator(r) == Some(&who))
            .filter_map(|r| r.get("made").and_then(Json::as_u64))
            .collect();
        if let Err(o) = self.limits.check(account_made, &made, now) {
            return Err(Refusal {
                name: o.name,
                detail: json!({"limit": o.limit, "retry_after": o.retry_after}).to_string(),
            });
        }
        if rows.iter().any(|r| {
            r.get("label").and_then(Json::as_str) == Some(label) && row_creator(r) != Some(&who)
        }) {
            return refuse("label-taken", label.to_owned());
        }
        let lineage: [u8; 16] = random();
        let build = Hash::of(Purpose::Fixture, b"souls/worldd/0.0.0").to_bytes();
        let (claim, ()) = create(
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
            |claim| {
                (self.starter)(&Start {
                    name: &ask.name,
                    template: &template.dir,
                    lineage,
                    creator,
                    claim,
                })
            },
        )?;
        let row = json!({
            "name": ask.name,
            "label": label,
            "template": ask.template,
            "lineage": to_hex(&lineage),
            "zone": principal_text(template.zone),
            "creator": who,
            "made": now,
        });
        let rows = add_row(&inner.dir.store, etag, rows, row.clone())?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(rows);
        Ok(json!({"world": row, "epoch": claim.takeover.epoch}))
    }

    /// A world's settings (rule 6): `creator` sets `unlisted` and `closed` on the row of `world` (either may be
    /// `None`, left as it is; both `None` reads the row). Answers the row. Writes the list's one object alone.
    pub fn settings(
        &self,
        world: &str,
        creator: Id,
        unlisted: Option<bool>,
        closed: Option<bool>,
    ) -> Result<Json, Refusal> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let who = principal_text(creator);
        let (etag, rows) = read_rows(&inner.dir.store)?;
        let set = |rows: &mut Vec<Json>| -> R<Json> {
            let Some(row) = rows
                .iter_mut()
                .find(|r| r.get("name").and_then(Json::as_str) == Some(world))
            else {
                return refuse("world-missing", world.to_owned());
            };
            if row_creator(row) != Some(&who) {
                return refuse("not-the-creator", world.to_owned());
            }
            for (k, v) in [("unlisted", unlisted), ("closed", closed)] {
                if let Some(v) = v {
                    row[k] = json!(v);
                }
            }
            Ok(row.clone())
        };
        if unlisted.is_none() && closed.is_none() {
            return set(&mut rows.clone());
        }
        let (rows, row) = write_rows(&inner.dir.store, etag, rows, set)?;
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(rows);
        Ok(row)
    }
}

/// The one creator of the world `lineage`/`zone`, as its directory record names it (G1e, #3532): its row in the list
/// gives its name, and the name record (written once, never replaced) its creator. `None` when the list has no row
/// for it, or the name record is not this world's.
pub fn creator_of<S: Store>(store: &S, lineage: &[u8; 16], zone: Id) -> R<Option<Id>> {
    let (_, rows) = read_rows(store)?;
    let (l, z) = (to_hex(lineage), principal_text(zone));
    let Some(name) = rows.iter().find_map(|r| {
        (r.get("lineage")?.as_str()? == l && r.get("zone")?.as_str()? == z)
            .then(|| r.get("name")?.as_str())
            .flatten()
    }) else {
        return Ok(None);
    };
    Ok(match store.get(&NameRecord::key(name))? {
        Some(o) => {
            let rec = NameRecord::read(&o.bytes)?;
            (rec.lineage == *lineage && rec.zone == zone).then_some(rec.creator)
        }
        None => None,
    })
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

/// Adds `row` on condition of the version read; a write refused because another machine added a row reads again.
fn add_row<S: Store>(
    store: &S,
    etag: String,
    rows: Vec<Json>,
    row: Json,
) -> R<(String, Vec<Json>)> {
    let ((etag, rows), ()) = write_rows(store, etag, rows, |next| {
        next.push(row.clone());
        Ok(())
    })?;
    Ok((etag, rows))
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

/// The list and create the environment names, or `None` when `DIRECTORYD_TEMPLATES` is not set:
/// `DIRECTORYD_TEMPLATES` (a folder of published templates, one folder each), `DIRECTORYD_WORLDS` (where new worlds'
/// folders go), `DIRECTORYD_WORLDD` (the world program). The directory's store is the one W8's environment names, or
/// an in-memory one for a local run.
pub fn from_env(machine: &str) -> Option<R<Worlds<&'static (dyn Store + Send + Sync)>>> {
    let templates = PathBuf::from(std::env::var_os("DIRECTORYD_TEMPLATES")?);
    let run = || -> R<Worlds<&'static (dyn Store + Send + Sync)>> {
        let store: Box<dyn Store + Send + Sync> = match crate::directory::s3::S3::from_env() {
            Some(s) => Box::new(s?),
            None => Box::new(crate::directory::store::Memory::default()),
        };
        let store: &'static (dyn Store + Send + Sync) = Box::leak(store);
        let mut found = BTreeMap::new();
        let entries =
            std::fs::read_dir(&templates).or_else(|e| refuse("template-io", e.to_string()))?;
        for e in entries.flatten() {
            if e.path().join("template").is_file() {
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
        Ok(Worlds::new(
            Directory::new(store, machine),
            found,
            worldd_starter(
                var("DIRECTORYD_WORLDD", "worldd"),
                var("DIRECTORYD_WORLDS", "worlds"),
            ),
        ))
    };
    Some(run())
}

#[cfg(test)]
mod tests;
