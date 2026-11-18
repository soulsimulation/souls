//! The fact sheet's WASM bindings (Engine v2 V10, #2720): a page feeds a view's files in and gets the sheet's bytes,
//! or one second's facts over the state applied so far (`factsAt`, which V15's page calls). The same Rust as native.

use super::{Sheet, facts_at};
use crate::effects::Refusal;
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

fn js(r: Refusal) -> JsError {
    JsError::new(&r.to_string())
}

/// A fact sheet as it is read, held in WASM memory.
#[wasm_bindgen(js_name = FactSheet)]
pub struct WasmSheet(Option<Sheet>);

#[wasm_bindgen(js_class = FactSheet)]
impl WasmSheet {
    /// A sheet of world seconds `t0..t1` of a view of the zone whose header file's bytes are `header`.
    #[wasm_bindgen(constructor)]
    pub fn new(header: &[u8], t0: i64, t1: i64) -> Result<WasmSheet, JsError> {
        Sheet::new(header, t0, t1)
            .map(|s| WasmSheet(Some(s)))
            .map_err(js)
    }

    fn sheet(&mut self) -> Result<&mut Sheet, JsError> {
        self.0
            .as_mut()
            .ok_or_else(|| JsError::new("facts-finished: the sheet was finished"))
    }

    /// Feeds the next stream part's file bytes (V1).
    pub fn part(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.sheet()?.part(bytes).map_err(js)
    }

    /// Feeds the next history bundle's bytes (V3).
    pub fn bundle(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.sheet()?.bundle(bytes).map_err(js)
    }

    /// One second's whole record at world time `t` µs over the state applied so far, as CBOR bytes; empty before the
    /// first file.
    #[wasm_bindgen(js_name = factsAt)]
    pub fn facts_at(&mut self, t: i64) -> Result<Vec<u8>, JsError> {
        match self.sheet()?.state() {
            Some(s) => facts_at(s, t).map_err(js),
            None => Ok(Vec::new()),
        }
    }

    /// Writes the seconds left and gives the sheet's bytes.
    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        let s = self
            .0
            .take()
            .ok_or_else(|| JsError::new("facts-finished: the sheet was finished"))?;
        s.finish().map_err(js)
    }
}
