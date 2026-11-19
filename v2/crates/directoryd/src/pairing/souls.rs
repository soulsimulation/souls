//! My Souls (Engine v2 W11, #2749): what the account page lists and changes for an owner's Souls, kept beside W2's
//! pairings so the list is one request that wakes no world.
//!
//! - **The world** a Soul was paired for is the one the agent's request named (`world`), kept at the approval.
//! - **Name, description and picture** are the owner's, set by a signed-in POST and read by the list. A picture
//!   passes G6's gate (`assets::check` with a portrait's limits, then the hold point); only PNG and JPEG, at most
//!   [`PICTURE_BYTES`] and [`PICTURE_SIDE`] px, kept stripped of metadata.
//! - **A retire** is asked by the agent (with its token) or the page, and done only by the owner's signed-in POST
//!   with `confirm`: the token's hash leaves the store and the gateway's tokens file, the Soul leaves the list, and a
//!   pairing of it is refused `soul-retired`. An agent's ask changes nothing else.

use super::{Pairing, is_name, is_soul_grant};
use replica::encode::to_hex;
use replica::ids::sha256;
use rusqlite::{OptionalExtension, params};
use std::sync::Arc;

/// The most bytes a Soul's picture may have (today's 256 KiB).
pub const PICTURE_BYTES: u64 = 262_144;
/// The longest side of a Soul's picture, px (today's 512).
pub const PICTURE_SIDE: u64 = 512;
/// The most characters a description may have.
pub const DESCRIPTION_MOST: usize = 280;

/// The tables this module adds to the pairing store.
pub(super) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS pair_request_worlds_v1(code TEXT PRIMARY KEY, world TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS soul_profiles_v1(grant_text TEXT PRIMARY KEY, world TEXT, name TEXT, description TEXT,
      retire_asked INTEGER NOT NULL DEFAULT 0, retired_at INTEGER);
    CREATE TABLE IF NOT EXISTS soul_pictures_v1(grant_text TEXT PRIMARY KEY, format TEXT NOT NULL, hash TEXT NOT NULL,
      bytes BLOB NOT NULL);";

/// One of an account's Souls, as the list shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mine {
    pub soul: String,
    /// The device whose agent holds it (`None`: no agent connected).
    pub device: Option<String>,
    pub world: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    /// The picture's format (`png` or `jpeg`) and its bytes.
    pub picture: Option<(String, Vec<u8>)>,
    /// Its agent asked to retire it; nothing happens until the owner confirms.
    pub retire_asked: bool,
}

/// What a profile change sets; `None` leaves a field as it is.
#[derive(Clone, Debug, Default)]
pub struct Profile {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// A world's name as a request names it: 1 to 80 of `a-z`, `0-9` and `-` (G9's names, up to 40, or a placed
/// world's instance name, `<32 hex>-<32 hex>-<n>`; a reserved one may still be an old world's).
pub fn is_world(text: &str) -> bool {
    (1..=80).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn store<T>(r: rusqlite::Result<T>) -> Result<T, &'static str> {
    r.map_err(|_| "store")
}

impl Pairing {
    /// Keeps the world a pending request (by its code) was made for.
    pub fn ask_world(&self, code: &str, world: &str) -> Result<(), &'static str> {
        if !is_world(world) {
            return Err("world");
        }
        store(self.db.lock().expect("the store").execute(
            "INSERT OR REPLACE INTO pair_request_worlds_v1(code, world) VALUES (?1, ?2)",
            params![code, world],
        ))
        .map(|_| ())
    }

    /// At an approval: the Soul `grant` is now paired for the world its request named, if it named one.
    pub(super) fn note_world(&self, code: &str, grant: &str) -> Result<(), &'static str> {
        store(self.db.lock().expect("the store").execute(
            "INSERT INTO soul_profiles_v1(grant_text, world)
               SELECT ?2, world FROM pair_request_worlds_v1 WHERE code = ?1
             ON CONFLICT(grant_text) DO UPDATE SET world = excluded.world",
            params![code, grant],
        ))
        .map(|_| ())
    }

    /// Whether the Soul `grant` was retired.
    pub(super) fn retired(&self, grant: &str) -> Result<bool, &'static str> {
        store(
            self.db
                .lock()
                .expect("the store")
                .query_row(
                    "SELECT retired_at IS NOT NULL FROM soul_profiles_v1 WHERE grant_text = ?1",
                    params![grant],
                    |r| r.get(0),
                )
                .optional(),
        )
        .map(|r| r.unwrap_or(false))
    }

    /// The Souls `account` holds and has not retired, each with its device, world, profile and picture, in grant
    /// order: one read of this store.
    pub fn mine(&self, account: &str) -> Result<Vec<Mine>, &'static str> {
        let db = self.db.lock().expect("the store");
        let mut q = store(db.prepare(
            "SELECT s.grant_text, CASE WHEN s.token_hash IS NULL THEN NULL ELSE s.device END, p.world, p.name,
                    p.description, c.format, c.bytes, COALESCE(p.retire_asked, 0)
             FROM paired_souls_v1 s
               LEFT JOIN soul_profiles_v1 p ON p.grant_text = s.grant_text
               LEFT JOIN soul_pictures_v1 c ON c.grant_text = s.grant_text
             WHERE s.account = ?1 AND s.grant_text LIKE 'soul-%' AND p.retired_at IS NULL ORDER BY 1",
        ))?;
        let rows = store(q.query_map(params![account], |r| {
            let format: Option<String> = r.get(5)?;
            let bytes: Option<Vec<u8>> = r.get(6)?;
            Ok(Mine {
                soul: r.get(0)?,
                device: r.get(1)?,
                world: r.get(2)?,
                name: r.get(3)?,
                description: r.get(4)?,
                picture: format.zip(bytes),
                retire_asked: r.get::<_, i64>(7)? != 0,
            })
        }))?;
        store(rows.collect())
    }

    /// The owner of the unretired Soul `grant`, if it is `account`'s; refused by name otherwise.
    fn owned(&self, account: &str, grant: &str) -> Result<(), &'static str> {
        match self.soul_of(grant)? {
            None => Err("unknown-soul"),
            Some((owner, _)) if owner != account || !is_soul_grant(grant) => Err("not-yours"),
            Some(_) if self.retired(grant)? => Err("soul-retired"),
            Some(_) => Ok(()),
        }
    }

    /// `account` sets its Soul's name and description.
    pub fn set_profile(&self, account: &str, grant: &str, p: &Profile) -> Result<(), &'static str> {
        self.owned(account, grant)?;
        if p.name.as_deref().is_some_and(|n| !is_name(n)) {
            return Err("name");
        }
        if p.description.as_deref().is_some_and(|d| {
            d.chars().count() > DESCRIPTION_MOST || d.chars().any(char::is_control)
        }) {
            return Err("description");
        }
        store(self.db.lock().expect("the store").execute(
            "INSERT INTO soul_profiles_v1(grant_text, name, description) VALUES (?1, ?2, ?3)
             ON CONFLICT(grant_text) DO UPDATE SET name = COALESCE(?2, name), description = COALESCE(?3, description)",
            params![grant, p.name, p.description],
        ))
        .map(|_| ())
    }

    /// `account` sets its Soul's picture: G6's check with a portrait's limits, then the hold point. The stripped
    /// bytes are kept; a held or rejected file is refused and nothing is kept.
    pub fn set_picture(&self, account: &str, grant: &str, file: &[u8]) -> Result<(), String> {
        self.owned(account, grant).map_err(str::to_string)?;
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
        let checked = Arc::new(checked);
        match assets::hold::judge(
            Arc::new(assets::hold::NoClassifier),
            checked.clone(),
            assets::hold::CLASSIFY_WITHIN,
        ) {
            assets::hold::Verdict::Allow => {}
            assets::hold::Verdict::Hold(_) => return Err("picture-held".into()),
            assets::hold::Verdict::Reject(_) => return Err("picture-rejected".into()),
        }
        self.db
            .lock()
            .expect("the store")
            .execute(
                "INSERT OR REPLACE INTO soul_pictures_v1(grant_text, format, hash, bytes) VALUES (?1, ?2, ?3, ?4)",
                params![
                    grant,
                    checked.format.name(),
                    to_hex(&checked.hash.digest()),
                    checked.bytes
                ],
            )
            .map(|_| ())
            .map_err(|_| "store".to_string())
    }

    /// The agent holding a Soul's `token` asks for it to be retired. Nothing changes but the ask, which the owner's
    /// list shows until the owner confirms. The Soul's grant.
    pub fn ask_retire(&self, token: &str) -> Result<String, &'static str> {
        let hash = to_hex(&sha256(token.as_bytes()));
        let db = self.db.lock().expect("the store");
        let grant: String = store(
            db.query_row(
                "SELECT grant_text FROM paired_souls_v1 WHERE token_hash = ?1",
                params![hash],
                |r| r.get(0),
            )
            .optional(),
        )?
        .ok_or("unknown-token")?;
        store(db.execute(
            "INSERT INTO soul_profiles_v1(grant_text, retire_asked) VALUES (?1, 1)
             ON CONFLICT(grant_text) DO UPDATE SET retire_asked = 1",
            params![grant],
        ))?;
        Ok(grant)
    }

    /// The signed-in `account` retires its Soul: its token's hash leaves the store and the gateway's tokens file,
    /// it leaves the list, and a later pairing of it is refused `soul-retired`.
    pub fn retire(&self, account: &str, grant: &str, now: u64) -> Result<(), &'static str> {
        self.owned(account, grant)?;
        let db = self.db.lock().expect("the store");
        store(db.execute(
            "UPDATE paired_souls_v1 SET device = NULL, token_hash = NULL WHERE grant_text = ?1 AND account = ?2",
            params![grant, account],
        ))?;
        store(db.execute(
            "INSERT INTO soul_profiles_v1(grant_text, retired_at) VALUES (?1, ?2)
             ON CONFLICT(grant_text) DO UPDATE SET retired_at = ?2",
            params![grant, now as i64],
        ))?;
        self.write_tokens(&db).map_err(|_| "tokens-file")
    }
}
