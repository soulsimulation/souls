//! The shared library: built natively and to WASM, loaded by the world, the client and the page (Engine v2, #2635).
//! Empty but for the load probe (K1, #2638).
#![forbid(unsafe_code)]

pub mod apply;
pub mod effects;
pub mod encode;
pub mod hash;
pub mod ids;
pub mod pose;
pub mod query;
pub mod rules;
pub mod time;
pub mod tree;
// R1's bindings import wasm-bindgen's glue, so the checker (T10, no imports) leaves them out.
#[cfg(all(target_arch = "wasm32", not(feature = "checker")))]
mod wasm;
pub mod world_model;
pub mod zones;

#[cfg(all(target_arch = "wasm32", not(feature = "checker")))]
use wasm_bindgen::prelude::wasm_bindgen;

/// Hashes `input` (FNV-1a, 32 bit, over its little-endian bytes). v2/tools/wasm-load calls it natively, in Node and
/// in a headless browser and checks that all three return the same value.
/// Not exported from the checker build (`checker`), which has no imports (T10, `v2/docs/intents.md` rule 13).
#[cfg_attr(all(target_arch = "wasm32", not(feature = "checker")), wasm_bindgen)]
pub fn load_probe(input: u32) -> u32 {
    input
        .to_le_bytes()
        .iter()
        .fold(0x811c_9dc5_u32, |hash, byte| {
            (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
        })
}

#[cfg(test)]
mod tests {
    use super::load_probe;

    #[test]
    fn load_probe_is_fnv1a_of_the_le_bytes() {
        assert_eq!(load_probe(0), 0x4b95_f515);
        assert_eq!(load_probe(2638), load_probe(2638));
        assert_ne!(load_probe(2638), load_probe(2639));
    }
}
