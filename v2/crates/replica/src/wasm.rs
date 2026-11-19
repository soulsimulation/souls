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
//!
//! The daemon's copy of its scope is a [`WasmCopy`] (R5's `sync::Copy`): when the gateway cannot resume its stream it
//! compares and descends through the gateway, one request at a time (R5b, #3164).

use crate::apply::Replica;
use crate::effects::Actor;
use crate::encode::{Name, Value, decode, encode, from_hex, to_hex};
use crate::ids::{Id, Scope, Version};
use crate::intents::{Fallback, Hello, Intent, PROTOCOL, Target};
use crate::sync::{Copy, Descent, read_hashes, read_records, wire};
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

/// The sign-in `{1: token, 2: cursor, 3: seen}`; `cursor` is a version's bytes, empty for a fresh stream, and `seen`
/// how many frames the client applied at that version (the gateway's default, 1, when left out). A refusal never
/// carries the token.
#[wasm_bindgen(js_name = wireSignIn)]
pub fn wire_sign_in(token: &str, cursor: &[u8], seen: Option<u32>) -> Result<Vec<u8>, JsError> {
    let token = Name::new(token).ok_or_else(|| JsError::new("token-not-a-name"))?;
    let mut m = BTreeMap::from([(1, Value::Text(token))]);
    if !cursor.is_empty() {
        m.insert(2, decode(cursor).map_err(js)?.value);
        if let Some(n) = seen {
            m.insert(3, Value::Uint(u64::from(n)));
        }
    }
    encode(&Value::Map(m)).map_err(js)
}

/// One frame from the gateway as a line: `outcome <name>`, `answer <sequence> <version hex> <kind> <reason or
/// outcome>`, with `-` for any the frame has none of (an answer the gateway gives itself has no version), or
/// `sync <n> <refusal name or ->` for the answer to sync request `n` (R5b), which [`WasmCopy`] reads.
#[wasm_bindgen(js_name = wireFrame)]
pub fn wire_frame(frame: &[u8]) -> Result<String, JsError> {
    let Value::Map(m) = decode(frame).map_err(js)?.value else {
        return Err(JsError::new("frame-not-a-record"));
    };
    if let Some(Value::Text(name)) = m.get(&4) {
        return Ok(format!("outcome {}", name.as_str()));
    }
    if let Some(Value::Uint(n)) = m.get(&wire::ASK) {
        return Ok(match m.get(&wire::REFUSED) {
            Some(Value::Text(name)) => format!("sync {n} {}", name.as_str()),
            _ => format!("sync {n} -"),
        });
    }
    let Some(Value::Map(a)) = m.get(&2) else {
        return Err(JsError::new("frame-not-a-record"));
    };
    let field = |k: u64| match a.get(&k) {
        Some(Value::Uint(s)) => s.to_string(),
        Some(Value::Text(name)) => name.as_str().to_owned(),
        _ => "-".to_owned(),
    };
    let version = match m.get(&1) {
        Some(v) => to_hex(&encode(v).map_err(js)?),
        None => "-".to_owned(),
    };
    // R10 (#2702): the answer's kind (1 receipt, 2 refused, 3 accepted, 4 resolved, 5 unread) and its reason or outcome.
    let (sequence, kind, name) = (field(2), field(3), field(4));
    Ok(format!("answer {sequence} {version} {kind} {name}"))
}

/// A Soul's intent with no parameters, `verb` a ranked list of verbs split by spaces (the rest are its fallbacks,
/// R7), each on `target` (a node's id as `<scope hex>-<counter>`, or empty for none), decided against `basis` (a
/// version's bytes; empty for the zero version) and expiring at `expiry` world microseconds; read back as the world
/// reads it. `words`, when given, is parameter 1 as T8's `{23: words}` (a say or a whisper, V1b). C10 (#3414): `target`
/// may be one id per verb, split by spaces; `args`, the first verb's thing arguments as `name=<id>` split by spaces, is
/// parameter 1 as C2's `[[name, id], ...]`.
#[wasm_bindgen(js_name = wireIntent)]
// JS calls it with positional arguments; the words came last (C4, #3368), then the arguments (C10, #3414).
#[allow(clippy::too_many_arguments)]
pub fn wire_intent(
    scope: &[u8],
    counter: u64,
    verb: &str,
    sequence: u64,
    basis: &[u8],
    expiry: u64,
    target: &str,
    words: Option<String>,
    args: Option<String>,
) -> Result<Vec<u8>, JsError> {
    let node = |t: &str| -> Result<Option<Target>, JsError> {
        Ok(match t {
            "" => None,
            t => {
                let (scope, counter) = t
                    .split_once('-')
                    .and_then(|(s, c)| Some((from_hex(s).ok()?.try_into().ok()?, c.parse().ok()?)))
                    .ok_or_else(|| JsError::new("target-not-an-id"))?;
                let id = Id::new(Scope(scope), counter)
                    .ok_or_else(|| JsError::new("target-not-an-id"))?;
                Some(Target::Node(id))
            }
        })
    };
    let mut targets = target
        .split(' ')
        .map(node)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter();
    let target = targets.next().flatten();
    let args = (args
        .unwrap_or_default()
        .split(' ')
        .filter(|a| !a.is_empty()))
    .map(|a| match a.split_once('=').map(|(k, v)| (k, node(v))) {
        Some((k, Ok(Some(Target::Node(id))))) => {
            Ok(Value::Array(vec![Value::Bytes(k.into()), id.to_value()]))
        }
        _ => Err(JsError::new("arg-not-name-and-id")),
    })
    .collect::<Result<Vec<_>, _>>()?;
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
    let mut ranked = verb
        .split(' ')
        .map(|v| Name::new(v).ok_or_else(|| JsError::new("verb-not-a-name")));
    let verb = ranked
        .next()
        .ok_or_else(|| JsError::new("verb-not-a-name"))??;
    let fallbacks = ranked
        .map(|v| {
            v.map(|verb| Fallback {
                verb,
                target: targets.next().flatten().or_else(|| target.clone()),
                parameters: BTreeMap::new(),
                resources: Vec::new(),
            })
        })
        .collect::<Result<_, _>>()?;
    let intent = Intent {
        actor: Actor::Soul(id),
        verb,
        target,
        parameters: words
            .map(|w| {
                (
                    1,
                    Value::Map(BTreeMap::from([(23, Value::Bytes(w.into_bytes()))])),
                )
            })
            .into_iter()
            .chain((!args.is_empty()).then_some((1, Value::Array(args))))
            .collect(),
        sequence,
        basis,
        expiry: i64::try_from(expiry).map_err(|_| JsError::new("expiry-too-far"))?,
        resources: Vec::new(),
        fallbacks,
        replaces: None,
        body: None,
    };
    let bytes = encode(&intent.to_value()).map_err(js)?;
    Intent::read(&bytes).map_err(js)?;
    Ok(bytes)
}

fn sync_map(frame: &[u8]) -> Result<BTreeMap<u64, Value>, JsError> {
    match decode(frame).map_err(js)?.value {
        Value::Map(m) => match m.get(&wire::REFUSED) {
            Some(Value::Text(name)) => Err(JsError::new(name.as_str())),
            _ => Ok(m),
        },
        _ => Err(JsError::new("frame-not-a-record")),
    }
}

/// The first request of a sync: `{20: n, 21: []}`, the hashes of the scope the world grants this Soul.
#[wasm_bindgen(js_name = wireSyncScope)]
pub fn wire_sync_scope(n: u64) -> Result<Vec<u8>, JsError> {
    encode(&Value::Map(BTreeMap::from([
        (wire::ASK, Value::Uint(n)),
        (wire::IDS, Value::Array(Vec::new())),
    ])))
    .map_err(js)
}

/// The daemon's copy of its scope (R5's `sync::Copy`), synced one request at a time through the gateway (R5b).
#[wasm_bindgen(js_name = Copy)]
#[derive(Default)]
pub struct WasmCopy {
    copy: Copy,
    descent: Option<Descent>,
    asked: Vec<Vec<u8>>,
}

#[wasm_bindgen(js_class = Copy)]
impl WasmCopy {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmCopy {
        WasmCopy::default()
    }

    /// Whether it holds none of its scope.
    pub fn empty(&self) -> bool {
        self.copy.roots().is_empty()
    }

    /// The hashes answer: compares, and gives the world's version (hex) the hashes are at.
    #[wasm_bindgen(js_name = onHashes)]
    pub fn on_hashes(&mut self, frame: &[u8]) -> Result<String, JsError> {
        let m = sync_map(frame)?;
        let (ids, hashes) = read_hashes(&m).map_err(js)?;
        let version = m.get(&1).ok_or_else(|| JsError::new("sync-answer"))?;
        let version = to_hex(&encode(version).map_err(js)?);
        self.descent = Some(self.copy.compare(&ids, hashes));
        Ok(version)
    }

    /// The next records request `{20: n, 22: [hashes]}`, or nothing once the copy holds its scope.
    pub fn next(&mut self, n: u64) -> Result<Vec<u8>, JsError> {
        let d = self
            .descent
            .as_mut()
            .ok_or_else(|| JsError::new("sync-not-started"))?;
        self.asked = self.copy.ask(d, wire::RECORDS_MOST);
        if self.asked.is_empty() {
            return Ok(Vec::new());
        }
        encode(&Value::Map(BTreeMap::from([
            (wire::ASK, Value::Uint(n)),
            (
                wire::RECORDS,
                Value::Array(self.asked.iter().cloned().map(Value::Bytes).collect()),
            ),
        ])))
        .map_err(js)
    }

    /// A records answer: each record checked against the hash that named it, and kept.
    #[wasm_bindgen(js_name = onRecords)]
    pub fn on_records(&mut self, frame: &[u8]) -> Result<(), JsError> {
        let got = read_records(&sync_map(frame)?).map_err(js)?;
        let d = self
            .descent
            .as_mut()
            .ok_or_else(|| JsError::new("sync-not-started"))?;
        self.copy.take(d, &self.asked, got).map_err(js)
    }

    /// Ends the sync: lets go what the scope no longer reaches, and gives R5's counts as JSON, with `heldBytes`, the
    /// records a snapshot of the scope would fetch.
    pub fn finish(&mut self) -> Result<String, JsError> {
        let d = self
            .descent
            .take()
            .ok_or_else(|| JsError::new("sync-not-started"))?;
        let s = self.copy.finish(d).map_err(js)?;
        Ok(format!(
            r#"{{"rounds":{},"changed":{},"fetched":{},"sent":{},"got":{},"held":{},"heldBytes":{}}}"#,
            s.rounds,
            s.changed,
            s.fetched,
            s.sent,
            s.got,
            s.held,
            self.copy.held_bytes()
        ))
    }

    /// The record a hash names (hex), if held (R7 reads the copy through it).
    pub fn record(&self, hash: &str) -> Option<Vec<u8>> {
        self.copy
            .record(&crate::encode::from_hex(hash).ok()?)
            .map(<[u8]>::to_vec)
    }

    /// Each scope node's hash, as JSON `{"<id's bytes hex>": "<hash hex>"}`.
    pub fn roots(&self) -> Result<String, JsError> {
        let mut out = Vec::new();
        for (id, h) in self.copy.roots() {
            let id = to_hex(&encode(&id.to_value()).map_err(js)?);
            out.push(format!(r#""{id}":"{}""#, to_hex(h)));
        }
        Ok(format!("{{{}}}", out.join(",")))
    }
}
