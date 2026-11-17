//! Effects (contract T6; Engine v2 T6, #2645): the two layers of every effect, its envelope, the header that a
//! bundle's parts name by hash, and applying a part to state. The rules are numbered in `v2/docs/effects.md`.
//!
//! A part is read into typed records that keep every field they do not know (a field number from a later schema),
//! so a record re-encodes to exactly the bytes it was read from, and a hash is taken over those stored bytes.
//! Applying reads only the generic changes: a named event adds no state. Bytes come from T0's profile (`encode.rs`).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[cfg(all(target_arch = "wasm32", feature = "vectors"))]
use wasm_bindgen::prelude::wasm_bindgen;

use crate::encode::{Name, Value, decode, encode, to_hex};
use crate::ids::{Hash, Id, Purpose, Scope};
use crate::pose::{Frame, Pose, Quat, Support, Vec3};
use crate::time::Micros;
use crate::world_model::{Audience, DEPTH_LIMIT, End};

/// The fields of a record that this build does not know, kept so that the record re-encodes to its stored bytes.
pub type Rest = BTreeMap<u64, Value>;

/// Why a part, an effect or a change is refused. Each has a name (`v2/docs/effects.md`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub name: &'static str,
    pub detail: String,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.name, self.detail)
    }
}

impl std::error::Error for Refusal {}

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn not_record<T>(what: &str) -> R<T> {
    refuse("not-a-record", what)
}

fn show(id: Id) -> String {
    crate::world_model::show(id)
}

// --- Reading and writing values -----------------------------------------------------------------------------------

/// A map being read: known fields are taken out, and what is left is the record's [`Rest`].
struct Rec(BTreeMap<u64, Value>);

impl Rec {
    fn of(v: Value, what: &str) -> R<Rec> {
        match v {
            Value::Map(m) => Ok(Rec(m)),
            _ => not_record(what),
        }
    }

    fn take(&mut self, k: u64, what: &str) -> R<Value> {
        match self.0.remove(&k) {
            Some(v) => Ok(v),
            None => not_record(&format!("{what} lacks field {k}")),
        }
    }

    fn opt(&mut self, k: u64) -> Option<Value> {
        self.0.remove(&k)
    }

    /// No field may be left: a small value (a cause, an actor, an audience) has no room for later fields.
    fn closed(self, what: &str) -> R<()> {
        match self.0.keys().next() {
            None => Ok(()),
            Some(k) => not_record(&format!("{what} has no field {k}")),
        }
    }
}

fn record(pairs: Vec<(u64, Value)>, rest: &Rest) -> Value {
    let mut m = rest.clone();
    m.extend(pairs);
    Value::Map(m)
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

/// A signed 64-bit integer. An integer the profile holds beyond `i64` (down to −2^64, up to 2^64 − 1) is refused by
/// name, never cast (rule 9).
fn read_int(v: &Value, what: &str) -> R<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).or_else(|_| refuse("int-out-of-range", what)),
        Value::Nint(n) => i64::try_from(*n)
            .map(|n| -1 - n)
            .or_else(|_| refuse("int-out-of-range", what)),
        _ => not_record(&format!("{what} is not an integer")),
    }
}

fn read_uint(v: &Value, what: &str) -> R<u64> {
    match v {
        Value::Uint(u) => Ok(*u),
        Value::Nint(_) => refuse("int-out-of-range", what),
        _ => not_record(&format!("{what} is not an unsigned integer")),
    }
}

fn read_bytes(v: Value, what: &str) -> R<Vec<u8>> {
    match v {
        Value::Bytes(b) => Ok(b),
        _ => not_record(&format!("{what} is not bytes")),
    }
}

fn read_array(v: Value, what: &str) -> R<Vec<Value>> {
    match v {
        Value::Array(a) => Ok(a),
        _ => not_record(&format!("{what} is not an array")),
    }
}

fn read_map(v: Value, what: &str) -> R<BTreeMap<u64, Value>> {
    match v {
        Value::Map(m) => Ok(m),
        _ => not_record(&format!("{what} is not a map")),
    }
}

/// A name: `namespace:name`, optionally pinned as `namespace:name@1220<64 hex digits>` (rule 10). Any other text in
/// a part, which could be words, is refused as `text-not-a-name`.
fn is_name(text: &str) -> bool {
    let (plain, hash) = match text.split_once('@') {
        Some((p, h)) => (p, Some(h)),
        None => (text, None),
    };
    let Some((ns, name)) = plain.split_once(':') else {
        return false;
    };
    let part = |s: &str, extra: &[u8]| {
        s.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || extra.contains(&b))
    };
    part(ns, b"-")
        && part(name, b"_-")
        && hash.is_none_or(|h| {
            h.len() == 68
                && h.starts_with("1220")
                && h.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

fn read_name(v: Value, what: &str) -> R<Name> {
    match v {
        Value::Text(n) if is_name(n.as_str()) => Ok(n),
        Value::Text(n) => refuse("text-not-a-name", format!("{what}: {}", n.as_str())),
        _ => not_record(&format!("{what} is not a name")),
    }
}

fn read_pinned(v: Value, what: &str) -> R<Name> {
    let n = read_name(v, what)?;
    if n.as_str().contains('@') {
        Ok(n)
    } else {
        refuse("name-not-pinned", format!("{what}: {}", n.as_str()))
    }
}

/// A hash as a record holds it: 34 bytes, SHA-256's code and length, then the digest (T3 rule 9).
fn read_hash(v: Value, what: &str) -> R<Vec<u8>> {
    let b = read_bytes(v, what)?;
    if b.len() == 34 && b[0] == crate::ids::SHA2_256 && b[1] == 32 {
        Ok(b)
    } else {
        not_record(&format!("{what} is not a SHA-256 multihash"))
    }
}

/// An id, `[h'<scope>', counter]` (T3 rule 3).
pub fn read_id(v: &Value) -> R<Id> {
    match v {
        Value::Array(a) if a.len() == 2 => {
            let Value::Bytes(s) = &a[0] else {
                return not_record("an id's scope is not bytes");
            };
            let scope: [u8; 16] = s
                .as_slice()
                .try_into()
                .or_else(|_| not_record("an id's scope is not 16 bytes"))?;
            let counter = read_uint(&a[1], "an id's counter")?;
            Id::new(Scope(scope), counter)
                .map_or_else(|| refuse("int-out-of-range", "an id's counter"), Ok)
        }
        _ => not_record("an id is not [scope, counter]"),
    }
}

fn read_vec3(v: &Value, what: &str) -> R<Vec3> {
    match v {
        Value::Array(a) if a.len() == 3 => Ok(Vec3::new(
            read_int(&a[0], what)?,
            read_int(&a[1], what)?,
            read_int(&a[2], what)?,
        )),
        _ => not_record(&format!("{what} is not [x, y, z]")),
    }
}

fn vec3(v: Vec3) -> Value {
    Value::Array(vec![int(v.x), int(v.y), int(v.z)])
}

fn pose_refusal(r: crate::pose::PoseRefusal) -> Refusal {
    Refusal {
        name: r.name(),
        detail: "a pose (v2/docs/pose.md)".into(),
    }
}

/// A pose as T4 writes it, `{1: frame, 2: position, 3: orientation, 4: support}`, checked as T4 checks it, and in
/// its one byte form (a quaternion that breaks the sign rule, say, is refused).
pub fn read_pose(v: &Value) -> R<Pose> {
    let Value::Map(m) = v else {
        return not_record("a pose is not a map");
    };
    if m.keys().copied().ne(1..=4) {
        return not_record("a pose has fields 1 to 4");
    }
    let frame = match &m[&1] {
        Value::Array(a) if a.len() == 1 || a.len() == 2 => Frame {
            node: read_id(&a[0])?,
            slot: a.get(1).map(|s| read_uint(s, "a slot")).transpose()?,
        },
        _ => return not_record("a frame is not [node] or [node, slot]"),
    };
    let q = match &m[&3] {
        Value::Array(a) if a.len() == 4 => Quat::new(
            read_int(&a[0], "an orientation")?,
            read_int(&a[1], "an orientation")?,
            read_int(&a[2], "an orientation")?,
            read_int(&a[3], "an orientation")?,
        )
        .map_err(pose_refusal)?,
        _ => return not_record("an orientation is not [w, x, y, z]"),
    };
    let Value::Map(s) = &m[&4] else {
        return not_record("a support is not a map");
    };
    let node = |k| {
        s.get(&k)
            .map_or_else(|| not_record("a support lacks its node"), read_id)
    };
    let support = match s.get(&1).map(|w| read_uint(w, "a support")).transpose()? {
        Some(0) => Support::None,
        Some(1) => Support::Surface {
            surface: node(2)?,
            height: s.get(&3).map_or_else(
                || not_record("a surface lacks its height"),
                |h| read_int(h, "a height"),
            )?,
        },
        Some(2) => Support::Slot,
        Some(3) => Support::Volume { volume: node(2)? },
        Some(4) => Support::Track,
        _ => return not_record("a support's kind is 0 to 4"),
    };
    let pose = Pose {
        frame,
        position: read_vec3(&m[&2], "a position")?,
        orientation: q,
        support,
    };
    pose.check().map_err(pose_refusal)?;
    if pose.to_value() != *v {
        return not_record("a pose not in its one byte form");
    }
    Ok(pose)
}

fn read_audience(v: Value) -> R<Audience> {
    let mut r = Rec::of(v, "an audience")?;
    let a = match read_uint(&r.take(1, "an audience")?, "an audience")? {
        1 => Audience::Everyone,
        2 => Audience::Of(read_id(&r.take(2, "an audience")?)?),
        _ => return not_record("an audience is 1 everyone or 2 an id"),
    };
    r.closed("an audience")?;
    Ok(a)
}

fn audience(a: Audience) -> Value {
    match a {
        Audience::Everyone => record(vec![(1, Value::Uint(1))], &Rest::new()),
        Audience::Of(id) => record(vec![(1, Value::Uint(2)), (2, id.to_value())], &Rest::new()),
    }
}

// --- The envelope -------------------------------------------------------------------------------------------------

/// What caused an effect (rule 6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    /// An intent, by its id (T10).
    Intent(Id),
    /// An earlier effect in this zone's log, by its sequence: the timer it set, the transfer it began.
    Effect(u64),
    /// The world's own rule: a start, a time effect, a wind-down.
    World,
}

/// Who acted (rule 6): a Soul, a creator named by a principal id (never an account id, T8), or the world. A creator
/// driving a body the world owns is the creator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Actor {
    Soul(Id),
    Creator(Id),
    World,
}

/// An effect's envelope (rule 6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Envelope {
    /// The effect's place in its zone's log (T3 rule 8). The log is ordered by this alone.
    pub sequence: u64,
    /// The world time it happened, in T5's microseconds: inside a tick, the microsecond it was due.
    pub at: Micros,
    pub cause: Cause,
    pub actor: Actor,
    /// Who may see the effect: everyone, or an audience id (T8).
    pub audience: Audience,
    /// The node whose system wrote it; for a link, the owning end's node.
    pub node: Id,
}

fn read_cause(v: Value) -> R<Cause> {
    let mut r = Rec::of(v, "a cause")?;
    let c = match read_uint(&r.take(1, "a cause")?, "a cause")? {
        1 => Cause::Intent(read_id(&r.take(2, "a cause")?)?),
        2 => Cause::Effect(read_uint(&r.take(2, "a cause")?, "a cause's sequence")?),
        3 => Cause::World,
        _ => return not_record("a cause is 1 an intent, 2 an effect or 3 the world"),
    };
    r.closed("a cause")?;
    Ok(c)
}

fn cause(c: Cause) -> Value {
    let pairs = match c {
        Cause::Intent(id) => vec![(1, Value::Uint(1)), (2, id.to_value())],
        Cause::Effect(n) => vec![(1, Value::Uint(2)), (2, Value::Uint(n))],
        Cause::World => vec![(1, Value::Uint(3))],
    };
    record(pairs, &Rest::new())
}

fn read_actor(v: Value) -> R<Actor> {
    let mut r = Rec::of(v, "an actor")?;
    let a = match read_uint(&r.take(1, "an actor")?, "an actor")? {
        1 => Actor::Soul(read_id(&r.take(2, "an actor")?)?),
        2 => Actor::Creator(read_id(&r.take(2, "an actor")?)?),
        3 => Actor::World,
        _ => return not_record("an actor is 1 a Soul, 2 a creator or 3 the world"),
    };
    r.closed("an actor")?;
    Ok(a)
}

fn actor(a: Actor) -> Value {
    let pairs = match a {
        Actor::Soul(id) => vec![(1, Value::Uint(1)), (2, id.to_value())],
        Actor::Creator(id) => vec![(1, Value::Uint(2)), (2, id.to_value())],
        Actor::World => vec![(1, Value::Uint(3))],
    };
    record(pairs, &Rest::new())
}

// --- The generic changes ------------------------------------------------------------------------------------------

/// The closed list of generic changes (rule 3). Any future viewer applies these and nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    /// 1. A node, with its kind (pinned), its pose (whose frame is its parent and slot), its audience (fixed for its
    ///    life) and its fields.
    Create {
        node: Id,
        kind: Name,
        pose: Pose,
        audience: Audience,
        fields: BTreeMap<u64, Value>,
    },
    /// 2. A node, its subtree and every link with an end in them (T2 rule 3).
    Remove { node: Id },
    /// 3. A node moves from one parent and slot (`from`) into the frame of `pose`: the new parent and slot.
    Reparent { node: Id, from: Frame, pose: Pose },
    /// 4. A field's value. `by`, when the value is an amount moved, is the signed amount (SA-F2b): kept, never needed
    ///    to apply.
    Set {
        node: Id,
        field: u64,
        to: Value,
        by: Option<i64>,
    },
    /// 5. A typed link (T2 rule 7).
    Link {
        link: Id,
        ty: Name,
        ends: [Id; 2],
        owner: End,
        audience: Audience,
    },
    /// 6. A link ends.
    Unlink { link: Id },
    /// 7. A motion sample: T4's hand-off record as T4 writes it (pose.md rule 13), `{1: node, 2: at, 3: from,
    ///    4: to, 5: pose, 6: linear, 7: angular}`, where `from` and `to` are T4's owner records (equal when the owner
    ///    does not change) and the pose is in the node's frame, which is its parent and slot.
    Motion(Sample),
}

/// T4's hand-off record, read by this layer (the owners are kept as T4 wrote them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sample {
    pub node: Id,
    pub at: Micros,
    pub from: Value,
    pub to: Value,
    pub pose: Pose,
    pub linear: Vec3,
    pub angular: Vec3,
}

impl Sample {
    /// A hand-off record, `{1: node, 2: at, 3: from, 4: to, 5: pose, 6: linear, 7: angular}`, in its one byte form.
    pub fn read(v: Value) -> R<Sample> {
        let mut r = Rec::of(v, "a motion sample")?;
        let owner = |o: Value| match o {
            Value::Map(_) => Ok(o),
            _ => not_record("a motion owner is T4's owner record"),
        };
        let s = Sample {
            node: read_id(&r.take(1, "a motion sample")?)?,
            at: read_int(&r.take(2, "a motion sample")?, "a sample's time")?,
            from: owner(r.take(3, "a motion sample")?)?,
            to: owner(r.take(4, "a motion sample")?)?,
            pose: read_pose(&r.take(5, "a motion sample")?)?,
            linear: read_vec3(&r.take(6, "a motion sample")?, "a linear velocity")?,
            angular: read_vec3(&r.take(7, "a motion sample")?, "an angular velocity")?,
        };
        r.closed("a motion sample")?;
        Ok(s)
    }

    pub fn to_value(&self) -> Value {
        record(
            vec![
                (1, self.node.to_value()),
                (2, int(self.at)),
                (3, self.from.clone()),
                (4, self.to.clone()),
                (5, self.pose.to_value()),
                (6, vec3(self.linear)),
                (7, vec3(self.angular)),
            ],
            &Rest::new(),
        )
    }
}

/// A change and the fields of it this build does not know.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeRec {
    pub change: Change,
    pub rest: Rest,
}

impl ChangeRec {
    fn read(v: Value) -> R<ChangeRec> {
        let mut r = Rec::of(v, "a change")?;
        let which = read_uint(&r.take(1, "a change")?, "a change's kind")?;
        let id = |r: &mut Rec, k| read_id(&r.take(k, "a change")?);
        let change = match which {
            1 => Change::Create {
                node: id(&mut r, 2)?,
                kind: read_pinned(r.take(3, "a create")?, "a create's kind")?,
                pose: read_pose(&r.take(4, "a create")?)?,
                audience: read_audience(r.take(5, "a create")?)?,
                fields: read_map(r.take(6, "a create")?, "a create's fields")?,
            },
            2 => Change::Remove {
                node: id(&mut r, 2)?,
            },
            3 => Change::Reparent {
                node: id(&mut r, 2)?,
                from: match read_array(r.take(3, "a reparent")?, "a reparent's old frame")?
                    .as_slice()
                {
                    [n] => Frame {
                        node: read_id(n)?,
                        slot: None,
                    },
                    [n, s] => Frame {
                        node: read_id(n)?,
                        slot: Some(read_uint(s, "a slot")?),
                    },
                    _ => return not_record("an old frame is [node] or [node, slot]"),
                },
                pose: read_pose(&r.take(4, "a reparent")?)?,
            },
            4 => Change::Set {
                node: id(&mut r, 2)?,
                field: read_uint(&r.take(3, "a set")?, "a field number")?,
                to: r.take(4, "a set")?,
                by: r.opt(5).map(|b| read_int(&b, "a set's by")).transpose()?,
            },
            5 => Change::Link {
                link: id(&mut r, 2)?,
                ty: read_name(r.take(3, "a link")?, "a link's type")?,
                ends: match read_array(r.take(4, "a link")?, "a link's ends")?.as_slice() {
                    [a, b] => [read_id(a)?, read_id(b)?],
                    _ => return not_record("a link has two ends"),
                },
                owner: match read_uint(&r.take(5, "a link")?, "a link's owning end")? {
                    0 => End::First,
                    1 => End::Second,
                    _ => return not_record("a link's owning end is 0 or 1"),
                },
                audience: read_audience(r.take(6, "a link")?)?,
            },
            6 => Change::Unlink {
                link: id(&mut r, 2)?,
            },
            7 => Change::Motion(Sample::read(r.take(2, "a motion change")?)?),
            n => return refuse("change-unknown", format!("change {n}")),
        };
        Ok(ChangeRec { change, rest: r.0 })
    }

    pub fn to_value(&self) -> Value {
        let u = Value::Uint;
        let pairs = match &self.change {
            Change::Create {
                node,
                kind,
                pose,
                audience: a,
                fields,
            } => vec![
                (1, u(1)),
                (2, node.to_value()),
                (3, Value::Text(kind.clone())),
                (4, pose.to_value()),
                (5, audience(*a)),
                (6, Value::Map(fields.clone())),
            ],
            Change::Remove { node } => vec![(1, u(2)), (2, node.to_value())],
            Change::Reparent { node, from, pose } => {
                let mut f = vec![from.node.to_value()];
                f.extend(from.slot.map(u));
                vec![
                    (1, u(3)),
                    (2, node.to_value()),
                    (3, Value::Array(f)),
                    (4, pose.to_value()),
                ]
            }
            Change::Set {
                node,
                field,
                to,
                by,
            } => {
                let mut p = vec![
                    (1, u(4)),
                    (2, node.to_value()),
                    (3, u(*field)),
                    (4, to.clone()),
                ];
                p.extend(by.map(|b| (5, int(b))));
                p
            }
            Change::Link {
                link,
                ty,
                ends,
                owner,
                audience: a,
            } => vec![
                (1, u(5)),
                (2, link.to_value()),
                (3, Value::Text(ty.clone())),
                (
                    4,
                    Value::Array(vec![ends[0].to_value(), ends[1].to_value()]),
                ),
                (5, u(u64::from(*owner == End::Second))),
                (6, audience(*a)),
            ],
            Change::Unlink { link } => vec![(1, u(6)), (2, link.to_value())],
            Change::Motion(sample) => vec![(1, u(7)), (2, sample.to_value())],
        };
        record(pairs, &self.rest)
    }
}

// --- Named events, effects, parts and the header ------------------------------------------------------------------

/// A named event (rule 4): a name and numbered fields saying what the changes meant, and which of the effect's
/// changes it explains. It adds no state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    pub name: Name,
    pub fields: BTreeMap<u64, Value>,
    pub changes: Vec<u64>,
    pub rest: Rest,
}

impl Event {
    fn read(v: Value) -> R<Event> {
        let mut r = Rec::of(v, "an event")?;
        let name = read_name(r.take(1, "an event")?, "an event's name")?;
        let fields = r
            .opt(2)
            .map(|f| read_map(f, "an event's fields"))
            .transpose()?;
        let changes = match r.opt(3) {
            Some(c) => read_array(c, "an event's changes")?
                .iter()
                .map(|i| read_uint(i, "a change's index"))
                .collect::<R<Vec<_>>>()?,
            None => Vec::new(),
        };
        Ok(Event {
            name,
            fields: fields.unwrap_or_default(),
            changes,
            rest: r.0,
        })
    }

    pub fn to_value(&self) -> Value {
        let mut p = vec![(1, Value::Text(self.name.clone()))];
        if !self.fields.is_empty() {
            p.push((2, Value::Map(self.fields.clone())));
        }
        if !self.changes.is_empty() {
            p.push((
                3,
                Value::Array(self.changes.iter().map(|i| Value::Uint(*i)).collect()),
            ));
        }
        record(p, &self.rest)
    }
}

/// An effect (rules 1 and 2): its envelope, its generic changes, applied in order and all or none, and its named
/// events, which may be stripped without changing any state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Effect {
    pub envelope: Envelope,
    pub changes: Vec<ChangeRec>,
    pub events: Option<Vec<Event>>,
    pub rest: Rest,
}

impl Effect {
    fn read(v: Value) -> R<Effect> {
        let mut r = Rec::of(v, "an effect")?;
        let envelope = Envelope {
            sequence: read_uint(&r.take(1, "an effect")?, "a sequence")?,
            at: read_int(&r.take(2, "an effect")?, "a world time")?,
            cause: read_cause(r.take(3, "an effect")?)?,
            actor: read_actor(r.take(4, "an effect")?)?,
            audience: read_audience(r.take(5, "an effect")?)?,
            node: read_id(&r.take(6, "an effect")?)?,
        };
        let changes = read_array(r.take(7, "an effect")?, "an effect's changes")?
            .into_iter()
            .map(ChangeRec::read)
            .collect::<R<Vec<_>>>()?;
        let events = match r.opt(8) {
            Some(e) => Some(
                read_array(e, "an effect's events")?
                    .into_iter()
                    .map(Event::read)
                    .collect::<R<Vec<_>>>()?,
            ),
            None => None,
        };
        for ev in events.iter().flatten() {
            if let Some(i) = ev.changes.iter().find(|i| **i >= changes.len() as u64) {
                return not_record(&format!(
                    "event {} names change {i} of {}",
                    ev.name.as_str(),
                    changes.len()
                ));
            }
        }
        Ok(Effect {
            envelope,
            changes,
            events,
            rest: r.0,
        })
    }

    pub fn to_value(&self) -> Value {
        let e = &self.envelope;
        let mut p = vec![
            (1, Value::Uint(e.sequence)),
            (2, int(e.at)),
            (3, cause(e.cause)),
            (4, actor(e.actor)),
            (5, audience(e.audience)),
            (6, e.node.to_value()),
            (
                7,
                Value::Array(self.changes.iter().map(ChangeRec::to_value).collect()),
            ),
        ];
        if let Some(events) = &self.events {
            p.push((
                8,
                Value::Array(events.iter().map(Event::to_value).collect()),
            ));
        }
        record(p, &self.rest)
    }
}

/// A bundle's header (rule 7): the build, the schema by hash, the zone's lineage, zone and epoch, and the kinds and
/// move revisions its effects rest on, pinned by hash. Written once per bundle; each part names it by hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    pub build: Vec<u8>,
    pub schema: Vec<u8>,
    pub lineage: Scope,
    pub zone: Id,
    pub epoch: u64,
    pub kinds: Vec<Name>,
    pub moves: Vec<Name>,
    pub rest: Rest,
    stored: Vec<u8>,
}

impl Header {
    /// The header these stored bytes hold. The bytes are kept: the header's hash is over them.
    pub fn read(bytes: &[u8]) -> R<Header> {
        let v = decode(bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let mut r = Rec::of(v, "a header")?;
        let names = |v: Value, what| {
            read_array(v, what)?
                .into_iter()
                .map(|n| read_pinned(n, what))
                .collect::<R<Vec<_>>>()
        };
        let lineage: [u8; 16] = read_bytes(r.take(3, "a header")?, "a lineage")?
            .as_slice()
            .try_into()
            .or_else(|_| not_record("a lineage is 16 bytes"))?;
        Ok(Header {
            build: read_hash(r.take(1, "a header")?, "a build")?,
            schema: read_hash(r.take(2, "a header")?, "a schema")?,
            lineage: Scope(lineage),
            zone: read_id(&r.take(4, "a header")?)?,
            epoch: read_uint(&r.take(5, "a header")?, "an epoch")?,
            kinds: names(r.take(6, "a header")?, "a header's kinds")?,
            moves: names(r.take(7, "a header")?, "a header's moves")?,
            rest: std::mem::take(&mut r.0),
            stored: bytes.to_vec(),
        })
    }

    pub fn to_value(&self) -> Value {
        let names = |l: &[Name]| Value::Array(l.iter().cloned().map(Value::Text).collect());
        record(
            vec![
                (1, Value::Bytes(self.build.clone())),
                (2, Value::Bytes(self.schema.clone())),
                (3, Value::Bytes(self.lineage.0.to_vec())),
                (4, self.zone.to_value()),
                (5, Value::Uint(self.epoch)),
                (6, names(&self.kinds)),
                (7, names(&self.moves)),
            ],
            &self.rest,
        )
    }

    pub fn stored(&self) -> &[u8] {
        &self.stored
    }

    /// The `souls/header/1` hash of the stored bytes, which every part of the bundle names.
    pub fn hash(&self) -> Hash {
        Hash::of(Purpose::Header, &self.stored)
    }
}

/// A part of a bundle (rule 7): its header's hash and effects in sequence order. Its stored bytes are kept whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub header: Vec<u8>,
    pub effects: Vec<Effect>,
    pub rest: Rest,
    stored: Vec<u8>,
}

impl Part {
    pub fn read(bytes: &[u8]) -> R<Part> {
        let v = decode(bytes)
            .or_else(|e| refuse("encoding", e.to_string()))?
            .value;
        let mut r = Rec::of(v, "a part")?;
        let header = read_hash(r.take(1, "a part")?, "a part's header")?;
        let effects = read_array(r.take(2, "a part")?, "a part's effects")?
            .into_iter()
            .map(Effect::read)
            .collect::<R<Vec<_>>>()?;
        let part = Part {
            header,
            effects,
            rest: r.0,
            stored: bytes.to_vec(),
        };
        if let Some(t) = texts(&part.to_value()).into_iter().find(|t| !is_name(t)) {
            return refuse("text-not-a-name", t);
        }
        Ok(part)
    }

    pub fn to_value(&self) -> Value {
        record(
            vec![
                (1, Value::Bytes(self.header.clone())),
                (
                    2,
                    Value::Array(self.effects.iter().map(Effect::to_value).collect()),
                ),
            ],
            &self.rest,
        )
    }

    pub fn stored(&self) -> &[u8] {
        &self.stored
    }

    /// The same part with every named event left out, as new bytes (rule 4: the state it leaves is the same).
    pub fn strip_events(&self) -> R<Part> {
        let mut p = self.clone();
        for e in &mut p.effects {
            e.events = None;
        }
        let bytes = encode(&p.to_value()).or_else(|e| refuse("encoding", e.to_string()))?;
        Part::read(&bytes)
    }
}

/// Every text item in a value, depth first. Each must be a name (rule 10).
pub fn texts(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![v];
    while let Some(v) = stack.pop() {
        match v {
            Value::Text(t) => out.push(t.as_str().to_owned()),
            Value::Array(a) => stack.extend(a.iter().rev()),
            Value::Map(m) => stack.extend(m.values().rev()),
            _ => {}
        }
    }
    out
}

/// The layout this page fixes, as a value: each change's number, name and field numbers, then the envelope's,
/// an event's, a part's and a header's field numbers. Its `souls/schema/1` hash is what a header names.
pub fn schema() -> Value {
    let row = |n: u64, name: &str, fields: &[u64]| {
        Value::Array(vec![
            Value::Uint(n),
            Value::Text(Name::new(name).unwrap_or_else(|| unreachable!("a plain name"))),
            Value::Array(fields.iter().map(|f| Value::Uint(*f)).collect()),
        ])
    };
    Value::Array(vec![
        row(1, "create", &[2, 3, 4, 5, 6]),
        row(2, "remove", &[2]),
        row(3, "reparent", &[2, 3, 4]),
        row(4, "set", &[2, 3, 4, 5]),
        row(5, "link", &[2, 3, 4, 5, 6]),
        row(6, "unlink", &[2]),
        row(7, "motion", &[2]),
        row(0, "motion-sample", &[1, 2, 3, 4, 5, 6, 7]),
        row(0, "effect", &[1, 2, 3, 4, 5, 6, 7, 8]),
        row(0, "event", &[1, 2, 3]),
        row(0, "part", &[1, 2]),
        row(0, "header", &[1, 2, 3, 4, 5, 6, 7]),
    ])
}

/// The `souls/schema/1` hash of [`schema`].
pub fn schema_hash() -> Hash {
    Hash::of(
        Purpose::Schema,
        &encode(&schema()).unwrap_or_else(|_| unreachable!("the schema is shallow")),
    )
}

// --- State and applying -------------------------------------------------------------------------------------------

/// A node as the generic changes leave it. Its pose is kept without its frame, which is its parent and slot (T4
/// rule 1), as `{2: position, 3: orientation, 4: support}`; its motion as `{1: at, 2: linear, 3: angular, 4: owner}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeState {
    pub kind: Name,
    pub parent: Option<Id>,
    pub slot: Option<u64>,
    pub audience: Audience,
    pub fields: BTreeMap<u64, Value>,
    pub place: Option<Value>,
    pub motion: Option<Value>,
}

/// A link as the generic changes leave it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkState {
    pub ty: Name,
    pub ends: [Id; 2],
    pub owner: End,
    pub audience: Audience,
}

/// One zone's state, from its start and the parts applied since: no kinds are needed to apply a part (rule 5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub next: u64,
    pub nodes: BTreeMap<Id, NodeState>,
    pub links: BTreeMap<Id, LinkState>,
}

fn place(pose: &Pose) -> Value {
    match pose.to_value() {
        Value::Map(mut m) => {
            m.remove(&1);
            Value::Map(m)
        }
        _ => unreachable!("a pose is a map"),
    }
}

impl State {
    /// A zone's state at its start: its root node alone (T1's start record carries the rest).
    pub fn start(root: Id, kind: Name) -> State {
        let node = NodeState {
            kind,
            parent: None,
            slot: None,
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
            place: None,
            motion: None,
        };
        State {
            next: 0,
            nodes: [(root, node)].into(),
            links: BTreeMap::new(),
        }
    }

    /// Applies a part: all of it or none. It must name `header` by hash, and its effects must follow the state's
    /// last sequence, one by one.
    pub fn apply(&mut self, header: &Header, part: &Part) -> R<()> {
        if part.header != header.hash().to_bytes() {
            return refuse("header-mismatch", "the part names another header");
        }
        let mut s = self.clone();
        for e in &part.effects {
            s.apply_effect(header, e)?;
        }
        *self = s;
        Ok(())
    }

    fn apply_effect(&mut self, header: &Header, e: &Effect) -> R<()> {
        if e.envelope.sequence != self.next {
            return refuse(
                "sequence-gap",
                format!("effect {} after {}", e.envelope.sequence, self.next),
            );
        }
        for c in &e.changes {
            self.apply_change(header, &c.change)?;
        }
        self.next += 1;
        Ok(())
    }

    fn node(&self, id: Id) -> R<&NodeState> {
        self.nodes
            .get(&id)
            .map_or_else(|| refuse("node-missing", show(id)), Ok)
    }

    fn fresh(&self, id: Id) -> R<()> {
        if self.nodes.contains_key(&id) || self.links.contains_key(&id) {
            refuse("id-duplicate", show(id))
        } else {
            Ok(())
        }
    }

    /// How many ancestors `id` has, walked up with a loop; more than T2's 32 is refused, and so is a chain that
    /// comes back to itself.
    fn depth(&self, id: Id) -> R<u32> {
        let mut at = id;
        let mut n = 0;
        while let Some(p) = self.node(at)?.parent {
            n += 1;
            if p == id {
                return refuse("tree-cycle", show(id));
            }
            if n > DEPTH_LIMIT {
                return refuse("depth-over-limit", show(id));
            }
            at = p;
        }
        Ok(n)
    }

    /// `id` and every node below it.
    fn subtree(&self, id: Id) -> R<BTreeSet<Id>> {
        let mut out = BTreeSet::new();
        for n in self.nodes.keys() {
            let mut at = Some(*n);
            for _ in 0..=DEPTH_LIMIT + 1 {
                match at {
                    Some(a) if a == id => {
                        out.insert(*n);
                        break;
                    }
                    Some(a) => at = self.node(a)?.parent,
                    None => break,
                }
            }
        }
        Ok(out)
    }

    fn apply_change(&mut self, header: &Header, c: &Change) -> R<()> {
        match c {
            Change::Create {
                node,
                kind,
                pose,
                audience,
                fields,
            } => {
                self.fresh(*node)?;
                if !header.kinds.contains(kind) {
                    return refuse("kind-not-in-header", kind.as_str());
                }
                self.node(pose.frame.node)
                    .or_else(|_| refuse("parent-missing", show(pose.frame.node)))?;
                self.nodes.insert(
                    *node,
                    NodeState {
                        kind: kind.clone(),
                        parent: Some(pose.frame.node),
                        slot: pose.frame.slot,
                        audience: *audience,
                        fields: fields.clone(),
                        place: Some(place(pose)),
                        motion: None,
                    },
                );
                self.depth(*node)?;
            }
            Change::Remove { node } => {
                self.node(*node)?;
                let gone = self.subtree(*node)?;
                self.nodes.retain(|id, _| !gone.contains(id));
                self.links
                    .retain(|_, l| !gone.contains(&l.ends[0]) && !gone.contains(&l.ends[1]));
            }
            Change::Reparent { node, from, pose } => {
                let n = self.node(*node)?;
                if n.parent != Some(from.node) || n.slot != from.slot {
                    return refuse(
                        "frame-mismatch",
                        format!("{} is not where the reparent says", show(*node)),
                    );
                }
                self.node(pose.frame.node)
                    .or_else(|_| refuse("parent-missing", show(pose.frame.node)))?;
                let moved = self.subtree(*node)?;
                if moved.contains(&pose.frame.node) {
                    return refuse("tree-cycle", show(*node));
                }
                let n = self
                    .nodes
                    .get_mut(node)
                    .unwrap_or_else(|| unreachable!("read above"));
                n.parent = Some(pose.frame.node);
                n.slot = pose.frame.slot;
                n.place = Some(place(pose));
                n.motion = None;
                for m in moved {
                    self.depth(m)?;
                }
            }
            Change::Set {
                node, field, to, ..
            } => {
                self.node(*node)?;
                if let Some(n) = self.nodes.get_mut(node) {
                    n.fields.insert(*field, to.clone());
                }
            }
            Change::Link {
                link,
                ty,
                ends,
                owner,
                audience,
            } => {
                self.fresh(*link)?;
                let owning = ends[usize::from(*owner == End::Second)];
                if !self.nodes.contains_key(&owning) {
                    return refuse("link-owner-not-node", show(owning));
                }
                self.links.insert(
                    *link,
                    LinkState {
                        ty: ty.clone(),
                        ends: *ends,
                        owner: *owner,
                        audience: *audience,
                    },
                );
            }
            Change::Unlink { link } => {
                if self.links.remove(link).is_none() {
                    return refuse("link-missing", show(*link));
                }
            }
            Change::Motion(m) => {
                let n = self.node(m.node)?;
                if n.parent != Some(m.pose.frame.node) || n.slot != m.pose.frame.slot {
                    return refuse(
                        "frame-mismatch",
                        format!(
                            "{}: a motion sample's frame is its parent; a new frame is a reparent",
                            show(m.node)
                        ),
                    );
                }
                let motion = BTreeMap::from([
                    (1, int(m.at)),
                    (2, vec3(m.linear)),
                    (3, vec3(m.angular)),
                    (4, m.to.clone()),
                ]);
                if let Some(n) = self.nodes.get_mut(&m.node) {
                    n.place = Some(place(&m.pose));
                    n.motion = Some(Value::Map(motion));
                }
            }
        }
        Ok(())
    }

    /// The state as one profile value, flat (T0 rule 8): `{1: next, 2: [[id, node], ...], 3: [[id, link], ...]}` in
    /// id order, a node `{1: kind, 2: parent, 3: slot, 4: audience, 5: fields, 6: place, 7: motion}` (2, 3, 6 and 7
    /// when present) and a link `{1: type, 2: [end, end], 3: owning end, 4: audience}`.
    pub fn to_value(&self) -> Value {
        let nodes = self.nodes.iter().map(|(id, n)| {
            let mut m = BTreeMap::from([
                (1, Value::Text(n.kind.clone())),
                (4, audience(n.audience)),
                (5, Value::Map(n.fields.clone())),
            ]);
            m.extend(n.parent.map(|p| (2, p.to_value())));
            m.extend(n.slot.map(|s| (3, Value::Uint(s))));
            m.extend(n.place.clone().map(|p| (6, p)));
            m.extend(n.motion.clone().map(|p| (7, p)));
            Value::Array(vec![id.to_value(), Value::Map(m)])
        });
        let links = self.links.iter().map(|(id, l)| {
            Value::Array(vec![
                id.to_value(),
                Value::Map(BTreeMap::from([
                    (1, Value::Text(l.ty.clone())),
                    (
                        2,
                        Value::Array(vec![l.ends[0].to_value(), l.ends[1].to_value()]),
                    ),
                    (3, Value::Uint(u64::from(l.owner == End::Second))),
                    (4, audience(l.audience)),
                ])),
            ])
        });
        Value::Map(BTreeMap::from([
            (1, Value::Uint(self.next)),
            (2, Value::Array(nodes.collect())),
            (3, Value::Array(links.collect())),
        ]))
    }

    /// The fixtures' state hash: `souls/fixture/1` over the state's bytes. A world's public and private state
    /// hashes (T3 rule 11) are K5's node tree, not this.
    pub fn hash(&self) -> R<Hash> {
        let bytes = encode(&self.to_value()).or_else(|e| refuse("encoding", e.to_string()))?;
        Ok(Hash::of(Purpose::Fixture, &bytes))
    }
}

// --- The fixtures -------------------------------------------------------------------------------------------------

/// The bundle's header, in diagnostic notation.
pub const FIXTURE_HEADER: &str = include_str!("../fixtures/effects/header.diag");

/// The base part (a small world built by generic changes) and then each fixture, applied to the base alone.
pub const FIXTURES: [(&str, &str); 9] = [
    ("0-base", include_str!("../fixtures/effects/0-base.diag")),
    (
        "1-create",
        include_str!("../fixtures/effects/1-create.diag"),
    ),
    (
        "2-remove",
        include_str!("../fixtures/effects/2-remove.diag"),
    ),
    (
        "3-reparent",
        include_str!("../fixtures/effects/3-reparent.diag"),
    ),
    ("4-set", include_str!("../fixtures/effects/4-set.diag")),
    ("5-link", include_str!("../fixtures/effects/5-link.diag")),
    (
        "6-unlink",
        include_str!("../fixtures/effects/6-unlink.diag"),
    ),
    (
        "7-motion",
        include_str!("../fixtures/effects/7-motion.diag"),
    ),
    (
        "8-future",
        include_str!("../fixtures/effects/8-future.diag"),
    ),
];

/// A fixture's bytes: its diagnostic notation, `#` comments left out, in T0's profile.
pub fn fixture_bytes(text: &str) -> R<Vec<u8>> {
    let bare: Vec<&str> = text
        .lines()
        .map(|l| l.split('#').next().unwrap_or(""))
        .collect();
    let v = crate::encode::parse_diagnostic(&bare.join("\n")).or_else(|e| refuse("encoding", e))?;
    encode(&v).or_else(|e| refuse("encoding", e.to_string()))
}

/// What one fixture gave: its part's bytes, whether reading and writing them again gives the same bytes, and the
/// state hash after applying it to the base, with and without its named events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub name: &'static str,
    pub bytes: Vec<u8>,
    pub same_bytes: bool,
    pub state: Hash,
    pub stripped: Hash,
}

/// Reads the header, applies the base, then each fixture to the base: the goldens' inputs.
pub fn run_fixtures() -> R<(Header, Vec<Outcome>)> {
    let header = Header::read(&fixture_bytes(FIXTURE_HEADER)?)?;
    let root_kind = header
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .map_or_else(|| not_record("the header lists the root's kind"), Ok)?;
    let start = State::start(header.zone, root_kind.clone());
    let mut base = start.clone();
    let mut out = Vec::new();
    for (name, text) in FIXTURES {
        let bytes = fixture_bytes(text)?;
        let part = Part::read(&bytes)?;
        let same_bytes = encode(&part.to_value()).is_ok_and(|b| b == bytes);
        let from = if name == "0-base" { &start } else { &base };
        let (mut s, mut t) = (from.clone(), from.clone());
        s.apply(&header, &part)?;
        t.apply(&header, &part.strip_events()?)?;
        out.push(Outcome {
            name,
            bytes,
            same_bytes,
            state: s.hash()?,
            stripped: t.hash()?,
        });
        if name == "0-base" {
            base = s;
        }
    }
    Ok((header, out))
}

/// Step 0: T4's hand-off record (pose.md rule 13) decoded and encoded again by T0's profile, and read as a motion
/// sample by this layer and written back to the same bytes.
pub fn step0() -> R<(String, bool)> {
    let h = crate::pose::hand_offs(1).map_err(pose_refusal)?.last;
    let bytes = crate::encode::from_hex(&h).or_else(|e| refuse("encoding", e))?;
    let v = decode(&bytes)
        .or_else(|e| refuse("encoding", e.to_string()))?
        .value;
    let same = encode(&v).is_ok_and(|b| b == bytes);
    let sample = Sample::read(v)?;
    let read_back = encode(&sample.to_value()).is_ok_and(|b| b == bytes);
    Ok((h, same && read_back))
}

/// The effects goldens, one per line, as `fixtures/effects/goldens.txt` holds them: the native test and the WASM
/// build in Node both compare this with that file. WASM exports it only with the `vectors` feature.
#[cfg_attr(all(target_arch = "wasm32", feature = "vectors"), wasm_bindgen)]
pub fn effects_goldens() -> String {
    let mut lines = Vec::new();
    match goldens(&mut lines) {
        Ok(()) => lines.join("\n") + "\n",
        Err(r) => format!("refused {r}\n"),
    }
}

fn goldens(lines: &mut Vec<String>) -> R<()> {
    let (h, same) = step0()?;
    lines.push(format!(
        "step0 hand-off {h} round-trip {}",
        if same { "same" } else { "DIFFERS" }
    ));
    let (header, outcomes) = run_fixtures()?;
    lines.push(format!("schema {}", schema_hash()));
    lines.push(format!(
        "header {} bytes {}",
        header.hash(),
        to_hex(header.stored())
    ));
    for o in outcomes {
        lines.push(format!(
            "{} part {} {}",
            o.name,
            to_hex(&o.bytes),
            if o.same_bytes {
                "re-encodes-same"
            } else {
                "re-encodes-DIFFERENT"
            }
        ));
        lines.push(format!(
            "{} state {} stripped {}",
            o.name, o.state, o.stripped
        ));
    }
    Ok(())
}
