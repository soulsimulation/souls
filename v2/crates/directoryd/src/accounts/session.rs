//! The session check (W1): the provider's session token is a JWT signed with RS256, checked here against the
//! provider's public keys (`<issuer>/.well-known/jwks.json`). The keys are fetched when a token names a key id this
//! program has not seen, at most once a minute, and kept; so a request makes no call to the provider, and the fetches
//! are one per key change. The checks are today's (`apps/server/src/auth.ts`): RS256 only, whatever the token's header
//! says; the exact issuer; `exp`, `nbf`, `iat`, `sub`, `sid` and `azp` present; `azp` on the allowed list.

use super::from_b64url;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// An unknown key id makes a fetch at most this often (seconds).
pub const REFETCH_AFTER_S: u64 = 60;
/// Clock difference allowed on `exp` and `nbf` (seconds).
pub const LEEWAY_S: u64 = 5;

/// An RSA public key: modulus and exponent, big-endian.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicKey {
    pub n: Vec<u8>,
    pub e: Vec<u8>,
}

/// Where the provider's keys come from: its JWKS over HTTPS, or a test's own.
pub trait KeySource: Send + Sync {
    fn fetch(&self) -> Result<BTreeMap<String, PublicKey>, String>;
}

/// The provider's published keys, `<issuer>/.well-known/jwks.json`.
pub struct Jwks {
    pub url: String,
}

impl KeySource for Jwks {
    fn fetch(&self) -> Result<BTreeMap<String, PublicKey>, String> {
        let text = ureq::get(&self.url)
            .call()
            .map_err(|e| format!("the provider's keys: {e}"))?
            .body_mut()
            .read_to_string()
            .map_err(|e| format!("the provider's keys: {e}"))?;
        parse_jwks(&text)
    }
}

/// The RSA signing keys of a JWKS document, by key id.
pub fn parse_jwks(text: &str) -> Result<BTreeMap<String, PublicKey>, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| format!("a JWKS: {e}"))?;
    let keys = doc
        .get("keys")
        .and_then(Value::as_array)
        .ok_or("a JWKS has a `keys` array")?;
    let mut out = BTreeMap::new();
    for k in keys {
        let s = |f: &str| k.get(f).and_then(Value::as_str);
        if s("kty") != Some("RSA")
            || s("alg").is_some_and(|a| a != "RS256")
            || s("use").is_some_and(|u| u != "sig")
        {
            continue;
        }
        let (Some(kid), Some(n), Some(e)) = (s("kid"), s("n"), s("e")) else {
            continue;
        };
        if let (Some(n), Some(e)) = (from_b64url(n), from_b64url(e)) {
            out.insert(kid.to_string(), PublicKey { n, e });
        }
    }
    Ok(out)
}

/// A verified session: who, and until when the token holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub issuer: String,
    pub subject: String,
    pub session: String,
    /// The token's `exp`. A socket open longer re-checks a fresh token before then: a signed token cannot be revoked.
    pub expires: u64,
}

/// Why a token was refused, by name. Never carries the token or its claims.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// Not three base64url parts of JSON objects.
    Shape,
    /// The header names an algorithm other than RS256.
    Algorithm,
    /// No key with the token's key id, after the one fetch a minute allows.
    UnknownKey,
    /// The keys could not be fetched.
    KeysUnavailable,
    Signature,
    Issuer,
    /// `exp`, `nbf`, `iat`, `sub`, `sid` or `azp` is missing or of the wrong type.
    MissingClaim(&'static str),
    /// `azp` is not on the allowed list.
    Party,
    Expired,
    NotYet,
}

impl Refused {
    pub fn name(self) -> &'static str {
        match self {
            Refused::Shape => "token-shape",
            Refused::Algorithm => "token-algorithm",
            Refused::UnknownKey => "token-key-unknown",
            Refused::KeysUnavailable => "keys-unavailable",
            Refused::Signature => "token-signature",
            Refused::Issuer => "token-issuer",
            Refused::MissingClaim(_) => "token-claim-missing",
            Refused::Party => "token-party",
            Refused::Expired => "token-expired",
            Refused::NotYet => "token-not-yet",
        }
    }
}

struct Cache {
    keys: BTreeMap<String, PublicKey>,
    fetched_at: Option<u64>,
    fetches: u64,
}

/// Checks session tokens for one issuer and its allowed parties.
pub struct Verifier {
    issuer: String,
    parties: Vec<String>,
    source: Box<dyn KeySource>,
    cache: Mutex<Cache>,
}

impl Verifier {
    pub fn new(issuer: &str, parties: &[String], source: Box<dyn KeySource>) -> Verifier {
        Verifier {
            issuer: issuer.to_string(),
            parties: parties.to_vec(),
            source,
            cache: Mutex::new(Cache {
                keys: BTreeMap::new(),
                fetched_at: None,
                fetches: 0,
            }),
        }
    }

    /// How many times the keys have been fetched.
    pub fn fetches(&self) -> u64 {
        self.cache.lock().expect("the key cache").fetches
    }

    /// Checks `token` at `now` (seconds since 1970).
    pub fn verify(&self, token: &str, now: u64) -> Result<Session, Refused> {
        let parts: Vec<&str> = token.split('.').collect();
        let [head, body, sig] = parts[..] else {
            return Err(Refused::Shape);
        };
        let header = object(head)?;
        // The algorithm is pinned: the header is checked against it and never chooses it.
        if header.get("alg").and_then(Value::as_str) != Some("RS256") {
            return Err(Refused::Algorithm);
        }
        let kid = header
            .get("kid")
            .and_then(Value::as_str)
            .ok_or(Refused::Shape)?;
        let key = self.key(kid, now)?;
        let sig = from_b64url(sig).ok_or(Refused::Shape)?;
        let signed = &token[..head.len() + 1 + body.len()];
        RsaPublicKeyComponents {
            n: &key.n,
            e: &key.e,
        }
        .verify(&RSA_PKCS1_2048_8192_SHA256, signed.as_bytes(), &sig)
        .map_err(|_| Refused::Signature)?;

        let claims = object(body)?;
        if claims.get("iss").and_then(Value::as_str) != Some(self.issuer.as_str()) {
            return Err(Refused::Issuer);
        }
        let int = |c: &'static str| {
            claims
                .get(c)
                .and_then(Value::as_u64)
                .ok_or(Refused::MissingClaim(c))
        };
        let text = |c: &'static str| {
            claims
                .get(c)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or(Refused::MissingClaim(c))
        };
        let (exp, nbf, _iat) = (int("exp")?, int("nbf")?, int("iat")?);
        let (sub, sid, azp) = (text("sub")?, text("sid")?, text("azp")?);
        if !self.parties.iter().any(|p| p == azp) {
            return Err(Refused::Party);
        }
        if exp.saturating_add(LEEWAY_S) <= now {
            return Err(Refused::Expired);
        }
        if nbf > now.saturating_add(LEEWAY_S) {
            return Err(Refused::NotYet);
        }
        Ok(Session {
            issuer: self.issuer.clone(),
            subject: sub.to_string(),
            session: sid.to_string(),
            expires: exp,
        })
    }

    /// The key `kid`, from the cache, or from one fetch when it is unknown and the last fetch is a minute old.
    fn key(&self, kid: &str, now: u64) -> Result<PublicKey, Refused> {
        let mut c = self.cache.lock().expect("the key cache");
        if let Some(k) = c.keys.get(kid) {
            return Ok(k.clone());
        }
        if c.fetched_at
            .is_some_and(|t| now < t.saturating_add(REFETCH_AFTER_S))
        {
            return Err(Refused::UnknownKey);
        }
        c.fetched_at = Some(now);
        c.fetches += 1;
        c.keys = self.source.fetch().map_err(|_| Refused::KeysUnavailable)?;
        c.keys.get(kid).cloned().ok_or(Refused::UnknownKey)
    }
}

fn object(part: &str) -> Result<Map<String, Value>, Refused> {
    let bytes = from_b64url(part).ok_or(Refused::Shape)?;
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(Refused::Shape),
    }
}
