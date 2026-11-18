//! The stream reader's WASM bindings (Engine v2 V1, #2710): a page passes a pointer's or a part's file bytes in and
//! gets JSON back; the replica stays inside WASM memory. Every method calls the same Rust the native build runs.

use super::{Player, Pointer, StreamPart};
use crate::effects::Refusal;
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

fn js(r: Refusal) -> JsError {
    JsError::new(&r.to_string())
}

/// A pointer file's bytes as JSON ([`Pointer::to_json`]).
#[wasm_bindgen(js_name = readPointer)]
pub fn read_pointer(bytes: &[u8]) -> Result<String, JsError> {
    Pointer::read(bytes).map(|p| p.to_json()).map_err(js)
}

/// A part file's number and world times, as JSON (`{"number", "from", "to", "entries"}`), without playing it.
#[wasm_bindgen(js_name = readPart)]
pub fn read_part(bytes: &[u8]) -> Result<String, JsError> {
    let p = StreamPart::read(bytes).map_err(js)?;
    Ok(format!(
        r#"{{"number":{},"from":{},"to":{},"entries":{}}}"#,
        p.number, p.from, p.to, p.entries
    ))
}

/// One stream's reader, held in WASM memory.
#[wasm_bindgen(js_name = StreamPlayer)]
pub struct WasmPlayer(Player);

#[wasm_bindgen(js_class = StreamPlayer)]
impl WasmPlayer {
    /// A reader at the stream's start, from the header file's bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(header: &[u8]) -> Result<WasmPlayer, JsError> {
        Player::start(header).map(WasmPlayer).map_err(js)
    }

    /// Plays the next part's file bytes; what it did, as JSON ([`super::Played::to_json`]).
    pub fn play(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        self.0.play(bytes).map(|p| p.to_json()).map_err(js)
    }

    /// The number of the part it expects next.
    pub fn next(&self) -> u64 {
        self.0.next()
    }

    /// The motion samples of the part played last, every one in entry order (V6, #2715), as JSON:
    /// `[[node, frame node, frame slot or null, at µs, x, y, z µm], ...]`, ids as the page keys them (`<scope hex>.<n>`).
    pub fn samples(&self) -> String {
        let key = |id: crate::ids::Id| {
            format!("{}.{}", crate::encode::to_hex(&id.scope().0), id.counter())
        };
        let rows: Vec<String> = self
            .0
            .samples()
            .iter()
            .map(|h| {
                let p = h.pose.position;
                format!(
                    r#"["{}","{}",{},{},{},{},{}]"#,
                    key(h.node),
                    key(h.pose.frame.node),
                    h.pose
                        .frame
                        .slot
                        .map_or("null".to_owned(), |s| s.to_string()),
                    h.at,
                    p.x,
                    p.y,
                    p.z
                )
            })
            .collect();
        format!("[{}]", rows.join(","))
    }

    /// Answers one query on the copy it has played (R1's `query.rs`, Engine v2 V5 #2714).
    pub fn query(&self, query: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.replica().query(query).map_err(js)
    }
}
