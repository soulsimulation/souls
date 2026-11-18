//! The replica's WASM bindings (Engine v2 R1, #2684). The state stays inside WASM memory: JavaScript passes a header,
//! batches of parts and queries in as bytes and gets small answers back as new byte arrays, copied out, so no view
//! into WASM memory outlives a call (a view stops working when the memory grows). Every method calls the same Rust
//! the native build runs ([`Replica`]); nothing is decided here.
//!
//! Built with `wasm-bindgen --target web`: Node loads it with `initSync`, a page with the asynchronous `init()`.
//!
//! The resident daemon (Engine v2 R6, #2700; `v2/client/src/daemon/`) builds and reads every frame on the gateway's
//! socket through the `wire*` functions, never in JavaScript (`v2/docs/encoding.md` rule 11). The frames are I1's
//! (`gatewayd/src/lib.rs`).

use crate::apply::Replica;
use crate::effects::Actor;
use crate::encode::{Name, Value, decode, encode, from_hex, to_hex};
use crate::ids::{Id, Scope, Version};
use crate::intents::{Hello, Intent, PROTOCOL, Target};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

fn js(r: impl std::fmt::Display) -> JsError {
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

/// The client's first frame (T10 rule 12): its protocol, and no build of its own.
#[wasm_bindgen(js_name = wireHello)]
pub fn wire_hello() -> Result<Vec<u8>, JsError> {
    let hello = Hello {
        protocol: PROTOCOL,
        build: Vec::new(),
        refused: None,
        other: None,
    };
    hello.to_bytes().map_err(js)
}

/// The world's first frame: its build hash in hex, or its refusal by name.
#[wasm_bindgen(js_name = wireWorldBuild)]
pub fn wire_world_build(first: &[u8]) -> Result<String, JsError> {
    let h = Hello::read(first).map_err(js)?;
    match (h.refused, h.other) {
        (Some((ours, world)), _) => Err(JsError::new(&format!(
            "protocol-version: this client speaks {ours}, the world {world}"
        ))),
        (None, Some(why)) => Err(JsError::new(why.as_str())),
        (None, None) => Ok(to_hex(&h.build)),
    }
}

/// The sign-in `{1: token, 2: cursor}`; `cursor` is a version's bytes, empty for a fresh stream. A refusal never
/// carries the token.
#[wasm_bindgen(js_name = wireSignIn)]
pub fn wire_sign_in(token: &str, cursor: &[u8]) -> Result<Vec<u8>, JsError> {
    let token = Name::new(token).ok_or_else(|| JsError::new("token-not-a-name"))?;
    let mut m = BTreeMap::from([(1, Value::Text(token))]);
    if !cursor.is_empty() {
        m.insert(2, decode(cursor).map_err(js)?.value);
    }
    encode(&Value::Map(m)).map_err(js)
}

/// One frame from the gateway as a line: `outcome <name>`, or `answer <sequence> <version hex>`, with `-` for either
/// when the frame has none (an answer the gateway gives itself has no version).
#[wasm_bindgen(js_name = wireFrame)]
pub fn wire_frame(frame: &[u8]) -> Result<String, JsError> {
    let Value::Map(m) = decode(frame).map_err(js)?.value else {
        return Err(JsError::new("frame-not-a-record"));
    };
    if let Some(Value::Text(name)) = m.get(&4) {
        return Ok(format!("outcome {}", name.as_str()));
    }
    let sequence = match m.get(&2) {
        Some(Value::Map(a)) => match a.get(&2) {
            Some(Value::Uint(s)) => s.to_string(),
            _ => "-".to_owned(),
        },
        _ => return Err(JsError::new("frame-not-a-record")),
    };
    let version = match m.get(&1) {
        Some(v) => to_hex(&encode(v).map_err(js)?),
        None => "-".to_owned(),
    };
    Ok(format!("answer {sequence} {version}"))
}

/// A Soul's intent with no parameters, on `target` (a node's id as `<scope hex>-<counter>`, or empty for none),
/// decided against `basis` (a version's bytes; empty for the zero version) and expiring at `expiry` world
/// microseconds; read back as the world reads it.
#[wasm_bindgen(js_name = wireIntent)]
pub fn wire_intent(
    scope: &[u8],
    counter: u64,
    verb: &str,
    sequence: u64,
    basis: &[u8],
    expiry: u64,
    target: &str,
) -> Result<Vec<u8>, JsError> {
    let target = match target {
        "" => None,
        t => {
            let (scope, counter) = t
                .split_once('-')
                .and_then(|(s, c)| Some((from_hex(s).ok()?.try_into().ok()?, c.parse().ok()?)))
                .ok_or_else(|| JsError::new("target-not-an-id"))?;
            let id =
                Id::new(Scope(scope), counter).ok_or_else(|| JsError::new("target-not-an-id"))?;
            Some(Target::Node(id))
        }
    };
    let scope = Scope(
        scope
            .try_into()
            .map_err(|_| JsError::new("scope-not-16-bytes"))?,
    );
    let id = Id::new(scope, counter).ok_or_else(|| JsError::new("id-counter-exhausted"))?;
    let basis = match basis {
        [] => Version {
            lineage: Scope([0; 16]),
            zone: Id::new(Scope([0; 16]), 0).ok_or_else(|| JsError::new("id-counter-exhausted"))?,
            epoch: 0,
            sequence: 0,
        }
        .to_value(),
        b => decode(b).map_err(js)?.value,
    };
    let intent = Intent {
        actor: Actor::Soul(id),
        verb: Name::new(verb).ok_or_else(|| JsError::new("verb-not-a-name"))?,
        target,
        parameters: BTreeMap::new(),
        sequence,
        basis,
        expiry: i64::try_from(expiry).map_err(|_| JsError::new("expiry-too-far"))?,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    };
    let bytes = encode(&intent.to_value()).map_err(js)?;
    Intent::read(&bytes).map_err(js)?;
    Ok(bytes)
}
