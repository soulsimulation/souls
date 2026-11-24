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
//! - **The world hears of both** (W11b, #3511): after a retire or a change of name or description, the Souls file
//!   beside the gateway's tokens file (its name and `.souls`) is written whole, then renamed into place: `retired
//!   <grant>` for each retired Soul, `words <grant> <name hex> <description hex>` (`-` for one not saved) for each
//!   other Soul with words. The world reads it at its start and on each change (`worldd::directory`): it retires
//!   the body, or gives it the words as its own describe.

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
    CREATE TABLE IF NOT EXISTS pair_request_formers_v1(code TEXT PRIMARY KEY, former TEXT NOT NULL);
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

/// The id today's client knew a Soul by (`s_…`, R18): `s_` and 1 to 78 of `A-Z`, `a-z`, `0-9`, `_` and `-`.
pub fn is_former(text: &str) -> bool {
    text.strip_prefix("s_").is_some_and(|rest| {
        (1..=78).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn store<T>(r: rusqlite::Result<T>) -> Result<T, &'static str> {
    r.map_err(|_| "store")
}

/// One of a world's recent visitors (#3702): what its creator may read, nothing of the owner's account or device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Visitor {
    /// The Soul's grant, `soul-<scope hex>-<n>`.
    pub soul: String,
    pub name: Option<String>,
    /// When it last arrived (its latest approved pairing for the world), seconds.
    pub arrived: u64,
    /// An agent holds it now.
    pub connected: bool,
}

impl Pairing {
    /// The Souls most recently paired for `world`, newest first, at most `most`; retired Souls are left out.
    pub fn visitors(&self, world: &str, most: usize) -> Result<Vec<Visitor>, &'static str> {
        let db = self.db.lock().expect("the store");
        let mut q = store(db.prepare(
            "SELECT r.grant_text, MAX(r.created_at), p.name, ps.device IS NOT NULL
               FROM pair_requests_v1 r JOIN pair_request_worlds_v1 w ON w.code = r.code
               LEFT JOIN soul_profiles_v1 p ON p.grant_text = r.grant_text
               LEFT JOIN paired_souls_v1 ps ON ps.grant_text = r.grant_text
              WHERE w.world = ?1 AND r.state IN ('approved', 'delivered') AND r.scope = 'soul' AND r.grant_text IS NOT NULL
                AND p.retired_at IS NULL
              GROUP BY r.grant_text ORDER BY 2 DESC, 1 LIMIT ?2",
        ))?;
        let rows = store(q.query_map(params![world, most as i64], |r| {
            Ok(Visitor {
                soul: r.get(0)?,
                arrived: r.get::<_, i64>(1)?.max(0) as u64,
                name: r.get(2)?,
                connected: r.get(3)?,
            })
        }))?;
        store(rows.collect())
    }

    /// The world the request with this poll `secret` named, if it named one (#3702: its welcome goes with the token).
    pub fn world_by_secret(&self, secret: &str) -> Option<String> {
        let hash = to_hex(&sha256(secret.as_bytes()));
        self.db
            .lock()
            .expect("the store")
            .query_row(
                "SELECT w.world FROM pair_requests_v1 r JOIN pair_request_worlds_v1 w ON w.code = r.code
                 WHERE r.secret_hash = ?1",
                params![hash],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// The creator grant a paired creator's `token` is for (`creator-<scope hex>-<n>`), or none.
    pub fn creator_by_token(&self, token: &str) -> Option<String> {
        let hash = to_hex(&sha256(token.as_bytes()));
        self.db
            .lock()
            .expect("the store")
            .query_row(
                "SELECT grant_text FROM paired_souls_v1 WHERE token_hash = ?1
                 UNION SELECT grant_text FROM paired_world_tokens_v1 WHERE token_hash = ?1 LIMIT 1",
                params![hash],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .filter(|g| g.starts_with("creator-"))
    }

    /// Keeps the world a pending request (by its code) was made for.
    pub fn ask_world(&self, code: &str, world: &str) -> Result<(), &'static str> {
        if !is_world(world) {
            return Err("world");
        }
        self.placed(world)?;
        store(self.db.lock().expect("the store").execute(
            "INSERT OR REPLACE INTO pair_request_worlds_v1(code, world) VALUES (?1, ?2)",
            params![code, world],
        ))
        .map(|_| ())
    }

    /// Keeps the former id (R18) a pending request (by its code) names; its world is kept by [`Pairing::ask_world`].
    pub fn ask_former(&self, code: &str, former: &str) -> Result<(), &'static str> {
        if !is_former(former) {
            return Err("former");
        }
        store(self.db.lock().expect("the store").execute(
            "INSERT OR REPLACE INTO pair_request_formers_v1(code, former) VALUES (?1, ?2)",
            params![code, former],
        ))
        .map(|_| ())
    }

    /// The world and former id a request (by its code) names, if it names a former Soul.
    pub(super) fn former_of(&self, code: &str) -> Result<Option<(String, String)>, &'static str> {
        store(
            self.db
                .lock()
                .expect("the store")
                .query_row(
                    "SELECT w.world, f.former FROM pair_request_formers_v1 f
                       JOIN pair_request_worlds_v1 w ON w.code = f.code WHERE f.code = ?1",
                    params![code],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional(),
        )
    }

    /// The former id a request names, by the secret its daemon polls with: the poll says it back (R18).
    pub fn former_by_secret(&self, secret: &str) -> Option<String> {
        let hash = to_hex(&sha256(secret.as_bytes()));
        self.db
            .lock()
            .expect("the store")
            .query_row(
                "SELECT f.former FROM pair_request_formers_v1 f
                   JOIN pair_requests_v1 r ON r.code = f.code WHERE r.secret_hash = ?1",
                params![hash],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
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

    /// The existing owner page plus X11 identities not yet paired. Reading never registers a Soul or mints a token.
    pub(super) fn mine_with_imports(
        &self,
        store: &crate::accounts::store::Store,
        account: &str,
    ) -> Result<Vec<Mine>, &'static str> {
        let mut rows = self.mine(account)?;
        for (grant, world, name, description) in
            store.imported_souls(account).map_err(|_| "store")?
        {
            if self.soul_of(&grant)?.is_some() {
                // Current paired ownership and retirement win over immutable imported ownership.
                if let Some(row) = rows.iter_mut().find(|row| row.soul == grant) {
                    row.world.get_or_insert(world);
                    row.name.get_or_insert(name);
                    row.description.get_or_insert(description);
                }
                continue;
            }
            if self.retired(&grant)? {
                continue;
            }
            rows.push(Mine {
                soul: grant,
                world: Some(world),
                name: Some(name),
                description: Some(description),
                device: None,
                picture: None,
                retire_asked: false,
            });
        }
        rows.sort_by(|a, b| a.soul.cmp(&b.soul));
        Ok(rows)
    }

    // Only absent fields are initialized. Empty edited strings and every existing world/alias remain authoritative.
    pub(super) fn import_profile(
        db: &rusqlite::Connection,
        grant: &str,
        world: &str,
        name: &str,
        description: &str,
    ) -> Result<(), &'static str> {
        store(db.execute("INSERT INTO soul_profiles_v1(grant_text,world,name,description) VALUES(?1,?2,?3,?4)
            ON CONFLICT(grant_text) DO UPDATE SET world=COALESCE(soul_profiles_v1.world,excluded.world),
            name=COALESCE(soul_profiles_v1.name,excluded.name),description=COALESCE(soul_profiles_v1.description,excluded.description)
            WHERE soul_profiles_v1.retired_at IS NULL",params![grant,world,name,description])).map(|_|())
    }

    /// Called only after successful owner approval/adoption and account holding; never from a listing or refusal.
    pub(super) fn initialize_imported_profile(
        &self,
        imported: &crate::accounts::store::Store,
        account: &str,
        grant: &str,
    ) -> Result<(), &'static str> {
        let Some((_, world, name, description)) = imported
            .imported_souls(account)
            .map_err(|_| "store")?
            .into_iter()
            .find(|row| row.0 == grant)
        else {
            return Ok(());
        };
        let mut db = self.db.lock().expect("the store");
        let tx = store(db.transaction())?;
        let owned: bool = store(tx.query_row("SELECT EXISTS(SELECT 1 FROM paired_souls_v1 s LEFT JOIN soul_profiles_v1 p USING(grant_text) WHERE s.grant_text=?1 AND s.account=?2 AND p.retired_at IS NULL)",params![grant,account],|r|r.get(0)))?;
        if !owned {
            return Err("not-yours");
        }
        Self::import_profile(&tx, grant, &world, &name, &description)?;
        store(tx.commit())?;
        let worlds = Self::worlds_of(&db, grant)?;
        self.publish(&db, &worlds, || {
            self.write_souls(&db).map_err(|_| "souls-file")
        })
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

    /// Every placed world's Souls file.
    pub(super) fn all_world_souls(
        db: &rusqlite::Connection,
        rows: &std::collections::BTreeMap<String, super::authority::Authority>,
    ) -> std::io::Result<()> {
        for (key, authority) in rows {
            if key == &authority.world {
                Self::world_souls(db, rows, authority)?;
            }
        }
        Ok(())
    }

    /// One placed world's Souls file, beside its tokens file: its Souls' notices only. `rows` (the registry) tells
    /// which world a Soul's world name, alias or instance is.
    pub(super) fn world_souls(
        db: &rusqlite::Connection,
        rows: &std::collections::BTreeMap<String, super::authority::Authority>,
        authority: &super::authority::Authority,
    ) -> std::io::Result<()> {
        let mut text = String::from("# World-bound Soul lifecycle notices\n");
        let mut query = db.prepare("SELECT grant_text,world,retired_at IS NOT NULL,name,description FROM soul_profiles_v1 WHERE retired_at IS NOT NULL OR name IS NOT NULL OR description IS NOT NULL ORDER BY 1").map_err(std::io::Error::other)?;
        let found = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(std::io::Error::other)?;
        for row in found {
            let (grant, world, retired, name, description) = row.map_err(std::io::Error::other)?;
            if world
                .as_ref()
                .and_then(|world| rows.get(world))
                .is_none_or(|bound| bound.world != authority.world)
            {
                continue;
            }
            if retired {
                text.push_str(&format!("retired {grant}\n"));
            } else {
                let hex = |word: Option<String>| {
                    word.map_or_else(|| "-".to_owned(), |w| to_hex(w.as_bytes()))
                };
                text.push_str(&format!(
                    "words {grant} {} {}\n",
                    hex(name),
                    hex(description)
                ));
            }
        }
        let name = format!(
            "{}.souls",
            authority
                .tokens
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        );
        let file = authority.tokens.with_file_name(name);
        let temporary = file.with_extension("souls-tmp");
        crate::durable::replace(&file, &temporary, text.as_bytes())
    }

    /// Writes the Souls file beside the gateway's tokens file (W11b), when there is one.
    pub(super) fn write_souls(&self, db: &rusqlite::Connection) -> std::io::Result<()> {
        if let Some(authorities) = self.authorities().map_err(std::io::Error::other)? {
            return Self::all_world_souls(db, &authorities);
        }
        let Some(tokens) = &self.tokens_file else {
            return Ok(());
        };
        let mut name = tokens.file_name().unwrap_or_default().to_os_string();
        name.push(".souls");
        let file = tokens.with_file_name(name);
        let mut text = String::from(
            "# Written by directoryd (W11b): retired <grant> | words <grant> <name hex> <description hex>\n",
        );
        let mut q = db
            .prepare(
                "SELECT grant_text, retired_at IS NOT NULL, name, description FROM soul_profiles_v1
                 WHERE retired_at IS NOT NULL OR name IS NOT NULL OR description IS NOT NULL ORDER BY 1",
            )
            .map_err(std::io::Error::other)?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(std::io::Error::other)?;
        let hex = |w: Option<String>| w.map_or_else(|| "-".to_owned(), |w| to_hex(w.as_bytes()));
        for row in rows {
            let (grant, retired, name, description) = row.map_err(std::io::Error::other)?;
            if retired {
                text.push_str(&format!("retired {grant}\n"));
            } else {
                text.push_str(&format!(
                    "words {grant} {} {}\n",
                    hex(name),
                    hex(description)
                ));
            }
        }
        let tmp = file.with_extension("souls-tmp");
        crate::durable::replace(&file, &tmp, text.as_bytes())
    }

    /// Whether `account` holds as many unretired Souls as one account may (#3720).
    pub(super) fn at_soul_cap(&self, account: &str) -> Result<bool, &'static str> {
        let held: i64 = store(self.db.lock().expect("the store").query_row(
            "SELECT COUNT(*) FROM paired_souls_v1 s LEFT JOIN soul_profiles_v1 p ON p.grant_text = s.grant_text
             WHERE s.account = ?1 AND s.grant_text LIKE 'soul-%' AND p.retired_at IS NULL",
            params![account],
            |r| r.get(0),
        ))?;
        Ok(usize::try_from(held).unwrap_or(usize::MAX) >= self.soul_cap)
    }

    /// Whether another unretired Soul of `grant`'s world is already called `name`, ignoring case (#3720, today's
    /// `name-taken`). A Soul with no world is checked against the other Souls with none.
    fn name_taken(&self, grant: &str, name: &str) -> Result<bool, &'static str> {
        store(self.db.lock().expect("the store").query_row(
            "SELECT EXISTS(SELECT 1 FROM soul_profiles_v1 o WHERE o.grant_text <> ?1 AND o.retired_at IS NULL
               AND o.name = ?2 COLLATE NOCASE
               AND o.world IS (SELECT world FROM soul_profiles_v1 WHERE grant_text = ?1))",
            params![grant, name],
            |r| r.get(0),
        ))
    }

    /// `account` sets its Soul's name and description. A name another Soul of its world has is refused `name-taken`.
    pub fn set_profile(&self, account: &str, grant: &str, p: &Profile) -> Result<(), &'static str> {
        self.owned(account, grant)?;
        if p.name.as_deref().is_some_and(|n| !is_name(n)) {
            return Err("name");
        }
        if let Some(n) = p.name.as_deref()
            && self.name_taken(grant, n)?
        {
            return Err("name-taken");
        }
        if p.description.as_deref().is_some_and(|d| {
            d.chars().count() > DESCRIPTION_MOST || d.chars().any(char::is_control)
        }) {
            return Err("description");
        }
        let db = self.db.lock().expect("the store");
        store(db.execute(
            "INSERT INTO soul_profiles_v1(grant_text, name, description) VALUES (?1, ?2, ?3)
             ON CONFLICT(grant_text) DO UPDATE SET name = COALESCE(?2, name), description = COALESCE(?3, description)",
            params![grant, p.name, p.description],
        ))?;
        let worlds = Self::worlds_of(&db, grant)?;
        self.publish(&db, &worlds, || {
            self.write_souls(&db).map_err(|_| "souls-file")
        })
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

    /// The account and grant of the paired Soul whose agent holds `token` (#3707): `unknown-token` for none.
    pub fn token_owner(&self, token: &str) -> Result<(String, String), &'static str> {
        let hash = to_hex(&sha256(token.as_bytes()));
        store(
            self.db
                .lock()
                .expect("the store")
                .query_row(
                    "SELECT account, grant_text FROM paired_souls_v1 WHERE token_hash = ?1",
                    params![hash],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional(),
        )?
        .ok_or("unknown-token")
    }

    /// `account`'s Soul as its list shows it, by its grant (#3707).
    pub fn mine_one(&self, account: &str, grant: &str) -> Result<Mine, &'static str> {
        self.owned(account, grant)?;
        self.mine(account)?
            .into_iter()
            .find(|m| m.soul == grant)
            .ok_or("unknown-soul")
    }

    /// `account` clears its Soul's picture: the page draws its own again (today's `profile photo auto`, #3707).
    pub fn clear_picture(&self, account: &str, grant: &str) -> Result<(), &'static str> {
        self.owned(account, grant)?;
        store(self.db.lock().expect("the store").execute(
            "DELETE FROM soul_pictures_v1 WHERE grant_text = ?1",
            params![grant],
        ))
        .map(|_| ())
    }

    /// An agent signed in to `account` asks for its Soul `grant` to be retired (#3707): as [`Pairing::ask_retire`],
    /// nothing changes but the ask, which the owner's list shows until the owner confirms.
    pub fn ask_retire_of(&self, account: &str, grant: &str) -> Result<(), &'static str> {
        self.owned(account, grant)?;
        store(self.db.lock().expect("the store").execute(
            "INSERT INTO soul_profiles_v1(grant_text, retire_asked) VALUES (?1, 1)
             ON CONFLICT(grant_text) DO UPDATE SET retire_asked = 1",
            params![grant],
        ))
        .map(|_| ())
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
        let worlds = Self::retire_row(&db, account, grant, now)?;
        self.publish_removal(&db, &worlds, true, || {
            self.write_tokens(&db).map_err(|_| "tokens-file")?;
            self.write_souls(&db).map_err(|_| "souls-file")
        })
    }

    /// Retires each of `grants` as [`Pairing::retire`] does, in one transaction, then writes each world's files once
    /// for them all, not once per Soul. The grants are `account`'s active Souls, as the caller read them.
    pub(super) fn retire_many(
        &self,
        account: &str,
        grants: &[String],
        now: u64,
    ) -> Result<(), &'static str> {
        let mut db = self.db.lock().expect("the store");
        let tx = store(db.transaction())?;
        let mut worlds = std::collections::BTreeSet::new();
        for grant in grants {
            worlds.extend(Self::retire_row(&tx, account, grant, now)?);
        }
        store(tx.commit())?;
        self.publish_removal(&db, &worlds, true, || {
            self.write_tokens(&db).map_err(|_| "tokens-file")?;
            self.write_souls(&db).map_err(|_| "souls-file")
        })
    }

    /// The store's half of a retire: the token's hash and world tokens go, the profile is marked retired. The worlds
    /// whose files then change.
    fn retire_row(
        db: &rusqlite::Connection,
        account: &str,
        grant: &str,
        now: u64,
    ) -> Result<std::collections::BTreeSet<String>, &'static str> {
        let worlds = Self::worlds_of(db, grant)?;
        store(db.execute(
            "UPDATE paired_souls_v1 SET device = NULL, token_hash = NULL WHERE grant_text = ?1 AND account = ?2",
            params![grant, account],
        ))?;
        store(db.execute(
            "INSERT INTO soul_profiles_v1(grant_text, retired_at) VALUES (?1, ?2)
             ON CONFLICT(grant_text) DO UPDATE SET retired_at = ?2",
            params![grant, now as i64],
        ))?;
        store(db.execute(
            "DELETE FROM paired_world_tokens_v1 WHERE grant_text=?1",
            params![grant],
        ))?;
        Ok(worlds)
    }
}
