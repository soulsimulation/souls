//! Prayers (Engine v2 G11, #3335): a Soul's words to its world's creator, and the creator's answer, the mailbox's
//! other direction. Kept in the account store's file beside the mailbox, never in a world's log; the backup of that
//! file (O20) holds them, and removing a person's words (W7) must reach `prayers_v1` as it does `mailbox_v1`.
//!
//! A prayer is kept under its world, the Soul's own scope (T3: a new scope for every world). Its world's creator is the
//! principal the list of worlds (W3/G9) names as that world's creator, holding the creator grant of that principal
//! (W5's and G7's); a world the list has no row for (one started by hand, as in tests) is its own scope's creator
//! grant's ([`creator_worlds`]). The gateway has already checked the grant. A prayer is `waiting` until answered; an answer may be changed, and each answer is given to the Soul's socket until its daemon
//! says it has it (`delivered`). Text limits are in characters, as today's server counts them.

use super::random;
use super::store::{Store, StoreError};
use rusqlite::{OptionalExtension, params};

/// The longest prayer, in characters.
pub const PRAYER_MOST: usize = 2000;
/// The longest answer, in characters.
pub const ANSWER_MOST: usize = 4000;
/// An answer not taken by its Soul in this many seconds is no longer offered (the Soul's list still shows it).
pub const OFFER_MOST_S: u64 = 7 * 24 * 3600;
/// The most prayers one list gives.
const LIST_MOST: i64 = 100;

/// One prayer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prayer {
    pub id: String,
    /// The Soul's grant, as the gateway writes it.
    pub soul: String,
    pub text: String,
    pub at: u64,
    pub answer: Option<String>,
    pub answered_at: Option<u64>,
}

/// The scope hex of a grant of `kind` (`soul` or `creator`): `<kind>-<32 hex>-<counter>`.
pub fn scope_of<'a>(grant: &'a str, kind: &str) -> Option<&'a str> {
    let rest = grant.strip_prefix(kind)?.strip_prefix('-')?;
    let (scope, counter) = rest.split_once('-')?;
    (scope.len() == 32
        && scope.bytes().all(|b| b.is_ascii_hexdigit())
        && !counter.is_empty()
        && counter.bytes().all(|b| b.is_ascii_digit()))
    .then_some(scope)
}

/// The worlds (scope hex) whose creator `grant` is, given the list's rows as (lineage hex, creator principal text):
/// those the list names its principal (`<scope hex>:<counter>`) the creator of, and the grant's own scope when no row
/// has that lineage. `None` for a grant that is not a creator's.
pub fn creator_worlds(grant: &str, rows: &[(String, String)]) -> Option<Vec<String>> {
    let scope = scope_of(grant, "creator")?;
    let principal = format!("{scope}:{}", grant.rsplit('-').next()?);
    let mut worlds: Vec<String> = rows
        .iter()
        .filter(|(_, c)| *c == principal)
        .map(|(l, _)| l.clone())
        .collect();
    if !rows.iter().any(|(l, _)| l == scope) {
        worlds.push(scope.to_string());
    }
    Some(worlds)
}

fn sized(text: &str, most: usize) -> Result<(), &'static str> {
    match text.trim().chars().count() {
        0 => Err("empty"),
        n if n > most => Err("too-long"),
        _ => Ok(()),
    }
}

impl Store {
    /// `soul` prays; the prayer's id, or the refusal's name.
    pub fn pray(
        &self,
        soul: &str,
        text: &str,
        now: u64,
    ) -> Result<Result<String, &'static str>, StoreError> {
        let Some(scope) = scope_of(soul, "soul") else {
            return Ok(Err("prayer.not-a-soul"));
        };
        match sized(text, PRAYER_MOST) {
            Err("empty") => return Ok(Err("prayer.empty")),
            Err(_) => return Ok(Err("prayer.too-long")),
            Ok(()) => {}
        }
        let id = format!("p_{}", replica::encode::to_hex(&random::<6>()));
        let db = self.db.lock().expect("the store");
        db.execute(
            "INSERT INTO prayers_v1(id, soul, scope, text, at, delivered) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            params![id, soul, scope, text.trim(), now as i64],
        )?;
        Ok(Ok(id))
    }

    /// `soul`'s own prayers, newest first.
    pub fn prayers_of(&self, soul: &str) -> Result<Vec<Prayer>, StoreError> {
        let db = self.db.lock().expect("the store");
        let mut q = db.prepare(
            "SELECT id, soul, text, at, answer, answered_at FROM prayers_v1 WHERE soul = ?1
             ORDER BY at DESC, id LIMIT ?2",
        )?;
        let rows = q
            .query_map(params![soul, LIST_MOST], row)?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// The prayers to the creator of `worlds` ([`creator_worlds`]): waiting ones first, oldest first; with `all`, then
    /// the answered ones, newest first.
    pub fn prayers_to(&self, worlds: &[String], all: bool) -> Result<Vec<Prayer>, StoreError> {
        let scopes = serde_json::to_string(worlds).unwrap_or_default();
        let db = self.db.lock().expect("the store");
        let mut q = db.prepare(
            "SELECT id, soul, text, at, answer, answered_at FROM prayers_v1
             WHERE scope IN (SELECT value FROM json_each(?1)) AND (answer IS NULL OR ?2)
             ORDER BY answer IS NOT NULL, CASE WHEN answer IS NULL THEN at ELSE -answered_at END, id LIMIT ?3",
        )?;
        let rows = q
            .query_map(params![scopes, all, LIST_MOST], row)?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// The creator of `worlds` answers prayer `id` (again, if answered before); the prayer, or the refusal's name.
    pub fn answer(
        &self,
        worlds: &[String],
        id: &str,
        text: &str,
        now: u64,
    ) -> Result<Result<Prayer, &'static str>, StoreError> {
        let scopes = serde_json::to_string(worlds).unwrap_or_default();
        match sized(text, ANSWER_MOST) {
            Err("empty") => return Ok(Err("answer.empty")),
            Err(_) => return Ok(Err("answer.too-long")),
            Ok(()) => {}
        }
        let db = self.db.lock().expect("the store");
        let n = db.execute(
            "UPDATE prayers_v1 SET answer = ?3, answered_at = ?4, delivered = 0
             WHERE id = ?1 AND scope IN (SELECT value FROM json_each(?2))",
            params![id, scopes, text.trim(), now as i64],
        )?;
        if n != 1 {
            return Ok(Err("prayer.not-found"));
        }
        let p = db.query_row(
            "SELECT id, soul, text, at, answer, answered_at FROM prayers_v1 WHERE id = ?1",
            params![id],
            row,
        )?;
        Ok(Ok(p))
    }

    /// The answers not yet taken by their Souls, oldest first, within [`OFFER_MOST_S`].
    pub fn answers_open(&self, now: u64) -> Result<Vec<Prayer>, StoreError> {
        let db = self.db.lock().expect("the store");
        let mut q = db.prepare(
            "SELECT id, soul, text, at, answer, answered_at FROM prayers_v1
             WHERE answer IS NOT NULL AND delivered = 0 AND answered_at + ?1 > ?2 ORDER BY answered_at, id",
        )?;
        let rows = q
            .query_map(params![OFFER_MOST_S as i64, now as i64], row)?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// `soul`'s daemon has the answer to its prayer `id`. False if there is no such answered prayer of that Soul's.
    pub fn answer_taken(&self, id: &str, soul: &str) -> Result<bool, StoreError> {
        let db = self.db.lock().expect("the store");
        let n = db.execute(
            "UPDATE prayers_v1 SET delivered = 1 WHERE id = ?1 AND soul = ?2 AND answer IS NOT NULL",
            params![id, soul],
        )?;
        Ok(n == 1)
    }

    /// One prayer, by id.
    pub fn prayer(&self, id: &str) -> Result<Option<Prayer>, StoreError> {
        let db = self.db.lock().expect("the store");
        Ok(db
            .query_row(
                "SELECT id, soul, text, at, answer, answered_at FROM prayers_v1 WHERE id = ?1",
                params![id],
                row,
            )
            .optional()?)
    }
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Prayer> {
    Ok(Prayer {
        id: r.get(0)?,
        soul: r.get(1)?,
        text: r.get(2)?,
        at: r.get::<_, i64>(3)? as u64,
        answer: r.get(4)?,
        answered_at: r.get::<_, Option<i64>>(5)?.map(|t| t as u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000;
    const SCOPE: &str = "2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b";

    fn store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "g11-prayers-{}",
            replica::encode::to_hex(&random::<8>())
        ));
        std::fs::create_dir_all(&dir).expect("a temp dir");
        (Store::open(&dir.join("accounts.db")).expect("a store"), dir)
    }

    #[test]
    fn a_prayer_waits_until_its_creator_answers_and_the_answer_is_offered_until_taken() {
        let (s, dir) = store();
        let soul = format!("soul-{SCOPE}-2");
        let creator = creator_worlds(&format!("creator-{SCOPE}-0"), &[]).unwrap();
        let other = creator_worlds(&format!("creator-{}-0", "3c".repeat(16)), &[]).unwrap();
        let a = s.pray(&soul, "let it rain", T0).unwrap().unwrap();
        let b = s.pray(&soul, "and a bridge", T0 + 1).unwrap().unwrap();
        // The world's creator sees both waiting, oldest first; another world's creator sees none.
        let ids = |v: Vec<Prayer>| v.into_iter().map(|p| p.id).collect::<Vec<_>>();
        assert_eq!(
            ids(s.prayers_to(&creator, false).unwrap()),
            [a.as_str(), b.as_str()]
        );
        assert!(s.prayers_to(&other, true).unwrap().is_empty());
        assert_eq!(creator_worlds(&soul, &[]), None);
        // Only that world's creator answers it.
        assert_eq!(
            s.answer(&other, &a, "no", T0 + 2).unwrap(),
            Err("prayer.not-found")
        );
        let p = s.answer(&creator, &a, "it will", T0 + 3).unwrap().unwrap();
        assert_eq!(p.answer.as_deref(), Some("it will"));
        // Waiting first; answered ones with all.
        assert_eq!(ids(s.prayers_to(&creator, false).unwrap()), [b.as_str()]);
        assert_eq!(
            ids(s.prayers_to(&creator, true).unwrap()),
            [b.as_str(), a.as_str()]
        );
        // The answer is offered until the Soul's daemon takes it, and only its own Soul takes it.
        assert_eq!(ids(s.answers_open(T0 + 4).unwrap()), [a.as_str()]);
        assert!(!s.answer_taken(&a, &format!("soul-{SCOPE}-9")).unwrap());
        assert!(!s.answer_taken(&b, &soul).unwrap(), "not answered yet");
        assert!(s.answer_taken(&a, &soul).unwrap());
        assert!(s.answers_open(T0 + 4).unwrap().is_empty());
        assert_eq!(s.answers_open(T0 + 4).unwrap().len(), 0);
        // The Soul's own list: each, waiting or answered.
        let mine = s.prayers_of(&soul).unwrap();
        assert_eq!(
            mine.iter()
                .map(|p| (p.id.as_str(), p.answer.as_deref()))
                .collect::<Vec<_>>(),
            [(b.as_str(), None), (a.as_str(), Some("it will"))]
        );
        drop(s);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_worlds_creator_is_the_principal_the_list_names() {
        let lineage = "5e".repeat(16);
        let principal = "7a".repeat(16);
        let rows = [(lineage.clone(), format!("{principal}:3"))];
        // The list's creator of a world: that world, and its own scope only when the list has no row for it.
        assert_eq!(
            creator_worlds(&format!("creator-{principal}-3"), &rows),
            Some(vec![lineage.clone(), principal.clone()])
        );
        // Another principal, or the same principal's other counter: not that world's creator.
        assert_eq!(
            creator_worlds(&format!("creator-{principal}-4"), &rows),
            Some(vec![principal.clone()])
        );
        // A grant whose scope is a listed world's lineage is not its creator unless the list says so.
        assert_eq!(
            creator_worlds(&format!("creator-{lineage}-0"), &rows),
            Some(vec![])
        );
    }

    #[test]
    fn a5_a_prayer_over_2000_characters_or_an_answer_over_4000_is_refused_by_name() {
        let (s, dir) = store();
        let soul = format!("soul-{SCOPE}-2");
        let creator = vec![SCOPE.to_string()];
        // Characters, not bytes: 2,000 two-byte characters are a prayer.
        assert!(s.pray(&soul, &"é".repeat(PRAYER_MOST), T0).unwrap().is_ok());
        assert_eq!(
            s.pray(&soul, &"x".repeat(PRAYER_MOST + 1), T0).unwrap(),
            Err("prayer.too-long")
        );
        assert_eq!(s.pray(&soul, "  ", T0).unwrap(), Err("prayer.empty"));
        assert_eq!(
            s.pray(&format!("creator-{SCOPE}-0"), "hi", T0).unwrap(),
            Err("prayer.not-a-soul")
        );
        let id = s.pray(&soul, "hear me", T0).unwrap().unwrap();
        assert!(
            s.answer(&creator, &id, &"y".repeat(ANSWER_MOST), T0)
                .unwrap()
                .is_ok()
        );
        assert_eq!(
            s.answer(&creator, &id, &"y".repeat(ANSWER_MOST + 1), T0)
                .unwrap(),
            Err("answer.too-long")
        );
        assert_eq!(
            s.answer(&creator, &id, "", T0).unwrap(),
            Err("answer.empty")
        );
        assert_eq!(
            s.prayer(&id).unwrap().unwrap().answer.map(|a| a.len()),
            Some(ANSWER_MOST)
        );
        drop(s);
        let _ = std::fs::remove_dir_all(dir);
    }
}
