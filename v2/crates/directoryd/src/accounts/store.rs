//! The account store (W1): one SQLite file with one owning program. It maps each exact (issuer, subject) to a random
//! account id (`acct_<uuid>`, today's `provider_accounts_v1` shape, so the accounts import X11 reads it as it is), and
//! each account to a random principal id, the only one that enters effects. The program holds SQLite's exclusive
//! lock for as long as it has the file open, so a second program opening it is refused; a consistent copy is taken
//! through the owner with SQLite's online backup, never by copying the file.

use super::{principal_from_text, principal_text, random};
use replica::ids::{Id, Scope};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

/// A signed-in account: its id, kept here and in the page, and its principal id, the one worlds see.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub account: String,
    pub principal: Id,
}

/// The store's errors, by name.
#[derive(Debug)]
pub enum StoreError {
    /// Another program holds the file.
    Owned,
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Owned => write!(f, "store-owned: another program holds the account store"),
            StoreError::Sqlite(e) => write!(f, "store: {e}"),
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> StoreError {
        StoreError::Sqlite(e)
    }
}

pub struct Store {
    db: Mutex<Connection>,
}

impl Store {
    /// Opens (or creates) the store at `path` and takes it for this program alone.
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::ZERO)?;
        // Exclusive locking before WAL: the WAL index then lives in this process's memory, and the lock taken by the
        // first write below is held until the program closes the file.
        db.pragma_update(None, "locking_mode", "EXCLUSIVE")?;
        let owned = |e: rusqlite::Error| match e.sqlite_error_code() {
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
                StoreError::Owned
            }
            _ => StoreError::Sqlite(e),
        };
        db.pragma_update(None, "journal_mode", "WAL")
            .map_err(owned)?;
        db.execute_batch(
            "PRAGMA synchronous=FULL;
             BEGIN EXCLUSIVE;
             CREATE TABLE IF NOT EXISTS provider_accounts_v1(account_id TEXT PRIMARY KEY, issuer TEXT NOT NULL,
               subject TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(issuer, subject));
             CREATE TABLE IF NOT EXISTS account_principals_v1(account_id TEXT PRIMARY KEY
               REFERENCES provider_accounts_v1(account_id), principal_id TEXT NOT NULL UNIQUE,
               created_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS account_grants_v1(account_id TEXT NOT NULL
               REFERENCES provider_accounts_v1(account_id), grant_text TEXT NOT NULL, follow TEXT,
               UNIQUE(account_id, grant_text));
             CREATE TABLE IF NOT EXISTS revoked_sessions_v1(issuer TEXT NOT NULL, session_id TEXT NOT NULL,
               revoked_at INTEGER NOT NULL, PRIMARY KEY(issuer, session_id));
             COMMIT;",
        )
        .map_err(owned)?;
        Ok(Store { db: Mutex::new(db) })
    }

    /// The account for (issuer, subject), made with its principal on the first sign-in.
    pub fn sign_in(&self, issuer: &str, subject: &str, now: u64) -> Result<Account, StoreError> {
        let mut db = self.db.lock().expect("the store");
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let found: Option<String> = tx
            .query_row(
                "SELECT account_id FROM provider_accounts_v1 WHERE issuer = ?1 AND subject = ?2",
                params![issuer, subject],
                |r| r.get(0),
            )
            .optional()?;
        let account = match found {
            Some(a) => a,
            None => {
                let a = account_id();
                tx.execute(
                    "INSERT INTO provider_accounts_v1(account_id, issuer, subject, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![a, issuer, subject, now as i64],
                )?;
                a
            }
        };
        let principal: Option<String> = tx
            .query_row(
                "SELECT principal_id FROM account_principals_v1 WHERE account_id = ?1",
                params![account],
                |r| r.get(0),
            )
            .optional()?;
        let principal = match principal.as_deref().and_then(principal_from_text) {
            Some(p) => p,
            None => {
                let p = Id::new(Scope(random()), 0).expect("counter 0 is an id");
                tx.execute(
                    "INSERT INTO account_principals_v1(account_id, principal_id, created_at) VALUES (?1, ?2, ?3)",
                    params![account, principal_text(p), now as i64],
                )?;
                p
            }
        };
        tx.commit()?;
        Ok(Account { account, principal })
    }

    /// Records that `account` owns `grant` (a Soul, `soul-…`, or a world it creates, `creator-…`; V13b), with the
    /// body the page follows for it, if any.
    pub fn own(&self, account: &str, grant: &str, follow: Option<&str>) -> Result<(), StoreError> {
        let db = self.db.lock().expect("the store");
        db.execute(
            "INSERT INTO account_grants_v1(account_id, grant_text, follow) VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id, grant_text) DO UPDATE SET follow = excluded.follow",
            params![account, grant, follow],
        )?;
        Ok(())
    }

    /// What `account` owns: each grant and the body the page follows for it, in the order recorded.
    pub fn grants(&self, account: &str) -> Result<Vec<(String, Option<String>)>, StoreError> {
        let db = self.db.lock().expect("the store");
        let mut q = db.prepare(
            "SELECT grant_text, follow FROM account_grants_v1 WHERE account_id = ?1 ORDER BY rowid",
        )?;
        let rows = q.query_map(params![account], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Records that a session was signed out: it gets no view token again, however long its token holds.
    pub fn revoke_session(&self, issuer: &str, session: &str, now: u64) -> Result<(), StoreError> {
        let db = self.db.lock().expect("the store");
        db.execute(
            "INSERT OR IGNORE INTO revoked_sessions_v1(issuer, session_id, revoked_at) VALUES (?1, ?2, ?3)",
            params![issuer, session, now as i64],
        )?;
        Ok(())
    }

    /// Whether a session was signed out.
    pub fn revoked(&self, issuer: &str, session: &str) -> Result<bool, StoreError> {
        let db = self.db.lock().expect("the store");
        Ok(db
            .query_row(
                "SELECT 1 FROM revoked_sessions_v1 WHERE issuer = ?1 AND session_id = ?2",
                params![issuer, session],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// A consistent copy of the store at `to`, taken while it is in use (SQLite's online backup), for O20 to ship.
    pub fn backup(&self, to: &Path) -> Result<(), StoreError> {
        let db = self.db.lock().expect("the store");
        let mut dst = Connection::open(to)?;
        let b = rusqlite::backup::Backup::new(&db, &mut dst)?;
        b.run_to_completion(256, Duration::ZERO, None)?;
        Ok(())
    }

    /// How many accounts the store holds.
    pub fn accounts(&self) -> Result<u64, StoreError> {
        let db = self.db.lock().expect("the store");
        Ok(
            db.query_row("SELECT COUNT(*) FROM provider_accounts_v1", [], |r| {
                r.get::<_, i64>(0)
            })? as u64,
        )
    }
}

/// `acct_` and a random (version 4) UUID, as today's registry writes it.
fn account_id() -> String {
    let mut b: [u8; 16] = random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = replica::encode::to_hex(&b);
    format!(
        "acct_{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
