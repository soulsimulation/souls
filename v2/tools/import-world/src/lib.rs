//! Engine v2 X6 (#2819): one world's built content, from the facts file the exporter wrote from a backup of its
//! database (`node v2/tools/import-eden/export/export.ts --backup <file>`), loaded by N1's loader into a tree and set
//! out as the release owner's row: counts, differences with their reasons, uploads, things with no Soul Actions entry,
//! clean or not, and the import's hash.
//!
//! The difference list is against the backup itself, the catalog today's server keeps for the world: every thing row in
//! the backup is a node (or listed), the tree's counts equal what today's model bakes from it (N1's table), and every
//! upload the world holds is named by a thing (or listed, kept by hash with the world's uploads).

use import_eden::json::{self, Json};
use import_eden::{F_ASSET, F_ENTRY, count, load};
use replica::encode::Value;
use replica::ids::sha256;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub mod ways;

/// One difference: what, which ids, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Difference {
    pub what: String,
    pub ids: Vec<String>,
    pub reason: String,
    /// A difference with a known reason leaves the world clean; an unexplained one does not.
    pub explained: bool,
}

/// The row for one world.
#[derive(Clone, Debug, Default)]
pub struct World {
    pub world: String,
    pub backup_sha256: String,
    pub loaded: bool,
    pub nodes: usize,
    pub links: usize,
    /// things, rooms, floors, doors, doorways, stairs, windows, places.
    pub counts: BTreeMap<String, i64>,
    /// Today's thing rows in the backup.
    pub rows: usize,
    pub uploads: Vec<String>,
    /// Uploads some thing node names by hash.
    pub uploads_named: usize,
    /// Thing nodes that name their kind's entry.
    pub with_entry: usize,
    /// Today's def ref -> (why it has no entry, the things).
    pub no_entry: BTreeMap<String, (String, Vec<String>)>,
    pub differences: Vec<Difference>,
    /// Any motion, flight, timer or time effect in the imported state (there must be none: no history comes over).
    pub history: bool,
    /// SHA-256 over the tree's state hash and the uploads' hashes, hex.
    pub hash: String,
    /// W9 (#4085): the floors and seats' stand points a walk reaches from the arrival point and no walk leaves
    /// ([`ways::ways`]), or why the check did not run; `None` when it was not asked for.
    pub ways: Option<Result<ways::Ways, String>>,
}

impl World {
    pub fn clean(&self) -> bool {
        self.loaded && self.differences.iter().all(|d| d.explained)
    }
    pub fn no_entry_things(&self) -> usize {
        self.no_entry.values().map(|(_, ids)| ids.len()).sum()
    }
}

#[derive(Clone, Copy, PartialEq)]
enum LeftOut {
    WindowNoRoom,
}

/// What a loader note leaves out on purpose (W2b, 0.133), if anything. A flight within one storey is walked as that
/// floor (0.133); one the loader notes rises more than a step, a piece cut off, which nothing explains.
fn left_out(note: &str) -> Option<LeftOut> {
    note.ends_with(": a window in no room")
        .then_some(LeftOut::WindowNoRoom)
}

fn notes_like(notes: &[String], what: LeftOut) -> i64 {
    notes.iter().filter(|n| left_out(n) == Some(what)).count() as i64
}

/// Why the loader leaves it out, or None for a note nobody has explained.
fn note_reason(note: &str) -> Option<&'static str> {
    Some(match left_out(note)? {
        // import-eden: a window node belongs to a room, the one it looks out of or, in no room's wall (a serving
        // hatch), the nearest; a thing with no rooms (a lantern's glazing) has none. The thing keeps its solids and
        // its look.
        LeftOut::WindowNoRoom => {
            "explained: its thing has no rooms, so no room to look out of; the thing keeps its walls and look"
        }
    })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The row for one facts file.
pub fn row(text: &str) -> World {
    row_with(text, None)
}

/// The row for one facts file, with the walks of [`ways::ways`] from `opts` when given (once the world loads).
pub fn row_with(text: &str, opts: Option<&ways::Opts>) -> World {
    let mut w = row_of(text);
    if let (true, Some(o)) = (w.loaded, opts) {
        w.ways = Some(ways::ways(text, o));
    }
    w
}

fn row_of(text: &str) -> World {
    let mut w = World::default();
    let f = match json::parse(text) {
        Ok(f) => f,
        Err(e) => {
            w.differences.push(Difference {
                what: "facts".into(),
                ids: vec![],
                reason: format!("unreadable: {e}"),
                explained: false,
            });
            return w;
        }
    };
    let txt = |j: Option<&Json>| j.and_then(Json::str).unwrap_or("").to_owned();
    w.world = txt(f.get("world"));
    w.backup_sha256 = txt(f.get("backup").and_then(|b| b.get("sha256")));
    if let Some(e) = f.get("error").and_then(Json::str) {
        w.differences.push(Difference {
            what: "export".into(),
            ids: vec![],
            reason: format!("the backup did not export: {e}"),
            explained: false,
        });
        return w;
    }
    let rows: Vec<String> = f
        .get("entityRows")
        .map(Json::arr)
        .unwrap_or(&[])
        .iter()
        .map(|j| txt(Some(j)))
        .collect();
    w.rows = rows.len();
    w.uploads = f
        .get("uploads")
        .map(Json::arr)
        .unwrap_or(&[])
        .iter()
        .map(|u| txt(u.get("sha")))
        .collect();
    w.uploads.sort();
    for t in f.get("things").map(Json::arr).unwrap_or(&[]) {
        if let Some(why) = t.get("noEntry").and_then(Json::str) {
            let e = w
                .no_entry
                .entry(txt(t.get("ref")))
                .or_insert_with(|| (why.to_owned(), vec![]));
            e.1.push(txt(t.get("id")));
        }
    }

    let im = match load(text) {
        Ok(im) => im,
        Err(e) => {
            w.differences.push(Difference {
                what: "load".into(),
                ids: vec![],
                reason: format!("the loader refused the world: {e}"),
                explained: false,
            });
            return w;
        }
    };
    w.loaded = true;
    (w.nodes, w.links) = im.tree.counts();

    // Counts beside the bake (N1's table): an unequal count is an unexplained difference.
    let (table, by_ref, extra) = count(&im);
    for r in &table {
        let key = match r.what.as_str() {
            "things" | "doors" | "rooms" | "floors" => r.what.clone(),
            "windows (nodes)" => "windows".into(),
            "doorways (links)" => "doorways".into(),
            "stairs (links)" => "stairs".into(),
            _ => String::new(),
        };
        if !key.is_empty() {
            w.counts.insert(key, r.tree);
        }
        if r.tree != r.bake {
            // W2b: a window of a thing with no rooms is left out by design (`note_reason`), so a count short by exactly
            // those is explained.
            let skipped = match r.what.as_str() {
                "windows (nodes)" => notes_like(&im.notes, LeftOut::WindowNoRoom),
                _ => 0,
            };
            let explained = skipped > 0 && r.tree + skipped == r.bake;
            w.differences.push(Difference {
                what: format!("count {}", r.what),
                ids: vec![format!("tree {}, bake {}", r.tree, r.bake)],
                reason: if explained {
                    format!("explained: {skipped} left out by design (the loader notes below)")
                } else {
                    "unexplained: the tree's count is not the model's".into()
                },
                explained,
            });
        }
    }
    let places: i64 = extra
        .iter()
        .filter(|(k, _)| k.starts_with("places "))
        .map(|(_, v)| v)
        .sum();
    w.counts.insert("places".into(), places);
    for (k, v) in &im.by_ref {
        let t = by_ref.get(k).copied().unwrap_or(0);
        if t != *v {
            w.differences.push(Difference {
                what: format!("things of {k}"),
                ids: vec![format!("tree {t}, bake {v}")],
                reason: "unexplained: the tree's count is not the model's".into(),
                explained: false,
            });
        }
    }
    let lost: Vec<String> = rows
        .iter()
        .filter(|id| !im.nodes.contains_key(*id))
        .cloned()
        .collect();
    if !lost.is_empty() {
        w.differences.push(Difference {
            what: "things in the backup with no node".into(),
            ids: lost,
            reason: "unexplained".into(),
            explained: false,
        });
    }
    for n in &im.notes {
        let why = note_reason(n);
        w.differences.push(Difference {
            what: "loader note".into(),
            ids: vec![],
            reason: match why {
                Some(why) => format!("{n}: {why}"),
                None => n.clone(),
            },
            explained: why.is_some(),
        });
    }

    // Uploads named by a thing, entries named, and any history in the state.
    let t = &im.tree;
    let mut named: BTreeSet<String> = BTreeSet::new();
    let mut queue = VecDeque::from([t.root()]);
    while let Some(h) = queue.pop_front() {
        let n = t.node(h).expect("a live node");
        if let Some(Value::Array(a)) = n.fields().get(&F_ASSET) {
            for v in a {
                if let Value::Bytes(b) = v {
                    named.insert(hex(b));
                }
            }
        }
        if n.fields().contains_key(&F_ENTRY) {
            w.with_entry += 1;
        }
        if n.moved().is_some() {
            w.history = true;
        }
        queue.extend(t.children(h).expect("a live node").iter().copied());
    }
    w.uploads_named = w.uploads.iter().filter(|u| named.contains(*u)).count();
    let unnamed: Vec<String> = w
        .uploads
        .iter()
        .filter(|u| !named.contains(*u))
        .cloned()
        .collect();
    if !unnamed.is_empty() {
        w.differences.push(Difference {
            what: "uploads no thing names".into(),
            ids: unnamed,
            reason: "uploaded and placed nowhere: kept by hash with the world's uploads".into(),
            explained: true,
        });
    }
    let state = t.to_state();
    if let Value::Map(m) = state.to_value() {
        w.history |= m.keys().any(|k| *k >= 4);
    }
    let mut input = match state.hash() {
        Ok(h) => h.to_bytes(),
        Err(e) => {
            w.differences.push(Difference {
                what: "hash".into(),
                ids: vec![],
                reason: format!("{}: {}", e.name, e.detail),
                explained: false,
            });
            return w;
        }
    };
    for u in &w.uploads {
        input.extend(u.as_bytes());
    }
    w.hash = hex(&sha256(&input));
    w
}
