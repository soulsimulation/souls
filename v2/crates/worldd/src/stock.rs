//! A world's stock and its libraries (#4837): what its containers hold when it starts, assigned by rule
//! (`souls-world-stock/1`, `content/worlds/<world>/stock.json`), and the library rows a yielded thing carries by
//! reference (`souls-library/1`, `content/library/<name>.json`: a book's title and first page). No code here names a
//! kind, a field or a library.
//!
//! - **In the world's folder.** `worldd seed --stock <stock.json>` keeps the file as `stock.json` and each library it
//!   names as `library/<name>.json`; every start reads them ([`Data::read`]). A world with no `stock.json` has no stock
//!   here: a take makes its kind with no carried fields, as before.
//! - **Each copy's row** is worked out from the facts at each start ([`World::of`]), in the facts' order (the
//!   template's): a copy's room is the room slot it, or a thing it stands in, holds (`slot.room`); its building is its
//!   outermost holder's name; its name its own. A row's `where` matches each named key by prefix (all keys given;
//!   `{}` matches every copy), and the first row of the copy's entry that matches is its row. A row's copies are
//!   numbered 0, 1, 2 in that order.
//! - **A row naming a stock** (a section of its entry: `{kind, count, take, carries}`) makes each copy a stocked
//!   container ([`sim::forms::Stocked`]): its pile holds `count` rows of the draw's pool from `k * count`, and a take
//!   yields the row at the top. **A row naming none** names copies of a yielded kind placed in the world: each
//!   carries the top row of its own pile, written into the import when the world is seeded ([`World::placed`]).
//! - **The pool** is the library's rows whose tags meet the draw's (all rows with none), in library order. A row's
//!   carried fields are the yielded kind's text fields the stock names, each a reference (`{21: id}`, T8) to the row's
//!   words ([`reference`]): made from the library's name, the field's name and the row's place in the library, never
//!   from the words, so the log holds no word of it. Rows are only appended, so a reference keeps its words.
//! - **Served as public words.** A reference's words are the world's own content, everyone's: beside a records
//!   answer they go with the store's public words ([`World::words`], `views::names::attach_words`).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use replica::audience::REFERENCE;
use replica::encode::Value;
use replica::ids::{Id, Scope, sha256};
use replica::rules::json::{self, Value as Json};
use replica::tree::Tree;
use sim::forms::{Stocked, Stocks};

type R<T> = Result<T, String>;

/// The stock file in a world's folder, and the folder its libraries are kept in.
pub const FILE: &str = "stock.json";
pub const LIBRARIES: &str = "library";

/// The reference to the words of field `field` of row `row` (its place in the library, from 0) of library `library`:
/// a scope of the library and the field, the row's place plus one its counter.
pub fn reference(library: &str, field: &str, row: usize) -> Option<Id> {
    let h = sha256(format!("souls/library/1\0{library}\0{field}").as_bytes());
    let mut s = [0; 16];
    s.copy_from_slice(&h[..16]);
    Id::new(Scope(s), u64::try_from(row).ok()?.checked_add(1)?)
}

/// A world's stock file and its libraries, as read.
pub struct Data {
    pub stock: Json,
    pub libraries: BTreeMap<String, Json>,
}

impl Data {
    /// The stock file `path` and the libraries it names, each found under the nearest folder above the file that
    /// holds it (`content/library/books.json` from `content/worlds/eden/stock.json`).
    pub fn load(path: &Path) -> R<Data> {
        let stock = read(path)?;
        let mut libraries = BTreeMap::new();
        for (name, at) in stock.get("libraries").and_then(Json::obj).unwrap_or(&[]) {
            let rel = at
                .str()
                .ok_or(format!("stock-library: {name} names no file"))?;
            let found = path
                .ancestors()
                .skip(1)
                .map(|a| a.join(rel))
                .find(|p| p.is_file())
                .ok_or(format!(
                    "stock-library: {rel} not found above {}",
                    path.display()
                ))?;
            libraries.insert(name.clone(), read(&found)?);
        }
        Ok(Data { stock, libraries })
    }

    /// The world folder's stock file and libraries (`stock.json`, `library/<name>.json`), or none without the file.
    pub fn read(dir: &Path) -> R<Option<Data>> {
        let path = dir.join(FILE);
        if !path.is_file() {
            return Ok(None);
        }
        let stock = read(&path)?;
        let mut libraries = BTreeMap::new();
        for (name, _) in stock.get("libraries").and_then(Json::obj).unwrap_or(&[]) {
            let p = dir.join(LIBRARIES).join(format!("{name}.json"));
            libraries.insert(name.clone(), read(&p)?);
        }
        Ok(Some(Data { stock, libraries }))
    }

    /// Keeps the stock file and its libraries in world folder `dir`, as [`Data::read`] reads them.
    pub fn keep(&self, dir: &Path) -> R<()> {
        std::fs::create_dir_all(dir.join(LIBRARIES)).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(FILE), self.stock.to_json()).map_err(|e| e.to_string())?;
        for (name, lib) in &self.libraries {
            let p = dir.join(LIBRARIES).join(format!("{name}.json"));
            std::fs::write(&p, lib.to_json()).map_err(|e| format!("{}: {e}", p.display()))?;
        }
        Ok(())
    }
}

fn read(path: &Path) -> R<Json> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    json::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// A world's stock as its start works it out.
#[derive(Default)]
pub struct World {
    /// The stocked containers, by node.
    pub stocks: Arc<Stocks>,
    /// The placed copies of a yielded kind, by node, with the fields each carries.
    pub placed: BTreeMap<Id, BTreeMap<u64, Value>>,
    /// Every library row's words, by reference.
    pub words: Arc<BTreeMap<Id, Vec<u8>>>,
    /// The rows left out, each with why: an entry, a stock, a field or a library the world lacks.
    pub notes: Vec<String>,
}

/// A facts thing as a row's `where` reads it.
struct Copy<'a> {
    id: &'a str,
    name: &'a str,
    room: Option<&'a str>,
    building: Option<&'a str>,
}

fn copies(facts: &Json) -> Vec<Copy<'_>> {
    let things = facts.get("things").and_then(Json::arr).unwrap_or(&[]);
    let by: BTreeMap<&str, &Json> = things
        .iter()
        .filter_map(|t| Some((t.get("id")?.str()?, t)))
        .collect();
    let parent = |t: &Json| by.get(t.get("parent")?.str()?).copied();
    things
        .iter()
        .filter_map(|t| {
            let id = t.get("id")?.str()?;
            // Its room: the room slot it, or the nearest thing holding it, holds; its building: its outermost holder.
            let (mut room, mut at, mut outer) = (None, Some(t), None);
            for _ in 0..64 {
                let Some(c) = at else { break };
                if room.is_none() {
                    room = c
                        .get("slot")
                        .and_then(|s| s.get("room"))
                        .and_then(Json::str);
                }
                if !std::ptr::eq(c, t) {
                    outer = Some(c);
                }
                at = parent(c);
            }
            Some(Copy {
                id,
                name: t.get("name").and_then(Json::str).unwrap_or(""),
                room,
                building: outer.and_then(|o| o.get("name")).and_then(Json::str),
            })
        })
        .collect()
}

/// Whether row `row`'s `where` matches copy `c`: each key it names matches by prefix.
fn matches(row: &Json, c: &Copy<'_>) -> bool {
    row.get("where")
        .and_then(Json::obj)
        .unwrap_or(&[])
        .iter()
        .all(|(key, prefixes)| {
            let of = match key.as_str() {
                "room" => c.room,
                "name" => Some(c.name),
                "building" => c.building,
                _ => None,
            };
            of.is_some_and(|v| {
                prefixes
                    .arr()
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(Json::str)
                    .any(|p| v.starts_with(p))
            })
        })
}

fn int(v: Option<&Json>) -> Option<i64> {
    match v {
        Some(Json::Int(n)) => i64::try_from(*n).ok(),
        _ => None,
    }
}

/// The number entry `entry` gives its state field `field`.
fn field_n(entry: &Json, field: &str) -> Option<u64> {
    int(entry.get("state")?.get(field)?.get("n")).and_then(|n| u64::try_from(n).ok())
}

impl World {
    /// The stock of a world built from `facts` (its things in order), whose import put each facts thing at node
    /// `nodes[<its id>]` in `tree`, over the world's `entries` by kind: the stocked containers, the placed copies'
    /// fields and every library row's words. A row naming an entry, a stock, a field or a library the world lacks is
    /// left out, with why ([`World::notes`]); only facts that are not JSON are refused.
    pub fn of(
        data: &Data,
        facts: &Json,
        nodes: &BTreeMap<String, Id>,
        tree: &Tree,
        entries: &[(String, Json)],
    ) -> R<World> {
        let entry = |name: &str| entries.iter().find(|(k, _)| k == name).map(|(_, e)| e);
        // Every library row's words, by reference: each text column but its id.
        let mut words = BTreeMap::new();
        for (lib, l) in &data.libraries {
            // Rows past a counter's reach have no reference: they are never drawn either.
            let key = l.get("library").and_then(Json::str).unwrap_or(lib);
            for (i, row) in l
                .get(key)
                .and_then(Json::arr)
                .unwrap_or(&[])
                .iter()
                .enumerate()
            {
                for (col, v) in row.obj().unwrap_or(&[]) {
                    if let (Some(text), true, Some(r)) =
                        (v.str(), col != "id", reference(lib, col, i))
                    {
                        words.insert(r, text.as_bytes().to_vec());
                    }
                }
            }
        }
        // The text fields a yielded kind carries, by the kind: from the first stock (in entry order) yielding it.
        let carries_of = |kind: &str| -> Option<Vec<String>> {
            entries.iter().find_map(|(_, e)| {
                e.get("stock")?.obj()?.iter().find_map(|(_, s)| {
                    (s.get("kind")?.str()? == kind).then(|| {
                        s.get("carries")
                            .and_then(Json::arr)
                            .unwrap_or(&[])
                            .iter()
                            .filter_map(|c| c.str().map(str::to_owned))
                            .collect()
                    })
                })
            })
        };
        let rows = data.stock.get("rows").and_then(Json::arr).unwrap_or(&[]);
        // Each row's pool, its yielded kind's carried fields and, for a stocked row, the container's count field.
        struct Row {
            entry: String,
            kind: String,
            count: Option<u64>,
            start: i64,
            pool: Arc<Vec<BTreeMap<u64, Value>>>,
        }
        let mut made = Vec::new();
        let mut notes = Vec::new();
        for (i, row) in rows.iter().enumerate() {
            // A row the world cannot read is left out and said, never the world's start refused.
            let one = || -> R<Row> {
                let why = |w: String| format!("stock-row {i}: {w}");
                let name = row
                    .get("entry")
                    .and_then(Json::str)
                    .ok_or(why("no entry".into()))?;
                let holder = entry(name).ok_or(why(format!("{name} is not an entry here")))?;
                let (kind, count) = match row.get("stock").and_then(Json::str) {
                    Some(s) => {
                        let st = holder
                            .get("stock")
                            .and_then(|x| x.get(s))
                            .ok_or(why(format!("{name} has no stock {s}")))?;
                        let kind = st
                            .get("kind")
                            .and_then(Json::str)
                            .ok_or(why(format!("{s}: no kind")))?;
                        let field = st
                            .get("count")
                            .and_then(Json::str)
                            .ok_or(why(format!("{s}: no count")))?;
                        let n = field_n(holder, field)
                            .ok_or(why(format!("{name} has no field {field}")))?;
                        (kind.to_owned(), Some(n))
                    }
                    None => (name.to_owned(), None),
                };
                let start = int(row.get("count")).unwrap_or(1).max(1);
                let carries = carries_of(&kind).unwrap_or_default();
                let draw = row.get("draw");
                let pool = match (
                    draw.and_then(|d| d.get("library")).and_then(Json::str),
                    carries.is_empty(),
                ) {
                    (Some(lib), false) => {
                        let yielded =
                            entry(&kind).ok_or(why(format!("{kind} is not an entry here")))?;
                        let l = data
                            .libraries
                            .get(lib)
                            .ok_or(why(format!("no library {lib}")))?;
                        let key = l.get("library").and_then(Json::str).unwrap_or(lib);
                        let tags: Vec<&str> = draw
                            .and_then(|d| d.get("tags"))
                            .and_then(Json::arr)
                            .unwrap_or(&[])
                            .iter()
                            .filter_map(Json::str)
                            .collect();
                        let fields: Vec<(u64, &str)> = carries
                            .iter()
                            .map(|c| field_n(yielded, c).map(|n| (n, c.as_str())))
                            .collect::<Option<_>>()
                            .ok_or(why(format!("{kind} lacks a carried field")))?;
                        let mut pool = Vec::new();
                        for (r, lr) in l
                            .get(key)
                            .and_then(Json::arr)
                            .unwrap_or(&[])
                            .iter()
                            .enumerate()
                        {
                            let has = lr.get("tags").and_then(Json::arr).unwrap_or(&[]);
                            if !tags.is_empty()
                                && !has.iter().filter_map(Json::str).any(|t| tags.contains(&t))
                            {
                                continue;
                            }
                            let mut f = BTreeMap::new();
                            for (n, c) in &fields {
                                if lr.get(c).and_then(Json::str).is_some() {
                                    let id =
                                        reference(lib, c, r).ok_or("stock-library-too-long")?;
                                    f.insert(
                                        *n,
                                        Value::Map(BTreeMap::from([(REFERENCE, id.to_value())])),
                                    );
                                }
                            }
                            pool.push(f);
                        }
                        pool
                    }
                    _ => Vec::new(),
                };
                Ok(Row {
                    entry: name.to_owned(),
                    kind,
                    count,
                    start,
                    pool: Arc::new(pool),
                })
            };
            made.push(one().unwrap_or_else(|e| {
                notes.push(e);
                Row {
                    entry: String::new(),
                    kind: String::new(),
                    count: None,
                    start: 1,
                    pool: Arc::default(),
                }
            }));
        }
        let (mut stocks, mut placed) = (Stocks::new(), BTreeMap::new());
        let mut numbered = vec![0u64; made.len()];
        for c in copies(facts) {
            let Some(node) = nodes.get(c.id).copied() else {
                continue;
            };
            let Some(n) = tree.handle(node).and_then(|h| tree.node(h)) else {
                continue;
            };
            let name = import_eden::entry_name(n.kind().as_str(), n.fields()).to_owned();
            let Some(i) = (0..made.len()).find(|&i| made[i].entry == name && matches(&rows[i], &c))
            else {
                continue;
            };
            let (row, k) = (&made[i], numbered[i]);
            numbered[i] += 1;
            if row.pool.is_empty() {
                continue;
            }
            let s = Stocked {
                kind: row.kind.clone(),
                count: row.count.unwrap_or(0),
                start: row.start,
                offset: k.saturating_mul(row.start as u64),
                pool: Arc::clone(&row.pool),
            };
            match row.count {
                Some(_) => {
                    stocks.insert(node, s);
                }
                None => {
                    let f = s.carried(None);
                    if !f.is_empty() {
                        placed.insert(node, f);
                    }
                }
            }
        }
        Ok(World {
            stocks: Arc::new(stocks),
            placed,
            words: Arc::new(words),
            notes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reference is the library's, the field's and the row's: two fields of a row, or one field of two rows,
    /// never share one; the same three always give the same.
    #[test]
    fn a_reference_names_its_library_field_and_row() {
        let a = reference("books", "title", 0).unwrap();
        assert_eq!(a, reference("books", "title", 0).unwrap());
        assert_ne!(a, reference("books", "first_page", 0).unwrap());
        assert_ne!(a, reference("books", "title", 1).unwrap());
        assert_ne!(a, reference("garments", "title", 0).unwrap());
        assert_eq!(a.counter(), 1);
    }

    fn facts() -> Json {
        json::parse(
            r#"{"things": [
              {"id": "e_house", "name": "eden-house-1"},
              {"id": "e_a", "parent": "e_house", "slot": {"room": "living"}, "name": "living-shelf"},
              {"id": "e_b", "parent": "e_house", "slot": {"room": "stacks-2"}, "name": "big-case"},
              {"id": "e_c", "parent": "e_a", "slot": {"n": 1}, "name": "on-the-shelf"},
              {"id": "e_d", "name": "commons-reading-book"}
            ]}"#,
        )
        .unwrap()
    }

    /// A copy's room is its own room slot or its holder's; its building is its outermost holder's name.
    #[test]
    fn a_copy_reads_its_room_from_itself_or_its_holder() {
        let f = facts();
        let cs = copies(&f);
        let at = |id: &str| cs.iter().find(|c| c.id == id).unwrap();
        assert_eq!(
            (at("e_a").room, at("e_a").building),
            (Some("living"), Some("eden-house-1"))
        );
        assert_eq!(
            (at("e_c").room, at("e_c").building),
            (Some("living"), Some("eden-house-1"))
        );
        assert_eq!((at("e_d").room, at("e_d").building), (None, None));
        let row = |w: &str| json::parse(&format!(r#"{{"where": {w}}}"#)).unwrap();
        assert!(matches(
            &row(r#"{"room": ["stacks", "reading"]}"#),
            at("e_b")
        ));
        assert!(!matches(&row(r#"{"room": ["stacks"]}"#), at("e_a")));
        assert!(
            !matches(&row(r#"{"room": ["stacks"]}"#), at("e_d")),
            "no room matches no room row"
        );
        assert!(matches(&row(r#"{"name": ["commons-reading"]}"#), at("e_d")));
        assert!(matches(&row(r#"{"building": ["eden-house"]}"#), at("e_c")));
        assert!(matches(&row("{}"), at("e_d")));
    }
}
