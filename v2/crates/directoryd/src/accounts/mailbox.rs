//! The mailbox (Engine v2 R13, #2753): an owner's messages to their Soul, kept in the account store's file beside
//! the accounts, never in a world's log. The page's box (W10) puts one through the gateway.
//!
//! A message is `open` until the Soul's daemon closes it with the outcome of the act that served it (`done` or
//! `failed`, and the outcome's name), through the gateway. One still open [`OPEN_MOST_S`] after it was put is closed
//! `failed`, outcome `expired`, the next time the mailbox is read.

use super::random;
use super::store::{Store, StoreError};
use rusqlite::{OptionalExtension, params};

/// A message not closed in this many seconds closes `failed`.
pub const OPEN_MOST_S: u64 = 15 * 60;
/// The longest message, in bytes.
pub const TEXT_MOST: usize = 2000;

/// One message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mail {
    pub id: String,
    /// The Soul's grant, as the gateway writes it.
    pub soul: String,
    pub text: String,
    pub at: u64,
    /// `open`, `done` or `failed`.
    pub state: String,
    pub outcome: Option<String>,
}

fn name_like(s: &str, most: usize) -> bool {
    (1..=most).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

impl Store {
    /// Puts a message for `soul`; its id. `None` for a Soul or a text not in the form.
    pub fn mail_put(&self, soul: &str, text: &str, now: u64) -> Result<Option<String>, StoreError> {
        if !name_like(soul, 100) || text.is_empty() || text.len() > TEXT_MOST {
            return Ok(None);
        }
        let id = format!("m_{}", replica::encode::to_hex(&random::<8>()));
        let db = self.db.lock().expect("the store");
        db.execute(
            "INSERT INTO mailbox_v1(id, soul, text, at, state) VALUES (?1, ?2, ?3, ?4, 'open')",
            params![id, soul, text, now as i64],
        )?;
        Ok(Some(id))
    }

    /// Every open message, oldest first, after closing those open too long as `failed`.
    pub fn mail_open(&self, now: u64) -> Result<Vec<Mail>, StoreError> {
        let db = self.db.lock().expect("the store");
        db.execute(
            "UPDATE mailbox_v1 SET state = 'failed', outcome = 'expired', closed_at = ?1
             WHERE state = 'open' AND at + ?2 <= ?1",
            params![now as i64, OPEN_MOST_S as i64],
        )?;
        let mut q = db.prepare(
            "SELECT id, soul, text, at, state, outcome FROM mailbox_v1 WHERE state = 'open' ORDER BY at, id",
        )?;
        let rows = q.query_map([], row)?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Closes `soul`'s open message `id` as `state` (`done` or `failed`) with the outcome's name. False if there is
    /// no such open message of that Soul's, or the state or outcome is not in the form.
    pub fn mail_close(
        &self,
        id: &str,
        soul: &str,
        state: &str,
        outcome: &str,
        now: u64,
    ) -> Result<bool, StoreError> {
        if !matches!(state, "done" | "failed") || !name_like(outcome, 64) {
            return Ok(false);
        }
        let db = self.db.lock().expect("the store");
        let n = db.execute(
            "UPDATE mailbox_v1 SET state = ?3, outcome = ?4, closed_at = ?5
             WHERE id = ?1 AND soul = ?2 AND state = 'open'",
            params![id, soul, state, outcome, now as i64],
        )?;
        Ok(n == 1)
    }

    /// One message, by id.
    pub fn mail(&self, id: &str) -> Result<Option<Mail>, StoreError> {
        let db = self.db.lock().expect("the store");
        Ok(db
            .query_row(
                "SELECT id, soul, text, at, state, outcome FROM mailbox_v1 WHERE id = ?1",
                params![id],
                row,
            )
            .optional()?)
    }
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Mail> {
    Ok(Mail {
        id: r.get(0)?,
        soul: r.get(1)?,
        text: r.get(2)?,
        at: r.get::<_, i64>(3)? as u64,
        state: r.get(4)?,
        outcome: r.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000;
    const SOUL: &str = "soul-2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b-2";

    fn store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "r13-mailbox-{}",
            replica::encode::to_hex(&random::<8>())
        ));
        std::fs::create_dir_all(&dir).expect("a temp dir");
        (Store::open(&dir.join("accounts.db")).expect("a store"), dir)
    }

    #[test]
    fn a4_a_message_closes_with_its_outcome_or_failed_after_15_minutes() {
        let (s, dir) = store();
        let a = s
            .mail_put(SOUL, "come to the library", T0)
            .unwrap()
            .unwrap();
        let b = s.mail_put(SOUL, "wave at Ada", T0 + 60).unwrap().unwrap();
        assert_eq!(s.mail_open(T0 + 60).unwrap().len(), 2);
        // Only its own Soul closes it, once, with a state and an outcome in the form.
        assert!(
            !s.mail_close(&a, "soul-other-1", "done", "completed", T0 + 61)
                .unwrap()
        );
        assert!(
            !s.mail_close(&a, SOUL, "maybe", "completed", T0 + 61)
                .unwrap()
        );
        assert!(
            s.mail_close(&a, SOUL, "done", "completed", T0 + 61)
                .unwrap()
        );
        assert!(!s.mail_close(&a, SOUL, "failed", "again", T0 + 62).unwrap());
        let m = s.mail(&a).unwrap().unwrap();
        assert_eq!(
            (m.state.as_str(), m.outcome.as_deref()),
            ("done", Some("completed"))
        );
        // Not closed in 15 minutes: closed `failed`, `expired`, at the next read.
        let open = s.mail_open(T0 + 60 + OPEN_MOST_S - 1).unwrap();
        assert_eq!(
            open.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            [b.as_str()]
        );
        assert!(s.mail_open(T0 + 60 + OPEN_MOST_S).unwrap().is_empty());
        let m = s.mail(&b).unwrap().unwrap();
        assert_eq!(
            (m.state.as_str(), m.outcome.as_deref()),
            ("failed", Some("expired"))
        );
        assert!(
            !s.mail_close(&b, SOUL, "done", "completed", T0 + 61 + OPEN_MOST_S)
                .unwrap()
        );
        // Out of form: no Soul, no text, too long.
        assert_eq!(s.mail_put("", "x", T0).unwrap(), None);
        assert_eq!(s.mail_put(SOUL, "", T0).unwrap(), None);
        assert_eq!(
            s.mail_put(SOUL, &"x".repeat(TEXT_MOST + 1), T0).unwrap(),
            None
        );
        drop(s);
        let _ = std::fs::remove_dir_all(dir);
    }
}
