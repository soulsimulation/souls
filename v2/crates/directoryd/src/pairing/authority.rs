//! Exact placed-world authority routing. The fixed root-owned registry is private, never a client-supplied path.
use super::{Pairing, is_creator_grant, is_soul_grant};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS paired_world_tokens_v1(
    grant_text TEXT NOT NULL, world TEXT NOT NULL, device TEXT NOT NULL, token_hash TEXT NOT NULL,
    PRIMARY KEY(grant_text, world));";

#[derive(Clone)]
pub(super) struct Authority {
    pub world: String,
    pub tokens: PathBuf,
    pub creator: String,
}

impl Authority {
    pub(super) fn creator_grant(&self) -> String {
        format!("creator-{}", self.creator.replace(':', "-"))
    }
}

fn regular(path: &Path) -> Result<(), &'static str> {
    let mut at = PathBuf::new();
    for part in path.components() {
        at.push(part);
        let meta = std::fs::symlink_metadata(&at).map_err(|_| "world-authority-unavailable")?;
        if meta.file_type().is_symlink() {
            return Err("world-authority-invalid");
        }
    }
    Ok(())
}

impl Pairing {
    pub(super) fn authorities(&self) -> Result<Option<BTreeMap<String, Authority>>, &'static str> {
        let Some(path) = &self.authority_file else {
            return Ok(None);
        };
        regular(path)?;
        let bytes = std::fs::read(path).map_err(|_| "world-authority-unavailable")?;
        if bytes.len() > 1 << 20 {
            return Err("world-authority-invalid");
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "world-authority-invalid")?;
        if value["format"] != "souls/world-authority/1" {
            return Err("world-authority-invalid");
        }
        let root = PathBuf::from(
            value["worldsRoot"]
                .as_str()
                .ok_or("world-authority-invalid")?,
        );
        if !root.is_absolute() {
            return Err("world-authority-invalid");
        }
        regular(&root)?;
        let mut out = BTreeMap::new();
        for (world, row) in value["worlds"]
            .as_object()
            .ok_or("world-authority-invalid")?
        {
            let instance = row["instance"].as_str().ok_or("world-authority-invalid")?;
            let parts: Vec<_> = instance.split('-').collect();
            if !super::souls::is_world(world)
                || parts.len() != 3
                || parts[..2]
                    .iter()
                    .any(|p| p.len() != 32 || replica::encode::from_hex(p).is_err())
                || parts[2].parse::<u64>().is_err()
            {
                return Err("world-authority-invalid");
            }
            let creator = row["creator"].as_str().ok_or("world-authority-invalid")?;
            if crate::accounts::principal_from_text(creator).is_none() {
                return Err("world-authority-invalid");
            }
            let tokens = root.join("worlds").join(instance).join("tokens");
            regular(&tokens)?;
            let authority = Authority {
                world: world.clone(),
                tokens,
                creator: creator.to_owned(),
            };
            if out.insert(world.clone(), authority.clone()).is_some()
                || out.insert(instance.to_owned(), authority).is_some()
            {
                return Err("world-authority-invalid");
            }
        }
        // Imported aliases must be explicit operator bindings, never a guessed public-name fallback.
        if let Some(aliases) = value.get("aliases") {
            for (alias, target) in aliases.as_object().ok_or("world-authority-invalid")? {
                if !super::souls::is_world(alias) {
                    return Err("world-authority-invalid");
                }
                let target = out
                    .get(target.as_str().ok_or("world-authority-invalid")?)
                    .cloned()
                    .ok_or("world-authority-invalid")?;
                if out.insert(alias.clone(), target).is_some() {
                    return Err("world-authority-invalid");
                }
            }
        }
        Ok(Some(out))
    }

    pub(super) fn authority(&self, world: Option<&str>) -> Result<Option<Authority>, &'static str> {
        match self.authorities()? {
            None => Ok(None),
            Some(rows) => rows
                .get(world.ok_or("world-required")?)
                .cloned()
                .map(Some)
                .ok_or("world-unplaced"),
        }
    }

    pub(super) fn request_world(
        db: &Connection,
        code: &str,
    ) -> Result<Option<String>, &'static str> {
        db.query_row(
            "SELECT world FROM pair_request_worlds_v1 WHERE code=?1",
            params![code],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "store")
    }

    pub(super) fn soul_for_request(
        &self,
        grant: &str,
        code: &str,
    ) -> Result<Option<(String, Option<String>)>, &'static str> {
        let Some((account, legacy_device)) = self.soul_of(grant)? else {
            return Ok(None);
        };
        let db = self.db.lock().expect("the store");
        let world = Self::request_world(&db, code)?;
        let device = match self.authority(world.as_deref())? {
            None => legacy_device,
            Some(authority) => db
                .query_row(
                    "SELECT device FROM paired_world_tokens_v1 WHERE grant_text=?1 AND world=?2",
                    params![grant, authority.world],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| "store")?,
        };
        Ok(Some((account, device)))
    }

    pub(super) fn check_world(&self, code: &str, grant: &str) -> Result<(), &'static str> {
        let db = self.db.lock().expect("the store");
        let world = Self::request_world(&db, code)?;
        let Some(authority) = self.authority(world.as_deref())? else {
            return Ok(());
        };
        if is_creator_grant(grant) && grant != authority.creator_grant() {
            return Err("not-the-creator");
        }
        if is_soul_grant(grant) {
            let previous: Option<String> = db
                .query_row(
                    "SELECT world FROM soul_profiles_v1 WHERE grant_text=?1",
                    params![grant],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| "store")?
                .flatten();
            if let Some(previous) = previous
                && self
                    .authority(Some(&previous))?
                    .is_none_or(|a| a.world != authority.world)
            {
                return Err("soul-in-another-world");
            }
        }
        Ok(())
    }

    pub(super) fn write_world_tokens(&self, db: &Connection) -> std::io::Result<bool> {
        let Some(rows) = self.authorities().map_err(std::io::Error::other)? else {
            return Ok(false);
        };
        Self::backfill_world_tokens(db, &rows).map_err(std::io::Error::other)?;
        for (key, authority) in rows {
            if key != authority.world {
                continue;
            }
            let mut query = db.prepare("SELECT grant_text, token_hash FROM paired_world_tokens_v1 WHERE world=?1 ORDER BY 1").map_err(std::io::Error::other)?;
            let values = query
                .query_map(params![authority.world], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(std::io::Error::other)?;
            let mut text = String::from("# World-bound pairing authority\n");
            for value in values {
                let (grant, hash) = value.map_err(std::io::Error::other)?;
                text.push_str(&format!("{grant} {hash}\n"));
            }
            let temporary = authority.tokens.with_extension("tmp");
            std::fs::write(&temporary, text)?;
            std::fs::rename(temporary, authority.tokens)?;
        }
        Ok(true)
    }

    // A registry upgrade must preserve an already-delivered legacy token, never assign it to every world.
    // Validate the complete migration before changing SQL or any file; an existing scoped row wins.
    fn backfill_world_tokens(
        db: &Connection,
        rows: &BTreeMap<String, Authority>,
    ) -> Result<(), String> {
        let mut query = db
            .prepare(
                "SELECT s.grant_text,s.device,s.token_hash,p.world FROM paired_souls_v1 s
            LEFT JOIN soul_profiles_v1 p ON p.grant_text=s.grant_text
            WHERE s.token_hash IS NOT NULL AND COALESCE(p.retired_at,0)=0
            AND NOT EXISTS(SELECT 1 FROM paired_world_tokens_v1 w WHERE w.grant_text=s.grant_text)
            ORDER BY s.grant_text",
            )
            .map_err(|_| "store")?;
        let legacy = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|_| "store")?;
        let mut pending = Vec::new();
        for item in legacy {
            let (grant, device, hash, world) = item.map_err(|_| "store")?;
            let device = device.ok_or("world-authority-upgrade-unbound")?;
            let contains = |a: &Authority| -> Result<bool, String> {
                let text = std::fs::read_to_string(&a.tokens)
                    .map_err(|_| "world-authority-unavailable")?;
                Ok(text.lines().any(|line| {
                    let fields: Vec<_> = line.split_whitespace().collect();
                    fields.len() == 2 && fields[0] == grant && fields[1] == hash
                }))
            };
            let authority = if is_soul_grant(&grant) {
                let authority = world
                    .as_ref()
                    .and_then(|world| rows.get(world))
                    .ok_or("world-authority-upgrade-unbound")?;
                if !contains(authority)? {
                    return Err("world-authority-upgrade-mismatch".into());
                }
                authority
            } else if is_creator_grant(&grant) {
                let mut matches = Vec::new();
                for (key, authority) in rows {
                    if key == &authority.world
                        && grant == authority.creator_grant()
                        && contains(authority)?
                    {
                        matches.push(authority);
                    }
                }
                if matches.len() != 1 {
                    return Err("world-authority-upgrade-ambiguous".into());
                }
                matches[0]
            } else {
                return Err("world-authority-upgrade-unbound".into());
            };
            pending.push((grant, authority.world.clone(), device, hash));
        }
        db.execute_batch("SAVEPOINT world_authority_upgrade")
            .map_err(|_| "store")?;
        let changed = (|| {
            for (grant, world, device, hash) in pending {
                db.execute("INSERT INTO paired_world_tokens_v1(grant_text,world,device,token_hash) VALUES(?1,?2,?3,?4)",params![grant,world,device,hash]).map_err(|_| "store")?;
            }
            db.execute_batch("RELEASE world_authority_upgrade")
                .map_err(|_| "store")
        })();
        if changed.is_err() {
            let _ = db.execute_batch(
                "ROLLBACK TO world_authority_upgrade; RELEASE world_authority_upgrade",
            );
        }
        changed.map_err(str::to_owned)
    }
}
