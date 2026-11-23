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
//!
//! A creator's daemon (G7, #2796) builds its edit intents with [`wire_edit`] (T10 rule 15) and checks a batch on its
//! copy with [`edit_check`], which asks the world nothing: the structure checks of `edit::check`, by the same names,
//! against the kinds the world pins (its kinds text, read with `world_model::parse_kinds`).

use crate::apply::Replica;
use crate::edit::{OPS_MOST, Op, Ref, Spot};
use crate::effects::{Actor, Body, Effect, read_id};
use crate::encode::{Name, Value, decode, encode, from_hex, to_hex};
use crate::ids::{Id, Scope, Version};
use crate::intents::{Fallback, Hello, Intent, PROTOCOL, Target};
use crate::kinds::defined;
use crate::pose::{Quat, Support, Vec3};
use crate::rules::json;
use crate::sync::{Copy, Descent, read_hashes, read_records, wire};
use crate::world_model::{Audience, Kind, parse_kinds, plain, takes};
use std::collections::{BTreeMap, BTreeSet};
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
    // A view item (C6), which `wireHeard` reads, or the world's refusal of the subscription.
    if m.contains_key(&VIEW_ITEM) {
        return Ok("item".to_owned());
    }
    if let Some(Value::Text(name)) = m.get(&VIEW_REFUSED) {
        return Ok(format!("view-refused {}", name.as_str()));
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
    // G7 (#2796): an edit's receipt maps each placed name to its id (6), as `1=<id>,2=<id>`; its refusal names the
    // failing operation (7). Each `-` when the answer has none.
    let names = match (kind.as_str(), a.get(&6)) {
        ("1", Some(Value::Map(n))) if !n.is_empty() => n
            .iter()
            .map(|(k, v)| read_id(v).map(|id| format!("{k}={}", id_text(id))))
            .collect::<Result<Vec<_>, _>>()
            .map_err(js)?
            .join(","),
        _ => "-".to_owned(),
    };
    Ok(format!(
        "answer {sequence} {version} {kind} {name} {names} {}",
        field(7)
    ))
}

/// The gateway's view frames (`gatewayd::views`, #3292): a subscribe in, an item or a refusal out.
const VIEW_SUBSCRIBE: u64 = 30;
const VIEW_ITEM: u64 = 31;
const VIEW_REFUSED: u64 = 32;
/// The level a Soul's daemon subscribes at: sampled, so every entry of a body near it that is not a plain motion
/// sample reaches it (R4 rule 2; R9b, #3201). What is addressed to it is sent at every level (R4 rule 5).
const FOLLOW_LEVEL: u64 = 2;
/// R4's entry item (`worldd::views::subscription::Kind::Entry`): `{1: 1, 2: entry}`.
const ENTRY_ITEM: u64 = 1;

fn id_text(id: Id) -> String {
    format!("{}-{}", to_hex(&id.scope().0), id.counter())
}

/// A Soul's subscription to what it hears (C6, #3390) and to the entries of the bodies near it (R9b, #3201): `{30:
/// {1: [{2: body}], 2: sampled, 3: budget}}`, its own body followed, so the world addresses to it each utterance that
/// body hears (R4 rule 5) and sends it the entries of its interest set (R4 rule 2, [`wire_entry`]).
#[wasm_bindgen(js_name = wireSubscribe)]
pub fn wire_subscribe(scope: &[u8], counter: u64, budget: u64) -> Result<Vec<u8>, JsError> {
    let scope = Scope(
        scope
            .try_into()
            .map_err(|_| JsError::new("scope-not-16-bytes"))?,
    );
    let body = Id::new(scope, counter).ok_or_else(|| JsError::new("id-counter-exhausted"))?;
    let request = Value::Map(BTreeMap::from([
        (
            1,
            Value::Array(vec![Value::Map(BTreeMap::from([(2, body.to_value())]))]),
        ),
        (2, Value::Uint(FOLLOW_LEVEL)),
        (3, Value::Uint(budget)),
    ]));
    encode(&Value::Map(BTreeMap::from([(VIEW_SUBSCRIBE, request)]))).map_err(js)
}

/// An utterance in a view item frame (`{31: item}`) as a line, `heard <sequence> <world µs> <speaker id> <audience id
/// or -> <words hex or ->`, the audience `-` for the public; empty when the item is not an utterance.
#[wasm_bindgen(js_name = wireHeard)]
pub fn wire_heard(frame: &[u8]) -> Result<String, JsError> {
    let Value::Map(mut m) = decode(frame).map_err(js)?.value else {
        return Err(JsError::new("frame-not-a-record"));
    };
    let Some(Value::Bytes(item)) = m.remove(&VIEW_ITEM) else {
        return Err(JsError::new("frame-not-an-item"));
    };
    let Some(h) = crate::speech::heard(&item).map_err(js)? else {
        return Ok(String::new());
    };
    let audience = match h.said.audience {
        crate::world_model::Audience::Everyone => "-".to_owned(),
        crate::world_model::Audience::Of(a) => id_text(a),
    };
    let words = h.words.as_deref().map_or_else(|| "-".to_owned(), to_hex);
    Ok(format!(
        "heard {} {} {} {audience} {words}",
        h.sequence,
        h.at,
        id_text(h.speaker)
    ))
}

/// The largest integer a JavaScript number holds exactly.
const SAFE_MOST: u64 = (1 << 53) - 1;

/// An event field's value as JSON: an integer, a name, an id as `<scope hex>-<counter>`, or any other value as its
/// encoding's hex (quoted).
fn json_value(v: &Value) -> Result<String, JsError> {
    Ok(match v {
        Value::Uint(u) if *u <= SAFE_MOST => u.to_string(),
        Value::Nint(n) if *n < SAFE_MOST => format!("-{}", n + 1),
        // A name holds letters, digits and `_ - . : / @` only (T0 rule 6): nothing to escape.
        Value::Text(name) => format!("\"{}\"", name.as_str()),
        _ => match read_id(v) {
            Ok(id) => format!("\"{}\"", id_text(id)),
            Err(_) => format!("\"{}\"", to_hex(&encode(v).map_err(js)?)),
        },
    })
}

/// An entry in a view item frame (R4's `{1: 1, 2: entry}` or an addressed activity notification's
/// `{1: 9, 2: entry bytes}`) as JSON, for the
/// daemon to follow (R9b, #3201): `{"sequence":n,"at":n,"actor":"<id>"|null,"node":"<id>","changes":n,"events":
/// [{"name":"..","fields":{"<n>":<value>}}]}`, `actor` null for the world or a creator; empty when the item is not
/// an entry.
#[wasm_bindgen(js_name = wireEntry)]
pub fn wire_entry(frame: &[u8]) -> Result<String, JsError> {
    let Value::Map(mut m) = decode(frame).map_err(js)?.value else {
        return Err(JsError::new("frame-not-a-record"));
    };
    let Some(Value::Bytes(item)) = m.remove(&VIEW_ITEM) else {
        return Err(JsError::new("frame-not-an-item"));
    };
    let Value::Map(mut item) = decode(&item).map_err(js)?.value else {
        return Err(JsError::new("item-not-a-record"));
    };
    let addressed = item.get(&1) == Some(&Value::Uint(crate::speech::ADDRESSED));
    if !addressed && item.get(&1) != Some(&Value::Uint(ENTRY_ITEM)) {
        return Ok(String::new());
    }
    let mut entry = item
        .remove(&2)
        .ok_or_else(|| JsError::new("item-without-entry"))?;
    if addressed {
        let Value::Bytes(bytes) = entry else {
            return Err(JsError::new("addressed-entry-not-bytes"));
        };
        entry = decode(&bytes).map_err(js)?.value;
    }
    let e = Effect::read(entry).map_err(js)?;
    if addressed
        && (e
            .events
            .iter()
            .flatten()
            .any(|ev| ev.name.as_str() == crate::speech::SAID)
            || !e
                .events
                .iter()
                .flatten()
                .any(|ev| crate::activity::addressed(ev.name.as_str(), &ev.fields).is_some()))
    {
        return Ok(String::new());
    }
    let actor = match e.envelope.actor {
        Actor::Soul(id) => format!("\"{}\"", id_text(id)),
        Actor::Creator(_) | Actor::World => "null".to_owned(),
    };
    let changes = match &e.body {
        Body::Changes(c) => c.len(),
        _ => 0,
    };
    let mut events = Vec::new();
    for ev in e.events.iter().flatten() {
        let mut fields = Vec::new();
        for (k, v) in &ev.fields {
            fields.push(format!("\"{k}\":{}", json_value(v)?));
        }
        events.push(format!(
            r#"{{"name":"{}","fields":{{{}}}}}"#,
            ev.name.as_str(),
            fields.join(",")
        ));
    }
    Ok(format!(
        r#"{{"sequence":{},"at":{},"actor":{actor},"node":"{}","changes":{changes},"events":[{}]}}"#,
        e.envelope.sequence,
        e.envelope.at,
        id_text(e.envelope.node),
        events.join(",")
    ))
}

/// A Soul's intent with no parameters, `verb` a ranked list of verbs split by spaces (the rest are its fallbacks,
/// R7), each on `target` (a node's id as `<scope hex>-<counter>`, or empty for none), decided against `basis` (a
/// version's bytes; empty for the zero version) and expiring at `expiry` world microseconds; read back as the world
/// reads it. `words`, when given, is parameter 1 as T8's `{23: words}` (a say or a whisper, V1b). C10 (#3414): `target`
/// may be one id per verb, split by spaces; `args`, the first verb's thing arguments as `name=<id>` split by spaces, is
/// parameter 1 as C2's `[[name, id], ...]`. E26 (#3329): `params`, a JSON object of numbered parameters for an engine
/// act (`activity:offer`): a whole number, a name, an id (`<scope hex>-<counter>`), or a list of those. `reflex`, when
/// true, marks it as sent by the client on its own standing consent, not by its agent (field 12, #3764). `replaces`, an
/// earlier sequence of the same Soul, is field 10: what a `souls:cancel` ends (#3705).
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
    params: Option<String>,
    reflex: Option<bool>,
    replaces: Option<u64>,
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
    .map(|a| -> Result<Value, JsError> {
        let (key, value) = a
            .split_once('=')
            .filter(|(k, v)| !k.is_empty() && !v.is_empty())
            .ok_or_else(|| JsError::new("arg-not-name-and-id"))?;
        let value = named_arg(value, &node)?;
        Ok(Value::Array(vec![Value::Bytes(key.into()), value]))
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
    let mut parameters: BTreeMap<_, _> = numbered(params.as_deref(), &node)?.into_iter().collect();
    if !args.is_empty() {
        if parameters.contains_key(&1) || words.is_some() {
            return Err(JsError::new("arg-ambiguous"));
        }
        parameters.insert(1, Value::Array(args));
    }
    if let Some(w) = words {
        if parameters.contains_key(&1) {
            return Err(JsError::new("arg-ambiguous"));
        }
        parameters.insert(
            1,
            Value::Map(BTreeMap::from([(23, Value::Bytes(w.into_bytes()))])),
        );
    }
    if let Some(Value::Array(pairs)) = parameters.get(&1) {
        let mut seen = std::collections::BTreeSet::new();
        for pair in pairs {
            if let Value::Array(pair) = pair
                && let [Value::Bytes(key), _] = pair.as_slice()
                && !seen.insert(key)
            {
                return Err(JsError::new("arg-ambiguous"));
            }
        }
    }
    // An activity kind is pinned as a name and a binary hash, like an edit's kind: no text exceeds I2's limit.
    if matches!(verb.as_str(), "activity:offer" | "activity:propose")
        && let Some(Value::Text(kind)) = parameters.get(&1)
        && let Some((plain, hash)) = kind.as_str().split_once('@')
    {
        let bytes = from_hex(hash).map_err(|_| JsError::new("activity-kind-bad-pin"))?;
        if plain.is_empty()
            || plain.len() > crate::intent_decode::LIMITS.text_bytes as usize
            || bytes.len() != 34
            || bytes[..2] != [0x12, 0x20]
            || hash != to_hex(&bytes)
        {
            return Err(JsError::new("activity-kind-bad-pin"));
        }
        parameters.insert(
            1,
            Value::Array(vec![
                Value::Text(Name::new(plain).ok_or_else(|| JsError::new("activity-kind-bad-pin"))?),
                Value::Bytes(bytes),
            ]),
        );
    }
    let intent = Intent {
        actor: Actor::Soul(id),
        verb,
        target,
        parameters,
        sequence,
        basis,
        expiry: i64::try_from(expiry).map_err(|_| JsError::new("expiry-too-far"))?,
        resources: Vec::new(),
        fallbacks,
        // A cancel names the earlier sequence it ends (#3705, the daemon's `stop`).
        replaces,
        body: None,
        reflex: reflex.unwrap_or(false),
    };
    let bytes = encode(&intent.to_value()).map_err(js)?;
    crate::intent_decode::decode(&bytes).map_err(js)?;
    Ok(bytes)
}

fn id_of(t: &str) -> Option<Id> {
    let (s, c) = t.split_once('-')?;
    Id::new(Scope(from_hex(s).ok()?.try_into().ok()?), c.parse().ok()?)
}

/// A node an operation names, in the JSON the daemon passes: an id's text, or an integer naming a node placed earlier.
fn ref_of(v: Option<&json::Value>) -> Result<Ref, String> {
    match v {
        Some(json::Value::Int(n)) => u64::try_from(*n)
            .map(Ref::New)
            .map_err(|_| "a name is 0 or more".into()),
        Some(json::Value::Str(t)) => id_of(t)
            .map(Ref::Node)
            .ok_or_else(|| format!("{t} is not an id")),
        _ => Err("a node is an id or a name placed earlier in the batch".into()),
    }
}

fn int_of(v: Option<&json::Value>, what: &str) -> Result<i64, String> {
    match v {
        Some(json::Value::Int(n)) => i64::try_from(*n).map_err(|_| format!("{what} is too large")),
        _ => Err(format!("{what} is an integer")),
    }
}

fn uint_of(v: Option<&json::Value>, what: &str) -> Result<u64, String> {
    u64::try_from(int_of(v, what)?).map_err(|_| format!("{what} is 0 or more"))
}

/// A spot: `at` `[x, y, z]` in micrometres in the parent's frame and an optional `slot`, facing as the parent does.
fn spot_of(o: &json::Value) -> Result<Spot, String> {
    let at = o.get("at").and_then(json::Value::arr).unwrap_or(&[]);
    let axis = |k: usize| at.get(k).map_or(Ok(0), |v| int_of(Some(v), "at's numbers"));
    let slot = match o.get("slot") {
        None | Some(json::Value::Null) => None,
        v => Some(uint_of(v, "slot")?),
    };
    // A turn about +y in whole millidegrees (#3694: placing facing something), or, for a move that keeps a thing's
    // facing and support (#3695: a landform lifting what rests on it), both as the pose writes them: `orientation`
    // [w, x, y, z] and `support` {"which": 0 to 4, "node": id, "height": µm}.
    let orientation = match (
        o.get("yaw"),
        o.get("orientation").and_then(json::Value::arr),
    ) {
        (Some(v), _) if !matches!(v, json::Value::Null) => {
            Quat::from_yaw_mdeg(int_of(Some(v), "yaw, in millidegrees")?)
                .map_err(|e| format!("yaw: {e:?}"))?
        }
        (_, None) => Quat::IDENTITY,
        (_, Some(q)) if q.len() == 4 => Quat::new(
            int_of(q.first(), "orientation's numbers")?,
            int_of(q.get(1), "orientation's numbers")?,
            int_of(q.get(2), "orientation's numbers")?,
            int_of(q.get(3), "orientation's numbers")?,
        )
        .map_err(|e| format!("orientation: {e:?}"))?,
        (_, Some(_)) => return Err("orientation is [w, x, y, z]".into()),
    };
    let support = match o.get("support") {
        None | Some(json::Value::Null) if slot.is_some() => Support::Slot,
        None | Some(json::Value::Null) => Support::None,
        Some(v) => {
            let node = || match ref_of(v.get("node"))? {
                Ref::Node(id) => Ok(id),
                Ref::New(_) => Err("a support's node is an id".to_owned()),
            };
            match uint_of(v.get("which"), "a support's which")? {
                0 => Support::None,
                1 => Support::Surface {
                    surface: node()?,
                    height: int_of(v.get("height"), "a surface's height")?,
                },
                2 => Support::Slot,
                3 => Support::Volume { volume: node()? },
                4 => Support::Track,
                n => return Err(format!("a support's which is 0 to 4, not {n}")),
            }
        }
    };
    Ok(Spot {
        slot,
        position: Vec3::new(axis(0)?, axis(1)?, axis(2)?),
        orientation,
        support,
    })
}

/// An id written as text, `<32 hex scope>-<counter>`.
fn id_of_text(t: &str) -> Option<Id> {
    let (scope, n) = t.split_once('-')?;
    if scope.len() != 32 || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let scope: [u8; 16] = from_hex(scope).ok()?.try_into().ok()?;
    Id::new(Scope(scope), n.parse().ok()?)
}
/// The most bytes of words one field may carry in an edit (today's longest god-mode text, an event's title, is 120
/// characters; a notice's words are longer).
const WORDS_MOST: usize = 2_000;

fn field_value(v: &json::Value) -> Result<Value, String> {
    match v {
        json::Value::Int(n) if *n >= 0 => u64::try_from(*n)
            .map(Value::Uint)
            .map_err(|e| e.to_string()),
        json::Value::Int(n) => u64::try_from(-1 - *n)
            .map(Value::Nint)
            .map_err(|e| e.to_string()),
        json::Value::Bool(b) => Ok(Value::Uint(u64::from(*b))),
        json::Value::Str(t) => Name::new(t)
            .map(Value::Text)
            .ok_or_else(|| format!("{t:?} is not a name (ASCII, at most 64)")),
        json::Value::Arr(items) => items
            .iter()
            .map(field_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        // #3695: bytes (a landform's parameters, the ground's tiles) as {"hex": "<hex>"}.
        json::Value::Obj(_) if v.get("hex").is_some() => v
            .get("hex")
            .and_then(json::Value::str)
            .ok_or_else(|| "bytes are {\"hex\": \"<hex>\"}".to_owned())
            .and_then(|h| from_hex(h).map_err(|e| format!("bytes: {e}")))
            .map(Value::Bytes),
        // Words (#3699): T8's `{23: words}`, which the world keeps in its text store and logs as `{21: id}`.
        json::Value::Obj(pairs) => match pairs.as_slice() {
            [(k, json::Value::Str(t))]
                if k == "words" && !t.is_empty() && t.len() <= WORDS_MOST =>
            {
                Ok(Value::Map(BTreeMap::from([(
                    crate::audience::WORDS,
                    Value::Bytes(t.as_bytes().to_vec()),
                )])))
            }
            _ => Err(format!(
                "words are {{\"words\": \"...\"}}, 1 to {WORDS_MOST} bytes"
            )),
        },
        _ => Err(
            "a field's value is an integer, true or false, a name, words, bytes as {\"hex\": ..}, or an array of these"
                .into(),
        ),
    }
}

/// The batch the daemon passes as JSON: `[{"op": "place", "name": 1, "kind": "<namespace:name@hash>", "in": <node>,
/// "at": [x, y, z], "slot": n, "fields": {"<n>": value}}, {"op": "move", "node": <node>, "at": [..]}, {"op": "set",
/// "node": <node>, "field": n, "value": v}, {"op": "remove", "node": <node>}]`, positions in micrometres; a place or
/// a move may add `"yaw"`, a turn about +y in millidegrees.
/// A `doorway` names its leaf, owning `from` and other `to` places, with `at: [x,z]`, `yaw`, `width` and `height`
/// in the existing doorway row's millimetres/millidegrees, in the owning room's building frame.
fn ops_of(text: &str) -> Result<Vec<Op>, String> {
    batch_of(text).map(|(ops, _)| ops)
}

/// A batch as [`ops_of`] reads it, or `{"claim": "<claim id>", "ops": [...]}`: the batch sent under a build claim
/// (#3701).
fn batch_of(text: &str) -> Result<(Vec<Op>, Option<Name>), String> {
    let v = json::parse(text)?;
    match v.get("ops") {
        Some(ops) => {
            let claim = match v.get("claim") {
                None => None,
                Some(c) => Some(
                    c.str()
                        .and_then(Name::new)
                        .filter(|n| !n.as_str().is_empty() && n.as_str().len() <= 64)
                        .ok_or("a batch's claim is a name")?,
                ),
            };
            Ok((ops_in(ops)?, claim))
        }
        None => Ok((ops_in(&v)?, None)),
    }
}

fn ops_in(v: &json::Value) -> Result<Vec<Op>, String> {
    let list = v.arr().ok_or("a batch is a list of operations")?;
    if list.is_empty() || list.len() > OPS_MOST {
        return Err(format!("1 to {OPS_MOST} operations"));
    }
    list.iter()
        .map(|o| {
            let node = || ref_of(o.get("node"));
            Ok(match o.get("op").and_then(json::Value::str) {
                Some("place") => Op::Place {
                    name: uint_of(o.get("name"), "a place's name")?,
                    kind: o
                        .get("kind")
                        .and_then(json::Value::str)
                        .and_then(Name::new)
                        .ok_or("a place's kind is its full name")?,
                    parent: ref_of(o.get("in"))?,
                    at: spot_of(o)?,
                    audience: Audience::Everyone,
                    fields: o
                        .get("fields")
                        .and_then(json::Value::obj)
                        .unwrap_or(&[])
                        .iter()
                        .map(|(k, v)| {
                            let k = k.parse().map_err(|_| "a field is a number")?;
                            Ok((k, field_value(v)?))
                        })
                        .collect::<Result<_, String>>()?,
                },
                Some("move") => Op::Move {
                    node: node()?,
                    at: spot_of(o)?,
                },
                Some("set") => {
                    let field = uint_of(o.get("field"), "a set's field")?;
                    let raw = o.get("value").ok_or("a set's value")?;
                    // #3700: an owner written as an id's text (`<32 hex>-<counter>`, a Soul's) is written as an id;
                    // any other field keeps text as a name.
                    let to = match raw {
                        json::Value::Str(t) if field == crate::who_may::F_OWNER => {
                            match id_of_text(t) {
                                Some(id) => id.to_value(),
                                None => field_value(raw)?,
                            }
                        }
                        _ => field_value(raw)?,
                    };
                    Op::Set {
                        node: node()?,
                        field,
                        to,
                    }
                }
                Some("remove") => Op::Remove { node: node()? },
                Some("doorway") => {
                    let integer = |v: &json::Value| match v {
                        json::Value::Int(n) => i64::try_from(*n).ok(),
                        _ => None,
                    };
                    let at = o
                        .get("at")
                        .and_then(json::Value::arr)
                        .ok_or("a doorway's at is [x, z] mm")?;
                    let number = |key| {
                        o.get(key)
                            .and_then(integer)
                            .ok_or("a doorway number is an integer")
                    };
                    if at.len() != 2 {
                        return Err("a doorway's at is [x, z] mm".into());
                    }
                    Op::Doorway {
                        name: uint_of(o.get("name"), "a doorway's name")?,
                        door: ref_of(o.get("door"))?,
                        from: ref_of(o.get("from"))?,
                        to: ref_of(o.get("to"))?,
                        at: [
                            integer(&at[0]).ok_or("a doorway's x")?,
                            integer(&at[1]).ok_or("a doorway's z")?,
                        ],
                        yaw: number("yaw")?,
                        width: number("width")?,
                        height: number("height")?,
                        wall: ref_of(o.get("wall"))?,
                        closed: match field_value(
                            o.get("closed").ok_or("a doorway's closed solids")?,
                        )? {
                            Value::Array(rows) => rows,
                            _ => return Err("a doorway's closed solids are an array".into()),
                        },
                        open: match field_value(o.get("open").ok_or("a doorway's open solids")?)? {
                            Value::Array(rows) => rows,
                            _ => return Err("a doorway's open solids are an array".into()),
                        },
                    }
                }
                // #3728: a link between two nodes, its row appended to the owner's field, a door naming it.
                Some("link") => {
                    let ends = o
                        .get("ends")
                        .and_then(json::Value::arr)
                        .ok_or("a link's ends are [node, node]")?;
                    if ends.len() != 2 {
                        return Err("a link's ends are [node, node]".into());
                    }
                    Op::Link {
                        name: uint_of(o.get("name"), "a link's name")?,
                        ty: o
                            .get("type")
                            .and_then(json::Value::str)
                            .and_then(Name::new)
                            .ok_or("a link's type is a name")?,
                        ends: [ref_of(Some(&ends[0]))?, ref_of(Some(&ends[1]))?],
                        owner: match uint_of(o.get("owner"), "a link's owner")? {
                            0 => crate::world_model::End::First,
                            1 => crate::world_model::End::Second,
                            _ => return Err("a link's owner is 0 or 1".into()),
                        },
                        field: uint_of(o.get("field"), "a link's field")?,
                        row: match field_value(o.get("row").ok_or("a link's row")?)? {
                            Value::Array(row) => row,
                            _ => return Err("a link's row is an array".into()),
                        },
                        door: match o.get("door") {
                            None | Some(json::Value::Null) => None,
                            d => Some(ref_of(d)?),
                        },
                    }
                }
                _ => return Err("op is place, move, set, remove, doorway or link".into()),
            })
        })
        .collect()
}

/// A creator's edit intent (T10 rule 15, G7 #2796): `ops` (the JSON [`ops_of`] reads) from the actor
/// `<scope>-<counter>` (a creator; a Soul when `creator` is false, which the world refuses), under `sequence`, planned
/// against `basis` (a version's bytes; its sequence is the planned version). Read back as the world reads it.
#[wasm_bindgen(js_name = wireEdit)]
pub fn wire_edit(
    scope: &[u8],
    counter: u64,
    creator: bool,
    sequence: u64,
    basis: &[u8],
    ops: &str,
) -> Result<Vec<u8>, JsError> {
    let scope = Scope(
        scope
            .try_into()
            .map_err(|_| JsError::new("scope-not-16-bytes"))?,
    );
    let id = Id::new(scope, counter).ok_or_else(|| JsError::new("id-counter-exhausted"))?;
    let (ops, claim) = batch_of(ops).map_err(|e| JsError::new(&format!("edit-batch: {e}")))?;
    edit_intent(
        id,
        creator,
        sequence,
        basis,
        &crate::edit::wire::Asked::Batch(ops, None),
        claim.as_ref(),
    )
}

/// A creator's undo, redo or build step (G4, #3694), as [`wire_edit`] makes an edit: `asked` is `undo`, `redo` or
/// `step`; a step carries `ops` (the JSON [`ops_of`] reads) under the names `build` and `step`.
#[wasm_bindgen(js_name = wireEditAsked)]
#[allow(clippy::too_many_arguments)]
pub fn wire_edit_asked(
    scope: &[u8],
    counter: u64,
    sequence: u64,
    basis: &[u8],
    asked: &str,
    ops: &str,
    build: &str,
    step: &str,
) -> Result<Vec<u8>, JsError> {
    use crate::edit::wire::Asked;
    let scope = Scope(
        scope
            .try_into()
            .map_err(|_| JsError::new("scope-not-16-bytes"))?,
    );
    let id = Id::new(scope, counter).ok_or_else(|| JsError::new("id-counter-exhausted"))?;
    // A step's batch may be sent under a claim (`{"claim", "ops"}`, #3701), as a batch may.
    let (asked, claim) = match asked {
        "undo" => (Asked::Undo, None),
        "redo" => (Asked::Redo, None),
        "step" => {
            let (ops, claim) =
                batch_of(ops).map_err(|e| JsError::new(&format!("edit-batch: {e}")))?;
            (
                Asked::Batch(ops, Some((build.to_owned(), step.to_owned()))),
                claim,
            )
        }
        _ => return Err(JsError::new("edit-asked: undo, redo or step")),
    };
    edit_intent(id, true, sequence, basis, &asked, claim.as_ref())
}

fn edit_intent(
    id: Id,
    creator: bool,
    sequence: u64,
    basis: &[u8],
    asked: &crate::edit::wire::Asked,
    claim: Option<&Name>,
) -> Result<Vec<u8>, JsError> {
    let intent = Intent {
        actor: if creator {
            Actor::Creator(id)
        } else {
            Actor::Soul(id)
        },
        verb: Name::new(crate::edit::wire::VERB).ok_or_else(|| JsError::new("verb"))?,
        target: None,
        parameters: crate::edit::wire::with_claim(crate::edit::wire::parameters_of(asked), claim),
        sequence,
        basis: decode(basis).map_err(js)?.value,
        expiry: i64::MAX,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let bytes = encode(&intent.to_value()).map_err(js)?;
    // A creator's edit over the frame limit goes by the gateway's creator route (#3695), read as the world reads it.
    crate::intent_decode::decode_bulk(&bytes).map_err(js)?;
    Ok(bytes)
}

fn json_str(s: &str) -> String {
    let mut out = String::from('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Ordinary kinds text names its references together. An imported world's lines are independently named instead
/// (`import_eden::name_kind`), and may hold several revisions of one plain name. Keep each under its full hash.
fn creator_kinds(text: &str) -> Result<BTreeMap<String, Kind>, crate::world_model::Refusal> {
    let mut kinds = parse_kinds(text).or_else(|_| -> Result<_, crate::world_model::Refusal> {
        let mut kinds = BTreeMap::new();
        for line in text.lines() {
            kinds.extend(parse_kinds(line)?);
        }
        Ok(kinds)
    })?;
    // C3 extends body admission at boot without revising imported kind definitions. The world's export names
    // those exact full place kinds; both description and local checks apply the same in-memory extension.
    for line in text
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("# souls-boot-body"))
    {
        let target = line
            .strip_prefix("# souls-boot-body ")
            .filter(|s| !s.is_empty() && s.split_whitespace().count() == 1 && *s == s.trim())
            .ok_or_else(|| {
                crate::world_model::Refusal::Source("malformed boot-body admission".into())
            })?;
        let kind = kinds
            .get_mut(target)
            .filter(|k| k.owner == "place")
            .ok_or_else(|| {
                crate::world_model::Refusal::Source(
                    "boot-body target must be an existing full place kind".into(),
                )
            })?;
        kind.children.insert("body".into());
    }
    // Runtime activity pins are hashes of role definitions, not serialized T3 kind lines. Project only the
    // world's explicit boot registration/admission; no imported definition is rewritten or rehashed.
    for line in text
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("# souls-boot-activity"))
    {
        let bad =
            || crate::world_model::Refusal::Source("malformed boot-activity projection".into());
        let fields: Vec<_> = line
            .strip_prefix("# souls-boot-activity ")
            .ok_or_else(bad)?
            .split_whitespace()
            .collect();
        let [target, activity] = fields.as_slice() else {
            return Err(bad());
        };
        let (base, hash) = activity.split_once('@').ok_or_else(bad)?;
        if base.is_empty()
            || Name::new(base).is_none()
            || hash.len() != 68
            || !hash.starts_with("1220")
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(bad());
        }
        if kinds.get(*target).is_none_or(|kind| kind.owner != "place") {
            return Err(crate::world_model::Refusal::Source(
                "boot-activity target must be an existing full place kind".into(),
            ));
        }
        let runtime = Kind {
            owner: "activity".into(),
            children: Default::default(),
            slots: Default::default(),
            hands: None,
        };
        if kinds.get(*activity).is_some_and(|kind| kind != &runtime) {
            return Err(crate::world_model::Refusal::Source(
                "boot-activity collides with an existing kind".into(),
            ));
        }
        kinds.insert((*activity).to_owned(), runtime);
        kinds
            .get_mut(*target)
            .expect("validated place")
            .children
            .insert(base.to_owned());
    }
    Ok(kinds)
}

/// The kinds a world pins, from its kinds text, as JSON `{"<full name>": {"owner": .., "admits": [..], "slots":
/// {"<n>": [..]}}}`: what a creator may place, and in what.
#[wasm_bindgen(js_name = editKinds)]
pub fn edit_kinds(kinds: &str) -> Result<String, JsError> {
    let kinds = creator_kinds(kinds).map_err(|e| JsError::new(&format!("kinds-text: {e:?}")))?;
    Ok(kinds_json(&kinds))
}

fn kinds_json(kinds: &BTreeMap<String, Kind>) -> String {
    let list = |l: &BTreeSet<String>| l.iter().map(|n| json_str(n)).collect::<Vec<_>>().join(",");
    let out: Vec<String> = kinds
        .iter()
        .map(|(name, k)| {
            let slots: Vec<String> = k
                .slots
                .iter()
                .map(|(n, l)| format!(r#""{n}":[{}]"#, list(l)))
                .collect();
            format!(
                r#"{}:{{"owner":{},"admits":[{}],"slots":{{{}}}}}"#,
                json_str(name),
                json_str(&k.owner),
                list(&k.children),
                slots.join(",")
            )
        })
        .collect();
    format!("{{{}}}", out.join(","))
}

/// A node on the copy: its kind's full name and its parent.
struct Held {
    kind: String,
    parent: Option<Id>,
    doorway: bool,
    /// A `souls:kind` node's full name and record (#3697).
    definition: Option<(String, Vec<u8>)>,
}

/// The copy's nodes, read from its roots down by the records' hashes.
fn held(copy: &Copy) -> Result<BTreeMap<Id, Held>, String> {
    let mut out = BTreeMap::new();
    // A door is in a doorway while the link its field 7 names is there (`edit::check` asks the tree the same): a door
    // whose room was removed keeps a field naming a link that is gone (#3728).
    let (mut live, mut names_link) = (BTreeSet::new(), BTreeMap::new());
    let mut todo: Vec<Vec<u8>> = copy.roots().values().cloned().collect();
    while let Some(h) = todo.pop() {
        let Some(bytes) = copy.record(&h) else {
            continue;
        };
        let Value::Map(m) = decode(bytes).map_err(|e| e.to_string())?.value else {
            return Err("a record is a map".into());
        };
        let id = read_id(m.get(&1).ok_or("a record's id")?).map_err(|e| e.to_string())?;
        let kind = match m.get(&2) {
            Some(Value::Text(k)) => k.as_str().to_owned(),
            _ => return Err("a record's kind".into()),
        };
        let parent = m
            .get(&3)
            .map(read_id)
            .transpose()
            .map_err(|e| e.to_string())?;
        if let Some(Value::Array(cs)) = m.get(&10) {
            todo.extend(cs.iter().filter_map(|c| match c {
                Value::Bytes(b) => Some(b.clone()),
                _ => None,
            }));
        }
        if let Some(Value::Array(owned)) = m.get(&9) {
            live.extend(owned.iter().filter_map(|p| match p {
                Value::Array(p) => p.first().and_then(|l| read_id(l).ok()),
                _ => None,
            }));
        }
        if let Some(Value::Map(fields)) = m.get(&6)
            && let Some(link) = fields.get(&7).and_then(|v| read_id(v).ok())
        {
            names_link.insert(id, link);
        }
        let definition = match m.get(&6) {
            Some(Value::Map(fields)) if defined::is_definition(&kind) => {
                match (defined::named(fields), fields.get(&defined::ENTRY)) {
                    (Some(full), Some(Value::Bytes(b))) => Some((full.to_owned(), b.clone())),
                    _ => None,
                }
            }
            _ => None,
        };
        out.insert(
            id,
            Held {
                kind,
                parent,
                doorway: false,
                definition,
            },
        );
    }
    for (id, link) in names_link {
        if let Some(h) = out.get_mut(&id) {
            h.doorway = live.contains(&link);
        }
    }
    Ok(out)
}

/// The kinds the copy's `souls:kind` nodes at its root define (#3697), with `souls:kind` itself: the loader's reading.
fn copy_defined(nodes: &BTreeMap<Id, Held>) -> BTreeMap<String, Kind> {
    let root: BTreeSet<Id> = nodes
        .iter()
        .filter(|(_, h)| h.parent.is_none())
        .map(|(id, _)| *id)
        .collect();
    let mut out = BTreeMap::from([defined::kind().clone()]);
    for h in nodes.values() {
        if let (Some((full, b)), Some(p)) = (&h.definition, h.parent)
            && root.contains(&p)
            && let Ok(d) = defined::read(b, &|_| false)
            && d.full == *full
        {
            out.insert(d.full, d.kind);
        }
    }
    out
}

/// The kinds a creator defined in the world (#3697), from the copy (not `souls:kind` itself), in [`edit_kinds`]'s JSON: what `describe` lists
/// beside the boot kinds, and what a place may name.
#[wasm_bindgen(js_name = definedKinds)]
pub fn defined_kinds(copy: &WasmCopy) -> Result<String, JsError> {
    let nodes = held(&copy.copy).map_err(|e| JsError::new(&e))?;
    let mut own = copy_defined(&nodes);
    own.remove(&defined::kind().0);
    Ok(kinds_json(&own))
}

/// The engine's generic kind a definition is a node of (#3697): what a `define` places, never listed as a creator's.
#[wasm_bindgen(js_name = definitionKind)]
pub fn definition_kind() -> String {
    defined::kind().0.clone()
}

/// A record's full name and canonical bytes as the world would keep them (#3697): `{"ok": true, "kind": "<full>",
/// "bytes": <n>}`, or the refusal `{"ok": false, "code": "kind.<name>", "detail": ".."}`. Checks no namespace a boot kind
/// uses; the world does.
#[wasm_bindgen(js_name = defineName)]
pub fn define_name(record: &str) -> String {
    match defined::read(record.as_bytes(), &|_| false) {
        Ok(d) => format!(
            r#"{{"ok":true,"kind":{},"bytes":{}}}"#,
            json_str(&d.full),
            d.bytes.len()
        ),
        Err((code, detail)) => format!(
            r#"{{"ok":false,"code":{},"detail":{}}}"#,
            json_str(code),
            json_str(&detail)
        ),
    }
}

fn ref_text(r: Ref) -> String {
    match r {
        Ref::Node(id) => id_text(id),
        Ref::New(n) => format!("name {n}"),
    }
}

type Why = (&'static str, String);

/// Checks a batch (the JSON [`wire_edit`] takes) on the copy alone, asking the world nothing (G7, #2796): the
/// structure checks of `edit::check`, by its refusal names, with the world's kinds text (empty: the kinds are not
/// known here, and only the nodes are checked). Answers JSON `{"ok": true, "kinds": bool}` or `{"ok": false, "code":
/// "edit.<name>", "op": <place in the batch or null>, "detail": ".."}`. Not here: whether a node changed since the
/// planned version (the world's `edit.stale`) and the safety rule (G2), which need the world's stamps and bodies.
#[wasm_bindgen(js_name = editCheck)]
pub fn edit_check(copy: &WasmCopy, ops: &str, kinds: &str) -> String {
    let no = |op: Option<usize>, code: &str, detail: &str| {
        format!(
            r#"{{"ok":false,"code":{},"op":{},"detail":{}}}"#,
            json_str(code),
            op.map_or("null".to_owned(), |i| i.to_string()),
            json_str(detail)
        )
    };
    let ops = match ops_of(ops) {
        Ok(o) => o,
        Err(e) => return no(None, "edit.batch", &e),
    };
    let mut kinds: Option<BTreeMap<String, Kind>> = if kinds.trim().is_empty() {
        None
    } else {
        match creator_kinds(kinds) {
            Ok(k) => Some(k),
            Err(e) => return no(None, "edit.kinds-text", &format!("{e:?}")),
        }
    };
    let nodes = match held(&copy.copy) {
        Ok(n) => n,
        Err(e) => return no(None, "edit.copy", &e),
    };
    // The creator's own kinds, by the world's loader (#3697); a definition in the batch is checked as the world will.
    let boot = defined::namespaces(kinds.iter().flat_map(|k| k.keys().map(String::as_str)));
    let mut defines: BTreeMap<String, Vec<u8>> = nodes
        .values()
        .filter_map(|h| h.definition.clone())
        .collect();
    if let Some(k) = kinds.as_mut() {
        k.extend(copy_defined(&nodes));
    }
    let root = nodes
        .iter()
        .find(|(_, h)| h.parent.is_none())
        .map(|(id, _)| *id);
    let mut made: Vec<String> = Vec::new();
    let mut definitions_gone: Vec<(usize, String)> = Vec::new();
    // Each name placed so far, with its kind and parent, and every node the batch has removed.
    let mut new: BTreeMap<u64, (String, Ref)> = BTreeMap::new();
    let mut links = BTreeSet::new();
    let mut doorways: BTreeSet<Ref> = nodes
        .iter()
        .filter(|(_, n)| n.doorway)
        .map(|(id, _)| Ref::Node(*id))
        .collect();
    let mut gone: BTreeSet<Ref> = BTreeSet::new();
    for (i, op) in ops.iter().enumerate() {
        let named = |r: Ref| -> Result<(String, Option<Ref>), Why> {
            if gone.contains(&r) {
                let d = format!("{} is removed earlier in the batch", ref_text(r));
                return Err(("edit.node-missing", d));
            }
            match r {
                Ref::New(n) => new
                    .get(&n)
                    .map(|(k, p)| (k.clone(), Some(*p)))
                    .ok_or(("edit.name-unknown", format!("no place names {n}"))),
                Ref::Node(id) => nodes
                    .get(&id)
                    .map(|h| (h.kind.clone(), h.parent.map(Ref::Node)))
                    .ok_or_else(|| ("edit.node-missing", format!("{} is not here", id_text(id)))),
            }
        };
        let admits = |parent: &str, child: &str, slot: Option<u64>| -> Result<(), Why> {
            let Some(kinds) = &kinds else { return Ok(()) };
            let (Some(pk), Some(ck)) = (kinds.get(parent), kinds.get(child)) else {
                let d = format!("{} or {}", plain(parent), plain(child));
                return Err(("edit.kind-unknown", d));
            };
            let list = match slot {
                Some(s) => pk.slots.get(&s),
                None => Some(&pk.children),
            };
            if list.is_some_and(|l| takes(l, plain(child), &ck.owner)) {
                return Ok(());
            }
            let d = format!(
                "{} does not admit {} (slot {slot:?})",
                plain(parent),
                plain(child)
            );
            Err(("edit.child-not-admitted", d))
        };
        let step = || -> Result<(), Why> {
            match op {
                Op::Place {
                    name,
                    kind,
                    parent,
                    at,
                    fields,
                    ..
                } => {
                    if fields.contains_key(&crate::edit::DOOR_GEOMETRY) {
                        return Err((
                            "edit.doorway-geometry",
                            "owned geometry is written only by the doorway operation".into(),
                        ));
                    }
                    if kinds
                        .as_ref()
                        .is_some_and(|k| !k.contains_key(kind.as_str()))
                    {
                        let d = format!("{} is not pinned by this world", kind.as_str());
                        return Err(("edit.kind-unknown", d));
                    }
                    if new.contains_key(name) || links.contains(name) {
                        return Err(("edit.name-twice", format!("{name} is placed twice")));
                    }
                    if defined::is_definition(kind.as_str()) {
                        if root.is_none_or(|r| *parent != Ref::Node(r)) {
                            return Err((
                                "kind.invalid",
                                "a kind is defined at the world's root".into(),
                            ));
                        }
                        let Some(Value::Bytes(sent)) = fields.get(&defined::ENTRY) else {
                            return Err((
                                "kind.invalid",
                                "the definition is its record, as bytes".into(),
                            ));
                        };
                        let d = defined::read(sent, &|ns| boot.contains(ns))?;
                        if defines.contains_key(&d.full) {
                            return Err((
                                "kind.collision",
                                format!("{} is defined already", d.full),
                            ));
                        }
                        return Err(("", d.full));
                    }
                    let (pk, _) = named(*parent)?;
                    admits(&pk, kind.as_str(), at.slot)
                }
                Op::Move { node, at } => {
                    let (k, parent) = named(*node)?;
                    let parent =
                        parent.ok_or(("edit.root", "the zone's root does not move".to_owned()))?;
                    let (pk, _) = named(parent)?;
                    admits(&pk, &k, at.slot)
                }
                Op::Set { node, field, .. } => {
                    if *field == crate::edit::DOOR_GEOMETRY {
                        return Err((
                            "edit.doorway-geometry",
                            "owned geometry is written only by the doorway operation".into(),
                        ));
                    }
                    named(*node).map(|_| ())
                }
                Op::Doorway {
                    name,
                    door,
                    from,
                    to,
                    at,
                    width,
                    height,
                    wall,
                    closed,
                    open,
                    ..
                } => {
                    if new.contains_key(name) || links.contains(name) {
                        return Err(("edit.name-twice", format!("{name} is placed twice")));
                    }
                    let (kind, parent) = named(*door)?;
                    if doorways.contains(door) {
                        return Err(("edit.doorway", "the door already has a doorway".into()));
                    }
                    if parent != Some(*from)
                        || from == to
                        || *width <= 0
                        || *height <= 0
                        || at
                            .iter()
                            .chain([width, height])
                            .any(|n| n.checked_mul(1000).is_none())
                    {
                        return Err(("edit.doorway", "a door belongs to its owning end; distinct ends and positive dimensions are required".into()));
                    }
                    if kinds
                        .as_ref()
                        .is_some_and(|k| k.get(&kind).is_none_or(|k| k.owner != "thing"))
                    {
                        return Err(("edit.kind-unknown", kind));
                    }
                    let (wall_kind, _) = named(*wall)?;
                    if kinds
                        .as_ref()
                        .is_some_and(|k| k.get(&wall_kind).is_none_or(|k| k.owner != "thing"))
                    {
                        return Err((
                            "edit.doorway-geometry",
                            "the wall is an exact pinned thing".into(),
                        ));
                    }
                    crate::edit::doorway_solids(&Value::Array(closed.clone()), closed, open)
                        .map_err(|name| (name, "invalid authored geometry rows".into()))?;
                    for mut end in [*from, *to] {
                        let mut contained = false;
                        for _ in 0..64 {
                            if end == *wall {
                                contained = true;
                                break;
                            }
                            let (_, parent) = named(end)?;
                            let Some(parent) = parent else { break };
                            end = parent;
                        }
                        if !contained {
                            return Err((
                                "edit.doorway-geometry",
                                "both places belong to the authored wall's building".into(),
                            ));
                        }
                    }
                    for end in [*from, *to] {
                        let (kind, _) = named(end)?;
                        if kinds
                            .as_ref()
                            .is_some_and(|k| k.get(&kind).is_none_or(|k| k.owner != "place"))
                        {
                            return Err(("edit.doorway", "a doorway joins places".into()));
                        }
                    }
                    Ok(())
                }
                Op::Remove { node } => match named(*node)? {
                    (_, None) => Err(("edit.root", "the zone's root is not removed".to_owned())),
                    _ => Ok(()),
                },
                Op::Link {
                    name,
                    ty,
                    ends,
                    field,
                    row,
                    door,
                    ..
                } => {
                    if new.contains_key(name) || links.contains(name) {
                        return Err(("edit.name-twice", format!("{name} is placed twice")));
                    }
                    if ty.as_str().starts_with("souls:")
                        || *field == crate::edit::DOOR_GEOMETRY
                        || *field == 7
                        || ends[0] == ends[1]
                        || row.len() > crate::edit::LINK_ROW_MOST
                    {
                        return Err(("edit.link", "a link joins two distinct nodes, is not the engine's own, and appends a short row to a field other than 7".into()));
                    }
                    for end in ends {
                        named(*end)?;
                    }
                    if let Some(door) = door {
                        named(*door)?;
                        if doorways.contains(door) {
                            return Err(("edit.doorway", "the door already has a doorway".into()));
                        }
                    }
                    Ok(())
                }
            }
        };
        match step() {
            // A definition that passed: its full name is pinned for the rest of the batch.
            Err(("", full)) => {
                if let (Some(k), Op::Place { fields, .. }) = (kinds.as_mut(), op)
                    && let Some(Value::Bytes(b)) = fields.get(&defined::ENTRY)
                    && let Ok(d) = defined::read(b, &|_| false)
                {
                    k.insert(full.clone(), d.kind);
                }
                defines.insert(full.clone(), Vec::new());
                made.push(full);
            }
            Err((code, detail)) => return no(Some(i), code, &detail),
            Ok(()) => {}
        }
        match op {
            Op::Set { node, .. } => {
                if let Ref::Node(id) = node
                    && nodes
                        .get(id)
                        .is_some_and(|h| defined::is_definition(&h.kind))
                {
                    return no(
                        Some(i),
                        "kind.invalid",
                        "a definition never changes: define the new revision",
                    );
                }
            }
            Op::Remove {
                node: Ref::Node(id),
            } => {
                if let Some((full, _)) = nodes.get(id).and_then(|h| h.definition.clone()) {
                    definitions_gone.push((i, full));
                }
            }
            _ => {}
        }
        match op {
            Op::Doorway { name, door, .. } => {
                links.insert(*name);
                doorways.insert(*door);
            }
            Op::Link { name, door, .. } => {
                links.insert(*name);
                if let Some(door) = door {
                    doorways.insert(*door);
                }
            }
            Op::Place {
                name,
                kind,
                parent,
                fields,
                ..
            } => {
                new.insert(*name, (kind.as_str().to_owned(), *parent));
                if fields.get(&7).is_some_and(|v| read_id(v).is_ok()) {
                    doorways.insert(Ref::New(*name));
                }
            }
            Op::Set { node, field: 7, to } => {
                if read_id(to).is_ok() {
                    doorways.insert(*node);
                } else {
                    doorways.remove(node);
                }
            }
            Op::Remove { node } => {
                // Its subtree goes with it: every held node and placed name below it.
                let mut stack = vec![*node];
                while let Some(r) = stack.pop() {
                    gone.insert(r);
                    stack.extend(
                        nodes
                            .iter()
                            .filter(|(_, h)| h.parent.map(Ref::Node) == Some(r))
                            .map(|(id, _)| Ref::Node(*id)),
                    );
                    stack.extend(
                        new.iter()
                            .filter(|(_, (_, p))| *p == r)
                            .map(|(n, _)| Ref::New(*n)),
                    );
                }
            }
            _ => {}
        }
    }
    // `kind.in-use`: a removed definition's kind is still the kind of a thing the batch leaves.
    for (i, full) in &definitions_gone {
        let left = |mut r: Ref| {
            for _ in 0..=crate::world_model::DEPTH_LIMIT {
                if gone.contains(&r) {
                    return false;
                }
                let up = match r {
                    Ref::New(n) => new.get(&n).map(|(_, p)| *p),
                    Ref::Node(id) => nodes.get(&id).and_then(|h| h.parent).map(Ref::Node),
                };
                let Some(up) = up else { return true };
                r = up;
            }
            true
        };
        let users = nodes
            .iter()
            .filter(|(_, h)| h.kind == *full)
            .map(|(id, _)| Ref::Node(*id))
            .chain(
                new.iter()
                    .filter(|(_, (k, _))| k == full)
                    .map(|(n, _)| Ref::New(*n)),
            );
        if let Some(u) = users.into_iter().find(|r| left(*r)) {
            let d = format!(
                "{} is still a {}; remove what uses it first",
                ref_text(u),
                plain(full)
            );
            return no(Some(*i), "kind.in-use", &d);
        }
    }
    let defines: Vec<String> = made.iter().map(|m| json_str(m)).collect();
    format!(
        r#"{{"ok":true,"kinds":{},"defines":[{}]}}"#,
        kinds.is_some(),
        defines.join(",")
    )
}

/// A declared bare argument name is bytes; a valid thing id keeps its existing array form.
fn named_arg(
    value: &str,
    node: &dyn Fn(&str) -> Result<Option<Target>, JsError>,
) -> Result<Value, JsError> {
    match node(value) {
        Ok(Some(Target::Node(id))) => Ok(id.to_value()),
        _ if value.rsplit_once('-').is_some_and(|(s, _)| s.len() == 32) => {
            Err(JsError::new("arg-not-name-and-id"))
        }
        _ if !value.is_empty() && Name::new(value).is_some() => {
            Ok(Value::Bytes(value.as_bytes().to_vec()))
        }
        _ => Err(JsError::new("arg-not-name-and-id")),
    }
}

/// E26: `wireIntent`'s numbered parameters, read from a JSON object; a text is an id when it reads as one.
fn numbered(
    params: Option<&str>,
    node: &dyn Fn(&str) -> Result<Option<Target>, JsError>,
) -> Result<Vec<(u64, Value)>, JsError> {
    use crate::rules::json::{Value as Json, parse};
    let bad = || JsError::new("params-not-numbered");
    fn one(
        v: &Json,
        node: &dyn Fn(&str) -> Result<Option<Target>, JsError>,
    ) -> Result<Value, JsError> {
        Ok(match v {
            Json::Int(n) if *n >= 0 => {
                Value::Uint(u64::try_from(*n).map_err(|_| JsError::new("param-out-of-range"))?)
            }
            Json::Int(n) => {
                Value::Nint(u64::try_from(-1 - *n).map_err(|_| JsError::new("param-out-of-range"))?)
            }
            Json::Str(t) => match node(t) {
                Ok(Some(Target::Node(id))) => id.to_value(),
                _ => Value::Text(Name::new(t).ok_or_else(|| JsError::new("param-not-a-name"))?),
            },
            Json::Arr(a) => Value::Array(a.iter().map(|x| one(x, node)).collect::<Result<_, _>>()?),
            Json::Obj(m) if m.len() == 1 => match (&m[0].0[..], &m[0].1) {
                ("23", Json::Str(words)) => Value::Map(BTreeMap::from([(
                    23,
                    Value::Bytes(words.as_bytes().to_vec()),
                )])),
                ("21", Json::Str(id)) => match node(id)? {
                    Some(Target::Node(id)) => Value::Map(BTreeMap::from([(21, id.to_value())])),
                    _ => return Err(JsError::new("param-unsupported")),
                },
                _ => return Err(JsError::new("param-unsupported")),
            },
            _ => return Err(JsError::new("param-unsupported")),
        })
    }
    let Some(text) = params.filter(|t| !t.is_empty()) else {
        return Ok(Vec::new());
    };
    let Json::Obj(m) = parse(text).map_err(|_| bad())? else {
        return Err(bad());
    };
    m.iter()
        .map(|(k, v)| {
            let key = k.parse().map_err(|_| bad())?;
            let value = if key == 1 {
                if let Json::Arr(pairs) = v {
                    if pairs.iter().all(|p| matches!(p, Json::Arr(kv) if matches!(kv.as_slice(), [Json::Str(_), _]))) {
                        Value::Array(pairs.iter().map(|p| {
                            let Json::Arr(kv) = p else { unreachable!() };
                            let Json::Str(name) = &kv[0] else { unreachable!() };
                            if name.is_empty() { return Err(JsError::new("arg-malformed")); }
                            let value = match &kv[1] { Json::Str(t) => named_arg(t, node)?, v => one(v, node)? };
                            Ok(Value::Array(vec![Value::Bytes(name.as_bytes().to_vec()), value]))
                        }).collect::<Result<_, _>>()?)
                    } else { one(v, node)? }
                } else { one(v, node)? }
            } else { one(v, node)? };
            Ok((key, value))
        })
        .collect()
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
        // A sync cut off before it finished (its socket closed) is let go first (#3424).
        if let Some(old) = self.descent.take() {
            self.copy.abandon(old);
        }
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

/// Where a moving node is at world time `t` (#3603): `field` is the node's course field ([`crate::schedule::F_COURSE`],
/// 80) as its record holds it (the value's canonical bytes), `t` world µs. Gives `[x, y, z, vx, vy, vz]` in whole
/// units (a `BigInt64Array`): its position in its parent's frame, µm, and its velocity, µm a second, read by the same
/// formula the world reads ([`crate::schedule::course::place_at`]). Throws (`schedule-malformed`, the track's load refusals,
/// `before-track-start`) when the field is not a course the world would move the node by; the node then stands where
/// it was placed.
#[wasm_bindgen(js_name = courseAt)]
pub fn course_at(field: &[u8], t: i64) -> Result<Vec<i64>, JsError> {
    use crate::schedule::course::Course;
    let v = decode(field).map_err(js)?.value;
    let course =
        Course::read(&v).ok_or_else(|| JsError::new("schedule-malformed: not a course"))?;
    let table = course.load().map_err(js)?;
    let (p, v) = table.at(t).map_err(js)?;
    Ok(vec![p.x, p.y, p.z, v.x, v.y, v.z])
}
