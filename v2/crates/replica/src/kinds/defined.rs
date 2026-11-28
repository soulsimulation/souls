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
//! - `kind.too-large`: over [`ENTRY_MOST`] bytes as stored, or `geometry.bounds_mm` or a `geometry.solids_mm` value over
//!   [`BOUNDS_MOST_MM`];
//! - `kind.namespace`: `souls:` and `eden:`, and every namespace a boot kind uses, are not the creator's;
//! - `kind.field-reserved`: a state field numbered like a field the engine keeps on things ([`crate::fields`]: the
//!   owner and access marks, a tint, a schedule), which a form could then write past the engine's own checks, or like
//!   one of the import's 1 to 27 (27 names the entry a thing borrows);
//! - `kind.collision`: the same full name is already defined (by a node with other bytes, or already the same);
//! - `kind.in-use`: removing a kind that placed things still use, or that another definition's form creates (in
//!   `edit::check`, and again on the live copy in `edit::confirm`);
//! - `kind.effects`: a form's effect the world would refuse every time it ran ([`effects_checked`]): a `create` of a
//!   kind the world neither pins nor defines, or into a slot that does not admit it, or of a kind with solids into a
//!   slot (a made thing is not judged for what it would bury, so only one made into a hand has solids), or forms that
//!   start each other by timer sooner than [`TIMER_LEAST_US`] in a ring.
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
use std::sync::{Arc, Mutex, OnceLock};

/// The engine's generic kind a definition is a node of: owned by nothing a slot admits, admitting nothing.
pub const SOURCE: &str = "{1: \"souls:kind\", 2: \"kind\"}";
/// The field holding the definition's full name, as text.
pub const NAME: u64 = 1;
/// The field holding the canonical record, as bytes.
pub const ENTRY: u64 = 2;
/// The most bytes a stored record may have.
pub const ENTRY_MOST: usize = 64 << 10;
/// The most any of `geometry.bounds_mm` may be: 1 km. Content's largest kind is about 120 m; anything far past that
/// is a mistake, and its µm arithmetic would leave `i64`.
pub const BOUNDS_MOST_MM: i64 = 1_000_000;
/// A ring of forms that start each other by timer must take at least this long to go round, µs (one tick, 50 ms), so
/// one record never fires every tick for ever.
pub const TIMER_LEAST_US: i64 = 50_000;
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
    // The import's numbers, 1 to 27, are a thing's own facts: 27 names the entry a thing borrows, and every reader of a
    // thing's amounts or kind takes it for that (`sim::forms::amounts`, `worldd::needs`). A number past a u64 is refused
    // too: the kind's loader would wrap it onto one of them.
    if let Some((field, n)) = entry
        .get("state")
        .and_then(Json::obj)
        .unwrap_or(&[])
        .iter()
        .find_map(|(k, v)| match v.get("n") {
            Some(Json::Int(n)) => match u64::try_from(*n) {
                Ok(m) if m >= crate::fields::ENTRY_FIELDS.start => None,
                _ => Some((k, *n)),
            },
            _ => None,
        })
    {
        return Err((
            "kind.field-reserved",
            format!(
                "state field {field} takes n {n}, not a number a kind may take: number it from {} to {}",
                crate::fields::ENTRY_FIELDS.start,
                crate::fields::ENTRY_FIELDS.end - 1
            ),
        ));
    }
    if let Some((field, f)) = entry
        .get("state")
        .and_then(Json::obj)
        .unwrap_or(&[])
        .iter()
        .find_map(|(k, v)| match v.get("n") {
            Some(Json::Int(n)) => u64::try_from(*n)
                .ok()
                .and_then(crate::fields::on_things)
                .map(|f| (k, f)),
            _ => None,
        })
    {
        return Err((
            "kind.field-reserved",
            format!(
                "state field {field} takes n {}, the engine's {}: number it from {} to {}",
                f.n,
                f.name,
                crate::fields::ENTRY_FIELDS.start,
                crate::fields::ENTRY_FIELDS.end - 1
            ),
        ));
    }
    if let Some(b) = entry
        .get("geometry")
        .and_then(|g| g.get("bounds_mm"))
        .and_then(Json::arr)
        && let Some(big) = b.iter().find(|v| match v {
            Json::Int(n) => *n > i128::from(BOUNDS_MOST_MM),
            _ => false,
        })
    {
        return Err((
            "kind.too-large",
            format!("geometry.bounds_mm {big:?} is over {BOUNDS_MOST_MM} mm"),
        ));
    }
    if let Some(v) = entry.get("geometry").and_then(|g| g.get("solids_mm")) {
        own_solids(v)?;
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
    // Its rules as the loader gives a boot kind's (`Kinds::admits`): T3's kinds-file reader does not read the loader's
    // slot rows, so a record with slots read through it was refused.
    let kind = loaded
        .admits()
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

/// The most records [`stored`] keeps read.
const STORED_MOST: usize = 4096;

/// A stored record (a `souls:kind` node's bytes) read, when it defines `full`: from the cache by full name, which a
/// name can key because it is the hash of the bytes (the bytes are compared too), else read and kept. Every lookup of
/// a creator's kind (the loader, the commit's `Rules::kind`, the form runner) reads through it, so a record is parsed
/// once per process, not on every act or create. The cache holds what [`read`] gives, so it changes no answer.
pub fn stored(full: &str, bytes: &[u8]) -> Option<Arc<Defined>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, Arc<Defined>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Ok(c) = cache.lock()
        && let Some(d) = c.get(full)
        && d.bytes == bytes
    {
        return Some(d.clone());
    }
    let d = Arc::new(read(bytes, &|_| false).ok().filter(|d| d.full == full)?);
    if let Ok(mut c) = cache.lock() {
        if c.len() >= STORED_MOST {
            c.clear();
        }
        c.insert(full.to_owned(), d.clone());
    }
    Some(d)
}

/// The kinds a record's forms create (each `create` effect's `kind`), as written.
pub fn creates(entry: &Json) -> Vec<&str> {
    let mut out = Vec::new();
    for (_, f) in entry.get("forms").and_then(Json::obj).unwrap_or(&[]) {
        for e in f.get("effects").and_then(Json::arr).unwrap_or(&[]) {
            if e.get("change").and_then(Json::str) == Some("create")
                && let Some(k) = e.get("kind").and_then(Json::str)
            {
                out.push(k);
            }
        }
    }
    out
}

/// A record's forms' effects that the world would refuse each time they ran, refused now, `kind.effects` (#3697
/// review): a `create` of a kind `kinds` (the world's, by full name) does not hold, or into a slot of this kind that
/// does not admit it, or of a kind with solids (`solid`, the creator kinds that have them, by full name) into any slot;
/// and forms that start each other by `timer` in a ring that goes round sooner than
/// [`TIMER_LEAST_US`]. `kind` is this record's own rules. What depends on a form's arguments is left to the run, which
/// refuses that act alone.
pub fn effects_checked(
    entry: &Json,
    kind: &Kind,
    kinds: &BTreeMap<String, Kind>,
    solid: &BTreeMap<String, Value>,
) -> Result<(), Why> {
    let no = |why: String| Err(("kind.effects", why));
    let forms = entry.get("forms").and_then(Json::obj).unwrap_or(&[]);
    let slots = entry.get("slots").and_then(Json::obj).unwrap_or(&[]);
    // The quick timers: form to the forms it starts sooner than the least, and how soon.
    // Parallel timers between two forms count once, at the soonest (a negative one, refused when it runs, as 0).
    let mut quick: BTreeMap<&str, BTreeMap<&str, i128>> = BTreeMap::new();
    for (form, f) in forms {
        for e in f.get("effects").and_then(Json::arr).unwrap_or(&[]) {
            match e.get("change").and_then(Json::str) {
                Some("create") => {
                    let made = e.get("kind").and_then(Json::str).unwrap_or("");
                    let Some(k) = kinds.get(made) else {
                        return no(format!(
                            "{form}: creates {made}, a kind this world neither pins nor defines (its full name)"
                        ));
                    };
                    let into = e.get("into").and_then(Json::str).unwrap_or("");
                    if matches!(into, "actor_hand" | "here") {
                        continue;
                    }
                    let admits = (1u64..)
                        .zip(slots)
                        .find(|(_, (s, _))| s == into)
                        .and_then(|(n, _)| kind.slots.get(&n))
                        .is_some_and(|l| crate::world_model::takes(l, plain(made), &k.owner));
                    if !admits {
                        return no(format!(
                            "{form}: creates {} into {into}, a slot that does not admit it",
                            plain(made)
                        ));
                    }
                    // A made thing is not judged for what it would bury or cut off (BUILDSAFE judges edits and
                    // set-downs), so one with solids is made only into a hand, and judged when it is set down.
                    if solid.contains_key(made) {
                        return no(format!(
                            "{form}: creates {} into {into}, but a thing with solids is made only into a hand",
                            plain(made)
                        ));
                    }
                }
                Some("timer") => {
                    if let (Some(to), Some(Json::Int(us))) =
                        (e.get("form").and_then(Json::str), e.get("after_us"))
                        && *us < i128::from(TIMER_LEAST_US)
                    {
                        let soonest = quick
                            .entry(form.as_str())
                            .or_default()
                            .entry(to)
                            .or_insert(*us);
                        *soonest = (*soonest).min(*us);
                    }
                }
                _ => {}
            }
        }
    }
    // A ring of quick timers: the shortest way back to each form (Dijkstra over the forms), so the search is
    // polynomial in the record however many timers it has.
    for start in quick.keys() {
        let mut best: BTreeMap<&str, i128> = BTreeMap::from([(*start, 0)]);
        let mut due = std::collections::BinaryHeap::from([std::cmp::Reverse((0i128, *start))]);
        while let Some(std::cmp::Reverse((spent, at))) = due.pop() {
            if best.get(at).is_some_and(|b| *b < spent) {
                continue;
            }
            for (to, us) in quick.get(at).into_iter().flatten() {
                let spent = spent + (*us).max(0);
                if spent >= i128::from(TIMER_LEAST_US) {
                    continue;
                }
                if to == start {
                    return no(format!(
                        "{start}: starts itself again by timer within {spent} µs, under {TIMER_LEAST_US}"
                    ));
                }
                if best.get(to).is_none_or(|b| spent < *b) {
                    best.insert(to, spent);
                    due.push(std::cmp::Reverse((spent, to)));
                }
            }
        }
    }
    Ok(())
}

/// A placed thing's solids field (N1's field 12) for a kind of this record: its walk outline, from `geometry.bounds_mm`
/// as a boot kind's section 7 gives one ([`super::place::Geometry`]), so walkers go round it and the safety rule
/// judges it. `None` for a record with no bounds, or a thing lower than [`super::place::FLAT`] (walked over).
///
/// A record whose `geometry.solids_mm` lists its own boxes (`[[cx, cz, hx, hz, yaw mdeg, y0, y1]]`, mm, the thing's
/// frame: field 12's rows, as the import writes a seeded thing's from its model) gives those instead, so a thing with
/// gaps (a rack frame's two posts) is walked through where a seeded one is. A list [`read`] would refuse gives none:
/// a creator's record with one is never committed, and a content entry's are checked by its tests.
pub fn solids_of(entry: &Json) -> Option<Value> {
    let g = entry.get("geometry")?;
    if let Some(v) = g.get("solids_mm") {
        return own_solids(v).ok();
    }
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

/// `geometry.solids_mm` as field 12's rows. Each row is seven whole mm, `[cx, cz, hx, hz, yaw mdeg, y0, y1]`, its half
/// sizes and heights none below 0 and its top above its bottom, else `kind.invalid`. That is the seven a kind gives:
/// a seeded thing's nine (the import's tag and `abs` after them) are refused by name, not read as seven. A value
/// past [`BOUNDS_MOST_MM`] either way is `kind.too-large`, as a bound past it is, so the µm arithmetic stays in `i64`.
fn own_solids(v: &Json) -> Result<Value, Why> {
    let int = |n: i64| match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    };
    const ROW: &str = "[cx, cz, hx, hz, yaw_mdeg, y0, y1]";
    let rows = v.arr().filter(|a| !a.is_empty()).ok_or((
        "kind.invalid",
        format!("geometry.solids_mm is a list of rows {ROW}"),
    ))?;
    let mut out = Vec::with_capacity(rows.len());
    for (k, r) in rows.iter().enumerate() {
        let n: Vec<i128> = r
            .arr()
            .and_then(|a| {
                a.iter()
                    .map(|x| match x {
                        Json::Int(i) => Some(*i),
                        _ => None,
                    })
                    .collect()
            })
            .ok_or((
                "kind.invalid",
                format!("geometry.solids_mm row {k} is whole mm {ROW}"),
            ))?;
        if n.len() == 9 {
            return invalid(format!(
                "geometry.solids_mm row {k} has nine values, a seeded thing's (its tag and abs): a kind's row is {ROW}"
            ));
        }
        let Ok([cx, cz, hx, hz, yaw, y0, y1]) = <[i128; 7]>::try_from(n) else {
            return invalid(format!("geometry.solids_mm row {k} is seven values {ROW}"));
        };
        let row = [cx, cz, hx, hz, yaw, y0, y1];
        if let Some(big) = row.iter().find(|v| v.abs() > i128::from(BOUNDS_MOST_MM)) {
            return Err((
                "kind.too-large",
                format!("geometry.solids_mm row {k}: {big} is over {BOUNDS_MOST_MM} mm"),
            ));
        }
        if hx < 0 || hz < 0 || y0 < 0 || y1 <= y0 {
            return invalid(format!(
                "geometry.solids_mm row {k}: half sizes and heights none below 0, the top above the bottom"
            ));
        }
        // Each is within ±BOUNDS_MOST_MM, so an i64.
        out.push(Value::Array(
            row.iter()
                .map(|v| int(i64::try_from(*v).unwrap_or(0)))
                .collect(),
        ));
    }
    Ok(Value::Array(out))
}

/// A placed thing's slots field (field 13, `[[n, x, y, z, yaw mdeg, capacity]]` mm, the thing's frame) for a kind of
/// this record, as the import writes a seeded thing's: each slot numbered 1, 2, ... in the record's order (as the kind
/// numbers them), at its `at_mm`, turned `yaw_mdeg` (else 0), holding `most` (else 1). A slot with no `at_mm` gives no
/// point (a hand, a carry). `None` for a record whose slots give no point, so a stand or a bay placed live seats parts
/// at the points one seeded from a world's facts does.
pub fn slots_of(entry: &Json) -> Option<Value> {
    let whole = |v: Option<&Json>| match v {
        Some(Json::Int(n)) => i64::try_from(*n).ok(),
        _ => None,
    };
    let int = |n: i64| match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    };
    let rows: Vec<Value> = (1i64..)
        .zip(entry.get("slots")?.obj()?)
        .filter_map(|(n, (_, s))| {
            let at = s.get("at_mm")?.arr()?;
            let [x, y, z] = [0, 1, 2].map(|k| whole(at.get(k)));
            Some(Value::Array(vec![
                int(n),
                int(x?),
                int(y?),
                int(z?),
                int(whole(s.get("yaw_mdeg")).unwrap_or(0)),
                int(whole(s.get("most")).unwrap_or(1)),
            ]))
        })
        .collect();
    (!rows.is_empty()).then_some(Value::Array(rows))
}

/// The solids each creator kind gives what is placed of it ([`solids_of`]), by full name: kinds with none left out.
pub fn solids_in(tree: &Tree) -> BTreeMap<String, Value> {
    nodes(tree)
        .into_iter()
        .filter_map(|(_, full, bytes)| {
            let d = stored(&full, &bytes)?;
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

/// The definition a `souls:kind` node at the root of `tree` holds for `full`, by the loader; `None` for any other.
/// Reads the root's children and the one record that names it.
pub fn defined_named(tree: &Tree, full: &str) -> Option<Arc<Defined>> {
    let root = tree.root();
    let n = tree
        .children(root)?
        .iter()
        .filter_map(|h| tree.node(*h))
        .find(|n| is_definition(n.kind().as_str()) && named(n.fields()) == Some(full))?;
    let Some(Value::Bytes(b)) = n.fields().get(&ENTRY) else {
        return None;
    };
    stored(full, b)
}

/// The rules of `full`, a kind defined in `tree` (or `souls:kind` itself), by the loader; `None` for any other.
pub fn kind_named(tree: &Tree, full: &str) -> Option<Kind> {
    if is_definition(full) {
        return Some(kind().1.clone());
    }
    defined_named(tree, full).map(|d| d.kind.clone())
}

/// The record (`souls-entry/1`, forms included) of `full`, a kind defined in `tree`: what the form runner reads for a
/// thing of a creator's kind, as it reads a content entry for a boot kind (#3697 gap 2).
pub fn entry_named(tree: &Tree, full: &str) -> Option<Json> {
    defined_named(tree, full).map(|d| d.entry.clone())
}

/// The loader: the kinds a world's `souls:kind` nodes define, with `souls:kind` itself, by full name. A node whose
/// record no longer reads (it never should: each was checked when committed) is left out.
pub fn kinds_in(tree: &Tree) -> BTreeMap<String, Kind> {
    let mut out = BTreeMap::from([kind().clone()]);
    for (_, full, bytes) in nodes(tree) {
        if let Some(d) = stored(&full, &bytes) {
            out.insert(full, d.kind.clone());
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

#[cfg(test)]
mod tests {
    use super::*;

    fn solids(text: &str) -> Result<Value, Why> {
        own_solids(&json::parse(text).unwrap())
    }

    /// A creator's record with `solids_mm` as given, through [`read`].
    fn record(solids_mm: &str) -> Result<Defined, Why> {
        let text = format!(
            r#"{{"format": "souls-entry/1", "kind": "yard:frame", "owner": "thing",
                "geometry": {{"bounds_mm": [1219, 2438, 76], "solids_mm": {solids_mm}}}}}"#
        );
        read(text.as_bytes(), &|_| false)
    }

    #[test]
    fn a_kinds_own_solids_are_field_12s_rows() {
        let rows = solids("[[-572, 0, 38, 38, 0, 0, 2438], [572, 0, 38, 38, 0, 0, 2438]]").unwrap();
        let u = Value::Uint;
        assert_eq!(
            rows,
            Value::Array(vec![
                Value::Array(vec![
                    Value::Nint(571),
                    u(0),
                    u(38),
                    u(38),
                    u(0),
                    u(0),
                    u(2438)
                ]),
                Value::Array(vec![u(572), u(0), u(38), u(38), u(0), u(0), u(2438)]),
            ])
        );
        // The rack frame's content entry gives its two posts, as the import gives a seeded frame's.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../content/kinds/construction/rack_upright.json"
        );
        let entry = json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(solids_of(&entry), Some(rows));
        assert!(record("[[-572, 0, 38, 38, 0, 0, 2438], [572, 0, 38, 38, 0, 0, 2438]]").is_ok());
    }

    #[test]
    fn a_value_past_a_kilometre_is_too_large() {
        for row in [
            "[[1000001, 0, 1, 1, 0, 0, 1]]",
            "[[-1000001, 0, 1, 1, 0, 0, 1]]",
            "[[0, 0, 1, 1, 0, 0, 1000001]]",
        ] {
            assert_eq!(solids(row).unwrap_err().0, "kind.too-large", "{row}");
            assert_eq!(
                record(row).err().map(|e| e.0),
                Some("kind.too-large"),
                "{row}"
            );
        }
        assert!(
            solids("[[1000000, 0, 1, 1, 0, 0, 1000000]]").is_ok(),
            "a kilometre is the most"
        );
    }

    #[test]
    fn a_list_not_of_rows_is_refused_not_the_box() {
        for bad in [
            "7",
            "[]",
            "[7]",
            "[[0, 0, 1, 1, 0, 0]]",
            "[[0, 0, 1, 1, 0, 0, \"tall\"]]",
            "[[0, 0, -1, 1, 0, 0, 10]]",
            "[[0, 0, 1, 1, 0, -1, 10]]",
            "[[0, 0, 1, 1, 0, 10, 10]]",
        ] {
            assert_eq!(solids(bad).unwrap_err().0, "kind.invalid", "{bad}");
            assert_eq!(
                record(bad).err().map(|e| e.0),
                Some("kind.invalid"),
                "{bad}"
            );
        }
        // A seeded thing's nine (the import's tag and abs) are named, not read as seven.
        let nine = solids("[[-572, 0, 38, 38, 0, 0, 2438, 0, 0]]").unwrap_err();
        assert_eq!(nine.0, "kind.invalid");
        assert!(nine.1.contains("nine values"), "{}", nine.1);
        // A content entry with such a list gives no solids, not the bounds' box.
        let entry = json::parse(
            r#"{"geometry": {"bounds_mm": [1219, 2438, 76], "solids_mm": [[0, 0, 1]]}}"#,
        )
        .unwrap();
        assert_eq!(solids_of(&entry), None);
    }
}
