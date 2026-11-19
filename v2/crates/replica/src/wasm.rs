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
/// act (`activity:offer`): a whole number, a name, an id (`<scope hex>-<counter>`), or a list of those.
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
    let mut parameters: BTreeMap<_, _> = words
        .map(|w| {
            (
                1,
                Value::Map(BTreeMap::from([(23, Value::Bytes(w.into_bytes()))])),
            )
        })
        .into_iter()
        .chain((!args.is_empty()).then_some((1, Value::Array(args))))
        .chain(numbered(params.as_deref(), &node)?)
        .collect();
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
        replaces: None,
        body: None,
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
    Ok(Spot {
        slot,
        position: Vec3::new(axis(0)?, axis(1)?, axis(2)?),
        orientation: Quat::IDENTITY,
        support: if slot.is_some() {
            Support::Slot
        } else {
            Support::None
        },
    })
}

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
        _ => Err("a field's value is an integer, true or false, or a name".into()),
    }
}

/// The batch the daemon passes as JSON: `[{"op": "place", "name": 1, "kind": "<namespace:name@hash>", "in": <node>,
/// "at": [x, y, z], "slot": n, "fields": {"<n>": value}}, {"op": "move", "node": <node>, "at": [..]}, {"op": "set",
/// "node": <node>, "field": n, "value": v}, {"op": "remove", "node": <node>}]`, positions in micrometres.
fn ops_of(text: &str) -> Result<Vec<Op>, String> {
    let v = json::parse(text)?;
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
                Some("set") => Op::Set {
                    node: node()?,
                    field: uint_of(o.get("field"), "a set's field")?,
                    to: field_value(o.get("value").ok_or("a set's value")?)?,
                },
                Some("remove") => Op::Remove { node: node()? },
                _ => return Err("op is place, move, set or remove".into()),
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
    let ops = ops_of(ops).map_err(|e| JsError::new(&format!("edit-batch: {e}")))?;
    let intent = Intent {
        actor: if creator {
            Actor::Creator(id)
        } else {
            Actor::Soul(id)
        },
        verb: Name::new(crate::edit::wire::VERB).ok_or_else(|| JsError::new("verb"))?,
        target: None,
        parameters: crate::edit::wire::parameters(&ops),
        sequence,
        basis: decode(basis).map_err(js)?.value,
        expiry: i64::MAX,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    };
    let bytes = encode(&intent.to_value()).map_err(js)?;
    Intent::read(&bytes).map_err(js)?;
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
        if !kinds.get(*target).is_some_and(|kind| kind.owner == "place") {
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
    Ok(format!("{{{}}}", out.join(",")))
}

/// A node on the copy: its kind's full name and its parent.
struct Held {
    kind: String,
    parent: Option<Id>,
}

/// The copy's nodes, read from its roots down by the records' hashes.
fn held(copy: &Copy) -> Result<BTreeMap<Id, Held>, String> {
    let mut out = BTreeMap::new();
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
        out.insert(id, Held { kind, parent });
    }
    Ok(out)
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
    let kinds: Option<BTreeMap<String, Kind>> = if kinds.trim().is_empty() {
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
    // Each name placed so far, with its kind and parent, and every node the batch has removed.
    let mut new: BTreeMap<u64, (String, Ref)> = BTreeMap::new();
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
                    ..
                } => {
                    if kinds
                        .as_ref()
                        .is_some_and(|k| !k.contains_key(kind.as_str()))
                    {
                        let d = format!("{} is not pinned by this world", kind.as_str());
                        return Err(("edit.kind-unknown", d));
                    }
                    if new.contains_key(name) {
                        return Err(("edit.name-twice", format!("{name} is placed twice")));
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
                Op::Set { node, .. } => named(*node).map(|_| ()),
                Op::Remove { node } => match named(*node)? {
                    (_, None) => Err(("edit.root", "the zone's root is not removed".to_owned())),
                    _ => Ok(()),
                },
            }
        };
        if let Err((code, detail)) = step() {
            return no(Some(i), code, &detail);
        }
        match op {
            Op::Place {
                name, kind, parent, ..
            } => {
                new.insert(*name, (kind.as_str().to_owned(), *parent));
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
    format!(r#"{{"ok":true,"kinds":{}}}"#, kinds.is_some())
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
            Json::Int(n) => {
                Value::Uint(u64::try_from(*n).map_err(|_| JsError::new("param-negative"))?)
            }
            Json::Str(t) => match node(t) {
                Ok(Some(Target::Node(id))) => id.to_value(),
                _ => Value::Text(Name::new(t).ok_or_else(|| JsError::new("param-not-a-name"))?),
            },
            Json::Arr(a) => Value::Array(a.iter().map(|x| one(x, node)).collect::<Result<_, _>>()?),
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
        .map(|(k, v)| Ok((k.parse().map_err(|_| bad())?, one(v, node)?)))
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
