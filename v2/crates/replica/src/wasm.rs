//! The replica's WASM bindings (Engine v2 R1, #2684). The state stays inside WASM memory: JavaScript passes a header,
//! batches of parts and queries in as bytes and gets small answers back as new byte arrays, copied out, so no view
//! into WASM memory outlives a call (a view stops working when the memory grows). Every method calls the same Rust
//! the native build runs ([`Replica`]); nothing is decided here.
//!
//! Built with `wasm-bindgen --target web`: Node loads it with `initSync`, a page with the asynchronous `init()`.

use crate::apply::Replica;
use crate::effects::Refusal;
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

fn js(r: Refusal) -> JsError {
    JsError::new(&r.to_string())
}

/// One zone's copy, held in WASM memory.
#[wasm_bindgen(js_name = Replica)]
pub struct WasmReplica(Replica);

#[wasm_bindgen(js_class = Replica)]
impl WasmReplica {
    /// A copy at the zone's start, from the bundle header's stored bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(header: &[u8]) -> Result<WasmReplica, JsError> {
        Replica::start(header).map(WasmReplica).map_err(js)
    }

    /// Applies a batch (`apply.rs`): `{1: parts, 2: version, 3: chain, 4: refusal}` in T0's profile.
    #[wasm_bindgen(js_name = applyBatch)]
    pub fn apply_batch(&mut self, batch: &[u8], hash_steps: bool) -> Result<Vec<u8>, JsError> {
        self.0
            .apply_batch(batch, hash_steps)
            .map(|a| a.to_bytes())
            .map_err(js)
    }

    /// Answers a query (`query.rs`).
    pub fn query(&self, query: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.query(query).map_err(js)
    }

    /// The number of log entries applied.
    pub fn version(&self) -> u64 {
        self.0.version()
    }

    /// The state hash's bytes (`hash.rs`).
    #[wasm_bindgen(js_name = stateHash)]
    pub fn state_hash(&self) -> Result<Vec<u8>, JsError> {
        crate::hash::state_hash(self.0.tree())
            .map(|h| h.to_bytes())
            .map_err(js)
    }
}
