//! Tokens (Engine v2 I1, #2683). A token is the id of what it grants and 32 random bytes, written
//! `<grant>.<64 hex digits>`. The grant is an actor today (a Soul, `soul-<scope hex>-<counter>`, or a creator,
//! `creator-<scope hex>-<counter>`); a session's set of grants (I12) is another grant form, not another token shape.
//! The gateway stores only each token's SHA-256, compares in constant time, and can revoke a token. A token is never
//! printed: [`Token`]'s `Debug` and `Display` show its grant alone.

use std::collections::BTreeMap;
use std::fmt;

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

/// The stored tokens: per grant (by its text), the SHA-256 of each live token.
#[derive(Default)]
pub struct Tokens {
    by_grant: BTreeMap<String, (Grant, Vec<[u8; 32]>)>,
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

    /// Reads a file of `<grant> <sha-256 hex>` lines.
    pub fn read(text: &str) -> Result<Tokens, String> {
        let mut t = Tokens::default();
        for (n, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let bad = || format!("tokens line {}: want `<grant> <sha-256 hex>`", n + 1);
            let (g, h) = line.split_once(' ').ok_or_else(bad)?;
            let grant = Grant::parse(g).ok_or_else(bad)?;
            let hash: [u8; 32] = from_hex(h.trim())
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(bad)?;
            t.add(grant, hash);
        }
        Ok(t)
    }

    /// One line of the file [`Tokens::read`] reads.
    pub fn line(grant: Grant, hash: &[u8; 32]) -> String {
        format!("{} {}\n", grant.to_text(), to_hex(hash))
    }
}
