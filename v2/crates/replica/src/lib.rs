//! The shared library: built natively and to WASM, loaded by the world, the client and the page (Engine v2, #2635).
//! Empty but for the load probe (K1, #2638).
#![forbid(unsafe_code)]
// No float in a verdict (K14, #2648; v2/tools/arch/README.md): a module of drawing helpers allows it by name.
#![deny(clippy::float_arithmetic)]

pub mod apply;
pub mod audience;
pub mod bodies;
pub mod directory;
pub mod durability;
pub mod edit;
pub mod effects;
pub mod encode;
pub mod facts;
pub mod hash;
pub mod hatch;
pub mod history;
pub mod host;
pub mod ids;
pub mod index;
pub mod intent_decode;
pub mod intents;
pub mod kinds;
pub mod moves;
pub mod pose;
pub mod query;
pub mod read;
pub mod refusals;
pub mod rules;
pub mod speech;
pub mod stream;
pub mod sync;
pub mod time;
pub mod timed;
pub mod tree;
pub mod views;
pub mod walk;
pub mod who_may;
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
