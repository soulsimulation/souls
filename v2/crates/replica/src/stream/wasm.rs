//! The stream reader's WASM bindings (Engine v2 V1, #2710): a page passes a pointer's or a part's file bytes in and
//! gets JSON back; the replica stays inside WASM memory. Every method calls the same Rust the native build runs.

use super::public::PublicPlayer;
use super::{Player, Pointer, StreamPart};
use crate::effects::Refusal;
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

fn js(r: Refusal) -> JsError {
    JsError::new(&r.to_string())
}

/// A pointer file's bytes as JSON ([`Pointer::to_json`]).
#[wasm_bindgen(js_name = readPointer)]
pub fn read_pointer(bytes: &[u8]) -> Result<String, JsError> {
    let p = Pointer::read(bytes).map_err(js)?;
    let mut json = p.to_json();
    let m = super::read_map(bytes, "pointer").map_err(js)?;
    if let Some(crate::encode::Value::Bytes(hash)) = m.get(&8) {
        if hash.len() != 32 {
            return Err(JsError::new("public baseline hash"));
        }
        json.pop();
        json.push_str(&format!(
            ",\"baseline\":\"{}\",\"generation\":\"{}\"}}",
            crate::encode::to_hex(hash),
            crate::encode::to_hex(hash)
        ));
    }
    if let Some(crate::encode::Value::Array(h)) = m.get(&9) {
        let [
            crate::encode::Value::Uint(version),
            crate::encode::Value::Uint(next),
            crate::encode::Value::Bytes(hash),
        ] = h.as_slice()
        else {
            return Err(JsError::new("legacy handoff"));
        };
        if hash.len() != 32 {
            return Err(JsError::new("handoff digest"));
        }
        json.pop();
        json.push_str(&format!(
            ",\"legacyVersion\":{version},\"legacyNext\":{next},\"legacyHash\":\"{}\"}}",
            crate::encode::to_hex(hash)
        ));
    }
    // #3825: the generation the field-9 handoff closes, when it is a generation rather than the legacy stream.
    if let Some(crate::encode::Value::Bytes(from)) = m.get(&10) {
        if from.len() != 32 {
            return Err(JsError::new("handoff generation"));
        }
        json.pop();
        json.push_str(&format!(
            ",\"handoffFrom\":\"{}\"}}",
            crate::encode::to_hex(from)
        ));
    }
    // #2731: the world sleeps, still until its next due change (`[t]`, world µs) or with nothing due (`[]`).
    if let Some(crate::encode::Value::Array(due)) = m.get(&11) {
        let until = match due.as_slice() {
            [] => "null".to_owned(),
            [t] => super::read_int(Some(t), "still until")
                .map_err(js)?
                .to_string(),
            _ => return Err(JsError::new("still until")),
        };
        json.pop();
        json.push_str(&format!(",\"asleep\":true,\"stillUntil\":{until}}}"));
    }
    Ok(json)
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
pub struct WasmPlayer(Copy);
enum Copy {
    Legacy(Box<Player>),
    Public(Box<PublicPlayer>),
}

#[wasm_bindgen(js_class = StreamPlayer)]
impl WasmPlayer {
    /// A reader at the stream's start, from the header file's bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(header: &[u8]) -> Result<WasmPlayer, JsError> {
        Player::start(header)
            .map(|p| WasmPlayer(Copy::Legacy(Box::new(p))))
            .map_err(js)
    }

    /// A validated public observation, retaining exact root kinds and opaque frame references.
    #[wasm_bindgen(js_name = fromBaseline)]
    pub fn from_baseline(header: &[u8], baseline: &[u8]) -> Result<WasmPlayer, JsError> {
        PublicPlayer::start(header, baseline)
            .map(|p| WasmPlayer(Copy::Public(Box::new(p))))
            .map_err(js)
    }

    /// Plays the next part's file bytes; what it did, as JSON ([`super::Played::to_json`]).
    pub fn play(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        match &mut self.0 {
            Copy::Legacy(p) => p.play(bytes),
            Copy::Public(p) => p.play(bytes),
        }
        .map(|p| p.to_json())
        .map_err(js)
    }

    /// [`WasmPlayer::play`] for a part a joiner far behind will not show (#3822): every check but the next state's
    /// digest, which [`WasmPlayer::verify`] or the next part played with `play` works out once. A legacy copy plays it
    /// checked.
    #[wasm_bindgen(js_name = playDeferred)]
    pub fn play_deferred(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        match &mut self.0 {
            Copy::Legacy(p) => p.play(bytes),
            Copy::Public(p) => p.play_deferred(bytes),
        }
        .map(|p| p.to_json())
        .map_err(js)
    }

    /// Refuses (`stream-digest`) unless the state the deferred parts made has the digest the newest part claimed.
    pub fn verify(&mut self) -> Result<(), JsError> {
        match &mut self.0 {
            Copy::Legacy(_) => Ok(()),
            Copy::Public(p) => p.verify().map_err(js),
        }
    }

    /// The number of the part it expects next.
    pub fn next(&self) -> u64 {
        match &self.0 {
            Copy::Legacy(p) => p.next(),
            Copy::Public(p) => p.next(),
        }
    }

    /// The motion samples of the part played last, every one in entry order (V6, #2715), as JSON:
    /// `[[node, frame node, frame slot or null, at µs, x, y, z µm], ...]`, ids as the page keys them (`<scope hex>.<n>`).
    pub fn samples(&self) -> String {
        let key = |id: crate::ids::Id| {
            format!("{}.{}", crate::encode::to_hex(&id.scope().0), id.counter())
        };
        let samples = match &self.0 {
            Copy::Legacy(p) => p.samples(),
            Copy::Public(p) => p.samples(),
        };
        let rows: Vec<String> = samples
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
        crate::encode::encode(&crate::encode::Value::Array(
            match &self.0 {
                Copy::Legacy(p) => p.events(),
                Copy::Public(p) => p.events(),
            }
            .to_vec(),
        ))
        .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Continues on the next generation, both given in hex, without its baseline ([`PublicPlayer::cross`], #3825).
    pub fn cross(&mut self, generation: &str, digest: &str) -> Result<(), JsError> {
        let hex = |h: &str| crate::encode::from_hex(h).map_err(|e| JsError::new(&e));
        match &mut self.0 {
            Copy::Legacy(_) => Err(JsError::new("a legacy copy does not cross")),
            Copy::Public(p) => p.cross(&hex(generation)?, &hex(digest)?).map_err(js),
        }
    }

    /// Exact public projection digest, including unresolved references, for an explicit legacy handoff.
    #[wasm_bindgen(js_name = publicHash)]
    pub fn public_hash(&self) -> Result<String, JsError> {
        let hash = match &self.0 {
            Copy::Legacy(p) => super::public::digest(
                &super::public::project(p.replica().header(), &p.replica().tree().to_state())
                    .map_err(js)?,
            ),
            Copy::Public(p) => p.hash(),
        }
        .map_err(js)?;
        Ok(crate::encode::to_hex(&hash))
    }
    /// Complete authorized live public node records, including unresolved local frames.
    pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
        match &self.0 {
            Copy::Public(p) => p.snapshot().map_err(js),
            Copy::Legacy(_) => Err(JsError::new("legacy snapshot unavailable")),
        }
    }

    /// Answers one query on the copy it has played (R1's `query.rs`, Engine v2 V5 #2714).
    pub fn query(&self, query: &[u8]) -> Result<Vec<u8>, JsError> {
        match &self.0 {
            Copy::Legacy(p) => p.replica().query(query),
            Copy::Public(p) => p.query(query),
        }
        .map_err(js)
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
