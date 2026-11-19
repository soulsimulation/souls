//! Tokens (Engine v2 I1, #2683). A token is the id of what it grants and 32 random bytes, written
//! `<grant>.<64 hex digits>`. The grant is an actor today (a Soul, `soul-<scope hex>-<counter>`, or a creator,
//! `creator-<scope hex>-<counter>`); a session's set of grants (I12) is another grant form, not another token shape.
//! The gateway stores only each token's SHA-256, compares in constant time, and can revoke a token. A token is never
//! printed: [`Token`]'s `Debug` and `Display` show its grant alone.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use replica::effects::Actor;
use replica::encode::{Value, encode, from_hex, to_hex};
use replica::ids::{Id, Scope, sha256};
use subtle::ConstantTimeEq;

/// What a token grants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grant {
    /// One actor: a Soul or a creator. Its intents must name it as their actor.
    Actor(Actor),
}

impl Grant {
    /// The grant as text, the part of a token before its secret.
    pub fn to_text(self) -> String {
        let Grant::Actor(a) = self;
        let (kind, id) = match a {
            Actor::Soul(id) => ("soul", id),
            Actor::Creator(id) => ("creator", id),
            Actor::World => return "world".to_owned(),
        };
        format!("{kind}-{}-{}", to_hex(&id.scope().0), id.counter())
    }

    /// Reads a grant's text; `None` if it is not one.
    pub fn parse(text: &str) -> Option<Grant> {
        let mut parts = text.split('-');
        let (kind, scope, counter) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let scope: [u8; 16] = from_hex(scope).ok()?.try_into().ok()?;
        let id = Id::new(Scope(scope), counter.parse().ok()?)?;
        match kind {
            "soul" => Some(Grant::Actor(Actor::Soul(id))),
            "creator" => Some(Grant::Actor(Actor::Creator(id))),
            _ => None,
        }
    }

    /// The actor's bytes as an intent names it (T10 field 1), the key answers are routed by.
    pub fn key(self) -> Vec<u8> {
        let Grant::Actor(a) = self;
        actor_key(a)
    }
}

/// An actor's bytes as an intent and an answer carry it (`{1: 1 Soul or 2 creator, 2: id}`).
pub fn actor_key(a: Actor) -> Vec<u8> {
    let v = match a {
        Actor::Soul(id) => Value::Map([(1, Value::Uint(1)), (2, id.to_value())].into()),
        Actor::Creator(id) => Value::Map([(1, Value::Uint(2)), (2, id.to_value())].into()),
        Actor::World => Value::Map([(1, Value::Uint(3))].into()),
    };
    encode(&v).unwrap_or_default()
}

/// A token as presented. Its text is private to this module and never formatted.
pub struct Token {
    grant: Grant,
    text: String,
}

impl Token {
    /// Reads a presented token; `None` if it is not `<grant>.<64 hex digits>`.
    pub fn parse(text: &str) -> Option<Token> {
        let (grant, secret) = text.trim().rsplit_once('.')?;
        if secret.len() != 64 || from_hex(secret).is_err() {
            return None;
        }
        Some(Token {
            grant: Grant::parse(grant)?,
            text: text.trim().to_owned(),
        })
    }

    /// A new token for `grant`, its 32 bytes from the operating system's random source.
    pub fn issue(grant: Grant) -> Result<Token, getrandom::Error> {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret)?;
        Ok(Token {
            grant,
            text: format!("{}.{}", grant.to_text(), to_hex(&secret)),
        })
    }

    pub fn grant(&self) -> Grant {
        self.grant
    }

    /// The token's text, to hand to its holder once. The gateway never keeps it.
    pub fn reveal(&self) -> &str {
        &self.text
    }

    /// The SHA-256 of the token's text: what the gateway stores.
    pub fn hash(&self) -> [u8; 32] {
        sha256(self.text.as_bytes())
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Token({}, secret withheld)", self.grant.to_text())
    }
}

impl fmt::Display for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.<withheld>", self.grant.to_text())
    }
}

/// Why a token was refused. One name for every case, so a caller learns nothing about which part was wrong.
pub const REFUSED: &str = "token.refused";

/// The stored tokens: per grant (by its text), the SHA-256 of each live token, and the account that owns the grant if
/// the file names one (for the receipts file; never part of a check).
#[derive(Default)]
pub struct Tokens {
    by_grant: BTreeMap<String, (Grant, Vec<[u8; 32]>)>,
    accounts: BTreeMap<String, String>,
}

impl Tokens {
    /// Stores a token's hash, never the token.
    pub fn add(&mut self, grant: Grant, hash: [u8; 32]) {
        self.by_grant
            .entry(grant.to_text())
            .or_insert_with(|| (grant, Vec::new()))
            .1
            .push(hash);
    }

    /// Names the account that owns `grant`.
    pub fn set_account(&mut self, grant: Grant, account: &str) {
        self.accounts.insert(grant.to_text(), account.to_owned());
    }

    /// The account that owns `grant`, if one is named.
    pub fn account(&self, grant: Grant) -> Option<&str> {
        self.accounts.get(&grant.to_text()).map(String::as_str)
    }

    /// Revokes the token with this hash. True if it was stored.
    pub fn revoke(&mut self, hash: &[u8; 32]) -> bool {
        let mut found = false;
        for (_, hashes) in self.by_grant.values_mut() {
            hashes.retain(|h| {
                let same = bool::from(h.ct_eq(hash));
                found |= same;
                !same
            });
        }
        found
    }

    /// What a presented token grants, or `None`. The hash is compared in constant time against every hash stored
    /// for the grant it names.
    pub fn check(&self, presented: &Token) -> Option<Grant> {
        let hash = presented.hash();
        let (_, hashes) = self.by_grant.get(&presented.grant.to_text())?;
        let mut ok = subtle::Choice::from(0);
        for h in hashes {
            ok |= h.ct_eq(&hash);
        }
        bool::from(ok).then_some(presented.grant)
    }

    /// The hashes stored, as `(grant, hash)`: what a test reads to see that nothing else is kept.
    pub fn stored(&self) -> impl Iterator<Item = (Grant, &[u8; 32])> {
        self.by_grant
            .values()
            .flat_map(|(g, hs)| hs.iter().map(move |h| (*g, h)))
    }

    /// Reads a file of `<grant> <sha-256 hex> [<account>]` lines.
    pub fn read(text: &str) -> Result<Tokens, String> {
        let mut t = Tokens::default();
        for (n, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let bad = || {
                format!(
                    "tokens line {}: want `<grant> <sha-256 hex> [<account>]`",
                    n + 1
                )
            };
            let mut words = line.split_whitespace();
            let (Some(g), Some(h), account, None) =
                (words.next(), words.next(), words.next(), words.next())
            else {
                return Err(bad());
            };
            let grant = Grant::parse(g).ok_or_else(bad)?;
            let hash: [u8; 32] = from_hex(h)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(bad)?;
            t.add(grant, hash);
            if let Some(a) = account {
                t.set_account(grant, a);
            }
        }
        Ok(t)
    }

    /// One line of the file [`Tokens::read`] reads.
    pub fn line(grant: Grant, hash: &[u8; 32]) -> String {
        format!("{} {}\n", grant.to_text(), to_hex(hash))
    }
}

/// What tells a tokens file's versions apart: its modification time, length and inode (a file written whole and
/// renamed into place, as the directory writes it, is a new inode).
type Stamp = (Option<std::time::SystemTime>, u64, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok(), m.len(), m.ino()))
}

fn read_file(path: &Path) -> Result<Tokens, String> {
    std::fs::read_to_string(path)
        .map_err(|e| e.to_string())
        .and_then(|t| Tokens::read(&t))
}

/// The tokens file, read again whenever it changed (Engine v2 C3, #3367): a token the directory pairs while the
/// gateway runs works at its first sign-in, with no restart. A file that no longer reads leaves the tokens as they
/// were.
pub struct Source {
    path: PathBuf,
    seen: Mutex<Option<Stamp>>,
}

impl Source {
    /// Reads the file at `path`, remembering which version it read.
    pub fn open(path: &Path) -> Result<(Source, Tokens), String> {
        let seen = stamp(path);
        let tokens = read_file(path)?;
        let source = Source {
            path: path.to_owned(),
            seen: Mutex::new(seen),
        };
        Ok((source, tokens))
    }

    /// Reads the file again into `tokens` if it changed since it was last read; true when it did.
    pub fn refresh(&self, tokens: &RwLock<Tokens>) -> bool {
        let now = stamp(&self.path);
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if now.is_none() || *seen == now {
            return false;
        }
        let Ok(read) = read_file(&self.path) else {
            return false;
        };
        *tokens.write().unwrap_or_else(|e| e.into_inner()) = read;
        *seen = now;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(counter: u64) -> (Grant, String) {
        let id =
            Id::new(Scope([0x3c; 16]), counter).unwrap_or_else(|| unreachable!("a small counter"));
        let grant = Grant::Actor(Actor::Soul(id));
        (grant, format!("{}.{}", grant.to_text(), "ab".repeat(32)))
    }

    /// C3 A3: a token added to the file while the gateway runs is taken at the next check, with no restart.
    #[test]
    fn a3_a_rewritten_tokens_file_is_read_again() {
        let dir = std::env::temp_dir().join(format!("gatewayd-c3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tokens");
        let (a, ta) = token(1);
        let (b, tb) = token(2);
        let line = |g: Grant, t: &str| Tokens::line(g, &sha256(t.as_bytes()));
        std::fs::write(&path, line(a, &ta)).unwrap();
        let (source, read) = Source::open(&path).unwrap();
        let tokens = RwLock::new(read);
        let check = |t: &str| tokens.read().unwrap().check(&Token::parse(t).unwrap());
        assert_eq!(check(&ta), Some(a));
        assert_eq!(check(&tb), None, "not paired yet");
        assert!(!source.refresh(&tokens), "unchanged: not read again");
        // The directory writes the file whole and renames it into place.
        let next = dir.join("tokens.next");
        std::fs::write(&next, line(a, &ta) + &line(b, &tb)).unwrap();
        std::fs::rename(&next, &path).unwrap();
        assert!(source.refresh(&tokens));
        assert_eq!(check(&tb), Some(b), "the new token works at once");
        assert_eq!(check(&ta), Some(a));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
