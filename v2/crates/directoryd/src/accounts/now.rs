//! A Soul's public status line (Engine v2 C14, #3684; today's `now`, COMMON-LINK §2): one short line its agent writes
//! about what it is doing, shown on the Soul's page and its owner's page beside the description. Kept in the account
//! store's file beside the mailbox and the prayers, never in a world's log and never replayed, as today keeps it beside
//! the inbox.
//!
//! - **Set** by the Soul's daemon through the gateway, which has already checked the socket's grant (`{"now": {"n",
//!   "text"}}`, passed on as `POST /v1/mailbox/now`). An empty or blank line clears it.
//! - **The line** is cleaned as today's server cleans it: control characters, zero-width and bidi marks become spaces,
//!   runs of space become one, the ends are trimmed. At most [`NOW_MOST`] characters after that; a longer one is
//!   refused `now.too-long` and the line kept as it was. Text only: every reader sets it as text.
//! - **Read** by anyone (`POST /v1/account/now`): the line is public, as the Soul's page is. Nothing else about the
//!   Soul or its owner is in the answer.
//! - At most [`SETS_MOST`] sets a Soul in [`SETS_WINDOW_S`] seconds (today's 30 a minute); more are refused
//!   `now.too-often`.

use super::store::{Store, StoreError};
use rusqlite::{OptionalExtension, params};

/// The longest line, in characters (today's 140).
pub const NOW_MOST: usize = 140;
/// The most sets a Soul makes in [`SETS_WINDOW_S`].
pub const SETS_MOST: i64 = 30;
pub const SETS_WINDOW_S: u64 = 60;
/// The most Souls one read asks for (their grants fit the 4,096-byte body).
pub const READ_MOST: usize = 64;

/// The table this module keeps in the account store.
pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS soul_now_v1(soul TEXT PRIMARY KEY, text TEXT, at INTEGER,
    window_at INTEGER NOT NULL, window_n INTEGER NOT NULL);";

/// A Soul's line and when it was set (seconds since 1970).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Now {
    pub text: String,
    pub at: u64,
}

/// Is this a Soul's grant as the gateway writes it: `soul-<32 hex>-<counter>`?
pub fn is_soul(grant: &str) -> bool {
    super::prayers::scope_of(grant, "soul").is_some()
}

/// The line as it is kept: cleaned, or `None` to clear; refused `now.too-long` past [`NOW_MOST`] characters.
pub fn clean(raw: &str) -> Result<Option<String>, &'static str> {
    let spaced: String = raw
        .chars()
        .map(|c| {
            let hidden = c.is_control()
                || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{061c}' | '\u{feff}' | '\u{e0000}'..='\u{e007f}');
            if hidden { ' ' } else { c }
        })
        .collect();
    let text = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.chars().count() {
        0 => Ok(None),
        n if n > NOW_MOST => Err("now.too-long"),
        _ => Ok(Some(text)),
    }
}

impl Store {
    /// `soul` sets its line (`None`: cleared); the line kept, or the refusal's name.
    pub fn now_set(
        &self,
        soul: &str,
        raw: &str,
        now: u64,
    ) -> Result<Result<Option<Now>, &'static str>, StoreError> {
        if !is_soul(soul) {
            return Ok(Err("now.not-a-soul"));
        }
        let text = match clean(raw) {
            Ok(t) => t,
            Err(e) => return Ok(Err(e)),
        };
        let db = self.db.lock().expect("the store");
        let window: Option<(i64, i64)> = db
            .query_row(
                "SELECT window_at, window_n FROM soul_now_v1 WHERE soul = ?1",
                params![soul],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (window_at, n) = match window {
            Some((at, n)) if now.saturating_sub(at as u64) < SETS_WINDOW_S => (at, n),
            _ => (now as i64, 0),
        };
        if n >= SETS_MOST {
            return Ok(Err("now.too-often"));
        }
        db.execute(
            "INSERT INTO soul_now_v1(soul, text, at, window_at, window_n) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(soul) DO UPDATE SET text = ?2, at = ?3, window_at = ?4, window_n = ?5",
            params![soul, text, text.as_ref().map(|_| now as i64), window_at, n + 1],
        )?;
        Ok(Ok(text.map(|text| Now { text, at: now })))
    }

    /// The lines of those of `souls` that have one, in the order asked.
    pub fn now_of(&self, souls: &[&str]) -> Result<Vec<(String, Now)>, StoreError> {
        let db = self.db.lock().expect("the store");
        let mut q =
            db.prepare("SELECT text, at FROM soul_now_v1 WHERE soul = ?1 AND text IS NOT NULL")?;
        let mut out = Vec::new();
        for soul in souls.iter().filter(|s| is_soul(s)) {
            if let Some(now) = q
                .query_row(params![soul], |r| {
                    Ok(Now {
                        text: r.get(0)?,
                        at: r.get::<_, i64>(1)? as u64,
                    })
                })
                .optional()?
            {
                out.push((soul.to_string(), now));
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000;
    const SCOPE: &str = "4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d";

    fn store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "c14-now-{}",
            replica::encode::to_hex(&super::super::random::<8>())
        ));
        std::fs::create_dir_all(&dir).expect("a temp dir");
        (Store::open(&dir.join("accounts.db")).expect("a store"), dir)
    }

    #[test]
    fn a1_a_line_is_set_cleaned_cleared_and_refused_by_name_when_too_long() {
        let (s, dir) = store();
        let soul = format!("soul-{SCOPE}-3");
        let set = s
            .now_set(&soul, "  Reading\nby the\u{200b}fire \u{202e} ", T0)
            .unwrap()
            .unwrap();
        assert_eq!(
            set,
            Some(Now {
                text: "Reading by the fire".into(),
                at: T0
            })
        );
        assert_eq!(s.now_of(&[soul.as_str()]).unwrap(), [(soul.clone(), set.clone().unwrap())]);
        // 140 characters (not bytes) is a line; 141 is refused and the line kept.
        assert!(s.now_set(&soul, &"é".repeat(NOW_MOST), T0 + 1).unwrap().is_ok());
        assert_eq!(
            s.now_set(&soul, &"x".repeat(NOW_MOST + 1), T0 + 2).unwrap(),
            Err("now.too-long")
        );
        assert_eq!(s.now_of(&[soul.as_str()]).unwrap()[0].1.text, "é".repeat(NOW_MOST));
        // Empty or blank clears it.
        assert_eq!(s.now_set(&soul, " \n ", T0 + 3).unwrap(), Ok(None));
        assert!(s.now_of(&[soul.as_str()]).unwrap().is_empty());
        // Only a Soul's grant has a line.
        assert_eq!(
            s.now_set(&format!("creator-{SCOPE}-0"), "hi", T0).unwrap(),
            Err("now.not-a-soul")
        );
        drop(s);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a3_a_read_answers_only_the_lines_asked_for_and_sets_are_limited() {
        let (s, dir) = store();
        let a = format!("soul-{SCOPE}-1");
        let b = format!("soul-{SCOPE}-2");
        s.now_set(&a, "Fishing", T0).unwrap().unwrap();
        s.now_set(&b, "Asleep", T0).unwrap().unwrap();
        let got = s.now_of(&[b.as_str(), "not-a-grant", a.as_str()]).unwrap();
        assert_eq!(
            got.iter().map(|(g, n)| (g.as_str(), n.text.as_str())).collect::<Vec<_>>(),
            [(b.as_str(), "Asleep"), (a.as_str(), "Fishing")]
        );
        // 30 sets a minute; the window opens again after it.
        for i in 1..SETS_MOST {
            assert!(s.now_set(&a, &format!("step {i}"), T0 + 1).unwrap().is_ok());
        }
        assert_eq!(s.now_set(&a, "one more", T0 + 2).unwrap(), Err("now.too-often"));
        assert!(s.now_set(&a, "later", T0 + SETS_WINDOW_S).unwrap().is_ok());
        drop(s);
        let _ = std::fs::remove_dir_all(dir);
    }
}
