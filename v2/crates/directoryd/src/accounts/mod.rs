//! Accounts (Engine v2 W1, #2704): a person signs in, the directory verifies that locally, and
//! no account identity enters a world's log.
//!
//! - [`session`]: the provider's session token (a JWT, RS256) checked against its public keys, fetched once per key
//!   change and cached, so a request makes no call to the provider.
//! - [`store`]: one SQLite file, owned by this program alone, mapping (issuer, subject) to a random account id and
//!   each account to a random principal id. Only principal ids appear in effects (T8, `v2/docs/audience.md` rule 5).
//! - [`start`]: what the program refuses to start with, among them the sign-in for local and test worlds on a public
//!   address.
//! - [`serve`]: the sign-in requests over HTTP, the session exchange and sign-out.
//! - [`view`]: a signed-in session exchanges for a short-lived gateway view token (V13b, #3407).

pub mod serve;
pub mod session;
pub mod start;
pub mod store;
pub mod view;

use replica::ids::{Id, Scope};
use ring::rand::{SecureRandom, SystemRandom};

/// `n` random bytes from the operating system.
pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    SystemRandom::new()
        .fill(&mut b)
        .expect("the operating system's random source");
    b
}

/// A principal id as text: its scope in hex, a colon, its counter (`3fa2…9c:0`).
pub fn principal_text(id: Id) -> String {
    format!(
        "{}:{}",
        replica::encode::to_hex(&id.scope().0),
        id.counter()
    )
}

/// The inverse of [`principal_text`].
pub fn principal_from_text(text: &str) -> Option<Id> {
    let (scope, counter) = text.split_once(':')?;
    let bytes: [u8; 16] = replica::encode::from_hex(scope).ok()?.try_into().ok()?;
    Id::new(Scope(bytes), counter.parse().ok()?)
}

/// A short hash of a value, to correlate log lines without writing the value (an account id, never a subject).
pub fn correlate(value: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, value.as_bytes());
    replica::encode::to_hex(&d.as_ref()[..6])
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url without padding (RFC 7515 section 2), as a JWT writes its parts.
pub fn b64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..=c.len() {
            out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// Reads base64url without padding; `None` for any other character or a length no encoder writes.
pub fn from_b64url(text: &str) -> Option<Vec<u8>> {
    if text.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for ch in text.bytes() {
        let v = B64.iter().position(|&b| b == ch)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_round_trips() {
        for n in 0..40u8 {
            let bytes: Vec<u8> = (0..n).map(|i| i.wrapping_mul(37)).collect();
            assert_eq!(from_b64url(&b64url(&bytes)).as_deref(), Some(&bytes[..]));
        }
        assert_eq!(b64url(b"hi?"), "aGk_");
        assert_eq!(from_b64url("a"), None);
        assert_eq!(from_b64url("aGk/"), None);
    }

    #[test]
    fn principal_text_round_trips() {
        let id = Id::new(Scope(random()), 0).expect("an id");
        assert_eq!(principal_from_text(&principal_text(id)), Some(id));
    }
}
