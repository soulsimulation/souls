//! Ids, names and hashes (contract T3; Engine v2 T3, #2640). The rules are numbered in `v2/docs/ids.md`.
//!
//! An [`Id`] is a minting [`Scope`] (16 random bytes, new for every world and every fork) and a counter below 2^53. A
//! [`Version`] is (lineage, zone, epoch, sequence). A [`Hash`] is written as algorithm code, length and digest, and
//! its input starts with a [`Purpose`] label. A kind is named `namespace:name@hash` ([`KindName`]), where the hash
//! covers the kind's meaning and the kinds it refers to, each by its own name and hash. Every byte comes from the
//! encoding profile ([`crate::encode`]); this module writes no encoding of its own.

use crate::encode::{Name, Value, encode, parse_diagnostic, to_hex};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[cfg(all(target_arch = "wasm32", feature = "vectors"))]
use wasm_bindgen::prelude::wasm_bindgen;

/// Counters stay below 2^53, the largest range a JavaScript number holds exactly (rule 2).
pub const COUNTER_LIMIT: u64 = 1 << 53;

/// Who minted an id: 16 random bytes, new for every world and every fork (rule 1). The bytes come from the caller
/// (the directory, or the operating system's random source); nothing here draws them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Scope(pub [u8; 16]);

/// A node's id: its scope and a counter below [`COUNTER_LIMIT`]. Encoded as `[h'<scope>', counter]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Id {
    scope: Scope,
    counter: u64,
}

impl Id {
    /// The id, or `None` if the counter is not below 2^53.
    pub fn new(scope: Scope, counter: u64) -> Option<Id> {
        (counter < COUNTER_LIMIT).then_some(Id { scope, counter })
    }

    pub fn scope(self) -> Scope {
        self.scope
    }

    pub fn counter(self) -> u64 {
        self.counter
    }

    pub fn to_value(self) -> Value {
        Value::Array(vec![
            Value::Bytes(self.scope.0.to_vec()),
            Value::Uint(self.counter),
        ])
    }
}

/// A scope has given out every counter below 2^53. Refused by name: `id-counter-exhausted`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exhausted(pub Scope);

impl fmt::Display for Exhausted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "id-counter-exhausted: scope {} has no counter left",
            to_hex(&self.0.0)
        )
    }
}

impl std::error::Error for Exhausted {}

/// Gives out ids in one scope, counting up from 0. Every writer that mints has its own: a world's first zone uses the
/// world's scope, and each fork and each further zone writer gets a fresh one (rule 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Minter {
    scope: Scope,
    next: u64,
}

impl Minter {
    /// A minter for a new world, fork or zone writer, with its fresh scope.
    pub fn new(scope: Scope) -> Minter {
        Minter { scope, next: 0 }
    }

    /// The next id. A counter is never given out twice (rule 4).
    pub fn mint(&mut self) -> Result<Id, Exhausted> {
        let id = Id::new(self.scope, self.next).ok_or(Exhausted(self.scope))?;
        self.next = self.next.checked_add(1).ok_or(Exhausted(self.scope))?;
        Ok(id)
    }
}

/// Every id a world has ever held (rule 6): for each scope it minted from or inherited at a fork, the counters below
/// a bound; and each id that arrived from a scope it never minted from. A fork starts with a copy of its parent's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Held {
    below: BTreeMap<Scope, u64>,
    arrived: BTreeSet<Id>,
}

impl Held {
    pub fn knows(&self, id: Id) -> bool {
        self.below.get(&id.scope).is_some_and(|b| id.counter < *b) || self.arrived.contains(&id)
    }

    /// Records an id the world minted.
    pub fn minted(&mut self, id: Id) {
        let bound = self.below.entry(id.scope).or_insert(0);
        *bound = (*bound).max(id.counter + 1);
    }
}

/// A thing that arrived in a world: the id it has there and, if that id is new, the id it came with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Arrived {
    pub id: Id,
    pub origin: Option<Id>,
}

/// The id a thing arriving with `id` gets (rule 6). If the destination has ever held `id`, the thing gets a fresh id
/// from the destination's `minter` and keeps `id` as its origin; otherwise it keeps `id`. Either way `held` records
/// it, so arrivals are applied one after another by the destination's writer.
pub fn arrive(id: Id, held: &mut Held, minter: &mut Minter) -> Result<Arrived, Exhausted> {
    if held.knows(id) {
        let fresh = minter.mint()?;
        held.minted(fresh);
        Ok(Arrived {
            id: fresh,
            origin: Some(id),
        })
    } else {
        held.arrived.insert(id);
        Ok(Arrived { id, origin: None })
    }
}

/// Where a change sits in history (rule 8): the world's lineage (the scope it or its fork was created with), the zone
/// whose log holds it, the writer's epoch and the change's sequence in that zone's log. Encoded as
/// `[h'<lineage>', <zone id>, epoch, sequence]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Version {
    pub lineage: Scope,
    pub zone: Id,
    pub epoch: u64,
    pub sequence: u64,
}

impl Version {
    pub fn to_value(self) -> Value {
        Value::Array(vec![
            Value::Bytes(self.lineage.0.to_vec()),
            self.zone.to_value(),
            Value::Uint(self.epoch),
            Value::Uint(self.sequence),
        ])
    }
}

/// What a hash is of. Its label starts the hash's input, so two purposes never share a hash (rule 10).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// A kind's meaning.
    Kind,
    /// A kind's geometry, which the kind covers by this hash.
    Geometry,
    /// A node's public state.
    StatePublic,
    /// A node's state for one private audience; never shown outside it (rule 11).
    StatePrivate,
    /// The sections that sit beside a kind (looks, words, card, how-tos; rule 15).
    KindBeside,
    /// A log bundle's header, which each of its parts names (contract T6, `v2/docs/effects.md`).
    Header,
    /// The layout of effects a header names (contract T6).
    Schema,
    /// A golden fixture's bytes, and nothing else.
    Fixture,
    /// A view's definition: its level and revision (contract T7, `v2/docs/views.md`).
    View,
    /// A redaction list: the references removed so far (contracts T7 and T8).
    Redactions,
    /// An upload's stored bytes, after its check (G6, #2747, `v2/crates/assets`).
    Upload,
}

impl Purpose {
    pub fn label(self) -> &'static str {
        match self {
            Purpose::Kind => "souls/kind/1",
            Purpose::Geometry => "souls/geometry/1",
            Purpose::StatePublic => "souls/state-public/1",
            Purpose::StatePrivate => "souls/state-private/1",
            Purpose::KindBeside => "souls/kind-beside/1",
            Purpose::Header => "souls/header/1",
            Purpose::Schema => "souls/schema/1",
            Purpose::Fixture => "souls/fixture/1",
            Purpose::View => "souls/view/1",
            Purpose::Redactions => "souls/redactions/1",
            Purpose::Upload => "souls/upload/1",
        }
    }
}

/// The multicodec code of SHA-256 (`sha2-256`, permanent in the multicodec table), the one algorithm so far.
pub const SHA2_256: u8 = 0x12;

/// A SHA-256 hash, written as algorithm code, digest length and digest (a multihash; rule 9).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hash([u8; 32]);

impl Hash {
    /// The hash of `stored` bytes for `purpose`: SHA-256 over the label (one profile text item) and then the bytes.
    pub fn of(purpose: Purpose, stored: &[u8]) -> Hash {
        let label = Name::new(purpose.label()).expect("labels are names");
        let mut input = encode(&Value::Text(label)).expect("a label is one flat item");
        input.extend_from_slice(stored);
        Hash(sha256(&input))
    }

    pub fn digest(self) -> [u8; 32] {
        self.0
    }

    /// Code, length, digest: 34 bytes.
    pub fn to_bytes(self) -> Vec<u8> {
        let mut out = vec![SHA2_256, 32];
        out.extend_from_slice(&self.0);
        out
    }

    pub fn to_value(self) -> Value {
        Value::Bytes(self.to_bytes())
    }
}

/// Lower-case hex of code, length and digest: `1220` and 64 digits.
impl fmt::Display for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&to_hex(&self.to_bytes()))
    }
}

/// SHA-256 (FIPS 180-4), written out so that `replica` needs no dependency and both builds run the same code.
pub fn sha256(input: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    // The message, a 1 bit, zeros, and its length in bits as 64 bits big-endian, to a multiple of 64 bytes. The length
    // goes through u64, never usize (32 bits in WASM).
    let bits = u64::try_from(input.len())
        .ok()
        .and_then(|n| n.checked_mul(8))
        .expect("input under 2^61 bytes");
    let mut msg = input.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 32];
    for (chunk, word) in out.chunks_exact_mut(4).zip(h) {
        chunk.copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// The section holding a kind's `namespace:name`.
pub const SECTION_NAME: u64 = 1;
/// The section listing the kinds a kind refers to, by local number; the rest of the kind names them by that number.
pub const SECTION_REFERENCES: u64 = 10;
/// Sections from this number on sit beside the kind (looks, words, card, how-tos) and are not in its hash (rule 15).
pub const BESIDE_FROM: u64 = 20;

/// A kind as written: a profile map of numbered sections, read from diagnostic notation with `#` comments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KindSource {
    name: String,
    sections: BTreeMap<u64, Value>,
}

impl KindSource {
    /// Reads a kind from its text: diagnostic notation (`v2/docs/encoding.md`), where `#` starts a comment that runs
    /// to the end of the line (`#` is not a name character, so it never sits inside a value).
    pub fn parse(text: &str) -> Result<KindSource, KindRefusal> {
        let bare: String = text
            .lines()
            .map(|line| line.split('#').next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        let refuse = |why: String| KindRefusal::Source(why);
        let Value::Map(sections) = parse_diagnostic(&bare).map_err(refuse)? else {
            return Err(refuse("a kind is a map of sections".into()));
        };
        let name = match sections.get(&SECTION_NAME) {
            Some(Value::Text(n)) if is_kind_name(n.as_str()) => n.as_str().to_owned(),
            _ => return Err(refuse("section 1 is the kind's namespace:name".into())),
        };
        let refs_ok = match sections.get(&SECTION_REFERENCES) {
            None => true,
            Some(Value::Map(refs)) => refs
                .values()
                .all(|r| matches!(r, Value::Text(n) if is_kind_name(n.as_str()))),
            Some(_) => false,
        };
        if !refs_ok {
            return Err(refuse(format!(
                "{name}: section 10 maps numbers to namespace:name"
            )));
        }
        Ok(KindSource { name, sections })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    fn references(&self) -> Vec<&str> {
        match self.sections.get(&SECTION_REFERENCES) {
            Some(Value::Map(refs)) => refs
                .values()
                .filter_map(|r| match r {
                    Value::Text(n) => Some(n.as_str()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }
}

/// `namespace:name`, lower case as SA-F1 has it: a namespace of `a-z 0-9 -` and a name of `a-z 0-9 _`, each starting
/// with a letter (rule 12).
fn is_kind_name(text: &str) -> bool {
    let part = |p: &str, extra: u8| {
        p.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
            && p.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == extra)
    };
    matches!(text.split_once(':'), Some((ns, n)) if part(ns, b'-') && part(n, b'_'))
}

/// A kind's full name, `namespace:name@hash`, the bytes its hash covers, and the `souls/kind-beside/1` hash of the
/// sections beside it, if it has any.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KindName {
    pub name: String,
    pub hash: Hash,
    pub meaning: Vec<u8>,
    pub beside: Option<Hash>,
}

impl fmt::Display for KindName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}@{}", self.name, self.hash)
    }
}

/// Why a set of kinds could not be named. Each has its own name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KindRefusal {
    /// `kind-source`: the text is not a kind.
    Source(String),
    /// `kind-duplicate`: two kinds in one set share a `namespace:name`.
    Duplicate(String),
    /// `kind-unknown-reference`: a kind refers to one the set does not hold.
    UnknownReference { kind: String, reference: String },
    /// `kind-circular`: kinds refer to each other in a circle, listed from the first back to it (rule 17).
    Circular(Vec<String>),
}

impl KindRefusal {
    pub fn name(&self) -> &'static str {
        match self {
            KindRefusal::Source(_) => "kind-source",
            KindRefusal::Duplicate(_) => "kind-duplicate",
            KindRefusal::UnknownReference { .. } => "kind-unknown-reference",
            KindRefusal::Circular(_) => "kind-circular",
        }
    }
}

impl fmt::Display for KindRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: ", self.name())?;
        match self {
            KindRefusal::Source(why) => f.write_str(why),
            KindRefusal::Duplicate(n) => write!(f, "{n} twice"),
            KindRefusal::UnknownReference { kind, reference } => {
                write!(f, "{kind} refers to {reference}, which is not loaded")
            }
            KindRefusal::Circular(path) => f.write_str(&path.join(" -> ")),
        }
    }
}

impl std::error::Error for KindRefusal {}

/// Names every kind in `kinds`: each one's hash covers its meaning (every section below [`BESIDE_FROM`], name
/// included), with each kind it refers to written as that kind's `namespace:name@hash` (rules 12 and 14).
pub fn name_kinds(kinds: &[KindSource]) -> Result<BTreeMap<String, KindName>, KindRefusal> {
    let mut by_name = BTreeMap::new();
    for k in kinds {
        if by_name.insert(k.name.as_str(), k).is_some() {
            return Err(KindRefusal::Duplicate(k.name.clone()));
        }
    }
    let mut named = BTreeMap::new();
    for k in kinds {
        name_one(k, &by_name, &mut Vec::new(), &mut named)?;
    }
    Ok(named)
}

fn name_one(
    kind: &KindSource,
    by_name: &BTreeMap<&str, &KindSource>,
    path: &mut Vec<String>,
    named: &mut BTreeMap<String, KindName>,
) -> Result<(), KindRefusal> {
    if named.contains_key(&kind.name) {
        return Ok(());
    }
    if let Some(at) = path.iter().position(|n| *n == kind.name) {
        let mut circle = path[at..].to_vec();
        circle.push(kind.name.clone());
        return Err(KindRefusal::Circular(circle));
    }
    path.push(kind.name.clone());
    for r in kind.references() {
        let target = by_name
            .get(r)
            .ok_or_else(|| KindRefusal::UnknownReference {
                kind: kind.name.clone(),
                reference: r.to_owned(),
            })?;
        name_one(target, by_name, path, named)?;
    }
    path.pop();
    let mut meaning: BTreeMap<u64, Value> = kind
        .sections
        .range(..BESIDE_FROM)
        .map(|(k, v)| (*k, v.clone()))
        .collect();
    if let Some(Value::Map(refs)) = meaning.get_mut(&SECTION_REFERENCES) {
        for r in refs.values_mut() {
            if let Value::Text(n) = r {
                let full = named[n.as_str()].to_string();
                *r = Value::Text(Name::new(&full).expect("a full kind name is a name"));
            }
        }
    }
    let encoded =
        |v: Value| encode(&v).map_err(|e| KindRefusal::Source(format!("{}: {e}", kind.name)));
    let meaning = encoded(Value::Map(meaning))?;
    let hash = Hash::of(Purpose::Kind, &meaning);
    let beside: BTreeMap<u64, Value> = kind
        .sections
        .range(BESIDE_FROM..)
        .map(|(k, v)| (*k, v.clone()))
        .collect();
    let beside = match beside.is_empty() {
        true => None,
        false => Some(Hash::of(Purpose::KindBeside, &encoded(Value::Map(beside))?)),
    };
    named.insert(
        kind.name.clone(),
        KindName {
            name: kind.name.clone(),
            hash,
            meaning,
            beside,
        },
    );
    Ok(())
}

/// A node in the fork-then-travel fixture: its id and, if it arrived under a new id, the id it came with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FixtureNode {
    pub id: Id,
    pub origin: Option<Id>,
    pub body: bool,
}

impl FixtureNode {
    fn to_value(self) -> Value {
        let mut m = BTreeMap::from([(1, self.id.to_value())]);
        if let Some(o) = self.origin {
            m.insert(2, o.to_value());
        }
        Value::Map(m)
    }
}

/// The scopes of the fixture's world A and its fork B. Real scopes are random; these are spelled out to be read.
pub const FIXTURE_SCOPE_A: Scope = Scope([0xaa; 16]);
pub const FIXTURE_SCOPE_B: Scope = Scope([0xbb; 16]);

/// The fork-then-travel-back fixture (`fixtures/ids/`): world A mints four nodes, one a body; B is forked from A
/// without the body; each mints one more; then B's copy of A's node 2 and B's own new node travel to A. Returns A's
/// nodes at the end.
pub fn fork_then_travel_back() -> Vec<FixtureNode> {
    let node = |id, body| FixtureNode {
        id,
        origin: None,
        body,
    };
    let mint = |minter: &mut Minter, held: &mut Held| {
        let id = minter.mint().expect("fresh scope");
        held.minted(id);
        id
    };
    let (mut mint_a, mut held_a) = (Minter::new(FIXTURE_SCOPE_A), Held::default());
    let mut a: Vec<FixtureNode> = (0..4)
        .map(|i| node(mint(&mut mint_a, &mut held_a), i == 3))
        .collect();
    // The fork keeps every id it carries; it carries no bodies (a Soul is in one world).
    let mut b: Vec<FixtureNode> = a.iter().copied().filter(|n| !n.body).collect();
    let (mut mint_b, mut held_b) = (Minter::new(FIXTURE_SCOPE_B), held_a.clone());
    b.push(node(mint(&mut mint_b, &mut held_b), false));
    a.push(node(mint(&mut mint_a, &mut held_a), false));
    // Travel from B to A: node 2 (A has its own copy) and B's new node.
    for travelling in [b[2], b[3]] {
        let arrived = arrive(travelling.id, &mut held_a, &mut mint_a).expect("fresh scope");
        a.push(FixtureNode {
            id: arrived.id,
            origin: arrived.origin,
            body: false,
        });
    }
    a
}

/// The kinds of the hash cases, as committed in `fixtures/ids/`.
pub const FIXTURE_KETTLE: &str = include_str!("../fixtures/ids/kettle.diag");
pub const FIXTURE_CUP: &str = include_str!("../fixtures/ids/cup.diag");

/// Every golden line, `<case> <bytes as hex> <hash or name>`, as `fixtures/ids/goldens.txt` holds them. The native
/// test and the WASM build in Node both compare this with that file (rule 20). WASM exports it only with the
/// `vectors` feature, so the build the page loads does not carry it.
#[cfg_attr(all(target_arch = "wasm32", feature = "vectors"), wasm_bindgen)]
pub fn ids_goldens() -> String {
    let id = Id::new(FIXTURE_SCOPE_A, 7).expect("below 2^53");
    let version = Version {
        lineage: FIXTURE_SCOPE_A,
        zone: Id::new(FIXTURE_SCOPE_A, 0).expect("below 2^53"),
        epoch: 3,
        sequence: 1_000_000,
    };
    let world = Value::Array(
        fork_then_travel_back()
            .into_iter()
            .map(FixtureNode::to_value)
            .collect(),
    );
    let mut lines = Vec::new();
    for (case, value) in [
        ("id", id.to_value()),
        ("version", version.to_value()),
        ("fork-then-travel-back", world),
    ] {
        let bytes = encode(&value).expect("fixture values are shallow");
        let hash = Hash::of(Purpose::Fixture, &bytes);
        lines.push(format!("{case} {} {hash}", to_hex(&bytes)));
    }
    let kinds = [FIXTURE_KETTLE, FIXTURE_CUP].map(|t| KindSource::parse(t).expect("fixture"));
    for k in name_kinds(&kinds).expect("fixture kinds").values() {
        lines.push(format!("kind {} {k}", to_hex(&k.meaning)));
    }
    lines.join("\n") + "\n"
}
