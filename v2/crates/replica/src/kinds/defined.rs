//! A creator's own kinds (Engine v2 parity L12, #3697): a kind defined in the world, as data, after it started. Each is
//! a node of the engine's one generic kind `souls:kind` under the zone's root, holding its definition: the canonical
//! `souls-entry/1` record (the format of `content/kinds/*.json`) in field [`ENTRY`] as bytes, and its full name in
//! field [`NAME`]. The full name is `namespace:name@<hash>`, the hash `souls/kind/1` over the record's bytes, so a
//! changed definition is a new revision and the things placed from the old one keep their bytes.
//!
//! **One loader** ([`kinds_in`]) reads every kind a world has: its boot kinds (the header's) and every `souls:kind`
//! node. The world's edit check, the form runner and the client's checker read kinds through it, and a replica, a
//! replay or a fork learns them from the log, as any node: applying a create of a kind the header does not pin asks
//! [`defines`] whether a `souls:kind` node at the root names it.
//!
//! A definition is checked when it is committed ([`read`]), each failure refused by name:
//!
//! - `kind.invalid`: not a `souls-entry/1` record the kind loader reads (its numbered kind must load), a section it
//!   cannot hold, or a number that is not whole;
//! - `kind.too-large`: over [`ENTRY_MOST`] bytes as stored;
//! - `kind.namespace`: `souls:` and `eden:`, and every namespace a boot kind uses, are not the creator's;
//! - `kind.collision`: the same full name is already defined (by a node with other bytes, or already the same);
//! - `kind.in-use`: removing a kind that placed things still use (in `edit::check`).
//!
//! The record's `forms` are checked by the same entry checker content entries pass (the form runner's, which runs in
//! the world's edit checker); the client's checker checks the rest.

use super::Kinds;
use super::entry::entry_to_kind;
use crate::encode::{Name, Value};
use crate::ids::{Hash, Purpose};
use crate::rules::json::{self, Value as Json};
use crate::tree::Tree;
use crate::world_model::{Kind, parse_kinds, plain};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// The engine's generic kind a definition is a node of: owned by nothing a slot admits, admitting nothing.
pub const SOURCE: &str = "{1: \"souls:kind\", 2: \"kind\"}";
/// The field holding the definition's full name, as text.
pub const NAME: u64 = 1;
/// The field holding the canonical record, as bytes.
pub const ENTRY: u64 = 2;
/// The most bytes a stored record may have.
pub const ENTRY_MOST: usize = 64 << 10;
/// The sections of a record: those the kind loader numbers, and those beside its meaning.
const SECTIONS: [&str; 15] = [
    "format", "kind", "owner", "state", "links", "points", "slots", "children", "geometry",
    "motion", "loose", "forms", "looks", "text", "card",
];
/// Namespaces never a creator's.
const RESERVED: [&str; 2] = ["souls", "eden"];

/// `souls:kind`'s full name and its rules.
pub fn kind() -> &'static (String, Kind) {
    static K: OnceLock<(String, Kind)> = OnceLock::new();
    K.get_or_init(|| {
        parse_kinds(SOURCE)
            .expect("souls:kind loads")
            .into_iter()
            .next()
            .expect("one kind")
    })
}

/// Whether `full` is the generic kind a definition is a node of.
pub fn is_definition(full: &str) -> bool {
    full == kind().0
}

/// A checked definition: the full name, the canonical bytes, the rules the edit check reads, and the record.
#[derive(Clone, Debug)]
pub struct Defined {
    pub full: String,
    pub bytes: Vec<u8>,
    pub kind: Kind,
    pub entry: Json,
}

type Why = (&'static str, String);

fn invalid<T>(why: impl Into<String>) -> Result<T, Why> {
    Err(("kind.invalid", why.into()))
}

/// The record with its objects' keys in order, recursively; a number that is not whole is refused.
fn canonical(v: &Json) -> Result<Json, Why> {
    Ok(match v {
        Json::Num(t) => return invalid(format!("{t}: numbers are whole (mm, mdeg, permille)")),
        Json::Arr(a) => Json::Arr(a.iter().map(canonical).collect::<Result<_, _>>()?),
        Json::Obj(o) => {
            let mut o = o
                .iter()
                .map(|(k, v)| Ok((k.clone(), canonical(v)?)))
                .collect::<Result<Vec<_>, Why>>()?;
            o.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Obj(o)
        }
        other => other.clone(),
    })
}

/// The full name a record's canonical bytes define: its `kind` and the hash of the bytes.
pub fn full_name(kind: &str, bytes: &[u8]) -> String {
    format!("{kind}@{}", Hash::of(Purpose::Kind, bytes))
}

/// Reads a record as sent (JSON text, any key order), checks it and gives its canonical form (see the module's notes).
/// `boot` holds the namespaces the world's boot kinds use.
pub fn read(sent: &[u8], boot: &dyn Fn(&str) -> bool) -> Result<Defined, Why> {
    if sent.len() > ENTRY_MOST {
        return Err((
            "kind.too-large",
            format!("{} bytes, over {ENTRY_MOST}", sent.len()),
        ));
    }
    let text = std::str::from_utf8(sent).or_else(|_| invalid("a record is UTF-8 JSON"))?;
    let entry = canonical(&json::parse(text).or_else(|e| invalid(format!("not JSON: {e}")))?)?;
    if entry.get("format").and_then(Json::str) != Some("souls-entry/1") {
        return invalid("format is souls-entry/1");
    }
    if let Some((key, _)) = entry
        .obj()
        .unwrap_or(&[])
        .iter()
        .find(|(k, _)| !SECTIONS.contains(&k.as_str()))
    {
        return invalid(format!("a creator's kind has no {key} section"));
    }
    let name = entry.get("kind").and_then(Json::str).unwrap_or("");
    let Some((ns, _)) = name.split_once(':') else {
        return invalid("kind is namespace:name");
    };
    if RESERVED.contains(&ns) || boot(ns) {
        return Err((
            "kind.namespace",
            format!("{ns}: is not the creator's; use your own namespace"),
        ));
    }
    let bytes = entry.to_json().into_bytes();
    if bytes.len() > ENTRY_MOST {
        return Err((
            "kind.too-large",
            format!("{} bytes, over {ENTRY_MOST}", bytes.len()),
        ));
    }
    // The meaning the kind loader reads: the record less its forms and what sits beside it.
    let meaning = Json::Obj(
        entry
            .obj()
            .unwrap_or(&[])
            .iter()
            .filter(|(k, _)| !["forms", "looks", "text", "card"].contains(&k.as_str()))
            .map(|(k, v)| {
                // The parts a page draws sit beside the bounds the loader reads.
                let v = match (k.as_str(), v) {
                    ("geometry", Json::Obj(g)) => {
                        Json::Obj(g.iter().filter(|(k, _)| k != "parts").cloned().collect())
                    }
                    _ => v.clone(),
                };
                (k.clone(), v)
            })
            .collect(),
    );
    let source = entry_to_kind(&meaning.to_json()).or_else(invalid)?;
    let mut loaded = Kinds::default();
    loaded.load(&[(name, &source)]);
    if let Some(e) = loaded.refused().first() {
        return invalid(format!("{e:?}"));
    }
    let kind = parse_kinds(&source)
        .or_else(|e| invalid(format!("{e:?}")))?
        .into_values()
        .next()
        .ok_or(("kind.invalid", "no kind".to_owned()))?;
    Ok(Defined {
        full: full_name(name, &bytes),
        bytes,
        kind,
        entry,
    })
}

/// A placed thing's solids field (N1's field 12) for a kind of this record: its walk outline, from `geometry.bounds_mm`
/// as a boot kind's section 7 gives one ([`super::place::Geometry`]), so walkers go round it and the safety rule
/// judges it. `None` for a record with no bounds, or a thing lower than [`super::place::FLAT`] (walked over).
pub fn solids_of(entry: &Json) -> Option<Value> {
    let g = entry.get("geometry")?;
    let b: Vec<i64> = g
        .get("bounds_mm")?
        .arr()?
        .iter()
        .map(|v| match v {
            Json::Int(n) => i64::try_from(*n).ok().filter(|n| *n >= 0),
            _ => None,
        })
        .collect::<Option<_>>()?;
    let bounds_mm = <[i64; 3]>::try_from(b).ok()?;
    super::place::Geometry {
        bounds_mm,
        front: g.get("front").and_then(Json::str) != Some("none"),
    }
    .outlines()
    .solids()
}

/// The solids each creator kind gives what is placed of it ([`solids_of`]), by full name: kinds with none left out.
pub fn solids_in(tree: &Tree) -> BTreeMap<String, Value> {
    nodes(tree)
        .into_iter()
        .filter_map(|(_, full, bytes)| {
            let d = read(&bytes, &|_| false).ok().filter(|d| d.full == full)?;
            Some((full, solids_of(&d.entry)?))
        })
        .collect()
}

/// The full name a `souls:kind` node's fields name, if they name one.
pub fn named(fields: &BTreeMap<u64, Value>) -> Option<&str> {
    match fields.get(&NAME) {
        Some(Value::Text(n)) => Some(n.as_str()),
        _ => None,
    }
}

/// Every `souls:kind` node at the root: its id, the full name and the bytes it holds.
pub fn nodes(tree: &Tree) -> Vec<(crate::ids::Id, String, Vec<u8>)> {
    let root = tree.root();
    let Some(cs) = tree.children(root) else {
        return Vec::new();
    };
    cs.iter()
        .filter_map(|h| tree.node(*h))
        .filter(|n| is_definition(n.kind().as_str()))
        .filter_map(|n| {
            let full = named(n.fields())?.to_owned();
            let bytes = match n.fields().get(&ENTRY) {
                Some(Value::Bytes(b)) => b.clone(),
                _ => return None,
            };
            Some((n.id(), full, bytes))
        })
        .collect()
}

/// Whether a `souls:kind` node at the root defines `full` (or it is `souls:kind` itself): what a replica asks when a
/// create names a kind its header does not pin. Reads the root's children only.
pub fn defines(tree: &Tree, full: &Name) -> bool {
    if is_definition(full.as_str()) {
        return true;
    }
    let root = tree.root();
    tree.children(root).is_some_and(|cs| {
        cs.iter()
            .filter_map(|h| tree.node(*h))
            .any(|n| is_definition(n.kind().as_str()) && named(n.fields()) == Some(full.as_str()))
    })
}

/// The rules of `full`, a kind defined in `tree` (or `souls:kind` itself), by the loader; `None` for any other. Reads
/// the root's children and the one record that names it.
pub fn kind_named(tree: &Tree, full: &str) -> Option<Kind> {
    if is_definition(full) {
        return Some(kind().1.clone());
    }
    let root = tree.root();
    let n = tree
        .children(root)?
        .iter()
        .filter_map(|h| tree.node(*h))
        .find(|n| is_definition(n.kind().as_str()) && named(n.fields()) == Some(full))?;
    let Some(Value::Bytes(b)) = n.fields().get(&ENTRY) else {
        return None;
    };
    read(b, &|_| false)
        .ok()
        .filter(|d| d.full == full)
        .map(|d| d.kind)
}

/// The loader: the kinds a world's `souls:kind` nodes define, with `souls:kind` itself, by full name. A node whose
/// record no longer reads (it never should: each was checked when committed) is left out.
pub fn kinds_in(tree: &Tree) -> BTreeMap<String, Kind> {
    let mut out = BTreeMap::from([kind().clone()]);
    for (_, full, bytes) in nodes(tree) {
        if let Ok(d) = read(&bytes, &|_| false)
            && d.full == full
        {
            out.insert(full, d.kind);
        }
    }
    out
}

/// The namespaces of a set of full kind names.
pub fn namespaces<'a>(names: impl Iterator<Item = &'a str>) -> std::collections::BTreeSet<String> {
    names
        .filter_map(|n| plain(n).split_once(':').map(|(ns, _)| ns.to_owned()))
        .collect()
}
