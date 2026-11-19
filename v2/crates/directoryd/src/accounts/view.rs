//! The session exchange (Engine v2 V13b, #3407): a signed-in web session exchanges for a short-lived gateway view
//! token, scoped to the account's Souls and worlds, so the page opens its owner's view from the session alone.
//!
//! A view token is `view.<expires>.<grant>,<grant>….<HMAC-SHA256 hex>`: the grants are gatewayd's (`soul-…` or
//! `creator-…`, `gatewayd::token::Grant`), `expires` is in seconds since 1970, and the MAC is over everything before
//! its dot, with a key the directory and the gateways share (`--view-key`, a file of 64 hex digits). The gateway checks
//! it without a call (`gatewayd::token::View`). It lets its holder watch, never act, and lives [`VIEW_TTL_S`]: a
//! revoked or expired session gets no new one, and the page renews before it lapses. The token is answered to the page
//! once; it is never logged, stored or put in an address.

use replica::encode::{from_hex, to_hex};
use ring::hmac;

/// How long a view token holds (seconds). The page renews it before then.
pub const VIEW_TTL_S: u64 = 120;

/// The key the directory and the gateways share. Never formatted.
pub struct ViewKey(hmac::Key);

impl ViewKey {
    pub fn new(bytes: &[u8; 32]) -> ViewKey {
        ViewKey(hmac::Key::new(hmac::HMAC_SHA256, bytes))
    }

    /// Reads a key file: 64 hex digits.
    pub fn read(text: &str) -> Option<ViewKey> {
        let b: [u8; 32] = from_hex(text.trim()).ok()?.try_into().ok()?;
        Some(ViewKey::new(&b))
    }

    /// A view token for `grants`, holding until `expires`.
    pub fn mint(&self, grants: &[String], expires: u64) -> String {
        let body = format!("view.{expires}.{}", grants.join(","));
        let mac = hmac::sign(&self.0, body.as_bytes());
        format!("{body}.{}", to_hex(mac.as_ref()))
    }
}

/// A grant as gatewayd writes it: `soul-` or `creator-`, 32 hex digits, `-`, a counter.
pub fn is_grant(text: &str) -> bool {
    let Some((kind, rest)) = text.split_once('-') else {
        return false;
    };
    let Some((scope, counter)) = rest.split_once('-') else {
        return false;
    };
    matches!(kind, "soul" | "creator")
        && scope.len() == 32
        && scope.bytes().all(|b| b.is_ascii_hexdigit())
        && !counter.is_empty()
        && counter.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_token_is_its_grants_its_expiry_and_a_mac() {
        let k = ViewKey::new(&[7; 32]);
        let g = format!("soul-{}-3", "ab".repeat(16));
        let t = k.mint(std::slice::from_ref(&g), 1000);
        let (body, mac) = t.rsplit_once('.').unwrap();
        assert_eq!(body, format!("view.1000.{g}"));
        assert_eq!(mac.len(), 64);
        assert!(is_grant(&g) && !is_grant("soul-ab-3") && !is_grant("world-x-1"));
    }
}
