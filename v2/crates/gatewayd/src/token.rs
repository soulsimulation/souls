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

/// The key the directory signs view tokens with, shared with the gateways (V13b, #3407). Never formatted.
pub struct ViewKey([u8; 32]);

impl ViewKey {
    pub fn new(bytes: [u8; 32]) -> ViewKey {
        ViewKey(bytes)
    }

    /// Reads a key file: 64 hex digits.
    pub fn read(text: &str) -> Option<ViewKey> {
        Some(ViewKey(from_hex(text.trim()).ok()?.try_into().ok()?))
    }

    /// HMAC-SHA256 (RFC 2104) of `message` under this key.
    pub fn mac(&self, message: &[u8]) -> [u8; 32] {
        let pad = |b: u8| -> Vec<u8> {
            let mut k = [b; 64];
            for (k, x) in k.iter_mut().zip(self.0) {
                *k ^= x;
            }
            k.to_vec()
        };
        let mut inner = pad(0x36);
        inner.extend_from_slice(message);
        let mut outer = pad(0x5c);
        outer.extend_from_slice(&sha256(&inner));
        sha256(&outer)
    }
}

/// A view token as presented (V13b): `view.<expires>.<grant>,<grant>….<HMAC hex>`, minted by the directory from a
/// signed-in web session (`directoryd::accounts::view`). It lets its holder subscribe to views for its grants, never
/// send an intent, until it expires. Its text is private to this module and never formatted.
pub struct ViewToken {
    text: String,
}

/// What a checked view token grants: the Souls and worlds whose views it may watch, and until when (seconds since
/// 1970).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub grants: Vec<Grant>,
    pub expires: u64,
}

impl ViewToken {
    /// Reads a presented view token's shape; `None` if it is not one.
    pub fn parse(text: &str) -> Option<ViewToken> {
        let text = text.trim();
        text.starts_with("view.").then(|| ViewToken {
            text: text.to_owned(),
        })
    }

    /// What it grants at `now` (seconds since 1970), or `None`: a wrong MAC, an expired token or a grant that is not
    /// one. The MAC is compared in constant time.
    pub fn check(&self, key: &ViewKey, now: u64) -> Option<View> {
        let (body, mac) = self.text.rsplit_once('.')?;
        let mac: [u8; 32] = from_hex(mac).ok()?.try_into().ok()?;
        if !bool::from(key.mac(body.as_bytes()).ct_eq(&mac)) {
            return None;
        }
        let mut parts = body.splitn(3, '.');
        let (_, expires, grants) = (parts.next()?, parts.next()?, parts.next()?);
        let expires: u64 = expires.parse().ok()?;
        let grants = grants
            .split(',')
            .map(Grant::parse)
            .collect::<Option<Vec<_>>>()?;
        (now < expires && !grants.is_empty()).then_some(View { grants, expires })
    }
}

impl fmt::Debug for ViewToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ViewToken(secret withheld)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_sha256_matches_rfc_4231_case_2() {
        // RFC 4231 test case 2 ("Jefe"); a key shorter than the block is padded with zeros, as here.
        let mut k = [0u8; 32];
        k[..4].copy_from_slice(b"Jefe");
        assert_eq!(
            to_hex(&ViewKey::new(k).mac(b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn a_view_token_holds_until_it_expires_and_only_under_its_key() {
        let key = ViewKey::new([7; 32]);
        let g = Grant::Actor(Actor::Soul(Id::new(Scope([0xab; 16]), 3).unwrap()));
        let body = format!("view.1000.{}", g.to_text());
        let text = format!("{body}.{}", to_hex(&key.mac(body.as_bytes())));
        let t = ViewToken::parse(&text).unwrap();
        let view = View {
            grants: vec![g],
            expires: 1000,
        };
        assert_eq!(t.check(&key, 999), Some(view));
        assert_eq!(t.check(&key, 1000), None, "expired");
        assert_eq!(t.check(&ViewKey::new([8; 32]), 999), None, "another key");
        let forged = text.replace("view.1000.", "view.9000.");
        assert_eq!(ViewToken::parse(&forged).unwrap().check(&key, 999), None);
        assert!(!format!("{t:?}").contains(&text[text.len() - 64..]));
    }
}
