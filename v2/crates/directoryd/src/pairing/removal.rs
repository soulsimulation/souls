//! Who may remove a person's words (Engine v2 W7, #2826, A5). A removal acts on one world's text store
//! (`worldd remove-words`, `worldd::removal`); before it does, the directory, which alone knows accounts, Souls'
//! owners and worlds' creators, says whether the account that asks may:
//!
//! 1. **Their own** ([`Role::Own`]): the account owns every Soul named (`paired_souls_v1`, as a pairing checks
//!    `not-yours`).
//! 2. **The world's creator** ([`Role::Creator`]): the account holds the world's current creator grant (the
//!    registry's world, its owner as last read, as a creator's pairing checks it). Any Soul's words in that world,
//!    and only that world's: a removal never reaches past the world it names.
//! 3. **A site owner** ([`Role::Site`]): the account is one of the site's owners (`SIM_SITE_OWNERS`, the canonical
//!    account ids the ops page admits), anywhere.
//!
//! A site owner is checked first (so neither store ever holds one back), then their own, then the creator. Anyone
//! else is refused `removal.not-allowed`, and nothing is removed. The caller passes `holds` from the signed-in
//! account's own grants, never from the request.

use super::{Pairing, is_soul_grant};
use rusqlite::{OptionalExtension, params};
use std::collections::BTreeSet;

/// Why an account may remove the words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Own,
    Creator,
    Site,
}

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Role::Own => "own",
            Role::Creator => "creator",
            Role::Site => "site",
        }
    }
}

impl Pairing {
    /// Whether `account` may remove the words of the Souls `souls` (their grants) in `world`, and as whom. `holds`
    /// says whether the account holds a grant (its accounts, as a creator's pairing asks); `site`, the site's owners.
    pub fn may_remove_words(
        &self,
        account: &str,
        world: &str,
        souls: &[&str],
        holds: impl Fn(&str) -> bool,
        site: &BTreeSet<String>,
    ) -> Result<Role, &'static str> {
        if souls.is_empty() {
            return Err("souls-required");
        }
        if souls.iter().any(|s| !is_soul_grant(s)) {
            return Err("soul-grant");
        }
        // A site owner first: neither the pairing store nor a slow world store ever holds one back.
        if site.contains(account) {
            return Ok(Role::Site);
        }
        let own = {
            let db = self.db.lock().expect("the store");
            let mut q = db
                .prepare("SELECT account FROM paired_souls_v1 WHERE grant_text=?1")
                .map_err(|_| "store")?;
            let mut all = true;
            for s in souls {
                let owner: Option<String> = q
                    .query_row(params![s], |r| r.get(0))
                    .optional()
                    .map_err(|_| "store")?;
                all &= owner.as_deref() == Some(account);
            }
            all
        };
        if own {
            return Ok(Role::Own);
        }
        match self.authority(Some(world)) {
            Ok(Some(a)) if !a.creator.is_empty() && holds(&a.creator_grant()) => Ok(Role::Creator),
            Ok(_) | Err("world-unplaced") => Err("removal.not-allowed"),
            Err(e) => Err(e),
        }
    }
}
