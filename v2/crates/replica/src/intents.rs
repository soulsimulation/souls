//! Intents and the protocol (contract T10; Engine v2 T10, #2664): the intent envelope, the two ways an intent is
//! answered, the closed list of orders, the first frame each way and the checker's load by hash. The rules are
//! numbered in `v2/docs/intents.md`. Sockets and tokens (I1), checking (I2, I3), receipts and orders at runtime (I4,
//! B7) are not here.

use std::collections::BTreeMap;

#[cfg(all(target_arch = "wasm32", feature = "vectors"))]
use wasm_bindgen::prelude::wasm_bindgen;

use crate::effects::{Actor, Refusal, read_id};
use crate::encode::{Name, Value, decode, encode, to_hex};
use crate::ids::{Id, sha256};
use crate::time::Micros;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn not<T>(what: &str) -> R<T> {
    refuse("intent-not-a-record", what.to_owned())
}

/// The most bytes an intent may have. It is checked before any byte is parsed (rule 11).
/// The most bytes a first frame may have, checked the same way (rule 12).
pub const HELLO_MOST: u64 = 256;
pub const INTENT_MOST: u64 = 4096;
/// The most bytes a creator's bulk edit may have (#3695): a landform's ground tiles, an imported world's part. Only a
/// creator's edit is read over [`INTENT_MOST`]; it reaches the world by the gateway's creator route alone, as the
/// agents' socket takes no message over the frame limit.
pub const BULK_MOST: u64 = 8 << 20;
/// The most fallbacks an intent may rank (rule 6).
pub const FALLBACKS_MOST: u64 = 4;
/// This protocol's version (rule 12). A change to any frame after the first raises it: 2 added field 12, the reflex
/// marker (#3764).
pub const PROTOCOL: u64 = 2;

/// The verbs that are the engine's own (rule 4): a move inside a joint activity, a cancel, and the orders.
pub const MOVE: &str = "souls:move";
pub const CANCEL: &str = "souls:cancel";
/// The closed list of orders besides ranked fallbacks (rule 5), which any act may carry.
pub const ORDERS: [&str; 3] = ["souls:hold", "souls:follow", "souls:queue"];

/// What an intent is, by its verb (rule 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A checked act: a form's verb, `namespace:form`. Answered by a receipt or a refusal.
    Act,
    /// A move inside a joint activity: accepted, then resolved.
    Move,
    /// An order from the closed list.
    Order,
    /// A cancel of an earlier intent of the same actor, named by `replaces`.
    Cancel,
    /// A creator's edit: a batch of place, move, set and remove operations under one cause (rule 15).
    Edit,
}

/// A target (rule 3): a node, or a selector from a closed list (E2 fills it) that the engine binds at commit and
/// records as its choice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Node(Id),
    Selector(u64, BTreeMap<u64, Value>),
}

/// A resource an intent claims (rule 3; T9): every resource of a class, one of a class, or one by name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Claim {
    All(u64),
    One(u64),
    Named(Name),
}

/// One ranked fallback (rule 6): another act's verb, target, parameters and resources, `{2, 3, 4, 8}` as in the
/// envelope, tried in order when the one before is refused at commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fallback {
    pub verb: Name,
    pub target: Option<Target>,
    pub parameters: BTreeMap<u64, Value>,
    pub resources: Vec<Claim>,
}

/// An intent's envelope (rules 2 and 3): `{1: actor, 2: verb, 3: target, 4: parameters, 5: sequence, 6: basis,
/// 7: expiry, 8: resources, 9: fallbacks, 10: replaces, 11: body, 12: reflex}`. 3, 4, 8, 9, 10, 11 and 12 are left
/// out when empty (12 is `1` when there);
/// 11, the world-owned body a creator drives, is there exactly when the actor is a creator (proposed for the owner's
/// decision at the trunk stop, rule 3). There is no field for a start time or a condition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub actor: Actor,
    pub verb: Name,
    pub target: Option<Target>,
    pub parameters: BTreeMap<u64, Value>,
    pub sequence: u64,
    /// The version it was decided against: T3's `[lineage, zone, epoch, sequence]`, kept as stored.
    pub basis: Value,
    /// World time in microseconds (T5), never the client's clock.
    pub expiry: Micros,
    pub resources: Vec<Claim>,
    pub fallbacks: Vec<Fallback>,
    /// An earlier sequence of the same actor that this replaces (or, for a cancel, ends).
    pub replaces: Option<u64>,
    /// The world-owned body a creator drives; none for a Soul, whose body is its own.
    pub body: Option<Id>,
    /// Sent by the Soul's client on its own standing consent (an R9 reflex), not by its agent (#3764): it does not
    /// count as the agent acting, so it neither keeps a body from going idle nor wakes it (B16). Left out (`false`)
    /// for an agent's act and by every client older than protocol 2.
    pub reflex: bool,
}

fn map(pairs: Vec<(u64, Value)>) -> Value {
    Value::Map(pairs.into_iter().collect())
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: &Value) -> R<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).or_else(|_| refuse("int-out-of-range", "an expiry")),
        Value::Nint(n) => i64::try_from(*n)
            .map(|n| -1 - n)
            .or_else(|_| refuse("int-out-of-range", "an expiry")),
        _ => not("an integer"),
    }
}

fn read_map(v: Option<&Value>) -> R<BTreeMap<u64, Value>> {
    match v {
        None => Ok(BTreeMap::new()),
        Some(Value::Map(m)) if !m.is_empty() => Ok(m.clone()),
        Some(Value::Map(_)) => refuse("not-canonical", "empty parameters are left out"),
        Some(_) => not("parameters"),
    }
}

fn read_actor(v: Option<&Value>) -> R<Actor> {
    let Some(Value::Map(m)) = v else {
        return not("an actor");
    };
    if m.len() != 2 {
        return not("an actor is a Soul or a creator; the world sends no intents");
    }
    let id = read_id(m.get(&2).map_or(&Value::Uint(0), |x| x))?;
    match m.get(&1) {
        Some(Value::Uint(1)) => Ok(Actor::Soul(id)),
        Some(Value::Uint(2)) => Ok(Actor::Creator(id)),
        _ => not("an actor is 1 a Soul or 2 a creator"),
    }
}

fn actor(a: Actor) -> Value {
    match a {
        Actor::Soul(id) => map(vec![(1, Value::Uint(1)), (2, id.to_value())]),
        Actor::Creator(id) => map(vec![(1, Value::Uint(2)), (2, id.to_value())]),
        Actor::World => map(vec![(1, Value::Uint(3))]),
    }
}

fn read_target(v: &Value) -> R<Target> {
    match v {
        Value::Array(_) => Ok(Target::Node(read_id(v)?)),
        Value::Map(m) => {
            let Some(Value::Uint(n)) = m.get(&1) else {
                return not("a selector");
            };
            let fields = read_map(m.get(&2))?;
            if m.keys().any(|k| *k > 2) {
                return not("a selector is {1: number, 2: fields}");
            }
            Ok(Target::Selector(*n, fields))
        }
        _ => not("a target"),
    }
}

fn target(t: &Target) -> Value {
    match t {
        Target::Node(id) => id.to_value(),
        Target::Selector(n, f) => {
            let mut m = vec![(1, Value::Uint(*n))];
            if !f.is_empty() {
                m.push((2, Value::Map(f.clone())));
            }
            map(m)
        }
    }
}

fn read_name(v: Option<&Value>, what: &str) -> R<Name> {
    match v {
        Some(Value::Text(n)) if n.as_str().contains(':') => Ok(n.clone()),
        Some(Value::Text(n)) => refuse("text-not-a-name", n.as_str().to_owned()),
        _ => not(what),
    }
}

fn read_claim(v: &Value) -> R<Claim> {
    let Value::Map(m) = v else {
        return not("a resource");
    };
    match (m.get(&1), m.get(&2)) {
        (Some(Value::Uint(1)), Some(Value::Uint(c))) => Ok(Claim::All(*c)),
        (Some(Value::Uint(2)), Some(Value::Uint(c))) => Ok(Claim::One(*c)),
        (Some(Value::Uint(3)), Some(Value::Text(n))) => Ok(Claim::Named(n.clone())),
        _ => not("a resource is {1: 1 all, 2 one or 3 named, 2: class or name}"),
    }
}

fn claim(c: &Claim) -> Value {
    match c {
        Claim::All(n) => map(vec![(1, Value::Uint(1)), (2, Value::Uint(*n))]),
        Claim::One(n) => map(vec![(1, Value::Uint(2)), (2, Value::Uint(*n))]),
        Claim::Named(n) => map(vec![(1, Value::Uint(3)), (2, Value::Text(n.clone()))]),
    }
}

fn read_fallback(v: &Value) -> R<Fallback> {
    let Value::Map(m) = v else {
        return not("a fallback");
    };
    if let Some(Value::Text(verb)) = m.get(&2)
        && verb.as_str().starts_with("souls:")
    {
        return refuse("fallback-not-an-act", verb.as_str().to_owned());
    }
    if m.keys().any(|k| ![2, 3, 4, 8].contains(k)) {
        return not("a fallback is {2: verb, 3: target, 4: parameters, 8: resources}");
    }
    Ok(Fallback {
        verb: read_name(m.get(&2), "a fallback's verb")?,
        target: m.get(&3).map(read_target).transpose()?,
        parameters: read_map(m.get(&4))?,
        resources: read_claims(m.get(&8))?,
    })
}

fn fallback(f: &Fallback) -> Value {
    let mut m = vec![(2, Value::Text(f.verb.clone()))];
    m.extend(f.target.as_ref().map(|t| (3, target(t))));
    if !f.parameters.is_empty() {
        m.push((4, Value::Map(f.parameters.clone())));
    }
    if !f.resources.is_empty() {
        m.push((8, Value::Array(f.resources.iter().map(claim).collect())));
    }
    map(m)
}

fn read_claims(v: Option<&Value>) -> R<Vec<Claim>> {
    match v {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) if !a.is_empty() => a.iter().map(read_claim).collect(),
        Some(_) => refuse("not-canonical", "empty resources are left out"),
    }
}

/// Whether a basis is T3's version, `[lineage (16 bytes), zone id, epoch, sequence]`.
fn is_version(v: &Value) -> bool {
    match v {
        Value::Array(a) if a.len() == 4 => {
            matches!(&a[0], Value::Bytes(b) if b.len() == 16)
                && read_id(&a[1]).is_ok()
                && matches!(a[2], Value::Uint(_))
                && matches!(a[3], Value::Uint(_))
        }
        _ => false,
    }
}

impl Intent {
    /// Reads an intent from its bytes (rules 2 to 11). The size is checked before anything is parsed
    /// (`intent-too-large`); then the record (`intent-not-a-record`, unknown fields included, `not-canonical`), the
    /// verb (`order-unknown` for an engine verb outside the closed list), the fallbacks (`fallbacks-too-many`,
    /// `fallback-not-an-act`, `fallbacks-not-on-an-act`), each kind's shape (`order-without-target`,
    /// `cancel-without-replaces`, `cancel-not-bare`, `edit-not-bare`, `edit-not-a-batch`) and the driven body
    /// (`creator-without-body`, `body-not-a-creators`; an edit drives none).
    /// Over [`INTENT_MOST`] bytes, only a creator's edit of at most [`BULK_MOST`] is read (#3695); anything else is
    /// `intent-too-large`, whatever else is wrong with it.
    pub fn read(bytes: &[u8]) -> R<Intent> {
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if size <= INTENT_MOST {
            return Intent::parse(bytes);
        }
        let too = || {
            refuse(
                "intent-too-large",
                format!("{size} bytes; at most {INTENT_MOST}, or {BULK_MOST} for a creator's edit"),
            )
        };
        if size > BULK_MOST {
            return too();
        }
        match Intent::parse(bytes) {
            Ok(i)
                if matches!(i.actor, Actor::Creator(_))
                    && i.verb.as_str() == crate::edit::wire::VERB =>
            {
                Ok(i)
            }
            _ => too(),
        }
    }

    fn parse(bytes: &[u8]) -> R<Intent> {
        let v = decode(bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let Value::Map(m) = &v else {
            return not("an intent");
        };
        if m.keys().any(|k| *k == 0 || *k > 12) {
            return not("an intent's fields are 1 to 12; none is a start time or a condition");
        }
        let fallbacks = match m.get(&9) {
            None => Vec::new(),
            Some(Value::Array(a)) if a.is_empty() => {
                return refuse("not-canonical", "empty fallbacks are left out");
            }
            Some(Value::Array(a)) => {
                if u64::try_from(a.len()).unwrap_or(u64::MAX) > FALLBACKS_MOST {
                    return refuse("fallbacks-too-many", format!("at most {FALLBACKS_MOST}"));
                }
                a.iter().map(read_fallback).collect::<R<Vec<_>>>()?
            }
            Some(_) => return not("fallbacks"),
        };
        let resources = match m.get(&8) {
            None => Vec::new(),
            Some(Value::Array(a)) if !a.is_empty() => a.iter().map(read_claim).collect::<R<_>>()?,
            Some(_) => return refuse("not-canonical", "empty resources are left out"),
        };
        let intent = Intent {
            actor: read_actor(m.get(&1))?,
            verb: read_name(m.get(&2), "a verb")?,
            target: m.get(&3).map(read_target).transpose()?,
            parameters: read_map(m.get(&4))?,
            sequence: match m.get(&5) {
                Some(Value::Uint(s)) => *s,
                _ => return not("a sequence"),
            },
            basis: match m.get(&6) {
                Some(b) if is_version(b) => b.clone(),
                _ => return not("a basis is [lineage, zone, epoch, sequence]"),
            },
            expiry: read_int(m.get(&7).map_or(&Value::Bytes(Vec::new()), |x| x))?,
            resources,
            fallbacks,
            replaces: match m.get(&10) {
                None => None,
                Some(Value::Uint(s)) => Some(*s),
                Some(_) => return not("replaces"),
            },
            body: m.get(&11).map(read_id).transpose()?,
            reflex: match m.get(&12) {
                None => false,
                Some(Value::Uint(1)) => true,
                Some(_) => return not("a reflex marker is 1, or left out"),
            },
        };
        let kind = intent.kind()?;
        if kind != Kind::Act && !intent.fallbacks.is_empty() {
            return refuse("fallbacks-not-on-an-act", intent.verb.as_str().to_owned());
        }
        if kind == Kind::Order && intent.verb.as_str() != "souls:hold" && intent.target.is_none() {
            return refuse("order-without-target", intent.verb.as_str().to_owned());
        }
        if kind == Kind::Cancel {
            if intent.replaces.is_none() {
                return refuse("cancel-without-replaces", "a cancel names what it ends");
            }
            if intent.target.is_some()
                || !intent.parameters.is_empty()
                || !intent.resources.is_empty()
            {
                return refuse("cancel-not-bare", "a cancel carries only what it ends");
            }
        }
        if kind == Kind::Edit {
            // An edit drives no body, and the world decides who may send one (`edit.not-the-creator`).
            if intent.target.is_some()
                || !intent.resources.is_empty()
                || intent.replaces.is_some()
                || intent.body.is_some()
            {
                return refuse("edit-not-bare", "an edit carries only its batch");
            }
            crate::edit::wire::asked(&intent.parameters)
                .or_else(|why| refuse("edit-not-a-batch", why))?;
        }
        match (intent.actor, intent.body) {
            (Actor::Creator(_), None) if kind != Kind::Edit => {
                return refuse(
                    "creator-without-body",
                    "a creator names the world's body it drives",
                );
            }
            (Actor::Soul(_), Some(_)) => {
                return refuse("body-not-a-creators", "a Soul acts with its own body");
            }
            _ => {}
        }
        if crate::encode::encode(&intent.to_value()).ok().as_deref() != Some(bytes) {
            return refuse("not-canonical", "an intent re-encodes to its own bytes");
        }
        Ok(intent)
    }

    /// The intent's kind, by its verb (rule 4): an engine verb (`souls:`) is a move, a cancel, an edit (rule 15) or
    /// one of the closed orders, or `order-unknown`; any other verb is an act.
    pub fn kind(&self) -> R<Kind> {
        let v = self.verb.as_str();
        if v == MOVE {
            Ok(Kind::Move)
        } else if v == CANCEL {
            Ok(Kind::Cancel)
        } else if v == crate::edit::wire::VERB {
            Ok(Kind::Edit)
        } else if ORDERS.contains(&v) {
            Ok(Kind::Order)
        } else if v.starts_with("souls:") {
            refuse("order-unknown", v.to_owned())
        } else {
            Ok(Kind::Act)
        }
    }

    /// Whether this intent is its Soul's agent acting (#3764): a Soul's intent not marked as a reflex. What the idle
    /// and wind-down rule (B16) counts; a creator's intent is not a Soul's agent.
    pub fn agent_act(&self) -> bool {
        matches!(self.actor, Actor::Soul(_)) && !self.reflex
    }

    pub fn to_value(&self) -> Value {
        let mut m = vec![
            (1, actor(self.actor)),
            (2, Value::Text(self.verb.clone())),
            (5, Value::Uint(self.sequence)),
            (6, self.basis.clone()),
            (7, int(self.expiry)),
        ];
        m.extend(self.target.as_ref().map(|t| (3, target(t))));
        if !self.parameters.is_empty() {
            m.push((4, Value::Map(self.parameters.clone())));
        }
        if !self.resources.is_empty() {
            m.push((8, Value::Array(self.resources.iter().map(claim).collect())));
        }
        if !self.fallbacks.is_empty() {
            m.push((
                9,
                Value::Array(self.fallbacks.iter().map(fallback).collect()),
            ));
        }
        m.extend(self.replaces.map(|r| (10, Value::Uint(r))));
        m.extend(self.body.map(|b| (11, b.to_value())));
        if self.reflex {
            m.push((12, Value::Uint(1)));
        }
        map(m)
    }
}

// --- Answers ------------------------------------------------------------------------------------------------------

/// The one optional field of an answer frame `{1: version, 2: answer}` (O4, #2694): where the act's time went, `[µs,
/// ...]`, each the time between two stamps of one machine's steady clock, never a time of day. As the client gets
/// it: `[gateway's receipt to send, gateway in, link in, world in, check, tick wait, commit, log sync, world out, link
/// out, gateway out]`; the rest sum to the first, and the client's wait less the first is the network. It is added as
/// the answer leaves, after its tick is on the disk, so it is in no logged or hashed record, and a frame without it is
/// the same answer. A 16-byte trace id may follow the integers when one is carried (OpenTelemetry's, later).
pub const ANSWER_TIMES: u64 = 3;

/// How an intent is answered (rules 8 and 9). The zone's writer mints an id for each intent it reads (T3, from its
/// own scope), which every effect it causes names as its cause (T6 rule 6). A checked act gets a receipt, naming that
/// id and the entries that carried it out, or a refusal naming its reason and what changed since its basis. A move
/// inside a joint activity is accepted, then resolved: a miss is an outcome, not a refusal. Bytes refused before an
/// actor and a sequence are read get the unread answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    /// `{1: actor, 2: sequence, 3: 1, 4: intent id, 5: [log sequence, ...], 6: {name: id}}`: 6, an edit's map from
    /// each placed node's temporary name to the id the engine minted (rule 15), left out when empty.
    Receipt {
        actor: Actor,
        sequence: u64,
        intent: Id,
        entries: Vec<u64>,
        names: BTreeMap<u64, Id>,
    },
    /// `{1: actor, 2: sequence, 3: 2, 4: reason, 5: version now, 6: [node, ...] changed since the basis, 7: the
    /// failing operation}`: 6 left out when empty; 7, an edit's operation by its place in the batch (rule 15), left
    /// out when none.
    Refused {
        actor: Actor,
        sequence: u64,
        reason: Name,
        now: Value,
        changed: Vec<Id>,
        op: Option<u64>,
    },
    /// `{1: actor, 2: sequence, 3: 3, 4: intent id}`: a move accepted, to be resolved.
    Accepted {
        actor: Actor,
        sequence: u64,
        intent: Id,
    },
    /// `{1: actor, 2: sequence, 3: 4, 4: outcome}`: what became of an accepted move (a name: landed, missed...).
    Resolved {
        actor: Actor,
        sequence: u64,
        outcome: Name,
    },
    /// `{3: 5, 4: reason}`: bytes refused before an actor and a sequence were read (too large, not a record).
    Unread { reason: Name },
}

impl Answer {
    pub fn to_value(&self) -> Value {
        let head = |a: &Actor, s: &u64, k: u64| {
            vec![(1, actor(*a)), (2, Value::Uint(*s)), (3, Value::Uint(k))]
        };
        match self {
            Answer::Receipt {
                actor: a,
                sequence,
                intent,
                entries,
                names,
            } => {
                let mut m = head(a, sequence, 1);
                m.push((4, intent.to_value()));
                m.push((
                    5,
                    Value::Array(entries.iter().map(|e| Value::Uint(*e)).collect()),
                ));
                if !names.is_empty() {
                    m.push((
                        6,
                        Value::Map(names.iter().map(|(n, id)| (*n, id.to_value())).collect()),
                    ));
                }
                map(m)
            }
            Answer::Refused {
                actor: a,
                sequence,
                reason,
                now,
                changed,
                op,
            } => {
                let mut m = head(a, sequence, 2);
                m.push((4, Value::Text(reason.clone())));
                m.push((5, now.clone()));
                if !changed.is_empty() {
                    m.push((
                        6,
                        Value::Array(changed.iter().map(|i| i.to_value()).collect()),
                    ));
                }
                m.extend(op.map(|o| (7, Value::Uint(o))));
                map(m)
            }
            Answer::Accepted {
                actor: a,
                sequence,
                intent,
            } => {
                let mut m = head(a, sequence, 3);
                m.push((4, intent.to_value()));
                map(m)
            }
            Answer::Resolved {
                actor: a,
                sequence,
                outcome,
            } => {
                let mut m = head(a, sequence, 4);
                m.push((4, Value::Text(outcome.clone())));
                map(m)
            }
            Answer::Unread { reason } => {
                map(vec![(3, Value::Uint(5)), (4, Value::Text(reason.clone()))])
            }
        }
    }
}

// --- The first frame and the checker ------------------------------------------------------------------------------

/// The first frame each way (rule 12), which never changes: `{1: protocol version, 2: build hash}`, and, from a
/// world that cannot speak the client's version, `3: {1: "souls:protocol-version", 2: client's version, 3: world's
/// version}`. Nothing else is ever in it, so a client of any version reads a refusal of any later one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hello {
    pub protocol: u64,
    pub build: Vec<u8>,
    /// A version refusal: the client's version and the world's.
    pub refused: Option<(u64, u64)>,
    /// Any other refusal a later world puts in field 3, by its name, so an old client still learns what it was.
    pub other: Option<Name>,
}

impl Hello {
    pub fn to_bytes(&self) -> R<Vec<u8>> {
        let mut m = vec![
            (1, Value::Uint(self.protocol)),
            (2, Value::Bytes(self.build.clone())),
        ];
        if let Some((theirs, ours)) = self.refused {
            m.push((
                3,
                map(vec![
                    (1, Value::Text(name("souls:protocol-version"))),
                    (2, Value::Uint(theirs)),
                    (3, Value::Uint(ours)),
                ]),
            ));
        } else if let Some(why) = &self.other {
            m.push((3, map(vec![(1, Value::Text(why.clone()))])));
        }
        encode(&map(m)).or_else(|e| refuse("encoding", e.to_string()))
    }

    /// Reads a first frame: the same code in every version (rule 12). Its size is checked before parsing
    /// (`hello-too-large`). Field 3's name is read, and its two versions when they are there, so this reader reads any
    /// refusal a later world puts in the frame.
    pub fn read(bytes: &[u8]) -> R<Hello> {
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > HELLO_MOST {
            return refuse("hello-too-large", format!("at most {HELLO_MOST} bytes"));
        }
        let v = decode(bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let bad = || refuse("hello-not-a-record", "{1: protocol, 2: build, 3: refusal}");
        let Value::Map(m) = v else { return bad() };
        let (Some(Value::Uint(protocol)), Some(Value::Bytes(build))) = (m.get(&1), m.get(&2))
        else {
            return bad();
        };
        let (refused, other) = match m.get(&3) {
            None => (None, None),
            Some(Value::Map(r)) => {
                let Some(Value::Text(why)) = r.get(&1) else {
                    return bad();
                };
                match (why.as_str(), r.get(&2), r.get(&3)) {
                    ("souls:protocol-version", Some(Value::Uint(a)), Some(Value::Uint(b))) => {
                        (Some((*a, *b)), None)
                    }
                    _ => (None, Some(why.clone())),
                }
            }
            Some(_) => return bad(),
        };
        Ok(Hello {
            protocol: *protocol,
            build: build.clone(),
            refused,
            other,
        })
    }
}

fn name(t: &str) -> Name {
    Name::new(t).unwrap_or_else(|| unreachable!("a fixed name"))
}

/// A world's answer to a client's first frame (rule 10): its own first frame, refusing in it when the versions differ.
pub fn answer_hello(client: &[u8], world_protocol: u64, world_build: &[u8]) -> R<Vec<u8>> {
    let c = Hello::read(client)?;
    Hello {
        protocol: world_protocol,
        build: world_build.to_vec(),
        refused: (c.protocol != world_protocol).then_some((c.protocol, world_protocol)),
        other: None,
    }
    .to_bytes()
}

/// A build's hash (rule 13): the SHA-256 multihash of its file's bytes, `1220` and 64 hex digits, as `sha256sum` gives.
pub fn build_hash(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![crate::ids::SHA2_256, 32];
    out.extend_from_slice(&sha256(bytes));
    out
}

/// A checker the client may run (rule 13): `replica` as WASM, loaded only when its bytes are the build asked for
/// (`checker-not-the-build`), a WASM module (`checker-not-wasm`) with no imports (`checker-has-imports`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checker {
    pub build: Vec<u8>,
}

fn leb(bytes: &[u8], at: &mut usize) -> R<u64> {
    let mut n = 0_u64;
    for shift in (0..64).step_by(7) {
        let Some(b) = bytes.get(*at) else {
            return refuse("checker-not-wasm", "a section runs past the end");
        };
        *at += 1;
        n |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok(n);
        }
    }
    refuse("checker-not-wasm", "a length is too long")
}

impl Checker {
    pub fn load(bytes: &[u8], want: &[u8]) -> R<Checker> {
        let got = build_hash(bytes);
        if got != want {
            return refuse(
                "checker-not-the-build",
                format!("asked {}, got {}", to_hex(want), to_hex(&got)),
            );
        }
        if bytes.get(..8) != Some(b"\0asm\x01\0\0\0".as_slice()) {
            return refuse("checker-not-wasm", "no WASM header");
        }
        let mut at = 8;
        while at < bytes.len() {
            let id = bytes[at];
            at += 1;
            let len = usize::try_from(leb(bytes, &mut at)?).unwrap_or(usize::MAX);
            if id == 2 {
                let mut i = at;
                if leb(bytes, &mut i)? > 0 {
                    return refuse("checker-has-imports", "a checker runs with no imports");
                }
            }
            at = at.saturating_add(len);
        }
        if at != bytes.len() {
            return refuse("checker-not-wasm", "a section runs past the end");
        }
        Ok(Checker { build: got })
    }
}

// --- The fixtures -------------------------------------------------------------------------------------------------

/// The golden intents, as diagnostic notation (rule 14).
pub const FIXTURES: [(&str, &str); 10] = [
    ("act", include_str!("../fixtures/intents/act.diag")),
    ("move", include_str!("../fixtures/intents/move.diag")),
    (
        "fallbacks",
        include_str!("../fixtures/intents/fallbacks.diag"),
    ),
    ("hold", include_str!("../fixtures/intents/hold.diag")),
    ("follow", include_str!("../fixtures/intents/follow.diag")),
    ("queue", include_str!("../fixtures/intents/queue.diag")),
    ("cancel", include_str!("../fixtures/intents/cancel.diag")),
    ("replace", include_str!("../fixtures/intents/replace.diag")),
    ("edit", include_str!("../fixtures/intents/edit.diag")),
    ("reflex", include_str!("../fixtures/intents/reflex.diag")),
];

/// The intents goldens, one per line, `name kind hex`, as `fixtures/intents/goldens.txt` holds them: the native test
/// and the WASM build in Node both compare this with that file. WASM exports it only with the `vectors` feature.
#[cfg_attr(all(target_arch = "wasm32", feature = "vectors"), wasm_bindgen)]
pub fn intents_goldens() -> String {
    let mut lines = Vec::new();
    for (n, text) in FIXTURES {
        let line = crate::effects::fixture_bytes(text)
            .and_then(|b| Intent::read(&b).map(|i| (i, b)))
            .and_then(|(i, b)| i.kind().map(|k| (k, b)));
        lines.push(match line {
            Ok((k, b)) => format!("{n} {k:?} {}", to_hex(&b)),
            Err(r) => format!("{n} refused {r}"),
        });
    }
    // The first frame never changes: a client's, and a world on the next version refusing it.
    let build = build_hash(b"souls:build");
    let hello = Hello {
        protocol: PROTOCOL,
        build: build.clone(),
        refused: None,
        other: None,
    }
    .to_bytes();
    let refusal = hello
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|h| answer_hello(h, PROTOCOL + 1, &build));
    for (n, b) in [("hello", hello), ("hello-refused", refusal)] {
        lines.push(match b {
            Ok(b) => format!("{n} Frame {}", to_hex(&b)),
            Err(r) => format!("{n} refused {r}"),
        });
    }
    lines.join("\n") + "\n"
}
