//! Pairing a Soul to an agent (Engine v2 W2, #2705), in the shape of the OAuth device grant (RFC 8628). The agent's
//! daemon keeps a secret and sends only its hash; it is given a short code and a link; the signed-in owner approves
//! once, with a POST from the card; the daemon polls with its secret and is handed the Soul's token once, minted at
//! that poll. The directory keeps the token's SHA-256 alone, here and in the gateway's tokens file (I1's
//! `<grant> <sha-256 hex>` lines), never the token.
//!
//! - A request names a Soul (its grant, `soul-<scope hex>-<counter>`) or asks for a new one; its `scope` is `soul`.
//!   A creator's request (G7, #2796) has `scope` `creator` and names a world's creator grant,
//!   `creator-<scope hex>-<counter>`, which the account must hold (registered with the world); a creator is never
//!   made by a pairing. Approval, the connected device and the token are as for a Soul.
//! - A Soul connected to a device is refused, naming the device, unless the request is forced; a forced pairing
//!   replaces the old device's token. An unconnected Soul moves freely. No browser click takes a Soul: the owner
//!   only approves what an agent asked for, and only for a Soul the owner holds.
//! - Requests never expire (#2258); the card shows a request's age instead.
//! - Polls closer than the interval are answered `slow_down`, and the interval grows by 5 s (RFC 8628 §3.5).
//! - The account page (W9, #2827) lists an account's Souls, each with the device that holds it, and revokes one: its
//!   token's hash leaves the store and the gateway's tokens file, so the gateway refuses its next intent
//!   (`token.refused`), and the Soul is unconnected. A revoke takes the Soul to no other device.
//! - My Souls (W11, #2749): each Soul's world, name, description and picture, and its retirement: see [`souls`].
//! - Wrong short codes are counted per account: [`GUESSES_MOST`] in [`GUESS_WINDOW`] seconds, then every code is
//!   refused `code-guesses` until the window passes.

mod account;
mod authority;
pub mod operator;
pub mod removal;
pub mod route;
pub mod souls;
#[cfg(test)]
pub(crate) mod tests;

use crate::accounts::random;
use replica::encode::{from_hex, to_hex};
use replica::ids::sha256;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The seconds between polls a request starts with (N12: 1 s, not RFC 8628 §3.2's default of 5, which kept a newly
/// approved Soul waiting 2.5 s on average for its token). At 100 clients pairing at once that is 100 polls a second,
/// each one indexed row read.
pub const INTERVAL: u64 = 1;
/// Wrong short codes one account may send in [`GUESS_WINDOW`] seconds.
pub const GUESSES_MOST: usize = 5;
pub const GUESS_WINDOW: u64 = 600;
/// The short code's letters: no vowels, so no words, and none that look alike (RFC 8628 §6.1).
const LETTERS: &[u8; 20] = b"BCDFGHJKLMNPQRSTVWXZ";

/// What a daemon asks for.
#[derive(Clone, Debug)]
pub struct Ask {
    /// The SHA-256 of the secret the daemon keeps and polls with.
    pub secret_hash: [u8; 32],
    pub device: String,
    pub label: String,
    /// The Soul's grant, or `None` for a new Soul.
    pub soul: Option<String>,
    pub scope: String,
    pub force: bool,
}

/// What a daemon is given back: the short code to show its owner, and the seconds between polls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asked {
    pub code: String,
    pub interval: u64,
}

/// What a poll answers.
#[derive(Debug, PartialEq, Eq)]
pub enum Poll {
    Pending,
    /// Polled too soon: the new interval.
    SlowDown(u64),
    /// Refused by name, and for `soul-connected` the device the Soul is connected to.
    Refused(String, Option<String>),
    /// Approved: the token, handed over this once, and the Soul's grant.
    Token {
        token: String,
        grant: String,
    },
}

/// What the approval card shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    pub device: String,
    pub label: String,
    /// The Soul's grant, or `None` for a new Soul.
    pub soul: Option<String>,
    pub code: String,
    pub age: u64,
    pub scope: String,
    pub force: bool,
    /// The device the Soul is connected to now, if any.
    pub connected: Option<String>,
    /// The id today's client knew the Soul by, for a Soul X11 brought over (R18), if the request named one.
    pub former: Option<String>,
    /// The name a new Soul's request asks for (`souls.mjs pair --name`), if it asked for one.
    pub name: Option<String>,
}

type OwnerReader = std::sync::Arc<
    dyn Fn(&str) -> Result<crate::worlds::list::handoff::Ownership, String> + Send + Sync,
>;

pub struct Pairing {
    /// The page's origin, the start of the link a daemon prints.
    pub public_url: String,
    db: Mutex<Connection>,
    /// The gateway's tokens file, rewritten from the stored hashes after each pairing.
    tokens_file: Option<PathBuf>,
    authority_file: Option<PathBuf>,
    owner_reader: std::sync::OnceLock<OwnerReader>,
    /// Each placed world's owner as last read from the world store, by instance, and the reads in flight: a request
    /// waits at most [`authority::OWNER_WITHIN`] for a read, then uses this (local-first, as R15's stream).
    owners: std::sync::Arc<Mutex<authority::Owners>>,
    /// The world files a slow store kept back, for the copier ([`Pairing::copy_owed`]) to write.
    owed: Mutex<authority::Owed>,
    /// Per account, the times of its wrong short codes.
    guesses: Mutex<BTreeMap<String, Vec<u64>>>,
    /// Per secret hash, the last poll and the interval.
    polls: Mutex<BTreeMap<[u8; 32], (u64, u64)>>,
    /// Per pending request's code, the address it was asked from and when, in memory only: the world page of a
    /// signed-in person on the same address shows it ([`Pairing::waiting`]).
    askers: Mutex<BTreeMap<String, (std::net::IpAddr, u64)>>,
    /// The most unretired Souls one account may hold (#3720): today's `MAX_SOULS_PER_USER`, 20 unless
    /// `DIRECTORYD_SOULS_PER_ACCOUNT` says otherwise. A new Soul past it is refused `too-many`, as today.
    pub(crate) soul_cap: usize,
}

/// Today's default per-account Soul cap (`MAX_SOULS_PER_USER`).
pub const SOUL_CAP: usize = 20;

/// A grant's text is a Soul's: `soul-<32 hex>-<counter>`.
pub fn is_soul_grant(text: &str) -> bool {
    is_grant("soul-", text)
}

/// A grant's text is a creator's: `creator-<32 hex>-<counter>`.
pub fn is_creator_grant(text: &str) -> bool {
    is_grant("creator-", text)
}

fn is_grant(prefix: &str, text: &str) -> bool {
    let Some(rest) = text.strip_prefix(prefix) else {
        return false;
    };
    let Some((scope, counter)) = rest.split_once('-') else {
        return false;
    };
    scope.len() == 32
        && scope
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && !counter.is_empty()
        && counter.len() <= 20
        && counter.bytes().all(|b| b.is_ascii_digit())
}

/// A device's name or an agent's label: 1 to 64 characters, none a control character.
pub fn is_name(text: &str) -> bool {
    (1..=64).contains(&text.chars().count()) && !text.chars().any(char::is_control)
}

/// A short code as typed, upper-cased with its dash and spaces taken out.
fn plain(code: &str) -> String {
    code.chars()
        .filter(|c| !matches!(c, '-' | ' '))
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn new_code() -> String {
    let mut out = String::with_capacity(9);
    while out.len() < 9 {
        for b in random::<16>() {
            // 240 is the largest multiple of 20 below 256, so each letter is equally likely.
            if b < 240 && out.len() < 9 {
                if out.len() == 4 {
                    out.push('-');
                }
                out.push(LETTERS[usize::from(b % 20)] as char);
            }
        }
    }
    out
}

type Row = (String, String, Option<String>, String, bool, u64, String);
/// Finds the Soul X11 brought over for `(world, former id)`: its grant and its owning account (R18).
pub type Imported<'a> = &'a dyn Fn(&str, &str) -> Result<Option<(String, String)>, &'static str>;
type PollRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
);

impl Pairing {
    /// Opens (or creates) the pairing store at `path`. `tokens_file` is the gateway's tokens file, if any.
    pub fn open(
        path: &Path,
        tokens_file: Option<PathBuf>,
        public_url: &str,
    ) -> Result<Pairing, rusqlite::Error> {
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS pair_requests_v1(code TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE,
               device TEXT NOT NULL, label TEXT NOT NULL, soul TEXT, scope TEXT NOT NULL, force INTEGER NOT NULL,
               created_at INTEGER NOT NULL, state TEXT NOT NULL, account TEXT, grant_text TEXT, refusal TEXT,
               refusal_device TEXT);
             CREATE TABLE IF NOT EXISTS paired_souls_v1(grant_text TEXT PRIMARY KEY, account TEXT NOT NULL,
               device TEXT, token_hash TEXT);",
        )?;
        db.execute_batch(souls::SCHEMA)?;
        db.execute_batch(authority::SCHEMA)?;
        db.execute_batch(operator::SCHEMA)?;
        db.execute_batch(account::SCHEMA)?;
        Ok(Pairing {
            public_url: public_url.trim_end_matches('/').to_string(),
            db: Mutex::new(db),
            tokens_file,
            authority_file: std::env::var_os("DIRECTORYD_AUTHORITY_MAP").map(PathBuf::from),
            owner_reader: std::sync::OnceLock::new(),
            owners: std::sync::Arc::default(),
            owed: Mutex::default(),
            guesses: Mutex::default(),
            polls: Mutex::default(),
            askers: Mutex::default(),
            soul_cap: std::env::var("DIRECTORYD_SOULS_PER_ACCOUNT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(SOUL_CAP),
        })
    }

    /// Pairing as the program's arguments ask: off without `--pairing`.
    pub fn start(c: &crate::accounts::start::Config) -> Result<Option<Pairing>, rusqlite::Error> {
        c.pairing
            .as_ref()
            .map(|path| {
                let pairing = Pairing::open(path, c.gateway_tokens.clone(), &c.public_url)?;
                if pairing.authority_file.is_none() {
                    let db = pairing.db.lock().expect("the store");
                    pairing
                        .write_tokens(&db)
                        .and_then(|()| pairing.write_souls(&db))
                        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                }
                Ok(pairing)
            })
            .transpose()
    }

    /// A Soul (or a world's creator) held by `account` with no device: an unconnected one.
    pub fn register(&self, grant: &str, account: &str) -> Result<(), rusqlite::Error> {
        self.db.lock().expect("the store").execute(
            "INSERT OR IGNORE INTO paired_souls_v1(grant_text, account) VALUES (?1, ?2)",
            params![grant, account],
        )?;
        Ok(())
    }

    /// Records a daemon's request; its short code and interval.
    pub fn ask(&self, a: &Ask, now: u64) -> Result<Asked, &'static str> {
        match a.scope.as_str() {
            "soul" if a.soul.as_deref().is_some_and(|s| !is_soul_grant(s)) => {
                return Err("not-a-soul");
            }
            "soul" => {}
            "creator" if !a.soul.as_deref().is_some_and(is_creator_grant) => {
                return Err("not-a-creator");
            }
            "creator" => {}
            _ => return Err("scope-unknown"),
        }
        if !is_name(&a.device) || !is_name(&a.label) {
            return Err("name");
        }
        let db = self.db.lock().expect("the store");
        for _ in 0..4 {
            let code = new_code();
            let done = db.execute(
                "INSERT OR IGNORE INTO pair_requests_v1(code, secret_hash, device, label, soul, scope, force,
                   created_at, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')",
                params![code, to_hex(&a.secret_hash), a.device, a.label, a.soul, a.scope, a.force, now as i64],
            );
            match done {
                Ok(1) => {
                    self.polls
                        .lock()
                        .expect("polls")
                        .insert(a.secret_hash, (now, INTERVAL));
                    return Ok(Asked {
                        code,
                        interval: INTERVAL,
                    });
                }
                Ok(_) => {
                    // A code or a secret already asked with: a secret is never asked with twice.
                    let taken: bool = db
                        .query_row(
                            "SELECT 1 FROM pair_requests_v1 WHERE secret_hash = ?1",
                            params![to_hex(&a.secret_hash)],
                            |_| Ok(true),
                        )
                        .optional()
                        .map_err(|_| "store")?
                        .unwrap_or(false);
                    if taken {
                        return Err("secret-used");
                    }
                }
                Err(_) => return Err("store"),
            }
        }
        Err("store")
    }

    /// Counts a wrong code against `account`; refuses every code while the account is over its limit.
    fn guess(&self, account: &str, code: &str, now: u64) -> Result<Row, &'static str> {
        // The guesses lock is held only to count, never while a code is read or the store is asked.
        let over = {
            let mut guesses = self.guesses.lock().unwrap_or_else(|e| e.into_inner());
            let mine = guesses.entry(account.to_string()).or_default();
            mine.retain(|&t| t + GUESS_WINDOW > now);
            mine.len() >= GUESSES_MOST
        };
        if over {
            return Err("code-guesses");
        }
        let wrong = || {
            let mut guesses = self.guesses.lock().unwrap_or_else(|e| e.into_inner());
            guesses.entry(account.to_string()).or_default().push(now);
            Err("unknown-code")
        };
        // Exactly 8 of the code's ASCII letters, checked before any slicing; anything else is a wrong guess.
        let code = plain(code);
        if code.len() != 8 || !code.bytes().all(|b| LETTERS.contains(&b)) {
            return wrong();
        }
        let code = format!("{}-{}", &code[..4], &code[4..]);
        let found = self
            .db
            .lock()
            .expect("the store")
            .query_row(
                "SELECT code, device, soul, label, force, created_at, scope FROM pair_requests_v1
                 WHERE code = ?1 AND state = 'pending'",
                params![code],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get::<_, i64>(5)? as u64,
                        r.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| "store")?;
        match found {
            Some(row) => Ok(row),
            None => wrong(),
        }
    }

    fn soul_of(&self, grant: &str) -> Result<Option<(String, Option<String>)>, &'static str> {
        self.db
            .lock()
            .expect("the store")
            .query_row(
                "SELECT account, CASE WHEN token_hash IS NULL THEN NULL ELSE device END FROM paired_souls_v1
                 WHERE grant_text = ?1",
                params![grant],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| "store")
    }

    /// The card for a pending request, for the signed-in `account`.
    pub fn show(&self, account: &str, code: &str, now: u64) -> Result<Card, &'static str> {
        let (code, device, soul, label, force, created, scope) = self.guess(account, code, now)?;
        let connected = match &soul {
            Some(g) => self.soul_for_request(g, &code)?.and_then(|(_, d)| d),
            None => None,
        };
        let former = self.former_of(&code)?.map(|(_, f)| f);
        let name = self.name_of(&code)?;
        Ok(Card {
            device,
            label,
            soul,
            code,
            age: now.saturating_sub(created),
            scope,
            force,
            connected,
            former,
            name,
        })
    }

    /// The signed-in `account` approves the request with `code`. A refusal is final for the request, and its daemon
    /// learns it at its next poll: `soul-connected` names the device.
    pub fn approve(
        &self,
        account: &str,
        code: &str,
        now: u64,
    ) -> Result<String, (&'static str, Option<String>)> {
        self.approve_with(account, code, now, &|_, _| Ok(None))
    }

    /// Approval with X11's imported former-Soul lookup; creator holdings are absent for this wrapper.
    pub fn approve_with(
        &self,
        account: &str,
        code: &str,
        now: u64,
        imported: Imported<'_>,
    ) -> Result<String, (&'static str, Option<String>)> {
        self.approve_combined(account, code, now, imported, |_| false)
    }

    /// Approval with the account's creator holdings; imported former Souls are absent for this wrapper.
    pub fn approve_holding(
        &self,
        account: &str,
        code: &str,
        now: u64,
        holds: impl Fn(&str) -> bool,
    ) -> Result<String, (&'static str, Option<String>)> {
        self.approve_combined(account, code, now, &|_, _| Ok(None), holds)
    }

    fn approve_combined(
        &self,
        account: &str,
        code: &str,
        now: u64,
        imported: Imported<'_>,
        holds: impl Fn(&str) -> bool,
    ) -> Result<String, (&'static str, Option<String>)> {
        let (code, _, soul, _, force, _, _) =
            self.guess(account, code, now).map_err(|e| (e, None))?;
        if let Some(g) = soul.as_deref().filter(|g| is_creator_grant(g) && holds(g)) {
            self.register(g, account).map_err(|_| ("store", None))?;
        }
        // Each change is made only to a request still pending: of two approvals at once, one finds it gone.
        let refuse = |name: &'static str, device: Option<String>| {
            let changed = self.db.lock().expect("the store").execute(
                "UPDATE pair_requests_v1 SET state = 'refused', refusal = ?2, refusal_device = ?3
                 WHERE code = ?1 AND state = 'pending'",
                params![code, name, device],
            );
            match changed {
                Ok(0) => Err(("unknown-code", None)),
                Ok(_) => Err((name, device)),
                Err(_) => Err(("store", None)),
            }
        };
        // Imported candidates remain read-only until every approval check passes.
        let mut imported_candidate = false;
        // R18: a request naming a former Soul pairs the Soul X11 brought over for it, only for its own account.
        let soul = match (soul, self.former_of(&code).map_err(|e| (e, None))?) {
            (None, Some((world, former))) => {
                match imported(&world, &former).map_err(|e| (e, None))? {
                    Some((grant, owner)) if owner == account && is_soul_grant(&grant) => {
                        imported_candidate = self.soul_of(&grant).map_err(|e| (e, None))?.is_none();
                        Some(grant)
                    }
                    _ => return refuse("unknown-soul", None),
                }
            }
            (soul, _) => soul,
        };
        if let Some(g) = soul.as_deref().filter(|g| is_soul_grant(g))
            && self.soul_of(g).map_err(|e| (e, None))?.is_none()
            && !imported_candidate
        {
            let world = Self::request_world(&self.db.lock().expect("the store"), &code)
                .map_err(|e| (e, None))?;
            if let Some(world) = world {
                imported_candidate = imported(&world, g)
                    .map_err(|e| (e, None))?
                    .is_some_and(|(found, owner)| found == g && owner == account);
            }
        }
        let grant = match soul {
            Some(g) => match self
                .soul_for_request(&g, &code)
                .map_err(|e| (e, None))?
                .or_else(|| imported_candidate.then(|| (account.to_owned(), None)))
            {
                None if is_creator_grant(&g) => return refuse("not-the-creator", None),
                None => return refuse("unknown-soul", None),
                Some((owner, _)) if owner != account && is_creator_grant(&g) => {
                    return refuse("not-the-creator", None);
                }
                Some(_) if self.retired(&g).map_err(|e| (e, None))? => {
                    return refuse("soul-retired", None);
                }
                Some((owner, _)) if owner != account => return refuse("not-yours", None),
                Some((_, Some(device))) if !force => return refuse("soul-connected", Some(device)),
                Some(_) => g,
            },
            None => {
                if self.at_soul_cap(account).map_err(|e| (e, None))? {
                    return refuse("too-many", None);
                }
                let id = replica::ids::Id::new(replica::ids::Scope(random()), 0)
                    .expect("counter 0 is an id");
                let g = format!("soul-{}-{}", to_hex(&id.scope().0), id.counter());
                self.register(&g, account).map_err(|_| ("store", None))?;
                g
            }
        };
        self.check_world(&code, &grant).map_err(|e| (e, None))?;
        let mut db = self.db.lock().expect("the store");
        let tx = db.transaction().map_err(|_| ("store", None))?;
        if imported_candidate {
            let owner: Option<String> = tx
                .query_row(
                    "SELECT account FROM paired_souls_v1 WHERE grant_text=?1",
                    params![grant],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| ("store", None))?;
            if owner.as_deref().is_some_and(|a| a != account) {
                return Err(("not-yours", None));
            }
            let retired: bool = tx.query_row("SELECT COALESCE((SELECT retired_at IS NOT NULL FROM soul_profiles_v1 WHERE grant_text=?1),0)",params![grant],|r|r.get(0)).map_err(|_|("store",None))?;
            if retired {
                return Err(("soul-retired", None));
            }
            tx.execute(
                "INSERT OR IGNORE INTO paired_souls_v1(grant_text,account) VALUES(?1,?2)",
                params![grant, account],
            )
            .map_err(|_| ("store", None))?;
        }
        let changed = tx.execute(
            "UPDATE pair_requests_v1 SET state = 'approved', account = ?2, grant_text = ?3 WHERE code = ?1 AND state = 'pending'",
            params![code, account, grant],
        ).map_err(|_|("store",None))?;
        if changed == 0 {
            return Err(("unknown-code", None));
        }
        tx.commit().map_err(|_| ("store", None))?;
        drop(db);
        self.note_world(&code, &grant).map_err(|e| (e, None))?;
        // The asked-for name is best-effort: the approval is committed, and its daemon posts the name again.
        if let Err(e) = self.note_name(&code, &grant) {
            eprintln!("directoryd: degraded: pair-name {e}");
        }
        Ok(grant)
    }

    /// A daemon polls with its secret (64 hex digits).
    pub fn poll(&self, secret: &str, now: u64) -> Poll {
        let refused = |name: &str| Poll::Refused(name.to_string(), None);
        if secret.len() != 64 || from_hex(secret).is_err() {
            return refused("unknown-request");
        }
        let hash = sha256(secret.as_bytes());
        let mut db = self.db.lock().expect("the store");
        let row: Option<PollRow> = db
            .query_row(
                "SELECT state, device, grant_text, refusal, refusal_device, force FROM pair_requests_v1
                 WHERE secret_hash = ?1",
                params![to_hex(&hash)],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()
            .unwrap_or(None);
        let Some((state, device, grant, refusal, refusal_device, force)) = row else {
            return refused("unknown-request");
        };
        {
            let mut polls = self.polls.lock().expect("polls");
            let (last, interval) = polls.entry(hash).or_insert((0, INTERVAL));
            if now < *last + *interval {
                *interval += 5;
                *last = now;
                return Poll::SlowDown(*interval);
            }
            *last = now;
        }
        match (state.as_str(), grant) {
            ("pending", _) => Poll::Pending,
            ("refused", _) => Poll::Refused(refusal.unwrap_or_default(), refusal_device),
            ("approved", Some(grant)) => {
                let code: String = match db.query_row(
                    "SELECT code FROM pair_requests_v1 WHERE secret_hash=?1",
                    params![to_hex(&hash)],
                    |r| r.get(0),
                ) {
                    Ok(code) => code,
                    Err(_) => return refused("store"),
                };
                let world = match Self::request_world(&db, &code) {
                    Ok(world) => world,
                    Err(e) => return refused(e),
                };
                // A world store that cannot say who owns the world yet leaves the approval as it is: the daemon
                // polls again, and the token is minted when the owner can be had.
                let authority = match self.authority(world.as_deref()) {
                    Ok(authority) => authority,
                    Err("world-authority-unavailable") => return Poll::Pending,
                    Err(e) => return refused(e),
                };
                let unpublished = std::cell::Cell::new(false);
                if let Some(authority) = &authority
                    && is_creator_grant(&grant)
                    && grant != authority.creator_grant()
                {
                    return refused("not-the-creator");
                }
                let token = format!("{grant}.{}", to_hex(&random::<32>()));
                let token_hash = to_hex(&sha256(token.as_bytes()));
                let stored = (|| -> Result<Result<(), String>, rusqlite::Error> {
                    let tx = db.transaction()?;
                    // An approval made while the Soul was free does not take it from a device that connected since,
                    // unless the request was forced.
                    let now_on: Option<String> = match &authority {
                        Some(authority) => tx.query_row("SELECT device FROM paired_world_tokens_v1 WHERE grant_text=?1 AND world=?2", params![grant, authority.world], |r| r.get(0)).optional()?,
                        None => tx.query_row("SELECT device FROM paired_souls_v1 WHERE grant_text=?1 AND token_hash IS NOT NULL", params![grant], |r| r.get(0)).optional()?.flatten(),
                    };
                    if let Some(other) = now_on.filter(|d| !force && *d != device) {
                        tx.execute(
                            "UPDATE pair_requests_v1 SET state = 'refused', refusal = 'soul-connected',
                               refusal_device = ?2 WHERE secret_hash = ?1 AND state = 'approved'",
                            params![to_hex(&hash), other],
                        )?;
                        tx.commit()?;
                        return Ok(Err(other));
                    }
                    tx.execute(
                        "UPDATE paired_souls_v1 SET device = ?2, token_hash = ?3 WHERE grant_text = ?1",
                        params![grant, device, token_hash],
                    )?;
                    if let Some(authority) = &authority {
                        if is_soul_grant(&grant) {
                            tx.execute(
                                "DELETE FROM paired_world_tokens_v1 WHERE grant_text=?1",
                                params![grant],
                            )?;
                        }
                        tx.execute("INSERT INTO paired_world_tokens_v1(grant_text,world,device,token_hash) VALUES(?1,?2,?3,?4)
                            ON CONFLICT(grant_text,world) DO UPDATE SET device=excluded.device,token_hash=excluded.token_hash", params![grant, authority.world, device, token_hash])?;
                    }
                    // Publish the exact world's authority before the request can become delivered. A failed file
                    // write rolls back the SQL approval transition and the same request remains recoverable: the
                    // daemon is told to keep polling. Only that world's files are written.
                    match &authority {
                        Some(authority) => self.publish_world(&tx, authority),
                        None => self.write_tokens(&tx),
                    }
                    .map_err(|e| {
                        unpublished.set(true);
                        rusqlite::Error::ToSqlConversionFailure(Box::new(e))
                    })?;
                    // Of two polls at once, one delivers.
                    if tx.execute(
                        "UPDATE pair_requests_v1 SET state = 'delivered' WHERE secret_hash = ?1 AND state = 'approved'",
                        params![to_hex(&hash)],
                    )? == 0
                    {
                        return Err(rusqlite::Error::QueryReturnedNoRows);
                    }
                    tx.commit()?;
                    Ok(Ok(()))
                })();
                if let Some(authority) = authority.as_ref().filter(|a| !a.fresh) {
                    self.owe(Some(&authority.world));
                }
                match stored {
                    Err(_) if unpublished.get() => {
                        if let Some(authority) = &authority {
                            self.owe(Some(&authority.world));
                        }
                        return Poll::Pending;
                    }
                    Err(rusqlite::Error::QueryReturnedNoRows) => return refused("delivered"),
                    Err(_) => return refused("store"),
                    Ok(Err(other)) => return Poll::Refused("soul-connected".into(), Some(other)),
                    Ok(Ok(())) => {}
                }
                Poll::Token { token, grant }
            }
            _ => refused("delivered"),
        }
    }

    /// Rewrites the gateway's tokens file from the stored hashes: written whole, then renamed into place.
    fn write_tokens(&self, db: &Connection) -> std::io::Result<()> {
        if self.write_world_tokens(db)? {
            return Ok(());
        }
        let Some(file) = &self.tokens_file else {
            return Ok(());
        };
        let mut text = String::from(
            "# Written by directoryd's pairing (W2): <grant> <sha-256 hex of its token>\n",
        );
        let mut q = db
            .prepare("SELECT grant_text, token_hash FROM paired_souls_v1 WHERE token_hash IS NOT NULL ORDER BY 1")
            .map_err(std::io::Error::other)?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(std::io::Error::other)?;
        for row in rows {
            let (g, h) = row.map_err(std::io::Error::other)?;
            text.push_str(&format!("{g} {h}\n"));
        }
        let tmp = file.with_extension("tmp");
        crate::durable::replace(file, &tmp, text.as_bytes())
    }

    /// The Souls `account` holds, each with the device it is connected to (`None`: unconnected), in grant order.
    pub fn souls(&self, account: &str) -> Result<Vec<(String, Option<String>)>, &'static str> {
        let db = self.db.lock().expect("the store");
        let mut q = db
            .prepare(
                "SELECT grant_text, CASE WHEN token_hash IS NULL THEN NULL ELSE device END FROM paired_souls_v1
                 WHERE account = ?1 AND grant_text LIKE 'soul-%' ORDER BY 1",
            )
            .map_err(|_| "store")?;
        let rows = q
            .query_map(params![account], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| "store")?;
        rows.collect::<Result<_, _>>().map_err(|_| "store")
    }

    /// `account` revokes its Soul `grant`: the token's hash leaves the store and the gateway's tokens file, and the
    /// Soul is unconnected. Revoking an unconnected Soul changes nothing and is not refused.
    pub fn revoke(&self, account: &str, grant: &str) -> Result<(), &'static str> {
        match self.soul_of(grant)? {
            None => return Err("unknown-soul"),
            Some((owner, _)) if owner != account || !is_soul_grant(grant) => {
                return Err("not-yours");
            }
            Some(_) => {}
        }
        let db = self.db.lock().expect("the store");
        let worlds = Self::worlds_of(&db, grant)?;
        db.execute(
            "UPDATE paired_souls_v1 SET device = NULL, token_hash = NULL WHERE grant_text = ?1 AND account = ?2",
            params![grant, account],
        )
        .map_err(|_| "store")?;
        db.execute(
            "DELETE FROM paired_world_tokens_v1 WHERE grant_text=?1",
            params![grant],
        )
        .map_err(|_| "store")?;
        self.publish_removal(&db, &worlds, false, || {
            self.write_tokens(&db).map_err(|_| "tokens-file")
        })
    }

    /// Every hash the store holds for a Soul's token, for a test to read.
    pub fn stored_hashes(&self) -> Vec<(String, String)> {
        let db = self.db.lock().expect("the store");
        let mut q = db
            .prepare(
                "SELECT grant_text, token_hash FROM paired_souls_v1 WHERE token_hash IS NOT NULL",
            )
            .expect("a query");
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("rows")
            .flatten()
            .collect()
    }
}
