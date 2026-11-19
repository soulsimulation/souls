//! Engine v2 N1 (#2649): Eden 2026's built content as a tree (K2's `replica::tree`), from the facts file that
//! `export/export.ts` writes. Everything goes in through [`Tree::commit`], so T2's checks run on every change.
//!
//! The mapping (lane notes, "How Eden maps to the tree", `v2/docs/tranche/N-space-and-movement.md`):
//!
//! - world -> open ground -> each thing placed at the world root. A thing's children are its plain children and those
//!   in its slots (slot number = the slot's place in its bake, from 1). A room slot is not a slot: it is a room node.
//! - a thing with rooms, floors or stairs -> one floor node per level -> its rooms. A thing placed in a room slot is a
//!   child of that room. A window is a node under the room it opens from, with its width, height and sill.
//! - a doorway (a door, gate or arch opening) is a link between the room it opens from and the room it leads to, or
//!   the open ground; one with no rooms (a wall's gate) joins its thing to the open ground. The door thing standing in
//!   it keeps the link's id and its open state. A stair, ramp or ladder is a link between two floor nodes. Links carry
//!   no fields, so each doorway's and stair's geometry is a field of the node at its owning end.
//! - each named place that is not a room is a node under the open ground with its name, kind and outline. Nobody is
//!   its child: a place is found by its outline.
//! - the terrain (N1b, #3197) is two fields of the open ground: its tile side and every tile's heights and classes,
//!   byte for byte as exported (`F_TILE_SIZE`, `F_TILES`). `ground::scene::Terrain` reads them.
//!
//! Positions are micrometres (the facts are whole millimetres, times 1,000); yaws become orientations only through
//! `Quat::from_yaw_mdeg`. Human words (names) are stored by reference: the field holds the text's SHA-256, and
//! [`Import::texts`] maps it back. Kinds are T3's `namespace:name@hash`, each named on its own by T3's reader, in the
//! namespace the world's Soul Actions entries use ([`kind_name`]: Eden's `core:` and `eden:eden_` defs are `eden:`).

// The repeat rule's map ban (K12, v2/clippy.toml) is `sim`'s; this importer's map is a lookup.
#![allow(clippy::disallowed_types)]

pub mod json;

use json::Json;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope, sha256};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, parse_kinds, plain};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

// Field numbers on imported nodes. Today's ids, refs and hashes are bytes: a log's only text is `namespace:name`.
pub const F_ORIGIN: u64 = 1; // today's id (e_…), or e_…/room, e_…/floor-2, e_…/window-3, a place's id
pub const F_DEF: u64 = 2; // today's def ref, `name@version`
pub const F_DEF_HASH: u64 = 3; // today's def hash
pub const F_NAME: u64 = 4; // a name, by reference (SHA-256 of the text)
pub const F_LEVEL: u64 = 5; // a floor's index
pub const F_OPEN: u64 = 6; // a door: 1 open, 0 shut
pub const F_DOORWAY: u64 = 7; // a door: the id of the doorway link it stands in
pub const F_WIDTH: u64 = 8; // mm
pub const F_HEIGHT: u64 = 9; // mm (a window's, a room's)
pub const F_SILL: u64 = 10; // mm
pub const F_OUTLINE: u64 = 11; // [[x, z] mm …]: a room's (its frame), a place's or an area's (world)
pub const F_SOLIDS: u64 = 12; // [[cx, cz, hx, hz, yaw mdeg, y0, y1, tag, abs] …] mm, the thing's frame
pub const F_SLOTS: u64 = 13; // [[n, x, y, z, yaw mdeg, capacity] …] mm, the thing's frame
pub const F_SURFACES: u64 = 14; // a floor: [[y, [[x, z] …]] …] mm, the thing's frame
pub const F_PLACE_KIND: u64 = 15; // a place's kind (water, shore, pier, zone …)
pub const F_LINE: u64 = 16; // [[x, z] …] mm: a path thing's, a line place's, a river's
pub const F_LINE_WIDTH: u64 = 17; // mm
pub const F_WATER_LEVEL: u64 = 18; // mm
pub const F_PLACE_OF: u64 = 20; // what a place is derived from: area, water, shore, line, outline, landform, landmark
pub const F_STAIRS: u64 = 21; // a floor: [[link, kind, to, width, y0, y1, [[x, z] …]] …] for each stair from it
pub const F_DOORWAYS: u64 = 22; // a doorway's owning end: [[link, kind, x, z, yaw mdeg, width, height] …]
pub const F_SCALE: u64 = 23; // a thing's scale in parts per million, when it is not 1
pub const F_TILE_SIZE: u64 = 24; // the open ground: a terrain tile's side, mm (Eden: 64 m)
// The open ground's terrain, as the exporter wrote it: [[tx, tz, heights, classes] …], tile (tx, tz) covering x from
// tx × side to (tx + 1) × side, z likewise. Heights are (n + 1)² little-endian i32 mm, a row of x for each z, at
// side / n spacing; classes are n² bytes, one per cell, in the same order (today's media codes, `packages/ground`).
pub const F_TILES: u64 = 25;
pub const F_ASSET: u64 = 26; // X6: [SHA-256 …] of the world's uploads the thing names (a mesh's, a picture's)
pub const F_ENTRY: u64 = 27; // X6: the Soul Actions entry of the thing's kind (SA-E11's map), when it has one

pub const WORLD: &str = "eden:world";
pub const GROUND: &str = "eden:ground";
pub const FLOOR: &str = "eden:floor";
pub const ROOM: &str = "eden:room";
pub const WINDOW: &str = "eden:window";
pub const PLACE: &str = "eden:place";
pub const DOORWAY: &str = "eden:doorway";

/// The tree, the rules it was committed under, and what the import counted and noticed.
pub struct Import {
    pub tree: Tree,
    pub rules: Rules,
    /// Each origin key (today's id, or `e_…/room`, `e_…/floor-n`, `e_…/window`, a place id) to its node.
    pub nodes: BTreeMap<String, Id>,
    /// Today's def ref to its kind's full name.
    pub kinds: BTreeMap<String, String>,
    /// Names by reference: SHA-256 to text.
    pub texts: BTreeMap<[u8; 32], String>,
    /// What the replayed model's bake counts (written by the exporter in a pass of its own), and per def ref.
    pub bake: BTreeMap<String, i64>,
    pub by_ref: BTreeMap<String, i64>,
    /// Things the import could not place as the facts say, each with its reason.
    pub notes: Vec<String>,
    /// Things today's facts put in a slot another thing already holds: each stays a plain child of the same parent
    /// at its own place, out of the slot (one occupant per slot), with what holds the slot.
    pub left_out: Vec<String>,
    /// Today's def ref to its form: point, path or area.
    pub forms: BTreeMap<String, String>,
    /// The header and the one part the tree was committed from, as bytes: a client's copy is built from them.
    pub log: (Vec<u8>, Vec<u8>),
    /// Every entry the import committed, in order: what a stream of the world starts from (V5, #2714).
    pub effects: Vec<Effect>,
}

type R<T> = Result<T, String>;

fn need<'a>(j: &'a Json, k: &str) -> R<&'a Json> {
    j.get(k).ok_or_else(|| format!("missing '{k}'"))
}
fn int(j: &Json, k: &str) -> R<i64> {
    need(j, k)?
        .int()
        .ok_or_else(|| format!("'{k}' is not a whole number"))
}
fn s<'a>(j: &'a Json, k: &str) -> R<&'a str> {
    need(j, k)?
        .str()
        .ok_or_else(|| format!("'{k}' is not text"))
}
fn i(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}
fn ints(j: &Json) -> R<Value> {
    j.arr()
        .iter()
        .map(|n| {
            n.int()
                .map(i)
                .ok_or_else(|| "a list of whole numbers".to_owned())
        })
        .collect::<R<_>>()
        .map(Value::Array)
}
fn points(j: &Json) -> R<Value> {
    j.arr().iter().map(ints).collect::<R<_>>().map(Value::Array)
}
/// A library kind's name as the world's Soul Actions entries (`content/kinds`, `souls-entry/1`) name it (C12, #3427):
/// the exporter names today's built-in def `core-<name>` as `core:<name>` and an authored `eden-<name>` as
/// `eden:eden_<name>`, while the entries name both `eden:<name>`, Eden's own namespace. Any other name is kept.
pub fn kind_name(t: &str) -> String {
    match t.split_once(':') {
        Some(("core", n)) => format!("eden:{n}"),
        Some(("eden", n)) if n.len() > 5 && n.starts_with("eden_") => format!("eden:{}", &n[5..]),
        _ => t.to_owned(),
    }
}

/// `eden:<word>` for a label of lower-case letters, digits, `-` and `_` that starts with a letter.
fn label(t: &str) -> Option<Name> {
    let ok = t.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && t.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    ok.then(|| Name::new(&format!("eden:{t}"))).flatten()
}
fn hex(t: &str) -> R<Vec<u8>> {
    (0..t.len())
        .step_by(2)
        .map(|k| {
            t.get(k..k + 2)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| format!("'{t}' is not hex"))
        })
        .collect()
}
fn name(t: &str) -> R<Name> {
    Name::new(t).ok_or_else(|| format!("'{t}' is not a name"))
}

struct Spec {
    id: Id,
    parent: Id,
    slot: Option<u64>,
    kind: String,
    pose: [i64; 4],
    fields: BTreeMap<u64, Value>,
}

struct Build {
    mint: Minter,
    nodes: BTreeMap<String, Id>,
    specs: Vec<Spec>,
    texts: BTreeMap<[u8; 32], String>,
    notes: Vec<String>,
    left_out: Vec<String>,
}

impl Build {
    fn id(&mut self) -> R<Id> {
        self.mint.mint().map_err(|_| "ids exhausted".to_owned())
    }
    fn node(&mut self, key: &str) -> R<Id> {
        if let Some(id) = self.nodes.get(key) {
            return Ok(*id);
        }
        let id = self.id()?;
        self.nodes.insert(key.to_owned(), id);
        Ok(id)
    }
    /// Human words by reference (T8): the field holds the SHA-256 of the text.
    fn words(&mut self, text: &str) -> Value {
        let h = sha256(text.as_bytes());
        self.texts.entry(h).or_insert_with(|| text.to_owned());
        Value::Bytes(h.to_vec())
    }
    /// A label (a place's kind) as the name `eden:<label>` when it is one word, else by reference.
    fn label(&mut self, text: &str) -> Value {
        match label(text) {
            Some(n) => Value::Text(n),
            None => self.words(text),
        }
    }
    /// Today's identifier, as its bytes: a log carries no text but `namespace:name` (T6 rule 10).
    fn origin(&mut self, key: &str) -> R<Value> {
        Ok(Value::Bytes(key.as_bytes().to_vec()))
    }
    fn add(
        &mut self,
        key: &str,
        parent: Id,
        slot: Option<u64>,
        kind: &str,
        pose: [i64; 4],
        mut fields: BTreeMap<u64, Value>,
    ) -> R<Id> {
        let id = self.node(key)?;
        fields.insert(F_ORIGIN, self.origin(key)?);
        self.specs.push(Spec {
            id,
            parent,
            slot,
            kind: kind.to_owned(),
            pose,
            fields,
        });
        Ok(id)
    }
}

fn pose4(j: &Json) -> R<[i64; 4]> {
    let a = j.arr();
    if a.len() != 4 {
        return Err("a pose is [x, y, z, yaw mdeg]".into());
    }
    let n = |k: usize| a[k].int().ok_or_else(|| "a pose number".to_owned());
    Ok([n(0)?, n(1)?, n(2)?, n(3)?])
}

/// Kind lines, each named on its own by T3's reader (a set may hold two revisions of one `namespace:name`).
fn name_kind(line: &str) -> R<(String, replica::world_model::Kind)> {
    let mut k = parse_kinds(line).map_err(|e| format!("{e:?}: {line}"))?;
    k.pop_first().ok_or_else(|| "no kind".to_owned())
}

/// Builds the tree from the facts file's text.
pub fn load(text: &str) -> R<Import> {
    let f = json::parse(text)?;
    if s(&f, "format")? != "souls/import-eden/1" {
        return Err("not a souls/import-eden/1 file".into());
    }
    let things = need(&f, "things")?.arr();

    // --- Kinds: T3's names, with what each admits (section 11) and in its slots (section 6). -------------------------
    let mut slots_of: BTreeMap<&str, BTreeSet<i64>> = BTreeMap::new();
    let mut has_floors: BTreeSet<&str> = BTreeSet::new();
    for t in things {
        let r = s(t, "ref")?;
        let e = slots_of.entry(r).or_default();
        for sl in need(t, "slots").map(Json::arr).unwrap_or(&[]) {
            e.insert(int(sl, "n")?);
        }
        if t.get("rooms").is_some() || t.get("floors").is_some() || t.get("stairs").is_some() {
            has_floors.insert(r);
        }
    }
    let mut rules = Rules::default();
    let mut kinds: BTreeMap<String, String> = BTreeMap::new();
    let mut forms: BTreeMap<String, String> = BTreeMap::new();
    let mut full: BTreeMap<&str, String> = BTreeMap::new();
    let structural = [
        (
            WORLD,
            format!("{{1: \"{WORLD}\", 2: \"place\", 11: [\"{GROUND}\"]}}"),
        ),
        (
            GROUND,
            format!("{{1: \"{GROUND}\", 2: \"place\", 11: [\"thing\", \"{PLACE}\"]}}"),
        ),
        (
            FLOOR,
            format!("{{1: \"{FLOOR}\", 2: \"place\", 11: [\"{ROOM}\"]}}"),
        ),
        (
            ROOM,
            format!("{{1: \"{ROOM}\", 2: \"place\", 11: [\"thing\", \"{WINDOW}\"]}}"),
        ),
        (WINDOW, format!("{{1: \"{WINDOW}\", 2: \"place\"}}")),
        (PLACE, format!("{{1: \"{PLACE}\", 2: \"place\"}}")),
    ];
    for (plain_name, line) in &structural {
        let (fname, k) = name_kind(line)?;
        rules.kinds.insert(fname.clone(), k);
        full.insert(plain_name, fname);
    }
    for k in need(&f, "kinds")?.arr() {
        let r = s(k, "ref")?;
        let slots: String = slots_of
            .get(r)
            .map(|ns| {
                ns.iter()
                    .map(|n| format!("{n}: [\"thing\"]"))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let children = if has_floors.contains(r) {
            format!("[\"thing\", \"{FLOOR}\"]")
        } else {
            "[\"thing\"]".to_owned()
        };
        // Section 19 holds today's def hash, so the kind's hash covers today's meaning until K3 loads real entries.
        // Named as the entries name it ([`kind_name`]), so a thing's kind finds its entry.
        let line = format!(
            "{{1: \"{}\", 2: \"thing\", 6: {{{slots}}}, 11: {children}, 19: \"{}\"}}",
            kind_name(s(k, "name")?),
            s(k, "hash")?
        );
        let (fname, kind) = name_kind(&line)?;
        rules.kinds.insert(fname.clone(), kind);
        kinds.insert(r.to_owned(), fname);
        forms.insert(r.to_owned(), s(k, "form")?.to_owned());
    }

    // --- Ids: one scope for this world's one zone writer (T3: a new scope for every world; `world` names it). ----------
    let world = f.get("world").and_then(Json::str).unwrap_or("eden-2026");
    let mut scope = [0u8; 16];
    scope.copy_from_slice(&sha256(format!("souls/import-eden/{world}").as_bytes())[..16]);
    let mut b = Build {
        mint: Minter::new(Scope(scope)),
        nodes: BTreeMap::new(),
        specs: Vec::new(),
        texts: BTreeMap::new(),
        notes: Vec::new(),
        left_out: Vec::new(),
    };
    let root = b.node("world")?;
    let ground = b.add("ground", root, None, &full[GROUND], [0; 4], terrain(&f)?)?;

    // Doorway links, minted first so a door can name its doorway when it is created.
    let mut doorway_ids: BTreeMap<(String, String), Id> = BTreeMap::new();
    for t in things {
        for o in need(t, "openings").map(Json::arr).unwrap_or(&[]) {
            if s(o, "kind")? != "window" {
                let link = b.id()?;
                doorway_ids.insert((s(t, "id")?.to_owned(), s(o, "id")?.to_owned()), link);
            }
        }
    }
    let mut door_of: BTreeMap<&str, Id> = BTreeMap::new();
    for d in need(&f, "doors")?.arr() {
        let door = s(d, "door")?;
        match (
            d.get("thing").and_then(Json::str),
            d.get("opening").and_then(Json::str),
        ) {
            (Some(t), Some("own")) => {
                let own = doorway_ids.range((t.to_owned(), String::new())..).next();
                match own {
                    Some(((tt, _), id)) if tt == t => {
                        door_of.insert(door, *id);
                    }
                    _ => b
                        .notes
                        .push(format!("door {door}: its own doorway is missing")),
                }
            }
            (Some(t), Some(o)) => match doorway_ids.get(&(t.to_owned(), o.to_owned())) {
                Some(id) => {
                    door_of.insert(door, *id);
                }
                None => b
                    .notes
                    .push(format!("door {door}: doorway {t}/{o} is missing")),
            },
            _ => b.notes.push(format!(
                "door {door}: {}",
                d.get("reason").and_then(Json::str).unwrap_or("unpaired")
            )),
        }
    }

    // --- Things, floors, rooms and windows. ---------------------------------------------------------------------------
    let mut links: Vec<(Id, &str, [Id; 2])> = Vec::new();
    let mut doorway_fields: BTreeMap<Id, Vec<Value>> = BTreeMap::new();
    let mut stair_fields: BTreeMap<Id, Vec<Value>> = BTreeMap::new();
    // A slot's point in its thing's frame: today's pose of a thing in a slot is from its parent's origin, and K2's is
    // from the slot's point (T4's carry adds the point), so the point is taken off once here.
    let mut slot_at: HashMap<(&str, i64), [i64; 3]> = HashMap::new();
    for t in things {
        for sl in need(t, "slots").map(Json::arr).unwrap_or(&[]) {
            let at = need(sl, "at")?.arr();
            let n = |k: usize| at.get(k).and_then(Json::int).ok_or("a slot's at");
            slot_at.insert((s(t, "id")?, int(sl, "n")?), [n(0)?, n(1)?, n(2)?]);
        }
    }
    let mut held: HashMap<(Id, u64), &str> = HashMap::new();
    for t in things {
        let id = s(t, "id")?;
        let r = s(t, "ref")?;
        let kind = kinds
            .get(r)
            .ok_or_else(|| format!("{id}: kind {r} unknown"))?
            .clone();
        let (parent, slot) = match t.get("parent").and_then(Json::str) {
            None => (ground, None),
            Some(p) => {
                let pid = b.node(p)?;
                match t.get("slot") {
                    Some(sl) if sl.get("room").is_some() => {
                        (b.node(&format!("{p}/{}", s(sl, "room")?))?, None)
                    }
                    Some(sl) if sl.get("n").is_some() => {
                        // One occupant per slot (K11's `slot-over-full`): today a slot may hold several things, so
                        // the first keeps it and each later one stays a plain child at its own place, reported.
                        let n = int(sl, "n")? as u64;
                        match held.get(&(pid, n)) {
                            Some(first) => {
                                b.left_out.push(format!(
                                    "{id} ({r}): slot {n} of {p} already holds {first}; left out of the slot, a plain child at its own place"
                                ));
                                (pid, None)
                            }
                            None => {
                                held.insert((pid, n), id);
                                (pid, Some(n))
                            }
                        }
                    }
                    Some(sl) => {
                        b.notes.push(format!(
                            "{id}: slot {:?} of {p} is not in its bake; placed as a plain child",
                            sl.get("missing")
                        ));
                        (pid, None)
                    }
                    None => (pid, None),
                }
            }
        };
        let mut fields = BTreeMap::new();
        fields.insert(F_DEF, Value::Bytes(s(t, "def")?.as_bytes().to_vec()));
        let hash = need(&f, "kinds")?
            .arr()
            .iter()
            .find(|k| k.get("ref").and_then(Json::str) == Some(r))
            .and_then(|k| k.get("hash"))
            .and_then(Json::str)
            .unwrap_or("");
        fields.insert(F_DEF_HASH, Value::Bytes(hex(hash)?));
        if let Some(n) = t.get("name").and_then(Json::str) {
            fields.insert(F_NAME, b.words(n));
        }
        let sc = int(t, "scale_ppm")?;
        if sc != 1_000_000 {
            fields.insert(F_SCALE, i(sc));
        }
        if let Some(a) = t.get("asset") {
            let hs = a.arr().iter().map(|x| {
                let h = x.str().ok_or_else(|| "an upload's hash".to_owned())?;
                hex(h).map(Value::Bytes)
            });
            fields.insert(F_ASSET, Value::Array(hs.collect::<R<_>>()?));
        }
        if let Some(e) = t.get("entry").and_then(Json::str) {
            fields.insert(F_ENTRY, Value::Text(name(e)?));
        }
        if let Some(d) = t.get("door") {
            fields.insert(
                F_OPEN,
                Value::Uint(u64::from(need(d, "open")?.bool() == Some(true))),
            );
            if let Some(l) = door_of.get(id) {
                fields.insert(F_DOORWAY, l.to_value());
            }
        }
        if let Some(sh) = t.get("shape") {
            if let Some(a) = sh.get("area") {
                fields.insert(F_OUTLINE, points(a)?);
            }
            if let Some(p) = sh.get("path") {
                fields.insert(F_LINE, points(p)?);
            }
            if let Some(w) = sh.get("width").and_then(Json::int) {
                fields.insert(F_LINE_WIDTH, i(w));
            }
        }
        if let Some(w) = t.get("water") {
            fields.insert(F_WATER_LEVEL, i(int(w, "level")?));
        }
        if let Some(sol) = t.get("solids") {
            fields.insert(F_SOLIDS, points(sol)?);
        }
        if let Some(sl) = t.get("slots") {
            let rows = sl
                .arr()
                .iter()
                .map(|x| {
                    let at = need(x, "at")?.arr();
                    let n = |k: usize| at.get(k).and_then(Json::int).ok_or("a slot's at");
                    Ok(Value::Array(vec![
                        i(int(x, "n")?),
                        i(n(0)?),
                        i(n(1)?),
                        i(n(2)?),
                        i(int(x, "yaw")?),
                        i(x.get("capacity").and_then(Json::int).unwrap_or(1)),
                    ]))
                })
                .collect::<R<_>>()?;
            fields.insert(F_SLOTS, Value::Array(rows));
        }
        let mut pose = pose4(need(t, "pose")?)?;
        if let (Some(n), Some(p)) = (slot, t.get("parent").and_then(Json::str))
            && let Some(at) = slot_at.get(&(p, n as i64))
        {
            (0..3).for_each(|k| pose[k] -= at[k]);
        }
        let node = b.add(id, parent, slot, &kind, pose, fields)?;

        // Floors: one node per level its rooms, floors or stairs name, at the thing's origin.
        let mut levels: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
        for r in need(t, "rooms").map(Json::arr).unwrap_or(&[]) {
            levels.entry(int(r, "floor")?).or_default();
        }
        for fl in need(t, "floors").map(Json::arr).unwrap_or(&[]) {
            let y = int(fl, "y")?;
            levels
                .entry(int(fl, "level")?)
                .or_default()
                .push(Value::Array(vec![i(y), points(need(fl, "polygon")?)?]));
        }
        for st in need(t, "stairs").map(Json::arr).unwrap_or(&[]) {
            levels.entry(int(st, "from")?).or_default();
            levels.entry(int(st, "to")?).or_default();
        }
        for (lv, surfaces) in levels {
            let mut ff = BTreeMap::new();
            ff.insert(F_LEVEL, i(lv));
            if !surfaces.is_empty() {
                ff.insert(F_SURFACES, Value::Array(surfaces));
            }
            b.add(
                &format!("{id}/floor-{lv}"),
                node,
                None,
                &full[FLOOR],
                [0; 4],
                ff,
            )?;
        }
        for r in need(t, "rooms").map(Json::arr).unwrap_or(&[]) {
            let rid = s(r, "id")?;
            let floor = b.node(&format!("{id}/floor-{}", int(r, "floor")?))?;
            let mut rf = BTreeMap::new();
            rf.insert(F_NAME, b.words(s(r, "name")?));
            rf.insert(F_LEVEL, i(int(r, "floor")?));
            rf.insert(F_HEIGHT, i(int(r, "height")?));
            rf.insert(F_OUTLINE, points(need(r, "polygon")?)?);
            b.add(
                &format!("{id}/{rid}"),
                floor,
                None,
                &full[ROOM],
                pose4(need(r, "pose")?)?,
                rf,
            )?;
        }
        for o in need(t, "openings").map(Json::arr).unwrap_or(&[]) {
            let oid = s(o, "id")?;
            let okind = s(o, "kind")?;
            let from = o.get("from").and_then(Json::str);
            if okind == "window" {
                let (Some(from), Some(at)) = (from, o.get("inRoom")) else {
                    b.notes.push(format!("{id}/{oid}: a window in no room"));
                    continue;
                };
                let room = b.node(&format!("{id}/{from}"))?;
                let mut wf = BTreeMap::new();
                wf.insert(F_WIDTH, i(int(o, "width")?));
                wf.insert(F_HEIGHT, i(int(o, "height")?));
                wf.insert(F_SILL, i(o.get("sill").and_then(Json::int).unwrap_or(0)));
                wf.insert(F_LEVEL, i(int(o, "level")?));
                b.add(
                    &format!("{id}/{oid}"),
                    room,
                    None,
                    &full[WINDOW],
                    pose4(at)?,
                    wf,
                )?;
                continue;
            }
            let link = doorway_ids[&(id.to_owned(), oid.to_owned())];
            let a = match from {
                Some(r) => b.node(&format!("{id}/{r}"))?,
                None => node,
            };
            let rooms = need(t, "rooms").map(Json::arr).unwrap_or(&[]);
            let floors = need(t, "floors").map(Json::arr).unwrap_or(&[]);
            let z = match o.get("to").and_then(Json::str) {
                Some("outside") | None => ground,
                Some(r)
                    if rooms
                        .iter()
                        .any(|x| x.get("id").and_then(Json::str) == Some(r)) =>
                {
                    b.node(&format!("{id}/{r}"))?
                }
                // Not a room: a floor surface outside the rooms (a balcony). The doorway leads to that floor.
                Some(r) => match floors
                    .iter()
                    .find(|x| x.get("tag").and_then(Json::str) == Some(r))
                {
                    Some(fl) => b.node(&format!("{id}/floor-{}", int(fl, "level")?))?,
                    None => {
                        b.notes.push(format!(
                            "{id}/{oid}: leads to {r}, which is no room or floor; not linked"
                        ));
                        continue;
                    }
                },
            };
            if a == z {
                b.notes.push(format!(
                    "{id}/{oid}: a doorway from {from:?} to itself, not linked"
                ));
                continue;
            }
            let at = need(o, "at")?.arr();
            let xz = |k: usize| at.get(k).and_then(Json::int).ok_or("an opening's at");
            doorway_fields.entry(a).or_default().push(Value::Array(vec![
                link.to_value(),
                Value::Text(label(okind).ok_or("an opening's kind")?),
                i(xz(0)?),
                i(xz(1)?),
                i(int(o, "yaw")?),
                i(int(o, "width")?),
                i(int(o, "height")?),
            ]));
            links.push((link, DOORWAY, [a, z]));
        }
        for st in need(t, "stairs").map(Json::arr).unwrap_or(&[]) {
            let (lo, hi) = (int(st, "from")?, int(st, "to")?);
            let a = b.node(&format!("{id}/floor-{lo}"))?;
            let z = b.node(&format!("{id}/floor-{hi}"))?;
            let link = b.id()?;
            let ty = match s(st, "kind")? {
                "stairs" => "eden:stairs",
                "ramp" => "eden:ramp",
                "ladder" => "eden:ladder",
                _ => "eden:float",
            };
            stair_fields.entry(a).or_default().push(Value::Array(vec![
                link.to_value(),
                Value::Text(name(ty)?),
                i(hi),
                i(int(st, "width")?),
                i(int(st, "y0")?),
                i(int(st, "y1")?),
                points(need(st, "path")?)?,
            ]));
            links.push((link, ty, [a, z]));
        }
    }

    // --- Named places that are not rooms: nodes under the open ground, holding nobody. -------------------------------
    for p in need(&f, "places")?.arr() {
        let mut pf = BTreeMap::new();
        pf.insert(F_NAME, b.words(s(p, "name")?));
        let kind = s(p, "kind")?;
        pf.insert(F_PLACE_KIND, b.label(kind));
        pf.insert(
            F_PLACE_OF,
            Value::Text(label(s(p, "of")?).ok_or("a place's of")?),
        );
        if let Some(poly) = p.get("polygon") {
            pf.insert(F_OUTLINE, points(poly)?);
        }
        if let Some(line) = p.get("line") {
            pf.insert(F_LINE, points(line)?);
            pf.insert(F_LINE_WIDTH, i(int(p, "width")?));
        }
        if let Some(l) = p.get("level").and_then(Json::int) {
            pf.insert(F_WATER_LEVEL, i(l));
        }
        b.add(s(p, "id")?, ground, None, &full[PLACE], [0; 4], pf)?;
    }

    // Link geometry onto the owning ends.
    for sp in &mut b.specs {
        if let Some(rows) = doorway_fields.remove(&sp.id) {
            sp.fields.insert(F_DOORWAYS, Value::Array(rows));
        }
        if let Some(rows) = stair_fields.remove(&sp.id) {
            sp.fields.insert(F_STAIRS, Value::Array(rows));
        }
    }

    // --- Commit: every node by its parent's entry, parents first; then every link by its owning end. -----------------
    let mut tree = Tree::start(root, name(&full[WORLD])?);
    let header = header(root, &rules)?;
    let mut below: HashMap<Id, Vec<usize>> = HashMap::new();
    for (k, sp) in b.specs.iter().enumerate() {
        below.entry(sp.parent).or_default().push(k);
    }
    let mut effects = Vec::with_capacity(b.specs.len() + links.len());
    let mut queue = VecDeque::from([root]);
    let mut placed = 0usize;
    while let Some(p) = queue.pop_front() {
        for k in below.remove(&p).unwrap_or_default() {
            let sp = &b.specs[k];
            let [x, y, z, yaw] = sp.pose;
            let um = |v: i64| v.checked_mul(1000).ok_or("a position out of range");
            let pose = Pose {
                frame: Frame {
                    node: sp.parent,
                    slot: sp.slot,
                },
                position: Vec3::new(um(x)?, um(y)?, um(z)?),
                orientation: Quat::from_yaw_mdeg(yaw).map_err(|e| format!("{e:?}"))?,
                support: match sp.slot {
                    Some(_) => Support::Slot,
                    None => Support::Surface {
                        surface: sp.parent,
                        height: 0,
                    },
                },
            };
            let create = Change::Create {
                node: sp.id,
                kind: name(&sp.kind)?,
                pose,
                audience: Audience::Everyone,
                fields: sp.fields.clone(),
            };
            effects.push(entry(effects.len() as u64, sp.parent, vec![create]));
            queue.push_back(sp.id);
            placed += 1;
        }
    }
    if placed != b.specs.len() {
        let lost: Vec<String> = below
            .values()
            .flatten()
            .take(5)
            .map(|k| {
                let sp = &b.specs[*k];
                let key = b
                    .nodes
                    .iter()
                    .find(|(_, v)| **v == sp.parent)
                    .map_or("?", |(k, _)| k.as_str());
                format!("parent {key}")
            })
            .collect();
        return Err(format!(
            "{} nodes have no parent in the tree: {lost:?}",
            b.specs.len() - placed
        ));
    }
    let made: BTreeSet<Id> = b.specs.iter().map(|sp| sp.id).collect();
    let key_of = |id: &Id| {
        b.nodes
            .iter()
            .find(|(_, v)| *v == id)
            .map_or("?".to_owned(), |(k, _)| k.clone())
    };
    let missing: Vec<String> = links
        .iter()
        .flat_map(|(_, _, ends)| ends.iter())
        .filter(|e| **e != root && !made.contains(e))
        .map(key_of)
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "{} link ends are no node: {:?}",
            missing.len(),
            &missing[..missing.len().min(8)]
        ));
    }
    for (link, ty, ends) in &links {
        let change = Change::Link {
            link: *link,
            ty: name(ty)?,
            ends: *ends,
            owner: End::First,
            audience: Audience::Everyone,
        };
        effects.push(entry(effects.len() as u64, ends[0], vec![change]));
    }
    let part_bytes = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(header.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ])))
    .map_err(|e| e.to_string())?;
    let part = Part::read(&part_bytes).map_err(|e| format!("{}: {}", e.name, e.detail))?;
    tree.commit(&header, &part, &rules)
        .map_err(|e| format!("commit refused: {}: {}", e.name, e.detail))?;

    let mut bake = BTreeMap::new();
    if let Json::Obj(o) = need(&f, "bake")? {
        for (k, v) in o {
            bake.insert(k.clone(), v.int().unwrap_or(0));
        }
    }
    let mut by_ref = BTreeMap::new();
    if let Json::Obj(o) = need(&f, "byRef")? {
        for (k, v) in o {
            by_ref.insert(k.clone(), v.int().unwrap_or(0));
        }
    }
    Ok(Import {
        tree,
        rules,
        nodes: b.nodes,
        kinds,
        texts: b.texts,
        bake,
        by_ref,
        notes: b.notes,
        left_out: b.left_out,
        forms,
        log: (
            encode(&header.to_value()).map_err(|e| e.to_string())?,
            part_bytes,
        ),
        effects,
    })
}

/// The open ground's fields: its terrain tiles (`F_TILE_SIZE`, `F_TILES`), byte for byte as exported, when the facts
/// have a ground.
fn terrain(f: &Json) -> R<BTreeMap<u64, Value>> {
    let mut out = BTreeMap::new();
    let Some(g) = f.get("ground") else {
        return Ok(out);
    };
    let mut tiles = Vec::new();
    for t in need(g, "tiles")?.arr() {
        let heights = base64(s(t, "heights")?)?;
        let classes = base64(s(t, "classes")?)?;
        let n = classes.len().isqrt();
        if n == 0 || n * n != classes.len() || heights.len() != (n + 1) * (n + 1) * 4 {
            return Err(format!(
                "a terrain tile has {} height bytes and {} class bytes",
                heights.len(),
                classes.len()
            ));
        }
        tiles.push(Value::Array(vec![
            i(int(t, "tx")?),
            i(int(t, "tz")?),
            Value::Bytes(heights),
            Value::Bytes(classes),
        ]));
    }
    out.insert(F_TILE_SIZE, i(int(g, "tileM")? * 1000));
    out.insert(F_TILES, Value::Array(tiles));
    Ok(out)
}

/// Standard base64 (RFC 4648), as Node's `Buffer.toString('base64')` writes it.
pub fn base64(t: &str) -> R<Vec<u8>> {
    let digit = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let b = t.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(b.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for &c in b {
        acc = (acc << 6 | u32::from(digit(c).ok_or("not base64")?)) & 0xff_ffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

fn entry(sequence: u64, node: Id, changes: Vec<Change>) -> Effect {
    Effect {
        envelope: Envelope {
            sequence,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node,
        },
        body: Body::Changes(
            changes
                .into_iter()
                .map(|change| ChangeRec {
                    change,
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: None,
        rest: Rest::new(),
    }
}

/// The import's one header: this build, the schema by hash, the zone rooted at `zone`, epoch 0, and every kind pinned.
pub fn header(zone: Id, rules: &Rules) -> R<Header> {
    let build = Hash::of(Purpose::Fixture, b"souls/import-eden/1").to_bytes();
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(build)),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                rules
                    .kinds
                    .keys()
                    .map(|k| name(k).map(Value::Text))
                    .collect::<R<_>>()?,
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("{}: {}", e.name, e.detail))
}

/// One row of the count table: what the tree holds and what the replayed model's bake says.
pub struct Row {
    pub what: String,
    pub tree: i64,
    pub bake: i64,
}

/// Counts the tree by walking it from the root (children lists, never a scan of the node array) and its links, and
/// sets them beside the bake's.
pub fn count(im: &Import) -> (Vec<Row>, BTreeMap<String, i64>, BTreeMap<String, i64>) {
    let t = &im.tree;
    let mut c: BTreeMap<&str, i64> = BTreeMap::new();
    let mut by_ref: BTreeMap<String, i64> = BTreeMap::new();
    let mut places: BTreeMap<String, i64> = BTreeMap::new();
    let mut link_ids: BTreeSet<Id> = BTreeSet::new();
    let mut queue = VecDeque::from([t.root()]);
    let len = |v: Option<&Value>| match v {
        Some(Value::Array(a)) => a.len() as i64,
        _ => 0,
    };
    while let Some(h) = queue.pop_front() {
        let n = t.node(h).expect("a live node");
        let k = plain(n.kind().as_str());
        let f = n.fields();
        match k {
            WORLD | GROUND => {}
            FLOOR => {
                *c.entry("floors").or_default() += 1;
                *c.entry("floor surfaces").or_default() += len(f.get(&F_SURFACES));
            }
            ROOM => *c.entry("rooms").or_default() += 1,
            WINDOW => *c.entry("windows").or_default() += 1,
            PLACE => {
                if let Some(Value::Text(of)) = f.get(&F_PLACE_OF) {
                    *places.entry(format!("places {}", of.as_str())).or_default() += 1;
                }
            }
            _ => {
                *c.entry("things").or_default() += 1;
                if let Some(Value::Bytes(d)) = f.get(&F_DEF) {
                    *by_ref
                        .entry(String::from_utf8_lossy(d).into_owned())
                        .or_default() += 1;
                }
                if f.contains_key(&F_OPEN) {
                    *c.entry("doors").or_default() += 1;
                }
                if f.contains_key(&F_DOORWAY) {
                    *c.entry("doors in a doorway").or_default() += 1;
                }
                *c.entry("solids").or_default() += len(f.get(&F_SOLIDS));
                *c.entry("slots").or_default() += len(f.get(&F_SLOTS));
            }
        }
        for e in t.links_of(h).expect("a live node") {
            link_ids.insert(e.link);
        }
        queue.extend(t.children(h).expect("a live node").iter().copied());
    }
    let mut ty: BTreeMap<String, i64> = BTreeMap::new();
    for l in &link_ids {
        let (name, ..) = t.link(*l).expect("a link");
        *ty.entry(name.as_str().to_owned()).or_default() += 1;
    }
    let get = |m: &BTreeMap<String, i64>, k: &str| m.get(k).copied().unwrap_or(0);
    let rows = [
        ("things", c.get("things"), "things"),
        ("doors", c.get("doors"), "doors"),
        ("rooms", c.get("rooms"), "rooms"),
        ("floors", c.get("floors"), "floors"),
        ("floor surfaces", c.get("floor surfaces"), "floor surfaces"),
        ("solids", c.get("solids"), "solids"),
        ("slots (not rooms)", c.get("slots"), "slots"),
        ("windows (nodes)", c.get("windows"), "windows"),
        ("doorways (links)", Some(&get(&ty, DOORWAY)), "doorways"),
        (
            "stairs (links)",
            Some(&get(&ty, "eden:stairs")),
            "stairs:stairs",
        ),
    ]
    .into_iter()
    .map(|(what, tree, bk)| Row {
        what: what.to_owned(),
        tree: tree.copied().unwrap_or(0),
        bake: get(&im.bake, bk),
    })
    .collect::<Vec<_>>();
    let mut extra = places;
    extra.insert(
        "doors in a doorway".into(),
        c.get("doors in a doorway").copied().unwrap_or(0),
    );
    for (k, v) in ty {
        extra.insert(format!("link {k}"), v);
    }
    (rows, by_ref, extra)
}

/// A node's position in the world frame, in micrometres: its pose composed up the tree with T4's quaternions, from
/// the root down, a node in a slot at the slot's point plus its pose (T4's carry). `None` for an id that is no node
/// here.
pub fn world_of(im: &Import, id: Id) -> Option<Vec3> {
    let t = &im.tree;
    let mut chain = Vec::new();
    let mut at = Some(t.handle(id)?);
    while let Some(h) = at {
        let n = t.node(h)?;
        let parent = n.parent().and_then(|p| t.handle(p));
        if let Some(p) = n.place() {
            let point = match (n.slot(), parent) {
                (Some(s), Some(ph)) => slot_point(t.node(ph)?.fields(), s)?,
                _ => Vec3::ZERO,
            };
            chain.push((point.plus(p.position).ok()?, p.orientation));
        }
        at = parent;
    }
    let (mut pos, mut rot) = (Vec3::ZERO, Quat::IDENTITY);
    for (position, orientation) in chain.iter().rev() {
        pos = pos.plus(rot.rotate(*position).ok()?).ok()?;
        rot = rot.then(*orientation).ok()?;
    }
    Some(pos)
}

/// Slot `n`'s point (field 13's `[n, x, y, z, …]` mm) in micrometres.
fn slot_point(fields: &BTreeMap<u64, Value>, n: u64) -> Option<Vec3> {
    let num = |v: &Value| match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(u) => i64::try_from(*u).ok().map(|u| -u - 1),
        _ => None,
    };
    let Value::Array(rows) = fields.get(&F_SLOTS)? else {
        return None;
    };
    rows.iter().find_map(|r| match r {
        Value::Array(r) if r.first().and_then(num) == i64::try_from(n).ok() => Some(Vec3::new(
            num(r.get(1)?)? * 1000,
            num(r.get(2)?)? * 1000,
            num(r.get(3)?)? * 1000,
        )),
        _ => None,
    })
}

/// C13 (#3440): how far a stand point must lie from a solid for a body to stand there, mm: the standard body's radius
/// (280) and the margin the walked ground is cut with (60), as `sim::ground` cuts it (`HUMAN_RADIUS`, `MARGIN`), and 20
/// for the cut's rounding. A box is grown by it on every side, corners square.
pub const STAND_CLEAR: i64 = 360;
/// A body's height span above its floor, mm (`sim::ground::BODY_LOW`, `BODY_HIGH`): a solid outside it never blocks.
const BODY_SPAN: (i64, i64) = (220, 1_800);
/// The farthest a stand point is moved, mm.
const STAND_MOVE_MOST: i64 = 1_500;

/// The solids (field 12's rows, mm, the thing's frame) of the first thing of each kind, by the kind's plain name.
fn solids_by_kind(im: &Import) -> BTreeMap<String, Vec<Vec<i64>>> {
    let num = |v: &Value| match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(u) => i64::try_from(*u).ok().map(|u| -u - 1),
        _ => None,
    };
    let mut out = BTreeMap::new();
    for id in im.nodes.values() {
        let Some(n) = im.tree.handle(*id).and_then(|h| im.tree.node(h)) else {
            continue;
        };
        let kind = plain(n.kind().as_str());
        if out.contains_key(kind) {
            continue;
        }
        if let Some(Value::Array(rows)) = n.fields().get(&F_SOLIDS) {
            let rows = rows
                .iter()
                .filter_map(|r| match r {
                    Value::Array(r) => r.iter().map(num).collect::<Option<Vec<i64>>>(),
                    _ => None,
                })
                .collect();
            out.insert(kind.to_owned(), rows);
        }
    }
    out
}

/// Whether a body stands clear of `solids` at `(x, z)` mm: outside each box that meets its height span, grown by
/// [`STAND_CLEAR`].
fn stands_clear(solids: &[Vec<i64>], x: i64, z: i64) -> bool {
    solids.iter().all(|s| {
        let [cx, cz, hx, hz, yaw, y0, y1, ..] = s[..] else {
            return true;
        };
        if y1 <= BODY_SPAN.0 || y0 >= BODY_SPAN.1 {
            return true;
        }
        // The point in the box's own axes: turned back by the box's yaw.
        let Ok(q) = Quat::from_yaw_mdeg(-yaw) else {
            return true;
        };
        let Ok(p) = q.rotate(Vec3::new((x - cx) * 1000, 0, (z - cz) * 1000)) else {
            return true;
        };
        p.x.abs() > (hx + STAND_CLEAR) * 1000 || p.z.abs() > (hz + STAND_CLEAR) * 1000
    })
}

fn obj_mut<'a>(
    v: &'a mut replica::rules::json::Value,
    key: &str,
) -> Option<&'a mut replica::rules::json::Value> {
    match v {
        replica::rules::json::Value::Obj(o) => o.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

/// C13 (#3440): each stand point of `entries` (`(kind, souls-entry/1 entry)`, as `worldd seed` reads them; a point
/// whose role is `stand`, which a form walks to by name or as a slot's `stand`) that lies within [`STAND_CLEAR`] of
/// its own kind's solids (those of the kind's first thing in the import) is moved straight out from the thing's
/// middle, 10 mm at a time and at most [`STAND_MOVE_MOST`], until clear. A body could not stand there: the walk to it
/// answered `souls:no-way`. Returns the import report's lines, one for each point moved or left where it was.
pub fn clear_stand_points(
    im: &Import,
    entries: &mut [(String, replica::rules::json::Value)],
) -> Vec<String> {
    use replica::rules::json::Value as J;
    let solids = solids_by_kind(im);
    let mut report = Vec::new();
    for (kind, entry) in entries.iter_mut() {
        let Some(solids) = solids.get(kind.as_str()) else {
            continue;
        };
        let Some(J::Obj(points)) = obj_mut(entry, "points") else {
            continue;
        };
        for (name, p) in points.iter_mut() {
            if p.get("role").and_then(J::str) != Some("stand") {
                continue;
            }
            let Some(J::Arr(at)) = obj_mut(p, "at_mm") else {
                continue;
            };
            let (Some(J::Int(x)), Some(J::Int(z))) = (at.first(), at.get(2)) else {
                continue;
            };
            let (Ok(x), Ok(z)) = (i64::try_from(*x), i64::try_from(*z)) else {
                continue;
            };
            if stands_clear(solids, x, z) {
                continue;
            }
            let len =
                i64::try_from((i128::from(x).pow(2) + i128::from(z).pow(2)).isqrt()).unwrap_or(0);
            let to = (1..=STAND_MOVE_MOST / 10)
                .map(|k| len + k * 10)
                .filter(|_| len > 0)
                .map(|l| (x * l / len, z * l / len))
                .find(|&(x, z)| stands_clear(solids, x, z));
            match to {
                Some((nx, nz)) => {
                    at[0] = J::Int(i128::from(nx));
                    at[2] = J::Int(i128::from(nz));
                    report.push(format!(
                        "{kind} {name}: moved clear of its own solids, [{x}, {z}] -> [{nx}, {nz}] mm"
                    ));
                }
                None => report.push(format!(
                    "{kind} {name}: left at [{x}, {z}] mm, no clear spot within {STAND_MOVE_MOST} mm straight out"
                )),
            }
        }
    }
    report
}

/// A seat an entry declares on one thing (C17, #3453): a slot that admits a body, in the thing's own axes, µm.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BodySlot {
    pub thing: Id,
    /// The slot's number, 1, 2, ... in the entry's order (as the form runner numbers slots).
    pub slot: u64,
    /// Whether the slot's posture is `lie` (a bed's), else a sit.
    pub lie: bool,
    /// The slot's point; its height above the thing's floor is `at.y`.
    pub at: Vec3,
    /// The slot's stand point (the point its `stand` names), where a body stands to take it and is set back.
    pub stand: Vec3,
}

/// Every slot that admits a body ([`BodySlot`]) on the things of `tree` whose kind's entry (`entries`, `(kind,
/// souls-entry/1 entry)` as `worldd seed` reads them) declares one, by thing id and slot (C19, #3457: a sofa's three,
/// a bed's two); and the count of every such slot on those things. A slot with no stand point, or a point not in whole
/// millimetres, is left out.
pub fn body_slots(
    tree: &Tree,
    entries: &[(String, replica::rules::json::Value)],
) -> (Vec<BodySlot>, usize) {
    use replica::rules::json::Value as J;
    let um = |v: Option<&J>| -> Option<Vec3> {
        match v.and_then(J::arr)? {
            [J::Int(x), J::Int(y), J::Int(z)] => Some(Vec3::new(
                i64::try_from(*x).ok()? * 1000,
                i64::try_from(*y).ok()? * 1000,
                i64::try_from(*z).ok()? * 1000,
            )),
            _ => None,
        }
    };
    // Each kind's body slots, in the entry's order: (number, lie, at, stand).
    let mut by_kind: BTreeMap<&str, Vec<(u64, bool, Vec3, Vec3)>> = BTreeMap::new();
    for (kind, e) in entries {
        let slots = e.get("slots").and_then(J::obj).unwrap_or(&[]);
        let found: Vec<_> = (1u64..)
            .zip(slots)
            .filter(|(_, (_, d))| d.get("admits").and_then(J::str) == Some("body"))
            .filter_map(|(n, (_, d))| {
                let stand = d.get("stand").and_then(J::str)?;
                let stand = um(e.get("points")?.get(stand)?.get("at_mm"))?;
                let lie = d.get("posture").and_then(J::str) == Some("lie");
                Some((n, lie, um(d.get("at_mm"))?, stand))
            })
            .collect();
        if !found.is_empty() {
            by_kind.insert(plain(kind), found);
        }
    }
    let (mut out, mut all) = (Vec::new(), 0);
    let mut next = vec![tree.root()];
    while let Some(h) = next.pop() {
        next.extend(tree.children(h).unwrap_or(&[]).iter().copied());
        let Some(n) = tree.node(h) else { continue };
        let Some(found) = by_kind.get(plain(n.kind().as_str())) else {
            continue;
        };
        all += found.len();
        out.extend(found.iter().map(|&(slot, lie, at, stand)| BodySlot {
            thing: n.id(),
            slot,
            lie,
            at,
            stand,
        }));
    }
    out.sort_by_key(|s| (s.thing, s.slot));
    (out, all)
}
