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

    /// The event query (V1b, #3361): the named events of the part played last, as `[{1: name, 2: fields, 3: node, 4:
    /// at, 5: sequence}, ...]` in T0's profile ([`Player::events`]).
    pub fn events(&self) -> Result<Vec<u8>, JsError> {
        crate::encode::encode(&crate::encode::Value::Array(self.0.events().to_vec()))
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Answers one query on the copy it has played (R1's `query.rs`, Engine v2 V5 #2714).
    pub fn query(&self, query: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.replica().query(query).map_err(js)
    }
}

/// One moment of history (V9, #2719): a bundle's bytes, inflated and checked by the SHA-256 its day index names, applied
/// up to world time `at` (V4's `state_at`), as `{1: the state's hash (souls/fixture/1), 2: [node, ...] as the node
/// query answers, 3: [{1: node, 2: frame node, 3: frame slot, 4: at, 5: [x, y, z]}, ...] the bundle's motion samples
/// after `at`, 4: its start, 5: its length}` in T0's profile.
#[wasm_bindgen(js_name = historyAt)]
pub fn history_at(
    header: &[u8],
    bundle: &[u8],
    sha256: &[u8],
    at: i64,
    with_hash: bool,
) -> Result<Vec<u8>, JsError> {
    use crate::effects::{Body, Change, Effect, Header};
    use crate::encode::Value;
    use crate::hash::int;
    use std::collections::BTreeMap;
    let hash: [u8; 32] = sha256
        .try_into()
        .map_err(|_| JsError::new("a SHA-256 is 32 bytes"))?;
    let b = crate::history::Bundle::read_named(bundle, &hash).map_err(js)?;
    let s =
        crate::history::seek::state_at(&b, &Header::read(header).map_err(js)?, at).map_err(js)?;
    let nodes = s.nodes.iter().map(|(id, n)| {
        let mut m = BTreeMap::from([
            (1, id.to_value()),
            (2, Value::Text(n.kind.clone())),
            (6, Value::Map(n.fields.clone())),
        ]);
        m.extend(n.parent.map(|p| (3, p.to_value())));
        m.extend(n.slot.map(|v| (4, Value::Uint(v))));
        m.extend(n.place.clone().map(|v| (7, v)));
        m.extend(n.motion.clone().map(|v| (8, v)));
        Value::Map(m)
    });
    let mut samples = Vec::new();
    if let Value::Map(view) = &b.view
        && let Some(Value::Array(records)) = view.get(&8)
    {
        for e in records.iter().filter_map(|r| Effect::read(r.clone()).ok()) {
            let Body::Changes(cs) = &e.body else { continue };
            for h in cs.iter().filter_map(|c| match &c.change {
                Change::Motion(h) if h.at > at => Some(h),
                _ => None,
            }) {
                let p = h.pose.position;
                let mut m = BTreeMap::from([
                    (1, h.node.to_value()),
                    (2, h.pose.frame.node.to_value()),
                    (4, int(h.at)),
                    (5, Value::Array(vec![int(p.x), int(p.y), int(p.z)])),
                ]);
                m.extend(h.pose.frame.slot.map(|v| (3, Value::Uint(v))));
                samples.push(Value::Map(m));
            }
        }
    }
    let out = BTreeMap::from([
        (
            1,
            Value::Bytes(if with_hash {
                s.hash().map_err(js)?.to_bytes()
            } else {
                Vec::new()
            }),
        ),
        (2, Value::Array(nodes.collect())),
        (3, Value::Array(samples)),
        (4, int(b.start)),
        (5, int(b.length)),
    ]);
    crate::encode::encode(&Value::Map(out)).map_err(|e| JsError::new(&e.to_string()))
}
