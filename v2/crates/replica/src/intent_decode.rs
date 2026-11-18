//! An intent checked for form on arrival (Engine v2 I2, #2689): bytes in, a typed intent or a named refusal out.
//! The gateway runs it on every frame from a client nobody trusts, and the owner's client runs the same code (R8).
//! Form only: what an intent means (I3), whether it has expired (I4, on world time) and rate limits (I8) are not here.
//!
//! The order: the frame's length against [`LIMITS`] before any byte is read; then one value in the encoding profile
//! (deterministic CBOR, `v2/docs/encoding.md`); then depth, text length and the fallbacks' count against [`LIMITS`];
//! then T10's envelope (`Intent::read`, `v2/docs/intents.md`). Each refusal is a name from `refusals::REFUSALS`.

#[cfg(all(target_arch = "wasm32", feature = "vectors"))]
use wasm_bindgen::prelude::wasm_bindgen;

use crate::effects::Refusal;
use crate::encode::{RefusalKind, Value, decode as decode_value, from_hex};
use crate::intents::Intent;
use crate::refusals::named;

/// The limits on an intent's form, as `intent_limits.txt` holds them. Fixed-width: `usize` is 32 bits in WASM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// The most bytes a frame may have; the gateway's WebSocket takes its largest message from it.
    pub frame_bytes: u32,
    /// How deep arrays and maps may nest, the envelope counting as 1.
    pub depth: u32,
    /// The most ranked fallbacks an act may carry.
    pub fallbacks: u32,
    /// The most bytes any one text may have.
    pub text_bytes: u32,
}

/// The limits, read from `intent_limits.txt` when the crate is built: a malformed file fails the build.
pub const LIMITS: Limits = parse_limits(include_str!("intent_limits.txt"));

const KEYS: [&[u8]; 4] = [b"frame_bytes", b"depth", b"fallbacks", b"text_bytes"];

const fn parse_limits(text: &str) -> Limits {
    let b = text.as_bytes();
    let mut got: [Option<u32>; 4] = [None; 4];
    let mut i = 0;
    while i < b.len() {
        let start = i;
        while i < b.len() && b[i] != b'\n' {
            i += 1;
        }
        let (line_start, line_end) = (start, i);
        i += 1;
        if line_end == line_start || b[line_start] == b'#' {
            continue;
        }
        let mut k = 0;
        let mut matched = false;
        while k < KEYS.len() {
            let key = KEYS[k];
            let after = line_start + key.len();
            if after < line_end && b[after] == b' ' && same(b, line_start, key) {
                assert!(got[k].is_none(), "intent_limits.txt names a limit twice");
                let mut n: u32 = 0;
                let mut j = after + 1;
                assert!(j < line_end, "intent_limits.txt: a limit without a value");
                while j < line_end {
                    assert!(
                        b[j].is_ascii_digit(),
                        "intent_limits.txt: a value is not digits"
                    );
                    n = match n.checked_mul(10) {
                        Some(m) => match m.checked_add((b[j] - b'0') as u32) {
                            Some(s) => s,
                            None => panic!("intent_limits.txt: a value over 32 bits"),
                        },
                        None => panic!("intent_limits.txt: a value over 32 bits"),
                    };
                    j += 1;
                }
                got[k] = Some(n);
                matched = true;
            }
            k += 1;
        }
        assert!(matched, "intent_limits.txt: an unknown line");
    }
    match got {
        [
            Some(frame_bytes),
            Some(depth),
            Some(fallbacks),
            Some(text_bytes),
        ] => Limits {
            frame_bytes,
            depth,
            fallbacks,
            text_bytes,
        },
        _ => panic!("intent_limits.txt: a limit is missing"),
    }
}

const fn same(b: &[u8], at: usize, key: &[u8]) -> bool {
    let mut i = 0;
    while i < key.len() {
        if b[at + i] != key[i] {
            return false;
        }
        i += 1;
    }
    true
}

fn refused<T>(name: &str, detail: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal {
        // Every name given here is in the registry; one that is not reads as the envelope's shape.
        name: named(name).unwrap_or("intent.not-a-record"),
        detail: detail.into(),
    })
}

fn measure(v: &Value, depth: u32, most: &mut (u32, u64)) {
    match v {
        Value::Array(a) => {
            most.0 = most.0.max(depth + 1);
            a.iter().for_each(|x| measure(x, depth + 1, most));
        }
        Value::Map(m) => {
            most.0 = most.0.max(depth + 1);
            m.values().for_each(|x| measure(x, depth + 1, most));
        }
        Value::Text(t) => {
            most.1 = most
                .1
                .max(u64::try_from(t.as_str().len()).unwrap_or(u64::MAX))
        }
        _ => {}
    }
}

/// Reads one intent from an arriving frame, or refuses it by a name in `refusals::REFUSALS`.
pub fn decode(bytes: &[u8]) -> Result<Intent, Refusal> {
    // 1. The length alone: nothing is parsed and nothing reserved for a frame over the limit.
    let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if size > u64::from(LIMITS.frame_bytes) {
        return refused(
            "intent.too-large",
            format!("{size} bytes; at most {}", LIMITS.frame_bytes),
        );
    }
    // 2. One value in the encoding profile. Its decoder reserves at most a fixed count whatever a length claims.
    let value = match decode_value(bytes) {
        Ok(d) => d.value,
        Err(e) if e.kind == RefusalKind::TooDeep => {
            return refused("intent.too-deep", e.to_string());
        }
        Err(e) => return refused(&format!("intent.cbor.{}", e.kind.name()), e.to_string()),
    };
    // 3. The limits on the value.
    let mut most = (0, 0);
    measure(&value, 0, &mut most);
    if most.0 > LIMITS.depth {
        return refused(
            "intent.too-deep",
            format!("{} deep; at most {}", most.0, LIMITS.depth),
        );
    }
    if most.1 > u64::from(LIMITS.text_bytes) {
        return refused(
            "intent.text-too-long",
            format!("{} bytes; at most {}", most.1, LIMITS.text_bytes),
        );
    }
    if let Value::Map(m) = &value
        && let Some(Value::Array(f)) = m.get(&9)
        && u64::try_from(f.len()).unwrap_or(u64::MAX) > u64::from(LIMITS.fallbacks)
    {
        return refused(
            "intent.fallbacks-too-many",
            format!("{}; at most {}", f.len(), LIMITS.fallbacks),
        );
    }
    // 4. The envelope (T10), its names given the registry's prefix.
    Intent::read(bytes).or_else(|r| {
        let bare = r.name.strip_prefix("intent-").unwrap_or(r.name);
        refused(&format!("intent.{bare}"), r.detail)
    })
}

/// The malformed fixtures, one per line, `fixture expected-refusal hex`; `#` starts a comment line.
pub const MALFORMED: &str = include_str!("../fixtures/intent-decode/malformed.txt");

/// Each malformed fixture's refusal, one per line, `fixture expected given`: the native test and the WASM build in
/// Node both check that every `given` equals its `expected`. WASM exports it only with the `vectors` feature.
#[cfg_attr(all(target_arch = "wasm32", feature = "vectors"), wasm_bindgen)]
pub fn intent_decode_table() -> String {
    let mut out = String::new();
    for line in MALFORMED
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        let mut parts = line.split_whitespace();
        // No hex is the empty frame.
        let (Some(fixture), Some(want), hex) =
            (parts.next(), parts.next(), parts.next().unwrap_or(""))
        else {
            out.push_str(&format!("{line} malformed-fixture-line\n"));
            continue;
        };
        let given = match from_hex(hex) {
            Err(_) => "fixture-not-hex",
            Ok(bytes) => match decode(&bytes) {
                Ok(_) => "accepted",
                Err(r) => r.name,
            },
        };
        out.push_str(&format!("{fixture} {want} {given}\n"));
    }
    out
}
